#!/usr/bin/env python3
"""One HTTPS request with Chrome's TLS handshake (curl_cffi), for research/tiktok_signer_probe.ts.

Reads one JSON request on stdin ({method, url, headers, body}), writes one JSON answer on stdout
({status, headers, cookies: [raw Set-Cookie lines], body: base64}). Redirects are NOT followed: the caller
follows them so that every hop's cookies reach its jar.

    python -m pip install --user curl_cffi
"""
import base64
import json
import sys


def main() -> int:
    try:
        from curl_cffi import requests
    except ImportError:
        sys.stderr.write("curl_cffi is not installed: python -m pip install --user curl_cffi\n")
        return 2
    req = json.loads(sys.stdin.read())
    headers = {k: v for k, v in (req.get("headers") or {}).items() if k.lower() not in ("host", "content-length", "connection", "accept-encoding")}
    try:
        res = requests.request(
            req.get("method", "GET"),
            req["url"],
            headers=headers,
            data=(req.get("body") or None),
            impersonate="chrome",
            timeout=30,
            allow_redirects=False,
        )
        out = {
            "status": res.status_code,
            "headers": {k: v for k, v in res.headers.items() if k.lower() not in ("set-cookie", "content-encoding", "transfer-encoding")},
            "cookies": res.headers.get_list("set-cookie"),
            "body": base64.b64encode(res.content).decode("ascii"),
        }
    except Exception as exc:  # noqa: BLE001 - reported to the caller as text
        out = {"error": f"{type(exc).__name__}: {exc}"}
    sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
