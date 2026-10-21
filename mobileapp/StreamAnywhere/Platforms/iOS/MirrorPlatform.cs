// iOS: the Mirror page's platform side, on the code shared with the broadcast extension
// (StreamAnywhere.Broadcast/Shared, linked into this project): the App Group settings the
// extension reads, the status file it writes, the pairing (QR scanner + claim), the password
// sign-in, the room.
using Microsoft.Maui.ApplicationModel;

namespace StreamAnywhere.Mirror;

public sealed class MirrorPlatform : IMirrorPlatform
{
    public bool Supported => true;
    public string ExtensionBundleId => MirrorSettings.BroadcastExtensionBundleId;
    public int LocalPagePort => MirrorProtocol.LocalPagePort;

    static MirrorSettingsView View(MirrorSettings s) => new(s.ServerUrl, s.DeviceName, s.Room, s.SignedIn, s.Quality.ToString(), s.Fps, s.Audio, s.Microphone, s.UseServer);

    public MirrorSettingsView Load()
    {
        var s = MirrorSettings.Load();
        if (s.DeviceName == "iPhone") s.DeviceName = UIKit.UIDevice.CurrentDevice.Name;
        return View(s);
    }

    public void Save(MirrorSettingsView v)
    {
        var s = MirrorSettings.Load();
        s.ServerUrl = v.ServerUrl;
        s.DeviceName = v.DeviceName;
        s.Room = v.Room;
        s.Quality = Enum.TryParse<MirrorQuality>(v.Quality, out var q) ? q : MirrorQuality.Balanced;
        s.Fps = v.Fps;
        s.Audio = v.Audio;
        s.Microphone = v.Microphone;
        s.UseServer = v.UseServer;
        s.Save();
    }

    public async Task<string?> ScanPairingCodeAsync()
    {
        var host = Platform.GetCurrentUIViewController();
        if (host == null) return null;
        var scanner = new QrScannerController();
        await host.PresentViewControllerAsync(scanner, true);
        return await scanner.Result;
    }

    public async Task<MirrorSettingsView> PairAsync(string server, string token)
    {
        if (!Uri.TryCreate(server, UriKind.Absolute, out var serverUri)) throw new InvalidOperationException("The code points at an address that is not a URL.");
        var s = MirrorSettings.Load();
        if (s.DeviceName == "iPhone") s.DeviceName = UIKit.UIDevice.CurrentDevice.Name;
        var claim = await new ServerApi(serverUri, "").ClaimPairAsync(token, s.DeviceName);
        s.ServerUrl = server;
        s.Cookie = claim.Cookie;
        s.Room = claim.Room;
        s.UseServer = true;
        s.Save();
        // no password on that server: nothing to sign in to, but the relay must still take us
        if (!claim.SignedIn && !await new ServerApi(serverUri, "").SignedInAsync()) throw new InvalidOperationException("The server paired the phone but still refuses it; check the address.");
        return View(s);
    }

    public async Task SignInAsync(string serverUrl, string password)
    {
        var s = MirrorSettings.Load();
        s.ServerUrl = serverUrl;
        if (s.Server is not { } server) throw new InvalidOperationException("The server address is not a valid URL.");
        var api = new ServerApi(server, "");
        var cookie = await api.SignInAsync(password);
        s.Cookie = cookie;
        s.Save();
        // APP_PASSWORD_HASH=off: no cookie, and none needed - check the server takes us as we are
        if (cookie.Length == 0 && !await new ServerApi(server, "").SignedInAsync()) throw new InvalidOperationException("The server took the password but set no login cookie; check the address.");
    }

    public async Task<string> NewRoomAsync()
    {
        var s = MirrorSettings.Load();
        var code = "";
        if (s.UseServer && s.Server is { } server)
        {
            try
            {
                code = await new ServerApi(server, s.Cookie).CreateRoomAsync();
            }
            catch
            {
                /* offline, or not signed in: a local code; the relay makes the room when the phone connects */
            }
        }
        if (!RoomCode.IsValid(code)) code = RoomCode.Random();
        s.Room = code;
        s.Save();
        return code;
    }

    public MirrorStatusView? Status()
    {
        var st = MirrorStatus.Read();
        return st == null ? null : new MirrorStatusView(st.State, st.Message, st.Kbps, st.Width, st.Height, st.Rotation, st.Relay, st.Watchers, st.LocalClients, st.Fresh, st.Live);
    }

    public IReadOnlyList<string> LocalAddresses() => Mirror.LocalAddresses.IPv4();
}
