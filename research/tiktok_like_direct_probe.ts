/*
 * Probe: does TikTok accept a LIKE / UNLIKE (and a FAVORITE) made without a browser, with an
 * account's cookies?
 *
 *   node_modules/.bin/tsx research/tiktok_like_direct_probe.ts <account id> [video id]
 *
 * ONLY for an account that may be lost (never "main": it has no cookie file, and the probe refuses
 * it). It really likes a video as that account (one of its For You videos it has not liked, unless
 * an id is given) and takes the like back, then the same with "favorite", so the account ends as
 * it began. Nothing here prints a cookie or token value - counts and public ids only.
 *
 * RESULT (2026-11-25, a spare account, from the PC): NOT taken. TikTok answers status_code 0 with
 * `is_digg: 1` and the header `tt-ticket-guard-result: 1101`; the video still reads digged: false
 * and the account's Liked list (api/favorite/item_list) does not get it. Tried as well: verifyFp,
 * tt-csrf-token, the x-secsdk-csrf-token of a HEAD request, the action in a form body (that one
 * got an empty answer). A like needs the browser's ticket-guard key; a follow does not.
 */
import { closeTlsBridge } from '../server/src/tlsBridge';
import { loadAccountCookies, MAIN_ACCOUNT } from '../server/src/tiktokAccounts';
import { accountForYou, accountGet, openAccountVisit, type AccountVisit } from '../server/src/tiktokGuest';

const id = process.argv[2];
let videoId = process.argv[3];
if (!id || id === MAIN_ACCOUNT) {
  console.error('usage: tsx research/tiktok_like_direct_probe.ts <account id, never main> [video id]');
  process.exit(2);
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (m: string): void => console.log('   ' + m);

async function look(visit: AccountVisit, vid: string): Promise<{ digged?: boolean; collected?: boolean; likes?: number }> {
  const r = await accountGet(visit, { kind: 'video', path: '/api/item/detail/', query: { itemId: vid }, what: 'the video', referer: 'https://www.tiktok.com/foryou', usable: (j) => Boolean(j?.itemInfo?.itemStruct), log });
  const s = r.json.itemInfo.itemStruct;
  return { digged: s.digged, collected: s.collected, likes: Number(s.stats?.diggCount) };
}

async function post(visit: AccountVisit, path: string, query: Record<string, string | number>): Promise<string> {
  try {
    const r = await accountGet(visit, { kind: 'follow', method: 'POST', path, query, what: 'the like', referer: 'https://www.tiktok.com/foryou', usable: () => true, log });
    return `status_code ${r.json.status_code ?? r.json.statusCode}, keys ${Object.keys(r.json).join(',')}, is_digg ${r.json.is_digg}, ${r.ms} ms`;
  } catch (e) {
    return `REFUSED: ${(e as Error).message}`;
  }
}

(async () => {
  const cookies = loadAccountCookies(id);
  if (!cookies) throw new Error('no cookies are saved for that account');
  const visit = await openAccountVisit(cookies, log);
  if (!videoId) {
    const fy = await accountForYou(visit, 1, 9, log);
    const pick = (fy.json.itemList as any[]).find((it) => it?.id && it.digged === false && it.collected === false && !it.isAd);
    if (!pick) throw new Error('no For You video that is neither liked nor a favorite; give an id');
    videoId = String(pick.id);
    console.log(`1. a For You video of @${visit.user.username}: ${videoId} by @${pick.author?.uniqueId} (digged ${pick.digged}, collected ${pick.collected})`);
  }
  await pause(1200);
  console.log('   before:', JSON.stringify(await look(visit, videoId)));

  console.log('2. like');
  await pause(1200);
  console.log('   ' + (await post(visit, '/api/commit/item/digg/', { aweme_id: videoId, type: 1 })));
  await pause(1500);
  const liked = await look(visit, videoId);
  console.log('   after:', JSON.stringify(liked));

  console.log('3. unlike');
  await pause(1200);
  console.log('   ' + (await post(visit, '/api/commit/item/digg/', { aweme_id: videoId, type: 0 })));
  await pause(1500);
  console.log('   after:', JSON.stringify(await look(visit, videoId)));

  console.log('4. favorite, and back');
  for (const [label, path, query] of [
    ['collect action=1', '/api/aweme/collect/', { aweme_id: videoId, action: 1, itemId: videoId }],
  ] as Array<[string, string, Record<string, string | number>]>) {
    await pause(1200);
    console.log(`   ${label}: ` + (await post(visit, path, query)));
    await pause(1500);
    const now = await look(visit, videoId);
    console.log('   after:', JSON.stringify(now));
    if (now.collected) {
      await pause(1200);
      console.log('   back: ' + (await post(visit, path, { ...query, action: 0 })));
      await pause(1500);
      console.log('   after:', JSON.stringify(await look(visit, videoId)));
    }
  }
})()
  .catch((e) => {
    console.error('STOPPED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => {
    closeTlsBridge();
    setTimeout(() => process.exit(), 2000);
  });
