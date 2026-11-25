/**
 * Search, profiles, follow and messages, all through the headless "work page" on tiktok.com
 * (session.ts: one tab, one user at a time, closed during a QR sign-in).
 *
 * Measured 2026-10-10 (local headless Chrome, guest session):
 *  - search:   GET /api/search/general/full/?keyword=… fetched from inside the page is signed by
 *              TikTok's SDK (msToken / X-Bogus / X-Gnarly) and answers with videos (`data[].item`)
 *              and user lists (`data[].user_list`). /api/search/item/full/ answers 403.
 *  - profile:  a hand-built /api/user/detail/ or /api/post/item_list/ request gets an empty body or
 *              "illegal request" even from inside the page; the page's OWN requests work. So the
 *              profile is captured like For You: navigate to /@handle, take the account details
 *              from the page's embedded JSON (`__UNIVERSAL_DATA_FOR_REHYDRATION__`, scope
 *              `webapp.user-detail`; the page makes no user/detail request for them), read the
 *              post/item_list answers as they happen, scroll for more (cursor-based, hasMore).
 *              2026-10-13: TikTok answers the page's OWN post/item_list with an EMPTY 200 body for
 *              a new device / datacenter IP (the VM, and a guest desktop browser), so the page shows
 *              no videos at all; yt-dlp's listing of /@handle (--flat-playlist) still works and
 *              serves the videos whenever the page captured none (no play URLs: the viewer resolves
 *              each video through POST /api/resolve when it comes up, like search results).
 *              Guest search answers carry most videos without play URLs: those items are kept
 *              with no formats and the viewer resolves them through POST /api/resolve.
 *  - follow:   the profile page has a real `[data-e2e="follow-button"]` ("Follow" / "Following" /
 *              "Friends"); clicking it is TikTok's own code path. Needs the signed-in session
 *              (signed out, the click opens TikTok's login dialog).
 *  - messages: /messages needs the signed-in session (guest = redirect to /login). Read and sent
 *              through the page's DOM; the selectors are best-effort and /api/inbox/debug shows
 *              what the page actually contains, for tuning on the deployed server.
 *              A read can be cancelled (the viewer closed the panel, pressed Cancel, or its
 *              request dropped): the page's load is stopped and the work page is released at
 *              once, so the next request is not queued behind a read nobody waits for.
 *  - comments: measured 2026-11-05 (local headless Chrome, guest): a hand-built
 *              /api/comment/list/ request gets an EMPTY 200 body even when the page's SDK signed
 *              it, yt-dlp does not extract TikTok comments at all, and the guest video page shows
 *              TikTok's login dialog with no comments and makes no comment request. So comments
 *              need the signed-in session and are taken from the video page itself, like the
 *              profile: navigate to /@author/video/id, read the page's OWN comment/list answer as
 *              it happens (scrolling the list for the next page), then a request from inside the
 *              page, then the rendered comments (data-e2e="comment-level-1") as fallbacks.
 *              Unverified against a signed-in page at the time of writing: /api/comments/debug
 *              shows what the page contains, for tuning on the deployed server.
 */
import type { Page } from 'puppeteer-core';
import type { ChatMessage, CommentRepliesResponse, CommentsResponse, Conversation, ConversationResponse, FeedItem, FollowResponse, FollowState, InboxResponse, LikeResponse, ProfileResponse, SearchResponse, SendMessageResponse, UserSummary, VideoComment } from '../../shared/types';
import { itemToFeedItem, relationToState } from './feed';
import { directGet, directPage, isLoggedIn, onTikTokAccountChange, pageCookieHeader, resetWorkPage, tiktokDirectOn, withWorkPage } from './session';
import { ytdlpInfo } from './ytdlp';
import { GuestError, guestCommentList, guestGet, guestPage, guestReplyList, guestUnusable, pageScope } from './tiktokGuest';
import { say } from './activity';

const TT = 'https://www.tiktok.com';
const MESSAGES_URL = `${TT}/messages?lang=en`;
/** Resolves after `ms`, or rejects with CancelledError as soon as `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
};

export class SocialError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
  }
}

/** The caller gave up on the read (panel closed, Cancel pressed, request dropped). 499 like nginx's "client closed request". */
export class CancelledError extends SocialError {
  readonly cancelled = true;
  constructor() {
    super('Cancelled', 499);
  }
}
export const isCancelled = (e: unknown): boolean => e instanceof CancelledError || (e as { cancelled?: boolean })?.cancelled === true;

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/**
 * Page work (a goto, a long evaluate) that the cancel can interrupt: on abort the page's load is
 * stopped (window.stop, so TikTok's scripts do not keep the tab busy) and the caller gets
 * CancelledError at once; the puppeteer promise is left to settle on its own (a stopped
 * navigation rejects, which is swallowed).
 */
function cancellable<T>(page: Page, work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new CancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => undefined);
      page.evaluate('window.stop()').catch(() => undefined);
      reject(new CancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The reads in flight or waiting for the work page, by kind ("inbox": the messages list and
 * threads, "comments": a video's comments), so POST /api/inbox/cancel and /api/comments/cancel
 * can stop them all (the viewer's own request is usually gone already; this reaches the headless work).
 */
export type ReadKind = 'inbox' | 'comments';
const reads = new Map<ReadKind, Set<AbortController>>();
const readsOf = (kind: ReadKind): Set<AbortController> => {
  let set = reads.get(kind);
  if (!set) reads.set(kind, (set = new Set()));
  return set;
};
export const readsInFlight = (kind: ReadKind): number => readsOf(kind).size;
export function cancelReads(kind: ReadKind): number {
  const set = readsOf(kind);
  const n = set.size;
  for (const c of set) c.abort();
  set.clear();
  return n;
}
export const inboxReadsInFlight = (): number => readsInFlight('inbox');
export const cancelInboxReads = (): number => cancelReads('inbox');
/** Runs a read registered for cancelReads(kind), cancelled as well when the request's own `signal` aborts. */
export async function tracked<T>(kind: ReadKind, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const set = readsOf(kind);
  set.add(ctl);
  try {
    return await fn(ctl.signal);
  } finally {
    set.delete(ctl);
    signal?.removeEventListener('abort', onAbort);
  }
}

function requireLogin(what: string): void {
  if (!isLoggedIn()) throw new SocialError(`Sign in to TikTok first (Profile) to ${what}.`, 401);
}

// ---------------------------------------------------------------- captured page answers

interface Captured {
  kind: 'user' | 'posts';
  json: any;
}
const installed = new WeakSet<Page>();
let captured: Captured[] = [];
/** The page's own comment/list answers (url keeps the aweme_id and cursor they were asked for) */
let commentAnswers: { url: string; json: any }[] = [];

/** Records the page's own user/detail, post/item_list and comment/list answers (hand-built requests are refused). */
function installCapture(page: Page): void {
  if (installed.has(page)) return;
  installed.add(page);
  page.on('response', (res) => {
    const u = res.url();
    if (/\/api\/comment\/list\//.test(u)) {
      res
        .json()
        .then((json: any) => {
          commentAnswers.push({ url: u, json });
          if (commentAnswers.length > 20) commentAnswers.splice(0, commentAnswers.length - 20);
        })
        .catch(() => undefined);
      return;
    }
    const kind: Captured['kind'] | undefined = /\/api\/user\/detail\//.test(u) ? 'user' : /\/api\/post\/item_list\//.test(u) ? 'posts' : undefined;
    if (!kind) return;
    res
      .json()
      .then((json: any) => {
        captured.push({ kind, json });
        if (captured.length > 40) captured.splice(0, captured.length - 40);
      })
      .catch(() => undefined);
  });
}

function userFromDetail(json: any): UserSummary | undefined {
  const u = json?.userInfo?.user;
  if (!u?.uniqueId) return undefined;
  const st = json.userInfo.stats || json.userInfo.statsV2 || {};
  return {
    id: u.id,
    secUid: u.secUid,
    uniqueId: u.uniqueId,
    nickname: u.nickname,
    avatar: u.avatarMedium || u.avatarLarger || u.avatarThumb,
    signature: u.signature,
    verified: Boolean(u.verified),
    followers: num(st.followerCount),
    following: num(st.followingCount),
    likes: num(st.heartCount ?? st.heart),
    videos: num(st.videoCount),
    followState: relationToState(u.relation),
  };
}

function userFromSearch(ui: any): UserSummary | undefined {
  if (!ui?.unique_id) return undefined;
  return {
    id: ui.uid,
    secUid: ui.sec_uid,
    uniqueId: ui.unique_id,
    nickname: ui.nickname,
    avatar: ui.avatar_thumb?.url_list?.[0] || ui.avatar_medium?.url_list?.[0],
    signature: ui.signature,
    verified: Boolean(ui.custom_verify || ui.enterprise_verify_reason),
    followers: num(ui.follower_count),
    following: num(ui.following_count),
    likes: num(ui.total_favorited),
    videos: num(ui.aweme_count),
    followState: ui.follow_status !== undefined ? relationToState(ui.follow_status) : 'unknown',
  };
}

// ---------------------------------------------------------------- search

const COMMON = {
  aid: '1988',
  app_language: 'en',
  app_name: 'tiktok_web',
  browser_language: 'en-US',
  browser_name: 'Mozilla',
  browser_online: 'true',
  browser_platform: 'Win32',
  browser_version: '5.0 (Windows)',
  channel: 'tiktok_web',
  cookie_enabled: 'true',
  device_platform: 'web_pc',
  language: 'en',
  os: 'windows',
  region: 'US',
  screen_height: '1080',
  screen_width: '1920',
  tz_name: 'America/New_York',
  webcast_language: 'en',
};

/** TikTok's continuation of a search is tied to the first answer's log id */
let lastSearch: { q: string; id?: string } | undefined;

/** Seconds an in-page request may take: puppeteer's protocol timeout is 45 s, the page must answer before. */
const FETCH_TIMEOUT_MS = 25_000;

/**
 * A fetch run inside the page (signed by TikTok's SDK). Bounded in the page itself, so a request
 * TikTok stalls (observed on the Google VM: "Runtime.evaluate timed out" after 45 s) comes back as
 * a clear error instead of a protocol timeout.
 */
async function fetchInPage(page: Page, url: string, attempts = 3, log?: (m: string) => void, signal?: AbortSignal): Promise<string> {
  let text = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfCancelled(signal);
    const t0 = Date.now();
    const r = (await page.evaluate(`(async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ${FETCH_TIMEOUT_MS});
      try {
        const r = await fetch(${JSON.stringify(url)}, { credentials: 'include', signal: ctl.signal });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: '', error: String((e && e.name === 'AbortError') ? 'no answer within ${FETCH_TIMEOUT_MS / 1000} s' : (e && e.message) || e) };
      } finally { clearTimeout(timer); }
    })()`)) as { status: number; text: string; error?: string };
    log?.(`in-page request ${url.split('?')[0].slice(22)}: HTTP ${r.status}, ${r.text.length} bytes, ${Date.now() - t0} ms${r.error ? ', ' + r.error : ''}`);
    if (r.status === 403) throw new SocialError('TikTok refused the request (HTTP 403)');
    if (r.error && attempt === attempts) throw new SocialError(`TikTok did not answer (${r.error})`);
    text = r.text;
    if (text.trim()) break;
    if (attempt < attempts) await sleep(1200 * attempt, signal);
  }
  return text;
}

/** What a search answer (general/full) holds: its videos, and the accounts listed among them (handed to `addUser`). */
function readSearchAnswer(json: any, upstream: { cookieHeader: string; referer: string }, addUser: (ui: any) => void): FeedItem[] {
  const items: FeedItem[] = [];
  for (const d of Array.isArray(json.data) ? json.data : []) {
    if (d?.item && !d.item.imagePost) {
      // Photo posts (slideshows) are not videos; a video whose play URLs the guest answer stripped
      // is kept without formats and resolved by the viewer when it comes up.
      const it = itemToFeedItem(d.item, upstream, { allowUnplayable: true });
      if (it) items.push(it);
    }
    if (Array.isArray(d?.user_list)) for (const ul of d.user_list) addUser(ul?.user_info || ul);
    if (d?.user_info) addUser(d.user_info);
  }
  return items;
}

/**
 * The search without the browser, for an account in the test "without the browser" (never the main
 * one; session.ts directGet): the same two requests the page makes, signed, with the account's
 * cookies. TikTok answers them for an account (2026-11-25: 12 videos with files in 1.2 s, 10
 * accounts in 0.8 s) and for no guest. `web_search_code` - the JSON the page adds to the first
 * request - must be left out: with it the answer is an empty 200 within 80 ms.
 */
async function searchTikTokDirect(q: string, offset: number, log: (m: string) => void): Promise<SearchResponse> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const referer = `${TT}/search?q=${encodeURIComponent(q)}`;
  const query: Record<string, string | number> = { from_page: 'search', keyword: q, offset, search_source: 'normal_search' };
  if (offset && lastSearch?.q === q && lastSearch.id) query.search_id = lastSearch.id;
  const r = await directGet({ kind: 'search', path: '/api/search/general/full/', query, what: `videos matching "${q.slice(0, 40)}"`, referer, usable: (j) => Array.isArray(j?.data) || j?.has_more !== undefined, log });
  const json = r.json;
  const users: UserSummary[] = [];
  const seenUsers = new Set<string>();
  const addUser = (ui: any): void => {
    const u = userFromSearch(ui);
    if (u && !seenUsers.has(u.uniqueId)) {
      seenUsers.add(u.uniqueId);
      users.push(u);
    }
  };
  const items = readSearchAnswer(json, r.upstream, addUser);
  lastSearch = { q, id: json.extra?.logid || json.log_pb?.impr_id || lastSearch?.id };
  if (offset === 0) {
    // Accounts matching the words: a separate request; best effort.
    try {
      const ur = await directGet({ kind: 'search', path: '/api/search/user/full/', query: { from_page: 'search', keyword: q, cursor: 0, count: 12, search_source: 'normal_search' }, what: `accounts matching "${q.slice(0, 40)}"`, referer, usable: (j) => Array.isArray(j?.user_list) || j?.has_more !== undefined, log });
      for (const ul of Array.isArray(ur.json?.user_list) ? ur.json.user_list : []) addUser(ul?.user_info || ul);
    } catch (e) {
      warnings.push(`account search unavailable (${(e as Error).message})`);
    }
  }
  log(`search "${q}" offset ${offset} without the browser: ${items.length} videos, ${users.length} accounts, ${Date.now() - t0} ms`);
  const next = num(json.cursor);
  return { q, items, users, hasMore: json.has_more === 1 || json.has_more === true, offset: next !== undefined && next > offset ? next : offset + Math.max(items.length, 1), warnings, elapsedMs: Date.now() - t0, via: 'direct' };
}

export async function searchTikTok(q: string, offset: number, log: (m: string) => void): Promise<SearchResponse> {
  // An account in the test "without the browser": TikTok is asked directly, and the browser is not
  // started. Whatever goes wrong there, the search goes on through the browser as before.
  if (tiktokDirectOn('search')) {
    try {
      return await searchTikTokDirect(q, offset, log);
    } catch (e) {
      log(`search "${q}" without the browser failed (${(e as Error).message.split(/\r?\n/)[0]}); asking through the browser`);
    }
  }
  const t0 = Date.now();
  const warnings: string[] = [];
  const params = new URLSearchParams({ ...COMMON, from_page: 'search', keyword: q, offset: String(offset), search_source: 'normal_search', web_search_code: '{"tiktok":{"client_params_x":{"search_engine":{"ies_mt_user_live_video_card_use_libra":1,"mt_search_general_user_live_card":1}},"search_server":{}}}' });
  if (offset && lastSearch?.q === q && lastSearch.id) params.set('search_id', lastSearch.id);
  const url = `${TT}/api/search/general/full/?${params}`;
  let text = '';
  say('searching TikTok in the signed-in browser on the server (Chromium)', "searching in the server's browser");
  try {
    text = await withWorkPage(log, (page) => fetchInPage(page, url, 2, log), 'search');
  } catch (e) {
    // The page's scripts may be stuck (a stalled SDK, a page left on a heavy profile): once more on a fresh page.
    log(`search "${q}" failed on the current work page (${(e as Error).message}); retrying on a fresh page`);
    await resetWorkPage(log);
    text = await withWorkPage(log, (page) => fetchInPage(page, url, 2, log), 'search');
  }
  return withWorkPage(log, async (page) => {
    if (!text.trim()) throw new SocialError('TikTok search returned an empty answer (soft rate limit); try again in a moment');
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SocialError('TikTok search answered with something that is not JSON');
    }
    const code = Number(json.status_code ?? json.statusCode ?? 0);
    if (code !== 0) throw new SocialError(`TikTok search status ${code}: ${json.status_msg || json.statusMsg || 'unavailable'}`);
    const cookieHeader = await pageCookieHeader(page);
    const upstream = { cookieHeader, referer: `${TT}/search?q=${encodeURIComponent(q)}` };
    const users: UserSummary[] = [];
    const seenUsers = new Set<string>();
    const addUser = (ui: any) => {
      const u = userFromSearch(ui);
      if (u && !seenUsers.has(u.uniqueId)) {
        seenUsers.add(u.uniqueId);
        users.push(u);
      }
    };
    const items = readSearchAnswer(json, upstream, addUser);
    lastSearch = { q, id: json.extra?.logid || json.log_pb?.impr_id || lastSearch?.id };
    if (offset === 0) {
      // Accounts matching the words: a separate endpoint; best effort (it may be refused).
      try {
        const up = new URLSearchParams({ ...COMMON, from_page: 'search', keyword: q, cursor: '0', count: '12', search_source: 'normal_search' });
        const ut = await fetchInPage(page, `${TT}/api/search/user/full/?${up}`, 1, log);
        const uj = ut.trim() ? JSON.parse(ut) : undefined;
        for (const ul of Array.isArray(uj?.user_list) ? uj.user_list : []) addUser(ul?.user_info || ul);
      } catch (e) {
        warnings.push(`account search unavailable (${(e as Error).message})`);
      }
    }
    log(`search "${q}" offset ${offset}: ${items.length} videos, ${users.length} accounts, ${Date.now() - t0} ms`);
    const next = num(json.cursor);
    return { q, items, users, hasMore: json.has_more === 1 || json.has_more === true, offset: next !== undefined && next > offset ? next : offset + Math.max(items.length, 1), warnings, elapsedMs: Date.now() - t0, via: 'browser' };
  }, 'search');
}

// ---------------------------------------------------------------- profile

interface ProfileState {
  user: string;
  info?: UserSummary;
  items: FeedItem[];
  ids: Set<string>;
  hasMore: boolean;
  cookieHeader: string;
  notFound?: string;
  /** The page delivered no videos; the listing comes from yt-dlp (kept for the "more" calls) */
  viaYtDlp?: boolean;
}
let profile: ProfileState | undefined;

/** A flat yt-dlp entry of an account page as a feed item (no play URLs yet). */
function ytEntryToFeedItem(e: any, user: string): FeedItem | undefined {
  const id = typeof e?.id === 'string' && /^\d{5,}$/.test(e.id) ? e.id : undefined;
  if (!id) return undefined;
  const handle = typeof e.uploader === 'string' && e.uploader ? e.uploader : user;
  const thumbs: any[] = Array.isArray(e.thumbnails) ? e.thumbnails : [];
  const cover = (thumbs.find((t) => t?.id === 'cover') || thumbs[0])?.url;
  return {
    id,
    canonicalUrl: `${TT}/@${handle}/video/${id}`,
    author: { id: typeof e.uploader_id === 'string' ? e.uploader_id : undefined, uniqueId: handle, nickname: typeof e.channel === 'string' ? e.channel : undefined },
    desc: (typeof e.description === 'string' && e.description) || (typeof e.title === 'string' && e.title) || undefined,
    createTime: num(e.timestamp),
    duration: num(e.duration),
    cover: typeof cover === 'string' ? cover : undefined,
    stats: { plays: num(e.view_count), likes: num(e.like_count), comments: num(e.comment_count), shares: num(e.repost_count) },
    formats: [],
  };
}

/** yt-dlp walks the account's videos from the start up to offset + count (a page costs ~4 s). */
async function listWithYtDlp(user: string, offset: number, count: number, log: (m: string) => void): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const t0 = Date.now();
  const json = await ytdlpInfo({ url: `${TT}/@${encodeURIComponent(user)}`, flat: true, playlistItems: `${offset + 1}-${offset + count}` }, 90_000);
  const entries: any[] = Array.isArray(json?.entries) ? json.entries : [];
  const items: FeedItem[] = [];
  for (const e of entries) {
    const it = ytEntryToFeedItem(e, user);
    if (it && !items.some((x) => x.id === it.id)) items.push(it);
  }
  log(`profile @${user}: yt-dlp listed ${items.length} videos [${offset + 1}-${offset + count}], ${Date.now() - t0} ms`);
  return { items, hasMore: entries.length >= count };
}

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const onProfilePage = (page: Page, user: string): boolean => page.url().toLowerCase().startsWith(`${TT}/@${user.toLowerCase()}`);

const SCROLL_BOTTOM = `(() => { const el = document.scrollingElement || document.body; el.scrollTop = el.scrollHeight; window.dispatchEvent(new Event('scroll')); })()`;
/** The account details the server rendered into the page (no network request carries them). */
const READ_EMBEDDED_USER = `(() => {
  const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') || document.getElementById('__UNIVERSAL_DATA_FOR_REBUILD__');
  if (!el) return { missing: true, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
  try {
    const j = JSON.parse(el.textContent || '{}');
    const d = (j.__DEFAULT_SCOPE__ || {})['webapp.user-detail'];
    if (!d) return { missing: true, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
    return { statusCode: d.statusCode, statusMsg: d.statusMsg, userInfo: d.userInfo };
  } catch (e) { return { missing: true, text: String(e) }; }
})()`;
const READ_FOLLOW_BUTTON = `(() => { const b = document.querySelector('[data-e2e="follow-button"]'); return b ? (b.textContent || '').trim() : null; })()`;

function stateFromButton(text: string | null | undefined): FollowState | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (/^friends/.test(t)) return 'friends';
  if (/^following/.test(t)) return 'following';
  if (/^requested/.test(t)) return 'requested';
  if (/^follow( back)?$/.test(t)) return 'none';
  return undefined;
}

/** Takes the page's captured answers into the profile state. */
function absorbProfile(p: ProfileState): void {
  for (const c of captured.splice(0)) {
    if (c.kind === 'user') {
      const info = userFromDetail(c.json);
      if (info && sameUser(info.uniqueId, p.user)) p.info = info;
      else if (!info && Number(c.json?.statusCode ?? 0) !== 0) p.notFound = `${c.json.statusMsg || 'status ' + c.json.statusCode}`;
    } else {
      const list: any[] = Array.isArray(c.json?.itemList) ? c.json.itemList : [];
      for (const raw of list) {
        const it = itemToFeedItem(raw, { cookieHeader: p.cookieHeader, referer: `${TT}/@${p.user}` });
        if (it && !p.ids.has(it.id)) {
          p.ids.add(it.id);
          p.items.push(it);
        }
      }
      if (c.json?.hasMore === false) p.hasMore = false;
    }
  }
}

async function openProfile(page: Page, user: string, log: (m: string) => void, signal?: AbortSignal): Promise<ProfileState> {
  if (profile && sameUser(profile.user, user) && onProfilePage(page, user)) return profile;
  captured = [];
  profile = { user, items: [], ids: new Set(), hasMore: true, cookieHeader: '' };
  log(`profile @${user}: opening the page`);
  await cancellable(page, page.goto(`${TT}/@${encodeURIComponent(user)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 }), signal);
  profile.cookieHeader = await pageCookieHeader(page);
  return profile;
}

// ---------------------------------------------------------------- profile as a guest (no browser)

/**
 * What the signed-in browser learned about who is followed (the follow button it read or pressed),
 * by lower-cased handle. A guest answer cannot know it; a profile served from one takes it from here.
 */
const followKnown = new Map<string, FollowState>();
const rememberFollow = (user: string, state: FollowState | undefined): void => {
  if (state && state !== 'unknown') followKnown.set(user.toLowerCase(), state);
};

/** The account details in a tiktok.com account page's data block: the account, "no such account", or nothing readable. */
export function userFromAccountPage(html: string): { info?: UserSummary; statusCode?: number; privateAccount?: boolean; readable: boolean } {
  const detail = pageScope(html)?.['webapp.user-detail'];
  if (!detail || typeof detail !== 'object') return { readable: false };
  const statusCode = Number(detail.statusCode ?? 0);
  const info = userFromDetail({ userInfo: detail.userInfo });
  const u = detail.userInfo?.user;
  return { info, statusCode, privateAccount: Boolean(u?.privateAccount || u?.secret), readable: true };
}

interface GuestProfile {
  user: string;
  info: UserSummary;
  privateAccount: boolean;
  /** When the account page was read (the details are asked again after GUEST_PROFILE_MS) */
  infoAt: number;
  items: FeedItem[];
  ids: Set<string>;
  cursor: string;
  hasMore: boolean;
}
let guestProfile: GuestProfile | undefined;

// Another TikTok account became the active one: what was read as the previous one (who it follows,
// the profile page it had open, its captured answers) is not true of this one.
onTikTokAccountChange(() => {
  followKnown.clear();
  profile = undefined;
  guestProfile = undefined;
  captured = [];
  commentAnswers = [];
  lastSearch = undefined;
});
const GUEST_PROFILE_MS = 10 * 60 * 1000;

/**
 * An account's details and videos asked as a guest without a browser (tiktokGuest.ts): the account
 * page over the Chrome-like connection carries the details (and the id the list call wants), the
 * signed post/item_list call the videos, 30 a page with their play addresses. About 1-3 s for a
 * first page, where the browser path needs the headless browser, a page load and - on the VM,
 * whose page gets no videos - yt-dlp behind it. Undefined when the path is not usable right now;
 * GuestError when TikTok would not answer; SocialError 404 for an account that does not exist.
 */
export async function fetchProfileAsGuest(user: string, offset: number, count: number, log: (m: string) => void, signal?: AbortSignal): Promise<ProfileResponse | undefined> {
  if (guestUnusable('profile') || guestUnusable('posts')) return undefined;
  const t0 = Date.now();
  const warnings: string[] = [];
  const referer = `${TT}/@${encodeURIComponent(user)}`;
  let p = guestProfile && sameUser(guestProfile.user, user) ? guestProfile : undefined;
  if (!p || Date.now() - p.infoAt > GUEST_PROFILE_MS) {
    // An account in the test "without the browser" reads the page as itself: the page then says
    // whether it follows this account (a guest's page says "not followed" for everyone).
    let page: { html: string } | undefined;
    let asAccount = false;
    if (tiktokDirectOn('profile')) {
      try {
        page = await directPage('profile', referer, 'the account page', log, signal);
        asAccount = true;
      } catch (e) {
        if (isCancelled(e)) throw e;
        log(`profile @${user}: the page as the account did not come (${(e as Error).message.split(/\r?\n/)[0]}); reading it as a guest`);
      }
    }
    if (!page) page = await guestPage('profile', referer, 'the account page', log, signal);
    const read = userFromAccountPage(page.html);
    if (asAccount && read.info) rememberFollow(user, read.info.followState);
    if (read.readable && read.statusCode === 10221) throw new SocialError(`@${user}: TikTok could not find this account`, 404);
    if (!read.info?.secUid) throw new GuestError(read.readable ? `the account page carried no account (status ${read.statusCode})` : 'the account page carried no data block (TikTok served a challenge or changed the page)', 'empty');
    p = { user, info: read.info, privateAccount: Boolean(read.privateAccount), infoAt: Date.now(), items: [], ids: new Set(), cursor: '0', hasMore: true };
    guestProfile = p;
  } else if (offset === 0) {
    // A fresh open: the list from the top again (play addresses live about an hour).
    p.items = [];
    p.ids = new Set();
    p.cursor = '0';
    p.hasMore = true;
  }
  if (p.privateAccount) throw new SocialError(`@${user}: this account is private`, 404);
  let pages = 0;
  while (p.items.length < offset + count && p.hasMore && pages < 4) {
    pages++;
    const state = p;
    const r = await guestGet({
      kind: 'posts',
      path: '/api/post/item_list/',
      query: { secUid: state.info.secUid!, cursor: state.cursor, count: 30, coverFormat: 2, needPinnedItemIds: 'true', post_item_list_request_type: 0 },
      what: `the videos of @${user}`,
      referer,
      envCode: 64,
      log,
      signal,
    });
    const list: any[] = Array.isArray(r.json.itemList) ? r.json.itemList : [];
    let added = 0;
    for (const raw of list) {
      const it = itemToFeedItem(raw, { cookieHeader: r.upstream.cookieHeader, referer });
      if (it && !state.ids.has(it.id)) {
        state.ids.add(it.id);
        state.items.push(it);
        added++;
      }
    }
    const next = r.json.cursor !== undefined ? String(r.json.cursor) : state.cursor;
    state.hasMore = r.json.hasMore === true && list.length > 0 && next !== state.cursor;
    state.cursor = next;
    if (!added && !list.length) break;
  }
  // Who is followed is the signed-in browser's knowledge: a guest answer says "not followed" for everyone.
  const followState: FollowState = isLoggedIn() ? followKnown.get(p.info.uniqueId.toLowerCase()) ?? 'unknown' : 'none';
  const info: UserSummary = { ...p.info, followState };
  const items = p.items.slice(offset, offset + count).map((it) => ({ ...it, author: { ...it.author, followState: followState === 'unknown' ? undefined : followState } }));
  const hasMore = p.hasMore || p.items.length > offset + count;
  log(`profile @${user}: ${items.length} videos served (offset ${offset}, guest, ${pages} list page(s), more: ${hasMore}, ${Date.now() - t0} ms)`);
  return { user: info, items, offset, hasMore, warnings, elapsedMs: Date.now() - t0 };
}

/**
 * An account's details and videos: as a guest without a browser first (fetchProfileAsGuest); when
 * that is not usable or TikTok does not answer it, the headless work page as before
 * (fetchProfileInBrowser, with yt-dlp's listing behind it).
 */
export async function fetchProfile(user: string, offset: number, count: number, log: (m: string) => void): Promise<ProfileResponse> {
  try {
    const direct = await fetchProfileAsGuest(user, offset, count, log);
    if (direct) return direct;
  } catch (e) {
    if (isCancelled(e) || (e instanceof SocialError && e.status === 404)) throw e;
    log(`profile @${user}: the request without a browser failed (${(e as Error).message}); opening the account page in the browser instead`);
  }
  say('opening the account page in the browser (slower)', 'opening the account on TikTok');
  return fetchProfileInBrowser(user, offset, count, log);
}

/** The original: the account page in the headless work page (its own list answers), yt-dlp's listing when the page delivers no videos. */
export async function fetchProfileInBrowser(user: string, offset: number, count: number, log: (m: string) => void): Promise<ProfileResponse> {
  const t0 = Date.now();
  const warnings: string[] = [];
  return withWorkPage(log, async (page) => {
    installCapture(page);
    const p = await openProfile(page, user, log);
    // yt-dlp runs beside the page once the page is known (or looks about) to deliver no videos; not
    // sooner, since the VM has one core and the page itself delivers them when TikTok allows.
    let ytResult: { items: FeedItem[]; hasMore: boolean } | undefined;
    let ytPromise: Promise<typeof ytResult> | undefined;
    const startYtDlp = (): Promise<typeof ytResult> => {
      if (!ytPromise)
        ytPromise = listWithYtDlp(user, offset, count, log).then(
          (r) => (ytResult = r),
          (e) => {
            log(`profile @${user}: yt-dlp listing failed (${(e as Error).message})`);
            return undefined;
          },
        );
      return ytPromise;
    };
    if (p.viaYtDlp) void startYtDlp();
    const deadline = Date.now() + (p.viaYtDlp ? 0 : 20_000);
    const detailsUntil = Date.now() + 15_000;
    while (!p.info && !p.notFound && Date.now() < detailsUntil) {
      absorbProfile(p);
      if (p.info || p.notFound) break;
      const emb = (await page.evaluate(READ_EMBEDDED_USER).catch(() => undefined)) as { missing?: boolean; text?: string; statusCode?: number; statusMsg?: string; userInfo?: unknown } | undefined;
      if (emb && !emb.missing) {
        const info = userFromDetail({ userInfo: emb.userInfo });
        if (info && sameUser(info.uniqueId, user)) p.info = info;
        else if (Number(emb.statusCode ?? 0) !== 0) p.notFound = emb.statusMsg || `status ${emb.statusCode}`;
        else if (info) p.info = info; // TikTok redirected to the account's current handle
      } else if (emb?.text && /couldn.t find this account/i.test(emb.text)) p.notFound = 'not found';
      if (p.info || p.notFound) break;
      await sleep(300);
    }
    if (p.notFound) throw new SocialError(`@${user}: TikTok could not find this account${p.notFound === 'not found' ? '' : ` (${p.notFound})`}`, 404);
    let nudges = 0;
    let stale = 0;
    while (p.items.length < offset + count && p.hasMore && Date.now() < deadline) {
      const before = p.items.length;
      absorbProfile(p);
      if (p.items.length >= offset + count) break;
      if (nudges > 0 || p.items.length > 0) await page.evaluate(SCROLL_BOTTOM).catch(() => undefined);
      nudges++;
      await sleep(700);
      absorbProfile(p);
      stale = p.items.length > before ? 0 : stale + 1;
      if (stale >= 8) {
        warnings.push('TikTok stopped loading more videos of this account');
        break;
      }
      // The page's list answers are empty (see the header): yt-dlp beside the wait, and stop
      // waiting once it has the videos.
      if (!p.items.length && nudges >= 3) void startYtDlp();
      if (!p.items.length && ytResult?.items.length) break;
    }
    absorbProfile(p);
    let items = p.items.slice(offset, offset + count);
    let hasMore = p.hasMore && (stale < 8 || p.items.length > offset + count);
    let served = `${p.items.length} captured`;
    if (!items.length && (!p.items.length || p.viaYtDlp)) {
      // Nothing from the page at all (not just its end): yt-dlp's listing, awaited when still running.
      const yt = await startYtDlp();
      if (yt?.items.length) {
        if (!p.viaYtDlp) log(`profile @${user}: the page delivered no videos; serving yt-dlp's listing`);
        p.viaYtDlp = true;
        items = yt.items;
        hasMore = yt.hasMore;
        served = 'yt-dlp';
      } else if (yt) hasMore = false; // yt-dlp walked the account to its end
    }
    if (!p.info) {
      const txt = String(await page.evaluate('document.body.innerText').catch(() => ''));
      if (/couldn.t find this account|this account is private|no content/i.test(txt) && !items.length) throw new SocialError(`@${user}: ${/private/i.test(txt) ? 'this account is private' : 'TikTok could not find this account'}`, 404);
      const a = (p.items[0] || items[0])?.author;
      if (a?.uniqueId) {
        p.info = { id: a.id, uniqueId: a.uniqueId, nickname: a.nickname, avatar: a.avatar, followState: 'unknown' };
        warnings.push('TikTok did not deliver the profile details; showing what the videos carry');
      } else throw new SocialError(`@${user}: TikTok did not deliver the profile (${txt.replace(/\s+/g, ' ').slice(0, 100)})`);
    }
    const btn = stateFromButton((await page.evaluate(READ_FOLLOW_BUTTON).catch(() => null)) as string | null);
    if (btn && isLoggedIn()) {
      p.info.followState = btn;
      rememberFollow(p.info.uniqueId, btn);
    }
    if (p.viaYtDlp) for (const it of items) if (!it.author.avatar && sameUser(it.author.uniqueId || '', p.info.uniqueId)) it.author.avatar = p.info.avatar;
    log(`profile @${user}: ${items.length} videos served (offset ${offset}, ${served}, more: ${hasMore})`);
    return { user: p.info, items, offset, hasMore, warnings, elapsedMs: Date.now() - t0 };
  }, `profile @${user}`);
}

// ---------------------------------------------------------------- follow

/**
 * Follow / unfollow without the browser, for an account in the test "without the browser" (never
 * the main one; session.ts directGet): the account page as the account sees it names the account
 * (id, secUid) and says whether it is followed; then the page's own request, `POST
 * /api/commit/follow/user/`, signed, with an empty body. Accepted on 2026-11-25 (follow and
 * unfollow, 0.3 s each, `follow_status` 1 then 0, the account page agreeing afterwards).
 */
async function followDirect(user: string, follow: boolean, log: (m: string) => void): Promise<FollowResponse> {
  const t0 = Date.now();
  const referer = `${TT}/@${encodeURIComponent(user)}`;
  const page = await directPage('follow', referer, `the account page of @${user}`, log);
  const read = userFromAccountPage(page.html);
  if (read.readable && read.statusCode === 10221) throw new SocialError(`@${user}: TikTok could not find this account`, 404);
  const info = read.info;
  if (!info?.id || !info.secUid) throw new GuestError(read.readable ? `the account page carried no account (status ${read.statusCode})` : 'the account page carried no data block', 'empty');
  const before = info.followState ?? 'unknown';
  if (before !== 'unknown' && (before !== 'none') === follow) {
    rememberFollow(user, before);
    return { user, followState: before, warnings: [`already ${follow ? 'following' : 'not following'} @${user}`], via: 'direct' };
  }
  const r = await directGet({
    kind: 'follow',
    method: 'POST',
    path: '/api/commit/follow/user/',
    query: { action_type: follow ? 1 : 0, channel_id: 0, from: 18, from_pre: 0, fromWeb: 1, sec_user_id: info.secUid, type: follow ? 1 : 0, user_id: info.id },
    what: 'the follow',
    doing: `${follow ? 'following' : 'unfollowing'} @${user} at TikTok directly (no browser: the account's sign-in, a signed request)`,
    referer,
    usable: (j) => j?.follow_status !== undefined,
    log,
  });
  const warnings: string[] = [];
  let after = relationToState(r.json.follow_status);
  if (after === 'unknown') {
    warnings.push(`TikTok answered follow_status ${r.json.follow_status}`);
    after = follow ? 'following' : 'none';
  }
  if ((after !== 'none') !== follow) warnings.push('TikTok answered, but the follow state is not the one asked for');
  rememberFollow(user, after);
  log(`@${user}: ${follow ? 'follow' : 'unfollow'} without the browser, state now "${after}" (was "${before}"), ${Date.now() - t0} ms`);
  return { user, followState: after, warnings, via: 'direct' };
}

export async function followUser(user: string, follow: boolean, log: (m: string) => void): Promise<FollowResponse> {
  requireLogin(follow ? 'follow accounts' : 'unfollow accounts');
  // An account in the test "without the browser": TikTok is asked directly. When TikTok does not
  // answer that, the browser presses the button as before; when it answers "no", that is the answer.
  if (tiktokDirectOn('follow')) {
    try {
      return await followDirect(user, follow, log);
    } catch (e) {
      if (e instanceof SocialError) throw e;
      if (e instanceof GuestError && e.kind === 'status') throw new SocialError(`TikTok did not ${follow ? 'follow' : 'unfollow'} @${user} (${e.message})`);
      log(`@${user}: ${follow ? 'follow' : 'unfollow'} without the browser failed (${(e as Error).message.split(/\r?\n/)[0]}); pressing the button in the browser`);
    }
  }
  say(`opening @${user} in the signed-in browser on the server (Chromium) to press its follow button`, "pressing Follow in the server's browser");
  const warnings: string[] = [];
  return withWorkPage(log, async (page) => {
    installCapture(page);
    const p = await openProfile(page, user, log);
    let text: string | null = null;
    const deadline = Date.now() + 15_000;
    while (!text && Date.now() < deadline) {
      text = (await page.evaluate(READ_FOLLOW_BUTTON).catch(() => null)) as string | null;
      if (!text) await sleep(400);
    }
    const before = stateFromButton(text);
    if (!before) throw new SocialError(`@${user}: no follow button on the page${text ? ` (it says "${text}")` : ''}`);
    const followed = before !== 'none';
    if (followed === follow) {
      if (p.info) p.info.followState = before;
      rememberFollow(user, before);
      return { user, followState: before, warnings: [`already ${follow ? 'following' : 'not following'} @${user}`] };
    }
    await page.click('[data-e2e="follow-button"]');
    log(`@${user}: ${follow ? 'follow' : 'unfollow'} pressed (was "${text}")`);
    if (!follow) {
      // Some accounts ask "Unfollow?" in a dialog.
      await sleep(700);
      await page
        .evaluate(`(() => { for (const b of document.querySelectorAll('div[role="dialog"] button, [class*="Modal" i] button')) if (/^unfollow$/i.test((b.textContent || '').trim())) { b.click(); return true; } return false; })()`)
        .catch(() => undefined);
    }
    const until = Date.now() + 8000;
    let after: FollowState | undefined;
    while (Date.now() < until) {
      await sleep(400);
      after = stateFromButton((await page.evaluate(READ_FOLLOW_BUTTON).catch(() => null)) as string | null);
      if (after && after !== before) break;
      const loginWall = (await page.evaluate(`!!document.querySelector('[data-e2e="login-modal"], #login-modal, [class*="LoginModal" i]')`).catch(() => false)) as boolean;
      if (loginWall) {
        await page.keyboard.press('Escape').catch(() => undefined);
        throw new SocialError('TikTok asked for a sign-in instead of following: the session is no longer valid. Sign in again (Profile).', 401);
      }
    }
    if (!after || after === before) {
      warnings.push('TikTok did not confirm the change; the button still says the same');
      after = before;
    }
    if (p.info) p.info.followState = after;
    rememberFollow(user, after);
    log(`@${user}: follow state now "${after}"`);
    return { user, followState: after, warnings, via: 'browser' };
  }, `follow @${user}`);
}

// ---------------------------------------------------------------- like

/**
 * The like button of the video page, wherever TikTok's layout of the day puts it (data-e2e hooks),
 * and whether it shows the video as liked. `found` is the selector that matched; without one,
 * `hooks` lists what the page does have with "like" in its name (for the log).
 */
const LIKE_SELECTORS = ['[data-e2e="like-icon"]', '[data-e2e="browse-like-icon"]', '[data-e2e="video-like-icon"]'];
const READ_LIKE_BUTTON = `(() => {
  for (const s of ${JSON.stringify(LIKE_SELECTORS)}) {
    const ico = document.querySelector(s);
    if (!ico) continue;
    const b = ico.closest('button') || ico;
    const r = b.getBoundingClientRect();
    return { found: s, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), visible: r.width > 0 && r.height > 0 };
  }
  return { found: null, hooks: [...new Set([...document.querySelectorAll('[data-e2e]')].map((e) => e.getAttribute('data-e2e')))].filter((k) => /like|digg|heart/i.test(k || '')).slice(0, 20) };
})()`;

/** Whether the signed-in account has liked the video, and its like count: asked from inside the page (its scripts sign the request). */
async function likedNow(page: Page, id: string, log: (m: string) => void): Promise<{ liked?: boolean; likes?: number }> {
  const params = new URLSearchParams({ ...COMMON, itemId: id });
  const text = await fetchInPage(page, `${TT}/api/item/detail/?${params}`, 2, log);
  if (!text.trim()) return {};
  try {
    const s = JSON.parse(text)?.itemInfo?.itemStruct;
    return { liked: typeof s?.digged === 'boolean' ? s.digged : undefined, likes: num(s?.statsV2?.diggCount ?? s?.stats?.diggCount) };
  } catch {
    return {};
  }
}

/**
 * Likes a video, or takes the like back, by pressing the like button of the video's page in the
 * signed-in browser on the server. It has to be the browser: TikTok discards a like that is not
 * signed by the key its page keeps there ("ticket guard": a request made without the browser is
 * answered "ok" with `tt-ticket-guard-result: 1101` and changes nothing - tried 2026-11-25, see
 * research/tiktok_like_direct_probe.ts). So this works the same way for every account, the main one
 * included, and an account that otherwise asks TikTok without the browser starts its browser for it.
 * What TikTok says afterwards (the video's `digged`) is what is reported, not the press.
 */
export async function likeVideo(id: string, author: string, like: boolean, log: (m: string) => void): Promise<LikeResponse> {
  requireLogin(like ? 'like videos' : 'take a like back');
  const t0 = Date.now();
  say(`opening the video in the signed-in browser on the server (Chromium) to press its like button`, "pressing Like in the server's browser");
  return withWorkPage(
    log,
    async (page) => {
      const warnings: string[] = [];
      const url = videoPageUrl(author, id);
      if (page.url().split('?')[0] !== url) {
        say('opening the video on TikTok (step 1 of 3)', "step 1 of 3 · opening the video in the server's browser");
        log(`like ${id}: opening the video page`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        profile = undefined; // the page left the profile (if it was on one)
        commentAnswers = [];
        if (/\/login/.test(page.url())) throw new SocialError('TikTok sent the video page to its login: the session is no longer valid. Sign in again (Profile).', 401);
      }
      // What TikTok says now: a video that is already as asked is left alone.
      const before = await likedNow(page, id, log).catch(() => ({}) as { liked?: boolean; likes?: number });
      if (before.liked === like) {
        log(`like ${id}: already ${like ? 'liked' : 'not liked'}`);
        return { id, liked: like, likes: before.likes, warnings: [`the video was already ${like ? 'liked' : 'not liked'}`], via: 'browser' as const, elapsedMs: Date.now() - t0 };
      }
      say('looking for the like button on the page (step 2 of 3)', 'step 2 of 3 · finding the like button');
      let btn: { found: string | null; pressed?: string | null; label?: string | null; visible?: boolean; hooks?: string[] } = { found: null };
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        btn = (await page.evaluate(READ_LIKE_BUTTON).catch(() => ({ found: null }))) as typeof btn;
        if (btn.found && btn.visible) break;
        await sleep(400);
      }
      if (!btn.found || !btn.visible) {
        const title = String(await page.title().catch(() => ''));
        log(`like ${id}: no like button on the page (title "${title.slice(0, 60)}", hooks: ${(btn.hooks || []).join(', ') || 'none'})`);
        throw new SocialError(/log in/i.test(title) ? 'TikTok shows its login dialog on the video page: the session may be signed out (Profile → sign in again)' : "The video's page shows no like button (TikTok changed the page, or the video is not available)");
      }
      say(like ? 'pressing Like (step 3 of 3)' : 'taking the like back (step 3 of 3)', `step 3 of 3 · ${like ? 'pressing Like' : 'taking the like back'}`);
      // the page's own request, so its answer can be read as well as the button
      const answered = page.waitForResponse((r) => /\/api\/commit\/item\/digg\//.test(r.url()), { timeout: 9000 }).then(
        async (r) => ({ status: r.status(), guard: r.headers()['tt-ticket-guard-result'], json: await r.json().catch(() => undefined) }),
        () => undefined,
      );
      await page.click(btn.found);
      const answer = await answered;
      log(`like ${id}: ${like ? 'like' : 'unlike'} pressed (${btn.found}, was pressed=${btn.pressed}); the page's request: ${answer ? `HTTP ${answer.status}, status_code ${answer.json?.status_code}, is_digg ${answer.json?.is_digg}, guard ${answer.guard ?? '-'}` : 'not seen'}`);
      const loginWall = (await page.evaluate(`!!document.querySelector('[data-e2e="login-modal"], #login-modal, [class*="LoginModal" i]')`).catch(() => false)) as boolean;
      if (loginWall) {
        await page.keyboard.press('Escape').catch(() => undefined);
        throw new SocialError('TikTok asked for a sign-in instead of liking: the session is no longer valid. Sign in again (Profile).', 401);
      }
      // What TikTok says afterwards is the result (its answer can lag a moment behind the press).
      let after: { liked?: boolean; likes?: number } = {};
      for (let i = 0; i < 3; i++) {
        await sleep(i ? 1500 : 700);
        after = await likedNow(page, id, log).catch(() => ({}));
        if (after.liked === like) break;
      }
      let liked = after.liked;
      if (liked === undefined) {
        // TikTok did not say: the button's own state is the next best thing
        const now = (await page.evaluate(READ_LIKE_BUTTON).catch(() => ({ found: null }))) as typeof btn;
        liked = now.pressed === 'true' ? true : now.pressed === 'false' ? false : like;
        warnings.push('TikTok did not confirm the change; going by the button');
      } else if (liked !== like) warnings.push(`TikTok did not take the ${like ? 'like' : 'unlike'}: the video still reads as ${liked ? 'liked' : 'not liked'}`);
      log(`like ${id}: now ${liked ? 'liked' : 'not liked'}${after.likes !== undefined ? `, ${after.likes} likes` : ''}, ${Date.now() - t0} ms`);
      return { id, liked, likes: after.likes ?? before.likes, warnings, via: 'browser' as const, elapsedMs: Date.now() - t0 };
    },
    `${like ? 'like' : 'unlike'} ${id}`,
  );
}

// ---------------------------------------------------------------- comments

/**
 * The comments rendered on the video page (TikTok's data-e2e hooks: comment-level-1 is the text,
 * comment-username-1 / comment-time-1 / comment-like-count its neighbours), each reduced to its
 * fields; a fallback for when the page's own answer was not seen.
 */
const READ_COMMENTS_DOM = `(() => {
  const out = [];
  const seen = new Set();
  for (const t of document.querySelectorAll('[data-e2e="comment-level-1"]')) {
    let row = t;
    for (let i = 0; i < 6 && row.parentElement; i++) { row = row.parentElement; if (row.querySelector('[data-e2e="comment-username-1"]')) break; }
    if (seen.has(row)) continue;
    seen.add(row);
    const name = row.querySelector('[data-e2e="comment-username-1"]');
    const a = name ? name.closest('a[href]') || row.querySelector('a[href*="/@"]') : row.querySelector('a[href*="/@"]');
    const m = a ? (a.getAttribute('href') || '').match(/\\/@([^/?#]+)/) : null;
    const img = row.querySelector('img');
    const time = row.querySelector('[data-e2e="comment-time-1"]');
    const likes = row.querySelector('[data-e2e="comment-like-count"]');
    const reply = [...row.querySelectorAll('[data-e2e^="view-more"], [class*="ViewReplies" i], [class*="DivReplyAction" i]')].map((e) => e.innerText || '').join(' ');
    const rm = reply.match(/(\\d[\\d.,]*[KM]?)/i);
    out.push({ text: (t.innerText || '').trim(), nickname: name ? (name.innerText || '').trim() : '', uniqueId: m ? m[1] : undefined, avatar: img ? img.src : undefined, when: time ? (time.innerText || '').trim() : undefined, likes: likes ? (likes.innerText || '').trim() : undefined, replies: rm ? rm[1] : undefined, byAuthor: /creator|author/i.test(row.innerText || '') });
  }
  return out;
})()`;

const COMMENTS_DEBUG = `(() => {
  const e2e = [...new Set([...document.querySelectorAll('[data-e2e]')].map((e) => e.getAttribute('data-e2e')))];
  const cls = new Set();
  for (const el of document.querySelectorAll('[class]')) for (const c of String(el.className).split(/\\s+/)) if (/comment/i.test(c)) cls.add(c);
  return { url: location.href, title: document.title, e2e: e2e.filter((k) => /comment|login|captcha|verify|reply/i.test(k)), classes: [...cls].slice(0, 80), commentNodes: document.querySelectorAll('[data-e2e="comment-level-1"]').length, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200) };
})()`;

/** "1.2K" / "45" / "3M" as a number */
export const countOf = (s: unknown): number | undefined => {
  const m = String(s ?? '')
    .trim()
    .match(/^(\d+(?:[.,]\d+)?)\s*([KM])?$/i);
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  return Math.round(n * (m[2]?.toUpperCase() === 'M' ? 1e6 : m[2]?.toUpperCase() === 'K' ? 1e3 : 1));
};

function commentFromApi(c: any): VideoComment | undefined {
  if (!c?.cid && !c?.text) return undefined;
  const u = c.user || {};
  return {
    id: String(c.cid || c.text),
    text: String(c.text || ''),
    user: { id: u.uid ? String(u.uid) : undefined, uniqueId: u.unique_id, nickname: u.nickname, avatar: u.avatar_thumb?.url_list?.[0] || u.avatar_medium?.url_list?.[0] },
    time: num(c.create_time),
    likes: num(c.digg_count),
    replies: num(c.reply_comment_total),
    byAuthor: c.author_pin === 1 || c.is_author === true || c.label_text === 'Creator' || undefined,
  };
}

const videoPageUrl = (author: string, id: string): string => `${TT}/@${encodeURIComponent(author)}/video/${id}`;

/** TikTok's comment/list JSON as our comments: the list, where the next page starts, whether there is one. */
export function commentsFromAnswer(answer: any, cursor: number): { comments: VideoComment[]; cursor: number; hasMore: boolean; total?: number } {
  const comments = (Array.isArray(answer?.comments) ? answer.comments : []).map(commentFromApi).filter(Boolean) as VideoComment[];
  return { comments, cursor: num(answer?.cursor) ?? cursor + comments.length, hasMore: answer?.has_more === 1 || answer?.has_more === true, total: num(answer?.total) };
}

/**
 * A video's comments, asked as a guest without a browser (tiktokGuest.ts: one signed request over a
 * Chrome-like connection, about a second). Undefined when that path is not usable right now;
 * GuestError when TikTok would not answer it.
 */
export async function fetchCommentsAsGuest(id: string, cursor: number, log: (m: string) => void, signal?: AbortSignal): Promise<CommentsResponse | undefined> {
  if (guestUnusable()) return undefined;
  const t0 = Date.now();
  return tracked('comments', signal, async (sig) => {
    const r = await guestCommentList(id, cursor, log, sig);
    const page = commentsFromAnswer(r.json, cursor);
    const warnings = page.comments.length || cursor > 0 ? [] : ['No comments yet'];
    log(`comments ${id} from ${cursor}: ${page.comments.length} (guest${r.attempts > 1 ? `, attempt ${r.attempts}` : ''}), more: ${page.hasMore}, ${Date.now() - t0} ms`);
    return { id, ...page, how: 'guest', warnings, elapsedMs: Date.now() - t0 };
  });
}

/**
 * The replies under one comment, asked as a guest without a browser (there is no browser path for
 * these: the panel never showed replies before). TikTok hands out a few per page and leaves
 * `has_more` at 0 even when more remain, so "more" is decided by the cursor against the total.
 */
export async function fetchCommentReplies(id: string, commentId: string, cursor: number, log: (m: string) => void, signal?: AbortSignal): Promise<CommentRepliesResponse> {
  const why = guestUnusable('replies');
  if (why) throw new SocialError(`Replies cannot be read right now (${why})`, 503);
  const t0 = Date.now();
  return tracked('comments', signal, async (sig) => {
    let r;
    try {
      r = await guestReplyList(id, commentId, cursor, log, sig);
    } catch (e) {
      if (isCancelled(e) || !(e instanceof GuestError)) throw e;
      throw new SocialError(`TikTok did not give the replies to the server (${e.message})`, 502);
    }
    const page = commentsFromAnswer(r.json, cursor);
    const hasMore = page.comments.length > 0 && (page.total !== undefined ? page.cursor < page.total : page.hasMore);
    log(`replies ${id}/${commentId} from ${cursor}: ${page.comments.length} (guest), total ${page.total ?? '?'}, more: ${hasMore}, ${Date.now() - t0} ms`);
    return { id, commentId, comments: page.comments, cursor: page.cursor, hasMore, total: page.total, warnings: [], elapsedMs: Date.now() - t0 };
  });
}

/**
 * A video's comments. First as a guest without a browser (fetchCommentsAsGuest). When that is not
 * usable or TikTok does not answer it: from the signed-in work page - the page's own comment/list
 * answer (the list scrolled for the next page), else a request from inside the page, else the
 * rendered comments. `signal` (the request's) cancels the read; POST /api/comments/cancel does as well.
 */
export async function fetchComments(id: string, author: string, cursor: number, log: (m: string) => void, signal?: AbortSignal): Promise<CommentsResponse> {
  let guestWhy = guestUnusable();
  if (!guestWhy) {
    try {
      const direct = await fetchCommentsAsGuest(id, cursor, log, signal);
      if (direct) return direct;
    } catch (e) {
      if (isCancelled(e)) throw e;
      guestWhy = (e as Error).message;
      log(`comments ${id}: the request without a browser failed (${guestWhy}); ${isLoggedIn() ? 'reading the video page in the signed-in browser instead' : 'no signed-in browser to fall back to'}`);
    }
  }
  // A guest page in the browser shows TikTok's login dialog and no comments (seen 2026-11-05): the fallback needs the sign-in.
  if (!isLoggedIn()) {
    if (/^switched off/.test(guestWhy || '')) requireLogin('read comments');
    throw new SocialError(`TikTok did not give the comments to the server (${guestWhy}). Signing in to TikTok (Profile) lets the server read them from the video page instead.`, 502);
  }
  say('reading the comments from the video page in the signed-in browser (slower)', 'opening the video on TikTok');
  const t0 = Date.now();
  return tracked('comments', signal, (sig) =>
    withWorkPage(
      log,
      async (page) => {
        throwIfCancelled(sig);
        installCapture(page);
        const warnings: string[] = [];
        const url = videoPageUrl(author, id);
        const onPage = page.url().split('?')[0] === url;
        const wanted = (a: { url: string }): boolean => {
          try {
            const q = new URL(a.url).searchParams;
            return q.get('aweme_id') === id && Number(q.get('cursor') || 0) === cursor;
          } catch {
            return false;
          }
        };
        if (!onPage) {
          commentAnswers = [];
          log(`comments ${id}: opening the video page`);
          await cancellable(page, page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }), sig);
          profile = undefined; // the page left the profile (if it was on one)
          if (/\/login/.test(page.url())) throw new SocialError('TikTok sent the video page to its login: the session is no longer valid. Sign in again (Profile).', 401);
        } else if (cursor > 0 && !commentAnswers.some(wanted)) {
          // The next page: TikTok asks for it when the list is scrolled to its end.
          await page
            .evaluate(`(() => { const sels = ['[data-e2e="comment-list"]', '[class*="DivCommentListContainer" i]', '[class*="CommentList" i]']; for (const s of sels) { const p = document.querySelector(s); if (p) { p.scrollTop = p.scrollHeight; return s; } } window.scrollTo(0, document.body.scrollHeight); return 'window'; })()`)
            .catch(() => undefined);
        }
        let answer: any;
        let how: CommentsResponse['how'] = 'page';
        const until = Date.now() + (onPage ? 8_000 : 12_000);
        while (!answer && Date.now() < until) {
          answer = commentAnswers.find(wanted)?.json;
          if (!answer) await sleep(400, sig);
        }
        if (!answer) {
          // The page did not ask (or its answer was not seen): ask from inside it, signed by its scripts.
          how = 'fetch';
          const params = new URLSearchParams({ ...COMMON, aweme_id: id, count: '20', cursor: String(cursor), enter_from: 'tiktok_web', fromWeb: '1', current_region: 'US' });
          try {
            const text = await fetchInPage(page, `${TT}/api/comment/list/?${params}`, 2, log, sig);
            if (text.trim()) answer = JSON.parse(text);
            else warnings.push('TikTok answered the comment request from inside the page with an empty body');
          } catch (e) {
            if (isCancelled(e)) throw e;
            warnings.push(`comment request from inside the page failed (${(e as Error).message})`);
          }
        }
        let comments: VideoComment[] = [];
        let next = cursor;
        let hasMore = false;
        let total: number | undefined;
        if (answer) {
          const code = Number(answer.status_code ?? answer.statusCode ?? 0);
          if (code !== 0) warnings.push(`TikTok comment list status ${code}: ${answer.status_msg || answer.statusMsg || 'unavailable'}`);
          ({ comments, cursor: next, hasMore, total } = commentsFromAnswer(answer, cursor));
        }
        if (!comments.length) {
          // The rendered comments (whatever the page shows), the ones after `cursor` of them.
          const dom = ((await page.evaluate(READ_COMMENTS_DOM).catch(() => [])) as any[]).map(
            (d, i): VideoComment => ({ id: `dom:${i}:${d.text.slice(0, 40)}`, text: d.text, user: { uniqueId: d.uniqueId, nickname: d.nickname, avatar: d.avatar }, when: d.when, likes: countOf(d.likes), replies: countOf(d.replies), byAuthor: d.byAuthor || undefined }),
          );
          if (dom.length) {
            how = 'dom';
            comments = dom.slice(cursor);
            next = dom.length;
            hasMore = false;
          } else if (!answer) {
            const txt = String(await page.evaluate('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ');
            const title = String(await page.title().catch(() => ''));
            warnings.push(/log in/i.test(title) ? 'TikTok shows its login dialog on the video page: the session may be signed out (Profile → sign in again)' : /no comments yet|be the first to comment/i.test(txt) ? 'No comments yet' : `No comments found on the page (${txt.slice(0, 120)})`);
          }
        }
        // (last: the panel shows the first warning when there is nothing to list)
        if (guestWhy) warnings.push(`the request without a browser was not used: ${guestWhy}`);
        log(`comments ${id} from ${cursor}: ${comments.length} (${how}), more: ${hasMore}, ${Date.now() - t0} ms`);
        return { id, comments, cursor: next, hasMore, total, how, warnings, elapsedMs: Date.now() - t0 };
      },
      'comments',
    ),
  );
}

/** What the video page contains (for tuning the comment hooks on the deployed server). */
export async function commentsDebug(id: string, author: string, log: (m: string) => void, signal?: AbortSignal): Promise<unknown> {
  requireLogin('read comments');
  return tracked('comments', signal, (sig) =>
    withWorkPage(
      log,
      async (page) => {
        throwIfCancelled(sig);
        installCapture(page);
        const url = videoPageUrl(author, id);
        if (page.url().split('?')[0] !== url) {
          commentAnswers = [];
          await cancellable(page, page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }), sig);
          profile = undefined;
        }
        await sleep(6000, sig);
        const dbg = (await page.evaluate(COMMENTS_DEBUG)) as Record<string, unknown>;
        const dom = await page.evaluate(READ_COMMENTS_DOM).catch((e: Error) => e.message);
        const answers = commentAnswers.map((a) => ({ url: a.url.slice(0, 200), status_code: a.json?.status_code, total: a.json?.total, has_more: a.json?.has_more, cursor: a.json?.cursor, n: Array.isArray(a.json?.comments) ? a.json.comments.length : undefined, first: a.json?.comments?.[0] }));
        return { ...dbg, answers, dom };
      },
      'comments debug',
    ),
  );
}

// ---------------------------------------------------------------- messages

/**
 * Finds the conversation rows of TikTok's /messages page. Selectors are tried in turn (TikTok's
 * class names are generated; the data-e2e hooks are the stable ones) and each row is reduced to
 * its text lines + avatar.
 */
const READ_CONVERSATIONS = `(() => {
  const sels = ['[data-e2e="chat-list-item"]', '[class*="DivItemWrapper" i]', '[class*="ChatListItem" i]', '[class*="chat-list" i] li', '[class*="ChatList" i] [class*="Item" i]'];
  let nodes = [];
  for (const s of sels) { nodes = [...document.querySelectorAll(s)]; if (nodes.length) break; }
  return nodes.map((n, i) => {
    const img = n.querySelector('img');
    const lines = (n.innerText || '').split('\\n').map((t) => t.trim()).filter(Boolean);
    return { index: i, title: lines[0] || '', preview: lines[1] || '', time: lines[2] || '', avatar: img ? img.src : undefined, unread: !!n.querySelector('[class*="unread" i], [class*="Badge" i], [class*="Dot" i]') };
  });
})()`;

const READ_MESSAGES = `(() => {
  const sels = ['[data-e2e="chat-item"]', '[class*="DivMessageContainer" i]', '[class*="ChatItem" i]', '[class*="DivChatItem" i]', '[class*="MessageItem" i]'];
  let nodes = [];
  for (const s of sels) { nodes = [...document.querySelectorAll(s)]; if (nodes.length) break; }
  const box = nodes.length ? nodes[0].parentElement.getBoundingClientRect() : { left: 0, width: window.innerWidth };
  const mid = box.left + box.width / 2;
  const timeRe = /^(\\d{1,2}:\\d{2}( ?[ap]m)?|\\w{3} \\d{1,2}(, \\d{4})?|today|yesterday|\\d{1,2}\\/\\d{1,2}(\\/\\d{2,4})?)$/i;
  return nodes.map((n, i) => {
    const r = n.getBoundingClientRect();
    const a = n.querySelector('a[href]');
    const media = !!n.querySelector('video, canvas, [class*="Video" i], [class*="Cover" i]');
    const lines = (n.innerText || '').split('\\n').map((t) => t.trim()).filter(Boolean);
    const time = lines.find((l) => timeRe.test(l));
    const text = lines.filter((l) => l !== time).join(' ');
    const mine = n.matches('[class*="mine" i], [class*="self" i], [class*="Right" i]') || !!n.querySelector('[class*="mine" i], [class*="self" i]') || r.left + r.width / 2 > mid;
    return { index: i, text, time, from: mine ? 'me' : 'them', link: a ? a.href : undefined, media };
  });
})()`;

const READ_EDITOR = `(() => {
  const sels = ['[data-e2e="message-input-area"] [contenteditable="true"]', '[data-e2e="message-input-area"]', '[contenteditable="true"][class*="Editor" i]', '[class*="Chat" i] [contenteditable="true"]', '[contenteditable="true"]', 'textarea'];
  for (const s of sels) { const el = document.querySelector(s); if (el) { el.setAttribute('data-sa-editor', '1'); return { sel: s, text: el.innerText || el.value || '' }; } }
  return null;
})()`;

const PAGE_DEBUG = `(() => {
  const e2e = [...new Set([...document.querySelectorAll('[data-e2e]')].map((e) => e.getAttribute('data-e2e')))];
  const cls = new Set();
  for (const el of document.querySelectorAll('[class]')) for (const c of String(el.className).split(/\\s+/)) if (/chat|message|conversation|inbox|editor|input/i.test(c)) cls.add(c);
  return { url: location.href, title: document.title, e2e, classes: [...cls].slice(0, 120), text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1500) };
})()`;

interface RawConversation {
  index: number;
  title: string;
  preview: string;
  time: string;
  avatar?: string;
  unread: boolean;
}
interface RawMessage {
  index: number;
  text: string;
  time?: string;
  from: 'me' | 'them';
  link?: string;
  media: boolean;
}

const convId = (c: RawConversation): string => `${c.index}:${c.title}`;
const toConversation = (c: RawConversation): Conversation => ({ id: convId(c), title: c.title, avatar: c.avatar, preview: c.preview || undefined, time: c.time || undefined, unread: c.unread });

async function gotoMessages(page: Page, log: (m: string) => void, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  if (page.url().startsWith(`${TT}/messages`)) return;
  log('messages: opening /messages');
  await cancellable(page, page.goto(MESSAGES_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }), signal);
  if (/\/login/.test(page.url())) throw new SocialError('TikTok sent the messages page to its login: the session is no longer valid. Sign in again (Profile).', 401);
}

async function readConversations(page: Page, waitMs: number, signal?: AbortSignal): Promise<RawConversation[]> {
  const until = Date.now() + waitMs;
  let list: RawConversation[] = [];
  while (Date.now() < until) {
    throwIfCancelled(signal);
    list = ((await page.evaluate(READ_CONVERSATIONS).catch(() => [])) as RawConversation[]).filter((c) => c.title);
    if (list.length) break;
    await sleep(500, signal);
  }
  return list;
}

async function readMessages(page: Page, waitMs: number, signal?: AbortSignal): Promise<RawMessage[]> {
  const until = Date.now() + waitMs;
  let list: RawMessage[] = [];
  while (Date.now() < until) {
    throwIfCancelled(signal);
    list = ((await page.evaluate(READ_MESSAGES).catch(() => [])) as RawMessage[]).filter((m) => m.text || m.media || m.link);
    if (list.length) break;
    await sleep(500, signal);
  }
  return list;
}

const toMessages = (raw: RawMessage[]): ChatMessage[] => raw.map((m) => ({ id: String(m.index), from: m.from, text: m.text || (m.media ? 'Shared video' : m.link ? 'Link' : ''), time: m.time, kind: m.media ? 'media' : m.text ? 'text' : 'other', link: m.link }));

/** The conversation list. `signal` (the request's) cancels the read; POST /api/inbox/cancel does as well. */
export async function inbox(log: (m: string) => void, signal?: AbortSignal): Promise<InboxResponse> {
  requireLogin('read messages');
  const t0 = Date.now();
  return tracked('inbox', signal, (sig) =>
    withWorkPage(
      log,
      async (page) => {
        // Cancelled while waiting in line for the work page: hand it on without touching it.
        throwIfCancelled(sig);
        await gotoMessages(page, log, sig);
        const list = await readConversations(page, 12_000, sig);
        const warnings: string[] = [];
        if (!list.length) {
          const txt = String(await page.evaluate('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ');
          warnings.push(/no messages|start a chat|no conversations/i.test(txt) ? 'No conversations yet' : `No conversation list found on the page (${txt.slice(0, 120)})`);
        }
        log(`messages: ${list.length} conversation(s)`);
        return { conversations: list.map(toConversation), warnings, elapsedMs: Date.now() - t0 };
      },
      'inbox',
    ),
  );
}

/** Opens the thread (an inbox id, or "@handle" through the profile's Message button) and reads it. */
async function openThread(page: Page, id: string, log: (m: string) => void, signal?: AbortSignal): Promise<{ conversation: Conversation; messages: ChatMessage[]; canSend: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  let conversation: Conversation | undefined;
  throwIfCancelled(signal);
  if (id.startsWith('@')) {
    const user = id.slice(1);
    installCapture(page);
    await openProfile(page, user, log, signal);
    const until = Date.now() + 15_000;
    let clicked = false;
    while (!clicked && Date.now() < until) {
      throwIfCancelled(signal);
      clicked = (await page.evaluate(`(() => { const b = document.querySelector('[data-e2e="message-button"]'); if (!b) return false; b.click(); return true; })()`).catch(() => false)) as boolean;
      if (!clicked) await sleep(400, signal);
    }
    if (!clicked) throw new SocialError(`@${user}: the profile has no Message button (TikTok does not allow messaging this account)`);
    const t = Date.now() + 15_000;
    while (!page.url().startsWith(`${TT}/messages`) && Date.now() < t) await sleep(400, signal);
    if (!page.url().startsWith(`${TT}/messages`)) throw new SocialError(`@${user}: TikTok did not open the conversation (${page.url()})`);
    profile = undefined; // the page left the profile
    await sleep(1500, signal);
    const list = await readConversations(page, 5000, signal);
    const row = list.find((c) => sameUser(c.title, user) || c.title.toLowerCase().includes(user.toLowerCase()));
    conversation = row ? toConversation(row) : { id, title: user };
  } else {
    await gotoMessages(page, log, signal);
    const list = await readConversations(page, 12_000, signal);
    const [idxStr, ...rest] = id.split(':');
    const title = rest.join(':');
    const row = list.find((c) => c.index === Number(idxStr) && c.title === title) || list.find((c) => c.title === title);
    if (!row) throw new SocialError(`Conversation "${title || id}" is not in the list any more`, 404);
    conversation = toConversation(row);
    const sel = ['[data-e2e="chat-list-item"]', '[class*="DivItemWrapper" i]', '[class*="ChatListItem" i]', '[class*="chat-list" i] li', '[class*="ChatList" i] [class*="Item" i]'];
    const ok = (await page.evaluate(`(() => { for (const s of ${JSON.stringify(sel)}) { const n = document.querySelectorAll(s); if (n.length) { const el = n[${row.index}]; if (!el) return false; el.click(); return true; } } return false; })()`).catch(() => false)) as boolean;
    if (!ok) throw new SocialError('The conversation row could not be opened');
    await sleep(1200, signal);
  }
  const raw = await readMessages(page, 8000, signal);
  const editor = (await page.evaluate(READ_EDITOR).catch(() => null)) as { sel: string; text: string } | null;
  if (!raw.length) warnings.push('No messages found in the thread (or the page did not render it)');
  return { conversation, messages: toMessages(raw), canSend: Boolean(editor), warnings };
}

/** Opens and reads one thread. `signal` (the request's) cancels the read; POST /api/inbox/cancel does as well. */
export async function conversation(id: string, log: (m: string) => void, signal?: AbortSignal): Promise<ConversationResponse> {
  requireLogin('read messages');
  const t0 = Date.now();
  return tracked('inbox', signal, (sig) =>
    withWorkPage(
      log,
      async (page) => {
        throwIfCancelled(sig);
        const r = await openThread(page, id, log, sig);
        log(`messages: "${r.conversation.title}" – ${r.messages.length} message(s), can send: ${r.canSend}`);
        return { ...r, elapsedMs: Date.now() - t0 };
      },
      'conversation',
    ),
  );
}

/** Sends `text`. The request's `signal` stops the work only while the thread is being opened: once typing started, the message goes out. */
export async function sendMessage(id: string, text: string, log: (m: string) => void, signal?: AbortSignal): Promise<SendMessageResponse> {
  requireLogin('send messages');
  const msg = text.trim();
  if (!msg) throw new SocialError('Nothing to send', 400);
  if (msg.length > 1000) throw new SocialError('Messages are limited to 1000 characters', 400);
  const t0 = Date.now();
  return withWorkPage(log, async (page) => {
    throwIfCancelled(signal);
    const opened = await openThread(page, id, log, signal);
    if (!opened.canSend) throw new SocialError('TikTok offers no message box for this conversation');
    const before = opened.messages.filter((m) => m.from === 'me').length;
    await page.click('[data-sa-editor="1"]').catch(() => undefined);
    await page.keyboard.type(msg, { delay: 15 });
    await sleep(300);
    const typed = (await page.evaluate(READ_EDITOR).catch(() => null)) as { sel: string; text: string } | null;
    if (!typed || !typed.text.includes(msg.slice(0, 20))) {
      // React editors sometimes swallow key events; insert the text the way a paste would.
      await page.evaluate(`(() => { const el = document.querySelector('[data-sa-editor="1"]'); if (!el) return; el.focus(); document.execCommand('insertText', false, ${JSON.stringify(msg)}); })()`).catch(() => undefined);
      await sleep(300);
    }
    await page.keyboard.press('Enter');
    await sleep(1200);
    const still = (await page.evaluate(READ_EDITOR).catch(() => null)) as { sel: string; text: string } | null;
    if (still && still.text.trim()) {
      // Enter did not send: use the send button.
      await page.evaluate(`(() => { const b = document.querySelector('[data-e2e="message-send"], button[aria-label*="send" i], [class*="SendButton" i]'); if (b) b.click(); })()`).catch(() => undefined);
      await sleep(1200);
    }
    const raw = await readMessages(page, 5000);
    const messages = toMessages(raw);
    const mine = messages.filter((m) => m.from === 'me');
    const sent = mine.length > before || mine.some((m) => m.text.includes(msg.slice(0, 40)));
    const warnings = opened.warnings.slice();
    if (!sent) warnings.push('The message does not show in the thread yet; check the conversation again in a moment');
    log(`messages: sent to "${opened.conversation.title}": ${sent}`);
    return { conversation: opened.conversation, messages, canSend: true, sent, warnings, elapsedMs: Date.now() - t0 };
  }, 'send message');
}

/** What the messages page contains (for tuning the selectors on the deployed server). */
export async function inboxDebug(log: (m: string) => void, signal?: AbortSignal): Promise<unknown> {
  requireLogin('read messages');
  return tracked('inbox', signal, (sig) =>
    withWorkPage(
      log,
      async (page) => {
        throwIfCancelled(sig);
        await gotoMessages(page, log, sig);
        await sleep(3000, sig);
        const dbg = (await page.evaluate(PAGE_DEBUG)) as Record<string, unknown>;
        const conversations = await page.evaluate(READ_CONVERSATIONS).catch((e: Error) => e.message);
        const messages = await page.evaluate(READ_MESSAGES).catch((e: Error) => e.message);
        const editor = await page.evaluate(READ_EDITOR).catch((e: Error) => e.message);
        return { ...dbg, conversations, messages, editor };
      },
      'inbox debug',
    ),
  );
}
