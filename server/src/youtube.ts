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
import { config } from './config';
import { openUpstream } from './http';
import { defaultExpiry, registerMedia } from './mediaStore';
import { ytdlpInfo, ytdlpJsRuntime } from './ytdlp';
import { currentActivity, followActivity, say, track, type Act } from './activity';
import { DirectPlayerError, directPlayerEnabled, notePlayerDirect, notePlayerFallback, playerClient, playerInfoDirect } from './youtubePlayer';
import { avatarIfKnown, avatarKept, channelAvatar, pickAvatar, rememberAvatar } from './youtubeAvatar';
import { directSearchEnabled, noteDirect, noteFallback, searchDirect } from './youtubeSearch';
import { tvBearer, tvHomeFeed } from './youtubeTv';

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
const RESOLVE_TIMEOUT_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 120_000;
/**
 * How long a video's files may stay refused after a yt-dlp lookup before the lookup fails. The
 * TV client (the route for "made for kids" videos, with Deno) is shown an ad before the video,
 * and YouTube's file server answers 403 for every byte range until that ad's time is over
 * (measured 2026-11-22 on the PC and the VM: "30s ad" = the files opened 21 s after a 7 s
 * lookup; "23s ad skippable after 5s" = open at once; yt-dlp's debug log names the ad). The same
 * address opens by itself; a new lookup would start the ad clock again. So the first file is
 * asked for two bytes until it answers, and the viewer is told what the wait is.
 */
const AD_WAIT_MS = 75_000;
/** ...asked again this often meanwhile */
const AD_CHECK_EVERY_MS = 2_500;
/** One byte range of a file is asked for at most this long when its address is checked */
const CHECK_TIMEOUT_MS = 6_000;
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
  // The channel's picture: a search result carries it (kept for the channel's other videos); the
  // other listings do not, so a picture learned earlier is used and the feed asks for the rest
  // when a video comes into view (POST /api/avatar).
  const channel = { channelId: e.channel_id || undefined, handle, videoId: id };
  const carried = pickAvatar(e.channel_thumbnails);
  if (carried) rememberAvatar(channel, carried);
  return {
    id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    author: { id: e.channel_id || undefined, uniqueId: handle, nickname: e.channel || e.uploader || undefined, avatar: carried || avatarIfKnown(channel) },
    desc: e.title || undefined,
    createTime: typeof e.timestamp === 'number' ? e.timestamp : undefined,
    duration: typeof e.duration === 'number' ? e.duration : undefined,
    cover: bestThumb(e.thumbnails),
    stats: { plays: typeof e.view_count === 'number' ? e.view_count : undefined },
    formats: [],
  };
}

const PAGE = 20;

/** A listing target in a few words for the status line ("search tesla", "hashtag/funny/shorts", "@handle/videos"). */
function listName(target: string): string {
  const s = /^ytsearch\d+:(.*)$/.exec(target);
  if (s) return `search "${s[1].slice(0, 40)}"`;
  try {
    return decodeURIComponent(new URL(target).pathname).replace(/^\//, '').slice(0, 60) || target;
  } catch {
    return target.slice(0, 60);
  }
}

/**
 * A page of a flat listing. `target` is a yt-dlp URL or a `ytsearchN:` spec; yt-dlp walks the
 * continuation pages until it has `offset + count` entries (page 2 costs about a second more).
 */
async function listFlat(target: (n: number) => string, offset: number, count: number, log: (m: string) => void, cookieFile?: string): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const want = offset + count;
  const t0 = Date.now();
  say(`asking yt-dlp for the list (${listName(target(want))}, entries ${offset + 1}-${want}): usually 3-4 s, longer on a busy server`);
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
      say(`asking YouTube's search directly${offset ? ' for the next page' : ''} (under a second when it answers)`);
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
      say(`the direct search failed (${reason.slice(0, 80)}): asking yt-dlp instead`);
    }
  }
  const r = await listFlat((n) => `ytsearch${n}:${q}`, offset, PAGE, log);
  return { q, items: r.items, users: [], hasMore: r.hasMore, offset: offset + PAGE, warnings: [], elapsedMs: Date.now() - t0 };
}

/**
 * Feed items on their way out, each with its channel's picture where the server has one kept
 * (30 days, youtubeAvatar.ts): the picture is on screen with the video, without a request of its
 * own. Items in stock were listed before their pictures were learned, so this is done at the
 * door; the stocked items are not changed.
 */
export function withYouTubeAvatars<T extends FeedItem>(items: T[], log: (m: string) => void = () => undefined): T[] {
  return items.map((it) => {
    if (it.author?.avatar) return it;
    // (a kept picture older than a day goes out as it is and is checked behind this answer)
    const avatar = avatarKept({ channelId: it.author?.id, handle: it.author?.uniqueId, videoId: it.id }, log);
    return avatar ? { ...it, author: { ...it.author, avatar } } : it;
  });
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
  say("reading your YouTube home feed through the code sign-in (YouTube's TV app API)");
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
const inFlight = new Map<string, { p: Promise<ResolveResponse>; act?: Act }>();

// ---------------------------------------------------------------- the slow route's lane
/**
 * The slow route (yt-dlp; with Deno for a "made for kids" video) runs one video at a time, the
 * one a viewer is looking at first.
 *
 * Seen on the VM, 2026-11-22/23: one such lookup takes 7-13 s alone, but the feed asks for the
 * next videos ahead of time and a kids' feed is all slow-route videos, so two ran side by side in
 * the two yt-dlp helpers (42 s each instead of 2 x 10) while the video on screen waited behind
 * them for a helper - past the viewer's 60 s ("HTTP 504"). In line, each takes its 10 s, and the
 * video in view goes before the ones asked ahead. YOUTUBE_SLOW_LOOKUPS=2 gives a bigger server
 * two lanes.
 */
const SLOW_LANES = Math.max(1, Number(process.env.YOUTUBE_SLOW_LOOKUPS) || 1);
interface SlowTurn {
  id: string;
  go: () => void;
}
const slowQueue: SlowTurn[] = [];
let slowRunning = 0;
/** Videos a viewer is looking at (asked for without `ahead`), until their lookup settles */
const wanted = new Set<string>();
/** Called when a slow lookup starts: the server frees what memory it can for it (index.ts) */
let makeRoom: (() => void) | undefined;
export function setYouTubeRoomMaker(fn: (() => void) | undefined): void {
  makeRoom = fn;
}

/** Slow lookups running and waiting in line, for /api/health and the "what is the server busy with" lists. */
export const youtubeSlowLookups = (): { running: number; queued: number; asAccount: number; asGuest: number; lastAccountFailure?: { at: string; reason: string } } => ({ running: slowRunning, queued: slowQueue.length, ...slowStats });

/** The next in line: the video a viewer asked for last, else the one asked ahead the longest ago. */
function nextSlowTurn(): SlowTurn | undefined {
  if (!slowQueue.length) return undefined;
  let at = 0;
  for (let i = slowQueue.length - 1; i >= 0; i--) {
    if (wanted.has(slowQueue[i].id)) {
      at = i;
      break;
    }
  }
  return slowQueue.splice(at, 1)[0];
}

/** Waits for the lane; the returned function gives it up (calling it twice is fine). */
async function slowTurn(id: string): Promise<() => void> {
  if (slowRunning < SLOW_LANES) slowRunning++;
  else {
    const ahead = slowQueue.length + slowRunning;
    say(`the slow route takes one video at a time on this server: ${ahead} lookup${ahead === 1 ? '' : 's'} before this one (the video on screen goes first)`, ahead === 1 ? "waiting for another video's lookup to end" : `waiting for ${ahead} other lookups to end`);
    await new Promise<void>((go) => slowQueue.push({ id, go }));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = nextSlowTurn();
    if (next) next.go();
    else slowRunning--;
  };
}

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
 *
 * `ahead`: the feed is getting an upcoming video ready; without it a viewer is looking at this
 * video, and a slow-route lookup for it goes before the ones asked ahead (also when it was first
 * asked ahead and is asked again now).
 */
export async function resolveYouTube(inputUrl: string, log: (m: string) => void, cookieFile?: string, waitMs = RESOLVE_TIMEOUT_MS, opts: { ahead?: boolean } = {}): Promise<ResolveResponse> {
  const id = youTubeVideoId(inputUrl);
  if (!id) throw new YouTubeError('That is not a YouTube video URL', 400);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (!opts.ahead) wanted.add(id);
  let running = inFlight.get(id);
  if (running) {
    say('this video is already being looked up for an earlier request: waiting for that answer', 'waiting for the lookup to end');
    // ...and from here on this request says what that lookup is doing
    followActivity(running.act);
  } else {
    // An activity of its own: the lookup goes on (and stays listed) after this caller's wait is over.
    let act: Act | undefined;
    const p = track(`Looking up YouTube video ${id}`, { platform: 'youtube' }, () => {
      act = currentActivity();
      return resolveUncached(id, inputUrl, log, cookieFile);
    }).finally(() => {
      inFlight.delete(id);
      wanted.delete(id);
    });
    // a lookup that fails after every caller stopped waiting is nobody's unhandled rejection
    p.catch(() => undefined);
    running = { p, act };
    inFlight.set(id, running);
  }
  return within(running.p, waitMs, () => new YouTubeError(`YouTube took more than ${Math.round(waitMs / 1000)} s for this video; the lookup is still running on the server, so opening it again may play at once`, 504));
}

/** The picture-only H.264 files the player can take (plain https, up to MAX_HEIGHT). */
const h264Files = (formats: any[]): any[] => formats.filter((f) => f.url && /^avc1/.test(f.vcodec || '') && (f.acodec === 'none' || !f.acodec) && f.protocol === 'https' && (f.height || 0) <= MAX_HEIGHT);

/**
 * YouTube's answer to the only player client that works without the player's JavaScript, for a
 * video marked "made for kids" (measured 2026-11-22; yt-dlp names the same limit). Region blocks
 * get the same words, so the note says what is known, not what the video is.
 */
const KIDS_NOTE = ' (YouTube answers this for videos marked "made for kids": playing them needs Deno and the yt-dlp-ejs package on the server, see deploy/gcp/setup-vm.sh)';

function classify(msg: string): YouTubeError {
  // With a JS runtime yt-dlp has tried the clients that do play those videos: the words are then YouTube's whole answer.
  if (/This video is not available\s*$/i.test(msg) && !ytdlpJsRuntime()) return new YouTubeError(msg + KIDS_NOTE, 404);
  if (/private|unavailable|not available|removed|does not exist|age/i.test(msg)) return new YouTubeError(msg, 404);
  if (/sign in|bot|captcha/i.test(msg)) return new YouTubeError(`YouTube refused the request from this server: ${msg}`, 503);
  return new YouTubeError(msg);
}

/**
 * Whether YouTube's file server refuses this format's address outright (403 for its first two
 * bytes). Anything else - an answer, a timeout, a network error - is "not refused": the player
 * finds out, as before.
 */
async function fileRefused(f: any): Promise<boolean> {
  try {
    const headers: Record<string, string> = { range: 'bytes=0-1' };
    if (f.http_headers?.['User-Agent']) headers['user-agent'] = f.http_headers['User-Agent'];
    const { res, status } = await openUpstream(f.url, { allowlist: config.proxyAllowedHosts, maxRedirects: 3, headers, timeoutMs: CHECK_TIMEOUT_MS });
    res.destroy();
    return status === 403;
  } catch {
    return false;
  }
}
/** Tests: replaces the address check (undefined restores it). */
let refusedCheck: (f: any) => Promise<boolean> = fileRefused;
export function setYouTubeFileCheck(check: ((f: any) => Promise<boolean>) | undefined): void {
  refusedCheck = check || fileRefused;
}

/**
 * yt-dlp asking as the signed-in account (the code sign-in, youtubeTv.ts): YouTube's TV player
 * client in the older version yt-dlp calls "tv_downgraded", with the account's token on the
 * request, and nothing else asked (the watch page and its data go through the web client, which
 * answers a TV token with HTTP 400).
 *
 * Measured on the VM, 2026-11-23, when YouTube answered its address "Sign in to confirm you're not
 * a bot" for every guest client that plays a "made for kids" video (tv_samsung, web; a visitor id
 * changed nothing):
 *  - TVHTML5 with the token, asked directly: playable, but 26 formats without an address (SABR only)
 *  - yt-dlp player_client=tv with the token: the same, "missing a URL"
 *  - yt-dlp player_client=tv_downgraded with the token: 23 formats in 5.8 s (Deno included), and
 *    the file answered 206 at once - no ad time to wait out, unlike the guest's TV route
 *  - the token on every request of an ordinary extraction: HTTP 400 "invalid argument" (web client)
 * The answer names no title (the feed has it from its listing).
 */
const SIGNED_IN_ARGS = { youtube: { ...VIDEO_EXTRACTOR_ARGS.youtube, player_client: ['tv_downgraded'], player_skip: ['webpage', 'configs', 'initial_data'] } };

/** How the slow route's lookups went (for /api/health) */
const slowStats = { asAccount: 0, asGuest: 0, lastAccountFailure: undefined as { at: string; reason: string } | undefined };

/** Tests: the yt-dlp call and the code sign-in's token (undefined restores each). */
let askYtDlp: typeof ytdlpInfo = ytdlpInfo;
let accountToken: () => Promise<string | undefined> = tvBearer;
export function setYouTubeLookupHooks(hooks: { ytdlp?: typeof ytdlpInfo; token?: () => Promise<string | undefined> } = {}): void {
  askYtDlp = hooks.ytdlp || ytdlpInfo;
  accountToken = hooks.token || tvBearer;
}

const BOT_CHECK = /sign in to confirm you.re not a bot/i;

/**
 * The video's info through yt-dlp.
 *
 * `skipClient`: a player client that already said it has no stream for this video (the direct
 * lookup's: "made for kids", an age gate). Such a video is asked for as the signed-in account
 * first when there is a code sign-in - the quicker route, and the one YouTube does not put a bot
 * check or an ad's wait in front of. Otherwise, and when that fails: as a guest (with a JS runtime
 * yt-dlp has other clients and need not ask the refused one again), then - refused, and time left -
 * with the account's cookies, then as the account when that was not tried yet.
 */
async function infoFromYtDlp(id: string, deadline: number, log: (m: string) => void, cookieFile?: string, skipClient?: string): Promise<any> {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const left = (): number => deadline - Date.now();
  let triedAccount = false;
  /** undefined: no code sign-in (or no time left); throws what yt-dlp said otherwise */
  const asAccount = async (why: string): Promise<any | undefined> => {
    if (triedAccount || left() < RETRY_MIN_MS) return undefined;
    const token = await accountToken().catch(() => undefined);
    if (!token) return undefined;
    triedAccount = true;
    const t1 = Date.now();
    say(`${why}: asking YouTube as your account (the sign-in with a code), through yt-dlp and Deno (about 6 s on the small server)`, 'asking YouTube as your account');
    try {
      const info = await askYtDlp({ url, noplaylist: true, extractorArgs: SIGNED_IN_ARGS, headers: { Authorization: `Bearer ${token}` } }, Math.max(1, left()));
      slowStats.asAccount++;
      log(`youtube ${id}: looked up as the signed-in account in ${Date.now() - t1} ms`);
      return info;
    } catch (e) {
      const reason = ((e as Error).message || String(e)).slice(0, 200);
      slowStats.lastAccountFailure = { at: new Date().toISOString(), reason: `${id}: ${reason}` };
      log(`youtube ${id}: the lookup as the signed-in account failed after ${Date.now() - t1} ms (${reason.slice(0, 120)})`);
      throw e;
    }
  };
  if (skipClient) {
    const info = await asAccount(`YouTube gives a guest's ${skipClient} app no stream for this video`).catch(() => undefined);
    if (info) return info;
    if (triedAccount) say('the lookup as your account failed: asking YouTube as a guest (yt-dlp, the slow route: 10-40 s)', 'asking YouTube as a guest');
  }
  const extractorArgs = skipClient && ytdlpJsRuntime() ? { youtube: { ...VIDEO_EXTRACTOR_ARGS.youtube, player_client: ['default', `-${skipClient}`] } } : VIDEO_EXTRACTOR_ARGS;
  const t1 = Date.now();
  try {
    const info = await askYtDlp({ url, noplaylist: true, extractorArgs }, Math.max(1, left()));
    slowStats.asGuest++;
    return info;
  } catch (e) {
    let last = classify((e as Error).message);
    log(`youtube ${id}: guest extraction failed after ${Date.now() - t1} ms (${last.message.slice(0, 120)})`);
    if (cookieFile && left() >= RETRY_MIN_MS) {
      log(`youtube ${id}: retrying with the account's cookies`);
      say(`YouTube refused the guest request (${last.message.slice(0, 80)}): trying again with your signed-in cookies`, 'trying again with your sign-in');
      try {
        return await askYtDlp({ url, noplaylist: true, cookieFile, extractorArgs }, left());
      } catch (e2) {
        last = classify((e2 as Error).message);
      }
    }
    try {
      const info = await asAccount(`YouTube refused the guest request (${last.message.slice(0, 60)})`);
      if (info) return info;
    } catch {
      /* logged above; the guest's refusal is the answer */
    }
    // (no sign-in to ask with: the viewer can add one)
    if (!triedAccount && !cookieFile && BOT_CHECK.test(last.message)) {
      throw new YouTubeError(`${last.message.replace(/\s*Use --cookies[\s\S]*$/, '')} Signing in to YouTube in this app (Profile, "Sign in with a code") lets the server ask for such videos as your account.`, last.status);
    }
    throw last;
  }
}

/** Tests: replaces the slow route's yt-dlp lookup (undefined restores it). */
let slowInfo: (id: string, deadline: number, log: (m: string) => void, cookieFile?: string, skipClient?: string) => Promise<any> = infoFromYtDlp;
export function setYouTubeSlowInfo(fn: ((id: string) => Promise<any>) | undefined): void {
  slowInfo = fn ? (id) => fn(id) : infoFromYtDlp;
}

async function resolveUncached(id: string, inputUrl: string, log: (m: string) => void, cookieFile?: string): Promise<ResolveResponse> {
  const t0 = Date.now();
  const attempts: ResolveResponse['attempts'] = [];
  let info: any;
  let how = '';
  /** The direct lookup's client, when YouTube told it there is no stream for it (made for kids, age gate, region) */
  let unplayableFor: string | undefined;
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
      if (e instanceof DirectPlayerError && e.kind === 'unplayable') unplayableFor = playerClient().name;
      notePlayerFallback(`${id}: ${reason}`);
      attempts.push({ resolver: 'native', ok: false, error: reason, elapsedMs: Date.now() - t0 });
      log(`youtube ${id}: the direct lookup failed after ${Date.now() - t0} ms (${reason.slice(0, 160)}); asking yt-dlp`);
      const js = ytdlpJsRuntime();
      say(
        unplayableFor
          ? js
            ? `YouTube gives its ${unplayableFor} app no stream for this video ("${reason.slice(0, 60)}"): asking yt-dlp, which runs YouTube's player script with Deno (the slow route: 10-40 s)`
            : `YouTube gives its ${unplayableFor} app no stream for this video ("${reason.slice(0, 60)}"): asking yt-dlp (no JS runtime on this server, so it will likely get the same answer)`
          : `the direct lookup failed (${reason.slice(0, 80)}): asking yt-dlp instead (the slow route: 2 s on a PC, 7-25 s on the small server)`,
        'taking the slow route',
      );
    }
  } else say('direct lookups are switched off (YOUTUBE_PLAYER=ytdlp): asking yt-dlp');
  if (!info) {
    // One slow lookup at a time, the viewer's first (see slowTurn); its time limit starts with its turn.
    const queuedAt = Date.now();
    const done = await slowTurn(id);
    const t1 = Date.now();
    if (t1 - queuedAt > 1000) log(`youtube ${id}: waited ${t1 - queuedAt} ms for the slow route's turn`);
    const deadline = t1 + LOOKUP_TIMEOUT_MS;
    try {
      makeRoom?.();
    } catch {
      /* freeing memory is a favour, never a failure */
    }
    try {
      info = await slowInfo(id, deadline, log, cookieFile, unplayableFor);
    } finally {
      // (the wait for YouTube's ad time below is a few bytes every 2.5 s: the next video's lookup need not wait for it)
      done();
    }
    how = 'yt-dlp';
    // the file the player starts with (the highest H.264 one), asked for its first bytes
    const first = h264Files(Array.isArray(info.formats) ? info.formats : []).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (first) {
      say(`checking that YouTube's file server hands out the video (${String(first.format_id)} at ${new URL(first.url).hostname})`, 'checking the video file');
      const held = Date.now();
      let checks = 1;
      while (await refusedCheck(first)) {
        const waited = Date.now() - held;
        if (waited >= AD_WAIT_MS || deadline - Date.now() < AD_CHECK_EVERY_MS + CHECK_TIMEOUT_MS) {
          log(`youtube ${id}: the files stayed refused (403) for ${Math.round(waited / 1000)} s after the lookup`);
          attempts.push({ resolver: 'ytdlp', ok: false, error: "YouTube's file server kept refusing the files (HTTP 403)", elapsedMs: Date.now() - t1 });
          throw new YouTubeError(
            `YouTube's file server kept refusing this video's files (HTTP 403) for ${Math.round(waited / 1000)} s after it handed out their addresses. It holds a video back while the ad it would play first runs (up to about 30 s as measured); this one stayed closed longer. Opening the video again starts over`,
            502,
          );
        }
        if (checks === 1) log(`youtube ${id}: the files are refused (403) right after the lookup: waiting for YouTube's ad time to pass`);
        say(`YouTube keeps this video's files closed for the length of the ad its TV app would play first (5 to 30 s as measured): waiting for them to open, ${Math.round(waited / 1000)} s so far`, 'waiting for YouTube to release it');
        await new Promise((r) => setTimeout(r, AD_CHECK_EVERY_MS));
        checks++;
      }
      if (checks > 1) {
        how = `yt-dlp (files opened ${Math.round((Date.now() - held) / 1000)} s after the lookup: YouTube's ad time)`;
        log(`youtube ${id}: the files opened ${Math.round((Date.now() - held) / 1000)} s after the lookup`);
      }
    }
    attempts.push({ resolver: 'ytdlp', ok: true, elapsedMs: Date.now() - t1 });
  }
  const all: any[] = Array.isArray(info.formats) ? info.formats : [];
  say(`YouTube answered with ${all.length} formats: picking the H.264 picture and AAC sound files`, 'picking the files');
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
  // The channel's picture is not in any lookup answer: the one kept from earlier goes along; else
  // it is asked for now, off the viewer's path, so the feed's own ask (POST /api/avatar) finds it.
  const channelRef = { channelId: typeof info.channel_id === 'string' ? info.channel_id : undefined, handle: handleOf(info), videoId: id };
  if (!avatarIfKnown(channelRef)) void channelAvatar(channelRef, log);
  const resp: ResolveResponse = {
    source: 'youtube',
    resolver: how.startsWith('yt-dlp') ? 'ytdlp' : 'native',
    id,
    inputUrl,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    // (yt-dlp makes up "youtube video #<id>" when the answer names no title: the feed's own stays)
    title: typeof info.title === 'string' && !/^youtube video #/i.test(info.title) ? info.title : undefined,
    author: handleOf(info) || info.channel || info.uploader,
    authorAvatar: avatarIfKnown(channelRef),
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
