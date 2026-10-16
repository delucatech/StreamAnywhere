/**
 * The library's downloads: one task per video, for in-app playback or as a file on the device.
 *
 * In-app ("Download for in-app playback"):
 *   - 'job' options (YouTube): the server fetches and merges the parts (/api/download/start, polled),
 *     then the finished file is streamed from /api/download/jobs/:id/file into IndexedDB in parts.
 *   - 'stream' options (TikTok, Instagram, Facebook, plain files): the ready MP4 is streamed straight
 *     from the cookie-free CDN URL (CORS *), or through the same-origin proxy when that fails.
 *   The record that marks the video as present is written last, so an interrupted download leaves
 *   orphan parts (swept at the next start) and never a video that "exists" but cannot play.
 *
 * Device ("Save to device"):
 *   - a copy already downloaded here is exported as it is (no network);
 *   - 'stream' options go through the proxy with ?dl=<name> as a plain same-origin file download
 *     (the browser's own download, any size), or are fetched and handed over as a blob;
 *   - 'job' options wait for the server, then the file is offered ("Save file": the destination
 *     picker where the browser has one, otherwise the download folder / the Files app).
 */
import type { DownloadJob, LibraryEntry, LibraryOption } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';
import { canPickDestination, canShareFiles, storageInfo } from './capabilities';
import * as db from './db';
import type { LocalVideo } from './db';

export type TaskPhase = 'queued' | 'server' | 'fetching' | 'storing' | 'ready' | 'done' | 'error' | 'cancelled';

export interface Task {
  entryId: string;
  kind: 'inapp' | 'device';
  option: LibraryOption;
  phase: TaskPhase;
  /** 0-100 of the whole task when known */
  percent?: number;
  text: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  jobId?: string;
  partKey?: string;
  /** phase 'ready' (device): the file waits here; save() hands it to the user */
  save?: () => Promise<void>;
  abort: AbortController;
}

const tasks = new Map<string, Task>();
const listeners = new Set<() => void>();

export function onTasksChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (): void => listeners.forEach((fn) => fn());

export const taskFor = (entryId: string): Task | undefined => tasks.get(entryId);
export const allTasks = (): Task[] => [...tasks.values()];
export const isRunning = (t: Task | undefined): boolean => !!t && (t.phase === 'queued' || t.phase === 'server' || t.phase === 'fetching' || t.phase === 'storing');
/** Part keys of downloads in progress (their parts must survive the orphan sweep) */
export const activePartKeys = (): Set<string> => new Set([...tasks.values()].filter((t) => isRunning(t) && t.partKey).map((t) => t.partKey!));

export function dismiss(entryId: string): void {
  const t = tasks.get(entryId);
  if (t && !isRunning(t)) {
    tasks.delete(entryId);
    emit();
  }
}

export function cancel(entryId: string): void {
  const t = tasks.get(entryId);
  if (!t || !isRunning(t)) return;
  t.abort.abort();
  if (t.jobId) void api.downloadCancel(t.jobId).catch(() => undefined);
  finish(t, 'cancelled', 'Cancelled');
}

const fmtBytes = (n: number): string => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export { fmtBytes };

/** A file name for the device: the title without the characters file systems refuse. */
export function fileName(entry: LibraryEntry, option: { ext: string }): string {
  const base = (entry.title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${base || `video-${entry.sourceId || entry.id}`}.${option.ext || 'mp4'}`;
}

function set(t: Task, phase: TaskPhase, text: string, percent?: number): void {
  t.phase = phase;
  t.text = text;
  t.percent = percent;
  emit();
}

function finish(t: Task, phase: 'done' | 'error' | 'cancelled', text: string, error?: string): void {
  if (t.phase === 'done' || t.phase === 'error' || t.phase === 'cancelled') return;
  t.phase = phase;
  t.text = text;
  t.error = error;
  t.finishedAt = Date.now();
  if (phase === 'done') t.percent = 100;
  emit();
}

function start(entry: LibraryEntry, kind: Task['kind'], option: LibraryOption): Task {
  const old = tasks.get(entry.id);
  if (old && isRunning(old)) throw new Error('This video is already being downloaded');
  const t: Task = { entryId: entry.id, kind, option, phase: 'queued', text: 'Starting…', startedAt: Date.now(), abort: new AbortController() };
  tasks.set(entry.id, t);
  emit();
  return t;
}

const errText = (e: unknown): string => (e instanceof ApiError ? e.message : (e as Error)?.message || String(e));
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const id = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

// ---------------------------------------------------------------- the server job (YouTube)

/** Starts the server-side download and polls it to the end; returns the finished job. `share` = how much of the task's bar it takes. */
async function runJob(t: Task, probeId: string, share: number): Promise<DownloadJob> {
  set(t, 'server', 'Asking the server to fetch the video…');
  let job = await api.downloadStart(probeId, t.option.id);
  t.jobId = job.jobId;
  for (;;) {
    if (t.abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const p = job.progress;
    if (job.state === 'queued') set(t, 'server', job.queuePosition ? `Waiting for ${job.queuePosition} other download${job.queuePosition > 1 ? 's' : ''} on the server…` : 'Waiting for a turn on the server…');
    else if (job.state === 'downloading') {
      const bits = [`Server is fetching${p.part ? ` the ${p.part}` : ''}`];
      if (p.percent !== undefined) bits.push(`${Math.round(p.percent)}%`);
      bits.push(p.totalBytes ? `${fmtBytes(p.downloadedBytes)} of ${fmtBytes(p.totalBytes)}` : fmtBytes(p.downloadedBytes));
      if (p.speedBps) bits.push(`${fmtBytes(p.speedBps)}/s`);
      set(t, 'server', bits.join(' · '), p.percent !== undefined ? (p.percent * share) / 100 : undefined);
    } else if (job.state === 'merging') set(t, 'server', 'Server is merging picture and sound…', share * 0.98);
    else if (job.state === 'done') return job;
    else throw new Error(job.error || (job.state === 'cancelled' ? 'Cancelled on the server' : 'The server could not fetch the video'));
    await sleep(1000, t.abort.signal);
    try {
      job = await api.downloadJob(job.jobId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new Error(e.message);
      // a blip: ask again
    }
  }
}

// ---------------------------------------------------------------- streaming into IndexedDB

interface Stored {
  parts: number;
  bytes: number;
  mime: string;
}

/**
 * Streams `url` into parts under `partKey`; `base`/`share` place its progress on the task's bar. A
 * failure before the first byte lets the caller try the next URL.
 */
async function streamToParts(t: Task, url: string, partKey: string, sizeHint: number | undefined, base: number, share: number): Promise<Stored> {
  const res = await fetch(url, { mode: 'cors', credentials: 'same-origin', signal: t.abort.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0) || sizeHint || 0;
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim() || 'video/mp4';
  if (!res.body) throw new Error('The response has no body');
  const reader = res.body.getReader();
  let chunks: Uint8Array[] = [];
  let pending = 0;
  let got = 0;
  let index = 0;
  const flush = async (): Promise<void> => {
    if (!pending) return;
    const blob = new Blob(chunks as BlobPart[], { type: mime });
    chunks = [];
    pending = 0;
    try {
      await db.putPart(partKey, index++, blob);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === 'QuotaExceededError' || /quota/i.test((e as Error).message || '')) throw new Error('This browser ran out of storage for the video; free some space (delete other local videos) and try again');
      throw e;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    pending += value.byteLength;
    got += value.byteLength;
    const pct = total ? Math.min(100, (100 * got) / total) : undefined;
    set(t, 'storing', total ? `Saving to this browser · ${Math.round(pct!)}% · ${fmtBytes(got)} of ${fmtBytes(total)}` : `Saving to this browser · ${fmtBytes(got)}`, pct !== undefined ? base + (pct * share) / 100 : undefined);
    if (pending >= db.PART_BYTES) await flush();
  }
  await flush();
  if (!got) throw new Error('The file was empty');
  return { parts: index, bytes: got, mime };
}

async function enoughRoom(size: number | undefined): Promise<void> {
  if (!size) return;
  const s = await storageInfo();
  if (!s.quota) return;
  const free = s.quota - s.usage;
  if (free < size * 1.1) throw new Error(`Not enough storage in this browser: the video needs about ${fmtBytes(size)} and ${fmtBytes(Math.max(0, free))} is free. Delete other local videos or pick a lower quality.`);
}

/**
 * Download for in-app playback. `probeId` is required for 'job' options. A copy already present is
 * replaced only once the new one is complete.
 */
export async function downloadInApp(entry: LibraryEntry, option: LibraryOption, probeId?: string): Promise<void> {
  const t = start(entry, 'inapp', option);
  const partKey = `${entry.id}#${Date.now().toString(36)}`;
  t.partKey = partKey;
  try {
    await enoughRoom(option.sizeBytes);
    let stored: Stored | undefined;
    if (option.via === 'job') {
      if (!probeId) throw new Error('The quality list has expired: open the video again');
      const job = await runJob(t, probeId, 60);
      set(t, 'fetching', 'Fetching the finished file from the server…', 60);
      stored = await streamToParts(t, apiUrl(job.fileUrl!), partKey, job.sizeBytes, 60, 40);
    } else {
      const urls = [option.directUrl, option.proxyUrl ? apiUrl(option.proxyUrl) : undefined].filter((u): u is string => !!u);
      if (!urls.length) throw new Error('No downloadable URL for this quality');
      const errors: string[] = [];
      for (const url of urls) {
        set(t, 'fetching', 'Fetching the video…');
        try {
          stored = await streamToParts(t, url, partKey, option.sizeBytes, 0, 100);
          break;
        } catch (e) {
          if (t.abort.signal.aborted) throw e;
          errors.push(errText(e));
          await db.deleteParts(partKey).catch(() => undefined);
          if (/ran out of storage/.test(errText(e))) throw e;
        }
      }
      if (!stored) throw new Error(errors.join('; ') || 'The video could not be fetched');
    }
    const previous = await db.getVideo(entry.id);
    const video: LocalVideo = {
      entryId: entry.id,
      partKey,
      parts: stored.parts,
      sizeBytes: stored.bytes,
      mime: stored.mime,
      ext: option.ext || 'mp4',
      optionId: option.id,
      label: option.label,
      detail: option.detail,
      width: option.width,
      height: option.height,
      vcodec: option.vcodec,
      savedAt: Date.now(),
      title: entry.title,
    };
    await db.putVideo(video);
    if (previous && previous.partKey !== partKey) await db.deleteParts(previous.partKey).catch(() => undefined);
    finish(t, 'done', `Available on this browser · ${option.label} · ${fmtBytes(stored.bytes)}`);
  } catch (e) {
    await db.deleteParts(partKey).catch(() => undefined);
    if (t.abort.signal.aborted || (e as Error)?.name === 'AbortError') finish(t, 'cancelled', 'Cancelled');
    else finish(t, 'error', `Download failed: ${errText(e)}`, errText(e));
  }
}

// ---------------------------------------------------------------- files on the device

/** The browser's own download of a same-origin URL (Content-Disposition names the file). */
function anchorDownload(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

interface SavePicker {
  showSaveFilePicker(opts: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }): Promise<{ createWritable(): Promise<WritableStream & { write(data: Blob | BufferSource): Promise<void>; close(): Promise<void> }> }>;
}
const picker = (): SavePicker['showSaveFilePicker'] | undefined => (canPickDestination ? (window as unknown as SavePicker).showSaveFilePicker.bind(window) : undefined);
const mimeOf = (ext: string): string => (ext === 'm4a' ? 'audio/mp4' : ext === 'webm' ? 'video/webm' : ext === 'mkv' ? 'video/x-matroska' : 'video/mp4');

/** Hands a Blob to the user as a file: the destination picker when there is one, else the download folder. Returns false when the user cancelled. */
export async function exportBlob(blob: Blob, name: string): Promise<boolean> {
  const pick = picker();
  if (pick) {
    try {
      const handle = await pick({ suggestedName: name, types: [{ description: 'Video', accept: { [blob.type || 'video/mp4']: [`.${name.split('.').pop() || 'mp4'}`] } }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      // fall back to the plain download
    }
  }
  const url = URL.createObjectURL(blob);
  anchorDownload(url, name);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** The share sheet with the file (iPhone: "Save to Files", "Save Video"). False when not possible here. */
export async function shareBlob(blob: Blob, name: string): Promise<boolean> {
  if (!canShareFiles) return false;
  const file = new File([blob], name, { type: blob.type || 'video/mp4' });
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: name });
    return true;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return true;
    return false;
  }
}

/** Streams a same-origin URL into a file the user picked (progress on the task), or starts the browser's own download. */
async function saveUrl(t: Task, url: string, name: string, viaPickerFirst: boolean): Promise<void> {
  const pick = viaPickerFirst ? picker() : undefined;
  if (!pick) {
    anchorDownload(url, name);
    finish(t, 'done', 'The browser is saving the file (see its downloads)');
    return;
  }
  let handle;
  try {
    handle = await pick({ suggestedName: name, types: [{ description: 'Video', accept: { [mimeOf(name.split('.').pop() || 'mp4')]: [`.${name.split('.').pop() || 'mp4'}`] } }] });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      finish(t, 'cancelled', 'Cancelled');
      return;
    }
    anchorDownload(url, name);
    finish(t, 'done', 'The browser is saving the file (see its downloads)');
    return;
  }
  set(t, 'fetching', 'Saving the file…');
  const res = await fetch(url, { credentials: 'same-origin', signal: t.abort.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      got += chunk.byteLength;
      set(t, 'fetching', total ? `Saving the file · ${Math.round((100 * got) / total)}% · ${fmtBytes(got)} of ${fmtBytes(total)}` : `Saving the file · ${fmtBytes(got)}`, total ? (100 * got) / total : undefined);
      ctl.enqueue(chunk);
    },
  });
  await res.body.pipeThrough(counter).pipeTo(await handle.createWritable(), { signal: t.abort.signal });
  finish(t, 'done', `Saved ${name}${total ? ` (${fmtBytes(total)})` : ''}`);
}

/**
 * Save as a regular file on this device. `local` = a copy already downloaded here for the same
 * quality (exported directly). Must be called from a user gesture (the browser's file APIs insist).
 */
export async function saveToDevice(entry: LibraryEntry, option: LibraryOption, probeId?: string, local?: LocalVideo): Promise<void> {
  const t = start(entry, 'device', option);
  const name = fileName(entry, option);
  try {
    if (local && local.optionId === option.id) {
      set(t, 'fetching', 'Preparing the local copy…');
      const blob = await db.videoBlob(local);
      const ok = await exportBlob(blob, name);
      finish(t, ok ? 'done' : 'cancelled', ok ? `Saved ${name} (${fmtBytes(blob.size)})` : 'Cancelled');
      return;
    }
    if (option.via === 'job') {
      if (!probeId) throw new Error('The quality list has expired: open the video again');
      const job = await runJob(t, probeId, 100);
      const url = apiUrl(job.fileUrl!);
      const fname = job.fileName || name;
      // The user gesture is long gone: offer the file (its own "Save file" button picks the destination).
      t.save = async () => {
        t.save = undefined;
        await saveUrl(t, url, fname, true);
      };
      set(t, 'ready', `Ready: ${fname} (${fmtBytes(job.sizeBytes || 0)}). Tap "Save file".`, 100);
      if (!picker()) {
        // no picker anyway: start the browser's download right away (the button stays in case it did not)
        anchorDownload(url, fname);
      }
      return;
    }
    if (option.proxyUrl) {
      const url = `${apiUrl(option.proxyUrl)}${option.proxyUrl.includes('?') ? '&' : '?'}dl=${encodeURIComponent(name)}`;
      await saveUrl(t, url, name, true);
      return;
    }
    if (!option.directUrl) throw new Error('No downloadable URL for this quality');
    set(t, 'fetching', 'Fetching the video…');
    const res = await fetch(option.directUrl, { mode: 'cors', signal: t.abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const ok = await exportBlob(blob, name);
    finish(t, ok ? 'done' : 'cancelled', ok ? `Saved ${name} (${fmtBytes(blob.size)})` : 'Cancelled');
  } catch (e) {
    if (t.abort.signal.aborted || (e as Error)?.name === 'AbortError') finish(t, 'cancelled', 'Cancelled');
    else finish(t, 'error', `Could not save the file: ${errText(e)}`, errText(e));
  }
}
