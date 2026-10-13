/**
 * yt-dlp: the TikTok fallback resolver and everything YouTube (search, listings, formats).
 *
 * Two ways to run it:
 *  - warm daemons (scripts/ytdlp-daemon.py): a Python process that imports yt_dlp once and answers
 *    extraction requests as JSON lines. Importing yt_dlp costs ~11 s of CPU on the free e2-micro
 *    VM (1 s on a PC), so the CLI-per-request way made every YouTube call 25-120 s there.
 *  - the CLI, when no Python that can import yt_dlp is found (and for the TikTok fallback).
 *
 * TikTok: yt-dlp (2026.08.19 verified) returns cookie-bound v16/v19-webapp-prime.<region>.tiktok.com
 * URLs plus the cookies/Referer it used. Those URLs can only be fetched with the same cookies, so
 * they are exposed through the proxy only; the native resolver is preferred when it works.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { MediaFormat, ResolveResponse } from '../../shared/types';
import { config, findUp } from './config';
import { defaultExpiry, registerMedia } from './mediaStore';

interface Candidate {
  cmd: string;
  args: string[];
  label: string;
}

function candidates(): Candidate[] {
  const list: Candidate[] = [];
  if (config.ytdlpPath) list.push({ cmd: config.ytdlpPath, args: [], label: config.ytdlpPath });
  list.push({ cmd: 'yt-dlp', args: [], label: 'yt-dlp (PATH)' });
  // pip --user installs on Windows land in %APPDATA%\Python\PythonXY\Scripts
  if (process.platform === 'win32') {
    const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Python');
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        const exe = path.join(base, d, 'Scripts', 'yt-dlp.exe');
        if (fs.existsSync(exe)) list.push({ cmd: exe, args: [], label: exe });
      }
    }
  }
  list.push({ cmd: 'python', args: ['-m', 'yt_dlp'], label: 'python -m yt_dlp' });
  list.push({ cmd: 'python3', args: ['-m', 'yt_dlp'], label: 'python3 -m yt_dlp' });
  list.push({ cmd: 'py', args: ['-m', 'yt_dlp'], label: 'py -m yt_dlp' });
  return list;
}

function run(c: Candidate, extra: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(c.cmd, [...c.args, ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let cached: { c: Candidate; version: string } | null | undefined;

export async function detectYtDlp(): Promise<{ available: boolean; version?: string; command?: string; error?: string }> {
  if (cached !== undefined) return cached ? { available: true, version: cached.version, command: cached.c.label } : { available: false, error: 'yt-dlp not found' };
  const errors: string[] = [];
  for (const c of candidates()) {
    try {
      const r = await run(c, ['--version'], 15_000);
      const version = r.stdout.trim().split(/\r?\n/).pop() || '';
      if (r.code === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(version)) {
        cached = { c, version };
        return { available: true, version, command: c.label };
      }
      errors.push(`${c.label}: exit ${r.code}`);
    } catch (e) {
      errors.push(`${c.label}: ${(e as Error).message}`);
    }
  }
  cached = null;
  return { available: false, error: errors.join('; ') };
}

/** The number of yt-dlp processes running at once (a Python start costs ~1 s and ~60 MB; the VM has 1 GB). */
const MAX_PARALLEL = 2;
let running = 0;
const queue: (() => void)[] = [];

/**
 * Runs yt-dlp with `args` and returns its stdout; throws with yt-dlp's last ERROR line otherwise.
 * At most MAX_PARALLEL run concurrently, the rest wait their turn.
 */
export async function ytdlp(args: string[], timeoutMs = 90_000): Promise<string> {
  const det = await detectYtDlp();
  if (!det.available || !cached) throw new Error(`yt-dlp unavailable: ${det.error}`);
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
  running++;
  try {
    const r = await run(cached.c, ['--no-warnings', ...args], timeoutMs);
    if (r.code !== 0 || !r.stdout.trim()) {
      const err = r.stderr.split(/\r?\n/).filter((l) => /ERROR/i.test(l)).pop() || r.stderr.trim().slice(-300) || `exit ${r.code}`;
      throw new Error(`yt-dlp failed: ${err.replace(/^ERROR:\s*/, '')}`);
    }
    return r.stdout;
  } finally {
    running--;
    queue.shift()?.();
  }
}

// ---------------------------------------------------------------- warm daemons

/** One extraction: what `yt-dlp -j` / `--flat-playlist -J --playlist-items` would print, parsed. */
export interface InfoRequest {
  url: string;
  /** --flat-playlist (listings: search, hashtag, channel) */
  flat?: boolean;
  /** --playlist-items, e.g. "1-30" */
  playlistItems?: string;
  /** --no-playlist (a single video) */
  noplaylist?: boolean;
  /** --cookies: a Netscape cookies.txt (the YouTube sign-in); yt-dlp writes rotated cookies back to it */
  cookieFile?: string;
}

const DAEMONS = Math.max(1, Number(process.env.YTDLP_DAEMONS) || 2);
const DAEMON_SCRIPT = findUp(path.join('server', 'scripts', 'ytdlp-daemon.py')) || findUp(path.join('server', 'scripts', 'ytdlp-daemon.py'), process.cwd());

interface Pending {
  id: number;
  resolve: (info: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** A Python process with yt_dlp imported; handles one request at a time. */
class Daemon {
  proc?: ChildProcess;
  pending?: Pending;
  version = '';
  /** Resolves true when the process answered its hello line */
  readonly ready: Promise<boolean>;
  private nextId = 1;
  private dead = false;

  constructor(private readonly python: { cmd: string; args: string[] }, private readonly onLog: (m: string) => void) {
    this.ready = this.start();
  }

  get busy(): boolean {
    return Boolean(this.pending);
  }
  get alive(): boolean {
    return Boolean(this.proc) && !this.dead;
  }

  private start(): Promise<boolean> {
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(this.python.cmd, [...this.python.args, DAEMON_SCRIPT!], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', YTDLP_PATH: config.ytdlpPath },
        });
      } catch (e) {
        this.onLog(`daemon spawn failed: ${(e as Error).message}`);
        resolve(false);
        return;
      }
      this.proc = proc;
      let hello = false;
      let stderr = '';
      proc.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      proc.on('error', (e) => {
        this.onLog(`daemon error: ${e.message}`);
        this.die(new Error(`yt-dlp daemon: ${e.message}`));
        resolve(false);
      });
      proc.on('close', (code) => {
        this.die(new Error(`yt-dlp daemon exited (${code}): ${stderr.trim().split(/\r?\n/).pop() || ''}`));
        resolve(false);
      });
      const rl = readline.createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        let msg: { id: number; ok: boolean; info?: unknown; error?: string; version?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (!hello) {
          hello = true;
          if (msg.ok) {
            this.version = msg.version || '';
            this.onLog(`daemon ready (${this.python.cmd}, yt-dlp ${this.version})`);
            resolve(true);
          } else {
            this.onLog(`daemon could not start: ${msg.error}`);
            this.kill();
            resolve(false);
          }
          return;
        }
        const p = this.pending;
        if (!p || p.id !== msg.id) return;
        clearTimeout(p.timer);
        this.pending = undefined;
        if (msg.ok) p.resolve(msg.info);
        else p.reject(new Error(`yt-dlp failed: ${msg.error || 'unknown error'}`));
      });
    });
  }

  request(req: InfoRequest, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.dead) return reject(new Error('yt-dlp daemon is not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        // A stuck extraction takes the process with it; the pool starts a fresh one next time.
        this.onLog(`daemon request ${id} timed out after ${timeoutMs} ms; restarting the daemon`);
        this.die(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending = { id, resolve, reject, timer };
      const body: Record<string, unknown> = { id, url: req.url, flat: Boolean(req.flat), noplaylist: Boolean(req.noplaylist) };
      if (req.playlistItems) body.playlist_items = req.playlistItems;
      if (req.cookieFile) body.cookiefile = req.cookieFile;
      this.proc.stdin!.write(JSON.stringify(body) + '\n');
    });
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    const p = this.pending;
    this.pending = undefined;
    if (p) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.kill();
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }
}

/** Interpreters that may import yt_dlp, in order; YTDLP_PYTHON first. */
function pythonCandidates(): { cmd: string; args: string[] }[] {
  const list: { cmd: string; args: string[] }[] = [];
  if (process.env.YTDLP_PYTHON) list.push({ cmd: process.env.YTDLP_PYTHON, args: [] });
  if (process.platform !== 'win32') list.push({ cmd: '/opt/ytdlp/bin/python3', args: [] });
  list.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
  if (process.platform === 'win32') list.push({ cmd: 'py', args: ['-3'] });
  return list;
}

const pool: Daemon[] = [];
let daemonPython: { cmd: string; args: string[] } | null | undefined;
let daemonProbe: Promise<void> | undefined;
const waiters: (() => void)[] = [];
let daemonLog: (m: string) => void = () => undefined;
export const setYtDlpLogger = (log: (m: string) => void): void => {
  daemonLog = log;
};

/** Finds (once) a Python that can run the daemon; null when none can. */
async function probeDaemon(): Promise<void> {
  if (daemonPython !== undefined) return;
  if (!daemonProbe) {
    daemonProbe = (async () => {
      if (!DAEMON_SCRIPT || /^(0|false|no)$/i.test(process.env.YTDLP_DAEMON || '')) {
        daemonPython = null;
        return;
      }
      for (const py of pythonCandidates()) {
        const d = new Daemon(py, daemonLog);
        if (await d.ready) {
          daemonPython = py;
          pool.push(d);
          return;
        }
      }
      daemonLog('no Python can import yt_dlp; falling back to the yt-dlp command line per request');
      daemonPython = null;
    })();
  }
  await daemonProbe;
}

async function acquire(): Promise<Daemon> {
  for (;;) {
    for (let i = pool.length - 1; i >= 0; i--) if (!pool[i].alive) pool.splice(i, 1);
    const free = pool.find((d) => !d.busy);
    if (free) return free;
    if (pool.length < DAEMONS) {
      const d = new Daemon(daemonPython!, daemonLog);
      pool.push(d);
      if (await d.ready) return d;
      continue;
    }
    await new Promise<void>((r) => waiters.push(r));
  }
}

export const daemonStatus = (): { enabled: boolean; python?: string; running: number; busy: number; version?: string } => ({
  enabled: Boolean(daemonPython),
  python: daemonPython?.cmd,
  running: pool.filter((d) => d.alive).length,
  busy: pool.filter((d) => d.busy).length,
  version: pool[0]?.version,
});

/**
 * One extraction as parsed JSON, through a warm daemon when there is one, else the CLI.
 * Daemon requests are serialised per process (DAEMONS of them, default 2).
 */
export async function ytdlpInfo(req: InfoRequest, timeoutMs = 150_000): Promise<any> {
  await probeDaemon();
  if (daemonPython) {
    const d = await acquire();
    try {
      return await d.request(req, timeoutMs);
    } finally {
      waiters.shift()?.();
    }
  }
  const args = req.flat ? ['--flat-playlist', '-J'] : ['-j'];
  if (req.noplaylist) args.push('--no-playlist');
  if (req.playlistItems) args.push('--playlist-items', req.playlistItems);
  if (req.cookieFile) args.push('--cookies', req.cookieFile);
  args.push(req.url);
  const out = await ytdlp(args, timeoutMs);
  return JSON.parse(out.trim().split(/\r?\n/).pop()!);
}

export function shutdownYtDlp(): void {
  for (const d of pool) d.kill();
}

/** Starts the first daemon now (the import takes ~20 s on the VM; better at boot than on the first request). */
export function warmYtDlp(): void {
  void probeDaemon().catch(() => undefined);
}

export async function resolveWithYtDlp(inputUrl: string): Promise<ResolveResponse> {
  const t0 = Date.now();
  const info = await ytdlpInfo({ url: inputUrl, noplaylist: true }, 90_000);
  const warnings: string[] = ['yt-dlp URLs are cookie-bound and only usable through the proxy'];
  const formats: MediaFormat[] = [];
  const seen = new Set<string>();
  for (const f of info.formats || []) {
    if (!f.url || f.vcodec === 'none') continue;
    const baseId = String(f.format_id || '').replace(/-\d+$/, '');
    if (seen.has(baseId)) continue; // -0/-1 are mirrors of the same stream
    seen.add(baseId);
    const headers: Record<string, string> = {};
    if (f.http_headers?.Referer) headers.referer = f.http_headers.Referer;
    if (f.cookies) headers.cookie = f.cookies;
    const rec = registerMedia({ url: f.url, headers, label: `ytdlp ${info.id} ${baseId}`, source: 'tiktok', expiresAt: defaultExpiry() });
    formats.push({
      id: baseId,
      label: `${baseId} (${f.vcodec || '?'}${f.tbr ? `, ${Math.round(f.tbr)} kbps` : ''})`,
      codec: /h264|avc/i.test(f.vcodec || '') ? 'h264' : /h265|hevc|hvc|bytevc1/i.test(f.vcodec || '') ? 'h265' : 'unknown',
      codecDetail: f.vcodec,
      width: f.width || undefined,
      height: f.height || undefined,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : undefined,
      proxyUrl: `/api/media/${rec.id}`,
      mediaId: rec.id,
      requiresCookies: Boolean(f.cookies),
      upstreamHost: new URL(f.url).hostname,
    });
  }
  formats.sort((a, b) => (a.codec === 'h264' ? -1 : 1) - (b.codec === 'h264' ? -1 : 1) || (b.bitrate || 0) - (a.bitrate || 0));
  if (!formats.length) throw new Error('yt-dlp returned no video formats');
  return {
    source: 'tiktok',
    resolver: 'ytdlp',
    id: String(info.id),
    inputUrl,
    canonicalUrl: info.webpage_url,
    title: info.title,
    author: info.uploader || info.channel,
    duration: info.duration,
    width: info.width,
    height: info.height,
    cover: info.thumbnail,
    formats,
    warnings,
    elapsedMs: Date.now() - t0,
    attempts: [],
  };
}
