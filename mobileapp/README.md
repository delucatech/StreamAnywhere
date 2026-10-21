# StreamAnywhere mobile app (.NET MAUI)

The phone app. Its first feature is **Mirror**: the iPhone's screen (any app, with its sound) on the
Tesla's browser. Open `StreamAnywhere.slnx` in Visual Studio.

```
StreamAnywhere/                 the MAUI app (iOS, Android, Windows, Mac Catalyst); dark theme only (App.xaml.cs + Resources/Styles/Colors.xaml)
  Mirror/MirrorPage.xaml        the home page: what is going on, Start mirroring, Pair with the Tesla, settings folded away
  Mirror/PairLink.cs            the pairing link in the car's QR code (https://server/pair#TOKEN, or streamanywhere://pair?…)
  Mirror/IMirrorPlatform.cs     what the page needs from the platform (+ the stub for non-iOS platforms)
  Mirror/BroadcastPickerView.cs the start button (iOS: the system's RPSystemBroadcastPickerView)
  Platforms/iOS/MirrorPlatform.cs, QrScannerController.cs (the camera), BroadcastPickerHandler.cs, Entitlements.plist (the App Group)
  Platforms/iOS/Info.plist      the camera permission text and the streamanywhere:// URL scheme
StreamAnywhere.Broadcast/       the iOS Broadcast Upload Extension (.NET for iOS, no MAUI): the mirroring itself
  SampleHandler.cs              ReplayKit's entry point (Info.plist: NSExtensionPrincipalClass)
  Broadcaster.cs                frames in, links out; keyframe requests; the relay's "no frames needed"
  H264Encoder.cs                VideoToolbox: scaled, High profile, no B-frames, 2 s keyframes
  AacEncoder.cs                 AudioToolbox AAC-LC 44.1 kHz stereo; silence keeps the track going
  RelayClient.cs                ClientWebSocket to the server's /api/mirror/ws (reconnects, skips when behind)
  LocalServer.cs                Network.framework: the viewer page on 8420, the WebSocket on 8421 (the hotspot)
  Shared/                       compiled here and linked into the app: the protocol, the App Group settings
                                and status file, the server calls (sign-in, rooms)
```

## How it works

iOS lets an app capture the whole screen only through a **Broadcast Upload Extension**: a separate
process iOS starts when the user picks the app in the broadcast sheet (the app's **Start mirroring**
button, or Control Center's screen-recording button). The extension gets the frames and the app's
sound, encodes them (H.264 / AAC) and sends them two ways at once, in the wire protocol of
`shared/mirror.ts` (**mirror/1**):

| Path | When | What the car opens |
|---|---|---|
| Local direct | The Tesla is on the iPhone's hotspot (or both on one Wi-Fi) | `http://172.20.10.1:8420/` – a page the phone serves itself; no internet, no data |
| Relay | Anywhere else | StreamAnywhere → Mirror: the page shows a QR code and waits; the picture appears when the phone starts |

### Pairing (no password on the phone)

The relay sits behind the site password, so the phone needs the login cookie. Rather than typing the
password into the app, the car vouches for the phone: the Tesla's Mirror page (already signed in) asks
the server for a **one-time pairing code** tied to its room and shows it as a QR code
(`https://server/pair#TOKEN`, refreshed every four minutes). On the phone, **Pair with the Tesla**
opens the camera; the scanned token goes to `POST /api/mirror/pair/claim` (public: the token is the
credential), which answers with the same `sa_auth` cookie a password would have given and the room
the car is waiting in. The car's page is told ("paired"), and the extension connects to the relay like
any signed-in client. The room is remembered on both sides, so the next day it is just **Start
mirroring** on the phone and the picture shows on the car; scan again only to pair another phone or
after "Show a new code".

Scanning with iOS's Camera app works too: it opens the landing page `/pair` on the server (public),
which hands the token to the app through the `streamanywhere://pair?server=…&token=…` URL scheme
(Info.plist `CFBundleURLTypes`; `MauiProgram.cs` routes the open to `PairLink`). The password sign-in
is still there under Settings for a server with no page to scan.

The viewer page, the relay and the protocol live in the web platform (see
[../mirror/README.md](../mirror/README.md), which also holds a Swift version of this app with a third
path, a WebRTC direct link; there is no .NET WebRTC binding small enough for the extension's 50 MB
limit, so the MAUI version has the two paths above).

The app and the extension are separate processes: they share the App Group
`group.com.delucatech.streamanywhere` (settings and the server's login cookie go in, a status file
comes out once a second).

## Building

- `global.json` pins the .NET SDK to the 10.0.1xx band (currently 10.0.113), the same pin as FitnessPro:
  that band's iOS workload (.NET for iOS 26.5) is the one the paired Mac's Xcode 26.6 accepts. Without
  the pin Visual Studio picks another installed SDK and its iOS workload (26.0 wants Xcode 26.0, the
  .NET 11 RC wants Xcode 27), and launching on the iPhone fails with "This version of .NET for iOS
  requires Xcode ..." (seen 2026-10-21).
- **Windows** builds the Windows target (`dotnet build -f net10.0-windows10.0.19041.0`), which shows the
  page with a "this is an iPhone feature" note, and compiles all the iOS C# with
  `dotnet build StreamAnywhere/StreamAnywhere.csproj -f net10.0-ios -r iossimulator-arm64` after a
  `dotnet restore StreamAnywhere.slnx` (checked 2026-10-21: the extension and the app's iOS files compile
  against the iOS bindings). Name the RID as Visual Studio does: the extension restores for all three iOS
  RIDs and builds for the one it is given, and the `.csproj.user` Visual Studio writes for the app sets
  its RID too late for a build without one (the output folder then says x64 while the RID is arm64).
- **iOS** needs a Mac: Visual Studio's *Pair to Mac*, or the solution on a Mac. Automatic signing
  must create the two bundle ids (`com.delucatech.streamanywhere`, `.broadcast`) and the App Group on
  your Apple developer account; both projects' Entitlements.plist list the group. Run on a real
  iPhone (the simulator has no ReplayKit broadcast).
- The viewer page the extension serves is `../mirror/ios/Shared/Resources/viewer.html`, built by
  `npm run build:mirror-local -w client` at the repo root (committed).

## What is verified and what is not

- Verified: the relay, the viewer (WebCodecs and MSE), the protocol, the pairing (the car's page
  shows the code, a claim signs the phone in, the page switches to the picture by itself and back to
  the code when the stream stops), with the desktop sender page in a browser; the server's 36 relay
  checks; the C# compiles for iOS (2026-10-21).
- **Not yet run on a phone** (no Mac here): the extension itself, the camera scanner, the URL-scheme
  handoff. Expect a round of fixes. The soft spots: the orientation mapping (`Broadcaster.RotationOf`;
  swap 90 and 270 if landscape comes out turned the wrong way), the 50 MB memory limit of the
  extension with the .NET runtime (the `MtouchLink=SdkOnly` setting keeps the bundle small; if iOS
  kills the broadcast, try the Saver quality), whether the Tesla's browser accepts the plain-http
  hotspot page, and the restyled system start button on iOS 17+ (if it shows a bare icon, the title
  styling in `BroadcastPickerHandler.Style` needs the button's `Configuration` cleared).
