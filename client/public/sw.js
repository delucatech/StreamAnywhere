/*
 * Service worker: the pages and their scripts come from this device, so opening an app or coming
 * back to the home screen does not wait for the network, and the Video Library plays offline.
 *
 *  - Built scripts and styles (/assets/…, content-hashed, immutable): cache first; the ones the
 *    pages reference are fetched into the cache when the worker installs, so even a first open of
 *    an app after a deploy has them ready.
 *  - The pages (home, feed, library): the network, but no longer than PAGE_WAIT_MS – after that the
 *    cached copy, and the cached copy at once when offline. A cached copy is used only while every
 *    script and style it references is cached too (after a deploy the server no longer has the old
 *    ones, and a page whose scripts are gone shows nothing). When the network then brings a newer
 *    page, the window that got the old copy is told (message "page-updated"); the feed page reloads
 *    if it has not started playing, the home screen reloads right away.
 *  - Icons / manifest: cache first.
 *  - Everything else (the API, media relays, the login page, the dev server's modules) is not
 *    touched: the browser does what it always did.
 *
 * Library playback needs no network at all once the page is open: the video comes from IndexedDB and
 * the decoding happens in the browser (WebCodecs or the <video> fallback). The library list shown
 * offline is the page's own mirror of the server's library (IndexedDB), not a cached API answer.
 */
const CACHE = 'sa-pages-v3';
const PAGES = ['/home.html', '/feed.html', '/library.html'];
const STATIC = ['/icon.svg', '/manifest.webmanifest', '/apple-touch-icon.png'];
const PAGE_WAIT_MS = 1500;

/** The scripts and styles a page references (the build writes them as /assets/… links). */
const assetsOf = (html, base) => {
  const out = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+\.(?:js|css))"/g)) out.add(new URL(m[1], base).href);
  return [...out];
};

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        await c.addAll([...PAGES, ...STATIC]).catch(() => undefined);
        // the pages' scripts and styles too, each on its own (one missing must not stop the rest)
        for (const p of PAGES) {
          const res = await c.match(p);
          if (!res) continue;
          const html = await res.text().catch(() => '');
          for (const a of assetsOf(html, self.location.origin + p)) {
            if (!(await c.match(a))) await c.add(a).catch(() => undefined);
          }
        }
      })
      .then(() => self.skipWaiting()),
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

const cacheable = (res) => res && res.ok && !res.redirected && (res.type === 'basic' || res.type === 'default');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/login') return;

  if (p.startsWith('/assets/') || STATIC.includes(p)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (cacheable(res)) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  const isPage = req.mode === 'navigate' && (PAGES.includes(p) || p === '/');
  if (isPage) {
    const key = p === '/' ? '/home.html' : p;
    const clientId = e.resultingClientId || e.clientId;
    let servedStale = false;
    const net = fetch(req).then((res) => {
      if (cacheable(res)) e.waitUntil(storePage(key, res.clone(), clientId, () => servedStale));
      return res;
    });
    // the network's answer while it is quick; the (complete) cached page once it is slow; the network
    // when nothing usable is cached
    const slow = new Promise((resolve) => setTimeout(resolve, PAGE_WAIT_MS)).then(() => consistentCachedPage(key));
    e.respondWith(
      Promise.race([net.then((res) => ({ res, from: 'net' })), slow.then((res) => ({ res, from: 'cache' }))])
        .then(({ res, from }) => {
          if (res && from === 'cache') servedStale = true;
          return res || net;
        })
        .catch(() =>
          consistentCachedPage(key).then((hit) => {
            if (hit) servedStale = true;
            return hit || Response.error();
          }),
        ),
    );
  }
});

/** The cached page, only when every script and style it references is cached too; undefined otherwise. */
async function consistentCachedPage(key) {
  const c = await caches.open(CACHE);
  const hit = await c.match(key);
  if (!hit) return undefined;
  const html = await hit.clone().text();
  for (const a of assetsOf(html, self.location.origin + key)) if (!(await c.match(a))) return undefined;
  return hit;
}

/**
 * Keeps a page that came from the network, with its scripts and styles (so the cached copy stays
 * usable), and tells the window that was shown an older copy meanwhile that a newer page is here.
 */
async function storePage(key, res, clientId, servedStale) {
  const c = await caches.open(CACHE);
  const html = await res.clone().text();
  const old = await c.match(key);
  const oldHtml = old ? await old.clone().text() : '';
  await c.put(key, res);
  for (const a of assetsOf(html, self.location.origin + key)) {
    if (!(await c.match(a))) await c.add(a).catch(() => undefined);
  }
  if (servedStale() && html !== oldHtml && clientId) {
    const client = await self.clients.get(clientId);
    if (client) client.postMessage({ type: 'page-updated', page: key });
  }
}
