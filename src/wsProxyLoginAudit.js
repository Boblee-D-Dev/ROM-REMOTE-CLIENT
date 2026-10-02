'use strict';

const fs = require('fs');
const path = require('path');

const OPCODE_ROBROWSER = 0x0888;
const OPCODE_RAThena = 0x0825;
const GAME_ID_OFFSET = 9;
const GAME_ID_LEN = 24;
/** Minimum bytes through end of 24-byte account id field */
const MIN_LOGIN_PACKET = GAME_ID_OFFSET + GAME_ID_LEN;

/**
 * @param {string|null|undefined} ip
 */
function normalizeClientIp(ip) {
  if (!ip || !String(ip).trim()) {
    return { client_ipv4: null, client_ip: null, ip_version: null };
  }
  const raw = String(ip).trim();
  if (raw.startsWith('::ffff:')) {
    const v4 = raw.slice(7);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
      return { client_ipv4: v4, client_ip: v4, ip_version: 4 };
    }
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    return { client_ipv4: raw, client_ip: raw, ip_version: 4 };
  }
  return { client_ipv4: null, client_ip: raw, ip_version: 6 };
}

/**
 * Parse Game ID from CA SSO login (0x0888 / 0x0825). Does not read password/MAC/IP fields.
 *
 * @param {Buffer} buf
 * @returns {string|null}
 */
function parseGameIdFromLoginPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_LOGIN_PACKET) {
    return null;
  }
  const opcode = buf.readUInt16LE(0);
  if (opcode !== OPCODE_ROBROWSER && opcode !== OPCODE_RAThena) {
    return null;
  }
  const pktLen = buf.readUInt16LE(2);
  if (pktLen < MIN_LOGIN_PACKET || buf.length < pktLen) {
    return null;
  }
  const idBytes = buf.subarray(GAME_ID_OFFSET, GAME_ID_OFFSET + GAME_ID_LEN);
  const nul = idBytes.indexOf(0);
  const slice = nul === -1 ? idBytes : idBytes.subarray(0, nul);
  const gameId = slice.toString('utf8').trim();
  return gameId || null;
}

/**
 * @param {object} [options]
 * @param {string} [options.auditPath]
 */
function createLoginAuditLogger(options = {}) {
  const enabled =
    process.env.WS_LOGIN_AUDIT === '1' ||
    process.env.WS_LOGIN_AUDIT === 'true' ||
    !!(options.auditPath || process.env.WS_LOGIN_AUDIT_PATH);
  const auditPath =
    options.auditPath ||
    process.env.WS_LOGIN_AUDIT_PATH ||
    path.join(process.cwd(), 'logs', 'ws-login-audit.jsonl');

  if (enabled) {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  }

  /**
   * @param {object} row
   */
  function append(row) {
    if (!enabled) return;
    const line = `${JSON.stringify(row)}\n`;
    fs.appendFile(auditPath, line, (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error(`WS login audit write failed: ${err.message}`);
      }
    });
  }

  /**
   * @param {Buffer} data
   * @param {object} ctx
   * @param {boolean} ctx.alreadyLogged
   * @param {string|null} ctx.clientIp
   * @param {string|null|undefined} ctx.origin
   * @param {string} ctx.ws_target
	 * @param {boolean} ctx.turnstile_enforced
	 * @param {string|null|undefined} ctx.sec_ch_mobile
	 * @param {string|null|undefined} ctx.sec_ch_platform
   * @returns {boolean} true if logged this call
   */
  function tryLogLoginPacket(data, ctx) {
    if (!enabled || ctx.alreadyLogged) {
      return false;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const gameId = parseGameIdFromLoginPacket(buf);
    if (!gameId) {
      return false;
    }
    const ipFields = normalizeClientIp(ctx.clientIp);
    append({
      ts: new Date().toISOString(),
      event: 'login_attempt',
      game_id: gameId,
      origin: ctx.origin || null,
      turnstile_enforced: !!ctx.turnstile_enforced,
      sec_ch_mobile: ctx.sec_ch_mobile || null,
      sec_ch_platform: ctx.sec_ch_platform || null,
      ws_target: ctx.ws_target,
      ...ipFields,
    });
    return true;
  }

  return {
    enabled,
    auditPath,
    append,
    tryLogLoginPacket,
    parseGameIdFromLoginPacket,
    normalizeClientIp,
  };
}

module.exports = {
  createLoginAuditLogger,
  parseGameIdFromLoginPacket,
  normalizeClientIp,
  OPCODE_ROBROWSER,
  OPCODE_RAThena,
  GAME_ID_OFFSET,
  GAME_ID_LEN,
};
