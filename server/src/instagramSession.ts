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
 * deletes it and the headless browser's profile. Treat it like a password. Next to it, a small
 * `.meta.json` keeps the identity (User-Agent) of the browser the cookies came from: Instagram ties a
 * web session to the browser that made it ("useragent mismatch" otherwise), so the headless browser
 * presents that identity. The paste request's own User-Agent is taken for it (the person pastes from
 * the browser that exported), the sign-in window's own for the window mode.
 *
 * The check: the account API (`current_user`) names the account outright, but Instagram refuses that
 * call from a datacenter address (429 at once, seen from the GCP VM), so the settings page is tried
 * next (only a signed-in account stays on it). When neither can say - the address is rate-limited -
 * cookies with the shape of a session (`sessionid` = `<account id>:<token>...`) are kept as a
 * provisional sign-in (`verified: false`) and the first Reels page settles it: it confirms the sign-in
 * (instagram.ts calls `confirmed`) or goes to the login page, after which a conclusive "signed out"
 * deletes the cookies. GET /api/session/log?platform=instagram shows each step.
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
/** The identity of the browser the cookies came from (JSON {userAgent}), next to the cookies file. */
const META_FILE = COOKIE_FILE.replace(/\.txt$/i, '') + '.meta.json';
/** The sign-in window's own profile (the headless browser has another one: two Chromes cannot share a profile). */
const LOGIN_PROFILE_DIR = process.env.INSTAGRAM_LOGIN_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'instagram-login-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const SIGNIN_URL = 'https://www.instagram.com/accounts/login/';
const RECHECK_MS = 30 * 60 * 1000;
/** A saved file Instagram would not check is tried again this often, this many times. */
const PROBE_RETRY_MS = 10 * 60 * 1000;
const PROBE_MAX_TRIES = 6;

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
  const names = new Set([...map.values()].map((c) => c.name));
  const missing = ['ds_user_id', 'csrftoken', 'mid', 'ig_did', 'datr'].filter((n) => !names.has(n));
  if (missing.length) warnings.push(`only ${map.size} instagram.com cookie${map.size === 1 ? '' : 's'} (no ${missing.join(', ')}); a complete cookies.txt export is trusted more by Instagram`);
  return { cookies: [...map.values()], warnings };
}

/**
 * What the cookies say about themselves, for when Instagram will not say (a rate-limited server
 * address): a web session's `sessionid` has the form `<account id>:<token>:...` (URL-encoded in
 * exports) and `ds_user_id` names the same account. No proof the session is alive - the Reels page
 * gives that later.
 */
export function cookiesLookSignedIn(cookies: ParsedCookie[]): { ok: boolean; userId?: string; reason?: string } {
  const sessionid = cookies.find((c) => c.name === 'sessionid')?.value || '';
  const dsUserId = cookies.find((c) => c.name === 'ds_user_id')?.value || '';
  if (!sessionid) return { ok: false, reason: 'no sessionid cookie' };
  let decoded = sessionid;
  try {
    decoded = decodeURIComponent(sessionid);
  } catch {
    /* keep as pasted */
  }
  const fromSession = /^(\d{3,25}):/.exec(decoded)?.[1];
  if (fromSession && dsUserId && fromSession !== dsUserId) return { ok: false, reason: 'the sessionid and ds_user_id cookies belong to different accounts (a mixed export)' };
  if (!fromSession && !/^\d{3,25}$/.test(dsUserId)) return { ok: false, reason: 'the sessionid has an unexpected form and there is no ds_user_id' };
  return { ok: true, userId: fromSession || dsUserId };
}

/** A usable User-Agent header value, or undefined. */
export function cleanUserAgent(ua: unknown): string | undefined {
  const t = typeof ua === 'string' ? ua.trim() : '';
  return /^[\x20-\x7e]{16,512}$/.test(t) ? t : undefined;
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
  /** Instagram itself confirmed the cookies (the API or a signed-in-only page); false = provisional */
  verified?: boolean;
  /** Something a signed-in page ran into that the person must act on (a checkpoint) */
  trouble?: string;
}
const s: State = { state: 'none' };
let probe: Promise<void> | undefined;
let probed = false;
let probeRetryAt = 0;
let probeTries = 0;
/** When Instagram last gave no verdict on the saved cookies: the feed does not ask again before PROBE_RETRY_MS. */
let lastInconclusiveAt = 0;
/** The next automatic try of a saved file Instagram could not check (nobody polls between tries). */
let retryTimer: NodeJS.Timeout | undefined;
/** Records an answer without verdict: the pacing of the next tries starts now. */
function noteInconclusive(): void {
  lastInconclusiveAt = Date.now();
  probeTries++;
  probeRetryAt = Date.now() + PROBE_RETRY_MS;
}
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

/** The User-Agent of the browser the saved cookies came from (undefined for a file saved without one). */
export function savedUserAgent(): string | undefined {
  try {
    return cleanUserAgent(JSON.parse(fs.readFileSync(META_FILE, 'utf8'))?.userAgent);
  } catch {
    return undefined;
  }
}

export const instagramSignedIn = (): boolean => s.state === 'logged_in';

/** The Reels page came back for the saved cookies: Instagram accepts them (and may have named the account). */
function confirmSignedIn(username?: string): void {
  if (s.state !== 'logged_in') return;
  const placeholder = !s.username || s.username === 'instagram' || /^user\d+$/.test(s.username);
  if (username && (placeholder || !s.verified)) s.username = username;
  if (!s.verified) log(`Instagram served the Reels page for the saved cookies: signed in as @${s.username} (confirmed)`);
  s.verified = true;
  s.trouble = undefined;
  s.checkedAt = Date.now();
}

setSessionHooks({
  cookies: savedInstagramCookies,
  signedIn: instagramSignedIn,
  confirmed: confirmSignedIn,
  userAgent: savedUserAgent,
  trouble: (message) => {
    s.trouble = message;
    log(message);
  },
});

function saveCookies(cookies: ParsedCookie[], userAgent?: string): void {
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, toNetscape(cookies, 'Instagram'), { mode: 0o600 });
  if (userAgent) fs.writeFileSync(META_FILE, JSON.stringify({ userAgent, savedAt: new Date().toISOString() }), { mode: 0o600 });
  else fs.rmSync(META_FILE, { force: true });
  s.savedAt = Date.now();
}

/** The account's placeholder name while Instagram has not named it: the id the cookies carry. */
const placeholderName = (userId: string | undefined): string => (userId ? `user${userId}` : 'instagram');

function markLoggedIn(acc: InstagramAccount, how: string, verified = true): void {
  s.state = 'logged_in';
  s.username = acc.username || 'instagram';
  s.nickname = acc.name;
  s.avatar = acc.avatar;
  s.verified = verified;
  s.trouble = undefined;
  s.error = undefined;
  s.loginMode = undefined;
  s.checkedAt = Date.now();
  probed = true;
  clearRetry();
  log(`signed in as @${s.username} (${how})`);
}

function forget(reason: string | undefined, deleteFile: boolean): void {
  if (deleteFile) {
    fs.rmSync(COOKIE_FILE, { force: true });
    fs.rmSync(META_FILE, { force: true });
  }
  s.state = 'none';
  s.username = s.nickname = s.avatar = undefined;
  s.verified = false;
  s.trouble = undefined;
  s.loginMode = undefined;
  s.error = reason;
  s.checkedAt = undefined;
  probed = true;
  clearRetry();
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
  const ua = savedUserAgent();
  let acc = await checkInstagramAccount(cookies, ua);
  // A good sign-in is only dropped on a second "signed out" answer: the first may be a passing refusal.
  if (wasIn && acc.ok && !acc.loggedIn) {
    await new Promise((r) => setTimeout(r, 3000));
    acc = await checkInstagramAccount(cookies, ua);
  }
  if (!acc.ok) {
    // Quick retries make Instagram's throttle worse: one more try every 10 minutes, a handful at most.
    noteInconclusive();
    if (wasIn) {
      log(`account check gave no verdict (${acc.error}); the saved sign-in is kept`);
      return acc;
    }
    const look = cookiesLookSignedIn(cookies);
    if (acc.limited && look.ok) {
      // Instagram would not say (it limits this server's address): use the cookies and let the Reels page decide.
      markLoggedIn({ ok: true, loggedIn: true, username: placeholderName(look.userId) }, `saved cookies, not confirmed: ${acc.error}`, false);
      return acc;
    }
    // Not usable as they are: say why. What a retry cannot change (a checkpoint, the wrong browser
    // identity, cookies that are no session) ends the probing; a failure to reach Instagram is retried.
    const final = Boolean(acc.checkpoint || acc.uaMismatch || !look.ok) || probeTries >= PROBE_MAX_TRIES;
    s.error = acc.checkpoint
      ? `Instagram wants a verification for this account (${acc.error}): open instagram.com in your own browser, confirm it was you, then sign in here again with a fresh export.`
      : acc.uaMismatch
        ? `Instagram says the saved cookies were made by another browser than the one this server presents (${acc.error}); sign in again, pasting from the browser you exported with.`
        : !look.ok
          ? `Instagram could not check the saved cookies (${acc.error}) and they do not look like a sign-in (${look.reason}); sign in again with a fresh export.`
          : `Instagram could not check the saved cookies (${acc.error})${final ? '; "Check again" tries once more, or sign in again with a fresh export' : `; next try in ${Math.round(PROBE_RETRY_MS / 60000)} min`}.`;
    if (final) probed = true;
    else {
      // Nobody polls between tries: the next one is scheduled here.
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
    log(`Instagram says the saved cookies are signed out (${acc.error || ''}); deleting them`);
    forget('Instagram no longer accepts the saved cookies (signed out or expired). Sign in again with a fresh export.', true);
    await resetInstagramBrowser(true);
  }
  return acc;
}

/** Checks the saved file in the background; `deliberate` (the panel's "Check again") goes past the pacing and the tries cap. */
function startProbe(deliberate = false): void {
  if (deliberate && s.state === 'none' && fileExists()) {
    probed = false;
    probeTries = 0;
    probeRetryAt = 0;
    clearRetry();
  }
  if (probe || probed || !fileExists() || Date.now() < probeRetryAt || probeTries >= PROBE_MAX_TRIES) return;
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

export async function instagramSessionStatus(recheck = false): Promise<SessionStatus> {
  const sup = sessionSupported();
  if (!sup.ok) return { platform: 'instagram', supported: false, state: 'unsupported', error: sup.reason, message: 'Instagram runs in a browser on the server: it needs Chrome or Edge there (set BROWSER_PATH).' };
  if (s.state === 'none') startProbe(recheck);
  const base: SessionStatus = { platform: 'instagram', supported: true, state: s.state, username: s.username, nickname: s.nickname, avatar: s.avatar, error: s.error, browser: path.basename(sup.executable || 'browser') };
  if (s.state === 'none') {
    // "Checking" only while a check runs; between tries the reason (s.error) is shown and the cookies form is usable.
    base.probing = Boolean(probe);
    base.message = base.probing ? 'Saved Instagram cookies exist; checking them with Instagram…' : fileExists() ? s.error || 'Saved Instagram cookies exist, but Instagram could not be reached to check them ("Check again").' : 'Not signed in.';
  } else if (s.state === 'login_pending') {
    base.loginMode = s.loginMode;
    base.message = 'Finish signing in to Instagram inside the window that opened on the server machine. The window closes by itself once Instagram reports the account.';
  } else if (s.state === 'logged_in') {
    base.message = s.verified ? `Signed in as @${s.username}` : `Signed in as @${s.username} (not yet confirmed by Instagram)`;
    const notes: string[] = [];
    if (s.savedAt) notes.push(`Cookies saved ${new Date(s.savedAt).toLocaleString()}`);
    if (!s.verified) notes.push("Instagram has not confirmed these cookies yet (it is limiting this server's address), so they are used as they are; your feed will show whether they work. If it does not, sign out and paste a fresh export.");
    if (s.trouble) notes.push(s.trouble);
    if (notes.length) base.notice = notes.join('. ');
  }
  return base;
}

// ---------------------------------------------------------------- sign-in

export async function instagramStartLogin(mode: LoginMode, cookiesText: string | undefined, rawLog: (m: string) => void, pasteUserAgent?: unknown): Promise<SessionStatus> {
  feedLog = rawLog;
  const sup = sessionSupported();
  if (!sup.ok) throw new InstagramSessionError(`Instagram needs a Chrome/Edge on the server (${sup.reason})`, 503);
  if (s.state === 'login_pending' && s.loginBrowser?.isConnected()) return instagramSessionStatus();
  if (probe) await probe.catch(() => undefined);
  if (mode === 'window') return startWindowLogin();
  if (mode !== 'cookies') throw new InstagramSessionError('Instagram has no QR sign-in: paste the cookies of a signed-in browser, or open the sign-in window on the server machine.', 400);
  const { cookies, warnings } = parseInstagramCookies(cookiesText || '');
  const ua = cleanUserAgent(pasteUserAgent);
  log(`cookies received: ${cookies.length} kept (${cookies.map((c) => c.name).join(', ')})${warnings.length ? ' - ' + warnings.join('; ') : ''}${ua ? '; browser identity of the paste: ' + ua.slice(0, 80) : ''}`);
  const acc = await checkInstagramAccount(cookies, ua);
  if (acc.checkpoint) throw new InstagramSessionError(`Instagram wants a verification for this account before it serves this server (${acc.error}). Open instagram.com in your own browser, confirm it was you, then export the cookies again.`, 403);
  if (acc.uaMismatch) throw new InstagramSessionError(`Instagram says these cookies were made by another browser than the one you are pasting from (${acc.error}). Paste them from the browser you exported them with, or export them again from this one.`, 400);
  // Only Instagram's own throttle leaves the cookies unjudged; anything else (the browser did not start, a
  // timeout, an odd page) is a server problem to retry.
  if (!acc.ok && !acc.limited) throw new InstagramSessionError(`Instagram could not be reached to check the cookies (${acc.error}); try again in a moment`, 502);
  if (!acc.ok) {
    const look = cookiesLookSignedIn(cookies);
    if (!look.ok) throw new InstagramSessionError(`Instagram could not check the cookies (${acc.error}) and they do not look like a sign-in (${look.reason}). Export them again while instagram.com shows your account.`, 400);
    // Instagram would not say (it limits this server's address): keep the cookies and let the Reels page decide.
    noteInconclusive();
    await closeLoginBrowser();
    saveCookies(cookies, ua);
    markLoggedIn({ ok: true, loggedIn: true, username: placeholderName(look.userId) }, `pasted cookies, not confirmed: ${acc.error}`, false);
    const st = await instagramSessionStatus();
    st.notice = [...warnings, `Instagram would not confirm the cookies (${acc.error}), so they are saved and used as they are; your feed will show whether they work.`].join('; ');
    return st;
  }
  if (!acc.loggedIn) {
    log(`Instagram says these cookies are signed out (${acc.error || ''})`);
    throw new InstagramSessionError('Instagram does not recognise these cookies as a signed-in account. Export them again while instagram.com shows your account - best from a private window you close right after exporting, so the cookies are not rotated behind our back.', 400);
  }
  await closeLoginBrowser();
  saveCookies(cookies, ua);
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
          .filter((c) => isInstagram(String(c.domain || '')))
          .map((c) => ({ domain: String(c.domain), path: String(c.path || '/'), secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : 0, name: String(c.name), value: String(c.value) }));
        if (!cookies.some((c) => c.name === 'sessionid' && c.value)) continue;
        const acc = await checkInstagramAccount(cookies, windowUa);
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
  lastInconclusiveAt = 0;
  probeTries = 0;
  fs.rmSync(LOGIN_PROFILE_DIR, { recursive: true, force: true });
  await resetInstagramBrowser(true);
  s.savedAt = undefined;
  log('signed out (cookies deleted)');
  return instagramSessionStatus();
}

/**
 * The For You feed found nothing or was sent to the login page: returns the reason when the cookies
 * turn out to be dead. Instagram is not asked again within PROBE_RETRY_MS of an answer without verdict
 * (the feed's own retries would otherwise hammer a limited address).
 */
export async function instagramSessionLost(): Promise<string | undefined> {
  if (Date.now() - lastInconclusiveAt < PROBE_RETRY_MS) {
    log(`feed: the Reels page gave nothing, but Instagram gave no verdict on the cookies ${Math.round((Date.now() - lastInconclusiveAt) / 60000)} min ago; not asking again yet`);
    return undefined;
  }
  const acc = await verifySavedInstagram(true);
  if (acc && acc.ok && !acc.loggedIn) return s.error || 'Instagram signed this server out';
  return undefined;
}

export const shutdownInstagramSession = (): Promise<void> => closeLoginBrowser();
