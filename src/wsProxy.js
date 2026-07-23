'use strict';

const net = require('net');
const logger = require('./utils/logger');
const { createMetrics } = require('./wsProxyMetrics');

/** Official SSO login packet ID expected by rAthena */
const PACKET_CA_SSO_LOGIN_REQ = 0x0825;
/** roBrowser currently emits this ID for the same SSO login body */
const PACKET_CA_SSO_LOGIN_REQ_ROBROWSER = 0x0888;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://moon-ro.com',
  'https://www.moon-ro.com',
  '127.0.0.1',
  'localhost',
  'robrowser.test',
];

/**
 * Parse WS_ALLOWED_ORIGINS env (comma-separated).
 * Entries may be full origins (https://moon-ro.com) or hostnames (127.0.0.1, robrowser.test).
 */
function parseAllowedOrigins(raw) {
  if (!raw || !String(raw).trim()) {
    return DEFAULT_ALLOWED_ORIGINS.slice();
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string|undefined} origin
 * @param {string[]} allowList
 */
function isAllowedOrigin(origin, allowList) {
  if (!origin) return false;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const originNorm = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  const host = parsed.hostname.toLowerCase();

  for (const entry of allowList) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;

    // Full origin match (optionally ignore default ports already normalized by URL)
    if (rule.includes('://')) {
      try {
        const allowed = new URL(rule);
        const allowedNorm = `${allowed.protocol}//${allowed.host}`.toLowerCase();
        if (originNorm === allowedNorm) return true;
        // Allow any port when rule has no explicit port and host+protocol match
        if (
          !rule.match(/:\d+$/) &&
          allowed.protocol === parsed.protocol &&
          allowed.hostname.toLowerCase() === host
        ) {
          return true;
        }
      } catch {
        // fall through
      }
      continue;
    }

    // Hostname-only rule: any scheme/port
    if (host === rule || host.endsWith(`.${rule}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Rewrite roBrowser SSO login header 0x0888 → 0x0825 (body unchanged).
 * Only safe on the login server port — on map/char, 0x0888 is a shuffled packet.
 *
 * @param {Buffer|ArrayBuffer|Buffer[]} data
 * @returns {Buffer}
 */
function rewriteLoginPacket(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 2) return buf;
  if (buf.readUInt16LE(0) !== PACKET_CA_SSO_LOGIN_REQ_ROBROWSER) return buf;

  const out = Buffer.from(buf);
  out.writeUInt16LE(PACKET_CA_SSO_LOGIN_REQ, 0);
  logger.info(
    `WS proxy: rewrote login packet 0x${PACKET_CA_SSO_LOGIN_REQ_ROBROWSER.toString(16)} → 0x${PACKET_CA_SSO_LOGIN_REQ.toString(16)}`
  );
  return out;
}

/**
 * Attach embedded WebSocket → TCP proxy to an HTTP server.
 *
 * @param {import('http').Server} server
 * @param {object} [options]
 * @param {string[]} [options.allowedTargets]
 * @param {string[]} [options.allowedOrigins]
 * @param {boolean} [options.rewriteLoginPacket]
 * @param {number} [options.loginPort]
 */
function attachWsProxy(server, options = {}) {
  const WebSocket = require('ws');
  const ALLOWED_TARGETS = options.allowedTargets || [
    '127.0.0.1:6900',
    '127.0.0.1:6121',
    '127.0.0.1:5121',
  ];
  const ALLOWED_ORIGINS = options.allowedOrigins || parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS);
  const REWRITE_LOGIN =
    options.rewriteLoginPacket !== undefined
      ? !!options.rewriteLoginPacket
      : process.env.WS_REWRITE_LOGIN_PACKET !== 'false';
  const LOGIN_PORT = options.loginPort || parseInt(process.env.WS_LOGIN_PORT || '6900', 10);

  const metrics = options.metrics || createMetrics({ loginPort: LOGIN_PORT });
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws/')) {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, ALLOWED_ORIGINS)) {
      logger.warn(`WS proxy blocked origin: ${origin || '(none)'}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const target = req.url.slice('/ws/'.length);
    const colonIdx = target.lastIndexOf(':');
    const host = colonIdx !== -1 ? target.slice(0, colonIdx) : '';
    const targetPort = colonIdx !== -1 ? parseInt(target.slice(colonIdx + 1), 10) : NaN;

    if (!host || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      logger.warn(`WS proxy rejected malformed target: "${target}"`);
      ws.close();
      return;
    }

    logger.info(`WS attempt: ${target} origin=${req.headers.origin || '(none)'}`);

    if (!ALLOWED_TARGETS.includes(target)) {
      logger.warn(`WS proxy blocked: ${target} (allowed: ${ALLOWED_TARGETS.join(', ')})`);
      ws.close();
      return;
    }

    // Soft block common emulator UAs (client gate is primary). Allow robrowser.test for local dev.
    const origin = req.headers.origin || '';
    const ua = req.headers['user-agent'] || '';
    const isDevOrigin = /robrowser\.test/i.test(origin);
    if (
      !isDevOrigin &&
      /Android SDK built for|sdk_gphone|Emulator|Genymotion|goldfish|ranchu|BlueStacks|LDPlayer|Nox/i.test(ua)
    ) {
      logger.warn(`WS proxy blocked emulator UA origin=${origin}`);
      ws.close();
      return;
    }

    const metricId = metrics.trackConnect(req, target, targetPort);
    const isLoginTarget = targetPort === LOGIN_PORT;
    const shouldRewrite = REWRITE_LOGIN && isLoginTarget;

    logger.info(`WS proxy: connecting to ${target}`);
    const tcp = net.connect(targetPort, host);
    tcp.setNoDelay(true);

    const MAX_PENDING = 64;
    const pending = [];
    let connected = false;

    let cleaned = false;
    const cleanup = (reason) => {
      if (cleaned) return;
      cleaned = true;
      metrics.trackDisconnect(metricId, reason);
      logger.info(`WS proxy: closed ${target} (${reason})`);
      if (!tcp.destroyed) tcp.destroy();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    const toServer = (data) => {
      const payload = shouldRewrite ? rewriteLoginPacket(data) : (Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (connected) {
        tcp.write(payload);
      } else if (pending.length < MAX_PENDING) {
        pending.push(payload);
      } else {
        logger.warn(`WS proxy: pending queue full for ${target}, dropping message`);
      }
    };

    tcp.on('connect', () => {
      connected = true;
      logger.info(`WS proxy: connected  to ${target}`);
      pending.splice(0).forEach((d) => tcp.write(d));
    });

    ws.on('message', toServer);

    tcp.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    ws.on('close', () => cleanup('client closed'));
    ws.on('error', (err) => cleanup(`client error: ${err.message}`));
    tcp.on('close', () => cleanup('server closed'));
    tcp.on('error', (err) => cleanup(`server error: ${err.message}`));
  });

  logger.info(`WebSocket proxy enabled on /ws/ (allowed targets: ${ALLOWED_TARGETS.join(', ')})`);
  logger.info(`WS proxy allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  if (REWRITE_LOGIN) {
    logger.info(
      `WS proxy login rewrite: 0x${PACKET_CA_SSO_LOGIN_REQ_ROBROWSER.toString(16)} → 0x${PACKET_CA_SSO_LOGIN_REQ.toString(16)} on port ${LOGIN_PORT}`
    );
  }
  logger.info(`WS metrics history: ${metrics.historyPath}`);

  return { wss, ALLOWED_TARGETS, ALLOWED_ORIGINS, metrics };
}

module.exports = {
  attachWsProxy,
  isAllowedOrigin,
  parseAllowedOrigins,
  rewriteLoginPacket,
  createMetrics,
  PACKET_CA_SSO_LOGIN_REQ,
  PACKET_CA_SSO_LOGIN_REQ_ROBROWSER,
  DEFAULT_ALLOWED_ORIGINS,
};
