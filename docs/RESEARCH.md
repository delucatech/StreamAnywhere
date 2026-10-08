# TikTok media access research (measured 2026-10-08)

All statements below come from the probes in `research/` (Python, run from a Windows machine
with a residential US IP) and from the browser experiments in the app. Re-run them; TikTok
changes behaviour without notice.

Test video: `https://www.tiktok.com/@tiktok/video/7693184538704416031` (public, official
@tiktok account, 68 s, 720×1280).

## 1. Where the media URLs come from

`GET https://www.tiktok.com/@tiktok/video/<id>` with a desktop Chrome User-Agent returns HTTP 200
and:

- `Set-Cookie`: `tt_chain_token`, `tt_csrf_token`, `ttwid` (fresh values per request).
- `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">` (older pages used
  `__UNIVERSAL_DATA_FOR_REBOOTING__`; yt-dlp matches both). Path:
  `__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct.video`.

Relevant fields:

| Field | Observed |
|---|---|
| `format` / `codecType` / `width×height` / `duration` | `mp4` / `h264` / 720×1280 / 68 |
| `playAddr`, `downloadAddr` | `https://v16-webapp-prime.us.tiktok.com/video/tos/…?…&expire=…&signature=…&tk=tt_chain_token` |
| `bitrateInfo[]` | 4 variants: `normal_720_0` (h264, 701 kbps), `adapt_lowest_1080_1`, `adapt_lower_720_1`, `adapt_540_1` (all `h265_hvc1`) |
| `bitrateInfo[i].PlayAddr.UrlList` | `[v16-webapp-prime…, v19-webapp-prime…, https://www.tiktok.com/aweme/v1/play/?…&tk=tt_chain_token&video_id=…]` |

The `statusCode` next to `itemInfo` is 0 for public videos; non-zero values (10204 not found,
10216/10222 private, 10239 login/age) are surfaced as errors by the resolver.

## 2. Primary CDN URLs (`v16/v19-webapp-prime.<region>.tiktok.com`)

Probe `research/tiktok_probe_cdn_access.py` and `tiktok_probe_cookie_binding.py`:

| Request | Status | Notes |
|---|---|---|
| no cookies, no Referer | **403** (519-byte HTML) | `Access-Control-Allow-Origin: https://www.tiktok.com`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Headers: range` |
| no cookies + `Referer: https://www.tiktok.com/` | 403 | |
| page cookies, no Referer | 403 | |
| only `Cookie: tt_chain_token=…` (no jar), no Referer | 403 | |
| page cookies + Referer | **200**, 6,019,431 bytes `video/mp4`, `Accept-Ranges: bytes` | |
| page cookies + Referer + `Range: bytes=0-1023` | **206** `Content-Range: bytes 0-1023/6019431` | Range works |
| cookies from a *different* page session + Referer | 403 | the `signature` is bound to the session's `tt_chain_token` (`tk=tt_chain_token` in the query) |
| `HEAD` with cookies + Referer | 403 | HEAD is refused; the proxy emulates HEAD with a 1-byte ranged GET |
| `OPTIONS` preflight | 403 | |

Expiry: `expire=<epoch>` ≈ 48 h after resolution. Two resolutions of the same video differ only
in `ft`, `expire`, `l` (log id) and `signature`.

**Consequence for browsers:** even if a browser had a valid `tt_chain_token` cookie for
`.tiktok.com`, `fetch()` from another origin fails the CORS check because the ACAO value is the
fixed string `https://www.tiktok.com`. Chrome's console message, captured in the app:

> Access to fetch at 'https://v16-webapp-prime.us.tiktok.com/…' from origin 'http://localhost:5173'
> has been blocked by CORS policy: The 'Access-Control-Allow-Origin' header has a value
> 'https://www.tiktok.com' that is not equal to the supplied origin.

A `<video src>` (no-cors) load would additionally need the cookie that is bound to the resolver's
session, which the browser does not have. These URLs are therefore **proxy-only**.

## 3. The cookie-free path: `https://www.tiktok.com/aweme/v1/play/?…`

Probe `research/tiktok_probe_redirect_url.py`:

| Request | Status | Headers |
|---|---|---|
| GET, no cookies, `Origin: http://localhost:5173` | **302** → `https://v16m-default.tiktokcdn-us.com/<32-hex>/<8-hex>/video/tos/…` | `Access-Control-Allow-Origin: http://localhost:5173` (echoed), `Access-Control-Allow-Credentials: true`, no `Set-Cookie` |
| OPTIONS preflight (`Access-Control-Request-Method: GET`) | **200** | ACAO echoed, `Access-Control-Allow-Methods: GET` |
| OPTIONS with `Access-Control-Request-Headers: range` | 200 | `Access-Control-Allow-Headers: range` |

Final CDN URL (`v16m-default.tiktokcdn-us.com`):

| Request | Status | Headers |
|---|---|---|
| no headers at all | 200, 6,019,431 bytes | `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes`, `Cache-Control: max-age=15295729` |
| `Origin` + `Range: bytes=0-1023` | **206** | ACAO `*`, `Content-Range` |
| different User-Agent (`curl/8.0`) | 200 | not UA-bound |
| `Referer: http://localhost:5173/` | 200 | not Referer-bound |
| `HEAD` | connection error | use ranged GET instead |

The second path segment is a hex epoch (`0x6ac7ec70` → ~60 h validity).

**Browser confirmation** (app experiments, Chromium 152): `fetch(redirectUrl, {mode:'cors',
credentials:'omit', headers:{Range:'bytes=0-15'}})` → HTTP 206, `response.redirected = true`,
first bytes `00 00 00 20 66 74 79 70 69 73 6f 6d` (`ftypisom`). Fetching the resolved CDN URL
directly → HTTP 206 in 24 ms. `Content-Range` is **not** readable from JavaScript (not in
`Access-Control-Expose-Headers`), `Content-Length` is (safelisted).

Every bitrate variant, including the H.265 ones, carries an `/aweme/v1/play` URL.

Unknowns worth monitoring:

- Whether the final CDN hash is bound to the client IP. The browser and the server shared an IP in
  these tests, so the app tries the server-resolved CDN URL first and the redirect URL (resolved
  by the browser itself) second.
- Whether TikTok rate-limits or disables `/aweme/v1/play` for non-browser traffic patterns.

## 4. yt-dlp (2026.08.19) view of the same video

`yt-dlp -j` returns 10 formats: `download` (h264), `h264_720p_701105-{0,1}`,
`bytevc1_{540,720,1080}p_*-{0,1}` (h265), plus an `mp3` audio-only entry. Every video URL is a
`v16/v19-webapp-prime` cookie-bound URL; `http_headers` carries the page `Referer` and the
`cookies` field carries `ttwid`/`tt_chain_token`. yt-dlp does **not** expose the
`/aweme/v1/play` URL, so it is used only as a fallback resolver (proxy-only URLs). yt-dlp warns
that it would like `curl_cffi` impersonation; the plain run still succeeded.

## 5. Container / codec facts (from mp4box in the browser)

- Brands `isom,iso2,avc1,mp41`, `moov` first (progressive), not fragmented.
- H.264 variant: `avc1.64001f` (High, level 3.1) 720×1280, 1,648 samples, `avcC` 48 bytes; video
  edit list offset 1024/12288 (CTS delay), which the renderer subtracts so audio and video share a
  timeline.
- Audio: `mp4a.40.29` (HE-AAC v2) 44.1 kHz stereo, 4-byte AudioSpecificConfig; Chromium's
  `AudioDecoder` supports it.
- H.265 variants: `hvc1.1.6.L186` (540p) etc. `VideoDecoder.isConfigSupported` returned `false`
  in the test build (no HEVC hardware path), so the app reports the error and stops.

## 6. Public test MP4 hosts (CORS verified with `curl -H Origin`)

| URL | ACAO | Range |
|---|---|---|
| `mdn.github.io/learning-area/…/rabbit320.mp4` | `*` | yes |
| `mdn.github.io/dom-examples/picture-in-picture/assets/bigbuckbunny.mp4` | `*` | yes |
| `interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4`, `friday.mp4` | `*` | yes |
| `commondatastorage.googleapis.com/gtv-videos-bucket/…` | `*` but **403** (bucket no longer public) | – |
| `test-videos.co.uk`, `media.w3.org`, `archive.org` (final host) | none | – |
