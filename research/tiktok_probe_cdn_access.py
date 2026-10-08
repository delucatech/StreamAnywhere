import json, re, sys, urllib.request, urllib.error, http.cookiejar, gzip, io, time

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
OUT = sys.argv[1]
CANDIDATES = sys.argv[2:]

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(url, headers=None, method="GET", timeout=25, allow_body=True):
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
    if headers: h.update(headers)
    r = urllib.request.Request(url, headers=h, method=method)
    try:
        resp = opener.open(r, timeout=timeout)
        body = resp.read(1024 * 64) if allow_body else b""
        if resp.headers.get("Content-Encoding") == "gzip":
            try: body = gzip.GzipFile(fileobj=io.BytesIO(body)).read()
            except Exception: pass
        return resp.status, dict(resp.headers), body
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(4096)
    except Exception as e:
        return -1, {"error": repr(e)}, b""

def find_video_id():
    for c in CANDIDATES:
        if "/video/" in c:
            return c
    # discover from a profile page
    st, hd, body = req("https://www.tiktok.com/@tiktok", {"Accept": "text/html"})
    m = re.findall(r'/@tiktok/video/(\d+)', body.decode("utf-8", "ignore"))
    if m: return f"https://www.tiktok.com/@tiktok/video/{m[0]}"
    return None

results = {"steps": []}
url = find_video_id()
results["video_url"] = url
if not url:
    results["error"] = "no video url discovered"
    json.dump(results, open(OUT, "w"), indent=2); sys.exit(1)

# full page fetch (need whole body for JSON)
h = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9"}
r = urllib.request.Request(url, headers=h)
resp = opener.open(r, timeout=30)
html = resp.read().decode("utf-8", "ignore")
results["page_status"] = resp.status
results["page_final_url"] = resp.geturl()
results["page_set_cookie_names"] = [c.name for c in jar]
m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_RE(?:BOOTING|HYDRATION)__" type="application/json">(.*?)</script>', html, re.S)
results["has_universal_data"] = bool(m)
play_addr = None
if m:
    data = json.loads(m.group(1))
    scope = data.get("__DEFAULT_SCOPE__", {})
    results["scope_keys"] = list(scope.keys())
    vd = scope.get("webapp.video-detail", {})
    results["video_detail_status"] = vd.get("statusCode"), vd.get("statusMsg")
    item = vd.get("itemInfo", {}).get("itemStruct", {})
    video = item.get("video", {})
    keep = {k: video.get(k) for k in ["width","height","duration","ratio","format","codecType","bitrate","playAddr","downloadAddr","definition","encodedType","videoQuality","cover"]}
    keep["bitrateInfo"] = [{k: b.get(k) for k in ["Bitrate","CodecType","GearName","QualityType"]} | {"UrlList": (b.get("PlayAddr") or {}).get("UrlList")} for b in video.get("bitrateInfo", [])]
    keep["desc"] = item.get("desc"); keep["id"] = item.get("id"); keep["author"] = item.get("author", {}).get("uniqueId")
    results["item"] = keep
    play_addr = video.get("playAddr")
results["play_addr"] = play_addr
if not play_addr:
    json.dump(results, open(OUT, "w"), indent=2, default=str); sys.exit(0)

def record(name, **kw):
    st, hd, body = req(play_addr, **kw)
    cors = {k: v for k, v in hd.items() if k.lower().startswith("access-control") or k.lower() in ("content-type","content-length","content-range","accept-ranges","cache-control","vary","set-cookie","x-tt-logid","server","content-disposition")}
    results["steps"].append({"test": name, "status": st, "headers": cors, "body_prefix_hex": body[:12].hex(), "body_len_read": len(body)})

origin = {"Origin": "http://localhost:5173"}
referer = {"Referer": "https://www.tiktok.com/"}
record("A: GET no cookies/referer (fresh opener)", allow_body=True)
# separate no-cookie opener
nocookie = urllib.request.build_opener()
def req_nocookie(headers):
    h = {"User-Agent": UA, "Accept": "*/*"}; h.update(headers)
    try:
        resp = nocookie.open(urllib.request.Request(play_addr, headers=h), timeout=25)
        body = resp.read(64); return resp.status, dict(resp.headers), body
    except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read(2048)
    except Exception as e: return -1, {"error": repr(e)}, b""
for name, hh in [("B: no cookies, no referer", {}), ("C: no cookies + Referer", referer), ("D: no cookies + Referer + Origin", {**referer, **origin}), ("E: no cookies + Range 0-1023", {"Range": "bytes=0-1023"})]:
    st, hd, body = req_nocookie(hh)
    cors = {k: v for k, v in hd.items() if k.lower().startswith("access-control") or k.lower() in ("content-type","content-length","content-range","accept-ranges","cache-control","vary","server")}
    results["steps"].append({"test": name, "status": st, "headers": cors, "body_prefix_hex": body[:12].hex(), "body_len_read": len(body)})
record("F: with page cookies + Referer + Origin", headers={**referer, **origin})
record("G: with page cookies + Referer + Range", headers={**referer, "Range": "bytes=0-1023"})
# CORS preflight
st, hd, body = req_nocookie({"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range"})
results["steps"].append({"test": "H: OPTIONS-like probe (GET with ACRM headers)", "status": st, "headers": {k: v for k, v in hd.items() if k.lower().startswith("access-control")}})
try:
    resp = nocookie.open(urllib.request.Request(play_addr, headers={"User-Agent": UA, "Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"}, method="OPTIONS"), timeout=25)
    results["steps"].append({"test": "I: real OPTIONS preflight", "status": resp.status, "headers": {k: v for k, v in dict(resp.headers).items() if k.lower().startswith("access-control") or k.lower()=="allow"}})
except urllib.error.HTTPError as e:
    results["steps"].append({"test": "I: real OPTIONS preflight", "status": e.code, "headers": {k: v for k, v in dict(e.headers).items() if k.lower().startswith("access-control") or k.lower()=="allow"}})
except Exception as e:
    results["steps"].append({"test": "I: real OPTIONS preflight", "status": -1, "error": repr(e)})
# URL params analysis
from urllib.parse import urlparse, parse_qs
u = urlparse(play_addr)
results["play_addr_host"] = u.netloc
results["play_addr_params"] = {k: (v[0][:40] + "..." if len(v[0]) > 40 else v[0]) for k, v in parse_qs(u.query).items()}
json.dump(results, open(OUT, "w"), indent=2, default=str)
print(json.dumps(results, indent=2, default=str)[:12000])
