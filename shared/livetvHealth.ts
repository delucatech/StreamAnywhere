/**
 * How well a Live TV stream has been playing: the last tries of it (did the tune open, how long
 * from the tap to the first picture), kept on the server with the preferences, and the rating the
 * page draws from them (the dot on the tile, the order of a channel's backup streams).
 *
 * Shared by the server (keeps the tries) and the page (rates them); pure.
 */
import type { LiveTvRating, LiveTvTry } from './types';

/** Tries kept per stream */
export const HEALTH_TRIES = 10;
/** Tries older than this no longer count (community streams change weekly) */
export const HEALTH_MAX_AGE_MS = 14 * 24 * 3600_000;
/** A first picture later than this after the tap counts against the stream */
export const SLOW_START_MS = 25_000;
/** A first-picture report this long after the tune completes the tune's own entry instead of adding one */
export const HEALTH_AMEND_MS = 3 * 60_000;

/** The tries with `t` added: the old ones dropped, the last HEALTH_TRIES kept, oldest first */
export function pushTry(tries: LiveTvTry[] | undefined, t: LiveTvTry): LiveTvTry[] {
  const cutoff = t.at - HEALTH_MAX_AGE_MS;
  return [...(tries || []).filter((x) => x.at >= cutoff), t].slice(-HEALTH_TRIES);
}

export interface StreamRating {
  rating: LiveTvRating;
  /** Tries that count (within HEALTH_MAX_AGE_MS) and how many of them opened */
  count: number;
  okCount: number;
  /** Typical seconds from the tap to the first picture (the median of the tries that opened and reported it) */
  startSec?: number;
  /** One line for the tooltip */
  text: string;
}

/**
 * good: the last try opened and at least 4 of 5 did (one try that opened counts), and it does
 *       not take ages to start
 * weak: the last try opened but others failed, or it starts slowly; or the last try failed but
 *       half of them opened
 * bad:  the last try failed and most did (one try that failed counts)
 * none: not tried within the window
 */
export function rateStream(tries: LiveTvTry[] | undefined, now = Date.now()): StreamRating {
  const recent = (tries || []).filter((t) => t.at >= now - HEALTH_MAX_AGE_MS && t.at <= now + 60_000);
  const count = recent.length;
  if (!count) return { rating: 'none', count: 0, okCount: 0, text: 'Not tried yet' };
  const okCount = recent.filter((t) => t.ok).length;
  const last = recent[count - 1];
  const starts = recent.filter((t) => t.ok && t.ms && t.ms > 0).map((t) => t.ms!).sort((a, b) => a - b);
  const startSec = starts.length ? Math.round(starts[Math.floor(starts.length / 2)] / 1000) : undefined;
  const slow = startSec !== undefined && startSec * 1000 > SLOW_START_MS;
  const played = count === 1 ? (okCount ? 'played the one time it was tried' : 'did not play the one time it was tried') : `played ${okCount} of the last ${count} times`;
  const start = startSec !== undefined ? `, starts in about ${startSec} s` : '';
  let rating: LiveTvRating;
  let text: string;
  if (last.ok) {
    rating = okCount / count >= 0.8 && !slow ? 'good' : 'weak';
    text = rating === 'good' ? `Good: ${played}${start}` : `Weak: ${played}${slow ? `, slow to start (about ${startSec} s)` : start}`;
  } else {
    rating = count >= 2 && okCount / count >= 0.5 ? 'weak' : 'bad';
    text = rating === 'weak' ? `Weak: did not play last time, but ${played}${start}` : count === 1 ? 'Did not play the one time it was tried' : `Did not play last time (${played})`;
  }
  return { rating, count, okCount, startSec, text };
}

/** For ordering: the streams most likely to play first, the untried before the shaky ones */
export function ratingRank(r: LiveTvRating): number {
  return r === 'good' ? 0 : r === 'none' ? 1 : r === 'weak' ? 2 : 3;
}
