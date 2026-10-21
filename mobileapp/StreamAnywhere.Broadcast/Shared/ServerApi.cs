// The few HTTP calls to the StreamAnywhere server: the site password (POST /login answers 303 with
// the sa_auth cookie, kept in the settings for the extension), a room code. Managed HTTP on purpose:
// the native handler follows redirects and keeps cookies where the extension cannot see them.
using System.Net;
using System.Text.Json;

namespace StreamAnywhere.Mirror;

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

    /// <summary>Signs in; returns the cookie to keep ("" when the server has no password).</summary>
    public async Task<string> SignInAsync(string password)
    {
        var form = new FormUrlEncodedContent(new[] { new KeyValuePair<string, string>("password", password), new KeyValuePair<string, string>("next", "/") });
        using var resp = await http.PostAsync(new Uri(server, "/login"), form);
        if (resp.StatusCode == HttpStatusCode.Unauthorized) throw new InvalidOperationException("Wrong password.");
        if ((int)resp.StatusCode is < 200 or >= 400) throw new InvalidOperationException($"The server answered {(int)resp.StatusCode}.");
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
