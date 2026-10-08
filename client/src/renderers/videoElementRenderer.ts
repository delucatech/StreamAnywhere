/**
 * Mode A: hidden <video> element decodes; frames are copied into the canvas with
 * requestVideoFrameCallback (falls back to requestAnimationFrame).
 *
 * The element is created with crossOrigin="anonymous" first so the canvas stays untainted and
 * the test mirrors fetch() CORS rules. If that fails for a cross-origin URL, a second attempt
 * without the attribute is made (browser "no-cors" media load): playback may work, but the
 * canvas becomes tainted (getImageData is blocked) – which the stats report explicitly.
 */
import { emptyStats, FpsCounter, type LoadSource, type PlayerState, type PlayerStats, type Renderer, type RendererEvents } from './types';

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { presentedFrames: number; mediaTime: number; width: number; height: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export class VideoElementRenderer implements Renderer {
  readonly name = 'HTML5 <video> → Canvas';
  private ctx2d: CanvasRenderingContext2D;
  private video: VideoWithRvfc;
  private _state: PlayerState = 'idle';
  private st: PlayerStats = emptyStats(this.name);
  private fps = new FpsCounter();
  private rvfcId = 0;
  private rafId = 0;
  private tainted = false;
  private firstFrameSent = false;
  private useRvfc = false;
  private generation = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    host: HTMLElement,
    private readonly events: RendererEvents,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx2d = ctx;
    this.video = document.createElement('video') as VideoWithRvfc;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.muted = false;
    this.video.className = 'hidden-video';
    this.video.setAttribute('aria-hidden', 'true');
    host.appendChild(this.video);
    this.useRvfc = typeof this.video.requestVideoFrameCallback === 'function';
  }

  get state(): PlayerState {
    return this._state;
  }
  get currentTime(): number {
    return this.video.currentTime || 0;
  }
  get duration(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  private setState(s: PlayerState): void {
    if (this._state === s) return;
    this._state = s;
    this.st.state = s;
    this.events.onStateChange(s);
  }

  async load(src: LoadSource): Promise<void> {
    const gen = ++this.generation;
    this.stopLoops();
    this.firstFrameSent = false;
    this.tainted = false;
    this.fps.reset();
    this.st = emptyStats(this.name);
    this.st.connection = src.connection;
    this.st.source = src.label;
    this.st.audio = 'native <video> element';
    this.st.videoCodec = 'not exposed by <video>';
    this.st.cors = src.corsResult === 'passed' ? 'Passed' : src.corsResult === 'failed' ? 'Failed' : src.corsResult === 'same-origin' ? 'Same-origin (n/a)' : 'Not tested';
    this.st.extra['Frame callback'] = this.useRvfc ? 'requestVideoFrameCallback' : 'requestAnimationFrame (rVFC unavailable)';
    this.setState('loading');
    const sameOrigin = src.url.startsWith('blob:') || new URL(src.url, location.href).origin === location.origin;
    let ok = await this.attemptLoad(src.url, sameOrigin ? null : 'anonymous', gen);
    if (!ok && !sameOrigin && gen === this.generation) {
      this.events.onLog('warn', 'crossOrigin="anonymous" load failed; retrying without CORS (canvas will be tainted if it loads)');
      ok = await this.attemptLoad(src.url, null, gen);
      if (ok) this.tainted = true;
    }
    if (gen !== this.generation) return;
    if (!ok) {
      const err = this.video.error;
      const msg = err ? `MediaError code ${err.code}${err.message ? ': ' + err.message : ''}` : 'unknown media error';
      this.events.onLog('error', `<video> failed to load: ${msg}`);
      this.setState('error');
      this.events.onError(new Error(msg));
      return;
    }
    this.st.extra['crossOrigin attr'] = this.video.crossOrigin ?? 'none';
    this.st.extra['Canvas tainted'] = this.tainted ? 'yes (cross-origin media without CORS)' : 'no';
    this.st.resolution = `${this.video.videoWidth} × ${this.video.videoHeight}`;
    this.st.duration = this.duration;
    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
    this.setState('ready');
    this.startLoops();
  }

  private attemptLoad(url: string, crossOrigin: string | null, gen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const v = this.video;
      const cleanup = () => {
        v.removeEventListener('loadeddata', onOk);
        v.removeEventListener('error', onErr);
        clearTimeout(timer);
      };
      const onOk = () => {
        cleanup();
        resolve(gen === this.generation);
      };
      const onErr = () => {
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(() => {
        cleanup();
        this.events.onLog('warn', 'video load timed out after 20s');
        resolve(false);
      }, 20_000);
      v.addEventListener('loadeddata', onOk);
      v.addEventListener('error', onErr);
      v.pause();
      v.removeAttribute('src');
      if (crossOrigin) v.crossOrigin = crossOrigin;
      else v.removeAttribute('crossorigin');
      v.src = url;
      v.load();
    });
  }

  private startLoops(): void {
    const v = this.video;
    v.onplaying = () => this.setState('playing');
    v.onpause = () => {
      if (!v.ended) this.setState('paused');
    };
    v.onwaiting = () => this.setState('buffering');
    v.onended = () => this.setState('ended');
    v.onerror = () => {
      this.setState('error');
      this.events.onError(new Error(`MediaError code ${v.error?.code}`));
    };
    if (this.useRvfc) {
      const cb = () => {
        this.draw();
        this.rvfcId = v.requestVideoFrameCallback!(cb);
      };
      this.rvfcId = v.requestVideoFrameCallback!(cb);
      // Also paint the poster frame while paused
      this.draw();
    } else {
      let lastTime = -1;
      const tick = () => {
        this.rafId = requestAnimationFrame(tick);
        if (v.currentTime !== lastTime) {
          lastTime = v.currentTime;
          this.draw();
        }
      };
      this.rafId = requestAnimationFrame(tick);
    }
  }

  private draw(): void {
    const v = this.video;
    if (!v.videoWidth) return;
    try {
      this.ctx2d.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
    } catch (e) {
      this.events.onLog('error', `drawImage failed: ${(e as Error).message}`);
      return;
    }
    this.st.renderedFrames++;
    this.fps.tick();
    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      // Taint check: reading pixels throws SecurityError on a tainted canvas.
      try {
        this.ctx2d.getImageData(0, 0, 1, 1);
        this.st.extra['getImageData'] = 'allowed';
      } catch {
        this.st.extra['getImageData'] = 'blocked (SecurityError: tainted canvas)';
        this.tainted = true;
        this.st.extra['Canvas tainted'] = 'yes';
      }
      this.events.onFirstFrame();
    }
  }

  private stopLoops(): void {
    if (this.rvfcId && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.rvfcId);
    cancelAnimationFrame(this.rafId);
    this.rvfcId = 0;
    this.rafId = 0;
  }

  async play(): Promise<void> {
    try {
      await this.video.play();
    } catch (e) {
      this.events.onLog('error', `play() rejected: ${(e as Error).message}`);
    }
  }
  pause(): void {
    this.video.pause();
  }
  seek(seconds: number): void {
    this.video.currentTime = seconds;
  }
  setVolume(v: number): void {
    this.video.volume = v;
  }

  stats(): PlayerStats {
    const v = this.video;
    this.st.fps = this.fps.value();
    this.st.currentTime = this.currentTime;
    this.st.duration = this.duration;
    const q = v.getVideoPlaybackQuality?.();
    if (q) {
      this.st.decodedFrames = q.totalVideoFrames;
      this.st.droppedFrames = q.droppedVideoFrames;
    }
    const buffered = v.buffered;
    let ahead = 0;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= v.currentTime && buffered.end(i) >= v.currentTime) ahead = buffered.end(i) - v.currentTime;
    }
    this.st.bufferedAheadSec = ahead;
    this.st.extra['readyState'] = String(v.readyState);
    this.st.extra['networkState'] = String(v.networkState);
    return this.st;
  }

  destroy(): void {
    this.generation++;
    this.stopLoops();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}
