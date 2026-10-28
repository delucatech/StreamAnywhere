/**
 * The Live TV player: a full-screen theater around a <video>. HLS plays through hls.js (Media
 * Source Extensions: Chromium, the Tesla browser, Firefox, desktop Safari) or natively where only
 * that exists (iPhone Safari); a progressive file goes straight into the <video>. Nothing is
 * decoded on a canvas here: live streams are long-running MPEG-TS / fMP4 chains, which is what
 * MSE is for, and the canvas pipeline reads whole MP4 files.
 *
 * States: tuning (the server opens the stream and says what it is) -> loading (first segments)
 * -> playing; or "unavailable" (the provider refused / nothing came) and "unsupported" (DASH, a
 * web page, DRM, a codec the browser lacks), each with the reason and what to do next.
 *
 * Around it: previous / next channel (buttons, arrow keys, a vertical swipe), favorite, the
 * programme guide panel (what is on now and next, the day's listing), mute, fullscreen (the
 * theater itself, or the iPhone's native video player), and the controls hiding while playing.
 */
import Hls, { ErrorTypes, Events, type ErrorData } from 'hls.js';
import type { LiveTvChannel, LiveTvChannelGuideResponse, LiveTvProgramme, LiveTvTuneResponse } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';

export type PlayerState = 'idle' | 'tuning' | 'loading' | 'playing' | 'paused' | 'unavailable' | 'unsupported';

export interface PlayerHooks {
  onClose(): void;
  onChannel(ch: LiveTvChannel): void;
  onFavorite(ch: LiveTvChannel, on: boolean): void;
  isFavorite(key: string): boolean;
  /** Closed captions were turned on / off (the page keeps the setting) */
  onCaptions(on: boolean): void;
  /** The viewer hid this channel (the hide button, the H key, or from the error message) */
  onHide(ch: LiveTvChannel): void;
  /** Pause and rewind was turned on / off (the page keeps the setting) */
  onDvr(on: boolean): void;
  /** The server answered a tune: did the channel open (the page ranks channels that did not) */
  onTuned(ch: LiveTvChannel, ok: boolean): void;
  guide(key: string): Promise<LiveTvChannelGuideResponse>;
  nowNext(key: string): Promise<{ now?: LiveTvProgramme; next?: LiveTvProgramme }>;
  /** The provider's name for the subtitle (several providers) */
  providerName(ch: LiveTvChannel): string;
}

const elementFullscreenAllowed = (): boolean => !!document.fullscreenEnabled || !!(document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled;
type NativeVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitDisplayingFullscreen?: boolean };
const nativeVideoFullscreen = (v: HTMLVideoElement): boolean => typeof (v as NativeVideo).webkitEnterFullscreen === 'function' && !elementFullscreenAllowed();

const icon = (paths: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  prev: icon('<path d="M15 5l-7 7 7 7"/>'),
  next: icon('<path d="M9 5l7 7-7 7"/>'),
  back: icon('<path d="M11 5 4 12l7 7M20 5l-7 7 7 7"/>'),
  fwd: icon('<path d="M13 5l7 7-7 7M4 5l7 7-7 7"/>'),
  play: icon('<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>'),
  pause: icon('<path d="M7 5v14M17 5v14" stroke-width="3.2"/>'),
  sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  muted: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  full: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  star: icon('<path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.7z"/>'),
  starOn: icon('<path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.7z" fill="currentColor"/>'),
  guide: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v14"/>'),
  cc: icon('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6"/>'),
  hide: icon('<path d="M3 3l18 18"/><path d="M10.6 5.3A10.4 10.4 0 0 1 12 5.2c5 0 8.6 4.1 9.8 6.8-.5 1.1-1.3 2.3-2.4 3.4M6.4 6.6C4.2 8 2.9 10 2.2 12c1.2 2.7 4.8 6.8 9.8 6.8 1.7 0 3.2-.4 4.5-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  warn: icon('<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17.5v.5"/>'),
  off: icon('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
};

const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** 95 -> "1:35", 3725 -> "1:02:05" */
const fmtDur = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const SKIP_SEC = 10;
/** Closer to the live edge than this counts as live */
const LIVE_SLACK_SEC = 8;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class LiveTvPlayer {
  private root: HTMLElement;
  private video: HTMLVideoElement;
  private wait: HTMLElement;
  private waitText: HTMLElement;
  private msg: HTMLElement;
  private big: HTMLButtonElement;
  private logoEl: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private favBtn: HTMLButtonElement;
  private ccBtn: HTMLButtonElement;
  private guideBtn: HTMLButtonElement;
  private playBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private liveEl: HTMLButtonElement;
  private seekRow: HTMLElement;
  private range: HTMLInputElement;
  private seekTime: HTMLElement;
  private nowEl: HTMLElement;
  private nextEl: HTMLElement;
  private barEl: HTMLElement;
  private guideList: HTMLElement;
  private hls?: Hls;
  private items: LiveTvChannel[] = [];
  private index = -1;
  private generation = 0;
  private muted = false;
  private hideTimer = 0;
  private guideTimer = 0;
  private stallTimer = 0;
  private recovered = false;
  /** the frozen-picture watchdog (see checkFrozen) */
  private frozenTimer = 0;
  private lastFrames = -1;
  private lastTime = -1;
  private frozenSince = 0;
  private unfreezes = 0;
  /** Closed captions shown on the picture (a device setting the page keeps; off by default) */
  captions = false;
  /** Pause and rewind: the server records the channel (a device setting the page keeps; on by default) */
  dvr = true;
  /** How far back the current stream reaches (the server's answer), 0 when unknown */
  private windowSec = 0;
  private timelineTimer = 0;
  private scrubbing = false;
  state: PlayerState = 'idle';

  constructor(root: HTMLElement, private readonly hooks: PlayerHooks) {
    this.root = root;
    root.className = 'theater hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Live TV player');
    root.innerHTML = `
      <div class="th-stage"><video playsinline autoplay preload="auto"></video>
        <div class="th-wait hidden"><span class="spinner"></span><span class="th-wait-text">Tuning…</span></div>
        <div class="th-msg hidden"></div>
        <button type="button" class="th-big hidden" aria-label="Play">${ICON.play}</button>
      </div>
      <div class="th-top">
        <button type="button" class="th-btn th-close" aria-label="Close player" title="Close (Esc)">${ICON.close}</button>
        <div class="th-titles"><div class="th-logo"></div><div style="min-width:0"><div class="th-name"></div><div class="th-sub"></div></div></div>
        <button type="button" class="th-btn th-fav" aria-label="Favorite" title="Favorite (F)">${ICON.star}</button>
        <button type="button" class="th-btn th-hide" aria-label="Hide this channel" title="Hide this channel (H)">${ICON.hide}</button>
        <button type="button" class="th-btn th-cc" aria-label="Closed captions" aria-pressed="false" title="Closed captions (C)">${ICON.cc}</button>
        <button type="button" class="th-btn th-guidebtn" aria-label="Programme guide" title="Guide (G)">${ICON.guide}</button>
        <button type="button" class="th-btn th-full" aria-label="Fullscreen" title="Fullscreen">${ICON.full}</button>
      </div>
      <div class="th-bottom">
        <div class="th-seek hidden">
          <input type="range" class="th-range" min="0" max="1000" value="1000" step="1" aria-label="Position: drag back to rewind, right to live" />
          <span class="th-seek-time"></span>
        </div>
        <div class="th-controls">
          <button type="button" class="th-btn th-prev" aria-label="Previous channel" title="Previous channel (↑)">${ICON.prev}</button>
          <button type="button" class="th-btn th-back" aria-label="Back ${SKIP_SEC} seconds" title="Back ${SKIP_SEC} s (←)">${ICON.back}</button>
          <button type="button" class="th-btn th-play" aria-label="Pause" title="Play / pause (Space)">${ICON.pause}</button>
          <button type="button" class="th-btn th-fwd" aria-label="Forward ${SKIP_SEC} seconds" title="Forward ${SKIP_SEC} s (→)">${ICON.fwd}</button>
          <button type="button" class="th-btn th-mute" aria-label="Mute" title="Mute (M)">${ICON.sound}</button>
          <button type="button" class="th-live off" title="Jump to live (L)">LIVE</button>
          <div class="th-prog"><div class="th-prog-now"></div><div class="ch-bar hidden"><i></i></div><div class="th-prog-next"></div></div>
          <button type="button" class="th-btn th-next" aria-label="Next channel" title="Next channel (↓)">${ICON.next}</button>
        </div>
      </div>
      <aside class="th-guide" aria-label="Programme guide">
        <div class="th-guide-head"><span>Guide</span><button type="button" class="sh-close th-guideclose" aria-label="Close guide">✕</button></div>
        <div class="th-guide-list"></div>
      </aside>`;
    const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
    this.video = q<HTMLVideoElement>('video');
    this.wait = q('.th-wait');
    this.waitText = q('.th-wait-text');
    this.msg = q('.th-msg');
    this.big = q<HTMLButtonElement>('.th-big');
    this.logoEl = q('.th-logo');
    this.nameEl = q('.th-name');
    this.subEl = q('.th-sub');
    this.favBtn = q<HTMLButtonElement>('.th-fav');
    this.ccBtn = q<HTMLButtonElement>('.th-cc');
    this.guideBtn = q<HTMLButtonElement>('.th-guidebtn');
    this.playBtn = q<HTMLButtonElement>('.th-play');
    this.muteBtn = q<HTMLButtonElement>('.th-mute');
    this.liveEl = q<HTMLButtonElement>('.th-live');
    this.seekRow = q('.th-seek');
    this.range = q<HTMLInputElement>('.th-range');
    this.seekTime = q('.th-seek-time');
    this.nowEl = q('.th-prog-now');
    this.nextEl = q('.th-prog-next');
    this.barEl = q('.th-prog .ch-bar');
    this.guideList = q('.th-guide-list');

    q('.th-close').addEventListener('click', () => this.close());
    q('.th-prev').addEventListener('click', () => this.step(-1));
    q('.th-next').addEventListener('click', () => this.step(1));
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.big.addEventListener('click', () => this.togglePlay());
    q('.th-back').addEventListener('click', () => this.seekBy(-SKIP_SEC));
    q('.th-fwd').addEventListener('click', () => this.seekBy(SKIP_SEC));
    this.liveEl.addEventListener('click', () => this.goLive());
    // the seek bar: dragging shows where it would land; letting go seeks there
    this.range.addEventListener('input', () => {
      this.scrubbing = true;
      const w = this.window();
      if (w) this.seekTime.textContent = this.behindLabel(w.live - (w.start + (Number(this.range.value) / 1000) * (w.live - w.start)));
    });
    this.range.addEventListener('change', () => {
      this.scrubbing = false;
      const w = this.window();
      if (w) this.seekTo(w.start + (Number(this.range.value) / 1000) * (w.live - w.start));
    });
    this.video.addEventListener('timeupdate', () => this.refreshTimeline());
    this.video.addEventListener('pause', () => this.refreshTimeline());
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    this.favBtn.addEventListener('click', () => this.toggleFavorite());
    this.ccBtn.addEventListener('click', () => this.setCaptions(!this.captions));
    q('.th-hide').addEventListener('click', () => this.hideCurrent());
    this.guideBtn.addEventListener('click', () => this.toggleGuide());
    // text tracks appear as the stream is parsed (hls.js adds <track>s; Safari lists the manifest's):
    // each one gets the captions setting applied
    this.video.textTracks.addEventListener('addtrack', () => this.applyCaptions());
    this.video.addEventListener('loadedmetadata', () => this.applyCaptions());
    q('.th-guideclose').addEventListener('click', () => this.toggleGuide(false));
    q('.th-full').addEventListener('click', () => this.toggleFullscreen());
    this.video.addEventListener('click', () => this.wake());
    this.video.addEventListener('dblclick', () => this.toggleFullscreen());
    this.video.addEventListener('playing', () => {
      this.setState('playing');
      this.watchFrozen();
    });
    this.video.addEventListener('pause', () => {
      if (this.state === 'playing') this.setState('paused');
    });
    this.video.addEventListener('waiting', () => {
      if (this.state === 'playing') this.showWait('Buffering…');
    });
    this.video.addEventListener('error', () => this.onNativeError());
    this.video.addEventListener('stalled', () => this.armStall());
    this.video.addEventListener('timeupdate', () => this.disarmStall());
    for (const ev of ['mousemove', 'touchstart', 'keydown']) root.addEventListener(ev, () => this.wake(), { passive: true });
    // a vertical swipe on the picture changes channel (TV-remote style)
    let y0 = 0;
    let t0 = 0;
    root.addEventListener('touchstart', (e) => {
      y0 = e.touches[0].clientY;
      t0 = Date.now();
    }, { passive: true });
    root.addEventListener('touchend', (e) => {
      if ((e.target as HTMLElement).closest('.th-guide, button')) return;
      const dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dy) > 90 && Date.now() - t0 < 600) this.step(dy < 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('fullscreenchange', () => this.wake());
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }
  get current(): LiveTvChannel | undefined {
    return this.items[this.index];
  }

  /** Opens the theater on `index` of `items` (the browser's current list, so prev / next follow it). */
  open(items: LiveTvChannel[], index: number): void {
    this.items = items;
    this.root.classList.remove('hidden');
    document.body.classList.add('theater-open');
    // the live edge moves while paused: the bar and the "behind" badge follow it
    window.clearInterval(this.timelineTimer);
    this.timelineTimer = window.setInterval(() => this.refreshTimeline(), 1000);
    void this.play(index);
  }

  /** The list changed under the player (a filter, a refresh): keep playing, follow the same channel. */
  setItems(items: LiveTvChannel[]): void {
    const key = this.current?.key;
    this.items = items;
    const i = key ? items.findIndex((c) => c.key === key) : -1;
    if (i >= 0) this.index = i;
  }

  close(): void {
    if (!this.isOpen) return;
    this.generation++;
    window.clearInterval(this.timelineTimer);
    this.timelineTimer = 0;
    this.stopMedia();
    this.root.classList.add('hidden', 'idle');
    this.root.classList.remove('guide-open');
    document.body.classList.remove('theater-open');
    if (document.fullscreenElement === this.root) void document.exitFullscreen().catch(() => undefined);
    this.setState('idle');
    this.hooks.onClose();
  }

  refreshFavorite(): void {
    const c = this.current;
    const on = !!c && this.hooks.isFavorite(c.key);
    this.favBtn.innerHTML = on ? ICON.starOn : ICON.star;
    this.favBtn.classList.toggle('on', on);
  }

  private step(d: number): void {
    if (!this.items.length) return;
    void this.play((this.index + d + this.items.length) % this.items.length);
  }

  private async play(index: number): Promise<void> {
    const ch = this.items[index];
    if (!ch) return;
    const gen = ++this.generation;
    this.index = index;
    this.recovered = false;
    this.unfreezes = 0;
    this.stopMedia();
    this.logoEl.innerHTML = ch.logo ? `<img src="${esc(ch.logo)}" alt="" draggable="false" />` : '';
    this.nameEl.textContent = (ch.number ? `${ch.number} · ` : '') + ch.name;
    this.subEl.textContent = [...ch.groups, this.hooks.providerName(ch)].filter(Boolean).join(' · ');
    this.nowEl.textContent = '';
    this.nextEl.textContent = '';
    this.barEl.classList.add('hidden');
    this.windowSec = 0;
    this.seekRow.classList.add('hidden');
    this.refreshFavorite();
    this.hooks.onChannel(ch);
    this.setState('tuning');
    this.showWait('Tuning…');
    if (this.root.classList.contains('guide-open')) void this.loadGuide(ch);
    void this.loadNowNext(ch);
    if (ch.drm) return this.showMessage('unsupported', 'This channel is DRM-protected (the playlist names license keys); it cannot play here.', 'DRM');
    let t: LiveTvTuneResponse;
    try {
      t = await api.liveTvTune(ch.key, this.dvr);
    } catch (e) {
      if (gen !== this.generation) return;
      const m = e instanceof ApiError ? e.message : (e as Error).message;
      return this.showMessage('unavailable', `The server could not open this channel: ${m}`);
    }
    if (gen !== this.generation) return;
    this.hooks.onTuned(ch, t.state === 'ok' && !!t.playUrl);
    if (t.state !== 'ok' || !t.playUrl) return this.showMessage(t.state === 'unsupported' ? 'unsupported' : 'unavailable', t.message || 'This channel is not available right now.', t.detail);
    this.windowSec = t.dvr ? t.windowSec || 0 : 0;
    this.setState('loading');
    this.showWait('Loading…');
    this.startMedia(apiUrl(t.playUrl), t.kind === 'progressive', gen);
  }

  private startMedia(url: string, progressive: boolean, gen: number): void {
    const v = this.video;
    v.muted = this.muted;
    if (!progressive && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: false,
        liveSyncDurationCount: 3,
        // no liveMaxLatencyDurationCount: a paused or rewound player must not be dragged back to live
        maxBufferLength: 30,
        backBufferLength: 30,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 3,
        enableWorker: true,
      });
      // the manifest's subtitle tracks follow the captions setting (CEA-608 tracks: applyCaptions)
      hls.subtitleDisplay = this.captions;
      this.hls = hls;
      hls.on(Events.ERROR, (_e, data) => this.onHlsError(data, gen));
      hls.on(Events.MANIFEST_PARSED, () => {
        if (gen !== this.generation) return;
        void this.tryPlay();
      });
      hls.on(Events.FRAG_BUFFERED, () => {
        if (gen === this.generation && (this.state === 'loading' || this.state === 'playing')) this.wait.classList.add('hidden');
      });
      hls.attachMedia(v);
      hls.loadSource(url);
      return;
    }
    // native HLS (iPhone Safari) or a progressive file
    v.src = url;
    void this.tryPlay();
  }

  private async tryPlay(): Promise<void> {
    try {
      await this.video.play();
      this.big.classList.add('hidden');
    } catch {
      // autoplay refused (no gesture reached the video): one tap starts it
      if (this.state === 'loading' || this.state === 'playing') {
        this.wait.classList.add('hidden');
        this.big.classList.remove('hidden');
        this.setState('paused');
      }
    }
  }

  private stopMedia(): void {
    this.disarmStall();
    this.stopWatchFrozen();
    if (this.hls) {
      this.hls.destroy();
      this.hls = undefined;
    }
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* nothing loaded */
    }
    this.big.classList.add('hidden');
    this.msg.classList.add('hidden');
  }

  private onHlsError(data: ErrorData, gen: number): void {
    if (gen !== this.generation) return;
    if (!data.fatal) {
      // a slow segment: say so, keep going
      if (data.details === 'bufferStalledError' && this.state === 'playing') this.showWait('Buffering…');
      return;
    }
    const code = (data.response as { code?: number } | undefined)?.code;
    const bodyMsg = (() => {
      const d = (data.response as { data?: unknown } | undefined)?.data;
      if (typeof d === 'string') {
        try {
          return (JSON.parse(d) as { error?: string }).error;
        } catch {
          return undefined;
        }
      }
      return undefined;
    })();
    if (data.type === ErrorTypes.MEDIA_ERROR) {
      if (!this.recovered && this.hls) {
        this.recovered = true;
        this.hls.recoverMediaError();
        return;
      }
      const codec = data.details === 'manifestIncompatibleCodecsError' ? 'This stream uses a codec this browser cannot decode.' : 'The browser could not decode this stream (a codec it does not support, or a broken stream).';
      return this.showMessage('unsupported', codec, data.details);
    }
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      const why = bodyMsg || (code === 404 ? 'the provider has no such stream any more' : code === 403 ? 'the provider refused the request (geo-blocked, or not allowed from the server)' : code && code >= 500 ? `the provider's server failed (${code})` : this.state === 'playing' ? 'the stream stopped' : 'nothing came from the provider');
      return this.showMessage('unavailable', `This channel is not available right now: ${why}.`, data.details);
    }
    this.showMessage('unavailable', `Playback failed (${data.details}).`);
  }

  private onNativeError(): void {
    if (this.state === 'idle' || this.state === 'tuning' || this.msg.classList.contains('hidden') === false) return;
    const err = this.video.error;
    const code = err?.code;
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return this.showMessage('unsupported', 'This browser cannot play this stream format.', err?.message);
    if (code === MediaError.MEDIA_ERR_DECODE) return this.showMessage('unsupported', 'The browser could not decode this stream (a codec it does not support, or a broken stream).', err?.message);
    this.showMessage('unavailable', `This channel is not available right now: ${err?.message || 'the stream stopped'}.`);
  }

  // ---------------------------------------------------------------- closed captions

  /** Turns captions on / off (the page is told, and keeps the setting). */
  setCaptions(on: boolean): void {
    const changed = this.captions !== on;
    this.captions = on;
    this.ccBtn.classList.toggle('on', on);
    this.ccBtn.setAttribute('aria-pressed', String(on));
    this.ccBtn.title = on ? 'Closed captions: on (C)' : 'Closed captions: off (C)';
    this.applyCaptions();
    if (changed) this.hooks.onCaptions(on);
  }

  /**
   * The text tracks of the <video> follow the setting. Off: every track disabled, so nothing
   * is drawn even when the channel carries CEA-608 captions or the browser would show a
   * subtitle track by itself. On: hls.js shows the manifest's subtitle track when there is one;
   * otherwise the first captions / subtitles track (CEA-608 from the video, or Safari's own list).
   */
  private applyCaptions(): void {
    const on = this.captions;
    if (this.hls) this.hls.subtitleDisplay = on;
    const tracks = this.video.textTracks;
    if (!tracks) return;
    const hlsSubtitles = !!this.hls && this.hls.subtitleTracks.length > 0;
    let shown = false;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.kind !== 'captions' && t.kind !== 'subtitles') continue;
      if (!on) {
        if (t.mode !== 'disabled') t.mode = 'disabled';
        continue;
      }
      if (hlsSubtitles) continue; // hls.js's subtitle-track controller owns their modes
      const mode: TextTrackMode = shown ? 'hidden' : 'showing';
      shown = true;
      if (t.mode !== mode) t.mode = mode;
    }
  }

  // ---------------------------------------------------------------- the frozen-picture watchdog

  /**
   * The picture freezes while the sound goes on: Chromium stops rendering video after a hole or
   * a broken frame in the video buffer while the audio buffer still plays (hls.js nudges across
   * holes under a second; bigger ones, and a stuck decoder, it does not see since the clock
   * keeps running). Every 2 s, while playing and visible: when the clock advanced but no new
   * video frame was produced for 4 s, the pipeline is flushed: a seek to the live edge first,
   * then hls.js's media-error recovery, then the channel is tuned again.
   */
  private watchFrozen(): void {
    this.stopWatchFrozen();
    this.lastFrames = -1;
    this.lastTime = -1;
    this.frozenSince = 0;
    this.frozenTimer = window.setInterval(() => this.checkFrozen(), 2000);
  }
  private stopWatchFrozen(): void {
    if (this.frozenTimer) window.clearInterval(this.frozenTimer);
    this.frozenTimer = 0;
    this.frozenSince = 0;
  }
  private checkFrozen(): void {
    const v = this.video;
    if (this.state !== 'playing' || v.paused || v.seeking || document.hidden || !v.videoWidth) {
      this.frozenSince = 0;
      return;
    }
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : undefined;
    const frames = q ? q.totalVideoFrames : (v as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount;
    if (frames === undefined) return;
    const time = v.currentTime;
    const clockMoved = this.lastTime >= 0 && time > this.lastTime + 0.5;
    const framesMoved = this.lastFrames < 0 || frames !== this.lastFrames;
    this.lastFrames = frames;
    this.lastTime = time;
    if (!clockMoved || framesMoved) {
      this.frozenSince = 0;
      return;
    }
    if (!this.frozenSince) this.frozenSince = Date.now();
    else if (Date.now() - this.frozenSince >= 4000) {
      this.frozenSince = 0;
      this.unfreeze();
    }
  }
  private unfreeze(): void {
    const v = this.video;
    const attempt = ++this.unfreezes;
    console.warn(`[livetv] picture frozen while the sound plays (attempt ${attempt})`);
    this.showWait('Buffering…');
    if (attempt === 1) {
      // a seek flushes the decoder; the live edge is where a live stream belongs anyway
      const live = this.hls?.liveSyncPosition;
      if (typeof live === 'number' && Number.isFinite(live) && live > v.currentTime) v.currentTime = live;
      else if (v.seekable.length) v.currentTime = Math.max(v.currentTime, v.seekable.end(v.seekable.length - 1) - 1);
      else v.currentTime += 0.001;
      return;
    }
    if (attempt === 2 && this.hls) {
      this.hls.recoverMediaError();
      return;
    }
    void this.play(this.index);
  }

  /** No progress for 30 s while playing: the stream died quietly. */
  private armStall(): void {
    if (this.stallTimer || this.state !== 'playing') return;
    this.stallTimer = window.setTimeout(() => {
      this.stallTimer = 0;
      if (this.state === 'playing' && !this.video.paused) this.showMessage('unavailable', 'The stream stopped sending video.');
    }, 30_000);
  }
  private disarmStall(): void {
    if (this.stallTimer) window.clearTimeout(this.stallTimer);
    this.stallTimer = 0;
  }

  private setState(s: PlayerState): void {
    this.state = s;
    this.root.classList.toggle('playing', s === 'playing');
    if (s === 'playing') {
      this.wait.classList.add('hidden');
      this.msg.classList.add('hidden');
      this.big.classList.add('hidden');
      this.liveEl.classList.remove('off');
      this.wake();
    } else this.liveEl.classList.add('off');
    const playing = s === 'playing' || s === 'loading';
    this.playBtn.innerHTML = playing ? ICON.pause : ICON.play;
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  private showWait(text: string): void {
    this.msg.classList.add('hidden');
    this.waitText.textContent = text;
    this.wait.classList.remove('hidden');
  }

  private showMessage(kind: 'unavailable' | 'unsupported', text: string, detail?: string): void {
    this.stopMedia();
    this.wait.classList.add('hidden');
    this.setState(kind);
    this.msg.className = `th-msg ${kind}`;
    this.msg.innerHTML = `<div class="th-ico">${kind === 'unsupported' ? ICON.warn : ICON.off}</div><p>${esc(text)}</p>${detail ? `<small>${esc(detail)}</small>` : ''}
      <div class="sh-actions"><button type="button" class="btn small primary" data-act="retry">Try again</button><button type="button" class="btn small" data-act="next">Next channel</button><button type="button" class="btn small" data-act="hide">Hide channel</button><button type="button" class="btn small ghost" data-act="close">Close</button></div>`;
    this.msg.querySelector('[data-act="retry"]')!.addEventListener('click', () => void this.play(this.index));
    this.msg.querySelector('[data-act="next"]')!.addEventListener('click', () => this.step(1));
    this.msg.querySelector('[data-act="hide"]')!.addEventListener('click', () => this.hideCurrent());
    this.msg.querySelector('[data-act="close"]')!.addEventListener('click', () => this.close());
    this.msg.classList.remove('hidden');
    this.wake();
  }

  private togglePlay(): void {
    if (this.state === 'unavailable' || this.state === 'unsupported') return void this.play(this.index);
    if (this.video.paused) {
      // resume where it was paused; paused longer than the stream reaches back: from the oldest point kept
      const w = this.window();
      if (w && this.video.currentTime < w.start + 1) this.video.currentTime = w.start + 1;
      void this.tryPlay();
      this.setState('loading');
    } else {
      this.video.pause();
      this.big.classList.remove('hidden');
    }
    this.refreshTimeline();
  }

  // ---------------------------------------------------------------- pause and rewind

  /** What can be seeked: the oldest point kept, the end of what is buffered, and the live edge. */
  private window(): { start: number; end: number; live: number } | undefined {
    const s = this.video.seekable;
    if (!s.length) return undefined;
    const start = s.start(0);
    const end = s.end(s.length - 1);
    const sync = this.hls?.liveSyncPosition;
    const live = typeof sync === 'number' && Number.isFinite(sync) && sync > start ? Math.min(sync, end) : end;
    return live > start ? { start, end, live } : undefined;
  }

  private seekTo(t: number): void {
    const w = this.window();
    if (!w) return;
    const target = Math.max(w.start + 0.5, Math.min(t, w.live));
    if (target >= w.live - 0.5) return this.goLive();
    this.video.currentTime = target;
    this.showWait('Loading…');
    if (this.video.paused) void this.tryPlay();
    this.wake();
  }

  private seekBy(delta: number): void {
    this.seekTo(this.video.currentTime + delta);
  }

  /** Back to the live edge (and playing). */
  private goLive(): void {
    const w = this.window();
    if (!w) return;
    if (this.video.currentTime < w.live - 0.5) this.video.currentTime = w.live;
    if (this.video.paused) {
      void this.tryPlay();
      this.setState('loading');
    }
    this.refreshTimeline();
    this.wake();
  }

  /** "−2:35 · 1:58 PM": how far behind live, and the clock time that was (the live edge is now) */
  private behindLabel(behind: number): string {
    if (behind < LIVE_SLACK_SEC) return 'Live';
    return `−${fmtDur(behind)} · ${fmtClock(Date.now() - behind * 1000)}`;
  }

  /** The seek bar (when the stream reaches back at least 20 s) and the LIVE / "behind" badge follow the player. */
  private refreshTimeline(): void {
    if (!this.isOpen || this.state === 'idle' || this.state === 'tuning') return;
    const w = this.window();
    if (!w) {
      this.seekRow.classList.add('hidden');
      return;
    }
    const pos = Math.min(this.video.currentTime, w.live);
    const behind = Math.max(0, w.live - pos);
    const span = w.live - w.start;
    this.seekRow.classList.toggle('hidden', span < 20);
    if (!this.scrubbing) {
      this.range.value = String(Math.round(((pos - w.start) / span) * 1000));
      this.seekTime.textContent = behind < LIVE_SLACK_SEC ? (this.windowSec ? `Live · rewind up to ${fmtDur(Math.min(span, this.windowSec))}` : 'Live') : this.behindLabel(behind);
    }
    const isBehind = behind >= LIVE_SLACK_SEC;
    this.liveEl.textContent = isBehind ? `−${fmtDur(behind)}` : 'LIVE';
    this.liveEl.classList.toggle('behind', isBehind);
    this.liveEl.classList.toggle('off', !isBehind && this.state !== 'playing');
    this.liveEl.title = isBehind ? 'Jump to live (L)' : 'Live';
  }

  /** Pause and rewind on / off (the page is told, and keeps the setting); applies to the next channel. */
  setDvr(on: boolean): void {
    const changed = this.dvr !== on;
    this.dvr = on;
    if (changed) this.hooks.onDvr(on);
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    this.video.muted = this.muted;
    this.muteBtn.innerHTML = this.muted ? ICON.muted : ICON.sound;
    this.muteBtn.setAttribute('aria-label', this.muted ? 'Unmute' : 'Mute');
  }

  private toggleFavorite(): void {
    const c = this.current;
    if (!c) return;
    this.hooks.onFavorite(c, !this.hooks.isFavorite(c.key));
    this.refreshFavorite();
  }

  /** Hides the channel playing and moves on to the next one (or closes when it was the last). */
  private hideCurrent(): void {
    const c = this.current;
    if (!c) return;
    this.hooks.onHide(c);
    const rest = this.items.filter((x) => x.key !== c.key);
    if (!rest.length) return this.close();
    const next = Math.min(this.index, rest.length - 1);
    this.items = rest;
    void this.play(next);
  }

  private toggleGuide(on = !this.root.classList.contains('guide-open')): void {
    this.root.classList.toggle('guide-open', on);
    this.guideBtn.classList.toggle('on', on);
    if (on && this.current) void this.loadGuide(this.current);
  }

  private async loadGuide(ch: LiveTvChannel): Promise<void> {
    const gen = this.generation;
    this.guideList.innerHTML = '<p class="sh-note"><span class="spinner small"></span>Loading the guide…</p>';
    let g: LiveTvChannelGuideResponse;
    try {
      g = await this.hooks.guide(ch.key);
    } catch (e) {
      if (gen === this.generation) this.guideList.innerHTML = `<p class="sh-note">${esc((e as Error).message)}</p>`;
      return;
    }
    if (gen !== this.generation) return;
    if (!g.programmes.length) {
      this.guideList.innerHTML = `<p class="sh-note">${esc(g.note || 'No listing for this channel.')}</p>`;
      if (g.loading) {
        window.clearTimeout(this.guideTimer);
        this.guideTimer = window.setTimeout(() => void this.loadGuide(ch), 4000);
      }
      return;
    }
    const now = Date.now();
    this.guideList.innerHTML = g.programmes
      .map((p) => {
        const cls = p.stop <= now ? 'past' : p.start <= now ? 'now' : '';
        return `<div class="prog ${cls}"><div class="prog-time">${fmtClock(p.start)}</div><div><div class="prog-title">${esc(p.title)}</div>${p.desc ? `<div class="prog-desc">${esc(p.desc)}</div>` : ''}</div></div>`;
      })
      .join('');
    this.guideList.querySelector('.prog.now')?.scrollIntoView({ block: 'start' });
  }

  private async loadNowNext(ch: LiveTvChannel): Promise<void> {
    const gen = this.generation;
    let nn: { now?: LiveTvProgramme; next?: LiveTvProgramme };
    try {
      nn = await this.hooks.nowNext(ch.key);
    } catch {
      return;
    }
    if (gen !== this.generation) return;
    const now = Date.now();
    if (nn.now) {
      this.nowEl.textContent = `${nn.now.title}  ·  ${fmtClock(nn.now.start)} – ${fmtClock(nn.now.stop)}`;
      const pct = Math.max(0, Math.min(100, ((now - nn.now.start) / (nn.now.stop - nn.now.start)) * 100));
      this.barEl.classList.remove('hidden');
      (this.barEl.firstElementChild as HTMLElement).style.width = `${pct.toFixed(1)}%`;
    } else {
      this.nowEl.textContent = '';
      this.barEl.classList.add('hidden');
    }
    this.nextEl.textContent = nn.next ? `Next: ${nn.next.title} at ${fmtClock(nn.next.start)}` : '';
    // the programme changes: look again when it ends
    window.clearTimeout(this.guideTimer);
    const until = nn.now ? nn.now.stop - now + 2000 : 10 * 60_000;
    this.guideTimer = window.setTimeout(() => this.current?.key === ch.key && void this.loadNowNext(ch), Math.max(15_000, Math.min(until, 30 * 60_000)));
  }

  private toggleFullscreen(): void {
    const v = this.video as NativeVideo;
    if (nativeVideoFullscreen(v)) return v.webkitEnterFullscreen!();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void this.root.requestFullscreen?.().catch(() => undefined);
  }

  /** Controls show on any activity and hide again after 3 s while playing. */
  private wake(): void {
    this.root.classList.remove('idle');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.root.classList.add('idle'), 3000);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    switch (e.key) {
      case 'Escape':
        if (this.root.classList.contains('guide-open')) this.toggleGuide(false);
        else this.close();
        break;
      case ' ':
      case 'k':
        this.togglePlay();
        break;
      case 'ArrowUp':
      case 'PageUp':
        this.step(-1);
        break;
      case 'ArrowDown':
      case 'PageDown':
        this.step(1);
        break;
      case 'ArrowLeft':
        this.seekBy(-SKIP_SEC);
        break;
      case 'ArrowRight':
        this.seekBy(SKIP_SEC);
        break;
      case 'l':
        this.goLive();
        break;
      case 'm':
        this.toggleMute();
        break;
      case 'f':
        this.toggleFavorite();
        break;
      case 'c':
        this.setCaptions(!this.captions);
        break;
      case 'h':
        this.hideCurrent();
        break;
      case 'g':
        this.toggleGuide();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
