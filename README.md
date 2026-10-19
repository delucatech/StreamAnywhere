# StreamAnywhere – experimental browser-side video pipeline

A research prototype that plays TikTok videos (and ordinary MP4 URLs) in a desktop Chromium
browser through a **custom rendering pipeline**, instead of the native `<video>` display:

```
TikTok URL ─► POST /api/resolve ─► cookie-free CDN URL ─► browser fetch() (Range)
                                                           │
                                            mp4box.js demuxer (streaming)
                                                           │
                                 VideoDecoder (WebCodecs)   AudioDecoder (WebCodecs)
                                       │                          │
                                Canvas 2D drawImage         Web Audio (master clock)
```

Everything after `/api/resolve` happens in the browser. The server only resolves metadata and
offers an opt-in, allowlisted streaming proxy for the cases where direct access is impossible.

Status on 2026-10-08, tested in the Chromium 152 build embedded in the Claude desktop app on
Windows 10 (see **Test results** for exactly what was measured):

| Goal | Status |
|---|---|
| MP4 URL → fetch → demux → WebCodecs → Canvas, real-time, with audio, seek, cleanup | **Working** (test MP4 and TikTok) |
| TikTok URL → metadata + media URLs | **Working** (native scraper; yt-dlp fallback) |
| TikTok media fetched **directly** from the CDN by the browser (no proxy) | **Working** via TikTok's cookie-free `/aweme/v1/play` redirect → `tiktokcdn-us.com` (`Access-Control-Allow-Origin: *`) |
| TikTok primary `playAddr` URLs fetched by the browser | **Impossible** – session-cookie-bound and `Access-Control-Allow-Origin: https://www.tiktok.com` (measured) |
| Proxy fallback with Range/seek, CORS, host allowlist, SSRF guard | **Working** |
| Mode A `<video>` → Canvas, Mode C official iframe | **Working** (comparison modes) |
| H.265 TikTok variants through WebCodecs | **Browser-dependent** – fails cleanly where `VideoDecoder.isConfigSupported` says no |
| **Feed page** (`feed.html`): TikTok-style vertical stream, Explore feed without sign-in | **Working** (Node server and IIS handler) |
| Feed page: personal **For You** feed after signing in to TikTok (QR code or window) | **Working mechanism** (signed-out test; QR rendered and refreshed); needs the Node server + Chrome/Edge/Chromium on that machine – see **Feed** |
| **YouTube sign-in**: paste/upload the cookies of a signed-in browser (or a sign-in window on the server machine); **For You** = the account's recommendations | **Working mechanism** (built 2026-10-13; verified signed-out: cookie parsing, YouTube's account check, rejection paths. The signed-in feed itself awaits a real account) – see **YouTube** |
| **Launcher** (`home.html`, the landing page): iPad-style icons that open each platform like an app | **Working** |
| **YouTube, guest mode**: Shorts by hashtag, search, channels; picture + sound as two files played in sync | **Working** (Node server with yt-dlp) – see **YouTube** |
| **Facebook** (built 2026-10-15): **Reels** = the latest reels of a rotation of public Pages, read from facebook.com's own pages over plain HTTPS (no browser, no yt-dlp, no sign-in); pasted reel links; **For You** = the account's Reels feed after a cookie sign-in; one progressive 720p MP4 per reel, fetched by the viewer itself (CORS `*`) | **Working** signed out (dev machine); the signed-in feed awaits a real account; untested from the VM's address – see **Facebook** |
| **Instagram** (built 2026-10-13): **requires a sign-in** (Instagram serves nobody who is signed out): paste/upload the cookies of a signed-in browser (or a sign-in window on the server machine). **Reels** = the latest Reels of a rotation of big public accounts, **For You** = the account's Reels page, `@handle`/link/account search, profiles; one muxed MP4 per Reel | **Working mechanism, unverified signed in** (cookie parsing, rejection of bad cookies, the account rotation, embed resolving and playback are verified signed out; the signed-in feed awaits a real account) – see **Instagram** |

## Repository layout

```
client/   Vite 4 + TypeScript front end (no framework)
  src/media/demuxer.ts            streaming fetch → mp4box.js, Range-based seeking, backpressure
  src/media/codecConfig.ts        avcC/hvcC/esds → VideoDecoderConfig / AudioDecoderConfig
  src/media/audioOutput.ts        Web Audio sink that doubles as the playback clock (+ wall clock)
  src/renderers/webcodecsRenderer.ts   Mode B (primary): WebCodecs → Canvas
  src/renderers/videoElementRenderer.ts Mode A: hidden <video> → rVFC → Canvas
  src/renderers/embedRenderer.ts        Mode C: official TikTok player iframe
  src/cors-test.ts                browser-side fetch()/<video> access tests
  src/diagnostics.ts              the six experiments (measured, with explanations)
  src/main.ts                     UI, source/renderer selection, direct-vs-proxy decision
  home.html + src/home/home.ts    the launcher: one app icon per platform (src/platforms.ts), zoom-open animation
  feed.html + src/feed/feed.ts    the feed page (feed.html?platform=tiktok|youtube|instagram|facebook): stream that follows the finger / mouse and snaps one video at a time (TikTok-like drag), tap-to-pause, auto-scroll, playback speed, download
server/   Fastify 4 + TypeScript (Node 16 compatible)
  src/tiktok.ts                   native TikTok resolver (page JSON) + server-side CORS probe
  src/feed.ts                     Explore feed (unsigned TikTok API) + itemStruct → FeedItem conversion
  src/session.ts                  TikTok sign-in through a real Chrome/Edge (puppeteer-core) + For You capture
  src/youtube.ts                  YouTube guest mode through yt-dlp: hashtag Shorts, search, channels, two-file resolve
  src/instagram.ts                Instagram through a headless Chrome page: account catalog, embed-page resolver, explore/search/profile/For You
  src/instagramSession.ts         Instagram sign-in (cookies / window), account check
  src/facebook.ts                 Facebook over plain HTTPS: Page listings (catalog), reel pages, explore/profile/search/For You
  src/facebookSession.ts          Facebook sign-in (cookies / window), settings-page account check
  src/ytdlp.ts                    yt-dlp fallback resolver
  src/proxy.ts                    GET/HEAD /api/media/:id streaming relay with Range support
  src/ssrf.ts                     https-only, host allowlist, private-IP rejection
  src/tests/run.ts                executable checks (offline + live network)
shared/types.ts                   API types shared by both sides
research/                         the Python probes used to measure TikTok CDN behaviour (+ redacted results)
docs/RESEARCH.md                  detailed findings: cookies, CORS, Referer, expiry, signatures, Range
```

## Setup

Requirements: Node.js **16.17+** (tested on 16.17.0; 18/20 also fine), npm 8+. Optional:
Python 3 with `yt-dlp` (`pip install yt-dlp`) for the fallback resolver.

```bash
npm install
```

Configuration is optional. Copy `.env.example` to `server/.env` (or repo-root `.env`) and adjust:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | resolver/proxy port |
| `CLIENT_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | origins allowed to call `/api` |
| `PROXY_ALLOWED_HOSTS` | *(empty)* | extra upstream hosts the proxy may relay (`host` or `*.suffix`); TikTok CDN hosts and the bundled test-MP4 hosts are always allowed |
| `RESOLVER` | `auto` | `auto` (native, then yt-dlp), `native`, or `ytdlp` |
| `YTDLP_PATH` | *(auto-detect)* | explicit path to `yt-dlp` |
| `SERVE_CLIENT` | `false` | serve `client/dist` from the server (production) |
| `BROWSER_PATH` | *(auto-detect)* | Chrome/Edge executable used for TikTok sign-in / For You (feed page) |
| `TIKTOK_PROFILE_DIR` | `~/.streamanywhere/tiktok-profile` | browser profile that keeps the TikTok session (treat like a password) |
| `YOUTUBE_COOKIES_FILE` | `~/.streamanywhere/youtube-cookies.txt` | the YouTube sign-in: a Netscape cookies.txt yt-dlp reads and refreshes (treat like a password) |
| `YOUTUBE_PROFILE_DIR` | `~/.streamanywhere/youtube-profile` | browser profile of the YouTube sign-in *window* (deleted at sign-out) |
| `INSTAGRAM_COOKIES_FILE` | `~/.streamanywhere/instagram-cookies.txt` | the Instagram sign-in (Netscape cookies.txt; treat like a password); `…cookies.meta.json` next to it keeps the User-Agent the cookies came from |
| `INSTAGRAM_PROFILE_DIR` / `INSTAGRAM_LOGIN_PROFILE_DIR` | `~/.streamanywhere/instagram-profile` / `…-login-profile` | profile of the headless Instagram browser / of the sign-in *window* (both deleted at sign-out) |
| `FACEBOOK_COOKIES_FILE` | `~/.streamanywhere/facebook-cookies.txt` | the Facebook sign-in (Netscape cookies.txt; treat like a password); `…cookies.meta.json` next to it keeps the paste's User-Agent |
| `FACEBOOK_CATALOG_FILE` | `~/.streamanywhere/facebook-catalog.json` | each Page's last listed reels (a cache; deleting it is harmless) |
| `INSTAGRAM_CATALOG_FILE` | `~/.streamanywhere/instagram-catalog.json` | each account's last listed Reels (a cache; deleting it is harmless) |
| `ENABLE_BROWSER_SESSION` | `1` | set `0` to disable the sign-in feature entirely |
| `LOG_LEVEL` | `info` | `debug` adds per-request logs |

### Run (development)

```bash
npm run dev
```

Starts the server on http://127.0.0.1:8787 and Vite on http://localhost:5173 (Vite proxies `/api`).
Open http://localhost:5173 in Chrome/Chromium/Edge.

### Run (production build)

```bash
npm run build
SERVE_CLIENT=true npm start      # PowerShell: $env:SERVE_CLIENT='true'; npm start
```

### Site password

Every page and API call of the Node server needs a password (only `/login` and `/api/health` are
open). The login page sets an HttpOnly cookie that is valid for a year and renewed while the site
is used, so each browser types the password once. The repository holds only a salted scrypt hash
of it (`server/src/auth.ts`); `APP_PASSWORD_HASH` replaces it (the command to make a hash is in
that file, and a new password signs every browser out). `APP_PASSWORD_HASH=off` turns the
password off. The cookie is signed with a secret the server generates on first start and keeps in
`cookie-secret` next to the TikTok profile directory (`APP_COOKIE_SECRET` or
`APP_COOKIE_SECRET_FILE` override it); the hash alone, which is public, cannot mint a cookie.
Behind a reverse proxy on the same host (Caddy) the per-visitor limits use `X-Forwarded-For`
(`TRUST_PROXY`, default `loopback`). The cookie goes to the same origin only, so a client on
another origin (GitHub Pages, `?api=`) cannot use a password-protected server. The IIS handler
has no password.

### Public copies

- Source: https://github.com/delucatech/StreamAnywhere
- Client on GitHub Pages (static, always on): https://delucatech.github.io/StreamAnywhere/
  Pages cannot run the resolver, so there the TikTok modes need an API: deploy the server (below)
  and open `https://delucatech.github.io/StreamAnywhere/?api=https://<your-app>.onrender.com`
  (the value is remembered; the header field shows the API status). Test MP4 and local-file modes
  work on Pages without any server because they never touch the API.

### Deploy to an existing IIS / ASP.NET site (no Node on the server)

`deploy/iis/player/` is a self-contained copy of the app for IIS: the built client plus
`api.ashx`, a single-file ASP.NET generic handler that re-implements the resolver and the
streaming proxy (C# 3 / .NET 3.5 syntax, so it compiles inside an ASP.NET 2.0/3.5 application;
verified against Windows Server 2016 / IIS 10 / .NET 2.0.50727 at https://delucatech.com/player/).

- Upload the folder (or unzip `deploy/iis/player.zip`) to `<site root>\player\`. No IIS
  application, app pool or server setting is needed; the handler routes by path info
  (`/player/api.ashx/api/resolve`, `/player/api.ashx/api/media/<id>`).
- Rebuild the client for another path with `VITE_BASE=/other/ VITE_API_BASE=/other/api.ashx npm run build -w client`.
- Differences from the Node server: no yt-dlp fallback; **no TikTok sign-in / For You feed**
  (the handler cannot run a browser; `/player/feed.html` serves the Explore feed and reports
  this in the sign-in panel); media ids live in the app domain and are lost on app-pool recycle
  (the client simply re-resolves); CORS origins and limits are constants at the top of `api.ashx`.
- The feed batch JSON is far above the MS11-100 member cap of `JavaScriptSerializer`, so the
  handler slices the response text itself (`ExtractArrayObjects` / `ShallowMembers`) and only
  deserialises each item's `video`, `author`, `stats` and `music` objects.
- `deploy/iis/probe.aspx` is a diagnostic page that reports the runtime, TLS and TikTok
  reachability from the server. Delete it after use.

### Deploy to a free Google Cloud VM (For You included)

The For You feed needs a browser on the server, which the container hosts below cannot provide.
Google Cloud's *Always Free* `e2-micro` (us-west1 / us-central1 / us-east1, 30 GB disk) can:

1. Console → Compute Engine → *Create instance*: name `streamanywhere`, region `us-central1`,
   machine `e2-micro`, boot disk Debian 12 (standard persistent disk, 30 GB), firewall: allow
   HTTP and HTTPS. Keep the default ephemeral external IP (a reserved static IP is billed).
2. Instance → *Edit* → *Automation* → *Startup script*:

```bash
#!/bin/bash
curl -fsSL https://raw.githubusercontent.com/delucatech/StreamAnywhere/main/deploy/gcp/setup-vm.sh | bash > /var/log/streamanywhere-setup.log 2>&1
```

   Save, then *Reset* the VM. [`deploy/gcp/setup-vm.sh`](deploy/gcp/setup-vm.sh) adds 2 GB swap,
   installs Node 20, Chromium and Caddy, builds the app into `/opt/streamanywhere`, runs it as a
   systemd service (`journalctl -u streamanywhere -f`), and serves it over HTTPS at
   `https://<external-ip-with-dashes>.sslip.io` (Let's Encrypt, no DNS needed). The first run
   takes about 10 minutes on an e2-micro; it runs again on every boot, so a *Reset* redeploys the
   latest `main`. (The same command also works once over SSH with `sudo`.)
3. Open `https://<that host>/feed.html` → Sign in → Sign in with QR code → scan with the app.

**Stable address without a paid static IP:** the ephemeral IP changes when the VM is stopped and
started. Create a free [DuckDNS](https://www.duckdns.org) subdomain, then add two instance
metadata keys (*Edit → Metadata*): `duckdns-domain` = `yourname` and `duckdns-token` = your token,
and Reset. The VM then keeps `yourname.duckdns.org` pointed at itself (cron, every 5 minutes) and
Caddy serves `https://yourname.duckdns.org`. Your own domain can CNAME to it (`feed.delucatech.com
→ yourname.duckdns.org`; then set metadata `public-host` = `feed.delucatech.com`). The IIS and
GitHub Pages copies of the client cannot use this server: it requires the site password cookie,
which only its own origin receives (see *Site password*). Untested from
my side: whether TikTok treats Google's IP range like a datacenter (captcha at sign-in or an
empty For You feed); the Explore feed and the resolver are unaffected by that.

### Deploy to a free host (no PC required)

Because playback goes straight from the viewer's browser to TikTok's CDN, the server only
resolves metadata and (rarely) relays through the proxy, so a free tier is enough.

**Render (one click, runs the Dockerfile):**

1. Push this repository to GitHub.
2. In Render choose *New → Blueprint*, pick the repo; `render.yaml` creates a free web service
   (Docker, Node 20, yt-dlp included, `SERVE_CLIENT=true`, health check on `/api/health`).
3. Open `https://<service>.onrender.com`. Share that link; viewers need any internet connection.

Free-tier behaviour: the service sleeps after 15 minutes without traffic and takes 30 to 60 s to
wake. Koyeb's free tier works the same way with the same Dockerfile. Any Docker host works:
`docker build -t streamanywhere . && docker run -p 8787:8787 streamanywhere`.

Hosted deployments default to `HOST=0.0.0.0`, serve the built client same-origin (no CORS
setup), rate-limit `/api/resolve` and `/api/probe` to 20 requests per minute per IP and
`/api/media` to 120 (`RATE_LIMIT_RESOLVE`, `RATE_LIMIT_MEDIA`), and the client tries TikTok's
cookie-free redirect URL first so the CDN location is resolved from the *viewer's* IP rather than
the server's datacenter IP.

Things only a real deployment can tell you: whether TikTok serves its bot-check page to that
host's egress IP (then `/api/resolve` fails with "No embedded video JSON" and yt-dlp is tried),
and whether the free tier's bandwidth cap matters when the proxy fallback is used a lot.

### Tests

```bash
npm test                 # offline checks + live network checks (public MP4 + public TikTok video)
SKIP_NETWORK=1 npm test  # offline only
TIKTOK_TEST_URL=https://www.tiktok.com/@user/video/123 npm test   # another public video
npm run typecheck
```

## Feed (TikTok-style stream)

Open **`/feed.html`** (from the launcher; `?platform=youtube` for YouTube). It is a full-window vertical stream like the app:

- One video per screen, scroll-snap. The video that fills the viewport plays; the others pause.
  Mouse wheel, touch, ↑/↓, J/K, PageUp/PageDown move between videos.
- **Tap/click the video to pause and resume** (Space does the same). **M** mutes, **D** downloads.
- **Full screen** (the Full action / **F** / **W**): the video fills the whole window (bars, rail and Up next
  hidden; the browser's fullscreen too where it allows it). **Exit full screen** (top right), **F** or Esc leaves it.
- **Auto-scroll** (checkbox / **A**): when on, a finished video advances to the next one; when off,
  videos loop.
- **⬇ Download** fetches the cookie-free CDN URL as a blob (progress on the button) and saves it as
  `@author_<id>.mp4`; if the direct fetch fails it goes through the server proxy.
- Sources: **Explore** (TikTok's public explore feed, with the same categories as tiktok.com/explore;
  no sign-in; works with both the Node server and the IIS handler) and **For You** (your own feed
  after signing in; Node server only). On YouTube the two are **Shorts** (hashtag Shorts, guest)
  and **For You** (the signed-in account's recommendations, see **YouTube**).
- Playback uses the browser's `<video>` element (several items are kept warm, H.264 variant
  preferred, proxy fallback on error); the WebCodecs pipeline stays on the lab page.

**Signing in to TikTok (For You)** – `Sign in` offers two ways; both use the Chrome/Edge/Chromium
installed on the machine that runs the Node server, with a private profile, and StreamAnywhere never
handles the password:

- **Sign in with QR code** (default, works on a server without a display): a headless page opens
  TikTok's own `login/qrcode` page, the QR canvas is copied into the session status and shown in
  the feed page; scan it with the TikTok app on the phone and confirm. The code is refreshed as
  TikTok rotates it.
- **Open sign-in window on server**: a visible browser window on TikTok's login page, for a PC
  where you can see the screen (any sign-in method).

When TikTok reports a session the status shows `@username` and the feed switches to For You. From
then on a *headless* instance of that profile keeps `tiktok.com/foryou` open: TikTok's web app
does its own request signing (msToken / X-Bogus / X-Gnarly), and the server only reads the
`recommend/item_list` responses it receives, nudging the page (scroll + ArrowDown) when the viewer
needs more. `Sign out` closes the browsers and deletes the profile directory.

Why this design: measured on 2026-10-08, `/api/recommend/item_list/` answers `{"status_code":0}`
without items unless the request carries the signatures minted by TikTok's `webmssdk.js` from a
browser fingerprint, even when replayed from the same machine; the Explore endpoint has no such
requirement. The QR-login passport endpoints refuse the web app id ("Application has no
permissions"), so there is no password-less flow we could drive ourselves. Headless Chrome is
served an error page unless it hides automation (user agent without `HeadlessChrome`,
`--disable-blink-features=AutomationControlled`, no `--enable-automation`) – `session.ts` does that.
Everything after sign-in was verified signed-out (TikTok's guest feed: small batches of 1–6 items,
then a login wall); the signed-in path uses exactly the same capture. Hosted containers (Render,
Docker) have no Chrome: the feed page then offers Explore only and says so.

## Launcher and platforms

**`/`** (`home.html`) is an iPad-style home screen: one icon per platform (TikTok, YouTube, Instagram, Facebook) plus the
Video Library and the lab player, a dock, and a zoom-from-icon animation into `feed.html?platform=…`; the feed's Home
button (top left) zooms back. A green badge on an icon means that platform is signed in on the
server. The page has a web-app manifest, so it can be added to a phone's or tablet's home screen
and runs full screen. Platforms are declared once in `client/src/platforms.ts` (name, colours, icon,
categories); the feed page reads `?platform=` and labels, colours and routes itself accordingly.

## Video Library

The **Library** icon on the home screen opens `library.html` (the Video Downloader grew into it;
`download.html` redirects there). One library of saved links is shared by every browser of the site;
videos are downloaded where you want them, on the device you are using:

1. **Save link** stores the URL in the library at once and looks its details up in the background
   (title, author, length, thumbnail; YouTube through yt-dlp, the others through the feed's resolvers).
   Duplicates are recognised by the video's canonical form (`watch?v=ID`, `@user/video/ID`, `reel/CODE`).
   A failed lookup keeps the entry with a placeholder title that can be edited. Nothing is downloaded.
2. **Download for in-app playback** stores the video in *this* browser (IndexedDB, in 8 MB parts
   written while the download streams) and the built-in player plays it, offline too.
3. **Save to device** writes a regular file: the destination picker on desktop Chromium / Edge
   (`showSaveFilePicker`), the downloads folder or the Files app elsewhere. The car's browser cannot
   save files, so the action is not shown there. A file saved this way is not an in-app copy.

Categories (create, rename, delete, assign several per video), search, a category filter and an
"On this browser" filter organise the list. Each card says where the video stands: *Saved to library*,
*Looking up details…*, *Downloading…* (with progress), *On this browser · 720p*, *Download failed*,
*Unavailable at the source*.

**Server** (`server/src/library.ts`): the library is one JSON file (`LIBRARY_DIR/library.json`,
default `<dir of TIKTOK_PROFILE_DIR>/library`, i.e. `/var/lib/streamanywhere/library` on the VM),
written atomically, with a `rev` that grows on every change so the pages can poll cheaply
(`GET /api/library?rev=N` answers `unchanged`). Thumbnails are copied once into `LIBRARY_DIR/thumbs`
(the platforms' cover URLs expire within days) and served from `/api/library/thumb/:id`.
`GET /api/library/entries/:id/options` lists the qualities a browser can get right now: YouTube =
the downloader's options (a server job that merges picture and sound with ffmpeg, then
`/api/download/jobs/:id/file`); TikTok / Instagram / Facebook / plain files = ready MP4s the browser
fetches itself, from the cookie-free CDN URL or through the proxy (`?dl=<name>` on a relay makes it
a file download). A source that says the video is gone marks the entry *unavailable*: the link is
not a backup of the video.

**Browser** (`client/src/library/`): `db.ts` is the IndexedDB store (library mirror, video records,
blob parts); a video counts as present only when its record and all its parts are there with the
recorded size (`verifyVideos`, run on every load), so a store the browser evicted shows *Download
again*, never a stale "available". `downloads.ts` runs the tasks (progress, cancel, retry, quota
check before a download, `QuotaExceededError` cleaned up). `capabilities.ts` decides per browser
which actions are offered (Tesla: no file saving; iPhone: Files app and the share sheet; Chromium:
destination picker). `sw.js` caches the page and its built assets so the library opens offline.

**Player** (`client/src/library/player.ts`): the feed's `FeedPlayer` on a canvas, unchanged — WebCodecs
(mp4box demux → `VideoDecoder` / `AudioDecoder` → canvas 2D + Web Audio) or the hidden-`<video>`
fallback. The only addition to the pipeline is a Blob source in `Mp4Demuxer`: the stored file is read
with `Blob.slice()` where a URL would be fetched with a `Range` header (the `<video>` fallback gets an
object URL). The pipeline has no other network dependency, so local videos play with the network off.
Around it: tap to pause, a seekable bar, previous / next by button, vertical swipe, wheel or arrow
keys, mute, fullscreen, auto-advance. Qualities whose codec the browser cannot decode
(`VideoDecoder.isConfigSupported`) are greyed for in-app downloads and still offered as files.

Browser notes: Safari on iPhone may clear site data (the local videos) after 7 days without a visit
unless the app is on the Home Screen; the page asks for persistent storage where the API exists and
says in its footer what the browser granted. Removing a library entry deletes the local copies on
every browser the next time they open the library; deleting a local copy keeps the entry.

## YouTube (guest mode)

Measured 2026-10-12 (dev machine and the GCP VM; the VM's IP is not bot-checked for guests):

- **Explore** = the Shorts tab of a hashtag page (`youtube.com/hashtag/<tag>/shorts`, 30 vertical
  videos in under 3 s); the chips are hashtags and "All" rotates through them. YouTube's Trending
  page no longer exists (it redirects home).
- **Search** = `yt-dlp "ytsearchN:…"` (3–4 s a page of 20). Channels (`@handle/videos`) back the
  Profile button. Everything is guest access; YouTube sign-in / a personal feed comes later.
- **Playback**: YouTube gives guests no muxed format (the 360p one needs a PO token and answers
  403), so each video is resolved (`yt-dlp -j`, cached an hour) to an H.264 video-only file (up
  to 720p, `avc1` itags 160/133/134/135/136/298) plus an AAC audio file (itag 140, original
  language, 128 kbps). Both are fragmented MP4 and both go through the proxy: `googlevideo.com`
  URLs are bound to the server's IP and carry no CORS header. The WebCodecs renderer runs a
  second demuxer for the sound file and syncs the picture to its audio clock (`LoadSource.audioUrl`).
- **Proxy chunking**: googlevideo throttles an open-ended request to ~50 KB/s but serves a bounded
  Range at full speed (10 MB in 0.3 s), so `chunked` media records are relayed in 4 MB chunks.
- **Seeking in fragmented files**: mp4box only knows the fragments it has parsed, so a seek beyond
  the downloaded part uses the `sidx` index (`demuxer.ts`: fragment byte offset → restart the fetch
  there, point mp4box's parser at it, and let the fragment's `tfdt` set the time).
- Needs `yt-dlp` on the server (`YTDLP_PATH`, auto-detected on PATH / pip user installs; the GCP
  script installs it in a venv and upgrades it on every deploy). The server keeps `YTDLP_DAEMONS`
  (2) Python processes with `yt_dlp` imported (`server/scripts/ytdlp-daemon.py`) and sends them
  extraction requests as JSON lines: importing yt_dlp costs ~11 s of CPU on the free e2-micro
  (measured 2026-10-12), which made every CLI call 25–120 s there; warm, a listing or a resolve
  takes the extraction time only. `YTDLP_PYTHON` names the interpreter; `YTDLP_DAEMON=0` forces the
  CLI. The `<video>` fallback renderer cannot play two files and stays silent for YouTube; the
  download button saves the picture only.

### YouTube sign-in (For You)

Google refuses sign-ins from automated browsers, the TV-code flow (youtube.com/activate) hands out
OAuth tokens that YouTube stopped honouring for yt-dlp in 2024, and the VM has no display for a
Google window - so the YouTube sign-in is the way yt-dlp documents: **the cookies of a browser
that is signed in**. Profile → the panel offers:

- **Paste / choose cookies.txt**: on a computer, sign in at youtube.com in a *private window*,
  export the cookies with a cookie-export extension ("Get cookies.txt LOCALLY" for Chrome/Edge,
  "cookies.txt" for Firefox) while on youtube.com, close the private window (an open tab would
  rotate the cookies behind the server's back), then paste the text or pick the file. A JSON
  export of a cookie-editor extension and a copied `Cookie:` header are accepted too.
- **Open sign-in window on server** (a desktop running the server, not the VM): a visible
  Chrome/Edge with its own profile opens Google's sign-in; once youtube.com holds the account
  cookies they are exported to the same file and the window closes.

The server keeps only youtube.com / google.com cookies, checks them at once with YouTube's own
account menu (`youtubei/v1/account/account_menu` with the site's `SAPISIDHASH` authorisation) and
shows the account name, handle and avatar. The file (`YOUTUBE_COOKIES_FILE`) *is* the sign-in:
yt-dlp reads it for the feed and writes rotated cookies back, a saved file is re-checked at start,
and **Sign out** deletes it. **For You** lists `youtube.com/feed/recommended` (the account's home
feed; a signed-out visitor gets an empty list, which triggers the account check). Playback stays
the guest two-file path; the cookies are used for a video only when the guest extraction is
refused (age gate, private video, bot check). `/api/session/log?platform=youtube` shows the steps.

## Instagram

Same idea as the other two platforms, but Instagram **requires a sign-in**: the feed page opens the
sign-in panel instead of a feed, and the server answers every Instagram request with 401 until the
saved cookies check out. Why there is no guest mode, measured 2026-10-13 from the dev machine:

- **Every Instagram API refuses guests** (`/api/v1/...`, `web_profile_info`, tags, search, clips all
  answer 401 `require_login`, also when called from inside a real instagram.com page) and yt-dlp's
  Instagram extractors are marked broken. The Explore page, `/reels/` and hashtag pages redirect to
  the login page. What a guest *can* see: a public profile page (`/<handle>/reels/` renders its 12
  latest Reels, no paging) and the **embed page of any post** (`/p/<code>/embed/captioned/`).
- **Reels tab** is a rotation over big public accounts (Instagram has no global feed to list): each chip is a list of
  accounts (`INSTAGRAM_CATEGORIES` in `shared/types.ts`, all verified to list 8+ Reels to a guest),
  "All" alternates between the categories, and the Reels of the next few accounts are interleaved so
  the stream never shows a dozen from one account in a row.
- **Playback** is the easy part: the embed page, fetched from inside an instagram.com page (a plain
  HTTPS client gets a generic shell), carries the post's JSON with a **progressive, muxed H.264 + AAC
  MP4** (`video_url`: moov first, Range, `Access-Control-Allow-Origin: *`), caption, counts, owner and
  cover. About 0.9 s each, 8 in parallel inside one page. The viewer fetches the CDN URL itself
  (`directUrl`) and falls back to the proxy (`*.cdninstagram.com` is on the allowlist).
- **Profile pages are rate limited per IP**: about 100 profile loads in 4 minutes made every profile
  redirect to `/accounts/login` for over 30 minutes (a fresh browser profile did not help), while embed
  pages kept working. So the server keeps a **catalog** (`INSTAGRAM_CATALOG_FILE`): one listing per
  account every 6 hours, at most 40 profile loads an hour, 3 s between loads, a back-off of 10 min
  (doubling to 1 h) after a redirect, and stale listings are served rather than an error. While
  profiles are blocked, only accounts already in the catalog feed the stream. Signing in avoids the
  limit (it counts per account then). The signed-in session is used for the profile pages too. `/api/stats` shows `instagram.blockedForSec` and the catalog size.
- **Search**: the account search (`/web/search/topsearch/`) finds accounts; an `@handle` (or profile
  link) opens the account and its Reels, a pasted post/reel link plays it. **Profile** = the
  account's Reels (a signed-in account keeps paging on scroll; a guest would get 12).
- All of it runs in **one headless Chrome/Edge page** (`src/instagram.ts`, its own profile), one job at
  a time, closed after 5 idle minutes (the 1 GB VM needs the memory); no yt-dlp involved.

### Instagram sign-in

Instagram has no QR/TV-code login and challenges scripted password logins, so - like YouTube - the
sign-in is **the cookies of a browser that is signed in** (paste / choose `cookies.txt`, or a sign-in
window on the machine running the server; a `sessionid` must be among them). The server keeps only
instagram.com cookies in `INSTAGRAM_COOKIES_FILE`, next to them the **identity of the browser they came
from** (`…cookies.meta.json`: the paste request's own `User-Agent`, or the sign-in window's) - Instagram
ties a web session to the browser that made it and answers `useragent mismatch` otherwise - and its
headless browser presents that identity (with matching client hints for Chrome/Edge). Paste from the
browser you exported with, and export the whole file: a thin export (no `mid`, `ig_did`, `datr`) is
accepted with a warning.

The cookies are loaded into the headless browser and **checked at once**, in three steps, because
Instagram refuses its account API from a datacenter address (the GCP VM gets **429 at once** for
`/api/v1/accounts/current_user/`, while the dev machine gets a plain 401 for bad cookies):

1. the account API - 200 names the account; `login_required` (401/403) = bad cookies, refused (verified);
   a 429, or its throttle text ("Please wait a few minutes…", which can come with `require_login: true`
   for good cookies too) says nothing about the cookies;
2. the settings page `/accounts/edit/` - only a signed-in account stays on it (and the page names the
   account); a redirect to the login page = signed out, unless it carries Instagram's rate-limit flag
   (`is_from_rle`), a bare 429 for the page = the address is limited, `/challenge/` = the account must
   confirm "it was me" in your own browser first (403 to the client);
3. when neither could say, cookies with the **shape of a session** (`sessionid` = `<account id>:<token>…`
   agreeing with `ds_user_id`) are **kept as a provisional sign-in** (`Signed in as @user<id>`, "not yet
   confirmed"), because every tool that reads Instagram (yt-dlp, gallery-dl, instaloader) does the same:
   it trusts the sessionid and learns from a login redirect later. The first **For You** fill settles
   it: a served Reels page confirms the sign-in (and names the account), a login redirect without the
   rate-limit flag triggers one more full check and a conclusive "signed out" deletes the cookies.
   A saved sign-in Instagram will not check is tried again every 10 minutes, a few times, never faster
   (quick retries lengthen Instagram's throttle); the feed does not ask for a verdict again within
   those 10 minutes either, a refused page (429, rate-limit redirect) pauses signed-in page loads for
   10 minutes, and the feed page waits 2 minutes after a 429 instead of retrying every few seconds.
   Between tries the sign-in panel shows the reason (a checkpoint, the wrong browser identity, cookies
   that are no session) and the cookies form, so a fresh export can be pasted. Instagram also **deletes a `sessionid` it rejects**
   (verified with bad cookies): that counts as "signed out" whatever the pages said, and a login
   redirect that leaves the cookie in place while the address is limited is no verdict (provisional).

**For You** is the account's Reels page (`/reels/`): its GraphQL answers are captured while the page
is paged with the keyboard and only the post *codes* are taken from them - the playable file always
comes from the embed page. **This signed-in half could not be tried without an account**;
`/api/session/log?platform=instagram` shows what Instagram answered at each step (the first words of
each refused answer's body included) and `/api/stats` → `instagram.lastAccountCheck` the last verdict.
If the VM's address is on Instagram's datacenter list, no cookie fixes it: the pages themselves come
back 429 or go to the login page; only another egress address (a residential proxy) would. Automation
on a real account can make Instagram ask for a checkpoint: the server is deliberately slow and sparse,
but keep that in mind.

## Facebook

Built 2026-10-15. Facebook is the easy one: no browser on the server, no yt-dlp, everything is read
from facebook.com's own pages over plain HTTPS (`server/src/facebook.ts`). Measured from the dev machine:

- **A Page's Reels tab is public.** `facebook.com/<page>/reels/` answers a signed-out visitor with the
  Page's latest 10 reels inside the page's JSON (`<script type="application/json">` blobs, Facebook's
  Relay store): id, `browser_native_hd_url` (720p progressive H.264 + AAC) and `browser_native_sd_url`,
  size, length, cover, caption, creation time, a rounded play count ("230K"), the comment count, the
  owner's name / link / picture and the audio title. The HTML is big (2 MB compressed, 16 MB
  decompressed - it embeds the reels' DASH manifests), so one listing is kept per Page for 4 hours
  (`FACEBOOK_CATALOG_FILE`) and re-listed in the background while someone watches. Paging past the 10
  would need a GraphQL doc id, so the **Reels** tab is a rotation over many public Pages
  (`FACEBOOK_CATEGORIES` in `shared/types.ts`, each verified to list 10 reels to a guest), interleaved
  so the stream never shows ten from one Page in a row.
- **A single reel is public too**: `facebook.com/reel/<id>` carries the same records (plus the next
  few reels of the viewer), so a pasted link resolves without a sign-in. `watch/?v=`, `/<page>/videos/…/<id>`,
  `fb.watch` and share links are followed to the reel.
- **Playback**: the CDN (`*.fbcdn.net`) sends `Access-Control-Allow-Origin: *` and honours Range, so the
  viewer fetches the MP4 itself; the proxy is the fallback. URLs expire (`oe=`, about a day); a reel is
  not served within 30 minutes of that and its Page is re-listed.
- **The Reels feed needs a sign-in**: `/reel/` and `/reels/` send a guest to the login page, as does
  search. **For You** loads `facebook.com/reel/` with the saved cookies and takes the reels embedded in
  it (every load is a fresh sample; the stock's recent-id window drops repeats). **Search** is a Page
  name (@page / link) that opens the Page, or a reel link that plays.
- Not known yet: whether Facebook serves these pages to a datacenter address (the GCP VM). A guest
  request that is sent to the login page is retried with the saved sign-in when there is one, and
  guest Page loads pause for 10 minutes (doubling) after such a refusal. Rate limits were not
  measured; Page loads are paced 2 s apart, 60 an hour.

### Facebook sign-in (For You)

Like YouTube and Instagram: **the cookies of a browser that is signed in** (paste / choose
`cookies.txt`, or a sign-in window on the machine running the server); `c_user` and `xs` must be among
them. The server keeps only facebook.com cookies in `FACEBOOK_COOKIES_FILE` (the paste's User-Agent next
to it) and checks them at once with the settings page, which only a signed-in account gets (a guest is
sent to `login.php`, verified; a `/checkpoint/` redirect means the account must confirm itself in your
own browser first). Every page Facebook renders names the signed-in viewer (`CurrentUserInitialData`),
so the first signed-in page the feed reads confirms the account, and a signed-in request that lands on
the login page triggers a re-check; a conclusive "signed out" deletes the file. The signed-in half
could not be tried without an account; `/api/session/log?platform=facebook` shows each step.

## Diagnostics without a shell

- **`/api/log`** (site password): the last 800 server log lines as text, newest last; `?n=100`,
  `?level=warn` for problems only. The feed page reports its own failures there too (feed batch,
  resolve, player and page errors, tagged `client=true` with the platform, video id, page and
  device), so a problem on the Tesla or a phone can be read afterwards from any browser.
- **`/api/health`** (public): build facts, yt-dlp and daemon status, uptime. **`/api/stats`**: feed
  stock per category, media records, the headless work page.
- **`/api/session/log`**: the last TikTok sign-in steps; `?platform=youtube` / `?platform=instagram` for those.

## Using the app

1. **Prove the pipeline without TikTok first**: Source = *Test MP4*, Renderer = *Mode B*, Load.
   The stats panel shows the measured resolution, codec string, audio path, FPS, dropped frames,
   decoder queue, buffered seconds, bytes downloaded and the browser-side CORS result.
   *Local file* plays any MP4 from disk through the same pipeline (blob URL, same-origin).
2. Paste a TikTok URL (default is a public video from the official @tiktok account), Source = *Auto*.
   The client resolves it, runs a real `fetch()` with a Range header against each cookie-free
   candidate URL, and only falls back to the proxy if every direct candidate fails. The
   *Connection* stat tells you which path is in use; the server logs it too (`client played media via direct|proxy`).
3. *Direct CDN only* / *Proxy only* force one path. *Format* lets you pick TikTok's H.264 or
   H.265 variants.
4. Mode A uses a hidden `<video>` + `requestVideoFrameCallback` as a baseline; Mode C shows
   TikTok's official embedded player for comparison (no media bytes reach the page).
5. **Run all experiments** executes the six tests from the brief and prints measured results with
   an explanation of why each path succeeds or fails. *Copy results JSON* exports them.

## How the pieces work

**Demuxing** – `Mp4Demuxer` streams the response body into `mp4box.js` (`ISOFile.appendBuffer`
with `fileStart` offsets). When `moov` is parsed it builds decoder configs from the sample entry
boxes (`avcC`/`hvcC` payload → `description`, `esds` DecoderSpecificInfo → AAC `description`),
sets extraction options and receives samples in `onSamples`. If mp4box asks for a later file
position (moov after mdat) the fetch restarts there with a `Range` header. Seeking calls
`ISOFile.seek(t, useRap=true)`, aborts the fetch and restarts at the returned offset; mp4box
re-emits samples from the previous random-access point, pre-roll frames are decoded and
discarded until the target. Reading pauses when more than ~600 video samples are queued.

**Decoding** – `EncodedVideoChunk`s are built from each sample (`cts` → µs, minus the edit-list
offset, `is_sync` → key). The decoder is kept ~12 frames ahead with at most 8 chunks in flight.
Audio chunks are decoded ~2.5 s ahead of the playhead and each `AudioData` is scheduled as an
`AudioBufferSourceNode` at its exact timestamp.

**Scheduling** – the `AudioContext` is the master clock (its `currentTime` freezes on
`suspend()`, so pause/resume are exact). On every animation frame the newest decoded frame whose
timestamp ≤ clock is painted; skipped frames count as *dropped*. With no decodable audio a
`performance.now()` wall clock is used. If the AudioContext cannot resume (autoplay policy) the
video runs on the wall clock and the audio clock takes over on the next Play press. If the decoder
starves, the clock pauses (*buffering*) and resumes when 3 frames are ready. A 100 ms timer keeps
the scheduler alive in occluded tabs where `requestAnimationFrame` stops.

**Resolver** – `POST /api/resolve` with a TikTok URL fetches the public video page, reads the
`__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON and returns, per bitrate variant: the cookie-free
redirect URL, the final CDN URL (resolved server-side), a server-side CORS probe of it, and a
proxy id. Short links (`vm.tiktok.com/…`, `/t/…`) are followed first. Private, deleted,
age-gated or photo posts are reported as errors; nothing bypasses access controls. Plain MP4 URLs
pass through with a probe and (if the host is allowlisted) a proxy id.

**Proxy** – `GET|HEAD /api/media/:id` streams the upstream response, forwards the client's
`Range` header and `Content-Type/Length/Range`, `Accept-Ranges`, adds the `Referer` and session
cookies TikTok's primary CDN requires, exposes the headers through CORS and logs every relayed
request with byte counts. Upstreams must be `https`, on the allowlist, and resolve to public IPs;
redirects are re-validated hop by hop. Media ids are random and expire with the upstream URL.

## Test results (2026-10-08)

Measured in the app's experiments panel and the server test-suite. Browser: Chromium 152 (Claude
desktop app pane), Windows 10. Server: Node 16.17.0.

| Test | Result | Measured detail |
|---|---|---|
| Direct MP4 in HTML5 `<video>` | PASS | rabbit320.mp4 loaded with `crossorigin="anonymous"` in 57 ms, 320×240, 7.8 s |
| Direct MP4 drawn into Canvas | PASS | drawImage OK, `getImageData` allowed (untainted) |
| Direct MP4 decoded with WebCodecs | PASS | 834,563 bytes streamed, `avc1.42e00d`, first frame after 67 ms, AAC supported |
| TikTok resolved URL with fetch() | PASS (as expected) | cookie-bound `v16-webapp-prime.us.tiktok.com`: **blocked** – Chrome console: *“Access-Control-Allow-Origin header has a value 'https://www.tiktok.com' that is not equal to the supplied origin”*; `/aweme/v1/play` redirect: HTTP 206 (redirected); resolved `v16m-default.tiktokcdn-us.com`: HTTP 206 in 24 ms |
| TikTok via media proxy | PASS | HTTP 206, `content-range: bytes 0-15/6019431`, upstream `v16-webapp-prime.us.tiktok.com` with cookies |
| TikTok official iframe | PASS | `player/v1` loaded in ~1 s; opaque, no media access |

Full playback of the TikTok video (`avc1.64001f` 720×1280, 68.7 s, 6.0 MB, HE-AAC v2
`mp4a.40.29`) through Mode B **directly from the CDN**: moov parsed, 1,648 video samples, all
frames decoded, audio scheduled with 0 drops, seek to 40 s restarted the download at the 33.42 s
keyframe with a `206` Range response, pause froze the clock, and playback reached *ended*. The
same video also played through the proxy and through Mode A (`<video>` with
`crossorigin="anonymous"`, canvas untainted, 0 dropped frames reported by
`getVideoPlaybackQuality`).

**Caveat on FPS numbers**: the automated test environment kept the browser pane occluded, so
Chromium throttled `requestAnimationFrame` to 0/s and the renderer fell back to its 100 ms timer
(≈10 fps painted, remaining frames counted as dropped). Decoding ran at full speed. Smoothness in a
visible window has **not** been measured by me; open the app and read the FPS/dropped counters
yourself.

## Browser compatibility notes

- **Chrome / Chromium / Edge 94+**: full Mode B (VideoDecoder + AudioDecoder) and
  `requestVideoFrameCallback`. H.264 + AAC work everywhere. HEVC via WebCodecs depends on the OS
  hardware decoder (`isConfigSupported` returned `false` in the test build; the app reports this
  and stops instead of guessing). AV1 reported supported.
- **Safari 16.4+**: `VideoDecoder` yes, `AudioDecoder` only in recent versions; untested here.
- **Firefox 130+**: WebCodecs video decode shipped on desktop; untested here.
- WebCodecs needs a secure context (`https:` or `localhost`). Without it the app shows an explicit
  message and switches to Mode A.
- `fetch()` can read `Content-Length` on CORS responses but not `Content-Range`/`Accept-Ranges`
  unless the server exposes them (TikTok's CDN does not); the demuxer therefore relies on the
  `206` status and its own offsets.

## What was *not* done / assumptions

- Only public videos. Private, login-gated, region-locked or DRM content is reported, not bypassed.
  The For You feed shows what TikTok serves to *your* signed-in browser session, nothing more.
- The signed-in For You path was not exercised with a real account in this session (signing in
  is yours to do); the capture mechanism was verified with TikTok's guest feed.
- Rendering uses Canvas 2D (`drawImage(VideoFrame)`); a WebGL/WebGPU path is a next step.
- No adaptive bitrate switching; the format is chosen manually.
- The server-resolved CDN URL was fetched by a browser on the same machine/IP as the server. If
  TikTok's `/aweme/v1/play` hashes are IP-bound, a remote browser should use the redirect URL
  itself (the client already tries it as the second candidate) – *Auto* mode handles this.
- URL lifetime: `expire=` on primary URLs ≈ 48 h; the hex path segment on `tiktokcdn-us.com` URLs
  ≈ 60 h. Re-resolve when expired (the proxy returns 404 for expired ids).
- Node 16 was the installed runtime, so Vite 4 / Fastify 4 / tsx 3 are pinned; mp4box 2.4.1's
  `engines` field targets Node 20 but only its browser bundle is used.

## Recommended next steps

1. Verify smoothness in a visible window on several machines; add a frame-timing histogram.
2. WebGL/WebGPU renderer (`texImage2D(VideoFrame)` / `importExternalTexture`) and a worker-based
   decode path (`OffscreenCanvas` + `VideoDecoder` in a Worker) to keep the main thread free.
3. HEVC/AV1 policy: query `isConfigSupported` for all variants at resolve time and pick the best
   supported one automatically; add software-decoder fallback notes.
4. Audio: use an `AudioWorklet` ring buffer instead of per-chunk `AudioBufferSourceNode`s for
   gapless playback on long files; add A/V drift measurement.
5. Fragmented MP4 / DASH segments (mp4box already parses `moof`) and HLS (`.m3u8` → TS/fMP4).
6. Harden the resolver: TikTok changes markup; keep yt-dlp as the canary and add a scheduled
   check. Track the `/aweme/v1/play` behaviour (it is the single point that makes direct playback possible).
7. Production: rate-limit `/api/resolve` and `/api/media`, persist media ids (Redis) and cap proxy
   bandwidth per client.
