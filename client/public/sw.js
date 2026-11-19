/*
 * Service worker: the app is installed on this device and opens from there.
 *
 * How it works (since 2026-11-19; before that the pages came from the network first):
 *
 *  - The build writes /app-version.json: a version and the list of everything that belongs to it
 *    (the pages, their content-hashed scripts and styles, the icons).
 *  - The copy on this device is one whole version: its pages, its scripts and the version file it
 *    came from, all in one cache. A page is answered from that copy AT ONCE, without asking the
 *    network - opening the app does not wait for the server, and works without a connection.
 *  - Every time the app is opened (a page is navigated to, or the page says it came back to the
 *    front: message "check-update") the worker asks the server for /app-version.json. The same
 *    version: nothing to do. Another one: everything new is downloaded in the background - scripts
 *    first, then the pages together, the version file last - and only then does the device's copy
 *    switch over. A download that fails half way leaves the version in use untouched.
 *  - The pages are told what the check found (message "app-update": current / updated /
 *    unreachable / login / none); src/appUpdate.ts reloads a page whose newer copy is ready (unless
 *    something is playing) and shows "Reconnecting…" / "Could not connect" when the server did not
 *    answer.
 *
 * What is NOT in this cache, and is never touched by an update: saved videos and the feed's media
 * cache (IndexedDB), settings and sign-in state (localStorage / cookies). The API, the media relays
 * and the login page always go to the network.
 *
 * Without a version file on the server (the Vite dev server, a build from before this change) the
 * worker keeps no pages and answers none: the browser does what it always did.
 */
const CACHE = 'sa-app-v5';
const VERSION_URL = '/app-version.json';
/** The pages kept on the device (the lab player, the downloader and the phone's sender page are not) */
const APP_PAGES = ['/home.html', '/feed.html', '/library.html', '/livetv.html', '/mirror.html'];
const STATIC = ['/icon.svg', '/manifest.webmanifest', '/apple-touch-icon.png'];
/** The version question must be answered quickly: it decides between "current" and "could not connect" */
const VERSION_TIMEOUT_MS = 10000;
const FILE_TIMEOUT_MS = 45000;
/** A check that finished this recently answers the next one too (a navigation and its page both ask) */
const REUSE_MS = 3000;
const PARALLEL = 4;

const pathOf = (url) => new URL(url, self.location.origin).pathname;

/**
 * A cache lookup by address alone. The server answers everything with "Vary: Origin" (its CORS
 * plugin), and a page's module scripts are requested WITH an Origin header while the copies here
 * were downloaded without one: a plain match() then finds nothing, the script goes to the network,
 * and without a connection the page stays empty (seen 2026-11-19 with the server stopped).
 */
const lookup = (c, req) => c.match(req, { ignoreVary: true });

/** The scripts and styles a page references (the build writes them as /assets/… links). */
const assetsOf = (html) => {
  const out = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+\.(?:js|css))"/g)) out.add(pathOf(m[1]));
  return [...out];
};

async function timedFetch(url, ms, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { credentials: 'same-origin', ...init, signal: ctl.signal });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? `no answer within ${Math.round(ms / 1000)} s` : (e && e.message) || 'the request failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Sent to the site's login page: the password cookie is missing or has expired. */
const isLogin = (res) => res.redirected && pathOf(res.url) === '/login';

/** One file of a version, or an error that says what was wrong with it. */
async function download(path, init) {
  const res = await timedFetch(path, FILE_TIMEOUT_MS, init);
  if (isLogin(res)) throw new Error('signed out');
  if (!res.ok || res.redirected || (res.type !== 'basic' && res.type !== 'default')) throw new Error(`${path}: the server answered ${res.status}`);
  return res;
}

/** Runs `work` over `items`, at most `n` at a time; the first failure stops the rest. */
async function pool(items, n, work) {
  let i = 0;
  let failed;
  const next = async () => {
    while (i < items.length && !failed) {
      const item = items[i++];
      try {
        await work(item);
      } catch (e) {
        failed = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, next));
  if (failed) throw failed;
}

/** The version this device holds ({ version, pages, assets, previousAssets, pageChangedAt }), or undefined. */
async function installed(c) {
  const res = await lookup(c, VERSION_URL);
  if (!res) return undefined;
  try {
    const v = await res.json();
    return v && typeof v.version === 'string' && Array.isArray(v.pages) && Array.isArray(v.assets) ? v : undefined;
  } catch (e) {
    return undefined;
  }
}

/** Everything the version lists is really in the cache (a browser may drop entries; a download may have been cut). */
async function complete(c, v) {
  const have = new Set((await c.keys()).map((r) => pathOf(r.url)));
  return [...v.pages, ...v.assets].every((p) => have.has(p));
}

const validManifest = (m) =>
  !!m && typeof m.version === 'string' && !!m.version && Array.isArray(m.pages) && Array.isArray(m.assets) && m.pages.every((p) => typeof p === 'string') && m.assets.every((a) => typeof a === 'string');

/**
 * Brings the device's copy to version `next`. Order matters: the scripts and styles first (their
 * names carry a content hash, so the ones already here are right and are not fetched again), then
 * every page, held in memory until all of them arrived, then pages + version file are stored. A
 * page in the cache therefore always has its scripts. Returns the pages whose text changed and
 * when (pages loaded before that moment show the older copy).
 */
async function install(c, cur, next) {
  const pages = next.pages.filter((p) => APP_PAGES.includes(p));
  const assets = next.assets.filter((a) => a.startsWith('/assets/'));
  if (!pages.length) throw new Error('the version file lists no pages');

  const have = new Set((await c.keys()).map((r) => pathOf(r.url)));
  await pool(assets.filter((a) => !have.has(a)), PARALLEL, async (a) => c.put(a, await download(a)));

  const fresh = [];
  await pool(pages, PARALLEL, async (p) => {
    const res = await download(p, { cache: 'no-store' });
    fresh.push({ path: p, text: await res.clone().text(), res });
  });
  // a page that references a script the list does not name (should not happen) gets it too
  const listed = new Set(assets);
  const extra = [...new Set(fresh.flatMap((f) => assetsOf(f.text)))].filter((a) => !listed.has(a));
  await pool(extra.filter((a) => !have.has(a)), PARALLEL, async (a) => c.put(a, await download(a)));

  const now = Date.now();
  const pageChangedAt = { ...((cur && cur.pageChangedAt) || {}) };
  const changed = [];
  for (const f of fresh) {
    const old = await lookup(c, f.path);
    const oldText = old ? await old.text() : undefined;
    // a first install changes nothing anyone is looking at: no page came from this cache before
    if (cur && oldText !== f.text) {
      changed.push(f.path);
      pageChangedAt[f.path] = now;
    }
  }
  await Promise.all(fresh.map((f) => c.put(f.path, f.res)));
  // icons and the web manifest: nice to have, never a reason to fail
  await Promise.all(STATIC.map((p) => download(p, { cache: 'no-store' }).then((res) => c.put(p, res)).catch(() => undefined)));
  const record = { version: next.version, built: next.built, pages, assets: [...assets, ...extra], previousAssets: (cur && cur.assets) || [], pageChangedAt, installedAt: now };
  await c.put(VERSION_URL, new Response(JSON.stringify(record), { headers: { 'content-type': 'application/json' } }));

  // Scripts of versions before the previous one go. The previous version's stay: a page that is
  // still open runs it and may ask for one of its parts later.
  const keep = new Set([...record.assets, ...record.previousAssets]);
  for (const req of await c.keys()) {
    const p = pathOf(req.url);
    if ((p.startsWith('/assets/') && !keep.has(p)) || (APP_PAGES.includes(p) && !pages.includes(p))) await c.delete(req);
  }
  return { pages: changed, changedAt: now };
}

/** The server has no version file: nothing is served from this device (dev server, an old build). */
async function forget(c) {
  for (const req of await c.keys()) {
    const p = pathOf(req.url);
    if (p === VERSION_URL || APP_PAGES.includes(p)) await c.delete(req);
  }
}

/**
 * One check. The answer's state:
 *   current      the device has the server's version
 *   updated      a newer version was downloaded and is the device's copy now (pages: the ones that
 *                changed, changedAt: when - a page loaded before that shows the older copy)
 *   unreachable  the server did not answer, or a download failed (detail says what); the copy in use is unchanged
 *   login        the site password cookie is gone
 *   none         the server has no version file
 */
async function runCheck() {
  let res;
  try {
    res = await timedFetch(VERSION_URL, VERSION_TIMEOUT_MS, { cache: 'no-store' });
  } catch (e) {
    return { state: 'unreachable', detail: e.message };
  }
  const c = await caches.open(CACHE);
  const cur = await installed(c);
  const have = cur ? cur.version : undefined;
  if (isLogin(res)) return { state: 'login', version: have };
  if (res.status === 404) {
    await forget(c);
    return { state: 'none' };
  }
  // the Vite dev server answers an unknown path with its index page (200, text/html)
  if (res.ok && !/json/i.test(res.headers.get('content-type') || '')) return { state: 'none' };
  if (!res.ok) return { state: 'unreachable', detail: `the server answered ${res.status}`, version: have };
  let next;
  try {
    next = await res.json();
  } catch (e) {
    next = undefined;
  }
  if (!validManifest(next)) return { state: 'unreachable', detail: 'the version file could not be read', version: have };
  if (cur && cur.version === next.version && (await complete(c, cur))) return { state: 'current', version: have };
  try {
    const done = await install(c, cur, next);
    return { state: 'updated', version: next.version, from: have, pages: done.pages, changedAt: done.changedAt };
  } catch (e) {
    if (e && e.message === 'signed out') return { state: 'login', version: have };
    return { state: 'unreachable', detail: `the new version could not be downloaded (${(e && e.message) || e})`, version: have };
  }
}

let running;
let last;
/** The check, once at a time: callers during a check share its answer, and so do callers right after it. */
function check() {
  if (running) return running;
  if (last && Date.now() - last.at < REUSE_MS) return Promise.resolve(last.result);
  running = runCheck()
    .catch((e) => ({ state: 'unreachable', detail: (e && e.message) || String(e) }))
    .then(async (result) => {
      last = { at: Date.now(), result };
      running = undefined;
      // every open window hears about a new version, not only the one that asked
      if (result.state === 'updated' && result.pages.length) await broadcast({ type: 'app-update', ...result });
      return result;
    });
  return running;
}

async function broadcast(msg) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of all) client.postMessage(msg);
}

self.addEventListener('install', (e) => {
  // The whole app is fetched before this worker takes over. When the server cannot be reached the
  // installation fails on purpose: the worker before this one (and the copy it holds - activating
  // deletes it) stays in charge, and the browser tries again at the next open.
  e.waitUntil(
    check().then((result) => {
      if (result.state === 'unreachable') throw new Error(`not installed: ${result.detail || 'the server did not answer'}`);
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * A page asks for a check: { type: 'check-update', page: '/feed.html', loadedAt: ms }. The answer
 * goes back to it with `stale`: a newer copy of ITS page was stored after it was loaded (also when
 * that happened before it asked - the check a navigation starts may be done by then).
 */
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'check-update' || !e.source) return;
  const src = e.source;
  e.waitUntil(
    check().then(async (result) => {
      let stale = false;
      if (typeof d.page === 'string' && typeof d.loadedAt === 'number') {
        const cur = await installed(await caches.open(CACHE));
        const at = cur && cur.pageChangedAt ? cur.pageChangedAt[d.page] : undefined;
        stale = typeof at === 'number' && at > d.loadedAt;
      }
      src.postMessage({ type: 'app-update', ...result, stale, reply: true });
    }),
  );
});

const cacheable = (res) => res && res.ok && !res.redirected && (res.type === 'basic' || res.type === 'default');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/login' || p === VERSION_URL) return;

  if (p.startsWith('/assets/') || STATIC.includes(p)) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        lookup(c, req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (cacheable(res)) e.waitUntil(c.put(req, res.clone()));
              return res;
            }),
        ),
      ),
    );
    return;
  }

  if (req.mode === 'navigate' && (APP_PAGES.includes(p) || p === '/')) {
    const key = p === '/' ? '/home.html' : p;
    // the device's copy at once; the network only when there is none (first visit, dev server)
    e.respondWith(cachedPage(key).then((hit) => hit || fetch(req)));
    // the app was opened: look for a newer version (also when the page's own script never runs)
    e.waitUntil(check());
  }
});

/** The device's copy of a page: only as part of an installed version, and only with all its scripts. */
async function cachedPage(key) {
  const c = await caches.open(CACHE);
  const cur = await installed(c);
  if (!cur || !cur.pages.includes(key)) return undefined;
  const hit = await lookup(c, key);
  if (!hit) return undefined;
  const html = await hit.clone().text();
  for (const a of assetsOf(html)) if (!(await lookup(c, a))) return undefined;
  return hit;
}
