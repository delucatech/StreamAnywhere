import type { SourceKind } from '../../../shared/types';

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
  /** Result of the browser-side CORS probe that selected this URL */
  corsResult?: 'passed' | 'failed' | 'not-tested' | 'same-origin';
  corsDetail?: string;
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

export interface Renderer {
  readonly name: string;
  load(src: LoadSource): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(v: number): void;
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
