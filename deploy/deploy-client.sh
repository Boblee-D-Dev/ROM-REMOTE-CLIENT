#!/usr/bin/env bash
# Deploy GRF asset server (client.moon-ro.com) on rom-web.
#
# Usage:
#   cp deploy/deploy.env.example deploy/deploy.env
#   cp .env.example .env.production
#   ./deploy/deploy-client.sh --setup
#   ./deploy/deploy-client.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ENV="$SCRIPT_DIR/deploy.env"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

RUN_SETUP=0
for arg in "$@"; do
	case "$arg" in
		--setup) RUN_SETUP=1 ;;
		--skip-nginx) SKIP_NGINX=1 ;;
		-h | --help)
			sed -n '1,12p' "$0"
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
	echo "ERROR: missing $APP_ENV_PATH (copy from .env.example)" >&2
	exit 1
}

echo "rom-remote client deploy → $SSH_TARGET ($CLIENT_DOMAIN)"

if [[ "$RUN_SETUP" == "1" ]]; then
	"$SCRIPT_DIR/setup-server.sh" "$DEPLOY_ENV"
elif ! ssh_run "test -f '$SSL_CERT_PATH' && test -f '$SSL_KEY_PATH'" 2>/dev/null; then
	echo "ERROR: SSL cert missing on VPS. Run: ./deploy/deploy-client.sh --setup" >&2
	ssl_hint
	exit 1
fi

deploy_app_sync "$APP_ENV_PATH"

if [[ "$SKIP_NGINX" != "1" ]]; then
	DEPLOY_ENV="$DEPLOY_ENV" "$SCRIPT_DIR/sync-nginx.sh"
fi

log_step "Deploy complete"
echo "  Client: https://${CLIENT_DOMAIN}/"
