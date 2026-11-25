/**
 * HTTPS requests with Chrome's TLS handshake, through a warm Python helper
 * (server/scripts/tls-bridge.py, the curl_cffi package).
 *
 * Why: TikTok's web API answers some paths with an EMPTY 200 when the connection was opened the way
 * Node opens it, whatever the request says (measured 2026-11-25: comments, the signed-out For You
 * list, a profile's videos; the Explore list about 2 times in 3 from the VM). The same requests over
 * a Chrome-shaped handshake are answered. Node cannot change its handshake; curl_cffi can.
 *
 * One helper process, started on the first request and stopped after IDLE_MS without one (a Python
 * with curl_cffi holds ~35 MB, which the 1 GB VM should not carry all day). One request at a time:
 * the callers are a viewer's comments panel and its "more" button.
 *
 * The helper keeps no cookies and follows no redirects: both are the caller's (tiktokGuest.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { findUp } from './config';

const SCRIPT = findUp(path.join('server', 'scripts', 'tls-bridge.py')) || findUp(path.join('server', 'scripts', 'tls-bridge.py'), process.cwd());
const IDLE_MS = Math.max(1, Number(process.env.TIKTOK_TLS_IDLE_MIN) || 10) * 60 * 1000;
/** After no Python could import curl_cffi: look again this much later (it may have been installed since). */
const RETRY_PROBE_MS = 30 * 60 * 1000;

export class TlsBridgeError extends Error {
  /** true: no helper can run here at all (no script, no Python with curl_cffi) */
  constructor(message: string, public readonly unavailable = false) {
    super(message);
  }
}

export interface ChromeRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface ChromeAnswer {
  status: number;
  /** lower-cased names; Set-Cookie is in `cookies` */
  headers: Record<string, string>;
  /** the raw Set-Cookie lines */
  cookies: string[];
  body: Buffer;
  ms: number;
}

interface Python {
  cmd: string;
  args: string[];
}

/** Interpreters that may have curl_cffi, in order; TIKTOK_TLS_PYTHON first, then the VM's own venv (deploy/gcp/setup-vm.sh). */
function candidates(): Python[] {
  const list: Python[] = [];
  if (process.env.TIKTOK_TLS_PYTHON) list.push({ cmd: process.env.TIKTOK_TLS_PYTHON, args: [] });
  if (process.platform !== 'win32') list.push({ cmd: '/opt/tiktoktls/bin/python3', args: [] });
  list.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
  if (process.platform === 'win32') list.push({ cmd: 'py', args: ['-3'] });
  return list;
}

interface Pending {
  id: number;
  resolve: (a: ChromeAnswer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

let log: (m: string) => void = () => undefined;
export const setTlsBridgeLogger = (fn: (m: string) => void): void => {
  log = fn;
};

let proc: ChildProcess | undefined;
let pending: Pending | undefined;
let nextId = 1;
let python: Python | undefined;
let version = '';
/** Why no helper can run (set by a failed probe), and when that was found */
let unavailable: { reason: string; at: number } | undefined;
let starting: Promise<void> | undefined;
let idleTimer: NodeJS.Timeout | undefined;
/** Requests wait their turn here */
let chain: Promise<unknown> = Promise.resolve();
const stats = { requests: 0, failed: 0, starts: 0, lastError: undefined as { at: string; reason: string } | undefined };

function stop(why: string): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const p = proc;
  proc = undefined;
  if (!p) return;
  log(`TLS helper stopped (${why})`);
  try {
    p.stdin?.end(JSON.stringify({ id: 0, method: '__quit__' }) + '\n');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }, 1500).unref();
}

function failPending(err: Error): void {
  const p = pending;
  pending = undefined;
  if (!p) return;
  clearTimeout(p.timer);
  p.reject(err);
}

/** Starts the helper with one interpreter; resolves once it said hello, rejects with its reason otherwise. */
function startWith(py: Python): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(py.cmd, [...py.args, SCRIPT!], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    } catch (e) {
      reject(new Error((e as Error).message));
      return;
    }
    let hello = false;
    let stderr = '';
    const helloTimer = setTimeout(() => {
      if (hello) return;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('no answer within 30 s'));
    }, 30_000);
    child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-1500)));
    child.on('error', (e) => {
      clearTimeout(helloTimer);
      if (proc === child) proc = undefined;
      failPending(new TlsBridgeError(`the TLS helper failed: ${e.message}`));
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(helloTimer);
      if (proc === child) {
        proc = undefined;
        failPending(new TlsBridgeError(`the TLS helper exited (${code}): ${stderr.trim().split(/\r?\n/).pop() || 'no message'}`));
      }
      reject(new Error(`exited (${code}): ${stderr.trim().split(/\r?\n/).pop() || 'no message'}`));
    });
    child.stdin?.on('error', () => undefined);
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      let msg: { id?: number; ok?: boolean; error?: string; version?: string; status?: number; headers?: Record<string, string>; cookies?: string[]; body?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!hello) {
        hello = true;
        clearTimeout(helloTimer);
        if (!msg.ok) {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          reject(new Error(msg.error || 'the helper refused to start'));
          return;
        }
        version = msg.version || '';
        proc = child;
        resolve();
        return;
      }
      const p = pending;
      if (!p || p.id !== msg.id) return;
      pending = undefined;
      clearTimeout(p.timer);
      if (!msg.ok) p.reject(new TlsBridgeError(`request failed: ${msg.error || 'unknown error'}`));
      else p.resolve({ status: Number(msg.status) || 0, headers: msg.headers || {}, cookies: Array.isArray(msg.cookies) ? msg.cookies : [], body: Buffer.from(msg.body || '', 'base64'), ms: Date.now() - p.startedAt });
    });
  });
}

async function ensureStarted(): Promise<void> {
  if (proc) return;
  if (unavailable && Date.now() - unavailable.at < RETRY_PROBE_MS) throw new TlsBridgeError(unavailable.reason, true);
  if (!starting) {
    starting = (async () => {
      if (!SCRIPT) {
        unavailable = { reason: 'server/scripts/tls-bridge.py was not found', at: Date.now() };
        throw new TlsBridgeError(unavailable.reason, true);
      }
      const reasons: string[] = [];
      for (const py of python ? [python] : candidates()) {
        try {
          const t0 = Date.now();
          await startWith(py);
          python = py;
          unavailable = undefined;
          stats.starts += 1;
          log(`TLS helper ready (${py.cmd}, curl_cffi ${version}, ${Date.now() - t0} ms)`);
          return;
        } catch (e) {
          reasons.push(`${py.cmd}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      python = undefined;
      unavailable = { reason: `no Python with curl_cffi (${reasons.join('; ')})`, at: Date.now() };
      log(`TLS helper unavailable: ${unavailable.reason}`);
      throw new TlsBridgeError(unavailable.reason, true);
    })().finally(() => {
      starting = undefined;
    });
  }
  await starting;
}

function one(req: ChromeRequest): Promise<ChromeAnswer> {
  return new Promise((resolve, reject) => {
    const child = proc;
    if (!child?.stdin) return reject(new TlsBridgeError('the TLS helper is not running'));
    const id = nextId++;
    const timeoutMs = req.timeoutMs ?? 20_000;
    const timer = setTimeout(() => {
      // The helper answers one request at a time: a request that never ends would block every later one.
      if (pending?.id !== id) return;
      pending = undefined;
      stop(`a request did not end within ${Math.round(timeoutMs / 1000) + 5} s`);
      reject(new TlsBridgeError(`no answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs + 5_000);
    pending = { id, resolve, reject, timer, startedAt: Date.now() };
    child.stdin.write(JSON.stringify({ id, method: req.method || 'GET', url: req.url, headers: req.headers || {}, body: req.body ?? null, timeout: Math.ceil(timeoutMs / 1000) }) + '\n');
  });
}

/** One HTTPS request over a Chrome-shaped connection. Redirects come back as they are (3xx + Location). */
export function chromeRequest(req: ChromeRequest): Promise<ChromeAnswer> {
  const run = async (): Promise<ChromeAnswer> => {
    await ensureStarted();
    if (idleTimer) clearTimeout(idleTimer);
    stats.requests += 1;
    try {
      return await one(req);
    } catch (e) {
      stats.failed += 1;
      stats.lastError = { at: new Date().toISOString(), reason: (e as Error).message.slice(0, 200) };
      throw e;
    } finally {
      if (proc) {
        idleTimer = setTimeout(() => stop(`idle for ${Math.round(IDLE_MS / 60000)} min`), IDLE_MS);
        idleTimer.unref();
      }
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/** false once a probe found no Python with curl_cffi (asked again after RETRY_PROBE_MS) */
export const tlsBridgeUsable = (): boolean => !(unavailable && Date.now() - unavailable.at < RETRY_PROBE_MS);

export interface TlsBridgeStatus {
  /** undefined: not tried yet */
  available?: boolean;
  running: boolean;
  python?: string;
  version?: string;
  requests: number;
  failed: number;
  starts: number;
  reason?: string;
  lastError?: { at: string; reason: string };
}

export function tlsBridgeStatus(): TlsBridgeStatus {
  return {
    available: unavailable ? false : python ? true : undefined,
    running: Boolean(proc),
    python: python?.cmd,
    version: version || undefined,
    requests: stats.requests,
    failed: stats.failed,
    starts: stats.starts,
    reason: unavailable?.reason,
    lastError: stats.lastError,
  };
}

export function closeTlsBridge(): void {
  stop('server closing');
}
