/**
 * The platforms the launcher (home.html) offers and the feed page (feed.html?platform=…) plays.
 * Adding a platform = one entry here (plus its server adapter).
 *
 * The icons are original drawings that evoke each service; they are not the official logos.
 */
import { EXPLORE_CATEGORIES, INSTAGRAM_CATEGORIES, YOUTUBE_CATEGORIES, platformOf, type Platform } from '../../shared/types';

export interface PlatformCategory {
  id: number;
  label: string;
}

export interface PlatformDef {
  id: Platform;
  name: string;
  /** Label under the launcher icon */
  short: string;
  /** Feed page for this platform */
  url: string;
  /** Brand-ish colours for the icon tile and the feed's accent */
  accent: string;
  accent2: string;
  tile: string;
  /** Inline SVG (24x24 viewBox) drawn in white on the tile */
  icon: string;
  /** Explore categories (chips above the feed) and the id that means "All" */
  categories: PlatformCategory[];
  defaultCategory: number;
  tabs: { explore: string; foryou: string };
  /** Whether accounts can be followed / messaged (TikTok only) */
  social: boolean;
  /** How the sign-in panel's main button works: TikTok's QR code, or pasted/uploaded cookies (YouTube, Instagram) */
  signIn: 'qr' | 'cookies';
  /** What the sign-in panel says before a sign-in */
  signInHint: string;
  /** The platform serves nobody who is signed out (Instagram): the feed waits for a sign-in */
  loginRequired: boolean;
  /** Cookie sign-in: the site whose cookies are exported, whose sign-in page the server window opens, and the placeholder of the search box */
  cookieSite: string;
  signInWindowOwner: string;
  searchPlaceholder: string;
}

export const PLATFORMS: PlatformDef[] = [
  {
    id: 'tiktok',
    name: 'TikTok',
    short: 'TikTok',
    url: 'feed.html?platform=tiktok',
    accent: '#fe2c55',
    accent2: '#25f4ee',
    tile: 'linear-gradient(145deg, #1b1b22 0%, #000 100%)',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#25f4ee" d="M12.9 3h2.6c.2 1.8 1.4 3.3 3.1 3.8v2.6c-1.2 0-2.3-.4-3.2-1v6.4a5 5 0 1 1-5-5v2.7a2.3 2.3 0 1 0 2.5 2.3V3z" transform="translate(-0.9 0.9)"/><path fill="#fe2c55" d="M12.9 3h2.6c.2 1.8 1.4 3.3 3.1 3.8v2.6c-1.2 0-2.3-.4-3.2-1v6.4a5 5 0 1 1-5-5v2.7a2.3 2.3 0 1 0 2.5 2.3V3z" transform="translate(0.9 -0.9)"/><path fill="#fff" d="M12.9 3h2.6c.2 1.8 1.4 3.3 3.1 3.8v2.6c-1.2 0-2.3-.4-3.2-1v6.4a5 5 0 1 1-5-5v2.7a2.3 2.3 0 1 0 2.5 2.3V3z"/></svg>',
    categories: EXPLORE_CATEGORIES,
    defaultCategory: 120,
    tabs: { explore: 'Explore', foryou: 'For You' },
    social: true,
    signIn: 'qr',
    signInHint: '"Sign in with QR code" shows TikTok\'s login QR here; scan it with the TikTok app on your phone.',
    loginRequired: false,
    cookieSite: 'tiktok.com',
    signInWindowOwner: 'TikTok',
    searchPlaceholder: 'Search videos and accounts',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    short: 'YouTube',
    url: 'feed.html?platform=youtube',
    accent: '#ff0033',
    accent2: '#ffffff',
    tile: 'linear-gradient(145deg, #ff3b3b 0%, #c4001d 100%)',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5.5" width="19" height="13" rx="4.2" fill="#fff"/><path d="M10 9v6l5.2-3z" fill="#c4001d"/></svg>',
    categories: YOUTUBE_CATEGORIES,
    defaultCategory: 0,
    tabs: { explore: 'Shorts', foryou: 'For You' },
    social: false,
    signIn: 'cookies',
    signInHint: 'Sign in with the cookies of a browser that is signed in to YouTube: paste a cookies.txt export below (or choose the file). The server checks them with YouTube and keeps only the youtube.com ones.',
    loginRequired: false,
    cookieSite: 'youtube.com',
    signInWindowOwner: 'Google',
    searchPlaceholder: 'Search YouTube',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    short: 'Instagram',
    url: 'feed.html?platform=instagram',
    accent: '#e1306c',
    accent2: '#fcaf45',
    tile: 'linear-gradient(45deg, #fdc468 0%, #fa7e1e 22%, #d62976 50%, #962fbf 78%, #4f5bd5 100%)',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5.2" fill="none" stroke="#fff" stroke-width="1.9"/><circle cx="12" cy="12" r="3.9" fill="none" stroke="#fff" stroke-width="1.9"/><circle cx="17.1" cy="6.9" r="1.15" fill="#fff"/></svg>',
    categories: INSTAGRAM_CATEGORIES,
    defaultCategory: 0,
    tabs: { explore: 'Reels', foryou: 'For You' },
    social: false,
    signIn: 'cookies',
    signInHint: 'Instagram does not show anything to visitors who are signed out, so it needs a sign-in: use the cookies of a browser that is signed in to Instagram (paste a cookies.txt export below, or choose the file). The server checks them with Instagram and keeps only the instagram.com ones.',
    loginRequired: true,
    cookieSite: 'instagram.com',
    signInWindowOwner: 'Instagram',
    searchPlaceholder: 'Search an @account or paste a link',
  },
];

export const platformById = (id: Platform): PlatformDef => PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];

/** The platform the page was opened for: ?platform=… (the launcher sets it), default TikTok. */
export function currentPlatform(): PlatformDef {
  let v: string | null = null;
  try {
    v = new URLSearchParams(location.search).get('platform');
  } catch {
    /* ignore */
  }
  return platformById(platformOf(v));
}

const LAST_KEY = 'streamanywhere.lastApp';
export function rememberApp(id: Platform | 'lab'): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* ignore */
  }
}
export function lastApp(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) || undefined;
  } catch {
    return undefined;
  }
}
