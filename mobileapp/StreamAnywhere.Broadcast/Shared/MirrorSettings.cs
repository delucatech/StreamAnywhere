// What the app configures and the broadcast extension reads, in the App Group's NSUserDefaults (the
// two are separate processes), and the status the extension writes next to it for the app to show.
// Linked into the MAUI app for iOS (StreamAnywhere.csproj) and compiled into the extension.
using System.Text.Json;
using Foundation;

namespace StreamAnywhere.Mirror;

public enum MirrorQuality
{
    Saver,    // 854 long side, 1.5 Mb/s - the car's LTE through the relay
    Balanced, // 1280, 3 Mb/s
    Sharp,    // 1920, 6 Mb/s - the hotspot / Wi-Fi
}

public static class MirrorQualityInfo
{
    public static int LongSide(this MirrorQuality q) => q switch { MirrorQuality.Saver => 854, MirrorQuality.Sharp => 1920, _ => 1280 };
    public static int Bitrate(this MirrorQuality q) => q switch { MirrorQuality.Saver => 1_500_000, MirrorQuality.Sharp => 6_000_000, _ => 3_000_000 };
    public static string Label(this MirrorQuality q) => q switch { MirrorQuality.Saver => "Saver (480p, 1.5 Mb/s)", MirrorQuality.Sharp => "Sharp (1080p, 6 Mb/s)", _ => "Balanced (720p, 3 Mb/s)" };
}

public sealed class MirrorSettings
{
    /// <summary>The App Group both targets belong to (the two Entitlements.plist files).</summary>
    public const string AppGroup = "group.com.delucatech.streamanywhere";
    public const string BroadcastExtensionBundleId = "com.delucatech.streamanywhere.broadcast";

    public string ServerUrl { get; set; } = "https://teslavplayer.duckdns.org";
    public string DeviceName { get; set; } = "iPhone";
    public string Room { get; set; } = "";
    /// <summary>The site-password cookie (sa_auth=…) the server set at sign-in; empty = not signed in</summary>
    public string Cookie { get; set; } = "";
    public MirrorQuality Quality { get; set; } = MirrorQuality.Balanced;
    public int Fps { get; set; } = 30;
    public bool Audio { get; set; } = true;
    public bool Microphone { get; set; } = false;
    /// <summary>Use the StreamAnywhere relay at all (off = hotspot only)</summary>
    public bool UseServer { get; set; } = true;

    public bool SignedIn => Cookie.Length > 0;
    public Uri? Server => Uri.TryCreate(ServerUrl.Trim(), UriKind.Absolute, out var u) ? u : null;

    static NSUserDefaults Defaults => new NSUserDefaults(AppGroup, NSUserDefaultsType.SuiteName);

    public static MirrorSettings Load()
    {
        var d = Defaults;
        var s = new MirrorSettings();
        s.ServerUrl = d.StringForKey("mirror.server") ?? s.ServerUrl;
        s.DeviceName = d.StringForKey("mirror.name") ?? s.DeviceName;
        s.Room = d.StringForKey("mirror.room") ?? "";
        s.Cookie = d.StringForKey("mirror.cookie") ?? "";
        s.Quality = Enum.TryParse<MirrorQuality>(d.StringForKey("mirror.quality"), out var q) ? q : MirrorQuality.Balanced;
        var fps = (int)d.IntForKey("mirror.fps");
        s.Fps = fps is 15 or 24 or 30 or 60 ? fps : 30;
        s.Audio = d.ValueForKey(new NSString("mirror.audio")) == null || d.BoolForKey("mirror.audio");
        s.Microphone = d.BoolForKey("mirror.mic");
        s.UseServer = d.ValueForKey(new NSString("mirror.useServer")) == null || d.BoolForKey("mirror.useServer");
        return s;
    }

    public void Save()
    {
        var d = Defaults;
        d.SetString(ServerUrl, "mirror.server");
        d.SetString(DeviceName, "mirror.name");
        d.SetString(Room, "mirror.room");
        d.SetString(Cookie, "mirror.cookie");
        d.SetString(Quality.ToString(), "mirror.quality");
        d.SetInt(Fps, "mirror.fps");
        d.SetBool(Audio, "mirror.audio");
        d.SetBool(Microphone, "mirror.mic");
        d.SetBool(UseServer, "mirror.useServer");
        d.Synchronize();
    }
}

/// <summary>What the extension is doing, for the app's screen (written once a second to the group container).</summary>
public sealed class MirrorStatus
{
    public string State { get; set; } = "idle"; // idle | starting | live | stopped | error
    public string Message { get; set; } = "";
    public string Room { get; set; } = "";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public int VideoFrames { get; set; }
    public int Kbps { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public int Rotation { get; set; }
    public string Relay { get; set; } = "off"; // off | connecting | open | idle | closed
    /// <summary>Why the server link is not open (empty while it is, or has never failed)</summary>
    public string RelayError { get; set; } = "";
    public int Watchers { get; set; }
    public int LocalClients { get; set; }
    public List<string> LocalAddresses { get; set; } = new();

    public bool Fresh => (DateTime.UtcNow - UpdatedAt).TotalSeconds < 5;
    public bool Live => State == "live" && Fresh;
    /// <summary>Written in the last minutes: what it says is about this outing, not an old one</summary>
    public bool Recent => (DateTime.UtcNow - UpdatedAt).TotalMinutes < 10;

    static string? FilePath
    {
        get
        {
            var url = NSFileManager.DefaultManager.GetContainerUrl(MirrorSettings.AppGroup);
            return url?.Path == null ? null : Path.Combine(url.Path, "status.json");
        }
    }

    public void Write()
    {
        var path = FilePath;
        if (path == null) return;
        try
        {
            using var ms = new MemoryStream();
            using (var w = new System.Text.Json.Utf8JsonWriter(ms))
            {
                w.WriteStartObject();
                w.WriteString("state", State);
                w.WriteString("message", Message);
                w.WriteString("room", Room);
                w.WriteString("updatedAt", UpdatedAt.ToString("o"));
                w.WriteNumber("videoFrames", VideoFrames);
                w.WriteNumber("kbps", Kbps);
                w.WriteNumber("width", Width);
                w.WriteNumber("height", Height);
                w.WriteNumber("rotation", Rotation);
                w.WriteString("relay", Relay);
                w.WriteString("relayError", RelayError);
                w.WriteNumber("watchers", Watchers);
                w.WriteNumber("localClients", LocalClients);
                w.WriteStartArray("localAddresses");
                foreach (var a in LocalAddresses) w.WriteStringValue(a);
                w.WriteEndArray();
                w.WriteEndObject();
            }
            var tmp = path + ".tmp";
            File.WriteAllBytes(tmp, ms.ToArray());
            File.Move(tmp, path, true);
        }
        catch
        {
            /* the status is a convenience */
        }
    }

    public static MirrorStatus? Read()
    {
        var path = FilePath;
        if (path == null || !File.Exists(path)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
            var r = doc.RootElement;
            var s = new MirrorStatus
            {
                State = r.GetProperty("state").GetString() ?? "idle",
                Message = r.GetProperty("message").GetString() ?? "",
                Room = r.GetProperty("room").GetString() ?? "",
                UpdatedAt = DateTime.TryParse(r.GetProperty("updatedAt").GetString(), null, System.Globalization.DateTimeStyles.RoundtripKind, out var t) ? t.ToUniversalTime() : DateTime.MinValue,
                VideoFrames = r.GetProperty("videoFrames").GetInt32(),
                Kbps = r.GetProperty("kbps").GetInt32(),
                Width = r.GetProperty("width").GetInt32(),
                Height = r.GetProperty("height").GetInt32(),
                Rotation = r.GetProperty("rotation").GetInt32(),
                Relay = r.GetProperty("relay").GetString() ?? "off",
                RelayError = r.TryGetProperty("relayError", out var re) ? re.GetString() ?? "" : "",
                Watchers = r.GetProperty("watchers").GetInt32(),
                LocalClients = r.GetProperty("localClients").GetInt32(),
            };
            foreach (var a in r.GetProperty("localAddresses").EnumerateArray()) if (a.GetString() is { } addr) s.LocalAddresses.Add(addr);
            return s;
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>The phone's IPv4 addresses (the hotspot's 172.20.10.1 first), for the app to show.</summary>
public static class LocalAddresses
{
    public static List<string> IPv4()
    {
        var outp = new List<string>();
        try
        {
            foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;
                foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) continue;
                    var s = ua.Address.ToString();
                    if (s.StartsWith("169.254") || s.StartsWith("127.")) continue;
                    outp.Add(s);
                }
            }
        }
        catch
        {
            /* no interfaces to list */
        }
        return outp.OrderByDescending(a => a.StartsWith("172.20.10.")).Distinct().ToList();
    }
}
