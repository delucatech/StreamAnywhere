/**
 * The desktop sender (mirror-send.html): mirrors this computer's screen, a camera, or a test pattern
 * to a Mirror room, speaking the same protocol as the iPhone app (shared/mirror.ts) - so it is both
 * a feature (a laptop's screen on the Tesla) and the test bench for the viewer and the relay.
 *
 * Pipeline: the source is drawn onto a canvas at the chosen size and rate, each picture goes to a
 * WebCodecs VideoEncoder (H.264, AVCC); sound goes to an AudioEncoder (AAC-LC). The encoded frames
 * are pushed to the relay (WebSocket) and to every watcher that opened a direct WebRTC data channel.
 */
import { aacAudioSpecificConfig, avcCodecString, bytesToBase64, CHUNK_BYTES, chunkify, encodeConfig, encodeFrame, MIRROR_PROTOCOL, type IceServer, type MirrorConfig, type MirrorControl, type SignalData } from '../../../shared/mirror';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const el = {
  room: $('room'),
  link: $<HTMLAnchorElement>('link'),
  source: $<HTMLSelectElement>('source'),
  audio: $<HTMLInputElement>('audio'),
  size: $<HTMLSelectElement>('size'),
  fps: $<HTMLSelectElement>('fps'),
  bitrate: $<HTMLSelectElement>('bitrate'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  status: $('status'),
  watchers: $('watchers'),
  preview: $<HTMLCanvasElement>('preview'),
  log: $('log'),
};

const params = new URLSearchParams(location.search);
const apiBase = params.get('api') || location.origin;

function log(line: string): void {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()} ${line}`;
  el.log.prepend(d);
  while (el.log.childElementCount > 60) el.log.lastElementChild?.remove();
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(new URL(path, apiBase).toString(), { credentials: 'include', ...init });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
};

// ------------------------------------------------------------ links to the watchers

interface DirectWatcher {
  id: string;
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  skipping: boolean;
  pending: RTCIceCandidateInit[];
}

/** A watcher's channel holding more than this skips frames until the next keyframe */
const DC_HIGH_WATER = 2 * 1024 * 1024;
/** The protocol's buffers are plain ArrayBuffer-backed; the socket APIs want that spelled out */
const asBuf = (b: Uint8Array): Uint8Array<ArrayBuffer> => b as Uint8Array<ArrayBuffer>;

class SenderLinks {
  private ws?: WebSocket;
  private direct = new Map<string, DirectWatcher>();
  private chunkId = 1;
  private relayWanted = true;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private closed = false;
  private iceServers: IceServer[] = [];
  watchers = 0;
  bytesRelay = 0;
  bytesDirect = 0;
  lastConfig?: Uint8Array;
  onNeedKey: () => void = () => undefined;
  onStatus: (s: string) => void = () => undefined;

  constructor(
    private readonly room: string,
    private readonly name: string,
  ) {}

  async start(): Promise<void> {
    try {
      this.iceServers = (await api<{ iceServers: IceServer[] }>('/api/mirror/ice')).iceServers || [];
    } catch {
      /* no STUN: same-network direct links still work */
    }
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const u = new URL('/api/mirror/ws', apiBase);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('room', this.room);
    u.searchParams.set('role', 'sender');
    u.searchParams.set('name', this.name);
    const ws = new WebSocket(u.toString());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus('relay connected');
      log('relay: connected');
      if (this.lastConfig) ws.send(asBuf(this.lastConfig));
      this.pingTimer = window.setInterval(() => this.control({ t: 'ping' }), 15_000);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) return;
      let msg: MirrorControl | undefined;
      try {
        msg = JSON.parse(String(e.data)) as MirrorControl;
      } catch {
        return;
      }
      void this.onControl(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = undefined;
      if (this.closed) return;
      this.onStatus('relay reconnecting');
      log('relay: closed, reconnecting');
      this.reconnectTimer = window.setTimeout(() => this.connect(), 2000);
    };
  }

  private control(m: MirrorControl): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async onControl(msg: MirrorControl): Promise<void> {
    switch (msg.t) {
      case 'ready':
        this.watchers = msg.watchers;
        this.onStatus(`relay ready, ${msg.watchers} watching`);
        break;
      case 'need-key':
        this.onNeedKey();
        break;
      case 'watcher':
        this.watchers = msg.watchers;
        log(`watcher ${msg.id} ${msg.event === 'join' ? 'joined' : 'left'} (${msg.watchers} watching)`);
        if (msg.event === 'leave') this.dropDirect(msg.id);
        this.onStatus(`${msg.watchers} watching`);
        break;
      case 'relay-demand':
        this.relayWanted = msg.on;
        log(`relay ${msg.on ? 'wants frames' : 'needs no frames (every watcher is on a direct link)'}`);
        break;
      case 'signal':
        if (msg.from) await this.onSignal(msg.from, msg.data);
        break;
      default:
        break;
    }
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    let d = this.direct.get(from);
    if ('sdp' in data && data.sdp.type === 'offer') {
      if (d) this.dropDirect(from);
      const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
      d = { id: from, pc, skipping: true, pending: [] };
      this.direct.set(from, d);
      const dw = d;
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.binaryType = 'arraybuffer';
        dw.dc = dc;
        dc.onopen = () => {
          log(`direct link to ${from} open`);
          dc.send(JSON.stringify({ t: 'hello', name: this.name, protocol: MIRROR_PROTOCOL } satisfies MirrorControl));
          if (this.lastConfig) dc.send(asBuf(this.lastConfig));
          dw.skipping = true;
          this.onNeedKey();
        };
        dc.onclose = () => log(`direct link to ${from} closed`);
      };
      pc.onicecandidate = (e) => this.control({ t: 'signal', to: from, data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.dropDirect(from);
      };
      try {
        await pc.setRemoteDescription(data.sdp);
        for (const c of dw.pending) await pc.addIceCandidate(c).catch(() => undefined);
        dw.pending = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.control({ t: 'signal', to: from, data: { sdp: { type: 'answer', sdp: answer.sdp || '' } } });
      } catch (e) {
        log(`direct link to ${from} failed: ${(e as Error).message}`);
        this.dropDirect(from);
      }
      return;
    }
    if (!d) return;
    if ('candidate' in data && data.candidate) {
      if (d.pc.remoteDescription) await d.pc.addIceCandidate(data.candidate).catch(() => undefined);
      else d.pending.push(data.candidate);
    }
  }

  private dropDirect(id: string): void {
    const d = this.direct.get(id);
    if (!d) return;
    this.direct.delete(id);
    d.dc?.close();
    d.pc.close();
  }

  /** The decoder configuration: kept, sent to the relay and to every direct link (new ones get it on open). */
  config(bytes: Uint8Array): void {
    this.lastConfig = bytes;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(asBuf(bytes));
    for (const d of this.direct.values()) if (d.dc?.readyState === 'open') d.dc.send(asBuf(bytes));
  }

  frame(bytes: Uint8Array, isVideo: boolean, key: boolean): void {
    if (this.relayWanted && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(asBuf(bytes));
      this.bytesRelay += bytes.byteLength;
    }
    for (const d of this.direct.values()) {
      const dc = d.dc;
      if (!dc || dc.readyState !== 'open') continue;
      if (d.skipping) {
        if (isVideo && key && dc.bufferedAmount < DC_HIGH_WATER / 4) d.skipping = false;
        else continue;
      } else if (dc.bufferedAmount > DC_HIGH_WATER) {
        d.skipping = true;
        continue;
      }
      const id = this.chunkId++;
      for (const piece of chunkify(bytes, id, CHUNK_BYTES)) dc.send(asBuf(piece));
      this.bytesDirect += bytes.byteLength;
    }
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    for (const id of [...this.direct.keys()]) this.dropDirect(id);
    this.ws?.close();
    this.ws = undefined;
  }
}

// ------------------------------------------------------------ capture + encode

interface Session {
  stream?: MediaStream;
  video?: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  encoder?: VideoEncoder;
  audioEncoder?: AudioEncoder;
  audioReader?: ReadableStreamDefaultReader<AudioData>;
  timer: number;
  startedAt: number;
  frames: number;
  forceKey: boolean;
  lastKeyAt: number;
  links: SenderLinks;
  videoConfig?: MirrorConfig['video'];
  audioConfig?: MirrorConfig['audio'];
  configSent: boolean;
  held: Uint8Array[];
  audioCtx?: AudioContext;
  patternT: number;
}

let session: Session | undefined;
let room = '';

const KEYFRAME_EVERY_MS = 2000;

function pickSize(): number {
  return Number(el.size.value) || 1280;
}

function drawPattern(s: Session): void {
  const { canvas, ctx } = s;
  const t = (performance.now() - s.startedAt) / 1000;
  const w = canvas.width;
  const h = canvas.height;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(t * 20) % 360} 60% 20%)`);
  g.addColorStop(1, `hsl(${(t * 20 + 120) % 360} 60% 35%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const r = Math.min(w, h) * 0.18;
  const cx = w / 2 + Math.cos(t * 1.3) * (w / 2 - r - 20);
  const cy = h / 2 + Math.sin(t * 0.9) * (h / 2 - r - 20);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.font = `bold ${Math.round(h * 0.08)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(`Mirror test ${t.toFixed(1)} s`, w / 2, h * 0.15);
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.round(h * 0.05)}px system-ui, sans-serif`;
  ctx.fillText(`${w}×${h} · frame ${s.frames}`, w / 2, h * 0.92);
}

function configIfReady(s: Session, wantAudio: boolean): void {
  if (s.configSent || !s.videoConfig) return;
  if (wantAudio && !s.audioConfig) return;
  const config: MirrorConfig = { v: 1, video: s.videoConfig, audio: s.audioConfig, name: 'This computer' };
  s.links.config(encodeConfig(config));
  s.configSent = true;
  for (const h of s.held) s.links.frame(h, h[0] === 0x02, (h[1] & 1) !== 0);
  s.held = [];
  log(`config sent: ${config.video?.codec} ${config.video?.width}×${config.video?.height}${config.audio ? ` + ${config.audio.codec} ${config.audio.sampleRate} Hz` : ''}`);
}

function emit(s: Session, bytes: Uint8Array, isVideo: boolean, key: boolean, wantAudio: boolean): void {
  configIfReady(s, wantAudio);
  if (!s.configSent) {
    // the first frames wait for the decoder configuration (the audio one can lag a little)
    if (s.held.length < 200) s.held.push(bytes);
    return;
  }
  s.links.frame(bytes, isVideo, key);
}

async function start(): Promise<void> {
  if (session) return;
  if (typeof VideoEncoder === 'undefined') {
    el.status.textContent = 'This browser has no WebCodecs VideoEncoder.';
    return;
  }
  const wantAudio = el.audio.checked;
  const long = pickSize();
  const fps = Number(el.fps.value) || 30;
  const bitrate = Number(el.bitrate.value) || 4_000_000;
  const canvas = el.preview;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const links = new SenderLinks(room, 'This computer');
  const s: Session = { canvas, ctx, timer: 0, startedAt: performance.now(), frames: 0, forceKey: true, lastKeyAt: 0, links, configSent: false, held: [], patternT: 0 };
  session = s;
  links.onNeedKey = () => {
    s.forceKey = true;
  };
  links.onStatus = (t) => {
    el.watchers.textContent = `${links.watchers} watching · ${t}`;
  };

  let audioTrack: MediaStreamTrack | undefined;
  const source = el.source.value;
  try {
    if (source === 'screen') {
      s.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: wantAudio });
    } else if (source === 'camera') {
      s.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: long }, frameRate: fps }, audio: wantAudio });
    } else {
      // test pattern: drawn below; a soft tone for the sound
      if (wantAudio) {
        const ac = new AudioContext({ sampleRate: 48000 });
        const osc = ac.createOscillator();
        osc.frequency.value = 220;
        const gain = ac.createGain();
        gain.gain.value = 0.05;
        const dest = ac.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        osc.start();
        s.audioCtx = ac;
        s.stream = dest.stream;
      }
    }
  } catch (e) {
    el.status.textContent = `Capture failed: ${(e as Error).message}`;
    session = undefined;
    return;
  }
  const videoTrack = s.stream?.getVideoTracks()[0];
  audioTrack = s.stream?.getAudioTracks()[0];
  if (videoTrack) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream([videoTrack]);
    await v.play();
    s.video = v;
    videoTrack.addEventListener('ended', stop);
  }
  // output size: the source's shape, longest side capped
  const srcW = s.video?.videoWidth || 16;
  const srcH = s.video?.videoHeight || 9;
  const scale = Math.min(1, long / Math.max(srcW, srcH));
  const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  const outW = s.video ? w : long;
  const outH = s.video ? h : Math.round(((long * 9) / 16 / 2)) * 2;
  canvas.width = outW;
  canvas.height = outH;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !s.videoConfig) {
        const desc = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
        // the codec string from the SPS inside the avcC (the encoder's own string is fine too)
        const spsLen = (desc[6] << 8) | desc[7];
        const sps = desc.subarray(8, 8 + spsLen);
        s.videoConfig = { codec: avcCodecString(sps), width: outW, height: outH, description: bytesToBase64(desc), rotation: 0, fps };
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      emit(s, encodeFrame('video', chunk.type === 'key', chunk.timestamp, data), true, chunk.type === 'key', Boolean(audioTrack));
    },
    error: (e) => {
      log(`encoder error: ${e.message}`);
      stop();
    },
  });
  encoder.configure({ codec: 'avc1.640028', width: outW, height: outH, bitrate, framerate: fps, latencyMode: 'realtime', avc: { format: 'avc' }, hardwareAcceleration: 'no-preference' });
  s.encoder = encoder;

  if (audioTrack && typeof AudioEncoder !== 'undefined' && typeof MediaStreamTrackProcessor !== 'undefined') {
    const settings = audioTrack.getSettings();
    const sampleRate = settings.sampleRate || 48000;
    const channels = settings.channelCount || 2;
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (!s.audioConfig) {
          const desc = meta?.decoderConfig?.description ? new Uint8Array(meta.decoderConfig.description as ArrayBuffer) : aacAudioSpecificConfig(sampleRate, channels);
          s.audioConfig = { codec: 'mp4a.40.2', sampleRate: meta?.decoderConfig?.sampleRate || sampleRate, channels: meta?.decoderConfig?.numberOfChannels || channels, description: bytesToBase64(desc) };
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        emit(s, encodeFrame('audio', true, chunk.timestamp, data), false, true, true);
      },
      error: (e) => log(`audio encoder error: ${e.message}`),
    });
    try {
      audioEncoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128_000 });
      s.audioEncoder = audioEncoder;
      const processor = new MediaStreamTrackProcessor<AudioData>({ track: audioTrack });
      const reader = processor.readable.getReader();
      s.audioReader = reader;
      void (async () => {
        const base = s.startedAt;
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          if (audioEncoder.state === 'configured') {
            // the audio clock: the same origin as the video timestamps (performance.now() at start)
            const ts = Math.round((performance.now() - base) * 1000);
            const frame = new AudioData({ format: value.format!, sampleRate: value.sampleRate, numberOfFrames: value.numberOfFrames, numberOfChannels: value.numberOfChannels, timestamp: ts, data: copyAudio(value) });
            audioEncoder.encode(frame);
            frame.close();
          }
          value.close();
        }
      })();
    } catch (e) {
      log(`no AAC encoder here (${(e as Error).message}); sending video only`);
      audioTrack.stop();
      audioTrack = undefined;
    }
  } else if (audioTrack) {
    log('no AudioEncoder / MediaStreamTrackProcessor here; sending video only');
    audioTrack.stop();
    audioTrack = undefined;
  }

  await links.start();
  el.start.disabled = true;
  el.stop.disabled = false;
  el.status.textContent = `Mirroring ${source} at ${outW}×${outH}, ${fps} fps, ${(bitrate / 1e6).toFixed(1)} Mb/s${audioTrack ? ' with sound' : ''}`;

  const interval = 1000 / fps;
  s.timer = window.setInterval(() => {
    if (session !== s || !s.encoder || s.encoder.state !== 'configured') return;
    if (s.video) ctx.drawImage(s.video, 0, 0, outW, outH);
    else drawPattern(s);
    if (s.encoder.encodeQueueSize > 4) return; // the encoder is behind: skip this picture
    const now = performance.now();
    const key = s.forceKey || now - s.lastKeyAt >= KEYFRAME_EVERY_MS;
    if (key) {
      s.forceKey = false;
      s.lastKeyAt = now;
    }
    const frame = new VideoFrame(canvas, { timestamp: Math.round((now - s.startedAt) * 1000) });
    s.encoder.encode(frame, { keyFrame: key });
    frame.close();
    s.frames++;
  }, interval);
  statsTimer = window.setInterval(() => {
    el.watchers.textContent = `${links.watchers} watching · relay ${(links.bytesRelay / 1e6).toFixed(1)} MB · direct ${(links.bytesDirect / 1e6).toFixed(1)} MB · ${s.frames} frames`;
  }, 1000);
}

function copyAudio(d: AudioData): ArrayBuffer {
  const total = d.allocationSize({ planeIndex: 0 }) * (d.format?.endsWith('-planar') ? d.numberOfChannels : 1);
  const buf = new ArrayBuffer(total);
  if (d.format?.endsWith('-planar')) {
    const per = d.allocationSize({ planeIndex: 0 });
    for (let ch = 0; ch < d.numberOfChannels; ch++) d.copyTo(new Uint8Array(buf, ch * per, per), { planeIndex: ch });
  } else {
    d.copyTo(buf, { planeIndex: 0 });
  }
  return buf;
}

let statsTimer = 0;

function stop(): void {
  const s = session;
  if (!s) return;
  session = undefined;
  clearInterval(s.timer);
  clearInterval(statsTimer);
  s.links.stop();
  void s.audioReader?.cancel().catch(() => undefined);
  s.encoder?.close();
  s.audioEncoder?.close();
  s.stream?.getTracks().forEach((t) => t.stop());
  void s.audioCtx?.close();
  if (s.video) {
    s.video.pause();
    s.video.srcObject = null;
  }
  el.start.disabled = false;
  el.stop.disabled = true;
  el.status.textContent = 'Stopped.';
  el.watchers.textContent = '';
}

el.start.addEventListener('click', () => void start());
el.stop.addEventListener('click', stop);
window.addEventListener('pagehide', stop);

// ------------------------------------------------------------ the room

(async () => {
  try {
    const fromUrl = (params.get('room') || '').toUpperCase();
    const info = fromUrl ? { room: fromUrl } : await api<{ room: string }>('/api/mirror/rooms', { method: 'POST' });
    room = info.room;
    el.room.textContent = room;
    const link = new URL('/mirror.html', apiBase);
    link.searchParams.set('room', room);
    el.link.href = link.toString();
    el.link.textContent = link.toString();
    el.start.disabled = false;
    el.status.textContent = 'Ready. Choose a source and press Start; open the link on the Tesla (or type the code on mirror.html).';
  } catch (e) {
    el.status.textContent = `Could not get a room from the server: ${(e as Error).message}`;
  }
})();
