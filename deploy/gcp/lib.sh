# Shared by the VM's self-update scripts (ytdlp-update.sh, auto-deploy.sh). setup-vm.sh installs
# this file and those scripts to /usr/local/lib/streamanywhere/; systemd timers run them.
# shellcheck shell=bash

SA_LOCK=/run/lock/streamanywhere-deploy.lock
SA_ENV=/etc/streamanywhere.env
SA_HEALTH=http://127.0.0.1:8787/api/health

# Prints why the server should be left alone right now (nothing when it has room), from
# /api/health -> server.pressure / server.busy (server/src/pressure.ts, serverBusy() in index.ts).
# A restart or an `npm ci` + build on top of a busy e2-micro is what froze it on 2026-11-19 (the
# home-screen stampede): anything the server is doing for a viewer comes first.
sa_busy_reason() {
  local h
  # /api/health asks yt-dlp for its version, so a starved VM answers slowly: 30 s before "no answer".
  if ! h=$(curl -fsS -m 30 "$SA_HEALTH" 2>/dev/null); then
    echo "the server did not answer /api/health"
    return 0
  fi
  printf '%s' "$h" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const v = JSON.parse(s).server || {};
        if (v.pressure) console.log("under pressure: " + (v.reason || "little memory left"));
        else if (Array.isArray(v.busy) && v.busy.length) console.log("busy: " + v.busy.join("; "));
      } catch (e) {
        console.log("unreadable /api/health answer");
      }
    });'
}

# The yt-dlp versions the server can use: the venv (preferred, YTDLP_PATH) and the zipapp fallback.
sa_ytdlp_versions() {
  echo "venv $(/opt/ytdlp/bin/yt-dlp --version 2>/dev/null || echo none), zipapp $(/usr/local/bin/yt-dlp --version 2>/dev/null || echo none)"
}
