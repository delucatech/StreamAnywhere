import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { FeedRequest, FeedResponse, HealthResponse, ProbeRequest, ReportRequest, ResolveRequest, ResolveResponse, SessionInputRequest, SessionLoginRequest, SessionStatus } from '../../shared/types';
import { config, findUp } from './config';
import { registerProxyRoutes } from './proxy';
import { isTikTokUrl, probeUrl, resolveTikTokNative, TikTokError } from './tiktok';
import { detectYtDlp, resolveWithYtDlp } from './ytdlp';
import { defaultExpiry, mediaCount, registerMedia } from './mediaStore';
import { hostAllowed } from './ssrf';
import { FeedError, fetchExploreFeed, normalizeExploreOptions } from './feed';
import { fetchExploreViaBrowser, fetchForYou, logout, sessionInput, sessionProbe, sessionStatus, sessionSupported, shutdownBrowsers, startLogin } from './session';

/** After the browser path rescued an explore request, prefer it for a while (datacenter IPs). */
let exploreViaBrowserUntil = 0;
const EXPLORE_VIA_BROWSER_ENV = /^(1|true|yes)$/i.test(process.env.EXPLORE_VIA_BROWSER || '');

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 64 * 1024,
    disableRequestLogging: config.logLevel !== 'debug',
  });

  // Same-origin deployments (SERVE_CLIENT) need no CORS; otherwise allow the configured client origins.
  await app.register(cors, {
    origin: config.clientOrigins.includes('*') || config.serveClient ? true : config.clientOrigins,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Range'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type', 'X-Proxy-Upstream-Host', 'X-Proxy-Upstream-Status', 'X-Proxy-Redirects'],
    maxAge: 600,
  });

  // Public-deployment protection: per-IP limits on the endpoints that cause upstream traffic.
  await app.register(rateLimit, { global: false, timeWindow: '1 minute', max: config.rateLimit.mediaPerMinute });
  const resolveLimit = { config: { rateLimit: { max: config.rateLimit.resolvePerMinute, timeWindow: '1 minute' } } };

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    node: process.version,
    ytdlp: await detectYtDlp(),
    resolver: config.resolver,
    proxyAllowedHosts: config.proxyAllowedHosts,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.post<{ Body: ResolveRequest }>('/api/resolve', resolveLimit, async (req, reply) => {
    const body = req.body || ({} as ResolveRequest);
    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'Body must contain an http(s) "url"' });
    const origin = body.origin || (req.headers.origin as string | undefined) || config.clientOrigins[0] || 'http://localhost:5173';
    const log = (msg: string, data?: Record<string, unknown>) => req.log.info(data || {}, msg);
    const t0 = Date.now();

    if (!isTikTokUrl(url)) {
      // Plain MP4 (or any media URL): pass through, probe CORS server-side, offer the proxy if allowlisted.
      const host = new URL(url).hostname;
      const warnings: string[] = [];
      const probe = body.probe === false ? undefined : await probeUrl(url, origin, ['*']);
      let proxyUrl: string | undefined;
      let mediaId: string | undefined;
      if (hostAllowed(host, config.proxyAllowedHosts)) {
        const rec = registerMedia({ url, headers: {}, label: `mp4 ${url}`, source: 'mp4', expiresAt: defaultExpiry() });
        proxyUrl = `/api/media/${rec.id}`;
        mediaId = rec.id;
      } else {
        warnings.push(`Host ${host} is not in PROXY_ALLOWED_HOSTS; proxy relay disabled for this URL`);
      }
      const resp: ResolveResponse = {
        source: 'mp4',
        resolver: 'passthrough',
        id: url,
        inputUrl: url,
        formats: [
          {
            id: 'origin',
            label: 'Original URL',
            codec: 'unknown',
            directUrl: url,
            directKind: 'origin',
            serverProbe: probe,
            proxyUrl,
            mediaId,
            requiresCookies: false,
            upstreamHost: host,
          },
        ],
        warnings,
        elapsedMs: Date.now() - t0,
        attempts: [{ resolver: 'passthrough', ok: true, elapsedMs: Date.now() - t0 }],
      };
      log('resolved plain media url', { host, probeStatus: probe?.status, acao: probe?.headers.accessControlAllowOrigin });
      return resp;
    }

    const attempts: ResolveResponse['attempts'] = [];
    const order: ('native' | 'ytdlp')[] = config.resolver === 'native' ? ['native'] : config.resolver === 'ytdlp' ? ['ytdlp'] : ['native', 'ytdlp'];
    let lastError: Error | undefined;
    for (const strategy of order) {
      const ta = Date.now();
      try {
        const result = strategy === 'native' ? await resolveTikTokNative(url, { probeOrigin: origin, probe: body.probe !== false, log }) : await resolveWithYtDlp(url);
        attempts.push({ resolver: strategy, ok: true, elapsedMs: Date.now() - ta });
        result.attempts = attempts;
        result.elapsedMs = Date.now() - t0;
        req.log.info(
          { resolver: strategy, id: result.id, formats: result.formats.map((f) => ({ id: f.id, codec: f.codec, direct: f.directKind || 'none', probe: f.serverProbe?.status })) },
          'tiktok resolved',
        );
        return result;
      } catch (e) {
        const err = e as Error;
        lastError = err;
        attempts.push({ resolver: strategy, ok: false, error: err.message, elapsedMs: Date.now() - ta });
        req.log.warn({ resolver: strategy, err: err.message }, 'resolver attempt failed');
        // Do not fall through to yt-dlp for definitive answers (private/not found)
        if (err instanceof TikTokError && /^tiktok_status_|unsupported_photo|not_tiktok|bad_path/.test(err.code)) break;
      }
    }
    return reply.code(502).send({ error: lastError?.message || 'resolution failed', attempts, elapsedMs: Date.now() - t0 });
  });

  app.post<{ Body: ProbeRequest }>('/api/probe', resolveLimit, async (req, reply) => {
    const url = String(req.body?.url || '').trim();
    if (!/^https:\/\//i.test(url)) return reply.code(400).send({ error: 'Body must contain an https "url"' });
    const origin = req.body?.origin || (req.headers.origin as string | undefined) || 'http://localhost:5173';
    return probeUrl(url, origin, ['*']);
  });

  app.post<{ Body: ReportRequest }>('/api/report', async (req) => {
    const b = req.body || ({} as ReportRequest);
    req.log.info(
      { connection: b.connection, renderer: b.renderer, ok: b.ok, mediaId: b.mediaId, url: b.url?.slice(0, 120), detail: b.detail?.slice(0, 300) },
      b.ok ? `client played media via ${b.connection}` : `client playback via ${b.connection} failed`,
    );
    return { ok: true };
  });

  // ---- feed (TikTok-style stream): explore needs no login; foryou needs the browser session.
  app.post<{ Body: FeedRequest }>('/api/feed', resolveLimit, async (req, reply) => {
    const b = req.body || ({} as FeedRequest);
    const source = b.source === 'foryou' ? 'foryou' : 'explore';
    const count = Math.max(1, Math.min(30, Number(b.count) || 12));
    const t0 = Date.now();
    const log = (msg: string) => req.log.info({ source }, msg);
    try {
      if (source === 'explore') {
        const category = b.category !== undefined && Number.isInteger(Number(b.category)) ? Number(b.category) : undefined;
        const norm = normalizeExploreOptions({ category, count });
        const browserOk = sessionSupported().ok;
        let r;
        if (browserOk && (EXPLORE_VIA_BROWSER_ENV || Date.now() < exploreViaBrowserUntil)) {
          try {
            r = await fetchExploreViaBrowser(norm.category, norm.count, log);
          } catch (e) {
            req.log.warn({ err: (e as Error).message }, 'explore via browser failed; trying the direct request');
          }
        }
        if (!r) {
          try {
            r = await fetchExploreFeed({ category, count, log });
          } catch (e) {
            if (!browserOk) throw e;
            req.log.warn({ err: (e as Error).message }, 'direct explore request failed; trying through the headless browser');
            r = await fetchExploreViaBrowser(norm.category, norm.count, log);
            r.warnings.push('direct explore request was blocked; served through the headless browser');
            exploreViaBrowserUntil = Date.now() + 15 * 60 * 1000;
          }
        }
        const resp: FeedResponse = { source, items: r.items, hasMore: r.hasMore, warnings: r.warnings, elapsedMs: Date.now() - t0 };
        return resp;
      }
      const r = await fetchForYou(count, log);
      const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
      return resp;
    } catch (e) {
      const err = e as Error;
      req.log.warn({ source, err: err.message }, 'feed request failed');
      const status = err instanceof FeedError ? err.status : 502;
      return reply.code(status).send({ error: err.message, source, elapsedMs: Date.now() - t0 });
    }
  });

  app.get('/api/session', async (): Promise<SessionStatus> => sessionProbe());
  app.post<{ Body: SessionLoginRequest }>('/api/session/login', resolveLimit, async (req, reply) => {
    try {
      const mode = req.body?.mode === 'window' ? 'window' : 'qr';
      return await startLogin(mode, (m) => req.log.info(m));
    } catch (e) {
      return reply.code(500).send({ ...sessionStatus(), error: (e as Error).message });
    }
  });
  app.post('/api/session/logout', async () => logout());
  // Clicks / typing for TikTok's verification modal on the headless sign-in page (see SessionInputRequest).
  app.post<{ Body: SessionInputRequest }>('/api/session/input', async (req, reply) => {
    try {
      return await sessionInput(req.body || { type: 'shot' });
    } catch (e) {
      return reply.code(409).send({ ...sessionStatus(), error: (e as Error).message });
    }
  });

  registerProxyRoutes(app);

  app.get('/api/stats', async () => ({ mediaRecords: mediaCount(), uptimeSec: Math.round(process.uptime()) }));

  if (config.serveClient) {
    const dist = findUp(path.join('client', 'dist')) || findUp(path.join('client', 'dist'), process.cwd()) || path.resolve('client', 'dist');
    if (fs.existsSync(dist)) {
      const fastifyStatic = (await import('@fastify/static')).default;
      await app.register(fastifyStatic, { root: dist, prefix: '/' });
      app.log.info({ dist }, 'serving built client');
    } else {
      app.log.warn({ dist }, 'SERVE_CLIENT is set but client/dist does not exist (run npm run build)');
    }
  }
  return app;
}

if (require.main === module) {
  buildServer()
    .then(async (app) => {
      const addr = await app.listen({ port: config.port, host: config.host });
      console.log(`StreamAnywhere resolver/proxy listening on ${addr}`);
      // systemd stop/restart: close the headless browsers first, otherwise the stop waits for the
      // 90 s SIGTERM timeout and Chromium gets SIGKILLed (leaving stale profile locks behind).
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.once(sig, () => {
          app.log.info({ sig }, 'shutting down');
          void Promise.race([shutdownBrowsers(), new Promise((r) => setTimeout(r, 8000))]).finally(() => process.exit(0));
        });
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
