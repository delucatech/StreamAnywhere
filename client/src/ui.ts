export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

export type LogLevel = 'info' | 'warn' | 'error';

const logEl = () => $('log');
const MAX_LOG_LINES = 400;
const entries: { t: number; level: LogLevel; msg: string }[] = [];

export function log(level: LogLevel, msg: string): void {
  const t = performance.now();
  entries.push({ t, level, msg });
  if (entries.length > MAX_LOG_LINES) entries.shift();
  const line = document.createElement('div');
  line.className = level;
  const ts = document.createElement('span');
  ts.className = 't';
  ts.textContent = `[${(t / 1000).toFixed(3)}s] `;
  line.appendChild(ts);
  line.appendChild(document.createTextNode(msg));
  const el = logEl();
  el.appendChild(line);
  while (el.childElementCount > MAX_LOG_LINES) el.removeChild(el.firstChild!);
  el.scrollTop = el.scrollHeight;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[StreamAnywhere] ${msg}`);
}

export function clearLog(): void {
  logEl().textContent = '';
  entries.length = 0;
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function setOverlay(text: string, isError = false): void {
  const o = $('overlay');
  o.textContent = text;
  o.classList.toggle('hidden', !text);
  o.classList.toggle('error', isError);
}
