/**
 * Work that outlives the request which asked for it, and answers that are kept for the next one.
 *
 * A search, an account page or a resolve takes the server seconds to minutes (a headless browser,
 * yt-dlp). When the car loses its connection meanwhile, the work goes on regardless (nothing here
 * is cancelled) and its answer is kept, so the request the car sends when it is back is answered
 * at once:
 *
 *  - in flight: an identical request joins the running job instead of starting it again;
 *  - kept: an answer younger than `freshMs` is final; one between `freshMs` and `keepMs` goes out
 *    at once as well, and the job runs again in the background (one at a time, a pause between
 *    two) so the next request gets a fresher one (`cachedAgeSec` on the answer tells the client,
 *    which asks again a little later);
 *  - `persist`: the answer is on disk too (~/.streamanywhere/jobs/), so a restart keeps it.
 *
 * Failures are not kept: the next request runs the job again, and a kept answer stays until a
 * fresh one replaces it.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lastFeedDir } from './lastBatch';

export interface JobOptions<T> {
  /** A kept answer younger than this is final */
  freshMs: number;
  /** A kept answer older than this is not used */
  keepMs: number;
  /** Keep the answer on disk too (survives a restart) */
  persist?: boolean;
  /** A kept answer, as it can go out now (expired play URLs stripped, the age filled in) */
  revive?: (value: T, ageMs: number) => T;
  log?: (msg: string) => void;
}

interface Kept {
  at: number;
  value: unknown;
}

/** In-memory answers (the newest MEMORY_MAX; a persisted one is read back from disk when missing) */
const MEMORY_MAX = 300;
/** Files kept on disk at most (the oldest go when the count passes this) */
const DISK_MAX = 400;
/** Between two background refreshes */
const REFRESH_GAP_MS = 2000;

const kept = new Map<string, Kept>();
const inFlight = new Map<string, Promise<unknown>>();
const missingOnDisk = new Set<string>();
const refreshQueue: { key: string; work: () => Promise<unknown>; opts: JobOptions<unknown> }[] = [];
let refreshing = false;
let refreshTimer: NodeJS.Timeout | undefined;
let writes = 0;
let stats = { hits: 0, stale: 0, joined: 0, runs: 0, refreshes: 0 };

export function jobsDir(): string {
  return process.env.JOBS_DIR || path.join(path.dirname(lastFeedDir()), 'jobs');
}

/** File name: the key readable (prefix-preserving, so invalidate(prefix) can match files) plus a hash. */
function fileOf(key: string): string {
  const readable = key.replace(/[^\w.-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  return path.join(jobsDir(), `${readable}-${hash}.json`);
}

function fromDisk(key: string): Kept | undefined {
  if (missingOnDisk.has(key)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) as { key?: string; at?: number; value?: unknown };
    if (raw && raw.key === key && typeof raw.at === 'number' && raw.value !== undefined) {
      const k = { at: raw.at, value: raw.value };
      remember(key, k);
      return k;
    }
  } catch {
    /* none */
  }
  missingOnDisk.add(key);
  return undefined;
}

function remember(key: string, k: Kept): void {
  kept.set(key, k);
  if (kept.size > MEMORY_MAX) {
    const oldest = [...kept.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(MEMORY_MAX / 4));
    for (const [k2] of oldest) kept.delete(k2);
  }
}

function toDisk(key: string, k: Kept): void {
  try {
    fs.mkdirSync(jobsDir(), { recursive: true });
    const file = fileOf(key);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFile(tmp, JSON.stringify({ key, at: k.at, value: k.value }), (err) => {
      if (err) return;
      fs.rename(tmp, file, () => undefined);
    });
    missingOnDisk.delete(key);
    if (++writes % 50 === 0) pruneDisk();
  } catch {
    /* no disk: memory only */
  }
}

function pruneDisk(): void {
  try {
    const dir = jobsDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const { f } of files.slice(0, Math.max(0, files.length - DISK_MAX))) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* ignore */
  }
}

function keep(key: string, value: unknown, opts: JobOptions<unknown>): void {
  const k = { at: Date.now(), value };
  remember(key, k);
  if (opts.persist) toDisk(key, k);
}

function run<T>(key: string, work: () => Promise<T>, opts: JobOptions<T>): Promise<T> {
  stats.runs++;
  const p = work()
    .then((v) => {
      keep(key, v, opts as JobOptions<unknown>);
      return v;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function queueRefresh<T>(key: string, work: () => Promise<T>, opts: JobOptions<T>): void {
  if (inFlight.has(key) || refreshQueue.some((r) => r.key === key)) return;
  refreshQueue.push({ key, work, opts: opts as JobOptions<unknown> });
  scheduleRefresh(0);
}

function scheduleRefresh(delayMs: number): void {
  if (refreshing || refreshTimer || !refreshQueue.length) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    const next = refreshQueue.shift();
    if (!next) return;
    const hit = kept.get(next.key);
    // Fresh again meanwhile (a viewer's request ran it), or running: nothing to do
    if ((hit && Date.now() - hit.at < next.opts.freshMs) || inFlight.has(next.key)) return scheduleRefresh(0);
    refreshing = true;
    stats.refreshes++;
    next.opts.log?.(`refreshing in the background: ${next.key}`);
    void run(next.key, next.work, next.opts)
      .catch((e) => next.opts.log?.(`background refresh failed (the earlier answer stays): ${next.key}: ${(e as Error).message}`))
      .finally(() => {
        refreshing = false;
        scheduleRefresh(REFRESH_GAP_MS);
      });
  }, delayMs);
  refreshTimer.unref?.();
}

/**
 * The answer for `key`: kept (fresh, or stale with a refresh queued), in flight (joined), or run now.
 * `work` is never cancelled: a request that goes away leaves its job running, and the answer waits
 * here for the next one.
 */
export async function sharedJob<T>(key: string, work: () => Promise<T>, opts: JobOptions<T>): Promise<T> {
  const now = Date.now();
  const hit = kept.get(key) ?? (opts.persist ? fromDisk(key) : undefined);
  if (hit && now - hit.at < opts.keepMs) {
    const age = now - hit.at;
    const value = opts.revive ? opts.revive(hit.value as T, age) : (hit.value as T);
    if (age >= opts.freshMs) {
      stats.stale++;
      queueRefresh(key, work, opts);
      opts.log?.(`kept answer from ${Math.round(age / 1000)} s ago served; a fresh one is being fetched: ${key}`);
    } else stats.hits++;
    return value;
  }
  const running = inFlight.get(key);
  if (running) {
    stats.joined++;
    opts.log?.(`joined the running job: ${key}`);
    return running as Promise<T>;
  }
  return run(key, work, opts);
}

/** Forgets every kept answer whose key starts with `prefix` (memory and disk). */
export function invalidateJobs(prefix: string): void {
  for (const k of kept.keys()) if (k.startsWith(prefix)) kept.delete(k);
  try {
    const dir = jobsDir();
    const start = prefix.replace(/[^\w.-]/g, '_').slice(0, 80);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(start) && f.endsWith('.json')) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* no dir */
  }
  missingOnDisk.clear();
}

export function jobStats(): Record<string, unknown> {
  return { ...stats, kept: kept.size, inFlight: [...inFlight.keys()], refreshQueue: refreshQueue.length };
}

/** Tests: forget everything in memory, stop the refresh timer. */
export function resetJobs(): void {
  kept.clear();
  inFlight.clear();
  missingOnDisk.clear();
  refreshQueue.length = 0;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  refreshing = false;
  stats = { hits: 0, stale: 0, joined: 0, runs: 0, refreshes: 0 };
}
