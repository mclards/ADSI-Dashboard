const fetch = require('node-fetch');
const { bulkInsert, stmts, getSetting } = require('./db');
const { checkAlarms } = require('./alarms');
const { broadcastUpdate } = require('./ws');

// ─── State ───────────────────────────────────────────────────────────────────

const liveData = {};       // key: `${inv}_${unit}` → latest parsed row
const prevKwh  = {};       // for 5-min energy increment tracking
const unreachableState = {}; // per-key miss/suppression tracking

const POLL_MS    = 500;    // poll interval
const OFFLINE_MS = 20000;   // mark offline after 20s no data
const MISSING_GRACE_MS = 12000; // ignore short per-poll gaps before counting misses
const SOLAR_HOUR_START = 5;
const SOLAR_HOUR_END   = 18;
const MAX_PAC_DT_S = 30;   // cap integration gap — allows recovery from short network outages
const SUPPRESS_AFTER_MISS_MS = 120000; // suppress after prolonged misses
const SUPPRESS_BACKOFF_MS = 30000;    // retry after backoff window
const API_FETCH_TIMEOUT_MS = 5000;
const IPCONFIG_CACHE_MS = 5000;

let pollTimer = null;
let running   = false;

// Pac-based daily energy integrator (independent from kWh register).
const pacTodayByInverter = {}; // key: inverter -> kWh
const pacIntegratorState = {}; // key: `${inv}_${unit}` -> { ts, pac }
let pacDayKey = '';
let ipConfigCache = null;
let ipConfigCacheTs = 0;
let apiFailMs = 0;
let apiOfflineBroadcasted = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSolarWindow() {
  const h = new Date().getHours();
  return h >= SOLAR_HOUR_START && h < SOLAR_HOUR_END;
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resetPacTodayIfNeeded(ts = Date.now()) {
  const k = dayKey(ts);
  if (k === pacDayKey) return;
  pacDayKey = k;
  for (const key of Object.keys(pacTodayByInverter)) delete pacTodayByInverter[key];
  for (const key of Object.keys(pacIntegratorState)) delete pacIntegratorState[key];
}

function integratePacToday(parsed) {
  const now = parsed.ts || Date.now();
  resetPacTodayIfNeeded(now);
  const key = `${parsed.inverter}_${parsed.unit}`;
  const pac = Math.max(0, Number(parsed.pac || 0));
  const prev = pacIntegratorState[key];

  if (!prev) {
    pacIntegratorState[key] = { ts: now, pac };
    return;
  }

  const dtSec = Math.max(0, (now - prev.ts) / 1000);
  if (dtSec > 0) {
    const safeDt = Math.min(dtSec, MAX_PAC_DT_S);
    const avgPac = (prev.pac + pac) / 2;
    const kwhInc = (avgPac * safeDt) / 3600000; // W*s -> kWh
    pacTodayByInverter[parsed.inverter] =
      (pacTodayByInverter[parsed.inverter] || 0) + kwhInc;
  }

  pacIntegratorState[key] = { ts: now, pac };
}

function parseRow(row) {
  const inverter = Number(row.inverter || 0);
  const unit     = Number(row.unit || 0);
  if (!inverter || !unit) return null;

  const vdc  = Number(row.vdc  || 0);
  const idc  = Number(row.idc  || 0);
  const vac1 = Number(row.vac1 || 0);
  const vac2 = Number(row.vac2 || 0);
  const vac3 = Number(row.vac3 || 0);
  const iac1 = Number(row.iac1 || 0);
  const iac2 = Number(row.iac2 || 0);
  const iac3 = Number(row.iac3 || 0);
  const pac  = Number(row.pac  || 0);
  // Use multiplication instead of left-shift to avoid signed 32-bit overflow in JS.
  const kwh  = (((Number(row.kwh_high || 0) & 0xFFFF) * 65536) + (Number(row.kwh_low || 0) & 0xFFFF)) / 10;
  const alarm = Number(row.alarm || 0);
  const onOffRaw = Number(row.on_off ?? row.onOff ?? 0);
  const on_off = onOffRaw === 1 ? 1 : 0;

  // Sanity clamp
  const safePac = pac * 10 <= 260000 ? pac * 10 : 0;
  const safePdc = vdc * idc <= 265000 ? vdc * idc : 0;

  const sourceTs = Number(row.ts || row.timestamp || Date.now());
  const ts = Number.isFinite(sourceTs) && sourceTs > 0 ? sourceTs : Date.now();

  return {
    ts,
    inverter, unit,
    vdc, idc,
    vac1, vac2, vac3,
    iac1, iac2, iac3,
    pac: safePac,
    pdc: safePdc,
    kwh,
    alarm,
    on_off,
    online: 1
  };
}

function defaultIpConfig() {
  const cfg = { inverters: {}, poll_interval: {}, units: {} };
  for (let i = 1; i <= 27; i++) {
    cfg.inverters[i] = `192.168.1.${100 + i}`;
    cfg.poll_interval[i] = 0.05;
    cfg.units[i] = [1, 2, 3, 4];
  }
  return cfg;
}

function sanitizeIpConfig(input) {
  const out = defaultIpConfig();
  const src = input && typeof input === "object" ? input : {};
  for (let i = 1; i <= 27; i++) {
    const ip = String(
      src?.inverters?.[i] ?? src?.inverters?.[String(i)] ?? out.inverters[i],
    ).trim();
    const poll = Number(
      src?.poll_interval?.[i] ??
        src?.poll_interval?.[String(i)] ??
        out.poll_interval[i],
    );
    const unitsRaw = src?.units?.[i] ?? src?.units?.[String(i)] ?? out.units[i];
    const units = Array.isArray(unitsRaw)
      ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
      : [1, 2, 3, 4];
    // Validate IP format; fall back to default on invalid entries.
    const ipValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
    if (!ipValid) console.warn(`[poller] Ignoring invalid IP for inverter ${i}: "${ip}"`);
    out.inverters[i] = ipValid ? ip : `192.168.1.${100 + i}`;
    out.poll_interval[i] = Number.isFinite(poll) && poll >= 0.01 && poll <= 60 ? poll : 0.05;
    out.units[i] = units.length ? [...new Set(units)] : [];
  }
  return out;
}

function loadIpConfigSnapshot(force = false) {
  const now = Date.now();
  if (!force && ipConfigCache && now - ipConfigCacheTs < IPCONFIG_CACHE_MS) {
    return ipConfigCache;
  }
  const raw = getSetting("ipConfigJson", "");
  if (!raw) {
    ipConfigCache = defaultIpConfig();
    ipConfigCacheTs = now;
    return ipConfigCache;
  }
  try {
    ipConfigCache = sanitizeIpConfig(JSON.parse(String(raw)));
  } catch (err) {
    console.error("[poller] ipconfig parse failed:", err.message);
    ipConfigCache = defaultIpConfig();
  }
  ipConfigCacheTs = now;
  return ipConfigCache;
}

function setIpConfigSnapshot(cfg) {
  ipConfigCache = sanitizeIpConfig(cfg);
  ipConfigCacheTs = Date.now();
}

function getExpectedKeysFromIpConfig(cfg) {
  const keys = [];
  for (let inv = 1; inv <= 27; inv++) {
    const ip = String(
      cfg?.inverters?.[inv] ?? cfg?.inverters?.[String(inv)] ?? "",
    ).trim();
    if (!ip) continue;

    const unitsRaw = cfg?.units?.[inv] ?? cfg?.units?.[String(inv)] ?? [1, 2, 3, 4];
    const units = Array.isArray(unitsRaw)
      ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
      : [1, 2, 3, 4];
    const uniqUnits = units.length ? [...new Set(units)] : [];
    for (const unit of uniqUnits) {
      keys.push(`${inv}_${unit}`);
    }
  }
  return keys;
}

function markSeenKey(key) {
  if (unreachableState[key]) delete unreachableState[key];
}

function markMissingKey(key, now) {
  const s = unreachableState[key] || { missMs: 0, suppressUntil: 0, offlineSent: false };
  s.missMs += POLL_MS;

  if (s.missMs >= OFFLINE_MS && !s.offlineSent) {
    if (liveData[key]) {
      liveData[key].online = 0;
      liveData[key].pac = 0;
      liveData[key].pdc = 0;
      broadcastUpdate({ type: 'offline', key });
    }
    s.offlineSent = true;
  }

  if (s.missMs >= SUPPRESS_AFTER_MISS_MS && s.suppressUntil < now) {
    s.suppressUntil = now + SUPPRESS_BACKOFF_MS;
    // Keep last row for UI stability; freshness and online flags still gate totals.
    if (liveData[key]) liveData[key].online = 0;
  }

  unreachableState[key] = s;
}

// ─── 5-min energy bucketing ──────────────────────────────────────────────────

const energyBuckets = {}; // `${inv}` -> { bucketStart, kwhStart, day }

function floorToFiveMinute(ts) {
  const FIVE = 5 * 60 * 1000;
  return Math.floor(ts / FIVE) * FIVE;
}

function update5minBucket(parsed) {
  const key = String(parsed.inverter);
  const now = parsed.ts || Date.now();
  const bucketStart = floorToFiveMinute(now);
  const dKey = dayKey(now);
  const kwhNow = Number(pacTodayByInverter[parsed.inverter] || 0);
  const state = energyBuckets[key];

  if (!state || state.day !== dKey) {
    energyBuckets[key] = { bucketStart, kwhStart: kwhNow, day: dKey };
    return;
  }

  if (bucketStart <= state.bucketStart) return;

  // Persist exactly on wall-clock 5-minute boundaries (:00/:05/:10/...),
  // derived from PAC integration only (not register kWh).
  const inc = Math.max(0, kwhNow - Number(state.kwhStart || 0));
  stmts.insertEnergy5.run(bucketStart, parsed.inverter, inc);
  energyBuckets[key] = { bucketStart, kwhStart: kwhNow, day: dKey };
}

function buildTotals(now) {
  const totals = {};
  for (const d of Object.values(liveData)) {
    const isFresh = now - Number(d.ts || 0) <= OFFLINE_MS;
    if (!d.online || !isFresh) continue;
    const inv = d.inverter;
    if (!totals[inv]) totals[inv] = { pac: 0, pdc: 0, kwh: 0 };
    totals[inv].pac += d.pac || 0;
    totals[inv].pdc += d.pdc || 0;
    totals[inv].kwh += d.kwh || 0;
  }
  return totals;
}

function markAllOffline() {
  for (const [key, d] of Object.entries(liveData)) {
    if (!d) continue;
    d.online = 0;
    d.pac = 0;
    d.pdc = 0;
    broadcastUpdate({ type: 'offline', key });
  }
}

// ─── Poll loop ───────────────────────────────────────────────────────────────

async function poll() {
  if (!running) return;
  const now = Date.now();

  const apiUrl = getSetting('apiUrl', 'http://127.0.0.1:9100/data');
  const ipConfig = loadIpConfigSnapshot();
  const expectedKeys = getExpectedKeysFromIpConfig(ipConfig);
  const expectedSet = new Set(expectedKeys);

  let rows = [];
  let fetchOk = false;
  try {
    const res = await fetch(apiUrl, { timeout: API_FETCH_TIMEOUT_MS });
    rows = await res.json();
    if (!Array.isArray(rows)) rows = [];
    fetchOk = true;
    apiFailMs = 0;
    apiOfflineBroadcasted = false;
  } catch (e) {
    fetchOk = false;
    apiFailMs += POLL_MS;
  }

  // Avoid flapping all cards on short API hiccups.
  if (!fetchOk) {
    if (apiFailMs >= OFFLINE_MS && !apiOfflineBroadcasted) {
      markAllOffline();
      apiOfflineBroadcasted = true;
    }
    const totals = buildTotals(now);
    broadcastUpdate({ type: 'live', data: liveData, totals });
    return;
  }

  const batch = [];
  const seen  = new Set();

  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed) continue;
    const key = `${parsed.inverter}_${parsed.unit}`;
    if (!expectedSet.has(key)) continue;

    integratePacToday(parsed);

    seen.add(key);
    markSeenKey(key);

    // Skip if identical to previous
    const prev = liveData[key];
    if (prev &&
        prev.pac === parsed.pac &&
        prev.kwh === parsed.kwh &&
        prev.alarm === parsed.alarm) {
      // Heartbeat refresh: keep timestamp/online fresh even when values are stable.
      prev.ts = parsed.ts;
      prev.online = 1;
      continue;
    }

    liveData[key] = parsed;

    // Only write to DB during solar window
    if (isSolarWindow()) {
      batch.push(parsed);
      update5minBucket(parsed);
    }

  }

  if (batch.length) {
    try {
      bulkInsert(batch);
      checkAlarms(batch);
    } catch (e) {
      console.error('[DB]', e.message);
    }
  }

  // Remove stale keys no longer configured in ipconfig.
  for (const key of Object.keys(liveData)) {
    if (expectedSet.has(key)) continue;
    delete liveData[key];
    if (unreachableState[key]) delete unreachableState[key];
  }

  // Track configured IDs that were not seen and auto-suppress prolonged misses.
  for (const key of expectedKeys) {
    if (seen.has(key)) continue;

    // Short gaps are common with Modbus polling; avoid flapping on brief misses.
    const last = liveData[key];
    if (last && now - Number(last.ts || 0) <= MISSING_GRACE_MS) continue;

    const s = unreachableState[key];
    if (s && s.suppressUntil > now) continue;
    markMissingKey(key, now);
  }

  const totals = buildTotals(now);

  broadcastUpdate({ type: 'live', data: liveData, totals });
}

function start() {
  if (running) return;
  running = true;
  (function tick() {
    if (!running) return;
    poll()
      .catch((err) => console.error("[poller] unhandled poll error:", err.message))
      .finally(() => {
        pollTimer = setTimeout(tick, POLL_MS);
      });
  })();
}

function stop() {
  running = false;
  clearTimeout(pollTimer);
}

function getLiveData() { return liveData; }

function getTodayPacKwh() {
  resetPacTodayIfNeeded(Date.now());
  return Object.keys(pacTodayByInverter)
    .map((inv) => ({
      inverter: Number(inv),
      total_kwh: Number((pacTodayByInverter[inv] || 0).toFixed(6)),
    }))
    .sort((a, b) => a.inverter - b.inverter);
}

module.exports = { start, stop, getLiveData, getTodayPacKwh, setIpConfigSnapshot };
