#!/usr/bin/env bash
# Issue or renew Let's Encrypt certs for client + proxy domains (certbot webroot).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
load_deploy_env "$SCRIPT_DIR/deploy.env"

if [[ -z "$CERTBOT_EMAIL" ]]; then
	echo "ERROR: set CERTBOT_EMAIL in deploy/deploy.env" >&2
	exit 1
fi

require_cmd ssh

CERTBOT_D_ARGS=()
for d in $REMOTE_DOMAINS; do
	CERTBOT_D_ARGS+=(-d "$d")
done

log_step "Ensuring certbot certificate for: $REMOTE_DOMAINS"

ssh_run "bash -s" <<REMOTE
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v certbot >/dev/null; then
  apt-get update -qq
  apt-get install -y certbot
fi

mkdir -p '$CERTBOT_WEBROOT'

if [ -f '$SSL_CERT_PATH' ] && [ -f '$SSL_KEY_PATH' ]; then
  echo "Certificate already present at $SSL_CERT_PATH"
  certbot renew --dry-run >/dev/null 2>&1 || true
  exit 0
fi

cat > /etc/nginx/sites-available/certbot-bootstrap <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $REMOTE_DOMAINS;

    location /.well-known/acme-challenge/ {
        root $CERTBOT_WEBROOT;
    }

    location / {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/certbot-bootstrap /etc/nginx/sites-enabled/certbot-bootstrap
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

certbot certonly --webroot -w '$CERTBOT_WEBROOT' \\
  ${CERTBOT_D_ARGS[*]} \\
  --email '$CERTBOT_EMAIL' \\
  --agree-tos --no-eff-email -n \\
  --cert-name '$CERT_NAME'

echo "Issued: $SSL_CERT_PATH"
REMOTE

log_step "certbot certificate ready"
