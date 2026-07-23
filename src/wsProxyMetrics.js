'use strict';

/**
 * Lightweight concurrent-player metrics for OBT analysis (SSH / log files only).
 * Tracks concurrent counts and max players (all-time + daily), persisted to disk.
 * Not a connection limit — statistics only.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const MOBILE_UA_RE =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS|FxiOS|SamsungBrowser/i;

function classifyClient(userAgent) {
  const ua = userAgent || '';
  if (!ua) return 'unknown';
  return MOBILE_UA_RE.test(ua) ? 'mobile' : 'desktop';
}

function roleFromPort(port, ports) {
  if (port === ports.login) return 'login';
  if (port === ports.char) return 'char';
  if (port === ports.map) return 'map';
  return 'other';
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function emptyMax() {
  return {
    total: 0,
    mobile: 0,
    desktop: 0,
    playing: 0,
    playingMobile: 0,
    playingDesktop: 0,
    at: null,
  };
}

function createMetrics(options = {}) {
  const ports = {
    login: options.loginPort || parseInt(process.env.WS_LOGIN_PORT || '6900', 10),
    char: options.charPort || parseInt(process.env.WS_CHAR_PORT || '6121', 10),
    map: options.mapPort || parseInt(process.env.WS_MAP_PORT || '5121', 10),
  };

  const intervalMs = options.intervalMs || parseInt(process.env.WS_METRICS_INTERVAL_MS || '60000', 10);
  const historyPath =
    options.historyPath ||
    process.env.WS_METRICS_HISTORY_FILE ||
    path.join(process.cwd(), 'logs', 'ws-metrics.jsonl');
  const peakPath =
    options.peakPath ||
    process.env.WS_METRICS_PEAK_FILE ||
    path.join(process.cwd(), 'logs', 'ws-metrics-peak.json');

  /** @type {Map<string, { client: string, role: string, target: string, origin: string, startedAt: number }>} */
  const active = new Map();

  let seq = 0;
  const totals = {
    connects: 0,
    disconnects: 0,
    mobileConnects: 0,
    desktopConnects: 0,
    unknownConnects: 0,
  };

  let maxAllTime = emptyMax();
  let maxDay = { date: todayKey(), ...emptyMax() };

  function loadPersistedMax() {
    try {
      if (!fs.existsSync(peakPath)) return;
      const saved = JSON.parse(fs.readFileSync(peakPath, 'utf8'));
      if (saved && saved.allTime) {
        maxAllTime = { ...emptyMax(), ...saved.allTime };
      }
      if (saved && saved.daily && saved.daily.date === todayKey()) {
        maxDay = { date: saved.daily.date, ...emptyMax(), ...saved.daily };
      }
      logger.info(
        `WS metrics: loaded max allTime.playing=${maxAllTime.playing} daily[${maxDay.date}].playing=${maxDay.playing}`
      );
    } catch (err) {
      logger.warn(`WS metrics: failed to load peak file: ${err.message}`);
    }
  }

  function savePersistedMax() {
    try {
      fs.mkdirSync(path.dirname(peakPath), { recursive: true });
      fs.writeFileSync(
        peakPath,
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            allTime: maxAllTime,
            daily: maxDay,
          },
          null,
          2
        )
      );
    } catch (err) {
      logger.warn(`WS metrics: failed to save peak file: ${err.message}`);
    }
  }

  function bumpMax(bucket, values, nowIso) {
    let changed = false;
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === 'number' && v > (bucket[k] || 0)) {
        bucket[k] = v;
        changed = true;
      }
    }
    if (changed) bucket.at = nowIso;
    return changed;
  }

  function ensureDayBucket() {
    const d = todayKey();
    if (maxDay.date !== d) {
      maxDay = { date: d, ...emptyMax() };
    }
  }

  function countActive() {
    const byClient = { mobile: 0, desktop: 0, unknown: 0 };
    const byRole = { login: 0, char: 0, map: 0, other: 0 };
    const playingByClient = { mobile: 0, desktop: 0, unknown: 0 };

    for (const meta of active.values()) {
      byClient[meta.client] = (byClient[meta.client] || 0) + 1;
      byRole[meta.role] = (byRole[meta.role] || 0) + 1;
      if (meta.role === 'map') {
        playingByClient[meta.client] = (playingByClient[meta.client] || 0) + 1;
      }
    }

    return {
      total: active.size,
      mobile: byClient.mobile,
      desktop: byClient.desktop,
      unknown: byClient.unknown,
      playing: byRole.map || 0,
      playingMobile: playingByClient.mobile,
      playingDesktop: playingByClient.desktop,
      byRole,
    };
  }

  function snapshot() {
    ensureDayBucket();
    const concurrent = countActive();
    const nowIso = new Date().toISOString();

    const maxValues = {
      total: concurrent.total,
      mobile: concurrent.mobile,
      desktop: concurrent.desktop,
      playing: concurrent.playing,
      playingMobile: concurrent.playingMobile,
      playingDesktop: concurrent.playingDesktop,
    };

    const changedAll = bumpMax(maxAllTime, maxValues, nowIso);
    const changedDay = bumpMax(maxDay, maxValues, nowIso);
    if (changedAll || changedDay) {
      savePersistedMax();
      logger.info(
        `WS metrics: new max playing=${concurrent.playing} (mobile=${concurrent.playingMobile}) ` +
          `allTimeMax=${maxAllTime.playing} dayMax=${maxDay.playing}`
      );
    }

    return {
      ts: nowIso,
      concurrent: {
        total: concurrent.total,
        mobile: concurrent.mobile,
        desktop: concurrent.desktop,
        unknown: concurrent.unknown,
        playing: concurrent.playing,
        playingMobile: concurrent.playingMobile,
        playingDesktop: concurrent.playingDesktop,
        byRole: concurrent.byRole,
      },
      max: {
        allTime: { ...maxAllTime },
        daily: { ...maxDay },
      },
      peak: { ...maxAllTime },
      totals: { ...totals },
      ports,
    };
  }

  function trackConnect(req, target, targetPort) {
    const id = `c${++seq}`;
    const client = classifyClient(req.headers['user-agent']);
    const role = roleFromPort(targetPort, ports);
    active.set(id, {
      client,
      role,
      target,
      origin: req.headers.origin || '',
      ua: (req.headers['user-agent'] || '').slice(0, 160),
      startedAt: Date.now(),
    });
    totals.connects += 1;
    if (client === 'mobile') totals.mobileConnects += 1;
    else if (client === 'desktop') totals.desktopConnects += 1;
    else totals.unknownConnects += 1;

    snapshot();
    logger.info(
      `WS metrics: +${client}/${role} target=${target} concurrent=${active.size} playing=${countActive().playing}`
    );
    return id;
  }

  function trackDisconnect(id, reason) {
    const meta = active.get(id);
    if (!meta) return;
    active.delete(id);
    totals.disconnects += 1;
    logger.info(
      `WS metrics: -${meta.client}/${meta.role} reason=${reason} concurrent=${active.size} playing=${countActive().playing}`
    );
  }

  function appendHistory(snap) {
    try {
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      fs.appendFileSync(
        historyPath,
        JSON.stringify({
          ts: snap.ts,
          concurrent: snap.concurrent,
          max: snap.max,
          peak: snap.peak,
        }) + '\n'
      );
    } catch (err) {
      logger.warn(`WS metrics: failed to write history: ${err.message}`);
    }
  }

  let timer = null;
  function startPeriodicLog() {
    if (intervalMs <= 0 || timer) return;
    timer = setInterval(() => {
      const snap = snapshot();
      logger.info(
        `WS metrics snapshot: playing=${snap.concurrent.playing} (mobile=${snap.concurrent.playingMobile} desktop=${snap.concurrent.playingDesktop}) ` +
          `tunnels=${snap.concurrent.total} ` +
          `maxPlayingAll=${snap.max.allTime.playing} maxPlayingDay=${snap.max.daily.playing} ` +
          `maxPlayingMobileAll=${snap.max.allTime.playingMobile}`
      );
      appendHistory(snap);
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopPeriodicLog() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  loadPersistedMax();
  startPeriodicLog();

  return {
    trackConnect,
    trackDisconnect,
    snapshot,
    classifyClient,
    startPeriodicLog,
    stopPeriodicLog,
    historyPath,
    peakPath,
  };
}

module.exports = {
  createMetrics,
  classifyClient,
};
