/**
 * HTTP for Live TV providers. Unlike the media proxy (https only, allowlisted hosts) IPTV panels
 * and streams are mostly plain http on arbitrary hosts, so this opener allows both schemes and
 * any public host; what it keeps is the private-address check on every hop (ssrf.ts), bounded
 * redirects, timeouts and body limits. Credentials never go in the log: redactUrl() masks the
 * user / password path segments of Xtream URLs and secret-looking query parameters.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import { config } from './config';
import { assertPublicHost, UpstreamRejectedError } from './ssrf';

export const LIVETV_USER_AGENT = process.env.LIVETV_USER_AGENT || config.userAgent;

export interface LiveRequestOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LiveResponse {
  res: IncomingMessage;
  status: number;
  finalUrl: string;
  redirects: number;
}

/** http(s) only, no credentials in the URL, a public host (checked after DNS). */
export async function checkLiveUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamRejectedError('Invalid URL', 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UpstreamRejectedError('Only http(s) URLs can be used', 'bad_scheme');
  if (url.username || url.password) throw new UpstreamRejectedError('Credentials in the URL itself are not supported; use the provider fields', 'bad_url');
  await assertPublicHost(url.hostname);
  return url;
}

/** Opens a streaming request; the caller consumes or destroys `res`. Redirect hops are re-checked. */
export async function openLive(rawUrl: string, opts: LiveRequestOptions = {}): Promise<LiveResponse> {
  let url = await checkLiveUrl(rawUrl);
  let redirects = 0;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? config.upstreamTimeoutMs;
  for (;;) {
    const headers: Record<string, string> = { 'user-agent': LIVETV_USER_AGENT, accept: '*/*', 'accept-encoding': 'identity', connection: 'close', ...(opts.headers || {}) };
    const lib = url.protocol === 'https:' ? https : http;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = lib.request(url, { method: opts.method || 'GET', headers, timeout: timeoutMs, rejectUnauthorized: false }, resolve);
      req.on('timeout', () => req.destroy(new Error(`No answer from ${url.hostname} in ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', reject);
      opts.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      req.end();
    });
    const status = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects < maxRedirects) {
      res.resume();
      redirects++;
      url = await checkLiveUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    return { res, status, finalUrl: url.toString(), redirects };
  }
}

export async function readLiveBody(res: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      res.destroy();
      throw new Error(`The answer is larger than ${Math.round(limit / 1048576)} MB`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** GET a text document (a playlist, a JSON answer); gzip bodies are inflated (by magic, whatever the headers say). */
export async function fetchLiveText(url: string, opts: { limit?: number; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ text: string; status: number; contentType: string; finalUrl: string }> {
  const { res, status, finalUrl } = await openLive(url, { headers: opts.headers, timeoutMs: opts.timeoutMs });
  if (status >= 400) {
    res.resume();
    throw new Error(`HTTP ${status} from ${safeHost(finalUrl)}`);
  }
  const limit = opts.limit ?? 32 * 1024 * 1024;
  let body = await readLiveBody(res, limit);
  if (isGzip(body)) body = zlib.gunzipSync(body, { maxOutputLength: limit * 8 });
  return { text: body.toString('utf8'), status, contentType: String(res.headers['content-type'] || ''), finalUrl };
}

export const isGzip = (b: Buffer): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

export const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
};

/**
 * A URL fit for the log: Xtream paths carry "/live/<user>/<password>/" (and player_api.php?username=&password=),
 * playlist links often "?username=…&password=…" or a token: all of those are masked.
 */
export function redactUrl(url: string, secrets: string[] = []): string {
  let s = String(url || '');
  for (const sec of secrets) if (sec && sec.length >= 3) s = s.split(sec).join('***');
  s = s.replace(/([?&](?:username|user|password|pass|pwd|token|key|auth|secret|session)=)[^&#]*/gi, '$1***');
  s = s.replace(/(\/(?:live|movie|series|timeshift|streaming)\/)[^/]+\/[^/]+\//gi, '$1***/***/');
  return s;
}
