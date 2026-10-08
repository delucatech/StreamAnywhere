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
 *   POST /api/session/login   -> opens a VISIBLE browser window on https://www.tiktok.com/login
 *                                (the person signs in there; this server never sees the password),
 *                                waits for the session cookie, then closes the window.
 *   GET  /api/session         -> state + @username (checked through TikTok's account/info endpoint)
 *   POST /api/session/logout  -> closes everything and deletes the profile directory
 *   POST /api/feed {source:'foryou'} -> a headless page on /foryou; every recommend/item_list
 *                                response is captured, and "more" is requested by scrolling the page.
 *
 * The profile lives in ~/.streamanywhere/tiktok-profile (TIKTOK_PROFILE_DIR overrides). It holds
 * the TikTok cookies of the signed-in account: treat the directory like a password.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FeedItem, SessionStatus } from '../../shared/types';
import { itemToFeedItem } from './feed';

type Browser = import('puppeteer-core').Browser;
type Page = import('puppeteer-core').Page;

/**
 * Outside the repository on purpose: Chrome writes to the profile constantly and `tsx watch`
 * (npm run dev) restarts the server on every change inside server/ (observed: the API froze).
 */
const PROFILE_DIR = process.env.TIKTOK_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'tiktok-profile');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const FEED_URL = 'https://www.tiktok.com/foryou';

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
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return candidates.find((c) => fs.existsSync(c));
}

interface SessionInternal {
  state: SessionStatus['state'];
  username?: string;
  nickname?: string;
  avatar?: string;
  error?: string;
  loginBrowser?: Browser;
  loginStartedAt?: number;
  headless?: Browser;
  feedPage?: Page;
  /** Items captured from the headless /foryou page that have not been handed out yet */
  pending: FeedItem[];
  seenIds: Set<string>;
  feedCookieHeader?: string;
  lastFeedError?: string;
}

const s: SessionInternal = { state: 'none', pending: [], seenIds: new Set() };
let puppeteerMod: typeof import('puppeteer-core') | undefined;

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
  if (!exe) return { ok: false, reason: 'No Chrome/Edge found on this machine (set BROWSER_PATH to a chrome.exe / msedge.exe)' };
  return { ok: true, executable: exe };
}

function profileExists(): boolean {
  return fs.existsSync(path.join(PROFILE_DIR, 'Default')) || fs.existsSync(path.join(PROFILE_DIR, 'Local State'));
}

async function launch(headless: boolean): Promise<Browser> {
  const sup = sessionSupported();
  if (!sup.ok) throw new Error(sup.reason);
  const p = await puppeteer();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return p.launch({
    executablePath: sup.executable,
    headless: headless ? 'new' : false,
    userDataDir: PROFILE_DIR,
    defaultViewport: headless ? { width: 1280, height: 900 } : null,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--mute-audio', `--window-size=${headless ? '1280,900' : '1100,860'}`],
    ignoreDefaultArgs: ['--enable-automation'],
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
  if (!sup.ok) return { supported: false, state: 'unsupported', error: sup.reason, message: 'Sign-in needs the Node server on a machine with Chrome or Edge.' };
  const base: SessionStatus = { supported: true, state: s.state, username: s.username, nickname: s.nickname, avatar: s.avatar, error: s.error, browser };
  if (s.state === 'none') base.message = profileExists() ? 'A saved browser profile exists; checking it on first use.' : 'Not signed in. Sign in opens TikTok in a browser window on the server machine.';
  if (s.state === 'login_pending') base.message = 'Finish signing in inside the TikTok window that opened on the server machine.';
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
          if (acc.ok) {
            s.state = 'logged_in';
            s.username = acc.username;
            s.nickname = acc.nickname;
            s.avatar = acc.avatar;
          }
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

export async function startLogin(log: (m: string) => void): Promise<SessionStatus> {
  if (s.state === 'login_pending' && s.loginBrowser) return sessionStatus();
  if (probe) await probe.catch(() => undefined);
  probed = true;
  await closeHeadless();
  s.state = 'login_pending';
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
        s.state = 'logged_in';
        s.username = acc.username;
        s.nickname = acc.nickname;
        s.avatar = acc.avatar;
        s.error = undefined;
        log(`signed in as @${acc.username}`);
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

async function closeHeadless(): Promise<void> {
  const b = s.headless;
  s.headless = undefined;
  s.feedPage = undefined;
  if (b) await b.close().catch(() => undefined);
}

export async function logout(): Promise<SessionStatus> {
  const lb = s.loginBrowser;
  s.loginBrowser = undefined;
  if (lb) await lb.close().catch(() => undefined);
  await closeHeadless();
  s.state = 'none';
  s.username = s.nickname = s.avatar = s.error = undefined;
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

/** The headless page that stays on /foryou; feed responses are captured as they happen. */
async function feedPage(): Promise<Page> {
  if (s.feedPage && s.headless?.isConnected()) return s.feedPage;
  await closeHeadless();
  feedLog?.('launching headless browser');
  const browser = await launch(true);
  feedLog?.('headless browser launched: ' + (await browser.version()));
  s.headless = browser;
  const page = (await browser.pages())[0] || (await browser.newPage());
  // Verified 2026-10-08: with this UA fix, --disable-blink-features=AutomationControlled and without
  // --enable-automation, the headless page gets real feed batches; plain headless got "Something went wrong".
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  // Keep the headless page cheap: no media/images; the viewer's browser fetches the videos itself.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Only media: TikTok's scripts (incl. the signing SDK) come from *.tiktokcdn-*.com too.
    const t = req.resourceType();
    if (t === 'media' || t === 'image' || t === 'font' || /mime_type=video|\.mp4(\?|$)/.test(req.url())) req.abort().catch(() => undefined);
    else req.continue().catch(() => undefined);
  });
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

let feedLog: ((m: string) => void) | undefined;
const guestAllowed = (): boolean => /^(1|true|yes)$/i.test(process.env.FORYOU_ALLOW_GUEST || '');

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
