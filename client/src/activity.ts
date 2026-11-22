/**
 * The status strip: while this page waits for the server (or for a video's bytes), a small panel
 * says what the page is waiting for, for how long, and what the server is doing about it right
 * now - step by step, with the last lines of its log - or that the server is not answering.
 *
 *   Getting the video ready… 14 s
 *   ● Getting a YouTube video ready (Gh-XKNuvvC4) — yt-dlp: running YouTube's player script with Deno · 6 s on this step
 *   ● TikTok browser: loading Explore videos (in the background)
 *   3 s ago · youtube Gh-XKNuvvC4: the direct lookup failed … asking yt-dlp
 *
 * A page gets it by importing this module (it mounts itself). What the page waits for comes from
 * pending.ts: api.ts registers every request that can be slow, and a page may name waits of its
 * own with beginWait(). The server's side is GET /api/activity (server/src/activity.ts), asked
 * only while the strip is up. A tap on the strip shows more lines; a second tap fewer.
 */
import type { ActivityEntry, ActivityResponse } from '../../shared/types';
import { apiUrl } from './api';
import { currentWaits, isQuiet, onWaitsChanged, type Wait } from './pending';

/** A wait shorter than this never shows the strip */
const SHOW_AFTER_MS = 1200;
/** The server is asked this often while the strip is up */
const ASK_EVERY_MS = 1500;
const ASK_TIMEOUT_MS = 6000;
/** After the last wait ended the strip stays this long (its last word: "done", "failed: …") */
const LINGER_MS = 1800;

const CSS = `
#sa-activity{position:fixed;left:var(--sa-activity-left,8px);top:var(--sa-activity-top,auto);bottom:var(--sa-activity-bottom,calc(8px + env(safe-area-inset-bottom,0px)));z-index:2147483000;
box-sizing:border-box;max-width:var(--sa-activity-width,min(94vw,520px));padding:7px 10px 8px;border-radius:10px;background:rgba(10,12,16,.86);border:1px solid rgba(255,255,255,.12);
color:#eef1f6;font:12px/1.38 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:left;cursor:pointer;user-select:none;-webkit-user-select:none;
box-shadow:0 4px 18px rgba(0,0,0,.45);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);overflow-wrap:anywhere}
#sa-activity.hidden{display:none}
#sa-activity .sa-head{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px}
#sa-activity .sa-spin{flex:none;width:11px;height:11px;border-radius:50%;border:2px solid rgba(255,255,255,.22);border-top-color:#25f4ee;animation:sa-activity-spin .9s linear infinite}
#sa-activity.idle .sa-spin{animation:none;border-color:rgba(255,255,255,.3)}
#sa-activity .sa-line{margin-top:3px;color:#cfd6e4}
#sa-activity .sa-line b{font-weight:600;color:#fff}
#sa-activity .sa-line.bg{color:#9aa3b7}
#sa-activity .sa-line.ok{color:#8fe3a8}
#sa-activity .sa-line.bad{color:#ff8d98}
#sa-activity .sa-line.warn{color:#ffd27a}
#sa-activity .sa-line.log{color:#8f98ac;font-size:11px}
#sa-activity .sa-more{margin-top:3px;color:#7e879b;font-size:10.5px}
@keyframes sa-activity-spin{to{transform:rotate(360deg)}}
`;

const sec = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/** One activity of the server as a line of text. */
export function activityLine(a: ActivityEntry): string {
  if (a.ended) {
    const ran = sec(a.forMs);
    return a.ended.failed ? `${a.what} — failed after ${ran}${a.ended.result ? `: ${a.ended.result}` : ''}` : `${a.what} — done in ${ran}`;
  }
  const step = a.step ? ` — ${a.step}` : '';
  // the clock of the step when there is one (how long it has been stuck there), else of the whole job
  const clock = a.step && a.stepForMs !== undefined && a.stepForMs >= 1500 ? ` · ${sec(a.stepForMs)} on this step` : !a.step && a.forMs >= 1500 ? ` · ${sec(a.forMs)}` : '';
  return `${a.what}${step}${clock}${a.background ? ' (in the background)' : ''}`;
}

interface ServerView {
  /** The last answer */
  data?: ActivityResponse;
  answeredAt: number;
  /** When the strip came up for the wait on show (the "no answer yet" clock) */
  since: number;
  /** A request is out since (0 = none) */
  askedAt: number;
  failures: number;
  /** The server has no /api/activity (an older build, the IIS deployment): only this page's own clock is shown */
  unsupported: boolean;
  /** 401: the site password is needed first */
  locked: boolean;
}

/** The text lines of the strip below its head line; pure, for the tests of its wording. */
export function stripLines(view: ServerView, now: number, expanded: boolean): { cls: string; text: string }[] {
  const out: { cls: string; text: string }[] = [];
  if (view.unsupported || view.locked) return out;
  if (!view.data) {
    const waited = now - view.since;
    if (waited >= 3000 || view.failures) out.push({ cls: 'warn', text: `No answer from the server yet (${sec(waited)}): it may be overloaded or restarting, or this device's connection dropped. Still trying…` });
    else out.push({ cls: 'bg', text: 'Asking the server what it is doing…' });
    return out;
  }
  const stale = now - view.answeredAt;
  if (view.failures >= 2 || stale >= 6000) {
    out.push({ cls: 'warn', text: `The server has not answered for ${sec(stale)}: it may be overloaded or restarting, or this device's connection dropped. Still trying… (last known state below)` });
  }
  const d = view.data;
  if (d.server.pressure) out.push({ cls: 'warn', text: `The server is under pressure (${d.server.reason || 'little memory left'}): everything takes longer.` });
  const max = expanded ? 12 : 3;
  const acts = d.activities;
  for (const a of acts.slice(0, max)) out.push({ cls: a.ended ? (a.ended.failed ? 'bad' : 'ok') : a.background ? 'bg' : '', text: `${a.ended ? (a.ended.failed ? '✗' : '✓') : '●'} ${activityLine(a)}` });
  if (acts.length > max) out.push({ cls: 'bg', text: `…and ${acts.length - max} more` });
  if (!acts.some((a) => !a.ended)) {
    // nothing registered: the older "busy" words, or the plain fact that the server is idle
    const busy = d.server.busy.filter(Boolean);
    if (busy.length) for (const b of busy.slice(0, max)) out.push({ cls: 'bg', text: `● ${b}` });
    else out.push({ cls: 'bg', text: 'The server reports no work in progress: the wait is on the connection, or on this device.' });
  }
  const logs = d.recent.slice(expanded ? -6 : -2);
  for (const l of logs) out.push({ cls: `log${l.level === 'info' ? '' : ' bad'}`, text: `${sec(l.agoMs + (now - view.answeredAt))} ago · ${l.text}` });
  return out;
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
  const head = document.createElement('div');
  head.className = 'sa-head';
  const spin = document.createElement('span');
  spin.className = 'sa-spin';
  const headText = document.createElement('span');
  head.append(spin, headText);
  const body = document.createElement('div');
  const more = document.createElement('div');
  more.className = 'sa-more';
  root.append(head, body, more);
  const attach = (): void => void document.body.appendChild(root);
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  let expanded = false;
  try {
    expanded = localStorage.getItem('streamanywhere.activity.expanded') === '1';
  } catch {
    /* storage unavailable */
  }
  // its own clicks only: a tap on the strip must not pause the video under it
  for (const type of ['click', 'pointerdown', 'pointerup', 'mousedown', 'touchstart'] as const) {
    root.addEventListener(
      type,
      (e) => {
        e.stopPropagation();
        if (type !== 'click') return;
        expanded = !expanded;
        try {
          localStorage.setItem('streamanywhere.activity.expanded', expanded ? '1' : '0');
        } catch {
          /* storage unavailable */
        }
        render();
      },
      { passive: true },
    );
  }

  const view: ServerView = { answeredAt: 0, since: 0, askedAt: 0, failures: 0, unsupported: false, locked: false };
  let lastAskAt = 0;
  let ticker = 0;
  let shownAt = 0;
  /** The last wait that was on show, kept for the lingering strip */
  let lastWait: Wait | undefined;
  let lastWaitEndedAt = 0;

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
    // the waits somebody is held up by; the quiet ones only count ("+2 more") while the strip is up
    const waits = all.filter((w) => !isQuiet(w));
    const oldest = waits[0];
    if (oldest) lastWait = oldest;
    const due = oldest && now - oldest.startedAt >= SHOW_AFTER_MS;
    const lingering = !oldest && shownAt > 0 && now - lastWaitEndedAt < LINGER_MS;
    if (!due && !lingering) {
      if (!all.length) stop();
      root.classList.add('hidden');
      if (!oldest) shownAt = 0;
      return;
    }
    if (!shownAt) {
      shownAt = now;
      // a new wait: what the server said during the last one is history
      view.data = undefined;
      view.answeredAt = view.since = now;
      view.failures = 0;
      lastAskAt = 0;
    }
    root.classList.remove('hidden');
    root.classList.toggle('idle', !oldest);
    const w = oldest || lastWait;
    const others = all.length - 1;
    const headLine = oldest ? `${w!.label}… ${sec(now - w!.startedAt)}${others > 0 ? ` (+${others} more)` : ''}` : `${w ? w.label : 'Done'}: finished`;
    if (headText.textContent !== headLine) headText.textContent = headLine;
    const lines = stripLines(view, now, expanded);
    // rebuilt only when the text changed: the strip is read, not animated
    const sig = lines.map((l) => l.cls + '|' + l.text).join('\n');
    if (body.dataset.sig !== sig) {
      body.dataset.sig = sig;
      body.textContent = '';
      for (const l of lines) {
        const div = document.createElement('div');
        div.className = `sa-line ${l.cls}`;
        div.textContent = l.text;
        body.appendChild(div);
      }
    }
    const hint = view.unsupported ? 'This server does not report what it is doing (an older build).' : view.locked ? '' : expanded ? 'Tap for fewer details' : 'Tap for more details';
    if (more.textContent !== hint) more.textContent = hint;
    if (oldest && !view.askedAt && now - lastAskAt >= ASK_EVERY_MS - 100) void ask();
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
    const waits = currentWaits();
    if (waits.length) start();
    if (shownAt && !waits.some((w) => !isQuiet(w))) {
      lastWaitEndedAt = Date.now();
      // one more look at the server: how the work ended ("done in 12 s", "failed: …")
      void ask();
    }
    render();
  });
}

mount();
