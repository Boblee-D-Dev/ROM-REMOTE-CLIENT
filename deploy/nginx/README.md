# nginx — Moon Remote Client + WS Proxy

| File | Live path | Upstream |
|------|-----------|----------|
| [`client.moon-ro.com.conf`](client.moon-ro.com.conf) | `/etc/nginx/sites-available/client.moon-ro.com` | `127.0.0.1:3338` |
| [`proxy.moon-ro.com.conf`](proxy.moon-ro.com.conf) | `/etc/nginx/sites-available/proxy.moon-ro.com` | `127.0.0.1:5999` |

SSL: **certbot** — both domains share `/etc/letsencrypt/live/client.moon-ro.com/`.

Apply: `./deploy/deploy.sh` or `./deploy/sync-nginx.sh`.

Adjust upstream ports in `deploy/deploy.env` (`CLIENT_PORT`, `PROXY_PORT`) if you change Node bindings — update these nginx files to match.
