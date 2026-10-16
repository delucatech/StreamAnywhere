import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EXPLORE_CATEGORIES, YOUTUBE_CATEGORIES, platformOf } from '../../shared/types';
import type { ConversationRequest, DownloadProbeRequest, LibraryCategoryRequest, LibraryEntryPatch, LibrarySaveRequest, DownloadStartRequest, FeedRequest, FeedResponse, FollowRequest, HealthResponse, ProbeRequest, ProfileRequest, ProfileResponse, ReportRequest, ResolveRequest, ResolveResponse, SearchRequest, SendMessageRequest, SessionActionRequest, SessionInputRequest, SessionLoginRequest, SessionStatus } from '../../shared/types';
import { registerAuth } from './auth';
import { config, findUp } from './config';
import { registerProxyRoutes } from './proxy';
import { isTikTokUrl, probeUrl, resolveTikTokNative, TikTokError } from './tiktok';
import { detectFfmpeg } from './ffmpeg';
import { cancelJob, DOWNLOAD_SOURCES, DownloadError, downloaderStats, getJob, jobFile, jobServed, MAX_BYTES, probeDownload, setDownloaderLogger, shutdownDownloader, startDownload } from './downloader';
import { addCategory, deleteCategory, deleteEntry, entryOptions, flushLibrary, LibraryError, libraryState, libraryStats, patchEntry, refreshEntry, renameCategory, saveLink, setLibraryLogger, thumbFile } from './library';
import { daemonStatus, detectYtDlp, resolveWithYtDlp, setYtDlpLogger, shutdownYtDlp, warmYtDlp } from './ytdlp';
import { logStream, recentLog } from './logbuf';
import { defaultExpiry, mediaCount, registerMedia } from './mediaStore';
import { hostAllowed } from './ssrf';
import { EXPLORE_DEFAULT_CATEGORY, FeedError, fetchExploreFeed, normalizeExploreOptions, type ExploreResult } from './feed';
import { cancelLogin, fetchExploreViaBrowser, fetchForYou, forYouStock, logout, rememberLog, workState, sessionInput, sessionLog, sessionProbe, sessionStatus, sessionSupported, shutdownBrowsers, startLogin } from './session';
import { Reservoir, type ReservoirStats } from './reservoir';
import { getProgress } from './progress';
import { conversation, fetchProfile, followUser, inbox, inboxDebug, searchTikTok, sendMessage, SocialError } from './social';
import { channelVideos, exploreYouTube, isYouTubeUrl, recommendedYouTube, resolveYouTube, searchYouTube, youTubeCategory, YouTubeError } from './youtube';
import { exploreInstagram, forYouInstagram, instagramCategory, instagramStats, InstagramError, isInstagramUrl, pauseInstagramPages, profileInstagram, resolveInstagram, searchInstagram, setInstagramLogger, shutdownInstagram } from './instagram';
import { instagramCancelLogin, instagramLogout, instagramSessionLog, ensureInstagramSession, instagramSessionLost, instagramSessionStatus, instagramSignedIn, instagramStartLogin, InstagramSessionError, setInstagramSessionLogger, shutdownInstagramSession } from './instagramSession';
import { setYouTubeSessionLogger, shutdownYouTubeSession, youtubeCancelLogin, youtubeCookieFile, youtubeLogout, youtubeSessionLog, youtubeSessionLost, youtubeSessionStatus, youtubeStartLogin, YouTubeSessionError } from './youtubeSession';
import { exploreFacebook, facebookCategory, facebookStats, FacebookError, forYouFacebook, isFacebookUrl, profileFacebook, resolveFacebook, searchFacebook, setFacebookLogger } from './facebook';
import { ensureFacebookSession, facebookCancelLogin, facebookLogout, facebookSessionLog, facebookSessionLost, facebookSessionStatus, facebookSignedIn, facebookStartLogin, FacebookSessionError, setFacebookSessionLogger, shutdownFacebookSession } from './facebookSession';

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

/**
 * YouTube guest Explore stock per category: page after page of the hashtag's Shorts tab. "All"
 * rotates through the other hashtags, a page of each in turn.
 */
const youtubeReservoirs = new Map<number, Reservoir>();
function youtubeReservoir(categoryId: number, log: (m: string) => void): Reservoir {
  let r = youtubeReservoirs.get(categoryId);
  if (!r) {
    const cat = youTubeCategory(categoryId);
    const others = YOUTUBE_CATEGORIES.filter((c) => c.id !== 0);
    r = new Reservoir(
      `youtube ${cat.tag}`,
      async ({ count, index }) => {
        const tag = cat.id === 0 ? others[index % others.length].tag : cat.tag;
        const page = cat.id === 0 ? Math.floor(index / others.length) : index;
        const res = await exploreYouTube(tag, page, count, log);
        return { items: res.items, warnings: res.hasMore ? [] : [`#${tag} has no more Shorts`] };
      },
      { log, batch: 30, target: 45, low: 25, gapMs: 1000 },
    );
    youtubeReservoirs.set(categoryId, r);
  }
  return r;
}
export const youtubeStock = (): Record<string, ReservoirStats> => Object.fromEntries([...youtubeReservoirs].map(([k, v]) => [String(k), v.stats]));

/**
 * The signed-in account's YouTube feed (youtube.com/feed/recommended through the saved cookies),
 * stocked like the others. Each fill walks a different "load more" page of the home feed (YouTube
 * re-samples the recommendations on every load, so the pages differ between fills as well).
 */
let youtubeForYou: Reservoir | undefined;
function youtubeForYouReservoir(log: (m: string) => void): Reservoir {
  if (!youtubeForYou) {
    youtubeForYou = new Reservoir(
      'youtube foryou',
      async ({ count, index }) => {
        const file = youtubeCookieFile();
        if (!file) throw new FeedError('Not signed in to YouTube: sign in from Profile to see your For You feed.', 'youtube_not_signed_in', 401);
        const res = await recommendedYouTube((index % 3) * count, count, file, log);
        if (!res.items.length) {
          // A signed-out visitor gets an empty recommended feed, not an error: ask YouTube who we are.
          const lost = await youtubeSessionLost();
          if (lost) throw new FeedError(`Not signed in to YouTube any more: ${lost}`, 'youtube_not_signed_in', 401);
        }
        return { items: res.items, warnings: res.items.length ? [] : ['YouTube returned no recommendations this time'] };
      },
      { log, batch: 30, target: 45, low: 25, gapMs: 1500 },
    );
  }
  return youtubeForYou;
}

/**
 * Instagram "Reels" stock per category (signed-in only): the latest Reels of a rotation of big public
 * accounts (instagram.ts explains why there is no global feed to list). Fills are slow-ish (a profile
 * page load each, paced by the module) so the stock is deep and refilled early.
 */
const instagramReservoirs = new Map<number, Reservoir>();
function instagramReservoir(categoryId: number, log: (m: string) => void): Reservoir {
  let r = instagramReservoirs.get(categoryId);
  if (!r) {
    const cat = instagramCategory(categoryId);
    r = new Reservoir(`instagram ${cat.label}`, ({ count }) => exploreInstagram(cat.id, count, log), { log, batch: 30, target: 45, low: 25, gapMs: 4000, waitMs: 110_000 });
    instagramReservoirs.set(categoryId, r);
  }
  return r;
}
export const instagramStock = (): Record<string, ReservoirStats> => Object.fromEntries([...instagramReservoirs].map(([k, v]) => [String(k), v.stats]));

/** The signed-in account's Reels page, stocked like the others (a fill pages the Reels viewer for ~20 s). */
let instagramForYou: Reservoir | undefined;
function instagramForYouReservoir(log: (m: string) => void): Reservoir {
  if (!instagramForYou) {
    instagramForYou = new Reservoir(
      'instagram foryou',
      async ({ count }) => {
        let res: Awaited<ReturnType<typeof forYouInstagram>>;
        try {
          res = await forYouInstagram(count, log);
        } catch (e) {
          // The Reels page went to the login page: only a conclusive account check ends the sign-in (the
          // same redirect is how Instagram limits a busy server address).
          if (!(e instanceof InstagramError && e.code === 'instagram_not_signed_in')) throw e;
          const lost = await instagramSessionLost();
          if (lost) throw new FeedError(`Not signed in to Instagram any more: ${lost}`, 'instagram_not_signed_in', 401);
          // No verdict: leave the Reels page alone for a while too, or the stock's background fills would keep loading it.
          pauseInstagramPages();
          throw new FeedError("Instagram sent the Reels page to its login page but would not say whether the saved cookies still work (it is limiting this server's address); try again in a few minutes, or sign out and paste a fresh export.", 'instagram_rate_limited', 429);
        }
        if (!res.items.length) {
          const lost = await instagramSessionLost();
          if (lost) throw new FeedError(`Not signed in to Instagram any more: ${lost}`, 'instagram_not_signed_in', 401);
        }
        return res;
      },
      // A fill from cold on the 1 GB VM (browser start, slow Reels page, video lookups) can take two
      // minutes; the viewer is shown each step meanwhile (/api/feed/progress), so the request waits it out.
      { log, batch: 20, target: 30, low: 15, gapMs: 3000, waitMs: 170_000 },
    );
  }
  return instagramForYou;
}

/**
 * Facebook "Reels" stock per category: the latest reels of a rotation of public Pages, read from the
 * Pages' own HTML (facebook.ts). A fill is quick (saved listings) or one Page load (a few seconds).
 */
const facebookReservoirs = new Map<number, Reservoir>();
function facebookReservoir(categoryId: number, log: (m: string) => void): Reservoir {
  let r = facebookReservoirs.get(categoryId);
  if (!r) {
    const cat = facebookCategory(categoryId);
    r = new Reservoir(`facebook ${cat.label}`, ({ count }) => exploreFacebook(cat.id, count, log), { log, batch: 24, target: 40, low: 20, gapMs: 2500, waitMs: 60_000 });
    facebookReservoirs.set(categoryId, r);
  }
  return r;
}
export const facebookStock = (): Record<string, ReservoirStats> => Object.fromEntries([...facebookReservoirs].map(([k, v]) => [String(k), v.stats]));

/** The signed-in account's Reels feed (facebook.com/reel/ loaded with the saved cookies), stocked like the others. */
let facebookForYou: Reservoir | undefined;
function facebookForYouReservoir(log: (m: string) => void): Reservoir {
  if (!facebookForYou) {
    facebookForYou = new Reservoir(
      'facebook foryou',
      async ({ count }) => {
        let res: Awaited<ReturnType<typeof forYouFacebook>>;
        try {
          res = await forYouFacebook(count, log);
        } catch (e) {
          if (!(e instanceof FacebookError && e.code === 'facebook_not_signed_in')) throw e;
          const lost = await facebookSessionLost();
          throw new FeedError(lost ? `Not signed in to Facebook any more: ${lost}` : e.message, 'facebook_not_signed_in', 401);
        }
        if (!res.items.length) {
          const lost = await facebookSessionLost();
          if (lost) throw new FeedError(`Not signed in to Facebook any more: ${lost}`, 'facebook_not_signed_in', 401);
        }
        return res;
      },
      { log, batch: 12, target: 24, low: 12, gapMs: 2500, waitMs: 60_000 },
    );
  }
  return facebookForYou;
}

export async function buildServer() {
  const app = Fastify({
    // stdout (journald) plus the in-memory tail served by /api/log
    logger: { level: config.logLevel, stream: logStream },
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
  setYtDlpLogger((m) => app.log.info({ what: 'yt-dlp' }, m));
  setYouTubeSessionLogger((m) => app.log.info({ what: 'youtube-session' }, m));
  setInstagramSessionLogger((m) => app.log.info({ what: 'instagram-session' }, m));
  setInstagramLogger((m) => app.log.info({ what: 'instagram' }, m));
  setFacebookSessionLogger((m) => app.log.info({ what: 'facebook-session' }, m));
  setFacebookLogger((m) => app.log.info({ what: 'facebook' }, m));
  setDownloaderLogger((m) => app.log.info({ what: 'downloader' }, m));
  setLibraryLogger((m) => app.log.info({ what: 'library' }, m));

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    node: process.version,
    ytdlp: await detectYtDlp(),
    ytdlpDaemon: daemonStatus(),
    ffmpeg: await detectFfmpeg(),
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

    if (isYouTubeUrl(url)) {
      try {
        return await resolveYouTube(url, (m) => log(m), youtubeCookieFile());
      } catch (e) {
        const err = e as Error;
        req.log.warn({ err: err.message }, 'youtube resolve failed');
        return reply.code(e instanceof YouTubeError ? e.status : 502).send({ error: err.message, attempts: [{ resolver: 'ytdlp', ok: false, error: err.message, elapsedMs: Date.now() - t0 }], elapsedMs: Date.now() - t0 });
      }
    }

    if (isInstagramUrl(url)) {
      try {
        await ensureInstagramSession();
        return await resolveInstagram(url, (m) => log(m));
      } catch (e) {
        const err = e as Error;
        req.log.warn({ err: err.message }, 'instagram resolve failed');
        return reply.code(e instanceof InstagramError ? e.status : 502).send({ error: err.message, attempts: [{ resolver: 'native', ok: false, error: err.message, elapsedMs: Date.now() - t0 }], elapsedMs: Date.now() - t0 });
      }
    }

    if (isFacebookUrl(url)) {
      try {
        await ensureFacebookSession();
        return await resolveFacebook(url, (m) => log(m));
      } catch (e) {
        const err = e as Error;
        req.log.warn({ err: err.message }, 'facebook resolve failed');
        return reply.code(e instanceof FacebookError ? e.status : 502).send({ error: err.message, attempts: [{ resolver: 'native', ok: false, error: err.message, elapsedMs: Date.now() - t0 }], elapsedMs: Date.now() - t0 });
      }
    }

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
    const fields = { client: true, kind: b.kind, platform: b.platform, connection: b.connection, renderer: b.renderer, ok: b.ok, mediaId: b.mediaId, url: b.url?.slice(0, 120), detail: b.detail?.slice(0, 500), page: b.page?.slice(0, 120), ua: b.ua?.slice(0, 160) };
    if (b.kind) {
      // The feed page reporting what went wrong on the viewer's device (see feed.ts reportProblem)
      if (b.ok) req.log.info(fields, `client: ${b.kind}`);
      else req.log.warn(fields, `client problem: ${b.kind}`);
    } else req.log.info(fields, b.ok ? `client played media via ${b.connection}` : `client playback via ${b.connection} failed`);
    return { ok: true };
  });

  // The last log lines as text (newest last): ?n=300 lines, ?level=warn for problems only.
  app.get<{ Querystring: { n?: string; level?: string } }>('/api/log', async (req, reply) => {
    const n = Math.max(1, Math.min(800, Number(req.query.n) || 300));
    const level = /^(warn|error)$/i.test(req.query.level || '') ? 40 : /^debug$/i.test(req.query.level || '') ? 20 : 30;
    return reply.type('text/plain; charset=utf-8').header('cache-control', 'no-store').send(recentLog(n, level) + '\n');
  });

  // What a slow fill is doing right now, for the viewer's loading screen (polled while a feed request runs).
  app.get<{ Querystring: { platform?: string } }>('/api/feed/progress', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return getProgress(platformOf(req.query.platform));
  });

  // ---- feed (TikTok-style stream): explore needs no login; foryou needs the browser session.
  app.post<{ Body: FeedRequest }>('/api/feed', resolveLimit, async (req, reply) => {
    const b = req.body || ({} as FeedRequest);
    const platform = platformOf(b.platform);
    const source = b.source === 'foryou' ? 'foryou' : 'explore';
    const count = Math.max(1, Math.min(30, Number(b.count) || 12));
    const t0 = Date.now();
    const log = (msg: string) => app.log.info({ platform, source }, msg);
    const warn = (err: string, msg: string) => app.log.warn({ platform, source, err }, msg);
    try {
      if (platform === 'instagram') {
        await ensureInstagramSession();
        if (!instagramSignedIn()) throw new FeedError('Instagram needs a sign-in: open Profile and sign in with the cookies of a signed-in browser.', 'instagram_not_signed_in', 401);
        if (source === 'foryou') {
          const r = await instagramForYouReservoir(log).take(count);
          const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
          log(`instagram foryou: ${r.items.length} served ${r.fromStock ? 'from stock' : 'after a fill'}, ${r.ready} ready, ${resp.elapsedMs} ms`);
          return resp;
        }
        const cat = instagramCategory(b.category);
        const r = await instagramReservoir(cat.id, log).take(count);
        const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
        log(`instagram explore ${cat.label}: ${r.items.length} served ${r.fromStock ? 'from stock' : 'after a fill'}, ${r.ready} ready, ${resp.elapsedMs} ms`);
        return resp;
      }
      if (platform === 'facebook') {
        if (source === 'foryou') {
          await ensureFacebookSession();
          if (!facebookSignedIn()) throw new FeedError('Not signed in to Facebook: sign in from Profile to see your For You feed.', 'facebook_not_signed_in', 401);
          const r = await facebookForYouReservoir(log).take(count);
          const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
          log(`facebook foryou: ${r.items.length} served ${r.fromStock ? 'from stock' : 'after a fill'}, ${r.ready} ready, ${resp.elapsedMs} ms`);
          return resp;
        }
        const cat = facebookCategory(b.category);
        const r = await facebookReservoir(cat.id, log).take(count);
        const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
        log(`facebook explore ${cat.label}: ${r.items.length} served ${r.fromStock ? 'from stock' : 'after a fill'}, ${r.ready} ready, ${resp.elapsedMs} ms`);
        return resp;
      }
      if (platform === 'youtube') {
        if (source === 'foryou') {
          if (!youtubeCookieFile()) throw new FeedError('Not signed in to YouTube: sign in from Profile to see your For You feed.', 'youtube_not_signed_in', 401);
          const r = await youtubeForYouReservoir(log).take(count);
          const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
          log(`youtube foryou: ${r.items.length} served ${r.fromStock ? 'from stock' : 'after a fill'}, ${r.ready} ready, ${resp.elapsedMs} ms`);
          return resp;
        }
        const cat = youTubeCategory(b.category);
        const r = await youtubeReservoir(cat.id, log).take(count);
        const resp: FeedResponse = { source, items: r.items, hasMore: true, warnings: r.warnings, elapsedMs: Date.now() - t0 };
        log(`youtube explore ${cat.tag}: ${r.items.length} served ${r.fromStock ? 'from stock' : 'after a fill'}, ${r.ready} ready, ${resp.elapsedMs} ms`);
        return resp;
      }
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
      const status = err instanceof FeedError ? err.status : err instanceof YouTubeError || err instanceof InstagramError || err instanceof FacebookError ? err.status : 502;
      return reply.code(status).send({ error: err.message, source, elapsedMs: Date.now() - t0 });
    }
  });

  // ---- search / profiles / follow / messages (headless work page; see social.ts)
  const socialLog = (what: string) => rememberLog((msg: string) => app.log.info({ what }, msg));
  const socialFail = (reply: import('fastify').FastifyReply, e: unknown, t0: number) => {
    const err = e as Error;
    app.log.warn({ err: err.message }, 'social request failed');
    return reply.code(e instanceof SocialError || e instanceof YouTubeError || e instanceof InstagramError || e instanceof FacebookError ? e.status : 502).send({ error: err.message, elapsedMs: Date.now() - t0 });
  };
  const youtubeLog = (m: string) => app.log.info({ what: 'youtube' }, m);
  const instagramLog = (m: string) => app.log.info({ what: 'instagram' }, m);
  const facebookLog = (m: string) => app.log.info({ what: 'facebook' }, m);
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
      if (platformOf(req.body?.platform) === 'youtube') return await searchYouTube(q, offset, youtubeLog);
      if (platformOf(req.body?.platform) === 'instagram') {
        await ensureInstagramSession();
        return await searchInstagram(q, offset, instagramLog);
      }
      if (platformOf(req.body?.platform) === 'facebook') {
        await ensureFacebookSession();
        return await searchFacebook(q, offset, facebookLog);
      }
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
      if (platformOf(req.body?.platform) === 'instagram') {
        await ensureInstagramSession();
        return await profileInstagram(user, offset, count, instagramLog);
      }
      if (platformOf(req.body?.platform) === 'facebook') {
        await ensureFacebookSession();
        return await profileFacebook(user, offset, count, facebookLog);
      }
      if (platformOf(req.body?.platform) === 'youtube') {
        const r = await channelVideos(user, offset, count, youtubeLog);
        const resp: ProfileResponse = { user: { uniqueId: user, nickname: r.items[0]?.author.nickname }, items: r.items, offset, hasMore: r.hasMore, warnings: [], elapsedMs: Date.now() - t0 };
        return resp;
      }
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

  app.get<{ Querystring: { platform?: string; recheck?: string } }>('/api/session', async (req): Promise<SessionStatus> => {
    const platform = platformOf(req.query.platform);
    // recheck=1 is the panel's "Check again": a deliberate check of saved Instagram cookies goes past the probe pacing.
    return platform === 'youtube' ? youtubeSessionStatus() : platform === 'instagram' ? instagramSessionStatus(req.query.recheck === '1') : platform === 'facebook' ? facebookSessionStatus(req.query.recheck === '1') : sessionProbe();
  });
  // The last sign-in log lines (what the server did on TikTok's page / with the YouTube cookies), for diagnosing without a shell.
  app.get<{ Querystring: { platform?: string } }>('/api/session/log', async (req) => {
    const platform = platformOf(req.query.platform);
    return platform === 'youtube' ? youtubeSessionLog() : platform === 'instagram' ? instagramSessionLog() : platform === 'facebook' ? facebookSessionLog() : sessionLog();
  });
  // A cookies.txt export can run to a few hundred KB when a whole browser was exported (the server keeps youtube.com only).
  app.post<{ Body: SessionLoginRequest }>('/api/session/login', { ...resolveLimit, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const platform = platformOf(req.body?.platform);
    try {
      if (platform === 'instagram') {
        instagramForYou = undefined;
        const mode = req.body?.mode === 'window' ? 'window' : 'cookies';
        // The pasting browser is normally the one the cookies came from: its identity goes with them.
        return await instagramStartLogin(mode, typeof req.body?.cookies === 'string' ? req.body.cookies : undefined, (m) => req.log.info({ what: 'instagram-session' }, m), req.headers['user-agent']);
      }
      if (platform === 'youtube') {
        const mode = req.body?.mode === 'window' ? 'window' : 'cookies';
        return await youtubeStartLogin(mode, typeof req.body?.cookies === 'string' ? req.body.cookies : undefined, (m) => req.log.info({ what: 'youtube-session' }, m));
      }
      if (platform === 'facebook') {
        facebookForYou = undefined;
        const mode = req.body?.mode === 'window' ? 'window' : 'cookies';
        return await facebookStartLogin(mode, typeof req.body?.cookies === 'string' ? req.body.cookies : undefined, (m) => req.log.info({ what: 'facebook-session' }, m), req.headers['user-agent']);
      }
      const mode = req.body?.mode === 'window' ? 'window' : 'qr';
      return await startLogin(mode, (m) => req.log.info(m));
    } catch (e) {
      const status = e instanceof YouTubeSessionError || e instanceof InstagramSessionError || e instanceof FacebookSessionError ? e.status : 500;
      const base = platform === 'youtube' ? await youtubeSessionStatus() : platform === 'instagram' ? await instagramSessionStatus() : platform === 'facebook' ? await facebookSessionStatus() : sessionStatus();
      return reply.code(status).send({ ...base, error: (e as Error).message });
    }
  });
  app.post<{ Body: SessionActionRequest }>('/api/session/logout', async (req) => {
    if (platformOf(req.body?.platform) === 'youtube') {
      youtubeForYou = undefined;
      return youtubeLogout();
    }
    if (platformOf(req.body?.platform) === 'instagram') {
      instagramForYou = undefined;
      return instagramLogout();
    }
    if (platformOf(req.body?.platform) === 'facebook') {
      facebookForYou = undefined;
      return facebookLogout();
    }
    return logout();
  });
  // Cancels a pending sign-in and forgets its token/ticket/dialog (the next sign-in starts from zero).
  app.post<{ Body: SessionActionRequest }>('/api/session/cancel', async (req) => {
    const platform = platformOf(req.body?.platform);
    return platform === 'youtube' ? youtubeCancelLogin() : platform === 'instagram' ? instagramCancelLogin() : platform === 'facebook' ? facebookCancelLogin() : cancelLogin();
  });
  // Clicks / typing for TikTok's verification modal on the headless sign-in page (see SessionInputRequest).
  app.post<{ Body: SessionInputRequest }>('/api/session/input', async (req, reply) => {
    try {
      return await sessionInput(req.body || { type: 'shot' });
    } catch (e) {
      return reply.code(409).send({ ...sessionStatus(), error: (e as Error).message });
    }
  });

  registerProxyRoutes(app);

  // ---- Video Downloader (download.html): look a link up, start a download, poll it, fetch the file
  const downloadError = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown): unknown => {
    const err = e as DownloadError;
    return reply.code(err instanceof DownloadError ? err.status : 502).send({ error: err.message || String(e) });
  };
  app.get('/api/download/sources', async () => ({ sources: DOWNLOAD_SOURCES, maxBytes: MAX_BYTES, ffmpeg: (await detectFfmpeg()).available, ytdlp: (await detectYtDlp()).available }));
  app.post<{ Body: DownloadProbeRequest }>('/api/download/probe', resolveLimit, async (req, reply) => {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'Paste a link that starts with https://' });
    try {
      return await probeDownload(url);
    } catch (e) {
      req.log.warn({ url: url.slice(0, 120), err: (e as Error).message }, 'download probe failed');
      return downloadError(reply, e);
    }
  });
  app.post<{ Body: DownloadStartRequest }>('/api/download/start', resolveLimit, async (req, reply) => {
    try {
      return await startDownload(String(req.body?.probeId || ''), String(req.body?.optionId || ''));
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'download start failed');
      return downloadError(reply, e);
    }
  });
  app.get<{ Params: { id: string } }>('/api/download/jobs/:id', async (req, reply) => {
    const job = getJob(req.params.id);
    return job || reply.code(404).send({ error: 'No such download (the server may have restarted)' });
  });
  app.post<{ Params: { id: string } }>('/api/download/jobs/:id/cancel', async (req, reply) => {
    const job = cancelJob(req.params.id);
    return job || reply.code(404).send({ error: 'No such download' });
  });
  app.get<{ Params: { id: string } }>('/api/download/jobs/:id/file', async (req, reply) => {
    const f = jobFile(req.params.id);
    if (!f) return reply.code(404).send({ error: 'That file is not here any more: download it again' });
    const ascii = f.fileName.replace(/[^ -~]/g, '_').replace(/"/g, "'");
    const stream = fs.createReadStream(f.path);
    stream.on('end', () => jobServed(req.params.id));
    return reply
      .code(200)
      .headers({
        'content-type': f.mime,
        'content-length': String(f.sizeBytes),
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
        'cache-control': 'no-store',
      })
      .send(stream);
  });

  // ---- Video Library (library.html): the shared list of saved links, categories, qualities on offer
  const libraryError = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown): unknown => {
    const err = e as { message?: string; status?: number };
    const status = e instanceof LibraryError || e instanceof DownloadError || e instanceof YouTubeError || e instanceof InstagramError || e instanceof FacebookError || e instanceof InstagramSessionError || e instanceof FacebookSessionError ? err.status || 502 : 502;
    return reply.code(status).send({ error: err.message || String(e) });
  };
  app.get<{ Querystring: { rev?: string } }>('/api/library', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = libraryState();
    if (req.query.rev !== undefined && Number(req.query.rev) === s.rev) return { rev: s.rev, unchanged: true };
    return s;
  });
  app.post<{ Body: LibrarySaveRequest }>('/api/library', resolveLimit, async (req, reply) => {
    try {
      const r = saveLink(String(req.body?.url || ''), Array.isArray(req.body?.categoryIds) ? req.body!.categoryIds!.map(String) : []);
      return { ...r, state: libraryState() };
    } catch (e) {
      return libraryError(reply, e);
    }
  });
  app.post<{ Params: { id: string }; Body: LibraryEntryPatch }>('/api/library/entries/:id', async (req, reply) => {
    try {
      return { entry: patchEntry(req.params.id, req.body || {}), state: libraryState() };
    } catch (e) {
      return libraryError(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>('/api/library/entries/:id/delete', async (req, reply) => {
    try {
      deleteEntry(req.params.id);
      return libraryState();
    } catch (e) {
      return libraryError(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>('/api/library/entries/:id/refresh', resolveLimit, async (req, reply) => {
    try {
      return { entry: refreshEntry(req.params.id), state: libraryState() };
    } catch (e) {
      return libraryError(reply, e);
    }
  });
  app.get<{ Params: { id: string } }>('/api/library/entries/:id/options', resolveLimit, async (req, reply) => {
    try {
      reply.header('cache-control', 'no-store');
      return await entryOptions(req.params.id);
    } catch (e) {
      req.log.warn({ id: req.params.id, err: (e as Error).message }, 'library options failed');
      return libraryError(reply, e);
    }
  });
  app.post<{ Body: LibraryCategoryRequest }>('/api/library/categories', async (req, reply) => {
    try {
      return { category: addCategory(req.body?.name), state: libraryState() };
    } catch (e) {
      return libraryError(reply, e);
    }
  });
  app.post<{ Params: { id: string }; Body: LibraryCategoryRequest }>('/api/library/categories/:id', async (req, reply) => {
    try {
      return { category: renameCategory(req.params.id, req.body?.name), state: libraryState() };
    } catch (e) {
      return libraryError(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>('/api/library/categories/:id/delete', async (req, reply) => {
    try {
      deleteCategory(req.params.id);
      return libraryState();
    } catch (e) {
      return libraryError(reply, e);
    }
  });
  // Thumbnails are copied once when the link is saved (the platforms' cover URLs expire); the ?v= changes with the file.
  app.get<{ Params: { id: string } }>('/api/library/thumb/:id', async (req, reply) => {
    const f = thumbFile(req.params.id);
    if (!f) return reply.code(404).send({ error: 'No thumbnail' });
    return reply.code(200).headers({ 'content-type': f.mime, 'cache-control': 'public, max-age=31536000, immutable' }).send(fs.createReadStream(f.path));
  });

  app.get('/api/stats', async () => ({ downloads: downloaderStats(), library: libraryStats(), mediaRecords: mediaCount(), exploreStock: exploreStock(), youtubeStock: youtubeStock(), youtubeForYouStock: youtubeForYou?.stats, instagramStock: instagramStock(), instagramForYouStock: instagramForYou?.stats, instagram: instagramStats(), facebookStock: facebookStock(), facebookForYouStock: facebookForYou?.stats, facebook: facebookStats(), forYouStock: forYouStock(), workPage: workState(), uptimeSec: Math.round(process.uptime()) }));

  if (config.serveClient) {
    const dist = findUp(path.join('client', 'dist')) || findUp(path.join('client', 'dist'), process.cwd()) || path.resolve('client', 'dist');
    if (fs.existsSync(dist)) {
      const fastifyStatic = (await import('@fastify/static')).default;
      // The launcher (home.html) is the landing page; the lab player stays at /index.html.
      // Built assets carry a content hash in their name: cache them for good, so opening an app does not
      // revalidate every script and stylesheet over the car's mobile link. Pages keep revalidating.
      const setHeaders = (res: { setHeader(name: string, value: string): void }, filePath: string): void => {
        if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      };
      await app.register(fastifyStatic, { root: dist, prefix: '/', index: ['home.html'], setHeaders });
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
      app.log.info(`StreamAnywhere resolver/proxy listening on ${addr}`);
      warmYtDlp();
      // systemd stop/restart: close the headless browsers first, otherwise the stop waits for the
      // 90 s SIGTERM timeout and Chromium gets SIGKILLed (leaving stale profile locks behind).
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.once(sig, () => {
          app.log.info({ sig }, 'shutting down');
          shutdownYtDlp();
          shutdownDownloader();
          flushLibrary();
          void Promise.race([Promise.all([shutdownBrowsers(), shutdownYouTubeSession(), shutdownInstagram(), shutdownInstagramSession(), shutdownFacebookSession()]), new Promise((r) => setTimeout(r, 8000))]).finally(() => process.exit(0));
        });
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
