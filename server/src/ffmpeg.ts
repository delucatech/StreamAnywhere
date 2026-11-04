/**
 * Where ffmpeg is: FFMPEG_PATH, else `ffmpeg` on the PATH (apt / apk / choco installs), else the
 * binary of the ffmpeg-static package (a dependency of the server; its install step downloads the
 * build for this platform). yt-dlp needs it to merge YouTube's separate video and audio files.
 *
 * The distro build comes first and stays first: the static build crashed (SIGSEGV) recording live
 * HLS channels on the VM (2026-10-28 and again 2026-11-04). On 2026-11-04 the server had picked it
 * because `ffmpeg -version` had not answered within 10 s right after a deploy (the disk was
 * saturated), and the verdict was cached for the life of the process. So: a binary that exists is
 * never demoted for being slow to answer (the machine is starved, the binary is fine), only for
 * failing to run; a verdict that fell back to the static build or found nothing is asked again a
 * minute later.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FfmpegInfo {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
  /** The version check did not answer in time: the version is unknown, the binary kept */
  slow?: boolean;
}

const VERSION_TIMEOUT_MS = 30_000;

/** The version string, 'timeout' when the binary did not answer in time, undefined when it does not run */
function version(cmd: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<string | 'timeout' | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(undefined);
      return;
    }
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child!.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = /ffmpeg version (\S+)/.exec(out);
      if (code === 0 && m) resolve(m[1]);
      else resolve(timedOut ? 'timeout' : undefined);
    });
  });
}

/** Where `ffmpeg` on the PATH is, if any directory of the PATH holds an executable one */
export function ffmpegOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat', 'ffmpeg'] : ['ffmpeg'];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

export interface FfmpegCandidate {
  cmd: string;
  /** A file known to be there (a bare `ffmpeg` without a PATH hit is not) */
  exists: boolean;
  /** The ffmpeg-static package's binary: the last resort */
  bundled?: boolean;
}

/** The candidates in order of preference */
export function ffmpegCandidates(env: NodeJS.ProcessEnv = process.env, bundled: string | null = bundledFfmpeg()): FfmpegCandidate[] {
  const list: FfmpegCandidate[] = [];
  if (env.FFMPEG_PATH) list.push({ cmd: env.FFMPEG_PATH, exists: fs.existsSync(env.FFMPEG_PATH) });
  const onPath = ffmpegOnPath(env);
  if (onPath) list.push({ cmd: onPath, exists: true });
  else list.push({ cmd: 'ffmpeg', exists: false });
  if (bundled && fs.existsSync(bundled)) list.push({ cmd: bundled, exists: true, bundled: true });
  return list;
}

function bundledFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('ffmpeg-static') as string | null;
  } catch {
    return null; /* package not installed */
  }
}

/**
 * The verdict over a list of candidates and their version answers (exported for the checks):
 * the first that answers wins; one that exists but is slow to answer wins too unless it is the
 * bundled build (which only ever stands in when nothing else is there).
 */
export async function pickFfmpeg(list: FfmpegCandidate[], ask: (cmd: string) => Promise<string | 'timeout' | undefined>, timeoutSec = VERSION_TIMEOUT_MS / 1000): Promise<FfmpegInfo> {
  const errors: string[] = [];
  for (const c of list) {
    const v = await ask(c.cmd);
    if (v === 'timeout') {
      if (c.exists && !c.bundled) return { available: true, path: c.cmd, slow: true };
      errors.push(`${c.cmd}: no answer in ${timeoutSec} s`);
    } else if (v) return { available: true, path: c.cmd, version: v };
    else errors.push(`${c.cmd}: not runnable`);
  }
  return { available: false, error: errors.join('; ') || 'no ffmpeg' };
}

/** How long a verdict that fell back to the bundled binary (or found none) is kept before asking again */
const RETRY_MS = 60_000;

let cached: Promise<FfmpegInfo> | undefined;
let cachedAt = 0;

/** A verdict is final when it names a runnable, non-bundled binary with a version; any other gets a second look */
const settled = (i: FfmpegInfo): boolean => i.available && !i.slow && !/ffmpeg-static/.test(i.path || '');

export function detectFfmpeg(): Promise<FfmpegInfo> {
  if (!cached || Date.now() - cachedAt > RETRY_MS) {
    const prev = cached;
    cachedAt = Date.now();
    const next = (async () => {
      const info = await pickFfmpeg(ffmpegCandidates(), (cmd) => version(cmd));
      if (settled(info)) cachedAt = Number.POSITIVE_INFINITY;
      return info;
    })();
    if (!prev) cached = next;
    // a second look runs behind the kept verdict and replaces it once it is in
    else void next.then((info) => void (cached = Promise.resolve(info)), () => undefined);
  }
  return cached!;
}

/** For the checks: forget the verdict */
export function resetFfmpegDetection(): void {
  cached = undefined;
  cachedAt = 0;
}

// ---------------------------------------------------------------- what is in a file, and making an MP4 of it
//
// The app's player reads MP4 only (mp4box.js + WebCodecs): a video stored in the library has to be
// an MP4 with codecs the browsers decode. ffmpeg tells what a downloaded file holds (`-i`, parsed
// from its stream listing: there is no ffprobe in the ffmpeg-static package), and makes the MP4:
// a remux (streams copied, seconds) when the codecs are fine, a re-encode (H.264 / AAC, slow on
// a small server) when they are not.

export interface MediaStreamInfo {
  index: number;
  kind: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';
  /** ffmpeg's codec name: h264, hevc, vp9, av1, mpeg4, aac, ac3, eac3, dts, opus, mp3, flac, subrip, ... */
  codec: string;
  /** "High 10", "LC", ... */
  profile?: string;
  /** Video: pixel format (yuv420p, yuv420p10le, yuv444p...) */
  pixFmt?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Audio: "stereo", "5.1(side)", "mono" */
  channels?: string;
  language?: string;
  isDefault: boolean;
  /** Cover art stored as a video stream */
  attachedPic: boolean;
}

export interface MediaInfo {
  /** ffmpeg's demuxer name(s): "matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2", "avi" */
  container: string;
  durationSec?: number;
  streams: MediaStreamInfo[];
}

/** Parses the stream listing `ffmpeg -i` prints (stderr). Exported for the tests. */
export function parseFfmpegInfo(text: string): MediaInfo {
  const container = /^\s*Input #0, ([^\n]*?), from /m.exec(text)?.[1]?.trim() || '';
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : undefined;
  const streams: MediaStreamInfo[] = [];
  const re = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle|Data|Attachment): ([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rest = m[4];
    const fields = rest.split(/,\s*/);
    const first = fields[0] || '';
    const codec = (first.split(/\s+/)[0] || '').toLowerCase();
    const profile = /^\S+\s+\(([^)]*)\)/.exec(first)?.[1];
    const s: MediaStreamInfo = {
      index: Number(m[1]),
      kind: m[3].toLowerCase() as MediaStreamInfo['kind'],
      codec,
      profile: profile && !/\//.test(profile) ? profile : undefined,
      language: m[2] && m[2] !== 'und' ? m[2] : undefined,
      isDefault: /\(default\)/.test(rest),
      attachedPic: /\(attached pic\)/.test(rest),
    };
    if (s.kind === 'video') {
      // "yuv420p(tv, bt709, progressive)" -> yuv420p; the size and frame rate follow
      s.pixFmt = fields[1] ? fields[1].split('(')[0].trim() : undefined;
      const wh = /(\d{2,5})x(\d{2,5})/.exec(rest);
      if (wh) {
        s.width = Number(wh[1]);
        s.height = Number(wh[2]);
      }
      const fps = /([\d.]+) fps/.exec(rest);
      if (fps) s.fps = Number(fps[1]);
    } else if (s.kind === 'audio') {
      s.channels = fields.find((f) => /^(mono|stereo|quad|\d+\.\d+(\([a-z]+\))?|\d+ channels)/.test(f.trim()))?.trim();
    }
    streams.push(s);
  }
  return { container, durationSec, streams };
}

function runFfmpeg(args: string[], opts: { onStderr?: (line: string) => void; onStdout?: (line: string) => void; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    void detectFfmpeg().then((ff) => {
      if (!ff.available || !ff.path) return reject(new Error(`ffmpeg is not installed on this server (${ff.error})`));
      let child;
      try {
        child = spawn(ff.path, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return reject(e);
      }
      let stderr = '';
      let killed = false;
      const kill = (): void => {
        killed = true;
        try {
          child!.kill();
        } catch {
          /* gone */
        }
      };
      const timer = setTimeout(kill, opts.timeoutMs);
      const onAbort = (): void => kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const lines = (stream: NodeJS.ReadableStream, fn?: (l: string) => void, keep = false): void => {
        let buf = '';
        stream.on('data', (d: Buffer) => {
          buf += d.toString('utf8');
          // ffmpeg's progress lines end with \r; the listing with \n
          const parts = buf.split(/\r\n|\r|\n/);
          buf = parts.pop() || '';
          for (const l of parts) {
            if (keep) stderr = (stderr + l + '\n').slice(-12_000);
            fn?.(l);
          }
        });
        stream.on('end', () => {
          if (buf && keep) stderr = (stderr + buf + '\n').slice(-12_000);
          if (buf) fn?.(buf);
        });
      };
      lines(child.stdout!, opts.onStdout);
      lines(child.stderr!, opts.onStderr, true);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (opts.signal?.aborted) return reject(new Error('Cancelled'));
        if (killed) return reject(new Error(`ffmpeg was stopped after ${Math.round(opts.timeoutMs / 60000)} minutes`));
        resolve({ code, stderr });
      });
    }, reject);
  });
}

/** What a media file holds (its container, duration and streams). */
export async function probeMedia(file: string): Promise<MediaInfo> {
  // `-i` without an output lists the streams and exits 1 ("At least one output file must be specified")
  const { stderr } = await runFfmpeg(['-i', file], { timeoutMs: 60_000 });
  const info = parseFfmpegInfo(stderr);
  if (!info.container) {
    const err = stderr.split('\n').find((l) => /Invalid data|could not find|not found|Error/i.test(l)) || 'ffmpeg could not read the file';
    throw new Error(err.replace(/^\S+: /, '').trim());
  }
  return info;
}

export interface ConversionPlan {
  /** Nothing to do: the file is an MP4 whose streams the browsers decode */
  keep: boolean;
  video: MediaStreamInfo;
  audio?: MediaStreamInfo;
  videoCopy: boolean;
  audioCopy: boolean;
  /** For the page: "remuxed from MKV", "picture re-encoded to H.264 (10-bit H.264), sound to AAC (AC-3)" */
  note: string;
  /** The codec family of the output as the page's playability check names it: h264 / h265 / vp9 / av1 */
  vcodec: string;
  acodec?: string;
}

const CONTAINER_NAME = (c: string): string => (/matroska/.test(c) ? 'MKV' : /webm/.test(c) ? 'WebM' : /^avi/.test(c) ? 'AVI' : /mpegts/.test(c) ? 'MPEG-TS' : /^asf/.test(c) ? 'WMV' : /^flv/.test(c) ? 'FLV' : /mov|mp4/.test(c) ? 'MP4' : c.toUpperCase());
const VIDEO_NAME: Record<string, string> = { h264: 'H.264', hevc: 'H.265', vp9: 'VP9', av1: 'AV1', mpeg4: 'MPEG-4 part 2', mpeg2video: 'MPEG-2', vc1: 'VC-1', vp8: 'VP8', wmv3: 'WMV', msmpeg4v3: 'DivX', prores: 'ProRes', mjpeg: 'MJPEG' };
const AUDIO_NAME: Record<string, string> = { aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD', opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', mp2: 'MP2', flac: 'FLAC', pcm_s16le: 'PCM', alac: 'ALAC' };
const FAMILY: Record<string, string> = { h264: 'h264', hevc: 'h265', vp9: 'vp9', av1: 'av1' };

/** Which streams go into the MP4 and whether they can be copied as they are. Exported for the tests. */
export function planConversion(info: MediaInfo, nameHint = ''): ConversionPlan {
  const videos = info.streams.filter((s) => s.kind === 'video' && !s.attachedPic && !/^(mjpeg|png|bmp|gif)$/.test(s.codec));
  const video = videos[0];
  if (!video) throw new Error(`The file has no video stream (${info.streams.map((s) => `${s.kind} ${s.codec}`).join(', ') || 'nothing ffmpeg understands'})`);
  const audios = info.streams.filter((s) => s.kind === 'audio');
  const audio = audios.find((s) => s.isDefault) || audios[0];
  const isMp4 = /\b(mov|mp4)\b/.test(info.container);
  // 8-bit 4:2:0 H.264 / H.265 / VP9 / AV1 can go into an MP4 as they are; 10-bit and 4:4:4 the browsers do not decode
  const eightBit = !video.pixFmt || /^(yuv420p|yuvj420p|nv12)$/.test(video.pixFmt);
  const videoCopy = Boolean(FAMILY[video.codec]) && eightBit;
  const audioCopy = !audio || audio.codec === 'aac';
  const keep = isMp4 && videoCopy && audioCopy && videos.length === 1 && audios.length <= 1;
  const vName = `${VIDEO_NAME[video.codec] || video.codec}${video.pixFmt && !eightBit ? ` ${/10/.test(video.pixFmt) ? '10-bit' : /12/.test(video.pixFmt) ? '12-bit' : video.pixFmt}` : ''}`;
  const aName = audio ? AUDIO_NAME[audio.codec] || audio.codec : '';
  let note: string;
  if (keep) note = 'kept as it was';
  else {
    const bits: string[] = [];
    if (!videoCopy) bits.push(`picture re-encoded to H.264 (was ${vName})`);
    if (!audioCopy) bits.push(`sound re-encoded to AAC (was ${aName})`);
    // ffmpeg names MKV and WebM alike ("matroska,webm"): the file's own name tells them apart
    const from = /matroska/.test(info.container) && /\.webm$/i.test(nameHint) ? 'WebM' : CONTAINER_NAME(info.container);
    note = `${isMp4 ? 'rewritten' : `remuxed from ${from}`}${bits.length ? `, ${bits.join(', ')}` : ''}`;
    if (audios.length > 1 && audio) note += ` · ${audios.length} sound tracks, kept the ${audio.isDefault ? 'default' : 'first'} one${audio.language ? ` (${audio.language})` : ''}`;
  }
  return { keep, video, audio, videoCopy, audioCopy, note, vcodec: videoCopy ? FAMILY[video.codec] : 'h264', acodec: audio ? 'aac' : undefined };
}

export interface ConvertProgress {
  /** 0-100 when the duration is known */
  percent?: number;
  /** Media seconds done per real second */
  speed?: number;
  outTimeSec: number;
}

/**
 * Writes `out` (an MP4, moov first) from `input` according to `plan`. A re-encode is capped at
 * 1920 px wide (the small server) and runs with libx264's veryfast preset.
 */
export async function convertToMp4(input: string, out: string, plan: ConversionPlan, durationSec: number | undefined, opts: { onProgress: (p: ConvertProgress) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
  const args = ['-y', '-i', input, '-map', `0:${plan.video.index}`];
  if (plan.audio) args.push('-map', `0:${plan.audio.index}`);
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
  if (plan.videoCopy) {
    args.push('-c:v', 'copy');
    if (plan.video.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2");
  }
  if (plan.audio) {
    if (plan.audioCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', out);
  let lastSpeed: number | undefined;
  const { code, stderr } = await runFfmpeg(args, {
    timeoutMs: opts.timeoutMs ?? 6 * 60 * 60 * 1000,
    signal: opts.signal,
    onStdout: (line) => {
      const [k, v] = line.split('=');
      if (k === 'speed') {
        const n = parseFloat(v);
        if (Number.isFinite(n)) lastSpeed = n;
      } else if (k === 'out_time') {
        const t = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(v);
        if (!t) return;
        const sec = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        opts.onProgress({ outTimeSec: sec, speed: lastSpeed, percent: durationSec ? Math.min(100, (100 * sec) / durationSec) : undefined });
      }
    },
  });
  if (code !== 0) {
    const err = stderr.split('\n').filter((l) => l.trim() && !/^\s*(Stream|Input|Output|Metadata|Duration|Press|frame=|size=|\[.*\] .*(?:profile|configuration|using|kb\/s|ref|mb |coded|i16|i8|i4|transform|direct|weighted|consecutive|final))/i.test(l)).pop() || `ffmpeg exit ${code}`;
    throw new Error(err.trim());
  }
}

/** One frame of `file` at `atSec` as a JPEG (640 px wide). */
export async function frameToJpeg(file: string, atSec: number, out: string): Promise<void> {
  const { code, stderr } = await runFfmpeg(['-y', '-ss', String(Math.max(0, atSec)), '-i', file, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '3', out], { timeoutMs: 60_000 });
  if (code !== 0) throw new Error(stderr.trim().split('\n').pop() || `ffmpeg exit ${code}`);
}
