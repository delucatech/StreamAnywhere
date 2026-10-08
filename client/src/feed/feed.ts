/**
 * Feed page: a TikTok-style vertical stream.
 *
 *  - Source "Explore" (no sign-in) or "For You" (the signed-in account's feed; needs the Node
 *    server with a Chrome/Edge session, see server/src/session.ts).
 *  - One full-height <video> per item, scroll-snap; the item that fills the viewport plays, the
 *    others pause. Items near the end trigger the next batch.
 *  - Tap/click a video to pause/resume. ↑/↓ (or J/K) move, Space pauses, M mutes, F fullscreen,
 *    D downloads.
 *  - Auto-scroll: when on, a finished video advances to the next one; when off, it loops.
 *  - Download: fetches the cookie-free CDN URL (CORS *) as a blob and saves it as @author_id.mp4;
 *    falls back to the server proxy when the direct fetch fails.
 *
 * Playback uses the browser's <video> element (not the WebCodecs lab pipeline) so that several
 * items can be kept warm at once and so that H.265-only variants still play where the browser can.
 */
import { EXPLORE_CATEGORIES, type FeedItem, type FeedSource, type LoginMode, type MediaFormat, type SessionStatus } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const el = {
  app: $('app'),
  feed: $('feed'),
  source: $<HTMLSelectElement>('source'),
  category: $<HTMLSelectElement>('category'),
  autoscroll: $<HTMLInputElement>('autoscroll'),
  signin: $<HTMLButtonElement>('signin'),
  fullwindow: $<HTMLButtonElement>('fullwindow'),
  fullscreen: $<HTMLButtonElement>('fullscreen'),
  session: $('session'),
  sessionText: $('sessionText'),
  sessionLogin: $<HTMLButtonElement>('sessionLogin'),
  sessionLoginWindow: $<HTMLButtonElement>('sessionLoginWindow'),
  sessionQr: $('sessionQr'),
  sessionQrImg: $<HTMLImageElement>('sessionQrImg'),
  sessionQrHint: $('sessionQrHint'),
  sessionRefresh: $<HTMLButtonElement>('sessionRefresh'),
  sessionLogout: $<HTMLButtonElement>('sessionLogout'),
  sessionClose: $<HTMLButtonElement>('sessionClose'),
  start: $('start'),
  startBtn: $<HTMLButtonElement>('startBtn'),
  toast: $('toast'),
  loading: $('loading'),
};

interface Entry {
  item: FeedItem;
  root: HTMLElement;
  video: HTMLVideoElement;
  progress: HTMLElement;
  err: HTMLElement;
  dlBtn: HTMLButtonElement;
  /** Which URL the video element currently uses */
  src?: { url: string; kind: 'direct' | 'proxy' };
  triedProxy: boolean;
  failed: boolean;
}

const PREFS_KEY = 'streamanywhere.feed';
interface Prefs {
  source: FeedSource;
  category: number;
  autoscroll: boolean;
  muted: boolean;
}
function loadPrefs(): Prefs {
  const def: Prefs = { source: 'explore', category: 120, autoscroll: true, muted: false };
  try {
    return { ...def, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>) };
  } catch {
    return def;
  }
}
function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
const prefs = loadPrefs();

const state = {
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
};

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
const errMsg = (e: unknown): string => (e instanceof ApiError ? `${e.message} (HTTP ${e.status})` : (e as Error)?.message || String(e));

/** Prefer H.264 (the formats are already sorted that way), then anything with a direct or proxy URL. */
function pickFormat(item: FeedItem): MediaFormat | undefined {
  return item.formats.find((f) => f.codec === 'h264' && (f.directUrl || f.proxyUrl)) || item.formats.find((f) => f.directUrl || f.proxyUrl);
}
function sourceCandidates(item: FeedItem): { url: string; kind: 'direct' | 'proxy' }[] {
  const f = pickFormat(item);
  if (!f) return [];
  const out: { url: string; kind: 'direct' | 'proxy' }[] = [];
  if (f.directUrl) out.push({ url: f.directUrl, kind: 'direct' });
  if (f.proxyUrl) out.push({ url: apiUrl(f.proxyUrl), kind: 'proxy' });
  return out;
}

// ---------- setup ----------
for (const c of EXPLORE_CATEGORIES) {
  const o = document.createElement('option');
  o.value = String(c.id);
  o.textContent = c.label;
  el.category.appendChild(o);
}
el.source.value = prefs.source;
el.category.value = String(prefs.category);
el.autoscroll.checked = prefs.autoscroll;
updateSourceUi();

el.source.addEventListener('change', () => {
  const src = el.source.value as FeedSource;
  if (src === 'foryou' && state.session?.state !== 'logged_in') {
    // Keep the selector on explore until a session exists; the panel switches it once signed in.
    el.source.value = prefs.source;
    void openSessionPanel();
    return;
  }
  prefs.source = src;
  savePrefs();
  updateSourceUi();
  void reload();
});
el.category.addEventListener('change', () => {
  prefs.category = Number(el.category.value);
  savePrefs();
  void reload();
});
el.autoscroll.addEventListener('change', () => {
  prefs.autoscroll = el.autoscroll.checked;
  savePrefs();
  applyLoopMode();
  toast(prefs.autoscroll ? 'Auto-scroll on: next video plays when this one ends' : 'Auto-scroll off: videos loop');
});
el.fullwindow.addEventListener('click', () => {
  const on = el.app.classList.toggle('fullwindow');
  el.fullwindow.setAttribute('aria-pressed', String(on));
  if (on) toast('Full window. Press Esc or W to show the bar again');
});
el.fullscreen.addEventListener('click', () => toggleFullscreen());
el.signin.addEventListener('click', () => void openSessionPanel());
el.sessionClose.addEventListener('click', () => closeSessionPanel());
el.sessionRefresh.addEventListener('click', () => void refreshSession(true));
el.sessionLogin.addEventListener('click', () => void startLogin('qr'));
el.sessionLoginWindow.addEventListener('click', () => void startLogin('window'));
el.sessionLogout.addEventListener('click', () => void signOut());
el.startBtn.addEventListener('click', () => start());
el.start.addEventListener('click', (e) => {
  if (e.target === el.start) start();
});

function updateSourceUi(): void {
  el.category.classList.toggle('hidden', prefs.source !== 'explore');
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.app.requestFullscreen().catch((e) => toast(`Fullscreen refused: ${(e as Error).message}`, true));
}

function start(): void {
  state.started = true;
  el.start.classList.add('hidden');
  el.feed.focus();
  const cur = state.entries[state.active];
  if (cur) void playEntry(cur);
}

// ---------- session ----------
function renderSession(): void {
  const s = state.session;
  if (!s) {
    el.sessionText.textContent = 'Checking the server…';
    return;
  }
  const lines: string[] = [];
  if (!s.supported) {
    lines.push('<b>Sign-in is not available on this server.</b>');
    lines.push(s.error || '');
    lines.push('For You needs the Node server (npm run dev / npm start) on a machine with Chrome or Edge. The Explore feed works everywhere.');
  } else if (s.state === 'logged_in') {
    lines.push(`<b>Signed in as @${esc(s.username || '?')}</b>${s.nickname && s.nickname !== s.username ? ` (${esc(s.nickname)})` : ''}`);
    lines.push('The For You feed comes from this account. Sign out closes the browser session and deletes the saved profile on the server.');
  } else if (s.state === 'login_pending' && s.loginMode === 'qr') {
    lines.push('<b>Scan to sign in.</b>');
    lines.push('In the TikTok app: Profile → ☰ menu → My QR code → scan icon (or point the in-app camera at this code), then confirm. The code refreshes by itself; this page updates automatically.');
  } else if (s.state === 'login_pending') {
    lines.push('<b>Waiting for sign-in…</b>');
    lines.push('A TikTok window opened on the machine running the server. Sign in there (any method). This page updates automatically.');
  } else {
    lines.push('<b>Not signed in.</b>');
    lines.push(`"Sign in with QR code" shows TikTok's login QR here; scan it with the TikTok app on your phone. The session then lives in a private ${esc(s.browser || 'browser')} profile on the server. StreamAnywhere never sees your password.`);
    if (s.error) lines.push(`<span style="color:var(--err)">${esc(s.error)}</span>`);
  }
  el.sessionText.innerHTML = lines.filter(Boolean).join('\n');
  const showQr = s.state === 'login_pending' && s.loginMode === 'qr';
  el.sessionQr.classList.toggle('hidden', !showQr);
  if (showQr) {
    const img = s.qr || s.pageShot || '';
    if (img && el.sessionQrImg.src !== img) el.sessionQrImg.src = img;
    el.sessionQrImg.classList.toggle('page-shot', !s.qr && Boolean(s.pageShot));
    if (!img) el.sessionQrImg.removeAttribute('src');
    el.sessionQrHint.textContent = s.qrState === 'scanned' ? 'Scanned – confirm on your phone' : s.qr ? 'Waiting for the scan…' : s.pageShot ? 'No QR code yet – this is what TikTok shows the server; retrying automatically' : 'Loading the QR code…';
  }
  const idle = s.supported && s.state !== 'logged_in' && s.state !== 'login_pending';
  el.sessionLogin.classList.toggle('hidden', !idle);
  el.sessionLoginWindow.classList.toggle('hidden', !idle);
  el.sessionLogout.classList.toggle('hidden', !s.supported || s.state === 'none' || s.state === 'unsupported');
  el.signin.textContent = s.state === 'logged_in' ? `@${s.username || 'account'}` : s.state === 'login_pending' ? 'Signing in…' : 'Sign in';
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function refreshSession(announce = false): Promise<SessionStatus | undefined> {
  try {
    const prev = state.session?.state;
    state.session = await api.session();
    renderSession();
    if (announce) toast(state.session.message || state.session.state);
    if (state.session.state === 'logged_in' && prev === 'login_pending') {
      // Freshly signed in: switch to For You.
      prefs.source = 'foryou';
      el.source.value = 'foryou';
      savePrefs();
      updateSourceUi();
      closeSessionPanel();
      toast(`Signed in as @${state.session.username || '?'} – loading your For You feed`);
      void reload();
    }
    return state.session;
  } catch (e) {
    state.session = { supported: false, state: 'unsupported', error: `Server unreachable: ${errMsg(e)}` };
    renderSession();
    return undefined;
  }
}

async function openSessionPanel(): Promise<void> {
  el.session.classList.remove('hidden');
  await refreshSession();
  pollSession();
}
function closeSessionPanel(): void {
  el.session.classList.add('hidden');
}
function pollSession(): void {
  clearInterval(state.sessionPoll);
  state.sessionPoll = window.setInterval(() => {
    if (state.session?.state === 'login_pending' || state.session?.probing) void refreshSession();
    else clearInterval(state.sessionPoll);
  }, 2000);
}

async function startLogin(mode: LoginMode): Promise<void> {
  el.sessionLogin.disabled = el.sessionLoginWindow.disabled = true;
  el.sessionText.innerHTML = mode === 'qr' ? '<b>Starting TikTok on the server…</b>\nThis can take up to a minute the first time (the browser has to start).' : '<b>Opening the sign-in window on the server…</b>';
  try {
    state.session = await api.sessionLogin(mode);
    renderSession();
    pollSession();
  } catch (e) {
    toast(`Sign-in could not start: ${errMsg(e)}`, true, 6000);
  } finally {
    el.sessionLogin.disabled = el.sessionLoginWindow.disabled = false;
  }
}

async function signOut(): Promise<void> {
  el.sessionLogout.disabled = true;
  el.sessionText.innerHTML = '<b>Signing out…</b>\nClosing the browser session on the server (a few seconds).';
  try {
    state.session = await api.sessionLogout();
    renderSession();
    if (prefs.source === 'foryou') {
      prefs.source = 'explore';
      el.source.value = 'explore';
      savePrefs();
      updateSourceUi();
      void reload();
    }
    toast('Signed out');
  } catch (e) {
    toast(`Sign-out failed: ${errMsg(e)}`, true);
    renderSession();
  } finally {
    el.sessionLogout.disabled = false;
  }
}

// ---------- feed loading ----------
async function reload(): Promise<void> {
  state.generation++;
  for (const e of state.entries) {
    e.video.pause();
    e.video.removeAttribute('src');
    e.video.load();
  }
  state.entries = [];
  state.ids = new Set();
  state.active = -1;
  state.exhausted = false;
  el.feed.innerHTML = '';
  el.feed.scrollTop = 0;
  await loadMore();
}

async function loadMore(): Promise<void> {
  if (state.loading || state.exhausted) return;
  state.loading = true;
  const gen = state.generation;
  el.loading.classList.remove('hidden');
  el.loading.textContent = state.entries.length ? 'Loading more…' : 'Loading feed…';
  try {
    const r = await api.feed({ source: prefs.source, category: prefs.source === 'explore' ? prefs.category : undefined, count: 12 });
    if (gen !== state.generation) return;
    let added = 0;
    for (const item of r.items) {
      if (state.ids.has(item.id) || !sourceCandidates(item).length) continue;
      state.ids.add(item.id);
      state.entries.push(makeEntry(item));
      added++;
    }
    for (const w of r.warnings) console.warn('[feed]', w);
    if (!added && !r.items.length) {
      if (!r.hasMore) state.exhausted = true;
      else if (r.warnings.length) toast(r.warnings[r.warnings.length - 1], true, 5000);
    }
    if (!state.entries.length) showEmpty(r.warnings[0] || 'The feed returned no playable videos. Try again or pick another category.');
    if (state.active < 0 && state.entries.length) setActive(0);
  } catch (e) {
    if (gen !== state.generation) return;
    const msg = errMsg(e);
    toast(`Feed failed: ${msg}`, true, 7000);
    if (!state.entries.length) showEmpty(`Feed failed: ${msg}`);
    if (prefs.source === 'foryou' && /not signed in|session/i.test(msg)) void openSessionPanel();
  } finally {
    state.loading = false;
    el.loading.classList.add('hidden');
  }
}

function showEmpty(text: string): void {
  const d = document.createElement('div');
  d.className = 'item empty-state';
  d.textContent = text;
  el.feed.appendChild(d);
}

// ---------- entries ----------
const observer = new IntersectionObserver(
  (records) => {
    for (const r of records) {
      if (!r.isIntersecting || r.intersectionRatio < 0.6) continue;
      const idx = state.entries.findIndex((e) => e.root === r.target);
      if (idx >= 0 && idx !== state.active) setActive(idx);
    }
  },
  { root: el.feed, threshold: [0.6] },
);

function makeEntry(item: FeedItem): Entry {
  const root = document.createElement('article');
  root.className = 'item';
  root.dataset.id = item.id;
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'none';
  video.muted = prefs.muted;
  if (item.cover) video.poster = item.cover;
  video.setAttribute('aria-label', item.desc || `video by @${item.author.uniqueId || '?'}`);
  root.appendChild(video);

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
  const f = pickFormat(item);
  meta.textContent = [item.music ? `♫ ${item.music}` : '', item.stats.plays !== undefined ? `${fmtCount(item.stats.plays)} plays` : '', item.stats.likes !== undefined ? `${fmtCount(item.stats.likes)} likes` : '', f ? f.id : '']
    .filter(Boolean)
    .join(' · ');
  info.appendChild(meta);
  root.appendChild(info);

  const side = document.createElement('div');
  side.className = 'side';
  const muteBtn = sideButton(prefs.muted ? '🔇' : '🔊', 'Mute / unmute (M)', () => toggleMute());
  muteBtn.dataset.role = 'mute';
  const dlBtn = sideButton('⬇', 'Download this video (D)', () => void download(entry));
  dlBtn.dataset.role = 'download';
  side.appendChild(muteBtn);
  side.appendChild(dlBtn);
  root.appendChild(side);

  const progress = document.createElement('div');
  progress.className = 'progress';
  const bar = document.createElement('i');
  progress.appendChild(bar);
  root.appendChild(progress);

  const err = document.createElement('div');
  err.className = 'err hidden';
  root.appendChild(err);

  const entry: Entry = { item, root, video, progress: bar, err, dlBtn, triedProxy: false, failed: false };

  video.addEventListener('click', () => togglePause(entry));
  video.addEventListener('timeupdate', () => {
    if (video.duration) bar.style.width = `${(100 * video.currentTime) / video.duration}%`;
  });
  video.addEventListener('ended', () => {
    if (state.entries[state.active] !== entry) return;
    if (prefs.autoscroll) goTo(state.active + 1);
  });
  video.addEventListener('error', () => onVideoError(entry));
  video.addEventListener('play', () => root.classList.remove('paused'));
  video.addEventListener('pause', () => {
    if (state.entries[state.active] === entry && state.userPaused) root.classList.add('paused');
  });

  el.feed.appendChild(root);
  observer.observe(root);
  return entry;
}

function sideButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'side-btn';
  b.type = 'button';
  b.title = title;
  b.textContent = icon;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function attachSource(entry: Entry, which: 'direct' | 'proxy' | 'auto' = 'auto'): boolean {
  const cands = sourceCandidates(entry.item);
  const pick = which === 'auto' ? cands[0] : cands.find((c) => c.kind === which);
  if (!pick) return false;
  if (entry.src?.url === pick.url) return true;
  entry.src = pick;
  entry.video.src = pick.url;
  entry.video.load();
  return true;
}

function onVideoError(entry: Entry): void {
  const e = entry.video.error;
  const detail = e ? `MediaError ${e.code}${e.message ? ': ' + e.message : ''}` : 'unknown error';
  if (entry.src?.kind === 'direct' && !entry.triedProxy && sourceCandidates(entry.item).some((c) => c.kind === 'proxy')) {
    entry.triedProxy = true;
    console.warn(`[feed] direct URL failed for ${entry.item.id} (${detail}); retrying through the proxy`);
    attachSource(entry, 'proxy');
    if (state.entries[state.active] === entry && state.started) void playEntry(entry);
    return;
  }
  entry.failed = true;
  entry.err.textContent = `This video could not be loaded (${detail}).`;
  entry.err.classList.remove('hidden');
  if (state.entries[state.active] === entry && prefs.autoscroll) window.setTimeout(() => state.entries[state.active] === entry && goTo(state.active + 1), 1500);
}

async function playEntry(entry: Entry): Promise<void> {
  if (!state.started || entry.failed) return;
  if (!attachSource(entry)) return;
  entry.video.loop = !prefs.autoscroll;
  entry.video.muted = prefs.muted;
  try {
    await entry.video.play();
  } catch (e) {
    const err = e as DOMException;
    if (err.name === 'NotAllowedError' && !entry.video.muted) {
      // Autoplay with sound was refused: continue muted and tell the user.
      prefs.muted = true;
      savePrefs();
      syncMuteButtons();
      entry.video.muted = true;
      toast('Playing muted (browser autoplay rule). Press M or the speaker button for sound.');
      try {
        await entry.video.play();
      } catch {
        /* reported through the error handler */
      }
    } else if (err.name !== 'AbortError') {
      console.warn('[feed] play() failed', err);
    }
  }
}

function setActive(idx: number): void {
  if (idx < 0 || idx >= state.entries.length) return;
  const prev = state.entries[state.active];
  if (prev && prev !== state.entries[idx]) {
    prev.video.pause();
    prev.root.classList.remove('paused');
    try {
      prev.video.currentTime = 0;
    } catch {
      /* not loaded */
    }
  }
  state.active = idx;
  state.userPaused = false;
  const cur = state.entries[idx];
  void playEntry(cur);
  // Warm the neighbours, release the rest.
  state.entries.forEach((e, i) => {
    const d = Math.abs(i - idx);
    if (d === 1) {
      if (!e.failed && attachSource(e)) e.video.preload = 'auto';
    } else if (d > 2 && e.src) {
      e.video.pause();
      e.video.removeAttribute('src');
      e.video.load();
      e.src = undefined;
    }
  });
  if (idx >= state.entries.length - 3) void loadMore();
}

function goTo(idx: number): void {
  if (idx < 0) return;
  if (idx >= state.entries.length) {
    void loadMore();
    return;
  }
  // scrollTo on the container (not scrollIntoView) so the page itself never scrolls on phones.
  el.feed.scrollTo({ top: idx * el.feed.clientHeight, behavior: 'smooth' });
}

function togglePause(entry: Entry): void {
  if (!state.started) {
    start();
    return;
  }
  if (entry.video.paused) {
    state.userPaused = false;
    entry.root.classList.remove('paused');
    void playEntry(entry);
  } else {
    state.userPaused = true;
    entry.video.pause();
    entry.root.classList.add('paused');
  }
}

function applyLoopMode(): void {
  for (const e of state.entries) e.video.loop = !prefs.autoscroll;
}

function toggleMute(): void {
  prefs.muted = !prefs.muted;
  savePrefs();
  for (const e of state.entries) e.video.muted = prefs.muted;
  syncMuteButtons();
  toast(prefs.muted ? 'Muted' : 'Sound on');
}
function syncMuteButtons(): void {
  for (const b of el.feed.querySelectorAll<HTMLButtonElement>('button[data-role="mute"]')) b.textContent = prefs.muted ? '🔇' : '🔊';
}

// ---------- download ----------
async function download(entry: Entry): Promise<void> {
  const item = entry.item;
  const cands = sourceCandidates(item);
  if (!cands.length) return toast('No downloadable URL for this video', true);
  const name = `@${(item.author.uniqueId || 'tiktok').replace(/[^\w.-]+/g, '_')}_${item.id}.mp4`;
  entry.dlBtn.disabled = true;
  entry.dlBtn.textContent = '…';
  const errors: string[] = [];
  try {
    for (const c of cands) {
      try {
        const res = await fetch(c.url, { mode: 'cors', credentials: 'omit' });
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
            entry.dlBtn.textContent = total ? `${Math.round((100 * got) / total)}%` : `${(got / 1048576).toFixed(1)}M`;
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
    entry.dlBtn.disabled = false;
    entry.dlBtn.textContent = '⬇';
  }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  const cur = state.entries[state.active];
  switch (e.key) {
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
      el.fullwindow.click();
      break;
    case 'Escape':
      if (el.app.classList.contains('fullwindow')) el.fullwindow.click();
      if (!el.session.classList.contains('hidden')) closeSessionPanel();
      break;
    case 'd':
    case 'D':
      if (cur) void download(cur);
      break;
    case 'a':
    case 'A':
      el.autoscroll.click();
      break;
  }
});

// ---------- touch: swipe up/down = next/previous video (like the app) ----------
// Native scroll-snap already moves one item per flick; this guarantees it for short or fast swipes
// and keeps a half-dragged video from sticking between two snap points.
let touchStartY = 0;
let touchStartX = 0;
let touchStartAt = 0;
let touchStartIdx = 0;
let touchMoved = false;
/** Timestamp of the last user-driven scroll (touch, wheel, key); realign() stays out of the way for a while after it. */
let userScrollAt = 0;
let touching = false;
let swipeTimer = 0;
el.feed.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    touching = true;
    userScrollAt = Date.now();
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartAt = Date.now();
    touchMoved = false;
    touchStartIdx = Math.round(el.feed.scrollTop / Math.max(1, el.feed.clientHeight));
  },
  { passive: true },
);
el.feed.addEventListener(
  'touchmove',
  () => {
    touchMoved = true;
    userScrollAt = Date.now();
  },
  { passive: true },
);
el.feed.addEventListener(
  'touchend',
  (e) => {
    touching = false;
    userScrollAt = Date.now();
    if (!touchMoved || !e.changedTouches.length) return;
    const dy = touchStartY - e.changedTouches[0].clientY;
    const dx = touchStartX - e.changedTouches[0].clientX;
    const dt = Date.now() - touchStartAt;
    if (Math.abs(dy) < 30 || Math.abs(dy) < Math.abs(dx) || dt > 1200) return;
    if (!state.started) start();
    const target = Math.max(0, Math.min(state.entries.length - 1, touchStartIdx + (dy > 0 ? 1 : -1)));
    // The browser's own snap animation runs after touchend; only step in if it settled on the wrong item.
    clearTimeout(swipeTimer);
    swipeTimer = window.setTimeout(() => {
      const h = Math.max(1, el.feed.clientHeight);
      if (Math.round(el.feed.scrollTop / h) !== target) goTo(target);
    }, 450);
  },
  { passive: true },
);
el.feed.addEventListener('touchcancel', () => {
  touching = false;
}, { passive: true });
el.feed.addEventListener('wheel', () => {
  userScrollAt = Date.now();
}, { passive: true });

// ---------- resize: keep the active video exactly in view ----------
// Items are sized to the feed viewport (height: 100%), so when the window, orientation or
// fullscreen state changes, the scroll offset must be re-aligned to the active item or the video
// ends up partly off-screen. The video element itself keeps its aspect ratio (object-fit: contain).
let resizeTimer = 0;
let knownHeight = el.feed.clientHeight;
let knownIdx = 0;
el.feed.addEventListener(
  'scroll',
  () => {
    // Remember which item the user is on in the current geometry (independent of the observer lag).
    if (knownHeight > 0) knownIdx = Math.round(el.feed.scrollTop / knownHeight);
  },
  { passive: true },
);
function realign(): void {
  const h = el.feed.clientHeight;
  if (!h || !state.entries.length) return;
  if (h === knownHeight) return; // nothing changed (e.g. a scroll-driven observer callback)
  // Phones resize the viewport while the user flicks (toolbar collapses): never fight that.
  if (touching || Date.now() - userScrollAt < 900) {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(realign, 400);
    return;
  }
  const idx = Math.max(0, Math.min(state.entries.length - 1, knownIdx));
  knownHeight = h;
  const top = idx * h;
  if (Math.abs(el.feed.scrollTop - top) > 1) el.feed.scrollTo({ top, behavior: 'auto' });
}
function onViewportChange(): void {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(realign, 120); // after the browser settles (toolbars, snap)
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);
document.addEventListener('fullscreenchange', onViewportChange);
window.visualViewport?.addEventListener('resize', onViewportChange);
new ResizeObserver(onViewportChange).observe(el.feed);

// Pause when the tab is hidden; resume on return.
document.addEventListener('visibilitychange', () => {
  const cur = state.entries[state.active];
  if (!cur) return;
  if (document.hidden) cur.video.pause();
  else if (!state.userPaused) void playEntry(cur);
});

// ---------- boot ----------
// The feed must not wait for the session check (it may launch a browser on the server): start with
// Explore right away, and switch to For You as soon as the server confirms a signed-in profile.
void (async () => {
  const wanted = prefs.source;
  if (wanted === 'foryou') {
    prefs.source = 'explore';
    el.source.value = 'explore';
    updateSourceUi();
  }
  const feedReady = loadMore();
  const s = await refreshSession();
  if (s?.probing) {
    toast('Checking the saved TikTok sign-in on the server…');
    const t0 = Date.now();
    while (state.session?.probing && Date.now() - t0 < 60_000) {
      await new Promise((r) => setTimeout(r, 2000));
      await refreshSession();
    }
  }
  if (wanted === 'foryou') {
    if (state.session?.state === 'logged_in') {
      prefs.source = 'foryou';
      el.source.value = 'foryou';
      savePrefs();
      updateSourceUi();
      await feedReady;
      toast(`Signed in as @${state.session.username || '?'} – loading your For You feed`);
      void reload();
    } else {
      savePrefs();
      if (state.session?.supported) toast('Sign in to see your For You feed; showing Explore meanwhile.', false, 5000);
    }
  }
})();

(window as unknown as { streamAnywhereFeed: unknown }).streamAnywhereFeed = state;
