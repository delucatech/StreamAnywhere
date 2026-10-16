/**
 * Video Library (library.html): save links once, organise them, download where you want them.
 *
 *  - The library (links, details, categories) lives on the server and is shared by every browser
 *    of this site; the page polls for changes and keeps a mirror in IndexedDB for offline viewing.
 *  - "Download for in-app playback" stores the video in this browser (IndexedDB) and the built-in
 *    player (player.ts: the feed's canvas pipeline) plays it, offline too.
 *  - "Save to device" saves a regular file (Downloads folder, the Files app); the car's browser
 *    cannot save files, so that action is not shown there.
 *  - Local copies are verified against the stored bytes on every load: a copy the browser evicted
 *    is reported and "Download again" offered, never shown as present.
 */
import type { LibraryEntry, LibraryOption, LibraryOptionsResponse, LibraryState } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';
import { PLATFORMS, rememberApp } from '../platforms';
import { canPickDestination, canSaveFiles, canShareFiles, hasIndexedDb, isIOS, isTesla, persistenceNote, requestPersistence, storageInfo } from './capabilities';
import * as db from './db';
import * as dl from './downloads';
import { fmtBytes } from './downloads';
import { LibraryPlayer, type PlayItem } from './player';

(window as unknown as { streamAnywhereStarted: boolean }).streamAnywhereStarted = true;
rememberApp('library');

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const el = {
  splash: $('splash'),
  titleIcon: $('titleIcon'),
  homeLink: $<HTMLAnchorElement>('homeLink'),
  catsBtn: $<HTMLButtonElement>('catsBtn'),
  addBtn: $<HTMLButtonElement>('addBtn'),
  addBox: $('addBox'),
  form: $<HTMLFormElement>('saveForm'),
  url: $<HTMLInputElement>('url'),
  pasteBtn: $<HTMLButtonElement>('pasteBtn'),
  saveBtn: $<HTMLButtonElement>('saveBtn'),
  saveHint: $('saveHint'),
  saveStatus: $('saveStatus'),
  offline: $('offline'),
  search: $<HTMLInputElement>('search'),
  localOnly: $<HTMLButtonElement>('localOnly'),
  chips: $('chips'),
  grid: $('grid'),
  empty: $('empty'),
  storage: $('storage'),
  foot: $('foot'),
  sheetOverlay: $('sheetOverlay'),
  sheet: $('sheet'),
  shHead: $('shHead'),
  shBody: $('shBody'),
  catsOverlay: $('catsOverlay'),
  catsClose: $<HTMLButtonElement>('catsClose'),
  catsBody: $('catsBody'),
  theater: $('theater'),
  toast: $('toast'),
};

const LIBRARY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="#fff" stroke-width="1.9"/><path fill="#fff" d="M10 9.2v5.6l4.8-2.8z"/></svg>';
el.titleIcon.innerHTML = LIBRARY_ICON;

// ---------------------------------------------------------------- helpers
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtDuration = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const timeAgo = (t: number): string => {
  const d = Date.now() - t;
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  if (d < 14 * 86400_000) return `${Math.round(d / 86400_000)} d ago`;
  return new Date(t).toLocaleDateString();
};
const errMsg = (e: unknown): string => (e instanceof ApiError ? e.message : (e as Error)?.message || String(e));

interface SourceDef {
  name: string;
  icon: string;
  tile: string;
}
const OTHER: SourceDef = { name: 'Web', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" fill="none" stroke="#fff" stroke-width="1.6"/></svg>', tile: 'linear-gradient(145deg, #5c6b8a 0%, #2b3550 100%)' };
const sourceDef = (source: LibraryEntry['source']): SourceDef => {
  const p = PLATFORMS.find((x) => x.id === source);
  return p ? { name: p.name, icon: p.icon, tile: p.tile } : OTHER;
};

let toastTimer = 0;
function toast(msg: string, isError = false, ms = 3800): void {
  el.toast.textContent = msg;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- state
let lib: LibraryState = { rev: 0, entries: [], categories: [] };
/** The library came from the server during this visit (its rev means something) */
let fresh = false;
let offline = !navigator.onLine;
let local = new Map<string, db.LocalVideo>();
let localChecked = false;
const filters = { q: '', cat: 'all', localOnly: false };
let selectedId: string | undefined;
const optionsCache = new Map<string, { at: number; resp: LibraryOptionsResponse }>();
const OPTIONS_TTL_MS = 15 * 60_000;
const theater = new LibraryPlayer(el.theater);

const entryById = (id: string | undefined): LibraryEntry | undefined => (id ? lib.entries.find((e) => e.id === id) : undefined);

// ---------------------------------------------------------------- sync with the server
let pollTimer = 0;
let syncing = false;

function setOffline(on: boolean): void {
  if (offline === on) return;
  offline = on;
  el.offline.classList.toggle('hidden', !on);
  el.saveBtn.disabled = on;
  el.url.disabled = on;
  if (!on) void sync(true);
}

async function sync(force = false): Promise<void> {
  if (syncing) return;
  if (!navigator.onLine) {
    setOffline(true);
    return;
  }
  syncing = true;
  try {
    const r = await api.library(fresh && !force ? lib.rev : undefined);
    if (!('unchanged' in r)) {
      lib = r;
      fresh = true;
      void db.putState(lib);
      await reconcileLocal();
      render();
    }
    if (offline) {
      offline = false;
      el.offline.classList.add('hidden');
      el.saveBtn.disabled = false;
      el.url.disabled = false;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status !== 401) toast(`The library could not be loaded: ${e.message}`, true);
    } else setOffline(true);
  } finally {
    syncing = false;
    schedulePoll();
  }
}

/** A quick poll while a lookup runs on the server, a slow one otherwise. */
function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  const pending = lib.entries.some((e) => e.meta === 'pending');
  pollTimer = window.setTimeout(() => void sync(), pending ? 2500 : document.hidden ? 60_000 : 15_000);
}

/** Entries removed from the library (on any device) take their local copies with them. */
async function reconcileLocal(): Promise<void> {
  if (!fresh || !localChecked) return;
  const ids = new Set(lib.entries.map((e) => e.id));
  for (const [id] of local) {
    if (ids.has(id)) continue;
    await db.deleteVideo(id).catch(() => undefined);
    local.delete(id);
    theater.remove(id);
  }
}

/** The copies actually present in this browser (records whose bytes are gone are dropped and reported). */
async function refreshLocal(): Promise<void> {
  if (!hasIndexedDb) return;
  try {
    const r = await db.verifyVideos(dl.activePartKeys());
    local = new Map(r.present.map((v) => [v.entryId, v]));
    localChecked = true;
    if (r.missing.length) toast(`${r.missing.length} video${r.missing.length > 1 ? 's' : ''} downloaded to this browser ${r.missing.length > 1 ? 'are' : 'is'} no longer in its storage (the browser cleared it). You can download ${r.missing.length > 1 ? 'them' : 'it'} again.`, true, 8000);
    await reconcileLocal();
  } catch (e) {
    toast(`Local videos could not be read: ${errMsg(e)}`, true);
  }
  render();
  void renderStorage();
}

// ---------------------------------------------------------------- the list
function visibleEntries(): LibraryEntry[] {
  const q = filters.q.trim().toLowerCase();
  return lib.entries
    .filter((e) => {
      if (filters.localOnly && !local.has(e.id)) return false;
      if (filters.cat === 'none' && e.categoryIds.length) return false;
      if (filters.cat !== 'all' && filters.cat !== 'none' && !e.categoryIds.includes(filters.cat)) return false;
      if (q) {
        const hay = `${e.title} ${e.author || ''} ${sourceDef(e.source).name} ${e.url}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => b.addedAt - a.addedAt);
}

interface Status {
  cls: 'ok' | 'busy' | 'err' | 'warn' | 'plain';
  text: string;
  percent?: number;
}
function statusOf(e: LibraryEntry): Status {
  const t = dl.taskFor(e.id);
  if (t && dl.isRunning(t)) return { cls: 'busy', text: t.kind === 'inapp' ? (t.phase === 'server' ? 'Preparing on the server…' : 'Downloading to this browser…') : 'Saving to the device…', percent: t.percent };
  if (t && t.phase === 'error') return { cls: 'err', text: t.kind === 'inapp' ? 'Download failed' : 'Could not save the file' };
  if (t && t.phase === 'ready') return { cls: 'ok', text: 'File ready to save' };
  const v = local.get(e.id);
  if (v) return { cls: 'ok', text: `On this browser · ${v.label}` };
  if (e.meta === 'pending') return { cls: 'busy', text: 'Looking up details…' };
  if (e.unavailable) return { cls: 'warn', text: 'Unavailable at the source' };
  return { cls: 'plain', text: 'Saved to library' };
}

function renderChips(): void {
  const chips: { id: string; label: string; count: number }[] = [{ id: 'all', label: 'All', count: lib.entries.length }];
  for (const c of lib.categories) chips.push({ id: c.id, label: c.name, count: lib.entries.filter((e) => e.categoryIds.includes(c.id)).length });
  const none = lib.entries.filter((e) => !e.categoryIds.length).length;
  if (lib.categories.length && none) chips.push({ id: 'none', label: 'No category', count: none });
  if (filters.cat !== 'all' && !chips.some((c) => c.id === filters.cat)) filters.cat = 'all';
  el.chips.innerHTML = chips.map((c) => `<button type="button" class="chip${c.id === filters.cat ? ' on' : ''}" role="radio" aria-checked="${c.id === filters.cat}" data-cat="${esc(c.id)}">${esc(c.label)}<small>${c.count}</small></button>`).join('');
  el.chips.classList.toggle('hidden', !lib.categories.length);
}
el.chips.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.chip');
  if (!b) return;
  filters.cat = b.dataset.cat || 'all';
  render();
});

function cardHtml(e: LibraryEntry): string {
  const s = sourceDef(e.source);
  const st = statusOf(e);
  const v = local.get(e.id);
  const sub = [e.author ? `@${e.author.replace(/^@/, '')}` : '', s.name, e.duration ? fmtDuration(e.duration) : ''].filter(Boolean).join(' · ');
  const cats = e.categoryIds.map((id) => lib.categories.find((c) => c.id === id)?.name).filter(Boolean) as string[];
  const thumb = e.thumb ? `<img src="${esc(apiUrl(e.thumb))}" alt="" loading="lazy" decoding="async" draggable="false" />` : `<span class="ph" style="background:${s.tile}">${s.icon}</span>`;
  return `<article class="vcard${v ? ' local' : ''}${st.cls === 'busy' ? ' busy' : ''}" data-id="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(e.title)}">
    <div class="vthumb">${thumb}
      <span class="vsrc" style="background:${s.tile}" title="${esc(s.name)}">${s.icon}</span>
      ${e.duration ? `<span class="vdur">${fmtDuration(e.duration)}</span>` : ''}
      <button type="button" class="vmore" data-more="${esc(e.id)}" aria-label="More options for ${esc(e.title)}" title="More"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2.2" fill="currentColor"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><circle cx="19" cy="12" r="2.2" fill="currentColor"/></svg></button>
      ${v ? `<button type="button" class="vplay" data-play="${esc(e.id)}" aria-label="Play ${esc(e.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l10-6.5z"/></svg></button>` : ''}
    </div>
    <div class="vbody">
      <h3 class="vtitle">${esc(e.title)}</h3>
      <p class="vsub">${esc(sub) || '&nbsp;'}</p>
      <p class="vstatus ${st.cls}">${st.cls === 'busy' ? '<span class="spinner small"></span>' : ''}${esc(st.text)}</p>
      ${st.percent !== undefined ? `<div class="vbar"><i style="width:${st.percent}%"></i></div>` : ''}
      ${cats.length ? `<p class="vcats">${cats.map((c) => `<span>${esc(c)}</span>`).join('')}</p>` : ''}
    </div>
  </article>`;
}

function renderGrid(): void {
  const list = visibleEntries();
  el.grid.innerHTML = list.map(cardHtml).join('');
  let empty = '';
  if (!lib.entries.length) {
    if (!fresh && offline) empty = '<b>Offline, and no saved library on this device yet.</b><br>Open the library once while online; it is remembered here afterwards.';
    else if (!fresh) empty = '<span class="spinner"></span> Loading your library…';
    else empty = '<b>Your library is empty.</b><br>Tap <b>+</b> at the top, paste a video link and save it. It is saved to your library on every device; downloading is a separate step, so you decide where each video lives.';
  } else if (!list.length) {
    if (filters.localOnly) empty = `<b>No videos are downloaded to this browser${filters.cat !== 'all' || filters.q ? ' in this selection' : ''}.</b><br>Open a video and choose <i>Download for in-app playback</i> to watch it here${isTesla ? ' in the car' : ''}, offline too.`;
    else if (filters.q) empty = `<b>Nothing matches “${esc(filters.q)}”.</b>`;
    else empty = '<b>No videos in this category yet.</b><br>Open a video and tick the category to put it here.';
  }
  el.empty.innerHTML = empty;
  el.empty.classList.toggle('hidden', !empty);
}
/** A tap on a card: a video that is here plays; one that is not shows how to get it here. */
function openCard(id: string): void {
  if (local.has(id)) void playEntry(id);
  else openSheet(id, 'options');
}
el.grid.addEventListener('click', (e) => {
  const play = (e.target as HTMLElement).closest<HTMLElement>('[data-play]');
  if (play) {
    e.stopPropagation();
    void playEntry(play.dataset.play!);
    return;
  }
  const more = (e.target as HTMLElement).closest<HTMLElement>('[data-more]');
  if (more) {
    e.stopPropagation();
    openSheet(more.dataset.more!, 'menu');
    return;
  }
  const card = (e.target as HTMLElement).closest<HTMLElement>('.vcard');
  if (card) openCard(card.dataset.id!);
});
el.grid.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = (e.target as HTMLElement).closest<HTMLElement>('.vcard');
  if (!card) return;
  e.preventDefault();
  openCard(card.dataset.id!);
});

el.search.addEventListener('input', () => {
  filters.q = el.search.value;
  renderGrid();
});
el.localOnly.addEventListener('click', () => {
  filters.localOnly = !filters.localOnly;
  el.localOnly.classList.toggle('on', filters.localOnly);
  el.localOnly.setAttribute('aria-pressed', String(filters.localOnly));
  renderGrid();
});

function render(): void {
  renderChips();
  renderGrid();
  if (selectedId) renderSheet();
}

// ---------------------------------------------------------------- storage footer
let persistAsked = false;
async function renderStorage(): Promise<void> {
  if (!hasIndexedDb) {
    el.storage.innerHTML = '<b>This browser cannot store videos</b> (no IndexedDB): saved links work, in-app downloads do not.';
    return;
  }
  const videos = [...local.values()];
  const bytes = videos.reduce((n, v) => n + v.sizeBytes, 0);
  const info = await storageInfo();
  const bits: string[] = [];
  bits.push(videos.length ? `<b>${videos.length} video${videos.length === 1 ? '' : 's'} on this browser</b> · ${fmtBytes(bytes)}` : '<b>No videos on this browser yet</b>');
  if (info.quota) bits.push(`${fmtBytes(Math.max(0, info.quota - info.usage))} free of ${fmtBytes(info.quota)}`);
  let html = `<p>${bits.join(' · ')}</p><p class="muted">${esc(persistenceNote(info.persisted))}${info.persisted === false && !isIOS && !isTesla ? ' <button type="button" class="link" id="persistBtn">Ask the browser to keep them</button>' : ''}</p>`;
  const mode = LibraryPlayer.mode();
  html += `<p class="muted">Player: ${mode.mode === 'webcodecs' ? 'WebCodecs + canvas (the same pipeline as the feeds)' : `canvas fed by a hidden video (WebCodecs unavailable: ${esc(mode.reason || '')})`}. Local videos play offline.</p>`;
  el.storage.innerHTML = html;
  document.getElementById('persistBtn')?.addEventListener('click', async () => {
    persistAsked = true;
    const ok = await requestPersistence();
    toast(ok ? 'The browser will keep the local videos' : 'The browser did not grant persistent storage (it may still keep them)', !ok);
    void renderStorage();
  });
}

// ---------------------------------------------------------------- saving a link
let saving = false;
function setSaveStatus(text: string, kind: 'busy' | 'error' | 'info' | 'none'): void {
  el.saveStatus.classList.toggle('hidden', kind === 'none');
  el.saveStatus.classList.toggle('error', kind === 'error');
  el.saveStatus.innerHTML = kind === 'busy' ? '<span class="spinner"></span>' : '';
  el.saveStatus.appendChild(document.createTextNode(text));
}

async function saveLink(raw: string): Promise<void> {
  const url = raw.trim();
  if (!url || saving) return;
  if (offline) return toast('You are offline: links can be saved once the connection is back', true);
  saving = true;
  el.saveBtn.disabled = true;
  setSaveStatus('Saving the link…', 'busy');
  try {
    const r = await api.librarySave(url, filters.cat !== 'all' && filters.cat !== 'none' ? [filters.cat] : []);
    lib = r.state;
    fresh = true;
    void db.putState(lib);
    render();
    if (r.duplicate) {
      setSaveStatus('This link is already in your library.', 'info');
      flashCard(r.entry.id);
    } else {
      setSaveStatus('', 'none');
      el.url.value = '';
      showAddBox(false);
      toast(r.entry.meta === 'pending' ? 'Saved. Looking up the title and thumbnail…' : 'Saved to your library');
      flashCard(r.entry.id);
    }
    schedulePoll();
  } catch (e) {
    setSaveStatus(errMsg(e), 'error');
  } finally {
    saving = false;
    el.saveBtn.disabled = offline;
  }
}

function flashCard(id: string): void {
  const card = el.grid.querySelector<HTMLElement>(`.vcard[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add('flash');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  window.setTimeout(() => card.classList.remove('flash'), 1600);
}

/** The add-link box stays out of the way until "Add" is tapped (and after a link was saved). */
function showAddBox(on: boolean): void {
  el.addBox.classList.toggle('hidden', !on);
  el.addBtn.classList.toggle('on', on);
  el.addBtn.setAttribute('aria-expanded', String(on));
  if (on) el.url.focus();
}
el.addBtn.addEventListener('click', () => showAddBox(el.addBox.classList.contains('hidden')));
el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  void saveLink(el.url.value);
});
el.pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      el.url.value = text.trim();
      void saveLink(el.url.value);
      return;
    }
  } catch {
    /* no clipboard access: the field is focused for a manual paste */
  }
  el.url.focus();
});

// ---------------------------------------------------------------- one video (the sheet)
type SheetView =
  | { kind: 'info' }
  | { kind: 'menu' }
  | { kind: 'category' }
  | { kind: 'options'; mode: 'inapp' | 'device'; loading: boolean; error?: string; resp?: LibraryOptionsResponse; playable?: Map<string, boolean> }
  | { kind: 'remove'; back: 'info' | 'menu' };
let view: SheetView = { kind: 'info' };
let titleEditing = false;
let headRenderedFor = '';

/**
 * `start` 'options' opens straight on the download choices (a video not downloaded here was tapped);
 * 'menu' on the short list of actions (the card's "more" button).
 */
function openSheet(id: string, start: 'info' | 'options' | 'menu' = 'info'): void {
  const e = entryById(id);
  if (!e) return;
  selectedId = id;
  view = start === 'menu' ? { kind: 'menu' } : { kind: 'info' };
  titleEditing = false;
  headRenderedFor = '';
  el.sheetOverlay.classList.remove('hidden');
  document.body.classList.add('sheet-open');
  const canOffer = !local.has(id) && !dl.isRunning(dl.taskFor(id)) && !e.unavailable && !offline && hasIndexedDb;
  if (start === 'options' && canOffer) void loadOptions(e, 'inapp');
  else renderSheet();
  el.sheet.scrollTop = 0;
}
function closeSheet(): void {
  selectedId = undefined;
  el.sheetOverlay.classList.add('hidden');
  document.body.classList.remove('sheet-open');
  // opened from the player's options button: the video goes on
  if (theater.isOpen) theater.resume();
}
// The player's options button: the same sheet, over the player, with the video paused meanwhile.
theater.onOptions = (id) => {
  theater.pause();
  openSheet(id);
};
el.sheetOverlay.addEventListener('click', (e) => {
  if (e.target === el.sheetOverlay) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || theater.isOpen) return;
  if (!el.catsOverlay.classList.contains('hidden')) closeCats();
  else if (selectedId) closeSheet();
});

function renderSheet(): void {
  const e = entryById(selectedId);
  if (!e) {
    if (selectedId) {
      closeSheet();
      toast('This video was removed from the library');
    }
    return;
  }
  const s = sourceDef(e.source);
  const headKey = `${e.id}|${e.title}|${e.thumb}|${e.author}|${e.duration}|${e.meta}`;
  if (headKey !== headRenderedFor && !titleEditing) {
    headRenderedFor = headKey;
    const sub = [e.author ? `@${e.author.replace(/^@/, '')}` : '', s.name, e.duration ? fmtDuration(e.duration) : '', e.width && e.height ? `${e.width}×${e.height}` : ''].filter(Boolean).join(' · ');
    el.shHead.innerHTML = `
      <div class="sh-thumb">${e.thumb ? `<img src="${esc(apiUrl(e.thumb))}" alt="" />` : `<span class="ph" style="background:${s.tile}">${s.icon}</span>`}</div>
      <div class="sh-titles">
        <div class="sh-title-row">
          <h2 class="sh-title" id="shTitle">${esc(e.title)}</h2>
          <button type="button" class="sh-icon" data-act="edit-title" aria-label="Edit title" title="Edit title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/></svg></button>
        </div>
        <p class="sh-sub">${esc(sub)}</p>
        <p class="sh-link"><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Open on ${esc(s.name)}</a> · added ${esc(timeAgo(e.addedAt))}</p>
      </div>
      <button type="button" class="sh-close" data-act="close" aria-label="Close">✕</button>`;
  }
  el.shBody.innerHTML =
    view.kind === 'options' ? optionsHtml(e, view) : view.kind === 'remove' ? removeHtml(e) : view.kind === 'menu' ? menuHtml(e) : view.kind === 'category' ? categoryHtml(e) : infoHtml(e);
}

/** The card's "more" menu: one action per row, the destructive ones last. */
function menuHtml(e: LibraryEntry): string {
  const v = local.get(e.id);
  const running = dl.isRunning(dl.taskFor(e.id));
  const s = sourceDef(e.source);
  const cats = e.categoryIds.map((id) => lib.categories.find((c) => c.id === id)?.name).filter(Boolean) as string[];
  const item = (act: string, label: string, opts: { sub?: string; disabled?: boolean; danger?: boolean } = {}) =>
    `<button type="button" class="menu-item${opts.danger ? ' danger-text' : ''}" data-act="${act}" ${opts.disabled ? 'disabled' : ''}><span>${label}</span>${opts.sub ? `<small>${esc(opts.sub)}</small>` : ''}</button>`;
  let html = '<div class="menu">';
  if (v) {
    html += item('play', theater.isOpen && theater.current === e.id ? 'Resume' : 'Play', { sub: `On this browser · ${v.label}` });
    if (canSaveFiles) html += item('export-local', `Save ${esc(v.label)} copy to device`);
    if (canShareFiles && isIOS) html += item('share-local', 'Share / Save to Photos…');
  } else {
    html += item('pick-inapp', 'Download for in-app playback', { disabled: running || !!e.unavailable || offline || !hasIndexedDb, sub: running ? 'Download in progress' : e.unavailable ? 'Unavailable at the source' : offline ? 'Offline' : undefined });
    if (canSaveFiles) html += item('pick-device', 'Save to device', { disabled: running || !!e.unavailable || offline });
  }
  html += item('categories', 'Change category', { sub: cats.length ? cats.join(', ') : 'No category' });
  html += item('edit-title', 'Edit title');
  html += `<a class="menu-item" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer"><span>Open on ${esc(s.name)}</span></a>`;
  html += item('details', 'Details', { sub: 'Downloads, qualities and everything else' });
  if (v) html += item('delete-local', 'Delete from this browser', { danger: true, sub: 'The link stays in your library' });
  html += item('remove', 'Remove from library…', { danger: true });
  html += '</div>';
  return html;
}

/** Category picker reached from the "more" menu: the same chips as the details view, on a page of their own. */
function categoryHtml(e: LibraryEntry): string {
  let html = '<section class="sh-section"><h3 class="sh-h">Categories</h3>';
  if (lib.categories.length) html += `<div class="sh-cats">${lib.categories.map((c) => `<button type="button" class="chip${e.categoryIds.includes(c.id) ? ' on' : ''}" data-cat-toggle="${esc(c.id)}" aria-pressed="${e.categoryIds.includes(c.id)}">${esc(c.name)}</button>`).join('')}<button type="button" class="chip add" data-act="new-cat">+ New category</button></div>`;
  else html += '<p class="sh-note">No categories yet. <button type="button" class="link" data-act="new-cat">Create one</button> to group your videos.</p>';
  html += '<p class="sh-note">Tap a category to add or remove this video; it is saved right away.</p>';
  html += '<div class="sh-actions"><button type="button" class="btn primary" data-act="menu">Done</button></div></section>';
  return html;
}

function taskHtml(e: LibraryEntry): string {
  const t = dl.taskFor(e.id);
  if (!t) return '';
  const running = dl.isRunning(t);
  const cls = t.phase === 'error' ? 'error' : t.phase === 'done' || t.phase === 'ready' ? 'done' : '';
  const bar = running || t.phase === 'ready' ? `<div class="bar${t.percent === undefined ? ' busy' : ''}"><i style="width:${t.percent ?? 0}%"></i></div>` : '';
  const buttons = [
    running ? '<button type="button" class="btn small danger" data-act="cancel">Cancel</button>' : '',
    t.phase === 'ready' && t.save ? '<button type="button" class="btn small primary" data-act="save-ready">Save file</button>' : '',
    t.phase === 'error' ? `<button type="button" class="btn small" data-act="retry">Try again</button>` : '',
    !running ? '<button type="button" class="btn small ghost" data-act="dismiss">Dismiss</button>' : '',
  ].join('');
  return `<div class="sh-task ${cls}">${bar}<p>${esc(t.text)}</p><div class="sh-actions">${buttons}</div></div>`;
}

function infoHtml(e: LibraryEntry): string {
  const v = local.get(e.id);
  const t = dl.taskFor(e.id);
  const running = dl.isRunning(t);
  let html = '';
  if (e.meta === 'pending') html += '<p class="sh-note"><span class="spinner small"></span> Looking up the title, thumbnail and length at the source…</p>';
  else if (e.meta === 'failed' && !e.unavailable) html += `<p class="sh-note warn">The details could not be looked up (${esc(e.metaError || 'unknown error')}). The link is saved; you can edit the title and try the lookup again. <button type="button" class="link" data-act="refresh">Look up again</button></p>`;
  if (e.unavailable) html += `<p class="sh-note warn"><b>This video is no longer available at its source</b> (${esc(e.unavailable.reason)}, seen ${esc(timeAgo(e.unavailable.at))}). It cannot be downloaded again; a copy already downloaded to a browser still plays there. <button type="button" class="link" data-act="recheck">Check again</button></p>`;
  html += taskHtml(e);

  html += '<section class="sh-section"><h3 class="sh-h">On this browser</h3>';
  if (v) {
    html += `<p class="sh-local ok">Available for in-app playback · ${esc(v.label)} · ${esc(v.detail)} · ${fmtBytes(v.sizeBytes)} · downloaded ${esc(timeAgo(v.savedAt))}</p>
      <div class="sh-actions">
        <button type="button" class="btn primary" data-act="play">${theater.isOpen && theater.current === e.id ? 'Resume' : 'Play'}</button>
        ${canSaveFiles ? `<button type="button" class="btn" data-act="export-local" title="${canPickDestination ? 'Choose where to save the file' : 'Saves the file where this browser puts downloads'}">Save ${esc(v.label)} copy to device</button>` : ''}
        ${canShareFiles && isIOS ? '<button type="button" class="btn" data-act="share-local">Share / Save to Photos…</button>' : ''}
        <button type="button" class="btn ghost" data-act="pick-inapp" ${running || e.unavailable ? 'disabled' : ''}>Replace with another quality…</button>
        <button type="button" class="btn ghost danger-text" data-act="delete-local">Delete from this browser</button>
      </div>
      <p class="sh-note">Deleting the local copy keeps the link and its details in your library.</p>`;
  } else {
    html += `<p class="sh-local">Not downloaded to this browser.${isTesla ? ' Download it here to watch it in the car, also without a connection.' : ''}</p>
      <div class="sh-actions">
        <button type="button" class="btn primary" data-act="pick-inapp" ${running || e.unavailable || offline ? 'disabled' : ''}>Download for in-app playback</button>
        ${canSaveFiles ? `<button type="button" class="btn" data-act="pick-device" ${running || e.unavailable || offline ? 'disabled' : ''}>Save to device</button>` : ''}
      </div>
      <p class="sh-note">${hasIndexedDb ? 'In-app downloads stay in this browser; other devices download their own copy. ' : 'This browser cannot store videos for in-app playback. '}${canSaveFiles ? `“Save to device” writes a regular file${canPickDestination ? ' where you choose' : isIOS ? ' into the Files app (Downloads)' : ' into the downloads folder'}; the app cannot play files saved that way.` : 'The car’s browser cannot save files; downloads for in-app playback work.'}</p>`;
  }
  html += '</section>';

  html += '<section class="sh-section"><h3 class="sh-h">Categories</h3>';
  if (lib.categories.length) html += `<div class="sh-cats">${lib.categories.map((c) => `<button type="button" class="chip${e.categoryIds.includes(c.id) ? ' on' : ''}" data-cat-toggle="${esc(c.id)}" aria-pressed="${e.categoryIds.includes(c.id)}">${esc(c.name)}</button>`).join('')}<button type="button" class="chip add" data-act="new-cat">+ New category</button></div>`;
  else html += '<p class="sh-note">No categories yet. <button type="button" class="link" data-act="new-cat">Create one</button> to group your videos.</p>';
  html += '</section>';

  html += `<section class="sh-section"><div class="sh-actions"><button type="button" class="btn ghost danger-text" data-act="remove">Remove from library…</button></div></section>`;
  return html;
}

function removeHtml(e: LibraryEntry): string {
  const v = local.get(e.id);
  return `<section class="sh-section">
    <h3 class="sh-h">Remove “${esc(e.title)}” from the library?</h3>
    <p class="sh-note">The link and its details disappear from the library on every device. ${v ? 'The copy downloaded to this browser is deleted as well. ' : ''}Copies downloaded to other browsers are deleted there the next time they open the library. The video itself stays at its source; you can save the link again later.</p>
    <div class="sh-actions"><button type="button" class="btn danger" data-act="remove-confirm">Remove</button><button type="button" class="btn ghost" data-act="back">Keep it</button></div>
  </section>`;
}

function optionsHtml(e: LibraryEntry, v: Extract<SheetView, { kind: 'options' }>): string {
  const title = v.mode === 'inapp' ? 'Download for in-app playback' : 'Save to device';
  let body = '';
  if (v.loading) body = '<p class="sh-note"><span class="spinner small"></span> Asking the source which qualities it offers…</p>';
  else if (v.error) body = `<p class="sh-note warn">${esc(v.error)}</p><div class="sh-actions"><button type="button" class="btn small" data-act="options-retry">Try again</button></div>`;
  else if (v.resp) {
    const opts = v.resp.options.filter((o) => (v.mode === 'inapp' ? o.kind === 'video' : true));
    if (!opts.length) body = '<p class="sh-note warn">No quality of this video can be played here.</p>';
    else {
      const current = local.get(e.id);
      body += `<div class="option-list">${opts
        .map((o) => {
          const ok = v.mode === 'inapp' ? v.playable?.get(o.id) !== false : true;
          const size = o.sizeBytes ? `${o.sizeIsEstimate ? '~' : ''}${fmtBytes(o.sizeBytes)}` : '';
          const tags = [o.recommended ? '<span class="rec">best fit</span>' : '', current?.optionId === o.id && v.mode === 'inapp' ? '<span class="rec have">downloaded</span>' : '', !ok ? '<span class="rec no">won’t play here</span>' : ''].join('');
          return `<button type="button" class="option${ok ? '' : ' off'}" data-opt="${esc(o.id)}" ${ok ? '' : 'disabled'} aria-label="${esc([o.label, o.detail, size].filter(Boolean).join(', '))}"><span class="q">${esc(o.label)}${tags}<small>${esc(o.detail)}</small></span><span class="size">${size}</span></button>`;
        })
        .join('')}</div>`;
      if (v.resp.warnings.length) body += `<p class="sh-note">${esc(v.resp.warnings.join(' '))}</p>`;
      if (v.mode === 'inapp' && v.playable && [...v.playable.values()].some((x) => !x)) body += '<p class="sh-note">Greyed qualities use a codec this browser cannot decode; they can still be saved to the device.</p>';
      if (v.mode === 'device' && !canPickDestination) body += `<p class="sh-note">${isIOS ? 'The file goes to the Files app (Downloads); share it from there to Photos.' : 'The file goes where this browser puts downloads.'}</p>`;
    }
  }
  return `<section class="sh-section"><div class="sh-opt-head"><button type="button" class="btn small ghost" data-act="back">‹ Back</button><h3 class="sh-h">${title}</h3></div>${body}</section>`;
}

async function loadOptions(e: LibraryEntry, mode: 'inapp' | 'device'): Promise<void> {
  view = { kind: 'options', mode, loading: true };
  renderSheet();
  const hit = optionsCache.get(e.id);
  try {
    const resp = hit && Date.now() - hit.at < OPTIONS_TTL_MS ? hit.resp : await api.libraryOptions(e.id);
    optionsCache.set(e.id, { at: hit && resp === hit.resp ? hit.at : Date.now(), resp });
    const playable = new Map<string, boolean>();
    if (mode === 'inapp') await Promise.all(resp.options.map(async (o) => playable.set(o.id, await playableHere(o))));
    if (selectedId !== e.id || view.kind !== 'options') return;
    view = { kind: 'options', mode, loading: false, resp, playable };
    void sync(); // the lookup may have refreshed the title or marked the video unavailable
  } catch (err) {
    if (selectedId !== e.id || view.kind !== 'options') return;
    view = { kind: 'options', mode, loading: false, error: errMsg(err) };
  }
  renderSheet();
}

/** Can the player here decode this quality? (the codec string as WebCodecs / the <video> element understand it) */
const playableCache = new Map<string, boolean>();
const FAMILY_CODEC: Record<string, string> = { h264: 'avc1.64001f', avc1: 'avc1.64001f', h265: 'hvc1.1.6.L120.B0', hevc: 'hvc1.1.6.L120.B0', vp9: 'vp09.00.31.08', av1: 'av01.0.08M.08' };
async function playableHere(o: LibraryOption): Promise<boolean> {
  if (o.kind !== 'video') return false;
  const raw = (o.vcodec || '').toLowerCase();
  if (!raw) return true;
  const codec = FAMILY_CODEC[raw] || o.vcodec!;
  const key = `${LibraryPlayer.mode().mode}:${codec}`;
  const hit = playableCache.get(key);
  if (hit !== undefined) return hit;
  let ok = true;
  try {
    if (LibraryPlayer.mode().mode === 'webcodecs') {
      const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: o.width || 1280, codedHeight: o.height || 720 });
      ok = !!r.supported;
    } else {
      const v = document.createElement('video');
      ok = v.canPlayType(`video/mp4; codecs="${codec}"`) !== '';
    }
  } catch {
    ok = /^avc1|^h264/.test(raw);
  }
  playableCache.set(key, ok);
  return ok;
}

async function chooseOption(e: LibraryEntry, optId: string): Promise<void> {
  if (view.kind !== 'options' || !view.resp) return;
  const o = view.resp.options.find((x) => x.id === optId);
  if (!o) return;
  const mode = view.mode;
  const probeId = view.resp.probeId;
  view = { kind: 'info' };
  renderSheet();
  try {
    if (mode === 'inapp') {
      if (!hasIndexedDb) throw new Error('This browser cannot store videos');
      void dl.downloadInApp(e, o, probeId).then(() => refreshLocal());
    } else {
      // must stay inside the tap: the file APIs want a user gesture
      void dl.saveToDevice(e, o, probeId, local.get(e.id));
    }
  } catch (err) {
    toast(errMsg(err), true);
  }
}

async function startTitleEdit(e: LibraryEntry): Promise<void> {
  titleEditing = true;
  const row = el.shHead.querySelector('.sh-title-row') as HTMLElement;
  row.innerHTML = `<input class="sh-title-input" id="shTitleInput" type="text" value="${esc(e.title)}" maxlength="300" aria-label="Title" /><button type="button" class="btn small primary" data-act="save-title">Save</button><button type="button" class="btn small ghost" data-act="cancel-title">Cancel</button>`;
  const input = row.querySelector<HTMLInputElement>('input')!;
  input.focus();
  input.select();
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void saveTitle(e);
    } else if (ev.key === 'Escape') {
      ev.stopPropagation();
      endTitleEdit();
    }
  });
}
function endTitleEdit(): void {
  titleEditing = false;
  headRenderedFor = '';
  renderSheet();
}
async function saveTitle(e: LibraryEntry): Promise<void> {
  const input = el.shHead.querySelector<HTMLInputElement>('#shTitleInput');
  const title = input?.value.trim();
  if (!title || title === e.title) return endTitleEdit();
  try {
    const r = await api.libraryPatch(e.id, { title });
    lib = r.state;
    void db.putState(lib);
    endTitleEdit();
    render();
  } catch (err) {
    toast(`The title could not be saved: ${errMsg(err)}`, true);
  }
}

async function toggleCategory(e: LibraryEntry, catId: string): Promise<void> {
  const ids = e.categoryIds.includes(catId) ? e.categoryIds.filter((x) => x !== catId) : [...e.categoryIds, catId];
  try {
    const r = await api.libraryPatch(e.id, { categoryIds: ids });
    lib = r.state;
    void db.putState(lib);
    render();
  } catch (err) {
    toast(`The category could not be changed: ${errMsg(err)}`, true);
  }
}

async function removeEntry(e: LibraryEntry): Promise<void> {
  try {
    lib = await api.libraryDelete(e.id);
    void db.putState(lib);
    if (local.has(e.id)) {
      await db.deleteVideo(e.id).catch(() => undefined);
      local.delete(e.id);
      theater.remove(e.id);
    }
    dl.dismiss(e.id);
    closeSheet();
    render();
    void renderStorage();
    toast('Removed from your library');
  } catch (err) {
    toast(`Could not remove it: ${errMsg(err)}`, true);
  }
}

async function deleteLocal(e: LibraryEntry): Promise<void> {
  try {
    await db.deleteVideo(e.id);
    local.delete(e.id);
    theater.remove(e.id);
    dl.dismiss(e.id);
    render();
    void renderStorage();
    toast('Deleted from this browser; the link stays in your library');
  } catch (err) {
    toast(`Could not delete the local copy: ${errMsg(err)}`, true);
  }
}

el.sheet.addEventListener('click', (ev) => {
  const e = entryById(selectedId);
  if (!e) return;
  const target = ev.target as HTMLElement;
  const catBtn = target.closest<HTMLElement>('[data-cat-toggle]');
  if (catBtn) return void toggleCategory(e, catBtn.dataset.catToggle!);
  const opt = target.closest<HTMLElement>('[data-opt]');
  if (opt) return void chooseOption(e, opt.dataset.opt!);
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act) return;
  const t = dl.taskFor(e.id);
  switch (act) {
    case 'close':
      return closeSheet();
    case 'back':
      view = { kind: view.kind === 'remove' ? view.back : 'info' };
      return renderSheet();
    case 'menu':
      view = { kind: 'menu' };
      return renderSheet();
    case 'details':
      view = { kind: 'info' };
      return renderSheet();
    case 'categories':
      view = { kind: 'category' };
      return renderSheet();
    case 'edit-title':
      return void startTitleEdit(e);
    case 'save-title':
      return void saveTitle(e);
    case 'cancel-title':
      return endTitleEdit();
    case 'refresh':
    case 'recheck':
      return void api
        .libraryRefresh(e.id)
        .then((r) => {
          lib = r.state;
          render();
          schedulePoll();
        })
        .catch((err) => toast(errMsg(err), true));
    case 'play':
      return void playEntry(e.id);
    case 'pick-inapp':
      return void loadOptions(e, 'inapp');
    case 'pick-device':
      return void loadOptions(e, 'device');
    case 'options-retry':
      optionsCache.delete(e.id);
      return void loadOptions(e, view.kind === 'options' ? view.mode : 'inapp');
    case 'export-local': {
      const v = local.get(e.id);
      if (!v) return;
      return void dl.saveToDevice(e, { id: v.optionId, kind: 'video', label: v.label, detail: v.detail, ext: v.ext, via: 'stream', width: v.width, height: v.height, vcodec: v.vcodec }, undefined, v);
    }
    case 'share-local': {
      const v = local.get(e.id);
      if (!v) return;
      return void db
        .videoBlob(v)
        .then((b) => dl.shareBlob(b, dl.fileName(e, { ext: v.ext })))
        .then((ok) => !ok && toast('Sharing files is not available here', true))
        .catch((err) => toast(errMsg(err), true));
    }
    case 'delete-local':
      return void deleteLocal(e);
    case 'cancel':
      return dl.cancel(e.id);
    case 'dismiss':
      dl.dismiss(e.id);
      return render();
    case 'retry':
      if (!t) return;
      dl.dismiss(e.id);
      return void loadOptions(e, t.kind);
    case 'save-ready':
      return void t?.save?.().catch((err) => toast(errMsg(err), true));
    case 'new-cat':
      return openCats(true);
    case 'remove':
      view = { kind: 'remove', back: view.kind === 'menu' ? 'menu' : 'info' };
      return renderSheet();
    case 'remove-confirm':
      return void removeEntry(e);
  }
});

// ---------------------------------------------------------------- categories dialog
function openCats(focusNew = false): void {
  el.catsOverlay.classList.remove('hidden');
  renderCats();
  if (focusNew) el.catsBody.querySelector<HTMLInputElement>('#newCat')?.focus();
}
function closeCats(): void {
  el.catsOverlay.classList.add('hidden');
}
function renderCats(): void {
  const rows = lib.categories.map((c) => {
    const n = lib.entries.filter((e) => e.categoryIds.includes(c.id)).length;
    return `<div class="cat-row" data-cat="${esc(c.id)}"><input type="text" value="${esc(c.name)}" maxlength="60" aria-label="Category name" /><span class="cat-n">${n} video${n === 1 ? '' : 's'}</span><button type="button" class="btn small" data-cat-act="rename">Rename</button><button type="button" class="btn small ghost danger-text" data-cat-act="delete">Delete</button></div>`;
  });
  el.catsBody.innerHTML = `${rows.join('') || '<p class="sh-note">No categories yet.</p>'}
    <form class="cat-new" id="catNewForm"><input type="text" id="newCat" placeholder="New category" maxlength="60" aria-label="New category name" required /><button type="submit" class="btn small primary">Add</button></form>
    <p class="sh-note">Deleting a category keeps its videos in the library; they just lose that label.</p>`;
}
el.catsBtn.addEventListener('click', () => openCats());
el.catsClose.addEventListener('click', closeCats);
el.catsOverlay.addEventListener('click', (e) => {
  if (e.target === el.catsOverlay) closeCats();
});
el.catsBody.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el.catsBody.querySelector<HTMLInputElement>('#newCat');
  const name = input?.value.trim();
  if (!name) return;
  try {
    const r = await api.libraryAddCategory(name);
    lib = r.state;
    void db.putState(lib);
    // a category created from a video's sheet is applied to that video right away
    const e2 = entryById(selectedId);
    if (e2 && !e2.categoryIds.includes(r.category.id)) await toggleCategory(e2, r.category.id);
    renderCats();
    render();
    el.catsBody.querySelector<HTMLInputElement>('#newCat')?.focus();
  } catch (err) {
    toast(errMsg(err), true);
  }
});
el.catsBody.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cat-act]');
  if (!b) return;
  const row = b.closest<HTMLElement>('.cat-row')!;
  const id = row.dataset.cat!;
  const cat = lib.categories.find((c) => c.id === id);
  if (!cat) return;
  try {
    if (b.dataset.catAct === 'rename') {
      const name = row.querySelector('input')!.value.trim();
      if (!name || name === cat.name) return;
      lib = (await api.libraryRenameCategory(id, name)).state;
    } else {
      if (!confirm(`Delete the category “${cat.name}”? Its videos stay in the library.`)) return;
      lib = await api.libraryDeleteCategory(id);
    }
    void db.putState(lib);
    renderCats();
    render();
  } catch (err) {
    toast(errMsg(err), true);
  }
});

// ---------------------------------------------------------------- playing
async function playEntry(id: string): Promise<void> {
  if (theater.isOpen && theater.current === id) return closeSheet(); // back to the paused video
  const list = visibleEntries().filter((e) => local.has(e.id));
  let idx = list.findIndex((e) => e.id === id);
  if (idx < 0) {
    const e = entryById(id);
    if (!e || !local.has(id)) return toast('This video is not downloaded to this browser', true);
    list.unshift(e);
    idx = 0;
  }
  const items: PlayItem[] = list.map((e) => {
    const v = local.get(e.id)!;
    return {
      entryId: e.id,
      title: e.title,
      sub: [e.author ? `@${e.author.replace(/^@/, '')}` : '', sourceDef(e.source).name, v.label].filter(Boolean).join(' · '),
      poster: e.thumb ? apiUrl(e.thumb) : undefined,
      durationHint: e.duration,
      load: () => db.videoBlob(v),
    };
  });
  closeSheet();
  theater.open(items, idx);
}

// ---------------------------------------------------------------- tasks -> UI
dl.onTasksChange(() => {
  renderGrid();
  if (selectedId) renderSheet();
});

// ---------------------------------------------------------------- home
let leaving = false;
el.homeLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (leaving) return;
  leaving = true;
  try {
    sessionStorage.setItem('streamanywhere.returnFrom', 'library');
  } catch {
    /* ignore */
  }
  location.assign(el.homeLink.href);
});

// ---------------------------------------------------------------- start
window.addEventListener('online', () => void sync(true));
window.addEventListener('offline', () => setOffline(true));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void sync();
  else schedulePoll();
});
// a second tab (or the player) changed the local store: check again when this tab is used
window.addEventListener('focus', () => void refreshLocal());

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[library] service worker not registered', e));
}

void (async () => {
  // the mirror first (instant, and all there is offline), the server right after
  const saved = await db.getState();
  if (saved) {
    lib = saved;
    render();
  }
  el.offline.classList.toggle('hidden', !offline);
  await refreshLocal();
  await sync(true);
  void renderStorage();
  if (!persistAsked && hasIndexedDb && !isIOS) void requestPersistence().then(() => renderStorage());
  const bits: string[] = [];
  if (isTesla) bits.push('Tesla browser: files cannot be saved on the device; in-app downloads work.');
  if (isIOS) bits.push('iPhone/iPad: “Save to device” puts the file in the Files app (Downloads).');
  bits.push('Saved links are not backups: a video removed at its source cannot be downloaded again.');
  el.foot.textContent = bits.join(' ');
  // ?url=… (a shared link, or the old downloader page): save it right away
  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) {
      history.replaceState(null, '', location.pathname);
      showAddBox(true);
      el.url.value = q;
      void saveLink(q);
    }
  } catch {
    /* ignore */
  }
})();

el.splash.classList.add('leaving');
window.setTimeout(() => el.splash.classList.add('hidden'), 350);
(window as unknown as { streamAnywhereReady: boolean }).streamAnywhereReady = true;
// Debug handle (console / automated checks)
(window as unknown as { streamAnywhereLibrary: unknown }).streamAnywhereLibrary = { get lib() { return lib; }, get local() { return local; }, sync, refreshLocal, openSheet, playEntry, theater, tasks: dl.allTasks };
