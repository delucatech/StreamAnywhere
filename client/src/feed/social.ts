/**
 * The feed page's social panels: search, account profiles (with follow and the account's videos)
 * and messages. All data comes from the server's headless TikTok session (server/src/social.ts);
 * search and profiles work signed out, follow and messages need the signed-in account.
 *
 * The panels do not play anything themselves: a tapped video hands a play list (the search results
 * or the account's videos, with the continuation) to the feed through SocialHost.play().
 *
 * Search remembers, per platform and on this device (localStorage): the phrases searched, shown
 * under the box while typing (filtered by what is typed) with a ✕ to forget one, and the results
 * of the recent ones. A phrase searched again shows its earlier results at once and the fresh
 * search runs behind them (a status at the end of the list says so); fresh results then take over.
 */
import type { ChatMessage, Conversation, FeedItem, FollowState, SearchResponse, UserSummary } from '../../../shared/types';
import { api, ApiError } from '../api';
import { pressed } from '../busy';
import type { PlatformDef } from '../platforms';

export type PlayList = { kind: 'search'; q: string; items: FeedItem[]; offset: number; hasMore: boolean } | { kind: 'profile'; user: string; items: FeedItem[]; offset: number; hasMore: boolean };

export interface SocialHost {
  play(list: PlayList, startIndex: number): void;
  toast(msg: string, isError?: boolean, ms?: number): void;
  isLoggedIn(): boolean;
  openSessionPanel(): Promise<void>;
  fmtCount(n?: number): string;
  /** Called when the first panel opens (true) and when the last one closes (false): the feed pauses behind a panel. */
  onPanelsChange(open: boolean): void;
  /** Which platform the panels search and browse (follow / messages exist on TikTok only) */
  platform: PlatformDef;
  /** The signed-in account's follow state of an account became known (a profile opened, a follow pressed) */
  onFollowState?(user: string, state: FollowState): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const errMsg = (e: unknown): string => (e instanceof ApiError ? e.message : (e as Error)?.message || String(e));

let host!: SocialHost;

const el = {
  search: $('search'),
  searchForm: $<HTMLFormElement>('searchForm'),
  searchClose: $<HTMLButtonElement>('searchClose'),
  searchInput: $<HTMLInputElement>('searchInput'),
  searchGo: $<HTMLButtonElement>('searchGo'),
  searchStatus: $('searchStatus'),
  searchHistory: $('searchHistory'),
  searchUsers: $('searchUsers'),
  searchVideos: $('searchVideos'),
  searchFresh: $('searchFresh'),
  searchFreshText: $('searchFreshText'),
  searchMore: $<HTMLButtonElement>('searchMore'),
  profile: $('profile'),
  profileClose: $<HTMLButtonElement>('profileClose'),
  profileHandle: $('profileHandle'),
  profileStatus: $('profileStatus'),
  profileAvatar: $<HTMLImageElement>('profileAvatar'),
  profileNick: $('profileNick'),
  profileStats: $('profileStats'),
  profileBio: $('profileBio'),
  profileFollow: $<HTMLButtonElement>('profileFollow'),
  profileMessage: $<HTMLButtonElement>('profileMessage'),
  profileVideos: $('profileVideos'),
  profileMore: $<HTMLButtonElement>('profileMore'),
  inbox: $('inbox'),
  inboxClose: $<HTMLButtonElement>('inboxClose'),
  inboxBack: $<HTMLButtonElement>('inboxBack'),
  inboxTitle: $('inboxTitle'),
  inboxRefresh: $<HTMLButtonElement>('inboxRefresh'),
  inboxStatus: $('inboxStatus'),
  inboxList: $('inboxList'),
  inboxThread: $('inboxThread'),
  inboxMessages: $('inboxMessages'),
  inboxForm: $<HTMLFormElement>('inboxForm'),
  inboxText: $<HTMLInputElement>('inboxText'),
  inboxSend: $<HTMLButtonElement>('inboxSend'),
};

function status(node: HTMLElement, text: string, isError = false): void {
  node.textContent = text;
  node.classList.toggle('error', isError);
  node.classList.toggle('hidden', !text);
}

/** Panels stack: the last opened one is on top (Escape / close pops it). */
const open: HTMLElement[] = [];
function show(panel: HTMLElement): void {
  const wasOpen = open.length > 0;
  const i = open.indexOf(panel);
  if (i >= 0) open.splice(i, 1);
  open.push(panel);
  panel.classList.remove('hidden');
  panel.scrollTop = 0;
  if (!wasOpen) host.onPanelsChange(true);
}
function hide(panel: HTMLElement): void {
  const i = open.indexOf(panel);
  if (i < 0) return;
  open.splice(i, 1);
  panel.classList.add('hidden');
  if (!open.length) host.onPanelsChange(false);
}
/** Closes the panel on top; false when none is open. */
export function closeTopPanel(): boolean {
  const top = open[open.length - 1];
  if (!top) return false;
  hide(top);
  return true;
}
export function closeAllPanels(): void {
  while (closeTopPanel()) {
    /* pop */
  }
}
export const panelOpen = (): boolean => open.length > 0;

// ---------------------------------------------------------------- shared renderers

function videoTile(item: FeedItem, onPlay: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'v-tile';
  b.title = item.desc || '';
  if (item.cover) {
    const img = document.createElement('img');
    img.src = item.cover;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    b.appendChild(img);
  }
  if (item.stats.plays !== undefined) {
    const p = document.createElement('span');
    p.className = 'v-plays';
    p.textContent = `▶ ${host.fmtCount(item.stats.plays)}`;
    b.appendChild(p);
  }
  const m = document.createElement('span');
  m.className = 'v-meta';
  m.textContent = item.desc || `@${item.author.uniqueId || '?'}`;
  b.appendChild(m);
  b.addEventListener('click', onPlay);
  return b;
}

function userRow(u: UserSummary): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'user-row';
  const img = document.createElement('img');
  if (u.avatar) img.src = u.avatar;
  img.alt = '';
  img.loading = 'lazy';
  b.appendChild(img);
  const d = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'u-name';
  name.textContent = `@${u.uniqueId}${u.verified ? ' ✔' : ''}`;
  const sub = document.createElement('div');
  sub.className = 'u-sub';
  sub.textContent = [u.nickname, u.followers !== undefined ? `${host.fmtCount(u.followers)} followers` : '', u.signature].filter(Boolean).join(' · ');
  d.append(name, sub);
  b.appendChild(d);
  b.addEventListener('click', () => void openProfile(u.uniqueId));
  return b;
}

// ---------------------------------------------------------------- search memory

interface CachedSearch {
  at: number;
  items: FeedItem[];
  users: UserSummary[];
  offset: number;
  hasMore: boolean;
}
interface SearchMemory {
  v: 1;
  /** Newest first */
  history: { q: string; at: number }[];
  /** By the phrase in lower case */
  results: Record<string, CachedSearch>;
}
const HISTORY_MAX = 40;
const RESULTS_MAX = 12;
const RESULT_ITEMS_MAX = 60;
const RESULTS_MAX_AGE = 7 * 24 * 3600_000;
const normQ = (q: string): string => q.trim().toLowerCase();
let memory: SearchMemory | undefined;
const memoryKey = (): string => `streamanywhere.search.${host.platform.id}`;
function getMemory(): SearchMemory {
  if (memory) return memory;
  const empty: SearchMemory = { v: 1, history: [], results: {} };
  try {
    const m = JSON.parse(localStorage.getItem(memoryKey()) || 'null') as SearchMemory | null;
    memory = m && m.v === 1 && Array.isArray(m.history) && m.results ? m : empty;
  } catch {
    memory = empty;
  }
  return memory;
}
function saveMemory(): void {
  if (!memory) return;
  try {
    localStorage.setItem(memoryKey(), JSON.stringify(memory));
  } catch {
    // full: keep the phrases, drop the results
    memory.results = {};
    try {
      localStorage.setItem(memoryKey(), JSON.stringify(memory));
    } catch {
      /* storage unavailable */
    }
  }
}
/** The results of an earlier search of this phrase, if recent enough. */
function cachedSearch(q: string): CachedSearch | undefined {
  const c = getMemory().results[normQ(q)];
  return c && Date.now() - c.at < RESULTS_MAX_AGE && c.items.length ? c : undefined;
}
/** Remembers the phrase (newest first) and its results (the diagnostics-only fields are big and useless later). */
function rememberSearch(q: string, items: FeedItem[], users: UserSummary[], offset: number, hasMore: boolean): void {
  const m = getMemory();
  const key = normQ(q);
  m.history = [{ q: q.trim(), at: Date.now() }, ...m.history.filter((h) => normQ(h.q) !== key)].slice(0, HISTORY_MAX);
  const slim = items.slice(0, RESULT_ITEMS_MAX).map((it) => ({ ...it, formats: it.formats.map(({ cookieBoundUrl: _c, serverProbe: _s, ...f }) => f) }));
  m.results[key] = { at: Date.now(), items: slim, users, offset, hasMore };
  // only the recent phrases keep their results
  const keep = new Set(m.history.slice(0, RESULTS_MAX).map((h) => normQ(h.q)));
  for (const k of Object.keys(m.results)) if (!keep.has(k)) delete m.results[k];
  saveMemory();
}
function forgetSearch(q: string): void {
  const m = getMemory();
  const key = normQ(q);
  m.history = m.history.filter((h) => normQ(h.q) !== key);
  delete m.results[key];
  saveMemory();
}
function forgetAllSearches(): void {
  const m = getMemory();
  m.history = [];
  m.results = {};
  saveMemory();
}

const CLOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>';
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);

/**
 * The earlier phrases under the box: all of them (newest first) while the box is empty, otherwise
 * the ones containing what is typed, the ones starting with it first, the match in bold.
 */
function renderHistory(typed: string): void {
  const f = normQ(typed);
  const all = getMemory().history;
  const rows = f ? all.filter((h) => h.q.toLowerCase().includes(f)).sort((a, b) => Number(b.q.toLowerCase().startsWith(f)) - Number(a.q.toLowerCase().startsWith(f))) : all;
  el.searchHistory.innerHTML = '';
  if (!rows.length) {
    el.searchHistory.classList.add('hidden');
    return;
  }
  for (const h of rows) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.setAttribute('role', 'option');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'history-q';
    b.title = `Search “${h.q}” again`;
    const i = f ? h.q.toLowerCase().indexOf(f) : -1;
    const text = i >= 0 ? `${esc(h.q.slice(0, i))}<b>${esc(h.q.slice(i, i + f.length))}</b>${esc(h.q.slice(i + f.length))}` : esc(h.q);
    b.innerHTML = `${CLOCK_ICON}<span>${text}</span>`;
    b.addEventListener('click', () => {
      el.searchInput.value = h.q;
      submitSearch();
    });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'history-del';
    x.textContent = '✕';
    x.title = 'Forget this search';
    x.setAttribute('aria-label', `Forget “${h.q}”`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      forgetSearch(h.q);
      renderHistory(el.searchInput.value);
      el.searchInput.focus();
    });
    row.append(b, x);
    el.searchHistory.appendChild(row);
  }
  if (!f && rows.length > 1) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn ghost small history-clear';
    clear.textContent = 'Clear search history';
    clear.addEventListener('click', () => {
      forgetAllSearches();
      renderHistory('');
      el.searchInput.focus();
    });
    el.searchHistory.appendChild(clear);
  }
  el.searchHistory.classList.remove('hidden');
}
function hideHistory(): void {
  el.searchHistory.classList.add('hidden');
}
el.searchInput.addEventListener('input', () => renderHistory(el.searchInput.value));
el.searchInput.addEventListener('focus', () => renderHistory(el.searchInput.value));
// ↓ from the box walks the earlier phrases; Escape in the box (the feed's keys leave inputs alone) hides them
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    const first = el.searchHistory.querySelector<HTMLButtonElement>('.history-q');
    if (first && !el.searchHistory.classList.contains('hidden')) {
      e.preventDefault();
      first.focus();
    }
  } else if (e.key === 'Escape') hideHistory();
});
el.searchHistory.addEventListener('keydown', (e) => {
  const rows = [...el.searchHistory.querySelectorAll<HTMLButtonElement>('.history-q')];
  const cur = (e.target as HTMLElement).closest('.history-row')?.querySelector<HTMLButtonElement>('.history-q');
  const i = cur ? rows.indexOf(cur) : -1;
  if (e.key === 'ArrowDown' && i >= 0 && i < rows.length - 1) {
    e.preventDefault();
    rows[i + 1].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (i > 0) rows[i - 1].focus();
    else el.searchInput.focus();
  } else if (e.key === 'Escape') {
    hideHistory();
    el.searchInput.focus();
  }
});
// a tap anywhere else in the panel (the results, the status) puts the phrases away
el.search.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('#searchForm') && !t.closest('#searchHistory')) hideHistory();
});

// ---------------------------------------------------------------- search

const search = { q: '', items: [] as FeedItem[], users: [] as UserSummary[], offset: 0, hasMore: false, busy: false, fromCache: false };
/** One tile per video id, reused when the fresh results re-order the earlier ones (no image reload) */
const tiles = new Map<string, HTMLButtonElement>();

export function openSearch(): void {
  show(el.search);
  el.searchInput.focus();
  el.searchInput.select();
  renderHistory(el.searchInput.value); // focus() fires no event in a background tab
}

function searchTile(it: FeedItem, q: string): HTMLButtonElement {
  let t = tiles.get(it.id);
  if (t) return t;
  t = videoTile(it, () => {
    closeAllPanels();
    // the index is looked up on the tap: the fresh results may have re-ordered the list since
    host.play({ kind: 'search', q, items: search.items.slice(), offset: search.offset, hasMore: search.hasMore }, Math.max(0, search.items.findIndex((x) => x.id === it.id)));
  });
  tiles.set(it.id, t);
  return t;
}
/** Puts the grid in search.items order, reusing tiles; the accounts list is replaced. */
function renderResults(q: string): void {
  el.searchUsers.innerHTML = '';
  for (const u of search.users) el.searchUsers.appendChild(userRow(u));
  const grid = el.searchVideos;
  const want = search.items.map((it) => searchTile(it, q));
  for (const child of [...grid.children]) if (!want.includes(child as HTMLButtonElement)) child.remove();
  want.forEach((t, i) => {
    if (grid.children[i] !== t) grid.insertBefore(t, grid.children[i] || null);
  });
  el.searchMore.classList.toggle('hidden', !search.hasMore || !search.items.length);
}
function fresh(text: string): void {
  el.searchFreshText.textContent = text;
  el.searchFresh.classList.toggle('hidden', !text);
}
const countText = (n: number, users: number): string => `${n} video${n === 1 ? '' : 's'}${users ? `, ${users} account${users === 1 ? '' : 's'}` : ''}`;

/** Back from a playing list to the panel it was tapped in (the results / the account stay as they were). */
export function reopenPlayList(list: PlayList): void {
  if (list.kind === 'profile') void openProfile(list.user);
  else show(el.search); // no focus: that would raise the keyboard on a phone
}

/**
 * A request that never reached the server or got no answer (the car's link dropped), as opposed to
 * the platform refusing: the server goes on with the job and keeps its answer, so asking again a
 * little later gets it.
 */
const connectionLost = (e: unknown): boolean => !(e instanceof ApiError) || e.status === 504;
const RETRY_MAX = 4;
const retryDelay = (n: number): number => Math.min(12_000, 3000 * 2 ** (n - 1));
/** The server answered with an earlier result and is fetching a fresh one: ask again after this long */
const REASK_MS = 20_000;
const REASK_MAX = 3;
let searchRetries = 0;
let searchRetryTimer = 0;
let searchReaskTimer = 0;
const searchOpen = (): boolean => !el.search.classList.contains('hidden');

/** Fresh results take over, in their order; earlier ones the search no longer returns stay at the end. */
function takeOverSearch(q: string, r: SearchResponse, more: boolean): void {
  search.offset = r.offset;
  search.hasMore = r.hasMore;
  if (!more && search.fromCache) {
    const earlier = search.items.filter((x) => !r.items.some((it) => it.id === x.id));
    search.items = [...r.items, ...earlier];
    search.users = r.users;
    search.fromCache = false;
  } else {
    if (!more) search.users = r.users;
    search.items.push(...r.items.filter((it) => !search.items.some((x) => x.id === it.id)));
  }
  renderResults(q);
  rememberSearch(q, search.items, search.users, search.offset, search.hasMore);
  const n = search.items.length;
  const age = r.cachedAgeSec !== undefined ? ` · the server's answer from ${Math.max(1, Math.round(r.cachedAgeSec / 60))} min ago; fresh results are on their way` : '';
  status(el.searchStatus, n || search.users.length ? `${countText(n, more ? 0 : search.users.length)} for “${q}”${age}` : `Nothing found for “${q}”${age}`);
  for (const w of r.warnings) console.warn('[search]', w);
}

/** The server served an earlier answer and is searching again behind it: the same request a little later brings the fresh one. */
async function reaskSearch(q: string, attempt: number): Promise<void> {
  if (search.q !== q || search.busy || !searchOpen()) return;
  search.busy = true;
  fresh('Fresh results are on their way…');
  try {
    const r = await api.search({ platform: host.platform.id, q, offset: 0 });
    if (search.q !== q) return;
    if (r.cachedAgeSec !== undefined) {
      if (attempt < REASK_MAX) searchReaskTimer = window.setTimeout(() => void reaskSearch(q, attempt + 1), REASK_MS);
      return;
    }
    search.fromCache = true; // the fresh answer takes over, what it no longer lists stays at the end
    takeOverSearch(q, r, false);
  } catch (e) {
    console.warn('[search] the fresh answer did not come:', errMsg(e));
  } finally {
    search.busy = false;
    fresh('');
  }
}

async function runSearch(q: string, more: boolean): Promise<void> {
  if (search.busy) return;
  search.busy = true;
  hideHistory();
  clearTimeout(searchRetryTimer);
  clearTimeout(searchReaskTimer);
  if (!more) {
    searchRetries = 0;
    search.q = q;
    search.items = [];
    search.users = [];
    search.offset = 0;
    search.hasMore = false;
    search.fromCache = false;
    tiles.clear();
    el.searchUsers.innerHTML = '';
    el.searchVideos.innerHTML = '';
    el.searchMore.classList.add('hidden');
    // Searched before: those results right away; the fresh search runs behind them.
    const c = cachedSearch(q);
    if (c) {
      search.fromCache = true;
      search.items = c.items.slice();
      search.users = c.users.slice();
      search.offset = c.offset;
      search.hasMore = c.hasMore;
      renderResults(q);
      status(el.searchStatus, `${countText(search.items.length, search.users.length)} for “${q}” from an earlier search · looking for fresh ones…`);
      fresh(`Searching ${host.platform.name} for fresh results…`);
    } else {
      status(el.searchStatus, `Searching for “${q}”…`);
      // the shape of what is coming, while it comes (renderResults replaces them)
      for (let i = 0; i < 6; i++) {
        const sk = document.createElement('div');
        sk.className = 'v-tile skeleton';
        sk.setAttribute('aria-hidden', 'true');
        el.searchVideos.appendChild(sk);
      }
    }
  } else status(el.searchStatus, 'Loading more…');
  try {
    const r = await api.search({ platform: host.platform.id, q, offset: more ? search.offset : 0 });
    if (search.q !== q) return;
    searchRetries = 0;
    takeOverSearch(q, r, more);
    if (r.cachedAgeSec !== undefined && !more) searchReaskTimer = window.setTimeout(() => void reaskSearch(q, 1), REASK_MS);
  } catch (e) {
    for (const sk of el.searchVideos.querySelectorAll('.skeleton')) sk.remove();
    if (connectionLost(e) && searchRetries < RETRY_MAX) {
      // The server keeps searching and keeps the answer: the same request again brings it.
      searchRetries++;
      const delay = retryDelay(searchRetries);
      status(el.searchStatus, `Connection problem (${errMsg(e)}) – the server goes on searching; asking again in ${Math.round(delay / 1000)} s…`, true);
      searchRetryTimer = window.setTimeout(() => {
        if (search.q === q && searchOpen()) void runSearch(q, more);
      }, delay);
    } else if (search.fromCache && !more) status(el.searchStatus, `Showing the earlier results for “${q}” – the fresh search failed: ${errMsg(e)}`, true);
    else status(el.searchStatus, `Search failed: ${errMsg(e)}`, true);
  } finally {
    search.busy = false;
    fresh('');
  }
}

function submitSearch(): void {
  const q = el.searchInput.value.trim();
  if (!q) return;
  hideHistory();
  el.searchInput.blur();
  pressed(el.searchGo, () => runSearch(q, false), { label: 'Searching' });
}
el.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitSearch();
});
el.searchMore.addEventListener('click', () => pressed(el.searchMore, () => runSearch(search.q, true), { label: 'Loading' }));
el.searchClose.addEventListener('click', () => hide(el.search));

// ---------------------------------------------------------------- profile

const profile = { user: '', info: undefined as UserSummary | undefined, items: [] as FeedItem[], offset: 0, hasMore: false, busy: false };

const followLabel = (s: FollowState | undefined): string => (s === 'following' ? 'Following' : s === 'friends' ? 'Friends' : s === 'requested' ? 'Requested' : 'Follow');

function renderProfileHead(): void {
  const u = profile.info;
  el.profileHandle.textContent = `@${profile.user}`;
  if (!u) return;
  el.profileHandle.textContent = `@${u.uniqueId}${u.verified ? ' ✔' : ''}`;
  if (u.avatar) el.profileAvatar.src = u.avatar;
  else el.profileAvatar.removeAttribute('src');
  el.profileNick.textContent = u.nickname || '';
  el.profileStats.innerHTML = '';
  for (const [n, label] of [
    [u.following, 'Following'],
    [u.followers, 'Followers'],
    [u.likes, 'Likes'],
    [u.videos, 'Videos'],
  ] as [number | undefined, string][]) {
    if (n === undefined) continue;
    const s = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = host.fmtCount(n);
    s.append(b, ` ${label}`);
    el.profileStats.appendChild(s);
  }
  el.profileBio.textContent = u.signature || '';
  const followed = u.followState === 'following' || u.followState === 'friends' || u.followState === 'requested';
  el.profileFollow.textContent = followLabel(u.followState);
  el.profileFollow.classList.toggle('primary', !followed);
  el.profileFollow.classList.toggle('on', followed);
  el.profileFollow.title = host.isLoggedIn() ? '' : 'Sign in (Profile) to follow accounts';
}

export async function openProfile(user: string): Promise<void> {
  const handle = user.replace(/^@/, '').trim();
  if (!handle) return;
  show(el.profile);
  if (profile.user.toLowerCase() === handle.toLowerCase() && profile.info) return;
  profile.user = handle;
  profile.info = undefined;
  profile.items = [];
  profile.offset = 0;
  profile.hasMore = false;
  el.profileVideos.innerHTML = '';
  el.profileMore.classList.add('hidden');
  el.profileAvatar.removeAttribute('src');
  el.profileNick.textContent = '';
  el.profileStats.innerHTML = '';
  el.profileBio.textContent = '';
  renderProfileHead();
  await loadProfile(false);
}

let profileRetries = 0;
let profileRetryTimer = 0;
let profileReaskTimer = 0;
const profileOpen = (): boolean => !el.profile.classList.contains('hidden');

/** The server served the account's earlier page and is loading it again: the fresh page's new videos go to the top. */
async function reaskProfile(user: string, attempt: number): Promise<void> {
  if (profile.user !== user || profile.busy || !profileOpen()) return;
  profile.busy = true;
  try {
    const r = await api.profile({ platform: host.platform.id, user, offset: 0, count: 24 });
    if (profile.user !== user) return;
    if (r.cachedAgeSec !== undefined) {
      if (attempt < REASK_MAX) profileReaskTimer = window.setTimeout(() => void reaskProfile(user, attempt + 1), REASK_MS);
      return;
    }
    profile.info = r.user;
    renderProfileHead();
    const fresh = r.items.filter((it) => !profile.items.some((x) => x.id === it.id));
    if (!fresh.length) return;
    profile.items.unshift(...fresh);
    const tiles = fresh.map((it, i) =>
      videoTile(it, () => {
        closeAllPanels();
        host.play({ kind: 'profile', user, items: profile.items.slice(), offset: profile.offset, hasMore: profile.hasMore }, i);
      }),
    );
    el.profileVideos.prepend(...tiles);
  } catch (e) {
    console.warn('[profile] the fresh page did not come:', errMsg(e));
  } finally {
    profile.busy = false;
  }
}

async function loadProfile(more: boolean): Promise<void> {
  if (profile.busy) return;
  profile.busy = true;
  clearTimeout(profileRetryTimer);
  clearTimeout(profileReaskTimer);
  if (!more) profileRetries = 0;
  const user = profile.user;
  status(el.profileStatus, more ? 'Loading more videos…' : `Loading @${user}… (the server opens the account page)`);
  try {
    const r = await api.profile({ platform: host.platform.id, user, offset: more ? profile.offset : 0, count: 24 });
    if (profile.user !== user) return;
    profileRetries = 0;
    if (r.cachedAgeSec !== undefined && !more) profileReaskTimer = window.setTimeout(() => void reaskProfile(user, 1), REASK_MS);
    profile.info = r.user;
    profile.offset = r.offset + r.items.length;
    profile.hasMore = r.hasMore;
    renderProfileHead();
    if (r.user.followState && r.user.followState !== 'unknown') host.onFollowState?.(r.user.uniqueId, r.user.followState);
    const base = profile.items.length;
    const fresh = r.items.filter((it) => !profile.items.some((x) => x.id === it.id));
    profile.items.push(...fresh);
    fresh.forEach((it, i) =>
      el.profileVideos.appendChild(
        videoTile(it, () => {
          closeAllPanels();
          host.play({ kind: 'profile', user, items: profile.items.slice(), offset: profile.offset, hasMore: profile.hasMore }, base + i);
        }),
      ),
    );
    el.profileMore.classList.toggle('hidden', !profile.hasMore || !fresh.length);
    status(el.profileStatus, profile.items.length ? '' : r.warnings[0] || 'No videos to show');
    for (const w of r.warnings) console.warn('[profile]', w);
  } catch (e) {
    if (connectionLost(e) && profileRetries < RETRY_MAX) {
      profileRetries++;
      const delay = retryDelay(profileRetries);
      status(el.profileStatus, `Connection problem (${errMsg(e)}) – the server goes on loading @${user}; asking again in ${Math.round(delay / 1000)} s…`, true);
      profileRetryTimer = window.setTimeout(() => {
        if (profile.user === user && profileOpen()) void loadProfile(more);
      }, delay);
    } else status(el.profileStatus, `Could not load @${user}: ${errMsg(e)}`, true);
  } finally {
    profile.busy = false;
  }
}

el.profileClose.addEventListener('click', () => hide(el.profile));
el.profileMore.addEventListener('click', () => pressed(el.profileMore, () => loadProfile(true), { label: 'Loading' }));
el.profileFollow.addEventListener('click', () => {
  const u = profile.info;
  if (!u) return;
  if (!host.isLoggedIn()) {
    host.toast('Sign in to TikTok first to follow accounts', true, 4000);
    void host.openSessionPanel();
    return;
  }
  const followed = u.followState === 'following' || u.followState === 'friends' || u.followState === 'requested';
  pressed(
    el.profileFollow,
    async () => {
      try {
        const r = await api.follow({ user: u.uniqueId, follow: !followed });
        u.followState = r.followState;
        renderProfileHead();
        host.onFollowState?.(u.uniqueId, r.followState);
        host.toast(r.followState === 'none' ? `Unfollowed @${u.uniqueId}` : `${followLabel(r.followState)} @${u.uniqueId}`);
        for (const w of r.warnings) console.warn('[follow]', w);
      } catch (e) {
        host.toast(`Follow failed: ${errMsg(e)}`, true, 6000);
      }
    },
    { label: followed ? 'Unfollowing' : 'Following' },
  );
});
el.profileMessage.addEventListener('click', () => {
  if (!profile.info) return;
  if (!host.isLoggedIn()) {
    host.toast('Sign in to TikTok first to send messages', true, 4000);
    void host.openSessionPanel();
    return;
  }
  void openInbox('@' + profile.info.uniqueId);
});

// ---------------------------------------------------------------- inbox

const inbox = { conversation: undefined as Conversation | undefined, threadId: '', busy: false };

function renderConversations(list: Conversation[]): void {
  el.inboxList.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'conv-row' + (c.unread ? ' unread' : '');
    const img = document.createElement('img');
    if (c.avatar) img.src = c.avatar;
    img.alt = '';
    img.loading = 'lazy';
    b.appendChild(img);
    const d = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'c-title';
    t.textContent = c.title;
    const s = document.createElement('div');
    s.className = 'c-sub';
    s.textContent = c.preview || '';
    d.append(t, s);
    b.appendChild(d);
    if (c.time) {
      const tm = document.createElement('span');
      tm.className = 'c-time';
      tm.textContent = c.time;
      b.appendChild(tm);
    }
    b.addEventListener('click', () => void openThread(c.id, c.title));
    el.inboxList.appendChild(b);
  }
}

function renderMessages(list: ChatMessage[]): void {
  el.inboxMessages.innerHTML = '';
  for (const m of list) {
    const d = document.createElement('div');
    d.className = `msg ${m.from}`;
    if (m.link) {
      const a = document.createElement('a');
      a.href = m.link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = m.text || m.link;
      d.appendChild(a);
    } else d.textContent = m.text;
    if (m.time) {
      const t = document.createElement('span');
      t.className = 'm-time';
      t.textContent = m.time;
      d.appendChild(t);
    }
    el.inboxMessages.appendChild(d);
  }
  el.inboxMessages.lastElementChild?.scrollIntoView({ block: 'end' });
}

function showList(): void {
  inbox.threadId = '';
  inbox.conversation = undefined;
  el.inboxTitle.textContent = 'Messages';
  el.inboxBack.classList.add('hidden');
  el.inboxThread.classList.add('hidden');
  el.inboxList.classList.remove('hidden');
}

async function loadInbox(): Promise<void> {
  if (inbox.busy) return;
  inbox.busy = true;
  status(el.inboxStatus, 'Reading your messages… (the server opens TikTok’s inbox)');
  try {
    const r = await api.inbox();
    renderConversations(r.conversations);
    status(el.inboxStatus, r.conversations.length ? '' : r.warnings[0] || 'No conversations', !r.conversations.length && !/no conversations/i.test(r.warnings[0] || ''));
    for (const w of r.warnings) console.warn('[inbox]', w);
  } catch (e) {
    status(el.inboxStatus, `Messages could not be read: ${errMsg(e)}`, true);
  } finally {
    inbox.busy = false;
  }
}

async function openThread(id: string, title?: string): Promise<void> {
  if (inbox.busy) return;
  inbox.busy = true;
  inbox.threadId = id;
  el.inboxTitle.textContent = title || id.replace(/^\d+:/, '');
  el.inboxBack.classList.remove('hidden');
  el.inboxList.classList.add('hidden');
  el.inboxThread.classList.remove('hidden');
  el.inboxMessages.innerHTML = '';
  status(el.inboxStatus, 'Opening the conversation…');
  try {
    const r = await api.inboxOpen(id);
    if (inbox.threadId !== id) return;
    inbox.conversation = r.conversation;
    inbox.threadId = r.conversation.id || id;
    el.inboxTitle.textContent = r.conversation.title || title || id;
    renderMessages(r.messages);
    el.inboxForm.classList.toggle('hidden', !r.canSend);
    status(el.inboxStatus, r.messages.length ? '' : r.warnings[0] || 'No messages yet');
    for (const w of r.warnings) console.warn('[inbox]', w);
    if (r.canSend) el.inboxText.focus();
  } catch (e) {
    status(el.inboxStatus, `Could not open the conversation: ${errMsg(e)}`, true);
  } finally {
    inbox.busy = false;
  }
}

export async function openInbox(threadId?: string): Promise<void> {
  if (!host.isLoggedIn()) {
    host.toast('Sign in to TikTok first to see your messages', true, 4000);
    await host.openSessionPanel();
    return;
  }
  show(el.inbox);
  if (threadId) await openThread(threadId, threadId.replace(/^@/, '@'));
  else {
    showList();
    await loadInbox();
  }
}

el.inboxClose.addEventListener('click', () => hide(el.inbox));
el.inboxBack.addEventListener('click', () => {
  showList();
  void loadInbox();
});
el.inboxRefresh.addEventListener('click', () => pressed(el.inboxRefresh, () => (inbox.threadId ? openThread(inbox.threadId, inbox.conversation?.title) : loadInbox()), { label: 'Refreshing' }));
el.inboxForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.inboxText.value.trim();
  const id = inbox.threadId;
  if (!text || !id) return;
  pressed(
    el.inboxSend,
    async () => {
      status(el.inboxStatus, 'Sending…');
      try {
        const r = await api.inboxSend({ id, text });
        if (inbox.threadId !== id && inbox.threadId !== r.conversation.id) return;
        inbox.conversation = r.conversation;
        inbox.threadId = r.conversation.id || id;
        renderMessages(r.messages);
        if (r.sent) {
          el.inboxText.value = '';
          status(el.inboxStatus, '');
        } else status(el.inboxStatus, r.warnings[r.warnings.length - 1] || 'The message does not show in the thread yet', true);
      } catch (e2) {
        status(el.inboxStatus, `Send failed: ${errMsg(e2)}`, true);
      }
    },
    { label: 'Sending' },
  );
});

export function initSocial(h: SocialHost): void {
  host = h;
  const p = h.platform;
  el.searchInput.placeholder = p.searchPlaceholder;
  // Follow and messages exist on TikTok only; the other platforms show the account's videos.
  el.profileFollow.classList.toggle('hidden', !p.social);
  el.profileMessage.classList.toggle('hidden', !p.social);
}
