/**
 * Live TV (livetv.html): the channels of the providers set up in Settings (M3U playlists, Xtream
 * Codes accounts, the built-in community playlists), browsed by provider, group and search,
 * with favorites and what is on now from the programme guide; a tap plays the channel in the
 * theater (player.ts).
 *
 *  - Providers, favorites and the last channel live on the server (every browser of the site
 *    shares them; the page polls for changes). Favorites and the last channel are mirrored in
 *    localStorage so the page renders them before the server answers.
 *  - The channel list can run to thousands (iptv-org): the grid is rendered a page at a time
 *    ("Show more", and as the page is scrolled near the bottom), and "what is on now" is asked
 *    for the channels on screen only.
 *  - Settings (the gear): add / edit / delete / enable / test / refresh providers; presets.
 */
import type { LiveTvChannel, LiveTvPrefs, LiveTvPreset, LiveTvProgramme, LiveTvProvider, LiveTvProviderInput, LiveTvState } from '../../../shared/types';
import { api, ApiError } from '../api';
import { rememberApp } from '../platforms';
import { LiveTvPlayer } from './player';

(window as unknown as { streamAnywhereStarted: boolean }).streamAnywhereStarted = true;
rememberApp('livetv');

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const el = {
  splash: $('splash'),
  splashStatus: $('splashStatus'),
  titleIcon: $('titleIcon'),
  refreshBtn: $<HTMLButtonElement>('refreshBtn'),
  settingsBtn: $<HTMLButtonElement>('settingsBtn'),
  offline: $('offline'),
  cont: $('continue'),
  contLogo: $('continueLogo'),
  contName: $('continueName'),
  contNow: $('continueNow'),
  contBtn: $<HTMLButtonElement>('continueBtn'),
  search: $<HTMLInputElement>('search'),
  providerSel: $<HTMLSelectElement>('providerSel'),
  viewSeg: $('viewSeg'),
  favCount: $('favCount'),
  chips: $('chips'),
  status: $('status'),
  grid: $('grid'),
  moreRow: $('moreRow'),
  moreBtn: $<HTMLButtonElement>('moreBtn'),
  empty: $('empty'),
  settingsOverlay: $('settingsOverlay'),
  settingsClose: $<HTMLButtonElement>('settingsClose'),
  settingsBody: $('settingsBody'),
  formOverlay: $('formOverlay'),
  formTitle: $('formTitle'),
  formClose: $<HTMLButtonElement>('formClose'),
  formBody: $('formBody'),
  theater: $('theater'),
  toast: $('toast'),
};

const TV_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="18" height="12.5" rx="2.4" fill="none" stroke="#fff" stroke-width="1.9"/><path d="M8.5 2.8 12 6.5l3.5-3.7" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.6 10.2v5.2l4.4-2.6z" fill="#fff"/></svg>';
el.titleIcon.innerHTML = TV_ICON;
const STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.7z"/></svg>';
const STAR_ON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.7z"/></svg>';

// ---------------------------------------------------------------- helpers
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const errMsg = (e: unknown): string => (e instanceof ApiError ? e.message : (e as Error)?.message || String(e));
const timeAgo = (t: number): string => {
  const d = Date.now() - t;
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  return `${Math.round(d / 86400_000)} d ago`;
};
const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const n = (v: number): string => v.toLocaleString();
const initials = (name: string): string =>
  name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

let toastTimer = 0;
function toast(msg: string, isError = false, ms = 3800): void {
  el.toast.textContent = msg;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.remove('show'), ms);
}

function busy(btn: HTMLButtonElement, work: () => Promise<unknown>, label?: string): void {
  if (btn.classList.contains('busy')) return;
  const text = btn.textContent;
  btn.classList.add('busy');
  btn.disabled = true;
  if (label) btn.textContent = label;
  void work().finally(() => {
    btn.classList.remove('busy');
    btn.disabled = false;
    if (label) btn.textContent = text;
  });
}

// ---------------------------------------------------------------- state
const PREFS_KEY = 'streamanywhere.livetv.prefs';
const VIEW_KEY = 'streamanywhere.livetv.view';
let state: LiveTvState = { rev: 0, channelsRev: 0, providers: [], prefs: { favorites: [], hidden: [], broken: {} }, remux: false };
let channels: LiveTvChannel[] = [];
let channelsRev = -1;
let presets: LiveTvPreset[] = [];
let favorites = new Set<string>();
/** Channels hidden from the browser (server-side, every device) */
let hidden = new Set<string>();
/** Channel key -> when its last tune failed (server-side): ranked last in the All view */
let broken: Record<string, number> = {};
let lastKey: string | undefined;
/**
 * Logos that failed to load in this browser (key -> when), kept a week: a channel without a
 * working logo ranks after those with one in the All view, from the next render on.
 */
const BAD_LOGOS_KEY = 'streamanywhere.livetv.badlogos';
const BAD_LOGO_TTL = 7 * 86400_000;
let badLogos: Record<string, number> = {};
const view = { q: '', provider: 'all', group: 'all', favs: false };
let shown = 0;
const PAGE = 120;
let visible: LiveTvChannel[] = [];
/** now / next per channel key, as last fetched */
const nowMap = new Map<string, { now?: LiveTvProgramme; next?: LiveTvProgramme; at: number }>();
let offline = !navigator.onLine;

try {
  const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') as LiveTvPrefs | null;
  if (p) {
    favorites = new Set(p.favorites || []);
    hidden = new Set(p.hidden || []);
    broken = p.broken || {};
    lastKey = p.lastKey;
  }
  const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') as Partial<typeof view> | null;
  if (v) Object.assign(view, v);
  const bad = JSON.parse(localStorage.getItem(BAD_LOGOS_KEY) || 'null') as Record<string, number> | null;
  const cutoff = Date.now() - BAD_LOGO_TTL;
  if (bad) for (const [k, t] of Object.entries(bad)) if (typeof t === 'number' && t > cutoff) badLogos[k] = t;
} catch {
  /* no storage */
}
let badLogosTimer = 0;
function noteBadLogo(key: string): void {
  if (badLogos[key]) return;
  badLogos[key] = Date.now();
  window.clearTimeout(badLogosTimer);
  badLogosTimer = window.setTimeout(() => {
    // at most 3,000 entries: the oldest go first
    const entries = Object.entries(badLogos).sort((a, b) => b[1] - a[1]).slice(0, 3000);
    badLogos = Object.fromEntries(entries);
    try {
      localStorage.setItem(BAD_LOGOS_KEY, JSON.stringify(badLogos));
    } catch {
      /* ignore */
    }
  }, 1000);
}
const saveView = (): void => {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* ignore */
  }
};
const savePrefs = (): void => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ favorites: [...favorites], hidden: [...hidden], broken, lastKey } as LiveTvPrefs));
  } catch {
    /* ignore */
  }
};

const providerById = (id: string): LiveTvProvider | undefined => state.providers.find((p) => p.id === id);
/** Any of a channel's keys (its sources, the same stream listed by another provider) -> the channel */
let byKey = new Map<string, LiveTvChannel>();
const isFav = (c: LiveTvChannel): boolean => c.keys.some((k) => favorites.has(k));
const isHidden = (c: LiveTvChannel): boolean => c.keys.some((k) => hidden.has(k));
/** "Did not play last time": every stream of it failed (one working source is enough) */
const isBroken = (c: LiveTvChannel): boolean => c.sources.every((s) => broken[s.key]);
const channelByKey = (key: string | undefined): LiveTvChannel | undefined => {
  const c = key ? byKey.get(key) : undefined;
  return c && !isHidden(c) ? c : undefined;
};
/** The order of the All view: channels that did not play last time last, those without a working logo before them */
const rankOf = (c: LiveTvChannel): number => (isBroken(c) ? 2 : !c.logo || badLogos[c.key] ? 1 : 0);
const anyRefreshRunning = (): boolean => state.providers.some((p) => p.refresh.state === 'running' || p.epg.state === 'running');

// ---------------------------------------------------------------- the player
const player = new LiveTvPlayer(el.theater, {
  onClose: () => render(),
  onChannel: (ch) => {
    lastKey = ch.key;
    savePrefs();
    void api.liveTvPrefs({ lastKey: ch.key }).catch(() => undefined);
    renderContinue();
    for (const b of el.grid.querySelectorAll<HTMLElement>('.ch')) b.classList.toggle('playing', b.dataset.key === ch.key);
  },
  onFavorite: (ch, on) => void setFavorite(ch, on),
  isFavorite: (ch) => isFav(ch),
  isBroken: (key) => !!broken[key],
  onHide: (ch) => void setHidden(ch, true),
  onTuned: (ch, key, ok) => {
    // the server keeps this too; the tile dims (or brightens) right away
    if (ok) delete broken[key];
    else broken[key] = Date.now();
    savePrefs();
    const tile = el.grid.querySelector<HTMLElement>(`.ch[data-key="${CSS.escape(ch.key)}"]`);
    if (tile) {
      const dim = isBroken(ch);
      tile.classList.toggle('dim', dim);
      tile.title = dim ? BROKEN_TITLE : '';
    }
  },
  providerName: (ch) => (state.providers.length > 1 ? providerById(ch.providerId)?.name || '' : ''),
  guide: (key) => api.liveTvGuide(key),
  nowNext: async (key) => {
    const r = await api.liveTvGuideNow([key]);
    const nn = r.now[key] || {};
    nowMap.set(key, { ...nn, at: Date.now() });
    return nn;
  },
});

const BROKEN_TITLE = 'Did not play last time';

/** A favorite is kept under the channel's first key; taking it off clears every key of the channel (lists made before the merge) */
async function setFavorite(c: LiveTvChannel, on: boolean): Promise<void> {
  const keys = on ? [c.key] : c.keys.filter((k) => favorites.has(k));
  if (on) {
    favorites.add(c.key);
    for (const k of c.keys) hidden.delete(k);
  } else for (const k of keys) favorites.delete(k);
  savePrefs();
  renderFavButtons();
  if (view.favs) render();
  try {
    let p: LiveTvPrefs | undefined;
    for (const key of keys) p = await api.liveTvPrefs({ favorite: { key, on } });
    if (p) favorites = new Set(p.favorites);
    savePrefs();
    renderFavButtons();
  } catch (e) {
    toast(errMsg(e), true);
  }
}

/** Hides a channel from the browser (every key of it, or shows it again); the server keeps the list for every device. */
async function setHidden(c: LiveTvChannel, on: boolean): Promise<void> {
  const keys = on ? c.keys : c.keys.filter((k) => hidden.has(k));
  for (const k of keys) {
    if (on) {
      hidden.add(k);
      favorites.delete(k);
    } else hidden.delete(k);
  }
  savePrefs();
  render();
  if (!el.settingsOverlay.classList.contains('hidden')) renderSettings();
  if (on) toast('Channel hidden: Settings lists the hidden channels');
  try {
    let p: LiveTvPrefs | undefined;
    for (const key of keys) p = await api.liveTvPrefs({ hidden: { key, on } });
    if (p) applyPrefs(p);
  } catch (e) {
    toast(errMsg(e), true);
  }
}

function applyPrefs(p: LiveTvPrefs): void {
  favorites = new Set(p.favorites);
  hidden = new Set(p.hidden || []);
  broken = p.broken || {};
  if (p.lastKey) lastKey = p.lastKey;
  savePrefs();
}

/** All / Favorites: which is on, and how many favorites there are among the channels loaded */
function renderViewSeg(): void {
  for (const b of el.viewSeg.querySelectorAll<HTMLElement>('[data-view]')) {
    const on = (b.dataset.view === 'favs') === view.favs;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  const count = channels.reduce((a, c) => a + (favorites.has(c.key) ? 1 : 0), 0);
  el.favCount.textContent = count ? n(count) : '';
}

function renderFavButtons(): void {
  renderViewSeg();
  for (const b of el.grid.querySelectorAll<HTMLElement>('.ch')) {
    const c = byKey.get(b.dataset.key || '');
    const on = !!c && isFav(c);
    const fav = b.querySelector<HTMLElement>('.ch-fav');
    if (fav) {
      fav.classList.toggle('on', on);
      fav.innerHTML = on ? STAR_ON : STAR;
    }
  }
  player.refreshFavorite();
}

// ---------------------------------------------------------------- sync with the server
let pollTimer = 0;
let polling = false;

// ---------------------------------------------------------------- the first load, told as it goes
/**
 * Where the page's start stands: the splash (and the empty channel area) say what is being
 * waited for, with the seconds ticking, so a slow server (the small VM is busy at times) never
 * looks like a frozen tile. `error` is the last failed attempt's reason, shown with "Try again".
 */
const boot: { phase: 'connect' | 'channels' | 'done'; at: number; error?: string; timer: number } = { phase: 'connect', at: Date.now(), timer: 0 };

function bootText(): { text: string; detail: string } {
  const sec = Math.round((Date.now() - boot.at) / 1000);
  if (boot.error) return { text: `The server did not answer: ${boot.error}`, detail: offline ? 'You are offline.' : 'Tap to try again.' };
  const text = boot.phase === 'connect' ? (sec < 2 ? 'Connecting to the server…' : `Connecting to the server… ${sec} s`) : `Loading the channel list… ${sec} s`;
  const detail = sec >= 10 ? 'The server is slow to answer; it may be busy. Still waiting…' : '';
  return { text, detail };
}

function renderBoot(): void {
  const { text, detail } = bootText();
  el.splashStatus.innerHTML = `${esc(text)}${detail ? `<small>${esc(detail)}</small>` : ''}`;
  el.splash.classList.toggle('retry', !!boot.error);
  if (!channels.length) renderEmpty();
}

/** The splash leaves (the server answered, or gave up); the list area carries on with the status. */
function leaveSplash(): void {
  if (el.splash.classList.contains('leaving') || el.splash.classList.contains('hidden')) return;
  el.splash.classList.add('leaving');
  window.setTimeout(() => el.splash.classList.add('hidden'), 320);
}

function setBoot(phase: typeof boot.phase, error?: string): void {
  boot.phase = phase;
  boot.error = error;
  if (phase === 'done') {
    window.clearInterval(boot.timer);
    boot.timer = 0;
    leaveSplash();
    renderEmpty();
    return;
  }
  if (!boot.timer) boot.timer = window.setInterval(renderBoot, 1000);
  renderBoot();
}
el.splash.addEventListener('click', () => {
  if (!boot.error) return;
  boot.at = Date.now();
  setBoot('connect');
  void sync();
});

async function sync(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const r = await api.liveTv(state.rev || undefined);
    if (!('unchanged' in r)) {
      state = r;
      applyPrefs(r.prefs);
      renderProviders();
      if (!el.settingsOverlay.classList.contains('hidden')) renderSettings();
    }
    const cr = 'unchanged' in r ? r.channelsRev : r.channelsRev;
    if (cr !== channelsRev) {
      if (boot.phase !== 'done') {
        // the server is there: the providers are known, the (large) channel list is next
        setBoot('channels');
        leaveSplash();
      }
      const c = await api.liveTvChannels();
      if (!('unchanged' in c)) {
        // an older server build (mid-deploy) answers without `groups`, `sources` or `keys`
        channels = c.channels.map((ch) => ({
          ...ch,
          groups: Array.isArray(ch.groups) ? ch.groups : ch.group ? [ch.group] : [],
          sources: Array.isArray(ch.sources) && ch.sources.length ? ch.sources : [{ key: ch.key, providerId: ch.providerId, name: ch.name }],
          keys: Array.isArray(ch.keys) && ch.keys.length ? ch.keys : [ch.key],
        }));
        byKey = new Map();
        for (const ch of channels) for (const k of ch.keys) byKey.set(k, ch);
        channelsRev = c.channelsRev;
        player.setItems(visible);
        render();
      }
    } else if (!('unchanged' in r)) render();
    if (boot.phase !== 'done') setBoot('done');
    setOffline(false);
  } catch (e) {
    if (e instanceof TypeError) setOffline(true);
    else if (e instanceof ApiError && e.status !== 401) toast(errMsg(e), true);
    if (boot.phase !== 'done') setBoot(boot.phase, e instanceof TypeError ? (offline ? 'no connection' : 'the request failed (the connection dropped?)') : errMsg(e));
  } finally {
    polling = false;
    schedulePoll();
  }
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  const fast = anyRefreshRunning() || !el.settingsOverlay.classList.contains('hidden');
  pollTimer = window.setTimeout(() => void sync(), document.hidden ? 60_000 : fast ? 3000 : 30_000);
}

function setOffline(v: boolean): void {
  offline = v;
  el.offline.classList.toggle('hidden', !v);
}
window.addEventListener('online', () => void sync());
window.addEventListener('offline', () => setOffline(true));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void sync();
});

// ---------------------------------------------------------------- rendering
function renderProviders(): void {
  const cur = view.provider;
  const opts = ['<option value="all">All providers</option>'];
  for (const p of state.providers) opts.push(`<option value="${esc(p.id)}"${p.enabled ? '' : ' disabled'}>${esc(p.name)}${p.enabled ? '' : ' (off)'}</option>`);
  el.providerSel.innerHTML = opts.join('');
  el.providerSel.value = state.providers.some((p) => p.id === cur && p.enabled) ? cur : 'all';
  if (el.providerSel.value !== cur) {
    view.provider = el.providerSel.value;
    saveView();
  }
  el.providerSel.classList.toggle('hidden', state.providers.length < 2);
  el.refreshBtn.classList.toggle('busy', anyRefreshRunning());
}

function filtered(): LiveTvChannel[] {
  const q = view.q.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const list = channels.filter((c) => {
    if (isHidden(c)) return false;
    if (view.provider !== 'all' && !c.sources.some((s) => s.providerId === view.provider)) return false;
    if (view.favs && !isFav(c)) return false;
    if (view.group !== 'all' && !c.groups.includes(view.group)) return false;
    if (words.length) {
      const hay = `${c.name} ${c.groups.join(' ')} ${c.number || ''}`.toLowerCase();
      for (const w of words) if (!hay.includes(w)) return false;
    }
    return true;
  });
  // Favorites keep the provider's order; the All view puts the channels most likely to play
  // (and to look right) first: working logo, then no logo, then "did not play last time"
  if (!view.favs) list.sort((a, b) => rankOf(a) - rankOf(b));
  return list;
}

function renderChips(): void {
  // the groups of the channels that pass the other filters (provider, favorites, search);
  // a channel in several groups counts in each of them
  const counts = new Map<string, number>();
  const q = view.q.trim().toLowerCase();
  let total = 0;
  for (const c of channels) {
    if (isHidden(c)) continue;
    if (view.provider !== 'all' && !c.sources.some((s) => s.providerId === view.provider)) continue;
    if (view.favs && !isFav(c)) continue;
    if (q && !`${c.name} ${c.groups.join(' ')}`.toLowerCase().includes(q)) continue;
    total++;
    if (!c.groups.length) counts.set('', (counts.get('') || 0) + 1);
    for (const g of c.groups) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 250);
  if (view.group !== 'all' && !counts.has(view.group)) view.group = 'all';
  const chip = (id: string, label: string, count: number): string => `<button type="button" class="chip${view.group === id ? ' on' : ''}" role="radio" aria-checked="${view.group === id}" data-group="${esc(id)}">${esc(label)} <small>${n(count)}</small></button>`;
  el.chips.innerHTML = chip('all', 'All', total) + groups.map(([g, c]) => chip(g, g || 'Ungrouped', c)).join('');
  el.chips.classList.toggle('hidden', groups.length < 2);
}

function tileHtml(c: LiveTvChannel): string {
  const fav = isFav(c);
  const prov = state.providers.length > 1 ? providerById(c.providerId)?.name : '';
  const sub = [...c.groups, prov, c.sources.length > 1 ? `${c.sources.length} streams` : ''].filter(Boolean).join(' · ');
  const dim = isBroken(c);
  return `<button type="button" class="ch${player.current?.key === c.key ? ' playing' : ''}${dim ? ' dim' : ''}" data-key="${esc(c.key)}" aria-label="Play ${esc(c.name)}"${dim ? ` title="${BROKEN_TITLE}"` : ''}>
    <span class="ch-logo">${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" draggable="false" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'initials',textContent:this.dataset.i}))" data-i="${esc(initials(c.name))}" />` : `<span class="initials">${esc(initials(c.name))}</span>`}
      ${c.number ? `<span class="ch-num">${c.number}</span>` : ''}${c.drm ? '<span class="ch-drm">DRM</span>' : ''}
      <span class="ch-fav${fav ? ' on' : ''}" role="button" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" data-fav="${esc(c.key)}">${fav ? STAR_ON : STAR}</span>
    </span>
    <span class="ch-body"><span class="ch-name">${esc(c.name)}</span><span class="ch-sub">${esc(sub)}</span><span class="ch-now" data-now="${esc(c.key)}"></span></span>
  </button>`;
}

function render(): void {
  renderViewSeg();
  renderChips();
  visible = filtered();
  player.setItems(visible);
  shown = Math.min(Math.max(shown, PAGE), visible.length);
  if (shown === 0) shown = Math.min(PAGE, visible.length);
  el.grid.innerHTML = visible.slice(0, shown).map(tileHtml).join('');
  el.moreRow.classList.toggle('hidden', shown >= visible.length);
  el.moreBtn.textContent = `Show more (${n(visible.length - shown)} left)`;
  renderEmpty();
  renderContinue();
  renderStatus();
  void fetchNowFor(visible.slice(0, shown));
}

function appendMore(): void {
  const from = shown;
  shown = Math.min(shown + PAGE, visible.length);
  el.grid.insertAdjacentHTML('beforeend', visible.slice(from, shown).map(tileHtml).join(''));
  el.moreRow.classList.toggle('hidden', shown >= visible.length);
  el.moreBtn.textContent = `Show more (${n(visible.length - shown)} left)`;
  void fetchNowFor(visible.slice(from, shown));
}

function renderEmpty(): void {
  let html = '';
  if (boot.phase !== 'done') {
    // the first load: what is being waited for (the seconds tick), or why it failed
    const { text, detail } = bootText();
    html = boot.error
      ? `<p><b>${esc(text)}</b>${offline ? '<br />You are offline.' : ''}</p><button type="button" class="btn primary" id="emptyRetry">Try again</button>`
      : `<p><span class="spinner"></span> ${esc(text)}${detail ? `<br /><small>${esc(detail)}</small>` : ''}</p>`;
  } else if (!state.providers.length) html = `<p><b>No providers yet.</b><br />Add an M3U playlist, an Xtream Codes account, or one of the free community playlists.</p><button type="button" class="btn primary" id="emptySettings">Open Settings</button>`;
  else if (!channels.length) {
    const running = state.providers.find((p) => p.refresh.state === 'running');
    const failed = state.providers.filter((p) => p.refresh.state === 'error');
    const enabled = state.providers.some((p) => p.enabled);
    if (running) html = `<p><span class="spinner"></span> Loading the channels of <b>${esc(running.name)}</b>…</p>`;
    else if (!enabled) html = `<p>Every provider is turned off. Turn one on in Settings.</p>`;
    else if (failed.length) html = `<p><b>${esc(failed[0].name)}</b> could not be loaded: ${esc(failed[0].refresh.error || '')}</p><button type="button" class="btn" id="emptySettings">Open Settings</button>`;
    else html = `<p>No channels yet.</p>`;
  } else if (!visible.length) html = view.favs && !favorites.size ? '<p><b>No favorites yet.</b><br />Tap the star on a channel to keep it here.</p>' : '<p>No channel matches.</p>';
  el.empty.innerHTML = html;
  el.empty.classList.toggle('hidden', !html);
  el.empty.querySelector('#emptySettings')?.addEventListener('click', () => openSettings());
  el.empty.querySelector('#emptyRetry')?.addEventListener('click', () => {
    boot.at = Date.now();
    setBoot('connect');
    void sync();
  });
}

function renderStatus(): void {
  const running = state.providers.filter((p) => p.refresh.state === 'running');
  const epg = state.providers.filter((p) => p.epg.state === 'running');
  let text = '';
  let cls = 'status';
  if (running.length) text = `<span class="spinner"></span> Loading the channels of ${esc(running.map((p) => p.name).join(', '))}…`;
  else if (epg.length) text = `<span class="spinner"></span> Loading the programme guide of ${esc(epg.map((p) => p.name).join(', '))}…`;
  else {
    const failed = state.providers.filter((p) => p.enabled && p.refresh.state === 'error');
    if (failed.length) {
      text = `${esc(failed[0].name)} could not be refreshed: ${esc(failed[0].refresh.error || '')}`;
      cls = 'status error';
    }
  }
  el.status.className = cls;
  el.status.innerHTML = text;
  el.status.classList.toggle('hidden', !text);
}

function renderContinue(): void {
  const c = channelByKey(lastKey);
  const show = !!c && !player.isOpen;
  el.cont.classList.toggle('hidden', !show);
  if (!c || !show) return;
  el.contLogo.innerHTML = c.logo ? `<img src="${esc(c.logo)}" alt="" />` : `<span class="initials">${esc(initials(c.name))}</span>`;
  el.contName.textContent = c.name;
  const nn = nowMap.get(c.key);
  el.contNow.textContent = nn?.now ? `Now: ${nn.now.title}` : c.group;
}

// "what is on now" for the tiles on screen, in batches; refreshed every minute while the page is visible
let nowTimer = 0;
async function fetchNowFor(list: LiveTvChannel[]): Promise<void> {
  const stale = Date.now() - 60_000;
  const keys = list.filter((c) => (nowMap.get(c.key)?.at || 0) < stale).map((c) => c.key);
  if (!keys.length) return paintNow();
  let loading = false;
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    try {
      const r = await api.liveTvGuideNow(batch);
      for (const k of batch) nowMap.set(k, { ...(r.now[k] || {}), at: Date.now() });
      loading ||= r.loading;
    } catch {
      return;
    }
  }
  paintNow();
  if (loading) {
    window.clearTimeout(nowTimer);
    nowTimer = window.setTimeout(() => {
      for (const k of keys) nowMap.delete(k);
      void fetchNowFor(list);
    }, 5000);
  }
}
function paintNow(): void {
  const now = Date.now();
  for (const span of el.grid.querySelectorAll<HTMLElement>('[data-now]')) {
    const nn = nowMap.get(span.dataset.now || '');
    const prog = nn?.now;
    if (!prog) {
      span.textContent = '';
      span.nextElementSibling?.remove();
      continue;
    }
    span.textContent = prog.title;
    span.title = `${prog.title} (${fmtClock(prog.start)} – ${fmtClock(prog.stop)})${nn.next ? `\nNext: ${nn.next.title}` : ''}`;
    const pct = Math.max(0, Math.min(100, ((now - prog.start) / (prog.stop - prog.start)) * 100));
    let bar = span.nextElementSibling as HTMLElement | null;
    if (!bar || !bar.classList.contains('ch-bar')) {
      bar = document.createElement('span');
      bar.className = 'ch-bar';
      bar.innerHTML = '<i></i>';
      span.after(bar);
    }
    (bar.firstElementChild as HTMLElement).style.width = `${pct.toFixed(1)}%`;
  }
  renderContinue();
}
window.setInterval(() => {
  if (!document.hidden && channels.length) void fetchNowFor(visible.slice(0, shown));
}, 60_000);

// ---------------------------------------------------------------- interactions
el.search.value = view.q;
el.search.addEventListener('input', () => {
  view.q = el.search.value;
  shown = 0;
  saveView();
  render();
});
el.providerSel.addEventListener('change', () => {
  view.provider = el.providerSel.value;
  view.group = 'all';
  shown = 0;
  saveView();
  render();
});
el.viewSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-view]');
  if (!b) return;
  const favs = b.dataset.view === 'favs';
  if (favs === view.favs) return;
  view.favs = favs;
  shown = 0;
  saveView();
  render();
});
el.chips.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-group]');
  if (!b) return;
  view.group = b.dataset.group!;
  shown = 0;
  saveView();
  render();
});
el.moreBtn.addEventListener('click', appendMore);
// a logo that fails to load (error events do not bubble: captured) is remembered for the ranking
el.grid.addEventListener(
  'error',
  (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'IMG') return;
    const key = t.closest<HTMLElement>('.ch')?.dataset.key;
    if (key) noteBadLogo(key);
  },
  true,
);
window.addEventListener('scroll', () => {
  if (el.moreRow.classList.contains('hidden')) return;
  if (window.innerHeight + window.scrollY > document.body.offsetHeight - 900) appendMore();
}, { passive: true });
el.grid.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const fav = t.closest<HTMLElement>('[data-fav]');
  if (fav) {
    e.stopPropagation();
    const c = byKey.get(fav.dataset.fav!);
    if (c) void setFavorite(c, !isFav(c));
    return;
  }
  const tile = t.closest<HTMLElement>('.ch');
  if (!tile) return;
  const i = visible.findIndex((c) => c.key === tile.dataset.key);
  if (i >= 0) player.open(visible, i);
});
el.contBtn.addEventListener('click', () => {
  const i = visible.findIndex((c) => c.key === lastKey);
  if (i >= 0) return player.open(visible, i);
  const c = channelByKey(lastKey);
  if (c) player.open([c, ...visible.filter((x) => x.key !== c.key)], 0);
});
el.refreshBtn.addEventListener('click', () => {
  busy(el.refreshBtn, async () => {
    const enabled = state.providers.filter((p) => p.enabled && p.refresh.state !== 'running');
    if (!enabled.length) return toast('No provider to refresh');
    for (const p of enabled) {
      try {
        state = await api.liveTvRefreshProvider(p.id);
      } catch (e) {
        toast(errMsg(e), true);
      }
    }
    renderProviders();
    renderStatus();
    schedulePoll();
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !player.isOpen && (e.target as HTMLElement).tagName !== 'INPUT') {
    e.preventDefault();
    el.search.focus();
  }
});

// ---------------------------------------------------------------- Settings: providers
function openSettings(): void {
  el.settingsOverlay.classList.remove('hidden');
  document.body.classList.add('sheet-open');
  renderSettings();
  if (!presets.length) void api.liveTvPresets().then((r) => {
    presets = r.presets;
    renderSettings();
  }).catch(() => undefined);
  schedulePoll();
}
function closeSettings(): void {
  el.settingsOverlay.classList.add('hidden');
  if (el.formOverlay.classList.contains('hidden')) document.body.classList.remove('sheet-open');
  schedulePoll();
}
el.settingsBtn.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', closeSettings);
el.settingsOverlay.addEventListener('click', (e) => {
  if (e.target === el.settingsOverlay) closeSettings();
});

function providerStatus(p: LiveTvProvider): { text: string; cls: string } {
  const r = p.refresh;
  if (r.state === 'running') return { text: 'Loading the channel list…', cls: 'run' };
  if (r.state === 'error') return { text: `Could not load: ${r.error || 'unknown error'}${r.at ? ` (${timeAgo(r.at)})` : ''}`, cls: 'err' };
  if (r.state === 'never') return { text: 'Not loaded yet', cls: '' };
  const parts = [`${n(r.channels)} channels in ${n(r.groups)} groups`, `refreshed ${timeAgo(r.at || 0)}`];
  if (p.epg.state === 'running') parts.push('guide loading…');
  else if (p.epg.state === 'ok') parts.push(`guide: ${n(p.epg.channels)} channels, ${n(p.epg.programmes)} programmes`);
  else if (p.epg.state === 'error') parts.push(`guide failed: ${p.epg.error}`);
  else if (p.epgSource === 'none') parts.push('no guide');
  if (p.account?.expiresAt) parts.push(`account until ${new Date(p.account.expiresAt).toLocaleDateString()}`);
  return { text: parts.join(' · '), cls: '' };
}

function renderSettings(): void {
  const rows = state.providers.map((p) => {
    const s = providerStatus(p);
    return `<div class="prov${p.enabled ? '' : ' off'}" data-prov="${esc(p.id)}">
      <div class="prov-head"><span class="prov-name">${esc(p.name)}</span><span class="kind ${p.kind}">${p.kind === 'xtream' ? 'XTREAM' : p.preset ? 'PRESET' : 'M3U'}</span>
        <button type="button" class="toggle small${p.enabled ? ' on' : ''}" data-prov-act="toggle" aria-pressed="${p.enabled}" title="${p.enabled ? 'Turn off' : 'Turn on'}"><span class="toggle-dot" aria-hidden="true"></span>${p.enabled ? 'On' : 'Off'}</button></div>
      <div class="prov-status ${s.cls}">${esc(s.text)}</div>
      <div class="prov-actions"><button type="button" class="btn small" data-prov-act="test">Test</button><button type="button" class="btn small" data-prov-act="refresh"${p.refresh.state === 'running' ? ' disabled' : ''}>Refresh channels</button><button type="button" class="btn small" data-prov-act="edit">Edit</button><button type="button" class="btn small ghost danger-text" data-prov-act="delete">Delete</button></div>
      <div class="prov-status hidden" data-test-result></div>
    </div>`;
  });
  const have = new Set(state.providers.map((p) => p.preset).filter(Boolean));
  const bySource = new Map<string, LiveTvPreset[]>();
  for (const p of presets) bySource.set(p.source, [...(bySource.get(p.source) || []), p]);
  const presetHtml = [...bySource.entries()]
    .map(
      ([source, list]) => `<p class="sh-section">${esc(source)}</p>` +
        list
          .map(
            (p) => `<div class="preset"><div class="preset-text"><div class="preset-name">${esc(p.name)}${p.approxChannels ? ` <small class="muted">~${n(p.approxChannels)} channels</small>` : ''}</div><div class="preset-desc">${esc(p.description)}${p.epgUrl ? ' Includes a programme guide.' : ''}</div></div>
              <button type="button" class="btn small${have.has(p.id) ? '' : ' primary'}" data-preset="${esc(p.id)}"${have.has(p.id) ? ' disabled' : ''}>${have.has(p.id) ? 'Added' : 'Add'}</button></div>`,
          )
          .join(''),
    )
    .join('');
  const playbackNote = state.remux
    ? `Channels are recorded by the server (the last 30 minutes) and drawn on a canvas by ${esc(player.rendererName)}, no video element: pause as long as you like, drag the bar or use ← → to go back, LIVE jumps to now.`
    : 'This server has no ffmpeg, which turns live streams into what the page can decode: live channels cannot play here until it is installed.';
  // one row per channel, whichever of its keys the hidden list names
  const hiddenRows = [...new Set([...hidden].map((key) => byKey.get(key)).filter((c): c is LiveTvChannel => !!c))]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (c) => `<div class="preset"><div class="preset-text"><div class="preset-name">${esc(c.name)}</div><div class="preset-desc">${esc([...c.groups, state.providers.length > 1 ? providerById(c.providerId)?.name || '' : ''].filter(Boolean).join(' · '))}</div></div>
        <button type="button" class="btn small" data-unhide="${esc(c.key)}">Show</button></div>`,
    );
  const hiddenHtml = hiddenRows.length
    ? `<p class="sh-section">Hidden channels <small class="muted">${n(hiddenRows.length)}</small></p>
       <p class="sh-note">Hidden on every device, out of every view and search. The eye button in the player (or the H key) hides the channel playing.</p>
       ${hiddenRows.join('')}
       <div class="sh-actions"><button type="button" class="btn small" data-unhide-all>Show all again</button></div>`
    : '';
  el.settingsBody.innerHTML = `
    <p class="sh-section">Playback</p>
    <div class="prov${state.remux ? '' : ' off'}">
      <div class="prov-head"><span class="prov-name">Pause and rewind</span><span class="kind ${state.remux ? 'm3u' : 'xtream'}">${state.remux ? 'ON' : 'NO FFMPEG'}</span></div>
      <div class="prov-status">${playbackNote}</div>
    </div>
    ${hiddenHtml}
    <p class="sh-section">Providers</p>
    ${rows.join('') || '<p class="sh-note">No providers yet. Add your own playlist or Xtream account below, or one of the community playlists.</p>'}
    <div class="sh-actions"><button type="button" class="btn small primary" data-add="m3u">Add M3U playlist</button><button type="button" class="btn small primary" data-add="xtream">Add Xtream Codes</button></div>
    <p class="sh-note">Channel lists refresh by themselves every 12 hours (and their guides with them); the refresh button at the top, or Refresh channels here, does it now. Providers and their credentials are kept on the server, encrypted, for every browser of this site; passwords never come back to the page or into the log. Streams are relayed by the server, so the provider sees the server, not your device.</p>
    <p class="sh-section">Community playlists (free)</p>
    <p class="sh-note">Public lists maintained by volunteers: which channels are up, geo-blocked, or in a format this browser plays changes all the time. ${presets.length ? '' : '<span class="spinner small"></span>Loading…'}</p>
    ${presetHtml}`;
}

el.settingsBody.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const add = t.closest<HTMLElement>('[data-add]');
  if (add) return openForm(add.dataset.add as 'm3u' | 'xtream');
  const unhide = t.closest<HTMLElement>('[data-unhide]');
  if (unhide) {
    const c = byKey.get(unhide.dataset.unhide!);
    if (c) void setHidden(c, false);
    return;
  }
  if (t.closest('[data-unhide-all]')) {
    hidden.clear();
    savePrefs();
    render();
    renderSettings();
    try {
      applyPrefs(await api.liveTvPrefs({ unhideAll: true }));
    } catch (err) {
      toast(errMsg(err), true);
    }
    return;
  }
  const pre = t.closest<HTMLButtonElement>('[data-preset]');
  if (pre) {
    const preset = presets.find((p) => p.id === pre.dataset.preset);
    if (!preset) return;
    return busy(pre, async () => {
      try {
        const r = await api.liveTvAddProvider({ preset: preset.id, name: preset.name });
        state = r.state;
        toast(`${preset.name} added; loading its channels…`);
        renderProviders();
        renderSettings();
        render();
        schedulePoll();
      } catch (err) {
        toast(errMsg(err), true);
      }
    }, 'Adding…');
  }
  const b = t.closest<HTMLButtonElement>('[data-prov-act]');
  if (!b) return;
  const row = b.closest<HTMLElement>('.prov')!;
  const p = providerById(row.dataset.prov!);
  if (!p) return;
  const act = b.dataset.provAct;
  try {
    if (act === 'toggle') {
      state = (await api.liveTvUpdateProvider(p.id, { enabled: !p.enabled })).state;
      renderSettings();
      renderProviders();
      channelsRev = -1;
      void sync();
    } else if (act === 'refresh') {
      state = await api.liveTvRefreshProvider(p.id);
      renderSettings();
      renderProviders();
      renderStatus();
      schedulePoll();
    } else if (act === 'edit') openForm(p.kind, p);
    else if (act === 'delete') {
      if (!confirm(`Delete “${p.name}”? Its channels and favorites go with it.`)) return;
      state = await api.liveTvDeleteProvider(p.id);
      renderSettings();
      renderProviders();
      channelsRev = -1;
      void sync();
    } else if (act === 'test') {
      const out = row.querySelector<HTMLElement>('[data-test-result]')!;
      out.className = 'prov-status run';
      out.innerHTML = '<span class="spinner small"></span>Testing the connection…';
      out.classList.remove('hidden');
      busy(b, async () => {
        try {
          const r = await api.liveTvTest({ id: p.id });
          out.className = `prov-status ${r.ok ? '' : 'err'}`;
          out.textContent = `${r.ok ? '✓' : '✕'} ${r.message} (${(r.elapsedMs / 1000).toFixed(1)} s)`;
        } catch (err) {
          out.className = 'prov-status err';
          out.textContent = errMsg(err);
        }
      }, 'Testing…');
    }
  } catch (err) {
    toast(errMsg(err), true);
  }
});

// ---------------------------------------------------------------- the provider form (add / edit)
let formKind: 'm3u' | 'xtream' = 'm3u';
let editing: LiveTvProvider | undefined;

function openForm(kind: 'm3u' | 'xtream', p?: LiveTvProvider): void {
  formKind = kind;
  editing = p;
  el.formTitle.textContent = p ? `Edit ${p.name}` : kind === 'xtream' ? 'Add an Xtream Codes provider' : 'Add an M3U playlist';
  renderForm();
  el.formOverlay.classList.remove('hidden');
  document.body.classList.add('sheet-open');
  el.formBody.querySelector<HTMLInputElement>('input')?.focus();
}
function closeForm(): void {
  el.formOverlay.classList.add('hidden');
  if (el.settingsOverlay.classList.contains('hidden')) document.body.classList.remove('sheet-open');
}
el.formClose.addEventListener('click', closeForm);
el.formOverlay.addEventListener('click', (e) => {
  if (e.target === el.formOverlay) closeForm();
});

function renderForm(): void {
  const p = editing;
  const field = (id: string, label: string, type: string, value: string, placeholder: string, extra = ''): string => `<div class="field"><label for="f_${id}">${label}</label><input id="f_${id}" name="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" ${extra} /></div>`;
  const kinds = p ? '' : `<div class="kinds"><button type="button" class="chip${formKind === 'm3u' ? ' on' : ''}" data-kind="m3u">M3U / M3U8 playlist</button><button type="button" class="chip${formKind === 'xtream' ? ' on' : ''}" data-kind="xtream">Xtream Codes</button></div>`;
  const body =
    formKind === 'm3u'
      ? field('name', 'Name', 'text', p?.name || '', 'My playlist', 'maxlength="80" required') +
        (p?.preset ? `<p class="sh-note">A built-in community playlist: its URL is fixed.</p>` : field('url', 'Playlist URL (M3U / M3U8)', 'url', p?.url || '', 'https://provider.example/get.php?username=…&type=m3u_plus', 'required inputmode="url"'))
      : field('name', 'Name', 'text', p?.name || '', 'My IPTV', 'maxlength="80" required') +
        field('server', 'Server URL', 'text', p?.server || '', 'http://host:8080', 'required inputmode="url"') +
        field('username', 'Username', 'text', p?.username || '', '', 'required') +
        field('password', p ? 'Password (leave empty to keep the saved one)' : 'Password', 'password', '', '', p ? '' : 'required');
  el.formBody.innerHTML = `<form id="provForm" autocomplete="off">${kinds}${body}
    ${field('epgUrl', 'Programme guide URL (XMLTV, optional)', 'url', p?.epgUrl || '', formKind === 'xtream' ? 'Leave empty to use the panel’s own guide' : 'https://…/guide.xml.gz', 'inputmode="url"')}
    <p class="sh-note">${formKind === 'xtream' ? 'The panel address, username and password your provider gave you. The password is stored encrypted on the server and never shown again.' : 'The playlist is fetched by the server and kept; its channels are refreshed every 12 hours and on demand. A guide named inside the playlist (url-tvg) is used when no URL is given here.'}</p>
    <div class="status hidden" id="formStatus"></div>
    <div class="sh-actions"><button type="submit" class="btn primary" id="formSave">${p ? 'Save' : 'Add provider'}</button><button type="button" class="btn" id="formTest">Test connection</button><button type="button" class="btn ghost" id="formCancel">Cancel</button></div>
  </form>`;
  el.formBody.querySelector('#formCancel')!.addEventListener('click', closeForm);
  for (const k of el.formBody.querySelectorAll<HTMLElement>('[data-kind]')) {
    k.addEventListener('click', () => {
      formKind = k.dataset.kind as 'm3u' | 'xtream';
      renderForm();
    });
  }
  const form = el.formBody.querySelector<HTMLFormElement>('#provForm')!;
  const status = el.formBody.querySelector<HTMLElement>('#formStatus')!;
  const input = (): LiveTvProviderInput => {
    const fd = new FormData(form);
    const v = (k: string): string | undefined => (fd.has(k) ? String(fd.get(k) || '') : undefined);
    return { kind: formKind, name: v('name'), url: v('url'), server: v('server'), username: v('username'), password: v('password'), epgUrl: v('epgUrl') };
  };
  const say = (text: string, cls: string): void => {
    status.className = `status ${cls}`;
    status.innerHTML = text;
    status.classList.remove('hidden');
  };
  el.formBody.querySelector<HTMLButtonElement>('#formTest')!.addEventListener('click', (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    say('<span class="spinner"></span> Testing the connection… (a big playlist takes a while)', '');
    busy(btn, async () => {
      try {
        const r = await api.liveTvTest({ ...input(), id: p?.id, preset: p?.preset });
        say(`${r.ok ? '✓' : '✕'} ${esc(r.message)} (${(r.elapsedMs / 1000).toFixed(1)} s)`, r.ok ? 'ok' : 'error');
      } catch (err) {
        say(esc(errMsg(err)), 'error');
      }
    }, 'Testing…');
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const btn = el.formBody.querySelector<HTMLButtonElement>('#formSave')!;
    busy(btn, async () => {
      try {
        const r = p ? await api.liveTvUpdateProvider(p.id, input()) : await api.liveTvAddProvider(input());
        state = r.state;
        closeForm();
        renderSettings();
        renderProviders();
        render();
        toast(p ? 'Saved' : `${r.provider.name} added; loading its channels…`);
        schedulePoll();
      } catch (err) {
        say(esc(errMsg(err)), 'error');
      }
    }, p ? 'Saving…' : 'Adding…');
  });
}

// ---------------------------------------------------------------- start
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !player.isOpen) {
    if (!el.formOverlay.classList.contains('hidden')) closeForm();
    else if (!el.settingsOverlay.classList.contains('hidden')) closeSettings();
  }
});

// for the console: the player's state and the renderer's counters while a channel plays
(window as unknown as { streamAnywhereLiveTv: unknown }).streamAnywhereLiveTv = { player, stats: () => player.stats() };
setBoot('connect');
render();
void sync().finally(() => {
  (window as unknown as { streamAnywhereReady: boolean }).streamAnywhereReady = true;
  // a failed start keeps the splash with its reason and "Tap to try again" (the poll retries too)
  if (boot.phase === 'done') leaveSplash();
  if (boot.phase === 'done' && !state.providers.length && !offline) openSettings();
});
