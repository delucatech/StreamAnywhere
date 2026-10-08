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
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { openUpstream } from './http';
import { getMedia } from './mediaStore';
import { UpstreamRejectedError } from './ssrf';

const FORWARD_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];

export function registerProxyRoutes(app: FastifyInstance): void {
  const handler = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const rec = getMedia(req.params.id);
    if (!rec) {
      return reply.code(404).send({ error: 'Unknown or expired media id. Resolve the video again.' });
    }
    const isHead = req.method === 'HEAD';
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
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
    headers['access-control-expose-headers'] =
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, X-Proxy-Upstream-Host, X-Proxy-Upstream-Status, X-Proxy-Redirects';

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
