"use strict";
const express = require("express");
const expressWs = require("express-ws");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");
const vm = require("vm");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const fetch = require("node-fetch");
const cron = require("node-cron");

const {
  getSetting,
  setSetting,
  pruneOldData,
  stmts,
  db,
  DATA_DIR,
  ARCHIVE_DIR,
  bulkInsert,
  bulkUpsertForecastDayAhead,
  bulkUpsertForecastIntradayAdjusted,
  bulkUpsertSolcastSnapshot,
  closeDb,
  getTelemetryHotCutoffTs,
  queryReadingsRangeAll,
  queryReadingsRange,
  queryEnergy5minRangeAll,
  queryEnergy5minRange,
  sumEnergy5minByInverterRange,
  archiveReadingsRows,
  archiveEnergyRows,
  getDailyReadingsSummaryRows,
  ingestDailyReadingsSummary,
  rebuildDailyReadingsSummaryForDate,
  closeArchiveDbForMonth,
  stagePendingMainDbReplacement,
  beginArchiveDbReplacement,
  validateSqliteFileSync,
  endArchiveDbReplacement,
  insertChatMessage,
  getChatThread,
  getChatInboxAfterId,
  markChatReadUpToId,
  clearAllChatMessages,
} = require("./db");
const { registerClient, broadcastUpdate, startKeepAlive, getStats: getWsStats } = require("./ws");
const poller = require("./poller");
const exporter = require("./exporter");
const {
  getActiveAlarms,
  decodeAlarm,
  getTopSeverity,
  formatAlarmHex,
  checkAlarms,
  logControlAction,
  getAuditLog,
} = require("./alarms");

// â”€â”€â”€ Cloud Backup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
const staticNoCache = {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  },
};
app.use("/assets", express.static(path.join(__dirname, "../assets"), staticNoCache));
app.use(express.static(path.join(__dirname, "../public"), staticNoCache));
app.use("/api", remoteApiTokenGate);
const PORT = Math.max(1, Math.min(65535, Number(process.env.ADSI_SERVER_PORT || 3500) || 3500));
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
const ARCHIVE_PENDING_REPLACEMENTS_PATH = path.join(
  ARCHIVE_DIR,
  ".pending-archive-replacements.json",
);
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
const SOLCAST_ACCESS_MODE_API = "api";
const SOLCAST_ACCESS_MODE_TOOLKIT = "toolkit";
const SOLCAST_TOOLKIT_RECENT_HOURS = 48;
const SOLCAST_TOOLKIT_PERIOD = "PT5M";
const SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS = 7;
const SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS = 192;
const SOLCAST_TOOLKIT_SITE_TYPES = new Set([
  "utility_scale_sites",
  "rooftop_sites",
  "sites",
]);
const REPORT_SOLAR_START_H = SOLCAST_SOLAR_START_H;
const REPORT_SOLAR_END_H = SOLCAST_SOLAR_END_H;
const REPORT_UNIT_KW_MAX = SOLCAST_UNIT_KW_MAX;
const REPORT_MAX_NODES_PER_INVERTER = 4;
const AVAIL_MAX_GAP_S = 120; // max interval treated as online (6Ã— OFFLINE_MS=20s)
const ENERGY_5MIN_UNPAGED_ROW_CAP = 50000; // safety cap for the non-paged fallback path
const REMOTE_BRIDGE_INTERVAL_MS = 1200;
const REMOTE_BRIDGE_MAX_BACKOFF_MS = 30000; // max retry interval after consecutive live failures
const REMOTE_ENERGY_POLL_INTERVAL_MS = 30000; // today-energy endpoint is rate-limited to 30 s
const REMOTE_DB_MIN_PERSIST_MS = 1000;
const REMOTE_DB_PAC_DELTA_PERSIST_W = 250;
const REMOTE_FETCH_TIMEOUT_MS = 5000;
const REMOTE_CHAT_POLL_INTERVAL_MS = 5000;
const REMOTE_CHAT_POLL_LIMIT = 50;
const REMOTE_LIVE_FETCH_RETRIES = 2;
const REMOTE_LIVE_FETCH_RETRY_BASE_MS = 350;
const REMOTE_LIVE_FAILURES_BEFORE_OFFLINE = 4;
const REMOTE_LIVE_FAILURES_BEFORE_OFFLINE_DURING_SYNC = 8;
const REMOTE_LIVE_DEGRADED_GRACE_MS = 45000;
const REMOTE_LIVE_STALE_RETENTION_MS = 120000;
const REMOTE_REPLICATION_TIMEOUT_MS = 300000;
const REMOTE_REPLICATION_RETRY_MS = 30000;
const REMOTE_INCREMENTAL_INTERVAL_MS = 3000;
const REMOTE_INCREMENTAL_APPEND_LIMIT = 25000;
const REMOTE_PUSH_DELTA_LIMIT = 50000;
const REMOTE_PUSH_CHUNK_MAX_ROWS = 6000;
const REMOTE_PUSH_CHUNK_TARGET_BYTES = 4 * 1024 * 1024;
const REMOTE_PUSH_FETCH_RETRIES = 3;
const REMOTE_PUSH_FETCH_RETRY_BASE_MS = 1200;
const REMOTE_INCREMENTAL_STARTUP_MAX_BATCHES = 200;
const REMOTE_INCREMENTAL_MANUAL_MAX_BATCHES = 200;
const REMOTE_INCREMENTAL_CATCHUP_PASSES = 8;
const REMOTE_INCREMENTAL_REQUEST_TIMEOUT_MS = 90000;
const REMOTE_INCREMENTAL_FETCH_RETRIES = 3;
const REMOTE_INCREMENTAL_FETCH_RETRY_BASE_MS = 1200;
const CHAT_THREAD_LIMIT = 20;
const CHAT_RETENTION_COUNT = 500;
const CHAT_MESSAGE_MAX_LEN = 500;
const CHAT_PROXY_TIMEOUT_MS = 8000;
const REMOTE_ARCHIVE_TRANSFER_CONCURRENCY = 2;
const REPLICATION_TRANSFER_STREAM_HWM = 512 * 1024;
const REPLICATION_JSON_GZIP_MIN_BYTES = 96 * 1024;
const REPLICATION_STREAM_GZIP_MIN_BYTES = 256 * 1024;
const REMOTE_FETCH_KEEPALIVE_MSECS = 8000;
const REMOTE_FETCH_MAX_SOCKETS = 8;
const LIVE_FRESH_MS = 20000;
const REMOTE_CLIENT_PULL_ONLY = false;
const REMOTE_TODAY_SHADOW_SETTING_KEY = "remoteTodayEnergyShadow";
const REMOTE_GATEWAY_HANDOFF_SETTING_KEY = "remoteGatewayHandoffMeta";
const MAX_SHADOW_AGE_MS = CORE_MAX_SHADOW_AGE_MS; // 4h stale same-day shadow protection
const MAX_HANDOFF_ACTIVE_MS = 4 * 60 * 60 * 1000; // 4h hard cap for active handoff
const REMOTE_REPLICATION_PRESERVE_SETTING_KEYS = new Set([
  "operationMode",
  "remoteAutoSync",
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
const REMOTE_MAIN_DB_PRESERVE_SETTING_KEYS = new Set([
  "operationMode",
  "remoteAutoSync",
  "remoteGatewayUrl",
  "remoteApiToken",
  "tailscaleDeviceHint",
  "wireguardInterface",
  "csvSavePath",
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
      "availability_pct",
      "performance_pct",
      "node_uptime_s",
      "expected_node_uptime_s",
      "expected_nodes",
      "rated_kw",
      "updated_ts",
    ],
  },
  {
    name: "daily_readings_summary",
    orderBy: "date ASC, inverter ASC, unit ASC",
    columns: [
      "date",
      "inverter",
      "unit",
      "sample_count",
      "online_samples",
      "pac_online_sum",
      "pac_online_count",
      "pac_peak",
      "first_ts",
      "last_ts",
      "first_kwh",
      "last_kwh",
      "last_online",
      "intervals_json",
      "updated_ts",
    ],
  },
  {
    name: "forecast_dayahead",
    orderBy: "date ASC, slot ASC",
    columns: ["date", "ts", "slot", "time_hms", "kwh_inc", "kwh_lo", "kwh_hi", "source", "updated_ts"],
  },
  {
    name: "forecast_intraday_adjusted",
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
  daily_readings_summary: {
    mode: "updated",
    cursorColumn: "updated_ts",
    orderBy: "updated_ts ASC, date ASC, inverter ASC, unit ASC",
    limit: 0,
  },
  forecast_dayahead: {
    mode: "updated",
    cursorColumn: "updated_ts",
    orderBy: "updated_ts ASC, date ASC, slot ASC",
    limit: 0,
  },
  forecast_intraday_adjusted: {
    mode: "updated",
    cursorColumn: "updated_ts",
    orderBy: "updated_ts ASC, date ASC, slot ASC",
    limit: 0,
  },
  settings: { mode: "updated", cursorColumn: "updated_ts", orderBy: "updated_ts ASC, key ASC", limit: 0 },
};

let remoteBridgeTimer = null;
let remoteChatPollTimer = null;
const remoteBridgeState = {
  running: false,
  connected: false,
  lastAttemptTs: 0,
  lastSuccessTs: 0,
  liveFailureCount: 0,
  lastFailureTs: 0,
  lastError: "",
  lastReasonCode: "",
  lastReasonClass: "",
  lastLatencyMs: 0,
  lastLiveNodeCount: 0,
  liveData: {},
  totals: {},
  todayEnergyRows: [],   // gateway /api/energy/today rows, piggybacked from bridge tick
  lastTodayEnergyFetchTs: 0, // ts of last successful today-energy fetch (rate-limited)
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
  lastHealthBroadcastKey: "",
};
const remoteBridgePersistState = Object.create(null); // per-node persisted hot-data cadence
const remoteBridgeEnergyMirrorState = Object.create(null); // per-inverter 5-min bucket mirror
const remoteChatBridgeState = {
  running: false,
  lastInboundId: 0,
  primed: false,
  lastError: "",
  lastWarnTs: 0,
};
const remoteTodayEnergyShadow = {
  day: "",
  rows: [],
  syncedAt: 0,
};
const remoteBridgeAlarmState = Object.create(null);
const gatewayTodayCarryState = {
  day: "",
  byInv: Object.create(null), // inverter -> { shadowBaseKwh, anchorPollerKwh }
};
// Handoff lifecycle: tracks an active Remoteâ†’Gateway transition so the stale-shadow
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
function createManualReplicationJobState() {
  return {
    id: "",
    action: "idle",
    status: "idle",
    running: false,
    includeArchive: true,
    startedAt: 0,
    updatedAt: 0,
    finishedAt: 0,
    error: "",
    errorCode: "",
    summary: "",
    needsRestart: false,
    result: null,
  };
}
const manualReplicationJobState = createManualReplicationJobState();
let cpuSampleTs = Date.now();
let cpuSampleUsage = process.cpuUsage();

// â”€â”€â”€ Cloud Backup â€” Service Initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

const OAUTH_REDIRECT_BASE = `http://localhost:${PORT}/oauth/callback`;

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

function broadcastRemoteOfflineLiveState() {
  remoteBridgeState.liveData = {};
  remoteBridgeState.totals = { pac: 0, kwh: 0 };
  remoteBridgeState.lastLiveNodeCount = 0;
  broadcastUpdate({
    type: "live",
    data: remoteBridgeState.liveData,
    totals: remoteBridgeState.totals,
    remoteHealth: buildRemoteHealthSnapshot(),
  });
}

function countRemoteLiveNodes(data = remoteBridgeState.liveData) {
  if (!data || typeof data !== "object") return 0;
  return Object.values(data).filter((row) => row && typeof row === "object").length;
}

function getRemoteSnapshotAgeMs(nowTs = Date.now()) {
  const lastSuccessTs = Number(remoteBridgeState.lastSuccessTs || 0);
  if (!lastSuccessTs) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowTs - lastSuccessTs);
}

function hasUsableRemoteLiveSnapshot(nowTs = Date.now()) {
  return (
    countRemoteLiveNodes(remoteBridgeState.liveData) > 0 &&
    getRemoteSnapshotAgeMs(nowTs) <= REMOTE_LIVE_STALE_RETENTION_MS
  );
}

function classifyRemoteBridgeFailure(err) {
  const status = Number(err?.httpStatus || 0);
  if (status === 401) {
    return {
      reasonCode: "HTTP_401",
      reasonClass: "auth-error",
      reasonText: "Gateway rejected the remote API token (401 Unauthorized).",
    };
  }
  if (status === 403) {
    return {
      reasonCode: "HTTP_403",
      reasonClass: "auth-error",
      reasonText: "Gateway rejected the remote API token (403 Forbidden).",
    };
  }
  if (status === 400) {
    return {
      reasonCode: "HTTP_400",
      reasonClass: "config-error",
      reasonText: "Gateway rejected the live request due to invalid remote settings.",
    };
  }
  if (status === 404) {
    return {
      reasonCode: "HTTP_404",
      reasonClass: "disconnected",
      reasonText: "Gateway live endpoint was not found (404).",
    };
  }
  if (status > 0) {
    return {
      reasonCode: `HTTP_${status}`,
      reasonClass: "disconnected",
      reasonText: `Gateway live request failed with HTTP ${status}.`,
    };
  }

  const code = String(err?.code || err?.type || "")
    .trim()
    .toUpperCase();
  const msg = String(err?.message || err || "")
    .trim()
    .toLowerCase();

  if (msg.includes("remote gateway url is not configured")) {
    return {
      reasonCode: "MISSING_URL",
      reasonClass: "config-error",
      reasonText: "Remote gateway URL is not configured.",
    };
  }
  if (msg.includes("cannot be localhost in remote mode")) {
    return {
      reasonCode: "LOOPBACK_URL",
      reasonClass: "config-error",
      reasonText: "Remote gateway URL cannot be localhost in Remote mode.",
    };
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    msg.includes("network timeout") ||
    msg.includes("timed out")
  ) {
    return {
      reasonCode: "TIMEOUT",
      reasonClass: "disconnected",
      reasonText: "Gateway live request timed out.",
    };
  }
  if (code === "ECONNREFUSED" || msg.includes("econnrefused")) {
    return {
      reasonCode: "ECONNREFUSED",
      reasonClass: "disconnected",
      reasonText: "Gateway connection was refused.",
    };
  }
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    msg.includes("enotfound") ||
    msg.includes("getaddrinfo")
  ) {
    return {
      reasonCode: "DNS_FAILURE",
      reasonClass: "disconnected",
      reasonText: "Gateway host could not be resolved.",
    };
  }
  if (
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    msg.includes("host unreachable") ||
    msg.includes("network unreachable")
  ) {
    return {
      reasonCode: "NETWORK_UNREACHABLE",
      reasonClass: "disconnected",
      reasonText: "Gateway route is unreachable.",
    };
  }
  if (
    code === "ECONNRESET" ||
    code === "UND_ERR_SOCKET" ||
    msg.includes("socket hang up") ||
    msg.includes("read econnreset")
  ) {
    return {
      reasonCode: "SOCKET_RESET",
      reasonClass: "disconnected",
      reasonText: "Gateway connection was reset during the live request.",
    };
  }
  if (
    code === "BAD_JSON" ||
    msg.includes("invalid live json") ||
    msg.includes("unexpected token")
  ) {
    return {
      reasonCode: "BAD_PAYLOAD",
      reasonClass: "disconnected",
      reasonText: "Gateway returned an invalid live payload.",
    };
  }
  return {
    reasonCode: code || "LIVE_FETCH_FAILED",
    reasonClass: "disconnected",
    reasonText: String(err?.message || err || "Gateway live request failed."),
  };
}

function getRemoteBridgeNextDelayMs(nowTs = Date.now()) {
  const failures = Math.max(0, Number(remoteBridgeState.liveFailureCount || 0));
  const fastRetry = Boolean(remoteBridgeState.connected) || hasRecentRemoteBridgeSuccess(nowTs);
  if (fastRetry || failures <= 1) return REMOTE_BRIDGE_INTERVAL_MS;
  return Math.min(
    REMOTE_BRIDGE_MAX_BACKOFF_MS,
    REMOTE_BRIDGE_INTERVAL_MS * Math.pow(2, failures - 1),
  );
}

function buildRemoteHealthSnapshot(nowTs = Date.now()) {
  const mode = readOperationMode();
  const lastSuccessTs = Number(remoteBridgeState.lastSuccessTs || 0);
  const lastFailureTs = Number(remoteBridgeState.lastFailureTs || 0);
  const liveFreshMs = lastSuccessTs
    ? Math.max(0, nowTs - lastSuccessTs)
    : Number.POSITIVE_INFINITY;
  const hasSnapshot = hasUsableRemoteLiveSnapshot(nowTs);
  const reasonCode = String(remoteBridgeState.lastReasonCode || "").trim();
  const reasonClass = String(remoteBridgeState.lastReasonClass || "").trim();
  let reasonText = String(remoteBridgeState.lastError || "").trim();
  let state = "disconnected";
  let effectiveReasonCode = reasonCode;

  if (mode !== "remote") {
    state = "gateway-local";
    effectiveReasonCode = "";
    reasonText = "";
  } else if (reasonClass === "config-error") {
    state = "config-error";
  } else if (reasonClass === "auth-error") {
    state = "auth-error";
  } else if (
    Boolean(remoteBridgeState.connected) &&
    Math.max(0, Number(remoteBridgeState.liveFailureCount || 0)) <= 0
  ) {
    state = "connected";
  } else if (hasSnapshot && liveFreshMs <= REMOTE_LIVE_DEGRADED_GRACE_MS) {
    state = "degraded";
  } else if (hasSnapshot) {
    state = "stale";
  } else {
    state = "disconnected";
  }

  return {
    mode,
    state,
    reasonCode: effectiveReasonCode,
    reasonText,
    hasUsableSnapshot: hasSnapshot,
    snapshotRetainMs: REMOTE_LIVE_STALE_RETENTION_MS,
    liveFreshMs: Number.isFinite(liveFreshMs) ? liveFreshMs : null,
    lastAttemptTs: Number(remoteBridgeState.lastAttemptTs || 0),
    lastSuccessTs,
    lastFailureTs,
    failureStreak: Math.max(0, Number(remoteBridgeState.liveFailureCount || 0)),
    backoffMs:
      mode === "remote" && remoteBridgeState.running
        ? getRemoteBridgeNextDelayMs(nowTs)
        : 0,
    lastLatencyMs: Math.max(0, Number(remoteBridgeState.lastLatencyMs || 0)),
    liveNodeCount:
      hasSnapshot || Boolean(remoteBridgeState.connected)
        ? Math.max(
            0,
            Number(remoteBridgeState.lastLiveNodeCount || countRemoteLiveNodes()),
          )
        : 0,
  };
}

function broadcastRemoteHealthUpdate(force = false) {
  const health = buildRemoteHealthSnapshot();
  const key = JSON.stringify([
    health.state,
    health.reasonCode,
    health.hasUsableSnapshot,
    health.failureStreak,
    health.lastSuccessTs,
    health.lastFailureTs,
    health.liveNodeCount,
  ]);
  if (!force && remoteBridgeState.lastHealthBroadcastKey === key) return;
  remoteBridgeState.lastHealthBroadcastKey = key;
  broadcastUpdate({ type: "remote_health", health });
}

function shouldProxyApiPath(pathname) {
  const p = String(pathname || "");
  if (p === "/backup" || p.startsWith("/backup/")) return false;
  if (p === "/chat" || p.startsWith("/chat/")) return false;
  if (p === "/forecast/solcast" || p.startsWith("/forecast/solcast/")) return false;
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

function normalizeChatMachine(value, def = "gateway") {
  const v = String(value || def)
    .trim()
    .toLowerCase();
  return v === "remote" ? "remote" : "gateway";
}

function getOppositeChatMachine(machine) {
  return normalizeChatMachine(machine, "gateway") === "remote"
    ? "gateway"
    : "remote";
}

function getChatModeLabel(machine) {
  return normalizeChatMachine(machine, "gateway") === "remote"
    ? "Remote"
    : "Server";
}

function buildChatDisplayName(machine, operatorName) {
  const operator = String(operatorName || "").trim() || "OPERATOR";
  return `${operator} - ${getChatModeLabel(machine)}`.slice(0, 160);
}

function buildLocalChatIdentity(machineOverride = "") {
  const fromMachine = normalizeChatMachine(machineOverride || readOperationMode(), "gateway");
  return {
    from_machine: fromMachine,
    to_machine: getOppositeChatMachine(fromMachine),
    from_name: buildChatDisplayName(
      fromMachine,
      getSetting("operatorName", "OPERATOR"),
    ),
  };
}

function sanitizeChatMessageText(raw) {
  const normalized = String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (!normalized) {
    const err = new Error("Message cannot be empty.");
    err.httpStatus = 400;
    throw err;
  }
  if (normalized.length > CHAT_MESSAGE_MAX_LEN) {
    const err = new Error(`Message must be ${CHAT_MESSAGE_MAX_LEN} characters or fewer.`);
    err.httpStatus = 400;
    throw err;
  }
  return normalized;
}

function normalizeChatRow(row) {
  if (!row || typeof row !== "object") return null;
  const id = Math.max(0, Math.trunc(Number(row.id || 0)));
  if (!id) return null;
  const fromMachine = normalizeChatMachine(row.from_machine, "gateway");
  const toMachine = normalizeChatMachine(
    row.to_machine,
    getOppositeChatMachine(fromMachine),
  );
  return {
    id,
    ts: Math.max(0, Math.trunc(Number(row.ts || 0))),
    from_machine: fromMachine,
    to_machine: toMachine,
    from_name: String(row.from_name || "").trim().slice(0, 160),
    message: String(row.message || ""),
    read_ts:
      row.read_ts == null || row.read_ts === ""
        ? null
        : Math.max(0, Math.trunc(Number(row.read_ts || 0))),
  };
}

function normalizeChatRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeChatRow)
    .filter(Boolean);
}

function getNewestChatIdForMachine(rows, machine) {
  const targetMachine = normalizeChatMachine(machine, "gateway");
  let maxId = 0;
  for (const row of normalizeChatRows(rows)) {
    if (row.to_machine !== targetMachine) continue;
    if (row.id > maxId) maxId = row.id;
  }
  return maxId;
}

function updateRemoteChatCursorFromRows(rows, machine = "remote") {
  const maxId = getNewestChatIdForMachine(rows, machine);
  if (maxId > Number(remoteChatBridgeState.lastInboundId || 0)) {
    remoteChatBridgeState.lastInboundId = maxId;
  }
  return remoteChatBridgeState.lastInboundId;
}

function getRuntimeLiveData() {
  return isRemoteMode() ? remoteBridgeState.liveData || {} : poller.getLiveData();
}

function resetRemoteBridgeAlarmState() {
  for (const key of Object.keys(remoteBridgeAlarmState)) {
    delete remoteBridgeAlarmState[key];
  }
}

function syncRemoteBridgeAlarmTransitions(nextLiveData) {
  const rows = nextLiveData && typeof nextLiveData === "object" ? nextLiveData : {};
  const nextState = Object.create(null);
  const raised = [];

  for (const [key, row] of Object.entries(rows)) {
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!inverter || !unit) continue;

    const alarmValue = Number(row?.alarm || 0);
    nextState[key] = alarmValue;

    const prevAlarmValue = Number(remoteBridgeAlarmState[key] || 0);
    if (!alarmValue || alarmValue === prevAlarmValue) continue;

    raised.push({
      inverter,
      unit,
      alarm_value: alarmValue,
      severity: getTopSeverity(alarmValue) || "fault",
      decoded: decodeAlarm(alarmValue),
      alarm_hex: formatAlarmHex(alarmValue),
    });
  }

  resetRemoteBridgeAlarmState();
  for (const [key, value] of Object.entries(nextState)) {
    remoteBridgeAlarmState[key] = value;
  }

  if (raised.length) {
    broadcastUpdate({ type: "alarm", alarms: raised });
  }
}

function clearRemoteBridgePersistState() {
  for (const key of Object.keys(remoteBridgePersistState)) {
    delete remoteBridgePersistState[key];
  }
  for (const key of Object.keys(remoteBridgeEnergyMirrorState)) {
    delete remoteBridgeEnergyMirrorState[key];
  }
}

function floorToFiveMinute(ts) {
  const fiveMinMs = 5 * 60 * 1000;
  return Math.floor(Number(ts || 0) / fiveMinMs) * fiveMinMs;
}

function isSolarWindowNow(ts = Date.now()) {
  const d = new Date(Number(ts || Date.now()));
  const hour = d.getHours();
  return hour >= SOLCAST_SOLAR_START_H && hour < SOLCAST_SOLAR_END_H;
}

function normalizeRemoteLiveReading(row, fallbackTs = Date.now()) {
  const inverter = Math.trunc(Number(row?.inverter || 0));
  const unit = Math.trunc(Number(row?.unit || 0));
  if (!(inverter > 0) || !(unit > 0)) return null;
  const ts = Math.max(0, Number(row?.ts || fallbackTs) || fallbackTs);
  return {
    ts,
    inverter,
    unit,
    pac: Math.max(0, Number(row?.pac || 0)),
    kwh: Math.max(0, Number(row?.kwh || 0)),
    alarm: Math.max(0, Number(row?.alarm || 0)),
    on_off: Number(row?.on_off ?? row?.onOff ?? 0) === 1 ? 1 : 0,
    online: Number(row?.online ?? 1) === 1 ? 1 : 0,
  };
}

function persistRemoteLiveRows(nextLiveData, syncedAt = Date.now()) {
  if (!isRemoteMode()) return;
  const rows = nextLiveData && typeof nextLiveData === "object" ? nextLiveData : {};
  const batch = [];
  const alarmBatch = [];

  for (const [key, rawRow] of Object.entries(rows)) {
    const parsed = normalizeRemoteLiveReading(rawRow, syncedAt);
    if (!parsed) continue;
    const prev = remoteBridgePersistState[key];
    const forcePersist =
      !prev ||
      Number(parsed.alarm || 0) !== Number(prev.alarm || 0) ||
      Number(parsed.on_off || 0) !== Number(prev.on_off || 0) ||
      Number(parsed.online || 0) !== Number(prev.online || 0);
    const elapsedMs = !prev
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, Number(parsed.ts || 0) - Number(prev.ts || 0));
    const pacDelta = !prev
      ? Number.MAX_SAFE_INTEGER
      : Math.abs(Number(parsed.pac || 0) - Number(prev.pac || 0));
    const shouldPersist =
      forcePersist ||
      (isSolarWindowNow(parsed.ts) &&
        (elapsedMs >= REMOTE_DB_MIN_PERSIST_MS ||
          pacDelta >= REMOTE_DB_PAC_DELTA_PERSIST_W));

    if (!prev || Number(parsed.ts || 0) >= Number(prev.ts || 0)) {
      remoteBridgePersistState[key] = {
        ts: Number(parsed.ts || 0),
        pac: Number(parsed.pac || 0),
        alarm: Number(parsed.alarm || 0),
        on_off: Number(parsed.on_off || 0),
        online: Number(parsed.online || 0),
      };
    }

    if (!shouldPersist) continue;
    batch.push({
      ts: Number(parsed.ts || 0),
      inverter: Number(parsed.inverter || 0),
      unit: Number(parsed.unit || 0),
      pac: Number(parsed.pac || 0),
      kwh: Number(parsed.kwh || 0),
      alarm: Number(parsed.alarm || 0),
      online: Number(parsed.online || 0) === 1 ? 1 : 0,
    });
    alarmBatch.push(parsed);
  }

  if (batch.length) {
    bulkInsert(batch);
    ingestDailyReadingsSummary(batch);
  }
  if (alarmBatch.length) {
    checkAlarms(alarmBatch);
  }
}

function mirrorRemoteTodayEnergyRowsToLocal(rowsRaw, syncedAt = Date.now()) {
  if (!isRemoteMode()) return;
  const rows = normalizeTodayEnergyRows(rowsRaw);
  if (!rows.length) return;
  const day = localDateStr(syncedAt);
  const bucketStart = floorToFiveMinute(syncedAt);

  for (const row of rows) {
    const inverter = Number(row?.inverter || 0);
    const totalKwh = Math.max(0, Number(row?.total_kwh || 0));
    if (!(inverter > 0)) continue;
    const key = String(inverter);
    const prev = remoteBridgeEnergyMirrorState[key];
    if (!prev || String(prev.day || "") !== day || totalKwh < Number(prev.totalKwh || 0)) {
      remoteBridgeEnergyMirrorState[key] = { day, bucketStart, totalKwh };
      continue;
    }
    if (bucketStart <= Number(prev.bucketStart || 0)) continue;
    const inc = Math.max(0, totalKwh - Number(prev.totalKwh || 0));
    try {
      stmts.insertEnergy5.run(bucketStart, inverter, Number(inc.toFixed(6)));
    } catch (err) {
      console.warn("[remote-energy] mirror insert failed:", err.message);
    }
    remoteBridgeEnergyMirrorState[key] = { day, bucketStart, totalKwh };
  }
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
      health: buildRemoteHealthSnapshot(),
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

function sanitizeArchiveFileName(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const fileName = raw.toLowerCase().endsWith(".db") ? raw : `${raw}.db`;
  return /^\d{4}-\d{2}\.db$/i.test(fileName) ? fileName : "";
}

function monthKeyFromArchiveFileName(fileName) {
  const safe = sanitizeArchiveFileName(fileName);
  return safe ? safe.slice(0, 7) : "";
}

function readPendingArchiveReplacements() {
  try {
    if (!fs.existsSync(ARCHIVE_PENDING_REPLACEMENTS_PATH)) return [];
    const parsed = JSON.parse(
      fs.readFileSync(ARCHIVE_PENDING_REPLACEMENTS_PATH, "utf8"),
    );
    if (!Array.isArray(parsed)) return [];
    const deduped = new Map();
    for (const entry of parsed) {
      const name = sanitizeArchiveFileName(entry?.name || "");
      const monthKey = monthKeyFromArchiveFileName(name);
      const tempName = path.basename(String(entry?.tempName || "").trim());
      if (!name || !monthKey || !tempName) continue;
      deduped.set(name, {
        name,
        monthKey,
        tempName,
        size: Math.max(0, Number(entry?.size || 0)),
        mtimeMs: Math.max(0, Number(entry?.mtimeMs || 0)),
        stagedAt: Math.max(0, Number(entry?.stagedAt || 0)),
      });
    }
    return Array.from(deduped.values()).sort((a, b) =>
      String(a?.name || "").localeCompare(String(b?.name || "")),
    );
  } catch (_) {
    return [];
  }
}

function writePendingArchiveReplacements(entriesRaw) {
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
  if (!entries.length) {
    try {
      fs.unlinkSync(ARCHIVE_PENDING_REPLACEMENTS_PATH);
    } catch (_) {
      // Ignore missing manifest cleanup failures.
    }
    return;
  }
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const tempPath = `${ARCHIVE_PENDING_REPLACEMENTS_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2));
  fs.renameSync(tempPath, ARCHIVE_PENDING_REPLACEMENTS_PATH);
}

function stagePendingArchiveReplacement({
  name,
  monthKey,
  tempName,
  size = 0,
  mtimeMs = 0,
}) {
  const safeName = sanitizeArchiveFileName(name || "");
  const safeMonthKey = monthKeyFromArchiveFileName(
    safeName || `${String(monthKey || "").trim()}.db`,
  );
  const safeTempName = path.basename(String(tempName || "").trim());
  if (!safeName || !safeMonthKey || !safeTempName) {
    throw new Error("Invalid staged archive replacement payload.");
  }
  const nextEntries = [];
  for (const entry of readPendingArchiveReplacements()) {
    if (String(entry?.name || "") !== safeName) {
      nextEntries.push(entry);
      continue;
    }
    const oldTempName = path.basename(String(entry?.tempName || "").trim());
    if (oldTempName && oldTempName !== safeTempName && /\.tmp$/i.test(oldTempName)) {
      try {
        fs.unlinkSync(path.join(ARCHIVE_DIR, oldTempName));
      } catch (_) {
        // Ignore stale temp cleanup failures.
      }
    }
  }
  const staged = {
    name: safeName,
    monthKey: safeMonthKey,
    tempName: safeTempName,
    size: Math.max(0, Number(size || 0)),
    mtimeMs: Math.max(0, Number(mtimeMs || 0)),
    stagedAt: Date.now(),
  };
  nextEntries.push(staged);
  writePendingArchiveReplacements(nextEntries);
  return staged;
}

function getPendingArchiveReplacement(name) {
  const safeName = sanitizeArchiveFileName(name || "");
  if (!safeName) return null;
  return (
    readPendingArchiveReplacements().find(
      (entry) => String(entry?.name || "") === safeName,
    ) || null
  );
}

function resolveArchiveFileForTransfer(fileName) {
  const safeName = sanitizeArchiveFileName(fileName || "");
  if (!safeName) return null;
  const pending = getPendingArchiveReplacement(safeName);
  if (pending?.tempName) {
    const tempPath = path.join(ARCHIVE_DIR, pending.tempName);
    if (fs.existsSync(tempPath)) {
      const stat = fs.statSync(tempPath);
      return {
        path: tempPath,
        size: Math.max(0, Number(stat.size || pending?.size || 0)),
        mtimeMs: Math.max(0, Number(pending?.mtimeMs || stat.mtimeMs || 0)),
        pendingApply: true,
      };
    }
  }
  const finalPath = path.join(ARCHIVE_DIR, safeName);
  const stat = fs.statSync(finalPath);
  return {
    path: finalPath,
    size: Math.max(0, Number(stat.size || 0)),
    mtimeMs: Math.max(0, Number(stat.mtimeMs || 0)),
    pendingApply: false,
  };
}

function applyPendingArchiveReplacementsSync() {
  const pendingEntries = readPendingArchiveReplacements();
  if (!pendingEntries.length) return { applied: 0, failed: 0, pending: 0 };
  let applied = 0;
  let failed = 0;
  const remaining = [];
  for (const entry of pendingEntries) {
    const name = sanitizeArchiveFileName(entry?.name || "");
    const monthKey = monthKeyFromArchiveFileName(name);
    const tempName = path.basename(String(entry?.tempName || "").trim());
    const tempPath = path.join(ARCHIVE_DIR, tempName);
    const finalPath = path.join(ARCHIVE_DIR, name);
    if (!name || !monthKey || !tempName) continue;
    if (!fs.existsSync(tempPath)) continue;
    beginArchiveDbReplacement(monthKey);
    try {
      validateSqliteFileSync(tempPath);
      try {
        fs.unlinkSync(finalPath);
      } catch (_) {
        // Ignore missing prior archive file.
      }
      fs.renameSync(tempPath, finalPath);
      const targetMtimeMs = Math.max(0, Number(entry?.mtimeMs || 0));
      if (targetMtimeMs > 0) {
        const mtime = new Date(targetMtimeMs);
        fs.utimesSync(finalPath, mtime, mtime);
      }
      applied += 1;
    } catch (err) {
      failed += 1;
      remaining.push(entry);
      console.warn(
        `[archive] pending replacement apply failed for ${name}:`,
        err?.message || err,
      );
    } finally {
      endArchiveDbReplacement(monthKey);
    }
  }
  writePendingArchiveReplacements(remaining);
  return { applied, failed, pending: remaining.length };
}

function listLocalArchiveManifest() {
  const manifestMap = new Map();
  try {
    const names = fs
      .readdirSync(ARCHIVE_DIR, { withFileTypes: true })
      .filter((entry) => entry?.isFile?.())
      .map((entry) => String(entry.name || ""))
      .filter((name) => Boolean(sanitizeArchiveFileName(name)))
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const filePath = path.join(ARCHIVE_DIR, name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const stat = fs.statSync(filePath);
        size = Math.max(0, Number(stat.size || 0));
        mtimeMs = Math.max(0, Number(stat.mtimeMs || 0));
      } catch (_) {
        size = 0;
        mtimeMs = 0;
      }
      manifestMap.set(name, {
        name,
        monthKey: monthKeyFromArchiveFileName(name),
        size,
        mtimeMs,
      });
    }
  } catch (_) {
    // Ignore manifest read failures and fall back to any staged replacements.
  }
  for (const pending of readPendingArchiveReplacements()) {
    const name = sanitizeArchiveFileName(pending?.name || "");
    if (!name) continue;
    manifestMap.set(name, {
      name,
      monthKey: monthKeyFromArchiveFileName(name),
      size: Math.max(0, Number(pending?.size || 0)),
      mtimeMs: Math.max(0, Number(pending?.mtimeMs || 0)),
      pendingApply: true,
    });
  }
  return Array.from(manifestMap.values()).sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || "")),
  );
}

function summarizeArchiveManifest(manifestRaw) {
  const manifest = Array.isArray(manifestRaw) ? manifestRaw : [];
  const fileCount = manifest.length;
  const totalBytes = manifest.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry?.size || 0)),
    0,
  );
  const newestMtimeMs = manifest.reduce(
    (max, entry) => Math.max(max, Math.max(0, Number(entry?.mtimeMs || 0))),
    0,
  );
  return {
    fileCount,
    totalBytes,
    newestMtimeMs,
    files: manifest,
  };
}

function buildManualReplicationScope() {
  const archiveSummary = summarizeArchiveManifest(listLocalArchiveManifest());
  return {
    background: true,
    includeArchiveOptional: true,
    defaultIncludeArchive: false,
    hotTables: ["adsi.db (main database snapshot)"],
    preservedSettings: Array.from(REMOTE_MAIN_DB_PRESERVE_SETTING_KEYS),
    archive: {
      ...archiveSummary,
      optional: true,
    },
    notes: {
      transport: "Manual sync uses the configured remote gateway URL over Tailscale/reachable network path.",
      push:
        "Push sends the local hot table delta first, then returns to the gateway as source of truth and stages the latest gateway main DB back to this machine.",
      pull:
        "Pull downloads a fresh gateway main DB snapshot and stages it for restart-safe local replacement. Optional monthly archive DB files can follow.",
      liveBridge:
        "Live bridge polling stays lightweight. Archive transfer is manual-only and does not run on the automatic live sync loop.",
      hotPriority:
        "The gateway main DB snapshot is always staged first. Archive DB files are optional and intended for historical catch-up only.",
    },
  };
}

function snapshotManualReplicationJob() {
  return {
    id: String(manualReplicationJobState.id || ""),
    action: String(manualReplicationJobState.action || "idle"),
    status: String(manualReplicationJobState.status || "idle"),
    running: Boolean(manualReplicationJobState.running),
    includeArchive: Boolean(manualReplicationJobState.includeArchive),
    startedAt: Number(manualReplicationJobState.startedAt || 0),
    updatedAt: Number(manualReplicationJobState.updatedAt || 0),
    finishedAt: Number(manualReplicationJobState.finishedAt || 0),
    error: String(manualReplicationJobState.error || ""),
    errorCode: String(manualReplicationJobState.errorCode || ""),
    summary: String(manualReplicationJobState.summary || ""),
    needsRestart: Boolean(manualReplicationJobState.needsRestart),
    result:
      manualReplicationJobState.result &&
      typeof manualReplicationJobState.result === "object"
        ? { ...manualReplicationJobState.result }
        : null,
  };
}

function updateManualReplicationJob(patch = {}, options = {}) {
  Object.assign(manualReplicationJobState, patch || {});
  manualReplicationJobState.updatedAt = Date.now();
  if (options.broadcast === false) return snapshotManualReplicationJob();
  broadcastUpdate({
    type: "replication_job",
    job: snapshotManualReplicationJob(),
  });
  return snapshotManualReplicationJob();
}

function resetManualReplicationJob() {
  Object.assign(manualReplicationJobState, createManualReplicationJobState(), {
    updatedAt: Date.now(),
  });
  return snapshotManualReplicationJob();
}

function isManualReplicationJobRunning() {
  return Boolean(manualReplicationJobState.running);
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
  const totalBytes = rawChunks.reduce(
    (sum, chunk) => sum + Math.max(0, Number(chunk?.bytes || 0)),
    0,
  );
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
        totalBytes,
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

function mergeAppendReplicationRow(tableName, payload, cols, authoritative = false) {
  if (tableName === "readings") {
    if (Number(payload?.ts || 0) < getTelemetryHotCutoffTs()) {
      archiveReadingsRows([payload]);
      return true;
    }
    if (authoritative) {
      // Authoritative: overwrite existing row, insert if absent.
      const upd = stmtCached(
        "update:readings:auth",
        `UPDATE readings SET pac=@pac, kwh=@kwh, alarm=@alarm, online=@online WHERE ts=@ts AND inverter=@inverter AND unit=@unit`,
      ).run(payload);
      if (upd.changes > 0) return true;
      // No existing row — fall through to INSERT.
    } else {
      const exists = stmtCached(
        "exists:readings:ts_inv_unit",
        `SELECT id FROM readings WHERE ts=? AND inverter=? AND unit=? LIMIT 1`,
      ).get(payload.ts, payload.inverter, payload.unit);
      if (exists?.id) return false;
    }
    const colList = cols.join(", ");
    const valList = cols.map((c) => "@" + c).join(", ");
    if (authoritative) {
      stmtCached("merge:readings:auth",
        "INSERT INTO readings (" + colList + ") VALUES (" + valList + ")" +
        " ON CONFLICT(id) DO UPDATE SET" +
        " ts=excluded.ts, inverter=excluded.inverter, unit=excluded.unit," +
        " pac=excluded.pac, kwh=excluded.kwh, alarm=excluded.alarm, online=excluded.online",
      ).run(payload);
    } else {
      stmtCached("merge:readings",
        "INSERT INTO readings (" + colList + ") VALUES (" + valList + ")" +
        " ON CONFLICT(id) DO UPDATE SET" +
        " ts=excluded.ts, inverter=excluded.inverter, unit=excluded.unit," +
        " pac=excluded.pac, kwh=excluded.kwh, alarm=excluded.alarm, online=excluded.online" +
        " WHERE COALESCE(excluded.ts,0) >= COALESCE(readings.ts,0)",
      ).run(payload);
    }
    return true;
  }

  if (tableName === "energy_5min") {
    if (Number(payload?.ts || 0) < getTelemetryHotCutoffTs()) {
      archiveEnergyRows([payload]);
      return true;
    }
    if (authoritative) {
      // Authoritative: overwrite existing row, insert if absent.
      const upd = stmtCached(
        "update:energy_5min:auth",
        `UPDATE energy_5min SET kwh_inc=@kwh_inc WHERE ts=@ts AND inverter=@inverter`,
      ).run(payload);
      if (upd.changes > 0) return true;
      // No existing row — fall through to INSERT.
    } else {
      const existingRow = stmtCached(
        "exists:energy_5min:ts_inv",
        `SELECT id, kwh_inc FROM energy_5min WHERE ts=? AND inverter=? LIMIT 1`,
      ).get(payload.ts, payload.inverter);
      if (existingRow?.id) {
        // Row exists. Update kwh_inc if the incoming value differs — corrects stale local rows.
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
    }
    const colList = cols.join(", ");
    const valList = cols.map((c) => "@" + c).join(", ");
    if (authoritative) {
      stmtCached("merge:energy_5min:auth",
        "INSERT INTO energy_5min (" + colList + ") VALUES (" + valList + ")" +
        " ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, inverter=excluded.inverter, kwh_inc=excluded.kwh_inc",
      ).run(payload);
    } else {
      stmtCached("merge:energy_5min",
        "INSERT INTO energy_5min (" + colList + ") VALUES (" + valList + ")" +
        " ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, inverter=excluded.inverter, kwh_inc=excluded.kwh_inc" +
        " WHERE COALESCE(excluded.ts,0) >= COALESCE(energy_5min.ts,0)",
      ).run(payload);
    }
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

function mergeUpdatedReplicationRow(tableName, payload, cols, preserveSettings = true, authoritative = false) {
  if (tableName === "settings") {
    const k = String(payload?.key || "").trim();
    if (preserveSettings && REMOTE_REPLICATION_PRESERVE_SETTING_KEYS.has(k)) {
      return false;
    }
    // In authoritative mode the gateway value always wins; no timestamp guard.
    const sColList = cols.join(", ");
    const sValList = cols.map((c) => "@" + c).join(", ");
    const sBase = "INSERT INTO settings (" + sColList + ") VALUES (" + sValList + ")" +
      " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts";
    const sSql = authoritative ? sBase : sBase + " WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(settings.updated_ts,0)";
    stmtCached(authoritative ? "merge:settings:auth" : "merge:settings:lww", sSql).run(payload);
    return true;
  }

  if (tableName === "forecast_dayahead") {
    const fdColList = cols.join(", ");
    const fdValList = cols.map((c) => "@" + c).join(", ");
    const fdBase = "INSERT INTO forecast_dayahead (" + fdColList + ") VALUES (" + fdValList + ")" +
      " ON CONFLICT(date, slot) DO UPDATE SET" +
      " ts=excluded.ts, time_hms=excluded.time_hms," +
      " kwh_inc=excluded.kwh_inc, kwh_lo=excluded.kwh_lo, kwh_hi=excluded.kwh_hi," +
      " source=excluded.source, updated_ts=excluded.updated_ts";
    const fdSql = authoritative ? fdBase : fdBase + " WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(forecast_dayahead.updated_ts,0)";
    stmtCached(authoritative ? "merge:forecast_dayahead:auth" : "merge:forecast_dayahead:lww", fdSql).run(payload);
    return true;
  }

  if (tableName === "forecast_intraday_adjusted") {
    const fiColList = cols.join(", ");
    const fiValList = cols.map((c) => "@" + c).join(", ");
    const fiBase = "INSERT INTO forecast_intraday_adjusted (" + fiColList + ") VALUES (" + fiValList + ")" +
      " ON CONFLICT(date, slot) DO UPDATE SET" +
      " ts=excluded.ts, time_hms=excluded.time_hms," +
      " kwh_inc=excluded.kwh_inc, kwh_lo=excluded.kwh_lo, kwh_hi=excluded.kwh_hi," +
      " source=excluded.source, updated_ts=excluded.updated_ts";
    const fiSql = authoritative ? fiBase : fiBase + " WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(forecast_intraday_adjusted.updated_ts,0)";
    stmtCached(authoritative ? "merge:forecast_intraday_adjusted:auth" : "merge:forecast_intraday_adjusted:lww", fiSql).run(payload);
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
    const drColList = drCols.join(", ");
    const drValList = drCols.map((c) => "@" + c).join(", ");
    const drBase = "INSERT INTO daily_report (" + drColList + ") VALUES (" + drValList + ")" +
      " ON CONFLICT(date, inverter) DO UPDATE SET" +
      " kwh_total=excluded.kwh_total, pac_peak=excluded.pac_peak, pac_avg=excluded.pac_avg," +
      " uptime_s=excluded.uptime_s, alarm_count=excluded.alarm_count, control_count=excluded.control_count," +
      " availability_pct=excluded.availability_pct, performance_pct=excluded.performance_pct," +
      " node_uptime_s=excluded.node_uptime_s, expected_node_uptime_s=excluded.expected_node_uptime_s," +
      " expected_nodes=excluded.expected_nodes, rated_kw=excluded.rated_kw, updated_ts=excluded.updated_ts";
    const drSql = authoritative ? drBase : drBase + " WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(daily_report.updated_ts,0)";
    stmtCached(authoritative ? "merge:daily_report:auth" : "merge:daily_report:lww", drSql).run(drPayload);
    return true;
  }

  if (tableName === "daily_readings_summary") {
    const drsColList = cols.join(", ");
    const drsValList = cols.map((c) => "@" + c).join(", ");
    const drsBase = "INSERT INTO daily_readings_summary (" + drsColList + ") VALUES (" + drsValList + ")" +
      " ON CONFLICT(date, inverter, unit) DO UPDATE SET" +
      " sample_count=excluded.sample_count, online_samples=excluded.online_samples," +
      " pac_online_sum=excluded.pac_online_sum, pac_online_count=excluded.pac_online_count," +
      " pac_peak=excluded.pac_peak, first_ts=excluded.first_ts, last_ts=excluded.last_ts," +
      " first_kwh=excluded.first_kwh, last_kwh=excluded.last_kwh, last_online=excluded.last_online," +
      " intervals_json=excluded.intervals_json, updated_ts=excluded.updated_ts";
    const drsSql = authoritative ? drsBase : drsBase + " WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(daily_readings_summary.updated_ts,0)";
    stmtCached(authoritative ? "merge:daily_readings_summary:auth" : "merge:daily_readings_summary:lww", drsSql).run(payload);
    return true;
  }

  if (tableName === "alarms") {
    const alColList = cols.join(", ");
    const alValList = cols.map((c) => "@" + c).join(", ");
    const alBase = "INSERT INTO alarms (" + alColList + ") VALUES (" + alValList + ")" +
      " ON CONFLICT(id) DO UPDATE SET" +
      " ts=excluded.ts, inverter=excluded.inverter, unit=excluded.unit," +
      " alarm_code=excluded.alarm_code, alarm_value=excluded.alarm_value, severity=excluded.severity," +
      " cleared_ts=excluded.cleared_ts, acknowledged=excluded.acknowledged, updated_ts=excluded.updated_ts";
    const alSql = authoritative ? alBase : alBase + " WHERE COALESCE(excluded.updated_ts,0) >= COALESCE(alarms.updated_ts,0)";
    stmtCached(authoritative ? "merge:alarms:auth" : "merge:alarms:lww", alSql).run(payload);
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
  const authoritative = Boolean(options?.authoritative);
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
            ? mergeAppendReplicationRow(def.name, payload, def.columns, authoritative)
            : mergeUpdatedReplicationRow(
                def.name,
                payload,
                def.columns,
                preserveSettings,
                authoritative,
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

function capturePreservedMainDbSettings() {
  const keys = Array.from(REMOTE_MAIN_DB_PRESERVE_SETTING_KEYS);
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

function clearReplicatedTablesForFullReplace(preserveSettings = true) {
  for (const def of REPLICATION_TABLE_DEFS) {
    if (def.name === "settings" && preserveSettings) {
      const keys = Array.from(REMOTE_REPLICATION_PRESERVE_SETTING_KEYS);
      if (!keys.length) {
        db.prepare("DELETE FROM settings").run();
        continue;
      }
      const placeholders = keys.map(() => "?").join(", ");
      db.prepare(`DELETE FROM settings WHERE key NOT IN (${placeholders})`).run(...keys);
      continue;
    }
    db.prepare(`DELETE FROM ${def.name}`).run();
  }
}

function applyFullDbSnapshot(snapshot, opts = {}) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : null;
  if (!snap || typeof snap !== "object") throw new Error("Invalid replication snapshot payload.");
  const tables = snap.tables && typeof snap.tables === "object" ? snap.tables : null;
  if (!tables) throw new Error("Invalid replication snapshot tables.");

  const preserveRows = capturePreservedLocalSettings();
  const replace = Boolean(opts?.replace);
  const authoritative = Boolean(opts?.authoritative);
  const importTx = db.transaction(() => {
    if (replace) {
      clearReplicatedTablesForFullReplace(true);
    }
    const merged = applyReplicationTableMerge(tables, {
      preserveSettings: true,
      inTransaction: true,
      authoritative,
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

function applyIncrementalDbDelta(deltaPayload, opts = {}) {
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
      authoritative: Boolean(opts?.authoritative),
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

async function checkLocalNewerBeforePull(baseUrl) {
  remoteBridgeState.lastReconcileError = "";
  remoteBridgeState.lastReconcileRows = 0;
  try {
    const summaryRes = await fetchWithRetry(
      `${baseUrl}/api/replication/summary`,
      {
        method: "GET",
        headers: buildRemoteProxyHeaders(),
        timeout: REMOTE_REPLICATION_TIMEOUT_MS,
      },
      {
        attempts: REMOTE_LIVE_FETCH_RETRIES,
        baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
      },
    );
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
    remoteBridgeState.lastReconcileTs = Date.now();
    remoteBridgeState.lastReconcileError = "";
    if (localNewer) {
      remoteBridgeState.lastSyncDirection = "pull-check-local-newer";
    }
    return { ok: true, localNewer };
  } catch (err) {
    remoteBridgeState.lastReconcileError = String(err?.message || err);
    return { ok: false, error: remoteBridgeState.lastReconcileError };
  }
}

async function runRemoteFullReplication(baseUrl, opts = {}) {
  if (remoteBridgeState.replicationRunning) return { skipped: true, reason: "in_progress" };
  remoteBridgeState.replicationRunning = true;
  remoteBridgeState.lastReplicationAttemptTs = Date.now();
  remoteBridgeState.lastReplicationError = "";
  const xferLabel = String(opts?.label || "");

  try {
    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "start", recvBytes: 0, label: xferLabel });
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

    const stats = applyFullDbSnapshot(data.snapshot, opts);
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
    remoteBridgeState.lastSyncDirection = "pull-full";
    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "done", recvBytes: 0, importedRows: Number(stats.importedRows || 0), label: xferLabel });

    return { ok: true, mode: "full", ...stats };
  } catch (err) {
    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "error", recvBytes: 0, label: xferLabel });
    remoteBridgeState.lastReplicationError = String(err?.message || err);
    if (remoteBridgeState.lastSyncDirection !== "push-failed") {
      remoteBridgeState.lastSyncDirection = "pull-full-failed";
    }
    return { ok: false, error: remoteBridgeState.lastReplicationError };
  } finally {
    remoteBridgeState.replicationRunning = false;
  }
}

async function runRemoteIncrementalReplication(baseUrl, maxBatches = 5, opts = {}) {
  if (remoteBridgeState.replicationRunning) return { skipped: true, reason: "in_progress" };
  remoteBridgeState.replicationRunning = true;
  remoteBridgeState.lastReplicationAttemptTs = Date.now();
  remoteBridgeState.lastReplicationError = "";
  const xferLabel = String(opts?.label || "");

  try {
    let batches = 0;
    let importedRows = 0;
    let hasMore = false;
    let signature = "";
    let totalRecvBytes = 0;
    let cursors = normalizeReplicationCursors(
      remoteBridgeState.replicationCursors || readReplicationCursorsSetting(),
    );

    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "start", recvBytes: 0, label: xferLabel });

    do {
      const data = await requestIncrementalDeltaWithRetry(baseUrl, cursors, (bytes) => {
        totalRecvBytes += bytes;
        broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "chunk", recvBytes: totalRecvBytes, batch: batches + 1, label: xferLabel });
      });

      const applied = applyIncrementalDbDelta(data.delta, opts);
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
    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "done", recvBytes: totalRecvBytes, importedRows, label: xferLabel });
    return { ok: true, importedRows, hasMore, batches, signature, nextCursors: cursors };
  } catch (err) {
    broadcastUpdate({ type: "xfer_progress", dir: "rx", phase: "error", recvBytes: totalRecvBytes || 0, label: xferLabel });
    remoteBridgeState.lastReplicationError = String(err?.message || err);
    remoteBridgeState.lastSyncDirection = "pull-incremental-failed";
    return { ok: false, error: remoteBridgeState.lastReplicationError };
  } finally {
    remoteBridgeState.replicationRunning = false;
  }
}

async function runRemoteCatchUpReplication(baseUrl, maxBatches = 200, maxPasses = 8, opts = {}) {
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
    const res = await runRemoteIncrementalReplication(baseUrl, safeBatches, opts);
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

    const pushed = await pushDeltaInChunks(baseUrl, delta, { label: "Pushing local data" });
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

async function runManualPullSync(baseUrl, includeArchive = true, forcePull = false) {
  // Step 0 — Check: if local data is newer than the gateway, stop unless forcePull.
  if (!forcePull) {
    updateManualReplicationJob({ summary: "Checking gateway state before main DB pull…" });
    const check = await checkLocalNewerBeforePull(baseUrl);
    if (!check?.ok) {
      throw new Error(`Gateway state check failed: ${String(check?.error || "unknown error")}. Check gateway connectivity and retry.`);
    }
    if (check.localNewer) {
      const err = new Error(
        "Local data is newer than the gateway. Use Push first to send local changes to the gateway, " +
        "or use Force Pull to overwrite local data with the gateway state.",
      );
      err.code = "LOCAL_NEWER_PUSH_FAILED";
      err.canForcePull = true;
      throw err;
    }
  }

  // Step 1 — Pull a fresh gateway main DB snapshot and stage it for restart-safe replacement.
  updateManualReplicationJob({ summary: "Pulling fresh gateway main database…" });
  const mainDb = await pullMainDbFromRemote(baseUrl, {
    label: "Pulling main database",
    syncDirection: "pull-main-db-staged",
    failureDirection: "pull-main-db-failed",
  });
  if (mainDb?.skipped) {
    throw new Error("Replication already in progress.");
  }
  if (!mainDb?.ok) {
    throw new Error(
      `Main DB pull failed: ${String(
        mainDb?.error || "unknown error",
      )}. Ensure gateway and client are on the same build.`,
    );
  }

  let archive = {
    ok: true,
    availableFiles: 0,
    transferredFiles: 0,
    skippedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    files: [],
    unsupported: false,
  };
  if (includeArchive) {
    updateManualReplicationJob({
      summary: "Main DB staged. Downloading archive DB files from gateway.",
    });
    archive = await pullArchiveFilesFromRemote(baseUrl);
  }
  const mainDbSummary = `main DB staged=${(Math.max(0, Number(mainDb.size || 0)) / (1024 * 1024)).toFixed(2)} MB (applied after restart)`;
  const archiveSummary = includeArchive
    ? archive.unsupported
      ? "archive skipped (remote build has no archive sync)"
      : `archive files staged=${Number(archive.transferredFiles || 0).toLocaleString()} (applied after restart)`
    : "archive skipped";
  return {
    needsRestart: true,
    direction: String(remoteBridgeState.lastSyncDirection || "idle"),
    mode: "main-db",
    mainDb,
    archive,
    summary: `Pull complete | ${mainDbSummary} | ${archiveSummary}. Restart the app to apply the new gateway database.`,
  };
}

async function runManualPushSync(baseUrl, includeArchive = true) {
  updateManualReplicationJob({
    summary: "Pushing local replicated hot data to gateway.",
  });
  const pushed = await runRemotePushFull(baseUrl);
  if (pushed?.skipped) {
    throw new Error("Replication already in progress.");
  }
  if (!pushed?.ok) {
    throw new Error(String(pushed?.error || "Full push failed."));
  }

  let archivePush = {
    ok: true,
    availableFiles: 0,
    transferredFiles: 0,
    skippedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    files: [],
    unsupported: false,
  };
  if (includeArchive) {
    updateManualReplicationJob({
      summary: "Hot push finished. Uploading local archive DB files to gateway.",
    });
    archivePush = await pushArchiveFilesToRemote(baseUrl);
  }

  const archivePushSummary = includeArchive
    ? archivePush.unsupported
      ? "archive upload skipped"
      : `archive sent to gateway=${Number(archivePush.transferredFiles || 0).toLocaleString()}`
    : "archive skipped";
  return {
    needsRestart: false,
    mode: "push",
    direction: String(remoteBridgeState.lastSyncDirection || "idle"),
    pushedRows: Number(pushed.importedRows || 0),
    pushChunks: Number(pushed.chunkCount || 0),
    archivePush,
    summary: `Push complete | pushed=${Number(pushed.importedRows || 0).toLocaleString()} rows in ${Number(pushed.chunkCount || 0)} chunk(s) | ${archivePushSummary}. Local database was not changed.`,
  };
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

function shouldForceRemoteOffline(err) {
  const status = Number(err?.httpStatus || 0);
  if (status === 400 || status === 401 || status === 403 || status === 404) return true;
  const msg = String(err?.message || err || "")
    .trim()
    .toLowerCase();
  return (
    msg.includes("remote gateway url is not configured") ||
    msg.includes("cannot be localhost in remote mode") ||
    msg.includes("unauthorized api request")
  );
}

function getRemoteOfflineFailureThreshold() {
  return remoteBridgeState.replicationRunning
    ? REMOTE_LIVE_FAILURES_BEFORE_OFFLINE_DURING_SYNC
    : REMOTE_LIVE_FAILURES_BEFORE_OFFLINE;
}

function hasRecentRemoteBridgeSuccess(nowTs = Date.now()) {
  const lastSuccessTs = Number(remoteBridgeState.lastSuccessTs || 0);
  if (!lastSuccessTs) return false;
  return nowTs - lastSuccessTs < REMOTE_LIVE_DEGRADED_GRACE_MS;
}

const REMOTE_HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: REMOTE_FETCH_KEEPALIVE_MSECS,
  maxSockets: REMOTE_FETCH_MAX_SOCKETS,
  maxFreeSockets: Math.max(2, Math.floor(REMOTE_FETCH_MAX_SOCKETS / 2)),
});

const REMOTE_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: REMOTE_FETCH_KEEPALIVE_MSECS,
  maxSockets: REMOTE_FETCH_MAX_SOCKETS,
  maxFreeSockets: Math.max(2, Math.floor(REMOTE_FETCH_MAX_SOCKETS / 2)),
});

function getFetchAgentForUrl(targetUrl) {
  try {
    const protocol = String(new URL(String(targetUrl || "")).protocol || "").toLowerCase();
    return protocol === "https:" ? REMOTE_HTTPS_AGENT : REMOTE_HTTP_AGENT;
  } catch (_) {
    return undefined;
  }
}

function buildRemoteFetchOptions(targetUrl, options = {}) {
  const next = options && typeof options === "object" ? { ...options } : {};
  if (next.agent == null) next.agent = getFetchAgentForUrl(targetUrl);
  if (next.compress == null) next.compress = true;
  return next;
}

function createTransferReadStream(filePath) {
  return fs.createReadStream(filePath, { highWaterMark: REPLICATION_TRANSFER_STREAM_HWM });
}

function createTransferWriteStream(filePath) {
  return fs.createWriteStream(filePath, { highWaterMark: REPLICATION_TRANSFER_STREAM_HWM });
}

async function hashFileSha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createTransferReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function createReplicationGzipStream() {
  return zlib.createGzip({
    level: zlib.constants.Z_BEST_SPEED,
    chunkSize: REPLICATION_TRANSFER_STREAM_HWM,
  });
}

function requestAcceptsGzip(req) {
  const acceptEncoding = String(req?.headers?.["accept-encoding"] || "").toLowerCase();
  return acceptEncoding.includes("gzip");
}

function shouldGzipReplicationJson(req, rawBytes) {
  return requestAcceptsGzip(req) && Number(rawBytes || 0) >= REPLICATION_JSON_GZIP_MIN_BYTES;
}

function shouldGzipReplicationStream(req, rawBytes) {
  return requestAcceptsGzip(req) && Number(rawBytes || 0) >= REPLICATION_STREAM_GZIP_MIN_BYTES;
}

function sendJsonMaybeGzip(req, res, payload) {
  const raw = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!shouldGzipReplicationJson(req, raw.length)) {
    res.setHeader("Content-Length", String(raw.length));
    res.end(raw);
    return;
  }
  const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED });
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Length", String(gz.length));
  res.setHeader("Vary", "Accept-Encoding");
  res.end(gz);
}

function encodeJsonRequestBody(payload, { gzipThreshold = REPLICATION_JSON_GZIP_MIN_BYTES } = {}) {
  const raw = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  const headers = {
    "Content-Type": "application/json",
  };
  if (raw.length < Math.max(1024, Number(gzipThreshold || 0))) {
    headers["Content-Length"] = String(raw.length);
    return { headers, body: raw };
  }
  const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED });
  headers["Content-Encoding"] = "gzip";
  headers["Content-Length"] = String(gz.length);
  headers["x-json-size"] = String(raw.length);
  return { headers, body: gz };
}

async function verifyTransferredFile(filePath, { expectedSize = 0, expectedSha256 = "" } = {}) {
  const stat = await fs.promises.stat(filePath);
  const actualSize = Math.max(0, Number(stat?.size || 0));
  const sizeTarget = Math.max(0, Number(expectedSize || 0));
  if (sizeTarget > 0 && actualSize !== sizeTarget) {
    throw new Error(`Transfer size mismatch. Expected ${sizeTarget} bytes, received ${actualSize}.`);
  }
  const hashTarget = String(expectedSha256 || "").trim().toLowerCase();
  if (hashTarget) {
    const actualSha256 = String(await hashFileSha256(filePath) || "").trim().toLowerCase();
    if (!actualSha256 || actualSha256 !== hashTarget) {
      throw new Error("Transfer integrity check failed (SHA-256 mismatch).");
    }
  }
  return { size: actualSize };
}

async function runTasksWithConcurrency(items, limit, handler) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 0) return [];
  const safeLimit = Math.max(1, Math.min(list.length, Number(limit || 1) || 1));
  const results = new Array(list.length);
  let cursor = 0;
  let firstErr = null;

  async function worker() {
    while (true) {
      if (firstErr) return;
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await handler(list[index], index);
      } catch (err) {
        firstErr = firstErr || err;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  if (firstErr) throw firstErr;
  return results;
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = Math.max(1, Number(retryOptions?.attempts || 1));
  const baseDelay = Math.max(0, Number(retryOptions?.baseDelayMs || 0));
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fetch(url, buildRemoteFetchOptions(url, options));
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
  const targetUrl = `${baseUrl}/api/replication/incremental`;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const r = await fetch(targetUrl, buildRemoteFetchOptions(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildRemoteProxyHeaders(),
        },
        body: JSON.stringify({ cursors }),
        timeout: REMOTE_INCREMENTAL_REQUEST_TIMEOUT_MS,
      }));
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
  const targetUrl = `${baseUrl}/api/replication/push`;
  const encodedBody = encodeJsonRequestBody({ delta: deltaPayload });

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const r = await fetch(targetUrl, buildRemoteFetchOptions(targetUrl, {
        method: "POST",
        headers: {
          ...buildRemoteProxyHeaders(),
          ...encodedBody.headers,
        },
        body: encodedBody.body,
        timeout: REMOTE_REPLICATION_TIMEOUT_MS,
      }));
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

async function pushDeltaInChunks(baseUrl, deltaPayload, opts = {}) {
  const delta = deltaPayload && typeof deltaPayload === "object" ? deltaPayload : null;
  if (!delta || typeof delta !== "object") {
    throw new Error("Invalid push replication payload.");
  }
  const sourceTables = delta.tables && typeof delta.tables === "object" ? delta.tables : {};
  const totalRows = countReplicationRowsByTables(sourceTables);
  const xferLabel = String(opts?.label || "Pushing local data");
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

  broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "start", totalBytes, sentBytes: 0, chunkCount: chunks.length, totalRows, label: xferLabel });

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
      broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "chunk", totalBytes, sentBytes, chunk: i + 1, chunkCount: chunks.length, totalRows, label: xferLabel });
    } catch (err) {
      broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "error", totalBytes, sentBytes, chunk: i + 1, chunkCount: chunks.length, label: xferLabel });
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

  broadcastUpdate({ type: "xfer_progress", dir: "tx", phase: "done", totalBytes, sentBytes, chunkCount: chunks.length, importedRows, totalRows, label: xferLabel });

  return {
    importedRows,
    skippedRows,
    chunkCount: chunks.length,
    totalRows,
    signature,
  };
}

async function createGatewayMainDbSnapshotForTransfer() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const tempPath = path.join(
    DATA_DIR,
    `adsi.db.snapshot-${Date.now()}-${process.pid}.tmp`,
  );
  try {
    poller.flushPending();
  } catch (_) {
    // Best effort only; backup still produces a consistent snapshot.
  }
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch (_) {
    // Ignore checkpoint failures before snapshot export.
  }
  await db.backup(tempPath);
  const stat = await fs.promises.stat(tempPath);
  const sha256 = await hashFileSha256(tempPath);
  return {
    tempPath,
    size: Math.max(0, Number(stat?.size || 0)),
    mtimeMs: Math.max(0, Number(stat?.mtimeMs || Date.now())),
    sha256,
  };
}

async function pullMainDbFromRemote(baseUrl, opts = {}) {
  if (remoteBridgeState.replicationRunning) {
    return { skipped: true, reason: "in_progress" };
  }
  remoteBridgeState.replicationRunning = true;
  remoteBridgeState.lastReplicationAttemptTs = Date.now();
  remoteBridgeState.lastReplicationError = "";

  const xferLabel = String(opts?.label || "Pulling main database");
  const nextSyncDirection = String(opts?.syncDirection || "pull-main-db-staged");
  const failureDirection = String(opts?.failureDirection || "pull-main-db-failed");
  const preserveRows = capturePreservedMainDbSettings();
  const tempPath = path.join(DATA_DIR, `adsi.db.download-${Date.now()}.tmp`);
  let recvBytes = 0;
  let totalBytes = 0;
  let expectedSha256 = "";

  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const targetUrl = `${baseUrl}/api/replication/main-db`;
    const r = await fetch(targetUrl, buildRemoteFetchOptions(targetUrl, {
      method: "GET",
      headers: buildRemoteProxyHeaders(),
      timeout: REMOTE_REPLICATION_TIMEOUT_MS,
    }));
    if (!r.ok) {
      if (Number(r.status || 0) === 404) {
        throw new Error("Gateway build does not expose main DB pull.");
      }
      throw new Error(`Main DB pull HTTP ${r.status} ${r.statusText}`);
    }
    totalBytes = Math.max(
      0,
      Number(
        r.headers.get("x-main-db-size") ||
          r.headers.get("content-length") ||
          0,
      ),
    );
    const targetMtimeMs = Math.max(
      0,
      Number(r.headers.get("x-main-db-mtime") || Date.now()),
    );
    expectedSha256 = String(r.headers.get("x-main-db-sha256") || "").trim().toLowerCase();
    const body = r.body;
    if (!body) {
      throw new Error("Main DB pull returned an empty body.");
    }

    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "start",
      recvBytes: 0,
      totalBytes,
      chunkCount: 1,
      label: xferLabel,
    });

    body.on("data", (chunk) => {
      const bytes = Math.max(0, Buffer.byteLength(chunk || Buffer.alloc(0)));
      if (bytes <= 0) return;
      recvBytes += bytes;
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "chunk",
        recvBytes,
        totalBytes,
        chunk: 1,
        chunkCount: 1,
        label: xferLabel,
      });
    });

    await pipeline(body, createTransferWriteStream(tempPath));
    const verified = await verifyTransferredFile(tempPath, {
      expectedSize: totalBytes > 0 ? totalBytes : recvBytes,
      expectedSha256,
    });
    if (targetMtimeMs > 0) {
      const mtime = new Date(targetMtimeMs);
      await fs.promises.utimes(tempPath, mtime, mtime);
    }
    const staged = stagePendingMainDbReplacement({
      tempName: path.basename(tempPath),
      size: Math.max(0, Number(verified?.size || totalBytes || recvBytes || 0)),
      mtimeMs: targetMtimeMs,
      preservedSettings: preserveRows,
    });

    remoteBridgeState.lastReplicationTs = Date.now();
    remoteBridgeState.lastReplicationRows = 0;
    remoteBridgeState.lastReplicationSignature = "";
    remoteBridgeState.lastReplicationError = "";
    remoteBridgeState.lastSyncDirection = nextSyncDirection;

    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "done",
      recvBytes,
      totalBytes: totalBytes > 0 ? totalBytes : recvBytes,
      chunkCount: 1,
      importedRows: 1,
      label: xferLabel,
    });

    return {
      ok: true,
      staged: true,
      size: Math.max(0, Number(staged?.size || recvBytes || 0)),
      mtimeMs: Math.max(0, Number(staged?.mtimeMs || targetMtimeMs || 0)),
      preservedSettings: preserveRows
        .map((row) => String(row?.key || ""))
        .filter(Boolean),
    };
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore temp cleanup failures.
    }
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "error",
      recvBytes,
      totalBytes: totalBytes > 0 ? totalBytes : recvBytes,
      chunkCount: 1,
      label: xferLabel,
    });
    remoteBridgeState.lastReplicationError = String(err?.message || err);
    if (remoteBridgeState.lastSyncDirection !== "push-failed") {
      remoteBridgeState.lastSyncDirection = failureDirection;
    }
    return { ok: false, error: remoteBridgeState.lastReplicationError };
  } finally {
    remoteBridgeState.replicationRunning = false;
  }
}

function shouldPullArchiveFile(remoteMeta, localMeta) {
  if (!localMeta) return true;
  const remoteSize = Math.max(0, Number(remoteMeta?.size || 0));
  const localSize = Math.max(0, Number(localMeta?.size || 0));
  const remoteMtime = Math.max(0, Number(remoteMeta?.mtimeMs || 0));
  const localMtime = Math.max(0, Number(localMeta?.mtimeMs || 0));
  if (remoteSize !== localSize) return true;
  return remoteMtime > localMtime + 2000;
}

function shouldPushArchiveFile(localMeta, remoteMeta) {
  if (!remoteMeta) return true;
  const localSize = Math.max(0, Number(localMeta?.size || 0));
  const remoteSize = Math.max(0, Number(remoteMeta?.size || 0));
  const localMtime = Math.max(0, Number(localMeta?.mtimeMs || 0));
  const remoteMtime = Math.max(0, Number(remoteMeta?.mtimeMs || 0));
  if (localSize > remoteSize) return true;
  if (localSize < remoteSize) return false;
  return localMtime > remoteMtime + 2000;
}

async function fetchRemoteArchiveManifest(baseUrl) {
  const targetUrl = `${baseUrl}/api/replication/archive-manifest`;
  const r = await fetch(targetUrl, buildRemoteFetchOptions(targetUrl, {
    method: "GET",
    headers: buildRemoteProxyHeaders(),
    timeout: REMOTE_REPLICATION_TIMEOUT_MS,
  }));
  if (!r.ok) {
    if (Number(r.status || 0) === 404) {
      return { ok: false, unsupported: true, error: "Remote build does not expose archive sync." };
    }
    throw new Error(`Archive manifest HTTP ${r.status} ${r.statusText}`);
  }
  const data = await r.json();
  if (!data?.ok) {
    throw new Error(String(data?.error || "Invalid archive manifest payload."));
  }
  const files = Array.isArray(data?.manifest) ? data.manifest : [];
  return {
    ok: true,
    manifest: files
      .map((entry) => {
        const name = sanitizeArchiveFileName(entry?.name || "");
        if (!name) return null;
        return {
          name,
          monthKey: monthKeyFromArchiveFileName(name),
          size: Math.max(0, Number(entry?.size || 0)),
          mtimeMs: Math.max(0, Number(entry?.mtimeMs || 0)),
        };
      })
      .filter(Boolean),
  };
}

async function downloadArchiveFileFromRemote(baseUrl, fileMeta, onBytes) {
  const name = sanitizeArchiveFileName(fileMeta?.name || "");
  if (!name) throw new Error("Invalid archive file name.");
  const monthKey = monthKeyFromArchiveFileName(name);
  const tempPath = path.join(ARCHIVE_DIR, `${name}.download-${Date.now()}.tmp`);
  await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
  closeArchiveDbForMonth(monthKey);

  let body = null;
  let expectedSha256 = "";
  try {
    const targetUrl = `${baseUrl}/api/replication/archive-download?file=${encodeURIComponent(name)}`;
    const r = await fetch(
      targetUrl,
      buildRemoteFetchOptions(targetUrl, {
        method: "GET",
        headers: buildRemoteProxyHeaders(),
        timeout: REMOTE_REPLICATION_TIMEOUT_MS,
      }),
    );
    if (!r.ok) {
      throw new Error(`Archive download HTTP ${r.status} ${r.statusText}`);
    }
    expectedSha256 = String(r.headers.get("x-archive-sha256") || "").trim().toLowerCase();
    body = r.body;
    if (!body) {
      throw new Error("Archive download returned an empty body.");
    }
    body.on("data", (chunk) => {
      const bytes = Math.max(0, Buffer.byteLength(chunk || Buffer.alloc(0)));
      if (bytes > 0 && typeof onBytes === "function") onBytes(bytes);
    });
    await pipeline(body, createTransferWriteStream(tempPath));
    const verified = await verifyTransferredFile(tempPath, {
      expectedSize: Math.max(0, Number(fileMeta?.size || 0)),
      expectedSha256,
    });
    const targetMtimeMs = Math.max(0, Number(fileMeta?.mtimeMs || 0));
    if (targetMtimeMs > 0) {
      const mtime = new Date(targetMtimeMs);
      await fs.promises.utimes(tempPath, mtime, mtime);
    }
    stagePendingArchiveReplacement({
      name,
      monthKey,
      tempName: path.basename(tempPath),
      size: Math.max(0, Number(verified?.size || fileMeta?.size || 0)),
      mtimeMs: targetMtimeMs,
    });
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore temp cleanup failures.
    }
    throw err;
  }
  return {
    name,
    monthKey,
    size: Math.max(0, Number(fileMeta?.size || 0)),
    mtimeMs: Math.max(0, Number(fileMeta?.mtimeMs || 0)),
  };
}

async function uploadArchiveFileToRemote(baseUrl, fileMeta, onBytes) {
  const name = sanitizeArchiveFileName(fileMeta?.name || "");
  if (!name) throw new Error("Invalid archive file name.");
  const monthKey = monthKeyFromArchiveFileName(name);
  const resolved = resolveArchiveFileForTransfer(name);
  if (!resolved?.path) {
    throw new Error("Archive file not found.");
  }
  const filePath = resolved.path;
  closeArchiveDbForMonth(monthKey);
  const stat = await fs.promises.stat(filePath);
  const sha256 = await hashFileSha256(filePath);
  const targetUrl = `${baseUrl}/api/replication/archive-upload?file=${encodeURIComponent(name)}`;
  const stream = createTransferReadStream(filePath);
  stream.on("data", (chunk) => {
    const bytes = Math.max(0, Buffer.byteLength(chunk || Buffer.alloc(0)));
    if (bytes > 0 && typeof onBytes === "function") onBytes(bytes);
  });

  const r = await fetch(
    targetUrl,
    buildRemoteFetchOptions(targetUrl, {
      method: "POST",
      headers: {
        ...buildRemoteProxyHeaders(),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(Math.max(0, Number(stat.size || 0))),
        "x-archive-size": String(Math.max(0, Number(stat.size || 0))),
        "x-archive-mtime": String(
          Math.max(0, Number(fileMeta?.mtimeMs || stat.mtimeMs || Date.now())),
        ),
        "x-archive-sha256": sha256,
      },
      body: stream,
      timeout: REMOTE_REPLICATION_TIMEOUT_MS,
    }),
  );
  if (!r.ok) {
    let detail = "";
    try {
      detail = String(await r.text()).trim();
    } catch (_) {
      detail = "";
    }
    throw new Error(
      detail
        ? `Archive upload HTTP ${r.status} ${r.statusText}: ${detail}`
        : `Archive upload HTTP ${r.status} ${r.statusText}`,
    );
  }
  const data = await r.json();
  if (!data?.ok) {
    throw new Error(String(data?.error || "Archive upload failed."));
  }
  return {
    name,
    monthKey,
    size: Math.max(0, Number(stat.size || 0)),
    mtimeMs: Math.max(0, Number(fileMeta?.mtimeMs || stat.mtimeMs || 0)),
  };
}

async function pullArchiveFilesFromRemote(baseUrl) {
  const remoteManifestRes = await fetchRemoteArchiveManifest(baseUrl);
  if (!remoteManifestRes.ok) {
    return {
      ok: false,
      unsupported: Boolean(remoteManifestRes.unsupported),
      availableFiles: 0,
      transferredFiles: 0,
      skippedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      files: [],
      error: String(remoteManifestRes.error || "Archive manifest unavailable."),
    };
  }

  const remoteManifest = Array.isArray(remoteManifestRes.manifest)
    ? remoteManifestRes.manifest
    : [];
  const localMap = new Map(
    listLocalArchiveManifest().map((entry) => [String(entry.name || ""), entry]),
  );
  const toPull = remoteManifest.filter((entry) =>
    shouldPullArchiveFile(entry, localMap.get(String(entry.name || ""))),
  );
  const totalBytes = toPull.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry?.size || 0)),
    0,
  );
  let transferredBytes = 0;
  let transferredFiles = 0;
  const transferredNames = [];
  if (toPull.length > 0) {
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "start",
      recvBytes: 0,
      totalBytes,
      chunkCount: toPull.length,
      label: "Pulling archive",
    });
  }

  try {
    await runTasksWithConcurrency(
      toPull,
      REMOTE_ARCHIVE_TRANSFER_CONCURRENCY,
      async (fileMeta) => {
        await downloadArchiveFileFromRemote(baseUrl, fileMeta, (bytes) => {
          transferredBytes += Math.max(0, Number(bytes || 0));
          const activeStep = Math.min(toPull.length, Math.max(1, transferredFiles + 1));
          broadcastUpdate({
            type: "xfer_progress",
            dir: "rx",
            phase: "chunk",
            recvBytes: transferredBytes,
            totalBytes,
            chunk: activeStep,
            chunkCount: toPull.length,
            label: "Pulling archive",
          });
        });
        transferredFiles += 1;
        transferredNames.push(fileMeta.name);
        broadcastUpdate({
          type: "xfer_progress",
          dir: "rx",
          phase: "chunk",
          recvBytes: transferredBytes,
          totalBytes,
          chunk: transferredFiles,
          chunkCount: toPull.length,
          label: "Pulling archive",
        });
      },
    );
  } catch (err) {
    if (toPull.length > 0) {
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "error",
        recvBytes: transferredBytes,
        totalBytes,
        chunkCount: toPull.length,
        label: "Pulling archive",
      });
    }
    throw err;
  }

  if (toPull.length > 0) {
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "done",
      recvBytes: transferredBytes,
      totalBytes,
      chunkCount: toPull.length,
      label: "Pulling archive",
    });
  }

  return {
    ok: true,
    availableFiles: remoteManifest.length,
    transferredFiles,
    skippedFiles: Math.max(0, remoteManifest.length - transferredFiles),
    totalBytes,
    transferredBytes,
    files: transferredNames,
  };
}

async function pushArchiveFilesToRemote(baseUrl) {
  const remoteManifestRes = await fetchRemoteArchiveManifest(baseUrl);
  if (!remoteManifestRes.ok) {
    return {
      ok: false,
      unsupported: Boolean(remoteManifestRes.unsupported),
      availableFiles: 0,
      transferredFiles: 0,
      skippedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      files: [],
      error: String(remoteManifestRes.error || "Archive manifest unavailable."),
    };
  }

  const remoteMap = new Map(
    (Array.isArray(remoteManifestRes.manifest) ? remoteManifestRes.manifest : []).map(
      (entry) => [String(entry.name || ""), entry],
    ),
  );
  const localManifest = listLocalArchiveManifest();
  const toPush = localManifest.filter((entry) =>
    shouldPushArchiveFile(entry, remoteMap.get(String(entry.name || ""))),
  );
  const totalBytes = toPush.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry?.size || 0)),
    0,
  );
  let transferredBytes = 0;
  let transferredFiles = 0;
  const transferredNames = [];
  if (toPush.length > 0) {
    broadcastUpdate({
      type: "xfer_progress",
      dir: "tx",
      phase: "start",
      sentBytes: 0,
      totalBytes,
      chunkCount: toPush.length,
      label: "Pushing archive",
    });
  }

  try {
    await runTasksWithConcurrency(
      toPush,
      REMOTE_ARCHIVE_TRANSFER_CONCURRENCY,
      async (fileMeta) => {
        await uploadArchiveFileToRemote(baseUrl, fileMeta, (bytes) => {
          transferredBytes += Math.max(0, Number(bytes || 0));
          const activeStep = Math.min(toPush.length, Math.max(1, transferredFiles + 1));
          broadcastUpdate({
            type: "xfer_progress",
            dir: "tx",
            phase: "chunk",
            sentBytes: transferredBytes,
            totalBytes,
            chunk: activeStep,
            chunkCount: toPush.length,
            label: "Pushing archive",
          });
        });
        transferredFiles += 1;
        transferredNames.push(fileMeta.name);
        broadcastUpdate({
          type: "xfer_progress",
          dir: "tx",
          phase: "chunk",
          sentBytes: transferredBytes,
          totalBytes,
          chunk: transferredFiles,
          chunkCount: toPush.length,
          label: "Pushing archive",
        });
      },
    );
  } catch (err) {
    if (toPush.length > 0) {
      broadcastUpdate({
        type: "xfer_progress",
        dir: "tx",
        phase: "error",
        sentBytes: transferredBytes,
        totalBytes,
        chunkCount: toPush.length,
        label: "Pushing archive",
      });
    }
    throw err;
  }

  if (toPush.length > 0) {
    broadcastUpdate({
      type: "xfer_progress",
      dir: "tx",
      phase: "done",
      sentBytes: transferredBytes,
      totalBytes,
      chunkCount: toPush.length,
      label: "Pushing archive",
    });
  }

  return {
    ok: true,
    availableFiles: localManifest.length,
    transferredFiles,
    skippedFiles: Math.max(0, localManifest.length - transferredFiles),
    totalBytes,
    transferredBytes,
    files: transferredNames,
  };
}

function startManualReplicationJob(action, options, runner) {
  if (isManualReplicationJobRunning() || remoteBridgeState.replicationRunning) {
    return {
      started: false,
      reason: "in_progress",
      job: snapshotManualReplicationJob(),
    };
  }
  const jobId = `${String(action || "sync")}-${Date.now()}`;
  updateManualReplicationJob({
    id: jobId,
    action: String(action || "sync"),
    status: "queued",
    running: true,
    includeArchive: options?.includeArchive !== false,
    startedAt: Date.now(),
    finishedAt: 0,
    error: "",
    summary: String(options?.summary || "Queued"),
    needsRestart: false,
    result: null,
  });

  setTimeout(async () => {
    updateManualReplicationJob({
      status: "running",
      summary: String(options?.runningSummary || "Running"),
    });
    try {
      const result = await runner();
      updateManualReplicationJob({
        status: "completed",
        running: false,
        finishedAt: Date.now(),
        summary: String(
          result?.summary ||
            `${String(action || "sync")} complete. Restart the app to refresh in-memory state.`,
        ),
        error: "",
        needsRestart: Boolean(result?.needsRestart),
        result:
          result && typeof result === "object"
            ? { ...result }
            : null,
      });
    } catch (err) {
      updateManualReplicationJob({
        status: "failed",
        running: false,
        finishedAt: Date.now(),
        summary: `${String(action || "sync")} failed`,
        error: String(err?.message || err),
        errorCode: String(err?.code || ""),
        needsRestart: false,
        result: null,
      });
    }
  }, 25);

  return {
    started: true,
    job: snapshotManualReplicationJob(),
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
    if (p.startsWith("/api/export/")) timeoutMs = Math.max(timeoutMs, 600000);
    else if (p.startsWith("/api/report/")) timeoutMs = Math.max(timeoutMs, 45000);
    else if (p.startsWith("/api/replication/")) timeoutMs = Math.max(timeoutMs, 45000);
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
    const upstream = await fetch(target, buildRemoteFetchOptions(target, {
      method,
      headers,
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
      timeout: timeoutMs,
    }));
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

async function requestRemoteChat(pathname, {
  method = "GET",
  body = null,
  timeout = CHAT_PROXY_TIMEOUT_MS,
  retry = null,
} = {}) {
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    const err = new Error("Remote gateway URL is not configured.");
    err.httpStatus = 503;
    throw err;
  }
  if (isUnsafeRemoteLoop(base)) {
    const err = new Error("Remote gateway URL cannot be localhost in remote mode.");
    err.httpStatus = 400;
    throw err;
  }
  const target = `${base}${pathname}`;
  const hasBody = !["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
  const headers = {
    ...buildRemoteProxyHeaders(),
  };
  if (hasBody) headers["Content-Type"] = "application/json";

  const fetchOptions = {
    method,
    headers,
    body: hasBody ? JSON.stringify(body || {}) : undefined,
    timeout: Math.max(1000, Number(timeout || CHAT_PROXY_TIMEOUT_MS)),
  };
  const response = retry
    ? await fetchWithRetry(target, fetchOptions, retry)
    : await fetch(target, fetchOptions);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = null;
  }
  if (!response.ok) {
    const err = new Error(
      String(parsed?.error || parsed?.message || text || `HTTP ${response.status}`),
    );
    err.httpStatus = Number(response.status || 0);
    throw err;
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function warnRemoteChatPoll(message) {
  const now = Date.now();
  if (now - Number(remoteChatBridgeState.lastWarnTs || 0) < 30000) return;
  remoteChatBridgeState.lastWarnTs = now;
  console.warn("[chat] remote poll failed:", String(message || "unknown error"));
}

async function primeRemoteChatCursor() {
  if (!isRemoteMode()) return 0;
  const payload = await requestRemoteChat(
    `/api/chat/messages?mode=thread&limit=${CHAT_THREAD_LIMIT}`,
    {
      method: "GET",
      timeout: CHAT_PROXY_TIMEOUT_MS,
      retry: {
        attempts: 2,
        baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
      },
    },
  );
  const rows = normalizeChatRows(payload?.rows);
  remoteChatBridgeState.lastInboundId = getNewestChatIdForMachine(rows, "remote");
  remoteChatBridgeState.primed = true;
  remoteChatBridgeState.lastError = "";
  return remoteChatBridgeState.lastInboundId;
}

async function pollRemoteChatOnce() {
  if (!isRemoteMode()) return;
  if (!remoteChatBridgeState.primed) {
    await primeRemoteChatCursor();
  }
  const afterId = Math.max(0, Number(remoteChatBridgeState.lastInboundId || 0));
  const qs = new URLSearchParams({
    mode: "inbox",
    machine: "remote",
    afterId: String(afterId),
    limit: String(REMOTE_CHAT_POLL_LIMIT),
  });
  const payload = await requestRemoteChat(`/api/chat/messages?${qs.toString()}`, {
    method: "GET",
    timeout: CHAT_PROXY_TIMEOUT_MS,
    retry: {
      attempts: 2,
      baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
    },
  });
  const rows = normalizeChatRows(payload?.rows);
  if (!rows.length) {
    remoteChatBridgeState.lastError = "";
    return;
  }
  for (const row of rows) {
    if (row.id > Number(remoteChatBridgeState.lastInboundId || 0)) {
      remoteChatBridgeState.lastInboundId = row.id;
    }
    broadcastUpdate({ type: "chat", row });
  }
  remoteChatBridgeState.lastError = "";
}

function stopRemoteChatBridge() {
  if (remoteChatPollTimer) {
    clearTimeout(remoteChatPollTimer);
    remoteChatPollTimer = null;
  }
  remoteChatBridgeState.running = false;
  remoteChatBridgeState.primed = false;
  remoteChatBridgeState.lastInboundId = 0;
  remoteChatBridgeState.lastError = "";
}

function startRemoteChatBridge() {
  if (remoteChatBridgeState.running) return;
  remoteChatBridgeState.running = true;
  remoteChatBridgeState.primed = false;
  remoteChatBridgeState.lastInboundId = 0;
  remoteChatBridgeState.lastError = "";
  const tick = async () => {
    if (!remoteChatBridgeState.running) return;
    if (!isRemoteMode()) {
      stopRemoteChatBridge();
      return;
    }
    try {
      await pollRemoteChatOnce();
    } catch (err) {
      remoteChatBridgeState.lastError = String(err?.message || err);
      warnRemoteChatPoll(remoteChatBridgeState.lastError);
    }
    remoteChatPollTimer = setTimeout(tick, REMOTE_CHAT_POLL_INTERVAL_MS);
    if (remoteChatPollTimer?.unref) remoteChatPollTimer.unref();
  };
  tick();
}

async function runRemoteStartupAutoSync(baseUrl) {
  const check = await checkLocalNewerBeforePull(baseUrl);
  if (!check?.ok) {
    remoteBridgeState.lastReplicationError =
      `Startup gateway state check failed: ${String(check?.error || "unknown error")}`;
    remoteBridgeState.lastSyncDirection = "startup-auto-sync-failed";
    return {
      ok: false,
      stage: "check",
      localNewer: false,
      error: remoteBridgeState.lastReplicationError,
      check,
    };
  }
  if (check.localNewer) {
    remoteBridgeState.lastReplicationError =
      "Startup auto sync blocked: local data is newer than the gateway. Run Push first or use manual Force Pull if you want to overwrite local state.";
    remoteBridgeState.lastSyncDirection = "startup-auto-sync-blocked-local-newer";
    return {
      ok: false,
      stage: "check",
      localNewer: true,
      error: remoteBridgeState.lastReplicationError,
      check,
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
      check,
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
      check,
      incremental: inc,
    };
  }

  remoteBridgeState.lastReplicationError = "";
  return { ok: true, stage: "complete", check, incremental: inc };
}

async function pollRemoteLiveOnce() {
  const wasConnected = Boolean(remoteBridgeState.connected);
  const hadLiveData = Boolean(
    remoteBridgeState.liveData &&
      typeof remoteBridgeState.liveData === "object" &&
      Object.keys(remoteBridgeState.liveData).length,
  );
  const startedAt = Date.now();
  remoteBridgeState.lastAttemptTs = startedAt;
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    remoteBridgeState.connected = false;
    remoteBridgeState.liveFailureCount += 1;
    remoteBridgeState.lastFailureTs = startedAt;
    remoteBridgeState.lastReasonCode = "MISSING_URL";
    remoteBridgeState.lastReasonClass = "config-error";
    remoteBridgeState.lastError = "Remote gateway URL is not configured.";
    if (!hasUsableRemoteLiveSnapshot(startedAt) && (wasConnected || hadLiveData)) {
      broadcastRemoteOfflineLiveState();
    }
    broadcastRemoteHealthUpdate(true);
    return;
  }
  if (isUnsafeRemoteLoop(base)) {
    remoteBridgeState.connected = false;
    remoteBridgeState.liveFailureCount += 1;
    remoteBridgeState.lastFailureTs = startedAt;
    remoteBridgeState.lastReasonCode = "LOOPBACK_URL";
    remoteBridgeState.lastReasonClass = "config-error";
    remoteBridgeState.lastError =
      "Remote gateway URL cannot be localhost in remote mode.";
    if (!hasUsableRemoteLiveSnapshot(startedAt) && (wasConnected || hadLiveData)) {
      broadcastRemoteOfflineLiveState();
    }
    broadcastRemoteHealthUpdate(true);
    return;
  }
  try {
    const r = await fetchWithRetry(
      `${base}/api/live`,
      {
        method: "GET",
        headers: buildRemoteProxyHeaders(),
        timeout: REMOTE_FETCH_TIMEOUT_MS,
      },
      {
        attempts: REMOTE_LIVE_FETCH_RETRIES,
        baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
      },
    );
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} ${r.statusText}`);
      err.httpStatus = Number(r.status || 0);
      throw err;
    }
    let data;
    try {
      data = await r.json();
    } catch (parseErr) {
      const err = new Error("Gateway returned invalid live JSON.");
      err.code = "BAD_JSON";
      throw err;
    }
    remoteBridgeState.liveData =
      data && typeof data === "object" ? data : {};
    const successTs = Date.now();
    remoteBridgeState.lastLatencyMs = Math.max(0, successTs - startedAt);
    remoteBridgeState.lastLiveNodeCount = countRemoteLiveNodes(remoteBridgeState.liveData);
    persistRemoteLiveRows(remoteBridgeState.liveData, successTs);
    remoteBridgeState.totals = computeTotalsFromLiveData(
      remoteBridgeState.liveData,
    );
    remoteBridgeState.connected = true;
    remoteBridgeState.liveFailureCount = 0;
    remoteBridgeState.lastFailureTs = 0;
    remoteBridgeState.lastSuccessTs = successTs;
    remoteBridgeState.lastReasonCode = "";
    remoteBridgeState.lastReasonClass = "";
    remoteBridgeState.lastError = "";
    broadcastUpdate({
      type: "live",
      data: remoteBridgeState.liveData,
      totals: remoteBridgeState.totals,
      remoteHealth: buildRemoteHealthSnapshot(successTs),
    });
    remoteBridgeState.lastHealthBroadcastKey = "";
    remoteBridgeState.lastSyncDirection = "pull-live";

    // Piggyback today's energy totals so /api/energy/today matches gateway exactly.
    // Rate-limited: only fetch when stale (>30 s) to avoid hammering the gateway
    // on every 1.2 s bridge tick.
    const energyAgeMs = successTs - (remoteBridgeState.lastTodayEnergyFetchTs || 0);
    if (energyAgeMs >= REMOTE_ENERGY_POLL_INTERVAL_MS) {
      try {
        const et = await fetchWithRetry(
          `${base}/api/energy/today`,
          {
            method: "GET",
            headers: buildRemoteProxyHeaders(),
            timeout: REMOTE_FETCH_TIMEOUT_MS,
          },
          {
            attempts: REMOTE_LIVE_FETCH_RETRIES,
            baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
          },
        );
        if (et.ok) {
          const rows = await et.json();
          if (Array.isArray(rows)) {
            const normalizedRows = normalizeTodayEnergyRows(rows);
            remoteBridgeState.todayEnergyRows = normalizedRows;
            updateRemoteTodayEnergyShadow(normalizedRows, successTs);
            mirrorRemoteTodayEnergyRowsToLocal(normalizedRows, successTs);
            todayEnergyCache.ts = 0; // force next request to re-read with new data
          }
          remoteBridgeState.lastTodayEnergyFetchTs = successTs;
        }
      } catch (_) {
        // Non-fatal; stale todayEnergyRows will be used until next tick.
      }
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
    const failure = classifyRemoteBridgeFailure(err);
    const nowTs = Date.now();
    remoteBridgeState.liveFailureCount += 1;
    remoteBridgeState.lastFailureTs = nowTs;
    remoteBridgeState.lastReasonCode = failure.reasonCode;
    remoteBridgeState.lastReasonClass = failure.reasonClass;
    remoteBridgeState.lastError = failure.reasonText;
    const lastSuccessAgeMs = remoteBridgeState.lastSuccessTs
      ? nowTs - Number(remoteBridgeState.lastSuccessTs || 0)
      : Number.POSITIVE_INFINITY;
    const failureThreshold = getRemoteOfflineFailureThreshold();
    const forceOffline = shouldForceRemoteOffline(err);
    const recentSuccess = hasRecentRemoteBridgeSuccess(nowTs);
    const shouldMarkOffline =
      forceOffline ||
      (!wasConnected && !recentSuccess) ||
      remoteBridgeState.liveFailureCount >= failureThreshold ||
      lastSuccessAgeMs >= REMOTE_LIVE_DEGRADED_GRACE_MS;
    remoteBridgeState.connected = !shouldMarkOffline && wasConnected;
    const keepSnapshot = hasUsableRemoteLiveSnapshot(nowTs);
    if (shouldMarkOffline && !keepSnapshot && (wasConnected || hadLiveData)) {
      broadcastRemoteOfflineLiveState();
    }
    if (shouldMarkOffline && wasConnected) {
      remoteBridgeState.lastSyncDirection = "pull-live-failed";
    }
    broadcastRemoteHealthUpdate(true);
  }
}

async function kickRemoteBridgeNow(reason = "manual-reconnect") {
  if (!isRemoteMode()) {
    return {
      ok: false,
      error: "Live bridge refresh is available only in Remote mode.",
      connected: false,
      liveNodeCount: 0,
      remoteHealth: buildRemoteHealthSnapshot(),
    };
  }
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    remoteBridgeState.connected = false;
    remoteBridgeState.lastReasonCode = "MISSING_URL";
    remoteBridgeState.lastReasonClass = "config-error";
    remoteBridgeState.lastError = "Remote gateway URL is not configured.";
    broadcastRemoteHealthUpdate(true);
    return {
      ok: false,
      error: remoteBridgeState.lastError,
      connected: false,
      liveNodeCount: 0,
      remoteHealth: buildRemoteHealthSnapshot(),
    };
  }
  if (isUnsafeRemoteLoop(base)) {
    remoteBridgeState.connected = false;
    remoteBridgeState.lastReasonCode = "LOOPBACK_URL";
    remoteBridgeState.lastReasonClass = "config-error";
    remoteBridgeState.lastError =
      "Remote gateway URL cannot be localhost in remote mode.";
    broadcastRemoteHealthUpdate(true);
    return {
      ok: false,
      error: remoteBridgeState.lastError,
      connected: false,
      liveNodeCount: 0,
      remoteHealth: buildRemoteHealthSnapshot(),
    };
  }
  if (!remoteBridgeState.running) {
    startRemoteBridge();
  }
  remoteBridgeState.lastSyncDirection = String(reason || "manual-reconnect");
  remoteBridgeState.lastAttemptTs = Date.now();
  remoteBridgeState.liveFailureCount = 0;
  try {
    await pollRemoteLiveOnce();
    const remoteHealth = buildRemoteHealthSnapshot();
    const liveNodeCount = Math.max(
      0,
      Object.values(remoteBridgeState.liveData || {}).filter(
        (row) => row && typeof row === "object",
      ).length,
    );
    return {
      ok: remoteHealth.state === "connected",
      degraded:
        remoteHealth.state === "degraded" || remoteHealth.state === "stale",
      connected: remoteHealth.state === "connected",
      liveNodeCount,
      lastSuccessTs: Number(remoteBridgeState.lastSuccessTs || 0),
      lastError: String(remoteBridgeState.lastError || ""),
      error:
        remoteHealth.state === "connected"
          ? ""
          : String(remoteHealth.reasonText || "Live bridge is not fully healthy."),
      remoteHealth,
    };
  } catch (err) {
    remoteBridgeState.connected = false;
    remoteBridgeState.lastFailureTs = Date.now();
    const failure = classifyRemoteBridgeFailure(err);
    remoteBridgeState.lastReasonCode = failure.reasonCode;
    remoteBridgeState.lastReasonClass = failure.reasonClass;
    remoteBridgeState.lastError = failure.reasonText;
    const remoteHealth = buildRemoteHealthSnapshot();
    broadcastRemoteHealthUpdate(true);
    return {
      ok: false,
      error: remoteBridgeState.lastError,
      connected: false,
      liveNodeCount: 0,
      lastSuccessTs: Number(remoteBridgeState.lastSuccessTs || 0),
      lastError: remoteBridgeState.lastError,
      remoteHealth,
    };
  }
}

function stopRemoteBridge() {
  if (remoteBridgeTimer) {
    clearTimeout(remoteBridgeTimer);
    remoteBridgeTimer = null;
  }
  resetRemoteBridgeAlarmState();
  clearRemoteBridgePersistState();
  remoteBridgeState.running = false;
  remoteBridgeState.connected = false;
  remoteBridgeState.liveFailureCount = 0;
  remoteBridgeState.lastFailureTs = 0;
  remoteBridgeState.lastReasonCode = "";
  remoteBridgeState.lastReasonClass = "";
  remoteBridgeState.lastLatencyMs = 0;
  remoteBridgeState.lastLiveNodeCount = 0;
  remoteBridgeState.lastHealthBroadcastKey = "";
  remoteBridgeState.replicationRunning = false;
  if (_shutdownCalled || !isRemoteMode()) remoteBridgeState.lastSyncDirection = "idle";
}

function startRemoteBridge() {
  if (remoteBridgeState.running) return;
  clearRemoteBridgePersistState();
  remoteBridgeState.running = true;
  remoteBridgeState.autoSyncAttempted = false;
  remoteBridgeState.liveFailureCount = 0;
  remoteBridgeState.lastFailureTs = 0;
  remoteBridgeState.lastReasonCode = "";
  remoteBridgeState.lastReasonClass = "";
  remoteBridgeState.lastLatencyMs = 0;
  remoteBridgeState.lastHealthBroadcastKey = "";
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
    // Keep fast retry while the bridge is still connected or has a recent
    // successful poll. Only apply exponential backoff after a real disconnect.
    const nextDelay = getRemoteBridgeNextDelayMs();
    remoteBridgeTimer = setTimeout(tick, Math.round(nextDelay));
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
    broadcastUpdate({
      type: "live",
      data: poller.getLiveData(),
      totals: { pac: 0, kwh: 0 },
      remoteHealth: buildRemoteHealthSnapshot(),
    });
    startRemoteBridge();
    startRemoteChatBridge();
  } else {
    const wasRemoteActive =
      Boolean(remoteBridgeState.running) || Boolean(remoteBridgeState.connected);
    if (wasRemoteActive && Array.isArray(remoteBridgeState.todayEnergyRows)) {
      updateRemoteTodayEnergyShadow(remoteBridgeState.todayEnergyRows, Date.now());
    }
    // â"€â"€ Handoff lifecycle: capture per-inverter baselines â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
        `[handoff] Remoteâ†'Gateway started day=${handoffDay}` +
        ` inverters=${capturedRows.length}` +
        ` baselines=[${baselineList}${capturedRows.length > 8 ? " ..." : ""}]`,
      );
      persistGatewayHandoffMeta();
    }
    stopRemoteBridge();
    stopRemoteChatBridge();
    remoteBridgeState.liveData = {}; // discard stale remote snapshot
    remoteBridgeState.totals = {};
    remoteBridgeState.todayEnergyRows = []; // discard bridge cache; gateway mode uses DB + shadow supplement
    if (wasRemoteActive) {
      // Clear stale remote values on clients before local poller publishes fresh rows.
      poller.markAllOffline();
      broadcastUpdate({
        type: "live",
        data: poller.getLiveData(),
        totals: {},
        remoteHealth: buildRemoteHealthSnapshot(),
      });
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

function getForecastSolarWindowBounds(day) {
  const raw = String(day || localDateStr()).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localDateStr();
  const hh = (n) => String(Math.trunc(Number(n) || 0)).padStart(2, "0");
  return {
    startTs: new Date(
      `${d}T${hh(SOLCAST_SOLAR_START_H)}:00:00.000`,
    ).getTime(),
    endTs: new Date(
      `${d}T${hh(SOLCAST_SOLAR_END_H)}:00:00.000`,
    ).getTime(),
  };
}

function countStoredForecastRows(tableName) {
  const target =
    tableName === "forecast_intraday_adjusted"
      ? "forecast_intraday_adjusted"
      : "forecast_dayahead";
  try {
    const row = stmtCached(
      `count:${target}`,
      `SELECT COUNT(*) AS cnt FROM ${target}`,
    ).get();
    return Math.max(0, Number(row?.cnt || 0));
  } catch (err) {
    console.warn(`[forecast] count failed for ${target}:`, err.message);
    return 0;
  }
}

function getDayAheadRowsForDate(day) {
  const dayKey = String(day || "").trim();
  if (!dayKey) return [];
  let dbRows = [];
  try {
    dbRows = stmts.getForecastDayAheadDate.all(dayKey);
  } catch (err) {
    console.error("[forecast] DB read failed:", err.message);
    dbRows = [];
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

function getIntradayAdjustedRowsForDate(day) {
  const dayKey = String(day || "").trim();
  if (!dayKey) return [];
  let dbRows = [];
  try {
    dbRows = stmts.getForecastIntradayAdjustedDate.all(dayKey);
  } catch (err) {
    console.error("[forecast] intraday DB read failed:", err.message);
    dbRows = [];
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

function upsertIntradayAdjustedSeriesToDb(day, series, source = "context-sync") {
  const rows = normalizeDayAheadSeries(day, series);
  bulkUpsertForecastIntradayAdjusted(day, rows, source);
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
    const infoDayAhead = db
      .prepare(
        "DELETE FROM forecast_dayahead WHERE slot < 60 OR slot > 216",
      )
      .run();
    const infoIntraday = db
      .prepare(
        "DELETE FROM forecast_intraday_adjusted WHERE slot < 60 OR slot > 216",
      )
      .run();
    return Number(infoDayAhead?.changes || 0) + Number(infoIntraday?.changes || 0);
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
    plantName: "ADSI Plant",
    operatorName: "OPERATOR",
    retainDays: "90",
    forecastProvider: "ml_local",
    solcastBaseUrl: "https://api.solcast.com.au",
    solcastAccessMode: SOLCAST_ACCESS_MODE_TOOLKIT,
    solcastApiKey: "",
    solcastResourceId: "",
    solcastToolkitEmail: "",
    solcastToolkitPassword: "",
    solcastToolkitSiteRef: "",
    solcastTimezone: "Asia/Manila",
    plantLatitude: String(WEATHER_LAT),
    plantLongitude: String(WEATHER_LON),
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

function buildDefaultSettingsSnapshot() {
  return {
    operationMode: "gateway",
    remoteAutoSync: false,
    remoteGatewayUrl: "",
    remoteApiToken: "",
    tailscaleDeviceHint: "",
    wireguardInterface: "",
    apiUrl: `${INVERTER_ENGINE_BASE_URL}/data`,
    writeUrl: `${INVERTER_ENGINE_BASE_URL}/write`,
    csvSavePath: "C:\\Logs\\InverterDashboard",
    inverterCount: 27,
    nodeCount: 4,
    invGridLayout: "4",
    plantName: "ADSI Plant",
    operatorName: "OPERATOR",
    retainDays: 90,
    forecastProvider: "ml_local",
    solcastBaseUrl: "https://api.solcast.com.au",
    solcastAccessMode: SOLCAST_ACCESS_MODE_TOOLKIT,
    solcastApiKey: "",
    solcastResourceId: "",
    solcastToolkitEmail: "",
    solcastToolkitPassword: "",
    solcastToolkitSiteRef: "",
    solcastTimezone: "Asia/Manila",
    plantLatitude: WEATHER_LAT,
    plantLongitude: WEATHER_LON,
    exportUiState: buildDefaultExportUiState(),
    inverterPollConfig: { ...DEFAULT_POLL_CFG },
    dataDir: DATA_DIR,
  };
}

function buildSettingsSnapshot() {
  const defaults = buildDefaultSettingsSnapshot();
  const tailscaleHint = sanitizeTailscaleDeviceHint(
    getSetting("tailscaleDeviceHint", getSetting("wireguardInterface", "")),
    "",
  );
  return {
    operationMode: readOperationMode(),
    remoteAutoSync: readRemoteAutoSyncEnabled(),
    remoteGatewayUrl: getRemoteGatewayBaseUrl(),
    remoteApiToken: getRemoteApiToken(),
    tailscaleDeviceHint: tailscaleHint,
    wireguardInterface: tailscaleHint,
    apiUrl: getSetting("apiUrl", defaults.apiUrl),
    writeUrl: getSetting("writeUrl", defaults.writeUrl),
    csvSavePath: getSetting("csvSavePath", defaults.csvSavePath),
    inverterCount: Number(getSetting("inverterCount", defaults.inverterCount)),
    nodeCount: Number(getSetting("nodeCount", defaults.nodeCount)),
    invGridLayout: sanitizeInvGridLayout(
      getSetting("invGridLayout", defaults.invGridLayout),
    ),
    plantName: getSetting("plantName", defaults.plantName),
    operatorName: getSetting("operatorName", defaults.operatorName),
    retainDays: Number(getSetting("retainDays", defaults.retainDays)),
    forecastProvider:
      String(
        getSetting("forecastProvider", defaults.forecastProvider) ||
          defaults.forecastProvider,
      )
        .trim()
        .toLowerCase() === "solcast"
        ? "solcast"
        : "ml_local",
    solcastBaseUrl: getSetting("solcastBaseUrl", defaults.solcastBaseUrl),
    solcastAccessMode: normalizeSolcastAccessMode(
      getSetting("solcastAccessMode", defaults.solcastAccessMode),
    ),
    solcastApiKey: getSetting("solcastApiKey", defaults.solcastApiKey),
    solcastResourceId: getSetting(
      "solcastResourceId",
      defaults.solcastResourceId,
    ),
    solcastToolkitEmail: getSetting(
      "solcastToolkitEmail",
      defaults.solcastToolkitEmail,
    ),
    solcastToolkitPassword: getSetting(
      "solcastToolkitPassword",
      defaults.solcastToolkitPassword,
    ),
    solcastToolkitSiteRef: getSetting(
      "solcastToolkitSiteRef",
      defaults.solcastToolkitSiteRef,
    ),
    solcastTimezone: getSetting(
      "solcastTimezone",
      defaults.solcastTimezone,
    ),
    plantLatitude: Number(getSetting("plantLatitude", WEATHER_LAT)),
    plantLongitude: Number(getSetting("plantLongitude", WEATHER_LON)),
    exportUiState: sanitizeExportUiState(
      readJsonSetting("exportUiState", defaults.exportUiState),
    ),
    inverterPollConfig: sanitizePollConfig(
      readJsonSetting("inverterPollConfig", DEFAULT_POLL_CFG),
    ),
    dataDir: DATA_DIR,
  };
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

function normalizeSolcastAccessMode(value) {
  return String(value || SOLCAST_ACCESS_MODE_TOOLKIT)
    .trim()
    .toLowerCase() === SOLCAST_ACCESS_MODE_TOOLKIT
    ? SOLCAST_ACCESS_MODE_TOOLKIT
    : SOLCAST_ACCESS_MODE_API;
}

function resolveSolcastAccessMode(rawMode, candidate = null) {
  const src = candidate && typeof candidate === "object" ? candidate : {};
  const hasToolkit = !!(
    String(src.toolkitEmail || "").trim() &&
    String(src.toolkitPassword || "").trim() &&
    String(src.toolkitSiteRef || "").trim()
  );
  const hasApi = !!(
    String(src.apiKey || "").trim() &&
    String(src.resourceId || "").trim()
  );
  const explicit = String(rawMode ?? "").trim();
  if (!explicit) {
    return hasToolkit ? SOLCAST_ACCESS_MODE_TOOLKIT : SOLCAST_ACCESS_MODE_API;
  }
  const normalized = normalizeSolcastAccessMode(explicit);
  if (normalized === SOLCAST_ACCESS_MODE_API && hasToolkit && !hasApi) {
    return SOLCAST_ACCESS_MODE_TOOLKIT;
  }
  return normalized;
}

function getSolcastConfig() {
  const cfg = {
    baseUrl: String(
      getSetting("solcastBaseUrl", "https://api.solcast.com.au") || "",
    ).trim() || "https://api.solcast.com.au",
    accessMode: String(
      getSetting("solcastAccessMode", SOLCAST_ACCESS_MODE_TOOLKIT) || "",
    ).trim(),
    apiKey: String(getSetting("solcastApiKey", "") || "").trim(),
    resourceId: String(getSetting("solcastResourceId", "") || "").trim(),
    toolkitEmail: String(getSetting("solcastToolkitEmail", "") || "").trim(),
    toolkitPassword: String(
      getSetting("solcastToolkitPassword", "") || "",
    ).trim(),
    toolkitSiteRef: String(
      getSetting("solcastToolkitSiteRef", "") || "",
    ).trim(),
    timeZone:
      String(getSetting("solcastTimezone", WEATHER_TZ) || "").trim() ||
      WEATHER_TZ,
  };
  cfg.accessMode = resolveSolcastAccessMode(cfg.accessMode, cfg);
  return cfg;
}

function buildSolcastConfigFromInput(input = null) {
  const base = getSolcastConfig();
  const src = input && typeof input === "object" ? input : {};
  const cfg = {
    baseUrl: String(
      src.solcastBaseUrl ?? src.baseUrl ?? base.baseUrl ?? "",
    ).trim() || "https://api.solcast.com.au",
    accessMode: String(
      src.solcastAccessMode ?? src.accessMode ?? base.accessMode ?? "",
    ).trim(),
    apiKey: String(src.solcastApiKey ?? src.apiKey ?? base.apiKey ?? "").trim(),
    resourceId: String(
      src.solcastResourceId ?? src.resourceId ?? base.resourceId ?? "",
    ).trim(),
    toolkitEmail: String(
      src.solcastToolkitEmail ?? src.toolkitEmail ?? base.toolkitEmail ?? "",
    ).trim(),
    toolkitPassword: String(
      src.solcastToolkitPassword ??
        src.toolkitPassword ??
        base.toolkitPassword ??
        "",
    ).trim(),
    toolkitSiteRef: String(
      src.solcastToolkitSiteRef ??
        src.toolkitSiteRef ??
        base.toolkitSiteRef ??
        "",
    ).trim(),
    timeZone: String(
      src.solcastTimezone ?? src.timeZone ?? base.timeZone ?? "",
    ).trim() || WEATHER_TZ,
  };
  cfg.accessMode = resolveSolcastAccessMode(cfg.accessMode, cfg);
  return cfg;
}

function hasUsableSolcastConfig(cfg = null) {
  const c = cfg || getSolcastConfig();
  if (!isHttpUrl(c.baseUrl)) return false;
  if (normalizeSolcastAccessMode(c.accessMode) === SOLCAST_ACCESS_MODE_TOOLKIT) {
    return !!(c.toolkitEmail && c.toolkitPassword && c.toolkitSiteRef);
  }
  return !!(c.apiKey && c.resourceId);
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

async function fetchSolcastApiForecastRecords(cfg) {
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

function normalizeSolcastToolkitRecentHours(value, fallback = SOLCAST_TOOLKIT_RECENT_HOURS) {
  const n = Math.max(1, Math.trunc(Number(value || fallback)));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS, n);
}

function buildSolcastToolkitRecentUrl(
  origin,
  siteType,
  siteId,
  hours = SOLCAST_TOOLKIT_RECENT_HOURS,
  period = SOLCAST_TOOLKIT_PERIOD,
) {
  const safeType = String(siteType || "").trim().toLowerCase();
  const safeId = encodeURIComponent(String(siteId || "").trim());
  const safeHours = normalizeSolcastToolkitRecentHours(hours, SOLCAST_TOOLKIT_RECENT_HOURS);
  const safePeriod = String(period || SOLCAST_TOOLKIT_PERIOD).trim() || SOLCAST_TOOLKIT_PERIOD;
  return new URL(
    `/${safeType}/${safeId}/recent?view=Toolkit&theme=light&hours=${safeHours}&period=${encodeURIComponent(safePeriod)}`,
    origin,
  ).toString();
}

function parseSolcastToolkitSiteRef(value, baseUrl, options = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Solcast toolkit site URL or site ID is required.");
  }
  const recentHours = normalizeSolcastToolkitRecentHours(
    options?.recentHours,
    SOLCAST_TOOLKIT_RECENT_HOURS,
  );
  const period = String(options?.period || SOLCAST_TOOLKIT_PERIOD).trim() || SOLCAST_TOOLKIT_PERIOD;
  let origin = "";
  try {
    origin = new URL(String(baseUrl || "https://api.solcast.com.au")).origin;
  } catch {
    throw new Error("Invalid Solcast Base URL.");
  }

  const parseSitePath = (input) => {
    const cleaned = String(input || "").replace(/^\/+|\/+$/g, "");
    const m = /^(utility_scale_sites|rooftop_sites|sites)\/([^/?#]+)/i.exec(
      cleaned,
    );
    if (!m) return null;
    const siteType = String(m[1] || "").trim().toLowerCase();
    if (!SOLCAST_TOOLKIT_SITE_TYPES.has(siteType)) return null;
    return {
      siteType,
      siteId: decodeURIComponent(String(m[2] || "").trim()),
    };
  };

  if (/^https?:\/\//i.test(raw)) {
    let parsedUrl;
    try {
      parsedUrl = new URL(raw);
    } catch {
      throw new Error("Invalid Solcast toolkit site URL.");
    }
    const parsed = parseSitePath(parsedUrl.pathname);
    if (!parsed) {
      throw new Error(
        "Solcast toolkit URL must include /utility_scale_sites/<id>, /rooftop_sites/<id>, or /sites/<id>.",
      );
    }
    return {
      ...parsed,
      origin: parsedUrl.origin,
      pageUrl: buildSolcastToolkitRecentUrl(
        parsedUrl.origin,
        parsed.siteType,
        parsed.siteId,
        recentHours,
        period,
      ),
    };
  }

  const parsed = parseSitePath(raw);
  if (parsed) {
    return {
      ...parsed,
      origin,
      pageUrl: buildSolcastToolkitRecentUrl(
        origin,
        parsed.siteType,
        parsed.siteId,
        recentHours,
        period,
      ),
    };
  }

  if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
    throw new Error(
      "Solcast toolkit site reference must be a site URL, site path, or site ID.",
    );
  }
  return {
    siteType: "utility_scale_sites",
    siteId: raw,
    origin,
    pageUrl: buildSolcastToolkitRecentUrl(
      origin,
      "utility_scale_sites",
      raw,
      recentHours,
      period,
    ),
  };
}

function mergeCookiesIntoJar(jar, response) {
  if (!jar || !response?.headers || typeof response.headers.raw !== "function") {
    return;
  }
  const setCookies = response.headers.raw()["set-cookie"] || [];
  for (const entry of setCookies) {
    const first = String(entry || "").split(";")[0] || "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    if (!value) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function buildCookieHeader(jar) {
  if (!(jar instanceof Map) || !jar.size) return "";
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function escapeRegex(source) {
  return String(source || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractJsArrayLiteralByName(html, name) {
  const src = String(html || "");
  const re = new RegExp(`\\b${escapeRegex(name)}\\b\\s*=\\s*\\[`, "i");
  const match = re.exec(src);
  if (!match) return "";
  const start = src.indexOf("[", match.index);
  if (start < 0) return "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  return "";
}

function extractJsonParseArrayByName(html, name) {
  const src = String(html || "");
  const re = new RegExp(
    `\\b${escapeRegex(name)}\\b\\s*=\\s*JSON\\.parse\\((['"])([\\s\\S]*?)\\1\\)`,
    "i",
  );
  const match = re.exec(src);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[2]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(
      `Unable to parse Solcast toolkit ${name} JSON payload: ${err.message}`,
    );
  }
}

function evaluateJsArrayLiteral(literal, label) {
  if (!literal) return [];
  try {
    const result = vm.runInNewContext(`(${literal})`, Object.create(null), {
      timeout: 1000,
    });
    return Array.isArray(result) ? result : [];
  } catch (err) {
    throw new Error(`Unable to parse Solcast toolkit ${label} payload: ${err.message}`);
  }
}

function parseSolcastToolkitHtml(html) {
  const forecastsLiteral = extractJsArrayLiteralByName(html, "forecasts");
  const estActualsLiteral = extractJsArrayLiteralByName(html, "estActuals");
  const forecasts = forecastsLiteral
    ? evaluateJsArrayLiteral(forecastsLiteral, "forecasts")
    : extractJsonParseArrayByName(html, "forecasts");
  const estActuals = estActualsLiteral
    ? evaluateJsArrayLiteral(estActualsLiteral, "estimated actuals")
    : extractJsonParseArrayByName(html, "estActuals");
  if (!forecasts.length) {
    if (/auth\/credentials|name=\"userName\"|type=\"password\"/i.test(String(html || ""))) {
      throw new Error("Solcast toolkit login failed. Check the email and password.");
    }
    throw new Error("Solcast toolkit page did not expose forecast data.");
  }
  return {
    forecasts,
    estActuals,
    yLabelMw: /Power Output\s*\(MW\)/i.test(String(html || "")),
  };
}

function normalizeToolkitPowerValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(6));
}

function normalizeSolcastToolkitForecastRecords(records) {
  const out = [];
  for (const rec of records || []) {
    if (!rec || typeof rec !== "object") continue;
    const pvEstimate = normalizeToolkitPowerValue(
      rec?.pv_estimate ?? rec?.pvEstimate ?? rec?.pv_estimate_mean,
    );
    const pvEstimate10 = normalizeToolkitPowerValue(
      rec?.pv_estimate10 ?? rec?.pv_estimate_10 ?? rec?.pv_estimate_low,
    );
    const pvEstimate90 = normalizeToolkitPowerValue(
      rec?.pv_estimate90 ?? rec?.pv_estimate_90 ?? rec?.pv_estimate_high,
    );
    out.push({
      ...rec,
      period_end:
        rec?.period_end ??
        rec?.periodEnd ??
        rec?.period_end_utc ??
        rec?.periodEndUtc,
      period: rec?.period || SOLCAST_TOOLKIT_PERIOD,
      pv_estimate: pvEstimate,
      pv_estimate10:
        pvEstimate10 ?? (pvEstimate != null ? pvEstimate : null),
      pv_estimate90:
        pvEstimate90 ?? (pvEstimate != null ? pvEstimate : null),
    });
  }
  return out;
}

async function fetchSolcastToolkitForecastRecords(cfg, options = {}) {
  const site = parseSolcastToolkitSiteRef(cfg.toolkitSiteRef, cfg.baseUrl, {
    recentHours: options?.toolkitHours,
    period: options?.toolkitPeriod,
  });
  const cookieJar = new Map();
  const buildHeaders = (extra = {}) => {
    const headers = { ...extra };
    const cookie = buildCookieHeader(cookieJar);
    if (cookie) headers.Cookie = cookie;
    return headers;
  };

  const landing = await fetch(site.pageUrl, {
    timeout: SOLCAST_TIMEOUT_MS,
    headers: buildHeaders({
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
  });
  mergeCookiesIntoJar(cookieJar, landing);

  const authUrl = new URL("/auth/credentials", site.origin).toString();
  const authBody = new URLSearchParams({
    userName: cfg.toolkitEmail,
    password: cfg.toolkitPassword,
    rememberMe: "false",
    continue: site.pageUrl,
  }).toString();
  const authResp = await fetch(authUrl, {
    method: "POST",
    timeout: SOLCAST_TIMEOUT_MS,
    redirect: "manual",
    headers: buildHeaders({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: site.pageUrl,
    }),
    body: authBody,
  });
  mergeCookiesIntoJar(cookieJar, authResp);
  if (authResp.status >= 400) {
    const detail = String(await authResp.text().catch(() => "") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    throw new Error(
      `Solcast toolkit login failed (HTTP ${authResp.status}${detail ? ` - ${detail}` : ""}).`,
    );
  }

  const pageResp = await fetch(site.pageUrl, {
    timeout: SOLCAST_TIMEOUT_MS,
    headers: buildHeaders({
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: site.pageUrl,
    }),
  });
  mergeCookiesIntoJar(cookieJar, pageResp);
  if (!pageResp.ok) {
    const detail = String(await pageResp.text().catch(() => "") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    throw new Error(
      `Solcast toolkit page fetch failed (HTTP ${pageResp.status}${detail ? ` - ${detail}` : ""}).`,
    );
  }
  const html = await pageResp.text();
  const parsed = parseSolcastToolkitHtml(html);
  const records = normalizeSolcastToolkitForecastRecords(parsed.forecasts);
  if (!records.length) {
    throw new Error("Solcast toolkit page returned no forecast records.");
  }
  return {
    endpoint: site.pageUrl,
    records,
    estActuals: parsed.estActuals,
    accessMode: SOLCAST_ACCESS_MODE_TOOLKIT,
    siteType: site.siteType,
    siteId: site.siteId,
    units: parsed.yLabelMw
      ? "MW-average (converted to interval MWh / stored slot kWh)"
      : "toolkit chart power",
  };
}

async function fetchSolcastForecastRecords(cfg, options = {}) {
  return normalizeSolcastAccessMode(cfg.accessMode) ===
    SOLCAST_ACCESS_MODE_TOOLKIT
    ? fetchSolcastToolkitForecastRecords(cfg, options)
    : fetchSolcastApiForecastRecords(cfg);
}

function convertSolcastPowerToMwh(powerValue, durMin, accessMode) {
  const power = Number(powerValue);
  const minutes = Number(durMin);
  if (!Number.isFinite(power) || !Number.isFinite(minutes) || power <= 0 || minutes <= 0) {
    return null;
  }
  if (normalizeSolcastAccessMode(accessMode) === SOLCAST_ACCESS_MODE_TOOLKIT) {
    return Number((power * (minutes / 60)).toFixed(6));
  }
  return Number(((power * (minutes / 60)) / 1000).toFixed(6));
}

function convertSolcastPowerToMw(powerValue, accessMode) {
  const power = Number(powerValue);
  if (!Number.isFinite(power) || power <= 0) return null;
  if (normalizeSolcastAccessMode(accessMode) === SOLCAST_ACCESS_MODE_TOOLKIT) {
    return Number(power.toFixed(6));
  }
  return Number((power / 1000).toFixed(6));
}

function normalizeSolcastPreviewDayCount(value) {
  const n = Math.trunc(Number(value || 1));
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS, Math.max(1, n));
}

function computeSolcastPreviewHours(dayCount) {
  const count = normalizeSolcastPreviewDayCount(dayCount);
  return Math.max(
    SOLCAST_TOOLKIT_RECENT_HOURS,
    Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS, (count + 1) * 24),
  );
}

function listSolcastPreviewDays(forecastRecords, actualRecords, cfg) {
  const startMin = SOLCAST_SOLAR_START_H * 60;
  const endMin = SOLCAST_SOLAR_END_H * 60;
  const daySet = new Set();
  const pushDay = (rec) => {
    const endRaw =
      rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
    const endTs = Date.parse(String(endRaw || ""));
    if (!Number.isFinite(endTs) || endTs <= 0) return;
    const p = getTzParts(endTs, cfg.timeZone);
    if (p.minuteOfDay < startMin || p.minuteOfDay > endMin) return;
    daySet.add(p.date);
  };

  for (const rec of forecastRecords || []) pushDay(rec);
  for (const rec of actualRecords || []) pushDay(rec);
  return Array.from(daySet).sort();
}

function buildSolcastPreviewDaySeries(day, forecastRecords, actualRecords, cfg) {
  const accessMode = normalizeSolcastAccessMode(cfg?.accessMode);
  const startMin = SOLCAST_SOLAR_START_H * 60;
  const endMin = SOLCAST_SOLAR_END_H * 60;
  const actualMwhMap = new Map();
  const actualMwMap = new Map();
  const forecastMwhMap = new Map();
  const forecastMwMap = new Map();
  const forecastLoMwhMap = new Map();
  const forecastLoMwMap = new Map();
  const forecastHiMwhMap = new Map();
  const forecastHiMwMap = new Map();
  const pushRow = (rec, kind) => {
    const endRaw =
      rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
    const endTs = Date.parse(String(endRaw || ""));
    if (!Number.isFinite(endTs) || endTs <= 0) return;
    const p = getTzParts(endTs, cfg.timeZone);
    if (p.date !== day || p.minuteOfDay < startMin || p.minuteOfDay > endMin) return;
    const label = p.time.slice(0, 5);
    const durMin = parseIsoDurationToMinutes(
      rec?.period ?? rec?.period_duration ?? rec?.duration,
      SOLCAST_SLOT_MIN,
    );
    const mid = convertSolcastPowerToMwh(
      rec?.pv_estimate ??
        rec?.pvEstimate ??
        rec?.pv_estimate_mean ??
        rec?.pv_estimate_median,
      durMin,
      accessMode,
    );
    const midMw = convertSolcastPowerToMw(
      rec?.pv_estimate ??
        rec?.pvEstimate ??
        rec?.pv_estimate_mean ??
        rec?.pv_estimate_median,
      accessMode,
    );
    if (kind !== "forecast") {
      if (mid != null) actualMwhMap.set(label, mid);
      if (midMw != null) actualMwMap.set(label, midMw);
      return;
    }
    if (mid != null) forecastMwhMap.set(label, mid);
    if (midMw != null) forecastMwMap.set(label, midMw);
    const lo = convertSolcastPowerToMwh(
      rec?.pv_estimate10 ?? rec?.pv_estimate_10 ?? rec?.pv_estimate_low,
      durMin,
      accessMode,
    );
    const loMw = convertSolcastPowerToMw(
      rec?.pv_estimate10 ?? rec?.pv_estimate_10 ?? rec?.pv_estimate_low,
      accessMode,
    );
    const hi = convertSolcastPowerToMwh(
      rec?.pv_estimate90 ?? rec?.pv_estimate_90 ?? rec?.pv_estimate_high,
      durMin,
      accessMode,
    );
    const hiMw = convertSolcastPowerToMw(
      rec?.pv_estimate90 ?? rec?.pv_estimate_90 ?? rec?.pv_estimate_high,
      accessMode,
    );
    if (lo != null) forecastLoMwhMap.set(label, lo);
    if (loMw != null) forecastLoMwMap.set(label, loMw);
    if (hi != null) forecastHiMwhMap.set(label, hi);
    if (hiMw != null) forecastHiMwMap.set(label, hiMw);
  };

  for (const rec of forecastRecords || []) pushRow(rec, "forecast");
  for (const rec of actualRecords || []) pushRow(rec, "actual");

  const rows = [];
  let forecastTotalMwh = 0;
  let actualTotalMwh = 0;
  for (let minute = startMin; minute <= endMin; minute += SOLCAST_SLOT_MIN) {
    const hh = Math.floor(minute / 60);
    const mm = minute % 60;
    const label = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const forecastVal = forecastMwhMap.has(label)
      ? Number(forecastMwhMap.get(label))
      : null;
    const loVal = forecastLoMwhMap.has(label)
      ? Number(forecastLoMwhMap.get(label))
      : null;
    const hiVal = forecastHiMwhMap.has(label)
      ? Number(forecastHiMwhMap.get(label))
      : null;
    const actualVal = actualMwhMap.has(label) ? Number(actualMwhMap.get(label)) : null;
    const forecastMw = forecastMwMap.has(label)
      ? Number(forecastMwMap.get(label))
      : null;
    const forecastLoMw = forecastLoMwMap.has(label)
      ? Number(forecastLoMwMap.get(label))
      : null;
    const forecastHiMw = forecastHiMwMap.has(label)
      ? Number(forecastHiMwMap.get(label))
      : null;
    const actualMw = actualMwMap.has(label)
      ? Number(actualMwMap.get(label))
      : null;
    rows.push({
      date: day,
      time: label,
      period: SOLCAST_TOOLKIT_PERIOD,
      chartLabel: `${day.slice(5)} ${label}`,
      forecastMwh: forecastVal,
      forecastLoMwh: loVal,
      forecastHiMwh: hiVal,
      actualMwh: actualVal,
      forecastMw,
      forecastLoMw,
      forecastHiMw,
      actualMw,
    });
    if (forecastVal != null) forecastTotalMwh += forecastVal;
    if (actualVal != null) actualTotalMwh += actualVal;
  }

  return {
    day,
    rows,
    forecastTotalMwh: Number(forecastTotalMwh.toFixed(6)),
    actualTotalMwh: Number(actualTotalMwh.toFixed(6)),
    startTime: "05:00",
    endTime: "18:00",
  };
}

function buildSolcastPreviewSeries(startDay, dayCount, forecastRecords, actualRecords, cfg) {
  const availableDays = listSolcastPreviewDays(forecastRecords, actualRecords, cfg);
  const todayTz = localDateStrInTz(Date.now(), cfg.timeZone);
  const requestedStartDay = String(startDay || "").trim();
  const normalizedCount = normalizeSolcastPreviewDayCount(dayCount);
  const effectiveStartDay =
    requestedStartDay && availableDays.includes(requestedStartDay)
      ? requestedStartDay
      : availableDays.includes(todayTz)
        ? todayTz
        : availableDays[0] || requestedStartDay || todayTz;
  const startIdx = Math.max(0, availableDays.indexOf(effectiveStartDay));
  const selectedDays = availableDays.slice(startIdx, startIdx + normalizedCount);
  if (!selectedDays.length) {
    throw new Error("No Solcast samples are available inside the 05:00-18:00 window.");
  }

  const daySeries = selectedDays.map((day) =>
    buildSolcastPreviewDaySeries(day, forecastRecords, actualRecords, cfg),
  );
  const rows = daySeries.flatMap((entry) => entry.rows || []);
  if (!rows.length) {
    throw new Error(
      `No Solcast samples matched ${selectedDays[0]} within ${SOLCAST_SOLAR_START_H}:00-${SOLCAST_SOLAR_END_H}:00 (${cfg.timeZone}).`,
    );
  }

  const labels = rows.map((row) => row.chartLabel);
  const forecastMwh = rows.map((row) => row.forecastMwh);
  const forecastLoMwh = rows.map((row) => row.forecastLoMwh);
  const forecastHiMwh = rows.map((row) => row.forecastHiMwh);
  const actualMwh = rows.map((row) => row.actualMwh);
  const forecastMw = rows.map((row) => row.forecastMw);
  const forecastLoMw = rows.map((row) => row.forecastLoMw);
  const forecastHiMw = rows.map((row) => row.forecastHiMw);
  const actualMw = rows.map((row) => row.actualMw);
  const forecastTotalMwh = daySeries.reduce(
    (sum, entry) => sum + Number(entry?.forecastTotalMwh || 0),
    0,
  );
  const actualTotalMwh = daySeries.reduce(
    (sum, entry) => sum + Number(entry?.actualTotalMwh || 0),
    0,
  );
  const rangeStartDay = selectedDays[0];
  const rangeEndDay = selectedDays[selectedDays.length - 1];

  return {
    day: rangeStartDay,
    dayCount: selectedDays.length,
    selectedDays,
    daysCovered: availableDays,
    rangeStartDay,
    rangeEndDay,
    rangeLabel:
      rangeStartDay === rangeEndDay
        ? rangeStartDay
        : `${rangeStartDay} to ${rangeEndDay}`,
    labels,
    forecastMwh,
    forecastLoMwh,
    forecastHiMwh,
    actualMwh,
    forecastMw,
    forecastLoMw,
    forecastHiMw,
    actualMw,
    rows,
    forecastTotalMwh: Number(forecastTotalMwh.toFixed(6)),
    actualTotalMwh: Number(actualTotalMwh.toFixed(6)),
    startTime: "05:00",
    endTime: "18:00",
  };
}

function buildDayAheadRowsFromSolcast(day, records, cfg) {
  const slotKwh = new Array(288).fill(0);
  const slotLo = new Array(288).fill(0);
  const slotHi = new Array(288).fill(0);
  let matched = 0;
  const slotMs = SOLCAST_SLOT_MIN * 60000;
  const startMin = SOLCAST_SOLAR_START_H * 60;
  const endMin = SOLCAST_SOLAR_END_H * 60;
  const accessMode = normalizeSolcastAccessMode(cfg?.accessMode);
  const powerToKwh = (value, hours) => {
    const power = Number(value);
    if (!Number.isFinite(power) || power <= 0 || !(hours > 0)) return 0;
    if (accessMode === SOLCAST_ACCESS_MODE_TOOLKIT) {
      return power * hours * 1000;
    }
    return power * hours;
  };

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
        slotKwh[slot] += powerToKwh(kw, overlapH);
        slotLo[slot] += powerToKwh(kwLo, overlapH);
        slotHi[slot] += powerToKwh(kwHi, overlapH);
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

function buildSolcastSnapshotRows(day, records, estActuals, cfg) {
  const accessMode = normalizeSolcastAccessMode(cfg?.accessMode);
  const slotMs = SOLCAST_SLOT_MIN * 60000;
  const startMin = SOLCAST_SOLAR_START_H * 60;
  const endMin = SOLCAST_SOLAR_END_H * 60;
  const KWH_PER_MW = 1000 * (SOLCAST_SLOT_MIN / 60);

  // Per-slot accumulators for forecast (MW weighted by overlap hours)
  const slotData = new Array(288).fill(null).map(() => ({
    sumMwH: 0, sumLoH: 0, sumHiH: 0, overlapH: 0,
    period_end_utc: null, period: null,
  }));

  // Build estActual MW map keyed by slot index
  const estActualMwBySlot = new Map();
  for (const rec of estActuals || []) {
    const endRaw =
      rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
    const endTs = Date.parse(String(endRaw || ""));
    if (!Number.isFinite(endTs) || endTs <= 0) continue;
    const p = getTzParts(endTs, cfg.timeZone);
    if (p.date !== day || p.minuteOfDay < startMin || p.minuteOfDay >= endMin) continue;
    const slot = Math.floor(p.minuteOfDay / SOLCAST_SLOT_MIN);
    const mw = convertSolcastPowerToMw(
      rec?.pv_estimate ?? rec?.pvEstimate ?? rec?.pv_estimate_mean ?? rec?.pv_estimate_median,
      accessMode,
    );
    if (mw != null) estActualMwBySlot.set(slot, mw);
  }

  // Accumulate forecast records into per-slot MW*h buckets
  let matched = 0;
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
    const mw = convertSolcastPowerToMw(
      rec?.pv_estimate ?? rec?.pvEstimate ?? rec?.pv_estimate_mean ?? rec?.pv_estimate_median,
      accessMode,
    );
    const loMw = convertSolcastPowerToMw(
      rec?.pv_estimate10 ?? rec?.pv_estimate_10 ?? rec?.pv_estimate_low,
      accessMode,
    ) ?? mw;
    const hiMw = convertSolcastPowerToMw(
      rec?.pv_estimate90 ?? rec?.pv_estimate_90 ?? rec?.pv_estimate_high,
      accessMode,
    ) ?? mw;
    if (mw == null && loMw == null && hiMw == null) continue;

    let segStart = startTs;
    while (segStart < endTs) {
      const boundary = Math.min(endTs, (Math.floor(segStart / slotMs) + 1) * slotMs);
      const segEnd = boundary > segStart ? boundary : Math.min(endTs, segStart + slotMs);
      const midTs = segStart + Math.floor((segEnd - segStart) / 2);
      const p = getTzParts(midTs, cfg.timeZone);
      if (p.date === day && p.minuteOfDay >= startMin && p.minuteOfDay < endMin) {
        const slot = Math.floor(p.minuteOfDay / SOLCAST_SLOT_MIN);
        const overlapH = (segEnd - segStart) / 3600000;
        const d = slotData[slot];
        if (mw   != null) d.sumMwH += mw   * overlapH;
        if (loMw != null) d.sumLoH += loMw * overlapH;
        if (hiMw != null) d.sumHiH += hiMw * overlapH;
        d.overlapH += overlapH;
        d.period_end_utc = String(periodEndRaw);
        d.period = rec?.period ?? rec?.period_duration ?? rec?.duration ?? null;
        matched += 1;
      }
      segStart = segEnd;
    }
  }

  if (!matched) {
    throw new Error(
      `No Solcast samples matched ${day} within ${SOLCAST_SOLAR_START_H}:00-${SOLCAST_SOLAR_END_H}:00 (${cfg.timeZone}).`,
    );
  }

  const rows = [];
  for (let slot = startMin / SOLCAST_SLOT_MIN; slot < endMin / SOLCAST_SLOT_MIN; slot++) {
    const hh = Math.floor((slot * SOLCAST_SLOT_MIN) / 60);
    const mm = (slot * SOLCAST_SLOT_MIN) % 60;
    const ts_local = zonedDateTimeToUtcMs(day, hh, mm, 0, cfg.timeZone);
    const d = slotData[slot];
    const oh = d.overlapH > 0 ? d.overlapH : 0;
    const forecast_mw    = oh > 0 ? Number((d.sumMwH / oh).toFixed(6)) : null;
    const forecast_lo_mw = oh > 0 ? Number((d.sumLoH / oh).toFixed(6)) : null;
    const forecast_hi_mw = oh > 0 ? Number((d.sumHiH / oh).toFixed(6)) : null;
    const est_actual_mw  = estActualMwBySlot.has(slot)
      ? Number(estActualMwBySlot.get(slot).toFixed(6)) : null;
    rows.push({
      slot,
      ts_local: Number.isFinite(ts_local) ? Number(ts_local) : 0,
      period_end_utc: d.period_end_utc,
      period: d.period,
      forecast_mw,
      forecast_lo_mw,
      forecast_hi_mw,
      est_actual_mw,
      forecast_kwh:    forecast_mw    != null ? Number((forecast_mw    * KWH_PER_MW).toFixed(6)) : null,
      forecast_lo_kwh: forecast_lo_mw != null ? Number((forecast_lo_mw * KWH_PER_MW).toFixed(6)) : null,
      forecast_hi_kwh: forecast_hi_mw != null ? Number((forecast_hi_mw * KWH_PER_MW).toFixed(6)) : null,
      est_actual_kwh:  est_actual_mw  != null ? Number((est_actual_mw  * KWH_PER_MW).toFixed(6)) : null,
    });
  }
  return rows;
}

function persistSolcastSnapshot(day, rows, source, pulledTs) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  try {
    bulkUpsertSolcastSnapshot(String(day || ""), rows, source, pulledTs);
    return rows.length;
  } catch (err) {
    console.warn(`[solcast-snapshot] persist failed for ${day}:`, err.message);
    return 0;
  }
}

function buildAndPersistSolcastSnapshot(day, records, estActuals, cfg, source, pulledTs) {
  try {
    const snapshotRows = buildSolcastSnapshotRows(day, records, estActuals || [], cfg);
    const persistedRows = persistSolcastSnapshot(day, snapshotRows, source, pulledTs);
    if (snapshotRows.length && persistedRows !== snapshotRows.length) {
      return {
        ok: false,
        builtRows: Number(snapshotRows.length || 0),
        persistedRows: Number(persistedRows || 0),
        warning:
          `Solcast snapshot persist failed for ${day} ` +
          `(${Number(persistedRows || 0)}/${Number(snapshotRows.length || 0)} rows saved).`,
      };
    }
    return {
      ok: true,
      builtRows: Number(snapshotRows.length || 0),
      persistedRows: Number(persistedRows || 0),
      warning: "",
    };
  } catch (err) {
    const msg = String(err?.message || err || "unknown snapshot error").trim();
    console.warn(`[solcast-snapshot] ${day}:`, msg);
    return {
      ok: false,
      builtRows: 0,
      persistedRows: 0,
      warning: `Solcast snapshot skipped for ${day}: ${msg}`,
    };
  }
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
  const _lat = Number(getSetting("plantLatitude", WEATHER_LAT));
  const _lon = Number(getSetting("plantLongitude", WEATHER_LON));
  const url =
    `${base}?latitude=${_lat}&longitude=${_lon}` +
    `&daily=${encodeURIComponent(WEATHER_DAILY_FIELDS)}` +
    `&start_date=${encodeURIComponent(startDay)}` +
    `&end_date=${encodeURIComponent(endDay)}` +
    `&timezone=${encodeURIComponent(WEATHER_TZ)}`;

  try {
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
  } catch (err) {
    // Network error or API failure — serve stale cache if available, even past TTL.
    if (cached && Array.isArray(cached.rows) && cached.rows.length) {
      console.warn(`[weather] API unavailable (${err.message}); serving stale cache for ${key}`);
      return cached.rows;
    }
    throw err; // No stale data available — propagate so route returns 500
  }
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
  const exitCode = Number(result?.code ?? -1);
  if (exitCode !== 0) {
    const details = String(result?.stderr || result?.stdout || "")
      .trim()
      .slice(-2000);
    throw new Error(`ML forecast generator failed (code ${exitCode}). ${details || ""}`.trim());
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
    if (normalizeSolcastAccessMode(cfg.accessMode) === SOLCAST_ACCESS_MODE_TOOLKIT) {
      throw new Error(
        "Solcast toolkit mode is selected but the site reference, email, or password is incomplete.",
      );
    }
    throw new Error(
      "Solcast API mode is selected but the API key, resource ID, or base URL is incomplete. Switch Access Mode to Toolkit Login if you want to use only the toolkit URL, email, and password.",
    );
  }
  const { endpoint, records, estActuals, accessMode } = await fetchSolcastForecastRecords(cfg);
  const pulledTs = Date.now();
  let writtenRows = 0;
  let snapshotRowsPersisted = 0;
  const snapshotWarnings = [];
  for (const day of dates) {
    const rows = buildDayAheadRowsFromSolcast(day, records, cfg);
    bulkUpsertForecastDayAhead(day, rows, "solcast");
    writtenRows += Number(rows.length || 0);
    const snapshotResult = buildAndPersistSolcastSnapshot(
      day,
      records,
      estActuals || [],
      cfg,
      accessMode,
      pulledTs,
    );
    snapshotRowsPersisted += Number(snapshotResult?.persistedRows || 0);
    if (!snapshotResult?.ok && snapshotResult?.warning) {
      snapshotWarnings.push(String(snapshotResult.warning));
    }
  }
  const normalizedRows = normalizeForecastDbWindow();
  return {
    providerUsed: "solcast",
    accessMode,
    endpoint,
    writtenRows,
    snapshotRowsPersisted,
    snapshotWarnings,
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
    rows = queryReadingsRangeAll(s, e).map((r) => ({
      inverter: r.inverter,
      unit: r.unit,
      ts: r.ts,
      pac: r.pac,
      online: r.online,
    }));
  } else {
    rows = queryReadingsRange(Number(inverter), s, e).map((r) => ({
      inverter: r.inverter,
      unit: r.unit,
      ts: r.ts,
      pac: r.pac,
      online: r.online,
    }));
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

  const resultMap = sumEnergy5minByInverterRange(startTs, endTs);

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
const PAST_REPORT_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
const pastReportSummaryCache = new Map(); // day -> { ts, summary }

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

function cloneReportSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return JSON.parse(JSON.stringify(summary));
}

function getPastReportSummaryCached(day, now = Date.now()) {
  const key = String(day || "").trim();
  if (!key) return null;
  const entry = pastReportSummaryCache.get(key);
  if (!entry) return null;
  if (Number(now || Date.now()) - Number(entry.ts || 0) > PAST_REPORT_SUMMARY_CACHE_TTL_MS) {
    pastReportSummaryCache.delete(key);
    return null;
  }
  return cloneReportSummary(entry.summary);
}

function setPastReportSummaryCache(day, summary, now = Date.now()) {
  const key = String(day || "").trim();
  if (!key || !summary || typeof summary !== "object") return;
  pastReportSummaryCache.set(key, {
    ts: Number(now || Date.now()),
    summary: cloneReportSummary(summary),
  });
}

function getSummaryIntervalsForRow(summaryRow) {
  let intervals = [];
  try {
    const parsed = JSON.parse(String(summaryRow?.intervals_json || "[]"));
    if (Array.isArray(parsed)) {
      intervals = parsed
        .map((pair) => {
          if (!Array.isArray(pair) || pair.length < 2) return null;
          const start = Number(pair[0] || 0);
          const end = Number(pair[1] || 0);
          return end > start && start > 0 ? [start, end] : null;
        })
        .filter(Boolean);
    }
  } catch (_) {
    intervals = [];
  }
  const lastTs = Number(summaryRow?.last_ts || 0);
  if (Number(summaryRow?.last_online || 0) === 1 && lastTs > 0) {
    intervals.push([lastTs, lastTs + 1000]);
  }
  return intervals;
}

function computeOnlineSecondsFromIntervals(intervals, window = null) {
  let clipped = Array.isArray(intervals) ? intervals.slice() : [];
  if (window?.startTs > 0 && window?.endTs > window.startTs) {
    clipped = clipIntervalsToWindowMs(clipped, window.startTs, window.endTs);
  }
  return sumMergedIntervalsMs(clipped) / 1000;
}

function normalizePersistedDailyReportRow(row, day, ipCfg = null) {
  const safeRow = row && typeof row === "object" ? { ...row } : {};
  const reportDay = parseIsoDateStrict(String(day || safeRow?.date || localDateStr()), "date");
  const inv = Number(safeRow?.inverter || 0);
  const configuredUnits = inv > 0 ? getConfiguredUnitsForReportInverter(ipCfg || loadIpConfigFromDb(), inv) : [];
  const expectedNodesRaw = Number(safeRow?.expected_nodes || 0);
  const expectedNodes = expectedNodesRaw > 0
    ? Math.max(1, Math.min(REPORT_MAX_NODES_PER_INVERTER, Math.trunc(expectedNodesRaw)))
    : getReportActiveNodeCount(configuredUnits, new Map());
  const ratedKw = Number(safeRow?.rated_kw || 0) > 0
    ? Number(safeRow?.rated_kw || 0)
    : getReportRatedKwForNodeCount(expectedNodes);
  const uptimeS = Math.max(0, Number(safeRow?.uptime_s || 0));
  const windowS = getReportSolarWindowSeconds(reportDay, reportDay === localDateStr());
  const availabilityPct = Number(safeRow?.availability_pct);
  const performancePct = Number(safeRow?.performance_pct);
  const kwhTotal = Math.max(0, Number(safeRow?.kwh_total || 0));
  const perfDenom = ratedKw > 0 ? ratedKw * (uptimeS / 3600) : 0;

  safeRow.date = reportDay;
  safeRow.expected_nodes = expectedNodes;
  safeRow.rated_kw = Number(ratedKw.toFixed(3));
  safeRow.availability_pct = Number(
    clampPct(Number.isFinite(availabilityPct) ? availabilityPct : (windowS > 0 ? (uptimeS / windowS) * 100 : 0)).toFixed(3),
  );
  safeRow.performance_pct = Number(
    clampPct(Number.isFinite(performancePct) ? performancePct : (perfDenom > 0 ? (kwhTotal / perfDenom) * 100 : 0)).toFixed(3),
  );
  safeRow.node_uptime_s = Math.max(0, Math.round(Number(safeRow?.node_uptime_s || 0)));
  safeRow.expected_node_uptime_s = Math.max(
    0,
    Math.round(Number(safeRow?.expected_node_uptime_s || windowS * expectedNodes)),
  );
  safeRow.control_count = Math.max(0, Math.trunc(Number(safeRow?.control_count || 0)));
  return safeRow;
}

function normalizePersistedDailyReportRows(rows, day) {
  const ipCfg = loadIpConfigFromDb();
  return (Array.isArray(rows) ? rows : []).map((row) =>
    normalizePersistedDailyReportRow(row, day || row?.date || localDateStr(), ipCfg),
  );
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

      const persisted = stmts.getDailyReport.all(day);
      if (persisted.length) {
        const normalized = normalizePersistedDailyReportRows(persisted, day);
        setPastDailyReportRowsCache(day, normalized);
        return cloneDailyReportRows(normalized);
      }
    }

    const rebuilt = buildDailyReportRowsForDate(day, {
      persist,
      refresh,
      includeTodayPartial: false,
    });
    setPastDailyReportRowsCache(day, rebuilt);
    return cloneDailyReportRows(rebuilt);
  }

  return buildDailyReportRowsForDate(day, {
    persist,
    refresh,
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
// mistakenly counted as uptime â€" the old lastTs-firstTs span formula would
// credit the entire gap regardless of what happened inside it.
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

function clipIntervalsToWindowMs(intervals, startMs, endMs) {
  const start = Number(startMs || 0);
  const end = Number(endMs || 0);
  if (!(start > 0) || !(end > start)) return [];
  return (Array.isArray(intervals) ? intervals : [])
    .map(([rawStart, rawEnd]) => {
      const clippedStart = Math.max(start, Number(rawStart || 0));
      const clippedEnd = Math.min(end, Number(rawEnd || 0));
      return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
    })
    .filter(Boolean);
}

function sumMergedIntervalsMs(intervals) {
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
  return totalMs;
}

function computeNodeOnlineSeconds(rows, maxGapS = AVAIL_MAX_GAP_S, window = null) {
  let intervals = buildNodeOnlineIntervalsMs(rows, maxGapS);
  if (window?.startTs > 0 && window?.endTs > window.startTs) {
    intervals = clipIntervalsToWindowMs(intervals, window.startTs, window.endTs);
  }
  return sumMergedIntervalsMs(intervals) / 1000;
}

function computeInverterOnlineSeconds(rowsByUnit, maxGapS = AVAIL_MAX_GAP_S, window = null) {
  const byUnit = rowsByUnit instanceof Map ? rowsByUnit : new Map();
  let intervals = [];
  for (const unitRows of byUnit.values()) {
    intervals.push(...buildNodeOnlineIntervalsMs(unitRows, maxGapS));
  }
  if (window?.startTs > 0 && window?.endTs > window.startTs) {
    intervals = clipIntervalsToWindowMs(intervals, window.startTs, window.endTs);
  }
  return sumMergedIntervalsMs(intervals) / 1000;
}

function getReportSolarWindowBounds(day, includeTodayPartial = true) {
  const d = parseIsoDateStrict(day || localDateStr(), "date");
  const today = localDateStr();
  if (d > today) {
    return { startTs: 0, endTs: 0, seconds: 0 };
  }
  const hh = (n) => String(Math.trunc(Number(n) || 0)).padStart(2, "0");
  const startTs = new Date(`${d}T${hh(REPORT_SOLAR_START_H)}:00:00.000`).getTime();
  let endTs = new Date(`${d}T${hh(REPORT_SOLAR_END_H)}:00:00.000`).getTime();
  if (includeTodayPartial && d === today) {
    endTs = Math.min(endTs, Date.now());
  }
  return {
    startTs,
    endTs,
    seconds: Math.max(0, (endTs - startTs) / 1000),
  };
}

function getReportSolarWindowSeconds(day, includeTodayPartial = true) {
  return getReportSolarWindowBounds(day, includeTodayPartial).seconds;
}

function getConfiguredUnitsForReportInverter(cfg, inverter) {
  const unitsRaw =
    cfg?.units?.[inverter] ??
    cfg?.units?.[String(inverter)] ??
    [1, 2, 3, 4];
  const units = Array.isArray(unitsRaw)
    ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= REPORT_MAX_NODES_PER_INVERTER)
    : [1, 2, 3, 4];
  return [...new Set(units)].sort((a, b) => a - b);
}

function getReportActiveNodeCount(configuredUnits, rowsByUnit) {
  const configuredCount = Array.isArray(configuredUnits) ? configuredUnits.length : 0;
  if (configuredCount > 0) return configuredCount;
  const observedCount = rowsByUnit instanceof Map ? rowsByUnit.size : 0;
  if (observedCount > 0) {
    return Math.max(1, Math.min(REPORT_MAX_NODES_PER_INVERTER, observedCount));
  }
  return REPORT_MAX_NODES_PER_INVERTER;
}

function getReportRatedKwForNodeCount(nodeCount) {
  const count = Math.max(
    0,
    Math.min(REPORT_MAX_NODES_PER_INVERTER, Number(nodeCount || 0)),
  );
  if (count <= 0) return 0;
  return (REPORT_UNIT_KW_MAX * count) / REPORT_MAX_NODES_PER_INVERTER;
}

function buildDailyReportRowsForDate(dateText, options = {}) {
  const persist = options.persist !== false;
  const refresh = options.refresh === true;
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
  const pacKwhByInv = sumEnergy5minByInverterRange(startTs, endTs);

  if (day === localDateStr() && includeTodayPartial) {
    const supplementalRows = getTodayEnergySupplementRows(day);
    for (const { inverter, total_kwh } of supplementalRows) {
      const inv = Number(inverter || 0);
      if (inv <= 0 || !(total_kwh > 0)) continue;
      pacKwhByInv.set(inv, Math.max(pacKwhByInv.get(inv) || 0, total_kwh));
    }
  }

  const reportWindow = getReportSolarWindowBounds(day, includeTodayPartial);
  const expectedSolarWindowS = Number(reportWindow.seconds || 0);
  const ipCfg = loadIpConfigFromDb();
  const persistedRows = normalizePersistedDailyReportRows(stmts.getDailyReport.all(day), day);
  const persistedByInv = new Map(
    persistedRows.map((row) => [Number(row?.inverter || 0), row]),
  );

  let summaryRows = refresh ? rebuildDailyReadingsSummaryForDate(day) : getDailyReadingsSummaryRows(day);
  if ((!summaryRows || !summaryRows.length) && day <= localDateStr()) {
    summaryRows = rebuildDailyReadingsSummaryForDate(day);
  }
  const summaryByInv = new Map();
  for (const row of summaryRows || []) {
    const inv = Number(row?.inverter || 0);
    if (!(inv > 0)) continue;
    if (!summaryByInv.has(inv)) summaryByInv.set(inv, []);
    summaryByInv.get(inv).push(row);
  }

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
    const persistedRow = persistedByInv.get(inv) || null;
    const alarmCountRaw = alarmCountByInv.get(inv) || 0;
    const controlCountRaw = auditCountByInv.get(inv) || 0;
    const alarmCount = day < localDateStr()
      ? Math.max(alarmCountRaw, Number(persistedRow?.alarm_count || 0))
      : alarmCountRaw;
    const controlCount = day < localDateStr()
      ? Math.max(controlCountRaw, Number(persistedRow?.control_count || 0))
      : controlCountRaw;
    const pacKwh = Number(pacKwhByInv.get(inv) || 0);
    const configuredUnits = getConfiguredUnitsForReportInverter(ipCfg, inv);
    const configuredUnitSet = new Set(configuredUnits);
    const allRows = summaryByInv.get(inv) || [];
    const rows = configuredUnits.length
      ? allRows.filter((r) => configuredUnitSet.has(Number(r?.unit || 0)))
      : allRows;
    const hasLiveData =
      rows.length > 0 ||
      pacKwh > 0 ||
      alarmCount > 0 ||
      controlCount > 0 ||
      Boolean(persistedRow);
    if (!hasLiveData) continue;
    if (!rows.length && persistedRow) {
      const fallbackRow = normalizePersistedDailyReportRow(
        {
          ...persistedRow,
          date: day,
          inverter: inv,
          alarm_count: Math.max(alarmCount, Number(persistedRow?.alarm_count || 0)),
          control_count: Math.max(controlCount, Number(persistedRow?.control_count || 0)),
        },
        day,
        ipCfg,
      );
      out.push(fallbackRow);
      continue;
    }

    const rowsByUnit = new Map();
    const perUnitUptime = [];
    let allIntervals = [];
    let pacPeak = 0;
    let pacOnlineSum = 0;
    let pacOnlineCount = 0;
    for (const r of rows) {
      const unit = Number(r?.unit || 0);
      if (unit < 1) continue;
      rowsByUnit.set(unit, r);
      pacPeak = Math.max(pacPeak, Number(r?.pac_peak || 0));
      pacOnlineSum += Number(r?.pac_online_sum || 0);
      pacOnlineCount += Number(r?.pac_online_count || 0);
      const intervals = getSummaryIntervalsForRow(r);
      allIntervals.push(...intervals);
      perUnitUptime.push({
        unit,
        uptimeS: computeOnlineSecondsFromIntervals(intervals, reportWindow),
      });
    }

    const pacAvg = pacOnlineCount > 0 ? pacOnlineSum / pacOnlineCount : 0;
    const activeNodeCount = getReportActiveNodeCount(configuredUnits, rowsByUnit);
    const ratedKw = getReportRatedKwForNodeCount(activeNodeCount);
    const uptimeS = computeOnlineSecondsFromIntervals(allIntervals, reportWindow);
    perUnitUptime.sort(
      (a, b) =>
        Number(b.uptimeS || 0) - Number(a.uptimeS || 0) ||
        Number(a.unit || 0) - Number(b.unit || 0),
    );
    const nodeUptimeS = perUnitUptime
      .slice(0, activeNodeCount)
      .reduce((s, r) => s + Math.max(0, Number(r?.uptimeS || 0)), 0);

    let kwhTotal = Math.max(0, pacKwh);
    if (kwhTotal <= 0 && rows.length >= 1) {
      let regTotal = 0;
      for (const r of rows) {
        const firstKwh = Number(r?.first_kwh || 0);
        const lastKwh = Number(r?.last_kwh || firstKwh);
        const diff = lastKwh - firstKwh;
        if (Number.isFinite(diff) && diff > 0) regTotal += diff;
      }
      if (regTotal > 0) kwhTotal = regTotal;
    }

    const expectedNodeUptimeS = expectedSolarWindowS * activeNodeCount;
    const availabilityPct =
      expectedSolarWindowS > 0 ? (uptimeS / expectedSolarWindowS) * 100 : 0;
    const uptimeH = uptimeS / 3600;
    const perfDenomKwh = ratedKw * uptimeH;
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
      expected_nodes: activeNodeCount,
      rated_kw: Number(ratedKw.toFixed(3)),
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
        row.availability_pct,
        row.performance_pct,
        row.node_uptime_s,
        row.expected_node_uptime_s,
        row.expected_nodes,
        row.rated_kw,
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
    const expectedNodes = Math.max(
      0,
      Math.min(
        REPORT_MAX_NODES_PER_INVERTER,
        Number(row?.expected_nodes || REPORT_MAX_NODES_PER_INVERTER),
      ),
    );
    const ratedKw =
      Number(row?.rated_kw || 0) ||
      getReportRatedKwForNodeCount(expectedNodes || REPORT_MAX_NODES_PER_INVERTER);
    const rowDenom = Math.max(0, ratedKw * uph);

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
  const today = localDateStr();
  const selectedDate = new Date(`${day}T00:00:00.000`);
  const dow = selectedDate.getDay(); // 0=Sunday ... 6=Saturday
  const weekStartDate = new Date(selectedDate.getTime());
  weekStartDate.setDate(weekStartDate.getDate() - dow);
  const weekStart = localDateStr(weekStartDate.getTime());
  const weekEnd = addDaysIso(weekStart, 6);
  const dates = daysInclusive(weekStart, weekEnd);
  const canCacheSummary = day < today && weekEnd < today;
  if (canCacheSummary && !refreshDay) {
    const cached = getPastReportSummaryCached(day);
    if (cached) return cached;
  }

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
  const summary = {
    date: day,
    week_start: weekStart,
    week_end: weekEnd,
    daily: summarizeDailyReportRows(dailyRows),
    weekly: summarizeDailyReportRows(weeklyRows),
  };
  if (canCacheSummary) setPastReportSummaryCache(day, summary);
  return summary;
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
      remoteHealth: buildRemoteHealthSnapshot(),
      settings: {
        inverterCount: Number(getSetting("inverterCount", 27)),
        plantName: getSetting("plantName", "ADSI Plant"),
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

function resolveGatewayChatIdentity(req) {
  if (isLoopbackRequest(req)) {
    return buildLocalChatIdentity();
  }
  const fromMachine = normalizeChatMachine(req?.body?.from_machine, "remote");
  const toMachine = normalizeChatMachine(
    req?.body?.to_machine,
    getOppositeChatMachine(fromMachine),
  );
  if (toMachine !== getOppositeChatMachine(fromMachine)) {
    const err = new Error("Invalid chat route.");
    err.httpStatus = 400;
    throw err;
  }
  const fromName = String(req?.body?.from_name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return {
    from_machine: fromMachine,
    to_machine: toMachine,
    from_name:
      fromName ||
      buildChatDisplayName(
        fromMachine,
        getSetting("operatorName", "OPERATOR"),
      ),
  };
}

app.post("/api/chat/send", async (req, res) => {
  let message = "";
  try {
    message = sanitizeChatMessageText(req?.body?.message);
    if (isRemoteMode()) {
      const identity = buildLocalChatIdentity("remote");
      const payload = await requestRemoteChat("/api/chat/send", {
        method: "POST",
        body: {
          message,
          ...identity,
        },
        timeout: CHAT_PROXY_TIMEOUT_MS,
      });
      const row = normalizeChatRow(payload?.row);
      if (!row) throw new Error("Gateway returned an invalid chat row.");
      broadcastUpdate({ type: "chat", row });
      return res.json({ ok: true, row });
    }

    const identity = resolveGatewayChatIdentity(req);
    const row = insertChatMessage(
      {
        ts: Date.now(),
        ...identity,
        message,
        read_ts: null,
      },
      CHAT_RETENTION_COUNT,
    );
    broadcastUpdate({ type: "chat", row });
    return res.json({ ok: true, row });
  } catch (err) {
    const status = Math.max(400, Math.min(599, Number(err?.httpStatus || 502)));
    const rawMessage = String(err?.message || err || "Message send failed.");
    const error =
      isRemoteMode() && /remote gateway|fetch failed|timed out|econnrefused|connect/i.test(rawMessage)
        ? "Gateway unavailable. Message not sent."
        : rawMessage;
    return res.status(status).json({ ok: false, error });
  }
});

app.get("/api/chat/messages", async (req, res) => {
  try {
    const mode = String(req?.query?.mode || "thread")
      .trim()
      .toLowerCase();
    const limit = Math.max(
      1,
      Math.min(
        mode === "thread" ? CHAT_THREAD_LIMIT : REMOTE_CHAT_POLL_LIMIT,
        Math.trunc(Number(req?.query?.limit || (mode === "thread" ? CHAT_THREAD_LIMIT : REMOTE_CHAT_POLL_LIMIT))),
      ),
    );
    const afterId = Math.max(0, Math.trunc(Number(req?.query?.afterId || 0)));
    const machine = normalizeChatMachine(
      req?.query?.machine,
      isRemoteMode() ? "remote" : readOperationMode(),
    );

    if (isRemoteMode()) {
      const qs = new URLSearchParams({
        mode: mode === "inbox" ? "inbox" : "thread",
        limit: String(limit),
      });
      if (mode === "inbox") {
        qs.set("machine", machine);
        qs.set("afterId", String(afterId));
      }
      const payload = await requestRemoteChat(`/api/chat/messages?${qs.toString()}`, {
        method: "GET",
        timeout: CHAT_PROXY_TIMEOUT_MS,
        retry: {
          attempts: 2,
          baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
        },
      });
      const rows = normalizeChatRows(payload?.rows);
      if (mode === "thread") {
        updateRemoteChatCursorFromRows(rows, "remote");
        remoteChatBridgeState.primed = true;
      } else if (mode === "inbox") {
        updateRemoteChatCursorFromRows(rows, machine);
        remoteChatBridgeState.primed = true;
      }
      return res.json({ ok: true, rows });
    }

    if (mode === "inbox") {
      const rows = getChatInboxAfterId(machine, afterId, limit).map(normalizeChatRow).filter(Boolean);
      return res.json({ ok: true, rows });
    }
    const rows = getChatThread(limit).map(normalizeChatRow).filter(Boolean);
    return res.json({ ok: true, rows });
  } catch (err) {
    const status = Math.max(400, Math.min(599, Number(err?.httpStatus || 502)));
    return res.status(status).json({
      ok: false,
      error: String(err?.message || err || "Chat history request failed."),
    });
  }
});

app.post("/api/chat/read", async (req, res) => {
  try {
    const upToId = Math.max(0, Math.trunc(Number(req?.body?.upToId || 0)));
    if (isRemoteMode()) {
      const payload = await requestRemoteChat("/api/chat/read", {
        method: "POST",
        body: {
          upToId,
          machine: "remote",
        },
        timeout: CHAT_PROXY_TIMEOUT_MS,
        retry: {
          attempts: 2,
          baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
        },
      });
      return res.json({
        ok: true,
        updated: Math.max(0, Math.trunc(Number(payload?.updated || 0))),
      });
    }

    const machine = isLoopbackRequest(req)
      ? readOperationMode()
      : normalizeChatMachine(req?.body?.machine, readOperationMode());
    const updated = markChatReadUpToId(machine, upToId, Date.now());
    return res.json({ ok: true, updated });
  } catch (err) {
    const status = Math.max(400, Math.min(599, Number(err?.httpStatus || 502)));
    return res.status(status).json({
      ok: false,
      error: String(err?.message || err || "Chat read update failed."),
    });
  }
});

app.post("/api/chat/clear", async (req, res) => {
  try {
    if (isRemoteMode()) {
      const payload = await requestRemoteChat("/api/chat/clear", {
        method: "POST",
        body: {},
        timeout: CHAT_PROXY_TIMEOUT_MS,
        retry: {
          attempts: 2,
          baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
        },
      });
      broadcastUpdate({ type: "chat_clear" });
      return res.json({
        ok: true,
        cleared: Math.max(0, Math.trunc(Number(payload?.cleared || 0))),
      });
    }

    const cleared = clearAllChatMessages();
    broadcastUpdate({ type: "chat_clear" });
    return res.json({ ok: true, cleared });
  } catch (err) {
    const status = Math.max(400, Math.min(599, Number(err?.httpStatus || 502)));
    return res.status(status).json({
      ok: false,
      error: String(err?.message || err || "Chat clear failed."),
    });
  }
});

app.get("/api/replication/manual-scope", (req, res) => {
  res.json({ ok: true, scope: buildManualReplicationScope() });
});

app.get("/api/replication/job-status", (req, res) => {
  res.json({ ok: true, job: snapshotManualReplicationJob() });
});

app.get("/api/replication/archive-manifest", (req, res) => {
  try {
    const manifest = listLocalArchiveManifest();
    sendJsonMaybeGzip(req, res, {
      ok: true,
      manifest,
      summary: summarizeArchiveManifest(manifest),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/replication/archive-download", async (req, res) => {
  const fileName = sanitizeArchiveFileName(req.query?.file || "");
  if (!fileName) {
    return res.status(400).json({ ok: false, error: "Invalid archive file." });
  }
  const monthKey = monthKeyFromArchiveFileName(fileName);
  closeArchiveDbForMonth(monthKey);
  try {
    const resolved = resolveArchiveFileForTransfer(fileName);
    if (!resolved?.path) {
      throw new Error("Archive file not found.");
    }
    const totalBytes = Math.max(0, Number(resolved.size || 0));
    const sha256 = await hashFileSha256(resolved.path);
    const useGzip = shouldGzipReplicationStream(req, totalBytes);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("x-archive-size", String(totalBytes));
    res.setHeader("x-archive-sha256", sha256);
    res.setHeader(
      "x-archive-mtime",
      String(Math.max(0, Number(resolved.mtimeMs || 0))),
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    if (!useGzip) {
      res.setHeader("Content-Length", String(totalBytes));
      await pipeline(createTransferReadStream(resolved.path), res);
      return;
    }
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    await pipeline(createTransferReadStream(resolved.path), createReplicationGzipStream(), res);
    return;
  } catch (err) {
    return res.status(404).json({ ok: false, error: "Archive file not found." });
  }
});

app.post("/api/replication/archive-upload", async (req, res) => {
  const fileName = sanitizeArchiveFileName(req.query?.file || "");
  if (!fileName) {
    return res.status(400).json({ ok: false, error: "Invalid archive file." });
  }
  const monthKey = monthKeyFromArchiveFileName(fileName);
  const tempPath = path.join(ARCHIVE_DIR, `${fileName}.upload-${Date.now()}.tmp`);
  const expectedSize = Math.max(0, Number(req.headers["x-archive-size"] || 0));
  const expectedMtimeMs = Math.max(0, Number(req.headers["x-archive-mtime"] || Date.now()));
  const expectedSha256 = String(req.headers["x-archive-sha256"] || "").trim().toLowerCase();
  let recvBytes = 0;
  try {
    await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
    closeArchiveDbForMonth(monthKey);
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "start",
      recvBytes: 0,
      totalBytes: expectedSize,
      chunkCount: 1,
      label: `Receiving archive ${fileName}`,
    });
    req.on("data", (chunk) => {
      recvBytes += Math.max(0, Buffer.byteLength(chunk || Buffer.alloc(0)));
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "chunk",
        recvBytes,
        totalBytes: expectedSize,
        chunk: 1,
        chunkCount: 1,
        label: `Receiving archive ${fileName}`,
      });
    });
    await pipeline(req, createTransferWriteStream(tempPath));
    const verified = await verifyTransferredFile(tempPath, {
      expectedSize: expectedSize > 0 ? expectedSize : recvBytes,
      expectedSha256,
    });
    const mtime = new Date(expectedMtimeMs);
    await fs.promises.utimes(tempPath, mtime, mtime);
    stagePendingArchiveReplacement({
      name: fileName,
      monthKey,
      tempName: path.basename(tempPath),
      size: Math.max(0, Number(verified?.size || expectedSize || recvBytes || 0)),
      mtimeMs: expectedMtimeMs,
    });
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "done",
      recvBytes,
      totalBytes: expectedSize > 0 ? expectedSize : recvBytes,
      chunkCount: 1,
      importedRows: 1,
      label: `Receiving archive ${fileName}`,
    });
    return res.json({
      ok: true,
      file: {
        name: fileName,
        monthKey,
        size: expectedSize > 0 ? expectedSize : recvBytes,
        mtimeMs: expectedMtimeMs,
        staged: true,
      },
    });
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore temp cleanup failures.
    }
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "error",
      recvBytes,
      totalBytes: expectedSize > 0 ? expectedSize : recvBytes,
      chunkCount: 1,
      label: `Receiving archive ${fileName}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/replication/main-db", async (req, res) => {
  if (isRemotePullOnlyMode()) {
    return res.status(409).json({
      ok: false,
      error: "Replication is disabled in Client pull-only mode.",
    });
  }
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }

  let snapshot = null;
  let sentBytes = 0;
  try {
    snapshot = await createGatewayMainDbSnapshotForTransfer();
    const fileName = "adsi.db";
    const totalBytes = Math.max(0, Number(snapshot?.size || 0));
    const targetMtimeMs = Math.max(0, Number(snapshot?.mtimeMs || Date.now()));
    const stream = createTransferReadStream(snapshot.tempPath);
    const useGzip = shouldGzipReplicationStream(req, totalBytes);

    broadcastUpdate({
      type: "xfer_progress",
      dir: "tx",
      phase: "start",
      sentBytes: 0,
      totalBytes,
      chunkCount: 1,
      label: "Sending main database",
    });

    stream.on("data", (chunk) => {
      sentBytes += Math.max(0, Buffer.byteLength(chunk || Buffer.alloc(0)));
      broadcastUpdate({
        type: "xfer_progress",
        dir: "tx",
        phase: "chunk",
        sentBytes,
        totalBytes,
        chunk: 1,
        chunkCount: 1,
        label: "Sending main database",
      });
    });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("x-main-db-size", String(totalBytes));
    res.setHeader("x-main-db-mtime", String(targetMtimeMs));
    res.setHeader("x-main-db-sha256", String(snapshot?.sha256 || ""));
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    if (!useGzip) {
      res.setHeader("Content-Length", String(totalBytes));
      await pipeline(stream, res);
    } else {
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      await pipeline(stream, createReplicationGzipStream(), res);
    }
    broadcastUpdate({
      type: "xfer_progress",
      dir: "tx",
      phase: "done",
      sentBytes,
      totalBytes,
      chunkCount: 1,
      importedRows: 1,
      label: "Sending main database",
    });
  } catch (err) {
    broadcastUpdate({
      type: "xfer_progress",
      dir: "tx",
      phase: "error",
      sentBytes,
      totalBytes: Math.max(0, Number(snapshot?.size || sentBytes || 0)),
      chunkCount: 1,
      label: "Sending main database",
    });
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  } finally {
    if (snapshot?.tempPath) {
      try {
        await fs.promises.unlink(snapshot.tempPath);
      } catch (_) {
        // Ignore temp snapshot cleanup failures.
      }
    }
  }
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
    sendJsonMaybeGzip(req, res, { ok: true, summary });
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
    sendJsonMaybeGzip(req, res, { ok: true, snapshot });
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
    sendJsonMaybeGzip(req, res, { ok: true, delta });
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
    const totalBytes = Math.max(0, Number(meta?.totalBytes || 0));
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
          totalBytes,
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
        totalBytes,
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
        totalBytes,
        label: "Receiving push",
      });
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "chunk",
        recvBytes: Math.max(0, recvBytes),
        totalBytes,
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
          totalBytes,
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
        totalBytes,
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
      totalBytes,
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
  const includeArchive = req?.body?.includeArchive !== false;
  const background = req?.body?.background !== false;
  const forcePull = Boolean(req?.body?.forcePull);
  try {
    if (background) {
      const started = startManualReplicationJob(
        "pull",
        {
          includeArchive,
          summary: "Queued background pull from gateway.",
          runningSummary: "Checking gateway state, then pulling and staging the gateway main database.",
        },
        () => runManualPullSync(base, includeArchive, forcePull),
      );
      if (!started?.started) {
        return res.status(202).json({
          ok: false,
          error: "Replication already in progress.",
          background: true,
          job: started?.job || snapshotManualReplicationJob(),
        });
      }
      return res.status(202).json({
        ok: true,
        background: true,
        includeArchive,
        forcePull,
        job: started.job,
        message:
          "Background pull started. Gateway state will be checked first, then the gateway main database will be staged for restart-safe replacement.",
      });
    }

    const result = await runManualPullSync(base, includeArchive, forcePull);
    return res.json({
      ok: true,
      background: false,
      includeArchive,
      forcePull,
      result,
      direction: String(remoteBridgeState.lastSyncDirection || "idle"),
    });
  } catch (err) {
    if (err?.code === "LOCAL_NEWER_PUSH_FAILED") {
      return res.status(409).json({
        ok: false,
        code: "LOCAL_NEWER_PUSH_FAILED",
        canForcePull: true,
        error: String(err?.message || err),
      });
    }
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
  const includeArchive = req?.body?.includeArchive !== false;
  const background = req?.body?.background !== false;
  try {
    if (background) {
      const started = startManualReplicationJob(
        "push",
        {
          includeArchive,
          summary: "Queued background push to gateway.",
          runningSummary: "Pushing local replicated data to gateway. Local database will not be changed.",
        },
        () => runManualPushSync(base, includeArchive),
      );
      if (!started?.started) {
        return res.status(202).json({
          ok: false,
          error: "Replication already in progress.",
          background: true,
          job: started?.job || snapshotManualReplicationJob(),
        });
      }
      return res.status(202).json({
        ok: true,
        background: true,
        includeArchive,
        job: started.job,
        message:
          "Background push started. Local replicated data will be sent to the gateway. Local database will not be changed.",
      });
    }

    const result = await runManualPushSync(base, includeArchive);
    return res.json({
      ok: true,
      background: false,
      includeArchive,
      result,
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
    const check = await checkLocalNewerBeforePull(base);
    if (!check?.ok) {
      return res.status(502).json({
        ok: false,
        error: String(check?.error || "Gateway state check failed."),
        check,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    if (check.localNewer && !forcePull) {
      return res.status(409).json({
        ok: false,
        code: "LOCAL_NEWER_PUSH_FAILED",
        canForcePull: true,
        error:
          "Local data is newer than the gateway. Use Push first, or retry with forcePull to overwrite local data from the gateway.",
        check,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }
    if (forcePull) {
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
        check,
        mode: String(incremental.mode || "incremental"),
        incremental,
        direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      });
    }

    return res.status(502).json({
      ok: false,
      error: `Manual catch-up pull failed: ${String(
        incremental?.error || "unknown error",
      )}. Ensure gateway and client are on the same build.`,
      check,
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

app.get("/api/settings", (req, res) => {
  res.json(buildSettingsSnapshot());
});

app.get("/api/settings/defaults", (req, res) => {
  try {
    res.json({
      ok: true,
      settings: buildDefaultSettingsSnapshot(),
      cloudBackupSettings: _cloudBackup.getDefaultSettings(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
    pastDailyReportCache.clear();
    pastReportSummaryCache.clear();
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
  const retainDaysBefore = Math.max(1, Number(getSetting("retainDays", 90)));
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
    solcastAccessMode,
    solcastApiKey,
    solcastResourceId,
    solcastToolkitEmail,
    solcastToolkitPassword,
    solcastToolkitSiteRef,
    solcastTimezone,
    exportUiState,
    inverterPollConfig,
    plantLatitude,
    plantLongitude,
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
    updates.retainDays = clampInt(retainDays, 1, 1095, 90);
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
  if (solcastAccessMode !== undefined) {
    const mode = normalizeSolcastAccessMode(solcastAccessMode);
    if (
      mode !== SOLCAST_ACCESS_MODE_API &&
      mode !== SOLCAST_ACCESS_MODE_TOOLKIT
    ) {
      return res.status(400).json({ ok: false, error: "Invalid solcastAccessMode" });
    }
    updates.solcastAccessMode = mode;
  }
  if (solcastApiKey !== undefined) {
    const key = String(solcastApiKey || "").trim();
    updates.solcastApiKey = key.slice(0, 256);
  }
  if (solcastResourceId !== undefined) {
    const rid = String(solcastResourceId || "").trim();
    updates.solcastResourceId = rid.slice(0, 120);
  }
  const effectiveSolcastBaseUrl =
    String(
      updates.solcastBaseUrl ??
        getSetting("solcastBaseUrl", "https://api.solcast.com.au") ??
        "https://api.solcast.com.au",
    ).trim() || "https://api.solcast.com.au";
  if (solcastToolkitEmail !== undefined) {
    const email = String(solcastToolkitEmail || "").trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Invalid solcastToolkitEmail" });
    }
    updates.solcastToolkitEmail = email.slice(0, 200);
  }
  if (solcastToolkitPassword !== undefined) {
    const pwd = String(solcastToolkitPassword || "").trim();
    updates.solcastToolkitPassword = pwd.slice(0, 256);
  }
  if (solcastToolkitSiteRef !== undefined) {
    const ref = String(solcastToolkitSiteRef || "").trim();
    if (ref) {
      try {
        parseSolcastToolkitSiteRef(ref, effectiveSolcastBaseUrl);
      } catch (err) {
        return res.status(400).json({
          ok: false,
          error: `Invalid solcastToolkitSiteRef: ${err.message}`,
        });
      }
    }
    updates.solcastToolkitSiteRef = ref.slice(0, 500);
  }
  if (solcastTimezone !== undefined) {
    const tz = String(solcastTimezone || "").trim();
    if (tz && !/^[A-Za-z0-9_.+\-]+(?:\/[A-Za-z0-9_.+\-]+)*$/.test(tz)) {
      return res.status(400).json({ ok: false, error: "Invalid solcastTimezone" });
    }
    updates.solcastTimezone = (tz || "Asia/Manila").slice(0, 80);
  }
  if (plantLatitude !== undefined) {
    const lat = Number(plantLatitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90)
      return res.status(400).json({ ok: false, error: "plantLatitude must be between -90 and 90" });
    updates.plantLatitude = String(lat);
  }
  if (plantLongitude !== undefined) {
    const lon = Number(plantLongitude);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180)
      return res.status(400).json({ ok: false, error: "plantLongitude must be between -180 and 180" });
    updates.plantLongitude = String(lon);
  }
  if (exportUiState !== undefined) {
    updates.exportUiState = JSON.stringify(sanitizeExportUiState(exportUiState));
  }
  if (inverterPollConfig !== undefined) {
    updates.inverterPollConfig = JSON.stringify(sanitizePollConfig(inverterPollConfig));
  }

  const effectiveMode = sanitizeOperationMode(
    updates.operationMode !== undefined ? updates.operationMode : modeBefore,
    modeBefore,
  );
  const effectiveRemoteGatewayUrl = String(
    updates.remoteGatewayUrl !== undefined
      ? updates.remoteGatewayUrl
      : remoteGatewayBefore,
  ).trim();
  if (effectiveMode === "remote") {
    if (!effectiveRemoteGatewayUrl) {
      return res.status(400).json({
        ok: false,
        error:
          "Remote mode requires a configured Remote Gateway URL. Enter the gateway address first, then save again.",
      });
    }
    if (isUnsafeRemoteLoop(effectiveRemoteGatewayUrl)) {
      return res.status(400).json({
        ok: false,
        error:
          "Remote mode cannot use localhost or 127.0.0.1 as the gateway URL. Use the gateway workstation IP, hostname, or Tailscale address.",
      });
    }
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
    if (modeAfter === "remote") {
      setTimeout(() => {
        kickRemoteBridgeNow("settings-refresh").catch(() => {});
      }, 25);
    }
  }
  if (
    updates.inverterCount !== undefined ||
    updates.nodeCount !== undefined
  ) {
    pastDailyReportCache.clear();
    pastReportSummaryCache.clear();
  }
  if (updates.remoteAutoSync === "0") {
    remoteBridgeState.autoSyncAttempted = false;
  }
  let retentionApplied = null;
  if (updates.retainDays !== undefined) {
    const retainDaysAfter = Math.max(1, Number(updates.retainDays || retainDaysBefore));
    if (retainDaysAfter !== retainDaysBefore) {
      retentionApplied = pruneOldData({ vacuum: retainDaysAfter < retainDaysBefore });
    }
  }
  const snapshot = buildSettingsSnapshot();
  res.json({
    ok: true,
    csvSavePath: exportDirResolved || getSetting("csvSavePath", "C:\\Logs\\InverterDashboard"),
    exportDirCreated,
    settings: snapshot,
    retentionApplied,
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
    remoteLiveFailureCount: Number(remoteBridgeState.liveFailureCount || 0),
    remoteLastFailureTs: Number(remoteBridgeState.lastFailureTs || 0),
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
    remoteHealth: buildRemoteHealthSnapshot(),
    remoteReplicationCursors: normalizeReplicationCursors(
      isRemotePullOnlyMode()
        ? {}
        : remoteBridgeState.replicationCursors || readReplicationCursorsSetting(),
    ),
    manualReplicationJob: snapshotManualReplicationJob(),
    manualReplicationScope: buildManualReplicationScope(),
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
    const r = await fetchWithRetry(
      `${base}/api/live`,
      {
        method: "GET",
        headers: buildRemoteProxyHeaders(token),
        timeout: Math.max(REMOTE_FETCH_TIMEOUT_MS, 15000),
      },
      {
        attempts: REMOTE_LIVE_FETCH_RETRIES,
        baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
      },
    );
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

app.post("/api/runtime/network/reconnect", async (req, res) => {
  const result = await kickRemoteBridgeNow("manual-reconnect");
  if (/available only in Remote mode/i.test(String(result?.error || ""))) {
    return res.status(400).json({
      ok: false,
      error: String(result?.error || "Remote bridge refresh failed."),
      connected: false,
      liveNodeCount: Number(result?.liveNodeCount || 0),
      lastSuccessTs: Number(result?.lastSuccessTs || 0),
      lastError: String(result?.lastError || result?.error || ""),
      remoteHealth: result?.remoteHealth || buildRemoteHealthSnapshot(),
    });
  }
  return res.json({
    ok: Boolean(result?.ok),
    degraded: Boolean(result?.degraded),
    error: String(result?.error || ""),
    connected: Boolean(result?.connected),
    liveNodeCount: Number(result?.liveNodeCount || 0),
    lastSuccessTs: Number(result?.lastSuccessTs || 0),
    lastError: String(result?.lastError || ""),
    remoteHealth: result?.remoteHealth || buildRemoteHealthSnapshot(),
  });
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

  try {
    const baseRows = scopedInv
      ? queryEnergy5minRange(scopedInv, s, e)
      : queryEnergy5minRangeAll(s, e);

    if (pagedMode) {
      const safeLimit = clampInt(limit, 100, 5000, 500);
      const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
      const rows = baseRows
        .slice()
        .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0) || Number(a?.inverter || 0) - Number(b?.inverter || 0))
        .slice(safeOffset, safeOffset + safeLimit);

      let totalKwh = 0;
      let latestTs = 0;
      let peak = { inverter: 0, ts: 0, kwhInc: 0 };
      const inverterSet = new Set();
      for (const row of baseRows) {
        const inv = Number(row?.inverter || 0);
        const ts = Number(row?.ts || 0);
        const kwhInc = Number(row?.kwh_inc || 0);
        if (inv > 0) inverterSet.add(inv);
        totalKwh += kwhInc;
        if (ts > latestTs) latestTs = ts;
        if (
          kwhInc > Number(peak.kwhInc || 0) ||
          (kwhInc === Number(peak.kwhInc || 0) && ts > Number(peak.ts || 0))
        ) {
          peak = { inverter: inv, ts, kwhInc };
        }
      }

      res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
      return res.json({
        ok: true,
        rows,
        total: baseRows.length,
        limit: safeLimit,
        offset: safeOffset,
        hasMore: safeOffset + rows.length < baseRows.length,
        summary: {
          rowCount: baseRows.length,
          totalKwh: Number(totalKwh.toFixed(6)),
          avgKwh: baseRows.length > 0 ? Number((totalKwh / baseRows.length).toFixed(6)) : 0,
          latestTs,
          inverterCount: inverterSet.size,
          peak: {
            inverter: Number(peak.inverter || 0),
            ts: Number(peak.ts || 0),
            kwhInc: Number(Number(peak.kwhInc || 0).toFixed(6)),
          },
        },
      });
    }

    const capLimit = ENERGY_5MIN_UNPAGED_ROW_CAP;
    if (baseRows.length > capLimit) {
      return res.status(400).json({
        ok: false,
        error: `Date range too large: use paged=1 with limit/offset or narrow the range. Exceeded ${capLimit} row cap.`,
        rowCap: capLimit,
      });
    }
    res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
    return res.json(baseRows);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Energy read failed." });
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
      ? queryEnergy5minRangeAll(s, e).slice(0, ENERGY_5MIN_UNPAGED_ROW_CAP)
      : queryEnergy5minRange(Number(inverter), s, e).slice(0, ENERGY_5MIN_UNPAGED_ROW_CAP);

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
  const { date, start, end, bucketMin, product } = req.query;
  const parsedStart = parseDateMs(start, NaN, false);
  const parsedEnd = parseDateMs(end, NaN, true);
  const targetDate = String(
    date || (Number.isFinite(parsedStart) ? localDateStr(parsedStart) : localDateStr()),
  ).trim();
  const solarWindow = getForecastSolarWindowBounds(targetDate);
  const productKey = String(product || "dayahead").trim().toLowerCase();
  let rows =
    productKey === "intraday" || productKey === "intraday-adjusted"
      ? getIntradayAdjustedRowsForDate(targetDate)
      : getDayAheadRowsForDate(targetDate);
  const s = Number.isFinite(parsedStart)
    ? Math.max(parsedStart, solarWindow.startTs)
    : solarWindow.startTs;
  const e = Number.isFinite(parsedEnd)
    ? Math.min(parsedEnd, solarWindow.endTs)
    : solarWindow.endTs;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
    return res.json([]);
  }
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
    const accessMode = normalizeSolcastAccessMode(cfg.accessMode);
    if (accessMode === SOLCAST_ACCESS_MODE_TOOLKIT) {
      if (!cfg.toolkitEmail) {
        return res.status(400).json({
          ok: false,
          error: "Solcast toolkit email is required.",
        });
      }
      if (!cfg.toolkitPassword) {
        return res.status(400).json({
          ok: false,
          error: "Solcast toolkit password is required.",
        });
      }
      if (!cfg.toolkitSiteRef) {
        return res.status(400).json({
          ok: false,
          error: "Solcast toolkit site URL or site ID is required.",
        });
      }
      try {
        parseSolcastToolkitSiteRef(cfg.toolkitSiteRef, cfg.baseUrl);
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    } else {
      if (!cfg.apiKey) {
        return res.status(400).json({
          ok: false,
          error:
            "Solcast API key is required. Switch Access Mode to Toolkit Login if you want to use email and password only.",
        });
      }
      if (!cfg.resourceId) {
        return res.status(400).json({
          ok: false,
          error:
            "Solcast resource ID is required. Switch Access Mode to Toolkit Login if you want to use the toolkit chart URL instead.",
        });
      }
    }
    if (!/^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(cfg.timeZone)) {
      return res.status(400).json({ ok: false, error: "Invalid Solcast timezone format." });
    }

    const started = Date.now();
    const { endpoint, records, estActuals, units } = await fetchSolcastForecastRecords(cfg);
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
    const snapshotResult = buildAndPersistSolcastSnapshot(
      tomorrowTz,
      records,
      estActuals || [],
      cfg,
      accessMode,
      started,
    );

    return res.json({
      ok: true,
      provider: "solcast",
      accessMode,
      endpoint,
      durationMs: Date.now() - started,
      records: Number(records.length || 0),
      estimatedActuals: Number(estActuals?.length || 0),
      units: String(units || "").trim() || "provider payload",
      timezone: cfg.timeZone,
      firstPeriodEndIso: validTs.length ? new Date(validTs[0]).toISOString() : "",
      lastPeriodEndIso: validTs.length
        ? new Date(validTs[validTs.length - 1]).toISOString()
        : "",
      daysCovered: Array.from(daySet).sort(),
      snapshotOk: !!snapshotResult?.ok,
      snapshotRowsPersisted: Number(snapshotResult?.persistedRows || 0),
      snapshotWarning: String(snapshotResult?.warning || ""),
      dayAheadPreview: preview,
      warning,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/forecast/solcast/preview", async (req, res) => {
  try {
    const cfg = buildSolcastConfigFromInput(req.body || {});
    if (!isHttpUrl(cfg.baseUrl)) {
      return res.status(400).json({ ok: false, error: "Invalid Solcast Base URL." });
    }
    const accessMode = normalizeSolcastAccessMode(cfg.accessMode);
    if (accessMode === SOLCAST_ACCESS_MODE_TOOLKIT) {
      if (!cfg.toolkitEmail) {
        return res.status(400).json({
          ok: false,
          error: "Solcast toolkit email is required.",
        });
      }
      if (!cfg.toolkitPassword) {
        return res.status(400).json({
          ok: false,
          error: "Solcast toolkit password is required.",
        });
      }
      if (!cfg.toolkitSiteRef) {
        return res.status(400).json({
          ok: false,
          error: "Solcast toolkit site URL or site ID is required.",
        });
      }
      try {
        parseSolcastToolkitSiteRef(cfg.toolkitSiteRef, cfg.baseUrl);
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    } else {
      if (!cfg.apiKey) {
        return res.status(400).json({
          ok: false,
          error:
            "Solcast API key is required. Switch Access Mode to Toolkit Login if you want to use email and password only.",
        });
      }
      if (!cfg.resourceId) {
        return res.status(400).json({
          ok: false,
          error:
            "Solcast resource ID is required. Switch Access Mode to Toolkit Login if you want to use the toolkit chart URL instead.",
        });
      }
    }
    if (!/^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(cfg.timeZone)) {
      return res.status(400).json({ ok: false, error: "Invalid Solcast timezone format." });
    }

    const requestedDay = String(req.body?.day || "").trim();
    const requestedDayCount = normalizeSolcastPreviewDayCount(req.body?.dayCount || 1);
    const started = Date.now();
    const { endpoint, records, estActuals, units } = await fetchSolcastForecastRecords(cfg, {
      toolkitHours: computeSolcastPreviewHours(requestedDayCount),
    });
    const preview = buildSolcastPreviewSeries(
      requestedDay || localDateStrInTz(Date.now(), cfg.timeZone),
      requestedDayCount,
      records,
      estActuals || [],
      cfg,
    );
    let snapshotRowsPersisted = 0;
    const snapshotWarnings = [];
    for (const day of (preview.selectedDays?.length ? preview.selectedDays : [preview.day])) {
      const snapshotResult = buildAndPersistSolcastSnapshot(
        day,
        records,
        estActuals || [],
        cfg,
        accessMode,
        started,
      );
      snapshotRowsPersisted += Number(snapshotResult?.persistedRows || 0);
      if (!snapshotResult?.ok && snapshotResult?.warning) {
        snapshotWarnings.push(String(snapshotResult.warning));
      }
    }
    return res.json({
      ok: true,
      provider: "solcast",
      accessMode,
      endpoint,
      durationMs: Date.now() - started,
      units: String(units || "").trim() || "provider payload",
      timezone: cfg.timeZone,
      day: preview.day,
      dayCount: preview.dayCount,
      selectedDays: preview.selectedDays,
      rangeStartDay: preview.rangeStartDay,
      rangeEndDay: preview.rangeEndDay,
      rangeLabel: preview.rangeLabel,
      daysCovered: preview.daysCovered,
      startTime: preview.startTime,
      endTime: preview.endTime,
      labels: preview.labels,
      forecastMwh: preview.forecastMwh,
      forecastLoMwh: preview.forecastLoMwh,
      forecastHiMwh: preview.forecastHiMwh,
      actualMwh: preview.actualMwh,
      forecastMw: preview.forecastMw,
      forecastLoMw: preview.forecastLoMw,
      forecastHiMw: preview.forecastHiMw,
      actualMw: preview.actualMw,
      rows: preview.rows,
      forecastTotalMwh: preview.forecastTotalMwh,
      actualTotalMwh: preview.actualTotalMwh,
      snapshotOk: snapshotWarnings.length === 0,
      snapshotRowsPersisted,
      snapshotWarnings,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/export/solcast-preview", async (req, res) => {
  try {
    const cfg = buildSolcastConfigFromInput(req.body || {});
    if (!isHttpUrl(cfg.baseUrl)) {
      return res.status(400).json({ ok: false, error: "Invalid Solcast Base URL." });
    }
    const accessMode = normalizeSolcastAccessMode(cfg.accessMode);
    if (accessMode === SOLCAST_ACCESS_MODE_TOOLKIT) {
      if (!cfg.toolkitEmail) {
        return res.status(400).json({ ok: false, error: "Solcast toolkit email is required." });
      }
      if (!cfg.toolkitPassword) {
        return res.status(400).json({ ok: false, error: "Solcast toolkit password is required." });
      }
      if (!cfg.toolkitSiteRef) {
        return res.status(400).json({ ok: false, error: "Solcast toolkit site URL or site ID is required." });
      }
      try {
        parseSolcastToolkitSiteRef(cfg.toolkitSiteRef, cfg.baseUrl);
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    } else {
      if (!cfg.apiKey) {
        return res.status(400).json({
          ok: false,
          error:
            "Solcast API key is required. Switch Access Mode to Toolkit Login if you want to use email and password only.",
        });
      }
      if (!cfg.resourceId) {
        return res.status(400).json({
          ok: false,
          error:
            "Solcast resource ID is required. Switch Access Mode to Toolkit Login if you want to use the toolkit chart URL instead.",
        });
      }
    }
    if (!/^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(cfg.timeZone)) {
      return res.status(400).json({ ok: false, error: "Invalid Solcast timezone format." });
    }

    const requestedDay = String(req.body?.day || "").trim();
    const requestedDayCount = normalizeSolcastPreviewDayCount(req.body?.dayCount || 1);
    const { records, estActuals } = await fetchSolcastForecastRecords(cfg, {
      toolkitHours: computeSolcastPreviewHours(requestedDayCount),
    });
    const preview = buildSolcastPreviewSeries(
      requestedDay || localDateStrInTz(Date.now(), cfg.timeZone),
      requestedDayCount,
      records,
      estActuals || [],
      cfg,
    );
    const outPath = await exporter.exportSolcastPreview({
      rows: preview.rows,
      startDay: preview.rangeStartDay,
      endDay: preview.rangeEndDay,
      format: "xlsx",
    });
    return res.json({
      ok: true,
      path: outPath,
      day: preview.day,
      dayCount: preview.dayCount,
      rangeStartDay: preview.rangeStartDay,
      rangeEndDay: preview.rangeEndDay,
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
      snapshotRowsPersisted: Number(generation.snapshotRowsPersisted || 0),
      snapshotWarnings: Array.isArray(generation.snapshotWarnings)
        ? generation.snapshotWarnings
        : [],
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
    const today = localDateStr();
    // For ranges that include today, compute today live (partial-day window) and
    // merge with persisted past rows. The raw DB range query returns stale
    // persisted availability_pct for today and must not be used for it.
    if (e >= today && s <= today) {
      const dayBeforeToday = localDateStr(new Date(`${today}T00:00:00.000`).getTime() - 1);
      const pastRows = normalizePersistedDailyReportRows(
        s < today ? stmts.getDailyReportRange.all(s, dayBeforeToday) : [],
      );
      const todayRows = getDailyReportRowsForDay(today, {
        persist: true,
        includeTodayPartial: true,
        refresh: refreshRequested,
      });
      const merged = [...pastRows, ...todayRows].sort(
        (a, b) =>
          String(a.date || "").localeCompare(String(b.date || "")) ||
          Number(a.inverter || 0) - Number(b.inverter || 0),
      );
      res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
      return res.json(merged);
    }
    res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
    return res.json(
      normalizePersistedDailyReportRows(stmts.getDailyReportRange.all(s, e)),
    );
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/api/report/payload", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const _t0 = Date.now();
  try {
    const requestedDate = parseIsoDateStrict(req.query?.date || localDateStr(), "date");
    const refreshRequested = ["1", "true", "yes", "on"].includes(
      String(req.query?.refresh || "")
        .trim()
        .toLowerCase(),
    );
    const latestDate = getLatestReportDate();
    let date = requestedDate;
    let rows = getDailyReportRowsForDay(date, {
      persist: true,
      includeTodayPartial: date === localDateStr(),
      refresh: refreshRequested,
    });
    let fallbackUsed = false;

    if ((!Array.isArray(rows) || rows.length === 0) && latestDate && latestDate !== date) {
      date = latestDate;
      rows = getDailyReportRowsForDay(date, {
        persist: true,
        includeTodayPartial: date === localDateStr(),
        refresh: false,
      });
      fallbackUsed = true;
    }

    const summary = buildDailyWeeklyReportSummary(date, {
      refreshDay: refreshRequested && date === requestedDate,
    });
    res.setHeader("X-Perf-Ms", String(Date.now() - _t0));
    return res.json({
      ok: true,
      requestedDate,
      date,
      latestDate: latestDate || "",
      fallbackUsed,
      rows: Array.isArray(rows) ? rows : [],
      summary,
    });
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

function getEnergySummarySupplementRowsForRange(startTs, endTs) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const today = localDateStr();
  const todayStart = new Date(`${today}T00:00:00.000`).getTime();
  const todayEnd = new Date(`${today}T23:59:59.999`).getTime();
  if (e < todayStart || s > todayEnd) return [];
  return getTodayEnergySupplementRows(today);
}

function buildEnergySummarySourceRows(payload = {}) {
  const s = Number(payload?.startTs || 0) || Date.now() - 86400000;
  const e = Number(payload?.endTs || 0) || Date.now();
  return exporter.buildEnergySummaryExportRows(s, e, payload?.inverter, {
    supplementalTodayRows: getEnergySummarySupplementRowsForRange(s, e),
  });
}

app.post("/api/energy/summary-source", async (req, res) => {
  try {
    const rows = buildEnergySummarySourceRows(req.body || {});
    return res.json({ ok: true, rows });
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
    const payload = req.body || {};
    const outPath = await exporter.exportEnergy({
      ...payload,
      supplementalTodayRows: getEnergySummarySupplementRowsForRange(
        payload?.startTs,
        payload?.endTs,
      ),
    });
    return res.json({ ok: true, path: outPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
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

const pendingArchiveApplyResult = applyPendingArchiveReplacementsSync();
if (Number(pendingArchiveApplyResult?.applied || 0) > 0) {
  console.log(
    `[archive] Applied ${Number(pendingArchiveApplyResult.applied || 0)} staged archive replacement(s) on startup.`,
  );
}
if (Number(pendingArchiveApplyResult?.failed || 0) > 0) {
  console.warn(
    `[archive] ${Number(pendingArchiveApplyResult.failed || 0)} staged archive replacement(s) still pending after startup.`,
  );
}

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
      const storedRows = countStoredForecastRows("forecast_dayahead");
      if (storedRows <= 0) {
        const r = syncDayAheadFromContextIfNewer(true);
        if (r?.changed) {
          console.log(
            `[Forecast] Day-ahead sync -> DB: days=${Number(r.days || 0)} rows=${Number(r.rows || 0)}`,
          );
        }
      } else {
        console.log(
          `[Forecast] Startup legacy context import skipped; forecast_dayahead already has ${storedRows} stored row(s).`,
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
  startKeepAlive();
  applyRuntimeMode();
  if (process.send) process.send("ready");
});

// â"€â"€â"€ Cloud Backup API Routes â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

/** GET /api/backup/settings  â€" return cloud backup settings */
app.get("/api/backup/settings", (req, res) => {
  try {
    const s = _cloudBackup.getCloudSettingsForClient();
    res.json({ ok: true, settings: s, connected: _tokenStore.listConnected() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/settings  â€" save cloud backup settings */
app.post("/api/backup/settings", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
    const clearGDriveClientSecret = Boolean(body.clearGDriveClientSecret);
    delete body.clearGDriveClientSecret;
    const saved = _cloudBackup.saveCloudSettings(body, {
      clearGDriveClientSecret,
    });
    res.json({ ok: true, settings: _cloudBackup.getCloudSettingsForClient(saved) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/auth/:provider/start  â€" begin OAuth flow */
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

/** POST /api/backup/auth/:provider/callback  â€" complete OAuth token exchange */
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

/** POST /api/backup/auth/:provider/disconnect  â€" revoke stored tokens */
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

/** GET /api/backup/status  â€" connection status + progress */
app.get("/api/backup/status", (req, res) => {
  res.json({
    ok: true,
    connected: _tokenStore.listConnected(),
    progress: _cloudBackup.getProgress(),
  });
});

/** GET /api/backup/progress  â€" current operation progress */
app.get("/api/backup/progress", (req, res) => {
  res.json({ ok: true, progress: _cloudBackup.getProgress() });
});

/** GET /api/backup/history  â€" local backup history */
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

/** POST /api/backup/now  â€" run backup immediately */
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

/** GET /api/backup/cloud/:provider  â€" list cloud backups */
app.get("/api/backup/cloud/:provider", async (req, res) => {
  const provider = req.params.provider;
  try {
    const items = await _cloudBackup.listCloudBackups(provider);
    res.json({ ok: true, provider, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/pull  â€" pull backup from cloud */
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

/** POST /api/backup/restore/:id  â€" restore a local backup */
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

/** DELETE /api/backup/:id  â€" delete a local backup package */
app.delete("/api/backup/:id", (req, res) => {
  const backupId = decodeURIComponent(req.params.id);
  try {
    const result = _cloudBackup.deleteLocalBackup(backupId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// â"€â"€â"€ Graceful Shutdown â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
  stopRemoteChatBridge();
  try { poller.stop(); } catch (_) {}
  httpServer.close(() => { _flushAndClose(); process.exit(0); });
  // Safety: if httpServer doesn't drain within 2 s, force-close and exit.
  setTimeout(() => { _flushAndClose(); process.exit(0); }, 2000).unref();
}

// Called when running embedded in the Electron main process (packaged mode).
// Must NOT call process.exit â€" Electron controls the lifecycle.
function shutdownEmbedded() {
  if (_shutdownCalled) return;
  _shutdownCalled = true;
  console.log("[Server] Embedded shutdown: flushing DB...");
  stopRemoteBridge();
  stopRemoteChatBridge();
  try { poller.stop(); } catch (_) {}
  try {
    httpServer.close(() => { _flushAndClose(); });
  } catch (_) {
    _flushAndClose();
    return;
  }
  setTimeout(() => { _flushAndClose(); }, 2000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("message", (msg) => {
  if (msg && msg.type === "shutdown") gracefulShutdown("ipc");
});

// â"€â"€â"€ Periodic WAL Checkpoint â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Keeps the WAL file from growing unbounded between auto-checkpoints.
setInterval(() => {
  try { db.pragma("wal_checkpoint(PASSIVE)"); } catch (_) {}
}, 15 * 60 * 1000).unref();

// â"€â"€â"€ Periodic DB Backup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
