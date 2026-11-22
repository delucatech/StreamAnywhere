"""
yt-dlp kept warm: one Python process that imports yt_dlp once and answers extraction requests
over stdin/stdout, one JSON object per line.

Importing yt_dlp costs ~1 s on a PC and ~11 s of CPU on the free e2-micro VM (measured
2026-10-12: a zipapp recompiles every module on each run), so spawning the CLI per request made
every YouTube call 25-120 s there. This process pays that once.

Hello:    {"id": 0, "ok": true, "version": "2026.10.26", "direct_client": {...} | null,
           "js_runtime": "/usr/local/bin/deno" | null}
Request:  {"id": 1, "url": "...", "flat": true, "playlist_items": "1-30", "noplaylist": false,
           "cookiefile": "/path/to/cookies.txt",
           "extractor_args": {"youtube": {"skip": ["hls", "dash"]}}}
Progress: {"id": 1, "progress": "[youtube] dQw4w9WgXcQ: Downloading webpage"}   (any number, before the response)
Response: {"id": 1, "ok": true, "info": {...}}  or  {"id": 1, "ok": false, "error": "..."}

direct_client is the YouTube player client this yt-dlp uses when it has no JavaScript runtime
(name, numeric id, the request context): the server asks YouTube's player API with it directly
(server/src/youtubePlayer.ts), so a daily yt-dlp upgrade also renews that request.

js_runtime is the Deno yt-dlp will find on the PATH (null without one). With it (and the yt-dlp-ejs
package, part of `pip install "yt-dlp[default]"`) yt-dlp runs YouTube's player script and can use
the web and TV player clients: the way to the videos the JS-less client is refused ("made for
kids"), and a second route when YouTube closes that client. Progress lines are yt-dlp's own
messages for the request in hand; the server shows them to the viewer who is waiting.

The yt_dlp package comes from the running interpreter (pip / venv install); when the environment
variable YTDLP_PATH names a zipapp (the GitHub release file), that file is put on sys.path instead.
"""
import json
import os
import shutil
import sys


def _import_yt_dlp():
    try:
        import yt_dlp  # noqa: F401
        return yt_dlp
    except ImportError:
        pass
    p = os.environ.get("YTDLP_PATH", "")
    if p and os.path.isfile(p):
        sys.path.insert(0, p)
        import yt_dlp  # noqa: F401
        return yt_dlp
    raise


def _direct_client():
    """
    The player client yt-dlp falls back to without a JS runtime, when it is one that needs no
    sign-in, no JS player and no PO token for its https formats; None otherwise (the server then
    uses its built-in definition). Internal names of yt-dlp: any change there ends in None.
    """
    try:
        from yt_dlp.extractor.youtube import _base
        from yt_dlp.extractor.youtube._video import YoutubeIE

        name = YoutubeIE._DEFAULT_JSLESS_CLIENTS[0]
        c = _base.INNERTUBE_CLIENTS[name]
        if c.get("REQUIRE_JS_PLAYER") or c.get("REQUIRE_AUTH"):
            return None
        policy = (c.get("GVS_PO_TOKEN_POLICY") or {}).get(_base.StreamingProtocol.HTTPS)
        if policy is not None and getattr(policy, "required", False):
            return None
        client = {k: v for k, v in c["INNERTUBE_CONTEXT"]["client"].items() if isinstance(v, (str, int, float, bool))}
        if not client.get("clientName") or not client.get("clientVersion"):
            return None
        out = {"name": name, "id": int(c["INNERTUBE_CONTEXT_CLIENT_NAME"]), "client": client}
        if isinstance(c.get("PLAYER_PARAMS"), str):
            out["params"] = c["PLAYER_PARAMS"]
        return out
    except Exception:  # noqa: BLE001
        return None


class _Steps:
    """yt-dlp's logger: its screen messages ("[youtube] <id>: Downloading webpage") go out as progress lines."""

    def __init__(self, out, rid):
        self._out = out
        self._rid = rid

    def debug(self, msg):
        # to_screen() ends here too; real debug output is marked "[debug] "
        if not isinstance(msg, str) or msg.startswith("[debug] ") or not msg.strip():
            return
        try:
            self._out.write(json.dumps({"id": self._rid, "progress": msg.strip()[:300]}, ensure_ascii=True) + "\n")
            self._out.flush()
        except Exception:  # noqa: BLE001
            pass

    def info(self, msg):
        self.debug(msg)

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def main():
    out = sys.stdout
    try:
        yt_dlp = _import_yt_dlp()
    except Exception as e:  # noqa: BLE001
        out.write(json.dumps({"id": 0, "ok": False, "error": "cannot import yt_dlp: %s" % e}) + "\n")
        out.flush()
        return 1
    out.write(json.dumps({"id": 0, "ok": True, "version": yt_dlp.version.__version__, "direct_client": _direct_client(), "js_runtime": shutil.which("deno")}) + "\n")
    out.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": bool(req.get("noplaylist")),
            "logger": _Steps(out, rid),
            # the same formats the CLI gives us; no JS runtime is required for them (2026-10)
            "check_formats": False,
            # a connection that stops answering ends by itself (yt-dlp's default is 20 s per read)
            "socket_timeout": 12,
        }
        if req.get("flat"):
            opts["extract_flat"] = "in_playlist"
        if req.get("playlist_items"):
            opts["playlist_items"] = str(req["playlist_items"])
        if req.get("extractor_args"):
            opts["extractor_args"] = req["extractor_args"]
        if req.get("cookiefile"):
            # The YouTube sign-in. yt-dlp saves the (possibly rotated) jar back to the file on close.
            opts["cookiefile"] = str(req["cookiefile"])
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(req["url"], download=False)
                info = ydl.sanitize_info(info)
            resp = {"id": rid, "ok": True, "info": info}
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if msg.startswith("ERROR: "):
                msg = msg[7:]
            resp = {"id": rid, "ok": False, "error": msg}
        out.write(json.dumps(resp, ensure_ascii=True) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
