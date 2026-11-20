#!/usr/bin/env bash
# Daily yt-dlp upgrade on the VM (systemd: streamanywhere-ytdlp-update.timer, installed by setup-vm.sh).
#
# Added 2026-11-20: YouTube search falls back to yt-dlp and all YouTube playback goes through it, and
# YouTube breaks old yt-dlp releases often; until now it was upgraded only when the VM was Reset.
# Upgrades the venv package and the zipapp, and restarts the server only when a version changed
# (its yt-dlp daemons keep yt_dlp imported, so they would keep the old code). The unit runs this at
# Nice=19 / idle I/O: pip on the e2-micro's small disk is what a viewer would feel.
set -uo pipefail
# shellcheck source=deploy/gcp/lib.sh
. "$(dirname "$0")/lib.sh"
export HOME="${HOME:-/root}"

# One deploy/update at a time (setup-vm.sh at boot, auto-deploy.sh, this): wait for the other one.
exec 9>"$SA_LOCK"
if ! flock -w 3600 9; then echo "WARN: another deploy/update held the lock for an hour; skipping today"; exit 0; fi

before=$(sa_ytdlp_versions)
current=$(/opt/ytdlp/bin/yt-dlp --version 2>/dev/null || /usr/local/bin/yt-dlp --version 2>/dev/null || echo none)
# The latest release's tag (e.g. 2026.11.18) from GitHub's redirect: when the venv already has it,
# there is nothing to wait for. A failed lookup just means "try the upgrade".
latest=$(curl -fsSI -m 20 https://github.com/yt-dlp/yt-dlp/releases/latest 2>/dev/null | tr -d '\r' | sed -n 's#^[Ll]ocation:.*/tag/##p' | tail -1)
if [ -n "$latest" ] && [ "$latest" = "$current" ]; then echo "yt-dlp is current ($before)"; exit 0; fi
echo "yt-dlp: have $before, latest release ${latest:-unknown}"

# The upgrade swaps files under a running daemon (extractors are imported lazily), and the restart
# drops whatever is playing: wait for a quiet moment, up to 2 hours (checks every 10 min).
for i in $(seq 1 12); do
  why=$(sa_busy_reason)
  [ -z "$why" ] && break
  if [ "$i" -eq 12 ]; then echo "WARN: the server stayed busy for 2 hours ($why); no upgrade today"; exit 0; fi
  echo "waiting: $why"
  sleep 600
done

if [ -x /opt/ytdlp/bin/pip ]; then
  /opt/ytdlp/bin/pip install -q --no-cache-dir -U yt-dlp >/dev/null 2>&1 || echo "WARN: pip install -U yt-dlp failed"
fi
if [ -x /usr/local/bin/yt-dlp ]; then
  /usr/local/bin/yt-dlp -U >/dev/null 2>&1 || echo "WARN: yt-dlp -U (zipapp) failed"
fi
after=$(sa_ytdlp_versions)

if [ "$before" = "$after" ]; then echo "yt-dlp unchanged ($after)"; exit 0; fi
echo "yt-dlp upgraded: $before -> $after; restarting streamanywhere"
systemctl restart streamanywhere || echo "WARN: restart failed"
