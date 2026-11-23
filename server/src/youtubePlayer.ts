/**
 * A YouTube video's play URLs straight from YouTube's player API (youtubei/v1/player), over plain
 * HTTPS: the one request yt-dlp's JS-less client sends, without yt-dlp around it. No Python.
 *
 * Why (2026-11-22): on the free e2-micro VM every video lookup through yt-dlp 2026.10.26 took 7-25 s
 * and many ran past the viewer's 30 s ("yt-dlp timed out after 30 s", worst for long videos of big
 * channels with a dozen dubbed sound tracks). For one video yt-dlp downloads the watch page
 * (1.0-1.3 MB of HTML it searches and parses), the player answer and an HLS manifest we never
 * play: 1.8-2.1 s on the dev PC, ten times that on the VM's throttled CPU, more while a headless
 * browser runs beside it. The player answer alone has everything the feed needs.
 *
 * Measured 2026-11-22 from the dev PC (yt-dlp 2026.10.21's client definition):
 *  - one POST, 115-160 ms, 16-32 KB gzipped (90-275 KB of JSON; a video with 20 dubbed tracks lists
 *    118 formats). The URLs are plain (no signature to compute, no `n` parameter), carry
 *    `c=VISIONOS`, and a ranged GET answers 206 with fragmented MP4 (ftyp "dash"): the same files
 *    yt-dlp hands out.
 *  - without a visitor id the answer is LOGIN_REQUIRED "Sign in to confirm you're not a bot". The
 *    id YouTube returns with that refusal (responseContext.visitorData) is accepted on the next
 *    request, as is the one a youtube.com page carries (what yt-dlp sends). The id is kept and
 *    reused, the way a browser keeps it. A refusal neither id lifts rests this path for 10 min.
 *  - a "made for kids" video answers UNPLAYABLE "This video is not available" (as it does to
 *    yt-dlp without a JS runtime). No app client gives plain URLs for those: ANDROID and IOS
 *    answer OK with SABR only, the web and TV clients need the player's JavaScript.
 *  - the answer names the channel but not its @handle; YouTube's oEmbed endpoint does (author_url,
 *    0.12 s), asked alongside.
 *
 * yt-dlp stays the fallback (youtube.ts): any failure here - a refusal, an unplayable answer, a
 * timeout, a layout this parser does not read - is counted in /api/health (youtubePlayer.fallback,
 * lastFallback) and the video is looked up by yt-dlp as before. YOUTUBE_PLAYER=ytdlp turns this
 * path off. The client definition is the one the installed yt-dlp reports (its daemon's hello
 * line), so the daily yt-dlp upgrade renews it; BUILTIN_CLIENT is used until a daemon has started.
 */
import * as zlib from 'node:zlib';
import { openUpstream, readBody } from './http';
import { ytdlpDirectClient } from './ytdlp';
import { say } from './activity';

const API = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const HOSTS = ['www.youtube.com'];
const REQUEST_TIMEOUT_MS = 6_000;
const OEMBED_TIMEOUT_MS = 2_500;
/** A visitor id is replaced after this long (and at once when YouTube refuses it) */
const VISITOR_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * After a refusal that no visitor id lifted (YouTube bot-checking this server's address), the
 * direct path rests this long: every video goes to yt-dlp without three more refused requests.
 */
const REFUSED_REST_MS = 10 * 60 * 1000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** A player client: the `client` object of the request context, and its numeric id for the header. */
export interface PlayerClient {
  name: string;
  id: number;
  client: Record<string, string | number | boolean>;
  /** The `params` of the player request, for a client that needs one */
  params?: string;
}

/** yt-dlp 2026.10.21's `visionos` client (its only one that needs no JS runtime and no PO token). */
export const BUILTIN_CLIENT: PlayerClient = {
  name: 'visionos',
  id: 101,
  client: {
    clientName: 'VISIONOS',
    clientVersion: '1.02',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    osName: 'visionOS',
    osVersion: '26.5.23O471',
  },
};

/** What a daemon reported, when it is a usable client definition; undefined otherwise. */
export function validClient(raw: unknown): PlayerClient | undefined {
  const r = raw as Partial<PlayerClient> | undefined;
  if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !Number.isInteger(r.id) || !r.client || typeof r.client !== 'object') return undefined;
  const c = r.client;
  for (const k of ['clientName', 'clientVersion', 'userAgent']) if (typeof c[k] !== 'string' || !c[k]) return undefined;
  if (Object.values(c).some((v) => !['string', 'number', 'boolean'].includes(typeof v))) return undefined;
  return { name: r.name, id: r.id as number, client: c, params: typeof r.params === 'string' && r.params ? r.params : undefined };
}

/** The client in use: the installed yt-dlp's, else the built-in one. */
export const playerClient = (): PlayerClient => validClient(ytdlpDirectClient()) || BUILTIN_CLIENT;

/** Why the direct path gave no formats; `kind` says what the fallback is up against. */
export class DirectPlayerError extends Error {
  constructor(
    message: string,
    /** refused: YouTube wants a sign-in / bot check; unplayable: YouTube has no stream for this client; layout: an answer this parser does not read; network: no usable answer */
    public readonly kind: 'refused' | 'unplayable' | 'layout' | 'network',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- parsing (pure)

/** One format in the shape of a yt-dlp format entry (the fields youtube.ts reads). */
export interface DirectFormat {
  format_id: string;
  url: string;
  protocol: 'https';
  ext: string;
  vcodec: string;
  acodec: string;
  width?: number;
  height?: number;
  fps?: number;
  /** kbit/s */
  tbr?: number;
  abr?: number;
  /** For sound: the track's name, "original" and "(default)" as YouTube marks them */
  format_note?: string;
  http_headers: Record<string, string>;
}

/** One video in the shape of yt-dlp's info JSON (the fields youtube.ts reads). */
export interface DirectInfo {
  id: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  /** https://www.youtube.com/@handle, from oEmbed */
  uploader_url?: string;
  duration?: number;
  width?: number;
  height?: number;
  thumbnails: { url: string; width?: number; height?: number }[];
  formats: DirectFormat[];
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : undefined;
};

/** `status` and `reason` of an answer's playabilityStatus. */
export function playability(json: any): { status?: string; reason?: string } {
  const ps = json?.playabilityStatus;
  const reason = typeof ps?.reason === 'string' ? ps.reason : typeof ps?.messages?.[0] === 'string' ? ps.messages[0] : undefined;
  return { status: typeof ps?.status === 'string' ? ps.status : undefined, reason };
}

/**
 * True for the refusal a missing or worn-out visitor id gets ("Sign in to confirm you're not a
 * bot"); an age gate is LOGIN_REQUIRED too, and no visitor id changes that.
 */
export function isBotCheck(json: any): boolean {
  const { status, reason } = playability(json);
  return status === 'LOGIN_REQUIRED' && !/\bage\b|inappropriate/i.test(reason || '');
}

/** The visitor id a youtube.com page carries in its config. */
export function visitorFromPage(html: string): string | undefined {
  return /"VISITOR_DATA":"([^"\\]{8,})"/.exec(html)?.[1] || /"visitorData":"([^"\\]{8,})"/.exec(html)?.[1];
}

/**
 * A player answer as yt-dlp-shaped info. Throws DirectPlayerError when the video is not playable
 * for this client, or the answer is not one this parser reads. Formats without a plain URL
 * (signatureCipher, SABR only), DRM formats and "on the fly" DASH streams are left out.
 */
export function playerAnswerToInfo(json: any, videoId: string, userAgent: string): DirectInfo {
  const { status, reason } = playability(json);
  if (!status) throw new DirectPlayerError(`no playability status in the answer (top-level keys: ${Object.keys(json || {}).slice(0, 8).join(', ')})`, 'layout');
  if (status !== 'OK') throw new DirectPlayerError(`${status}${reason ? `: ${reason}` : ''}`, status === 'LOGIN_REQUIRED' ? 'refused' : 'unplayable');
  const vd = json.videoDetails || {};
  // YouTube answers a client it does not serve with another video (a placeholder); yt-dlp checks the same.
  if (typeof vd.videoId === 'string' && vd.videoId !== videoId) throw new DirectPlayerError(`the answer is for another video (${vd.videoId})`, 'unplayable');
  if (vd.isLive === true) throw new DirectPlayerError('a live stream (HLS only)', 'unplayable');
  const adaptive = json.streamingData?.adaptiveFormats;
  if (!Array.isArray(adaptive)) throw new DirectPlayerError(`no adaptiveFormats in the answer (streamingData keys: ${Object.keys(json.streamingData || {}).slice(0, 8).join(', ') || 'none'})`, 'layout');
  const formats: DirectFormat[] = [];
  let unsigned = 0;
  for (const f of adaptive) {
    const m = /^(video|audio)\/([\w-]+);\s*codecs="([^"]+)"/.exec(typeof f?.mimeType === 'string' ? f.mimeType : '');
    if (!m) continue;
    if (typeof f.url !== 'string' || !/^https:\/\//.test(f.url)) {
      unsigned++;
      continue;
    }
    if (f.type === 'FORMAT_STREAM_TYPE_OTF' || (Array.isArray(f.drmFamilies) && f.drmFamilies.length)) continue;
    const isVideo = m[1] === 'video';
    const kbps = num(f.averageBitrate ?? f.bitrate);
    const track = f.audioTrack;
    const lang = typeof track?.id === 'string' ? track.id.split('.')[0] : undefined;
    const note = isVideo
      ? typeof f.qualityLabel === 'string'
        ? f.qualityLabel
        : undefined
      : [typeof track?.displayName === 'string' ? track.displayName : '', track?.audioIsDefault === true ? '(default)' : '', f.isDrc === true ? 'DRC' : ''].filter(Boolean).join(' ') || undefined;
    formats.push({
      format_id: `${f.itag}${!isVideo && f.isDrc === true ? '-drc' : ''}${!isVideo && lang ? `-${lang}` : ''}`,
      url: f.url,
      protocol: 'https',
      ext: m[2],
      vcodec: isVideo ? m[3] : 'none',
      acodec: isVideo ? 'none' : m[3],
      width: isVideo ? num(f.width) : undefined,
      height: isVideo ? num(f.height) : undefined,
      fps: isVideo ? num(f.fps) : undefined,
      tbr: kbps !== undefined ? Math.round(kbps / 100) / 10 : undefined,
      abr: !isVideo && kbps !== undefined ? Math.round(kbps / 100) / 10 : undefined,
      format_note: note,
      http_headers: { 'User-Agent': userAgent },
    });
  }
  if (!formats.length) throw new DirectPlayerError(unsigned ? `${unsigned} formats, none with a plain URL (signed or SABR only)` : 'the answer lists no formats', 'layout');
  const thumbs: any[] = Array.isArray(vd.thumbnail?.thumbnails) ? vd.thumbnail.thumbnails : [];
  const largest = formats.filter((f) => f.vcodec !== 'none').sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  return {
    id: videoId,
    title: typeof vd.title === 'string' ? vd.title : undefined,
    channel: typeof vd.author === 'string' ? vd.author : undefined,
    channel_id: typeof vd.channelId === 'string' ? vd.channelId : undefined,
    duration: num(vd.lengthSeconds),
    width: largest?.width,
    height: largest?.height,
    thumbnails: thumbs.filter((t) => typeof t?.url === 'string').map((t) => ({ url: t.url, width: num(t.width), height: num(t.height) })),
    formats,
  };
}

// ---------------------------------------------------------------- network

/** The three requests of a lookup; tests replace them. */
export interface PlayerTransport {
  /** The player answer for `videoId`, asked as `client`, with `visitorId` when there is one */
  player(videoId: string, client: PlayerClient, visitorId: string | undefined): Promise<any>;
  /** The HTML of the video's embed page (carries a visitor id; 150 KB) */
  embedPage(videoId: string): Promise<string>;
  /** YouTube's oEmbed JSON for the video (author_url names the channel's @handle) */
  oembed(videoId: string): Promise<any>;
}

async function readText(res: Awaited<ReturnType<typeof openUpstream>>['res']): Promise<string> {
  let buf = await readBody(res, 8 * 1024 * 1024);
  if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}

/** The body of a player request (what yt-dlp sends for a JS-less client). */
export function playerRequestBody(videoId: string, client: PlayerClient, visitorId: string | undefined): Record<string, unknown> {
  const c: Record<string, unknown> = { ...client.client, hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0 };
  if (visitorId) c.visitorData = visitorId;
  return {
    context: { client: c },
    videoId,
    ...(client.params ? { params: client.params } : {}),
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

const httpTransport: PlayerTransport = {
  async player(videoId, client, visitorId) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept-encoding': 'gzip',
      origin: 'https://www.youtube.com',
      'x-youtube-client-name': String(client.id),
      'x-youtube-client-version': String(client.client.clientVersion),
      'user-agent': String(client.client.userAgent),
    };
    if (visitorId) headers['x-goog-visitor-id'] = visitorId;
    const { res, status } = await openUpstream(API, { method: 'POST', body: JSON.stringify(playerRequestBody(videoId, client, visitorId)), headers, allowlist: HOSTS, timeoutMs: REQUEST_TIMEOUT_MS });
    const text = await readText(res);
    if (status !== 200) throw new DirectPlayerError(`YouTube's player API answered ${status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`, 'network');
    try {
      return JSON.parse(text);
    } catch {
      throw new DirectPlayerError(`the player answer is not JSON (${text.slice(0, 80)})`, 'layout');
    }
  },
  async embedPage(videoId) {
    const { res, status } = await openUpstream(`https://www.youtube.com/embed/${videoId}`, {
      headers: { 'accept-encoding': 'gzip', 'accept-language': 'en-US,en;q=0.9', 'user-agent': BROWSER_UA },
      allowlist: HOSTS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const text = await readText(res);
    if (status !== 200) throw new DirectPlayerError(`the embed page answered ${status}`, 'network');
    return text;
  },
  async oembed(videoId) {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const { res, status } = await openUpstream(url, { headers: { 'accept-encoding': 'gzip', 'user-agent': BROWSER_UA }, allowlist: HOSTS, timeoutMs: OEMBED_TIMEOUT_MS });
    const text = await readText(res);
    if (status !== 200) throw new Error(`oEmbed answered ${status}`);
    return JSON.parse(text);
  },
};

let transport: PlayerTransport = httpTransport;

/** The visitor id YouTube accepted last, and when it was taken */
let visitor: { id: string; at: number } | undefined;
/** Set by a refusal no visitor id lifted: no direct request before `until` */
let rest: { until: number; reason: string } | undefined;

const echoed = (json: any): string | undefined => {
  const v = json?.responseContext?.visitorData;
  return typeof v === 'string' && v.length >= 8 ? v : undefined;
};

/**
 * The player answer, with a visitor id YouTube accepts: the kept one; on a bot-check refusal the
 * one that refusal hands back; then the one the video's embed page carries. The last answer is
 * returned either way (still refused: the caller reports it).
 */
async function ask(videoId: string, client: PlayerClient, log: (m: string) => void): Promise<{ json: any; requests: number }> {
  const kept = visitor && Date.now() - visitor.at < VISITOR_TTL_MS ? visitor.id : undefined;
  say(`asking YouTube's player API directly for the video's files (as its ${client.name} app${kept ? '' : ', first request: no visitor id yet'})`, 'asking YouTube for the video');
  let json = await transport.player(videoId, client, kept);
  let requests = 1;
  if (!isBotCheck(json)) {
    if (!kept) {
      const v = echoed(json);
      if (v) visitor = { id: v, at: Date.now() };
    }
    return { json, requests };
  }
  const tried = new Set<string>(kept ? [kept] : []);
  const sources: [string, () => Promise<string | undefined>][] = [
    ['the one YouTube sent with the refusal', async () => echoed(json)],
    ["the embed page's", async () => visitorFromPage(await transport.embedPage(videoId))],
  ];
  for (const [what, get] of sources) {
    let id: string | undefined;
    try {
      id = await get();
    } catch (e) {
      log(`youtube player: no visitor id from ${what} (${(e as Error).message})`);
    }
    if (!id || tried.has(id)) continue;
    tried.add(id);
    say(`YouTube asked "are you a bot?": asking again with a visitor id (${what})`, 'asking YouTube again');
    json = await transport.player(videoId, client, id);
    requests++;
    if (!isBotCheck(json)) {
      visitor = { id, at: Date.now() };
      log(`youtube player: ${kept ? 'the visitor id was refused; a new one' : 'a visitor id'} (${what}) is accepted`);
      return { json, requests };
    }
  }
  visitor = undefined;
  const { status, reason } = playability(json);
  rest = { until: Date.now() + REFUSED_REST_MS, reason: `${status}${reason ? `: ${reason}` : ''}` };
  log(`youtube player: refused with every visitor id (${rest.reason}); videos go to yt-dlp for ${REFUSED_REST_MS / 60_000} min`);
  return { json, requests };
}

/** The channel page URL of the video's uploader (https://www.youtube.com/@handle); undefined when oEmbed does not say. */
async function uploaderUrl(videoId: string): Promise<string | undefined> {
  try {
    const url = (await transport.oembed(videoId))?.author_url;
    return typeof url === 'string' && /^https:\/\/www\.youtube\.com\/@/.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One video's info and formats from the player API. Throws DirectPlayerError; the caller falls
 * back to yt-dlp. `requests` counts the player requests it took (2 when a visitor id was needed).
 */
export async function playerInfoDirect(videoId: string, log: (m: string) => void): Promise<{ info: DirectInfo; requests: number; client: string }> {
  if (rest && Date.now() < rest.until) throw new DirectPlayerError(`${rest.reason} (refused with every visitor id; next direct try in ${Math.ceil((rest.until - Date.now()) / 60_000)} min)`, 'refused');
  rest = undefined;
  const client = playerClient();
  const handle = uploaderUrl(videoId);
  let answer: { json: any; requests: number };
  try {
    answer = await ask(videoId, client, log);
  } catch (e) {
    throw e instanceof DirectPlayerError ? e : new DirectPlayerError((e as Error).message || String(e), 'network');
  }
  const info = playerAnswerToInfo(answer.json, videoId, String(client.client.userAgent));
  info.uploader_url = await handle;
  return { info, requests: answer.requests, client: client.name };
}

// ---------------------------------------------------------------- status

const stats = { direct: 0, fallback: 0, lastFallback: undefined as { at: string; reason: string } | undefined };

/** False when YOUTUBE_PLAYER=ytdlp: every video is looked up by yt-dlp, as before this module. */
export const directPlayerEnabled = (): boolean => !/^ytdlp$/i.test(process.env.YOUTUBE_PLAYER || '');

export function notePlayerDirect(): void {
  stats.direct++;
}

export function notePlayerFallback(reason: string): void {
  stats.fallback++;
  stats.lastFallback = { at: new Date().toISOString(), reason: reason.slice(0, 300) };
}

/** For /api/health: which path looks videos up, with which client, and how often yt-dlp was needed. */
export const youtubePlayerStatus = (): { mode: 'direct' | 'ytdlp'; client: string; direct: number; fallback: number; lastFallback?: { at: string; reason: string } } => {
  const c = playerClient();
  return {
    mode: directPlayerEnabled() ? 'direct' : 'ytdlp',
    client: `${c.name} ${c.client.clientVersion}${c === BUILTIN_CLIENT ? ' (built in)' : ''}`,
    direct: stats.direct,
    fallback: stats.fallback,
    lastFallback: stats.lastFallback,
  };
};

/** Tests: replace the network (undefined restores it), forget the visitor id and any rest. */
export function setPlayerTransport(t: PlayerTransport | undefined): void {
  transport = t || httpTransport;
  visitor = undefined;
  rest = undefined;
}
