#!/usr/bin/env bash
# Harden rom-server (proxy VPS): localhost MariaDB, ufw, fail2ban.
# Safe for live players — only touches SSH/firewall/DB bind, not game ports.
#
# Usage (on VPS as root, or via deploy):
#   ./deploy/setup-security.sh
#   ssh rom-server 'bash -s' < deploy/setup-security.sh
set -euo pipefail

ADMIN_IP="${ADMIN_SSH_IP:-49.49.216.27}"

log() { echo "[setup-security] $*"; }

log "MariaDB → bind 127.0.0.1 only"
MYSQL_CNF="/etc/mysql/mariadb.conf.d/50-server.cnf"
if [[ -f "$MYSQL_CNF" ]]; then
  if grep -q '^bind-address' "$MYSQL_CNF"; then
    sed -i 's/^bind-address\s*=.*/bind-address            = 127.0.0.1/' "$MYSQL_CNF"
  else
    printf '\nbind-address            = 127.0.0.1\n' >>"$MYSQL_CNF"
  fi
  systemctl restart mariadb
  ss -tlnp | grep 3306 || true
fi

log "Installing fail2ban + ufw (if missing)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y fail2ban ufw

log "fail2ban: sshd jail (ignore admin IP $ADMIN_IP)"
mkdir -p /etc/fail2ban/jail.d
cat >/etc/fail2ban/jail.d/rom-server.local <<EOF
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8 ::1 ${ADMIN_IP}

[sshd]
enabled  = true
port     = ssh
logpath  = %(sshd_log)s
backend  = %(sshd_backend)s
maxretry = 3
bantime  = 86400
EOF

systemctl enable fail2ban
systemctl restart fail2ban

log "ufw: allow 22/80/443, deny rest"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP certbot + redirect'
ufw allow 443/tcp comment 'HTTPS proxy'
ufw --force enable

log "Verify"
ufw status verbose
fail2ban-client status sshd
curl -sf http://127.0.0.1:5999/api/health >/dev/null && log "proxy health OK" || log "WARN: proxy health check failed"
curl -sf https://proxy.moon-ro.com/health >/dev/null && log "public proxy health OK" || log "WARN: public health check failed"

log "Done"
