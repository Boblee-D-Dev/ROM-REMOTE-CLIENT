'use strict';

/**
 * Lightweight standalone WebSocket → TCP proxy for roBrowser.
 * Runs separately from the GRF asset server so gameplay traffic
 * does not share an event loop with heavy asset I/O.
 *
 * Usage:
 *   node start-ws-proxy.js
 *   # or via PM2 (see ecosystem / deploy config)
 *
 * Env (see .env.example):
 *   WS_PROXY_PORT / PORT          listen port (default 5999)
 *   WS_ALLOWED_TARGETS            host:port allowlist
 *   WS_ALLOWED_ORIGINS            browser Origin allowlist
 *   WS_REWRITE_LOGIN_PACKET       0x0888 → 0x0825 on login port
 *   WS_LOGIN_PORT                 default 6900
 *   WS_METRICS_INTERVAL_MS        snapshot log interval (default 60000)
 *   WS_METRICS_HISTORY_FILE       jsonl path (default ./logs/ws-metrics.jsonl)
 *
 * Metrics are written to disk for offline OBT analysis (SSH). No public stats API.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
require('dotenv').config();

const http = require('http');
const logger = require('./src/utils/logger');
const { attachWsProxy, createMetrics } = require('./src/wsProxy');

const port = parseInt(process.env.WS_PROXY_PORT || process.env.PORT || '5999', 10);

const ALLOWED_TARGETS = process.env.WS_ALLOWED_TARGETS
  ? process.env.WS_ALLOWED_TARGETS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['127.0.0.1:6900', '127.0.0.1:6121', '127.0.0.1:5121'];

const metrics = createMetrics();

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  // Minimal health only — OBT metrics are file/log based (SSH), not a public API.
  if (url === '/api/health' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'moon-ws-proxy' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('moon-ws-proxy: use WebSocket /ws/<host>:<port>\n');
});

attachWsProxy(server, { allowedTargets: ALLOWED_TARGETS, metrics });

server.listen(port, process.env.HOST || '127.0.0.1', () => {
  const host = process.env.HOST || '127.0.0.1';
  logger.info(`WS proxy standalone listening on http://${host}:${port} (WS path /ws/)`);
  logger.info(`WS metrics: writing ${metrics.historyPath} every ${process.env.WS_METRICS_INTERVAL_MS || '60000'}ms (SSH only)`);
});
