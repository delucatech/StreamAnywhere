/**
 * The Live TV player: a full-screen theater around a <canvas>. There is no <video> element
 * anywhere in it: the server records the channel (ffmpeg -> fragmented MP4, a rolling window) and
 * the page plays that recording as one endless MP4 through the feed's pipeline (fetch -> mp4box
 * demux -> VideoDecoder / AudioDecoder -> canvas 2D + Web Audio), the way TikTok videos play. A
 * media file a playlist links to (an MP4) goes through the same pipeline as a file.
 *
 * States: tuning (the server opens the stream and says what it is) -> loading (first frames)
 * -> playing / paused; or "unavailable" (the provider refused / nothing came / the stream died)
 * and "unsupported" (DASH, a web page, DRM, a codec this browser's decoder lacks), each with the
 * reason and what to do next.
 *
 * Pause and rewind: the recording reaches back the server's window (`…/window` says how far);
 * pausing freezes the clock (the download pauses with it, the server keeps recording); resuming
 * continues from the pause point; a seek reloads the stream from that point (`?from=`), and
 * LIVE reloads it from the live edge.
 *
 * Around it: previous / next channel (buttons, arrow keys, a vertical swipe), favorite, hide, the
 * programme guide panel (what is on now and next, the day's listing), mute, fullscreen (the
 * theater itself), and the controls hiding while playing.
 */
import type { LiveTvChannel, LiveTvChannelGuideResponse, LiveTvProgramme, LiveTvTuneResponse, LiveTvTuneStatus, LiveTvWindow } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';
import { FeedPlayer } from '../feed/player';

export type PlayerState = 'idle' | 'tuning' | 'loading' | 'playing' | 'paused' | 'unavailable' | 'unsupported';

export interface PlayerHooks {
  onClose(): void;
  onChannel(ch: LiveTvChannel): void;
  onFavorite(ch: LiveTvChannel, on: boolean): void;
  isFavorite(key: string): boolean;
  /** The viewer hid this channel (the hide button, the H key, or from the error message) */
  onHide(ch: LiveTvChannel): void;
  /** The server answered a tune: did the channel open (the page ranks channels that did not) */
  onTuned(ch: LiveTvChannel, ok: boolean): void;
  guide(key: string): Promise<LiveTvChannelGuideResponse>;
  nowNext(key: string): Promise<{ now?: LiveTvProgramme; next?: LiveTvProgramme }>;
  /** The provider's name for the subtitle (several providers) */
  providerName(ch: LiveTvChannel): string;
}

const elementFullscreenAllowed = (): boolean => !!document.fullscreenEnabled || !!(document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled;

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
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const SKIP_SEC = 10;
/** Within this of the live start (the server's `edge`) counts as live for the badge */
const LIVE_SLACK_SEC = 5;
/** A seek landing this close to the live start simply goes live */
const LIVE_SNAP_SEC = 3;
/** The seek bar shows once the recording reaches back this far */
const MIN_WINDOW_SEC = 20;
const WINDOW_POLL_MS = 2000;

export class LiveTvPlayer {
  private root: HTMLElement;
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private wait: HTMLElement;
  private waitText: HTMLElement;
  private waitDetail: HTMLElement;
  private msg: HTMLElement;
  private big: HTMLButtonElement;
  private logoEl: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private favBtn: HTMLButtonElement;
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
  private readonly feed: FeedPlayer;
  private items: LiveTvChannel[] = [];
  private index = -1;
  private generation = 0;
  private muted = false;
  private hideTimer = 0;
  private guideTimer = 0;
  private timelineTimer = 0;
  private waitTimer = 0;
  /** While a channel opens: the overlay ticks every second with what the server is doing */
  private progressTimer = 0;
  private openedAt = 0;
  private polling = false;
  private status?: LiveTvTuneStatus;
  private windowAt = 0;
  private scrubbing = false;
  /** The current channel's recording stream (`?v=` included); undefined for a media file */
  private streamUrl?: string;
  /** What the recording reaches back to, as the server last said */
  private win?: LiveTvWindow;
  private windowSec = 0;
  /** The stream ended once already for this channel: the next end is reported, not retried */
  private retried = false;
  /** This player, to the server: the recorder of a channel it leaves stops at once */
  private readonly viewer = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  /** The channel whose recorder runs for this player (told when leaving it) */
  private recordedKey?: string;
  state: PlayerState = 'idle';

  constructor(root: HTMLElement, private readonly hooks: PlayerHooks) {
    this.root = root;
    root.className = 'theater hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Live TV player');
    root.innerHTML = `
      <div class="th-stage"><canvas width="16" height="9"></canvas>
        <div class="th-wait hidden"><span class="spinner"></span><span class="th-wait-text">Tuning…</span><small class="th-wait-detail"></small></div>
        <div class="th-msg hidden"></div>
        <button type="button" class="th-big hidden" aria-label="Play">${ICON.play}</button>
      </div>
      <div class="th-top">
        <button type="button" class="th-btn th-close" aria-label="Close player" title="Close (Esc)">${ICON.close}</button>
        <div class="th-titles"><div class="th-logo"></div><div style="min-width:0"><div class="th-name"></div><div class="th-sub"></div></div></div>
        <button type="button" class="th-btn th-fav" aria-label="Favorite" title="Favorite (F)">${ICON.star}</button>
        <button type="button" class="th-btn th-hide" aria-label="Hide this channel" title="Hide this channel (H)">${ICON.hide}</button>
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
    this.stage = q('.th-stage');
    this.canvas = q<HTMLCanvasElement>('canvas');
    this.wait = q('.th-wait');
    this.waitText = q('.th-wait-text');
    this.waitDetail = q('.th-wait-detail');
    this.msg = q('.th-msg');
    this.big = q<HTMLButtonElement>('.th-big');
    this.logoEl = q('.th-logo');
    this.nameEl = q('.th-name');
    this.subEl = q('.th-sub');
    this.favBtn = q<HTMLButtonElement>('.th-fav');
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

    // the feed's canvas player: WebCodecs, or (without it) a hidden video copied into the canvas
    this.feed = new FeedPlayer(this.canvas, this.stage, {
      onFirstFrame: () => {
        if (this.state === 'loading') this.setState('playing');
      },
      onEnded: () => this.onStreamEnded(),
      onError: (err) => this.onPlayerError(err),
      onPlayingChange: (playing) => {
        if (this.state === 'tuning' || this.state === 'unavailable' || this.state === 'unsupported' || this.state === 'idle') return;
        if (playing) this.setState('playing');
        else if (this.feed.paused) this.setState('paused');
      },
      onTime: () => undefined,
      onWaiting: (waiting) => {
        // a stall shorter than a moment (a hole in a lossy feed, a slow segment) is not worth an overlay
        window.clearTimeout(this.waitTimer);
        if (!waiting) {
          if (this.state === 'playing' || this.state === 'loading') this.wait.classList.add('hidden');
          return;
        }
        if (this.state === 'loading') return this.tickProgress();
        if (this.state === 'playing') this.waitTimer = window.setTimeout(() => this.state === 'playing' && this.showWait('Buffering…'), 1200);
      },
    });

    q('.th-close').addEventListener('click', () => this.close());
    q('.th-prev').addEventListener('click', () => this.step(-1));
    q('.th-next').addEventListener('click', () => this.step(1));
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.big.addEventListener('click', () => this.togglePlay());
    q('.th-back').addEventListener('click', () => this.seekBy(-SKIP_SEC));
    q('.th-fwd').addEventListener('click', () => this.seekBy(SKIP_SEC));
    this.liveEl.addEventListener('click', () => this.goLive());
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    this.favBtn.addEventListener('click', () => this.toggleFavorite());
    q('.th-hide').addEventListener('click', () => this.hideCurrent());
    this.guideBtn.addEventListener('click', () => this.toggleGuide());
    q('.th-guideclose').addEventListener('click', () => this.toggleGuide(false));
    q('.th-full').addEventListener('click', () => this.toggleFullscreen());
    this.canvas.addEventListener('click', () => this.wake());
    this.canvas.addEventListener('dblclick', () => this.toggleFullscreen());
    // the seek bar: dragging shows where it would land; letting go reloads the stream there
    this.range.addEventListener('input', () => {
      this.scrubbing = true;
      const w = this.timeline();
      if (w) this.seekTime.textContent = this.behindLabel(w.edge - (w.start + (Number(this.range.value) / 1000) * (w.end - w.start)));
    });
    this.range.addEventListener('change', () => {
      this.scrubbing = false;
      const w = this.timeline();
      if (w) this.seekTo(w.start + (Number(this.range.value) / 1000) * (w.end - w.start));
    });
    for (const ev of ['mousemove', 'touchstart', 'keydown']) root.addEventListener(ev, () => this.wake(), { passive: true });
    // a touch or key: sound the autoplay policy held back may start now
    for (const ev of ['touchstart', 'keydown', 'click']) root.addEventListener(ev, () => this.feed.userGesture(), { passive: true });
    // a vertical swipe on the picture changes channel (TV-remote style)
    let y0 = 0;
    let t0 = 0;
    root.addEventListener('touchstart', (e) => {
      y0 = e.touches[0].clientY;
      t0 = Date.now();
    }, { passive: true });
    root.addEventListener('touchend', (e) => {
      if ((e.target as HTMLElement).closest('.th-guide, button, input')) return;
      const dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dy) > 90 && Date.now() - t0 < 600) this.step(dy < 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('fullscreenchange', () => this.wake());
    // the page goes away (closed, navigated, the car's browser killed): a beacon frees the recorder
    window.addEventListener('pagehide', () => {
      if (!this.recordedKey) return;
      const body = new Blob([JSON.stringify({ key: this.recordedKey, viewer: this.viewer })], { type: 'application/json' });
      navigator.sendBeacon?.(apiUrl('/api/livetv/leave'), body);
      this.recordedKey = undefined;
    });
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }
  get current(): LiveTvChannel | undefined {
    return this.items[this.index];
  }
  /** How the picture is made: the renderer's name (WebCodecs + Canvas, or the hidden-video fallback) */
  get rendererName(): string {
    return this.feed.rendererName;
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
    this.leaveRecorded();
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

  /** Tells the server this player left the recorded channel (nothing to say when none is recorded). */
  private leaveRecorded(): void {
    const key = this.recordedKey;
    if (!key) return;
    this.recordedKey = undefined;
    void api.liveTvLeave(key, this.viewer).catch(() => undefined);
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
    this.retried = false;
    if (this.recordedKey !== ch.key) this.leaveRecorded();
    this.stopMedia();
    this.logoEl.innerHTML = ch.logo ? `<img src="${esc(ch.logo)}" alt="" draggable="false" />` : '';
    this.nameEl.textContent = (ch.number ? `${ch.number} · ` : '') + ch.name;
    this.subEl.textContent = [...ch.groups, this.hooks.providerName(ch)].filter(Boolean).join(' · ');
    this.nowEl.textContent = '';
    this.nextEl.textContent = '';
    this.barEl.classList.add('hidden');
    this.refreshFavorite();
    this.hooks.onChannel(ch);
    this.setState('tuning');
    this.startProgress(ch);
    if (this.root.classList.contains('guide-open')) void this.loadGuide(ch);
    void this.loadNowNext(ch);
    if (ch.drm) return this.showMessage('unsupported', 'This channel is DRM-protected (the playlist names license keys); it cannot play here.', 'DRM');
    let t: LiveTvTuneResponse;
    try {
      t = await api.liveTvTune(ch.key, this.viewer);
    } catch (e) {
      if (gen !== this.generation) return;
      const m = e instanceof ApiError ? e.message : (e as Error).message;
      return this.showMessage('unavailable', `The server could not open this channel: ${m}`);
    }
    if (gen !== this.generation) return;
    this.hooks.onTuned(ch, t.state === 'ok' && !!t.playUrl);
    if (t.state !== 'ok' || !t.playUrl) return this.showMessage(t.state === 'unsupported' ? 'unsupported' : 'unavailable', t.message || 'This channel is not available right now.', t.detail);
    this.windowSec = t.dvr ? t.windowSec || 0 : 0;
    this.recordedKey = t.kind === 'remux' ? ch.key : undefined;
    this.setState('loading');
    this.status = undefined;
    this.tickProgress();
    if (t.kind === 'remux') {
      this.streamUrl = apiUrl(t.playUrl);
      void this.loadStream('live', gen);
    } else {
      // a media file: the same pipeline reads it with Range requests; the bar is its duration
      this.streamUrl = undefined;
      void this.loadFile(apiUrl(t.playUrl), ch.name, gen);
    }
  }

  /** The recording from the live edge or from a point in it (a seek), through the feed's pipeline. */
  private async loadStream(from: 'live' | number, gen = this.generation): Promise<void> {
    const ch = this.current;
    if (!this.streamUrl || !ch) return;
    const url = `${this.streamUrl}${this.streamUrl.includes('?') ? '&' : '?'}from=${from === 'live' ? 'live' : from.toFixed(3)}`;
    try {
      await this.feed.load(url, 'proxy', ch.name, { live: true, startAt: from === 'live' ? undefined : from });
      if (gen !== this.generation) return;
      await this.feed.play();
    } catch (e) {
      if (gen === this.generation) this.onPlayerError(e as Error);
    }
  }

  private async loadFile(url: string, label: string, gen: number): Promise<void> {
    try {
      await this.feed.load(url, 'proxy', label, {});
      if (gen !== this.generation) return;
      await this.feed.play();
    } catch (e) {
      if (gen === this.generation) this.onPlayerError(e as Error);
    }
  }

  private stopMedia(): void {
    this.feed.pause();
    this.streamUrl = undefined;
    this.win = undefined;
    this.windowSec = 0;
    this.seekRow.classList.add('hidden');
    this.big.classList.add('hidden');
    this.msg.classList.add('hidden');
  }

  /** The stream ended: a live recording never does unless the recorder stopped (a dead upstream, the idle reaper). */
  private onStreamEnded(): void {
    if (!this.isOpen || this.state === 'idle') return;
    if (!this.streamUrl) {
      // a media file reached its end
      this.setState('paused');
      this.big.classList.remove('hidden');
      return;
    }
    if (!this.retried) {
      // once: the server may just have restarted the recorder (the upstream hiccupped)
      this.retried = true;
      void this.play(this.index);
      return;
    }
    this.showMessage('unavailable', 'The stream stopped sending video.');
  }

  private onPlayerError(err: Error): void {
    if (!this.isOpen || this.state === 'unavailable' || this.state === 'unsupported') return;
    const m = err.message || 'playback failed';
    if (/hev1|hvc1/i.test(m)) return this.showMessage('unsupported', 'This channel is H.265 (HEVC), which this browser cannot decode; most channels are H.264.', m);
    if (/VideoDecoder|AudioDecoder|codec|No video track|WebCodecs|decode\(\)|mp4box/i.test(m)) return this.showMessage('unsupported', `This browser cannot decode this stream: ${m}`);
    this.showMessage('unavailable', `This channel is not available right now: ${/HTTP (404|410)/.test(m) ? 'the stream is gone' : m}.`);
  }

  /**
   * The opening overlay, kept alive: every second it says what is happening and for how long
   * (the server is asked where the tune stands while the tune request runs), so a slow start on
   * a busy server reads as progress, never as a frozen page.
   */
  private startProgress(ch?: LiveTvChannel): void {
    this.stopProgress();
    this.openedAt = Date.now();
    this.status = undefined;
    this.tickProgress();
    this.progressTimer = window.setInterval(() => {
      this.tickProgress();
      if (ch && this.state === 'tuning' && !this.polling) {
        this.polling = true;
        api.liveTvTuneStatus(ch.key)
          .then((s) => {
            if (this.state === 'tuning' && this.current?.key === ch.key) this.status = s;
          })
          .catch(() => undefined)
          .finally(() => (this.polling = false));
      }
    }, 1000);
  }

  private stopProgress(): void {
    window.clearInterval(this.progressTimer);
    this.progressTimer = 0;
  }

  private tickProgress(): void {
    if (this.state !== 'tuning' && this.state !== 'loading') return this.stopProgress();
    const sec = Math.round((Date.now() - this.openedAt) / 1000);
    const s = this.status;
    let text: string;
    const notes: string[] = [];
    if (this.state === 'loading') text = sec < 4 ? 'Opening the recording…' : 'Downloading and decoding the first frames…';
    else if (!s) text = sec < 3 ? 'Asking the server to open the channel…' : 'Waiting for the server to answer…';
    else if (s.phase === 'idle') text = 'Waiting for the server to pick up the request…';
    else if (s.phase === 'probing') text = 'Checking the stream with the provider…';
    else if (s.phase === 'checking') text = 'Checking the picked quality…';
    else if (s.phase === 'starting') text = 'Starting the recorder…';
    else {
      const n = s.segments || 0;
      text = n ? `Recording started, waiting for the first picture (${n} of 2 segments)…` : 'Recording started, waiting for the provider to send video…';
      if (s.note) notes.push(s.note);
    }
    if (s && s.load >= 1.5) notes.push(`The server is busy (load ${s.load}); this takes longer than usual.`);
    this.showWait(`${text} ${sec} s`, notes.join(' · '));
  }

  private setState(s: PlayerState): void {
    this.state = s;
    if (s !== 'tuning' && s !== 'loading') this.stopProgress();
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
    this.refreshTimeline();
  }

  private showWait(text: string, detail = ''): void {
    this.msg.classList.add('hidden');
    this.waitText.textContent = text;
    this.waitDetail.textContent = detail;
    this.wait.classList.remove('hidden');
  }

  private showMessage(kind: 'unavailable' | 'unsupported', text: string, detail?: string): void {
    this.leaveRecorded();
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
    if (this.state === 'tuning') return;
    if (this.feed.paused) {
      // resume where it was paused; paused longer than the recording reaches back: from the oldest point kept
      const w = this.timeline();
      if (this.streamUrl && w && this.feed.currentTime < w.start + 1) return this.seekTo(w.start + 1);
      void this.feed.play();
      this.setState('loading');
      this.startProgress();
    } else {
      this.feed.pause();
      this.big.classList.remove('hidden');
      this.setState('paused');
    }
    this.refreshTimeline();
  }

  // ---------------------------------------------------------------- pause and rewind

  /** What can be seeked: the recording's window (live; `edge` = where live playback is), or the file's length. */
  private timeline(): { start: number; end: number; edge: number; live: boolean } | undefined {
    if (this.streamUrl) {
      const w = this.win;
      if (!w || w.end <= w.start) return undefined;
      return { start: w.start, end: w.end, edge: w.edge || w.end, live: true };
    }
    const d = this.feed.duration;
    return d > 0 ? { start: 0, end: d, edge: d, live: false } : undefined;
  }

  private seekTo(t: number): void {
    const w = this.timeline();
    if (!w) return;
    const target = Math.max(w.start + 0.5, Math.min(t, w.end));
    if (w.live) {
      if (target >= w.edge - LIVE_SNAP_SEC) return this.goLive();
      this.setState('loading');
      this.startProgress();
      void this.loadStream(target);
    } else {
      this.feed.seek(target);
      if (this.feed.paused) void this.feed.play();
    }
    this.wake();
  }

  private seekBy(delta: number): void {
    this.seekTo(this.feed.currentTime + delta);
  }

  /** Back to the live edge (and playing). */
  private goLive(): void {
    if (!this.streamUrl) return;
    const w = this.timeline();
    if (w && !this.feed.paused && w.edge - this.feed.currentTime < LIVE_SLACK_SEC) return;
    this.setState('loading');
    this.startProgress();
    void this.loadStream('live');
    this.wake();
  }

  /** "−2:35 · 1:58 PM": how far behind live, and the clock time that was (the live edge is now) */
  private behindLabel(behind: number): string {
    if (behind < LIVE_SLACK_SEC) return 'Live';
    return `−${fmtDur(behind)} · ${fmtClock(Date.now() - behind * 1000)}`;
  }

  /** The seek bar (once the recording reaches back MIN_WINDOW_SEC) and the LIVE / "behind" badge follow the player. */
  private refreshTimeline(): void {
    if (!this.isOpen || this.state === 'idle' || this.state === 'tuning') return;
    const c = this.current;
    if (this.streamUrl && c && Date.now() - this.windowAt > WINDOW_POLL_MS) {
      this.windowAt = Date.now();
      const gen = this.generation;
      void api.liveTvWindow(c.key, this.viewer).then((w) => {
        if (gen === this.generation) this.win = w;
      }).catch(() => undefined);
    }
    const w = this.timeline();
    if (!w) {
      this.seekRow.classList.add('hidden');
      return;
    }
    const pos = Math.min(Math.max(this.feed.currentTime, w.start), w.end);
    const span = w.end - w.start;
    const behind = w.live ? Math.max(0, w.edge - pos) : 0;
    this.seekRow.classList.toggle('hidden', span < MIN_WINDOW_SEC);
    if (!this.scrubbing) {
      this.range.value = String(Math.round(((pos - w.start) / span) * 1000));
      if (w.live) this.seekTime.textContent = behind < LIVE_SLACK_SEC ? `Live · rewind up to ${fmtDur(Math.min(span, this.windowSec || span))}` : this.behindLabel(behind);
      else this.seekTime.textContent = `${fmtDur(pos)} / ${fmtDur(w.end)}`;
    }
    const isBehind = w.live && behind >= LIVE_SLACK_SEC;
    this.liveEl.textContent = isBehind ? `−${fmtDur(behind)}` : 'LIVE';
    this.liveEl.classList.toggle('behind', isBehind);
    this.liveEl.classList.toggle('off', !isBehind && (this.state !== 'playing' || !w.live));
    this.liveEl.title = isBehind ? 'Jump to live (L)' : w.live ? 'Live' : 'A media file, not a live stream';
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    this.feed.setMuted(this.muted);
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
    if (!elementFullscreenAllowed()) return;
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
