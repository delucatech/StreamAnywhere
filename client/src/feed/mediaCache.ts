/**
 * The feed's media cache (IndexedDB, database "streamanywhere-media"): the bytes of the videos the
 * feed has downloaded, so a video that comes up again (the previous one, the feed of an app the
 * viewer switches back to, the saved feed after the car closed the page) starts from disk instead
 * of the network.
 *
 *  - One record per file (a video's picture file, and its separate sound file on YouTube): the
 *    bytes from the start of the file as far as they were downloaded (a whole file once the
 *    download finished; a head otherwise), the file's size, and the URL they came from. A head is
 *    only reused for the same URL (a fresh resolve may hand out another encoding); a whole file
 *    for any URL.
 *  - Stored when a download completes and when a player is released (the viewer moved on); never
 *    while bytes are streaming.
 *  - Room is made slowly (sweep): what the saved feeds still list ahead of the viewer is kept;
 *    everything else goes oldest first once the budget is passed, and after MAX_AGE regardless,
 *    a few files per sweep.
 */

const DB_NAME = 'streamanywhere-media';
const DB_VERSION = 1;
const STORE = 'files';
/** The budget: this much at most... */
const BUDGET_MAX = 400 * 1024 * 1024;
/** ...and never more than this share of what the browser offers the site */
const BUDGET_SHARE = 0.2;
const BUDGET_MIN = 40 * 1024 * 1024;
/** A file nobody's feed lists any more is dropped after this long */
export const MAX_AGE = 24 * 3600_000;
/** A head shorter than this is not worth a record */
const MIN_BYTES = 128 * 1024;
/** A sweep deletes at most this many files (slowly, between videos) */
const SWEEP_DELETES = 12;

export type CacheRole = 'video' | 'audio';

export interface CachedFile {
  /** `${platform}:${itemId}:${role}` */
  key: string;
  /** `${platform}:${itemId}` (what the sweep protects by) */
  itemKey: string;
  role: CacheRole;
  url: string;
  bytes: number;
  total: number;
  complete: boolean;
  savedAt: number;
  lastUsedAt: number;
  blob: Blob;
}

export const itemKey = (platform: string, itemId: string): string => `${platform}:${itemId}`;
export const fileKey = (platform: string, itemId: string, role: CacheRole): string => `${itemKey(platform, itemId)}:${role}`;

let dbPromise: Promise<IDBDatabase> | undefined;
let unavailable = false;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'key' });
        s.createIndex('itemKey', 'itemKey');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  dbPromise.catch(() => {
    dbPromise = undefined;
    unavailable = true;
  });
  return dbPromise;
}

function reqAsync<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/** Bytes in the cache as of the last sweep or store (approximate between sweeps) */
let usedBytes = -1;
let budgetBytes = BUDGET_MAX;

/** The cached file, or undefined; `lastUsedAt` is refreshed. Never throws. */
export async function getCached(key: string): Promise<CachedFile | undefined> {
  if (unavailable) return undefined;
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    const rec = (await reqAsync(s.get(key))) as CachedFile | undefined;
    if (rec) {
      rec.lastUsedAt = Date.now();
      s.put(rec);
    }
    await txDone(tx);
    return rec && rec.blob instanceof Blob && rec.blob.size === rec.bytes ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores the bytes (a whole file, or the head of one with a known size). An existing record is
 * only replaced by a longer one. True when something was written.
 */
export async function putCached(rec: Omit<CachedFile, 'savedAt' | 'lastUsedAt'>): Promise<boolean> {
  if (unavailable) return false;
  if (!rec.complete && (rec.bytes < MIN_BYTES || !(rec.total > 0))) return false;
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    const old = (await reqAsync(s.get(rec.key))) as CachedFile | undefined;
    if (old && old.bytes >= rec.bytes && (old.complete || old.url === rec.url)) {
      await txDone(tx);
      return false;
    }
    const now = Date.now();
    s.put({ ...rec, savedAt: old?.savedAt ?? now, lastUsedAt: now } as CachedFile);
    await txDone(tx);
    if (usedBytes >= 0) usedBytes += rec.bytes - (old?.bytes || 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the cache is over its budget as far as it is known (a sweep is due). */
export const overBudget = (): boolean => usedBytes > budgetBytes;

export interface SweepResult {
  files: number;
  bytes: number;
  deleted: number;
  freed: number;
  budget: number;
}

/**
 * Makes room: files older than MAX_AGE whose item no feed protects go, then (while over budget) the
 * least recently used unprotected ones, at most SWEEP_DELETES per call. `protect` holds item keys
 * (platform:id) still listed ahead of the viewer somewhere.
 */
export async function sweep(protect: Set<string>): Promise<SweepResult | undefined> {
  if (unavailable) return undefined;
  try {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) budgetBytes = Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, Math.floor(est.quota * BUDGET_SHARE)));
    } catch {
      /* no estimate */
    }
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    // the records without their blobs' bytes: a cursor reads keys and sizes only (Blob.size is free)
    const all: { key: string; itemKey: string; bytes: number; savedAt: number; lastUsedAt: number; ok: boolean }[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        const r = c.value as CachedFile;
        all.push({ key: r.key, itemKey: r.itemKey, bytes: r.bytes, savedAt: r.savedAt, lastUsedAt: r.lastUsedAt, ok: r.blob instanceof Blob && r.blob.size === r.bytes });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    const now = Date.now();
    let bytes = all.reduce((n, r) => n + r.bytes, 0);
    const doomed = new Set<string>();
    let freed = 0;
    const drop = (r: (typeof all)[number]) => {
      if (doomed.has(r.key)) return;
      doomed.add(r.key);
      freed += r.bytes;
      bytes -= r.bytes;
    };
    // 1. broken records (a blob the browser evicted): no use to anyone
    for (const r of all) if (!r.ok) drop(r);
    // 2. the stale: a day old and no feed lists them any more, oldest first
    const stale = all.filter((r) => !doomed.has(r.key) && now - r.savedAt > MAX_AGE && !protect.has(r.itemKey)).sort((a, b) => a.savedAt - b.savedAt);
    for (const r of stale) {
      if (doomed.size >= SWEEP_DELETES) break;
      drop(r);
    }
    // 3. over budget: the least recently used unprotected files, until under it or the sweep's quota is spent
    if (bytes > budgetBytes) {
      const candidates = all.filter((r) => !doomed.has(r.key) && !protect.has(r.itemKey)).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const r of candidates) {
        if (bytes <= budgetBytes || doomed.size >= SWEEP_DELETES) break;
        drop(r);
      }
    }
    for (const key of doomed) s.delete(key);
    await txDone(tx);
    usedBytes = bytes;
    return { files: all.length - doomed.size, bytes, deleted: doomed.size, freed, budget: budgetBytes };
  } catch {
    return undefined;
  }
}

/** Deletes every cached file (the Library's "clear" and tests). */
export async function wipeMediaCache(): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await txDone(tx);
  usedBytes = 0;
}
