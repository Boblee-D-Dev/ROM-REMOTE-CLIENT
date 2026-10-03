'use strict';

const {
  isTabletUserAgent,
  isTabletClientHint,
  isLinuxX86DesktopClassUa,
  isLinuxOrAndroidChPlatform,
  readTurnstileQueryPresent,
  readArmDesktopSiteProfile,
} = require('./wsProxyClientHints');

function envFlag(name, defaultWhenUnset) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultWhenUnset;
  return v !== 'false' && v !== '0';
}

/** Aligned with ror-browser device-gate.js EMULATOR_UA_PATTERNS */
const EMULATOR_UA_PATTERNS = [
  /Android.*sdk_gphone/i,
  /Android.*sdk_x86/i,
  /Android.*Emulator/i,
  /Android SDK built for/i,
  /Android.*x86.*generic/i,
  /generic.*x86/i,
  /generic_x86/i,
  /vbox86p?/i,
  /VMware/i,
  /BlueStacks/i,
  /NoxPlayer|Nox App|nox/i,
  /LDPlayer|LD-|LD\d/i,
  /MEmu|mumu|MuMuPlayer|Nemu|nemu|XYAZ/i,
  /Microvirt|microvirt/i,
  /Andy\s*OS/i,
  /Genymotion/i,
  /com\.android\.emulator/i,
  /google_sdk/i,
  /goldfish/i,
  /Android.*ranchu|ranchu/i,
  /sdk_gphone/i,
  /Emulator/i,
  /ttVM_Hdragon/i,
  /youwave/i,
  /bluestacks|memu|ldplayer/i,
];

/**
 * @param {string} ua
 */
function isEmulatorUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return false;
  for (let i = 0; i < EMULATOR_UA_PATTERNS.length; i++) {
    if (EMULATOR_UA_PATTERNS[i].test(ua)) return true;
  }
  if (/Android/i.test(ua) && /\bx86_64\b|\bx86\b/i.test(ua) && !/armv/i.test(ua)) {
    return true;
  }
  return false;
}

/**
 * Large outer window + phone UA often means emulator on PC (server cannot read — client sends profile).
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} ua
 */
function isLinuxMobileCh1WithoutPlayProfile(req, ua) {
  return isLinuxX86DesktopClassUa(ua) && !readArmDesktopSiteProfile(req);
}

/**
 * Obvious desktop browser UA (not phone/tablet).
 *
 * @param {string} ua
 */
function isDesktopUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return false;
  if (isTabletUserAgent(ua)) return false;
  if (/Android.*Mobile|iPhone|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    return false;
  }
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) {
    return false;
  }
  if (/Windows NT|Macintosh|CrOS/i.test(ua) && !/Mobile|Android/i.test(ua)) {
    return true;
  }
  if (/X11; (Ubuntu|Linux x86_64|Linux i686)/i.test(ua) && !/Android/i.test(ua)) {
    return true;
  }
  return false;
}

/**
 * iPad + Sec-CH (iPadOS may send macOS platform with Macintosh UA).
 *
 * @param {string} ua
 * @param {{ mobile?: string, platform?: string, ua?: string }} [hints]
 */
function isTabletLikeClient(ua, hints) {
  if (isTabletUserAgent(ua)) return true;
  if (hints && isTabletClientHint(hints)) return true;
  const platform = String(hints?.platform || '').replace(/"/g, '');
  if (/iPadOS/i.test(platform)) return true;
  if (/Macintosh|iPad/i.test(ua) && /iOS|iPadOS|macOS/i.test(platform)) return true;
  return false;
}

function shouldEnforceUaGate(targetPort, loginPort) {
  const emulatorOn = envFlag('WS_UA_EMULATOR_BLOCK', true);
  const desktopOn = envFlag('WS_UA_DESKTOP_BLOCK', true);
  if (!emulatorOn && !desktopOn) return false;
  if (envFlag('WS_UA_GATE_LOGIN_ONLY', true)) {
    return targetPort === loginPort;
  }
  return true;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {object} ctx
 * @param {number} ctx.targetPort
 * @param {number} ctx.loginPort
 * @param {string} [ctx.origin]
 * @param {{ mobile?: string }} [hints]
 */
function evaluateUserAgentGate(req, ctx, hints = {}) {
  const { targetPort, loginPort, origin = '' } = ctx;
  if (!shouldEnforceUaGate(targetPort, loginPort)) {
    return { block: false, reason: 'not_enforced' };
  }
  if (/robrowser\.test/i.test(origin)) {
    return { block: false, reason: 'dev_origin' };
  }

  const ua = (req.headers && req.headers['user-agent']) || '';

  if (envFlag('WS_UA_EMULATOR_BLOCK', true) && isEmulatorUserAgent(ua)) {
    return { block: true, reason: 'emulator_ua' };
  }

  const mobile = (hints.mobile || '').toLowerCase();
  if (
    envFlag('WS_UA_DESKTOP_BLOCK', true) &&
    isDesktopUserAgent(ua) &&
    isLinuxX86DesktopClassUa(ua) &&
    isLinuxOrAndroidChPlatform(hints) &&
    readTurnstileQueryPresent(req) &&
    readArmDesktopSiteProfile(req) &&
    (mobile === '?0' || mobile === '0' || !mobile)
  ) {
    return { block: false, reason: 'arm_linux_turnstile_ua_exception' };
  }

  if (envFlag('WS_UA_DESKTOP_BLOCK', true) && isDesktopUserAgent(ua)) {
    if (mobile === '?1' || mobile === '1') {
      // iPadOS Safari: Macintosh UA + official client ch-mobile ?1 — not Win/Linux spoof
      if (isTabletLikeClient(ua, hints)) {
        return { block: false, reason: 'tablet_ch1_exception' };
      }
      if (/Windows NT|CrOS/i.test(ua)) {
        return { block: true, reason: 'desktop_ua_mobile_ch_spoof' };
      }
      if (/X11; (Ubuntu|Linux x86)/i.test(ua)) {
        if (isLinuxX86DesktopClassUa(ua) && readArmDesktopSiteProfile(req)) {
          return { block: false, reason: 'linux_mobile_ch1_exception' };
        }
        if (isLinuxMobileCh1WithoutPlayProfile(req, ua)) {
          return { block: true, reason: 'desktop_ua_mobile_ch_spoof' };
        }
        return { block: true, reason: 'desktop_ua_mobile_ch_spoof' };
      }
      // Macintosh + ?1 without tablet hints: allow (iPad desktop-class UA); Mac desktop uses ?0 → CH blocks
      if (/Macintosh/i.test(ua) && !/Windows NT/i.test(ua)) {
        return { block: false, reason: 'macintosh_ch1_exception' };
      }
      return { block: true, reason: 'desktop_ua_mobile_ch_spoof' };
    }
    return { block: true, reason: 'desktop_ua' };
  }

  return { block: false, reason: 'ok' };
}

module.exports = {
  isEmulatorUserAgent,
  isDesktopUserAgent,
  evaluateUserAgentGate,
  shouldEnforceUaGate,
  isTabletLikeClient,
  EMULATOR_UA_PATTERNS,
};
