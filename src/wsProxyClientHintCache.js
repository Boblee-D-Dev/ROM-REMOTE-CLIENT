'use strict';

const {
  readClientHintHeaders,
  readClientHintQuery,
  mobileHintFromUserAgent,
  isLinuxX86DesktopClassUa,
  readArmDesktopSiteProfile,
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
    model: hints.model || '',
    platformVersion: hints.platformVersion || '',
    arch: hints.arch || '',
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
 * @param {import('http').IncomingMessage} req
 */
function isTrustedOriginForChQuery(req) {
  const origin = (req.headers && req.headers.origin) || '';
  if (/robrowser\.test/i.test(origin)) return true;
  if (/^https:\/\/(www\.)?moon-ro\.com$/i.test(origin)) return true;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return true;
  return false;
}

/**
 * Wire Sec-CH-UA-Mobile ?0 wins in Chrome even when play sends ch-mobile=?1 — prefer query for ARM desktop-site.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} uaHeader
 * @param {string} wireMobile
 * @param {string|undefined} queryMobile
 */
function pickMergedMobile(req, uaHeader, wireMobile, queryMobile) {
  const q = queryMobile === '?1' || queryMobile === '1' ? '?1' : queryMobile;
  const w = wireMobile === '?0' || wireMobile === '0' ? '?0' : wireMobile;
  if (
    q === '?1' &&
    w === '?0' &&
    isLinuxX86DesktopClassUa(uaHeader) &&
    isTrustedOriginForChQuery(req) &&
    readArmDesktopSiteProfile(req)
  ) {
    return '?1';
  }
  return wireMobile || queryMobile || '';
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
  const wireMobile =
    fromUpgrade.mobile || cached?.mobile || fromUa || '';
  const queryMobile = fromQuery?.mobile || '';
  const mobile = pickMergedMobile(req, uaHeader, wireMobile, queryMobile) || queryMobile || fromUa || '';
  return {
    mobile,
    platform: fromUpgrade.platform || fromQuery?.platform || cached?.platform || '',
    ua: fromUpgrade.ua || fromQuery?.ua || cached?.ua || '',
    model: fromUpgrade.model || cached?.model || '',
    platformVersion: fromUpgrade.platformVersion || cached?.platformVersion || '',
    arch: fromUpgrade.arch || cached?.arch || '',
  };
}

module.exports = {
  rememberClientHints,
  peekClientHints,
  resolveClientHints,
  pickMergedMobile,
  isTrustedOriginForChQuery,
};
