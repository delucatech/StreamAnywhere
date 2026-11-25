/*
 * Probe: does TikTok accept a FOLLOW / UNFOLLOW made without a browser, with an account's cookies?
 *
 *   node_modules/.bin/tsx research/tiktok_follow_direct_probe.ts <account id> <handle> [--keep]
 *
 * ONLY for an account that may be lost (never "main": it has no cookie file, and the probe refuses
 * it). It really follows <handle> as that account and then unfollows it again (unless --keep), so
 * the account ends as it began. Nothing here prints a cookie or token value - names, sizes, counts
 * and public ids only.
 */
import { signRequest } from '../server/src/tiktokSign';
import { chromeRequest, closeTlsBridge, type ChromeAnswer } from '../server/src/tlsBridge';
import { loadAccountCookies, MAIN_ACCOUNT } from '../server/src/tiktokAccounts';
import { openAccountVisit, pageScope, takeCookies } from '../server/src/tiktokGuest';

const ORIGIN = 'https://www.tiktok.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const id = process.argv[2];
const handle = (process.argv[3] || '').replace(/^@/, '');
const keep = process.argv.includes('--keep');
if (!id || id === MAIN_ACCOUNT || !handle) {
  console.error('usage: tsx research/tiktok_follow_direct_probe.ts <account id, never main> <handle> [--keep]');
  process.exit(2);
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cookies = loadAccountCookies(id);
  if (!cookies) throw new Error('no cookies are saved for that account');
  const visit = await openAccountVisit(cookies, (m) => console.log('   ' + m));
  const jar = visit.jar;
  const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const referer = `${ORIGIN}/@${handle}`;

  /** The account page as the account sees it: who it is, and whether the account follows it. */
  const look = async (): Promise<{ uid?: string; secUid?: string; relation?: number; followers?: number }> => {
    const a = await chromeRequest({ method: 'GET', url: referer, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${ORIGIN}/foryou`, Cookie: cookie() }, timeoutMs: 25_000 });
    takeCookies(jar, a.cookies);
    const d = pageScope(a.body.toString('utf8'))?.['webapp.user-detail'];
    const u = d?.userInfo?.user;
    return { uid: u?.id, secUid: u?.secUid, relation: u?.relation, followers: Number(d?.userInfo?.stats?.followerCount) || undefined };
  };

  const common = (): Array<[string, string]> =>
    Object.entries({
      aid: '1988', app_name: 'tiktok_web', app_language: 'en', device_platform: 'web_pc', device_id: visit.webId, region: visit.region, priority_region: visit.region, language: 'en',
      WebIdLastTime: String(Math.floor(Date.now() / 1000)), channel: 'tiktok_web', cookie_enabled: 'true', os: 'mac', browser_language: 'en-US', browser_name: 'Mozilla', browser_online: 'true', browser_platform: 'MacIntel',
      browser_version: '5.0 (Macintosh)', focus_state: 'true', is_fullscreen: 'false', is_page_visible: 'true', history_len: '3', screen_height: '1117', screen_width: '1728',
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago', webcast_language: 'en', root_referer: `${ORIGIN}/`, odinId: visit.odinId ?? '', user_is_login: 'true',
    });
  const apiHeaders = (): Record<string, string> => ({
    'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', Referer: referer, Origin: ORIGIN,
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
    Cookie: cookie(),
  });

  /** The token TikTok's page asks for before a write: a HEAD on the same path answers it in a header. */
  const writeToken = async (path: string): Promise<string | undefined> => {
    const a = await chromeRequest({ method: 'HEAD', url: `${ORIGIN}${path}`, headers: { ...apiHeaders(), 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' }, timeoutMs: 20_000 });
    takeCookies(jar, a.cookies);
    const h = a.headers['x-ware-csrf-token'];
    const parts = typeof h === 'string' ? h.split(',') : [];
    console.log(`   write token: HTTP ${a.status}, header ${h ? `given (${parts.length} parts, token ${parts[1]?.length ?? 0} chars)` : 'ABSENT'}`);
    return parts[1] || undefined;
  };

  const act = async (who: { uid: string; secUid: string }, follow: boolean, token: string | undefined): Promise<{ a: ChromeAnswer; json?: any; text: string }> => {
    const pairs = common();
    for (const [k, v] of Object.entries({ action_type: follow ? 1 : 0, channel_id: 0, from: 18, from_pre: 0, fromWeb: 1, sec_user_id: who.secUid, type: follow ? 1 : 0, user_id: who.uid })) pairs.push([k, String(v)]);
    const qs = signRequest(pairs, { userAgent: UA, msToken: jar.get('msToken') ?? '', body: '' }).query;
    const headers: Record<string, string> = { ...apiHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
    if (visit.csrf) headers['tt-csrf-token'] = visit.csrf;
    if (token) headers['x-secsdk-csrf-token'] = token;
    const a = await chromeRequest({ method: 'POST', url: `${ORIGIN}/api/commit/follow/user/?${qs}`, headers, body: '', timeoutMs: 25_000 });
    takeCookies(jar, a.cookies);
    const text = a.body.toString('utf8');
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON */
    }
    return { a, json, text };
  };
  const said = (r: { a: ChromeAnswer; json?: any; text: string }): string =>
    `HTTP ${r.a.status}, ${r.a.body.length} bytes, ${r.a.ms} ms -> ${r.json ? `status_code ${r.json.status_code ?? r.json.statusCode}, follow_status ${r.json.follow_status}, keys ${Object.keys(r.json).join(',')}${r.json.status_msg ? `, "${r.json.status_msg}"` : ''}` : r.text ? 'NOT JSON: ' + JSON.stringify(r.text.slice(0, 80)) : 'EMPTY BODY'}`;

  console.log(`1. @${handle} as @${visit.user.username} sees it`);
  const before = await look();
  console.log(`   id ${before.uid ? 'given' : 'ABSENT'}, secUid ${before.secUid ? 'given' : 'ABSENT'}, relation ${before.relation}, followers ${before.followers}`);
  if (!before.uid || !before.secUid) throw new Error('the account page did not name the account; stopping');
  if (before.relation && before.relation !== 0) throw new Error(`@${visit.user.username} already follows @${handle} (relation ${before.relation}): pick an account it does not follow, so the probe can put things back`);
  const who = { uid: before.uid, secUid: before.secUid };

  console.log('2. follow, with the page\'s csrf token only');
  await pause(1500);
  let r = await act(who, true, undefined);
  console.log('   ' + said(r));
  await pause(2000);
  let now = await look();
  console.log(`   relation now ${now.relation}`);
  let token: string | undefined;
  if (!(Number(now.relation) > 0)) {
    console.log('2b. follow, with the write token asked for first');
    token = await writeToken('/api/commit/follow/user/');
    await pause(1000);
    r = await act(who, true, token);
    console.log('   ' + said(r));
    await pause(2000);
    now = await look();
    console.log(`   relation now ${now.relation}`);
  }
  if (!(Number(now.relation) > 0)) throw new Error('TikTok did not take the follow either way');
  if (keep) return;

  console.log('3. unfollow, the same way');
  await pause(2000);
  r = await act(who, false, token);
  console.log('   ' + said(r));
  await pause(2000);
  now = await look();
  console.log(`   relation now ${now.relation}`);

  console.log('4. is the session still alive?');
  await pause(1000);
  const acc = await chromeRequest({ method: 'GET', url: `${ORIGIN}/passport/web/account/info/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web_pc`, headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: `${ORIGIN}/foryou`, Cookie: cookie() }, timeoutMs: 25_000 });
  let info: any;
  try {
    info = JSON.parse(acc.body.toString('utf8'));
  } catch {
    /* not JSON */
  }
  console.log(`   account/info: HTTP ${acc.status} -> ${info?.data?.username ? 'signed in as @' + info.data.username : `NOT signed in (${info?.data?.description || info?.message || 'no answer'})`}`);
})()
  .catch((e) => {
    console.error('STOPPED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => {
    closeTlsBridge();
    setTimeout(() => process.exit(), 2000);
  });
