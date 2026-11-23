import * as https from 'node:https';
import * as net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { config } from './config';
import { assertSafeUpstream } from './ssrf';

/**
 * Node 20 connects to a host's addresses one after the other and gives each one 250 ms before it
 * moves on ("happy eyeballs"). The VM has no IPv6 route, so a host's IPv4 address is the only one
 * that can answer - and when the machine is busy the event loop itself is 200+ ms late (health:
 * lagMs), the 250 ms pass before Node looks at the finished handshake, the IPv4 attempt is dropped,
 * IPv6 fails at once, and the request dies with an AggregateError whose message is empty. Seen
 * 2026-11-23 as 'proxy upstream open failed err ""' and, in the player, "HTTP 502 fetching media"
 * - always while a headless browser or a yt-dlp lookup was running. Five seconds per address keeps
 * the fallback and survives a busy moment. (Node 16 on the dev PC has neither the feature nor the
 * setter.)
 */
const CONNECT_ATTEMPT_MS = 5000;
try {
  (net as { setDefaultAutoSelectFamilyAttemptTimeout?: (ms: number) => void }).setDefaultAutoSelectFamilyAttemptTimeout?.(CONNECT_ATTEMPT_MS);
} catch {
  /* an older Node: nothing to set */
}

/**
 * A network error with words: an AggregateError (every address of the host failed) has an empty
 * message, so its code and the first address's error are named instead.
 */
export function netError(e: unknown): Error {
  const err = e as Error & { code?: string; errors?: (Error & { code?: string; address?: string })[] };
  if (err?.message) return err;
  const parts = (err?.errors || []).map((x) => `${x.address ? x.address + ': ' : ''}${x.code || x.message || 'failed'}`);
  const text = `could not connect${err?.code ? ` (${err.code})` : ''}${parts.length ? `: ${parts.slice(0, 3).join(', ')}` : ''}`;
  const out = new Error(text) as Error & { code?: string };
  out.code = err?.code;
  return out;
}

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
  method?: 'GET' | 'HEAD' | 'OPTIONS' | 'POST';
  /** The request body (POST); its Content-Type goes in `headers`. */
  body?: string | Buffer;
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
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = https.request(url, { method: opts.method || 'GET', headers, timeout: timeoutMs }, resolve);
      req.on('timeout', () => req.destroy(new Error(`Upstream timeout after ${timeoutMs}ms`)));
      req.on('error', (e) => reject(netError(e)));
      req.end(opts.body);
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
