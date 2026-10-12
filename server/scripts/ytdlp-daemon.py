"""
yt-dlp kept warm: one Python process that imports yt_dlp once and answers extraction requests
over stdin/stdout, one JSON object per line.

Importing yt_dlp costs ~1 s on a PC and ~11 s of CPU on the free e2-micro VM (measured
2026-10-12: a zipapp recompiles every module on each run), so spawning the CLI per request made
every YouTube call 25-120 s there. This process pays that once.

Request:  {"id": 1, "url": "...", "flat": true, "playlist_items": "1-30", "noplaylist": false,
           "extractor_args": {"youtube": {"player_client": ["..."]}}}
Response: {"id": 1, "ok": true, "info": {...}}  or  {"id": 1, "ok": false, "error": "..."}

The yt_dlp package comes from the running interpreter (pip / venv install); when the environment
variable YTDLP_PATH names a zipapp (the GitHub release file), that file is put on sys.path instead.
"""
import json
import os
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


class _Quiet:
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

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
    out.write(json.dumps({"id": 0, "ok": True, "version": yt_dlp.version.__version__}) + "\n")
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
            "logger": _Quiet(),
            # the same formats the CLI gives us; no JS runtime is required for them (2026-10)
            "check_formats": False,
        }
        if req.get("flat"):
            opts["extract_flat"] = "in_playlist"
        if req.get("playlist_items"):
            opts["playlist_items"] = str(req["playlist_items"])
        if req.get("extractor_args"):
            opts["extractor_args"] = req["extractor_args"]
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
