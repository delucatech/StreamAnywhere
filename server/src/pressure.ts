/**
 * How starved the server is right now: memory left on the machine, swap in use, the load per CPU,
 * and how late the event loop runs its timers (a thrashing VM makes everything late at once).
 *
 * The free e2-micro (1 GB, 2 GB swap on a slow disk) was found on 2026-11-04 with 1.2 GB in swap,
 * 97 % of its CPU time waiting on the disk and timers running minutes late: every page and API
 * call of the site stalled for minutes while nothing was wrong with the code. /api/health reports
 * these figures (the home screen and the Live TV page show them while they wait), and the
 * background jobs that can wait (refreshing a channel list, a feed top-up) hold off while the
 * machine is under pressure.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface ServerPressure {
  /** MemTotal / MemAvailable of the machine (Linux: /proc/meminfo; elsewhere os.totalmem / os.freemem), MB */
  totalMb: number;
  availableMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  /** This process: resident set and the V8 heap in use, MB */
  rssMb: number;
  heapMb: number;
  /** One-minute load average per CPU (above ~1.5 the machine is busy) */
  load: number;
  cpus: number;
  /** How late the event loop ran its 500 ms timer at worst over the last ~30 s (ms) */
  lagMs: number;
  /** The machine is starved: little memory left, deep in swap, or the event loop runs seconds late */
  pressure: boolean;
  /** Why, in words, when `pressure` is set */
  reason?: string;
}

const MB = 1024 * 1024;

/** The event-loop lag sampler: a timer that notes how late it fires; the worst of the last ~30 s is kept, decaying. */
let worstLagMs = 0;
let lastTick = Date.now();
const TICK_MS = 500;
const sampler = setInterval(() => {
  const now = Date.now();
  const late = Math.max(0, now - lastTick - TICK_MS);
  lastTick = now;
  // the worst recent value, forgotten over ~30 s (60 ticks) when the loop runs on time again
  worstLagMs = Math.max(late, worstLagMs * 0.93);
  if (worstLagMs < 5) worstLagMs = 0;
}, TICK_MS);
sampler.unref?.();

/** MemAvailable and swap use from /proc/meminfo (Linux); undefined elsewhere. */
function meminfo(): { totalMb: number; availableMb: number; swapTotalMb: number; swapUsedMb: number } | undefined {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (key: string): number | undefined => {
      const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
      return m ? Number(m[1]) : undefined;
    };
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    const swapTotal = kb('SwapTotal') ?? 0;
    const swapFree = kb('SwapFree') ?? 0;
    if (total === undefined || available === undefined) return undefined;
    return { totalMb: Math.round(total / 1024), availableMb: Math.round(available / 1024), swapTotalMb: Math.round(swapTotal / 1024), swapUsedMb: Math.round((swapTotal - swapFree) / 1024) };
  } catch {
    return undefined;
  }
}

/** Below this much available memory the machine is about to swap (the VM has 1 GB) */
export const LOW_MEMORY_MB = Number(process.env.LOW_MEMORY_MB) || 120;
/** An event loop this late means the process is not getting the CPU (or is swapped out) */
export const HIGH_LAG_MS = 1500;

export function serverPressure(): ServerPressure {
  const mi = meminfo();
  const mem = process.memoryUsage();
  const cpus = Math.max(1, os.cpus().length || 1);
  const load = Math.round((os.loadavg()[0] / cpus) * 10) / 10;
  const p: ServerPressure = {
    totalMb: mi?.totalMb ?? Math.round(os.totalmem() / MB),
    availableMb: mi?.availableMb ?? Math.round(os.freemem() / MB),
    swapTotalMb: mi?.swapTotalMb ?? 0,
    swapUsedMb: mi?.swapUsedMb ?? 0,
    rssMb: Math.round(mem.rss / MB),
    heapMb: Math.round(mem.heapUsed / MB),
    load,
    cpus,
    lagMs: Math.round(worstLagMs),
    pressure: false,
  };
  const reasons: string[] = [];
  if (p.availableMb < LOW_MEMORY_MB) reasons.push(`${p.availableMb} MB of memory left`);
  if (p.swapTotalMb && p.swapUsedMb > p.swapTotalMb * 0.5) reasons.push(`${p.swapUsedMb} MB in swap`);
  if (p.lagMs >= HIGH_LAG_MS) reasons.push(`timers running ${(p.lagMs / 1000).toFixed(1)} s late`);
  if (load >= 4) reasons.push(`load ${load} per CPU`);
  if (reasons.length) {
    p.pressure = true;
    p.reason = reasons.join(', ');
  }
  return p;
}

/** Whether a background job that can wait should wait (a one-line reason for the log), else undefined. */
export function pressureReason(): string | undefined {
  const p = serverPressure();
  return p.pressure ? p.reason : undefined;
}

/** A short line for the log / the status pages: "memory 240 MB free, swap 1207 MB, load 4.4, lag 0 ms" */
export const pressureLine = (p: ServerPressure = serverPressure()): string => `memory ${p.availableMb} MB free of ${p.totalMb}, swap ${p.swapUsedMb} MB, load ${p.load}, lag ${p.lagMs} ms${p.pressure ? ' (under pressure)' : ''}`;
