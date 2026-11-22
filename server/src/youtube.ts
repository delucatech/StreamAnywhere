/**
 * YouTube through yt-dlp (guest for Shorts, search and channels; the saved cookies for the account):
 *
 *  - search:   YouTube's web API directly (youtubeSearch.ts, under a second a page); yt-dlp's
 *              `ytsearch<N>:<query>` with --flat-playlist (about 3-4 s a page of 20) when that fails.
 *  - explore:  the Shorts tab of a hashtag page (youtube.com/hashtag/<tag>/shorts): vertical videos,
 *              about 30 per page in under 3 s. YouTube's Trending page is gone (redirects home).
 *  - channel:  youtube.com/@handle/videos, the same flat listing.
 *  - resolve:  YouTube's player API directly (youtubePlayer.ts, about 0.2 s); yt-dlp's `-j` for
 *              one video (2 s on a PC, 7-25 s on the e2-micro) when that fails. YouTube hands
 *              guests no muxed format (the 360p one needs a PO token and answers 403), so the
 *              player gets two files: H.264 video (itag 160/133/134/135/136, 144p-720p) and AAC
 *              audio (itag 140), both fragmented MP4, both relayed by the proxy: googlevideo URLs
 *              are bound to the server's IP and carry no CORS header.
 *  - foryou:   youtube.com/feed/recommended (the signed-in home feed) with the cookie file of the
 *              YouTube sign-in (youtubeSession.ts); a signed-out visitor gets an empty list there.
 *
 * Measured 2026-10-12 from the dev machine and from the GCP VM (no bot check there for guests).
 */
import type { FeedItem, MediaFormat, ResolveResponse, SearchResponse, YouTubeCategory } from '../../shared/types';
import { YOUTUBE_CATEGORIES } from '../../shared/types';
import { defaultExpiry, registerMedia } from './mediaStore';
import { ytdlpInfo } from './ytdlp';
import { directPlayerEnabled, notePlayerDirect, notePlayerFallback, playerInfoDirect } from './youtubePlayer';
import { directSearchEnabled, noteDirect, noteFallback, searchDirect } from './youtubeSearch';
import { tvHomeFeed } from './youtubeTv';

/**
 * Listings keep a long limit (a page of a busy hashtag can take a while on the e2-micro).
 *
 * A single video: the viewer waits RESOLVE_TIMEOUT_MS for it, then the feed shows the failure and
 * skips the video. The lookup itself (LOOKUP_TIMEOUT_MS: the direct request, then yt-dlp with its
 * wait for a free daemon and the retry with the account's cookies) goes on after that and its
 * answer is kept, so the same video asked again plays at once instead of starting over - and a
 * slow yt-dlp run is no longer cut off just before it ends (ytdlp.ts STUCK_MS).
 */
const LIST_TIMEOUT_MS = 150_000;
const RESOLVE_TIMEOUT_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 75_000;
/** The direct request gives way to yt-dlp after this long (it answers in 0.2 s when it answers). */
const DIRECT_TIMEOUT_MS = 8_000;
/** The cookies retry is skipped when less than this is left of LOOKUP_TIMEOUT_MS. */
const RETRY_MIN_MS = 5_000;
/** yt-dlp for one video: the manifests it would download and parse are never played here. */
const VIDEO_EXTRACTOR_ARGS = { youtube: { skip: ['hls', 'dash'] } };

export class YouTubeError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
  }
}

const VIDEO_ID = /^[\w-]{11}$/;

export function isYouTubeUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, '');
    return h === 'youtube.com' || h === 'youtu.be' || h === 'youtube-nocookie.com';
  } catch {
    return false;
  }
}

/** The 11-character video id of a watch / shorts / youtu.be / embed URL, or undefined. */
export function youTubeVideoId(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, '');
    let id: string | null | undefined;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = /^\/(?:shorts|embed|v|live)\/([\w-]{11})/.exec(u.pathname);
        id = m?.[1];
      }
    }
    return id && VIDEO_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export const youTubeCategory = (id: unknown): YouTubeCategory => YOUTUBE_CATEGORIES.find((c) => c.id === Number(id)) || YOUTUBE_CATEGORIES[0];

/** Largest thumbnail; portrait ones (the Shorts tabs give 405x720) are preferred for the vertical feed. */
function bestThumb(thumbs: any[] | undefined): string | undefined {
  if (!thumbs?.length) return undefined;
  const score = (t: any) => (Number(t.width) || 0) * (Number(t.height) || 0) + ((Number(t.height) || 0) > (Number(t.width) || 0) ? 1e7 : 0);
  return [...thumbs].sort((a, b) => score(b) - score(a))[0]?.url;
}

/** The @handle of a channel from the fields a flat entry or a video JSON may carry. */
function handleOf(e: any): string | undefined {
  for (const v of [e.uploader_id, e.channel_handle]) if (typeof v === 'string' && v.startsWith('@')) return v.slice(1);
  const url = String(e.uploader_url || e.channel_url || '');
  const m = /youtube\.com\/@([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * One flat-playlist entry (search result, hashtag Shorts tab, channel tab) as a feed item. It has
 * no play URLs yet: the client resolves them (POST /api/resolve) when the video comes into view.
 */
export function entryToFeedItem(e: any): FeedItem | undefined {
  const id = typeof e?.id === 'string' && VIDEO_ID.test(e.id) ? e.id : undefined;
  if (!id) return undefined;
  if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') return undefined;
  const handle = handleOf(e);
  return {
    id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    author: { id: e.channel_id || undefined, uniqueId: handle, nickname: e.channel || e.uploader || undefined },
    desc: e.title || undefined,
    createTime: typeof e.timestamp === 'number' ? e.timestamp : undefined,
    duration: typeof e.duration === 'number' ? e.duration : undefined,
    cover: bestThumb(e.thumbnails),
    stats: { plays: typeof e.view_count === 'number' ? e.view_count : undefined },
    formats: [],
  };
}

const PAGE = 20;

/**
 * A page of a flat listing. `target` is a yt-dlp URL or a `ytsearchN:` spec; yt-dlp walks the
 * continuation pages until it has `offset + count` entries (page 2 costs about a second more).
 */
async function listFlat(target: (n: number) => string, offset: number, count: number, log: (m: string) => void, cookieFile?: string): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const want = offset + count;
  const t0 = Date.now();
  const json = await ytdlpInfo({ url: target(want), flat: true, playlistItems: `${offset + 1}-${want}`, cookieFile }, LIST_TIMEOUT_MS);
  const entries: any[] = Array.isArray(json?.entries) ? json.entries : [];
  const items: FeedItem[] = [];
  for (const e of entries) {
    const it = entryToFeedItem(e);
    if (it && !items.some((x) => x.id === it.id)) items.push(it);
  }
  log(`${target(want)} [${offset + 1}-${want}]: ${entries.length} entries, ${items.length} videos, ${Date.now() - t0} ms`);
  return { items, hasMore: entries.length >= count };
}

/**
 * A page of search results: straight from YouTube's web API (youtubeSearch.ts, under a second),
 * else - that path failed, or YOUTUBE_SEARCH=ytdlp - through yt-dlp as before. `offset` is what the
 * previous page answered (offset + PAGE); the direct path reads it as a page number.
 */
export async function searchYouTube(q: string, offset: number, log: (m: string) => void): Promise<SearchResponse> {
  const t0 = Date.now();
  if (directSearchEnabled()) {
    try {
      const r = await searchDirect(q, offset, PAGE, log);
      const items: FeedItem[] = [];
      for (const e of r.entries) {
        const it = entryToFeedItem(e);
        if (it && !items.some((x) => x.id === it.id)) items.push(it);
      }
      noteDirect();
      log(`search "${q}" [${offset}]: ${items.length} videos direct, ${r.requests} request(s), ${Date.now() - t0} ms`);
      return { q, items, users: [], hasMore: r.hasMore, offset: offset + PAGE, warnings: [], elapsedMs: Date.now() - t0 };
    } catch (e) {
      const reason = (e as Error).message || String(e);
      noteFallback(reason);
      log(`search "${q}" [${offset}]: direct search failed after ${Date.now() - t0} ms (${reason.slice(0, 160)}); asking yt-dlp`);
    }
  }
  const r = await listFlat((n) => `ytsearch${n}:${q}`, offset, PAGE, log);
  return { q, items: r.items, users: [], hasMore: r.hasMore, offset: offset + PAGE, warnings: [], elapsedMs: Date.now() - t0 };
}

/** The Shorts tab of a hashtag (the guest Explore feed); `page` 0 = the first 30. */
export async function exploreYouTube(tag: string, page: number, count: number, log: (m: string) => void): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const safe = tag.replace(/[^\w]/g, '').toLowerCase() || 'shorts';
  return listFlat(() => `https://www.youtube.com/hashtag/${safe}/shorts`, page * count, count, log);
}

/**
 * The signed-in account's recommendations (what youtube.com shows on its home page), through the
 * saved cookies. `offset` walks the "load more" continuations (30 a page); YouTube answers a
 * signed-out visitor with an empty list, which the caller turns into a sign-in check.
 */
export async function recommendedYouTube(offset: number, count: number, cookieFile: string, log: (m: string) => void): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  return listFlat(() => 'https://www.youtube.com/feed/recommended', offset, count, log, cookieFile);
}

/**
 * The signed-in account's recommendations through the code sign-in: the home feed of YouTube's TV
 * API (youtubeTv.ts), plain HTTPS, about 0.4 s a request. Throws TvAuthError when Google no longer
 * accepts the sign-in.
 */
export async function recommendedYouTubeTv(count: number, log: (m: string) => void): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const t0 = Date.now();
  const r = await tvHomeFeed(count, log);
  const items: FeedItem[] = [];
  for (const e of r.entries) {
    const it = entryToFeedItem(e);
    if (it && !items.some((x) => x.id === it.id)) items.push(it);
  }
  log(`home feed (code sign-in): ${r.entries.length} entries, ${items.length} videos, ${r.requests} request(s), ${Date.now() - t0} ms`);
  return { items, hasMore: true };
}

/** A channel's videos (its /videos tab; Shorts live on /shorts and are listed when /videos is empty). */
export async function channelVideos(handle: string, offset: number, count: number, log: (m: string) => void): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const h = handle.replace(/^@/, '');
  if (!/^[\w.\-]{1,64}$/.test(h)) throw new YouTubeError('That is not a YouTube handle', 400);
  const videos = await listFlat(() => `https://www.youtube.com/@${encodeURIComponent(h)}/videos`, offset, count, log).catch((e) => {
    if (/does not exist|not found|404/i.test((e as Error).message)) throw new YouTubeError(`@${h} was not found on YouTube`, 404);
    throw e;
  });
  if (videos.items.length || offset > 0) return videos;
  return listFlat(() => `https://www.youtube.com/@${encodeURIComponent(h)}/shorts`, 0, count, log).catch(() => videos);
}

const MAX_HEIGHT = 720;
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: ResolveResponse }>();
const inFlight = new Map<string, Promise<ResolveResponse>>();

/** `expire=` (unix seconds) of a googlevideo URL */
function urlExpiry(url: string): number | undefined {
  const m = /[?&]expire=(\d{9,11})/.exec(url);
  return m ? Number(m[1]) : undefined;
}

/**
 * The AAC track to play: the original language at the highest bitrate (itag 140, 128 kbps, over
 * 139, 48 kbps). Dubbed videos list 139-0, 140-0, ... per language with the original one marked
 * "original (default)"; a -drc variant (compressed loudness) is avoided.
 */
export function pickAudio(formats: any[]): any | undefined {
  const aac = formats.filter((f) => f.url && (f.vcodec === 'none' || !f.vcodec) && /^mp4a/.test(f.acodec || '') && f.protocol === 'https');
  const score = (f: any): number => (/original/i.test(f.format_note || '') ? 1000 : 0) + (f.format_id === '140' ? 500 : 0) + (Number(f.abr || f.tbr) || 0) - (/drc/i.test(f.format_id || '') ? 10 : 0);
  return aac.sort((a, b) => score(b) - score(a))[0];
}

/** `p`'s outcome, or `late()` thrown after `ms` (p itself goes on). */
function within<T>(p: Promise<T>, ms: number, late: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(late()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Resolves one video: metadata plus proxy URLs for the H.264 video files and the AAC audio file.
 * `cookieFile` (the YouTube sign-in) is used only when the guest extraction is refused (age gate,
 * private video of the account, "sign in to confirm you're not a bot"): the guest path is the
 * measured one, and it keeps the account's cookies out of every ordinary play.
 *
 * Rejects after `waitMs` with a 504 while the lookup goes on: its answer is kept for the next ask.
 */
export async function resolveYouTube(inputUrl: string, log: (m: string) => void, cookieFile?: string, waitMs = RESOLVE_TIMEOUT_MS): Promise<ResolveResponse> {
  const id = youTubeVideoId(inputUrl);
  if (!id) throw new YouTubeError('That is not a YouTube video URL', 400);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let p = inFlight.get(id);
  if (!p) {
    p = resolveUncached(id, inputUrl, log, cookieFile).finally(() => inFlight.delete(id));
    // a lookup that fails after every caller stopped waiting is nobody's unhandled rejection
    p.catch(() => undefined);
    inFlight.set(id, p);
  }
  return within(p, waitMs, () => new YouTubeError(`YouTube took more than ${Math.round(waitMs / 1000)} s for this video; the lookup is still running on the server, so opening it again may play at once`, 504));
}

/** The picture-only H.264 files the player can take (plain https, up to MAX_HEIGHT). */
const h264Files = (formats: any[]): any[] => formats.filter((f) => f.url && /^avc1/.test(f.vcodec || '') && (f.acodec === 'none' || !f.acodec) && f.protocol === 'https' && (f.height || 0) <= MAX_HEIGHT);

/**
 * YouTube's answer to the only player client that works without the player's JavaScript, for a
 * video marked "made for kids" (measured 2026-11-22; yt-dlp names the same limit). Region blocks
 * get the same words, so the note says what is known, not what the video is.
 */
const KIDS_NOTE = ' (YouTube answers this for videos marked "made for kids", which this server cannot play yet)';

function classify(msg: string): YouTubeError {
  if (/This video is not available\s*$/i.test(msg)) return new YouTubeError(msg + KIDS_NOTE, 404);
  if (/private|unavailable|not available|removed|does not exist|age/i.test(msg)) return new YouTubeError(msg, 404);
  if (/sign in|bot|captcha/i.test(msg)) return new YouTubeError(`YouTube refused the request from this server: ${msg}`, 503);
  return new YouTubeError(msg);
}

/** The video's info through yt-dlp: as a guest, then (refused, and time left) with the account's cookies. */
async function infoFromYtDlp(id: string, deadline: number, log: (m: string) => void, cookieFile?: string): Promise<any> {
  const t0 = Date.now();
  const url = `https://www.youtube.com/watch?v=${id}`;
  try {
    return await ytdlpInfo({ url, noplaylist: true, extractorArgs: VIDEO_EXTRACTOR_ARGS }, Math.max(1, deadline - t0));
  } catch (e) {
    const guestErr = classify((e as Error).message);
    log(`youtube ${id}: guest extraction failed after ${Date.now() - t0} ms (${guestErr.message.slice(0, 120)})`);
    if (!cookieFile || deadline - Date.now() < RETRY_MIN_MS) throw guestErr;
    log(`youtube ${id}: retrying with the account's cookies`);
    try {
      return await ytdlpInfo({ url, noplaylist: true, cookieFile, extractorArgs: VIDEO_EXTRACTOR_ARGS }, deadline - Date.now());
    } catch (e2) {
      throw classify((e2 as Error).message);
    }
  }
}

async function resolveUncached(id: string, inputUrl: string, log: (m: string) => void, cookieFile?: string): Promise<ResolveResponse> {
  const t0 = Date.now();
  const deadline = t0 + LOOKUP_TIMEOUT_MS;
  const attempts: ResolveResponse['attempts'] = [];
  let info: any;
  let how = '';
  if (directPlayerEnabled()) {
    try {
      const d = await within(playerInfoDirect(id, log), DIRECT_TIMEOUT_MS, () => new Error(`no answer in ${DIRECT_TIMEOUT_MS / 1000} s`));
      if (!h264Files(d.info.formats).length) throw new Error(`no H.264 video format up to ${MAX_HEIGHT}p among its ${d.info.formats.length} formats`);
      info = d.info;
      how = `direct (${d.client}, ${d.requests} request${d.requests === 1 ? '' : 's'})`;
      notePlayerDirect();
      attempts.push({ resolver: 'native', ok: true, elapsedMs: Date.now() - t0 });
    } catch (e) {
      const reason = (e as Error).message || String(e);
      notePlayerFallback(`${id}: ${reason}`);
      attempts.push({ resolver: 'native', ok: false, error: reason, elapsedMs: Date.now() - t0 });
      log(`youtube ${id}: the direct lookup failed after ${Date.now() - t0} ms (${reason.slice(0, 160)}); asking yt-dlp`);
    }
  }
  if (!info) {
    const t1 = Date.now();
    info = await infoFromYtDlp(id, deadline, log, cookieFile);
    how = 'yt-dlp';
    attempts.push({ resolver: 'ytdlp', ok: true, elapsedMs: Date.now() - t1 });
  }
  const all: any[] = Array.isArray(info.formats) ? info.formats : [];
  const warnings: string[] = [];
  const videoOnly = h264Files(all);
  if (!videoOnly.length) throw new YouTubeError(`No H.264 video format up to ${MAX_HEIGHT}p for ${id} (${all.length} formats)`);
  const audio = pickAudio(all);
  if (!audio) warnings.push('No AAC audio format: the video plays without sound');
  const expiresAt = urlExpiry(videoOnly[0].url);
  const expiryMs = expiresAt ? Math.min(defaultExpiry(), expiresAt * 1000 - 60_000) : defaultExpiry();
  const headers: Record<string, string> = {};
  if (videoOnly[0].http_headers?.['User-Agent']) headers['user-agent'] = videoOnly[0].http_headers['User-Agent'];
  let audioProxyUrl: string | undefined;
  let audioMediaId: string | undefined;
  if (audio) {
    const rec = registerMedia({ url: audio.url, headers, label: `youtube ${id} audio ${audio.format_id}`, source: 'youtube', chunked: true, expiresAt: expiryMs });
    audioProxyUrl = `/api/media/${rec.id}`;
    audioMediaId = rec.id;
  }
  // Highest first (720p, then 480p ...): the feed picks the first H.264 entry.
  videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  const formats: MediaFormat[] = videoOnly.map((f) => {
    const rec = registerMedia({ url: f.url, headers, label: `youtube ${id} ${f.format_id}`, source: 'youtube', chunked: true, expiresAt: expiryMs });
    return {
      id: String(f.format_id),
      label: `${f.width}×${f.height} ${f.format_id} (${f.vcodec}${f.tbr ? `, ${Math.round(f.tbr)} kbps` : ''})${audio ? ' + AAC' : ''}`,
      codec: 'h264',
      codecDetail: f.vcodec,
      width: f.width || undefined,
      height: f.height || undefined,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : undefined,
      proxyUrl: `/api/media/${rec.id}`,
      mediaId: rec.id,
      audioProxyUrl,
      audioMediaId,
      requiresCookies: false,
      expiresAt,
      upstreamHost: new URL(f.url).hostname,
    };
  });
  const resp: ResolveResponse = {
    source: 'youtube',
    resolver: how === 'yt-dlp' ? 'ytdlp' : 'native',
    id,
    inputUrl,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    title: info.title,
    author: handleOf(info) || info.channel || info.uploader,
    duration: typeof info.duration === 'number' ? info.duration : undefined,
    width: info.width,
    height: info.height,
    cover: bestThumb(info.thumbnails) || info.thumbnail,
    formats,
    warnings,
    elapsedMs: Date.now() - t0,
    attempts,
  };
  log(`youtube ${id}: ${formats.map((f) => f.id).join('/')} + audio ${audio?.format_id || 'none'}, ${how}, ${resp.elapsedMs} ms${resp.elapsedMs > RESOLVE_TIMEOUT_MS ? ' (after the viewer stopped waiting; kept for the next ask)' : ''}`);
  cache.set(id, { at: Date.now(), value: resp });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return resp;
}
