/**
 * Mode B: fetch -> mp4box demux -> VideoDecoder / AudioDecoder -> Canvas 2D + Web Audio.
 *
 * No <video> element is involved. Frames are scheduled against the audio clock (or a wall
 * clock when there is no audio): on every animation frame the newest decoded frame whose
 * timestamp <= clock is painted and older ones are closed (counted as dropped).
 *
 * A source may come as two files (LoadSource.audioUrl - YouTube serves picture and sound
 * separately): a second demuxer then feeds the audio samples, and the decoders are configured once
 * both files have delivered their track descriptions (an audio file that fails is simply left out).
 */
import type { Sample } from 'mp4box';
import { AudioSink, WallClock, type PlaybackClock } from '../media/audioOutput';
import { shortCodecName, type TrackInfo } from '../media/codecConfig';
import { Mp4Demuxer, type MediaRecording } from '../media/demuxer';
import { emptyStats, FpsCounter, type DownloadProgress, type LoadSource, type PlayerState, type PlayerStats, type Renderer, type RendererEvents } from './types';

const TARGET_DECODED_FRAMES = 12; // frames kept decoded ahead of the playhead
const MAX_DECODE_QUEUE = 8; // chunks in flight inside the decoder
/**
 * Sound is decoded and placed on the timeline this far ahead of the clock: a decoder that answers
 * late by a few seconds (the car's, busy with the picture) still lands its chunks in the future.
 * 2.5 s used to be the lead, and the car dropped hundreds of chunks that came back too late.
 */
const AUDIO_AHEAD_US = 6_000_000;
/** The sound on the timeline about to run out while chunks are still with the decoder: wait for it (buffering) instead of dropping what comes late */
const AUDIO_LOW_US = 150_000;
/** Resume from an audio wait once this much sound is on the timeline again */
const AUDIO_RESUME_US = 1_500_000;
const MAX_QUEUED_VIDEO_SAMPLES = 600; // network backpressure thresholds (samples)
const MAX_QUEUED_AUDIO_SAMPLES = 1500;
const MIN_START_FRAMES = 3;
/** A live stream whose timestamps leave the clock by this much (either way) is followed, not waited for or dropped */
const LIVE_JUMP_US = 3_000_000;
/** The sound timeline run dry for this long with chunks still at the decoder = a stall the watchdog undoes (a restart) */
const AUDIO_STALL_MS = 2000;
/** The AudioContext's clock not moving for this long while it says it is running = the output device is gone */
const AUDIO_FROZEN_MS = 2000;
/** Restarts of the sound in a row that scheduled nothing before giving the picture a wall clock */
const AUDIO_RECOVERY_LIMIT = 3;

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
  /** Demuxer of the separate sound file (LoadSource.audioUrl); undefined when the sound is in `demuxer`'s file */
  private audioDemuxer?: Mp4Demuxer;
  private lastReleasedAudioSample = 0;
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
  private _audioBlocked = false;
  /** Media seconds per real second; applied to every clock this renderer makes */
  private rate = 1;
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
  /** NAL unit length prefix of the video samples (avcC / hvcC lengthSizeMinusOne + 1), for the key-frame check */
  private nalLength = 4;
  private fakeKeyFrames = 0;
  private fakeKeyWarned = false;
  /** When the video decoder was restarted after refusing a chunk (recoverDecoder) */
  private decoderRestarts: number[] = [];
  private lastVideoSampleUs = 0;
  private lastReleasedSample = 0;
  private volume = 1;
  private firstFrameSent = false;
  private rotation = 0;
  private generation = 0;
  /** An endless stream (LoadSource.live): see frameStep for what differs */
  private live = false;
  /** The sound watchdog (audioWatch): the context's clock last seen, since when it has not moved, restarts in a row that brought nothing */
  private lastCtxTime = -1;
  private ctxFrozenSince = 0;
  private audioRecoveries = 0;
  private audioRecoveryStreak = 0;
  private lastRecoveryAt = 0;
  /** Since when the sound timeline has been dry (nothing left to play) with chunks still at the decoder; 0 = it is not */
  private audioDrySince = 0;

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
  get audioBlocked(): boolean {
    return this._audioBlocked;
  }
  get currentTime(): number {
    const us = this.clockRunning ? this.clock.currentMediaUs() : this.pendingSeekUs ?? this.lastRenderedUs;
    return Math.min(this.durationUs || Infinity, Math.max(0, us)) / 1e6;
  }
  get duration(): number {
    return this.durationUs / 1e6;
  }

  private wallClock(): WallClock {
    const c = new WallClock();
    c.setRate(this.rate);
    return c;
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
    this.live = !!src.live;
    if (src.startAt && src.startAt > 0) {
      // present from here: what the decoders produce before it (the fragment's lead-in) is dropped
      const startUs = Math.round(src.startAt * 1e6);
      this.pendingSeekUs = startUs;
      this.lastRenderedUs = startUs;
    }
    // Two files: configure once both have parsed their moov (or the sound file has failed).
    const split = Boolean(src.audioUrl);
    let videoReady: { durationSec: number; video?: TrackInfo; audio?: TrackInfo } | undefined;
    let audioReady: { audio?: TrackInfo } | undefined;
    let audioFailed = false;
    const maybeConfigure = () => {
      if (!videoReady || (split && !audioReady && !audioFailed)) return;
      const durationSec = videoReady.durationSec > 0 ? videoReady.durationSec : src.durationHint || 0;
      void this.configure(durationSec, videoReady.video, split ? audioReady?.audio : videoReady.audio);
    };
    const onAudioSamples = (samples: Sample[]) => {
      if (gen !== this.generation) return;
      this.audioSamples.push(...samples);
      this.applyBackpressure();
      this.pump();
    };
    this.demuxer = new Mp4Demuxer(src.url, src.fetchInit, {
      onReady: (info, video, audio) => {
        if (gen !== this.generation) return;
        videoReady = { durationSec: info.duration / info.timescale, video, audio };
        maybeConfigure();
      },
      onVideoSamples: (samples) => {
        if (gen !== this.generation) return;
        this.videoSamples.push(...samples);
        const last = samples[samples.length - 1];
        if (last && this.videoTrack) this.lastVideoSampleUs = this.toUs(last.cts, this.videoTrack);
        this.applyBackpressure();
        this.pump();
      },
      onAudioSamples: split ? () => undefined : onAudioSamples,
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
    }, src.blob, src.prefix);
    if (src.audioUrl) {
      this.audioDemuxer = new Mp4Demuxer(src.audioUrl, src.fetchInit, {
        onReady: (info, _video, audio) => {
          if (gen !== this.generation) return;
          this.events.onLog('info', `[demux audio] ${audio ? audio.codec : 'no audio track'}, ${(info.duration / info.timescale).toFixed(1)}s`);
          audioReady = { audio };
          maybeConfigure();
        },
        onVideoSamples: () => undefined,
        onAudioSamples,
        onProgress: () => undefined,
        onEnd: () => undefined,
        onError: (err) => {
          if (gen !== this.generation) return;
          // Sound is optional: the picture plays on a wall clock without it.
          this.events.onLog('warn', `[demux audio] ${err.message} - playing without sound`);
          audioFailed = true;
          this.audioDemuxer?.destroy();
          this.audioDemuxer = undefined;
          if (!this.videoDecoder) maybeConfigure();
          else this.disableAudio(`the sound file failed: ${err.message}`);
        },
        onLog: (msg) => this.events.onLog('info', `[demux audio] ${msg}`),
      }, undefined, src.audioPrefix);
      this.audioDemuxer.start();
    }
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
    this.nalLength = nalLengthSize(video.codec, video.videoConfig.description as BufferSource | undefined);
    this.events.onLog('info', `VideoDecoder configured: ${video.codec} ${w}x${h}, description ${video.videoConfig.description ? (video.videoConfig.description as Uint8Array).byteLength + ' bytes' : 'none'}`);

    if (audio?.audioConfig && typeof AudioDecoder !== 'undefined') {
      try {
        const as = await AudioDecoder.isConfigSupported(audio.audioConfig);
        if (gen !== this.generation) return;
        if (as.supported) {
          this.audio = new AudioSink(audio.audioConfig.sampleRate);
          this.audio.setVolume(this.volume);
          this.audio.setRate(this.rate);
          this.audio.onLateResume = () => {
            // the context took longer than start() waited (a slow device, not the autoplay policy): sound now, not at the next tap
            if (gen !== this.generation || !this._audioBlocked) return;
            this.events.onLog('info', 'AudioContext resumed late; handing it the clock');
            void this.unblockAudio();
          };
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
    if (!this.audioEnabled) this.clock = this.wallClock();
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
      error: (e) => this.disableAudio(`the audio decoder failed: ${e.message}`),
    });
    dec.configure(config);
    return dec;
  }

  /** Sound off for good (this load): the picture goes on against a wall clock, and the reason is said */
  private disableAudio(reason: string): void {
    const wasRunning = this.clockRunning;
    const nowUs = this.clock.currentMediaUs();
    this.events.onLog('error', `Sound off: ${reason}. The picture continues without it.`);
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
    this.clock = this.wallClock();
    this.st.audio = `off (${reason}) – wall clock`;
    if (wasRunning) void this.clock.start(nowUs);
  }

  /**
   * The sound watchdog, every frame step while playing with sound: a decoder that stopped
   * answering, timestamps that left the clock, or a context whose clock stands still although it
   * says it runs. The first two are undone by restarting the sound where the picture is; the third
   * (the output device gone: a car handing the speakers to something else) ends in a wall clock,
   * since a frozen master clock would freeze the picture too.
   */
  private audioWatch(nowPerf: number): void {
    const a = this.audio;
    const ad = this.audioDecoder;
    if (!a || !ad || !this.audioEnabled || this._audioBlocked || !this.clockRunning || !this.wantPlay || (this._state !== 'playing' && this._state !== 'buffering') || ad.state !== 'configured') {
      this.ctxFrozenSince = 0;
      this.audioDrySince = 0;
      return;
    }
    // suspended behind our back (the page was hidden, the device interrupted it): asked to run again
    if (this._state === 'playing' && a.contextState === 'suspended') void a.resume();
    const ct = a.ctx.currentTime;
    if (this._state === 'playing' && a.contextState === 'running' && ct === this.lastCtxTime) {
      if (!this.ctxFrozenSince) this.ctxFrozenSince = nowPerf;
      else if (nowPerf - this.ctxFrozenSince > AUDIO_FROZEN_MS) {
        this.disableAudio('the audio output stopped answering (did the device hand the speakers to something else?)');
        return;
      }
    } else this.ctxFrozenSince = 0;
    this.lastCtxTime = ct;

    // a stall is the timeline run dry (nothing left to play) while chunks are still with the
    // decoder; a decoder merely quiet while seconds of sound are still queued is left alone (a
    // restart drops what it holds: that is a gap, not a cure)
    const dry = a.playableUntilUs < this.clock.currentMediaUs() && this.audioPending();
    if (!dry) {
      this.audioDrySince = 0;
      if (a.lastScheduledAt > this.lastRecoveryAt) this.audioRecoveryStreak = 0;
      return;
    }
    if (!this.audioDrySince) this.audioDrySince = nowPerf;
    const idleMs = nowPerf - this.audioDrySince;
    if (idleMs < AUDIO_STALL_MS) return;
    this.audioDrySince = nowPerf;
    if (a.lastScheduledAt > this.lastRecoveryAt) this.audioRecoveryStreak = 0;
    const at = this.lastRenderedUs;
    const what = `decoder queue ${ad.decodeQueueSize}, ${this.audioSamples.length} chunks waiting, ${a.droppedChunks} dropped, context ${a.contextState}, clock ${(this.clock.currentMediaUs() / 1e6).toFixed(1)} s, picture ${(at / 1e6).toFixed(1)} s; video ${this.fps.value().toFixed(0)} fps, ${this.st.droppedFrames} frames dropped, decode queue ${this.videoDecoder?.decodeQueueSize ?? 0}, ${this.audioWaits} sound waits`;
    if (this.audioRecoveryStreak >= AUDIO_RECOVERY_LIMIT) {
      this.disableAudio(`the sound could not be restarted (${what})`);
      return;
    }
    this.audioRecoveries++;
    this.audioRecoveryStreak++;
    this.lastRecoveryAt = nowPerf;
    this.st.extra['Audio restarts'] = String(this.audioRecoveries);
    this.events.onLog('warn', `Sound stopped for ${(idleMs / 1000).toFixed(1)} s (${what}); restarting it where the picture is`);
    try {
      ad.reset();
      ad.configure(this.audioTrack!.audioConfig!);
    } catch (e) {
      this.disableAudio(`the audio decoder would not restart: ${(e as Error).message}`);
      return;
    }
    this.rebase(at);
    this.pump();
  }

  /** The clock restarts at `atUs` (a live stream's timestamps moved, or the sound is restarted where the picture is) */
  private rebase(atUs: number): void {
    this.audio?.reset();
    void this.clock.start(atUs);
  }

  private applyBackpressure(): void {
    if (!this.demuxer) return;
    const videoFull = this.videoSamples.length > MAX_QUEUED_VIDEO_SAMPLES;
    const audioFull = this.audioSamples.length > MAX_QUEUED_AUDIO_SAMPLES;
    const videoLow = this.videoSamples.length < MAX_QUEUED_VIDEO_SAMPLES / 2;
    const audioLow = this.audioSamples.length < MAX_QUEUED_AUDIO_SAMPLES / 2;
    if (this.audioDemuxer) {
      // Each file is throttled by its own queue.
      if (videoFull) this.demuxer.pause();
      else if (videoLow) this.demuxer.resume();
      if (audioFull) this.audioDemuxer.pause();
      else if (audioLow) this.audioDemuxer.resume();
      return;
    }
    if (videoFull || audioFull) this.demuxer.pause();
    else if (videoLow && audioLow) this.demuxer.resume();
  }

  /** Feed the decoders while their queues are short. */
  private pump(): void {
    const vd = this.videoDecoder;
    const vt = this.videoTrack;
    if (!vd || !vt || vd.state !== 'configured') return;
    while (this.frames.length + vd.decodeQueueSize < TARGET_DECODED_FRAMES && vd.decodeQueueSize < MAX_DECODE_QUEUE && this.videoSamples.length) {
      const s = this.videoSamples.shift()!;
      // The file's sync flag is not enough: some live streams (open GOP, recovery-point SEI) flag
      // frames as sync that hold no IDR picture, and the decoder refuses such a chunk marked `key`
      // ("was marked as type key but wasn't a key frame"). Only a real one counts.
      let key = s.is_sync;
      if (key && !isKeyFrame(s.data!, vt.codec, this.nalLength)) {
        key = false;
        this.st.extra['Fake key frames'] = String(++this.fakeKeyFrames);
        if (!this.fakeKeyWarned) {
          this.fakeKeyWarned = true;
          this.events.onLog('warn', 'the stream flags frames as key frames that are not (open GOP); waiting for a real one');
        }
      }
      if (this.needKey && !key) continue;
      this.needKey = false;
      try {
        vd.decode(
          new EncodedVideoChunk({
            type: key ? 'key' : 'delta',
            timestamp: this.toUs(s.cts, vt),
            duration: Math.round((s.duration * 1e6) / vt.timescale),
            data: s.data!,
          }),
        );
      } catch (e) {
        const msg = (e as Error).message;
        if (/key ?frame/i.test(msg) && this.recoverDecoder(msg)) return;
        this.fail(new Error(`decode() threw: ${msg}`));
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
      while (this.audioSamples.length && ad.decodeQueueSize < 32 && this.audio.scheduledUntilUs < horizon) {
        const s = this.audioSamples.shift()!;
        const ts = this.toUs(s.cts, at);
        try {
          ad.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, duration: Math.round((s.duration * 1e6) / at.timescale), data: s.data! }));
          this.lastAudioSubmitAt = performance.now();
        } catch (e) {
          this.disableAudio(`audio decode() threw: ${(e as Error).message}`);
          break;
        }
        // scheduledUntilUs only advances on output; use the chunk's own end time to bound the loop
        if (!this.audio.scheduledUntilUs || this.audio.scheduledUntilUs < ts) this.audio.scheduledUntilUs = ts;
        if (s.number - this.lastReleasedAudioSample > 200) {
          (this.audioDemuxer || this.demuxer)?.releaseSamples(at.id, s.number);
          this.lastReleasedAudioSample = s.number;
        }
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
    if (this._audioBlocked && this.clockRunning) await this.unblockAudio();
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
    this.audioDemuxer?.seek(seconds);
    this.st.extra['Last seek'] = `${seconds.toFixed(2)}s → RAP ${rap.toFixed(2)}s`;
    this.wantPlay = wasPlaying;
    this.setState(wasPlaying ? 'buffering' : 'paused');
  }

  setVolume(v: number): void {
    this.volume = v;
    this.audio?.setVolume(v);
  }

  /** The speed, kept for the next load too; the running clock changes pace in place (no seek, no gap). */
  setRate(rate: number): void {
    if (!(rate > 0) || rate === this.rate) return;
    this.rate = rate;
    this.clock.setRate(rate);
    if (this.audio && this.clock !== this.audio) this.audio.setRate(rate);
  }

  /** A touch or key from the viewer: sound that the autoplay policy held back may start now. */
  userGesture(): void {
    if (this._audioBlocked && this.clockRunning) void this.unblockAudio();
  }

  /** Picture file plus the separate sound file when there is one (YouTube); the sound counts once its size is known. */
  recording(): { video?: MediaRecording; audio?: MediaRecording } {
    return { video: this.demuxer?.recording(), audio: this.audioDemuxer?.recording() };
  }

  download(): DownloadProgress {
    const v = this.demuxer?.stats;
    if (!v) return { loaded: 0, total: 0, fraction: -1 };
    const a = this.audioDemuxer?.stats;
    const withAudio = !!a && a.totalBytes > 0;
    const loaded = v.downloadedTo + (withAudio ? a.downloadedTo : 0);
    const total = v.totalBytes ? v.totalBytes + (withAudio ? a.totalBytes : 0) : 0;
    return { loaded, total, fraction: total ? Math.min(1, loaded / total) : -1 };
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
    if (this.audioDemuxer) {
      const a = this.audioDemuxer.stats;
      this.st.extra['Audio file'] = `${a.bytesLoaded}/${a.totalBytes || '?'} bytes, HTTP ${a.httpStatus}`;
    }
    if (this.audio) {
      this.st.extra['Audio context'] = `${this.audio.contextState}, ${this.audio.ctx.sampleRate} Hz`;
      this.st.extra['Audio chunks'] = `${this.audio.scheduledChunks} scheduled, ${this.audio.droppedChunks} dropped${this.audio.lastError ? ', err: ' + this.audio.lastError : ''}`;
      this.st.extra['Audio ahead'] = `${Math.max(0, (this.audio.playableUntilUs - (this.clockRunning ? this.clock.currentMediaUs() : this.lastRenderedUs)) / 1e6).toFixed(1)} s on the timeline`;
      this.st.extra['Audio starts at'] = this.audio.firstScheduledUs < 0 ? 'not yet' : `${(this.audio.firstScheduledUs / 1e6).toFixed(3)}s`;
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
    this.audioDemuxer?.destroy();
    this.audioDemuxer = undefined;
    this.lastReleasedAudioSample = 0;
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
    this.clock = this.wallClock();
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
    this.live = false;
    this.lastCtxTime = -1;
    this.ctxFrozenSince = 0;
    this.audioRecoveries = 0;
    this.audioRecoveryStreak = 0;
    this.lastRecoveryAt = 0;
    this.audioDrySince = 0;
    this.audioWaits = 0;
    this.lastAudioSubmitAt = 0;
    this.fps.reset();
    this.videoTrack = undefined;
    this.audioTrack = undefined;
  }

  /**
   * The video decoder refused a chunk (a key frame it did not accept as one): restarted at once
   * and fed from the next real key frame, the picture pausing for a moment instead of the stream
   * failing. Three restarts within a minute are a stream this browser cannot play: false.
   */
  private recoverDecoder(why: string): boolean {
    const vd = this.videoDecoder;
    const cfg = this.videoTrack?.videoConfig;
    const now = performance.now();
    this.decoderRestarts = this.decoderRestarts.filter((t) => now - t < 60_000);
    if (!vd || !cfg || this.decoderRestarts.length >= 3) return false;
    this.decoderRestarts.push(now);
    this.st.extra['Decoder restarts'] = String(this.decoderRestarts.length);
    try {
      vd.reset();
      vd.configure(cfg);
    } catch (e) {
      this.events.onLog('warn', `the video decoder would not restart: ${(e as Error).message}`);
      return false;
    }
    this.needKey = true;
    this.events.onLog('warn', `the video decoder refused a chunk (${why}); restarted, continuing from the next key frame`);
    window.setTimeout(() => this.pump(), 0);
    return true;
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
      if (this.audio && !this._audioBlocked) {
        const ok = await this.audio.start(atUs);
        if (!ok) {
          this._audioBlocked = true;
          this.clock = this.wallClock();
          this.st.audio += ' – blocked by autoplay policy, press Play to enable';
          this.events.onLog('warn', 'AudioContext could not be resumed (no user gesture yet); video runs on a wall clock until Play is pressed');
        }
      }
      this.clockRunning = true;
      if (!this.audio || this._audioBlocked) await this.clock.start(atUs);
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
  private unblocking = false;
  private async unblockAudio(): Promise<void> {
    if (!this.audio || !this._audioBlocked || this.unblocking) return;
    this.unblocking = true;
    const gen = this.generation;
    const audio = this.audio;
    let ok = false;
    try {
      ok = await audio.start(this.clock.currentMediaUs(), 1500);
    } finally {
      this.unblocking = false;
    }
    if (!ok || gen !== this.generation || this.audio !== audio) return;
    this._audioBlocked = false;
    this.clock = this.audio;
    // paused meanwhile (a tap while the sound was starting): the audio clock must not run on alone
    if (!this.wantPlay || !this.clockRunning) void audio.pause();
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
    let now = this.clock.currentMediaUs();
    if (this.live && this.frames.length && this.wantPlay) {
      const oldest = this.frames[0].timestamp;
      const newest = this.frames[this.frames.length - 1].timestamp;
      if (oldest > now + LIVE_JUMP_US) {
        // the timestamps jumped ahead (a segment dropped out of the server's window while paused, or
        // the upstream restarted): a finite file would wait here for the clock; a live stream moves on
        this.events.onLog('info', `live stream jumped from ${(now / 1e6).toFixed(1)}s to ${(oldest / 1e6).toFixed(1)}s; following it`);
        this.rebase(oldest);
        now = oldest;
      } else if (newest < now - LIVE_JUMP_US) {
        // the timestamps fell behind the clock (they jumped back at an ad break the recorder
        // stitched, or this device decodes slower than the clock runs): dropping every late frame
        // and every late chunk of sound for good is what used to happen - silent picture, forever
        this.events.onLog('warn', `live stream fell ${((now - newest) / 1e6).toFixed(1)} s behind the clock (timestamps ${(oldest / 1e6).toFixed(1)}s); following it`);
        this.rebase(oldest);
        now = oldest;
      }
    }
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
      if (this._state === 'buffering' && this.wantPlay && this.audioReady(now)) {
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
    if (this._state === 'playing' && this.wantPlay && this.audioStarved(now)) {
      // the sound decoder is behind (the device is busy with the picture): wait for it, as for
      // frames, instead of letting its late chunks fall behind the clock and be dropped
      this.st.extra['Audio waits'] = String(++this.audioWaits);
      this.events.onLog('info', `sound ran dry at ${(now / 1e6).toFixed(1)} s (decoder queue ${this.audioDecoder?.decodeQueueSize}, ${this.audioSamples.length} chunks waiting); waiting for the decoder`);
      this.setState('buffering');
      void this.clock.pause();
      this.pump();
    }
    if (this._state === 'buffering' && this.wantPlay && this.frames.length >= MIN_START_FRAMES && this.audioReady(now)) {
      void this.clock.resume().then(() => this.setState('playing'));
    }
    this.audioWatch(performance.now());
  }

  private audioWaits = 0;
  /** performance.now() of the last chunk handed to the sound decoder: sound is still expected for a while after it */
  private lastAudioSubmitAt = 0;
  /** Sound still to come: chunks queued, with the decoder, or handed to it a moment ago (its answer can lag by seconds) */
  private audioPending(): boolean {
    return this.audioSamples.length > 0 || (this.audioDecoder?.decodeQueueSize || 0) > 0 || performance.now() - this.lastAudioSubmitAt < 8000;
  }
  /** The sound drives the clock and what is on its timeline is about to run out, with more still to come from the decoder */
  private audioStarved(nowUs: number): boolean {
    const a = this.audio;
    const ad = this.audioDecoder;
    if (!a || !ad || !this.audioEnabled || this._audioBlocked || this.clock !== a) return false;
    if (a.playableUntilUs >= nowUs + AUDIO_LOW_US) return false;
    return this.audioPending();
  }
  /** Enough sound on the timeline to resume (always, without sound as the clock) */
  private audioReady(nowUs: number): boolean {
    const a = this.audio;
    if (!a || !this.audioEnabled || this._audioBlocked || this.clock !== a) return true;
    if (a.playableUntilUs >= nowUs + AUDIO_RESUME_US) return true;
    // nothing more coming for the sound (the demuxer is quiet): do not wait on it
    return !this.audioPending();
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

/** NAL length prefix size from an avcC / hvcC description (4 when there is none or it cannot be read) */
export function nalLengthSize(codec: string, description: BufferSource | undefined): number {
  if (!description) return 4;
  const b = description instanceof ArrayBuffer ? new Uint8Array(description) : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  if (/^(avc|avc1|avc3)/i.test(codec) && b.length > 4) return (b[4] & 3) + 1;
  if (/^(hev1|hvc1)/i.test(codec) && b.length > 21) return (b[21] & 3) + 1;
  return 4;
}

/**
 * Whether a length-prefixed (AVCC / HVCC) sample holds a real random access picture: an IDR slice
 * (H.264 NAL type 5) or an IRAP picture (H.265 NAL types 16-21). A sample that cannot be walked is
 * taken as the file says.
 */
export function isKeyFrame(data: Uint8Array | ArrayBuffer, codec: string, nalLength: number): boolean {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  const h265 = /^(hev1|hvc1)/i.test(codec);
  if (!h265 && !/^(avc|avc1|avc3)/i.test(codec)) return true;
  let i = 0;
  let sawSlice = false;
  while (i + nalLength <= b.length) {
    let len = 0;
    for (let k = 0; k < nalLength; k++) len = (len << 8) | b[i + k];
    i += nalLength;
    if (len <= 0 || i + len > b.length) return !sawSlice; // not walkable: trust the file
    const t = h265 ? (b[i] >> 1) & 0x3f : b[i] & 0x1f;
    if (h265 ? t >= 16 && t <= 21 : t === 5) return true;
    if (h265 ? t <= 9 : t === 1) sawSlice = true;
    i += len;
  }
  return !sawSlice; // no picture at all (metadata only): leave the flag alone
}
