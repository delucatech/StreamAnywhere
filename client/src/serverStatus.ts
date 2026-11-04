/**
 * What the server is up to, for the pages' waiting screens: /api/health (no password needed, cheap)
 * says whether the machine is starved and what the server is busy with. A watcher asks it on a
 * timer while a page waits for something, and tells the page in words:
 *
 *   "Connecting to the server… 12 s"            nothing has answered yet
 *   "The server is busy: refreshing the channel list of IPTV-org – Kids"
 *   "The server is short of memory (84 MB free, 1207 MB in swap): everything takes longer"
 *
 * The free VM thrashes at times (2026-11-04: 1.2 GB in swap, every page stalling for minutes); a
 * line that says so beats a spinner that looks frozen.
 */
import type { HealthResponse, ServerStatus } from '../../shared/types';
import { api } from './api';

export interface ServerWord {
  /** One line for the viewer, or undefined when the server is idle and well */
  line?: string;
  /** The server answered the last health check this long ago (ms); undefined before the first answer */
  answeredAgoMs?: number;
  /** How long the last health check took (ms) */
  tookMs?: number;
  /** The answer is pending this long (ms) */
  pendingMs?: number;
  status?: ServerStatus;
  /** The last check failed (no answer in time, or an error): the server (or the connection) is down or stalled */
  failed?: boolean;
}

/** The health answer in one line, or undefined when there is nothing to say. */
export function describeServer(h: HealthResponse | undefined): string | undefined {
  const s = h?.server;
  if (!s) return undefined;
  const busy = s.busy.length ? `busy: ${s.busy.join(', ')}` : '';
  if (s.pressure) {
    // the server's own reason ("timers running 3.2 s late", "84 MB of memory left, 1207 MB in swap")
    const why = s.reason || (s.swapMb > 0 ? `${s.memoryMb} MB of memory free, ${s.swapMb} MB in swap` : `${s.memoryMb} MB of memory free`);
    return `The server is under pressure (${why})${busy ? `, ${busy}` : ''}: everything takes longer.`;
  }
  if (busy) return `The server is ${busy}.`;
  return undefined;
}

/**
 * Asks /api/health every `everyMs` while running and reports each answer (and each wait) through
 * `onWord`. Starts at once; stop() ends it. The clock in the words ticks every second.
 */
export function watchServer(onWord: (w: ServerWord) => void, opts: { everyMs?: number; timeoutMs?: number } = {}): { stop(): void; last(): ServerWord } {
  const everyMs = opts.everyMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 8000;
  let stopped = false;
  let word: ServerWord = {};
  let askedAt = 0;
  let answeredAt = 0;
  let inFlight = false;
  let timer = 0;
  const tell = (): void => {
    const now = Date.now();
    onWord({ ...word, answeredAgoMs: answeredAt ? now - answeredAt : undefined, pendingMs: inFlight ? now - askedAt : undefined });
  };
  const ask = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    askedAt = Date.now();
    try {
      const h = await api.health(timeoutMs);
      answeredAt = Date.now();
      word = { line: describeServer(h), tookMs: answeredAt - askedAt, status: h.server, failed: false };
    } catch (e) {
      word = { ...word, failed: true, line: navigator.onLine ? `The server did not answer the health check (${(e as Error).message}).` : 'You are offline.' };
    } finally {
      inFlight = false;
    }
    tell();
  };
  const tick = (): void => {
    if (stopped) return;
    tell();
    if (!inFlight && Date.now() - askedAt >= everyMs) void ask();
    timer = window.setTimeout(tick, 1000);
  };
  void ask();
  timer = window.setTimeout(tick, 1000);
  return {
    stop: () => {
      stopped = true;
      window.clearTimeout(timer);
    },
    last: () => word,
  };
}
