/**
 * The Mirror viewer (mirror.html): the Tesla's browser (or any browser) shows an iPhone's screen.
 *
 * Two ways in:
 *   - from the StreamAnywhere server: mirror.html, type the six-letter code the phone shows (or open
 *     mirror.html?room=CODE from the phone's QR code). The frames come over the server's relay and,
 *     when the networks allow it, straight from the phone over WebRTC (watch.ts decides).
 *   - from the phone itself on its hotspot: http://172.20.10.1:8420/ serves this same page
 *     (mirror-local.html, built into one file for the app); the frames come over the local WebSocket.
 *
 * Decoding: WebCodecs onto a canvas where the page is secure (https), Media Source Extensions
 * into a <video> otherwise (sinks.ts).
 */
import { IPHONE_HOTSPOT_ADDRESS, isRoomCode, MIRROR_LOCAL_PORT, normalizeRoomCode, type MirrorConfig } from '../../../shared/mirror';
import { createSink, mseAvailable, webCodecsAvailable, type MediaSink } from './sinks';
import { MirrorWatcher, type WatchStatus } from './watch';

const LOCAL = document.documentElement.dataset.mirrorLocal === '1';
const LAST_ROOM_KEY = 'streamanywhere.mirror.lastRoom';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const el = {
  entry: $('entry'),
  code: $<HTMLInputElement>('code'),
  watch: $<HTMLButtonElement>('watch'),
  entryNote: $('entry-note'),
  entryError: $('entry-error'),
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

const params = new URLSearchParams(location.search);
const preferDecoder = params.get('decoder') === 'mse' ? 'mse' : params.get('decoder') === 'webcodecs' ? 'webcodecs' : undefined;
const directAllowed = params.get('direct') !== '0';

// ------------------------------------------------------------ entry screen

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
    : `Type the code the phone shows. On the phone's hotspot you can also open http://${IPHONE_HOTSPOT_ADDRESS}:${MIRROR_LOCAL_PORT}/ for the direct local link. ${describeSupport()}`;
  if (!LOCAL) el.code.focus();
}

function rememberRoom(code: string): void {
  try {
    localStorage.setItem(LAST_ROOM_KEY, code);
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

el.code.addEventListener('input', () => {
  const v = normalizeRoomCode(el.code.value);
  if (v !== el.code.value) el.code.value = v;
  el.watch.disabled = !isRoomCode(v);
});
el.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && isRoomCode(el.code.value)) startWatching(el.code.value);
});
el.watch.addEventListener('click', () => startWatching(LOCAL ? 'LOCAL0' : el.code.value));

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

function renderStatus(s: WatchStatus): void {
  lastStatus = s;
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

function startWatching(code: string): void {
  if (!LOCAL && !isRoomCode(code)) return;
  try {
    sink = createSink(preferDecoder);
  } catch (e) {
    showEntry((e as Error).message);
    return;
  }
  if (!LOCAL) rememberRoom(code);
  el.entry.hidden = true;
  el.player.hidden = false;
  el.stage.replaceChildren(sink.element);
  sink.setMuted(muted);
  void sink.unlock(); // from the tap on Watch
  void keepAwake();
  const apiBase = params.get('api') || undefined;
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
  void wakeLock?.release().catch(() => undefined);
  wakeLock = undefined;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  if (!LOCAL) {
    const u = new URL(location.href);
    u.searchParams.delete('room');
    history.replaceState(null, '', u.toString());
  }
  showEntry();
}

el.btnLeave.addEventListener('click', stopWatching);
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
  const fromUrl = normalizeRoomCode(params.get('room') || '');
  el.code.value = fromUrl || lastRoom();
  el.watch.disabled = !isRoomCode(el.code.value);
  showEntry();
  // a scanned QR code brought the code along: one tap (the browser needs a gesture for sound) and it plays
  if (isRoomCode(fromUrl)) el.watch.textContent = 'Tap to watch';
}
