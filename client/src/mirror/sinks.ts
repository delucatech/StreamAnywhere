/**
 * Where the mirrored frames go on the viewer:
 *
 *  - WebCodecsSink: VideoDecoder -> Canvas, AudioDecoder -> Web Audio (the feed player's sink). Every
 *    decoded picture is painted the moment it comes out, which is the lowest delay a browser offers.
 *    Needs a secure context (https, or localhost).
 *  - MseSink: the frames are packed into fragmented MP4 (fmp4.ts) and appended to a <video> through
 *    Media Source Extensions: works on plain http (the phone's own page on the hotspot) and in browsers
 *    without WebCodecs. A "latency chaser" keeps the playhead a few frames behind the newest data.
 */
import { base64ToBytes, type DecodedFrame, type MirrorConfig } from '../../../shared/mirror';
import { AudioSink } from '../media/audioOutput';
import { initSegment, mediaSegment, mimeType, VIDEO_TIMESCALE } from './fmp4';

export interface SinkStats {
  decoder: 'webcodecs' | 'mse';
  width: number;
  height: number;
  rotation: number;
  framesIn: number;
  framesOut: number;
  dropped: number;
  /** Seconds of video the playhead is behind the newest frame (MSE); 0 for WebCodecs */
  behindS: number;
  audio: boolean;
  error?: string;
}

export interface MediaSink {
  readonly element: HTMLElement;
  configure(config: MirrorConfig): void;
  push(frame: DecodedFrame): void;
  /** Called from a user gesture: unlock sound */
  unlock(): Promise<void>;
  setMuted(muted: boolean): void;
  stats(): SinkStats;
  destroy(): void;
}

export function webCodecsAvailable(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined' && window.isSecureContext;
}

export function mseAvailable(): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function';
}

/** How much audio to keep scheduled ahead of the clock (network jitter allowance) */
const AUDIO_LEAD_US = 120_000;
const AUDIO_MAX_LEAD_US = 500_000;

export class WebCodecsSink implements MediaSink {
  readonly element: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video?: VideoDecoder;
  private audio?: AudioDecoder;
  private audioOut?: AudioSink;
  private videoKey = '';
  private audioKey = '';
  private needKey = true;
  private st: SinkStats = { decoder: 'webcodecs', width: 0, height: 0, rotation: 0, framesIn: 0, framesOut: 0, dropped: 0, behindS: 0, audio: false };
  private muted = false;
  private audioBaseUs = -1;
  private pendingFrame?: VideoFrame;
  private painting = false;
  private destroyed = false;

  constructor() {
    this.element = document.createElement('canvas');
    this.element.className = 'mirror-canvas';
    const ctx = this.element.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  configure(config: MirrorConfig): void {
    const v = config.video;
    if (v) {
      const key = `${v.codec}|${v.width}x${v.height}|${v.description}`;
      if (key !== this.videoKey) {
        this.videoKey = key;
        this.needKey = true;
        this.video?.close();
        this.video = new VideoDecoder({
          output: (frame) => this.paint(frame),
          error: (e) => {
            this.st.error = e.message;
            this.needKey = true;
          },
        });
        this.video.configure({ codec: v.codec, codedWidth: v.width, codedHeight: v.height, description: base64ToBytes(v.description), optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
      }
      this.st.rotation = v.rotation || 0;
      this.applySize(v.width, v.height, v.rotation || 0);
    }
    const a = config.audio;
    if (a && typeof AudioDecoder !== 'undefined') {
      const key = `${a.codec}|${a.sampleRate}|${a.channels}|${a.description}`;
      if (key !== this.audioKey) {
        this.audioKey = key;
        this.audio?.close();
        this.audioOut?.destroy();
        this.audioOut = new AudioSink(a.sampleRate);
        this.audioOut.setVolume(this.muted ? 0 : 1);
        this.audioBaseUs = -1;
        const out = this.audioOut;
        this.audio = new AudioDecoder({
          output: (data) => out.enqueue(data),
          error: (e) => {
            this.st.error = 'audio: ' + e.message;
          },
        });
        this.audio.configure({ codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, description: base64ToBytes(a.description) });
        this.st.audio = true;
      }
    } else if (!a && this.audio) {
      this.audio.close();
      this.audio = undefined;
      this.audioOut?.destroy();
      this.audioOut = undefined;
      this.audioKey = '';
      this.st.audio = false;
    }
  }

  private applySize(w: number, h: number, rotation: number): void {
    const swap = rotation === 90 || rotation === 270;
    const cw = swap ? h : w;
    const ch = swap ? w : h;
    if (this.element.width !== cw || this.element.height !== ch) {
      this.element.width = cw;
      this.element.height = ch;
    }
    this.st.width = cw;
    this.st.height = ch;
  }

  push(frame: DecodedFrame): void {
    if (this.destroyed) return;
    if (frame.kind === 'video') {
      if (!this.video || this.video.state !== 'configured') return;
      if (this.needKey) {
        if (!frame.key) {
          this.st.dropped++;
          return;
        }
        this.needKey = false;
      }
      this.st.framesIn++;
      // the decoder is behind: let it catch up rather than queue a growing backlog (the next keyframe resyncs)
      if (this.video.decodeQueueSize > 12) {
        this.st.dropped++;
        this.needKey = true;
        return;
      }
      try {
        this.video.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: Math.round(frame.timestampUs), data: frame.data }));
      } catch (e) {
        this.st.error = (e as Error).message;
        this.needKey = true;
      }
      return;
    }
    if (!this.audio || this.audio.state !== 'configured' || !this.audioOut) return;
    const out = this.audioOut;
    if (this.audioBaseUs < 0 || !out.running) {
      this.audioBaseUs = frame.timestampUs;
      void out.start(frame.timestampUs - AUDIO_LEAD_US);
    } else {
      // too far ahead of the clock (the link paused and then flushed): re-base so the delay does not stay
      const lead = out.scheduledUntilUs - out.currentMediaUs();
      if (lead > AUDIO_MAX_LEAD_US) {
        out.stopAll();
        void out.start(frame.timestampUs - AUDIO_LEAD_US);
      } else if (lead < -AUDIO_MAX_LEAD_US) {
        out.stopAll();
        void out.start(frame.timestampUs - AUDIO_LEAD_US);
      }
    }
    try {
      this.audio.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(frame.timestampUs), data: frame.data }));
    } catch (e) {
      this.st.error = 'audio: ' + (e as Error).message;
    }
  }

  private paint(frame: VideoFrame): void {
    // only the newest decoded picture is painted when several come out of the decoder at once
    this.pendingFrame?.close();
    this.pendingFrame = frame;
    if (this.painting) return;
    this.painting = true;
    const draw = (): void => {
      this.painting = false;
      const f = this.pendingFrame;
      this.pendingFrame = undefined;
      if (!f || this.destroyed) {
        f?.close();
        return;
      }
      const rot = this.st.rotation;
      const { width: cw, height: ch } = this.element;
      const ctx = this.ctx;
      ctx.save();
      if (rot) {
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate((rot * Math.PI) / 180);
        const swap = rot === 90 || rot === 270;
        ctx.drawImage(f, -(swap ? ch : cw) / 2, -(swap ? cw : ch) / 2, swap ? ch : cw, swap ? cw : ch);
      } else {
        ctx.drawImage(f, 0, 0, cw, ch);
      }
      ctx.restore();
      f.close();
      this.st.framesOut++;
    };
    // paint on the next animation frame when the page is visible; right away when it is not (a hidden
    // pane never gets animation frames)
    if (document.visibilityState === 'visible') requestAnimationFrame(draw);
    else draw();
  }

  async unlock(): Promise<void> {
    if (this.audioOut) await this.audioOut.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.audioOut?.setVolume(muted ? 0 : 1);
  }

  stats(): SinkStats {
    return { ...this.st };
  }

  destroy(): void {
    this.destroyed = true;
    this.pendingFrame?.close();
    this.pendingFrame = undefined;
    this.video?.close();
    this.audio?.close();
    this.audioOut?.destroy();
    this.video = undefined;
    this.audio = undefined;
    this.audioOut = undefined;
  }
}

/** The playhead is kept this far behind the newest frame */
const MSE_TARGET_BEHIND_S = 0.12;
const MSE_MAX_BEHIND_S = 0.6;
/** Data older than this is removed from the SourceBuffer */
const MSE_KEEP_S = 20;

export class MseSink implements MediaSink {
  readonly element: HTMLVideoElement;
  private ms?: MediaSource;
  private sb?: SourceBuffer;
  private queue: Uint8Array[] = [];
  private config?: MirrorConfig;
  private trackKey = '';
  private needKey = true;
  private seq = 1;
  private baseUs = -1;
  private lastVideoUs = -1;
  private nominalVideoDuration = 3000;
  private st: SinkStats = { decoder: 'mse', width: 0, height: 0, rotation: 0, framesIn: 0, framesOut: 0, dropped: 0, behindS: 0, audio: false };
  private chaser = 0;
  private destroyed = false;
  private opened: Promise<void>;

  constructor() {
    this.element = document.createElement('video');
    this.element.className = 'mirror-video';
    this.element.playsInline = true;
    this.element.autoplay = true;
    this.element.muted = false;
    this.element.setAttribute('playsinline', '');
    this.ms = new MediaSource();
    this.opened = new Promise<void>((resolve) => this.ms!.addEventListener('sourceopen', () => resolve(), { once: true }));
    this.element.src = URL.createObjectURL(this.ms);
    this.chaser = window.setInterval(() => this.chase(), 500);
  }

  configure(config: MirrorConfig): void {
    this.config = config;
    const v = config.video;
    const a = config.audio;
    const key = `${v?.codec}|${v?.width}x${v?.height}|${v?.description}|${a?.codec}|${a?.sampleRate}|${a?.channels}|${a?.description}`;
    if (v) {
      this.st.rotation = v.rotation || 0;
      this.st.width = v.width;
      this.st.height = v.height;
      this.nominalVideoDuration = Math.round(VIDEO_TIMESCALE / (v.fps || 30));
      const rot = v.rotation || 0;
      this.element.style.transform = rot ? `rotate(${rot}deg)` : '';
      this.element.dataset.rotation = String(rot);
    }
    if (key === this.trackKey) return;
    const firstInit = !this.trackKey;
    this.trackKey = key;
    this.needKey = true;
    this.st.audio = Boolean(a);
    const mime = mimeType(v, a);
    if (!MediaSource.isTypeSupported(mime)) {
      this.st.error = `This browser cannot play ${mime}`;
      return;
    }
    void this.opened.then(() => {
      if (this.destroyed || !this.ms) return;
      if (firstInit) {
        try {
          this.sb = this.ms.addSourceBuffer(mime);
          this.sb.mode = 'segments';
          this.sb.addEventListener('updateend', () => this.pump());
          this.sb.addEventListener('error', () => {
            this.st.error = 'SourceBuffer error';
          });
        } catch (e) {
          this.st.error = (e as Error).message;
          return;
        }
      } else if (this.sb) {
        try {
          // a new picture size or codec mid-stream: the SourceBuffer takes a new init segment of the same tracks
          this.sb.changeType?.(mime);
        } catch {
          /* same tracks, same codecs: the init segment alone is enough */
        }
      }
      this.queue.push(initSegment(v, a));
      this.pump();
    });
  }

  push(frame: DecodedFrame): void {
    if (this.destroyed || !this.config) return;
    if (frame.kind === 'video') {
      if (this.needKey) {
        if (!frame.key) {
          this.st.dropped++;
          return;
        }
        this.needKey = false;
      }
      this.st.framesIn++;
    }
    if (this.baseUs < 0) this.baseUs = frame.timestampUs;
    const rel = Math.max(0, frame.timestampUs - this.baseUs);
    if (frame.kind === 'video') {
      const dts = Math.round((rel * VIDEO_TIMESCALE) / 1e6);
      let duration = this.nominalVideoDuration;
      if (this.lastVideoUs >= 0) {
        const d = Math.round(((frame.timestampUs - this.lastVideoUs) * VIDEO_TIMESCALE) / 1e6);
        if (d > 0 && d < VIDEO_TIMESCALE) duration = d;
      }
      this.lastVideoUs = frame.timestampUs;
      this.queue.push(mediaSegment('video', this.seq++, dts, duration, frame.key, frame.data));
    } else {
      const a = this.config.audio;
      if (!a) return;
      const dts = Math.round((rel * a.sampleRate) / 1e6);
      this.queue.push(mediaSegment('audio', this.seq++, dts, 1024, true, frame.data));
    }
    this.pump();
  }

  private pump(): void {
    const sb = this.sb;
    if (!sb || sb.updating || !this.queue.length || this.destroyed) return;
    if (this.ms?.readyState !== 'open') return;
    // several frames at once: one append (the queue grows while the link stalls)
    let total = 0;
    const n = Math.min(this.queue.length, 64);
    for (let i = 0; i < n; i++) total += this.queue[i].byteLength;
    const chunk = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < n; i++) {
      chunk.set(this.queue[i], o);
      o += this.queue[i].byteLength;
    }
    this.queue.splice(0, n);
    try {
      sb.appendBuffer(chunk);
      this.st.framesOut += n;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'QuotaExceededError') {
        this.trim(true);
        this.queue.unshift(chunk);
      } else {
        this.st.error = err.message;
        this.needKey = true;
      }
    }
  }

  /** Keeps the playhead near the live edge, and the buffer short. */
  private chase(): void {
    const v = this.element;
    const sb = this.sb;
    if (!sb || this.destroyed) return;
    try {
      const b = v.buffered;
      if (!b.length) return;
      const end = b.end(b.length - 1);
      const behind = end - v.currentTime;
      this.st.behindS = Math.max(0, behind);
      if (v.paused && v.readyState >= 2) void v.play().catch(() => undefined);
      if (behind > MSE_MAX_BEHIND_S) {
        v.currentTime = Math.max(b.start(b.length - 1), end - MSE_TARGET_BEHIND_S);
        v.playbackRate = 1;
      } else if (behind > MSE_TARGET_BEHIND_S * 2) {
        v.playbackRate = 1.08;
      } else {
        v.playbackRate = 1;
      }
      this.trim(false);
    } catch {
      /* buffered ranges unavailable while the SourceBuffer updates */
    }
  }

  private trim(hard: boolean): void {
    const sb = this.sb;
    const v = this.element;
    if (!sb || sb.updating) return;
    try {
      const b = v.buffered;
      if (!b.length) return;
      const cut = v.currentTime - (hard ? 2 : MSE_KEEP_S);
      if (cut > b.start(0) + 1) sb.remove(0, cut);
    } catch {
      /* ignore */
    }
  }

  async unlock(): Promise<void> {
    try {
      await this.element.play();
    } catch {
      /* no data yet; chase() retries */
    }
  }

  setMuted(muted: boolean): void {
    this.element.muted = muted;
  }

  stats(): SinkStats {
    return { ...this.st };
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.chaser);
    try {
      if (this.ms?.readyState === 'open') this.ms.endOfStream();
    } catch {
      /* ignore */
    }
    this.element.pause();
    URL.revokeObjectURL(this.element.src);
    this.element.removeAttribute('src');
    this.sb = undefined;
    this.ms = undefined;
    this.queue = [];
  }
}

export function createSink(prefer?: 'webcodecs' | 'mse'): MediaSink {
  if (prefer === 'mse' && mseAvailable()) return new MseSink();
  if (prefer !== 'mse' && webCodecsAvailable()) return new WebCodecsSink();
  if (mseAvailable()) return new MseSink();
  throw new Error('This browser has neither WebCodecs nor Media Source Extensions');
}
