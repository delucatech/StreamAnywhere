# Mirror – an iPhone's screen on the Tesla (or any browser)

Mirror is a separate app from the feed player: an iOS app whose **broadcast extension** captures
the phone's whole screen (ReplayKit) and sends it, with the app's sound, to a page in the Tesla's
browser. Nothing is installed in the car: the viewer is `mirror.html` on the StreamAnywhere server,
or the page the phone serves itself.

```
 iPhone (Mirror app + broadcast extension)                       Tesla / laptop browser
 ┌──────────────────────────────────────┐                        ┌─────────────────────────┐
 │ ReplayKit screen ─► VideoToolbox H.264│ ── 1. local  ────────►│ mirror page             │
 │ ReplayKit app audio ─► AAC-LC         │ ── 2. direct (WebRTC)►│  WebCodecs → canvas     │
 │ (silence when the app is quiet)       │ ── 3. relay (server) ►│  or MSE → <video>       │
 └──────────────────────────────────────┘                        └─────────────────────────┘
```

## The three ways the picture reaches the car

| Path | When | Quality and delay | Cost |
|---|---|---|---|
| **1. Local direct** | The Tesla is on the iPhone's hotspot (or both on one Wi-Fi). The car opens `http://172.20.10.1:8420/`, a page the phone serves itself; the frames go over a WebSocket on port 8421. | Best: a few frames of delay, no mobile data used for the picture, no internet needed at all. | Free |
| **2. Internet direct** | Both have internet and the networks allow it: a WebRTC data channel from the phone to the car, introduced through the server (STUN only). | Good. | Free |
| **3. Relay** | The car on its own LTE, the phone on mobile data, the networks blocking a direct link (common): the phone pushes to the StreamAnywhere server, the car reads from it. | Good, slightly more delay. | The server's bandwidth, about 1–2 GB per hour at 3 Mb/s |

The viewer opened from the server connects to the relay first (the picture shows at once) and tries
the direct link in the background; when the direct link delivers, it tells the server to stop
copying frames to it, and the phone stops pushing to the relay when nobody needs it (so path 2 costs
the phone one copy of the stream, not two). If the direct link drops, the relay resumes with a fresh
keyframe. The page served by the phone uses path 1 only.

## The pieces

| Where | What |
|---|---|
| `shared/mirror.ts` | The wire protocol **mirror/1** (binary CONFIG / VIDEO / AUDIO / CHUNK messages, JSON control messages) and the codec helpers; `ios/Shared/MirrorProtocol.swift` is its Swift twin |
| `server/src/mirror.ts` | The relay and signalling: `/api/mirror/ws?room=CODE&role=sender\|watcher` (WebSocket, behind the site password), `POST /api/mirror/rooms`, `GET /api/mirror/rooms/:code`, `GET /api/mirror/ice`. Keeps the frames since the last keyframe so a late joiner starts at once; asks the sender for a keyframe when a watcher joins or falls behind; drops frames for a watcher whose link is slow instead of letting it fall further behind |
| `client/mirror.html` (+ `src/mirror/`) | The viewer: type the six-letter code (or open `mirror.html?room=CODE`). `watch.ts` runs the relay + direct links, `sinks.ts` decodes with WebCodecs (https) or Media Source Extensions (`fmp4.ts` packs the frames into fragmented MP4; used on plain http and where WebCodecs is missing) |
| `client/mirror-local.html` | The same viewer, built into **one file** for the phone to serve: `npm run build:mirror-local -w client` writes `ios/Shared/Resources/viewer.html` (committed, so the Mac build needs no Node) |
| `client/mirror-send.html` | A **desktop sender**: this computer's screen, a camera or a test pattern to a room, speaking the same protocol (WebCodecs encoders). Both a feature and the test bench: the whole chain was verified with it in the browser |
| `server/src/tests/mirror.ts` | 26 offline checks of the relay (`npx tsx src/tests/mirror.ts` in `server/`, also part of `npm test`) |
| `ios/` | The iPhone app (below) |

Messages: a `CONFIG` carries the decoder configurations (H.264 `avcC`, AAC `AudioSpecificConfig`),
the picture size, its rotation and the sender's name; `VIDEO` is one H.264 access unit in AVCC form
with a keyframe flag and a timestamp (f64 microseconds); `AUDIO` is one raw AAC-LC frame. A declared
track must keep flowing (the MSE viewer waits for both), so the phone sends silence when the app is
quiet. The same bytes go over all three links; data channels get them in 60 KB `CHUNK`s.

## The phone app: two versions

The **.NET MAUI app** in [`../mobileapp/`](../mobileapp/README.md) is the one that lives with the rest
of the mobile app (Visual Studio): its broadcast extension in C# does the hotspot path and the relay
path, and it compiles for iOS on Windows (checked 2026-10-21; deploying still needs a Mac).

The **Swift version** below (`ios/`) is the same design in Xcode, plus the WebRTC direct link (Google's
WebRTC package; no .NET binding fits the extension's 50 MB limit). Both speak the same protocol to the
same viewer; keep whichever you build with.

## The Swift app (`ios/`)

A **Broadcast Upload Extension** is the only way iOS lets an app capture the whole screen (other apps
included); it runs as its own process and must be built by Xcode.

| File | Role |
|---|---|
| `Mirror/` | The app: server address + site password (the cookie is kept in the App Group, so the extension has it), the room code to type in the car (and a QR code with the link, and the hotspot address), quality, the system's **Start mirroring** button (`RPSystemBroadcastPickerView`), the live status |
| `MirrorBroadcast/SampleHandler.swift` | The extension iOS feeds the screen's frames and the app's sound to |
| `Shared/Broadcaster.swift` | Frames in, three links out: caps the frame rate, encodes, publishes the CONFIG, honours keyframe requests and the relay's "no frames needed" |
| `Shared/H264Encoder.swift` | VideoToolbox: scales (VTPixelTransferSession) and encodes (High profile, no B-frames, 2 s keyframes); SPS/PPS → `avcC` |
| `Shared/AACEncoder.swift` | AudioToolbox AAC-LC 44.1 kHz stereo from whatever PCM layout ReplayKit delivers; the sample-counted timeline is kept on the real clock with silence |
| `Shared/RelayClient.swift` | `URLSessionWebSocketTask` to the server (reconnects; skips frames while its backlog is large) |
| `Shared/LocalServer.swift` | Network.framework: the viewer page on 8420 (plain HTTP, one file), the WebSocket on 8421 (`NWProtocolWebSocket`) |
| `Shared/DirectLinks.swift` | One WebRTC data channel per watcher that offers one (Google's WebRTC via the `stasel/WebRTC` package; compiles without it, then no direct links) |
| `Shared/MirrorSettings.swift` | Settings and the status file in the App Group `group.com.delucatech.mirror` |
| `project.yml` | [XcodeGen](https://github.com/yonaskolb/XcodeGen) definition of the two targets; the `.xcodeproj` is generated |

### Building (needs a Mac)

iOS apps are built on a Mac with Xcode; the Windows PC cannot do it (that holds for the MAUI app's
iOS build too, which needs a paired Mac). Steps:

1. `brew install xcodegen`, then in `mirror/ios`: `xcodegen generate` and `open Mirror.xcodeproj`.
2. In Xcode's Signing & Capabilities pick your team for **both** targets (or set `DEVELOPMENT_TEAM`
   in `project.yml`). The bundle ids `com.delucatech.mirror` / `.broadcast` and the App Group
   `group.com.delucatech.mirror` must exist on your developer account (Xcode creates them with
   automatic signing). To change them, edit `project.yml`, `MirrorSettings.swift` (two constants) and
   the two `.entitlements` files.
3. Run the **Mirror** scheme on a real iPhone (the simulator has no ReplayKit broadcast).
4. On the phone: enter the server address and the site password, Sign in, then **Start mirroring** →
   choose Mirror → Start Broadcast. The red indicator shows while it runs; open any app.
5. In the car: StreamAnywhere → **Mirror** → type the code. On the hotspot, open
   `http://172.20.10.1:8420/` instead.

### What is verified and what is not

- Verified (2026-10-21, in a browser on the PC): the relay, the direct link's signalling and data
  channel, the viewer's WebCodecs and MSE decoders, audio, the sender's backlog handling, the
  relay-pause logic, all with the desktop sender; the 26 relay checks.
- **Not yet run on a phone** (no Mac here): the Swift code. It is written against documented APIs and
  reviewed, but expect a round of fixes in Xcode. The known soft spots: the orientation mapping in
  `Broadcaster.rotation(of:)` (if landscape comes out turned the wrong way, swap 90 and 270 there),
  the extension's 50 MB memory limit with the WebRTC package loaded (turn off "Try the direct link"
  in the app if the broadcast ends with a memory error), and whether the Tesla's browser accepts the
  plain-http hotspot page (it should; the server page is the fallback).
- The Tesla's browser: WebCodecs in Chromium needs https (the server page has it); the hotspot page
  plays through MSE. Both were exercised in Chromium here, not in the car yet.

## Pairing (the phone never types the password)

The relay is behind the site password. `mirror.html`, already signed in on the car, asks
`POST /api/mirror/pair` for a one-time token tied to its room and shows it as a QR code
(`https://server/pair#TOKEN`, refreshed every four minutes), then waits in the room. The phone scans
it (the StreamAnywhere app's **Pair with the Tesla**, or the Camera app, which opens the public
landing page `/pair` and hands the token to the app through `streamanywhere://pair?…`) and claims it at
`POST /api/mirror/pair/claim` (public; one claim per token, five minutes), which sets the same
`sa_auth` cookie a password would have and names the room; the car's page gets a `paired` control.
The room is remembered on both sides (`localStorage` on the car, the App Group on the phone), so after
the first scan the phone just starts and the page switches to the picture by itself, and back to the
code when the stream stops. The Swift app in `ios/` still signs in with the password (it predates
pairing); `server/src/tests/mirror.ts` covers the pairing calls.

## Server settings

`MIRROR_STUN_URLS` (default: Google's public STUN) and, optionally, `MIRROR_TURN_URLS` /
`MIRROR_TURN_USERNAME` / `MIRROR_TURN_PASSWORD` for a TURN server, which would make the "direct"
link succeed through a relay of its own; the StreamAnywhere relay needs nothing. The relay runs in
the existing Node server behind Caddy (WebSockets pass through `reverse_proxy` as they are).
