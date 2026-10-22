/**
 * Feed page: a TikTok-style vertical stream.
 *
 *  - Source "Explore" (no sign-in) or "For You" (the signed-in account's feed; needs the Node
 *    server with a Chrome/Edge session, see server/src/session.ts). Tabs in the transparent top bar.
 *  - One full-height <canvas> per item; the items are stacked in a track that is translated (no
 *    native scrolling): a drag moves the track with the finger / mouse, the next video coming in
 *    from below (or the previous from above), and on release it snaps to one video, which plays
 *    while the others pause. Items near the end trigger the next batch, and a batch that brings
 *    nothing is retried with a growing delay, so the feed never "ends" (like the app).
 *  - Swipe (touch) or drag (mouse) up/down = next/previous video. Tap/click = pause/resume.
 *    ↑/↓ (or J/K) move, Space pauses, M mutes, F fullscreen, D downloads, A toggles auto-scroll,
 *    W hides the bars.
 *  - Right-hand action column: who posted it (profile, with a follow "+" on the avatar for a signed-in
 *    TikTok account), the likes and comments, sound, save (download), auto-scroll (phones only: wide
 *    screens have the switch on the Up next panel; the choice is shared by every app), playback speed
 *    (S: 0.5× to 2×, 1× on every visit), fullscreen. Bottom bar: Home, Friends, + (placeholders), Inbox (messages), Profile (sign-in:
 *    TikTok's QR code / window; YouTube's pasted cookies / window, see platforms.ts `signIn`).
 *  - Search (top bar) and account profiles (social.ts) hand the feed a play list: search results
 *    or an account's videos then play in place of the source, with a pill to go back. The video
 *    pauses while any panel (search, profile, inbox, sign-in) covers the feed and resumes on close.
 *  - Download: fetches the cookie-free CDN URL (CORS *) as a blob and saves it as @author_id.mp4;
 *    falls back to the server proxy when the direct fetch fails.
 *
 * Playback is canvas-only (see player.ts): the WebCodecs pipeline (fetch → mp4box → VideoDecoder →
 * canvas 2D + Web Audio) paints each item's <canvas>; no <video> element is on the page. Where
 * WebCodecs is missing, a hidden <video> decodes and its frames are copied into the same canvas.
 * The active item and its two neighbours hold a player; the others are released.
 *
 * Media cache (mediaCache.ts): what a player downloaded is kept in IndexedDB when the download
 * finishes or the player is released, and a video that comes up again (back to the previous one,
 * back to this app from another, the saved feed after the page was closed) is fed from disk first,
 * the rest from the network. A sweep between videos makes room (see mediaCache.ts).
 */
import type { FeedAuthor, FeedItem, FeedSource, FollowState, LoginMode, MediaFormat, SessionInputRequest, SessionStatus } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';
import { pressed } from '../busy';
import type { MediaPrefix } from '../media/demuxer';
import { currentPlatform, PLATFORMS, rememberApp, type PlatformDef } from '../platforms';
import { fileKey, getCached, itemKey, MAX_AGE as CACHE_MAX_AGE, overBudget, putCached, sweep, type CacheRole } from './mediaCache';
import { FeedPlayer, feedPlayerMode } from './player';
import { closeTopPanel, initSocial, openInbox, openProfile, openSearch, panelOpen, reopenPlayList, type PlayList } from './social';

// feed.html's failsafe reports whether this script ran at all
(window as unknown as { streamAnywhereStarted: boolean }).streamAnywhereStarted = true;

/** The platform this page plays (feed.html?platform=…, set by the launcher); it colours and labels the page. */
const P = currentPlatform();
rememberApp(P.id);
document.title = `${P.name} – StreamAnywhere`;
document.body.classList.add(`platform-${P.id}`);
document.documentElement.style.setProperty('--accent', P.accent);
document.documentElement.style.setProperty('--accent-2', P.accent2);
// The page and its scripts come from this device from the second open on (public/sw.js).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[feed] service worker not registered', e));

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const el = {
  app: $('app'),
  homeLink: $<HTMLAnchorElement>('homeLink'),
  feed: $('feed'),
  track: $('track'),
  tabs: $('tabs'),
  chips: $('chips'),
  context: $('context'),
  contextLabel: $('contextLabel'),
  contextBack: $<HTMLButtonElement>('contextBack'),
  contextClose: $<HTMLButtonElement>('contextClose'),
  searchBtn: $<HTMLButtonElement>('searchBtn'),
  actAuthor: $<HTMLButtonElement>('actAuthor'),
  actAuthorImg: $<HTMLImageElement>('actAuthorImg'),
  actAuthorLabel: $('actAuthorLabel'),
  actFollow: $<HTMLButtonElement>('actFollow'),
  actLikes: $('actLikes'),
  actLikesLabel: $('actLikesLabel'),
  actComments: $('actComments'),
  actCommentsLabel: $('actCommentsLabel'),
  actMute: $<HTMLButtonElement>('actMute'),
  actMuteIco: $('actMuteIco'),
  actDownload: $<HTMLButtonElement>('actDownload'),
  actDownloadIco: $('actDownloadIco'),
  actAuto: $<HTMLButtonElement>('actAuto'),
  actAutoLabel: $('actAutoLabel'),
  actFull: $<HTMLButtonElement>('actFull'),
  actSpeed: $<HTMLButtonElement>('actSpeed'),
  actSpeedIco: $('actSpeedIco'),
  speed: $('speed'),
  speedCard: $('speedCard'),
  fsExit: $<HTMLButtonElement>('fsExit'),
  navHome: $<HTMLButtonElement>('navHome'),
  navFriends: $<HTMLButtonElement>('navFriends'),
  navApp: $<HTMLButtonElement>('navApp'),
  navAppTile: $('navAppTile'),
  navInbox: $<HTMLButtonElement>('navInbox'),
  navProfile: $<HTMLButtonElement>('navProfile'),
  navProfileLabel: $('navProfileLabel'),
  session: $('session'),
  sessionText: $('sessionText'),
  sessionCookies: $<HTMLFormElement>('sessionCookies'),
  sessionCookiesText: $<HTMLTextAreaElement>('sessionCookiesText'),
  sessionCookiesFile: $<HTMLInputElement>('sessionCookiesFile'),
  sessionCookiesPick: $<HTMLButtonElement>('sessionCookiesPick'),
  sessionCookiesSend: $<HTMLButtonElement>('sessionCookiesSend'),
  sessionCookiesResult: $('sessionCookiesResult'),
  sessionCookiesLabel: $('sessionCookiesLabel'),
  sessionCookiesHelp: $('sessionCookiesHelp'),
  sessionLogin: $<HTMLButtonElement>('sessionLogin'),
  sessionLoginWindow: $<HTMLButtonElement>('sessionLoginWindow'),
  sessionQr: $('sessionQr'),
  sessionQrImg: $<HTMLImageElement>('sessionQrImg'),
  sessionQrHint: $('sessionQrHint'),
  sessionCode: $<HTMLFormElement>('sessionCode'),
  sessionCodeText: $<HTMLInputElement>('sessionCodeText'),
  sessionCodeSend: $<HTMLButtonElement>('sessionCodeSend'),
  sessionCodeResult: $('sessionCodeResult'),
  sessionCodeMeta: $('sessionCodeMeta'),
  sessionCodeResend: $<HTMLButtonElement>('sessionCodeResend'),
  sessionInput: $('sessionInput'),
  sessionManualToggle: $<HTMLButtonElement>('sessionManualToggle'),
  sessionInputText: $<HTMLInputElement>('sessionInputText'),
  sessionInputType: $<HTMLButtonElement>('sessionInputType'),
  sessionInputEnter: $<HTMLButtonElement>('sessionInputEnter'),
  sessionInputBack: $<HTMLButtonElement>('sessionInputBack'),
  sessionRefresh: $<HTMLButtonElement>('sessionRefresh'),
  sessionCancel: $<HTMLButtonElement>('sessionCancel'),
  sessionRestart: $<HTMLButtonElement>('sessionRestart'),
  sessionNotice: $('sessionNotice'),
  sessionLogout: $<HTMLButtonElement>('sessionLogout'),
  sessionClose: $<HTMLButtonElement>('sessionClose'),
  start: $('start'),
  startBtn: $<HTMLButtonElement>('startBtn'),
  toast: $('toast'),
  loading: $('loading'),
  loadingTitle: $('loadingTitle'),
  loadingDetail: $('loadingDetail'),
  // wide-screen layout (the car): rail, header title, Up next
  railLauncher: $<HTMLButtonElement>('railLauncher'),
  railApps: $('railApps'),
  railFriends: $<HTMLButtonElement>('railFriends'),
  railInbox: $<HTMLButtonElement>('railInbox'),
  railProfile: $<HTMLButtonElement>('railProfile'),
  railProfileLabel: $('railProfileLabel'),
  appName: $('appName'),
  appSub: $('appSub'),
  searchLabel: $('searchLabel'),
  upnextAuto: $<HTMLButtonElement>('upnextAuto'),
  upnextList: $('upnextList'),
  upnextStatus: $('upnextStatus'),
  upnextStatusTitle: $('upnextStatusTitle'),
  upnextStatusDetail: $('upnextStatusDetail'),
};

/** Stroke icons of the action column (the mute and save icons change, so they are set from here). */
const icon = (paths: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  muted: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  save: icon('<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>'),
};

interface Entry {
  item: FeedItem;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Canvas player; exists only while the item is active or a neighbour of the active one */
  player?: FeedPlayer;
  progress: HTMLElement;
  /** The lighter line behind the progress: how much of the video has been downloaded */
  downloaded: HTMLElement;
  err: HTMLElement;
  /** Which URL the player currently uses */
  src?: SourceCandidate;
  triedProxy: boolean;
  failed: boolean;
  /** True while the viewer drags the progress bar (the ticker must not move it then) */
  isSeeking: () => boolean;
  /** Play URLs being fetched for an item that came without any (guest search results) */
  resolving?: Promise<boolean>;
  /** The status shown on the video while it waits (see syncWait) */
  waitEl: HTMLElement;
  waitText: HTMLElement;
  /** The player reports loading / buffering */
  buffering: boolean;
  /** The direct URL failed; the proxy is being tried */
  retrying: boolean;
  /** Came from the saved feed (see resume): its play URLs may have expired, so a failure re-resolves once */
  restored?: boolean;
  reresolved?: boolean;
  /** Where the viewer was in this video when the page closed; applied once it plays */
  resumeAt?: number;
  /** Bumped per attachSource: a cache lookup that finishes after the next one must not load */
  loadGen: number;
  /** Bytes of each file already handed to the media cache for this player (nothing is stored twice) */
  stored: { video: number; audio: number };
}

const playerMode = feedPlayerMode();
let playerModeAnnounced = false;

// ---------- layout: phone (full-screen video + bars) or wide (the theater rail, theater.css) ----------
// Wide whenever the window has room for the rail, the 9:16 column and Up next side by side and is
// not taller than wide: the car (its browser window is close to square beside the car panel),
// tablets and desktops in landscape. Phones, also turned sideways (too short), keep the phone layout.
// ?layout=wide|phone|auto overrides that and is remembered on this device.
const LAYOUT_KEY = 'streamanywhere.layout';
const layoutPick = ((): 'auto' | 'wide' | 'phone' => {
  let v: string | null = null;
  try {
    v = new URLSearchParams(location.search).get('layout');
    if (v === 'auto' || v === 'wide' || v === 'phone') localStorage.setItem(LAYOUT_KEY, v);
    else v = localStorage.getItem(LAYOUT_KEY);
  } catch {
    /* storage unavailable */
  }
  return v === 'wide' || v === 'phone' ? v : 'auto';
})();
function applyLayout(): boolean {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const wide = layoutPick === 'wide' || (layoutPick === 'auto' && w >= 760 && h >= 480 && w >= h);
  el.app.classList.toggle('wide', wide);
  fitStage(wide, w, h);
  return wide;
}
/**
 * The wide layout's panel is 9:16 and as tall as the stage – unless the width beside the rail, the
 * Up next column and the action column runs out first: then it came out shorter and sat between
 * two black bands (an 855x815 window, 2026-10-20). The side parts give way instead: the air beside
 * the panel and the stage padding shrink, Up next narrows to 170 px, then goes. The numbers are
 * theater.css's (--side); the result goes back to it as --upnext-w / --feed-air and two classes.
 */
function fitStage(wide: boolean, w: number, h: number): void {
  const st = el.app.style;
  if (!wide || el.app.classList.contains('fullwindow')) {
    st.removeProperty('--upnext-w');
    st.removeProperty('--feed-air');
    el.app.classList.remove('tight', 'no-upnext', 'upnext-narrow');
    return;
  }
  const stageH = h - (el.app.classList.contains('no-row2') ? 84 : 136);
  const panelW = (stageH * 9) / 16;
  const fixed = 92 + 18 + 76 + 16; // rail, gap, action column, air
  const preferred = Math.min(300, Math.max(230, w * 0.24)); // the CSS clamp for Up next
  let upnext = preferred;
  let air = 32;
  let pad = 24;
  const spare = (): number => w - fixed - panelW - 2 * pad - 2 * air - upnext;
  if (spare() < 0) {
    air = 8;
    pad = 12;
  }
  if (spare() < 0) upnext = Math.max(170, upnext + spare());
  if (spare() < 0) upnext = 0;
  el.app.classList.toggle('tight', air < 32);
  el.app.classList.toggle('no-upnext', upnext === 0);
  el.app.classList.toggle('upnext-narrow', upnext > 0 && upnext < preferred);
  if (upnext === preferred) st.removeProperty('--upnext-w');
  else st.setProperty('--upnext-w', `${Math.round(upnext)}px`);
  if (air === 32) st.removeProperty('--feed-air');
  else st.setProperty('--feed-air', `${air}px`);
}
window.addEventListener('resize', applyLayout);
{
  const wide = applyLayout();
  // The screen this page runs on, once per load (server log): sizes the layout rules for the car.
  void api.report({ kind: 'screen', ok: true, connection: 'local', renderer: playerMode.mode, platform: P.id, detail: `${window.innerWidth}x${window.innerHeight} css px, dpr ${window.devicePixelRatio}, screen ${screen.width}x${screen.height}, layout ${wide ? 'wide' : 'phone'} (${layoutPick})`, page: location.pathname + location.search, ua: navigator.userAgent });
}

/** Preferences are kept per platform (the TikTok key predates the launcher) */
const PREFS_KEY = P.id === 'tiktok' ? 'streamanywhere.feed' : `streamanywhere.feed.${P.id}`;
interface Prefs {
  source: FeedSource;
  /** 'user' when the source is a tab the viewer tapped; 'auto' when the sign-in state chose it */
  pick: 'auto' | 'user';
  category: number;
  autoscroll: boolean;
  muted: boolean;
}
/** Auto-scroll is one choice for every app (switched on YouTube, it holds on TikTok too), kept apart from the per-app settings. */
const SHARED_PREFS_KEY = 'streamanywhere.feed.shared';
function loadPrefs(): Prefs {
  const def: Prefs = { source: 'explore', pick: 'auto', category: P.defaultCategory, autoscroll: true, muted: false };
  try {
    const own = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>;
    const shared = JSON.parse(localStorage.getItem(SHARED_PREFS_KEY) || '{}') as Partial<Pick<Prefs, 'autoscroll'>>;
    const p = { ...def, ...own };
    if (typeof shared.autoscroll === 'boolean') p.autoscroll = shared.autoscroll;
    return p;
  } catch {
    return def;
  }
}
function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    localStorage.setItem(SHARED_PREFS_KEY, JSON.stringify({ autoscroll: prefs.autoscroll }));
  } catch {
    /* ignore */
  }
}
const prefs = loadPrefs();

/** What the feed plays: the chosen source, or a play list handed over by search / a profile. */
type FeedMode = { kind: 'source' } | PlayList;

const state = {
  mode: { kind: 'source' } as FeedMode,
  entries: [] as Entry[],
  ids: new Set<string>(),
  active: -1,
  started: false,
  loading: false,
  exhausted: false,
  generation: 0,
  session: undefined as SessionStatus | undefined,
  sessionPoll: 0,
  userPaused: false,
  /** The viewer asked for a video past the end; advance as soon as one arrives */
  wantNext: false,
  /** Consecutive batches that brought nothing (drives the retry delay) */
  emptyBatches: 0,
  /** ms epoch before which no batch is requested: the server said the platform is limiting it (HTTP 429) */
  pauseUntil: 0,
  retryTimer: 0,
};
/** How long a 429 ("limited, try later") from the server pauses the feed's retries. */
const LIMITED_PAUSE_MS = 120_000;

// ---------- helpers ----------
let toastTimer = 0;
function toast(msg: string, isError = false, ms = 3500): void {
  el.toast.textContent = msg;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.add('hidden'), ms);
}
const fmtCount = (n?: number): string => (n === undefined ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const fmtBytes = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const errMsg = (e: unknown): string => (e instanceof ApiError ? `${e.message} (HTTP ${e.status})` : (e as Error)?.message || String(e));
/** Tells the server what went wrong on this device (it lands in /api/log, tagged client) - at most one report every 2 s per kind. */
const reportedAt = new Map<string, number>();
function reportProblem(kind: string, detail: string, extra: { url?: string; mediaId?: string; connection?: 'direct' | 'proxy' } = {}): void {
  const now = Date.now();
  if (now - (reportedAt.get(kind) || 0) < 2000) return;
  reportedAt.set(kind, now);
  void api.report({ kind, platform: P.id, ok: false, detail: detail.slice(0, 500), connection: extra.connection || 'proxy', renderer: playerMode.mode, url: extra.url, mediaId: extra.mediaId, page: location.pathname + location.search, ua: navigator.userAgent });
}
window.addEventListener('error', (e) => reportProblem('page error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => reportProblem('unhandled rejection', errMsg(e.reason)));
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Prefer H.264 (the formats are already sorted that way), then anything with a direct or proxy URL. */
function pickFormat(item: FeedItem): MediaFormat | undefined {
  return item.formats.find((f) => f.codec === 'h264' && (f.directUrl || f.proxyUrl)) || item.formats.find((f) => f.directUrl || f.proxyUrl);
}
interface SourceCandidate {
  url: string;
  kind: 'direct' | 'proxy';
  /** The sound, when it comes as a second file (YouTube) */
  audioUrl?: string;
}
function sourceCandidates(item: FeedItem): SourceCandidate[] {
  const f = pickFormat(item);
  if (!f) return [];
  const out: SourceCandidate[] = [];
  const audioUrl = f.audioProxyUrl ? apiUrl(f.audioProxyUrl) : undefined;
  if (f.directUrl) out.push({ url: f.directUrl, kind: 'direct', audioUrl });
  if (f.proxyUrl) out.push({ url: apiUrl(f.proxyUrl), kind: 'proxy', audioUrl });
  return out;
}
const activeEntry = (): Entry | undefined => state.entries[state.active];
/** Clicks before this time are the tail of a drag or a seek and must not toggle pause. */
let suppressClickUntil = 0;

// ---------- top bar: source tabs + explore categories ----------
function renderSourceUi(): void {
  const listMode = state.mode.kind !== 'source';
  for (const b of el.tabs.querySelectorAll<HTMLButtonElement>('.tab')) b.classList.toggle('active', !listMode && b.dataset.source === prefs.source);
  const chips = !listMode && prefs.source === 'explore';
  el.chips.classList.toggle('hidden', !chips);
  el.context.classList.toggle('hidden', !listMode);
  // nothing under the header (For You, and every tab without categories): the wide layout drops that row
  el.app.classList.toggle('no-row2', !chips && !listMode);
  applyLayout(); // the stage's height changed with the row: the panel's width budget too (fitStage)
  if (state.mode.kind === 'search') el.contextLabel.textContent = `Search: ${state.mode.q}`;
  else if (state.mode.kind === 'profile') el.contextLabel.textContent = `@${state.mode.user}`;
  const back = state.mode.kind === 'profile' ? `Back to @${state.mode.user}` : 'Back to the search results';
  el.contextBack.title = back;
  el.contextBack.setAttribute('aria-label', back);
  for (const c of el.chips.querySelectorAll<HTMLButtonElement>('.chip')) c.classList.toggle('active', Number(c.dataset.id) === prefs.category);
  // Wide-screen header: the app's name, then what plays (tab · category, or the search / account)
  const tabName = prefs.source === 'foryou' ? P.tabs.foryou : P.tabs.explore;
  const cat = prefs.source === 'explore' && prefs.category !== P.defaultCategory ? P.categories.find((c) => c.id === prefs.category) : undefined;
  el.appSub.textContent = listMode ? el.contextLabel.textContent || '' : cat ? `${tabName} · ${cat.label}` : tabName;
}
async function setSource(src: FeedSource, announce = true): Promise<void> {
  if ((src === 'foryou' || P.loginRequired) && state.session?.state !== 'logged_in') {
    // Keep Explore until a session exists; the panel switches once signed in.
    await openSessionPanel();
    return;
  }
  if (prefs.source === src && state.mode.kind === 'source') return;
  prefs.source = src;
  prefs.pick = 'user';
  state.mode = { kind: 'source' };
  savePrefs();
  renderSourceUi();
  if (announce) toast(src === 'foryou' ? P.tabs.foryou : P.tabs.explore);
  await reload();
}
/** Plays a list from search or a profile (social.ts), starting at `startIndex`. */
function playList(list: PlayList, startIndex: number): void {
  state.mode = list;
  renderSourceUi();
  toast(list.kind === 'search' ? `Search: ${list.q}` : `Videos of @${list.user}`);
  // One history entry per list, so the browser's Back (the car's, the phone's) returns to the panel.
  if (!history.state?.saList) history.pushState({ saList: true }, '');
  void reload(list.items, startIndex);
}
/**
 * Back from a playing list to the panel it came from: the ← button, a swipe / drag to the right,
 * Escape / Backspace, and the browser's Back. The list keeps playing (paused) behind the panel.
 */
function backToPanel(): void {
  if (state.mode.kind === 'source') return;
  if (history.state?.saList) history.back(); // popstate reopens the panel
  else reopenPlayList(state.mode);
}
window.addEventListener('popstate', () => {
  if (state.mode.kind === 'source') return;
  if (panelOpen()) closeTopPanel();
  else reopenPlayList(state.mode);
});
el.contextBack.addEventListener('click', backToPanel);
el.contextLabel.addEventListener('click', backToPanel);
el.contextClose.addEventListener('click', () => {
  if (state.mode.kind === 'source') return;
  state.mode = { kind: 'source' };
  renderSourceUi();
  void reload();
});
for (const b of el.tabs.querySelectorAll<HTMLButtonElement>('.tab')) b.textContent = b.dataset.source === 'foryou' ? P.tabs.foryou : P.tabs.explore;
for (const c of P.categories) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.dataset.id = String(c.id);
  b.textContent = c.label;
  b.addEventListener('click', () => {
    if (prefs.category === c.id) return;
    prefs.category = c.id;
    savePrefs();
    renderSourceUi();
    pressed(b, () => reload());
  });
  el.chips.appendChild(b);
}
el.tabs.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.tab');
  if (b?.dataset.source) pressed(b, () => setSource(b.dataset.source as FeedSource));
});
el.searchBtn.addEventListener('click', () => openSearch());
el.searchLabel.textContent = P.searchPlaceholder;
el.appName.textContent = P.name;
renderSourceUi();

// ---------- actions column + bottom bar ----------
el.actMute.addEventListener('click', () => toggleMute());
el.actDownload.addEventListener('click', () => {
  const cur = activeEntry();
  if (cur) void download(cur);
});
el.actAuto.addEventListener('click', () => toggleAutoscroll());
el.actFull.addEventListener('click', () => toggleFullscreen());
el.fsExit.addEventListener('click', () => setFullscreen(false));
el.navHome.addEventListener('click', () => {
  if (state.active > 0) goTo(0);
  else pressed(el.navHome, () => reload());
});
el.navFriends.addEventListener('click', () => toast('Friends is coming later'));
// The middle of the bottom bar shows the icon of the app in use (so it is clear which one this is);
// tapping it goes back to the launcher like the top-left home link.
el.navAppTile.style.background = P.tile;
el.navAppTile.innerHTML = P.icon;
el.navApp.title = `${P.name}: home screen (all apps)`;
el.navApp.setAttribute('aria-label', `${P.name}: home screen`);
onHomeTap(el.navApp);
el.navInbox.addEventListener('click', () => (P.social ? pressed(el.navInbox, () => openInbox()) : toast(`Messages are not available for ${P.name}`)));
el.actAuthor.addEventListener('click', () => {
  const cur = activeEntry();
  if (cur?.item.author.uniqueId) void openProfile(cur.item.author.uniqueId);
});
// The "+" on the avatar: follow the account of the video in view; the badge goes once the account is followed.
el.actFollow.addEventListener('click', () => {
  const user = activeEntry()?.item.author.uniqueId;
  if (!user) return;
  if (state.session?.state !== 'logged_in') {
    toast(`Sign in to ${P.name} first to follow accounts`, true, 4000);
    void openSessionPanel();
    return;
  }
  pressed(el.actFollow, async () => {
    try {
      const r = await api.follow({ user, follow: true });
      rememberFollowState(user, r.followState);
      toast(r.followState === 'none' ? `Could not follow @${user}` : r.followState === 'requested' ? `Follow request sent to @${user}` : `Following @${user}`);
      for (const w of r.warnings) console.warn('[follow]', w);
    } catch (e) {
      toast(`Follow failed: ${errMsg(e)}`, true, 6000);
    }
    syncFollow(activeEntry());
  });
});
/** What the signed-in account's follow state of each author is known to be here (follows done on this page, profiles opened). */
const followKnown = new Map<string, FollowState>();
function rememberFollowState(user: string, s: FollowState): void {
  if (s === 'unknown') return;
  followKnown.set(user.toLowerCase(), s);
  for (const e of state.entries) if (e.item.author.uniqueId?.toLowerCase() === user.toLowerCase()) e.item.author.followState = s;
}
const followStateOf = (a: FeedAuthor): FollowState | undefined => (a.uniqueId ? followKnown.get(a.uniqueId.toLowerCase()) : undefined) ?? a.followState;
// Wide screens: the rail lists every app with the one in use marked; tapping another one switches to
// its feed, tapping the one in use goes back to the first video (like Home). The section buttons act
// through the bottom bar's handlers (the bottom bar is hidden there).
for (const p of PLATFORMS) {
  const inUse = p.id === P.id;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = inUse ? 'rail-app active' : 'rail-app';
  b.title = inUse ? `${p.name} (in use): back to the first video` : `Switch to ${p.name}`;
  b.setAttribute('aria-label', inUse ? `${p.name}, in use` : `Switch to ${p.name}`);
  if (inUse) b.setAttribute('aria-current', 'page');
  b.style.setProperty('--app-accent', p.accent);
  const tile = document.createElement('span');
  tile.className = 'rail-tile';
  tile.style.background = p.tile;
  tile.innerHTML = p.icon;
  const name = document.createElement('span');
  name.className = 'rail-name';
  name.textContent = p.short;
  b.append(tile, name);
  if (inUse) b.addEventListener('click', () => el.navHome.click());
  else onTap(b, () => switchApp(p));
  el.railApps.appendChild(b);
}
onHomeTap(el.railLauncher);
el.railFriends.addEventListener('click', () => el.navFriends.click());
el.railInbox.addEventListener('click', () => el.navInbox.click());
el.railProfile.addEventListener('click', () => el.navProfile.click());
el.upnextAuto.addEventListener('click', () => toggleAutoscroll());
initSocial({
  play: playList,
  toast,
  isLoggedIn: () => state.session?.state === 'logged_in',
  openSessionPanel,
  fmtCount,
  platform: P,
  onPanelsChange: syncOverlayPause,
  onFollowState: (user, s) => {
    rememberFollowState(user, s);
    syncFollow(activeEntry());
  },
});
el.navProfile.addEventListener('click', () => pressed(el.navProfile, () => openSessionPanel()));
el.sessionClose.addEventListener('click', () => closeSessionPanel());
el.sessionRefresh.addEventListener('click', () =>
  pressed(
    el.sessionRefresh,
    async () => {
      sessionPollFailures = 0;
      await refreshSession(true, true);
      // A sign-in or profile check still running on the server is followed again from here.
      if (state.session?.state === 'login_pending' || state.session?.probing) pollSession();
    },
    { label: 'Checking' },
  ),
);
el.sessionLogin.addEventListener('click', () => pressed(el.sessionLogin, () => startLogin('qr'), { label: 'Starting' }));
el.sessionLoginWindow.addEventListener('click', () => pressed(el.sessionLoginWindow, () => startLogin('window'), { label: 'Opening' }));
el.sessionLoginWindow.title = `Opens ${P.name}'s sign-in page in a visible browser window on the machine that runs the server`;
// Cookie sign-in (YouTube, Instagram): the pasted text (or the chosen file's text) goes to the server, which checks it with the site.
el.sessionCookiesLabel.textContent = `Cookies of a browser that is signed in to ${P.name}`;
el.sessionCookiesHelp.innerHTML = `<ol>
  <li>On a computer, open a <b>private / incognito window</b> and sign in at <b>${esc(P.cookieSite)}</b>.</li>
  <li>Export the cookies with a cookie export extension (for example “Get cookies.txt LOCALLY” for Chrome/Edge, “cookies.txt” for Firefox) while on ${esc(P.cookieSite)}, as a <b>cookies.txt</b> file.</li>
  <li><b>Close the private window</b> (so the browser does not rotate the cookies behind this server's back), then paste the file's text here or choose the file.</li>
</ol>
<p>The server keeps the ${esc(P.cookieSite)} cookies in a private file and uses them for your feed; nothing else is read. "Sign out" deletes the file. ${esc(P.name)} may sign the server out after a while – then paste a fresh export.</p>`;
el.sessionCookies.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.sessionCookiesText.value.trim();
  if (!text) {
    showCookiesResult('err', 'Paste the cookies first, or choose the cookies.txt file.');
    el.sessionCookiesText.focus();
    return;
  }
  pressed(el.sessionCookiesSend, () => startLogin('cookies', text), { label: `Checking with ${P.name}` });
});
el.sessionCookiesPick.addEventListener('click', () => el.sessionCookiesFile.click());
el.sessionCookiesFile.addEventListener('change', () => {
  const f = el.sessionCookiesFile.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    el.sessionCookiesText.value = String(reader.result || '');
    el.sessionCookiesFile.value = '';
    if (el.sessionCookiesText.value.trim()) el.sessionCookies.requestSubmit();
    else showCookiesResult('err', `${f.name} is empty`);
  };
  reader.onerror = () => showCookiesResult('err', `Could not read ${f.name}`);
  reader.readAsText(f);
});
function showCookiesResult(kind: 'ok' | 'err' | 'wait', text: string): void {
  el.sessionCookiesResult.textContent = text;
  el.sessionCookiesResult.className = `session-code-result ${kind}`;
}
el.sessionLogout.addEventListener('click', () => pressed(el.sessionLogout, () => signOut(), { label: 'Signing out' }));
el.sessionCancel.addEventListener('click', () => pressed(el.sessionCancel, () => cancelLogin(), { label: 'Cancelling' }));
el.sessionRestart.addEventListener('click', () =>
  pressed(
    el.sessionRestart,
    async () => {
      await cancelLogin(true);
      await startLogin('qr');
    },
    { label: 'Restarting' },
  ),
);
let manualOpen = false;
el.sessionManualToggle.addEventListener('click', () => {
  manualOpen = !manualOpen;
  renderSession();
});
// Live view (TikTok verification on the server's page): clicks and drags on the picture, typing below it.
let liveDown: { x: number; y: number; id: number } | undefined;
el.sessionQrImg.addEventListener('pointerdown', (e) => {
  if (!el.sessionQrImg.classList.contains('live')) return;
  e.preventDefault();
  liveDown = { ...livePoint(e), id: e.pointerId };
  el.sessionQrImg.setPointerCapture(e.pointerId);
});
el.sessionQrImg.addEventListener('pointerup', (e) => {
  if (!liveDown || liveDown.id !== e.pointerId) return;
  const from = liveDown;
  liveDown = undefined;
  const to = livePoint(e);
  const moved = Math.hypot(to.x - from.x, to.y - from.y) > 6;
  void sendLiveInput(moved ? { type: 'drag', x: from.x, y: from.y, x2: to.x, y2: to.y } : { type: 'click', x: to.x, y: to.y });
});
el.sessionQrImg.addEventListener('pointercancel', () => (liveDown = undefined));
el.sessionInputType.addEventListener('click', () => {
  const text = el.sessionInputText.value;
  if (!text) return;
  el.sessionInputText.value = '';
  pressed(el.sessionInputType, () => sendLiveInput({ type: 'type', text }), { label: 'Typing' });
});
el.sessionInputText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = el.sessionInputText.value;
    el.sessionInputText.value = '';
    void (text ? sendLiveInput({ type: 'type', text }).then(() => sendLiveInput({ type: 'key', key: 'Enter' })) : sendLiveInput({ type: 'key', key: 'Enter' }));
  }
});
el.sessionInputEnter.addEventListener('click', () => pressed(el.sessionInputEnter, () => sendLiveInput({ type: 'key', key: 'Enter' }), { label: 'Pressing' }));
/** A code was sent from this page and the server has not answered with a newer result yet */
let codePending = false;
/** `verifyResult.at` the server reported before the last code was sent (anything newer is its answer) */
let resultSeenAt = 0;
function sendVerifyCode(): void {
  const code = el.sessionCodeText.value.replace(/\D+/g, '');
  el.sessionCodeText.value = code;
  if (code.length < 4) {
    showCodeResult('err', code ? 'The code is too short – it has 6 digits.' : 'Type the code from the e-mail first.');
    el.sessionCodeText.focus();
    return;
  }
  resultSeenAt = state.session?.verifyResult?.at || 0;
  codePending = true;
  showCodeResult('wait', 'Checking the code with TikTok…');
  pressed(
    el.sessionCodeSend,
    async () => {
      el.sessionCodeText.blur(); // closes the on-screen keyboard so the answer is visible
      if (!(await sendLiveInput({ type: 'code', code }))) {
        // The request never reached the server (connection, restart): nothing is being checked.
        codePending = false;
        showCodeResult('err', 'The code did not reach the server – check the connection and press Verify again.');
      }
    },
    { label: 'Verifying' },
  );
}
// Submit = the Verify button, Enter/Go on any keyboard (the form handles both); keydown is the backstop
// for keyboards that send Enter without submitting.
el.sessionCode.addEventListener('submit', (e) => {
  e.preventDefault();
  sendVerifyCode();
});
el.sessionCodeText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendVerifyCode();
  }
});
el.sessionCodeText.addEventListener('input', () => {
  const digits = el.sessionCodeText.value.replace(/\D+/g, '');
  if (digits !== el.sessionCodeText.value) el.sessionCodeText.value = digits;
  if (el.sessionCodeResult.classList.contains('err')) el.sessionCodeResult.classList.add('hidden');
});
el.sessionCodeResend.addEventListener('click', () =>
  pressed(
    el.sessionCodeResend,
    async () => {
      await sendLiveInput({ type: 'resend' });
      el.sessionCodeText.value = '';
      showCodeResult('', 'A new code was requested – use the newest e-mail (older codes stop working).');
      el.sessionCodeText.focus();
    },
    { label: 'Sending' },
  ),
);
function showCodeResult(kind: '' | 'ok' | 'err' | 'wait', text: string): void {
  el.sessionCodeResult.className = 'session-code-result' + (kind ? ' ' + kind : '');
  el.sessionCodeResult.textContent = text;
}
// On-screen keyboards (Tesla, phones) cover the lower part of the page. Keep the code box above them:
// pad the panel by the keyboard height (visualViewport shrinks) and scroll the box into view on focus.
function keepCodeBoxVisible(): void {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  el.session.style.setProperty('--kb', `${Math.round(kb)}px`);
  if (document.activeElement === el.sessionCodeText && !el.sessionCode.classList.contains('hidden')) el.sessionCode.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
el.sessionCodeText.addEventListener('focus', () => {
  el.session.scrollTo({ top: 0 });
  window.setTimeout(keepCodeBoxVisible, 150);
  window.setTimeout(keepCodeBoxVisible, 600);
});
window.visualViewport?.addEventListener('resize', keepCodeBoxVisible);
window.visualViewport?.addEventListener('scroll', keepCodeBoxVisible);
el.sessionInputBack.addEventListener('click', () => pressed(el.sessionInputBack, () => sendLiveInput({ type: 'key', key: 'Backspace' }), { label: 'Deleting' }));

/** Pointer position in page pixels (the picture is the server's viewport, scaled to fit). */
function livePoint(e: PointerEvent): { x: number; y: number } {
  const r = el.sessionQrImg.getBoundingClientRect();
  const size = state.session?.pageShotSize || { w: el.sessionQrImg.naturalWidth || 1, h: el.sessionQrImg.naturalHeight || 1 };
  return { x: Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * size.w), y: Math.round(((e.clientY - r.top) / Math.max(1, r.height)) * size.h) };
}
/** Sends one input to the server's sign-in page; true when the server took it. */
async function sendLiveInput(req: SessionInputRequest): Promise<boolean> {
  el.sessionQrImg.classList.add('busy');
  try {
    state.session = await api.sessionInput(req);
    renderSession();
    return true;
  } catch (e) {
    toast(`Could not reach the sign-in page: ${errMsg(e)}`, true);
    return false;
  } finally {
    el.sessionQrImg.classList.remove('busy');
  }
}
el.startBtn.addEventListener('click', () => start());
el.start.addEventListener('click', (e) => {
  if (e.target === el.start) start();
});

function syncActionButtons(): void {
  el.actMuteIco.innerHTML = prefs.muted ? ICON.muted : ICON.sound;
  el.actAuto.classList.toggle('on', prefs.autoscroll);
  el.actAutoLabel.textContent = prefs.autoscroll ? 'Auto on' : 'Auto off';
  el.upnextAuto.classList.toggle('on', prefs.autoscroll);
  el.upnextAuto.setAttribute('aria-checked', String(prefs.autoscroll));
}
el.actDownloadIco.innerHTML = ICON.save;
syncActionButtons();

function toggleAutoscroll(): void {
  prefs.autoscroll = !prefs.autoscroll;
  savePrefs();
  for (const e of state.entries) if (e.player) e.player.loop = !prefs.autoscroll;
  syncActionButtons();
  toast(prefs.autoscroll ? 'Auto-scroll on: next video plays when this one ends' : 'Auto-scroll off: videos loop');
}

// ---------- playback speed ----------
// 1× on every visit (not remembered); applies to every player on the page, at once, keeping the
// position. The Speed action (or S) opens the choices over a faded screen; a tap outside keeps the
// current one. The WebCodecs path plays the sound faster rather than time-stretching it, so the
// pitch rises with the speed (Web Audio has no pitch-preserving rate).
let speed = 1;
const fmtSpeed = (r: number): string => `${r}×`;
function setSpeed(r: number): void {
  speed = r;
  for (const e of state.entries) e.player?.setRate(r);
  el.actSpeedIco.textContent = fmtSpeed(r);
  el.actSpeed.classList.toggle('on', r !== 1);
  el.actSpeed.title = `Playback speed: ${fmtSpeed(r)} (S)`;
  for (const b of el.speedCard.querySelectorAll<HTMLButtonElement>('.speed-opt')) b.classList.toggle('on', Number(b.dataset.rate) === r);
}
function speedMenuOpen(): boolean {
  return !el.speed.classList.contains('hidden');
}
function openSpeedMenu(): void {
  el.speed.classList.remove('hidden');
  el.speedCard.querySelector<HTMLButtonElement>('.speed-opt.on')?.focus();
}
function closeSpeedMenu(): void {
  el.speed.classList.add('hidden');
  el.feed.focus();
}
el.actSpeed.addEventListener('click', () => (speedMenuOpen() ? closeSpeedMenu() : openSpeedMenu()));
el.speed.addEventListener('click', (e) => {
  if (e.target === el.speed) closeSpeedMenu();
});
for (const b of el.speedCard.querySelectorAll<HTMLButtonElement>('.speed-opt')) {
  b.addEventListener('click', () => {
    const r = Number(b.dataset.rate);
    if (r > 0) {
      setSpeed(r);
      toast(r === 1 ? 'Normal speed' : `Playing at ${fmtSpeed(r)}`);
    }
    closeSpeedMenu();
  });
}

// Full screen: the video takes all the room the window has (no bars, rail, Up next or actions;
// .fullwindow in feed.css / theater.css), with an "Exit full screen" button over it. The browser's
// own fullscreen is asked for as well where it is allowed; where it is refused (the car's browser)
// the page still fills the window. Leaving the browser's fullscreen (its Esc) leaves ours too.
function isFullscreen(): boolean {
  return el.app.classList.contains('fullwindow');
}
function setFullscreen(on: boolean): void {
  if (on === isFullscreen()) return;
  el.app.classList.toggle('fullwindow', on);
  applyLayout(); // the side parts come back (or go) with the window: fitStage
  el.actFull.setAttribute('aria-pressed', String(on));
  const root = document.documentElement;
  if (on) {
    if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().catch(() => undefined);
    toast('Full screen: tap "Exit full screen" (or F / Esc) to leave');
  } else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  layout();
}
function toggleFullscreen(): void {
  setFullscreen(!isFullscreen());
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) setFullscreen(false);
});

function start(): void {
  state.started = true;
  el.start.classList.add('hidden');
  el.feed.focus();
  const cur = activeEntry();
  if (cur) void playEntry(cur);
  syncWait();
}

/**
 * No "Tap to start": the first video plays as soon as it is on screen – a signed-in account's feed,
 * a guest's Explore, a restored one alike. A browser that allows no sound before a touch plays the
 * picture silently; the first tap, swipe or key turns the sound on (see the gesture listeners
 * below). Only a panel over the feed holds it back: on a sign-in-only platform without an account
 * that is the sign-in panel. Returns true when it started the feed.
 */
const HINT_KEY = 'sa_feed_hint_shown';
function maybeAutoStart(): boolean {
  if (state.started || !activeEntry() || overlayOpen()) return false;
  start();
  window.setTimeout(() => {
    const p = activeEntry()?.player;
    if (p?.audioBlocked && !prefs.muted) toast('Sound starts after your first tap or swipe (a browser rule)', false, 5000);
  }, 2500);
  // The gestures, once per device (they used to sit under the start button)
  try {
    if (!localStorage.getItem(HINT_KEY)) {
      localStorage.setItem(HINT_KEY, '1');
      window.setTimeout(() => toast('Swipe up/down for the next video · tap to pause · swipe right to go back · F for full screen', false, 7000), 6000);
    }
  } catch {
    /* storage unavailable */
  }
  return true;
}
// The first touch or key after an automatic start lets a sound that the browser held back begin.
function onUserGesture(): void {
  for (const e of state.entries) e.player?.userGesture();
}
document.addEventListener('pointerdown', onUserGesture, true);
document.addEventListener('keydown', onUserGesture, true);

// ---------- session ----------
function renderSession(): void {
  const s = state.session;
  if (!s) {
    el.sessionText.textContent = 'Checking the server…';
    return;
  }
  const lines: string[] = [];
  const cookieSignIn = P.signIn === 'cookies';
  if (!s.supported && cookieSignIn) {
    lines.push(`<b>${esc(P.name)} sign-in is not available on this server.</b>`);
    lines.push(esc(s.error || s.message || ''));
    lines.push(`${esc(P.tabs.explore)} and search need the same thing, so they are unavailable here as well.`);
  } else if (!s.supported) {
    lines.push('<b>Sign-in is not available on this server.</b>');
    lines.push(s.error || '');
    lines.push('For You needs the Node server (npm run dev / npm start) on a machine with Chrome or Edge. The Explore feed works everywhere.');
  } else if (s.state === 'logged_in' && cookieSignIn) {
    lines.push(`<b>Signed in as @${esc(s.username || '?')}</b>${s.nickname && s.nickname !== s.username ? ` (${esc(s.nickname)})` : ''}`);
    lines.push(`Your ${esc(P.tabs.foryou)} feed is ${esc(P.name)}'s own recommendations for this account. Sign out deletes the saved cookies on the server.`);
    if (s.notice) lines.push(`<span style="color:var(--muted)">${esc(s.notice)}</span>`);
  } else if (s.state === 'logged_in') {
    lines.push(`<b>Signed in as @${esc(s.username || '?')}</b>${s.nickname && s.nickname !== s.username ? ` (${esc(s.nickname)})` : ''}`);
    lines.push('The For You feed comes from this account. Sign out closes the browser session and deletes the saved profile on the server.');
  } else if (s.state === 'login_pending' && s.loginMode === 'qr' && s.qrState === 'verify' && s.verifyStep === 'code') {
    lines.push('<b>Almost there – enter the code TikTok e-mailed you.</b>');
    lines.push(esc(s.message || ''));
  } else if (s.state === 'login_pending' && s.loginMode === 'qr') {
    lines.push('<b>Scan to sign in.</b>');
    lines.push('In the TikTok app: Profile → ☰ menu → My QR code → scan icon (or point the in-app camera at this code), then confirm. The code refreshes by itself; this page updates automatically.');
    if (!s.qr && /did not show/i.test(s.message || '')) lines.push(`<span style="color:var(--muted)">${esc(s.message || '')}</span>`);
  } else if (s.state === 'login_pending') {
    lines.push('<b>Waiting for sign-in…</b>');
    lines.push(`A ${esc(P.signInWindowOwner)} sign-in window opened on the machine running the server. Sign in there (any method). This page updates automatically.`);
  } else if (s.probing) {
    lines.push('<b>Checking the saved sign-in…</b>');
    lines.push(esc(s.message || ''));
  } else if (cookieSignIn) {
    lines.push('<b>Not signed in.</b>');
    lines.push(`${esc(P.signInHint)} StreamAnywhere never sees your password.`);
    if (s.error) lines.push(`<span style="color:var(--err)">${esc(s.error)}</span>`);
  } else {
    lines.push('<b>Not signed in.</b>');
    lines.push(`${esc(P.signInHint)} The session then lives in a private ${esc(s.browser || 'browser')} profile on the server. StreamAnywhere never sees your password.`);
    if (s.error) lines.push(`<span style="color:var(--err)">${esc(s.error)}</span>`);
  }
  el.sessionText.innerHTML = lines.filter(Boolean).join('\n');
  const showQr = s.state === 'login_pending' && s.loginMode === 'qr';
  el.sessionQr.classList.toggle('hidden', !showQr);
  if (showQr) {
    el.sessionNotice.textContent = s.notice || '';
    el.sessionNotice.classList.toggle('hidden', !s.notice);
    const live = s.qrState === 'verify' && Boolean(s.pageShot);
    const img = (live ? s.pageShot : s.qr || s.pageShot) || '';
    if (img && el.sessionQrImg.src !== img) el.sessionQrImg.src = img;
    el.sessionQrImg.classList.toggle('page-shot', live || (!s.qr && Boolean(s.pageShot)));
    const codeStep = s.qrState === 'verify' && s.verifyStep === 'code';
    // Code step = locked: the picture is not clickable, manual controls are gone; only the code box
    // (and Cancel) remain, so nothing can be pressed by accident while the e-mail is fetched.
    el.sessionQrImg.classList.toggle('live', live && !codeStep);
    el.sessionManualToggle.classList.toggle('hidden', !live || codeStep);
    el.sessionManualToggle.textContent = manualOpen ? 'Hide manual controls' : 'Having trouble? Show manual controls';
    el.sessionInput.classList.toggle('hidden', !(live && manualOpen && !codeStep));
    if (!live || codeStep) manualOpen = false;
    const codeWasHidden = el.sessionCode.classList.contains('hidden');
    el.sessionCode.classList.toggle('hidden', !codeStep);
    if (codeStep) renderCodeStep(s);
    if (codeStep && codeWasHidden) {
      toast(`TikTok e-mailed you a verification code – enter it here`, false, 6000);
      el.session.scrollTo({ top: 0 });
      if (!s.verifyResult || s.verifyResult.state === 'rejected') el.sessionCodeText.focus();
    }
    if (!img) el.sessionQrImg.removeAttribute('src');
    qrExpiresAt = s.qr && !live ? s.qrExpiresAt || 0 : 0;
    renderQrHint(s);
  }
  const idle = s.supported && s.state !== 'logged_in' && s.state !== 'login_pending';
  const locked = showQr && s.qrState === 'verify' && s.verifyStep === 'code';
  el.sessionLogin.classList.toggle('hidden', !idle || cookieSignIn);
  el.sessionLoginWindow.classList.toggle('hidden', !idle);
  el.sessionCookies.classList.toggle('hidden', !(idle && cookieSignIn && !s.probing));
  if (!(idle && cookieSignIn)) el.sessionCookiesResult.classList.add('hidden');
  // "Sign out" only when there is a session to end; while a sign-in is pending the button is "Cancel".
  // In the code step only Cancel remains (Cancel forgets the attempt; "Sign in" then starts from zero).
  el.sessionLogout.classList.toggle('hidden', s.state !== 'logged_in');
  el.sessionCancel.classList.toggle('hidden', s.state !== 'login_pending');
  el.sessionRestart.classList.toggle('hidden', !(s.state === 'login_pending' && s.loginMode === 'qr') || locked);
  el.sessionRefresh.classList.toggle('hidden', locked);
  el.sessionClose.classList.toggle('hidden', locked);
  el.session.querySelector('.session-inner')?.classList.toggle('locked', locked);
  // Remember a pending sign-in across reloads: the panel reopens where the process stands.
  try {
    if (s.state === 'login_pending') localStorage.setItem(SIGNIN_KEY, '1');
    else localStorage.removeItem(SIGNIN_KEY);
  } catch {
    /* storage unavailable */
  }
  el.navProfileLabel.textContent = s.state === 'logged_in' ? `@${(s.username || 'me').slice(0, 12)}` : s.state === 'login_pending' ? 'Signing in…' : 'Profile';
  el.railProfileLabel.textContent = el.navProfileLabel.textContent;
  el.navProfile.classList.toggle('active', s.state === 'logged_in');
  // the follow "+" exists for a signed-in account only
  syncFollow(activeEntry());
}
const SIGNIN_KEY = P.id === 'tiktok' ? 'streamanywhere.feed.signin' : `streamanywhere.feed.${P.id}.signin`;
/** The code step: TikTok's answer to the last code, and how long the server keeps waiting. */
function renderCodeStep(s: SessionStatus): void {
  const r = s.verifyResult;
  if (r && r.at !== resultSeenAt) {
    codePending = false;
    if (r.state === 'checking') showCodeResult('wait', 'Checking the code with TikTok…');
    else if (r.state === 'accepted') showCodeResult('ok', 'Code accepted ✓ – finishing the sign-in…');
    else if (r.state === 'rejected') {
      showCodeResult('err', `TikTok did not accept the code${r.text ? ': ' + r.text : ''}. Check the newest e-mail and try again, or press "Resend code".`);
      if (document.activeElement !== el.sessionCodeText && !el.sessionCodeSend.classList.contains('busy')) el.sessionCodeText.select();
    } else showCodeResult('err', r.text || 'TikTok gave no answer to that code. Try again, or press "Resend code" for a fresh one.');
  } else if (!codePending) {
    el.sessionCodeResult.classList.add('hidden');
  }
  const sentMin = s.codeSentAt ? Math.round((Date.now() - s.codeSentAt) / 60_000) : 0;
  const until = s.verifyUntil ? new Date(s.verifyUntil) : undefined;
  el.sessionCodeMeta.textContent = `${s.codeSentAt ? (sentMin < 1 ? 'Code sent just now' : `Code sent ${sentMin} min ago`) : 'Waiting for the code'}${until ? ` · this page waits until ${until.toLocaleDateString(undefined, { weekday: 'short' })} ${until.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}`;
  el.sessionCodeResend.disabled = el.sessionCodeResend.classList.contains('busy');
}
let qrExpiresAt = 0;
function renderQrHint(s: SessionStatus): void {
  const left = qrExpiresAt ? Math.max(0, Math.round((qrExpiresAt - Date.now()) / 1000)) : 0;
  el.sessionQrHint.textContent =
    s.qrState === 'verify'
      ? s.verifyStep === 'code'
        ? 'The picture is TikTok\'s page on the server (live). Enter the e-mailed code above and press Verify.'
        : s.verifyStep === 'sending'
          ? 'Email verification chosen – waiting for TikTok\'s code field…'
          : 'TikTok asks for a verification – this is the server\'s page, live. Tap or click on it; type below.'
      : s.qrState === 'scanned'
      ? 'Scanned – confirm on your phone, then wait a moment'
      : s.qr
        ? left > 0
          ? `Scan within ${left} s – a new code appears automatically`
          : 'Getting a new code…'
        : s.pageShot
          ? 'No QR code yet – this is what TikTok shows the server; retrying automatically'
          : 'Loading the QR code… (up to a minute)';
}
window.setInterval(() => {
  if (state.session && !el.session.classList.contains('hidden') && !el.sessionQr.classList.contains('hidden')) renderQrHint(state.session);
}, 1000);

/** Consecutive failed status polls; the last known status is kept meanwhile (a blip must not end the live view) */
let sessionPollFailures = 0;
const SESSION_POLL_GIVE_UP = 90; // ~3 minutes of 2 s polls
/** The account the server reported signed in on the last visit: the next visit asks for For You straight away. */
const SIGNED_KEY = `streamanywhere.signedin.${P.id}`;
function lastSignedIn(): boolean {
  try {
    return !!localStorage.getItem(SIGNED_KEY);
  } catch {
    return false;
  }
}
function rememberSignedIn(s: SessionStatus | undefined): void {
  try {
    if (s?.state === 'logged_in') localStorage.setItem(SIGNED_KEY, s.username || '1');
    else if (s && s.supported && s.state !== 'login_pending' && !s.probing) localStorage.removeItem(SIGNED_KEY);
  } catch {
    /* storage unavailable */
  }
}
/** The saved preference was For You but the server was still checking the profile at boot: switch when it says signed in */
let restoreForYou = false;
/** The boot sequence decides the source itself once the session check has settled */
let booting = true;

/** A signed-in account watches its own feed unless the viewer tapped Explore while signed in. */
const wantsForYou = (): boolean => prefs.pick !== 'user' || prefs.source === 'foryou';

async function refreshSession(announce = false, recheck = false): Promise<SessionStatus | undefined> {
  try {
    const prev = state.session?.state;
    const prevProbing = Boolean(state.session?.probing);
    state.session = await api.session(P.id, recheck);
    sessionPollFailures = 0;
    rememberSignedIn(state.session);
    if (state.session.state === 'logged_in') {
      signedOutPanelShown = false;
      maybeAutoStart();
    }
    renderSession();
    if (announce) toast(state.session.message || state.session.state);
    if (state.session.state === 'logged_in' && (prev === 'login_pending' || (restoreForYou && prevProbing))) {
      restoreForYou = false;
      onSignedIn();
    } else if (!booting && state.session.state === 'logged_in' && prev !== 'logged_in' && prefs.source !== 'foryou' && wantsForYou() && state.mode.kind === 'source') {
      // The server reports the account after being unreachable (a restart, a deploy): its feed, as
      // after a sign-in. Explore stays only when the viewer chose it while signed in.
      restoreForYou = false;
      onSignedIn();
    } else if (restoreForYou && !state.session.probing) {
      // The profile check finished without a session: Explore for this visit; the saved preference
      // is kept so the next visit with a signed-in server goes back to the account's feed.
      restoreForYou = false;
      if (P.loginRequired) void openSessionPanel();
      else if (state.session.supported) toast(`Sign in (Profile) to see your ${P.tabs.foryou} feed; showing ${P.tabs.explore} meanwhile.`, false, 5000);
    }
    return state.session;
  } catch (e) {
    const prev = state.session;
    sessionPollFailures++;
    if (prev && prev.supported && (prev.state === 'login_pending' || prev.probing) && sessionPollFailures < SESSION_POLL_GIVE_UP) {
      // The server is still mid-flow (its state lives there, not here): keep what we know, keep polling,
      // and only mention the hiccup. Replacing the status would hide the QR / code box and stop the poll.
      state.session = { ...prev, notice: `Connection problem (${errMsg(e)}) – retrying…` };
      renderSession();
      return prev;
    }
    state.session = { supported: false, state: 'unsupported', error: `Server unreachable: ${errMsg(e)}` };
    renderSession();
    return undefined;
  }
}

async function openSessionPanel(): Promise<void> {
  hideLoading(); // the panel says what is going on from here
  el.session.classList.remove('hidden');
  syncOverlayPause();
  await refreshSession();
  pollSession();
}
function closeSessionPanel(): void {
  el.session.classList.add('hidden');
  syncOverlayPause();
}
function pollSession(): void {
  clearInterval(state.sessionPoll);
  state.sessionPoll = window.setInterval(() => {
    if (state.session?.state === 'login_pending' || state.session?.probing) void refreshSession();
    else clearInterval(state.sessionPoll);
  }, 2000);
}

async function startLogin(mode: LoginMode, cookies?: string): Promise<void> {
  el.sessionLogin.disabled = el.sessionLoginWindow.disabled = true;
  if (mode === 'cookies') showCookiesResult('wait', `Checking the cookies with ${P.name}…`);
  else el.sessionText.innerHTML = mode === 'qr' ? '<b>Starting TikTok on the server…</b>\nThis can take up to a minute the first time (the browser has to start).' : '<b>Opening the sign-in window on the server…</b>';
  try {
    const prev = state.session?.state;
    state.session = await api.sessionLogin(mode, P.id, cookies);
    if (mode === 'cookies') {
      el.sessionCookiesText.value = '';
      el.sessionCookiesResult.classList.add('hidden');
    }
    renderSession();
    // The cookie sign-in finishes in the same request: straight to the account's feed.
    if (state.session.state === 'logged_in' && prev !== 'logged_in') onSignedIn();
    else pollSession();
  } catch (e) {
    if (mode === 'cookies') {
      const body = (e as ApiError)?.body as Partial<SessionStatus> | undefined;
      if (body && typeof body === 'object' && 'state' in body) state.session = { ...(body as SessionStatus), error: undefined };
      renderSession();
      showCookiesResult('err', errMsg(e));
      el.sessionCookiesText.focus();
      // The failed paste may have started a check of the saved file: follow it so the form comes back.
      if (state.session?.probing || state.session?.state === 'login_pending') pollSession();
    } else {
      toast(`Sign-in could not start: ${errMsg(e)}`, true, 6000);
      renderSession();
    }
  } finally {
    el.sessionLogin.disabled = el.sessionLoginWindow.disabled = false;
  }
}

/** A sign-in just completed: close the panel and switch to the account's feed. */
function onSignedIn(): void {
  signedOutPanelShown = false;
  closeSessionPanel();
  // The saved feed restored at boot already is the account's feed: keep playing it.
  const keep = restoredSource !== undefined && (restoredSource === 'foryou' || P.loginRequired) && state.mode.kind === 'source' && state.entries.length > 0;
  restoredSource = undefined;
  if (keep) {
    state.exhausted = false;
    scheduleMoreIfNeeded();
    return;
  }
  toast(`Signed in as @${state.session?.username || '?'} – loading your ${P.tabs.foryou} feed`);
  prefs.source = 'foryou';
  prefs.pick = 'auto';
  savePrefs();
  renderSourceUi();
  void reload();
}

/** Cancels a pending sign-in on the server and forgets it; the next "Sign in" starts from zero. */
async function cancelLogin(quiet = false): Promise<void> {
  el.sessionCancel.disabled = true;
  if (!quiet) el.sessionText.innerHTML = '<b>Cancelling…</b>';
  try {
    localStorage.removeItem(SIGNIN_KEY);
  } catch {
    /* storage unavailable */
  }
  codePending = false;
  resultSeenAt = 0;
  el.sessionCodeText.value = '';
  try {
    state.session = await api.sessionCancel(P.id);
    renderSession();
    if (!quiet) toast('Sign-in cancelled – "Sign in with QR code" starts over');
  } catch (e) {
    toast(`Cancel failed: ${errMsg(e)}`, true);
    renderSession();
  } finally {
    el.sessionCancel.disabled = false;
  }
}

async function signOut(cancelOnly = false): Promise<void> {
  el.sessionLogout.disabled = el.sessionCancel.disabled = true;
  el.sessionText.innerHTML = P.signIn === 'cookies' ? '<b>Signing out…</b>\nDeleting the saved cookies on the server.' : '<b>Signing out…</b>\nClosing the browser session on the server (a few seconds).';
  try {
    state.session = await api.sessionLogout(P.id);
    rememberSignedIn(state.session);
    renderSession();
    if (prefs.source === 'foryou' || P.loginRequired) {
      prefs.source = 'explore';
      prefs.pick = 'auto';
      savePrefs();
      renderSourceUi();
      void reload();
    }
    toast(cancelOnly ? 'Sign-in cancelled' : 'Signed out');
  } catch (e) {
    toast(`${cancelOnly ? 'Cancel' : 'Sign-out'} failed: ${errMsg(e)}`, true);
    renderSession();
  } finally {
    el.sessionLogout.disabled = el.sessionCancel.disabled = false;
  }
}

// ---------- loading indicator: never over a video ----------
// Nothing loaded yet: a card centred on the empty panel. Videos on screen: the last row of the
// Up next list (wide screens) or a small chip under the top bar (phones), while the video plays on.
let loadingTicker = 0;
function sourceLabel(): string {
  if (state.mode.kind === 'search') return `search results for “${state.mode.q}”`;
  if (state.mode.kind === 'profile') return `videos of @${state.mode.user}`;
  if (prefs.source === 'foryou') return `your ${P.tabs.foryou} feed`;
  const cat = P.categories.find((c) => c.id === prefs.category);
  return `${P.tabs.explore}${cat && cat.id !== P.defaultCategory ? ' · ' + cat.label : ''}`;
}
function showLoading(title: string, detail: string, done = false): void {
  const centered = state.entries.length === 0;
  // Wide screens, videos loaded: the status is the last row of the Up next list, off the video.
  if (!centered && el.app.classList.contains('wide')) {
    el.loading.classList.add('hidden');
    el.upnextStatus.classList.remove('hidden');
    el.upnextStatus.classList.toggle('done', done);
    el.upnextStatusTitle.textContent = title;
    el.upnextStatusDetail.textContent = detail;
    return;
  }
  el.upnextStatus.classList.add('hidden');
  // Phones, videos still to watch: nothing over the video. The next batch (or TikTok being slow) is
  // the viewer's business only once they are out of videos; until then they play and scroll.
  if (!centered && !viewerWaiting()) {
    el.loading.classList.add('hidden');
    return;
  }
  // centred on the video panel (on wide screens that is the middle column, not the whole window)
  const f = el.feed.getBoundingClientRect();
  const a = el.app.getBoundingClientRect();
  if (f.width > 0) {
    el.loading.style.setProperty('--feed-cx', `${f.left - a.left + f.width / 2}px`);
    el.loading.style.setProperty('--feed-cy', `${f.top - a.top + f.height / 2}px`);
    el.loading.style.setProperty('--feed-top', `${f.top - a.top}px`);
  }
  el.loading.classList.remove('hidden');
  el.loading.classList.toggle('compact', !centered);
  el.loading.classList.toggle('done', done);
  // "Tap to start" sits in the middle too: the card goes below it, not over it
  el.loading.classList.toggle('below-start', centered && !el.start.classList.contains('hidden'));
  el.loadingTitle.textContent = title;
  el.loadingDetail.textContent = detail;
}
/** The viewer has nothing more to watch until the next batch arrives. */
const viewerWaiting = (): boolean => state.entries.length === 0 || state.wantNext || state.active >= state.entries.length - 1;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Unplayed videos after the one in view. */
const aheadCount = (): number => Math.max(0, state.entries.length - 1 - Math.max(state.active, 0));
/** A batch arrived while watching: say what it brought for a moment. */
function flashAdded(added: number): void {
  clearInterval(loadingTicker);
  const ahead = aheadCount();
  showLoading(`+${plural(added, 'new video')}`, `${state.entries.length} loaded · ${ahead} still to watch`, true);
  const t = window.setTimeout(() => {
    if (loadingTicker === t) hideLoading();
  }, 2500);
  loadingTicker = t;
}
function hideLoading(): void {
  clearInterval(loadingTicker);
  loadingTicker = 0; // a late progress answer must not show the indicator again
  el.loading.classList.add('hidden');
  el.upnextStatus.classList.add('hidden');
}
/** Shows what the page is waiting for, updating the detail line as the wait grows. */
function startLoadingStatus(): void {
  clearInterval(loadingTicker);
  const t0 = Date.now();
  const ticker = window.setInterval(() => render(), 1000);
  loadingTicker = ticker;
  // The server's own account of a slow fill (browser starting, page loading, …), asked every 2 s.
  let serverStep = '';
  let asking = false;
  const askServer = async (): Promise<void> => {
    if (asking || state.mode.kind !== 'source') return;
    asking = true;
    const r = await api.feedProgress(P.id);
    asking = false;
    if (loadingTicker !== ticker) return;
    serverStep = r.text || '';
    render();
  };
  function render(): void {
    const sec = Math.round((Date.now() - t0) / 1000);
    const first = state.entries.length === 0;
    if (sec >= 2 && sec % 2 === 0) void askServer();
    if (!first) {
      // Watching while the next batch comes: how much is loaded, how much is left, what the server is on.
      const ahead = aheadCount();
      const title = state.wantNext || ahead === 0 ? 'Fetching the next video…' : `${state.entries.length} videos loaded · getting more`;
      let step = 'Asking the server for the next batch';
      if (sec >= 4) step = `The server is fetching new videos from ${P.name}`;
      if (sec >= 12) step = `${P.name} is slow to answer, still trying`;
      if (serverStep) step = serverStep.split('\n')[0];
      const left = ahead ? `${ahead} still to watch` : 'none left to watch yet';
      showLoading(title, `${step}${sec >= 3 ? ` · ${sec} s` : ''}\n${left}`);
      return;
    }
    let title = `Loading ${sourceLabel()}…`;
    let detail = 'Asking the server for the next videos';
    if (sec >= 5) detail = `The server is fetching from ${P.name}…`;
    if (sec >= 12) detail = prefs.source === 'foryou' ? `Reading your feed from the signed-in ${P.name} session
(a fresh browser start can take up to a minute)` : `${P.name} is slow to answer; the server is retrying…`;
    if (serverStep) detail = serverStep;
    if (sec >= 40 || serverStep) detail += `
${sec} s so far – still working`;
    if (state.emptyBatches > 0) title = `Still loading ${sourceLabel()}…`;
    showLoading(title, detail);
  }
  render();
  void askServer();
}
function showRetryStatus(delayMs: number): void {
  clearInterval(loadingTicker);
  const until = Date.now() + delayMs;
  const render = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    // Phones: the chip over the video only while the viewer is actually out of videos. The list
    // (wide screens) can always say when the next try is.
    if (!viewerWaiting() && !el.app.classList.contains('wide')) return hideLoading();
    const n = state.entries.length;
    showLoading(
      n ? `${n} videos loaded · no new ones yet` : `${P.name} returned no videos for ${sourceLabel()}`,
      n
        ? `${P.name} limits how fast it hands out videos · next try in ${left} s\n${aheadCount() ? `${aheadCount()} still to watch` : 'none left to watch yet'}`
        : `Retrying in ${left} s… (${P.name} limits how fast it hands out videos)`,
    );
    if (left <= 0) clearInterval(loadingTicker);
  };
  render();
  loadingTicker = window.setInterval(render, 1000);
}

// ---------- resume: each app's feed survives the browser closing ----------
// The car's browser closes the page whenever another app opens. Each app keeps its feed here: the
// video in view (and the one before it), the next ones already loaded, which tab / category, and
// how far into the video the viewer was, so reopening plays on from there while new videos load
// behind it. Forgotten after RESUME_MAX_AGE, or when the viewer picks another tab / category
// (that feed is saved instead). Play URLs older than RESUME_KEEP_URLS are dropped and fetched
// again when the video comes up; younger ones are kept, and re-fetched if they fail.
const RESUME_KEY = `streamanywhere.resume.${P.id}`;
const RESUME_AT_KEY = `${RESUME_KEY}.at`;
const RESUME_MAX_AGE = 7 * 24 * 3600_000;
/** A play URL that does not say when it expires is trusted this long */
const RESUME_KEEP_URLS = 2 * 3600_000;
const RESUME_BEHIND = 1;
const RESUME_AHEAD = 30;
interface Resume {
  v: 1;
  savedAt: number;
  source: FeedSource;
  category: number;
  items: FeedItem[];
  /** The video in view, as an index into items */
  index: number;
}
/** The source a restored feed came from, until the boot sequence has settled (see onSignedIn) */
let restoredSource: FeedSource | undefined;
let resumeTimer = 0;
function clearResume(): void {
  clearTimeout(resumeTimer);
  try {
    localStorage.removeItem(RESUME_KEY);
    localStorage.removeItem(RESUME_AT_KEY);
  } catch {
    /* storage unavailable */
  }
}
/** Saves the feed (debounced unless `now`): only the platform's own feed, not a search / account play list. */
function saveResume(now = false): void {
  clearTimeout(resumeTimer);
  if (!now) {
    resumeTimer = window.setTimeout(() => saveResume(true), 1500);
    return;
  }
  const cur = activeEntry();
  if (state.mode.kind !== 'source' || !cur) return;
  const from = Math.max(0, state.active - RESUME_BEHIND);
  const kept = state.entries.slice(from, state.active + RESUME_AHEAD + 1).filter((e) => e === cur || !e.failed);
  // the diagnostics-only fields are big and useless later
  const items = kept.map((e) => ({ ...e.item, formats: e.item.formats.map(({ cookieBoundUrl: _c, serverProbe: _s, ...f }) => f) }));
  const r: Resume = { v: 1, savedAt: Date.now(), source: prefs.source, category: prefs.category, items, index: kept.indexOf(cur) };
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(r));
  } catch {
    clearResume(); // full: better nothing than half
  }
  saveResumePosition();
}
/** How far into the video in view the viewer is (cheap; written every few seconds while playing). */
function saveResumePosition(): void {
  const cur = activeEntry();
  if (state.mode.kind !== 'source' || !cur?.player || !state.started) return;
  try {
    localStorage.setItem(RESUME_AT_KEY, JSON.stringify({ id: cur.item.id, t: Math.round(cur.player.currentTime * 10) / 10 }));
  } catch {
    /* storage unavailable */
  }
}
function loadResume(): Resume | undefined {
  try {
    const r = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null') as Resume | null;
    if (!r || r.v !== 1 || !Array.isArray(r.items) || !r.items.length || Date.now() - r.savedAt > RESUME_MAX_AGE) return undefined;
    if (r.source !== 'explore' && r.source !== 'foryou') return undefined;
    // Play URLs that have expired (or may have: no expiry known, saved long ago) are dropped; such a
    // video gets fresh ones from its page when it comes up (ensureFormats). The others play at once.
    const now = Date.now();
    const old = now - r.savedAt > RESUME_KEEP_URLS;
    for (const it of r.items) it.formats = it.formats.filter((f) => (f.expiresAt !== undefined ? f.expiresAt * 1000 > now + 60_000 : !old));
    r.index = Math.max(0, Math.min(r.items.length - 1, Number(r.index) || 0));
    return r;
  } catch {
    return undefined;
  }
}
/** Puts the saved feed back on screen, on the video the viewer was watching. */
function restoreFeed(r: Resume): boolean {
  prefs.source = r.source;
  if (P.categories.some((c) => c.id === r.category)) prefs.category = r.category;
  renderSourceUi();
  const added = addItems(r.items);
  if (!added) return false;
  restoredSource = r.source;
  for (const e of state.entries) e.restored = true;
  const id = r.items[r.index]?.id;
  const idx = Math.max(0, state.entries.findIndex((e) => e.item.id === id));
  try {
    const at = JSON.parse(localStorage.getItem(RESUME_AT_KEY) || 'null') as { id?: string; t?: number } | null;
    if (at && at.id === id && Number(at.t) > 0) state.entries[idx].resumeAt = Number(at.t);
  } catch {
    /* no position */
  }
  jumpTo(idx);
  setActive(idx);
  const ahead = state.entries.length - 1 - idx;
  toast(`Picking up where you left off · ${ahead ? `${plural(ahead, 'more video')} ready` : 'loading more'}`, false, 4000);
  return true;
}
window.setInterval(saveResumePosition, 4000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveResume(true));
window.addEventListener('pagehide', () => saveResume(true));

// ---------- feed loading ----------
async function reload(preloaded?: FeedItem[], startIndex = 0): Promise<void> {
  // a new feed (another tab / category, a sign-in, a play list): the saved one no longer applies
  if (!preloaded) clearResume();
  restoredSource = undefined;
  state.generation++;
  clearTimeout(state.retryTimer);
  for (const e of state.entries) releasePlayer(e);
  state.entries = [];
  state.ids = new Set();
  state.active = -1;
  state.exhausted = false;
  state.emptyBatches = 0;
  state.pauseUntil = 0;
  state.wantNext = false;
  el.track.innerHTML = '';
  jumpTo(0);
  renderQueue();
  syncWait();
  if (preloaded?.length) {
    // A play list (search results / an account's videos): show it at once, from the tapped video.
    addItems(preloaded);
    const idx = Math.max(0, Math.min(state.entries.length - 1, startIndex));
    if (!state.started) start();
    jumpTo(idx);
    setActive(idx);
    return;
  }
  await loadMore();
}

/** Appends new videos (duplicates and items without a playable URL are skipped); returns how many. */
/** `stale`: the server's last good batch (see FeedResponse.stale): like a saved video, a failing play URL is replaced from the video's page. */
function addItems(items: FeedItem[], stale = false): number {
  let added = 0;
  for (const item of items) {
    // An item without formats (search results) is kept: its play URLs are resolved when it comes up.
    if (state.ids.has(item.id) || (item.formats.length && !sourceCandidates(item).length)) continue;
    state.ids.add(item.id);
    const entry = makeEntry(item);
    if (stale) entry.restored = true;
    state.entries.push(entry);
    added++;
  }
  if (added) {
    layout(); // the first items give the track its panel height
    renderQueue();
  }
  return added;
}

// ---------- wide screens: the Up next queue ----------
/** Rows of the queue: this many videos before the active one, the active one and this many after it. */
const QUEUE_BEHIND = 12;
const QUEUE_AHEAD = 12;
/** The rows by video id: kept across updates, so the list keeps its scroll position and momentum. */
const queueRows = new Map<string, { row: HTMLElement; now: HTMLElement; wait: HTMLElement; who: HTMLElement; desc: HTMLElement }>();
/** The video whose row was last brought into view. */
let queueShownId = '';
/** When the viewer last scrolled the list; the current row does not pull it back for a while after that. */
let queueScrolledAt = 0;
for (const type of ['wheel', 'touchstart', 'pointerdown'] as const) el.upnextList.addEventListener(type, () => (queueScrolledAt = Date.now()), { passive: true });
function renderQueue(): void {
  const i = state.active;
  const from = Math.max(0, i - QUEUE_BEHIND);
  const to = Math.min(state.entries.length, Math.max(i, 0) + QUEUE_AHEAD + 1);
  const keep = new Set<string>();
  const list = el.upnextList;
  let pos = 0;
  for (let k = from; k < to; k++) {
    const entry = state.entries[k];
    const item = entry.item;
    keep.add(item.id);
    let q = queueRows.get(item.id);
    if (!q) {
      const row = document.createElement('button');
      row.type = 'button';
      const thumb = document.createElement(item.cover ? 'img' : 'span');
      thumb.className = 'q-thumb';
      if (thumb instanceof HTMLImageElement) {
        thumb.src = item.cover!;
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.decoding = 'async';
        thumb.draggable = false;
      }
      const text = document.createElement('span');
      text.className = 'q-text';
      const now = document.createElement('span');
      now.className = 'q-now';
      now.textContent = 'NOW PLAYING';
      // what the video in view is waiting for (renderWait), under NOW PLAYING instead of over the video
      const wait = document.createElement('span');
      wait.className = 'q-wait hidden';
      const who = document.createElement('span');
      who.className = 'q-author';
      const desc = document.createElement('span');
      desc.className = 'q-desc';
      text.append(now, wait, who, desc);
      row.append(thumb, text);
      row.addEventListener('click', () => {
        if (!state.started) start();
        const at = state.entries.indexOf(entry);
        if (at >= 0 && at !== state.active) goTo(at);
      });
      q = { row, now, wait, who, desc };
      queueRows.set(item.id, q);
    }
    // the parts that change: the state (now / watched / next) and the name once the video is resolved
    q.row.className = k === i ? 'q-row current' : k < i ? 'q-row past' : 'q-row';
    if (k === i) q.row.setAttribute('aria-current', 'true');
    else q.row.removeAttribute('aria-current');
    // A thin listing (YouTube's hashtag pages) names the channel only once the video is resolved
    const name = item.author.uniqueId || item.author.nickname;
    const author = name ? `@${name}` : '';
    q.row.title = k === i ? `Playing ${author || 'this video'}` : `Play ${author || 'this video'}`;
    q.now.hidden = k !== i;
    if (k !== i) q.wait.classList.add('hidden');
    q.who.textContent = author;
    q.desc.textContent = item.desc || (k < i ? 'Watched' : '');
    // into place without emptying the list (an empty list would lose its scroll position)
    if (list.children[pos] !== q.row) list.insertBefore(q.row, list.children[pos] ?? null);
    pos++;
  }
  // rows no longer in the window go; the status row (loading more…) stays the last child
  while (list.children.length > pos + 1) list.children[pos].remove();
  if (list.lastElementChild !== el.upnextStatus) list.append(el.upnextStatus);
  for (const id of [...queueRows.keys()]) if (!keep.has(id)) queueRows.delete(id);
  // The current row comes into view when the video changes, unless the viewer is browsing the list.
  const curId = state.entries[i]?.item.id ?? '';
  if (curId !== queueShownId) {
    queueShownId = curId;
    const cur = queueRows.get(curId)?.row;
    if (cur && Date.now() - queueScrolledAt > 2500) {
      const top = cur.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 8;
      list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }
}

/** The next batch for the current mode: the source, or the continuation of a play list. */
async function fetchBatch(): Promise<{ items: FeedItem[]; warnings: string[]; hasMore: boolean; stale?: boolean }> {
  const mode = state.mode;
  if (mode.kind === 'search') {
    if (!mode.hasMore) return { items: [], warnings: [], hasMore: false };
    const r = await api.search({ platform: P.id, q: mode.q, offset: mode.offset });
    mode.offset = r.offset;
    mode.hasMore = r.hasMore;
    return { items: r.items, warnings: r.warnings, hasMore: r.hasMore };
  }
  if (mode.kind === 'profile') {
    if (!mode.hasMore) return { items: [], warnings: [], hasMore: false };
    const r = await api.profile({ platform: P.id, user: mode.user, offset: mode.offset, count: BATCH });
    mode.offset = r.offset + r.items.length;
    mode.hasMore = r.hasMore;
    return { items: r.items, warnings: r.warnings, hasMore: r.hasMore };
  }
  // Nothing on screen: the server may answer with earlier videos rather than make the viewer wait.
  // With videos on screen (a saved feed, an earlier batch) it must not: those are the same videos.
  const r = await api.feed({ platform: P.id, source: prefs.source, category: prefs.source === 'explore' ? prefs.category : undefined, count: BATCH, quick: state.entries.length === 0 });
  return { items: r.items, warnings: r.warnings, hasMore: r.hasMore, stale: r.stale };
}

/** The sign-in panel was opened because the For You feed reported a missing session (once per sign-out) */
let signedOutPanelShown = false;

/** Videos per request: the server answers from its stock, and a bigger batch costs TikTok the same call. */
const BATCH = 30;
/** Keep at least this many unplayed videos ahead of the viewer… */
const AHEAD = 8;
/**
 * …and more as the list grows: the next batch is asked for once the viewer is 75 % of the way
 * through the loaded videos, so it is there long before the last one. At most a batch's worth
 * ahead, so one batch at a time.
 */
const AHEAD_FRACTION = 0.25;
const aheadWanted = (): number => Math.min(BATCH, Math.max(AHEAD, Math.ceil(state.entries.length * AHEAD_FRACTION)));

/** Fetches the next batch; returns how many videos were added. */
async function loadMore(): Promise<number> {
  if (state.loading || state.exhausted) return 0;
  state.loading = true;
  const gen = state.generation;
  startLoadingStatus();
  let added = 0;
  let before = 0;
  try {
    const r = await fetchBatch();
    if (gen !== state.generation) return 0;
    before = state.entries.length;
    added = addItems(r.items, r.stale);
    for (const w of r.warnings) console.warn('[feed]', w);
    if (r.stale && added && !before) toast('Recent videos first – fresh ones are on their way', false, 4000);
    if (!added) {
      state.emptyBatches++;
      if (!r.hasMore) {
        // A play list has an end (unlike the sources): stop asking, tell the viewer once.
        state.exhausted = true;
        if (state.mode.kind !== 'source' && state.entries.length) toast('That was the last video of this list', false, 4000);
      }
    } else state.emptyBatches = state.pauseUntil = 0;
    if (!state.entries.length && state.emptyBatches >= 3) showEmpty(r.warnings[0] || 'The feed returned no playable videos. Try again or pick another category.');
    if (state.active < 0 && state.entries.length) setActive(0);
  } catch (e) {
    if (gen !== state.generation) return 0;
    state.emptyBatches++;
    const msg = errMsg(e);
    const body = e instanceof ApiError ? (e.body as { code?: unknown } | undefined) : undefined;
    const code = typeof body?.code === 'string' ? body.code : '';
    // The server is still checking the saved sign-in (a browser start on the small VM can take a
    // minute): not a sign-out – keep asking, and say so once instead of an error.
    const pending = code === 'tiktok_session_pending';
    // A sign-out by the server's code; by the message only for a server without codes (an old build)
    const signedOut = code ? /_not_signed_in$/.test(code) : /not signed in|session|sign in|needs a sign-in/i.test(msg) && !/could not be checked|still being checked|retrying shortly/i.test(msg);
    console.warn('[feed] batch failed:', msg);
    reportProblem('feed batch', `${sourceLabel()}: ${msg}`);
    // A 429 means the platform is limiting the server: asking every few seconds only lengthens that.
    if (e instanceof ApiError && e.status === 429) state.pauseUntil = Date.now() + LIMITED_PAUSE_MS;
    if (pending) {
      if (state.emptyBatches === 1) toast(`Checking your saved ${P.name} sign-in on the server…`, false, 4000);
    } else if (state.emptyBatches === 1 || state.emptyBatches % 4 === 0) toast(`Feed: ${msg} – ${state.pauseUntil > Date.now() ? `next try in ${Math.round((state.pauseUntil - Date.now()) / 1000)} s` : 'retrying'}`, true, 5000);
    if (!state.entries.length && state.emptyBatches >= 3 && !pending) showEmpty(`Feed failed: ${msg}`);
    if (!pending && (prefs.source === 'foryou' || P.loginRequired) && signedOut) {
      // The TikTok session is gone: retrying every 20 s would only reopen this panel again and again.
      // Stop the loop (signing in or switching the source calls reload(), which starts it afresh).
      state.exhausted = true;
      if (!signedOutPanelShown) {
        signedOutPanelShown = true;
        void openSessionPanel();
      }
    }
  } finally {
    state.loading = false;
    hideLoading();
  }
  if (added && state.wantNext) {
    state.wantNext = false;
    goTo(state.active + 1);
  }
  if (added && before) flashAdded(added);
  if (added) saveResume();
  scheduleMoreIfNeeded();
  return added;
}

/**
 * Like the app, the feed never ends: whenever fewer than aheadWanted() unplayed videos are left
 * after the current one, the next batch is requested. When the previous batch brought nothing
 * (TikTok's soft limits, duplicates), retry with a growing delay.
 */
function scheduleMoreIfNeeded(): void {
  clearTimeout(state.retryTimer);
  if (state.exhausted || state.loading) return;
  const ahead = state.entries.length - 1 - state.active;
  if (ahead >= aheadWanted()) return;
  const delay = Math.max(state.emptyBatches === 0 ? 0 : Math.min(20_000, 3000 * 2 ** (state.emptyBatches - 1)), state.pauseUntil - Date.now());
  if (delay) showRetryStatus(delay);
  state.retryTimer = window.setTimeout(() => void loadMore(), delay);
}

function showEmpty(text: string): void {
  if (el.feed.querySelector('.empty-state')) return;
  const d = document.createElement('div');
  d.className = 'item empty-state';
  d.textContent = text;
  el.track.appendChild(d);
  layout();
}

// ---------- entries ----------
function makeEntry(item: FeedItem): Entry {
  const root = document.createElement('article');
  root.className = 'item';
  root.dataset.id = item.id;
  const label = item.desc || `video by @${item.author.uniqueId || '?'}`;
  // Poster: shown until the player paints its first frame (the canvas is hidden until then).
  if (item.cover) {
    const cover = document.createElement('img');
    cover.className = 'cover';
    cover.src = item.cover;
    cover.alt = '';
    cover.decoding = 'async';
    cover.loading = 'lazy'; // a batch of 30 covers is not downloaded at once
    cover.draggable = false;
    root.appendChild(cover);
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'frame';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);
  root.appendChild(canvas);

  const badge = document.createElement('div');
  badge.className = 'pause-badge';
  badge.textContent = '▶';
  root.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'info';
  const author = document.createElement('div');
  author.className = 'author';
  const a = document.createElement('a');
  a.href = item.canonicalUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `@${item.author.uniqueId || item.author.nickname || '?'}`;
  if (item.author.uniqueId) {
    a.title = 'Open this account';
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      void openProfile(item.author.uniqueId!);
    });
  }
  author.appendChild(a);
  info.appendChild(author);
  if (item.desc) {
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = item.desc;
    info.appendChild(desc);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  // likes and comments are in the action column (syncStats); the caption keeps the music and the plays
  meta.textContent = [item.music ? `♫ ${item.music}` : '', item.stats.plays !== undefined ? `${fmtCount(item.stats.plays)} plays` : ''].filter(Boolean).join(' · ');
  info.appendChild(meta);
  root.appendChild(info);

  // Progress bar: click or drag anywhere on it to seek (touch too; it never scrolls the feed).
  // A canvas seek resets the decoders, so while dragging the bar only follows the pointer and
  // the player is seeked at most every SEEK_THROTTLE_MS plus once more on release.
  const progress = document.createElement('div');
  progress.className = 'progress';
  const downloaded = document.createElement('b');
  const bar = document.createElement('i');
  progress.append(downloaded, bar);
  root.appendChild(progress);
  let seeking = false;
  let lastSeekAt = 0;
  const SEEK_THROTTLE_MS = 400;
  const seekTo = (clientX: number, force: boolean) => {
    const r = progress.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    bar.style.width = `${ratio * 100}%`;
    const p = entry.player;
    if (!p || !(p.duration > 0)) return;
    if (!force && Date.now() - lastSeekAt < SEEK_THROTTLE_MS) return;
    lastSeekAt = Date.now();
    p.seek(ratio * p.duration);
  };
  progress.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    seeking = true;
    root.classList.add('seeking');
    progress.setPointerCapture(e.pointerId);
    suppressClickUntil = Date.now() + 600;
    seekTo(e.clientX, true);
  });
  progress.addEventListener('pointermove', (e) => {
    if (!seeking) return;
    e.stopPropagation();
    seekTo(e.clientX, false);
  });
  const endSeek = (e: PointerEvent) => {
    if (!seeking) return;
    seeking = false;
    root.classList.remove('seeking');
    seekTo(e.clientX, true);
    suppressClickUntil = Date.now() + 400;
    if (activeEntry() === entry && !state.userPaused && entry.player?.paused) void playEntry(entry);
  };
  progress.addEventListener('pointerup', endSeek);
  progress.addEventListener('pointercancel', endSeek);
  // keep the feed's own drag/click handlers out of it
  for (const type of ['mousedown', 'touchstart', 'click'] as const) progress.addEventListener(type, (e) => e.stopPropagation(), { passive: type === 'touchstart' });

  const err = document.createElement('div');
  err.className = 'err hidden';
  root.appendChild(err);

  // What this video is waiting for, while it is the one in view (syncWait)
  const waitEl = document.createElement('div');
  waitEl.className = 'wait hidden';
  waitEl.setAttribute('role', 'status');
  const waitSpin = document.createElement('span');
  waitSpin.className = 'spinner';
  waitSpin.setAttribute('aria-hidden', 'true');
  const waitText = document.createElement('span');
  waitEl.append(waitSpin, waitText);
  root.appendChild(waitEl);

  const entry: Entry = { item, root, canvas, progress: bar, downloaded, err, triedProxy: false, failed: false, isSeeking: () => seeking, waitEl, waitText, buffering: false, retrying: false, loadGen: 0, stored: { video: 0, audio: 0 } };

  // Tap/click on the picture (poster or canvas) = pause/resume; on the edge of the previous / next
  // video showing above / below (wide screens) = go there. The info block and progress bar handle
  // their own pointer events.
  for (const target of [canvas, root.querySelector<HTMLImageElement>('.cover')]) {
    target?.addEventListener('click', () => {
      if (suppressClickUntil > Date.now()) return; // the click that ends a drag
      if (activeEntry() !== entry) {
        if (!state.started) start();
        goTo(state.entries.indexOf(entry));
        return;
      }
      togglePause(entry);
    });
  }

  el.track.appendChild(root);
  return entry;
}

/** Creates the entry's canvas player (idempotent). */
function ensurePlayer(entry: Entry): FeedPlayer {
  if (entry.player) return entry.player;
  const player = new FeedPlayer(entry.canvas, entry.root, {
    onFirstFrame: () => {
      entry.root.classList.add('has-frame');
      entry.retrying = false;
      if (activeEntry() === entry) {
        syncWait();
        warmNeighbours();
      }
    },
    onWaiting: (w) => {
      entry.buffering = w;
      if (activeEntry() === entry) syncWait();
    },
    onEnded: () => {
      if (activeEntry() !== entry) return;
      if (prefs.autoscroll) goTo(state.active + 1);
    },
    onError: (e) => onPlayerError(entry, e),
    onPlayingChange: (playing) => {
      if (playing) entry.root.classList.remove('paused');
      else if (activeEntry() === entry && state.userPaused) entry.root.classList.add('paused');
    },
    onTime: (t, d) => {
      if (!entry.isSeeking()) entry.progress.style.width = `${(100 * t) / d}%`;
      const dl = player.download();
      if (dl.fraction >= 0) entry.downloaded.style.width = `${Math.round(dl.fraction * 1000) / 10}%`;
      // the whole file is here: into the media cache now (a page closed later cannot lose it)
      if (dl.fraction >= 1 && dl.total > 0 && entry.stored.video < dl.total) storeRecording(entry);
      // Reopened page: back to where the viewer was in this video (once, when it is playing)
      if (entry.resumeAt !== undefined && !player.paused) {
        const at = entry.resumeAt;
        entry.resumeAt = undefined;
        if (at > t + 1 && at < d - 2) player.seek(at);
      }
    },
  });
  player.loop = !prefs.autoscroll;
  player.setMuted(prefs.muted);
  player.setRate(speed);
  entry.player = player;
  if (!playerModeAnnounced) {
    playerModeAnnounced = true;
    console.info(`[feed] canvas player: ${player.rendererName}${playerMode.reason ? ` (${playerMode.reason})` : ''}`);
    if (playerMode.mode !== 'webcodecs') toast(`WebCodecs unavailable (${playerMode.reason}); frames are copied from a hidden video into the canvas.`, false, 6000);
  }
  return player;
}

/** Drops the entry's player (decoders, audio context, network) and shows the poster again. */
function releasePlayer(entry: Entry): void {
  if (!entry.player) return;
  storeRecording(entry);
  entry.player.destroy();
  entry.player = undefined;
  entry.src = undefined;
  entry.root.classList.remove('has-frame', 'paused');
  entry.progress.style.width = '0%';
  entry.downloaded.style.width = '0%';
  entry.buffering = false;
}

function attachSource(entry: Entry, which: 'direct' | 'proxy' | 'auto' = 'auto'): boolean {
  const cands = sourceCandidates(entry.item);
  const pick = which === 'auto' ? cands[0] : cands.find((c) => c.kind === which);
  if (!pick) return false;
  if (entry.player && entry.src?.url === pick.url) return true;
  entry.src = pick;
  entry.root.classList.remove('has-frame');
  const p = ensurePlayer(entry);
  entry.stored = { video: 0, audio: 0 };
  const gen = ++entry.loadGen;
  const label = `${P.name} ${entry.item.id} (${pick.kind})`;
  const load = (prefix?: MediaPrefix, audioPrefix?: MediaPrefix) => {
    if (entry.player !== p || entry.src !== pick || entry.loadGen !== gen) return;
    if (prefix) console.debug(`[feed] ${entry.item.id}: ${prefix.complete ? 'whole file' : `first ${fmtBytes(prefix.blob.size)}`} from the media cache`);
    void p.load(pick.url, pick.kind, label, { audioUrl: pick.audioUrl, durationHint: entry.item.duration, prefix, audioPrefix });
  };
  // What the media cache has of this video goes first (a few ms to look up); on any trouble, the network.
  Promise.all([cachedPrefix(entry, 'video', pick.url), pick.audioUrl ? cachedPrefix(entry, 'audio', pick.audioUrl) : undefined]).then(([v, a]) => load(v, a), () => load());
  return true;
}

// ---------- media cache: the bytes of the videos seen, so they start from disk next time ----------
/** The cached head (or whole) of the file, usable with `url`: a head only from the same URL. */
async function cachedPrefix(entry: Entry, role: CacheRole, url: string): Promise<MediaPrefix | undefined> {
  const rec = await getCached(fileKey(P.id, entry.item.id, role));
  if (!rec || !(rec.complete || rec.url === url)) return undefined;
  entry.stored[role] = rec.bytes; // what is there need not be written again
  return { blob: rec.blob, total: rec.complete ? rec.bytes : rec.total, complete: rec.complete };
}
/** Hands what the player downloaded to the cache (once per length; complete files always). */
function storeRecording(entry: Entry): void {
  const p = entry.player;
  const src = entry.src;
  if (!p || !src) return;
  const r = p.recording();
  for (const role of ['video', 'audio'] as const) {
    const rec = r[role];
    const url = role === 'video' ? src.url : src.audioUrl;
    if (!rec || !url || rec.bytes <= entry.stored[role]) continue;
    entry.stored[role] = rec.bytes;
    void putCached({ key: fileKey(P.id, entry.item.id, role), itemKey: itemKey(P.id, entry.item.id), role, url, bytes: rec.bytes, total: rec.total, complete: rec.complete, blob: new Blob(rec.parts, { type: 'video/mp4' }) }).then((written) => {
      if (written && overBudget()) scheduleSweep(5000);
    });
  }
}
/**
 * What no sweep may delete: the videos every app's saved feed still lists from the one before the
 * viewer's on (they are what plays next there), and this feed's own from the previous one on.
 */
function protectedItems(): Set<string> {
  const keep = new Set<string>();
  for (const p of PLATFORMS) {
    try {
      const raw = localStorage.getItem(`streamanywhere.resume.${p.id}`);
      if (!raw) continue;
      const r = JSON.parse(raw) as Partial<Resume>;
      if (!Array.isArray(r.items) || Date.now() - (r.savedAt || 0) > CACHE_MAX_AGE) continue;
      const from = Math.max(0, (Number(r.index) || 0) - RESUME_BEHIND);
      for (const it of r.items.slice(from)) if (it?.id) keep.add(itemKey(p.id, it.id));
    } catch {
      /* unreadable: nothing protected from it */
    }
  }
  if (state.mode.kind === 'source') for (const e of state.entries.slice(Math.max(0, state.active - RESUME_BEHIND))) keep.add(itemKey(P.id, e.item.id));
  return keep;
}
let sweepTimer = 0;
/** A sweep of the media cache in a quiet moment (never on the critical path of a video start). */
function scheduleSweep(delayMs: number): void {
  clearTimeout(sweepTimer);
  sweepTimer = window.setTimeout(() => {
    sweepTimer = 0;
    void sweep(protectedItems()).then((r) => {
      if (r && (r.deleted || r.bytes > r.budget * 0.9)) console.info(`[feed] media cache: ${r.files} files, ${fmtBytes(r.bytes)} of ${fmtBytes(r.budget)}${r.deleted ? `, removed ${r.deleted} (${fmtBytes(r.freed)})` : ''}`);
      if (r && r.bytes > r.budget) scheduleSweep(30_000); // still over: on, a few at a time
    });
  }, delayMs);
}
scheduleSweep(25_000);
window.setInterval(() => scheduleSweep(1000), 10 * 60_000);

function onPlayerError(entry: Entry, e: Error): void {
  const detail = e.message || 'unknown error';
  if (entry.src?.kind === 'direct' && !entry.triedProxy && sourceCandidates(entry.item).some((c) => c.kind === 'proxy')) {
    entry.triedProxy = true;
    console.warn(`[feed] direct URL failed for ${entry.item.id} (${detail}); retrying through the proxy`);
    // A renderer that reported an error is finished; start a fresh one for the proxy URL.
    releasePlayer(entry);
    entry.retrying = true;
    attachSource(entry, 'proxy');
    if (activeEntry() === entry && state.started) void playEntry(entry);
    syncWait();
    return;
  }
  if (entry.restored && !entry.reresolved && entry.item.canonicalUrl) {
    // A video from the saved feed: its play URLs have probably expired. Fresh ones from its page, once.
    entry.reresolved = true;
    entry.triedProxy = false;
    entry.item.formats = [];
    entry.resolving = undefined;
    releasePlayer(entry);
    entry.retrying = true;
    console.warn(`[feed] saved video ${entry.item.id} failed (${detail}); getting fresh play URLs`);
    if (activeEntry() === entry && state.started) void playEntry(entry);
    else if (Math.abs(state.entries.indexOf(entry) - state.active) === 1) void ensureFormats(entry).then((ok) => ok && attachSource(entry));
    syncWait();
    return;
  }
  entry.failed = true;
  entry.err.textContent = `This video could not be loaded (${detail}).`;
  entry.err.classList.remove('hidden');
  syncWait();
  reportProblem('player', `${entry.item.id}: ${detail}`, { url: entry.src?.url, connection: entry.src?.kind });
  if (activeEntry() === entry && prefs.autoscroll) window.setTimeout(() => activeEntry() === entry && goTo(state.active + 1), 1500);
}

/**
 * How long the feed waits for a video's play URLs before it counts the video as failed (and skips
 * it with auto-scroll on). The server gives a YouTube lookup 30 s; this leaves room for the trip.
 * Other platforms may start a browser on the server for their first lookup, so they get longer.
 */
const RESOLVE_LIMIT_MS = P.id === 'youtube' ? 40_000 : 100_000;

/** Play URLs that end within this long are replaced before they are used (a failure and a retry cost more). */
const URL_MARGIN_MS = 5 * 60_000;
const urlsExpiring = (item: FeedItem): boolean => item.formats.length > 0 && item.formats.every((f) => f.expiresAt !== undefined && f.expiresAt * 1000 < Date.now() + URL_MARGIN_MS);

/**
 * Items from a guest search carry no play URLs: ask the resolver for them (same formats as the feed)
 * before the player is attached. False when TikTok has nothing playable for it.
 */
function ensureFormats(entry: Entry): Promise<boolean> {
  if (!entry.player && !entry.resolving && urlsExpiring(entry.item)) {
    console.debug(`[feed] ${entry.item.id}: play URLs about to expire; getting fresh ones first`);
    entry.item.formats = [];
  }
  if (entry.item.formats.length) return Promise.resolve(true);
  if (!entry.resolving) {
    entry.resolving = api
      .resolve({ url: entry.item.canonicalUrl, probe: false }, RESOLVE_LIMIT_MS)
      .then((r) => {
        entry.item.formats = r.formats.filter((f) => f.directUrl || f.proxyUrl);
        if (!entry.item.formats.length) throw new Error(r.warnings[0] || 'no playable format');
        // A thin listing (YouTube's hashtag pages name no channel) is completed from the video itself.
        const item = entry.item;
        if (!item.author.uniqueId && r.author) {
          item.author.uniqueId = r.author;
          const a = entry.root.querySelector<HTMLAnchorElement>('.info .author a');
          if (a) {
            a.textContent = `@${r.author}`;
            a.title = 'Open this account';
            a.addEventListener('click', (ev) => {
              ev.preventDefault();
              void openProfile(r.author!);
            });
          }
          if (activeEntry() === entry) syncAuthor(entry);
          renderQueue();
        }
        if (!item.duration && r.duration) item.duration = r.duration;
        if (activeEntry() === entry) syncWait();
        return true;
      })
      .catch((e) => {
        entry.failed = true;
        entry.err.textContent = `This video could not be resolved (${errMsg(e)})`;
        entry.err.classList.remove('hidden');
        syncWait();
        reportProblem('resolve', `${entry.item.id}: ${errMsg(e)}`, { url: entry.item.canonicalUrl });
        if (activeEntry() === entry && prefs.autoscroll) window.setTimeout(() => activeEntry() === entry && goTo(state.active + 1), 1500);
        return false;
      });
  }
  return entry.resolving;
}

async function playEntry(entry: Entry): Promise<void> {
  if (!state.started || entry.failed) return;
  if (!(await ensureFormats(entry)) || activeEntry() !== entry) return;
  if (!attachSource(entry)) return;
  const p = entry.player!;
  p.loop = !prefs.autoscroll;
  p.setMuted(prefs.muted);
  try {
    await p.play();
  } catch (e) {
    console.warn('[feed] play() failed', e);
  }
}

/** The author button beside the video: its avatar, and its @name under it ("Profile" until it is known). */
function syncAuthor(entry: Entry): void {
  const a = entry.item.author;
  if (a.avatar) el.actAuthorImg.src = a.avatar;
  else el.actAuthorImg.removeAttribute('src');
  el.actAuthor.disabled = !a.uniqueId;
  el.actAuthorLabel.textContent = a.uniqueId ? `@${a.uniqueId}` : a.nickname || 'Profile';
  el.actAuthor.title = a.uniqueId ? `@${a.uniqueId}: who posted this video (P)` : 'Who posted this video (P)';
  syncFollow(entry);
  syncStats(entry);
}

/**
 * The follow "+" on the avatar: shown for a signed-in account on a platform with follows (TikTok), for
 * an author it is not known to follow. TikTok's items say (`relation`) for the signed-in feed; where
 * nothing says, the badge shows, and a tap on an account already followed just takes it away.
 */
function syncFollow(entry: Entry | undefined): void {
  const a = entry?.item.author;
  const can = Boolean(P.social && a?.uniqueId && state.session?.state === 'logged_in');
  const s = a ? followStateOf(a) : undefined;
  const followed = s === 'following' || s === 'friends' || s === 'requested';
  el.actFollow.classList.toggle('hidden', !can || followed);
  el.actFollow.title = a?.uniqueId ? `Follow @${a.uniqueId}` : 'Follow this account';
}

/** The video's likes and comments beside it (an item without the count shows no row). */
function syncStats(entry: Entry): void {
  const { likes, comments } = entry.item.stats;
  el.actLikes.classList.toggle('hidden', likes === undefined);
  el.actLikesLabel.textContent = likes === undefined ? '' : fmtCount(likes);
  el.actLikes.title = likes === undefined ? 'Likes' : `${likes.toLocaleString()} likes`;
  el.actComments.classList.toggle('hidden', comments === undefined);
  el.actCommentsLabel.textContent = comments === undefined ? '' : fmtCount(comments);
  el.actComments.title = comments === undefined ? 'Comments' : `${comments.toLocaleString()} comments`;
}

function setActive(idx: number): void {
  if (idx < 0 || idx >= state.entries.length) return;
  const prev = activeEntry();
  if (prev && prev !== state.entries[idx]) {
    prev.player?.pause();
    prev.root.classList.remove('paused', 'active');
    // back to its first frame once it has slid out of view (not while it is still on screen)
    window.setTimeout(() => activeEntry() !== prev && prev.player?.seek(0), SNAP_MS + 40);
  }
  state.active = idx;
  state.userPaused = false;
  const cur = state.entries[idx];
  cur.root.classList.add('active');
  syncAuthor(cur);
  // the first video of a signed-in visit starts by itself (start() plays it); otherwise play here –
  // or, before "Tap to start", get it ready (fresh play URLs if needed, first frames) so the tap is instant
  if (!maybeAutoStart()) {
    if (state.started) void playEntry(cur);
    else void ensureFormats(cur).then((ok) => ok && !state.started && activeEntry() === cur && attachSource(cur));
  }
  syncWait();
  renderQueue();
  // Only the video in view and its two neighbours keep a player (each holds a decoder, an audio
  // context and an open download); the rest are released.
  state.entries.forEach((e, i) => {
    if (Math.abs(i - idx) > 1 && e.player) releasePlayer(e);
  });
  warmNeighbours();
  scheduleMoreIfNeeded();
  saveResume();
}

/** A video in view that shows no frame after this long no longer holds its neighbours back. */
const WARM_LATEST_MS = 3000;
let warmTimer = 0;
/**
 * The neighbours of the video in view get a player too (they fetch and decode their first frames,
 * then idle on backpressure), so the next one starts at once. The video in view goes first: they
 * start only once it has painted its first frame, so its download does not share the connection
 * while the viewer waits. Before "Tap to start", or when it fails or shows nothing within
 * WARM_LATEST_MS, they start anyway.
 */
function warmNeighbours(): void {
  clearTimeout(warmTimer);
  warmTimer = 0;
  const cur = activeEntry();
  if (!cur) return;
  const ready = !state.started || cur.failed || cur.root.classList.contains('has-frame');
  if (!ready) {
    warmTimer = window.setTimeout(() => {
      warmTimer = 0;
      warmNeighbours();
    }, WARM_LATEST_MS);
    return;
  }
  const idx = state.active;
  for (const e of [state.entries[idx + 1], state.entries[idx - 1]]) {
    if (!e || e.failed) continue;
    void ensureFormats(e).then((ok) => ok && Math.abs(state.entries.indexOf(e) - state.active) === 1 && attachSource(e));
  }
  prepareAhead();
}

/**
 * The two videos after the next one: their play URLs now (a saved or stale video needs a resolve,
 * which would otherwise happen as it comes into view), and the first megabyte of each into the
 * media cache, so the swipe to them starts from disk. Not on a connection that asks to save data.
 */
const PREPARE_AHEAD = [2, 3];
const PREFETCH_BYTES = 1024 * 1024;
const prefetching = new Set<string>();
function prepareAhead(): void {
  if (!state.started) return;
  for (const d of PREPARE_AHEAD) {
    const e = state.entries[state.active + d];
    if (!e || e.failed) continue;
    void ensureFormats(e).then((ok) => {
      if (ok && Math.abs(state.entries.indexOf(e) - state.active) <= 3) void prefetchHead(e);
    });
  }
}
async function prefetchHead(entry: Entry): Promise<void> {
  if (entry.player || prefetching.has(entry.item.id)) return;
  const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const pick = sourceCandidates(entry.item)[0];
  if (!pick) return;
  prefetching.add(entry.item.id);
  try {
    const key = fileKey(P.id, entry.item.id, 'video');
    if (await getCached(key)) return;
    // A plain request, read up to PREFETCH_BYTES and then dropped: a Range header would make the
    // browser ask the CDN's permission first (a CORS preflight), which TikTok's CDN does not give.
    const res = await fetch(pick.url, { mode: 'cors', credentials: 'same-origin' });
    if (!res.ok || !res.body) return;
    const total = Number(res.headers.get('content-length') || 0);
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    let got = 0;
    let ended = false;
    while (got < PREFETCH_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      chunks.push(value as BlobPart);
      got += value.byteLength;
    }
    if (!ended) await reader.cancel().catch(() => undefined);
    const complete = ended && (!total || got >= total);
    if (!got || (!complete && !total)) return; // a head is only worth keeping with the file's size
    const blob = new Blob(chunks, { type: 'video/mp4' });
    if (await putCached({ key, itemKey: itemKey(P.id, entry.item.id), role: 'video', url: pick.url, bytes: blob.size, total: complete ? blob.size : total, complete, blob })) {
      console.debug(`[feed] ${entry.item.id}: ${complete ? 'whole file' : `first ${fmtBytes(blob.size)}`} fetched ahead`);
    }
  } catch (e) {
    console.debug(`[feed] ${entry.item.id}: fetch ahead failed (${errMsg(e)})`);
  } finally {
    prefetching.delete(entry.item.id);
  }
}

function goTo(idx: number): void {
  if (idx < 0) return;
  if (idx >= state.entries.length) {
    // Past the end: fetch more and advance when it arrives (the feed never stops).
    state.wantNext = true;
    if (state.loading) startLoadingStatus();
    else {
      clearTimeout(state.retryTimer);
      void loadMore();
    }
    return;
  }
  snapTo(idx);
}

function togglePause(entry: Entry): void {
  if (!state.started) {
    start();
    return;
  }
  if (!entry.player || entry.player.paused) {
    state.userPaused = false;
    entry.root.classList.remove('paused');
    void playEntry(entry);
  } else {
    state.userPaused = true;
    entry.player.pause();
    entry.root.classList.add('paused');
  }
  syncWait();
}

// ---------- per-video status: what the video in view is waiting for ----------
// Shown on the video only after a short delay (a quick start never flashes it) and updated as the
// wait grows. One timer, running only while the video in view waits; nothing runs otherwise.
const WAIT_SHOW_MS = 450;
let waitTimer = 0;
let waitEntry: Entry | undefined;
let waitPhase = '';
let waitSince = 0;
function waitPhaseOf(e: Entry): string {
  if (!state.started || e.failed || state.userPaused || document.hidden || overlayOpen()) return '';
  if (e.resolving && !e.item.formats.length) return 'resolve';
  if (!e.root.classList.contains('has-frame')) return e.retrying ? 'retry' : 'load';
  return e.buffering ? 'buffer' : '';
}
function syncWait(): void {
  const e = activeEntry();
  const phase = e ? waitPhaseOf(e) : '';
  if (waitEntry && waitEntry !== e) {
    waitEntry.waitEl.classList.add('hidden');
    queueWait(waitEntry, '');
  }
  // the clock starts when a wait starts; from one step to the next (resolve → load) it keeps running
  if (e !== waitEntry || !waitPhase) waitSince = Date.now();
  waitEntry = e;
  waitPhase = phase;
  if (!e || !phase) {
    e?.waitEl.classList.add('hidden');
    queueWait(e, '');
    clearInterval(waitTimer);
    waitTimer = 0;
    return;
  }
  renderWait();
  if (!waitTimer) waitTimer = window.setInterval(renderWait, 500);
}
function renderWait(): void {
  const e = waitEntry;
  if (!e) return;
  const ms = Date.now() - waitSince;
  if (ms < WAIT_SHOW_MS) {
    e.waitEl.classList.add('hidden');
    queueWait(e, '');
    return;
  }
  const sec = Math.floor(ms / 1000);
  let text = waitPhase === 'resolve' ? `Getting the video from ${P.name}…` : waitPhase === 'retry' ? 'Trying another connection…' : waitPhase === 'buffer' ? 'Buffering…' : 'Loading video…';
  // Bytes are moving: how much of the video is here (the file size once the server has said it)
  const dl = waitPhase === 'resolve' ? undefined : e.player?.download();
  if (dl && dl.fraction >= 0) text += ` ${Math.floor(dl.fraction * 100)}%`;
  if (dl && dl.loaded > 0) text += dl.total ? `\n${fmtBytes(dl.loaded)} of ${fmtBytes(dl.total)}` : `\n${fmtBytes(dl.loaded)} received`;
  if (sec >= 6) text += `\n${sec} s – slow connection, still loading`;
  if (e.waitText.textContent !== text) e.waitText.textContent = text;
  e.waitEl.classList.remove('hidden');
  queueWait(e, text);
}
/** The wait line on the video's row in the Up next list (empty text hides it). */
function queueWait(e: Entry | undefined, text: string): void {
  const q = e && queueRows.get(e.item.id);
  if (!q) return;
  q.wait.classList.toggle('hidden', !text);
  if (q.wait.textContent !== text) q.wait.textContent = text;
}

function toggleMute(): void {
  prefs.muted = !prefs.muted;
  savePrefs();
  for (const e of state.entries) e.player?.setMuted(prefs.muted);
  syncActionButtons();
  toast(prefs.muted ? 'Muted' : 'Sound on');
}

// ---------- download ----------
async function download(entry: Entry): Promise<void> {
  const item = entry.item;
  const cands = sourceCandidates(item);
  if (!cands.length) return toast('No downloadable URL for this video', true);
  const name = `@${(item.author.uniqueId || P.id).replace(/[^\w.-]+/g, '_')}_${item.id}.mp4`;
  if (cands[0].audioUrl) toast(`${P.name} serves the sound as a separate file: the saved MP4 has the picture only`, false, 5000);
  if (el.actDownload.classList.contains('busy')) return;
  el.actDownload.disabled = true;
  el.actDownload.classList.add('busy');
  const small = el.actDownload.querySelector('small');
  const smallText = small?.textContent || 'Save';
  if (small) small.textContent = 'Saving…';
  el.actDownloadIco.textContent = '…';
  const errors: string[] = [];
  try {
    for (const c of cands) {
      try {
        const res = await fetch(c.url, { mode: 'cors', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length') || 0);
        const reader = res.body?.getReader();
        const chunks: BlobPart[] = [];
        let got = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value as BlobPart);
            got += value.length;
            el.actDownloadIco.textContent = total ? `${Math.round((100 * got) / total)}%` : `${(got / 1048576).toFixed(1)}M`;
          }
        } else {
          chunks.push(new Uint8Array(await res.arrayBuffer()));
        }
        const blob = new Blob(chunks, { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        toast(`Saved ${name} (${(blob.size / 1048576).toFixed(1)} MB, ${c.kind})`);
        return;
      } catch (e) {
        errors.push(`${c.kind}: ${(e as Error).message}`);
      }
    }
    toast(`Download failed – ${errors.join('; ')}`, true, 7000);
  } finally {
    el.actDownload.disabled = false;
    el.actDownload.classList.remove('busy');
    if (small) small.textContent = smallText;
    el.actDownloadIco.innerHTML = ICON.save;
  }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  if (panelOpen()) {
    if (e.key === 'Escape') closeTopPanel();
    return;
  }
  const cur = activeEntry();
  switch (e.key) {
    case '/':
      e.preventDefault();
      openSearch();
      break;
    case 'p':
    case 'P':
      if (cur?.item.author.uniqueId) void openProfile(cur.item.author.uniqueId);
      break;
    case 'ArrowDown':
    case 'j':
    case 'J':
    case 'PageDown':
      e.preventDefault();
      if (!state.started) start();
      goTo(state.active + 1);
      break;
    case 'ArrowUp':
    case 'k':
    case 'K':
    case 'PageUp':
      e.preventDefault();
      goTo(state.active - 1);
      break;
    case ' ':
      e.preventDefault();
      if (cur) togglePause(cur);
      break;
    case 'm':
    case 'M':
      toggleMute();
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'w':
    case 'W':
      toggleFullscreen();
      break;
    case 's':
    case 'S':
      if (speedMenuOpen()) closeSpeedMenu();
      else openSpeedMenu();
      break;
    case 'Escape':
      if (speedMenuOpen()) {
        closeSpeedMenu();
        break;
      }
      if (isFullscreen()) {
        setFullscreen(false);
        break;
      }
      if (!el.session.classList.contains('hidden') && el.sessionClose.classList.contains('hidden') === false) closeSessionPanel();
      else backToPanel();
      break;
    case 'Backspace':
      backToPanel();
      break;
    case 'd':
    case 'D':
      if (cur) void download(cur);
      break;
    case 'a':
    case 'A':
      toggleAutoscroll();
      break;
  }
});

// ---------- the track: it follows the finger / mouse, then snaps to one video ----------
// No native scrolling. The feed is a clip window and the track inside it (every video panel with
// its caption and progress bar, stacked with no gap) is translated. While a finger or the mouse
// holds it, it moves with the pointer: the next panel comes in from below, the previous one from
// above. On release it snaps to the next / previous panel when the drag went far or fast enough,
// otherwise back to the one it started on. The wheel and the keys snap directly. The panel in
// view is centred in the window: on wide screens the window is taller than a panel, so the edges
// of the neighbours show; on phones a panel is the whole window.
const SNAP_MS = 320;
/** A drag moves on when it covers this share of a panel ... */
const SWIPE_SHARE = 0.2;
/** ... or ends at this speed (px per ms) in its own direction. */
const FLICK_SPEED = 0.45;
/** Pointer movement below this is a tap / click, not a drag. */
const SLOP = 6;
let itemH = 1;
let padTop = 0;
/** The panel the track rests on (= state.active once a move is decided). */
let trackIdx = 0;
/** The drag displacement in px: positive = pulled down (towards the previous panel). */
let offset = 0;

/** Reads the panel height and the centring pad; true when they changed. */
function measure(): boolean {
  const first = el.track.firstElementChild as HTMLElement | null;
  const h = Math.max(1, first?.offsetHeight || el.feed.clientHeight);
  const pad = Math.max(0, Math.round((el.feed.clientHeight - h) / 2));
  if (h === itemH && pad === padTop) return false;
  itemH = h;
  padTop = pad;
  return true;
}
function placeTrack(animate: boolean): void {
  el.track.classList.toggle('snapping', animate);
  el.track.style.transform = `translate3d(0, ${padTop - trackIdx * itemH + offset}px, 0)`;
}
/** Puts the track on a panel at once (a reload). */
function jumpTo(idx: number): void {
  trackIdx = Math.max(0, idx);
  offset = 0;
  measure();
  placeTrack(false);
}
/** Slides the track to a panel and makes it the one playing. */
function snapTo(idx: number): void {
  trackIdx = idx;
  offset = 0;
  placeTrack(true);
  setActive(idx);
}
/** The track's translation as rendered right now (mid-snap it is between two panels). */
function renderedY(): number {
  return new DOMMatrixReadOnly(getComputedStyle(el.track).transform).m42;
}
/** After a resize (window, orientation, fullscreen, the first items): keep the panel in view exactly in view. */
function layout(): void {
  if (!measure()) return;
  if (!gesture || gesture.axis !== 'y') offset = 0;
  placeTrack(false);
}
new ResizeObserver(layout).observe(el.feed);
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', layout);
document.addEventListener('fullscreenchange', layout);
window.visualViewport?.addEventListener('resize', layout);

/** Decides where the track goes when the pointer lets go (v: px per ms, positive = downwards). */
function settle(v: number, moved: number): void {
  const last = state.entries.length - 1;
  if (last < 0) {
    offset = 0;
    placeTrack(true);
    return;
  }
  const far = Math.abs(moved) >= itemH * SWIPE_SHARE;
  const flick = Math.abs(v) >= FLICK_SPEED && Math.sign(v) === Math.sign(moved) && Math.abs(moved) >= 12;
  // a short, slow drag goes back; after grabbing a moving track, to the nearest panel
  let target = far || flick ? trackIdx + (moved < 0 ? 1 : -1) : trackIdx - Math.round(offset / itemH);
  if (target > last) goTo(last + 1); // past the end: the next batch, and on to it when it arrives
  target = Math.max(0, Math.min(last, target));
  if (target !== state.active) snapTo(target);
  else {
    trackIdx = target;
    offset = 0;
    placeTrack(true);
  }
}

interface Gesture {
  id: number;
  x0: number;
  y0: number;
  t0: number;
  /** Decided once the pointer has moved past SLOP: vertical = the track, horizontal = the back gesture. */
  axis: 'none' | 'x' | 'y';
  /** The track's offset when it was grabbed (not 0 when grabbed mid-snap). */
  base: number;
  /** The last moves, for the release speed. */
  samples: { y: number; t: number }[];
}
let gesture: Gesture | undefined;
el.feed.addEventListener('pointerdown', (e) => {
  if (gesture || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if ((e.target as HTMLElement).closest('a, button, .progress')) return; // their own clicks and drags
  gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), axis: 'none', base: 0, samples: [] };
});
window.addEventListener('pointermove', (e) => {
  if (!gesture || e.pointerId !== gesture.id) return;
  const dx = e.clientX - gesture.x0;
  const dy = e.clientY - gesture.y0;
  if (gesture.axis === 'none') {
    if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
    gesture.axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
    if (gesture.axis !== 'y') return;
    // grabbed: the track stops where it is (mid-snap too) and follows the pointer from there
    offset = renderedY() - (padTop - trackIdx * itemH);
    gesture.base = offset;
    el.track.classList.remove('snapping');
    el.feed.classList.add('dragging');
    try {
      el.feed.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is gone already */
    }
  }
  if (gesture.axis !== 'y') return;
  const raw = gesture.base + dy;
  const last = state.entries.length - 1;
  // before the first / past the last panel the track only gives a little
  offset = (raw > 0 && trackIdx <= 0) || (raw < 0 && trackIdx >= last) ? raw * 0.35 : raw;
  placeTrack(false);
  const t = performance.now();
  gesture.samples.push({ y: e.clientY, t });
  while (gesture.samples.length > 1 && t - gesture.samples[0].t > 100) gesture.samples.shift();
});
function endGesture(e: PointerEvent, cancelled: boolean): void {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  gesture = undefined;
  if (g.axis === 'none') return; // a tap / click: the picture's own click listener
  el.feed.classList.remove('dragging');
  try {
    el.feed.releasePointerCapture(e.pointerId);
  } catch {
    /* not captured */
  }
  suppressClickUntil = Date.now() + 400; // the click that ends a drag must not toggle pause
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  const dt = performance.now() - g.t0;
  if (g.axis === 'x') {
    // A swipe / drag to the right (like the back gesture of a phone) returns to the list's panel.
    if (!cancelled && dx >= 70 && dx > Math.abs(dy) * 1.5 && dt <= 1200) backToPanel();
    return;
  }
  if (!state.started) start();
  const s0 = g.samples[0];
  const s1 = g.samples[g.samples.length - 1];
  // the speed over the last moves (a span of at least a frame, or the estimate is noise)
  const v = !cancelled && s0 && s1 && s1.t - s0.t >= 8 ? (s1.y - s0.y) / (s1.t - s0.t) : 0;
  settle(v, cancelled ? 0 : offset - g.base);
}
window.addEventListener('pointerup', (e) => endGesture(e, false));
window.addEventListener('pointercancel', (e) => endGesture(e, true));
// nothing in the feed is dragged natively (images, links) and the page never scrolls under it
el.feed.addEventListener('dragstart', (e) => e.preventDefault());

// ---------- wheel: one notch (or one trackpad flick) = one video ----------
let wheelAcc = 0;
let wheelLockUntil = 0;
let wheelIdle = 0;
el.feed.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLockUntil || gesture?.axis === 'y') {
      wheelAcc = 0; // the tail of a trackpad flick, or a finger on the track
      return;
    }
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * itemH : e.deltaY;
    clearTimeout(wheelIdle);
    wheelIdle = window.setTimeout(() => (wheelAcc = 0), 200);
    if (Math.abs(wheelAcc) < 50) return;
    const dir = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    wheelLockUntil = now + 600;
    if (!state.started) start();
    goTo(state.active + dir);
  },
  { passive: false },
);

/** A panel (search, profile, inbox, sign-in) covers the feed: the video waits behind it. */
function overlayOpen(): boolean {
  return panelOpen() || !el.session.classList.contains('hidden');
}
// Pause while the tab is hidden or a panel covers the feed; resume (unless the user paused) when
// the tab returns and the last panel closes.
function syncOverlayPause(): void {
  const cur = activeEntry();
  if (!cur) return;
  if (document.hidden || overlayOpen()) cur.player?.pause();
  else if (!state.userPaused) void playEntry(cur);
  syncWait();
}
document.addEventListener('visibilitychange', syncOverlayPause);

// The service worker showed this page from its cache while the network was slow, and a newer page
// has arrived since (a deploy): take it now while nothing is lost – only before playback started.
navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
  if ((e.data as { type?: string } | null)?.type === 'page-updated' && !state.started && !leaving) location.reload();
});

// ---------- boot ----------
// The feed must not wait for the session check (it may launch a browser on the server): start with
// Explore right away, and switch to For You as soon as the server confirms a signed-in profile.
// A signed-in account gets For You even when the saved source is Explore, unless the viewer tapped
// Explore while signed in (pick 'user'): an earlier visit that found the server restarting must not
// pin the account to the guest feed.
void (async () => {
  const wanted: FeedSource = wantsForYou() ? 'foryou' : 'explore';
  const savedForYou = prefs.source === 'foryou';
  // The page was closed (the car's browser does that when another app opens): the saved feed of the
  // tab this visit would show plays on at once, without waiting for the server or the session check.
  // Explore is what shows first anyway (For You follows once the server confirms the account), and on a
  // sign-in-only platform either tab needs the account, so those restore too.
  const saved = loadResume();
  const restored = !!saved && (saved.source === wanted || saved.source === 'explore' || P.loginRequired) && restoreFeed(saved);
  const restoredFrom = restored ? saved!.source : undefined;
  // Explore first, For You once the account is confirmed – except on a sign-in-only platform, where
  // either tab needs the account, and for an account the server reported signed in last time
  // (trusted: For You is asked for straight away; the server's earlier For You videos come at once).
  const trusted = !P.loginRequired && savedForYou && !restored && wanted === 'foryou' && lastSignedIn();
  if (savedForYou && !restored && !P.loginRequired && !trusted) {
    prefs.source = 'explore';
    renderSourceUi();
  }
  // The first batch is asked for at once, before the session check: the server answers with
  // earlier videos when it has nothing ready, or with "not signed in" (which opens the sign-in panel).
  // On a sign-in-only platform, and for a trusted account, that batch is the account's feed, like a
  // restored one (onSignedIn keeps it).
  const feedReady: Promise<unknown> = restored ? Promise.resolve() : loadMore();
  if ((P.loginRequired && !restored) || trusted) restoredSource = prefs.source;
  let resuming = false;
  try {
    resuming = localStorage.getItem(SIGNIN_KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  if (resuming) {
    // A sign-in was pending when the page was last open: show the panel right away, in the right step.
    el.session.classList.remove('hidden');
    el.sessionText.innerHTML = `<b>Resuming your ${esc(P.name)} sign-in…</b>\nChecking where it stands on the server.`;
  }
  const s = await refreshSession();
  if (s?.state === 'login_pending') {
    hideLoading();
    el.session.classList.remove('hidden');
    pollSession();
    if (s.qrState === 'verify' && s.verifyStep === 'code') toast('Your sign-in is waiting for the e-mailed code', false, 5000);
  } else if (resuming && s && !s.probing && s.state !== 'logged_in') {
    toast('The sign-in is no longer pending on the server – start it again from Profile', false, 6000);
  }
  if (s?.probing) {
    toast(`Checking the saved ${P.name} sign-in on the server…`);
    const t0 = Date.now();
    while (state.session?.probing && Date.now() - t0 < 60_000) {
      await new Promise((r) => setTimeout(r, 2000));
      await refreshSession();
    }
  }
  booting = false;
  // A restored feed is the feed: a confirmed sign-in only lets it go on loading (no reload). Kept
  // while the check still runs, so the switch to the account's feed (onSignedIn) knows it too.
  if (!state.session?.probing) restoredSource = undefined;
  if (P.loginRequired) {
    if (state.session?.state === 'logged_in' && (restored || prefs.source === wanted)) {
      // the feed on screen (restored, or asked for at boot) is the account's feed: it goes on
      savePrefs();
    } else if (state.session?.state === 'logged_in') {
      prefs.source = wanted;
      savePrefs();
      renderSourceUi();
      await feedReady;
      toast(`Signed in as @${state.session.username || '?'} – loading your ${wanted === 'foryou' ? P.tabs.foryou : P.tabs.explore} feed`);
      void reload();
    } else if (state.session?.probing) {
      restoreForYou = true;
      pollSession();
    } else if (state.session?.state !== 'login_pending' && el.session.classList.contains('hidden')) {
      // (the first batch's "not signed in" answer may have opened the panel already)
      void openSessionPanel();
    }
  } else if (wanted === 'foryou') {
    if (state.session?.state === 'logged_in' && (restoredFrom === 'foryou' || prefs.source === 'foryou')) {
      // the saved For You feed, or the one a trusted account asked for at boot: it goes on
      savePrefs();
    } else if (state.session?.state === 'logged_in') {
      prefs.source = 'foryou';
      savePrefs();
      renderSourceUi();
      await feedReady;
      toast(`Signed in as @${state.session.username || '?'} – loading your ${P.tabs.foryou} feed`);
      void reload();
    } else if (state.session?.probing) {
      // The server is still checking the saved profile (a cold browser start on a small VM can take
      // longer than a minute): keep the For You preference and keep polling; refreshSession switches
      // over when the server reports the sign-in, or settles on Explore when it reports none.
      restoreForYou = true;
      pollSession();
    } else if (savedForYou && state.session?.supported) {
      // No session on the server: Explore for this visit. The saved preference is not touched, so a
      // server that is restarting (unreachable right now) cannot pin the account to Explore.
      toast(`Sign in (Profile) to see your ${P.tabs.foryou} feed; showing ${P.tabs.explore} meanwhile.`, false, 5000);
      if (restoredFrom === 'foryou' || prefs.source === 'foryou') {
        // the saved (or trusted) For You videos cannot go on loading without the account
        prefs.source = 'explore';
        renderSourceUi();
        void reload();
      }
    }
  }
})();

// Back to the launcher: the home screen plays the reverse of its open animation for this app.
// It must answer the tap at once, also while a video plays on a slow device (the car): the
// navigation goes out on the finger's release, not the click after it, and every player is stopped
// first, so decoding, drawing and the video downloads no longer hold up the thread and the network
// while the home screen loads.
let leaving = false;
function goHome(): void {
  if (leaving) return;
  leaving = true;
  el.app.classList.add('leaving');
  try {
    sessionStorage.setItem('streamanywhere.returnFrom', P.id);
  } catch {
    /* ignore */
  }
  saveResume(true); // the position too, while the player still knows it
  for (const e of state.entries) releasePlayer(e);
  location.assign(el.homeLink.href);
}
/**
 * Another app from the rail: like going home, the page answers the tap at once. The app's splash
 * (the launcher's: its tile, its icon, "Opening …") covers this page right away and feed.html
 * continues it from its first paint, every player is stopped so their downloads and decoding no
 * longer hold up the thread and the network, the feed is saved, and the app's page is asked for.
 */
function switchApp(p: PlatformDef): void {
  if (leaving) return;
  leaving = true;
  el.app.classList.add('leaving');
  const launch = { tile: p.tile, icon: p.icon, name: p.name };
  try {
    sessionStorage.setItem('streamanywhere.launch', JSON.stringify(launch));
  } catch {
    /* storage unavailable: the app opens without the splash */
  }
  const splash = document.createElement('div');
  splash.className = 'splash';
  splash.style.background = launch.tile;
  splash.innerHTML = `<div class="splash-icon">${launch.icon}</div><div class="splash-status"><span class="splash-spinner"></span><span>Opening ${esc(launch.name)}…</span></div>`;
  document.body.appendChild(splash);
  saveResume(true);
  for (const e of state.entries) releasePlayer(e);
  location.assign(p.url);
}
/** A control that leaves the page: acts on release of a press that began on it (and on click: keyboard, mouse). */
function onTap(b: HTMLElement, fn: () => void): void {
  let down = -1;
  b.addEventListener('pointerdown', (e) => {
    if (e.isPrimary && e.button === 0) down = e.pointerId;
  });
  b.addEventListener('pointerup', (e) => {
    if (e.pointerId !== down) return;
    down = -1;
    e.preventDefault();
    fn();
  });
  b.addEventListener('pointercancel', () => (down = -1));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    fn();
  });
}
function onHomeTap(b: HTMLElement): void {
  onTap(b, goHome);
}
onHomeTap(el.homeLink);
// Back from the home screen into a page kept in the back/forward cache: its players were stopped.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && leaving) location.reload();
});

// Opened from the home screen: its splash (feed.html) fades into the page now that everything is set up.
// (Also after feed.html's 15 s failsafe showed it: a slow load that got there after all.)
(window as unknown as { streamAnywhereReady: boolean }).streamAnywhereReady = true;
{
  const splash = document.getElementById('splash');
  if (splash && !splash.classList.contains('hidden')) {
    window.setTimeout(() => splash.classList.add('leaving'), 30);
    window.setTimeout(() => splash.remove(), 400);
  }
}

// Debug handle (console / automated checks): the state plus the two navigation entry points, so the
// feed can be driven where scrolling and IntersectionObserver do not run (hidden or occluded tabs).
(window as unknown as { streamAnywhereFeed: unknown }).streamAnywhereFeed = Object.assign(state, { setActive, goTo });
