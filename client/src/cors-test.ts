/**
 * Browser-side access tests. These are the only tests that prove whether *this* browser can
 * read media bytes from a URL; server-side probes can only explain the headers it saw.
 */

export interface FetchTestResult {
  url: string;
  ok: boolean;
  status?: number;
  statusText?: string;
  /** 'cors' | 'basic' | 'opaque' ... as reported by the Response */
  responseType?: string;
  contentType?: string | null;
  contentLength?: string | null;
  contentRange?: string | null;
  acceptRanges?: string | null;
  bytes?: number;
  firstBytesHex?: string;
  error?: string;
  errorKind?: 'cors-or-network' | 'http' | 'timeout' | 'other';
  elapsedMs: number;
  redirected?: boolean;
  finalUrl?: string;
}

/** fetch(url, Range: bytes=0-15) in CORS mode without credentials. */
export async function testFetch(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<FetchTestResult> {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      ...(init || {}),
      headers: { ...(init?.headers as Record<string, string> | undefined), Range: 'bytes=0-15' },
      signal: ac.signal,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    clearTimeout(timer);
    const r: FetchTestResult = {
      url,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      responseType: res.type,
      contentType: res.headers.get('content-type'),
      contentLength: res.headers.get('content-length'),
      contentRange: res.headers.get('content-range'),
      acceptRanges: res.headers.get('accept-ranges'),
      bytes: buf.byteLength,
      firstBytesHex: Array.from(buf.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join(' '),
      elapsedMs: performance.now() - t0,
      redirected: res.redirected,
      finalUrl: res.url,
    };
    if (!res.ok) {
      r.errorKind = 'http';
      r.error = `HTTP ${res.status}`;
    }
    return r;
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    const timeout = err.name === 'AbortError';
    return {
      url,
      ok: false,
      error: timeout ? `timed out after ${timeoutMs} ms` : `${err.name}: ${err.message}`,
      // The browser deliberately hides CORS failures behind a generic TypeError("Failed to fetch").
      errorKind: timeout ? 'timeout' : err.name === 'TypeError' ? 'cors-or-network' : 'other',
      elapsedMs: performance.now() - t0,
    };
  }
}

export interface VideoElementTestResult {
  url: string;
  ok: boolean;
  crossOrigin: 'anonymous' | 'none';
  width?: number;
  height?: number;
  duration?: number;
  mediaErrorCode?: number;
  mediaErrorMessage?: string;
  tainted?: boolean;
  elapsedMs: number;
  error?: string;
}

/** Load a URL in a detached <video> and optionally test whether a drawn canvas is readable. */
export function testVideoElement(url: string, crossOrigin: 'anonymous' | 'none', drawToCanvas = false, timeoutMs = 20_000): Promise<VideoElementTestResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    if (crossOrigin === 'anonymous') v.crossOrigin = 'anonymous';
    const finish = (r: Partial<VideoElementTestResult>) => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve({ url, ok: false, crossOrigin, elapsedMs: performance.now() - t0, ...r });
    };
    const timer = setTimeout(() => finish({ error: `timed out after ${timeoutMs} ms` }), timeoutMs);
    v.addEventListener('error', () => finish({ mediaErrorCode: v.error?.code, mediaErrorMessage: v.error?.message, error: `MediaError ${v.error?.code}` }));
    v.addEventListener('loadeddata', () => {
      let tainted: boolean | undefined;
      if (drawToCanvas) {
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 2;
        c.height = v.videoHeight || 2;
        const ctx = c.getContext('2d')!;
        try {
          ctx.drawImage(v, 0, 0, c.width, c.height);
          ctx.getImageData(0, 0, 1, 1);
          tainted = false;
        } catch {
          tainted = true;
        }
      }
      finish({ ok: true, width: v.videoWidth, height: v.videoHeight, duration: v.duration, tainted });
    });
    v.src = url;
    v.load();
  });
}
