/**
 * Mode B: fetch -> mp4box demux -> VideoDecoder / AudioDecoder -> Canvas 2D + Web Audio.
 *
 * No <video> element is involved. Frames are scheduled against the audio clock (or a wall
 * clock when there is no audio): on every animation frame the newest decoded frame whose
 * timestamp <= clock is painted and older ones are closed (counted as dropped).
 */
import type { Sample } from 'mp4box';
import { AudioSink, WallClock, type PlaybackClock } from '../media/audioOutput';
import { shortCodecName, type TrackInfo } from '../media/codecConfig';
import { Mp4Demuxer } from '../media/demuxer';
import { emptyStats, FpsCounter, type LoadSource, type PlayerState, type PlayerStats, type Renderer, type RendererEvents } from './types';

const TARGET_DECODED_FRAMES = 12; // frames kept decoded ahead of the playhead
const MAX_DECODE_QUEUE = 8; // chunks in flight inside the decoder
const AUDIO_AHEAD_US = 2_500_000; // schedule audio this far ahead
const MAX_QUEUED_VIDEO_SAMPLES = 600; // network backpressure thresholds (samples)
const MAX_QUEUED_AUDIO_SAMPLES = 1500;
const MIN_START_FRAMES = 3;

export function webCodecsSupported(): { ok: boolean; reason?: string } {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
    return { ok: false, reason: 'WebCodecs VideoDecoder is not available in this browser' };
  }
  if (!window.isSecureContext) return { ok: false, reason: 'WebCodecs requires a secure context (https or localhost)' };
  return { ok: true };
}

export class WebCodecsRenderer implements Renderer {
  readonly name = 'WebCodecs + Canvas';
  private ctx2d: CanvasRenderingContext2D;
  private demuxer?: Mp4Demuxer;
  private videoDecoder?: VideoDecoder;
  private audioDecoder?: AudioDecoder;
  private videoTrack?: TrackInfo;
  private audioTrack?: TrackInfo;
  private videoSamples: Sample[] = [];
  private audioSamples: Sample[] = [];
  private frames: VideoFrame[] = [];
  private clock: PlaybackClock = new WallClock();
  private audio?: AudioSink;
  private audioEnabled = false;
  /** AudioContext could not be resumed (autoplay policy); wall clock drives video until Play is pressed */
  private audioBlocked = false;
  private _state: PlayerState = 'idle';
  private st: PlayerStats = emptyStats(this.name);
  private fps = new FpsCounter();
  private raf = 0;
  private fallbackTimer = 0;
  private lastTickAt = 0;
  private durationUs = 0;
  private lastRenderedUs = 0;
  private clockRunning = false;
  private wantPlay = false;
  private demuxEnded = false;
  private videoEos = false;
  private flushing = false;
  private pendingSeekUs: number | undefined;
  private needKey = true;
  private lastVideoSampleUs = 0;
  private lastReleasedSample = 0;
  private volume = 1;
  private firstFrameSent = false;
  private rotation = 0;
  private generation = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: RendererEvents,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx2d = ctx;
  }

  get state(): PlayerState {
    return this._state;
  }
  get currentTime(): number {
    const us = this.clockRunning ? this.clock.currentMediaUs() : this.pendingSeekUs ?? this.lastRenderedUs;
    return Math.min(this.durationUs || Infinity, Math.max(0, us)) / 1e6;
  }
  get duration(): number {
    return this.durationUs / 1e6;
  }

  private setState(s: PlayerState): void {
    if (this._state === s) return;
    this._state = s;
    this.st.state = s;
    this.events.onStateChange(s);
  }

  async load(src: LoadSource): Promise<void> {
    this.teardownMedia();
    const gen = ++this.generation;
    this.st = emptyStats(this.name);
    this.st.connection = src.connection;
    this.st.source = src.label;
    this.st.cors = src.corsResult === 'passed' ? 'Passed' : src.corsResult === 'failed' ? 'Failed' : src.corsResult === 'same-origin' ? 'Same-origin (n/a)' : 'Not tested';
    this.setState('loading');
    const support = webCodecsSupported();
    if (!support.ok) {
      this.fail(new Error(support.reason!));
      return;
    }
    this.demuxer = new Mp4Demuxer(src.url, src.fetchInit, {
      onReady: (info, video, audio) => {
        if (gen !== this.generation) return;
        void this.configure(info.duration / info.timescale, video, audio);
      },
      onVideoSamples: (samples) => {
        if (gen !== this.generation) return;
        this.videoSamples.push(...samples);
        const last = samples[samples.length - 1];
        if (last && this.videoTrack) this.lastVideoSampleUs = this.toUs(last.cts, this.videoTrack);
        this.applyBackpressure();
        this.pump();
      },
      onAudioSamples: (samples) => {
        if (gen !== this.generation) return;
        this.audioSamples.push(...samples);
        this.applyBackpressure();
        this.pump();
      },
      onProgress: (loaded, total) => {
        this.st.bytesLoaded = loaded;
        this.st.totalBytes = total;
      },
      onEnd: () => {
        if (gen !== this.generation) return;
        this.demuxEnded = true;
        this.pump();
      },
      onError: (err) => {
        if (gen !== this.generation) return;
        this.fail(err);
      },
      onLog: (msg) => this.events.onLog('info', `[demux] ${msg}`),
    });
    this.demuxer.start();
    this.startLoop();
  }

  private toUs(ts: number, t: TrackInfo): number {
    return Math.round(((ts - t.editOffset) * 1e6) / t.timescale);
  }

  private async configure(durationSec: number, video: TrackInfo | undefined, audio: TrackInfo | undefined): Promise<void> {
    const gen = this.generation;
    if (!video?.videoConfig) {
      this.fail(new Error('No video track found in MP4'));
      return;
    }
    this.videoTrack = video;
    this.audioTrack = audio;
    this.durationUs = Math.round(durationSec * 1e6);
    this.st.duration = durationSec;
    this.rotation = video.rotation;
    const w = video.width || 0;
    const h = video.height || 0;
    const rotated = this.rotation === 90 || this.rotation === 270;
    this.canvas.width = rotated ? h : w;
    this.canvas.height = rotated ? w : h;
    this.st.resolution = `${this.canvas.width} × ${this.canvas.height}${this.rotation ? ` (rotated ${this.rotation}°)` : ''}`;
    this.st.videoCodec = `${shortCodecName(video.codec)} (${video.codec})`;
    this.st.extra['Video samples'] = String(video.nbSamples);
    this.st.extra['Edit offset'] = `${video.editOffset} / ${video.timescale}`;
    if (video.configNote) this.events.onLog('warn', video.configNote);

    let support: VideoDecoderSupport;
    try {
      support = await VideoDecoder.isConfigSupported(video.videoConfig);
    } catch (e) {
      this.fail(new Error(`VideoDecoder.isConfigSupported threw: ${(e as Error).message}`));
      return;
    }
    if (gen !== this.generation) return;
    if (!support.supported) {
      this.fail(new Error(`VideoDecoder does not support ${video.codec} with the given configuration`));
      return;
    }
    this.videoDecoder = this.makeVideoDecoder(video.videoConfig);
    this.events.onLog('info', `VideoDecoder configured: ${video.codec} ${w}x${h}, description ${video.videoConfig.description ? (video.videoConfig.description as Uint8Array).byteLength + ' bytes' : 'none'}`);

    if (audio?.audioConfig && typeof AudioDecoder !== 'undefined') {
      try {
        const as = await AudioDecoder.isConfigSupported(audio.audioConfig);
        if (gen !== this.generation) return;
        if (as.supported) {
          this.audio = new AudioSink();
          this.audio.setVolume(this.volume);
          this.clock = this.audio;
          this.audioDecoder = this.makeAudioDecoder(audio.audioConfig);
          this.audioEnabled = true;
          this.st.audio = `Web Audio (${shortCodecName(audio.codec)} ${audio.audioConfig.sampleRate} Hz × ${audio.audioConfig.numberOfChannels})`;
          this.events.onLog('info', `AudioDecoder configured: ${audio.codec} ${audio.audioConfig.sampleRate} Hz, description ${audio.audioConfig.description ? (audio.audioConfig.description as Uint8Array).byteLength + ' bytes' : 'none'}`);
        } else {
          this.st.audio = `unsupported (${audio.codec}) – wall clock`;
          this.events.onLog('warn', `AudioDecoder does not support ${audio.codec}; playing without audio`);
        }
      } catch (e) {
        this.st.audio = `error – wall clock`;
        this.events.onLog('warn', `AudioDecoder setup failed: ${(e as Error).message}`);
      }
    } else {
      this.st.audio = audio ? `no AudioDecoder (${audio.codec}) – wall clock` : 'no audio track – wall clock';
    }
    if (!this.audioEnabled) this.clock = new WallClock();
    this.setState('ready');
    this.pump();
  }

  private makeVideoDecoder(config: VideoDecoderConfig): VideoDecoder {
    const gen = this.generation;
    const dec = new VideoDecoder({
      output: (frame) => {
        if (gen !== this.generation) {
          frame.close();
          return;
        }
        this.st.decodedFrames++;
        if (this.pendingSeekUs !== undefined && frame.timestamp < this.pendingSeekUs - 1000) {
          frame.close(); // pre-roll frames between the RAP and the seek target
          return;
        }
        // Insert in presentation order (decoders emit in order, but be safe)
        let i = this.frames.length;
        while (i > 0 && this.frames[i - 1].timestamp > frame.timestamp) i--;
        this.frames.splice(i, 0, frame);
        this.pump();
      },
      error: (e) => this.fail(new Error(`VideoDecoder error: ${e.message}`)),
    });
    dec.configure(config);
    this.needKey = true;
    return dec;
  }

  private makeAudioDecoder(config: AudioDecoderConfig): AudioDecoder {
    const gen = this.generation;
    const dec = new AudioDecoder({
      output: (data) => {
        if (gen !== this.generation || !this.audio) {
          data.close();
          return;
        }
        if (this.pendingSeekUs !== undefined && data.timestamp + (data.duration || 0) < this.pendingSeekUs) {
          data.close();
          return;
        }
        this.audio.enqueue(data);
        this.pump();
      },
      error: (e) => {
        this.events.onLog('error', `AudioDecoder error: ${e.message} – continuing without audio`);
        this.disableAudio();
      },
    });
    dec.configure(config);
    return dec;
  }

  private disableAudio(): void {
    const wasRunning = this.clockRunning;
    const nowUs = this.clock.currentMediaUs();
    this.audioEnabled = false;
    try {
      this.audioDecoder?.close();
    } catch {
      /* ignore */
    }
    this.audioDecoder = undefined;
    this.audio?.destroy();
    this.audio = undefined;
    this.audioSamples = [];
    this.clock = new WallClock();
    this.st.audio = 'disabled after decoder error – wall clock';
    if (wasRunning) void this.clock.start(nowUs);
  }

  private applyBackpressure(): void {
    if (!this.demuxer) return;
    const full = this.videoSamples.length > MAX_QUEUED_VIDEO_SAMPLES || this.audioSamples.length > MAX_QUEUED_AUDIO_SAMPLES;
    const low = this.videoSamples.length < MAX_QUEUED_VIDEO_SAMPLES / 2 && this.audioSamples.length < MAX_QUEUED_AUDIO_SAMPLES / 2;
    if (full) this.demuxer.pause();
    else if (low) this.demuxer.resume();
  }

  /** Feed the decoders while their queues are short. */
  private pump(): void {
    const vd = this.videoDecoder;
    const vt = this.videoTrack;
    if (!vd || !vt || vd.state !== 'configured') return;
    while (this.frames.length + vd.decodeQueueSize < TARGET_DECODED_FRAMES && vd.decodeQueueSize < MAX_DECODE_QUEUE && this.videoSamples.length) {
      const s = this.videoSamples.shift()!;
      if (this.needKey && !s.is_sync) continue;
      this.needKey = false;
      try {
        vd.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: this.toUs(s.cts, vt),
            duration: Math.round((s.duration * 1e6) / vt.timescale),
            data: s.data!,
          }),
        );
      } catch (e) {
        this.fail(new Error(`decode() threw: ${(e as Error).message}`));
        return;
      }
      if (s.number - this.lastReleasedSample > 60) {
        this.demuxer?.releaseSamples(vt.id, s.number);
        this.lastReleasedSample = s.number;
      }
    }
    const ad = this.audioDecoder;
    const at = this.audioTrack;
    if (ad && at && this.audio && ad.state === 'configured') {
      const horizon = (this.clockRunning ? this.clock.currentMediaUs() : this.pendingSeekUs ?? this.lastRenderedUs) + AUDIO_AHEAD_US;
      while (this.audioSamples.length && ad.decodeQueueSize < 16 && this.audio.scheduledUntilUs < horizon) {
        const s = this.audioSamples.shift()!;
        const ts = this.toUs(s.cts, at);
        try {
          ad.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, duration: Math.round((s.duration * 1e6) / at.timescale), data: s.data! }));
        } catch (e) {
          this.events.onLog('warn', `audio decode() threw: ${(e as Error).message}`);
          this.disableAudio();
          break;
        }
        // scheduledUntilUs only advances on output; use the chunk's own end time to bound the loop
        if (!this.audio.scheduledUntilUs || this.audio.scheduledUntilUs < ts) this.audio.scheduledUntilUs = ts;
      }
    }
    // End of stream: flush decoders once everything has been queued.
    if (this.demuxEnded && !this.videoSamples.length && !this.flushing && !this.videoEos && vd.decodeQueueSize >= 0) {
      this.flushing = true;
      const gen = this.generation;
      const done = () => {
        if (gen !== this.generation) return;
        this.videoEos = true;
        this.flushing = false;
      };
      vd.flush().then(done, done);
      if (ad && ad.state === 'configured' && !this.audioSamples.length) ad.flush().catch(() => undefined);
    }
    this.applyBackpressure();
  }

  async play(): Promise<void> {
    if (this._state === 'error') return;
    if (this._state === 'ended') this.seek(0);
    this.wantPlay = true;
    if (this.audioBlocked && this.clockRunning) await this.unblockAudio();
    if (this.clockRunning && !this.clock.running) {
      await this.clock.resume();
      this.setState('playing');
    } else if (this.audio) {
      // Resume the AudioContext inside the user gesture so autoplay policy is satisfied.
      await this.audio.resume().catch(() => undefined);
    }
    this.pump();
  }

  pause(): void {
    this.wantPlay = false;
    if (this.clockRunning) {
      void this.clock.pause();
      this.lastRenderedUs = this.clock.currentMediaUs();
    }
    if (this._state === 'playing' || this._state === 'buffering') this.setState('paused');
  }

  seek(seconds: number): void {
    if (!this.demuxer || !this.videoTrack || !this.videoDecoder) return;
    const wasPlaying = this.wantPlay;
    const targetUs = Math.max(0, Math.min(this.durationUs, Math.round(seconds * 1e6)));
    this.wantPlay = false;
    if (this.clockRunning) void this.clock.pause();
    this.clockRunning = false;
    for (const f of this.frames) f.close();
    this.frames = [];
    this.videoSamples = [];
    this.audioSamples = [];
    this.videoEos = false;
    this.flushing = false;
    this.demuxEnded = false;
    this.pendingSeekUs = targetUs;
    this.lastRenderedUs = targetUs;
    this.audio?.reset();
    try {
      this.videoDecoder.reset();
      this.videoDecoder.configure(this.videoTrack.videoConfig!);
      this.needKey = true;
      if (this.audioDecoder && this.audioTrack?.audioConfig) {
        this.audioDecoder.reset();
        this.audioDecoder.configure(this.audioTrack.audioConfig);
      }
    } catch (e) {
      this.fail(new Error(`decoder reset failed: ${(e as Error).message}`));
      return;
    }
    const rap = this.demuxer.seek(seconds);
    this.st.extra['Last seek'] = `${seconds.toFixed(2)}s → RAP ${rap.toFixed(2)}s`;
    this.wantPlay = wasPlaying;
    this.setState(wasPlaying ? 'buffering' : 'paused');
  }

  setVolume(v: number): void {
    this.volume = v;
    this.audio?.setVolume(v);
  }

  stats(): PlayerStats {
    this.st.fps = this.fps.value();
    this.st.decodeQueue = this.videoDecoder?.decodeQueueSize ?? 0;
    this.st.framesBuffered = this.frames.length;
    this.st.currentTime = this.currentTime;
    const nowUs = this.clockRunning ? this.clock.currentMediaUs() : this.lastRenderedUs;
    this.st.bufferedAheadSec = Math.max(0, (this.lastVideoSampleUs - nowUs) / 1e6);
    if (this.demuxer) {
      const d = this.demuxer.stats;
      this.st.extra['HTTP'] = `${d.httpStatus} ${d.contentType}`;
      this.st.extra['Range requests'] = d.rangeSupported === undefined ? 'untested' : d.rangeSupported ? 'supported' : 'ignored by server';
      this.st.extra['Progressive (moov first)'] = d.isProgressive === undefined ? '?' : String(d.isProgressive);
      this.st.extra['Fetch restarts'] = String(d.restarts);
    }
    if (this.audio) {
      this.st.extra['Audio context'] = this.audio.contextState;
      this.st.extra['Audio chunks'] = `${this.audio.scheduledChunks} scheduled, ${this.audio.droppedChunks} dropped${this.audio.lastError ? ', err: ' + this.audio.lastError : ''}`;
    }
    this.st.extra['Queued samples'] = `${this.videoSamples.length} video / ${this.audioSamples.length} audio`;
    return this.st;
  }

  destroy(): void {
    this.teardownMedia();
    this.generation++;
  }

  private teardownMedia(): void {
    this.generation++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearInterval(this.fallbackTimer);
    this.fallbackTimer = 0;
    this.demuxer?.destroy();
    this.demuxer = undefined;
    try {
      if (this.videoDecoder && this.videoDecoder.state !== 'closed') this.videoDecoder.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.audioDecoder && this.audioDecoder.state !== 'closed') this.audioDecoder.close();
    } catch {
      /* ignore */
    }
    this.videoDecoder = undefined;
    this.audioDecoder = undefined;
    for (const f of this.frames) f.close();
    this.frames = [];
    this.videoSamples = [];
    this.audioSamples = [];
    this.audio?.destroy();
    this.audio = undefined;
    this.audioEnabled = false;
    this.clock = new WallClock();
    this.clockRunning = false;
    this.wantPlay = false;
    this.demuxEnded = false;
    this.videoEos = false;
    this.flushing = false;
    this.pendingSeekUs = undefined;
    this.lastRenderedUs = 0;
    this.lastVideoSampleUs = 0;
    this.lastReleasedSample = 0;
    this.durationUs = 0;
    this.firstFrameSent = false;
    this.fps.reset();
    this.videoTrack = undefined;
    this.audioTrack = undefined;
  }

  private fail(err: Error): void {
    this.events.onLog('error', err.message);
    this.setState('error');
    this.events.onError(err);
  }

  private startLoop(): void {
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.lastTickAt = performance.now();
      this.frameStep();
    };
    this.raf = requestAnimationFrame(tick);
    // requestAnimationFrame stops in hidden/occluded tabs; keep the scheduler (and therefore
    // frame dropping, buffering and end-of-stream detection) alive with a coarse timer.
    this.fallbackTimer = window.setInterval(() => {
      if (performance.now() - this.lastTickAt > 120) this.frameStep();
    }, 100);
  }

  private startingClock = false;

  private async startClock(atUs: number): Promise<void> {
    if (this.startingClock) return;
    this.startingClock = true;
    try {
      if (this.audio && !this.audioBlocked) {
        const ok = await this.audio.start(atUs);
        if (!ok) {
          this.audioBlocked = true;
          this.clock = new WallClock();
          this.st.audio += ' – blocked by autoplay policy, press Play to enable';
          this.events.onLog('warn', 'AudioContext could not be resumed (no user gesture yet); video runs on a wall clock until Play is pressed');
        }
      }
      this.clockRunning = true;
      if (!this.audio || this.audioBlocked) await this.clock.start(atUs);
      if (!this.wantPlay) {
        await this.clock.pause();
        return;
      }
      this.setState('playing');
    } finally {
      this.startingClock = false;
    }
  }

  /** After a user gesture, hand the clock back to the audio sink if it was blocked earlier. */
  private async unblockAudio(): Promise<void> {
    if (!this.audio || !this.audioBlocked) return;
    const nowUs = this.clock.currentMediaUs();
    const ok = await this.audio.start(nowUs, 1500);
    if (!ok) return;
    this.audioBlocked = false;
    this.clock = this.audio;
    this.st.audio = this.st.audio.replace(' – blocked by autoplay policy, press Play to enable', ' (resumed after gesture)');
    this.events.onLog('info', 'AudioContext resumed after user gesture; audio clock is now master');
  }

  private frameStep(): void {
    if (this._state === 'error' || this._state === 'idle' || this._state === 'loading') return;
    // Paused / not started: show the first available frame (e.g. after load or seek).
    if (!this.clockRunning) {
      if (this.frames.length && (this.pendingSeekUs !== undefined || !this.firstFrameSent)) {
        const f = this.frames.shift()!;
        this.paint(f);
        this.lastRenderedUs = f.timestamp;
        f.close();
        this.pendingSeekUs = undefined;
      }
      if (this.wantPlay) {
        if (this.frames.length >= MIN_START_FRAMES || this.videoEos) {
          const startAt = this.frames.length ? Math.min(this.frames[0].timestamp, this.lastRenderedUs || this.frames[0].timestamp) : this.lastRenderedUs;
          void this.startClock(startAt);
        } else {
          this.setState('buffering');
          this.pump();
        }
      }
      return;
    }
    const now = this.clock.currentMediaUs();
    let chosen: VideoFrame | undefined;
    while (this.frames.length && this.frames[0].timestamp <= now + 2000) {
      if (chosen) {
        chosen.close();
        this.st.droppedFrames++;
      }
      chosen = this.frames.shift();
    }
    if (chosen) {
      this.paint(chosen);
      this.lastRenderedUs = chosen.timestamp;
      chosen.close();
      this.pendingSeekUs = undefined;
      this.pump();
      if (this._state === 'buffering' && this.wantPlay) {
        void this.clock.resume().then(() => this.setState('playing'));
      }
    } else if (!this.frames.length) {
      if (this.videoEos) {
        if (now >= this.lastRenderedUs) {
          this.wantPlay = false;
          void this.clock.pause();
          this.clockRunning = false;
          this.setState('ended');
        }
      } else if (this.wantPlay && this._state === 'playing' && now - this.lastRenderedUs > 250_000) {
        // Decoder/network starved: freeze the clock until frames are available again.
        this.setState('buffering');
        void this.clock.pause();
      }
    }
    if (this._state === 'buffering' && this.wantPlay && this.frames.length >= MIN_START_FRAMES) {
      void this.clock.resume().then(() => this.setState('playing'));
    }
  }

  private paint(frame: VideoFrame): void {
    const c = this.canvas;
    const ctx = this.ctx2d;
    if (this.rotation) {
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((this.rotation * Math.PI) / 180);
      const w = this.rotation === 90 || this.rotation === 270 ? c.height : c.width;
      const h = this.rotation === 90 || this.rotation === 270 ? c.width : c.height;
      ctx.drawImage(frame, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(frame, 0, 0, c.width, c.height);
    }
    this.st.renderedFrames++;
    this.fps.tick();
    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      this.events.onFirstFrame();
    }
  }
}
