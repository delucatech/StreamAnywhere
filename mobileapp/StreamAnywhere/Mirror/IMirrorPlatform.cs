// What the Mirror page needs from the platform. iOS has the real thing (Platforms/iOS/MirrorPlatform.cs,
// backed by the code shared with the broadcast extension); the other platforms get the stub below,
// which only says that mirroring is an iPhone feature.
namespace StreamAnywhere.Mirror;

public sealed record MirrorSettingsView(string ServerUrl, string DeviceName, string Room, bool SignedIn, string Quality, int Fps, bool Audio, bool Microphone, bool UseServer)
{
    /// <summary>The phone can reach the relay: paired (or signed in), with a room the car knows</summary>
    public bool Paired => UseServer && SignedIn && RoomCode.IsValid(Room);
    public string ServerHost => Uri.TryCreate(ServerUrl.Trim(), UriKind.Absolute, out var u) ? u.Host : ServerUrl;
}

/// <summary>Fresh = written in the last seconds (the extension is running); Live = fresh and mirroring.</summary>
public sealed record MirrorStatusView(string State, string Message, int Kbps, int Width, int Height, int Rotation, string Relay, string RelayError, int Watchers, int LocalClients, bool Fresh, bool Live, bool Recent);

public interface IMirrorPlatform
{
    bool Supported { get; }
    /// <summary>The bundle id of the broadcast extension (the start button is pointed at it)</summary>
    string ExtensionBundleId { get; }
    /// <summary>iOS is recording or broadcasting the screen right now (whatever is receiving it)</summary>
    bool ScreenCaptured { get; }
    MirrorSettingsView Load();
    void Save(MirrorSettingsView s);
    /// <summary>Opens the camera on a QR scanner; the text of the first code seen, or null when the user cancelled.</summary>
    Task<string?> ScanPairingCodeAsync();
    /// <summary>
    /// Claims a pairing code from the Tesla's screen: the server signs this phone in and names the car's
    /// room; both are kept. Throws with a readable message when it fails.
    /// </summary>
    Task<MirrorSettingsView> PairAsync(string server, string token);
    /// <summary>POST /login with the site password (the fallback when there is no code to scan); keeps the cookie.</summary>
    Task SignInAsync(string serverUrl, string password);
    /// <summary>A room code: from the server when it can be reached, otherwise made here.</summary>
    Task<string> NewRoomAsync();
    MirrorStatusView? Status();
    /// <summary>The phone's addresses on its hotspot / Wi-Fi (the hotspot's first)</summary>
    IReadOnlyList<string> LocalAddresses();
    int LocalPagePort { get; }
}

#if !IOS
public sealed class MirrorPlatformStub : IMirrorPlatform
{
    MirrorSettingsView settings = new("https://teslavplayer.duckdns.org", "Phone", "", false, "Balanced", 30, true, false, true);
    public bool Supported => false;
    public string ExtensionBundleId => "";
    public bool ScreenCaptured => false;
    public MirrorSettingsView Load() => settings;
    public void Save(MirrorSettingsView s) => settings = s;
    public Task<string?> ScanPairingCodeAsync() => Task.FromResult<string?>(null);
    public Task<MirrorSettingsView> PairAsync(string server, string token) => throw new NotSupportedException("Mirroring the screen is an iPhone feature.");
    public Task SignInAsync(string serverUrl, string password) => throw new NotSupportedException("Mirroring the screen is an iPhone feature.");
    public Task<string> NewRoomAsync() => Task.FromResult("");
    public MirrorStatusView? Status() => null;
    public IReadOnlyList<string> LocalAddresses() => Array.Empty<string>();
    public int LocalPagePort => 8420;
}
#endif
