/**
 * The feed page's social panels: search, account profiles (with follow and the account's videos)
 * and messages. All data comes from the server's headless TikTok session (server/src/social.ts);
 * search and profiles work signed out, follow and messages need the signed-in account.
 *
 * The panels do not play anything themselves: a tapped video hands a play list (the search results
 * or the account's videos, with the continuation) to the feed through SocialHost.play().
 */
import type { ChatMessage, Conversation, FeedItem, FollowState, UserSummary } from '../../../shared/types';
import { api, ApiError } from '../api';
import { pressed } from '../busy';

export type PlayList = { kind: 'search'; q: string; items: FeedItem[]; offset: number; hasMore: boolean } | { kind: 'profile'; user: string; items: FeedItem[]; offset: number; hasMore: boolean };

export interface SocialHost {
  play(list: PlayList, startIndex: number): void;
  toast(msg: string, isError?: boolean, ms?: number): void;
  isLoggedIn(): boolean;
  openSessionPanel(): Promise<void>;
  fmtCount(n?: number): string;
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
  searchUsers: $('searchUsers'),
  searchVideos: $('searchVideos'),
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
  profilePlay: $<HTMLButtonElement>('profilePlay'),
  profileLink: $<HTMLAnchorElement>('profileLink'),
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
  const i = open.indexOf(panel);
  if (i >= 0) open.splice(i, 1);
  open.push(panel);
  panel.classList.remove('hidden');
  panel.scrollTop = 0;
}
function hide(panel: HTMLElement): void {
  const i = open.indexOf(panel);
  if (i >= 0) open.splice(i, 1);
  panel.classList.add('hidden');
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

// ---------------------------------------------------------------- search

const search = { q: '', items: [] as FeedItem[], offset: 0, hasMore: false, busy: false };

export function openSearch(): void {
  show(el.search);
  el.searchInput.focus();
  el.searchInput.select();
}

async function runSearch(q: string, more: boolean): Promise<void> {
  if (search.busy) return;
  search.busy = true;
  if (!more) {
    search.q = q;
    search.items = [];
    search.offset = 0;
    search.hasMore = false;
    el.searchUsers.innerHTML = '';
    el.searchVideos.innerHTML = '';
    el.searchMore.classList.add('hidden');
    status(el.searchStatus, `Searching for “${q}”…`);
  } else status(el.searchStatus, 'Loading more…');
  try {
    const r = await api.search({ q, offset: more ? search.offset : 0 });
    if (search.q !== q) return;
    search.offset = r.offset;
    search.hasMore = r.hasMore;
    if (!more) for (const u of r.users) el.searchUsers.appendChild(userRow(u));
    const base = search.items.length;
    const fresh = r.items.filter((it) => !search.items.some((x) => x.id === it.id));
    search.items.push(...fresh);
    fresh.forEach((it, i) =>
      el.searchVideos.appendChild(
        videoTile(it, () => {
          closeAllPanels();
          host.play({ kind: 'search', q, items: search.items.slice(), offset: search.offset, hasMore: search.hasMore }, base + i);
        }),
      ),
    );
    el.searchMore.classList.toggle('hidden', !search.hasMore || !fresh.length);
    const n = search.items.length;
    status(el.searchStatus, n || r.users.length ? `${n} video${n === 1 ? '' : 's'}${r.users.length && !more ? `, ${r.users.length} account${r.users.length === 1 ? '' : 's'}` : ''} for “${q}”` : `Nothing found for “${q}”`);
    for (const w of r.warnings) console.warn('[search]', w);
  } catch (e) {
    status(el.searchStatus, `Search failed: ${errMsg(e)}`, true);
  } finally {
    search.busy = false;
  }
}

el.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = el.searchInput.value.trim();
  if (!q) return;
  el.searchInput.blur();
  pressed(el.searchGo, () => runSearch(q, false), { label: 'Searching' });
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
  el.profileLink.href = `https://www.tiktok.com/@${u.uniqueId}`;
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

async function loadProfile(more: boolean): Promise<void> {
  if (profile.busy) return;
  profile.busy = true;
  const user = profile.user;
  status(el.profileStatus, more ? 'Loading more videos…' : `Loading @${user}… (the server opens the account page)`);
  try {
    const r = await api.profile({ user, offset: more ? profile.offset : 0, count: 24 });
    if (profile.user !== user) return;
    profile.info = r.user;
    profile.offset = r.offset + r.items.length;
    profile.hasMore = r.hasMore;
    renderProfileHead();
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
    status(el.profileStatus, `Could not load @${user}: ${errMsg(e)}`, true);
  } finally {
    profile.busy = false;
  }
}

el.profileClose.addEventListener('click', () => hide(el.profile));
el.profileMore.addEventListener('click', () => pressed(el.profileMore, () => loadProfile(true), { label: 'Loading' }));
el.profilePlay.addEventListener('click', () => {
  if (!profile.items.length) return host.toast('No videos loaded yet');
  closeAllPanels();
  host.play({ kind: 'profile', user: profile.user, items: profile.items.slice(), offset: profile.offset, hasMore: profile.hasMore }, 0);
});
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
}
