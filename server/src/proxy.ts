/**
 * Minimal streaming media relay: GET/HEAD /api/media/:id
 *
 *  - Streams the upstream body (never buffers the whole file).
 *  - Forwards the client's Range header, and Content-Type / Content-Length / Content-Range /
 *    Accept-Ranges / ETag / Last-Modified back.
 *  - Adds the upstream headers TikTok requires (Referer + session cookies) that a browser
 *    on another origin cannot send.
 *  - Upstream host must be allowlisted and resolve to a public IP (see ssrf.ts).
 *  - Client disconnects destroy the upstream request.
 *  - Records marked `chunked` (YouTube) are fetched upstream in bounded Range chunks and the
 *    chunks are concatenated into one response: googlevideo.com throttles an open-ended request
 *    to about 50 KB/s and serves a bounded range at full speed (measured 2026-10-12).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { config } from './config';
import { openUpstream } from './http';
import { getMedia, type MediaRecord } from './mediaStore';
import { UpstreamRejectedError } from './ssrf';

const FORWARD_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];
const EXPOSE = 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, X-Proxy-Upstream-Host, X-Proxy-Upstream-Status, X-Proxy-Redirects';
/** Upstream chunk for `chunked` records (10 MB was still served at full speed; smaller = quicker first byte) */
const CHUNK = 4 * 1024 * 1024;

function parseRange(range: string | undefined): { start: number; end?: number } | 'bad' | undefined {
  if (!range) return undefined;
  const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!m) return 'bad';
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  return end !== undefined && end < start ? 'bad' : { start, end };
}

/** The `total` of an upstream "bytes a-b/total" */
const totalOf = (contentRange: string | undefined): number | undefined => {
  const m = /\/(\d+)$/.exec(contentRange || '');
  return m ? Number(m[1]) : undefined;
};

/** One bounded upstream chunk; a 403/5xx is retried once (googlevideo refuses the odd request). */
async function openChunk(rec: MediaRecord, start: number, end: number): Promise<{ res: IncomingMessage; status: number; finalUrl: string }> {
  let last: { res: IncomingMessage; status: number; finalUrl: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400));
    last?.res.destroy();
    last = await openUpstream(rec.url, { allowlist: config.proxyAllowedHosts, maxRedirects: 5, headers: { ...rec.headers, range: `bytes=${start}-${end}` } });
    if (last.status < 400) return last;
  }
  return last!;
}

/**
 * Chunked relay: answers the client's (open-ended or bounded) Range with one response whose body is
 * the concatenation of bounded upstream chunks.
 */
async function relayChunked(rec: MediaRecord, req: FastifyRequest, reply: FastifyReply, isHead: boolean, range: string | undefined): Promise<unknown> {
  const parsed = parseRange(isHead ? undefined : range);
  if (parsed === 'bad') return reply.code(416).send({ error: 'Bad Range' });
  const start = parsed?.start || 0;
  const t0 = Date.now();
  let first;
  try {
    first = await openChunk(rec, start, Math.min(start + CHUNK - 1, parsed?.end ?? Infinity));
  } catch (e) {
    const err = e as Error;
    req.log.warn({ mediaId: rec.id, err: err.message }, 'proxy upstream open failed');
    return reply.code(err instanceof UpstreamRejectedError ? 403 : 502).send({ error: err.message });
  }
  rec.stats.requests++;
  rec.stats.lastStatus = first.status;
  if (first.status >= 400) {
    first.res.destroy();
    req.log.warn({ mediaId: rec.id, status: first.status }, 'proxy upstream error status');
    return reply.code(first.status === 403 || first.status === 404 ? first.status : 502).send({ error: `Upstream responded ${first.status}`, upstreamStatus: first.status });
  }
  const total = first.status === 206 ? totalOf(first.res.headers['content-range'] as string | undefined) : Number(first.res.headers['content-length'] || 0) || undefined;
  const headers: Record<string, string> = {
    'content-type': (first.res.headers['content-type'] as string) || 'video/mp4',
    'accept-ranges': 'bytes',
    'x-proxy-upstream-host': new URL(first.finalUrl).hostname,
    'x-proxy-upstream-status': String(first.status),
    'x-proxy-redirects': '0',
    'access-control-expose-headers': EXPOSE,
  };
  if (first.status !== 206 || !total) {
    // Upstream ignored the Range (not expected from googlevideo): relay this one response as it is.
    if (first.res.headers['content-length']) headers['content-length'] = String(first.res.headers['content-length']);
    if (isHead) {
      first.res.destroy();
      return reply.code(200).headers(headers).send();
    }
    req.raw.on('close', () => first.res.destroy());
    return reply.code(200).headers(headers).send(first.res);
  }
  if (isHead) {
    first.res.destroy();
    headers['content-length'] = String(total);
    req.log.info({ mediaId: rec.id, mode: 'proxy-chunked', method: 'HEAD', total }, 'media delivered via proxy (HEAD)');
    return reply.code(200).headers(headers).send();
  }
  if (start >= total) {
    first.res.destroy();
    return reply.code(416).header('content-range', `bytes */${total}`).send({ error: 'Range not satisfiable' });
  }
  const last = parsed?.end !== undefined && parsed.end < total ? parsed.end : total - 1;
  headers['content-length'] = String(last - start + 1);
  if (parsed) headers['content-range'] = `bytes ${start}-${last}/${total}`;

  const out = new PassThrough();
  let bytes = 0;
  let closed = false;
  let current: IncomingMessage | undefined = first.res;
  req.raw.on('close', () => {
    closed = true;
    current?.destroy();
  });
  const pump = async (): Promise<void> => {
    let pos = start;
    let res: IncomingMessage = first.res;
    for (;;) {
      const chunkEnd = Math.min(pos + CHUNK - 1, last);
      current = res;
      for await (const c of res) {
        if (closed) return;
        bytes += (c as Buffer).length;
        if (!out.write(c)) await new Promise<void>((r) => out.once('drain', r));
      }
      pos = chunkEnd + 1;
      if (pos > last || closed) return;
      const next = await openChunk(rec, pos, Math.min(pos + CHUNK - 1, last));
      if (next.status !== 206) {
        next.res.destroy();
        throw new Error(`upstream chunk at ${pos} answered ${next.status}`);
      }
      res = next.res;
    }
  };
  void pump()
    .then(() => out.end())
    .catch((e) => {
      req.log.warn({ mediaId: rec.id, err: (e as Error).message, bytes }, 'proxy chunk relay failed');
      out.destroy(e as Error);
    })
    .finally(() => {
      rec.stats.bytes += bytes;
      req.log.info({ mediaId: rec.id, mode: 'proxy-chunked', range: range || 'none', bytes, of: last - start + 1, ms: Date.now() - t0 }, 'media delivered via proxy');
    });
  return reply.code(parsed ? 206 : 200).headers(headers).send(out);
}

/** `?dl=<name>` on a relay request: the browser saves the body as a file with that name (the library's "Save to device"). */
function attachmentFor(req: FastifyRequest): string | undefined {
  const name = String((req.query as { dl?: unknown })?.dl || '').trim();
  if (!name) return undefined;
  const clean = name.replace(/[\\/:*?"<>|]+|[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video.mp4';
  const ascii = clean.replace(/[^ -~]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

export function registerProxyRoutes(app: FastifyInstance): void {
  const handler = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const rec = getMedia(req.params.id);
    if (!rec) {
      return reply.code(404).send({ error: 'Unknown or expired media id. Resolve the video again.' });
    }
    const attachment = attachmentFor(req);
    if (attachment) reply.header('content-disposition', attachment);
    const isHead = req.method === 'HEAD';
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    if (rec.chunked) return relayChunked(rec, req, reply, isHead, range);
    const upstreamHeaders: Record<string, string> = { ...rec.headers };
    // Upstream HEAD is refused by TikTok's CDN (403); emulate HEAD with a 1-byte ranged GET.
    if (isHead) upstreamHeaders.range = 'bytes=0-0';
    else if (range) upstreamHeaders.range = range;
    const t0 = Date.now();
    let up;
    try {
      up = await openUpstream(rec.url, { allowlist: config.proxyAllowedHosts, maxRedirects: 5, headers: upstreamHeaders });
    } catch (e) {
      const err = e as Error;
      const code = err instanceof UpstreamRejectedError ? 403 : 502;
      req.log.warn({ mediaId: rec.id, err: err.message }, 'proxy upstream open failed');
      return reply.code(code).send({ error: err.message });
    }
    const { res, status, finalUrl, redirects } = up;
    rec.stats.requests++;
    rec.stats.lastStatus = status;
    if (status >= 400) {
      res.destroy();
      req.log.warn({ mediaId: rec.id, status, finalUrl }, 'proxy upstream error status');
      return reply.code(status === 403 || status === 404 ? status : 502).send({ error: `Upstream responded ${status}`, upstreamStatus: status });
    }
    const headers: Record<string, string> = {};
    for (const h of FORWARD_HEADERS) {
      const v = res.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    if (!headers['accept-ranges']) headers['accept-ranges'] = 'bytes';
    headers['x-proxy-upstream-host'] = new URL(finalUrl).hostname;
    headers['x-proxy-upstream-status'] = String(status);
    headers['x-proxy-redirects'] = String(redirects);
    headers['access-control-expose-headers'] = EXPOSE;

    if (isHead) {
      res.destroy();
      // Translate "bytes 0-0/total" into a plain Content-Length
      const m = /\/(\d+)$/.exec(headers['content-range'] || '');
      if (m) headers['content-length'] = m[1];
      delete headers['content-range'];
      req.log.info({ mediaId: rec.id, mode: 'proxy', method: 'HEAD', upstreamStatus: status }, 'media delivered via proxy (HEAD)');
      return reply.code(200).headers(headers).send();
    }
    let bytes = 0;
    res.on('data', (c: Buffer) => (bytes += c.length));
    res.on('close', () => {
      rec.stats.bytes += bytes;
      req.log.info(
        { mediaId: rec.id, mode: 'proxy', range: range || 'none', upstreamStatus: status, bytes, ms: Date.now() - t0, host: headers['x-proxy-upstream-host'] },
        'media delivered via proxy',
      );
    });
    req.raw.on('close', () => {
      if (!res.destroyed) res.destroy();
    });
    return reply.code(status).headers(headers).send(res);
  };
  const limited = { config: { rateLimit: { max: config.rateLimit.mediaPerMinute, timeWindow: '1 minute' } } };
  app.get('/api/media/:id', limited, handler);
  app.head('/api/media/:id', limited, handler);
}
