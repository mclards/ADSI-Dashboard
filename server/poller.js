const fetch = require('node-fetch');
const {
  bulkInsertPollerBatch,
  getSetting,
  sumEnergy5minByInverterRange,
  upsertAvailability5min,
} = require('./db');
const { checkAlarms } = require('./alarms');
const { broadcastUpdate } = require('./ws');
const {
  normalizeTodayEnergyRows,
  evaluateTodayEnergyHealth,
} = require("./todayEnergyHealthCore");

// ─── State ───────────────────────────────────────────────────────────────────

const liveData = {};       // key: `${inv}_${unit}` → latest parsed row
const unreachableState = {}; // per-key miss/suppression tracking
const lastPersistState = {}; // per-key DB persist cadence state

const POLL_MS    = 200;    // poll interval — reduced from 500ms; Python updates at ~50ms/inverter
const OFFLINE_MS = 20000;   // mark offline after 20s no data
const MISSING_GRACE_MS = 12000; // ignore short per-poll gaps before counting misses
const SOLAR_HOUR_START = 5;
const SOLAR_HOUR_END   = 18;
// Primary dropout protection is the stale frame guard in integratePacToday():
// it detects when Python serves a cached Modbus frame (ts unchanged) and skips
// PAC integration, preventing phantom kWh accumulation during Modbus dropouts.
// This 30s cap is a hard ceiling for genuine long timestamp gaps (e.g. clock jumps).
// A gap-clip warning is emitted whenever the cap fires so discards are visible in logs.
const MAX_PAC_DT_S = 30;   // cap integration gap — hard ceiling (stale frame guard is primary)
const SUPPRESS_AFTER_MISS_MS = 120000; // suppress after prolonged misses
const SUPPRESS_BACKOFF_MS = 30000;    // retry after backoff window
const API_FETCH_TIMEOUT_MS = 5000;
const IPCONFIG_CACHE_MS = 5000;
const DB_MIN_PERSIST_MS = 1000;
const DB_PAC_DELTA_PERSIST_W = 250;
const DB_READING_BACKLOG_MAX_ROWS = 120000;
const DB_ENERGY_BACKLOG_MAX_ROWS = 12000;
// When Python has no fresh Modbus frame (Modbus down), it serves the LAST cached
// frame unchanged. If Node integrates PAC against that stale frame it accumulates
// phantom kWh. Guard: if the frame timestamp hasn't advanced since the last
// integration for this key, and system time has moved on, treat as stale and
// skip the PAC increment. 3s matches Python's per-inverter reconnect window.
const STALE_FRAME_MAX_AGE_MS = 3000; // frame ts must advance within this window

let pollTimer = null;
let running   = false;
let liveJsonCache = "{}";
let liveJsonCacheTs = Date.now();
const pendingReadingQueue = new Map();
const pendingEnergyQueue = new Map();
const pollStats = {
  startedAt: Date.now(),
  tickCount: 0,
  lastPollStartedTs: 0,
  lastPollEndedTs: 0,
  lastPollDurationMs: 0,
  avgPollDurationMs: 0,
  maxPollDurationMs: 0,
  fetchOkCount: 0,
  fetchErrorCount: 0,
  lastFetchError: "",
  rowsFetched: 0,
  rowsParsed: 0,
  rowsAccepted: 0,
  rowsSkippedUnconfigured: 0,
  rowsNoChange: 0,
  rowsPersisted: 0,
  rowsPersistSkippedCadence: 0,
  dbBulkInsertCount: 0,
  dbInsertErrorCount: 0,
  dbPersistRetryCount: 0,
  dbPersistDroppedReadingCount: 0,
  dbPersistDroppedEnergyCount: 0,
  pendingReadingQueueSize: 0,
  pendingEnergyQueueSize: 0,
  pendingReadingQueueHighWater: 0,
  pendingEnergyQueueHighWater: 0,
  lastDbPersistError: "",
  lastDbPersistOkTs: 0,
  offlineMarkCount: 0,
  lastCacheUpdateTs: Date.now(),
  // ─── Energy integrity counters (new) ─────────────────────────────────────
  pacGapClipCount: 0,         // times PAC dt was capped by MAX_PAC_DT_S → silent energy loss
  pacGapClipTotalSec: 0,      // cumulative seconds clipped (indicates severity)
  partialBucketFlushCount: 0, // 5-min partial buckets flushed on shutdown (recovered energy)
  solarWindowSkipCount: 0,    // readings dropped because outside solar persist window
  staleFrameSkipCount: 0,     // PAC integrations skipped because Python served a cached stale frame
  // ─── Frame latency (Python sweep lag vs Node poll interval) ─────────────────
  frameAgeAvgMs: 0,           // EMA of (Date.now() − frame.ts) across all parsed rows
  frameAgeMaxMs: 0,           // peak frame age seen in this session (ms)
};

// ─── Energy backlog pressure tracking ────────────────────────────────────────
let _pressureState = "normal"; // "normal" | "elevated" | "critical"

function getEnergyBacklogPressure() {
  const queueSize = pendingEnergyQueue.size + pendingReadingQueue.size;
  const highWater = Math.max(
    Number(pollStats.pendingEnergyQueueHighWater || 0),
    Number(pollStats.pendingReadingQueueHighWater || 0),
  );
  const lastFlushOk = !pollStats.lastDbPersistError;
  const lastFlushTs = Number(pollStats.lastDbPersistOkTs || 0);

  // Hysteresis transitions — one transition per call to prevent cascade
  if (_pressureState === "normal") {
    if (queueSize >= 3000) _pressureState = "elevated";
  } else if (_pressureState === "elevated") {
    if (queueSize >= 8000 || !lastFlushOk) {
      _pressureState = "critical";
    } else if (queueSize < 2500) {
      _pressureState = "normal";
    }
  } else if (_pressureState === "critical") {
    if (queueSize < 7000 && lastFlushOk) _pressureState = "elevated";
  }

  return {
    queueSize,
    highWater,
    maxRows: DB_ENERGY_BACKLOG_MAX_ROWS,
    pressure: _pressureState,
    lastFlushOk,
    lastFlushTs,
    droppedEnergy: Number(pollStats.dbPersistDroppedEnergyCount || 0),
    droppedReadings: Number(pollStats.dbPersistDroppedReadingCount || 0),
  };
}

// ─── Flush priority retry state ──────────────────────────────────────────────
let _flushRetryCount = 0;

// Pac-based daily energy integrator (independent from kWh register).
const pacTodayByInverter = {}; // key: inverter -> kWh
const pacIntegratorState = {}; // key: `${inv}_${unit}` -> { ts, pac }
let todayEnergyHealthState = {
  byInv: Object.create(null),
  summary: {
    state: "idle",
    reasonCode: "inactive",
    reasonText: "Today-energy health has not been evaluated yet.",
    checkedAt: 0,
    activeInverterCount: 0,
    fallbackActiveCount: 0,
    staleCount: 0,
    mismatchCount: 0,
    selectedSource: "pac",
  },
};
let todayEnergySelectedRows = [];
let todayEnergyBaselineDay = "";
let todayEnergyBaselineByInv = new Map();
let todayEnergyBaselineLiveByInv = new Map();
let todayEnergyBaselineSeededAt = 0;
let pacDayKey = '';
let ipConfigCache = null;
let ipConfigCacheTs = 0;
let apiFailMs = 0;
let apiOfflineBroadcasted = false;

function updateLiveSnapshotCache() {
  try {
    const next = JSON.stringify(liveData);
    // Only bump the cache timestamp when the serialized payload actually changed.
    // This keeps /api/live ETag responses meaningful for direct conditional GETs.
    if (next !== liveJsonCache) {
      liveJsonCache = next;
      liveJsonCacheTs = Date.now();
      pollStats.lastCacheUpdateTs = liveJsonCacheTs;
    }
  } catch (err) {
    // Keep last good snapshot; avoid throwing in hot path.
    console.warn("[poller] live snapshot cache failed:", err.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSolarWindow() {
  const h = new Date().getHours();
  return h >= SOLAR_HOUR_START && h < SOLAR_HOUR_END;
}

function isSolarWindowAt(ts = Date.now()) {
  const d = new Date(ts);
  const h = d.getHours();
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
  todayEnergySelectedRows = [];
  todayEnergyBaselineDay = "";
  todayEnergyBaselineByInv = new Map();
  todayEnergyBaselineLiveByInv = new Map();
  todayEnergyBaselineSeededAt = 0;
  todayEnergyHealthState = {
    byInv: Object.create(null),
    summary: {
      state: "idle",
      reasonCode: "day_reset",
      reasonText: "Today-energy health was reset for the new local day.",
      checkedAt: Math.max(0, Number(ts || Date.now())),
      activeInverterCount: 0,
      fallbackActiveCount: 0,
      staleCount: 0,
      mismatchCount: 0,
      selectedSource: "pac",
    },
  };
}

function roundKwh(value) {
  return Number((Math.max(0, Number(value) || 0)).toFixed(6));
}

function normalizeSourceIp(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(raw)) {
    return raw.replace(/:\d+$/, "");
  }
  try {
    if (raw.includes("://")) {
      return String(new URL(raw).hostname || "").trim();
    }
  } catch {
    // Fall through to raw token.
  }
  return raw;
}

function getRowUnitNumber(row) {
  return Math.trunc(
    Number(
      row?.unit ??
        row?.node_number ??
        row?.nodeNumber ??
        row?.node ??
        row?.Module ??
        row?.module,
    ),
  );
}

function getRowReportedInverter(row) {
  return Math.trunc(
    Number(
      row?.inverter ??
        row?.inverter_number ??
        row?.inverterNumber ??
        row?.Inverter,
    ),
  );
}

function buildIpConfigLookup(cfg) {
  const safeCfg = sanitizeIpConfig(cfg);
  const byIp = new Map();
  const unitsByInverter = new Map();
  for (let inv = 1; inv <= 27; inv++) {
    const ip = normalizeSourceIp(
      safeCfg?.inverters?.[inv] ?? safeCfg?.inverters?.[String(inv)] ?? "",
    );
    if (ip) byIp.set(ip, inv);
    const unitsRaw =
      safeCfg?.units?.[inv] ?? safeCfg?.units?.[String(inv)] ?? [1, 2, 3, 4];
    const units = Array.isArray(unitsRaw)
      ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
      : [1, 2, 3, 4];
    unitsByInverter.set(inv, new Set(units));
  }
  return {
    byIp,
    unitsByInverter,
  };
}

function resolveConfiguredTelemetryIdentity(row, lookup) {
  const sourceIp = normalizeSourceIp(
    row?.source_ip ??
      row?.sourceIp ??
      row?.ip ??
      row?.ip_address ??
      row?.ipAddress ??
      row?.host,
  );
  const unit = getRowUnitNumber(row);
  const rawInverter = getRowReportedInverter(row);
  let inverter = rawInverter;

  if (sourceIp && lookup?.byIp instanceof Map) {
    inverter = Number(lookup.byIp.get(sourceIp) || 0);
    if (!(inverter > 0)) {
      return { ok: false, reasonCode: "ip_unconfigured", sourceIp, unit, rawInverter };
    }
  }

  if (!(unit >= 1 && unit <= 4)) {
    return { ok: false, reasonCode: "unit_invalid", sourceIp, unit, rawInverter, inverter };
  }
  if (!(inverter >= 1 && inverter <= 27)) {
    return { ok: false, reasonCode: "inverter_invalid", sourceIp, unit, rawInverter, inverter };
  }

  const configuredUnits = lookup?.unitsByInverter?.get(inverter);
  if (configuredUnits instanceof Set && !configuredUnits.has(unit)) {
    return { ok: false, reasonCode: "unit_unconfigured", sourceIp, unit, rawInverter, inverter };
  }

  return {
    ok: true,
    inverter,
    unit,
    sourceIp,
    rawInverter,
  };
}

function resolveFrameDay(row, ts = Date.now()) {
  const year = Math.floor(Number(row?.year || 0));
  const month = Math.floor(Number(row?.month || 0));
  const day = Math.floor(Number(row?.day || 0));
  if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return dayKey(ts);
}

function localDayStartTs(dayText) {
  return new Date(`${String(dayText || dayKey()).trim()}T00:00:00.000`).getTime();
}

function buildPacTodayByInverterMap() {
  const out = new Map();
  for (const [invRaw, totalRaw] of Object.entries(pacTodayByInverter)) {
    const inverter = Math.floor(Number(invRaw || 0));
    const totalKwh = roundKwh(totalRaw);
    if (!(inverter > 0) || !(totalKwh > 0)) continue;
    out.set(inverter, totalKwh);
  }
  return out;
}

function buildTodayEnergyRowsFromSeed({
  seededTotalByInv,
  seededLiveByInv,
  currentLiveByInv,
}) {
  const seededTotals =
    seededTotalByInv instanceof Map ? seededTotalByInv : new Map();
  const seededLive =
    seededLiveByInv instanceof Map ? seededLiveByInv : new Map();
  const currentLive =
    currentLiveByInv instanceof Map ? currentLiveByInv : new Map();
  const invSet = new Set([
    ...Array.from(seededTotals.keys()),
    ...Array.from(seededLive.keys()),
    ...Array.from(currentLive.keys()),
  ]);

  return Array.from(invSet)
    .map((inv) => {
      const inverter = Math.floor(Number(inv || 0));
      if (!(inverter > 0)) return null;
      const seededTotal = roundKwh(seededTotals.get(inverter));
      const anchorLive = roundKwh(seededLive.get(inverter));
      const liveNow = roundKwh(currentLive.get(inverter));
      const totalKwh = roundKwh(seededTotal + Math.max(0, liveNow - anchorLive));
      if (!(totalKwh > 0)) return null;
      return {
        inverter,
        total_kwh: totalKwh,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.inverter - b.inverter);
}

function ensureTodayEnergyBaseline(ts = Date.now()) {
  const day = dayKey(ts);
  if (
    todayEnergyBaselineDay === day &&
    todayEnergyBaselineSeededAt > 0 &&
    todayEnergyBaselineByInv instanceof Map &&
    todayEnergyBaselineLiveByInv instanceof Map
  ) {
    return todayEnergyBaselineByInv;
  }
  const seededDb = sumEnergy5minByInverterRange(
    localDayStartTs(day),
    Math.max(localDayStartTs(day), Number(ts || Date.now())),
  );
  const seededLive = buildPacTodayByInverterMap();
  const seededTotals = new Map();
  const invSet = new Set([
    ...Array.from(seededDb.keys()),
    ...Array.from(seededLive.keys()),
  ]);
  for (const inv of invSet) {
    const inverter = Math.floor(Number(inv || 0));
    if (!(inverter > 0)) continue;
    const dbKwh = roundKwh(seededDb.get(inverter));
    const liveKwh = roundKwh(seededLive.get(inverter));
    const totalKwh = roundKwh(Math.max(dbKwh, liveKwh));
    if (totalKwh > 0) seededTotals.set(inverter, totalKwh);
  }
  todayEnergyBaselineDay = day;
  todayEnergyBaselineByInv = seededTotals;
  todayEnergyBaselineLiveByInv = seededLive;
  todayEnergyBaselineSeededAt = Date.now();
  return todayEnergyBaselineByInv;
}


function integratePacToday(parsed) {
  const now = parsed.ts || Date.now();
  resetPacTodayIfNeeded(now);
  const key = `${parsed.inverter}_${parsed.unit}`;
  const pac = Math.max(0, Number(parsed.pac || 0));
  const prev = pacIntegratorState[key];

  if (!prev) {
    pacIntegratorState[key] = { ts: now, pac, totalKwh: 0, pythonKwh: parsed.kwh_python || 0 };
    parsed.kwh = 0;
    return;
  }

  let totalKwh = Number(prev.totalKwh || 0);
  const dtSec = Math.max(0, (now - prev.ts) / 1000);

  // ── Stale frame guard: trust Python's timestamp ──
  // Python's /data filters out frames older than STALE_FRAME_MAX_AGE_MS before sending.
  // If dtSec === 0 the same ts was re-served — skip to avoid zero-increment noise.
  if (dtSec === 0 && prev.ts > 0) {
    pollStats.staleFrameSkipCount += 1;
    parsed.kwh = roundKwh(totalKwh);
    return;
  }

  // ── Primary path: use Python's accumulated kwh_today delta ──
  // Python integrates at 50ms granularity (vs Node's 200ms refetch), so its kWh
  // is more accurate. We take the delta from the last known Python value;
  // if Python restarted (kwh_python < prev), delta = 0 (safe — DB baseline covers it).
  const pythonKwh = Number(parsed.kwh_python || 0);
  if (pythonKwh > 0) {
    const prevPythonKwh = Number(prev.pythonKwh || 0);
    const pythonDelta = Math.max(0, pythonKwh - prevPythonKwh);
    totalKwh += pythonDelta;
    pacTodayByInverter[parsed.inverter] =
      (pacTodayByInverter[parsed.inverter] || 0) + pythonDelta;
    parsed.kwh = roundKwh(totalKwh);
    pacIntegratorState[key] = { ts: now, pac, totalKwh: parsed.kwh, pythonKwh };
    return;
  }

  // ── Fallback path: PAC trapezoid (when Python kwh_today unavailable) ──
  if (dtSec > 0) {
    const safeDt = Math.min(dtSec, MAX_PAC_DT_S);
    // ── Gap-clip warning: any dt capped here is energy permanently lost ──
    if (dtSec > MAX_PAC_DT_S) {
      pollStats.pacGapClipCount += 1;
      pollStats.pacGapClipTotalSec += Math.round(dtSec - MAX_PAC_DT_S);
      const discardedKwh = ((prev.pac + pac) / 2 * (dtSec - MAX_PAC_DT_S)) / 3600000;
      console.warn(
        `[energy] PAC gap clipped: inv=${parsed.inverter}_${parsed.unit}` +
        ` dt=${dtSec.toFixed(1)}s capped=${MAX_PAC_DT_S}s` +
        ` discarded≈${discardedKwh.toFixed(4)}kWh` +
        ` totalClips=${pollStats.pacGapClipCount}`,
      );
    }
    const avgPac = (prev.pac + pac) / 2;
    const kwhInc = (avgPac * safeDt) / 3600000; // W*s -> kWh
    totalKwh += kwhInc;
    pacTodayByInverter[parsed.inverter] =
      (pacTodayByInverter[parsed.inverter] || 0) + kwhInc;
  }

  parsed.kwh = roundKwh(totalKwh);
  pacIntegratorState[key] = { ts: now, pac, totalKwh: parsed.kwh, pythonKwh: 0 };
}

function parseRow(row, identity = null) {
  const resolved =
    identity && typeof identity === "object" ? identity : resolveConfiguredTelemetryIdentity(row, null);
  if (!resolved?.ok) return null;
  const inverter = Math.trunc(Number(resolved.inverter));
  const unit = Math.trunc(Number(resolved.unit));

  const vdc  = Number(row.vdc  || 0);
  const idc  = Number(row.idc  || 0);
  const vac1 = Number(row.vac1 || 0);
  const vac2 = Number(row.vac2 || 0);
  const vac3 = Number(row.vac3 || 0);
  const iac1 = Number(row.iac1 || 0);
  const iac2 = Number(row.iac2 || 0);
  const iac3 = Number(row.iac3 || 0);
  const pac  = Number(row.pac  || 0);
  const alarm = Number(row.alarm || 0);
  const onOffRaw = Number(row.on_off ?? row.onOff ?? 0);
  const on_off = onOffRaw === 1 ? 1 : 0;

  // Sanity clamp
  const safePac = pac * 10 <= 260000 ? pac * 10 : 0;
  const safePdc = vdc * idc <= 265000 ? vdc * idc : 0;

  // Python's pre-accumulated kWh for this node (50ms integrator, 30s cap applied).
  // When > 0, Node uses the delta of this value instead of its own PAC trapezoid.
  const kwh_python = Math.max(0, Number(row.kwh_today || 0));

  const sourceTs = Number(row.ts || row.timestamp || Date.now());
  const ts = Number.isFinite(sourceTs) && sourceTs > 0 ? sourceTs : Date.now();
  const day = resolveFrameDay(row, ts);

  return {
    ts,
    day,
    inverter, unit,
    vdc, idc,
    vac1, vac2, vac3,
    iac1, iac2, iac3,
    pac: safePac,
    pdc: safePdc,
    kwh: 0,
    kwh_python,
    alarm,
    on_off,
    online: 1,
    source_ip: String(resolved.sourceIp || ""),
  };
}

function toPersistedReadingRow(row) {
  return {
    ts: Number(row?.ts || 0),
    inverter: Number(row?.inverter || 0),
    unit: Number(row?.unit || 0),
    pac: Number(row?.pac || 0),
    kwh: roundKwh(row?.kwh),
    alarm: Number(row?.alarm || 0),
    online: Number(row?.online ?? 1) === 1 ? 1 : 0,
  };
}

const DEFAULT_INVERTER_LOSS_PCT = 2.5;

function defaultIpConfig() {
  const cfg = { inverters: {}, poll_interval: {}, units: {}, losses: {} };
  for (let i = 1; i <= 27; i++) {
    cfg.inverters[i] = `192.168.1.${100 + i}`;
    cfg.poll_interval[i] = 0.05;
    cfg.units[i] = [1, 2, 3, 4];
    cfg.losses[i] = DEFAULT_INVERTER_LOSS_PCT;
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
    const lossRaw = Number(
      src?.losses?.[i] ?? src?.losses?.[String(i)] ?? out.losses[i],
    );
    // Validate IP format; fall back to default on invalid entries.
    const ipValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
    if (!ipValid) console.warn(`[poller] Ignoring invalid IP for inverter ${i}: "${ip}"`);
    out.inverters[i] = ipValid ? ip : `192.168.1.${100 + i}`;
    out.poll_interval[i] = Number.isFinite(poll) && poll >= 0.01 && poll <= 60 ? poll : 0.05;
    out.units[i] = units.length ? [...new Set(units)] : [];
    out.losses[i] =
      Number.isFinite(lossRaw) && lossRaw >= 0 && lossRaw <= 100
        ? lossRaw
        : out.losses[i];
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
      pollStats.offlineMarkCount += 1;
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
let lastAvailabilityBucketTs = 0; // last written availability_5min boundary

function floorToFiveMinute(ts) {
  const FIVE = 5 * 60 * 1000;
  return Math.floor(ts / FIVE) * FIVE;
}

function update5minBucket(parsed, energyRows) {
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
  energyRows.push({
    ts: bucketStart,
    inverter: parsed.inverter,
    kwh_inc: Number(inc.toFixed(6)),
  });
  energyBuckets[key] = { bucketStart, kwhStart: kwhNow, day: dKey };
}

function readingQueueKey(row) {
  return `${Number(row?.ts || 0)}|${Number(row?.inverter || 0)}|${Number(row?.unit || 0)}`;
}

function energyQueueKey(row) {
  return `${Number(row?.ts || 0)}|${Number(row?.inverter || 0)}`;
}

function syncPendingQueueStats() {
  pollStats.pendingReadingQueueSize = pendingReadingQueue.size;
  pollStats.pendingEnergyQueueSize = pendingEnergyQueue.size;
  if (pendingReadingQueue.size > pollStats.pendingReadingQueueHighWater) {
    pollStats.pendingReadingQueueHighWater = pendingReadingQueue.size;
  }
  if (pendingEnergyQueue.size > pollStats.pendingEnergyQueueHighWater) {
    pollStats.pendingEnergyQueueHighWater = pendingEnergyQueue.size;
  }
}

function enqueueBounded(map, key, row, maxRows, dropCounterField, label) {
  if (map.has(key)) {
    map.set(key, row);
    return;
  }
  map.set(key, row);
  while (map.size > maxRows) {
    const oldestKey = map.keys().next();
    if (oldestKey.done) break;
    map.delete(oldestKey.value);
    pollStats[dropCounterField] += 1;
    const dropped = Number(pollStats[dropCounterField] || 0);
    if (dropped === 1 || dropped % 500 === 0) {
      console.warn(
        `[poller] ${label} backlog cap reached; dropped ${dropped} oldest queued row(s).`,
      );
    }
  }
}

function enqueuePendingPersist(readingRows = [], energyRows = []) {
  for (const row of readingRows) {
    enqueueBounded(
      pendingReadingQueue,
      readingQueueKey(row),
      row,
      DB_READING_BACKLOG_MAX_ROWS,
      "dbPersistDroppedReadingCount",
      "reading",
    );
  }
  for (const row of energyRows) {
    enqueueBounded(
      pendingEnergyQueue,
      energyQueueKey(row),
      row,
      DB_ENERGY_BACKLOG_MAX_ROWS,
      "dbPersistDroppedEnergyCount",
      "energy_5min",
    );
  }
  syncPendingQueueStats();
}

function flushPersistBacklog(reason = "tick") {
  if (!pendingReadingQueue.size && !pendingEnergyQueue.size) {
    pollStats.lastDbPersistError = "";
    syncPendingQueueStats();
    return true;
  }
  const readingRows = Array.from(pendingReadingQueue.values()).sort((a, b) =>
    Number(a.ts || 0) - Number(b.ts || 0) ||
    Number(a.inverter || 0) - Number(b.inverter || 0) ||
    Number(a.unit || 0) - Number(b.unit || 0),
  );
  const energyRows = Array.from(pendingEnergyQueue.values()).sort((a, b) =>
    Number(a.ts || 0) - Number(b.ts || 0) ||
    Number(a.inverter || 0) - Number(b.inverter || 0),
  );
  try {
    bulkInsertPollerBatch(readingRows, energyRows);
    pendingReadingQueue.clear();
    pendingEnergyQueue.clear();
    pollStats.dbBulkInsertCount += 1;
    pollStats.lastDbPersistError = "";
    pollStats.lastDbPersistOkTs = Date.now();
    _flushRetryCount = 0;
    syncPendingQueueStats();
    return true;
  } catch (err) {
    pollStats.dbInsertErrorCount += 1;
    pollStats.dbPersistRetryCount += 1;
    pollStats.lastDbPersistError = String(err?.message || err || "");
    syncPendingQueueStats();
    console.error(`[poller] DB persist failed (${reason}):`, pollStats.lastDbPersistError);

    // Priority retry under pressure — up to 3 retries with exponential backoff
    if (_flushRetryCount < 3) {
      const bp = getEnergyBacklogPressure();
      if (bp.pressure !== "normal") {
        const backoffMs = 100 * Math.pow(2, _flushRetryCount); // 100, 200, 400
        _flushRetryCount++;
        pollStats.energyPriorityRetryCount = (pollStats.energyPriorityRetryCount || 0) + 1;
        setTimeout(() => flushPersistBacklog("pressure-retry"), backoffMs);
        return false;
      }
    }
    return false;
  }
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

function getTodayPacRowsRaw() {
  resetPacTodayIfNeeded(Date.now());
  ensureTodayEnergyBaseline(Date.now());
  return buildTodayEnergyRowsFromSeed({
    seededTotalByInv: todayEnergyBaselineByInv,
    seededLiveByInv: todayEnergyBaselineLiveByInv,
    currentLiveByInv: buildPacTodayByInverterMap(),
  });
}

function updateTodayEnergyHealthFromTotals(totals, now = Date.now()) {
  const result = evaluateTodayEnergyHealth({
    pacRows: getTodayPacRowsRaw(),
    liveTotalsByInv: totals,
    prevState: todayEnergyHealthState,
    now,
    solarActive: isSolarWindow(),
  });
  todayEnergyHealthState = result.nextState;
  todayEnergySelectedRows = normalizeTodayEnergyRows(result.rows);
  for (const evt of result.events || []) {
    if (!evt || typeof evt !== "object") continue;
    if (evt.type === "source_change") {
      console.log(
        `[today-energy] inv=${evt.inverter} source=${evt.source}` +
        ` reason=${evt.reasonCode}` +
        ` pac=${Number(evt.pacKwh || 0).toFixed(3)}kWh` +
        ` livePac=${Number(evt.livePacW || 0).toFixed(0)}W`,
      );
      continue;
    }
    if (evt.type === "summary_change") {
      const health = evt.health || {};
      console.log(
        `[today-energy] state=${String(health.state || "unknown")}` +
        ` reason=${String(health.reasonCode || "")}` +
        ` fallback=${Number(health.fallbackActiveCount || 0)}` +
        ` stale=${Number(health.staleCount || 0)}` +
        ` mismatch=${Number(health.mismatchCount || 0)}`,
      );
    }
  }
}

function markAllOffline() {
  for (const [key, d] of Object.entries(liveData)) {
    if (!d) continue;
    if (Number(d.online || 0) === 1) pollStats.offlineMarkCount += 1;
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
  const pollStartedAt = Date.now();
  pollStats.tickCount += 1;
  pollStats.lastPollStartedTs = pollStartedAt;
  let parsedThisTick = 0;
  let acceptedThisTick = 0;
  let skippedConfigThisTick = 0;
  let noChangeThisTick = 0;
  let persistedThisTick = 0;
  let skippedCadenceThisTick = 0;
  const energyBatch = [];

  const apiUrl = getSetting('apiUrl', 'http://127.0.0.1:9100/data');
  const ipConfig = loadIpConfigSnapshot();
  const ipConfigLookup = buildIpConfigLookup(ipConfig);
  const expectedKeys = getExpectedKeysFromIpConfig(ipConfig);
  const expectedSet = new Set(expectedKeys);

  let rows = [];
  let fetchOk = false;
  try {
    const res = await fetch(apiUrl, { timeout: API_FETCH_TIMEOUT_MS });
    if (!res.ok) {
      throw new Error(`Gateway poll HTTP ${res.status}`);
    }
    rows = await res.json();
    if (!Array.isArray(rows)) rows = [];
    fetchOk = true;
    pollStats.fetchOkCount += 1;
    pollStats.rowsFetched += rows.length;
    pollStats.lastFetchError = "";
    apiFailMs = 0;
    apiOfflineBroadcasted = false;
  } catch (e) {
    fetchOk = false;
    pollStats.fetchErrorCount += 1;
    pollStats.lastFetchError = String(e?.message || e || "");
    apiFailMs += Math.max(POLL_MS, Date.now() - pollStartedAt);
  }

  // Avoid flapping all cards on short API hiccups.
  if (!fetchOk) {
    flushPersistBacklog("fetch-error-retry");
    if (apiFailMs >= OFFLINE_MS && !apiOfflineBroadcasted) {
      markAllOffline();
      apiOfflineBroadcasted = true;
    }
    updateLiveSnapshotCache();
    const totals = buildTotals(now);
    updateTodayEnergyHealthFromTotals(totals, now);
    broadcastUpdate({ type: 'live', data: liveData, totals });
    const pollEndedAt = Date.now();
    const dur = Math.max(0, pollEndedAt - pollStartedAt);
    pollStats.lastPollEndedTs = pollEndedAt;
    pollStats.lastPollDurationMs = dur;
    pollStats.avgPollDurationMs =
      ((pollStats.avgPollDurationMs * (pollStats.tickCount - 1)) + dur) /
      pollStats.tickCount;
    if (dur > pollStats.maxPollDurationMs) pollStats.maxPollDurationMs = dur;
    return;
  }

  const batch = [];
  const alarmBatch = [];
  const seen  = new Set();

  for (const row of rows) {
    const identity = resolveConfiguredTelemetryIdentity(row, ipConfigLookup);
    if (!identity?.ok) {
      if (
        identity?.reasonCode === "ip_unconfigured" ||
        identity?.reasonCode === "unit_unconfigured"
      ) {
        skippedConfigThisTick += 1;
      }
      continue;
    }

    const parsed = parseRow(row, identity);
    if (!parsed) continue;
    parsedThisTick += 1;
    const key = `${parsed.inverter}_${parsed.unit}`;

    // Fix #5: track frame age (Python sweep lag vs Node poll interval)
    const frameAge = Math.max(0, Date.now() - Number(parsed.ts || 0));
    if (frameAge > pollStats.frameAgeMaxMs) pollStats.frameAgeMaxMs = frameAge;
    pollStats.frameAgeAvgMs = pollStats.frameAgeAvgMs
      ? pollStats.frameAgeAvgMs * 0.95 + frameAge * 0.05
      : frameAge;

    integratePacToday(parsed);

    seen.add(key);
    markSeenKey(key);

    // Skip if identical to previous
    const prev = liveData[key];
    if (prev &&
        prev.pac === parsed.pac &&
        prev.alarm === parsed.alarm &&
        prev.on_off === parsed.on_off) {
      // Heartbeat refresh: keep timestamp/online fresh even when values are stable.
      prev.ts = parsed.ts;
      prev.online = 1;
      prev.kwh = parsed.kwh;
      prev.day = parsed.day;
      noChangeThisTick += 1;
      continue;
    }

    liveData[key] = parsed;
    acceptedThisTick += 1;
    alarmBatch.push(parsed);

    // Persist with cadence guard to reduce synchronous DB pressure.
    const persistPrev = lastPersistState[key];
    const forcePersist =
      !persistPrev ||
      Number(parsed.alarm || 0) !== Number(persistPrev.alarm || 0) ||
      Number(parsed.on_off || 0) !== Number(persistPrev.on_off || 0);
    const elapsedMs = !persistPrev
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, Number(parsed.ts || 0) - Number(persistPrev.ts || 0));
    const pacDelta = !persistPrev
      ? Number.MAX_SAFE_INTEGER
      : Math.abs(Number(parsed.pac || 0) - Number(persistPrev.pac || 0));
    const inSolarWindow = isSolarWindowAt(parsed.ts);
    const shouldPersist =
      inSolarWindow &&
      (forcePersist || elapsedMs >= DB_MIN_PERSIST_MS || pacDelta >= DB_PAC_DELTA_PERSIST_W);

    if (!inSolarWindow) {
      // Track skips outside the solar window so clock-drift energy loss is visible
      pollStats.solarWindowSkipCount += 1;
    }

    if (shouldPersist) {
      batch.push(toPersistedReadingRow(parsed));
      update5minBucket(parsed, energyBatch);
      lastPersistState[key] = {
        ts: Number(parsed.ts || 0),
        pac: Number(parsed.pac || 0),
        alarm: Number(parsed.alarm || 0),
        on_off: Number(parsed.on_off || 0),
      };
      persistedThisTick += 1;
    } else {
      skippedCadenceThisTick += 1;
    }

  }

  enqueuePendingPersist(batch, energyBatch);
  flushPersistBacklog("tick");

  if (alarmBatch.length) {
    try {
      checkAlarms(alarmBatch);
    } catch (e) {
      console.error("[alarms]", e.message);
    }
  }

  // Remove stale keys no longer configured in ipconfig.
  for (const key of Object.keys(liveData)) {
    if (expectedSet.has(key)) continue;
    delete liveData[key];
    if (unreachableState[key]) delete unreachableState[key];
    if (lastPersistState[key]) delete lastPersistState[key];
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

  // ── Availability snapshot at 5-min boundaries ──
  // Records how many inverters are online vs configured for each 5-min slot.
  // Used by forecast engine to detect partial outages in training data.
  // Only writes once liveData has received at least one inverter reading
  // (Object.keys(liveData).length > 0) to avoid artificial (0, N) on startup.
  const availBucket = floorToFiveMinute(now);
  if (fetchOk && availBucket > lastAvailabilityBucketTs && Object.keys(liveData).length > 0) {
    const onlineInverters = new Set();
    for (const d of Object.values(liveData)) {
      if (Number(d.online || 0) === 1 && (now - Number(d.ts || 0)) <= OFFLINE_MS) {
        onlineInverters.add(Number(d.inverter || 0));
      }
    }
    const expectedInverters = new Set();
    for (let inv = 1; inv <= 27; inv++) {
      const ip = String(
        ipConfig?.inverters?.[inv] ?? ipConfig?.inverters?.[String(inv)] ?? "",
      ).trim();
      if (ip) expectedInverters.add(inv);
    }
    if (expectedInverters.size > 0) {
      try {
        upsertAvailability5min(availBucket, onlineInverters.size, expectedInverters.size);
        lastAvailabilityBucketTs = availBucket;
      } catch (err) {
        console.error("[poller] availability_5min upsert failed:", err.message);
      }
    }
  }

  updateTodayEnergyHealthFromTotals(totals, now);
  updateLiveSnapshotCache();
  broadcastUpdate({ type: 'live', data: liveData, totals });

  pollStats.rowsParsed += parsedThisTick;
  pollStats.rowsAccepted += acceptedThisTick;
  pollStats.rowsSkippedUnconfigured += skippedConfigThisTick;
  pollStats.rowsNoChange += noChangeThisTick;
  pollStats.rowsPersisted += persistedThisTick;
  pollStats.rowsPersistSkippedCadence += skippedCadenceThisTick;
  const pollEndedAt = Date.now();
  const dur = Math.max(0, pollEndedAt - pollStartedAt);
  pollStats.lastPollEndedTs = pollEndedAt;
  pollStats.lastPollDurationMs = dur;
  pollStats.avgPollDurationMs =
    ((pollStats.avgPollDurationMs * (pollStats.tickCount - 1)) + dur) /
    pollStats.tickCount;
  if (dur > pollStats.maxPollDurationMs) pollStats.maxPollDurationMs = dur;
}

function start() {
  if (running) return;
  running = true;
  (function tick() {
    if (!running) return;
    const tickStartedAt = Date.now();
    poll()
      .catch((err) => console.error("[poller] unhandled poll error:", err.message))
      .finally(() => {
        const delay = Math.max(0, POLL_MS - (Date.now() - tickStartedAt));
        pollTimer = setTimeout(tick, delay);
      });
  })();
}

function stop() {
  running = false;
  clearTimeout(pollTimer);
}

// Flush any liveData readings not yet written due to cadence guards.
// Also flushes current partial 5-min buckets so a graceful restart does not
// lose the energy accumulated in the current bucket window.
function flushPending() {
  const now = Date.now();
  const batch = [];
  for (const d of Object.values(liveData)) {
    if (!d || !d.ts) continue;
    if (!isSolarWindowAt(d.ts)) continue;
    const key = `${d.inverter}_${d.unit}`;
    const prev = lastPersistState[key];
    if (prev && Number(d.ts) <= Number(prev.ts)) continue;
    batch.push(toPersistedReadingRow(d));
    lastPersistState[key] = {
      ts: Number(d.ts), pac: Number(d.pac || 0),
      alarm: Number(d.alarm || 0), on_off: Number(d.on_off || 0),
    };
  }

  // ── Partial 5-min bucket flush (FIX: server restart was losing active bucket) ──
  // Write the energy accumulated in the current (incomplete) 5-min window so
  // a restart does not permanently lose up to 5 min of solar generation.
  const partialEnergyBatch = [];
  const dKey = dayKey(now);
  for (const [invKey, state] of Object.entries(energyBuckets)) {
    if (!state || state.day !== dKey) continue;
    const inv = Number(invKey);
    if (!(inv > 0)) continue;
    const kwhNow = Number(pacTodayByInverter[inv] || 0);
    const inc = Math.max(0, kwhNow - Number(state.kwhStart || 0));
    if (!(inc > 0)) continue;
    // Use the current wall-clock bucket start as the timestamp
    const bucketTs = floorToFiveMinute(now);
    partialEnergyBatch.push({
      ts: bucketTs,
      inverter: inv,
      kwh_inc: Number(inc.toFixed(6)),
    });
    pollStats.partialBucketFlushCount += 1;
    console.log(
      `[energy] partial bucket flushed on shutdown: inv=${inv}` +
      ` inc=${inc.toFixed(4)}kWh bucket=${new Date(bucketTs).toISOString()}`,
    );
  }

  enqueuePendingPersist(batch, partialEnergyBatch);
  flushPersistBacklog("shutdown");
}

function getLiveData() { return liveData; }

function getLiveSnapshotJson() {
  return {
    json: liveJsonCache,
    ts: liveJsonCacheTs,
  };
}

function getTodayPacKwh() {
  if (Array.isArray(todayEnergySelectedRows) && todayEnergySelectedRows.length) {
    return normalizeTodayEnergyRows(todayEnergySelectedRows);
  }
  return getTodayPacRowsRaw();
}

function getTodayPacRawKwh() {
  return getTodayPacRowsRaw();
}

function getTodayEnergyHealth() {
  return {
    ...(todayEnergyHealthState?.summary || {}),
    sourceRows: {
      pac: getTodayPacRowsRaw(),
      selected: normalizeTodayEnergyRows(todayEnergySelectedRows),
    },
  };
}

function getPerfStats() {
  return {
    running: Boolean(running),
    pollMs: POLL_MS,
    offlineMs: OFFLINE_MS,
    maxPacDtS: MAX_PAC_DT_S,
    solarHourStart: SOLAR_HOUR_START,
    solarHourEnd: SOLAR_HOUR_END,
    liveKeyCount: Object.keys(liveData).length,
    expectedSuppressedKeyCount: Object.keys(unreachableState).length,
    ...pollStats,
    avgPollDurationMs: Number(Number(pollStats.avgPollDurationMs || 0).toFixed(3)),
    todayEnergyHealth: todayEnergyHealthState?.summary || {
      state: "idle",
      reasonCode: "inactive",
      reasonText: "Today-energy health has not been evaluated yet.",
    },
  };
}

module.exports = {
  start,
  stop,
  flushPending,
  markAllOffline,
  getLiveData,
  getLiveSnapshotJson,
  getTodayPacKwh,
  getTodayPacRawKwh,
  getTodayEnergyHealth,
  setIpConfigSnapshot,
  getPerfStats,
  buildTodayEnergyRowsFromSeed,
  buildIpConfigLookup,
  resolveConfiguredTelemetryIdentity,
  getEnergyBacklogPressure,
};
