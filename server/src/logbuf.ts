/**
 * The last few hundred log lines, kept in memory and served by GET /api/log, so a problem on the
 * VM can be read from a browser (with the site password) instead of over SSH. Pino's JSON lines
 * pass through to stdout (journald) unchanged.
 */
const MAX_LINES = 800;
const lines: string[] = [];

function push(line: string): void {
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

/** A pino destination: tees every line into the ring buffer. */
export const logStream = {
  write(chunk: string): void {
    process.stdout.write(chunk);
    for (const l of String(chunk).split('\n')) if (l.trim()) push(l);
  },
};

const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const SKIP = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'reqId', 'v']);

/** Readable text, newest last: `HH:MM:SS LEVEL msg key=value ...` */
export function recentLog(count = 300, minLevel = 30): string {
  const out: string[] = [];
  for (const raw of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw);
    } catch {
      out.push(raw);
      continue;
    }
    const level = Number(rec.level) || 30;
    if (level < minLevel) continue;
    const t = new Date(Number(rec.time) || Date.now()).toISOString().slice(11, 19);
    const extras = Object.entries(rec)
      .filter(([k]) => !SKIP.has(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    out.push(`${t} ${LEVELS[level] || level} ${rec.msg || ''}${extras ? '  ' + extras : ''}`);
  }
  return out.slice(-count).join('\n');
}
