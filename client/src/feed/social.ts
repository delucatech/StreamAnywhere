/**
 * The feed page's social panels: search, account profiles (with follow and the account's videos)
 * and messages. All data comes from the server's headless TikTok session (server/src/social.ts);
 * search and profiles work signed out, follow and messages need the signed-in account. Instagram
 * (server/src/instagram.ts) has search, profiles and follow, always signed in.
 *
 * The panels do not play anything themselves: a tapped video hands a play list (the search results
 * or the account's videos, with the continuation) to the feed through SocialHost.play().
 *
 * Search remembers, per platform and on this device (localStorage): the phrases searched, shown
 * under the box while typing (filtered by what is typed) with a × to forget one, and the results
 * of the recent ones. A phrase searched again shows its earlier results at once and the fresh
 * search runs behind them (a status at the end of the list says so); fresh results then take over.
 */
import type { ChatMessage, Conversation, FeedItem, FollowState, SearchResponse, UserSummary, VideoComment } from '../../../shared/types';
import { serverStep } from '../activity';
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
  /**
   * The comments sheet is on screen: true the moment it starts to open, false once it has slid
   * away. The video goes on as it was above the sheet (it is not a panel: nothing pauses), and
   * meanwhile the feed must not move to another video by itself.
   */
  onCommentsHold(held: boolean): void;
  /**
   * Where the video in view is on the page, when the comments sheet belongs over that video alone
   * (wide screens: the video is a card in the middle); undefined when the sheet takes the screen (phones).
   */
  videoCard?(): { left: number; top: number; width: number; height: number } | undefined;
  /**
   * The place beside the video where the comments go instead of over it (wide screens: the column
   * of the Up next list, which they cover while they are open); undefined when there is none (a
   * phone, a window too narrow for that column). The video then stays whole and usable beside them.
   */
  commentsSide?(): { left: number; top: number; width: number; height: number } | undefined;
  /**
   * What the comments sheet leaves of the page for the video, from `top` to `bottom` (px from the
   * top of the window), each time the sheet moves: the host fits the picture into it, so the video
   * is still watched above the comments. `animate`: the sheet is sliding there (SHEET_MS, the same
   * curve); otherwise it follows a finger and the picture follows at once.
   */
  onCommentsView?(view: { top: number; bottom: number }, animate: boolean): void;
  /** Which platform the panels search and browse (follow: TikTok and Instagram; messages and comments: TikTok only) */
  platform: PlatformDef;
  /** The signed-in account's follow state of an account became known (a profile opened, a follow pressed) */
  onFollowState?(user: string, state: FollowState): void;
  /** What the page knows of the signed-in account's follow state of a video's author (its "+" badge) */
  followState?(author: FeedItem['author']): FollowState | undefined;
  /** The search or account panel closed (its list may be playing behind it) */
  onPanelClosed?(kind: 'search' | 'profile'): void;
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
  inboxCancel: $<HTMLButtonElement>('inboxCancel'),
  comments: $('comments'),
  commentsFrame: $('commentsFrame'),
  commentsSheet: $('commentsSheet'),
  commentsGrab: $('commentsGrab'),
  commentsBody: $('commentsBody'),
  commentsClose: $<HTMLButtonElement>('commentsClose'),
  commentsTitle: $('commentsTitle'),
  commentsRefresh: $<HTMLButtonElement>('commentsRefresh'),
  commentsCancel: $<HTMLButtonElement>('commentsCancel'),
  commentsStatus: $('commentsStatus'),
  commentsList: $('commentsList'),
  commentsLoading: $('commentsLoading'),
  commentsLoadingTitle: $('commentsLoadingTitle'),
  commentsLoadingDetail: $('commentsLoadingDetail'),
  commentsMore: $<HTMLButtonElement>('commentsMore'),
  sideTabs: $('sideTabs'),
  sideAuthor: $<HTMLButtonElement>('sideAuthor'),
  sideAvatar: $<HTMLImageElement>('sideAvatar'),
  sideHandle: $('sideHandle'),
  sideNick: $('sideNick'),
  sideStats: $('sideStats'),
  sideDesc: $('sideDesc'),
  sideFollow: $<HTMLButtonElement>('sideFollow'),
  sideClose: $<HTMLButtonElement>('sideClose'),
  sideTabComments: $<HTMLButtonElement>('sideTabComments'),
  sideTabVideos: $<HTMLButtonElement>('sideTabVideos'),
  sideRefresh: $<HTMLButtonElement>('sideRefresh'),
  sideCancel: $<HTMLButtonElement>('sideCancel'),
  sideVideos: $('sideVideos'),
  sideVideosStatus: $('sideVideosStatus'),
  sideVideosGrid: $('sideVideosGrid'),
  sideVideosLoading: $('sideVideosLoading'),
  sideVideosLoadingTitle: $('sideVideosLoadingTitle'),
  sideVideosMore: $<HTMLButtonElement>('sideVideosMore'),
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
  if (panel === el.profile) host.onPanelClosed?.('profile');
  else if (panel === el.search) host.onPanelClosed?.('search');
  else if (panel === el.inbox) cancelInboxRead(); // nobody waits for the messages any more: the server stops reading them
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
    x.textContent = '×';
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

/**
 * Another account is the active one: the results on show and the kept ones were found as the
 * previous account (its follow states, its video addresses). The phrases searched stay.
 */
export function forgetAccountResults(): void {
  memory = undefined; // read again from storage, where the results were emptied (accountVideos.ts)
  window.clearTimeout(searchReaskTimer);
  Object.assign(search, { q: '', items: [], users: [], offset: 0, hasMore: false, fromCache: false });
  tiles.clear();
  el.searchUsers.innerHTML = '';
  el.searchVideos.innerHTML = '';
  el.searchMore.classList.add('hidden');
  fresh('');
  status(el.searchStatus, '');
  Object.assign(profile, { user: '', info: undefined, items: [], offset: 0, hasMore: false });
}

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
  // how the server searched, where it says so (TikTok): asked directly, or in its signed-in browser
  const via = r.cachedAgeSec !== undefined ? '' : r.via === 'direct' ? ' · asked directly, no browser' : r.via === 'browser' ? " · searched in the server's browser" : '';
  status(el.searchStatus, n || search.users.length ? `${countText(n, more ? 0 : search.users.length)} for “${q}”${age}${via}` : `Nothing found for “${q}”${age}${via}`);
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
  status(el.profileStatus, more ? 'Loading more videos…' : `Loading @${user}…`);
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
    host.toast(`Sign in to ${host.platform.name} first to follow accounts`, true, 4000);
    void host.openSessionPanel();
    return;
  }
  const followed = u.followState === 'following' || u.followState === 'friends' || u.followState === 'requested';
  pressed(
    el.profileFollow,
    async () => {
      try {
        const r = await api.follow({ platform: host.platform.id, user: u.uniqueId, id: u.id, follow: !followed });
        u.followState = r.followState;
        renderProfileHead();
        host.onFollowState?.(u.uniqueId, r.followState);
        if (r.via) console.info(`[follow] @${u.uniqueId}: ${r.followState} · ${r.via === 'direct' ? 'asked directly, no browser' : "pressed in the server's browser"}`);
        // "none" after asking to follow = it did not take (the server's warning says why)
        host.toast(`${r.followState === 'none' ? (followed ? `Unfollowed @${u.uniqueId}` : `Could not follow @${u.uniqueId}`) : r.followState === 'requested' ? `Follow request sent to @${u.uniqueId}` : `${followLabel(r.followState)} @${u.uniqueId}`}${r.via === 'direct' ? ' · asked directly, no browser' : ''}`, r.followState === 'none' && !followed);
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

/**
 * Reading the list or a thread takes a while (the server drives TikTok's messages page in its
 * headless browser), so every read can be cancelled: Cancel in the header, Back, closing the
 * panel, or starting another read. The cancel aborts this browser's request AND tells the server
 * (POST /api/inbox/cancel) to stop the page work, so the next read is not queued behind it.
 * `seq` tells a stale answer (of a read that was replaced) from the current one.
 */
const inbox = { conversation: undefined as Conversation | undefined, threadId: '', busy: false, ctl: undefined as AbortController | undefined, seq: 0 };

/** Header: Cancel while a read runs, Refresh otherwise. */
function inboxBusy(busy: boolean): void {
  inbox.busy = busy;
  el.inboxRefresh.classList.toggle('hidden', busy);
  el.inboxCancel.classList.toggle('hidden', !busy);
}

/** Starts a read: the previous one (if any) is cancelled first. Returns what the read checks itself against. */
function beginRead(): { seq: number; signal: AbortSignal } {
  cancelInboxRead();
  const ctl = new AbortController();
  inbox.ctl = ctl;
  inboxBusy(true);
  return { seq: ++inbox.seq, signal: ctl.signal };
}
/** The read is over (answered, failed or cancelled); only the current one touches the panel state. */
function endRead(seq: number): boolean {
  if (seq !== inbox.seq) return false;
  inbox.ctl = undefined;
  inboxBusy(false);
  return true;
}
/** Stops the read in flight here and on the server; false when none runs. */
function cancelInboxRead(): boolean {
  const ctl = inbox.ctl;
  if (!ctl) return false;
  inbox.ctl = undefined;
  inboxBusy(false);
  ctl.abort();
  void api.inboxCancel().catch((e) => console.warn('[inbox] cancel not delivered:', errMsg(e)));
  return true;
}

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
  const { seq, signal } = beginRead();
  status(el.inboxStatus, 'Reading your messages… (the server opens TikTok’s inbox)');
  try {
    const r = await api.inbox(signal);
    if (!endRead(seq)) return;
    renderConversations(r.conversations);
    status(el.inboxStatus, r.conversations.length ? '' : r.warnings[0] || 'No conversations', !r.conversations.length && !/no conversations/i.test(r.warnings[0] || ''));
    for (const w of r.warnings) console.warn('[inbox]', w);
  } catch (e) {
    if (!endRead(seq) || signal.aborted) return; // replaced or cancelled: whoever did it set the status
    status(el.inboxStatus, `Messages could not be read: ${errMsg(e)}`, true);
  }
}

async function openThread(id: string, title?: string): Promise<void> {
  const { seq, signal } = beginRead();
  inbox.threadId = id;
  el.inboxTitle.textContent = title || id.replace(/^\d+:/, '');
  el.inboxBack.classList.remove('hidden');
  el.inboxList.classList.add('hidden');
  el.inboxThread.classList.remove('hidden');
  el.inboxMessages.innerHTML = '';
  el.inboxForm.classList.add('hidden');
  status(el.inboxStatus, 'Opening the conversation…');
  try {
    const r = await api.inboxOpen(id, signal);
    if (!endRead(seq) || inbox.threadId !== id) return;
    inbox.conversation = r.conversation;
    inbox.threadId = r.conversation.id || id;
    el.inboxTitle.textContent = r.conversation.title || title || id;
    renderMessages(r.messages);
    el.inboxForm.classList.toggle('hidden', !r.canSend);
    status(el.inboxStatus, r.messages.length ? '' : r.warnings[0] || 'No messages yet');
    for (const w of r.warnings) console.warn('[inbox]', w);
    if (r.canSend) el.inboxText.focus();
  } catch (e) {
    if (!endRead(seq) || signal.aborted) return;
    status(el.inboxStatus, `Could not open the conversation: ${errMsg(e)}`, true);
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
  cancelInboxRead();
  showList();
  void loadInbox();
});
el.inboxRefresh.addEventListener('click', () => void (inbox.threadId ? openThread(inbox.threadId, inbox.conversation?.title) : loadInbox()));
el.inboxCancel.addEventListener('click', () => {
  if (cancelInboxRead()) status(el.inboxStatus, inbox.threadId ? 'Stopped. Refresh opens the conversation again.' : 'Stopped. Refresh reads your messages again.');
});
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

// ---------------------------------------------------------------- comments

/**
 * The comments of a video (the bubble beside it). The server asks TikTok for them as a guest, without
 * a browser (about a second, no TikTok sign-in needed); when TikTok does not answer that, it reads
 * them from its signed-in TikTok page, which takes a while. So, like the inbox, the read shows
 * Cancel and is stopped (here and on the server, POST /api/comments/cancel) by Cancel, closing the
 * sheet, or a new read.
 *
 * They show in a sheet that slides up over the lower two thirds of the video (see "the sheet" below);
 * it is not one of the panels above: the video is neither paused nor covered.
 */
const comments = { item: undefined as FeedItem | undefined, /** The video (id) whose comments were asked for, so a tab shown again does not ask twice */ asked: '', list: [] as VideoComment[], cursor: 0, hasMore: false, total: undefined as number | undefined, ctl: undefined as AbortController | undefined, seq: 0 };

function commentsBusy(busy: boolean): void {
  el.commentsRefresh.classList.toggle('hidden', busy);
  el.commentsCancel.classList.toggle('hidden', !busy);
  // (the same pair beside the video, on its Comments tab)
  el.sideRefresh.classList.toggle('hidden', busy || side.tab !== 'comments');
  el.sideCancel.classList.toggle('hidden', !busy || side.tab !== 'comments');
  el.commentsMore.disabled = busy;
}
function beginCommentsRead(): { seq: number; signal: AbortSignal } {
  cancelCommentsRead();
  const ctl = new AbortController();
  comments.ctl = ctl;
  commentsBusy(true);
  return { seq: ++comments.seq, signal: ctl.signal };
}
function endCommentsRead(seq: number): boolean {
  if (seq !== comments.seq) return false;
  comments.ctl = undefined;
  commentsBusy(false);
  return true;
}
/** Stops the comments read in flight here and on the server; false when none runs. */
function cancelCommentsRead(): boolean {
  const ctl = comments.ctl;
  if (!ctl) return false;
  comments.ctl = undefined;
  commentsBusy(false);
  ctl.abort();
  void api.commentsCancel().catch((e) => console.warn('[comments] cancel not delivered:', errMsg(e)));
  return true;
}

const whenOf = (c: VideoComment): string => {
  if (c.when) return c.when;
  if (!c.time) return '';
  const s = Math.max(0, Date.now() / 1000 - c.time);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(c.time * 1000).toLocaleDateString();
};

/**
 * "View 3 replies" under a comment: each tap asks the server for the next few (TikTok hands out a
 * handful per page) and lists them, indented, under the comment; once all are there the button
 * hides and shows them. A read the panel cancels (a new comments read, Cancel) just stops.
 */
function repliesBlock(c: VideoComment, item: FeedItem): HTMLElement {
  const total = c.replies || 0;
  const wrap = document.createElement('div');
  wrap.className = 'c-replies';
  const list = document.createElement('div');
  list.className = 'c-replies-list';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'c-replies-btn';
  const plural = (n: number): string => `${host.fmtCount(n)} ${n === 1 ? 'reply' : 'replies'}`;
  const state = { cursor: 0, shown: 0, hasMore: true, busy: false, hidden: false };
  const label = (): void => {
    btn.textContent = state.busy ? 'Reading the replies…' : !state.shown ? `View ${plural(total)}` : state.hasMore ? `More replies (${state.shown} of ${host.fmtCount(Math.max(total, state.shown))})` : state.hidden ? `Show ${plural(state.shown)}` : 'Hide replies';
  };
  label();
  btn.addEventListener('click', () => {
    if (state.busy) return;
    if (state.shown && !state.hasMore) {
      state.hidden = !state.hidden;
      list.classList.toggle('hidden', state.hidden);
      label();
      return;
    }
    state.busy = true;
    label();
    void api
      .commentReplies({ platform: host.platform.id, id: item.id, commentId: c.id, cursor: state.cursor })
      .then((r) => {
        for (const reply of r.comments) list.appendChild(commentRow(reply, undefined));
        state.shown += r.comments.length;
        state.cursor = r.cursor;
        state.hasMore = r.hasMore && r.comments.length > 0;
        state.busy = false;
        label();
        if (!state.shown) btn.textContent = 'No replies to show';
      })
      .catch((e) => {
        state.busy = false;
        label();
        if (e instanceof ApiError && e.status === 499) return; // the panel stopped its reads
        btn.textContent = 'Replies could not be read. Tap to try again';
        console.warn('[comments] replies:', errMsg(e));
      });
  });
  wrap.append(btn, list);
  return wrap;
}

/** One comment's row; `item` (the video) makes its reply count a button that lists the replies - left out for a reply's own row. */
function commentRow(c: VideoComment, item: FeedItem | undefined): HTMLElement {
  const row = document.createElement('div');
  row.className = item ? 'comment-row' : 'comment-row reply';
  const img = document.createElement('img');
  if (c.user.avatar) img.src = c.user.avatar;
  img.alt = '';
  img.loading = 'lazy';
  img.draggable = false;
  row.appendChild(img);
  const body = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'c-name';
  name.textContent = c.user.nickname || (c.user.uniqueId ? '@' + c.user.uniqueId : '');
  if (c.byAuthor) {
    const a = document.createElement('span');
    a.className = 'c-author';
    a.textContent = 'Creator';
    name.appendChild(a);
  }
  const text = document.createElement('div');
  text.className = 'c-text';
  text.textContent = c.text;
  const meta = document.createElement('div');
  meta.className = 'c-meta';
  // The replies can be fetched for a comment with a real id (not one read off the page's DOM), on TikTok.
  const canList = Boolean(item && c.replies && /^\d{5,30}$/.test(c.id) && host.platform.id === 'tiktok');
  const parts = [whenOf(c), c.likes ? `${host.fmtCount(c.likes)} likes` : '', c.replies && !canList && item ? `${host.fmtCount(c.replies)} ${c.replies === 1 ? 'reply' : 'replies'}` : ''].filter(Boolean);
  for (const p of parts) {
    const s = document.createElement('span');
    s.textContent = p;
    meta.appendChild(s);
  }
  body.append(name, text, meta);
  if (canList && item) body.appendChild(repliesBlock(c, item));
  row.appendChild(body);
  return row;
}

function renderComments(list: VideoComment[], append: boolean): void {
  if (!append) el.commentsList.innerHTML = '';
  for (const c of list) el.commentsList.appendChild(commentRow(c, comments.item));
}

function commentsTitle(): void {
  const n = comments.total ?? comments.item?.stats.comments;
  el.commentsTitle.textContent = n !== undefined ? `${host.fmtCount(n)} comments` : 'Comments';
  el.sideTabComments.textContent = n !== undefined ? `Comments ${host.fmtCount(n)}` : 'Comments';
}

// While the comments are read the sheet says so itself, in the list where they are about to be
// (and under the ones on show for "More comments"), with the step the server is on and a clock -
// not on the status line, which sits above the sheet, over the video.
let commentsLoadingTimer = 0;
function showCommentsLoading(more: boolean): void {
  window.clearInterval(commentsLoadingTimer);
  const t0 = Date.now();
  let step = '';
  let askedAt = 0;
  el.commentsLoading.classList.toggle('more', more);
  el.commentsLoading.classList.remove('hidden');
  el.commentsLoadingTitle.textContent = more ? 'Loading more comments…' : 'Loading the comments…';
  const render = (): void => {
    const waited = Date.now() - t0;
    el.commentsLoadingDetail.textContent = [step, waited >= 3000 ? `${Math.round(waited / 1000)} s` : ''].filter(Boolean).join(' · ');
  };
  const timer = window.setInterval(() => {
    render();
    // what the server is doing about it, once the answer is not there at once
    if (Date.now() - t0 < 700 || askedAt) return;
    askedAt = Date.now();
    void serverStep('POST /api/comments').then((s) => {
      if (commentsLoadingTimer !== timer) return;
      if (s !== undefined) step = s;
      render();
      window.setTimeout(() => (askedAt = 0), Math.max(0, 1500 - (Date.now() - askedAt)));
    });
  }, 500);
  commentsLoadingTimer = timer;
  render();
}
function hideCommentsLoading(): void {
  window.clearInterval(commentsLoadingTimer);
  commentsLoadingTimer = 0;
  el.commentsLoading.classList.add('hidden');
}

async function loadComments(more: boolean): Promise<void> {
  const item = comments.item;
  if (!item?.author.uniqueId) return;
  const { seq, signal } = beginCommentsRead();
  comments.asked = item.id;
  if (!more) {
    comments.list = [];
    comments.cursor = 0;
    comments.hasMore = false;
    el.commentsList.innerHTML = '';
    el.commentsMore.classList.add('hidden');
  }
  status(el.commentsStatus, '');
  showCommentsLoading(more);
  try {
    // (quiet: the sheet shows this wait itself, see showCommentsLoading)
    const r = await api.comments({ platform: host.platform.id, id: item.id, author: item.author.uniqueId, cursor: more ? comments.cursor : 0 }, signal, { label: 'Loading the comments', quiet: () => true });
    if (!endCommentsRead(seq) || comments.item !== item) return;
    comments.list = more ? comments.list.concat(r.comments) : r.comments;
    comments.cursor = r.cursor;
    comments.hasMore = r.hasMore && r.comments.length > 0;
    if (r.total !== undefined) comments.total = r.total;
    commentsTitle();
    renderComments(r.comments, more);
    el.commentsMore.classList.toggle('hidden', !comments.hasMore);
    status(el.commentsStatus, comments.list.length ? '' : r.warnings[0] || 'No comments yet', !comments.list.length && !/no comments yet/i.test(r.warnings[0] || ''));
    for (const w of r.warnings) console.warn('[comments]', w);
  } catch (e) {
    if (!endCommentsRead(seq) || signal.aborted) return;
    if (e instanceof ApiError && e.status === 401 && !host.isLoggedIn()) {
      status(el.commentsStatus, 'Sign in to TikTok first (Profile) to read comments.', true);
      return;
    }
    status(el.commentsStatus, `Comments could not be read: ${errMsg(e)}`, true);
  } finally {
    // (a newer read has its own notice on show: that one stays)
    if (seq === comments.seq) hideCommentsLoading();
  }
}

// ---- the sheet
// Wide screens with the Up next column on show: the comments take that column, top to bottom
// (SocialHost.commentsSide), and the video beside them stays as it is - whole, and still tapped,
// paused and swiped (the layer lets everything outside the sheet through). The list of next videos
// is back when they close. Everywhere else:
// It slides up from the bottom of its frame (the screen on phones, the video's card on wide screens
// without that column) to SHEET_SHARE of it, so the video stays in view above. The grab area (handle + header) drags it:
// down to close, up to the tall position (the frame less a strip of video at the top). A tap beside
// the sheet, the close button and Escape / C (feed.ts) close it too. From the moment it starts to
// open until it has slid away the host holds the feed on this video (SocialHost.onCommentsHold).
// The slide is a CSS transition; its end is a timer here, so a page that renders nothing (a hidden
// tab) still ends up open or closed.
/** How long the sheet takes to slide to a position (feed.css .sheet.settling uses the same) */
const SHEET_MS = 340;
/** The share of its frame the sheet covers when it opens */
const SHEET_SHARE = 0.66;
/** px of video that stay in view above the sheet when it is pulled all the way up (feed.css .sheet-frame: its top padding, less the safe area) */
const SHEET_STRIP = 120;
/** A release faster than this (px per ms) is a flick: the sheet goes one position on in that direction */
const SHEET_FLICK = 0.5;
interface SheetDrag {
  id: number;
  y0: number;
  /** The sheet's height in view when it was grabbed */
  h0: number;
  moved: boolean;
  /** The last moves, for the release speed */
  samples: { y: number; t: number }[];
}
const sheet = {
  state: 'closed' as 'closed' | 'opening' | 'open' | 'closing',
  /** Pulled up to the tall position */
  tall: false,
  /** Beside the video (over the Up next column) instead of over it */
  side: false,
  timer: 0,
  /** px: the height it opens to, and the tall one */
  rest: 0,
  max: 0,
  /** px of the sheet in view right now (0 = out of view) */
  shown: 0,
  /** px from the top of the window: where the video's room above the sheet begins, and the frame's lower edge */
  viewTop: 0,
  frameBottom: 0,
  drag: undefined as SheetDrag | undefined,
};

/** Places the frame (over the video's card, or the whole screen) and works out the two heights. */
function sheetMeasure(): void {
  const f = el.commentsFrame;
  const beside = host.commentsSide?.();
  const card = beside ? undefined : host.videoCard?.();
  const place = beside ?? card;
  sheet.side = !!beside;
  f.classList.toggle('side', !!beside);
  el.comments.classList.toggle('side', !!beside);
  f.classList.toggle('card', !!card);
  if (place) {
    const o = el.comments.getBoundingClientRect();
    f.style.left = `${Math.round(place.left - o.left)}px`;
    f.style.top = `${Math.round(place.top - o.top)}px`;
    f.style.width = `${Math.round(place.width)}px`;
    f.style.height = `${Math.round(place.height)}px`;
  } else f.style.left = f.style.top = f.style.width = f.style.height = '';
  // the frame's top padding is the strip of video the tall sheet leaves (none beside the video)
  const pad = parseFloat(getComputedStyle(f).paddingTop) || 0;
  const room = f.clientHeight - pad;
  sheet.max = Math.max(160, Math.round(room));
  // beside the video the comments take the whole column: one position, nothing to pull up to
  sheet.rest = beside ? sheet.max : Math.min(sheet.max, Math.max(160, Math.round(f.clientHeight * SHEET_SHARE)));
  // the video's room starts under the notch / status bar (the padding is that plus SHEET_STRIP)
  const box = f.getBoundingClientRect();
  sheet.viewTop = box.top + Math.max(0, pad - SHEET_STRIP);
  sheet.frameBottom = box.bottom;
  // (no longer beside the video - the window shrank: the sheet is the comments alone)
  if (!sheet.side && side.tab !== 'comments') setSideTab('comments');
}
/** Shows `h` px of the sheet: up to the resting height it slides, above it it grows. */
function sheetPlace(h: number, animate: boolean): void {
  const s = el.commentsSheet;
  h = Math.max(0, Math.min(sheet.max, h));
  sheet.shown = h;
  s.classList.toggle('settling', animate);
  s.style.height = `${Math.max(sheet.rest, h)}px`;
  s.style.transform = `translate3d(0, ${Math.max(0, sheet.rest - h)}px, 0)`;
  // (beside the video nothing of it is covered: the picture stays - or goes back - where it was)
  host.onCommentsView?.(sheet.side ? { top: 0, bottom: Number.MAX_SAFE_INTEGER } : { top: sheet.viewTop, bottom: sheet.frameBottom - h }, animate && !sheet.side);
}
/** Slides the sheet to one of its positions and calls `then` when it is there. */
function sheetSettle(h: number, then?: () => void): void {
  clearTimeout(sheet.timer);
  sheetPlace(h, true);
  sheet.timer = window.setTimeout(() => {
    sheet.timer = 0;
    el.commentsSheet.classList.remove('settling');
    then?.();
  }, SHEET_MS);
}
function sheetOpen(): void {
  if (sheet.state === 'open' || sheet.state === 'opening') return;
  if (sheet.state === 'closed') {
    host.onCommentsHold(true); // before anything moves: a video that is about to end stays
    el.comments.classList.remove('hidden');
    sheet.tall = false;
    sheetMeasure();
    sheetPlace(0, false);
    void el.commentsSheet.offsetHeight; // the sheet is rendered below the edge before it slides up
  }
  // (still sliding away: it turns round from where it is; the hold was never let go)
  sheet.state = 'opening';
  sheetSettle(sheet.rest, () => (sheet.state = 'open'));
}
/**
 * Slides the sheet away (`instant`: takes it away at once - the video it belongs to is gone). The
 * read in flight stops now; the feed is let go only when the sheet has left, so nothing that a tap
 * or the end of the video asked for meanwhile moves the feed.
 */
export function closeComments(instant = false): void {
  if (sheet.state === 'closed' || (sheet.state === 'closing' && !instant)) return;
  sheet.drag = undefined;
  el.commentsGrab.classList.remove('dragging');
  cancelCommentsRead();
  const gone = (): void => {
    sheet.state = 'closed';
    el.comments.classList.add('hidden');
    host.onCommentsHold(false);
  };
  sheet.state = 'closing';
  if (instant) {
    clearTimeout(sheet.timer);
    sheet.timer = 0;
    gone();
  } else sheetSettle(0, gone);
}
/** The comments sheet is on screen (opening and sliding away included). */
export const commentsOpen = (): boolean => sheet.state !== 'closed';

// The grab area follows the finger / mouse; the buttons in it keep their own taps.
el.commentsGrab.addEventListener('pointerdown', (e) => {
  if (sheet.drag || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (sheet.side) return; // a column beside the video is closed with its ×, not dragged
  if (sheet.state !== 'open' && sheet.state !== 'opening') return;
  if ((e.target as HTMLElement).closest('button')) return;
  sheet.drag = { id: e.pointerId, y0: e.clientY, h0: sheet.shown, moved: false, samples: [] };
  try {
    el.commentsGrab.setPointerCapture(e.pointerId);
  } catch {
    /* the pointer is gone already */
  }
});
el.commentsGrab.addEventListener('pointermove', (e) => {
  const d = sheet.drag;
  if (!d || e.pointerId !== d.id) return;
  const dy = e.clientY - d.y0;
  if (!d.moved) {
    if (Math.abs(dy) < 4) return;
    d.moved = true;
    // grabbed while it was still sliding up: it follows the pointer from where it was going
    clearTimeout(sheet.timer);
    sheet.timer = 0;
    sheet.state = 'open';
    el.commentsGrab.classList.add('dragging');
  }
  sheetPlace(d.h0 - dy, false);
  const t = performance.now();
  d.samples.push({ y: e.clientY, t });
  while (d.samples.length > 1 && t - d.samples[0].t > 100) d.samples.shift();
});
function endSheetDrag(e: PointerEvent, cancelled: boolean): void {
  const d = sheet.drag;
  if (!d || e.pointerId !== d.id) return;
  sheet.drag = undefined;
  el.commentsGrab.classList.remove('dragging');
  try {
    el.commentsGrab.releasePointerCapture(e.pointerId);
  } catch {
    /* not captured */
  }
  if (!d.moved) return;
  const s0 = d.samples[0];
  const s1 = d.samples[d.samples.length - 1];
  // px per ms over the last moves, positive = downwards
  const v = !cancelled && s0 && s1 && s1.t - s0.t >= 8 ? (s1.y - s0.y) / (s1.t - s0.t) : 0;
  const h = sheet.shown;
  const hasTall = sheet.max - sheet.rest >= 60;
  let to: 'close' | 'rest' | 'tall';
  if (cancelled) to = sheet.tall ? 'tall' : 'rest';
  else if (v >= SHEET_FLICK) to = h > sheet.rest + 20 ? 'rest' : 'close';
  else if (v <= -SHEET_FLICK) to = h >= sheet.rest - 20 ? 'tall' : 'rest';
  else to = h < sheet.rest * 0.65 ? 'close' : h > (sheet.rest + sheet.max) / 2 ? 'tall' : 'rest';
  if (to === 'tall' && !hasTall) to = 'rest';
  if (to === 'close') {
    closeComments();
    return;
  }
  sheet.tall = to === 'tall';
  sheetSettle(sheet.tall ? sheet.max : sheet.rest);
}
el.commentsGrab.addEventListener('pointerup', (e) => endSheetDrag(e, false));
el.commentsGrab.addEventListener('pointercancel', (e) => endSheetDrag(e, true));

// Beside the sheet (the video above it, the rest of the page): the layer takes the tap, closes the
// sheet and keeps the event, so the video under it is not paused, started or swiped by it. A swipe
// there closes it as well (a moved finger makes no click, so the release is what counts).
let outsideDown = false;
el.comments.addEventListener('pointerdown', (e) => {
  outsideDown = e.isPrimary && !(e.pointerType === 'mouse' && e.button !== 0) && !el.commentsSheet.contains(e.target as Node);
});
el.comments.addEventListener('pointerup', (e) => {
  if (outsideDown && e.isPrimary) closeComments();
});
el.comments.addEventListener('pointercancel', () => (outsideDown = false));
el.comments.addEventListener('click', (e) => {
  if (el.commentsSheet.contains(e.target as Node)) return;
  e.preventDefault();
  e.stopPropagation();
  if (outsideDown) closeComments();
  outsideDown = false;
});
// nothing in the sheet is dragged natively, and a wheel turn beside the list goes nowhere
el.comments.addEventListener('dragstart', (e) => e.preventDefault());
el.comments.addEventListener(
  'wheel',
  (e) => {
    if (!el.commentsBody.contains(e.target as Node)) e.preventDefault();
  },
  { passive: false },
);
// The window changed (rotation, the car's panel, full screen): the frame and the heights with it,
// after the feed's own layout, which listens to the same events.
function sheetRelayout(): void {
  window.setTimeout(() => {
    if (sheet.state === 'closed' || sheet.state === 'closing' || sheet.drag) return;
    sheetMeasure();
    if (sheet.state === 'open') sheetPlace(sheet.tall ? sheet.max : sheet.rest, false);
    else sheetSettle(sheet.rest, () => (sheet.state = 'open'));
  }, 0);
}
window.addEventListener('resize', sheetRelayout);
window.addEventListener('orientationchange', sheetRelayout);
window.visualViewport?.addEventListener('resize', sheetRelayout);

// ---- beside the video: who posted it, and two tabs (wide screens)
// The column the comments take beside the video (sheet.side) opens with the account that posted the
// video at its top - picture, name, followers, Follow - and two tabs under it: the video's comments,
// and the account's videos (tap one to play them from there). The comment bubble opens it on
// Comments, the avatar on Videos. The account's page (bio, messages, the big grid) is one tap on
// the name away. On a phone none of this shows: the sheet there is the comments alone.
const side = {
  tab: 'comments' as 'comments' | 'videos',
  /** The account whose videos the Videos tab holds (lower-cased handle), '' = none asked yet */
  user: '',
  info: undefined as UserSummary | undefined,
  items: [] as FeedItem[],
  offset: 0,
  hasMore: false,
  busy: false,
  seq: 0,
};
const sideAuthor = (): FeedItem['author'] | undefined => comments.item?.author;
const sideFollowState = (): FollowState | undefined => {
  const a = sideAuthor();
  if (!a) return undefined;
  const known = host.followState?.(a);
  return known && known !== 'unknown' ? known : side.info?.followState;
};
const isFollowed = (s: FollowState | undefined): boolean => s === 'following' || s === 'friends' || s === 'requested';

function renderSideHead(): void {
  const a = sideAuthor();
  if (!a) return;
  const u = side.info && side.user === (a.uniqueId || '').toLowerCase() ? side.info : undefined;
  el.sideHandle.textContent = `@${u?.uniqueId || a.uniqueId || '?'}${u?.verified ? ' ✔' : ''}`;
  el.sideNick.textContent = u?.nickname || a.nickname || '';
  const pic = u?.avatar || a.avatar;
  if (pic) el.sideAvatar.src = pic;
  else el.sideAvatar.removeAttribute('src');
  const stats: string[] = [];
  if (u?.followers !== undefined) stats.push(`${host.fmtCount(u.followers)} followers`);
  if (u?.likes !== undefined) stats.push(`${host.fmtCount(u.likes)} likes`);
  if (u?.videos !== undefined) stats.push(`${host.fmtCount(u.videos)} videos`);
  el.sideStats.textContent = stats.join(' · ');
  el.sideDesc.textContent = comments.item?.desc || '';
  el.sideDesc.classList.toggle('hidden', !comments.item?.desc);
  const state = sideFollowState();
  if (!el.sideFollow.classList.contains('busy')) el.sideFollow.textContent = followLabel(state);
  el.sideFollow.classList.toggle('primary', !isFollowed(state));
  el.sideFollow.classList.toggle('on', isFollowed(state));
  el.sideFollow.classList.toggle('hidden', !host.platform.follow);
}

/** Shows one of the two tabs; what it holds is read the first time it is shown for this video / account. */
function setSideTab(tab: 'comments' | 'videos'): void {
  const changed = side.tab !== tab;
  side.tab = tab;
  const vids = tab === 'videos';
  el.sideTabComments.classList.toggle('active', !vids);
  el.sideTabVideos.classList.toggle('active', vids);
  el.sideTabComments.setAttribute('aria-selected', String(!vids));
  el.sideTabVideos.setAttribute('aria-selected', String(vids));
  el.sideTabs.classList.toggle('second', vids);
  el.commentsBody.classList.toggle('hidden', vids);
  el.sideVideos.classList.toggle('hidden', !vids);
  el.sideRefresh.classList.toggle('hidden', vids || !!comments.ctl);
  el.sideCancel.classList.toggle('hidden', vids || !comments.ctl);
  if (changed) {
    // the tab that comes in slides in from its side (feed.css side-in)
    const shown = vids ? el.sideVideos : el.commentsBody;
    shown.classList.remove('from-left', 'from-right');
    void shown.offsetWidth;
    shown.classList.add(vids ? 'from-right' : 'from-left');
  }
  const item = comments.item;
  if (!item) return;
  if (!vids) {
    if (comments.asked !== item.id) void loadComments(false);
    return;
  }
  const handle = (item.author.uniqueId || '').toLowerCase();
  if (side.user !== handle) void loadSideVideos(false);
}

async function loadSideVideos(more: boolean): Promise<void> {
  const a = sideAuthor();
  const user = a?.uniqueId;
  if (!user || (side.busy && more)) return;
  const handle = user.toLowerCase();
  const seq = ++side.seq;
  if (!more || side.user !== handle) {
    more = false;
    side.user = handle;
    side.info = undefined;
    side.items = [];
    side.offset = 0;
    side.hasMore = false;
    el.sideVideosGrid.innerHTML = '';
    el.sideVideosMore.classList.add('hidden');
    el.sideVideos.scrollTop = 0;
  }
  side.busy = true;
  status(el.sideVideosStatus, '');
  el.sideVideosLoading.classList.toggle('more', more);
  el.sideVideosLoading.classList.remove('hidden');
  el.sideVideosLoadingTitle.textContent = more ? 'Loading more videos…' : `Loading the videos of @${user}…`;
  el.sideVideosMore.disabled = true;
  try {
    // (quiet: the tab shows this wait itself, where the videos are about to be)
    const r = await api.profile({ platform: host.platform.id, user, offset: more ? side.offset : 0, count: 24 }, { label: `Loading the videos of @${user}`, quiet: () => true });
    if (seq !== side.seq || side.user !== handle) return;
    side.info = r.user;
    side.offset = r.offset + r.items.length;
    side.hasMore = r.hasMore;
    if (r.user.followState && r.user.followState !== 'unknown') host.onFollowState?.(r.user.uniqueId, r.user.followState);
    renderSideHead();
    const base = side.items.length;
    const fresh = r.items.filter((it) => !side.items.some((x) => x.id === it.id));
    side.items.push(...fresh);
    fresh.forEach((it, i) => {
      const tile = videoTile(it, () => host.play({ kind: 'profile', user, items: side.items.slice(), offset: side.offset, hasMore: side.hasMore }, base + i));
      // the one that is playing beside the panel is marked, like TikTok's own
      if (it.id === comments.item?.id) tile.classList.add('current');
      el.sideVideosGrid.appendChild(tile);
    });
    el.sideVideosMore.classList.toggle('hidden', !side.hasMore || !fresh.length);
    status(el.sideVideosStatus, side.items.length ? '' : r.warnings[0] || 'No videos to show');
    for (const w of r.warnings) console.warn('[profile]', w);
  } catch (e) {
    if (seq !== side.seq) return;
    if (!more) side.user = ''; // the tab asks again the next time it is shown
    status(el.sideVideosStatus, `Could not load @${user}: ${errMsg(e)}`, true);
  } finally {
    if (seq === side.seq) {
      side.busy = false;
      el.sideVideosLoading.classList.add('hidden');
      el.sideVideosMore.disabled = false;
    }
  }
}

/**
 * The signed-in account's follow state of an account became known somewhere else on the page (the
 * "+" on the avatar): the panel's Follow button and the account page's say the same.
 */
export function followStateChanged(user: string, state: FollowState): void {
  const handle = user.toLowerCase();
  if (side.info && side.user === handle) side.info.followState = state;
  if (profile.info && profile.info.uniqueId.toLowerCase() === handle) {
    profile.info.followState = state;
    renderProfileHead();
  }
  if ((sideAuthor()?.uniqueId || '').toLowerCase() === handle) renderSideHead();
}

el.sideTabComments.addEventListener('click', () => setSideTab('comments'));
el.sideTabVideos.addEventListener('click', () => setSideTab('videos'));
el.sideVideosMore.addEventListener('click', () => void loadSideVideos(true));
el.sideClose.addEventListener('click', () => closeComments());
el.sideRefresh.addEventListener('click', () => void loadComments(false));
el.sideCancel.addEventListener('click', () => {
  if (cancelCommentsRead()) status(el.commentsStatus, comments.list.length ? 'Stopped.' : 'Stopped. Refresh reads the comments again.');
});
// The name and picture: the account's own page (bio, messages, the big grid). The video pauses behind it as always.
el.sideAuthor.addEventListener('click', () => {
  const user = sideAuthor()?.uniqueId;
  if (user) void openProfile(user);
});
el.sideFollow.addEventListener('click', () => {
  const a = sideAuthor();
  if (!a?.uniqueId) return;
  if (!host.isLoggedIn()) {
    host.toast(`Sign in to ${host.platform.name} first to follow accounts`, true, 4000);
    void host.openSessionPanel();
    return;
  }
  const user = a.uniqueId;
  const followed = isFollowed(sideFollowState());
  pressed(
    el.sideFollow,
    async () => {
      try {
        const r = await api.follow({ platform: host.platform.id, user, id: a.id, follow: !followed });
        if (side.info && side.user === user.toLowerCase()) side.info.followState = r.followState;
        host.onFollowState?.(user, r.followState);
        host.toast(`${r.followState === 'none' ? (followed ? `Unfollowed @${user}` : `Could not follow @${user}`) : r.followState === 'requested' ? `Follow request sent to @${user}` : `${followLabel(r.followState)} @${user}`}${r.via === 'direct' ? ' · asked directly, no browser' : ''}`, r.followState === 'none' && !followed);
        for (const w of r.warnings) console.warn('[follow]', w);
      } catch (e) {
        host.toast(`Follow failed: ${errMsg(e)}`, true, 6000);
      }
      window.setTimeout(renderSideHead, 0); // (after the button has its own text back)
    },
    { label: followed ? 'Unfollowing' : 'Following' },
  );
});

/**
 * Opens the panel for `item` (the video in view) on one of its tabs. Beside the video (wide screens)
 * that is the account, Comments and Videos; as a sheet (phones) it is the comments alone.
 */
function openSide(item: FeedItem, tab: 'comments' | 'videos'): void {
  sheetOpen();
  if (comments.item?.id !== item.id) {
    cancelCommentsRead();
    comments.item = item;
    comments.asked = '';
    comments.list = [];
    comments.cursor = 0;
    comments.hasMore = false;
    comments.total = undefined;
    el.commentsList.innerHTML = '';
    el.commentsMore.classList.add('hidden');
    status(el.commentsStatus, '');
    el.commentsBody.scrollTop = 0;
    commentsTitle();
    for (const t of el.sideVideosGrid.querySelectorAll('.v-tile.current')) t.classList.remove('current');
  }
  renderSideHead();
  setSideTab(sheet.side ? tab : 'comments');
}

/** Opens the comments of `item` (the video in view); a different video starts a fresh read. */
export function openComments(item: FeedItem): void {
  if (!host.platform.social) {
    host.toast(`Comments are not available for ${host.platform.name} yet`);
    return;
  }
  if (!item.author.uniqueId) {
    host.toast('This video has no account to read the comments from');
    return;
  }
  openSide(item, 'comments');
}

/**
 * The avatar of the video in view: where the panel goes beside the video (wide screens, an app with
 * comments), it opens there on the account's videos and true comes back; false = no such place, the
 * caller opens the account's page instead.
 */
export function openAuthorBeside(item: FeedItem): boolean {
  if (!host.platform.social || !item.author.uniqueId) return false;
  if (sheet.state === 'closed' ? !host.commentsSide?.() : !sheet.side) return false;
  openSide(item, 'videos');
  return true;
}

el.commentsClose.addEventListener('click', () => closeComments());
el.commentsRefresh.addEventListener('click', () => void loadComments(false));
el.commentsMore.addEventListener('click', () => void loadComments(true));
el.commentsCancel.addEventListener('click', () => {
  if (cancelCommentsRead()) status(el.commentsStatus, comments.list.length ? 'Stopped.' : 'Stopped. Refresh reads the comments again.');
});

export function initSocial(h: SocialHost): void {
  host = h;
  const p = h.platform;
  el.searchInput.placeholder = p.searchPlaceholder;
  // Follow exists on TikTok and Instagram, messages on TikTok only; the other platforms show the account's videos.
  el.profileFollow.classList.toggle('hidden', !p.follow);
  el.profileMessage.classList.toggle('hidden', !p.social);
}
