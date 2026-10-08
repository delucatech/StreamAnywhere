import json, re, sys, urllib.request, urllib.error, http.cookiejar
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
URL=sys.argv[1]
def session():
    jar=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    html=op.open(urllib.request.Request(URL,headers={"User-Agent":UA,"Accept":"text/html"}),timeout=30).read().decode("utf-8","ignore")
    m=re.search(r'<script id="__UNIVERSAL_DATA_FOR_RE(?:BOOTING|HYDRATION)__" type="application/json">(.*?)</script>',html,re.S)
    v=json.loads(m.group(1))["__DEFAULT_SCOPE__"]["webapp.video-detail"]["itemInfo"]["itemStruct"]["video"]
    return jar,op,v
def get(op,url,headers,method="GET"):
    h={"User-Agent":UA,"Accept":"*/*"}; h.update(headers)
    try:
        r=op.open(urllib.request.Request(url,headers=h,method=method),timeout=25); body=r.read(16); return r.status,r.geturl()[:90],dict(r.headers),body
    except urllib.error.HTTPError as e: return e.code,"",dict(e.headers),e.read(16)
    except Exception as e: return -1,repr(e),{},b""
j1,op1,v1=session(); j2,op2,v2=session()
c1={c.name:c.value for c in j1}; c2={c.name:c.value for c in j2}
print("session1 tt_chain_token:",c1.get("tt_chain_token","")[:12],"...  session2:",c2.get("tt_chain_token","")[:12])
print("playAddr identical across sessions?", v1["playAddr"]==v2["playAddr"])
import urllib.parse as up
q1=up.parse_qs(up.urlparse(v1["playAddr"]).query); q2=up.parse_qs(up.urlparse(v2["playAddr"]).query)
print("differing params:",[k for k in q1 if q1.get(k)!=q2.get(k)])
tests=[
 ("J1: s1 URL + s1 cookies, no Referer", op1, v1["playAddr"], {}),
 ("J2: s1 URL + s1 cookies + Referer", op1, v1["playAddr"], {"Referer":"https://www.tiktok.com/"}),
 ("J3: s1 URL + s2 cookies + Referer (cross-session)", op2, v1["playAddr"], {"Referer":"https://www.tiktok.com/"}),
 ("J4: s1 URL + only tt_chain_token header, no jar", urllib.request.build_opener(), v1["playAddr"], {"Cookie":"tt_chain_token="+c1.get("tt_chain_token","")}),
 ("J5: HEAD s1 URL + s1 cookies", op1, v1["playAddr"], {}),
 ("J6: aweme/v1/play URL (3rd in UrlList) + s1 cookies", op1, v1["bitrateInfo"][0]["PlayAddr"]["UrlList"][-1], {"Referer":"https://www.tiktok.com/"}),
 ("J7: aweme/v1/play URL, no cookies", urllib.request.build_opener(), v1["bitrateInfo"][0]["PlayAddr"]["UrlList"][-1], {}),
]
for name,op,url,h in tests:
    st,final,hd,body=get(op,url,h,"HEAD" if name.startswith("J5") else "GET")
    print(f"{name}: status={st} final={final} ct={hd.get('Content-Type')} len={hd.get('Content-Length')} acao={hd.get('Access-Control-Allow-Origin')} body={body[:8].hex()}")
print("expire param:",q1.get("expire"), " now:", __import__('time').time())
