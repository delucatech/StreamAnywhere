/**
 * Video Downloader (download.html): a pasted link -> the qualities on offer -> one file to save.
 *
 *  - probe:  one yt-dlp extraction (the warm daemon, 1-5 s) lists the formats; they are folded into
 *            one option per resolution (the best video at that height, merged with the best audio)
 *            plus "audio only". The extraction is kept for a while so the download does not repeat it.
 *  - job:    the yt-dlp command line downloads the chosen parts (bounded Range chunks, so googlevideo
 *            serves them at full speed) and merges them with ffmpeg (ffmpeg.ts) into one MP4 under
 *            the server's temp directory; its progress lines are parsed for the page (polled every
 *            second), and the finished file is served once by GET /api/download/jobs/:id/file.
 *  - sources: YouTube first. The others are listed to the page as "soon": TikTok's native resolver
 *            already gives a muxed MP4 to the feed, Instagram and Facebook need the saved cookies.
 *
 * Files live for a while after the download (DONE_TTL_MS) and are removed at startup, so a crash
 * cannot fill the disk. The e2-micro's disk is small: a file larger than DOWNLOAD_MAX_BYTES is refused.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { DownloadJob, DownloadOption, DownloadProbeResponse, DownloadSource } from '../../shared/types';
import { detectFfmpeg } from './ffmpeg';
import { isTikTokUrl } from './tiktok';
import { isYouTubeUrl, youTubeVideoId } from './youtube';
import { youtubeCookieFile } from './youtubeSession';
import { isInstagramUrl } from './instagram';
import { isFacebookUrl } from './facebook';
import { ytdlpCommand, ytdlpInfo } from './ytdlp';

export class DownloadError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
  }
}

/** The sources the page offers, in its order; `enabled` ones are served. */
export const DOWNLOAD_SOURCES: { id: DownloadSource; name: string; enabled: boolean }[] = [
  { id: 'youtube', name: 'YouTube', enabled: true },
  { id: 'tiktok', name: 'TikTok', enabled: false },
  { id: 'instagram', name: 'Instagram', enabled: false },
  { id: 'facebook', name: 'Facebook', enabled: false },
];

export function downloadSourceOf(url: string): DownloadSource {
  if (isYouTubeUrl(url)) return 'youtube';
  if (isTikTokUrl(url)) return 'tiktok';
  if (isInstagramUrl(url)) return 'instagram';
  if (isFacebookUrl(url)) return 'facebook';
  return 'other';
}

const PROBE_TIMEOUT_MS = 40_000;
const PROBE_TTL_MS = 20 * 60 * 1000;
const MAX_RUNNING = Math.max(1, Number(process.env.DOWNLOAD_PARALLEL) || 2);
const JOB_LIMIT_MS = 45 * 60 * 1000;
/** No new bytes for this long = stuck */
const STALL_MS = 4 * 60 * 1000;
const DONE_TTL_MS = 60 * 60 * 1000;
/** Deleted this long after the browser fetched the whole file */
const SERVED_TTL_MS = 5 * 60 * 1000;
export const MAX_BYTES = Number(process.env.DOWNLOAD_MAX_BYTES) || 2 * 1024 * 1024 * 1024;
const DIR = process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'streamanywhere-downloads');

let log: (m: string) => void = () => undefined;
export const setDownloaderLogger = (fn: (m: string) => void): void => {
  log = fn;
};

// ---------------------------------------------------------------- formats -> options

const CODEC_NAMES: [RegExp, string][] = [
  [/^avc1|^h264/i, 'H.264'],
  [/^av01/i, 'AV1'],
  [/^vp0?9/i, 'VP9'],
  [/^hev1|^hvc1|^h265/i, 'H.265'],
  [/^mp4a/i, 'AAC'],
  [/^opus/i, 'Opus'],
  [/^vorbis/i, 'Vorbis'],
];
const codecName = (c: string | undefined): string => (c ? CODEC_NAMES.find(([re]) => re.test(c))?.[1] || c.split('.')[0] : '?');
/** Preference between video codecs at the same resolution: H.264 plays everywhere, VP9 nearly, AV1 on new devices only. */
const codecRank = (c: string | undefined): number => (/^avc1|^h264/i.test(c || '') ? 3 : /^vp0?9/i.test(c || '') ? 2 : /^av01/i.test(c || '') ? 1 : 0);

const isHttp = (f: any): boolean => Boolean(f?.url) && /^https?$/.test(f.protocol || 'https');
const hasVideo = (f: any): boolean => Boolean(f.vcodec) && f.vcodec !== 'none';
const hasAudio = (f: any): boolean => Boolean(f.acodec) && f.acodec !== 'none';
const sizeOf = (f: any): { bytes?: number; estimate: boolean } => (typeof f.filesize === 'number' ? { bytes: f.filesize, estimate: false } : typeof f.filesize_approx === 'number' ? { bytes: f.filesize_approx, estimate: true } : { bytes: undefined, estimate: true });

/** The audio track to merge: AAC (plays everywhere) in the original language at the highest bitrate, no -drc variant. */
export function bestAudio(formats: any[]): any | undefined {
  const audio = formats.filter((f) => isHttp(f) && hasAudio(f) && !hasVideo(f));
  const score = (f: any): number => (/^mp4a/i.test(f.acodec) ? 10_000 : 0) + (/original/i.test(f.format_note || '') ? 1000 : 0) + (Number(f.abr || f.tbr) || 0) - (/drc/i.test(f.format_id || '') ? 10 : 0);
  return audio.sort((a, b) => score(b) - score(a))[0];
}

/** How a chosen option is downloaded: yt-dlp's -f spec, the container, and the parts' sizes (for the progress total). */
export interface OptionPlan {
  spec: string;
  ext: string;
  merge: boolean;
  parts: { id: string; kind: 'video' | 'audio' | 'video + audio'; bytes?: number }[];
}

/**
 * The qualities to offer, highest first: one per resolution (and frame rate above 30), the best
 * codec at it, merged with the best audio when the video has none; then "audio only".
 */
export function buildOptions(formats: any[]): { options: DownloadOption[]; plans: Map<string, OptionPlan> } {
  const options: DownloadOption[] = [];
  const plans = new Map<string, OptionPlan>();
  const audio = bestAudio(formats);
  const videos = formats.filter((f) => isHttp(f) && hasVideo(f) && Number(f.height) > 0 && !/storyboard|premium/i.test(f.format_note || ''));
  const groups = new Map<string, any[]>();
  for (const f of videos) {
    const fps = Number(f.fps) || 0;
    const key = `${f.height}${fps > 30 ? `p${Math.round(fps)}` : ''}`;
    groups.set(key, [...(groups.get(key) || []), f]);
  }
  const score = (f: any): number => codecRank(f.vcodec) * 1e6 + (Number(f.tbr) || 0) + (hasAudio(f) && !audio ? 1e5 : 0);
  const chosen = [...groups.entries()]
    .map(([key, list]) => ({ key, f: [...list].sort((a, b) => score(b) - score(a))[0] }))
    .sort((a, b) => (b.f.height || 0) - (a.f.height || 0) || (Number(b.f.fps) || 0) - (Number(a.f.fps) || 0));
  for (const { key, f } of chosen) {
    const fps = Number(f.fps) || 0;
    // "1080p" names the shorter side: a vertical Short of 1080x1920 is 1080p, not 1920p
    const p = Math.min(Number(f.height), Number(f.width) || Number(f.height));
    const merge = !hasAudio(f) && Boolean(audio);
    const vSize = sizeOf(f);
    const aSize = merge ? sizeOf(audio) : { bytes: 0, estimate: false };
    const bytes = vSize.bytes !== undefined && aSize.bytes !== undefined ? vSize.bytes + aSize.bytes : undefined;
    const acodec = merge ? audio.acodec : hasAudio(f) ? f.acodec : undefined;
    const ext = merge || /^(avc1|av01|vp0?9|h264)/i.test(f.vcodec) ? 'mp4' : f.ext || 'mp4';
    const id = `v${key}`;
    options.push({
      id,
      kind: 'video',
      label: `${p}p${fps > 30 ? Math.round(fps) : ''}`,
      detail: `${ext.toUpperCase()} · ${codecName(f.vcodec)}${acodec ? ` + ${codecName(acodec)}` : ' (no sound)'}`,
      width: f.width || undefined,
      height: f.height,
      fps: fps || undefined,
      vcodec: f.vcodec,
      acodec,
      ext,
      sizeBytes: bytes,
      sizeIsEstimate: bytes !== undefined ? vSize.estimate || aSize.estimate : undefined,
    });
    plans.set(id, {
      spec: merge ? `${f.format_id}+${audio.format_id}` : String(f.format_id),
      ext,
      merge,
      parts: merge ? [{ id: String(f.format_id), kind: 'video', bytes: vSize.bytes }, { id: String(audio.format_id), kind: 'audio', bytes: aSize.bytes }] : [{ id: String(f.format_id), kind: hasAudio(f) ? 'video + audio' : 'video', bytes: vSize.bytes }],
    });
  }
  // the first H.264 option at 1080p or below is the one most devices play as it is
  const rec = options.find((o) => /^avc1|^h264/i.test(o.vcodec || '') && Math.min(o.height || 0, o.width || o.height || 0) <= 1080) || options[0];
  if (rec) rec.recommended = true;
  if (audio) {
    const s = sizeOf(audio);
    const ext = /^mp4a/i.test(audio.acodec) ? 'm4a' : audio.ext || 'webm';
    options.push({
      id: 'audio',
      kind: 'audio',
      label: 'Audio only',
      detail: `${ext.toUpperCase()} · ${codecName(audio.acodec)}${audio.abr ? ` ${Math.round(audio.abr)} kbps` : ''}`,
      acodec: audio.acodec,
      ext,
      sizeBytes: s.bytes,
      sizeIsEstimate: s.bytes !== undefined ? s.estimate : undefined,
    });
    plans.set('audio', { spec: String(audio.format_id), ext, merge: false, parts: [{ id: String(audio.format_id), kind: 'audio', bytes: s.bytes }] });
  }
  return { options, plans };
}

// ---------------------------------------------------------------- probe

interface Probe {
  id: string;
  at: number;
  info: any;
  source: DownloadSource;
  response: DownloadProbeResponse;
  plans: Map<string, OptionPlan>;
  cookieFile?: string;
}
const probes = new Map<string, Probe>();

function classify(msg: string): DownloadError {
  if (/private|unavailable|not available|removed|does not exist|age/i.test(msg)) return new DownloadError(msg, 404);
  if (/sign in|bot|captcha/i.test(msg)) return new DownloadError(`The site refused the request from this server: ${msg}`, 503);
  return new DownloadError(msg);
}

export async function probeDownload(inputUrl: string): Promise<DownloadProbeResponse> {
  const t0 = Date.now();
  const source = downloadSourceOf(inputUrl);
  const def = DOWNLOAD_SOURCES.find((s) => s.id === source);
  if (!def) throw new DownloadError('That link is not from a supported site. Paste a YouTube link.', 400);
  if (!def.enabled) throw new DownloadError(`${def.name} links are not supported yet; YouTube links are.`, 400);
  let url = inputUrl;
  if (source === 'youtube') {
    const id = youTubeVideoId(inputUrl);
    if (!id) throw new DownloadError('That is not a YouTube video link (watch, shorts, youtu.be or embed).', 400);
    url = `https://www.youtube.com/watch?v=${id}`;
  }
  for (const [k, p] of probes) if (Date.now() - p.at > PROBE_TTL_MS) probes.delete(k);
  const cookieFile = source === 'youtube' ? youtubeCookieFile() : undefined;
  let info: any;
  let usedCookies = false;
  try {
    info = await ytdlpInfo({ url, noplaylist: true }, PROBE_TIMEOUT_MS);
  } catch (e) {
    const err = classify((e as Error).message);
    if (!cookieFile) throw err;
    log(`probe ${url}: guest extraction failed (${err.message.slice(0, 120)}); retrying with the account's cookies`);
    try {
      info = await ytdlpInfo({ url, noplaylist: true, cookieFile }, PROBE_TIMEOUT_MS);
      usedCookies = true;
    } catch (e2) {
      throw classify((e2 as Error).message);
    }
  }
  const formats: any[] = Array.isArray(info?.formats) ? info.formats : [];
  const { options, plans } = buildOptions(formats);
  if (!options.length) throw new DownloadError(`No downloadable format for this video (${formats.length} listed)`, 404);
  const warnings: string[] = [];
  if (info.is_live || info.live_status === 'is_live') warnings.push('This is a live stream: only what has been broadcast so far can be saved.');
  const probeId = crypto.randomBytes(8).toString('hex');
  const response: DownloadProbeResponse = {
    probeId,
    source,
    id: String(info.id || ''),
    url: info.webpage_url || url,
    title: info.title || undefined,
    author: info.channel || info.uploader || undefined,
    duration: typeof info.duration === 'number' ? info.duration : undefined,
    cover: info.thumbnail || undefined,
    options,
    warnings,
    elapsedMs: Date.now() - t0,
  };
  probes.set(probeId, { id: probeId, at: Date.now(), info, source, response, plans, cookieFile: usedCookies ? cookieFile : undefined });
  log(`probe ${source} ${response.id}: ${options.map((o) => o.label).join(', ')} in ${response.elapsedMs} ms`);
  return response;
}

// ---------------------------------------------------------------- jobs

interface Job {
  pub: DownloadJob;
  probe: Probe;
  plan: OptionPlan;
  proc?: ChildProcess;
  dir: string;
  filePath?: string;
  /** bytes of the parts already finished */
  doneBytes: number;
  lastBytesAt: number;
  servedAt?: number;
  killed: boolean;
  stderrTail: string;
}
const jobs = new Map<string, Job>();

const running = (): Job[] => [...jobs.values()].filter((j) => j.pub.state === 'downloading' || j.pub.state === 'merging');
const queued = (): Job[] => [...jobs.values()].filter((j) => j.pub.state === 'queued').sort((a, b) => a.pub.startedAt - b.pub.startedAt);

function cleanDir(): void {
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* nothing there */
  }
  fs.mkdirSync(DIR, { recursive: true });
}
let dirReady = false;

export async function startDownload(probeId: string, optionId: string): Promise<DownloadJob> {
  const probe = probes.get(probeId);
  if (!probe || Date.now() - probe.at > PROBE_TTL_MS) throw new DownloadError('That lookup has expired: look the link up again.', 410);
  const option = probe.response.options.find((o) => o.id === optionId);
  const plan = probe.plans.get(optionId);
  if (!option || !plan) throw new DownloadError('Unknown quality for this video', 400);
  if (option.sizeBytes && option.sizeBytes > MAX_BYTES) throw new DownloadError(`That file would be about ${(option.sizeBytes / 1048576 / 1024).toFixed(1)} GB; this server saves files up to ${Math.round(MAX_BYTES / 1048576 / 1024)} GB. Pick a lower quality.`, 413);
  const ytdlp = await ytdlpCommand();
  if (!ytdlp) throw new DownloadError('yt-dlp is not installed on this server', 503);
  if (plan.merge) {
    const ff = await detectFfmpeg();
    if (!ff.available) throw new DownloadError(`ffmpeg is not installed on this server, so video and audio cannot be merged (${ff.error})`, 503);
  }
  if (!dirReady) {
    cleanDir();
    dirReady = true;
  }
  const jobId = crypto.randomBytes(8).toString('hex');
  const dir = path.join(DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const total = plan.parts.every((p) => p.bytes !== undefined) ? plan.parts.reduce((n, p) => n + (p.bytes || 0), 0) : undefined;
  const job: Job = {
    pub: {
      jobId,
      state: 'queued',
      source: probe.source,
      title: probe.response.title,
      option,
      progress: { downloadedBytes: 0, totalBytes: total, percent: total ? 0 : undefined },
      startedAt: Date.now(),
      elapsedMs: 0,
    },
    probe,
    plan,
    dir,
    doneBytes: 0,
    lastBytesAt: Date.now(),
    killed: false,
    stderrTail: '',
  };
  jobs.set(jobId, job);
  pump();
  return snapshot(job);
}

function snapshot(j: Job): DownloadJob {
  const q = queued();
  return { ...j.pub, progress: { ...j.pub.progress }, elapsedMs: Date.now() - j.pub.startedAt, queuePosition: j.pub.state === 'queued' ? q.indexOf(j) : undefined };
}

export function getJob(jobId: string): DownloadJob | undefined {
  const j = jobs.get(jobId);
  return j && snapshot(j);
}

/** The finished file to serve (path, name, size), or undefined. */
export function jobFile(jobId: string): { path: string; fileName: string; sizeBytes: number; mime: string } | undefined {
  const j = jobs.get(jobId);
  if (!j || j.pub.state !== 'done' || !j.filePath || !j.pub.fileName || !fs.existsSync(j.filePath)) return undefined;
  const ext = path.extname(j.filePath).slice(1).toLowerCase();
  const mime = ext === 'mp4' ? 'video/mp4' : ext === 'm4a' ? 'audio/mp4' : ext === 'webm' ? (j.pub.option.kind === 'audio' ? 'audio/webm' : 'video/webm') : ext === 'mkv' ? 'video/x-matroska' : 'application/octet-stream';
  return { path: j.filePath, fileName: j.pub.fileName, sizeBytes: j.pub.sizeBytes || fs.statSync(j.filePath).size, mime };
}

/** The browser has the whole file: it can go soon. */
export function jobServed(jobId: string): void {
  const j = jobs.get(jobId);
  if (j) j.servedAt = Date.now();
}

export function cancelJob(jobId: string): DownloadJob | undefined {
  const j = jobs.get(jobId);
  if (!j) return undefined;
  if (j.pub.state === 'queued' || j.pub.state === 'downloading' || j.pub.state === 'merging') {
    finish(j, 'cancelled', 'Cancelled');
  }
  return snapshot(j);
}

/** A file name for the browser: the title without the characters file systems refuse. */
export function saveName(title: string | undefined, id: string, ext: string): string {
  const base = (title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${base || `video-${id}`}.${ext}`;
}

function pump(): void {
  while (running().length < MAX_RUNNING) {
    const next = queued()[0];
    if (!next) break;
    void run(next);
  }
}

const PROGRESS = 'SA-DL';

async function run(j: Job): Promise<void> {
  // out of the queue before the first await, or pump() would start it again
  j.pub.state = 'downloading';
  const ytdlp = (await ytdlpCommand())!;
  const ff = await detectFfmpeg();
  const infoFile = path.join(j.dir, 'info.json');
  try {
    fs.writeFileSync(infoFile, JSON.stringify(j.probe.info));
  } catch (e) {
    return finish(j, 'error', `Could not write to ${j.dir}: ${(e as Error).message}`);
  }
  const args = [
    ...ytdlp.args,
    '--no-warnings',
    '--no-playlist',
    '--no-mtime',
    '--newline',
    '--progress-template',
    `download:${PROGRESS}|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s|%(info.vcodec)s`,
    '-f',
    j.plan.spec,
    '-o',
    path.join(j.dir, `file.%(ext)s`),
    // the formats the user chose from, so the download does not look the video up again
    '--load-info-json',
    infoFile,
  ];
  if (j.plan.merge) args.push('--merge-output-format', j.plan.ext);
  if (ff.available && ff.path && ff.path !== 'ffmpeg') args.push('--ffmpeg-location', ff.path);
  if (j.probe.cookieFile) args.push('--cookies', j.probe.cookieFile);
  j.pub.progress.part = j.plan.parts[0]?.kind;
  j.lastBytesAt = Date.now();
  log(`job ${j.pub.jobId}: ${j.probe.source} ${j.probe.response.id} ${j.pub.option.label} (-f ${j.plan.spec}, ${j.pub.progress.totalBytes ? `${Math.round(j.pub.progress.totalBytes / 1048576)} MB` : 'size unknown'})`);
  let proc: ChildProcess;
  try {
    proc = spawn(ytdlp.cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: j.dir });
  } catch (e) {
    return finish(j, 'error', `yt-dlp could not start: ${(e as Error).message}`);
  }
  j.proc = proc;
  const onLine = (line: string): void => {
    if (line.startsWith(PROGRESS + '|')) return progress(j, line.split('|'));
    if (/^\[Merger\]|^\[ffmpeg\]|^\[ExtractAudio\]/.test(line)) {
      j.pub.state = 'merging';
      j.pub.progress.part = undefined;
      j.lastBytesAt = Date.now();
    }
  };
  readline.createInterface({ input: proc.stdout! }).on('line', onLine);
  readline.createInterface({ input: proc.stderr! }).on('line', (line) => {
    onLine(line);
    if (!line.startsWith(PROGRESS)) j.stderrTail = (j.stderrTail + line + '\n').slice(-1500);
  });
  const watchdog = setInterval(() => {
    if (j.pub.state !== 'downloading' && j.pub.state !== 'merging') return clearInterval(watchdog);
    if (Date.now() - j.pub.startedAt > JOB_LIMIT_MS) finish(j, 'error', `Gave up after ${Math.round(JOB_LIMIT_MS / 60000)} minutes`);
    else if (Date.now() - j.lastBytesAt > STALL_MS) finish(j, 'error', `Nothing arrived for ${Math.round(STALL_MS / 60000)} minutes; the download was stopped`);
  }, 5000);
  proc.on('error', (e) => finish(j, 'error', `yt-dlp failed to run: ${e.message}`));
  proc.on('close', (code) => {
    clearInterval(watchdog);
    j.proc = undefined;
    if (j.pub.state !== 'downloading' && j.pub.state !== 'merging') return; // cancelled / timed out already
    if (code !== 0) {
      const err = j.stderrTail.split(/\r?\n/).filter((l) => /ERROR/i.test(l)).pop() || j.stderrTail.trim().split(/\r?\n/).pop() || `exit ${code}`;
      return finish(j, 'error', err.replace(/^ERROR:\s*/, ''));
    }
    const file = fs
      .readdirSync(j.dir)
      .filter((f) => f.startsWith('file.') && !/\.(part|ytdl|json|temp)$/i.test(f) && !/^file\.f\d/.test(f))
      .map((f) => path.join(j.dir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    if (!file) return finish(j, 'error', 'yt-dlp finished but left no file');
    j.filePath = file;
    j.pub.sizeBytes = fs.statSync(file).size;
    j.pub.fileName = saveName(j.probe.response.title, j.probe.response.id, path.extname(file).slice(1) || j.plan.ext);
    j.pub.fileUrl = `/api/download/jobs/${j.pub.jobId}/file`;
    j.pub.progress = { downloadedBytes: j.pub.sizeBytes, totalBytes: j.pub.sizeBytes, percent: 100 };
    finish(j, 'done');
  });
}

/** One progress line: SA-DL|status|downloaded|total|total_estimate|speed|eta|format_id|vcodec */
function progress(j: Job, f: string[]): void {
  const num = (s: string | undefined): number | undefined => {
    const n = Number(s);
    return s && s !== 'NA' && Number.isFinite(n) ? n : undefined;
  };
  const status = f[1];
  const downloaded = num(f[2]) || 0;
  const partTotal = num(f[3]) ?? num(f[4]);
  const formatId = f[7];
  const vcodec = f[8];
  const part = j.plan.parts.find((p) => p.id === formatId);
  const p = j.pub.progress;
  if (status === 'finished') {
    j.doneBytes += partTotal ?? downloaded;
    p.downloadedBytes = j.doneBytes;
    p.speedBps = undefined;
    p.etaSec = undefined;
    j.lastBytesAt = Date.now();
    if (part && j.plan.parts.length > 1 && j.plan.parts.indexOf(part) === j.plan.parts.length - 1) p.part = undefined;
    return;
  }
  if (status !== 'downloading') return;
  if (downloaded > 0) j.lastBytesAt = Date.now();
  p.part = part?.kind || (vcodec && vcodec !== 'none' ? 'video' : 'audio');
  p.downloadedBytes = j.doneBytes + downloaded;
  p.speedBps = num(f[5]);
  // the total: the probe's sum of the parts, else what yt-dlp knows of this part on top of the finished ones
  const total = p.totalBytes ?? (partTotal !== undefined ? j.doneBytes + partTotal : undefined);
  if (total) {
    p.percent = Math.min(100, Math.round((1000 * p.downloadedBytes) / total) / 10);
    p.etaSec = p.speedBps ? Math.round((total - p.downloadedBytes) / p.speedBps) : num(f[6]);
  } else {
    p.percent = undefined;
    p.etaSec = num(f[6]);
  }
  j.pub.state = 'downloading';
}

function finish(j: Job, state: 'done' | 'error' | 'cancelled', error?: string): void {
  if (j.pub.state === 'done' || j.pub.state === 'error' || j.pub.state === 'cancelled') return;
  j.pub.state = state;
  j.pub.error = error;
  j.pub.elapsedMs = Date.now() - j.pub.startedAt;
  if (j.proc && !j.killed) {
    j.killed = true;
    try {
      j.proc.kill();
    } catch {
      /* gone */
    }
  }
  if (state === 'done') log(`job ${j.pub.jobId}: done, ${j.pub.fileName} (${Math.round((j.pub.sizeBytes || 0) / 1048576)} MB) in ${Math.round(j.pub.elapsedMs / 1000)} s`);
  else {
    log(`job ${j.pub.jobId}: ${state}${error ? ` - ${error.slice(0, 200)}` : ''}`);
    // the process may still hold the files for a moment
    setTimeout(() => removeFiles(j), 1500);
  }
  pump();
}

function removeFiles(j: Job): void {
  try {
    fs.rmSync(j.dir, { recursive: true, force: true });
  } catch {
    /* already gone, or still held: the next sweep tries again */
  }
}

/** Finished files go after DONE_TTL_MS (SERVED_TTL_MS once fetched); failed jobs are forgotten after a while. */
function sweep(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    const s = j.pub.state;
    if (s === 'downloading' || s === 'merging' || s === 'queued') continue;
    const age = now - j.pub.startedAt - j.pub.elapsedMs;
    const expired = s === 'done' ? (j.servedAt ? now - j.servedAt > SERVED_TTL_MS : age > DONE_TTL_MS) : age > 10 * 60 * 1000;
    if (!expired) continue;
    removeFiles(j);
    if (!fs.existsSync(j.dir)) jobs.delete(id);
  }
}
setInterval(sweep, 60_000).unref();

export function shutdownDownloader(): void {
  for (const j of jobs.values()) if (j.proc) finish(j, 'cancelled', 'Server stopped');
}

export const downloaderStats = (): { jobs: number; running: number; queued: number; dir: string } => ({ jobs: jobs.size, running: running().length, queued: queued().length, dir: DIR });
