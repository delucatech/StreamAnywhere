/**
 * Playback clocks.
 *
 * AudioSink: Web Audio output for decoded AudioData. Each AudioData becomes an AudioBuffer
 * scheduled at (baseCtxTime + (timestamp - baseMediaUs)). Because AudioContext.currentTime
 * freezes while suspended, the audio context doubles as the master clock for video
 * frame scheduling; pause() = suspend(), resume() = resume().
 *
 * WallClock: performance.now()-based fallback used when there is no (decodable) audio track.
 */

export interface PlaybackClock {
  /** Start (or re-base) the clock at the given media time, in microseconds. Resolves false if the clock could not start. */
  start(mediaUs: number): Promise<boolean>;
  currentMediaUs(): number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  readonly running: boolean;
}

export class WallClock implements PlaybackClock {
  private baseMediaUs = 0;
  private basePerf = 0;
  private _running = false;
  private pausedAtUs = 0;
  get running(): boolean {
    return this._running;
  }
  async start(mediaUs: number): Promise<boolean> {
    this.baseMediaUs = mediaUs;
    this.basePerf = performance.now();
    this._running = true;
    return true;
  }
  currentMediaUs(): number {
    if (!this._running) return this.pausedAtUs;
    return this.baseMediaUs + (performance.now() - this.basePerf) * 1000;
  }
  async pause(): Promise<void> {
    if (!this._running) return;
    this.pausedAtUs = this.currentMediaUs();
    this._running = false;
  }
  async resume(): Promise<void> {
    if (this._running) return;
    await this.start(this.pausedAtUs);
  }
}

export class AudioSink implements PlaybackClock {
  readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private baseCtxTime = 0;
  private baseMediaUs = 0;
  private started = false;
  private sources = new Set<AudioBufferSourceNode>();
  private pending: AudioData[] = [];
  /** Media time (us) up to which audio has been scheduled */
  scheduledUntilUs = 0;
  scheduledChunks = 0;
  droppedChunks = 0;
  lastError = '';

  constructor() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  get running(): boolean {
    return this.started && this.ctx.state === 'running';
  }

  get contextState(): AudioContextState {
    return this.ctx.state;
  }

  setVolume(v: number): void {
    this.gain.gain.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Starts the clock at mediaUs. Resolves false when the AudioContext could not be resumed within
   * the timeout (Chrome's autoplay policy keeps contexts created without a user gesture suspended).
   */
  async start(mediaUs: number, resumeTimeoutMs = 400): Promise<boolean> {
    this.stopAll();
    this.baseMediaUs = mediaUs;
    if (this.ctx.state !== 'running') {
      const resumed = await Promise.race([
        this.ctx.resume().then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), resumeTimeoutMs)),
      ]);
      if (!resumed || (this.ctx.state as AudioContextState) !== 'running') return false;
    }
    this.baseCtxTime = this.ctx.currentTime + 0.03;
    this.started = true;
    const p = this.pending;
    this.pending = [];
    for (const d of p) this.schedule(d);
    return true;
  }

  currentMediaUs(): number {
    if (!this.started) return this.baseMediaUs;
    return this.baseMediaUs + Math.max(0, this.ctx.currentTime - this.baseCtxTime) * 1e6;
  }

  async pause(): Promise<void> {
    if (this.ctx.state === 'running') await this.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Queue decoded audio. Before start() the data is held; afterwards it is scheduled immediately. */
  enqueue(data: AudioData): void {
    if (!this.started) {
      this.pending.push(data);
      if (this.pending.length > 400) this.pending.shift()?.close();
      return;
    }
    this.schedule(data);
  }

  private schedule(data: AudioData): void {
    try {
      const frames = data.numberOfFrames;
      const channels = data.numberOfChannels;
      const buffer = this.ctx.createBuffer(channels, frames, data.sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        buffer.copyToChannel(plane, ch);
      }
      const when = this.baseCtxTime + (data.timestamp - this.baseMediaUs) / 1e6;
      const now = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.onended = () => this.sources.delete(src);
      if (when < now - 0.005) {
        const offset = now - when;
        if (offset >= buffer.duration) {
          this.droppedChunks++;
          data.close();
          return;
        }
        src.start(now, offset);
      } else {
        src.start(when);
      }
      this.sources.add(src);
      this.scheduledChunks++;
      this.scheduledUntilUs = Math.max(this.scheduledUntilUs, data.timestamp + (data.duration || 0));
    } catch (e) {
      this.lastError = (e as Error).message;
      this.droppedChunks++;
    } finally {
      data.close();
    }
  }

  /** Stop every scheduled buffer (seek / stop). */
  stopAll(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    for (const d of this.pending) d.close();
    this.pending = [];
    this.scheduledUntilUs = 0;
  }

  reset(): void {
    this.stopAll();
    this.started = false;
  }

  destroy(): void {
    this.stopAll();
    void this.ctx.close();
  }
}
