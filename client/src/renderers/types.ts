import type { SourceKind } from '../../../shared/types';
import type { MediaPrefix, MediaRecording } from '../media/demuxer';

export type ConnectionKind = 'direct' | 'proxy' | 'test' | 'local' | 'embed';

export interface LoadSource {
  /** URL to fetch / assign to the renderer */
  url: string;
  /** fetch() options used by the WebCodecs path (mode/credentials) */
  fetchInit?: RequestInit;
  /** Human label shown in diagnostics */
  label: string;
  connection: ConnectionKind;
  sourceKind: SourceKind | 'local';
  /** TikTok video id (embed mode) */
  videoId?: string;
  mediaId?: string;
  /**
   * Second file carrying the sound (YouTube hands out picture and sound separately). The WebCodecs
   * renderer demuxes it alongside `url`; the <video> fallback cannot and plays silently.
   */
  audioUrl?: string;
  /** Duration in seconds when the container does not say (fragmented files may report 0) */
  durationHint?: number;
  /** Result of the browser-side CORS probe that selected this URL */
  corsResult?: 'passed' | 'failed' | 'not-tested' | 'same-origin';
  corsDetail?: string;
  /**
   * A video file stored in this browser (the Video Library's downloads, IndexedDB): the demuxer
   * reads it with Blob.slice() instead of fetch(), everything after that is the same pipeline.
   * `url` may then be empty (the <video> fallback makes its own object URL).
   */
  blob?: Blob;
  /**
   * The head of the file (or all of it) from the feed's media cache: played from disk first, the
   * rest downloaded from `url`. `audioPrefix` is the same for the separate sound file (`audioUrl`).
   */
  prefix?: MediaPrefix;
  audioPrefix?: MediaPrefix;
  /**
   * An endless stream (Live TV: the server's recording as one fragmented MP4 that keeps growing):
   * no duration, no seeking inside the file (the player reloads from another point instead), the
   * clock follows a jump in the timestamps, and the stream ending means the channel stopped.
   */
  live?: boolean;
  /** Start presenting at this media time (seconds): frames before it are decoded and dropped */
  startAt?: number;
}

export type PlayerState = 'idle' | 'loading' | 'ready' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerStats {
  renderer: string;
  state: PlayerState;
  connection: ConnectionKind | '-';
  source: string;
  resolution: string;
  videoCodec: string;
  audio: string;
  fps: number;
  decodedFrames: number;
  renderedFrames: number;
  droppedFrames: number;
  decodeQueue: number;
  framesBuffered: number;
  /** Seconds of media demuxed/decoded beyond the playhead */
  bufferedAheadSec: number;
  bytesLoaded: number;
  totalBytes: number;
  cors: string;
  currentTime: number;
  duration: number;
  extra: Record<string, string>;
}

export interface RendererEvents {
  onStateChange(state: PlayerState): void;
  onLog(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Fires once the first frame has been painted */
  onFirstFrame(): void;
  onError(err: Error): void;
}

/** How much of the media has been downloaded (the feed's loading text and buffer bar). */
export interface DownloadProgress {
  /** Bytes received so far (0 when the renderer cannot tell, e.g. a <video> element) */
  loaded: number;
  /** File size in bytes; 0 when not known (yet) */
  total: number;
  /** 0..1, or -1 when unknown */
  fraction: number;
}

export interface Renderer {
  readonly name: string;
  /** Cheap enough to call several times a second (unlike stats()) */
  download?(): DownloadProgress;
  /** What the renderer has of the file(s) from byte 0, for the feed's media cache (WebCodecs only) */
  recording?(): { video?: MediaRecording; audio?: MediaRecording };
  load(src: LoadSource): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(v: number): void;
  /** Playback speed, media seconds per real second (1 = normal); kept across loads */
  setRate?(rate: number): void;
  /** True while the sound could not start for want of a user gesture (the picture runs on its own clock) */
  readonly audioBlocked?: boolean;
  /** The viewer has touched the page: a renderer whose sound was blocked may start it now */
  userGesture?(): void;
  readonly currentTime: number;
  readonly duration: number;
  readonly state: PlayerState;
  stats(): PlayerStats;
  destroy(): void;
}

export function emptyStats(renderer: string): PlayerStats {
  return {
    renderer,
    state: 'idle',
    connection: '-',
    source: '-',
    resolution: '-',
    videoCodec: '-',
    audio: '-',
    fps: 0,
    decodedFrames: 0,
    renderedFrames: 0,
    droppedFrames: 0,
    decodeQueue: 0,
    framesBuffered: 0,
    bufferedAheadSec: 0,
    bytesLoaded: 0,
    totalBytes: 0,
    cors: '-',
    currentTime: 0,
    duration: 0,
    extra: {},
  };
}

/** Sliding one-second frame counter */
export class FpsCounter {
  private times: number[] = [];
  tick(now = performance.now()): void {
    this.times.push(now);
    const cutoff = now - 1000;
    while (this.times.length && this.times[0] < cutoff) this.times.shift();
  }
  value(now = performance.now()): number {
    const cutoff = now - 1000;
    while (this.times.length && this.times[0] < cutoff) this.times.shift();
    return this.times.length;
  }
  reset(): void {
    this.times = [];
  }
}
