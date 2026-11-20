#!/usr/bin/env bash
# Opt-in redeploy of the app when origin/<branch> moves (systemd: streamanywhere-autodeploy.timer,
# every 30 min, installed by setup-vm.sh; enabled only with AUTO_DEPLOY=1 in /etc/streamanywhere.env).
#
# Added 2026-11-20: the client deploys itself to GitHub Pages on every push, but the server changed
# only on a Reset. This reruns the app part of setup-vm.sh (fetch/reset, npm ci, build, restart) and
# nothing else: no apt, no units, no Caddy. A change to setup-vm.sh itself still needs a Reset (this
# says so in the journal). The unit runs it at Nice=19 / idle I/O, and it starts only when the server
# reports no pressure and no work (2026-11-19: work piled on the e2-micro froze it for 10 minutes).
set -uo pipefail
# shellcheck source=deploy/gcp/lib.sh
. "$(dirname "$0")/lib.sh"
APP_DIR=/opt/streamanywhere
APP_USER=streamanywhere
export HOME="${HOME:-/root}"

grep -qx 'AUTO_DEPLOY=1' "$SA_ENV" 2>/dev/null || { echo "AUTO_DEPLOY is not 1 in $SA_ENV; nothing to do"; exit 0; }

# Never two at once (setup-vm.sh at boot and ytdlp-update.sh take the same lock): the next timer run retries.
exec 9>"$SA_LOCK"
if ! flock -n 9; then echo "another deploy/update is running; next check in 30 min"; exit 0; fi

cd "$APP_DIR" || { echo "WARN: $APP_DIR is missing"; exit 1; }
# The branch setup-vm.sh deployed (metadata "branch"); the local branch name can differ from it.
branch=$(sed -n 's/^DEPLOY_BRANCH=//p' "$SA_ENV" 2>/dev/null | tail -1)
branch=${branch:-main}
here=$(git rev-parse HEAD)
# ls-remote first: a few hundred bytes every 30 min instead of a fetch.
there=$(git ls-remote origin "refs/heads/$branch" 2>/dev/null | cut -f1)
if [ -z "$there" ]; then echo "WARN: could not read origin/$branch; next check in 30 min"; exit 0; fi
# A commit whose deploy failed is not retried every 30 min (HEAD is already on it): the next push is.
[ "$there" = "$here" ] && exit 0

# A server that is not running is deployed at once (the new commit may be its fix); a running one
# that does not answer is a starved VM, which a build would only make worse.
if systemctl is-active --quiet streamanywhere; then
  why=$(sa_busy_reason)
  if [ -n "$why" ]; then echo "origin/$branch is at ${there:0:7} (here ${here:0:7}), waiting: $why"; exit 0; fi
fi

if ! git fetch -q origin "$branch"; then echo "WARN: git fetch failed; next check in 30 min"; exit 0; fi
if ! git reset -q --hard "origin/$branch"; then echo "WARN: git reset failed"; exit 1; fi
new=$(git rev-parse HEAD)
echo "deploying ${here:0:7} -> ${new:0:7}: $(git log -1 --format=%s | cut -c1-80)"
if ! git diff --quiet "$here" "$new" -- deploy/gcp/setup-vm.sh; then
  echo "NOTE: deploy/gcp/setup-vm.sh changed in this range; Reset the VM to apply its system changes"
fi

if ! npm ci --no-audit --no-fund --loglevel=error; then
  # node_modules is half-written now; the running server keeps what it already loaded. Not restarted.
  echo "WARN: npm ci failed; the server was NOT restarted (Reset the VM, or push a fix)"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  exit 1
fi
# Same as setup-vm.sh: with Debian's ffmpeg pinned, the bundled static build goes (SIGSEGV, 2026-11-04).
if grep -q '^FFMPEG_PATH=' "$SA_ENV" 2>/dev/null; then rm -f "$APP_DIR/node_modules/ffmpeg-static/ffmpeg"; fi
if ! out=$(npm run build 2>&1); then
  echo "WARN: build failed; the server was NOT restarted"
  printf '%s\n' "$out" | tail -20
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  exit 1
fi
printf '%s\n' "$out" | tail -5
find client/dist/assets -type f -mtime +14 -delete 2>/dev/null || true
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# The updater scripts themselves (install writes a new file, so this running copy is unaffected).
for f in lib.sh ytdlp-update.sh auto-deploy.sh; do
  install -m 755 "$APP_DIR/deploy/gcp/$f" "/usr/local/lib/streamanywhere/$f" 2>/dev/null || echo "WARN: could not install $f"
done

systemctl restart streamanywhere || { echo "WARN: restart failed"; exit 1; }
sleep 15
echo "deployed ${new:0:7}; health: $(curl -fsS -m 30 "$SA_HEALTH" 2>/dev/null | head -c 120 || echo 'no answer yet')"
