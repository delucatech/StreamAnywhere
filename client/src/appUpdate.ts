/**
 * The app on this device: opened from the service worker's copy, kept up to date in the background.
 *
 * The service worker (public/sw.js) answers every page from the version saved on this device and
 * looks for a newer one on the server. This module is the page's side of that:
 *
 *  - "The app was just opened" is one of: this script starts (a page load), the page comes back
 *    from the browser's back/forward cache (pageshow, persisted), or it becomes visible again
 *    after being hidden (the installed app brought back to the front, the tab chosen again, the
 *    car's screen woken). Each of them asks the worker to check for a newer version - and asks the
 *    browser to re-read the worker's own script.
 *  - The worker answers (message "app-update"):
 *      current / updated   the server answered. When a newer copy of THIS page was stored after
 *                          the page was loaded, the page reloads into it - unless the page says
 *                          it must not right now (something is playing, a download is running);
 *                          then a notice says the new version loads at the next open.
 *      unreachable         the server did not answer: "Reconnecting…" stays on screen while it
 *                          tries again (5 s, 10 s, 20 s), then "Could not connect" for a while;
 *                          after that it keeps trying quietly every 30 s. "Connected again" when
 *                          the server is back. The browser's `online` event tries at once.
 *      login               the site password cookie is gone: the server's login page.
 *      none                the server has no version file (the dev server): nothing is cached.
 *  - It asks the browser to keep this site's storage (saved videos, the media cache) instead of
 *    dropping it when the disk runs short.
 *
 * The notice is this module's own element (the home screen and the Mirror page have no toast), so
 * it looks the same on every page.
 */

export interface AppUpdateOptions {
  /** May the page reload right now? Default: yes. False while something plays or a download runs. */
  canReload?: () => boolean;
}

type UpdateState = 'current' | 'updated' | 'unreachable' | 'login' | 'none';
interface UpdateMessage {
  type: 'app-update';
  state: UpdateState;
  detail?: string;
  version?: string;
  /** The pages whose text changed (state updated) */
  pages?: string[];
  /** When the newer copy was stored (ms) */
  changedAt?: number;
  /** In an answer to this page's own question: a newer copy of this page was stored after it loaded */
  stale?: boolean;
  /** An answer to this page's question (not the news of an update another page's check found) */
  reply?: boolean;
}

/** The page as the service worker names it */
const PAGE = location.pathname === '/' ? '/home.html' : location.pathname;
/** When this page was loaded: a copy stored later is newer than what is on screen */
const LOADED_AT = performance.timeOrigin || Date.now();
/** Waits before the next try while "Reconnecting…" shows; after these, RETRY_QUIET_MS */
const RETRY_MS = [5000, 10000, 20000];
const RETRY_QUIET_MS = 30000;
/** Two "opened" signals this close together are one opening (pageshow + visibilitychange) */
const OPEN_GAP_MS = 5000;
/** A question without an answer for this long is forgotten (the worker was stopped mid-way) */
const ANSWER_WAIT_MS = 90000;
/** No second reload-for-an-update this soon after one (a guard against ever looping) */
const RELOAD_GUARD_MS = 15000;
const RELOAD_KEY = 'streamanywhere.update.reloadAt';

let started = false;
let canReload: () => boolean = () => true;
/** Failed checks in a row since the app was last opened (decides which notice shows, and the next wait) */
let failures = 0;
/** The server has not answered since its last answer (decides whether "Connected again" is said) */
let down = false;
let waiting = false;
let askedAt = 0;
let retryTimer = 0;
let answerTimer = 0;
let reloading = false;
let toldPending = false;

// ---------------------------------------------------------------- the notice
let box: HTMLDivElement | undefined;
let hideTimer = 0;

function notice(text: string, opts: { error?: boolean; ms?: number } = {}): void {
  if (!box) {
    box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:calc(env(safe-area-inset-top, 0px) + 14px)',
      'transform:translateX(-50%)',
      'z-index:2147483000',
      'max-width:min(92vw, 620px)',
      'padding:10px 18px',
      'border-radius:16px',
      'background:rgba(14,18,34,.95)',
      'color:#fff',
      'border:1px solid rgba(255,255,255,.2)',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)',
      'font:600 clamp(14px, 1.25vw, 18px)/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      'text-align:center',
      'cursor:pointer',
      'transition:opacity .2s',
    ].join(';');
    box.title = 'Tap to hide';
    box.addEventListener('click', hideNotice);
    document.body.appendChild(box);
  }
  box.textContent = text;
  box.style.borderColor = opts.error ? '#ff6b6b' : 'rgba(255,255,255,.2)';
  box.style.display = 'block';
  box.style.opacity = '1';
  window.clearTimeout(hideTimer);
  if (opts.ms) hideTimer = window.setTimeout(hideNotice, opts.ms);
}

function hideNotice(): void {
  window.clearTimeout(hideTimer);
  if (box) box.style.display = 'none';
}

// ---------------------------------------------------------------- asking
/**
 * Asks the worker for a check. False when it does not: an answer is still awaited, or (for an
 * "opened" signal) the last question is only a moment old.
 */
function ask(why: 'open' | 'retry' | 'online'): boolean {
  const now = Date.now();
  if (waiting) return false;
  if (why === 'open' && now - askedAt < OPEN_GAP_MS) return false;
  window.clearTimeout(retryTimer);
  waiting = true;
  askedAt = now;
  // a worker the browser stopped mid-way never answers: do not wait for it for ever
  window.clearTimeout(answerTimer);
  answerTimer = window.setTimeout(() => {
    waiting = false;
    retryLater();
  }, ANSWER_WAIT_MS);
  navigator.serviceWorker.ready
    .then((reg) => {
      // the worker's own script too (the browser looks on a navigation, not when the app comes back to the front)
      if (why !== 'retry') void reg.update().catch(() => undefined);
      if (!reg.active) throw new Error('no active service worker');
      reg.active.postMessage({ type: 'check-update', page: PAGE, loadedAt: LOADED_AT });
    })
    .catch((e) => {
      answered();
      console.warn('[app] the update check could not be asked for', e);
      retryLater();
    });
  return true;
}

function answered(): void {
  waiting = false;
  window.clearTimeout(answerTimer);
}

/** The app was opened (or brought back): the "Reconnecting…" story starts over, and a check runs. */
function opened(): void {
  failures = 0;
  // no question went out (one is a moment old, or its answer is awaited): while the server is
  // down, the tries must go on all the same - going to the background stopped them
  if (!ask('open') && down && !waiting) retryLater();
}

function retryLater(): void {
  window.clearTimeout(retryTimer);
  if (document.visibilityState !== 'visible') return; // coming back to the front asks again
  retryTimer = window.setTimeout(() => void ask('retry'), RETRY_MS[Math.max(0, failures - 1)] ?? RETRY_QUIET_MS);
}

function couldNotConnect(m: UpdateMessage): void {
  failures++;
  down = true;
  console.warn(`[app] update check ${failures}: ${m.detail || 'the server did not answer'}`);
  const offline = !navigator.onLine;
  if (failures <= RETRY_MS.length) {
    notice(offline ? 'You are offline. Reconnecting…' : 'Could not reach the server. Reconnecting…');
  } else if (failures === RETRY_MS.length + 1) {
    notice(
      offline
        ? 'You are offline. This is the copy of the app saved on this device; it reconnects by itself.'
        : 'Could not connect to the server. This is the copy of the app saved on this device; it keeps trying in the background.',
      { error: true, ms: 9000 },
    );
  }
  retryLater();
}

/** A newer copy of this page is on the device: load it, or say that it will load at the next open. */
function applyUpdate(): void {
  if (reloading) return;
  let lastReload = 0;
  try {
    lastReload = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {
    /* no session storage: no guard */
  }
  if (Date.now() - lastReload < RELOAD_GUARD_MS) return;
  if (!canReload()) {
    if (!toldPending) notice('A new version of the app is ready. It loads the next time this page is opened.', { ms: 7000 });
    toldPending = true;
    return;
  }
  reloading = true;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* see above */
  }
  location.reload();
}

function onMessage(e: MessageEvent): void {
  const m = e.data as UpdateMessage | null;
  if (!m || m.type !== 'app-update') return;
  const stale = m.reply ? !!m.stale : !!m.pages?.includes(PAGE) && (m.changedAt ?? Infinity) > LOADED_AT;
  if (!m.reply) {
    // another page's check downloaded a new version
    if (m.state === 'updated' && stale) applyUpdate();
    return;
  }
  answered();
  if (m.state === 'login') {
    // back to the password page, but not out of a video that plays from this device
    if (canReload()) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    return;
  }
  if (m.state === 'unreachable') {
    // a newer copy stored earlier is on the device all the same
    if (stale && canReload()) applyUpdate();
    if (!reloading) couldNotConnect(m);
    return;
  }
  window.clearTimeout(retryTimer);
  if (down) notice('Connected again.', { ms: 3000 });
  down = false;
  failures = 0;
  if (stale) applyUpdate();
}

/** Asks the browser not to drop this site's data (saved videos) when storage runs short. */
function keepStorage(): void {
  const st = navigator.storage;
  // Firefox asks the viewer with a prompt; Chromium and Safari decide by themselves
  if (!st?.persist || !st.persisted || /firefox/i.test(navigator.userAgent)) return;
  void st
    .persisted()
    .then((kept) => kept || st.persist())
    .catch(() => undefined);
}

/**
 * Registers the service worker and starts the checks. Call once from each page's script. Does
 * nothing where service workers do not exist (a plain http page: the phone's hotspot Mirror page).
 */
export function startAppUpdates(opts: AppUpdateOptions = {}): void {
  if (started || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  started = true;
  if (opts.canReload) canReload = opts.canReload;
  navigator.serviceWorker.addEventListener('message', onMessage);
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[app] service worker not registered', e));
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) opened();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') opened();
    else window.clearTimeout(retryTimer);
  });
  window.addEventListener('online', () => void ask('online'));
  keepStorage();
  opened();
}
