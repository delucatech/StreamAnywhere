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
  play: icon('<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>'),
  pause: icon('<path d="M7 5v14M17 5v14" stroke-width="3.2"/>'),
  sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  muted: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  full: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  star: icon('<path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.7z"/>'),
  starOn: icon('<path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.7z" fill="currentColor"/>'),
  guide: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v14"/>'),
  warn: icon('<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17.5v.5"/>'),
  off: icon('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
};

const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  private guideBtn: HTMLButtonElement;
  private playBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private liveEl: HTMLElement;
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
        <button type="button" class="th-btn th-guidebtn" aria-label="Programme guide" title="Guide (G)">${ICON.guide}</button>
        <button type="button" class="th-btn th-full" aria-label="Fullscreen" title="Fullscreen">${ICON.full}</button>
      </div>
      <div class="th-bottom">
        <button type="button" class="th-btn th-prev" aria-label="Previous channel" title="Previous channel (↑)">${ICON.prev}</button>
        <button type="button" class="th-btn th-play" aria-label="Pause" title="Play / pause (Space)">${ICON.pause}</button>
        <button type="button" class="th-btn th-mute" aria-label="Mute" title="Mute (M)">${ICON.sound}</button>
        <span class="th-live off">LIVE</span>
        <div class="th-prog"><div class="th-prog-now"></div><div class="ch-bar hidden"><i></i></div><div class="th-prog-next"></div></div>
        <button type="button" class="th-btn th-next" aria-label="Next channel" title="Next channel (↓)">${ICON.next}</button>
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
    this.guideBtn = q<HTMLButtonElement>('.th-guidebtn');
    this.playBtn = q<HTMLButtonElement>('.th-play');
    this.muteBtn = q<HTMLButtonElement>('.th-mute');
    this.liveEl = q('.th-live');
    this.nowEl = q('.th-prog-now');
    this.nextEl = q('.th-prog-next');
    this.barEl = q('.th-prog .ch-bar');
    this.guideList = q('.th-guide-list');

    q('.th-close').addEventListener('click', () => this.close());
    q('.th-prev').addEventListener('click', () => this.step(-1));
    q('.th-next').addEventListener('click', () => this.step(1));
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.big.addEventListener('click', () => this.togglePlay());
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    this.favBtn.addEventListener('click', () => this.toggleFavorite());
    this.guideBtn.addEventListener('click', () => this.toggleGuide());
    q('.th-guideclose').addEventListener('click', () => this.toggleGuide(false));
    q('.th-full').addEventListener('click', () => this.toggleFullscreen());
    this.video.addEventListener('click', () => this.wake());
    this.video.addEventListener('dblclick', () => this.toggleFullscreen());
    this.video.addEventListener('playing', () => this.setState('playing'));
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
    this.stopMedia();
    this.logoEl.innerHTML = ch.logo ? `<img src="${esc(ch.logo)}" alt="" draggable="false" />` : '';
    this.nameEl.textContent = (ch.number ? `${ch.number} · ` : '') + ch.name;
    this.subEl.textContent = [ch.group, this.hooks.providerName(ch)].filter(Boolean).join(' · ');
    this.nowEl.textContent = '';
    this.nextEl.textContent = '';
    this.barEl.classList.add('hidden');
    this.refreshFavorite();
    this.hooks.onChannel(ch);
    this.setState('tuning');
    this.showWait('Tuning…');
    if (this.root.classList.contains('guide-open')) void this.loadGuide(ch);
    void this.loadNowNext(ch);
    if (ch.drm) return this.showMessage('unsupported', 'This channel is DRM-protected (the playlist names license keys); it cannot play here.', 'DRM');
    let t: LiveTvTuneResponse;
    try {
      t = await api.liveTvTune(ch.key);
    } catch (e) {
      if (gen !== this.generation) return;
      const m = e instanceof ApiError ? e.message : (e as Error).message;
      return this.showMessage('unavailable', `The server could not open this channel: ${m}`);
    }
    if (gen !== this.generation) return;
    if (t.state !== 'ok' || !t.playUrl) return this.showMessage(t.state === 'unsupported' ? 'unsupported' : 'unavailable', t.message || 'This channel is not available right now.', t.detail);
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
        liveMaxLatencyDurationCount: 8,
        maxBufferLength: 20,
        backBufferLength: 10,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 3,
        enableWorker: true,
      });
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
      <div class="sh-actions"><button type="button" class="btn small primary" data-act="retry">Try again</button><button type="button" class="btn small" data-act="next">Next channel</button><button type="button" class="btn small ghost" data-act="close">Close</button></div>`;
    this.msg.querySelector('[data-act="retry"]')!.addEventListener('click', () => void this.play(this.index));
    this.msg.querySelector('[data-act="next"]')!.addEventListener('click', () => this.step(1));
    this.msg.querySelector('[data-act="close"]')!.addEventListener('click', () => this.close());
    this.msg.classList.remove('hidden');
    this.wake();
  }

  private togglePlay(): void {
    if (this.state === 'unavailable' || this.state === 'unsupported') return void this.play(this.index);
    if (this.video.paused) {
      // a live stream paused for a while is behind: jump back to the live edge
      if (this.hls && this.hls.liveSyncPosition !== null && this.hls.liveSyncPosition !== undefined) this.video.currentTime = this.hls.liveSyncPosition;
      void this.tryPlay();
      this.setState('loading');
    } else {
      this.video.pause();
      this.big.classList.remove('hidden');
    }
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
      case 'm':
        this.toggleMute();
        break;
      case 'f':
        this.toggleFavorite();
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
