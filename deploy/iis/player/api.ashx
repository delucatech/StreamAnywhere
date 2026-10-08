<%@ WebHandler Language="C#" Class="StreamAnywhere.ApiHandler" %>
/*
 * StreamAnywhere resolver + media proxy as a single ASP.NET generic handler.
 * Port of server/src (Node) for IIS. Targets the .NET 2.0 CLR / C# 3 (.NET 3.5 compiler) so it runs
 * inside an existing ASP.NET 2.0/3.5 application without any server configuration.
 *
 * Routing uses path info:  /player/api.ashx/api/resolve, /player/api.ashx/api/media/<id>, ...
 * The client is built with VITE_API_BASE=/player/api.ashx so its "/api/..." calls land here.
 */
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web;
using System.Web.Script.Serialization;

namespace StreamAnywhere
{
    public class ApiHandler : IHttpHandler
    {
        // ------------------------------------------------------------------ configuration
        static readonly string[] ProxyAllowedHosts = {
            "*.tiktok.com", "*.tiktokcdn.com", "*.tiktokcdn-us.com", "*.tiktokcdn-eu.com", "*.tiktokv.com",
            "*.byteoversea.com", "*.ibyteimg.com", "mdn.github.io", "interactive-examples.mdn.mozilla.net"
        };
        static readonly string[] TikTokHosts = { "*.tiktok.com", "*.tiktokcdn.com", "*.tiktokcdn-us.com", "*.tiktokcdn-eu.com", "*.tiktokv.com" };
        static readonly string[] CorsOrigins = { "https://delucatech.com", "https://www.delucatech.com", "https://delucatech.github.io", "http://localhost:5173", "http://127.0.0.1:5173" };
        const int ResolvePerMinute = 20;
        const int MediaPerMinute = 120;
        const int UpstreamTimeoutMs = 25000;
        const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
        static readonly DateTime Started = DateTime.UtcNow;

        // ------------------------------------------------------------------ state (per app domain)
        class MediaRecord
        {
            public string Id;
            public string Url;
            public string Referer;
            public List<KeyValuePair<string, string>> Cookies = new List<KeyValuePair<string, string>>();
            public DateTime ExpiresAt;
            public string Source;
            public int Requests;
            public long Bytes;
        }
        static readonly Dictionary<string, MediaRecord> Media = new Dictionary<string, MediaRecord>();
        static readonly Dictionary<string, List<DateTime>> RateBuckets = new Dictionary<string, List<DateTime>>();
        static readonly List<string> RecentReports = new List<string>();
        static readonly object Gate = new object();

        static ApiHandler()
        {
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768; } // Tls12 | Tls11
            catch (Exception) { try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } catch (Exception) { } }
            ServicePointManager.Expect100Continue = false;
            ServicePointManager.DefaultConnectionLimit = 64;
        }

        public bool IsReusable { get { return true; } }

        // ------------------------------------------------------------------ entry point
        public void ProcessRequest(HttpContext ctx)
        {
            HttpRequest req = ctx.Request;
            HttpResponse res = ctx.Response;
            string path = (req.PathInfo ?? "").TrimEnd('/');
            if (path.Length == 0) path = "/";
            ApplyCors(req, res);
            if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.End(); return; }
            try
            {
                if (path == "/api/health" || path == "/") { Json(res, 200, Health()); return; }
                if (path == "/api/stats") { Json(res, 200, Stats()); return; }
                if (path == "/api/resolve") { RequirePost(req); RateLimit(ctx, "resolve", ResolvePerMinute); Json(res, 200, Resolve(ReadJsonBody(req), req)); return; }
                if (path == "/api/probe") { RequirePost(req); RateLimit(ctx, "resolve", ResolvePerMinute); Dictionary<string, object> b = ReadJsonBody(req); Json(res, 200, Probe(Str(b, "url"), Str(b, "origin") ?? req.Headers["Origin"] ?? "https://delucatech.com", new string[] { "*" })); return; }
                if (path == "/api/report") { RequirePost(req); Report(ReadJsonBody(req), req); Json(res, 200, Obj("ok", true)); return; }
                if (path.StartsWith("/api/media/")) { RateLimit(ctx, "media", MediaPerMinute); ProxyMedia(ctx, path.Substring("/api/media/".Length)); return; }
                Json(res, 404, Obj("error", "Unknown endpoint " + path));
            }
            catch (HttpError e) { Json(res, e.Status, Obj("error", e.Message)); }
            catch (System.Threading.ThreadAbortException) { throw; }
            catch (Exception e) { Json(res, 500, Obj("error", e.GetType().Name + ": " + e.Message)); }
        }

        class HttpError : Exception { public int Status; public HttpError(int status, string msg) : base(msg) { Status = status; } }

        static void RequirePost(HttpRequest req) { if (req.HttpMethod != "POST") throw new HttpError(405, "POST required"); }

        static void ApplyCors(HttpRequest req, HttpResponse res)
        {
            string origin = req.Headers["Origin"];
            if (origin != null && Array.IndexOf(CorsOrigins, origin) >= 0)
            {
                res.AppendHeader("Access-Control-Allow-Origin", origin);
                res.AppendHeader("Vary", "Origin");
            }
            res.AppendHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
            res.AppendHeader("Access-Control-Allow-Headers", "Content-Type, Range");
            res.AppendHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, X-Proxy-Upstream-Host, X-Proxy-Upstream-Status, X-Proxy-Redirects");
            res.AppendHeader("Access-Control-Max-Age", "600");
        }

        static void RateLimit(HttpContext ctx, string bucket, int perMinute)
        {
            string key = bucket + "|" + ctx.Request.UserHostAddress;
            DateTime now = DateTime.UtcNow;
            lock (Gate)
            {
                List<DateTime> hits;
                if (!RateBuckets.TryGetValue(key, out hits)) { hits = new List<DateTime>(); RateBuckets[key] = hits; }
                hits.RemoveAll(delegate(DateTime t) { return (now - t).TotalSeconds > 60; });
                if (hits.Count >= perMinute) throw new HttpError(429, "Rate limit exceeded (" + perMinute + " per minute)");
                hits.Add(now);
                if (RateBuckets.Count > 5000) RateBuckets.Clear();
            }
        }

        // ------------------------------------------------------------------ JSON helpers (JavaScriptSerializer, .NET 3.5)
        static JavaScriptSerializer NewSerializer() { JavaScriptSerializer s = new JavaScriptSerializer(); s.MaxJsonLength = int.MaxValue; s.RecursionLimit = 500; return s; }

        static void Json(HttpResponse res, int status, object body)
        {
            res.StatusCode = status;
            res.ContentType = "application/json; charset=utf-8";
            res.Cache.SetCacheability(HttpCacheability.NoCache);
            res.Write(NewSerializer().Serialize(body));
        }

        static Dictionary<string, object> Obj(params object[] kv)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }

        static Dictionary<string, object> ReadJsonBody(HttpRequest req)
        {
            string text;
            using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8)) text = r.ReadToEnd();
            if (text.Trim().Length == 0) return new Dictionary<string, object>();
            object o;
            try { o = NewSerializer().DeserializeObject(text); } catch (Exception e) { throw new HttpError(400, "Invalid JSON body: " + e.Message); }
            Dictionary<string, object> d = o as Dictionary<string, object>;
            if (d == null) throw new HttpError(400, "JSON body must be an object");
            return d;
        }

        static object Get(object o, string key)
        {
            IDictionary<string, object> d = o as IDictionary<string, object>;
            if (d == null) return null;
            object v;
            return d.TryGetValue(key, out v) ? v : null;
        }
        static string Str(object o, string key) { object v = Get(o, key); return v == null ? null : v.ToString(); }
        static double Num(object v) { if (v == null) return 0; try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch (Exception) { return 0; } }
        static IList Arr(object v) { return v as IList; }

        // ------------------------------------------------------------------ health / stats / report
        static object Health()
        {
            return Obj(
                "ok", true,
                "node", "ASP.NET " + Environment.Version + " on " + Environment.OSVersion.VersionString,
                "ytdlp", Obj("available", false, "error", "yt-dlp is not available in the IIS deployment (native resolver only)"),
                "resolver", "native",
                "proxyAllowedHosts", new List<string>(ProxyAllowedHosts),
                "uptimeSec", (int)(DateTime.UtcNow - Started).TotalSeconds);
        }
        static object Stats()
        {
            lock (Gate)
            {
                List<object> recs = new List<object>();
                foreach (MediaRecord r in Media.Values) recs.Add(Obj("id", r.Id, "host", new Uri(r.Url).Host, "requests", r.Requests, "bytes", r.Bytes, "expiresAt", r.ExpiresAt.ToString("o")));
                return Obj("mediaRecords", Media.Count, "media", recs, "recentReports", new List<string>(RecentReports), "uptimeSec", (int)(DateTime.UtcNow - Started).TotalSeconds);
            }
        }
        static void Report(Dictionary<string, object> b, HttpRequest req)
        {
            string line = DateTime.UtcNow.ToString("o") + " " + req.UserHostAddress + " connection=" + Str(b, "connection") + " renderer=" + Str(b, "renderer") + " ok=" + Str(b, "ok") + " media=" + Str(b, "mediaId") + " detail=" + Truncate(Str(b, "detail"), 200);
            lock (Gate) { RecentReports.Add(line); if (RecentReports.Count > 200) RecentReports.RemoveAt(0); }
        }
        static string Truncate(string s, int n) { return s == null ? null : (s.Length > n ? s.Substring(0, n) : s); }

        // ------------------------------------------------------------------ SSRF guard
        static bool HostAllowed(string host, string[] allow)
        {
            string h = host.ToLowerInvariant().TrimEnd('.');
            foreach (string e0 in allow)
            {
                string e = e0.ToLowerInvariant();
                if (e == "*") return true;
                if (e.StartsWith("*.")) { string suffix = e.Substring(1); if (h.EndsWith(suffix) && h.Length > suffix.Length) return true; }
                else if (h == e) return true;
            }
            return false;
        }
        static bool IsPrivate(IPAddress ip)
        {
            if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            {
                byte[] b = ip.GetAddressBytes();
                return b[0] == 10 || b[0] == 127 || b[0] == 0 || (b[0] == 169 && b[1] == 254) || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) || b[0] >= 224;
            }
            if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
            {
                if (IPAddress.IPv6Loopback.Equals(ip) || IPAddress.IPv6Any.Equals(ip) || ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal) return true;
                byte[] b = ip.GetAddressBytes();
                return (b[0] & 0xFE) == 0xFC;
            }
            return true;
        }
        static Uri AssertSafeUpstream(string raw, string[] allow)
        {
            Uri u;
            if (!Uri.TryCreate(raw, UriKind.Absolute, out u)) throw new HttpError(400, "Invalid upstream URL");
            if (u.Scheme != "https") throw new HttpError(403, "Only https upstreams are allowed");
            if (u.UserInfo.Length > 0) throw new HttpError(403, "Credentials in URL are not allowed");
            if (!HostAllowed(u.Host, allow)) throw new HttpError(403, "Upstream host \"" + u.Host + "\" is not in the proxy allowlist");
            IPAddress literal;
            if (IPAddress.TryParse(u.Host, out literal)) { if (IsPrivate(literal)) throw new HttpError(403, "Literal IP upstreams are not allowed"); return u; }
            IPAddress[] addrs;
            try { addrs = Dns.GetHostAddresses(u.Host); } catch (Exception e) { throw new HttpError(502, "DNS lookup failed for " + u.Host + ": " + e.Message); }
            if (addrs.Length == 0) throw new HttpError(502, "DNS returned no addresses for " + u.Host);
            foreach (IPAddress a in addrs) if (IsPrivate(a)) throw new HttpError(403, "Upstream " + u.Host + " resolves to a private address");
            return u;
        }

        // ------------------------------------------------------------------ HTTP client
        class Upstream
        {
            public HttpWebResponse Response;
            public int Status;
            public string FinalUrl;
            public int Redirects;
        }

        static HttpWebRequest MakeRequest(Uri u, string method, MediaRecord rec, string range, string origin, string referer)
        {
            HttpWebRequest r = (HttpWebRequest)WebRequest.Create(u);
            r.Method = method;
            r.Timeout = UpstreamTimeoutMs;
            r.ReadWriteTimeout = UpstreamTimeoutMs;
            r.AllowAutoRedirect = false;
            r.UserAgent = UserAgent;
            r.Accept = "*/*";
            r.KeepAlive = true;
            r.AutomaticDecompression = DecompressionMethods.None;
            if (referer != null) r.Referer = referer;
            if (origin != null) r.Headers["Origin"] = origin;
            if (rec != null)
            {
                if (rec.Referer != null) r.Referer = rec.Referer;
                if (rec.Cookies.Count > 0)
                {
                    r.CookieContainer = new CookieContainer();
                    foreach (KeyValuePair<string, string> c in rec.Cookies)
                    {
                        try { r.CookieContainer.Add(new Cookie(c.Key, c.Value, "/", "." + RegistrableDomain(u.Host))); } catch (Exception) { }
                    }
                }
            }
            if (range != null) ApplyRange(r, range);
            return r;
        }

        static string RegistrableDomain(string host)
        {
            string[] parts = host.Split('.');
            if (parts.Length <= 2) return host;
            return parts[parts.Length - 2] + "." + parts[parts.Length - 1];
        }

        static void ApplyRange(HttpWebRequest r, string range)
        {
            Match m = Regex.Match(range ?? "", @"^bytes=(\d*)-(\d*)$");
            if (!m.Success) throw new HttpError(416, "Unsupported Range header");
            string a = m.Groups[1].Value, b = m.Groups[2].Value;
            long from = a.Length > 0 ? long.Parse(a, CultureInfo.InvariantCulture) : -1;
            long to = b.Length > 0 ? long.Parse(b, CultureInfo.InvariantCulture) : -1;
            if (from > int.MaxValue || to > int.MaxValue) throw new HttpError(416, "Range beyond 2 GB is not supported by this proxy");
            if (from >= 0 && to >= 0) r.AddRange((int)from, (int)to);
            else if (from >= 0) r.AddRange((int)from);
            else if (to >= 0) r.AddRange(-(int)to); // suffix range: last N bytes
        }

        /// Opens an upstream response, following redirects manually (each hop re-validated).
        static Upstream Open(string url, string method, MediaRecord rec, string range, string origin, string referer, string[] allow, int maxRedirects)
        {
            Uri u = AssertSafeUpstream(url, allow);
            int redirects = 0;
            for (; ; )
            {
                HttpWebRequest r = MakeRequest(u, method, rec, range, origin, referer);
                HttpWebResponse resp;
                try { resp = (HttpWebResponse)r.GetResponse(); }
                catch (WebException we)
                {
                    resp = we.Response as HttpWebResponse;
                    if (resp == null) throw new HttpError(502, "Upstream request failed: " + we.Status + " " + we.Message);
                }
                int status = (int)resp.StatusCode;
                string loc = resp.Headers["Location"];
                if ((status == 301 || status == 302 || status == 303 || status == 307 || status == 308) && loc != null && redirects < maxRedirects)
                {
                    resp.Close();
                    redirects++;
                    u = AssertSafeUpstream(new Uri(u, loc).ToString(), allow);
                    continue;
                }
                Upstream up = new Upstream();
                up.Response = resp; up.Status = status; up.FinalUrl = u.ToString(); up.Redirects = redirects;
                return up;
            }
        }

        static string ReadAll(HttpWebResponse resp, int limit)
        {
            using (Stream s = resp.GetResponseStream())
            using (MemoryStream ms = new MemoryStream())
            {
                byte[] buf = new byte[65536];
                int n;
                while ((n = s.Read(buf, 0, buf.Length)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (ms.Length > limit) throw new HttpError(502, "Upstream response exceeded " + limit + " bytes");
                }
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        // ------------------------------------------------------------------ server-side CORS probe
        static Dictionary<string, object> Probe(string url, string origin, string[] allow)
        {
            if (url == null || !url.StartsWith("https://")) throw new HttpError(400, "Body must contain an https \"url\"");
            DateTime t0 = DateTime.UtcNow;
            Dictionary<string, object> result = Obj("url", url, "requestedOrigin", origin, "redirects", 0, "headers", new Dictionary<string, object>());
            try
            {
                Upstream up = Open(url, "GET", null, "bytes=0-1", origin, origin + "/", allow, 5);
                try
                {
                    WebHeaderCollection h = up.Response.Headers;
                    result["status"] = up.Status;
                    result["ok"] = up.Status >= 200 && up.Status < 300;
                    result["finalUrl"] = up.FinalUrl;
                    result["redirects"] = up.Redirects;
                    result["headers"] = Obj(
                        "accessControlAllowOrigin", h["Access-Control-Allow-Origin"],
                        "accessControlAllowCredentials", h["Access-Control-Allow-Credentials"],
                        "accessControlExposeHeaders", h["Access-Control-Expose-Headers"],
                        "acceptRanges", h["Accept-Ranges"],
                        "contentType", h["Content-Type"],
                        "contentLength", h["Content-Length"],
                        "contentRange", h["Content-Range"],
                        "server", h["Server"]);
                }
                finally { up.Response.Close(); }
            }
            catch (Exception e) { result["status"] = 0; result["ok"] = false; result["error"] = e.Message; }
            result["elapsedMs"] = (int)(DateTime.UtcNow - t0).TotalMilliseconds;
            return result;
        }

        // ------------------------------------------------------------------ resolver
        static bool IsTikTok(Uri u) { return Regex.IsMatch(u.Host, @"(^|\.)tiktok\.com$", RegexOptions.IgnoreCase); }

        static Dictionary<string, object> Resolve(Dictionary<string, object> body, HttpRequest req)
        {
            string url = (Str(body, "url") ?? "").Trim();
            Uri input;
            if (!Uri.TryCreate(url, UriKind.Absolute, out input) || (input.Scheme != "http" && input.Scheme != "https")) throw new HttpError(400, "Body must contain an http(s) \"url\"");
            string origin = Str(body, "origin") ?? req.Headers["Origin"] ?? ("https://" + req.Url.Host);
            bool probe = !(Get(body, "probe") is bool) || (bool)Get(body, "probe");
            DateTime t0 = DateTime.UtcNow;

            if (!IsTikTok(input))
            {
                List<string> warnings = new List<string>();
                Dictionary<string, object> fmt = Obj("id", "origin", "label", "Original URL", "codec", "unknown", "directUrl", url, "directKind", "origin", "requiresCookies", false, "upstreamHost", input.Host);
                if (probe && input.Scheme == "https") fmt["serverProbe"] = Probe(url, origin, new string[] { "*" });
                if (input.Scheme == "https" && HostAllowed(input.Host, ProxyAllowedHosts))
                {
                    MediaRecord rec = Register(url, null, null, DateTime.UtcNow.AddHours(6), "mp4");
                    fmt["proxyUrl"] = "/api/media/" + rec.Id; fmt["mediaId"] = rec.Id;
                }
                else warnings.Add("Host " + input.Host + " is not in the proxy allowlist; proxy relay disabled for this URL");
                List<object> formats = new List<object>(); formats.Add(fmt);
                List<object> attempts = new List<object>(); attempts.Add(Obj("resolver", "passthrough", "ok", true, "elapsedMs", (int)(DateTime.UtcNow - t0).TotalMilliseconds));
                return Obj("source", "mp4", "resolver", "passthrough", "id", url, "inputUrl", url, "formats", formats, "warnings", warnings, "elapsedMs", (int)(DateTime.UtcNow - t0).TotalMilliseconds, "attempts", attempts);
            }

            List<object> att = new List<object>();
            try
            {
                Dictionary<string, object> r = ResolveTikTok(url, origin, probe);
                att.Add(Obj("resolver", "native", "ok", true, "elapsedMs", (int)(DateTime.UtcNow - t0).TotalMilliseconds));
                r["attempts"] = att;
                r["elapsedMs"] = (int)(DateTime.UtcNow - t0).TotalMilliseconds;
                return r;
            }
            catch (HttpError e)
            {
                att.Add(Obj("resolver", "native", "ok", false, "error", e.Message, "elapsedMs", (int)(DateTime.UtcNow - t0).TotalMilliseconds));
                throw new HttpError(e.Status >= 400 && e.Status < 500 ? e.Status : 502, e.Message);
            }
            catch (Exception e)
            {
                throw new HttpError(502, "native resolver failed: " + e.Message);
            }
        }

        static MediaRecord Register(string url, string referer, List<KeyValuePair<string, string>> cookies, DateTime expires, string source)
        {
            lock (Gate)
            {
                List<string> stale = new List<string>();
                foreach (MediaRecord r in Media.Values) if (r.ExpiresAt <= DateTime.UtcNow) stale.Add(r.Id);
                foreach (string id in stale) Media.Remove(id);
                foreach (MediaRecord r in Media.Values) if (r.Url == url) return r;
                MediaRecord rec = new MediaRecord();
                rec.Id = NewId(); rec.Url = url; rec.Referer = referer; rec.ExpiresAt = expires; rec.Source = source;
                if (cookies != null) rec.Cookies = cookies;
                Media[rec.Id] = rec;
                return rec;
            }
        }
        static string NewId()
        {
            byte[] b = new byte[9];
            new RNGCryptoServiceProvider().GetBytes(b);
            return Convert.ToBase64String(b).Replace('+', '-').Replace('/', '_').TrimEnd('=');
        }

        static Dictionary<string, object> ResolveTikTok(string inputUrl, string origin, bool probe)
        {
            Uri u = new Uri(inputUrl);
            string videoId = null;
            string pageUrl;
            Match m = Regex.Match(u.AbsolutePath, @"/(?:@[^/]+/)?(?:video|photo)/(\d{6,})");
            if (u.AbsolutePath.Contains("/photo/")) throw new HttpError(400, "Photo/slideshow posts are not supported");
            if (m.Success) { videoId = m.Groups[1].Value; pageUrl = "https://www.tiktok.com" + u.AbsolutePath; }
            else
            {
                Match e = Regex.Match(u.AbsolutePath, @"/(?:embed/(?:v2/)?|player/v1/)(\d{6,})");
                if (e.Success) { videoId = e.Groups[1].Value; pageUrl = "https://www.tiktok.com/@_/video/" + videoId; }
                else if (Regex.IsMatch(u.AbsolutePath, @"^/(t/)?[A-Za-z0-9]+/?$"))
                {
                    // short link: follow redirects to the canonical page
                    Upstream s = Open(u.ToString(), "GET", null, null, null, null, TikTokHosts, 5);
                    s.Response.Close();
                    Match c = Regex.Match(new Uri(s.FinalUrl).AbsolutePath, @"/(?:@[^/]+/)?video/(\d{6,})");
                    if (!c.Success) throw new HttpError(400, "Short link did not lead to a video page (" + s.FinalUrl + ")");
                    videoId = c.Groups[1].Value; pageUrl = "https://www.tiktok.com" + new Uri(s.FinalUrl).AbsolutePath;
                }
                else throw new HttpError(400, "Unrecognised TikTok URL path: " + u.AbsolutePath);
            }

            // Fetch the page with a cookie jar; TikTok sets tt_chain_token / ttwid / tt_csrf_token.
            CookieContainer jar = new CookieContainer();
            HttpWebRequest pr = (HttpWebRequest)WebRequest.Create(pageUrl);
            pr.Timeout = UpstreamTimeoutMs; pr.ReadWriteTimeout = UpstreamTimeoutMs; pr.CookieContainer = jar; pr.AllowAutoRedirect = true; pr.UserAgent = UserAgent;
            pr.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
            pr.Headers["Accept-Language"] = "en-US,en;q=0.9";
            string html; string finalUrl;
            try
            {
                using (HttpWebResponse presp = (HttpWebResponse)pr.GetResponse())
                {
                    if ((int)presp.StatusCode != 200) throw new HttpError(502, "TikTok page returned HTTP " + (int)presp.StatusCode);
                    finalUrl = presp.ResponseUri.ToString();
                    html = ReadAll(presp, 12 * 1024 * 1024);
                }
            }
            catch (WebException we) { throw new HttpError(502, "TikTok page request failed: " + we.Message); }

            Match jm = Regex.Match(html, "<script id=\"__UNIVERSAL_DATA_FOR_RE(?:HYDRATION|BOOTING)__\" type=\"application/json\">(.*?)</script>", RegexOptions.Singleline);
            if (!jm.Success) jm = Regex.Match(html, "<script id=\"SIGI_STATE\" type=\"application/json\">(.*?)</script>", RegexOptions.Singleline);
            if (!jm.Success)
            {
                Match tm = Regex.Match(html, "<title[^>]*>(.*?)</title>", RegexOptions.Singleline);
                throw new HttpError(502, "No embedded video JSON found in the TikTok page (title: " + (tm.Success ? tm.Groups[1].Value.Trim() : "n/a") + "). TikTok may have served a bot-check or changed its markup.");
            }
            // The whole page JSON exceeds the 1000-members-per-object cap that the MS11-100 security update
            // imposes on JavaScriptSerializer (the i18n table alone has thousands of keys), so only the
            // "webapp.video-detail" object (or legacy "ItemModule") is cut out and parsed.
            string rawJson = jm.Groups[1].Value;
            object item = null;
            string detailJson = ExtractObject(rawJson, "\"webapp.video-detail\"");
            if (detailJson != null)
            {
                object detail;
                try { detail = NewSerializer().DeserializeObject(detailJson); } catch (Exception e) { throw new HttpError(502, "webapp.video-detail JSON could not be parsed: " + e.Message); }
                int code = (int)Num(Get(detail, "statusCode"));
                if (code != 0) throw new HttpError(404, "TikTok reports status " + code + ": " + StatusMessage(code, Str(detail, "statusMsg")));
                item = Get(Get(detail, "itemInfo"), "itemStruct");
            }
            else
            {
                string moduleJson = ExtractObject(rawJson, "\"ItemModule\"");
                if (moduleJson == null) throw new HttpError(502, "Page JSON has no webapp.video-detail (login wall or unsupported post type?)");
                object im;
                try { im = NewSerializer().DeserializeObject(moduleJson); } catch (Exception e) { throw new HttpError(502, "ItemModule JSON could not be parsed: " + e.Message); }
                item = Get(im, videoId);
            }
            object video = Get(item, "video");
            if (video == null) throw new HttpError(502, "No video item in page JSON");

            List<KeyValuePair<string, string>> cookies = new List<KeyValuePair<string, string>>();
            foreach (Cookie c in jar.GetCookies(new Uri("https://www.tiktok.com/"))) cookies.Add(new KeyValuePair<string, string>(c.Name, c.Value));
            List<string> warnings = new List<string>();
            bool hasChain = false; foreach (KeyValuePair<string, string> c in cookies) if (c.Key == "tt_chain_token") hasChain = true;
            if (!hasChain) warnings.Add("tt_chain_token cookie was not set by TikTok; cookie-bound URLs may fail");

            List<Dictionary<string, object>> formats = new List<Dictionary<string, object>>();
            IList variants = Arr(Get(video, "bitrateInfo"));
            if (variants == null || variants.Count == 0)
            {
                string pa = Str(video, "playAddr");
                if (pa != null)
                {
                    Dictionary<string, object> fake = Obj("GearName", "playAddr", "CodecType", Str(video, "codecType"), "Bitrate", Get(video, "bitrate"), "PlayAddr", Obj("UrlList", new object[] { pa }));
                    variants = new object[] { fake };
                }
            }
            double vw = Num(Get(video, "width")), vh = Num(Get(video, "height"));
            if (variants != null)
            {
                foreach (object v in variants)
                {
                    IList urls = Arr(Get(Get(v, "PlayAddr"), "UrlList"));
                    if (urls == null || urls.Count == 0) continue;
                    string cookieBound = null, redirectUrl = null;
                    foreach (object o in urls) { string s = o.ToString(); if (s.Contains("/aweme/v1/play/")) { if (redirectUrl == null) redirectUrl = s; } else if (cookieBound == null) cookieBound = s; }
                    if (cookieBound == null) cookieBound = urls[0].ToString();
                    string gear = Str(v, "GearName") ?? "unknown";
                    string codecType = Str(v, "CodecType");
                    string codec = CodecFamily(codecType);
                    Match rm = Regex.Match(gear, @"(\d{3,4})");
                    double? h = rm.Success ? (double?)double.Parse(rm.Groups[1].Value, CultureInfo.InvariantCulture) : null;
                    double bitrate = Num(Get(v, "Bitrate"));
                    long? exp = ExpiryFromUrl(cookieBound);
                    MediaRecord rec = Register(cookieBound, finalUrl, cookies, exp.HasValue ? Epoch(exp.Value) : DateTime.UtcNow.AddHours(6), "tiktok");
                    Dictionary<string, object> fmt = Obj(
                        "id", gear,
                        "label", gear + " (" + (codecType ?? "codec?") + (bitrate > 0 ? ", " + Math.Round(bitrate / 1000) + " kbps" : "") + ")",
                        "codec", codec, "codecDetail", codecType,
                        "bitrate", bitrate > 0 ? (object)(long)bitrate : null,
                        "height", h.HasValue ? (object)(int)h.Value : null,
                        "width", (h.HasValue && vw > 0 && vh > 0) ? (object)(int)Math.Round(h.Value * vw / vh) : null,
                        "proxyUrl", "/api/media/" + rec.Id, "mediaId", rec.Id,
                        "cookieBoundUrl", cookieBound, "requiresCookies", true,
                        "expiresAt", exp.HasValue ? (object)exp.Value : null,
                        "upstreamHost", new Uri(cookieBound).Host);
                    if (redirectUrl != null)
                    {
                        fmt["directUrl"] = redirectUrl; fmt["directKind"] = "redirect"; fmt["redirectUrl"] = redirectUrl;
                        try
                        {
                            Upstream rr = Open(redirectUrl, "GET", null, "bytes=0-0", null, "https://www.tiktok.com/", TikTokHosts, 5);
                            rr.Response.Close();
                            if (rr.Status >= 200 && rr.Status < 400 && rr.FinalUrl != redirectUrl)
                            {
                                fmt["directUrl"] = rr.FinalUrl; fmt["directKind"] = "cdn";
                                long? e2 = ExpiryFromUrl(rr.FinalUrl); if (e2.HasValue) fmt["expiresAt"] = e2.Value;
                            }
                            else warnings.Add(gear + ": redirect URL answered HTTP " + rr.Status + "; browser will try the redirect itself");
                        }
                        catch (Exception e) { warnings.Add(gear + ": could not resolve redirect URL server-side: " + e.Message); }
                        if (probe) fmt["serverProbe"] = Probe((string)fmt["directUrl"], origin, TikTokHosts);
                    }
                    else warnings.Add(gear + ": no cookie-free URL in UrlList; only the proxy can deliver it");
                    formats.Add(fmt);
                }
            }
            if (formats.Count == 0) throw new HttpError(502, "No playable formats found in page JSON");
            formats.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                int ah = (string)a["codec"] == "h264" ? 0 : 1, bh = (string)b["codec"] == "h264" ? 0 : 1;
                if (ah != bh) return ah - bh;
                return Num(b["bitrate"]).CompareTo(Num(a["bitrate"]));
            });
            List<object> fl = new List<object>(); foreach (Dictionary<string, object> f in formats) fl.Add(f);

            object author = Get(item, "author");
            string authorName = author is string ? (string)author : (Str(author, "uniqueId") ?? Str(author, "nickname"));
            return Obj(
                "source", "tiktok", "resolver", "native",
                "id", Str(item, "id") ?? videoId, "inputUrl", inputUrl, "canonicalUrl", finalUrl,
                "title", Str(item, "desc"), "author", authorName,
                "duration", Get(video, "duration"), "width", Get(video, "width"), "height", Get(video, "height"), "cover", Str(video, "cover"),
                "formats", fl, "warnings", warnings, "elapsedMs", 0, "attempts", new List<object>());
        }

        /// Returns the JSON object literal that follows `"key":` in json (brace-balanced, string-aware), or null.
        static string ExtractObject(string json, string quotedKey)
        {
            int idx = json.IndexOf(quotedKey + ":", StringComparison.Ordinal);
            if (idx < 0) return null;
            int start = json.IndexOf('{', idx + quotedKey.Length);
            if (start < 0) return null;
            int depth = 0; bool inStr = false; bool esc = false;
            for (int i = start; i < json.Length; i++)
            {
                char c = json[i];
                if (inStr)
                {
                    if (esc) esc = false;
                    else if (c == '\\') esc = true;
                    else if (c == '"') inStr = false;
                    continue;
                }
                if (c == '"') inStr = true;
                else if (c == '{') depth++;
                else if (c == '}') { depth--; if (depth == 0) return json.Substring(start, i - start + 1); }
            }
            return null;
        }

        static string StatusMessage(int code, string fallback)
        {
            switch (code)
            {
                case 10204: return "Video not found (deleted or wrong id)";
                case 10216: return "Video is private";
                case 10222: return "Video is private (account is private)";
                case 10231: return "Video is region-restricted";
                case 10239: return "Video is age-restricted / requires login";
                default: return fallback ?? "unavailable";
            }
        }
        static string CodecFamily(string c)
        {
            c = (c ?? "").ToLowerInvariant();
            if (c.Contains("h264") || c.Contains("avc")) return "h264";
            if (c.Contains("h265") || c.Contains("hvc") || c.Contains("hevc") || c.Contains("bytevc1")) return "h265";
            if (c.Contains("av1")) return "av1";
            if (c.Contains("vp9")) return "vp9";
            return "unknown";
        }
        static long? ExpiryFromUrl(string url)
        {
            try
            {
                Uri u = new Uri(url);
                Match q = Regex.Match(u.Query, @"[?&](?:expire|x-expires)=(\d+)");
                if (q.Success) return long.Parse(q.Groups[1].Value, CultureInfo.InvariantCulture);
                string[] segs = u.AbsolutePath.Split('/');
                if (segs.Length > 2 && Regex.IsMatch(segs[2], "^[0-9a-f]{8}$"))
                {
                    long t = long.Parse(segs[2], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                    if (t > 1600000000 && t < 4000000000) return t;
                }
            }
            catch (Exception) { }
            return null;
        }
        static DateTime Epoch(long seconds) { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(seconds); }

        // ------------------------------------------------------------------ media proxy
        static readonly string[] ForwardHeaders = { "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control" };

        static void ProxyMedia(HttpContext ctx, string id)
        {
            HttpRequest req = ctx.Request; HttpResponse res = ctx.Response;
            MediaRecord rec;
            lock (Gate) { Media.TryGetValue(id, out rec); }
            if (rec == null || rec.ExpiresAt <= DateTime.UtcNow) throw new HttpError(404, "Unknown or expired media id. Resolve the video again.");
            bool isHead = req.HttpMethod == "HEAD";
            if (!isHead && req.HttpMethod != "GET") throw new HttpError(405, "GET or HEAD required");
            string range = isHead ? "bytes=0-0" : req.Headers["Range"];
            Upstream up = Open(rec.Url, "GET", rec, range, null, null, ProxyAllowedHosts, 5);
            HttpWebResponse ur = up.Response;
            try
            {
                lock (Gate) { rec.Requests++; }
                if (up.Status >= 400) throw new HttpError(up.Status == 403 || up.Status == 404 ? up.Status : 502, "Upstream responded " + up.Status);
                res.StatusCode = up.Status;
                res.BufferOutput = false;
                foreach (string h in ForwardHeaders)
                {
                    string v = ur.Headers[h];
                    if (v == null) continue;
                    if (h == "Content-Type") res.ContentType = v; else res.AppendHeader(h, v);
                }
                if (ur.Headers["Accept-Ranges"] == null) res.AppendHeader("Accept-Ranges", "bytes");
                res.AppendHeader("X-Proxy-Upstream-Host", new Uri(up.FinalUrl).Host);
                res.AppendHeader("X-Proxy-Upstream-Status", up.Status.ToString());
                res.AppendHeader("X-Proxy-Redirects", up.Redirects.ToString());
                if (isHead)
                {
                    // Upstream HEAD is refused by TikTok's CDN; translate "bytes 0-0/total" into Content-Length.
                    Match t = Regex.Match(ur.Headers["Content-Range"] ?? "", @"/(\d+)$");
                    res.StatusCode = 200;
                    res.ClearHeaders();
                    ApplyCors(req, res);
                    if (ur.Headers["Content-Type"] != null) res.ContentType = ur.Headers["Content-Type"];
                    if (t.Success) res.AppendHeader("Content-Length", t.Groups[1].Value);
                    res.AppendHeader("Accept-Ranges", "bytes");
                    return;
                }
                using (Stream s = ur.GetResponseStream())
                {
                    byte[] buf = new byte[65536];
                    int n; long total = 0;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        if (!res.IsClientConnected) break;
                        res.OutputStream.Write(buf, 0, n);
                        total += n;
                        if ((total & 0xFFFFF) < 65536) res.Flush();
                    }
                    lock (Gate) { rec.Bytes += total; }
                }
            }
            finally { ur.Close(); }
        }
    }
}
