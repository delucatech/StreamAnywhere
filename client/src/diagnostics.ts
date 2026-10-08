/**
 * Experiments panel: six measured tests comparing access paths and rendering approaches.
 * Every result is produced by actually performing the operation in this browser.
 */
import type { Sample } from 'mp4box';
import type { MediaFormat, ResolveResponse } from '../../shared/types';
import { apiUrl } from './api';
import { testFetch, testVideoElement, type FetchTestResult } from './cors-test';
import { Mp4Demuxer } from './media/demuxer';

export type ExperimentStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip';

export interface ExperimentResult {
  id: string;
  name: string;
  expected: string;
  status: ExperimentStatus;
  summary: string;
  details: string;
  data?: unknown;
}

export interface DiagContext {
  testUrl: string;
  /** Last resolved TikTok response, or a function that resolves one on demand */
  getTikTok: () => Promise<ResolveResponse | undefined>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const EXPERIMENTS: Omit<ExperimentResult, 'status' | 'summary' | 'details'>[] = [
  { id: 'video-direct', name: 'Direct MP4 in HTML5 <video>', expected: 'Baseline: loads with crossorigin="anonymous"' },
  { id: 'canvas-copy', name: 'Direct MP4 drawn into Canvas', expected: 'Frame copy works and canvas stays untainted' },
  { id: 'webcodecs', name: 'Direct MP4 decoded with WebCodecs', expected: 'fetch → demux → VideoDecoder emits frames' },
  { id: 'tiktok-fetch', name: 'TikTok resolved URL with fetch()', expected: 'Cookie-bound URL fails; cookie-free CDN URL passes CORS' },
  { id: 'tiktok-proxy', name: 'TikTok via media proxy', expected: 'Controlled fallback: 206 + MP4 bytes from /api/media' },
  { id: 'tiktok-iframe', name: 'TikTok official iframe', expected: 'Loads, but media bytes are not accessible to the page' },
];

export function initialResults(): ExperimentResult[] {
  return EXPERIMENTS.map((e) => ({ ...e, status: 'pending', summary: '', details: '' }));
}

function fmtFetch(r: FetchTestResult): string {
  if (r.ok) {
    return `HTTP ${r.status} in ${r.elapsedMs.toFixed(0)} ms, type=${r.responseType}, content-type=${r.contentType}, content-range=${r.contentRange ?? 'hidden/none'}, first bytes: ${r.firstBytesHex}${r.redirected ? ' (redirected)' : ''}`;
  }
  return `${r.error} (${r.errorKind}) after ${r.elapsedMs.toFixed(0)} ms`;
}

interface HeadlessResult {
  ok: boolean;
  frames: number;
  firstFrameMs?: number;
  codec?: string;
  audioCodec?: string;
  audioSupported?: boolean;
  width?: number;
  height?: number;
  progressive?: boolean;
  error?: string;
  elapsedMs: number;
  bytes: number;
}

/** Decode the first N frames of an MP4 with WebCodecs without touching the page's canvas. */
export function headlessWebCodecs(url: string, init: RequestInit | undefined, maxFrames = 30, timeoutMs = 20_000): Promise<HeadlessResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let frames = 0;
    let firstFrameMs: number | undefined;
    let decoder: VideoDecoder | undefined;
    let done = false;
    let queued: Sample[] = [];
    let sent = 0;
    let bytes = 0;
    let streamEnded = false;
    let flushed = false;
    let ready = false;
    const out: Partial<HeadlessResult> = {};
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      demuxer.destroy();
      try {
        decoder?.close();
      } catch {
        /* ignore */
      }
      resolve({ ok, frames, firstFrameMs, error, elapsedMs: performance.now() - t0, bytes, ...out });
    };
    const timer = setTimeout(() => finish(frames > 0, frames > 0 ? undefined : 'timed out before the first frame'), timeoutMs);
    const flushOnce = () => {
      if (flushed || !decoder || decoder.state !== 'configured') return;
      flushed = true;
      decoder.flush().then(() => finish(frames > 0, frames > 0 ? undefined : 'stream ended without frames'), () => finish(frames > 0));
    };
    const pump = () => {
      if (!decoder || decoder.state !== 'configured' || flushed) return;
      while (queued.length && sent < maxFrames + 8 && decoder.decodeQueueSize < 8) {
        const s = queued.shift()!;
        if (sent === 0 && !s.is_sync) continue;
        try {
          decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round((s.cts * 1e6) / s.timescale), duration: Math.round((s.duration * 1e6) / s.timescale), data: s.data! }));
          sent++;
        } catch (e) {
          finish(false, `decode() threw: ${(e as Error).message}`);
          return;
        }
      }
      // Flush only when nothing more will be decoded: a decode() after flush() needs a key frame.
      if ((sent >= maxFrames + 8 || (streamEnded && !queued.length)) && !done) flushOnce();
    };
    const demuxer = new Mp4Demuxer(url, init, {
      onReady: async (movie, video, audio) => {
        ready = true;
        out.progressive = movie.isProgressive;
        if (!video?.videoConfig) {
          finish(false, 'no video track');
          return;
        }
        out.codec = video.codec;
        out.width = video.width;
        out.height = video.height;
        out.audioCodec = audio?.codec;
        try {
          const s = await VideoDecoder.isConfigSupported(video.videoConfig);
          if (!s.supported) {
            finish(false, `VideoDecoder does not support ${video.codec}`);
            return;
          }
          if (audio?.audioConfig && typeof AudioDecoder !== 'undefined') out.audioSupported = (await AudioDecoder.isConfigSupported(audio.audioConfig)).supported;
        } catch (e) {
          finish(false, `isConfigSupported threw: ${(e as Error).message}`);
          return;
        }
        if (done) return;
        decoder = new VideoDecoder({
          output: (f) => {
            frames++;
            if (frames === 1) firstFrameMs = performance.now() - t0;
            f.close();
            if (frames >= maxFrames) finish(true);
            else pump();
          },
          error: (e) => finish(false, `VideoDecoder error: ${e.message}`),
        });
        decoder.configure(video.videoConfig);
        pump();
      },
      onVideoSamples: (samples) => {
        queued.push(...samples);
        pump();
      },
      onAudioSamples: () => undefined,
      onProgress: (loaded) => (bytes = loaded),
      onEnd: () => {
        streamEnded = true;
        if (!ready) {
          finish(false, 'stream ended before moov was parsed');
          return;
        }
        pump(); // decodes what is left and flushes once the queue is empty (decoder may still be configuring)
      },
      onError: (e) => finish(false, e.message),
      onLog: () => undefined,
    });
    demuxer.start();
  });
}

function pickFormat(tt: ResolveResponse): MediaFormat | undefined {
  return tt.formats.find((f) => f.codec === 'h264') || tt.formats[0];
}

export async function runExperiments(ctx: DiagContext, onUpdate: (results: ExperimentResult[]) => void): Promise<ExperimentResult[]> {
  const results = initialResults();
  const set = (id: string, patch: Partial<ExperimentResult>) => {
    const r = results.find((x) => x.id === id)!;
    Object.assign(r, patch);
    onUpdate(results);
  };
  const corsInit: RequestInit = { mode: 'cors', credentials: 'omit' };

  // 1. <video> baseline
  set('video-direct', { status: 'running' });
  const v1 = await testVideoElement(ctx.testUrl, 'anonymous');
  set('video-direct', {
    status: v1.ok ? 'pass' : 'fail',
    summary: v1.ok ? `${v1.width}×${v1.height}, ${v1.duration?.toFixed(1)} s` : v1.error || 'failed',
    details: v1.ok
      ? `Loaded in ${v1.elapsedMs.toFixed(0)} ms with crossorigin="anonymous" from ${ctx.testUrl}. The browser's media stack fetched and decoded the file; the page only observes metadata.`
      : `Failed (${v1.error}). With crossorigin="anonymous" the load obeys CORS: the server must send Access-Control-Allow-Origin for this origin.`,
    data: v1,
  });

  // 2. canvas copy
  set('canvas-copy', { status: 'running' });
  const v2 = await testVideoElement(ctx.testUrl, 'anonymous', true);
  set('canvas-copy', {
    status: v2.ok && v2.tainted === false ? 'pass' : 'fail',
    summary: v2.ok ? (v2.tainted ? 'drawn, but canvas tainted' : 'drawn, canvas readable') : v2.error || 'failed',
    details: v2.ok
      ? `drawImage(video) succeeded and getImageData() ${v2.tainted ? 'threw SecurityError: the canvas is tainted because the media was loaded without CORS approval' : 'returned pixels: CORS approval keeps the canvas readable'}. Copying a native video frame does not change the browser's media policy.`
      : `The <video> element could not load the file, so nothing could be drawn (${v2.error}).`,
    data: v2,
  });

  // 3. WebCodecs decode
  set('webcodecs', { status: 'running' });
  if (typeof VideoDecoder === 'undefined') {
    set('webcodecs', { status: 'fail', summary: 'WebCodecs unavailable', details: 'This browser has no VideoDecoder. Use Chrome/Chromium/Edge 94+ (or Safari 16.4+ / Firefox 130+ for parts of WebCodecs).' });
  } else {
    const h = await headlessWebCodecs(ctx.testUrl, corsInit);
    set('webcodecs', {
      status: h.ok ? 'pass' : 'fail',
      summary: h.ok ? `${h.frames} frames decoded, first after ${h.firstFrameMs?.toFixed(0)} ms` : h.error || 'failed',
      details: h.ok
        ? `fetch() streamed ${h.bytes} bytes, mp4box parsed moov (progressive=${h.progressive}), VideoDecoder(${h.codec}) produced ${h.frames} VideoFrames at ${h.width}×${h.height}. Audio track: ${h.audioCodec || 'none'}${h.audioSupported !== undefined ? ` (AudioDecoder supported: ${h.audioSupported})` : ''}. This path needs raw bytes, so it only works where fetch() passes CORS.`
        : `${h.error}. If the error mentions CORS, the server did not allow this origin to read the bytes; if it names the codec, the decoder lacks support for it.`,
      data: h,
    });
  }

  // 4–6. TikTok
  let tt: ResolveResponse | undefined;
  try {
    tt = await ctx.getTikTok();
  } catch (e) {
    ctx.log('warn', `TikTok resolution for experiments failed: ${(e as Error).message}`);
    for (const id of ['tiktok-fetch', 'tiktok-proxy', 'tiktok-iframe']) set(id, { status: 'fail', summary: 'resolver failed', details: (e as Error).message });
    return results;
  }
  if (!tt) {
    for (const id of ['tiktok-fetch', 'tiktok-proxy', 'tiktok-iframe']) set(id, { status: 'skip', summary: 'no TikTok URL', details: 'Enter a TikTok video URL above (or load one) to run the TikTok experiments.' });
    return results;
  }
  const f = pickFormat(tt);
  if (!f) {
    for (const id of ['tiktok-fetch', 'tiktok-proxy']) set(id, { status: 'fail', summary: 'no formats', details: 'Resolver returned no formats.' });
  } else {
    set('tiktok-fetch', { status: 'running' });
    const lines: string[] = [];
    const data: Record<string, FetchTestResult> = {};
    let anyDirect = false;
    if (f.cookieBoundUrl) {
      const r = await testFetch(f.cookieBoundUrl, corsInit);
      data.cookieBound = r;
      lines.push(`• cookie-bound playAddr (${new URL(f.cookieBoundUrl).hostname}): ${r.ok ? 'UNEXPECTEDLY PASSED' : 'blocked'} — ${fmtFetch(r)}`);
    }
    if (f.redirectUrl) {
      const r = await testFetch(f.redirectUrl, corsInit);
      data.redirect = r;
      anyDirect ||= r.ok;
      lines.push(`• cookie-free redirect URL (www.tiktok.com/aweme/v1/play): ${r.ok ? 'passed' : 'failed'} — ${fmtFetch(r)}`);
    }
    if (f.directUrl && f.directUrl !== f.redirectUrl) {
      const r = await testFetch(f.directUrl, corsInit);
      data.cdn = r;
      anyDirect ||= r.ok;
      lines.push(`• resolved CDN URL (${new URL(f.directUrl).hostname}): ${r.ok ? 'passed' : 'failed'} — ${fmtFetch(r)}`);
    }
    if (!f.redirectUrl && !f.directUrl) lines.push('• resolver found no cookie-free URL for this format');
    const sp = f.serverProbe;
    if (sp) lines.push(`• server-side probe of the direct URL saw HTTP ${sp.status}, Access-Control-Allow-Origin: ${sp.headers.accessControlAllowOrigin ?? 'none'}, Accept-Ranges: ${sp.headers.acceptRanges ?? 'none'}`);
    lines.push(
      anyDirect
        ? 'Why it works: the /aweme/v1/play redirect and the tiktokcdn-*.com target need no cookies and send Access-Control-Allow-Origin: *, so fetch() can read the bytes with Range requests.'
        : 'Why it fails: playAddr URLs are signed for the resolver session cookie (tt_chain_token), require a tiktok.com Referer, and answer with Access-Control-Allow-Origin: https://www.tiktok.com, which never matches this origin.',
    );
    set('tiktok-fetch', { status: anyDirect ? 'pass' : 'fail', summary: anyDirect ? 'direct CDN fetch passed CORS' : 'no direct URL readable', details: lines.join('\n'), data });

    set('tiktok-proxy', { status: 'running' });
    if (!f.proxyUrl) {
      set('tiktok-proxy', { status: 'fail', summary: 'no proxy URL', details: 'Resolver did not offer a proxy URL for this format.' });
    } else {
      const r = await testFetch(apiUrl(f.proxyUrl), { mode: 'cors', credentials: 'omit' });
      set('tiktok-proxy', {
        status: r.ok ? 'pass' : 'fail',
        summary: r.ok ? `HTTP ${r.status} via ${apiUrl(f.proxyUrl)}` : r.error || 'failed',
        details: `${fmtFetch(r)}\nThe proxy adds the Referer and session cookies TikTok's primary CDN demands and re-exposes the stream same-origin with Range support. It is the controlled fallback when direct access is impossible; the server logs every relayed request.`,
        data: r,
      });
    }
  }

  set('tiktok-iframe', { status: 'running' });
  const iframeResult = await new Promise<{ ok: boolean; ms: number }>((resolve) => {
    const t0 = performance.now();
    const ifr = document.createElement('iframe');
    ifr.style.cssText = 'position:absolute;width:2px;height:2px;opacity:0;pointer-events:none';
    ifr.src = `https://www.tiktok.com/player/v1/${encodeURIComponent(tt!.id)}?autoplay=0`;
    const timer = setTimeout(() => {
      ifr.remove();
      resolve({ ok: false, ms: performance.now() - t0 });
    }, 15_000);
    ifr.addEventListener('load', () => {
      clearTimeout(timer);
      const ms = performance.now() - t0;
      setTimeout(() => ifr.remove(), 500);
      resolve({ ok: true, ms });
    });
    document.body.appendChild(ifr);
  });
  set('tiktok-iframe', {
    status: iframeResult.ok ? 'pass' : 'fail',
    summary: iframeResult.ok ? `iframe loaded in ${iframeResult.ms.toFixed(0)} ms` : 'iframe did not fire load',
    details: iframeResult.ok
      ? `https://www.tiktok.com/player/v1/${tt.id} loaded. Its document is cross-origin: this page cannot read its DOM, its <video> element, or any media bytes — a working embed is not evidence of raw media access. Playback inside the iframe uses TikTok's own cookies and signed URLs.`
      : 'The load event never fired (blocked by a content blocker, network error, or the video cannot be embedded).',
  });
  return results;
}
