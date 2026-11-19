/**
 * Home-screen top-ups: one at a time, and only when the machine has room.
 *
 * The home screen asks, for every platform, that the feed's stock be topped up in the background
 * (so the app opens with fresh videos). Each request is answered at once, and until 2026-11-19 each
 * also started its top-up at once - all platforms together. After a restart every stock is empty,
 * so one visit of the home screen started Instagram's headless browser, TikTok's headless browser
 * and Facebook's 20 MB Reels pages at the same moment, on top of whatever a viewer was watching:
 * the 1 GB VM went into swap and answered nothing for ten minutes (health check and pages
 * included; seen right after the deploy of 2026-11-19).
 *
 * Now the top-ups wait in this queue. The next one starts only when the server is not under
 * pressure and nothing heavy is running (`noRoom` says what is in the way), runs alone until its
 * work is done, and is dropped when the server stayed busy for too long - the app then loads its
 * own feed when it is opened, as it does without a home screen.
 */
export interface TopUpJob {
  /** One job per feed: a second request for the same feed while the first waits is ignored */
  key: string;
  /** For the log: "instagram foryou" */
  what: string;
  /** The headless browser this job works in: that browser being open is not in its way */
  uses?: 'tiktok' | 'instagram';
  /** Starts the top-up (a sign-in check may come first); false when there was nothing to do */
  start: () => Promise<boolean> | boolean;
  /** The work started by `start` is still running */
  running: () => boolean;
  log: (msg: string) => void;
}

export interface TopUpQueueOptions {
  /** What stands in the way of starting this job right now, in words; undefined when there is room */
  noRoom: (job: TopUpJob) => string | undefined;
  /** How long a job waits for room before it is dropped */
  patienceMs?: number;
  /** How long a started job may run before the next one is looked at */
  runMs?: number;
  /** How often room / running are looked at */
  pollMs?: number;
  /** After a start, the time its work gets to show up as running */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface TopUpQueueStats {
  /** The feeds waiting, in order */
  queued: string[];
  /** The feed being topped up */
  running?: string;
  /** What the next job is waiting for */
  waitingFor?: string;
  started: number;
  dropped: number;
}

export interface TopUpQueue {
  /** Queues a top-up; false when one for the same feed waits or runs already */
  add(job: TopUpJob): boolean;
  stats(): TopUpQueueStats;
  /** Resolves when the queue is empty (tests) */
  idle(): Promise<void>;
}

export function createTopUpQueue(options: TopUpQueueOptions): TopUpQueue {
  const patienceMs = options.patienceMs ?? 20 * 60_000;
  const runMs = options.runMs ?? 5 * 60_000;
  const pollMs = options.pollMs ?? 5000;
  const settleMs = options.settleMs ?? 5000;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // never keeps the process alive on its own (shutdown, tests)
        setTimeout(resolve, ms).unref?.();
      }));
  const jobs: TopUpJob[] = [];
  let current: TopUpJob | undefined;
  let waitingFor: string | undefined;
  let started = 0;
  let dropped = 0;
  let loop: Promise<void> | undefined;

  async function run(): Promise<void> {
    while (jobs.length) {
      const job = jobs[0]!;
      const giveUpAt = now() + patienceMs;
      let told = false;
      while ((waitingFor = options.noRoom(job)) !== undefined && now() < giveUpAt) {
        if (!told) job.log(`${job.what}: home screen top-up waits (${waitingFor})`);
        told = true;
        await sleep(pollMs);
      }
      jobs.shift();
      if (waitingFor !== undefined) {
        dropped++;
        job.log(`${job.what}: home screen top-up dropped, the server stayed busy for ${Math.round(patienceMs / 60_000)} min (${waitingFor})`);
        waitingFor = undefined;
        continue;
      }
      current = job;
      try {
        if (await job.start()) {
          started++;
          job.log(`${job.what}: started for the home screen`);
          await sleep(settleMs);
          const until = now() + runMs;
          while (job.running() && now() < until) await sleep(pollMs);
        }
      } catch (e) {
        job.log(`${job.what}: home screen top-up failed (${(e as Error)?.message || e})`);
      }
      current = undefined;
    }
  }

  function kick(): void {
    if (loop) return;
    loop = run()
      .catch(() => undefined)
      .then(() => {
        loop = undefined;
        if (jobs.length) kick(); // one added while the loop was ending
      });
  }

  return {
    add(job) {
      if (current?.key === job.key || jobs.some((j) => j.key === job.key)) return false;
      jobs.push(job);
      kick();
      return true;
    },
    stats: () => ({ queued: jobs.map((j) => j.what), running: current?.what, waitingFor, started, dropped }),
    idle: async () => {
      while (loop) await loop;
    },
  };
}
