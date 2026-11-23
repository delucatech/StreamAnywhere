/**
 * Checks of the YouTube channel pictures (youtubeAvatar.ts). run.ts calls youtubeAvatarChecks()
 * (offline: the parsers on answers trimmed from real ones of 2026-11-23, and the lookups against a
 * replaced network) and youtubeAvatarNetworkChecks() (four small requests to YouTube).
 *
 * Alone: `npx tsx src/tests/youtubeAvatar.ts` from server/ (AVATAR_NETWORK=1 adds the network part).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { avatarKept, avatarRefreshing, loadAvatarStore, saveAvatarStore } from '../youtubeAvatar';
import { avatarFromAnswer, avatarIfKnown, channelAvatar, channelFromAnswer, cleanHandle, pickAvatar, rememberAvatar, setAvatarTransport, youtubeAvatarStatus, type AvatarTransport } from '../youtubeAvatar';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const RICK = 'UCuAXFkgsw1L7xaCfnd5JJOw';
const COCO = 'UCbCmjCuTUZos6Inko4u57UQ';
const rick = (size: number, host = 'yt3.googleusercontent.com'): string => `https://${host}/_ShEGOdg-t5YGJse14Ooq6FYBZqX_QSlhaTNjG06miYusm5lWm1UroLyVxnYtahADfRTVLtuVQ=s${size}-c-k-c0x00ffffff-no-rj`;
const coco = (size: number): string => `https://yt3.ggpht.com/yiljI_XQcX8X0p_E2S0APGrUs7tHBMukf5_3dhVzhbH-z5uhzpt88tUopQa7ngVwO1nGAAnr6A=s${size}-c-k-c0x00ffffff-no-rj`;
const sized = (url: (n: number) => string, ...sizes: number[]): { url: string; width: number; height: number }[] => sizes.map((n) => ({ url: url(n), width: n, height: n }));

/** A channel's browse answer under the fields= mask (web client). */
const browseAnswer = (id = RICK, url: (n: number) => string = rick, handle = 'RickAstleyYT'): any => ({
  header: { pageHeaderRenderer: { content: { pageHeaderViewModel: { image: { decoratedAvatarViewModel: { avatar: { avatarViewModel: { image: { sources: sized(url, 72, 120, 160), processor: { borderImageProcessor: { circular: true } } }, avatarImageSize: 'AVATAR_SIZE_XL' } } } } } } } },
  metadata: { channelMetadataRenderer: { title: 'A channel', externalId: id, avatar: { thumbnails: sized(url, 900) }, vanityChannelUrl: `http://www.youtube.com/@${handle}` } },
});

/** A video's watch answer under the fields= mask: empty blocks around the owner, as YouTube sends them. */
const nextAnswer = (id = COCO, url: (n: number) => string = coco, handle = 'CoComelon'): any => ({
  contents: { twoColumnWatchNextResults: { results: { results: { contents: [{}, { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { thumbnail: { thumbnails: sized(url, 48, 88, 176) }, navigationEndpoint: { browseEndpoint: { browseId: id, canonicalBaseUrl: `/@${handle}` } } } } } }, {}, {}] } } } },
});

/** What a channel id that does not exist, and a "Topic" channel, answer. */
const emptyAnswer = { header: {} };

function fake(over: Partial<AvatarTransport> = {}): { t: AvatarTransport; calls: string[] } {
  const calls: string[] = [];
  const t: AvatarTransport = {
    async browse(channelId) {
      calls.push(`browse ${channelId}`);
      return over.browse ? over.browse(channelId) : browseAnswer(channelId);
    },
    async next(videoId) {
      calls.push(`next ${videoId}`);
      return over.next ? over.next(videoId) : nextAnswer();
    },
    async resolve(handle) {
      calls.push(`resolve ${handle}`);
      return over.resolve ? over.resolve(handle) : { endpoint: { browseEndpoint: { browseId: RICK, params: 'EgC4AQCSAwDyBgQKAjIA' } } };
    },
  };
  return { t, calls };
}

export async function youtubeAvatarChecks(check: Check): Promise<void> {
  console.log('\n== 5i. YouTube channel pictures: parsing, what is kept, two lookups at a time (offline)');
  const logs: string[] = [];
  const log = (m: string): void => void logs.push(m);

  // ---- the picture out of a list of thumbnails
  check('of 72, 120 and 160 px the largest that fits 88-176 is taken', pickAvatar(sized(rick, 72, 120, 160)) === rick(160), pickAvatar(sized(rick, 72, 120, 160)));
  check('of 48, 88 and 176 px: 176', pickAvatar(sized(coco, 48, 88, 176)) === coco(176));
  check('a single 900 px picture is asked for at 176 px', pickAvatar(sized(rick, 900)) === rick(176), pickAvatar(sized(rick, 900)));
  check('a single 48 px picture too', pickAvatar(sized(coco, 48)) === coco(176));
  check('200 px is nearer than 900 px when nothing fits', pickAvatar([{ url: 'https://yt3.ggpht.com/a=s900-c-k', width: 900 }, { url: 'https://yt3.ggpht.com/b=s200-c-k?days_since_epoch=20780', width: 200 }]) === 'https://yt3.ggpht.com/b=s176-c-k?days_since_epoch=20780');
  check("the size in the address counts, not the declared width (a search result's =s88 says 68)", pickAvatar([{ url: coco(88), width: 68, height: 68 }]) === coco(88));
  check('an address without a scheme gets https', pickAvatar([{ url: '//yt3.ggpht.com/ytc/AIdro_l1Gfj=s88-c-k-c0x00ffffff-no-rj', width: 88 }]) === 'https://yt3.ggpht.com/ytc/AIdro_l1Gfj=s88-c-k-c0x00ffffff-no-rj' && pickAvatar([{ url: 'http://yt3.ggpht.com/x=s88-c' }]) === 'https://yt3.ggpht.com/x=s88-c');
  check('an address without a size is taken as it is', pickAvatar([{ url: 'https://yt3.ggpht.com/plain', width: 400 }]) === 'https://yt3.ggpht.com/plain');
  check('other hosts, other schemes and things that are no list give nothing', pickAvatar([{ url: 'https://evil.example/a=s88-c' }, { url: 'https://ggpht.com.evil.example/a=s88' }, { url: 'javascript:alert(1)' }, { url: 7 }, null]) === undefined && pickAvatar(undefined) === undefined && pickAvatar({ url: rick(88) }) === undefined && pickAvatar([]) === undefined);

  // ---- the picture out of an answer
  check('a channel page answer: the header picture (160 px)', avatarFromAnswer(browseAnswer()) === rick(160), avatarFromAnswer(browseAnswer()));
  check('…without the header: the 900 px one of the metadata, at 176 px', avatarFromAnswer({ metadata: browseAnswer().metadata }) === rick(176));
  check("…the older header and the TV client's header are read too", avatarFromAnswer({ header: { c4TabbedHeaderRenderer: { avatar: { thumbnails: sized(rick, 48, 88, 176) } } } }) === rick(176) && avatarFromAnswer({ contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { header: { channelHeaderRenderer: { avatar: { thumbnails: sized(rick, 72) } } } } } } } }) === rick(176));
  check("a watch answer: the owner's picture (176 px)", avatarFromAnswer(nextAnswer()) === coco(176), avatarFromAnswer(nextAnswer()));
  const result = { videoId: 'e_04ZrNroTo', channelThumbnailSupportedRenderers: { channelThumbnailWithLinkRenderer: { thumbnail: { thumbnails: [{ url: coco(88), width: 68, height: 68 }] }, navigationEndpoint: { browseEndpoint: { browseId: COCO } } } } };
  check('a search result (videoRenderer), bare or wrapped', avatarFromAnswer(result) === coco(88) && avatarFromAnswer({ videoRenderer: result }) === coco(88));
  check("a search result's newer avatar block alone", avatarFromAnswer({ videoId: 'e_04ZrNroTo', avatar: { decoratedAvatarViewModel: { avatar: { avatarViewModel: { image: { sources: [{ url: coco(68), width: 68, height: 68 }] } } } } } }) === coco(176));
  const html = `<html><head><title>Rick Astley - YouTube</title><link rel="image_src" href="${rick(900)}"><meta property="og:title" content="Rick Astley"><meta property="og:image" content="${rick(900)}"><meta property="og:image:width" content="900"></head><body><img src="${coco(88)}"></body></html>`;
  check('a channel page (HTML): og:image, at 176 px', avatarFromAnswer(html) === rick(176), avatarFromAnswer(html));
  check('…or its image_src link', avatarFromAnswer(`<link rel="image_src" href="${rick(900)}">`) === rick(176));
  check('JSON given as text is parsed', avatarFromAnswer(JSON.stringify(browseAnswer())) === rick(160) && avatarFromAnswer('  ' + JSON.stringify(nextAnswer())) === coco(176));
  check('an answer without a picture gives nothing (unknown channel, Topic channel, error, junk)', [emptyAnswer, {}, null, undefined, 7, '', '{"header":', '<html></html>', { error: { code: 400 } }, { contents: { twoColumnWatchNextResults: { results: { results: { contents: [{}, {}] } } } } }].every((a) => avatarFromAnswer(a) === undefined));
  check("another channel's picture deeper in a channel page is not taken", avatarFromAnswer({ header: {}, contents: { twoColumnBrowseResultsRenderer: { tabs: [{ lockupViewModel: { image: { sources: sized(coco, 88) } } }] } } }) === undefined);

  // ---- the channel an answer is about
  const fromBrowse = channelFromAnswer(browseAnswer());
  const fromNext = channelFromAnswer(nextAnswer());
  check('a channel page answer names its channel and handle', fromBrowse.channelId === RICK && fromBrowse.handle === 'RickAstleyYT', fromBrowse);
  check('a watch answer names the owner', fromNext.channelId === COCO && fromNext.handle === 'CoComelon', fromNext);
  check('a resolved handle names the channel; an empty answer names nothing', channelFromAnswer({ endpoint: { browseEndpoint: { browseId: RICK } } }).channelId === RICK && channelFromAnswer(emptyAnswer).channelId === undefined && channelFromAnswer(null).handle === undefined);
  check('a channel without a handle (canonicalBaseUrl /channel/UC…) has none', channelFromAnswer(nextAnswer(COCO, coco, '')).handle === undefined && channelFromAnswer({ contents: { twoColumnWatchNextResults: { results: { results: { contents: [{ videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { navigationEndpoint: { browseEndpoint: { browseId: COCO, canonicalBaseUrl: `/channel/${COCO}` } } } } } }] } } } } }).handle === undefined);
  check('handles: "@Name", "Name", a page address, an encoded one', cleanHandle('@RickAstleyYT') === 'RickAstleyYT' && cleanHandle('RickAstleyYT') === 'RickAstleyYT' && cleanHandle('https://www.youtube.com/@RickAstleyYT/videos?x=1') === 'RickAstleyYT' && cleanHandle('/@caf%C3%A9') === 'café', cleanHandle('/@caf%C3%A9'));
  check('a channel name, a channel id and junk are no handle', [`Rick Astley`, RICK, 'https://www.youtube.com/channel/' + RICK, '', undefined, 7, '@'].every((h) => cleanHandle(h) === undefined));

  // ---- with a channel id: one request, then none
  let f = fake();
  setAvatarTransport(f.t);
  let url = await channelAvatar({ channelId: RICK, videoId: 'dQw4w9WgXcQ' }, log);
  check('with a channel id: one request for its page data', url === rick(160) && f.calls.join() === `browse ${RICK}`, { url, calls: f.calls });
  url = await channelAvatar({ channelId: RICK }, log);
  check('the second time no request at all', url === rick(160) && f.calls.length === 1, f.calls);
  check('…and the handle the answer named, and the video, find it too', (await channelAvatar({ handle: '@rickastleyyt' }, log)) === rick(160) && (await channelAvatar({ videoId: 'dQw4w9WgXcQ' }, log)) === rick(160) && f.calls.length === 1, f.calls);
  check('avatarIfKnown answers without asking', avatarIfKnown({ channelId: RICK }) === rick(160) && avatarIfKnown({ channelId: COCO }) === undefined && avatarIfKnown({}) === undefined && f.calls.length === 1);
  let st = youtubeAvatarStatus();
  check('the status counts one lookup, one request, one picture', st.lookups === 1 && st.requests === 1 && st.found === 1 && st.failed === 0 && st.kept === 3 && st.running === 0 && st.waiting === 0, st);

  // ---- with a video id only: the watch data, which also names the channel
  f = fake();
  setAvatarTransport(f.t);
  url = await channelAvatar({ videoId: 'e_04ZrNroTo' }, log);
  check('with a video id only: one request for its watch data', url === coco(176) && f.calls.join() === 'next e_04ZrNroTo', { url, calls: f.calls });
  check('another video of that channel costs nothing once the channel is known', (await channelAvatar({ channelId: COCO, videoId: 'wV3N-wCRL2k' }, log)) === coco(176) && (await channelAvatar({ handle: 'CoComelon' }, log)) === coco(176) && f.calls.length === 1, f.calls);
  f = fake();
  setAvatarTransport(f.t);
  url = await channelAvatar({ handle: 'CoComelon', videoId: 'e_04ZrNroTo' }, log);
  check('a handle and a video id: the watch data (one request), not the two of the handle', url === coco(176) && f.calls.join() === 'next e_04ZrNroTo', f.calls);

  // ---- with a handle only: its channel id, then the page data
  f = fake();
  setAvatarTransport(f.t);
  url = await channelAvatar({ handle: 'https://www.youtube.com/@RickAstleyYT' }, log);
  check('with a handle only: two requests (the channel id, then its page data)', url === rick(160) && f.calls.join() === `resolve RickAstleyYT,browse ${RICK}`, { url, calls: f.calls });
  check('…and the channel id is known afterwards', avatarIfKnown({ channelId: RICK }) === rick(160));
  f = fake({ resolve: async () => ({ endpoint: { browseEndpoint: { browseId: COCO } } }) });
  setAvatarTransport(f.t);
  rememberAvatar({ channelId: COCO }, coco(88));
  url = await channelAvatar({ handle: 'CoComelon' }, log);
  check('a handle that leads to a known channel needs its channel id only', url === coco(88) && f.calls.join() === 'resolve CoComelon', { url, calls: f.calls });
  f = fake({ resolve: async () => ({}) });
  setAvatarTransport(f.t);
  logs.length = 0;
  check('a handle that leads nowhere gives nothing', (await channelAvatar({ handle: 'nobody-here' }, log)) === undefined && f.calls.join() === 'resolve nobody-here' && /leads to no channel/.test(logs.join()), { calls: f.calls, logs });

  // ---- a channel page without a picture: the watch data is asked next
  f = fake({ browse: async () => emptyAnswer });
  setAvatarTransport(f.t);
  url = await channelAvatar({ channelId: RICK, videoId: 'dQw4w9WgXcQ' }, log);
  check('a channel page without a picture (a Topic channel): the watch data of the video is asked', url === coco(176) && f.calls.join() === `browse ${RICK},next dQw4w9WgXcQ`, { url, calls: f.calls });

  // ---- pictures other answers carried
  f = fake();
  setAvatarTransport(f.t);
  rememberAvatar({ channelId: COCO, handle: '@CoComelon' }, coco(68));
  rememberAvatar({ channelId: RICK }, 'https://evil.example/x.jpg');
  rememberAvatar({ channelId: RICK }, undefined);
  check("a search result's picture is kept at 176 px and found by channel id and handle, without a request", (await channelAvatar({ channelId: COCO }, log)) === coco(176) && (await channelAvatar({ handle: 'cocomelon' }, log)) === coco(176) && f.calls.length === 0, f.calls);
  check('an address that is no picture is not kept', avatarIfKnown({ channelId: RICK }) === undefined);

  // ---- failures: never thrown, kept 10 min; pictures kept 30 days and checked after a day, behind the answer
  let clock = 1_800_000_000_000;
  let failing = true;
  let newPicture = false;
  f = fake({
    browse: async (id) => {
      if (failing) throw new Error('YouTube answered 429: Too Many Requests');
      return newPicture ? browseAnswer(id, coco) : browseAnswer(id);
    },
  });
  setAvatarTransport(f.t, { now: () => clock });
  logs.length = 0;
  let threw = false;
  try {
    url = await channelAvatar({ channelId: RICK }, log);
  } catch {
    threw = true;
  }
  check('a failed request gives undefined, not an error, and is logged with its reason', !threw && url === undefined && logs.length === 1 && /no picture for UCuAXFkgsw1L7xaCfnd5JJOw \(channel page data: YouTube answered 429/.test(logs[0]), logs);
  st = youtubeAvatarStatus();
  check('…and shows in the status', st.failed === 1 && st.found === 0 && /429/.test(st.lastFailure?.reason || ''), st);
  failing = false;
  clock += 9 * 60 * 1000;
  check('within 10 minutes it is not asked again', (await channelAvatar({ channelId: RICK }, log)) === undefined && f.calls.length === 1, f.calls);
  clock += 2 * 60 * 1000;
  check('after 10 minutes it is', (await channelAvatar({ channelId: RICK }, log)) === rick(160) && f.calls.length === 2, f.calls);
  clock += 23 * 60 * 60 * 1000;
  check('within a day a kept picture costs no request', (await channelAvatar({ channelId: RICK }, log)) === rick(160) && f.calls.length === 2 && !avatarRefreshing({ channelId: RICK }), f.calls);
  clock += 2 * 60 * 60 * 1000;
  failing = true;
  const atOnce = await channelAvatar({ channelId: RICK }, log);
  check('older than a day: the kept picture is answered at once, and looked up again behind the answer', atOnce === rick(160) && avatarRefreshing({ channelId: RICK }), { atOnce, calls: f.calls });
  await tick(5);
  check('a check that fails keeps the old picture', f.calls.length === 3 && avatarIfKnown({ channelId: RICK }) === rick(160) && !avatarRefreshing({ channelId: RICK }), f.calls);
  clock += 5 * 60 * 1000;
  check('…and is not repeated for 10 minutes', (await channelAvatar({ channelId: RICK }, log)) === rick(160) && (await tick(5), f.calls.length === 3), f.calls);
  clock += 6 * 60 * 1000;
  failing = false;
  newPicture = true;
  const stillOld = avatarKept({ channelId: RICK }, log);
  check('a feed item on its way out gets the kept picture at once and starts the check too', stillOld === rick(160) && avatarRefreshing({ channelId: RICK }), stillOld);
  await tick(5);
  st = youtubeAvatarStatus();
  check("the channel's new picture is what the next ask gets", f.calls.length === 4 && (await channelAvatar({ channelId: RICK }, log)) === coco(160) && st.changed === 1 && st.refreshed === 2, { calls: f.calls, st });
  check('a channel that is not kept costs a feed item no request', avatarKept({ channelId: COCO }, log) === undefined && (await tick(5), f.calls.length === 4), f.calls);
  clock += 29 * 24 * 60 * 60 * 1000;
  newPicture = false;
  check('after 29 days the picture is still answered at once', (await channelAvatar({ channelId: RICK }, log)) === coco(160), f.calls);
  await tick(5);
  check('…and the check behind it brought the current one', f.calls.length === 5 && avatarIfKnown({ channelId: RICK }) === rick(160), f.calls);
  clock += 31 * 24 * 60 * 60 * 1000;
  check('after 30 days without a check it is looked up like a new one', avatarIfKnown({ channelId: RICK }) === undefined && (await channelAvatar({ channelId: RICK }, log)) === rick(160) && f.calls.length === 6, f.calls);

  // ---- the file: pictures survive a restart
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-avatars-')), 'youtube-avatars.json');
  setAvatarTransport(f.t, { now: () => clock });
  check('no file yet: an empty start', loadAvatarStore(file) === 0);
  rememberAvatar({ channelId: COCO, handle: 'CoComelon' }, coco(88));
  await channelAvatar({ channelId: RICK }, log);
  saveAvatarStore();
  const callsBefore = f.calls.length;
  setAvatarTransport(f.t, { now: () => clock }); // "restart": everything in memory is gone
  check('after a restart nothing is known until the file is read', avatarIfKnown({ channelId: COCO }) === undefined);
  const read = loadAvatarStore(file);
  check('the kept pictures are read back and cost no request', read >= 3 && (await channelAvatar({ handle: 'cocomelon' }, log)) === coco(88) && (await channelAvatar({ channelId: RICK }, log)) === rick(160) && f.calls.length === callsBefore, { read, calls: f.calls.slice(callsBefore) });
  clock += 31 * 24 * 60 * 60 * 1000;
  setAvatarTransport(f.t, { now: () => clock });
  check('entries past their 30 days are not read', loadAvatarStore(file) === 0);
  fs.writeFileSync(file, 'not json');
  check('an unreadable file is an empty start, not an error', loadAvatarStore(file) === 0);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  clock = 1_800_000_000_000;
  setAvatarTransport(fake({ browse: async () => Promise.reject(new Error('down')) }).t);
  threw = false;
  try {
    url = await channelAvatar({ channelId: RICK }, () => {
      throw new Error('the log is broken');
    });
  } catch {
    threw = true;
  }
  check('a log that throws does not make the lookup throw', !threw && url === undefined);
  check('nothing to ask with gives nothing, without a request', (await channelAvatar({}, log)) === undefined && (await channelAvatar({ channelId: 'not-a-channel', videoId: 'short', handle: 'a b' }, log)) === undefined && (await channelAvatar(undefined as never, log)) === undefined);

  // ---- no answer within the limit
  const never = gate();
  f = fake({ browse: () => never.wait.then(() => browseAnswer()) });
  setAvatarTransport(f.t, { timeoutMs: 60 });
  logs.length = 0;
  const started = Date.now();
  url = await channelAvatar({ channelId: RICK }, log);
  check('a request without an answer is given up (5 s in production, 60 ms here)', url === undefined && Date.now() - started < 1000 && /no answer within 0\.06 s/.test(logs.join()), { ms: Date.now() - started, logs });
  never.open();
  await tick(5);
  check('…and an answer that still comes late is kept', avatarIfKnown({ channelId: RICK }) === rick(160) && youtubeAvatarStatus().running === 0);

  // ---- lookups for the same channel share one request
  const g = gate();
  f = fake({ browse: (id) => g.wait.then(() => browseAnswer(id)) });
  setAvatarTransport(f.t);
  const same = [channelAvatar({ channelId: RICK, videoId: 'dQw4w9WgXcQ' }, log), channelAvatar({ channelId: RICK }, log), channelAvatar({ channelId: RICK, handle: 'RickAstleyYT' }, log)];
  await tick(5);
  g.open();
  const sameUrls = await Promise.all(same);
  check('three lookups for one channel at the same time: one request', sameUrls.every((u) => u === rick(160)) && f.calls.length === 1, f.calls);

  // ---- two lookups at a time
  const gates = new Map<string, { wait: Promise<void>; open: () => void }>();
  let active = 0;
  let most = 0;
  f = fake({
    browse: async (id) => {
      active++;
      most = Math.max(most, active);
      const mine = gate();
      gates.set(id, mine);
      await mine.wait;
      active--;
      return browseAnswer(id);
    },
  });
  setAvatarTransport(f.t);
  const ids = [0, 1, 2, 3, 4, 5].map((n) => `UC${String(n).repeat(22)}`);
  const all = ids.map((id) => channelAvatar({ channelId: id }, log));
  await tick(5);
  st = youtubeAvatarStatus();
  check('of six lookups two run and four wait', active === 2 && st.running === 2 && st.waiting === 4 && f.calls.length === 2, { active, st, calls: f.calls });
  // a seventh channel that is already known does not wait in the line
  rememberAvatar({ channelId: COCO }, coco(88));
  check('a known channel answers at once while others wait', (await channelAvatar({ channelId: COCO }, log)) === coco(88));
  // the third in line is learned meanwhile: its turn sends no request
  rememberAvatar({ channelId: ids[2] }, rick(88));
  for (let i = 0; i < 12 && gates.size < 5; i++) {
    for (const x of gates.values()) x.open();
    await tick(5);
  }
  for (const x of gates.values()) x.open();
  const urls = await Promise.all(all);
  st = youtubeAvatarStatus();
  check('all six end with a picture, never more than two requests at once', urls.every((u, i) => u === (i === 2 ? rick(88) : rick(160))) && most === 2 && st.running === 0 && st.waiting === 0, { most, st });
  check('a channel learned while its lookup waited costs no request', f.calls.length === 5 && !f.calls.includes(`browse ${ids[2]}`), f.calls);

  // ---- at most 6000 kept
  setAvatarTransport(fake().t);
  for (let n = 0; n < 6001; n++) rememberAvatar({ channelId: `UC${String(n).padStart(22, '0')}` }, rick(88));
  check('at most 6000 are kept; the oldest leaves first', youtubeAvatarStatus().kept === 6000 && avatarIfKnown({ channelId: `UC${'0'.repeat(22)}` }) === undefined && avatarIfKnown({ channelId: `UC${String(6000).padStart(22, '0')}` }) === rick(88), youtubeAvatarStatus().kept);

  setAvatarTransport(undefined);
}

/** Four small requests to YouTube: a channel by id, a "made for kids" video by id alone, a handle (two). */
export async function youtubeAvatarNetworkChecks(check: Check): Promise<void> {
  console.log('\n== 5j. YouTube channel pictures against youtube.com (network)');
  setAvatarTransport(undefined);
  const logs: string[] = [];
  const log = (m: string): void => void logs.push(m);
  const picture = (u: string | undefined): boolean => /^https:\/\/yt3\.(ggpht|googleusercontent)\.com\/.+=s(88|120|160|176)-/.test(u || '');
  let t = Date.now();
  const byChannel = await channelAvatar({ channelId: RICK }, log);
  check('a channel id gives its picture', picture(byChannel), { url: byChannel, ms: Date.now() - t, logs });
  t = Date.now();
  const byVideo = await channelAvatar({ videoId: 'e_04ZrNroTo' }, log);
  check('a "made for kids" video id alone gives its channel\'s picture, and names the channel', picture(byVideo) && avatarIfKnown({ channelId: COCO }) === byVideo, { url: byVideo, ms: Date.now() - t, logs });
  const before = youtubeAvatarStatus().requests;
  const byHandle = await channelAvatar({ handle: '@RickAstleyYT' }, log);
  check('a handle the first answer named costs no request', byHandle === byChannel && youtubeAvatarStatus().requests === before, { url: byHandle, status: youtubeAvatarStatus() });
  t = Date.now();
  const resolved = await channelAvatar({ handle: '@PBSKIDS' }, log);
  check('a handle alone gives its picture (two requests)', picture(resolved) && youtubeAvatarStatus().requests === before + 2, { url: resolved, ms: Date.now() - t, status: youtubeAvatarStatus(), logs });
  check('the answers are the small masked ones (no "mask" warning in the log)', !logs.some((l) => /mask/.test(l)), logs);
  setAvatarTransport(undefined);
}

if (require.main === module) {
  let failures = 0;
  const check: Check = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
    if (!cond) failures++;
  };
  (async () => {
    await youtubeAvatarChecks(check);
    if (process.env.AVATAR_NETWORK === '1') await youtubeAvatarNetworkChecks(check);
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
    process.exit(failures ? 1 : 0);
  })().catch((e) => {
    console.error('test runner crashed:', e);
    process.exit(1);
  });
}
