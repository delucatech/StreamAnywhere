/*
 * Probe: can TikTok's web API be read WITHOUT a browser, as a guest, with the ported signer (tiktok_sign.ts)?
 *
 *   node_modules/.bin/tsx research/tiktok_signer_probe.ts [--transport node|curl] [--video <id>] [--python <exe>]
 *
 * Steps: guest session (ttwid + page identity + msToken) -> a video id from the unsigned Explore list ->
 * comments unsigned (control) -> comments signed -> next page -> signed-out "For You" -> a profile.
 * Prints sizes and counts only, never cookie or token values.
 *
 * --transport node  plain Node HTTPS (Node's own TLS handshake)
 * --transport curl  research/tiktok_tls_bridge.py (curl_cffi: Chrome's TLS handshake)
 */
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRequest } from './tiktok_sign';

const ORIGIN = 'https://www.tiktok.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const TRANSPORT = arg('transport', 'node') as 'node' | 'curl';
const PYTHON = arg('python', process.platform === 'win32' ? 'python' : 'python3')!;

type Jar = Record<string, string>;
interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  ms: number;
}

const cookieHeader = (jar: Jar): string => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function takeCookies(jar: Jar, headers: Answer['headers']): number {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  let n = 0;
  for (const entry of list) {
    const first = entry.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const value = first.slice(eq + 1).trim();
    if (!value) continue;
    jar[first.slice(0, eq).trim()] = value;
    n += 1;
  }
  return n;
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  if (!body.length || !encoding) return body;
  if (encoding === 'gzip') return zlib.gunzipSync(body);
  if (encoding === 'deflate') return zlib.inflateSync(body);
  if (encoding === 'br') return zlib.brotliDecompressSync(body);
  return body;
}

function viaNode(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: decode(raw, String(res.headers['content-encoding'] ?? '').trim().toLowerCase() || undefined),
            ms: Date.now() - started,
          });
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out after 30 s')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function viaCurl(method: string, url: string, headers: Record<string, string>, body?: string): Answer {
  const started = Date.now();
  const run = spawnSync(PYTHON, [join(here, 'tiktok_tls_bridge.py')], {
    input: JSON.stringify({ method, url, headers, body: body ?? null }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`TLS bridge failed (${run.status}): ${(run.stderr || run.stdout || '').trim().slice(0, 300)}`);
  const out = JSON.parse(run.stdout) as { status: number; headers: Record<string, string>; cookies: string[]; body: string; error?: string };
  if (out.error) throw new Error('TLS bridge: ' + out.error);
  const lower: Answer['headers'] = {};
  for (const [k, v] of Object.entries(out.headers)) lower[k.toLowerCase()] = v;
  lower['set-cookie'] = out.cookies;
  return { status: out.status, headers: lower, body: Buffer.from(out.body, 'base64'), ms: Date.now() - started };
}

/** One request, following redirects by hand so every hop's cookies land in the jar. */
async function send(jar: Jar, method: string, url: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  let target = url;
  for (let hop = 0; hop < 6; hop++) {
    const h = { ...headers, ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) };
    const answer = TRANSPORT === 'curl' ? viaCurl(method, target, h, body) : await viaNode(method, target, h, body);
    takeCookies(jar, answer.headers);
    const location = answer.headers['location'];
    if (answer.status >= 300 && answer.status < 400 && location) {
      target = new URL(Array.isArray(location) ? location[0] : location, target).toString();
      method = 'GET';
      body = undefined;
      continue;
    }
    return answer;
  }
  throw new Error('too many redirects');
}

interface Session {
  jar: Jar;
  webId: string;
  region: string;
  csrf?: string;
  abVersions?: string;
  fromPage: boolean;
}

function pageIdentity(html: string): { wid?: string; region?: string; csrf?: string; ab?: string } {
  const m = /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return {};
  try {
    const ctx = JSON.parse(m[1])?.__DEFAULT_SCOPE__?.['webapp.app-context'] ?? {};
    return { wid: ctx.wid, region: ctx.region, csrf: ctx.csrfToken, ab: ctx.abTestVersion?.versionName };
  } catch {
    return {};
  }
}

async function newSession(): Promise<Session> {
  const jar: Jar = {};
  const reg = await send(
    jar,
    'POST',
    `${ORIGIN}/ttwid/union/register/`,
    { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: '*/*' },
    JSON.stringify({ region: 'US', aid: 1988, needFid: false, service: 'www.tiktok.com', migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true }),
  ).catch((e) => ({ status: 0, body: Buffer.from(String(e)) }) as Answer);
  console.log(`  device registration: HTTP ${reg.status}, ttwid ${jar.ttwid ? 'set' : 'absent'}`);

  const page = await send(jar, 'GET', `${ORIGIN}/explore`, {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: `${ORIGIN}/`,
  });
  const id = pageIdentity(page.body.toString('utf8'));
  console.log(`  /explore: HTTP ${page.status}, ${page.body.length} bytes, device id ${id.wid ? 'from the page' : 'ABSENT'}, region ${id.region ?? '?'}`);

  let webId = id.wid ?? '';
  if (!webId) {
    webId = '7';
    for (let i = 0; i < 18; i++) webId += String(Math.floor(Math.random() * 10));
  }
  const region = id.region ?? 'US';
  const boot = new URLSearchParams({ aid: '1988', count: '10', app_name: 'tiktok_web', device_platform: 'web_pc', device_id: webId, region, priority_region: region });
  const first = await send(jar, 'GET', `${ORIGIN}/api/recommend/item_list/?${boot}`, {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: `${ORIGIN}/`,
  });
  console.log(`  msToken call: HTTP ${first.status}, msToken ${jar.msToken ? jar.msToken.length + ' chars' : 'ABSENT'}; cookies: ${Object.keys(jar).join(', ')}`);
  return { jar, webId, region, csrf: id.csrf ?? jar.tt_csrf_token, abVersions: id.ab, fromPage: Boolean(id.wid) };
}

function commonParams(s: Session): Array<[string, string]> {
  const p: Record<string, string> = {
    aid: '1988',
    app_name: 'tiktok_web',
    app_language: 'en',
    device_platform: 'web_pc',
    device_id: s.webId,
    region: s.region,
    priority_region: s.region,
    language: 'en',
    WebIdLastTime: String(Math.floor(Date.now() / 1000)),
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    os: 'mac',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'MacIntel',
    browser_version: '5.0 (Macintosh)',
    focus_state: 'true',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    history_len: '3',
    screen_height: '1117',
    screen_width: '1728',
    tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
    webcast_language: 'en',
    root_referer: `${ORIGIN}/`,
  };
  return Object.entries(p);
}

const AB_PATHS = new Set(['/api/post/item_list/', '/api/recommend/item_list/']);

interface CallOptions {
  sign?: boolean;
  envCode?: number;
  referer?: string;
  keepEmpty?: string[];
}

async function call(s: Session, path: string, query: Record<string, string | number>, o: CallOptions = {}): Promise<{ answer: Answer; json?: any; text: string }> {
  const pairs = commonParams(s);
  for (const [k, v] of Object.entries(query)) {
    if (v === '' && !o.keepEmpty?.includes(k)) continue;
    pairs.push([k, String(v)]);
  }
  if (AB_PATHS.has(path) && s.abVersions) pairs.push(['clientABVersions', s.abVersions]);
  const qs =
    o.sign === false
      ? pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : signRequest(pairs, { userAgent: UA, msToken: s.jar.msToken ?? '', envCode: o.envCode }).query;
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: o.referer ?? `${ORIGIN}/`,
    Origin: ORIGIN,
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    priority: 'u=1, i',
  };
  if (s.csrf) headers['x-secsdk-csrf-token'] = s.csrf;
  const answer = await send(s.jar, 'GET', `${ORIGIN}${path}?${qs}`, headers);
  const text = answer.body.toString('utf8');
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  return { answer, json, text };
}

function report(label: string, r: { answer: Answer; json?: any; text: string }, summary: (j: any) => string): void {
  const h = r.answer.headers;
  const guard = h['tt-ticket-guard-result'] !== undefined ? `, guard ${h['tt-ticket-guard-result']}` : '';
  const what = r.json ? summary(r.json) : r.text.length ? `NOT JSON: ${JSON.stringify(r.text.slice(0, 120))}` : 'EMPTY BODY';
  console.log(`${label}: HTTP ${r.answer.status}, ${r.answer.body.length} bytes, ${r.answer.ms} ms${guard} -> ${what}`);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GAP = 3500;

async function main(): Promise<void> {
  console.log(`transport: ${TRANSPORT}, node ${process.version}, ${new Date().toISOString()}`);
  console.log('1. guest session');
  const s = await newSession();

  console.log('2. a video with comments');
  let videoId = arg('video');
  let author = '';
  let secUid = '';
  const exploreLine = (j: any) => `${(j.itemList ?? []).length} videos, status_code ${j.status_code ?? j.statusCode}`;
  await pause(3500); // calls less than 3 s apart get TikTok's empty 200 (seen 2026-10-10)
  let explore = await call(s, '/api/explore/item_list/', { categoryType: 120, count: 16 }, { sign: false, referer: `${ORIGIN}/explore` });
  report('  explore (unsigned)', explore, exploreLine);
  if (!explore.json?.itemList?.length) {
    await pause(3500);
    explore = await call(s, '/api/explore/item_list/', { categoryType: 120, count: 16 }, { referer: `${ORIGIN}/explore` });
    report('  explore (signed)', explore, exploreLine);
  }
  if (!explore.json?.itemList?.length) {
    await pause(GAP);
    explore = await call(s, '/api/recommend/item_list/', { from_page: 'fyp', count: 16, coverFormat: 2 });
    report('  recommend (signed) instead', explore, exploreLine);
  }
  const items: any[] = explore.json?.itemList ?? [];
  const pick = items.filter((it) => Number(it?.stats?.commentCount) > 200).sort((a, b) => Number(a.stats.commentCount) - Number(b.stats.commentCount))[0] ?? items[0];
  if (pick) {
    author = pick.author?.uniqueId ?? '';
    secUid = pick.author?.secUid ?? '';
    if (!videoId) {
      videoId = pick.id;
      console.log(`  picked ${videoId} by @${author}: ${pick.stats?.commentCount} comments`);
    }
  }
  if (!videoId) throw new Error('no video id: pass --video <id>');

  const commentQuery = { aweme_id: videoId, count: 20, cursor: 0, fromWeb: 1, enter_from: 'tiktok_web', current_region: s.region };
  const commentLine = (j: any) => {
    const list: any[] = j.comments ?? [];
    const sample = list[0] ? ` first: ${JSON.stringify(String(list[0].text ?? '').slice(0, 50))} by @${list[0].user?.unique_id ?? '?'}` : '';
    return `${list.length} comments, total ${j.total}, has_more ${j.has_more}, cursor ${j.cursor}, status_code ${j.status_code}.${sample}`;
  };

  console.log('3. comments');
  await pause(GAP);
  report('  unsigned (control)', await call(s, '/api/comment/list/', commentQuery, { sign: false }), commentLine);
  await pause(GAP);
  const page1 = await call(s, '/api/comment/list/', commentQuery);
  report('  signed, page 1', page1, commentLine);
  if (page1.json?.comments?.length) {
    await pause(GAP);
    report('  signed, page 2', await call(s, '/api/comment/list/', { ...commentQuery, cursor: page1.json.cursor ?? 20 }), commentLine);
    const withReplies = (page1.json.comments as any[]).find((c) => Number(c.reply_comment_total) > 0);
    if (withReplies) {
      await pause(GAP);
      report('  signed, replies', await call(s, '/api/comment/list/reply/', { item_id: videoId, comment_id: withReplies.cid, count: 20, cursor: 0 }), commentLine);
    }
  }

  console.log('4. signed-out "For You"');
  await pause(GAP);
  report('  recommend (signed)', await call(s, '/api/recommend/item_list/', { from_page: 'fyp', count: 16, coverFormat: 2 }), (j) => `${(j.itemList ?? []).length} videos, status_code ${j.status_code ?? j.statusCode}`);

  if (author) {
    console.log(`5. profile @${author}`);
    await pause(GAP);
    const detail = await call(s, '/api/user/detail/', { abTestVersion: s.abVersions ?? '', appType: 'm', secUid: '', uniqueId: author }, { keepEmpty: ['secUid', 'uniqueId'], referer: `${ORIGIN}/@${author}` });
    report('  user/detail (signed)', detail, (j) => `statusCode ${j.statusCode}, followers ${j.userInfo?.stats?.followerCount}, videos ${j.userInfo?.stats?.videoCount}`);
    secUid = detail.json?.userInfo?.user?.secUid ?? secUid;
    if (secUid) {
      await pause(GAP);
      report('  post/item_list (signed, envCode 64)', await call(s, '/api/post/item_list/', { secUid, count: 16, cursor: 0, coverFormat: 2, post_item_list_request_type: 0 }, { envCode: 64, referer: `${ORIGIN}/@${author}` }), (j) => `${(j.itemList ?? []).length} videos, hasMore ${j.hasMore}, statusCode ${j.statusCode ?? j.status_code}`);
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
