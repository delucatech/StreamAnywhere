/**
 * Facebook sign-in: the cookies of a browser that is signed in to facebook.com, kept in a file and
 * sent with the server's own requests to facebook.com (facebook.ts). Same shape as the Instagram and
 * YouTube sign-ins and for the same reasons (no QR/TV-code login; scripted password logins get a
 * checkpoint), but no browser is involved: Facebook's pages are read over plain HTTPS.
 *
 * Two ways in (POST /api/session/login {platform:'facebook'}):
 *  - mode 'cookies': the text of a cookies.txt (Netscape format; a cookie extension's JSON export and
 *    a raw `Cookie:` header are accepted too). Only facebook.com cookies are kept and `c_user` (the
 *    account id) plus `xs` (the session) must be among them. They are checked at once with the
 *    settings page, which only a signed-in account gets (a guest is sent to the login page).
 *  - mode 'window': a visible Chrome/Edge window on the server machine (a desktop, not a VM) on
 *    Facebook's login page with its own profile; once facebook.com holds `c_user` + `xs` the window's
 *    cookies are exported to the same file and the window closes.
 *
 * The file (~/.streamanywhere/facebook-cookies.txt, FACEBOOK_COOKIES_FILE) is the sign-in; sign out
 * deletes it. Treat it like a password. Next to it, `.meta.json` keeps the identity (User-Agent) of
 * the browser the cookies came from, which the server presents with them.
 *
 * Only the signed-out half could be verified without an account (bogus cookies: the settings page
 * answers 302 to login.php, 2026-10-15); the signed-in half follows Facebook's page structure
 * (`CurrentUserInitialData` names the viewer on every page) and is confirmed by the first signed-in
 * page the feed reads. GET /api/session/log?platform=facebook shows each step.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoginMode, SessionStatus } from '../../shared/types';
import { extractReels, fetchFacebookHtml, facebookLog, setSessionHooks } from './facebook';
import { cleanUserAgent } from './instagramSession';
import { findBrowserExecutable } from './session';
import { fromHeader, fromJson, fromNetscape, toNetscape, type ParsedCookie } from './youtubeSession';

type Browser = import('puppeteer-core').Browser;

const COOKIE_FILE = process.env.FACEBOOK_COOKIES_FILE || path.join(os.homedir(), '.streamanywhere', 'facebook-cookies.txt');
const META_FILE = COOKIE_FILE.replace(/\.txt$/i, '') + '.meta.json';
const LOGIN_PROFILE_DIR = process.env.FACEBOOK_LOGIN_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'facebook-login-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const SIGNIN_URL = 'https://www.facebook.com/login/';
const SETTINGS_URL = 'https://www.facebook.com/settings/';
const RECHECK_MS = 30 * 60 * 1000;
const PROBE_RETRY_MS = 10 * 60 * 1000;
const PROBE_MAX_TRIES = 6;

export class FacebookSessionError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
  }
}

// ---------------------------------------------------------------- cookie text

const isFacebook = (d: string): boolean => /(^|\.)facebook\.com$/i.test(d.replace(/^\./, ''));

/** Cookies out of whatever the user pasted, restricted to facebook.com; throws without `c_user` + `xs`. */
export function parseFacebookCookies(text: string): { cookies: ParsedCookie[]; warnings: string[] } {
  const t = (text || '').trim();
  if (!t) throw new FacebookSessionError('Paste the cookies first', 400);
  if (t.length > 2_000_000) throw new FacebookSessionError('That is too much text for a cookies file', 413);
  let all = fromJson(t, '.facebook.com') || fromNetscape(t);
  if (!all.length && /=/.test(t) && !/\t/.test(t)) all = fromHeader(t, '.facebook.com');
  if (!all.length) throw new FacebookSessionError('No cookies found in that text. Expected a cookies.txt export (Netscape format, one cookie per line), a JSON export of a cookie extension, or a Cookie: header.', 400);
  const kept = all.filter((c) => isFacebook(c.domain));
  const warnings: string[] = [];
  if (all.length > kept.length) warnings.push(`${all.length - kept.length} cookie${all.length - kept.length === 1 ? '' : 's'} of other sites ignored`);
  const has = (n: string): boolean => kept.some((c) => c.name === n && c.value);
  if (!has('c_user') || !has('xs')) throw new FacebookSessionError('These cookies carry no Facebook sign-in (no "c_user" and "xs" for facebook.com). Export them from a browser where facebook.com shows your account, while on facebook.com.', 400);
  const map = new Map<string, ParsedCookie>();
  for (const c of kept) map.set(`${c.domain}|${c.path}|${c.name}`, c);
  const names = new Set([...map.values()].map((c) => c.name));
  const missing = ['datr', 'sb', 'fr'].filter((n) => !names.has(n));
  if (missing.length) warnings.push(`only ${map.size} facebook.com cookie${map.size === 1 ? '' : 's'} (no ${missing.join(', ')}); a complete cookies.txt export is trusted more by Facebook`);
  return { cookies: [...map.values()], warnings };
}

/** The `Cookie:` header for www.facebook.com out of the saved cookies. */
export function cookieHeaderFor(cookies: ParsedCookie[]): string {
  const seen = new Map<string, string>();
  for (const c of cookies) if (isFacebook(c.domain) && c.value) seen.set(c.name, c.value);
  return [...seen].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---------------------------------------------------------------- the account check

export interface FacebookAccount {
  ok: boolean;
  loggedIn: boolean;
  id?: string;
  name?: string;
  shortName?: string;
  /** The profile's address slug (facebook.com/<slug>), when it has one */
  slug?: string;
  error?: string;
  /** ok:false because Facebook wants the account to confirm itself (a checkpoint) */
  checkpoint?: boolean;
  /** ok:false because Facebook is limiting the server's address */
  limited?: boolean;
}

/**
 * What the settings page says about a set of cookies: it is served (200, and `CurrentUserInitialData`
 * names the viewer) to a signed-in account, sent to the login page for anyone else, to the checkpoint
 * page for an account Facebook wants to verify first.
 */
export function accountFromPage(status: number, location: string | undefined, html: string): FacebookAccount {
  const loc = location || '';
  if (status >= 300 && status < 400) {
    if (/facebook\.com\/checkpoint/i.test(loc)) return { ok: false, loggedIn: false, checkpoint: true, error: `Facebook sent the settings page to its checkpoint page` };
    if (/facebook\.com\/(login|recover)/i.test(loc)) return { ok: true, loggedIn: false, error: 'the settings page sent the cookies to the login page' };
    return { ok: false, loggedIn: false, error: `the settings page redirected to ${loc.slice(0, 80)}` };
  }
  if (status === 429) return { ok: false, loggedIn: false, limited: true, error: "Facebook is limiting this server's address (429 for the settings page)" };
  if (status >= 400) return { ok: false, loggedIn: false, error: `the settings page answered ${status}` };
  const page = extractReels(html);
  if (page.viewer.id && page.viewer.id !== '0') return { ok: true, loggedIn: true, id: page.viewer.id, name: page.viewer.name || undefined, shortName: page.viewer.shortName };
  if (page.loginWall || /id="login_form"|"LoginFormController"/.test(html)) return { ok: true, loggedIn: false, error: 'the settings page showed the login form' };
  return { ok: false, loggedIn: false, error: `the settings page (200, "${page.title.slice(0, 40)}") did not name an account` };
}

/** The profile slug `facebook.com/me/` redirects a signed-in account to (`/mario.deluca` -> `mario.deluca`; a `profile.php?id=` profile has none). */
export function slugFromMeRedirect(location: string | undefined): string | undefined {
  if (!location) return undefined;
  try {
    const u = new URL(location);
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return undefined;
    const first = u.pathname.split('/').filter(Boolean)[0];
    return first && first !== 'profile.php' && first !== 'login' && first !== 'login.php' && /^[\w.\-]{1,64}$/.test(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

/** Asks Facebook who `cookies` belong to (the settings page), with the identity of the browser they came from. */
export async function checkFacebookAccount(cookies: ParsedCookie[], userAgent?: string): Promise<FacebookAccount> {
  try {
    const cookie = cookieHeaderFor(cookies);
    const r = await fetchFacebookHtml(SETTINGS_URL, { cookie, userAgent, timeoutMs: 30_000 });
    const acc = accountFromPage(r.status, r.location, r.html);
    log(`account check: settings page ${r.status}${r.location ? ' -> ' + new URL(r.location).pathname : ''} => ${acc.ok ? (acc.loggedIn ? `signed in as ${acc.name || acc.id}` : `signed out (${acc.error})`) : `inconclusive (${acc.error})`}`);
    if (acc.ok && acc.loggedIn) {
      // The profile's own address, for a handle-like name (the settings page gives the display name only).
      const me = await fetchFacebookHtml('https://www.facebook.com/me/', { cookie, userAgent, timeoutMs: 20_000 }).catch(() => undefined);
      const slug = slugFromMeRedirect(me?.location);
      if (slug) acc.slug = slug;
      if (me) log(`account check: /me/ ${me.status}${me.location ? ' -> ' + new URL(me.location).pathname : ''}`);
    }
    return acc;
  } catch (e) {
    return { ok: false, loggedIn: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------- state

interface State {
  state: SessionStatus['state'];
  id?: string;
  username?: string;
  nickname?: string;
  error?: string;
  loginMode?: LoginMode;
  loginBrowser?: Browser;
  loginStartedAt?: number;
  checkedAt?: number;
  savedAt?: number;
  verified?: boolean;
  trouble?: string;
}
const s: State = { state: 'none' };
let probe: Promise<void> | undefined;
let probed = false;
let probeRetryAt = 0;
let probeTries = 0;
let retryTimer: NodeJS.Timeout | undefined;
let recheck: Promise<void> | undefined;
function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}
const recent: string[] = [];
let feedLog: ((m: string) => void) | undefined;
const log = (m: string): void => {
  recent.push(`${new Date().toISOString()} ${m}`);
  if (recent.length > 200) recent.splice(0, recent.length - 200);
  feedLog?.(m);
};
export const setFacebookSessionLogger = (l: (m: string) => void): void => {
  feedLog = l;
};
export const facebookSessionLog = (): { lines: string[] } => ({ lines: [...recent, ...facebookLog().lines].sort() });

const fileExists = (): boolean => fs.existsSync(COOKIE_FILE);

export function savedFacebookCookies(): ParsedCookie[] | undefined {
  try {
    return fileExists() ? fromNetscape(fs.readFileSync(COOKIE_FILE, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

interface Meta {
  userAgent?: string;
  savedAt?: string;
}
function readMeta(): Meta {
  try {
    const m = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}
export const savedUserAgent = (): string | undefined => cleanUserAgent(readMeta().userAgent);

function saveCookies(cookies: ParsedCookie[], userAgent?: string): void {
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, toNetscape(cookies, 'Facebook'), { mode: 0o600 });
  if (userAgent) fs.writeFileSync(META_FILE, JSON.stringify({ userAgent, savedAt: new Date().toISOString() }), { mode: 0o600 });
  else fs.rmSync(META_FILE, { force: true });
  s.savedAt = Date.now();
}

export const facebookSignedIn = (): boolean => s.state === 'logged_in';
/** Signed in, or a saved sign-in not checked yet (a restart): worth showing earlier videos while the check runs. */
export const facebookMaySignIn = (): boolean => s.state === 'logged_in' || (s.state === 'none' && !probed && fileExists());

/** The handle shown for the account: the profile's address slug, else its name. */
const nameOf = (acc: FacebookAccount): string => acc.slug || acc.name || acc.shortName || (acc.id ? `user${acc.id}` : 'facebook');

function markLoggedIn(acc: FacebookAccount, how: string, verified = true): void {
  s.state = 'logged_in';
  s.id = acc.id;
  s.username = nameOf(acc);
  s.nickname = acc.name && acc.name !== s.username ? acc.name : undefined;
  s.verified = verified;
  s.trouble = undefined;
  s.error = undefined;
  s.loginMode = undefined;
  s.checkedAt = Date.now();
  probed = true;
  clearRetry();
  log(`signed in as ${s.username} (${how})`);
}

function forget(reason: string | undefined, deleteFile: boolean): void {
  if (deleteFile) {
    fs.rmSync(COOKIE_FILE, { force: true });
    fs.rmSync(META_FILE, { force: true });
  }
  s.state = 'none';
  s.id = s.username = s.nickname = undefined;
  s.verified = false;
  s.trouble = undefined;
  s.loginMode = undefined;
  s.error = reason;
  s.checkedAt = undefined;
  probed = true;
  clearRetry();
}

setSessionHooks({
  cookieHeader: () => {
    if (s.state !== 'logged_in') return undefined;
    const c = savedFacebookCookies();
    return c?.length ? cookieHeaderFor(c) : undefined;
  },
  userAgent: savedUserAgent,
  confirmed: (name, id) => {
    if (s.state !== 'logged_in') return;
    if (name && /^user\d+$/.test(s.username || '')) s.username = name;
    else if (name && !s.nickname && name !== s.username) s.nickname = name;
    if (id) s.id = id;
    if (!s.verified) log(`Facebook served a signed-in page for the saved cookies: signed in as ${s.username} (confirmed)`);
    s.verified = true;
    s.checkedAt = Date.now();
  },
  rejected: () => {
    // A signed-in page went to the login page: ask the settings page; a conclusive "signed out" ends the sign-in.
    if (s.state !== 'logged_in' || recheck) return;
    log('a signed-in page was refused; checking the saved cookies again');
    recheck = verifySavedFacebook(true)
      .then(() => undefined, (e) => log('recheck error: ' + (e as Error).message))
      .finally(() => (recheck = undefined));
  },
});

/** Verifies the saved file against Facebook; only a conclusive answer ends the probing. */
export async function verifySavedFacebook(force = false): Promise<FacebookAccount | undefined> {
  const cookies = savedFacebookCookies();
  if (!cookies) {
    if (s.state === 'logged_in') forget('The saved Facebook cookies are gone from the server.', false);
    probed = true;
    return undefined;
  }
  if (!force && s.state === 'logged_in' && Date.now() - (s.checkedAt || 0) < RECHECK_MS) return { ok: true, loggedIn: true, id: s.id, name: s.username };
  const wasIn = s.state === 'logged_in';
  const acc = await checkFacebookAccount(cookies, savedUserAgent());
  if (!acc.ok) {
    probeTries++;
    probeRetryAt = Date.now() + PROBE_RETRY_MS;
    if (wasIn) {
      log(`account check gave no verdict (${acc.error}); the saved sign-in is kept`);
      return acc;
    }
    const final = Boolean(acc.checkpoint) || probeTries >= PROBE_MAX_TRIES;
    s.error = acc.checkpoint
      ? `Facebook wants a verification for this account (${acc.error}): open facebook.com in your own browser, confirm it was you, then sign in here again with a fresh export.`
      : `Facebook could not check the saved cookies (${acc.error})${final ? '; "Check again" tries once more, or sign in again with a fresh export' : `; next try in ${Math.round(PROBE_RETRY_MS / 60000)} min`}.`;
    if (final) probed = true;
    else {
      clearRetry();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        startProbe();
      }, PROBE_RETRY_MS);
      retryTimer.unref?.();
    }
    log(`account check gave no verdict (${acc.error}); the saved cookies are kept${final ? ' but not used' : ' and checked again later'}`);
    return acc;
  }
  if (acc.loggedIn) markLoggedIn(acc, 'saved cookies');
  else {
    log(`Facebook says the saved cookies are signed out (${acc.error || ''}); deleting them`);
    forget('Facebook no longer accepts the saved cookies (signed out or expired). Sign in again with a fresh export.', true);
  }
  return acc;
}

function startProbe(deliberate = false): void {
  if (deliberate && s.state === 'none' && fileExists()) {
    probed = false;
    probeTries = 0;
    probeRetryAt = 0;
    clearRetry();
  }
  if (probe || probed || !fileExists() || Date.now() < probeRetryAt || probeTries >= PROBE_MAX_TRIES) return;
  probe = verifySavedFacebook(true)
    .then(() => undefined, (e) => log('probe error: ' + (e as Error).message))
    .finally(() => (probe = undefined));
}

/** True when the server holds a working Facebook sign-in; waits for the check of a saved file after a start. */
export async function ensureFacebookSession(): Promise<boolean> {
  if (s.state === 'none' && fileExists() && !probed) {
    if (!probe) startProbe();
    await probe?.catch(() => undefined);
  }
  return s.state === 'logged_in';
}

export async function facebookSessionStatus(recheckNow = false): Promise<SessionStatus> {
  if (s.state === 'none') startProbe(recheckNow);
  const exe = findBrowserExecutable();
  const base: SessionStatus = { platform: 'facebook', supported: true, state: s.state, username: s.username, nickname: s.nickname, error: s.error, browser: exe ? path.basename(exe) : undefined };
  if (s.state === 'none') {
    base.probing = Boolean(probe);
    base.message = base.probing ? 'Saved Facebook cookies exist; checking them with Facebook…' : fileExists() ? s.error || 'Saved Facebook cookies exist, but Facebook could not be reached to check them ("Check again").' : 'Not signed in.';
  } else if (s.state === 'login_pending') {
    base.loginMode = s.loginMode;
    base.message = 'Finish signing in to Facebook inside the window that opened on the server machine. The window closes by itself once Facebook reports the account.';
  } else if (s.state === 'logged_in') {
    base.message = s.verified ? `Signed in as ${s.username}` : `Signed in as ${s.username} (not yet confirmed by Facebook)`;
    const notes: string[] = [];
    if (s.savedAt) notes.push(`Cookies saved ${new Date(s.savedAt).toLocaleString()}`);
    if (s.trouble) notes.push(s.trouble);
    if (notes.length) base.notice = notes.join('. ');
  }
  return base;
}

// ---------------------------------------------------------------- sign-in

export async function facebookStartLogin(mode: LoginMode, cookiesText: string | undefined, rawLog: (m: string) => void, pasteUserAgent?: unknown): Promise<SessionStatus> {
  feedLog = rawLog;
  if (s.state === 'login_pending' && s.loginBrowser?.isConnected()) return facebookSessionStatus();
  if (probe) await probe.catch(() => undefined);
  if (mode === 'window') return startWindowLogin();
  if (mode !== 'cookies') throw new FacebookSessionError('Facebook has no QR sign-in: paste the cookies of a signed-in browser, or open the sign-in window on the server machine.', 400);
  const { cookies, warnings } = parseFacebookCookies(cookiesText || '');
  const ua = cleanUserAgent(pasteUserAgent);
  log(`cookies received: ${cookies.length} kept (${cookies.map((c) => c.name).join(', ')})${warnings.length ? ' - ' + warnings.join('; ') : ''}${ua ? '; browser identity of the paste: ' + ua.slice(0, 80) : ''}`);
  const acc = await checkFacebookAccount(cookies, ua);
  if (acc.checkpoint) throw new FacebookSessionError(`Facebook wants a verification for this account before it serves this server (${acc.error}). Open facebook.com in your own browser, confirm it was you, then export the cookies again.`, 403);
  if (!acc.ok) throw new FacebookSessionError(`Facebook could not be reached to check the cookies (${acc.error}); try again in a moment`, acc.limited ? 429 : 502);
  if (!acc.loggedIn) {
    log(`Facebook says these cookies are signed out (${acc.error || ''})`);
    throw new FacebookSessionError('Facebook does not recognise these cookies as a signed-in account. Export them again while facebook.com shows your account - best from a private window you close right after exporting, so the cookies are not rotated behind our back.', 400);
  }
  await closeLoginBrowser();
  saveCookies(cookies, ua);
  markLoggedIn(acc, 'pasted cookies');
  const st = await facebookSessionStatus();
  if (warnings.length) st.notice = warnings.join('; ');
  return st;
}

async function closeLoginBrowser(): Promise<void> {
  const b = s.loginBrowser;
  s.loginBrowser = undefined;
  if (b) await b.close().catch(() => undefined);
}

async function startWindowLogin(): Promise<SessionStatus> {
  const exe = findBrowserExecutable();
  if (!exe) throw new FacebookSessionError('No Chrome/Edge/Chromium found on the server machine (set BROWSER_PATH); paste cookies instead.', 503);
  await closeLoginBrowser();
  s.state = 'login_pending';
  s.loginMode = 'window';
  s.error = undefined;
  s.loginStartedAt = Date.now();
  let browser: Browser;
  try {
    const p = await import('puppeteer-core');
    fs.mkdirSync(LOGIN_PROFILE_DIR, { recursive: true });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(LOGIN_PROFILE_DIR, f), { force: true });
    const args = ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--mute-audio', '--window-size=1100,860'];
    if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
    if (process.platform === 'linux' && (process.getuid?.() === 0 || /^(1|true|yes)$/i.test(process.env.BROWSER_NO_SANDBOX || ''))) args.push('--no-sandbox');
    browser = await p.launch({ executablePath: exe, headless: false, userDataDir: LOGIN_PROFILE_DIR, defaultViewport: null, args, ignoreDefaultArgs: ['--enable-automation'], timeout: 90_000, protocolTimeout: 45_000 });
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0];
    log('sign-in window could not be opened: ' + msg);
    s.state = 'none';
    s.loginMode = undefined;
    s.error = `The sign-in window could not be opened on the server (${msg}).`;
    throw new FacebookSessionError(s.error, 500);
  }
  s.loginBrowser = browser;
  browser.on('disconnected', () => {
    if (s.loginBrowser === browser) {
      s.loginBrowser = undefined;
      if (s.state === 'login_pending') {
        s.state = 'none';
        s.loginMode = undefined;
        s.error = 'The sign-in window was closed before Facebook reported an account.';
      }
    }
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const windowUa = cleanUserAgent((await browser.userAgent().catch(() => '')).replace('HeadlessChrome', 'Chrome'));
  if (windowUa) await page.setUserAgent(windowUa).catch(() => undefined);
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
          .filter((c) => isFacebook(String(c.domain || '')))
          .map((c) => ({ domain: String(c.domain), path: String(c.path || '/'), secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : 0, name: String(c.name), value: String(c.value) }));
        if (!cookies.some((c) => c.name === 'c_user' && c.value) || !cookies.some((c) => c.name === 'xs' && c.value)) continue;
        const acc = await checkFacebookAccount(cookies, windowUa);
        if (!acc.ok || !acc.loggedIn) continue;
        if (s.loginBrowser !== browser) return;
        saveCookies(cookies, windowUa);
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
  return facebookSessionStatus();
}

export async function facebookCancelLogin(): Promise<SessionStatus> {
  await closeLoginBrowser();
  if (s.state === 'login_pending') {
    s.state = 'none';
    s.loginMode = undefined;
    s.error = undefined;
  }
  return facebookSessionStatus();
}

/** Deletes the cookie file and the sign-in window's profile: the sign-in is gone from the server. */
export async function facebookLogout(): Promise<SessionStatus> {
  await closeLoginBrowser();
  forget(undefined, true);
  probeTries = 0;
  fs.rmSync(LOGIN_PROFILE_DIR, { recursive: true, force: true });
  s.savedAt = undefined;
  log('signed out (cookies deleted)');
  return facebookSessionStatus();
}

/** The For You feed found nothing or was refused: the reason when the cookies turn out to be dead. */
export async function facebookSessionLost(): Promise<string | undefined> {
  if (recheck) await recheck;
  else {
    const acc = await verifySavedFacebook(true);
    if (acc && acc.ok && !acc.loggedIn) return s.error || 'Facebook signed this server out';
    return undefined;
  }
  return s.state === 'logged_in' ? undefined : s.error || 'Facebook signed this server out';
}

export const shutdownFacebookSession = (): Promise<void> => closeLoginBrowser();
