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

When `WS_LOGIN_AUDIT=1` or `WS_LOGIN_AUDIT_PATH` is set, wsProxy appends one line per **login-port** SSO packet (`0x0888` / `0x0825`): UTC timestamp, `client_ipv4`, `game_id`, `origin`, `turnstile_enforced`, optional `sec_ch_mobile` / `sec_ch_platform` / `sec_ch_ua` / `sec_ch_ua_model` / `sec_ch_ua_platform_version`, truncated `user_agent_snip`, `ws_target`. **Never** logs password, Turnstile token, or MAC from the packet body.

Default path: `./logs/ws-login-audit.jsonl` (under app dir on VPS, e.g. `/var/www/moon-ws-proxy/logs/`).

JSONL field `turnstile_enforced` = Turnstile was required on this login-port connection (not “user failed captcha”). Requires `TURNSTILE_SECRET_KEY` in deploy env — copy from rom-web `/var/www/rom-frontend/.env`.

**Ops**

- Read on proxy VPS only; restrict file permissions (`chmod 640`, owner = PM2 user).
- Rotate with logrotate or cron; keep ~90 days (`WS_LOGIN_AUDIT_RETENTION_DAYS` is documented only — prune manually or add logrotate).
- Example queries (jq): same IP → many accounts: `jq -r 'select(.client_ipv4=="1.2.3.4") | .game_id' ws-login-audit.jsonl | sort -u`; one account → many IPs: `jq -r 'select(.game_id=="MyUser_M") | .client_ipv4' ws-login-audit.jsonl | sort -u`.

**QA (LOG-6):** PWA login once → one JSONL line with matching `game_id` and `client_ipv4` ≠ proxy egress (`218`). Char/map WS must not append login lines.

### WSS access log (`ws-access.jsonl`, ALOG)

When `WS_ACCESS_LOG=1` or `WS_ACCESS_LOG_PATH` is set, wsProxy appends one JSONL line per **WSS upgrade attempt** that reaches Node (after nginx): `outcome` `allowed` | `blocked`, `http_status`, `block_reason`, `login_id` (from query `login-id` / `game-id`), client IP fields, truncated UA, Sec-CH fields, `ch_mobile_query`, `turnstile_query_present` (boolean only), `origin`, `ws_target`, `target_port`. **Never** logs Turnstile token value.

Default path: `./logs/ws-access.jsonl`. Default **`WS_ACCESS_LOG_LOGIN_ONLY=true`** — login port (6900) upgrades only; set `false` to include char/map (6121/5121).

**Ops**

- Same permissions/rotation as login audit (`chmod 640`, ~90 days).
- PM2 startup log must show `WS access log: enabled path=...`.
- **nginx:** `moon_proxy_track` JSON `access_log` + `conf.d/moon-proxy-track-log-format.conf` (edge UA/CH even when Node rejects) — installed by `sync-nginx.sh` on proxy deploy.
- **Play client 1.3.99:** `login-id=` + `ch-mobile` on login WSS (TAB client; deploy with proxy batch).

Example (blocked Android tablet at CH gate):

```bash
jq -r 'select(.outcome=="blocked") | [.ts,.block_reason,.login_id,.sec_ch_mobile,.user_agent_snip] | @tsv' logs/ws-access.jsonl | tail -20
```

Backlog: [`rom-server/docs/play-proxy-access-log-android-tablet-backlog.md`](../../rom-server/docs/play-proxy-access-log-android-tablet-backlog.md).

### Client Hints (Proxy #1–4)

- **nginx:** `Accept-CH` + `Critical-CH` on `proxy.moon-ro.com` (reload after deploy).
- **Node:** `/health` returns the same `Accept-CH` headers with CORS for allowed origins (`WS_ALLOWED_ORIGINS`) so `/play` can warm hints before WSS.
- **Enforce:** `WS_CLIENT_HINTS_ENFORCE=true`, `WS_CLIENT_HINTS_LOGIN_ONLY=true`, `WS_CLIENT_HINTS_REQUIRE=true` — blocks `?0` on login WSS; requires `ch-mobile` query (official play) or mobile UA fallback; iPad + **Android tablet** exception; **ARM + Desktop site** (`Linux x86_64` UA + Turnstile + play `ch-mobile=?1` merge) — see `docs/play-proxy-access-log-android-tablet-backlog.md` TAB.
- **Metrics:** PM2 log lines `blocked_desktop_ch` (403 before Turnstile verify).
- **Play client:** `WebSocket.js` GET `https://proxy.moon-ro.com/health` once per session before login WSS (play **1.3.78+**).

### UA gate (#5) + emulator UA + rate limit (#9)

- **Order on login WSS:** Client Hints → **UA gate** → **rate limit** → Turnstile → TCP.
- **Emulator UA:** `WS_UA_EMULATOR_BLOCK=true` (default) — LDPlayer / BlueStacks / sdk_gphone / x86 Android UA → **403** · metric `blocked_emulator_ua`.
- **Desktop UA:** `WS_UA_DESKTOP_BLOCK=true` — Windows/macOS/Linux desktop UA on login WSS (incl. `?1` + desktop UA spoof) → **403** · metric `blocked_desktop_ua`.
- **Rate limit:** `WS_RATE_LIMIT_LOGIN=true` — max **40** login upgrades / **60s** / client IP (tune via env) → **429** · metric `blocked_rate_limit`.
- **Accept-CH:** nginx + `/health` request `Sec-CH-UA-Model` for audit (**EMU-12**).

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
