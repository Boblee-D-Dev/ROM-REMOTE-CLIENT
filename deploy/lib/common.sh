#!/usr/bin/env bash
# Shared helpers for rom-remote deploy.

deploy_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_root="$(cd "$deploy_lib_dir/.." && pwd)"
repo_root="$(cd "$deploy_root/.." && pwd)"

load_deploy_env() {
	local env_file="${1:-$deploy_root/deploy.env}"
	if [[ -f "$env_file" ]]; then
		# shellcheck disable=SC1090
		source "$env_file"
	fi

	VPS_USER="${VPS_USER:-root}"
	VPS_HOST="${VPS_HOST:-rom-web}"
	SSH_TARGET="${VPS_USER}@${VPS_HOST}"
	DEPLOY_ROLE="${DEPLOY_ROLE:-client}"
	CLIENT_DOMAIN="${CLIENT_DOMAIN:-client.moon-ro.com}"
	PROXY_DOMAIN="${PROXY_DOMAIN:-proxy.moon-ro.com}"
	CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@moon-ro.com}"
	CERTBOT_WEBROOT="${CERTBOT_WEBROOT:-/var/www/certbot}"
	REMOTE_ROOT="${REMOTE_ROOT:-/var/www/moon-remote-client}"
	CLIENT_PORT="${CLIENT_PORT:-3338}"
	PROXY_PORT="${PROXY_PORT:-5999}"
	ENV_FILE="${ENV_FILE:-.env.production}"
	PM2_APP="${PM2_APP:-moon-remote-client}"
	SKIP_NGINX="${SKIP_NGINX:-0}"

	case "$DEPLOY_ROLE" in
		client)
			REMOTE_DOMAINS="${REMOTE_DOMAINS:-$CLIENT_DOMAIN}"
			CERT_NAME="${CERT_NAME:-$CLIENT_DOMAIN}"
			NGINX_SITE="${NGINX_SITE:-client.moon-ro.com}"
			;;
		proxy)
			REMOTE_DOMAINS="${REMOTE_DOMAINS:-$PROXY_DOMAIN}"
			CERT_NAME="${CERT_NAME:-$PROXY_DOMAIN}"
			NGINX_SITE="${NGINX_SITE:-proxy.moon-ro.com}"
			;;
		*)
			echo "ERROR: unknown DEPLOY_ROLE=$DEPLOY_ROLE (use client or proxy)" >&2
			exit 1
			;;
	esac

	SSL_CERT_PATH="${SSL_CERT_PATH:-/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem}"
	SSL_KEY_PATH="${SSL_KEY_PATH:-/etc/letsencrypt/live/${CERT_NAME}/privkey.pem}"
}

log_step() {
	echo ""
	echo "==> $*"
}

ssh_run() {
	ssh -o BatchMode=yes "$SSH_TARGET" "$@"
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "ERROR: required command not found: $1" >&2
		exit 1
	}
}

ssl_hint() {
	cat <<EOF
Let's Encrypt (certbot) — one-time on this VPS:
  1. Point DNS A record(s) here: $REMOTE_DOMAINS → $VPS_HOST
  2. Set CERTBOT_EMAIL in deploy env file
  3. Run: ./deploy/deploy-${DEPLOY_ROLE}.sh --setup
  Cert paths (default):
    $SSL_CERT_PATH
    $SSL_KEY_PATH
EOF
}

deploy_app_sync() {
	local env_path="$1"
	require_cmd rsync
	require_cmd ssh
	require_cmd scp

	log_step "Syncing app → $SSH_TARGET:$REMOTE_ROOT"
	rsync -avz \
		--exclude node_modules --exclude .git --exclude '.env.*' --exclude logs \
		--exclude deploy/deploy.env --exclude deploy/proxy.env \
		"$repo_root/" "$SSH_TARGET:$REMOTE_ROOT/"

	scp "$env_path" "$SSH_TARGET:$REMOTE_ROOT/.env"

	log_step "Installing dependencies and restarting PM2 ($PM2_APP)"
	ssh_run "bash -s" <<REMOTE
set -euo pipefail
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd '$REMOTE_ROOT'
mkdir -p logs
NPM_FLAGS='--production=false'
if [ '$PM2_APP' = 'moon-ws-proxy' ]; then
  NPM_FLAGS="\$NPM_FLAGS --ignore-scripts"
fi
if [ -f package-lock.json ]; then npm ci \$NPM_FLAGS; else npm install \$NPM_FLAGS; fi
pm2 startOrRestart ecosystem.config.js --only '$PM2_APP' --update-env
pm2 save || true
REMOTE
}
