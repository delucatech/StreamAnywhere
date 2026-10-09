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
  feed.html + src/feed/feed.ts    the feed page: snap-scrolling stream, tap-to-pause, auto-scroll, download
server/   Fastify 4 + TypeScript (Node 16 compatible)
  src/tiktok.ts                   native TikTok resolver (page JSON) + server-side CORS probe
  src/feed.ts                     Explore feed (unsigned TikTok API) + itemStruct → FeedItem conversion
  src/session.ts                  TikTok sign-in through a real Chrome/Edge (puppeteer-core) + For You capture
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
password off. The cookie goes to the same origin only, so a client on another origin (GitHub
Pages, `?api=`) cannot use a password-protected server. The IIS handler has no password.

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

Open **`/feed.html`** (linked from the lab page). It is a full-window vertical stream like the app:

- One video per screen, scroll-snap. The video that fills the viewport plays; the others pause.
  Mouse wheel, touch, ↑/↓, J/K, PageUp/PageDown move between videos.
- **Tap/click the video to pause and resume** (Space does the same). **M** mutes, **D** downloads.
- **Fullscreen** (⛶ / **F**) and **Full window** (hides the top bar; **W** or Esc brings it back).
- **Auto-scroll** (checkbox / **A**): when on, a finished video advances to the next one; when off,
  videos loop.
- **⬇ Download** fetches the cookie-free CDN URL as a blob (progress on the button) and saves it as
  `@author_<id>.mp4`; if the direct fetch fails it goes through the server proxy.
- Sources: **Explore** (TikTok's public explore feed, with the same categories as tiktok.com/explore;
  no sign-in; works with both the Node server and the IIS handler) and **For You** (your own feed
  after signing in; Node server only).
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
