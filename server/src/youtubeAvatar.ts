/**
 * A YouTube channel's profile picture (the avatar next to a video), over plain HTTPS: one request
 * of half a kilobyte per channel, signed out. No Python, no browser.
 *
 * Why: no YouTube source of the feed carries the picture. yt-dlp's flat entries, the TV home tiles
 * and the player answer name the channel only (the `visionos` player answer has no endscreen, no
 * cards and no microformat: no yt3 address anywhere in it). Web search results do carry it
 * (videoRenderer.channelThumbnailSupportedRenderers.channelThumbnailWithLinkRenderer.thumbnail):
 * rememberAvatar() keeps those, so a channel seen in a search costs no request here.
 *
 * Measured 2026-11-23 from the dev PC (Rick Astley, Cocomelon, PBS KIDS; "made for kids" channels
 * answer like any other):
 *
 *   request                                             gzipped      JSON/HTML   time
 *   browse (WEB), fields= mask                          0.5-0.9 KB   1.2-2.1 KB  0.21-0.49 s   <- used
 *   next (WEB, by video id), fields= mask               0.5 KB       1.2 KB      0.66-0.70 s   <- used without a channel id
 *   navigation/resolve_url (@handle -> channel id)      0.1 KB       0.1 KB      0.10 s        <- used for a handle alone
 *   browse (WEB), whole answer                          134 KB       1.29 MB     0.45 s
 *   browse (WEB), "search in channel" tab, whole        8.9 KB       40 KB       0.20 s
 *   browse (TVHTML5), whole answer                      not gzipped  690 KB      0.44 s
 *   next (WEB), whole answer                            66 KB        480 KB      0.68 s
 *   GET /channel/UC... or /@handle (og:image)           405 KB       2.28 MB     0.50 s (og:image 0.9 MB in, after 270 KB gzipped)
 *   GET /embed/<video>                                  64 KB        150 KB      0.17 s (no channel picture in it)
 *   oEmbed                                              0.5 KB       0.9 KB      0.19 s (no picture; a channel address answers 404)
 *
 * The `fields=` query parameter is Google's partial-response mask; youtubei honours it on browse,
 * next, search and resolve_url (`$fields=` and the X-Goog-FieldMask header do the same). The server
 * still builds the whole answer (the time does not change), but sends and we parse 1-2 KB instead
 * of 1.3 MB. Should YouTube stop honouring the mask, the whole answer arrives and the parser reads
 * the same paths in it; the log says so once an answer is larger than expected.
 *
 * Where the picture is:
 *  - browse: header.pageHeaderRenderer.content.pageHeaderViewModel.image.decoratedAvatarViewModel
 *    .avatar.avatarViewModel.image.sources (72, 120, 160 px) and
 *    metadata.channelMetadataRenderer.avatar.thumbnails (one, 900 px).
 *  - next: contents.twoColumnWatchNextResults.results.results.contents[]
 *    .videoSecondaryInfoRenderer.owner.videoOwnerRenderer.thumbnail.thumbnails (48, 88, 176 px),
 *    with the channel id and @handle beside it (navigationEndpoint.browseEndpoint).
 * The size is the `=s<N>` part of the address and any size is served, so a picture outside
 * 88-176 px is asked for at 176 px.
 *
 * A channel id that does not exist and an auto-generated "Topic" channel answer `{"header":{}}`:
 * no picture. With a video id the watch data is asked next (not tried against a Topic video).
 *
 * Not measured from the VM (a datacenter address). browse and next took no visitor id and no
 * cookie here, and no consent page stands in front of the API; a refusal there shows in the log
 * and in youtubeAvatarStatus().lastFailure, and costs nothing else (the feed shows no picture).
 */
import * as zlib from 'node:zlib';
import { openUpstream, readBody } from './http';
import { youtubeSearchStatus } from './youtubeSearch';

const API = 'https://www.youtube.com/youtubei/v1';
const HOSTS = ['www.youtube.com'];
/** One lookup (all its requests) gives up after this long */
const LOOKUP_TIMEOUT_MS = 5_000;
const KEEP_MS = 24 * 60 * 60 * 1000;
const FAILED_KEEP_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_RUNNING = 2;
/** The feed draws the picture at 40-60 px; these sizes stay sharp at twice that */
const WANT_MIN = 88;
const WANT_MAX = 176;
/** A masked answer is 1-2 KB; a larger one means the mask is not applied */
const MASKED_ANSWER_MAX = 64 * 1024;

const BROWSE_FIELDS = 'metadata(channelMetadataRenderer(externalId,vanityChannelUrl,avatar)),header(pageHeaderRenderer(content(pageHeaderViewModel(image))))';
const NEXT_FIELDS = 'contents(twoColumnWatchNextResults(results(results(contents(videoSecondaryInfoRenderer(owner(videoOwnerRenderer(thumbnail,navigationEndpoint(browseEndpoint)))))))))';
const RESOLVE_FIELDS = 'endpoint(browseEndpoint(browseId))';

/** What is known about a video's channel; any one of the three is enough. */
export interface AvatarRef {
  /** UC… (videoDetails.channelId of a player answer, channel_id of a flat entry) */
  channelId?: string;
  /** "@name", "name" or the channel page's address */
  handle?: string;
  videoId?: string;
}

// ---------------------------------------------------------------- parsing (pure)

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;
const SIZE_TOKEN = /=s(\d+)(?=-|\?|$)/;

/** "@Name", "Name", "/@Name" and "https://www.youtube.com/@Name/videos" -> "Name"; undefined for anything else. */
export function cleanHandle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  let name = /(?:^|\/)@([^/?#\s]+)/.exec(s)?.[1];
  if (!name && /^[^/@?#\s]+$/.test(s) && !CHANNEL_ID.test(s)) name = s;
  if (!name) return undefined;
  try {
    name = decodeURIComponent(name);
  } catch {
    // a stray % in a handle: kept as it is
  }
  return name.length <= 100 ? name : undefined;
}

/** An image address of Google's picture hosts with its scheme filled in; undefined for anything else. */
function pictureUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const s = raw.startsWith('//') ? 'https:' + raw : raw.replace(/^http:\/\//, 'https://');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !/(^|\.)(ggpht|googleusercontent)\.com$/.test(u.hostname)) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

/**
 * The picture to show out of a list of thumbnails ({ url, width }): the largest one of 88-176 px;
 * without one, the nearest size, asked for at 176 px when the address carries its size (`=s900-…`).
 * The size in the address counts before the declared width (search results declare 68 for `=s88`).
 */
export function pickAvatar(thumbnails: unknown): string | undefined {
  if (!Array.isArray(thumbnails)) return undefined;
  const all: { url: string; size: number }[] = [];
  for (const t of thumbnails) {
    const url = pictureUrl(t?.url);
    if (!url) continue;
    const inUrl = Number(SIZE_TOKEN.exec(url)?.[1]);
    all.push({ url, size: inUrl || Number(t?.width) || 0 });
  }
  if (!all.length) return undefined;
  const fits = all.filter((t) => t.size >= WANT_MIN && t.size <= WANT_MAX).sort((a, b) => b.size - a.size)[0];
  if (fits) return fits.url;
  const larger = all.filter((t) => t.size > WANT_MAX).sort((a, b) => a.size - b.size)[0];
  const best = larger || [...all].sort((a, b) => b.size - a.size)[0];
  return SIZE_TOKEN.test(best.url) ? best.url.replace(SIZE_TOKEN, `=s${WANT_MAX}`) : best.url;
}

const attr = (s: string): string => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** The owner block of a watch answer (youtubei/v1/next). */
function videoOwner(json: any): any {
  const contents = json?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
  if (!Array.isArray(contents)) return undefined;
  for (const c of contents) {
    const owner = c?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
    if (owner) return owner;
  }
  return undefined;
}

/**
 * The channel's picture out of an answer: the JSON of a channel's browse answer (web or TV client,
 * masked or whole), of a watch answer (next), one search result (a videoRenderer), or the HTML of a
 * channel page (og:image). Only the places that hold this channel's own picture are read (a
 * channel page is full of other channels' pictures). undefined when there is none.
 */
export function avatarFromAnswer(answer: unknown): string | undefined {
  if (typeof answer === 'string') {
    const s = answer.trimStart();
    if (s.startsWith('{')) {
      try {
        return avatarFromAnswer(JSON.parse(s));
      } catch {
        return undefined;
      }
    }
    const m = /<meta\s+property="og:image"\s+content="([^"]+)"/.exec(answer) || /<link\s+rel="image_src"\s+href="([^"]+)"/.exec(answer);
    return m ? pickAvatar([{ url: attr(m[1]) }]) : undefined;
  }
  const j = answer as any;
  if (!j || typeof j !== 'object') return undefined;
  const lists: unknown[] = [
    j.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources,
    j.header?.c4TabbedHeaderRenderer?.avatar?.thumbnails,
    j.metadata?.channelMetadataRenderer?.avatar?.thumbnails,
    j.microformat?.microformatDataRenderer?.thumbnail?.thumbnails,
    j.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.header?.channelHeaderRenderer?.avatar?.thumbnails,
    videoOwner(j)?.thumbnail?.thumbnails,
    j.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails,
    j.videoRenderer?.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails,
    j.avatar?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources,
  ];
  return pickAvatar(lists.flatMap((l) => (Array.isArray(l) ? l : [])));
}

/** The channel an answer is about (browse, next or navigation/resolve_url): its id and handle, as far as it says. */
export function channelFromAnswer(json: any): { channelId?: string; handle?: string } {
  const meta = json?.metadata?.channelMetadataRenderer;
  const browse = videoOwner(json)?.navigationEndpoint?.browseEndpoint || json?.endpoint?.browseEndpoint;
  const id = [meta?.externalId, browse?.browseId].find((v) => typeof v === 'string' && CHANNEL_ID.test(v));
  const handle = [meta?.vanityChannelUrl, browse?.canonicalBaseUrl].map((v) => (typeof v === 'string' && v.includes('@') ? cleanHandle(v) : undefined)).find(Boolean);
  return { channelId: id, handle };
}

// ---------------------------------------------------------------- network

/** The three requests a lookup may send, each answering the parsed JSON; tests replace them. */
export interface AvatarTransport {
  /** The channel's page data, narrowed to its picture (youtubei/v1/browse) */
  browse(channelId: string): Promise<any>;
  /** A video's watch data, narrowed to its owner (youtubei/v1/next) */
  next(videoId: string): Promise<any>;
  /** What a channel page address leads to: the channel id of an @handle (youtubei/v1/navigation/resolve_url) */
  resolve(handle: string): Promise<any>;
}

let warnedUnmasked = false;
let logLine: (m: string) => void = () => undefined;

async function post(endpoint: string, fields: string, body: Record<string, unknown>): Promise<any> {
  // the web client version the search keeps fresh (youtubeSearch.ts); any recent one is accepted
  const clientVersion = youtubeSearchStatus().clientVersion;
  const data = JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } }, ...body });
  const { res, status } = await openUpstream(`${API}/${endpoint}?prettyPrint=false&fields=${encodeURIComponent(fields)}`, {
    method: 'POST',
    body: data,
    headers: {
      'content-type': 'application/json',
      'accept-encoding': 'gzip',
      origin: 'https://www.youtube.com',
      'x-youtube-client-name': '1',
      'x-youtube-client-version': clientVersion,
    },
    allowlist: HOSTS,
    timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  let buf = await readBody(res, 4 * 1024 * 1024);
  if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
  const text = buf.toString('utf8');
  if (status !== 200) throw new Error(`YouTube answered ${status}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  if (text.length > MASKED_ANSWER_MAX && !warnedUnmasked) {
    warnedUnmasked = true;
    logLine(`youtube avatar: the ${endpoint} answer is ${Math.round(text.length / 1024)} KB (1-2 KB expected): YouTube no longer applies the fields= mask; the pictures still work, each lookup costs more`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the answer is not JSON (${text.slice(0, 80)})`);
  }
}

const httpTransport: AvatarTransport = {
  browse: (channelId) => post('browse', BROWSE_FIELDS, { browseId: channelId }),
  next: (videoId) => post('next', NEXT_FIELDS, { videoId }),
  resolve: (handle) => post('navigation/resolve_url', RESOLVE_FIELDS, { url: `https://www.youtube.com/@${encodeURIComponent(handle)}` }),
};

let transport: AvatarTransport = httpTransport;
let now: () => number = Date.now;
let lookupTimeoutMs = LOOKUP_TIMEOUT_MS;

// ---------------------------------------------------------------- what is known

interface Known {
  /** undefined: the lookup failed, or the channel has no picture */
  url?: string;
  until: number;
}

/** By channel id ("c:UC…"), handle ("h:name", lower case) and video id ("v:…"); the oldest entry leaves first */
const known = new Map<string, Known>();
const inFlight = new Map<string, Promise<string | undefined>>();
const stats = { lookups: 0, requests: 0, found: 0, failed: 0, lastFailure: undefined as { at: string; reason: string } | undefined };

function clean(ref: AvatarRef | undefined): AvatarRef {
  return {
    channelId: typeof ref?.channelId === 'string' && CHANNEL_ID.test(ref.channelId) ? ref.channelId : undefined,
    handle: cleanHandle(ref?.handle),
    videoId: typeof ref?.videoId === 'string' && VIDEO_ID.test(ref.videoId) ? ref.videoId : undefined,
  };
}

/** The keys of a channel, the most certain first (the first one names the lookup). */
function keysOf(ref: AvatarRef): string[] {
  const keys: string[] = [];
  if (ref.channelId) keys.push(`c:${ref.channelId}`);
  if (ref.handle) keys.push(`h:${ref.handle.toLowerCase()}`);
  if (ref.videoId) keys.push(`v:${ref.videoId}`);
  return keys;
}

/** A kept answer for any of the keys: a picture before a kept failure. */
function recall(keys: string[]): Known | undefined {
  let failure: Known | undefined;
  for (const k of keys) {
    const e = known.get(k);
    if (!e) continue;
    if (now() >= e.until) {
      known.delete(k);
      continue;
    }
    if (!e.url) {
      failure = failure || e;
      continue;
    }
    // read again: the last to leave
    known.delete(k);
    known.set(k, e);
    return e;
  }
  return failure;
}

function keep(keys: string[], url: string | undefined): void {
  for (const k of keys) {
    // a failure never replaces a picture that is still good
    const had = known.get(k);
    if (!url && had?.url && now() < had.until) continue;
    known.delete(k);
    known.set(k, { url, until: now() + (url ? KEEP_MS : FAILED_KEEP_MS) });
  }
  while (known.size > MAX_ENTRIES) known.delete(known.keys().next().value as string);
}

/** The channel's picture when it is already known; no request. */
export function avatarIfKnown(ref: AvatarRef): string | undefined {
  return recall(keysOf(clean(ref)))?.url;
}

/**
 * Keeps a picture another answer carried for free (a search result's channel thumbnail), so no
 * lookup is needed for that channel. `url` may be any size; it is kept at 88-176 px.
 */
export function rememberAvatar(ref: AvatarRef, url: string | undefined): void {
  const picture = pickAvatar([{ url }]);
  if (picture) keep(keysOf(clean(ref)), picture);
}

// ---------------------------------------------------------------- lookups, two at a time

let running = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (running < MAX_RUNNING) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

/** The place goes straight to the next lookup in line. */
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/** The requests of one lookup, in order, until one gives a picture. Keeps what it finds. Never throws. */
async function lookUp(ref: AvatarRef, problems: string[]): Promise<string | undefined> {
  const keys = new Set(keysOf(ref));
  const learn = (json: any): void => {
    const c = channelFromAnswer(json);
    for (const k of keysOf({ channelId: c.channelId, handle: c.handle })) keys.add(k);
  };
  const steps: [string, () => Promise<string | undefined>][] = [];
  if (ref.channelId) {
    const id = ref.channelId;
    steps.push([
      'channel page data',
      async () => {
        const json = await transport.browse(id);
        learn(json);
        return avatarFromAnswer(json);
      },
    ]);
  }
  if (ref.videoId) {
    const id = ref.videoId;
    steps.push([
      'watch data',
      async () => {
        const json = await transport.next(id);
        learn(json);
        return avatarFromAnswer(json);
      },
    ]);
  }
  if (ref.handle && !ref.channelId) {
    const handle = ref.handle;
    steps.push([
      'handle',
      async () => {
        const id = channelFromAnswer(await transport.resolve(handle)).channelId;
        if (!id) throw new Error('the handle leads to no channel');
        keys.add(`c:${id}`);
        const kept = recall([`c:${id}`]);
        if (kept?.url) return kept.url;
        stats.requests++;
        const json = await transport.browse(id);
        learn(json);
        return avatarFromAnswer(json);
      },
    ]);
  }
  for (const [what, step] of steps) {
    try {
      stats.requests++;
      const url = await step();
      if (url) {
        keep([...keys], url);
        return url;
      }
      problems.push(`${what}: no picture in the answer`);
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message || String(e)}`);
    }
  }
  return undefined;
}

/**
 * The address of a channel's profile picture (88-176 px, yt3.ggpht.com or
 * yt3.googleusercontent.com), from what is known about one of its videos. Never throws: undefined
 * when YouTube gives none within 5 s.
 *
 * With a channel id: one request (its page data). With a video id only: one request (the video's
 * watch data, which also names the channel). With a handle only: two (the handle's channel id,
 * then its page data). A picture is kept 24 h, a failure 10 min; lookups for the same channel
 * share one request; two lookups run at a time, the others wait their turn.
 */
export async function channelAvatar(ref: AvatarRef, log: (m: string) => void): Promise<string | undefined> {
  try {
    const r = clean(ref);
    const keys = keysOf(r);
    if (!keys.length) return undefined;
    const kept = recall(keys);
    if (kept) return kept.url;
    const name = keys[0];
    const shared = inFlight.get(name);
    if (shared) return await shared;
    logLine = log;
    const run = (async (): Promise<string | undefined> => {
      await acquire();
      let timer: NodeJS.Timeout | undefined;
      try {
        // the channel may have been learned while this lookup waited its turn (another video of it)
        const meanwhile = recall(keys);
        if (meanwhile) return meanwhile.url;
        stats.lookups++;
        const problems: string[] = [];
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), lookupTimeoutMs);
        });
        const result = await Promise.race([lookUp(r, problems), timeout]);
        if (typeof result === 'string' && result !== 'timeout') {
          stats.found++;
          return result;
        }
        if (result === 'timeout') problems.push(`no answer within ${lookupTimeoutMs / 1000} s`);
        const reason = problems.join('; ') || 'nothing to ask with';
        keep(keys, undefined);
        stats.failed++;
        stats.lastFailure = { at: new Date().toISOString(), reason: `${name.slice(2)}: ${reason}`.slice(0, 300) };
        log(`youtube avatar: no picture for ${name.slice(2)} (${reason}); asked again in ${FAILED_KEEP_MS / 60_000} min`);
        return undefined;
      } finally {
        if (timer) clearTimeout(timer);
        release();
      }
    })();
    inFlight.set(name, run);
    try {
      return await run;
    } finally {
      if (inFlight.get(name) === run) inFlight.delete(name);
    }
  } catch (e) {
    try {
      log(`youtube avatar: lookup failed (${(e as Error).message || String(e)})`);
    } catch {
      // a log that throws changes nothing
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- status

/** For /api/health: how many pictures are kept, and how the lookups went. */
export const youtubeAvatarStatus = (): { kept: number; running: number; waiting: number; lookups: number; requests: number; found: number; failed: number; lastFailure?: { at: string; reason: string } } => ({
  kept: known.size,
  running,
  waiting: waiting.length,
  lookups: stats.lookups,
  requests: stats.requests,
  found: stats.found,
  failed: stats.failed,
  lastFailure: stats.lastFailure,
});

/**
 * Tests: replace the network (undefined restores it), the clock and the 5 s limit; forget every
 * picture and count. Call it between lookups, not while one runs.
 */
export function setAvatarTransport(t: AvatarTransport | undefined, opts: { now?: () => number; timeoutMs?: number } = {}): void {
  transport = t || httpTransport;
  now = opts.now || Date.now;
  lookupTimeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  known.clear();
  inFlight.clear();
  warnedUnmasked = false;
  Object.assign(stats, { lookups: 0, requests: 0, found: 0, failed: 0, lastFailure: undefined });
}
