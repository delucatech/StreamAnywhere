/**
 * The status line: while this page waits for the server (or for a video's bytes), one short line
 * at the bottom says what the wait is, which step it is on and that it is moving:
 *
 *   ◌ Getting video ready… step 1 of 3 · reading the video page · 6 s
 *   ◌ Getting video ready… step 3 of 3 · 1.2 MB of 14.0 MB loaded · 9 s
 *   ◌ Buffering… 3.4 MB of 14.0 MB loaded
 *
 * One wait, one line, the current step only: a step that is over is not listed, and nothing stays
 * once the wait ends. It takes no taps (the video under it does).
 *
 * A page gets it by importing this module (it mounts itself). What the page waits for comes from
 * pending.ts: api.ts registers every request that can be slow, and a page may name waits of its
 * own with beginWait(). For a wait on the server, GET /api/activity (server/src/activity.ts) names
 * the step the server is on; it is asked only while such a wait is on show. The whole picture
 * (every job, the log, the machine's state) stays at /api/activity for diagnosing.
 */
import type { ActivityEntry, ActivityResponse } from '../../shared/types';
import { apiUrl } from './api';
import { currentWaits, infoOf, isQuiet, onWaitsChanged, type Wait, type WaitInfo } from './pending';

/** A wait shorter than this never shows the line */
const SHOW_AFTER_MS = 800;
/** The server is asked this often while a wait on the server is on show */
const ASK_EVERY_MS = 1500;
const ASK_TIMEOUT_MS = 6000;
/** The clock is shown once the wait has lasted this long */
const CLOCK_AFTER_MS = 3000;
/** No word from the server for this long: the line says so */
const SILENT_MS = 8000;

const CSS = `
#sa-activity{position:fixed;left:var(--sa-activity-left,10px);bottom:var(--sa-activity-bottom,calc(10px + env(safe-area-inset-bottom,0px)));z-index:2147483000;
box-sizing:border-box;max-width:var(--sa-activity-width,min(92vw,480px));display:flex;align-items:flex-start;gap:7px;padding:4px 11px 4px 8px;border-radius:12px;
background:rgba(10,12,16,.58);color:#d5dbe6;font:500 11.5px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
pointer-events:none;user-select:none;-webkit-user-select:none;font-variant-numeric:tabular-nums}
#sa-activity.hidden{display:none}
#sa-activity .sa-spin{flex:none;width:9px;height:9px;margin-top:3px;border-radius:50%;border:1.5px solid rgba(255,255,255,.22);border-top-color:#25f4ee;animation:sa-activity-spin .9s linear infinite}
#sa-activity .sa-text{min-width:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}
#sa-activity.warn{color:#ffd27a}
@keyframes sa-activity-spin{to{transform:rotate(360deg)}}
`;

const sec = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * A step of the server in a few words: its tool's name and everything after the first clause go
 * ("yt-dlp: reading the video's page on YouTube (as its tv app)" -> "reading the video's page on
 * YouTube"). The server may name the short form itself (ActivityEntry.brief).
 */
export function shortStep(step: string | undefined, max = 46): string {
  if (!step) return '';
  let t = step.replace(/^(yt-dlp|ffmpeg|[A-Z][\w' ]{2,22}):\s+/, '');
  t = t.split(/\s*[(;:]\s*|\s[—–]\s|\.\s/)[0].trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

/** The server's activity that belongs to a wait: the same request and, where both name one, the same ref. */
export function activityFor(acts: ActivityEntry[], route: string | undefined, ref: string | undefined): ActivityEntry | undefined {
  if (!route) return undefined;
  return acts.find((a) => !a.ended && a.route === route && (!ref || !a.ref || a.ref === ref));
}

interface ServerView {
  /** The last answer */
  data?: ActivityResponse;
  answeredAt: number;
  /** When the line came up for the wait on show (the "no answer yet" clock) */
  since: number;
  /** A request is out since (0 = none) */
  askedAt: number;
  failures: number;
  /** The server has no /api/activity (an older build, the IIS deployment): only this page's own facts are shown */
  unsupported: boolean;
  /** 401: the site password is needed first */
  locked: boolean;
}

/** The line for a wait; pure, for the tests of its wording. `server` is undefined for a wait that is not on the server. */
export function statusLine(w: Pick<Wait, 'label' | 'startedAt'>, info: WaitInfo, server: Pick<ServerView, 'data' | 'answeredAt' | 'since' | 'failures'> | undefined, now: number): { text: string; warn: boolean } {
  const bits: string[] = [];
  if (info.step) bits.push(`step ${info.step[0]} of ${info.step[1]}`);
  let warn = false;
  let detail = info.detail || '';
  if (server) {
    const silent = server.data ? now - server.answeredAt : now - server.since;
    if (silent >= SILENT_MS || server.failures >= 3) {
      warn = true;
      detail = 'the server is not answering, still trying';
    } else if (server.data) {
      const a = activityFor(server.data.activities, info.route, info.ref);
      const said = a ? a.brief || shortStep(a.step) : '';
      if (said) detail = said;
    }
  }
  if (detail) bits.push(detail);
  const waited = now - w.startedAt;
  if (waited >= CLOCK_AFTER_MS) bits.push(sec(waited));
  return { text: `${info.label || w.label}…${bits.length ? ' ' + bits.join(' · ') : ''}`, warn };
}

function mount(): void {
  if (typeof document === 'undefined' || document.getElementById('sa-activity')) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'sa-activity';
  root.className = 'hidden';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  const spin = document.createElement('span');
  spin.className = 'sa-spin';
  const text = document.createElement('span');
  text.className = 'sa-text';
  root.append(spin, text);
  const attach = (): void => void document.body.appendChild(root);
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  const view: ServerView = { answeredAt: 0, since: 0, askedAt: 0, failures: 0, unsupported: false, locked: false };
  let lastAskAt = 0;
  let ticker = 0;
  /** The wait on show (its id), so a new one starts with a clean view of the server */
  let shownId = 0;
  let wasOnServer = false;

  async function ask(): Promise<void> {
    if (view.askedAt || view.unsupported || view.locked) return;
    view.askedAt = lastAskAt = Date.now();
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), ASK_TIMEOUT_MS);
    try {
      const res = await fetch(apiUrl('/api/activity'), { mode: 'cors', credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
      if (res.status === 404 || res.status === 405) view.unsupported = true;
      else if (res.status === 401) view.locked = true;
      else if (!res.ok) view.failures++;
      else {
        view.data = (await res.json()) as ActivityResponse;
        view.answeredAt = Date.now();
        view.failures = 0;
      }
    } catch {
      view.failures++;
    } finally {
      window.clearTimeout(timer);
      view.askedAt = 0;
    }
    render();
  }

  function render(): void {
    const now = Date.now();
    const all = currentWaits();
    // the oldest wait somebody is held up by; the quiet ones (prefetch, the next batch) never show
    const w = all.find((x) => !isQuiet(x));
    if (!w || now - w.startedAt < SHOW_AFTER_MS) {
      if (!all.length) stop();
      root.classList.add('hidden');
      if (!w) shownId = 0;
      wasOnServer = false;
      return;
    }
    const info = infoOf(w);
    if (info.route === undefined && w.route) {
      info.route = w.route;
      info.ref = w.ref;
    }
    const onServer = Boolean(info.route) && !view.unsupported && !view.locked;
    if (shownId !== w.id || (onServer && !wasOnServer)) {
      shownId = w.id;
      // a new wait (or its part on the server begins): what the server said before is history
      view.data = undefined;
      view.answeredAt = view.since = now;
      view.failures = 0;
      lastAskAt = 0;
    }
    wasOnServer = onServer;
    const line = statusLine(w, info, onServer ? view : undefined, now);
    if (text.textContent !== line.text) text.textContent = line.text;
    root.classList.toggle('warn', line.warn);
    root.classList.remove('hidden');
    if (onServer && !view.askedAt && now - lastAskAt >= ASK_EVERY_MS - 100) void ask();
  }

  function start(): void {
    if (ticker) return;
    ticker = window.setInterval(render, 500);
  }
  function stop(): void {
    if (!ticker) return;
    window.clearInterval(ticker);
    ticker = 0;
  }

  onWaitsChanged(() => {
    if (currentWaits().length) start();
    render();
  });
}

mount();
