/**
 * The last few hundred log lines, kept in memory and served by GET /api/log, so a problem on the
 * VM can be read from a browser (with the site password) instead of over SSH. Pino's JSON lines
 * pass through to stdout (journald) unchanged.
 *
 * stdout is written off the event loop. On Windows Node writes to a stdout *pipe* synchronously
 * (lib/net.js makeSyncWrite), so once the process reading the pipe (the desktop app's dev-server
 * runner, `| tee`, any spawn with piped stdio) stops draining it, the next log line blocks the main
 * thread until the reader catches up: after ~80 KB of unread output the whole server stopped
 * answering HTTP, /api/health included, with nothing logged (seen 2026-10-16). On POSIX
 * (journald on the VM) the pipe write is asynchronous but nothing bounds the backlog, so a stalled
 * reader grows memory instead. Here each chunk is queued and handed to fs.write(1, ...) one at a
 * time, which runs on libuv's thread pool and never stalls the loop. The queue is capped; while
 * nobody reads, the oldest lines are dropped and counted, and a single warning line reports the
 * count once writes flow again. The ring buffer keeps every line regardless. A TTY keeps the plain
 * process.stdout.write.
 */
import { write as fsWrite } from 'node:fs';
import { hostname } from 'node:os';

const MAX_LINES = 800;
const lines: string[] = [];

function push(line: string): void {
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

// ---- asynchronous stdout ------------------------------------------------------------------------

const STDOUT_FD = 1;
/** Queued (not yet handed to fs.write) bytes beyond this are shed, oldest first. */
const MAX_QUEUED_BYTES = 256 * 1024;
const queue: Buffer[] = [];
let queuedBytes = 0;
/** The chunk (or the unwritten tail of it) currently with fs.write. */
let inFlight: Buffer | null = null;
/** Set on a write error (EPIPE, EBADF, ...): stdout is given up for good, the ring buffer stays. */
let stdoutGone = false;
let droppedLines = 0;

function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return n || 1;
}

function enqueue(chunk: string): void {
  if (stdoutGone) return;
  const buf = Buffer.from(chunk, 'utf8');
  queue.push(buf);
  queuedBytes += buf.length;
  // Shed the oldest queued lines (never the one in flight, never the only one) until under the cap.
  while (queuedBytes > MAX_QUEUED_BYTES && queue.length > 1) {
    const old = queue.shift() as Buffer;
    queuedBytes -= old.length;
    droppedLines += countLines(old);
  }
  pump();
}

function pump(): void {
  if (inFlight || stdoutGone) return;
  const next = queue.shift();
  if (!next) return;
  queuedBytes -= next.length;
  inFlight = next;
  writeInFlight();
}

function writeInFlight(): void {
  const buf = inFlight as Buffer;
  fsWrite(STDOUT_FD, buf, 0, buf.length, null, (err, written) => {
    if (err) {
      if (err.code === 'EAGAIN') {
        // A non-blocking pipe that is full right now: try again shortly, the data is still ours.
        setTimeout(writeInFlight, 20).unref();
        return;
      }
      stdoutGone = true;
      inFlight = null;
      queue.length = 0;
      queuedBytes = 0;
      return;
    }
    if (written < buf.length) {
      inFlight = buf.subarray(written);
      writeInFlight();
      return;
    }
    inFlight = null;
    if (droppedLines > 0) {
      // Writes flow again: say what was lost, in the gap where it was lost (before the newer lines).
      const warn = JSON.stringify({
        level: 40,
        time: Date.now(),
        pid: process.pid,
        hostname: hostname(),
        msg: `stdout was not being read: ${droppedLines} log line(s) dropped (the in-memory tail at /api/log kept them)`,
      });
      droppedLines = 0;
      const wbuf = Buffer.from(warn + '\n', 'utf8');
      queue.unshift(wbuf);
      queuedBytes += wbuf.length;
    }
    pump();
  });
}

const toStdout: (chunk: string) => void = process.stdout.isTTY ? (chunk) => void process.stdout.write(chunk) : enqueue;

/** A pino destination: tees every line into the ring buffer. */
export const logStream = {
  write(chunk: string): void {
    toStdout(chunk);
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
