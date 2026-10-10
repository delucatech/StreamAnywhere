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
 *              Guest search answers carry most videos without play URLs: those items are kept
 *              with no formats and the viewer resolves them through POST /api/resolve.
 *  - follow:   the profile page has a real `[data-e2e="follow-button"]` ("Follow" / "Following" /
 *              "Friends"); clicking it is TikTok's own code path. Needs the signed-in session
 *              (signed out, the click opens TikTok's login dialog).
 *  - messages: /messages needs the signed-in session (guest = redirect to /login). Read and sent
 *              through the page's DOM; the selectors are best-effort and /api/inbox/debug shows
 *              what the page actually contains, for tuning on the deployed server.
 */
import type { Page } from 'puppeteer-core';
import type { ChatMessage, Conversation, ConversationResponse, FeedItem, FollowResponse, FollowState, InboxResponse, ProfileResponse, SearchResponse, SendMessageResponse, UserSummary } from '../../shared/types';
import { itemToFeedItem } from './feed';
import { isLoggedIn, pageCookieHeader, withWorkPage } from './session';

const TT = 'https://www.tiktok.com';
const MESSAGES_URL = `${TT}/messages?lang=en`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
};

export class SocialError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
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

/** Records the page's own user/detail and post/item_list answers (hand-built requests are refused). */
function installCapture(page: Page): void {
  if (installed.has(page)) return;
  installed.add(page);
  page.on('response', (res) => {
    const u = res.url();
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

function relationToState(rel: unknown): FollowState {
  switch (Number(rel)) {
    case 0:
      return 'none';
    case 1:
      return 'following';
    case 2:
      return 'friends';
    case 4:
      return 'requested';
    default:
      return 'unknown';
  }
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

async function fetchInPage(page: Page, url: string, attempts = 3): Promise<string> {
  let text = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = (await page.evaluate(`fetch(${JSON.stringify(url)}, { credentials: 'include' }).then(async (r) => ({ status: r.status, text: await r.text() }))`)) as { status: number; text: string };
    if (r.status === 403) throw new SocialError('TikTok refused the request (HTTP 403)');
    text = r.text;
    if (text.trim()) break;
    if (attempt < attempts) await sleep(1200 * attempt);
  }
  return text;
}

export async function searchTikTok(q: string, offset: number, log: (m: string) => void): Promise<SearchResponse> {
  const t0 = Date.now();
  const warnings: string[] = [];
  return withWorkPage(log, async (page) => {
    const params = new URLSearchParams({ ...COMMON, from_page: 'search', keyword: q, offset: String(offset), search_source: 'normal_search', web_search_code: '{"tiktok":{"client_params_x":{"search_engine":{"ies_mt_user_live_video_card_use_libra":1,"mt_search_general_user_live_card":1}},"search_server":{}}}' });
    if (offset && lastSearch?.q === q && lastSearch.id) params.set('search_id', lastSearch.id);
    const text = await fetchInPage(page, `${TT}/api/search/general/full/?${params}`);
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
    const items: FeedItem[] = [];
    const users: UserSummary[] = [];
    const seenUsers = new Set<string>();
    const addUser = (ui: any) => {
      const u = userFromSearch(ui);
      if (u && !seenUsers.has(u.uniqueId)) {
        seenUsers.add(u.uniqueId);
        users.push(u);
      }
    };
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
    lastSearch = { q, id: json.extra?.logid || json.log_pb?.impr_id || lastSearch?.id };
    if (offset === 0) {
      // Accounts matching the words: a separate endpoint; best effort (it may be refused).
      try {
        const up = new URLSearchParams({ ...COMMON, from_page: 'search', keyword: q, cursor: '0', count: '12', search_source: 'normal_search' });
        const ut = await fetchInPage(page, `${TT}/api/search/user/full/?${up}`, 1);
        const uj = ut.trim() ? JSON.parse(ut) : undefined;
        for (const ul of Array.isArray(uj?.user_list) ? uj.user_list : []) addUser(ul?.user_info || ul);
      } catch (e) {
        warnings.push(`account search unavailable (${(e as Error).message})`);
      }
    }
    log(`search "${q}" offset ${offset}: ${items.length} videos, ${users.length} accounts`);
    const next = num(json.cursor);
    return { q, items, users, hasMore: json.has_more === 1 || json.has_more === true, offset: next !== undefined && next > offset ? next : offset + Math.max(items.length, 1), warnings, elapsedMs: Date.now() - t0 };
  });
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
}
let profile: ProfileState | undefined;

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

async function openProfile(page: Page, user: string, log: (m: string) => void): Promise<ProfileState> {
  if (profile && sameUser(profile.user, user) && onProfilePage(page, user)) return profile;
  captured = [];
  profile = { user, items: [], ids: new Set(), hasMore: true, cookieHeader: '' };
  log(`profile @${user}: opening the page`);
  await page.goto(`${TT}/@${encodeURIComponent(user)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  profile.cookieHeader = await pageCookieHeader(page);
  return profile;
}

export async function fetchProfile(user: string, offset: number, count: number, log: (m: string) => void): Promise<ProfileResponse> {
  const t0 = Date.now();
  const warnings: string[] = [];
  return withWorkPage(log, async (page) => {
    installCapture(page);
    const p = await openProfile(page, user, log);
    const deadline = Date.now() + 20_000;
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
    }
    absorbProfile(p);
    if (!p.info) {
      const txt = String(await page.evaluate('document.body.innerText').catch(() => ''));
      if (/couldn.t find this account|this account is private|no content/i.test(txt) && !p.items.length) throw new SocialError(`@${user}: ${/private/i.test(txt) ? 'this account is private' : 'TikTok could not find this account'}`, 404);
      const a = p.items[0]?.author;
      if (a?.uniqueId) {
        p.info = { id: a.id, uniqueId: a.uniqueId, nickname: a.nickname, avatar: a.avatar, followState: 'unknown' };
        warnings.push('TikTok did not deliver the profile details; showing what the videos carry');
      } else throw new SocialError(`@${user}: TikTok did not deliver the profile (${txt.replace(/\s+/g, ' ').slice(0, 100)})`);
    }
    const btn = stateFromButton((await page.evaluate(READ_FOLLOW_BUTTON).catch(() => null)) as string | null);
    if (btn && isLoggedIn()) p.info.followState = btn;
    const items = p.items.slice(offset, offset + count);
    log(`profile @${user}: ${items.length} videos served (offset ${offset}, ${p.items.length} captured, more: ${p.hasMore})`);
    return { user: p.info, items, offset, hasMore: p.hasMore && (stale < 8 || p.items.length > offset + count), warnings, elapsedMs: Date.now() - t0 };
  });
}

// ---------------------------------------------------------------- follow

export async function followUser(user: string, follow: boolean, log: (m: string) => void): Promise<FollowResponse> {
  requireLogin(follow ? 'follow accounts' : 'unfollow accounts');
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
    log(`@${user}: follow state now "${after}"`);
    return { user, followState: after, warnings };
  });
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

async function gotoMessages(page: Page, log: (m: string) => void): Promise<void> {
  if (page.url().startsWith(`${TT}/messages`)) return;
  log('messages: opening /messages');
  await page.goto(MESSAGES_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (/\/login/.test(page.url())) throw new SocialError('TikTok sent the messages page to its login: the session is no longer valid. Sign in again (Profile).', 401);
}

async function readConversations(page: Page, waitMs: number): Promise<RawConversation[]> {
  const until = Date.now() + waitMs;
  let list: RawConversation[] = [];
  while (Date.now() < until) {
    list = ((await page.evaluate(READ_CONVERSATIONS).catch(() => [])) as RawConversation[]).filter((c) => c.title);
    if (list.length) break;
    await sleep(500);
  }
  return list;
}

async function readMessages(page: Page, waitMs: number): Promise<RawMessage[]> {
  const until = Date.now() + waitMs;
  let list: RawMessage[] = [];
  while (Date.now() < until) {
    list = ((await page.evaluate(READ_MESSAGES).catch(() => [])) as RawMessage[]).filter((m) => m.text || m.media || m.link);
    if (list.length) break;
    await sleep(500);
  }
  return list;
}

const toMessages = (raw: RawMessage[]): ChatMessage[] => raw.map((m) => ({ id: String(m.index), from: m.from, text: m.text || (m.media ? 'Shared video' : m.link ? 'Link' : ''), time: m.time, kind: m.media ? 'media' : m.text ? 'text' : 'other', link: m.link }));

export async function inbox(log: (m: string) => void): Promise<InboxResponse> {
  requireLogin('read messages');
  const t0 = Date.now();
  return withWorkPage(log, async (page) => {
    await gotoMessages(page, log);
    const list = await readConversations(page, 12_000);
    const warnings: string[] = [];
    if (!list.length) {
      const txt = String(await page.evaluate('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ');
      warnings.push(/no messages|start a chat|no conversations/i.test(txt) ? 'No conversations yet' : `No conversation list found on the page (${txt.slice(0, 120)})`);
    }
    log(`messages: ${list.length} conversation(s)`);
    return { conversations: list.map(toConversation), warnings, elapsedMs: Date.now() - t0 };
  });
}

/** Opens the thread (an inbox id, or "@handle" through the profile's Message button) and reads it. */
async function openThread(page: Page, id: string, log: (m: string) => void): Promise<{ conversation: Conversation; messages: ChatMessage[]; canSend: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  let conversation: Conversation | undefined;
  if (id.startsWith('@')) {
    const user = id.slice(1);
    installCapture(page);
    await openProfile(page, user, log);
    const until = Date.now() + 15_000;
    let clicked = false;
    while (!clicked && Date.now() < until) {
      clicked = (await page.evaluate(`(() => { const b = document.querySelector('[data-e2e="message-button"]'); if (!b) return false; b.click(); return true; })()`).catch(() => false)) as boolean;
      if (!clicked) await sleep(400);
    }
    if (!clicked) throw new SocialError(`@${user}: the profile has no Message button (TikTok does not allow messaging this account)`);
    const t = Date.now() + 15_000;
    while (!page.url().startsWith(`${TT}/messages`) && Date.now() < t) await sleep(400);
    if (!page.url().startsWith(`${TT}/messages`)) throw new SocialError(`@${user}: TikTok did not open the conversation (${page.url()})`);
    profile = undefined; // the page left the profile
    await sleep(1500);
    const list = await readConversations(page, 5000);
    const row = list.find((c) => sameUser(c.title, user) || c.title.toLowerCase().includes(user.toLowerCase()));
    conversation = row ? toConversation(row) : { id, title: user };
  } else {
    await gotoMessages(page, log);
    const list = await readConversations(page, 12_000);
    const [idxStr, ...rest] = id.split(':');
    const title = rest.join(':');
    const row = list.find((c) => c.index === Number(idxStr) && c.title === title) || list.find((c) => c.title === title);
    if (!row) throw new SocialError(`Conversation "${title || id}" is not in the list any more`, 404);
    conversation = toConversation(row);
    const sel = ['[data-e2e="chat-list-item"]', '[class*="DivItemWrapper" i]', '[class*="ChatListItem" i]', '[class*="chat-list" i] li', '[class*="ChatList" i] [class*="Item" i]'];
    const ok = (await page.evaluate(`(() => { for (const s of ${JSON.stringify(sel)}) { const n = document.querySelectorAll(s); if (n.length) { const el = n[${row.index}]; if (!el) return false; el.click(); return true; } } return false; })()`).catch(() => false)) as boolean;
    if (!ok) throw new SocialError('The conversation row could not be opened');
    await sleep(1200);
  }
  const raw = await readMessages(page, 8000);
  const editor = (await page.evaluate(READ_EDITOR).catch(() => null)) as { sel: string; text: string } | null;
  if (!raw.length) warnings.push('No messages found in the thread (or the page did not render it)');
  return { conversation, messages: toMessages(raw), canSend: Boolean(editor), warnings };
}

export async function conversation(id: string, log: (m: string) => void): Promise<ConversationResponse> {
  requireLogin('read messages');
  const t0 = Date.now();
  return withWorkPage(log, async (page) => {
    const r = await openThread(page, id, log);
    log(`messages: "${r.conversation.title}" – ${r.messages.length} message(s), can send: ${r.canSend}`);
    return { ...r, elapsedMs: Date.now() - t0 };
  });
}

export async function sendMessage(id: string, text: string, log: (m: string) => void): Promise<SendMessageResponse> {
  requireLogin('send messages');
  const msg = text.trim();
  if (!msg) throw new SocialError('Nothing to send', 400);
  if (msg.length > 1000) throw new SocialError('Messages are limited to 1000 characters', 400);
  const t0 = Date.now();
  return withWorkPage(log, async (page) => {
    const opened = await openThread(page, id, log);
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
  });
}

/** What the messages page contains (for tuning the selectors on the deployed server). */
export async function inboxDebug(log: (m: string) => void): Promise<unknown> {
  requireLogin('read messages');
  return withWorkPage(log, async (page) => {
    await gotoMessages(page, log);
    await sleep(3000);
    const dbg = (await page.evaluate(PAGE_DEBUG)) as Record<string, unknown>;
    const conversations = await page.evaluate(READ_CONVERSATIONS).catch((e: Error) => e.message);
    const messages = await page.evaluate(READ_MESSAGES).catch((e: Error) => e.message);
    const editor = await page.evaluate(READ_EDITOR).catch((e: Error) => e.message);
    return { ...dbg, conversations, messages, editor };
  });
}
