/**
 * TikTok feed sources.
 *
 *  explore: GET https://www.tiktok.com/api/explore/item_list/?aid=1988&categoryType=<id>&count=<n>
 *           Verified 2026-10-08: answers without any signature (no msToken / X-Bogus / X-Gnarly);
 *           cursor is always 0, hasMore true, so "more" means "call again". Measured 2026-10-10:
 *           the same category+count is answered from a cache for ~1 min (identical batch), a
 *           different count gives a fresh sample, and "All" holds ~110 distinct videos per minute
 *           before it repeats (reservoir.ts / index.ts vary the count and borrow categories).
 *           Needs the tt_chain_token/ttwid cookies of a page visit first; the
 *           playAddr URLs in the response are signed for THAT session (proxy-only, like the resolver).
 *           Every bitrate variant also carries the cookie-free /aweme/v1/play URL (browser-direct).
 *           TikTok occasionally answers with an empty body (anti-bot); the caller retries.
 *
 *  foryou:  served from a signed-in real browser (session.ts): TikTok's own web app does the
 *           request signing, we only read the JSON that comes back.
 *
 * Both produce FeedItem[] through itemToFeedItem(), which mirrors the resolver's format list so the
 * feed UI and the lab player share the direct-vs-proxy logic.
 */
import type { CodecFamily, FeedItem, MediaFormat } from '../../shared/types';
import { jarHeader, newJar, openUpstream, readBody, type CookieJar } from './http';
import { defaultExpiry, registerMedia } from './mediaStore';
import { tiktokAllowlist } from './tiktok';

export const EXPLORE_DEFAULT_CATEGORY = 120;
const MAX_COUNT = 30;

export class FeedError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 502) {
    super(message);
  }
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
    const e = new URL(url).searchParams.get('expire');
    if (e && /^\d+$/.test(e)) return Number(e);
  } catch {
    /* ignore */
  }
  return undefined;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
};

function safeHost(u: string): string | undefined {
  try {
    return new URL(u).hostname;
  } catch {
    return undefined;
  }
}

export interface UpstreamSession {
  cookieHeader: string;
  referer: string;
}

/**
 * Converts a TikTok "itemStruct" (as found in feed responses and page JSON) into a FeedItem.
 * `upstream` is what the proxy must send for the cookie-bound playAddr URLs; pass undefined when
 * the upstream session is unknown (then only direct URLs are offered).
 */
export function itemToFeedItem(item: any, upstream?: UpstreamSession): FeedItem | undefined {
  const video = item?.video;
  if (!item?.id || !video) return undefined;
  const author = typeof item.author === 'object' && item.author ? item.author : {};
  const uniqueId: string | undefined = author.uniqueId || (typeof item.author === 'string' ? item.author : undefined);
  const variants: any[] = Array.isArray(video.bitrateInfo) && video.bitrateInfo.length ? video.bitrateInfo : [];
  if (!variants.length && video.playAddr) {
    variants.push({ GearName: 'playAddr', CodecType: video.codecType, Bitrate: video.bitrate, PlayAddr: { UrlList: [video.playAddr] } });
  }
  const formats: MediaFormat[] = [];
  for (const v of variants) {
    const urls: string[] = v?.PlayAddr?.UrlList || [];
    if (!urls.length) continue;
    const cookieBound = urls.find((u) => !u.includes('/aweme/v1/play/')) || urls[0];
    const redirectUrl = urls.find((u) => u.includes('/aweme/v1/play/'));
    const gear: string = v.GearName || 'unknown';
    const h = /(\d{3,4})/.exec(gear);
    const height = h ? Number(h[1]) : num(v?.PlayAddr?.Height);
    const fmt: MediaFormat = {
      id: gear,
      label: `${gear} (${v.CodecType || 'codec?'}${v.Bitrate ? `, ${Math.round(v.Bitrate / 1000)} kbps` : ''})`,
      codec: codecFamily(v.CodecType),
      codecDetail: v.CodecType,
      bitrate: num(v.Bitrate),
      width: height && video.width && video.height ? Math.round((height * video.width) / video.height) : num(v?.PlayAddr?.Width),
      height,
      cookieBoundUrl: cookieBound,
      requiresCookies: true,
      expiresAt: expiryFromUrl(cookieBound),
      upstreamHost: safeHost(cookieBound),
    };
    if (redirectUrl) {
      fmt.directUrl = redirectUrl;
      fmt.directKind = 'redirect';
      fmt.redirectUrl = redirectUrl;
    }
    if (upstream && /^https:/.test(cookieBound)) {
      const rec = registerMedia({
        url: cookieBound,
        headers: { referer: upstream.referer, cookie: upstream.cookieHeader },
        label: `tiktok ${item.id} ${gear}`,
        source: 'tiktok',
        expiresAt: fmt.expiresAt ? fmt.expiresAt * 1000 : defaultExpiry(),
      });
      fmt.proxyUrl = `/api/media/${rec.id}`;
      fmt.mediaId = rec.id;
    }
    if (fmt.directUrl || fmt.proxyUrl) formats.push(fmt);
  }
  if (!formats.length) return undefined;
  formats.sort((a, b) => (a.codec === 'h264' ? -1 : 1) - (b.codec === 'h264' ? -1 : 1) || (b.bitrate || 0) - (a.bitrate || 0));
  const stats = item.stats || {};
  return {
    id: String(item.id),
    canonicalUrl: `https://www.tiktok.com/@${uniqueId || '_'}/video/${item.id}`,
    author: { id: author.id, uniqueId, nickname: author.nickname, avatar: author.avatarThumb || author.avatarMedium },
    desc: typeof item.desc === 'string' ? item.desc : undefined,
    createTime: num(item.createTime),
    duration: num(video.duration),
    width: num(video.width),
    height: num(video.height),
    cover: video.cover || video.originCover,
    music: item.music?.title,
    stats: { plays: num(stats.playCount), likes: num(stats.diggCount), comments: num(stats.commentCount), shares: num(stats.shareCount) },
    formats,
  };
}

/** Shared across explore calls: TikTok's cookies live a long time and a warm jar avoids a page hit per call. */
let exploreJar: CookieJar | undefined;
let exploreJarAt = 0;

async function warmJar(log?: (m: string) => void, force = false): Promise<CookieJar> {
  if (!force && exploreJar && Date.now() - exploreJarAt < 30 * 60 * 1000) return exploreJar;
  const jar = newJar();
  const { res, status } = await openUpstream('https://www.tiktok.com/explore', {
    allowlist: tiktokAllowlist,
    maxRedirects: 5,
    jar,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
  });
  res.destroy();
  if (status !== 200) throw new FeedError(`TikTok explore page returned HTTP ${status}`, 'page_status');
  log?.(`explore cookie jar warmed: ${[...jar.cookies.keys()].join(', ')}`);
  exploreJar = jar;
  exploreJarAt = Date.now();
  return jar;
}

export interface ExploreOptions {
  category?: number;
  count?: number;
  log?: (msg: string) => void;
}

export interface ExploreResult {
  items: FeedItem[];
  hasMore: boolean;
  warnings: string[];
  /** Raw item count TikTok returned (before filtering) */
  raw: number;
}

/** The explore API URL (same parameters TikTok's web client sends, minus its signatures). */
export function exploreApiUrl(category: number, count: number): string {
  const params = new URLSearchParams({
    aid: '1988',
    app_language: 'en',
    app_name: 'tiktok_web',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: '5.0 (Windows)',
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    categoryType: String(category),
    count: String(count),
    device_platform: 'web_pc',
    from_page: 'explore',
    language: 'en',
    os: 'windows',
    region: 'US',
    screen_height: '1080',
    screen_width: '1920',
    tz_name: 'America/New_York',
    webcast_language: 'en',
  });
  return 'https://www.tiktok.com/api/explore/item_list/?' + params.toString();
}

/** Parses an explore API body into feed items (shared by the direct and the browser path). */
export function parseExploreBody(text: string, upstream: UpstreamSession | undefined, warnings: string[]): { items: FeedItem[]; hasMore: boolean; raw: number } {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new FeedError(`Explore API JSON could not be parsed: ${(e as Error).message}`, 'bad_json');
  }
  const code = Number(json.statusCode ?? json.status_code ?? 0);
  if (code !== 0) throw new FeedError(`TikTok explore API status ${code}: ${json.statusMsg || json.status_msg || 'unavailable'}`, 'tiktok_status_' + code);
  const list: any[] = Array.isArray(json.itemList) ? json.itemList : [];
  const items: FeedItem[] = [];
  for (const raw of list) {
    const it = itemToFeedItem(raw, upstream);
    if (it) items.push(it);
  }
  if (list.length && !items.length) warnings.push('explore returned items but none had playable formats');
  return { items, hasMore: json.hasMore !== false, raw: list.length };
}

export function normalizeExploreOptions(opts: ExploreOptions): { category: number; count: number } {
  return {
    category: Number.isInteger(opts.category) ? (opts.category as number) : EXPLORE_DEFAULT_CATEGORY,
    count: Math.max(1, Math.min(MAX_COUNT, opts.count || 16)),
  };
}

export async function fetchExploreFeed(opts: ExploreOptions = {}): Promise<ExploreResult> {
  const { category, count } = normalizeExploreOptions(opts);
  const warnings: string[] = [];
  const jar = await warmJar(opts.log);
  const url = exploreApiUrl(category, count);
  let lastErr: Error | undefined;
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // An empty 200 body is TikTok's soft refusal; a fresh cookie jar plus a pause gets a real answer.
    const jarNow = attempt > 1 ? await warmJar(opts.log, attempt > 2) : jar;
    const { res, status } = await openUpstream(url, {
      allowlist: tiktokAllowlist,
      jar: jarNow,
      headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.tiktok.com/explore' },
    });
    const text = (await readBody(res, 16 * 1024 * 1024)).toString('utf8');
    if (status !== 200) {
      lastErr = new FeedError(`TikTok explore API returned HTTP ${status}: ${text.slice(0, 200)}`, 'api_status');
    } else if (!text.trim()) {
      // Observed: an empty 200 body now and then (anti-bot); a retry a moment later succeeds.
      lastErr = new FeedError(`TikTok explore API returned an empty body ${attempts} times (soft rate limit); try again in a minute`, 'empty_body');
      warnings.push(`attempt ${attempt}: empty body from TikTok, retrying`);
    } else {
      const upstream: UpstreamSession = { cookieHeader: jarHeader(jarNow), referer: 'https://www.tiktok.com/explore' };
      const parsed = parseExploreBody(text, upstream, warnings);
      opts.log?.(`explore category ${category}: ${parsed.items.length}/${parsed.raw} items`);
      return { ...parsed, warnings };
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  throw lastErr || new FeedError('explore feed failed', 'unknown');
}
