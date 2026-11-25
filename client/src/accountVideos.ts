/**
 * The videos a device keeps for an app were loaded as ONE of the server's accounts (TikTok keeps
 * several, one active at a time): the saved feed that plays on when the page reopens, the bytes in
 * the media cache, the results of recent searches. When another account becomes the active one -
 * switched on this device, or on another one (the accounts live on the server) - none of that is
 * kept: the feed, its position and the cached files of the previous account go, and the new
 * account's are loaded.
 *
 * Each page remembers which account its videos belong to (localStorage) and compares it with what
 * the server names: in the session status, in the accounts list and with every For You answer.
 */
import type { Platform } from '../../shared/types';
import { dropCached } from './feed/mediaCache';

const key = (platform: Platform): string => `streamanywhere.account.${platform}`;
/** What this page was told last (also when storage is unavailable) */
const told = new Map<Platform, string>();

function remembered(platform: Platform): string | undefined {
  const t = told.get(platform);
  if (t !== undefined) return t;
  try {
    return localStorage.getItem(key(platform)) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Notes that `account` is the server's active account for this app. True when this device's videos
 * were loaded as another one (the caller then drops them); false the first time an account is named.
 */
export function accountIs(platform: Platform, account: string | undefined): boolean {
  if (!account) return false;
  const before = remembered(platform);
  told.set(platform, account);
  try {
    localStorage.setItem(key(platform), account);
  } catch {
    /* storage unavailable: `told` remembers for this visit */
  }
  return before !== undefined && before !== account;
}

/**
 * Forgets what this device keeps of the app's videos: the saved feed and its position, the results
 * of recent searches (the phrases stay: they are the viewer's, not the account's) and the app's
 * files in the media cache. How many cached files went.
 */
export async function dropStoredVideos(platform: Platform): Promise<number> {
  try {
    localStorage.removeItem(`streamanywhere.resume.${platform}`);
    localStorage.removeItem(`streamanywhere.resume.${platform}.at`);
    const k = `streamanywhere.search.${platform}`;
    const m = JSON.parse(localStorage.getItem(k) || 'null') as { results?: unknown } | null;
    if (m && typeof m === 'object' && m.results) {
      m.results = {};
      localStorage.setItem(k, JSON.stringify(m));
    }
  } catch {
    /* storage unavailable */
  }
  return dropCached(platform);
}
