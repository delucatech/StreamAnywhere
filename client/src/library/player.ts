/**
 * The library's player: the videos downloaded to this browser, played with the app's own pipeline.
 *
 * Playback is the feed's FeedPlayer (feed/player.ts) on a <canvas>: WebCodecs (fetch → mp4box →
 * VideoDecoder / AudioDecoder → canvas 2D + Web Audio), or the hidden-<video>-into-canvas fallback
 * where WebCodecs is missing. The only difference from the feed is where the bytes come from: the
 * demuxer reads the stored Blob with slice() instead of fetch(), so nothing here needs a network.
 *
 * Around it: tap to pause, a seekable progress bar, previous / next (buttons, a vertical swipe,
 * the arrow keys), mute and fullscreen, and the next video starting when one ends.
 */
import { FeedPlayer, feedPlayerMode } from '../feed/player';

export interface PlayItem {
  entryId: string;
  title: string;
  sub: string;
  poster?: string;
  durationHint?: number;
  /** The stored file (read when the item comes up) */
  load: () => Promise<Blob>;
}

const fmtTime = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

const icon = (paths: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  prev: icon('<path d="M18 6l-8.5 6L18 18z" fill="currentColor"/><path d="M6 6v12"/>'),
  next: icon('<path d="M6 6l8.5 6L6 18z" fill="currentColor"/><path d="M18 6v12"/>'),
  play: icon('<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>'),
  pause: icon('<path d="M7 5v14M17 5v14" stroke-width="3.2"/>'),
  sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  muted: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  full: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  replay: icon('<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v5h5"/>'),
  more: icon('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
};

export class LibraryPlayer {
  private root: HTMLElement;
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private poster: HTMLImageElement;
  private wait: HTMLElement;
  private err: HTMLElement;
  private big: HTMLButtonElement;
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private counter: HTMLElement;
  private time: HTMLElement;
  private bar: HTMLElement;
  private played: HTMLElement;
  private loaded: HTMLElement;
  private playBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private fullBtn: HTMLButtonElement;
  private player?: FeedPlayer;
  private items: PlayItem[] = [];
  private index = -1;
  private generation = 0;
  private muted = false;
  private seeking = false;
  private ended = false;
  private hideTimer = 0;
  /** Called when the overlay closes (the page resumes its own state) */
  onClose?: () => void;
  /** The options button (top right): the page opens the video's sheet over the player */
  onOptions?: (entryId: string) => void;

  constructor(root: HTMLElement) {
    this.root = root;
    root.className = 'theater hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Video player');
    root.innerHTML = `
      <div class="th-top">
        <button type="button" class="th-btn th-close" aria-label="Close player" title="Close (Esc)">${ICON.close}</button>
        <div class="th-title"><div class="th-name"></div><div class="th-sub"></div></div>
        <div class="th-counter"></div>
        <button type="button" class="th-btn th-menu" aria-label="Options for this video" title="Options: quality, categories, delete…">${ICON.more}</button>
      </div>
      <div class="th-stage">
        <img class="th-poster" alt="" draggable="false" />
        <canvas class="th-canvas"></canvas>
        <div class="th-wait hidden"><span class="spinner"></span><span class="th-wait-text">Loading…</span></div>
        <div class="th-err hidden"></div>
        <button type="button" class="th-big hidden" aria-label="Play">${ICON.play}</button>
      </div>
      <div class="th-bottom">
        <div class="th-time"></div>
        <div class="th-bar" role="slider" aria-label="Position" tabindex="0"><i class="th-loaded"></i><i class="th-played"></i></div>
        <div class="th-ctrls">
          <button type="button" class="th-btn th-prev" aria-label="Previous video" title="Previous (↑)">${ICON.prev}</button>
          <button type="button" class="th-btn th-play big" aria-label="Pause" title="Pause (Space)">${ICON.pause}</button>
          <button type="button" class="th-btn th-next" aria-label="Next video" title="Next (↓)">${ICON.next}</button>
          <span class="th-gap"></span>
          <button type="button" class="th-btn th-mute" aria-label="Mute" title="Mute (M)">${ICON.sound}</button>
          <button type="button" class="th-btn th-full" aria-label="Fullscreen" title="Fullscreen (F)">${ICON.full}</button>
        </div>
      </div>`;
    const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
    this.stage = q('.th-stage');
    this.canvas = q('.th-canvas');
    this.poster = q('.th-poster');
    this.wait = q('.th-wait');
    this.err = q('.th-err');
    this.big = q('.th-big');
    this.titleEl = q('.th-name');
    this.subEl = q('.th-sub');
    this.counter = q('.th-counter');
    this.time = q('.th-time');
    this.bar = q('.th-bar');
    this.played = q('.th-played');
    this.loaded = q('.th-loaded');
    this.playBtn = q('.th-play');
    this.muteBtn = q('.th-mute');
    this.prevBtn = q('.th-prev');
    this.nextBtn = q('.th-next');
    this.fullBtn = q('.th-full');
    q('.th-close').addEventListener('click', () => this.close());
    q('.th-menu').addEventListener('click', () => {
      const id = this.current;
      if (id) this.onOptions?.(id);
    });
    this.playBtn.addEventListener('click', () => this.togglePause());
    this.big.addEventListener('click', () => this.togglePause());
    this.prevBtn.addEventListener('click', () => this.go(this.index - 1));
    this.nextBtn.addEventListener('click', () => this.go(this.index + 1));
    this.muteBtn.addEventListener('click', () => this.setMuted(!this.muted));
    this.fullBtn.addEventListener('click', () => this.toggleFullscreen());
    if (!document.fullscreenEnabled && !(document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled) this.fullBtn.classList.add('hidden');
    this.bindStage();
    this.bindBar();
    document.addEventListener('keydown', (e) => this.onKey(e));
    // a moving mouse brings the bars back; a finger does that with a tap (see bindStage)
    this.root.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.showChrome();
    });
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** The video on screen */
  get current(): string | undefined {
    return this.items[this.index]?.entryId;
  }

  pause(): void {
    this.player?.pause();
    this.showChrome();
  }

  resume(): void {
    if (this.player?.paused && !this.ended) void this.player.play();
  }

  /** The renderer in use, for the page's notes ("WebCodecs + Canvas" or the <video> fallback). */
  static mode(): { mode: string; reason?: string } {
    return feedPlayerMode();
  }

  open(items: PlayItem[], index: number): void {
    if (!items.length) return;
    this.items = items;
    this.root.classList.remove('hidden');
    document.body.classList.add('theater-open');
    this.showChrome();
    this.go(Math.max(0, Math.min(items.length - 1, index)));
  }

  close(): void {
    if (!this.isOpen) return;
    this.generation++;
    this.player?.destroy();
    this.player = undefined;
    this.root.classList.add('hidden');
    document.body.classList.remove('theater-open');
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    this.onClose?.();
  }

  /** Items the page removed (a local copy deleted) leave the list; the player closes when nothing is left. */
  remove(entryId: string): void {
    const i = this.items.findIndex((x) => x.entryId === entryId);
    if (i < 0) return;
    this.items.splice(i, 1);
    if (!this.items.length) return this.close();
    if (i === this.index) this.go(Math.min(i, this.items.length - 1));
    else if (i < this.index) this.index--;
    this.renderCounter();
  }

  private renderCounter(): void {
    this.counter.textContent = this.items.length > 1 ? `${this.index + 1} / ${this.items.length}` : '';
    this.prevBtn.disabled = this.index <= 0;
    this.nextBtn.disabled = this.index >= this.items.length - 1;
  }

  private go(i: number): void {
    if (i < 0 || i >= this.items.length) return;
    const gen = ++this.generation;
    this.index = i;
    const item = this.items[i];
    this.ended = false;
    this.titleEl.textContent = item.title;
    this.subEl.textContent = item.sub;
    this.renderCounter();
    this.err.classList.add('hidden');
    this.big.classList.add('hidden');
    this.stage.classList.remove('has-frame', 'paused');
    this.played.style.width = '0%';
    this.loaded.style.width = '0%';
    this.time.textContent = item.durationHint ? `0:00 / ${fmtTime(item.durationHint)}` : '';
    if (item.poster) {
      this.poster.src = item.poster;
      this.poster.classList.remove('hidden');
    } else this.poster.classList.add('hidden');
    this.setWaiting(true, 'Opening the local copy…');
    this.player?.destroy();
    this.player = undefined;
    void item
      .load()
      .then(async (blob) => {
        if (gen !== this.generation) return;
        const player = new FeedPlayer(this.canvas, this.stage, {
          onFirstFrame: () => {
            if (gen !== this.generation) return;
            this.stage.classList.add('has-frame');
            this.setWaiting(false);
          },
          onWaiting: (w) => gen === this.generation && this.setWaiting(w, 'Buffering…'),
          onEnded: () => {
            if (gen !== this.generation) return;
            if (this.index < this.items.length - 1) this.go(this.index + 1);
            else {
              this.ended = true;
              this.stage.classList.add('paused');
              this.big.innerHTML = ICON.replay;
              this.big.classList.remove('hidden');
              this.playBtn.innerHTML = ICON.replay;
              this.playBtn.setAttribute('aria-label', 'Play again');
            }
          },
          onError: (e) => {
            if (gen !== this.generation) return;
            this.setWaiting(false);
            this.err.textContent = `This video could not be played (${e.message}).`;
            this.err.classList.remove('hidden');
          },
          onPlayingChange: (playing) => {
            if (gen !== this.generation) return;
            this.stage.classList.toggle('paused', !playing);
            this.big.classList.toggle('hidden', playing || this.ended);
            if (!this.ended) {
              this.big.innerHTML = ICON.play;
              this.playBtn.innerHTML = playing ? ICON.pause : ICON.play;
              this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
            }
          },
          onTime: (t, d) => {
            if (gen !== this.generation) return;
            if (!this.seeking) this.played.style.width = `${(100 * t) / d}%`;
            const dl = player.download();
            if (dl.fraction >= 0) this.loaded.style.width = `${Math.round(dl.fraction * 1000) / 10}%`;
            this.time.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
          },
        });
        player.loop = false;
        player.setMuted(this.muted);
        this.player = player;
        await player.load('', 'local', `library ${item.entryId}`, { blob, durationHint: item.durationHint });
        if (gen !== this.generation) return;
        await player.play();
      })
      .catch((e: Error) => {
        if (gen !== this.generation) return;
        this.setWaiting(false);
        this.err.textContent = `The local copy could not be opened (${e.message}). Download it again from the library.`;
        this.err.classList.remove('hidden');
      });
  }

  private setWaiting(on: boolean, text = 'Loading…'): void {
    this.wait.classList.toggle('hidden', !on);
    (this.wait.querySelector('.th-wait-text') as HTMLElement).textContent = text;
  }

  private togglePause(): void {
    const p = this.player;
    if (!p) return;
    if (this.ended) {
      this.ended = false;
      this.big.classList.add('hidden');
      p.seek(0);
      void p.play();
      return;
    }
    if (p.paused) void p.play();
    else p.pause();
    this.showChrome();
  }

  private setMuted(m: boolean): void {
    this.muted = m;
    this.player?.setMuted(m);
    this.muteBtn.innerHTML = m ? ICON.muted : ICON.sound;
    this.muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
  }

  private toggleFullscreen(): void {
    const d = document as unknown as { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const r = this.root as unknown as { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement || d.webkitFullscreenElement) {
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
      else d.webkitExitFullscreen?.();
    } else if (this.root.requestFullscreen) void this.root.requestFullscreen().catch(() => undefined);
    else r.webkitRequestFullscreen?.();
  }

  /**
   * The title, the bars and the buttons fade a couple of seconds into playback. A tap on the video
   * while they are hidden only brings them back; a tap while they show pauses or resumes.
   */
  private showChrome(): void {
    this.root.classList.remove('idle');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this.player && !this.player.paused) this.root.classList.add('idle');
    }, 2500);
  }

  private bindStage(): void {
    let down: { x: number; y: number; id: number; at: number; wasIdle: boolean } | undefined;
    let moved = false;
    this.stage.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, id: e.pointerId, at: performance.now(), wasIdle: this.root.classList.contains('idle') };
      moved = false;
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      if (Math.abs(e.clientY - down.y) > 10 || Math.abs(e.clientX - down.x) > 10) moved = true;
    });
    const end = (e: PointerEvent): void => {
      if (!down || e.pointerId !== down.id) return;
      const dy = e.clientY - down.y;
      const dx = e.clientX - down.x;
      const dt = performance.now() - down.at;
      const wasIdle = down.wasIdle;
      down = undefined;
      const h = this.stage.clientHeight || 1;
      // a vertical swipe (far or fast enough) moves to the next / previous video, like the feed
      if (Math.abs(dy) > Math.abs(dx) && (Math.abs(dy) > h * 0.18 || (Math.abs(dy) > 40 && Math.abs(dy) / dt > 0.45))) {
        this.go(dy < 0 ? this.index + 1 : this.index - 1);
        return;
      }
      if (moved) return;
      if (wasIdle) this.showChrome();
      else this.togglePause();
    };
    this.stage.addEventListener('pointerup', end);
    this.stage.addEventListener('pointercancel', () => (down = undefined));
    // the wheel steps through the videos too (desktop, the car's scroll)
    let wheelLock = 0;
    this.root.addEventListener(
      'wheel',
      (e) => {
        if (!this.isOpen) return;
        e.preventDefault();
        const now = performance.now();
        if (now < wheelLock || Math.abs(e.deltaY) < 20) return;
        wheelLock = now + 500;
        this.go(e.deltaY > 0 ? this.index + 1 : this.index - 1);
      },
      { passive: false },
    );
  }

  private bindBar(): void {
    const seekTo = (clientX: number): number => {
      const r = this.bar.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)));
      this.played.style.width = `${f * 100}%`;
      return f;
    };
    let id = -1;
    this.bar.addEventListener('pointerdown', (e) => {
      if (!this.player) return;
      id = e.pointerId;
      this.seeking = true;
      this.bar.setPointerCapture(id);
      seekTo(e.clientX);
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) seekTo(e.clientX);
    });
    const done = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = -1;
      this.seeking = false;
      const f = seekTo(e.clientX);
      const p = this.player;
      if (p && p.duration > 0) {
        this.ended = false;
        this.big.classList.add('hidden');
        p.seek(f * p.duration);
        if (p.paused) void p.play();
      }
    };
    this.bar.addEventListener('pointerup', done);
    this.bar.addEventListener('pointercancel', done);
    this.bar.addEventListener('keydown', (e) => {
      const p = this.player;
      if (!p) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        p.seek(Math.max(0, p.currentTime + (e.key === 'ArrowLeft' ? -5 : 5)));
      }
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    switch (e.key) {
      case 'Escape':
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else this.close();
        break;
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        this.togglePause();
        break;
      case 'ArrowDown':
      case 'j':
      case 'J':
      case 'PageDown':
        e.preventDefault();
        this.go(this.index + 1);
        break;
      case 'ArrowUp':
      case 'PageUp':
        e.preventDefault();
        this.go(this.index - 1);
        break;
      case 'ArrowLeft':
        this.player?.seek(Math.max(0, (this.player?.currentTime || 0) - 5));
        break;
      case 'ArrowRight':
        this.player?.seek((this.player?.currentTime || 0) + 5);
        break;
      case 'm':
      case 'M':
        this.setMuted(!this.muted);
        break;
      case 'f':
      case 'F':
        this.toggleFullscreen();
        break;
    }
  }
}
