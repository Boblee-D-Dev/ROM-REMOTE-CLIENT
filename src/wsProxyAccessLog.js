'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeClientIp } = require('./wsProxyLoginAudit');

const LOGIN_ID_MAX = 24;

function envFlag(name, defaultWhenSet) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultWhenSet;
  return v !== 'false' && v !== '0';
}

/**
 * @param {string|undefined} raw
 */
function sanitizeLoginId(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.length > LOGIN_ID_MAX ? s.slice(0, LOGIN_ID_MAX) : s;
}

/**
 * Query params safe for access log (never log Turnstile token value).
 *
 * @param {import('http').IncomingMessage} req
 */
function readUpgradeQuery(req) {
  try {
    const parsed = new URL(req.url || '', 'http://ws-proxy.local');
    const loginId =
      sanitizeLoginId(parsed.searchParams.get('login-id')) ||
      sanitizeLoginId(parsed.searchParams.get('game-id'));
    const chMobileQuery = parsed.searchParams.get('ch-mobile');
    const turnstilePresent = parsed.searchParams.has('cf-turnstile-response');
    return {
      login_id: loginId,
      ch_mobile_query: chMobileQuery ? chMobileQuery.trim().slice(0, 8) : null,
      turnstile_query_present: turnstilePresent,
    };
  } catch {
    return {
      login_id: null,
      ch_mobile_query: null,
      turnstile_query_present: false,
    };
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {object} hints from resolveClientHints
 */
function baseUpgradeFields(req, hints = {}) {
  const uaHeader = (req.headers && req.headers['user-agent']) || '';
  const query = readUpgradeQuery(req);
  return {
    origin: (req.headers && req.headers.origin) || null,
    user_agent_snip: uaHeader ? String(uaHeader).slice(0, 240) : null,
    sec_ch_mobile: hints.mobile || null,
    sec_ch_platform: hints.platform || null,
    sec_ch_ua: hints.ua || null,
    sec_ch_ua_model: hints.model || null,
    sec_ch_ua_platform_version: hints.platformVersion || null,
    sec_ch_ua_arch: hints.arch || null,
    ch_mobile_query: query.ch_mobile_query,
    turnstile_query_present: query.turnstile_query_present,
    login_id: query.login_id,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.accessPath]
 * @param {number} [options.loginPort]
 */
function createAccessLogger(options = {}) {
  const loginPort = options.loginPort || parseInt(process.env.WS_LOGIN_PORT || '6900', 10);
  const enabled =
    process.env.WS_ACCESS_LOG === '1' ||
    process.env.WS_ACCESS_LOG === 'true' ||
    !!(options.accessPath || process.env.WS_ACCESS_LOG_PATH);
  /** default true = login port only (6900); set WS_ACCESS_LOG_LOGIN_ONLY=false for all ports */
  const loginOnly = envFlag('WS_ACCESS_LOG_LOGIN_ONLY', true);
  const accessPath =
    options.accessPath ||
    process.env.WS_ACCESS_LOG_PATH ||
    path.join(process.cwd(), 'logs', 'ws-access.jsonl');

  if (enabled) {
    fs.mkdirSync(path.dirname(accessPath), { recursive: true });
  }

  /**
   * @param {object} row
   */
  function append(row) {
    if (!enabled) return;
    const line = `${JSON.stringify(row)}\n`;
    fs.appendFile(accessPath, line, (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error(`WS access log write failed: ${err.message}`);
      }
    });
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {object} ctx
   * @param {number|null} ctx.targetPort
   * @param {string|null} ctx.ws_target
   * @param {string|null|undefined} ctx.clientIp
   * @param {object} [ctx.hints]
   * @param {'allowed'|'blocked'} ctx.outcome
   * @param {number} [ctx.http_status]
   * @param {string|null} [ctx.block_reason]
   */
  function logUpgrade(req, ctx) {
    if (!enabled) return;
    if (loginOnly && ctx.targetPort !== loginPort) return;

    const ipFields = normalizeClientIp(ctx.clientIp);
    append({
      ts: new Date().toISOString(),
      event: 'ws_upgrade',
      outcome: ctx.outcome,
      http_status: ctx.http_status || (ctx.outcome === 'allowed' ? 101 : 403),
      block_reason: ctx.block_reason || null,
      ws_target: ctx.ws_target,
      target_port: ctx.targetPort,
      ...ipFields,
      ...baseUpgradeFields(req, ctx.hints || {}),
    });
  }

  return {
    enabled,
    accessPath,
    loginOnly,
    logUpgrade,
    readUpgradeQuery,
    sanitizeLoginId,
  };
}

module.exports = {
  createAccessLogger,
  readUpgradeQuery,
  sanitizeLoginId,
  baseUpgradeFields,
};
