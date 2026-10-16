/**
 * Where ffmpeg is: FFMPEG_PATH, else `ffmpeg` on the PATH (apt / apk / choco installs), else the
 * binary of the ffmpeg-static package (a dependency of the server; its install step downloads the
 * build for this platform). yt-dlp needs it to merge YouTube's separate video and audio files.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export interface FfmpegInfo {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

function version(cmd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(undefined);
      return;
    }
    let out = '';
    const timer = setTimeout(() => child!.kill(), 10_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = /ffmpeg version (\S+)/.exec(out);
      resolve(code === 0 && m ? m[1] : undefined);
    });
  });
}

function candidates(): string[] {
  const list: string[] = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);
  list.push('ffmpeg');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null;
    if (p && fs.existsSync(p)) list.push(p);
  } catch {
    /* package not installed */
  }
  return list;
}

let cached: Promise<FfmpegInfo> | undefined;

export function detectFfmpeg(): Promise<FfmpegInfo> {
  if (!cached) {
    cached = (async () => {
      const errors: string[] = [];
      for (const c of candidates()) {
        const v = await version(c);
        if (v) return { available: true, path: c, version: v };
        errors.push(`${c}: not runnable`);
      }
      return { available: false, error: errors.join('; ') || 'no ffmpeg' };
    })();
  }
  return cached;
}
