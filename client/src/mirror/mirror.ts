/**
 * The Mirror viewer (mirror.html): the Tesla's browser (or any browser) shows an iPhone's screen.
 *
 * Two ways in:
 *   - from the StreamAnywhere server: mirror.html shows a pairing code (a QR code) for its room and
 *     waits in that room. The phone scans the code in the StreamAnywhere app (or with the Camera app),
 *     which signs the phone in and gives it the room; when the phone starts mirroring, the picture
 *     takes over here by itself. The room is remembered, so a phone that paired once just starts
 *     next time. A code typed by hand (mirror.html?room=CODE) still works. The frames come over the
 *     server's relay and, when the networks allow it, straight from the phone over WebRTC (watch.ts).
 *   - from the phone itself on its hotspot: http://172.20.10.1:8420/ serves this same page
 *     (mirror-local.html, built into one file for the app); the frames come over the local WebSocket.
 *
 * Decoding: WebCodecs onto a canvas where the page is secure (https), Media Source Extensions
 * into a <video> otherwise (sinks.ts).
 */
import QRCode from 'qrcode';
import { IPHONE_HOTSPOT_ADDRESS, isRoomCode, MIRROR_LOCAL_PORT, normalizeRoomCode, type MirrorConfig, type MirrorPairInfo } from '../../../shared/mirror';
import { createSink, mseAvailable, webCodecsAvailable, type MediaSink } from './sinks';
import { MirrorWatcher, type WatchStatus } from './watch';

const LOCAL = document.documentElement.dataset.mirrorLocal === '1';
const LAST_ROOM_KEY = 'streamanywhere.mirror.lastRoom';
/** A new pairing code before the old one expires (the server's tokens live five minutes) */
const PAIR_REFRESH_MS = 4 * 60 * 1000;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const $opt = <T extends HTMLElement = HTMLElement>(id: string): T | undefined => (document.getElementById(id) as T | null) || undefined;
const el = {
  entry: $('entry'),
  code: $<HTMLInputElement>('code'),
  watch: $<HTMLButtonElement>('watch'),
  entryNote: $('entry-note'),
  entryError: $('entry-error'),
  // the lobby (the server page only)
  qr: $opt('qr'),
  roomCode: $opt('room-code'),
  lobbyStatus: $opt('lobby-status'),
  lobbyStatusText: $opt('lobby-status-text'),
  newCode: $opt<HTMLButtonElement>('new-code'),
  player: $('player'),
  stage: $('stage'),
  overlay: $('overlay'),
  overlayText: $('overlay-text'),
  overlaySub: $('overlay-sub'),
  hud: $('hud'),
  hudPath: $('hud-path'),
  hudName: $('hud-name'),
  hudStats: $('hud-stats'),
  hudLinks: $('hud-links'),
  btnSound: $<HTMLButtonElement>('btn-sound'),
  btnFull: $<HTMLButtonElement>('btn-full'),
  btnLeave: $<HTMLButtonElement>('btn-leave'),
  btnRetry: $<HTMLButtonElement>('btn-retry'),
  home: $('home'),
};

let sink: MediaSink | undefined;
let watcher: MirrorWatcher | undefined;
let muted = false;
let wakeLock: { release(): Promise<void> } | undefined;
let hudTimer = 0;
let statsTimer = 0;
let lastStatus: WatchStatus | undefined;
let config: MirrorConfig | undefined;
/** The picture has shown in this watcher's life: a short reconnect keeps the player, not the lobby */
let wasLive = false;
let pairTimer = 0;
let currentRoom = '';

const params = new URLSearchParams(location.search);
const preferDecoder = params.get('decoder') === 'mse' ? 'mse' : params.get('decoder') === 'webcodecs' ? 'webcodecs' : undefined;
const directAllowed = params.get('direct') !== '0';
const apiBase = params.get('api') || undefined;

// ------------------------------------------------------------ entry / lobby

function describeSupport(): string {
  if (webCodecsAvailable()) return 'Plays with WebCodecs (lowest delay).';
  if (mseAvailable()) return window.isSecureContext ? 'Plays through Media Source Extensions.' : 'Plays through Media Source Extensions (this page is plain http, so WebCodecs is unavailable).';
  return 'This browser has neither WebCodecs nor Media Source Extensions: it cannot show the mirror.';
}

function showEntry(error?: string): void {
  el.player.hidden = true;
  el.entry.hidden = false;
  el.entryError.textContent = error || '';
  el.entryError.hidden = !error;
  el.entryNote.textContent = LOCAL
    ? `Connected to the phone over its hotspot. ${describeSupport()}`
    : `On the phone's hotspot, open http://${IPHONE_HOTSPOT_ADDRESS}:${MIRROR_LOCAL_PORT}/ instead: no internet needed. ${describeSupport()}`;
}

function rememberRoom(code: string): void {
  try {
    if (code) localStorage.setItem(LAST_ROOM_KEY, code);
    else localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* ignore */
  }
}
function lastRoom(): string {
  try {
    return localStorage.getItem(LAST_ROOM_KEY) || '';
  } catch {
    return '';
  }
}

function setLobbyStatus(text: string, kind: 'waiting' | 'paired' | 'error' = 'waiting'): void {
  if (!el.lobbyStatus || !el.lobbyStatusText) return;
  el.lobbyStatusText.textContent = text;
  el.lobbyStatus.dataset.kind = kind;
}

/** Asks the server for a pairing code for the room (the remembered one, or a new one) and draws it. */
async function refreshPairing(room: string): Promise<MirrorPairInfo | undefined> {
  clearTimeout(pairTimer);
  try {
    const r = await fetch(new URL('/api/mirror/pair', apiBase || location.origin).toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: room || undefined }),
    });
    if (!r.ok) throw new Error(r.status === 401 ? 'Signed out: reload the page and sign in.' : `The server answered ${r.status}.`);
    const info = (await r.json()) as MirrorPairInfo;
    if (el.roomCode) el.roomCode.textContent = info.room;
    if (el.qr) el.qr.innerHTML = await QRCode.toString(info.url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#000000', light: '#ffffff' } });
    pairTimer = window.setTimeout(() => void refreshPairing(info.room), PAIR_REFRESH_MS);
    return info;
  } catch (e) {
    setLobbyStatus(`No pairing code: ${(e as Error).message}`, 'error');
    pairTimer = window.setTimeout(() => void refreshPairing(room), 10_000);
    return undefined;
  }
}

/** The server page's start: a pairing code for the room, and a watcher waiting in it. */
async function openLobby(room: string): Promise<void> {
  showEntry();
  setLobbyStatus('Getting a pairing code…');
  const info = await refreshPairing(room);
  if (!info) return;
  if (info.room !== currentRoom) {
    rememberRoom(info.room);
    startWatching(info.room);
  }
}

el.code.addEventListener('input', () => {
  const v = normalizeRoomCode(el.code.value);
  if (v !== el.code.value) el.code.value = v;
  el.watch.disabled = !isRoomCode(v);
});
el.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && isRoomCode(el.code.value)) watchTypedCode();
});
el.watch.addEventListener('click', () => (LOCAL ? startWatching('LOCAL0') : watchTypedCode()));
el.newCode?.addEventListener('click', () => {
  rememberRoom('');
  stopWatching();
  void openLobby('');
});

function watchTypedCode(): void {
  const code = el.code.value;
  if (!isRoomCode(code)) return;
  el.code.value = '';
  el.watch.disabled = true;
  stopWatching();
  void openLobby(code);
}

// the browser plays sound only after a gesture: any tap on the page counts
document.addEventListener('pointerdown', () => void sink?.unlock());

// ------------------------------------------------------------ player

async function keepAwake(): Promise<void> {
  try {
    const n = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (n.wakeLock && !wakeLock) wakeLock = await n.wakeLock.request('screen');
  } catch {
    /* not available (or the page is hidden) */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watcher) void keepAwake();
});

function fitStage(): void {
  if (!sink || !config?.video) return;
  const rot = config.video.rotation || 0;
  const e = sink.element;
  if (!(e instanceof HTMLVideoElement)) return; // the canvas already has the upright size
  const sw = el.stage.clientWidth;
  const sh = el.stage.clientHeight;
  if (rot === 90 || rot === 270) {
    // the element is laid out sideways, then turned: its box is the stage turned on its side
    e.style.width = `${sh}px`;
    e.style.height = `${sw}px`;
    e.style.left = `${(sw - sh) / 2}px`;
    e.style.top = `${(sh - sw) / 2}px`;
  } else {
    e.style.width = '';
    e.style.height = '';
    e.style.left = '';
    e.style.top = '';
  }
}
window.addEventListener('resize', fitStage);

function showHud(temporary = true): void {
  el.hud.classList.remove('hidden');
  clearTimeout(hudTimer);
  if (temporary) hudTimer = window.setTimeout(() => el.hud.classList.add('hidden'), 4000);
}
el.stage.addEventListener('click', () => {
  if (el.hud.classList.contains('hidden')) showHud();
  else el.hud.classList.add('hidden');
});

function pathLabel(s: WatchStatus): string {
  if (s.path === 'local') return 'Local';
  if (s.path === 'direct') return 'Direct';
  return 'Relay';
}

function showPlayer(): void {
  if (!el.player.hidden) return;
  el.entry.hidden = true;
  el.player.hidden = false;
  void sink?.unlock();
  void keepAwake();
  fitStage();
}

function renderStatus(s: WatchStatus): void {
  lastStatus = s;
  if (s.state === 'live') wasLive = true;
  // the lobby (with the pairing code) until the picture arrives; the player's own overlay for a blip after that
  const inLobby = !LOCAL && s.state !== 'live' && (!wasLive || s.state === 'waiting' || s.state === 'ended');
  if (inLobby) {
    showEntry();
    if (s.state === 'waiting') setLobbyStatus(s.message || 'Waiting for the phone…', s.message?.includes('paired') ? 'paired' : 'waiting');
    else if (s.state === 'ended') setLobbyStatus(`${s.message || 'The stream ended'} – getting a new code…`, 'error');
    else if (s.state === 'error') setLobbyStatus(s.message || 'Something went wrong', 'error');
    else setLobbyStatus(s.message || 'Connecting to the server…');
    if (s.state === 'ended' || s.state === 'error') {
      // the room went away (or the link failed for good): a fresh code makes a fresh room
      stopWatching();
      window.setTimeout(() => void openLobby(lastRoom()), 2500);
    }
    return;
  }
  if (s.state === 'live') showPlayer();
  el.hudPath.textContent = pathLabel(s);
  el.hudPath.dataset.path = s.path;
  el.hudName.textContent = s.senderName ? s.senderName : '';
  const links: string[] = [];
  if (!LOCAL) {
    links.push(`relay: ${s.relay}`);
    links.push(`direct: ${s.direct}`);
  }
  if (s.watchers > 1) links.push(`${s.watchers} watching`);
  el.hudLinks.textContent = links.join(' · ');
  el.btnRetry.hidden = LOCAL || s.direct === 'open' || s.direct === 'connecting' || s.state !== 'live';
  const busy = s.state !== 'live';
  el.overlay.hidden = !busy;
  if (busy) {
    el.overlayText.textContent =
      s.state === 'connecting' ? 'Connecting…' : s.state === 'waiting' ? 'Waiting for the phone' : s.state === 'ended' ? 'The stream ended' : 'Something went wrong';
    el.overlaySub.textContent = s.message || '';
    el.overlay.classList.toggle('spin', s.state === 'connecting' || s.state === 'waiting');
    showHud(false);
  } else {
    showHud(true);
  }
}

function renderStats(): void {
  if (!sink || !lastStatus) return;
  const st = sink.stats();
  const parts: string[] = [];
  if (st.width) parts.push(`${st.width}×${st.height}`);
  parts.push(`${lastStatus.fps} fps`);
  parts.push(`${lastStatus.kbps >= 1000 ? (lastStatus.kbps / 1000).toFixed(1) + ' Mb/s' : lastStatus.kbps + ' kb/s'}`);
  parts.push(st.decoder === 'webcodecs' ? 'WebCodecs' : `MSE${st.behindS ? ` ${st.behindS.toFixed(2)} s behind` : ''}`);
  if (st.audio) parts.push(muted ? 'muted' : 'sound');
  if (st.dropped) parts.push(`${st.dropped} dropped`);
  if (st.error) parts.push(`⚠ ${st.error}`);
  el.hudStats.textContent = parts.join(' · ');
}

/** Joins the room: the sink and the watcher; the views follow the watcher's status. */
function startWatching(code: string): void {
  if (!LOCAL && !isRoomCode(code)) return;
  stopWatching();
  try {
    sink = createSink(preferDecoder);
  } catch (e) {
    showEntry((e as Error).message);
    setLobbyStatus((e as Error).message, 'error');
    return;
  }
  currentRoom = code;
  wasLive = false;
  el.stage.replaceChildren(sink.element);
  sink.setMuted(muted);
  void sink.unlock(); // after a tap (Watch); otherwise the first tap on the page unlocks the sound
  if (LOCAL) {
    el.entry.hidden = true;
    el.player.hidden = false;
    void keepAwake();
  }
  watcher = new MirrorWatcher(sink, {
    room: code,
    local: LOCAL,
    direct: directAllowed,
    apiBase,
    onStatus: renderStatus,
    onConfig: (c) => {
      config = c;
      fitStage();
    },
    onPaired: () => {
      // the code is spent: show the next one
      void refreshPairing(code);
    },
  });
  watcher.start();
  if (!LOCAL) {
    const u = new URL(location.href);
    u.searchParams.set('room', code);
    history.replaceState(null, '', u.toString());
  }
  clearInterval(statsTimer);
  statsTimer = window.setInterval(renderStats, 1000);
}

function stopWatching(): void {
  clearInterval(statsTimer);
  watcher?.stop();
  watcher = undefined;
  sink?.destroy();
  sink = undefined;
  config = undefined;
  currentRoom = '';
  wasLive = false;
  void wakeLock?.release().catch(() => undefined);
  wakeLock = undefined;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
}

el.btnLeave.addEventListener('click', () => {
  stopWatching();
  if (LOCAL) {
    showEntry();
    return;
  }
  clearTimeout(pairTimer);
  location.href = 'home.html';
});
el.btnRetry.addEventListener('click', () => watcher?.retryDirect());
el.btnSound.addEventListener('click', () => {
  muted = !muted;
  sink?.setMuted(muted);
  void sink?.unlock();
  el.btnSound.textContent = muted ? 'Sound off' : 'Sound on';
  el.btnSound.setAttribute('aria-pressed', String(!muted));
  showHud();
});
el.btnFull.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void el.player.requestFullscreen?.().catch(() => undefined);
  showHud();
});
window.addEventListener('pagehide', () => {
  watcher?.stop();
  sink?.destroy();
});

// ------------------------------------------------------------ start

if (LOCAL) {
  el.code.hidden = true;
  el.watch.disabled = false;
  el.watch.textContent = 'Tap to watch';
  el.home.hidden = true;
  showEntry();
} else {
  // a code in the link (typed on another device, or an old bookmark) wins; otherwise the remembered room
  const fromUrl = normalizeRoomCode(params.get('room') || '');
  void openLobby(isRoomCode(fromUrl) ? fromUrl : lastRoom());
}
