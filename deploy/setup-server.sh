#!/usr/bin/env bash
# First-time VPS bootstrap: packages, certbot SSL, nginx site enable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
load_deploy_env "$SCRIPT_DIR/deploy.env"

require_cmd ssh

log_step "Bootstrap on $SSH_TARGET"

ssh_run "bash -s" <<REMOTE
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v nginx >/dev/null; then
  apt-get update -qq
  apt-get install -y nginx
fi

mkdir -p '$REMOTE_ROOT/logs' '$CERTBOT_WEBROOT'
chmod 755 '$REMOTE_ROOT'

if ! command -v node >/dev/null; then
  export NVM_DIR="\$HOME/.nvm"
  if [ ! -s "\$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "\$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm alias default 'lts/*'
  npm install -g pm2
fi
REMOTE

"$SCRIPT_DIR/issue-ssl.sh"
"$SCRIPT_DIR/sync-nginx.sh"

log_step "Server bootstrap complete"
echo "Next: ./deploy/deploy.sh"
