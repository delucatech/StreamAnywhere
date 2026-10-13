/**
 * Instagram sign-in: the cookies of a browser that is signed in to instagram.com, kept in a file and
 * loaded into the server's headless browser (instagram.ts) whenever it starts.
 *
 * Same shape as the YouTube sign-in (youtubeSession.ts) and for the same reasons: Instagram has no
 * QR/TV-code login and shows a challenge to a scripted password login, while a cookie export from
 * the person's own browser needs nothing on the server but the file. Two ways in
 * (POST /api/session/login {platform:'instagram'}):
 *  - mode 'cookies': the text of a cookies.txt (Netscape format; a cookie extension's JSON export and
 *    a raw `Cookie:` header are accepted too). Only instagram.com cookies are kept and `sessionid` must
 *    be among them. They are loaded into the headless browser and checked with Instagram at once
 *    (`/api/v1/accounts/current_user/`), which also names the account.
 *  - mode 'window': a visible Chrome/Edge window on the server machine (a desktop, not a VM) on
 *    Instagram's login page with its own profile; once instagram.com holds a `sessionid` the window's
 *    cookies are exported to the same file and the window closes.
 *
 * The file (~/.streamanywhere/instagram-cookies.txt, INSTAGRAM_COOKIES_FILE) is the sign-in; sign out
 * deletes it and the headless browser's profile. Treat it like a password. The account check answer
 * ("current_user") is Instagram's documented web call but has not been seen live with a real
 * account here: if it is refused for a good sign-in, GET /api/session/log?platform=instagram shows
 * what Instagram answered.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoginMode, SessionStatus } from '../../shared/types';
import { checkInstagramAccount, instagramLog, resetInstagramBrowser, setSessionHooks, type InstagramAccount } from './instagram';
import { findBrowserExecutable, sessionSupported } from './session';
import { fromHeader, fromJson, fromNetscape, toNetscape, type ParsedCookie } from './youtubeSession';

type Browser = import('puppeteer-core').Browser;

const COOKIE_FILE = process.env.INSTAGRAM_COOKIES_FILE || path.join(os.homedir(), '.streamanywhere', 'instagram-cookies.txt');
/** The sign-in window's own profile (the headless browser has another one: two Chromes cannot share a profile). */
const LOGIN_PROFILE_DIR = process.env.INSTAGRAM_LOGIN_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'instagram-login-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const SIGNIN_URL = 'https://www.instagram.com/accounts/login/';
const RECHECK_MS = 30 * 60 * 1000;

export class InstagramSessionError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
  }
}

// ---------------------------------------------------------------- cookie text

const isInstagram = (d: string): boolean => /(^|\.)instagram\.com$/i.test(d.replace(/^\./, ''));

/** Cookies out of whatever the user pasted, restricted to instagram.com; throws when no `sessionid` is among them. */
export function parseInstagramCookies(text: string): { cookies: ParsedCookie[]; warnings: string[] } {
  const t = (text || '').trim();
  if (!t) throw new InstagramSessionError('Paste the cookies first', 400);
  if (t.length > 2_000_000) throw new InstagramSessionError('That is too much text for a cookies file', 413);
  let all = fromJson(t, '.instagram.com') || fromNetscape(t);
  if (!all.length && /=/.test(t) && !/\t/.test(t)) all = fromHeader(t, '.instagram.com');
  if (!all.length) throw new InstagramSessionError('No cookies found in that text. Expected a cookies.txt export (Netscape format, one cookie per line), a JSON export of a cookie extension, or a Cookie: header.', 400);
  const kept = all.filter((c) => isInstagram(c.domain));
  const warnings: string[] = [];
  if (all.length > kept.length) warnings.push(`${all.length - kept.length} cookie${all.length - kept.length === 1 ? '' : 's'} of other sites ignored`);
  if (!kept.some((c) => c.name === 'sessionid' && c.value)) throw new InstagramSessionError('These cookies carry no Instagram sign-in (no "sessionid" for instagram.com). Export them from a browser where instagram.com shows your account, while on instagram.com.', 400);
  const map = new Map<string, ParsedCookie>();
  for (const c of kept) map.set(`${c.domain}|${c.path}|${c.name}`, c);
  return { cookies: [...map.values()], warnings };
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
  checkedAt?: number;
  savedAt?: number;
}
const s: State = { state: 'none' };
let probe: Promise<void> | undefined;
let probed = false;
let probeRetryAt = 0;
let probeTries = 0;
const recent: string[] = [];
let feedLog: ((m: string) => void) | undefined;
const log = (m: string): void => {
  recent.push(`${new Date().toISOString()} ${m}`);
  if (recent.length > 200) recent.splice(0, recent.length - 200);
  feedLog?.(m);
};
export const setInstagramSessionLogger = (l: (m: string) => void): void => {
  feedLog = l;
};
/** The sign-in notes and the browser notes, oldest first (GET /api/session/log?platform=instagram). */
export const instagramSessionLog = (): { lines: string[] } => ({ lines: [...recent, ...instagramLog().lines].sort() });

const fileExists = (): boolean => fs.existsSync(COOKIE_FILE);

export function savedInstagramCookies(): ParsedCookie[] | undefined {
  try {
    return fileExists() ? fromNetscape(fs.readFileSync(COOKIE_FILE, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

export const instagramSignedIn = (): boolean => s.state === 'logged_in';

setSessionHooks({ cookies: savedInstagramCookies, signedIn: instagramSignedIn });

function saveCookies(cookies: ParsedCookie[]): void {
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, toNetscape(cookies, 'Instagram'), { mode: 0o600 });
  s.savedAt = Date.now();
}

function markLoggedIn(acc: InstagramAccount, how: string): void {
  s.state = 'logged_in';
  s.username = acc.username || 'instagram';
  s.nickname = acc.name;
  s.avatar = acc.avatar;
  s.error = undefined;
  s.loginMode = undefined;
  s.checkedAt = Date.now();
  probed = true;
  log(`signed in as @${s.username} (${how})`);
}

function forget(reason: string | undefined, deleteFile: boolean): void {
  if (deleteFile) fs.rmSync(COOKIE_FILE, { force: true });
  s.state = 'none';
  s.username = s.nickname = s.avatar = undefined;
  s.loginMode = undefined;
  s.error = reason;
  s.checkedAt = undefined;
  probed = true;
}

/** Verifies the saved file against Instagram; only a conclusive answer ends the probing. */
export async function verifySavedInstagram(force = false): Promise<InstagramAccount | undefined> {
  const cookies = savedInstagramCookies();
  if (!cookies) {
    if (s.state === 'logged_in') forget('The saved Instagram cookies are gone from the server.', false);
    probed = true;
    return undefined;
  }
  if (!force && s.state === 'logged_in' && Date.now() - (s.checkedAt || 0) < RECHECK_MS) return { ok: true, loggedIn: true, username: s.username, name: s.nickname, avatar: s.avatar };
  const wasIn = s.state === 'logged_in';
  let acc = await checkInstagramAccount(cookies);
  // A good sign-in is only dropped on a second "signed out" answer: the first may be a passing refusal.
  if (wasIn && acc.ok && !acc.loggedIn) {
    await new Promise((r) => setTimeout(r, 3000));
    acc = await checkInstagramAccount(cookies);
  }
  if (!acc.ok) {
    probeTries++;
    probeRetryAt = Date.now() + 30_000;
    log(`account check failed (${acc.error}); the saved cookies are kept and checked again later`);
    return acc;
  }
  if (acc.loggedIn) markLoggedIn(acc, 'saved cookies');
  else {
    log(`Instagram says the saved cookies are signed out (${acc.error || ''}); deleting them`);
    forget('Instagram no longer accepts the saved cookies (signed out or expired). Sign in again with a fresh export.', true);
    await resetInstagramBrowser(true);
  }
  return acc;
}

function startProbe(): void {
  if (probe || probed || !fileExists() || Date.now() < probeRetryAt || probeTries >= 20) return;
  probe = verifySavedInstagram(true)
    .then(() => undefined, (e) => log('probe error: ' + (e as Error).message))
    .finally(() => (probe = undefined));
}

/** True when the server holds a working Instagram sign-in; waits for the check of a saved file after a start. */
export async function ensureInstagramSession(): Promise<boolean> {
  if (s.state === 'none' && fileExists() && !probed) {
    if (!probe) startProbe();
    await probe?.catch(() => undefined);
  }
  return s.state === 'logged_in';
}

export async function instagramSessionStatus(): Promise<SessionStatus> {
  const sup = sessionSupported();
  if (!sup.ok) return { platform: 'instagram', supported: false, state: 'unsupported', error: sup.reason, message: 'Instagram runs in a browser on the server: it needs Chrome or Edge there (set BROWSER_PATH).' };
  if (s.state === 'none') startProbe();
  const base: SessionStatus = { platform: 'instagram', supported: true, state: s.state, username: s.username, nickname: s.nickname, avatar: s.avatar, error: s.error, browser: path.basename(sup.executable || 'browser') };
  if (s.state === 'none') {
    const pending = Boolean(probe) || (fileExists() && !probed);
    base.probing = pending;
    base.message = pending ? 'Saved Instagram cookies exist; checking them with Instagram…' : fileExists() ? 'Saved Instagram cookies exist, but Instagram could not be reached to check them ("Check again").' : 'Not signed in.';
  } else if (s.state === 'login_pending') {
    base.loginMode = s.loginMode;
    base.message = 'Finish signing in to Instagram inside the window that opened on the server machine. The window closes by itself once Instagram reports the account.';
  } else if (s.state === 'logged_in') {
    base.message = `Signed in as @${s.username}`;
    if (s.savedAt) base.notice = `Cookies saved ${new Date(s.savedAt).toLocaleString()}`;
  }
  return base;
}

// ---------------------------------------------------------------- sign-in

export async function instagramStartLogin(mode: LoginMode, cookiesText: string | undefined, rawLog: (m: string) => void): Promise<SessionStatus> {
  feedLog = rawLog;
  const sup = sessionSupported();
  if (!sup.ok) throw new InstagramSessionError(`Instagram needs a Chrome/Edge on the server (${sup.reason})`, 503);
  if (s.state === 'login_pending' && s.loginBrowser?.isConnected()) return instagramSessionStatus();
  if (probe) await probe.catch(() => undefined);
  if (mode === 'window') return startWindowLogin();
  if (mode !== 'cookies') throw new InstagramSessionError('Instagram has no QR sign-in: paste the cookies of a signed-in browser, or open the sign-in window on the server machine.', 400);
  const { cookies, warnings } = parseInstagramCookies(cookiesText || '');
  log(`cookies received: ${cookies.length} kept${warnings.length ? ' (' + warnings.join('; ') + ')' : ''}`);
  const acc = await checkInstagramAccount(cookies);
  if (!acc.ok) throw new InstagramSessionError(`Instagram could not be reached to check the cookies (${acc.error}); try again in a moment`, 502);
  if (!acc.loggedIn) {
    log(`Instagram says these cookies are signed out (${acc.error || ''})`);
    throw new InstagramSessionError('Instagram does not recognise these cookies as a signed-in account. Export them again while instagram.com shows your account - best from a private window you close right after exporting, so the cookies are not rotated behind our back.', 400);
  }
  await closeLoginBrowser();
  saveCookies(cookies);
  markLoggedIn(acc, 'pasted cookies');
  const st = await instagramSessionStatus();
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
  if (!exe) throw new InstagramSessionError('No Chrome/Edge/Chromium found on the server machine (set BROWSER_PATH); paste cookies instead.', 503);
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
    throw new InstagramSessionError(s.error, 500);
  }
  s.loginBrowser = browser;
  browser.on('disconnected', () => {
    if (s.loginBrowser === browser) {
      s.loginBrowser = undefined;
      if (s.state === 'login_pending') {
        s.state = 'none';
        s.loginMode = undefined;
        s.error = 'The sign-in window was closed before Instagram reported an account.';
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
          .filter((c) => isInstagram(String(c.domain || '')))
          .map((c) => ({ domain: String(c.domain), path: String(c.path || '/'), secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : 0, name: String(c.name), value: String(c.value) }));
        if (!cookies.some((c) => c.name === 'sessionid' && c.value)) continue;
        const acc = await checkInstagramAccount(cookies);
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
  return instagramSessionStatus();
}

export async function instagramCancelLogin(): Promise<SessionStatus> {
  await closeLoginBrowser();
  if (s.state === 'login_pending') {
    s.state = 'none';
    s.loginMode = undefined;
    s.error = undefined;
  }
  return instagramSessionStatus();
}

/** Deletes the cookie file and both browser profiles: the sign-in is gone from the server. */
export async function instagramLogout(): Promise<SessionStatus> {
  await closeLoginBrowser();
  forget(undefined, true);
  fs.rmSync(LOGIN_PROFILE_DIR, { recursive: true, force: true });
  await resetInstagramBrowser(true);
  s.savedAt = undefined;
  log('signed out (cookies deleted)');
  return instagramSessionStatus();
}

/** The For You feed found nothing: returns the reason when the cookies turn out to be dead. */
export async function instagramSessionLost(): Promise<string | undefined> {
  const acc = await verifySavedInstagram(true);
  if (acc && acc.ok && !acc.loggedIn) return s.error || 'Instagram signed this server out';
  return undefined;
}

export const shutdownInstagramSession = (): Promise<void> => closeLoginBrowser();
