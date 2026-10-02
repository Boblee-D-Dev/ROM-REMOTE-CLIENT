'use strict';

const net = require('net');
const logger = require('./utils/logger');
const { createMetrics } = require('./wsProxyMetrics');
const {
  shouldEnforceTurnstile,
  verifyTurnstileToken,
  resolveClientIp,
  extractTurnstileToken,
  parseWsTargetPath,
} = require('./wsProxyTurnstile');
const { createLoginAuditLogger } = require('./wsProxyLoginAudit');
const { evaluateClientHints } = require('./wsProxyClientHints');
const { resolveClientHints } = require('./wsProxyClientHintCache');
const { evaluateUserAgentGate } = require('./wsProxyUserAgent');
const { createRateLimiter, shouldRateLimitLogin } = require('./wsProxyRateLimit');

/** Official SSO login packet ID expected by rAthena */
const PACKET_CA_SSO_LOGIN_REQ = 0x0825;
/** roBrowser currently emits this ID for the same SSO login body */
const PACKET_CA_SSO_LOGIN_REQ_ROBROWSER = 0x0888;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://moon-ro.com',
  'https://www.moon-ro.com',
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
  const loginAudit =
    options.loginAudit ||
    createLoginAuditLogger({ auditPath: process.env.WS_LOGIN_AUDIT_PATH });
  const loginRateLimit = options.loginRateLimit || createRateLimiter();
  const wss = new WebSocket.Server({ noServer: true });

  function rejectUpgrade(socket, statusLine, logMsg) {
    logger.warn(logMsg);
    socket.write(`${statusLine}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws/')) {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, ALLOWED_ORIGINS)) {
      rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden', `WS proxy blocked origin: ${origin || '(none)'}`);
      return;
    }

    const parsedTarget = parseWsTargetPath(req.url);
    if (!parsedTarget) {
      rejectUpgrade(socket, 'HTTP/1.1 400 Bad Request', `WS proxy rejected malformed upgrade url: ${req.url}`);
      return;
    }

    const { target, targetPort } = parsedTarget;
    const upgradeClientIp = resolveClientIp(req);
    const clientHints = resolveClientHints(req, upgradeClientIp);

    const chResult = evaluateClientHints(
      req,
      {
        targetPort,
        loginPort: LOGIN_PORT,
        origin: origin || '',
      },
      clientHints
    );
    if (chResult.block) {
      if (typeof metrics.recordBlockedDesktopCh === 'function') {
        metrics.recordBlockedDesktopCh(chResult.reason || 'desktop_ch');
      }
      rejectUpgrade(
        socket,
        'HTTP/1.1 403 Forbidden',
        `WS proxy blocked client-hints target=${target} reason=${chResult.reason || 'desktop_ch'} mobile=${chResult.hints.mobile || '(none)'}`
      );
      return;
    }

    const uaResult = evaluateUserAgentGate(
      req,
      { targetPort, loginPort: LOGIN_PORT, origin: origin || '' },
      clientHints
    );
    if (uaResult.block) {
      const reason = uaResult.reason || 'ua_gate';
      if (reason.startsWith('desktop_ua') && typeof metrics.recordBlockedDesktopUa === 'function') {
        metrics.recordBlockedDesktopUa(reason);
      } else if (typeof metrics.recordBlockedEmulatorUa === 'function') {
        metrics.recordBlockedEmulatorUa(reason);
      }
      rejectUpgrade(
        socket,
        'HTTP/1.1 403 Forbidden',
        `WS proxy blocked ua target=${target} reason=${reason} ua=${(req.headers['user-agent'] || '').slice(0, 120)}`
      );
      return;
    }

    if (shouldRateLimitLogin(targetPort, LOGIN_PORT)) {
      const rl = loginRateLimit.check(upgradeClientIp || 'unknown');
      if (!rl.allowed) {
        if (typeof metrics.recordBlockedRateLimit === 'function') {
          metrics.recordBlockedRateLimit('login_upgrade');
        }
        rejectUpgrade(
          socket,
          'HTTP/1.1 429 Too Many Requests',
          `WS proxy rate limit ip=${upgradeClientIp} count=${rl.count} limit=${rl.limit} target=${target}`
        );
        return;
      }
    }

    const runVerify = async () => {
      if (!shouldEnforceTurnstile(targetPort, LOGIN_PORT)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
        return;
      }

      const token = extractTurnstileToken(req);
      const clientIp = resolveClientIp(req);
      const result = await verifyTurnstileToken(token, clientIp);
      if (!result.ok) {
        if (typeof metrics.recordBlockedTurnstile === 'function') {
          metrics.recordBlockedTurnstile(result.reason || 'blocked');
        }
        rejectUpgrade(
          socket,
          'HTTP/1.1 403 Forbidden',
          `WS proxy blocked turnstile target=${target} reason=${result.reason || 'unknown'}`
        );
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    };

    runVerify().catch((err) => {
      rejectUpgrade(
        socket,
        'HTTP/1.1 503 Service Unavailable',
        `WS proxy turnstile verify error: ${err.message}`
      );
    });
  });

  wss.on('connection', (ws, req) => {
    const parsedTarget = parseWsTargetPath(req.url);
    if (!parsedTarget) {
      logger.warn(`WS proxy rejected malformed target url: "${req.url || ''}"`);
      ws.close();
      return;
    }

    const { host, targetPort, target } = parsedTarget;

    logger.info(`WS attempt: ${target} origin=${req.headers.origin || '(none)'}`);

    if (!ALLOWED_TARGETS.includes(target)) {
      logger.warn(`WS proxy blocked: ${target} (allowed: ${ALLOWED_TARGETS.join(', ')})`);
      ws.close();
      return;
    }

    const metricId = metrics.trackConnect(req, target, targetPort);
    const isLoginTarget = targetPort === LOGIN_PORT;
    const shouldRewrite = REWRITE_LOGIN && isLoginTarget;
    const clientIp = resolveClientIp(req);
    const turnstileEnforced = shouldEnforceTurnstile(targetPort, LOGIN_PORT);
    let loginAuditLogged = false;
    const auditCtx = () => {
      const ch = resolveClientHints(req, clientIp);
      const uaHeader = (req.headers && req.headers['user-agent']) || '';
      return {
        alreadyLogged: loginAuditLogged,
        clientIp,
        origin: req.headers.origin,
        ws_target: target,
        turnstile_enforced: turnstileEnforced,
        sec_ch_mobile: ch.mobile || null,
        sec_ch_platform: ch.platform || null,
        sec_ch_ua: ch.ua || null,
        sec_ch_ua_model: ch.model || null,
        sec_ch_ua_platform_version: ch.platformVersion || null,
        user_agent_snip: uaHeader ? String(uaHeader).slice(0, 240) : null,
      };
    };

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
      if (isLoginTarget && loginAudit.enabled) {
        if (loginAudit.tryLogLoginPacket(data, auditCtx())) {
          loginAuditLogged = true;
        }
      }
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
  if (process.env.TURNSTILE_SECRET_KEY) {
    const loginOnly = process.env.WS_TURNSTILE_LOGIN_ONLY !== 'false';
    const enforce = process.env.WS_TURNSTILE_ENFORCE !== 'false';
    logger.info(
      `WS proxy turnstile: secret=set enforce=${enforce} loginPortOnly=${loginOnly} loginPort=${LOGIN_PORT}`
    );
  } else {
    logger.info('WS proxy turnstile: secret not set (verification disabled)');
  }
  logger.info(`WS metrics history: ${metrics.historyPath}`);
  if (loginAudit.enabled) {
    logger.info(`WS login audit: enabled path=${loginAudit.auditPath}`);
  } else {
    logger.info('WS login audit: disabled (set WS_LOGIN_AUDIT_PATH or WS_LOGIN_AUDIT=1)');
  }
  logger.info(
    `WS proxy ua gate: emulator=${process.env.WS_UA_EMULATOR_BLOCK !== 'false'} desktop=${process.env.WS_UA_DESKTOP_BLOCK !== 'false'} loginOnly=${process.env.WS_UA_GATE_LOGIN_ONLY !== 'false'}`
  );
  logger.info(
    `WS proxy rate limit login: enabled=${loginRateLimit.enabled} max=${loginRateLimit.maxAttempts}/${loginRateLimit.windowMs}ms`
  );

  return { wss, ALLOWED_TARGETS, ALLOWED_ORIGINS, metrics, loginAudit, loginRateLimit };
}

module.exports = {
  attachWsProxy,
  isAllowedOrigin,
  parseAllowedOrigins,
  parseWsTargetPath,
  rewriteLoginPacket,
  createMetrics,
  createLoginAuditLogger,
  PACKET_CA_SSO_LOGIN_REQ,
  PACKET_CA_SSO_LOGIN_REQ_ROBROWSER,
  DEFAULT_ALLOWED_ORIGINS,
};
