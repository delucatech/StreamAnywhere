/*
 * Service worker: the pages and their scripts come from this device, so opening an app or coming
 * back to the home screen does not wait for the network, and the Video Library plays offline.
 *
 *  - Built scripts and styles (/assets/…, content-hashed, immutable): cache first; the ones the
 *    pages reference are fetched into the cache when the worker installs, so even a first open of
 *    an app after a deploy has them ready.
 *  - The pages (home, feed, library): the network, but no longer than PAGE_WAIT_MS – after that the
 *    cached copy (a deploy shows on the next open); the cached copy at once when offline.
 *  - Icons / manifest: cache first.
 *  - Everything else (the API, media relays, the login page, the dev server's modules) is not
 *    touched: the browser does what it always did.
 *
 * Library playback needs no network at all once the page is open: the video comes from IndexedDB and
 * the decoding happens in the browser (WebCodecs or the <video> fallback). The library list shown
 * offline is the page's own mirror of the server's library (IndexedDB), not a cached API answer.
 */
const CACHE = 'sa-pages-v2';
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
    const net = fetch(req).then((res) => {
      if (cacheable(res)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    });
    // the network's answer while it is quick; the cached page once it is slow; the network when nothing is cached
    const slow = new Promise((resolve) => setTimeout(resolve, PAGE_WAIT_MS)).then(() => caches.match(key));
    e.respondWith(
      Promise.race([net, slow])
        .then((res) => res || net)
        .catch(() => caches.match(key).then((hit) => hit || Response.error())),
    );
  }
});
