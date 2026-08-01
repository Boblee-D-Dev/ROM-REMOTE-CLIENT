# rom-remote — deploy

Deploy **GRF asset server** (`client.moon-ro.com`) and **WebSocket proxy** (`proxy.moon-ro.com`).

SSL uses **Let's Encrypt (certbot)** — separate from moon-ro.com (Cloudflare Origin in rom-frontend).

## Quick start (new VPS)

1. VPS: Ubuntu, port **80** open for certbot challenge, **443** for HTTPS/WSS.
2. DNS: `A` records for `client.moon-ro.com` and `proxy.moon-ro.com` → VPS IP.
3. Local config:
   ```bash
   cp deploy/deploy.env.example deploy/deploy.env
   cp .env.example .env.production
   # edit VPS_HOST, CERTBOT_EMAIL, GRF paths, etc.
   chmod +x deploy/*.sh deploy/lib/common.sh
   ./deploy/deploy.sh --setup
   ```

## Routine deploy

```bash
./deploy/deploy.sh
```

## PM2 apps

| App | Port | nginx domain |
|-----|------|--------------|
| `moon-remote-client` | 3338 | client.moon-ro.com |
| `moon-ws-proxy` | 5999 | proxy.moon-ro.com |

## Related repos

| Repo | Deploy | SSL |
|------|--------|-----|
| **rom-remote** (this) | `./deploy/deploy.sh` | certbot |
| **rom-frontend** | `./deploy/deploy.sh` | Cloudflare Origin |
| **ror-browser** | `./deploy-play.sh` | — |

## Scripts

| Script | Purpose |
|--------|---------|
| [`deploy.sh`](deploy.sh) | rsync + npm + PM2 + nginx |
| [`setup-server.sh`](setup-server.sh) | First boot: nginx, NVM/PM2, certbot |
| [`issue-ssl.sh`](issue-ssl.sh) | certbot webroot issuance |
| [`sync-nginx.sh`](sync-nginx.sh) | Copy nginx configs → VPS |

Nginx reference: [`deploy/nginx/`](nginx/).
