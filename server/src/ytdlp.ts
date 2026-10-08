/**
 * yt-dlp fallback resolver. yt-dlp (2026.08.19 verified) returns cookie-bound
 * v16/v19-webapp-prime.<region>.tiktok.com URLs plus the cookies/Referer it used. Those
 * URLs can only be fetched with the same cookies, so they are exposed through the proxy only.
 * yt-dlp does not surface the cookie-free /aweme/v1/play redirect, so the native resolver is
 * preferred when it works.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MediaFormat, ResolveResponse } from '../../shared/types';
import { config } from './config';
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

export async function resolveWithYtDlp(inputUrl: string): Promise<ResolveResponse> {
  const t0 = Date.now();
  const det = await detectYtDlp();
  if (!det.available || !cached) throw new Error(`yt-dlp unavailable: ${det.error}`);
  const r = await run(cached.c, ['-j', '--no-warnings', '--no-playlist', inputUrl], 90_000);
  if (r.code !== 0 || !r.stdout.trim()) {
    const err = r.stderr.split(/\r?\n/).filter((l) => /ERROR/i.test(l)).pop() || r.stderr.trim().slice(-300) || `exit ${r.code}`;
    throw new Error(`yt-dlp failed: ${err}`);
  }
  const info = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
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
