/**
 * Offline checks of "what the server is doing" (run.ts calls activityChecks()): the activity list
 * (activity.ts), the request names and the HTTP side (activityRoutes.ts), yt-dlp's messages as
 * steps (ytdlp.ts) and the log tail (logbuf.ts).
 */
import Fastify from 'fastify';
import * as http from 'node:http';
import type { ActivityResponse, ServerStatus } from '../../../shared/types';
import { activitySnapshot, beginActivity, currentActivity, endActivity, followActivity, inActivity, resetActivity, say, sayer, track, tracking, type Act } from '../activity';
import { describeRequest, registerActivity } from '../activityRoutes';
import { logStream, recentLogLines } from '../logbuf';
import { ytdlpBrief, ytdlpStep } from '../ytdlp';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

export async function activityChecks(check: Check): Promise<void> {
  console.log('\n== 5h. What the server is doing (activity list, request names, steps)');
  resetActivity();

  // ---- one tracked job and its steps
  const g1 = gate();
  const job = track('Looking up YouTube video abc', { platform: 'youtube' }, async () => {
    say('asking YouTube directly');
    await g1.wait;
    return 7;
  });
  await tick();
  let list = activitySnapshot();
  check('a tracked job is listed with its step', list.length === 1 && list[0].what === 'Looking up YouTube video abc' && list[0].step === 'asking YouTube directly' && list[0].platform === 'youtube' && !list[0].ended, list);
  let threw = false;
  try {
    say('nobody is listening here');
  } catch {
    threw = true;
  }
  check('say() outside any activity does nothing', !threw && !tracking() && activitySnapshot()[0].step === 'asking YouTube directly');
  g1.open();
  check('the job returns its own value', (await job) === 7);
  check('a job that ended at once leaves the list (nothing to report)', activitySnapshot().length === 0, activitySnapshot());

  // ---- a job inside a request: its steps are the request's, it is listed once, and it outlives the request
  const request = beginActivity('Getting a YouTube video ready (abc)', { platform: 'youtube' });
  const g2 = gate();
  let stepLater: (t: string) => void = () => undefined;
  const inner = inActivity(request, () =>
    track('Looking up YouTube video abc', {}, async () => {
      stepLater = sayer();
      say('yt-dlp: reading the page');
      await g2.wait;
    }),
  );
  await tick();
  list = activitySnapshot();
  check('a job started inside a request is listed once, by the request', list.length === 1 && list[0].what.startsWith('Getting a YouTube video ready'), list);
  check("the job's step is the request's step", list[0].step === 'yt-dlp: reading the page', list[0]);
  stepLater('yt-dlp: running the player script with Deno');
  check('a step said later from outside (a child process callback) lands on the same job and request', activitySnapshot()[0].step === 'yt-dlp: running the player script with Deno', activitySnapshot());
  // the viewer stopped waiting: the request ends, the job goes on
  request.startedAt -= 5000;
  endActivity(request, { failed: true, result: 'the viewer stopped waiting' });
  list = activitySnapshot();
  const running = list.filter((a) => !a.ended);
  const ended = list.filter((a) => a.ended);
  check('when the request ends first, the job is listed on its own', running.length === 1 && running[0].what === 'Looking up YouTube video abc' && running[0].step === 'yt-dlp: running the player script with Deno', list);
  check('the ended request stays for a moment with how it ended', ended.length === 1 && ended[0].ended?.failed === true && ended[0].ended?.result === 'the viewer stopped waiting' && ended[0].forMs >= 5000, ended);
  g2.open();
  await inner;

  // ---- order, failures, clipping
  resetActivity();
  const bg = beginActivity('Keeping Explore videos in stock', { background: true });
  await tick(5);
  const fg = beginActivity('Searching YouTube for "tesla"', { platform: 'youtube' });
  list = activitySnapshot();
  check("the viewers' work comes before the server's own jobs", list.length === 2 && list[0].what.startsWith('Searching') && list[1].background === true, list);
  fg.startedAt -= 3000;
  endActivity(fg, { failed: true, result: 'YouTube answered 429' });
  endActivity(bg);
  list = activitySnapshot();
  check('a failure that took a while is kept with its reason; a quick success is not', list.length === 1 && list[0].ended?.failed === true && list[0].ended.result === 'YouTube answered 429', list);
  resetActivity();
  const failing = track('A job that fails', {}, async () => {
    throw new Error('boom');
  });
  check('track() passes the failure on', (await failing.then(() => 'ok', (e) => (e as Error).message)) === 'boom');
  const long = beginActivity('x'.repeat(600));
  check('a very long text is cut', activitySnapshot()[0].what.length <= 240, activitySnapshot()[0].what.length);
  endActivity(long);
  resetActivity();

  // ---- request names
  const d = (method: string, path: string, body?: unknown, query?: unknown): string | undefined => describeRequest(method, path, body, query)?.what;
  check('a YouTube video request is named with the video id', d('POST', '/api/resolve', { url: 'https://www.youtube.com/watch?v=Gh-XKNuvvC4' }) === 'Getting a YouTube video ready (Gh-XKNuvvC4)', d('POST', '/api/resolve', { url: 'https://www.youtube.com/watch?v=Gh-XKNuvvC4' }));
  check('a TikTok video request names TikTok', /^Getting a TikTok video ready/.test(d('POST', '/api/resolve', { url: 'https://www.tiktok.com/@a/video/7300000000000000000' }) || ''));
  check('a plain file request names its host', d('POST', '/api/resolve', { url: 'https://mdn.github.io/x/flower.mp4' }) === 'Getting a video ready (mdn.github.io)', d('POST', '/api/resolve', { url: 'https://mdn.github.io/x/flower.mp4' }));
  check('a search names the platform and the phrase', d('POST', '/api/search', { platform: 'youtube', q: 'tesla fsd 15' }) === 'Searching YouTube for "tesla fsd 15"');
  check('a feed request names the feed', d('POST', '/api/feed', { platform: 'instagram', source: 'foryou' }) === 'Loading Instagram For You videos' && describeRequest('POST', '/api/feed', { platform: 'instagram' }, {})?.platform === 'instagram');
  check('a sign-in check is listed only when it asks the platform', d('GET', '/api/session', undefined, { platform: 'tiktok', recheck: '1' }) === 'Checking the TikTok sign-in' && d('GET', '/api/session', undefined, { platform: 'tiktok' }) === undefined);
  check('polled and instant requests are not listed', [d('GET', '/api/health'), d('GET', '/api/activity'), d('GET', '/api/feed/progress'), d('GET', '/api/media/abc'), d('POST', '/api/report', {}), d('GET', '/api/livetv/tune/status')].every((x) => x === undefined));
  check('Live TV and library requests are named', d('POST', '/api/livetv/tune', { key: 'k' }) === 'Live TV: opening a channel' && /qualities/.test(d('GET', '/api/library/entries/abc/options') || '') && /refreshing a provider/.test(d('POST', '/api/livetv/providers/p1/refresh') || ''));
  check('a body that is not an object does not break the naming', d('POST', '/api/search', 'oops') === 'Searching TikTok for ""' && d('POST', '/api/resolve', null) !== undefined);

  // ---- the one-line status: a step in a few words, a request found by its route, a later request following the work
  resetActivity();
  const req1 = beginActivity('Getting a YouTube video ready (abc)', { platform: 'youtube', route: 'POST /api/resolve', ref: 'https://www.youtube.com/watch?v=abc' });
  const g3 = gate();
  let lookup: Act | undefined;
  let lookupSays: (t: string, b?: string) => void = () => undefined;
  const work = inActivity(req1, () =>
    track('Looking up YouTube video abc', {}, async () => {
      lookup = currentActivity();
      lookupSays = sayer();
      say("yt-dlp: reading the video's page on YouTube", 'reading the video page');
      await g3.wait;
    }),
  );
  await tick();
  list = activitySnapshot();
  check('a request carries its route and what it is about', list.length === 1 && list[0].route === 'POST /api/resolve' && list[0].ref === 'https://www.youtube.com/watch?v=abc', list);
  check('a step may name its short form, and the request gets both', list[0].step === "yt-dlp: reading the video's page on YouTube" && list[0].brief === 'reading the video page', list[0]);
  say('outside');
  const req2 = beginActivity('Getting a YouTube video ready (abc)', { platform: 'youtube', route: 'POST /api/resolve', ref: 'https://www.youtube.com/watch?v=abc' });
  inActivity(req2, () => {
    say('this video is already being looked up for an earlier request: waiting for that answer');
    followActivity(lookup);
  });
  const second = (): { step?: string; brief?: string } => activitySnapshot().find((a) => a.id === req2.id) || {};
  check('a second request for the same work takes over its current step', second().step === "yt-dlp: reading the video's page on YouTube" && second().brief === 'reading the video page', second());
  lookupSays('yt-dlp: asking YouTube for the files (as its tv app)');
  check('...and every later one (a step without a short form clears the old one)', second().step === 'yt-dlp: asking YouTube for the files (as its tv app)' && second().brief === undefined, second());
  inActivity(req1, () => followActivity(lookup));
  lookupSays('yt-dlp: one more step', 'one more');
  check('following the work one already carries changes nothing (no loop)', activitySnapshot().find((a) => a.id === req1.id)?.brief === 'one more' && second().brief === 'one more', activitySnapshot());
  endActivity(req2);
  lookupSays('yt-dlp: after the second request ended');
  check('a request that ended is no longer told', activitySnapshot().find((a) => a.id === req1.id)?.step === 'yt-dlp: after the second request ended' && !lookup?.followers?.size, lookup?.followers?.size);
  g3.open();
  await work;
  endActivity(req1);
  resetActivity();
  check('a video request is told apart by its address', describeRequest('POST', '/api/resolve', { url: 'https://www.youtube.com/watch?v=Gh-XKNuvvC4' }, {})?.ref === 'https://www.youtube.com/watch?v=Gh-XKNuvvC4' && describeRequest('POST', '/api/search', { q: 'x' }, {})?.ref === undefined);
  check("yt-dlp's steps have short forms", ytdlpBrief('[youtube] Gh-XKNuvvC4: Downloading webpage') === 'reading the video page' && ytdlpBrief('[youtube] [jsc:deno] Solving JS challenges using deno') === 'unlocking the video addresses' && ytdlpBrief('[youtube:tab] Extracting something new') === undefined);

  // ---- yt-dlp's own messages as steps
  check("yt-dlp: the watch page step is said in plain words", ytdlpStep('[youtube] Gh-XKNuvvC4: Downloading webpage') === "yt-dlp: reading the video's page on YouTube", ytdlpStep('[youtube] Gh-XKNuvvC4: Downloading webpage'));
  check('yt-dlp: a player request names the app it asks as', ytdlpStep('[youtube] Gh-XKNuvvC4: Downloading tv samsung player API JSON') === "yt-dlp: asking YouTube for the video's files (as its tv samsung app)");
  check('yt-dlp: the JavaScript step names the runtime', ytdlpStep('[youtube] [jsc:deno] Solving JS challenges using deno') === "yt-dlp: running YouTube's player script (with Deno, to unlock the video addresses)", ytdlpStep('[youtube] [jsc:deno] Solving JS challenges using deno'));
  check('yt-dlp: the player script download is named', ytdlpStep('[youtube] Gh-XKNuvvC4: Downloading player 6b3d0364-main') === "yt-dlp: downloading YouTube's player script");
  check('yt-dlp: an unknown message is passed on without its prefix', ytdlpStep('[youtube:tab] Extracting something new') === 'yt-dlp: Extracting something new', ytdlpStep('[youtube:tab] Extracting something new'));

  // ---- the log tail
  const now = Date.now();
  const line = (o: Record<string, unknown>): void => logStream.write(JSON.stringify({ level: 30, time: now, pid: 1, hostname: 't', ...o }) + '\n');
  // (the log is written in time order: the tail stops at the first line that is too old)
  line({ msg: 'an old line', time: now - 120_000 });
  line({ msg: 'media delivered via proxy', mode: 'proxy-chunked', bytes: 2 * 1048576, ms: 640, host: 'rr3.googlevideo.com' });
  line({ msg: 'client: player', client: true });
  line({ msg: 'daemon ready', what: 'yt-dlp', level: 30 });
  line({ msg: 'youtube resolve failed', err: 'This video is private', level: 40 });
  const tail = recentLogLines(10, 30_000).map((l) => `${l.level}|${l.text}`);
  check("the relay's log line is said in words", tail.includes('info|video relay: sent 2.0 MB in 0.6 s from rr3.googlevideo.com'), tail);
  check("a device's own report is left out of the server's tail", !tail.some((t) => t.includes('client: player')), tail);
  check('a line is prefixed with its part of the server, and a problem carries its reason', tail.includes('info|yt-dlp: daemon ready') && tail.includes('warn|youtube resolve failed: This video is private'), tail);
  check('old lines are left out', !tail.some((t) => t.includes('an old line')), tail);

  // ---- over HTTP: a slow request is listed while it runs, with its step, and reported when it failed
  resetActivity();
  const app = Fastify({ logger: false });
  const status: ServerStatus = { memoryMb: 500, memoryTotalMb: 1000, swapMb: 0, swapTotalMb: 0, rssMb: 100, load: 0.1, lagMs: 0, pressure: false, busy: [], browser: false };
  registerActivity(app, () => status);
  const slow = gate();
  app.post('/api/search', async (_req, reply) => {
    say('asking the source');
    await slow.wait;
    return reply.code(502).send({ error: 'the source did not answer' });
  });
  app.get('/api/health', async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(base + p, { method, headers: data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode || 0, json });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
  try {
    const pending = call('POST', '/api/search', { platform: 'youtube', q: 'blippi' });
    await tick(120);
    await call('GET', '/api/health');
    let r = (await call('GET', '/api/activity')).json as ActivityResponse;
    check('GET /api/activity lists the request in progress with its step', r.activities.length === 1 && r.activities[0].what === 'Searching YouTube for "blippi"' && r.activities[0].step === 'asking the source' && !r.activities[0].ended, r.activities);
    check('…with the machine state and the log tail beside it', r.server.memoryMb === 500 && Array.isArray(r.recent) && r.recent.every((l) => typeof l.agoMs === 'number'), { server: r.server, recent: r.recent.length });
    // long enough to be worth reporting when it ends
    await tick(1500);
    slow.open();
    const answer = await pending;
    await tick(30);
    r = (await call('GET', '/api/activity')).json as ActivityResponse;
    check('the request got its own answer', answer.status === 502 && answer.json?.error === 'the source did not answer', answer);
    check("a failed request stays listed for a moment with the server's error text", r.activities.length === 1 && r.activities[0].ended?.failed === true && r.activities[0].ended.result === 'the source did not answer', r.activities);
  } finally {
    await app.close();
    resetActivity();
  }
}
