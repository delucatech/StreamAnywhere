import type { FeedProgress, Platform } from '../../shared/types';

/**
 * What a slow platform job is doing right now (a browser starting, a page loading, video files being
 * looked up), per platform, so the viewer's loading screen can say more than "loading…" while a fill
 * takes a minute or two on the small VM. GET /api/feed/progress serves it; a job clears it when done.
 */
const steps = new Map<Platform, { text: string; at: number }>();

export function setProgress(platform: Platform, text: string): void {
  if (text) steps.set(platform, { text, at: Date.now() });
  else steps.delete(platform);
}

export const clearProgress = (platform: Platform): void => setProgress(platform, '');

export function getProgress(platform: Platform): FeedProgress {
  const s = steps.get(platform);
  // A step nobody has updated for this long belongs to a job that died without clearing it.
  if (!s || Date.now() - s.at > 5 * 60 * 1000) return { platform };
  return { platform, text: s.text, forMs: Date.now() - s.at };
}
