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

/**
 * Consecutive chunks whose timestamps line up within this tolerance are glued back to back
 * (sample-accurate), instead of each being placed at its own rounded microsecond timestamp.
 * Anything further apart is a real discontinuity (seek, dropped chunk) and re-syncs.
 */
const CONTIGUOUS_TOLERANCE_S = 0.004;

export class AudioSink implements PlaybackClock {
  ctx: AudioContext;
  private gain: GainNode;
  private baseCtxTime = 0;
  private baseMediaUs = 0;
  private started = false;
  private sources = new Set<AudioBufferSourceNode>();
  private pending: AudioData[] = [];
  /** Context time at which the last scheduled chunk ends; the next contiguous chunk starts exactly there */
  private nextStartTime = -1;
  /** Media time (us) up to which audio has been scheduled */
  scheduledUntilUs = 0;
  scheduledChunks = 0;
  droppedChunks = 0;
  /** Media time (us) of the earliest chunk that was actually scheduled since the last start()/reset(); -1 = none yet */
  firstScheduledUs = -1;
  lastError = '';

  /**
   * @param sampleRate the track's sample rate. The context is opened at that rate so the whole
   *   stream is resampled once, continuously, by the output device path. Opening it at the device
   *   rate (the default, usually 48 kHz) and feeding 44.1 kHz AudioBuffers made Web Audio resample
   *   every ~23 ms chunk on its own, and the seams between them crackled.
   */
  constructor(sampleRate?: number) {
    this.ctx = AudioSink.createContext(sampleRate);
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  private static createContext(sampleRate?: number): AudioContext {
    if (sampleRate && sampleRate >= 8000 && sampleRate <= 96000) {
      try {
        return new AudioContext({ sampleRate });
      } catch {
        /* rate not supported here; fall back to the device rate */
      }
    }
    return new AudioContext();
  }

  /**
   * The decoder's real output rate can differ from the configured one (HE-AAC doubles it). While
   * nothing has been scheduled yet the context is cheap to reopen at the right rate.
   */
  private matchContextRate(rate: number): void {
    if (this.started || this.scheduledChunks || !rate || rate === this.ctx.sampleRate) return;
    const old = this.ctx;
    const next = AudioSink.createContext(rate);
    if (next.sampleRate !== rate) {
      void next.close();
      return;
    }
    const volume = this.gain.gain.value;
    void old.close();
    this.ctx = next;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;
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
   *
   * Chunks decoded before this call (held in `pending`) are kept and scheduled against the new
   * base: the renderer pre-decodes a few seconds of sound before the clock starts, and dropping
   * them here used to leave the first seconds of every video (and every seek) silent.
   */
  async start(mediaUs: number, resumeTimeoutMs = 400): Promise<boolean> {
    this.stopScheduled();
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
    this.matchContextRate(data.sampleRate);
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
      const nominal = this.baseCtxTime + (data.timestamp - this.baseMediaUs) / 1e6;
      // Glue the chunk to the end of the previous one when the timestamps say they are adjacent:
      // starting each buffer at its own rounded timestamp left one-sample gaps/overlaps that click.
      const contiguous = this.nextStartTime >= 0 && Math.abs(nominal - this.nextStartTime) <= CONTIGUOUS_TOLERANCE_S;
      const when = contiguous ? this.nextStartTime : nominal;
      const now = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.onended = () => this.sources.delete(src);
      // A chunk whose start is already behind the clock (or before context time 0, which start()
      // rejects) plays from the matching offset instead of being placed in the past.
      if (when < now) {
        const offset = now - when;
        if (offset >= buffer.duration) {
          this.droppedChunks++;
          this.nextStartTime = -1;
          return;
        }
        src.start(now, offset);
      } else {
        src.start(when);
      }
      const durationS = frames / data.sampleRate;
      this.nextStartTime = when + durationS;
      this.sources.add(src);
      this.scheduledChunks++;
      if (this.firstScheduledUs < 0 || data.timestamp < this.firstScheduledUs) this.firstScheduledUs = data.timestamp;
      this.scheduledUntilUs = Math.max(this.scheduledUntilUs, data.timestamp + Math.round(durationS * 1e6));
    } catch (e) {
      this.lastError = (e as Error).message;
      this.droppedChunks++;
      this.nextStartTime = -1;
    } finally {
      data.close();
    }
  }

  /** Stop every buffer that is playing or scheduled; chunks still waiting in `pending` are kept. */
  private stopScheduled(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.scheduledUntilUs = 0;
    this.firstScheduledUs = -1;
    this.nextStartTime = -1;
  }

  /** Stop every scheduled buffer and discard undecoded-ahead chunks (seek / stop). */
  stopAll(): void {
    this.stopScheduled();
    for (const d of this.pending) d.close();
    this.pending = [];
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
