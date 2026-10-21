/**
 * Mirror wire protocol ("mirror/1"), shared by the server relay, the viewer page, the desktop
 * sender page and (as a Swift port, mirror/ios/Shared/MirrorProtocol.swift) the iPhone app.
 *
 * A stream is one sender (the phone, or the desktop sender page) and any number of watchers (the
 * Tesla's browser, a laptop). The same frames travel over whichever channel is in use:
 *   local   the phone's own HTTP + WebSocket server on the hotspot (page http://172.20.10.1:8420/, frames ws://172.20.10.1:8421/)
 *   direct  a WebRTC data channel between phone and watcher (STUN, no relay)
 *   relay   the StreamAnywhere server: the sender pushes to /api/mirror/ws?role=sender, every
 *           watcher reads from /api/mirror/ws?role=watcher, the server copies the bytes across.
 *
 * Binary messages (little-endian):
 *   [0x01] CONFIG  UTF-8 JSON MirrorConfig: the decoder configurations (H.264 avcC, AAC
 *                  AudioSpecificConfig), picture size, rotation. Sent before the first frame and again
 *                  whenever something in it changes (a resolution change comes with a keyframe).
 *   [0x02] VIDEO   flags u8 (bit 0 = keyframe) + timestamp f64 (microseconds) + H.264 access unit in
 *                  AVCC form (4-byte length prefixed NAL units, matching the avcC in the config)
 *   [0x03] AUDIO   flags u8 + timestamp f64 (microseconds) + one raw AAC-LC frame (no ADTS header)
 *   [0x10] CHUNK   id u32 + index u16 + count u16 + a slice of a larger message (WebRTC data channels
 *                  cap a message at 256 KB; keyframes can be bigger). Reassembled in order.
 * Text messages are JSON control messages (MirrorControl below).
 *
 * A declared track must keep flowing: a watcher that plays through Media Source Extensions (the
 * phone's local page is plain http, where WebCodecs is unavailable) waits for both tracks, so a
 * sender that declares audio sends silence when the app is quiet.
 */

export const MIRROR_PROTOCOL = 'mirror/1';
/** The phone's own web server on the hotspot: the page on one port, the WebSocket on the next (Network.framework speaks one protocol per listener) */
export const MIRROR_LOCAL_PORT = 8420;
export const MIRROR_LOCAL_WS_PORT = 8421;
/** The iPhone's own address on its Personal Hotspot (every iPhone uses this one). */
export const IPHONE_HOTSPOT_ADDRESS = '172.20.10.1';

export const MSG = {
  CONFIG: 0x01,
  VIDEO: 0x02,
  AUDIO: 0x03,
  CHUNK: 0x10,
} as const;
export const FLAG_KEY = 0x01;

/** WebRTC data channels carry at most this per message; larger ones are CHUNKed. */
export const CHUNK_BYTES = 60 * 1024;
export const FRAME_HEADER_BYTES = 1 + 1 + 8;

export interface MirrorVideoConfig {
  /** e.g. avc1.64001f */
  codec: string;
  width: number;
  height: number;
  /** base64 AVCDecoderConfigurationRecord (the avcC payload) */
  description: string;
  /** Degrees clockwise the picture must be turned to be upright (0, 90, 180, 270) */
  rotation: number;
  /** Nominal frame rate (the sender's cap) */
  fps: number;
}

export interface MirrorAudioConfig {
  /** mp4a.40.2 */
  codec: string;
  sampleRate: number;
  channels: number;
  /** base64 AudioSpecificConfig (2 bytes for AAC-LC) */
  description: string;
}

export interface MirrorConfig {
  v: 1;
  video?: MirrorVideoConfig;
  audio?: MirrorAudioConfig;
  /** What the sender calls itself (the phone's name) */
  name?: string;
}

/** JSON control messages (WebSocket text frames, or data-channel strings). */
export type MirrorControl =
  /** server -> sender/watcher after the upgrade */
  | { t: 'ready'; room: string; live: boolean; name?: string; watchers: number; id?: string }
  /** server -> sender: a watcher needs a keyframe to start (or to recover) */
  | { t: 'need-key' }
  /** server -> sender: a watcher arrived or left (with its id, for direct-link signalling) */
  | { t: 'watcher'; id: string; event: 'join' | 'leave'; watchers: number }
  /** server -> sender: whether any watcher still needs the frames through the relay (false = all are on direct links) */
  | { t: 'relay-demand'; on: boolean }
  /** server -> watcher: the sender arrived / left */
  | { t: 'sender'; event: 'join' | 'leave'; name?: string }
  /** server -> watcher: how many are watching */
  | { t: 'watchers'; n: number }
  /** watcher -> server: stop (or resume) copying frames to me - I am receiving them over the direct link */
  | { t: 'relay'; on: boolean }
  /** watcher -> server -> sender ("from" filled in by the server) and sender -> server -> watcher ("to") */
  | { t: 'signal'; to?: string; from?: string; data: SignalData }
  /** either side -> server: something went wrong / a note for the log */
  | { t: 'error'; message: string }
  /** sender -> watcher (direct channel): I am the sender, here is my name */
  | { t: 'hello'; name?: string; protocol: string }
  /** keepalive */
  | { t: 'ping' }
  | { t: 'pong' };

export type SignalData =
  | { sdp: { type: 'offer' | 'answer'; sdp: string } }
  | { candidate: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null };

export interface MirrorRoomInfo {
  room: string;
  live: boolean;
  name?: string;
  watchers: number;
  config?: MirrorConfig;
  startedAt?: number;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

export function encodeConfig(config: MirrorConfig): Uint8Array {
  const json = utf8.enc.encode(JSON.stringify(config));
  const out = new Uint8Array(1 + json.byteLength);
  out[0] = MSG.CONFIG;
  out.set(json, 1);
  return out;
}

export function encodeFrame(kind: 'video' | 'audio', key: boolean, timestampUs: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + data.byteLength);
  const dv = new DataView(out.buffer);
  out[0] = kind === 'video' ? MSG.VIDEO : MSG.AUDIO;
  out[1] = key ? FLAG_KEY : 0;
  dv.setFloat64(2, timestampUs, true);
  out.set(data, FRAME_HEADER_BYTES);
  return out;
}

export interface DecodedFrame {
  kind: 'video' | 'audio';
  key: boolean;
  timestampUs: number;
  data: Uint8Array;
}

export type DecodedMessage =
  | { type: 'config'; config: MirrorConfig }
  | ({ type: 'frame' } & DecodedFrame)
  | { type: 'chunk'; id: number; index: number; count: number; data: Uint8Array }
  | { type: 'unknown'; kind: number };

export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (bytes[0]) {
    case MSG.CONFIG:
      return { type: 'config', config: JSON.parse(utf8.dec.decode(bytes.subarray(1))) as MirrorConfig };
    case MSG.VIDEO:
    case MSG.AUDIO:
      return {
        type: 'frame',
        kind: bytes[0] === MSG.VIDEO ? 'video' : 'audio',
        key: (bytes[1] & FLAG_KEY) !== 0,
        timestampUs: dv.getFloat64(2, true),
        data: bytes.subarray(FRAME_HEADER_BYTES),
      };
    case MSG.CHUNK:
      return { type: 'chunk', id: dv.getUint32(1, true), index: dv.getUint16(5, true), count: dv.getUint16(7, true), data: bytes.subarray(9) };
    default:
      return { type: 'unknown', kind: bytes[0] };
  }
}

/** Is this a video message that starts a group of pictures? (cheap check for the relay) */
export const isKeyVideo = (bytes: Uint8Array): boolean => bytes[0] === MSG.VIDEO && (bytes[1] & FLAG_KEY) !== 0;

/** Splits a message into CHUNK messages when it is larger than the channel allows. */
export function chunkify(message: Uint8Array, id: number, max = CHUNK_BYTES): Uint8Array[] {
  if (message.byteLength <= max) return [message];
  const count = Math.ceil(message.byteLength / max);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const slice = message.subarray(i * max, Math.min(message.byteLength, (i + 1) * max));
    const c = new Uint8Array(9 + slice.byteLength);
    const dv = new DataView(c.buffer);
    c[0] = MSG.CHUNK;
    dv.setUint32(1, id, true);
    dv.setUint16(5, i, true);
    dv.setUint16(7, count, true);
    c.set(slice, 9);
    out.push(c);
  }
  return out;
}

/** Reassembles CHUNK messages; returns the whole message when the last piece arrives. */
export class ChunkAssembler {
  private parts = new Map<number, { pieces: (Uint8Array | undefined)[]; got: number; at: number }>();
  push(chunk: { id: number; index: number; count: number; data: Uint8Array }): Uint8Array | undefined {
    let p = this.parts.get(chunk.id);
    if (!p) {
      if (this.parts.size > 8) {
        // lose the oldest half-built message rather than grow without bound
        const oldest = [...this.parts.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.parts.delete(oldest[0]);
      }
      p = { pieces: new Array(chunk.count), got: 0, at: Date.now() };
      this.parts.set(chunk.id, p);
    }
    if (chunk.index >= p.pieces.length || p.pieces[chunk.index]) return undefined;
    p.pieces[chunk.index] = chunk.data;
    p.got++;
    if (p.got < p.pieces.length) return undefined;
    this.parts.delete(chunk.id);
    let total = 0;
    for (const piece of p.pieces) total += piece!.byteLength;
    const out = new Uint8Array(total);
    let o = 0;
    for (const piece of p.pieces) {
      out.set(piece!, o);
      o += piece!.byteLength;
    }
    return out;
  }
}

/** avc1.PPCCLL from the first bytes of an SPS NAL unit (profile_idc, constraint flags, level_idc). */
export function avcCodecString(sps: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** Builds an AVCDecoderConfigurationRecord from SPS/PPS NAL units (without start codes). */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.byteLength + pps.byteLength);
  out[0] = 1; // configurationVersion
  out[1] = sps[1];
  out[2] = sps[2];
  out[3] = sps[3];
  out[4] = 0xff; // lengthSizeMinusOne = 3 (4-byte lengths)
  out[5] = 0xe1; // 1 SPS
  out[6] = sps.byteLength >> 8;
  out[7] = sps.byteLength & 0xff;
  out.set(sps, 8);
  let o = 8 + sps.byteLength;
  out[o++] = 1; // 1 PPS
  out[o++] = pps.byteLength >> 8;
  out[o++] = pps.byteLength & 0xff;
  out.set(pps, o);
  return out;
}

/** AudioSpecificConfig for AAC-LC */
export function aacAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let idx = rates.indexOf(sampleRate);
  if (idx < 0) idx = 4;
  const objectType = 2; // AAC LC
  return new Uint8Array([(objectType << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Room codes: six characters from an alphabet without 0/O/1/I. */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const normalizeRoomCode = (s: string): string =>
  s
    .toUpperCase()
    .replace(/0/g, 'O')
    .replace(/[^A-Z2-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
export const isRoomCode = (s: string): boolean => s.length === ROOM_CODE_LENGTH && [...s].every((c) => ROOM_ALPHABET.includes(c));
