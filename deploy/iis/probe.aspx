<%@ Page Language="C#" Trace="false" Debug="false" EnableViewState="false" %>
<%@ Import Namespace="System.Net" %>
<%@ Import Namespace="System.IO" %>
<%@ Import Namespace="System.Text" %>
<%@ Import Namespace="System.Reflection" %>
<%@ Import Namespace="System.Text.RegularExpressions" %>
<script runat="server">
    // StreamAnywhere hosting probe (v2: compiles on .NET 2.0/3.5 and 4.x). Upload to /player/probe.aspx,
    // open it once in a browser, then DELETE it. Reports only what the port needs.
    private StringBuilder sb = new StringBuilder();
    private const string UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

    private void L(string k, object v) { sb.Append(k).Append(": ").Append(v == null ? "(null)" : v.ToString()).Append("\n"); }

    private object Prop(object target, Type type, string name) {
        try {
            PropertyInfo p = type.GetProperty(name, BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
            return p == null ? "(not in this runtime)" : p.GetValue(target, null);
        } catch (Exception ex) { return "error: " + ex.GetType().Name; }
    }

    protected void Page_Load(object sender, EventArgs e) {
        Response.ContentType = "text/plain; charset=utf-8";
        Response.Cache.SetCacheability(HttpCacheability.NoCache);
        try { Run(); } catch (Exception ex) { L("probe.fatal", ex.ToString()); }
        Response.Write(sb.ToString());
    }

    private void Run() {
        L("probe.version", "2026-10-08 v2");
        L("utc.now", DateTime.UtcNow.ToString("o"));
        L("os.version", Environment.OSVersion.VersionString);
        L("clr.version", Environment.Version);
        L("os.64bit", Prop(null, typeof(Environment), "Is64BitOperatingSystem"));
        L("iis.version", Prop(null, typeof(HttpRuntime), "IISVersion"));
        L("aspnet.integrated", Prop(null, typeof(HttpRuntime), "UsingIntegratedPipeline"));
        L("trust.full", Prop(AppDomain.CurrentDomain, typeof(AppDomain), "IsFullyTrusted"));
        L("server.software", Request.ServerVariables["SERVER_SOFTWARE"]);
        L("app.virtualpath", HttpRuntime.AppDomainAppVirtualPath);
        L("app.physicalpath", HttpRuntime.AppDomainAppPath);
        L("page.path", Request.Path);
        L("page.pathinfo", Request.PathInfo);
        L("request.https", Request.IsSecureConnection);
        L("request.host", Request.Url.Host);
        L("request.protocol", Request.ServerVariables["SERVER_PROTOCOL"]);
        L("client.ip", Request.UserHostAddress);
        L("x-forwarded-for", Request.Headers["X-Forwarded-For"]);
        L("response.bufferOutputDefault", Response.BufferOutput);

        try {
            Type rk = Type.GetType("Microsoft.Win32.Registry");
            object lm = rk.GetField("LocalMachine").GetValue(null);
            object key = lm.GetType().GetMethod("OpenSubKey", new Type[] { typeof(string) }).Invoke(lm, new object[] { "SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full\\" });
            object rel = key == null ? null : key.GetType().GetMethod("GetValue", new Type[] { typeof(string) }).Invoke(key, new object[] { "Release" });
            L("netfx.release", rel);
            int r = rel == null ? 0 : Convert.ToInt32(rel);
            L("netfx.installed", r >= 528040 ? "4.8+" : r >= 461808 ? "4.7.2" : r >= 460798 ? "4.7" : r >= 394802 ? "4.6.2" : r >= 393295 ? "4.6" : r >= 379893 ? "4.5.2" : r >= 378389 ? "4.5" : "none/unknown");
        } catch (Exception ex) { L("netfx.release", "unavailable: " + ex.GetType().Name); }

        try {
            // Tls12 = 3072, Tls13 = 12288 (enum values may not exist on old runtimes; cast is fine)
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)(3072 | 12288) | ServicePointManager.SecurityProtocol;
            L("tls.protocols", ServicePointManager.SecurityProtocol);
        } catch (Exception ex) {
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; L("tls.protocols", "Tls12 only (" + ex.GetType().Name + ")"); }
            catch (Exception ex2) { L("tls.protocols", "could not set: " + ex2.Message); }
        }

        try {
            HttpWebRequest r1 = (HttpWebRequest)WebRequest.Create("https://api.ipify.org/?format=text");
            r1.Timeout = 15000; r1.UserAgent = "StreamAnywhere-probe";
            using (HttpWebResponse s1 = (HttpWebResponse)r1.GetResponse())
            using (StreamReader rd = new StreamReader(s1.GetResponseStream())) L("egress.ip", rd.ReadToEnd().Trim());
        } catch (Exception ex) { L("egress.ip", "failed: " + ex.Message); }

        string awemeUrl = null;
        try {
            CookieContainer jar = new CookieContainer();
            HttpWebRequest r2 = (HttpWebRequest)WebRequest.Create("https://www.tiktok.com/@tiktok/video/7693184538704416031");
            r2.Timeout = 30000; r2.CookieContainer = jar; r2.AllowAutoRedirect = true; r2.UserAgent = UA;
            r2.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
            r2.Headers["Accept-Language"] = "en-US,en;q=0.9";
            string html;
            using (HttpWebResponse s2 = (HttpWebResponse)r2.GetResponse()) {
                L("tiktok.page.status", (int)s2.StatusCode);
                L("tiktok.page.finalUrl", s2.ResponseUri);
                using (StreamReader rd = new StreamReader(s2.GetResponseStream(), Encoding.UTF8)) html = rd.ReadToEnd();
            }
            L("tiktok.page.bytes", html.Length);
            Match t = Regex.Match(html, "<title[^>]*>(.*?)</title>", RegexOptions.Singleline);
            L("tiktok.page.title", t.Success ? t.Groups[1].Value.Trim() : "(none)");
            L("tiktok.page.hasRehydrationJson", html.Contains("__UNIVERSAL_DATA_FOR_REHYDRATION__") || html.Contains("__UNIVERSAL_DATA_FOR_REBOOTING__"));
            L("tiktok.page.hasPlayAddr", html.Contains("playAddr"));
            string ck = jar.GetCookieHeader(new Uri("https://www.tiktok.com/"));
            L("tiktok.page.cookies", ck.Length > 0 ? Regex.Replace(ck, "=[^;]*", "=...") : "(none)");
            int i = html.IndexOf("https://www.tiktok.com/aweme/v1/play/");
            if (i >= 0) {
                int j = html.IndexOf('"', i);
                awemeUrl = html.Substring(i, j - i).Replace("\\u0026", "&").Replace("&amp;", "&");
            }
            L("tiktok.page.hasAwemePlayUrl", awemeUrl != null);
        } catch (WebException ex) {
            HttpWebResponse er = ex.Response as HttpWebResponse;
            L("tiktok.page.status", er == null ? "error: " + ex.Message : ((int)er.StatusCode).ToString() + " " + ex.Message);
        } catch (Exception ex) { L("tiktok.page.status", "error: " + ex.Message); }

        if (awemeUrl != null) {
            try {
                HttpWebRequest r3 = (HttpWebRequest)WebRequest.Create(awemeUrl);
                r3.Timeout = 30000; r3.AllowAutoRedirect = true; r3.AddRange(0, 15); r3.UserAgent = UA;
                r3.Headers["Origin"] = "https://delucatech.com";
                using (HttpWebResponse s3 = (HttpWebResponse)r3.GetResponse()) {
                    L("tiktok.cdn.status", (int)s3.StatusCode);
                    L("tiktok.cdn.host", s3.ResponseUri.Host);
                    L("tiktok.cdn.contentType", s3.ContentType);
                    L("tiktok.cdn.contentRange", s3.Headers["Content-Range"]);
                    L("tiktok.cdn.acao", s3.Headers["Access-Control-Allow-Origin"]);
                    byte[] buf = new byte[16]; int n = s3.GetResponseStream().Read(buf, 0, 16);
                    L("tiktok.cdn.firstBytes", BitConverter.ToString(buf, 0, n));
                }
            } catch (WebException ex) {
                HttpWebResponse er = ex.Response as HttpWebResponse;
                L("tiktok.cdn.status", er == null ? "error: " + ex.Message : ((int)er.StatusCode).ToString() + " " + ex.Message);
            } catch (Exception ex) { L("tiktok.cdn.status", "error: " + ex.Message); }
        }
    }
</script>
