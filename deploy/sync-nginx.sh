#!/usr/bin/env bash
# Install client + proxy nginx site configs on VPS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
load_deploy_env "$SCRIPT_DIR/deploy.env"

require_cmd ssh
require_cmd scp

log_step "Installing nginx sites on $SSH_TARGET"

scp "$SCRIPT_DIR/nginx/client.moon-ro.com.conf" "$SSH_TARGET:/etc/nginx/sites-available/client.moon-ro.com"
scp "$SCRIPT_DIR/nginx/proxy.moon-ro.com.conf" "$SSH_TARGET:/etc/nginx/sites-available/proxy.moon-ro.com"

ssh_run "bash -s" <<'REMOTE'
set -euo pipefail
ln -sf /etc/nginx/sites-available/client.moon-ro.com /etc/nginx/sites-enabled/client.moon-ro.com
ln -sf /etc/nginx/sites-available/proxy.moon-ro.com /etc/nginx/sites-enabled/proxy.moon-ro.com
nginx -t
systemctl reload nginx
REMOTE

log_step "nginx reloaded (client + proxy)"
