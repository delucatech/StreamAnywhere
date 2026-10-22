/**
 * The viewer's side of the three ways the picture can arrive (shared/mirror.ts):
 *
 *  - local:  this page was served by the phone itself (on its hotspot); the frames come over a
 *            WebSocket to the same host. Nothing else is tried.
 *  - relay:  a WebSocket to the StreamAnywhere server, which copies the sender's frames. Connected
 *            first, so the picture shows at once; also carries the signalling for the direct link.
 *  - direct: a WebRTC data channel straight to the phone (STUN). Once it delivers frames, the relay is
 *            told to stop copying them (it stays connected for signalling and as the fallback); if the
 *            channel drops, the relay is asked to resume with a keyframe.
 *
 * Frames from both links go to one sink; duplicates (the moments both deliver) are dropped by
 * timestamp.
 */
import { ChunkAssembler, decodeMessage, MIRROR_LOCAL_WS_PORT, MIRROR_PROTOCOL, type IceServer, type MirrorConfig, type MirrorControl, type SignalData } from '../../../shared/mirror';
import type { MediaSink } from './sinks';

export type PathKind = 'local' | 'direct' | 'relay';

export interface WatchStatus {
  state: 'connecting' | 'waiting' | 'live' | 'ended' | 'error';
  /** The link the frames are coming over right now */
  path: PathKind;
  relay: 'off' | 'connecting' | 'open' | 'paused' | 'closed';
  direct: 'off' | 'connecting' | 'open' | 'failed' | 'closed';
  senderName?: string;
  watchers: number;
  message?: string;
  /** The message is a note from the server about the phone (an error: it was refused) rather than this link's own state */
  note?: 'info' | 'error';
  /** Bytes received, by path */
  bytes: Record<PathKind, number>;
  /** Frames received in the last second (any path) */
  fps: number;
  kbps: number;
}

export interface WatchOptions {
  /** Where the server is (same origin by default) */
  apiBase?: string;
  room: string;
  /** This page came from the phone: one WebSocket to the same host, nothing else */
  local: boolean;
  /** Try the WebRTC direct link (default true where RTCPeerConnection exists) */
  direct?: boolean;
  onStatus(s: WatchStatus): void;
  onConfig?(c: MirrorConfig): void;
  /** A phone scanned this page's pairing code (relay only) */
  onPaired?(name?: string): void;
}

const RELAY_RECONNECT_MIN_MS = 1000;
const RELAY_RECONNECT_MAX_MS = 10_000;
const PING_MS = 15_000;
/** The direct link must deliver this many video frames before the relay is paused */
const DIRECT_WARMUP_FRAMES = 10;
const DIRECT_CONNECT_TIMEOUT_MS = 12_000;

export class MirrorWatcher {
  private ws?: WebSocket;
  private wsTimer = 0;
  private reconnectDelay = RELAY_RECONNECT_MIN_MS;
  private pingTimer = 0;
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private assembler = new ChunkAssembler();
  private directFrames = 0;
  private directTimer = 0;
  private lastTs: Record<'video' | 'audio', number> = { video: -1, audio: -1 };
  private status: WatchStatus = { state: 'connecting', path: 'relay', relay: 'off', direct: 'off', watchers: 0, bytes: { local: 0, direct: 0, relay: 0 }, fps: 0, kbps: 0 };
  private tick = { frames: 0, bytes: 0, at: performance.now() };
  private rateTimer = 0;
  private closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private config?: MirrorConfig;
  /** false between the sender leaving and coming back: frames still in flight on the direct link must not bring the picture "live" again */
  private senderPresent = true;

  constructor(
    private readonly sink: MediaSink,
    private readonly opts: WatchOptions,
  ) {
    this.status.path = opts.local ? 'local' : 'relay';
    this.rateTimer = window.setInterval(() => this.updateRates(), 1000);
  }

  start(): void {
    if (this.opts.local) this.connectLocal();
    else this.connectRelay();
  }

  get currentConfig(): MirrorConfig | undefined {
    return this.config;
  }

  private emit(patch: Partial<WatchStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.status);
  }

  private updateRates(): void {
    const now = performance.now();
    const dt = (now - this.tick.at) / 1000;
    if (dt <= 0) return;
    const fps = Math.round(this.tick.frames / dt);
    const kbps = Math.round((this.tick.bytes * 8) / dt / 1000);
    this.tick = { frames: 0, bytes: 0, at: now };
    if (fps !== this.status.fps || kbps !== this.status.kbps) this.emit({ fps, kbps });
  }

  // ------------------------------------------------------------ frames

  private deliver(bytes: Uint8Array, path: PathKind): void {
    if (!this.senderPresent) return;
    const msg = decodeMessage(bytes);
    this.status.bytes[path] += bytes.byteLength;
    if (msg.type === 'chunk') {
      const whole = this.assembler.push(msg);
      if (whole) this.deliver(whole, path);
      return;
    }
    if (msg.type === 'config') {
      this.config = msg.config;
      this.sink.configure(msg.config);
      this.opts.onConfig?.(msg.config);
      if (this.status.state !== 'live') this.emit({ state: 'live', path });
      return;
    }
    if (msg.type !== 'frame') return;
    // the two links overlap for a moment: the same frame must not reach the decoder twice
    if (msg.timestampUs <= this.lastTs[msg.kind]) return;
    this.lastTs[msg.kind] = msg.timestampUs;
    this.tick.bytes += bytes.byteLength;
    if (msg.kind === 'video') {
      this.tick.frames++;
      if (path === 'direct') {
        this.directFrames++;
        if (this.directFrames === DIRECT_WARMUP_FRAMES && msg.key === false) {
          /* keep counting: the relay is paused after a keyframe arrived directly */
        }
        if (this.directFrames >= DIRECT_WARMUP_FRAMES && this.status.relay === 'open') this.pauseRelay();
      }
    }
    if (path !== this.status.path) this.emit({ path });
    if (this.status.state !== 'live') this.emit({ state: 'live' });
    this.sink.push(msg);
  }

  // ------------------------------------------------------------ local (the phone's own page)

  private connectLocal(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${MIRROR_LOCAL_WS_PORT}/`;
    this.emit({ state: 'connecting', relay: 'off', direct: 'off', path: 'local' });
    this.openSocket(url, 'local');
  }

  // ------------------------------------------------------------ relay

  private relayUrl(): string {
    const base = this.opts.apiBase || location.origin;
    const u = new URL('/api/mirror/ws', base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('room', this.opts.room);
    u.searchParams.set('role', 'watcher');
    return u.toString();
  }

  private connectRelay(): void {
    this.emit({ state: this.status.state === 'live' ? 'live' : 'connecting', relay: 'connecting' });
    this.openSocket(this.relayUrl(), 'relay');
  }

  private openSocket(url: string, path: 'local' | 'relay'): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.emit({ state: 'error', message: (e as Error).message });
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = RELAY_RECONNECT_MIN_MS;
      if (path === 'relay') this.emit({ relay: 'open' });
      else this.emit({ state: 'connecting' });
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.sendControl({ t: 'ping' }), PING_MS);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        this.deliver(new Uint8Array(e.data), path);
        return;
      }
      let msg: MirrorControl | undefined;
      try {
        msg = JSON.parse(String(e.data)) as MirrorControl;
      } catch {
        return;
      }
      this.onControl(msg, path);
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = undefined;
      if (this.closed) return;
      if (e.code === 4001 || e.code === 4003) {
        this.emit({ state: 'ended', relay: 'closed', message: e.reason || 'The stream ended' });
        return;
      }
      if (path === 'relay') this.emit({ relay: 'closed', state: this.status.direct === 'open' ? this.status.state : 'connecting', message: 'Reconnecting to the server…' });
      else this.emit({ state: 'connecting', message: 'Reconnecting to the phone…' });
      // a watcher must not keep decoding deltas across a gap
      this.lastTs = { video: -1, audio: -1 };
      this.wsTimer = window.setTimeout(() => (path === 'relay' ? this.connectRelay() : this.connectLocal()), this.reconnectDelay);
      this.reconnectDelay = Math.min(RELAY_RECONNECT_MAX_MS, this.reconnectDelay * 2);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private sendControl(m: MirrorControl): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private onControl(msg: MirrorControl, path: 'local' | 'relay'): void {
    switch (msg.t) {
      case 'ready':
        this.senderPresent = path === 'local' || msg.live;
        this.emit({ senderName: msg.name, watchers: msg.watchers, state: msg.live ? (this.status.state === 'live' ? 'live' : 'connecting') : 'waiting', message: msg.live ? undefined : 'Waiting for the phone to start mirroring…', note: undefined });
        if (msg.live && path === 'relay') this.tryDirect();
        break;
      case 'hello':
        this.emit({ senderName: msg.name, message: msg.protocol !== MIRROR_PROTOCOL ? `Protocol ${msg.protocol}` : undefined });
        break;
      case 'sender':
        if (msg.event === 'join') {
          this.senderPresent = true;
          this.lastTs = { video: -1, audio: -1 };
          this.emit({ senderName: msg.name, state: 'connecting', message: undefined, note: undefined });
          if (path === 'relay') this.tryDirect();
        } else {
          this.senderPresent = false;
          this.closeDirect('sender left');
          this.emit({ state: 'waiting', message: 'The phone stopped mirroring. Waiting for it to come back…' });
        }
        break;
      case 'watchers':
        this.emit({ watchers: msg.n });
        break;
      case 'paired':
        this.emit({ senderName: msg.name || this.status.senderName, message: `${msg.name || 'The phone'} is paired. Tap Start mirroring on it.`, note: undefined });
        this.opts.onPaired?.(msg.name);
        break;
      case 'note':
        this.emit({ message: msg.message, note: msg.kind || 'info' });
        break;
      case 'signal':
        void this.onSignal(msg.data);
        break;
      default:
        break;
    }
  }

  private pauseRelay(): void {
    this.sendControl({ t: 'relay', on: false });
    this.emit({ relay: 'paused' });
  }

  private resumeRelay(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastTs = { video: -1, audio: -1 };
    this.sendControl({ t: 'relay', on: true });
    this.emit({ relay: 'open' });
  }

  // ------------------------------------------------------------ direct (WebRTC data channel)

  private async tryDirect(): Promise<void> {
    if (this.opts.direct === false || typeof RTCPeerConnection === 'undefined' || this.pc || this.closed) return;
    let iceServers: IceServer[] = [];
    try {
      const r = await fetch(new URL('/api/mirror/ice', this.opts.apiBase || location.origin).toString(), { credentials: 'include' });
      if (r.ok) iceServers = ((await r.json()) as { iceServers: IceServer[] }).iceServers || [];
    } catch {
      /* STUN-less: host candidates still work on the same network */
    }
    if (this.pc || this.closed) return;
    this.directFrames = 0;
    this.emit({ direct: 'connecting' });
    const pc = new RTCPeerConnection({ iceServers: iceServers as RTCIceServer[] });
    this.pc = pc;
    const dc = pc.createDataChannel('mirror', { ordered: true });
    dc.binaryType = 'arraybuffer';
    this.dc = dc;
    dc.onopen = () => {
      clearTimeout(this.directTimer);
      this.emit({ direct: 'open' });
    };
    dc.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.deliver(new Uint8Array(e.data), 'direct');
      else {
        try {
          this.onControl(JSON.parse(String(e.data)) as MirrorControl, 'relay');
        } catch {
          /* ignore */
        }
      }
    };
    dc.onclose = () => this.closeDirect('channel closed');
    dc.onerror = () => this.closeDirect('channel error');
    pc.onicecandidate = (e) => {
      this.sendControl({ t: 'signal', data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closeDirect(pc.connectionState);
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendControl({ t: 'signal', data: { sdp: { type: 'offer', sdp: offer.sdp || '' } } });
    } catch (e) {
      this.closeDirect((e as Error).message);
      return;
    }
    this.directTimer = window.setTimeout(() => {
      if (this.dc?.readyState !== 'open') this.closeDirect('no direct link (networks block it)');
    }, DIRECT_CONNECT_TIMEOUT_MS);
  }

  private async onSignal(data: SignalData): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if ('sdp' in data) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of this.pendingCandidates) await pc.addIceCandidate(c).catch(() => undefined);
        this.pendingCandidates = [];
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => undefined);
        else this.pendingCandidates.push(data.candidate);
      }
    } catch (e) {
      this.closeDirect((e as Error).message);
    }
  }

  private closeDirect(why: string): void {
    clearTimeout(this.directTimer);
    const had = this.pc;
    this.dc?.close();
    this.pc?.close();
    this.dc = undefined;
    this.pc = undefined;
    this.pendingCandidates = [];
    if (!had) return;
    const wasCarrying = this.status.path === 'direct';
    this.emit({ direct: why === 'channel closed' || why === 'sender left' ? 'closed' : 'failed', message: wasCarrying ? undefined : this.status.message });
    if (this.status.relay === 'paused' || wasCarrying) {
      this.resumeRelay();
      this.emit({ path: 'relay' });
    }
    this.directFrames = 0;
  }

  /** Try the direct link again (after a failure), e.g. on a button */
  retryDirect(): void {
    this.closeDirect('retry');
    void this.tryDirect();
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.wsTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.rateTimer);
    this.closeDirect('stopped');
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }
}
