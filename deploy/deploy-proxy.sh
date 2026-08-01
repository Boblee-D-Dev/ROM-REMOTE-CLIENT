#!/usr/bin/env bash
# Deploy WebSocket proxy (proxy.moon-ro.com) on rom-server.
#
# Usage:
#   cp deploy/proxy.env.example deploy/proxy.env
#   cp .env.proxy.production.example .env.proxy.production
#   # Point proxy.moon-ro.com DNS → rom-server, then:
#   ./deploy/deploy-proxy.sh --setup
#   ./deploy/deploy-proxy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ENV="$SCRIPT_DIR/proxy.env"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

RUN_SETUP=0
SKIP_SSL_CHECK=0
for arg in "$@"; do
	case "$arg" in
		--setup) RUN_SETUP=1 ;;
		--skip-nginx) SKIP_NGINX=1 ;;
		--skip-ssl) SKIP_SSL_CHECK=1 ;;
		-h | --help)
			sed -n '1,14p' "$0"
			exit 0
			;;
		*)
			echo "Unknown option: $arg" >&2
			exit 1
			;;
	esac
done

load_deploy_env "$DEPLOY_ENV"

APP_ENV_PATH="$repo_root/$ENV_FILE"
[[ -f "$APP_ENV_PATH" ]] || {
	echo "ERROR: missing $APP_ENV_PATH (copy from .env.proxy.production.example)" >&2
	exit 1
}

echo "rom-remote proxy deploy → $SSH_TARGET ($PROXY_DOMAIN)"

if [[ "$RUN_SETUP" == "1" ]]; then
	"$SCRIPT_DIR/setup-server.sh" "$DEPLOY_ENV"
elif [[ "$SKIP_SSL_CHECK" != "1" ]] && ! ssh_run "test -f '$SSL_CERT_PATH' && test -f '$SSL_KEY_PATH'" 2>/dev/null; then
	echo "ERROR: SSL cert missing on VPS. Point DNS here, then run: ./deploy/deploy-proxy.sh --setup" >&2
	ssl_hint
	exit 1
fi

deploy_app_sync "$APP_ENV_PATH"

if [[ "$SKIP_NGINX" != "1" ]]; then
	DEPLOY_ENV="$DEPLOY_ENV" "$SCRIPT_DIR/sync-nginx.sh"
fi

log_step "Deploy complete"
echo "  Proxy: wss://${PROXY_DOMAIN}/"
