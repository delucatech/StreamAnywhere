/**
 * TikTok sign-in through a REAL browser (puppeteer-core driving the Chrome/Edge already installed
 * on the machine that runs this server; nothing is downloaded).
 *
 * Why a browser: the personalised For You feed (/api/recommend/item_list/) is only answered when
 * the request carries TikTok's client signatures (msToken cookie + X-Bogus + X-Gnarly, minted by
 * webmssdk.js from a browser fingerprint). Measured 2026-10-08: the same request without them, or
 * replayed from a script, returns {"status_code":0} with no items. So instead of re-implementing
 * the signer we let TikTok's own web app run in a signed-in browser profile and read the feed JSON
 * it receives.
 *
 * Flow:
 *   POST /api/session/login {mode:'qr'}     -> a HEADLESS page opens https://www.tiktok.com/login/qrcode;
 *                                             the QR canvas is copied into the session status so the
 *                                             feed page can show it; the person scans it with the
 *                                             TikTok app. Works on servers without a display.
 *   POST /api/session/login {mode:'window'} -> opens a VISIBLE browser window on tiktok.com/login
 *                                             (any sign-in method; needs a desktop on the server).
 *   GET  /api/session                       -> state, @username, current QR image while pending
 *   POST /api/session/logout                -> closes everything and deletes the profile directory
 *   POST /api/feed {source:'foryou'}        -> a headless page on /foryou; every recommend/item_list
 *                                             response is captured; "more" = scrolling the page.
 *
 * The server never sees a password. The profile lives in ~/.streamanywhere/tiktok-profile
 * (TIKTOK_PROFILE_DIR overrides). It holds the TikTok cookies of the signed-in account: treat the
 * directory like a password.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FeedItem, LoginMode, SessionInputRequest, SessionStatus } from '../../shared/types';
import { exploreApiUrl, itemToFeedItem, parseExploreBody, type ExploreResult } from './feed';

type Browser = import('puppeteer-core').Browser;
type Page = import('puppeteer-core').Page;
type Frame = import('puppeteer-core').Frame;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handle = import('puppeteer-core').ElementHandle<any>;

/**
 * Outside the repository on purpose: Chrome writes to the profile constantly and `tsx watch`
 * (npm run dev) restarts the server on every change inside server/ (observed: the API froze).
 */
const PROFILE_DIR = process.env.TIKTOK_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'tiktok-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Once TikTok e-mailed a verification code, the attempt (page, dialog, token, ticket) is held this long:
 *  the code stays valid for hours, and the user may come back to enter it much later. */
const VERIFY_HOLD_MS = 48 * 60 * 60 * 1000;
/** A verification ticket (code accepted) is re-used for a fresh QR token for this long. */
const TICKET_KEEP_MS = VERIFY_HOLD_MS;
const QR_RELOAD_MS = 110 * 1000;
const FEED_URL = 'https://www.tiktok.com/foryou';
const QR_URL = 'https://www.tiktok.com/login/qrcode';
const QR_SELECTOR = '[data-e2e="qr-code"] canvas';
/** Viewport of the headless login page = pixel size of the screenshots the UI shows (clicks map 1:1) */
const QR_VIEWPORT = { width: 760, height: 860 };

export function findBrowserExecutable(): string | undefined {
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge');
  }
  return candidates.find((c) => fs.existsSync(c));
}

interface SessionInternal {
  state: SessionStatus['state'];
  username?: string;
  nickname?: string;
  avatar?: string;
  error?: string;
  loginMode?: LoginMode;
  loginBrowser?: Browser;
  loginStartedAt?: number;
  qrPage?: Page;
  qr?: string;
  qrState?: SessionStatus['qrState'];
  /** What the login page shows when no QR could be captured (title + first words), for the UI */
  qrPageHint?: string;
  qrPageShot?: string;
  /** Last answer of TikTok's QR API seen on the page (status + body snippet) */
  qrApi?: string;
  /** Expiry of the current QR (ms epoch) as announced by TikTok's API; the page is only reloaded after it */
  qrExpireAt?: number;
  scannedAt?: number;
  /** TikTok's own get_qrcode / check_qrconnect request URLs as the page issued them (templates for our own calls) */
  qrGetUrl?: string;
  qrCheckUrl?: string;
  /** Token of the QR we are showing (from get_qrcode); polled through check_qrconnect */
  qrToken?: string;
  /** Last time TikTok answered a status check with "maximum attempts" (rate limit) */
  qrRateLimitedAt?: number;
  /** redirect_url from a confirmed check_qrconnect answer */
  qrRedirect?: string;
  /** When TikTok last answered the status check with 2135 (identity verification required on the page) */
  qrVerifyAt?: number;
  /** TikTok's verification decision (x-tt-verify-idv-decision-conf header), for the log */
  qrVerifyConf?: string;
  qrVerifyStep?: SessionStatus['verifyStep'];
  qrVerifyText?: string;
  /** Last time the server clicked something in the verification dialog by itself */
  qrVerifyAutoAt?: number;
  /** Last time the server pressed "Send code" (or chose the method) - no re-sends for a minute */
  qrVerifySentAt?: number;
  /** How many times the server tried to activate the Email row of the current dialog */
  qrVerifyTries?: number;
  /** When the server pressed "Send code" (once per verification; never again by itself) */
  qrCodeSentAt?: number;
  /** When the remembered code was typed automatically for the current verification */
  qrAutoCodeAt?: number;
  /** When "Resend" was last pressed for the user */
  qrResendAt?: number;
  /** Outcome of the last code the user entered */
  qrVerifyResult?: SessionStatus['verifyResult'];
  /** Dialog text just before the code was submitted (new sentences after it = TikTok's answer) */
  qrTextBeforeCode?: string;
  /** Verification ticket TikTok's SDK sends (x-tt-passport-ticket) once the code was accepted; re-used
   *  for a fresh QR token when the first one expired while the user fetched the e-mail */
  qrTicket?: string;
  qrTicketAt?: number;
  /** QR token for which the saved ticket was already tried (one try per token) */
  qrTicketTriedToken?: string;
  qrTicketRetryAt?: number;
  /** Shown in the UI for a few minutes (why the attempt restarted, what to do) */
  qrNotice?: string;
  qrNoticeAt?: number;
  qrHoldLoggedAt?: number;
  headless?: Browser;
  feedPage?: Page;
  explorePage?: Page;
  /** Items captured from the headless /foryou page that have not been handed out yet */
  pending: FeedItem[];
  seenIds: Set<string>;
  feedCookieHeader?: string;
  lastFeedError?: string;
}

const s: SessionInternal = { state: 'none', pending: [], seenIds: new Set() };

/**
 * The e-mailed verification code and the verification ticket survive a server restart: TikTok keeps
 * the code valid for hours, so the user should never have to fetch the e-mail twice.
 */
const VERIFY_STORE = path.join(path.dirname(PROFILE_DIR), 'tiktok-verify.json');
interface VerifyStore {
  code?: { value: string; at: number };
  ticket?: { value: string; at: number };
}
let verifyStore: VerifyStore | undefined;
function loadVerifyStore(): VerifyStore {
  if (verifyStore) return verifyStore;
  let j: any = {};
  try {
    j = JSON.parse(fs.readFileSync(VERIFY_STORE, 'utf8'));
  } catch {
    /* none yet */
  }
  const fresh = (e: any): { value: string; at: number } | undefined => (e && typeof e.value === 'string' && e.value && typeof e.at === 'number' && Date.now() - e.at < VERIFY_HOLD_MS ? { value: e.value, at: e.at } : undefined);
  verifyStore = { code: fresh(j.code), ticket: fresh(j.ticket) };
  return verifyStore;
}
function saveVerifyStore(patch: Partial<VerifyStore>): void {
  verifyStore = { ...loadVerifyStore(), ...patch };
  try {
    fs.mkdirSync(path.dirname(VERIFY_STORE), { recursive: true });
    fs.writeFileSync(VERIFY_STORE, JSON.stringify(verifyStore));
  } catch (e) {
    feedLog?.('could not save the verification store: ' + (e as Error).message);
  }
}

/**
 * Saves an e-mail code the user already has (or forgets it when empty). It is typed into TikTok's
 * code field automatically after the next scan - and right away if that field is up now.
 */
export async function saveVerifyCode(raw: string): Promise<SessionStatus> {
  const code = raw.replace(/\D+/g, '').slice(0, 8);
  if (!code) {
    saveVerifyStore({ code: undefined, ticket: undefined });
    s.qrTicket = s.qrTicketAt = undefined;
    feedLog?.('saved verification code and ticket forgotten');
    return sessionStatus();
  }
  saveVerifyStore({ code: { value: code, at: Date.now() } });
  feedLog?.(`verification code saved for later (ends in ${code.slice(-2)})`);
  if (s.state === 'login_pending' && s.loginMode === 'qr' && s.qrState === 'verify' && s.qrVerifyStep === 'code' && s.qrPage && !s.qrPage.isClosed()) return sessionInput({ type: 'code', code });
  return sessionStatus();
}
let puppeteerMod: typeof import('puppeteer-core') | undefined;
let feedLog: ((m: string) => void) | undefined;
const guestAllowed = (): boolean => /^(1|true|yes)$/i.test(process.env.FORYOU_ALLOW_GUEST || '');

/**
 * Loaded on first use, not at startup: the Explore feed and the resolver must keep working on a
 * server where puppeteer-core cannot initialise. (Observed 2026-10-08: when the server was started
 * by the Claude desktop app's preview runner, loading/launching puppeteer-core never completed;
 * from a normal terminal, `npm run dev` / `tsx watch` and `npm start` both work.)
 */
async function puppeteer(): Promise<typeof import('puppeteer-core')> {
  if (!puppeteerMod) puppeteerMod = await import('puppeteer-core');
  return puppeteerMod;
}

export function sessionSupported(): { ok: boolean; reason?: string; executable?: string } {
  if (/^(0|false|no)$/i.test(process.env.ENABLE_BROWSER_SESSION || '')) return { ok: false, reason: 'ENABLE_BROWSER_SESSION=0' };
  const exe = findBrowserExecutable();
  if (!exe) return { ok: false, reason: 'No Chrome/Edge/Chromium found on this machine (set BROWSER_PATH to the executable)' };
  return { ok: true, executable: exe };
}

function profileExists(): boolean {
  return fs.existsSync(path.join(PROFILE_DIR, 'Default')) || fs.existsSync(path.join(PROFILE_DIR, 'Local State'));
}

/**
 * Chrome leaves Singleton* lock files in the profile when it did not exit cleanly (hard reset,
 * OOM kill). With a stale lock the next launch prints nothing and exits at once, which puppeteer
 * reports as "Failed to launch the browser process!" with an empty log. We own the profile, so
 * when none of OUR browsers is running the locks are stale and can go.
 */
function clearStaleProfileLocks(): void {
  if (s.headless?.isConnected() || s.loginBrowser?.isConnected()) return;
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(PROFILE_DIR, f), { force: true });
    } catch {
      /* ignore */
    }
  }
}

async function launch(headless: boolean): Promise<Browser> {
  try {
    return await launchOnce(headless);
  } catch (e) {
    // One retry: boot-time CPU starvation on tiny VMs and stale locks are both transient.
    feedLog?.(`browser launch failed (${(e as Error).message.split('\n')[0]}); retrying once`);
    await new Promise((r) => setTimeout(r, 3000));
    return launchOnce(headless);
  }
}

async function launchOnce(headless: boolean): Promise<Browser> {
  const sup = sessionSupported();
  if (!sup.ok) throw new Error(sup.reason);
  const p = await puppeteer();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  clearStaleProfileLocks();
  // Verified 2026-10-08: with the UA fix (see preparePage), --disable-blink-features=AutomationControlled
  // and without --enable-automation, the headless page gets real feed batches; plain headless got
  // "Something went wrong".
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--mute-audio', `--window-size=${headless ? '1280,900' : '1100,860'}`];
  if (headless) args.push('--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--renderer-process-limit=3');
  // Linux servers: /dev/shm is tiny on small VMs; a service user has no sandboxed user namespace.
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
  if (process.platform === 'linux' && (process.getuid?.() === 0 || /^(1|true|yes)$/i.test(process.env.BROWSER_NO_SANDBOX || ''))) args.push('--no-sandbox');
  return p.launch({
    executablePath: sup.executable,
    headless: headless ? 'new' : false,
    userDataDir: PROFILE_DIR,
    defaultViewport: headless ? { width: 1280, height: 900 } : null,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    // Cold starts on a 0.25-vCPU VM took >20 s; puppeteer's default is 30 s.
    timeout: 90_000,
    protocolTimeout: 45_000,
  });
}

/** UA without "HeadlessChrome" and no media downloads (the viewer's browser fetches the videos itself). */
async function preparePage(page: Page, browser: Browser): Promise<void> {
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Only media: TikTok's scripts (incl. the signing SDK) come from *.tiktokcdn-*.com too.
    const t = req.resourceType();
    if (t === 'media' || t === 'font' || t === 'image' || /mime_type=video|\.mp4(\?|$)/.test(req.url())) {
      req.abort().catch(() => undefined);
      return;
    }
    if (page === s.qrPage) {
      const ticket = req.headers()['x-tt-passport-ticket'];
      if (ticket && ticket !== s.qrTicket) {
        s.qrTicket = ticket;
        s.qrTicketAt = Date.now();
        saveVerifyStore({ ticket: { value: ticket, at: s.qrTicketAt } });
        if (s.qrVerifyResult?.state === 'checking') s.qrVerifyResult = { state: 'accepted', at: Date.now() };
        feedLog?.('verification ticket received from TikTok: the code was accepted (ticket kept for 48 h in case the QR token expired)');
      }
      // While the user fetches the e-mail code, TikTok's page would rotate the QR on its ~1 min timer
      // and drop the verified token with it. Hold the rotation: the token is renewed by us if needed.
      if (s.qrState === 'verify' && /passport\/web\/get_qrcode/.test(req.url())) {
        if (Date.now() - (s.qrHoldLoggedAt || 0) > 60_000) {
          s.qrHoldLoggedAt = Date.now();
          feedLog?.("holding TikTok's QR rotation while the verification is pending");
        }
        req.abort('aborted').catch(() => undefined);
        return;
      }
    }
    req.continue().catch(() => undefined);
  });
}

async function hasSessionCookie(page: Page): Promise<boolean> {
  const cookies = await page.cookies('https://www.tiktok.com');
  return cookies.some((c) => (c.name === 'sessionid' || c.name === 'sid_tt' || c.name === 'sessionid_ss') && c.value);
}

/** Asks TikTok who is signed in (same-origin fetch from inside the page, so cookies/signing apply). */
async function fetchAccount(page: Page): Promise<{ username?: string; nickname?: string; avatar?: string; ok: boolean; error?: string }> {
  try {
    const info: any = await page.evaluate(
      `fetch('https://www.tiktok.com/passport/web/account/info/?aid=1988', { credentials: 'include' }).then((r) => r.json())`,
    );
    if (info?.data && !info.data.error_code) {
      return { ok: true, username: info.data.username || info.data.screen_name, nickname: info.data.screen_name || info.data.username, avatar: info.data.avatar_url };
    }
    return { ok: false, error: info?.data?.description || info?.message || 'not signed in' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function sessionStatus(): SessionStatus {
  const sup = sessionSupported();
  const browser = sup.executable ? path.basename(sup.executable) : undefined;
  if (!sup.ok) return { supported: false, state: 'unsupported', error: sup.reason, message: 'Sign-in needs the Node server on a machine with Chrome, Edge or Chromium.' };
  const base: SessionStatus = { supported: true, state: s.state, username: s.username, nickname: s.nickname, avatar: s.avatar, error: s.error, browser };
  const savedCode = loadVerifyStore().code;
  if (savedCode && s.state !== 'logged_in') base.savedCode = { hint: savedCode.value.slice(-2), at: savedCode.at };
  if (s.state === 'none') base.message = profileExists() ? 'A saved browser profile exists; checking it on first use.' : 'Not signed in.';
  if (s.state === 'login_pending') {
    base.loginMode = s.loginMode;
    if (s.loginMode === 'qr') {
      base.qr = s.qr;
      base.qrState = s.qrState;
      if (s.qr && s.qrExpireAt) base.qrExpiresAt = s.qrExpireAt;
      if ((!s.qr || s.qrState === 'verify') && s.qrPageShot) {
        base.pageShot = s.qrPageShot;
        base.pageShotSize = { w: QR_VIEWPORT.width, h: QR_VIEWPORT.height };
      }
      if (s.qrState === 'verify') {
        base.verifyStep = s.qrVerifyStep || 'choose';
        base.verifyText = s.qrVerifyText;
        base.codeSentAt = s.qrCodeSentAt;
        base.verifyUntil = (s.qrCodeSentAt || s.qrVerifyAt || Date.now()) + VERIFY_HOLD_MS;
        base.verifyResult = s.qrVerifyResult;
        if (Date.now() - (s.qrCodeSentAt || s.qrVerifyAt || 0) > 90_000 && s.qrVerifyStep === 'code' && !s.qrVerifyResult) base.notice = 'No e-mail yet? Check the spam folder. The code stays valid for hours and this page waits for it; "Resend code" asks TikTok for a new one.';
      }
      if (s.qrNotice && Date.now() - (s.qrNoticeAt || 0) < 4 * 60_000) base.notice = s.qrNotice;
      const limited = s.qrRateLimitedAt && Date.now() - s.qrRateLimitedAt < 30_000 && s.qrState !== 'verify';
      base.message = limited
        ? 'TikTok is temporarily refusing sign-in status checks from this server ("maximum number of attempts"). Scans are not noticed while this lasts; wait 10–15 minutes, then try again.'
        : s.qrState === 'verify'
          ? s.qrVerifyStep === 'code'
            ? `TikTok sent a verification code${verifyTarget() ? ' to ' + verifyTarget() : ''}. Enter it below and press Verify; the server submits it on TikTok's page.`
            : s.qrVerifyStep === 'sending'
              ? 'TikTok wants to verify it is you. The server chose "Email" – waiting for the code field…'
              : 'TikTok wants an extra verification before it signs this browser in. The server picks "Email" by itself; otherwise tap or click on the live picture below.'
          : s.qrState === 'scanned'
          ? 'Scanned – confirm the sign-in in the TikTok app.'
          : s.qr
            ? 'Scan the QR code with the TikTok app.'
            : s.qrPageHint
              ? `TikTok did not show a QR code. The page says: ${s.qrPageHint}`
              : 'Loading the QR code…';
      if (limited) base.qrState = 'expired';
    } else base.message = 'Finish signing in inside the TikTok window that opened on the server machine.';
  }
  if (s.state === 'logged_in') base.message = `Signed in as @${s.username || '?'}`;
  return base;
}

/** Masked address/number TikTok's verification dialog mentions (h***d@example.com, +1 ***123) */
function verifyTarget(): string {
  const m = /[\w*.+-]+@[\w*.-]+\.\w+|\+?\d[\d* -]{5,}\d/.exec(s.qrVerifyText || '');
  return m ? m[0] : '';
}

let probe: Promise<void> | undefined;
let probed = false;

/**
 * Verifies a saved profile (headless) once per server run so the status is right after a restart.
 * The check launches a browser and can take seconds, so GET /api/session starts it in the
 * background and answers immediately with `probing: true`; clients poll until it is false.
 * `wait` = true (used before fetching For You) awaits the result instead.
 */
export async function sessionProbe(wait = false): Promise<SessionStatus> {
  if (!probed && s.state === 'none' && profileExists() && sessionSupported().ok) {
    probe =
      probe ||
      (async () => {
        try {
          const page = await feedPage();
          const acc = await fetchAccount(page);
          if (acc.ok) markLoggedIn(acc);
          // not ok: the saved profile holds no (valid) session - stay 'none' without reporting an error.
        } catch (e) {
          s.error = (e as Error).message;
        } finally {
          probed = true;
          probe = undefined;
        }
      })();
    if (wait) await probe;
  }
  const st = sessionStatus();
  if (probe) {
    st.probing = true;
    st.message = 'Checking the saved browser profile…';
  }
  return st;
}

function markLoggedIn(acc: { username?: string; nickname?: string; avatar?: string }): void {
  s.state = 'logged_in';
  s.username = acc.username;
  s.nickname = acc.nickname;
  s.avatar = acc.avatar;
  s.error = undefined;
  s.qr = undefined;
  s.qrState = undefined;
  s.loginMode = undefined;
}

/** The last sign-in log lines (GET /api/session/log), so the flow can be diagnosed without a shell. */
const recentLog: string[] = [];
function remember(m: string): void {
  recentLog.push(new Date().toISOString().slice(11, 19) + ' ' + m);
  if (recentLog.length > 120) recentLog.splice(0, recentLog.length - 120);
}
export function sessionLog(): { lines: string[] } {
  return { lines: recentLog.slice() };
}
const wrapLog = (log: (m: string) => void): ((m: string) => void) => (m) => {
  remember(m);
  log(m);
};

export async function startLogin(mode: LoginMode, rawLog: (m: string) => void): Promise<SessionStatus> {
  if (s.state === 'login_pending' && (s.loginBrowser || s.qrPage)) return sessionStatus();
  if (probe) await probe.catch(() => undefined);
  probed = true;
  const log = (m: string): void => {
    remember(m);
    rawLog(m);
  };
  feedLog = log;
  return mode === 'window' ? startWindowLogin(log) : startQrLogin(log);
}

// ---------------------------------------------------------------- QR sign-in (headless, no display)
async function startQrLogin(log: (m: string) => void): Promise<SessionStatus> {
  s.state = 'login_pending';
  s.loginMode = 'qr';
  s.error = undefined;
  s.qr = undefined;
  s.qrPageHint = undefined;
  s.qrPageShot = undefined;
  s.qrExpireAt = undefined;
  s.scannedAt = undefined;
  s.qrToken = undefined;
  s.qrGetUrl = undefined;
  s.qrCheckUrl = undefined;
  s.qrRedirect = undefined;
  s.qrVerifyAt = undefined;
  s.qrVerifyConf = undefined;
  s.qrVerifyStep = undefined;
  s.qrVerifyText = undefined;
  s.qrVerifyAutoAt = undefined;
  s.qrVerifySentAt = undefined;
  s.qrVerifyTries = undefined;
  s.qrNotice = undefined;
  s.qrNoticeAt = undefined;
  s.qrTicketTriedToken = undefined;
  s.qrCodeSentAt = undefined;
  s.qrAutoCodeAt = undefined;
  s.qrResendAt = undefined;
  s.qrVerifyResult = undefined;
  s.qrTextBeforeCode = undefined;
  s.qrState = 'new';
  s.loginStartedAt = Date.now();
  const stored = loadVerifyStore();
  if (!s.qrTicket && stored.ticket) {
    s.qrTicket = stored.ticket.value;
    s.qrTicketAt = stored.ticket.at;
    log('verification ticket restored from disk (a scan within 48 h of the last code needs no e-mail)');
  }
  const browser = await headlessBrowser();
  // An e2-micro cannot run three TikTok tabs: close the feed/explore pages while the QR is pending.
  await closeSecondaryPages();
  const page = await browser.newPage();
  await preparePage(page, browser);
  await page.setViewport({ ...QR_VIEWPORT, deviceScaleFactor: 1 }).catch(() => undefined);
  s.qrPage = page;
  // Diagnostic: what TikTok's QR API answers (datacenter IPs get rate-limited / empty answers).
  // The QR comes from TikTok's own API answer (data.qrcode = base64 PNG) - no need to wait for the
  // page to draw it into a canvas, which a small VM may never get around to. The qrconnect poll
  // answers carry the scan state ("new" / "scanned" / "confirmed").
  page.on('response', (res) => {
    if (!/passport\/web\/get_qrcode|qrconnect/.test(res.url())) return;
    void res
      .text()
      .then((body) => {
        s.qrApi = `${res.status()} ${new URL(res.url()).pathname} ${body.replace(/\s+/g, ' ').slice(0, 160)}`;
        if (res.url().includes('get_qrcode')) s.qrGetUrl = res.url();
        else if (!s.qrCheckUrl) s.qrCheckUrl = res.url();
        let json: any;
        try {
          json = JSON.parse(body);
        } catch {
          log('QR API (not JSON): ' + s.qrApi);
          return;
        }
        const d = json?.data || {};
        // Answer to a status check that carried the verification ticket (the SDK's retry after the code,
        // or our own re-use of a saved ticket): this is where we learn whether the token survived.
        const ticketed = Boolean(res.request().headers()['x-tt-passport-ticket']);
        if (ticketed) log('status check with verification ticket answered: ' + body.replace(/\s+/g, ' ').slice(0, 200));
        if (typeof d.qrcode === 'string' && d.qrcode.length > 100 && s.qrPage === page) {
          s.qr = 'data:image/png;base64,' + d.qrcode;
          s.qrState = 'new';
          s.qrPageHint = undefined;
          s.qrPageShot = undefined;
          s.scannedAt = undefined;
          if (s.qrVerifyAt) log('verification abandoned - TikTok issued a new QR code');
          s.qrVerifyAt = undefined;
          s.qrVerifyStep = undefined;
          s.qrVerifyText = undefined;
          if (typeof d.token === 'string') s.qrToken = d.token;
          s.qrExpireAt = typeof d.expire_time === 'number' && d.expire_time > 1e9 ? d.expire_time * 1000 : Date.now() + 55_000;
          log(`QR code received from TikTok's API (${d.qrcode.length} chars, valid ${Math.round((s.qrExpireAt - Date.now()) / 1000)} s)`);
        } else if (typeof d.status === 'string') {
          // The page keeps polling ITS token; once we drive our own, only answers for our token count.
          let urlToken: string | null = null;
          try {
            urlToken = new URL(res.url()).searchParams.get('token');
          } catch {
            /* ignore */
          }
          if (s.qrToken && urlToken && urlToken !== s.qrToken) return;
          if (d.status === 'scanned' || d.status === 'confirmed') {
            if (s.qrState !== 'scanned') log(`QR ${d.status} - waiting for TikTok to finish the sign-in`);
            s.qrState = 'scanned';
            s.scannedAt = s.scannedAt || Date.now();
            if (d.status === 'confirmed' && typeof d.redirect_url === 'string' && d.redirect_url.startsWith('http')) s.qrRedirect = d.redirect_url;
          } else if (d.status === 'expired' && ticketed) {
            // The code was accepted, but TikTok had already retired the QR token (~1 min life). Start over
            // with a fresh code; the ticket is re-used for it so the e-mail is not asked again.
            void restartAfterVerify(page, log, "Your verification went through, but TikTok's QR session had expired by then (its codes live about a minute). A fresh code is loading: scan it again. The server re-uses the verification, so no second e-mail should be needed.");
          } else if (d.status === 'expired' && (s.qrState as string) !== 'scanned') s.qrState = 'expired';
        } else if (json?.message === 'error' || d.error_code) {
          if (ticketed && d.error_code !== 2135) {
            void restartAfterVerify(page, log, `TikTok did not accept the verified sign-in (${d.description || 'error ' + d.error_code}). A fresh code is loading: scan it again.`);
          } else if (d.error_code === 2135 && res.url().includes('qrconnect')) {
            if (ticketed) log('TikTok did not accept the saved verification ticket for this token; asking for a fresh verification');
            else if (retryWithTicket(page, log)) return; // the ticketed answer decides (confirmed / 2135 again)
            // "IDV required": the phone confirmed, but TikTok wants an identity verification (captcha,
            // code, ...) inside THIS page before it hands over the session. Its SDK renders that as a
            // modal; the UI shows the page live and forwards the user's clicks/typing (sessionInput).
            const conf = res.headers()['x-tt-verify-idv-decision-conf'] || '';
            if (s.qrState !== 'verify') log(`QR confirmed on the phone, but TikTok requires a verification on the page (2135)${conf ? ' decision=' + conf.slice(0, 300) : ''}`);
            s.qrState = 'verify';
            s.qrVerifyAt = Date.now();
            s.qrVerifyConf = conf || s.qrVerifyConf;
            s.scannedAt = s.scannedAt || Date.now();
          } else if (d.error_code === 7 || /maximum number of attempts/i.test(String(d.description || ''))) {
            if (!s.qrRateLimitedAt) log('TikTok rate-limits the QR status checks for this session: ' + s.qrApi);
            s.qrRateLimitedAt = Date.now();
          } else log('QR API error: ' + s.qrApi);
        }
      })
      .catch(() => undefined);
  });
  await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  log('QR sign-in page opened');
  void qrLoop(page, browser, log);
  // Give the first QR a moment so the first status answer already carries it.
  for (let i = 0; i < 20 && !s.qr && s.qrPage === page; i++) await new Promise((r) => setTimeout(r, 250));
  return sessionStatus();
}

async function captureQr(page: Page): Promise<string | undefined> {
  try {
    await page.waitForSelector(QR_SELECTOR, { timeout: 8000 });
    const data = (await page.evaluate(`(() => { const c = document.querySelector('${QR_SELECTOR}'); return c ? c.toDataURL('image/png') : null; })()`)) as string | null;
    return data && data.startsWith('data:image/png') && data.length > 200 ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Strips TikTok's per-request signatures; the page's fetch hook adds fresh ones. */
function unsignedUrl(url: string): string {
  const u = new URL(url);
  for (const k of ['X-Bogus', 'X-Gnarly', 'X-Dynosaur', '_signature']) u.searchParams.delete(k);
  return u.toString();
}

let qrBackoffUntil = 0;
let lastQrRequestAt = 0;

/** Asks TikTok for a new QR from inside the page (signed by its SDK). Returns false when not possible yet. */
async function requestNewQr(page: Page, log: (m: string) => void): Promise<boolean> {
  if (!s.qrGetUrl) return false;
  // Never more often than every 20 s, and not during a rate-limit back-off.
  if (Date.now() < qrBackoffUntil || Date.now() - lastQrRequestAt < 15_000) return false;
  lastQrRequestAt = Date.now();
  try {
    const json: any = await page.evaluate(`fetch(${JSON.stringify(unsignedUrl(s.qrGetUrl))}, { credentials: 'include' }).then((r) => r.json())`);
    const d = json?.data || {};
    if (typeof d.qrcode === 'string' && d.qrcode.length > 100) {
      s.qr = 'data:image/png;base64,' + d.qrcode;
      s.qrToken = typeof d.token === 'string' ? d.token : s.qrToken;
      s.qrExpireAt = typeof d.expire_time === 'number' && d.expire_time > 1e9 ? d.expire_time * 1000 : Date.now() + 55_000;
      s.qrState = 'new';
      s.scannedAt = undefined;
      s.qrPageHint = undefined;
      s.qrPageShot = undefined;
      log(`new QR requested in page (valid ${Math.round((s.qrExpireAt - Date.now()) / 1000)} s)`);
      return true;
    }
    log('in-page get_qrcode answered without a QR: ' + JSON.stringify(json).slice(0, 160));
    if (d.error_code === 7 || /maximum number of attempts/i.test(String(d.description || ''))) {
      // TikTok limits how many codes one session may request; wait before asking again.
      s.qrPageHint = 'TikTok limited QR requests for a moment (too many attempts). A new code will be requested in about a minute.';
      qrBackoffUntil = Date.now() + 65_000;
    }
  } catch (e) {
    log('in-page get_qrcode failed: ' + (e as Error).message.split('\n')[0]);
  }
  return false;
}

/** Polls check_qrconnect for OUR token (kept for diagnostics; the page's own polling is used in normal operation). */
export async function pollQrToken(page: Page): Promise<{ status?: string; redirect?: string; raw?: string }> {
  if (!s.qrToken) return {};
  const base = s.qrCheckUrl || (s.qrGetUrl ? s.qrGetUrl.replace('/get_qrcode/', '/check_qrconnect/') : undefined);
  if (!base) return {};
  const u = new URL(unsignedUrl(base));
  u.searchParams.set('token', s.qrToken);
  try {
    const json: any = await page.evaluate(`fetch(${JSON.stringify(u.toString())}, { credentials: 'include' }).then((r) => r.json())`);
    const d = json?.data || {};
    return { status: typeof d.status === 'string' ? d.status : undefined, redirect: typeof d.redirect_url === 'string' ? d.redirect_url : undefined, raw: JSON.stringify(json).slice(0, 200) };
  } catch (e) {
    return { raw: (e as Error).message.split('\n')[0] };
  }
}

/**
 * The phone confirmed a NEW token and TikTok asks for a verification again, but the user already passed
 * one a moment ago: send the status check with that ticket ourselves. Returns false when there is no
 * usable ticket (then the normal verification starts). The page's response hook handles the answer.
 */
function retryWithTicket(page: Page, log: (m: string) => void): boolean {
  if (!s.qrTicket || !s.qrToken || Date.now() - (s.qrTicketAt || 0) > TICKET_KEEP_MS || s.qrTicketTriedToken === s.qrToken) return false;
  const base = s.qrCheckUrl || (s.qrGetUrl ? s.qrGetUrl.replace('/get_qrcode/', '/check_qrconnect/') : undefined);
  if (!base) return false;
  s.qrTicketTriedToken = s.qrToken;
  s.qrTicketRetryAt = Date.now();
  const u = new URL(unsignedUrl(base));
  u.searchParams.set('token', s.qrToken);
  log('re-using the verification ticket from the previous attempt for the new QR token');
  void page
    .evaluate(`fetch(${JSON.stringify(u.toString())}, { credentials: 'include', headers: { 'x-tt-passport-ticket': ${JSON.stringify(s.qrTicket)} } }).then((r) => r.text())`)
    .catch((e) => log('ticketed status check failed: ' + (e as Error).message.split('\n')[0]));
  return true;
}

let restarting = false;

/** Leaves the verification, tells the user why, and loads a fresh QR (clean page, modal gone). */
async function restartAfterVerify(page: Page, log: (m: string) => void, notice: string): Promise<void> {
  if (restarting || s.qrPage !== page) return;
  restarting = true;
  try {
    log('starting over: ' + notice.slice(0, 120));
    s.qrNotice = notice;
    s.qrNoticeAt = Date.now();
    s.qrVerifyAt = undefined;
    s.qrVerifyStep = undefined;
    s.qrVerifyText = undefined;
    s.qrVerifyAutoAt = undefined;
    s.qrVerifySentAt = undefined;
    s.qrCodeSentAt = undefined;
    s.qrAutoCodeAt = undefined;
    s.qrResendAt = undefined;
    s.qrVerifyResult = undefined;
    s.qrTextBeforeCode = undefined;
    s.qrState = 'expired';
    s.qr = undefined;
    s.qrExpireAt = undefined;
    s.scannedAt = undefined;
    s.qrRedirect = undefined;
    // The attempt starts afresh: the 10-minute scan window counts from now again.
    s.loginStartedAt = Date.now();
    await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
  } finally {
    restarting = false;
  }
}

/** Screenshot of the whole login-page viewport into the status (what the user sees in the live view). */
async function captureShot(page: Page): Promise<void> {
  try {
    const shot = await page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' });
    if (s.qrPage === page) s.qrPageShot = `data:image/jpeg;base64,${shot}`;
  } catch {
    /* page busy or gone */
  }
}

/** What TikTok's verification dialog currently shows (text of the modal, across frames) */
interface VerifyView {
  text: string;
  input: boolean;
  frames: number;
}

/**
 * In-page finder (runs in every frame). mode 'input' = the code field; otherwise the smallest visible
 * element whose text matches `reStr` (and not `notStr`): the smallest element that still contains the
 * whole match is the row/button itself, not a container around it.
 */
const FIND_JS = `(reStr, notStr, mode) => {
  const re = new RegExp(reStr, 'i');
  const not = notStr ? new RegExp(notStr, 'i') : null;
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0' && cs.pointerEvents !== 'none'; };
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  if (mode === 'input') {
    // The code field: score every visible text input (placeholder/label mentioning code or digits,
    // numeric keyboard, 6-char limit, inside TikTok's dialog) and take the best, never just the first.
    // Shadow roots are walked too (component libraries hide their <input> in them).
    const inputs = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) inputs.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    let best = null, bestScore = -1;
    for (const el of inputs) {
      if (!vis(el) || ['hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'search'].includes(el.type)) continue;
      const hint = clean([el.placeholder, el.getAttribute('aria-label'), el.name, el.id, el.autocomplete].join(' '));
      let score = 0;
      if (/code|digit|verif|otp/i.test(hint)) score += 10;
      if (/numeric|tel/i.test(el.inputMode || '') || el.type === 'tel' || el.type === 'number') score += 5;
      if (el.maxLength === 6) score += 5;
      if (el.closest('#idv-modal-container, [role="dialog"], [class*="modal" i], [class*="Modal"]')) score += 5;
      if (/search|password|email|phone|user/i.test(hint) && !/code/i.test(hint)) score -= 10;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }
  let best = null, bestLen = 1e9;
  for (const el of document.querySelectorAll('button, [role="button"], a, li, div, span, p, label')) {
    if (!vis(el)) continue;
    const label = clean(el.innerText || el.getAttribute('aria-label'));
    if (!label || label.length > 140 || !re.test(label) || (not && not.test(label))) continue;
    if (label.length < bestLen || (label.length === bestLen && best && best.contains(el))) { best = el; bestLen = label.length; }
  }
  return best;
}`;

const TEXT_JS = `(() => {
  const root = document.querySelector('#idv-modal-container') || document.body;
  return (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600);
})()`;

/** Finds an element in any frame of the page (main frame first). */
async function findInPage(page: Page, re: string, not = '', mode = 'text'): Promise<{ el: Handle; frame: Frame } | undefined> {
  for (const frame of page.frames()) {
    try {
      const h = await frame.evaluateHandle(`(${FIND_JS})(${JSON.stringify(re)}, ${JSON.stringify(not)}, ${JSON.stringify(mode)})`);
      const el = h.asElement() as Handle | null;
      if (el) return { el, frame };
      await h.dispose();
    } catch {
      /* frame detached or cross-origin without access */
    }
  }
  return undefined;
}

// In-page helpers as Function objects (the server's TypeScript has no DOM library; puppeteer serialises them).
type ElFn = (e: unknown) => unknown;
const DESCRIBE_FN = Function(
  'e',
  `const r = e.getBoundingClientRect();
  const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const d = (x) => (x ? x.tagName.toLowerCase() + (x.className && typeof x.className === 'string' ? '.' + x.className.split(/\s+/).slice(0, 2).join('.') : '') : 'none');
  return d(e) + ' "' + (e.innerText || '').replace(/\s+/g, ' ').slice(0, 40) + '" at ' + Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) + ' top=' + d(under) + (under && under !== e && !e.contains(under) && !under.contains(e) ? ' (COVERED)' : '');`,
) as ElFn;
const SCROLL_FN = Function('e', "e.scrollIntoView({ block: 'center' });") as ElFn;
const FOCUS_FN = Function('e', 'e.tabIndex = e.tabIndex || 0; e.focus();') as ElFn;
const DOM_CLICK_FN = Function(
  'e',
  `let n = e;
  for (let i = 0; n && i < 6; i++, n = n.parentElement) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) n.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window }));
  }`,
) as ElFn;

async function describe(el: Handle): Promise<string> {
  return el.evaluate(DESCRIBE_FN).then(String, () => '?');
}

async function scanVerifyDialog(page: Page): Promise<VerifyView | undefined> {
  try {
    const frames = page.frames();
    let text = '';
    for (const f of frames) {
      const t = String(await f.evaluate(TEXT_JS).catch(() => ''));
      if (t && !text.includes(t.slice(0, 60))) text += (text ? ' | ' : '') + t;
    }
    const input = Boolean(await findInPage(page, '', '', 'input'));
    return { text: text.slice(0, 600), input, frames: frames.length };
  } catch {
    return undefined;
  }
}

/**
 * Activates a row/button of TikTok's dialog. Attempt 1 is a normal click on its centre; if the dialog
 * does not change, later attempts escalate (touch tap, focus + Enter, DOM click on the element and its
 * ancestors) because TikTok's rows have reacted to different event kinds over time.
 */
async function activate(page: Page, el: Handle, attempt: number, log: (m: string) => void, what: string): Promise<void> {
  const how = attempt % 4;
  log(`verification: ${what} (try ${attempt}, ${['click', 'touch tap', 'focus+Enter', 'DOM click'][how]}) on ${await describe(el)}`);
  try {
    await el.evaluate(SCROLL_FN);
    const box = await el.boundingBox();
    if (how === 0 || !box) {
      await el.hover();
      await new Promise((r) => setTimeout(r, 80));
      await el.click({ delay: 60 });
    } else if (how === 1) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else if (how === 2) {
      await el.evaluate(FOCUS_FN);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
    } else {
      await el.evaluate(DOM_CLICK_FN);
    }
  } catch (e) {
    log('verification: activation failed: ' + (e as Error).message.split('\n')[0]);
  }
}

/**
 * Moves TikTok's "Verify it's really you" dialog along without the user: picks the Email method (never
 * Password), presses "Send code" when the dialog offers it, and reports the step/text for the UI.
 */
async function driveVerifyDialog(page: Page, log: (m: string) => void): Promise<void> {
  if (Date.now() - (s.qrTicketRetryAt || 0) < 8000) return; // a saved ticket is being tried first
  // No "no code entered" timeout here: the e-mailed code stays valid for hours, and the page, the dialog
  // and the token are held (VERIFY_HOLD_MS) until the user enters it, cancels, or starts over.
  const v = await scanVerifyDialog(page);
  if (!v) return;
  if (v.text && v.text !== s.qrVerifyText) {
    s.qrVerifyText = v.text;
    log(`verification dialog (${v.frames} frame${v.frames === 1 ? '' : 's'}): ` + v.text.slice(0, 240));
  }
  const now = Date.now();
  if (v.input) {
    // A code field is on screen. Press "Send code" ONCE if TikTok shows such a button - never again by
    // itself: every press makes TikTok issue a new code and the one in the user's inbox goes stale.
    if (s.qrVerifyStep !== 'code') log('verification: code field is up');
    s.qrVerifyStep = 'code';
    s.qrVerifyTries = 0;
    if (!s.qrCodeSentAt) {
      const send = await findInPage(page, '^(send|get) (the )?code$|^send$', 'resend');
      if (send) {
        s.qrCodeSentAt = now;
        s.qrVerifySentAt = now;
        await activate(page, send.el, 0, log, 'pressing "Send code"');
      } else s.qrCodeSentAt = s.qrVerifySentAt || now; // TikTok sent the code when the method was chosen
    }
    if (s.qrVerifyResult?.state === 'checking') checkCodeOutcome(v.text, log);
    // A code saved earlier (TikTok re-sends the same one for hours): type it without waiting for the user.
    const saved = loadVerifyStore().code;
    if (saved && !s.qrVerifyResult && !s.qrAutoCodeAt && now - (s.qrCodeSentAt || now) > 1500) {
      s.qrAutoCodeAt = now;
      s.qrNotice = `Trying the code you entered earlier (ends in ${saved.value.slice(-2)}) by itself…`;
      s.qrNoticeAt = now;
      log('verification: typing the remembered code automatically');
      await enterVerifyCode(page, saved.value, log);
    }
    return;
  }
  if (s.qrVerifyResult?.state === 'checking') checkCodeOutcome(v.text, log);
  if (now - (s.qrVerifyAutoAt || 0) < 5000) return; // give the dialog time to change after an activation
  // The Email row (label + masked address) first, the bare word as fallback, phone/SMS after that.
  const email = (await findInPage(page, '\\bemail\\b.*@', 'password')) || (await findInPage(page, '\\bemail\\b|\\be-mail\\b', 'password'));
  const phone = !email ? await findInPage(page, '\\bphone\\b|\\bsms\\b|\\btext message\\b', 'password') : undefined;
  const pick = email || phone;
  if (pick) {
    const tries = (s.qrVerifyTries || 0) + 1;
    s.qrVerifyTries = tries;
    s.qrVerifyAutoAt = now;
    s.qrVerifySentAt = now;
    s.qrVerifyStep = 'sending';
    await activate(page, pick.el, tries - 1, log, `choosing ${email ? 'Email' : 'Phone'}`);
    if (tries === 8) {
      s.qrNotice = 'The server could not activate the "Email" row in TikTok\'s dialog by itself. Please tap it in the live picture.';
      s.qrNoticeAt = now;
    }
    return;
  }
  if (s.qrVerifyStep !== 'sending' || now - (s.qrVerifyAutoAt || 0) > 20_000) s.qrVerifyStep = s.qrVerifyStep === 'sending' ? 'sending' : 'choose';
}

const ENABLED_FN = Function('e', 'return !e.disabled && e.getAttribute("aria-disabled") !== "true";') as ElFn;
const VALUE_FN = Function('e', 'return String(e.value !== undefined ? e.value : e.textContent || "");') as ElFn;
const CLEAR_FN = Function('e', 'e.focus(); e.select && e.select();') as ElFn;
type ElFn2 = (e: unknown, code: string) => unknown;
/** The browser's own text insertion: fires a real "input" event that React's onChange accepts. */
const INSERT_TEXT_FN = Function(
  'e',
  'code',
  `e.focus();
  if (e.select) e.select();
  const ok = document.execCommand && document.execCommand('insertText', false, code);
  return (ok ? 'exec:' : 'noexec:') + e.value;`,
) as ElFn2;
/** Controlled-input trick: set the value through the native setter, then dispatch input + change. */
const REACT_SET_FN = Function(
  'e',
  'code',
  `e.focus();
  const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(e, code); else e.value = code;
  e.dispatchEvent(new InputEvent('input', { bubbles: true, data: code, inputType: 'insertText' }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return e.value;`,
) as ElFn2;
/** The focused element (through shadow roots) and what it holds: "INPUT:123456" */
const ACTIVE_JS = `(() => {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body) return 'none';
  return a.tagName + (a.className && typeof a.className === 'string' ? '.' + a.className.split(/\\s+/).slice(0, 2).join('.') : '') + ':' + String(a.value !== undefined ? a.value : a.textContent || '').slice(0, 20);
})()`;
/** Count of inputs per frame, incl. shadow roots (diagnostics) */
const COUNT_JS = `(() => {
  let n = 0, vis = 0;
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'INPUT' || el.isContentEditable) { n++; const r = el.getBoundingClientRect(); if (r.width > 4 && r.height > 4) vis++; } if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  return n + '/' + vis;
})()`;

async function activeField(page: Page): Promise<string> {
  for (const f of page.frames()) {
    const a = String(await f.evaluate(ACTIVE_JS).catch(() => 'none'));
    if (a !== 'none') return a;
  }
  return 'none';
}

/**
 * Types the code into TikTok's code field and READS IT BACK (the field, or whatever has focus, has to
 * hold exactly the code). Ways tried: click + type, focus + select-all + type, tap + type, and a click
 * at the field's place on screen (just above "Resend code") + type, for fields the DOM search misses.
 * Returns '' on success, else a diagnosis for the UI/log.
 */
async function typeVerifyCode(page: Page, code: string, log: (m: string) => void): Promise<string> {
  const diag: string[] = [];
  const counts: string[] = [];
  for (const f of page.frames()) counts.push(String(await f.evaluate(COUNT_JS).catch(() => '?')));
  diag.push(`inputs per frame ${counts.join(',')}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const input = attempt < 3 ? await findInPage(page, '', '', 'input') : undefined;
    if (attempt < 3 && !input) {
      diag.push(`try ${attempt + 1}: no code field in the DOM`);
      continue;
    }
    try {
      if (attempt === 0 && input) {
        diag.push('field ' + (await describe(input.el)));
        await input.el.evaluate(SCROLL_FN);
        await input.el.click({ clickCount: 3, delay: 20 });
        await page.keyboard.press('Backspace');
        await input.el.type(code, { delay: 60 });
      } else if (attempt === 1 && input) {
        // Keystrokes reached the field but its value snapped back to "" (a React-controlled input
        // whose onChange did not take them): insert the text the way the browser itself does.
        await input.el.evaluate(CLEAR_FN);
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        diag.push('try 2: insertText → ' + String(await input.el.evaluate(INSERT_TEXT_FN, code)));
      } else if (attempt === 2 && input) {
        diag.push('try 3: native setter + input event → ' + String(await input.el.evaluate(REACT_SET_FN, code)));
      } else {
        // Geometry: TikTok's field sits right above its "Resend code" link, full dialog width.
        const resend = await findInPage(page, '^resend( code)?$');
        const box = resend ? await resend.el.boundingBox() : null;
        if (!box) {
          diag.push('try 4: no "Resend code" link to aim from');
          continue;
        }
        const x = box.x + Math.max(60, box.width / 2);
        const y = box.y - 40;
        diag.push(`try 4: click at ${Math.round(x)},${Math.round(y)} above "Resend code"`);
        await page.mouse.click(x, y, { delay: 40 });
        await new Promise((r) => setTimeout(r, 150));
        for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
        await page.keyboard.type(code, { delay: 80 });
        await new Promise((r) => setTimeout(r, 300));
        if (!(await activeField(page)).endsWith(':' + code)) await page.evaluate(`document.execCommand('insertText', false, ${JSON.stringify(code)})`).catch(() => undefined);
      }
    } catch (e) {
      diag.push(`try ${attempt + 1} threw: ` + (e as Error).message.split('\n')[0].slice(0, 80));
    }
    await new Promise((r) => setTimeout(r, 350));
    const val = input ? String(await input.el.evaluate(VALUE_FN).catch(() => '?')) : '';
    const active = await activeField(page);
    if (val === code || active.endsWith(':' + code)) {
      log(`verification: code typed (try ${attempt + 1}; field="${val}", focus=${active})`);
      return '';
    }
    diag.push(`try ${attempt + 1}: field="${val}" focus=${active}`);
  }
  const text = diag.join(' | ');
  log('verification: typing failed - ' + text);
  return text;
}

/** Puts a verification code into TikTok's code field and submits it (Next/Verify button, else Enter). */
async function enterVerifyCode(page: Page, code: string, log: (m: string) => void): Promise<void> {
  s.qrTextBeforeCode = (await scanVerifyDialog(page))?.text || s.qrVerifyText || '';
  s.qrVerifyResult = { state: 'checking', at: Date.now() };
  const problem = await typeVerifyCode(page, code, log);
  if (problem) {
    s.qrVerifyResult = { state: 'unknown', text: "The code could not be typed into TikTok's field on the server. Details: " + problem.slice(0, 400), at: Date.now() };
    await captureShot(page);
    return;
  }
  // TikTok enables its button once the code is complete; give it a moment, then press it (or Enter).
  let submit: { el: Handle } | undefined;
  for (let i = 0; i < 8 && !submit; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const b = await findInPage(page, '^(verify|continue|next|submit|confirm|done|log in|login)\\b', 'resend');
    if (b && (await b.el.evaluate(ENABLED_FN).catch(() => true))) submit = b;
  }
  if (submit) {
    log('verification: pressing ' + (await describe(submit.el)));
    await submit.el.click({ delay: 30 }).catch(() => undefined);
  } else {
    log('verification: no enabled Next/Verify button - pressing Enter');
    await page.keyboard.press('Enter').catch(() => undefined);
  }
  // If the field still shows the code 2 s later, the press did nothing: Enter inside the field as well.
  await new Promise((r) => setTimeout(r, 2000));
  const still = await findInPage(page, '', '', 'input');
  if (still && String(await still.el.evaluate(VALUE_FN).catch(() => '')) === code) {
    log('verification: dialog unchanged after the press - pressing Enter in the field');
    await still.el.evaluate(FOCUS_FN).catch(() => undefined);
    await page.keyboard.press('Enter').catch(() => undefined);
  }
}

/** After a code was submitted: did TikTok accept it (ticket seen) or complain in the dialog? */
function checkCodeOutcome(text: string, log: (m: string) => void): void {
  const r = s.qrVerifyResult;
  if (!r || r.state !== 'checking') return;
  if (s.qrTicket && (s.qrTicketAt || 0) >= r.at) {
    s.qrVerifyResult = { state: 'accepted', at: Date.now() };
    return;
  }
  const before = s.qrTextBeforeCode || '';
  const fresh = text.split(/(?<=[.!?])\s+|\s*\|\s*/).filter((sn) => sn.length > 3 && !before.includes(sn));
  const bad = fresh.find((sn) => /incorrect|invalid|wrong|not (correct|valid|match)|doesn.t match|expired|try again|too many|limit/i.test(sn));
  if (bad) {
    s.qrVerifyResult = { state: 'rejected', text: bad.slice(0, 160), at: Date.now() };
    log('verification: TikTok rejected the code: ' + bad.slice(0, 160));
    if (s.qrAutoCodeAt && s.qrAutoCodeAt >= r.at - 1000) {
      saveVerifyStore({ code: undefined });
      s.qrNotice = 'The code from earlier is no longer accepted - enter the one from the newest e-mail.';
      s.qrNoticeAt = Date.now();
    }
    return;
  }
  if (Date.now() - r.at > 25_000) {
    s.qrVerifyResult = { state: 'unknown', at: Date.now() };
    log('verification: no answer seen 25 s after the code was submitted');
  }
}

let inputChain: Promise<void> = Promise.resolve();

/**
 * Forwards one user input to the headless login page (TikTok's verification modal lives there) and
 * answers with a fresh screenshot. Inputs are serialised so a drag is not interleaved with a click.
 */
export async function sessionInput(req: SessionInputRequest): Promise<SessionStatus> {
  const page = s.qrPage;
  if (!page || page.isClosed() || s.state !== 'login_pending' || s.loginMode !== 'qr') throw new Error('No QR sign-in page is open.');
  const clamp = (v: unknown, max: number): number => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const run = async (): Promise<void> => {
    switch (req.type) {
      case 'click':
        await page.mouse.click(clamp(req.x, QR_VIEWPORT.width), clamp(req.y, QR_VIEWPORT.height), { delay: 40 });
        break;
      case 'drag': {
        // Slider captchas want a human-looking drag: several moves, not one jump.
        const x1 = clamp(req.x, QR_VIEWPORT.width);
        const y1 = clamp(req.y, QR_VIEWPORT.height);
        const x2 = clamp(req.x2, QR_VIEWPORT.width);
        const y2 = clamp(req.y2, QR_VIEWPORT.height);
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
          await new Promise((r) => setTimeout(r, 25));
        }
        await page.mouse.up();
        break;
      }
      case 'type':
        await page.keyboard.type(String(req.text || '').slice(0, 200), { delay: 35 });
        break;
      case 'key':
        if (['Enter', 'Backspace', 'Tab', 'Escape'].includes(req.key)) await page.keyboard.press(req.key);
        break;
      case 'code': {
        const code = String(req.code || '').replace(/\s+/g, '').slice(0, 12);
        if (code) {
          feedLog?.(`verification: entering the ${code.length}-digit code`);
          saveVerifyStore({ code: { value: code, at: Date.now() } });
          await enterVerifyCode(page, code, (m) => feedLog?.(m));
        }
        break;
      }
      case 'resend': {
        // The user asks for the e-mail again: press TikTok's "Resend"/"Send code" (once a minute).
        if (Date.now() - (s.qrResendAt || 0) < 60_000) break;
        const btn = (await findInPage(page, '^resend( code)?$|^send( the)? code( again)?$|^send$')) || (await findInPage(page, 'resend|send again'));
        if (btn) {
          s.qrResendAt = Date.now();
          s.qrCodeSentAt = Date.now();
          s.qrVerifyResult = undefined;
          await activate(page, btn.el, 0, (m) => feedLog?.(m), 'pressing "Resend"');
        } else feedLog?.('verification: no Resend button on the page');
        break;
      }
      case 'shot':
      default:
        break;
    }
    await new Promise((r) => setTimeout(r, req.type === 'shot' ? 0 : req.type === 'code' ? 1200 : 350));
    await captureShot(page);
  };
  const job = inputChain.then(run, run);
  inputChain = job.catch(() => undefined);
  await job;
  return sessionStatus();
}

async function qrLoop(page: Page, browser: Browser, log: (m: string) => void): Promise<void> {
  let lastReload = Date.now();
  let lastShotAt = 0;
  let misses = 0;
  let confirmingNavigated = false;
  try {
    while (s.qrPage === page) {
      // 10 minutes to scan; once TikTok asks for a verification the attempt is held for VERIFY_HOLD_MS.
      const inVerify = (s.qrState as string) === 'verify';
      const deadline = inVerify ? (s.qrCodeSentAt || s.qrVerifyAt || Date.now()) + VERIFY_HOLD_MS : (s.loginStartedAt || 0) + LOGIN_TIMEOUT_MS;
      if (Date.now() > deadline) break;
      if (!browser.isConnected() || page.isClosed()) break;
      // --- TikTok's page drives the cycle (one poll stream = no extra rate-limit pressure). We only
      //     react: when its code expired, click the code area (TikTok's refresh) and wait for the new one.
      const verifying = (s.qrState as string) === 'verify';
      const confirming = verifying || ((s.qrState as string) === 'scanned' && Date.now() - (s.scannedAt || 0) < 120_000);
      const expiredNow = (s.qrState as string) === 'expired' || (s.qrExpireAt ? Date.now() > s.qrExpireAt + 1500 : false);
      if (s.qrRedirect && !confirmingNavigated) {
        // TikTok confirmed the scan and told the page where to go; follow it ourselves in case the page
        // (CPU-starved on a small VM) has not done so. That URL sets the session cookies.
        confirmingNavigated = true;
        log('QR confirmed - following the TikTok redirect to finish the sign-in');
        await page.goto(s.qrRedirect, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      }
      if (s.qr && expiredNow && !s.qrRateLimitedAt && !confirming) {
        const before = s.qr;
        s.qr = undefined;
        s.qrExpireAt = undefined;
        s.qrState = 'new';
        const clicked = await page
          .click('[data-e2e="qr-code"]', { delay: 30 })
          .then(() => true)
          .catch(() => false);
        for (let i = 0; clicked && i < 30 && !s.qr; i++) await new Promise((r) => setTimeout(r, 500));
        if (s.qr && s.qr !== before) log('QR expired - TikTok refreshed it in place');
        else if (s.qrGetUrl && (await requestNewQr(page, log))) log('QR expired - requested a new one in page');
        else {
          log('QR expired - reloading the login page');
          await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
          lastReload = Date.now();
        }
      } else if (!s.qr && s.qrGetUrl && !s.qrRateLimitedAt && misses >= 20 && !verifying) {
        // No code for ~40 s although the page is up: ask TikTok directly (signed by the page).
        if (await requestNewQr(page, log)) misses = 0;
      }
      if (s.qrRateLimitedAt && Date.now() - s.qrRateLimitedAt > 120_000) s.qrRateLimitedAt = undefined;
      if (await hasSessionCookie(page).catch(() => false)) {
        const acc = await fetchAccount(page);
        if (acc.ok) {
          markLoggedIn(acc);
          log(`signed in as @${acc.username} (QR)`);
          s.qrPage = undefined;
          await page.close().catch(() => undefined);
          await resetFeedPage();
          return;
        }
      }
      const text = String(await page.evaluate('document.body.innerText').catch(() => '')).toLowerCase();
      // Reload for a fresh QR only when TikTok says the current one expired (or it is past the expiry
      // it announced). Never while a scan is being confirmed: a reload there threw the login away.
      const scanning = verifying || ((s.qrState as string) === 'scanned' && Date.now() - (s.scannedAt || 0) < 90_000);
      // Refresh a little BEFORE TikTok's expiry (codes live ~55 s; a reload on a small VM takes as long),
      // so there is always a scannable code on screen.
      const expired = !s.qrGetUrl && !s.qr && ((s.qrState as string) === 'expired' || /expired|refresh/.test(text) || Date.now() - lastReload > QR_RELOAD_MS);
      if (!scanning && expired) {
        s.qr = undefined;
        s.qrExpireAt = undefined;
        s.scannedAt = undefined;
        s.qrState = 'new';
        // TikTok's page shows an "expired, tap to refresh" overlay on the QR; a click on it asks for a
        // new code without reloading (faster, keeps the session). Reload only if that brings nothing.
        const clicked = await page
          .click('[data-e2e="qr-code"]', { delay: 30 })
          .then(() => true)
          .catch(() => false);
        let fresh = false;
        for (let i = 0; clicked && i < 8 && !fresh; i++) {
          await new Promise((r) => setTimeout(r, 500));
          fresh = Boolean(s.qr);
        }
        if (fresh) log('QR expired - refreshed in place');
        else {
          log('QR expired - loading a fresh one');
          await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
          lastReload = Date.now();
        }
      } else if (/confirm|scanned/.test(text) && !/1\. scan with/.test(text) && !verifying) {
        s.qrState = 'scanned';
        s.scannedAt = s.scannedAt || Date.now();
      }
      if (verifying) {
        // Drive TikTok's verification dialog as far as possible (choose Email, press "Send code"),
        // and keep a live view for the UI, where the user enters the code.
        await driveVerifyDialog(page, log);
        if (Date.now() - lastShotAt > 1200) {
          await captureShot(page);
          lastShotAt = Date.now();
        }
        misses = 0;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      const qr = s.qr && (s.qrState as string) !== 'expired' ? undefined : await captureQr(page);
      if (s.qr && !qr) {
        misses = 0;
      } else if (qr) {
        s.qr = qr;
        s.qrPageHint = undefined;
        s.qrPageShot = undefined;
        misses = 0;
      } else if (++misses === 12 || misses % 30 === 0) {
        // No QR canvas: tell the UI (and the log) what TikTok served instead (captcha, error page, ...)
        const title = String(await page.title().catch(() => ''));
        const body = text.replace(/\s+/g, ' ').trim().slice(0, 160);
        s.qrPageHint = (`${title}${body ? ' – ' + body : ''}`.slice(0, 160) || `${page.url()} (empty page)`) + (s.qrApi ? ` | QR API: ${s.qrApi.slice(0, 200)}` : ' | QR API: no answer seen');
        log(`QR page shows no QR code: ${s.qrPageHint}`);
        await captureShot(page);
        if (misses % 30 === 0) {
          await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
          lastReload = Date.now();
        }
      }
      await new Promise((r) => setTimeout(r, (s.qrState as string) === 'scanned' ? 700 : 1500));
    }
    if (s.qrPage === page && s.state === 'login_pending') {
      s.state = 'none';
      s.error = (s.qrState as string) === 'verify' ? 'The verification was not completed within 48 hours; sign in again.' : 'QR sign-in timed out after 10 minutes.';
      s.qr = undefined;
      s.qrPage = undefined;
      await page.close().catch(() => undefined);
    }
  } catch (e) {
    if (s.qrPage === page) {
      s.state = 'error';
      s.error = (e as Error).message;
      s.qrPage = undefined;
    }
  }
}

// ---------------------------------------------------------------- window sign-in (needs a desktop)
async function startWindowLogin(log: (m: string) => void): Promise<SessionStatus> {
  await closeHeadless();
  s.state = 'login_pending';
  s.loginMode = 'window';
  s.error = undefined;
  s.loginStartedAt = Date.now();
  const browser = await launch(false);
  s.loginBrowser = browser;
  const page = (await browser.pages())[0] || (await browser.newPage());
  browser.on('disconnected', () => {
    if (s.loginBrowser === browser) {
      s.loginBrowser = undefined;
      if (s.state === 'login_pending') {
        s.state = 'none';
        s.error = 'The sign-in window was closed before TikTok reported a session.';
      }
    }
  });
  await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  log('sign-in window opened');
  // Poll for the session cookie, then confirm with account/info, then close the window.
  void (async () => {
    try {
      while (s.loginBrowser === browser && Date.now() - (s.loginStartedAt || 0) < LOGIN_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!browser.isConnected()) return;
        const p = (await browser.pages())[0];
        if (!p) continue;
        if (!(await hasSessionCookie(p).catch(() => false))) continue;
        const acc = await fetchAccount(p);
        if (!acc.ok) continue;
        markLoggedIn(acc);
        log(`signed in as @${acc.username} (window)`);
        s.loginBrowser = undefined;
        await browser.close().catch(() => undefined);
        return;
      }
      if (s.state === 'login_pending') {
        s.state = 'none';
        s.error = 'Sign-in timed out after 10 minutes.';
        s.loginBrowser = undefined;
        await browser.close().catch(() => undefined);
      }
    } catch (e) {
      s.state = 'error';
      s.error = (e as Error).message;
    }
  })();
  return sessionStatus();
}

// ---------------------------------------------------------------- headless browser + feed page
let headlessLaunch: Promise<Browser> | undefined;

/**
 * One shared headless browser. Concurrent callers (the saved-profile probe, an explore request and
 * a QR login can all arrive within the same second after a restart) wait for the same launch:
 * two launches on one profile directory fail with "Failed to launch the browser process" (profile
 * lock) - observed on the Google Cloud VM 2026-10-08.
 */
async function headlessBrowser(): Promise<Browser> {
  if (s.headless?.isConnected()) return s.headless;
  if (headlessLaunch) return headlessLaunch;
  headlessLaunch = (async () => {
    try {
      await closeHeadless();
      feedLog?.('launching headless browser');
      const browser = await launch(true);
      feedLog?.('headless browser launched: ' + (await browser.version()));
      s.headless = browser;
      browser.on('disconnected', () => {
        if (s.headless === browser) {
          s.headless = undefined;
          s.feedPage = undefined;
          s.qrPage = undefined;
          s.explorePage = undefined;
        }
      });
      return browser;
    } finally {
      headlessLaunch = undefined;
    }
  })();
  return headlessLaunch;
}

async function closeHeadless(): Promise<void> {
  const b = s.headless;
  s.headless = undefined;
  s.feedPage = undefined;
  s.qrPage = undefined;
  s.explorePage = undefined;
  if (b) await b.close().catch(() => undefined);
}

/** After a sign-in: drop guest items and make the feed page reload as the signed-in account. */
async function resetFeedPage(): Promise<void> {
  s.pending = [];
  s.seenIds = new Set();
  s.lastFeedError = undefined;
  const p = s.feedPage;
  s.feedPage = undefined;
  if (p && !p.isClosed()) await p.close().catch(() => undefined);
}

/** The headless page that stays on /foryou; feed responses are captured as they happen. */
let feedPageOpening: Promise<Page> | undefined;

async function feedPage(): Promise<Page> {
  if (s.feedPage && !s.feedPage.isClosed() && s.headless?.isConnected()) return s.feedPage;
  if (feedPageOpening) return feedPageOpening;
  feedPageOpening = openFeedPage().finally(() => {
    feedPageOpening = undefined;
  });
  return feedPageOpening;
}

async function openFeedPage(): Promise<Page> {
  const browser = await headlessBrowser();
  const first = (await browser.pages())[0];
  const page = first && !s.qrPage && first.url() === 'about:blank' ? first : await browser.newPage();
  await preparePage(page, browser);
  page.on('response', (res) => {
    if (!/\/api\/recommend\/item_list\//.test(res.url())) return;
    void res
      .json()
      .then((json: any) => {
        const list: any[] = Array.isArray(json?.itemList) ? json.itemList : [];
        let added = 0;
        for (const raw of list) {
          const it = itemToFeedItem(raw, s.feedCookieHeader ? { cookieHeader: s.feedCookieHeader, referer: FEED_URL } : undefined);
          if (it && !s.seenIds.has(it.id)) {
            s.seenIds.add(it.id);
            s.pending.push(it);
            added++;
          }
        }
        if (!list.length) s.lastFeedError = `recommend/item_list answered without items (${JSON.stringify(json).slice(0, 120)})`;
        else s.lastFeedError = undefined;
        if (added) feedLog?.(`captured ${added} new For You item(s) (${s.pending.length} pending)`);
      })
      .catch(() => undefined);
  });
  s.feedPage = page;
  feedLog?.('headless feed page: opening ' + FEED_URL);
  await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  feedLog?.('headless feed page: loaded "' + (await page.title()) + '"');
  const cookies = await page.cookies('https://www.tiktok.com');
  s.feedCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return page;
}

/**
 * Explore feed fetched from inside a headless page on tiktok.com/explore. The page's own scripts
 * sign the request (msToken / X-Bogus / X-Gnarly), which is what TikTok wants from datacenter IPs:
 * observed 2026-10-08 on a Google Cloud VM, the plain HTTP explore request got an empty body
 * two times out of three while the browser path answered. Needs no sign-in.
 */
/** Closes the explore and feed pages (kept the browser). */
async function closeSecondaryPages(): Promise<void> {
  for (const key of ['explorePage', 'feedPage'] as const) {
    const pg = s[key];
    s[key] = undefined;
    if (pg && !pg.isClosed()) await pg.close().catch(() => undefined);
  }
  s.pending = [];
  s.seenIds = new Set();
}

export async function fetchExploreViaBrowser(category: number, count: number, log: (m: string) => void): Promise<ExploreResult> {
  feedLog = feedLog || wrapLog(log);
  if (!sessionSupported().ok) throw new Error(sessionSupported().reason);
  if (s.qrPage && !s.qrPage.isClosed()) throw new Error('A QR sign-in is in progress; the browser is reserved for it for the moment');
  const browser = await headlessBrowser();
  let page = s.explorePage;
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await preparePage(page, browser);
    await page.goto('https://www.tiktok.com/explore', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    s.explorePage = page;
    log('headless explore page opened');
  }
  const url = exploreApiUrl(category, count);
  const text = String(await page.evaluate(`fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => r.text())`));
  if (!text.trim()) throw new Error('TikTok explore API returned an empty body (through the browser as well)');
  const cookies = await page.cookies('https://www.tiktok.com');
  const warnings: string[] = [];
  const parsed = parseExploreBody(text, { cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '), referer: 'https://www.tiktok.com/explore' }, warnings);
  log(`explore via browser, category ${category}: ${parsed.items.length}/${parsed.raw} items`);
  return { ...parsed, warnings };
}

/**
 * Cancels a pending sign-in and forgets everything about it (token, ticket, dialog, notices), so the
 * next "Sign in" starts the whole process from zero. Keeps the headless browser (slow to relaunch).
 */
export async function cancelLogin(): Promise<SessionStatus> {
  const lb = s.loginBrowser;
  s.loginBrowser = undefined;
  if (lb) await lb.close().catch(() => undefined);
  const page = s.qrPage;
  s.qrPage = undefined;
  if (page && !page.isClosed()) await page.close().catch(() => undefined);
  if (s.state === 'login_pending') s.state = 'none';
  s.error = undefined;
  s.loginMode = undefined;
  s.qr = s.qrState = s.qrPageHint = s.qrPageShot = s.qrToken = s.qrGetUrl = s.qrCheckUrl = s.qrRedirect = undefined;
  s.qrExpireAt = s.scannedAt = s.qrVerifyAt = s.qrVerifyAutoAt = s.qrVerifySentAt = s.qrVerifyTries = undefined;
  s.qrVerifyConf = s.qrVerifyStep = s.qrVerifyText = s.qrNotice = s.qrTextBeforeCode = undefined;
  s.qrNoticeAt = s.qrCodeSentAt = s.qrAutoCodeAt = s.qrResendAt = s.qrTicketRetryAt = undefined;
  s.qrTicketTriedToken = undefined;
  s.qrVerifyResult = undefined;
  feedLog?.('sign-in cancelled by the user');
  probed = true;
  return sessionStatus();
}

export async function logout(): Promise<SessionStatus> {
  const lb = s.loginBrowser;
  s.loginBrowser = undefined;
  if (lb) await lb.close().catch(() => undefined);
  await closeHeadless();
  s.state = 'none';
  s.username = s.nickname = s.avatar = s.error = s.qr = s.qrState = s.loginMode = undefined;
  s.pending = [];
  s.seenIds = new Set();
  probed = true;
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch (e) {
    s.error = `Profile directory could not be deleted: ${(e as Error).message}`;
  }
  return sessionStatus();
}

export interface ForYouResult {
  items: FeedItem[];
  warnings: string[];
}

/**
 * Returns up to `count` not-yet-delivered items from the signed-in For You feed, nudging the page
 * (scroll + ArrowDown) until TikTok loads more, for at most ~12 s.
 */
export async function fetchForYou(count: number, log: (m: string) => void): Promise<ForYouResult> {
  feedLog = wrapLog(log);
  const warnings: string[] = [];
  if (!sessionSupported().ok) throw new Error(sessionSupported().reason);
  // FORYOU_ALLOW_GUEST=1 lets the headless page run signed-out (TikTok's guest feed: a few videos,
  // then a login wall) – for testing the capture mechanism only.
  if (s.state !== 'logged_in' && !guestAllowed()) {
    await sessionProbe(true);
    if ((s.state as SessionStatus['state']) !== 'logged_in') throw new Error(s.error ? `Not signed in (${s.error})` : 'Not signed in to TikTok. Use "Sign in" first.');
  }
  const page = await feedPage();
  const deadline = Date.now() + 12_000;
  // Return early with a partial batch: the viewer prefetches ahead, so latency matters more than size.
  const enough = Math.min(count, 4);
  let nudges = 0;
  while (s.pending.length < enough && Date.now() < deadline) {
    if (nudges > 0 || s.pending.length === 0) {
      // TikTok's feed loads the next batch when the reader approaches the end of the loaded list.
      await page
        .evaluate(`(() => { const el = document.scrollingElement || document.body; el.scrollTop = el.scrollHeight; window.dispatchEvent(new Event('scroll')); })()`)
        .catch(() => undefined);
      await page.keyboard.press('ArrowDown').catch(() => undefined);
    }
    nudges++;
    await new Promise((r) => setTimeout(r, 600));
    if (s.lastFeedError && nudges > 6) break;
  }
  if (!s.pending.length) {
    // Maybe the page is stuck on a dialog or the session expired: reload once.
    const acc = await fetchAccount(page);
    if (!acc.ok && s.state === 'logged_in') {
      s.state = 'none';
      s.error = `TikTok session is no longer valid (${acc.error}). Sign in again.`;
      throw new Error(s.error);
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 4000));
    if (!s.pending.length) warnings.push(s.lastFeedError || 'TikTok did not deliver feed items; try again in a moment.');
  }
  const items = s.pending.splice(0, count);
  return { items, warnings };
}

export function profileDir(): string {
  return PROFILE_DIR;
}

/** Closes every browser this process started (process shutdown). The profile stays on disk. */
export async function shutdownBrowsers(): Promise<void> {
  const lb = s.loginBrowser;
  s.loginBrowser = undefined;
  if (lb) await lb.close().catch(() => undefined);
  await closeHeadless();
}
