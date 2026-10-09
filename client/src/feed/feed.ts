/**
 * Feed page: a TikTok-style vertical stream.
 *
 *  - Source "Explore" (no sign-in) or "For You" (the signed-in account's feed; needs the Node
 *    server with a Chrome/Edge session, see server/src/session.ts). Tabs in the transparent top bar.
 *  - One full-height <canvas> per item, scroll-snap; the item that fills the viewport plays, the
 *    others pause. Items near the end trigger the next batch, and a batch that brings nothing is
 *    retried with a growing delay, so the feed never "ends" (like the app).
 *  - Swipe (touch) or drag (mouse) up/down = next/previous video. Tap/click = pause/resume.
 *    ↑/↓ (or J/K) move, Space pauses, M mutes, F fullscreen, D downloads, A toggles auto-scroll,
 *    W hides the bars.
 *  - Right-hand action column: sound, save (download), auto-scroll, fullscreen. Bottom bar: Home,
 *    Friends, +, Inbox (placeholders for later), Profile (sign-in panel).
 *  - Download: fetches the cookie-free CDN URL (CORS *) as a blob and saves it as @author_id.mp4;
 *    falls back to the server proxy when the direct fetch fails.
 *
 * Playback is canvas-only (see player.ts): the WebCodecs pipeline (fetch → mp4box → VideoDecoder →
 * canvas 2D + Web Audio) paints each item's <canvas>; no <video> element is on the page. Where
 * WebCodecs is missing, a hidden <video> decodes and its frames are copied into the same canvas.
 * The active item and its two neighbours hold a player; the others are released.
 */
import { EXPLORE_CATEGORIES, type FeedItem, type FeedSource, type LoginMode, type MediaFormat, type SessionInputRequest, type SessionStatus } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';
import { pressed } from '../busy';
import { FeedPlayer, feedPlayerMode } from './player';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const el = {
  app: $('app'),
  feed: $('feed'),
  tabs: $('tabs'),
  chips: $('chips'),
  searchBtn: $<HTMLButtonElement>('searchBtn'),
  actMute: $<HTMLButtonElement>('actMute'),
  actMuteIco: $('actMuteIco'),
  actDownload: $<HTMLButtonElement>('actDownload'),
  actDownloadIco: $('actDownloadIco'),
  actAuto: $<HTMLButtonElement>('actAuto'),
  actAutoLabel: $('actAutoLabel'),
  actFull: $<HTMLButtonElement>('actFull'),
  navHome: $<HTMLButtonElement>('navHome'),
  navFriends: $<HTMLButtonElement>('navFriends'),
  navPlus: $<HTMLButtonElement>('navPlus'),
  navInbox: $<HTMLButtonElement>('navInbox'),
  navProfile: $<HTMLButtonElement>('navProfile'),
  navProfileLabel: $('navProfileLabel'),
  session: $('session'),
  sessionText: $('sessionText'),
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
};

interface Entry {
  item: FeedItem;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Canvas player; exists only while the item is active or a neighbour of the active one */
  player?: FeedPlayer;
  progress: HTMLElement;
  err: HTMLElement;
  /** Which URL the player currently uses */
  src?: { url: string; kind: 'direct' | 'proxy' };
  triedProxy: boolean;
  failed: boolean;
  /** True while the viewer drags the progress bar (the ticker must not move it then) */
  isSeeking: () => boolean;
}

const playerMode = feedPlayerMode();
let playerModeAnnounced = false;

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
  /** The viewer asked for a video past the end; advance as soon as one arrives */
  wantNext: false,
  /** Consecutive batches that brought nothing (drives the retry delay) */
  emptyBatches: 0,
  retryTimer: 0,
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
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

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
const activeEntry = (): Entry | undefined => state.entries[state.active];
/** Timestamp of the last user-driven scroll (touch, wheel, key, drag); realign() stays out of the way for a while after it. */
let userScrollAt = 0;
/** Clicks before this time are the tail of a drag or a seek and must not toggle pause. */
let suppressClickUntil = 0;

// ---------- top bar: source tabs + explore categories ----------
function renderSourceUi(): void {
  for (const b of el.tabs.querySelectorAll<HTMLButtonElement>('.tab')) b.classList.toggle('active', b.dataset.source === prefs.source);
  el.chips.classList.toggle('hidden', prefs.source !== 'explore');
  for (const c of el.chips.querySelectorAll<HTMLButtonElement>('.chip')) c.classList.toggle('active', Number(c.dataset.id) === prefs.category);
}
async function setSource(src: FeedSource, announce = true): Promise<void> {
  if (src === 'foryou' && state.session?.state !== 'logged_in') {
    // Keep Explore until a session exists; the panel switches once signed in.
    await openSessionPanel();
    return;
  }
  if (prefs.source === src) return;
  prefs.source = src;
  savePrefs();
  renderSourceUi();
  if (announce) toast(src === 'foryou' ? 'For You' : 'Explore');
  await reload();
}
for (const c of EXPLORE_CATEGORIES) {
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
el.searchBtn.addEventListener('click', () => toast('Search is coming later'));
renderSourceUi();

// ---------- actions column + bottom bar ----------
el.actMute.addEventListener('click', () => toggleMute());
el.actDownload.addEventListener('click', () => {
  const cur = activeEntry();
  if (cur) void download(cur);
});
el.actAuto.addEventListener('click', () => toggleAutoscroll());
el.actFull.addEventListener('click', () => toggleFullscreen());
el.navHome.addEventListener('click', () => {
  if (state.active > 0) goTo(0);
  else pressed(el.navHome, () => reload());
});
el.navFriends.addEventListener('click', () => toast('Friends is coming later'));
el.navPlus.addEventListener('click', () => toast('Upload is coming later'));
el.navInbox.addEventListener('click', () => toast('Inbox is coming later'));
el.navProfile.addEventListener('click', () => pressed(el.navProfile, () => openSessionPanel()));
el.sessionClose.addEventListener('click', () => closeSessionPanel());
el.sessionRefresh.addEventListener('click', () => pressed(el.sessionRefresh, () => refreshSession(true), { label: 'Checking' }));
el.sessionLogin.addEventListener('click', () => pressed(el.sessionLogin, () => startLogin('qr'), { label: 'Starting' }));
el.sessionLoginWindow.addEventListener('click', () => pressed(el.sessionLoginWindow, () => startLogin('window'), { label: 'Opening' }));
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
      await sendLiveInput({ type: 'code', code });
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
async function sendLiveInput(req: SessionInputRequest): Promise<void> {
  el.sessionQrImg.classList.add('busy');
  try {
    state.session = await api.sessionInput(req);
    renderSession();
  } catch (e) {
    toast(`Could not reach the sign-in page: ${errMsg(e)}`, true);
  } finally {
    el.sessionQrImg.classList.remove('busy');
  }
}
el.startBtn.addEventListener('click', () => start());
el.start.addEventListener('click', (e) => {
  if (e.target === el.start) start();
});

function syncActionButtons(): void {
  el.actMuteIco.textContent = prefs.muted ? '🔇' : '🔊';
  el.actAuto.classList.toggle('on', prefs.autoscroll);
  el.actAutoLabel.textContent = prefs.autoscroll ? 'Auto on' : 'Auto off';
}
syncActionButtons();

function toggleAutoscroll(): void {
  prefs.autoscroll = !prefs.autoscroll;
  savePrefs();
  for (const e of state.entries) if (e.player) e.player.loop = !prefs.autoscroll;
  syncActionButtons();
  toast(prefs.autoscroll ? 'Auto-scroll on: next video plays when this one ends' : 'Auto-scroll off: videos loop');
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.app.requestFullscreen().catch((e) => toast(`Fullscreen refused: ${(e as Error).message}`, true));
}

function toggleBars(): void {
  const on = el.app.classList.toggle('fullwindow');
  if (on) toast('Bars hidden. Press W or Esc to show them again');
}

function start(): void {
  state.started = true;
  el.start.classList.add('hidden');
  el.feed.focus();
  const cur = activeEntry();
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
  } else if (s.state === 'login_pending' && s.loginMode === 'qr' && s.qrState === 'verify' && s.verifyStep === 'code') {
    lines.push('<b>Almost there – enter the code TikTok e-mailed you.</b>');
    lines.push(esc(s.message || ''));
  } else if (s.state === 'login_pending' && s.loginMode === 'qr') {
    lines.push('<b>Scan to sign in.</b>');
    lines.push('In the TikTok app: Profile → ☰ menu → My QR code → scan icon (or point the in-app camera at this code), then confirm. The code refreshes by itself; this page updates automatically.');
    if (!s.qr && /did not show/i.test(s.message || '')) lines.push(`<span style="color:var(--muted)">${esc(s.message || '')}</span>`);
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
  el.sessionLogin.classList.toggle('hidden', !idle);
  el.sessionLoginWindow.classList.toggle('hidden', !idle);
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
  el.navProfile.classList.toggle('active', s.state === 'logged_in');
}
const SIGNIN_KEY = 'streamanywhere.feed.signin';
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
    } else showCodeResult('err', 'TikTok gave no answer to that code. Try again, or press "Resend code" for a fresh one.');
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

async function refreshSession(announce = false): Promise<SessionStatus | undefined> {
  try {
    const prev = state.session?.state;
    state.session = await api.session();
    renderSession();
    if (announce) toast(state.session.message || state.session.state);
    if (state.session.state === 'logged_in' && prev === 'login_pending') {
      closeSessionPanel();
      toast(`Signed in as @${state.session.username || '?'} – loading your For You feed`);
      prefs.source = 'foryou';
      savePrefs();
      renderSourceUi();
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
    renderSession();
  } finally {
    el.sessionLogin.disabled = el.sessionLoginWindow.disabled = false;
  }
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
    state.session = await api.sessionCancel();
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
  el.sessionText.innerHTML = '<b>Signing out…</b>\nClosing the browser session on the server (a few seconds).';
  try {
    state.session = await api.sessionLogout();
    renderSession();
    if (prefs.source === 'foryou') {
      prefs.source = 'explore';
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

// ---------- loading indicator: centered with details while the viewer waits, a small chip otherwise ----------
let loadingTicker = 0;
function sourceLabel(): string {
  if (prefs.source === 'foryou') return 'your For You feed';
  const cat = EXPLORE_CATEGORIES.find((c) => c.id === prefs.category);
  return `Explore${cat && cat.id !== 120 ? ' · ' + cat.label : ''}`;
}
function showLoading(title: string, detail: string, centered: boolean): void {
  el.loading.classList.remove('hidden');
  el.loading.classList.toggle('compact', !centered);
  el.loadingTitle.textContent = title;
  el.loadingDetail.textContent = detail;
}
function hideLoading(): void {
  clearInterval(loadingTicker);
  el.loading.classList.add('hidden');
}
/** Shows what the page is waiting for, updating the detail line as the wait grows. */
function startLoadingStatus(): void {
  clearInterval(loadingTicker);
  const t0 = Date.now();
  const waiting = () => state.entries.length === 0 || state.wantNext || state.active >= state.entries.length - 1;
  const render = () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const first = state.entries.length === 0;
    let title = first ? `Loading ${sourceLabel()}…` : 'Loading more videos…';
    let detail = 'Asking the server for the next videos';
    if (sec >= 5) detail = 'The server is fetching from TikTok…';
    if (sec >= 12) detail = prefs.source === 'foryou' ? 'Reading your feed from the signed-in TikTok session\n(a fresh browser start can take up to a minute)' : 'TikTok is slow to answer; the server is retrying through its browser…';
    if (sec >= 40) detail += `\n${sec} s so far – still trying`;
    if (state.emptyBatches > 0 && first) title = `Still loading ${sourceLabel()}…`;
    showLoading(title, detail, waiting());
  };
  render();
  loadingTicker = window.setInterval(render, 1000);
}
function showRetryStatus(delayMs: number): void {
  clearInterval(loadingTicker);
  const until = Date.now() + delayMs;
  const render = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    const waiting = state.entries.length === 0 || state.wantNext || state.active >= state.entries.length - 1;
    if (!waiting) return hideLoading();
    showLoading(
      state.entries.length ? 'No new videos yet' : `TikTok returned no videos for ${sourceLabel()}`,
      `Retrying in ${left} s… (TikTok limits how fast it hands out videos)`,
      true,
    );
    if (left <= 0) clearInterval(loadingTicker);
  };
  render();
  loadingTicker = window.setInterval(render, 1000);
}

// ---------- feed loading ----------
async function reload(): Promise<void> {
  state.generation++;
  clearTimeout(state.retryTimer);
  for (const e of state.entries) releasePlayer(e);
  state.entries = [];
  state.ids = new Set();
  state.active = -1;
  state.exhausted = false;
  state.emptyBatches = 0;
  state.wantNext = false;
  el.feed.innerHTML = '';
  el.feed.scrollTop = 0;
  await loadMore();
}

/** Fetches the next batch; returns how many videos were added. */
async function loadMore(): Promise<number> {
  if (state.loading || state.exhausted) return 0;
  state.loading = true;
  const gen = state.generation;
  startLoadingStatus();
  let added = 0;
  try {
    const r = await api.feed({ source: prefs.source, category: prefs.source === 'explore' ? prefs.category : undefined, count: 12 });
    if (gen !== state.generation) return 0;
    for (const item of r.items) {
      if (state.ids.has(item.id) || !sourceCandidates(item).length) continue;
      state.ids.add(item.id);
      state.entries.push(makeEntry(item));
      added++;
    }
    for (const w of r.warnings) console.warn('[feed]', w);
    if (!added) {
      state.emptyBatches++;
      if (!r.items.length && !r.hasMore) state.exhausted = true;
    } else state.emptyBatches = 0;
    if (!state.entries.length && state.emptyBatches >= 3) showEmpty(r.warnings[0] || 'The feed returned no playable videos. Try again or pick another category.');
    if (state.active < 0 && state.entries.length) setActive(0);
  } catch (e) {
    if (gen !== state.generation) return 0;
    state.emptyBatches++;
    const msg = errMsg(e);
    console.warn('[feed] batch failed:', msg);
    if (state.emptyBatches === 1 || state.emptyBatches % 4 === 0) toast(`Feed: ${msg} – retrying`, true, 5000);
    if (!state.entries.length && state.emptyBatches >= 3) showEmpty(`Feed failed: ${msg}`);
    if (prefs.source === 'foryou' && /not signed in|session/i.test(msg)) void openSessionPanel();
  } finally {
    state.loading = false;
    hideLoading();
  }
  if (added && state.wantNext) {
    state.wantNext = false;
    goTo(state.active + 1);
  }
  scheduleMoreIfNeeded();
  return added;
}

/**
 * Like the app, the feed never ends: when the viewer is close to the last loaded video and the
 * previous batch brought nothing (TikTok's soft limits, duplicates), retry with a growing delay.
 */
function scheduleMoreIfNeeded(): void {
  clearTimeout(state.retryTimer);
  if (state.exhausted || state.loading) return;
  const nearEnd = state.active >= state.entries.length - 3;
  if (!nearEnd) return;
  const delay = state.emptyBatches === 0 ? 0 : Math.min(20_000, 3000 * 2 ** (state.emptyBatches - 1));
  if (delay) showRetryStatus(delay);
  state.retryTimer = window.setTimeout(() => void loadMore(), delay);
}

function showEmpty(text: string): void {
  if (el.feed.querySelector('.empty-state')) return;
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
  const label = item.desc || `video by @${item.author.uniqueId || '?'}`;
  // Poster: shown until the player paints its first frame (the canvas is hidden until then).
  if (item.cover) {
    const cover = document.createElement('img');
    cover.className = 'cover';
    cover.src = item.cover;
    cover.alt = '';
    cover.decoding = 'async';
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
  meta.textContent = [item.music ? `♫ ${item.music}` : '', item.stats.plays !== undefined ? `${fmtCount(item.stats.plays)} plays` : '', item.stats.likes !== undefined ? `${fmtCount(item.stats.likes)} likes` : '']
    .filter(Boolean)
    .join(' · ');
  info.appendChild(meta);
  root.appendChild(info);

  // Progress bar: click or drag anywhere on it to seek (touch too; it never scrolls the feed).
  // A canvas seek resets the decoders, so while dragging the bar only follows the pointer and
  // the player is seeked at most every SEEK_THROTTLE_MS plus once more on release.
  const progress = document.createElement('div');
  progress.className = 'progress';
  const bar = document.createElement('i');
  progress.appendChild(bar);
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
    userScrollAt = Date.now();
    seekTo(e.clientX, true);
  });
  progress.addEventListener('pointermove', (e) => {
    if (!seeking) return;
    e.stopPropagation();
    userScrollAt = Date.now();
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

  const entry: Entry = { item, root, canvas, progress: bar, err, triedProxy: false, failed: false, isSeeking: () => seeking };

  // Tap/click on the picture (poster or canvas) = pause/resume. The info block and progress bar
  // handle their own pointer events.
  for (const target of [canvas, root.querySelector<HTMLImageElement>('.cover')]) {
    target?.addEventListener('click', () => {
      if (suppressClickUntil > Date.now()) return; // the click that ends a drag
      togglePause(entry);
    });
  }

  el.feed.appendChild(root);
  observer.observe(root);
  return entry;
}

/** Creates the entry's canvas player (idempotent). */
function ensurePlayer(entry: Entry): FeedPlayer {
  if (entry.player) return entry.player;
  const player = new FeedPlayer(entry.canvas, entry.root, {
    onFirstFrame: () => entry.root.classList.add('has-frame'),
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
    },
  });
  player.loop = !prefs.autoscroll;
  player.setMuted(prefs.muted);
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
  entry.player.destroy();
  entry.player = undefined;
  entry.src = undefined;
  entry.root.classList.remove('has-frame', 'paused');
  entry.progress.style.width = '0%';
}

function attachSource(entry: Entry, which: 'direct' | 'proxy' | 'auto' = 'auto'): boolean {
  const cands = sourceCandidates(entry.item);
  const pick = which === 'auto' ? cands[0] : cands.find((c) => c.kind === which);
  if (!pick) return false;
  if (entry.player && entry.src?.url === pick.url) return true;
  entry.src = pick;
  entry.root.classList.remove('has-frame');
  const p = ensurePlayer(entry);
  void p.load(pick.url, pick.kind, `TikTok ${entry.item.id} (${pick.kind})`);
  return true;
}

function onPlayerError(entry: Entry, e: Error): void {
  const detail = e.message || 'unknown error';
  if (entry.src?.kind === 'direct' && !entry.triedProxy && sourceCandidates(entry.item).some((c) => c.kind === 'proxy')) {
    entry.triedProxy = true;
    console.warn(`[feed] direct URL failed for ${entry.item.id} (${detail}); retrying through the proxy`);
    // A renderer that reported an error is finished; start a fresh one for the proxy URL.
    releasePlayer(entry);
    attachSource(entry, 'proxy');
    if (activeEntry() === entry && state.started) void playEntry(entry);
    return;
  }
  entry.failed = true;
  entry.err.textContent = `This video could not be loaded (${detail}).`;
  entry.err.classList.remove('hidden');
  if (activeEntry() === entry && prefs.autoscroll) window.setTimeout(() => activeEntry() === entry && goTo(state.active + 1), 1500);
}

async function playEntry(entry: Entry): Promise<void> {
  if (!state.started || entry.failed) return;
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

function setActive(idx: number): void {
  if (idx < 0 || idx >= state.entries.length) return;
  const prev = activeEntry();
  if (prev && prev !== state.entries[idx]) {
    prev.player?.pause();
    prev.root.classList.remove('paused');
    prev.player?.seek(0);
  }
  state.active = idx;
  state.userPaused = false;
  const cur = state.entries[idx];
  void playEntry(cur);
  // Warm the neighbours (their players fetch and decode the first frames, then idle on
  // backpressure), release the rest so decoders and audio contexts do not pile up.
  state.entries.forEach((e, i) => {
    const d = Math.abs(i - idx);
    if (d === 1) {
      if (!e.failed) attachSource(e);
    } else if (d > 2 && e.player) {
      releasePlayer(e);
    }
  });
  scheduleMoreIfNeeded();
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
  // scrollTo on the container (not scrollIntoView) so the page itself never scrolls on phones.
  el.feed.scrollTo({ top: idx * el.feed.clientHeight, behavior: 'smooth' });
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
  const name = `@${(item.author.uniqueId || 'tiktok').replace(/[^\w.-]+/g, '_')}_${item.id}.mp4`;
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
    el.actDownloadIco.textContent = '⬇';
  }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  const cur = activeEntry();
  switch (e.key) {
    case 'ArrowDown':
    case 'j':
    case 'J':
    case 'PageDown':
      e.preventDefault();
      if (!state.started) start();
      userScrollAt = Date.now();
      goTo(state.active + 1);
      break;
    case 'ArrowUp':
    case 'k':
    case 'K':
    case 'PageUp':
      e.preventDefault();
      userScrollAt = Date.now();
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
      toggleBars();
      break;
    case 'Escape':
      if (el.app.classList.contains('fullwindow')) toggleBars();
      if (!el.session.classList.contains('hidden') && el.sessionClose.classList.contains('hidden') === false) closeSessionPanel();
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

// ---------- touch: swipe up/down = next/previous video (like the app) ----------
// Native scroll-snap already moves one item per flick; this guarantees it for short or fast swipes
// and keeps a half-dragged video from sticking between two snap points.
let touchStartY = 0;
let touchStartX = 0;
let touchStartAt = 0;
let touchStartIdx = 0;
let touchMoved = false;
let touching = false;
let swipeTimer = 0;
function settleAfterSwipe(target: number): void {
  // The browser's own snap animation runs after the gesture; only step in if it settles elsewhere.
  clearTimeout(swipeTimer);
  swipeTimer = window.setTimeout(() => {
    const h = Math.max(1, el.feed.clientHeight);
    if (Math.round(el.feed.scrollTop / h) !== target) goTo(target);
  }, 450);
}
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
    if (touchStartIdx + (dy > 0 ? 1 : -1) >= state.entries.length) goTo(state.entries.length);
    else settleAfterSwipe(target);
  },
  { passive: true },
);
el.feed.addEventListener(
  'touchcancel',
  () => {
    touching = false;
  },
  { passive: true },
);
el.feed.addEventListener(
  'wheel',
  () => {
    userScrollAt = Date.now();
  },
  { passive: true },
);

// ---------- mouse: press, drag up/down, release = next/previous video ----------
let dragStartY = 0;
let dragStartIdx = 0;
let dragging = false;
el.feed.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest('a, button')) return;
  dragging = true;
  dragStartY = e.clientY;
  dragStartIdx = Math.round(el.feed.scrollTop / Math.max(1, el.feed.clientHeight));
  userScrollAt = Date.now();
  el.feed.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  userScrollAt = Date.now();
  if (Math.abs(e.clientY - dragStartY) > 6) e.preventDefault();
});
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  el.feed.classList.remove('dragging');
  const dy = dragStartY - e.clientY;
  if (Math.abs(dy) < 40) return; // a click, handled by the video's click listener
  suppressClickUntil = Date.now() + 400;
  if (!state.started) start();
  const next = dragStartIdx + (dy > 0 ? 1 : -1);
  if (next < 0) return;
  goTo(next);
});

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
  if (touching || dragging || Date.now() - userScrollAt < 900) {
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
  const cur = activeEntry();
  if (!cur) return;
  if (document.hidden) cur.player?.pause();
  else if (!state.userPaused) void playEntry(cur);
});

// ---------- boot ----------
// The feed must not wait for the session check (it may launch a browser on the server): start with
// Explore right away, and switch to For You as soon as the server confirms a signed-in profile.
void (async () => {
  const wanted = prefs.source;
  if (wanted === 'foryou') {
    prefs.source = 'explore';
    renderSourceUi();
  }
  const feedReady = loadMore();
  let resuming = false;
  try {
    resuming = localStorage.getItem(SIGNIN_KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  if (resuming) {
    // A sign-in was pending when the page was last open: show the panel right away, in the right step.
    el.session.classList.remove('hidden');
    el.sessionText.innerHTML = '<b>Resuming your TikTok sign-in…</b>\nChecking where it stands on the server.';
  }
  const s = await refreshSession();
  if (s?.state === 'login_pending') {
    el.session.classList.remove('hidden');
    pollSession();
    if (s.qrState === 'verify' && s.verifyStep === 'code') toast('Your sign-in is waiting for the e-mailed code', false, 5000);
  } else if (resuming && s && !s.probing && s.state !== 'logged_in') {
    toast('The sign-in is no longer pending on the server – start it again from Profile', false, 6000);
  }
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
      savePrefs();
      renderSourceUi();
      await feedReady;
      toast(`Signed in as @${state.session.username || '?'} – loading your For You feed`);
      void reload();
    } else {
      savePrefs();
      if (state.session?.supported) toast('Sign in (Profile) to see your For You feed; showing Explore meanwhile.', false, 5000);
    }
  }
})();

// Debug handle (console / automated checks): the state plus the two navigation entry points, so the
// feed can be driven where scrolling and IntersectionObserver do not run (hidden or occluded tabs).
(window as unknown as { streamAnywhereFeed: unknown }).streamAnywhereFeed = Object.assign(state, { setActive, goTo });
