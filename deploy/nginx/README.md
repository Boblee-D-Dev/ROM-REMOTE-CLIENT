# nginx — Moon Remote

| File | Host | Domain | Upstream |
|------|------|--------|----------|
| [`client.moon-ro.com.conf`](client.moon-ro.com.conf) | rom-web | client.moon-ro.com | `127.0.0.1:3338` |
| [`proxy.moon-ro.com.conf.template`](proxy.moon-ro.com.conf.template) | rom-server | proxy.moon-ro.com | `127.0.0.1:5999` |
| [`proxy.moon-ro.com.conf`](proxy.moon-ro.com.conf) | rom-web (legacy) | proxy.moon-ro.com | reference snapshot |
| [`moon-proxy-track-log-format.conf`](moon-proxy-track-log-format.conf) | rom-server | — | `log_format moon_proxy_track` → `/etc/nginx/conf.d/` |

Apply via `./deploy/deploy-client.sh` or `./deploy/deploy-proxy.sh`.

Proxy cert on rom-server: `/etc/letsencrypt/live/proxy.moon-ro.com/`.
