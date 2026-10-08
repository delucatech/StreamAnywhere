/**
 * Native TikTok resolver (no third-party dependency).
 *
 * How it works (verified 2026-10-08 against public videos):
 *  1. GET https://www.tiktok.com/@user/video/<id> with a desktop UA. The response sets the
 *     cookies tt_chain_token / ttwid / tt_csrf_token and embeds a JSON blob in
 *     <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> (older pages: ...REBOOTING or SIGI_STATE).
 *  2. __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct.video holds:
 *       - playAddr / downloadAddr: v16-webapp-prime.<region>.tiktok.com URLs. These are signed
 *         for THIS session's tt_chain_token (403 without the cookie, 403 with another session's
 *         cookie, 403 without a tiktok.com Referer) and send
 *         Access-Control-Allow-Origin: https://www.tiktok.com -> never fetchable from another origin.
 *       - bitrateInfo[]: per-quality variants (h264 and h265/"bytevc1"). Each PlayAddr.UrlList ends
 *         with a https://www.tiktok.com/aweme/v1/play/?... URL. That URL needs NO cookies, answers
 *         CORS preflight with the caller's Origin, and 302-redirects to a
 *         v16m-default.tiktokcdn-*.com URL that sends Access-Control-Allow-Origin: * and supports
 *         Range requests. This is the only known path to genuinely direct browser fetches.
 *
 * Only public videos are handled; private / login-gated items are reported as errors.
 */
import type { CodecFamily, MediaFormat, ResolveResponse, ServerProbe } from '../../shared/types';
import { config } from './config';
import { newJar, openUpstream, readBody, resolveRedirect, jarHeader, type CookieJar } from './http';
import { defaultExpiry, registerMedia } from './mediaStore';

const TIKTOK_PAGE_HOSTS = ['www.tiktok.com', 'tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];

export class TikTokError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export function isTikTokUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /(^|\.)tiktok\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export interface ParsedTikTokUrl {
  videoId?: string;
  /** URL to fetch the page from (may be a short link that must be followed) */
  pageUrl: string;
  isShortLink: boolean;
}

export function parseTikTokUrl(raw: string): ParsedTikTokUrl {
  const u = new URL(raw);
  if (!TIKTOK_PAGE_HOSTS.includes(u.hostname.toLowerCase()) && !/\.tiktok\.com$/i.test(u.hostname)) {
    throw new TikTokError(`Not a TikTok URL: ${u.hostname}`, 'not_tiktok');
  }
  const m = /\/(?:@[^/]+\/)?(?:video|photo)\/(\d{6,})/.exec(u.pathname) || /\/v\/(\d{6,})\.html/.exec(u.pathname);
  if (u.pathname.includes('/photo/')) throw new TikTokError('Photo/slideshow posts are not supported', 'unsupported_photo');
  if (m) return { videoId: m[1], pageUrl: `https://www.tiktok.com${u.pathname}`, isShortLink: false };
  const embed = /\/embed\/(?:v2\/)?(\d{6,})/.exec(u.pathname) || /\/player\/v1\/(\d{6,})/.exec(u.pathname);
  if (embed) return { videoId: embed[1], pageUrl: `https://www.tiktok.com/@_/video/${embed[1]}`, isShortLink: false };
  // vm.tiktok.com/XXXX, vt.tiktok.com/XXXX, www.tiktok.com/t/XXXX
  if (/^\/(t\/)?[A-Za-z0-9]+\/?$/.test(u.pathname)) return { pageUrl: u.toString(), isShortLink: true };
  throw new TikTokError(`Unrecognised TikTok URL path: ${u.pathname}`, 'bad_path');
}

const ALLOW_TIKTOK = ['*.tiktok.com', '*.tiktokcdn.com', '*.tiktokcdn-us.com', '*.tiktokcdn-eu.com', '*.tiktokv.com'];

async function followShortLink(url: string): Promise<string> {
  const { res, status, finalUrl } = await openUpstream(url, { allowlist: ALLOW_TIKTOK, maxRedirects: 5, headers: { accept: 'text/html' } });
  res.destroy();
  if (status >= 400) throw new TikTokError(`Short link returned HTTP ${status}`, 'short_link');
  return finalUrl;
}

interface PageData {
  html: string;
  json: any;
  jar: CookieJar;
  finalUrl: string;
}

async function fetchPage(pageUrl: string): Promise<PageData> {
  const jar = newJar();
  const { res, status, finalUrl } = await openUpstream(pageUrl, {
    allowlist: ALLOW_TIKTOK,
    maxRedirects: 5,
    jar,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1',
    },
  });
  if (status !== 200) {
    res.destroy();
    throw new TikTokError(`TikTok page returned HTTP ${status}`, 'page_status');
  }
  const html = (await readBody(res, 12 * 1024 * 1024)).toString('utf8');
  const m =
    /<script id="__UNIVERSAL_DATA_FOR_RE(?:HYDRATION|BOOTING)__" type="application\/json">(.*?)<\/script>/s.exec(html) ||
    /<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/s.exec(html);
  if (!m) {
    const title = /<title[^>]*>(.*?)<\/title>/s.exec(html)?.[1]?.trim();
    throw new TikTokError(
      `No embedded video JSON found in the TikTok page (title: ${title || 'n/a'}). TikTok may have served a bot-check or changed its markup.`,
      'no_json',
    );
  }
  let json: any;
  try {
    json = JSON.parse(m[1]);
  } catch (e) {
    throw new TikTokError(`Embedded JSON could not be parsed: ${(e as Error).message}`, 'bad_json');
  }
  return { html, json, jar, finalUrl };
}

function codecFamily(codecType: string | undefined): CodecFamily {
  const c = (codecType || '').toLowerCase();
  if (c.includes('h264') || c.includes('avc')) return 'h264';
  if (c.includes('h265') || c.includes('hvc') || c.includes('hevc') || c.includes('bytevc1')) return 'h265';
  if (c.includes('av1')) return 'av1';
  if (c.includes('vp9')) return 'vp9';
  return 'unknown';
}

function expiryFromUrl(url: string): number | undefined {
  try {
    const u = new URL(url);
    const e = u.searchParams.get('expire') || u.searchParams.get('x-expires');
    if (e && /^\d+$/.test(e)) return Number(e);
    // v16m-default.tiktokcdn-us.com/<hash>/<hex-epoch>/video/... -> second path segment is hex seconds
    const seg = u.pathname.split('/')[2];
    if (seg && /^[0-9a-f]{8}$/.test(seg)) {
      const t = parseInt(seg, 16);
      if (t > 1_600_000_000 && t < 4_000_000_000) return t;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

const STATUS_MESSAGES: Record<number, string> = {
  10204: 'Video not found (deleted or wrong id)',
  10216: 'Video is private',
  10222: 'Video is private (account is private)',
  10231: 'Video is region-restricted',
  10239: 'Video is age-restricted / requires login',
};

export interface NativeResolveOptions {
  probeOrigin?: string;
  probe?: boolean;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const str = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.join(', ') : v);

/** Server-side CORS probe: GET with Origin + Range bytes=0-1, following redirects (allowlisted hosts only). */
export async function probeUrl(url: string, origin: string, allowlist: string[]): Promise<ServerProbe> {
  const t0 = Date.now();
  try {
    const { res, status, finalUrl, redirects } = await openUpstream(url, {
      allowlist,
      maxRedirects: 5,
      headers: { origin, range: 'bytes=0-1', referer: origin + '/' },
    });
    const h = res.headers;
    res.destroy();
    return {
      url,
      status,
      ok: status >= 200 && status < 300,
      finalUrl,
      redirects,
      requestedOrigin: origin,
      elapsedMs: Date.now() - t0,
      headers: {
        accessControlAllowOrigin: h['access-control-allow-origin'] as string | undefined,
        accessControlAllowCredentials: h['access-control-allow-credentials'] as string | undefined,
        accessControlExposeHeaders: h['access-control-expose-headers'] as string | undefined,
        acceptRanges: h['accept-ranges'] as string | undefined,
        contentType: str(h['content-type']),
        contentLength: str(h['content-length']),
        contentRange: str(h['content-range']),
        server: str(h['server']),
      },
    };
  } catch (e) {
    return {
      url,
      status: 0,
      ok: false,
      error: (e as Error).message,
      redirects: 0,
      requestedOrigin: origin,
      elapsedMs: Date.now() - t0,
      headers: {},
    };
  }
}

export async function resolveTikTokNative(inputUrl: string, opts: NativeResolveOptions = {}): Promise<ResolveResponse> {
  const t0 = Date.now();
  const log = opts.log || (() => undefined);
  const warnings: string[] = [];
  let parsed = parseTikTokUrl(inputUrl);
  if (parsed.isShortLink) {
    const target = await followShortLink(parsed.pageUrl);
    log('short link resolved', { target });
    parsed = parseTikTokUrl(target);
    if (!parsed.videoId) throw new TikTokError('Short link did not lead to a video page', 'short_link');
  }
  const page = await fetchPage(parsed.pageUrl);
  const scope = page.json.__DEFAULT_SCOPE__;
  let item: any;
  if (scope) {
    const detail = scope['webapp.video-detail'];
    if (!detail) throw new TikTokError('Page JSON has no webapp.video-detail (login wall or unsupported post type?)', 'no_detail');
    const code = Number(detail.statusCode ?? 0);
    if (code !== 0) {
      throw new TikTokError(`TikTok reports status ${code}: ${STATUS_MESSAGES[code] || detail.statusMsg || 'unavailable'}`, 'tiktok_status_' + code);
    }
    item = detail.itemInfo?.itemStruct;
  } else if (page.json.ItemModule) {
    // legacy SIGI_STATE layout
    item = page.json.ItemModule[parsed.videoId || Object.keys(page.json.ItemModule)[0]];
  }
  if (!item?.video) throw new TikTokError('No video item in page JSON', 'no_item');
  const video = item.video;
  const cookieHeader = jarHeader(page.jar);
  const referer = page.finalUrl;
  if (!page.jar.cookies.has('tt_chain_token')) warnings.push('tt_chain_token cookie was not set by TikTok; cookie-bound URLs may fail');

  const upstreamHeaders = { referer, cookie: cookieHeader };
  const formats: MediaFormat[] = [];
  const probeOrigin = opts.probeOrigin || 'http://localhost:5173';

  const variants: any[] = Array.isArray(video.bitrateInfo) && video.bitrateInfo.length ? video.bitrateInfo : [];
  if (!variants.length && video.playAddr) {
    variants.push({ GearName: 'playAddr', CodecType: video.codecType, Bitrate: video.bitrate, PlayAddr: { UrlList: [video.playAddr] }, PlayAddrIsPrimary: true });
  }
  for (const v of variants) {
    const urls: string[] = v?.PlayAddr?.UrlList || [];
    if (!urls.length) continue;
    const cookieBound = urls.find((u) => !u.includes('/aweme/v1/play/')) || urls[0];
    const redirectUrl = urls.find((u) => u.includes('/aweme/v1/play/'));
    const gear: string = v.GearName || 'unknown';
    const resMatch = /(\d{3,4})/.exec(gear);
    const codec = codecFamily(v.CodecType);
    const heightGuess = resMatch ? Number(resMatch[1]) : undefined;
    const rec = registerMedia({
      url: cookieBound,
      headers: upstreamHeaders,
      label: `tiktok ${item.id} ${gear}`,
      source: 'tiktok',
      expiresAt: (expiryFromUrl(cookieBound) ? expiryFromUrl(cookieBound)! * 1000 : defaultExpiry()),
    });
    const fmt: MediaFormat = {
      id: gear,
      label: `${gear} (${v.CodecType || 'codec?'}${v.Bitrate ? `, ${Math.round(v.Bitrate / 1000)} kbps` : ''})`,
      codec,
      codecDetail: v.CodecType,
      bitrate: v.Bitrate,
      width: heightGuess && video.width && video.height ? Math.round((heightGuess * video.width) / video.height) : undefined,
      height: heightGuess,
      proxyUrl: `/api/media/${rec.id}`,
      mediaId: rec.id,
      cookieBoundUrl: cookieBound,
      requiresCookies: true,
      expiresAt: expiryFromUrl(cookieBound),
      upstreamHost: new URL(cookieBound).hostname,
    };
    if (redirectUrl) {
      fmt.directUrl = redirectUrl;
      fmt.directKind = 'redirect';
      fmt.redirectUrl = redirectUrl;
      try {
        // Resolve the cookie-free redirect server-side so the browser can hit the CDN URL directly.
        const r = await resolveRedirect(redirectUrl, ALLOW_TIKTOK, { referer: 'https://www.tiktok.com/' });
        if (r.status >= 200 && r.status < 400 && r.finalUrl !== redirectUrl) {
          fmt.directUrl = r.finalUrl;
          fmt.directKind = 'cdn';
          fmt.expiresAt = expiryFromUrl(r.finalUrl) ?? fmt.expiresAt;
        } else {
          warnings.push(`${gear}: redirect URL answered HTTP ${r.status}; browser will try the redirect itself`);
        }
      } catch (e) {
        warnings.push(`${gear}: could not resolve redirect URL server-side: ${(e as Error).message}`);
      }
      if (opts.probe !== false && fmt.directUrl) {
        fmt.serverProbe = await probeUrl(fmt.directUrl, probeOrigin, ALLOW_TIKTOK);
      }
    } else {
      warnings.push(`${gear}: no cookie-free URL in UrlList; only the proxy can deliver it`);
    }
    formats.push(fmt);
  }
  // Prefer H.264 first (WebCodecs/HTML5 baseline), then by bitrate desc
  formats.sort((a, b) => (a.codec === 'h264' ? -1 : 1) - (b.codec === 'h264' ? -1 : 1) || (b.bitrate || 0) - (a.bitrate || 0));
  if (!formats.length) throw new TikTokError('No playable formats found in page JSON', 'no_formats');

  log('native resolve ok', { id: item.id, formats: formats.length, cookies: [...page.jar.cookies.keys()] });
  return {
    source: 'tiktok',
    resolver: 'native',
    id: String(item.id || parsed.videoId),
    inputUrl,
    canonicalUrl: page.finalUrl,
    title: item.desc,
    author: item.author?.uniqueId || item.author?.nickname || (typeof item.author === 'string' ? item.author : undefined),
    duration: video.duration,
    width: video.width,
    height: video.height,
    cover: video.cover,
    formats,
    warnings,
    elapsedMs: Date.now() - t0,
    attempts: [],
  };
}

export const tiktokAllowlist = ALLOW_TIKTOK;
export const userAgent = config.userAgent;
