'use strict';

const {
  readClientHintHeaders,
  readClientHintQuery,
  mobileHintFromUserAgent,
} = require('./wsProxyClientHints');

const TTL_MS = parseInt(process.env.WS_CLIENT_HINTS_CACHE_MS || '120000', 10);
/** @type {Map<string, { mobile: string, platform: string, ua: string, expires: number }>} */
const byIp = new Map();

function rememberClientHints(clientIp, hints) {
  if (!clientIp || !hints) return;
  const mobile = hints.mobile || '';
  const platform = hints.platform || '';
  const ua = hints.ua || '';
  if (!mobile && !platform && !ua) return;
  byIp.set(clientIp, {
    mobile,
    platform,
    ua,
    expires: Date.now() + TTL_MS,
  });
}

function peekClientHints(clientIp) {
  if (!clientIp) return null;
  const row = byIp.get(clientIp);
  if (!row) return null;
  if (Date.now() > row.expires) {
    byIp.delete(clientIp);
    return null;
  }
  return { mobile: row.mobile, platform: row.platform, ua: row.ua };
}

/**
 * WebSocket upgrade often omits Sec-CH-*; merge with recent /health for same IP.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} clientIp
 */
function resolveClientHints(req, clientIp) {
  const fromUpgrade = readClientHintHeaders(req);
  const fromQuery = readClientHintQuery(req);
  const cached = peekClientHints(clientIp);
  const uaHeader = (req.headers && req.headers['user-agent']) || '';
  const fromUa = mobileHintFromUserAgent(uaHeader);
  return {
    mobile: fromUpgrade.mobile || fromQuery?.mobile || cached?.mobile || fromUa || '',
    platform: fromUpgrade.platform || fromQuery?.platform || cached?.platform || '',
    ua: fromUpgrade.ua || fromQuery?.ua || cached?.ua || '',
  };
}

module.exports = {
  rememberClientHints,
  peekClientHints,
  resolveClientHints,
};
