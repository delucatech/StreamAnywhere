import json, re, sys, urllib.request, urllib.error, http.cookiejar, urllib.parse as up, time
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
URL=sys.argv[1]
jar=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
html=op.open(urllib.request.Request(URL,headers={"User-Agent":UA,"Accept":"text/html"}),timeout=30).read().decode("utf-8","ignore")
m=re.search(r'<script id="__UNIVERSAL_DATA_FOR_RE(?:BOOTING|HYDRATION)__" type="application/json">(.*?)</script>',html,re.S)
v=json.loads(m.group(1))["__DEFAULT_SCOPE__"]["webapp.video-detail"]["itemInfo"]["itemStruct"]["video"]
aweme=v["bitrateInfo"][0]["PlayAddr"]["UrlList"][-1]
print("aweme url:",aweme[:120])
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None
nr=urllib.request.build_opener(NoRedirect)
def get(opener,url,headers,method="GET"):
    h={"User-Agent":UA,"Accept":"*/*"}; h.update(headers)
    try:
        r=opener.open(urllib.request.Request(url,headers=h,method=method),timeout=25); return r.status,r.geturl(),dict(r.headers),r.read(16)
    except urllib.error.HTTPError as e: return e.code,e.headers.get("Location",""),dict(e.headers),e.read(16)
    except Exception as e: return -1,repr(e),{},b""
st,loc,hd,body=get(nr,aweme,{"Origin":"http://localhost:5173"})
print(f"K1: aweme 302 (no cookies, Origin): status={st} location={loc[:100]} acao={hd.get('Access-Control-Allow-Origin')} acac={hd.get('Access-Control-Allow-Credentials')} vary={hd.get('Vary')} setcookie={'Set-Cookie' in hd}")
st,loc,hd,body=get(nr,aweme,{"Origin":"http://localhost:5173","Access-Control-Request-Method":"GET"},"OPTIONS")
print(f"K2: aweme OPTIONS preflight: status={st} acao={hd.get('Access-Control-Allow-Origin')} acam={hd.get('Access-Control-Allow-Methods')}")
final=loc if loc.startswith("http") else None
if not final:
    st,final,hd,body=get(urllib.request.build_opener(),aweme,{})
print("final:",final[:140])
plain=urllib.request.build_opener()
for name,h,method in [
  ("L1: final, no headers",{}, "GET"),
  ("L2: final + Origin localhost",{"Origin":"http://localhost:5173"},"GET"),
  ("L3: final + Origin + Range 0-1023",{"Origin":"http://localhost:5173","Range":"bytes=0-1023"},"GET"),
  ("L4: final OPTIONS preflight w/ range",{"Origin":"http://localhost:5173","Access-Control-Request-Method":"GET","Access-Control-Request-Headers":"range"},"OPTIONS"),
  ("L5: final HEAD",{},"HEAD"),
  ("L6: final, different UA",{"User-Agent":"curl/8.0"},"GET"),
  ("L7: final + Referer localhost",{"Referer":"http://localhost:5173/"},"GET"),
]:
    st,loc,hd,body=get(plain,final,h,method)
    keep={k:v for k,v in hd.items() if k.lower().startswith("access-control") or k.lower() in ("content-type","content-length","content-range","accept-ranges","cache-control","server","vary")}
    print(f"{name}: status={st} {json.dumps(keep)} body={body[:8].hex()}")
p=up.urlparse(final).path.split("/")
print("final host:",up.urlparse(final).netloc," path segs:",p[1:3], " seg2 as hex ts:", int(p[2],16) if len(p)>2 and re.fullmatch(r'[0-9a-f]+',p[2]) else None, "now:",int(time.time()))
# also: do the other bitrate variants have aweme URLs? 
for b in v["bitrateInfo"]:
    print("gear",b["GearName"],b["CodecType"],b["Bitrate"],"aweme?",any("aweme/v1/play" in u for u in b["PlayAddr"]["UrlList"]))
