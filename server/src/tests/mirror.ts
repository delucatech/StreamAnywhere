/**
 * Offline checks of the Mirror relay (run.ts calls mirrorChecks()): a sender and two watchers on
 * a local server, the password cookie, the cached group of pictures for a late joiner, the
 * "relay-demand" and "relay" controls, the signalling path, the backlog of a slow watcher.
 */
import { WebSocket } from 'ws';
import { buildServer } from '../index';
import { decodeMessage, encodeConfig, encodeFrame, isRoomCode, type MirrorControl } from '../../../shared/mirror';
import { roomSnapshot } from '../mirror';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

interface Peer {
  ws: WebSocket;
  controls: MirrorControl[];
  binaries: Uint8Array[];
  /** resolves when a control of this type (or any binary message, for 'binary') arrives */
  next(kind: MirrorControl['t'] | 'binary', timeoutMs?: number): Promise<MirrorControl | Uint8Array | undefined>;
}

function connect(url: string, headers: Record<string, string>): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const peer: Peer = {
      ws,
      controls: [],
      binaries: [],
      next(kind, timeoutMs = 2500) {
        return new Promise((res) => {
          const started = Date.now();
          const poll = (): void => {
            if (kind === 'binary') {
              if (peer.binaries.length) return res(peer.binaries.shift());
            } else {
              const i = peer.controls.findIndex((c) => c.t === kind);
              if (i >= 0) return res(peer.controls.splice(i, 1)[0]);
            }
            if (Date.now() - started > timeoutMs) return res(undefined);
            setTimeout(poll, 10);
          };
          poll();
        });
      },
    };
    ws.on('open', () => resolve(peer));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) peer.binaries.push(new Uint8Array(data));
      else peer.controls.push(JSON.parse(String(data)) as MirrorControl);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function mirrorChecks(check: Check, cookie: string, base: string, wsBase: string): Promise<void> {
  console.log('\n== mirror relay');
  const http = await import('node:http');
  const post = (p: string, headers: Record<string, string>, json?: unknown) =>
    new Promise<{ status: number; body: string; setCookie: string }>((resolve, reject) => {
      const payload = json === undefined ? undefined : JSON.stringify(json);
      const req = http.request(base + p, { method: 'POST', headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString(), setCookie: String(res.headers['set-cookie']?.[0] || '') }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  const get = (p: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(base + p, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
      }).on('error', reject);
    });

  const noCookie = await post('/api/mirror/rooms', {});
  check('rooms need the site password', noCookie.status === 401, noCookie.status);
  const made = await post('/api/mirror/rooms', { cookie });
  const room = (JSON.parse(made.body) as { room: string }).room;
  check('a room code is six letters', made.status === 200 && isRoomCode(room), room);

  let refused = '';
  await connect(`${wsBase}/api/mirror/ws?room=${room}&role=watcher`, {}).catch((e: Error) => (refused = e.message));
  check('the socket needs the site password too', /401/.test(refused), refused);
  refused = '';
  await connect(`${wsBase}/api/mirror/ws?room=ZZZZZZ&role=watcher`, { cookie }).catch((e: Error) => (refused = e.message));
  check('a watcher of an unknown room is refused', /404/.test(refused), refused);

  const sender = await connect(`${wsBase}/api/mirror/ws?room=${room}&role=sender&name=Test%20phone`, { cookie });
  const ready = (await sender.next('ready')) as MirrorControl | undefined;
  check('sender gets ready', ready?.t === 'ready' && ready.live === true && ready.watchers === 0, ready);
  const demand0 = (await sender.next('relay-demand')) as { on: boolean } | undefined;
  check('no watchers: the relay wants no frames', demand0?.on === false, demand0);

  const config = encodeConfig({ v: 1, video: { codec: 'avc1.640028', width: 64, height: 32, description: 'AQ==', rotation: 0, fps: 30 }, name: 'Test phone' });
  sender.ws.send(config);
  const key = encodeFrame('video', true, 1000, new Uint8Array([1, 2, 3]));
  const delta = encodeFrame('video', false, 34_000, new Uint8Array([4]));
  sender.ws.send(key);
  sender.ws.send(delta);
  await sleep(50);
  check('config and GOP cached for late joiners', roomSnapshot(room)?.cached === 2 && roomSnapshot(room)?.config?.name === 'Test phone', roomSnapshot(room));

  const w1 = await connect(`${wsBase}/api/mirror/ws?room=${room}&role=watcher`, { cookie });
  const w1ready = (await w1.next('ready')) as Extract<MirrorControl, { t: 'ready' }> | undefined;
  check('watcher gets ready with the sender name and its id', w1ready?.t === 'ready' && w1ready.live && w1ready.name === 'Test phone' && typeof w1ready.id === 'string', w1ready);
  const got = [await w1.next('binary'), await w1.next('binary'), await w1.next('binary')] as (Uint8Array | undefined)[];
  const kinds = got.map((b) => (b ? decodeMessage(b).type + (decodeMessage(b).type === 'frame' ? (decodeMessage(b) as { key: boolean }).key ? ':key' : ':delta' : '') : 'none'));
  check('late joiner receives config, keyframe, delta at once', kinds.join(',') === 'config,frame:key,frame:delta', kinds);
  const joined = (await sender.next('watcher')) as MirrorControl | undefined;
  check('sender told of the watcher (with its id)', joined?.t === 'watcher' && joined.event === 'join' && joined.id === w1ready?.id, joined);
  const demand1 = (await sender.next('relay-demand')) as { on: boolean } | undefined;
  check('a watcher on the relay: frames wanted again', demand1?.on === true, demand1);

  // live frames flow
  const live = encodeFrame('video', false, 67_000, new Uint8Array([5, 6]));
  sender.ws.send(live);
  const liveGot = (await w1.next('binary')) as Uint8Array | undefined;
  check('live frame relayed', liveGot !== undefined && decodeMessage(liveGot).type === 'frame' && (decodeMessage(liveGot) as { timestampUs: number }).timestampUs === 67_000);

  // signalling both ways
  w1.ws.send(JSON.stringify({ t: 'signal', data: { sdp: { type: 'offer', sdp: 'v=0' } } }));
  const offer = (await sender.next('signal')) as MirrorControl | undefined;
  check('offer reaches the sender with the watcher id', offer?.t === 'signal' && offer.from === w1ready?.id && 'sdp' in offer.data, offer);
  sender.ws.send(JSON.stringify({ t: 'signal', to: w1ready?.id, data: { sdp: { type: 'answer', sdp: 'v=0' } } }));
  const answer = (await w1.next('signal')) as MirrorControl | undefined;
  check('answer reaches the watcher', answer?.t === 'signal' && 'sdp' in answer.data && answer.data.sdp.type === 'answer', answer);

  // the watcher moves to its direct link: the relay stops copying, the sender is told
  w1.ws.send(JSON.stringify({ t: 'relay', on: false }));
  const demand2 = (await sender.next('relay-demand')) as { on: boolean } | undefined;
  check('every watcher direct: relay wants no frames', demand2?.on === false, demand2);
  sender.ws.send(encodeFrame('video', false, 100_000, new Uint8Array([7])));
  const skipped = await w1.next('binary', 300);
  check('a paused watcher gets no frames', skipped === undefined);
  w1.ws.send(JSON.stringify({ t: 'relay', on: true }));
  const demand3 = (await sender.next('relay-demand')) as { on: boolean } | undefined;
  const needKey = await sender.next('need-key');
  check('back on the relay: frames wanted and a keyframe asked for', demand3?.on === true && needKey !== undefined, { demand3, needKey });
  sender.ws.send(encodeFrame('video', false, 133_000, new Uint8Array([8])));
  const deltaDropped = await w1.next('binary', 300);
  check('a delta before the keyframe is not relayed to the rejoined watcher', deltaDropped === undefined);
  const key2 = encodeFrame('video', true, 166_000, new Uint8Array([9]));
  sender.ws.send(key2);
  const keyGot = (await w1.next('binary')) as Uint8Array | undefined;
  check('the next keyframe is', keyGot !== undefined && decodeMessage(keyGot).type === 'frame' && (decodeMessage(keyGot) as { key: boolean }).key === true);

  // a second watcher: counts
  const w2 = await connect(`${wsBase}/api/mirror/ws?room=${room}&role=watcher`, { cookie });
  await w2.next('ready');
  const count = (await w1.next('watchers')) as { n: number } | undefined;
  check('watchers are counted for everyone', count?.n === 2, count);
  w2.ws.close();
  const left = (await sender.next('watcher')) as MirrorControl | undefined;
  await sleep(20);
  const leftEvent = left?.t === 'watcher' && left.event === 'join' ? ((await sender.next('watcher')) as MirrorControl | undefined) : left;
  check('sender told when a watcher leaves', leftEvent?.t === 'watcher' && leftEvent.event === 'leave' && leftEvent.watchers === 1, leftEvent);

  // the sender goes away and comes back
  sender.ws.close();
  const gone = (await w1.next('sender')) as MirrorControl | undefined;
  check('watcher told the sender left', gone?.t === 'sender' && gone.event === 'leave', gone);
  check('room kept for the sender to return', roomSnapshot(room)?.live === false && roomSnapshot(room)?.watchers === 1, roomSnapshot(room));
  const sender2 = await connect(`${wsBase}/api/mirror/ws?room=${room}&role=sender&name=Back`, { cookie });
  await sender2.next('ready');
  const back = (await w1.next('sender')) as MirrorControl | undefined;
  check('watcher told the sender is back', back?.t === 'sender' && back.event === 'join' && back.name === 'Back', back);
  check('a returning sender starts a new stream (old config dropped)', roomSnapshot(room)?.config === undefined);

  const status = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get(base + `/api/mirror/rooms/${room.toLowerCase()}`, { headers: { cookie } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  check('room status (code normalised)', status.status === 200 && (JSON.parse(status.body) as { live: boolean; watchers: number }).live === true, status.body);

  // ---- pairing: the car's page shows a code, the phone claims it and is signed in
  const pairNoCookie = await post('/api/mirror/pair', {}, { room });
  check('a pairing code needs the site password', pairNoCookie.status === 401, pairNoCookie.status);
  const paired = await post('/api/mirror/pair', { cookie }, { room });
  const pairInfo = JSON.parse(paired.body) as { room: string; token: string; url: string; expiresInMs: number };
  check('a pairing code for the page\'s own room', paired.status === 200 && pairInfo.room === room && /^[A-Za-z0-9_-]{32}$/.test(pairInfo.token) && pairInfo.url === `${base}/pair#${pairInfo.token}` && pairInfo.expiresInMs > 60_000, pairInfo);
  const fresh = await post('/api/mirror/pair', { cookie });
  const freshInfo = JSON.parse(fresh.body) as { room: string; token: string };
  check('a pairing code without a room makes a new room', fresh.status === 200 && isRoomCode(freshInfo.room) && freshInfo.room !== room && roomSnapshot(freshInfo.room) !== undefined, freshInfo);
  const landing = await get('/pair', {});
  check('the landing page is public and hands the token to the app', landing.status === 200 && landing.body.includes('streamanywhere://pair?server=') && landing.body.includes('Open StreamAnywhere'), landing.status);
  const badClaim = await post('/api/mirror/pair/claim', {}, { token: 'nope-nope-nope-nope-nope', name: 'Phone' });
  check('an unknown pairing code is refused', badClaim.status === 404, badClaim.status);
  const claim = await post('/api/mirror/pair/claim', {}, { token: pairInfo.token, name: 'Scanned phone' });
  const claimBody = JSON.parse(claim.body) as { room: string; server: string; signedIn: boolean };
  const phoneCookie = claim.setCookie.split(';')[0];
  check('the phone claims the code without a password and gets the room and the cookie', claim.status === 200 && claimBody.room === room && claimBody.signedIn === true && claimBody.server === base && phoneCookie.startsWith('sa_auth='), { status: claim.status, body: claimBody, cookie: phoneCookie.slice(0, 12) });
  const pairedMsg = (await w1.next('paired')) as MirrorControl | undefined;
  check('the car\'s page is told the phone paired', pairedMsg?.t === 'paired' && pairedMsg.name === 'Scanned phone', pairedMsg);
  const again = await post('/api/mirror/pair/claim', {}, { token: pairInfo.token });
  check('a pairing code works once', again.status === 404, again.status);
  const beacon = await post('/api/mirror/beacon', {}, { event: 'started', room: room.toLowerCase(), name: 'Beacon phone', detail: 'signed in: no, shared settings: no' });
  const beaconNote = (await w1.next('note')) as MirrorControl | undefined;
  check('the extension\'s beacon needs no cookie and reaches the car\'s page', beacon.status === 200 && beaconNote?.t === 'note' && beaconNote.kind === 'info' && /Beacon phone started mirroring \(signed in: no/.test(beaconNote.message), { status: beacon.status, beaconNote });
  let lostPhone = '';
  await connect(`${wsBase}/api/mirror/ws?room=${room}&role=sender&name=Lost%20phone`, {}).catch((e: Error) => (lostPhone = e.message));
  const note = (await w1.next('note')) as MirrorControl | undefined;
  check('the car\'s page is told when its phone is refused', /401/.test(lostPhone) && note?.t === 'note' && note.kind === 'error' && /Lost phone reached the server.*refused.*sent none/.test(note.message), { lostPhone, note });
  const withPhoneCookie = await post('/api/mirror/rooms', { cookie: phoneCookie });
  check('the cookie from the claim is a real login', withPhoneCookie.status === 200, withPhoneCookie.status);
  let phoneRefused = '';
  const phoneSender = await connect(`${wsBase}/api/mirror/ws?room=${freshInfo.room}&role=sender&name=Paired`, { cookie: phoneCookie }).catch((e: Error) => (phoneRefused = e.message));
  check('the paired phone can send', phoneRefused === '' && typeof phoneSender === 'object', phoneRefused);
  if (typeof phoneSender === 'object') phoneSender.ws.close();

  w1.ws.close();
  sender2.ws.close();
  await sleep(30);
}

/** Standalone run: `npx tsx src/tests/mirror.ts` from server/ */
if (require.main === module) {
  (async () => {
    // a known password for this run, and the cookie /login sets for it
    const crypto = await import('node:crypto');
    const salt = crypto.randomBytes(16);
    process.env.APP_PASSWORD_HASH = `scrypt:${salt.toString('hex')}:${crypto.scryptSync('test-password', salt, 32).toString('hex')}`;
    process.env.APP_COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
    const app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const http = await import('node:http');
    const cookie = await new Promise<string>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, (res) => {
        res.resume();
        resolve(String(res.headers['set-cookie']?.[0] || '').split(';')[0]);
      });
      req.on('error', reject);
      req.end('password=test-password&next=%2F');
    });
    let failures = 0;
    await mirrorChecks(
      (name, cond, detail) => {
        console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
        if (!cond) failures++;
      },
      cookie,
      `http://127.0.0.1:${port}`,
      `ws://127.0.0.1:${port}`,
    );
    await app.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL MIRROR CHECKS PASSED');
    process.exit(failures ? 1 : 0);
  })();
}
