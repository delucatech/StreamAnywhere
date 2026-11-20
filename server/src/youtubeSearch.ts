/**
 * YouTube search straight from YouTube's own web API: the youtubei/v1/search endpoint that
 * youtube.com's search page calls, over plain HTTPS. No Python, no browser, nothing to warm up.
 *
 * Measured 2026-11-20 from the dev PC, "electric bikes review": the first page of 20 videos in
 * 0.6-0.8 s (about 95 KB gzipped), against 2.6 s for yt-dlp's ytsearch20 in-process (yt-dlp also
 * loads a youtube.com page for its config first, and its daemon queue sits in front of that).
 *
 * yt-dlp stays the fallback (youtube.ts): a failure here - an HTTP error, a timeout, or an answer
 * whose layout this parser no longer recognises - is logged and counted in /api/health
 * (youtubeSearch.fallback, lastFallback), and the same search is answered by yt-dlp, which every
 * deploy upgrades. YOUTUBE_SEARCH=ytdlp turns this path off entirely.
 *
 * The request is the one yt-dlp's ytsearch sends: the WEB client, the "Videos" filter
 * (VIDEOS_ONLY: no channels, playlists or shelves), and on later pages the continuation token of
 * the previous answer plus its visitor id. The web client version is refreshed from youtube.com
 * once a day (refreshClientVersion), so a version YouTube stops accepting is replaced without a
 * deploy.
 *
 * Pages: YouTube pages with continuation tokens, not offsets, and its continuation answers are
 * uneven (measured: 20, then 5, then 19 videos; another query 20, 1, 17, with repeats of earlier
 * pages). The server keeps each query's chain for STATE_TTL_MS: page N is the next PAGE videos not
 * seen on pages 0..N-1, fetched with up to MAX_REQUESTS_PER_PAGE continuation calls; videos past
 * PAGE wait in the chain's buffer and start the next page (often with no request at all). A page
 * asked for after the chain expired (or after a restart) is reached by walking the chain again.
 */
import * as zlib from 'node:zlib';
import { openUpstream, readBody } from './http';

const API = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const HOME = 'https://www.youtube.com/';
const HOSTS = ['www.youtube.com'];
/** youtube.com's "Type: Videos" search filter; yt-dlp's ytsearch sends the same. */
export const VIDEOS_ONLY = 'EgIQAfABAQ==';
/** The web client version (yt-dlp 2026.08.19 sends this one); replaced by refreshClientVersion. */
const DEFAULT_CLIENT_VERSION = '2.20260708.00.00';
const VERSION_REFRESH_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REQUESTS_PER_PAGE = 4;
const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_STATES = 200;

/** The answer is not shaped the way this parser expects: YouTube changed its layout. */
export class SearchLayoutError extends Error {}

/** One search result in the shape of a yt-dlp flat-playlist entry (what entryToFeedItem reads). */
export interface SearchEntry {
  id: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  /** "@handle", as yt-dlp gives it */
  uploader_id?: string;
  duration?: number;
  view_count?: number;
  live_status?: 'is_live' | 'is_upcoming';
  thumbnails: { url: string; width?: number; height?: number }[];
}

export interface ParsedAnswer {
  entries: SearchEntry[];
  /** The continuation token for the next answer; undefined at the end of the results */
  token?: string;
  visitorData?: string;
}

// ---------------------------------------------------------------- parsing (pure)

const text = (o: any): string | undefined => {
  if (!o) return undefined;
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map((r: any) => (typeof r?.text === 'string' ? r.text : '')).join('') || undefined;
  return undefined;
};

/** "51:20" -> 3080, "1:02:03" -> 3723; undefined for anything else. */
export function parseDuration(s: string | undefined): number | undefined {
  if (!s || !/^\d+(:\d{1,2}){0,2}$/.test(s.trim())) return undefined;
  return s
    .trim()
    .split(':')
    .reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** "139,516 views" -> 139516, "1 view" -> 1, "No views" -> 0; undefined when there is no count. */
export function parseViews(s: string | undefined): number | undefined {
  if (!s) return undefined;
  if (/^no views/i.test(s.trim())) return 0;
  const digits = s.replace(/[^\d]/g, '');
  return digits ? Number(digits) : undefined;
}

/** Drops the usqp= parameter (yt-dlp gives the URLs without it) and fills in a missing scheme. */
function cleanThumb(url: string): string {
  const u = url.startsWith('//') ? 'https:' + url : url;
  return u.replace(/([?&])usqp=[^&]*(&|$)/, (_m, lead: string, tail: string) => (tail ? lead : ''));
}

/** One videoRenderer as a flat entry; undefined when it has no usable video id. */
export function videoRendererToEntry(v: any): SearchEntry | undefined {
  const id = typeof v?.videoId === 'string' && /^[\w-]{11}$/.test(v.videoId) ? v.videoId : undefined;
  if (!id) return undefined;
  const owner = (v.ownerText?.runs || v.longBylineText?.runs || v.shortBylineText?.runs || [])[0];
  const browse = owner?.navigationEndpoint?.browseEndpoint;
  const base = typeof browse?.canonicalBaseUrl === 'string' ? browse.canonicalBaseUrl : '';
  let handle: string | undefined;
  if (base.startsWith('/@')) {
    try {
      handle = '@' + decodeURIComponent(base.slice(2));
    } catch {
      handle = '@' + base.slice(2);
    }
  }
  const badgeStyles: string[] = (v.badges || []).map((b: any) => b?.metadataBadgeRenderer?.style).filter(Boolean);
  const overlayStyles: string[] = (v.thumbnailOverlays || []).map((o: any) => o?.thumbnailOverlayTimeStatusRenderer?.style).filter(Boolean);
  const live = badgeStyles.includes('BADGE_STYLE_TYPE_LIVE_NOW') || overlayStyles.includes('LIVE');
  const upcoming = Boolean(v.upcomingEventData) || overlayStyles.includes('UPCOMING');
  const thumbs: any[] = Array.isArray(v.thumbnail?.thumbnails) ? v.thumbnail.thumbnails : [];
  return {
    id,
    title: text(v.title),
    channel: typeof owner?.text === 'string' ? owner.text : undefined,
    channel_id: typeof browse?.browseId === 'string' ? browse.browseId : undefined,
    uploader_id: handle,
    duration: parseDuration(text(v.lengthText)),
    view_count: parseViews(text(v.viewCountText)),
    live_status: live ? 'is_live' : upcoming ? 'is_upcoming' : undefined,
    thumbnails: thumbs
      .filter((t) => typeof t?.url === 'string')
      .map((t) => ({ url: cleanThumb(t.url), width: Number(t.width) || undefined, height: Number(t.height) || undefined })),
  };
}

/** Where the results sit: the first page's section list, or a continuation's appended items. */
function resultContainers(json: any): any[] | undefined {
  const first = json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
  if (Array.isArray(first)) return first;
  const cmds = json?.onResponseReceivedCommands;
  if (Array.isArray(cmds)) {
    const items = cmds.flatMap((c: any) => c?.appendContinuationItemsAction?.continuationItems || c?.reloadContinuationItemsCommand?.continuationItems || []);
    if (items.length || cmds.some((c: any) => c?.appendContinuationItemsAction || c?.reloadContinuationItemsCommand)) return items;
  }
  return undefined;
}

/**
 * The videos and the next continuation token of one search answer. Throws SearchLayoutError when
 * the result list is missing, or when it holds videos in a form this parser does not read
 * (no videoRenderer at all while video ids are present): yt-dlp answers instead.
 */
export function parseSearchAnswer(json: any): ParsedAnswer {
  const containers = resultContainers(json);
  if (!containers) throw new SearchLayoutError(`no result list in the answer (top-level keys: ${Object.keys(json || {}).slice(0, 8).join(', ')})`);
  const entries: SearchEntry[] = [];
  const seen = new Set<string>();
  const otherIds = new Set<string>();
  let token: string | undefined;
  const walk = (o: any): void => {
    if (Array.isArray(o)) {
      for (const x of o) walk(x);
      return;
    }
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'videoRenderer') {
        const e = videoRendererToEntry(v);
        if (e && !seen.has(e.id)) {
          seen.add(e.id);
          entries.push(e);
        }
        continue;
      }
      if (k === 'continuationItemRenderer') {
        const t = (v as any)?.continuationEndpoint?.continuationCommand?.token;
        if (typeof t === 'string' && t) token = t;
        continue;
      }
      if (k === 'videoId' && typeof v === 'string') otherIds.add(v);
      walk(v);
    }
  };
  walk(containers);
  if (!entries.length && otherIds.size) throw new SearchLayoutError(`${otherIds.size} videos in a layout this parser does not read (no videoRenderer)`);
  const visitorData = json?.responseContext?.visitorData;
  return { entries, token, visitorData: typeof visitorData === 'string' ? visitorData : undefined };
}

// ---------------------------------------------------------------- network

/** Sends one search request (the first page or a continuation) and returns the parsed JSON. */
export type SearchTransport = (body: Record<string, unknown>, clientVersion: string, visitorData?: string) => Promise<any>;

async function readMaybeGzip(res: Awaited<ReturnType<typeof openUpstream>>['res']): Promise<string> {
  let buf = await readBody(res, 8 * 1024 * 1024);
  if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}

const httpTransport: SearchTransport = async (body, clientVersion, visitorData) => {
  const data = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept-encoding': 'gzip',
    origin: 'https://www.youtube.com',
    'x-youtube-client-name': '1',
    'x-youtube-client-version': clientVersion,
  };
  if (visitorData) headers['x-goog-visitor-id'] = visitorData;
  const { res, status } = await openUpstream(API, { method: 'POST', body: data, headers, allowlist: HOSTS, timeoutMs: REQUEST_TIMEOUT_MS });
  const textBody = await readMaybeGzip(res);
  if (status !== 200) throw new Error(`YouTube search answered ${status}: ${textBody.replace(/\s+/g, ' ').slice(0, 160)}`);
  try {
    return JSON.parse(textBody);
  } catch {
    throw new SearchLayoutError(`the answer is not JSON (${textBody.slice(0, 80)})`);
  }
};

let transport: SearchTransport = httpTransport;

// ---------------------------------------------------------------- client version

let clientVersion = DEFAULT_CLIENT_VERSION;
let versionCheckedAt = 0;
let versionRefresh: Promise<void> | undefined;

/** The web client version youtube.com currently serves, read from its home page. */
export function clientVersionFromPage(html: string): string | undefined {
  return /"INNERTUBE_CLIENT_VERSION":"(\d+\.\d{8}\.\d{2}\.\d{2})"/.exec(html)?.[1];
}

/** At most once a day, in the background: a failure keeps the version in use. */
function refreshClientVersion(log: (m: string) => void): void {
  if (versionRefresh || Date.now() - versionCheckedAt < VERSION_REFRESH_MS) return;
  versionCheckedAt = Date.now();
  versionRefresh = (async () => {
    const { res, status } = await openUpstream(HOME, { headers: { 'accept-encoding': 'gzip', 'accept-language': 'en-US,en;q=0.9' }, allowlist: HOSTS, timeoutMs: REQUEST_TIMEOUT_MS });
    const html = await readMaybeGzip(res);
    const found = status === 200 ? clientVersionFromPage(html) : undefined;
    if (!found) return log(`youtube search: client version not found on youtube.com (HTTP ${status}); keeping ${clientVersion}`);
    if (found !== clientVersion) log(`youtube search: client version ${clientVersion} -> ${found}`);
    clientVersion = found;
  })()
    .catch((e) => log(`youtube search: client version check failed (${(e as Error).message}); keeping ${clientVersion}`))
    .finally(() => {
      versionRefresh = undefined;
    });
}

// ---------------------------------------------------------------- pages

interface QueryState {
  at: number;
  visitorData?: string;
  /** undefined: nothing fetched yet; null: the results ended */
  token?: string | null;
  pages: SearchEntry[][];
  /** videos fetched but not paged yet (an answer that overshot a page); they start the next one */
  buffer: SearchEntry[];
  seen: Set<string>;
  /** requests of one query run one after another (page 2 needs page 1's token) */
  lock: Promise<unknown>;
}

const states = new Map<string, QueryState>();

function stateFor(q: string): QueryState {
  const key = q.toLowerCase();
  let st = states.get(key);
  if (!st || Date.now() - st.at > STATE_TTL_MS) {
    st = { at: Date.now(), pages: [], buffer: [], seen: new Set(), lock: Promise.resolve() };
    states.delete(key);
    states.set(key, st);
    while (states.size > MAX_STATES) states.delete(states.keys().next().value as string);
  }
  return st;
}

async function fillTo(st: QueryState, q: string, page: number, pageSize: number): Promise<number> {
  let requests = 0;
  while (st.pages.length <= page && (st.token !== null || st.buffer.length)) {
    let calls = 0;
    while (st.buffer.length < pageSize && st.token !== null && calls < MAX_REQUESTS_PER_PAGE) {
      const context = { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } };
      const body = st.token === undefined ? { context, query: q, params: VIDEOS_ONLY } : { context, continuation: st.token };
      const parsed = parseSearchAnswer(await transport(body, clientVersion, st.visitorData));
      calls++;
      requests++;
      st.visitorData = st.visitorData || parsed.visitorData;
      st.token = parsed.token ?? null;
      for (const e of parsed.entries) {
        if (st.seen.has(e.id)) continue;
        st.seen.add(e.id);
        st.buffer.push(e);
      }
    }
    if (!st.buffer.length) {
      // nothing new at all: the end (no endless empty pages); a query without results keeps one empty page
      st.token = null;
      if (!st.pages.length) st.pages.push([]);
      break;
    }
    st.pages.push(st.buffer.splice(0, pageSize));
  }
  return requests;
}

export interface DirectPage {
  entries: SearchEntry[];
  hasMore: boolean;
  /** search requests this page needed (0 when the chain already had it) */
  requests: number;
}

/**
 * Page `floor(offset / pageSize)` of the results for `q`. Throws on any failure; the query's chain
 * is dropped then, so the next attempt starts clean.
 */
export async function searchDirect(q: string, offset: number, pageSize: number, log: (m: string) => void): Promise<DirectPage> {
  refreshClientVersion(log);
  const st = stateFor(q);
  const page = Math.max(0, Math.floor(offset / pageSize));
  const run = st.lock.then(async (): Promise<DirectPage> => {
    try {
      const requests = await fillTo(st, q, page, pageSize);
      const entries = st.pages[page] || [];
      const hasMore = page < st.pages.length - 1 || st.buffer.length > 0 || (st.token !== null && st.token !== undefined);
      return { entries, hasMore, requests };
    } catch (e) {
      if (states.get(q.toLowerCase()) === st) states.delete(q.toLowerCase());
      throw e;
    }
  });
  st.lock = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------- status

const stats = { direct: 0, fallback: 0, lastFallback: undefined as { at: string; reason: string } | undefined };

/** False when YOUTUBE_SEARCH=ytdlp: every search goes to yt-dlp, as before this module. */
export const directSearchEnabled = (): boolean => !/^ytdlp$/i.test(process.env.YOUTUBE_SEARCH || '');

export function noteDirect(): void {
  stats.direct++;
}

export function noteFallback(reason: string): void {
  stats.fallback++;
  stats.lastFallback = { at: new Date().toISOString(), reason: reason.slice(0, 300) };
}

/** For /api/health: which path answers searches, and how often the fallback was needed. */
export const youtubeSearchStatus = (): { mode: 'direct' | 'ytdlp'; clientVersion: string; direct: number; fallback: number; lastFallback?: { at: string; reason: string } } => ({
  mode: directSearchEnabled() ? 'direct' : 'ytdlp',
  clientVersion,
  direct: stats.direct,
  fallback: stats.fallback,
  lastFallback: stats.lastFallback,
});

/** Tests: replace the network (undefined restores it), forget every chain, skip the version check. */
export function setSearchTransport(t: SearchTransport | undefined): void {
  transport = t || httpTransport;
  states.clear();
  versionCheckedAt = t ? Number.MAX_SAFE_INTEGER : 0;
}
