/**
 * TikTok's web API as a signed-out visitor, without a browser.
 *
 * Two things make TikTok answer (measured 2026-11-25 from the PC and from the VM's Google address;
 * each one alone gets an empty 200):
 *   1. the request signature its page script adds (X-Dynosaur / X-Gnarly), computed by tiktokSign.ts;
 *   2. a connection opened the way Chrome opens it (tlsBridge.ts, the curl_cffi helper).
 *
 * A guest visit ("session") is three requests: a device registration (the ttwid cookie), the Explore
 * page (the device id, region and csrf token TikTok gave this visitor) and one unsigned list call
 * whose answer sets the msToken cookie. It is kept for SESSION_MS / SESSION_CALLS and replaced when
 * TikTok answers it with an empty body (its throttle is per session; a new one gets through).
 *
 * Used for a video's comments (social.ts fetchComments), which until now needed the signed-in
 * headless browser. Nothing here is personal: the answers are what tiktok.com shows anyone who is not
 * signed in, and the user's TikTok session is never sent.
 *
 * The signer imitates ONE build of TikTok's script. When TikTok changes the maths, every call comes
 * back empty: after FAILS_TO_PAUSE such failures in a row the path is paused for PAUSE_MS and the
 * callers go straight to their fallback (the browser); the next call after the pause tries again.
 * /api/health (tiktokGuest) says which state it is in, and GET /api/comments/check runs one call.
 */
import { say } from './activity';
import { DEFAULT_SCM_VERSION, DEFAULT_SDK_VERSION, signRequest } from './tiktokSign';
import { chromeRequest, tlsBridgeStatus, tlsBridgeUsable, TlsBridgeError, type ChromeAnswer, type TlsBridgeStatus } from './tlsBridge';

const ORIGIN = 'https://www.tiktok.com';
/** The signer hashes the browser name: the header and the signature must say the same one. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SESSION_MS = 20 * 60 * 1000;
const SESSION_CALLS = 150;
/** Between two API calls: TikTok answers calls that come too close together with an empty body. */
const GAP_MS = Math.max(0, Number(process.env.TIKTOK_GUEST_GAP_MS) || 600);
const FAILS_TO_PAUSE = 3;
const PAUSE_MS = 10 * 60 * 1000;
const OFF = /^(0|off|false|no)$/i.test(process.env.TIKTOK_GUEST || '');

export type GuestFailure = 'empty' | 'blocked' | 'status' | 'session' | 'helper';

export class GuestError extends Error {
  /** `code`: TikTok's own status code when it read the request and said no (kind `status`) */
  constructor(message: string, public readonly kind: GuestFailure, public readonly code?: number) {
    super(message);
  }
}

/** The caller gave up; `cancelled` is what social.ts isCancelled() looks for. */
class GuestCancelled extends Error {
  readonly cancelled = true;
  readonly status = 499;
  constructor() {
    super('Cancelled');
  }
}
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new GuestCancelled();
};
/** `work`, or GuestCancelled as soon as `signal` aborts (the request itself is left to end). */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new GuestCancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => undefined);
      reject(new GuestCancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

type Jar = Map<string, string>;
const jarHeader = (jar: Jar): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Set-Cookie lines into the jar (name=value only; an empty value is a deletion TikTok does not mean for us). */
export function takeCookies(jar: Jar, lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    const first = line.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const value = first.slice(eq + 1).trim();
    if (!value) continue;
    jar.set(first.slice(0, eq).trim(), value);
    n += 1;
  }
  return n;
}

const tiktokHost = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com'));
  } catch {
    return false;
  }
};

/** One request with the jar's cookies, redirects followed by hand (tiktok.com only) so every hop's cookies are kept. */
async function send(jar: Jar, method: string, url: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<ChromeAnswer> {
  let target = url;
  for (let hop = 0; hop < 5; hop++) {
    throwIfAborted(signal);
    if (!tiktokHost(target)) throw new GuestError(`TikTok redirected to another site (${target.slice(0, 80)})`, 'blocked');
    let answer: ChromeAnswer;
    try {
      answer = await abortable(chromeRequest({ method, url: target, headers: { ...headers, ...(jar.size ? { Cookie: jarHeader(jar) } : {}) }, body, timeoutMs: 20_000 }), signal);
    } catch (e) {
      if (e instanceof TlsBridgeError) throw new GuestError(e.unavailable ? `the Chrome-like connection helper cannot run here: ${e.message}` : `the Chrome-like connection helper: ${e.message}`, 'helper');
      throw e;
    }
    takeCookies(jar, answer.cookies);
    const location = answer.headers['location'];
    if (answer.status >= 300 && answer.status < 400 && location) {
      target = new URL(location, target).toString();
      method = 'GET';
      body = undefined;
      continue;
    }
    return answer;
  }
  throw new GuestError('TikTok kept redirecting', 'blocked');
}

export interface PageIdentity {
  wid?: string;
  region?: string;
  csrf?: string;
  ab?: string;
  /** The build of TikTok's signing script the page loads (".../webmssdk/2.0.0.569/webmssdk.js") */
  script?: string;
}

/** The data block a tiktok.com page carries for its own scripts (`__DEFAULT_SCOPE__`: "webapp.app-context", "webapp.user-detail", ...). */
export function pageScope(html: string): Record<string, any> | undefined {
  const m = /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return undefined;
  try {
    const scope = JSON.parse(m[1])?.__DEFAULT_SCOPE__;
    return scope && typeof scope === 'object' ? scope : undefined;
  } catch {
    return undefined;
  }
}

/** What a tiktok.com page tells its own scripts about this visitor. */
export function pageIdentity(html: string): PageIdentity {
  const out: PageIdentity = {};
  const script = /\/webmssdk\/(\d+(?:\.\d+){2,4})\/webmssdk\.js/.exec(html);
  if (script) out.script = script[1];
  const scope = pageScope(html);
  if (!scope) return out;
  try {
    const ctx = scope['webapp.app-context'] ?? {};
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
    out.wid = str(ctx.wid);
    out.region = str(ctx.region);
    out.csrf = str(ctx.csrfToken);
    out.ab = str(ctx.abTestVersion?.versionName);
  } catch {
    /* not the page we expected */
  }
  return out;
}

interface Session {
  jar: Jar;
  webId: string;
  region: string;
  csrf?: string;
  ab?: string;
  createdAt: number;
  calls: number;
}

let current: Session | undefined;
let opening: Promise<Session> | undefined;
/** The script build the last guest page loaded */
let scriptSeen: string | undefined;
/** The build number the signatures carry: the signer's own until another one is seen to work */
let signingAs = DEFAULT_SCM_VERSION;
let lastCallAt = 0;
let lastGoodVideo: string | undefined;
/** When signing as another script build was last tried (it costs a whole extra attempt: once an hour per build is enough) */
const otherBuildTried = new Map<string, number>();
const OTHER_BUILD_EVERY_MS = 60 * 60 * 1000;
const stats = {
  calls: 0,
  ok: 0,
  failed: 0,
  sessions: 0,
  lastOk: undefined as { at: string; ms: number } | undefined,
  lastFailure: undefined as { at: string; reason: string } | undefined,
};

const PAGE_HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${ORIGIN}/` };

async function openSession(log: (m: string) => void, signal?: AbortSignal): Promise<Session> {
  const t0 = Date.now();
  const jar: Jar = new Map();
  say('starting a guest visit to TikTok (1 of 3: a device id)', 'TikTok guest visit, step 1 of 3');
  // Best effort: the page visit below sets the cookie as well when this is refused.
  await send(
    jar,
    'POST',
    `${ORIGIN}/ttwid/union/register/`,
    { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: '*/*' },
    JSON.stringify({ region: 'US', aid: 1988, needFid: false, service: 'www.tiktok.com', migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true }),
    signal,
  ).catch((e) => {
    if (e instanceof GuestCancelled || (e instanceof GuestError && e.kind === 'helper')) throw e;
    log(`guest visit: device registration failed (${(e as Error).message}); the page visit sets the cookie too`);
  });

  say('starting a guest visit to TikTok (2 of 3: the Explore page)', 'TikTok guest visit, step 2 of 3');
  const page = await send(jar, 'GET', `${ORIGIN}/explore`, PAGE_HEADERS, undefined, signal);
  if (page.status !== 200) throw new GuestError(`TikTok's Explore page answered HTTP ${page.status}`, 'session');
  const id = pageIdentity(page.body.toString('utf8'));
  if (id.script) {
    if (id.script !== scriptSeen && id.script !== DEFAULT_SCM_VERSION) log(`guest visit: TikTok's page loads signing script ${id.script}; the signer was written for ${DEFAULT_SCM_VERSION} (fine as long as the calls are answered)`);
    scriptSeen = id.script;
  }
  if (!jar.has('ttwid')) throw new GuestError('TikTok gave the guest visit no ttwid cookie (its edge may be refusing this address)', 'session');
  if (!id.wid) throw new GuestError('the Explore page carried no device id (TikTok served a challenge or changed the page)', 'session');
  const region = id.region || 'US';

  say('starting a guest visit to TikTok (3 of 3: the request token)', 'TikTok guest visit, step 3 of 3');
  const boot = new URLSearchParams({ aid: '1988', count: '10', app_name: 'tiktok_web', device_platform: 'web_pc', device_id: id.wid, region, priority_region: region });
  await send(jar, 'GET', `${ORIGIN}/api/recommend/item_list/?${boot}`, { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${ORIGIN}/` }, undefined, signal);
  if (!jar.has('msToken')) throw new GuestError('TikTok gave the guest visit no msToken cookie', 'session');
  lastCallAt = Date.now();
  stats.sessions += 1;
  log(`guest visit ready in ${Date.now() - t0} ms (region ${region}, cookies ${[...jar.keys()].join(', ')}, script ${id.script ?? 'not seen'})`);
  return { jar, webId: id.wid, region, csrf: id.csrf || jar.get('tt_csrf_token'), ab: id.ab, createdAt: Date.now(), calls: 0 };
}

async function session(log: (m: string) => void, signal: AbortSignal | undefined, fresh: boolean): Promise<Session> {
  if (fresh) current = undefined;
  const s = current;
  if (s && Date.now() - s.createdAt < SESSION_MS && s.calls < SESSION_CALLS) return s;
  current = undefined;
  if (!opening) {
    // Not tied to one caller's signal: a second caller may be waiting for the same visit.
    opening = openSession(log)
      .then((made) => (current = made))
      .finally(() => {
        opening = undefined;
      });
  }
  return abortable(opening, signal);
}

function commonParams(s: Session): Array<[string, string]> {
  return Object.entries({
    aid: '1988',
    app_name: 'tiktok_web',
    app_language: 'en',
    device_platform: 'web_pc',
    device_id: s.webId,
    region: s.region,
    priority_region: s.region,
    language: 'en',
    WebIdLastTime: String(Math.floor(Date.now() / 1000)),
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    os: 'mac',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'MacIntel',
    browser_version: '5.0 (Macintosh)',
    focus_state: 'true',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    history_len: '3',
    screen_height: '1117',
    screen_width: '1728',
    tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
    webcast_language: 'en',
    root_referer: `${ORIGIN}/`,
  });
}

interface CallOptions {
  referer?: string;
  /** The script build to sign as (default: the one in use) */
  scm?: string;
  /** The signer's "environment code": TikTok wants 64 for a profile's video list, 65 (the default) elsewhere */
  envCode?: number;
  /** false: no signature (the Explore list answers without one, over a Chrome-like connection) */
  sign?: boolean;
  signal?: AbortSignal;
}

/** One GET (signed unless told otherwise); the parsed JSON, or GuestError saying how TikTok refused. */
async function call(s: Session, path: string, query: Record<string, string | number>, o: CallOptions = {}): Promise<{ json: any; ms: number; bytes: number }> {
  const wait = lastCallAt + GAP_MS - Date.now();
  if (wait > 0) await abortable(new Promise<void>((r) => setTimeout(r, wait)), o.signal);
  lastCallAt = Date.now();
  s.calls += 1;
  const pairs = commonParams(s);
  for (const [k, v] of Object.entries(query)) pairs.push([k, String(v)]);
  const qs =
    o.sign === false
      ? pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : signRequest(pairs, { userAgent: UA, msToken: s.jar.get('msToken') ?? '', sdkVersion: DEFAULT_SDK_VERSION, scmVersion: o.scm ?? signingAs, envCode: o.envCode }).query;
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: o.referer ?? `${ORIGIN}/`,
    Origin: ORIGIN,
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    priority: 'u=1, i',
  };
  if (s.csrf) headers['x-secsdk-csrf-token'] = s.csrf;
  const answer = await send(s.jar, 'GET', `${ORIGIN}${path}?${qs}`, headers, undefined, o.signal);
  const text = answer.body.toString('utf8');
  if (answer.status === 429) throw new GuestError('TikTok answered HTTP 429 (too many requests)', 'empty');
  if (!text.trim()) throw new GuestError(`TikTok answered HTTP ${answer.status} with an empty body`, 'empty');
  if (!/^\s*[[{]/.test(text)) {
    throw new GuestError(/wafchallengeid|Please wait/i.test(text) ? 'TikTok served its challenge page instead of an answer (its edge is refusing this address)' : `TikTok answered HTTP ${answer.status} with something that is not JSON`, 'blocked');
  }
  try {
    return { json: JSON.parse(text), ms: answer.ms, bytes: answer.body.length };
  } catch {
    throw new GuestError('TikTok answered with broken JSON', 'blocked');
  }
}

/** The fields of TikTok's bare "ok": an answer made of nothing else is its soft refusal. */
const ENVELOPE = new Set(['status_code', 'statusCode', 'status_msg', 'statusMsg', 'log_pb', 'extra']);
/** Whether an answer carries anything beyond TikTok's bare "ok" envelope. */
export function beyondEnvelope(json: any): boolean {
  return Boolean(json) && typeof json === 'object' && !Array.isArray(json) && Object.keys(json).some((k) => !ENVELOPE.has(k));
}

/**
 * Whether a comment/list answer is an answer rather than TikTok's bare "ok" envelope (its soft
 * refusal: nothing but status_code / log_pb). A video without comments, and an id TikTok does not
 * know, answer `"comments": null` with the other fields around it (seen 2026-11-25): that is an
 * answer - there is nothing to show - and asking again would not change it.
 */
export function commentAnswerUsable(json: any): boolean {
  return Boolean(json) && typeof json === 'object' && !Array.isArray(json) && ('comments' in json || Number.isFinite(Number(json.total ?? NaN)));
}

/**
 * What is being read. Each kind has its own failure count and pause: TikTok refusing one path
 * (say, search) must not send the comments back to the browser.
 */
export type GuestKind = 'comments' | 'replies' | 'explore' | 'profile' | 'posts' | 'video';

interface KindState {
  calls: number;
  ok: number;
  failed: number;
  failsInRow: number;
  pausedUntil: number;
  lastOk?: { at: string; ms: number };
  lastFailure?: { at: string; reason: string };
}
const kinds = new Map<GuestKind, KindState>();
const kindState = (kind: GuestKind): KindState => {
  let k = kinds.get(kind);
  if (!k) kinds.set(kind, (k = { calls: 0, ok: 0, failed: 0, failsInRow: 0, pausedUntil: 0 }));
  return k;
};

function succeeded(kind: GuestKind, ms: number): void {
  const k = kindState(kind);
  k.ok += 1;
  k.lastOk = { at: new Date().toISOString(), ms };
  k.failsInRow = 0;
  k.pausedUntil = 0;
  stats.ok += 1;
  stats.lastOk = k.lastOk;
}

function failed(kind: GuestKind, reason: string, countsTowardsPause: boolean, log: (m: string) => void): void {
  const k = kindState(kind);
  k.failed += 1;
  k.lastFailure = { at: new Date().toISOString(), reason: `${kind}: ${reason}`.slice(0, 240) };
  stats.failed += 1;
  stats.lastFailure = k.lastFailure;
  if (!countsTowardsPause) return;
  k.failsInRow += 1;
  if (k.failsInRow >= FAILS_TO_PAUSE && Date.now() >= k.pausedUntil) {
    k.pausedUntil = Date.now() + PAUSE_MS;
    log(`guest requests for ${kind} paused for ${PAUSE_MS / 60000} min after ${k.failsInRow} failures in a row (${reason}); the callers use their fallback meanwhile`);
  }
}

/** Why the guest path is not worth trying right now for this kind of read (undefined: try it). */
export function guestUnusable(kind: GuestKind = 'comments'): string | undefined {
  if (OFF) return 'switched off (TIKTOK_GUEST)';
  if (!tlsBridgeUsable()) return tlsBridgeStatus().reason || 'the Chrome-like connection helper cannot run here';
  const k = kindState(kind);
  if (Date.now() < k.pausedUntil) return `paused until ${new Date(k.pausedUntil).toISOString().slice(11, 16)} UTC after ${k.failsInRow} failed requests in a row (${k.lastFailure?.reason ?? 'no reason kept'})`;
  return undefined;
}

/** What the relay must send with a guest answer's cookie-bound video addresses (the visit's cookies). */
export interface GuestUpstream {
  cookieHeader: string;
  referer: string;
}

export interface GuestGet {
  kind: GuestKind;
  path: string;
  /** The call's own parameters; a function gets the visit's region for the calls that repeat it */
  query: Record<string, string | number> | ((visit: { region: string }) => Record<string, string | number>);
  /** For the status line: "the comments", "the search results" */
  what: string;
  referer?: string;
  envCode?: number;
  sign?: boolean;
  /** Is this JSON an answer? Default: anything beyond TikTok's bare "ok" envelope */
  usable?: (json: any) => boolean;
  /** Status codes besides 0 that still carry an answer (search: 203) */
  okStatus?: number[];
  log: (m: string) => void;
  signal?: AbortSignal;
}

export interface GuestAnswer {
  json: any;
  ms: number;
  attempts: number;
  upstream: GuestUpstream;
}

/**
 * One read as a guest, TikTok's own JSON back. Tries the kept visit, then a new one (TikTok
 * throttles per visit), then - when its page loads another build of the signing script than the
 * signatures carry, at most once an hour - once more signing as that build. Throws GuestError when
 * TikTok would not answer; kind `status` means it read the request and said no (nothing to retry).
 */
export async function guestGet(g: GuestGet): Promise<GuestAnswer> {
  const t0 = Date.now();
  stats.calls += 1;
  kindState(g.kind).calls += 1;
  const tries: Array<{ fresh: boolean; scm?: string; what: string }> = [
    { fresh: false, what: 'the kept guest visit' },
    { fresh: true, what: 'a new guest visit' },
  ];
  let lastError: GuestError | undefined;
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    try {
      const s = await session(g.log, g.signal, t.fresh && i > 0);
      say(i === 0 ? `asking TikTok for ${g.what}` : `asking TikTok for ${g.what} again (${t.what})`, `asking TikTok for ${g.what}`);
      const query = typeof g.query === 'function' ? g.query({ region: s.region }) : g.query;
      const r = await call(s, g.path, query, { referer: g.referer, envCode: g.envCode, sign: g.sign, scm: t.scm, signal: g.signal });
      const code = Number(r.json?.status_code ?? r.json?.statusCode ?? 0);
      if (code !== 0 && !g.okStatus?.includes(code)) {
        // TikTok read the request and said no (comments off, no such account): the signer is fine.
        const err = new GuestError(`TikTok status ${code}: ${r.json.status_msg || r.json.statusMsg || 'unavailable'}`, 'status', code);
        failed(g.kind, err.message, false, g.log);
        throw err;
      }
      if (!(g.usable ?? beyondEnvelope)(r.json)) throw new GuestError('TikTok answered "ok" with nothing in it (its soft refusal)', 'empty');
      if (t.scm && t.scm !== signingAs) {
        g.log(`guest requests: signing as script build ${t.scm} works where ${signingAs} did not; using it from now on`);
        signingAs = t.scm;
      }
      succeeded(g.kind, Date.now() - t0);
      return { json: r.json, ms: Date.now() - t0, attempts: i + 1, upstream: { cookieHeader: jarHeader(s.jar), referer: g.referer ?? `${ORIGIN}/` } };
    } catch (e) {
      if (!(e instanceof GuestError)) throw e; // cancelled, or a bug
      if (e.kind === 'status') throw e;
      lastError = e;
      g.log(`guest ${g.kind}: ${e.message} (${t.what}, attempt ${i + 1})`);
      if (e.kind === 'helper') break; // no connection to try again with
      current = undefined;
      // Last resort: the build TikTok's page loads now, when it is not the one the signatures carry.
      if (g.sign !== false && i === tries.length - 1 && tries.length === 2 && scriptSeen && scriptSeen !== signingAs && Date.now() - (otherBuildTried.get(scriptSeen) ?? 0) > OTHER_BUILD_EVERY_MS) {
        otherBuildTried.set(scriptSeen, Date.now());
        tries.push({ fresh: true, scm: scriptSeen, what: `signing as script build ${scriptSeen}` });
      }
    }
  }
  const err = lastError ?? new GuestError('TikTok did not answer', 'empty');
  failed(g.kind, err.message, true, g.log);
  throw err;
}

/**
 * A tiktok.com page's HTML as a guest (the account page carries the account's details in its data
 * block; no signature is involved, only the Chrome-like connection and the visit's cookies).
 */
export async function guestPage(kind: GuestKind, url: string, what: string, log: (m: string) => void, signal?: AbortSignal): Promise<{ html: string; status: number; ms: number }> {
  const t0 = Date.now();
  stats.calls += 1;
  kindState(kind).calls += 1;
  try {
    const s = await session(log, signal, false);
    say(`asking TikTok for ${what}`, `asking TikTok for ${what}`);
    const wait = lastCallAt + GAP_MS - Date.now();
    if (wait > 0) await abortable(new Promise<void>((r) => setTimeout(r, wait)), signal);
    lastCallAt = Date.now();
    s.calls += 1;
    const answer = await send(s.jar, 'GET', url, PAGE_HEADERS, undefined, signal);
    const html = answer.body.toString('utf8');
    if (answer.status >= 500 || !html.trim()) throw new GuestError(`TikTok answered HTTP ${answer.status}${html.trim() ? '' : ' with an empty page'}`, 'empty');
    succeeded(kind, Date.now() - t0);
    return { html, status: answer.status, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof GuestError) failed(kind, e.message, true, log);
    throw e;
  }
}

/** A page of a video's comments as TikTok's own JSON ({comments[], cursor, has_more, total}), asked as a guest. */
export async function guestCommentList(id: string, cursor: number, log: (m: string) => void, signal?: AbortSignal): Promise<GuestAnswer> {
  const r = await guestGet({
    kind: 'comments',
    path: '/api/comment/list/',
    query: (v) => ({ aweme_id: id, count: 20, cursor, fromWeb: 1, enter_from: 'tiktok_web', current_region: v.region }),
    what: 'the comments',
    usable: commentAnswerUsable,
    log,
    signal,
  });
  if (Array.isArray(r.json.comments) && r.json.comments.length) lastGoodVideo = id;
  return r;
}

/** The replies under one comment, TikTok's own JSON (a few per page: follow `cursor` up to `total`; has_more stays 0). */
export function guestReplyList(videoId: string, commentId: string, cursor: number, log: (m: string) => void, signal?: AbortSignal): Promise<GuestAnswer> {
  return guestGet({ kind: 'replies', path: '/api/comment/list/reply/', query: { item_id: videoId, comment_id: commentId, count: 20, cursor }, what: 'the replies', usable: commentAnswerUsable, log, signal });
}

export interface TikTokGuestStatus {
  mode: 'on' | 'off';
  /** unused: not asked yet; ok: the last request was answered; failing: it was not; paused: skipped for now; unavailable: no helper */
  state: 'unused' | 'ok' | 'failing' | 'paused' | 'unavailable';
  /** The build of TikTok's signing script the signer imitates, the one the signatures carry, and the one TikTok's page loaded last */
  signerBuild: string;
  signingAs: string;
  scriptSeen?: string;
  calls: number;
  ok: number;
  failed: number;
  /** Guest visits started since the server started */
  visits: number;
  visit?: { ageSec: number; calls: number };
  lastOk?: { at: string; ms: number };
  lastFailure?: { at: string; reason: string };
  pausedUntil?: string;
  /** Per kind of read, the ones asked so far: each has its own failure count and pause */
  paths: Partial<Record<GuestKind, { state: 'ok' | 'failing' | 'paused'; calls: number; ok: number; failed: number; lastFailure?: { at: string; reason: string }; pausedUntil?: string }>>;
  helper: TlsBridgeStatus;
}

export function tiktokGuestStatus(): TikTokGuestStatus {
  const helper = tlsBridgeStatus();
  const now = Date.now();
  const paths: TikTokGuestStatus['paths'] = {};
  let anyPaused = 0;
  let anyFailing = false;
  for (const [kind, k] of kinds) {
    if (!k.calls) continue; // only looked at, never asked
    const paused = now < k.pausedUntil;
    const failing = k.failsInRow > 0 || Boolean(k.lastFailure && (!k.lastOk || k.lastFailure.at > k.lastOk.at));
    if (paused) anyPaused = Math.max(anyPaused, k.pausedUntil);
    if (failing) anyFailing = true;
    paths[kind] = { state: paused ? 'paused' : failing ? 'failing' : 'ok', calls: k.calls, ok: k.ok, failed: k.failed, lastFailure: k.lastFailure, pausedUntil: paused ? new Date(k.pausedUntil).toISOString() : undefined };
  }
  // Overall: unavailable (off, or no helper), else the worst of the kinds asked so far.
  const state: TikTokGuestStatus['state'] = OFF || helper.available === false ? 'unavailable' : !stats.calls ? 'unused' : anyPaused ? 'paused' : anyFailing ? 'failing' : 'ok';
  return {
    mode: OFF ? 'off' : 'on',
    state,
    signerBuild: DEFAULT_SCM_VERSION,
    signingAs,
    scriptSeen,
    calls: stats.calls,
    ok: stats.ok,
    failed: stats.failed,
    visits: stats.sessions,
    visit: current ? { ageSec: Math.round((now - current.createdAt) / 1000), calls: current.calls } : undefined,
    lastOk: stats.lastOk,
    lastFailure: stats.lastFailure,
    pausedUntil: anyPaused ? new Date(anyPaused).toISOString() : undefined,
    paths,
    helper,
  };
}

/** The last video whose comments the guest path read (GET /api/comments/check without an id asks it again). */
export const guestLastGoodVideo = (): string | undefined => lastGoodVideo;

/** Tests: forget the visit, the pause and the counters. */
export function resetTikTokGuest(): void {
  current = undefined;
  opening = undefined;
  scriptSeen = undefined;
  signingAs = DEFAULT_SCM_VERSION;
  lastCallAt = 0;
  kinds.clear();
  lastGoodVideo = undefined;
  otherBuildTried.clear();
  Object.assign(stats, { calls: 0, ok: 0, failed: 0, sessions: 0, lastOk: undefined, lastFailure: undefined });
}
