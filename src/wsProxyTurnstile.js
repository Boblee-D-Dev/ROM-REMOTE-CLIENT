'use strict';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function envFlag(name, defaultWhenSet) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultWhenSet;
  return v !== 'false' && v !== '0';
}

/**
 * @param {number} targetPort
 * @param {number} loginPort
 */
function shouldEnforceTurnstile(targetPort, loginPort) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !String(secret).trim()) return false;
  if (!envFlag('WS_TURNSTILE_ENFORCE', true)) return false;
  if (envFlag('WS_TURNSTILE_LOGIN_ONLY', true)) {
    return targetPort === loginPort;
  }
  return true;
}

/**
 * @param {import('http').IncomingMessage} req
 */
function extractTurnstileToken(req) {
  try {
    const parsed = new URL(req.url || '', 'http://ws-proxy.local');
    const fromQuery = parsed.searchParams.get('cf-turnstile-response');
    if (fromQuery) return fromQuery;
  } catch {
    // ignore malformed URL
  }
  const header = req.headers && req.headers['cf-turnstile-response'];
  return typeof header === 'string' ? header : '';
}

/**
 * @param {import('http').IncomingMessage} req
 */
function resolveClientIp(req) {
  const headers = req.headers || {};
  const xReal = headers['x-real-ip'];
  if (typeof xReal === 'string' && xReal.trim()) return xReal.trim();
  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

/**
 * @param {string|undefined} token
 * @param {string|null|undefined} remoteIp
 */
async function verifyTurnstileToken(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !String(secret).trim()) {
    return { ok: true, skipped: true, reason: 'no_secret' };
  }
  if (!token) {
    return { ok: false, reason: 'missing_token' };
  }

  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);

  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.WS_TURNSTILE_VERIFY_TIMEOUT_MS || '8000', 10);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `siteverify_http_${res.status}` };
    }
    const data = await res.json();
    return {
      ok: data.success === true,
      reason: data.success ? 'ok' : 'invalid_token',
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, reason: 'siteverify_timeout' };
    }
    return { ok: false, reason: 'siteverify_error' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Strip /ws/host:port from upgrade URL (ignore query string).
 * @param {string|undefined} url
 */
function parseWsTargetPath(url) {
  if (!url || !url.startsWith('/ws/')) return null;
  let rest = url.slice('/ws/'.length);
  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) rest = rest.slice(0, qIdx);
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx === -1) return null;
  const host = rest.slice(0, colonIdx);
  const targetPort = parseInt(rest.slice(colonIdx + 1), 10);
  if (!host || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return null;
  }
  return { host, targetPort, target: rest };
}

module.exports = {
  shouldEnforceTurnstile,
  verifyTurnstileToken,
  resolveClientIp,
  extractTurnstileToken,
  parseWsTargetPath,
  envFlag,
};
