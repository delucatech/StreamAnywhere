"""Probe: can the For You feed be fetched server-side (logged out) and what does the home page embed?"""
import json, re, sys, time, urllib.parse as up
import requests
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
s=requests.Session(); s.headers.update({"User-Agent":UA,"Accept-Language":"en-US,en;q=0.9"})
def page(url):
    r=s.get(url,headers={"Accept":"text/html"},timeout=30,allow_redirects=True)
    m=re.search(r'<script id="__UNIVERSAL_DATA_FOR_RE(?:BOOTING|HYDRATION)__" type="application/json">(.*?)</script>',r.text,re.S)
    j=json.loads(m.group(1)) if m else None
    keys=list(j.get("__DEFAULT_SCOPE__",{}).keys()) if j else []
    print(f"PAGE {url}: status={r.status_code} final={r.url} len={len(r.text)} cookies={sorted(s.cookies.keys())}")
    print("  scope keys:",keys)
    return j
for u in ["https://www.tiktok.com/","https://www.tiktok.com/foryou","https://www.tiktok.com/explore"]:
    j=page(u)
    if j:
        sc=j["__DEFAULT_SCOPE__"]
        for k,v in sc.items():
            if isinstance(v,dict):
                sub=list(v.keys())[:12]
                print(f"   {k}: {sub}")
                for kk,vv in v.items():
                    if isinstance(vv,list) and vv and isinstance(vv[0],dict) and "video" in vv[0]:
                        print(f"     -> {k}.{kk} has {len(vv)} items with video; first id={vv[0].get('id')} author={vv[0].get('author',{}).get('uniqueId') if isinstance(vv[0].get('author'),dict) else vv[0].get('author')}")
                        urls=vv[0]['video'].get('bitrateInfo',[{}])[0].get('PlayAddr',{}).get('UrlList',[])
                        print("        urls:",[x[:70] for x in urls])
# feed api without signing
params={"aid":"1988","app_language":"en","app_name":"tiktok_web","browser_language":"en-US","browser_name":"Mozilla","browser_online":"true","browser_platform":"Win32","browser_version":"5.0 (Windows)","channel":"tiktok_web","cookie_enabled":"true","count":"16","device_platform":"web_pc","from_page":"fyp","history_len":"1","is_fullscreen":"false","is_page_visible":"true","language":"en","os":"windows","priority_region":"","referer":"","region":"US","screen_height":"1080","screen_width":"1920","tz_name":"America/New_York","webcast_language":"en","itemID":"1","pullType":"1","isNonPersonalized":"false","vv_count_fyp":"0","watchLiveLastTime":"0","showAboutThisAd":"true","showAds":"true"}
for name,hdrs in [("feed api w/ page cookies",{"Referer":"https://www.tiktok.com/","Accept":"*/*"}),("feed api explore",None)]:
    url="https://www.tiktok.com/api/recommend/item_list/?"+up.urlencode(params)
    if name.endswith("explore"):
        p2=dict(params); p2.update({"categoryType":"120","from_page":"explore"}); url="https://www.tiktok.com/api/explore/item_list/?"+up.urlencode(p2)
    r=s.get(url,headers=hdrs or {"Referer":"https://www.tiktok.com/explore"},timeout=30)
    body=r.text
    try:
        j=r.json(); items=j.get("itemList") or []
        print(f"API {name}: status={r.status_code} statusCode={j.get('statusCode')} status_code={j.get('status_code')} items={len(items)} hasMore={j.get('hasMore')} cursor={j.get('cursor')} keys={list(j.keys())[:10]}")
        if items:
            it=items[0]; print("   first:",it.get("id"),it.get("author",{}).get("uniqueId"),it.get("desc","")[:60]); 
            urls=it['video'].get('bitrateInfo',[{}])[0].get('PlayAddr',{}).get('UrlList',[]); print("   urls:",[x[:80] for x in urls])
    except Exception as e:
        print(f"API {name}: status={r.status_code} non-json ({e}) body[:200]={body[:200]!r}")
