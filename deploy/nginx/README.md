# nginx — Moon Remote

| File | Host | Domain | Upstream |
|------|------|--------|----------|
| [`client.moon-ro.com.conf`](client.moon-ro.com.conf) | rom-web | client.moon-ro.com | `127.0.0.1:3338` |
| [`proxy.moon-ro.com.conf.template`](proxy.moon-ro.com.conf.template) | rom-server | proxy.moon-ro.com | `127.0.0.1:5999` |
| [`proxy.moon-ro.com.conf`](proxy.moon-ro.com.conf) | rom-web (legacy) | proxy.moon-ro.com | reference snapshot |

Apply via `./deploy/deploy-client.sh` or `./deploy/deploy-proxy.sh`.

Proxy cert on rom-server: `/etc/letsencrypt/live/proxy.moon-ro.com/`.
