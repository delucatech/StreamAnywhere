/**
 * YouTube sign-in with a code, the way a TV signs in: the server asks Google for a short code, the
 * viewer approves it on a phone or computer (google.com/device, or the QR code that carries the
 * code), and Google hands the server a sign-in for "YouTube on TV". No cookies, no browser, no
 * password anywhere near this server.
 *
 * What the sign-in is used for: the account's home feed, read from YouTube's own TV API
 * (youtubei/v1/browse, the TVHTML5 client, `Authorization: Bearer`) over plain HTTPS. Ordinary
 * playback is unchanged (the guest path). Since 2026-11-23 a video YouTube refuses to a guest
 * ("made for kids" through the JS-less client, or the "are you a bot?" check the VM's address gets
 * on the other clients) is looked up as the account: tvBearer() hands the token to youtube.ts,
 * which gives it to yt-dlp for the TV player call only (yt-dlp dropped its own handling of this
 * sign-in in 2024).
 *
 * Measured 2026-11-20 from the dev PC with a real account:
 *  - POST youtube.com/o/oauth2/device/code -> { device_code, user_code "XXXX-XXXX", expires_in 1800,
 *    interval 5, verification_url https://www.google.com/device }. Opening that URL with
 *    ?user_code=XXXX-XXXX skips the typing: Google shows "does this code match?" and then Allow.
 *  - POST youtube.com/o/oauth2/token answers HTTP 200 {error:"authorization_pending"} until the
 *    approval, then { access_token, refresh_token, expires_in ~61800 (17 h) }. A refresh
 *    (grant_type refresh_token) gives a new access token and no new refresh token.
 *  - account/accounts_list: one accountItem per identity of the Google account (brand accounts
 *    included); the approved one has isSelected, and channelHandle when it has a channel.
 *  - browse FEtopics: about 20 videos in 4 shelves of tileRenderer items (title, channel, views,
 *    length, 320x180 picture), 0.4 s; the section list's continuation gives 4 more shelves a call
 *    (0.3 s each), among them a Shorts shelf (reelWatchEndpoint), shows / films (browseEndpoint -
 *    not videos, skipped), live streams (overlay style LIVE - skipped, they are HLS only) and ads
 *    (adSlotRenderer - skipped). A guest gets no videos at all there, only a "sign in" nudge.
 *
 * The client id and secret of "YouTube on TV" are not kept in this repository: they are read from
 * youtube.com/tv (they sit in the page every TV loads), remembered on disk, and stored with the
 * sign-in they issued, because a refresh must name the same client.
 *
 * The sign-in file (~/.streamanywhere/youtube-oauth.json, YOUTUBE_OAUTH_FILE) is the sign-in: treat
 * it like a password. Sign out deletes it and withdraws the grant at Google.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { openUpstream, readBody } from './http';
import { parseDuration, type SearchEntry } from './youtubeSearch';

const DIR = path.join(os.homedir(), '.streamanywhere');
const tokenFile = (): string => process.env.YOUTUBE_OAUTH_FILE || path.join(DIR, 'youtube-oauth.json');
const clientFile = (): string => process.env.YOUTUBE_TV_CLIENT_FILE || path.join(DIR, 'youtube-tv-client.json');
/** What a TV's browser calls itself; youtube.com/tv answers anything else with a redirect to the desktop site. */
const TV_UA = 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version';
const TV_PAGE = 'https://www.youtube.com/tv';
const API = 'https://www.youtube.com/youtubei/v1/';
const DEVICE_CODE_URL = 'https://www.youtube.com/o/oauth2/device/code';
const TOKEN_URL = 'https://www.youtube.com/o/oauth2/token';
const REVOKE_URL = 'https://www.youtube.com/o/oauth2/revoke';
const HOSTS = ['www.youtube.com'];
const SCOPE = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content';
/** The TV client version of 2026-11-20; replaced by what youtube.com/tv serves. */
const DEFAULT_CLIENT_VERSION = '7.20261118.19.00';
const CLIENT_REFRESH_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A fill continues the previous one's "load more" chain while it is this young and this short. */
const CHAIN_TTL_MS = 15 * 60 * 1000;
const CHAIN_MAX_PAGES = 8;
const MAX_REQUESTS_PER_FILL = 4;

/** Google no longer accepts the saved sign-in (revoked, or the account signed the device out). */
export class TvAuthError extends Error {}
/** The answer is not shaped the way this parser expects: YouTube changed its layout. */
export class TvLayoutError extends Error {}

// ---------------------------------------------------------------- parsing (pure)

const text = (o: any): string | undefined => {
  if (!o) return undefined;
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map((r: any) => (typeof r?.text === 'string' ? r.text : '')).join('') || undefined;
  return undefined;
};

export interface TvClient {
  clientId: string;
  clientSecret: string;
  clientVersion: string;
}

/** The "YouTube on TV" client of the page every TV loads: the first clientId/secret pair in it, and its version. */
export function tvClientFromPage(html: string): TvClient | undefined {
  const m = /clientId:"([\w.-]+\.apps\.googleusercontent\.com)",[\w$]+:"([\w-]{10,})"/.exec(html);
  if (!m) return undefined;
  const v = /"INNERTUBE_CLIENT_VERSION":"(\d+\.\d{8}\.\d{2}\.\d{2})"/.exec(html)?.[1];
  return { clientId: m[1], clientSecret: m[2], clientVersion: v || DEFAULT_CLIENT_VERSION };
}

/** "24K views" -> 24000, "1.2M views" -> 1200000, "411 views" -> 411; undefined when it is not a view count. */
export function parseCompactViews(s: string | undefined): number | undefined {
  const m = /^\s*([\d.,]+)\s*([KMB])?\s+views?\s*$/i.exec(s || '');
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

/**
 * One tile of the TV home feed as a flat entry (what entryToFeedItem reads); undefined for
 * everything that is not a playable video: shows, films and playlists (they open a page), ads,
 * buttons.
 */
export function tileToEntry(tile: any): SearchEntry | undefined {
  const cmd = tile?.onSelectCommand;
  const short = cmd?.reelWatchEndpoint;
  const id = cmd?.watchEndpoint?.videoId || short?.videoId;
  if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return undefined;
  const header = tile.header?.tileHeaderRenderer;
  const meta = tile.metadata?.tileMetadataRenderer;
  const overlays: any[] = (header?.thumbnailOverlays || []).map((o: any) => o?.thumbnailOverlayTimeStatusRenderer).filter(Boolean);
  const styles: string[] = overlays.map((o) => o.style).filter(Boolean);
  const lines: string[][] = (meta?.lines || []).map((l: any) => (l?.lineRenderer?.items || []).map((i: any) => text(i?.lineItemRenderer?.text) || ''));
  let views: number | undefined;
  for (const line of lines) for (const part of line) views = views ?? parseCompactViews(part);
  // A video's first line names the channel; a Short has no lines at all.
  const channel = short ? undefined : lines[0]?.find((p) => p && p !== '•' && parseCompactViews(p) === undefined);
  const thumbs: any[] = Array.isArray(header?.thumbnail?.thumbnails) ? header.thumbnail.thumbnails : [];
  return {
    id,
    title: text(meta?.title),
    channel: channel || undefined,
    duration: overlays.map((o) => parseDuration(text(o.text))).find((d) => d !== undefined),
    view_count: views,
    live_status: styles.includes('LIVE') ? 'is_live' : styles.includes('UPCOMING') ? 'is_upcoming' : undefined,
    thumbnails: thumbs.filter((t) => typeof t?.url === 'string').map((t) => ({ url: t.url, width: Number(t.width) || undefined, height: Number(t.height) || undefined })),
  };
}

/**
 * The videos of one home-feed answer (first page or "load more") and the token of the next one.
 * Throws TvLayoutError when the list of shelves is not where it used to be.
 */
export function parseTvFeed(json: any): { entries: SearchEntry[]; token?: string } {
  const list = json?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer || json?.continuationContents?.sectionListContinuation;
  if (!list || !Array.isArray(list.contents)) throw new TvLayoutError(`no list of shelves in the answer (top-level keys: ${Object.keys(json || {}).slice(0, 8).join(', ')})`);
  const entries: SearchEntry[] = [];
  const seen = new Set<string>();
  let tiles = 0;
  const walk = (o: any): void => {
    if (Array.isArray(o)) {
      for (const x of o) walk(x);
      return;
    }
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'adSlotRenderer') continue;
      if (k === 'tileRenderer') {
        tiles++;
        const e = tileToEntry(v);
        if (e && !seen.has(e.id)) {
          seen.add(e.id);
          entries.push(e);
        }
        continue;
      }
      walk(v);
    }
  };
  walk(list.contents);
  if (!tiles && list.contents.length > 1) throw new TvLayoutError(`${list.contents.length} shelves in a layout this parser does not read (no tileRenderer)`);
  const token = list.continuations?.[0]?.nextContinuationData?.continuation;
  return { entries, token: typeof token === 'string' && token ? token : undefined };
}

export interface TvAccount {
  name?: string;
  /** Without the @ */
  handle?: string;
  avatar?: string;
}

/** The identity the code was approved for (isSelected), out of account/accounts_list; undefined when the list is empty. */
export function accountFromAccountsList(json: any): TvAccount | undefined {
  const items: any[] = [];
  const walk = (o: any, depth = 0): void => {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    if (o.accountItem) items.push(o.accountItem);
    else for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(json?.contents);
  const a = items.find((i) => i?.isSelected) || items[0];
  if (!a) return undefined;
  const thumbs: any[] = a.accountPhoto?.thumbnails || [];
  let avatar: string | undefined = thumbs.length ? thumbs[thumbs.length - 1]?.url : undefined;
  if (avatar?.startsWith('//')) avatar = 'https:' + avatar;
  return { name: text(a.accountName), handle: (text(a.channelHandle) || '').replace(/^@/, '') || undefined, avatar };
}

// ---------------------------------------------------------------- network

/** One JSON request to youtube.com (POST when `body` is given). Replaceable in tests. */
export type TvTransport = (url: string, body: unknown | undefined, headers: Record<string, string>) => Promise<{ status: number; text: string }>;

const httpTransport: TvTransport = async (url, body, headers) => {
  const { res, status } = await openUpstream(url, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'user-agent': TV_UA, 'accept-encoding': 'gzip', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    allowlist: HOSTS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  let buf = await readBody(res, 8 * 1024 * 1024);
  if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
  return { status, text: buf.toString('utf8') };
};

let transport: TvTransport = httpTransport;

const parseJson = (t: string): any => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- the TV client (id, secret, version)

let client: (TvClient & { at: number }) | undefined;
let clientLoad: Promise<TvClient> | undefined;

function readJsonFile(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

/** The client of youtube.com/tv: read at most twice a day; a failed read keeps the last one (memory, then disk). */
async function tvClient(log: (m: string) => void): Promise<TvClient> {
  if (client && Date.now() - client.at < CLIENT_REFRESH_MS) return client;
  if (!clientLoad) {
    clientLoad = (async (): Promise<TvClient> => {
      let found: TvClient | undefined;
      let why = '';
      try {
        const r = await transport(TV_PAGE, undefined, { 'accept-language': 'en-US,en;q=0.9' });
        found = r.status === 200 ? tvClientFromPage(r.text) : undefined;
        if (!found) why = r.status === 200 ? 'the page names no sign-in client' : `HTTP ${r.status}`;
      } catch (e) {
        why = (e as Error).message;
      }
      if (found) {
        if (client && client.clientVersion !== found.clientVersion) log(`tv client version ${client.clientVersion} -> ${found.clientVersion}`);
        client = { ...found, at: Date.now() };
        try {
          writePrivate(clientFile(), found);
        } catch {
          /* the next start reads the page again */
        }
        return client;
      }
      const kept: TvClient | undefined = client || readJsonFile(clientFile());
      if (kept?.clientId && kept.clientSecret) {
        log(`youtube.com/tv could not be read (${why}); keeping the TV client read earlier`);
        // Ask again in a few minutes, not on every call.
        client = { clientId: kept.clientId, clientSecret: kept.clientSecret, clientVersion: kept.clientVersion || DEFAULT_CLIENT_VERSION, at: Date.now() - CLIENT_REFRESH_MS + 10 * 60 * 1000 };
        return client;
      }
      throw new Error(`YouTube's TV page could not be read (${why})`);
    })().finally(() => {
      clientLoad = undefined;
    });
  }
  return clientLoad;
}

// ---------------------------------------------------------------- the saved sign-in

interface Saved {
  refreshToken: string;
  accessToken?: string;
  /** ms epoch */
  expiresAt?: number;
  /** The client that issued the tokens: a refresh must name the same one */
  clientId: string;
  clientSecret: string;
  savedAt: number;
}

let saved: Saved | undefined | null;

function load(): Saved | undefined {
  if (saved === undefined) {
    const j = readJsonFile(tokenFile());
    saved = j && typeof j.refreshToken === 'string' && typeof j.clientId === 'string' && typeof j.clientSecret === 'string' ? (j as Saved) : null;
  }
  return saved || undefined;
}

function store(s: Saved): void {
  saved = s;
  writePrivate(tokenFile(), s);
}

/** A code sign-in is saved on this server (whether Google still accepts it is tvAccount's answer). */
export const tvSignedIn = (): boolean => Boolean(load());
export const tvSavedAt = (): number | undefined => load()?.savedAt;

/** Forgets the sign-in; `revoke` also withdraws the grant at Google (a sign-out, not a dead token). */
export async function tvForget(revoke: boolean, log: (m: string) => void): Promise<void> {
  const s = load();
  saved = null;
  chain = undefined;
  try {
    fs.rmSync(tokenFile(), { force: true });
  } catch {
    /* ignore */
  }
  if (revoke && s) {
    try {
      const r = await transport(`${REVOKE_URL}?token=${encodeURIComponent(s.refreshToken)}`, {}, {});
      log(r.status === 200 ? 'the sign-in was withdrawn at Google' : `Google answered ${r.status} to withdrawing the sign-in (it stays listed under the Google account's third-party access until removed there)`);
    } catch (e) {
      log(`the sign-in could not be withdrawn at Google (${(e as Error).message}); it is deleted here`);
    }
  }
}

let refreshing: Promise<string> | undefined;

/** A valid access token, renewed with the refresh token when it has under five minutes left. */
async function accessToken(force = false): Promise<string> {
  const s = load();
  if (!s) throw new TvAuthError('not signed in');
  if (!force && s.accessToken && (s.expiresAt || 0) - Date.now() > 5 * 60 * 1000) return s.accessToken;
  if (!refreshing) {
    refreshing = (async (): Promise<string> => {
      const r = await transport(TOKEN_URL, { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken, grant_type: 'refresh_token' }, {});
      const j = parseJson(r.text) || {};
      if (typeof j.access_token === 'string') {
        // The sign-in may have been replaced or deleted while Google answered.
        if (load() === s) store({ ...s, accessToken: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : s.refreshToken });
        return j.access_token;
      }
      if (j.error === 'invalid_grant' || j.error === 'invalid_client' || j.error === 'unauthorized_client') throw new TvAuthError(`Google no longer accepts the saved sign-in (${j.error})`);
      throw new Error(`Google answered ${r.status} to renewing the sign-in${j.error ? ` (${j.error})` : ''}`);
    })().finally(() => {
      refreshing = undefined;
    });
  }
  return refreshing;
}

/**
 * A valid access token of the code sign-in, for a request made as the account outside this file
 * (youtube.ts: a video YouTube refuses to a guest); undefined when there is no sign-in, Google no
 * longer accepts it, or it could not be renewed right now. It is the sign-in: never logged, and
 * sent nowhere but youtube.com.
 */
export async function tvBearer(): Promise<string | undefined> {
  if (!load()) return undefined;
  try {
    return await accessToken();
  } catch {
    return undefined;
  }
}

/** One call of YouTube's TV API as the signed-in account. Throws TvAuthError when the sign-in is dead. */
async function tvApi(endpoint: string, body: Record<string, unknown>, log: (m: string) => void): Promise<any> {
  const c = await tvClient(log).catch((): TvClient => ({ clientId: '', clientSecret: '', clientVersion: client?.clientVersion || DEFAULT_CLIENT_VERSION }));
  const payload = { context: { client: { clientName: 'TVHTML5', clientVersion: c.clientVersion, hl: 'en', gl: 'US' } }, ...body };
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(attempt > 0);
    const r = await transport(`${API}${endpoint}?prettyPrint=false`, payload, { authorization: `Bearer ${token}`, 'x-youtube-client-name': '7', 'x-youtube-client-version': c.clientVersion });
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 401) throw new TvAuthError('YouTube refused the sign-in (401)');
    if (r.status !== 200) throw new Error(`YouTube answered ${r.status} to ${endpoint}: ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    const j = parseJson(r.text);
    if (!j) throw new TvLayoutError(`the answer to ${endpoint} is not JSON (${r.text.slice(0, 80)})`);
    return j;
  }
}

// ---------------------------------------------------------------- sign-in with a code

export interface PendingCode {
  deviceCode: string;
  /** What the viewer types or confirms, "XXXX-XXXX" */
  userCode: string;
  /** Where: https://www.google.com/device */
  url: string;
  /** ms epoch */
  expiresAt: number;
  intervalMs: number;
  client: TvClient;
}

/** Asks Google for a code to approve. */
export async function requestCode(log: (m: string) => void): Promise<PendingCode> {
  const c = await tvClient(log);
  const r = await transport(DEVICE_CODE_URL, { client_id: c.clientId, scope: SCOPE, device_id: crypto.randomUUID(), device_model: 'ytlr::' }, {});
  const j = parseJson(r.text) || {};
  if (r.status !== 200 || typeof j.device_code !== 'string' || typeof j.user_code !== 'string') throw new Error(`Google answered ${r.status} to the request for a code${j.error ? ` (${j.error})` : ''}`);
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    url: typeof j.verification_url === 'string' && /^https:\/\//.test(j.verification_url) ? j.verification_url : 'https://www.google.com/device',
    expiresAt: Date.now() + (Number(j.expires_in) || 1800) * 1000,
    intervalMs: Math.max(2, Number(j.interval) || 5) * 1000,
    client: c,
  };
}

export type CodePoll = 'pending' | 'slow_down' | 'approved' | 'denied' | 'expired';

/** Asks Google once whether the code was approved; 'approved' has saved the sign-in. */
export async function pollCode(p: PendingCode): Promise<CodePoll> {
  const r = await transport(TOKEN_URL, { client_id: p.client.clientId, client_secret: p.client.clientSecret, code: p.deviceCode, grant_type: 'http://oauth.net/grant_type/device/1.0' }, {});
  const j = parseJson(r.text) || {};
  if (typeof j.access_token === 'string' && typeof j.refresh_token === 'string') {
    chain = undefined;
    store({ refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, clientId: p.client.clientId, clientSecret: p.client.clientSecret, savedAt: Date.now() });
    return 'approved';
  }
  if (j.error === 'authorization_pending') return 'pending';
  if (j.error === 'slow_down') return 'slow_down';
  if (j.error === 'access_denied') return 'denied';
  if (j.error === 'expired_token' || j.error === 'invalid_grant') return 'expired';
  throw new Error(`Google answered ${r.status} while waiting for the approval${j.error ? ` (${j.error})` : ''}`);
}

// ---------------------------------------------------------------- account and feed

export interface TvAccountCheck extends TvAccount {
  /** false: YouTube could not be asked (network); the sign-in is kept */
  ok: boolean;
  loggedIn: boolean;
  error?: string;
}

/** Who the saved sign-in is, straight from YouTube. A dead sign-in answers loggedIn:false. */
export async function tvAccount(log: (m: string) => void): Promise<TvAccountCheck> {
  if (!load()) return { ok: true, loggedIn: false, error: 'no code sign-in saved' };
  try {
    const acc = accountFromAccountsList(await tvApi('account/accounts_list', {}, log));
    return acc ? { ok: true, loggedIn: true, ...acc } : { ok: true, loggedIn: false, error: 'YouTube lists no account for the sign-in' };
  } catch (e) {
    if (e instanceof TvAuthError) return { ok: true, loggedIn: false, error: e.message };
    return { ok: false, loggedIn: false, error: (e as Error).message };
  }
}

interface Chain {
  /** undefined: start from the top; null: the feed ended */
  token?: string | null;
  at: number;
  pages: number;
  seen: Set<string>;
}

let chain: Chain | undefined;
let feedLock: Promise<unknown> = Promise.resolve();

/**
 * About `count` videos of the account's home feed that this chain has not given yet. One fill
 * continues the previous one ("load more") while the chain is young and short, then starts from the
 * top again, where YouTube has re-sampled the recommendations. Fills run one after another.
 */
export async function tvHomeFeed(count: number, log: (m: string) => void): Promise<{ entries: SearchEntry[]; requests: number }> {
  const run = feedLock.then(async () => {
    if (!chain || chain.token === null || Date.now() - chain.at > CHAIN_TTL_MS || chain.pages >= CHAIN_MAX_PAGES) chain = { at: Date.now(), pages: 0, seen: new Set() };
    const st = chain;
    const entries: SearchEntry[] = [];
    let requests = 0;
    try {
      while (entries.length < count && st.token !== null && requests < MAX_REQUESTS_PER_FILL) {
        const parsed = parseTvFeed(await tvApi('browse', st.token ? { continuation: st.token } : { browseId: 'FEtopics' }, log));
        requests++;
        st.pages++;
        st.token = parsed.token ?? null;
        for (const e of parsed.entries) {
          if (st.seen.has(e.id)) continue;
          st.seen.add(e.id);
          entries.push(e);
        }
      }
    } catch (e) {
      if (chain === st) chain = undefined;
      // What was gathered before the failure is still good; only a fill with nothing fails.
      if (!entries.length || e instanceof TvAuthError) throw e;
      log(`home feed: stopped after ${requests} request(s) (${(e as Error).message.slice(0, 120)})`);
    }
    return { entries, requests };
  });
  feedLock = run.catch(() => undefined);
  return run;
}

/** Tests: replace the network (undefined restores it) and forget everything held in memory. */
export function setTvTransport(t: TvTransport | undefined): void {
  transport = t || httpTransport;
  client = undefined;
  saved = undefined;
  chain = undefined;
}
