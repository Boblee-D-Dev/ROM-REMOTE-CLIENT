#!/usr/bin/env bash
# Deploy moon-remote-client + moon-ws-proxy (rsync + PM2 + nginx).
#
# Usage:
#   cp deploy/deploy.env.example deploy/deploy.env
#   cp .env.example .env.production   # edit for production
#   ./deploy/deploy.sh --setup        # first time on new VPS
#   ./deploy/deploy.sh                # routine deploy
#
# Flags:
#   --setup       run setup-server.sh (nginx, certbot, NVM/PM2)
#   --skip-nginx  skip nginx config sync
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

RUN_SETUP=0
for arg in "$@"; do
	case "$arg" in
		--setup) RUN_SETUP=1 ;;
		--skip-nginx) SKIP_NGINX=1 ;;
		-h | --help)
			sed -n '1,15p' "$0"
			exit 0
			;;
		*)
			echo "Unknown option: $arg" >&2
			exit 1
			;;
	esac
done

load_deploy_env "$SCRIPT_DIR/deploy.env"

ENV_PATH="$repo_root/$ENV_FILE"
[[ -f "$ENV_PATH" ]] || {
	echo "ERROR: missing $ENV_PATH (copy from .env.example)" >&2
	exit 1
}

require_cmd rsync
require_cmd ssh
require_cmd scp

echo "rom-remote deploy → $SSH_TARGET ($CLIENT_DOMAIN, $PROXY_DOMAIN)"

if [[ "$RUN_SETUP" == "1" ]]; then
	"$SCRIPT_DIR/setup-server.sh"
elif ! ssh_run "test -f '$SSL_CERT_PATH' && test -f '$SSL_KEY_PATH'" 2>/dev/null; then
	echo "ERROR: SSL cert missing on VPS. Run: ./deploy/deploy.sh --setup" >&2
	ssl_hint
	exit 1
fi

log_step "Syncing app → $SSH_TARGET:$REMOTE_ROOT"
rsync -avz \
	--exclude node_modules --exclude .git --exclude '.env.*' --exclude logs \
	--exclude deploy/deploy.env \
	"$repo_root/" "$SSH_TARGET:$REMOTE_ROOT/"

scp "$ENV_PATH" "$SSH_TARGET:$REMOTE_ROOT/.env"

log_step "Installing dependencies and restarting PM2"
ssh_run "bash -s" <<REMOTE
set -euo pipefail
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd '$REMOTE_ROOT'
mkdir -p logs
if [ -f package-lock.json ]; then npm ci --production=false; else npm install; fi
pm2 startOrRestart ecosystem.config.js --update-env
pm2 save || true
REMOTE

if [[ "$SKIP_NGINX" != "1" ]]; then
	"$SCRIPT_DIR/sync-nginx.sh"
fi

log_step "Deploy complete"
echo "  Client: https://${CLIENT_DOMAIN}/"
echo "  Proxy:  wss://${PROXY_DOMAIN}/"
