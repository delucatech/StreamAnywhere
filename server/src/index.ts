import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EXPLORE_CATEGORIES } from '../../shared/types';
import type { ConversationRequest, FeedRequest, FeedResponse, FollowRequest, HealthResponse, ProbeRequest, ProfileRequest, ReportRequest, ResolveRequest, ResolveResponse, SearchRequest, SendMessageRequest, SessionInputRequest, SessionLoginRequest, SessionStatus } from '../../shared/types';
import { registerAuth } from './auth';
import { config, findUp } from './config';
import { registerProxyRoutes } from './proxy';
import { isTikTokUrl, probeUrl, resolveTikTokNative, TikTokError } from './tiktok';
import { detectYtDlp, resolveWithYtDlp } from './ytdlp';
import { defaultExpiry, mediaCount, registerMedia } from './mediaStore';
import { hostAllowed } from './ssrf';
import { EXPLORE_DEFAULT_CATEGORY, FeedError, fetchExploreFeed, normalizeExploreOptions, type ExploreResult } from './feed';
import { cancelLogin, fetchExploreViaBrowser, fetchForYou, forYouStock, logout, sessionInput, sessionLog, sessionProbe, sessionStatus, sessionSupported, shutdownBrowsers, startLogin } from './session';
import { Reservoir, type ReservoirStats } from './reservoir';
import { conversation, fetchProfile, followUser, inbox, inboxDebug, searchTikTok, sendMessage, SocialError } from './social';

/** After the browser path rescued an explore request, prefer it for a while (datacenter IPs). */
let exploreViaBrowserUntil = 0;
const EXPLORE_VIA_BROWSER_ENV = /^(1|true|yes)$/i.test(process.env.EXPLORE_VIA_BROWSER || '');

/**
 * One Explore batch from TikTok: the plain request first, the headless browser as rescue (and
 * preferred for 15 min after a rescue, since datacenter IPs get refused by the plain request).
 */
async function fetchExploreAny(category: number, count: number, log: (m: string) => void, warn: (err: string, msg: string) => void): Promise<ExploreResult> {
  const browserOk = sessionSupported().ok;
  if (browserOk && (EXPLORE_VIA_BROWSER_ENV || Date.now() < exploreViaBrowserUntil)) {
    try {
      return await fetchExploreViaBrowser(category, count, log);
    } catch (e) {
      warn((e as Error).message, 'explore via browser failed; trying the direct request');
    }
  }
  try {
    return await fetchExploreFeed({ category, count, log });
  } catch (e) {
    if (!browserOk) throw e;
    warn((e as Error).message, 'direct explore request failed; trying through the headless browser');
    const r = await fetchExploreViaBrowser(category, count, log);
    r.warnings.push('direct explore request was blocked; served through the headless browser');
    exploreViaBrowserUntil = Date.now() + 15 * 60 * 1000;
    return r;
  }
}

/**
 * Explore stock per category, filled in the background while someone is watching (see reservoir.ts).
 *
 * Measured 2026-10-10: TikTok answers the same category+count from a cache for about a minute (a
 * repeat within seconds is identical), while a different count gives a fresh sample at once; the
 * pool behind "All" holds roughly 110 distinct videos per minute, then repeats until it rotates.
 * So every fill uses a different count, and "All" borrows from another category when it runs dry.
 */
const exploreReservoirs = new Map<number, Reservoir>();
function exploreReservoir(category: number, log: (m: string) => void, warn: (err: string, msg: string) => void): Reservoir {
  let r = exploreReservoirs.get(category);
  if (!r) {
    r = new Reservoir(
      `explore ${category}`,
      ({ count, index, lastAdded }) => {
        const n = Math.max(12, count - (index % 8));
        let cat = category;
        if (category === EXPLORE_DEFAULT_CATEGORY && lastAdded !== undefined && lastAdded < 5) {
          const others = EXPLORE_CATEGORIES.filter((c) => c.id !== category);
          cat = others[index % others.length].id;
          log(`explore ${category}: pool dry (${lastAdded} new last time), borrowing from category ${cat}`);
        }
        return fetchExploreAny(cat, n, log, warn);
      },
      { log },
    );
    exploreReservoirs.set(category, r);
  }
  return r;
}
export const exploreStock = (): Record<string, ReservoirStats> => Object.fromEntries([...exploreReservoirs].map(([k, v]) => [String(k), v.stats]));

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 64 * 1024,
    disableRequestLogging: config.logLevel !== 'debug',
    // Behind Caddy (reverse_proxy from 127.0.0.1) every request would otherwise count as coming from
    // 127.0.0.1: one bucket for all visitors, so ten anonymous wrong passwords a minute would lock
    // the owner out of /login. Trust X-Forwarded-For/-Proto only from a loopback peer (TRUST_PROXY
    // overrides, e.g. "true" on a hosting platform whose proxy is not local).
    trustProxy: config.trustProxy,
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

  // Site password: everything below (pages, API, media) needs the login cookie.
  registerAuth(app);

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
    const log = (msg: string) => app.log.info({ source }, msg);
    const warn = (err: string, msg: string) => app.log.warn({ source, err }, msg);
    try {
      if (source === 'explore') {
        const category = b.category !== undefined && Number.isInteger(Number(b.category)) ? Number(b.category) : undefined;
        const norm = normalizeExploreOptions({ category, count });
        // Served from the stock (filled in the background); only an empty stock waits for TikTok.
        const r = await exploreReservoir(norm.category, log, warn).take(norm.count);
        const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
        log(`explore ${norm.category}: ${r.items.length} served ${r.fromStock ? 'from stock' : 'after a fill'}, ${r.ready} ready, ${resp.elapsedMs} ms`);
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

  // ---- search / profiles / follow / messages (headless work page; see social.ts)
  const socialLog = (what: string) => (msg: string) => app.log.info({ what }, msg);
  const socialFail = (reply: import('fastify').FastifyReply, e: unknown, t0: number) => {
    const err = e as Error;
    app.log.warn({ err: err.message }, 'social request failed');
    return reply.code(e instanceof SocialError ? e.status : 502).send({ error: err.message, elapsedMs: Date.now() - t0 });
  };
  const handle = (user: unknown): string => {
    const u = String(user || '')
      .trim()
      .replace(/^@/, '');
    if (!/^[\w.\-]{1,64}$/.test(u)) throw new SocialError('That is not a TikTok handle', 400);
    return u;
  };
  app.post<{ Body: SearchRequest }>('/api/search', resolveLimit, async (req, reply) => {
    const t0 = Date.now();
    try {
      const q = String(req.body?.q || '').trim().slice(0, 100);
      if (!q) throw new SocialError('Type something to search for', 400);
      const offset = Math.max(0, Math.min(500, Number(req.body?.offset) || 0));
      return await searchTikTok(q, offset, socialLog('search'));
    } catch (e) {
      return socialFail(reply, e, t0);
    }
  });
  app.post<{ Body: ProfileRequest }>('/api/profile', resolveLimit, async (req, reply) => {
    const t0 = Date.now();
    try {
      const user = handle(req.body?.user);
      const offset = Math.max(0, Math.min(2000, Number(req.body?.offset) || 0));
      const count = Math.max(1, Math.min(60, Number(req.body?.count) || 24));
      return await fetchProfile(user, offset, count, socialLog('profile'));
    } catch (e) {
      return socialFail(reply, e, t0);
    }
  });
  app.post<{ Body: FollowRequest }>('/api/follow', resolveLimit, async (req, reply) => {
    const t0 = Date.now();
    try {
      return await followUser(handle(req.body?.user), req.body?.follow !== false, socialLog('follow'));
    } catch (e) {
      return socialFail(reply, e, t0);
    }
  });
  app.get('/api/inbox', async (req, reply) => {
    const t0 = Date.now();
    try {
      return await inbox(socialLog('inbox'));
    } catch (e) {
      return socialFail(reply, e, t0);
    }
  });
  app.get('/api/inbox/debug', async (req, reply) => {
    const t0 = Date.now();
    try {
      return await inboxDebug(socialLog('inbox'));
    } catch (e) {
      return socialFail(reply, e, t0);
    }
  });
  app.post<{ Body: ConversationRequest }>('/api/inbox/open', resolveLimit, async (req, reply) => {
    const t0 = Date.now();
    try {
      const id = String(req.body?.id || '').trim();
      if (!id) throw new SocialError('Which conversation?', 400);
      if (id.startsWith('@')) handle(id);
      return await conversation(id, socialLog('inbox'));
    } catch (e) {
      return socialFail(reply, e, t0);
    }
  });
  app.post<{ Body: SendMessageRequest }>('/api/inbox/send', resolveLimit, async (req, reply) => {
    const t0 = Date.now();
    try {
      const id = String(req.body?.id || '').trim();
      if (!id) throw new SocialError('Which conversation?', 400);
      if (id.startsWith('@')) handle(id);
      return await sendMessage(id, String(req.body?.text || ''), socialLog('inbox'));
    } catch (e) {
      return socialFail(reply, e, t0);
    }
  });

  app.get('/api/session', async (): Promise<SessionStatus> => sessionProbe());
  // The last sign-in log lines (what the server did on TikTok's page), for diagnosing without a shell.
  app.get('/api/session/log', async () => sessionLog());
  app.post<{ Body: SessionLoginRequest }>('/api/session/login', resolveLimit, async (req, reply) => {
    try {
      const mode = req.body?.mode === 'window' ? 'window' : 'qr';
      return await startLogin(mode, (m) => req.log.info(m));
    } catch (e) {
      return reply.code(500).send({ ...sessionStatus(), error: (e as Error).message });
    }
  });
  app.post('/api/session/logout', async () => logout());
  // Cancels a pending sign-in and forgets its token/ticket/dialog (the next sign-in starts from zero).
  app.post('/api/session/cancel', async () => cancelLogin());
  // Clicks / typing for TikTok's verification modal on the headless sign-in page (see SessionInputRequest).
  app.post<{ Body: SessionInputRequest }>('/api/session/input', async (req, reply) => {
    try {
      return await sessionInput(req.body || { type: 'shot' });
    } catch (e) {
      return reply.code(409).send({ ...sessionStatus(), error: (e as Error).message });
    }
  });

  registerProxyRoutes(app);

  app.get('/api/stats', async () => ({ mediaRecords: mediaCount(), exploreStock: exploreStock(), forYouStock: forYouStock(), uptimeSec: Math.round(process.uptime()) }));

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
