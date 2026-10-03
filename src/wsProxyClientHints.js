'use strict';

function envFlag(name, defaultWhenSet) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultWhenSet;
  return v !== 'false' && v !== '0';
}

/**
 * Client sends ch-mobile from navigator.userAgentData.mobile (Chrome PWA) when wire CH is missing.
 *
 * @param {import('http').IncomingMessage} req
 */
function readClientHintQuery(req) {
  try {
    const parsed = new URL(req.url || '', 'http://ws-proxy.local');
    const mobile = parsed.searchParams.get('ch-mobile');
    if (!mobile) return null;
    const m = mobile.trim();
    if (m === '?1' || m === '1') return { mobile: '?1', platform: '', ua: '' };
    if (m === '?0' || m === '0') return { mobile: '?0', platform: '', ua: '' };
  } catch {
    // ignore
  }
  return null;
}

function readClientHintHeaders(req) {
  const h = req.headers || {};
  const pick = (key) => {
    const v = h[key] || h[key.toLowerCase()];
    return typeof v === 'string' ? v.trim() : '';
  };
  return {
    mobile: pick('sec-ch-ua-mobile'),
    platform: pick('sec-ch-ua-platform'),
    ua: pick('sec-ch-ua'),
    model: pick('sec-ch-ua-model'),
    platformVersion: pick('sec-ch-ua-platform-version'),
    arch: pick('sec-ch-ua-arch'),
  };
}

/**
 * iPad / some tablets report Sec-CH-UA-Mobile ?0
 *
 * @param {{ mobile: string, platform: string, ua: string }} ch
 */
function isTabletUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return false;
  if (/iPad/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && /Mobile\/[\w]+ Safari/i.test(ua)) return true;
  return false;
}

/**
 * Fallback when query/header CH missing (Safari) — not for spoof-proof enforce alone.
 *
 * @param {string|undefined} ua
 */
function mobileHintFromUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return '';
  if (/iPad|iPhone|iPod/i.test(ua)) return '?1';
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return '?1';
  if (/Windows NT|X11; Linux x86|CrOS/i.test(ua) && !/Mobile/i.test(ua)) return '?0';
  return '';
}

function isTabletClientHint(ch) {
  const platform = (ch.platform || '').replace(/"/g, '');
  const ua = (ch.ua || '').toLowerCase();
  if (/iPad/i.test(ua)) return true;
  if (/iPadOS/i.test(platform)) return true;
  if (platform === 'iOS' && /iPad/i.test(ua)) return true;
  return false;
}

/**
 * Chrome "Desktop site" on ARM — wire UA is Linux x86_64 without Android.
 *
 * @param {string|undefined} ua
 */
function isLinuxX86DesktopClassUa(ua) {
  if (!ua || typeof ua !== 'string') return false;
  if (/Android/i.test(ua)) return false;
  if (/Windows NT|CrOS/i.test(ua)) return false;
  return /X11; Linux x86_64|X11; Linux i686|Linux x86_64/i.test(ua);
}

/**
 * @param {{ platform?: string }} ch
 */
function isLinuxOrAndroidChPlatform(ch) {
  const platform = String(ch?.platform || '').replace(/"/g, '').trim();
  return platform === 'Linux' || platform === 'Android';
}

/**
 * Android tablet often sends Sec-CH-UA-Mobile ?0 (same as iPad).
 *
 * @param {{ platform?: string }} ch
 * @param {string} ua
 */
function isAndroidTabletClientHint(ch, ua) {
  const platform = String(ch?.platform || '').replace(/"/g, '').trim();
  if (platform !== 'Android') return false;
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return false;
  return true;
}

/**
 * @param {import('http').IncomingMessage} req
 */
function readTurnstileQueryPresent(req) {
  try {
    const parsed = new URL(req.url || '', 'http://ws-proxy.local');
    return parsed.searchParams.has('cf-turnstile-response');
  } catch {
    return false;
  }
}

/** Set by play device-gate for real ARM + desktop-site only (not emulators). */
const ARM_DESKTOP_SITE_PROFILE = 'arm-desktop-site';

/**
 * @param {import('http').IncomingMessage} req
 */
function readArmDesktopSiteProfile(req) {
  try {
    const parsed = new URL(req.url || '', 'http://ws-proxy.local');
    const v = parsed.searchParams.get('moon-ch-profile');
    return v === ARM_DESKTOP_SITE_PROFILE;
  } catch {
    return false;
  }
}

/**
 * @param {number} targetPort
 * @param {number} loginPort
 */
function shouldEnforceClientHints(targetPort, loginPort) {
  if (!envFlag('WS_CLIENT_HINTS_ENFORCE', true)) return false;
  if (envFlag('WS_CLIENT_HINTS_LOGIN_ONLY', true)) {
    return targetPort === loginPort;
  }
  return true;
}

/**
 * Block desktop when Sec-CH-UA-Mobile is ?0 (after tablet exception).
 * Missing header → allow (first hop / legacy) unless WS_CLIENT_HINTS_REQUIRE=1.
 *
 * @param {import('http').IncomingMessage} req
 * @param {object} ctx
 * @param {number} ctx.targetPort
 * @param {number} ctx.loginPort
 * @param {string} [ctx.origin]
 */
function evaluateClientHints(req, ctx, hintsOverride) {
  const { targetPort, loginPort, origin = '' } = ctx;
  let hints = hintsOverride || readClientHintHeaders(req);
  const ua = (req.headers && req.headers['user-agent']) || '';

  if (!shouldEnforceClientHints(targetPort, loginPort)) {
    return { block: false, reason: 'not_enforced', hints };
  }
  if (/robrowser\.test/i.test(origin)) {
    return { block: false, reason: 'dev_origin', hints };
  }

  let mobile = hints.mobile;
  if (!mobile) {
    const fromUa = mobileHintFromUserAgent(ua);
    if (fromUa) {
      mobile = fromUa;
      hints = { ...hints, mobile: fromUa };
    }
  }

  if (!mobile) {
    if (envFlag('WS_CLIENT_HINTS_REQUIRE', false)) {
      return { block: true, reason: 'missing_ch_mobile', hints };
    }
    return { block: false, reason: 'missing_ch_mobile', hints };
  }

  const normalized = mobile.toLowerCase();
  if (normalized === '?1' || normalized === '1') {
    return { block: false, reason: 'mobile', hints };
  }
  if (normalized === '?0' || normalized === '0') {
    if (isTabletClientHint(hints) || isTabletUserAgent(ua)) {
      return { block: false, reason: 'tablet_exception', hints };
    }
    if (isAndroidTabletClientHint(hints, ua)) {
      return { block: false, reason: 'android_tablet_exception', hints };
    }
    if (
      isLinuxX86DesktopClassUa(ua) &&
      isLinuxOrAndroidChPlatform(hints) &&
      readTurnstileQueryPresent(req) &&
      readArmDesktopSiteProfile(req)
    ) {
      return { block: false, reason: 'arm_linux_turnstile_ch0_exception', hints };
    }
    return { block: true, reason: 'desktop_ch', hints };
  }

  return { block: false, reason: 'unknown_ch', hints };
}

const ACCEPT_CH_VALUE =
  'Sec-CH-UA-Mobile, Sec-CH-UA-Platform, Sec-CH-UA, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version';

function clientHintResponseHeaders(extra) {
  return {
    'Accept-CH': ACCEPT_CH_VALUE,
    'Critical-CH': 'Sec-CH-UA-Mobile',
    ...extra,
  };
}

module.exports = {
  readClientHintQuery,
  readClientHintHeaders,
  isTabletUserAgent,
  mobileHintFromUserAgent,
  isTabletClientHint,
  isLinuxX86DesktopClassUa,
  isLinuxOrAndroidChPlatform,
  isAndroidTabletClientHint,
  readTurnstileQueryPresent,
  readArmDesktopSiteProfile,
  ARM_DESKTOP_SITE_PROFILE,
  shouldEnforceClientHints,
  evaluateClientHints,
  clientHintResponseHeaders,
  ACCEPT_CH_VALUE,
};
