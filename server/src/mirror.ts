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
 * Rooms are six-letter codes the phone shows and the Tesla types. POST /api/mirror/rooms reserves one;
 * a sender may also connect with a code of its own. A room lives while its sender is connected and a
 * few minutes beyond, for the phone to reconnect.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { isKeyVideo, isRoomCode, MSG, normalizeRoomCode, ROOM_ALPHABET, ROOM_CODE_LENGTH, type IceServer, type MirrorConfig, type MirrorControl, type MirrorRoomInfo } from '../../shared/mirror';
import { requestAuthorized } from './auth';

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
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.sender) continue;
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
    if (!requestAuthorized(req.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const role = url.searchParams.get('role') === 'sender' ? 'sender' : 'watcher';
    const code = normalizeRoomCode(url.searchParams.get('room') || '');
    if (!isRoomCode(code) || (role === 'watcher' && !rooms.has(code)) || (role === 'sender' && !rooms.has(code) && rooms.size >= MAX_ROOMS)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const name = (url.searchParams.get('name') || '').slice(0, 60) || undefined;
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
}

/** For tests: the ids and counts of a room. */
export function roomSnapshot(code: string): { live: boolean; watchers: number; cached: number; config?: MirrorConfig } | undefined {
  const room = rooms.get(code);
  if (!room) return undefined;
  return { live: Boolean(room.sender), watchers: watcherCount(room), cached: room.gop.length, config: room.config };
}
