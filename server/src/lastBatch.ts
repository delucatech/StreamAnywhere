/**
 * The last good batch of every feed, kept on disk, so that a viewer who arrives while the server
 * has nothing ready (a restart, an idle stock, the source refusing) sees videos at once instead of
 * waiting for the source: the request is answered with a few of these and the fill runs meanwhile.
 *
 * Files: ~/.streamanywhere/last-feed/<key>.json (TIKTOK_PROFILE_DIR's parent when that is set),
 * written after a take that handed out fresh items, read once at the first need after a start.
 * Only items whose play URLs are still valid go out (a cover whose CDN URL has expired is dropped
 * too); an item with nothing playable left is skipped, and when none is left the caller waits for
 * the fill instead – a stale video that still needs a resolve for every play costs more than it saves
 * (2026-10-26: expired Instagram covers + a 100 s resolve per video on a starved server).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FeedItem, MediaFormat } from '../../shared/types';
import { getMedia } from './mediaStore';

/** Where the batches live (LAST_FEED_DIR overrides; the tests use a folder of their own) */
export function lastFeedDir(): string {
  if (process.env.LAST_FEED_DIR) return process.env.LAST_FEED_DIR;
  return path.join(process.env.TIKTOK_PROFILE_DIR ? path.dirname(process.env.TIKTOK_PROFILE_DIR) : path.join(os.homedir(), '.streamanywhere'), 'last-feed');
}
/** Items kept per feed */
const KEEP = 30;
/** Items handed out per stale answer: few, so the client asks again (and gets fresh ones) soon */
export const STALE_BATCH = 6;
/** A batch older than this is not worth showing (play URLs expire well before: see usableFormat) */
const MAX_AGE_MS = 14 * 24 * 3600_000;

interface Stored {
  savedAt: number;
  items: FeedItem[];
}

const cache = new Map<string, Stored | null>();
/** How far into the stored batch the stale answers have gone (reset by a fresh batch) */
const cursor = new Map<string, number>();

const file = (key: string): string => path.join(lastFeedDir(), `${key.replace(/[^\w.-]+/g, '_')}.json`);

function load(key: string): Stored | undefined {
  if (cache.has(key)) return cache.get(key) || undefined;
  let s: Stored | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file(key), 'utf8')) as Stored;
    if (raw && Array.isArray(raw.items) && raw.items.length && Date.now() - raw.savedAt < MAX_AGE_MS) s = raw;
  } catch {
    /* none yet */
  }
  cache.set(key, s);
  return s || undefined;
}

/** Remembers the newest items a feed handed out (fresh ones only; called after a successful take). */
export function rememberBatch(key: string, items: FeedItem[]): void {
  if (!items.length) return;
  const prev = load(key)?.items || [];
  const ids = new Set(items.map((i) => i.id));
  const merged = [...items, ...prev.filter((i) => !ids.has(i.id))].slice(0, KEEP);
  const s: Stored = { savedAt: Date.now(), items: merged };
  cache.set(key, s);
  cursor.set(key, 0);
  try {
    fs.mkdirSync(lastFeedDir(), { recursive: true });
    const tmp = `${file(key)}.${process.pid}.tmp`;
    fs.writeFile(tmp, JSON.stringify(s), (err) => {
      if (err) return;
      fs.rename(tmp, file(key), () => undefined);
    });
  } catch {
    /* no disk: memory only */
  }
}

/**
 * When a CDN URL stops working, in ms since the epoch, or undefined when it carries no expiry:
 * `oe=<hex seconds>` (Instagram, Facebook), `expire=` / `x-expires=` (TikTok, YouTube, decimal
 * seconds) and the hex-seconds path segment of tiktokcdn-us.com media URLs.
 */
export function urlExpiryMs(url: string | undefined): number | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const oe = u.searchParams.get('oe');
  if (oe && /^[0-9a-fA-F]{8}$/.test(oe)) return parseInt(oe, 16) * 1000;
  const dec = u.searchParams.get('expire') || u.searchParams.get('x-expires');
  if (dec && /^\d{9,11}$/.test(dec)) return Number(dec) * 1000;
  const seg = u.pathname.split('/')[2];
  if (seg && /^[0-9a-f]{8}$/.test(seg)) {
    const t = parseInt(seg, 16);
    if (t > 1_600_000_000 && t < 4_000_000_000) return t * 1000;
  }
  return undefined;
}

/** The item without a cover whose URL has expired (the client shows its placeholder instead of a broken image). */
export function withFreshCover<T extends { cover?: string }>(it: T, now: number): T {
  const exp = urlExpiryMs(it.cover);
  if (exp !== undefined && exp <= now) {
    const { cover: _c, ...rest } = it;
    return rest as T;
  }
  return it;
}

/**
 * A stored format as it can be handed out now: without a play URL that has expired, and without
 * a proxy relay this process no longer knows (the relays live in memory, with the upstream cookies;
 * after a restart they are gone). Undefined when nothing playable is left – the item then goes out
 * with no formats and the client gets fresh ones from the video's page.
 */
function usableFormat(f: MediaFormat, now: number): MediaFormat | undefined {
  if (f.expiresAt !== undefined && f.expiresAt * 1000 <= now + 60_000) return undefined;
  const id = f.mediaId || (f.proxyUrl || '').split('/api/media/')[1];
  if (f.proxyUrl && (!id || !getMedia(id))) {
    const { proxyUrl: _p, mediaId: _m, ...rest } = f;
    return rest.directUrl ? rest : undefined;
  }
  return f.directUrl || f.proxyUrl ? f : undefined;
}

/**
 * Kept search results / account pages as they can go out now: expired play URLs and covers
 * stripped (the item stays – the client gets fresh URLs from the video's page when it comes up).
 */
export function reviveItems<T extends FeedItem>(items: T[], now: number): T[] {
  return items.map((it) => withFreshCover({ ...it, formats: it.formats.map((f) => usableFormat(f, now)).filter((f): f is MediaFormat => Boolean(f)) }, now));
}

/** Whether this feed has been served before (its last good batch is on disk): a feed somebody uses. */
export function hasBatch(key: string): boolean {
  return load(key) !== undefined;
}

/**
 * The next few remembered items for a feed that has nothing ready, or undefined once they are
 * used up (then the caller waits for the source as before).
 */
export function staleBatch(key: string, count = STALE_BATCH): FeedItem[] | undefined {
  const s = load(key);
  if (!s) return undefined;
  const from = cursor.get(key) || 0;
  if (from >= s.items.length) return undefined;
  const now = Date.now();
  const items: FeedItem[] = [];
  let at = from;
  // Expired items (nothing playable left) are skipped, not served: the viewer would wait for a
  // resolve of each one anyway, behind the fill that is running.
  for (; at < s.items.length && items.length < count; at++) {
    const it = s.items[at];
    const formats = it.formats.map((f) => usableFormat(f, now)).filter((f): f is MediaFormat => Boolean(f));
    if (formats.length) items.push(withFreshCover({ ...it, formats }, now));
  }
  cursor.set(key, at);
  return items.length ? items : undefined;
}

// ---- the whole stock of a reservoir, so a restart begins with what was ready (not only the last batch)

const stockFile = (key: string): string => path.join(lastFeedDir(), `${key.replace(/[^\w.-]+/g, '_')}.stock.json`);
const stockTimers = new Map<string, NodeJS.Timeout>();

/** The stock a reservoir had when it last saved it (expired items are dropped by the caller). */
export function loadStock(key: string): FeedItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(stockFile(key), 'utf8')) as { savedAt: number; items: FeedItem[] };
    if (raw && Array.isArray(raw.items) && Date.now() - raw.savedAt < MAX_AGE_MS) return raw.items.map((it) => withFreshCover(it, Date.now()));
  } catch {
    /* none yet */
  }
  return [];
}

/** Writes the stock soon (coalesced: a fill and the takes that follow make one write). */
export function saveStock(key: string, items: () => FeedItem[]): void {
  const t = stockTimers.get(key);
  if (t) clearTimeout(t);
  stockTimers.set(
    key,
    setTimeout(() => {
      stockTimers.delete(key);
      try {
        fs.mkdirSync(lastFeedDir(), { recursive: true });
        const tmp = `${stockFile(key)}.${process.pid}.tmp`;
        fs.writeFile(tmp, JSON.stringify({ savedAt: Date.now(), items: items() }), (err) => {
          if (err) return;
          fs.rename(tmp, stockFile(key), () => undefined);
        });
      } catch {
        /* no disk */
      }
    }, 500),
  );
}

/** The feed items as the player needs them: without the diagnostics-only fields (big, unused outside the lab page). */
export function slimItems<T extends { formats: MediaFormat[] }>(items: T[]): T[] {
  return items.map((it) => ({ ...it, formats: it.formats.map(({ cookieBoundUrl: _c, serverProbe: _s, ...f }) => f) }));
}

/** Tests: forget everything in memory (the files stay). */
export function resetLastBatches(): void {
  cache.clear();
  cursor.clear();
}
