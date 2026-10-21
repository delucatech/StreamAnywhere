// The pairing link the Tesla's screen shows as a QR code (shared/mirror.ts, parsePairLink):
//   https://server/pair#TOKEN              what the code holds; scanned in the app, or by the Camera app,
//                                          which opens that landing page on the server, which in turn opens
//   streamanywhere://pair?server=…&token=… this app through its URL scheme (Info.plist, CFBundleURLTypes).
// Either way the app ends up here with a server and a token to claim. A link that arrives through the
// URL scheme is handed to the page (Received), or kept until the page is up (TakePending).
using System.Text.RegularExpressions;

namespace StreamAnywhere.Mirror;

public static partial class PairLink
{
    public const string Scheme = "streamanywhere";
    public const string Path = "/pair";

    [GeneratedRegex("^[A-Za-z0-9_-]{16,64}$")]
    private static partial Regex TokenRegex();

    public static bool TryParse(string? text, out string server, out string token)
    {
        server = "";
        token = "";
        if (string.IsNullOrWhiteSpace(text) || !Uri.TryCreate(text.Trim(), UriKind.Absolute, out var u)) return false;
        if (u.Scheme is "https" or "http")
        {
            if (u.AbsolutePath.TrimEnd('/') != Path) return false;
            var t = u.Fragment.TrimStart('#');
            if (!TokenRegex().IsMatch(t)) return false;
            server = u.GetLeftPart(UriPartial.Authority);
            token = t;
            return true;
        }
        if (u.Scheme != Scheme) return false;
        // "streamanywhere://pair?server=…&token=…" (the host is "pair"; the query is what matters)
        var q = u.Query;
        if (q.Length == 0 && u.OriginalString.Contains('?')) q = u.OriginalString[u.OriginalString.IndexOf('?')..];
        string s = "", t2 = "";
        foreach (var part in q.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var i = part.IndexOf('=');
            if (i <= 0) continue;
            var key = part[..i];
            var value = Uri.UnescapeDataString(part[(i + 1)..].Replace('+', ' '));
            if (key == "server") s = value.TrimEnd('/');
            else if (key == "token") t2 = value;
        }
        if (!TokenRegex().IsMatch(t2) || !Uri.TryCreate(s, UriKind.Absolute, out var su) || su.Scheme is not ("https" or "http") || su.GetLeftPart(UriPartial.Authority) != s) return false;
        server = s;
        token = t2;
        return true;
    }

    /// <summary>A link opened from outside (the landing page's button, the Camera app)</summary>
    public static event Action<string>? Received;
    static string? pending;

    public static void Receive(string? url)
    {
        if (!TryParse(url, out _, out _)) return;
        if (Received != null) Received(url!);
        else pending = url;
    }

    /// <summary>The link that arrived before anyone listened (a cold start from the landing page)</summary>
    public static string? TakePending()
    {
        var p = pending;
        pending = null;
        return p;
    }
}
