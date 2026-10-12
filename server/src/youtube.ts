/**
 * YouTube, guest mode (no sign-in), through yt-dlp:
 *
 *  - search:   `ytsearch<N>:<query>` with --flat-playlist (about 3-4 s a page of 20).
 *  - explore:  the Shorts tab of a hashtag page (youtube.com/hashtag/<tag>/shorts): vertical videos,
 *              about 30 per page in under 3 s. YouTube's Trending page is gone (redirects home).
 *  - channel:  youtube.com/@handle/videos, the same flat listing.
 *  - resolve:  `-j` for one video. YouTube hands guests no muxed format (the 360p one needs a PO
 *              token and answers 403), so the player gets two files: H.264 video (itag 160/133/134/
 *              135/136, 144p-720p) and AAC audio (itag 140), both fragmented MP4, both relayed by
 *              the proxy: googlevideo URLs are bound to the server's IP and carry no CORS header.
 *
 * Measured 2026-10-12 from the dev machine and from the GCP VM (no bot check there for guests).
 */
import type { FeedItem, MediaFormat, ResolveResponse, SearchResponse, YouTubeCategory } from '../../shared/types';
import { YOUTUBE_CATEGORIES } from '../../shared/types';
import { defaultExpiry, registerMedia } from './mediaStore';
import { ytdlp } from './ytdlp';

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
async function listFlat(target: (n: number) => string, offset: number, count: number, log: (m: string) => void): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const want = offset + count;
  const t0 = Date.now();
  const out = await ytdlp(['--flat-playlist', '-J', '--playlist-items', `${offset + 1}-${want}`, target(want)], 60_000);
  const json = JSON.parse(out.trim().split(/\r?\n/).pop()!);
  const entries: any[] = Array.isArray(json?.entries) ? json.entries : [];
  const items: FeedItem[] = [];
  for (const e of entries) {
    const it = entryToFeedItem(e);
    if (it && !items.some((x) => x.id === it.id)) items.push(it);
  }
  log(`${target(want)} [${offset + 1}-${want}]: ${entries.length} entries, ${items.length} videos, ${Date.now() - t0} ms`);
  return { items, hasMore: entries.length >= count };
}

export async function searchYouTube(q: string, offset: number, log: (m: string) => void): Promise<SearchResponse> {
  const t0 = Date.now();
  const r = await listFlat((n) => `ytsearch${n}:${q}`, offset, PAGE, log);
  return { q, items: r.items, users: [], hasMore: r.hasMore, offset: offset + PAGE, warnings: [], elapsedMs: Date.now() - t0 };
}

/** The Shorts tab of a hashtag (the guest Explore feed); `page` 0 = the first 30. */
export async function exploreYouTube(tag: string, page: number, count: number, log: (m: string) => void): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const safe = tag.replace(/[^\w]/g, '').toLowerCase() || 'shorts';
  return listFlat(() => `https://www.youtube.com/hashtag/${safe}/shorts`, page * count, count, log);
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

/** Resolves one video: metadata plus proxy URLs for the H.264 video files and the AAC audio file. */
export async function resolveYouTube(inputUrl: string, log: (m: string) => void): Promise<ResolveResponse> {
  const id = youTubeVideoId(inputUrl);
  if (!id) throw new YouTubeError('That is not a YouTube video URL', 400);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let p = inFlight.get(id);
  if (!p) {
    p = resolveUncached(id, inputUrl, log).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return p;
}

async function resolveUncached(id: string, inputUrl: string, log: (m: string) => void): Promise<ResolveResponse> {
  const t0 = Date.now();
  let out: string;
  try {
    out = await ytdlp(['-j', '--no-playlist', `https://www.youtube.com/watch?v=${id}`], 90_000);
  } catch (e) {
    const msg = (e as Error).message;
    if (/private|unavailable|not available|removed|does not exist|age/i.test(msg)) throw new YouTubeError(msg, 404);
    if (/sign in|bot|captcha/i.test(msg)) throw new YouTubeError(`YouTube refused the request from this server: ${msg}`, 503);
    throw new YouTubeError(msg);
  }
  const info = JSON.parse(out.trim().split(/\r?\n/).pop()!);
  const all: any[] = Array.isArray(info.formats) ? info.formats : [];
  const warnings: string[] = [];
  const videoOnly = all.filter((f) => f.url && /^avc1/.test(f.vcodec || '') && (f.acodec === 'none' || !f.acodec) && f.protocol === 'https' && (f.height || 0) <= MAX_HEIGHT);
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
    resolver: 'ytdlp',
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
    attempts: [{ resolver: 'ytdlp', ok: true, elapsedMs: Date.now() - t0 }],
  };
  log(`youtube ${id}: ${formats.map((f) => f.id).join('/')} + audio ${audio?.format_id || 'none'}, ${resp.elapsedMs} ms`);
  cache.set(id, { at: Date.now(), value: resp });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return resp;
}
