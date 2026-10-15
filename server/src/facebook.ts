/**
 * Facebook Reels, read from Facebook's own pages over plain HTTPS (no browser involved).
 *
 * What a signed-out visitor gets, measured 2026-10-15 from the dev machine (residential address):
 *  - A Page's Reels tab, `facebook.com/<page>/reels/`, answers 200 with the Page's latest 10 reels
 *    in the page's own JSON (`<script type="application/json">` blobs): for each reel its id,
 *    `browser_native_hd_url` (720p progressive H.264 + AAC, moov first) and `browser_native_sd_url`,
 *    size, length, cover, caption (`message.text`), creation time, a rounded play count
 *    ("230K"), the comment count, the owner's name / link / picture and the audio title. Paging
 *    past the 10 needs a GraphQL doc id (not attempted); the Page list is long instead.
 *    The HTML is big (2 MB compressed, 16 MB decompressed) because it embeds the reels' DASH manifests.
 *  - A single reel, `facebook.com/reel/<id>`, answers 200 with the same data for that reel (1.4 MB).
 *  - The CDN (`*.fbcdn.net`) sends `Access-Control-Allow-Origin: *` and honours Range: the viewer
 *    fetches the MP4 itself (`directUrl`); the proxy is the fallback. URLs expire (`oe=` hex seconds,
 *    about a day).
 *  - The Reels feed itself (`/reel/`, `/reels/`) and search redirect a guest to the login page: the
 *    For You tab needs the saved sign-in of facebookSession.ts (its cookies go on the same requests),
 *    and search is an @page / link box.
 *  - A Page that does not exist still answers 200, with "This content isn't available right now";
 *    a wrong-case slug answers 302 to the canonical one.
 *
 * Whether Facebook serves these pages to a datacenter address (the GCP VM) is not known yet; a login
 * redirect for a guest request is retried with the saved cookies when there are any.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { FeedItem, MediaFormat, ProfileResponse, ResolveResponse, SearchResponse, UserSummary } from '../../shared/types';
import { FACEBOOK_CATEGORIES } from '../../shared/types';
import { config } from './config';
import { openUpstream, readBody } from './http';
import { parseCount, urlExpiry } from './instagram';
import { defaultExpiry, registerMedia } from './mediaStore';
import { clearProgress, setProgress } from './progress';

const ORIGIN = 'https://www.facebook.com';
const FB_HOSTS = ['facebook.com', '*.facebook.com', 'fb.com', '*.fb.com', 'fb.watch'];
const CATALOG_FILE = process.env.FACEBOOK_CATALOG_FILE || path.join(os.homedir(), '.streamanywhere', 'facebook-catalog.json');
/** A Page's listing is reused this long (its MP4 URLs last about a day; see urlExpiry). */
const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;
/** Pause between two Page listings and the most per hour (no block measured yet; kept modest). */
const PAGE_GAP_MS = 2000;
const PAGE_BUDGET_PER_HOUR = 60;
/** After Facebook sent a guest page to the login page: no guest Page loads for this long (doubling per repeat). */
const BLOCK_MS = 10 * 60 * 1000;
const BLOCK_MAX_MS = 60 * 60 * 1000;
/** Background re-listing of Explore Pages: the pause after one listing before the next... */
const REFRESH_GAP_MS = 6000;
/** ...and only while an Explore feed was asked for within this window. */
const REFRESH_IDLE_MS = 3 * 60 * 1000;
/** A reel whose MP4 URL expires within this long is not served any more (the listing is refreshed instead). */
const URL_MARGIN_MS = 30 * 60 * 1000;
const HTML_LIMIT = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;
const REEL_TTL_MS = 30 * 60 * 1000;

export class FacebookError extends Error {
  constructor(message: string, public readonly status = 502, public readonly code = 'facebook_error') {
    super(message);
  }
}

// ---------------------------------------------------------------- pure helpers (unit tested)

export function isFacebookUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase().replace(/^(www|m|web|mbasic|touch|business|l)\./, '');
    return h === 'facebook.com' || h === 'fb.com' || h === 'fb.watch';
  } catch {
    return false;
  }
}

const ID = /^\d{6,25}$/;
/** Reserved first path segments that are not Page slugs. */
const NOT_A_PAGE = new Set(['reel', 'reels', 'watch', 'videos', 'video', 'share', 'profile.php', 'login', 'login.php', 'groups', 'events', 'marketplace', 'gaming', 'hashtag', 'stories', 'story.php', 'photo', 'photo.php', 'search', 'settings', 'help', 'policies', 'pages', 'people', 'public', 'me', 'home.php', 'checkpoint', 'recover', 'friends', 'messages', 'notifications', 'bookmarks', 'saved', 'ads', 'business', 'dialog', 'plugins', 'sharer', 'sharer.php', 'l.php', 'permalink.php', 'story', 'posts']);

/**
 * The video id of a reel / video URL (`/reel/<id>`, `/watch/?v=<id>`, `/<page>/videos/<slug>/<id>/`,
 * `/<page>/videos/<id>/`, `/video.php?v=<id>`), or undefined (share links and fb.watch need a redirect first).
 */
export function facebookVideoId(raw: string): string | undefined {
  try {
    if (!isFacebookUrl(raw)) return undefined;
    const u = new URL(raw);
    const v = u.searchParams.get('v');
    if (v && ID.test(v)) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    const m = /^\/(?:reel|reels)\/(\d{6,25})(?:\/|$)/.exec(u.pathname);
    if (m) return m[1];
    const vi = parts.indexOf('videos');
    if (vi >= 0) {
      const after = parts.slice(vi + 1);
      const id = after.find((p) => ID.test(p));
      if (id) return id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const SLUG = /^[\w.\-]{1,64}$/;

/** What was typed in the search box, as a Page slug (`@9gag`, `9gag`, a Page link, `profile.php?id=…`), or undefined. */
export function pageFromQuery(q: string): string | undefined {
  const t = q.trim();
  try {
    if (/^https?:\/\//i.test(t) && isFacebookUrl(t)) {
      const u = new URL(t);
      if (u.pathname === '/profile.php') {
        const id = u.searchParams.get('id');
        return id && ID.test(id) ? id : undefined;
      }
      const first = u.pathname.split('/').filter(Boolean)[0];
      return first && !NOT_A_PAGE.has(first.toLowerCase()) && SLUG.test(first) ? first : undefined;
    }
  } catch {
    /* fall through */
  }
  const h = t.replace(/^@/, '');
  return SLUG.test(h) && !/\s/.test(h) && !NOT_A_PAGE.has(h.toLowerCase()) ? h : undefined;
}

/** The slug of a Page / profile URL Facebook gives for a video's owner (`https://www.facebook.com/9gag` -> `9gag`). */
export function slugFromProfileUrl(url: string | undefined, fallbackId?: string): string | undefined {
  if (url) {
    try {
      const u = new URL(url);
      if (u.pathname === '/profile.php') {
        const id = u.searchParams.get('id');
        if (id && ID.test(id)) return id;
      } else {
        const first = u.pathname.split('/').filter(Boolean)[0];
        if (first && SLUG.test(first) && !NOT_A_PAGE.has(first.toLowerCase())) return first;
      }
    } catch {
      /* fall through */
    }
  }
  return fallbackId && ID.test(fallbackId) ? fallbackId : undefined;
}

/** One reel as the page JSON describes it (what the catalog keeps). */
export interface FbReel {
  id: string;
  hdUrl?: string;
  sdUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
  cover?: string;
  caption?: string;
  createdAt?: number;
  plays?: number;
  likes?: number;
  comments?: number;
  music?: string;
  owner: { id?: string; name?: string; slug?: string; avatar?: string; verified?: boolean };
}

export interface PageHtml {
  /** The reels in page order (first appearance), deduplicated */
  reels: FbReel[];
  /** The page's <title> */
  title: string;
  /** og:description - "9GAG Reels. 39,783,806 followers · 598,231 talking about this. ..." */
  description: string;
  /** The Page's own picture, when the page is a Page */
  avatar?: string;
  /** Facebook's "This content isn't available right now" page */
  notAvailable: boolean;
  /** A login dialog / page instead of content */
  loginWall: boolean;
  /** The signed-in viewer the page was rendered for ("0" / '' for a guest) */
  viewer: { id: string; name: string; shortName?: string };
  /** The Page's Reels tab has more than the listed reels */
  hasMore?: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const uri = (v: unknown): string | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return str(o.uri) || uri(o.image);
};
const decodeEntities = (s: string): string => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function metaContent(html: string, prop: string): string {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)="${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]+content="([^"]*)"`, 'i');
  const re2 = new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
  const m = re1.exec(html) || re2.exec(html);
  return m ? decodeEntities(m[1]) : '';
}

/**
 * Reads the reels out of a facebook.com page (a Page's Reels tab, a single reel, the Reels feed):
 * every JSON script of the page is walked for the records Facebook's Relay store holds - the
 * Story (`short_form_video_context`: the reel's id, size, cover, owner, audio, play count, with the
 * caption and the creation time next to it), the delivery record (`videoDeliveryLegacyFields`:
 * the MP4 URLs) and the feedback record (the comment count) - and they are joined by id.
 */
export function extractReels(html: string): PageHtml {
  const reels = new Map<string, FbReel>();
  const order: string[] = [];
  const urls = new Map<string, { hd?: string; sd?: string; width?: number; height?: number; duration?: number; cover?: string }>();
  const comments = new Map<string, number>();
  const feedbackOf = new Map<string, string>();
  let hasMore: boolean | undefined;
  let viewer = { id: '', name: '', shortName: undefined as string | undefined };
  let loginWall = false;

  const walk = (o: unknown, depth: number): void => {
    if (depth > 80 || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    const r = o as Record<string, unknown>;
    const vdl = r.videoDeliveryLegacyFields as Record<string, unknown> | undefined;
    if (vdl && typeof vdl === 'object') {
      const id = str(vdl.id) || str(r.id);
      if (id && ID.test(id)) {
        const prev = urls.get(id) || {};
        urls.set(id, {
          hd: prev.hd || str(vdl.browser_native_hd_url),
          sd: prev.sd || str(vdl.browser_native_sd_url),
          width: prev.width ?? num(r.width),
          height: prev.height ?? num(r.height),
          duration: prev.duration ?? num(r.length_in_second),
          cover: prev.cover || uri(r.preferred_thumbnail) || uri(r.thumbnailImage) || str(r.first_frame_thumbnail),
        });
      }
    }
    const sfvc = r.short_form_video_context as Record<string, unknown> | undefined;
    if (sfvc && typeof sfvc === 'object') {
      const video = (sfvc.video || {}) as Record<string, unknown>;
      const pb = (sfvc.playback_video || {}) as Record<string, unknown>;
      const id = str(video.id) || str(pb.id);
      if (id && ID.test(id)) {
        const owner = (sfvc.video_owner || video.owner || {}) as Record<string, unknown>;
        const msg = r.message as Record<string, unknown> | undefined;
        const fb = r.feedback as Record<string, unknown> | undefined;
        const prev = reels.get(id);
        const reel: FbReel = prev || { id, owner: {} };
        if (!prev) {
          reels.set(id, reel);
          order.push(id);
        }
        reel.width = reel.width ?? num(pb.width) ?? num(video.width);
        reel.height = reel.height ?? num(pb.height) ?? num(video.height);
        reel.duration = reel.duration ?? num(pb.length_in_second) ?? (num(video.playable_duration_in_ms) !== undefined ? num(video.playable_duration_in_ms)! / 1000 : undefined);
        reel.cover = reel.cover || uri(pb.preferred_thumbnail) || uri(pb.thumbnailImage) || uri(pb.image) || str(video.first_frame_thumbnail);
        reel.caption = reel.caption || (msg && typeof msg === 'object' ? str(msg.text) : undefined);
        reel.createdAt = reel.createdAt ?? num(r.creation_time);
        reel.plays = reel.plays ?? parseCount(str(sfvc.play_count_reduced));
        reel.music = reel.music || str(sfvc.track_title);
        reel.owner.id = reel.owner.id || str(owner.id);
        reel.owner.name = reel.owner.name || str(owner.name);
        reel.owner.slug = reel.owner.slug || slugFromProfileUrl(str(owner.url), str(owner.id));
        reel.owner.avatar = reel.owner.avatar || uri(owner.displayPicture) || uri(owner.profile_picture);
        if (reel.owner.verified === undefined && typeof owner.is_verified === 'boolean') reel.owner.verified = owner.is_verified;
        const fid = fb && typeof fb === 'object' ? str(fb.id) : undefined;
        if (fid) feedbackOf.set(id, fid);
      }
    }
    if (typeof r.total_comment_count === 'number' && typeof r.id === 'string') comments.set(r.id, r.total_comment_count);
    const pi = r.page_info as Record<string, unknown> | undefined;
    if (pi && typeof pi === 'object' && typeof pi.has_next_page === 'boolean' && r.edges) hasMore = hasMore || pi.has_next_page;
    for (const k of Object.keys(r)) {
      if (k === 'dash_manifest_xml_string' || k === 'tracking' || k === 'encrypted_tracking') continue;
      walk(r[k], depth + 1);
    }
  };

  const scriptRe = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html))) {
    const s = m[1];
    const relevant = s.includes('videoDeliveryLegacyFields') || s.includes('short_form_video_context') || s.includes('total_comment_count') || s.includes('CurrentUserInitialData') || s.includes('has_next_page');
    if (!relevant) continue;
    let json: unknown;
    try {
      json = JSON.parse(s);
    } catch {
      continue;
    }
    if (s.includes('CurrentUserInitialData')) {
      const cu = findDefine(json, 'CurrentUserInitialData') as Record<string, unknown> | undefined;
      if (cu) viewer = { id: str(cu.USER_ID) || '', name: str(cu.NAME) || '', shortName: str(cu.SHORT_NAME) };
    }
    walk(json, 0);
  }
  for (const id of order) {
    const reel = reels.get(id)!;
    const u = urls.get(id);
    if (u) {
      reel.hdUrl = u.hd;
      reel.sdUrl = u.sd;
      reel.width = reel.width ?? u.width;
      reel.height = reel.height ?? u.height;
      reel.duration = reel.duration ?? u.duration;
      reel.cover = reel.cover || u.cover;
    }
    const fid = feedbackOf.get(id);
    if (fid && comments.has(fid)) reel.comments = comments.get(fid);
  }
  // A delivery record without a Story (a plain video page): still a playable reel.
  for (const [id, u] of urls) {
    if (reels.has(id) || !(u.hd || u.sd)) continue;
    reels.set(id, { id, hdUrl: u.hd, sdUrl: u.sd, width: u.width, height: u.height, duration: u.duration, cover: u.cover, owner: {} });
    order.push(id);
  }
  const title = decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '');
  const description = metaContent(html, 'og:description') || metaContent(html, 'description');
  // A reel's own page says "230K views · 548 reactions | <caption> | <owner>" in its og:title.
  const ogTitle = metaContent(html, 'og:title');
  const first = order.length ? reels.get(order[0])! : undefined;
  if (first && /\d\s*(views|reactions)/i.test(ogTitle)) {
    const views = /([\d.,]+\s*[KMB]?)\s+views/i.exec(ogTitle);
    const reactions = /([\d.,]+\s*[KMB]?)\s+reactions/i.exec(ogTitle);
    if (views && first.plays === undefined) first.plays = parseCount(views[1].replace(/\s+/g, ''));
    if (reactions && first.likes === undefined) first.likes = parseCount(reactions[1].replace(/\s+/g, ''));
  }
  const avatarM = /"profilePicLarge":\{"uri":"((?:[^"\\]|\\.)*)"/.exec(html) || /"profilePicMedium":\{"uri":"((?:[^"\\]|\\.)*)"/.exec(html);
  let avatar: string | undefined;
  if (avatarM) {
    try {
      avatar = JSON.parse(`"${avatarM[1]}"`);
    } catch {
      /* ignore */
    }
  }
  const notAvailable = /"title":"This content isn't available right now"/.test(html) || /This content isn't available right now/.test(title);
  if (/"login_form"|"LoginFormController"|id="login_form"/.test(html) && !order.length) loginWall = true;
  return { reels: order.map((id) => reels.get(id)!), title, description, avatar, notAvailable, loginWall, viewer, hasMore };
}

/** The payload of a `["<name>",[],{...},<n>]` define record anywhere in a Facebook JSON blob. */
export function findDefine(node: unknown, name: string, depth = 0): unknown {
  if (depth > 12 || !node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    if (node.length >= 3 && node[0] === name && node[2] && typeof node[2] === 'object' && !Array.isArray(node[2])) return node[2];
    for (const x of node) {
      const r = findDefine(x, name, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  for (const k of Object.keys(node as Record<string, unknown>)) {
    const r = findDefine((node as Record<string, unknown>)[k], name, depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** The Page's details out of its Reels tab: name from the title ("9GAG Reels"), followers from the description. */
export function pageSummary(slug: string, page: PageHtml): UserSummary {
  const name = page.title === 'Facebook' ? '' : page.title.replace(/\s*(Reels|Videos|\| Facebook)\s*$/i, '').trim();
  const fm = /([\d.,]+\s*[KMB]?)\s+followers/i.exec(page.description);
  const likesM = /([\d.,]+\s*[KMB]?)\s+likes/i.exec(page.description);
  const owner = page.reels[0]?.owner;
  return {
    id: owner?.id,
    uniqueId: owner?.slug || slug,
    nickname: name || owner?.name || undefined,
    avatar: page.avatar || owner?.avatar,
    verified: owner?.verified,
    followers: fm ? parseCount(fm[1].replace(/\s+/g, '')) : undefined,
    likes: likesM ? parseCount(likesM[1].replace(/\s+/g, '')) : undefined,
  };
}

/** ms epoch when the reel's MP4 URL stops working (from `oe=`), or undefined. */
export function reelExpiry(r: FbReel): number | undefined {
  const exp = urlExpiry(r.hdUrl || r.sdUrl || '');
  return exp ? exp * 1000 : undefined;
}

export const facebookCategory = (id: unknown) => FACEBOOK_CATEGORIES.find((c) => c.id === Number(id)) || FACEBOOK_CATEGORIES[0];

// ---------------------------------------------------------------- hooks from the sign-in module

export interface SessionHooks {
  /** The `Cookie:` header of the saved sign-in (undefined when signed out). */
  cookieHeader: () => string | undefined;
  /** The User-Agent of the browser the cookies came from. */
  userAgent?: () => string | undefined;
  /** A signed-in-only page came back for the saved cookies (with the account's name when the page showed it). */
  confirmed?: (name?: string, id?: string) => void;
  /** Facebook sent a signed-in request to its login page: the cookies are dead (or the address is limited). */
  rejected?: () => void;
}
let hooks: SessionHooks | undefined;
export function setSessionHooks(h: SessionHooks): void {
  hooks = h;
}
const signedIn = (): boolean => Boolean(hooks?.cookieHeader());

const recent: string[] = [];
let logger: ((m: string) => void) | undefined;
const note = (m: string): void => {
  recent.push(`${new Date().toISOString()} ${m}`);
  if (recent.length > 200) recent.splice(0, recent.length - 200);
  logger?.(m);
};
export const setFacebookLogger = (l: (m: string) => void): void => {
  logger = l;
};
export const facebookLog = (): { lines: string[] } => ({ lines: recent.slice() });
const progress = (text: string): void => setProgress('facebook', text);

// ---------------------------------------------------------------- fetching

export interface FetchedPage {
  status: number;
  /** Where a 3xx points (absolute) */
  location?: string;
  html: string;
  finalUrl: string;
}

/**
 * GET a facebook.com page as a desktop browser would ask for it (gzip accepted, redirects not
 * followed unless asked: a login redirect is an answer). `cookie` adds the saved sign-in.
 */
export async function fetchFacebookHtml(url: string, opts: { cookie?: string; userAgent?: string; follow?: number; timeoutMs?: number } = {}): Promise<FetchedPage> {
  const headers: Record<string, string> = {
    'user-agent': opts.userAgent || config.userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  const { res, status, finalUrl } = await openUpstream(url, { headers, allowlist: FB_HOSTS, maxRedirects: opts.follow || 0, timeoutMs: opts.timeoutMs || FETCH_TIMEOUT_MS });
  const location = res.headers.location ? new URL(res.headers.location, finalUrl).toString() : undefined;
  if (status >= 300 && status < 400) {
    res.resume();
    return { status, location, html: '', finalUrl };
  }
  let body = await readBody(res, HTML_LIMIT);
  if (/gzip/i.test(String(res.headers['content-encoding'] || ''))) body = zlib.gunzipSync(body);
  return { status, location, html: body.toString('utf8'), finalUrl };
}

const isLoginUrl = (u: string | undefined): boolean => /facebook\.com\/(login|login\.php|recover|checkpoint)/i.test(u || '');
const isCheckpointUrl = (u: string | undefined): boolean => /facebook\.com\/checkpoint/i.test(u || '');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Guest Page loads are refused for the address right now (a login redirect for a guest). */
let blockedUntil = 0;
let blockStreak = 0;
export const blockedForSec = (): number => Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
function markBlocked(why: string): void {
  const pause = Math.min(BLOCK_MAX_MS, BLOCK_MS * 2 ** blockStreak);
  blockStreak++;
  blockedUntil = Date.now() + pause;
  note(`${why}; no guest Page loads for ${Math.round(pause / 60000)} min`);
}

let lastPageAt = 0;
const pageLoads: number[] = [];
let chain: Promise<unknown> = Promise.resolve();
/** Page listings go one at a time, PAGE_GAP_MS apart (the rate limit is per address). */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastPageAt + PAGE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastPageAt = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Loads a facebook.com page and reads its reels. A guest request first (nothing to lose), the saved
 * sign-in when Facebook sends the guest to its login page; a signed-in request that lands on the
 * login page is reported to the sign-in module.
 */
async function loadReels(url: string, what: string, opts: { signedIn?: boolean; hops?: number } = {}): Promise<PageHtml> {
  const useCookies = opts.signedIn || false;
  const cookie = useCookies ? hooks?.cookieHeader() : undefined;
  const ua = useCookies ? hooks?.userAgent?.() : undefined;
  const t0 = Date.now();
  let page: FetchedPage;
  try {
    page = await fetchFacebookHtml(url, { cookie, userAgent: ua });
  } catch (e) {
    throw new FacebookError(`${what} could not be loaded (${(e as Error).message})`, 502, 'facebook_error');
  }
  // A wrong-case slug, a video id, a share link: Facebook answers 302 to the canonical page. Followed
  // a few hops; the login and checkpoint pages are answers, not hops.
  if (page.status >= 300 && page.status < 400 && page.location && !isLoginUrl(page.location) && !isCheckpointUrl(page.location) && isFacebookUrl(page.location) && (opts.hops || 0) < 3) {
    note(`${what}: ${page.status} to ${new URL(page.location).pathname}`);
    return loadReels(page.location, what, { ...opts, hops: (opts.hops || 0) + 1 });
  }
  if (page.status >= 300 && page.status < 400) {
    if (isCheckpointUrl(page.location)) {
      if (useCookies) hooks?.rejected?.();
      throw new FacebookError(`Facebook wants a verification for ${useCookies ? 'this account' : "this server's address"} (${what} was sent to its checkpoint page)${useCookies ? ': open facebook.com in your own browser, confirm it was you, then sign in here again with a fresh export' : ''}.`, 403, 'facebook_checkpoint');
    }
    if (isLoginUrl(page.location)) {
      if (useCookies) {
        hooks?.rejected?.();
        throw new FacebookError(`Facebook signed this server out (${what} was sent to the login page); sign in again from Profile.`, 401, 'facebook_not_signed_in');
      }
      if (hooks?.cookieHeader()) {
        note(`${what}: a guest request was sent to the login page; retrying with the saved sign-in`);
        return loadReels(url, what, { ...opts, signedIn: true });
      }
      markBlocked(`${what}: Facebook sent a guest request to its login page`);
      throw new FacebookError(`Facebook will not show ${what} to a signed-out visitor from this server's address; sign in from Profile (the cookies of a signed-in browser) to read it with your account.`, 401, 'facebook_login_required');
    }
    throw new FacebookError(`Facebook redirected ${what} to ${page.location || '?'}`, 502, 'facebook_redirect');
  }
  if (page.status === 429) {
    markBlocked(`${what}: 429`);
    throw new FacebookError(`Facebook is limiting this server's address right now (${what} answered 429); next try in ${Math.round(blockedForSec() / 60)} min.`, 429, 'facebook_rate_limited');
  }
  if (page.status >= 400) throw new FacebookError(`Facebook answered ${page.status} for ${what}`, page.status === 404 ? 404 : 502, page.status === 404 ? 'facebook_not_found' : 'facebook_error');
  const t1 = Date.now();
  const parsed = extractReels(page.html);
  note(`${what}: ${Math.round(page.html.length / 1024)} KB in ${t1 - t0} ms, ${parsed.reels.length} reels parsed in ${Date.now() - t1} ms${useCookies ? ` (signed in${parsed.viewer.id && parsed.viewer.id !== '0' ? ' as ' + (parsed.viewer.name || parsed.viewer.id) : ''})` : ''}`);
  if (useCookies) {
    if (parsed.viewer.id && parsed.viewer.id !== '0') hooks?.confirmed?.(parsed.viewer.name || undefined, parsed.viewer.id);
    else if (parsed.loginWall) {
      hooks?.rejected?.();
      throw new FacebookError(`Facebook showed its login page instead of ${what}: the saved sign-in no longer works; sign in again from Profile.`, 401, 'facebook_not_signed_in');
    }
  } else if (parsed.loginWall) {
    if (hooks?.cookieHeader()) return loadReels(url, what, { ...opts, signedIn: true });
    markBlocked(`${what}: Facebook showed a login page to a guest`);
    throw new FacebookError(`Facebook will not show ${what} to a signed-out visitor from this server's address; sign in from Profile to read it with your account.`, 401, 'facebook_login_required');
  }
  blockStreak = 0;
  return parsed;
}

// ---------------------------------------------------------------- items

function mediaFormats(r: FbReel): MediaFormat[] {
  const out: MediaFormat[] = [];
  const exp = reelExpiry(r);
  const expiryMs = exp ? Math.min(defaultExpiry(), exp - 60_000) : defaultExpiry();
  for (const [id, url, label] of [
    ['hd', r.hdUrl, 'HD (720p) H.264 + AAC, progressive MP4'],
    ['sd', r.sdUrl, 'SD (360p) H.264 + AAC, progressive MP4'],
  ] as const) {
    if (!url) continue;
    const rec = registerMedia({ url, headers: { 'user-agent': config.userAgent }, label: `facebook ${r.id} ${id}`, source: 'facebook', expiresAt: expiryMs });
    let host: string | undefined;
    try {
      host = new URL(url).hostname;
    } catch {
      /* ignore */
    }
    out.push({
      id,
      label,
      codec: 'h264',
      width: id === 'hd' ? r.width : undefined,
      height: id === 'hd' ? r.height : undefined,
      // The Facebook CDN sends Access-Control-Allow-Origin: * and honours Range: the viewer may fetch it itself.
      directUrl: url,
      directKind: 'origin',
      proxyUrl: `/api/media/${rec.id}`,
      mediaId: rec.id,
      requiresCookies: false,
      expiresAt: exp ? Math.floor(exp / 1000) : undefined,
      upstreamHost: host,
    });
  }
  return out;
}

export function reelToFeedItem(r: FbReel): FeedItem {
  return {
    id: r.id,
    canonicalUrl: `${ORIGIN}/reel/${r.id}`,
    author: { id: r.owner.id, uniqueId: r.owner.slug || r.owner.id, nickname: r.owner.name, avatar: r.owner.avatar },
    desc: r.caption || undefined,
    createTime: r.createdAt,
    duration: r.duration,
    width: r.width,
    height: r.height,
    cover: r.cover,
    music: r.music,
    stats: { plays: r.plays, likes: r.likes, comments: r.comments },
    formats: mediaFormats(r),
  };
}

/** A reel the viewer can still play: it has a URL that does not run out within the margin. */
export function playable(r: FbReel, now = Date.now()): boolean {
  if (!r.hdUrl && !r.sdUrl) return false;
  const exp = reelExpiry(r);
  return !exp || exp - now > URL_MARGIN_MS;
}

// ---------------------------------------------------------------- the catalog (Page listings)

interface CatalogEntry {
  at: number;
  reels: FbReel[];
  user?: UserSummary;
  hasMore?: boolean;
}
let catalog: Map<string, CatalogEntry> | undefined;

function loadCatalog(): Map<string, CatalogEntry> {
  if (catalog) return catalog;
  catalog = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) as { pages?: Record<string, CatalogEntry> };
    for (const [k, v] of Object.entries(raw.pages || {})) if (v && Array.isArray(v.reels)) catalog.set(k, v);
  } catch {
    /* none yet */
  }
  return catalog;
}
function saveCatalog(): void {
  try {
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify({ pages: Object.fromEntries(loadCatalog()) }));
  } catch {
    /* the catalog is a cache */
  }
}

/** Loads `facebook.com/<slug>/reels/` and keeps what it lists. */
async function listPage(slug: string, log: (m: string) => void): Promise<CatalogEntry> {
  if (Date.now() < blockedUntil && !signedIn()) throw new FacebookError(`Facebook is refusing guest Page loads from this server's address for another ${Math.max(1, Math.ceil(blockedForSec() / 60))} min.`, 429, 'facebook_rate_limited');
  const hourAgo = Date.now() - 3600_000;
  while (pageLoads.length && pageLoads[0] < hourAgo) pageLoads.shift();
  if (pageLoads.length >= PAGE_BUDGET_PER_HOUR) throw new FacebookError('Too many Facebook Page loads this hour; try again in a few minutes.', 429, 'facebook_budget');
  return paced(async () => {
    pageLoads.push(Date.now());
    const page = await loadReels(`${ORIGIN}/${encodeURIComponent(slug)}/reels/`, `the Reels tab of ${slug}`);
    if (page.notAvailable && !page.reels.length) throw new FacebookError(`Facebook has no Page "${slug}" (or it is not available right now)`, 404, 'facebook_not_found');
    if (!page.reels.length) throw new FacebookError(`Facebook showed no reels on ${slug}'s Reels tab (page: "${page.title.slice(0, 60)}")`, 404, 'facebook_no_reels');
    const entry: CatalogEntry = { at: Date.now(), reels: page.reels, user: pageSummary(slug, page), hasMore: page.hasMore };
    loadCatalog().set(slug.toLowerCase(), entry);
    saveCatalog();
    log(`facebook ${slug}: ${page.reels.length} reels listed${page.hasMore ? ' (more on the Page)' : ''}`);
    return entry;
  });
}

/** A Page's reels: from the catalog while fresh and playable, else from its Reels tab (a stale listing beats an error). */
async function pageReels(slug: string, log: (m: string) => void): Promise<CatalogEntry> {
  const key = slug.toLowerCase();
  const hit = loadCatalog().get(key);
  const now = Date.now();
  if (hit && now - hit.at < CATALOG_TTL_MS && hit.reels.some((r) => playable(r, now))) return hit;
  try {
    return await listPage(slug, log);
  } catch (e) {
    if (hit && hit.reels.some((r) => playable(r, now)) && e instanceof FacebookError && (e.status === 429 || e.status === 502 || e.status === 504 || e.status === 401)) {
      log(`facebook ${slug}: ${e.message} - using the saved listing from ${new Date(hit.at).toLocaleString()}`);
      return hit;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- explore (Pages rotation) and For You (signed in)

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const orders = new Map<number, string[]>();
const cursors = new Map<number, number>();
/** The Pages of a category in a random but stable order ("All" alternates between the categories). */
function pageOrder(catId: number): string[] {
  let o = orders.get(catId);
  if (!o) {
    const cats = FACEBOOK_CATEGORIES.filter((c) => c.id !== 0);
    if (catId === 0) {
      const lists = shuffle(cats.map((c) => shuffle([...c.pages])));
      const mixed: string[] = [];
      for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && !mixed.includes(l[i])) mixed.push(l[i]);
      o = mixed;
    } else {
      o = shuffle([...facebookCategory(catId).pages]);
    }
    orders.set(catId, o);
  }
  return o;
}

export interface ExplorePlan {
  /** Pages whose saved listing this fill uses, in rotation order, with the reels still playable */
  use: { slug: string; reels: FbReel[] }[];
  /** Pages to list (again): no listing, an outdated one, or one whose URLs are running out */
  refresh: string[];
  cursor: number;
}

/**
 * Which Pages one Explore fill takes its reels from: the next ones of the rotation that have a usable
 * listing (fresh enough that its MP4 URLs still work), until `want` reels are together; the rest are
 * named for a (re)listing.
 */
export function planExploreFill(order: string[], cursor: number, listing: (key: string) => CatalogEntry | undefined, want: number, now: number): ExplorePlan {
  const use: ExplorePlan['use'] = [];
  const refresh: string[] = [];
  let collected = 0;
  let i = 0;
  for (; i < order.length && collected < want; i++) {
    const slug = order[(cursor + i) % order.length];
    const e = listing(slug.toLowerCase());
    const reels = e ? e.reels.filter((r) => playable(r, now)) : [];
    if (!e || now - e.at >= CATALOG_TTL_MS || reels.length < e.reels.length) refresh.push(slug);
    if (reels.length) {
      use.push({ slug, reels });
      collected += reels.length;
    }
  }
  return { use, refresh, cursor: cursor + i };
}

const refreshQueue: string[] = [];
let refreshing = false;
let refreshTimer: NodeJS.Timeout | undefined;
let lastRefreshEnd = 0;
let lastExploreAt = 0;

function queueRefresh(slugs: string[], log: (m: string) => void): void {
  lastExploreAt = Date.now();
  for (const s of slugs) if (!refreshQueue.includes(s)) refreshQueue.push(s);
  scheduleRefresh(log);
}

function scheduleRefresh(log: (m: string) => void): void {
  if (refreshing || refreshTimer || !refreshQueue.length) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    if (Date.now() - lastExploreAt > REFRESH_IDLE_MS) {
      refreshQueue.length = 0;
      return;
    }
    const slug = refreshQueue.shift() as string;
    const e = loadCatalog().get(slug.toLowerCase());
    if (e && Date.now() - e.at < CATALOG_TTL_MS && e.reels.every((r) => playable(r))) {
      scheduleRefresh(log);
      return;
    }
    refreshing = true;
    void listPage(slug, log)
      .catch((err: Error) => {
        log(`facebook ${slug}: background listing failed (${err.message})`);
        if (err instanceof FacebookError && (err.status === 429 || err.status === 401)) refreshQueue.length = 0;
      })
      .finally(() => {
        refreshing = false;
        lastRefreshEnd = Date.now();
        scheduleRefresh(log);
      });
  }, Math.max(0, lastRefreshEnd + REFRESH_GAP_MS - Date.now()));
  refreshTimer.unref?.();
}

/**
 * One reservoir fill of a category: the next Pages of its rotation, their reels interleaved (so the
 * stream never shows ten from one Page in a row). Saved listings are used at once; only when none is
 * usable does the fill wait for a Page.
 */
export async function exploreFacebook(catId: number, want: number, log: (m: string) => void): Promise<{ items: FeedItem[]; warnings: string[] }> {
  const order = pageOrder(catId);
  const warnings: string[] = [];
  const plan = planExploreFill(order, cursors.get(catId) || 0, (k) => loadCatalog().get(k), want, Date.now());
  cursors.set(catId, plan.cursor);
  const lists = plan.use.map((u) => u.reels);
  let failure: FacebookError | undefined;
  // Few listings yet (a new server): this fill lists a Page or two itself (a few seconds each), so the
  // stock does not keep re-serving the same handful while the background listing catches up.
  if (lists.length < 3 && plan.refresh.length) {
    if (!lists.length) progress('Reading the first Pages from facebook.com…');
    try {
      for (const slug of plan.refresh.slice(0, 3)) {
        try {
          const e = await listPage(slug, log);
          lists.push(e.reels.filter((r) => playable(r)));
          plan.refresh.splice(plan.refresh.indexOf(slug), 1);
          if (lists.length >= 3) break;
        } catch (e) {
          if (!(e instanceof FacebookError)) throw e;
          failure = e;
          if (e.status === 429 || e.status === 401) break;
          warnings.push(`${slug}: ${e.message}`);
        }
      }
    } finally {
      clearProgress('facebook');
    }
  }
  queueRefresh(plan.refresh, log);
  const reels: FbReel[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && !reels.some((r) => r.id === l[i].id)) reels.push(l[i]);
  if (!reels.length) throw failure && (failure.status === 429 || failure.status === 401) ? failure : new FacebookError('Facebook showed no reels for the Pages tried' + (warnings.length ? ` (${warnings.join('; ')})` : ''), 502, 'facebook_empty');
  const items = reels.slice(0, Math.max(want, 24)).map(reelToFeedItem);
  log(`facebook explore: ${items.length} reels from ${lists.length} Pages, ${refreshQueue.length} queued for re-listing`);
  return { items, warnings };
}

/**
 * The signed-in account's Reels feed: `facebook.com/reel/` loaded with the saved cookies carries the
 * feed's first reels in its JSON; every load is a fresh sample, so a fill is one load (the stock's
 * recent-id window drops repeats). Built from Facebook's page structure; not yet tried with an account.
 */
export async function forYouFacebook(want: number, log: (m: string) => void): Promise<{ items: FeedItem[]; warnings: string[] }> {
  if (!signedIn()) throw new FacebookError('Not signed in to Facebook: sign in from Profile to see your For You feed.', 401, 'facebook_not_signed_in');
  progress('Opening your Reels feed on facebook.com…');
  try {
    const page = await loadReels(`${ORIGIN}/reel/`, 'your Reels feed', { signedIn: true });
    const reels = page.reels.filter((r) => playable(r));
    log(`facebook foryou: ${reels.length} playable reels in the feed page (${page.reels.length} listed)`);
    if (!reels.length) return { items: [], warnings: ['Facebook returned no reels this time'] };
    return { items: reels.slice(0, Math.max(want, reels.length)).map(reelToFeedItem), warnings: [] };
  } finally {
    clearProgress('facebook');
  }
}

// ---------------------------------------------------------------- single reels, profiles, search

interface ReelCache {
  at: number;
  reel?: FbReel;
  why?: 'gone' | 'unavailable' | 'login';
}
const reelCache = new Map<string, ReelCache>();

/** One reel by id (`/reel/<id>`; a plain video id redirects to its video page, which carries the same records). */
async function fetchReel(id: string, log: (m: string) => void): Promise<FbReel | undefined> {
  const hit = reelCache.get(id);
  if (hit && Date.now() - hit.at < (hit.reel ? REEL_TTL_MS : 60_000) && (!hit.reel || playable(hit.reel))) return hit.reel;
  const t0 = Date.now();
  const page = await loadReels(`${ORIGIN}/reel/${id}`, `reel ${id}`);
  const reel = page.reels.find((r) => r.id === id) || page.reels[0];
  reelCache.set(id, { at: Date.now(), reel: reel && (reel.hdUrl || reel.sdUrl) ? reel : undefined, why: page.notAvailable ? 'gone' : undefined });
  log(`facebook reel ${id}: ${reel ? 'found' : 'not found'} in ${Date.now() - t0} ms${page.notAvailable ? ' (content not available)' : ''}`);
  if (reelCache.size > 1000) for (const [k, v] of reelCache) if (Date.now() - v.at > REEL_TTL_MS) reelCache.delete(k);
  return reel && (reel.hdUrl || reel.sdUrl) ? reel : undefined;
}

/** fb.watch / share links: the reel id after Facebook's redirects. */
async function videoIdOf(url: string): Promise<string | undefined> {
  const direct = facebookVideoId(url);
  if (direct) return direct;
  const page = await fetchFacebookHtml(url, { follow: 4, timeoutMs: 30_000 });
  return facebookVideoId(page.finalUrl) || facebookVideoId(page.location || '') || extractReels(page.html).reels[0]?.id;
}

/** POST /api/resolve for a Facebook reel / video URL */
export async function resolveFacebook(inputUrl: string, log: (m: string) => void): Promise<ResolveResponse> {
  const t0 = Date.now();
  const id = await videoIdOf(inputUrl);
  if (!id) throw new FacebookError('That is not a Facebook reel or video URL', 400, 'bad_url');
  const reel = await fetchReel(id, log);
  if (!reel) throw new FacebookError('Facebook would not show that video (removed, private, or not a video)', 404, 'facebook_unavailable');
  const fmts = mediaFormats(reel);
  return {
    source: 'facebook',
    resolver: 'native',
    id,
    inputUrl,
    canonicalUrl: `${ORIGIN}/reel/${id}`,
    title: reel.caption?.slice(0, 200),
    author: reel.owner.name || reel.owner.slug,
    duration: reel.duration,
    width: reel.width,
    height: reel.height,
    cover: reel.cover,
    formats: fmts,
    warnings: [],
    elapsedMs: Date.now() - t0,
    attempts: [{ resolver: 'native', ok: true, elapsedMs: Date.now() - t0 }],
  };
}

export async function profileFacebook(slug: string, offset: number, count: number, log: (m: string) => void): Promise<ProfileResponse> {
  const t0 = Date.now();
  const e = await pageReels(slug, log);
  const reels = e.reels.filter((r) => playable(r));
  const items = reels.slice(offset, offset + count).map(reelToFeedItem);
  const user: UserSummary = { ...(e.user || { uniqueId: slug }), uniqueId: e.user?.uniqueId || slug };
  const warnings: string[] = [];
  if (!reels.length) warnings.push(`${slug} has no reels to show`);
  else if (offset + count >= reels.length && e.hasMore) warnings.push('Facebook lists only the latest 10 reels of a Page to this server');
  return { user, items, offset, hasMore: offset + count < reels.length, warnings, elapsedMs: Date.now() - t0 };
}

/** Search: Facebook's search needs a sign-in and a GraphQL doc id; here a Page name (@slug / link) opens the Page and a reel link plays. */
export async function searchFacebook(q: string, offset: number, log: (m: string) => void): Promise<SearchResponse> {
  const t0 = Date.now();
  const warnings: string[] = [];
  if (offset > 0) return { q, items: [], users: [], hasMore: false, offset, warnings, elapsedMs: Date.now() - t0 };
  if (/^https?:\/\//i.test(q.trim()) && isFacebookUrl(q.trim())) {
    const id = await videoIdOf(q.trim()).catch(() => undefined);
    if (id) {
      const reel = await fetchReel(id, log);
      if (!reel) warnings.push('Facebook would not show that video');
      return { q, items: reel ? [reelToFeedItem(reel)] : [], users: [], hasMore: false, offset: 0, warnings, elapsedMs: Date.now() - t0 };
    }
  }
  const slug = pageFromQuery(q);
  if (!slug) {
    warnings.push('Facebook search needs a sign-in it does not offer to servers. Type a Page name (@page or its link) or paste a reel link.');
    return { q, items: [], users: [], hasMore: false, offset: 0, warnings, elapsedMs: Date.now() - t0 };
  }
  try {
    const prof = await profileFacebook(slug, 0, 12, log);
    return { q, items: prof.items, users: [prof.user], hasMore: false, offset: 0, warnings: prof.warnings, elapsedMs: Date.now() - t0 };
  } catch (e) {
    warnings.push((e as Error).message);
    return { q, items: [], users: [], hasMore: false, offset: 0, warnings, elapsedMs: Date.now() - t0 };
  }
}

export function facebookStats(): Record<string, unknown> {
  return { blockedForSec: blockedForSec(), pageLoadsLastHour: pageLoads.filter((t) => t > Date.now() - 3600_000).length, catalogPages: loadCatalog().size, reelCache: reelCache.size, refreshQueue: refreshQueue.length };
}
