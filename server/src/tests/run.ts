/**
 * Executable checks (no test framework): `npm test` from the repo root.
 *
 *  1. SSRF / allowlist unit checks (offline)
 *  2. TikTok URL parsing (offline)
 *  3. Proxy Range relay against a public CORS-enabled MP4 (network)
 *  4. Live TikTok resolution + cookie / CORS behaviour of each URL kind (network, TIKTOK_TEST_URL)
 *
 * Network checks are skipped (not failed) when SKIP_NETWORK=1.
 */
import { buildServer } from '../index';
import { hostAllowed, ipIsPrivate, assertSafeUpstream } from '../ssrf';
import { parseTikTokUrl } from '../tiktok';
import { itemToFeedItem } from '../feed';
import type { FeedResponse } from '../../../shared/types';
import { openUpstream } from '../http';
import type { ResolveResponse } from '../../../shared/types';

const TEST_MP4 = 'https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4';
const TIKTOK_URL = process.env.TIKTOK_TEST_URL || 'https://www.tiktok.com/@tiktok/video/7693184538704416031';
const skipNetwork = process.env.SKIP_NETWORK === '1';

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
}

async function network(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const http = await import('node:http');
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = http.request(
        base + p,
        { method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), origin: 'http://localhost:5173', ...headers } },
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
    await app.close();
  }
}

(async () => {
  await offline();
  if (skipNetwork) console.log('\n(network checks skipped: SKIP_NETWORK=1)');
  else await network();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('test runner crashed:', e);
  process.exit(1);
});
