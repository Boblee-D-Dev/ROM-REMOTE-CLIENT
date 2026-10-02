# rom-remote — deploy

Split deploy: **client** (rom-web) and **proxy** (rom-server) run on separate VPS.

| Role | Host | Domain | Script |
|------|------|--------|--------|
| GRF client | rom-web | client.moon-ro.com | `./deploy/deploy-client.sh` |
| WS proxy | rom-server | proxy.moon-ro.com | `./deploy/deploy-proxy.sh` |

SSL: **certbot** on each host (separate certs).

## Client (rom-web)

```bash
cp deploy/deploy.env.example deploy/deploy.env
cp .env.example .env.production
./deploy/deploy-client.sh --setup   # first time
./deploy/deploy-client.sh
```

## Proxy (rom-server)

```bash
cp deploy/proxy.env.example deploy/proxy.env
cp .env.proxy.example .env.proxy.production
# Cloudflare: point proxy.moon-ro.com A → rom-server IP
./deploy/deploy-proxy.sh --setup    # after DNS propagates
./deploy/deploy-proxy.sh
```

Proxy forwards to **rom-server-prd** (`43.228.86.182:6900/6121/5121`) — see `.env.proxy.production`.

### Login audit (JSONL)

When `WS_LOGIN_AUDIT=1` or `WS_LOGIN_AUDIT_PATH` is set, wsProxy appends one line per **login-port** SSO packet (`0x0888` / `0x0825`): UTC timestamp, `client_ipv4`, `game_id`, `origin`, `turnstile_enforced`, optional `sec_ch_mobile` / `sec_ch_platform`, `ws_target`. **Never** logs password, Turnstile token, or MAC from the packet body.

Default path: `./logs/ws-login-audit.jsonl` (under app dir on VPS, e.g. `/var/www/moon-ws-proxy/logs/`).

JSONL field `turnstile_enforced` = Turnstile was required on this login-port connection (not “user failed captcha”). Requires `TURNSTILE_SECRET_KEY` in deploy env — copy from rom-web `/var/www/rom-frontend/.env`.

**Ops**

- Read on proxy VPS only; restrict file permissions (`chmod 640`, owner = PM2 user).
- Rotate with logrotate or cron; keep ~90 days (`WS_LOGIN_AUDIT_RETENTION_DAYS` is documented only — prune manually or add logrotate).
- Example queries (jq): same IP → many accounts: `jq -r 'select(.client_ipv4=="1.2.3.4") | .game_id' ws-login-audit.jsonl | sort -u`; one account → many IPs: `jq -r 'select(.game_id=="MyUser_M") | .client_ipv4' ws-login-audit.jsonl | sort -u`.

**QA (LOG-6):** PWA login once → one JSONL line with matching `game_id` and `client_ipv4` ≠ proxy egress (`218`). Char/map WS must not append login lines.

### Client Hints (Proxy #1–4)

- **nginx:** `Accept-CH` + `Critical-CH` on `proxy.moon-ro.com` (reload after deploy).
- **Node:** `/health` returns the same `Accept-CH` headers with CORS for allowed origins (`WS_ALLOWED_ORIGINS`) so `/play` can warm hints before WSS.
- **Enforce:** `WS_CLIENT_HINTS_ENFORCE=true`, `WS_CLIENT_HINTS_LOGIN_ONLY=true`, `WS_CLIENT_HINTS_REQUIRE=true` — blocks `?0` on login WSS; requires `ch-mobile` query (official play) or mobile UA fallback; iPad/tablet exception.
- **Metrics:** PM2 log lines `blocked_desktop_ch` (403 before Turnstile verify).
- **Play client:** `WebSocket.js` GET `https://proxy.moon-ro.com/health` once per session before login WSS (play **1.3.78+**).

## After moving proxy DNS

Retire old proxy on rom-web:

```bash
./deploy/retire-web-proxy.sh
```

## Scripts

| Script | Purpose |
|--------|---------|
| [`deploy-client.sh`](deploy-client.sh) | GRF asset server + client nginx |
| [`deploy-proxy.sh`](deploy-proxy.sh) | WS proxy + proxy nginx on rom-server |
| [`retire-web-proxy.sh`](retire-web-proxy.sh) | Stop proxy PM2 + disable nginx on rom-web |
| [`setup-server.sh`](setup-server.sh) | Bootstrap (called via `--setup`) |
| [`issue-ssl.sh`](issue-ssl.sh) | certbot webroot |
| [`sync-nginx.sh`](sync-nginx.sh) | Install role-specific nginx site |
