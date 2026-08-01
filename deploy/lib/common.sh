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
	CLIENT_DOMAIN="${CLIENT_DOMAIN:-client.moon-ro.com}"
	PROXY_DOMAIN="${PROXY_DOMAIN:-proxy.moon-ro.com}"
	REMOTE_DOMAINS="${REMOTE_DOMAINS:-$CLIENT_DOMAIN $PROXY_DOMAIN}"
	CERT_NAME="${CERT_NAME:-$CLIENT_DOMAIN}"
	CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
	CERTBOT_WEBROOT="${CERTBOT_WEBROOT:-/var/www/certbot}"
	SSL_CERT_PATH="${SSL_CERT_PATH:-/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem}"
	SSL_KEY_PATH="${SSL_KEY_PATH:-/etc/letsencrypt/live/${CERT_NAME}/privkey.pem}"
	REMOTE_ROOT="${REMOTE_ROOT:-/var/www/moon-remote-client}"
	CLIENT_PORT="${CLIENT_PORT:-3338}"
	PROXY_PORT="${PROXY_PORT:-5999}"
	ENV_FILE="${ENV_FILE:-.env.production}"
	SKIP_NGINX="${SKIP_NGINX:-0}"
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
Let's Encrypt (certbot) — one-time on new VPS:
  1. Point DNS A records to this VPS: $REMOTE_DOMAINS
  2. Set CERTBOT_EMAIL in deploy/deploy.env
  3. Run: ./deploy/deploy.sh --setup
  Cert paths (default):
    $SSL_CERT_PATH
    $SSL_KEY_PATH
EOF
}
