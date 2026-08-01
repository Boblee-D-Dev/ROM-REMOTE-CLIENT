#!/usr/bin/env bash
# Stop proxy on rom-web after proxy.moon-ro.com DNS moves to rom-server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
load_deploy_env "$SCRIPT_DIR/deploy.env"

require_cmd ssh

echo "Retiring moon-ws-proxy on $SSH_TARGET"

ssh_run "bash -s" <<'REMOTE'
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if pm2 describe moon-ws-proxy >/dev/null 2>&1; then
  pm2 stop moon-ws-proxy
  pm2 delete moon-ws-proxy
  pm2 save || true
  echo "Stopped PM2 moon-ws-proxy"
else
  echo "moon-ws-proxy not running in PM2"
fi

rm -f /etc/nginx/sites-enabled/proxy.moon-ro.com
if [ -f /etc/nginx/sites-available/proxy.moon-ro.com ]; then
  mv /etc/nginx/sites-available/proxy.moon-ro.com \
     /etc/nginx/sites-available/proxy.moon-ro.com.disabled.$(date +%Y%m%d) || true
fi

if command -v nginx >/dev/null; then
  nginx -t
  systemctl reload nginx
fi
REMOTE

log_step "Proxy retired on rom-web"
