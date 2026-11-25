/*
 * Probe: does TikTok answer a SIGNED-IN For You request made without a browser?
 *
 *   node_modules/.bin/tsx research/tiktok_foryou_direct_probe.ts <cookies.txt of a THROWAWAY account> [--rounds 2]
 *
 * ONLY for an account that may be lost: the request carries the account's session cookies behind
 * an imitated signature (server/src/tiktokSign.ts) over a Chrome-like connection (tlsBridge.ts).
 * The cookie file stays wherever it is (never in the repository); nothing here prints a cookie or
 * token value - names, sizes, counts and public video/author ids only.
 *
 * Steps: the account's /foryou page (who TikTok says this is, the device id it gives) -> the For You
 * list, signed -> the same list as a guest (how much the two overlap) -> the account call again
 * (is the session still alive afterwards?).
 */
import * as fs from 'node:fs';
import { signRequest } from '../server/src/tiktokSign';
import { chromeRequest, closeTlsBridge, type ChromeAnswer } from '../server/src/tlsBridge';
import { parseTikTokCookies } from '../server/src/tiktokAccounts';
import { guestGet, pageScope, takeCookies } from '../server/src/tiktokGuest';

const ORIGIN = 'https://www.tiktok.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const file = process.argv[2];
const rounds = Math.max(1, Number(process.argv[process.argv.indexOf('--rounds') + 1]) || 2);
if (!file || file.startsWith('--')) {
  console.error('usage: tsx research/tiktok_foryou_direct_probe.ts <cookies.txt> [--rounds N]');
  process.exit(2);
}

const jar = new Map<string, string>();
const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function send(method: string, url: string, headers: Record<string, string>): Promise<ChromeAnswer> {
  let target = url;
  for (let hop = 0; hop < 5; hop++) {
    const a = await chromeRequest({ method, url: target, headers: { ...headers, Cookie: cookieHeader() }, timeoutMs: 25_000 });
    takeCookies(jar, a.cookies);
    const loc = a.headers['location'];
    if (a.status >= 300 && a.status < 400 && loc) {
      target = new URL(loc, target).toString();
      if (!/^https:\/\/([\w-]+\.)*tiktok\.com\//.test(target)) throw new Error('redirected off tiktok.com');
      continue;
    }
    return a;
  }
  throw new Error('too many redirects');
}

const guard = (a: ChromeAnswer): string => (a.headers['tt-ticket-guard-result'] !== undefined ? `, guard ${a.headers['tt-ticket-guard-result']}` : '');

(async () => {
  const { cookies, warnings } = parseTikTokCookies(fs.readFileSync(file, 'utf8'));
  // (a host-only and a domain cookie of the same name: the domain one is the account's)
  for (const c of cookies.sort((a, b) => Number(a.domain.startsWith('.')) - Number(b.domain.startsWith('.')))) jar.set(c.name, c.value);
  console.log(`cookies: ${jar.size} names${warnings.length ? ` (${warnings.join('; ')})` : ''}, sessionid ${jar.get('sessionid')?.length} chars`);

  console.log('1. the account page');
  const page = await send('GET', `${ORIGIN}/foryou`, { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${ORIGIN}/` });
  const ctx = pageScope(page.body.toString('utf8'))?.['webapp.app-context'] ?? {};
  const who = ctx.user?.uniqueId as string | undefined;
  console.log(`   HTTP ${page.status}, ${page.body.length} bytes${guard(page)} -> signed in as ${who ? '@' + who : 'NOBODY (the page shows a guest)'}, device id ${ctx.wid ? 'given' : 'ABSENT'}, region ${ctx.region}, odinId ${ctx.odinId ? 'given' : 'absent'}`);
  if (!who || !ctx.wid) throw new Error('TikTok does not treat these cookies as a signed-in session on this connection; stopping here');

  const common = (): Array<[string, string]> =>
    Object.entries({
      aid: '1988', app_name: 'tiktok_web', app_language: 'en', device_platform: 'web_pc', device_id: String(ctx.wid), region: String(ctx.region || 'US'), priority_region: String(ctx.region || 'US'), language: 'en',
      WebIdLastTime: String(Math.floor(Date.now() / 1000)), channel: 'tiktok_web', cookie_enabled: 'true', os: 'mac', browser_language: 'en-US', browser_name: 'Mozilla', browser_online: 'true', browser_platform: 'MacIntel',
      browser_version: '5.0 (Macintosh)', focus_state: 'true', is_fullscreen: 'false', is_page_visible: 'true', history_len: '3', screen_height: '1117', screen_width: '1728',
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago', webcast_language: 'en', root_referer: `${ORIGIN}/`, odinId: String(ctx.odinId || ''), user_is_login: 'true',
    });
  const apiHeaders: Record<string, string> = {
    'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${ORIGIN}/foryou`, Origin: ORIGIN,
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
  };
  const signedGet = async (path: string, query: Record<string, string | number>): Promise<{ a: ChromeAnswer; json?: any; text: string }> => {
    const pairs = common();
    for (const [k, v] of Object.entries(query)) pairs.push([k, String(v)]);
    const qs = signRequest(pairs, { userAgent: UA, msToken: jar.get('msToken') ?? '' }).query;
    const a = await send('GET', `${ORIGIN}${path}?${qs}`, apiHeaders);
    const text = a.body.toString('utf8');
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON */
    }
    return { a, json, text };
  };

  console.log('2. For You, signed, with the account\'s cookies');
  const mine = new Map<string, string>();
  for (let r = 1; r <= rounds; r++) {
    await pause(2500);
    const { a, json, text } = await signedGet('/api/recommend/item_list/', { from_page: 'fyp', count: 9, coverFormat: 2, itemID: '', pullType: r === 1 ? 1 : 2, isNonPersonalized: 'false', vv_count_fyp: r - 1, showAds: 'true', showAboutThisAd: 'true' });
    const list: any[] = json?.itemList ?? [];
    for (const it of list) if (it?.id) mine.set(String(it.id), String(it.author?.uniqueId ?? '?'));
    const playable = list.filter((it) => it?.video?.playAddr || it?.video?.bitrateInfo?.length).length;
    const follows = list.filter((it) => Number(it?.author?.relation) > 0).length;
    console.log(`   round ${r}: HTTP ${a.status}, ${a.body.length} bytes, ${a.ms} ms${guard(a)} -> ${json ? `${list.length} videos (${playable} with files, ${follows} from followed accounts), status_code ${json.status_code ?? json.statusCode}, hasMore ${json.hasMore}` : text ? 'NOT JSON: ' + JSON.stringify(text.slice(0, 100)) : 'EMPTY BODY'}`);
  }
  console.log(`   ${mine.size} distinct videos; first authors: ${[...mine.values()].slice(0, 6).map((u) => '@' + u).join(', ')}`);

  console.log('3. the same list as a guest (no account), to compare');
  try {
    const g = await guestGet({ kind: 'video', path: '/api/recommend/item_list/', query: { from_page: 'fyp', count: 9, coverFormat: 2 }, what: 'the guest list', log: () => undefined });
    const ids: string[] = (g.json.itemList ?? []).map((it: any) => String(it.id));
    console.log(`   ${ids.length} videos; in common with the account's list: ${ids.filter((id) => mine.has(id)).length}`);
  } catch (e) {
    console.log(`   failed: ${(e as Error).message}`);
  }

  console.log('4. is the session still alive?');
  await pause(1500);
  const acc = await send('GET', `${ORIGIN}/passport/web/account/info/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web_pc`, { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${ORIGIN}/foryou` });
  let info: any;
  try {
    info = JSON.parse(acc.body.toString('utf8'));
  } catch {
    /* not JSON */
  }
  console.log(`   account/info: HTTP ${acc.status}${guard(acc)} -> ${info?.data?.username ? 'signed in as @' + info.data.username : `NOT signed in (${info?.data?.description || info?.message || acc.body.toString('utf8').slice(0, 80) || 'empty'})`}`);
})()
  .catch((e) => {
    console.error('STOPPED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => {
    closeTlsBridge();
    setTimeout(() => process.exit(), 2000);
  });
