#!/usr/bin/env bash
# StreamAnywhere on a Google Cloud "Always Free" e2-micro (Debian 12), or any small Debian/Ubuntu VM.
#
# What it does (idempotent, re-run safely):
#   1. 2 GB swap (the e2-micro has 1 GB RAM; headless Chromium needs the headroom)
#   2. Node.js 20 (NodeSource), Chromium, git, Caddy
#   3. clones/updates the repo into /opt/streamanywhere, installs deps, builds the client
#   4. a systemd service "streamanywhere" running the Node server on 127.0.0.1:8787 as user "streamanywhere"
#   5. Caddy in front of it: HTTPS on 443 for https://<VM-IP with dashes>.sslip.io (Let's Encrypt, no DNS setup)
#
# Usage (as root on the VM, e.g. through the console's SSH-in-browser):
#   curl -fsSL https://raw.githubusercontent.com/delucatech/StreamAnywhere/main/deploy/gcp/setup-vm.sh | sudo bash
# or after cloning:  sudo bash deploy/gcp/setup-vm.sh
#
# Env overrides: REPO_URL, BRANCH, PUBLIC_HOST (default <ip>.sslip.io), CLIENT_ORIGINS (extra origins, comma-separated)
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/delucatech/StreamAnywhere.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/streamanywhere
APP_USER=streamanywhere
EXTERNAL_IP="$(curl -fsS -H 'Metadata-Flavor: Google' 'http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null || curl -fsS https://api.ipify.org || echo '')"
PUBLIC_HOST="${PUBLIC_HOST:-${EXTERNAL_IP//./-}.sslip.io}"

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "== 1. swap"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 2. packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg chromium fonts-liberation debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "node $(node -v), $(chromium --version 2>/dev/null | head -1), caddy $(caddy version | cut -d' ' -f1)"

echo "== 3. app"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/streamanywhere --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error
npm run build >/dev/null
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/lib/streamanywhere

echo "== 4. service"
cat > /etc/streamanywhere.env <<EOF
NODE_ENV=production
PORT=8787
HOST=127.0.0.1
SERVE_CLIENT=true
CLIENT_ORIGINS=https://${PUBLIC_HOST},https://delucatech.com,https://www.delucatech.com,https://delucatech.github.io${CLIENT_ORIGINS:+,${CLIENT_ORIGINS}}
BROWSER_PATH=/usr/bin/chromium
TIKTOK_PROFILE_DIR=/var/lib/streamanywhere/tiktok-profile
LOG_LEVEL=info
EOF
chmod 640 /etc/streamanywhere.env; chown root:"$APP_USER" /etc/streamanywhere.env
cat > /etc/systemd/system/streamanywhere.service <<EOF
[Unit]
Description=StreamAnywhere (TikTok feed resolver/proxy + browser session)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/streamanywhere.env
ExecStart=/usr/bin/node $APP_DIR/server/dist/server/src/index.js
Restart=always
RestartSec=5
# headless Chromium + Node comfortably fit in this; the swap covers spikes
MemoryMax=900M
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now streamanywhere >/dev/null
systemctl restart streamanywhere

echo "== 5. caddy (https://$PUBLIC_HOST)"
cat > /etc/caddy/Caddyfile <<EOF
$PUBLIC_HOST {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
EOF
systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

sleep 3
echo "== health: $(curl -fsS http://127.0.0.1:8787/api/health | head -c 120)"
echo
echo "Done. Open https://$PUBLIC_HOST/feed.html"
echo "  - 'Sign in' -> 'Sign in with QR code' and scan it with the TikTok app."
echo "  - Logs: journalctl -u streamanywhere -f"
echo "  - The GCP firewall must allow tcp:80 and tcp:443 (the console's 'Allow HTTPS traffic' checkbox)."
