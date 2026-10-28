/**
 * "Download to library": the video fetched once to the server, kept in LIBRARY_DIR/files, served
 * to every browser from /api/library/file/:id.
 *
 *  - A plain file link (MP4, MKV, WebM, AVI...) is downloaded as it is (http or https, redirects
 *    followed, each hop checked to be a public address). A platform video (YouTube, TikTok,
 *    Instagram, Facebook) goes through the same paths the browsers use: the recommended quality
 *    of entryOptions(), a server job for YouTube (yt-dlp + ffmpeg merge) or the ready MP4 for the
 *    others, so nothing is looked up twice.
 *  - The file is then inspected with ffmpeg (ffmpeg.ts: probeMedia / planConversion). An MP4 whose
 *    streams the browsers decode is kept as it is; anything else becomes one: a remux when the
 *    codecs are fine (MKV with H.264 + AAC: seconds), a re-encode when they are not (10-bit H.264,
 *    AC-3 / DTS sound: slow on the e2-micro, so the page says so).
 *  - Progress lives on the entry (`file`: state, percent, text) and reaches the pages through the
 *    library's poll. One import runs at a time; a server restart re-queues what was running (twice
 *    at most). Removing the entry, or "Delete the server copy", stops a running import.
 *  - Disk: a file larger than DOWNLOAD_MAX_BYTES (2 GB) is refused, and the files together may not
 *    pass LIBRARY_FILES_MAX_BYTES (15 GB): the VM's disk is 30 GB.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as path from 'node:path';
import type { LibraryEntry, LibraryFile, LibraryOption, LibrarySaveHint } from '../../shared/types';
import { config } from './config';
import { cancelJob, getJob, jobFile, jobServed, MAX_BYTES, startDownload } from './downloader';
import { convertToMp4, frameToJpeg, planConversion, probeMedia } from './ffmpeg';
import { canonicalize, entryFilePath, entryOptions, getEntry, libraryFilesDir, libraryLog as log, libraryState, libraryThumbsDir, LibraryError, markChanged, normalizeUrl, removeThumb, saveLink, setRemoveHook } from './library';
import { getMedia } from './mediaStore';
import { assertPublicHost } from './ssrf';

export const FILES_MAX_BYTES = Number(process.env.LIBRARY_FILES_MAX_BYTES) || 15 * 1024 * 1024 * 1024;
const MAX_RUNNING = Math.max(1, Number(process.env.LIBRARY_IMPORT_PARALLEL) || 1);
/** No new bytes for this long = stuck */
const STALL_MS = 3 * 60 * 1000;
const DOWNLOAD_LIMIT_MS = 3 * 60 * 60 * 1000;

const fmtBytes = (n: number): string => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface Running {
  id: string;
  abort: AbortController;
  jobId?: string;
}
const running = new Map<string, Running>();
const queue: string[] = [];

const busy = (f: LibraryFile | undefined): boolean => !!f && (f.state === 'queued' || f.state === 'downloading' || f.state === 'converting');

function update(e: LibraryEntry, patch: Partial<LibraryFile>): void {
  e.file = { ...(e.file || { state: 'queued', startedAt: Date.now(), attempts: 1 }), ...patch };
  e.updatedAt = Date.now();
  markChanged();
}

/** Bytes of the server copies that are there (the budget check). */
export function filesBytes(): number {
  return libraryState().entries.reduce((n, e) => n + (e.file?.state === 'ready' ? e.file.sizeBytes || 0 : 0), 0);
}

// ---------------------------------------------------------------- starting

/** "Download to library" for a pasted link: the entry is saved (or found) and the import queued. */
export function importLink(rawUrl: string, categoryIds: string[] = [], hint?: LibrarySaveHint): { entry: LibraryEntry; duplicate: boolean; importStarted: boolean } {
  // a plain file's details come from the file itself; a platform video is looked up as usual (title, cover)
  const url = normalizeUrl(rawUrl);
  const r = saveLink(url, categoryIds, { lookup: canonicalize(url).source !== 'other', hint });
  const started = startImport(r.entry.id);
  return { entry: r.entry, duplicate: r.duplicate, importStarted: started };
}

/** Queues the import of an entry; false when a copy is there already or an import is running. */
export function startImport(id: string): boolean {
  const e = getEntry(id);
  if (!e) throw new LibraryError('That video is no longer in the library', 404);
  if (e.file?.state === 'ready') return false;
  if (busy(e.file)) return false;
  if (e.unavailable) throw new LibraryError(`This video is no longer available at its source (${e.unavailable.reason})`, 404);
  update(e, { state: 'queued', percent: undefined, text: 'Waiting for a turn on the server…', error: undefined, startedAt: Date.now(), finishedAt: undefined, attempts: 1 });
  queue.push(id);
  pump();
  return true;
}

export function cancelImport(id: string): LibraryEntry {
  const e = getEntry(id);
  if (!e) throw new LibraryError('That video is no longer in the library', 404);
  stop(e);
  if (busy(e.file)) {
    e.file = undefined;
    e.updatedAt = Date.now();
    markChanged();
    log(`import ${id} cancelled`);
  }
  return e;
}

/** Forgets a failed import (the entry stays a link). */
export function dismissImport(id: string): LibraryEntry {
  const e = getEntry(id);
  if (!e) throw new LibraryError('That video is no longer in the library', 404);
  if (e.file?.state === 'error') {
    e.file = undefined;
    e.updatedAt = Date.now();
    markChanged();
  }
  return e;
}

function stop(e: LibraryEntry): void {
  const qi = queue.indexOf(e.id);
  if (qi >= 0) queue.splice(qi, 1);
  const r = running.get(e.id);
  if (r) {
    r.abort.abort();
    if (r.jobId) cancelJob(r.jobId);
  }
}
setRemoveHook(stop);

/** After a restart: imports that were running start over (a couple of times, then they are given up). */
export function resumeImports(): void {
  for (const e of libraryState().entries) {
    if (!busy(e.file)) continue;
    const attempts = (e.file!.attempts || 1) + 1;
    if (attempts > 3) {
      update(e, { state: 'error', error: 'The server restarted during the download, several times; try again later', text: undefined, percent: undefined, finishedAt: Date.now() });
      continue;
    }
    update(e, { state: 'queued', percent: undefined, text: 'Starting over after a server restart…', attempts });
    queue.push(e.id);
    log(`import ${e.id} resumed after a restart (attempt ${attempts})`);
  }
  pump();
}

function pump(): void {
  while (running.size < MAX_RUNNING && queue.length) {
    const id = queue.shift()!;
    const e = getEntry(id);
    if (!e || e.file?.state !== 'queued') continue;
    const r: Running = { id, abort: new AbortController() };
    running.set(id, r);
    void run(e, r).finally(() => {
      running.delete(id);
      pump();
    });
  }
}

// ---------------------------------------------------------------- the import itself

async function run(e: LibraryEntry, r: Running): Promise<void> {
  const t0 = Date.now();
  const dir = libraryFilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${e.id}.src`);
  const outTmp = path.join(dir, `${e.id}.mp4.part`);
  const cleanup = (): void => {
    for (const f of [src, outTmp]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* not there */
      }
    }
  };
  const gone = (): boolean => !getEntry(e.id) || r.abort.signal.aborted;
  // The source dropping the connection mid-file ("aborted", a reset): TikTok's CDN does that to
  // slow parallel streams from one address (the browser saving its own copy at the same time). A
  // second attempt a moment later usually sails through, so one is made before giving up.
  const fetchOnce = async (): Promise<string | undefined> => {
    if (e.source === 'other') {
      await fetchFile(e, r, src);
      return undefined;
    }
    return fetchPlatform(e, r, src);
  };
  const dropped = (err: unknown): boolean => /^aborted$|ECONNRESET|socket hang up|stopped at /i.test((err as Error)?.message || String(err));
  try {
    let label: string | undefined;
    try {
      label = await fetchOnce();
    } catch (err) {
      if (gone() || !dropped(err)) throw err;
      log(`import ${e.id}: the source dropped the connection (${(err as Error).message}); trying once more`);
      update(e, { text: 'The source dropped the connection; trying again…', percent: undefined });
      await new Promise((res) => setTimeout(res, 3000));
      if (gone()) throw new Error('Cancelled');
      label = await fetchOnce();
    }
    if (gone()) throw new Error('Cancelled');
    update(e, { state: 'converting', percent: undefined, text: 'Reading the file…' });
    const info = await probeMedia(src);
    const plan = planConversion(info, e.file?.originalName || e.url);
    const video = plan.video;
    let outPath: string;
    if (plan.keep) {
      fs.renameSync(src, outTmp);
      outPath = outTmp;
    } else {
      const what = plan.videoCopy ? (plan.audioCopy ? 'Converting to MP4' : 'Converting to MP4 (sound re-encoded)') : 'Re-encoding the picture to H.264 (slow on this server)';
      update(e, { text: `${what}…` });
      let lastAt = 0;
      await convertToMp4(src, outTmp, plan, info.durationSec, {
        signal: r.abort.signal,
        onProgress: (p) => {
          if (Date.now() - lastAt < 1000) return;
          lastAt = Date.now();
          update(e, { percent: p.percent, text: `${what}${p.percent !== undefined ? ` · ${Math.round(p.percent)}%` : ''}${p.speed ? ` · ${p.speed.toFixed(p.speed < 1 ? 2 : 1)}× real time` : ''}` });
        },
      });
      outPath = outTmp;
      try {
        fs.unlinkSync(src);
      } catch {
        /* fine */
      }
    }
    if (gone()) throw new Error('Cancelled');
    const size = fs.statSync(outPath).size;
    if (size + filesBytes() > FILES_MAX_BYTES) throw new Error(`The library's files would pass ${fmtBytes(FILES_MAX_BYTES)} on the server (${fmtBytes(filesBytes())} used); delete a server copy first`);
    const final = path.join(dir, `${e.id}.mp4`);
    fs.renameSync(outPath, final);
    // the entry's details from the file: length, size, a thumbnail when the source gave none
    if (info.durationSec && !e.duration) e.duration = info.durationSec;
    if (video.width && video.height) {
      e.width = video.width;
      e.height = video.height;
    }
    if (!e.thumb) await thumbnail(e, final, info.durationSec);
    e.unavailable = undefined;
    update(e, { state: 'ready', percent: 100, text: undefined, error: undefined, sizeBytes: size, ext: 'mp4', mime: 'video/mp4', vcodec: plan.vcodec, acodec: plan.acodec, note: plan.note, label, finishedAt: Date.now() });
    log(`import ${e.id} (${e.source}): ${fmtBytes(size)}, ${plan.note}, in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (err) {
    cleanup();
    const msg = ((err as Error).message || String(err)).slice(0, 300);
    const cur = getEntry(e.id);
    if (!cur) return log(`import ${e.id}: entry removed meanwhile`);
    if (r.abort.signal.aborted || /^Cancelled$/.test(msg)) return log(`import ${e.id}: stopped`);
    update(e, { state: 'error', error: msg, text: undefined, percent: undefined, finishedAt: Date.now() });
    log(`import ${e.id} (${e.source}) failed after ${Math.round((Date.now() - t0) / 1000)} s: ${msg}`);
  }
}

async function thumbnail(e: LibraryEntry, file: string, durationSec: number | undefined): Promise<void> {
  try {
    const at = durationSec ? Math.min(30, Math.max(1, durationSec * 0.1)) : 1;
    const thumbs = libraryThumbsDir();
    fs.mkdirSync(thumbs, { recursive: true });
    // not `<id>.…`: removeThumb() deletes every file whose name starts with the id
    const tmp = path.join(thumbs, `part-${e.id}.jpg`);
    await frameToJpeg(file, at, tmp);
    removeThumb(e.id);
    fs.renameSync(tmp, path.join(thumbs, `${e.id}.jpg`));
    e.thumb = `/api/library/thumb/${e.id}?v=${Date.now().toString(36)}`;
  } catch (err) {
    log(`thumbnail of ${e.id} not made: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- a platform video: the recommended quality

async function fetchPlatform(e: LibraryEntry, r: Running, dest: string): Promise<string | undefined> {
  update(e, { state: 'downloading', text: 'Asking the source which qualities it offers…' });
  const resp = await entryOptions(e.id);
  const videos = resp.options.filter((o) => o.kind === 'video');
  const o: LibraryOption | undefined = videos.find((x) => x.recommended) || videos[0];
  if (!o) throw new Error('No video quality is on offer for this link');
  if (o.sizeBytes && o.sizeBytes > MAX_BYTES) throw new Error(`That file is about ${fmtBytes(o.sizeBytes)}; this server keeps files up to ${fmtBytes(MAX_BYTES)}`);
  if (o.via === 'job') {
    if (!resp.probeId) throw new Error('The quality list has no download handle');
    let job = await startDownload(resp.probeId, o.id);
    r.jobId = job.jobId;
    for (;;) {
      if (r.abort.signal.aborted) throw new Error('Cancelled');
      const p = job.progress;
      if (job.state === 'queued') update(e, { text: job.queuePosition ? `Waiting for ${job.queuePosition} other download${job.queuePosition > 1 ? 's' : ''} on the server…` : 'Waiting for a turn on the server…' });
      else if (job.state === 'downloading') update(e, { percent: p.percent, text: `Fetching ${o.label}${p.part ? ` (${p.part})` : ''}${p.percent !== undefined ? ` · ${Math.round(p.percent)}%` : ''} · ${p.totalBytes ? `${fmtBytes(p.downloadedBytes)} of ${fmtBytes(p.totalBytes)}` : fmtBytes(p.downloadedBytes)}${p.speedBps ? ` · ${fmtBytes(p.speedBps)}/s` : ''}` });
      else if (job.state === 'merging') update(e, { percent: 99, text: 'Merging picture and sound…' });
      else if (job.state === 'done') break;
      else throw new Error(job.error || (job.state === 'cancelled' ? 'Cancelled' : 'The server could not fetch the video'));
      await new Promise((res) => setTimeout(res, 1000));
      job = getJob(job.jobId) || job;
    }
    const f = jobFile(job.jobId);
    if (!f) throw new Error('The downloaded file is not there any more');
    try {
      fs.renameSync(f.path, dest);
    } catch {
      fs.copyFileSync(f.path, dest);
    }
    jobServed(job.jobId);
    return o.label;
  }
  // a ready MP4: the cookie-free URL, else the proxy's record (URL + the headers it needs)
  let url = o.directUrl;
  let headers: Record<string, string> = {};
  if (!url && o.proxyUrl) {
    const rec = getMedia(o.proxyUrl.replace(/^\/api\/media\//, '').split('?')[0]);
    if (rec) {
      url = rec.url;
      headers = rec.headers;
    }
  }
  if (!url) throw new Error('No downloadable URL for this quality');
  await download(e, r, url, headers, dest, o.sizeBytes);
  return o.label;
}

// ---------------------------------------------------------------- a plain file

async function fetchFile(e: LibraryEntry, r: Running, dest: string): Promise<void> {
  update(e, { state: 'downloading', text: 'Connecting…' });
  await download(e, r, e.url, {}, dest);
}

const VIDEO_TYPE = /^(video\/|application\/octet-stream|application\/mp4|application\/x-matroska|binary\/octet-stream)/i;

/** Opens `rawUrl` for reading, following redirects; every hop must be http(s) to a public address. */
async function open(rawUrl: string, headers: Record<string, string>, signal: AbortSignal, redirectsLeft = 6): Promise<{ res: IncomingMessage; finalUrl: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('That is not a valid link');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links can be downloaded');
  if (url.username || url.password) throw new Error('Links with a user name or password are not accepted');
  await assertPublicHost(url.hostname);
  const mod = url.protocol === 'https:' ? https : http;
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = mod.request(url, { method: 'GET', headers: { 'user-agent': config.userAgent, accept: '*/*', 'accept-encoding': 'identity', ...headers }, timeout: 30_000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('The site did not answer within 30 s')));
    req.on('error', reject);
    const onAbort = (): void => {
      req.destroy(new Error('Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', onAbort));
    req.end();
  });
  const status = res.statusCode || 0;
  if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
    res.resume();
    if (!redirectsLeft) throw new Error('Too many redirects');
    return open(new URL(res.headers.location, url).toString(), headers, signal, redirectsLeft - 1);
  }
  return { res, finalUrl: url.toString() };
}

/** Streams `url` into `dest` with progress on the entry; refuses web pages and files over the limit. */
async function download(e: LibraryEntry, r: Running, url: string, headers: Record<string, string>, dest: string, sizeHint?: number): Promise<void> {
  const { res, finalUrl } = await open(url, headers, r.abort.signal);
  const status = res.statusCode || 0;
  if (status >= 400) {
    res.resume();
    throw new Error(status === 404 ? 'The link answered 404: the file is not there' : status === 403 ? 'The site refused the download (HTTP 403)' : `The link answered HTTP ${status}`);
  }
  const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const name = (() => {
    const cd = String(res.headers['content-disposition'] || '');
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    if (m) {
      try {
        return decodeURIComponent(m[1]).trim();
      } catch {
        return m[1].trim();
      }
    }
    try {
      return decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      return '';
    }
  })();
  const looksLikeVideo = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|flv|wmv|mpg|mpeg|3gp|ogv)$/i.test(name);
  if (type && !VIDEO_TYPE.test(type) && !looksLikeVideo) {
    res.resume();
    throw new Error(/^text\/html/.test(type) ? 'That link is a web page, not a video file. For YouTube, TikTok, Instagram and Facebook paste the video link; for other sites a direct link to the file (.mp4, .mkv...) is needed.' : `The link is not a video file (${type})`);
  }
  const total = Number(res.headers['content-length']) || sizeHint || 0;
  if (total > MAX_BYTES) {
    res.resume();
    throw new Error(`That file is ${fmtBytes(total)}; this server keeps files up to ${fmtBytes(MAX_BYTES)}`);
  }
  if (total && total + filesBytes() > FILES_MAX_BYTES) {
    res.resume();
    throw new Error(`The library's files would pass ${fmtBytes(FILES_MAX_BYTES)} on the server (${fmtBytes(filesBytes())} used); delete a server copy first`);
  }
  if (name && !e.titleEdited && e.source === 'other') {
    const t = name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').trim();
    if (t) e.title = t.slice(0, 300);
  }
  update(e, { originalName: name || undefined, text: total ? `Fetching ${fmtBytes(total)}…` : 'Fetching…', percent: total ? 0 : undefined });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let got = 0;
    let lastAt = Date.now();
    let lastReport = 0;
    const t0 = Date.now();
    const fail = (err: Error): void => {
      clearInterval(watch);
      res.destroy();
      out.destroy();
      reject(err);
    };
    const watch = setInterval(() => {
      if (Date.now() - lastAt > STALL_MS) fail(new Error(`Nothing arrived for ${Math.round(STALL_MS / 60000)} minutes; the download was stopped`));
      else if (Date.now() - t0 > DOWNLOAD_LIMIT_MS) fail(new Error(`Gave up after ${Math.round(DOWNLOAD_LIMIT_MS / 3600000)} hours`));
    }, 5000);
    const onAbort = (): void => fail(new Error('Cancelled'));
    r.abort.signal.addEventListener('abort', onAbort, { once: true });
    res.on('data', (chunk: Buffer) => {
      got += chunk.length;
      lastAt = Date.now();
      if (got > MAX_BYTES) return fail(new Error(`The file passed ${fmtBytes(MAX_BYTES)}, the most this server keeps`));
      if (Date.now() - lastReport > 1000) {
        lastReport = Date.now();
        const secs = (Date.now() - t0) / 1000;
        const speed = secs > 0.5 ? got / secs : 0;
        update(e, { percent: total ? Math.min(100, (100 * got) / total) : undefined, text: `Fetching${total ? ` ${Math.round((100 * got) / total)}% · ${fmtBytes(got)} of ${fmtBytes(total)}` : ` ${fmtBytes(got)}`}${speed ? ` · ${fmtBytes(speed)}/s` : ''}` });
      }
    });
    res.on('error', fail);
    out.on('error', (err) => fail((err as NodeJS.ErrnoException).code === 'ENOSPC' ? new Error('The server ran out of disk space') : err));
    res.pipe(out);
    out.on('finish', () => {
      clearInterval(watch);
      r.abort.signal.removeEventListener('abort', onAbort);
      if (!got) return reject(new Error('The file was empty'));
      if (total && got < total) return reject(new Error(`The download stopped at ${fmtBytes(got)} of ${fmtBytes(total)}`));
      resolve();
    });
  });
}

// ---------------------------------------------------------------- serving

/** The server copy to serve, or undefined. */
export function fileInfo(id: string): { path: string; size: number; mime: string; name: string } | undefined {
  const e = getEntry(id);
  if (!e || e.file?.state !== 'ready') return undefined;
  const p = entryFilePath(e);
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return undefined;
  }
  const base = (e.title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return { path: p, size, mime: e.file.mime || 'video/mp4', name: `${base || `video-${e.id}`}.${e.file.ext || 'mp4'}` };
}

/** Files in LIBRARY_DIR/files that belong to no entry (an interrupted import, a removed entry): removed at startup. */
export function sweepFiles(): void {
  const dir = libraryFilesDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const keep = new Set(libraryState().entries.filter((e) => e.file?.state === 'ready').map((e) => path.basename(entryFilePath(e))));
  const live = new Set(libraryState().entries.filter((e) => busy(e.file)).map((e) => e.id));
  for (const n of names) {
    if (keep.has(n)) continue;
    if (live.has(n.split('.')[0])) continue;
    try {
      fs.unlinkSync(path.join(dir, n));
      log(`removed stray file ${n}`);
    } catch {
      /* fine */
    }
  }
}

export const importStats = (): { running: number; queued: number; files: number; fileBytes: number; maxBytes: number } => ({ running: running.size, queued: queue.length, files: libraryState().entries.filter((e) => e.file?.state === 'ready').length, fileBytes: filesBytes(), maxBytes: FILES_MAX_BYTES });
