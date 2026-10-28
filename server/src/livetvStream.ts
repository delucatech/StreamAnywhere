/**
 * Live streams to the browser. A channel's stream is opened by the server, never by the browser:
 * IPTV streams are mostly plain http (a page served over https cannot load them), few allow
 * cross-origin requests, and Xtream stream URLs carry the account's password.
 *
 *  - tune (classify): open the stream once, look at the status, Content-Type and first bytes:
 *      HLS playlist      -> relayed and rewritten: every URI in it (variants, segments, keys, init
 *                           maps) becomes a same-origin path whose token is the upstream URL
 *                           encrypted (livetvCrypto), so nothing upstream is visible or forgeable;
 *      raw MPEG-TS       -> ffmpeg turns it into a live HLS playlist in a temp folder (video
 *                           copied, sound to AAC; a "remux"), served from there while someone is
 *                           watching, torn down 3 min after the last request. The playlist keeps
 *                           the last DVR_WINDOW_SEC: pause and rewind within it ("pause and
 *                           rewind"); an HLS channel goes through the same recorder when the
 *                           viewer wants that (one variant, picked here: pickVariant), else it
 *                           is relayed as below;
 *      a media file      -> relayed as it is (Range forwarded);
 *      DASH, a web page, DRM, anything else -> "unsupported", with the reason;
 *      an error, nothing, a timeout -> "unavailable".
 *    The verdict is kept for a few minutes per channel so the playlist relay does not re-probe.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { LiveTvStreamKind } from '../../shared/types';
import { detectFfmpeg } from './ffmpeg';
import { decryptText, encryptText } from './livetvCrypto';
import { LIVETV_USER_AGENT, openLive, redactUrl, safeHost } from './livetvHttp';
import { UpstreamRejectedError } from './ssrf';

export interface StreamSource {
  url: string;
  headers?: Record<string, string>;
  /** Xtream: the .ts form of the same stream, tried when the .m3u8 one is refused */
  alt?: string;
  /** strings that must never reach the log */
  secrets?: string[];
}

export type Classified =
  | { kind: 'hls'; url: string; playlist: string; headers?: Record<string, string> }
  | { kind: 'ts'; url: string; headers?: Record<string, string> }
  | { kind: 'progressive'; url: string; contentType: string; headers?: Record<string, string> }
  | { kind: 'unsupported'; detail: string; message: string }
  | { kind: 'unavailable'; detail: string; message: string };

let log: (m: string) => void = () => undefined;
export const setLiveTvStreamLogger = (fn: (m: string) => void): void => {
  log = fn;
};

const PROBE_TIMEOUT_MS = 15_000;

/** Reads up to `max` bytes (or the whole body when it ends sooner), then stops. */
async function readHead(res: IncomingMessage, max: number, enough?: (b: Buffer) => boolean): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size >= max || (enough && enough(Buffer.concat(chunks)))) break;
  }
  res.destroy();
  return Buffer.concat(chunks);
}

const isTs = (b: Buffer): boolean => b.length >= 376 && b[0] === 0x47 && b[188] === 0x47 && (b.length < 565 || b[376] === 0x47);
const looksText = (b: Buffer): boolean => {
  const head = b.subarray(0, Math.min(b.length, 512));
  let bad = 0;
  for (const c of head) if (c === 0 || (c < 9 && c !== 0)) bad++;
  return bad === 0;
};

async function classifyOne(url: string, headers: Record<string, string> | undefined, secrets: string[]): Promise<Classified> {
  let up;
  try {
    up = await openLive(url, { headers, timeoutMs: PROBE_TIMEOUT_MS });
  } catch (e) {
    const err = e as Error;
    if (err instanceof UpstreamRejectedError) return { kind: 'unsupported', detail: err.code, message: err.message };
    return { kind: 'unavailable', detail: err.message, message: `The stream could not be opened (${err.message})` };
  }
  const { res, status, finalUrl } = up;
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  if (status >= 400) {
    res.destroy();
    const why = status === 403 ? 'the provider refused the request (403: geo-blocked, or not allowed from this server)' : status === 404 ? 'the provider has no such stream any more (404)' : status === 401 ? 'the provider wants a sign-in (401)' : status >= 500 ? `the provider's server failed (${status})` : `HTTP ${status}`;
    return { kind: 'unavailable', detail: `HTTP ${status} from ${safeHost(finalUrl)}`, message: `This channel is not available right now: ${why}.` };
  }
  const wantsPlaylist = /mpegurl|m3u/.test(ct) || /\.m3u8?(\?|$)/i.test(finalUrl);
  const head = await readHead(res, wantsPlaylist ? 2 * 1024 * 1024 : 64 * 1024, wantsPlaylist ? undefined : (b) => b.length >= 2048);
  const text = looksText(head) ? head.toString('utf8') : '';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('#EXTM3U')) {
    if (!/#EXT-X-STREAM-INF|#EXTINF|#EXT-X-MEDIA/.test(trimmed)) return { kind: 'unavailable', detail: 'empty playlist', message: 'The provider answered with an empty playlist: the channel is off the air right now.' };
    return { kind: 'hls', url: finalUrl, playlist: text, headers };
  }
  if (/dash\+xml/.test(ct) || /<MPD[\s>]/.test(trimmed.slice(0, 4000))) return { kind: 'unsupported', detail: 'MPEG-DASH', message: 'This channel is an MPEG-DASH stream, which this player does not support (HLS and MPEG-TS play).' };
  if (/text\/html/.test(ct) || /^<!doctype html|^<html/i.test(trimmed)) {
    const site = /youtube\.com|youtu\.be/.test(finalUrl) ? 'a YouTube page' : /twitch\.tv/.test(finalUrl) ? 'a Twitch page' : 'a web page';
    return { kind: 'unsupported', detail: `web page from ${safeHost(finalUrl)}`, message: `This channel's link opens ${site}, not a video stream; it cannot play here.` };
  }
  if (isTs(head) || /video\/mp2t/.test(ct)) return { kind: 'ts', url: finalUrl, headers };
  const ftyp = head.length > 12 && head.subarray(4, 8).toString('latin1') === 'ftyp';
  const ebml = head.length > 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  if (ftyp || ebml || /^(video|audio)\//.test(ct)) return { kind: 'progressive', url: finalUrl, contentType: ct || (ebml ? 'video/webm' : 'video/mp4'), headers };
  if (/application\/(octet-stream|x-mpegurl)/.test(ct) && head.length === 0) return { kind: 'unavailable', detail: 'empty answer', message: 'The provider sent nothing for this channel.' };
  log(`unclassified stream from ${safeHost(finalUrl)}: ${ct || 'no content type'}, ${head.length} bytes, starts ${head.subarray(0, 8).toString('hex')} (${redactUrl(finalUrl, secrets)})`);
  return { kind: 'unsupported', detail: `${ct || 'unknown content type'}, ${head.length} bytes`, message: `The provider sent a format this player cannot read (${ct || 'unknown type'}).` };
}

export async function classify(src: StreamSource): Promise<Classified> {
  const secrets = src.secrets || [];
  let r = await classifyOne(src.url, src.headers, secrets);
  if (src.alt && r.kind !== 'hls' && r.kind !== 'progressive' && r.kind !== 'ts') {
    const r2 = await classifyOne(src.alt, src.headers, secrets);
    if (r2.kind === 'hls' || r2.kind === 'ts' || r2.kind === 'progressive') r = r2;
  }
  return r;
}

// ---------------------------------------------------------------- HLS rewriting

const PLAYLIST_TAGS = /^#EXT-X-(STREAM-INF|MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)/;

export const mintToken = (url: string): string => encryptText(url, true);
export const readToken = (token: string): string | undefined => {
  const u = decryptText(token);
  return u && /^https?:\/\//i.test(u) ? u : undefined;
};

/**
 * Every URI of a playlist (variant / media playlists, segments, keys, init maps, parts) becomes a
 * same-origin path with the upstream URL as an encrypted token. Playlist URIs go to the playlist
 * relay (which rewrites again), everything else to the segment relay.
 */
export function rewritePlaylist(text: string, baseUrl: string, key: string): string {
  const abs = (uri: string): string => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return uri;
    }
  };
  const asPlaylist = (uri: string): string => `/api/livetv/hls/${encodeURIComponent(key)}/p/${mintToken(abs(uri))}.m3u8`;
  const asSegment = (uri: string): string => `/api/livetv/seg/${encodeURIComponent(key)}/${mintToken(abs(uri))}`;
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const out: string[] = [];
  let nextIsPlaylist = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      out.push('');
      continue;
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) nextIsPlaylist = true;
      // URI="…" attributes
      const tagIsPlaylist = PLAYLIST_TAGS.test(line);
      out.push(line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${tagIsPlaylist ? asPlaylist(uri) : asSegment(uri)}"`));
      continue;
    }
    // a URI line
    if (nextIsPlaylist || (isMaster && !nextIsPlaylist)) {
      out.push(asPlaylist(line));
      nextIsPlaylist = false;
    } else out.push(asSegment(line));
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- the variant of a master playlist to record

export interface HlsInput {
  /** The media playlist (or the master, when the variant's sound is a separate rendition) */
  url: string;
  /** With the master: the variant's index among its #EXT-X-STREAM-INF entries (ffmpeg's program id) */
  program?: number;
  bandwidth?: number;
  resolution?: string;
}

const VARIANT_MAX_HEIGHT = 1080;
const VARIANT_MAX_BPS = 12_000_000;

/**
 * The variant of a master playlist the recorder should read: a video variant, H.264 before HEVC
 * (which not every browser decodes), the highest bandwidth at or under 1080p and 12 Mbps when
 * there is one, else the lightest of the rest. A media playlist (no variants) gives undefined.
 * When the variant's audio is a separate rendition (#EXT-X-MEDIA with a URI), ffmpeg needs the
 * master and the program index to pick the pair; else the media playlist itself.
 */
export function pickVariant(master: string, baseUrl: string): HlsInput | undefined {
  const lines = master.split(/\r?\n/).map((l) => l.trim());
  const audioGroupsWithUri = new Set<string>();
  for (const l of lines) {
    if (!l.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attrsOf(l.slice(13));
    if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI && a['GROUP-ID']) audioGroupsWithUri.add(a['GROUP-ID']);
  }
  type V = { index: number; uri: string; bandwidth: number; height: number; avc: boolean; video: boolean; audioGroup?: string };
  const variants: V[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attrsOf(lines[i].slice(18));
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j]) continue;
      if (!lines[j].startsWith('#')) uri = lines[j];
      break;
    }
    if (!uri) continue;
    const codecs = (a.CODECS || '').toLowerCase();
    const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
    variants.push({
      index: variants.length,
      uri,
      bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH']) || 0,
      height: res ? Number(res[2]) : 0,
      avc: !codecs || /avc1|avc3/.test(codecs),
      // codecs naming only audio (mp4a / ac-3 / ec-3) = an audio-only variant
      video: !codecs || /avc1|avc3|hvc1|hev1|av01|vp09|dvh1|dvhe/.test(codecs) || !!res,
      audioGroup: a.AUDIO,
    });
  }
  if (!variants.length) return undefined;
  const withVideo = variants.filter((v) => v.video);
  const pool = withVideo.length ? withVideo : variants;
  const fits = (v: V): boolean => (!v.height || v.height <= VARIANT_MAX_HEIGHT) && (!v.bandwidth || v.bandwidth <= VARIANT_MAX_BPS);
  const prefer = pool.filter((v) => v.avc && fits(v));
  const fallback = pool.filter((v) => fits(v));
  let pick: V;
  if (prefer.length) pick = prefer.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  else if (fallback.length) pick = fallback.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  else pick = pool.reduce((a, b) => (b.bandwidth && b.bandwidth < a.bandwidth ? b : a));
  const abs = (uri: string): string => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return uri;
    }
  };
  const separateAudio = !!pick.audioGroup && audioGroupsWithUri.has(pick.audioGroup);
  const out: HlsInput = separateAudio ? { url: baseUrl, program: pick.index } : { url: abs(pick.uri) };
  if (pick.bandwidth) out.bandwidth = pick.bandwidth;
  if (pick.height) out.resolution = `${pick.height}p`;
  return out;
}

/** KEY=VALUE,KEY="quoted, value" attribute lists of #EXT-X-STREAM-INF / #EXT-X-MEDIA */
function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = (m[3] ?? m[4] ?? '').trim();
  return out;
}

// ---------------------------------------------------------------- the remux / recorder (ffmpeg -> HLS with a window)

export interface RemuxSource {
  url: string;
  headers?: Record<string, string>;
  /** a raw MPEG-TS stream (sound re-encoded to AAC), or an HLS playlist (streams copied) */
  input: 'ts' | 'hls';
  /** HLS with the master: the variant to read (see pickVariant) */
  program?: number;
}

/** How far back the recorder's playlist reaches: pause and rewind within it */
export const DVR_WINDOW_SEC = 30 * 60;
const SEGMENT_SEC = 3;

interface RemuxSession {
  key: string;
  input: RemuxSource['input'];
  dir: string;
  proc: ChildProcess;
  startedAt: number;
  lastHit: number;
  ready: Promise<void>;
  exited?: { code: number | null; signal: string | null };
  stderr: string[];
}
const sessions = new Map<string, RemuxSession>();
/**
 * Nobody asked for the playlist for this long: stop. A paused player keeps reloading the live
 * playlist (so its window keeps growing), but a browser in a background tab is throttled to a
 * timer a minute, hence minutes rather than seconds.
 */
const REMUX_IDLE_MS = 3 * 60_000;
const REMUX_READY_MS = 30_000;
const safeDirName = (key: string): string => key.replace(/[^\w.-]/g, '_').slice(0, 80);
const remuxRoot = (): string => path.join(os.tmpdir(), 'streamanywhere-livetv');

const segmentsIn = (playlist: string): number => (playlist.match(/#EXTINF/g) || []).length;

/** The ffmpeg arguments of a recorder (exported for the checks) */
export function remuxArgs(src: RemuxSource, dir: string): string[] {
  const headerLines = Object.entries(src.headers || {})
    .filter(([k]) => k !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  const hls = src.input === 'hls';
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-user_agent', src.headers?.['user-agent'] || LIVETV_USER_AGENT,
    ...(headerLines ? ['-headers', headerLines] : []),
    // segments named .php / .html / nothing at all are common in IPTV lists
    ...(hls ? ['-allowed_extensions', 'ALL'] : []),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-fflags', '+genpts+discardcorrupt',
    // an HLS input starts a few segments behind live: one segment is enough to see the streams
    '-analyzeduration', hls ? '2000000' : '3000000', '-probesize', hls ? '2000000' : '3000000',
    '-i', src.url,
    ...(hls && src.program !== undefined ? ['-map', `p:${src.program}`, '-sn', '-dn'] : ['-map', '0:v:0?', '-map', '0:a:0?']),
    // HLS carries AAC already (what a browser plays); a raw TS may carry MP2 / AC-3: to AAC
    '-c:v', 'copy', ...(hls ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '128k']),
    '-f', 'hls', '-hls_time', String(SEGMENT_SEC), '-hls_list_size', String(Math.ceil(DVR_WINDOW_SEC / SEGMENT_SEC)),
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file+program_date_time',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8'),
  ];
}

async function startRemux(key: string, src: RemuxSource, ffmpeg: string, secrets: string[]): Promise<RemuxSession> {
  const dir = path.join(remuxRoot(), safeDirName(key));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const args = remuxArgs(src, dir);
  const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const s: RemuxSession = { key, input: src.input, dir, proc, startedAt: Date.now(), lastHit: Date.now(), ready: Promise.resolve(), stderr: [] };
  proc.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      s.stderr.push(redactUrl(line, secrets).slice(0, 300));
      if (s.stderr.length > 20) s.stderr.shift();
    }
  });
  proc.on('exit', (code, signal) => {
    s.exited = { code, signal };
    log(`remux ${key}: ffmpeg exited (${code ?? signal}) after ${Math.round((Date.now() - s.startedAt) / 1000)} s${s.stderr.length ? ': ' + s.stderr[s.stderr.length - 1] : ''}`);
  });
  proc.on('error', (e) => {
    s.exited = { code: -1, signal: null };
    s.stderr.push(e.message);
  });
  s.ready = new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (s.exited) return reject(new Error(s.stderr[s.stderr.length - 1] || `ffmpeg stopped (${s.exited.code ?? s.exited.signal})`));
      try {
        const pl = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
        if (segmentsIn(pl) >= 2) return resolve();
      } catch {
        /* not yet */
      }
      if (Date.now() - t0 > REMUX_READY_MS) {
        proc.kill();
        return reject(new Error(`no video from the provider in ${REMUX_READY_MS / 1000} s${s.stderr.length ? ' (' + s.stderr[s.stderr.length - 1] + ')' : ''}`));
      }
      setTimeout(tick, 300);
    };
    tick();
  });
  sessions.set(key, s);
  log(`remux ${key}: ffmpeg started for ${safeHost(src.url)} (${src.input}${src.program !== undefined ? ` program ${src.program}` : ''})`);
  return s;
}

function stopRemux(s: RemuxSession, why: string): void {
  sessions.delete(s.key);
  if (!s.exited) {
    try {
      s.proc.kill();
    } catch {
      /* gone */
    }
  }
  setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => undefined), 1500).unref?.();
  log(`remux ${s.key}: stopped (${why})`);
}

/** The remux of a channel, started if not running; resolves once two segments exist. */
export async function ensureRemux(key: string, src: RemuxSource, secrets: string[]): Promise<{ playUrl: string }> {
  const ff = await detectFfmpeg();
  if (!ff.available || !ff.path) throw new Error('This channel is a raw MPEG-TS stream, which needs ffmpeg on the server to play in a browser; ffmpeg is not installed there.');
  let s = sessions.get(key);
  if (s && (s.exited || s.input !== src.input)) {
    stopRemux(s, s.exited ? 'restarting after an exit' : 'the source changed');
    s = undefined;
  }
  if (!s) s = await startRemux(key, src, ff.path, secrets);
  s.lastHit = Date.now();
  try {
    await s.ready;
  } catch (e) {
    stopRemux(s, 'failed to start');
    throw e;
  }
  return { playUrl: `/api/livetv/remux/${encodeURIComponent(key)}/index.m3u8` };
}

export const remuxAvailable = async (): Promise<boolean> => (await detectFfmpeg()).available;
export const remuxStats = (): { running: number; keys: string[] } => ({ running: sessions.size, keys: [...sessions.keys()] });

const reaper = setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.lastHit > REMUX_IDLE_MS || (s.exited && now - s.lastHit > 5000)) stopRemux(s, s.exited ? 'ffmpeg had exited' : 'nobody watching');
}, 10_000);
reaper.unref?.();

export function shutdownLiveTvStreams(): void {
  clearInterval(reaper);
  for (const s of sessions.values()) stopRemux(s, 'shutdown');
}

// ---------------------------------------------------------------- routes

export type ResolveSource = (key: string) => Promise<StreamSource | undefined>;
export type Verdict = {
  kind: LiveTvStreamKind;
  url?: string;
  headers?: Record<string, string>;
  at: number;
  /** HLS: what the recorder reads for pause and rewind (the variant, or the master + program) */
  hlsInput?: HlsInput;
};

/** Relays one upstream resource (segment, key, init map, or a whole file) to the browser. */
async function relay(req: FastifyRequest, reply: FastifyReply, url: string, headers: Record<string, string> | undefined, secrets: string[], what: string): Promise<unknown> {
  const h: Record<string, string> = { ...(headers || {}) };
  if (typeof req.headers.range === 'string') h.range = req.headers.range;
  let up;
  try {
    up = await openLive(url, { headers: h, timeoutMs: 20_000 });
  } catch (e) {
    const err = e as Error;
    log(`${what} relay failed: ${err.message} (${redactUrl(url, secrets)})`);
    return reply.code(err instanceof UpstreamRejectedError ? 403 : 502).send({ error: err.message });
  }
  const { res, status } = up;
  if (status >= 400) {
    res.destroy();
    return reply.code(status === 403 || status === 404 ? status : 502).send({ error: `Upstream responded ${status}` });
  }
  const out: Record<string, string> = { 'cache-control': 'private, max-age=60' };
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers[k];
    if (typeof v === 'string') out[k] = v;
  }
  if (!out['content-type']) out['content-type'] = 'application/octet-stream';
  req.raw.on('close', () => {
    if (!res.destroyed) res.destroy();
  });
  return reply.code(status).headers(out).send(res);
}

export function registerLiveTvStreamRoutes(app: FastifyInstance, resolveSource: ResolveSource, verdictOf: (key: string) => Verdict | undefined): void {
  const noStore = { 'cache-control': 'no-store', 'content-type': 'application/vnd.apple.mpegurl' };
  const sourceOr404 = async (key: string, reply: FastifyReply): Promise<StreamSource | undefined> => {
    const src = await resolveSource(key);
    if (!src) void reply.code(404).send({ error: 'Unknown channel' });
    return src;
  };

  // the channel's own playlist (the verdict's URL after tune; probed again when the verdict expired)
  app.get<{ Params: { key: string } }>('/api/livetv/hls/:key/index.m3u8', async (req, reply) => {
    const key = req.params.key;
    const src = await sourceOr404(key, reply);
    if (!src) return;
    const v = verdictOf(key);
    const url = v?.kind === 'hls' && v.url ? v.url : undefined;
    const headers = v?.headers || src.headers;
    let text: string;
    let base: string;
    if (url) {
      let up;
      try {
        up = await openLive(url, { headers, timeoutMs: 15_000 });
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
      if (up.status >= 400) {
        up.res.destroy();
        return reply.code(up.status === 403 || up.status === 404 ? up.status : 502).send({ error: `Upstream responded ${up.status}` });
      }
      text = (await readHead(up.res, 4 * 1024 * 1024)).toString('utf8');
      base = up.finalUrl;
    } else {
      const c = await classify(src);
      if (c.kind !== 'hls') return reply.code(c.kind === 'unavailable' ? 502 : 415).send({ error: c.kind === 'unavailable' || c.kind === 'unsupported' ? c.message : 'Not an HLS stream: tune the channel first' });
      text = c.playlist;
      base = c.url;
    }
    return reply.headers(noStore).send(rewritePlaylist(text, base, key));
  });

  // a variant / media playlist named by the master
  app.get<{ Params: { key: string; token: string } }>('/api/livetv/hls/:key/p/:token', async (req, reply) => {
    const key = req.params.key;
    const src = await sourceOr404(key, reply);
    if (!src) return;
    const url = readToken(req.params.token.replace(/\.m3u8$/, ''));
    if (!url) return reply.code(400).send({ error: 'Bad playlist token' });
    let up;
    try {
      up = await openLive(url, { headers: src.headers, timeoutMs: 15_000 });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    if (up.status >= 400) {
      up.res.destroy();
      return reply.code(up.status === 403 || up.status === 404 ? up.status : 502).send({ error: `Upstream responded ${up.status}` });
    }
    const text = (await readHead(up.res, 4 * 1024 * 1024)).toString('utf8');
    return reply.headers(noStore).send(rewritePlaylist(text, up.finalUrl, key));
  });

  // a segment, key or init map
  const seg = async (req: FastifyRequest<{ Params: { key: string; token: string } }>, reply: FastifyReply): Promise<unknown> => {
    const src = await sourceOr404(req.params.key, reply);
    if (!src) return;
    const url = readToken(req.params.token);
    if (!url) return reply.code(400).send({ error: 'Bad segment token' });
    return relay(req, reply, url, src.headers, src.secrets || [], 'segment');
  };
  app.get('/api/livetv/seg/:key/:token', seg);
  app.head('/api/livetv/seg/:key/:token', seg);

  // a progressive file (MP4 / WebM / audio), relayed with Range
  const file = async (req: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply): Promise<unknown> => {
    const src = await sourceOr404(req.params.key, reply);
    if (!src) return;
    const v = verdictOf(req.params.key);
    return relay(req, reply, v?.url || src.url, v?.headers || src.headers, src.secrets || [], 'file');
  };
  app.get('/api/livetv/file/:key', file);
  app.head('/api/livetv/file/:key', file);

  // the remuxed playlist and its segments (files ffmpeg writes)
  app.get<{ Params: { key: string; file: string } }>('/api/livetv/remux/:key/:file', async (req, reply) => {
    const s = sessions.get(req.params.key);
    if (!s) return reply.code(404).send({ error: 'This channel is not being remuxed any more: tune it again' });
    if (!/^(index\.m3u8|seg\d{5,}\.ts)$/.test(req.params.file)) return reply.code(400).send({ error: 'Bad file name' });
    s.lastHit = Date.now();
    const file = path.join(s.dir, req.params.file);
    if (req.params.file === 'index.m3u8') {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return reply.code(404).send({ error: 'No playlist yet' });
      }
      return reply.headers(noStore).send(text);
    }
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return reply.code(404).send({ error: 'That segment is gone' });
    }
    return reply.headers({ 'content-type': 'video/mp2t', 'content-length': String(size), 'cache-control': 'private, max-age=30' }).send(fs.createReadStream(file));
  });
}
