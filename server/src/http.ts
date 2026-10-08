import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { config } from './config';
import { assertSafeUpstream } from './ssrf';

export interface CookieJar {
  cookies: Map<string, string>;
}
export const newJar = (): CookieJar => ({ cookies: new Map() });
export const jarHeader = (jar: CookieJar): string =>
  [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

function absorbSetCookie(jar: CookieJar | undefined, res: IncomingMessage): void {
  if (!jar) return;
  const sc = res.headers['set-cookie'];
  if (!sc) return;
  for (const line of sc) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  jar?: CookieJar;
  /** Follow up to N redirects (each hop re-validated against the allowlist). Default 0. */
  maxRedirects?: number;
  allowlist?: string[];
  timeoutMs?: number;
}

export interface UpstreamResponse {
  res: IncomingMessage;
  status: number;
  finalUrl: string;
  redirects: number;
}

/**
 * Opens a streaming HTTPS request. The caller must consume or destroy `res`.
 * Every hop is validated by assertSafeUpstream (https only, allowlisted host, public IP).
 */
export async function openUpstream(rawUrl: string, opts: RequestOptions = {}): Promise<UpstreamResponse> {
  const allowlist = opts.allowlist ?? ['*'];
  let url = await assertSafeUpstream(rawUrl, allowlist);
  let redirects = 0;
  const maxRedirects = opts.maxRedirects ?? 0;
  const timeoutMs = opts.timeoutMs ?? config.upstreamTimeoutMs;
  for (;;) {
    const headers: Record<string, string> = {
      'user-agent': config.userAgent,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...(opts.headers || {}),
    };
    if (opts.jar && opts.jar.cookies.size) headers.cookie = jarHeader(opts.jar);
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = https.request(url, { method: opts.method || 'GET', headers, timeout: timeoutMs }, resolve);
      req.on('timeout', () => req.destroy(new Error(`Upstream timeout after ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });
    absorbSetCookie(opts.jar, res);
    const status = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects < maxRedirects) {
      res.resume();
      redirects++;
      url = await assertSafeUpstream(new URL(res.headers.location, url).toString(), allowlist);
      continue;
    }
    return { res, status, finalUrl: url.toString(), redirects };
  }
}

export async function readBody(res: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      res.destroy();
      throw new Error(`Response exceeded ${limit} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Follow a redirecting URL (e.g. tiktok.com/aweme/v1/play) to its final location without downloading the body. */
export async function resolveRedirect(
  rawUrl: string,
  allowlist: string[],
  headers?: Record<string, string>,
): Promise<{ finalUrl: string; status: number; redirects: number; headers: IncomingMessage['headers'] }> {
  const { res, status, finalUrl, redirects } = await openUpstream(rawUrl, {
    allowlist,
    maxRedirects: 5,
    headers: { range: 'bytes=0-0', ...(headers || {}) },
  });
  res.destroy();
  return { finalUrl, status, redirects, headers: res.headers };
}
