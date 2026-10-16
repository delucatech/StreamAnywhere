/**
 * The browser-side store of the Video Library (IndexedDB, database "streamanywhere-library"):
 *
 *  - `state`:  a mirror of the server's library (entries + categories), so the page can show the
 *              library offline.
 *  - `videos`: one record per video downloaded for in-app playback here: which quality, how big,
 *              and the key its parts are stored under.
 *  - `parts`:  the file itself in Blob pieces of a few MB (written while the download streams, so a
 *              1 GB video never sits in memory). Playback gets `new Blob(parts)`, which the browser
 *              reads lazily from disk.
 *
 * A video counts as present only when its record AND all its parts are there with the recorded
 * size (verifyVideos): a cleared or partly evicted store is reported as missing, never as present.
 */
import type { LibraryState } from '../../../shared/types';

const DB_NAME = 'streamanywhere-library';
const DB_VERSION = 1;
export const PART_BYTES = 8 * 1024 * 1024;

export interface LocalVideo {
  entryId: string;
  /** Where the parts live (a new download of the same entry gets a new key; the old copy is removed after) */
  partKey: string;
  parts: number;
  sizeBytes: number;
  mime: string;
  ext: string;
  /** The quality that was downloaded */
  optionId: string;
  label: string;
  detail: string;
  width?: number;
  height?: number;
  vcodec?: string;
  savedAt: number;
  /** The entry's title at download time (shown when the entry is gone from the library) */
  title: string;
}

interface Part {
  partKey: string;
  index: number;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'entryId' });
      if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: ['partKey', 'index'] });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  dbPromise.catch(() => (dbPromise = undefined));
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

async function store(name: string, mode: IDBTransactionMode): Promise<{ s: IDBObjectStore; tx: IDBTransaction }> {
  const db = await open();
  const tx = db.transaction(name, mode);
  return { s: tx.objectStore(name), tx };
}

// ---------------------------------------------------------------- the library mirror

export async function getState(): Promise<LibraryState | undefined> {
  try {
    const { s } = await store('state', 'readonly');
    return (await reqAsync(s.get('library'))) as LibraryState | undefined;
  } catch {
    return undefined;
  }
}

export async function putState(state: LibraryState): Promise<void> {
  try {
    const { s, tx } = await store('state', 'readwrite');
    s.put(state, 'library');
    await txDone(tx);
  } catch {
    /* the mirror is a convenience */
  }
}

// ---------------------------------------------------------------- videos

export async function listVideos(): Promise<LocalVideo[]> {
  const { s } = await store('videos', 'readonly');
  return (await reqAsync(s.getAll())) as LocalVideo[];
}

export async function getVideo(entryId: string): Promise<LocalVideo | undefined> {
  const { s } = await store('videos', 'readonly');
  return (await reqAsync(s.get(entryId))) as LocalVideo | undefined;
}

export async function putVideo(v: LocalVideo): Promise<void> {
  const { s, tx } = await store('videos', 'readwrite');
  s.put(v);
  await txDone(tx);
}

const partsRange = (partKey: string): IDBKeyRange => IDBKeyRange.bound([partKey, 0], [partKey, Number.MAX_SAFE_INTEGER]);

export async function putPart(partKey: string, index: number, blob: Blob): Promise<void> {
  const { s, tx } = await store('parts', 'readwrite');
  s.put({ partKey, index, blob } as Part);
  await txDone(tx);
}

export async function deleteParts(partKey: string): Promise<void> {
  const { s, tx } = await store('parts', 'readwrite');
  s.delete(partsRange(partKey));
  await txDone(tx);
}

/** The video's file: one Blob over its stored parts (read lazily by the browser). */
export async function videoBlob(v: LocalVideo): Promise<Blob> {
  const { s } = await store('parts', 'readonly');
  const parts = ((await reqAsync(s.getAll(partsRange(v.partKey)))) as Part[]).sort((a, b) => a.index - b.index);
  if (parts.length !== v.parts) throw new Error(`The local copy is incomplete (${parts.length} of ${v.parts} parts present)`);
  return new Blob(
    parts.map((p) => p.blob),
    { type: v.mime || 'video/mp4' },
  );
}

/** Removes the record and the file. */
export async function deleteVideo(entryId: string): Promise<void> {
  const v = await getVideo(entryId);
  const db = await open();
  const tx = db.transaction(['videos', 'parts'], 'readwrite');
  tx.objectStore('videos').delete(entryId);
  if (v) tx.objectStore('parts').delete(partsRange(v.partKey));
  await txDone(tx);
}

export interface VerifyResult {
  present: LocalVideo[];
  /** Records whose file was missing or incomplete (the records have been removed) */
  missing: LocalVideo[];
  /** Bytes of parts that belonged to no record (removed: an interrupted download, or an old copy) */
  orphanBytes: number;
}

/**
 * Checks every record against the parts actually stored: count and total size must match. Records
 * without their file are dropped (reported), parts without a record are removed, unless their key
 * is in `keep` (downloads running right now).
 */
export async function verifyVideos(keep: Set<string> = new Set()): Promise<VerifyResult> {
  const db = await open();
  const tx = db.transaction(['videos', 'parts'], 'readwrite');
  const videos = tx.objectStore('videos');
  const parts = tx.objectStore('parts');
  const records = (await reqAsync(videos.getAll())) as LocalVideo[];
  const byKey = new Map<string, { count: number; bytes: number }>();
  // one cursor over the keys and the blobs' sizes (Blob.size needs no read of the data)
  await new Promise<void>((resolve, reject) => {
    const req = parts.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      const p = c.value as Part;
      const agg = byKey.get(p.partKey) || { count: 0, bytes: 0 };
      agg.count++;
      agg.bytes += p.blob?.size || 0;
      byKey.set(p.partKey, agg);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const present: LocalVideo[] = [];
  const missing: LocalVideo[] = [];
  const liveKeys = new Set<string>(keep);
  for (const v of records) {
    const agg = byKey.get(v.partKey);
    if (agg && agg.count === v.parts && agg.bytes === v.sizeBytes) {
      present.push(v);
      liveKeys.add(v.partKey);
    } else {
      missing.push(v);
      videos.delete(v.entryId);
    }
  }
  let orphanBytes = 0;
  for (const [key, agg] of byKey) {
    if (liveKeys.has(key)) continue;
    orphanBytes += agg.bytes;
    parts.delete(partsRange(key));
  }
  await txDone(tx);
  return { present, missing, orphanBytes };
}

/** Deletes everything this page stored (the library mirror included). */
export async function wipe(): Promise<void> {
  const db = await open();
  const tx = db.transaction(['videos', 'parts', 'state'], 'readwrite');
  tx.objectStore('videos').clear();
  tx.objectStore('parts').clear();
  tx.objectStore('state').clear();
  await txDone(tx);
}
