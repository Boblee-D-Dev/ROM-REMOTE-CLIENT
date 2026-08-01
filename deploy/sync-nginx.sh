#!/usr/bin/env bash
# Install nginx site config for client or proxy role.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ENV="${DEPLOY_ENV:-$SCRIPT_DIR/deploy.env}"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
load_deploy_env "$DEPLOY_ENV"

require_cmd ssh
require_cmd scp
require_cmd envsubst

export SSL_CERT_PATH SSL_KEY_PATH PROXY_PORT
SUBST_VARS='${SSL_CERT_PATH} ${SSL_KEY_PATH} ${PROXY_PORT}'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$DEPLOY_ROLE" in
	client)
		log_step "Installing nginx client site on $SSH_TARGET"
		scp "$SCRIPT_DIR/nginx/client.moon-ro.com.conf" "$SSH_TARGET:/etc/nginx/sites-available/client.moon-ro.com"
		ssh_run "bash -s" <<'REMOTE'
set -euo pipefail
ln -sf /etc/nginx/sites-available/client.moon-ro.com /etc/nginx/sites-enabled/client.moon-ro.com
nginx -t
systemctl reload nginx
REMOTE
		;;
	proxy)
		log_step "Installing nginx proxy site on $SSH_TARGET"
		envsubst "$SUBST_VARS" < "$SCRIPT_DIR/nginx/proxy.moon-ro.com.conf.template" > "$TMP/proxy.moon-ro.com"
		scp "$TMP/proxy.moon-ro.com" "$SSH_TARGET:/etc/nginx/sites-available/proxy.moon-ro.com"
		ssh_run "bash -s" <<'REMOTE'
set -euo pipefail
ln -sf /etc/nginx/sites-available/proxy.moon-ro.com /etc/nginx/sites-enabled/proxy.moon-ro.com
nginx -t
systemctl reload nginx
REMOTE
		;;
esac

log_step "nginx reloaded ($NGINX_SITE)"
