// What the Mirror page needs from the platform. iOS has the real thing (Platforms/iOS/MirrorPlatform.cs,
// backed by the code shared with the broadcast extension); the other platforms get the stub below,
// which only says that mirroring is an iPhone feature.
namespace StreamAnywhere.Mirror;

public sealed record MirrorSettingsView(string ServerUrl, string DeviceName, string Room, bool SignedIn, string Quality, int Fps, bool Audio, bool Microphone, bool UseServer);

public sealed record MirrorStatusView(string State, string Message, int Kbps, int Width, int Height, int Rotation, string Relay, int Watchers, int LocalClients, bool Live);

public interface IMirrorPlatform
{
    bool Supported { get; }
    /// <summary>The bundle id of the broadcast extension (the start button is pointed at it)</summary>
    string ExtensionBundleId { get; }
    MirrorSettingsView Load();
    void Save(MirrorSettingsView s);
    /// <summary>POST /login; keeps the cookie. Throws with a readable message when it fails.</summary>
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
    public MirrorSettingsView Load() => settings;
    public void Save(MirrorSettingsView s) => settings = s;
    public Task SignInAsync(string serverUrl, string password) => throw new NotSupportedException("Mirroring the screen is an iPhone feature.");
    public Task<string> NewRoomAsync() => Task.FromResult("");
    public MirrorStatusView? Status() => null;
    public IReadOnlyList<string> LocalAddresses() => Array.Empty<string>();
    public int LocalPagePort => 8420;
}
#endif
