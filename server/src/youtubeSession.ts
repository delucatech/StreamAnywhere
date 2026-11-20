/**
 * YouTube sign-in. Two kinds, either one makes the server "signed in":
 *
 *  - a CODE approved on a phone or computer (youtubeTv.ts): Google's sign-in for TVs. The server
 *    shows a code and a QR code, the viewer approves it with the Google account, and the account's
 *    home feed is then read from YouTube's TV API. This is the easy way and the one the panel offers
 *    first; it works on a server without a display and needs nothing from a browser.
 *  - the COOKIES of a browser that is signed in to youtube.com, handed to yt-dlp. yt-dlp cannot use
 *    the code sign-in (it dropped that in 2024), so cookies are what lets it fetch a video that
 *    YouTube refuses to a guest (age gate), and they list the feed when no code sign-in is saved.
 *
 * A scripted Google sign-in is not possible: Google refuses sign-ins from automated browsers ("this
 * browser or app may not be secure"), and a datacenter IP has no display for a sign-in window.
 *
 * Ways in (POST /api/session/login {platform:'youtube'}):
 *  - mode 'code': the server asks Google for a code (valid 30 minutes) and waits for the approval;
 *    the status carries the code and the address to open (the page draws the QR code).
 *  - mode 'cookies': the text of a cookies.txt (Netscape format; a JSON export of a cookie
 *    extension and a raw `Cookie:` header line are accepted too). Only youtube.com / google.com
 *    cookies are kept, the file is verified against YouTube's own account menu at once, and the
 *    account name/handle/avatar come from that answer.
 *  - mode 'window': a visible Chrome/Edge window on the server machine (a desktop, not the VM)
 *    with its own profile on Google's sign-in page; once youtube.com holds a SAPISID cookie the
 *    window's cookies are exported to the same file and the window closes.
 *
 * The file (~/.streamanywhere/youtube-cookies.txt, YOUTUBE_COOKIES_FILE) is the sign-in: sign out
 * deletes it. yt-dlp reads it for the account's feeds and writes rotated cookies back, so the
 * session stays fresh as long as the server keeps using it. Treat the file like a password.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoginMode, SessionStatus } from '../../shared/types';
import { config } from './config';
import { findBrowserExecutable } from './session';
import { pollCode, requestCode, tvAccount, tvForget, tvSavedAt, tvSignedIn, type CodePoll, type PendingCode } from './youtubeTv';
import { detectYtDlp } from './ytdlp';

type Browser = import('puppeteer-core').Browser;

const COOKIE_FILE = process.env.YOUTUBE_COOKIES_FILE || path.join(os.homedir(), '.streamanywhere', 'youtube-cookies.txt');
/** Outside the repository (tsx watch restarts on profile writes), like the TikTok profile. */
const PROFILE_DIR = process.env.YOUTUBE_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'youtube-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const SIGNIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&hl=en&continue=' + encodeURIComponent('https://www.youtube.com/');
/** A verified sign-in is re-checked against YouTube at most this often (the feed asks on every batch). */
const RECHECK_MS = 30 * 60 * 1000;

export class YouTubeSessionError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
  }
}

// ---------------------------------------------------------------- cookie text

export interface ParsedCookie {
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; 0 = session cookie */
  expires: number;
  name: string;
  value: string;
}

const KEEP_DOMAIN = /(^|\.)(youtube\.com|google\.com|googlevideo\.com)$/i;
const keepDomain = (d: string): boolean => KEEP_DOMAIN.test(d.replace(/^\./, ''));
/** Cookies Google sets identically on .google.com and .youtube.com at sign-in. */
const AUTH_COOKIES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID', '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-1PSIDCC', '__Secure-3PSIDCC', 'SIDCC', 'LOGIN_INFO'];

export function fromJson(text: string, defaultDomain = '.youtube.com'): ParsedCookie[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const arr = Array.isArray(data) ? data : Array.isArray((data as { cookies?: unknown })?.cookies) ? (data as { cookies: unknown[] }).cookies : undefined;
  if (!arr) return undefined;
  const out: ParsedCookie[] = [];
  for (const c of arr as Record<string, unknown>[]) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    const domain = typeof c.domain === 'string' ? c.domain : defaultDomain;
    const exp = Number(c.expirationDate ?? c.expires ?? c.expiry ?? 0);
    out.push({ domain, path: typeof c.path === 'string' ? c.path : '/', secure: c.secure !== false, httpOnly: Boolean(c.httpOnly), expires: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 0, name: c.name, value: c.value });
  }
  return out;
}

export function fromNetscape(text: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 6) continue;
    const [domain, , p, secure, expires, name] = f;
    const value = f.slice(6).join('\t');
    if (!domain || !name) continue;
    const exp = Number(expires);
    out.push({ domain, path: p || '/', secure: /^true$/i.test(secure), httpOnly, expires: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 0, name, value });
  }
  return out;
}

/** A `Cookie:` request header (name=value; name2=value2), as DevTools copies it. */
export function fromHeader(text: string, defaultDomain = '.youtube.com'): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  const body = text.replace(/^\s*cookie\s*:\s*/i, '');
  for (const part of body.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!/^[\w.\-]+$/.test(name)) continue;
    out.push({ domain: defaultDomain, path: '/', secure: true, httpOnly: false, expires: 0, name, value: part.slice(eq + 1).trim() });
  }
  return out;
}

/**
 * Cookies out of whatever the user pasted, restricted to youtube.com / google.com. Throws when
 * nothing usable is in it or when the cookies carry no sign-in (no SAPISID on youtube.com).
 */
export function parseCookiesText(text: string): { cookies: ParsedCookie[]; warnings: string[] } {
  const t = (text || '').trim();
  if (!t) throw new YouTubeSessionError('Paste the cookies first', 400);
  if (t.length > 2_000_000) throw new YouTubeSessionError('That is too much text for a cookies file', 413);
  let all = fromJson(t) || fromNetscape(t);
  if (!all.length && /=/.test(t) && !/\t/.test(t)) all = fromHeader(t);
  if (!all.length) throw new YouTubeSessionError('No cookies found in that text. Expected a cookies.txt export (Netscape format, one cookie per line), a JSON export of a cookie extension, or a Cookie: header.', 400);
  const warnings: string[] = [];
  const kept = all.filter((c) => keepDomain(c.domain));
  const dropped = all.length - kept.length;
  if (dropped) warnings.push(`${dropped} cookie${dropped === 1 ? '' : 's'} of other sites ignored`);
  const onYouTube = (name: string): boolean => kept.some((c) => c.name === name && /youtube\.com$/i.test(c.domain));
  if (!onYouTube('SAPISID') && !onYouTube('__Secure-3PAPISID')) {
    // A google.com-only export: Google sets the same account cookies on both domains.
    const fromGoogle = kept.filter((c) => AUTH_COOKIES.includes(c.name) && /google\.com$/i.test(c.domain) && !/^\.?(accounts|myaccount|apis)\./i.test(c.domain));
    if (fromGoogle.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) {
      for (const c of fromGoogle) if (!kept.some((k) => k.name === c.name && /youtube\.com$/i.test(k.domain))) kept.push({ ...c, domain: '.youtube.com' });
      warnings.push('the export had the account cookies for google.com only; they were copied to youtube.com');
    } else {
      throw new YouTubeSessionError('These cookies carry no YouTube sign-in (no SAPISID for youtube.com). Export them from a browser where youtube.com shows your account avatar, while on youtube.com.', 400);
    }
  }
  // One cookie per domain+path+name: a later line wins (exports list the newest last).
  const map = new Map<string, ParsedCookie>();
  for (const c of kept) map.set(`${c.domain}|${c.path}|${c.name}`, c);
  return { cookies: [...map.values()], warnings };
}

/** Netscape cookies.txt text (what yt-dlp --cookies reads; #HttpOnly_ marks what a browser hides from scripts). */
export function toNetscape(cookies: ParsedCookie[], site = 'YouTube'): string {
  const lines = ['# Netscape HTTP Cookie File', `# ${site} sign-in saved by StreamAnywhere on ` + new Date().toISOString() + ' - this file IS the sign-in; keep it private.', ''];
  for (const c of cookies) {
    const domain = c.domain;
    const sub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    lines.push(`${c.httpOnly ? '#HttpOnly_' : ''}${domain}\t${sub}\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${c.expires || 0}\t${c.name}\t${c.value}`);
  }
  return lines.join('\n') + '\n';
}

/** The cookies a request to www.youtube.com would carry. */
function forHost(cookies: ParsedCookie[], host = 'www.youtube.com'): ParsedCookie[] {
  return cookies.filter((c) => {
    const d = c.domain.replace(/^\./, '').toLowerCase();
    return host === d || host.endsWith('.' + d);
  });
}

// ---------------------------------------------------------------- account check (YouTube's own account menu)

export interface AccountCheck {
  ok: boolean;
  loggedIn: boolean;
  name?: string;
  handle?: string;
  avatar?: string;
  error?: string;
}

/** `Authorization: SAPISIDHASH` as youtube.com's own scripts compute it for www.youtube.com. */
export function sapisidHash(sapisid: string, now = Date.now()): string {
  const ts = Math.floor(now / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} https://www.youtube.com`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

/** First object under `key` anywhere in a JSON tree (YouTube nests its renderers deeply). */
export function findKey(node: unknown, key: string, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 40) return undefined;
  if (!Array.isArray(node) && key in (node as Record<string, unknown>)) return (node as Record<string, unknown>)[key];
  for (const v of Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)) {
    const r = findKey(v, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

const text = (v: any): string | undefined => (typeof v?.simpleText === 'string' ? v.simpleText : Array.isArray(v?.runs) ? v.runs.map((r: any) => r.text).join('') : undefined);

/** What YouTube's account menu says about a set of cookies (the same call the site's avatar menu makes). */
export function accountFromMenu(menu: unknown): AccountCheck {
  const ctx = findKey(menu, 'mainAppWebResponseContext');
  const header = findKey(menu, 'activeAccountHeaderRenderer');
  const loggedOut = ctx?.loggedOut === true || (!header && ctx?.loggedOut !== false);
  if (loggedOut) return { ok: true, loggedIn: false };
  const thumbs: any[] = header?.accountPhoto?.thumbnails || [];
  const avatar = thumbs.length ? thumbs[thumbs.length - 1]?.url : undefined;
  const handle = (text(header?.channelHandle) || '').replace(/^@/, '') || undefined;
  return { ok: true, loggedIn: true, name: text(header?.accountName), handle, avatar };
}

export async function checkAccount(cookies: ParsedCookie[], timeoutMs = 20_000): Promise<AccountCheck> {
  const mine = forHost(cookies);
  const sapisid = mine.find((c) => c.name === 'SAPISID')?.value || mine.find((c) => c.name === '__Secure-3PAPISID')?.value;
  if (!sapisid) return { ok: true, loggedIn: false, error: 'no SAPISID cookie' };
  const body = JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } } });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': config.userAgent,
    cookie: mine.map((c) => `${c.name}=${c.value}`).join('; '),
    authorization: sapisidHash(sapisid),
    'x-origin': 'https://www.youtube.com',
    origin: 'https://www.youtube.com',
    'x-goog-authuser': '0',
    'x-youtube-client-name': '1',
    'x-youtube-client-version': '2.20250101.00.00',
  };
  return new Promise<AccountCheck>((resolve) => {
    const req = https.request('https://www.youtube.com/youtubei/v1/account/account_menu?prettyPrint=false', { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if ((res.statusCode || 0) === 401 || (res.statusCode || 0) === 403) return resolve({ ok: true, loggedIn: false, error: `YouTube answered ${res.statusCode}` });
        if ((res.statusCode || 0) !== 200) return resolve({ ok: false, loggedIn: false, error: `YouTube answered ${res.statusCode}` });
        try {
          resolve(accountFromMenu(JSON.parse(data)));
        } catch (e) {
          resolve({ ok: false, loggedIn: false, error: 'unreadable answer: ' + (e as Error).message });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, loggedIn: false, error: e.message }));
    req.end(body);
  });
}

// ---------------------------------------------------------------- state

interface State {
  state: SessionStatus['state'];
  username?: string;
  nickname?: string;
  avatar?: string;
  error?: string;
  loginMode?: LoginMode;
  loginBrowser?: Browser;
  loginStartedAt?: number;
  /** When the cookie file was last verified as signed in */
  checkedAt?: number;
  /** When the current cookies were saved (shown to the user) */
  savedAt?: number;
  /** What the sign-in is: a code approved at Google (youtubeTv.ts), or the cookie file */
  via?: 'code' | 'cookies';
  /** While a code sign-in waits for the approval */
  code?: PendingCode;
}

const s: State = { state: 'none' };
let probe: Promise<void> | undefined;
/** The saved file was checked conclusively since the server started */
let probed = false;
let probeRetryAt = 0;
let probeTries = 0;
const recent: string[] = [];
function remember(m: string): void {
  recent.push(`${new Date().toISOString()} ${m}`);
  if (recent.length > 200) recent.splice(0, recent.length - 200);
}
let feedLog: ((m: string) => void) | undefined;
const log = (m: string): void => {
  remember(m);
  feedLog?.(m);
};
export const setYouTubeSessionLogger = (l: (m: string) => void): void => {
  feedLog = l;
};
export const youtubeSessionLog = (): { lines: string[] } => ({ lines: recent.slice() });

const fileExists = (): boolean => fs.existsSync(COOKIE_FILE);

/** The cookies as saved (undefined when there is no file). */
export function savedCookies(): ParsedCookie[] | undefined {
  try {
    return fileExists() ? fromNetscape(fs.readFileSync(COOKIE_FILE, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

/** Path of the cookie file for yt-dlp, when a sign-in is saved. */
export function youtubeCookieFile(): string | undefined {
  return s.state !== 'error' && fileExists() ? COOKIE_FILE : undefined;
}

export const youtubeSignedIn = (): boolean => s.state === 'logged_in';

/**
 * Where the account's feed comes from: 'code' = YouTube's TV API with the approved sign-in,
 * 'cookies' = yt-dlp with the cookie file; undefined = nobody is signed in.
 */
export function youtubeSignInKind(): 'code' | 'cookies' | undefined {
  if (s.state === 'error') return undefined;
  return tvSignedIn() ? 'code' : fileExists() ? 'cookies' : undefined;
}

function saveCookies(cookies: ParsedCookie[]): void {
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, toNetscape(cookies), { mode: 0o600 });
  s.savedAt = Date.now();
}

function markLoggedIn(acc: AccountCheck, how: string, via: 'code' | 'cookies' = 'cookies'): void {
  s.state = 'logged_in';
  s.via = via;
  s.code = undefined;
  s.username = acc.handle || acc.name || 'youtube';
  s.nickname = acc.name;
  s.avatar = acc.avatar;
  s.error = undefined;
  s.loginMode = undefined;
  s.checkedAt = Date.now();
  probed = true;
  log(`signed in as ${acc.handle ? '@' + acc.handle : acc.name || '?'} (${how})`);
}

function forget(reason: string | undefined, deleteFile: boolean): void {
  if (deleteFile) {
    try {
      fs.rmSync(COOKIE_FILE, { force: true });
    } catch {
      /* ignore */
    }
  }
  s.state = 'none';
  s.username = s.nickname = s.avatar = undefined;
  s.loginMode = undefined;
  s.via = undefined;
  s.error = reason;
  s.checkedAt = undefined;
  probed = true;
}

/**
 * Verifies the saved file against YouTube. `force` ignores the recheck interval. Only a conclusive
 * answer ends the probing: YouTube's "signed in" or "signed out"; a network failure is retried later.
 */
export async function verifySaved(force = false): Promise<AccountCheck | undefined> {
  if (!force && s.state === 'logged_in' && Date.now() - (s.checkedAt || 0) < RECHECK_MS && (tvSignedIn() || fileExists())) return { ok: true, loggedIn: true, name: s.nickname, handle: s.username, avatar: s.avatar };
  let codeLost: string | undefined;
  if (tvSignedIn()) {
    // The code sign-in first: it is what the feed uses when both kinds are saved.
    const tv = await tvAccount(log);
    if (!tv.ok) {
      probeTries++;
      probeRetryAt = Date.now() + 30_000;
      log(`account check failed (${tv.error}); the saved sign-in is kept and checked again later`);
      return tv;
    }
    if (tv.loggedIn) {
      markLoggedIn(tv, 'saved code sign-in', 'code');
      return tv;
    }
    log(`Google no longer accepts the saved code sign-in (${tv.error}); deleting it`);
    await tvForget(false, log);
    codeLost = 'Google no longer accepts the saved sign-in (it was removed from the Google account, or it expired). Sign in again with a new code.';
  }
  const cookies = savedCookies();
  if (!cookies) {
    if (codeLost) forget(codeLost, false);
    else if (s.state === 'logged_in') forget('The saved YouTube sign-in is gone from the server.', false);
    probed = true;
    return codeLost ? { ok: true, loggedIn: false, error: codeLost } : undefined;
  }
  const acc = await checkAccount(cookies);
  if (!acc.ok) {
    probeTries++;
    probeRetryAt = Date.now() + 30_000;
    log(`account check failed (${acc.error}); the saved cookies are kept and checked again later`);
    return acc;
  }
  if (acc.loggedIn) markLoggedIn(acc, 'saved cookies');
  else {
    log('YouTube says the saved cookies are signed out; deleting them');
    forget('YouTube no longer accepts the saved cookies (signed out or expired). Sign in again with a fresh export.', true);
  }
  return acc;
}

const anySaved = (): boolean => fileExists() || tvSignedIn();

function startProbe(): void {
  if (probe || probed || !anySaved() || Date.now() < probeRetryAt || probeTries >= 20) return;
  probe = verifySaved(true)
    .then(() => undefined, (e) => log('probe error: ' + (e as Error).message))
    .finally(() => (probe = undefined));
}

/** Status for GET /api/session?platform=youtube (starts a background check of a saved file on first use). */
export async function youtubeSessionStatus(): Promise<SessionStatus> {
  const yt = await detectYtDlp();
  if (!yt.available) return { platform: 'youtube', supported: false, state: 'unsupported', error: `yt-dlp is not available on this server (${yt.error})`, message: 'YouTube sign-in needs yt-dlp on the server. Shorts and search are unavailable without it as well.' };
  if (s.state === 'none') startProbe();
  const base: SessionStatus = { platform: 'youtube', supported: true, state: s.state, username: s.username, nickname: s.nickname, avatar: s.avatar, error: s.error, browser: 'yt-dlp ' + (yt.version || '') };
  if (s.state === 'none') {
    const pending = Boolean(probe) || (anySaved() && !probed);
    base.probing = pending;
    base.message = pending ? 'A saved YouTube sign-in exists; checking it with YouTube…' : anySaved() ? 'A saved YouTube sign-in exists, but YouTube could not be reached to check it ("Check again").' : 'Not signed in.';
  } else if (s.state === 'login_pending' && s.loginMode === 'code' && s.code) {
    base.loginMode = 'code';
    base.code = s.code.userCode;
    base.codeUrl = s.code.url;
    base.codeExpiresAt = s.code.expiresAt;
    base.message = `Open ${s.code.url.replace(/^https:\/\/(www\.)?/, '')} on your phone or computer, enter the code ${s.code.userCode}, choose your YouTube account and press Allow.`;
  } else if (s.state === 'login_pending') {
    base.loginMode = s.loginMode;
    base.message = 'Finish signing in to Google inside the window that opened on the server machine. The window closes by itself once YouTube reports the account.';
  } else if (s.state === 'logged_in') {
    base.via = s.via;
    base.message = `Signed in as ${s.username ? '@' + s.username : s.nickname || '?'}`;
    const at = s.via === 'code' ? tvSavedAt() : s.savedAt;
    if (at) base.notice = `${s.via === 'code' ? 'Signed in with a code' : 'Cookies saved'} ${new Date(at).toLocaleString()}`;
  }
  return base;
}

// ---------------------------------------------------------------- sign-in

/** POST /api/session/login {platform:'youtube', mode, cookies} */
export async function youtubeStartLogin(mode: LoginMode, cookiesText: string | undefined, rawLog: (m: string) => void): Promise<SessionStatus> {
  feedLog = rawLog;
  if (!(await detectYtDlp()).available) throw new YouTubeSessionError('yt-dlp is not available on this server', 503);
  if (s.state === 'login_pending' && s.loginBrowser?.isConnected()) return youtubeSessionStatus();
  if (s.state === 'login_pending' && s.loginMode === 'code' && s.code && mode === 'code') return youtubeSessionStatus();
  if (probe) await probe.catch(() => undefined);
  if (mode === 'code') return startCodeLogin();
  stopCodeLogin();
  if (mode === 'window') return startWindowLogin();
  if (mode !== 'cookies' && !cookiesText) throw new YouTubeSessionError('Sign in to YouTube with a code, with the cookies of a signed-in browser, or in the sign-in window on the server machine.', 400);
  const { cookies, warnings } = parseCookiesText(cookiesText || '');
  log(`cookies received: ${cookies.length} kept${warnings.length ? ' (' + warnings.join('; ') + ')' : ''}`);
  const acc = await checkAccount(cookies);
  if (!acc.ok) throw new YouTubeSessionError(`YouTube could not be reached to check the cookies (${acc.error}); try again in a moment`, 502);
  if (!acc.loggedIn) {
    log('YouTube says these cookies are signed out');
    throw new YouTubeSessionError('YouTube does not recognise these cookies as a signed-in account. Export them again while youtube.com shows your avatar - best from a private window you close right after exporting, so the cookies are not rotated behind our back.', 400);
  }
  await closeLoginBrowser();
  saveCookies(cookies);
  // A code sign-in saved earlier stays what the feed uses; the cookies then serve yt-dlp only.
  if (tvSignedIn() && s.state === 'logged_in' && s.via === 'code') log('cookies saved next to the code sign-in (yt-dlp uses them for videos YouTube refuses to a guest)');
  else markLoggedIn(acc, 'pasted cookies');
  const st = await youtubeSessionStatus();
  if (warnings.length) st.notice = warnings.join('; ');
  return st;
}

async function closeLoginBrowser(): Promise<void> {
  const b = s.loginBrowser;
  s.loginBrowser = undefined;
  if (b) await b.close().catch(() => undefined);
}

/** Stops waiting for a code's approval (the code itself simply runs out at Google). */
function stopCodeLogin(): void {
  if (!s.code) return;
  s.code = undefined;
  if (s.state === 'login_pending' && s.loginMode === 'code') {
    s.state = s.via ? 'logged_in' : 'none';
    s.loginMode = undefined;
  }
}

/**
 * Sign-in with a code: Google gives a code, the status shows it (and the page a QR code of it), and
 * this waits - asking Google every few seconds, as it prescribes - until the viewer approved it on a
 * phone or computer, refused it, or the code ran out (30 minutes).
 */
async function startCodeLogin(): Promise<SessionStatus> {
  await closeLoginBrowser();
  let pending: PendingCode;
  try {
    pending = await requestCode(log);
  } catch (e) {
    const msg = (e as Error).message;
    log('no sign-in code: ' + msg);
    throw new YouTubeSessionError(`Google did not give a sign-in code (${msg}); try again in a moment`, 502);
  }
  s.state = 'login_pending';
  s.loginMode = 'code';
  s.error = undefined;
  s.loginStartedAt = Date.now();
  s.code = pending;
  log(`sign-in code issued, valid ${Math.round((pending.expiresAt - Date.now()) / 60000)} min; waiting for the approval`);
  const fail = (reason: string): void => {
    if (s.code !== pending) return;
    s.code = undefined;
    s.state = s.via ? 'logged_in' : 'none';
    s.loginMode = undefined;
    s.error = reason;
    log('code sign-in ended: ' + reason);
  };
  void (async () => {
    let wait = pending.intervalMs;
    let errors = 0;
    while (s.code === pending) {
      await new Promise((r) => setTimeout(r, wait));
      if (s.code !== pending) return;
      if (Date.now() > pending.expiresAt) return fail('The code ran out before it was approved. "Sign in with a code" gives a new one.');
      let answer: CodePoll;
      try {
        answer = await pollCode(pending);
        errors = 0;
      } catch (e) {
        // A network blip: the code is still good, keep asking.
        if (++errors === 1 || errors % 12 === 0) log(`waiting for the approval: ${(e as Error).message}`);
        continue;
      }
      if (answer === 'pending') continue;
      if (answer === 'slow_down') {
        wait += 2000;
        continue;
      }
      if (answer === 'denied') return fail('The sign-in was refused on the Google page. "Sign in with a code" starts over.');
      if (answer === 'expired') return fail('The code ran out before it was approved. "Sign in with a code" gives a new one.');
      // Approved: the sign-in is saved; ask YouTube who it is.
      let acc = await tvAccount(log);
      if (!acc.ok) acc = await tvAccount(log);
      if (acc.ok && !acc.loggedIn) {
        await tvForget(false, log);
        return fail(`Google approved the code, but YouTube does not accept the sign-in (${acc.error}).`);
      }
      // YouTube could not be asked for the name right now: signed in all the same, the name follows at the next check.
      markLoggedIn(acc.loggedIn ? acc : { ok: true, loggedIn: true }, 'code approved', 'code');
      if (!acc.loggedIn) s.checkedAt = 0;
      return;
    }
  })();
  return youtubeSessionStatus();
}

/** A visible Chrome/Edge on the server machine (needs a desktop): the user signs in, we take the cookies. */
async function startWindowLogin(): Promise<SessionStatus> {
  const exe = findBrowserExecutable();
  if (!exe) throw new YouTubeSessionError('No Chrome/Edge/Chromium found on the server machine (set BROWSER_PATH); paste cookies instead.', 503);
  await closeLoginBrowser();
  s.state = 'login_pending';
  s.loginMode = 'window';
  s.error = undefined;
  s.loginStartedAt = Date.now();
  let browser: Browser;
  try {
    const p = await import('puppeteer-core');
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(PROFILE_DIR, f), { force: true });
    const args = ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--mute-audio', '--window-size=1100,860'];
    if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
    if (process.platform === 'linux' && (process.getuid?.() === 0 || /^(1|true|yes)$/i.test(process.env.BROWSER_NO_SANDBOX || ''))) args.push('--no-sandbox');
    browser = await p.launch({ executablePath: exe, headless: false, userDataDir: PROFILE_DIR, defaultViewport: null, args, ignoreDefaultArgs: ['--enable-automation'], timeout: 90_000, protocolTimeout: 45_000 });
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0];
    log('sign-in window could not be opened: ' + msg);
    s.state = 'none';
    s.loginMode = undefined;
    s.error = `The sign-in window could not be opened on the server (${msg}).`;
    throw new YouTubeSessionError(s.error, 500);
  }
  s.loginBrowser = browser;
  browser.on('disconnected', () => {
    if (s.loginBrowser === browser) {
      s.loginBrowser = undefined;
      if (s.state === 'login_pending') {
        s.state = 'none';
        s.loginMode = undefined;
        s.error = 'The sign-in window was closed before YouTube reported an account.';
      }
    }
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome')).catch(() => undefined);
  await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  log('sign-in window opened on ' + path.basename(exe));
  void (async () => {
    try {
      while (s.loginBrowser === browser && Date.now() - (s.loginStartedAt || 0) < LOGIN_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 3000));
        if (!browser.isConnected()) return;
        const p = (await browser.pages())[0];
        if (!p) continue;
        let all: any[] = [];
        try {
          const cdp = await p.createCDPSession();
          all = ((await cdp.send('Network.getAllCookies')) as { cookies: any[] }).cookies || [];
          await cdp.detach().catch(() => undefined);
        } catch {
          continue;
        }
        const cookies: ParsedCookie[] = all
          .filter((c) => keepDomain(String(c.domain || '')))
          .map((c) => ({ domain: String(c.domain), path: String(c.path || '/'), secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : 0, name: String(c.name), value: String(c.value) }));
        const yt = forHost(cookies);
        if (!yt.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) continue;
        const acc = await checkAccount(cookies);
        if (!acc.ok || !acc.loggedIn) continue;
        if (s.loginBrowser !== browser) return;
        saveCookies(cookies);
        markLoggedIn(acc, 'window');
        s.loginBrowser = undefined;
        await browser.close().catch(() => undefined);
        return;
      }
      if (s.loginBrowser === browser && s.state === 'login_pending') {
        s.state = 'none';
        s.loginMode = undefined;
        s.error = 'Sign-in timed out after 10 minutes.';
        s.loginBrowser = undefined;
        await browser.close().catch(() => undefined);
      }
    } catch (e) {
      log('window sign-in failed: ' + (e as Error).message);
      if (s.state === 'login_pending') {
        s.state = 'none';
        s.loginMode = undefined;
        s.error = (e as Error).message;
      }
    }
  })();
  return youtubeSessionStatus();
}

/** Ends a pending window sign-in; a saved sign-in (if any) stays. */
export async function youtubeCancelLogin(): Promise<SessionStatus> {
  await closeLoginBrowser();
  stopCodeLogin();
  if (s.state === 'login_pending') {
    s.state = 'none';
    s.loginMode = undefined;
    s.error = undefined;
  }
  return youtubeSessionStatus();
}

/** Deletes the code sign-in (withdrawn at Google), the cookie file and the window profile: the sign-in is gone from the server. */
export async function youtubeLogout(): Promise<SessionStatus> {
  await closeLoginBrowser();
  stopCodeLogin();
  // Withdrawn at Google too: a sign-out must not leave a working sign-in behind.
  await tvForget(true, log);
  forget(undefined, true);
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  s.savedAt = undefined;
  log('signed out (the saved sign-in is deleted)');
  return youtubeSessionStatus();
}

/**
 * The feed found nothing for the account: find out whether the cookies died (YouTube answers the
 * recommended feed of a signed-out visitor with an empty list, not an error). Returns the reason
 * when the sign-in is gone.
 */
export async function youtubeSessionLost(): Promise<string | undefined> {
  const acc = await verifySaved(true);
  if (acc && acc.ok && !acc.loggedIn) return s.error || 'YouTube signed this server out';
  return undefined;
}

export async function shutdownYouTubeSession(): Promise<void> {
  s.code = undefined;
  await closeLoginBrowser();
}
