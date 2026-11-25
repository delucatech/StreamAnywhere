/*
 * Probe: does TikTok answer a SEARCH made without a browser when the request carries an account's
 * session cookies? (As a guest every search endpoint answers an empty 200 - see tiktokGuest.ts.)
 *
 *   node_modules/.bin/tsx research/tiktok_search_direct_probe.ts <account id> [words]
 *
 * ONLY for an account that may be lost (never "main": it has no cookie file, and the probe refuses
 * it): the request carries the account's cookies behind an imitated signature. Nothing here prints
 * a cookie or token value - names, sizes, counts and public video/author ids only.
 */
import { signRequest } from '../server/src/tiktokSign';
import { chromeRequest, closeTlsBridge, type ChromeAnswer } from '../server/src/tlsBridge';
import { loadAccountCookies, MAIN_ACCOUNT } from '../server/src/tiktokAccounts';
import { openAccountVisit, takeCookies } from '../server/src/tiktokGuest';

const ORIGIN = 'https://www.tiktok.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const id = process.argv[2];
const words = process.argv.slice(3).join(' ') || 'tesla model y';
if (!id || id === MAIN_ACCOUNT) {
  console.error('usage: tsx research/tiktok_search_direct_probe.ts <account id, never main> [words]');
  process.exit(2);
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cookies = loadAccountCookies(id);
  if (!cookies) throw new Error('no cookies are saved for that account');
  const visit = await openAccountVisit(cookies, (m) => console.log('   ' + m));
  const jar = visit.jar;
  console.log(`1. the account page: @${visit.user.username}, region ${visit.region}, ${jar.size} cookie names`);

  const common = (): Array<[string, string]> =>
    Object.entries({
      aid: '1988', app_name: 'tiktok_web', app_language: 'en', device_platform: 'web_pc', device_id: visit.webId, region: visit.region, priority_region: visit.region, language: 'en',
      WebIdLastTime: String(Math.floor(Date.now() / 1000)), channel: 'tiktok_web', cookie_enabled: 'true', os: 'mac', browser_language: 'en-US', browser_name: 'Mozilla', browser_online: 'true', browser_platform: 'MacIntel',
      browser_version: '5.0 (Macintosh)', focus_state: 'true', is_fullscreen: 'false', is_page_visible: 'true', history_len: '3', screen_height: '1117', screen_width: '1728',
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago', webcast_language: 'en', root_referer: `${ORIGIN}/`, odinId: visit.odinId ?? '', user_is_login: 'true',
    });
  const referer = `${ORIGIN}/search?q=${encodeURIComponent(words)}`;
  const get = async (path: string, query: Record<string, string | number>, sign = true): Promise<{ a: ChromeAnswer; json?: any; text: string }> => {
    const pairs = common();
    for (const [k, v] of Object.entries(query)) pairs.push([k, String(v)]);
    const qs = sign ? signRequest(pairs, { userAgent: UA, msToken: jar.get('msToken') ?? '' }).query : pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const a = await chromeRequest({
      method: 'GET',
      url: `${ORIGIN}${path}?${qs}`,
      headers: {
        'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', Referer: referer, Origin: ORIGIN,
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      timeoutMs: 25_000,
    });
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
  const say = (label: string, r: { a: ChromeAnswer; json?: any; text: string }, more: string): void =>
    console.log(`   ${label}: HTTP ${r.a.status}, ${r.a.body.length} bytes, ${r.a.ms} ms -> ${r.json ? `status_code ${r.json.status_code ?? r.json.statusCode}, keys ${Object.keys(r.json).join(',')}${more}` : r.text ? 'NOT JSON: ' + JSON.stringify(r.text.slice(0, 80)) : 'EMPTY BODY'}`);

  const code = '{"tiktok":{"client_params_x":{"search_engine":{"ies_mt_user_live_video_card_use_libra":1,"mt_search_general_user_live_card":1}},"search_server":{}}}';
  console.log(`2. search "${words}" (everything), signed, with the account's cookies`);
  await pause(1500);
  const full = await get('/api/search/general/full/', { from_page: 'search', keyword: words, offset: 0, search_source: 'normal_search', web_search_code: code });
  const data: any[] = Array.isArray(full.json?.data) ? full.json.data : [];
  const vids = data.filter((d) => d?.item?.id);
  say('general/full', full, `; ${data.length} entries, ${vids.length} videos (${vids.filter((d) => d.item.video?.playAddr || d.item.video?.bitrateInfo?.length).length} with files), has_more ${full.json?.has_more}, cursor ${full.json?.cursor}; first: ${vids.slice(0, 4).map((d) => '@' + d.item.author?.uniqueId).join(', ')}`);

  if (full.json?.has_more) {
    console.log('3. the next page');
    await pause(1500);
    const next = await get('/api/search/general/full/', { from_page: 'search', keyword: words, offset: Number(full.json.cursor) || 12, search_source: 'normal_search', web_search_code: code, search_id: full.json.extra?.logid || full.json.log_pb?.impr_id || '' });
    const d2: any[] = Array.isArray(next.json?.data) ? next.json.data : [];
    const seen = new Set(vids.map((d) => String(d.item.id)));
    say('general/full page 2', next, `; ${d2.filter((d) => d?.item?.id).length} videos, ${d2.filter((d) => d?.item?.id && !seen.has(String(d.item.id))).length} new, has_more ${next.json?.has_more}`);
  }

  console.log('3b. other ways to ask for videos');
  const describe = (j: any): string => {
    const list: any[] = Array.isArray(j?.item_list) ? j.item_list : Array.isArray(j?.data) ? j.data.map((d: any) => d?.item).filter(Boolean) : [];
    return `; ${list.length} videos (${list.filter((it) => it?.video?.playAddr || it?.video?.bitrateInfo?.length).length} with files), has_more ${j?.has_more}, cursor ${j?.cursor}; first: ${list.slice(0, 4).map((it) => '@' + it?.author?.uniqueId).join(', ')}`;
  };
  const variants: Array<[string, string, Record<string, string | number>]> = [
    ['general/full without web_search_code', '/api/search/general/full/', { from_page: 'search', keyword: words, offset: 0, search_source: 'normal_search' }],
    ['item/full (the Videos tab)', '/api/search/item/full/', { from_page: 'search', keyword: words, offset: 0, count: 20, search_source: 'tab_search' }],
    ['item/full, normal_search', '/api/search/item/full/', { from_page: 'search', keyword: words, cursor: 0, count: 20, search_source: 'normal_search' }],
    ['general/full, focus_state etc. as the page sends', '/api/search/general/full/', { from_page: 'search', keyword: words, offset: 0, search_source: 'normal_search', web_search_code: code, is_filter_search: 0, sort_type: 0, publish_time: 0, search_id: '' }],
  ];
  for (const [label, path, query] of variants) {
    await pause(1500);
    const r = await get(path, query);
    say(label, r, describe(r.json));
  }

  console.log('4. accounts matching the words');
  await pause(1500);
  const users = await get('/api/search/user/full/', { from_page: 'search', keyword: words, cursor: 0, count: 12, search_source: 'normal_search' });
  const ul: any[] = Array.isArray(users.json?.user_list) ? users.json.user_list : [];
  say('user/full', users, `; ${ul.length} accounts: ${ul.slice(0, 4).map((u) => '@' + (u?.user_info?.unique_id ?? '?')).join(', ')}`);

  console.log('5. the same search without the signature (is the signature what matters?)');
  await pause(1500);
  const bare = await get('/api/search/general/full/', { from_page: 'search', keyword: words, offset: 0, search_source: 'normal_search', web_search_code: code }, false);
  say('general/full unsigned', bare, `; ${(Array.isArray(bare.json?.data) ? bare.json.data : []).length} entries`);

  console.log('6. is the session still alive?');
  await pause(1500);
  const acc = await chromeRequest({ method: 'GET', url: `${ORIGIN}/passport/web/account/info/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web_pc`, headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: `${ORIGIN}/foryou`, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, timeoutMs: 25_000 });
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
