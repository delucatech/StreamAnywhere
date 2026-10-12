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
/** Zoom the tapped tile up to the whole screen, then navigate. */
function open(app: App, tile: HTMLElement): void {
  if (opening) return;
  opening = true;
  rememberApp(app.id);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    location.href = app.url;
    return;
  }
  const r = tile.getBoundingClientRect();
  const z = el.zoom;
  z.style.background = app.tile;
  z.innerHTML = app.icon;
  z.classList.remove('hidden');
  Object.assign(z.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: '22.37%', opacity: '1' });
  el.screen.classList.add('launching');
  // Grow from the tile's rectangle to the viewport (transform keeps it on the compositor).
  const sx = innerWidth / r.width;
  const sy = innerHeight / r.height;
  const dx = innerWidth / 2 - (r.left + r.width / 2);
  const dy = innerHeight / 2 - (r.top + r.height / 2);
  const anim = z.animate(
    [
      { transform: 'translate(0, 0) scale(1)', borderRadius: '22.37%' },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: '0%' },
    ],
    { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
  );
  const go = () => (location.href = app.url);
  anim.addEventListener('finish', go);
  window.setTimeout(go, 500); // in case 'finish' never fires (hidden tab)
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
  const r = tile.getBoundingClientRect();
  const z = el.zoom;
  z.style.background = app.tile;
  z.innerHTML = app.icon;
  z.classList.remove('hidden');
  Object.assign(z.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: '22.37%' });
  const sx = innerWidth / r.width;
  const sy = innerHeight / r.height;
  const dx = innerWidth / 2 - (r.left + r.width / 2);
  const dy = innerHeight / 2 - (r.top + r.height / 2);
  const anim = z.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: '0%', opacity: 1 },
      { transform: 'translate(0, 0) scale(1)', borderRadius: '22.37%', opacity: 1 },
      { transform: 'translate(0, 0) scale(1)', borderRadius: '22.37%', opacity: 0 },
    ],
    { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
  );
  const done = () => z.classList.add('hidden');
  anim.addEventListener('finish', done);
  window.setTimeout(done, 600);
}

// Back-forward cache: a page restored from it keeps the "launching" state; undo it.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    opening = false;
    el.screen.classList.remove('launching');
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

playReturn();
void refreshBadges();
window.setInterval(() => void refreshBadges(), 30_000);
