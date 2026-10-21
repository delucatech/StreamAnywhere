# StreamAnywhere mobile app (.NET MAUI)

The phone app. Its first feature is **Mirror**: the iPhone's screen (any app, with its sound) on the
Tesla's browser. Open `StreamAnywhere.slnx` in Visual Studio.

```
StreamAnywhere/                 the MAUI app (iOS, Android, Windows, Mac Catalyst)
  Mirror/MirrorPage.xaml        the home page: the room code the car types, the start button, status, settings
  Mirror/IMirrorPlatform.cs     what the page needs from the platform (+ the stub for non-iOS platforms)
  Mirror/BroadcastPickerView.cs the start button (iOS: the system's RPSystemBroadcastPickerView)
  Platforms/iOS/MirrorPlatform.cs, BroadcastPickerHandler.cs, Entitlements.plist (the App Group)
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
| Relay | Anywhere else | StreamAnywhere → Mirror, type the six-letter code (or `mirror.html?room=CODE`) |

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
  page with a "this is an iPhone feature" note, and compiles all the iOS C# (checked 2026-10-21: the
  extension and the app's iOS files compile against the iOS bindings).
- **iOS** needs a Mac: Visual Studio's *Pair to Mac*, or the solution on a Mac. Automatic signing
  must create the two bundle ids (`com.delucatech.streamanywhere`, `.broadcast`) and the App Group on
  your Apple developer account; both projects' Entitlements.plist list the group. Run on a real
  iPhone (the simulator has no ReplayKit broadcast).
- The viewer page the extension serves is `../mirror/ios/Shared/Resources/viewer.html`, built by
  `npm run build:mirror-local -w client` at the repo root (committed).

## What is verified and what is not

- Verified: the relay, the viewer (WebCodecs and MSE), the protocol, with the desktop sender page in
  a browser; the server's 26 relay checks; the C# compiles for iOS.
- **Not yet run on a phone** (no Mac here): the extension itself. Expect a round of fixes. The soft
  spots: the orientation mapping (`Broadcaster.RotationOf`; swap 90 and 270 if landscape comes out
  turned the wrong way), the 50 MB memory limit of the extension with the .NET runtime (the
  `MtouchLink=SdkOnly` setting keeps the bundle small; if iOS kills the broadcast, try the Saver
  quality), and whether the Tesla's browser accepts the plain-http hotspot page.
