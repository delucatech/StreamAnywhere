import json, re, sys, time, random, string, urllib.parse as up
import requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
s=requests.Session(); s.headers.update({"User-Agent":UA,"Accept-Language":"en-US,en;q=0.9","Accept":"*/*","Referer":"https://www.tiktok.com/"})
s.get("https://www.tiktok.com/",headers={"Accept":"text/html"},timeout=30)
print("cookies:",sorted(s.cookies.keys()))
base={"aid":"1988","app_language":"en","app_name":"tiktok_web","browser_language":"en-US","browser_name":"Mozilla","browser_online":"true","browser_platform":"Win32","browser_version":"5.0 (Windows)","channel":"tiktok_web","cookie_enabled":"true","count":"16","device_platform":"web_pc","language":"en","os":"windows","region":"US","screen_height":"1080","screen_width":"1920","tz_name":"America/New_York","webcast_language":"en","device_id":str(random.randint(7000000000000000000,7999999999999999999))}
def call(name,url,params,headers=None,cookies=None):
    r=s.get(url+"?"+up.urlencode(params),headers=headers or {},cookies=cookies,timeout=30)
    try:
        j=r.json(); items=j.get("itemList") or []
        print(f"{name}: http={r.status_code} status_code={j.get('status_code')} statusCode={j.get('statusCode')} msg={j.get('status_msg')!r} items={len(items)} hasMore={j.get('hasMore')} cursor={j.get('cursor')} keys={list(j.keys())[:8]}")
        return j
    except Exception as e:
        print(f"{name}: http={r.status_code} non-json: {r.text[:150]!r}")
rec="https://www.tiktok.com/api/recommend/item_list/"
fyp=dict(base,from_page="fyp",itemID="1",pullType="1",isNonPersonalized="false",vv_count_fyp="0",history_len="1",is_fullscreen="false",is_page_visible="true",showAboutThisAd="true",showAds="true")
call("R1 fyp plain",rec,fyp)
ms="".join(random.choices(string.ascii_letters+string.digits+"-_",k=107))
call("R2 fyp + msToken param",rec,dict(fyp,msToken=ms))
call("R3 fyp + msToken + X-Bogus junk",rec,dict(fyp,msToken=ms,**{"X-Bogus":"DFSzswVLQD"+ms[:12]}))
call("R4 fyp + verifyFp",rec,dict(fyp,verifyFp="verify_"+"".join(random.choices("0123456789abcdef",k=8))+"_"+"".join(random.choices(string.ascii_letters+string.digits,k=16))))
call("R5 fyp count=6",rec,dict(fyp,count="6"))
call("R6 fyp minimal aid+count",rec,{"aid":"1988","count":"16"})
call("R7 fyp no cookies",rec,fyp,cookies={})
# explore pagination + url shapes
ex="https://www.tiktok.com/api/explore/item_list/"
exp=dict(base,from_page="explore",categoryType="120")
j=call("E1 explore cat120",ex,exp)
if j and j.get("itemList"):
    it=j["itemList"][0]; v=it["video"]
    print("  item keys:",list(it.keys())[:40])
    print("  video keys:",list(v.keys()))
    print("  playAddr:",v.get("playAddr","")[:90])
    for b in v.get("bitrateInfo",[]):
        ul=b["PlayAddr"]["UrlList"]; print("   gear",b.get("GearName"),b.get("CodecType"),b.get("Bitrate"),[u[:60] for u in ul])
    print("  author:",{k:it["author"].get(k) for k in ("id","uniqueId","nickname","avatarThumb")} if isinstance(it.get("author"),dict) else it.get("author"))
    print("  stats:",it.get("stats"),"music:",(it.get("music") or {}).get("title"))
    print("  cover:",v.get("cover","")[:80])
    ids1=[x["id"] for x in j["itemList"]]
    j2=call("E2 explore cursor=16",ex,dict(exp,cursor="16"))
    if j2 and j2.get("itemList"): print("  overlap with page1:",len(set(ids1)&{x["id"] for x in j2["itemList"]}))
    j3=call("E3 explore again cursor=0",ex,exp)
    if j3 and j3.get("itemList"): print("  overlap with page1:",len(set(ids1)&{x["id"] for x in j3["itemList"]}))
    j4=call("E4 explore cursor=32 count=30",ex,dict(exp,cursor="32",count="30"))
for cat in ["0","100","101","110","111","112","113","114","115","116","117","118","119","121","122","123","124","125","126","127","128","129","130","131","132","133","134","135","136","137","138","139","140"]:
    j=call(f"E cat{cat}",ex,dict(exp,categoryType=cat))
# QR login
q=s.get("https://www.tiktok.com/passport/web/get_qrcode/?"+up.urlencode({"aid":"1988","language":"en","next":"https://www.tiktok.com/","service":"https://www.tiktok.com"}),timeout=30)
print("QR get:",q.status_code,q.text[:400].replace("\n"," "))
try:
    qj=q.json(); tok=qj.get("data",{}).get("token")
    if tok:
        c=s.get("https://www.tiktok.com/passport/web/check_qrconnect/?"+up.urlencode({"aid":"1988","language":"en","token":tok,"next":"https://www.tiktok.com/","service":"https://www.tiktok.com"}),timeout=30)
        print("QR check:",c.status_code,c.text[:300])
except Exception as e: print("qr err",e)
a=s.get("https://www.tiktok.com/passport/web/account/info/?aid=1988",timeout=30)
print("account info (logged out):",a.status_code,a.text[:200])
