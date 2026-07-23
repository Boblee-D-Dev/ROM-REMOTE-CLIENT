# nginx — Moon Remote Client + WS Proxy

Synced from **rom-web** on 2026-07-23.

| File | Live path | Upstream |
|------|-----------|----------|
| [`client.moon-ro.com.conf`](client.moon-ro.com.conf) | `/etc/nginx/sites-available/client.moon-ro.com` | `127.0.0.1:3338` (GRF / assets) |
| [`proxy.moon-ro.com.conf`](proxy.moon-ro.com.conf) | `/etc/nginx/sites-available/proxy.moon-ro.com` | `127.0.0.1:5999` (WSS → TCP) |

## Apply on a server

```bash
# example
scp deploy/nginx/client.moon-ro.com.conf root@HOST:/etc/nginx/sites-available/client.moon-ro.com
scp deploy/nginx/proxy.moon-ro.com.conf  root@HOST:/etc/nginx/sites-available/proxy.moon-ro.com
ssh root@HOST 'ln -sf /etc/nginx/sites-available/client.moon-ro.com /etc/nginx/sites-enabled/
               ln -sf /etc/nginx/sites-available/proxy.moon-ro.com  /etc/nginx/sites-enabled/
               nginx -t && systemctl reload nginx'
```

Adjust SSL cert paths / upstream ports per host. Certbot-managed blocks are kept as on production.
