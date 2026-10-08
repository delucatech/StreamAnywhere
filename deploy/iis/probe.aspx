<%@ Page Language="C#" Trace="false" Debug="false" EnableViewState="false" %>
<%@ Import Namespace="System.Net" %>
<%@ Import Namespace="System.IO" %>
<%@ Import Namespace="System.Text" %>
<%@ Import Namespace="System.Text.RegularExpressions" %>
<%@ Import Namespace="System.Security" %>
<%@ Import Namespace="System.Security.Permissions" %>
<%
    // StreamAnywhere hosting probe. Upload to /player/probe.aspx, open it once in a browser,
    // then DELETE it. It reports only what the port needs and makes a few outbound test requests.
    Response.ContentType = "text/plain; charset=utf-8";
    Response.Cache.SetCacheability(HttpCacheability.NoCache);
    StringBuilder sb = new StringBuilder();
    Action<string, object> line = delegate(string k, object v) { sb.Append(k).Append(": ").Append(v == null ? "(null)" : v.ToString()).Append("\n"); };

    line("probe.version", "2026-10-08");
    line("utc.now", DateTime.UtcNow.ToString("o"));
    line("os.version", Environment.OSVersion.VersionString);
    line("os.64bit", Environment.Is64BitOperatingSystem);
    line("clr.version", Environment.Version);
    line("iis.version", HttpRuntime.IISVersion);
    line("server.software", Request.ServerVariables["SERVER_SOFTWARE"]);
    line("aspnet.integrated", HttpRuntime.UsingIntegratedPipeline);
    line("app.virtualpath", HttpRuntime.AppDomainAppVirtualPath);
    line("app.physicalpath", HttpRuntime.AppDomainAppPath);
    line("page.path", Request.Path);
    line("page.pathinfo", Request.PathInfo);
    line("page.appRelative", Request.AppRelativeCurrentExecutionFilePath);
    line("request.https", Request.IsSecureConnection);
    line("request.host", Request.Url.Host);
    line("request.protocol", Request.ServerVariables["SERVER_PROTOCOL"]);
    line("client.ip", Request.UserHostAddress);
    line("x-forwarded-for", Request.Headers["X-Forwarded-For"]);
    line("trust.full", AppDomain.CurrentDomain.IsFullyTrusted);
    try { new FileIOPermission(PermissionState.Unrestricted).Demand(); line("perm.fileio.unrestricted", true); } catch (Exception ex) { line("perm.fileio.unrestricted", "no: " + ex.GetType().Name); }
    try { new WebPermission(PermissionState.Unrestricted).Demand(); line("perm.web.unrestricted", true); } catch (Exception ex) { line("perm.web.unrestricted", "no: " + ex.GetType().Name); }

    // .NET Framework release key (may be blocked on shared hosting)
    try {
        using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry32).OpenSubKey("SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full\\")) {
            object rel = k == null ? null : k.GetValue("Release");
            line("netfx.release", rel);
            int r = rel == null ? 0 : Convert.ToInt32(rel);
            line("netfx.version", r >= 528040 ? "4.8+" : r >= 461808 ? "4.7.2" : r >= 460798 ? "4.7" : r >= 394802 ? "4.6.2" : r >= 393295 ? "4.6" : r >= 379893 ? "4.5.2" : r >= 378389 ? "4.5" : "unknown");
        }
    } catch (Exception ex) { line("netfx.release", "unavailable: " + ex.GetType().Name); }

    // Security protocols: enable TLS 1.2/1.3 explicitly (older defaults omit them)
    try {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288 | ServicePointManager.SecurityProtocol;
        line("tls.protocols", ServicePointManager.SecurityProtocol);
    } catch (Exception ex) { line("tls.protocols", "could not set: " + ex.Message); }

    // Outbound test 1: egress IP (what TikTok sees)
    try {
        HttpWebRequest r1 = (HttpWebRequest)WebRequest.Create("https://api.ipify.org/?format=text");
        r1.Timeout = 15000; r1.UserAgent = "StreamAnywhere-probe";
        using (HttpWebResponse s1 = (HttpWebResponse)r1.GetResponse()) using (StreamReader rd = new StreamReader(s1.GetResponseStream())) line("egress.ip", rd.ReadToEnd().Trim());
    } catch (Exception ex) { line("egress.ip", "failed: " + ex.Message); }

    // Outbound test 2: does TikTok serve this host the real video page?
    string videoUrl = "https://www.tiktok.com/@tiktok/video/7693184538704416031";
    string awemeUrl = null;
    try {
        CookieContainer jar = new CookieContainer();
        HttpWebRequest r2 = (HttpWebRequest)WebRequest.Create(videoUrl);
        r2.Timeout = 30000; r2.CookieContainer = jar; r2.AllowAutoRedirect = true;
        r2.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
        r2.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        r2.Headers["Accept-Language"] = "en-US,en;q=0.9";
        string html;
        using (HttpWebResponse s2 = (HttpWebResponse)r2.GetResponse()) {
            line("tiktok.page.status", (int)s2.StatusCode);
            line("tiktok.page.finalUrl", s2.ResponseUri);
            using (StreamReader rd = new StreamReader(s2.GetResponseStream(), Encoding.UTF8)) html = rd.ReadToEnd();
        }
        line("tiktok.page.bytes", html.Length);
        Match t = Regex.Match(html, "<title[^>]*>(.*?)</title>", RegexOptions.Singleline);
        line("tiktok.page.title", t.Success ? t.Groups[1].Value.Trim() : "(none)");
        line("tiktok.page.hasRehydrationJson", html.Contains("__UNIVERSAL_DATA_FOR_REHYDRATION__") || html.Contains("__UNIVERSAL_DATA_FOR_REBOOTING__"));
        line("tiktok.page.hasPlayAddr", html.Contains("playAddr"));
        line("tiktok.page.cookies", jar.GetCookieHeader(new Uri("https://www.tiktok.com/")).Length > 0 ? Regex.Replace(jar.GetCookieHeader(new Uri("https://www.tiktok.com/")), "=[^;]*", "=…") : "(none)");
        Match a = Regex.Match(html, "https:\\\\?/\\\\?/www\\.tiktok\\.com\\\\?/aweme\\\\?/v1\\\\?/play\\\\?/\\?[^\"]*");
        if (a.Success) awemeUrl = a.Value.Replace("\\/", "/").Replace("\\u0026", "&").Replace("&amp;", "&");
        line("tiktok.page.hasAwemePlayUrl", a.Success);
    } catch (WebException ex) {
        HttpWebResponse er = ex.Response as HttpWebResponse;
        line("tiktok.page.status", er == null ? "error: " + ex.Message : ((int)er.StatusCode).ToString() + " " + ex.Message);
    } catch (Exception ex) { line("tiktok.page.status", "error: " + ex.Message); }

    // Outbound test 3: cookie-free redirect URL -> CDN with Range (what the proxy would relay)
    if (awemeUrl != null) {
        try {
            HttpWebRequest r3 = (HttpWebRequest)WebRequest.Create(awemeUrl);
            r3.Timeout = 30000; r3.AllowAutoRedirect = true; r3.AddRange(0, 15);
            r3.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
            r3.Headers["Origin"] = "https://delucatech.com";
            using (HttpWebResponse s3 = (HttpWebResponse)r3.GetResponse()) {
                line("tiktok.cdn.status", (int)s3.StatusCode);
                line("tiktok.cdn.host", s3.ResponseUri.Host);
                line("tiktok.cdn.contentType", s3.ContentType);
                line("tiktok.cdn.contentRange", s3.Headers["Content-Range"]);
                line("tiktok.cdn.acao", s3.Headers["Access-Control-Allow-Origin"]);
                byte[] buf = new byte[16]; int n = s3.GetResponseStream().Read(buf, 0, 16);
                line("tiktok.cdn.firstBytes", BitConverter.ToString(buf, 0, n));
            }
        } catch (WebException ex) {
            HttpWebResponse er = ex.Response as HttpWebResponse;
            line("tiktok.cdn.status", er == null ? "error: " + ex.Message : ((int)er.StatusCode).ToString() + " " + ex.Message);
        } catch (Exception ex) { line("tiktok.cdn.status", "error: " + ex.Message); }
    }

    // Streaming check: can we flush without buffering the whole response?
    line("response.bufferOutputDefault", Response.BufferOutput);

    Response.Write(sb.ToString());
%>
