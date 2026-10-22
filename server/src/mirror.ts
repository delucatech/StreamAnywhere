/**
 * Mirror relay + signalling: the third of the three ways a mirrored screen reaches the Tesla.
 *
 * One WebSocket endpoint, /api/mirror/ws?room=CODE&role=sender|watcher (the site-password cookie
 * applies, like every other API call):
 *   - the sender (the phone's broadcast extension, or the desktop sender page) pushes the protocol
 *     messages of shared/mirror.ts: a CONFIG, then VIDEO / AUDIO frames;
 *   - every watcher (the Tesla browser) receives a copy of each message. A watcher that joins
 *     mid-stream first gets the CONFIG and the frames since the last keyframe (kept here, bounded),
 *     so the picture appears at once; the sender is asked for a fresh keyframe when there is none.
 *   - a watcher whose link is too slow (its socket buffer fills) stops getting frames until the next
 *     keyframe, which the sender is asked for, so it never falls further and further behind.
 *   - control messages (JSON text) let a watcher and the sender negotiate a direct WebRTC link
 *     through this socket ("signal"), and a watcher that receives the frames directly tells the
 *     relay to stop copying them ("relay": false) - the relay then costs nothing.
 *
 * Rooms are six-letter codes. POST /api/mirror/rooms reserves one; a sender may also connect with a
 * code of its own. A room lives while its sender or a watcher is connected and a few minutes beyond,
 * for the phone to reconnect.
 *
 * Pairing (how the phone gets in without the site password): the car's page, which is signed in,
 * asks POST /api/mirror/pair for a one-time token tied to its room and shows it as a QR code
 * (https://server/pair#TOKEN). The phone scans it - in the app, or with the Camera app, which opens
 * GET /pair, a public landing page that hands the token to the app through its URL scheme - and
 * the app claims it at POST /api/mirror/pair/claim (public: the token is the credential). The claim
 * answers with the room and the same login cookie a password would have given, so the broadcast
 * extension connects like any signed-in client, and the car's page is told ("paired").
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { appPairUrl, BEACON_PATH, isKeyVideo, isRoomCode, MSG, normalizeRoomCode, PAIR_PATH, PAIR_TOKEN_TTL_MS, pairUrl, ROOM_ALPHABET, ROOM_CODE_LENGTH, type IceServer, type MirrorBeacon, type MirrorConfig, type MirrorControl, type MirrorPairClaim, type MirrorPairInfo, type MirrorRoomInfo } from '../../shared/mirror';
import { issueAuthCookie, requestAuthorized } from './auth';

const WS_PATH = '/api/mirror/ws';
/** A watcher whose socket holds more than this is skipped until the next keyframe */
const WATCHER_HIGH_WATER = 3 * 1024 * 1024;
const WATCHER_LOW_WATER = 512 * 1024;
/** Frames kept since the last keyframe for late joiners (bounded by bytes and count) */
const GOP_MAX_BYTES = 8 * 1024 * 1024;
const GOP_MAX_FRAMES = 400;
/** A room without a sender is deleted after this */
const ROOM_IDLE_MS = 10 * 60 * 1000;
/** A reserved room nobody connected to */
const ROOM_RESERVED_MS = 15 * 60 * 1000;
const NEED_KEY_MIN_INTERVAL_MS = 700;
const PING_INTERVAL_MS = 20_000;
const MAX_ROOMS = 200;
const MAX_WATCHERS_PER_ROOM = 12;
/** The largest message a sender may push (a 4K keyframe is well under this) */
const MAX_MESSAGE_BYTES = 6 * 1024 * 1024;

interface Watcher {
  id: string;
  ws: WebSocket;
  /** false while the watcher receives the frames over its direct link */
  relay: boolean;
  /** dropping frames until the next keyframe (slow link, or just joined without a cached GOP) */
  waitingKey: boolean;
  alive: boolean;
  bytesSent: number;
  droppedFrames: number;
}

interface Sender {
  ws: WebSocket;
  name?: string;
  alive: boolean;
  bytesIn: number;
  frames: number;
  lastNeedKeyAt: number;
  /** what the sender was last told about the relay's need for frames */
  relayDemand: boolean;
}

interface Room {
  code: string;
  sender?: Sender;
  watchers: Map<string, Watcher>;
  config?: MirrorConfig;
  configMessage?: Buffer;
  /** the frames since the last keyframe (the keyframe first) */
  gop: Buffer[];
  gopBytes: number;
  createdAt: number;
  startedAt?: number;
  lastSenderAt: number;
}

const rooms = new Map<string, Room>();
let log: (level: 'info' | 'warn', what: Record<string, unknown>, msg: string) => void = () => undefined;

interface PairToken {
  token: string;
  room: string;
  createdAt: number;
  claimedAt?: number;
}
/** One-time pairing tokens (a few at a time: one per waiting car page, refreshed before it expires) */
const pairTokens = new Map<string, PairToken>();
const MAX_PAIR_TOKENS = 500;

function sweepPairTokens(): void {
  const now = Date.now();
  for (const [t, p] of pairTokens) if (p.claimedAt || now - p.createdAt > PAIR_TOKEN_TTL_MS) pairTokens.delete(t);
}

function newPairToken(room: string): PairToken {
  sweepPairTokens();
  if (pairTokens.size >= MAX_PAIR_TOKENS) {
    const oldest = [...pairTokens.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) pairTokens.delete(oldest.token);
  }
  const p: PairToken = { token: crypto.randomBytes(24).toString('base64url'), room, createdAt: Date.now() };
  pairTokens.set(p.token, p);
  return p;
}

/** Where this server is reached (behind Caddy the request says https in X-Forwarded-Proto) */
function publicOrigin(req: { protocol: string; hostname: string; headers: IncomingMessage['headers'] }): string {
  const https = req.protocol === 'https' || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
  return `${https ? 'https' : 'http'}://${req.hostname}`;
}

/**
 * The public landing page behind the QR code, for a phone that scanned it with the Camera app: hands
 * the token (in the fragment, so it never reached this server) to the app through its URL scheme.
 */
function pairLandingPage(origin: string): string {
  const appLink = appPairUrl(origin, '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07080c"><title>Pair with the Tesla – StreamAnywhere</title>
<style>
:root{color-scheme:dark;--bg:#07080c;--fg:#f2f4f8;--muted:#9aa3b5;--card:#141720;--line:#262b38;--accent:#4f8cff}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--fg);font:17px/1.45 -apple-system,system-ui,sans-serif}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px}
h1{margin:0 0 6px;font-size:26px}h1 small{display:block;font-size:15px;font-weight:400;color:var(--muted);margin-top:4px}
p{margin:14px 0;color:var(--muted)}
a.btn{display:block;text-align:center;padding:16px;border-radius:14px;background:var(--accent);color:#fff;font-weight:700;font-size:18px;text-decoration:none;margin-top:20px}
a.btn[hidden]{display:none}
.err{color:#ff6b7a}
ol{padding-left:20px;color:var(--muted)}li{margin:6px 0}
</style></head>
<body><main>
<h1>Mirror <small>Pair this iPhone with the Tesla</small></h1>
<p id="note">Opening the StreamAnywhere app…</p>
<a id="open" class="btn" href="#" hidden>Open StreamAnywhere</a>
<p id="help" hidden>No app yet? Install StreamAnywhere on this iPhone, then scan the code on the Tesla's screen again.</p>
<script>
(function(){
  var token=(location.hash||'').slice(1);
  var note=document.getElementById('note'),open=document.getElementById('open'),help=document.getElementById('help');
  if(!/^[A-Za-z0-9_-]{16,64}$/.test(token)){note.textContent='This link has no pairing code in it. Scan the code on the Tesla\\u2019s screen again.';note.className='err';return;}
  var link=${JSON.stringify(appLink)}+encodeURIComponent(token);
  open.href=link;open.hidden=false;help.hidden=false;
  note.textContent='Tap the button to open the StreamAnywhere app: it pairs this iPhone with the Tesla and you can start mirroring.';
  setTimeout(function(){location.href=link;},300);
})();
</script>
</main></body></html>`;
}

/** A phone claimed this room's pairing code: tell the car's page(s) */
function notifyPaired(room: Room, name: string | undefined): void {
  for (const w of room.watchers.values()) sendControl(w.ws, { t: 'paired', name });
}

const control = (m: MirrorControl): string => JSON.stringify(m);
const sendControl = (ws: WebSocket, m: MirrorControl): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(control(m));
};

function newRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('no free room code');
}

function getOrCreateRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = { code, watchers: new Map(), gop: [], gopBytes: 0, createdAt: Date.now(), lastSenderAt: 0 };
    rooms.set(code, room);
  }
  return room;
}

function roomInfo(room: Room): MirrorRoomInfo {
  return { room: room.code, live: Boolean(room.sender), name: room.sender?.name ?? room.config?.name, watchers: room.watchers.size, config: room.config, startedAt: room.startedAt };
}

function watcherCount(room: Room): number {
  return room.watchers.size;
}

/** Tells the sender whether the relay still needs its frames (a phone on a direct link to every watcher saves its data). */
function updateRelayDemand(room: Room): void {
  const s = room.sender;
  if (!s) return;
  const on = [...room.watchers.values()].some((w) => w.relay);
  if (on === s.relayDemand) return;
  s.relayDemand = on;
  sendControl(s.ws, { t: 'relay-demand', on });
  if (on) askForKeyframe(room, 'the relay needs frames again');
}

function askForKeyframe(room: Room, why: string): void {
  const s = room.sender;
  if (!s) return;
  const now = Date.now();
  if (now - s.lastNeedKeyAt < NEED_KEY_MIN_INTERVAL_MS) return;
  s.lastNeedKeyAt = now;
  sendControl(s.ws, { t: 'need-key' });
  log('info', { room: room.code, why }, 'mirror: keyframe requested');
}

/** The sender arrived: replace a previous connection of the same room (a reconnecting phone). */
function attachSender(room: Room, ws: WebSocket, name: string | undefined): void {
  if (room.sender && room.sender.ws !== ws) {
    try {
      room.sender.ws.close(4000, 'replaced by a new sender connection');
    } catch {
      /* already gone */
    }
  }
  const sender: Sender = { ws, name, alive: true, bytesIn: 0, frames: 0, lastNeedKeyAt: 0, relayDemand: true };
  room.sender = sender;
  room.startedAt = Date.now();
  room.lastSenderAt = room.startedAt;
  // a new sender connection starts a new stream: the old decoder configuration no longer applies
  room.config = undefined;
  room.configMessage = undefined;
  room.gop = [];
  room.gopBytes = 0;
  sendControl(ws, { t: 'ready', room: room.code, live: true, name, watchers: room.watchers.size });
  for (const w of room.watchers.values()) {
    w.waitingKey = true;
    sendControl(w.ws, { t: 'sender', event: 'join', name });
    sendControl(ws, { t: 'watcher', id: w.id, event: 'join', watchers: room.watchers.size });
  }
  if (room.watchers.size) askForKeyframe(room, 'sender joined with watchers waiting');
  updateRelayDemand(room);

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (room.sender !== sender) return;
    sender.alive = true;
    if (!isBinary) {
      let msg: MirrorControl | undefined;
      try {
        msg = JSON.parse(String(data)) as MirrorControl;
      } catch {
        return;
      }
      if (msg.t === 'signal' && msg.to) {
        const w = room.watchers.get(msg.to);
        if (w) sendControl(w.ws, { t: 'signal', from: 'sender', data: msg.data });
      } else if (msg.t === 'ping') {
        sendControl(ws, { t: 'pong' });
      } else if (msg.t === 'error') {
        log('warn', { room: room.code, message: msg.message }, 'mirror: sender reported an error');
      }
      return;
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buf.byteLength) return;
    sender.bytesIn += buf.byteLength;
    room.lastSenderAt = Date.now();
    const kind = buf[0];
    if (kind === MSG.CONFIG) {
      try {
        room.config = JSON.parse(buf.subarray(1).toString('utf8')) as MirrorConfig;
        if (!room.config.name && name) room.config.name = name;
      } catch {
        return;
      }
      room.configMessage = buf;
      room.gop = [];
      room.gopBytes = 0;
    } else if (kind === MSG.VIDEO || kind === MSG.AUDIO) {
      sender.frames++;
      if (isKeyVideo(buf)) {
        room.gop = [buf];
        room.gopBytes = buf.byteLength;
      } else if (room.gop.length && room.gop.length < GOP_MAX_FRAMES && room.gopBytes + buf.byteLength <= GOP_MAX_BYTES) {
        room.gop.push(buf);
        room.gopBytes += buf.byteLength;
      }
    } else {
      return;
    }
    let slow = false;
    for (const w of room.watchers.values()) {
      if (!w.relay || w.ws.readyState !== WebSocket.OPEN) continue;
      if (kind === MSG.CONFIG) {
        w.ws.send(buf, { binary: true });
        continue;
      }
      const buffered = w.ws.bufferedAmount;
      if (w.waitingKey) {
        if (kind === MSG.VIDEO && isKeyVideo(buf) && buffered < WATCHER_LOW_WATER) w.waitingKey = false;
        else {
          w.droppedFrames++;
          if (buffered >= WATCHER_LOW_WATER) slow = true;
          continue;
        }
      } else if (buffered > WATCHER_HIGH_WATER) {
        w.waitingKey = true;
        w.droppedFrames++;
        slow = true;
        continue;
      }
      w.ws.send(buf, { binary: true });
      w.bytesSent += buf.byteLength;
    }
    if (slow) askForKeyframe(room, 'a watcher fell behind');
    else if (kind === MSG.VIDEO && [...room.watchers.values()].some((w) => w.relay && w.waitingKey)) askForKeyframe(room, 'a watcher is waiting for a keyframe');
  });
  ws.on('close', () => {
    if (room.sender !== sender) return;
    room.sender = undefined;
    room.lastSenderAt = Date.now();
    for (const w of room.watchers.values()) sendControl(w.ws, { t: 'sender', event: 'leave', name });
    log('info', { room: room.code, frames: sender.frames, bytes: sender.bytesIn, watchers: room.watchers.size }, 'mirror: sender left');
  });
  log('info', { room: room.code, name, watchers: room.watchers.size }, 'mirror: sender joined');
}

function attachWatcher(room: Room, ws: WebSocket): void {
  if (room.watchers.size >= MAX_WATCHERS_PER_ROOM) {
    ws.close(4003, 'too many watchers');
    return;
  }
  const w: Watcher = { id: crypto.randomBytes(6).toString('base64url'), ws, relay: true, waitingKey: true, alive: true, bytesSent: 0, droppedFrames: 0 };
  room.watchers.set(w.id, w);
  sendControl(ws, { t: 'ready', room: room.code, live: Boolean(room.sender), name: room.sender?.name ?? room.config?.name, watchers: room.watchers.size, id: w.id });
  if (room.configMessage) {
    ws.send(room.configMessage, { binary: true });
    if (room.gop.length) {
      for (const f of room.gop) ws.send(f, { binary: true });
      w.bytesSent += room.gopBytes;
      w.waitingKey = false;
    }
  }
  if (room.sender) {
    sendControl(room.sender.ws, { t: 'watcher', id: w.id, event: 'join', watchers: room.watchers.size });
    if (w.waitingKey) askForKeyframe(room, 'watcher joined');
    updateRelayDemand(room);
  }
  for (const other of room.watchers.values()) if (other !== w) sendControl(other.ws, { t: 'watchers', n: room.watchers.size });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    w.alive = true;
    if (isBinary) return; // watchers send nothing but control messages
    let msg: MirrorControl | undefined;
    try {
      msg = JSON.parse(String(data)) as MirrorControl;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'signal':
        if (room.sender) sendControl(room.sender.ws, { t: 'signal', from: w.id, data: msg.data });
        break;
      case 'relay':
        if (w.relay !== Boolean(msg.on)) {
          w.relay = Boolean(msg.on);
          if (w.relay) {
            w.waitingKey = true;
            askForKeyframe(room, 'watcher back on the relay');
          }
          log('info', { room: room.code, watcher: w.id, relay: w.relay }, w.relay ? 'mirror: watcher back on the relay' : 'mirror: watcher on a direct link, relay paused');
          updateRelayDemand(room);
        }
        break;
      case 'need-key':
        w.waitingKey = true;
        askForKeyframe(room, 'watcher asked');
        break;
      case 'ping':
        sendControl(ws, { t: 'pong' });
        break;
      case 'error':
        log('warn', { room: room.code, watcher: w.id, message: msg.message }, 'mirror: watcher reported an error');
        break;
      default:
        break;
    }
  });
  ws.on('close', () => {
    room.watchers.delete(w.id);
    if (room.sender) sendControl(room.sender.ws, { t: 'watcher', id: w.id, event: 'leave', watchers: room.watchers.size });
    updateRelayDemand(room);
    for (const other of room.watchers.values()) sendControl(other.ws, { t: 'watchers', n: room.watchers.size });
    log('info', { room: room.code, watcher: w.id, bytes: w.bytesSent, dropped: w.droppedFrames, watchers: room.watchers.size }, 'mirror: watcher left');
  });
  log('info', { room: room.code, watcher: w.id, watchers: room.watchers.size, cached: room.gop.length }, 'mirror: watcher joined');
}

function sweepRooms(): void {
  sweepPairTokens();
  const now = Date.now();
  for (const [code, room] of rooms) {
    // a car's page waits in its room with the pairing code up for as long as it likes
    if (room.sender || room.watchers.size) continue;
    const idleSince = room.lastSenderAt || room.createdAt;
    const limit = room.lastSenderAt ? ROOM_IDLE_MS : ROOM_RESERVED_MS;
    if (now - idleSince < limit) continue;
    for (const w of room.watchers.values()) {
      try {
        w.ws.close(4001, 'the stream ended');
      } catch {
        /* ignore */
      }
    }
    rooms.delete(code);
  }
}

/** ICE servers the watcher and the phone use for the direct link: Google's STUN, plus a TURN relay when configured. */
export function iceServers(): IceServer[] {
  const out: IceServer[] = [];
  const stun = (process.env.MIRROR_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stun.length) out.push({ urls: stun });
  const turn = (process.env.MIRROR_TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (turn.length) out.push({ urls: turn, username: process.env.MIRROR_TURN_USERNAME || undefined, credential: process.env.MIRROR_TURN_PASSWORD || undefined });
  return out;
}

export function mirrorStats(): { rooms: number; live: number; watchers: number } {
  let live = 0;
  let watchers = 0;
  for (const r of rooms.values()) {
    if (r.sender) live++;
    watchers += r.watchers.size;
  }
  return { rooms: rooms.size, live, watchers };
}

/** Closes every socket (shutdown / tests). */
export function shutdownMirror(): void {
  for (const room of rooms.values()) {
    room.sender?.ws.terminate();
    for (const w of room.watchers.values()) w.ws.terminate();
  }
  rooms.clear();
}

export function registerMirror(app: FastifyInstance): void {
  log = (level, what, msg) => app.log[level]({ what: 'mirror', ...what }, msg);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      // not ours: nothing else on this server speaks WebSocket
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const role = url.searchParams.get('role') === 'sender' ? 'sender' : 'watcher';
    const code = normalizeRoomCode(url.searchParams.get('room') || '');
    const name = (url.searchParams.get('name') || '').slice(0, 60) || undefined;
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    // A refused connection is logged, and the room's watchers (the car's page, waiting with the
    // pairing code up) are told when it was their phone: the phone itself has no screen to say so.
    const refuse = (status: number, reason: string, tell?: string): void => {
      log('warn', { room: code, role, name, ip, status, reason }, 'mirror: connection refused');
      const room = rooms.get(code);
      if (tell && room) for (const w of room.watchers.values()) sendControl(w.ws, { t: 'note', message: tell, kind: 'error' });
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!requestAuthorized(req.headers)) {
      const hasCookie = /(^|;\s*)sa_auth=/.test(String(req.headers.cookie || ''));
      refuse(401, hasCookie ? 'the login cookie is not valid (another server, or the password changed)' : 'no login cookie', role === 'sender' ? `${name || 'The phone'} reached the server, but its sign-in was refused${hasCookie ? '' : ' (it sent none)'}: pair it again with the code on this screen.` : undefined);
      return;
    }
    if (!isRoomCode(code)) {
      refuse(404, 'not a room code');
      return;
    }
    if (role === 'watcher' && !rooms.has(code)) {
      refuse(404, 'no such room');
      return;
    }
    if (role === 'sender' && !rooms.has(code) && rooms.size >= MAX_ROOMS) {
      refuse(404, 'too many rooms');
      return;
    }
    log('info', { room: code, role, name, ip, known: rooms.has(code) }, 'mirror: connection accepted');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = getOrCreateRoom(code);
      ws.on('error', (e) => log('warn', { room: code, role, err: e.message }, 'mirror: socket error'));
      if (role === 'sender') attachSender(room, ws, name);
      else attachWatcher(room, ws);
    });
  });

  // keepalive: a car that drives out of coverage never sends a close frame
  const pinger = setInterval(() => {
    for (const room of rooms.values()) {
      const all: { alive: boolean; ws: WebSocket }[] = [...room.watchers.values()];
      if (room.sender) all.push(room.sender);
      for (const c of all) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }
    sweepRooms();
  }, PING_INTERVAL_MS);
  pinger.unref();
  wss.on('connection', (ws: WebSocket) => ws.on('pong', () => undefined));
  app.addHook('onClose', async () => {
    clearInterval(pinger);
    shutdownMirror();
  });

  app.post('/api/mirror/rooms', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    sweepRooms();
    if (rooms.size >= MAX_ROOMS) return reply.code(503).send({ error: 'Too many rooms right now' });
    const room = getOrCreateRoom(newRoomCode());
    return roomInfo(room);
  });

  app.get<{ Params: { code: string } }>('/api/mirror/rooms/:code', async (req, reply) => {
    const code = normalizeRoomCode(req.params.code);
    const room = rooms.get(code);
    if (!room) return reply.code(404).send({ error: 'No such room' });
    return roomInfo(room);
  });

  app.get('/api/mirror/ice', async () => ({ iceServers: iceServers() }));

  // ---- pairing (see the header comment)

  /** The car's page (signed in): a pairing code for its room - the remembered one, or a new one */
  app.post<{ Body: { room?: string } | null }>('/api/mirror/pair', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply): Promise<MirrorPairInfo | undefined> => {
    sweepRooms();
    let code = normalizeRoomCode(String(req.body?.room || ''));
    if (!isRoomCode(code)) {
      if (rooms.size >= MAX_ROOMS) return reply.code(503).send({ error: 'Too many rooms right now' });
      code = newRoomCode();
    } else if (!rooms.has(code) && rooms.size >= MAX_ROOMS) return reply.code(503).send({ error: 'Too many rooms right now' });
    const room = getOrCreateRoom(code);
    room.createdAt = Date.now();
    const p = newPairToken(room.code);
    const origin = publicOrigin(req);
    return { room: room.code, token: p.token, url: pairUrl(origin, p.token), expiresInMs: PAIR_TOKEN_TTL_MS };
  });

  /** The phone (no cookie): the token from the QR code buys the login cookie and the room */
  app.post<{ Body: { token?: string; name?: string } | null }>('/api/mirror/pair/claim', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply): Promise<MirrorPairClaim | undefined> => {
    sweepPairTokens();
    const token = String(req.body?.token || '');
    const p = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? pairTokens.get(token) : undefined;
    if (!p || p.claimedAt) {
      log('warn', { ip: req.ip }, 'mirror: pairing claim with an unknown or used code');
      return reply.code(404).send({ error: 'This pairing code is not valid any more: scan the code on the Tesla again' });
    }
    p.claimedAt = Date.now();
    const name = String(req.body?.name || '').slice(0, 60) || undefined;
    const signedIn = issueAuthCookie(req, reply);
    const room = getOrCreateRoom(p.room);
    room.createdAt = Date.now();
    notifyPaired(room, name);
    log('info', { room: room.code, name, watchers: room.watchers.size }, 'mirror: phone paired');
    return { room: room.code, server: publicOrigin(req), signedIn };
  });

  /** The phone's extension says it started / stopped / failed (public: it may have no sign-in to show); logged, and told to the room's watchers */
  app.post<{ Body: MirrorBeacon | null }>(BEACON_PATH, { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const b = req.body || ({} as MirrorBeacon);
    const event = (['started', 'relay-error', 'error', 'stopped'] as const).find((e) => e === b.event) || 'started';
    const code = normalizeRoomCode(String(b.room || ''));
    const name = String(b.name || '').slice(0, 60) || 'The phone';
    const detail = String(b.detail || '').slice(0, 300);
    log(event === 'started' || event === 'stopped' ? 'info' : 'warn', { room: code || undefined, name, event, detail, ip: req.ip }, 'mirror: phone beacon');
    const room = isRoomCode(code) ? rooms.get(code) : undefined;
    if (room) {
      const message =
        event === 'started'
          ? `${name} started mirroring${detail ? ` (${detail})` : ''}; the picture should follow.`
          : event === 'stopped'
            ? `${name} stopped mirroring.`
            : `${name} reports: ${detail || event}.`;
      for (const w of room.watchers.values()) sendControl(w.ws, { t: 'note', message, kind: event === 'started' || event === 'stopped' ? 'info' : 'error' });
    }
    return { ok: true, room: room ? room.code : undefined, watchers: room?.watchers.size ?? 0 };
  });

  /** The landing page the Camera app opens (public; the token stays in the fragment) */
  app.get(PAIR_PATH, async (req, reply) => {
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(pairLandingPage(publicOrigin(req)));
  });
}

/** For tests: the ids and counts of a room. */
export function roomSnapshot(code: string): { live: boolean; watchers: number; cached: number; config?: MirrorConfig } | undefined {
  const room = rooms.get(code);
  if (!room) return undefined;
  return { live: Boolean(room.sender), watchers: watcherCount(room), cached: room.gop.length, config: room.config };
}
