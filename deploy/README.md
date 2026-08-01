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
cp .env.proxy.production.example .env.proxy.production
# Cloudflare: point proxy.moon-ro.com A → rom-server IP
./deploy/deploy-proxy.sh --setup    # after DNS propagates
./deploy/deploy-proxy.sh
```

Proxy forwards to **rom-server-prd** (`43.228.86.182:6900/6121/5121`) — see `.env.proxy.production`.

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
