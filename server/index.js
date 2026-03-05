"use strict";
const express = require("express");
const expressWs = require("express-ws");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { spawnSync } = require("child_process");
const fetch = require("node-fetch");
const cron = require("node-cron");

const {
  getSetting,
  setSetting,
  pruneOldData,
  stmts,
  db,
  DATA_DIR,
  bulkUpsertForecastDayAhead,
  closeDb,
} = require("./db");
const { registerClient, broadcastUpdate, getStats: getWsStats } = require("./ws");
const poller = require("./poller");
const exporter = require("./exporter");
const {
  getActiveAlarms,
  decodeAlarm,
  formatAlarmHex,
  logControlAction,
  getAuditLog,
} = require("./alarms");

// ─── Cloud Backup ─────────────────────────────────────────────────────────────
const TokenStore = require("./tokenStore");
const OneDriveProvider = require("./cloudProviders/onedrive");
const GDriveProvider = require("./cloudProviders/gdrive");
const CloudBackupService = require("./cloudBackup");
const {
  MAX_SHADOW_AGE_MS: CORE_MAX_SHADOW_AGE_MS,
  localDateStr: localDateStrCore,
  normalizeTodayEnergyRows: normalizeTodayEnergyRowsCore,
  mergeTodayEnergyRowsMax: mergeTodayEnergyRowsMaxCore,
  todayEnergyRowsEqual: todayEnergyRowsEqualCore,
  applyGatewayCarryRows,
  evaluateHandoffProgress,
} = require("./mwhHandoffCore");

const app = express();
expressWs(app);
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || LOCAL_ORIGIN_RE.test(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || Number(err.status || 0) === 413)) {
    return res.status(413).json({
      ok: false,
      error: "Payload too large for a single request. Retry using chunked replication push.",
    });
  }
  return next(err);
});
app.use("/assets", express.static(path.join(__dirname, "../assets")));
app.use(express.static(path.join(__dirname, "../public")));
app.use("/api", remoteApiTokenGate);
const PORT = 3500;
const REMOTE_GATEWAY_DEFAULT_PORT = 3500;
const PORTABLE_ROOT = String(process.env.IM_PORTABLE_DATA_DIR || "").trim();
const PROGRAMDATA_ROOT = PORTABLE_ROOT
  ? path.join(PORTABLE_ROOT, "programdata")
  : path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "InverterDashboard");
const FORECAST_CTX_PATH = path.join(
  PROGRAMDATA_ROOT,
  "forecast",
  "context",
  "global",
  "global.json",
);
const FORECAST_CTX_MTIME_KEY = "forecastCtxMtimeMs";
const ROOT_DIR = path.join(__dirname, "..");
const INVERTER_ENGINE_BASE_URL = "http://127.0.0.1:9100";
const FORECAST_EXE_NAMES = ["ForecastCoreService.exe"];
const FORECAST_SCRIPT_NAMES = ["ForecastCoreService.py"];
const WEATHER_LAT = 6.772269;
const WEATHER_LON = 125.284455;
const WEATHER_TZ = "Asia/Manila";
const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;
const WEATHER_DAILY_FIELDS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "cloudcover_mean",
  "windspeed_10m_max",
  "shortwave_radiation_sum",
].join(",");
const weatherWeeklyCache = new Map();
const SOLCAST_TIMEOUT_MS = 20000;
const SOLCAST_SLOT_MIN = 5;
const SOLCAST_SOLAR_START_H = 5;
const SOLCAST_SOLAR_END_H = 18;
const SOLCAST_UNIT_KW_MAX = 997.0;
const REPORT_SOLAR_START_H = SOLCAST_SOLAR_START_H;
const REPORT_SOLAR_END_H = SOLCAST_SOLAR_END_H;
const REPORT_UNIT_KW_MAX = SOLCAST_UNIT_KW_MAX;
const REPORT_EXPECTED_NODES_PER_INVERTER = 4;
const AVAIL_MAX_GAP_S = 120; // max interval treated as online (6× OFFLINE_MS=20s)
const ENERGY_5MIN_UNPAGED_ROW_CAP = 50000; // safety cap for the non-paged fallback path
const REMOTE_BRIDGE_INTERVAL_MS = 1200;
const REMOTE_FETCH_TIMEOUT_MS = 5000;
const REMOTE_REPLICATION_TIMEOUT_MS = 300000;
const REMOTE_REPLICATION_RETRY_MS = 30000;
const REMOTE_INCREMENTAL_INTERVAL_MS = 3000;
const REMOTE_INCREMENTAL_APPEND_LIMIT = 10000;
const REMOTE_PUSH_DELTA_LIMIT = 50000;
const REMOTE_PUSH_CHUNK_MAX_ROWS = 3000;
const REMOTE_PUSH_CHUNK_TARGET_BYTES = 2 * 1024 * 1024;
const REMOTE_PUSH_FETCH_RETRIES = 3;
const REMOTE_PUSH_FETCH_RETRY_BASE_MS = 1200;
const REMOTE_INCREMENTAL_STARTUP_MAX_BATCHES = 200;
const REMOTE_INCREMENTAL_MANUAL_MAX_BATCHES = 200;
const REMOTE_INCREMENTAL_CATCHUP_PASSES = 8;
const REMOTE_INCREMENTAL_REQUEST_TIMEOUT_MS = 90000;
const REMOTE_INCREMENTAL_FETCH_RETRIES = 3;
const REMOTE_INCREMENTAL_FETCH_RETRY_BASE_MS = 1200;
const LIVE_FRESH_MS = 20000;
const REMOTE_CLIENT_PULL_ONLY = false;
const REMOTE_TODAY_SHADOW_SETTING_KEY = "remoteTodayEnergyShadow";
const REMOTE_GATEWAY_HANDOFF_SETTING_KEY = "remoteGatewayHandoffMeta";
const MAX_SHADOW_AGE_MS = CORE_MAX_SHADOW_AGE_MS; // 4h stale same-day shadow protection
const MAX_HANDOFF_ACTIVE_MS = 4 * 60 * 60 * 1000; // 4h hard cap for active handoff
const REMOTE_REPLICATION_PRESERVE_SETTING_KEYS = new Set([
  "operationMode",
  "remoteGatewayUrl",
  "remoteApiToken",
  "tailscaleDeviceHint",
  "wireguardInterface",
  "csvSavePath",
  "remoteReplicationCursors",
  "remoteReplicationLastTs",
  "remoteReplicationLastSignature",
  REMOTE_TODAY_SHADOW_SETTING_KEY,
  REMOTE_GATEWAY_HANDOFF_SETTING_KEY,
]);
const REPLICATION_TABLE_DEFS = [
  {
    name: "readings",
    orderBy: "id ASC",
    columns: [
      "id",
      "ts",
      "inverter",
      "unit",
      "vdc",
      "idc",
      "vac1",
      "vac2",
      "vac3",
      "iac1",
      "iac2",
      "iac3",
      "pac",
      "kwh",
      "alarm",
      "online",
    ],
  },
  {
    name: "energy_5min",
    orderBy: "id ASC",
    columns: ["id", "ts", "inverter", "kwh_inc"],
  },
  {
    name: "alarms",
    orderBy: "id ASC",
    columns: [
      "id",
      "ts",
      "inverter",
      "unit",
      "alarm_code",
      "alarm_value",
      "severity",
      "cleared_ts",
      "acknowledged",
      "updated_ts",
    ],
  },
  {
    name: "audit_log",
    orderBy: "id ASC",
    columns: ["id", "ts", "operator", "inverter", "node", "action", "scope", "result", "ip"],
  },
  {
    name: "daily_report",
    orderBy: "date ASC, inverter ASC",
    columns: [
      "id",
      "date",
      "inverter",
      "kwh_total",
      "pac_peak",
      "pac_avg",
      "uptime_s",
      "alarm_count",
      "control_count",
      "updated_ts",
    ],
  },
  {
    name: "forecast_dayahead",
    orderBy: "date ASC, slot ASC",
    columns: ["date", "ts", "slot", "time_hms", "kwh_inc", "kwh_lo", "kwh_hi", "source", "updated_ts"],
  },
  {
    name: "settings",
    orderBy: "key ASC",
    columns: ["key", "value", "updated_ts"],
  },
];
const REPLICATION_DEF_MAP = Object.fromEntries(
  REPLICATION_TABLE_DEFS.map((x) => [x.name, x]),
);
const REPLICATION_INCREMENTAL_STRATEGY = {
  readings: { mode: "append", cursorColumn: "id", orderBy: "id ASC", limit: REMOTE_INCREMENTAL_APPEND_LIMIT },
  energy_5min: { mode: "append", cursorColumn: "id", orderBy: "id ASC", limit: REMOTE_INCREMENTAL_APPEND_LIMIT },
  audit_log: { mode: "append", cursorColumn: "id", orderBy: "id ASC", limit: REMOTE_INCREMENTAL_APPEND_LIMIT },
  alarms: { mode: "updated", cursorColumn: "updated_ts", orderBy: "updated_ts ASC, id ASC", limit: 0 },
  daily_report: { mode: "updated", cursorColumn: "updated_ts", orderBy: "updated_ts ASC, id ASC", limit: 0 },
  forecast_dayahead: {
    mode: "updated",
    cursorColumn: "updated_ts",
    orderBy: "updated_ts ASC, date ASC, slot ASC",
    limit: 0,
  },
  settings: { mode: "updated", cursorColumn: "updated_ts", orderBy: "updated_ts ASC, key ASC", limit: 0 },
};

let remoteBridgeTimer = null;
const remoteBridgeState = {
  running: false,
  connected: false,
  lastAttemptTs: 0,
  lastSuccessTs: 0,
  lastError: "",
  liveData: {},
  totals: {},
  todayEnergyRows: [],   // gateway /api/energy/today rows, piggybacked from bridge tick
  replicationRunning: false,
  lastReplicationAttemptTs: 0,
  lastReplicationTs: 0,
  lastReplicationError: "",
  lastReplicationSignature: "",
  lastReplicationRows: 0,
  lastIncrementalTs: 0,
  replicationCursors: null,
  lastReconcileTs: 0,
  lastReconcileRows: 0,
  lastReconcileError: "",
  lastSyncDirection: "idle",
  autoSyncAttempted: false,
};
const remoteTodayEnergyShadow = {
  day: "",
  rows: [],
  syncedAt: 0,
};
const gatewayTodayCarryState = {
  day: "",
  byInv: Object.create(null), // inverter -> { shadowBaseKwh, anchorPollerKwh }
};
// Handoff lifecycle: tracks an active Remote→Gateway transition so the stale-shadow
// guard does not discard a freshly-captured shadow and carry-completion can be logged.
const gatewayHandoffMeta = {
  active: false,
  startedAt: 0,
  day: "",
  baselines: Object.create(null), // inv -> shadowKwh at handoff time
};
const inboundPushRxProgress = {
  active: false,
  key: "",
  recvBytes: 0,
};
let cpuSampleTs = Date.now();
let cpuSampleUsage = process.cpuUsage();

// ─── Cloud Backup — Service Initialization ────────────────────────────────────
const _tokenStore  = new TokenStore(DATA_DIR);
const _onedrive    = new OneDriveProvider(_tokenStore);
const _gdrive      = new GDriveProvider(_tokenStore);
const _cloudBackup = new CloudBackupService({
  dataDir:     DATA_DIR,
  db,
  getSetting,
  setSetting,
  tokenStore:  _tokenStore,
  onedrive:    _onedrive,
  gdrive:      _gdrive,
  poller,
  ipConfigPath: path.join(DATA_DIR, "ipconfig.json"),
});
// Apply saved schedule on startup (after cron module is ready).
setTimeout(() => {
  try { _cloudBackup.applyInitialSchedule(); } catch (e) {
    console.warn("[CloudBackup] Schedule init failed:", e.message);
  }
}, 2000);

const CLOUD_OP_BUSY_RE = /already in progress/i;
const CLOUD_OP_MAX_BUSY_RETRIES = 120; // up to ~4 minutes at 2s retry delay
const CLOUD_OP_BUSY_RETRY_MS = 2000;
let _cloudOpRunnerBusy = false;
const _cloudOpQueue = [];

function _scheduleCloudQueueRun(delayMs = 0) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (ms <= 0) {
    setImmediate(_runNextCloudOp);
    return;
  }
  const t = setTimeout(_runNextCloudOp, ms);
  if (t.unref) t.unref();
}

async function _runNextCloudOp() {
  if (_cloudOpRunnerBusy) return;
  const job = _cloudOpQueue.shift();
  if (!job) return;
  _cloudOpRunnerBusy = true;
  let retryBusy = false;
  try {
    await job.fn();
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (
      CLOUD_OP_BUSY_RE.test(msg) &&
      Number(job.busyRetries || 0) < CLOUD_OP_MAX_BUSY_RETRIES
    ) {
      retryBusy = true;
      job.busyRetries = Number(job.busyRetries || 0) + 1;
      _cloudOpQueue.unshift(job);
    } else {
      console.error(`[CloudBackup] queued op "${job.label}" failed:`, msg);
    }
  } finally {
    _cloudOpRunnerBusy = false;
    if (_cloudOpQueue.length > 0) {
      _scheduleCloudQueueRun(retryBusy ? CLOUD_OP_BUSY_RETRY_MS : 0);
    }
  }
}

function enqueueCloudOp(label, fn) {
  const pending = _cloudOpQueue.length + (_cloudOpRunnerBusy ? 1 : 0);
  _cloudOpQueue.push({
    label: String(label || "cloud-op"),
    fn,
    busyRetries: 0,
  });
  _scheduleCloudQueueRun(0);
  return {
    position: pending + 1,
  };
}

// OAuth pending state: stateKey -> { provider, codeVerifier, expiresAt }
const _oauthPending = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function _cleanOauthPending() {
  const now = Date.now();
  for (const [k, v] of _oauthPending) {
    if (now > v.expiresAt) _oauthPending.delete(k);
  }
}

const OAUTH_REDIRECT_BASE = `http://localhost:${3500}/oauth/callback`;

function sanitizeOperationMode(value, def = "gateway") {
  const v = String(value || def)
    .trim()
    .toLowerCase();
  return v === "remote" ? "remote" : "gateway";
}

function sanitizeTailscaleDeviceHint(value, def = "") {
  const v = String(value || def).trim();
  if (!v) return def;
  if (!/^[A-Za-z0-9_.\-]{1,120}$/.test(v)) return def;
  return v;
}

function normalizeGatewayUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw);
  const candidate = hasScheme ? raw : `http://${raw}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname) return "";
    u.username = "";
    u.password = "";
    if (!u.port) u.port = String(REMOTE_GATEWAY_DEFAULT_PORT);
    u.pathname = "/";
    u.search = "";
    u.hash = "";
    return u.origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function readOperationMode() {
  return sanitizeOperationMode(getSetting("operationMode", "gateway"), "gateway");
}

function isRemoteMode() {
  return readOperationMode() === "remote";
}

function isRemotePullOnlyMode() {
  return isRemoteMode() && REMOTE_CLIENT_PULL_ONLY;
}

function readRemoteAutoSyncEnabled() {
  const raw = String(getSetting("remoteAutoSync", "0") || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getRemoteGatewayBaseUrl() {
  return normalizeGatewayUrl(getSetting("remoteGatewayUrl", ""));
}

function getRemoteApiToken() {
  return String(getSetting("remoteApiToken", "") || "").trim();
}

function isLoopbackAddress(addr) {
  const ip = String(addr || "")
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

function isLoopbackRequest(req) {
  return (
    isLoopbackAddress(req?.ip) ||
    isLoopbackAddress(req?.socket?.remoteAddress) ||
    isLoopbackAddress(req?.connection?.remoteAddress)
  );
}

function readBearerToken(req) {
  const hdr = String(req?.headers?.authorization || "").trim();
  if (!/^bearer\s+/i.test(hdr)) return "";
  return hdr.slice(7).trim();
}

function resolveRequestToken(req) {
  return (
    String(req?.headers?.["x-inverter-remote-token"] || "").trim() ||
    readBearerToken(req)
  );
}

function shouldProxyApiPath(pathname) {
  const p = String(pathname || "");
  if (p === "/backup" || p.startsWith("/backup/")) return false;
  if (p === "/settings" || p.startsWith("/settings/")) return false;
  if (p === "/runtime/network" || p.startsWith("/runtime/network/")) return false;
  if (p === "/runtime/perf" || p.startsWith("/runtime/perf/")) return false;
  if (p === "/tailscale/status" || p.startsWith("/tailscale/status/")) return false;
  if (p === "/wireguard/status" || p.startsWith("/wireguard/status/")) return false;
  if (p === "/runtime/network/test" || p.startsWith("/runtime/network/test/"))
    return false;
  if (p === "/forecast/generate" || p.startsWith("/forecast/generate/"))
    return false;
  if (p === "/live" || p.startsWith("/live/")) return false;
  if (p === "/write" || p.startsWith("/write/")) return false;
  if (p.startsWith("/export/")) return false;
  return true;
}

function getRuntimeLiveData() {
  return isRemoteMode() ? remoteBridgeState.liveData || {} : poller.getLiveData();
}

function sampleProcessCpuPercent() {
  const now = Date.now();
  const elapsedMs = Math.max(1, now - cpuSampleTs);
  const usageNow = process.cpuUsage();
  const deltaUser = Math.max(0, Number(usageNow.user || 0) - Number(cpuSampleUsage.user || 0));
  const deltaSys = Math.max(0, Number(usageNow.system || 0) - Number(cpuSampleUsage.system || 0));
  cpuSampleTs = now;
  cpuSampleUsage = usageNow;
  const cpuCount = Math.max(1, Number(os.cpus()?.length || 1));
  const cpuMicrosCapacity = elapsedMs * 1000 * cpuCount;
  const pct = cpuMicrosCapacity > 0 ? ((deltaUser + deltaSys) / cpuMicrosCapacity) * 100 : 0;
  return Number(Math.max(0, Math.min(100, pct)).toFixed(2));
}

function getRuntimePerfSnapshot() {
  const mem = process.memoryUsage();
  const mb = (v) => Number((Number(v || 0) / (1024 * 1024)).toFixed(2));
  const mode = readOperationMode();
  const pollerStats =
    typeof poller.getPerfStats === "function" ? poller.getPerfStats() : {};
  const wsStats = typeof getWsStats === "function" ? getWsStats() : {};
  return {
    ok: true,
    ts: Date.now(),
    operationMode: mode,
    process: {
      pid: process.pid,
      uptimeSec: Number(process.uptime().toFixed(2)),
      cpuPercent: sampleProcessCpuPercent(),
      memoryMb: {
        rss: mb(mem.rss),
        heapTotal: mb(mem.heapTotal),
        heapUsed: mb(mem.heapUsed),
        external: mb(mem.external),
      },
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    poller: pollerStats,
    ws: wsStats,
    remote: {
      connected: Boolean(remoteBridgeState.connected),
      running: Boolean(remoteBridgeState.running),
      replicationRunning: Boolean(remoteBridgeState.replicationRunning),
      lastSuccessTs: Number(remoteBridgeState.lastSuccessTs || 0),
      lastError: String(remoteBridgeState.lastError || ""),
      lastReplicationTs: Number(remoteBridgeState.lastReplicationTs || 0),
      lastIncrementalTs: Number(remoteBridgeState.lastIncrementalTs || 0),
      lastReplicationRows: Number(remoteBridgeState.lastReplicationRows || 0),
      lastReplicationError: String(remoteBridgeState.lastReplicationError || ""),
      lastSyncDirection: String(remoteBridgeState.lastSyncDirection || "idle"),
    },
  };
}

function computeTotalsFromLiveData(data) {
  const now = Date.now();
  const out = {};
  const rows = data && typeof data === "object" ? Object.values(data) : [];
  for (const row of rows) {
    const inv = Number(row?.inverter || 0);
    if (!inv) continue;
    const ts = Number(row?.ts || 0);
    const online = Number(row?.online || 0) === 1;
    if (!online || !ts || now - ts > LIVE_FRESH_MS) continue;
    if (!out[inv]) out[inv] = { pac: 0, pdc: 0, kwh: 0 };
    out[inv].pac += Number(row?.pac || 0);
    out[inv].pdc += Number(row?.pdc || 0);
    out[inv].kwh += Number(row?.kwh || 0);
  }
  return out;
}

function normalizeReplicationCursors(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const table of Object.keys(REPLICATION_INCREMENTAL_STRATEGY)) {
    const v = Number(src[table] || 0);
    out[table] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return out;
}

function readReplicationCursorsSetting() {
  try {
    const raw = String(getSetting("remoteReplicationCursors", "") || "").trim();
    if (!raw) return normalizeReplicationCursors({});
    return normalizeReplicationCursors(JSON.parse(raw));
  } catch {
    return normalizeReplicationCursors({});
  }
}

function saveReplicationCursorsSetting(cursors) {
  const safe = normalizeReplicationCursors(cursors);
  setSetting("remoteReplicationCursors", JSON.stringify(safe));
  return safe;
}

function buildCurrentReplicationCursors() {
  const out = normalizeReplicationCursors({});
  for (const [table, strategy] of Object.entries(REPLICATION_INCREMENTAL_STRATEGY)) {
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(MAX(${strategy.cursorColumn}),0) AS v FROM ${table}`,
        )
        .get();
      const v = Number(row?.v || 0);
      out[table] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    } catch {
      out[table] = 0;
    }
  }
  return out;
}

function getReplicationWatermarkColumn(tableName, strategy) {
  const s = strategy || REPLICATION_INCREMENTAL_STRATEGY[tableName] || {};
  const def = REPLICATION_DEF_MAP[tableName];
  if (!def) return "id";
  if (s.mode === "append") {
    if (def.columns.includes("ts")) return "ts";
    return String(s.cursorColumn || "id");
  }
  return String(s.cursorColumn || "updated_ts");
}

function buildReplicationSummary() {
  const tables = {};
  let globalWatermark = 0;
  for (const def of REPLICATION_TABLE_DEFS) {
    const strategy = REPLICATION_INCREMENTAL_STRATEGY[def.name];
    if (!strategy) continue;
    const watermarkColumn = getReplicationWatermarkColumn(def.name, strategy);
    const hasId = def.columns.includes("id");
    const sql = hasId
      ? `SELECT COUNT(1) AS rowCount,
                COALESCE(MAX(COALESCE(${watermarkColumn}, 0)), 0) AS watermark,
                COALESCE(MAX(id), 0) AS maxId
           FROM ${def.name}`
      : `SELECT COUNT(1) AS rowCount,
                COALESCE(MAX(COALESCE(${watermarkColumn}, 0)), 0) AS watermark
           FROM ${def.name}`;
    let row = {};
    try {
      row = db.prepare(sql).get() || {};
    } catch {
      row = {};
    }
    const watermark = Number(row?.watermark || 0);
    const rowCount = Number(row?.rowCount || 0);
    const maxId = Number(row?.maxId || 0);
    tables[def.name] = {
      mode: strategy.mode,
      watermarkColumn,
      watermark: Number.isFinite(watermark) ? watermark : 0,
      rowCount: Number.isFinite(rowCount) ? rowCount : 0,
      maxId: Number.isFinite(maxId) ? maxId : 0,
    };
    globalWatermark = Math.max(globalWatermark, tables[def.name].watermark);
  }

  const signature = crypto
    .createHash("sha1")
    .update(JSON.stringify({ tables }))
    .digest("hex");

  return {
    generatedTs: Date.now(),
    mode: readOperationMode(),
    source: readOperationMode() === "remote" ? "remote-client" : "gateway",
    globalWatermark,
    tables,
    signature,
  };
}

function normalizeReplicationSummary(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const inTables = src.tables && typeof src.tables === "object" ? src.tables : {};
  const tables = {};
  let globalWatermark = 0;
  for (const def of REPLICATION_TABLE_DEFS) {
    const strategy = REPLICATION_INCREMENTAL_STRATEGY[def.name];
    if (!strategy) continue;
    const row = inTables[def.name] && typeof inTables[def.name] === "object" ? inTables[def.name] : {};
    const watermark = Number(row?.watermark || 0);
    const rowCount = Number(row?.rowCount || 0);
    const maxId = Number(row?.maxId || 0);
    tables[def.name] = {
      mode: strategy.mode,
      watermarkColumn: getReplicationWatermarkColumn(def.name, strategy),
      watermark: Number.isFinite(watermark) && watermark > 0 ? watermark : 0,
      rowCount: Number.isFinite(rowCount) && rowCount > 0 ? rowCount : 0,
      maxId: Number.isFinite(maxId) && maxId > 0 ? maxId : 0,
    };
    globalWatermark = Math.max(globalWatermark, tables[def.name].watermark);
  }
  return {
    generatedTs: Number(src?.generatedTs || 0),
    mode: sanitizeOperationMode(src?.mode || "gateway", "gateway"),
    source: String(src?.source || ""),
    signature: String(src?.signature || ""),
    globalWatermark,
    tables,
  };
}

function hasLocalNewerReplicationData(localSummaryRaw, gatewaySummaryRaw) {
  const local = normalizeReplicationSummary(localSummaryRaw);
  const remote = normalizeReplicationSummary(gatewaySummaryRaw);
  for (const def of REPLICATION_TABLE_DEFS) {
    const a = Number(local.tables?.[def.name]?.watermark || 0);
    const b = Number(remote.tables?.[def.name]?.watermark || 0);
    if (a > b) return true;
  }
  return false;
}

function buildPushDeltaAgainstSummary(peerSummaryRaw) {
  const peerSummary = normalizeReplicationSummary(peerSummaryRaw);
  const tables = {};
  const tableCounts = {};
  let totalRows = 0;

  for (const def of REPLICATION_TABLE_DEFS) {
    const strategy = REPLICATION_INCREMENTAL_STRATEGY[def.name];
    if (!strategy) continue;
    const cols = def.columns.join(", ");
    const watermarkColumn = getReplicationWatermarkColumn(def.name, strategy);
    const peerWatermark = Number(peerSummary.tables?.[def.name]?.watermark || 0);
    let rows = [];
    if (strategy.mode === "append") {
      const orderBy = def.columns.includes("id")
        ? `${watermarkColumn} ASC, id ASC`
        : `${watermarkColumn} ASC`;
      rows = db
        .prepare(
          `SELECT ${cols}
             FROM ${def.name}
            WHERE COALESCE(${watermarkColumn}, 0) > ?
            ORDER BY ${orderBy}
            LIMIT ?`,
        )
        .all(peerWatermark, REMOTE_PUSH_DELTA_LIMIT);
    } else {
      rows = db
        .prepare(
          `SELECT ${cols}
             FROM ${def.name}
            WHERE COALESCE(${watermarkColumn}, 0) > ?
            ORDER BY ${strategy.orderBy}`,
        )
        .all(peerWatermark);
    }
    tables[def.name] = rows;
    tableCounts[def.name] = rows.length;
    totalRows += rows.length;
  }

  const localSummary = buildReplicationSummary();
  const signature = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        sourceSignature: localSummary.signature,
        peerSignature: peerSummary.signature,
        tableCounts,
      }),
    )
    .digest("hex");

  return {
    meta: {
      generatedTs: Date.now(),
      mode: "push-delta",
      sourceSummary: localSummary,
      peerSummary,
      tableCounts,
      totalRows,
      signature,
    },
    tables,
  };
}

function countReplicationRowsByTables(tablesRaw) {
  const tables = tablesRaw && typeof tablesRaw === "object" ? tablesRaw : {};
  let total = 0;
  for (const def of REPLICATION_TABLE_DEFS) {
    const rows = Array.isArray(tables[def.name]) ? tables[def.name] : [];
    total += rows.length;
  }
  return total;
}

function buildPushDeltaChunks(deltaPayload) {
  const delta = deltaPayload && typeof deltaPayload === "object" ? deltaPayload : null;
  if (!delta) return [];
  const inTables = delta.tables && typeof delta.tables === "object" ? delta.tables : {};
  const sourceMeta = delta.meta && typeof delta.meta === "object" ? delta.meta : {};
  const safeMaxRows = Math.max(1, Number(REMOTE_PUSH_CHUNK_MAX_ROWS || 1));
  const safeTargetBytes = Math.max(32768, Number(REMOTE_PUSH_CHUNK_TARGET_BYTES || 32768));
  const rawChunks = [];

  let currentTables = Object.create(null);
  let currentRows = 0;
  let currentBytes = 0;

  const flushChunk = () => {
    if (currentRows <= 0) return;
    rawChunks.push({
      tables: currentTables,
      rows: currentRows,
      bytes: currentBytes,
    });
    currentTables = Object.create(null);
    currentRows = 0;
    currentBytes = 0;
  };

  for (const def of REPLICATION_TABLE_DEFS) {
    const rows = Array.isArray(inTables[def.name]) ? inTables[def.name] : [];
    for (const row of rows) {
      const rowBytes = Math.max(8, Buffer.byteLength(JSON.stringify(row ?? null), "utf8"));
      const willOverflowRows = currentRows > 0 && currentRows + 1 > safeMaxRows;
      const willOverflowBytes = currentRows > 0 && currentBytes + rowBytes > safeTargetBytes;
      if (willOverflowRows || willOverflowBytes) {
        flushChunk();
      }
      if (!currentTables[def.name]) {
        currentTables[def.name] = [];
      }
      currentTables[def.name].push(row);
      currentRows += 1;
      currentBytes += rowBytes;
    }
  }
  flushChunk();

  const chunkCount = rawChunks.length;
  const totalRowsFromMeta = Number(sourceMeta?.totalRows || 0);
  const totalRows = totalRowsFromMeta > 0 ? totalRowsFromMeta : countReplicationRowsByTables(inTables);
  const baseMode = String(sourceMeta?.mode || "push").trim() || "push";
  const baseSignature = String(sourceMeta?.signature || "").trim();

  return rawChunks.map((chunk, idx) => {
    const tableCounts = {};
    for (const def of REPLICATION_TABLE_DEFS) {
      const rows = Array.isArray(chunk.tables[def.name]) ? chunk.tables[def.name] : [];
      tableCounts[def.name] = rows.length;
    }
    return {
      meta: {
        generatedTs: Date.now(),
        mode: `${baseMode}-chunk`,
        signature: baseSignature,
        totalRows,
        chunkCount,
        chunkIndex: idx + 1,
        chunkRows: Number(chunk.rows || 0),
        chunkBytes: Number(chunk.bytes || 0),
        tableCounts,
      },
      tables: chunk.tables,
    };
  });
}

function makeReplicationRowPayload(row, cols) {
  const payload = {};
  for (const c of cols) {
    payload[c] = Object.prototype.hasOwnProperty.call(row || {}, c) ? row[c] : null;
  }
  return payload;
}

const REPLICATION_STMT_CACHE = Object.create(null);

function stmtCached(key, sql) {
  if (!REPLICATION_STMT_CACHE[key]) {
    REPLICATION_STMT_CACHE[key] = db.prepare(sql);
  }
  return REPLICATION_STMT_CACHE[key];
}

function mergeAppendReplicationRow(tableName, payload, cols) {
  if (tableName === "readings") {
    const exists = stmtCached(
      "exists:readings:ts_inv_unit",
      `SELECT id FROM readings WHERE ts=? AND inverter=? AND unit=? LIMIT 1`,
    ).get(payload.ts, payload.inverter, payload.unit);
    if (exists?.id) return false;
    const sql = `INSERT INTO readings (${cols.join(", ")}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(", ")})
      ON CONFLICT(id) DO UPDATE SET
        ts=excluded.ts,
        inverter=excluded.inverter,
        unit=excluded.unit,
        vdc=excluded.vdc,
        idc=excluded.idc,
        vac1=excluded.vac1,
        vac2=excluded.vac2,
        vac3=excluded.vac3,
        iac1=excluded.iac1,
        iac2=excluded.iac2,
        iac3=excluded.iac3,
        pac=excluded.pac,
        kwh=excluded.kwh,
        alarm=excluded.alarm,
        online=excluded.online
      WHERE COALESCE(excluded.ts,0) >= COALESCE(readings.ts,0)`;
    stmtCached("merge:readings", sql).run(payload);
    return true;
  }

  if (tableName === "energy_5min") {
    const existingRow = stmtCached(
      "exists:energy_5min:ts_inv",
      `SELECT id, kwh_inc FROM energy_5min WHERE ts=? AND inverter=? LIMIT 1`,
    ).get(payload.ts, payload.inverter);
    if (existingRow?.id) {
      // Row exists for this (ts, inverter). Update kwh_inc if the incoming value differs —
      // this corrects stale local rows that were written with a lower value (e.g., from a
      // previous partial bucket or a prior diverged local-gateway state).
      const incomingKwh = Number(payload.kwh_inc || 0);
      const existingKwh = Number(existingRow.kwh_inc || 0);
      if (Math.abs(incomingKwh - existingKwh) > 1e-9) {
        stmtCached(
          "update:energy_5min:kwh_inc_by_id",
          `UPDATE energy_5min SET kwh_inc=? WHERE id=?`,
        ).run(incomingKwh, existingRow.id);
        return true;
      }
      return false; // identical — no change needed
    }
    const sql = `INSERT INTO energy_5min (${cols.join(", ")}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(", ")})
      ON CONFLICT(id) DO UPDATE SET
        ts=excluded.ts,
        inverter=excluded.inverter,
        kwh_inc=excluded.kwh_inc
      WHERE COALESCE(excluded.ts,0) >= COALESCE(energy_5min.ts,0)`;
    stmtCached("merge:energy_5min", sql).run(payload);
    return true;
  }

  if (tableName === "audit_log") {
    const exists = stmtCached(
      "exists:audit_log:natural",
      `SELECT id
         FROM audit_log
        WHERE ts=? AND inverter=? AND node=? AND action=? AND scope=? AND operator=? AND result=? AND ip=?
        LIMIT 1`,
    ).get(
      payload.ts,
      payload.inverter,
      payload.node,
      payload.action,
      payload.scope,
      payload.operator,
      payload.result,
      payload.ip,
    );
    if (exists?.id) return false;
    const sql = `INSERT INTO audit_log (${cols.join(", ")}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(", ")})
      ON CONFLICT(id) DO UPDATE SET
        ts=excluded.ts,
        operator=excluded.operator,
        inverter=excluded.inverter,
        node=excluded.node,
        action=excluded.action,
        scope=excluded.scope,
        result=excluded.result,
        ip=excluded.ip
      WHERE COALESCE(excluded.ts,0) >= COALESCE(audit_log.ts,0)`;
    stmtCached("merge:audit_log", sql).run(payload);
    return true;
  }

  const sql = `INSERT OR REPLACE INTO ${tableName} (${cols.join(", ")}) VALUES (${cols
    .map((c) => `@${c}`)
    .join(", ")})`;
  stmtCached(`merge:append:${tableName}`, sql).run(payload);
  return true;
}

function mergeUpdatedReplicationRow(tableName, payload, cols, preserveSettings = true) {
  if (tableName === "settings") {
    const k = String(payload?.key || "").trim();
    if (preserveSettings && REMOTE_REPLICATION_PRESERVE_SETTING_KEYS.has(k)) {
      return false;
    }
    const sql = `INSERT INTO settings (${cols.join(", ")}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(", ")})
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_ts=excluded.updated_ts
      WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(settings.updated_ts,0)`;
    stmtCached("merge:settings:lww", sql).run(payload);
    return true;
  }

  if (tableName === "forecast_dayahead") {
    const sql = `INSERT INTO forecast_dayahead (${cols.join(", ")}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(", ")})
      ON CONFLICT(date, slot) DO UPDATE SET
        ts=excluded.ts,
        time_hms=excluded.time_hms,
        kwh_inc=excluded.kwh_inc,
        kwh_lo=excluded.kwh_lo,
        kwh_hi=excluded.kwh_hi,
        source=excluded.source,
        updated_ts=excluded.updated_ts
      WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(forecast_dayahead.updated_ts,0)`;
    stmtCached("merge:forecast_dayahead:lww", sql).run(payload);
    return true;
  }

  if (tableName === "daily_report") {
    // Exclude surrogate `id` — local DB assigns its own AUTOINCREMENT id.
    // Business key is (date, inverter); including gateway's id causes a PK
    // conflict when the client already holds a different row with that id.
    const drCols = cols.filter((c) => c !== "id");
    const drPayload = Object.fromEntries(
      Object.entries(payload).filter(([k]) => k !== "id"),
    );
    const sql = `INSERT INTO daily_report (${drCols.join(", ")}) VALUES (${drCols
      .map((c) => `@${c}`)
      .join(", ")})
      ON CONFLICT(date, inverter) DO UPDATE SET
        kwh_total=excluded.kwh_total,
        pac_peak=excluded.pac_peak,
        pac_avg=excluded.pac_avg,
        uptime_s=excluded.uptime_s,
        alarm_count=excluded.alarm_count,
        control_count=excluded.control_count,
        updated_ts=excluded.updated_ts
      WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(daily_report.updated_ts,0)`;
    stmtCached("merge:daily_report:lww", sql).run(drPayload);
    return true;
  }

  if (tableName === "alarms") {
    const sql = `INSERT INTO alarms (${cols.join(", ")}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(", ")})
      ON CONFLICT(id) DO UPDATE SET
        ts=excluded.ts,
        inverter=excluded.inverter,
        unit=excluded.unit,
        alarm_code=excluded.alarm_code,
        alarm_value=excluded.alarm_value,
        severity=excluded.severity,
        cleared_ts=excluded.cleared_ts,
        acknowledged=excluded.acknowledged,
        updated_ts=excluded.updated_ts
      WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(alarms.updated_ts,0)`;
    stmtCached("merge:alarms:lww", sql).run(payload);
    return true;
  }

  const sql = `INSERT OR REPLACE INTO ${tableName} (${cols.join(", ")}) VALUES (${cols
    .map((c) => `@${c}`)
    .join(", ")})`;
  stmtCached(`merge:updated:${tableName}`, sql).run(payload);
  return true;
}

function applyReplicationTableMerge(tablesPayload, options = {}) {
  const tables =
    tablesPayload && typeof tablesPayload === "object" ? tablesPayload : {};
  const preserveSettings = options?.preserveSettings !== false;
  const runMerge = () => {
    let importedRows = 0;
    let skippedRows = 0;
    for (const def of REPLICATION_TABLE_DEFS) {
      const incoming = Array.isArray(tables[def.name]) ? tables[def.name] : [];
      if (!incoming.length) continue;
      const strategy = REPLICATION_INCREMENTAL_STRATEGY[def.name];
      if (!strategy) continue;
      for (const row of incoming) {
        const payload = makeReplicationRowPayload(row, def.columns);
        const applied =
          strategy.mode === "append"
            ? mergeAppendReplicationRow(def.name, payload, def.columns)
            : mergeUpdatedReplicationRow(
                def.name,
                payload,
                def.columns,
                preserveSettings,
              );
        if (applied) importedRows += 1;
        else skippedRows += 1;
      }
    }
    return { importedRows, skippedRows };
  };
  if (options?.inTransaction) {
    return runMerge();
  }
  return db.transaction(runMerge)();
}

function buildFullDbSnapshot() {
  const generatedTs = Date.now();
  const tableCounts = {};
  const tableWatermarks = {};
  const tables = {};
  const cursors = buildCurrentReplicationCursors();

  for (const def of REPLICATION_TABLE_DEFS) {
    const selectCols = def.columns.join(", ");
    const sql = `SELECT ${selectCols} FROM ${def.name}${def.orderBy ? ` ORDER BY ${def.orderBy}` : ""}`;
    const rows = db.prepare(sql).all();
    tables[def.name] = rows;
    tableCounts[def.name] = rows.length;

    const tail = rows.length ? rows[rows.length - 1] : null;
    tableWatermarks[def.name] =
      tail?.updated_ts ??
      tail?.ts ??
      tail?.id ??
      tail?.date ??
      tail?.key ??
      null;
  }

  const signature = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        tableCounts,
        tableWatermarks,
      }),
    )
    .digest("hex");

  return {
    meta: {
      generatedTs,
      signature,
      source: "gateway",
      tableCounts,
      tableWatermarks,
      cursors,
      schemaVersion: 1,
    },
    tables,
  };
}

function capturePreservedLocalSettings() {
  const keys = Array.from(REMOTE_REPLICATION_PRESERVE_SETTING_KEYS);
  if (!keys.length) return [];
  const placeholders = keys.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .all(...keys);
  return rows.map((r) => ({
    key: String(r?.key || "").trim(),
    value: String(r?.value ?? ""),
  }));
}

function applyFullDbSnapshot(snapshot) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : null;
  if (!snap || typeof snap !== "object") throw new Error("Invalid replication snapshot payload.");
  const tables = snap.tables && typeof snap.tables === "object" ? snap.tables : null;
  if (!tables) throw new Error("Invalid replication snapshot tables.");

  const preserveRows = capturePreservedLocalSettings();
  const importTx = db.transaction(() => {
    const merged = applyReplicationTableMerge(tables, {
      preserveSettings: true,
      inTransaction: true,
    });

    for (const kv of preserveRows) {
      if (!kv?.key) continue;
      setSetting(kv.key, kv.value ?? "");
    }

    setSetting("remoteReplicationLastTs", String(Date.now()));
    if (snap?.meta?.signature) {
      setSetting("remoteReplicationLastSignature", String(snap.meta.signature));
    }
    const nextCursors = normalizeReplicationCursors(
      snap?.meta?.cursors || buildCurrentReplicationCursors(),
    );
    saveReplicationCursorsSetting(nextCursors);

    return {
      importedRows: Number(merged?.importedRows || 0),
      skippedRows: Number(merged?.skippedRows || 0),
      nextCursors,
    };
  });

  const applied = importTx();
  return {
    importedRows: Number(applied?.importedRows || 0),
    skippedRows: Number(applied?.skippedRows || 0),
    tableCounts: snap?.meta?.tableCounts || {},
    signature: String(snap?.meta?.signature || ""),
    nextCursors: normalizeReplicationCursors(applied?.nextCursors || {}),
  };
}

function buildIncrementalReplicationDelta(clientCursorsRaw) {
  const clientCursors = normalizeReplicationCursors(clientCursorsRaw);
  const nextCursors = { ...clientCursors };
  const tables = {};
  const tableCounts = {};
  const hasMoreByTable = {};
  let hasMoreAny = false;

  for (const [tableName, strategy] of Object.entries(REPLICATION_INCREMENTAL_STRATEGY)) {
    const def = REPLICATION_DEF_MAP[tableName];
    if (!def) continue;
    const cols = def.columns.join(", ");
    const cursor = Number(clientCursors[tableName] || 0);
    let rows = [];
    let hasMore = false;

    if (strategy.mode === "append") {
      rows = db
        .prepare(
          `SELECT ${cols}
             FROM ${tableName}
            WHERE ${strategy.cursorColumn} > ?
            ORDER BY ${strategy.orderBy}
            LIMIT ?`,
        )
        .all(cursor, Number(strategy.limit || REMOTE_INCREMENTAL_APPEND_LIMIT));
      const maxSeen = rows.length
        ? Math.max(cursor, ...rows.map((r) => Number(r?.[strategy.cursorColumn] || 0)))
        : cursor;
      nextCursors[tableName] = Number.isFinite(maxSeen) && maxSeen > 0 ? Math.floor(maxSeen) : 0;

      if (rows.length >= Number(strategy.limit || REMOTE_INCREMENTAL_APPEND_LIMIT)) {
        const tail = Number(nextCursors[tableName] || 0);
        const probe = db
          .prepare(
            `SELECT 1 AS x FROM ${tableName} WHERE ${strategy.cursorColumn} > ? LIMIT 1`,
          )
          .get(tail);
        hasMore = Boolean(probe?.x);
      }
    } else {
      rows = db
        .prepare(
          `SELECT ${cols}
             FROM ${tableName}
            WHERE COALESCE(${strategy.cursorColumn}, 0) > ?
            ORDER BY ${strategy.orderBy}`,
        )
        .all(cursor);
      const maxSeen = rows.length
        ? Math.max(cursor, ...rows.map((r) => Number(r?.[strategy.cursorColumn] || 0)))
        : cursor;
      nextCursors[tableName] = Number.isFinite(maxSeen) && maxSeen > 0 ? Math.floor(maxSeen) : 0;
      hasMore = false;
    }

    tables[tableName] = rows;
    tableCounts[tableName] = rows.length;
    hasMoreByTable[tableName] = hasMore;
    if (hasMore) hasMoreAny = true;
  }

  const signature = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        nextCursors,
        tableCounts,
      }),
    )
    .digest("hex");

  return {
    meta: {
      generatedTs: Date.now(),
      mode: "incremental",
      signature,
      clientCursors,
      nextCursors,
      tableCounts,
      hasMoreByTable,
      hasMoreAny,
    },
    tables,
  };
}

function applyIncrementalDbDelta(deltaPayload) {
  const delta = deltaPayload && typeof deltaPayload === "object" ? deltaPayload : null;
  if (!delta || typeof delta !== "object") {
    throw new Error("Invalid incremental replication payload.");
  }
  const tables = delta.tables && typeof delta.tables === "object" ? delta.tables : {};
  const nextCursors = normalizeReplicationCursors(delta?.meta?.nextCursors || {});
  const hasMoreAny = Boolean(delta?.meta?.hasMoreAny);
  const signature = String(delta?.meta?.signature || "");
  const applied = db.transaction(() => {
    const merged = applyReplicationTableMerge(tables, {
      preserveSettings: true,
      inTransaction: true,
    });
    const safe = saveReplicationCursorsSetting(nextCursors);
    setSetting("remoteReplicationLastTs", String(Date.now()));
    if (signature) setSetting("remoteReplicationLastSignature", signature);
    return {
      importedRows: Number(merged?.importedRows || 0),
      safeCursors: safe,
      skippedRows: Number(merged?.skippedRows || 0),
    };
  })();
  return {
    importedRows: Number(applied?.importedRows || 0),
    skippedRows: Number(applied?.skippedRows || 0),
    nextCursors: normalizeReplicationCursors(applied?.safeCursors || nextCursors),
    hasMoreAny,
    signature,
  };
}

function applyReplicationPushDelta(deltaPayload) {
  const delta = deltaPayload && typeof deltaPayload === "object" ? deltaPayload : null;
  if (!delta || typeof delta !== "object") {
    throw new Error("Invalid push replication payload.");
  }
  const tables = delta.tables && typeof delta.tables === "object" ? delta.tables : {};
  const signature = String(delta?.meta?.signature || "");
  const merged = applyReplicationTableMerge(tables, { preserveSettings: true });
  return {
    importedRows: Number(merged?.importedRows || 0),
    skippedRows: Number(merged?.skippedRows || 0),
    signature,
  };
}

async function reconcileRemoteBeforePull(baseUrl) {
  remoteBridgeState.lastReconcileError = "";
  remoteBridgeState.lastReconcileRows = 0;
  let localNewerDetected = false;
  try {
    const summaryRes = await fetch(`${baseUrl}/api/replication/summary`, {
      method: "GET",
      headers: buildRemoteProxyHeaders(),
      timeout: REMOTE_FETCH_TIMEOUT_MS,
    });
    if (!summaryRes.ok) {
      throw new Error(`Summary HTTP ${summaryRes.status} ${summaryRes.statusText}`);
    }
    const summaryData = await summaryRes.json();
    if (!summaryData?.ok || !summaryData?.summary) {
      throw new Error(String(summaryData?.error || "Invalid replication summary payload."));
    }

    const gatewaySummary = normalizeReplicationSummary(summaryData.summary);
    const localSummary = buildReplicationSummary();
    const localNewer = hasLocalNewerReplicationData(localSummary, gatewaySummary);
    localNewerDetected = localNewer;
    if (!localNewer) {
      remoteBridgeState.lastReconcileTs = Date.now();
      remoteBridgeState.lastSyncDirection = "pull-only";
      return { ok: true, pushed: false, rows: 0, localNewer: false };
    }

    const delta = buildPushDeltaAgainstSummary(gatewaySummary);
    const expectedRows = Number(delta?.meta?.totalRows || 0);
    if (expectedRows <= 0) {
      remoteBridgeState.lastReconcileTs = Date.now();
      remoteBridgeState.lastSyncDirection = "pull-only";
      return { ok: true, pushed: false, rows: 0, localNewer: true };
    }

    const pushed = await pushDeltaInChunks(baseUrl, delta);
    remoteBridgeState.lastReconcileTs = Date.now();
    remoteBridgeState.lastReconcileRows = Number(pushed?.importedRows || 0);
    remoteBridgeState.lastSyncDirection = "push-then-pull";
    return {
      ok: true,
      pushed: true,
      rows: Number(pushed?.importedRows || 0),
      skipped: Number(pushed?.skippedRows || 0),
      chunks: Number(pushed?.chunkCount || 0),
      localNewer: true,
    };
  } catch (err) {
    remoteBridgeState.lastReconcileError = String(err?.message || err);
    if (localNewerDetected) {
      remoteBridgeState.lastSyncDirection = "push-failed";
    }
    return {
      ok: false,
      error: remoteBridgeState.lastReconcileError,
      localNewer: localNewerDetected,
    };
  }
}

async function runRemoteFullReplication(baseUrl) {
  if (remoteBridgeState.replicationRunning) return { skipped: true, reason: "in_progress" };
  remoteBridgeState.replicationRunning = true;
  remoteBridgeState.lastReplicationAttemptTs = Date.now();
  remoteBridgeState.lastReplicationError = "";

  try {
    const r = await fetch(`${baseUrl}/api/replication/full`, {
      method: "GET",
      headers: buildRemoteProxyHeaders(),
      timeout: REMOTE_REPLICATION_TIMEOUT_MS,
    });
    if (!r.ok) {
      throw new Error(`Replication HTTP ${r.status} ${r.statusText}`);
    }
    const data = await r.json();
    if (!data?.ok || !data?.snapshot) {
      throw new Error(String(data?.error || "Gateway returned invalid replication payload."));
    }

    const stats = applyFullDbSnapshot(data.snapshot);
    ensurePersistedSettings();
    try {
      const cfg = loadIpConfigFromDb();
      mirrorIpConfigToLegacyFiles(cfg);
      backfillAuditIpsFromConfig();
    } catch (_) {
      // Non-fatal maintenance tasks.
    }

    remoteBridgeState.lastReplicationTs = Date.now();
    remoteBridgeState.lastReplicationRows = Number(stats.importedRows || 0);
    remoteBridgeState.lastReplicationSignature = String(stats.signature || "");
    remoteBridgeState.replicationCursors = normalizeReplicationCursors(
      stats.nextCursors || buildCurrentReplicationCursors(),
    );
    remoteBridgeState.lastReplicationError = "";
    remoteBridgeState.lastIncrementalTs = Date.now();
    if (remoteBridgeState.lastSyncDirection !== "push-then-pull") {
      remoteBridgeState.lastSyncDirection = "pull-full";
    }

    return { ok: true, ...stats };
  } catch (err) {
    remoteBridgeState.lastReplicationError = String(err?.message || err);
    if (remoteBridgeState.lastSyncDirection !== "push-failed") {
      remoteBridgeState.lastSyncDirection = "pull-full-failed";
    }
    return { ok: false, error: remoteBridgeState.lastReplicationError };
  } finally {
    remoteBridgeState.replicationRunning = false;
  }
}

async function runRemoteIncrementalReplication(baseUrl, maxBatches = 5) {
  if (remoteBridgeState.replicationRunning) return { skipped: true, reason: "in_progress" };
  remoteBridgeState.replicationRunning = true;
  remoteBridgeState.lastReplicationAttemptTs = Date.now();
  remoteBridgeState.lastReplicationError = "";

  try {
    let batches = 0;
    let importedRows = 0;
    let hasMore = false;
    let signature = "";
    let totalRecvBytes = 0;
    let cursors = normalizeReplicationCursors(
      remoteBridgeState.replicationCursors || readReplicationCursorsSetting(),
    );

    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "start", recvBytes: 0 });

    do {
      const data = await requestIncrementalDeltaWithRetry(baseUrl, cursors, (bytes) => {
        totalRecvBytes += bytes;
        broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "chunk", recvBytes: totalRecvBytes, batch: batches + 1 });
      });

      const applied = applyIncrementalDbDelta(data.delta);
      importedRows += Number(applied.importedRows || 0);
      signature = String(applied.signature || signature || "");
      cursors = normalizeReplicationCursors(applied.nextCursors || cursors);
      hasMore = Boolean(applied.hasMoreAny);
      batches += 1;
    } while (hasMore && batches < Math.max(1, Number(maxBatches || 5)));

    ensurePersistedSettings();
    try {
      const cfg = loadIpConfigFromDb();
      mirrorIpConfigToLegacyFiles(cfg);
      backfillAuditIpsFromConfig();
    } catch (_) {
      // Non-fatal maintenance tasks.
    }

    remoteBridgeState.lastIncrementalTs = Date.now();
    remoteBridgeState.lastReplicationTs = Date.now();
    remoteBridgeState.lastReplicationRows = importedRows;
    remoteBridgeState.lastReplicationSignature = signature;
    remoteBridgeState.replicationCursors = cursors;
    remoteBridgeState.lastReplicationError = "";
    remoteBridgeState.lastSyncDirection = "pull-incremental";
    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "done", recvBytes: totalRecvBytes, importedRows });
    return { ok: true, importedRows, hasMore, batches, signature, nextCursors: cursors };
  } catch (err) {
    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "error", recvBytes: totalRecvBytes || 0 });
    remoteBridgeState.lastReplicationError = String(err?.message || err);
    remoteBridgeState.lastSyncDirection = "pull-incremental-failed";
    return { ok: false, error: remoteBridgeState.lastReplicationError };
  } finally {
    remoteBridgeState.replicationRunning = false;
  }
}

async function runRemoteCatchUpReplication(baseUrl, maxBatches = 200, maxPasses = 8) {
  const safeBatches = Math.max(1, Number(maxBatches || 1));
  const safePasses = Math.max(1, Number(maxPasses || 1));
  let pass = 0;
  let totalImported = 0;
  let last = {
    ok: true,
    hasMore: false,
    batches: 0,
    signature: "",
    nextCursors: normalizeReplicationCursors(
      remoteBridgeState.replicationCursors || readReplicationCursorsSetting(),
    ),
  };

  while (pass < safePasses) {
    pass += 1;
    const res = await runRemoteIncrementalReplication(baseUrl, safeBatches);
    if (res?.skipped) return { skipped: true, reason: String(res.reason || "in_progress") };
    if (!res?.ok) return { ok: false, pass, error: String(res?.error || "Incremental replication failed.") };
    totalImported += Number(res.importedRows || 0);
    last = { ...last, ...res };
    if (!res.hasMore) {
      return {
        ok: true,
        mode: "incremental",
        pass,
        importedRows: totalImported,
        hasMore: false,
        batches: Number(res.batches || 0),
        signature: String(res.signature || ""),
        nextCursors: normalizeReplicationCursors(res.nextCursors || {}),
      };
    }
  }

  return {
    ok: true,
    mode: "incremental-partial",
    pass: safePasses,
    importedRows: totalImported,
    hasMore: true,
    batches: Number(last.batches || 0),
    signature: String(last.signature || ""),
    nextCursors: normalizeReplicationCursors(last.nextCursors || {}),
  };
}

async function runRemotePushFull(baseUrl) {
  if (remoteBridgeState.replicationRunning) {
    return { skipped: true, reason: "in_progress" };
  }
  remoteBridgeState.replicationRunning = true;
  remoteBridgeState.lastReplicationAttemptTs = Date.now();
  remoteBridgeState.lastReplicationError = "";

  try {
    const snapshot = buildFullDbSnapshot();
    const tables = snapshot?.tables && typeof snapshot.tables === "object" ? snapshot.tables : {};
    const totalRows = Object.values(tables).reduce(
      (sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0),
      0,
    );
    const delta = {
      meta: {
        generatedTs: Date.now(),
        mode: "push-full",
        signature: String(snapshot?.meta?.signature || ""),
        tableCounts: snapshot?.meta?.tableCounts || {},
        totalRows,
      },
      tables,
    };

    const pushed = await pushDeltaInChunks(baseUrl, delta);
    const importedRows = Number(pushed?.importedRows || 0);
    remoteBridgeState.lastReconcileTs = Date.now();
    remoteBridgeState.lastReconcileRows = importedRows;
    remoteBridgeState.lastSyncDirection = "push-full";
    remoteBridgeState.lastReplicationError = "";

    return {
      ok: true,
      totalRows: Number(pushed?.totalRows || totalRows),
      importedRows,
      skippedRows: Number(pushed?.skippedRows || 0),
      chunkCount: Number(pushed?.chunkCount || 0),
      signature: String(pushed?.signature || ""),
    };
  } catch (err) {
    remoteBridgeState.lastReplicationError = String(err?.message || err);
    remoteBridgeState.lastSyncDirection = "push-full-failed";
    return { ok: false, error: remoteBridgeState.lastReplicationError };
  } finally {
    remoteBridgeState.replicationRunning = false;
  }
}

function isUnsafeRemoteLoop(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(
    String(baseUrl || ""),
  );
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function isRetryableNetworkError(err) {
  const code = String(err?.code || "").trim().toUpperCase();
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const msg = String(err?.message || err || "")
    .trim()
    .toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("reason: read econnreset")
  );
}

function isRetryableHttpStatus(status) {
  const n = Number(status || 0);
  return n === 408 || n === 425 || n === 429 || n === 500 || n === 502 || n === 503 || n === 504;
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = Math.max(1, Number(retryOptions?.attempts || 1));
  const baseDelay = Math.max(0, Number(retryOptions?.baseDelayMs || 0));
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      const shouldRetry = i < attempts && isRetryableNetworkError(err);
      if (!shouldRetry) throw err;
      const jitter = Math.floor(Math.random() * 250);
      const delay = baseDelay * i + jitter;
      await waitMs(delay);
    }
  }
  throw lastErr || new Error("Fetch failed");
}

async function requestIncrementalDeltaWithRetry(baseUrl, cursors, onBytes) {
  const attempts = Math.max(1, Number(REMOTE_INCREMENTAL_FETCH_RETRIES || 1));
  let lastErr = null;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const r = await fetch(`${baseUrl}/api/replication/incremental`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildRemoteProxyHeaders(),
        },
        body: JSON.stringify({ cursors }),
        timeout: REMOTE_INCREMENTAL_REQUEST_TIMEOUT_MS,
      });
      if (!r.ok) {
        const err = new Error(`Incremental replication HTTP ${r.status} ${r.statusText}`);
        err.httpStatus = Number(r.status || 0);
        throw err;
      }
      const txt = await r.text();
      const recvBytes = Buffer.byteLength(txt, "utf8");
      if (onBytes) onBytes(recvBytes);
      let data;
      try { data = JSON.parse(txt); } catch (_) { data = null; }
      if (!data?.ok || !data?.delta) {
        throw new Error(String(data?.error || "Gateway returned invalid incremental payload."));
      }
      return data;
    } catch (err) {
      lastErr = err;
      const retryable =
        isRetryableNetworkError(err) || isRetryableHttpStatus(err?.httpStatus);
      if (!retryable || i >= attempts) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 250);
      const delay = REMOTE_INCREMENTAL_FETCH_RETRY_BASE_MS * i + jitter;
      await waitMs(delay);
    }
  }

  throw lastErr || new Error("Incremental delta request failed.");
}

async function requestPushDeltaWithRetry(baseUrl, deltaPayload) {
  const attempts = Math.max(1, Number(REMOTE_PUSH_FETCH_RETRIES || 1));
  let lastErr = null;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const r = await fetch(`${baseUrl}/api/replication/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildRemoteProxyHeaders(),
        },
        body: JSON.stringify({ delta: deltaPayload }),
        timeout: REMOTE_REPLICATION_TIMEOUT_MS,
      });
      if (!r.ok) {
        let detail = "";
        try {
          const txt = await r.text();
          detail = String(txt || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 260);
        } catch (_) {
          // Ignore body parse errors for HTTP failures.
        }
        const err = new Error(
          detail
            ? `Push HTTP ${r.status} ${r.statusText}: ${detail}`
            : `Push HTTP ${r.status} ${r.statusText}`,
        );
        err.httpStatus = Number(r.status || 0);
        throw err;
      }
      const data = await r.json();
      if (!data?.ok) {
        throw new Error(String(data?.error || "Gateway rejected push delta."));
      }
      return data;
    } catch (err) {
      lastErr = err;
      const status = Number(err?.httpStatus || 0);
      const retryable =
        isRetryableNetworkError(err) ||
        (isRetryableHttpStatus(status) && status !== 413);
      if (!retryable || i >= attempts) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 250);
      const delay = REMOTE_PUSH_FETCH_RETRY_BASE_MS * i + jitter;
      await waitMs(delay);
    }
  }

  throw lastErr || new Error("Push delta request failed.");
}

async function pushDeltaInChunks(baseUrl, deltaPayload) {
  const delta = deltaPayload && typeof deltaPayload === "object" ? deltaPayload : null;
  if (!delta || typeof delta !== "object") {
    throw new Error("Invalid push replication payload.");
  }
  const sourceTables = delta.tables && typeof delta.tables === "object" ? delta.tables : {};
  const totalRows = countReplicationRowsByTables(sourceTables);
  if (totalRows <= 0) {
    return {
      importedRows: 0,
      skippedRows: 0,
      chunkCount: 0,
      totalRows: 0,
      signature: String(delta?.meta?.signature || ""),
    };
  }

  const chunks = buildPushDeltaChunks(delta);
  if (!Array.isArray(chunks) || chunks.length <= 0) {
    throw new Error("Failed to build push delta chunks.");
  }

  const totalBytes = chunks.reduce((s, c) => s + Number(c?.meta?.chunkBytes || 0), 0);
  let sentBytes = 0;
  let importedRows = 0;
  let skippedRows = 0;
  let signature = String(delta?.meta?.signature || "");

  broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "start", totalBytes, sentBytes: 0, chunkCount: chunks.length, totalRows });

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const chunkRows = Number(chunk?.meta?.chunkRows || 0);
    const chunkBytes = Number(chunk?.meta?.chunkBytes || 0);
    try {
      const data = await requestPushDeltaWithRetry(baseUrl, chunk);
      const stats = data?.stats || {};
      importedRows += Number(stats?.importedRows || 0);
      skippedRows += Number(stats?.skippedRows || 0);
      signature = String(stats?.signature || signature || "");
      sentBytes += chunkBytes;
      broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "chunk", totalBytes, sentBytes, chunk: i + 1, chunkCount: chunks.length, totalRows });
    } catch (err) {
      broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "error", totalBytes, sentBytes, chunk: i + 1, chunkCount: chunks.length });
      const status = Number(err?.httpStatus || 0);
      const baseMsg =
        status === 413
          ? "Push HTTP 413 Payload Too Large"
          : String(err?.message || err || "Push chunk failed.");
      const detail = `${baseMsg} (chunk ${i + 1}/${chunks.length}, rows=${chunkRows}).`;
      const e = new Error(detail);
      e.httpStatus = status;
      throw e;
    }
  }

  broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "done", totalBytes, sentBytes, chunkCount: chunks.length, importedRows, totalRows });

  return {
    importedRows,
    skippedRows,
    chunkCount: chunks.length,
    totalRows,
    signature,
  };
}

function buildRemoteProxyHeaders(tokenOverride = "") {
  const token = String(tokenOverride || getRemoteApiToken() || "").trim();
  const headers = {};
  if (token) {
    headers["x-inverter-remote-token"] = token;
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function proxyToRemote(req, res, tokenOverride = "") {
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    return res
      .status(503)
      .json({ ok: false, error: "Remote gateway URL is not configured." });
  }
  if (isUnsafeRemoteLoop(base)) {
    return res
      .status(400)
      .json({ ok: false, error: "Remote gateway URL cannot be localhost in remote mode." });
  }

  const target = `${base}${req.originalUrl}`;
  const method = String(req.method || "GET").toUpperCase();
  let timeoutMs = REMOTE_FETCH_TIMEOUT_MS;
  try {
    const u = new URL(target);
    const p = String(u.pathname || "").toLowerCase();
    if (p.startsWith("/api/export/")) timeoutMs = Math.max(timeoutMs, 180000);
    else if (p.startsWith("/api/report/")) timeoutMs = Math.max(timeoutMs, 45000);
    else if (
      p.startsWith("/api/analytics/") ||
      p.startsWith("/api/energy/5min") ||
      p.startsWith("/api/alarms") ||
      p.startsWith("/api/audit")
    ) {
      timeoutMs = Math.max(timeoutMs, 20000);
    }
  } catch (_) {
    timeoutMs = REMOTE_FETCH_TIMEOUT_MS;
  }
  const headers = {
    ...buildRemoteProxyHeaders(tokenOverride),
  };
  const hasBody = !["GET", "HEAD"].includes(method);
  if (hasBody) headers["Content-Type"] = "application/json";
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
      timeout: timeoutMs,
    });
    const contentType = String(upstream.headers.get("content-type") || "");
    const bodyText = await upstream.text();
    res.status(upstream.status);
    if (/application\/json/i.test(contentType)) {
      try {
        return res.json(JSON.parse(bodyText || "{}"));
      } catch {
        return res.json({ ok: false, error: "Invalid JSON from remote gateway." });
      }
    }
    return res.send(bodyText);
  } catch (err) {
    return res
      .status(502)
      .json({ ok: false, error: `Remote gateway request failed: ${err.message}` });
  }
}

async function runRemoteStartupAutoSync(baseUrl) {
  const reconcile = await reconcileRemoteBeforePull(baseUrl);
  if (!reconcile?.ok) {
    const reason = String(reconcile?.error || "Reconciliation failed.");
    if (reconcile?.localNewer) {
      remoteBridgeState.lastReplicationError =
        `Startup auto sync blocked: local data is newer but push reconciliation failed (${reason}).`;
    } else {
      remoteBridgeState.lastReplicationError = `Startup reconciliation failed: ${reason}`;
      remoteBridgeState.lastSyncDirection = "startup-auto-sync-failed";
    }
    return {
      ok: false,
      stage: "reconcile",
      localNewer: Boolean(reconcile?.localNewer),
      error: remoteBridgeState.lastReplicationError,
      reconcile,
    };
  }

  const inc = await runRemoteCatchUpReplication(
    baseUrl,
    REMOTE_INCREMENTAL_STARTUP_MAX_BATCHES,
    REMOTE_INCREMENTAL_CATCHUP_PASSES,
  );
  if (inc?.skipped) {
    return {
      ok: false,
      stage: "incremental",
      skipped: true,
      error: String(inc?.reason || "Replication already in progress."),
      reconcile,
      incremental: inc,
    };
  }
  if (!inc?.ok) {
    remoteBridgeState.lastReplicationError = String(
      inc?.error || "Startup incremental replication failed.",
    );
    remoteBridgeState.lastSyncDirection = "startup-auto-sync-failed";
    return {
      ok: false,
      stage: "incremental",
      error: remoteBridgeState.lastReplicationError,
      reconcile,
      incremental: inc,
    };
  }

  remoteBridgeState.lastReplicationError = "";
  return { ok: true, stage: "complete", reconcile, incremental: inc };
}

async function pollRemoteLiveOnce() {
  const wasConnected = Boolean(remoteBridgeState.connected);
  remoteBridgeState.lastAttemptTs = Date.now();
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    remoteBridgeState.connected = false;
    remoteBridgeState.lastError = "Remote gateway URL is not configured.";
    return;
  }
  if (isUnsafeRemoteLoop(base)) {
    remoteBridgeState.connected = false;
    remoteBridgeState.lastError =
      "Remote gateway URL cannot be localhost in remote mode.";
    return;
  }
  try {
    const r = await fetch(`${base}/api/live`, {
      method: "GET",
      headers: buildRemoteProxyHeaders(),
      timeout: REMOTE_FETCH_TIMEOUT_MS,
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText}`);
    }
    const data = await r.json();
    remoteBridgeState.liveData =
      data && typeof data === "object" ? data : {};
    remoteBridgeState.totals = computeTotalsFromLiveData(
      remoteBridgeState.liveData,
    );
    remoteBridgeState.connected = true;
    remoteBridgeState.lastSuccessTs = Date.now();
    remoteBridgeState.lastError = "";
    broadcastUpdate({
      type: "live",
      data: remoteBridgeState.liveData,
      totals: remoteBridgeState.totals,
    });
    remoteBridgeState.lastSyncDirection = "pull-live";

    // Piggyback today's energy totals so /api/energy/today matches gateway exactly.
    try {
      const et = await fetch(`${base}/api/energy/today`, {
        method: "GET",
        headers: buildRemoteProxyHeaders(),
        timeout: REMOTE_FETCH_TIMEOUT_MS,
      });
      if (et.ok) {
        const rows = await et.json();
        if (Array.isArray(rows)) {
          const normalizedRows = normalizeTodayEnergyRows(rows);
          remoteBridgeState.todayEnergyRows = normalizedRows;
          updateRemoteTodayEnergyShadow(normalizedRows, Date.now());
          todayEnergyCache.ts = 0; // force next request to re-read with new data
        }
      }
    } catch (_) {
      // Non-fatal; stale todayEnergyRows will be used until next tick.
    }
    if (isRemotePullOnlyMode()) {
      remoteBridgeState.replicationRunning = false;
      remoteBridgeState.lastReplicationError =
        "Disabled in Client pull-only mode.";
    } else if (readRemoteAutoSyncEnabled() && !remoteBridgeState.autoSyncAttempted) {
      remoteBridgeState.autoSyncAttempted = true;
      remoteBridgeState.lastSyncDirection = "startup-auto-sync";
      runRemoteStartupAutoSync(base).catch((err) => {
        remoteBridgeState.lastReplicationError = String(err?.message || err);
        remoteBridgeState.lastSyncDirection = "startup-auto-sync-failed";
      });
    }
  } catch (err) {
    remoteBridgeState.connected = false;
    remoteBridgeState.lastError = String(err.message || err);
    if (wasConnected) {
      remoteBridgeState.lastSyncDirection = "pull-live-failed";
    }
  }
}

function stopRemoteBridge() {
  if (remoteBridgeTimer) {
    clearTimeout(remoteBridgeTimer);
    remoteBridgeTimer = null;
  }
  remoteBridgeState.running = false;
  remoteBridgeState.connected = false;
  remoteBridgeState.replicationRunning = false;
  if (!isRemoteMode()) remoteBridgeState.lastSyncDirection = "idle";
}

function startRemoteBridge() {
  if (remoteBridgeState.running) return;
  remoteBridgeState.running = true;
  remoteBridgeState.autoSyncAttempted = false;
  if (isRemotePullOnlyMode()) {
    remoteBridgeState.replicationCursors = normalizeReplicationCursors({});
  } else {
    remoteBridgeState.replicationCursors = readReplicationCursorsSetting();
  }
  const tick = async () => {
    if (!remoteBridgeState.running) return;
    if (!isRemoteMode()) {
      stopRemoteBridge();
      return;
    }
    await pollRemoteLiveOnce().catch(() => {});
    remoteBridgeTimer = setTimeout(tick, REMOTE_BRIDGE_INTERVAL_MS);
  };
  tick();
}

function applyRuntimeMode() {
  if (isRemoteMode()) {
    if (
      gatewayHandoffMeta.active ||
      gatewayHandoffMeta.day ||
      Object.keys(gatewayHandoffMeta.baselines).length
    ) {
      resetGatewayHandoffMeta(true);
    }
    gatewayTodayCarryState.day = localDateStr();
    gatewayTodayCarryState.byInv = Object.create(null);
    poller.stop();
    poller.markAllOffline();
    // Broadcast the all-offline state immediately so clients don't keep showing
    // stale gateway live data while waiting for the first remote-bridge push.
    broadcastUpdate({ type: "live", data: poller.getLiveData(), totals: { pac: 0, kwh: 0 } });
    startRemoteBridge();
  } else {
    const wasRemoteActive =
      Boolean(remoteBridgeState.running) || Boolean(remoteBridgeState.connected);
    if (wasRemoteActive && Array.isArray(remoteBridgeState.todayEnergyRows)) {
      updateRemoteTodayEnergyShadow(remoteBridgeState.todayEnergyRows, Date.now());
    }
    // ── Handoff lifecycle: capture per-inverter baselines ──────────────────────
    if (wasRemoteActive) {
      const handoffNow = Date.now();
      const handoffDay = localDateStr(handoffNow);
      gatewayHandoffMeta.active = true;
      gatewayHandoffMeta.startedAt = handoffNow;
      gatewayHandoffMeta.day = handoffDay;
      gatewayHandoffMeta.baselines = Object.create(null);
      const capturedRows = normalizeTodayEnergyRows(remoteTodayEnergyShadow.rows);
      for (const row of capturedRows) {
        const inv = Number(row?.inverter || 0);
        if (inv > 0) gatewayHandoffMeta.baselines[inv] = Number(row?.total_kwh || 0);
      }
      const baselineList = capturedRows
        .slice(0, 8)
        .map((r) => `${r.inverter}:${Number(r.total_kwh || 0).toFixed(2)}kWh`)
        .join(", ");
      console.log(
        `[handoff] Remote→Gateway started day=${handoffDay}` +
        ` inverters=${capturedRows.length}` +
        ` baselines=[${baselineList}${capturedRows.length > 8 ? " ..." : ""}]`,
      );
      persistGatewayHandoffMeta();
    }
    stopRemoteBridge();
    remoteBridgeState.liveData = {}; // discard stale remote snapshot
    remoteBridgeState.totals = {};
    remoteBridgeState.todayEnergyRows = []; // discard bridge cache; gateway mode uses DB + shadow supplement
    if (wasRemoteActive) {
      // Clear stale remote values on clients before local poller publishes fresh rows.
      poller.markAllOffline();
      broadcastUpdate({ type: "live", data: poller.getLiveData(), totals: {} });
    }
    poller.start();
  }
}

function getTailscaleStatusSnapshot(deviceHintOverride = "") {
  const hint = sanitizeTailscaleDeviceHint(
    deviceHintOverride ||
      getSetting("tailscaleDeviceHint", getSetting("wireguardInterface", "")),
    "",
  );
  const whereCmd = process.platform === "win32" ? "where" : "which";
  const whereRes = spawnSync(whereCmd, ["tailscale"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
  const installed = Number(whereRes?.status) === 0;
  let running = false;
  let connected = false;
  let backendState = "";
  let loginState = "";
  let tailscaleIps = [];
  let self = {};
  let peerCount = 0;
  let health = [];
  let diagnostics = "";
  if (installed) {
    const statusRes = spawnSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 6000,
    });
    diagnostics = String(
      `${statusRes?.stderr || ""}`.trim(),
    ).slice(0, 800);
    if (Number(statusRes?.status) === 0) {
      try {
        const parsed = JSON.parse(String(statusRes?.stdout || "{}"));
        backendState = String(parsed?.BackendState || "");
        loginState = String(parsed?.CurrentTailnet?.Name || "");
        running = backendState.toLowerCase() === "running";
        const selfNode = parsed?.Self || {};
        const ipCandidates = Array.isArray(selfNode?.TailscaleIPs)
          ? selfNode.TailscaleIPs
          : Array.isArray(selfNode?.Addresses)
            ? selfNode.Addresses
            : [];
        tailscaleIps = ipCandidates
          .map((x) => String(x || "").trim())
          .filter(Boolean);
        const peersObj = parsed?.Peer && typeof parsed.Peer === "object" ? parsed.Peer : {};
        peerCount = Object.keys(peersObj).length;
        health = Array.isArray(parsed?.Health)
          ? parsed.Health.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        self = {
          hostName: String(selfNode?.HostName || ""),
          dnsName: String(selfNode?.DNSName || ""),
          online: Boolean(selfNode?.Online),
          exitNode: Boolean(selfNode?.ExitNode),
          os: String(selfNode?.OS || ""),
          user: String(selfNode?.User || ""),
        };
        connected = running && Boolean(self.online) && tailscaleIps.length > 0;
      } catch (err) {
        diagnostics = String(
          `${diagnostics}\nJSON parse failed: ${err.message}`,
        )
          .trim()
          .slice(0, 800);
      }
    }
  } else {
    diagnostics = String(whereRes?.stderr || whereRes?.stdout || "").slice(0, 800);
  }

  return {
    installed,
    running,
    connected,
    backendState,
    tailnet: loginState,
    tailscaleIps,
    peerCount,
    self,
    health,
    deviceHint: hint,
    diagnostics,
  };
}

function remoteApiTokenGate(req, res, next) {
  const token = getRemoteApiToken();
  if (!token) return next();
  if (isLoopbackRequest(req)) return next();
  const provided = resolveRequestToken(req);
  if (provided === token) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized API request." });
}

function localDateStr(ts = Date.now()) {
  return localDateStrCore(ts);
}

function normalizeTodayEnergyRows(rowsRaw) {
  return normalizeTodayEnergyRowsCore(rowsRaw);
}

function mergeTodayEnergyRowsMax(...lists) {
  return mergeTodayEnergyRowsMaxCore(...lists);
}

function updateRemoteTodayEnergyShadow(rowsRaw, syncedAt = Date.now()) {
  const day = localDateStr(syncedAt);
  const incoming = normalizeTodayEnergyRows(rowsRaw);
  let changed = false;
  if (remoteTodayEnergyShadow.day !== day) {
    remoteTodayEnergyShadow.day = day;
    remoteTodayEnergyShadow.rows = incoming;
    remoteTodayEnergyShadow.syncedAt = Number(syncedAt || Date.now());
    changed = true;
    persistRemoteTodayEnergyShadow();
    return remoteTodayEnergyShadow.rows;
  }
  const merged = mergeTodayEnergyRowsMax(
    remoteTodayEnergyShadow.rows,
    incoming,
  );
  changed = !todayEnergyRowsEqual(remoteTodayEnergyShadow.rows, merged);
  remoteTodayEnergyShadow.rows = merged;
  remoteTodayEnergyShadow.syncedAt = Math.max(
    Number(remoteTodayEnergyShadow.syncedAt || 0),
    Number(syncedAt || Date.now()),
  );
  if (changed) persistRemoteTodayEnergyShadow();
  return remoteTodayEnergyShadow.rows;
}

function getRemoteTodayEnergyShadowRows(day = localDateStr()) {
  if (gatewayHandoffMeta.day && gatewayHandoffMeta.day !== day) {
    resetGatewayHandoffMeta(true);
  }
  if (remoteTodayEnergyShadow.day !== day) {
    if (remoteTodayEnergyShadow.day) {
      remoteTodayEnergyShadow.day = "";
      remoteTodayEnergyShadow.rows = [];
      remoteTodayEnergyShadow.syncedAt = 0;
      persistRemoteTodayEnergyShadow();
    }
    return [];
  }
  // Stale-shadow protection: if the handoff is not currently active and the
  // shadow is older than MAX_SHADOW_AGE_MS, discard it to prevent stale data
  // from a previous Remote session from permanently inflating today's totals.
  const shadowAgeMs = Date.now() - Number(remoteTodayEnergyShadow.syncedAt || 0);
  const handoffActive = gatewayHandoffMeta.active && gatewayHandoffMeta.day === day;
  if (!handoffActive && shadowAgeMs > MAX_SHADOW_AGE_MS) {
    console.warn(
      `[shadow] stale shadow discarded: age=${Math.round(shadowAgeMs / 60000)}min` +
      ` day=${day} syncedAt=${new Date(remoteTodayEnergyShadow.syncedAt).toISOString()}`,
    );
    remoteTodayEnergyShadow.day = "";
    remoteTodayEnergyShadow.rows = [];
    remoteTodayEnergyShadow.syncedAt = 0;
    persistRemoteTodayEnergyShadow();
    return [];
  }
  return normalizeTodayEnergyRows(remoteTodayEnergyShadow.rows);
}

// Checks whether per-inverter baselines have been surpassed by local data and
// closes the handoff either on completion or timeout.
function _checkHandoffCompletion(pollerMap, day) {
  const progress = evaluateHandoffProgress({
    handoffMeta: gatewayHandoffMeta,
    carryByInv: gatewayTodayCarryState.byInv,
    pollerMap,
    day,
    now: Date.now(),
    maxActiveMs: MAX_HANDOFF_ACTIVE_MS,
  });
  if (progress.action === "none") return;

  const elapsedS = Math.round(Number(progress.elapsedMs || 0) / 1000);
  const resolved = Number(progress.resolvedCount || 0);
  if (progress.action === "timeout") {
    console.warn(
      `[handoff] Remote->Gateway handoff timeout: day=${day}` +
      ` elapsed=${elapsedS}s resolved=${resolved} inverters` +
      ` carryRemaining=${Object.keys(gatewayTodayCarryState.byInv).length}`,
    );
    resetGatewayHandoffMeta(true);
    return;
  }

  console.log(
    `[handoff] Remote->Gateway handoff complete: day=${day}` +
    ` elapsed=${elapsedS}s` +
    ` resolved=${resolved} inverters`,
  );
  resetGatewayHandoffMeta(true);
}

function getTodayEnergySupplementRows(day = localDateStr()) {
  if (isRemoteMode()) {
    return mergeTodayEnergyRowsMax(
      remoteBridgeState.todayEnergyRows || [],
      getRemoteTodayEnergyShadowRows(day),
    );
  }

  const pollerRows = normalizeTodayEnergyRows(
    poller.getTodayPacKwh ? poller.getTodayPacKwh() : [],
  );
  const shadowRows = getRemoteTodayEnergyShadowRows(day);
  if (!shadowRows.length) {
    gatewayTodayCarryState.day = day;
    gatewayTodayCarryState.byInv = Object.create(null);
    return pollerRows;
  }

  if (gatewayTodayCarryState.day !== day) {
    gatewayTodayCarryState.day = day;
    gatewayTodayCarryState.byInv = Object.create(null);
  }

  const { rows: out, pollerMap } = applyGatewayCarryRows({
    pollerRows,
    shadowRows,
    carryByInv: gatewayTodayCarryState.byInv,
    onEvent(evt) {
      if (!evt || typeof evt !== "object") return;
      if (evt.type === "carry_applied") {
        console.log(
          `[handoff] carry applied: inv=${evt.inverter}` +
          ` shadow=${Number(evt.shadowKwh || 0).toFixed(2)}kWh` +
          ` poller=${Number(evt.pollerKwh || 0).toFixed(2)}kWh` +
          ` gap=${Number(evt.gapKwh || 0).toFixed(2)}kWh`,
        );
        return;
      }
      if (evt.type === "carry_removed") {
        console.log(
          `[handoff] inv=${evt.inverter} caught up:` +
          ` poller=${Number(evt.pollerKwh || 0).toFixed(2)}kWh` +
          ` >= shadow=${Number(evt.shadowKwh || 0).toFixed(2)}kWh - carry removed`,
        );
      }
    },
  });

  // Check whether all inverters have caught up and the handoff is complete.
  _checkHandoffCompletion(pollerMap, day);

  return out;
}

function todayEnergyRowsEqual(aRaw, bRaw) {
  return todayEnergyRowsEqualCore(aRaw, bRaw);
}

function normalizeGatewayHandoffBaselines(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const inv = Math.floor(Number(key));
    const kwh = Number(value);
    if (inv <= 0 || !Number.isFinite(kwh) || kwh < 0) continue;
    out[inv] = Number(kwh.toFixed(6));
  }
  return out;
}

function resetGatewayHandoffMeta(persist = false) {
  gatewayHandoffMeta.active = false;
  gatewayHandoffMeta.startedAt = 0;
  gatewayHandoffMeta.day = "";
  gatewayHandoffMeta.baselines = Object.create(null);
  if (persist) persistGatewayHandoffMeta();
}

function persistGatewayHandoffMeta() {
  try {
    if (!gatewayHandoffMeta.active) {
      setSetting(REMOTE_GATEWAY_HANDOFF_SETTING_KEY, "");
      return;
    }
    const day = String(gatewayHandoffMeta.day || "").trim();
    const startedAt = Number(gatewayHandoffMeta.startedAt || 0);
    const baselines = normalizeGatewayHandoffBaselines(gatewayHandoffMeta.baselines);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(startedAt) || startedAt <= 0) {
      setSetting(REMOTE_GATEWAY_HANDOFF_SETTING_KEY, "");
      return;
    }
    setSetting(
      REMOTE_GATEWAY_HANDOFF_SETTING_KEY,
      JSON.stringify({
        active: true,
        day,
        startedAt,
        baselines,
      }),
    );
  } catch (err) {
    console.warn("[handoff] persist meta failed:", err?.message || err);
  }
}

function loadGatewayHandoffMetaFromSettings() {
  try {
    const raw = String(getSetting(REMOTE_GATEWAY_HANDOFF_SETTING_KEY, "") || "").trim();
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const active = Boolean(parsed?.active);
    const day = String(parsed?.day || "").trim();
    const startedAt = Number(parsed?.startedAt || 0);
    const baselines = normalizeGatewayHandoffBaselines(parsed?.baselines);
    if (!active) {
      setSetting(REMOTE_GATEWAY_HANDOFF_SETTING_KEY, "");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day !== localDateStr()) {
      setSetting(REMOTE_GATEWAY_HANDOFF_SETTING_KEY, "");
      return;
    }
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      setSetting(REMOTE_GATEWAY_HANDOFF_SETTING_KEY, "");
      return;
    }
    gatewayHandoffMeta.active = true;
    gatewayHandoffMeta.day = day;
    gatewayHandoffMeta.startedAt = Math.min(startedAt, Date.now());
    gatewayHandoffMeta.baselines = baselines;
  } catch (err) {
    console.warn("[handoff] load meta failed:", err?.message || err);
  }
}

function persistRemoteTodayEnergyShadow() {
  try {
    if (!remoteTodayEnergyShadow.day || !Array.isArray(remoteTodayEnergyShadow.rows) || !remoteTodayEnergyShadow.rows.length) {
      setSetting(REMOTE_TODAY_SHADOW_SETTING_KEY, "");
      return;
    }
    setSetting(
      REMOTE_TODAY_SHADOW_SETTING_KEY,
      JSON.stringify({
        day: String(remoteTodayEnergyShadow.day || ""),
        rows: normalizeTodayEnergyRows(remoteTodayEnergyShadow.rows),
        syncedAt: Number(remoteTodayEnergyShadow.syncedAt || 0),
      }),
    );
  } catch (err) {
    console.warn("[shadow] persist remote today-energy failed:", err?.message || err);
  }
}

function loadRemoteTodayEnergyShadowFromSettings() {
  try {
    const raw = String(getSetting(REMOTE_TODAY_SHADOW_SETTING_KEY, "") || "").trim();
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const day = String(parsed?.day || "").trim();
    const syncedAt = Number(parsed?.syncedAt || 0);
    const rows = normalizeTodayEnergyRows(parsed?.rows);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !rows.length) return;
    if (day !== localDateStr()) {
      // Keep shadow strictly scoped to the current day.
      setSetting(REMOTE_TODAY_SHADOW_SETTING_KEY, "");
      return;
    }
    remoteTodayEnergyShadow.day = day;
    remoteTodayEnergyShadow.rows = rows;
    remoteTodayEnergyShadow.syncedAt = Number.isFinite(syncedAt) ? syncedAt : 0;
  } catch (err) {
    console.warn("[shadow] load remote today-energy failed:", err?.message || err);
  }
}

function readForecastContext() {
  try {
    if (!fs.existsSync(FORECAST_CTX_PATH)) return {};
    return JSON.parse(fs.readFileSync(FORECAST_CTX_PATH, "utf8"));
  } catch {
    return {};
  }
}

function parseHmsOnDay(day, timeText) {
  const dayStr = String(day || "").trim();
  const mDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayStr);
  const mTime = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(timeText || "").trim(),
  );
  if (!mDay || !mTime) return null;
  const y = Number(mDay[1]);
  const mo = Number(mDay[2]) - 1;
  const d = Number(mDay[3]);
  const hh = Number(mTime[1]);
  const mm = Number(mTime[2]);
  const ss = Number(mTime[3] || 0);
  return new Date(y, mo, d, hh, mm, ss, 0).getTime();
}

function getDayAheadRowsForDate(day) {
  const dayKey = String(day || "").trim();
  if (!dayKey) return [];
  try {
    if (readForecastProvider() !== "solcast") {
      syncDayAheadFromContextIfNewer(false);
    }
  } catch (err) {
    console.warn("[forecast] context sync failed:", err.message);
  }
  let dbRows = [];
  try {
    dbRows = stmts.getForecastDayAheadDate.all(dayKey);
  } catch (err) {
    console.error("[forecast] DB read failed:", err.message);
    dbRows = [];
  }
  if (!dbRows.length) {
    const ctx = readForecastContext();
    const root = ctx && typeof ctx === "object" ? ctx.PacEnergy_DayAhead : null;
    const series =
      root && typeof root === "object" ? root[dayKey] : null;
    if (Array.isArray(series) && series.length) {
      try {
        upsertDayAheadSeriesToDb(dayKey, series, "legacy-fallback");
        dbRows = stmts.getForecastDayAheadDate.all(dayKey);
      } catch (err) {
        console.warn("[forecast] legacy fallback upsert failed:", err.message);
      }
    }
  }
  if (!dbRows.length) return [];
  return dbRows.map((r) => {
    const kwhInc = Number(r?.kwh_inc || 0);
    return {
      ts: Number(r?.ts || 0),
      kwh_inc: Number(kwhInc.toFixed(6)),
      mwh_inc: Number((kwhInc / 1000).toFixed(6)),
    };
  });
}

function normalizeDayAheadSeries(day, series) {
  if (!Array.isArray(series)) return [];
  const out = [];
  const dayStart = new Date(`${day}T00:00:00.000`).getTime();
  for (const rec of series || []) {
    const ts = parseHmsOnDay(day, rec?.time);
    if (!ts) continue;
    const slot = Math.max(0, Math.min(287, Math.floor((ts - dayStart) / 300000)));
    const kwhInc = Number(rec?.kWh_inc ?? rec?.kwh_inc ?? 0);
    const kwhLo = Number(rec?.kWh_lo ?? rec?.kwh_lo ?? 0);
    const kwhHi = Number(rec?.kWh_hi ?? rec?.kwh_hi ?? 0);
    out.push({
      ts: Number(ts),
      slot: Number(slot),
      time_hms: String(rec?.time || "").trim() || "00:00:00",
      kwh_inc: Number.isFinite(kwhInc) ? Number(kwhInc.toFixed(6)) : 0,
      kwh_lo: Number.isFinite(kwhLo) ? Number(kwhLo.toFixed(6)) : 0,
      kwh_hi: Number.isFinite(kwhHi) ? Number(kwhHi.toFixed(6)) : 0,
    });
  }
  out.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0) || Number(a.slot || 0) - Number(b.slot || 0));
  return out;
}

function upsertDayAheadSeriesToDb(day, series, source = "context-sync") {
  const rows = normalizeDayAheadSeries(day, series);
  bulkUpsertForecastDayAhead(day, rows, source);
  return rows.length;
}

function syncDayAheadFromContextIfNewer(force = false) {
  if (!fs.existsSync(FORECAST_CTX_PATH)) return { changed: false, days: 0, rows: 0 };
  const stat = fs.statSync(FORECAST_CTX_PATH);
  const mtimeMs = Number(stat?.mtimeMs || 0);
  const known = Number(getSetting(FORECAST_CTX_MTIME_KEY, 0) || 0);
  if (!force && known && mtimeMs <= known) return { changed: false, days: 0, rows: 0 };

  const ctx = readForecastContext();
  const root = ctx && typeof ctx === "object" ? ctx.PacEnergy_DayAhead : null;
  if (!root || typeof root !== "object") {
    setSetting(FORECAST_CTX_MTIME_KEY, String(mtimeMs));
    return { changed: true, days: 0, rows: 0 };
  }

  let days = 0;
  let rows = 0;
  const keys = Object.keys(root);
  for (const day of keys) {
    const series = root[day];
    if (!Array.isArray(series)) continue;
    rows += upsertDayAheadSeriesToDb(day, series, "context-sync");
    days++;
  }

  setSetting(FORECAST_CTX_MTIME_KEY, String(mtimeMs));
  return { changed: true, days, rows };
}

function normalizeForecastDbWindow() {
  try {
    // Forecast window is 05:00..18:00 (5-minute window, typically ending at 17:55 slot).
    // Keep slots 60..216 inclusive so 18:00 boundary rows (if any) are preserved.
    const info = db
      .prepare(
        "DELETE FROM forecast_dayahead WHERE slot < 60 OR slot > 216",
      )
      .run();
    return Number(info?.changes || 0);
  } catch (e) {
    console.warn("[Forecast] DB window normalization failed:", e.message);
    return 0;
  }
}

function parseDateMs(value, fallback, endOfDay = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (/^\d+$/.test(String(value))) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const t = new Date(
      `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`,
    ).getTime();
    return Number.isNaN(t) ? fallback : t;
  }
  const t = new Date(String(value)).getTime();
  return Number.isNaN(t) ? fallback : t;
}

function clampInt(val, min, max, def) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const INV_GRID_LAYOUT_SET = new Set(["auto", "2", "3", "4", "5", "6", "7"]);
function sanitizeInvGridLayout(value, def = "4") {
  const v = String(value ?? def)
    .trim()
    .toLowerCase();
  return INV_GRID_LAYOUT_SET.has(v) ? v : def;
}

const EXPORT_UI_DATE_KEYS = [
  "reportDate",
  "expAlarmStart",
  "expAlarmEnd",
  "expEnergyStart",
  "expEnergyEnd",
  "expForecastDate",
  "expInvDataStart",
  "expInvDataEnd",
  "expAuditStart",
  "expAuditEnd",
  "expReportStart",
  "expReportEnd",
];
const EXPORT_UI_NUMERIC_KEYS = {
  genDayCount: { min: 1, max: 31, def: 1 },
};
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeExportUiState(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const key of EXPORT_UI_DATE_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = String(raw).trim();
    if (ISO_DATE_RE.test(v)) out[key] = v;
  }
  Object.entries(EXPORT_UI_NUMERIC_KEYS).forEach(([key, cfg]) => {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const v = Math.min(cfg.max, Math.max(cfg.min, Math.trunc(n)));
    out[key] = v;
  });
  return out;
}

const DEFAULT_POLL_CFG = {
  modbusTimeout:  1.0,
  reconnectDelay: 0.5,
  readSpacing:    0.005,
};

function sanitizePollConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const clamp = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
  };
  return {
    modbusTimeout:  clamp(src.modbusTimeout,  0.2,   10,  DEFAULT_POLL_CFG.modbusTimeout),
    reconnectDelay: clamp(src.reconnectDelay, 0.1,   10,  DEFAULT_POLL_CFG.reconnectDelay),
    readSpacing:    clamp(src.readSpacing,    0.001,  1,  DEFAULT_POLL_CFG.readSpacing),
  };
}

function readJsonSetting(key, fallback = {}) {
  const raw = String(getSetting(key, "") || "").trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildDefaultExportUiState() {
  const end = localDateStr();
  const start = localDateStr(Date.now() - 7 * 86400000);
  return {
    reportDate: end,
    expAlarmStart: start,
    expAlarmEnd: end,
    expEnergyStart: start,
    expEnergyEnd: end,
    expForecastDate: end,
    genDayCount: 1,
    expInvDataStart: start,
    expInvDataEnd: end,
    expAuditStart: start,
    expAuditEnd: end,
    expReportStart: start,
    expReportEnd: end,
  };
}

function ensurePersistedSettings() {
  const defaults = {
    operationMode: "gateway",
    remoteAutoSync: "0",
    remoteGatewayUrl: "",
    remoteApiToken: "",
    tailscaleDeviceHint: "",
    wireguardInterface: "",
    apiUrl: `${INVERTER_ENGINE_BASE_URL}/data`,
    writeUrl: `${INVERTER_ENGINE_BASE_URL}/write`,
    csvSavePath: "C:\\Logs\\InverterDashboard",
    inverterCount: "27",
    nodeCount: "4",
    invGridLayout: "4",
    plantName: "Solar Plant",
    operatorName: "OPERATOR",
    retainDays: "90",
    forecastProvider: "ml_local",
    solcastBaseUrl: "https://api.solcast.com.au",
    solcastApiKey: "",
    solcastResourceId: "",
    solcastTimezone: "Asia/Manila",
    remoteReplicationCursors: JSON.stringify(normalizeReplicationCursors({})),
    inverterPollConfig: JSON.stringify(DEFAULT_POLL_CFG),
  };

  Object.entries(defaults).forEach(([key, def]) => {
    const raw = String(getSetting(key, "") || "").trim();
    if (!raw) setSetting(key, def);
  });

  const rawExport = String(getSetting("exportUiState", "") || "").trim();
  if (!rawExport) {
    setSetting(
      "exportUiState",
      JSON.stringify(buildDefaultExportUiState()),
    );
    return;
  }

  try {
    const parsed = JSON.parse(rawExport);
    const safe = sanitizeExportUiState(parsed);
    if (JSON.stringify(safe) !== JSON.stringify(parsed)) {
      setSetting("exportUiState", JSON.stringify(safe));
    }
  } catch {
    setSetting(
      "exportUiState",
      JSON.stringify(buildDefaultExportUiState()),
    );
  }
}

function parseIsoDateStrict(value, fieldName) {
  const s = String(value || "").trim();
  if (!ISO_DATE_RE.test(s)) {
    throw new Error(`Invalid ${fieldName}. Use YYYY-MM-DD.`);
  }
  const t = new Date(`${s}T00:00:00.000`).getTime();
  if (Number.isNaN(t)) throw new Error(`Invalid ${fieldName}.`);
  return s;
}

function addDaysIso(day, addDays) {
  const base = new Date(`${day}T00:00:00.000`);
  base.setDate(base.getDate() + Number(addDays || 0));
  return localDateStr(base.getTime());
}

function daysInclusive(startDay, endDay) {
  const out = [];
  let cur = String(startDay || "").trim();
  const end = String(endDay || "").trim();
  while (cur <= end) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

const _tzDtfCache = new Map();
function getTzFormatter(timeZone) {
  const tz = String(timeZone || WEATHER_TZ).trim() || WEATHER_TZ;
  if (_tzDtfCache.has(tz)) return _tzDtfCache.get(tz);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  _tzDtfCache.set(tz, fmt);
  return fmt;
}

function getTzParts(ts, timeZone) {
  const fmt = getTzFormatter(timeZone);
  const parts = fmt.formatToParts(new Date(Number(ts || 0)));
  const get = (type) =>
    Number(parts.find((p) => p.type === type)?.value || 0);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
    minuteOfDay: hour * 60 + minute,
  };
}

function localDateStrInTz(ts = Date.now(), timeZone = WEATHER_TZ) {
  return getTzParts(ts, timeZone).date;
}

function getTimeZoneOffsetMinutes(ts, timeZone) {
  const p = getTzParts(ts, timeZone);
  const asUtc = Date.UTC(
    Number(p.year || 0),
    Math.max(0, Number(p.month || 1) - 1),
    Number(p.day || 1),
    Number(p.hour || 0),
    Number(p.minute || 0),
    Number(p.second || 0),
    0,
  );
  return (asUtc - Number(ts || 0)) / 60000;
}

function zonedDateTimeToUtcMs(dayStr, hh, mm, ss, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || "").trim());
  if (!m) return NaN;
  const y = Number(m[1]);
  const mon = Number(m[2]) - 1;
  const d = Number(m[3]);
  const baseUtc = Date.UTC(y, mon, d, Number(hh || 0), Number(mm || 0), Number(ss || 0), 0);
  let offset = getTimeZoneOffsetMinutes(baseUtc, timeZone);
  let utc = baseUtc - offset * 60000;
  const offset2 = getTimeZoneOffsetMinutes(utc, timeZone);
  if (offset2 !== offset) {
    utc = baseUtc - offset2 * 60000;
  }
  return utc;
}

function parseIsoDurationToMinutes(input, def = 30) {
  const s = String(input || "").trim().toUpperCase();
  if (!s) return def;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    s,
  );
  if (!m) return def;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  const total = days * 1440 + hours * 60 + mins + secs / 60;
  if (!Number.isFinite(total) || total <= 0) return def;
  return total;
}

function readForecastProvider() {
  return String(getSetting("forecastProvider", "ml_local") || "ml_local")
    .trim()
    .toLowerCase() === "solcast"
    ? "solcast"
    : "ml_local";
}

function getSolcastConfig() {
  return {
    baseUrl: String(
      getSetting("solcastBaseUrl", "https://api.solcast.com.au") || "",
    ).trim() || "https://api.solcast.com.au",
    apiKey: String(getSetting("solcastApiKey", "") || "").trim(),
    resourceId: String(getSetting("solcastResourceId", "") || "").trim(),
    timeZone:
      String(getSetting("solcastTimezone", WEATHER_TZ) || "").trim() ||
      WEATHER_TZ,
  };
}

function buildSolcastConfigFromInput(input = null) {
  const base = getSolcastConfig();
  const src = input && typeof input === "object" ? input : {};
  return {
    baseUrl: String(
      src.solcastBaseUrl ?? src.baseUrl ?? base.baseUrl ?? "",
    ).trim() || "https://api.solcast.com.au",
    apiKey: String(src.solcastApiKey ?? src.apiKey ?? base.apiKey ?? "").trim(),
    resourceId: String(
      src.solcastResourceId ?? src.resourceId ?? base.resourceId ?? "",
    ).trim(),
    timeZone: String(
      src.solcastTimezone ?? src.timeZone ?? base.timeZone ?? "",
    ).trim() || WEATHER_TZ,
  };
}

function hasUsableSolcastConfig(cfg = null) {
  const c = cfg || getSolcastConfig();
  return !!(c.apiKey && c.resourceId && isHttpUrl(c.baseUrl));
}

function computePlantMaxKwFromConfig() {
  try {
    const enabledNodes = getConfiguredNodeSet(loadIpConfigFromDb()).size;
    const eqInv = Math.max(0, Number(enabledNodes || 0)) / 4;
    return Math.max(0, eqInv * SOLCAST_UNIT_KW_MAX);
  } catch {
    // Safe fallback when config is unavailable.
    return 27 * SOLCAST_UNIT_KW_MAX;
  }
}

function computeSlotCapKwh() {
  return (computePlantMaxKwFromConfig() * SOLCAST_SLOT_MIN) / 60;
}

async function fetchSolcastForecastRecords(cfg) {
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  const rid = encodeURIComponent(String(cfg.resourceId || "").trim());
  const candidates = [
    `${base}/rooftop_sites/${rid}/forecasts?format=json`,
    `${base}/sites/${rid}/forecasts?format=json`,
  ];
  const errors = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        timeout: SOLCAST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: "application/json",
        },
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        const detail = String(txt || "").trim().slice(0, 260);
        throw new Error(`HTTP ${r.status}${detail ? ` - ${detail}` : ""}`);
      }
      const payload = await r.json();
      const records = Array.isArray(payload?.forecasts)
        ? payload.forecasts
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.response?.forecasts)
            ? payload.response.forecasts
            : [];
      if (!records.length) {
        throw new Error("No forecast records in payload.");
      }
      return { endpoint: url, records };
    } catch (err) {
      errors.push(`${url} => ${err.message}`);
    }
  }
  throw new Error(
    `Solcast fetch failed. ${errors.length ? errors.join(" | ") : "No usable endpoint response."}`,
  );
}

function buildDayAheadRowsFromSolcast(day, records, cfg) {
  const slotKwh = new Array(288).fill(0);
  const slotLo = new Array(288).fill(0);
  const slotHi = new Array(288).fill(0);
  let matched = 0;
  const slotMs = SOLCAST_SLOT_MIN * 60000;
  const startMin = SOLCAST_SOLAR_START_H * 60;
  const endMin = SOLCAST_SOLAR_END_H * 60;

  for (const rec of records || []) {
    const periodEndRaw =
      rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
    const endTs = Date.parse(String(periodEndRaw || ""));
    if (!Number.isFinite(endTs) || endTs <= 0) continue;
    const durMin = parseIsoDurationToMinutes(
      rec?.period ?? rec?.period_duration ?? rec?.duration,
      30,
    );
    if (!Number.isFinite(durMin) || durMin <= 0) continue;
    const startTs = endTs - durMin * 60000;
    const kw = Number(
      rec?.pv_estimate ??
        rec?.pvEstimate ??
        rec?.pv_estimate_mean ??
        rec?.pv_estimate_median ??
        0,
    );
    const kwLo = Number(
      rec?.pv_estimate10 ??
        rec?.pv_estimate_10 ??
        rec?.pv_estimate_low ??
        kw,
    );
    const kwHi = Number(
      rec?.pv_estimate90 ??
        rec?.pv_estimate_90 ??
        rec?.pv_estimate_high ??
        kw,
    );
    if (!Number.isFinite(kw) && !Number.isFinite(kwLo) && !Number.isFinite(kwHi)) {
      continue;
    }

    let segStart = startTs;
    while (segStart < endTs) {
      const boundary = Math.min(endTs, (Math.floor(segStart / slotMs) + 1) * slotMs);
      const segEnd = boundary > segStart ? boundary : Math.min(endTs, segStart + slotMs);
      const midTs = segStart + Math.floor((segEnd - segStart) / 2);
      const p = getTzParts(midTs, cfg.timeZone);
      if (p.date === day && p.minuteOfDay >= startMin && p.minuteOfDay < endMin) {
        const slot = Math.floor(p.minuteOfDay / SOLCAST_SLOT_MIN);
        const overlapH = (segEnd - segStart) / 3600000;
        slotKwh[slot] += Math.max(0, Number.isFinite(kw) ? kw : 0) * overlapH;
        slotLo[slot] += Math.max(0, Number.isFinite(kwLo) ? kwLo : 0) * overlapH;
        slotHi[slot] += Math.max(0, Number.isFinite(kwHi) ? kwHi : 0) * overlapH;
        matched += 1;
      }
      segStart = segEnd;
    }
  }

  if (!matched) {
    throw new Error(`No Solcast samples matched ${day} within ${SOLCAST_SOLAR_START_H}:00-${SOLCAST_SOLAR_END_H}:00 (${cfg.timeZone}).`);
  }

  const capKwh = computeSlotCapKwh();
  const rows = [];
  for (let slot = startMin / SOLCAST_SLOT_MIN; slot < endMin / SOLCAST_SLOT_MIN; slot++) {
    const hh = Math.floor((slot * SOLCAST_SLOT_MIN) / 60);
    const mm = (slot * SOLCAST_SLOT_MIN) % 60;
    const ts = zonedDateTimeToUtcMs(day, hh, mm, 0, cfg.timeZone);
    const kwh = Math.max(0, Math.min(Number(slotKwh[slot] || 0), capKwh));
    let lo = Math.max(0, Math.min(Number(slotLo[slot] || 0), capKwh));
    let hi = Math.max(0, Math.min(Number(slotHi[slot] || 0), capKwh));
    if (hi < lo) hi = lo;
    if (kwh < lo) lo = kwh;
    if (kwh > hi) hi = kwh;
    rows.push({
      ts: Number.isFinite(ts) ? Number(ts) : 0,
      slot,
      time_hms: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`,
      kwh_inc: Number(kwh.toFixed(6)),
      kwh_lo: Number(lo.toFixed(6)),
      kwh_hi: Number(hi.toFixed(6)),
    });
  }
  return rows;
}

function classifyDailySky(row) {
  const cloud = Number(row?.cloud_pct || 0);
  const rain = Number(row?.precip_mm || 0);
  const rainProb = Number(row?.precip_prob_pct || 0);
  if (rain >= 4 || rainProb >= 75) return "Rainy";
  if (cloud >= 80) return "Overcast";
  if (cloud >= 55) return "Cloudy";
  if (cloud >= 25) return "Partly Cloudy";
  return "Clear";
}

async function fetchDailyWeatherRange(startDay, endDay, useArchive = false) {
  if (!startDay || !endDay || endDay < startDay) return [];
  const key = `${useArchive ? "A" : "F"}|${startDay}|${endDay}`;
  const now = Date.now();
  const cached = weatherWeeklyCache.get(key);
  if (cached && now - Number(cached.ts || 0) <= WEATHER_CACHE_TTL_MS) {
    return Array.isArray(cached.rows) ? cached.rows : [];
  }

  const base = useArchive
    ? "https://archive-api.open-meteo.com/v1/archive"
    : "https://api.open-meteo.com/v1/forecast";
  const url =
    `${base}?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
    `&daily=${encodeURIComponent(WEATHER_DAILY_FIELDS)}` +
    `&start_date=${encodeURIComponent(startDay)}` +
    `&end_date=${encodeURIComponent(endDay)}` +
    `&timezone=${encodeURIComponent(WEATHER_TZ)}`;

  const r = await fetch(url, { timeout: 20000 });
  if (!r.ok) {
    throw new Error(`Weather API HTTP ${r.status}`);
  }
  const payload = await r.json();
  const d = payload?.daily || {};
  const time = Array.isArray(d.time) ? d.time : [];
  const tempMax = Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max : [];
  const tempMin = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min : [];
  const precip = Array.isArray(d.precipitation_sum) ? d.precipitation_sum : [];
  const precipProb = Array.isArray(d.precipitation_probability_max)
    ? d.precipitation_probability_max
    : [];
  const cloud = Array.isArray(d.cloudcover_mean)
    ? d.cloudcover_mean
    : Array.isArray(d.cloud_cover_mean)
      ? d.cloud_cover_mean
      : [];
  const wind = Array.isArray(d.windspeed_10m_max)
    ? d.windspeed_10m_max
    : Array.isArray(d.wind_speed_10m_max)
      ? d.wind_speed_10m_max
      : [];
  const rad = Array.isArray(d.shortwave_radiation_sum) ? d.shortwave_radiation_sum : [];

  const n = time.length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const solarMJ = Number(rad[i] || 0);
    const row = {
      date: String(time[i] || ""),
      temp_max_c: Number.isFinite(Number(tempMax[i])) ? Number(Number(tempMax[i]).toFixed(1)) : null,
      temp_min_c: Number.isFinite(Number(tempMin[i])) ? Number(Number(tempMin[i]).toFixed(1)) : null,
      precip_mm: Number.isFinite(Number(precip[i])) ? Number(Number(precip[i]).toFixed(1)) : 0,
      precip_prob_pct: Number.isFinite(Number(precipProb[i])) ? Number(Math.round(Number(precipProb[i]))) : 0,
      cloud_pct: Number.isFinite(Number(cloud[i])) ? Number(Math.round(Number(cloud[i]))) : 0,
      wind_kph: Number.isFinite(Number(wind[i])) ? Number(Number(wind[i]).toFixed(1)) : 0,
      solar_kwh_m2: Number.isFinite(solarMJ) ? Number((solarMJ / 3.6).toFixed(2)) : 0,
    };
    row.sky = classifyDailySky(row);
    rows.push(row);
  }

  weatherWeeklyCache.set(key, { ts: now, rows });
  return rows;
}

async function getWeeklyWeather(startDay) {
  const start = parseIsoDateStrict(startDay, "date");
  const end = addDaysIso(start, 6);
  const today = localDateStr();

  const chunks = [];
  if (end < today) {
    chunks.push(await fetchDailyWeatherRange(start, end, true));
  } else if (start > today) {
    chunks.push(await fetchDailyWeatherRange(start, end, false));
  } else {
    if (start < today) {
      chunks.push(await fetchDailyWeatherRange(start, addDaysIso(today, -1), true));
    }
    chunks.push(await fetchDailyWeatherRange(today, end, false));
  }

  const flat = chunks.flat();
  const byDate = new Map();
  flat.forEach((r) => {
    const d = String(r?.date || "").trim();
    if (!d) return;
    byDate.set(d, r);
  });

  return daysInclusive(start, end).map((d) => {
    const row = byDate.get(d);
    if (row) return row;
    return {
      date: d,
      temp_max_c: null,
      temp_min_c: null,
      precip_mm: 0,
      precip_prob_pct: 0,
      cloud_pct: 0,
      wind_kph: 0,
      solar_kwh_m2: 0,
      sky: "N/A",
    };
  });
}

function resolveForecastLaunch() {
  const explicit = String(process.env.IM_FORECAST_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) {
    const ext = path.extname(explicit).toLowerCase();
    if (ext === ".py") {
      return {
        cmd: process.env.PYTHON || "python",
        args: [explicit],
        cwd: path.dirname(explicit),
      };
    }
    return { cmd: explicit, args: [], cwd: path.dirname(explicit) };
  }

  const exeBaseDirs = [
    ROOT_DIR,
    process.cwd(),
    path.dirname(process.execPath || ""),
    process.resourcesPath || "",
    path.join(process.resourcesPath || "", "backend"),
  ].filter(Boolean);
  const exeCandidates = FORECAST_EXE_NAMES.flatMap((name) =>
    exeBaseDirs.map((dir) => path.join(dir, name)),
  );
  for (const p of exeCandidates) {
    if (fs.existsSync(p)) return { cmd: p, args: [], cwd: path.dirname(p) };
  }

  const scriptBaseDirs = [ROOT_DIR, process.cwd()];
  const scriptCandidates = FORECAST_SCRIPT_NAMES.flatMap((name) =>
    scriptBaseDirs.map((dir) => path.join(dir, name)),
  );
  for (const p of scriptCandidates) {
    if (fs.existsSync(p)) {
      return {
        cmd: process.env.PYTHON || "python",
        args: [p],
        cwd: path.dirname(p),
      };
    }
  }
  return null;
}

function runForecastGenerator(extraArgs, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const launch = resolveForecastLaunch();
    if (!launch) {
      reject(new Error("Forecast service executable/script not found."));
      return;
    }

    const args = [...launch.args, ...(Array.isArray(extraArgs) ? extraArgs : [])];
    const startedAt = Date.now();
    const proc = spawn(launch.cmd, args, {
      cwd: launch.cwd,
      env: { ...process.env, NODE_ENV: "production" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const appendBounded = (buf, chunk) => {
      const next = `${buf}${String(chunk || "")}`;
      return next.length > 200000 ? next.slice(-200000) : next;
    };

    proc.stdout?.on("data", (d) => {
      stdout = appendBounded(stdout, d.toString());
    });
    proc.stderr?.on("data", (d) => {
      stderr = appendBounded(stderr, d.toString());
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch (killErr) {
        console.warn("[forecast] proc kill failed:", killErr.message);
      }
      reject(new Error(`Forecast generation timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: Number(code ?? -1),
        signal: signal || "",
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function generateDayAheadWithMl(dayCount) {
  const args = ["--generate-days", String(dayCount)];
  const result = await runForecastGenerator(args);
  if (Number(result?.code || -1) !== 0) {
    const details = String(result?.stderr || result?.stdout || "")
      .trim()
      .slice(-2000);
    throw new Error(`ML forecast generator failed (code ${Number(result?.code || -1)}). ${details || ""}`.trim());
  }
  try {
    syncDayAheadFromContextIfNewer(true);
  } catch (err) {
    console.warn("[forecast] forced context sync failed:", err.message);
  }
  const normalizedRows = normalizeForecastDbWindow();
  return {
    providerUsed: "ml_local",
    durationMs: Number(result.durationMs || 0),
    normalizedRows,
  };
}

async function generateDayAheadWithSolcast(dates) {
  const cfg = getSolcastConfig();
  if (!hasUsableSolcastConfig(cfg)) {
    throw new Error("Solcast is selected but API key/resource/base URL are incomplete.");
  }
  const { endpoint, records } = await fetchSolcastForecastRecords(cfg);
  let writtenRows = 0;
  for (const day of dates) {
    const rows = buildDayAheadRowsFromSolcast(day, records, cfg);
    bulkUpsertForecastDayAhead(day, rows, "solcast");
    writtenRows += Number(rows.length || 0);
  }
  const normalizedRows = normalizeForecastDbWindow();
  return {
    providerUsed: "solcast",
    endpoint,
    writtenRows,
    normalizedRows,
  };
}

function formatDurationMs(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

function enrichAlarmRow(row, nowTs = Date.now()) {
  const occurredTs = Number(row?.ts || 0) || 0;
  const clearedTs = row?.cleared_ts ? Number(row.cleared_ts) : null;
  const status = clearedTs ? "CLEARED" : "ACTIVE";
  const endTs = clearedTs || nowTs;
  const durationMs = occurredTs ? Math.max(0, endTs - occurredTs) : 0;

  return {
    ...row,
    decoded: decodeAlarm(row?.alarm_value),
    alarm_hex: formatAlarmHex(row?.alarm_value),
    occurred_ts: occurredTs || null,
    end_ts: endTs,
    status,
    duration_ms: durationMs,
    duration_sec: Math.floor(durationMs / 1000),
    duration_min: Number((durationMs / 60000).toFixed(2)),
    duration_text: formatDurationMs(durationMs),
  };
}

const PLANT_WIDE_AUTH_PREFIX = "sacups";
function getPlantWideAuthKeys() {
  const now = new Date();
  const prev = new Date(now.getTime() - 60000);
  const nowMM = String(now.getMinutes()).padStart(2, "0");
  const prevMM = String(prev.getMinutes()).padStart(2, "0");
  return new Set([
    `${PLANT_WIDE_AUTH_PREFIX}${nowMM}`,
    `${PLANT_WIDE_AUTH_PREFIX}${prevMM}`,
  ]);
}
function isValidPlantWideAuthKey(v) {
  const key = String(v || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  return getPlantWideAuthKeys().has(key);
}

function startOfLocalDayMs(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildPacEnergyBuckets({ inverter, startTs, endTs, bucketMin = 5 }) {
  const s = Number(startTs) || Date.now() - 86400000;
  const e = Number(endTs) || Date.now();
  const bucketMs = Math.max(1, Number(bucketMin) || 5) * 60000;
  // Match the poller's MAX_PAC_DT_S cap so DB-recomputed totals agree with
  // the energy_5min table written by the live integrator.
  const dtCapSec = 30;

  let rows = [];
  if (!inverter || inverter === "all") {
    rows = db
      .prepare(
        "SELECT inverter, unit, ts, pac, online FROM readings WHERE ts BETWEEN ? AND ? ORDER BY inverter, unit, ts ASC",
      )
      .all(s, e);
  } else {
    rows = db
      .prepare(
        "SELECT inverter, unit, ts, pac, online FROM readings WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY inverter, unit, ts ASC",
      )
      .all(Number(inverter), s, e);
  }

  const nodeState = new Map(); // `${inv}_${unit}` -> { ts, pac }
  const bucketMap = new Map(); // `${inv}|${bucketTs}` -> kwh_inc

  for (const r of rows) {
    const inv = Number(r?.inverter || 0);
    const unit = Number(r?.unit || 0);
    const ts = Number(r?.ts || 0);
    if (!inv || !unit || !ts) continue;

    const key = `${inv}_${unit}`;
    const online = Number(r?.online || 0) === 1;
    const pacW = Math.max(0, Number(online ? r?.pac : 0) || 0);
    const prev = nodeState.get(key);

    if (prev && ts > prev.ts) {
      const dtSecRaw = (ts - prev.ts) / 1000;
      if (dtSecRaw > 0) {
        const dtSec = Math.min(dtCapSec, dtSecRaw);
        const avgPac = (Number(prev.pac || 0) + pacW) / 2;
        const kwhInc = (avgPac * dtSec) / 3600000; // W*s -> kWh
        if (kwhInc > 0) {
          const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
          const bKey = `${inv}|${bucketTs}`;
          bucketMap.set(bKey, Number(bucketMap.get(bKey) || 0) + kwhInc);
        }
      }
    }

    nodeState.set(key, { ts, pac: pacW });
  }

  const out = [];
  for (const [key, kwhInc] of bucketMap.entries()) {
    const [invStr, tsStr] = key.split("|");
    out.push({
      inverter: Number(invStr),
      ts: Number(tsStr),
      kwh_inc: Number(kwhInc.toFixed(6)),
    });
  }
  out.sort((a, b) => (a.inverter - b.inverter) || (a.ts - b.ts));
  return out;
}

function buildTodayPacTotalsFromDb() {
  // Use energy_5min (completed 5-min buckets) as primary source, supplemented by
  // the poller's live PAC accumulator for the current partial bucket.
  // This is reliable, fast, and resets automatically at midnight via timestamp boundary.
  const day = localDateStr();
  const startTs = new Date(`${day}T00:00:00.000`).getTime();
  const endTs = Date.now();

  const e5Rows = db.prepare(
    "SELECT inverter, SUM(kwh_inc) AS total_kwh FROM energy_5min WHERE ts >= ? AND ts <= ? GROUP BY inverter ORDER BY inverter ASC",
  ).all(startTs, endTs);

  const resultMap = new Map();
  for (const r of e5Rows) {
    const inv = Number(r?.inverter || 0);
    if (inv > 0) resultMap.set(inv, Number(r?.total_kwh || 0));
  }

  // Supplement with current partial-bucket totals plus the latest remote shadow
  // captured while this client was in Remote mode. This keeps totals stable when
  // switching Remote -> Gateway before the source gateway flushes its current
  // 5-minute bucket to energy_5min.
  const supplementRows = getTodayEnergySupplementRows(day);
  for (const { inverter, total_kwh } of supplementRows) {
    const inv = Number(inverter || 0);
    if (inv <= 0 || !(total_kwh > 0)) continue;
    resultMap.set(inv, Math.max(resultMap.get(inv) || 0, total_kwh));
  }

  return Array.from(resultMap.entries())
    .map(([inverter, total_kwh]) => ({
      inverter,
      total_kwh: Number(Number(total_kwh).toFixed(6)),
    }))
    .sort((a, b) => a.inverter - b.inverter);
}

const TODAY_ENERGY_CACHE_MS = 1000; // 1-second cache for near-realtime header updates
const todayEnergyCache = {
  day: "",
  ts: 0,
  rows: [],
};
const PAST_DAILY_REPORT_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute cache for immutable past days
const pastDailyReportCache = new Map(); // day -> { ts, rows }

function getTodayPacTotalsFromDbCached() {
  const now = Date.now();
  const day = localDateStr(now);
  if (
    todayEnergyCache.day === day &&
    now - Number(todayEnergyCache.ts || 0) < TODAY_ENERGY_CACHE_MS
  ) {
    return todayEnergyCache.rows;
  }
  const rows = buildTodayPacTotalsFromDb();
  todayEnergyCache.day = day;
  todayEnergyCache.ts = now;
  todayEnergyCache.rows = Array.isArray(rows) ? rows : [];
  return todayEnergyCache.rows;
}

function cloneDailyReportRows(rowsRaw) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  return rows.map((r) => ({ ...r }));
}

function getPastDailyReportRowsCached(day, now = Date.now()) {
  const key = String(day || "").trim();
  if (!key) return null;
  const entry = pastDailyReportCache.get(key);
  if (!entry) return null;
  if (Number(now || Date.now()) - Number(entry.ts || 0) > PAST_DAILY_REPORT_CACHE_TTL_MS) {
    pastDailyReportCache.delete(key);
    return null;
  }
  return cloneDailyReportRows(entry.rows);
}

function setPastDailyReportRowsCache(day, rowsRaw, now = Date.now()) {
  const key = String(day || "").trim();
  if (!key) return;
  pastDailyReportCache.set(key, {
    ts: Number(now || Date.now()),
    rows: cloneDailyReportRows(rowsRaw),
  });
}

function getDailyReportRowsForDay(dayInput, options = {}) {
  const day = parseIsoDateStrict(dayInput || localDateStr(), "date");
  const today = localDateStr();
  const refresh = options.refresh === true;
  const persist = options.persist !== false;
  const includeTodayPartial = options.includeTodayPartial !== false;

  if (day > today) {
    return cloneDailyReportRows(stmts.getDailyReport.all(day));
  }

  if (day < today) {
    if (!refresh) {
      const cached = getPastDailyReportRowsCached(day);
      if (cached) return cached;

      const dbRows = stmts.getDailyReport.all(day);
      if (dbRows.length > 0) {
        setPastDailyReportRowsCache(day, dbRows);
        return cloneDailyReportRows(dbRows);
      }
    }

    const rebuilt = buildDailyReportRowsForDate(day, {
      persist,
      includeTodayPartial: false,
    });
    setPastDailyReportRowsCache(day, rebuilt);
    return cloneDailyReportRows(rebuilt);
  }

  return buildDailyReportRowsForDate(day, {
    persist,
    includeTodayPartial,
  });
}

const getAlarmCountByInverterStmt = db.prepare(
  "SELECT COUNT(*) AS cnt FROM alarms WHERE inverter=? AND ts BETWEEN ? AND ?",
);
const getAuditCountByInverterStmt = db.prepare(
  "SELECT COUNT(*) AS cnt FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ?",
);

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function computeSpanSeconds(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length >= 2) {
    const firstTs = Number(list[0]?.ts || 0);
    const lastTs = Number(list[list.length - 1]?.ts || 0);
    return Math.max(0, (lastTs - firstTs) / 1000);
  }
  return list.length === 1 ? 1 : 0;
}

// Correct availability computation: consecutive-interval summation.
// Processes ALL rows for a node (online=1 and online=0) sorted by ts.
// For each consecutive pair, the interval is credited only when the starting
// row is online=1.  Each interval is capped at AVAIL_MAX_GAP_S so that long
// silent gaps (outages / comms loss that produced no readings) are not
// mistakenly counted as uptime — the old lastTs-firstTs span formula would
// credit the entire gap regardless of what happened inside it.
function computeNodeOnlineSeconds(rows, maxGapS = AVAIL_MAX_GAP_S) {
  const sorted = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return Number(sorted[0]?.online || 0) === 1 ? 1 : 0;
  let totalS = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (Number(sorted[i]?.online || 0) !== 1) continue;
    const dt = (Number(sorted[i + 1].ts) - Number(sorted[i].ts)) / 1000;
    totalS += Math.min(Math.max(0, dt), maxGapS);
  }
  // Credit 1 s for the last row when it is still online (avoids losing the
  // tail of a day where the final reading happened to be the last one).
  if (Number(sorted[sorted.length - 1]?.online || 0) === 1) totalS += 1;
  return totalS;
}

function buildNodeOnlineIntervalsMs(rows, maxGapS = AVAIL_MAX_GAP_S) {
  const sorted = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
  if (sorted.length === 0) return [];

  const intervals = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (Number(cur?.online || 0) !== 1) continue;
    const start = Number(cur?.ts || 0);
    const endRaw = Number(next?.ts || 0);
    if (!(start > 0) || !(endRaw > start)) continue;
    const maxEnd = start + Math.max(0, Number(maxGapS || 0)) * 1000;
    const end = Math.min(endRaw, maxEnd);
    if (end > start) intervals.push([start, end]);
  }

  // Keep parity with computeNodeOnlineSeconds(): tail credit for a final online row.
  const last = sorted[sorted.length - 1];
  if (Number(last?.online || 0) === 1) {
    const start = Number(last?.ts || 0);
    if (start > 0) intervals.push([start, start + 1000]);
  }
  return intervals;
}

function computeInverterOnlineSeconds(rowsByUnit, maxGapS = AVAIL_MAX_GAP_S) {
  const byUnit = rowsByUnit instanceof Map ? rowsByUnit : new Map();
  const intervals = [];
  for (const unitRows of byUnit.values()) {
    intervals.push(...buildNodeOnlineIntervalsMs(unitRows, maxGapS));
  }
  if (!intervals.length) return 0;

  intervals.sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
  let totalMs = 0;
  let curStart = intervals[0][0];
  let curEnd = intervals[0][1];

  for (let i = 1; i < intervals.length; i += 1) {
    const [start, end] = intervals[i];
    if (start <= curEnd) {
      if (end > curEnd) curEnd = end;
      continue;
    }
    totalMs += Math.max(0, curEnd - curStart);
    curStart = start;
    curEnd = end;
  }
  totalMs += Math.max(0, curEnd - curStart);
  return totalMs / 1000;
}

function getReportSolarWindowSeconds(day, includeTodayPartial = true) {
  const d = parseIsoDateStrict(day || localDateStr(), "date");
  const today = localDateStr();
  if (d > today) return 0;
  const hh = (n) => String(Math.trunc(Number(n) || 0)).padStart(2, "0");
  const startTs = new Date(`${d}T${hh(REPORT_SOLAR_START_H)}:00:00.000`).getTime();
  let endTs = new Date(`${d}T${hh(REPORT_SOLAR_END_H)}:00:00.000`).getTime();
  if (includeTodayPartial && d === today) {
    endTs = Math.min(endTs, Date.now());
  }
  return Math.max(0, (endTs - startTs) / 1000);
}

function buildDailyReportRowsForDate(dateText, options = {}) {
  const persist = options.persist !== false;
  const includeTodayPartial = options.includeTodayPartial !== false;
  const day = parseIsoDateStrict(
    dateText || localDateStr(),
    "date",
  );

  const startTs = new Date(`${day}T00:00:00.000`).getTime();
  const dayEndTs = new Date(`${day}T23:59:59.999`).getTime();
  const endTs =
    includeTodayPartial && day === localDateStr()
      ? Math.min(dayEndTs, Date.now())
      : dayEndTs;

  const invCount = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);

  // Use energy_5min as the single source of truth for kWh, matching the TODAY MWh
  // header. buildPacEnergyBuckets re-integrates the subsampled readings table and
  // systematically undercounts vs. the continuous live integrator that writes energy_5min.
  const pacKwhByInv = new Map();
  const e5Rows = db.prepare(
    "SELECT inverter, SUM(kwh_inc) AS total_kwh FROM energy_5min WHERE ts >= ? AND ts <= ? GROUP BY inverter",
  ).all(startTs, endTs);
  for (const r of e5Rows) {
    const inv = Number(r?.inverter || 0);
    if (inv > 0) pacKwhByInv.set(inv, Number(r?.total_kwh || 0));
  }

  // For today's partial day, fold in the live supplement source used by
  // /api/energy/today (poller in gateway mode, remote shadow on mode transition).
  if (day === localDateStr() && includeTodayPartial) {
    const supplementalRows = getTodayEnergySupplementRows(day);
    for (const { inverter, total_kwh } of supplementalRows) {
      const inv = Number(inverter || 0);
      if (inv <= 0 || !(total_kwh > 0)) continue;
      pacKwhByInv.set(inv, Math.max(pacKwhByInv.get(inv) || 0, total_kwh));
    }
  }
  const expectedSolarWindowS = getReportSolarWindowSeconds(
    day,
    includeTodayPartial,
  );

  // ── Batch queries: replace per-inverter N+1 pattern (was 27×3 = 81 queries) ──
  // All readings for the day in a single scan, grouped in-process by inverter.
  const allReadingsBatch = db.prepare(
    "SELECT inverter, unit, ts, pac, kwh, online FROM readings WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, unit ASC, ts ASC",
  ).all(startTs, endTs);
  const readingsByInv = new Map();
  for (const r of allReadingsBatch) {
    const inv = Number(r.inverter);
    if (!readingsByInv.has(inv)) readingsByInv.set(inv, []);
    readingsByInv.get(inv).push(r);
  }
  // Alarm and audit counts per inverter in 2 queries instead of 54.
  const alarmCountBatch = db.prepare(
    "SELECT inverter, COUNT(*) AS cnt FROM alarms WHERE ts BETWEEN ? AND ? GROUP BY inverter",
  ).all(startTs, endTs);
  const alarmCountByInv = new Map(
    alarmCountBatch.map((r) => [Number(r.inverter), Number(r.cnt || 0)]),
  );
  const auditCountBatch = db.prepare(
    "SELECT inverter, COUNT(*) AS cnt FROM audit_log WHERE ts BETWEEN ? AND ? GROUP BY inverter",
  ).all(startTs, endTs);
  const auditCountByInv = new Map(
    auditCountBatch.map((r) => [Number(r.inverter), Number(r.cnt || 0)]),
  );

  const out = [];
  for (let inv = 1; inv <= invCount; inv++) {
    const rows = readingsByInv.get(inv) || [];
    const alarmCount = alarmCountByInv.get(inv) || 0;
    const controlCount = auditCountByInv.get(inv) || 0;
    const pacKwh = Number(pacKwhByInv.get(inv) || 0);
    const hasLiveData = rows.length > 0 || pacKwh > 0 || alarmCount > 0 || controlCount > 0;
    if (!hasLiveData) continue;

    const onlineRows = rows.filter(
      (r) => Number(r?.online || 0) === 1 && Number(r?.pac || 0) > 0,
    );
    // Group ALL rows by unit (online and offline) so computeNodeOnlineSeconds
    // can see every state transition.  Using only online=1 rows (the old
    // onlineRowsByUnit approach) caused computeSpanSeconds to credit the full
    // first→last span even when the node was offline for hours in between.
    const rowsByUnit = new Map();
    for (const r of rows) {
      const unit = Number(r?.unit || 0);
      if (unit < 1) continue;
      if (!rowsByUnit.has(unit)) rowsByUnit.set(unit, []);
      rowsByUnit.get(unit).push(r);
    }
    const pacValues = rows
      .map((r) => Number(r?.pac || 0))
      .filter((v) => Number.isFinite(v) && v >= 0);

    const pacPeak = pacValues.length ? Math.max(...pacValues) : 0;
    const pacAvg = onlineRows.length
      ? onlineRows.reduce((s, r) => s + Number(r?.pac || 0), 0) /
        onlineRows.length
      : 0;
    // Inverter uptime is the union of online intervals across all observed units.
    // If any unit is online, inverter uptime advances.
    const uptimeS = computeInverterOnlineSeconds(rowsByUnit);
    const perUnitUptime = [];
    for (const [unit, unitRows] of rowsByUnit.entries()) {
      perUnitUptime.push({
        unit,
        uptimeS: computeNodeOnlineSeconds(unitRows),
      });
    }
    perUnitUptime.sort(
      (a, b) =>
        Number(b.uptimeS || 0) - Number(a.uptimeS || 0) ||
        Number(a.unit || 0) - Number(b.unit || 0),
    );
    const nodeUptimeS = perUnitUptime
      .slice(0, REPORT_EXPECTED_NODES_PER_INVERTER)
      .reduce((s, r) => s + Math.max(0, Number(r?.uptimeS || 0)), 0);

    let kwhTotal = Math.max(0, pacKwh);
    if (kwhTotal <= 0 && rows.length >= 2) {
      // Per-unit register difference (rows are mixed-unit, sorted by ts).
      const unitFirst = new Map();
      const unitLast = new Map();
      for (const r of rows) {
        const unit = Number(r?.unit || 0);
        const kwh = Number(r?.kwh || 0);
        if (!unit || !Number.isFinite(kwh)) continue;
        if (!unitFirst.has(unit)) unitFirst.set(unit, kwh);
        unitLast.set(unit, kwh);
      }
      let regTotal = 0;
      for (const [unit, firstKwh] of unitFirst.entries()) {
        const lastKwh = unitLast.get(unit) || firstKwh;
        const diff = lastKwh - firstKwh;
        if (Number.isFinite(diff) && diff > 0) regTotal += diff;
      }
      if (regTotal > 0) kwhTotal = regTotal;
    }
    const expectedNodeUptimeS =
      expectedSolarWindowS * REPORT_EXPECTED_NODES_PER_INVERTER;
    const availabilityPct =
      expectedNodeUptimeS > 0 ? (nodeUptimeS / expectedNodeUptimeS) * 100 : 0;
    const uptimeH = uptimeS / 3600;
    const perfDenomKwh = REPORT_UNIT_KW_MAX * uptimeH;
    const performancePct =
      perfDenomKwh > 0 ? (kwhTotal / perfDenomKwh) * 100 : 0;

    const row = {
      date: day,
      inverter: inv,
      kwh_total: Number(kwhTotal.toFixed(6)),
      pac_peak: Number(Math.max(0, pacPeak).toFixed(3)),
      pac_avg: Number(Math.max(0, pacAvg).toFixed(3)),
      uptime_s: Math.max(0, Math.round(uptimeS)),
      alarm_count: Math.max(0, Math.trunc(alarmCount)),
      control_count: Math.max(0, Math.trunc(controlCount)),
      availability_pct: Number(clampPct(availabilityPct).toFixed(3)),
      performance_pct: Number(clampPct(performancePct).toFixed(3)),
      node_uptime_s: Math.max(0, Math.round(nodeUptimeS)),
      expected_node_uptime_s: Math.max(0, Math.round(expectedNodeUptimeS)),
      expected_nodes: REPORT_EXPECTED_NODES_PER_INVERTER,
    };

    if (persist) {
      stmts.upsertDailyReport.run(
        row.date,
        row.inverter,
        row.kwh_total,
        row.pac_peak,
        row.pac_avg,
        row.uptime_s,
        row.alarm_count,
        row.control_count,
      );
    }

    out.push(row);
  }

  out.sort((a, b) => a.inverter - b.inverter);
  if (day < localDateStr()) {
    setPastDailyReportRowsCache(day, out);
  }
  return out;
}

function calcAvailabilityPctFromRow(row) {
  const explicit = Number(row?.availability_pct);
  if (Number.isFinite(explicit)) return clampPct(explicit);

  // Fallback for legacy DB rows that do not yet carry computed availability.
  let day = localDateStr();
  try {
    day = parseIsoDateStrict(String(row?.date || localDateStr()), "date");
  } catch (_) {
    day = localDateStr();
  }
  const windowS = getReportSolarWindowSeconds(day, true);
  if (windowS <= 0) return 0;
  const uptimeS = Math.max(0, Number(row?.uptime_s || 0));
  return clampPct((uptimeS / windowS) * 100);
}

function summarizeDailyReportRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return {
      inverter_count: 0,
      total_kwh: 0,
      total_mwh: 0,
      peak_kw: 0,
      alarm_count: 0,
      availability_avg_pct: 0,
      performance_pct: 0,
    };
  }

  const seen = new Set();
  let totalKwh = 0;
  let peakKw = 0;
  let alarmCount = 0;
  let availSum = 0;
  let denomKwh = 0;

  for (const row of list) {
    const inv = Number(row?.inverter || 0);
    if (inv) seen.add(inv);

    const kwh = Number(row?.kwh_total || 0);
    const rowPeakKw = Number(row?.pac_peak || 0) / 1000;
    const uph = Number(row?.uptime_s || 0) / 3600;
    const rowDenom = Math.max(0, REPORT_UNIT_KW_MAX * uph);

    totalKwh += Math.max(0, kwh);
    if (rowPeakKw > peakKw) peakKw = rowPeakKw;
    alarmCount += Math.max(0, Math.trunc(Number(row?.alarm_count || 0)));

    const avail = calcAvailabilityPctFromRow(row);
    availSum += avail;
    denomKwh += rowDenom;
  }

  const availabilityAvgPct = list.length ? availSum / list.length : 0;
  const perfPct = denomKwh > 0 ? (totalKwh / denomKwh) * 100 : 0;

  return {
    inverter_count: seen.size,
    total_kwh: Number(totalKwh.toFixed(6)),
    total_mwh: Number((totalKwh / 1000).toFixed(6)),
    peak_kw: Number(peakKw.toFixed(3)),
    alarm_count: alarmCount,
    availability_avg_pct: Number(
      clampPct(availabilityAvgPct).toFixed(3),
    ),
    performance_pct: Number(clampPct(perfPct).toFixed(3)),
  };
}

function buildDailyWeeklyReportSummary(targetDateText, options = {}) {
  const day = parseIsoDateStrict(targetDateText || localDateStr(), "date");
  const refreshDay = options.refreshDay === true;
  const selectedDate = new Date(`${day}T00:00:00.000`);
  const dow = selectedDate.getDay(); // 0=Sunday ... 6=Saturday
  const weekStartDate = new Date(selectedDate.getTime());
  weekStartDate.setDate(weekStartDate.getDate() - dow);
  const weekStart = localDateStr(weekStartDate.getTime());
  const weekEnd = addDaysIso(weekStart, 6);
  const dates = daysInclusive(weekStart, weekEnd);
  const today = localDateStr();

  const byDateRows = new Map();
  const isToday = day === today;
  const dailyRows = getDailyReportRowsForDay(day, {
    persist: true,
    includeTodayPartial: isToday,
    refresh: refreshDay,
  });
  byDateRows.set(day, dailyRows);

  for (const d of dates) {
    if (d === day) continue;
    const rows = getDailyReportRowsForDay(d, {
      persist: true,
      includeTodayPartial: d === today,
      refresh: false,
    });
    byDateRows.set(d, rows);
  }

  const weeklyRows = dates.flatMap((d) => byDateRows.get(d) || []);
  return {
    date: day,
    week_start: weekStart,
    week_end: weekEnd,
    daily: summarizeDailyReportRows(dailyRows),
    weekly: summarizeDailyReportRows(weeklyRows),
  };
}

function getLatestReportDate() {
  try {
    const rowDaily = db
      .prepare("SELECT date FROM daily_report ORDER BY date DESC LIMIT 1")
      .get();
    const dailyDate = String(rowDaily?.date || "").trim();
    if (dailyDate) return dailyDate;
  } catch (_) {
    // Fallback handled below.
  }
  try {
    const rowReadings = db
      .prepare(
        "SELECT strftime('%Y-%m-%d', MAX(ts)/1000, 'unixepoch', 'localtime') AS d FROM readings",
      )
      .get();
    return String(rowReadings?.d || "").trim();
  } catch (_) {
    return "";
  }
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
    out.inverters[i] = ip;
    out.poll_interval[i] = Number.isFinite(poll) && poll >= 0.01 ? poll : 0.05;
    out.units[i] = units.length ? [...new Set(units)] : [];
  }
  return out;
}

function legacyIpConfigPaths() {
  const preferred = [];
  if (PORTABLE_ROOT) {
    preferred.push(path.join(PORTABLE_ROOT, "config", "ipconfig.json"));
  }
  preferred.push(path.join(DATA_DIR, "ipconfig.json"));

  const legacy = [
    path.join(process.cwd(), "ipconfig.json"),
    path.join(__dirname, "../ipconfig.json"),
  ];

  return [...new Set([...preferred, ...legacy])];
}

function readLegacyIpConfigIfAny() {
  for (const p of legacyIpConfigPaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      return sanitizeIpConfig(parsed);
    } catch (err) {
      console.warn("[config] file read failed:", err.message);
    }
  }
  return null;
}

function mirrorIpConfigToLegacyFiles(cfg) {
  for (const p of legacyIpConfigPaths()) {
    try {
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
    } catch (err) {
      console.warn("[IPCONFIG] Legacy mirror write failed:", p, err.message);
    }
  }
}

function loadIpConfigFromDb() {
  const raw = getSetting("ipConfigJson", "");
  if (raw) {
    try {
      return sanitizeIpConfig(JSON.parse(raw));
    } catch (err) {
      console.warn("[config] DB ipconfig parse failed:", err.message);
    }
  }

  const legacy = readLegacyIpConfigIfAny();
  if (legacy) {
    setSetting("ipConfigJson", JSON.stringify(legacy));
    return legacy;
  }

  const def = defaultIpConfig();
  setSetting("ipConfigJson", JSON.stringify(def));
  return def;
}

function saveIpConfigToDb(cfg) {
  const safe = sanitizeIpConfig(cfg);
  setSetting("ipConfigJson", JSON.stringify(safe));
  return safe;
}

function getConfiguredNodeSet(cfg = null) {
  const safeCfg = cfg || loadIpConfigFromDb();
  const set = new Set();
  for (let inv = 1; inv <= 27; inv++) {
    const unitsRaw =
      safeCfg?.units?.[inv] ??
      safeCfg?.units?.[String(inv)] ??
      [1, 2, 3, 4];
    const units = Array.isArray(unitsRaw)
      ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
      : [1, 2, 3, 4];
    for (const unit of [...new Set(units)]) {
      set.add(`${inv}_${unit}`);
    }
  }
  return set;
}

function isHttpUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackIp(v) {
  const ip = String(v || "").trim().toLowerCase();
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip === "localhost" ||
    ip === "::ffff:127.0.0.1"
  );
}

function backfillAuditIpsFromConfig() {
  let cfg;
  try {
    cfg = loadIpConfigFromDb();
  } catch (err) {
    console.warn("[config] migration load failed:", err.message);
    return;
  }
  const invMap = (cfg && typeof cfg === "object" && cfg.inverters) || {};
  const invCount = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const update = db.prepare(
    `UPDATE audit_log
     SET ip = ?
     WHERE inverter = ?
       AND (
         ip IS NULL OR TRIM(ip) = '' OR LOWER(TRIM(ip)) IN ('::1','127.0.0.1','localhost','::ffff:127.0.0.1')
       )`,
  );
  const tx = db.transaction(() => {
    const seen = new Set();
    for (let inv = 1; inv <= invCount; inv++) {
      const ip = String(invMap[inv] ?? invMap[String(inv)] ?? "").trim();
      if (!ip) continue;
      seen.add(inv);
      update.run(ip, inv);
    }
    for (const [k, vRaw] of Object.entries(invMap || {})) {
      const inv = Math.trunc(Number(k));
      if (!Number.isFinite(inv) || inv < 1 || seen.has(inv)) continue;
      const ip = String(vRaw ?? "").trim();
      if (!ip) continue;
      update.run(ip, inv);
    }
  });
  tx();
}

// Ensure all user-facing settings exist in DB and survive restarts.
ensurePersistedSettings();

app.ws("/ws", (ws) => {
  registerClient(ws);
  ws.send(
    JSON.stringify({
      type: "init",
      data: getRuntimeLiveData(),
      settings: {
        inverterCount: Number(getSetting("inverterCount", 27)),
        plantName: getSetting("plantName", "Solar Plant"),
      },
    }),
  );
});

app.get("/api/live", (req, res) => {
  // Hot-path optimization for gateway mode: avoid per-request stringify cost.
  if (!isRemoteMode() && typeof poller.getLiveSnapshotJson === "function") {
    const snap = poller.getLiveSnapshotJson();
    if (snap && typeof snap.json === "string") {
      res.set("Content-Type", "application/json; charset=utf-8");
      return res.send(snap.json);
    }
  }
  return res.json(getRuntimeLiveData());
});

app.get("/api/replication/summary", async (req, res) => {
  if (isRemotePullOnlyMode()) {
    return res.status(409).json({
      ok: false,
      error: "Replication is disabled in Client pull-only mode.",
    });
  }
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const summary = buildReplicationSummary();
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/replication/full", async (req, res) => {
  if (isRemotePullOnlyMode()) {
    return res.status(409).json({
      ok: false,
      error: "Replication is disabled in Client pull-only mode.",
    });
  }
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const snapshot = buildFullDbSnapshot();
    res.json({ ok: true, snapshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/replication/incremental", async (req, res) => {
  if (isRemotePullOnlyMode()) {
    return res.status(409).json({
      ok: false,
      error: "Replication is disabled in Client pull-only mode.",
    });
  }
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const cursors = normalizeReplicationCursors(req?.body?.cursors || {});
    const delta = buildIncrementalReplicationDelta(cursors);
    res.json({ ok: true, delta });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/replication/push", async (req, res) => {
  if (isRemotePullOnlyMode()) {
    return res.status(409).json({
      ok: false,
      error: "Replication is disabled in Client pull-only mode.",
    });
  }
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const delta = req?.body?.delta;
    const meta = delta && typeof delta === "object" && delta.meta && typeof delta.meta === "object"
      ? delta.meta
      : {};
    const chunkIndex = Math.max(0, Number(meta?.chunkIndex || 0));
    const chunkCount = Math.max(0, Number(meta?.chunkCount || 0));
    const totalRows = Math.max(0, Number(meta?.totalRows || 0));
    const signature = String(meta?.signature || "");
    const chunkBytesFromMeta = Math.max(0, Number(meta?.chunkBytes || 0));
    const reqBytes = Buffer.byteLength(JSON.stringify(req?.body || {}), "utf8");
    const recvBytes = chunkBytesFromMeta > 0 ? chunkBytesFromMeta : reqBytes;
    const pushKey = `${signature}|${chunkCount}|${totalRows}`;

    if (chunkCount > 0) {
      if (!inboundPushRxProgress.active || chunkIndex <= 1 || inboundPushRxProgress.key !== pushKey) {
        inboundPushRxProgress.active = true;
        inboundPushRxProgress.key = pushKey;
        inboundPushRxProgress.recvBytes = 0;
        broadcastUpdate({
          type: "xfer_progress",
          dir: "rx",
          phase: "start",
          recvBytes: 0,
          chunkCount,
          totalRows,
          label: "Receiving push",
        });
      }
      inboundPushRxProgress.recvBytes += Math.max(0, recvBytes);
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "chunk",
        recvBytes: inboundPushRxProgress.recvBytes,
        batch: chunkIndex > 0 ? chunkIndex : 1,
        chunkCount,
        totalRows,
        label: "Receiving push",
      });
    } else {
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "start",
        recvBytes: 0,
        label: "Receiving push",
      });
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "chunk",
        recvBytes: Math.max(0, recvBytes),
        batch: 1,
        chunkCount: 1,
        totalRows,
        label: "Receiving push",
      });
    }

    const stats = applyReplicationPushDelta(delta);
    ensurePersistedSettings();
    try {
      const cfg = loadIpConfigFromDb();
      mirrorIpConfigToLegacyFiles(cfg);
      backfillAuditIpsFromConfig();
    } catch (_) {
      // Non-fatal maintenance tasks.
    }

    if (chunkCount > 0) {
      if (chunkIndex >= chunkCount) {
        broadcastUpdate({
          type: "xfer_progress",
          dir: "rx",
          phase: "done",
          recvBytes: Math.max(0, Number(inboundPushRxProgress.recvBytes || 0)),
          chunkCount,
          totalRows,
          importedRows: Number(stats?.importedRows || 0),
          label: "Receiving push",
        });
        inboundPushRxProgress.active = false;
        inboundPushRxProgress.key = "";
        inboundPushRxProgress.recvBytes = 0;
      }
    } else {
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "done",
        recvBytes: Math.max(0, recvBytes),
        importedRows: Number(stats?.importedRows || 0),
        label: "Receiving push",
      });
    }

    res.json({ ok: true, stats });
  } catch (err) {
    const recvBytes = Math.max(0, Number(inboundPushRxProgress.recvBytes || 0));
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "error",
      recvBytes,
      label: "Receiving push",
    });
    inboundPushRxProgress.active = false;
    inboundPushRxProgress.key = "";
    inboundPushRxProgress.recvBytes = 0;
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/replication/pull-now", async (req, res) => {
  if (!isRemoteMode()) {
    return res.status(400).json({
      ok: false,
      error: "Manual pull is available only in Remote mode.",
    });
  }
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    return res
      .status(503)
      .json({ ok: false, error: "Remote gateway URL is not configured." });
  }
  if (isUnsafeRemoteLoop(base)) {
    return res.status(400).json({
      ok: false,
      error: "Remote gateway URL cannot be localhost in remote mode.",
    });
  }
  try {
    const inc = await runRemoteCatchUpReplication(
      base,
      REMOTE_INCREMENTAL_MANUAL_MAX_BATCHES,
      REMOTE_INCREMENTAL_CATCHUP_PASSES,
    );
    if (inc?.skipped) {
      return res.status(202).json({
        ok: false,
        error: "Replication already in progress.",
        incremental: inc,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    if (inc?.ok) {
      return res.json({
        ok: true,
        mode: String(inc.mode || "incremental"),
        incremental: inc,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }

    return res.status(502).json({
      ok: false,
      error: `Incremental pull failed: ${String(
        inc?.error || "unknown error",
      )}. Ensure gateway and client are on the same build.`,
      incremental: inc,
      direction: String(remoteBridgeState.lastSyncDirection || "idle"),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/replication/push-now", async (req, res) => {
  if (!isRemoteMode()) {
    return res.status(400).json({
      ok: false,
      error: "Manual push is available only in Remote mode.",
    });
  }
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    return res
      .status(503)
      .json({ ok: false, error: "Remote gateway URL is not configured." });
  }
  if (isUnsafeRemoteLoop(base)) {
    return res.status(400).json({
      ok: false,
      error: "Remote gateway URL cannot be localhost in remote mode.",
    });
  }
  try {
    const pushed = await runRemotePushFull(base);
    if (pushed?.skipped) {
      return res.status(202).json({
        ok: false,
        error: "Replication already in progress.",
        pushed,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    if (!pushed?.ok) {
      return res.status(502).json({
        ok: false,
        error: String(pushed?.error || "Full push failed."),
        pushed,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    const incremental = await runRemoteCatchUpReplication(
      base,
      REMOTE_INCREMENTAL_MANUAL_MAX_BATCHES,
      REMOTE_INCREMENTAL_CATCHUP_PASSES,
    );
    if (incremental?.ok) {
      return res.json({
        ok: true,
        pushed,
        mode: String(incremental.mode || "incremental"),
        incremental,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    return res.status(502).json({
      ok: false,
      error: `Post-push incremental pull failed: ${String(
        incremental?.error || "unknown error",
      )}. Ensure gateway and client are on the same build.`,
      pushed,
      incremental,
      direction: String(remoteBridgeState.lastSyncDirection || "idle"),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/replication/reconcile-now", async (req, res) => {
  if (isRemotePullOnlyMode()) {
    return res.status(409).json({
      ok: false,
      error:
        "Manual replication is disabled in Client pull-only mode. Use the gateway server as source of truth.",
    });
  }
  if (!isRemoteMode()) {
    return res.status(400).json({
      ok: false,
      error: "Manual replication is only available in Remote mode.",
    });
  }
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    return res
      .status(503)
      .json({ ok: false, error: "Remote gateway URL is not configured." });
  }
  if (isUnsafeRemoteLoop(base)) {
    return res.status(400).json({
      ok: false,
      error: "Remote gateway URL cannot be localhost in remote mode.",
    });
  }

  const forcePull = Boolean(req?.body?.forcePull);
  try {
    const reconcile = await reconcileRemoteBeforePull(base);
    if (!reconcile?.ok && reconcile?.localNewer && !forcePull) {
      return res.status(409).json({
        ok: false,
        code: "LOCAL_NEWER_PUSH_FAILED",
        canForcePull: true,
        error:
          "Local data appears newer, but push reconciliation failed. Retry with forcePull to pull from gateway anyway.",
        reconcile,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    if (!reconcile?.ok && !forcePull) {
      return res.status(502).json({
        ok: false,
        error: String(reconcile?.error || "Reconciliation failed."),
        reconcile,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    if (!reconcile?.ok && forcePull) {
      remoteBridgeState.lastSyncDirection = "pull-only";
    }

    const incremental = await runRemoteCatchUpReplication(
      base,
      REMOTE_INCREMENTAL_MANUAL_MAX_BATCHES,
      REMOTE_INCREMENTAL_CATCHUP_PASSES,
    );
    if (incremental?.ok) {
      return res.json({
        ok: true,
        reconcile,
        mode: String(incremental.mode || "incremental"),
        incremental,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }

    return res.status(502).json({
      ok: false,
      error: `Reconcile pull failed: ${String(
        incremental?.error || "unknown error",
      )}. Ensure gateway and client are on the same build.`,
      reconcile,
      incremental,
      direction: String(remoteBridgeState.lastSyncDirection || "idle"),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/write", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const url = getSetting("writeUrl", `${INVERTER_ENGINE_BASE_URL}/write`);
  const { inverter, node, unit, value, scope, operator, authKey } = req.body || {};
  const invNum = Number(inverter);
  const unitNum = Number(unit ?? node);
  const valueNum = Number(value);
  const invMax = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const nodeMax = Math.max(1, Number(getSetting("nodeCount", 4)) || 4);

  if (!Number.isFinite(invNum) || invNum < 1 || invNum > invMax) {
    return res.status(400).json({ ok: false, error: "Invalid inverter" });
  }
  if (!Number.isFinite(unitNum) || unitNum < 1 || unitNum > nodeMax) {
    return res.status(400).json({ ok: false, error: "Invalid unit/node" });
  }
  if (!Number.isFinite(valueNum) || (valueNum !== 0 && valueNum !== 1 && valueNum !== 2)) {
    return res.status(400).json({ ok: false, error: "Invalid value" });
  }
  const scopeNorm = String(scope || "single").toLowerCase();
  const isBulkScope = scopeNorm === "all" || scopeNorm === "selected";
  if (isBulkScope && !isValidPlantWideAuthKey(authKey)) {
    return res.status(403).json({ ok: false, error: "Unauthorized bulk command" });
  }

  const upstreamPayload = { inverter: invNum, unit: unitNum, value: valueNum };
  const operatorName = String(operator || getSetting("operatorName", "OPERATOR")).trim() || "OPERATOR";
  const cfg = loadIpConfigFromDb();
  const targetIp = String(
    cfg?.inverters?.[invNum] ?? cfg?.inverters?.[String(invNum)] ?? "",
  ).trim();
  const ip = targetIp || "";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamPayload),
      timeout: 3000,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(
        data.error || `Upstream write failed (${r.status} ${r.statusText})`,
      );
    }
    logControlAction({
      operator: operatorName,
      inverter: invNum,
      node: unitNum || 0,
      action: valueNum === 1 ? "START" : "STOP",
      scope: scope || "single",
      result: "ok",
      ip,
    });
    res.json({ ok: true, data });
  } catch (e) {
    logControlAction({
      operator: operatorName,
      inverter: invNum,
      node: unitNum || 0,
      action: valueNum === 1 ? "START" : "STOP",
      scope: scope || "single",
      result: `error:${e.message}`,
      ip,
    });
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get("/api/settings", (req, res) =>
  res.json({
    operationMode: readOperationMode(),
    remoteAutoSync: readRemoteAutoSyncEnabled(),
    remoteGatewayUrl: getRemoteGatewayBaseUrl(),
    remoteApiToken: getRemoteApiToken(),
    tailscaleDeviceHint: sanitizeTailscaleDeviceHint(
      getSetting("tailscaleDeviceHint", getSetting("wireguardInterface", "")),
      "",
    ),
    wireguardInterface: sanitizeTailscaleDeviceHint(
      getSetting("tailscaleDeviceHint", getSetting("wireguardInterface", "")),
      "",
    ),
    apiUrl: getSetting("apiUrl", `${INVERTER_ENGINE_BASE_URL}/data`),
    writeUrl: getSetting("writeUrl", `${INVERTER_ENGINE_BASE_URL}/write`),
    csvSavePath: getSetting("csvSavePath", "C:\\Logs\\InverterDashboard"),
    inverterCount: Number(getSetting("inverterCount", 27)),
    nodeCount: Number(getSetting("nodeCount", 4)),
    invGridLayout: sanitizeInvGridLayout(getSetting("invGridLayout", "4")),
    plantName: getSetting("plantName", "Solar Plant"),
    operatorName: getSetting("operatorName", "OPERATOR"),
    retainDays: Number(getSetting("retainDays", 90)),
    forecastProvider: String(getSetting("forecastProvider", "ml_local") || "ml_local").trim().toLowerCase() === "solcast" ? "solcast" : "ml_local",
    solcastBaseUrl: getSetting("solcastBaseUrl", "https://api.solcast.com.au"),
    solcastApiKey: getSetting("solcastApiKey", ""),
    solcastResourceId: getSetting("solcastResourceId", ""),
    solcastTimezone: getSetting("solcastTimezone", "Asia/Manila"),
    exportUiState: sanitizeExportUiState(
      readJsonSetting("exportUiState", {}),
    ),
    inverterPollConfig: sanitizePollConfig(readJsonSetting("inverterPollConfig", DEFAULT_POLL_CFG)),
    dataDir: DATA_DIR,
  }),
);

app.get("/api/settings/export-ui", (req, res) => {
  res.json({
    exportUiState: sanitizeExportUiState(readJsonSetting("exportUiState", {})),
  });
});

app.get("/api/ip-config", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const cfg = loadIpConfigFromDb();
    mirrorIpConfigToLegacyFiles(cfg);
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/ip-config", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const cfg = saveIpConfigToDb(req.body || {});
    mirrorIpConfigToLegacyFiles(cfg);
    backfillAuditIpsFromConfig();
    // Push new config to poller immediately (skip 5 s cache lag).
    if (!isRemoteMode()) poller.setIpConfigSnapshot(cfg);
    // Notify the dashboard so it rebuilds inverter cards without a restart.
    broadcastUpdate({ type: "configChanged" });
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/settings", (req, res) => {
  const updates = {};
  let exportDirCreated = false;
  let exportDirResolved = "";
  const modeBefore = readOperationMode();
  const remoteGatewayBefore = getRemoteGatewayBaseUrl();
  const remoteTokenBefore = getRemoteApiToken();
  const {
    operationMode,
    remoteAutoSync,
    remoteGatewayUrl,
    remoteApiToken,
    wireguardInterface,
    tailscaleDeviceHint,
    apiUrl,
    writeUrl,
    csvSavePath,
    inverterCount,
    nodeCount,
    invGridLayout,
    plantName,
    operatorName,
    retainDays,
    forecastProvider,
    solcastBaseUrl,
    solcastApiKey,
    solcastResourceId,
    solcastTimezone,
    exportUiState,
    inverterPollConfig,
  } =
    req.body || {};

  if (operationMode !== undefined) {
    updates.operationMode = sanitizeOperationMode(operationMode, "gateway");
  }
  if (remoteAutoSync !== undefined) {
    updates.remoteAutoSync = Boolean(remoteAutoSync) ? "1" : "0";
  }
  if (remoteGatewayUrl !== undefined) {
    const url = normalizeGatewayUrl(remoteGatewayUrl);
    if (String(remoteGatewayUrl || "").trim() && !url) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid remoteGatewayUrl" });
    }
    updates.remoteGatewayUrl = url;
  }
  if (remoteApiToken !== undefined) {
    updates.remoteApiToken = String(remoteApiToken || "").trim().slice(0, 256);
  }
  if (tailscaleDeviceHint !== undefined || wireguardInterface !== undefined) {
    const hintSource =
      tailscaleDeviceHint !== undefined ? tailscaleDeviceHint : wireguardInterface;
    const safeHint = sanitizeTailscaleDeviceHint(hintSource, "");
    updates.tailscaleDeviceHint = safeHint;
    updates.wireguardInterface = safeHint;
  }

  if (apiUrl !== undefined) {
    const trimmedApiUrl = String(apiUrl || "").trim();
    if (trimmedApiUrl && !isHttpUrl(trimmedApiUrl))
      return res.status(400).json({ ok: false, error: "Invalid apiUrl" });
    if (trimmedApiUrl) updates.apiUrl = trimmedApiUrl;
  }
  if (writeUrl !== undefined) {
    const trimmedWriteUrl = String(writeUrl || "").trim();
    if (trimmedWriteUrl && !isHttpUrl(trimmedWriteUrl))
      return res.status(400).json({ ok: false, error: "Invalid writeUrl" });
    if (trimmedWriteUrl) updates.writeUrl = trimmedWriteUrl;
  }
  if (csvSavePath !== undefined) {
    const pathVal = String(csvSavePath).trim();
    if (!pathVal)
      return res.status(400).json({ ok: false, error: "Invalid csvSavePath" });
    try {
      const resolvedPath = path.resolve(pathVal);
      const existed = fs.existsSync(resolvedPath);
      fs.mkdirSync(resolvedPath, { recursive: true });
      exportDirCreated = !existed;
      exportDirResolved = resolvedPath;
      updates.csvSavePath = resolvedPath;
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: `Invalid csvSavePath: ${err.message}`,
      });
    }
  }
  if (inverterCount !== undefined)
    updates.inverterCount = clampInt(inverterCount, 1, 100, 27);
  if (nodeCount !== undefined)
    updates.nodeCount = clampInt(nodeCount, 1, 16, 4);
  if (invGridLayout !== undefined)
    updates.invGridLayout = sanitizeInvGridLayout(invGridLayout);
  if (retainDays !== undefined)
    updates.retainDays = clampInt(retainDays, 7, 1095, 90);
  if (plantName !== undefined) {
    const name = String(plantName).trim();
    if (!name)
      return res.status(400).json({ ok: false, error: "Invalid plantName" });
    updates.plantName = name.slice(0, 120);
  }
  if (operatorName !== undefined) {
    const name = String(operatorName).trim();
    if (!name)
      return res.status(400).json({ ok: false, error: "Invalid operatorName" });
    updates.operatorName = name.slice(0, 80);
  }
  if (forecastProvider !== undefined) {
    const provider = String(forecastProvider || "")
      .trim()
      .toLowerCase();
    if (provider !== "ml_local" && provider !== "solcast") {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid forecastProvider" });
    }
    updates.forecastProvider = provider;
  }
  if (solcastBaseUrl !== undefined) {
    const base = String(solcastBaseUrl || "").trim();
    if (base && !isHttpUrl(base)) {
      return res.status(400).json({ ok: false, error: "Invalid solcastBaseUrl" });
    }
    updates.solcastBaseUrl = base || "https://api.solcast.com.au";
  }
  if (solcastApiKey !== undefined) {
    const key = String(solcastApiKey || "").trim();
    updates.solcastApiKey = key.slice(0, 256);
  }
  if (solcastResourceId !== undefined) {
    const rid = String(solcastResourceId || "").trim();
    updates.solcastResourceId = rid.slice(0, 120);
  }
  if (solcastTimezone !== undefined) {
    const tz = String(solcastTimezone || "").trim();
    if (tz && !/^[A-Za-z0-9_.+\-]+(?:\/[A-Za-z0-9_.+\-]+)*$/.test(tz)) {
      return res.status(400).json({ ok: false, error: "Invalid solcastTimezone" });
    }
    updates.solcastTimezone = (tz || "Asia/Manila").slice(0, 80);
  }
  if (exportUiState !== undefined) {
    updates.exportUiState = JSON.stringify(sanitizeExportUiState(exportUiState));
  }
  if (inverterPollConfig !== undefined) {
    updates.inverterPollConfig = JSON.stringify(sanitizePollConfig(inverterPollConfig));
  }

  db.transaction(() => {
    Object.entries(updates).forEach(([k, v]) => setSetting(k, v));
  })();
  const modeAfter = readOperationMode();
  const remoteGatewayAfter = getRemoteGatewayBaseUrl();
  const remoteTokenAfter = getRemoteApiToken();
  if (
    modeAfter !== modeBefore ||
    remoteGatewayAfter !== remoteGatewayBefore ||
    remoteTokenAfter !== remoteTokenBefore
  ) {
    applyRuntimeMode();
    todayEnergyCache.ts = 0; // force immediate refresh; replicated DB data is now available
    broadcastUpdate({ type: "configChanged" }); // tell clients to reload settings + rebuild UI
  }
  if (updates.remoteAutoSync === "0") {
    remoteBridgeState.autoSyncAttempted = false;
  }
  res.json({
    ok: true,
    csvSavePath: exportDirResolved || getSetting("csvSavePath", "C:\\Logs\\InverterDashboard"),
    exportDirCreated,
  });
});

app.post("/api/settings/export-ui", (req, res) => {
  const payload = req.body || {};
  const safe = sanitizeExportUiState(payload.exportUiState || payload);
  setSetting("exportUiState", JSON.stringify(safe));
  res.json({ ok: true, exportUiState: safe });
});

app.get("/api/runtime/network", (req, res) => {
  res.json({
    ok: true,
    operationMode: readOperationMode(),
    remoteAutoSync: readRemoteAutoSyncEnabled(),
    remoteAutoSyncAttempted: Boolean(remoteBridgeState.autoSyncAttempted),
    remotePullOnly: Boolean(isRemotePullOnlyMode()),
    remoteGatewayUrl: getRemoteGatewayBaseUrl(),
    remoteConnected: Boolean(remoteBridgeState.connected),
    remoteLastAttemptTs: Number(remoteBridgeState.lastAttemptTs || 0),
    remoteLastSuccessTs: Number(remoteBridgeState.lastSuccessTs || 0),
    remoteLastError: String(remoteBridgeState.lastError || ""),
    remoteReplicationRunning: Boolean(remoteBridgeState.replicationRunning),
    remoteLastReplicationAttemptTs: Number(remoteBridgeState.lastReplicationAttemptTs || 0),
    remoteLastReplicationTs: Number(remoteBridgeState.lastReplicationTs || 0),
    remoteLastIncrementalTs: Number(remoteBridgeState.lastIncrementalTs || 0),
    remoteLastReplicationRows: Number(remoteBridgeState.lastReplicationRows || 0),
    remoteLastReplicationSignature: String(remoteBridgeState.lastReplicationSignature || ""),
    remoteLastReplicationError: String(remoteBridgeState.lastReplicationError || ""),
    remoteLastReconcileTs: Number(remoteBridgeState.lastReconcileTs || 0),
    remoteLastReconcileRows: Number(remoteBridgeState.lastReconcileRows || 0),
    remoteLastReconcileError: String(remoteBridgeState.lastReconcileError || ""),
    remoteLastSyncDirection: String(remoteBridgeState.lastSyncDirection || "idle"),
    remoteReplicationCursors: normalizeReplicationCursors(
      isRemotePullOnlyMode()
        ? {}
        : remoteBridgeState.replicationCursors || readReplicationCursorsSetting(),
    ),
    tailscale: getTailscaleStatusSnapshot(),
  });
});

app.get("/api/runtime/perf", (req, res) => {
  res.json(getRuntimePerfSnapshot());
});

app.get("/api/tailscale/status", (req, res) => {
  const hint = String(req.query?.deviceHint || "").trim();
  res.json({ ok: true, ...getTailscaleStatusSnapshot(hint) });
});

// Backward-compat alias for older frontend builds.
app.get("/api/wireguard/status", (req, res) => {
  const hint = String(req.query?.interface || "").trim();
  res.json({ ok: true, ...getTailscaleStatusSnapshot(hint) });
});

app.post("/api/runtime/network/test", async (req, res) => {
  const body = req.body || {};
  const base = normalizeGatewayUrl(
    body.remoteGatewayUrl !== undefined
      ? body.remoteGatewayUrl
      : getRemoteGatewayBaseUrl(),
  );
  const token = String(
    body.remoteApiToken !== undefined ? body.remoteApiToken : getRemoteApiToken(),
  )
    .trim()
    .slice(0, 256);
  if (!base) {
    return res
      .status(400)
      .json({ ok: false, error: "Remote gateway URL is not configured." });
  }
  if (isUnsafeRemoteLoop(base)) {
    return res
      .status(400)
      .json({ ok: false, error: "Remote gateway URL cannot be localhost in remote mode." });
  }
  const started = Date.now();
  try {
    const r = await fetch(`${base}/api/live`, {
      method: "GET",
      headers: buildRemoteProxyHeaders(token),
      timeout: REMOTE_FETCH_TIMEOUT_MS,
    });
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `Gateway test failed: HTTP ${r.status} ${r.statusText}`,
      });
    }
    const payload = await r.json().catch(() => ({}));
    const count =
      payload && typeof payload === "object" ? Object.keys(payload).length : 0;
    return res.json({
      ok: true,
      latencyMs: Date.now() - started,
      liveNodeCount: count,
      message: `Gateway reachable (${count} live node(s))`,
    });
  } catch (err) {
    return res
      .status(502)
      .json({ ok: false, error: `Gateway test failed: ${err.message}` });
  }
});

app.use("/api", async (req, res, next) => {
  if (!isRemoteMode()) return next();
  if (!shouldProxyApiPath(req.path)) return next();
  return proxyToRemote(req, res);
});

app.get("/api/alarms/active", (req, res) => {
  const rows = getActiveAlarms();
  const nowTs = Date.now();
  res.json(rows.map((r) => enrichAlarmRow(r, nowTs)));
});
app.get("/api/alarms", (req, res) => {
  const _t0 = Date.now();
  const { start, end, inverter } = req.query;
  const s = parseDateMs(start, Date.now() - 7 * 86400000, false);
  const e = parseDateMs(end, Date.now(), true);
  const configured = getConfiguredNodeSet();
  const rows =
    inverter && inverter !== "all"
      ? db
          .prepare(
            "SELECT * FROM alarms WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000",
          )
          .all(Number(inverter), s, e)
      : stmts.getAlarmsRange.all(s, e);
  const nowTs = Date.now();
  const out = rows
    .filter((r) =>
      configured.has(`${Number(r.inverter) || 0}_${Number(r.unit) || 0}`),
    )
    .map((r) => enrichAlarmRow(r, nowTs));
  res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
  res.json(out);
});
app.post("/api/alarms/:id/ack", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid alarm id" });
  }
  const info = stmts.ackAlarm.run(id);
  res.json({ ok: true, count: Number(info?.changes || 0) });
});
app.post("/api/alarms/ack-all", (req, res) => {
  const info = stmts.ackAllAlarms.run();
  res.json({ ok: true, count: Number(info?.changes || 0) });
});

app.get("/api/audit", (req, res) => {
  const _t0 = Date.now();
  const { start, end, inverter, limit } = req.query;
  const s = parseDateMs(start, Date.now() - 7 * 86400000, false);
  const e = parseDateMs(end, Date.now(), true);
  const rawLimit = Number(limit);
  const safeLimit = Number.isFinite(rawLimit)
    ? Math.min(20000, Math.max(1, Math.trunc(rawLimit)))
    : 5000;
  const invNum = Math.trunc(Number(inverter || 0));
  const out = getAuditLog({
    start: s,
    end: e,
    inverter:
      inverter && inverter !== "all" && Number.isFinite(invNum) && invNum > 0
        ? invNum
        : null,
    limit: safeLimit,
  });
  res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
  res.json(out);
});

app.get("/api/energy/5min", (req, res) => {
  const _t0 = Date.now();
  const { inverter, start, end, paged, limit, offset } = req.query;
  const s = start ? Number(start) : Date.now() - 86400000;
  const e = end ? Number(end) : Date.now();
  if (s >= e) return res.status(400).json({ ok: false, error: "start must be before end" });
  const pagedMode = ["1", "true", "yes", "on"].includes(
    String(paged || "")
      .trim()
      .toLowerCase(),
  );
  const invParsed = Number(inverter);
  const scopedInv =
    inverter && inverter !== "all" && Number.isFinite(invParsed) && invParsed > 0
      ? invParsed
      : null;

  if (pagedMode) {
    const safeLimit = clampInt(limit, 100, 5000, 500);
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    try {
      let rows = [];
      let total = 0;
      let summaryRow = {};
      let peakRow = {};

      if (Number.isFinite(scopedInv) && scopedInv > 0) {
        rows = db
          .prepare(
            `SELECT id, ts, inverter, kwh_inc
             FROM energy_5min
             WHERE inverter=? AND ts BETWEEN ? AND ?
             ORDER BY ts DESC, inverter ASC
             LIMIT ? OFFSET ?`,
          )
          .all(scopedInv, s, e, safeLimit, safeOffset);
        total = Number(
          db
            .prepare(
              `SELECT COUNT(1) AS c
               FROM energy_5min
               WHERE inverter=? AND ts BETWEEN ? AND ?`,
            )
            .get(scopedInv, s, e)?.c || 0,
        );
        summaryRow =
          db
            .prepare(
              `SELECT COUNT(1) AS row_count,
                      COALESCE(SUM(kwh_inc), 0) AS total_kwh,
                      COALESCE(MAX(ts), 0) AS latest_ts,
                      COUNT(DISTINCT inverter) AS inverter_count
                 FROM energy_5min
                WHERE inverter=? AND ts BETWEEN ? AND ?`,
            )
            .get(scopedInv, s, e) || {};
        peakRow =
          db
            .prepare(
              `SELECT inverter, ts, kwh_inc
                 FROM energy_5min
                WHERE inverter=? AND ts BETWEEN ? AND ?
                ORDER BY kwh_inc DESC, ts DESC
                LIMIT 1`,
            )
            .get(scopedInv, s, e) || {};
      } else {
        rows = db
          .prepare(
            `SELECT id, ts, inverter, kwh_inc
             FROM energy_5min
             WHERE ts BETWEEN ? AND ?
             ORDER BY ts DESC, inverter ASC
             LIMIT ? OFFSET ?`,
          )
          .all(s, e, safeLimit, safeOffset);
        total = Number(
          db
            .prepare(
              `SELECT COUNT(1) AS c
               FROM energy_5min
               WHERE ts BETWEEN ? AND ?`,
            )
            .get(s, e)?.c || 0,
        );
        summaryRow =
          db
            .prepare(
              `SELECT COUNT(1) AS row_count,
                      COALESCE(SUM(kwh_inc), 0) AS total_kwh,
                      COALESCE(MAX(ts), 0) AS latest_ts,
                      COUNT(DISTINCT inverter) AS inverter_count
                 FROM energy_5min
                WHERE ts BETWEEN ? AND ?`,
            )
            .get(s, e) || {};
        peakRow =
          db
            .prepare(
              `SELECT inverter, ts, kwh_inc
                 FROM energy_5min
                WHERE ts BETWEEN ? AND ?
                ORDER BY kwh_inc DESC, ts DESC
                LIMIT 1`,
            )
            .get(s, e) || {};
      }

      const rowCount = Number(summaryRow?.row_count || 0);
      const totalKwh = Number(summaryRow?.total_kwh || 0);
      const summary = {
        rowCount,
        totalKwh: Number(totalKwh.toFixed(6)),
        avgKwh: rowCount > 0 ? Number((totalKwh / rowCount).toFixed(6)) : 0,
        latestTs: Number(summaryRow?.latest_ts || 0),
        inverterCount: Number(summaryRow?.inverter_count || 0),
        peak: {
          inverter: Number(peakRow?.inverter || 0),
          ts: Number(peakRow?.ts || 0),
          kwhInc: Number(Number(peakRow?.kwh_inc || 0).toFixed(6)),
        },
      };

      res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
      return res.json({
        ok: true,
        rows,
        total,
        limit: safeLimit,
        offset: safeOffset,
        hasMore: safeOffset + rows.length < total,
        summary,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message || "Energy pagination failed." });
    }
  }

  // Non-paged fallback: apply a hard row cap so a wide date range cannot
  // serialize millions of rows and hang the process. Use paged=1 for large ranges.
  try {
    const capLimit = ENERGY_5MIN_UNPAGED_ROW_CAP;
    const rows = !scopedInv
      ? db.prepare(
          "SELECT * FROM energy_5min WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, ts ASC LIMIT ?",
        ).all(s, e, capLimit + 1)
      : db.prepare(
          "SELECT * FROM energy_5min WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?",
        ).all(Number(scopedInv), s, e, capLimit + 1);
    if (rows.length > capLimit) {
      return res.status(400).json({
        ok: false,
        error: `Date range too large: use paged=1 with limit/offset or narrow the range. Exceeded ${capLimit} row cap.`,
        rowCap: capLimit,
      });
    }
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Analytics-specific energy source:
// Always PAC-integrated kWh buckets (never register kWh deltas).
app.get("/api/analytics/energy", (req, res) => {
  const { inverter, start, end, bucketMin } = req.query;
  const s = start ? Number(start) : Date.now() - 86400000;
  const e = end ? Number(end) : Date.now();
  if (s >= e) return res.status(400).json({ ok: false, error: "start must be before end" });
  const bm = clampInt(bucketMin, 1, 60, 5);
  // Apply row cap to prevent wide date ranges from hanging the analytics chart.
  const baseRows =
    !inverter || inverter === "all"
      ? db.prepare(
          "SELECT * FROM energy_5min WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, ts ASC LIMIT ?",
        ).all(s, e, ENERGY_5MIN_UNPAGED_ROW_CAP)
      : db.prepare(
          "SELECT * FROM energy_5min WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?",
        ).all(Number(inverter), s, e, ENERGY_5MIN_UNPAGED_ROW_CAP);

  if (baseRows.length) {
    if (bm <= 5) return res.json(baseRows);
    const bucketMs = bm * 60000;
    const map = new Map();
    for (const r of baseRows) {
      const ts = Number(r?.ts || 0);
      const inv = Number(r?.inverter || 0);
      if (!ts || !inv) continue;
      const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
      const key = `${inv}|${bucketTs}`;
      const prev = Number(map.get(key) || 0);
      map.set(key, prev + Number(r?.kwh_inc || 0));
    }
    const out = Array.from(map.entries())
      .map(([key, kwh]) => {
        const [invStr, tsStr] = String(key).split("|");
        return {
          inverter: Number(invStr),
          ts: Number(tsStr),
          kwh_inc: Number(Number(kwh || 0).toFixed(6)),
        };
      })
      .sort((a, b) => Number(a.inverter || 0) - Number(b.inverter || 0) || Number(a.ts || 0) - Number(b.ts || 0));
    return res.json(out);
  }

  // Fallback only when energy_5min is empty/unavailable for the requested range.
  const rebuilt = buildPacEnergyBuckets({
    inverter: inverter || "all",
    startTs: s,
    endTs: e,
    bucketMin: bm,
  });
  return res.json(rebuilt);
});

app.get("/api/analytics/dayahead", (req, res) => {
  const { date, start, end, bucketMin } = req.query;
  const parsedStart = parseDateMs(start, NaN, false);
  const parsedEnd = parseDateMs(end, NaN, true);
  const targetDate = String(
    date || (Number.isFinite(parsedStart) ? localDateStr(parsedStart) : localDateStr()),
  ).trim();

  let rows = getDayAheadRowsForDate(targetDate);
  const s = Number.isFinite(parsedStart)
    ? parsedStart
    : new Date(`${targetDate}T00:00:00.000`).getTime();
  const e = Number.isFinite(parsedEnd)
    ? parsedEnd
    : new Date(`${targetDate}T23:59:59.999`).getTime();
  rows = rows.filter((r) => {
    const ts = Number(r?.ts || 0);
    return ts >= s && ts <= e;
  });

  const bm = clampInt(bucketMin, 1, 60, 5);
  if (bm > 5 && rows.length) {
    const bucketMs = bm * 60000;
    const map = new Map();
    for (const r of rows) {
      const ts = Number(r?.ts || 0);
      if (!ts) continue;
      const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
      const prev = Number(map.get(bucketTs) || 0);
      map.set(bucketTs, prev + Number(r?.kwh_inc || 0));
    }
    rows = Array.from(map.entries())
      .map(([ts, kwh]) => ({
        ts: Number(ts),
        kwh_inc: Number(Number(kwh || 0).toFixed(6)),
        mwh_inc: Number((Number(kwh || 0) / 1000).toFixed(6)),
      }))
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  }

  res.json(rows);
});

app.get("/api/weather/weekly", async (req, res) => {
  try {
    const day = parseIsoDateStrict(req.query?.date || localDateStr(), "date");
    const rows = await getWeeklyWeather(day);
    return res.json({ ok: true, date: day, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/forecast/solcast/test", async (req, res) => {
  try {
    const cfg = buildSolcastConfigFromInput(req.body || {});
    if (!isHttpUrl(cfg.baseUrl)) {
      return res.status(400).json({ ok: false, error: "Invalid Solcast Base URL." });
    }
    if (!cfg.apiKey) {
      return res.status(400).json({ ok: false, error: "Solcast API key is required." });
    }
    if (!cfg.resourceId) {
      return res.status(400).json({ ok: false, error: "Solcast resource ID is required." });
    }
    if (!/^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(cfg.timeZone)) {
      return res.status(400).json({ ok: false, error: "Invalid Solcast timezone format." });
    }

    const started = Date.now();
    const { endpoint, records } = await fetchSolcastForecastRecords(cfg);
    const validTs = [];
    const daySet = new Set();
    for (const rec of records || []) {
      const periodEndRaw =
        rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
      const ts = Date.parse(String(periodEndRaw || ""));
      if (!Number.isFinite(ts) || ts <= 0) continue;
      validTs.push(ts);
      daySet.add(getTzParts(ts, cfg.timeZone).date);
    }
    validTs.sort((a, b) => a - b);

    const todayTz = localDateStrInTz(Date.now(), cfg.timeZone);
    const tomorrowTz = addDaysIso(todayTz, 1);
    let preview = { date: tomorrowTz, slots: 0, totalMwh: 0 };
    let warning = "";
    try {
      const rows = buildDayAheadRowsFromSolcast(tomorrowTz, records, cfg);
      const totalKwh = rows.reduce((s, r) => s + Number(r?.kwh_inc || 0), 0);
      preview = {
        date: tomorrowTz,
        slots: Number(rows.length || 0),
        totalMwh: Number((totalKwh / 1000).toFixed(6)),
      };
    } catch (err) {
      warning = String(err?.message || err || "").slice(0, 240);
    }

    return res.json({
      ok: true,
      provider: "solcast",
      endpoint,
      durationMs: Date.now() - started,
      records: Number(records.length || 0),
      timezone: cfg.timeZone,
      firstPeriodEndIso: validTs.length ? new Date(validTs[0]).toISOString() : "",
      lastPeriodEndIso: validTs.length
        ? new Date(validTs[validTs.length - 1]).toISOString()
        : "",
      daysCovered: Array.from(daySet).sort(),
      dayAheadPreview: preview,
      warning,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

let forecastGenerating = false;

app.post("/api/forecast/generate", async (req, res) => {
  if (isRemoteMode()) {
    return res.status(403).json({
      ok: false,
      error:
        "Day-ahead generation is disabled in Client mode. Generate on the Gateway server.",
    });
  }
  if (forecastGenerating) {
    return res.status(409).json({ ok: false, error: "Forecast generation already in progress." });
  }
  forecastGenerating = true;
  try {
    const body = req.body || {};
    const mode = String(body.mode || "").trim();
    let dates = [];
    let dayCount = 1;

    if (!mode || mode === "dayahead-days") {
      dayCount = clampInt(body.dayCount, 1, 31, 1);
      const tomorrow = addDaysIso(localDateStr(), 1);
      const lastDay = addDaysIso(tomorrow, dayCount - 1);
      dates = daysInclusive(tomorrow, lastDay);
    } else {
      return res.status(400).json({
        ok: false,
        error: "Invalid mode. Use 'dayahead-days'.",
      });
    }

    const preferredProvider = readForecastProvider();
    const maxFutureDateMl = addDaysIso(localDateStr(), 15);
    const outOfHorizonMl = dates.filter((d) => d > maxFutureDateMl);
    let providerOrder =
      preferredProvider === "solcast"
        ? ["solcast", "ml_local"]
        : hasUsableSolcastConfig(getSolcastConfig())
          ? ["ml_local", "solcast"]
          : ["ml_local"];
    if (outOfHorizonMl.length) {
      providerOrder = providerOrder.filter((p) => p !== "ml_local");
      if (!providerOrder.length) {
        return res.status(400).json({
          ok: false,
          error: `Requested future date exceeds local ML weather horizon. Latest allowed date is ${maxFutureDateMl}.`,
        });
      }
    }

    const attempts = [];
    let generation = null;
    for (const provider of providerOrder) {
      const started = Date.now();
      try {
        if (provider === "solcast") {
          generation = await generateDayAheadWithSolcast(dates);
        } else {
          generation = await generateDayAheadWithMl(dayCount);
        }
        attempts.push({
          provider,
          ok: true,
          durationMs: Date.now() - started,
        });
        break;
      } catch (err) {
        attempts.push({
          provider,
          ok: false,
          durationMs: Date.now() - started,
          error: String(err?.message || err || "unknown error").slice(0, 400),
        });
      }
    }

    if (!generation) {
      const lastError = attempts.length
        ? attempts[attempts.length - 1].error
        : "Forecast generation failed.";
      return res.status(500).json({
        ok: false,
        error: "Forecast generation failed for all providers.",
        details: lastError,
        attempts,
      });
    }

    res.json({
      ok: true,
      mode,
      dates,
      count: dates.length,
      providerPreferred: preferredProvider,
      providerUsed: generation.providerUsed || "ml_local",
      fallbackUsed: (generation.providerUsed || "ml_local") !== preferredProvider,
      fallbackReason:
        (generation.providerUsed || "ml_local") !== preferredProvider
          ? attempts.find((a) => a.provider === preferredProvider && !a.ok)?.error || "Preferred provider unavailable."
          : "",
      durationMs: Number(generation.durationMs || 0),
      normalizedRows: Number(generation.normalizedRows || 0),
      writtenRows: Number(generation.writtenRows || 0),
      endpoint: generation.endpoint || "",
      attempts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    forecastGenerating = false;
  }
});

app.get("/api/energy/today", (req, res) => {
  try {
    const rows = getTodayPacTotalsFromDbCached();
    // Keep this endpoint strictly aligned with logged daily report rows.
    return res.json(rows);
  } catch (e) {
    console.warn("[energy/today] DB PAC total failed:", e.message);
    return res.json([]);
  }
});

app.get("/api/report/daily", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const _t0 = Date.now();
  try {
    const { date, start, end, refresh } = req.query;
    const refreshRequested = ["1", "true", "yes", "on"].includes(
      String(refresh || "")
        .trim()
        .toLowerCase(),
    );
    if (date) {
      const day = parseIsoDateStrict(date, "date");
      const isToday = day === localDateStr();
      const rows = getDailyReportRowsForDay(day, {
        persist: true,
        includeTodayPartial: isToday,
        refresh: refreshRequested,
      });
      res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
      return res.json(rows);
    }

    const s = start || localDateStr(Date.now() - 7 * 86400000);
    const e = end || localDateStr();
    res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
    return res.json(stmts.getDailyReportRange.all(s, e));
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/api/report/summary", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const day = parseIsoDateStrict(req.query?.date || localDateStr(), "date");
    const refreshRequested = ["1", "true", "yes", "on"].includes(
      String(req.query?.refresh || "")
        .trim()
        .toLowerCase(),
    );
    return res.json(
      buildDailyWeeklyReportSummary(day, { refreshDay: refreshRequested }),
    );
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/api/report/latest-date", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const latestDate = getLatestReportDate();
    return res.json({
      ok: true,
      latestDate: latestDate || "",
      hasData: Boolean(latestDate),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/export/alarms", async (req, res) => {
  try {
    const outPath = await exporter.exportAlarms(req.body || {});
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/export/energy", async (req, res) => {
  try {
    const outPath = await exporter.exportEnergy(req.body || {});
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/export/inverter-data", async (req, res) => {
  try {
    const outPath = await exporter.exportInverterData(req.body || {});
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/export/5min", async (req, res) => {
  try {
    const outPath = await exporter.export5min(req.body || {});
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/export/audit", async (req, res) => {
  try {
    const outPath = await exporter.exportAudit(req.body || {});
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/export/daily-report", async (req, res) => {
  try {
    const payload = req.body || {};
    const dateText = String(payload?.date || "").trim();
    if (dateText) {
      try {
        const day = parseIsoDateStrict(dateText, "date");
        buildDailyReportRowsForDate(day, {
          persist: true,
          includeTodayPartial: day === localDateStr(),
        });
      } catch (_) {
        // Exporter handles fallback/defaults.
      }
    } else {
      const s = Number(payload?.startTs || 0);
      const e = Number(payload?.endTs || 0);
      if (Number.isFinite(s) && Number.isFinite(e) && s > 0 && e >= s) {
        const startDay = fmtDate(s);
        const endDay = fmtDate(e);
        const today = localDateStr();
        for (const day of daysInclusive(startDay, endDay)) {
          if (day > today) continue;
          buildDailyReportRowsForDate(day, {
            persist: true,
            includeTodayPartial: day === today,
          });
        }
      }
    }
    const outPath = await exporter.exportDailyReport(req.body || {});
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/export/forecast-actual", async (req, res) => {
  try {
    const outPath = await exporter.exportForecastActual(req.body || {});
    res.json({ ok: true, path: outPath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

cron.schedule("0 2 * * *", pruneOldData);
cron.schedule("5 18 * * *", () => {
  const today = localDateStr();
  try {
    const rows = buildDailyReportRowsForDate(today, {
      persist: true,
      includeTodayPartial: false,
    });
    console.log(
      `[Cron] Daily report generated for ${today} (${rows.length} inverter row(s))`,
    );
  } catch (e) {
    console.warn("[Cron] Daily report generation failed:", e.message);
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`[Inverter] Server on http://localhost:${PORT}`);
  loadRemoteTodayEnergyShadowFromSettings();
  loadGatewayHandoffMetaFromSettings();
  try {
    const cfg = loadIpConfigFromDb();
    mirrorIpConfigToLegacyFiles(cfg);
    backfillAuditIpsFromConfig();
  } catch (e) {
    console.warn("[IPCONFIG] startup migration failed:", e.message);
  }
  try {
    if (readForecastProvider() !== "solcast") {
      const r = syncDayAheadFromContextIfNewer(true);
      if (r?.changed) {
        console.log(
          `[Forecast] Day-ahead sync -> DB: days=${Number(r.days || 0)} rows=${Number(r.rows || 0)}`,
        );
      }
    } else {
      console.log("[Forecast] Solcast provider selected; skipped legacy context sync.");
    }
    const trimmed = normalizeForecastDbWindow();
    if (trimmed > 0) {
      console.log(`[Forecast] Normalized DB forecast window (removed ${trimmed} row(s) outside 05:00-18:00).`);
    }
  } catch (e) {
    console.warn("[Forecast] startup sync failed:", e.message);
  }
  applyRuntimeMode();
  if (process.send) process.send("ready");
});

// ─── Cloud Backup API Routes ──────────────────────────────────────────────────

/** GET /api/backup/settings  — return cloud backup settings */
app.get("/api/backup/settings", (req, res) => {
  try {
    const s = _cloudBackup.getCloudSettings();
    res.json({ ok: true, settings: s, connected: _tokenStore.listConnected() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/settings  — save cloud backup settings */
app.post("/api/backup/settings", (req, res) => {
  try {
    const body = req.body || {};
    const saved = _cloudBackup.saveCloudSettings(body);
    res.json({ ok: true, settings: saved });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/auth/:provider/start  — begin OAuth flow */
app.post("/api/backup/auth/:provider/start", (req, res) => {
  const provider = req.params.provider;
  if (provider !== "onedrive" && provider !== "gdrive") {
    return res.status(400).json({ ok: false, error: "Unknown provider" });
  }
  try {
    _cleanOauthPending();
    const settings = _cloudBackup.getCloudSettings();
    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = `${OAUTH_REDIRECT_BASE}/${provider}`;

    let authUrl;
    if (provider === "onedrive") {
      const clientId = settings.onedrive?.clientId || "";
      const { verifier, challenge } = OneDriveProvider.generatePKCE();
      authUrl = _onedrive.getAuthUrl(clientId, redirectUri, state, challenge);
      _oauthPending.set(state, {
        provider,
        codeVerifier: verifier,
        clientId,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      });
    } else {
      const clientId = settings.gdrive?.clientId || "";
      authUrl = _gdrive.getAuthUrl(clientId, redirectUri, state);
      _oauthPending.set(state, {
        provider,
        codeVerifier: null,
        clientId,
        clientSecret: settings.gdrive?.clientSecret || "",
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      });
    }
    res.json({ ok: true, authUrl, state });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/auth/:provider/callback  — complete OAuth token exchange */
app.post("/api/backup/auth/:provider/callback", async (req, res) => {
  const provider = req.params.provider;
  const { code, state } = req.body || {};
  if (!code || !state) {
    return res.status(400).json({ ok: false, error: "Missing code or state" });
  }
  _cleanOauthPending();
  const pending = _oauthPending.get(state);
  if (!pending || pending.provider !== provider) {
    return res.status(400).json({ ok: false, error: "Invalid or expired OAuth state" });
  }
  _oauthPending.delete(state);
  const redirectUri = `${OAUTH_REDIRECT_BASE}/${provider}`;
  try {
    if (provider === "onedrive") {
      await _onedrive.exchangeCode(pending.clientId, code, redirectUri, pending.codeVerifier);
      const userInfo = await _onedrive.getUserInfo().catch(() => null);
      res.json({ ok: true, provider, user: userInfo });
    } else {
      await _gdrive.exchangeCode(pending.clientId, pending.clientSecret, code, redirectUri);
      const userInfo = await _gdrive.getUserInfo().catch(() => null);
      res.json({ ok: true, provider, user: userInfo });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/auth/:provider/disconnect  — revoke stored tokens */
app.post("/api/backup/auth/:provider/disconnect", (req, res) => {
  const provider = req.params.provider;
  try {
    if (provider === "onedrive") _onedrive.disconnect();
    else if (provider === "gdrive") _gdrive.disconnect();
    res.json({ ok: true, provider, connected: _tokenStore.listConnected() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/backup/status  — connection status + progress */
app.get("/api/backup/status", (req, res) => {
  res.json({
    ok: true,
    connected: _tokenStore.listConnected(),
    progress: _cloudBackup.getProgress(),
  });
});

/** GET /api/backup/progress  — current operation progress */
app.get("/api/backup/progress", (req, res) => {
  res.json({ ok: true, progress: _cloudBackup.getProgress() });
});

/** GET /api/backup/history  — local backup history */
app.get("/api/backup/history", (req, res) => {
  try {
    const history = _cloudBackup.getHistory().map((h) => ({
      id: h.id,
      createdAt: h.createdAt,
      scope: h.scope,
      tag: h.tag,
      totalSize: h.totalSize,
      status: h.status,
      cloud: h.cloud,
      restoredFrom: h.restoredFrom || null,
    }));
    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/now  — run backup immediately */
app.post("/api/backup/now", async (req, res) => {
  const { scope, provider, tag } = req.body || {};
  try {
    const q = enqueueCloudOp("backupNow", async () => {
      await _cloudBackup.backupNow({ scope, provider, tag });
    });
    res.json({
      ok: true,
      status: "queued",
      queuePosition: q.position,
      message: "Backup queued in background.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/backup/cloud/:provider  — list cloud backups */
app.get("/api/backup/cloud/:provider", async (req, res) => {
  const provider = req.params.provider;
  try {
    const items = await _cloudBackup.listCloudBackups(provider);
    res.json({ ok: true, provider, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/pull  — pull backup from cloud */
app.post("/api/backup/pull", async (req, res) => {
  const { provider, remoteId, remoteName } = req.body || {};
  if (!provider || !remoteId || !remoteName) {
    return res.status(400).json({ ok: false, error: "Missing provider, remoteId, or remoteName" });
  }
  try {
    const q = enqueueCloudOp("pullFromCloud", async () => {
      await _cloudBackup.pullFromCloud(provider, remoteId, remoteName);
    });
    res.json({
      ok: true,
      status: "queued",
      queuePosition: q.position,
      message: "Pull queued in background.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/restore/:id  — restore a local backup */
app.post("/api/backup/restore/:id", async (req, res) => {
  const backupId = decodeURIComponent(req.params.id);
  const { skipSafetyBackup } = req.body || {};
  try {
    const q = enqueueCloudOp("restoreBackup", async () => {
      await _cloudBackup.restoreBackup(backupId, {
        skipSafetyBackup: !!skipSafetyBackup,
      });
    });
    res.json({
      ok: true,
      status: "queued",
      queuePosition: q.position,
      message: "Restore queued in background.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** DELETE /api/backup/:id  — delete a local backup package */
app.delete("/api/backup/:id", (req, res) => {
  const backupId = decodeURIComponent(req.params.id);
  try {
    const result = _cloudBackup.deleteLocalBackup(backupId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
let _shutdownCalled = false;

function _flushAndClose() {
  try { poller.flushPending(); } catch (_) {}   // recover last ~1 s of readings
  closeDb();                                      // WAL checkpoint + db.close
}

// Called when running as a spawned child process (dev mode or future use).
function gracefulShutdown(reason) {
  if (_shutdownCalled) return;
  _shutdownCalled = true;
  console.log(`[Server] Graceful shutdown (${reason || "signal"}): flushing DB...`);
  try { poller.stop(); } catch (_) {}
  httpServer.close(() => { _flushAndClose(); process.exit(0); });
  // Safety: if httpServer doesn't drain within 2 s, force-close and exit.
  setTimeout(() => { _flushAndClose(); process.exit(0); }, 2000).unref();
}

// Called when running embedded in the Electron main process (packaged mode).
// Must NOT call process.exit — Electron controls the lifecycle.
function shutdownEmbedded() {
  if (_shutdownCalled) return;
  _shutdownCalled = true;
  console.log("[Server] Embedded shutdown: flushing DB...");
  try { poller.stop(); } catch (_) {}
  _flushAndClose();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("message", (msg) => {
  if (msg && msg.type === "shutdown") gracefulShutdown("ipc");
});

// ─── Periodic WAL Checkpoint ──────────────────────────────────────────────────
// Keeps the WAL file from growing unbounded between auto-checkpoints.
setInterval(() => {
  try { db.pragma("wal_checkpoint(PASSIVE)"); } catch (_) {}
}, 15 * 60 * 1000).unref();

// ─── Periodic DB Backup ───────────────────────────────────────────────────────
// Rotates between 2 backup files every 2 hours. Uses SQLite's online backup API
// so it never blocks reads/writes and is always consistent.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
let _backupSlot = 0;
async function runPeriodicBackup() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (_) {}
  const dest = path.join(BACKUP_DIR, `adsi_backup_${_backupSlot}.db`);
  _backupSlot = (_backupSlot + 1) % 2;
  try {
    await db.backup(dest);
    console.log("[DB] Backup written:", dest);
  } catch (err) {
    console.error("[DB] Backup failed:", err.message);
  }
}
setInterval(runPeriodicBackup, 2 * 60 * 60 * 1000).unref();
setTimeout(runPeriodicBackup, 60 * 1000).unref(); // startup backup after 60 s

module.exports = { shutdownEmbedded };


