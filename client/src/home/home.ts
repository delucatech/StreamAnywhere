/**
 * The launcher: an iPad-style home screen with one icon per platform (and the lab player).
 * Tapping an icon zooms it up to fill the screen and opens that platform's feed; the feed's
 * Home button comes back here and the icon zooms back down.
 *
 * Icons come from the platform registry (src/platforms.ts); a green badge marks a platform
 * whose server-side sign-in is active (an orange one a sign-in in progress).
 */
import type { Platform, SessionStatus } from '../../../shared/types';
import { api } from '../api';
import { PLATFORMS, rememberApp, type PlatformDef } from '../platforms';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const el = { screen: $('screen'), grid: $('grid'), dock: $('dock'), zoom: $('zoom'), clock: $('clock') };

interface App {
  id: Platform | 'lab';
  name: string;
  url: string;
  tile: string;
  icon: string;
  platform?: PlatformDef;
}

const LAB: App = {
  id: 'lab',
  name: 'Lab',
  url: 'index.html',
  tile: 'linear-gradient(145deg, #3b4a7a 0%, #16203f 100%)',
  icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M9 3h6v2h-1v5.3l5.2 8.6A2 2 0 0 1 17.5 22h-11a2 2 0 0 1-1.7-3.1L10 10.3V5H9z"/><path fill="#8fd3ff" d="M8.6 16h6.8l2.1 3.5H6.5z"/></svg>',
};
const APPS: App[] = [...PLATFORMS.map((p) => ({ id: p.id, name: p.short, url: p.url, tile: p.tile, icon: p.icon, platform: p })), LAB];

const badges = new Map<string, HTMLElement[]>();

function makeIcon(app: App, inDock: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'app';
  b.dataset.app = app.id;
  b.setAttribute('aria-label', `Open ${app.name}`);
  const tile = document.createElement('span');
  tile.className = 'tile';
  tile.style.background = app.tile;
  tile.innerHTML = app.icon;
  const badge = document.createElement('span');
  badge.className = 'badge';
  tile.appendChild(badge);
  b.appendChild(tile);
  if (!inDock) {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = app.name;
    b.appendChild(label);
  }
  badges.set(app.id, [...(badges.get(app.id) || []), badge]);
  b.addEventListener('click', () => open(app, tile));
  return b;
}

for (const app of APPS) el.grid.appendChild(makeIcon(app, false));
for (const app of APPS) if (app.platform) el.dock.appendChild(makeIcon(app, true));

let opening = false;

/**
 * The zoom surface: the tile's colour (a plain box, scaled to fill the screen) and the app's icon
 * on its own layer at its final size (scaled down to the tile at the start), so the icon never
 * stretches with the screen's shape and stays sharp. Below it, a spinner and "Opening …" fade in
 * while the app loads; feed.html shows the same splash until the feed is set up, so the hand-over
 * from this page to the app is seamless.
 */
const ZOOM_ICON = 150;
const zoomBg = document.createElement('div');
zoomBg.className = 'zoom-bg';
const zoomIcon = document.createElement('div');
zoomIcon.className = 'zoom-icon';
const zoomStatus = document.createElement('div');
zoomStatus.className = 'zoom-status';
zoomStatus.innerHTML = '<span class="zoom-spinner" aria-hidden="true"></span><span class="zoom-label"></span>';
el.zoom.append(zoomBg, zoomIcon, zoomStatus);

/** Puts the zoom layers on the tile; returns the two "full screen" transforms. */
function prepareZoom(app: App, r: DOMRect): { bgFull: string; iconAtTile: string } {
  el.zoom.classList.remove('hidden', 'waiting');
  zoomBg.style.background = app.tile;
  Object.assign(zoomBg.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  zoomIcon.innerHTML = app.icon;
  zoomStatus.querySelector('.zoom-label')!.textContent = `Opening ${app.name}…`;
  const sx = innerWidth / r.width;
  const sy = innerHeight / r.height;
  const dx = innerWidth / 2 - (r.left + r.width / 2);
  const dy = innerHeight / 2 - (r.top + r.height / 2);
  return {
    bgFull: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
    // the icon layer is centred on the screen at ZOOM_ICON px; at the tile it is moved back and shrunk
    iconAtTile: `translate(${-dx}px, ${-dy}px) scale(${r.width / ZOOM_ICON})`,
  };
}

/** Zoom the tapped tile up to the whole screen while the app's page is already being fetched. */
function open(app: App, tile: HTMLElement): void {
  if (opening) return;
  opening = true;
  rememberApp(app.id);
  // feed.html continues this splash until the feed is set up (its inline script reads this)
  try {
    sessionStorage.setItem('streamanywhere.launch', JSON.stringify({ tile: app.tile, icon: app.icon, name: app.name }));
  } catch {
    /* storage unavailable: the app opens without the splash */
  }
  const go = () => location.assign(app.url);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
  const t = prepareZoom(app, tile.getBoundingClientRect());
  el.screen.classList.add('launching');
  const timing: KeyframeAnimationOptions = { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' };
  // transform and opacity only: both run on the compositor, smooth even while the next page loads
  zoomBg.animate(
    [
      { transform: 'translate(0, 0) scale(1)', borderRadius: '22.37%' },
      { transform: t.bgFull, borderRadius: '0%' },
    ],
    timing,
  );
  zoomIcon.animate([{ transform: t.iconAtTile }, { transform: 'translate(0, 0) scale(1)' }], timing);
  // the spinner fades in (CSS, delayed) in case the app takes a moment
  el.zoom.classList.add('waiting');
  // Ask for the page right away (the zoom is mostly done by the time the first bytes arrive),
  // instead of waiting for the animation to end.
  window.setTimeout(go, 120);
  // Still here long after the tap (the app's page never arrived): never hang on "Opening …".
  clearTimeout(stuckTimer);
  stuckTimer = window.setTimeout(() => launchStuck(app), 15_000);
}

/** The app's page has not replaced this one 15 s after the tap: say so, tap to try again, tell the server. */
let stuckTimer = 0;
function launchStuck(app: App): void {
  zoomStatus.querySelector('.zoom-label')!.textContent = `Opening ${app.name} is taking too long. Tap to try again.`;
  el.zoom.classList.add('stuck');
  el.zoom.onclick = () => location.assign(app.url);
  void api.report({
    kind: 'launch stuck',
    ok: false,
    connection: 'proxy',
    renderer: 'none',
    platform: app.platform?.id,
    detail: `still on the home screen 15 s after tapping ${app.name} (${app.url}); readyState ${document.readyState}, ${navigator.onLine ? 'online' : 'offline'}`,
    page: location.pathname,
    ua: navigator.userAgent,
  });
}

/** Coming back from an app: the full-screen tile shrinks back into its icon. */
function playReturn(): void {
  let from: string | null = null;
  try {
    from = sessionStorage.getItem('streamanywhere.returnFrom');
    sessionStorage.removeItem('streamanywhere.returnFrom');
  } catch {
    /* ignore */
  }
  const app = APPS.find((a) => a.id === from);
  const tile = app && el.grid.querySelector<HTMLElement>(`.app[data-app="${app.id}"] .tile`);
  if (!app || !tile || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t = prepareZoom(app, tile.getBoundingClientRect());
  const timing: KeyframeAnimationOptions = { duration: 360, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' };
  const anim = zoomBg.animate(
    [
      { transform: t.bgFull, borderRadius: '0%', opacity: 1, offset: 0 },
      { transform: 'translate(0, 0) scale(1)', borderRadius: '22.37%', opacity: 1, offset: 0.8 },
      { transform: 'translate(0, 0) scale(1)', borderRadius: '22.37%', opacity: 0, offset: 1 },
    ],
    timing,
  );
  zoomIcon.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0 },
      { transform: t.iconAtTile, opacity: 1, offset: 0.8 },
      { transform: t.iconAtTile, opacity: 0, offset: 1 },
    ],
    timing,
  );
  const done = () => el.zoom.classList.add('hidden');
  anim.addEventListener('finish', done);
  window.setTimeout(done, 600);
}

// Back-forward cache: a page restored from it keeps the "launching" state; undo it.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    opening = false;
    clearTimeout(stuckTimer);
    el.zoom.onclick = null;
    el.screen.classList.remove('launching');
    el.zoom.classList.remove('waiting', 'stuck');
    el.zoom.classList.add('hidden');
  }
});

/** Sign-in badges: one status request per platform (TikTok's may take a moment on a cold server). */
async function refreshBadges(): Promise<void> {
  await Promise.all(
    PLATFORMS.map(async (p) => {
      let s: SessionStatus | undefined;
      try {
        s = await api.session(p.id);
      } catch {
        s = undefined;
      }
      for (const b of badges.get(p.id) || []) {
        b.textContent = s?.state === 'logged_in' ? '✓' : s?.state === 'login_pending' ? '…' : '';
        b.classList.toggle('pending', s?.state === 'login_pending');
        b.title = s?.state === 'logged_in' ? `Signed in as @${s.username || '?'}` : s?.state === 'login_pending' ? 'Sign-in in progress' : '';
      }
    }),
  );
}

function tickClock(): void {
  el.clock.textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
tickClock();
window.setInterval(tickClock, 15_000);

// Arrow keys move between icons (the Tesla browser and desktops); Enter/Space opens (native button).
document.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const icons = [...el.grid.querySelectorAll<HTMLButtonElement>('.app')];
  const i = icons.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i <= 0 ? icons.length - 1 : i - 1) : i < 0 || i >= icons.length - 1 ? 0 : i + 1;
  icons[next]?.focus();
  e.preventDefault();
});

/**
 * While the home screen idles, fetch the app page's scripts and styles into the browser cache (the
 * server marks them immutable), so tapping an icon only has to wait for the page itself.
 */
function warmAppPage(): void {
  const page = new URL('feed.html', location.href);
  fetch(page.href, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      const seen = new Set<string>();
      for (const m of html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+\.(?:js|css))"/g)) {
        const href = new URL(m[1], page).href;
        if (seen.has(href)) continue;
        seen.add(href);
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = href;
        document.head.appendChild(link);
      }
    })
    .catch(() => undefined);
}

playReturn();
window.setTimeout(warmAppPage, 1200);
void refreshBadges();
window.setInterval(() => void refreshBadges(), 30_000);
