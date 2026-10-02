'use strict';

function envFlag(name, defaultWhenUnset) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultWhenUnset;
  return v !== 'false' && v !== '0';
}

/**
 * Fixed-window counter per key (IP). In-memory only — resets on process restart.
 *
 * @param {object} [options]
 */
function createRateLimiter(options = {}) {
  const enabled = options.enabled !== undefined ? options.enabled : envFlag('WS_RATE_LIMIT_LOGIN', true);
  const windowMs =
    options.windowMs || parseInt(process.env.WS_RATE_LIMIT_LOGIN_WINDOW_MS || '60000', 10);
  const maxAttempts =
    options.maxAttempts || parseInt(process.env.WS_RATE_LIMIT_LOGIN_MAX || '40', 10);

  /** @type {Map<string, { count: number, windowStart: number }>} */
  const buckets = new Map();

  function prune(now) {
    if (buckets.size < 5000) return;
    for (const [key, row] of buckets) {
      if (now - row.windowStart > windowMs * 2) buckets.delete(key);
    }
  }

  /**
   * @param {string} key e.g. client IP
   * @returns {{ allowed: boolean, count: number, limit: number }}
   */
  function check(key) {
    if (!enabled || !key) {
      return { allowed: true, count: 0, limit: maxAttempts };
    }
    const now = Date.now();
    prune(now);
    let row = buckets.get(key);
    if (!row || now - row.windowStart >= windowMs) {
      row = { count: 0, windowStart: now };
      buckets.set(key, row);
    }
    row.count += 1;
    return {
      allowed: row.count <= maxAttempts,
      count: row.count,
      limit: maxAttempts,
    };
  }

  return {
    enabled,
    windowMs,
    maxAttempts,
    check,
  };
}

/**
 * @param {number} targetPort
 * @param {number} loginPort
 */
function shouldRateLimitLogin(targetPort, loginPort) {
  if (!envFlag('WS_RATE_LIMIT_LOGIN', true)) return false;
  if (envFlag('WS_RATE_LIMIT_LOGIN_ONLY', true)) {
    return targetPort === loginPort;
  }
  return true;
}

module.exports = {
  createRateLimiter,
  shouldRateLimitLogin,
};
