/**
 * Instagram through a headless Chrome/Edge page on instagram.com (puppeteer-core: the same machinery
 * as TikTok's work page in session.ts, but its own browser and profile).
 *
 * What a signed-out visitor can do (measured 2026-10-13 from the dev machine):
 *  - Every REST/GraphQL API (`/api/v1/...`, web_profile_info, tags, search, clips) answers 401
 *    "require_login", also when called from inside a real instagram.com page; yt-dlp's Instagram
 *    extractors are marked broken and refuse guests too. The Explore and Reels pages redirect to the
 *    login page, there is no hashtag page and no search.
 *  - A public profile page (`/<handle>/reels/`) renders 12 Reels (no paging) as anchors, so a guest
 *    "Explore" is a rotation over big public accounts (INSTAGRAM_CATEGORIES in shared/types.ts).
 *  - Every post has a guest-readable embed page, `/p/<code>/embed/captioned/`. Fetched from inside
 *    an instagram.com page (a plain HTTPS client gets a generic shell instead) it carries the post's
 *    JSON: a progressive, muxed H.264 + AAC MP4 (`video_url`, 720x1280, moov first, Range and
 *    `Access-Control-Allow-Origin: *`), counts, caption, owner, cover. ~0.9 s each, 8 in parallel.
 *  - Profile pages are rate limited PER IP: after ~100 profile loads in 4 minutes every profile
 *    redirects to /accounts/login (a fresh browser profile does not help) while the embed pages keep
 *    working. Hence the account catalog below (one listing per account every few hours, kept on
 *    disk), a pause between loads and an hourly budget.
 *
 * Instagram is therefore sign-in only here: every public function below refuses (401) without the
 * saved sign-in of instagramSession.ts. The guest findings above explain why, and the paths that
 * were measured as a guest (profile anchors, embed pages) are the ones the signed-in code reuses.
 *
 * Signed in (cookies of a signed-in browser, see instagramSession.ts) the profile pages page on
 * scroll, `topsearch` finds accounts, and the Reels page (`/reels/`) is the account's own feed: its
 * GraphQL answers are captured while scrolling and only the post CODES are taken from them; the
 * playable file always comes from the embed page. The signed-in half is built from Instagram's
 * documented web behaviour but could not be tried without an account.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FeedItem, MediaFormat, ProfileResponse, ResolveResponse, SearchResponse, UserSummary } from '../../shared/types';
import { INSTAGRAM_CATEGORIES } from '../../shared/types';
import { config } from './config';
import { defaultExpiry, registerMedia } from './mediaStore';
import { sessionSupported } from './session';
import type { ParsedCookie } from './youtubeSession';

type Browser = import('puppeteer-core').Browser;
type Page = import('puppeteer-core').Page;

const ORIGIN = 'https://www.instagram.com';
const APP_ID = '936619743392459';
const PROFILE_DIR = process.env.INSTAGRAM_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'instagram-profile');
const CATALOG_FILE = process.env.INSTAGRAM_CATALOG_FILE || path.join(os.homedir(), '.streamanywhere', 'instagram-catalog.json');
/** An account's Reels listing is reused this long (profiles are the rate-limited call). */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** Pause between two profile page loads, and the most loads per hour: the block came after ~100 in 4 minutes. */
const PROFILE_GAP_MS = 3000;
const PROFILE_BUDGET_PER_HOUR = 40;
/** After Instagram redirected a profile to the login page: no profile loads for this long (doubling per repeat, up to the cap). */
const BLOCK_MS = 10 * 60 * 1000;
const BLOCK_MAX_MS = 60 * 60 * 1000;
const EMBED_TTL_MS = 30 * 60 * 1000;
const EMBED_BATCH = 24;
/** The browser is closed after this long without work (a 1 GB VM needs the memory back). */
const IDLE_CLOSE_MS = 5 * 60 * 1000;

export class InstagramError extends Error {
  constructor(message: string, public readonly status = 502, public readonly code = 'instagram_error') {
    super(message);
  }
}

// ---------------------------------------------------------------- pure helpers (unit tested)

export function isInstagramUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase().replace(/^www\.|^m\./, '');
    return h === 'instagram.com' || h === 'instagr.am';
  } catch {
    return false;
  }
}

const CODE = /^[\w-]{5,20}$/;

/** The shortcode of a post / reel / igtv URL (`/reel/X/`, `/p/X/`, `/<user>/reel/X/`, `/reels/X/`), or undefined. */
export function instagramCode(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (!isInstagramUrl(raw)) return undefined;
    const m = /\/(?:p|reel|reels|tv)\/([\w-]{5,20})(?:\/|$)/.exec(u.pathname);
    return m && CODE.test(m[1]) ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** "268M" / "1.2K" / "32,070" -> number */
export function parseCount(s: string | undefined): number | undefined {
  const m = /^\s*([\d.,]+)\s*([KkMmBb]?)\s*$/.exec(s || '');
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'b'] || 1;
  return Math.round(n * mult);
}

/** The account details a profile page gives in its <meta> tags: "268M Followers, 194 Following, 32,070 Posts - See ... (@natgeo)". */
export function parseProfileMeta(handle: string, desc: string, ogTitle: string, image: string): UserSummary {
  const c = (re: RegExp): number | undefined => parseCount(re.exec(desc)?.[1]);
  const name = /^(.*?)\s*\(@/.exec(ogTitle || '')?.[1]?.trim();
  return {
    uniqueId: handle,
    nickname: name || undefined,
    avatar: image || undefined,
    followers: c(/([\d.,]+[KMB]?)\s+Followers/i),
    following: c(/([\d.,]+[KMB]?)\s+Following/i),
    videos: c(/([\d.,]+[KMB]?)\s+Posts/i),
  };
}

/** Post codes in any JSON tree from Instagram's GraphQL/REST answers: objects that look like a video post. */
export function collectCodes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 14 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) collectCodes(x, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.code === 'string' && CODE.test(o.code) && (o.video_versions || o.product_type === 'clips' || o.media_type === 2 || o.clips_metadata)) out.add(o.code);
  for (const k of Object.keys(o)) collectCodes(o[k], out, depth + 1);
}

/** `oe=` (hex unix seconds) of an Instagram CDN URL */
export function urlExpiry(url: string): number | undefined {
  const m = /[?&]oe=([0-9a-fA-F]{8})(?:&|$)/.exec(url);
  const n = m ? parseInt(m[1], 16) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export const instagramCategory = (id: unknown) => INSTAGRAM_CATEGORIES.find((c) => c.id === Number(id)) || INSTAGRAM_CATEGORIES[0];

const HANDLE = /^[\w.]{1,30}$/;

/** What was typed in the search box, as an account handle (`@natgeo`, `natgeo`, a profile URL), or undefined. */
export function handleFromQuery(q: string): string | undefined {
  const t = q.trim();
  try {
    if (/^https?:\/\//i.test(t) && isInstagramUrl(t)) {
      const first = new URL(t).pathname.split('/').filter(Boolean)[0];
      return first && !['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts'].includes(first) && HANDLE.test(first) ? first : undefined;
    }
  } catch {
    /* fall through */
  }
  const h = t.replace(/^@/, '');
  return HANDLE.test(h) ? h : undefined;
}

// ---------------------------------------------------------------- hooks from the sign-in module

let cookieSource: (() => ParsedCookie[] | undefined) | undefined;
let signedInFn: (() => boolean) | undefined;
/** instagramSession.ts tells this module where the saved cookies are and whether the account is signed in. */
export function setSessionHooks(h: { cookies: () => ParsedCookie[] | undefined; signedIn: () => boolean }): void {
  cookieSource = h.cookies;
  signedInFn = h.signedIn;
}
const signedIn = (): boolean => Boolean(signedInFn?.());

/** Instagram does not serve guests at all (its pages and APIs ask for a login): everything here needs the saved sign-in. */
function requireSignedIn(): void {
  if (!signedIn()) throw new InstagramError('Instagram needs a sign-in: open Profile and sign in with the cookies of a signed-in browser.', 401, 'instagram_not_signed_in');
}

// ---------------------------------------------------------------- the browser

let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let page: Page | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let chain: Promise<void> = Promise.resolve();
const recent: string[] = [];
let logger: ((m: string) => void) | undefined;
const note = (m: string): void => {
  recent.push(`${new Date().toISOString()} ${m}`);
  if (recent.length > 200) recent.splice(0, recent.length - 200);
  logger?.(m);
};
export const setInstagramLogger = (l: (m: string) => void): void => {
  logger = l;
};
export const instagramLog = (): { lines: string[] } => ({ lines: recent.slice() });

async function launchBrowser(): Promise<Browser> {
  const sup = sessionSupported();
  if (!sup.ok) throw new InstagramError(`Instagram needs a Chrome/Edge on the server: ${sup.reason}`, 503, 'instagram_unsupported');
  const p = await import('puppeteer-core');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(PROFILE_DIR, f), { force: true });
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--mute-audio', '--window-size=1280,900', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--renderer-process-limit=2'];
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
  if (process.platform === 'linux' && (process.getuid?.() === 0 || /^(1|true|yes)$/i.test(process.env.BROWSER_NO_SANDBOX || ''))) args.push('--no-sandbox');
  return p.launch({ executablePath: sup.executable, headless: 'new', userDataDir: PROFILE_DIR, defaultViewport: { width: 1280, height: 900 }, args, ignoreDefaultArgs: ['--enable-automation'], timeout: 90_000, protocolTimeout: 60_000 });
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    try {
      note('launching headless browser');
      let b: Browser;
      try {
        b = await launchBrowser();
      } catch (e) {
        if (e instanceof InstagramError) throw e;
        note(`browser launch failed (${(e as Error).message.split('\n')[0]}); retrying once`);
        await new Promise((r) => setTimeout(r, 3000));
        b = await launchBrowser();
      }
      browser = b;
      b.on('disconnected', () => {
        if (browser === b) {
          browser = undefined;
          page = undefined;
        }
      });
      return b;
    } finally {
      launching = undefined;
    }
  })();
  return launching;
}

/** Cookies of the saved sign-in as puppeteer wants them (instagram.com only). */
function cookieParams(cookies: ParsedCookie[]): Parameters<Page['setCookie']> {
  return cookies
    .filter((c) => /(^|\.)instagram\.com$/i.test(c.domain.replace(/^\./, '')))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain, path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly, ...(c.expires ? { expires: c.expires } : {}) }));
}

async function workPage(): Promise<Page> {
  const b = await getBrowser();
  if (page && !page.isClosed()) return page;
  const first = (await b.pages())[0];
  const p = first && first.url() === 'about:blank' ? first : await b.newPage();
  await p.setUserAgent((await b.userAgent()).replace('HeadlessChrome', 'Chrome'));
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => undefined);
    else req.continue().catch(() => undefined);
  });
  const saved = cookieSource?.();
  if (saved?.length) await p.setCookie(...cookieParams(saved));
  page = p;
  await p.goto(`${ORIGIN}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  note(`work page opened${saved?.length ? ' with the saved sign-in' : ''}`);
  return p;
}

/** One browser job at a time (the work page is navigated); closes the browser when idle. */
async function withPage<T>(fn: (p: Page) => Promise<T>): Promise<T> {
  const prev = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => (release = r));
  await prev;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    return await fn(await workPage());
  } finally {
    release();
    idleTimer = setTimeout(() => void closeBrowser('idle'), IDLE_CLOSE_MS);
    idleTimer.unref?.();
  }
}

async function closeBrowser(why: string): Promise<void> {
  const b = browser;
  browser = undefined;
  page = undefined;
  if (b) {
    note(`browser closed (${why})`);
    await b.close().catch(() => undefined);
  }
}

/** Drops the browser so the next job starts one with the current saved cookies (after a sign-in or sign-out). */
export async function resetInstagramBrowser(deleteProfile = false): Promise<void> {
  const prev = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => (release = r));
  await prev;
  try {
    await closeBrowser('reset');
    if (deleteProfile) fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  } finally {
    release();
  }
}

export const shutdownInstagram = (): Promise<void> => closeBrowser('shutdown');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- embed pages (the playable files)

export interface EmbedMedia {
  code: string;
  videoUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  views?: number;
  likes?: number;
  comments?: number;
  caption?: string;
  cover?: string;
  takenAt?: number;
  music?: string;
  owner: { id?: string; username?: string; fullName?: string; avatar?: string; verified?: boolean; followers?: number };
}

/** Runs inside the instagram.com page: fetches the embed pages and cuts the JSON out of them. */
const EMBED_JS = (codes: string[], concurrency: number): string => String.raw`(async (codes, conc) => {
  const KEY = '"contextJSON":"';
  const BS = String.fromCharCode(92);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const parse = (t) => {
    const st = t.indexOf(KEY);
    if (st < 0) return undefined;
    let i = st + KEY.length;
    while (i < t.length && t[i] !== '"') i += t[i] === BS ? 2 : 1;
    try { return JSON.parse(JSON.parse('"' + t.slice(st + KEY.length, i) + '"')); } catch (e) { return undefined; }
  };
  const one = async (code) => {
    let status = 0;
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch('/p/' + code + '/embed/captioned/', { credentials: 'include' });
        status = r.status;
        const ctx = parse(await r.text());
        const sm = ctx && ctx.gql_data && ctx.gql_data.shortcode_media;
        if (sm) {
          if (!sm.is_video || typeof sm.video_url !== 'string') return { code, status, notVideo: true };
          const cap = sm.edge_media_to_caption && sm.edge_media_to_caption.edges && sm.edge_media_to_caption.edges[0];
          const o = sm.owner || {};
          const mu = sm.clips_music_attribution_info;
          return { code, status, m: {
            code, videoUrl: sm.video_url, width: num(sm.dimensions && sm.dimensions.width), height: num(sm.dimensions && sm.dimensions.height),
            duration: num(sm.video_duration), views: num(sm.video_view_count),
            likes: num(sm.edge_liked_by && sm.edge_liked_by.count), comments: num(sm.edge_media_to_comment && sm.edge_media_to_comment.count),
            caption: cap && cap.node && cap.node.text, cover: sm.display_url || sm.thumbnail_src, takenAt: num(sm.taken_at_timestamp),
            music: mu ? [mu.uses_original_audio ? 'Original audio' : mu.song_name, mu.artist_name].filter(Boolean).join(' · ') : undefined,
            owner: { id: o.id, username: o.username, fullName: o.full_name, avatar: o.profile_pic_url, verified: o.is_verified, followers: num(o.edge_followed_by && o.edge_followed_by.count) },
          } };
        }
        if (r.status === 404) return { code, status, gone: true };
      } catch (e) { status = -1; }
      await sleep(600);
    }
    return { code, status, unavailable: true };
  };
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, codes.length) }, async () => {
    while (next < codes.length) { const i = next++; out[i] = await one(codes[i]); }
  }));
  return out;
})(${JSON.stringify(codes)}, ${concurrency})`;

interface EmbedAnswer {
  code: string;
  status: number;
  m?: EmbedMedia;
  notVideo?: boolean;
  gone?: boolean;
  unavailable?: boolean;
}

interface CacheEntry {
  at: number;
  media?: EmbedMedia;
  /** Why there is no media: not a video, removed, or not readable as a guest */
  why?: 'not_video' | 'gone' | 'unavailable';
}
const embedCache = new Map<string, CacheEntry>();

/** Resolves post codes to their embed data, in order; entries that are not videos or are gone are left out. */
export async function embedMany(codes: string[], log: (m: string) => void): Promise<Map<string, CacheEntry>> {
  const result = new Map<string, CacheEntry>();
  const todo: string[] = [];
  const now = Date.now();
  for (const c of codes) {
    const hit = embedCache.get(c);
    if (hit && now - hit.at < (hit.why === 'unavailable' ? 60_000 : hit.media ? EMBED_TTL_MS : 6 * 60 * 60 * 1000)) result.set(c, hit);
    else if (CODE.test(c) && !todo.includes(c)) todo.push(c);
  }
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const part = todo.slice(i, i + EMBED_BATCH);
    const t0 = Date.now();
    const answers = (await withPage((p) => p.evaluate(EMBED_JS(part, 8)))) as EmbedAnswer[];
    let ok = 0;
    for (const a of answers) {
      if (!a) continue;
      const entry: CacheEntry = a.m ? { at: Date.now(), media: a.m } : { at: Date.now(), why: a.notVideo ? 'not_video' : a.gone ? 'gone' : 'unavailable' };
      if (a.m) ok++;
      embedCache.set(a.code, entry);
      result.set(a.code, entry);
    }
    log(`instagram embeds: ${ok}/${part.length} videos in ${Date.now() - t0} ms`);
  }
  if (embedCache.size > 2000) for (const [k, v] of embedCache) if (Date.now() - v.at > EMBED_TTL_MS) embedCache.delete(k);
  return result;
}

function mediaFormat(m: EmbedMedia): MediaFormat {
  const exp = urlExpiry(m.videoUrl);
  const expiryMs = exp ? Math.min(defaultExpiry(), exp * 1000 - 60_000) : defaultExpiry();
  const rec = registerMedia({ url: m.videoUrl, headers: { 'user-agent': config.userAgent }, label: `instagram ${m.code}`, source: 'instagram', expiresAt: expiryMs });
  let host: string | undefined;
  try {
    host = new URL(m.videoUrl).hostname;
  } catch {
    /* ignore */
  }
  return {
    id: 'ig',
    label: `${m.width || '?'}×${m.height || '?'} H.264 + AAC (progressive MP4)`,
    codec: 'h264',
    width: m.width,
    height: m.height,
    // Instagram's CDN sends Access-Control-Allow-Origin: * and honours Range: the viewer may fetch it itself.
    directUrl: m.videoUrl,
    directKind: 'origin',
    proxyUrl: `/api/media/${rec.id}`,
    mediaId: rec.id,
    requiresCookies: false,
    expiresAt: exp,
    upstreamHost: host,
  };
}

export function embedToFeedItem(m: EmbedMedia): FeedItem {
  return {
    id: m.code,
    canonicalUrl: `${ORIGIN}/reel/${m.code}/`,
    author: { id: m.owner.id, uniqueId: m.owner.username, nickname: m.owner.fullName || undefined, avatar: m.owner.avatar },
    desc: m.caption || undefined,
    createTime: m.takenAt,
    duration: m.duration,
    width: m.width,
    height: m.height,
    cover: m.cover,
    music: m.music,
    stats: { plays: m.views, likes: m.likes, comments: m.comments },
    formats: [mediaFormat(m)],
  };
}

async function itemsFor(codes: string[], log: (m: string) => void): Promise<FeedItem[]> {
  const got = await embedMany(codes, log);
  const items: FeedItem[] = [];
  for (const c of codes) {
    const m = got.get(c)?.media;
    if (m && !items.some((i) => i.id === c)) items.push(embedToFeedItem(m));
  }
  return items;
}

/** POST /api/resolve for an Instagram post/reel URL */
export async function resolveInstagram(inputUrl: string, log: (m: string) => void): Promise<ResolveResponse> {
  requireSignedIn();
  const t0 = Date.now();
  const code = instagramCode(inputUrl);
  if (!code) throw new InstagramError('That is not an Instagram post or reel URL', 400, 'bad_url');
  const entry = (await embedMany([code], log)).get(code);
  if (!entry?.media) {
    const why = entry?.why === 'not_video' ? 'That post is not a video' : entry?.why === 'gone' ? 'That post does not exist (any more)' : 'Instagram would not show that post to a signed-out visitor (private account, removed, or rate limited)';
    throw new InstagramError(why, entry?.why === 'unavailable' ? 502 : 404, 'instagram_unavailable');
  }
  const m = entry.media;
  const fmt = mediaFormat(m);
  return {
    source: 'instagram',
    resolver: 'native',
    id: code,
    inputUrl,
    canonicalUrl: `${ORIGIN}/reel/${code}/`,
    title: m.caption?.slice(0, 200),
    author: m.owner.username,
    duration: m.duration,
    width: m.width,
    height: m.height,
    cover: m.cover,
    formats: [fmt],
    warnings: [],
    elapsedMs: Date.now() - t0,
    attempts: [{ resolver: 'native', ok: true, elapsedMs: Date.now() - t0 }],
  };
}

// ---------------------------------------------------------------- profiles (the rate-limited call) and the catalog

interface CatalogEntry {
  at: number;
  codes: string[];
  user?: UserSummary;
}
let catalog: Map<string, CatalogEntry> | undefined;

function loadCatalog(): Map<string, CatalogEntry> {
  if (catalog) return catalog;
  catalog = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) as { accounts?: Record<string, CatalogEntry> };
    for (const [k, v] of Object.entries(raw.accounts || {})) if (v && Array.isArray(v.codes)) catalog.set(k, v);
  } catch {
    /* none yet */
  }
  return catalog;
}
function saveCatalog(): void {
  try {
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify({ accounts: Object.fromEntries(loadCatalog()) }));
  } catch {
    /* the catalog is a cache */
  }
}

let blockedUntil = 0;
let blockStreak = 0;
let lastProfileAt = 0;
const profileLoads: number[] = [];

/** Seconds the profile pages are unavailable because Instagram limited this server's address (0 = fine). */
export const blockedForSec = (): number => Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));

export const PROFILE_STATE_JS = String.raw`(() => {
  const codes = [];
  const seen = {};
  for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
    const m = /\/reel\/([\w-]{5,20})\//.exec(a.getAttribute('href') || '');
    if (m && !seen[m[1]]) { seen[m[1]] = 1; codes.push(m[1]); }
  }
  const meta = (p) => { const e = document.querySelector('meta[property="' + p + '"],meta[name="' + p + '"]'); return e ? e.getAttribute('content') || '' : ''; };
  return { path: location.pathname, title: document.title, codes, text: (document.body ? document.body.innerText : '').slice(0, 500), desc: meta('og:description') || meta('description'), image: meta('og:image'), ogTitle: meta('og:title') };
})()`;

interface ProfileState {
  path: string;
  title: string;
  codes: string[];
  text: string;
  desc: string;
  image: string;
  ogTitle: string;
}

/**
 * Loads `/<handle>/reels/` and returns the Reels it lists (12 for a guest; a signed-in account keeps
 * paging while the page is scrolled, up to `want`).
 */
async function scrapeProfile(handle: string, want: number, log: (m: string) => void): Promise<CatalogEntry> {
  if (Date.now() < blockedUntil) throw new InstagramError(`Instagram is limiting profile pages from this server's address for another ${Math.ceil(blockedForSec() / 60)} min. Sign in (Profile) to avoid the limit, or try again later.`, 429, 'instagram_rate_limited');
  const hourAgo = Date.now() - 3600_000;
  while (profileLoads.length && profileLoads[0] < hourAgo) profileLoads.shift();
  if (profileLoads.length >= PROFILE_BUDGET_PER_HOUR) throw new InstagramError('Too many Instagram profile loads this hour (Instagram blocks a server that loads many); try again in a few minutes.', 429, 'instagram_budget');
  return withPage(async (p) => {
    const wait = lastProfileAt + PROFILE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastProfileAt = Date.now();
    profileLoads.push(Date.now());
    const t0 = Date.now();
    await p.goto(`${ORIGIN}/${encodeURIComponent(handle)}/reels/`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    let st: ProfileState = (await p.evaluate(PROFILE_STATE_JS)) as ProfileState;
    for (let i = 0; i < 40; i++) {
      if (/^\/accounts\/login/.test(st.path)) {
        const pause = Math.min(BLOCK_MAX_MS, BLOCK_MS * 2 ** blockStreak);
        blockStreak++;
        blockedUntil = Date.now() + pause;
        note(`@${handle}: Instagram redirected to the login page (profile rate limit); no profile loads for ${Math.round(pause / 60000)} min`);
        await p.goto(`${ORIGIN}/robots.txt`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        throw new InstagramError("Instagram is limiting profile pages from this server's address. Sign in (Profile) to avoid the limit, or try again in a while.", 429, 'instagram_rate_limited');
      }
      if (/isn't available|page not found/i.test(st.title) || /Sorry, this page isn't available/i.test(st.text)) throw new InstagramError(`@${handle} was not found on Instagram`, 404, 'instagram_not_found');
      if (/This account is private/i.test(st.text)) throw new InstagramError(`@${handle} is a private account`, 403, 'instagram_private');
      if (st.codes.length) break;
      await sleep(400);
      st = (await p.evaluate(PROFILE_STATE_JS)) as ProfileState;
    }
    // A signed-in profile keeps loading Reels as the page is scrolled; a guest's 12 are all there is.
    if (signedIn() && st.codes.length >= 12 && want > st.codes.length) {
      for (let round = 0; round < 8 && st.codes.length < want; round++) {
        await p.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await sleep(1500);
        const next = (await p.evaluate(PROFILE_STATE_JS)) as ProfileState;
        const grew = next.codes.length > st.codes.length;
        st = next;
        if (!grew) break;
      }
    }
    await p.goto(`${ORIGIN}/robots.txt`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    blockStreak = 0;
    log(`instagram @${handle}: ${st.codes.length} reels, ${Date.now() - t0} ms`);
    // Nothing found is not a listing worth keeping for hours (slow page, changed markup, an empty account).
    if (!st.codes.length) throw new InstagramError(`Instagram showed no Reels on @${handle}'s profile page (page: "${st.title.slice(0, 60)}")`, 404, 'instagram_no_reels');
    const user = parseProfileMeta(handle, st.desc, st.ogTitle, st.image);
    const entry: CatalogEntry = { at: Date.now(), codes: st.codes, user };
    loadCatalog().set(handle.toLowerCase(), entry);
    saveCatalog();
    return entry;
  });
}

/** An account's Reels: from the catalog while it is fresh, else from its profile page (stale data beats an error). */
async function accountReels(handle: string, want: number, log: (m: string) => void): Promise<CatalogEntry> {
  const key = handle.toLowerCase();
  const hit = loadCatalog().get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS && (hit.codes.length >= want || !signedIn() || hit.codes.length < 12)) return hit;
  try {
    return await scrapeProfile(handle, want, log);
  } catch (e) {
    if (hit && e instanceof InstagramError && (e.status === 429 || e.status === 502)) {
      log(`instagram @${handle}: ${e.message} - using the saved listing from ${new Date(hit.at).toLocaleString()}`);
      return hit;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- explore (guest) and For You (signed in)

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const orders = new Map<number, string[]>();
const cursors = new Map<number, number>();
/** The accounts of a category in a random but stable order ("All" alternates between the categories' accounts). */
function accountOrder(catId: number): string[] {
  let o = orders.get(catId);
  if (!o) {
    const cats = INSTAGRAM_CATEGORIES.filter((c) => c.id !== 0);
    if (catId === 0) {
      const lists = shuffle(cats.map((c) => shuffle([...c.accounts])));
      const mixed: string[] = [];
      for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && !mixed.includes(l[i])) mixed.push(l[i]);
      o = mixed;
    } else {
      o = shuffle([...instagramCategory(catId).accounts]);
    }
    orders.set(catId, o);
  }
  return o;
}

/**
 * One reservoir fill of a category: the next few accounts of its rotation, their Reels interleaved
 * (so the feed never shows a dozen from one account in a row) and resolved through the embed pages.
 */
export async function exploreInstagram(catId: number, want: number, log: (m: string) => void): Promise<{ items: FeedItem[]; warnings: string[] }> {
  requireSignedIn();
  const order = accountOrder(catId);
  const warnings: string[] = [];
  const lists: string[][] = [];
  let collected = 0;
  let loaded = 0;
  let failure: InstagramError | undefined;
  for (let tried = 0; tried < order.length && collected < want && loaded < 3; tried++) {
    const cur = cursors.get(catId) || 0;
    cursors.set(catId, cur + 1);
    const handle = order[cur % order.length];
    const fresh = loadCatalog().get(handle.toLowerCase());
    // Profile pages are limited: until they are allowed again only the accounts already listed can be used.
    if (failure && !fresh) continue;
    const cached = Boolean(fresh && Date.now() - fresh.at < CATALOG_TTL_MS);
    try {
      const acc = await accountReels(handle, 12, log);
      if (!cached) loaded++;
      if (acc.codes.length) {
        lists.push(acc.codes.slice(0, 12));
        collected += Math.min(12, acc.codes.length);
      }
    } catch (e) {
      if (!(e instanceof InstagramError)) throw e;
      if (e.status === 429) {
        failure = e;
        continue;
      }
      warnings.push(`@${handle}: ${e.message}`);
    }
  }
  const codes: string[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && !codes.includes(l[i])) codes.push(l[i]);
  if (!codes.length) throw failure || new InstagramError('Instagram showed no Reels for the accounts tried' + (warnings.length ? ` (${warnings.join('; ')})` : ''), 502, 'instagram_empty');
  if (failure) warnings.push(`${failure.message} (showing Reels listed earlier)`);
  const items = await itemsFor(codes.slice(0, Math.max(want, 24)), log);
  return { items, warnings };
}

/**
 * The signed-in account's Reels page (`/reels/`): the post codes in the GraphQL answers the page
 * receives while it is paged with the keyboard, plus the URL it settles on after each step.
 */
export async function forYouInstagram(want: number, log: (m: string) => void): Promise<{ items: FeedItem[]; warnings: string[] }> {
  requireSignedIn();
  const codes = await withPage(async (p) => {
    const found = new Set<string>();
    const onResponse = (res: import('puppeteer-core').HTTPResponse): void => {
      const u = res.url();
      if (!/\/api\/graphql|\/graphql\/query|\/api\/v1\//.test(u) || !/json|javascript|text\/plain/.test(res.headers()['content-type'] || '')) return;
      void res
        .text()
        .then((t) => {
          if (/"code"/.test(t)) collectCodes(JSON.parse(t.replace(/^for \(;;\);/, '')), found);
        })
        .catch(() => undefined);
    };
    p.on('response', onResponse);
    try {
      await p.goto(`${ORIGIN}/reels/`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      const t0 = Date.now();
      for (let step = 0; step < 14 && found.size < want && Date.now() - t0 < 25_000; step++) {
        await sleep(1200);
        const here = /\/reels\/([\w-]{5,20})/.exec(new URL(p.url()).pathname)?.[1];
        if (here && CODE.test(here)) found.add(here);
        if (/^\/accounts\/login/.test(new URL(p.url()).pathname)) throw new InstagramError('Instagram signed this server out; sign in again from Profile.', 401, 'instagram_not_signed_in');
        await p.keyboard.press('ArrowDown');
      }
    } finally {
      p.off('response', onResponse);
      await p.goto(`${ORIGIN}/robots.txt`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    return [...found];
  });
  log(`instagram foryou: ${codes.length} reel codes captured`);
  if (!codes.length) return { items: [], warnings: ['Instagram returned no Reels this time'] };
  return { items: await itemsFor(codes, log), warnings: [] };
}

// ---------------------------------------------------------------- search and profiles

const SEARCH_JS = (q: string): string => String.raw`fetch('/web/search/topsearch/?context=blended&include_reel=true&query=' + encodeURIComponent(${JSON.stringify(q)}), { credentials: 'include', headers: { 'x-ig-app-id': '${APP_ID}', 'x-requested-with': 'XMLHttpRequest' } }).then(async (r) => ({ status: r.status, text: await r.text() }))`;

export async function searchInstagram(q: string, offset: number, log: (m: string) => void): Promise<SearchResponse> {
  requireSignedIn();
  const t0 = Date.now();
  const warnings: string[] = [];
  let users: UserSummary[] = [];
  let items: FeedItem[] = [];
  const code = instagramCode(q);
  if (code) {
    items = await itemsFor([code], log);
    if (!items.length) warnings.push('That post is not a video Instagram shows to a signed-out visitor');
    return { q, items, users, hasMore: false, offset, warnings, elapsedMs: Date.now() - t0 };
  }
  if (offset > 0) return { q, items: [], users: [], hasMore: false, offset, warnings, elapsedMs: Date.now() - t0 };
  if (signedIn()) {
    try {
      const r = (await withPage((p) => p.evaluate(SEARCH_JS(q)))) as { status: number; text: string };
      const json = r.status === 200 ? JSON.parse(r.text) : undefined;
      users = (Array.isArray(json?.users) ? json.users : [])
        .map((x: any) => x?.user)
        .filter((u: any) => u && typeof u.username === 'string')
        .map((u: any): UserSummary => ({ id: u.pk ? String(u.pk) : undefined, uniqueId: u.username, nickname: u.full_name || undefined, avatar: u.profile_pic_url || undefined, verified: Boolean(u.is_verified) }));
      if (r.status !== 200) warnings.push(`Instagram search answered ${r.status}`);
    } catch (e) {
      warnings.push(`Instagram search failed (${(e as Error).message})`);
    }
  }
  const handle = handleFromQuery(q);
  const lead = users.find((u) => u.uniqueId.toLowerCase() === handle?.toLowerCase())?.uniqueId || (!users.length ? handle : undefined);
  if (lead) {
    try {
      const prof = await profileInstagram(lead, 0, 12, log);
      items = prof.items;
      if (!users.some((u) => u.uniqueId.toLowerCase() === lead.toLowerCase())) users = [prof.user, ...users];
    } catch (e) {
      warnings.push((e as Error).message);
    }
  } else if (!users.length) {
    warnings.push('Instagram search needs a sign-in. Type an account name (@handle) or paste a link to a post.');
  }
  return { q, items, users, hasMore: false, offset: 0, warnings, elapsedMs: Date.now() - t0 };
}

export async function profileInstagram(handle: string, offset: number, count: number, log: (m: string) => void): Promise<ProfileResponse> {
  requireSignedIn();
  const t0 = Date.now();
  const acc = await accountReels(handle, offset + count, log);
  const slice = acc.codes.slice(offset, offset + count);
  const items = await itemsFor(slice, log);
  const user: UserSummary = { ...(acc.user || { uniqueId: handle }), uniqueId: acc.user?.uniqueId || handle };
  const owner = items[0]?.author;
  if (owner) {
    user.id = user.id || owner.id;
    user.nickname = user.nickname || owner.nickname;
    user.avatar = user.avatar || owner.avatar;
  }
  const warnings: string[] = [];
  if (!acc.codes.length) warnings.push(`@${handle} has no Reels to show`);
  return { user, items, offset, hasMore: signedIn() && acc.codes.length >= offset + count && acc.codes.length >= 12, warnings, elapsedMs: Date.now() - t0 };
}

// ---------------------------------------------------------------- the account (used by instagramSession.ts)

export interface InstagramAccount {
  ok: boolean;
  loggedIn: boolean;
  username?: string;
  name?: string;
  avatar?: string;
  error?: string;
}

const ACCOUNT_JS = String.raw`(async () => {
  const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
  const h = { 'x-ig-app-id': '${APP_ID}', 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': csrf, 'x-asbd-id': '129477' };
  const r = await fetch('/api/v1/accounts/current_user/?edit=true', { credentials: 'include', headers: h });
  const t = await r.text();
  return { status: r.status, text: t.slice(0, 20000) };
})()`;

/** What Instagram says about a set of cookies (the account the web app would show), or ok:false when it could not be asked. */
export function accountFromAnswer(status: number, text: string): InstagramAccount {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const u = json?.user;
  if (status === 200 && u && typeof u.username === 'string') return { ok: true, loggedIn: true, username: u.username, name: u.full_name || undefined, avatar: u.profile_pic_url || undefined };
  if (status === 401 || status === 403 || json?.require_login === true || json?.message === 'login_required') return { ok: true, loggedIn: false, error: json?.message ? String(json.message) : `Instagram answered ${status}` };
  return { ok: false, loggedIn: false, error: `Instagram answered ${status}` };
}

/**
 * Puts `cookies` into the browser (replacing what it holds) and asks Instagram who they belong to.
 * With no cookies the browser's current ones are checked. A refusal removes the cookies again.
 */
export async function checkInstagramAccount(cookies?: ParsedCookie[]): Promise<InstagramAccount> {
  try {
    return await withPage(async (p) => {
      if (cookies) {
        const cdp = await p.createCDPSession();
        await cdp.send('Network.clearBrowserCookies').catch(() => undefined);
        await cdp.detach().catch(() => undefined);
        const params = cookieParams(cookies);
        if (params.length) await p.setCookie(...params);
        await p.goto(`${ORIGIN}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      }
      const r = (await p.evaluate(ACCOUNT_JS)) as { status: number; text: string };
      let acc = accountFromAnswer(r.status, r.text);
      if (!acc.ok) {
        // The API call was refused (429 from a datacenter address): ask through a page instead.
        note(`account check: API answered ${r.status}; trying the settings page`);
        acc = await accountFromSettingsPage(p, cookies);
      }
      note(`account check: status ${r.status} -> ${acc.ok ? (acc.loggedIn ? 'signed in as @' + acc.username : 'signed out') : acc.error}`);
      if (cookies && acc.ok && !acc.loggedIn) {
        const cdp = await p.createCDPSession();
        await cdp.send('Network.clearBrowserCookies').catch(() => undefined);
        await cdp.detach().catch(() => undefined);
      }
      return acc;
    });
  } catch (e) {
    return { ok: false, loggedIn: false, error: (e as Error).message };
  }
}

/** The settings page needs a sign-in: it stays put when signed in and is sent to the login page when not. */
async function accountFromSettingsPage(p: Page, cookies?: ParsedCookie[]): Promise<InstagramAccount> {
  try {
    await p.goto(`${ORIGIN}/accounts/edit/`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    let st = { path: '', url: '', user: '' };
    for (let i = 0; i < 20; i++) {
      st = (await p.evaluate(String.raw`({ path: location.pathname, url: location.href, user: (document.querySelector('input[name="username"]') || {}).value || '' })`)) as typeof st;
      if (/^\/accounts\/login/.test(st.path) || (/^\/accounts\/edit/.test(st.path) && st.user)) break;
      await sleep(500);
    }
    await p.goto(`${ORIGIN}/robots.txt`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    note(`settings page: ${st.path || '?'}${/is_from_rle/.test(st.url) ? ' (rate-limit redirect)' : ''}`);
    if (/^\/accounts\/login/.test(st.path)) {
      // The same redirect is how Instagram limits a busy address: that says nothing about the cookies.
      if (/is_from_rle/.test(st.url)) return { ok: false, loggedIn: false, error: "Instagram is limiting this server's address (rate-limit redirect)" };
      return { ok: true, loggedIn: false, error: 'the settings page sent the cookies to the login page' };
    }
    if (/^\/accounts\/edit/.test(st.path)) {
      const id = (cookies || cookieSource?.() || []).find((c) => c.name === 'ds_user_id')?.value;
      return { ok: true, loggedIn: true, username: st.user || (id ? `user${id}` : 'instagram') };
    }
    return { ok: false, loggedIn: false, error: `unexpected settings page ${st.path || '(none)'}` };
  } catch (e) {
    return { ok: false, loggedIn: false, error: (e as Error).message };
  }
}

export function instagramStats(): Record<string, unknown> {
  return { browser: Boolean(browser?.isConnected()), blockedForSec: blockedForSec(), profileLoadsLastHour: profileLoads.filter((t) => t > Date.now() - 3600_000).length, catalogAccounts: loadCatalog().size, embedCache: embedCache.size };
}
