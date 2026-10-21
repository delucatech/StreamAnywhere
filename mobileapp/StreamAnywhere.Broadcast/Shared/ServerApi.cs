// The few HTTP calls to the StreamAnywhere server: pairing (the token from the QR code on the
// Tesla's screen buys the sa_auth login cookie and the room; the normal way in), the site password
// (POST /login answers 303 with the same cookie; the fallback), a room code. The cookie is kept in the
// settings for the extension. Managed HTTP on purpose: the native handler follows redirects and keeps
// cookies where the extension cannot see them.
using System.Net;
using System.Text;
using System.Text.Json;

namespace StreamAnywhere.Mirror;

/// <summary>What a claimed pairing code gave us: the room, the cookie ("" when the server has no password).</summary>
public sealed record PairClaim(string Room, string Cookie, bool SignedIn);

public sealed class ServerApi
{
    readonly Uri server;
    readonly HttpClient http;

    public ServerApi(Uri server, string cookie)
    {
        this.server = server;
        http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(15) };
        if (cookie.Length > 0) http.DefaultRequestHeaders.Add("Cookie", cookie);
    }

    static string AuthCookieOf(HttpResponseMessage resp)
    {
        if (resp.Headers.TryGetValues("Set-Cookie", out var cookies))
        {
            foreach (var c in cookies)
            {
                var pair = c.Split(';')[0].Trim();
                if (pair.StartsWith("sa_auth=")) return pair;
            }
        }
        return "";
    }

    /// <summary>
    /// Claims the one-time code from the QR code on the Tesla's screen (POST /api/mirror/pair/claim, no
    /// cookie needed): the server signs this phone in and names the room the car is waiting in.
    /// </summary>
    public async Task<PairClaim> ClaimPairAsync(string token, string name)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("token", token);
            w.WriteString("name", name);
            w.WriteEndObject();
        }
        using var content = new ByteArrayContent(ms.ToArray());
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        using var resp = await http.PostAsync(new Uri(server, "/api/mirror/pair/claim"), content);
        if (resp.StatusCode == HttpStatusCode.NotFound) throw new InvalidOperationException("That pairing code is no longer valid. Scan the code on the Tesla's screen again.");
        if (resp.StatusCode == HttpStatusCode.TooManyRequests) throw new InvalidOperationException("Too many tries; wait a minute and scan again.");
        if (resp.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException($"The server answered {(int)resp.StatusCode}.");
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsByteArrayAsync());
        var room = doc.RootElement.GetProperty("room").GetString() ?? throw new InvalidOperationException("No room in the answer.");
        var signedIn = doc.RootElement.TryGetProperty("signedIn", out var s) && s.GetBoolean();
        var cookie = AuthCookieOf(resp);
        if (signedIn && cookie.Length == 0) throw new InvalidOperationException("The server paired the phone but set no login cookie; check the address.");
        return new PairClaim(room, cookie, signedIn);
    }

    /// <summary>Signs in with the site password; returns the cookie to keep ("" when the server has no password).</summary>
    public async Task<string> SignInAsync(string password)
    {
        var form = new FormUrlEncodedContent(new[] { new KeyValuePair<string, string>("password", password), new KeyValuePair<string, string>("next", "/") });
        using var resp = await http.PostAsync(new Uri(server, "/login"), form);
        if (resp.StatusCode == HttpStatusCode.Unauthorized) throw new InvalidOperationException("Wrong password.");
        if ((int)resp.StatusCode is < 200 or >= 400) throw new InvalidOperationException($"The server answered {(int)resp.StatusCode}.");
        return AuthCookieOf(resp);
    }

    /// <summary>Is the cookie (or the open server) still accepted?</summary>
    public async Task<bool> SignedInAsync()
    {
        try
        {
            using var resp = await http.GetAsync(new Uri(server, "/api/mirror/ice"));
            return resp.StatusCode == HttpStatusCode.OK;
        }
        catch
        {
            return false;
        }
    }

    public async Task<string> CreateRoomAsync()
    {
        using var resp = await http.PostAsync(new Uri(server, "/api/mirror/rooms"), null);
        if (resp.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException($"The server answered {(int)resp.StatusCode}.");
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsByteArrayAsync());
        return doc.RootElement.GetProperty("room").GetString() ?? throw new InvalidOperationException("No room in the answer.");
    }
}
