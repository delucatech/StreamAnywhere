/**
 * A stock of feed items filled in the background, so that a feed request is answered from memory
 * instead of waiting for TikTok.
 *
 * TikTok's Explore API hands out a random batch per call and refuses now and then (empty body =
 * soft rate limit), so the viewer used to wait a full round trip, plus retries, every 12 videos.
 * The reservoir asks TikTok early instead of faster: while a client has asked recently, it keeps
 * about `target` unseen items ready and refills, one call at a time, as soon as the stock drops
 * below `low`. An idle feed (no request for `idleMs`) stops all TikTok traffic.
 *
 * Items are deduplicated against the ids handed out within the last `recentMs` (a random batch of
 * 30 overlaps a previous one more and more as the hour goes on), and dropped once their play URLs
 * are about to expire.
 *
 * With a `persistKey`, the stock itself and the newest items handed out are kept on disk
 * (lastBatch.ts): a restart begins with the stock it had, and a take() for a viewer with nothing
 * on screen (`quick`) that finds the stock empty answers with a few of the earlier videos at once
 * (`stale`), while the fill runs. A viewer who already has videos waits for fresh ones as before.
 */
import type { FeedItem } from '../../shared/types';
import { loadStock, rememberBatch, saveStock, staleBatch } from './lastBatch';

export interface ReservoirFetch {
  items: FeedItem[];
  warnings: string[];
}

/** What a fill tells the source, so it can vary its request (TikTok answers a repeated request from a cache). */
export interface ReservoirFillContext {
  /** Items wanted from the source */
  count: number;
  /** Running number of this fill (0 for the first) */
  index: number;
  /** New items the previous fill brought (undefined before the first) */
  lastAdded?: number;
}

export interface ReservoirOptions {
  /** How many items to keep ready */
  target?: number;
  /** Refill as soon as fewer than this many are left */
  low?: number;
  /** Items asked from the source per call */
  batch?: number;
  /** Stop filling after this long without a take() */
  idleMs?: number;
  /** An id handed out within this window is not handed out again */
  recentMs?: number;
  /** Pause between two consecutive fills (TikTok dislikes bursts) */
  gapMs?: number;
  /** A fill that brings fewer new items than this (but some) pauses the filling for `dryMs` */
  dryBelow?: number;
  dryMs?: number;
  /** How long a take() waits for a fill when the stock is empty */
  waitMs?: number;
  /** Keep the stock and the last good batch on disk under this name, and answer an empty stock with the latter (see lastBatch.ts) */
  persistKey?: string;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface ReservoirStats {
  ready: number;
  recent: number;
  failures: number;
  filling: boolean;
  lastError?: string;
}

export interface ReservoirTake {
  items: FeedItem[];
  warnings: string[];
  /** Items still ready after this take */
  ready: number;
  /** Whether the answer came without waiting for the source */
  fromStock: boolean;
  /** The items are from an earlier visit (the stock was empty); a fill is running */
  stale?: boolean;
}

export class Reservoir {
  private stock: FeedItem[] = [];
  private recent = new Map<string, number>();
  private lastTakeAt = 0;
  private lastFillAt = 0;
  private filling: Promise<void> | undefined;
  private fillTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private backoffUntil = 0;
  private lastError: Error | undefined;
  private lastWarnings: string[] = [];
  private fillIndex = 0;
  private lastAdded: number | undefined;
  private readonly opt: Required<Omit<ReservoirOptions, 'log' | 'persistKey'>> & { log?: (msg: string) => void; persistKey?: string };

  constructor(private readonly name: string, private readonly fetch: (ctx: ReservoirFillContext) => Promise<ReservoirFetch>, options: ReservoirOptions = {}) {
    this.opt = {
      target: options.target ?? 60,
      low: options.low ?? 40,
      batch: options.batch ?? 30,
      // a feed left for a quarter of an hour is still topped up, so coming back finds it ready
      idleMs: options.idleMs ?? 15 * 60 * 1000,
      recentMs: options.recentMs ?? 60 * 60 * 1000,
      gapMs: options.gapMs ?? 3000,
      dryBelow: options.dryBelow ?? 5,
      dryMs: options.dryMs ?? 20_000,
      waitMs: options.waitMs ?? 25_000,
      now: options.now ?? Date.now,
      log: options.log,
      persistKey: options.persistKey,
    };
    if (options.persistKey) {
      const now = this.opt.now();
      this.stock = loadStock(options.persistKey).filter((it) => !expiredSoon(it, now));
      for (const it of this.stock) this.recent.set(it.id, now);
      if (this.stock.length) this.opt.log?.(`${this.name}: ${this.stock.length} ready from the last run`);
    }
  }

  private persist(): void {
    if (this.opt.persistKey) saveStock(this.opt.persistKey, () => this.stock);
  }

  /** Items ready right now (fresh ones only) */
  get ready(): number {
    this.prune();
    return this.stock.length;
  }

  get stats(): ReservoirStats {
    return { ready: this.ready, recent: this.recent.size, failures: this.failures, filling: Boolean(this.filling), lastError: this.lastError?.message };
  }

  /**
   * Hands out up to `count` items. Answers from the stock when it has any; otherwise waits for one
   * fill (or the one in flight). Throws the source's error only when nothing at all can be served.
   * `quick`: the viewer has nothing on screen – an empty stock answers with earlier videos (takeStale).
   */
  async take(count: number, quick = false): Promise<ReservoirTake> {
    this.lastTakeAt = this.opt.now();
    this.prune();
    const fromStock = this.stock.length > 0;
    if (!fromStock) {
      if (quick) {
        const stale = this.takeStale();
        if (stale) {
          this.warm();
          return stale;
        }
      }
      await this.waitForFill();
      this.prune();
    }
    const items = this.stock.splice(0, Math.max(1, count));
    const warnings = fromStock ? [] : this.lastWarnings.slice();
    if (!items.length && this.lastError) {
      this.scheduleFill();
      throw this.lastError;
    }
    if (this.opt.persistKey && items.length) {
      rememberBatch(this.opt.persistKey, items);
      this.persist();
    }
    this.scheduleFill();
    return { items, warnings, ready: this.stock.length, fromStock };
  }

  /**
   * For the home screen filling a device's saved feeds ahead of time: what is ready now (the
   * stock, else earlier videos), or undefined. Costs nothing – no fill is started, the feed is
   * not marked active, nothing waits.
   */
  takeCheap(count: number): ReservoirTake | undefined {
    this.prune();
    if (this.stock.length) {
      const items = this.stock.splice(0, Math.max(1, count));
      if (this.opt.persistKey) {
        rememberBatch(this.opt.persistKey, items);
        this.persist();
      }
      return { items, warnings: [], ready: this.stock.length, fromStock: true };
    }
    return this.takeStale();
  }

  /**
   * Earlier videos for a viewer with nothing on screen, when the stock is empty and this feed was
   * served before; undefined otherwise (then take() waits for the source). Starts no fill: the
   * caller does (warm), after whatever check must come first (a sign-in on some platforms).
   */
  takeStale(): ReservoirTake | undefined {
    this.prune();
    if (this.stock.length || !this.opt.persistKey) return undefined;
    const stale = staleBatch(this.opt.persistKey);
    if (!stale?.length) return undefined;
    this.opt.log?.(`${this.name}: stock empty, ${stale.length} earlier videos served while it fills`);
    return { items: stale, warnings: [], ready: 0, fromStock: false, stale: true };
  }

  /** Starts a fill now (after a stale answer), as if a viewer had just asked. */
  warm(): void {
    this.lastTakeAt = this.opt.now();
    void this.fill(true);
  }

  /** Forgets the stock (the source changed its mind, e.g. a sign-out). Keeps the recent-id window. */
  clear(): void {
    this.stock = [];
  }

  /** Stops the background work (process shutdown / tests). */
  stop(): void {
    if (this.fillTimer) clearTimeout(this.fillTimer);
    this.fillTimer = undefined;
    this.lastTakeAt = 0;
  }

  private active(): boolean {
    return this.opt.now() - this.lastTakeAt < this.opt.idleMs;
  }

  /** Runs one fill now (or joins the one in flight) and waits for it, bounded by waitMs. */
  private async waitForFill(): Promise<void> {
    const until = this.opt.now() + this.opt.waitMs;
    // A back-off from an earlier refusal is shortened to what the caller is willing to wait: the
    // viewer is actually out of videos now, which is worth one more try.
    while (this.opt.now() < until) {
      const p = this.filling || this.fill(true);
      await Promise.race([p, new Promise((r) => setTimeout(r, Math.max(0, until - this.opt.now())))]);
      if (this.stock.length || this.lastError) return;
    }
  }

  /** Plans the next background fill when the stock is low and a client is active. */
  private scheduleFill(): void {
    if (this.fillTimer || this.filling) return;
    if (!this.active() || this.stock.length >= this.opt.low) return;
    const now = this.opt.now();
    const wait = Math.max(this.backoffUntil - now, this.lastFillAt + this.opt.gapMs - now, 0);
    this.fillTimer = setTimeout(() => {
      this.fillTimer = undefined;
      void this.fill(false);
    }, wait);
  }

  private fill(urgent: boolean): Promise<void> {
    if (this.filling) return this.filling;
    if (this.fillTimer) clearTimeout(this.fillTimer);
    this.fillTimer = undefined;
    // A background fill planned earlier is skipped when the feed went idle or TikTok asked for a pause.
    if (!urgent && (!this.active() || this.opt.now() < this.backoffUntil)) {
      this.scheduleFill();
      return Promise.resolve();
    }
    this.filling = this.fillOnce()
      .catch(() => undefined)
      .finally(() => {
        this.filling = undefined;
        this.scheduleFill();
      });
    return this.filling;
  }

  private async fillOnce(): Promise<void> {
    this.lastFillAt = this.opt.now();
    try {
      // Always a full batch: the source's cost per call is the same, and duplicates are dropped anyway.
      const r = await this.fetch({ count: this.opt.batch, index: this.fillIndex++, lastAdded: this.lastAdded });
      const now = this.opt.now();
      let added = 0;
      let dupes = 0;
      for (const it of r.items) {
        if (this.recent.has(it.id) || this.stock.some((x) => x.id === it.id)) {
          dupes++;
          continue;
        }
        if (expiredSoon(it, now)) continue;
        this.recent.set(it.id, now);
        this.stock.push(it);
        added++;
      }
      this.lastWarnings = r.warnings;
      this.lastError = undefined;
      this.lastAdded = added;
      if (added) this.persist();
      if (added >= this.opt.dryBelow) {
        this.failures = 0;
        this.backoffUntil = 0;
      } else if (added) {
        // Mostly repeats: the source's pool is nearly used up for the moment; let it rotate.
        this.failures = 0;
        this.backoffUntil = now + this.opt.dryMs;
      } else {
        // Only duplicates or nothing at all: the source needs a pause before it varies its answer.
        this.failures++;
        this.backoffUntil = now + Math.min(60_000, 3000 * 2 ** Math.min(this.failures - 1, 5));
        this.lastError = new Error(r.items.length ? `only duplicates (${dupes}) came back; waiting ${Math.round((this.backoffUntil - now) / 1000)} s` : 'the source returned no items');
      }
      this.opt.log?.(`${this.name}: +${added} (${dupes} duplicates), ${this.stock.length} ready, ${this.recent.size} ids remembered`);
    } catch (e) {
      const now = this.opt.now();
      this.failures++;
      this.lastAdded = 0;
      this.backoffUntil = now + Math.min(60_000, 3000 * 2 ** Math.min(this.failures - 1, 5));
      this.lastError = e as Error;
      this.opt.log?.(`${this.name}: fill failed (${(e as Error).message}); next try in ${Math.round((this.backoffUntil - now) / 1000)} s`);
      throw e;
    }
  }

  /** Drops expired stock and old ids. */
  private prune(): void {
    const now = this.opt.now();
    if (this.stock.length) this.stock = this.stock.filter((it) => !expiredSoon(it, now));
    if (this.recent.size > 1000) {
      for (const [id, at] of this.recent) if (now - at > this.opt.recentMs) this.recent.delete(id);
    }
  }
}

/** True when every playable format of the item expires within the next 2 minutes. */
export function expiredSoon(it: FeedItem, now: number): boolean {
  let known = false;
  for (const f of it.formats) {
    if (f.expiresAt === undefined) return false;
    known = true;
    if (f.expiresAt * 1000 > now + 2 * 60 * 1000) return false;
  }
  return known;
}
