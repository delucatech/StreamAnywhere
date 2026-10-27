/**
 * Video Library: the links every browser of this site shares, with their details and categories.
 *
 *  - The library is one JSON file (LIBRARY_DIR, default next to the cookie secret: /var/lib/streamanywhere
 *    on the VM, ~/.streamanywhere on a PC), written atomically; `rev` grows with every change so the
 *    pages can ask "anything new since N?" cheaply (they poll).
 *  - Saving a link stores it at once (title = a placeholder) and looks its details up in the
 *    background: YouTube through yt-dlp (the downloader's probe), the others through the same
 *    resolvers the feed uses. A failed lookup leaves the entry, with an editable title.
 *  - Thumbnails are copied to LIBRARY_DIR/thumbs once (TikTok / Instagram / Facebook cover URLs
 *    expire within days) and served from /api/library/thumb/:id.
 *  - options(): the qualities a browser can get right now. YouTube = the downloader's options
 *    (server job: parts merged with ffmpeg); the others = ready MP4s the browser fetches itself.
 *  - Video files are not kept here unless asked: a browser downloads a copy for itself (IndexedDB),
 *    or saves a file on its device. "Download to library" (libraryFiles.ts) is the exception: the
 *    server fetches the video once into LIBRARY_DIR/files, converts it to an MP4 the browsers
 *    decode when it is not one (MKV, WebM, AC-3 sound...), and every device gets it from there.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LibraryCategory, LibraryEntry, LibraryOption, LibraryOptionsResponse, LibrarySource, LibraryState, MediaFormat, ResolveResponse } from '../../shared/types';
import { config } from './config';
import { DownloadError, downloadSourceOf, probeDownload } from './downloader';
import { facebookVideoId, resolveFacebook, FacebookError } from './facebook';
import { ensureFacebookSession } from './facebookSession';
import { openUpstream, readBody } from './http';
import { instagramCode, resolveInstagram, InstagramError } from './instagram';
import { ensureInstagramSession } from './instagramSession';
import { hostAllowed } from './ssrf';
import { parseTikTokUrl, resolveTikTokNative, TikTokError } from './tiktok';
import { youTubeVideoId, YouTubeError } from './youtube';
import { defaultExpiry, registerMedia } from './mediaStore';

export class LibraryError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

let log: (m: string) => void = () => undefined;
export const setLibraryLogger = (fn: (m: string) => void): void => {
  log = fn;
};

// ---------------------------------------------------------------- the file

function dataDir(): string {
  if (process.env.LIBRARY_DIR) return process.env.LIBRARY_DIR;
  const base = process.env.TIKTOK_PROFILE_DIR ? path.dirname(process.env.TIKTOK_PROFILE_DIR) : path.join(os.homedir(), '.streamanywhere');
  return path.join(base, 'library');
}
const DIR = dataDir();
const FILE = path.join(DIR, 'library.json');
const THUMBS = path.join(DIR, 'thumbs');
const FILES = path.join(DIR, 'files');

let state: LibraryState | undefined;
let saveTimer: NodeJS.Timeout | undefined;

function load(): LibraryState {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<LibraryState>;
    state = { rev: Number(parsed.rev) || 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [], categories: Array.isArray(parsed.categories) ? parsed.categories : [] };
    // A lookup that was running when the server stopped never finished: run it again.
    for (const e of state.entries) if (e.meta === 'pending') scheduleLookup(e.id);
  } catch {
    state = { rev: 1, entries: [], categories: [] };
  }
  return state;
}

/** Writes the file (tmp + rename) a moment after the last change; several changes in a row cost one write. */
function changed(): void {
  const s = load();
  s.rev++;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      log(`could not save ${FILE}: ${(e as Error).message}`);
    }
  }, 150);
  saveTimer.unref?.();
}

/** Writes pending changes now (shutdown). */
export function flushLibrary(): void {
  if (!saveTimer || !state) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  } catch {
    /* nothing more to do */
  }
}

export const libraryState = (): LibraryState => load();
export const libraryDir = (): string => DIR;
export const libraryThumbsDir = (): string => THUMBS;
export const libraryFilesDir = (): string => FILES;
/** Something changed in the state (rev grows, the file is written soon). */
export const markChanged = (): void => changed();
export const libraryLog = (m: string): void => log(m);
export const getEntry = (id: string): LibraryEntry | undefined => load().entries.find((x) => x.id === id);

/** Where an entry's server copy lives (whether or not the file exists). */
export const entryFilePath = (e: LibraryEntry): string => path.join(FILES, `${e.id}.${e.file?.ext || 'mp4'}`);

/** Registered by libraryFiles.ts: an entry is leaving the library (a running import must stop). */
let removeHook: (e: LibraryEntry) => void = () => undefined;
export const setRemoveHook = (fn: (e: LibraryEntry) => void): void => {
  removeHook = fn;
};

/** Deletes the server copy of a video (the entry stays, as a link). */
export function deleteFile(id: string): LibraryEntry {
  const e = getEntry(id);
  if (!e) throw new LibraryError('That video is no longer in the library', 404);
  removeHook(e);
  try {
    fs.unlinkSync(entryFilePath(e));
  } catch {
    /* not there */
  }
  if (e.file) {
    e.file = undefined;
    e.updatedAt = Date.now();
    changed();
    log(`server copy of ${e.id} deleted`);
  }
  return e;
}

const newId = (): string => crypto.randomBytes(6).toString('base64url');

// ---------------------------------------------------------------- links

/** Adds https:// to a bare host, trims, refuses anything that is not http(s). */
export function normalizeUrl(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) throw new LibraryError('Paste a video link first');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new LibraryError('That is not a valid link');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LibraryError('Only http(s) links can be saved');
  u.hash = '';
  return u.toString();
}

/** The one form of this link that identifies the video (duplicates are found by it) and the video's id on its platform. */
export function canonicalize(url: string): { source: LibrarySource; canonicalUrl: string; sourceId?: string } {
  const source = downloadSourceOf(url);
  if (source === 'youtube') {
    const id = youTubeVideoId(url);
    if (!id) throw new LibraryError('That is not a YouTube video link (watch, Shorts, youtu.be or embed)');
    return { source, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, sourceId: id };
  }
  if (source === 'tiktok') {
    let p;
    try {
      p = parseTikTokUrl(url);
    } catch (e) {
      throw new LibraryError((e as Error).message);
    }
    // a short link's video is known after the lookup follows it (canonicalUrl is fixed then)
    return p.videoId ? { source, canonicalUrl: `https://www.tiktok.com/video/${p.videoId}`, sourceId: p.videoId } : { source, canonicalUrl: p.pageUrl };
  }
  if (source === 'instagram') {
    const code = instagramCode(url);
    if (!code) throw new LibraryError('That is not an Instagram post or reel link');
    return { source, canonicalUrl: `https://www.instagram.com/reel/${code}/`, sourceId: code };
  }
  if (source === 'facebook') {
    const id = facebookVideoId(url);
    return id ? { source, canonicalUrl: `https://www.facebook.com/reel/${id}`, sourceId: id } : { source, canonicalUrl: url };
  }
  return { source: 'other', canonicalUrl: url };
}

const placeholderTitle = (url: string, source: LibrarySource, sourceId?: string): string => {
  const names: Record<LibrarySource, string> = { youtube: 'YouTube video', tiktok: 'TikTok video', instagram: 'Instagram reel', facebook: 'Facebook video', other: 'Video' };
  if (source === 'other') {
    try {
      const u = new URL(url);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      return last ? last.replace(/\.[a-z0-9]{2,4}$/i, '') : u.hostname;
    } catch {
      return names.other;
    }
  }
  return sourceId ? `${names[source]} ${sourceId}` : names[source];
};

/**
 * Saves a link. `lookup: false` skips the metadata lookup (an import of a plain file finds the
 * details in the file itself).
 */
export function saveLink(rawUrl: string, categoryIds: string[] = [], opts: { lookup?: boolean } = {}): { entry: LibraryEntry; duplicate: boolean } {
  const s = load();
  const url = normalizeUrl(rawUrl);
  const c = canonicalize(url);
  const existing = s.entries.find((e) => e.canonicalUrl === c.canonicalUrl || e.url === url);
  if (existing) return { entry: existing, duplicate: true };
  const now = Date.now();
  const valid = new Set(s.categories.map((x) => x.id));
  const doLookup = opts.lookup !== false;
  const entry: LibraryEntry = {
    id: newId(),
    url,
    canonicalUrl: c.canonicalUrl,
    source: c.source,
    sourceId: c.sourceId,
    title: placeholderTitle(url, c.source, c.sourceId),
    categoryIds: categoryIds.filter((id) => valid.has(id)),
    addedAt: now,
    updatedAt: now,
    meta: doLookup ? 'pending' : 'ok',
  };
  s.entries.unshift(entry);
  changed();
  log(`saved ${c.source} ${c.canonicalUrl}`);
  if (doLookup) scheduleLookup(entry.id);
  return { entry, duplicate: false };
}

export function patchEntry(id: string, patch: { title?: unknown; categoryIds?: unknown }): LibraryEntry {
  const s = load();
  const e = s.entries.find((x) => x.id === id);
  if (!e) throw new LibraryError('That video is no longer in the library', 404);
  if (typeof patch.title === 'string') {
    const t = patch.title.trim().slice(0, 300);
    if (t) {
      e.title = t;
      e.titleEdited = true;
    }
  }
  if (Array.isArray(patch.categoryIds)) {
    const valid = new Set(s.categories.map((x) => x.id));
    e.categoryIds = [...new Set(patch.categoryIds.map(String).filter((x) => valid.has(x)))];
  }
  e.updatedAt = Date.now();
  changed();
  return e;
}

export function deleteEntry(id: string): void {
  const s = load();
  const i = s.entries.findIndex((x) => x.id === id);
  if (i < 0) throw new LibraryError('That video is no longer in the library', 404);
  const [e] = s.entries.splice(i, 1);
  removeThumb(e.id);
  removeHook(e);
  try {
    fs.unlinkSync(entryFilePath(e));
  } catch {
    /* no server copy */
  }
  changed();
  log(`removed ${e.source} ${e.canonicalUrl}${e.file ? ' (and its server copy)' : ''}`);
}

export function refreshEntry(id: string): LibraryEntry {
  const s = load();
  const e = s.entries.find((x) => x.id === id);
  if (!e) throw new LibraryError('That video is no longer in the library', 404);
  if (e.meta !== 'pending') {
    e.meta = 'pending';
    e.metaError = undefined;
    e.updatedAt = Date.now();
    changed();
    scheduleLookup(e.id);
  }
  return e;
}

// ---------------------------------------------------------------- categories

export function addCategory(name: unknown): LibraryCategory {
  const s = load();
  const n = String(name || '')
    .trim()
    .slice(0, 60);
  if (!n) throw new LibraryError('Give the category a name');
  const dup = s.categories.find((c) => c.name.toLowerCase() === n.toLowerCase());
  if (dup) return dup;
  const cat: LibraryCategory = { id: newId(), name: n, createdAt: Date.now() };
  s.categories.push(cat);
  changed();
  return cat;
}

export function renameCategory(id: string, name: unknown): LibraryCategory {
  const s = load();
  const c = s.categories.find((x) => x.id === id);
  if (!c) throw new LibraryError('No such category', 404);
  const n = String(name || '')
    .trim()
    .slice(0, 60);
  if (!n) throw new LibraryError('Give the category a name');
  c.name = n;
  changed();
  return c;
}

export function deleteCategory(id: string): void {
  const s = load();
  const i = s.categories.findIndex((x) => x.id === id);
  if (i < 0) throw new LibraryError('No such category', 404);
  s.categories.splice(i, 1);
  for (const e of s.entries) {
    if (e.categoryIds.includes(id)) {
      e.categoryIds = e.categoryIds.filter((x) => x !== id);
      e.updatedAt = Date.now();
    }
  }
  changed();
}

// ---------------------------------------------------------------- metadata lookup

const lookups = new Set<string>();

function scheduleLookup(id: string): void {
  if (lookups.has(id)) return;
  lookups.add(id);
  setTimeout(() => void runLookup(id).finally(() => lookups.delete(id)), 10);
}

interface Looked {
  title?: string;
  author?: string;
  duration?: number;
  width?: number;
  height?: number;
  cover?: string;
  canonicalUrl?: string;
  sourceId?: string;
  /** A plain file link: the Content-Type it answered with */
  mediaType?: string;
}

/** Is this error the source saying the video is gone (as opposed to this server failing to ask)? */
function goneReason(e: unknown): string | undefined {
  const msg = (e as Error).message || String(e);
  if (e instanceof TikTokError && /^tiktok_status_|unsupported_photo/.test(e.code)) return msg;
  if ((e instanceof YouTubeError || e instanceof InstagramError || e instanceof FacebookError || e instanceof DownloadError) && e.status === 404) return msg;
  return undefined;
}

function fromResolve(r: ResolveResponse): Looked {
  return { title: r.title, author: r.author, duration: r.duration, width: r.width, height: r.height, cover: r.cover, canonicalUrl: r.canonicalUrl, sourceId: r.id };
}

async function lookup(e: LibraryEntry): Promise<Looked> {
  const l = (m: string) => log(`lookup ${e.id}: ${m}`);
  if (e.source === 'youtube') {
    const p = await probeDownload(e.canonicalUrl);
    return { title: p.title, author: p.author, duration: p.duration, cover: p.cover, canonicalUrl: p.url, sourceId: p.id };
  }
  if (e.source === 'tiktok') {
    const r = await resolveTikTokNative(e.url, { probe: false, log: (m) => l(m) });
    const out = fromResolve(r);
    if (r.id) out.canonicalUrl = `https://www.tiktok.com/video/${r.id}`;
    return out;
  }
  if (e.source === 'instagram') {
    await ensureInstagramSession();
    return fromResolve(await resolveInstagram(e.url, l));
  }
  if (e.source === 'facebook') {
    await ensureFacebookSession();
    return fromResolve(await resolveFacebook(e.url, l));
  }
  // a plain media URL: is it a video at all?
  const { res, status } = await openUpstream(e.url.replace(/^http:/, 'https:'), { allowlist: ['*'], maxRedirects: 5, headers: { range: 'bytes=0-0' } });
  res.destroy();
  if (status >= 400) throw new LibraryError(`The link answered HTTP ${status}`, status === 404 ? 404 : 502);
  const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type && !/^(video\/|application\/octet-stream|application\/mp4|application\/x-matroska)/i.test(type)) throw new LibraryError(`The link is not a video file (${type})`);
  return { mediaType: type || undefined };
}

async function runLookup(id: string): Promise<void> {
  const s = load();
  const e = s.entries.find((x) => x.id === id);
  if (!e) return;
  const t0 = Date.now();
  try {
    const got = await lookup(e);
    if (!s.entries.includes(e)) return; // removed meanwhile
    if (got.title && !e.titleEdited) e.title = got.title.trim().slice(0, 300) || e.title;
    if (got.author) e.author = got.author;
    if (got.duration) e.duration = got.duration;
    if (got.width) e.width = got.width;
    if (got.height) e.height = got.height;
    if (got.sourceId) e.sourceId = got.sourceId;
    if (got.canonicalUrl) e.canonicalUrl = got.canonicalUrl;
    if (got.mediaType) e.mediaType = got.mediaType;
    e.meta = 'ok';
    e.metaError = undefined;
    e.unavailable = undefined;
    e.updatedAt = Date.now();
    changed();
    log(`lookup ${e.id} (${e.source}): "${e.title.slice(0, 60)}" in ${Date.now() - t0} ms`);
    if (got.cover) await cacheThumb(e, got.cover);
  } catch (err) {
    if (!s.entries.includes(e)) return;
    const msg = ((err as Error).message || String(err)).slice(0, 300);
    e.meta = 'failed';
    e.metaError = msg;
    const gone = goneReason(err);
    if (gone) e.unavailable = { at: Date.now(), reason: gone };
    e.updatedAt = Date.now();
    changed();
    log(`lookup ${e.id} (${e.source}) failed after ${Date.now() - t0} ms: ${msg}`);
  }
}

// ---------------------------------------------------------------- thumbnails

const THUMB_MAX = 3 * 1024 * 1024;

function thumbPath(id: string): string | undefined {
  try {
    return fs.readdirSync(THUMBS).filter((f) => f.startsWith(`${id}.`)).map((f) => path.join(THUMBS, f))[0];
  } catch {
    return undefined;
  }
}

export function removeThumb(id: string): void {
  const p = thumbPath(id);
  if (p) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* gone */
    }
  }
}

async function cacheThumb(e: LibraryEntry, coverUrl: string): Promise<void> {
  try {
    const url = coverUrl.startsWith('//') ? `https:${coverUrl}` : coverUrl;
    const { res, status } = await openUpstream(url, { allowlist: ['*'], maxRedirects: 4, timeoutMs: 15_000, headers: { accept: 'image/*' } });
    if (status >= 400) {
      res.destroy();
      throw new Error(`HTTP ${status}`);
    }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/avif' ? 'avif' : type === 'image/gif' ? 'gif' : 'jpg';
    const body = await readBody(res, THUMB_MAX);
    if (!body.length) throw new Error('empty image');
    fs.mkdirSync(THUMBS, { recursive: true });
    removeThumb(e.id);
    fs.writeFileSync(path.join(THUMBS, `${e.id}.${ext}`), body);
    e.thumb = `/api/library/thumb/${e.id}?v=${Date.now().toString(36)}`;
    e.updatedAt = Date.now();
    changed();
  } catch (err) {
    log(`thumbnail for ${e.id} not cached: ${(err as Error).message}`);
  }
}

/** The cached thumbnail file for /api/library/thumb/:id, or undefined. */
export function thumbFile(id: string): { path: string; mime: string } | undefined {
  if (!/^[\w-]{1,24}$/.test(id)) return undefined;
  const p = thumbPath(id);
  if (!p) return undefined;
  const ext = path.extname(p).slice(1);
  return { path: p, mime: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'avif' ? 'image/avif' : ext === 'gif' ? 'image/gif' : 'image/jpeg' };
}

// ---------------------------------------------------------------- qualities on offer

const CODEC_LABEL: Record<string, string> = { h264: 'H.264', h265: 'H.265', av1: 'AV1', vp9: 'VP9', unknown: '?' };
const codecRank = (c: MediaFormat['codec']): number => (c === 'h264' ? 3 : c === 'vp9' ? 2 : c === 'av1' ? 1 : 0);

/** The size of a ready MP4 (a 1-byte Range request; TikTok's CDN refuses HEAD), or undefined within `timeoutMs`. */
async function sizeOfUrl(url: string, headers: Record<string, string>, timeoutMs: number): Promise<number | undefined> {
  try {
    const { res, status } = await openUpstream(url, { allowlist: ['*'], maxRedirects: 5, timeoutMs, headers: { ...headers, range: 'bytes=0-0' } });
    res.destroy();
    if (status === 206) {
      const m = /\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
      return m ? Number(m[1]) : undefined;
    }
    if (status === 200) return Number(res.headers['content-length']) || undefined;
  } catch {
    /* unknown size */
  }
  return undefined;
}

function streamOptions(r: ResolveResponse, hostAllowlist: string[]): LibraryOption[] {
  const usable = r.formats.filter((f) => f.directUrl || f.proxyUrl);
  // one per codec+resolution, best codec first, then the highest resolution
  const sorted = [...usable].sort((a, b) => codecRank(b.codec) - codecRank(a.codec) || (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const seen = new Set<string>();
  const out: LibraryOption[] = [];
  for (const f of sorted) {
    const key = `${f.codec}:${f.height || f.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const codec = CODEC_LABEL[f.codec] || f.codecDetail || '?';
    let proxyUrl = f.proxyUrl;
    if (!proxyUrl && f.directUrl && hostAllowed(new URL(f.directUrl).hostname, hostAllowlist)) {
      const rec = registerMedia({ url: f.directUrl, headers: {}, label: `library ${r.source} ${r.id} ${f.id}`, source: r.source, expiresAt: f.expiresAt ? Math.min(defaultExpiry(), f.expiresAt * 1000) : defaultExpiry() });
      proxyUrl = `/api/media/${rec.id}`;
    }
    out.push({
      id: f.id,
      kind: 'video',
      // the platforms' own quality names (TikTok's 540 / 720 / 1080 gears are `height` here)
      label: f.height ? `${f.height}p` : f.label,
      detail: `MP4 · ${codec}${f.bitrate ? ` ${Math.round(f.bitrate / 1000)} kbps` : ''}${f.audioProxyUrl ? ' (picture only)' : ''}`,
      width: f.width,
      height: f.height,
      vcodec: f.codecDetail || f.codec,
      ext: 'mp4',
      via: 'stream',
      directUrl: f.directUrl,
      proxyUrl,
    });
  }
  const rec = out.find((o) => /H\.264/.test(o.detail)) || out[0];
  if (rec) rec.recommended = true;
  return out;
}

/** The container a plain file link points at, from the Content-Type seen at the lookup or the link's extension. */
export function fileExtOf(e: LibraryEntry): string {
  const byType: Record<string, string> = { 'video/x-matroska': 'mkv', 'application/x-matroska': 'mkv', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/avi': 'avi', 'video/mp2t': 'ts', 'video/x-flv': 'flv', 'video/x-ms-wmv': 'wmv', 'video/mp4': 'mp4', 'video/x-m4v': 'mp4' };
  if (e.mediaType && byType[e.mediaType]) return byType[e.mediaType];
  try {
    const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(e.url).pathname);
    if (m) {
      const ext = m[1].toLowerCase();
      if (/^(mkv|webm|mov|avi|ts|m2ts|flv|wmv|mpg|mpeg|3gp|ogv)$/.test(ext)) return ext;
    }
  } catch {
    /* fine */
  }
  return 'mp4';
}

const FAMILY_NAME: Record<string, string> = { h264: 'H.264', h265: 'H.265', av1: 'AV1', vp9: 'VP9' };
/** "an MKV file", "a WebM file": initialisms are spelt out, so the article follows the first letter's sound. */
export const articleFor = (ext: string): string => (/^(webm|mov|wmv|mp4|mpeg)$/i.test(ext) ? 'a' : /^[aefhilmnorsx]/i.test(ext) ? 'an' : 'a');

/** The server copy as the one quality on offer (the source is not asked). */
function serverCopyOptions(e: LibraryEntry): LibraryOptionsResponse {
  const f = e.file!;
  const p = e.width && e.height ? Math.min(e.width, e.height) : undefined;
  return {
    entryId: e.id,
    options: [
      {
        id: 'library',
        kind: 'video',
        label: p ? `${p}p` : 'Library copy',
        detail: `MP4 · ${FAMILY_NAME[f.vcodec || ''] || f.vcodec || '?'}${f.acodec ? ' + AAC' : ' (no sound)'} · from the library on the server`,
        width: e.width,
        height: e.height,
        vcodec: f.vcodec,
        acodec: f.acodec,
        ext: 'mp4',
        sizeBytes: f.sizeBytes,
        sizeIsEstimate: false,
        recommended: true,
        via: 'stream',
        proxyUrl: `/api/library/file/${e.id}`,
      },
    ],
    warnings: [],
    elapsedMs: 0,
  };
}

export async function entryOptions(id: string): Promise<LibraryOptionsResponse> {
  const s = load();
  const e = s.entries.find((x) => x.id === id);
  if (!e) throw new LibraryError('That video is no longer in the library', 404);
  if (e.file?.state === 'ready') return serverCopyOptions(e);
  const t0 = Date.now();
  const l = (m: string) => log(`options ${e.id}: ${m}`);
  try {
    let resp: LibraryOptionsResponse;
    if (e.source === 'youtube') {
      const p = await probeDownload(e.canonicalUrl);
      resp = { entryId: e.id, probeId: p.probeId, options: p.options.map((o) => ({ ...o, via: 'job' })), warnings: p.warnings, elapsedMs: 0 };
      if (!e.titleEdited && p.title && p.title !== e.title) {
        e.title = p.title;
        e.updatedAt = Date.now();
        changed();
      }
    } else {
      let r: ResolveResponse;
      if (e.source === 'tiktok') r = await resolveTikTokNative(e.url, { probe: false, log: (m) => l(m) });
      else if (e.source === 'instagram') {
        await ensureInstagramSession();
        r = await resolveInstagram(e.url, l);
      } else if (e.source === 'facebook') {
        await ensureFacebookSession();
        r = await resolveFacebook(e.url, l);
      } else {
        const host = new URL(e.url).hostname;
        const allowed = hostAllowed(host, config.proxyAllowedHosts);
        const https = e.url.replace(/^http:/, 'https:');
        r = {
          source: 'mp4',
          resolver: 'passthrough',
          id: e.id,
          inputUrl: e.url,
          formats: [{ id: 'file', label: 'Original file', codec: 'unknown', directUrl: https, directKind: 'origin', requiresCookies: false, upstreamHost: host, proxyUrl: allowed ? `/api/media/${registerMedia({ url: https, headers: {}, label: `library file ${e.id}`, source: 'mp4', expiresAt: defaultExpiry() }).id}` : undefined }],
          warnings: allowed ? [] : ['This site is not on the proxy allowlist: the browser fetches the file directly, which works only when the site allows it (CORS).'],
          elapsedMs: 0,
          attempts: [],
        };
      }
      const options = streamOptions(r, config.proxyAllowedHosts);
      if (!options.length) throw new LibraryError('No downloadable video file was found for this link', 404);
      if (e.source === 'other') {
        // a plain file: the player reads MP4 only; anything else is offered as a file, with the way to convert it
        const ext = fileExtOf(e);
        for (const o of options) {
          o.ext = ext;
          o.vcodec = undefined;
          o.detail = ext === 'mp4' ? 'MP4 file' : `${ext.toUpperCase()} file`;
        }
        if (ext !== 'mp4') r.warnings.push(`This is ${articleFor(ext)} ${ext.toUpperCase()} file, which the app's player cannot read as it is. “Download to library” fetches it to the server and converts it to MP4; every device can then play it.`);
      }
      // sizes, a few at a time, without holding the answer up for long
      await Promise.all(options.slice(0, 6).map(async (o) => {
        // the cookie-free URL (TikTok's redirect to its CDN, the others' plain MP4s); cookie-bound ones need the proxy's record
        const f = r.formats.find((x) => x.id === o.id);
        const url = o.directUrl || f?.cookieBoundUrl;
        if (!url) return;
        const n = await sizeOfUrl(url, !o.directUrl && f?.cookieBoundUrl ? { referer: r.canonicalUrl || e.url } : {}, 6000);
        if (n) {
          o.sizeBytes = n;
          o.sizeIsEstimate = false;
        }
      }));
      resp = { entryId: e.id, options, warnings: r.warnings, elapsedMs: 0 };
    }
    if (e.unavailable) {
      e.unavailable = undefined;
      e.updatedAt = Date.now();
      changed();
    }
    resp.elapsedMs = Date.now() - t0;
    l(`${resp.options.map((o) => o.label).join(', ')} in ${resp.elapsedMs} ms`);
    return resp;
  } catch (err) {
    const gone = goneReason(err);
    if (gone && !e.unavailable) {
      e.unavailable = { at: Date.now(), reason: gone };
      e.updatedAt = Date.now();
      changed();
    }
    throw err;
  }
}

export const libraryStats = (): { entries: number; categories: number; pendingLookups: number; files: number; fileBytes: number; dir: string } => ({
  entries: load().entries.length,
  categories: load().categories.length,
  pendingLookups: lookups.size,
  files: load().entries.filter((e) => e.file?.state === 'ready').length,
  fileBytes: load().entries.reduce((n, e) => n + (e.file?.state === 'ready' ? e.file.sizeBytes || 0 : 0), 0),
  dir: DIR,
});
