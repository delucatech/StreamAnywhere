/**
 * What the server is doing right now, in words, for the viewer who is waiting.
 *
 * A wait with a spinner looks the same whether the server is asking YouTube, starting a browser,
 * queued behind another job or frozen. Every piece of work that can take more than a moment
 * registers here: what it is ("Getting a YouTube video ready"), the step it is on ("yt-dlp:
 * running YouTube's player script with Deno") and since when. GET /api/activity serves the list;
 * every page shows it while it waits (client/src/activity.ts).
 *
 * How work gets in:
 *  - API requests: a hook in index.ts starts an activity for each request that can be slow and
 *    ends it when the response is out.
 *  - Jobs of the server's own (a feed top-up, a channel list refresh, a helper starting): track().
 *  - Steps: say('…') anywhere below either of those. The activity is found through
 *    AsyncLocalStorage, so no handle is passed down the call chain; outside any activity say() is a
 *    no-op. A job started inside a request (track() within track()) reports its steps to the
 *    request too, and outlives it when the request ends first (a video lookup goes on after the
 *    viewer's 30 s).
 *
 * Nothing here may throw into the work it describes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActivityEntry, Platform } from '../../shared/types';

export interface Act {
  id: number;
  what: string;
  step?: string;
  startedAt: number;
  stepAt: number;
  platform?: Platform;
  background: boolean;
  parent?: Act;
  endedAt?: number;
  result?: string;
  failed?: boolean;
}

export interface ActivityOptions {
  platform?: Platform;
  /** Work nobody is waiting for (a top-up, a refresh on a timer): listed after the viewers' work */
  background?: boolean;
}

const als = new AsyncLocalStorage<Act>();
const running = new Map<number, Act>();
/** Ended activities stay listed this long, so the viewer sees how a wait ended ("done in 12 s", "failed: …") */
const KEEP_ENDED_MS = 8_000;
/** ...when they ran at least this long (a request answered at once is not news) */
const KEEP_ENDED_MIN_MS = 1_500;
/** An activity nobody ended (a job that died without its finally) leaves the list after this long without a step */
const STALE_MS = 10 * 60 * 1000;
const ended: Act[] = [];
let nextId = 1;

const clip = (text: string, max = 240): string => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** Starts an activity by hand (the request hook); the caller ends it with endActivity(). */
export function beginActivity(what: string, opts: ActivityOptions = {}): Act {
  const now = Date.now();
  const act: Act = { id: nextId++, what: clip(what), startedAt: now, stepAt: now, platform: opts.platform, background: Boolean(opts.background), parent: als.getStore() };
  running.set(act.id, act);
  if (act.parent && !act.parent.endedAt) setStep(act.parent, act.what);
  return act;
}

export function endActivity(act: Act, outcome: { failed?: boolean; result?: string } = {}): void {
  if (act.endedAt) return;
  act.endedAt = Date.now();
  act.failed = Boolean(outcome.failed);
  if (outcome.result) act.result = clip(outcome.result);
  running.delete(act.id);
  if (act.endedAt - act.startedAt >= KEEP_ENDED_MIN_MS) {
    ended.push(act);
    if (ended.length > 20) ended.splice(0, ended.length - 20);
  }
}

/** Runs `fn` inside `act` (say() below it reports to `act`). */
export const inActivity = <T>(act: Act, fn: () => T): T => als.run(act, fn);

function setStep(act: Act, text: string): void {
  act.step = text;
  act.stepAt = Date.now();
  if (act.parent && !act.parent.endedAt) setStep(act.parent, text);
}

/** The step the work in progress is on; a no-op outside any activity. */
export function say(text: string): void {
  try {
    const act = als.getStore();
    if (act && !act.endedAt && text) setStep(act, clip(text));
  } catch {
    /* a status line never breaks the work */
  }
}

/**
 * say() for later: a function that reports steps to the activity of *this* moment, for callbacks
 * that run outside it (a child process's output, a timer set up elsewhere).
 */
export function sayer(): (text: string) => void {
  const act = als.getStore();
  if (!act) return () => undefined;
  return (text) => {
    try {
      if (!act.endedAt && text) setStep(act, clip(text));
    } catch {
      /* a status line never breaks the work */
    }
  };
}

/** Whether a say() here would be seen (to skip building an expensive text). */
export const tracking = (): boolean => Boolean(als.getStore());

/**
 * Runs `work` as an activity of its own: listed from now until it settles, its say() steps shown
 * with it (and with the activity it was started in, when there is one).
 */
export async function track<T>(what: string, opts: ActivityOptions, work: () => Promise<T>): Promise<T> {
  const act = beginActivity(what, opts);
  try {
    const v = await als.run(act, work);
    endActivity(act);
    return v;
  } catch (e) {
    endActivity(act, { failed: true, result: (e as Error)?.message || String(e) });
    throw e;
  }
}

function entryOf(a: Act, now: number): ActivityEntry {
  return {
    id: a.id,
    what: a.what,
    step: a.step && a.step !== a.what ? a.step : undefined,
    forMs: (a.endedAt || now) - a.startedAt,
    stepForMs: a.step && !a.endedAt ? now - a.stepAt : undefined,
    platform: a.platform,
    background: a.background || undefined,
    ended: a.endedAt ? { agoMs: now - a.endedAt, failed: a.failed || undefined, result: a.result } : undefined,
  };
}

/**
 * The list for GET /api/activity: the viewers' work first (oldest first), then the server's own
 * jobs, then what ended in the last seconds. A job started inside a request that is still running
 * is not listed twice: the request carries its steps.
 */
export function activitySnapshot(): ActivityEntry[] {
  const now = Date.now();
  for (const [id, a] of running) if (now - a.stepAt > STALE_MS) running.delete(id);
  while (ended.length && now - (ended[0].endedAt || 0) > KEEP_ENDED_MS) ended.shift();
  const live = [...running.values()].filter((a) => !(a.parent && !a.parent.endedAt));
  live.sort((a, b) => Number(a.background) - Number(b.background) || a.startedAt - b.startedAt);
  // (an ended job is said once: by the request it ran for, when that one is listed too)
  const done = ended.filter((a) => now - (a.endedAt || 0) <= KEEP_ENDED_MS && !(a.parent && (running.has(a.parent.id) || ended.includes(a.parent)))).reverse();
  return [...live, ...done].map((a) => entryOf(a, now));
}

/** For the tests. */
export function resetActivity(): void {
  running.clear();
  ended.length = 0;
}
