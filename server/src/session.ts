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
import type { FeedItem, LoginMode, SessionStatus } from '../../shared/types';
import { exploreApiUrl, itemToFeedItem, parseExploreBody, type ExploreResult } from './feed';

type Browser = import('puppeteer-core').Browser;
type Page = import('puppeteer-core').Page;

/**
 * Outside the repository on purpose: Chrome writes to the profile constantly and `tsx watch`
 * (npm run dev) restarts the server on every change inside server/ (observed: the API froze).
 */
const PROFILE_DIR = process.env.TIKTOK_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'tiktok-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const QR_RELOAD_MS = 110 * 1000;
const FEED_URL = 'https://www.tiktok.com/foryou';
const QR_URL = 'https://www.tiktok.com/login/qrcode';
const QR_SELECTOR = '[data-e2e="qr-code"] canvas';

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
    if (t === 'media' || t === 'font' || t === 'image' || /mime_type=video|\.mp4(\?|$)/.test(req.url())) req.abort().catch(() => undefined);
    else req.continue().catch(() => undefined);
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
  if (s.state === 'none') base.message = profileExists() ? 'A saved browser profile exists; checking it on first use.' : 'Not signed in.';
  if (s.state === 'login_pending') {
    base.loginMode = s.loginMode;
    if (s.loginMode === 'qr') {
      base.qr = s.qr;
      base.qrState = s.qrState;
      if (s.qr && s.qrExpireAt) base.qrExpiresAt = s.qrExpireAt;
      if (!s.qr && s.qrPageShot) base.pageShot = s.qrPageShot;
      base.message = s.qrState === 'scanned' ? 'Scanned – confirm the sign-in in the TikTok app.' : s.qr ? 'Scan the QR code with the TikTok app.' : s.qrPageHint ? `TikTok did not show a QR code. The page says: ${s.qrPageHint}` : 'Loading the QR code…';
    } else base.message = 'Finish signing in inside the TikTok window that opened on the server machine.';
  }
  if (s.state === 'logged_in') base.message = `Signed in as @${s.username || '?'}`;
  return base;
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

export async function startLogin(mode: LoginMode, log: (m: string) => void): Promise<SessionStatus> {
  if (s.state === 'login_pending' && (s.loginBrowser || s.qrPage)) return sessionStatus();
  if (probe) await probe.catch(() => undefined);
  probed = true;
  feedLog = feedLog || log;
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
  s.qrState = 'new';
  s.loginStartedAt = Date.now();
  const browser = await headlessBrowser();
  // An e2-micro cannot run three TikTok tabs: close the feed/explore pages while the QR is pending.
  await closeSecondaryPages();
  const page = await browser.newPage();
  await preparePage(page, browser);
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
        let json: any;
        try {
          json = JSON.parse(body);
        } catch {
          log('QR API (not JSON): ' + s.qrApi);
          return;
        }
        const d = json?.data || {};
        if (typeof d.qrcode === 'string' && d.qrcode.length > 100 && s.qrPage === page) {
          s.qr = 'data:image/png;base64,' + d.qrcode;
          s.qrState = 'new';
          s.qrPageHint = undefined;
          s.qrPageShot = undefined;
          s.scannedAt = undefined;
          s.qrExpireAt = typeof d.expire_time === 'number' && d.expire_time > 1e9 ? d.expire_time * 1000 : Date.now() + 110_000;
          log(`QR code received from TikTok's API (${d.qrcode.length} chars, valid ${Math.round((s.qrExpireAt - Date.now()) / 1000)} s)`);
        } else if (typeof d.status === 'string') {
          if (d.status === 'scanned' || d.status === 'confirmed') {
            if (s.qrState !== 'scanned') log(`QR ${d.status} - waiting for TikTok to finish the sign-in`);
            s.qrState = 'scanned';
            s.scannedAt = s.scannedAt || Date.now();
          } else if (d.status === 'expired') s.qrState = 'expired';
        } else if (json?.message === 'error' || d.error_code) {
          log('QR API error: ' + s.qrApi);
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

async function qrLoop(page: Page, browser: Browser, log: (m: string) => void): Promise<void> {
  let lastReload = Date.now();
  let misses = 0;
  try {
    while (s.qrPage === page && Date.now() - (s.loginStartedAt || 0) < LOGIN_TIMEOUT_MS) {
      if (!browser.isConnected() || page.isClosed()) break;
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
      const scanning = (s.qrState as string) === 'scanned' && Date.now() - (s.scannedAt || 0) < 90_000;
      // Refresh a little BEFORE TikTok's expiry (codes live ~55 s; a reload on a small VM takes as long),
      // so there is always a scannable code on screen.
      const expired = (s.qrState as string) === 'expired' || /expired|refresh/.test(text) || (s.qrExpireAt ? Date.now() > s.qrExpireAt - 6000 : Date.now() - lastReload > QR_RELOAD_MS);
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
      } else if (/confirm|scanned/.test(text) && !/1\. scan with/.test(text)) {
        s.qrState = 'scanned';
        s.scannedAt = s.scannedAt || Date.now();
      }
      const qr = s.qr && (s.qrState as string) !== 'expired' ? undefined : await captureQr(page);
      if (s.qr && !qr) {
        misses = 0;
      } else if (qr) {
        s.qr = qr;
        s.qrPageHint = undefined;
        s.qrPageShot = undefined;
        misses = 0;
      } else if (++misses === 2 || misses % 30 === 0) {
        // No QR canvas: tell the UI (and the log) what TikTok served instead (captcha, error page, ...)
        const title = String(await page.title().catch(() => ''));
        const body = text.replace(/\s+/g, ' ').trim().slice(0, 160);
        s.qrPageHint = (`${title}${body ? ' – ' + body : ''}`.slice(0, 160) || `${page.url()} (empty page)`) + (s.qrApi ? ` | QR API: ${s.qrApi.slice(0, 200)}` : ' | QR API: no answer seen');
        log(`QR page shows no QR code: ${s.qrPageHint}`);
        try {
          const shot = await page.screenshot({ type: 'jpeg', quality: 45, encoding: 'base64', clip: { x: 0, y: 0, width: 900, height: 700 } });
          s.qrPageShot = `data:image/jpeg;base64,${shot}`;
        } catch {
          /* ignore */
        }
        if (misses % 30 === 0) {
          await page.goto(QR_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
          lastReload = Date.now();
        }
      }
      await new Promise((r) => setTimeout(r, (s.qrState as string) === 'scanned' ? 700 : 2000));
    }
    if (s.qrPage === page && s.state === 'login_pending') {
      s.state = 'none';
      s.error = 'QR sign-in timed out after 10 minutes.';
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
  feedLog = feedLog || log;
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
  feedLog = log;
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
