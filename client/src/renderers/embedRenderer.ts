/**
 * Mode C: TikTok's official embedded player (iframe) for comparison only.
 * Nothing in this mode touches raw media bytes: the iframe is opaque to the page.
 * Uses the Embed Player v1 endpoint (https://www.tiktok.com/player/v1/<id>) which supports
 * postMessage control; the legacy /embed/v2/<id> is used as a fallback.
 */
import { emptyStats, type LoadSource, type PlayerState, type PlayerStats, type Renderer, type RendererEvents } from './types';

export class EmbedRenderer implements Renderer {
  readonly name = 'TikTok official iframe';
  private iframe?: HTMLIFrameElement;
  private _state: PlayerState = 'idle';
  private st: PlayerStats = emptyStats(this.name);
  private loadedAt = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: RendererEvents,
  ) {}

  get state(): PlayerState {
    return this._state;
  }
  get currentTime(): number {
    return 0;
  }
  get duration(): number {
    return 0;
  }
  private setState(s: PlayerState): void {
    this._state = s;
    this.st.state = s;
    this.events.onStateChange(s);
  }

  async load(src: LoadSource): Promise<void> {
    this.destroy();
    this.st = emptyStats(this.name);
    this.st.connection = 'embed';
    this.st.source = src.label;
    this.st.audio = 'inside iframe (opaque)';
    this.st.videoCodec = 'unknown (opaque iframe)';
    this.st.resolution = 'unknown (opaque iframe)';
    this.st.cors = 'n/a – no media bytes reach this page';
    if (!src.videoId) {
      this.setState('error');
      this.events.onError(new Error('Embed mode needs a TikTok video id (load a TikTok URL first)'));
      return;
    }
    this.setState('loading');
    const iframe = document.createElement('iframe');
    iframe.className = 'embed-frame';
    iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = `https://www.tiktok.com/player/v1/${encodeURIComponent(src.videoId)}?controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=1&loop=0&autoplay=0&music_info=0&description=0&rel=0`;
    const t0 = performance.now();
    iframe.addEventListener('load', () => {
      this.loadedAt = performance.now() - t0;
      this.st.extra['iframe load event'] = `${this.loadedAt.toFixed(0)} ms (fires for cross-origin documents regardless of content)`;
      this.setState('ready');
      this.events.onFirstFrame();
      this.events.onLog('info', `TikTok player iframe loaded in ${this.loadedAt.toFixed(0)} ms – contents are cross-origin and inaccessible to JavaScript`);
    });
    iframe.addEventListener('error', () => {
      this.setState('error');
      this.events.onError(new Error('iframe error event'));
    });
    this.host.appendChild(iframe);
    this.iframe = iframe;
    // Player v1 postMessage API: listen for state messages (best effort, undocumented fields are ignored)
    window.addEventListener('message', this.onMessage);
  }

  private onMessage = (ev: MessageEvent) => {
    if (ev.origin !== 'https://www.tiktok.com' || !this.iframe || ev.source !== this.iframe.contentWindow) return;
    const data = ev.data as { type?: string; value?: unknown };
    if (data && typeof data.type === 'string') {
      this.st.extra['Last player message'] = `${data.type}${data.value !== undefined ? ': ' + JSON.stringify(data.value).slice(0, 60) : ''}`;
      if (data.type === 'onStateChange') {
        const v = Number(data.value);
        if (v === 0) this.setState('playing');
        else if (v === 1) this.setState('paused');
        else if (v === 2) this.setState('ended');
      }
    }
  };

  private post(type: string, value?: unknown): void {
    this.iframe?.contentWindow?.postMessage({ type, value, 'x-tiktok-player': true }, 'https://www.tiktok.com');
  }

  async play(): Promise<void> {
    this.post('play');
  }
  pause(): void {
    this.post('pause');
  }
  seek(seconds: number): void {
    this.post('seekTo', seconds);
  }
  setVolume(v: number): void {
    this.post('mute', v === 0);
  }
  stats(): PlayerStats {
    return this.st;
  }
  destroy(): void {
    window.removeEventListener('message', this.onMessage);
    this.iframe?.remove();
    this.iframe = undefined;
  }
}
