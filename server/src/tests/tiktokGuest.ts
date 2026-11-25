/**
 * Checks of TikTok asked as a guest without a browser (tiktokSign.ts, tiktokGuest.ts, tlsBridge.ts,
 * the comment mapping in social.ts). run.ts calls tiktokGuestChecks() (offline) and
 * tiktokGuestNetworkChecks() (one guest visit: two comment pages, replies, an Explore batch, an account
 * and its videos, one video's files; skipped, not failed, on a machine without Python + curl_cffi).
 *
 * Alone: `npx tsx src/tests/tiktokGuest.ts` from server/ (GUEST_NETWORK=1 adds the network part).
 */
import { encodeQuery, hashState, signRequest } from '../tiktokSign';
import { beyondEnvelope, commentAnswerUsable, GuestError, guestCommentList, guestUnusable, pageIdentity, pageScope, resetTikTokGuest, takeCookies, tiktokGuestStatus } from '../tiktokGuest';
import { closeTlsBridge, tlsBridgeStatus } from '../tlsBridge';
import { commentsFromAnswer, fetchCommentReplies, fetchProfileAsGuest, SocialError, userFromAccountPage } from '../social';
import { fetchExploreAsGuest, parseExploreJson } from '../feed';
import { resolveTikTokNative } from '../tiktok';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** The signer's own base64 alphabet */
const SEALED = /^[A-Za-z0-9/-]+=*$/;

export async function tiktokGuestChecks(check: Check): Promise<void> {
  console.log('\n== 2g. TikTok without a browser: the signer, the guest visit, the comment answer (offline)');

  check('a query is escaped the way a browser does it (space, quote, hash; the rest as it is)', encodeQuery([['a', 'b c'], ['k', 'x"y#z'], ['tz', 'America/Chicago']]) === 'a=b%20c&k=x%22y%23z&tz=America/Chicago', encodeQuery([['a', 'b c'], ['k', 'x"y#z'], ['tz', 'America/Chicago']]));
  check('other alphabets are sent as UTF-8 bytes', encodeQuery([['q', 'é猫']]) === 'q=%C3%A9%E7%8C%AB', encodeQuery([['q', 'é猫']]));
  check('the state hash is stable (same text, same number; another text, another number)', hashState('') === 2166136260 && hashState('aid=1988') === hashState('aid=1988') && hashState('aid=1988') !== hashState('aid=1989'), [hashState(''), hashState('aid=1988')]);

  const pairs: Array<[string, string]> = [['aid', '1988'], ['aweme_id', '7693184538704416031'], ['count', '20']];
  const a = signRequest(pairs, { userAgent: UA, msToken: 'tok_en-1', timestamp: 1795600000, nonce: 123456, nonce2: 654321 });
  const b = signRequest(pairs, { userAgent: UA, msToken: 'tok_en-1', timestamp: 1795600000, nonce: 123456, nonce2: 654321 });
  const order = a.query.split('&').map((p) => p.split('=')[0]);
  check('a signed query keeps the parameters first, then X-Dynosaur, msToken, X-Bogus, X-Gnarly', order.join(',') === 'aid,aweme_id,count,X-Dynosaur,msToken,X-Bogus,X-Gnarly', order);
  check('the signature values are sealed text; X-Bogus is the literal 1; msToken is passed through', SEALED.test(a.parameters['X-Dynosaur']) && SEALED.test(a.parameters['X-Gnarly']) && a.parameters['X-Bogus'] === '1' && a.parameters.msToken === 'tok_en-1' && a.parameters['X-Gnarly'].length > 100, { dynosaur: a.parameters['X-Dynosaur'].length, gnarly: a.parameters['X-Gnarly'].length });
  check('every signature is new (a random key each time), same shape', a.parameters['X-Gnarly'] !== b.parameters['X-Gnarly'] && a.parameters['X-Dynosaur'] !== b.parameters['X-Dynosaur'] && a.parameters['X-Gnarly'].length === b.parameters['X-Gnarly'].length);
  check('the signature starts where the plain query ends', a.query.startsWith('aid=1988&aweme_id=7693184538704416031&count=20&X-Dynosaur='));

  const jar = new Map<string, string>([['old', '1']]);
  const n = takeCookies(jar, ['ttwid=1%7Cabc; Path=/; Domain=tiktok.com; Max-Age=31536000; HttpOnly', 'msToken=m-1=; expires=Sat, 05 Dec 2026 15:00:00 GMT', 'gone=; Max-Age=0', 'not a cookie', 'old=2; Path=/']);
  check('Set-Cookie lines land in the jar by name; an empty value and a broken line are skipped', n === 3 && jar.get('ttwid') === '1%7Cabc' && jar.get('msToken') === 'm-1=' && jar.get('old') === '2' && !jar.has('gone'), { n, jar: [...jar] });

  const html = `<html><head><script src="https://lf16-tiktok-web.tiktokcdn-us.com/obj/tiktok-web-tx/webmssdk/2.0.0.569/webmssdk.js"></script></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': { wid: '7577000000000000001', region: 'US', csrfToken: 'csrf-1', abTestVersion: { versionName: '1,2,3' }, appId: 1180 } } })}</script></body></html>`;
  const id = pageIdentity(html);
  check("a page's identity: device id, region, csrf, A/B versions, and the build of the signing script it loads", id.wid === '7577000000000000001' && id.region === 'US' && id.csrf === 'csrf-1' && id.ab === '1,2,3' && id.script === '2.0.0.569', id);
  check('a challenge page (no data block) gives no device id, without throwing', pageIdentity('<html><body>Please wait...</body></html>').wid === undefined && pageIdentity('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{broken</script>').wid === undefined);

  check('a comment answer with a list (even empty), or with a total, is an answer', commentAnswerUsable({ comments: [], status_code: 0 }) && commentAnswerUsable({ total: 0, status_code: 0 }) && commentAnswerUsable({ comments: [{ cid: '1' }], total: 5 }));
  check('"comments": null with the other fields around it (no comments, or an unknown video) is an answer too', commentAnswerUsable({ comments: null, extra: { now: 1795620286000 }, log_pb: { impr_id: 'x' }, reply_style: 1, status_code: 0, status_msg: '', top_gifts: null }) && commentsFromAnswer({ comments: null, status_code: 0 }, 0).comments.length === 0);
  check("TikTok's bare \"ok\" (no list, no total) is its soft refusal, not an answer", !commentAnswerUsable({ status_code: 0 }) && !commentAnswerUsable({ status_code: 0, log_pb: { impr_id: 'x' } }) && !commentAnswerUsable(undefined) && !commentAnswerUsable('ok') && !commentAnswerUsable([]));

  const page = commentsFromAnswer(
    {
      comments: [
        { cid: '77', text: 'Absolutely beautiful', create_time: 1795500000, digg_count: 12, reply_comment_total: 3, user: { uid: '5', unique_id: 'someone', nickname: 'Some One', avatar_thumb: { url_list: ['https://p16.example/a.jpg'] } } },
        { cid: '78', text: 'thanks!', is_author: true, user: { unique_id: 'creator' } },
        {},
      ],
      cursor: 20,
      has_more: 1,
      total: 207,
    },
    0,
  );
  check('a comment page as our comments: text, who, when, likes, replies, the creator mark; an empty entry is dropped', page.comments.length === 2 && page.comments[0].id === '77' && page.comments[0].user.uniqueId === 'someone' && page.comments[0].user.avatar === 'https://p16.example/a.jpg' && page.comments[0].time === 1795500000 && page.comments[0].likes === 12 && page.comments[0].replies === 3 && page.comments[1].byAuthor === true, page.comments);
  check('the next page starts at TikTok\'s cursor; "more" and the total are passed on', page.cursor === 20 && page.hasMore && page.total === 207);
  const last = commentsFromAnswer({ comments: [{ cid: '1', text: 'a' }], has_more: 0 }, 40);
  check('without a cursor in the answer the next page starts after the comments read', last.cursor === 41 && !last.hasMore && last.total === undefined, last);

  check('an answer is more than TikTok\'s bare "ok" when it carries any field of its own', beyondEnvelope({ itemList: [], hasMore: false, statusCode: 0 }) && beyondEnvelope({ cursor: '0', status_code: 0 }) && !beyondEnvelope({ status_code: 0, statusCode: 0, status_msg: '', log_pb: { impr_id: 'x' }, extra: { now: 1 } }) && !beyondEnvelope(null) && !beyondEnvelope([]));

  const accountPage = (detail: unknown): string => `<html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': { wid: '1' }, 'webapp.user-detail': detail } })}</script></body></html>`;
  const acct = userFromAccountPage(accountPage({ statusCode: 0, userInfo: { user: { id: '107955', uniqueId: 'tiktok', nickname: 'TikTok', secUid: 'MS4wLjABAAAAv7', verified: true, signature: 'One TikTok can make a big impact', avatarMedium: 'https://p16.example/a.jpeg', relation: 0 }, stats: { followerCount: 97100000, followingCount: 5, heartCount: 450000000, videoCount: 1520 } } }));
  check("an account page's data block as the account: handle, the id the list call wants, counts", acct.readable && acct.statusCode === 0 && acct.info?.uniqueId === 'tiktok' && acct.info.secUid === 'MS4wLjABAAAAv7' && acct.info.followers === 97100000 && acct.info.videos === 1520 && acct.info.verified === true && !acct.privateAccount, acct);
  const gone = userFromAccountPage(accountPage({ statusCode: 10221, statusMsg: '', needFix: false }));
  check('an account TikTok does not know: status 10221, no account', gone.readable && gone.statusCode === 10221 && gone.info === undefined, gone);
  check('a private account is marked; a page without the block is not readable', userFromAccountPage(accountPage({ statusCode: 0, userInfo: { user: { uniqueId: 'shy', secUid: 'S', privateAccount: true }, stats: {} } })).privateAccount === true && !userFromAccountPage('<html><body>Please wait...</body></html>').readable && pageScope('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{broken</script>') === undefined);

  const exploreWarnings: string[] = [];
  const explore = parseExploreJson(
    { statusCode: 0, hasMore: true, itemList: [{ id: '7700000000000000001', desc: 'a cat', author: { uniqueId: 'cats', nickname: 'Cats' }, stats: { playCount: 10 }, video: { duration: 9, width: 576, height: 1024, cover: 'https://p16.example/c.jpg', bitrateInfo: [{ GearName: 'normal_540_0', CodecType: 'h264', Bitrate: 800000, PlayAddr: { UrlList: ['https://v16-webapp-prime.us.tiktok.com/video/tos/a.mp4?expire=1795700000', 'https://www.tiktok.com/aweme/v1/play/?video_id=v1'] } }] } }, { id: '7700000000000000002', isAd: true, video: {} }] },
    { cookieHeader: 'tt_chain_token=abc', referer: 'https://www.tiktok.com/explore' },
    exploreWarnings,
  );
  check('an Explore answer already parsed gives the same feed items (the ad left out, a relay address for the cookie-bound file)', explore.items.length === 1 && explore.raw === 2 && explore.hasMore && explore.items[0].author.uniqueId === 'cats' && explore.items[0].formats[0].directKind === 'redirect' && /^\/api\/media\//.test(explore.items[0].formats[0].proxyUrl || ''), { items: explore.items.length, raw: explore.raw, f: explore.items[0]?.formats[0] });

  resetTikTokGuest();
  check('each kind of read has its own pause: nothing is paused before a failure, whatever the kind', guestUnusable('comments') === guestUnusable('explore') && guestUnusable('profile') === guestUnusable('video'));
  const st = tiktokGuestStatus();
  check('before any request the status says "unused" and which script build the signer imitates', (st.state === 'unused' || st.state === 'unavailable') && st.signerBuild === '2.0.0.561' && st.signingAs === st.signerBuild && st.calls === 0, st);
}

export async function tiktokGuestNetworkChecks(check: Check, videoId: string): Promise<void> {
  console.log('\n== 5h. TikTok without a browser: a real guest visit and two pages of comments (network)');
  resetTikTokGuest();
  const lines: string[] = [];
  const log = (m: string): void => void lines.push(m);
  try {
    const t0 = Date.now();
    const first = await guestCommentList(videoId, 0, log);
    const firstMs = Date.now() - t0;
    const n = Array.isArray(first.json.comments) ? first.json.comments.length : -1;
    check(`a guest reads comments of ${videoId} without a browser`, n > 0 && Number(first.json.total) >= n, { comments: n, total: first.json.total, has_more: first.json.has_more, ms: firstMs, attempts: first.attempts });
    const t1 = Date.now();
    const second = await guestCommentList(videoId, Number(first.json.cursor) || n, log);
    const ids = new Set((first.json.comments as any[]).map((c) => c.cid));
    const fresh = (second.json.comments as any[]).filter((c) => !ids.has(c.cid)).length;
    check('the next page comes from the same visit, with other comments', second.attempts === 1 && fresh > 0, { comments: second.json.comments?.length, fresh, ms: Date.now() - t1 });
    const st = tiktokGuestStatus();
    check('the status after two answers: ok, one visit, the helper running', st.state === 'ok' && st.ok === 2 && st.visits === 1 && st.helper.running && Boolean(st.scriptSeen) && st.paths.comments?.ok === 2, { state: st.state, ok: st.ok, visits: st.visits, scriptSeen: st.scriptSeen, signingAs: st.signingAs, helper: st.helper.version });
    check('nothing makes the path unusable after a success', guestUnusable() === undefined, guestUnusable());

    // The other reads on the same visit: replies, Explore, an account and its videos, one video's files.
    const withReplies = (first.json.comments as any[]).concat(second.json.comments as any[]).find((c) => Number(c.reply_comment_total) > 0);
    if (withReplies) {
      const rep = await fetchCommentReplies(videoId, String(withReplies.cid), 0, log);
      check('the replies under a comment', rep.comments.length > 0 && rep.cursor === rep.comments.length && (rep.total ?? 0) >= rep.comments.length && rep.hasMore === rep.cursor < (rep.total ?? 0), { replies: rep.comments.length, total: rep.total, hasMore: rep.hasMore, ms: rep.elapsedMs });
    } else console.log('SKIP  no comment with replies on the first two pages');
    const ex = await fetchExploreAsGuest({ category: 120, count: 12, log });
    check('an Explore batch over the Chrome-like connection, every video with its files', Boolean(ex) && ex!.items.length >= 6 && ex!.items.every((it) => it.formats.length > 0 && Boolean(it.formats[0].proxyUrl)), { items: ex?.items.length, raw: ex?.raw, warnings: ex?.warnings });
    const prof = await fetchProfileAsGuest('tiktok', 0, 12, log);
    check("an account's details and first videos without a browser", Boolean(prof) && prof!.user.uniqueId === 'tiktok' && (prof!.user.followers ?? 0) > 1000000 && prof!.items.length === 12 && prof!.hasMore && prof!.items.every((it) => it.author.uniqueId === 'tiktok'), { user: prof?.user.uniqueId, followers: prof?.user.followers, items: prof?.items.length, hasMore: prof?.hasMore, ms: prof?.elapsedMs });
    const more = await fetchProfileAsGuest('tiktok', 12, 30, log);
    const firstIds = new Set(prof!.items.map((it) => it.id));
    check('the next videos continue where the first ones stopped (a second list page behind them)', Boolean(more) && more!.items.length === 30 && more!.items.every((it) => !firstIds.has(it.id)), { items: more?.items.length, ms: more?.elapsedMs });
    let missing: unknown;
    await fetchProfileAsGuest('no_such_account_zzz_91827', 0, 12, log).catch((e) => (missing = e));
    check('an account that does not exist is a 404, not a failure of the path', missing instanceof SocialError && missing.status === 404 && guestUnusable('profile') === undefined, { error: (missing as Error)?.message });
    const res = await resolveTikTokNative(`https://www.tiktok.com/@tiktok/video/${videoId}`, { probe: false, log: (m) => log(m) });
    check("one video's files through the item/detail call (no page fetch)", res.id === videoId && res.formats.length > 0 && res.formats.every((f) => Boolean(f.proxyUrl)) && lines.some((l) => /video details over the Chrome-like connection/.test(l)), { formats: res.formats.length, ms: res.elapsedMs, canonical: res.canonicalUrl });
    const paths = tiktokGuestStatus().paths;
    check('the status lists every kind that was asked, all ok', ['comments', 'replies', 'explore', 'profile', 'posts', 'video'].every((k) => !withReplies && k === 'replies' ? true : (paths as any)[k]?.state === 'ok'), paths);
  } catch (e) {
    if (e instanceof GuestError && e.kind === 'helper' && tlsBridgeStatus().available === false) {
      console.log(`SKIP  no Python with curl_cffi on this machine (${tlsBridgeStatus().reason}); comments use the browser path here`);
    } else {
      check('a guest reads comments without a browser', false, { error: (e as Error).message, log: lines.slice(-6) });
    }
  } finally {
    closeTlsBridge();
  }
}

if (require.main === module) {
  let failures = 0;
  const check: Check = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
    if (!cond) failures++;
  };
  (async () => {
    await tiktokGuestChecks(check);
    if (process.env.GUEST_NETWORK === '1') await tiktokGuestNetworkChecks(check, process.env.TIKTOK_TEST_VIDEO || '7693184538704416031');
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
    setTimeout(() => process.exit(failures ? 1 : 0), 2000);
  })().catch((e) => {
    console.error('crashed:', e);
    process.exit(1);
  });
}
