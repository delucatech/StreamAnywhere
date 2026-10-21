/**
 * Executable checks (no test framework): `npm test` from the repo root.
 *
 *  1. SSRF / allowlist unit checks (offline)
 *  2. TikTok URL parsing (offline)
 *  3. Proxy Range relay against a public CORS-enabled MP4 (network)
 *  4. Live TikTok resolution + cookie / CORS behaviour of each URL kind (network, TIKTOK_TEST_URL)
 *  5. Concurrent yt-dlp lookups through the warm daemons (network, skipped without yt-dlp)
 *
 * Network checks are skipped (not failed) when SKIP_NETWORK=1.
 */
import { buildServer } from '../index';
import { mirrorChecks } from './mirror';
import { hostAllowed, ipIsPrivate, assertSafeUpstream } from '../ssrf';
import { parseTikTokUrl } from '../tiktok';
import { isTikTokAd, itemToFeedItem } from '../feed';
import { entryToFeedItem, isYouTubeUrl, pickAudio, youTubeVideoId } from '../youtube';
import { accountFromMenu, parseCookiesText, sapisidHash, toNetscape, YouTubeSessionError } from '../youtubeSession';
import { accountFromAnswer, bodyHint, collectCodes, embedToFeedItem, handleFromQuery, instagramCode, isInstagramUrl, parseCount, parseProfileMeta, planExploreFill, sentAway, uaMetadata, urlExpiry } from '../instagram';
import { cleanUserAgent, cookiesLookSignedIn, InstagramSessionError, parseInstagramCookies } from '../instagramSession';
import { FACEBOOK_CATEGORIES, INSTAGRAM_CATEGORIES } from '../../../shared/types';
import { extractReels, facebookVideoId, isFacebookUrl, pageFromQuery, pageSummary, planExploreFill as planFacebookFill, playable, reelToFeedItem, slugFromProfileUrl } from '../facebook';
import { accountFromPage, cookieHeaderFor, FacebookSessionError, parseFacebookCookies, slugFromMeRedirect } from '../facebookSession';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Reservoir, expiredSoon } from '../reservoir';
import { lastFeedDir, resetLastBatches, STALE_BATCH } from '../lastBatch';
import { buildOptions, downloadSourceOf, saveName } from '../downloader';
import { canonicalize, normalizeUrl } from '../library';
import type { FeedItem } from '../../../shared/types';
import type { FeedResponse } from '../../../shared/types';
import { openUpstream } from '../http';
import { daemonStatus, detectYtDlp, shutdownYtDlp, ytdlpInfo } from '../ytdlp';
import type { ResolveResponse } from '../../../shared/types';

const TEST_MP4 = 'https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4';
const TIKTOK_URL = process.env.TIKTOK_TEST_URL || 'https://www.tiktok.com/@tiktok/video/7693184538704416031';
const skipNetwork = process.env.SKIP_NETWORK === '1';
// The last good batches of a server running on this machine must not leak into these checks
// (their proxy links belong to that process); the tests keep their own, empty, folder.
process.env.LAST_FEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'streamanywhere-last-feed-'));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
  if (!cond) failures++;
}

async function offline(): Promise<void> {
  console.log('\n== 1. allowlist / SSRF');
  check('wildcard suffix matches subdomain', hostAllowed('v16m-default.tiktokcdn-us.com', ['*.tiktokcdn-us.com']));
  check('wildcard suffix rejects bare domain lookalike', !hostAllowed('eviltiktokcdn-us.com', ['*.tiktokcdn-us.com']));
  check('exact host', hostAllowed('mdn.github.io', ['mdn.github.io']) && !hostAllowed('x.mdn.github.io', ['mdn.github.io']));
  check('private ipv4 detection', ipIsPrivate('10.1.2.3') && ipIsPrivate('127.0.0.1') && ipIsPrivate('169.254.169.254') && ipIsPrivate('172.16.0.1') && !ipIsPrivate('8.8.8.8'));
  check('private ipv6 detection', ipIsPrivate('::1') && ipIsPrivate('fe80::1') && ipIsPrivate('::ffff:192.168.1.1') && !ipIsPrivate('2606:4700::1111'));
  for (const [u, code] of [
    ['http://mdn.github.io/x.mp4', 'bad_scheme'],
    ['https://127.0.0.1/x.mp4', 'host_not_allowed'],
    ['https://localhost/x.mp4', 'host_not_allowed'],
    ['https://evil.example/x.mp4', 'host_not_allowed'],
    ['https://user:pw@mdn.github.io/x.mp4', 'bad_url'],
  ] as const) {
    let got = 'ok';
    try {
      await assertSafeUpstream(u, ['mdn.github.io']);
    } catch (e) {
      got = (e as { code?: string }).code || 'error';
    }
    check(`rejects ${u}`, got === code, got);
  }
  let litIp = 'ok';
  try {
    await assertSafeUpstream('https://10.0.0.1/x.mp4', ['*']);
  } catch (e) {
    litIp = (e as { code?: string }).code || 'error';
  }
  check('rejects literal private IP even with * allowlist', litIp === 'private_ip', litIp);

  console.log('\n== 2. TikTok URL parsing');
  check('canonical video url', parseTikTokUrl('https://www.tiktok.com/@tiktok/video/7693184538704416031?lang=en').videoId === '7693184538704416031');
  check('embed url', parseTikTokUrl('https://www.tiktok.com/embed/v2/7693184538704416031').videoId === '7693184538704416031');
  check('short link flagged', parseTikTokUrl('https://vm.tiktok.com/ZMabc123/').isShortLink === true);
  check('t/ short link flagged', parseTikTokUrl('https://www.tiktok.com/t/ZTabc123/').isShortLink === true);
  let photoErr = '';
  try {
    parseTikTokUrl('https://www.tiktok.com/@x/photo/7000000000000000000');
  } catch (e) {
    photoErr = (e as { code?: string }).code || '';
  }
  check('photo posts rejected', photoErr === 'unsupported_photo', photoErr);

  console.log('\n== 3. feed item conversion (offline)');
  const rawItem = {
    id: '7000000000000000001',
    desc: 'hello',
    createTime: 1791400000,
    author: { id: '1', uniqueId: 'someone', nickname: 'Some One', avatarThumb: 'https://p16.example/a.jpg' },
    stats: { playCount: 10, diggCount: 2, commentCount: 1, shareCount: 0 },
    music: { title: 'original sound' },
    video: {
      duration: 12,
      width: 576,
      height: 1024,
      cover: 'https://p16.example/c.jpg',
      bitrateInfo: [
        { GearName: 'adapt_540_1', CodecType: 'h265_hvc1', Bitrate: 900000, PlayAddr: { UrlList: ['https://v16-webapp-prime.us.tiktok.com/video/a?expire=1791500000', 'https://www.tiktok.com/aweme/v1/play/?file_id=a'] } },
        { GearName: 'normal_540_0', CodecType: 'h264', Bitrate: 1200000, PlayAddr: { UrlList: ['https://v16-webapp-prime.us.tiktok.com/video/b?expire=1791500000', 'https://www.tiktok.com/aweme/v1/play/?file_id=b'] } },
      ],
    },
  };
  const fi = itemToFeedItem(rawItem, { cookieHeader: 'tt_chain_token=x', referer: 'https://www.tiktok.com/explore' });
  check('feed item built', Boolean(fi), fi && fi.id);
  if (fi) {
    check('H.264 format sorted first', fi.formats[0].codec === 'h264' && fi.formats[0].id === 'normal_540_0', fi.formats.map((f) => f.id));
    check('direct (redirect) + proxy URLs present', fi.formats[0].directKind === 'redirect' && /^\/api\/media\//.test(fi.formats[0].proxyUrl || ''), fi.formats[0]);
    check('expiry parsed from the cookie-bound URL', fi.formats[0].expiresAt === 1791500000, fi.formats[0].expiresAt);
    check('author / stats / music mapped', fi.author.uniqueId === 'someone' && fi.stats.plays === 10 && fi.music === 'original sound', { author: fi.author, stats: fi.stats });
    check('canonical URL', fi.canonicalUrl === 'https://www.tiktok.com/@someone/video/7000000000000000001', fi.canonicalUrl);
  }
  check('item without video is skipped', itemToFeedItem({ id: '1' }) === undefined);
  check('item without any URL is skipped', itemToFeedItem({ id: '1', video: { bitrateInfo: [{ GearName: 'x', PlayAddr: { UrlList: [] } }] } }) === undefined);
  check('ad items are skipped (isAd, isSponsored, adInfo); a paid partnership is kept', itemToFeedItem({ ...rawItem, isAd: true }) === undefined && itemToFeedItem({ ...rawItem, isSponsored: true }) === undefined && itemToFeedItem({ ...rawItem, adInfo: { adId: '1' } }) === undefined && isTikTokAd({ ...rawItem, isAd: false, adInfo: {} }) === false && itemToFeedItem({ ...rawItem, isAd: false, brandedContent: true }) !== undefined);

  console.log('\n== 4. feed reservoir (offline)');
  await reservoirChecks();

  console.log('\n== 5. YouTube (offline)');
  check('youtube urls recognised', isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ') && isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ') && isYouTubeUrl('https://m.youtube.com/shorts/4wVIjM5Jczs') && !isYouTubeUrl('https://www.tiktok.com/@x/video/1'));
  check('video id from watch / shorts / youtu.be / embed', youTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1') === 'dQw4w9WgXcQ' && youTubeVideoId('https://www.youtube.com/shorts/4wVIjM5Jczs') === '4wVIjM5Jczs' && youTubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=x') === 'dQw4w9WgXcQ' && youTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
  check('no id for a channel or playlist url', youTubeVideoId('https://www.youtube.com/@MrBeast/shorts') === undefined && youTubeVideoId('https://www.youtube.com/playlist?list=PL123') === undefined);
  const flat = entryToFeedItem({
    id: 'rFZHOHl-L8A',
    title: 'lofi hip hop radio',
    url: 'https://www.youtube.com/watch?v=rFZHOHl-L8A',
    channel: 'Lofi Girl',
    channel_id: 'UCSJ4gkVC6NrvII8umztf0Ow',
    uploader_url: 'https://www.youtube.com/@LofiGirl',
    view_count: 14533130,
    duration: 3882,
    thumbnails: [
      { url: 'https://i.ytimg.com/vi/x/hq720.jpg?a', width: 360, height: 202 },
      { url: 'https://i.ytimg.com/vi/x/hq720.jpg?b', width: 720, height: 404 },
    ],
  });
  check('flat search entry -> feed item', Boolean(flat) && flat!.canonicalUrl === 'https://www.youtube.com/watch?v=rFZHOHl-L8A' && flat!.author.uniqueId === 'LofiGirl' && flat!.author.nickname === 'Lofi Girl' && flat!.stats.plays === 14533130 && flat!.duration === 3882 && flat!.formats.length === 0, flat);
  check('largest thumbnail chosen', flat?.cover === 'https://i.ytimg.com/vi/x/hq720.jpg?b', flat?.cover);
  const short = entryToFeedItem({ id: '4wVIjM5Jczs', title: 'cat', url: 'https://www.youtube.com/shorts/4wVIjM5Jczs', view_count: 3600000, thumbnails: [{ url: 'p', width: 405, height: 720 }, { url: 'l', width: 1280, height: 720 }] });
  check('thin shorts entry kept (author unknown), portrait thumbnail preferred', Boolean(short) && short!.author.uniqueId === undefined && short!.cover === 'p', short);
  check('live and invalid entries skipped', entryToFeedItem({ id: 'rFZHOHl-L8A', live_status: 'is_live' }) === undefined && entryToFeedItem({ id: 'nope' }) === undefined);
  const audio = pickAudio([
    { format_id: '139-20', url: 'u', vcodec: 'none', acodec: 'mp4a.40.5', protocol: 'https', abr: 49, format_note: 'English (US) original (default), low' },
    { format_id: '140-3', url: 'u', vcodec: 'none', acodec: 'mp4a.40.2', protocol: 'https', abr: 129.7, format_note: 'Spanish (US), medium' },
    { format_id: '140-20', url: 'u', vcodec: 'none', acodec: 'mp4a.40.2', protocol: 'https', abr: 129.7, format_note: 'English (US) original (default), medium' },
    { format_id: '140-20-drc', url: 'u', vcodec: 'none', acodec: 'mp4a.40.2', protocol: 'https', abr: 129.7, format_note: 'English (US) original (default), medium, DRC' },
    { format_id: '251', url: 'u', vcodec: 'none', acodec: 'opus', protocol: 'https', abr: 140 },
  ]);
  check('audio: original language at 128 kbps, no DRC, never opus', audio?.format_id === '140-20', audio?.format_id);
  check('audio: plain 140 wins over 139', pickAudio([{ format_id: '139', url: 'u', vcodec: 'none', acodec: 'mp4a.40.5', protocol: 'https', abr: 49 }, { format_id: '140', url: 'u', vcodec: 'none', acodec: 'mp4a.40.2', protocol: 'https', abr: 129 }])?.format_id === '140');

  console.log('\n== 6. YouTube sign-in: cookie text (offline)');
  const netscape = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSAPISID\tabc/def',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\tsid-value',
    '.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\ttz=UTC',
    '.example.com\tTRUE\t/\tFALSE\t0\tother\tx',
    '.google.com\tTRUE\t/\tTRUE\t1790000000\tHSID\thsid',
  ].join('\n');
  const parsed = parseCookiesText(netscape);
  check('netscape: youtube/google kept, other sites dropped, HttpOnly marked', parsed.cookies.length === 4 && parsed.cookies.find((c) => c.name === 'SID')?.httpOnly === true && parsed.cookies.find((c) => c.name === 'SAPISID')?.value === 'abc/def' && parsed.warnings.length === 1, parsed);
  const back = toNetscape(parsed.cookies);
  check('round trip keeps the HttpOnly prefix and session cookies', back.includes('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\tsid-value') && back.includes('\t0\tPREF\ttz=UTC') && parseCookiesText(back).cookies.length === 4);
  const json = JSON.stringify([
    { domain: '.youtube.com', name: '__Secure-3PAPISID', value: 'v', path: '/', secure: true, httpOnly: false, expirationDate: 1790000000.5 },
    { domain: '.youtube.com', name: 'LOGIN_INFO', value: 'l', path: '/', secure: true, httpOnly: true, session: true },
  ]);
  const fromJson = parseCookiesText(json);
  check('json export of a cookie extension', fromJson.cookies.length === 2 && fromJson.cookies[0].expires === 1790000000 && fromJson.cookies[1].httpOnly && fromJson.cookies[1].expires === 0, fromJson);
  const header = parseCookiesText('Cookie: SID=a; SAPISID=b; __Secure-3PAPISID=b; PREF=f6=8');
  check('cookie header line', header.cookies.length === 4 && header.cookies.every((c) => c.domain === '.youtube.com') && header.cookies.find((c) => c.name === 'PREF')?.value === 'f6=8');
  const googleOnly = parseCookiesText('.google.com\tTRUE\t/\tTRUE\t0\tSAPISID\tg\n.google.com\tTRUE\t/\tTRUE\t0\tSID\ts\n.google.com\tTRUE\t/\tTRUE\t0\tNID\tn');
  check('google.com-only export: account cookies copied to youtube.com', googleOnly.cookies.filter((c) => c.domain === '.youtube.com').map((c) => c.name).sort().join() === 'SAPISID,SID' && googleOnly.warnings.length === 1, googleOnly);
  for (const [label, text, status] of [
    ['empty text', '   ', 400],
    ['no cookies at all', 'hello world', 400],
    ['no sign-in cookie', '.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tx', 400],
  ] as const) {
    let got = 0;
    try {
      parseCookiesText(text);
    } catch (e) {
      got = e instanceof YouTubeSessionError ? e.status : -1;
    }
    check(`rejects ${label}`, got === status, got);
  }
  const hash = sapisidHash('abc', 1700000000000);
  check('SAPISIDHASH format', /^SAPISIDHASH 1700000000_[0-9a-f]{40}$/.test(hash), hash);
  const menuIn = { responseContext: { mainAppWebResponseContext: { loggedOut: false } }, actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { header: { activeAccountHeaderRenderer: { accountName: { simpleText: 'Mario' }, channelHandle: { simpleText: '@mario' }, accountPhoto: { thumbnails: [{ url: 's' }, { url: 'l' }] } } } } } } }] };
  const acc = accountFromMenu(menuIn);
  check('account menu: name, handle, largest avatar', acc.loggedIn && acc.name === 'Mario' && acc.handle === 'mario' && acc.avatar === 'l', acc);
  const out = accountFromMenu({ responseContext: { mainAppWebResponseContext: { loggedOut: true } }, actions: [] });
  check('account menu: signed out', out.ok && !out.loggedIn, out);

  console.log('\n== 7b. Facebook (offline)');
  check('facebook urls recognised', isFacebookUrl('https://www.facebook.com/reel/2221590032033460') && isFacebookUrl('https://fb.watch/abc123/') && isFacebookUrl('https://m.facebook.com/9gag/reels/') && isFacebookUrl('https://web.facebook.com/watch/?v=1') && !isFacebookUrl('https://www.instagram.com/reel/x/') && !isFacebookUrl('https://notfacebook.com/reel/1'));
  check('video id from reel / watch / page-videos urls', facebookVideoId('https://www.facebook.com/reel/2221590032033460') === '2221590032033460' && facebookVideoId('https://www.facebook.com/reel/2221590032033460/?mibextid=x') === '2221590032033460' && facebookVideoId('https://www.facebook.com/watch/?v=2221590032033460') === '2221590032033460' && facebookVideoId('https://www.facebook.com/9gag/videos/my-knees-could-never/2221590032033460/') === '2221590032033460' && facebookVideoId('https://www.facebook.com/9gag/videos/2221590032033460') === '2221590032033460' && facebookVideoId('https://www.facebook.com/9gag/reels/') === undefined && facebookVideoId('https://fb.watch/abc123/') === undefined);
  check('page from the search box', pageFromQuery('@9gag') === '9gag' && pageFromQuery('LADbible') === 'LADbible' && pageFromQuery('https://www.facebook.com/9gag/reels/') === '9gag' && pageFromQuery('https://www.facebook.com/profile.php?id=100064681269092') === '100064681269092' && pageFromQuery('https://www.facebook.com/reel/2221590032033460') === undefined && pageFromQuery('funny cats') === undefined && pageFromQuery('reel') === undefined);
  check('slug of an owner url', slugFromProfileUrl('https://www.facebook.com/9gag') === '9gag' && slugFromProfileUrl('https://www.facebook.com/profile.php?id=123456789') === '123456789' && slugFromProfileUrl(undefined, '123456789') === '123456789' && slugFromProfileUrl('https://www.facebook.com/reel/1', 'x') === undefined);
  // The records a Page's Reels tab carries (shape measured 2026-10-15), spread over two JSON scripts like Facebook does.
  const story = (id: string, caption: string, created: number, feedback: string, plays: string) => ({ node: { __typename: 'Story', short_form_video_context: { video: { id, __typename: 'Video', playable_duration_in_ms: 63402, owner: { __typename: 'User', id: '100064681269092' } }, playback_video: { aspect_ratio: 0.5625, height: 1920, width: 1080, length_in_second: 63.402, id, thumbnailImage: { uri: `https://scontent/${id}.jpg` }, preferred_thumbnail: { image: { uri: `https://scontent/${id}-pref.jpg` } } }, video_owner: { __typename: 'User', id: '100064681269092', name: '9GAG', is_verified: true, url: 'https://www.facebook.com/9gag', displayPicture: { uri: 'https://scontent/avatar.jpg' } }, track_title: '9GAG · Original audio', play_count_reduced: plays }, creation_time: created, feedback: { id: feedback }, message: { text: caption } } });
  const delivery = (id: string) => ({ __typename: 'Video', id, width: 1080, height: 1920, length_in_second: 63.402, videoDeliveryLegacyFields: { browser_native_hd_url: `https://video-hou1-1.xx.fbcdn.net/o1/v/${id}-hd.mp4?oe=6AD6CD6F&bitrate=1`, browser_native_sd_url: `https://video-hou1-1.xx.fbcdn.net/o1/v/${id}-sd.mp4?oe=6AD6CD6F`, id } });
  const script1 = JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['x', { __bbox: { result: { data: { user: { profile_reels: { edges: [{ cursor: 'c1', ...story('2221590032033460', 'My knees could never #9gag', 1791912781, 'fb1', '230K') }, { cursor: 'c2', ...story('1642273920789459', 'He is so proud #9gag', 1791675182, 'fb2', '2.2M') }], page_info: { end_cursor: 'c2', has_next_page: true } } }, viewer: {} } }, dash_manifest_xml_string: '<MPD/>' } }]]] } }]]] });
  const script2 = JSON.stringify({ require: [['RelayPrefetchedStreamCache', 'next', [], ['y', { __bbox: { result: { data: { attachments: [{ media: delivery('2221590032033460') }, { media: delivery('1642273920789459') }], feedbacks: [{ id: 'fb1', total_comment_count: 18 }, { id: 'fb2', total_comment_count: 123 }] } } } }]]], define: [['CurrentUserInitialData', [], { ACCOUNT_ID: '0', USER_ID: '0', NAME: '' }, 270]] });
  const pageHtml = `<!DOCTYPE html><html><head><title>9GAG Reels</title><meta property="og:description" content="9GAG Reels. 39,783,806 followers &#xb7; 598,231 talking about this. 9GAG is fun." /></head><body><script type="application/json" data-sjs>${script1}</script><script type="application/json" data-sjs>${script2}</script><script type="application/json" data-sjs>{"other":1}</script></body></html>`;
  const fbPage = extractReels(pageHtml);
  const r0 = fbPage.reels[0];
  check('reels tab: two reels joined from story + delivery + feedback records, in page order', fbPage.reels.length === 2 && r0?.id === '2221590032033460' && fbPage.reels[1].id === '1642273920789459' && r0.hdUrl!.includes('-hd.mp4') && r0.sdUrl!.includes('-sd.mp4') && r0.caption === 'My knees could never #9gag' && r0.createdAt === 1791912781 && r0.plays === 230000 && r0.comments === 18 && r0.width === 1080 && r0.height === 1920 && r0.duration === 63.402 && r0.cover === 'https://scontent/2221590032033460-pref.jpg' && r0.music === '9GAG · Original audio' && r0.owner.slug === '9gag' && r0.owner.name === '9GAG' && r0.owner.verified === true && fbPage.reels[1].plays === 2200000 && fbPage.reels[1].comments === 123, fbPage.reels);
  check('reels tab: title, has more, guest viewer, not a login wall', fbPage.title === '9GAG Reels' && fbPage.hasMore === true && fbPage.viewer.id === '0' && !fbPage.loginWall && !fbPage.notAvailable);
  const fbSummary = pageSummary('9GAG', fbPage);
  check('page summary: name from the title, followers from the description, owner from the reels', fbSummary.nickname === '9GAG' && fbSummary.followers === 39783806 && fbSummary.uniqueId === '9gag' && fbSummary.id === '100064681269092' && fbSummary.avatar === 'https://scontent/avatar.jpg' && fbSummary.verified === true, fbSummary);
  check('not available page', extractReels('<html><head><title>Facebook</title></head><body><script type="application/json">{"a":{"title":"This content isn\'t available right now"}}</script></body></html>').notAvailable === true);
  const reelPage = extractReels(`<html><head><title>Facebook</title><meta property="og:title" content="230K views &#xb7; 548 reactions | My knees | 9GAG" /></head><body><script type="application/json">${script1}</script><script type="application/json">${script2}</script></body></html>`);
  check("reel page: the og:title's views and reactions go to the page's own reel", reelPage.reels[0].plays === 230000 && reelPage.reels[0].likes === 548 && reelPage.reels[1].likes === undefined, reelPage.reels.map((r) => [r.plays, r.likes]));
  const fbItem = reelToFeedItem(r0);
  check('reel -> feed item: author slug, stats, hd then sd, direct + proxy urls, expiry from oe=', fbItem.id === '2221590032033460' && fbItem.author.uniqueId === '9gag' && fbItem.author.nickname === '9GAG' && fbItem.stats.plays === 230000 && fbItem.stats.comments === 18 && fbItem.formats.length === 2 && fbItem.formats[0].id === 'hd' && fbItem.formats[0].codec === 'h264' && fbItem.formats[0].directUrl!.includes('-hd.mp4') && /^\/api\/media\//.test(fbItem.formats[0].proxyUrl || '') && fbItem.formats[0].expiresAt === 0x6ad6cd6f && fbItem.formats[0].upstreamHost === 'video-hou1-1.xx.fbcdn.net' && fbItem.canonicalUrl === 'https://www.facebook.com/reel/2221590032033460', fbItem);
  check('playable: a url that runs out within the margin is not', playable(r0, 0x6ad6cd6f * 1000 - 3600_000) && !playable(r0, 0x6ad6cd6f * 1000 - 60_000) && !playable({ id: '1', owner: {} }));
  const fbNow = 0x6ad6cd6f * 1000 - 24 * 3600_000;
  const fbListing = (k: string) => (k === 'a' ? { at: fbNow - 1000, reels: [r0, fbPage.reels[1]] } : k === 'b' ? { at: fbNow - 5 * 3600_000, reels: [r0] } : k === 'c' ? { at: fbNow, reels: [{ id: '9', owner: {}, hdUrl: 'https://v/x.mp4?oe=00000001' }] } : undefined);
  const fbPlan = planFacebookFill(['a', 'b', 'c', 'd'], 0, fbListing, 10, fbNow);
  check('explore plan: fresh listing used, stale one used and queued, expired-url one queued, missing one queued', fbPlan.use.map((u) => u.slug).join() === 'a,b' && fbPlan.refresh.join() === 'b,c,d' && fbPlan.cursor === 4, fbPlan);
  check('categories: All plus some with pages, no duplicates inside one', FACEBOOK_CATEGORIES[0].id === 0 && FACEBOOK_CATEGORIES.length >= 4 && FACEBOOK_CATEGORIES.slice(1).every((c) => c.pages.length >= 3 && new Set(c.pages.map((p) => p.toLowerCase())).size === c.pages.length));
  const fbCookies = parseFacebookCookies(['# Netscape HTTP Cookie File', '.facebook.com\tTRUE\t/\tTRUE\t1790000000\tc_user\t100000000000001', '#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1790000000\txs\t12%3Aabc%3A2%3A1700000000%3A-1%3A-1', '.facebook.com\tTRUE\t/\tTRUE\t1790000000\tdatr\td', '.instagram.com\tTRUE\t/\tTRUE\t1790000000\tsessionid\tother'].join('\n'));
  check('facebook cookies: facebook.com kept, other sites dropped, thin export noted, header built', fbCookies.cookies.length === 3 && fbCookies.warnings.length === 2 && /1 cookie of other sites/.test(fbCookies.warnings[0]) && /no sb, fr/.test(fbCookies.warnings[1]) && cookieHeaderFor(fbCookies.cookies) === 'c_user=100000000000001; xs=12%3Aabc%3A2%3A1700000000%3A-1%3A-1; datr=d', fbCookies);
  for (const [label, text] of [['no xs', '.facebook.com\tTRUE\t/\tTRUE\t1790000000\tc_user\t1'], ['an instagram export', '.instagram.com\tTRUE\t/\tTRUE\t1790000000\tsessionid\tabc'], ['nothing', 'hello world']] as const) {
    let got = 0;
    try {
      parseFacebookCookies(text);
    } catch (e) {
      got = e instanceof FacebookSessionError ? e.status : -1;
    }
    check(`facebook cookies rejects ${label}`, got === 400, got);
  }
  const fbIn = accountFromPage(200, undefined, `<html><head><title>Settings</title></head><body><script type="application/json">${JSON.stringify({ define: [['CurrentUserInitialData', [], { ACCOUNT_ID: '100000000000001', USER_ID: '100000000000001', NAME: 'Mario DeLuca', SHORT_NAME: 'Mario' }, 270]] })}</script></body></html>`);
  check('settings page: a named viewer = signed in', fbIn.ok && fbIn.loggedIn && fbIn.id === '100000000000001' && fbIn.name === 'Mario DeLuca' && fbIn.shortName === 'Mario', fbIn);
  const fbOut = accountFromPage(302, 'https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Fsettings%2F', '');
  check('settings page: login redirect = signed out', fbOut.ok && !fbOut.loggedIn, fbOut);
  const fbCp = accountFromPage(302, 'https://www.facebook.com/checkpoint/1501092823525282/', '');
  check('settings page: checkpoint redirect flagged, no verdict', !fbCp.ok && fbCp.checkpoint === true, fbCp);
  check('settings page: 429 = limited; a guest page = no verdict', accountFromPage(429, undefined, '').limited === true && !accountFromPage(200, undefined, pageHtml).ok);
  check('profile slug from the /me/ redirect', slugFromMeRedirect('https://www.facebook.com/mario.deluca') === 'mario.deluca' && slugFromMeRedirect('https://www.facebook.com/profile.php?id=1') === undefined && slugFromMeRedirect('https://www.facebook.com/login.php?next=x') === undefined && slugFromMeRedirect(undefined) === undefined);

  console.log('\n== 7. Instagram (offline)');
  check('instagram urls recognised', isInstagramUrl('https://www.instagram.com/reel/DecPSQfoaRe/') && isInstagramUrl('https://instagr.am/p/DecPSQfoaRe') && isInstagramUrl('https://m.instagram.com/natgeo/') && !isInstagramUrl('https://www.tiktok.com/@x') && !isInstagramUrl('https://notinstagram.com/p/DecPSQfoaRe/'));
  check('post code from reel / p / user-reel / reels urls', ['https://www.instagram.com/reel/DecPSQfoaRe/', 'https://www.instagram.com/p/DecPSQfoaRe', 'https://www.instagram.com/natgeo/reel/DecPSQfoaRe/?igsh=x', 'https://www.instagram.com/reels/DecPSQfoaRe/'].every((u) => instagramCode(u) === 'DecPSQfoaRe') && instagramCode('https://www.instagram.com/natgeo/') === undefined && instagramCode('https://www.youtube.com/reel/DecPSQfoaRe/') === undefined);
  check('counts: 268M, 1.2K, 32,070', parseCount('268M') === 268000000 && parseCount('1.2K') === 1200 && parseCount('32,070') === 32070 && parseCount('x') === undefined);
  const meta = parseProfileMeta('natgeo', '268M Followers, 194 Following, 32,070 Posts - See Instagram photos and videos from National Geographic (@natgeo)', 'National Geographic (@natgeo) • Instagram photos and videos', 'https://x/a.jpg');
  check('profile meta: name, followers, following, posts', meta.nickname === 'National Geographic' && meta.followers === 268000000 && meta.following === 194 && meta.videos === 32070 && meta.avatar === 'https://x/a.jpg', meta);
  check('handle from the search box', handleFromQuery('@natgeo') === 'natgeo' && handleFromQuery('nasa') === 'nasa' && handleFromQuery('https://www.instagram.com/natgeo/') === 'natgeo' && handleFromQuery('https://www.instagram.com/reel/DecPSQfoaRe/') === undefined && handleFromQuery('funny cats') === undefined);
  check('cdn url expiry (oe= hex seconds)', urlExpiry('https://scontent.cdninstagram.com/o1/v/x.mp4?_nc_cat=1&oe=6AD04B1B&oh=00') === 0x6ad04b1b && urlExpiry('https://x/y.mp4?a=b') === undefined);
  const codes = new Set<string>();
  collectCodes({ data: { edges: [{ node: { media: { code: 'AbCdEfGh1', video_versions: [{ url: 'u' }], user: { code: 'NotAPost12' } } } }, { node: { media: { code: 'PhotoPost1', media_type: 1 } } }, { node: { media: { code: 'ClipPost_2', product_type: 'clips' } } }] } }, codes);
  check('codes of video posts in a graphql tree (photos and users skipped)', [...codes].sort().join() === 'AbCdEfGh1,ClipPost_2', [...codes]);
  // The Reels page's own JSON script (shape seen in a real browser 2026-10-13): the list sits ~16 levels down.
  const preloaded = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_PolarisClipsTabDesktopContainerQueryRelayPreloader_x', { __bbox: { complete: true, result: { data: { xdt_api__v1__clips__home__connection_v2: { edges: [{ node: { media: { __typename: 'XDTMediaDict', code: 'DeRGrknyuZv', video_versions: [{}] } } }, { node: { media: { code: 'DeapidhN3hr', media_type: 2 } } }] } } } } }]]] } }]]] };
  const deep = new Set<string>();
  collectCodes(preloaded, deep, 0, 40);
  check("codes in the Reels page's preloaded JSON (deep tree)", [...deep].sort().join() === 'DeRGrknyuZv,DeapidhN3hr', [...deep]);
  const kept = new Set<string>();
  const adCodes = new Set<string>();
  collectCodes({ items: [{ media: { code: 'OrganicRl1', video_versions: [{}] } }, { media: { code: 'InjectedAd', video_versions: [{}], injected: { ad_id: '9' } } }, { ad_id: '7', media: { code: 'WrappedAd2', product_type: 'clips' } }, { media: { code: 'Partnered3', media_type: 2, is_paid_partnership: true } }, { media: { code: 'NotAnAdOk4', clips_metadata: {}, injected: null } }] }, kept, 0, 14, adCodes);
  check('ad reels are left out (injected / ad_id); paid partnership kept; their codes reported', [...kept].sort().join() === 'NotAnAdOk4,OrganicRl1,Partnered3' && [...adCodes].sort().join() === 'InjectedAd,WrappedAd2', { kept: [...kept], adCodes: [...adCodes] });
  const it = embedToFeedItem({ code: 'DecPSQfoaRe', videoUrl: 'https://scontent-hou1-1.cdninstagram.com/o1/v/t2/f2/m86/x.mp4?oe=6AD04B1B', width: 1080, height: 1920, duration: 30.03, views: 30472, likes: 6830, comments: 60, caption: 'hello', cover: 'https://scontent/c.jpg', music: 'Original audio · natgeo', owner: { id: '787132', username: 'natgeo', fullName: 'National Geographic', avatar: 'https://scontent/a.jpg' } });
  const f0 = it.formats[0];
  check('embed -> feed item: author, stats, direct + proxy url', it.id === 'DecPSQfoaRe' && it.author.uniqueId === 'natgeo' && it.stats.likes === 6830 && it.stats.plays === 30472 && f0.codec === 'h264' && f0.directUrl!.endsWith('oe=6AD04B1B') && /^\/api\/media\//.test(f0.proxyUrl || '') && f0.expiresAt === 0x6ad04b1b && !f0.audioProxyUrl, it);
  check('categories: All plus 10 with accounts, no duplicates inside one', INSTAGRAM_CATEGORIES[0].id === 0 && INSTAGRAM_CATEGORIES.length === 11 && INSTAGRAM_CATEGORIES.slice(1).every((c) => c.accounts.length >= 4 && new Set(c.accounts).size === c.accounts.length));
  const acct = accountFromAnswer(200, JSON.stringify({ user: { username: 'mario', full_name: 'Mario D', profile_pic_url: 'p' }, status: 'ok' }));
  check('account answer: signed in', acct.ok && acct.loggedIn && acct.username === 'mario' && acct.name === 'Mario D', acct);
  const form = accountFromAnswer(200, JSON.stringify({ form_data: { username: 'mario', first_name: 'Mario D', email: 'x' }, status: 'ok' }));
  check('account answer: settings form data names the account', form.ok && form.loggedIn && form.username === 'mario' && form.name === 'Mario D', form);
  const shell = accountFromAnswer(200, '<!DOCTYPE html><html class="_9dls"><head><style>:root{--fds-black:#000}</style></head><body>Instagram</body></html>');
  check('account answer: the web app page is no verdict', !shell.ok && !shell.limited, shell);
  const gone = accountFromAnswer(401, JSON.stringify({ message: 'login_required', require_login: true, status: 'fail' }));
  check('account answer: signed out', gone.ok && !gone.loggedIn, gone);
  check('account answer: a 429 is not an answer', !accountFromAnswer(429, 'slow down').ok);
  const limited = accountFromAnswer(429, '<html><body><h1>Please wait a few minutes before you try again.</h1></body></html>');
  check('account answer: 429 = the address is limited, body in the error', !limited.ok && limited.limited === true && /Please wait a few minutes/.test(limited.error || ''), limited);
  const throttled = accountFromAnswer(401, JSON.stringify({ message: 'Please wait a few minutes before you try again.', require_login: true, status: 'fail' }));
  check('account answer: the throttle text with require_login is not a sign-out', !throttled.ok && throttled.limited === true, throttled);
  const uaMismatch = accountFromAnswer(429, JSON.stringify({ message: 'useragent mismatch', status: 'fail' }));
  check('account answer: useragent mismatch is named, not limited', !uaMismatch.ok && !uaMismatch.limited && /browser identity/.test(uaMismatch.error || ''), uaMismatch);
  const cp = accountFromAnswer(400, JSON.stringify({ message: 'checkpoint_required', checkpoint_url: '/challenge/x/', status: 'fail' }));
  check('account answer: checkpoint flagged, not signed out', !cp.ok && cp.checkpoint === true, cp);
  check('body hint strips markup and folds space', bodyHint('<html><head><style>a{}</style><script>var x=1;</script></head><body> <p>Please   wait</p>\n<b>now</b></body></html>') === 'Please wait now' && bodyHint('x'.repeat(200)).length === 141);
  check('sent away: login / rate-limit flag / checkpoint / neither', sentAway('https://www.instagram.com/accounts/login/?next=%2Freels%2F')?.kind === 'login' && sentAway('https://www.instagram.com/accounts/login/?next=%2Fnatgeo%2Freels%2F&is_from_rle')?.kind === 'limited' && sentAway('https://www.instagram.com/challenge/action/AX/')?.kind === 'checkpoint' && sentAway('https://www.instagram.com/accounts/suspended/')?.kind === 'checkpoint' && sentAway('https://www.instagram.com/reels/DecPSQfoaRe/') === undefined && sentAway('not a url') === undefined);
  const H = 3600_000;
  const now = 100 * H;
  const cat: Record<string, { at: number; codes: string[] }> = {
    a: { at: now - H, codes: Array.from({ length: 12 }, (_, i) => 'aaaaa' + i) },
    b: { at: now - 30 * H, codes: Array.from({ length: 12 }, (_, i) => 'bbbbb' + i) },
    d: { at: now - 2 * H, codes: Array.from({ length: 12 }, (_, i) => 'ddddd' + i) },
  };
  const plan = planExploreFill(['A', 'b', 'c', 'd', 'e'], 0, (k) => cat[k], 30, now);
  check('explore plan: old listings used at once, missing and old ones queued, stops at want', plan.use.map((u) => u.handle).join() === 'A,b,d' && plan.refresh.join() === 'b,c' && plan.cursor === 4, plan);
  const cold = planExploreFill(['x', 'y'], 5, () => undefined, 30, now);
  check('explore plan: nothing listed walks one lap and queues every account', cold.use.length === 0 && cold.refresh.join() === 'y,x' && cold.cursor === 7, cold);
  const chromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36';
  const m = uaMetadata(chromeUa);
  check('ua metadata: windows chrome brands/platform/full versions', m?.platform === 'Windows' && m.brands.some((b) => b.brand === 'Google Chrome' && b.version === '141') && m.fullVersion === '141.0.7390.55' && m.fullVersionList.some((b) => b.brand === 'Google Chrome' && b.version === '141.0.7390.55') && m.bitness === '64' && m.mobile === false, m);
  const edge = uaMetadata(chromeUa + ' Edg/141.0.3537.57');
  check('ua metadata: edge brand and full version, firefox none', edge?.brands.some((b) => b.brand === 'Microsoft Edge' && b.version === '141') === true && edge?.fullVersion === '141.0.3537.57' && edge?.fullVersionList.some((b) => b.brand === 'Microsoft Edge' && b.version === '141.0.3537.57') === true && uaMetadata('Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0') === undefined);
  check('ua metadata: android chrome is mobile without bitness', uaMetadata('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')?.mobile === true && uaMetadata('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')?.bitness === '');
  check('clean user agent', cleanUserAgent(' ' + chromeUa + ' ') === chromeUa && cleanUserAgent('short') === undefined && cleanUserAgent('bad\nvalue'.padEnd(40, 'x')) === undefined && cleanUserAgent(42) === undefined);
  const igText = ['# Netscape HTTP Cookie File', '.instagram.com\tTRUE\t/\tTRUE\t1790000000\tsessionid\t123%3Aabc', '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1790000000\tcsrftoken\ttok', '.instagram.com\tTRUE\t/\tTRUE\t1790000000\tds_user_id\t123', '.facebook.com\tTRUE\t/\tTRUE\t1790000000\txs\tother'].join('\n');
  const igParsed = parseInstagramCookies(igText);
  check('instagram cookies: instagram.com kept, other sites dropped, thin export noted', igParsed.cookies.length === 3 && igParsed.warnings.length === 2 && /1 cookie of other sites/.test(igParsed.warnings[0]) && /no mid, ig_did, datr/.test(igParsed.warnings[1]) && igParsed.cookies.find((c) => c.name === 'csrftoken')?.httpOnly === true, igParsed);
  const igHeader = parseInstagramCookies('Cookie: sessionid=123%3Aabc; csrftoken=tok; mid=zz');
  check('instagram cookies: header line lands on instagram.com', igHeader.cookies.length === 3 && igHeader.cookies.every((c) => c.domain === '.instagram.com'), igHeader);
  const full = parseInstagramCookies('sessionid=123%3Aabc; csrftoken=tok; mid=zz; ig_did=d; datr=e; ds_user_id=123');
  check('instagram cookies: a complete export has no warning', full.cookies.length === 6 && full.warnings.length === 0, full.warnings);
  check('cookies look signed in: account id from the sessionid', cookiesLookSignedIn(igParsed.cookies).userId === '123' && cookiesLookSignedIn(igHeader.cookies).userId === '123');
  const base = igParsed.cookies[0];
  check('cookies look signed in: a mixed export is refused', !cookiesLookSignedIn([{ ...base, name: 'sessionid', value: '999%3Aabc' }, { ...base, name: 'ds_user_id', value: '123' }]).ok);
  check('cookies look signed in: an odd sessionid needs ds_user_id', !cookiesLookSignedIn([{ ...base, name: 'sessionid', value: 'IGSCabcdef' }]).ok && cookiesLookSignedIn([{ ...base, name: 'sessionid', value: 'IGSCabcdef' }, { ...base, name: 'ds_user_id', value: '123' }]).userId === '123');
  for (const [label, text] of [['no sessionid', '.instagram.com\tTRUE\t/\tTRUE\t1790000000\tcsrftoken\ttok'], ['a youtube export', '.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSAPISID\tabc'], ['nothing', 'hello world']] as const) {
    let got = 0;
    try {
      parseInstagramCookies(text);
    } catch (e) {
      got = e instanceof InstagramSessionError ? e.status : -1;
    }
    check(`instagram cookies rejects ${label}`, got === 400, got);
  }
}

/** A fake item: one format whose play URL expires at `expiresAt` (unix seconds; undefined = unknown). */
const fakeItem = (id: string, expiresAt?: number): FeedItem => ({
  id,
  canonicalUrl: 'https://www.tiktok.com/@x/video/' + id,
  author: {},
  stats: {},
  formats: [{ id: 'f', label: 'f', codec: 'h264', requiresCookies: true, directUrl: 'https://www.tiktok.com/aweme/v1/play/?x=' + id, expiresAt }],
});

async function downloaderChecks(): Promise<void> {
  console.log('\n== 2b. Video Downloader (offline)');
  check('source of a link', downloadSourceOf('https://youtu.be/jNQXAC9IVRw') === 'youtube' && downloadSourceOf('https://www.tiktok.com/@a/video/1') === 'tiktok' && downloadSourceOf('https://example.com/v') === 'other');
  // what yt-dlp lists for a YouTube video: video-only H.264 / VP9 / AV1 at several heights, two AAC tracks, an Opus one, a muxed 360p
  const yt = [
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 1000, protocol: 'https', url: 'https://a/140', format_note: 'medium' },
    { format_id: '139', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.5', abr: 48, filesize: 400, protocol: 'https', url: 'https://a/139' },
    { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 140, filesize: 1100, protocol: 'https', url: 'https://a/251' },
    { format_id: '136', ext: 'mp4', vcodec: 'avc1.64001f', acodec: 'none', height: 720, width: 1280, fps: 30, tbr: 1500, filesize: 9000, protocol: 'https', url: 'https://a/136' },
    { format_id: '247', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 720, width: 1280, fps: 30, tbr: 1200, filesize: 7000, protocol: 'https', url: 'https://a/247' },
    { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, fps: 30, tbr: 3000, filesize_approx: 20000, protocol: 'https', url: 'https://a/137' },
    { format_id: '299', ext: 'mp4', vcodec: 'avc1.64002a', acodec: 'none', height: 1080, width: 1920, fps: 60, tbr: 4500, filesize: 30000, protocol: 'https', url: 'https://a/299' },
    { format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 2160, width: 3840, fps: 30, tbr: 12000, filesize: 90000, protocol: 'https', url: 'https://a/313' },
    { format_id: '401', ext: 'mp4', vcodec: 'av01.0.12M.08', acodec: 'none', height: 2160, width: 3840, fps: 30, tbr: 11000, filesize: 80000, protocol: 'https', url: 'https://a/401' },
    { format_id: 'sb0', ext: 'mhtml', vcodec: 'none', acodec: 'none', height: 90, protocol: 'mhtml', url: 'https://a/sb', format_note: 'storyboard' },
    { format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, width: 640, fps: 30, tbr: 500, filesize: 4000, protocol: 'https', url: 'https://a/18' },
  ];
  const { options, plans } = buildOptions(yt);
  const opt = (id: string) => options.find((o) => o.id === id);
  check('one option per height (60 fps apart), highest first, audio last', options.map((o) => o.id).join(' ') === 'v2160 v1080p60 v1080 v720 v360 audio', options.map((o) => o.id));
  check('H.264 preferred over VP9 at the same height', plans.get('v720')?.spec === '136+140' && opt('v720')?.detail === 'MP4 · H.264 + AAC', plans.get('v720'));
  check('VP9 preferred over AV1 where there is no H.264', plans.get('v2160')?.spec === '313+140' && /VP9/.test(opt('v2160')?.detail || ''), plans.get('v2160'));
  check('sizes add video + audio, approximate when either is', opt('v720')?.sizeBytes === 10000 && opt('v720')?.sizeIsEstimate === false && opt('v1080')?.sizeIsEstimate === true, [opt('v720'), opt('v1080')]);
  check('a muxed format is not merged', plans.get('v360')?.spec === '18' && plans.get('v360')?.merge === false, plans.get('v360'));
  check('the best fit is the top H.264 option at 1080p or below', options.find((o) => o.recommended)?.id === 'v1080p60');
  check('audio only = the AAC track', plans.get('audio')?.spec === '140' && opt('audio')?.ext === 'm4a', opt('audio'));
  check('file name: title cleaned, id when empty', saveName('A / B: "C"?  ', 'x', 'mp4') === 'A B C.mp4' && saveName(undefined, 'abc', 'm4a') === 'video-abc.m4a', saveName('A / B: "C"?  ', 'x', 'mp4'));
  check('option labels name the shorter side (a vertical Short is 1080p, not 1920p)', buildOptions([{ format_id: '1', url: 'https://x/v', protocol: 'https', vcodec: 'avc1.64001f', acodec: 'none', width: 1080, height: 1920, fps: 30, filesize: 10 }, { format_id: '2', url: 'https://x/a', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 2 }]).options[0].label === '1080p');

  console.log('\n== 2c. Video Library (offline)');
  check('link normalised: scheme added, fragment dropped', normalizeUrl('youtu.be/jNQXAC9IVRw#t=1') === 'https://youtu.be/jNQXAC9IVRw');
  let badLink = '';
  try {
    normalizeUrl('ftp://example.com/x.mp4');
  } catch (e) {
    badLink = (e as Error).message;
  }
  check('non-http links refused', /http/.test(badLink), badLink);
  check('youtube canonical form: watch?v=ID from any form', canonicalize('https://youtu.be/jNQXAC9IVRw?t=3').canonicalUrl === 'https://www.youtube.com/watch?v=jNQXAC9IVRw' && canonicalize('https://m.youtube.com/shorts/jNQXAC9IVRw').canonicalUrl === 'https://www.youtube.com/watch?v=jNQXAC9IVRw' && canonicalize('https://youtu.be/jNQXAC9IVRw').sourceId === 'jNQXAC9IVRw');
  check('tiktok canonical form: by video id; short links keep their url until looked up', canonicalize('https://www.tiktok.com/@tiktok/video/7693184538704416031?lang=en').canonicalUrl === 'https://www.tiktok.com/video/7693184538704416031' && canonicalize('https://vm.tiktok.com/ZMabc123/').sourceId === undefined);
  check('instagram / facebook canonical forms', canonicalize('https://www.instagram.com/reels/C9abcDEFghi/?igsh=1').canonicalUrl === 'https://www.instagram.com/reel/C9abcDEFghi/' && canonicalize('https://www.facebook.com/reel/1234567890').canonicalUrl === 'https://www.facebook.com/reel/1234567890');
  check('other links pass through as they are', canonicalize('https://example.com/videos/clip.mp4?x=1').source === 'other' && canonicalize('https://example.com/videos/clip.mp4?x=1').canonicalUrl === 'https://example.com/videos/clip.mp4?x=1');
  let notVideo = '';
  try {
    canonicalize('https://www.youtube.com/@somechannel');
  } catch (e) {
    notVideo = (e as Error).message;
  }
  check('a youtube channel link is not a video', /not a YouTube video/.test(notVideo), notVideo);
}

async function reservoirChecks(): Promise<void> {
  let now = 1_000_000;
  const clock = () => now;
  // Source: numbered items, with every batch repeating the previous batch's last 3 ids (like TikTok's random overlap).
  let next = 1;
  let calls = 0;
  let fail = 0;
  const source = async ({ count }: { count: number }) => {
    calls++;
    if (fail > 0) {
      fail--;
      throw new Error('empty body');
    }
    const items: FeedItem[] = [];
    for (let i = Math.max(1, next - 3); i < next; i++) items.push(fakeItem('v' + i));
    for (let i = 0; i < count; i++) items.push(fakeItem('v' + next++));
    return { items, warnings: [] };
  };
  const r = new Reservoir('test', source, { target: 20, low: 10, batch: 10, gapMs: 0, idleMs: 60_000, now: clock });
  const t1 = await r.take(5);
  check('empty stock waits for one fill and serves from it', t1.items.length === 5 && !t1.fromStock && calls === 1, { got: t1.items.length, calls });
  await new Promise((res) => setTimeout(res, 30));
  check('a low stock is refilled in the background', r.ready >= 10 && calls === 2, { ready: r.ready, calls });
  const t2 = await r.take(10);
  const seen = new Set<string>([...t1.items, ...t2.items].map((i) => i.id));
  check('second take served from stock, no duplicates', t2.fromStock && t2.items.length === 10 && seen.size === 15, { ids: t2.items.map((i) => i.id) });
  await new Promise((res) => setTimeout(res, 30));
  let drained = 0;
  while (r.ready > 0) drained += (await r.take(10)).items.length;
  check('the stock drains without repeating ids', drained > 0, { drained, calls });
  // Idle: no take() for longer than idleMs -> no background fill.
  now += 61_000;
  const callsBefore = calls;
  await new Promise((res) => setTimeout(res, 30));
  check('an idle reservoir stops asking the source', calls === callsBefore, { calls, callsBefore });
  // A failing source: take() surfaces the error, the next take retries.
  fail = 1;
  let err = '';
  try {
    await r.take(5);
  } catch (e) {
    err = (e as Error).message;
  }
  check('empty stock + source failure -> error surfaced', /empty body/.test(err), err);
  now += 5000;
  const t3 = await r.take(5);
  check('the next take retries the source and recovers', t3.items.length === 5, { got: t3.items.length });
  r.stop();
  // The last good batch: an empty stock answers with earlier videos at once, while the fill runs.
  resetLastBatches();
  const staleFile = path.join(lastFeedDir(), 'test-stale.json');
  try {
    const slow = new Reservoir('stale-test', source, { target: 20, low: 10, batch: 10, gapMs: 0, idleMs: 60_000, now: clock, persistKey: 'test-stale' });
    const first = await slow.take(10);
    check('persisted reservoir: first take fills and serves fresh items', first.items.length === 10 && !first.stale, { got: first.items.length });
    await new Promise((res) => setTimeout(res, 30));
    const servedBefore = new Set(first.items.map((i) => i.id));
    while (slow.ready > 0) for (const i of (await slow.take(10)).items) servedBefore.add(i.id);
    fail = 2; // the source refuses the next two fills (the wait, then the one behind the stale answer): the stale batch must not depend on it
    const callsAtEmpty = calls;
    const t0 = Date.now();
    check('a viewer with videos on screen gets no stale batch (waits for the source)', (await slow.take(10).then(() => false, () => true)) && Date.now() - t0 >= 0, { calls });
    now += 5000;
    const stale = await slow.take(10, true);
    check('empty stock answers at once with earlier videos (stale)', stale.stale === true && stale.items.length === STALE_BATCH && Date.now() - t0 < 500, { got: stale.items.length, stale: stale.stale, ms: Date.now() - t0 });
    check('the stale items were served on an earlier take', stale.items.every((i) => servedBefore.has(i.id)), { ids: stale.items.map((i) => i.id) });
    check('a fill was started alongside the stale answer', calls === callsAtEmpty + 2, { calls, callsAtEmpty });
    await new Promise((res) => setTimeout(res, 30));
    const again = await slow.take(10, true);
    check('the next stale answer continues the batch without repeating', again.stale === true && again.items.every((i) => !stale.items.some((j) => j.id === i.id)), { ids: again.items.map((i) => i.id) });
    now += 5000;
    await new Promise((res) => setTimeout(res, 30));
    const fresh = await slow.take(10);
    check('once the source answers, takes are fresh again', fresh.items.length === 10 && !fresh.stale, { got: fresh.items.length, stale: fresh.stale });
    await new Promise((res) => setTimeout(res, 60)); // the background top-up after the last take
    const readyBefore = slow.ready;
    const cheap = slow.takeCheap(3);
    check('a prefetch takes from the stock without starting anything', !!cheap && cheap.items.length === 3 && cheap.fromStock && slow.ready === readyBefore - 3, { got: cheap?.items.length, readyBefore, ready: slow.ready });
    // The home screen: a known feed with a low stock is topped up in the background; a full one is left alone.
    while (slow.ready > 0) await slow.take(10);
    const callsBeforeWarm = calls;
    check('warm-up tops a known, empty stock up', slow.warmIfKnown() === true, { ready: slow.ready });
    await new Promise((res) => setTimeout(res, 40));
    check('the warm-up fill ran', calls === callsBeforeWarm + 1 && slow.ready > 0, { calls, callsBeforeWarm, ready: slow.ready });
    check('warm-up leaves a stock at or above the low mark alone', slow.ready < 10 || slow.warmIfKnown() === false, { ready: slow.ready });
    await new Promise((res) => setTimeout(res, 40)); // any top-up that followed
    const readyAfter = slow.ready;
    slow.stop();
    await new Promise((res) => setTimeout(res, 700)); // the file writes are asynchronous (the stock one coalesced)
    check('the last good batch is on disk', fs.existsSync(staleFile), staleFile);
    const again2 = new Reservoir('stale-test-2', source, { target: 20, low: 10, batch: 10, gapMs: 0, idleMs: 60_000, now: clock, persistKey: 'test-stale' });
    check('a new reservoir starts with the stock the last one saved', again2.ready === readyAfter && readyAfter > 0, { ready: again2.ready, readyAfter });
    again2.stop();
  } finally {
    try {
      fs.rmSync(staleFile, { force: true });
      fs.rmSync(path.join(lastFeedDir(), 'test-stale.stock.json'), { force: true });
    } catch {
      /* nothing written */
    }
  }
  check('expiredSoon: unknown expiry is kept', !expiredSoon(fakeItem('a'), 1000));
  check('expiredSoon: far expiry is kept, near one dropped', !expiredSoon(fakeItem('a', 2000), 1000) && expiredSoon(fakeItem('a', 1), 1000));
}

const TEST_PASSWORD = 'test-password';

async function network(): Promise<void> {
  // A known password for this run (the real one is only stored as a hash).
  const crypto = await import('node:crypto');
  const salt = crypto.randomBytes(16);
  process.env.APP_PASSWORD_HASH = `scrypt:${salt.toString('hex')}:${crypto.scryptSync(TEST_PASSWORD, salt, 32).toString('hex')}`;
  // A throw-away cookie secret for this run (no file is written next to the real profile directory).
  process.env.APP_COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const http = await import('node:http');
  let cookie = '';
  /** A string body is sent as a form (the login page), anything else as JSON. */
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const form = typeof body === 'string';
      const data = body ? Buffer.from(form ? body : JSON.stringify(body)) : undefined;
      const req = http.request(
        base + p,
        {
          method,
          headers: {
            ...(data ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': String(data.length) } : {}),
            origin: 'http://localhost:5173',
            ...(cookie ? { cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  try {
    console.log('\n== site password');
    const health = await call('GET', '/api/health');
    check('health is public', health.status === 200, health.status);
    const noCookieApi = await call('POST', '/api/resolve', { url: TEST_MP4 });
    check('API without cookie -> 401', noCookieApi.status === 401, noCookieApi.status);
    const noCookiePage = await call('GET', '/feed.html?x=1');
    check('page without cookie -> redirect to /login', noCookiePage.status === 303 && noCookiePage.headers.location === '/login?next=%2Ffeed.html%3Fx%3D1', noCookiePage.headers.location);
    const loginPage = await call('GET', '/login?next=/feed.html');
    check('login page is served', loginPage.status === 200 && loginPage.body.toString().includes('name="password"'), loginPage.status);
    const wrong = await call('POST', '/login', 'password=nope&next=%2Ffeed.html');
    check('wrong password -> 401, no cookie', wrong.status === 401 && !wrong.headers['set-cookie'], wrong.status);
    const evil = await call('POST', '/login', `password=${TEST_PASSWORD}&next=%2F%2Fevil.example`);
    check('open redirect refused', evil.status === 303 && evil.headers.location === '/', evil.headers.location);
    // Browsers drop tabs/newlines before parsing: "/\t/evil.example" would become "//evil.example".
    for (const [label, next] of [
      ['tab', '%2F%09%2Fevil.example'],
      ['newline', '%2F%0A%2Fevil.example'],
      ['backslash', '%2F%5Cevil.example'],
      ['scheme', 'https%3A%2F%2Fevil.example%2F'],
    ]) {
      const r = await call('POST', '/login', `password=${TEST_PASSWORD}&next=${next}`);
      check(`open redirect refused (${label})`, r.status === 303 && r.headers.location === '/', r.headers.location);
    }
    const ok = await call('POST', '/login', `password=${encodeURIComponent(TEST_PASSWORD)}&next=%2Ffeed.html%3Fx%3D1`);
    const setCookie = String(ok.headers['set-cookie'] || '');
    check('right password -> cookie + redirect (query kept)', ok.status === 303 && ok.headers.location === '/feed.html?x=1' && /^sa_auth=\d+\.[\w-]{43};.*HttpOnly/.test(setCookie), { status: ok.status, setCookie });
    const forged = await call('GET', '/api/session', undefined, { cookie: setCookie.split(';')[0].replace(/=\d+\./, '=1.') });
    check('forged cookie -> 401', forged.status === 401, forged.status);
    // A token signed the way an attacker who read the public repository would try: HMAC with a key
    // derived from the (public) password hash alone must NOT be accepted.
    const issued = Math.floor(Date.now() / 1000);
    const publicKey = crypto.createHash('sha256').update('streamanywhere-cookie|' + process.env.APP_PASSWORD_HASH).digest();
    const minted = `${issued}.${crypto.createHmac('sha256', publicKey).update(`sa1.${issued}`).digest('base64url')}`;
    const mintedRes = await call('GET', '/api/session', undefined, { cookie: `sa_auth=${minted}` });
    check('cookie minted from the public hash alone -> 401', mintedRes.status === 401, mintedRes.status);
    cookie = setCookie.split(';')[0];
    const withCookie = await call('GET', '/api/session');
    check('API with cookie -> 200', withCookie.status === 200, withCookie.status);
    // Behind the loopback proxy (Caddy) the client address comes from X-Forwarded-For, so the per-IP
    // /login limit (10 a minute) is per visitor: 10 wrong attempts from one address do not lock out another.
    for (let i = 0; i < 10; i++) await call('POST', '/login', 'password=nope&next=%2F', { 'x-forwarded-for': '203.0.113.9' });
    const limited = await call('POST', '/login', 'password=nope&next=%2F', { 'x-forwarded-for': '203.0.113.9' });
    check('11th wrong password from one address -> 429', limited.status === 429, limited.status);
    const other = await call('POST', '/login', `password=${encodeURIComponent(TEST_PASSWORD)}&next=%2F`, { 'x-forwarded-for': '198.51.100.7' });
    check('another address still signs in', other.status === 303, other.status);

    console.log('\n== 3. Proxy Range relay (public CORS MP4)');
    const r = await call('POST', '/api/resolve', { url: TEST_MP4 });
    check('resolve passthrough 200', r.status === 200, r.status);
    const resolved = JSON.parse(r.body.toString()) as ResolveResponse;
    const f = resolved.formats[0];
    check('server probe sees ACAO *', f.serverProbe?.headers.accessControlAllowOrigin === '*', f.serverProbe?.headers);
    check('proxy url offered (host allowlisted)', typeof f.proxyUrl === 'string', f.proxyUrl);
    if (f.proxyUrl) {
      const ranged = await call('GET', f.proxyUrl, undefined, { range: 'bytes=4-11' });
      check('proxy returns 206 for Range', ranged.status === 206, ranged.status);
      check('proxy forwards Content-Range', /^bytes 4-11\/\d+$/.test(String(ranged.headers['content-range'])), ranged.headers['content-range']);
      check('proxy body is the ftyp box tag', ranged.body.toString('latin1').startsWith('ftyp'), ranged.body.toString('latin1'));
      check('proxy sets CORS origin', ranged.headers['access-control-allow-origin'] === 'http://localhost:5173', ranged.headers['access-control-allow-origin']);
      check('proxy exposes Content-Range', String(ranged.headers['access-control-expose-headers']).includes('Content-Range'));
      const head = await call('HEAD', f.proxyUrl);
      check('proxy HEAD 200 with Content-Length', head.status === 200 && Number(head.headers['content-length']) > 0, head.headers['content-length']);
      const open = await call('GET', '/api/media/doesnotexist');
      check('unknown media id -> 404', open.status === 404);
    }
    const bad = await call('POST', '/api/resolve', { url: 'https://example.com/video.mp4' });
    const badJson = JSON.parse(bad.body.toString()) as ResolveResponse;
    check('non-allowlisted host gets no proxy url', bad.status === 200 && badJson.formats[0].proxyUrl === undefined, badJson.warnings);

    console.log('\n== explore feed (network)');
    const feed = await call('POST', '/api/feed', { source: 'explore', count: 6 }, { origin: 'http://localhost:5173' });
    check('explore feed 200', feed.status === 200, feed.status === 200 ? undefined : feed.body.toString().slice(0, 300));
    if (feed.status === 200) {
      const fj = JSON.parse(feed.body.toString()) as FeedResponse;
      check('explore feed has items', fj.items.length > 0, { items: fj.items.length, warnings: fj.warnings });
      const first = fj.items[0];
      if (first) {
        const f0 = first.formats[0];
        check('feed item has author, id and an H.264 or playable format', Boolean(first.id && first.author.uniqueId && f0), { id: first.id, author: first.author.uniqueId, format: f0?.id });
        check('feed format offers a direct URL and a proxy URL', Boolean(f0?.directUrl && f0?.proxyUrl), { direct: f0?.directKind, proxy: f0?.proxyUrl });
        if (f0?.proxyUrl) {
          const viaProxy = await call('GET', f0.proxyUrl, undefined, { range: 'bytes=0-15' });
          check('feed item via proxy -> 206 and MP4 bytes', viaProxy.status === 206 && viaProxy.body.toString('latin1').includes('ftyp'), { status: viaProxy.status, host: viaProxy.headers['x-proxy-upstream-host'] });
        }
        if (f0?.directUrl) {
          const { res, status } = await openUpstream(f0.directUrl, { allowlist: ['*.tiktok.com', '*.tiktokcdn.com', '*.tiktokcdn-us.com', '*.tiktokcdn-eu.com'], maxRedirects: 5, headers: { range: 'bytes=0-15', origin: 'http://localhost:5173' } });
          const acao = res.headers['access-control-allow-origin'];
          res.destroy();
          check('feed direct URL without cookies -> 206 with ACAO *', status === 206 && acao === '*', { status, acao });
        }
      }
    }
    const session = await call('GET', '/api/session');
    check('session status endpoint answers', session.status === 200 && typeof JSON.parse(session.body.toString()).state === 'string', JSON.parse(session.body.toString()));

    console.log(`\n== 4. Live TikTok resolution (${TIKTOK_URL})`);
    const t = await call('POST', '/api/resolve', { url: TIKTOK_URL });
    check('resolve tiktok 200', t.status === 200, t.status === 200 ? undefined : t.body.toString().slice(0, 300));
    if (t.status === 200) {
      const tt = JSON.parse(t.body.toString()) as ResolveResponse;
      console.log(`   resolver=${tt.resolver} id=${tt.id} author=${tt.author} ${tt.width}x${tt.height} ${tt.duration}s formats=${tt.formats.length}`);
      const h264 = tt.formats.find((x) => x.codec === 'h264');
      check('has an H.264 format', Boolean(h264), tt.formats.map((x) => x.id + ':' + x.codec));
      if (h264) {
        check('H.264 format has a cookie-free direct URL', Boolean(h264.directUrl), h264.directKind);
        check('server probe of direct URL: 206 + ACAO *', h264.serverProbe?.status === 206 && h264.serverProbe.headers.accessControlAllowOrigin === '*', h264.serverProbe?.headers);
        // The cookie-bound URL must fail without cookies and succeed via the proxy
        if (h264.proxyUrl) {
          const viaProxy = await call('GET', h264.proxyUrl, undefined, { range: 'bytes=0-15' });
          check('TikTok via proxy -> 206 and MP4 bytes', viaProxy.status === 206 && viaProxy.body.toString('latin1').includes('ftyp'), { status: viaProxy.status, host: viaProxy.headers['x-proxy-upstream-host'] });
        }
        if (h264.directUrl) {
          // Server-side imitation of what the browser does: no cookies, Origin set
          const { res, status } = await openUpstream(h264.directUrl, { allowlist: ['*'], headers: { origin: 'http://localhost:5173', range: 'bytes=0-1' } });
          res.destroy();
          check('direct CDN URL without cookies -> 206', status === 206, status);
        }
      }
    }
  } finally {
    await mirrorChecks(check, cookie, base, base.replace(/^http/, 'ws'));
    await app.close();
  }
}

/**
 * Lookups that arrive together each get a daemon of their own (or wait for one): before 2026-10-14
 * they could all land on the same idle daemon and all but the last never settled.
 */
async function ytdlpChecks(): Promise<void> {
  console.log('\n== 5. yt-dlp lookups at the same time');
  if (!(await detectYtDlp()).available) {
    console.log('(skipped: no yt-dlp on this machine)');
    return;
  }
  const ids = ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '9bZkp7q19f0', 'kJQP7kiw5Fk'];
  const t0 = Date.now();
  const settled = await Promise.race([
    Promise.allSettled(ids.map((id) => ytdlpInfo({ url: `https://www.youtube.com/watch?v=${id}`, noplaylist: true }, 30_000))),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 45_000)),
  ]);
  check('every concurrent lookup settles within its limit', Boolean(settled), { ms: Date.now() - t0, daemons: daemonStatus() });
  const ok = (settled || []).map((r, i) => (r.status === 'fulfilled' && r.value?.id === ids[i] ? 'ok' : r.status === 'rejected' ? String(r.reason?.message).slice(0, 80) : 'wrong id'));
  check('each lookup got its own video', ok.length === ids.length && ok.every((x) => x === 'ok'), ok);
  // A wait for a turn counts against the limit: a queue behind busy daemons fails in time.
  const t1 = Date.now();
  const quick = await Promise.allSettled(ids.concat(ids).map((id) => ytdlpInfo({ url: `https://www.youtube.com/watch?v=${id}`, noplaylist: true }, 1_500)));
  check('a short limit holds while waiting in line', Date.now() - t1 < 4_000 && quick.some((r) => r.status === 'rejected'), { ms: Date.now() - t1 });
  shutdownYtDlp();
}

(async () => {
  await offline();
  await downloaderChecks();
  if (skipNetwork) console.log('\n(network checks skipped: SKIP_NETWORK=1)');
  else {
    await network();
    await ytdlpChecks();
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('test runner crashed:', e);
  process.exit(1);
});
