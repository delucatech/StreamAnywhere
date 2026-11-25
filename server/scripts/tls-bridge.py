#!/usr/bin/env python3
"""HTTPS requests that open their connection the way Chrome does, kept warm for the server
(server/src/tlsBridge.ts).

TikTok's web API answers some paths (comments among them) with an empty body when the TLS handshake
is Node's; curl_cffi imitates Chrome's. This is a line-oriented helper like ytdlp-daemon.py:

  first line out:  {"id": 0, "ok": true, "version": "<curl_cffi version>"}   (or ok: false + error)
  each line in:    {"id": N, "method": "GET", "url": "...", "headers": {...}, "body": "..."|null, "timeout": 20}
  each line out:   {"id": N, "ok": true, "status": 200, "headers": {...}, "cookies": ["raw Set-Cookie", ...], "body": "<base64>"}
                   {"id": N, "ok": false, "error": "..."}

One connection pool for the life of the process (no handshake per request). Cookies are the
caller's business: the pool's own jar is emptied after every request, and redirects are not followed
so that the caller sees every hop's Set-Cookie.

    python -m pip install curl_cffi
"""
import base64
import json
import sys

DROP_REQUEST = {"host", "content-length", "connection", "accept-encoding"}
DROP_RESPONSE = {"set-cookie", "content-encoding", "transfer-encoding", "connection"}


def out(obj) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        import curl_cffi
        from curl_cffi import requests
    except Exception as exc:  # noqa: BLE001 - the server reads the reason
        out({"id": 0, "ok": False, "error": f"curl_cffi cannot be imported ({type(exc).__name__}: {exc})"})
        return 2

    session = requests.Session(impersonate="chrome")
    out({"id": 0, "ok": True, "version": getattr(curl_cffi, "__version__", "?")})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            if req.get("method") == "__quit__":
                break
            headers = {k: v for k, v in (req.get("headers") or {}).items() if k.lower() not in DROP_REQUEST}
            res = session.request(
                req.get("method") or "GET",
                req["url"],
                headers=headers,
                data=(req.get("body") or None),
                timeout=float(req.get("timeout") or 20),
                allow_redirects=False,
            )
            answer = {
                "id": rid,
                "ok": True,
                "status": res.status_code,
                "headers": {k.lower(): v for k, v in res.headers.items() if k.lower() not in DROP_RESPONSE},
                "cookies": res.headers.get_list("set-cookie"),
                "body": base64.b64encode(res.content).decode("ascii"),
            }
            session.cookies.clear()
            out(answer)
        except Exception as exc:  # noqa: BLE001 - reported to the caller as text
            try:
                session.cookies.clear()
            except Exception:  # noqa: BLE001
                pass
            out({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
