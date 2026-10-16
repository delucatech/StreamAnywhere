/*
 * Service worker of the Video Library: lets library.html open and play its local videos without a
 * network.
 *
 *  - Built scripts and styles (/assets/…, content-hashed, immutable): cache first.
 *  - The library page itself (and the home screen): network first, the cached copy when offline.
 *  - Icons / manifest: cache first.
 *  - Everything else (the API, media relays, the login page, other pages, the dev server's modules)
 *    is not touched: the browser does what it always did.
 *
 * Playback needs no network at all once the page is open: the video comes from IndexedDB and the
 * decoding happens in the browser (WebCodecs or the <video> fallback). The library list shown offline
 * is the page's own mirror of the server's library (IndexedDB), not a cached API answer.
 */
const CACHE = 'sa-library-v1';
const PAGES = ['/library.html', '/home.html'];
const STATIC = ['/icon.svg', '/manifest.webmanifest', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([...PAGES, ...STATIC]).catch(() => undefined))
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
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(key, copy));
          }
          return res;
        })
        .catch(() => caches.match(key).then((hit) => hit || Response.error())),
    );
  }
});
