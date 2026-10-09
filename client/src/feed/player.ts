/**
 * Per-item canvas player for the feed.
 *
 * Wraps one of the lab renderers around the item's <canvas>, so the feed never shows a <video>:
 *  - 'webcodecs'    fetch → mp4box demux → VideoDecoder/AudioDecoder → canvas 2D + Web Audio.
 *                   No media element exists at all (the Tesla / "web page graphics" path).
 *  - 'video-canvas' only when WebCodecs is missing: a hidden, detached-looking <video> decodes and
 *                   every frame is copied into the canvas. Still canvas-only on screen.
 *
 * Adds what the feed needs on top of the Renderer interface: loop, a time ticker for the progress
 * bar, "paused" bookkeeping and a muted flag (volume 0/1).
 */
import type { LoadSource, PlayerState, Renderer, RendererEvents } from '../renderers/types';
import { VideoElementRenderer } from '../renderers/videoElementRenderer';
import { WebCodecsRenderer, webCodecsSupported } from '../renderers/webcodecsRenderer';

export type FeedPlayerMode = 'webcodecs' | 'video-canvas';

export function feedPlayerMode(): { mode: FeedPlayerMode; reason?: string } {
  const s = webCodecsSupported();
  return s.ok ? { mode: 'webcodecs' } : { mode: 'video-canvas', reason: s.reason };
}

export interface FeedPlayerEvents {
  /** The first frame of the current source has been painted */
  onFirstFrame(): void;
  /** Playback reached the end and loop is off */
  onEnded(): void;
  onError(err: Error): void;
  /** Frames are being presented (true) or not (false) */
  onPlayingChange(playing: boolean): void;
  /** Progress tick (about 4×/s while a source is loaded) */
  onTime(currentTime: number, duration: number): void;
}

const TICK_MS = 250;

export class FeedPlayer {
  readonly mode: FeedPlayerMode;
  readonly rendererName: string;
  private renderer: Renderer;
  private ticker = 0;
  private wantPlay = false;
  private muted = false;
  private destroyed = false;
  /** Loop the current source instead of reporting onEnded */
  loop = false;
  /** URL currently loaded (set by load) */
  url?: string;

  constructor(
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    private readonly events: FeedPlayerEvents,
    mode: FeedPlayerMode = feedPlayerMode().mode,
  ) {
    this.mode = mode;
    const rendererEvents: RendererEvents = {
      onStateChange: (s) => this.onState(s),
      onLog: (level, msg) => {
        if (level === 'error') console.warn(`[feed player] ${msg}`);
        else console.debug(`[feed player] ${msg}`);
      },
      onFirstFrame: () => {
        if (!this.destroyed) this.events.onFirstFrame();
      },
      onError: (err) => {
        if (this.destroyed) return;
        this.wantPlay = false;
        this.events.onPlayingChange(false);
        this.events.onError(err);
      },
    };
    this.renderer = mode === 'webcodecs' ? new WebCodecsRenderer(canvas, rendererEvents) : new VideoElementRenderer(canvas, host, rendererEvents);
    this.rendererName = this.renderer.name;
  }

  get paused(): boolean {
    return !this.wantPlay;
  }
  get currentTime(): number {
    return this.renderer.currentTime;
  }
  get duration(): number {
    return this.renderer.duration;
  }
  get state(): PlayerState {
    return this.renderer.state;
  }

  private onState(s: PlayerState): void {
    if (this.destroyed) return;
    if (s === 'playing') this.events.onPlayingChange(true);
    else if (s === 'paused' || s === 'error') this.events.onPlayingChange(false);
    else if (s === 'ended') {
      if (this.loop && this.wantPlay) {
        // Renderer.play() restarts from 0 when the state is 'ended'.
        void this.renderer.play();
        return;
      }
      this.wantPlay = false;
      this.events.onPlayingChange(false);
      this.events.onEnded();
    }
  }

  /** Starts fetching/decoding `url`; resolves when the renderer accepted it (frames arrive later). */
  async load(url: string, connection: 'direct' | 'proxy', label: string): Promise<void> {
    if (this.destroyed) return;
    this.url = url;
    this.wantPlay = false;
    const src: LoadSource = {
      url,
      label,
      connection,
      sourceKind: 'tiktok',
      fetchInit: { mode: 'cors', credentials: 'same-origin' },
      corsResult: 'not-tested',
    };
    this.renderer.setVolume(this.muted ? 0 : 1);
    this.startTicker();
    await this.renderer.load(src);
  }

  async play(): Promise<void> {
    if (this.destroyed || !this.url) return;
    this.wantPlay = true;
    await this.renderer.play();
  }

  pause(): void {
    if (this.destroyed) return;
    this.wantPlay = false;
    this.renderer.pause();
    this.events.onPlayingChange(false);
  }

  seek(seconds: number): void {
    if (this.destroyed || !this.url) return;
    this.renderer.seek(Math.max(0, seconds));
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.renderer.setVolume(m ? 0 : 1);
  }

  private startTicker(): void {
    clearInterval(this.ticker);
    this.ticker = window.setInterval(() => {
      if (this.destroyed) return;
      const d = this.renderer.duration;
      if (d > 0) this.events.onTime(this.renderer.currentTime, d);
    }, TICK_MS);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.wantPlay = false;
    clearInterval(this.ticker);
    this.ticker = 0;
    try {
      this.renderer.destroy();
    } catch (e) {
      console.warn('[feed player] destroy failed', e);
    }
  }
}
