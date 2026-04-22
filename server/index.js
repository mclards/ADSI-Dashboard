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
const WebSocket = require("ws");
const fetch = require("node-fetch");
const cron = require("node-cron");
const { getPortableDataRoot } = require("./runtimeEnvPaths");
const streaming = require("./streaming");
const go2rtcManager = require("./go2rtcManager");
const forecastGenLock = require("./forecastGenLock");

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
  bulkBackfillSolcastEstActual,
  // Day-ahead locked snapshot + snapshot history (v2.8+).
  // bulkInsertDayAheadLocked is consumed inside dayAheadLock.js (which
  // requires it directly from ./db); only express-layer helpers are imported here.
  // countDayAheadLockedForDay is used by the startup catch-up hook (R5).
  countDayAheadLockedForDay,
  getDayAheadLockedForDay,
  getDayAheadLockedMetaForDay,
  bulkInsertSnapshotHistory,
  pruneSnapshotHistory,
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
  prepareArchiveDbForTransfer,
  createSqliteTransferSnapshot,
  disposeSqliteTransferSnapshot,
  stagePendingMainDbReplacement,
  discardPendingMainDbReplacement,
  beginArchiveDbReplacement,
  validateSqliteFileSync,
  endArchiveDbReplacement,
  upsertDailyReportRowsToSnapshot,
  insertChatMessage,
  getChatThread,
  getChatInboxAfterId,
  markChatReadUpToId,
  clearAllChatMessages,
  getScheduledMaintenance,
  insertScheduledMaintenance,
  deleteScheduledMaintenance,
  // v2.8.10 Phase C: read-only snapshot of boot-time integrity + any
  // auto-restore that happened when adsi.db was found corrupt. Surfaced
  // to the renderer through GET /api/health/db-integrity.
  startupIntegrityResult,
} = require("./db");
const {
  registerClient,
  broadcastUpdate,
  setBroadcastPayloadEnricher,
  startKeepAlive,
  getStats: getWsStats,
} = require("./ws");
const { BackupHealthRegistry } = require("./backupHealthRegistry");
const poller = require("./poller");
const { getEnergyBacklogPressure } = require("./poller");
const exporter = require("./exporter");
const {
  getActiveAlarms,
  decodeAlarm,
  getTopSeverity,
  formatAlarmHex,
  checkAlarms,
  logControlAction,
  getAuditLog,
  ALARM_BITS,
  STOP_REASON_SUBCODES,
  SERVICE_DOCS,
  SERVICE_DOCS_GITHUB_BASE,
  FATAL_ALARM_VALUE,
} = require("./alarms");
const {
  isValidPlantWideAuthKey,
  issuePlantWideAuthSession,
  isValidPlantWideAuthSession,
} = require("./bulkControlAuth");
const {
  normalizeSequenceMode: normalizePlantCapSequenceMode,
  normalizeSequenceCustom: normalizePlantCapSequenceCustom,
  ScheduleEngine,
  PlantCapController,
} = require("./plantCapController");

// â”€â”€â”€ Cloud Backup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TokenStore = require("./tokenStore");
const OneDriveProvider = require("./cloudProviders/onedrive");
const GDriveProvider = require("./cloudProviders/gdrive");
const S3CompatibleProvider = require("./cloudProviders/s3");
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
const {
  summarizeCurrentDayEnergyRows,
  mergeCurrentDaySummaryIntoReportSummary,
  buildCurrentDayActualSupplementRows,
} = require("./currentDayEnergyCore");

const app = express();
let plantCapController = null;
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
// Ingeteam service reference PDFs (schematic, Level 1/2 workflows, SUN Manager
// manual). Served locally as the offline fallback if the GitHub raw URL fetch
// fails in the alarm drilldown.
app.use("/docs", express.static(path.join(__dirname, "../docs"), staticNoCache));
/* Block direct static access to credentials reference — must go through auth-gated endpoint */
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") && req.path.toLowerCase().includes("credentials-reference")) return res.status(403).end();
  next();
});
app.use(express.static(path.join(__dirname, "../public"), staticNoCache));
app.use("/api", remoteApiTokenGate);
const PORT = Math.max(1, Math.min(65535, Number(process.env.ADSI_SERVER_PORT || 3500) || 3500));
const REMOTE_GATEWAY_DEFAULT_PORT = 3500;
const PORTABLE_ROOT = getPortableDataRoot();
const PROGRAMDATA_ROOT = PORTABLE_ROOT
  ? path.join(PORTABLE_ROOT, "programdata")
  : path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "InverterDashboard");

// v2.8.14: ensure %PROGRAMDATA%\InverterDashboard is writable by Users.
// db.js already does this for DATA_DIR (the db/ subfolder), but the restore
// path also writes to programDataDir/{forecast,history,weather,logs,archive,
// license,auth}/ — those are siblings of db/, not children, so the recursive
// icacls grant on DATA_DIR doesn't reach them. Without this, a portable
// .adsibak restore on a freshly-installed machine can fail mid-flight with
// EPERM and trigger the auto-rollback chain (which itself needs the same
// directories to be writable).
(function ensureProgramDataRootWritable() {
  if (process.platform !== "win32") return;
  if (!PROGRAMDATA_ROOT.toLowerCase().includes("programdata")) return;
  try {
    fs.mkdirSync(PROGRAMDATA_ROOT, { recursive: true });
    const probe = path.join(PROGRAMDATA_ROOT, ".write-probe");
    fs.writeFileSync(probe, "", { flag: "w" });
    fs.unlinkSync(probe);
  } catch {
    try {
      const { spawnSync } = require("child_process");
      const r = spawnSync(
        "icacls",
        [PROGRAMDATA_ROOT, "/grant", "Users:(OI)(CI)M", "/T", "/Q"],
        { windowsHide: true, timeout: 15000 },
      );
      if (r.error) throw r.error;
      console.log("[startup] Granted Users write access to", PROGRAMDATA_ROOT);
    } catch (err) {
      console.warn(
        "[startup] Could not grant Users write access to",
        PROGRAMDATA_ROOT,
        ":",
        err.message,
        "— restore operations into this directory may fail with EPERM.",
      );
    }
  }
})();
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
const weatherHourlyCache = new Map();
const WEATHER_HOURLY_FIELDS = [
  "shortwave_radiation",
  "direct_normal_irradiance",
  "diffuse_radiation",
  "cloud_cover",
  "temperature_2m",
].join(",");
// Multi-model cloud cover — queried via a second Open-Meteo call so each
// model's values come back on separate keys (cloud_cover_jma_seamless, etc.).
// JMA is Japan Meteorological Agency → best regional skill for SE Asia.
const WEATHER_CLOUD_MODELS = [
  { id: "jma_seamless", label: "JMA" },
  { id: "ecmwf_ifs025", label: "ECMWF" },
  { id: "gfs_seamless", label: "GFS" },
  { id: "icon_seamless", label: "ICON" },
];
const SOLCAST_TIMEOUT_MS = 20000;
const SOLCAST_SLOT_MIN = 5;
const SOLCAST_SOLAR_START_H = 5;
const SOLCAST_SOLAR_END_H = 18;
const FORECAST_SOLAR_SLOT_COUNT =
  ((SOLCAST_SOLAR_END_H - SOLCAST_SOLAR_START_H) * 60) / SOLCAST_SLOT_MIN;
const SOLCAST_UNIT_KW_MAX = 997.0;
const NODE_KW_MAX = 244.25;  // per-node maximum (250 kW × 97.7%)
const SOLCAST_ACCESS_MODE_API = "api";
const SOLCAST_ACCESS_MODE_TOOLKIT = "toolkit";
const SOLCAST_TOOLKIT_RECENT_HOURS = 48;
const SOLCAST_TOOLKIT_PERIOD = "PT5M";
const SOLCAST_PREVIEW_RESOLUTIONS = new Set(["PT5M", "PT10M", "PT15M", "PT30M", "PT60M"]);
const SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS = 15;
const SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS = 360;

// Rate-limit lazy Solcast est_actual backfill per date (5-minute cooldown).
const _solcastLazyBackfillAttempts = new Map(); // date (YYYY-MM-DD) -> nextRetryAt (ms)
let SOLCAST_LAZY_BACKFILL_COOLDOWN_MS = 5 * 60 * 1000;
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
const AVAIL_OFFLINE_TOLERANCE_S = 60; // bridge offline gaps ≤ 60s (comms blips / Modbus timeouts)
const ENERGY_5MIN_UNPAGED_ROW_CAP = 50000; // safety cap for the non-paged fallback path
const REMOTE_BRIDGE_INTERVAL_MS = 800;
const REMOTE_BRIDGE_MAX_BACKOFF_MS = 30000; // max retry interval after consecutive live failures
const REMOTE_BRIDGE_WARMUP_MS = 8000; // allow the live bridge to establish before local fallback kicks in
const REMOTE_ENERGY_POLL_INTERVAL_MS = 30000; // today-energy endpoint is rate-limited to 30 s
const REMOTE_DB_MIN_PERSIST_MS = 1000;
const REMOTE_DB_PAC_DELTA_PERSIST_W = 250;
const REMOTE_FETCH_TIMEOUT_MS = 5000;
const REMOTE_CHAT_POLL_INTERVAL_MS = 5000;
const REMOTE_CHAT_POLL_LIMIT = 50;
const REMOTE_LIVE_FETCH_RETRIES = 2;
const REMOTE_LIVE_FETCH_RETRY_BASE_MS = 350;
const REMOTE_LIVE_FAILURES_BEFORE_OFFLINE = 6;
const REMOTE_LIVE_FAILURES_BEFORE_OFFLINE_DURING_SYNC = 10;
const REMOTE_LIVE_DEGRADED_GRACE_MS = 60000;
const REMOTE_LIVE_STALE_RETENTION_MS = 180000;
const REMOTE_REPLICATION_TIMEOUT_MS = 300000;
const REMOTE_REPLICATION_RETRY_MS = 30000;
const REMOTE_INCREMENTAL_INTERVAL_MS = 3000;
const REMOTE_INCREMENTAL_APPEND_LIMIT = 25000;
const REMOTE_PUSH_DELTA_LIMIT = 50000;
const REMOTE_PUSH_CHUNK_MAX_ROWS = 15000; // fewer round trips over Tailscale (was 6000)
const REMOTE_PUSH_CHUNK_TARGET_BYTES = 12 * 1024 * 1024; // 12 MB per chunk (was 4 MB)
const REMOTE_PUSH_FETCH_RETRIES = 3;
const REMOTE_PUSH_FETCH_RETRY_BASE_MS = 1200;

// ─── Energy-replication contention coordination ──────────────────────────────
const replicationYieldStats = {
  yieldCount: 0,
  yieldTotalMs: 0,
  lastYieldTs: null,
};

async function waitForEnergyBacklogRelief(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const bp = getEnergyBacklogPressure();
    if (bp.pressure === "normal") return "ok";
    replicationYieldStats.yieldCount += 1;
    replicationYieldStats.lastYieldTs = Date.now();
    if (bp.pressure === "elevated") {
      console.log(`[replication] Yielding to energy backlog (pressure: elevated, queue: ${bp.queueSize}/${bp.maxRows})`);
      await new Promise(r => setTimeout(r, 500));
      replicationYieldStats.yieldTotalMs += 500;
      continue;
    }
    // critical
    console.warn(`[replication] Energy backlog critical (${bp.queueSize}/${bp.maxRows}), pausing replication`);
    await new Promise(r => setTimeout(r, 2000));
    replicationYieldStats.yieldTotalMs += 2000;
  }
  console.warn(`[replication] Energy backlog relief timeout after ${maxWaitMs}ms`);
  return "timeout";
}

function getReplicationChunkLimit() {
  const bp = getEnergyBacklogPressure();
  if (bp.pressure === "critical") return 2000;
  if (bp.pressure === "elevated") return 8000;
  return REMOTE_INCREMENTAL_APPEND_LIMIT;
}
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
const REMOTE_ARCHIVE_TRANSFER_CONCURRENCY = 3; // parallel archive file downloads (was 1)
// Priority standby pulls also benefit from parallel downloads — the live bridge
// is already paused, so we can use the headroom for faster archive transfer.
const PRIORITY_PULL_ARCHIVE_TRANSFER_CONCURRENCY = 3;
const REPLICATION_TRANSFER_STREAM_HWM = 4 * 1024 * 1024; // 4 MB stream buffers (was 1 MB)
const REPLICATION_STREAM_GZIP_MIN_BYTES = 256 * 1024;
const GATEWAY_MAIN_DB_SNAPSHOT_CACHE_TTL_MS = 60 * 1000;
const GATEWAY_MAIN_DB_SNAPSHOT_CHECKPOINT_MIN_MS = 10 * 60 * 1000;
const REPLICATION_HASH_CACHE_LIMIT = 256;
const REMOTE_FETCH_KEEPALIVE_MSECS = 15000;
const REMOTE_FETCH_MAX_SOCKETS = 8;
const REMOTE_FETCH_MAX_SOCKETS_REPLICATION = 16;
const REMOTE_FETCH_MAX_SOCKETS_CONTROL = 8;
const REMOTE_CONTROL_PROXY_TIMEOUT_MS = 60000;
const CHAT_RATE_LIMIT_WINDOW_MS = 60000;
const CHAT_RATE_LIMIT_MAX = 10;
const LIVE_FRESH_MS = 15000; // keep live metric freshness aligned with renderer semantics
const REMOTE_CLIENT_PULL_ONLY = false;
const WRITE_ENGINE_TIMEOUT_MS = 25000;
const WRITE_QUEUE_MAX_PENDING = 512;
const REMOTE_TODAY_SHADOW_SETTING_KEY = "remoteTodayEnergyShadow";
const MANUAL_REPLICATION_CANCEL_CODE = "MANUAL_REPLICATION_CANCELLED";
const MANUAL_PULL_LOCAL_NEWER_CODE = "LOCAL_NEWER_PUSH_FAILED";
const MANUAL_PULL_GATEWAY_CHECK_FAILED_CODE = "GATEWAY_STATE_CHECK_FAILED";
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
  "operatorName",
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
  "operatorName",
  // Preserve the latest same-day gateway today-energy baseline so a staged
  // standby DB replacement can bridge current-day totals immediately after
  // restart, before the local poller catches up.
  REMOTE_TODAY_SHADOW_SETTING_KEY,
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
    columns: ["id", "ts", "operator", "inverter", "node", "action", "scope", "result", "ip", "reason"],
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
const REPLICATION_LOCAL_NEWER_IGNORE_TABLES = new Set([
  // Manual pull should protect newer replicated data, not standby-client config
  // drift. Settings differ by design in remote mode and should not block a
  // source-of-truth gateway refresh.
  "settings",
]);
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
let remoteBridgeSocket = null;
let remoteChatPollTimer = null;
let remoteLiveFetchController = null;
let remoteTodayEnergyFetchController = null;
let remoteChatFetchController = null;
const remoteBridgeState = {
  running: false,
  connected: false,
  startedAtTs: 0,
  lastAttemptTs: 0,
  lastSuccessTs: 0,
  liveFailureCount: 0,
  lastFailureTs: 0,
  lastError: "",
  lastReasonCode: "",
  lastReasonClass: "",
  lastLatencyMs: 0,
  lastLiveNodeCount: 0,
  currentBase: "",
  liveData: {},
  totals: {},
  todayEnergyRows: [],   // gateway /api/energy/today rows, piggybacked from bridge tick
  lastTodayEnergyFetchTs: 0, // ts of last successful today-energy fetch (rate-limited)
  lastTodayEnergyShadowPersistTs: 0,
  todayEnergyFetchInFlight: false,
  todayEnergyFetchRequestId: 0,
  bridgeSessionId: 0,
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
  livePauseActive: false,
  livePauseReason: "",
  livePauseSince: 0,
  livePauseResumeWanted: false,
  livePauseGeneration: 0,
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
  sourceKey: "",
};
const remoteBridgeAlarmState = Object.create(null);
const remoteTodayCarryState = {
  day: "",
  byInv: Object.create(null), // inverter -> { shadowBaseKwh, anchorPollerKwh }
};
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
    priorityMode: false,
    livePaused: false,
    cancelRequested: false,
    result: null,
  };
}
const manualReplicationJobState = createManualReplicationJobState();
let manualReplicationRunControl = null;
let cpuSampleTs = Date.now();
let cpuSampleUsage = process.cpuUsage();

// â”€â”€â”€ Cloud Backup â€” Service Initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _tokenStore  = new TokenStore(DATA_DIR);
const _onedrive    = new OneDriveProvider(_tokenStore);
const _gdrive      = new GDriveProvider(_tokenStore);
let _cloudBackup = null;
const _s3          = new S3CompatibleProvider(_tokenStore, () => (_cloudBackup ? _cloudBackup.getCloudSettings() : {}));

// v2.8.14: persistent health tracker for all backup paths (Tier 1 / Tier 3 /
// scheduled .adsibak / manual portable). Persists to backupHealth.json under
// DATA_DIR; broadcasts live updates over WS for the admin panel.
const _backupHealth = new BackupHealthRegistry({
  stateFilePath: path.join(DATA_DIR, "backupHealth.json"),
  broadcast: broadcastUpdate,
});

_cloudBackup = new CloudBackupService({
  dataDir:     DATA_DIR,
  db,
  getSetting,
  setSetting,
  tokenStore:  _tokenStore,
  onedrive:    _onedrive,
  gdrive:      _gdrive,
  s3:          _s3,
  poller,
  ipConfigPath: path.join(DATA_DIR, "ipconfig.json"),
  programDataDir: PROGRAMDATA_ROOT,
  healthRegistry: _backupHealth,
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

const GATEWAY_EXPORT_QUEUE_LIMIT = 3;
let _gatewayExportRunnerBusy = false;
const _gatewayExportQueue = [];
let _gatewayMainDbSnapshot = null;
let _gatewayMainDbSnapshotBuildPromise = null;
let _gatewayMainDbSnapshotLastCheckpointTs = 0;
const _replicationFileHashCache = new Map();

function _scheduleGatewayExportRun() {
  setImmediate(_runNextGatewayExportJob);
}

async function _runNextGatewayExportJob() {
  if (_gatewayExportRunnerBusy) return;
  const job = _gatewayExportQueue.shift();
  if (!job) return;
  _gatewayExportRunnerBusy = true;
  try {
    const startedAt = Date.now();
    const result = await job.fn();
    job.resolve(result);
    console.log(
      `[ExportQueue] completed "${job.label}" in ${Date.now() - startedAt} ms`,
    );
  } catch (err) {
    job.reject(err);
    console.warn(
      `[ExportQueue] "${job.label}" failed:`,
      String(err?.message || err || "unknown error"),
    );
  } finally {
    _gatewayExportRunnerBusy = false;
    if (_gatewayExportQueue.length > 0) {
      _scheduleGatewayExportRun();
    }
  }
}

function enqueueGatewayExportJob(label, fn) {
  const pending = _gatewayExportQueue.length + (_gatewayExportRunnerBusy ? 1 : 0);
  if (pending >= GATEWAY_EXPORT_QUEUE_LIMIT) {
    const err = new Error(
      "Gateway export queue is busy. Wait for the current export to finish and try again.",
    );
    err.code = "EXPORT_QUEUE_BUSY";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    _gatewayExportQueue.push({
      label: String(label || "export"),
      fn,
      resolve,
      reject,
    });
    _scheduleGatewayExportRun();
  });
}

function isExportQueueBusyError(err) {
  return String(err?.code || "").toUpperCase() === "EXPORT_QUEUE_BUSY";
}

async function runGatewayExportJob(label, fn) {
  return enqueueGatewayExportJob(label, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return fn();
  });
}

const _writeQueueStates = new Map();

function normalizeWriteScope(scopeRaw = "single") {
  const scope = String(scopeRaw || "single").trim().toLowerCase();
  if (
    scope === "all" ||
    scope === "selected" ||
    scope === "inverter" ||
    scope === "plant-cap"
  ) {
    return scope;
  }
  return "single";
}

function resolveWritePriority(scopeRaw = "single", priorityRaw = "") {
  const explicit = String(priorityRaw || "").trim().toLowerCase();
  if (explicit === "critical" || explicit === "highest" || explicit === "high") {
    return 0;
  }
  switch (normalizeWriteScope(scopeRaw)) {
    case "single":
      return 0;
    case "plant-cap":
      return 0;
    case "inverter":
      return 1;
    case "selected":
      return 2;
    case "all":
      return 3;
    default:
      return 1;
  }
}

function normalizeWriteQueueKey(queueKeyRaw = "global") {
  const queueKey = String(queueKeyRaw || "global").trim().toLowerCase();
  return queueKey || "global";
}

function getWriteQueueState(queueKeyRaw = "global") {
  const queueKey = normalizeWriteQueueKey(queueKeyRaw);
  let state = _writeQueueStates.get(queueKey);
  if (!state) {
    state = {
      busy: false,
      seq: 0,
      queue: [],
    };
    _writeQueueStates.set(queueKey, state);
  }
  return { queueKey, state };
}

function getPendingWriteQueueCount() {
  let total = 0;
  for (const state of _writeQueueStates.values()) {
    total += state.queue.length + (state.busy ? 1 : 0);
  }
  return total;
}

function cleanupWriteQueueState(queueKey, state) {
  if (!queueKey || !state) return;
  if (!state.busy && state.queue.length === 0) {
    _writeQueueStates.delete(queueKey);
  }
}

function scheduleWriteQueueRun(queueKeyRaw = "global", delayMs = 0) {
  const queueKey = normalizeWriteQueueKey(queueKeyRaw);
  const ms = Math.max(0, Number(delayMs) || 0);
  if (ms <= 0) {
    setImmediate(() => runNextWriteCommand(queueKey));
    return;
  }
  const t = setTimeout(() => runNextWriteCommand(queueKey), ms);
  if (t.unref) t.unref();
}

async function runNextWriteCommand(queueKeyRaw = "global") {
  const { queueKey, state } = getWriteQueueState(queueKeyRaw);
  if (state.busy) return;
  const job = state.queue.shift();
  if (!job) {
    cleanupWriteQueueState(queueKey, state);
    return;
  }
  state.busy = true;
  try {
    const result = await job.fn();
    job.resolve(result);
  } catch (err) {
    job.reject(err);
  } finally {
    state.busy = false;
    if (state.queue.length > 0) {
      scheduleWriteQueueRun(queueKey, 0);
    } else {
      cleanupWriteQueueState(queueKey, state);
    }
  }
}

function insertWriteQueueJob(state, job) {
  const next = job && typeof job === "object" ? job : null;
  if (!state || !next) return;
  let idx = state.queue.findIndex((queued) => {
    const queuedPriority = Number(queued?.priority ?? Number.POSITIVE_INFINITY);
    const nextPriority = Number(next.priority ?? Number.POSITIVE_INFINITY);
    if (nextPriority < queuedPriority) return true;
    if (nextPriority > queuedPriority) return false;
    return Number(next.seq || 0) < Number(queued?.seq || 0);
  });
  if (idx < 0) idx = state.queue.length;
  state.queue.splice(idx, 0, next);
}

function enqueueWriteCommand(scopeRaw, fn, options = {}) {
  if (typeof fn !== "function") {
    return Promise.reject(new Error("Invalid control command task."));
  }
  if (getPendingWriteQueueCount() >= WRITE_QUEUE_MAX_PENDING) {
    return Promise.reject(
      new Error("Control queue is busy. Please retry in a moment."),
    );
  }
  const scope = normalizeWriteScope(scopeRaw);
  const priority = resolveWritePriority(scope, options?.priority);
  const { queueKey, state } = getWriteQueueState(options?.queueKey || "global");
  return new Promise((resolve, reject) => {
    insertWriteQueueJob(state, {
      seq: (state.seq += 1),
      scope,
      priority,
      queuedAt: Date.now(),
      fn,
      resolve,
      reject,
    });
    scheduleWriteQueueRun(queueKey, 0);
  });
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
  // Allow test to override mode
  if (process.env.NODE_ENV === "test" && global.__adsiTestHooks?._forceRemoteMode != null) {
    return global.__adsiTestHooks._forceRemoteMode;
  }
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
    todayEnergy: getTodayEnergyRowsForWs(),
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
    code === "ECONNABORTED" ||
    code === "UND_ERR_SOCKET" ||
    msg.includes("socket hang up") ||
    msg.includes("read econnreset") ||
    msg.includes("econnaborted")
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

function getRemoteBridgeNextDelayMs(nowTs = Date.now(), pollElapsedMs = 0) {
  const elapsedMs = Math.max(0, Number(pollElapsedMs || 0));
  return Math.max(0, getRemoteBridgeTargetIntervalMs(nowTs) - elapsedMs);
}

function getRemoteBridgeTargetIntervalMs(nowTs = Date.now()) {
  const failures = Math.max(0, Number(remoteBridgeState.liveFailureCount || 0));
  const fastRetry = Boolean(remoteBridgeState.connected) || hasRecentRemoteBridgeSuccess(nowTs);
  if (fastRetry || failures <= 1) {
    // Adapt polling interval to gateway latency — if the gateway is slow,
    // give it breathing room instead of hammering at the base bridge cadence.
    const latency = Math.max(0, Number(remoteBridgeState.lastLatencyMs || 0));
    if (latency > 400) {
      return Math.min(
        REMOTE_BRIDGE_MAX_BACKOFF_MS,
        Math.max(REMOTE_BRIDGE_INTERVAL_MS, latency * 2),
      );
    }
    return REMOTE_BRIDGE_INTERVAL_MS;
  }
  return Math.min(
    REMOTE_BRIDGE_MAX_BACKOFF_MS,
    REMOTE_BRIDGE_INTERVAL_MS * Math.pow(2, failures - 1),
  );
}

function isRemoteLiveBridgePausedForTransfer() {
  return Boolean(remoteBridgeState.livePauseActive);
}

function pauseRemoteLiveBridgeForPriorityTransfer(reason = "standby-refresh") {
  const wasRunning = Boolean(remoteBridgeState.running);
  remoteBridgeState.livePauseActive = true;
  remoteBridgeState.livePauseReason = String(reason || "standby-refresh");
  remoteBridgeState.livePauseSince = Date.now();
  remoteBridgeState.livePauseResumeWanted = wasRunning;
  remoteBridgeState.livePauseGeneration =
    Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0)) + 1;
  if (remoteBridgeTimer) {
    clearTimeout(remoteBridgeTimer);
    remoteBridgeTimer = null;
  }
  closeRemoteBridgeSocket();
  remoteBridgeState.running = false;
  remoteBridgeState.connected = false;
  remoteBridgeState.todayEnergyFetchInFlight = false;
  remoteBridgeState.todayEnergyFetchRequestId =
    Math.max(0, Number(remoteBridgeState.todayEnergyFetchRequestId || 0)) + 1;
  remoteBridgeState.lastSyncDirection = "pull-priority-paused";
  remoteBridgeState.lastHealthBroadcastKey = "";
  broadcastRemoteHealthUpdate(true);
  return {
    bridgeWasRunning: wasRunning,
    reason: remoteBridgeState.livePauseReason,
    pausedAt: remoteBridgeState.livePauseSince,
  };
}

function resumeRemoteLiveBridgeAfterPriorityTransfer(token = null) {
  const shouldResume = Boolean(
    token?.bridgeWasRunning ?? remoteBridgeState.livePauseResumeWanted,
  );
  remoteBridgeState.livePauseActive = false;
  remoteBridgeState.livePauseReason = "";
  remoteBridgeState.livePauseSince = 0;
  remoteBridgeState.livePauseResumeWanted = false;
  remoteBridgeState.livePauseGeneration =
    Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0)) + 1;
  remoteBridgeState.lastHealthBroadcastKey = "";
  if (shouldResume && isRemoteMode()) {
    startRemoteBridge();
    return;
  }
  broadcastRemoteHealthUpdate(true);
}

function buildPriorityTransferNote(includeArchive = false) {
  return includeArchive
    ? "Remote live stream paused to prioritize standby DB and archive download."
    : "Remote live stream paused to prioritize standby DB download.";
}

function buildReplicationTransferFetchOptions(targetUrl, options = {}) {
  const next = options && typeof options === "object" ? { ...options } : {};
  next.compress = false;
  next.headers =
    next.headers && typeof next.headers === "object" ? { ...next.headers } : {};
  if (next.headers["Accept-Encoding"] == null && next.headers["accept-encoding"] == null) {
    next.headers["Accept-Encoding"] = "identity";
  }
  return buildRemoteFetchOptions(targetUrl, next);
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
  } else if (isRemoteLiveBridgePausedForTransfer()) {
    state = "paused";
    effectiveReasonCode = "PRIORITY_PULL";
    reasonText =
      String(remoteBridgeState.livePauseReason || "").trim() === "standby-refresh"
        ? "Live bridge paused during standby refresh."
        : String(remoteBridgeState.livePauseReason || "Live bridge paused during transfer.");
  } else if (reasonClass === "config-error") {
    state = "config-error";
  } else if (reasonClass === "auth-error") {
    state = "auth-error";
  } else if (isRemoteBridgeWarmupActive(nowTs)) {
    state = "connecting";
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
      mode === "remote" && remoteBridgeState.running && !isRemoteLiveBridgePausedForTransfer()
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
    pausedForPriorityTransfer: isRemoteLiveBridgePausedForTransfer(),
    pauseReason: String(remoteBridgeState.livePauseReason || ""),
    pauseSince: Math.max(0, Number(remoteBridgeState.livePauseSince || 0)),
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
  if (p === "/export" || p.startsWith("/export/")) return false;
  return true;
}

/**
 * Read-only API paths that can fall back to local DB when gateway is offline.
 * These all have local route handlers defined below the catch-all proxy middleware.
 */
function canFallbackToLocal(pathname) {
  const p = String(pathname || "");
  if (p === "/report" || p.startsWith("/report/")) return true;
  if (p === "/energy" || p.startsWith("/energy/")) return true;
  if (p === "/analytics" || p.startsWith("/analytics/")) return true;
  if (p === "/alarms" || p.startsWith("/alarms/")) return true;
  if (p === "/audit" || p.startsWith("/audit/")) return true;
  return false;
}

function shouldServeLocalFallback(pathname, nowTs = Date.now()) {
  // Viewer model: remote mode never falls back to local DB for historical reads.
  // Gateway unavailability is surfaced honestly instead of serving stale local data.
  return false;
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

const _chatRateBuckets = new Map(); // key: machine → { timestamps[] }

function checkChatRateLimit(machine) {
  const key = String(machine || "local");
  const now = Date.now();
  let bucket = _chatRateBuckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    _chatRateBuckets.set(key, bucket);
  }
  // Prune entries outside the window.
  bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < CHAT_RATE_LIMIT_WINDOW_MS);
  if (bucket.timestamps.length >= CHAT_RATE_LIMIT_MAX) {
    const err = new Error(`Rate limit exceeded. Maximum ${CHAT_RATE_LIMIT_MAX} messages per minute.`);
    err.httpStatus = 429;
    throw err;
  }
  bucket.timestamps.push(now);
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

function buildRemoteLiveSnapshot(rowsRaw, syncedAt = Date.now()) {
  const rows = rowsRaw && typeof rowsRaw === "object" ? rowsRaw : {};
  const out = {};
  for (const [key, rawRow] of Object.entries(rows)) {
    const parsed = normalizeRemoteLiveReading(rawRow, syncedAt);
    if (!parsed) continue;
    out[String(key || `${parsed.inverter}_${parsed.unit}`)] = {
      ...(rawRow && typeof rawRow === "object" ? rawRow : {}),
      ...parsed,
      // Preserve the gateway sample ts for persistence/history while using a
      // bridge-local freshness ts for runtime liveness on remote clients.
      sourceTs: Number(parsed.ts || 0),
      bridgeTs: Math.max(0, Number(syncedAt || Date.now())),
    };
  }
  return out;
}

function getRuntimeFreshTs(row) {
  return Math.max(0, Number(row?.bridgeTs || row?.ts || 0));
}

// Viewer model: live DB persistence disabled — remote mode keeps data in-memory only.
function persistRemoteLiveRows() { /* no-op */ }

// Viewer model: energy mirroring to local DB disabled — remote mode keeps data in-memory only.
function mirrorRemoteTodayEnergyRowsToLocal() { /* no-op */ }

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
    const ts = getRuntimeFreshTs(row);
    const online = Number(row?.online || 0) === 1;
    if (!online || !ts || now - ts > LIVE_FRESH_MS) continue;
    if (!out[inv]) out[inv] = { pac: 0, pdc: 0, kwh: 0 };
    out[inv].pac += Number(row?.pac || 0);
    out[inv].pdc += Number(row?.pdc || 0);
    out[inv].kwh += Number(row?.kwh || 0);
  }
  return out;
}

function computeTodayEnergyRowsFromLiveData(data) {
  return Object.entries(computeTotalsFromLiveData(data))
    .map(([inverter, totals]) => ({
      inverter: Number(inverter || 0),
      total_kwh: Number(Number(totals?.kwh || 0).toFixed(6)),
    }))
    .filter((row) => row.inverter > 0 && row.total_kwh > 0)
    .sort((a, b) => a.inverter - b.inverter);
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
    hotTables: ["main database snapshot"],
    preservedSettings: Array.from(REMOTE_MAIN_DB_PRESERVE_SETTING_KEYS),
    archive: {
      ...archiveSummary,
      optional: true,
    },
    notes: {
      transport: "Standby DB refresh uses the configured remote gateway URL over the approved reachable network path.",
      push:
        "Push is disabled in the viewer model. Gateway remains the only authoritative source for shared data.",
      pull:
        "Pull stages archive DB files first for historical consistency, then downloads a fresh gateway main DB snapshot for restart-safe local replacement. During manual standby refresh, the remote live bridge pauses temporarily so the transfer gets priority.",
      liveBridge:
        "Live bridge polling stays lightweight. Manual standby refresh temporarily pauses the viewer-side live bridge, then resumes it automatically when the transfer finishes.",
      hotPriority:
        "Archive DB files are staged first when included, followed by the gateway main DB snapshot. Archives are optional and intended for historical catch-up.",
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
    priorityMode: Boolean(manualReplicationJobState.priorityMode),
    livePaused: Boolean(manualReplicationJobState.livePaused),
    cancelRequested: Boolean(manualReplicationJobState.cancelRequested),
    result:
      manualReplicationJobState.result &&
      typeof manualReplicationJobState.result === "object"
        ? { ...manualReplicationJobState.result }
        : null,
  };
}

function createManualReplicationAbortError(message = "Standby DB refresh cancelled.") {
  const err = new Error(String(message || "Standby DB refresh cancelled."));
  err.name = "AbortError";
  err.code = MANUAL_REPLICATION_CANCEL_CODE;
  return err;
}

function createManualPullLocalNewerError(
  message = "Manual pull blocked: local standby data is newer than the gateway.",
) {
  const err = new Error(
    String(message || "Manual pull blocked: local standby data is newer than the gateway."),
  );
  err.code = MANUAL_PULL_LOCAL_NEWER_CODE;
  err.canForcePull = true;
  return err;
}

function createManualPullGatewayCheckError(
  message = "Gateway state check failed.",
) {
  const err = new Error(String(message || "Gateway state check failed."));
  err.code = MANUAL_PULL_GATEWAY_CHECK_FAILED_CODE;
  return err;
}

function isManualReplicationAbortError(err) {
  return (
    isAbortError(err) ||
    String(err?.code || "").trim().toUpperCase() === MANUAL_REPLICATION_CANCEL_CODE
  );
}

function throwIfManualReplicationAborted(signal, message = "Standby DB refresh cancelled.") {
  if (signal?.aborted) {
    throw createManualReplicationAbortError(message);
  }
}

function isTransferStreamAbortError(err) {
  if (isManualReplicationAbortError(err)) return true;
  const code = String(err?.code || "").trim().toUpperCase();
  if (
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  ) {
    return true;
  }
  const msg = String(err?.message || err || "").trim().toLowerCase();
  return msg.includes("premature close") || msg.includes("request aborted");
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

function createManualReplicationRunControl(jobId = "", action = "sync") {
  return {
    jobId: String(jobId || "").trim(),
    action: String(action || "sync").trim(),
    controller: new AbortController(),
    cancelRequested: false,
    stagedMainTempName: "",
    stagedArchiveEntries: new Map(),
  };
}

function trackManualReplicationStagedMainDb(runControl, tempName = "") {
  if (!runControl || typeof runControl !== "object") return;
  runControl.stagedMainTempName = path.basename(String(tempName || "").trim());
}

function trackManualReplicationStagedArchive(runControl, name = "", tempName = "") {
  if (!runControl || !(runControl.stagedArchiveEntries instanceof Map)) return;
  const safeName = sanitizeArchiveFileName(name || "");
  const safeTempName = path.basename(String(tempName || "").trim());
  if (!safeName || !safeTempName) return;
  runControl.stagedArchiveEntries.set(safeName, safeTempName);
}

function discardPendingArchiveReplacement(name = "", tempName = "") {
  const safeName = sanitizeArchiveFileName(name || "");
  if (!safeName) return { cleared: false, tempRemoved: false };
  const expectedTempName = path.basename(String(tempName || "").trim());
  const remaining = [];
  let cleared = false;
  let tempRemoved = false;
  for (const entry of readPendingArchiveReplacements()) {
    if (String(entry?.name || "") !== safeName) {
      remaining.push(entry);
      continue;
    }
    const pendingTempName = path.basename(String(entry?.tempName || "").trim());
    if (expectedTempName && pendingTempName && pendingTempName !== expectedTempName) {
      remaining.push(entry);
      continue;
    }
    cleared = true;
    if (pendingTempName) {
      try {
        fs.unlinkSync(path.join(ARCHIVE_DIR, pendingTempName));
        tempRemoved = true;
      } catch (_) {
        tempRemoved = false;
      }
    }
  }
  if (cleared) writePendingArchiveReplacements(remaining);
  return { cleared, tempRemoved };
}

function discardTrackedManualReplicationArtifacts(runControl) {
  if (!runControl || typeof runControl !== "object") return;
  if (runControl.stagedMainTempName) {
    try {
      discardPendingMainDbReplacement(runControl.stagedMainTempName);
    } catch (_) {}
    runControl.stagedMainTempName = "";
  }
  if (runControl.stagedArchiveEntries instanceof Map) {
    for (const [name, tempName] of runControl.stagedArchiveEntries.entries()) {
      try {
        discardPendingArchiveReplacement(name, tempName);
      } catch (_) {}
    }
    runControl.stagedArchiveEntries.clear();
  }
}

function requestManualReplicationCancel(
  message = "Force-cancelling standby DB refresh...",
) {
  const runControl = manualReplicationRunControl;
  if (!runControl || !isManualReplicationJobRunning()) {
    return {
      ok: false,
      error: "No standby DB refresh is currently running.",
      job: snapshotManualReplicationJob(),
    };
  }
  runControl.cancelRequested = true;
  updateManualReplicationJob({
    status: "cancelling",
    cancelRequested: true,
    summary: String(message || "Force-cancelling standby DB refresh..."),
    error: "",
    errorCode: "",
  });
  try {
    runControl.controller.abort(
      createManualReplicationAbortError("Standby DB refresh cancelled by operator."),
    );
  } catch (_) {}
  return { ok: true, job: snapshotManualReplicationJob() };
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
    if (REPLICATION_LOCAL_NEWER_IGNORE_TABLES.has(def.name)) continue;
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

const REPLICATION_STMT_CACHE = new Map();

// Whitelist of replication tables allowed in dynamic SQL construction.
// Must exactly match `REPLICATION_TABLE_DEFS[].name`. Used as a
// defence-in-depth SQL-injection guard at the two dynamic-`tableName`
// interpolation sites in mergeAppendReplicationRow / mergeUpdatedReplicationRow.
const REPLICATION_ALLOWED_TABLES = new Set([
  "readings",
  "energy_5min",
  "alarms",
  "audit_log",
  "daily_report",
  "daily_readings_summary",
  "forecast_dayahead",
  "forecast_intraday_adjusted",
  "settings",
]);

function assertReplicationTableAllowed(tableName) {
  if (!REPLICATION_ALLOWED_TABLES.has(String(tableName))) {
    throw new Error(`replication: rejected non-whitelisted tableName=${JSON.stringify(tableName)}`);
  }
}

function stmtCached(key, sql) {
  if (!REPLICATION_STMT_CACHE.get(key)) {
    REPLICATION_STMT_CACHE.set(key, db.prepare(sql));
    // Evict oldest (first inserted) entry if cache exceeds 200 entries.
    // T1.7 note (Phase 8): better-sqlite3 Statement objects do NOT expose a
    // .free() / .finalize() method — the N-API finaliser releases native
    // resources on GC once the JS reference is dropped.  `Map.delete()` is
    // sufficient; no explicit free call is available or needed.  The audit's
    // suggestion to call .free() applied to node-sqlite3 (async) or
    // better-sqlite3-with-pool forks, not the vanilla package used here.
    if (REPLICATION_STMT_CACHE.size > 200) {
      const oldest = REPLICATION_STMT_CACHE.keys().next().value;
      REPLICATION_STMT_CACHE.delete(oldest);
    }
  }
  return REPLICATION_STMT_CACHE.get(key);
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
        // Row exists. Only allow upward corrections — never reduce locally-polled energy
        // via replication, as that would create discrepancies vs physical meter readings.
        const incomingKwh = Number(payload.kwh_inc || 0);
        const existingKwh = Number(existingRow.kwh_inc || 0);
        if (incomingKwh > existingKwh + 1e-9) {
          // Incoming is higher — accept the correction (gateway may have a more complete bucket).
          stmtCached(
            "update:energy_5min:kwh_inc_by_id",
            `UPDATE energy_5min SET kwh_inc=? WHERE id=?`,
          ).run(incomingKwh, existingRow.id);
          return true;
        }
        if (incomingKwh < existingKwh - 1e-6) {
          // Incoming is LOWER — reject to protect locally-polled data integrity.
          const diff = (existingKwh - incomingKwh).toFixed(4);
          const bucketTime = new Date(Number(payload?.ts || 0)).toISOString();
          console.warn(
            `[energy] REDUCTION blocked via replication: inv=${payload?.inverter}` +
            ` bucket=${bucketTime}` +
            ` stored=${existingKwh.toFixed(4)}kWh incoming=${incomingKwh.toFixed(4)}kWh` +
            ` diff=-${diff}kWh — kept higher local value`,
          );
        }
        return false; // identical or lower — no change
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
        ip=excluded.ip,
        reason=excluded.reason
      WHERE COALESCE(excluded.ts,0) >= COALESCE(audit_log.ts,0)`;
    stmtCached("merge:audit_log", sql).run(payload);
    return true;
  }

  // T1.1 fix: whitelist tableName before dynamic SQL construction.
  assertReplicationTableAllowed(tableName);
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

  // T1.1 fix: whitelist tableName before dynamic SQL construction.
  assertReplicationTableAllowed(tableName);
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
    // Cap rows to prevent unbounded memory allocation on large DBs
    const limitedSql = def.orderBy
      ? `SELECT ${selectCols} FROM ${def.name} ORDER BY ${def.orderBy} LIMIT 10000`
      : `SELECT ${selectCols} FROM ${def.name} LIMIT 10000`;
    const rows = db.prepare(limitedSql).all();
    if (rows.length >= 10000) {
      console.warn(`[Replication] buildFullDbSnapshot: ${def.name} truncated at 10000 rows`);
    }
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
  const chunkLimit = getReplicationChunkLimit();

  for (const [tableName, strategy] of Object.entries(REPLICATION_INCREMENTAL_STRATEGY)) {
    const def = REPLICATION_DEF_MAP[tableName];
    if (!def) continue;
    const cols = def.columns.join(", ");
    const cursor = Number(clientCursors[tableName] || 0);
    let rows = [];
    let hasMore = false;

    if (strategy.mode === "append") {
      const effectiveLimit = Number(strategy.limit || chunkLimit);
      rows = db
        .prepare(
          `SELECT ${cols}
             FROM ${tableName}
            WHERE ${strategy.cursorColumn} > ?
            ORDER BY ${strategy.orderBy}
            LIMIT ?`,
        )
        .all(cursor, effectiveLimit);
      const maxSeen = rows.length
        ? Math.max(cursor, ...rows.map((r) => Number(r?.[strategy.cursorColumn] || 0)))
        : cursor;
      nextCursors[tableName] = Number.isFinite(maxSeen) && maxSeen > 0 ? Math.floor(maxSeen) : 0;

      if (rows.length >= effectiveLimit) {
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

async function evaluateManualPullPreflight(baseUrl, forcePull = false) {
  const check = await checkLocalNewerBeforePull(baseUrl);
  if (!check?.ok) {
    const message = `Gateway state check failed: ${String(check?.error || "unknown error")}`;
    remoteBridgeState.lastReplicationError = message;
    remoteBridgeState.lastSyncDirection = "pull-check-failed";
    return {
      ok: false,
      localNewer: false,
      check,
      error: createManualPullGatewayCheckError(message),
    };
  }
  if (check.localNewer && !forcePull) {
    const message =
      "Manual pull blocked: local standby data is newer than the gateway. Use Force Pull only if you intentionally want to overwrite the newer local data.";
    remoteBridgeState.lastReplicationError = message;
    remoteBridgeState.lastSyncDirection = "pull-check-blocked-local-newer";
    return {
      ok: false,
      localNewer: true,
      check,
      error: createManualPullLocalNewerError(message),
    };
  }
  remoteBridgeState.lastReplicationError = "";
  if (check.localNewer && forcePull) {
    remoteBridgeState.lastSyncDirection = "pull-check-force-local-newer";
  }
  return {
    ok: true,
    localNewer: Boolean(check.localNewer),
    check,
  };
}

async function assertManualPullPreflight(baseUrl, forcePull = false) {
  const preflight = await evaluateManualPullPreflight(baseUrl, forcePull);
  if (!preflight?.ok) {
    throw preflight?.error || new Error("Standby DB refresh preflight failed.");
  }
  return preflight;
}

function buildManualPullErrorPayload(err) {
  const code = String(err?.code || "").trim().toUpperCase();
  const payload = {
    ok: false,
    error: String(err?.message || err || "Standby DB refresh failed."),
  };
  if (code) payload.errorCode = code;
  if (code === MANUAL_PULL_LOCAL_NEWER_CODE) {
    payload.canForcePull = true;
  }
  return payload;
}

function sendManualPullErrorResponse(res, err) {
  const code = String(err?.code || "").trim().toUpperCase();
  if (code === MANUAL_PULL_LOCAL_NEWER_CODE) {
    return res.status(409).json(buildManualPullErrorPayload(err));
  }
  if (code === MANUAL_PULL_GATEWAY_CHECK_FAILED_CODE) {
    return res.status(502).json(buildManualPullErrorPayload(err));
  }
  return res.status(500).json(buildManualPullErrorPayload(err));
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

    await waitForEnergyBacklogRelief();
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
      await waitForEnergyBacklogRelief();

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

async function runManualPullSync(baseUrl, includeArchive = true, forcePull = false, options = {}) {
  const signal = options?.signal || null;
  const runControl = options?.runControl || null;
  const preflight = options?.preflight && typeof options.preflight === "object"
    ? options.preflight
    : null;
  throwIfManualReplicationAborted(signal);
  if (preflight?.ok) {
    remoteBridgeState.lastReplicationError = "";
    if (preflight.localNewer && forcePull) {
      remoteBridgeState.lastSyncDirection = "pull-check-force-local-newer";
    }
  } else if (forcePull) {
    remoteBridgeState.lastReplicationError = "";
  } else {
    await assertManualPullPreflight(baseUrl, forcePull);
  }
  throwIfManualReplicationAborted(signal);
  boostSocketPoolForReplication();
  const priorityPause = pauseRemoteLiveBridgeForPriorityTransfer("standby-refresh");
  const priorityNote = buildPriorityTransferNote(includeArchive);
  try {
    // Step 1 — Pull archive DB files first (when requested) so historical data is staged
    //          before the main DB snapshot, minimising the gap on an interrupted transfer.
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
      throwIfManualReplicationAborted(signal);
      updateManualReplicationJob({
        summary: `Downloading archive DB files from gateway first. ${priorityNote}`,
        priorityMode: true,
        livePaused: true,
      });
      archive = await pullArchiveFilesFromRemote(baseUrl, {
        forceAll: true,
        concurrency: PRIORITY_PULL_ARCHIVE_TRANSFER_CONCURRENCY,
        priorityMode: true,
        livePaused: true,
        note: priorityNote,
        signal,
        runControl,
      });
    }

    // Step 2 — Pull a fresh gateway main DB snapshot and stage it for restart-safe replacement.
    //          Archive manifest-level failures (ok=false) are non-fatal — main DB is the
    //          critical piece for mode-switching.  The failure surfaces in the final summary.
    const archiveOk = !includeArchive || archive.ok || archive.unsupported;
    throwIfManualReplicationAborted(signal);
    updateManualReplicationJob({
      summary: `${includeArchive ? (archiveOk ? "Archives staged. " : "Archive pull incomplete. ") : ""}Downloading fresh gateway main database. ${priorityNote}`,
      priorityMode: true,
      livePaused: true,
    });
    const mainDb = await pullMainDbFromRemote(baseUrl, {
      label: "Downloading main database",
      syncDirection: "pull-main-db-staged",
      failureDirection: "pull-main-db-failed",
      priorityMode: true,
      livePaused: true,
      note: priorityNote,
      signal,
      runControl,
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

    // Step 3 — Gateway readiness check: warn if ipconfig.json is absent at the expected path.
    const ipconfigMissing = !fs.existsSync(path.join(DATA_DIR, "ipconfig.json"));

    const mainDbSummary = `main DB staged=${(Math.max(0, Number(mainDb.size || 0)) / (1024 * 1024)).toFixed(2)} MB`;
    const archiveSummary = includeArchive
      ? !archive.ok && !archive.unsupported
        ? `archive download failed: ${String(archive.error || "unknown error")} (main DB still staged)`
        : archive.unsupported
          ? "archive skipped (remote build has no archive sync)"
          : `archive files staged=${Number(archive.transferredFiles || 0).toLocaleString()}`
      : "archive skipped";
    const readinessNote = ipconfigMissing
      ? " | WARNING: Gateway IP configuration not found — configure IP settings before switching to Gateway mode."
      : "";
    return {
      needsRestart: true,
      direction: String(remoteBridgeState.lastSyncDirection || "idle"),
      mode: "main-db",
      mainDb,
      archive,
      priorityMode: true,
      summary: `Standby DB refresh complete | ${mainDbSummary} | ${archiveSummary}${readinessNote}. Remote live stream resumes automatically. Restart is needed to apply the staged database.`,
    };
  } finally {
    // Force immediate energy refresh after pull so the TODAY MWh metric
    // recovers without waiting for the next 30 s piggyback cycle.
    todayEnergyCache.ts = 0;
    remoteBridgeState.lastTodayEnergyFetchTs = 0;
    resumeRemoteLiveBridgeAfterPriorityTransfer(priorityPause);
    restoreSocketPoolAfterReplication();
  }
}

async function runManualPushSync(baseUrl, includeArchive = true) {
  boostSocketPoolForReplication();
  try {
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
  } finally {
    restoreSocketPoolAfterReplication();
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

function isAbortError(err) {
  return String(err?.name || "").trim() === "AbortError";
}

function isRetryableNetworkError(err) {
  const code = String(err?.code || "").trim().toUpperCase();
  if (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
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

function isRemoteBridgeWarmupActive(nowTs = Date.now()) {
  if (!isRemoteMode()) return false;
  if (remoteBridgeState.connected) return false;
  if (Number(remoteBridgeState.lastSuccessTs || 0) > 0) return false;
  if (!remoteBridgeState.running) return false;
  const startedAtTs = Math.max(0, Number(remoteBridgeState.startedAtTs || 0));
  if (!startedAtTs) return false;
  const warmupAgeMs = Math.max(0, nowTs - startedAtTs);
  const failureStreak = Math.max(0, Number(remoteBridgeState.liveFailureCount || 0));
  return warmupAgeMs < REMOTE_BRIDGE_WARMUP_MS && failureStreak <= 1;
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

const REMOTE_CONTROL_HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: REMOTE_FETCH_KEEPALIVE_MSECS,
  maxSockets: REMOTE_FETCH_MAX_SOCKETS_CONTROL,
  maxFreeSockets: Math.max(2, Math.floor(REMOTE_FETCH_MAX_SOCKETS_CONTROL / 2)),
});

const REMOTE_CONTROL_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: REMOTE_FETCH_KEEPALIVE_MSECS,
  maxSockets: REMOTE_FETCH_MAX_SOCKETS_CONTROL,
  maxFreeSockets: Math.max(2, Math.floor(REMOTE_FETCH_MAX_SOCKETS_CONTROL / 2)),
});

function setRemoteAgentMaxSockets(maxSockets) {
  const ms = Math.max(4, Math.min(32, Number(maxSockets) || REMOTE_FETCH_MAX_SOCKETS));
  const free = Math.max(2, Math.floor(ms / 2));
  REMOTE_HTTP_AGENT.maxSockets = ms;
  REMOTE_HTTP_AGENT.maxFreeSockets = free;
  REMOTE_HTTPS_AGENT.maxSockets = ms;
  REMOTE_HTTPS_AGENT.maxFreeSockets = free;
}

function boostSocketPoolForReplication() {
  setRemoteAgentMaxSockets(REMOTE_FETCH_MAX_SOCKETS_REPLICATION);
}

function restoreSocketPoolAfterReplication() {
  setRemoteAgentMaxSockets(REMOTE_FETCH_MAX_SOCKETS);
}

function getFetchAgentForUrl(targetUrl, trafficClass = "default") {
  try {
    const protocol = String(new URL(String(targetUrl || "")).protocol || "").toLowerCase();
    if (String(trafficClass || "").trim().toLowerCase() === "control") {
      return protocol === "https:" ? REMOTE_CONTROL_HTTPS_AGENT : REMOTE_CONTROL_HTTP_AGENT;
    }
    return protocol === "https:" ? REMOTE_HTTPS_AGENT : REMOTE_HTTP_AGENT;
  } catch (_) {
    return undefined;
  }
}

function buildRemoteFetchOptions(targetUrl, options = {}, trafficClass = "default") {
  const next = options && typeof options === "object" ? { ...options } : {};
  if (next.agent == null) next.agent = getFetchAgentForUrl(targetUrl, trafficClass);
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

function buildReplicationHashCacheKey(filePath, size = 0, mtimeMs = 0) {
  return [
    path.resolve(String(filePath || "")).toLowerCase(),
    Math.max(0, Number(size || 0)),
    Math.max(0, Number(mtimeMs || 0)),
  ].join("|");
}

function pruneReplicationHashCache() {
  while (_replicationFileHashCache.size > REPLICATION_HASH_CACHE_LIMIT) {
    const oldest = _replicationFileHashCache.keys().next();
    if (oldest.done) break;
    _replicationFileHashCache.delete(oldest.value);
  }
}

async function getCachedFileSha256(filePath, statHint = null) {
  const stat = statHint || await fs.promises.stat(filePath);
  const size = Math.max(0, Number(stat?.size || 0));
  const mtimeMs = Math.max(0, Number(stat?.mtimeMs || 0));
  const cacheKey = buildReplicationHashCacheKey(filePath, size, mtimeMs);
  const cached = _replicationFileHashCache.get(cacheKey);
  if (cached?.sha256) {
    _replicationFileHashCache.delete(cacheKey);
    _replicationFileHashCache.set(cacheKey, cached);
    return String(cached.sha256);
  }
  const sha256 = await hashFileSha256(filePath);
  _replicationFileHashCache.set(cacheKey, { sha256 });
  pruneReplicationHashCache();
  return sha256;
}

function isGatewayMainDbSnapshotUsable(snapshot, nowTs = Date.now()) {
  return Boolean(
    snapshot?.tempPath &&
    Number(snapshot?.expiresAt || 0) > nowTs &&
    fs.existsSync(snapshot.tempPath),
  );
}

async function disposeGatewayMainDbSnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.cleanupTimer) {
    clearTimeout(snapshot.cleanupTimer);
    snapshot.cleanupTimer = null;
  }
  if (Number(snapshot.refCount || 0) > 0) {
    scheduleGatewayMainDbSnapshotCleanup(snapshot, GATEWAY_MAIN_DB_SNAPSHOT_CACHE_TTL_MS);
    return;
  }
  if (_gatewayMainDbSnapshot === snapshot) {
    const remainingMs = Math.max(0, Number(snapshot.expiresAt || 0) - Date.now());
    if (remainingMs > 0) {
      scheduleGatewayMainDbSnapshotCleanup(snapshot, remainingMs);
      return;
    }
    _gatewayMainDbSnapshot = null;
  }
  try {
    await fs.promises.unlink(snapshot.tempPath);
  } catch (err) {
    const code = String(err?.code || "").trim().toUpperCase();
    if (code !== "ENOENT") {
      console.warn(
        "[replication] failed to clean up cached main DB snapshot:",
        String(err?.message || err || "unknown error"),
      );
    }
  }
}

function scheduleGatewayMainDbSnapshotCleanup(snapshot, delayMs = 0) {
  if (!snapshot) return;
  if (snapshot.cleanupTimer) {
    clearTimeout(snapshot.cleanupTimer);
    snapshot.cleanupTimer = null;
  }
  const delay = Math.max(1000, Number(delayMs || 0));
  const timer = setTimeout(() => {
    disposeGatewayMainDbSnapshot(snapshot).catch((err) => {
      console.warn(
        "[replication] cached main DB snapshot cleanup failed:",
        String(err?.message || err || "unknown error"),
      );
    });
  }, delay);
  if (timer.unref) timer.unref();
  snapshot.cleanupTimer = timer;
}

function retainGatewayMainDbSnapshot(snapshot) {
  if (!snapshot) return null;
  snapshot.refCount = Math.max(0, Number(snapshot.refCount || 0)) + 1;
  if (snapshot.cleanupTimer) {
    clearTimeout(snapshot.cleanupTimer);
    snapshot.cleanupTimer = null;
  }
  return snapshot;
}

function releaseGatewayMainDbSnapshotForTransfer(snapshot) {
  if (!snapshot) return;
  snapshot.refCount = Math.max(0, Number(snapshot.refCount || 0) - 1);
  if (Number(snapshot.refCount || 0) > 0) return;
  disposeGatewayMainDbSnapshot(snapshot).catch((err) => {
    console.warn(
      "[replication] main DB snapshot release cleanup failed:",
      String(err?.message || err || "unknown error"),
    );
  });
}

function cleanupGatewayMainDbSnapshotSync() {
  const snapshot = _gatewayMainDbSnapshot;
  _gatewayMainDbSnapshot = null;
  if (!snapshot?.tempPath) return;
  if (snapshot.cleanupTimer) {
    clearTimeout(snapshot.cleanupTimer);
    snapshot.cleanupTimer = null;
  }
  try {
    fs.unlinkSync(snapshot.tempPath);
  } catch (err) {
    const code = String(err?.code || "").trim().toUpperCase();
    if (code !== "ENOENT") {
      console.warn(
        "[replication] failed to remove cached main DB snapshot during shutdown:",
        String(err?.message || err || "unknown error"),
      );
    }
  }
}

async function maybeCheckpointGatewayMainDbBeforeSnapshot() {
  const nowTs = Date.now();
  if (
    nowTs - Number(_gatewayMainDbSnapshotLastCheckpointTs || 0) <
    GATEWAY_MAIN_DB_SNAPSHOT_CHECKPOINT_MIN_MS
  ) {
    return;
  }
  _gatewayMainDbSnapshotLastCheckpointTs = nowTs;
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch (_) {
    _gatewayMainDbSnapshotLastCheckpointTs = 0;
  }
}

async function buildGatewayMainDbSnapshotForTransfer() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const tempPath = path.join(
    DATA_DIR,
    `adsi.db.snapshot-${Date.now()}-${process.pid}.tmp`,
  );
  let todayReportRows = [];
  let currentDaySnapshot = null;
  try {
    try {
      poller.flushPending();
    } catch (_) {
      // Best effort only; backup still produces a consistent snapshot.
    }
    try {
      // Reuse the same authoritative today-energy rows for snapshot report
      // injection so a standby refresh does not rescan the full current-day
      // energy range again right after /api/energy/today has already warmed it.
      currentDaySnapshot = buildCurrentDayEnergySnapshot();
      // Refresh standby DB should stay read-only against the gateway's live DB.
      // Compute current-day report rows in memory, then apply them only to the
      // temporary snapshot so the downloaded file stays aligned with the UI.
      todayReportRows = buildDailyReportRowsForDate(localDateStr(), {
        persist: false,
        includeTodayPartial: true,
        refresh: false,
        todayEnergyRows: currentDaySnapshot?.rows || [],
      });
    } catch (err) {
      console.warn(
        "[replication] standby snapshot today-report compute failed:",
        String(err?.message || err || "unknown error"),
      );
    }
    await maybeCheckpointGatewayMainDbBeforeSnapshot();
    await db.backup(tempPath);
    if (Array.isArray(todayReportRows) && todayReportRows.length > 0) {
      try {
        upsertDailyReportRowsToSnapshot(tempPath, todayReportRows);
      } catch (err) {
        console.warn(
          "[replication] standby snapshot today-report apply failed:",
          String(err?.message || err || "unknown error"),
        );
      }
    }
    const stat = await fs.promises.stat(tempPath);
    const sha256 = await getCachedFileSha256(tempPath, stat);
    return {
      tempPath,
      size: Math.max(0, Number(stat?.size || 0)),
      mtimeMs: Math.max(0, Number(stat?.mtimeMs || Date.now())),
      sha256,
      expiresAt: Date.now() + GATEWAY_MAIN_DB_SNAPSHOT_CACHE_TTL_MS,
      refCount: 0,
      cleanupTimer: null,
    };
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore temp cleanup failures after snapshot build errors.
    }
    throw err;
  }
}

function createReplicationGzipStream() {
  return zlib.createGzip({
    level: 4, // balanced speed/ratio for SQLite payloads (was Z_BEST_SPEED=1)
    chunkSize: REPLICATION_TRANSFER_STREAM_HWM,
  });
}

function requestAcceptsGzip(req) {
  const acceptEncoding = String(req?.headers?.["accept-encoding"] || "").toLowerCase();
  return acceptEncoding.includes("gzip");
}

function shouldGzipReplicationStream(req, rawBytes) {
  return requestAcceptsGzip(req) && Number(rawBytes || 0) >= REPLICATION_STREAM_GZIP_MIN_BYTES;
}

function sendJsonMaybeGzip(req, res, payload) {
  const raw = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Keep replication JSON uncompressed so all gateway<->remote transfer lanes
  // follow the same low-CPU identity behavior.
  res.setHeader("Content-Length", String(raw.length));
  res.end(raw);
}

function encodeJsonRequestBody(payload) {
  const raw = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  return {
    headers: {
    "Content-Type": "application/json",
      "Content-Length": String(raw.length),
    },
    body: raw,
  };
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
      const jitter = Math.floor(Math.random() * 250 * i);
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
  const encodedBody = encodeJsonRequestBody({ cursors });

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const r = await fetch(targetUrl, buildReplicationTransferFetchOptions(targetUrl, {
        method: "POST",
        headers: {
          ...buildRemoteProxyHeaders(),
          ...encodedBody.headers,
        },
        body: encodedBody.body,
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
      const jitter = Math.floor(Math.random() * 250 * i);
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
      const r = await fetch(targetUrl, buildReplicationTransferFetchOptions(targetUrl, {
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
      const jitter = Math.floor(Math.random() * 250 * i);
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
  const nowTs = Date.now();
  if (isGatewayMainDbSnapshotUsable(_gatewayMainDbSnapshot, nowTs)) {
    return retainGatewayMainDbSnapshot(_gatewayMainDbSnapshot);
  }
  if (_gatewayMainDbSnapshot && !isGatewayMainDbSnapshotUsable(_gatewayMainDbSnapshot, nowTs)) {
    disposeGatewayMainDbSnapshot(_gatewayMainDbSnapshot).catch(() => {});
  }
  if (_gatewayMainDbSnapshotBuildPromise) {
    return retainGatewayMainDbSnapshot(await _gatewayMainDbSnapshotBuildPromise);
  }
  _gatewayMainDbSnapshotBuildPromise = (async () => {
    const previousSnapshot = _gatewayMainDbSnapshot;
    const nextSnapshot = await buildGatewayMainDbSnapshotForTransfer();
    _gatewayMainDbSnapshot = nextSnapshot;
    if (previousSnapshot && previousSnapshot !== nextSnapshot) {
      previousSnapshot.expiresAt = 0;
      disposeGatewayMainDbSnapshot(previousSnapshot).catch(() => {});
    }
    return nextSnapshot;
  })();
  try {
    return retainGatewayMainDbSnapshot(await _gatewayMainDbSnapshotBuildPromise);
  } finally {
    _gatewayMainDbSnapshotBuildPromise = null;
  }
}

async function refreshStandbyTodayShadowFromGateway(baseUrl, options = {}) {
  const signal = options?.signal || null;
  throwIfManualReplicationAborted(signal);
  const base = getRemoteTodayEnergySourceKey(baseUrl);
  if (!base) {
    return { ok: false, rows: [], error: "Remote gateway URL is not configured." };
  }
  const targetUrl = `${base}/api/energy/today`;
  try {
    const r = await fetchWithRetry(
      targetUrl,
      buildReplicationTransferFetchOptions(targetUrl, {
        method: "GET",
        headers: buildRemoteProxyHeaders(),
        timeout: Math.min(REMOTE_REPLICATION_TIMEOUT_MS, 15000),
        signal,
      }),
      {
        attempts: Math.max(1, Number(REMOTE_LIVE_FETCH_RETRIES || 1)),
        baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
      },
    );
    if (!r.ok) {
      const err = new Error(`Standby today-energy HTTP ${r.status} ${r.statusText}`);
      err.httpStatus = Number(r.status || 0);
      throw err;
    }
    const rows = normalizeTodayEnergyRows(await r.json());
    if (!rows.length) {
      return { ok: false, rows: [], error: "Gateway returned no today-energy rows." };
    }
    const syncedAt = Date.now();
    remoteBridgeState.todayEnergyRows = rows;
    remoteBridgeState.lastTodayEnergyFetchTs = syncedAt;
    remoteBridgeState.lastTodayEnergyShadowPersistTs = syncedAt;
    updateRemoteTodayEnergyShadow(rows, syncedAt, { sourceKey: base });
    return { ok: true, rows, syncedAt, fallbackUsed: false };
  } catch (err) {
    if (isManualReplicationAbortError(err)) {
      throw createManualReplicationAbortError(
        "Standby DB refresh cancelled by operator.",
      );
    }
    let fallbackRows = normalizeTodayEnergyRows(remoteBridgeState.todayEnergyRows);
    if (!fallbackRows.length) {
      fallbackRows = getRemoteTodayEnergyShadowRows(localDateStr(), {
        requireSourceMatch: true,
        sourceKey: base,
      });
    }
    if (fallbackRows.length) {
      const syncedAt = Date.now();
      updateRemoteTodayEnergyShadow(fallbackRows, syncedAt, { sourceKey: base });
      return {
        ok: false,
        rows: fallbackRows,
        syncedAt,
        error: String(err?.message || err || "Standby today-energy refresh failed."),
        fallbackUsed: true,
      };
    }
    return {
      ok: false,
      rows: [],
      error: String(err?.message || err || "Standby today-energy refresh failed."),
      fallbackUsed: false,
    };
  }
}

async function pullMainDbFromRemote(baseUrl, opts = {}) {
  const signal = opts?.signal || null;
  const runControl = opts?.runControl || null;
  throwIfManualReplicationAborted(signal);
  if (remoteBridgeState.replicationRunning) {
    return { skipped: true, reason: "in_progress" };
  }
  remoteBridgeState.replicationRunning = true;
  remoteBridgeState.lastReplicationAttemptTs = Date.now();
  remoteBridgeState.lastReplicationError = "";

  const xferLabel = String(opts?.label || "Downloading main database");
  const nextSyncDirection = String(opts?.syncDirection || "pull-main-db-staged");
  const failureDirection = String(opts?.failureDirection || "pull-main-db-failed");
  const tempPath = path.join(DATA_DIR, `adsi.db.download-${Date.now()}.tmp`);
  let recvBytes = 0;
  let totalBytes = 0;
  let expectedSha256 = "";
  let preserveRows = [];
  let standbyTodayShadow = null;
  let stagedTempName = "";
  const transferMeta = {
    priorityMode: Boolean(opts?.priorityMode),
    livePaused: Boolean(opts?.livePaused),
    stage: "main-db",
    note: String(opts?.note || "").trim(),
  };

  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    standbyTodayShadow = await refreshStandbyTodayShadowFromGateway(baseUrl, { signal });
    if (!standbyTodayShadow?.ok && !standbyTodayShadow?.fallbackUsed) {
      console.warn(
        "[replication] standby today-energy baseline refresh failed:",
        String(standbyTodayShadow?.error || "unknown error"),
      );
    }
    preserveRows = capturePreservedMainDbSettings();
    const targetUrl = `${baseUrl}/api/replication/main-db`;
    const r = await fetch(targetUrl, buildReplicationTransferFetchOptions(targetUrl, {
      method: "GET",
      headers: buildRemoteProxyHeaders(),
      timeout: REMOTE_REPLICATION_TIMEOUT_MS,
      signal,
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

    // Read gateway cursors so we can converge sync state after pull.
    let gatewayCursors = null;
    try {
      const cursorsRaw = String(r.headers.get("x-main-db-cursors") || "").trim();
      if (cursorsRaw && cursorsRaw !== "{}") {
        gatewayCursors = normalizeReplicationCursors(JSON.parse(cursorsRaw));
      }
    } catch (_) { /* ignore malformed cursor header */ }

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
      ...transferMeta,
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
        ...transferMeta,
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
    stagedTempName = String(staged?.tempName || path.basename(tempPath)).trim();
    trackManualReplicationStagedMainDb(runControl, stagedTempName);
    throwIfManualReplicationAborted(signal);

    remoteBridgeState.lastReplicationTs = Date.now();
    remoteBridgeState.lastReplicationRows = 0;
    remoteBridgeState.lastReplicationSignature = "";
    remoteBridgeState.lastReplicationError = "";
    remoteBridgeState.lastSyncDirection = nextSyncDirection;

    // Converge replication cursors with gateway so incremental sync starts fresh.
    if (gatewayCursors) {
      remoteBridgeState.replicationCursors = gatewayCursors;
      try { saveReplicationCursorsSetting(gatewayCursors); } catch (_) { /* non-fatal */ }
    }

    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "done",
      recvBytes,
      totalBytes: totalBytes > 0 ? totalBytes : recvBytes,
      chunkCount: 1,
      importedRows: 1,
      label: xferLabel,
      ...transferMeta,
    });

    return {
      ok: true,
      staged: true,
      size: Math.max(0, Number(staged?.size || recvBytes || 0)),
      mtimeMs: Math.max(0, Number(staged?.mtimeMs || targetMtimeMs || 0)),
      standbyTodayShadow:
        standbyTodayShadow && typeof standbyTodayShadow === "object"
          ? {
              ok: Boolean(standbyTodayShadow.ok),
              rows: Array.isArray(standbyTodayShadow.rows)
                ? Number(standbyTodayShadow.rows.length || 0)
                : 0,
              fallbackUsed: Boolean(standbyTodayShadow.fallbackUsed),
              error: String(standbyTodayShadow.error || ""),
            }
          : null,
      preservedSettings: preserveRows
        .map((row) => String(row?.key || ""))
        .filter(Boolean),
    };
  } catch (err) {
    if (stagedTempName) {
      try {
        discardPendingMainDbReplacement(stagedTempName);
      } catch (_) {
        // Ignore staged manifest cleanup failures.
      }
      if (
        runControl &&
        typeof runControl === "object" &&
        String(runControl.stagedMainTempName || "").trim() === stagedTempName
      ) {
        runControl.stagedMainTempName = "";
      }
    }
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore temp cleanup failures.
    }
    if (isManualReplicationAbortError(err)) {
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "cancelled",
        recvBytes,
        totalBytes: totalBytes > 0 ? totalBytes : recvBytes,
        chunkCount: 1,
        label: xferLabel,
        ...transferMeta,
      });
      remoteBridgeState.lastReplicationError = "Standby DB refresh cancelled by operator.";
      if (remoteBridgeState.lastSyncDirection !== "push-failed") {
        remoteBridgeState.lastSyncDirection = "pull-main-db-cancelled";
      }
      throw createManualReplicationAbortError(
        "Standby DB refresh cancelled by operator.",
      );
    }
    broadcastUpdate({
      type: "xfer_progress",
      dir: "rx",
      phase: "error",
      recvBytes,
      totalBytes: totalBytes > 0 ? totalBytes : recvBytes,
      chunkCount: 1,
      label: xferLabel,
      ...transferMeta,
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

async function fetchRemoteArchiveManifest(baseUrl, options = {}) {
  const signal = options?.signal || null;
  throwIfManualReplicationAborted(signal);
  const targetUrl = `${baseUrl}/api/replication/archive-manifest`;
  const r = await fetch(targetUrl, buildRemoteFetchOptions(targetUrl, {
    method: "GET",
    headers: buildRemoteProxyHeaders(),
    timeout: REMOTE_REPLICATION_TIMEOUT_MS,
    signal,
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

async function downloadArchiveFileFromRemote(baseUrl, fileMeta, onBytes, options = {}) {
  const signal = options?.signal || null;
  const runControl = options?.runControl || null;
  throwIfManualReplicationAborted(signal);
  const name = sanitizeArchiveFileName(fileMeta?.name || "");
  if (!name) throw new Error("Invalid archive file name.");
  const monthKey = monthKeyFromArchiveFileName(name);
  const tempPath = path.join(ARCHIVE_DIR, `${name}.download-${Date.now()}.tmp`);
  await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
  closeArchiveDbForMonth(monthKey);

  const RESUME_MAX_ATTEMPTS = 3;
  let expectedSha256 = "";
  let resumeOffset = 0;
  let stagedTempName = "";

  try {
    for (let attempt = 1; attempt <= RESUME_MAX_ATTEMPTS; attempt += 1) {
      const targetUrl = `${baseUrl}/api/replication/archive-download?file=${encodeURIComponent(name)}`;
      const reqHeaders = { ...buildRemoteProxyHeaders() };

      // On retry, try to resume from where we left off.
      if (resumeOffset > 0) {
        reqHeaders["Range"] = `bytes=${resumeOffset}-`;
      }

      let r;
      try {
        r = await fetch(
          targetUrl,
          buildReplicationTransferFetchOptions(targetUrl, {
            method: "GET",
            headers: reqHeaders,
            timeout: REMOTE_REPLICATION_TIMEOUT_MS,
            signal,
          }),
        );
      } catch (fetchErr) {
        // On network error, check partial file size for resume.
        if (attempt < RESUME_MAX_ATTEMPTS && isRetryableNetworkError(fetchErr)) {
          try {
            const partialStat = await fs.promises.stat(tempPath);
            resumeOffset = Math.max(0, Number(partialStat.size || 0));
          } catch (_) {
            resumeOffset = 0;
          }
          const jitter = Math.floor(Math.random() * 500 * attempt);
          await waitMs(1000 * attempt + jitter);
          continue;
        }
        throw fetchErr;
      }

      // If server doesn't support range (416 or 200 on range request), restart from scratch.
      if (resumeOffset > 0 && r.status === 416) {
        resumeOffset = 0;
        try { await fs.promises.unlink(tempPath); } catch (_) { /* ignore */ }
        continue;
      }
      if (resumeOffset > 0 && r.status === 200) {
        // Server ignored Range header — restart from scratch.
        resumeOffset = 0;
        try { await fs.promises.unlink(tempPath); } catch (_) { /* ignore */ }
      }

      throwIfManualReplicationAborted(signal);
      if (!r.ok && r.status !== 206) {
        throw new Error(`Archive download HTTP ${r.status} ${r.statusText}`);
      }
      expectedSha256 = String(r.headers.get("x-archive-sha256") || "").trim().toLowerCase();
      const body = r.body;
      if (!body) {
        throw new Error("Archive download returned an empty body.");
      }
      body.on("data", (chunk) => {
        const bytes = Math.max(0, Buffer.byteLength(chunk || Buffer.alloc(0)));
        if (bytes > 0 && typeof onBytes === "function") onBytes(bytes);
      });

      // On 206 Partial Content, append to existing temp file; otherwise overwrite.
      const writeFlags = r.status === 206 ? "a" : "w";
      const writeStream = fs.createWriteStream(tempPath, {
        flags: writeFlags,
        highWaterMark: REPLICATION_TRANSFER_STREAM_HWM,
      });

      try {
        await pipeline(body, writeStream);
      } catch (streamErr) {
        if (attempt < RESUME_MAX_ATTEMPTS && isRetryableNetworkError(streamErr)) {
          try {
            const partialStat = await fs.promises.stat(tempPath);
            resumeOffset = Math.max(0, Number(partialStat.size || 0));
          } catch (_) {
            resumeOffset = 0;
          }
          const jitter = Math.floor(Math.random() * 500 * attempt);
          await waitMs(1000 * attempt + jitter);
          continue;
        }
        throw streamErr;
      }

      // Download completed — break out of retry loop.
      break;
    }

    const verified = await verifyTransferredFile(tempPath, {
      expectedSize: Math.max(0, Number(fileMeta?.size || 0)),
      expectedSha256,
    });
    const targetMtimeMs = Math.max(0, Number(fileMeta?.mtimeMs || 0));
    if (targetMtimeMs > 0) {
      const mtime = new Date(targetMtimeMs);
      await fs.promises.utimes(tempPath, mtime, mtime);
    }
    const staged = stagePendingArchiveReplacement({
      name,
      monthKey,
      tempName: path.basename(tempPath),
      size: Math.max(0, Number(verified?.size || fileMeta?.size || 0)),
      mtimeMs: targetMtimeMs,
    });
    stagedTempName = String(staged?.tempName || path.basename(tempPath)).trim();
    trackManualReplicationStagedArchive(
      runControl,
      name,
      stagedTempName,
    );
    throwIfManualReplicationAborted(signal);
  } catch (err) {
    if (stagedTempName) {
      try {
        discardPendingArchiveReplacement(name, stagedTempName);
      } catch (_) {
        // Ignore staged archive cleanup failures.
      }
      if (runControl?.stagedArchiveEntries instanceof Map) {
        runControl.stagedArchiveEntries.delete(name);
      }
    }
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
  prepareArchiveDbForTransfer(monthKey);
  const stat = await fs.promises.stat(filePath);
  const sha256 = await getCachedFileSha256(filePath, stat);
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

async function pullArchiveFilesFromRemote(baseUrl, options = {}) {
  const signal = options?.signal || null;
  const runControl = options?.runControl || null;
  throwIfManualReplicationAborted(signal);
  const forceAll = Boolean(options?.forceAll);
  const concurrency = Math.max(
    1,
    Math.min(4, Number(options?.concurrency || REMOTE_ARCHIVE_TRANSFER_CONCURRENCY) || 1),
  );
  const transferMeta = {
    priorityMode: Boolean(options?.priorityMode),
    livePaused: Boolean(options?.livePaused),
    stage: "archive",
    note: String(options?.note || "").trim(),
  };
  const remoteManifestRes = await fetchRemoteArchiveManifest(baseUrl, { signal });
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
  const toPull = forceAll
    ? remoteManifest.slice()
    : remoteManifest.filter((entry) =>
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
      label: "Downloading archive",
      ...transferMeta,
    });
  }

  try {
    await runTasksWithConcurrency(
      toPull,
      concurrency,
      async (fileMeta) => {
        throwIfManualReplicationAborted(signal);
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
            label: "Downloading archive",
            ...transferMeta,
          });
        }, {
          ...options,
          signal,
          runControl,
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
          label: "Downloading archive",
          ...transferMeta,
        });
      },
    );
  } catch (err) {
    if (isManualReplicationAbortError(err)) {
      if (toPull.length > 0) {
        broadcastUpdate({
          type: "xfer_progress",
          dir: "rx",
          phase: "cancelled",
          recvBytes: transferredBytes,
          totalBytes,
          chunkCount: toPull.length,
          label: "Downloading archive",
          ...transferMeta,
        });
      }
      throw createManualReplicationAbortError(
        "Standby DB refresh cancelled by operator.",
      );
    }
    if (toPull.length > 0) {
      broadcastUpdate({
        type: "xfer_progress",
        dir: "rx",
        phase: "error",
        recvBytes: transferredBytes,
        totalBytes,
        chunkCount: toPull.length,
        label: "Downloading archive",
        ...transferMeta,
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
      label: "Downloading archive",
      ...transferMeta,
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
  const runControl = createManualReplicationRunControl(jobId, action);
  manualReplicationRunControl = runControl;
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
    cancelRequested: false,
    result: null,
  });

  setTimeout(async () => {
    try {
      throwIfManualReplicationAborted(
        runControl?.controller?.signal || null,
        "Standby DB refresh cancelled by operator.",
      );
      updateManualReplicationJob({
        status: "running",
        cancelRequested: false,
        summary: String(options?.runningSummary || "Running"),
      });
      const result = await runner(runControl);
      updateManualReplicationJob({
        status: "completed",
        running: false,
        finishedAt: Date.now(),
        summary: String(
          result?.summary ||
            `${String(action || "sync")} complete. Restart the app to refresh in-memory state.`,
        ),
        error: "",
        errorCode: "",
        needsRestart: Boolean(result?.needsRestart),
        livePaused: false,
        cancelRequested: false,
        result:
          result && typeof result === "object"
            ? { ...result }
            : null,
      });
    } catch (err) {
      if (isManualReplicationAbortError(err)) {
        discardTrackedManualReplicationArtifacts(runControl);
        updateManualReplicationJob({
          status: "cancelled",
          running: false,
          finishedAt: Date.now(),
          summary: String(err?.message || "Standby DB refresh cancelled."),
          error: "",
          errorCode: MANUAL_REPLICATION_CANCEL_CODE,
          needsRestart: false,
          livePaused: false,
          cancelRequested: false,
          result: null,
        });
        return;
      }
      discardTrackedManualReplicationArtifacts(runControl);
      updateManualReplicationJob({
        status: "failed",
        running: false,
        finishedAt: Date.now(),
        summary: `${String(action || "sync")} failed`,
        error: String(err?.message || err),
        errorCode: String(err?.code || ""),
        needsRestart: false,
        livePaused: false,
        cancelRequested: false,
        result: null,
      });
    } finally {
      if (manualReplicationRunControl === runControl) {
        manualReplicationRunControl = null;
      }
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

// Centralized proxy timeout rules: [pathPrefix, timeoutMs]
// Ordered from most specific to least specific; first match wins.
const PROXY_TIMEOUT_RULES = [
  ["/api/export/",       600000],  // 10 min — large CSV/Excel exports
  ["/api/report/",        45000],  // 45 s  — daily report generation
  ["/api/replication/",    45000],  // 45 s  — replication sync
  ["/api/write",          60000],  // 60 s  — control writes, including batched inverter actions
  ["/api/plant-cap/",      60000],  // 60 s  — sequential plant cap release/control actions
  ["/api/analytics/",      20000],  // 20 s  — analytics queries
  ["/api/energy/5min",     20000],  // 20 s  — energy range queries
  ["/api/alarms",          20000],  // 20 s  — alarm queries
  ["/api/audit",           20000],  // 20 s  — audit queries
  ["/api/chat/",           10000],  // 10 s  — chat messaging
  ["/api/backup/",         60000],  // 60 s  — cloud backup operations
  ["/api/substation-meter/", 20000],  // 20 s  — substation meter reads/writes
];

function resolveProxyTimeout(targetUrl) {
  try {
    const p = String(new URL(String(targetUrl || "")).pathname || "").toLowerCase();
    for (const [prefix, ms] of PROXY_TIMEOUT_RULES) {
      if (p.startsWith(prefix)) return Math.max(REMOTE_FETCH_TIMEOUT_MS, ms);
    }
  } catch (_) {
    // Malformed URL — fall through to default.
  }
  return REMOTE_FETCH_TIMEOUT_MS;
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
  const timeoutMs = resolveProxyTimeout(target);
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

async function proxyWriteToRemote(req, res, targetPath = "/api/write") {
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

  const path =
    String(targetPath || "/api/write").trim() || "/api/write";
  const target = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const payload =
    req?.body && typeof req.body === "object"
      ? { ...req.body }
      : {};
  try {
    const upstream = await fetch(
      target,
      buildRemoteFetchOptions(
        target,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-control-priority": "high",
            ...buildRemoteProxyHeaders(),
          },
          body: JSON.stringify(payload),
          timeout: REMOTE_CONTROL_PROXY_TIMEOUT_MS,
        },
        "control",
      ),
    );
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (_) {
      parsed = null;
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: String(parsed?.error || text || `Remote control failed (${upstream.status} ${upstream.statusText})`),
      });
    }
    return res.json(parsed && typeof parsed === "object" ? parsed : { ok: true });
  } catch (err) {
    const msg = String(err?.message || err || "").trim();
    const friendly = /timed out|timeout/i.test(msg)
      ? `Gateway control path timeout after ${REMOTE_CONTROL_PROXY_TIMEOUT_MS} ms.`
      : msg;
    return res.status(502).json({
      ok: false,
      error: `Remote control request failed: ${friendly}`,
    });
  }
}

async function performLocalWriteRequest(url, upstreamPayload) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamPayload),
      timeout: WRITE_ENGINE_TIMEOUT_MS,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(
        data.error ||
          data.msg ||
          `Upstream write failed (${r.status} ${r.statusText})`,
      );
    }
    return data;
  } catch (err) {
    const msg = String(err?.message || err || "").trim();
    if (/timed out|timeout/i.test(msg)) {
      throw new Error(
        `Control engine timeout after ${WRITE_ENGINE_TIMEOUT_MS} ms.`,
      );
    }
    if (/econnrefused|socket hang up|fetch failed/i.test(msg.toLowerCase())) {
      throw new Error("Control engine is temporarily unavailable.");
    }
    throw err;
  }
}

function resolveBatchWriteUrl(urlRaw) {
  const fallback = `${INVERTER_ENGINE_BASE_URL}/write/batch`;
  const raw = String(urlRaw || "").trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    const pathname = String(parsed.pathname || "");
    if (/\/write\/?$/i.test(pathname)) {
      parsed.pathname = pathname.replace(/\/write\/?$/i, "/write/batch");
    } else {
      parsed.pathname = `${pathname.replace(/\/+$/, "")}/batch`;
    }
    return parsed.toString();
  } catch (_) {
    if (/\/write\/?$/i.test(raw)) return raw.replace(/\/write\/?$/i, "/write/batch");
    return `${raw.replace(/\/+$/, "")}/batch`;
  }
}

async function performLocalWriteBatchRequest(url, upstreamPayload) {
  const batchUrl = resolveBatchWriteUrl(url);
  try {
    const r = await fetch(batchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamPayload),
      timeout: WRITE_ENGINE_TIMEOUT_MS,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(
        data.error ||
          data.msg ||
          `Upstream batch write failed (${r.status} ${r.statusText})`,
      );
    }
    return data;
  } catch (err) {
    const msg = String(err?.message || err || "").trim();
    if (/timed out|timeout/i.test(msg)) {
      throw new Error(
        `Control engine timeout after ${WRITE_ENGINE_TIMEOUT_MS} ms.`,
      );
    }
    if (/econnrefused|socket hang up|fetch failed/i.test(msg.toLowerCase())) {
      throw new Error("Control engine is temporarily unavailable.");
    }
    throw err;
  }
}

function isAuthorizedPlantWideControl({ authKey, authToken } = {}, req) {
  // T2.1 fix: share a single clock read across both checks so a clock step
  // between them can't cause inconsistent validation.
  // T2.3 fix (Phase 5): pass req so a bound session token is rejected when
  // replayed from a different IP/UA.  Callers that did not pass req
  // (legacy paths, tests) keep the old behaviour — only unbound sessions
  // pass that route, and the rotating sacupsMM key is unaffected.
  const nowMs = Date.now();
  return (
    isValidPlantWideAuthSession(authToken, nowMs, req) || isValidPlantWideAuthKey(authKey, nowMs)
  );
}

function getWriteActionLabel(value) {
  const numeric = Number(value);
  if (numeric === 1) return "START";
  if (numeric === 0) return "STOP";
  if (numeric === 2) return "RESET";
  return "WRITE";
}

function sanitizeWriteUnits(unitsRaw, nodeMax) {
  const source = Array.isArray(unitsRaw) ? unitsRaw : [];
  const out = [];
  for (const unitRaw of source) {
    const unitNum = Number(unitRaw);
    if (!Number.isFinite(unitNum) || unitNum < 1 || unitNum > nodeMax) continue;
    const normalized = Math.trunc(unitNum);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function normalizeBatchWriteResults(units, data) {
  const safeUnits = Array.isArray(units) ? units : [];
  const rawResults = Array.isArray(data?.results) ? data.results : [];
  return safeUnits.map((unit) => {
    const match = rawResults.find((entry) => Number(entry?.unit) === Number(unit));
    return {
      unit: Number(unit),
      ok: Boolean(match?.ok),
    };
  });
}

async function executeLocalControlWriteRequest(bodyRaw = {}, options = {}) {
  const {
    inverter,
    node,
    unit,
    value,
    scope,
    operator,
    authKey,
    authToken,
    priority,
    reason,
  } = bodyRaw || {};
  const skipBulkAuth = Boolean(options?.skipBulkAuth);
  const url = getSetting("writeUrl", `${INVERTER_ENGINE_BASE_URL}/write`);
  const invNum = Number(inverter);
  const unitNum = Number(unit ?? node);
  const valueNum = Number(value);
  const invMax = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const nodeMax = Math.max(1, Number(getSetting("nodeCount", 4)) || 4);

  if (!Number.isFinite(invNum) || invNum < 1 || invNum > invMax) {
    const err = new Error("Invalid inverter");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(unitNum) || unitNum < 1 || unitNum > nodeMax) {
    const err = new Error("Invalid unit/node");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(valueNum) || (valueNum !== 0 && valueNum !== 1 && valueNum !== 2)) {
    const err = new Error("Invalid value");
    err.status = 400;
    throw err;
  }

  const scopeNorm = normalizeWriteScope(scope || "single");
  const isBulkScope =
    scopeNorm === "all" || scopeNorm === "selected" || scopeNorm === "plant-cap";
  if (
    !skipBulkAuth &&
    isBulkScope &&
    !isAuthorizedPlantWideControl({ authKey, authToken }, options.req)
  ) {
    const err = new Error("Unauthorized bulk command");
    err.status = 403;
    throw err;
  }

  const operatorName =
    String(operator || getSetting("operatorName", "OPERATOR")).trim() || "OPERATOR";
  const cfg = loadIpConfigFromDb();
  const targetIp = String(
    cfg?.inverters?.[invNum] ?? cfg?.inverters?.[String(invNum)] ?? "",
  ).trim();
  const ip = targetIp || "";
  const upstreamPayload = { inverter: invNum, unit: unitNum, value: valueNum };
  const action = getWriteActionLabel(valueNum);
  if (
    plantCapController &&
    scopeNorm !== "plant-cap" &&
    typeof plantCapController.getManualWriteGuard === "function"
  ) {
    const guard = plantCapController.getManualWriteGuard({
      scope: scopeNorm,
      inverter: invNum,
      unit: unitNum,
      value: valueNum,
      operator: operatorName,
    });
    if (guard && guard.allowed === false) {
      logControlAction({
        operator: operatorName,
        inverter: invNum,
        node: unitNum || 0,
        action,
        scope: scopeNorm,
        result: `blocked:${String(guard.reasonCode || "plant_cap_active")}`,
        ip,
        reason: reason || "",
        details: String(guard.message || ""),
      });
      const err = new Error(
        String(
          guard.message ||
            "Plant Output Cap is active; manual control is blocked for this inverter.",
        ),
      );
      err.status = Number(guard.status || 409);
      throw err;
    }
  }
  try {
    const data = await enqueueWriteCommand(
      scopeNorm,
      () => performLocalWriteRequest(url, upstreamPayload),
      { priority, queueKey: ip || `inv-${invNum}` },
    );
    logControlAction({
      operator: operatorName,
      inverter: invNum,
      node: unitNum || 0,
      action,
      scope: scopeNorm,
      result: "ok",
      ip,
      reason: reason || "",
    });
    if (
      plantCapController &&
      scopeNorm !== "plant-cap" &&
      typeof plantCapController.handleManualWrite === "function"
    ) {
      plantCapController.handleManualWrite({
        scope: scopeNorm,
        inverter: invNum,
        unit: unitNum,
        value: valueNum,
        operator: operatorName,
      });
    }
    return {
      ok: true,
      data,
      inverter: invNum,
      unit: unitNum,
      scope: scopeNorm,
      action,
      operator: operatorName,
      ip,
    };
  } catch (e) {
    logControlAction({
      operator: operatorName,
      inverter: invNum,
      node: unitNum || 0,
      action,
      scope: scopeNorm,
      result: `error:${e.message}`,
      ip,
      reason: reason || "",
    });
    if (!Number(e?.status || 0)) e.status = 502;
    throw e;
  }
}

async function executeLocalBatchControlWriteRequest(bodyRaw = {}, options = {}) {
  const {
    inverter,
    units,
    value,
    scope,
    operator,
    authKey,
    authToken,
    priority,
  } = bodyRaw || {};
  const skipBulkAuth = Boolean(options?.skipBulkAuth);
  const url = getSetting("writeUrl", `${INVERTER_ENGINE_BASE_URL}/write`);
  const invNum = Number(inverter);
  const valueNum = Number(value);
  const invMax = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const nodeMax = Math.max(1, Number(getSetting("nodeCount", 4)) || 4);
  const unitList = sanitizeWriteUnits(units, nodeMax);

  if (!Number.isFinite(invNum) || invNum < 1 || invNum > invMax) {
    const err = new Error("Invalid inverter");
    err.status = 400;
    throw err;
  }
  if (!unitList.length) {
    const err = new Error("No valid units provided");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(valueNum) || (valueNum !== 0 && valueNum !== 1 && valueNum !== 2)) {
    const err = new Error("Invalid value");
    err.status = 400;
    throw err;
  }

  const scopeNorm = normalizeWriteScope(scope || "inverter");
  const isBulkScope =
    scopeNorm === "all" || scopeNorm === "selected" || scopeNorm === "plant-cap";
  if (
    !skipBulkAuth &&
    isBulkScope &&
    !isAuthorizedPlantWideControl({ authKey, authToken }, options.req)
  ) {
    const err = new Error("Unauthorized bulk command");
    err.status = 403;
    throw err;
  }

  const operatorName =
    String(operator || getSetting("operatorName", "OPERATOR")).trim() || "OPERATOR";
  const cfg = loadIpConfigFromDb();
  const targetIp = String(
    cfg?.inverters?.[invNum] ?? cfg?.inverters?.[String(invNum)] ?? "",
  ).trim();
  const ip = targetIp || "";
  const upstreamPayload = { inverter: invNum, units: unitList, value: valueNum };
  const action = getWriteActionLabel(valueNum);
  if (
    plantCapController &&
    scopeNorm !== "plant-cap" &&
    typeof plantCapController.getManualWriteGuard === "function"
  ) {
    const guard = plantCapController.getManualWriteGuard({
      scope: scopeNorm,
      inverter: invNum,
      units: unitList,
      value: valueNum,
      operator: operatorName,
    });
    if (guard && guard.allowed === false) {
      unitList.forEach((unit) => {
        logControlAction({
          operator: operatorName,
          inverter: invNum,
          node: unit || 0,
          action,
          scope: scopeNorm,
          result: `blocked:${String(guard.reasonCode || "plant_cap_active")}`,
          ip,
          details: String(guard.message || ""),
        });
      });
      const err = new Error(
        String(
          guard.message ||
            "Plant Output Cap is active; manual control is blocked for this inverter.",
        ),
      );
      err.status = Number(guard.status || 409);
      throw err;
    }
  }

  try {
    const data = await enqueueWriteCommand(
      scopeNorm,
      () => performLocalWriteBatchRequest(url, upstreamPayload),
      { priority, queueKey: ip || `inv-${invNum}` },
    );
    const results = normalizeBatchWriteResults(unitList, data);
    let okCount = 0;
    let failCount = 0;
    results.forEach(({ unit, ok }) => {
      if (ok) okCount += 1;
      else failCount += 1;
      logControlAction({
        operator: operatorName,
        inverter: invNum,
        node: unit || 0,
        action,
        scope: scopeNorm,
        result: ok ? "ok" : "error",
        ip,
      });
      if (
        ok &&
        plantCapController &&
        scopeNorm !== "plant-cap" &&
        typeof plantCapController.handleManualWrite === "function"
      ) {
        plantCapController.handleManualWrite({
          scope: scopeNorm,
          inverter: invNum,
          unit,
          value: valueNum,
          operator: operatorName,
        });
      }
    });

    return {
      ok: failCount === 0 && okCount > 0,
      partial: okCount > 0 && failCount > 0,
      data,
      inverter: invNum,
      units: unitList,
      scope: scopeNorm,
      action,
      operator: operatorName,
      ip,
      results,
      successCount: okCount,
      failureCount: failCount,
    };
  } catch (e) {
    unitList.forEach((unit) => {
      logControlAction({
        operator: operatorName,
        inverter: invNum,
        node: unit || 0,
        action,
        scope: scopeNorm,
        result: "error",
        ip,
        details: String(e?.message || e || ""),
      });
    });
    throw e;
  }
}

async function requestRemoteChat(pathname, {
  method = "GET",
  body = null,
  timeout = CHAT_PROXY_TIMEOUT_MS,
  retry = null,
  signal = null,
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
    signal: signal || undefined,
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

async function primeRemoteChatCursor(signal = null) {
  if (!isRemoteMode()) return 0;
  const payload = await requestRemoteChat(
    `/api/chat/messages?mode=thread&limit=${CHAT_THREAD_LIMIT}`,
    {
      method: "GET",
      timeout: CHAT_PROXY_TIMEOUT_MS,
      signal,
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
  const controller = new AbortController();
  remoteChatFetchController = controller;
  try {
    if (!remoteChatBridgeState.primed) {
      await primeRemoteChatCursor(controller.signal);
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
      signal: controller.signal,
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
  } finally {
    if (remoteChatFetchController === controller) {
      remoteChatFetchController = null;
    }
  }
}

function stopRemoteChatBridge() {
  if (remoteChatPollTimer) {
    clearTimeout(remoteChatPollTimer);
    remoteChatPollTimer = null;
  }
  if (remoteChatFetchController) {
    try { remoteChatFetchController.abort(); } catch (_) {}
    remoteChatFetchController = null;
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
      if (!remoteChatBridgeState.running || !isRemoteMode() || isAbortError(err)) {
        return;
      }
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

function closeRemoteBridgeSocket({ preserveHandlers = false } = {}) {
  const ws = remoteBridgeSocket;
  remoteBridgeSocket = null;
  if (!ws) return;
  try {
    if (!preserveHandlers && typeof ws.removeAllListeners === "function") {
      ws.removeAllListeners();
    }
    if (typeof ws.terminate === "function") {
      ws.terminate();
      return;
    }
    if (typeof ws.close === "function") {
      ws.close();
    }
  } catch (_) {}
}

function buildRemoteBridgeWsUrl(baseUrl, pathname = "/ws") {
  const u = new URL(String(baseUrl || "").trim());
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = pathname;
  u.search = "";
  u.hash = "";
  return u.toString();
}

function shouldPersistRemoteTodayEnergyShadow(nowTs = Date.now()) {
  return (
    nowTs - Number(remoteBridgeState.lastTodayEnergyShadowPersistTs || 0) >=
    REMOTE_ENERGY_POLL_INTERVAL_MS
  );
}

function isCurrentRemoteBridgeContext({
  bridgeSessionId,
  livePauseGeneration,
  base,
} = {}) {
  const isCurrentBridgeSession =
    bridgeSessionId === Math.max(0, Number(remoteBridgeState.bridgeSessionId || 0));
  const isCurrentPauseGeneration =
    livePauseGeneration === Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0));
  return Boolean(
    isCurrentBridgeSession &&
      isCurrentPauseGeneration &&
      !isRemoteLiveBridgePausedForTransfer() &&
      remoteBridgeState.running &&
      isRemoteMode() &&
      getRemoteGatewayBaseUrl() === base
  );
}

function applyRemoteBridgeLiveFrame(payload, context = {}) {
  const msg = payload && typeof payload === "object" ? payload : {};
  const data = msg.data && typeof msg.data === "object" ? msg.data : null;
  if (!data) return false;
  if (!isCurrentRemoteBridgeContext(context)) return false;

  const successTs = Date.now();
  remoteBridgeState.liveData = buildRemoteLiveSnapshot(data, successTs);
  remoteBridgeState.lastLatencyMs = Math.max(
    0,
    Number(context?.startedAt ? successTs - Number(context.startedAt || 0) : 0),
  );
  remoteBridgeState.lastLiveNodeCount = countRemoteLiveNodes(remoteBridgeState.liveData);
  remoteBridgeState.totals =
    msg.totals && typeof msg.totals === "object"
      ? {
          pac: Math.max(0, Number(msg.totals.pac || 0)),
          kwh: Math.max(0, Number(msg.totals.kwh || 0)),
        }
      : computeTotalsFromLiveData(remoteBridgeState.liveData);
  remoteBridgeState.connected = true;
  remoteBridgeState.liveFailureCount = 0;
  remoteBridgeState.lastFailureTs = 0;
  remoteBridgeState.lastSuccessTs = successTs;
  remoteBridgeState.lastReasonCode = "";
  remoteBridgeState.lastReasonClass = "";
  remoteBridgeState.lastError = "";
  if (Array.isArray(msg.todayEnergy)) {
    const normalizedRows = normalizeTodayEnergyRows(msg.todayEnergy);
    remoteBridgeState.todayEnergyRows = normalizedRows;
    remoteBridgeState.lastTodayEnergyFetchTs = successTs;
    if (shouldPersistRemoteTodayEnergyShadow(successTs)) {
      updateRemoteTodayEnergyShadow(normalizedRows, successTs);
      remoteBridgeState.lastTodayEnergyShadowPersistTs = successTs;
    }
    todayEnergyCache.ts = 0;
  }
  broadcastUpdate({
    type: "live",
    data: remoteBridgeState.liveData,
    totals: remoteBridgeState.totals,
    todayEnergy: getTodayEnergyRowsForWs(),
    remoteHealth: buildRemoteHealthSnapshot(successTs),
  });
  remoteBridgeState.lastHealthBroadcastKey = "";
  remoteBridgeState.lastSyncDirection = "stream-live";
  return true;
}

function handleRemoteBridgeStreamFailure(err, context = {}) {
  const wasConnected = Boolean(remoteBridgeState.connected);
  const hadLiveData = Boolean(
    remoteBridgeState.liveData &&
      typeof remoteBridgeState.liveData === "object" &&
      Object.keys(remoteBridgeState.liveData).length,
  );
  if (!isCurrentRemoteBridgeContext(context)) return;
  const failure = classifyRemoteBridgeFailure(err);
  const nowTs = Date.now();
  remoteBridgeState.connected = false;
  remoteBridgeState.liveFailureCount += 1;
  remoteBridgeState.lastFailureTs = nowTs;
  remoteBridgeState.lastReasonCode = failure.reasonCode;
  remoteBridgeState.lastReasonClass = failure.reasonClass;
  remoteBridgeState.lastError = failure.reasonText;
  if (!hasUsableRemoteLiveSnapshot(nowTs) && (wasConnected || hadLiveData)) {
    broadcastRemoteOfflineLiveState();
  }
  if (wasConnected) {
    remoteBridgeState.lastSyncDirection = "stream-live-failed";
  }
  broadcastRemoteHealthUpdate(true);
}

function scheduleRemoteBridgeReconnect() {
  if (!remoteBridgeState.running || isRemoteLiveBridgePausedForTransfer() || !isRemoteMode()) {
    return;
  }
  if (remoteBridgeTimer) {
    clearTimeout(remoteBridgeTimer);
    remoteBridgeTimer = null;
  }
  const nextDelay = getRemoteBridgeNextDelayMs(Date.now(), 0);
  remoteBridgeTimer = setTimeout(() => {
    remoteBridgeTimer = null;
    connectRemoteBridgeSocket();
  }, Math.round(nextDelay));
}

function connectRemoteBridgeSocket() {
  if (!remoteBridgeState.running || isRemoteLiveBridgePausedForTransfer() || !isRemoteMode()) {
    return;
  }
  const startedAt = Date.now();
  remoteBridgeState.lastAttemptTs = startedAt;
  const bridgeSessionId = Number(remoteBridgeState.bridgeSessionId || 0);
  const livePauseGeneration = Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0));
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    remoteBridgeState.connected = false;
    remoteBridgeState.liveFailureCount += 1;
    remoteBridgeState.lastFailureTs = startedAt;
    remoteBridgeState.lastReasonCode = "MISSING_URL";
    remoteBridgeState.lastReasonClass = "config-error";
    remoteBridgeState.lastError = "Remote gateway URL is not configured.";
    if (!hasUsableRemoteLiveSnapshot(startedAt)) {
      broadcastRemoteOfflineLiveState();
    }
    broadcastRemoteHealthUpdate(true);
    scheduleRemoteBridgeReconnect();
    return;
  }
  if (isUnsafeRemoteLoop(base)) {
    remoteBridgeState.connected = false;
    remoteBridgeState.liveFailureCount += 1;
    remoteBridgeState.lastFailureTs = startedAt;
    remoteBridgeState.lastReasonCode = "LOOPBACK_URL";
    remoteBridgeState.lastReasonClass = "config-error";
    remoteBridgeState.lastError = "Remote gateway URL cannot be localhost in remote mode.";
    if (!hasUsableRemoteLiveSnapshot(startedAt)) {
      broadcastRemoteOfflineLiveState();
    }
    broadcastRemoteHealthUpdate(true);
    return;
  }
  if (String(remoteBridgeState.currentBase || "").trim() !== base) {
    resetRemoteBridgeLiveSessionState(base);
    broadcastRemoteOfflineLiveState();
  }

  let wsUrl = "";
  try {
    wsUrl = buildRemoteBridgeWsUrl(base, "/ws");
  } catch (err) {
    handleRemoteBridgeStreamFailure(err, {
      bridgeSessionId,
      livePauseGeneration,
      base,
    });
    scheduleRemoteBridgeReconnect();
    return;
  }

  closeRemoteBridgeSocket();
  const ws = new WebSocket(wsUrl, {
    headers: buildRemoteProxyHeaders(),
    handshakeTimeout: REMOTE_FETCH_TIMEOUT_MS,
  });
  remoteBridgeSocket = ws;

  const failOnce = (err) => {
    if (ws._bridgeFailureHandled) return;
    ws._bridgeFailureHandled = true;
    if (remoteBridgeSocket === ws) remoteBridgeSocket = null;
    handleRemoteBridgeStreamFailure(err, {
      bridgeSessionId,
      livePauseGeneration,
      base,
    });
    scheduleRemoteBridgeReconnect();
  };

  ws.on("open", () => {
    if (!isCurrentRemoteBridgeContext({ bridgeSessionId, livePauseGeneration, base })) {
      closeRemoteBridgeSocket();
      return;
    }
    remoteBridgeState.lastLatencyMs = Math.max(0, Date.now() - startedAt);
    remoteBridgeState.lastSyncDirection = "stream-live-connect";
    broadcastRemoteHealthUpdate(true);
  });

  ws.on("message", (raw) => {
    if (!isCurrentRemoteBridgeContext({ bridgeSessionId, livePauseGeneration, base })) {
      return;
    }
    let msg = null;
    try {
      msg = JSON.parse(String(raw || ""));
    } catch (err) {
      failOnce(new Error("Gateway live stream returned invalid JSON."));
      return;
    }
    const type = String(msg?.type || "").trim().toLowerCase();
    if (type !== "init" && type !== "live") return;
    applyRemoteBridgeLiveFrame(msg, {
      bridgeSessionId,
      livePauseGeneration,
      base,
      startedAt,
    });
  });

  ws.on("error", (err) => {
    failOnce(err instanceof Error ? err : new Error(String(err || "Live stream error.")));
  });

  ws.on("close", (code) => {
    const suffix = code ? ` (${code})` : "";
    failOnce(new Error(`Gateway live stream closed${suffix}.`));
  });
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
  const bridgeSessionId = Number(remoteBridgeState.bridgeSessionId || 0);
  const livePauseGeneration = Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0));
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
  if (String(remoteBridgeState.currentBase || "").trim() !== base) {
    resetRemoteBridgeLiveSessionState(base);
    if (wasConnected || hadLiveData) {
      broadcastRemoteOfflineLiveState();
    }
  }
  // T1.5 fix (Phase 8, 2026-04-14): abort any prior in-flight live fetch
  // before reassigning the module-level controller.  Without this, rapid
  // reconnect cycles would leave orphaned fetches running to completion
  // (and consuming socket/memory) whose results we would discard anyway.
  if (remoteLiveFetchController) {
    try { remoteLiveFetchController.abort(); } catch (_) { /* ignore */ }
  }
  const liveController = new AbortController();
  remoteLiveFetchController = liveController;
  try {
    const r = await fetchWithRetry(
      `${base}/api/live`,
      {
        method: "GET",
        headers: buildRemoteProxyHeaders(),
        timeout: REMOTE_FETCH_TIMEOUT_MS,
        signal: liveController.signal,
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
    const isCurrentBridgeSession =
      bridgeSessionId === Math.max(0, Number(remoteBridgeState.bridgeSessionId || 0));
    const isCurrentPauseGeneration =
      livePauseGeneration === Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0));
    if (
      !isCurrentBridgeSession ||
      !isCurrentPauseGeneration ||
      isRemoteLiveBridgePausedForTransfer() ||
      !remoteBridgeState.running ||
      !isRemoteMode() ||
      getRemoteGatewayBaseUrl() !== base
    ) {
      return;
    }
    const successTs = Date.now();
    remoteBridgeState.liveData = buildRemoteLiveSnapshot(data, successTs);
    remoteBridgeState.lastLatencyMs = Math.max(0, successTs - startedAt);
    remoteBridgeState.lastLiveNodeCount = countRemoteLiveNodes(remoteBridgeState.liveData);
    // Viewer model: live data stays in-memory only — no local DB persistence.
    // persistRemoteLiveRows(remoteBridgeState.liveData, successTs);
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
      todayEnergy: getTodayEnergyRowsForWs(),
      remoteHealth: buildRemoteHealthSnapshot(successTs),
    });
    remoteBridgeState.lastHealthBroadcastKey = "";
    remoteBridgeState.lastSyncDirection = "pull-live";

    // Piggyback today's energy totals so /api/energy/today matches gateway exactly.
    // Rate-limited: only fetch when stale (>30 s) to avoid hammering the gateway
    // on every 1.2 s bridge tick.
    // Fire-and-forget: don't block the bridge tick, but only record success after
    // rows were actually received so transient failures retry immediately.
    const energyAgeMs = successTs - (remoteBridgeState.lastTodayEnergyFetchTs || 0);
    if (
      energyAgeMs >= REMOTE_ENERGY_POLL_INTERVAL_MS &&
      !remoteBridgeState.todayEnergyFetchInFlight
    ) {
      remoteBridgeState.todayEnergyFetchInFlight = true;
      const requestId =
        Math.max(0, Number(remoteBridgeState.todayEnergyFetchRequestId || 0)) + 1;
      remoteBridgeState.todayEnergyFetchRequestId = requestId;
      const todayController = new AbortController();
      remoteTodayEnergyFetchController = todayController;
      fetchWithRetry(
        `${base}/api/energy/today`,
        {
          method: "GET",
          headers: buildRemoteProxyHeaders(),
          timeout: REMOTE_FETCH_TIMEOUT_MS,
          signal: todayController.signal,
        },
        {
          attempts: 1, // single attempt — next bridge tick will retry if needed
          baseDelayMs: REMOTE_LIVE_FETCH_RETRY_BASE_MS,
        },
      )
        .then(async (et) => {
          if (!et.ok) return;
          const rows = await et.json();
          const isCurrentRequest =
            requestId === Math.max(0, Number(remoteBridgeState.todayEnergyFetchRequestId || 0));
          const isCurrentSession =
            bridgeSessionId === Math.max(0, Number(remoteBridgeState.bridgeSessionId || 0));
          if (
            !isCurrentRequest ||
            !isCurrentSession ||
            !remoteBridgeState.running ||
            !isRemoteMode() ||
            getRemoteGatewayBaseUrl() !== base ||
            !Array.isArray(rows)
          ) {
            return;
          }
          const normalizedRows = normalizeTodayEnergyRows(rows);
          remoteBridgeState.todayEnergyRows = normalizedRows;
          const ts = Date.now();
          remoteBridgeState.lastTodayEnergyFetchTs = ts;
          updateRemoteTodayEnergyShadow(normalizedRows, ts);
          // Viewer model: energy stays in-memory only — no local DB mirroring.
          // mirrorRemoteTodayEnergyRowsToLocal(normalizedRows, ts);
          todayEnergyCache.ts = 0; // force next request to re-read with new data
        })
        .catch((err) => {
          if (isAbortError(err)) return;
          // Non-fatal; stale todayEnergyRows will be used until next tick.
          console.warn("[remote-energy] piggyback fetch failed:", err?.message || err);
        })
        .finally(() => {
          if (remoteTodayEnergyFetchController === todayController) {
            remoteTodayEnergyFetchController = null;
          }
          if (
            requestId === Math.max(0, Number(remoteBridgeState.todayEnergyFetchRequestId || 0))
          ) {
            remoteBridgeState.todayEnergyFetchInFlight = false;
          }
        });
    }
    // Viewer model: no startup auto-sync, no incremental replication.
    // Remote mode is a gateway-backed viewer — manual Pull is the only DB refresh path.
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    const isCurrentBridgeSession =
      bridgeSessionId === Math.max(0, Number(remoteBridgeState.bridgeSessionId || 0));
    const isCurrentPauseGeneration =
      livePauseGeneration === Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0));
    if (
      !isCurrentBridgeSession ||
      !isCurrentPauseGeneration ||
      isRemoteLiveBridgePausedForTransfer() ||
      !isRemoteMode() ||
      getRemoteGatewayBaseUrl() !== base
    ) {
      return;
    }
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
  } finally {
    if (remoteLiveFetchController === liveController) {
      remoteLiveFetchController = null;
    }
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
  } else {
    if (remoteBridgeTimer) {
      clearTimeout(remoteBridgeTimer);
      remoteBridgeTimer = null;
    }
    connectRemoteBridgeSocket();
  }
  const reconnectStartedAt = Date.now();
  remoteBridgeState.lastSyncDirection = String(reason || "manual-reconnect");
  remoteBridgeState.lastAttemptTs = reconnectStartedAt;
  remoteBridgeState.liveFailureCount = 0;
  const deadline = reconnectStartedAt + Math.max(3000, REMOTE_FETCH_TIMEOUT_MS + 2000);
  while (Date.now() < deadline) {
    if (Number(remoteBridgeState.lastSuccessTs || 0) >= reconnectStartedAt) break;
    if (Number(remoteBridgeState.lastFailureTs || 0) >= reconnectStartedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
}

function stopRemoteBridge() {
  if (remoteBridgeTimer) {
    clearTimeout(remoteBridgeTimer);
    remoteBridgeTimer = null;
  }
  if (remoteLiveFetchController) {
    try { remoteLiveFetchController.abort(); } catch (_) {}
    remoteLiveFetchController = null;
  }
  if (remoteTodayEnergyFetchController) {
    try { remoteTodayEnergyFetchController.abort(); } catch (_) {}
    remoteTodayEnergyFetchController = null;
  }
  closeRemoteBridgeSocket();
  resetRemoteBridgeAlarmState();
  clearRemoteBridgePersistState();
  remoteBridgeState.running = false;
  remoteBridgeState.connected = false;
  remoteBridgeState.startedAtTs = 0;
  remoteBridgeState.liveFailureCount = 0;
  remoteBridgeState.lastFailureTs = 0;
  remoteBridgeState.lastReasonCode = "";
  remoteBridgeState.lastReasonClass = "";
  remoteBridgeState.lastLatencyMs = 0;
  remoteBridgeState.lastLiveNodeCount = 0;
  remoteBridgeState.currentBase = "";
  remoteBridgeState.lastTodayEnergyFetchTs = 0;
  remoteBridgeState.lastTodayEnergyShadowPersistTs = 0;
  remoteBridgeState.todayEnergyFetchInFlight = false;
  remoteTodayCarryState.day = "";
  remoteTodayCarryState.byInv = Object.create(null);
  console.log("[energy] remote carry state cleared on bridge stop — energy hand-off reset");
  remoteBridgeState.todayEnergyFetchRequestId =
    Math.max(0, Number(remoteBridgeState.todayEnergyFetchRequestId || 0)) + 1;
  remoteBridgeState.lastHealthBroadcastKey = "";
  remoteBridgeState.replicationRunning = false;
  remoteBridgeState.livePauseActive = false;
  remoteBridgeState.livePauseReason = "";
  remoteBridgeState.livePauseSince = 0;
  remoteBridgeState.livePauseResumeWanted = false;
  remoteBridgeState.livePauseGeneration =
    Math.max(0, Number(remoteBridgeState.livePauseGeneration || 0)) + 1;
  if (_shutdownCalled || !isRemoteMode()) remoteBridgeState.lastSyncDirection = "idle";
}

function startRemoteBridge() {
  if (remoteBridgeState.running || isRemoteLiveBridgePausedForTransfer()) return;
  if (remoteBridgeTimer) {
    clearTimeout(remoteBridgeTimer);
    remoteBridgeTimer = null;
  }
  closeRemoteBridgeSocket();
  clearRemoteBridgePersistState();
  remoteTodayCarryState.day = "";
  remoteTodayCarryState.byInv = Object.create(null);
  console.log("[energy] remote carry state cleared on bridge start — fresh session");
  resetRemoteBridgeLiveSessionState(getRemoteGatewayBaseUrl());
  remoteBridgeState.running = true;
  remoteBridgeState.startedAtTs = Date.now();
  remoteBridgeState.bridgeSessionId =
    Math.max(0, Number(remoteBridgeState.bridgeSessionId || 0)) + 1;
  remoteBridgeState.autoSyncAttempted = false;
  remoteBridgeState.liveFailureCount = 0;
  remoteBridgeState.lastFailureTs = 0;
  remoteBridgeState.lastReasonCode = "";
  remoteBridgeState.lastReasonClass = "";
  remoteBridgeState.lastLatencyMs = 0;
  remoteBridgeState.lastTodayEnergyShadowPersistTs = 0;
  remoteBridgeState.todayEnergyFetchInFlight = false;
  remoteBridgeState.lastHealthBroadcastKey = "";
  if (isRemotePullOnlyMode()) {
    remoteBridgeState.replicationCursors = normalizeReplicationCursors({});
  } else {
    remoteBridgeState.replicationCursors = readReplicationCursorsSetting();
  }
  connectRemoteBridgeSocket();
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
    // â"€â"€ Handoff lifecycle: capture per-inverter baselines â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (wasRemoteActive) {
      const handoffNow = Date.now();
      const handoffDay = localDateStr(handoffNow);
      const capturedRows = normalizeTodayEnergyRows(
        getTodayEnergySupplementRows(handoffDay),
      );
      if (capturedRows.length) {
        updateRemoteTodayEnergyShadow(capturedRows, handoffNow, {
          sourceKey: getRemoteTodayEnergySourceKey(),
        });
      }
      gatewayHandoffMeta.active = true;
      gatewayHandoffMeta.startedAt = handoffNow;
      gatewayHandoffMeta.day = handoffDay;
      gatewayHandoffMeta.baselines = Object.create(null);
      const baselineRows = capturedRows.length
        ? capturedRows
        : getRemoteTodayEnergyShadowRows(handoffDay);
      for (const row of baselineRows) {
        const inv = Number(row?.inverter || 0);
        if (inv > 0) gatewayHandoffMeta.baselines[inv] = Number(row?.total_kwh || 0);
      }
      const baselineList = baselineRows
        .slice(0, 8)
        .map((r) => `${r.inverter}:${Number(r.total_kwh || 0).toFixed(2)}kWh`)
        .join(", ");
      console.log(
        `[handoff] Remoteâ†'Gateway started day=${handoffDay}` +
        ` inverters=${baselineRows.length}` +
        ` baselines=[${baselineList}${baselineRows.length > 8 ? " ..." : ""}]`,
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

function getRemoteTodayEnergySourceKey(base = null) {
  const normalizedBase =
    base === null || base === undefined
      ? getRemoteGatewayBaseUrl()
      : normalizeGatewayUrl(base);
  return String(normalizedBase || "").trim();
}

function resetRemoteTodayEnergyShadow(persist = false) {
  remoteTodayEnergyShadow.day = "";
  remoteTodayEnergyShadow.rows = [];
  remoteTodayEnergyShadow.syncedAt = 0;
  remoteTodayEnergyShadow.sourceKey = "";
  if (persist) persistRemoteTodayEnergyShadow();
}

function updateRemoteTodayEnergyShadow(rowsRaw, syncedAt = Date.now(), options = {}) {
  const day = localDateStr(syncedAt);
  const incoming = normalizeTodayEnergyRows(rowsRaw);
  if (!incoming.length) {
    return normalizeTodayEnergyRows(remoteTodayEnergyShadow.rows);
  }
  const nextSourceKey = getRemoteTodayEnergySourceKey(
    options?.sourceKey ?? null,
  );
  const nextSyncedAt = Math.max(0, Number(syncedAt || Date.now()));
  const changed =
    remoteTodayEnergyShadow.day !== day ||
    remoteTodayEnergyShadow.sourceKey !== nextSourceKey ||
    Number(remoteTodayEnergyShadow.syncedAt || 0) !== nextSyncedAt ||
    !todayEnergyRowsEqual(remoteTodayEnergyShadow.rows, incoming);
  remoteTodayEnergyShadow.day = day;
  remoteTodayEnergyShadow.rows = incoming;
  remoteTodayEnergyShadow.syncedAt = nextSyncedAt;
  remoteTodayEnergyShadow.sourceKey = nextSourceKey;
  if (changed) persistRemoteTodayEnergyShadow();
  return remoteTodayEnergyShadow.rows;
}

function getRemoteTodayEnergyShadowRows(day = localDateStr(), options = {}) {
  const requireSourceMatch = options?.requireSourceMatch === true;
  const requiredSourceKey = requireSourceMatch
    ? getRemoteTodayEnergySourceKey(options?.sourceKey ?? null)
    : "";
  if (gatewayHandoffMeta.day && gatewayHandoffMeta.day !== day) {
    resetGatewayHandoffMeta(true);
  }
  if (remoteTodayEnergyShadow.day !== day) {
    if (remoteTodayEnergyShadow.day) {
      resetRemoteTodayEnergyShadow(true);
    }
    return [];
  }
  if (requireSourceMatch) {
    const shadowSourceKey = String(remoteTodayEnergyShadow.sourceKey || "").trim();
    if (!requiredSourceKey || !shadowSourceKey || shadowSourceKey !== requiredSourceKey) {
      if (shadowSourceKey && requiredSourceKey && shadowSourceKey !== requiredSourceKey) {
        console.warn(
          `[shadow] source mismatch discarded: stored=${shadowSourceKey} current=${requiredSourceKey}`,
        );
      }
      resetRemoteTodayEnergyShadow(true);
      return [];
    }
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
    resetRemoteTodayEnergyShadow(true);
    return [];
  }
  return normalizeTodayEnergyRows(remoteTodayEnergyShadow.rows);
}

function resetRemoteBridgeLiveSessionState(nextBase = "") {
  remoteBridgeState.connected = false;
  remoteBridgeState.liveData = {};
  remoteBridgeState.totals = {};
  remoteBridgeState.todayEnergyRows = [];
  remoteBridgeState.lastSuccessTs = 0;
  remoteBridgeState.lastLiveNodeCount = 0;
  remoteBridgeState.lastTodayEnergyFetchTs = 0;
  remoteBridgeState.lastTodayEnergyShadowPersistTs = 0;
  remoteBridgeState.todayEnergyFetchInFlight = false;
  remoteBridgeState.currentBase = String(nextBase || "").trim();
  todayEnergyCache.ts = 0;
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
    // Keep remote today-energy metrics near real time between the 30 s
    // gateway /api/energy/today syncs. Fresh gateway rows stay authoritative;
    // the local shadow is only a same-source fallback when the current remote
    // session has not fetched today-energy yet.
    const liveRows = computeTodayEnergyRowsFromLiveData(remoteBridgeState.liveData);
    const gatewayRows = normalizeTodayEnergyRows(remoteBridgeState.todayEnergyRows);
    const shadowRows = gatewayRows.length
      ? gatewayRows
      : getRemoteTodayEnergyShadowRows(day, { requireSourceMatch: true });
    if (!shadowRows.length) {
      remoteTodayCarryState.day = day;
      remoteTodayCarryState.byInv = Object.create(null);
      return liveRows;
    }
    if (remoteTodayCarryState.day !== day) {
      remoteTodayCarryState.day = day;
      remoteTodayCarryState.byInv = Object.create(null);
    }
    const { rows: out } = applyGatewayCarryRows({
      pollerRows: liveRows,
      shadowRows,
      carryByInv: remoteTodayCarryState.byInv,
    });
    return out;
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

function getTodayEnergyRowsForWs(day = localDateStr()) {
  // Remote-mode header updates should follow the live bridge tick, not the
  // DB-oriented /api/energy/today cache path. Gateway mode keeps the existing
  // DB-backed behavior for init payloads.
  if (isRemoteMode()) {
    return getTodayEnergySupplementRows(day);
  }
  return getTodayPacTotalsFromDbCached();
}

function getTodayEnergyRowsForLivePayload(day = localDateStr()) {
  const liveRows = getTodayEnergySupplementRows(day);
  if (isRemoteMode()) return liveRows;
  const cachedRows =
    todayEnergyCache.day === day && Array.isArray(todayEnergyCache.rows)
      ? todayEnergyCache.rows
      : [];
  if (!cachedRows.length) return liveRows;
  return mergeTodayEnergyRowsMax(cachedRows, liveRows);
}

setBroadcastPayloadEnricher((payload) => {
  if (!payload || typeof payload !== "object") return payload;
  if (String(payload.type || "").trim().toLowerCase() !== "live") return payload;
  const todayEnergy = Object.prototype.hasOwnProperty.call(payload, "todayEnergy")
    ? normalizeTodayEnergyRows(payload.todayEnergy)
    : getTodayEnergyRowsForLivePayload();
  const enriched = { ...payload, todayEnergy };
  if (!Object.prototype.hasOwnProperty.call(enriched, "todaySummary")) {
    enriched.todaySummary = buildCurrentDayEnergySnapshot({
      asOfTs: Date.now(),
      todayEnergyRows: todayEnergy,
    }).todaySummary;
  }
  if (
    plantCapController &&
    !Object.prototype.hasOwnProperty.call(enriched, "plantCap")
  ) {
    enriched.plantCap = plantCapController.getStatus({
      refresh: true,
      includePreview: false,
    });
  }
  return enriched;
});

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
        sourceKey: String(remoteTodayEnergyShadow.sourceKey || ""),
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
    const rawSourceKey = String(parsed?.sourceKey || "").trim();
    const sourceKey = rawSourceKey
      ? getRemoteTodayEnergySourceKey(rawSourceKey)
      : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !rows.length) return;
    if (day !== localDateStr()) {
      // Keep shadow strictly scoped to the current day.
      setSetting(REMOTE_TODAY_SHADOW_SETTING_KEY, "");
      return;
    }
    remoteTodayEnergyShadow.day = day;
    remoteTodayEnergyShadow.rows = rows;
    remoteTodayEnergyShadow.syncedAt = Number.isFinite(syncedAt) ? syncedAt : 0;
    remoteTodayEnergyShadow.sourceKey = sourceKey;
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

function countDayAheadSolarWindowRows(day) {
  const { startTs, endTs } = getForecastSolarWindowBounds(day);
  return getDayAheadRowsForDate(day).reduce((count, row) => {
    const ts = Number(row?.ts || 0);
    return count + (ts >= startTs && ts < endTs ? 1 : 0);
  }, 0);
}

function hasCompleteDayAheadRowsForDate(day) {
  return countDayAheadSolarWindowRows(day) >= FORECAST_SOLAR_SLOT_COUNT;
}

function getSolcastSnapshotStatsForDay(day) {
  let rows = [];
  try {
    rows = stmts.getSolcastSnapshotDay.all(String(day || ""));
  } catch (err) {
    console.warn(`[solcast-snapshot] read failed for ${day}:`, err.message);
    rows = [];
  }
  if (!Array.isArray(rows) || !rows.length) {
    return {
      hasSnapshot: false,
      solarRows: 0,
      filledRows: 0,
      coverageRatio: 0,
      pulledTs: null,
    };
  }

  const solarStartSlot = Math.floor((SOLCAST_SOLAR_START_H * 60) / SOLCAST_SLOT_MIN);
  const solarEndSlot = Math.floor((SOLCAST_SOLAR_END_H * 60) / SOLCAST_SLOT_MIN);
  const solarRows = rows.filter((r) => {
    const slot = Number(r?.slot ?? -1);
    return Number.isFinite(slot) && slot >= solarStartSlot && slot < solarEndSlot;
  });
  const filledRows = solarRows.reduce((count, r) => {
    const value = Number(r?.forecast_kwh);
    return count + (Number.isFinite(value) ? 1 : 0);
  }, 0);
  const pulledTs = solarRows.reduce((mx, r) => {
    const ts = Number(r?.pulled_ts || 0);
    return Number.isFinite(ts) && ts > mx ? ts : mx;
  }, 0);
  return {
    hasSnapshot: solarRows.length > 0,
    solarRows: Number(solarRows.length || 0),
    filledRows: Number(filledRows || 0),
    coverageRatio: solarRows.length > 0 ? Math.max(0, Math.min(1, filledRows / FORECAST_SOLAR_SLOT_COUNT)) : 0,
    pulledTs: pulledTs > 0 ? pulledTs : null,
  };
}

function classifySolcastFreshnessForDay(day, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const expectSolcast = Boolean(opts.expectSolcast);
  if (!expectSolcast) return "not_expected";

  const stats =
    opts.snapshotStats && typeof opts.snapshotStats === "object"
      ? opts.snapshotStats
      : getSolcastSnapshotStatsForDay(day);
  const coverage = Number(stats?.coverageRatio || 0);
  const pulledTs =
    Number(opts.pulledTsOverride || 0) > 0
      ? Number(opts.pulledTsOverride)
      : Number(stats?.pulledTs || 0) > 0
        ? Number(stats.pulledTs)
        : 0;

  if (!stats?.hasSnapshot || coverage <= 0) return "missing";
  if (coverage < 0.8) return "stale_reject";
  if (!pulledTs) return "stale_reject";

  const ageSec = Math.floor((Date.now() - pulledTs) / 1000);
  if (coverage >= 0.95 && ageSec <= 7200) return "fresh";
  if (coverage >= 0.8 && ageSec <= 43200) return "stale_usable";
  return "stale_reject";
}

function sumDayAheadTotalKwh(day) {
  const { startTs, endTs } = getForecastSolarWindowBounds(day);
  const rows = getDayAheadRowsForDate(day);
  return rows.reduce((sum, row) => {
    const ts = Number(row?.ts || 0);
    if (ts < startTs || ts >= endTs) return sum;
    return sum + Math.max(0, Number(row?.kwh_inc || 0));
  }, 0);
}

function assessTomorrowForecastQuality(date) {
  const existingRows = countDayAheadSolarWindowRows(date);
  if (existingRows <= 0) return "missing";
  if (existingRows < FORECAST_SOLAR_SLOT_COUNT) return "incomplete";

  try {
    const audit =
      stmts.getLatestAuthoritativeForecastRunAuditForDate.get(date) ||
      stmts.getLatestForecastRunAuditForDate.get(date);
    if (!audit) return "missing_audit";

    const expected = readForecastProvider();
    const expectSolcastInput =
      expected === "solcast" || (expected === "ml_local" && hasUsableSolcastConfig(getSolcastConfig()));
    const variant = String(audit?.forecast_variant || "").trim();
    const freshness = String(audit?.solcast_freshness_class || "").trim();

    if (String(audit?.run_status || "").trim() && String(audit.run_status).trim() !== "success") {
      return "weak_quality";
    }

    if (expected === "solcast") {
      if (String(audit?.provider_used || "").trim() !== "solcast") return "wrong_provider";
      if (variant !== "solcast_direct") return "wrong_provider";
      if (freshness === "stale_reject" || freshness === "missing") return "stale_input";
      // Detect if Solcast snapshots refreshed since this forecast was generated
      const auditPulledTsSolcast = Number(audit?.solcast_snapshot_pulled_ts || 0);
      if (auditPulledTsSolcast > 0) {
        const currentStatsSolcast = getSolcastSnapshotStatsForDay(date);
        const currentPulledTsSolcast = Number(currentStatsSolcast?.pulledTs || 0);
        if (currentPulledTsSolcast > auditPulledTsSolcast) return "stale_input";
      }
      return "healthy";
    }

    if (String(audit?.provider_used || "").trim() !== "ml_local") {
      return "wrong_provider";
    }
    if (!variant) {
      return "weak_quality";
    }
    if (expectSolcastInput) {
      if (variant === "ml_without_solcast") return "wrong_provider";
      if (freshness === "missing" || freshness === "stale_reject") return "stale_input";
      // Check if Solcast snapshots have been refreshed since the forecast was generated.
      // This catches the scenario where weather data updates between cron runs
      // (e.g., forecast generated at 04:30, Solcast refreshes by 08:00, 09:30 cron
      // should detect the forecast was built with older data and regenerate before
      // the 10AM control room submission cutoff).
      const auditPulledTs = Number(audit?.solcast_snapshot_pulled_ts || 0);
      if (auditPulledTs > 0) {
        const currentStats = getSolcastSnapshotStatsForDay(date);
        const currentPulledTs = Number(currentStats?.pulledTs || 0);
        if (currentPulledTs > auditPulledTs) {
          return "stale_input";
        }
      }
      if (variant === "ml_solcast_hybrid_stale") {
        const freshClass = classifySolcastFreshnessForDay(date, {
          expectSolcast: true,
        });
        if (freshClass === "fresh") return "stale_input";
      }
    }
    return "healthy";
  } catch (err) {
    console.warn(`[quality] Failed to assess forecast quality for ${date}:`, err.message);
    return "weak_quality";
  }
}

function getIncompleteDayAheadContextDays() {
  const ctx = readForecastContext();
  const root = ctx && typeof ctx === "object" ? ctx.PacEnergy_DayAhead : null;
  if (!root || typeof root !== "object") return [];
  return Object.keys(root).filter((day) => {
    const series = root[day];
    return Array.isArray(series) && !hasCompleteDayAheadRowsForDate(day);
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
  "expEnergyDate",
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
  const energyDate =
    String(input.expEnergyDate || "").trim() ||
    String(input.expEnergyEnd || "").trim() ||
    String(input.expEnergyStart || "").trim();
  for (const key of EXPORT_UI_DATE_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = String(raw).trim();
    if (ISO_DATE_RE.test(v)) out[key] = v;
  }
  if (ISO_DATE_RE.test(energyDate)) out.expEnergyDate = energyDate;
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

// Camera streaming configuration — promoted from client localStorage to the
// server DB so it survives reinstalls, Electron userData rewrites, and any
// Local Storage LevelDB corruption. `go2rtcAutoStart` remains a top-level
// key for backwards compatibility.
const DEFAULT_CAMERA_CFG = Object.freeze({
  mode: "hls",
  go2rtcIp: "",
  go2rtcPort: "",
  streamKey: "",
  ip: "",
  rtspPort: "",
  streamPath: "",
  user: "",
  pass: "",
});

function sanitizeCameraConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const str = (v, max = 200) =>
    String(v == null ? "" : v).trim().slice(0, max);
  const modeRaw = str(src.mode, 16).toLowerCase();
  const mode = ["hls", "webrtc", "ffmpeg"].includes(modeRaw) ? modeRaw : "hls";
  return {
    mode,
    go2rtcIp:   str(src.go2rtcIp,   120),
    go2rtcPort: str(src.go2rtcPort,  10),
    streamKey:  str(src.streamKey,   80),
    ip:         str(src.ip,         120),
    rtspPort:   str(src.rtspPort,    10),
    streamPath: str(src.streamPath,  80),
    user:       str(src.user,        80),
    // Password length is generous but capped; empty string is a valid choice
    // (unauthenticated RTSP). Stored in plain text in settings — same risk
    // surface as the existing plain-text Solcast/remote tokens.
    pass:       str(src.pass,       256),
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
    expEnergyDate: end,
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
    solcastToolkitDays: "2",
    solcastToolkitPeriod: SOLCAST_TOOLKIT_PERIOD,
    solcastTimezone: "Asia/Manila",
    plantLatitude: String(WEATHER_LAT),
    plantLongitude: String(WEATHER_LON),
    forecastExportLimitMw: "24",
    plantCapUpperMw: "",
    plantCapLowerMw: "",
    plantCapSequenceMode: "ascending",
    plantCapSequenceCustomJson: "[]",
    plantCapCooldownSec: String(30),
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
    solcastToolkitDays: "2",
    solcastToolkitPeriod: SOLCAST_TOOLKIT_PERIOD,
    solcastTimezone: "Asia/Manila",
    plantLatitude: WEATHER_LAT,
    plantLongitude: WEATHER_LON,
    forecastExportLimitMw: 24,
    plantCapUpperMw: null,
    plantCapLowerMw: null,
    plantCapSequenceMode: "ascending",
    plantCapSequenceCustom: [],
    plantCapCooldownSec: 30,
    exportUiState: buildDefaultExportUiState(),
    inverterPollConfig: { ...DEFAULT_POLL_CFG },
    cameraConfig: { ...DEFAULT_CAMERA_CFG },
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
    solcastToolkitDays: getSetting(
      "solcastToolkitDays",
      defaults.solcastToolkitDays,
    ),
    solcastToolkitPeriod: getSetting(
      "solcastToolkitPeriod",
      defaults.solcastToolkitPeriod,
    ),
    solcastTimezone: getSetting(
      "solcastTimezone",
      defaults.solcastTimezone,
    ),
    plantLatitude: Number(getSetting("plantLatitude", WEATHER_LAT)),
    plantLongitude: Number(getSetting("plantLongitude", WEATHER_LON)),
    forecastExportLimitMw: (() => {
      const raw = String(getSetting("forecastExportLimitMw", defaults.forecastExportLimitMw) || "").trim();
      if (!raw) return defaults.forecastExportLimitMw;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : defaults.forecastExportLimitMw;
    })(),
    plantCapUpperMw: (() => {
      const raw = String(getSetting("plantCapUpperMw", "") || "").trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    })(),
    plantCapLowerMw: (() => {
      const raw = String(getSetting("plantCapLowerMw", "") || "").trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    })(),
    plantCapSequenceMode: normalizePlantCapSequenceMode(
      getSetting("plantCapSequenceMode", defaults.plantCapSequenceMode),
    ),
    plantCapSequenceCustom: normalizePlantCapSequenceCustom(
      readJsonSetting("plantCapSequenceCustomJson", defaults.plantCapSequenceCustom),
      Number(getSetting("inverterCount", defaults.inverterCount)),
    ),
    plantCapCooldownSec: clampInt(
      getSetting("plantCapCooldownSec", defaults.plantCapCooldownSec),
      5,
      600,
      defaults.plantCapCooldownSec,
    ),
    exportUiState: sanitizeExportUiState(
      readJsonSetting("exportUiState", defaults.exportUiState),
    ),
    inverterPollConfig: sanitizePollConfig(
      readJsonSetting("inverterPollConfig", DEFAULT_POLL_CFG),
    ),
    cameraConfig: sanitizeCameraConfig(
      readJsonSetting("cameraConfig", DEFAULT_CAMERA_CFG),
    ),
    go2rtcAutoStart: getSetting("go2rtcAutoStart", "0"),
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
    toolkitDays: Math.max(1, Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS, Math.trunc(Number(getSetting("solcastToolkitDays", "2")) || 2))),
    toolkitPeriod: String(getSetting("solcastToolkitPeriod", SOLCAST_TOOLKIT_PERIOD) || SOLCAST_TOOLKIT_PERIOD).trim(),
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
    toolkitDays: Math.max(1, Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS, Math.trunc(
      Number(src.solcastToolkitDays ?? src.toolkitDays ?? base.toolkitDays ?? 2) || 2,
    ))),
    toolkitPeriod: String(
      src.solcastToolkitPeriod ?? src.toolkitPeriod ?? base.toolkitPeriod ?? SOLCAST_TOOLKIT_PERIOD,
    ).trim() || SOLCAST_TOOLKIT_PERIOD,
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

function classifySolcastFreshness(pulledTs, cfg = null) {
  if (!pulledTs) return "missing";
  const c = cfg || getSolcastConfig();
  if (!hasUsableSolcastConfig(c)) return "not_expected";
  const ageSec = Math.floor((Date.now() - pulledTs) / 1000);
  // Fresh = pulled within the last 61 minutes
  if (ageSec <= 3660) return "fresh";
  // Stale usable = pulled within the last 24 hours
  if (ageSec <= 86400) return "stale_usable";
  return "stale_reject";
}

function computePlantMaxKwFromConfig() {
  try {
    const enabledNodes = getConfiguredNodeSet(loadIpConfigFromDb()).size;
    return Math.max(0, Number(enabledNodes || 0) * NODE_KW_MAX);
  } catch {
    // Safe fallback: ~108 nodes × 244.25 kW = 26.4 MW
    return 108 * NODE_KW_MAX;
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
    throw new Error("Plant Resource ID is required for Toolkit mode.");
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
      "Plant Resource ID must contain only alphanumeric characters, dots, hyphens, or underscores.",
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
  const cfgHours = cfg.toolkitDays ? cfg.toolkitDays * 24 : undefined;
  const site = parseSolcastToolkitSiteRef(cfg.toolkitSiteRef, cfg.baseUrl, {
    recentHours: options?.toolkitHours ?? cfgHours,
    period: options?.toolkitPeriod ?? cfg.toolkitPeriod,
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

function normalizeSolcastPreviewResolution(value) {
  const raw = String(value || SOLCAST_TOOLKIT_PERIOD)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return SOLCAST_PREVIEW_RESOLUTIONS.has(raw) ? raw : SOLCAST_TOOLKIT_PERIOD;
}

function getSolcastPreviewBucketMinutes(resolution) {
  const normalized = normalizeSolcastPreviewResolution(resolution);
  const minutes = Number.parseInt(
    normalized.replace(/^PT/i, "").replace(/M$/i, ""),
    10,
  );
  return Number.isFinite(minutes) && minutes > 0 ? minutes : SOLCAST_SLOT_MIN;
}

function parseSolcastPreviewMinuteOfDay(timeText) {
  const raw = String(timeText || "").trim();
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return -1;
  const hh = Number(match[1] || 0);
  const mm = Number(match[2] || 0);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return -1;
  return hh * 60 + mm;
}

function formatSolcastPreviewBucketTime(minuteOfDay) {
  const minute = Math.max(0, Math.trunc(Number(minuteOfDay || 0)));
  const hh = Math.floor(minute / 60);
  const mm = minute % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function sumSolcastPreviewNumbers(values) {
  let total = 0;
  let seen = false;
  for (const raw of values || []) {
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    total += num;
    seen = true;
  }
  return seen ? Number(total.toFixed(6)) : null;
}

function averageSolcastPreviewNumbers(values) {
  let total = 0;
  let count = 0;
  for (const raw of values || []) {
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    total += num;
    count += 1;
  }
  return count > 0 ? Number((total / count).toFixed(6)) : null;
}

function aggregateSolcastPreviewRows(rows, resolution) {
  const displayPeriod = normalizeSolcastPreviewResolution(resolution);
  const bucketMinutes = getSolcastPreviewBucketMinutes(displayPeriod);
  const safeRows = Array.isArray(rows) ? rows : [];
  if (bucketMinutes <= SOLCAST_SLOT_MIN) {
    return {
      rows: safeRows.map((row) => ({
        ...row,
        period: displayPeriod,
      })),
      displayPeriod,
      bucketMinutes,
    };
  }

  const grouped = new Map();
  for (const row of safeRows) {
    const date = String(row?.date || "").trim();
    const minuteOfDay = parseSolcastPreviewMinuteOfDay(row?.time);
    if (!date || minuteOfDay < 0) continue;
    const bucketStart = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
    const key = `${date}|${bucketStart}`;
    let entry = grouped.get(key);
    if (!entry) {
      const bucketTime = formatSolcastPreviewBucketTime(bucketStart);
      entry = {
        date,
        time: bucketTime,
        period: displayPeriod,
        chartLabel: `${date.slice(5)} ${bucketTime}`,
        forecastMwh: [],
        forecastLoMwh: [],
        forecastHiMwh: [],
        actualMwh: [],
        forecastMw: [],
        forecastLoMw: [],
        forecastHiMw: [],
        actualMw: [],
      };
      grouped.set(key, entry);
    }
    entry.forecastMwh.push(row?.forecastMwh);
    entry.forecastLoMwh.push(row?.forecastLoMwh);
    entry.forecastHiMwh.push(row?.forecastHiMwh);
    entry.actualMwh.push(row?.actualMwh);
    entry.forecastMw.push(row?.forecastMw);
    entry.forecastLoMw.push(row?.forecastLoMw);
    entry.forecastHiMw.push(row?.forecastHiMw);
    entry.actualMw.push(row?.actualMw);
  }

  return {
    rows: Array.from(grouped.values())
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.time.localeCompare(b.time);
      })
      .map((entry) => ({
        date: entry.date,
        time: entry.time,
        period: displayPeriod,
        chartLabel: entry.chartLabel,
        forecastMwh: sumSolcastPreviewNumbers(entry.forecastMwh),
        forecastLoMwh: sumSolcastPreviewNumbers(entry.forecastLoMwh),
        forecastHiMwh: sumSolcastPreviewNumbers(entry.forecastHiMwh),
        actualMwh: sumSolcastPreviewNumbers(entry.actualMwh),
        forecastMw: averageSolcastPreviewNumbers(entry.forecastMw),
        forecastLoMw: averageSolcastPreviewNumbers(entry.forecastLoMw),
        forecastHiMw: averageSolcastPreviewNumbers(entry.forecastHiMw),
        actualMw: averageSolcastPreviewNumbers(entry.actualMw),
      })),
    displayPeriod,
    bucketMinutes,
  };
}

function computeSolcastPreviewHours(dayCount) {
  const count = normalizeSolcastPreviewDayCount(dayCount);
  return Math.max(
    SOLCAST_TOOLKIT_RECENT_HOURS,
    Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS, (count + 1) * 24),
  );
}

function parseIsoDateParts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function diffIsoDays(aDateStr, bDateStr) {
  const a = parseIsoDateParts(aDateStr);
  const b = parseIsoDateParts(bDateStr);
  if (!a || !b) return 0;
  const aUtc = Date.UTC(a.year, a.month - 1, a.day);
  const bUtc = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((aUtc - bUtc) / 86400000);
}

function computeSolcastPreviewHoursForRequest(
  startDay,
  dayCount,
  cfg,
  availableSpanDayCount = dayCount,
) {
  const count = normalizeSolcastPreviewDayCount(dayCount);
  const availableSpan = normalizeSolcastPreviewDayCount(availableSpanDayCount);
  const todayTz = localDateStrInTz(Date.now(), cfg?.timeZone || WEATHER_TZ);
  const requestedStartDay = String(startDay || "").trim();
  const startOffsetDays = Math.max(0, diffIsoDays(requestedStartDay, todayTz));
  const neededHours = (startOffsetDays + Math.max(count, availableSpan) + 1) * 24;
  return Math.max(
    SOLCAST_TOOLKIT_RECENT_HOURS,
    Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS, neededHours),
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

function buildSolcastPreviewSeries(
  startDay,
  dayCount,
  forecastRecords,
  actualRecords,
  cfg,
  resolution,
) {
  const availableDays = listSolcastPreviewDays(forecastRecords, actualRecords, cfg);
  const todayTz = localDateStrInTz(Date.now(), cfg.timeZone);
  const requestedStartDay = String(startDay || "").trim();
  const normalizedCount = normalizeSolcastPreviewDayCount(dayCount);
  const displayPeriod = normalizeSolcastPreviewResolution(resolution);
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
  const rawRows = daySeries.flatMap((entry) => entry.rows || []);
  if (!rawRows.length) {
    throw new Error(
      `No Solcast samples matched ${selectedDays[0]} within ${SOLCAST_SOLAR_START_H}:00-${SOLCAST_SOLAR_END_H}:00 (${cfg.timeZone}).`,
    );
  }
  const aggregated = aggregateSolcastPreviewRows(rawRows, displayPeriod);
  const rows = aggregated.rows;

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
    sourcePeriod: SOLCAST_TOOLKIT_PERIOD,
    displayPeriod: aggregated.displayPeriod,
    bucketMinutes: aggregated.bucketMinutes,
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
    rawRows,
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
        if (slot < 0 || slot >= 288) continue; // defensive: guard against constant drift
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
  // v2.8 audit (R3): track how many records actually carried tri-band data
  // (P10/P90 distinct from P50). When Solcast omits these, the previous code
  // silently fell back to P50 — disabling the tri-band hard clamp without
  // any operator signal. We still apply the fallback (so downstream consumers
  // keep working) but now we count the records that came through with real
  // bands so we can warn at the end if coverage is suspiciously low.
  let recordsWithRealLo = 0;
  let recordsWithRealHi = 0;
  let recordsWithAnyForecast = 0;
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
    const loMwRaw = convertSolcastPowerToMw(
      rec?.pv_estimate10 ?? rec?.pv_estimate_10 ?? rec?.pv_estimate_low,
      accessMode,
    );
    const hiMwRaw = convertSolcastPowerToMw(
      rec?.pv_estimate90 ?? rec?.pv_estimate_90 ?? rec?.pv_estimate_high,
      accessMode,
    );
    if (mw != null) recordsWithAnyForecast += 1;
    if (loMwRaw != null) recordsWithRealLo += 1;
    if (hiMwRaw != null) recordsWithRealHi += 1;
    // Fallback to P50 when P10/P90 absent (preserves current downstream behavior).
    // The full semantic fix (storing NULL for absent bands) is documented in
    // plans/2026-04-11-audit-solcast-data-feed-reliability.md as a follow-up.
    const loMw = loMwRaw ?? mw;
    const hiMw = hiMwRaw ?? mw;
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

  // v2.8 audit (R3): warn if Solcast omitted P10/P90 for a meaningful share
  // of records. Below this threshold the tri-band hard clamp loses bite
  // because lo == p50 == hi for affected slots.
  if (recordsWithAnyForecast > 0) {
    const loRatio = recordsWithRealLo / recordsWithAnyForecast;
    const hiRatio = recordsWithRealHi / recordsWithAnyForecast;
    if (loRatio < 0.5 || hiRatio < 0.5) {
      console.warn(
        `[solcast-snapshot] ${day}: P10/P90 coverage low ` +
          `(P10=${(loRatio * 100).toFixed(0)}%, P90=${(hiRatio * 100).toFixed(0)}% of ${recordsWithAnyForecast} records). ` +
          `Tri-band hard clamp will be partially or fully disabled for slots without bands. ` +
          `Check Solcast Toolkit response format / plan tier.`,
      );
    } else if (loRatio < 1.0 || hiRatio < 1.0) {
      console.log(
        `[solcast-snapshot] ${day}: tri-band partial coverage ` +
          `(P10=${(loRatio * 100).toFixed(0)}%, P90=${(hiRatio * 100).toFixed(0)}% of ${recordsWithAnyForecast} records)`,
      );
    }
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

function buildAndPersistSolcastSnapshotAllDays(records, estActuals, cfg, source, pulledTs) {
  const daySet = new Set();
  for (const rec of records || []) {
    const endRaw = rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
    const ts = Date.parse(String(endRaw || ""));
    if (Number.isFinite(ts) && ts > 0) {
      daySet.add(getTzParts(ts, cfg.timeZone).date);
    }
  }
  const results = {};
  for (const day of [...daySet].sort()) {
    try {
      results[day] = buildAndPersistSolcastSnapshot(day, records, estActuals, cfg, source, pulledTs);
    } catch (err) {
      results[day] = { ok: false, warning: String(err?.message || err || "unknown error") };
    }
  }
  return results;
}

function querySolcastWeekAheadDays(baseDateTz) {
  const dates = [];
  for (let i = 1; i <= 7; i++) dates.push(addDaysIso(baseDateTz, i));
  const rows = db.prepare(
    `SELECT forecast_day, slot, forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, pulled_ts
     FROM solcast_snapshots
     WHERE forecast_day IN (${dates.map(() => "?").join(",")})
     ORDER BY forecast_day, slot`,
  ).all(...dates);
  const byDay = {};
  for (const d of dates) {
    byDay[d] = { date: d, totalKwh: 0, totalLoKwh: 0, totalHiKwh: 0, slots: 0, pulledTs: null, hasData: false };
  }
  for (const r of rows) {
    const d = byDay[r.forecast_day];
    if (!d) continue;
    d.totalKwh   += Number(r.forecast_kwh    || 0);
    d.totalLoKwh += Number(r.forecast_lo_kwh || 0);
    d.totalHiKwh += Number(r.forecast_hi_kwh || 0);
    d.slots++;
    if (r.pulled_ts) d.pulledTs = Math.max(d.pulledTs ?? 0, Number(r.pulled_ts));
    d.hasData = true;
  }
  return Object.values(byDay);
}

function querySlotRowsForWeekAhead(dates) {
  if (!dates || !dates.length) return [];
  const rows = db.prepare(
    `SELECT forecast_day, slot, forecast_kwh, forecast_lo_kwh, forecast_hi_kwh
     FROM solcast_snapshots
     WHERE forecast_day IN (${dates.map(() => "?").join(",")})
     ORDER BY forecast_day, slot`,
  ).all(...dates);
  return rows.map((r) => {
    const slotNum = Number(r.slot || 0);
    const hh = Math.floor((slotNum * 5) / 60);
    const mm = (slotNum * 5) % 60;
    return {
      date: r.forecast_day,
      slot: slotNum,
      time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      forecastKwh:   Number(r.forecast_kwh    || 0),
      forecastLoKwh: Number(r.forecast_lo_kwh || 0),
      forecastHiKwh: Number(r.forecast_hi_kwh || 0),
    };
  });
}

async function fetchWeatherWithRetry(url, opts = {}, maxRetries = 2) {
  const delays = [1000, 3000];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(url, { timeout: 20000, ...opts });
      if (r.ok) return r;
      if (r.status >= 500 && attempt < maxRetries) {
        await new Promise(ok => setTimeout(ok, delays[attempt] || 3000));
        continue;
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise(ok => setTimeout(ok, delays[attempt] || 3000));
      }
    }
  }
  throw lastErr;
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
    const r = await fetchWeatherWithRetry(url);
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

    // Evict entries older than 2 weeks or if cache exceeds 52 entries
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    for (const [k, v] of weatherWeeklyCache) {
      if (now - (v.ts || 0) > TWO_WEEKS_MS) weatherWeeklyCache.delete(k);
    }
    if (weatherWeeklyCache.size > 52) {
      // Delete oldest by ts
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, v] of weatherWeeklyCache) {
        if ((v.ts || 0) < oldestTs) { oldestTs = v.ts || 0; oldestKey = k; }
      }
      if (oldestKey !== null) weatherWeeklyCache.delete(oldestKey);
    }
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

async function fetchHourlyWeatherToday() {
  const todayStr = localDateStr();
  const now = Date.now();
  const cached = weatherHourlyCache.get(todayStr);
  if (cached && now - Number(cached.ts || 0) <= WEATHER_CACHE_TTL_MS) {
    return cached.data;
  }

  const _lat = Number(getSetting("plantLatitude", WEATHER_LAT));
  const _lon = Number(getSetting("plantLongitude", WEATHER_LON));
  const baseUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${_lat}&longitude=${_lon}` +
    `&hourly=${encodeURIComponent(WEATHER_HOURLY_FIELDS)}` +
    `&start_date=${todayStr}&end_date=${todayStr}` +
    `&timezone=${encodeURIComponent(WEATHER_TZ)}`;
  const modelIds = WEATHER_CLOUD_MODELS.map((m) => m.id).join(",");
  const multiModelUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${_lat}&longitude=${_lon}` +
    `&hourly=cloud_cover` +
    `&models=${encodeURIComponent(modelIds)}` +
    `&start_date=${todayStr}&end_date=${todayStr}` +
    `&timezone=${encodeURIComponent(WEATHER_TZ)}`;

  try {
    const [baseRes, multiRes] = await Promise.allSettled([
      fetchWeatherWithRetry(baseUrl).then((r) => r.json()),
      fetchWeatherWithRetry(multiModelUrl).then((r) => r.json()),
    ]);
    if (baseRes.status !== "fulfilled") throw baseRes.reason;
    const payload = baseRes.value || {};
    const h = payload?.hourly || {};
    const time = Array.isArray(h.time) ? h.time : [];
    const ghi = Array.isArray(h.shortwave_radiation) ? h.shortwave_radiation : [];
    const dni = Array.isArray(h.direct_normal_irradiance) ? h.direct_normal_irradiance : [];
    const dhi = Array.isArray(h.diffuse_radiation) ? h.diffuse_radiation : [];
    const cloud = Array.isArray(h.cloud_cover) ? h.cloud_cover : [];
    const temp = Array.isArray(h.temperature_2m) ? h.temperature_2m : [];

    const rows = [];
    for (let i = 0; i < time.length; i++) {
      rows.push({
        time: String(time[i] || ""),
        ghi_wm2: Number.isFinite(Number(ghi[i])) ? Math.round(Number(ghi[i])) : 0,
        dni_wm2: Number.isFinite(Number(dni[i])) ? Math.round(Number(dni[i])) : 0,
        dhi_wm2: Number.isFinite(Number(dhi[i])) ? Math.round(Number(dhi[i])) : 0,
        cloud_pct: Number.isFinite(Number(cloud[i])) ? Math.round(Number(cloud[i])) : 0,
        temp_c: Number.isFinite(Number(temp[i])) ? Number(Number(temp[i]).toFixed(1)) : null,
      });
    }

    // Multi-model cloud cover — graceful: if the second call fails, cloudModels is []
    // and the renderer falls back to the blended cloud series alone.
    const cloudModels = [];
    if (multiRes.status === "fulfilled" && multiRes.value?.hourly) {
      const mh = multiRes.value.hourly;
      for (const spec of WEATHER_CLOUD_MODELS) {
        const arr = mh[`cloud_cover_${spec.id}`];
        if (!Array.isArray(arr) || !arr.length) continue;
        cloudModels.push({
          id: spec.id,
          label: spec.label,
          values: arr.map((v) =>
            Number.isFinite(Number(v)) ? Math.round(Number(v)) : null,
          ),
        });
      }
    } else if (multiRes.status === "rejected") {
      console.warn(
        `[weather] Multi-model cloud fetch failed (${multiRes.reason?.message || multiRes.reason}); using blended cloud only`,
      );
    }

    const data = { date: todayStr, rows, cloudModels };
    weatherHourlyCache.set(todayStr, { ts: now, data });

    // Evict old entries
    for (const [k, v] of weatherHourlyCache) {
      if (now - (v.ts || 0) > 24 * 60 * 60 * 1000) weatherHourlyCache.delete(k);
    }
    return data;
  } catch (err) {
    if (cached && cached.data) {
      console.warn(`[weather] Hourly API unavailable (${err.message}); serving stale cache`);
      return cached.data;
    }
    throw err;
  }
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
    // M5 fix: track this process for emergency kill in safety timer
    _lastForecastPid = proc.pid;

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
        // FIX-M7: On Windows, kill the process tree to avoid orphaned children
        if (process.platform === "win32" && proc.pid) {
          try { require("child_process").execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" }); } catch {}
        } else {
          proc.kill("SIGTERM");
        }
      } catch (killErr) {
        console.warn("[forecast] proc kill failed:", killErr.message);
      }
      _lastForecastPid = null;
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
      // M5 fix: clear tracked PID on process close
      _lastForecastPid = null;
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

/**
 * Shared provider-aware day-ahead generation orchestrator.
 *
 * Both manual, automatic (Python-delegated), and fallback cron paths call this
 * function so provider routing, Solcast freshness policy, and audit metadata
 * are consistent regardless of trigger source.
 *
 * @param {Object} opts
 * @param {string[]} opts.dates           - Target dates (YYYY-MM-DD)
 * @param {string}   opts.trigger         - 'manual_api' | 'auto_service' | 'node_fallback'
 * @param {boolean}  [opts.allowMlFallback=true]  - Allow ML fallback if preferred provider fails
 * @param {string|null} [opts.expectedProvider=null] - Override provider (null = read from settings)
 * @param {boolean}  [opts.replaceExisting=false]    - Replace existing forecast if present
 * @returns {Promise<Object>} Result payload with provider_expected, provider_used, etc.
 */
async function runDayAheadGenerationPlan({
  dates,
  trigger = "manual_api",
  allowMlFallback = true,
  expectedProvider = null,
  replaceExisting = false,
}) {
  const normalizedDates = Array.from(
    new Set(
      (Array.isArray(dates) ? dates : [])
        .map((d) => String(d || "").trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ),
  ).sort();
  if (!normalizedDates.length) {
    throw new Error("No target dates provided for day-ahead generation.");
  }

  const preferredProvider = expectedProvider || readForecastProvider();
  const maxFutureDateMl = addDaysIso(localDateStr(), 15);
  const outOfHorizonMl = normalizedDates.filter((d) => d > maxFutureDateMl);
  const expectSolcastInput =
    preferredProvider === "solcast" ||
    (preferredProvider === "ml_local" && hasUsableSolcastConfig(getSolcastConfig()));

  let providerOrder =
    preferredProvider === "solcast"
      ? ["solcast", ...(allowMlFallback ? ["ml_local"] : [])]
      : hasUsableSolcastConfig(getSolcastConfig())
        ? ["ml_local", "solcast"]
        : ["ml_local"];

  if (outOfHorizonMl.length) {
    providerOrder = providerOrder.filter((p) => p !== "ml_local");
    if (!providerOrder.length) {
      throw new Error(
        `Requested future date exceeds local ML weather horizon. Latest allowed date is ${maxFutureDateMl}.`,
      );
    }
  }

  const attempts = [];
  let generation = null;
  for (const provider of providerOrder) {
    const started = Date.now();
    try {
      if (provider === "solcast") {
        generation = await generateDayAheadWithSolcast(normalizedDates);
      } else {
        generation = await generateDayAheadWithMl(normalizedDates);
      }
      attempts.push({
        provider,
        ok: true,
        durationMs: Date.now() - started,
      });
      break;
    } catch (err) {
      // FIX-H3: Log partial state warning on provider failure
      console.warn(`[forecast] Provider ${provider} failed for dates [${normalizedDates.join(",")}]: ${err.message}. Partial writes may exist — next provider will overwrite.`);
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
    for (const day of normalizedDates) {
      const auditParams = {
        target_date: day,
        generated_ts: Date.now(),
        generator_mode: trigger,
        provider_used: attempts.length ? attempts[attempts.length - 1].provider : preferredProvider,
        provider_expected: preferredProvider,
        forecast_variant: "generation_failed",
        weather_source: null,
        solcast_snapshot_day: null,
        solcast_snapshot_pulled_ts: null,
        solcast_snapshot_age_sec: null,
        solcast_snapshot_coverage_ratio: null,
        solcast_snapshot_source: null,
        solcast_mean_blend: null,
        solcast_reliability: null,
        solcast_primary_mode: 0,
        solcast_raw_total_kwh: null,
        solcast_applied_total_kwh: null,
        physics_total_kwh: null,
        hybrid_total_kwh: null,
        final_forecast_total_kwh: null,
        ml_residual_total_kwh: null,
        error_class_total_kwh: null,
        bias_total_kwh: null,
        shape_skipped_for_solcast: 0,
        run_status: "failed",
        solcast_freshness_class: expectSolcastInput ? "missing" : "not_expected",
        is_authoritative_runtime: 0,
        is_authoritative_learning: 0,
        superseded_by_run_audit_id: null,
        replaces_run_audit_id: null,
        solcast_lo_total_kwh: null,
        solcast_hi_total_kwh: null,
        baseline_is_solcast_mid: 0,
        notes_json: JSON.stringify({ attempts, error: lastError }),
      };
      try {
        stmts.insertForecastRunAudit.run(auditParams);
      } catch (auditErr) {
        console.warn(`[forecast] Audit write failed for ${day}, retrying: ${auditErr.message}`);
        try {
          // H4 fix: single retry with 500ms delay
          await new Promise(r => setTimeout(r, 500));
          stmts.insertForecastRunAudit.run(auditParams);
        } catch (retryErr) {
          console.error(`[forecast] Audit write retry failed for ${day}: ${retryErr.message}`);
        }
      }
    }
    throw new Error(
      `Forecast generation failed for all providers (trigger=${trigger}). ${lastError}`,
    );
  }

  const providerUsed = generation.providerUsed || "ml_local";
  const variantsByDate = {};
  const freshnessByDate = {};
  const totalsByDate = {};

  // Extract per-run Python results from generation object (new in v2.5.1)
  // Contains: ml_residual_total_kwh, error_class_total_kwh, bias_total_kwh, error_memory_meta per date
  const pythonResultsByDate = generation.pythonResultsByDate || {};

  for (const day of normalizedDates) {
    const snapshotStats = getSolcastSnapshotStatsForDay(day);
    const freshness = classifySolcastFreshnessForDay(day, {
      expectSolcast: providerUsed === "solcast" || expectSolcastInput,
      pulledTsOverride:
        providerUsed === "solcast"
          ? generation.pulledTs
          : generation.solcastPull?.pulledTs || null,
      snapshotStats,
    });
    let forecastVariant = "ml_without_solcast";
    if (providerUsed === "solcast") {
      forecastVariant = "solcast_direct";
    } else if (freshness === "fresh") {
      forecastVariant = "ml_solcast_hybrid_fresh";
    } else if (freshness === "stale_usable" || freshness === "stale_reject") {
      forecastVariant = "ml_solcast_hybrid_stale";
    } else if (expectSolcastInput) {
      forecastVariant = "ml_without_solcast";
    }

    const dayTotalKwh = sumDayAheadTotalKwh(day);
    variantsByDate[day] = forecastVariant;
    freshnessByDate[day] = freshness;
    totalsByDate[day] = Number(dayTotalKwh.toFixed(3));

    const previousAuthoritative = stmts.getLatestAuthoritativeForecastRunAuditForDate.get(day) || null;

    // Read error memory totals from per-run Python result (v2.5.1+)
    // Python returns: ml_residual_total_kwh, error_class_total_kwh, bias_total_kwh, error_memory_meta
    // Safely coerce to NULL if missing or NaN
    const pythonResult = pythonResultsByDate[day] || {};
    const mlResidualKwh = pythonResult?.ml_residual_total_kwh != null && !Number.isNaN(pythonResult.ml_residual_total_kwh)
      ? Number(pythonResult.ml_residual_total_kwh)
      : null;
    const errorClassKwh = pythonResult?.error_class_total_kwh != null && !Number.isNaN(pythonResult.error_class_total_kwh)
      ? Number(pythonResult.error_class_total_kwh)
      : null;
    const biasKwh = pythonResult?.bias_total_kwh != null && !Number.isNaN(pythonResult.bias_total_kwh)
      ? Number(pythonResult.bias_total_kwh)
      : null;

    try {
      const notesObj = {
        attempts,
        replaceExisting: Boolean(replaceExisting),
        snapshotRows: Number(snapshotStats?.solarRows || 0),
        snapshotFilledRows: Number(snapshotStats?.filledRows || 0),
      };
      const errorMemoryMeta = pythonResult?.error_memory_meta || null;
      if (errorMemoryMeta) {
        notesObj.error_memory = errorMemoryMeta;
      }

      const inserted = stmts.insertForecastRunAudit.run({
        target_date: day,
        generated_ts: Date.now(),
        generator_mode: trigger,
        provider_used: providerUsed,
        provider_expected: preferredProvider,
        forecast_variant: forecastVariant,
        weather_source:
          providerUsed === "solcast"
            ? "solcast_direct"
            : forecastVariant === "ml_without_solcast"
              ? "archive-fallback"
              : "solcast_snapshot",
        solcast_snapshot_day: snapshotStats?.hasSnapshot ? day : null,
        solcast_snapshot_pulled_ts: snapshotStats?.pulledTs || null,
        solcast_snapshot_age_sec:
          Number(snapshotStats?.pulledTs || 0) > 0
            ? Math.floor((Date.now() - Number(snapshotStats.pulledTs)) / 1000)
            : null,
        solcast_snapshot_coverage_ratio:
          snapshotStats?.hasSnapshot ? Number(snapshotStats.coverageRatio || 0) : null,
        solcast_snapshot_source:
          providerUsed === "solcast"
            ? "direct"
            : generation.solcastPull?.pulled
              ? "auto_pull"
              : snapshotStats?.hasSnapshot
                ? "cached"
                : null,
        solcast_mean_blend: null,
        solcast_reliability: null,
        solcast_primary_mode: 0,
        solcast_raw_total_kwh: null,
        solcast_applied_total_kwh: null,
        physics_total_kwh: null,
        hybrid_total_kwh: null,
        final_forecast_total_kwh: Number(dayTotalKwh.toFixed(3)),
        ml_residual_total_kwh: mlResidualKwh,
        error_class_total_kwh: errorClassKwh,
        bias_total_kwh: biasKwh,
        shape_skipped_for_solcast: 0,
        run_status: "success",
        solcast_freshness_class: freshness,
        is_authoritative_runtime: 1,
        is_authoritative_learning: 1,
        superseded_by_run_audit_id: null,
        replaces_run_audit_id: previousAuthoritative?.id || null,
        solcast_lo_total_kwh: null,
        solcast_hi_total_kwh: null,
        baseline_is_solcast_mid: providerUsed === "solcast" ? 1 : 0,
        notes_json: JSON.stringify(notesObj),
      });
      const newRunId = Number(inserted?.lastInsertRowid || 0);
      const previousId = Number(previousAuthoritative?.id || 0);
      if (newRunId > 0 && previousId > 0 && previousId !== newRunId) {
        const previousNotes = {
          supersededBy: newRunId,
          supersededAt: Date.now(),
          reason: "new_authoritative_generation",
        };
        stmts.updateForecastRunAudit.run({
          id: previousId,
          is_authoritative_runtime: 0,
          is_authoritative_learning: 0,
          superseded_by_run_audit_id: newRunId,
          replaces_run_audit_id: null,
          run_status: "superseded",
          notes_json: JSON.stringify(previousNotes),
        });
      }
    } catch (auditErr) {
      console.warn(`[forecast] Failed to write audit log for ${day}:`, auditErr.message);
    }
  }

  const firstDate = normalizedDates[0];
  const primaryVariant = variantsByDate[firstDate] || "ml_without_solcast";

  return {
    provider_expected: preferredProvider,
    provider_used: providerUsed,
    forecast_variant: primaryVariant,
    forecast_variants_by_date: variantsByDate,
    solcast_freshness_by_date: freshnessByDate,
    totals_kwh_by_date: totalsByDate,
    trigger,
    solcast_pull: generation.solcastPull || null,
    written_rows: Number(generation.writtenRows || 0),
    normalized_rows: Number(generation.normalizedRows || 0),
    snapshot_rows_persisted: Number(generation.snapshotRowsPersisted || 0),
    snapshot_warnings: Array.isArray(generation.snapshotWarnings)
      ? generation.snapshotWarnings
      : [],
    target_dates: normalizedDates,
    durationMs: Number(generation.durationMs || 0),
    endpoint: generation.endpoint || "",
    attempts,
    warnings: [],
    // Pass through raw generation for response compatibility
    _raw: generation,
  };
}

/**
 * Backfill est_actual_mw/est_actual_kwh into existing snapshot rows for past
 * dates whose estActual data is available in the toolkit response.
 * Only updates rows that currently have NULL or 0 est_actual — never overwrites
 * existing est_actual or forecast columns.
 */
function backfillEstActualFromFetch(estActuals, cfg, targetDateSet) {
  if (!Array.isArray(estActuals) || !estActuals.length) return { backfilledDates: 0, backfilledSlots: 0 };

  const startMin = SOLCAST_SOLAR_START_H * 60;
  const endMin   = SOLCAST_SOLAR_END_H * 60;
  const accessMode = normalizeSolcastAccessMode(cfg?.accessMode);
  const KWH_PER_MW = 1000 * (SOLCAST_SLOT_MIN / 60);

  // Group estActual records by local date
  const byDate = new Map();
  for (const rec of estActuals) {
    const endRaw = rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
    const endTs  = Date.parse(String(endRaw || ""));
    if (!Number.isFinite(endTs) || endTs <= 0) continue;
    const p = getTzParts(endTs, cfg.timeZone);
    if (p.minuteOfDay < startMin || p.minuteOfDay >= endMin) continue;
    // Skip dates that are already in the target set (they get full upsert)
    if (targetDateSet.has(p.date)) continue;
    const slot = Math.floor(p.minuteOfDay / SOLCAST_SLOT_MIN);
    const mw = convertSolcastPowerToMw(
      rec?.pv_estimate ?? rec?.pvEstimate ?? rec?.pv_estimate_mean ?? rec?.pv_estimate_median,
      accessMode,
    );
    if (mw == null) continue;
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push({
      slot,
      est_actual_mw:  Number(mw.toFixed(6)),
      est_actual_kwh: Number((mw * KWH_PER_MW).toFixed(6)),
    });
  }

  let backfilledDates = 0;
  let backfilledSlots = 0;
  for (const [day, slotRows] of byDate) {
    try {
      const updated = bulkBackfillSolcastEstActual(day, slotRows);
      if (updated > 0) {
        backfilledDates++;
        backfilledSlots += updated;
        console.log(`[solcast-backfill] ${day}: backfilled est_actual for ${updated}/${slotRows.length} slots`);
      }
    } catch (err) {
      console.warn(`[solcast-backfill] ${day}: failed -`, err.message);
    }
  }
  return { backfilledDates, backfilledSlots };
}

/**
 * Lazy-backfill Solcast snapshots for a single date if the Analytics endpoint
 * detects no data or all-NULL est_actual rows. Respects rate-limit cooldown per date
 * and does not run in remote mode (remote clients proxy all requests to gateway).
 * Returns true if the backfill task was scheduled, false otherwise.
 */
function lazyBackfillSolcastSnapshotIfMissing(date) {
  // Guard: validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    return false;
  }

  // Guard: do not backfill in remote mode (remote clients proxy to gateway)
  if (isRemoteMode()) {
    return false;
  }

  // Guard: check rate-limit cooldown
  const nextRetryAt = _solcastLazyBackfillAttempts.get(date);
  if (nextRetryAt != null && nextRetryAt > Date.now()) {
    return false;
  }

  // Set cooldown to prevent rapid re-fetches
  _solcastLazyBackfillAttempts.set(date, Date.now() + SOLCAST_LAZY_BACKFILL_COOLDOWN_MS);

  // Fire-and-forget: schedule backfill without blocking the response
  setImmediate(async () => {
    try {
      await autoFetchSolcastSnapshots([date], { toolkitHours: SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS });
    } catch (err) {
      console.warn("[solcast-lazy-backfill]", date, err.message);
    }
  });

  return true;
}

/**
 * Auto-fetch fresh Solcast snapshots for the given dates before ML generation.
 * Also backfills est_actual data for recent past dates present in the toolkit
 * response (satellite-derived estimated actuals for outage reconstruction).
 * Silently returns { pulled: false } if Solcast is not configured or fetch fails.
 */
async function autoFetchSolcastSnapshots(dates, options = {}) {
  try {
    const cfg = getSolcastConfig();
    if (!hasUsableSolcastConfig(cfg)) {
      return { pulled: false, reason: "not_configured" };
    }
    // Request wider toolkit window to capture est_actual for past dates (backfill).
    // Toolkit supports ~30 days (15 past + 15 future); use max available hours
    // unless the caller explicitly set a narrower window.
    const fetchOptions = { ...options };
    if (!fetchOptions.toolkitHours) {
      fetchOptions.toolkitHours = SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS;
    }
    const { records, estActuals, accessMode } = await fetchSolcastForecastRecords(cfg, fetchOptions);
    const pulledTs = Date.now();
    const warnings = [];
    let persisted = 0;
    const targetDateSet = new Set(dates);
    for (const day of dates) {
      const snap = buildAndPersistSolcastSnapshot(
        day,
        records,
        estActuals || [],
        cfg,
        accessMode,
        pulledTs,
      );
      persisted += Number(snap?.persistedRows || 0);
      if (!snap?.ok && snap?.warning) {
        warnings.push(String(snap.warning));
      }
    }

    // ── History append (v2.8+) ──────────────────────────────────────────
    // After persisting to solcast_snapshots, append a frozen copy to
    // solcast_snapshot_history so we preserve the full day-ahead→intraday
    // evolution for post-hoc analysis and spread-weighted learning.
    // This runs on every successful Solcast pull (5–10/day in practice).
    let historyRowsAppended = 0;
    try {
      const capturedTs = Date.now();
      const historyRows = [];
      for (const day of dates) {
        const snapRows = stmts.getSolcastSnapshotDay.all(String(day || ""));
        for (const r of snapRows) {
          historyRows.push({
            forecast_day: r.forecast_day,
            slot: r.slot,
            captured_ts: capturedTs,
            pulled_ts: Number(r.pulled_ts || pulledTs),
            p50_mw: r.forecast_mw,
            p10_mw: r.forecast_lo_mw,
            p90_mw: r.forecast_hi_mw,
            est_actual_mw: r.est_actual_mw,
            age_sec: Math.max(
              0,
              Math.floor((capturedTs - Number(r.pulled_ts || pulledTs)) / 1000),
            ),
            solcast_source: r.source || accessMode || "toolkit",
          });
        }
      }
      if (historyRows.length > 0) {
        historyRowsAppended = bulkInsertSnapshotHistory(historyRows);
      }
    } catch (histErr) {
      // Non-fatal — the live snapshot was already persisted; history is
      // purely a research/learning artifact. Log and move on.
      console.warn(
        `[forecast] Snapshot history append failed: ${histErr?.message || histErr}`,
      );
    }

    // Backfill est_actual for past dates present in the toolkit response
    const backfill = backfillEstActualFromFetch(estActuals, cfg, targetDateSet);
    if (backfill.backfilledSlots > 0) {
      console.log(
        `[forecast] Est-actual backfill: ${backfill.backfilledSlots} slots across ${backfill.backfilledDates} past date(s)`,
      );
    }

    console.log(
      `[forecast] Auto-pulled Solcast snapshots for ${dates.length} date(s): ${persisted} rows persisted, ${historyRowsAppended} history rows appended`,
    );
    return { pulled: true, persisted, warnings, pulledTs, backfill, historyRowsAppended };
  } catch (err) {
    console.warn("[forecast] Solcast auto-pull failed (will use cached/physics fallback):", err.message);
    return { pulled: false, reason: String(err.message || "fetch_error").slice(0, 300), pulledTs: null };
  }
}

async function generateDayAheadWithMl(dates) {
  const targetDates = Array.from(
    new Set(
      (Array.isArray(dates) ? dates : [])
        .map((d) => String(d || "").trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ),
  ).sort();
  if (!targetDates.length) {
    throw new Error("No target dates provided for ML generation.");
  }

  // Auto-pull fresh Solcast snapshots before spawning Python ML generator.
  const solcastPull = await autoFetchSolcastSnapshots(targetDates);

  const isContiguous = targetDates.every((day, idx) => {
    if (idx === 0) return true;
    return day === addDaysIso(targetDates[idx - 1], 1);
  });

  // Track per-run Python results (with totals and error_memory_meta)
  const pythonResultsByDate = {};

  const runAndAssert = async (args) => {
    const result = await runForecastGenerator(args);
    const exitCode = Number(result?.code ?? -1);
    if (exitCode !== 0) {
      const details = String(result?.stderr || result?.stdout || "")
        .trim()
        .slice(-2000);
      throw new Error(`ML forecast generator failed (code ${exitCode}). ${details || ""}`.trim());
    }
    return result;
  };

  let durationMs = 0;
  if (targetDates.length === 1) {
    const result = await runAndAssert(["--generate-date", targetDates[0]]);
    durationMs += Number(result?.durationMs || 0);
    // Parse Python stdout to extract per-run result (v2.5.1+)
    try {
      const pythonResult = JSON.parse(String(result?.stdout || "{}"));
      if (pythonResult && targetDates[0]) {
        pythonResultsByDate[targetDates[0]] = pythonResult;
      }
    } catch (parseErr) {
      console.warn("[forecast] Failed to parse single-date ML result stdout:", parseErr.message);
    }
  } else if (isContiguous) {
    const result = await runAndAssert([
      "--generate-range",
      targetDates[0],
      targetDates[targetDates.length - 1],
    ]);
    durationMs += Number(result?.durationMs || 0);
    // For range, Python may return a single aggregated result or per-date results
    // Try to parse and store; if it's aggregated, all dates will use the same result
    try {
      const pythonResult = JSON.parse(String(result?.stdout || "{}"));
      if (pythonResult) {
        // Assume single aggregated result for the range
        for (const day of targetDates) {
          pythonResultsByDate[day] = pythonResult;
        }
      }
    } catch (parseErr) {
      console.warn("[forecast] Failed to parse range ML result stdout:", parseErr.message);
    }
  } else {
    for (const day of targetDates) {
      const result = await runAndAssert(["--generate-date", day]);
      durationMs += Number(result?.durationMs || 0);
      // Parse Python stdout to extract per-run result (v2.5.1+)
      try {
        const pythonResult = JSON.parse(String(result?.stdout || "{}"));
        if (pythonResult) {
          pythonResultsByDate[day] = pythonResult;
        }
      } catch (parseErr) {
        console.warn(`[forecast] Failed to parse ML result stdout for ${day}:`, parseErr.message);
      }
    }
  }

  try {
    syncDayAheadFromContextIfNewer(true);
  } catch (err) {
    console.warn("[forecast] forced context sync failed:", err.message);
  }
  const normalizedRows = normalizeForecastDbWindow();
  return {
    providerUsed: "ml_local",
    durationMs,
    normalizedRows,
    solcastPull,
    pythonResultsByDate,
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
  // Backfill est_actual for past dates present in the toolkit response
  const backfill = backfillEstActualFromFetch(estActuals, cfg, new Set(dates));
  const normalizedRows = normalizeForecastDbWindow();
  return {
    providerUsed: "solcast",
    accessMode,
    endpoint,
    writtenRows,
    snapshotRowsPersisted,
    snapshotWarnings,
    normalizedRows,
    pulledTs,
    estActualBackfill: backfill,
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
  const day = localDateStr();
  if (isRemoteMode()) {
    return normalizeTodayEnergyRows(getTodayEnergySupplementRows(day));
  }
  // Use energy_5min (completed 5-min buckets) as primary source, supplemented by
  // the poller's live PAC accumulator for the current partial bucket.
  // This is reliable, fast, and resets automatically at midnight via timestamp boundary.
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

function buildCurrentDayEnergySnapshot(options = {}) {
  const asOfTs = Number(options?.asOfTs || Date.now());
  const day = localDateStr(asOfTs);
  const rows = normalizeTodayEnergyRows(
    Array.isArray(options?.todayEnergyRows)
      ? options.todayEnergyRows
      : getTodayPacTotalsFromDbCached(),
  );
  const todaySummary = {
    day,
    as_of_ts: asOfTs,
    ...summarizeCurrentDayEnergyRows(rows),
  };
  const snapshot = {
    day,
    asOfTs,
    rows,
    todaySummary,
  };

  if (options?.includeDailyReportRows === true) {
    snapshot.dailyReportRows = buildDailyReportRowsForDate(day, {
      persist: false,
      refresh: false,
      includeTodayPartial: true,
      todayEnergyRows: rows,
    });
  }

  return snapshot;
}

function buildReportSummaryWithCurrentDaySnapshot(day, baseSummary, currentDaySnapshot, todayRows) {
  const today = localDateStr();
  if (!currentDaySnapshot || currentDaySnapshot.day !== today) {
    return baseSummary;
  }

  const selectedDay = String(day || "").trim();
  const summary = mergeCurrentDaySummaryIntoReportSummary(
    baseSummary,
    currentDaySnapshot.todaySummary,
    {
      replaceDaily: selectedDay === today,
      replaceWeekly:
        String(baseSummary?.week_start || "") <= today &&
        String(baseSummary?.week_end || "") >= today,
      baseTodayDailyTotalKwh: summarizeDailyReportRows(todayRows).total_kwh,
    },
  );

  if (
    selectedDay === today &&
    Array.isArray(currentDaySnapshot.dailyReportRows) &&
    currentDaySnapshot.dailyReportRows.length > 0
  ) {
    summary.current_day.daily_report_rows = cloneDailyReportRows(
      currentDaySnapshot.dailyReportRows,
    );
  }

  return summary;
}

function sumEnergyRowsKwh(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, row) => sum + Math.max(0, Number(row?.kwh_inc || 0)),
    0,
  );
}


function buildForecastActualSupplementRowsForRange(
  startTs,
  endTs,
  currentDaySnapshot = null,
) {
  const snapshot =
    currentDaySnapshot &&
    currentDaySnapshot.day === localDateStr() &&
    currentDaySnapshot.todaySummary
      ? currentDaySnapshot
      : buildCurrentDayEnergySnapshot();
  const s = Number(startTs || 0) || Date.now() - 86400000;
  const e = Number(endTs || 0) || Date.now();
  const day = String(snapshot.day || localDateStr());
  const dayStartTs = new Date(`${day}T00:00:00.000`).getTime();
  const dayEndTs = new Date(`${day}T23:59:59.999`).getTime();
  const overlapStartTs = Math.max(s, dayStartTs);
  const overlapEndTs = Math.min(e, dayEndTs, Number(snapshot.asOfTs || Date.now()));
  if (!(overlapEndTs >= overlapStartTs)) return [];

  const persistedBeforeRangeKwh =
    overlapStartTs > dayStartTs
      ? sumEnergyRowsKwh(
          queryEnergy5minRangeAll(dayStartTs, Math.max(dayStartTs, overlapStartTs - 1)),
        )
      : 0;
  const persistedRangeKwh = sumEnergyRowsKwh(
    queryEnergy5minRangeAll(overlapStartTs, overlapEndTs),
  );

  return buildCurrentDayActualSupplementRows({
    startTs: s,
    endTs: e,
    rangeStartTs: overlapStartTs,
    rangeEndTs: overlapEndTs,
    dayStartTs,
    dayEndTs,
    asOfTs: Number(snapshot.asOfTs || Date.now()),
    authoritativeTotalKwh: Number(snapshot.todaySummary?.total_kwh || 0),
    persistedBeforeRangeKwh,
    persistedRangeKwh,
  });
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
/* Availability-aware online interval builder.
   A node is "available" when online=1, UNLESS it was manually stopped
   (alarm=0x1000).  Non-manual-stop fault alarms are disregarded — the node
   still counts as available even if PAC dropped to 0 due to a fault. */
function isNodeAvailableForRow(row) {
  if (Number(row?.online || 0) !== 1) return false;
  const alarm = Number(row?.alarm || 0);
  return (alarm & 0x1000) === 0;
}

function buildNodeOnlineIntervalsMs(rows, maxGapS = AVAIL_MAX_GAP_S) {
  const sorted = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
  if (sorted.length === 0) return [];

  const intervals = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (!isNodeAvailableForRow(cur)) continue;
    const start = Number(cur?.ts || 0);
    const endRaw = Number(next?.ts || 0);
    if (!(start > 0) || !(endRaw > start)) continue;
    const maxEnd = start + Math.max(0, Number(maxGapS || 0)) * 1000;
    const end = Math.min(endRaw, maxEnd);
    if (end > start) intervals.push([start, end]);
  }

  // Keep parity with computeNodeOnlineSeconds(): tail credit for a final online row.
  const last = sorted[sorted.length - 1];
  if (isNodeAvailableForRow(last)) {
    const start = Number(last?.ts || 0);
    if (start > 0) intervals.push([start, start + 1000]);
  }

  // Bridge brief offline gaps (comms blips, Modbus timeouts) so they
  // don't penalise availability.  Two online intervals separated by a
  // gap ≤ AVAIL_OFFLINE_TOLERANCE_S are merged into one continuous span.
  return bridgeShortOfflineGaps(intervals, AVAIL_OFFLINE_TOLERANCE_S);
}

function bridgeShortOfflineGaps(intervals, toleranceS) {
  if (intervals.length < 2 || !(toleranceS > 0)) return intervals;
  const tolMs = toleranceS * 1000;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [[sorted[0][0], sorted[0][1]]];

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = out[out.length - 1];
    const [s, e] = sorted[i];
    if (s - prev[1] <= tolMs) {
      // Gap is within tolerance — bridge it
      if (e > prev[1]) prev[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
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
  return NODE_KW_MAX * count;
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
  const currentDayEnergyRows =
    day === localDateStr() && includeTodayPartial && Array.isArray(options?.todayEnergyRows)
      ? normalizeTodayEnergyRows(options.todayEnergyRows)
      : null;

  const invCount = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const pacKwhByInv =
    currentDayEnergyRows && currentDayEnergyRows.length
      ? new Map(
          currentDayEnergyRows
            .map((row) => [
              Number(row?.inverter || 0),
              Number(row?.total_kwh || 0),
            ])
            .filter(([inv, totalKwh]) => inv > 0 && totalKwh > 0),
        )
      : sumEnergy5minByInverterRange(startTs, endTs);

  if (day === localDateStr() && includeTodayPartial) {
    const supplementalRows =
      currentDayEnergyRows && currentDayEnergyRows.length
        ? currentDayEnergyRows
        : getTodayEnergySupplementRows(day);
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

    /* ── Per-inverter dynamic availability window ───────────────────────
       Window start = first non-zero PAC interval start (>= solar 5 AM)
       Window end   = last interval end (last zero-PAC transition, <= solar 6 PM / now)
       Falls back to the fixed solar window if no intervals exist.          */
    const clippedIntervals = reportWindow.startTs > 0 && reportWindow.endTs > reportWindow.startTs
      ? clipIntervalsToWindowMs(allIntervals, reportWindow.startTs, reportWindow.endTs)
      : allIntervals.slice();
    let dynWindowStartMs = Infinity;
    let dynWindowEndMs = 0;
    for (const [s, e] of clippedIntervals) {
      if (s < dynWindowStartMs) dynWindowStartMs = s;
      if (e > dynWindowEndMs) dynWindowEndMs = e;
    }
    const dynWindowS = dynWindowEndMs > dynWindowStartMs
      ? (dynWindowEndMs - dynWindowStartMs) / 1000
      : 0;
    const availWindowS = dynWindowS > 0 ? dynWindowS : expectedSolarWindowS;

    const expectedNodeUptimeS = availWindowS * activeNodeCount;
    const availabilityPct =
      availWindowS > 0 ? (uptimeS / availWindowS) * 100 : 0;
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

  const totalInvCount = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const availabilityAvgPct = totalInvCount > 0 ? availSum / totalInvCount : 0;
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
  const currentDaySnapshot =
    options.currentDaySnapshot && typeof options.currentDaySnapshot === "object"
      ? options.currentDaySnapshot
      : null;
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
  const baseSummary = {
    date: day,
    week_start: weekStart,
    week_end: weekEnd,
    daily: summarizeDailyReportRows(dailyRows),
    weekly: summarizeDailyReportRows(weeklyRows),
  };
  const summary = buildReportSummaryWithCurrentDaySnapshot(
    day,
    baseSummary,
    currentDaySnapshot,
    byDateRows.get(today) || [],
  );
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
    out.inverters[i] = ip;
    out.poll_interval[i] = Number.isFinite(poll) && poll >= 0.01 ? poll : 0.05;
    out.units[i] = units.length ? [...new Set(units)] : [];
    out.losses[i] =
      Number.isFinite(lossRaw) && lossRaw >= 0 && lossRaw <= 100
        ? lossRaw
        : out.losses[i];
  }
  return out;
}

function legacyIpConfigPaths() {
  // Only include paths under user-data / portable roots — these persist
  // across updates. Paths under the installed app directory
  // (path.join(__dirname, "../ipconfig.json")) or the current working
  // directory are intentionally excluded: they are replaced by every
  // installer run, so letting them feed the fallback chain allows a
  // stale bundled ipconfig to silently overwrite user customizations
  // on the first post-update boot.
  const preferred = [];
  if (PORTABLE_ROOT) {
    preferred.push(path.join(PORTABLE_ROOT, "config", "ipconfig.json"));
  }
  preferred.push(path.join(DATA_DIR, "ipconfig.json"));
  return [...new Set(preferred)];
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

plantCapController = new PlantCapController({
  getLiveData: () => getRuntimeLiveData(),
  getIpConfig: () => loadIpConfigFromDb(),
  getSettings: () => buildSettingsSnapshot(),
  isRemoteMode: () => isRemoteMode(),
  executeWrite: (body) => executeLocalControlWriteRequest(body, { skipBulkAuth: true }),
  broadcast: (payload) => broadcastUpdate(payload),
  getDb: () => db,
  liveFreshMs: LIVE_FRESH_MS,
  operatorName: "PLANT CAP",
});

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
  const todayEnergy = getTodayEnergyRowsForWs();
  const plantCap =
    plantCapController &&
    plantCapController.getStatus({ refresh: true, includePreview: false });
  ws.send(
    JSON.stringify({
      type: "init",
      data: getRuntimeLiveData(),
      todayEnergy,
      todaySummary: buildCurrentDayEnergySnapshot({
        asOfTs: Date.now(),
        todayEnergyRows: todayEnergy,
      }).todaySummary,
      remoteHealth: buildRemoteHealthSnapshot(),
      settings: {
        inverterCount: Number(getSetting("inverterCount", 27)),
        plantName: getSetting("plantName", "ADSI Plant"),
        exportLimitMw: (() => {
          const n = Number(getSetting("forecastExportLimitMw", "24") || "24");
          return Number.isFinite(n) && n > 0 ? n : 24;
        })(),
      },
      plantCap: plantCap || null,
    }),
  );
});

/* ── Camera RTSP → MPEG1/TS WebSocket ─────────────────────────────── */
app.ws("/ws/camera", (ws, req) => {
  let registered = false;

  function tryStart(rtspUrl) {
    if (registered || !rtspUrl) return;
    registered = true;
    streaming.registerStreamClient(ws);
    if (streaming.getCameraStatus() === "stopped" || streaming.getCameraStatus() === "error") {
      if (!streaming.startCameraStream(rtspUrl)) {
        streaming.unregisterStreamClient(ws);
        registered = false;
        ws.close(4002, "Failed to start camera stream");
      }
    }
  }

  // Support RTSP URL via query parameter (used by jsmpeg's built-in WS source)
  const qUrl = req.query && req.query.url;
  if (qUrl) tryStart(qUrl);

  // Also support JSON message approach (manual WS clients)
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "start" && data.rtspUrl) tryStart(data.rtspUrl);
    } catch (_) {}
  });

  ws.on("close", () => { if (registered) streaming.unregisterStreamClient(ws); });
  ws.on("error", () => { if (registered) streaming.unregisterStreamClient(ws); });
});

/* ── go2rtc process control (gateway-mode only) ───────────────────── */
app.get("/api/streaming/go2rtc-status", (req, res) => {
  res.json(go2rtcManager.getStatus());
});

app.post("/api/streaming/go2rtc/start", (req, res) => {
  if (isRemoteMode()) {
    return res
      .status(403)
      .json({ ok: false, error: "go2rtc is only available in gateway mode." });
  }
  go2rtcManager
    .start(true)
    .then((r) => res.json(r))
    .catch((e) => res.status(500).json({ ok: false, error: e.message }));
});

app.post("/api/streaming/go2rtc/stop", (req, res) => {
  go2rtcManager
    .stop()
    .then(() => res.json({ ok: true }))
    .catch((e) => res.status(500).json({ ok: false, error: e.message }));
});

app.get("/api/system/contention", (req, res) => {
  const bp = getEnergyBacklogPressure();
  const perf = poller.getPerfStats();
  res.json({
    ok: true,
    contention: {
      energyBacklog: bp,
      replicationYield: {
        yieldCount: replicationYieldStats.yieldCount,
        yieldTotalMs: replicationYieldStats.yieldTotalMs,
        lastYieldTs: replicationYieldStats.lastYieldTs,
      },
      eventLoop: {
        lagMs: perf.eventLoopLagMs,
        lagMaxMs: perf.eventLoopLagMaxMs,
        lagAvgMs: Number(Number(perf.eventLoopLagAvgMs || 0).toFixed(1)),
        jsonSerializeMaxMs: perf.jsonSerializeMaxMs,
      },
    },
  });
});

// v2.8.10 Phase C: expose the boot-time DB integrity snapshot so the
// renderer can show a banner when the main DB was auto-restored from a
// backup slot after a torn-write event. Read-only; no side effects.
app.get("/api/health/db-integrity", (req, res) => {
  const snap = startupIntegrityResult || {};
  // v2.8.14 — surface the prior-run shutdown classification so the renderer
  // banner can distinguish Windows-initiated reboots (session-end /
  // powerMonitor) from unexpected crashes (BSOD / power loss / hard kill).
  const ls = snap.lastShutdown && typeof snap.lastShutdown === "object" ? snap.lastShutdown : null;
  const prior = ls?.priorReason && typeof ls.priorReason === "object" ? ls.priorReason : null;
  res.json({
    ok: true,
    mainDb: snap.mainDb || "unknown",
    restored: !!snap.restored,
    restoredFromSlot: snap.restoredFromSlot,
    restoredAt: Number(snap.restoredAt || 0),
    unrescuable: !!snap.unrescuable,
    unrescuableAt: Number(snap.unrescuableAt || 0),
    quickCheck: String(snap.quickCheck || ""),
    checkedAt: Number(snap.checkedAt || 0),
    backupCandidates: Array.isArray(snap.backupCandidates)
      ? snap.backupCandidates.map((c) => ({
          slot: c.slot,
          size: c.size,
          mtimeMs: c.mtimeMs,
          ok: c.ok,
        }))
      : [],
    lastShutdown: ls
      ? {
          classification: String(ls.classification || "unknown"),
          sentinelWasPresent: !!ls.sentinelWasPresent,
          checkedAt: Number(ls.checkedAt || 0),
          reason: prior ? String(prior.reason || "") : "",
          initiator: prior ? String(prior.initiator || "") : "",
          timestamp: prior ? Number(prior.timestamp || 0) : 0,
          isoTime: prior ? String(prior.isoTime || "") : "",
          extra: prior && typeof prior === "object"
            ? Object.fromEntries(
                Object.entries(prior).filter(
                  ([k]) => !["reason", "initiator", "timestamp", "isoTime", "pid", "platform", "nodeVersion", "electronVersion", "appVersion"].includes(k),
                ),
              )
            : null,
        }
      : null,
  });
});

app.get("/api/live", (req, res) => {
  // Hot-path optimization for gateway mode: avoid per-request stringify cost.
  // Supports ETag for direct consumers that can tolerate cached heartbeat data.
  // The remote bridge still uses full polls so downstream clients keep fresh
  // timestamps/totals for accuracy and stale-card avoidance.
  // Uses res.writeHead()+res.end() to bypass Express's own ETag generation
  // which would overwrite our timestamp-based ETag.
  if (!isRemoteMode() && typeof poller.getLiveSnapshotJson === "function") {
    const snap = poller.getLiveSnapshotJson();
    if (snap && typeof snap.json === "string") {
      const etag = `"live-${snap.ts}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { "ETag": etag });
        return res.end();
      }
      const buf = Buffer.from(snap.json, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(buf.length),
        "ETag": etag,
        "Cache-Control": "no-cache",
      });
      return res.end(buf);
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
    const rateMachine = isRemoteMode() ? "remote" : (readOperationMode() || "gateway");
    checkChatRateLimit(rateMachine);
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

app.post("/api/replication/cancel", (req, res) => {
  const result = requestManualReplicationCancel();
  if (!result.ok) {
    return res.status(409).json(result);
  }
  return res.json(result);
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
  prepareArchiveDbForTransfer(monthKey);
  let snapshot = null;
  try {
    const resolved = resolveArchiveFileForTransfer(fileName);
    if (!resolved?.path) {
      throw new Error("Archive file not found.");
    }
    snapshot = await createSqliteTransferSnapshot(resolved.path, {
      targetDir: ARCHIVE_DIR,
      prefix: `${fileName}.transfer-snapshot`,
      mtimeMs: Math.max(0, Number(resolved.mtimeMs || 0)),
    });
    const totalBytes = Math.max(0, Number(snapshot?.size || resolved.size || 0));
    const sha256 = await getCachedFileSha256(snapshot.tempPath, {
      size: totalBytes,
      mtimeMs: Math.max(0, Number(snapshot?.mtimeMs || resolved.mtimeMs || 0)),
    });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("x-archive-size", String(totalBytes));
    res.setHeader("x-archive-sha256", sha256);
    res.setHeader(
      "x-archive-mtime",
      String(Math.max(0, Number(snapshot?.mtimeMs || resolved.mtimeMs || 0))),
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Accept-Ranges", "bytes");

    // Support HTTP Range requests for resumable downloads.
    const rangeHeader = String(req.headers.range || "").trim();
    if (rangeHeader && totalBytes > 0) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? Math.min(parseInt(match[2], 10), totalBytes - 1) : totalBytes - 1;
        if (start >= totalBytes || start > end) {
          res.setHeader("Content-Range", `bytes */${totalBytes}`);
          return res.status(416).end();
        }
        res.setHeader("Content-Range", `bytes ${start}-${end}/${totalBytes}`);
        res.setHeader("Content-Length", String(end - start + 1));
        res.status(206);
        await pipeline(
          fs.createReadStream(snapshot.tempPath, {
            start,
            end,
            highWaterMark: REPLICATION_TRANSFER_STREAM_HWM,
          }),
          res,
        );
        return;
      }
    }

    const useGzip = shouldGzipReplicationStream(req, totalBytes);
    if (!useGzip) {
      res.setHeader("Content-Length", String(totalBytes));
      await pipeline(createTransferReadStream(snapshot.tempPath), res);
      return;
    }
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    await pipeline(
      createTransferReadStream(snapshot.tempPath),
      createReplicationGzipStream(),
      res,
    );
    return;
  } catch (err) {
    return res.status(404).json({ ok: false, error: "Archive file not found." });
  } finally {
    if (snapshot?.tempPath) {
      try {
        await disposeSqliteTransferSnapshot(snapshot);
      } catch (err) {
        console.warn(
          "[replication] failed to clean up archive transfer snapshot:",
          String(err?.message || err || "unknown error"),
        );
      }
    }
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

    // Include gateway cursors so the remote side can converge after pull.
    let gatewayCursorsJson = "{}";
    try {
      gatewayCursorsJson = JSON.stringify(buildCurrentReplicationCursors());
    } catch (_) { /* non-fatal */ }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("x-main-db-size", String(totalBytes));
    res.setHeader("x-main-db-mtime", String(targetMtimeMs));
    res.setHeader("x-main-db-sha256", String(snapshot?.sha256 || ""));
    res.setHeader("x-main-db-cursors", gatewayCursorsJson);
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
    const cancelled = isTransferStreamAbortError(err);
    broadcastUpdate({
      type: "xfer_progress",
      dir: "tx",
      phase: cancelled ? "cancelled" : "error",
      sentBytes,
      totalBytes: Math.max(0, Number(snapshot?.size || sentBytes || 0)),
      chunkCount: 1,
      label: "Sending main database",
    });
    if (cancelled) {
      return;
    }
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  } finally {
    releaseGatewayMainDbSnapshotForTransfer(snapshot);
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

    await waitForEnergyBacklogRelief();
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
    let preflight = null;
    if (background && !forcePull) {
      preflight = await evaluateManualPullPreflight(base, forcePull);
      if (!preflight?.ok) {
        return sendManualPullErrorResponse(res, preflight?.error);
      }
    }
    if (background) {
      const started = startManualReplicationJob(
        "pull",
        {
          includeArchive,
          summary: "Queued standby DB refresh from gateway.",
          runningSummary: "Downloading and staging the gateway main database for standby use.",
        },
        (runControl) =>
          runManualPullSync(base, includeArchive, forcePull, {
            signal: runControl?.controller?.signal || null,
            runControl,
            preflight,
          }),
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
          "Background standby DB refresh started. Archives are staged first (when included), then the gateway main database. Restart is needed to apply.",
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
    return sendManualPullErrorResponse(res, err);
  }
});

app.post("/api/replication/push-now", async (req, res) => {
  // Viewer model: push is disabled. Remote mode is a gateway-backed viewer.
  return res.status(410).json({
    ok: false,
    error: "Push is disabled. Remote mode is a gateway-backed viewer.",
  });
});

app.post("/api/replication/reconcile-now", async (req, res) => {
  // Viewer model: reconciliation is disabled. Remote mode is a gateway-backed viewer.
  return res.status(410).json({
    ok: false,
    error: "Reconciliation is disabled. Remote mode is a gateway-backed viewer.",
  });
});

app.post("/api/write", async (req, res) => {
  if (isRemoteMode()) {
    return proxyWriteToRemote(req, res);
  }
  try {
    // T2.3 fix (Phase 5): pass req so a bound session token is rejected
    // when replayed from a different client.
    const result = await executeLocalControlWriteRequest(req.body || {}, { req });
    res.json(result);
  } catch (e) {
    res.status(Number(e?.status || 502)).json({ ok: false, error: e.message });
  }
});

app.post("/api/write/batch", async (req, res) => {
  if (isRemoteMode()) {
    return proxyWriteToRemote(req, res, "/api/write/batch");
  }
  try {
    const result = await executeLocalBatchControlWriteRequest(req.body || {}, { req });
    res.json(result);
  } catch (e) {
    res.status(Number(e?.status || 502)).json({ ok: false, error: e.message });
  }
});

app.post("/api/write/auth/bulk", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const { authKey } = req.body || {};
  // T2.1 fix: capture the clock ONCE and pass it to both auth functions so
  // a clock step between the key check and the session mint cannot produce
  // inconsistent (issuedAt, expiresAt) pairs or reject a valid key that
  // crossed a minute boundary between reads.
  const nowMs = Date.now();
  if (!isValidPlantWideAuthKey(authKey, nowMs)) {
    return res.status(403).json({ ok: false, error: "Authorization failed. Invalid auth key." });
  }
  // T2.3 fix (Phase 5): bind the session to the requesting client so it
  // cannot be replayed from elsewhere within the TTL window.
  const session = issuePlantWideAuthSession(nowMs, req);
  return res.json({
    ok: true,
    token: session.token,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    ttlMs: session.ttlMs,
  });
});

app.get("/api/plant-cap/status", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  return res.json({
    ok: true,
    status:
      plantCapController &&
      plantCapController.getStatus({ refresh: true, includePreview: true }),
  });
});

app.post("/api/plant-cap/preview", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const preview =
      plantCapController && plantCapController.buildPreview(req.body || {});
    return res.json({
      ok: true,
      preview,
      status:
        plantCapController &&
        plantCapController.getStatus({ refresh: true, includePreview: false }),
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/plant-cap/enable", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res
      .status(403)
      .json({ ok: false, error: "Unauthorized plant cap command" });
  }
  try {
    const status =
      plantCapController &&
      (await plantCapController.enable(req.body || {}));
    return res.json({ ok: true, status });
  } catch (err) {
    return res
      .status(Number(err?.status || 400))
      .json({ ok: false, error: err.message });
  }
});

app.post("/api/plant-cap/disable", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res
      .status(403)
      .json({ ok: false, error: "Unauthorized plant cap command" });
  }
  const status =
    plantCapController &&
    plantCapController.disable(
      "disabled",
      "Plant-wide capping monitoring was disabled by an authorized operator.",
    );
  return res.json({ ok: true, status });
});

app.post("/api/plant-cap/release", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res
      .status(403)
      .json({ ok: false, error: "Unauthorized plant cap command" });
  }
  try {
    const result =
      plantCapController && (await plantCapController.releaseControlled());
    return res.json(result || { ok: false, error: "Plant cap controller unavailable." });
  } catch (err) {
    return res
      .status(Number(err?.status || 500))
      .json({ ok: false, error: err.message });
  }
});

app.get("/api/plant-cap/history", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const rows = db
      .prepare(
        `SELECT ts, operator, inverter, node, action, scope, result, ip, reason
         FROM audit_log
         WHERE scope = 'plant-cap'
         ORDER BY ts DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    return res.json({ ok: true, history: rows, limit, offset });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/plant-cap/forecast-impact", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const upperMw = Number(req.query.upperMw);
    if (!Number.isFinite(upperMw) || upperMw <= 0) {
      return res.status(400).json({ ok: false, error: "upperMw must be a positive number" });
    }
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const pad = (n) => String(n).padStart(2, "0");
    const defaultDate = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    const date = String(req.query.date || defaultDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "date must be YYYY-MM-DD" });
    }
    const rows = db
      .prepare("SELECT kwh_inc FROM forecast_dayahead WHERE date = ? AND kwh_inc > 0")
      .all(date);
    const slotCapKwh = upperMw * 1000 * 5 / 60;
    let totalKwh = 0;
    let curtailedKwh = 0;
    let affectedSlots = 0;
    for (const r of rows) {
      const kwh = Number(r.kwh_inc || 0);
      totalKwh += kwh;
      if (kwh > slotCapKwh) {
        curtailedKwh += kwh - slotCapKwh;
        affectedSlots++;
      }
    }
    return res.json({
      ok: true,
      date,
      upperMw,
      totalSlots: rows.length,
      affectedSlots,
      totalKwh: Math.round(totalKwh * 1000) / 1000,
      curtailedKwh: Math.round(curtailedKwh * 1000) / 1000,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Plant Cap Schedule CRUD ──────────────────────────────────────────────────

function normalizeScheduleInput(body) {
  const name    = String(body.name || "").trim().slice(0, 60) || "Schedule";
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1;

  const timeRe     = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const start_time = timeRe.test(String(body.start_time || "")) ? body.start_time : null;
  const stop_time  = timeRe.test(String(body.stop_time  || "")) ? body.stop_time  : null;
  if (!start_time || !stop_time) {
    return { error: "start_time and stop_time are required in HH:MM format." };
  }
  if (start_time >= stop_time) {
    return { error: "stop_time must be after start_time. Midnight-spanning schedules are not supported." };
  }

  const upper_mw = (body.upper_mw !== undefined && body.upper_mw !== null)
    ? Number(body.upper_mw) : null;
  const lower_mw = (body.lower_mw !== undefined && body.lower_mw !== null)
    ? Number(body.lower_mw) : null;
  if (upper_mw !== null && (!Number.isFinite(upper_mw) || upper_mw <= 0)) {
    return { error: "upper_mw must be a positive number." };
  }
  if (lower_mw !== null && (!Number.isFinite(lower_mw) || lower_mw < 0)) {
    return { error: "lower_mw must be >= 0." };
  }
  if (upper_mw !== null && lower_mw !== null && lower_mw >= upper_mw) {
    return { error: "lower_mw must be less than upper_mw." };
  }

  const sequence_mode = body.sequence_mode
    ? String(body.sequence_mode).trim() : null;
  let sequence_custom_json = "[]";
  if (Array.isArray(body.sequence_custom)) {
    sequence_custom_json = JSON.stringify(body.sequence_custom.map(Number).filter(Number.isFinite));
  } else if (typeof body.sequence_custom_json === "string") {
    try {
      const parsed = JSON.parse(body.sequence_custom_json);
      if (!Array.isArray(parsed)) return { error: "sequence_custom_json must be a JSON array." };
      sequence_custom_json = JSON.stringify(parsed.map(Number).filter(Number.isFinite));
    } catch (_) {
      return { error: "sequence_custom_json must be valid JSON." };
    }
  }

  const cooldown_sec = (body.cooldown_sec !== undefined && body.cooldown_sec !== null)
    ? Math.max(0, Math.min(3600, Math.trunc(Number(body.cooldown_sec)))) : null;

  return { name, enabled, start_time, stop_time, upper_mw, lower_mw, sequence_mode, sequence_custom_json, cooldown_sec };
}

app.get("/api/plant-cap/schedule-status", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const schedules = plantCapController?.scheduleEngine?.getScheduleStatus() || [];
    const remarks   = plantCapController?.scheduleEngine?.getRemarks(50) || [];
    return res.json({ ok: true, schedules, remarks });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/plant-cap/schedules", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const rows = db.prepare("SELECT * FROM plant_cap_schedules ORDER BY id").all();
    return res.json({ ok: true, schedules: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/plant-cap/schedules", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res.status(403).json({ ok: false, error: "Unauthorized plant cap schedule command" });
  }
  const input = normalizeScheduleInput(req.body || {});
  if (input.error) return res.status(400).json({ ok: false, error: input.error });
  try {
    const result = db.prepare(`
      INSERT INTO plant_cap_schedules
        (name, enabled, start_time, stop_time, upper_mw, lower_mw,
         sequence_mode, sequence_custom_json, cooldown_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name, input.enabled, input.start_time, input.stop_time,
      input.upper_mw, input.lower_mw, input.sequence_mode,
      input.sequence_custom_json, input.cooldown_sec,
    );
    const row = db.prepare("SELECT * FROM plant_cap_schedules WHERE id = ?").get(result.lastInsertRowid);
    if (plantCapController?.scheduleEngine) plantCapController.scheduleEngine._cache = null;
    return res.json({ ok: true, schedule: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/plant-cap/schedules/:id", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const id = Math.trunc(Number(req.params.id));
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, error: "Invalid schedule id" });
    }
    const row = db.prepare("SELECT * FROM plant_cap_schedules WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ ok: false, error: "Schedule not found" });
    return res.json({ ok: true, schedule: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/plant-cap/schedules/:id", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res.status(403).json({ ok: false, error: "Unauthorized plant cap schedule command" });
  }
  const id = Math.trunc(Number(req.params.id));
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, error: "Invalid schedule id" });
  }
  const input = normalizeScheduleInput(req.body || {});
  if (input.error) return res.status(400).json({ ok: false, error: input.error });
  try {
    const existing = db
      .prepare("SELECT id, current_state FROM plant_cap_schedules WHERE id = ?")
      .get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "Schedule not found" });
    if (existing.current_state === "active") {
      return res.status(409).json({ ok: false, error: "Cannot edit an active schedule — disable it first." });
    }
    db.prepare(`
      UPDATE plant_cap_schedules SET
        name = ?, enabled = ?, start_time = ?, stop_time = ?,
        upper_mw = ?, lower_mw = ?, sequence_mode = ?,
        sequence_custom_json = ?, cooldown_sec = ?,
        current_state = 'waiting', updated_ts = ?
      WHERE id = ?
    `).run(
      input.name, input.enabled, input.start_time, input.stop_time,
      input.upper_mw, input.lower_mw, input.sequence_mode,
      input.sequence_custom_json, input.cooldown_sec,
      Date.now(), id,
    );
    const row = db.prepare("SELECT * FROM plant_cap_schedules WHERE id = ?").get(id);
    if (plantCapController?.scheduleEngine) plantCapController.scheduleEngine._cache = null;
    return res.json({ ok: true, schedule: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/plant-cap/schedules/:id", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  const authBody = req.body && typeof req.body === "object" ? req.body : {};
  if (!isAuthorizedPlantWideControl(authBody, req)) {
    return res.status(403).json({ ok: false, error: "Unauthorized plant cap schedule command" });
  }
  const id = Math.trunc(Number(req.params.id));
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, error: "Invalid schedule id" });
  }
  try {
    const existing = db
      .prepare("SELECT id, current_state FROM plant_cap_schedules WHERE id = ?")
      .get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "Schedule not found" });
    if (existing.current_state === "active") {
      return res.status(409).json({ ok: false, error: "Cannot delete an active schedule — disable it first." });
    }
    db.prepare("DELETE FROM plant_cap_schedules WHERE id = ?").run(id);
    if (plantCapController?.scheduleEngine) plantCapController.scheduleEngine._cache = null;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/plant-cap/schedules/:id/toggle", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res.status(403).json({ ok: false, error: "Unauthorized plant cap schedule command" });
  }
  const id = Math.trunc(Number(req.params.id));
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, error: "Invalid schedule id" });
  }
  try {
    const existing = db
      .prepare("SELECT id, enabled, current_state FROM plant_cap_schedules WHERE id = ?")
      .get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "Schedule not found" });
    const newEnabled = existing.enabled ? 0 : 1;
    // If disabling an active schedule, move it to paused; otherwise reset to waiting
    const newState = newEnabled === 0 && existing.current_state === "active"
      ? "paused"
      : (newEnabled === 1 ? "waiting" : existing.current_state);
    db.prepare(
      "UPDATE plant_cap_schedules SET enabled = ?, current_state = ?, safety_pause_reason = ?, updated_ts = ? WHERE id = ?"
    ).run(
      newEnabled,
      newState,
      newEnabled === 0 && existing.current_state === "active" ? "disabled_by_toggle" : null,
      Date.now(),
      id,
    );
    const row = db.prepare("SELECT * FROM plant_cap_schedules WHERE id = ?").get(id);
    if (plantCapController?.scheduleEngine) plantCapController.scheduleEngine._cache = null;
    return res.json({ ok: true, schedule: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* Auth-gated credentials reference — requires authKey=admin */
app.get("/api/credentials-reference", (req, res) => {
  const key = String(req.query.authKey || "").trim();
  if (key !== "admin") {
    return res.status(403).json({ ok: false, error: "Invalid authorization key." });
  }
  const filePath = path.join(__dirname, "../public/credentials-reference.html");
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(500).json({ ok: false, error: "File not found." });
  });
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

// ───── Substation Meter Endpoints (E2a-c) ─────

function requireSubstationAuth(req, res, next) {
  const key = String(req.headers["x-substation-key"] || "").trim().toLowerCase();
  if (!key) return res.status(401).json({ ok: false, error: "Authorization required." });
  const m = new Date().getMinutes();
  const valid = [`adsi${m}`, `adsi${String(m).padStart(2, "0")}`];
  // Allow ±1 minute tolerance for clock skew
  const mPrev = (m + 59) % 60;
  valid.push(`adsi${mPrev}`, `adsi${String(mPrev).padStart(2, "0")}`);
  if (!valid.includes(key)) return res.status(403).json({ ok: false, error: "Invalid authorization key." });
  next();
}

const SUBSTATION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUBSTATION_MAX_MWH = 5.0; // plant max ~20 MW × 0.25h
const SUBSTATION_MAX_ROWS = 96; // 24h ÷ 15min
const SUBSTATION_15MIN_MS = 15 * 60 * 1000;

function validateSubstationDate(dateStr) {
  if (!SUBSTATION_DATE_RE.test(dateStr)) return "Invalid date format (YYYY-MM-DD required).";
  const d = new Date(dateStr + "T00:00:00+08:00");
  if (isNaN(d.getTime())) return "Invalid date.";
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (dateStr > todayStr) return "Future dates not allowed.";
  return null;
}

function validateSubstationReadings(readings) {
  if (!Array.isArray(readings)) return "readings must be an array.";
  if (readings.length === 0) return "readings array is empty.";
  if (readings.length > SUBSTATION_MAX_ROWS) return `Too many readings (max ${SUBSTATION_MAX_ROWS}).`;
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    if (typeof r.ts !== "number" || !Number.isFinite(r.ts) || r.ts <= 0)
      return `readings[${i}].ts must be a positive epoch-ms number.`;
    if (r.ts % (SUBSTATION_15MIN_MS) !== 0)
      return `readings[${i}].ts must align to 15-min boundary.`;
    if (typeof r.mwh !== "number" || !Number.isFinite(r.mwh))
      return `readings[${i}].mwh must be a finite number.`;
    if (r.mwh < 0 || r.mwh > SUBSTATION_MAX_MWH)
      return `readings[${i}].mwh out of range (0-${SUBSTATION_MAX_MWH}).`;
  }
  return null;
}

// GET /api/substation-meter/:date — retrieve readings for a date
app.get("/api/substation-meter/:date", (req, res) => {
  // In remote mode the gateway is the authoritative store — never read from the local DB.
  if (isRemoteMode()) return proxyToRemote(req, res);
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });
  try {
    const rows = db.prepare(
      "SELECT date, ts, mwh, entered_by, entered_at, updated_by, updated_at FROM substation_metered_energy WHERE date = ? ORDER BY ts"
    ).all(dateStr);
    const daily = db.prepare(
      "SELECT * FROM substation_meter_daily WHERE date = ?"
    ).bind(dateStr).get() || null;
    res.json({ ok: true, date: dateStr, readings: rows, daily });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/substation-meter/:date — upsert 15-min readings
app.post("/api/substation-meter/:date", async (req, res) => {
  // In remote mode, write exclusively to the gateway — never touch the local proxy DB.
  if (isRemoteMode()) return proxyToRemote(req, res);
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });
  const { readings, daily } = req.body || {};
  const readingsErr = validateSubstationReadings(readings);
  if (readingsErr) return res.status(400).json({ ok: false, error: readingsErr });
  try {
    const now = Date.now();
    const upsert = db.prepare(`
      INSERT INTO substation_metered_energy (date, ts, mwh, entered_by, entered_at)
      VALUES (?, ?, ?, 'admin', ?)
      ON CONFLICT(date, ts) DO UPDATE SET
        mwh = excluded.mwh,
        updated_by = 'admin',
        updated_at = ?
    `);
    const tx = db.transaction(() => {
      for (const r of readings) {
        upsert.run(dateStr, r.ts, r.mwh, now, now);
      }
      // Upsert daily metadata if provided
      if (daily && typeof daily === "object") {
        // Sanitize time fields — only allow digits + 'H' pattern (e.g. "0538H")
        const timeRe = /^\d{3,4}H$/i;
        const safeSyncTime = (typeof daily.sync_time === "string" && timeRe.test(daily.sync_time.trim())) ? daily.sync_time.trim() : null;
        const safeDesyncTime = (typeof daily.desync_time === "string" && timeRe.test(daily.desync_time.trim())) ? daily.desync_time.trim() : null;
        db.prepare(`
          INSERT INTO substation_meter_daily (date, sync_time, desync_time, total_gen_mwhr, net_kwh, deviation_pct, entered_by, entered_at)
          VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)
          ON CONFLICT(date) DO UPDATE SET
            sync_time = excluded.sync_time,
            desync_time = excluded.desync_time,
            total_gen_mwhr = excluded.total_gen_mwhr,
            net_kwh = excluded.net_kwh,
            deviation_pct = excluded.deviation_pct
        `).run(
          dateStr,
          safeSyncTime,
          safeDesyncTime,
          typeof daily.total_gen_mwhr === "number" ? daily.total_gen_mwhr : null,
          typeof daily.net_kwh === "number" ? daily.net_kwh : null,
          typeof daily.deviation_pct === "number" ? daily.deviation_pct : null,
          now
        );
      }
    });
    tx();
    // Directional cross-check: Net meter (downstream) must be ≤ Σ 15-min
    // sub-meter. A Net value greater than the sum is a topology violation.
    const totalMwh = readings.reduce((s, r) => s + r.mwh, 0);
    const totalKwh = totalMwh * 1000;
    let deviationWarning = null;
    if (daily?.net_kwh && daily.net_kwh > 0 && totalKwh > 0 && daily.net_kwh > totalKwh) {
      const devPct = ((daily.net_kwh - totalKwh) / totalKwh) * 100;
      deviationWarning = `Net meter (${daily.net_kwh.toLocaleString()} kWh) exceeds Σ 15-min sub-meter (${totalKwh.toFixed(0)} kWh) by ${devPct.toFixed(2)}% — Net should be ≤ Σ (downstream meter).`;
    }
    // Remote mode is short-circuited above to proxy straight to the gateway,
    // so this path only runs in local/gateway mode.
    res.json({
      ok: true, date: dateStr, rowsUpserted: readings.length,
      totalMwh: Number(totalMwh.toFixed(6)),
      deviationWarning,
    });
    // Auto-trigger debounced QA recalculation
    _triggerSubstationRecalc(dateStr);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/substation-meter/:date/upload-xlsx — parse SCADA xlsx and return preview
app.post("/api/substation-meter/:date/upload-xlsx", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });
  try {
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.body);

    // Find the 69kV sheet or fallback to first sheet with datetime data
    let ws = wb.getWorksheet("69kV") || wb.getWorksheet("69KV");
    if (!ws) {
      for (const sheet of wb.worksheets) {
        const cellA2 = sheet.getCell("A2").value;
        if (cellA2 instanceof Date || (typeof cellA2 === "string" && /\d{4}/.test(cellA2))) {
          ws = sheet;
          break;
        }
      }
    }
    if (!ws) return res.status(400).json({ ok: false, error: "No valid sheet found (expected '69kV')." });

    const readings = [];
    // Net (kWh) is read from the file's summary row as a downstream-meter
    // sanity value. Topology: Inverter → Substation Meter (15-min interval,
    // column K — source of truth for readings) → Net Meter (daily total only,
    // no interval data). Because the Net meter sits downstream, its daily
    // total MUST be ≤ Σ of the 15-min sub-meter readings. A Net value that
    // exceeds the computed sum is a directional violation (mis-typed Net,
    // corrupted interval log, or meter fault) and raises a warning.
    let syncTime = null, desyncTime = null, netKwh = null, summaryMwhr = null;
    let fileDate = null; // date detected from file's datetime column

    const pad2 = (n) => String(n).padStart(2, "0");
    // ExcelJS stores formula results on the cell itself. Shared-formula child cells
    // have `{sharedFormula:"P9"}` as their `.value` with no inline result, but the
    // computed value is still available via `cell.result`. Prefer that accessor,
    // and fall back to the plain value for non-formula cells.
    const cellNumeric = (cell) => {
      if (cell === null || cell === undefined) return NaN;
      // Raw primitive (when caller passes .value directly)
      if (typeof cell === "number") return cell;
      if (typeof cell === "string") return parseFloat(cell);
      // Formula cell — cell.result is the cached computed value
      if (typeof cell.result === "number") return cell.result;
      const v = cell.value;
      if (v === null || v === undefined) return NaN;
      if (typeof v === "number") return v;
      if (typeof v === "object") {
        if (typeof v.result === "number") return v.result;
        if ("result" in v) return parseFloat(v.result);
      }
      return parseFloat(v);
    };

    ws.eachRow((row, rowNum) => {
      if (rowNum <= 1) return; // skip header
      const cellA = row.getCell(1).value; // column A — datetime
      const cellK = row.getCell(11);       // column K — MW instantaneous (source of truth)
      const cellF = row.getCell(6).value;  // column F — Sync Time
      const cellH = row.getCell(8).value;  // column H — Desync Time

      // Parse datetime from column A
      let dt = null;
      if (cellA instanceof Date) {
        dt = cellA;
      } else if (typeof cellA === "string") {
        const parsed = new Date(cellA);
        if (!isNaN(parsed.getTime())) dt = parsed;
      } else if (typeof cellA === "number") {
        // Excel serial date
        const d = new Date(Math.round((cellA - 25569) * 86400 * 1000));
        if (!isNaN(d.getTime())) dt = d;
      }

      // Derive MW-hr from column K (instantaneous MW) for a 15-min interval,
      // clamping pre-sunrise / night-time negative readings to zero. This matches
      // the workbook's own formula in column P (=IF(K<0, 0, K/4)) but avoids
      // depending on whether Excel cached the formula result.
      const mwInstant = cellNumeric(cellK);
      const mwh = Number.isFinite(mwInstant) ? Math.max(mwInstant, 0) / 4 : NaN;

      if (dt && Number.isFinite(mwh) && mwh >= 0) {
        // ExcelJS parses Excel datetime cells as UTC regardless of timezone intent,
        // so the wall-clock digits the operator typed ("05:45") live in the UTC getters.
        // We treat those digits as local PHT time (UTC+8).
        const yy = dt.getUTCFullYear();
        const mm = dt.getUTCMonth();
        const dd = dt.getUTCDate();
        const hh = dt.getUTCHours();
        const mi = dt.getUTCMinutes();
        if (!fileDate) {
          fileDate = `${yy}-${pad2(mm + 1)}-${pad2(dd)}`;
        }
        // Build a real epoch ms assuming PHT (+08:00): local = UTC+8 → UTC = local-8.
        const phtEpochMs = Date.UTC(yy, mm, dd, hh, mi) - 8 * 3600 * 1000;
        const aligned = Math.round(phtEpochMs / SUBSTATION_15MIN_MS) * SUBSTATION_15MIN_MS;
        const localTime = `${yy}-${pad2(mm + 1)}-${pad2(dd)} ${pad2(hh)}:${pad2(mi)}`;
        readings.push({ ts: aligned, mwh: Number(mwh.toFixed(6)), time: localTime });
      } else if (!dt) {
        // Summary row — check for totals and metadata
        if (Number.isFinite(mwh) && mwh > 0 && !summaryMwhr) {
          summaryMwhr = mwh;
        }
        const kVal = cellNumeric(cellK);
        if (Number.isFinite(kVal) && kVal > 100 && !netKwh) {
          netKwh = kVal;
        }
        const fVal = String(cellF || "").trim();
        if (/^\d{3,4}H$/i.test(fVal) && !syncTime) syncTime = fVal;
        const hVal = String(cellH || "").trim();
        if (/^\d{3,4}H$/i.test(hVal) && !desyncTime) desyncTime = hVal;
      }
    });

    if (readings.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid MW-hr readings found in the file." });
    }

    // Sort by timestamp
    readings.sort((a, b) => a.ts - b.ts);

    const totalMwh = readings.reduce((s, r) => s + r.mwh, 0);
    const totalKwh = totalMwh * 1000;
    // Directional check: Net meter is downstream of the 15-min sub-meter,
    // so Net kWh must be ≤ Σ (15-min) kWh. Deviation is reported as a signed
    // percentage (negative = Net < Σ, expected; positive = Net > Σ, violation).
    let deviationPct = null;
    let directionalViolation = false;
    if (netKwh && netKwh > 0 && totalKwh > 0) {
      deviationPct = Number(((netKwh - totalKwh) / totalKwh * 100).toFixed(2));
      directionalViolation = netKwh > totalKwh;
    }

    const dateMismatch = fileDate && fileDate !== dateStr;
    res.json({
      ok: true,
      date: fileDate || dateStr,   // always report the file's actual date
      fileDate: fileDate || dateStr,
      requestedDate: dateStr,
      dateMismatch: dateMismatch || false,
      readings,
      daily: {
        sync_time: syncTime,
        desync_time: desyncTime,
        total_gen_mwhr: Number(totalMwh.toFixed(6)),
        net_kwh: netKwh,
        deviation_pct: deviationPct,
      },
      summary: {
        rowCount: readings.length,
        totalMwh: Number(totalMwh.toFixed(6)),
        summaryMwhr: summaryMwhr ? Number(summaryMwhr.toFixed(6)) : null,
        netKwh,
        deviationPct,
        directionalViolation,
        deviationWarning: directionalViolation
          ? `Net meter (${netKwh.toLocaleString()} kWh) exceeds Σ 15-min sub-meter (${totalKwh.toFixed(0)} kWh) by ${deviationPct.toFixed(2)}% — Net should be ≤ Σ (downstream meter). Check for mis-typed Net or incomplete interval log.`
          : null,
      },
    });
  } catch (e) {
    console.error("[substation-meter] xlsx parse error:", e.message);
    res.status(400).json({ ok: false, error: `Failed to parse xlsx: ${e.message}` });
  }
});

// Substation meter QA recalculation — debounce + lock
const _substationRecalcTimers = new Map(); // date -> timer
const _substationRecalcLocks = new Set();  // dates currently being recalculated
const _SUBSTATION_MAX_PENDING = 50;        // max concurrent debounce dates
function _triggerSubstationRecalc(dateStr) {
  if (_substationRecalcLocks.has(dateStr)) return false;
  if (_substationRecalcTimers.has(dateStr)) {
    clearTimeout(_substationRecalcTimers.get(dateStr));
  }
  // Evict oldest pending date if at capacity
  if (_substationRecalcTimers.size >= _SUBSTATION_MAX_PENDING && !_substationRecalcTimers.has(dateStr)) {
    const oldest = _substationRecalcTimers.keys().next().value;
    clearTimeout(_substationRecalcTimers.get(oldest));
    _substationRecalcTimers.delete(oldest);
  }
  const timer = setTimeout(async () => {
    _substationRecalcTimers.delete(dateStr);
    if (_substationRecalcLocks.has(dateStr)) return;
    _substationRecalcLocks.add(dateStr);
    try {
      console.log(`[substation-meter] Recalculating QA for ${dateStr}...`);
      const result = await runForecastGenerator(["--qa-date", dateStr]);
      console.log(`[substation-meter] QA recalculate done for ${dateStr} (${result?.durationMs || 0}ms)`);
      broadcastUpdate({ type: "substation_recalc_done", date: dateStr, ok: true });
    } catch (e) {
      console.error(`[substation-meter] QA recalculate failed for ${dateStr}:`, e.message);
      broadcastUpdate({ type: "substation_recalc_done", date: dateStr, ok: false, error: e.message });
    } finally {
      _substationRecalcLocks.delete(dateStr);
    }
  }, 5000);
  _substationRecalcTimers.set(dateStr, timer);
  return true;
}

// POST /api/substation-meter/:date/recalculate — explicit re-run QA for a date
app.post("/api/substation-meter/:date/recalculate", (req, res) => {
  // Remote proxies have no local substation data — defer QA recalc to the gateway.
  if (isRemoteMode()) return proxyToRemote(req, res);
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });

  if (_substationRecalcLocks.has(dateStr)) {
    return res.status(409).json({ ok: false, error: "Recalculation already in progress for this date." });
  }

  _triggerSubstationRecalc(dateStr);
  res.status(202).json({ ok: true, message: `QA recalculation for ${dateStr} scheduled (5s debounce).` });
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
    solcastToolkitDays,
    solcastToolkitPeriod,
    solcastTimezone,
    exportUiState,
    inverterPollConfig,
    plantLatitude,
    plantLongitude,
    forecastExportLimitMw,
    plantCapUpperMw,
    plantCapLowerMw,
    plantCapSequenceMode,
    plantCapSequenceCustom,
    plantCapCooldownSec,
    go2rtcAutoStart,
    cameraConfig,
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
          error: `Invalid Plant Resource ID: ${err.message}`,
        });
      }
    }
    updates.solcastToolkitSiteRef = ref.slice(0, 500);
  }
  if (solcastToolkitDays !== undefined) {
    const d = Math.max(1, Math.min(SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS, Math.trunc(Number(solcastToolkitDays) || 2)));
    updates.solcastToolkitDays = String(d);
  }
  if (solcastToolkitPeriod !== undefined) {
    const p = String(solcastToolkitPeriod || "PT5M").trim();
    updates.solcastToolkitPeriod = SOLCAST_PREVIEW_RESOLUTIONS.has(p) ? p : SOLCAST_TOOLKIT_PERIOD;
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
  if (forecastExportLimitMw !== undefined) {
    const limit = Number(forecastExportLimitMw);
    if (!Number.isFinite(limit) || limit <= 0) {
      return res.status(400).json({
        ok: false,
        error: "forecastExportLimitMw must be greater than 0",
      });
    }
    updates.forecastExportLimitMw = String(limit);
  }
  if (plantCapUpperMw !== undefined) {
    const rawUpper = String(plantCapUpperMw ?? "").trim();
    if (!rawUpper) {
      updates.plantCapUpperMw = "";
    } else {
      const upper = Number(rawUpper);
      if (!Number.isFinite(upper) || upper <= 0) {
        return res.status(400).json({
          ok: false,
          error: "plantCapUpperMw must be greater than 0",
        });
      }
      updates.plantCapUpperMw = String(upper);
    }
  }
  if (plantCapLowerMw !== undefined) {
    const rawLower = String(plantCapLowerMw ?? "").trim();
    if (!rawLower) {
      updates.plantCapLowerMw = "";
    } else {
      const lower = Number(rawLower);
      if (!Number.isFinite(lower) || lower < 0) {
        return res.status(400).json({
          ok: false,
          error: "plantCapLowerMw must be 0 or higher",
        });
      }
      updates.plantCapLowerMw = String(lower);
    }
  }
  if (plantCapSequenceMode !== undefined) {
    updates.plantCapSequenceMode = normalizePlantCapSequenceMode(
      plantCapSequenceMode,
    );
  }
  if (plantCapSequenceCustom !== undefined) {
    updates.plantCapSequenceCustomJson = JSON.stringify(
      normalizePlantCapSequenceCustom(
        plantCapSequenceCustom,
        clampInt(
          inverterCount !== undefined
            ? inverterCount
            : getSetting("inverterCount", 27),
          1,
          200,
          27,
        ),
      ),
    );
  }
  if (plantCapCooldownSec !== undefined) {
    updates.plantCapCooldownSec = String(
      clampInt(plantCapCooldownSec, 5, 600, 30),
    );
  }
  if (
    updates.plantCapUpperMw !== undefined ||
    updates.plantCapLowerMw !== undefined
  ) {
    const upperValue = String(
      updates.plantCapUpperMw !== undefined
        ? updates.plantCapUpperMw
        : getSetting("plantCapUpperMw", ""),
    ).trim();
    const lowerValue = String(
      updates.plantCapLowerMw !== undefined
        ? updates.plantCapLowerMw
        : getSetting("plantCapLowerMw", ""),
    ).trim();
    if (upperValue && lowerValue) {
      const upper = Number(upperValue);
      const lower = Number(lowerValue);
      if (Number.isFinite(upper) && Number.isFinite(lower) && !(lower < upper)) {
        return res.status(400).json({
          ok: false,
          error: "plantCapLowerMw must be less than plantCapUpperMw",
        });
      }
    }
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

  if (go2rtcAutoStart !== undefined) {
    updates.go2rtcAutoStart = go2rtcAutoStart === "1" || go2rtcAutoStart === true ? "1" : "0";
  }
  if (cameraConfig !== undefined) {
    updates.cameraConfig = JSON.stringify(sanitizeCameraConfig(cameraConfig));
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
  let retentionScheduled = false;
  if (updates.retainDays !== undefined) {
    const retainDaysAfter = Math.max(1, Number(updates.retainDays || retainDaysBefore));
    if (retainDaysAfter !== retainDaysBefore) {
      retentionScheduled = true;
      // Fire-and-forget: pruneOldData is async and yields between batches to avoid
      // blocking the event loop. Don't await it — respond to the client immediately.
      pruneOldData({ vacuum: retainDaysAfter < retainDaysBefore }).catch((err) => {
        console.error("[settings] background pruneOldData failed:", err.message);
      });
    }
  }
  const snapshot = buildSettingsSnapshot();
  res.json({
    ok: true,
    csvSavePath: exportDirResolved || getSetting("csvSavePath", "C:\\Logs\\InverterDashboard"),
    exportDirCreated,
    settings: snapshot,
    retentionApplied: retentionScheduled ? { ok: true, scheduled: true } : null,
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
    remoteLivePausedForTransfer: Boolean(remoteBridgeState.livePauseActive),
    remoteLivePauseReason: String(remoteBridgeState.livePauseReason || ""),
    remoteLivePauseSince: Number(remoteBridgeState.livePauseSince || 0),
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

app.get("/api/runtime/data-health", (req, res) => {
  const todayEnergy =
    typeof poller.getTodayEnergyHealth === "function"
      ? poller.getTodayEnergyHealth()
      : {};
  const pollerStats =
    typeof poller.getPerfStats === "function"
      ? poller.getPerfStats()
      : {};
  res.json({
    ok: true,
    operationMode: isRemoteMode() ? "remote" : "gateway",
    todayEnergy,
    poller: {
      running: Boolean(pollerStats?.running),
      lastPollStartedTs: Number(pollerStats?.lastPollStartedTs || 0),
      lastPollEndedTs: Number(pollerStats?.lastPollEndedTs || 0),
      lastDbPersistOkTs: Number(pollerStats?.lastDbPersistOkTs || 0),
      fetchOkCount: Number(pollerStats?.fetchOkCount || 0),
      fetchErrorCount: Number(pollerStats?.fetchErrorCount || 0),
      lastFetchError: String(pollerStats?.lastFetchError || ""),
    },
  });
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
  // Viewer model: all proxied reads go through gateway — no local fallback.
  return proxyToRemote(req, res);
});

app.get("/api/alarms/active", (req, res) => {
  const rows = getActiveAlarms();
  const nowTs = Date.now();
  res.json(rows.map((r) => enrichAlarmRow(r, nowTs)));
});
// Static reference metadata for the alarm-drilldown UI — per-bit service
// references, TrinPM modules, schematic pages, and GitHub raw URLs for the
// matching Ingeteam docs. Served once at UI load, cached client-side.
app.get("/api/alarms/reference", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    bits: ALARM_BITS,
    stopReasonSubcodes: STOP_REASON_SUBCODES,
    fatalValue: FATAL_ALARM_VALUE,
    serviceDocs: SERVICE_DOCS,
    githubBase: SERVICE_DOCS_GITHUB_BASE,
    fleetDocId: "AAV2015IQE01_B",
  });
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
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
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
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
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
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
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

app.get("/api/analytics/solcast-est-actual", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const date = String(req.query?.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: "invalid date" });
  }
  try {
    const rows = stmts.getSolcastSnapshotDay.all(date);
    const { startTs, endTs } = getForecastSolarWindowBounds(date);
    // Solcast estimated_actuals are PT5M records — each snapshot slot stores the
    // correct 5-min energy in est_actual_kwh (mw * 5/60 * 1000). Sum kWh then
    // convert to MWh, matching Forecast section's buildSolcastPreviewDaySeries().
    let totalKwh = 0;
    let slots = 0;
    let hasEstActualData = false;
    for (const r of rows) {
      const ts = Number(r?.ts_local || 0);
      if (!ts || ts < startTs || ts >= endTs) continue;
      if (r?.est_actual_mw == null) continue; // no est_actual data for this slot
      hasEstActualData = true;
      const v = Number(r.est_actual_kwh);
      if (!Number.isFinite(v) || v < 0) continue;
      totalKwh += v;
      slots += 1;
    }

    // Trigger lazy backfill if no rows or no est_actual data found
    if (!rows || rows.length === 0 || !hasEstActualData) {
      lazyBackfillSolcastSnapshotIfMissing(date);
    }

    return res.json({
      ok: true,
      date,
      totalMwh: Number((totalKwh / 1000).toFixed(6)),
      slots,
      hasData: slots > 0,
    });
  } catch (err) {
    console.error("[solcast-est-actual] read failed:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Day-ahead vs reality chart (v2.8+) ───────────────────────────────────
// Returns 4 aligned series for the analytics panel:
//   1. locked.*            — frozen 10 AM day-ahead P10/P50/P90 (immutable)
//   2. intraday_solcast.*  — Solcast's own estimated actual (overwrite semantics)
//   3. plant_actual.*      — plant-wide PAC-based actual MW per 5-min slot
//   4. ml_final.*          — dashboard's ML final forecast (intraday-adjusted)
app.get("/api/analytics/dayahead-chart", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const date = String(req.query?.date || localDateStr()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: "invalid date" });
  }
  try {
    // 1. Locked day-ahead snapshot + meta
    const lockedRows = getDayAheadLockedForDay(date);
    const lockedMeta = getDayAheadLockedMetaForDay(date);
    const locked = {
      captured_ts: Number(lockedMeta?.captured_ts || 0) || null,
      captured_local: lockedMeta?.captured_local || null,
      capture_reason: lockedMeta?.capture_reason || null,
      solcast_source: lockedMeta?.solcast_source || null,
      plant_cap_mw:
        lockedMeta?.plant_cap_mw != null ? Number(lockedMeta.plant_cap_mw) : null,
      spread_pct_cap_avg:
        lockedMeta?.spread_pct_cap_avg != null
          ? Number(lockedMeta.spread_pct_cap_avg)
          : null,
      spread_pct_cap_max:
        lockedMeta?.spread_pct_cap_max != null
          ? Number(lockedMeta.spread_pct_cap_max)
          : null,
      total_p50_kwh:
        lockedMeta?.total_p50_kwh != null ? Number(lockedMeta.total_p50_kwh) : null,
      total_p10_kwh:
        lockedMeta?.total_p10_kwh != null ? Number(lockedMeta.total_p10_kwh) : null,
      total_p90_kwh:
        lockedMeta?.total_p90_kwh != null ? Number(lockedMeta.total_p90_kwh) : null,
      rows: lockedRows.map((r) => ({
        slot: Number(r.slot),
        ts_local: Number(r.ts_local || 0),
        p50_mw: r.p50_mw != null ? Number(r.p50_mw) : null,
        p10_mw: r.p10_mw != null ? Number(r.p10_mw) : null,
        p90_mw: r.p90_mw != null ? Number(r.p90_mw) : null,
      })),
    };

    // 2. Intraday Solcast est_actual from solcast_snapshots (latest overwrite state)
    let intradaySolcastRows = [];
    try {
      const snapRows = stmts.getSolcastSnapshotDay.all(date);
      intradaySolcastRows = snapRows
        .filter((r) => r?.est_actual_mw != null)
        .map((r) => ({
          slot: Number(r.slot),
          ts_local: Number(r.ts_local || 0),
          est_actual_mw: Number(r.est_actual_mw),
        }));
    } catch (e) {
      console.warn(`[dayahead-chart] intraday_solcast read failed for ${date}:`, e.message);
    }

    // 3. Plant actual MW per 5-min slot — sum kwh_inc across all inverters, then
    //    convert to average MW over the slot ((kwh / (5/60)) / 1000).
    let plantActualRows = [];
    try {
      const solarWindow = getForecastSolarWindowBounds(date);
      if (Number.isFinite(solarWindow.startTs) && Number.isFinite(solarWindow.endTs)) {
        const energyRows = queryEnergy5minRangeAll(solarWindow.startTs, solarWindow.endTs);
        const bySlotTs = new Map();
        for (const r of energyRows) {
          const ts = Number(r?.ts || 0);
          if (!ts) continue;
          const kwh = Number(r?.kwh_inc || 0);
          bySlotTs.set(ts, Number(bySlotTs.get(ts) || 0) + kwh);
        }
        // Convert ts → slot (0..287). slot = ((ts - dayStartTs) / 300000) where
        // dayStartTs is midnight local for `date`.
        const midnightTs = new Date(`${date}T00:00:00`).getTime();
        plantActualRows = Array.from(bySlotTs.entries())
          .map(([ts, kwh]) => {
            const slot = Math.round((ts - midnightTs) / (5 * 60 * 1000));
            // Average MW over the 5-min slot
            const mw = (kwh / (5 / 60)) / 1000;
            return { slot, ts_local: ts, actual_mw: Number(mw.toFixed(4)), actual_kwh: Number(kwh.toFixed(4)) };
          })
          .filter((r) => r.slot >= 0 && r.slot < 288)
          .sort((a, b) => a.slot - b.slot);
      }
    } catch (e) {
      console.warn(`[dayahead-chart] plant_actual read failed for ${date}:`, e.message);
    }

    // 4. ML final = intraday-adjusted forecast (primary) with day-ahead fallback
    //    Converted from kwh_inc (per 5-min slot) back to MW via (kwh / (5/60) / 1000).
    let mlFinalRows = [];
    try {
      let srcRows = getIntradayAdjustedRowsForDate(date);
      if (!srcRows || srcRows.length === 0) {
        srcRows = getDayAheadRowsForDate(date);
      }
      const midnightTs = new Date(`${date}T00:00:00`).getTime();
      mlFinalRows = (srcRows || []).map((r) => {
        const ts = Number(r.ts || 0);
        const slot = Math.round((ts - midnightTs) / (5 * 60 * 1000));
        const kwh = Number(r.kwh_inc || 0);
        const mw = (kwh / (5 / 60)) / 1000;
        return {
          slot,
          ts_local: ts,
          ml_mw: Number(mw.toFixed(4)),
        };
      }).filter((r) => r.slot >= 0 && r.slot < 288);
    } catch (e) {
      console.warn(`[dayahead-chart] ml_final read failed for ${date}:`, e.message);
    }

    // Meta: actuals-so-far total + variance + within-band tracking
    const actualTotalKwhSoFar = plantActualRows.reduce(
      (a, r) => a + Number(r.actual_kwh || 0),
      0,
    );
    const p50TotalKwh = Number(locked.total_p50_kwh || 0);
    const varianceVsP50Pct =
      p50TotalKwh > 0
        ? ((actualTotalKwhSoFar - p50TotalKwh) / p50TotalKwh) * 100
        : null;

    // actual_within_band: among plant_actual slots that have matching locked rows,
    // what fraction lies between the corresponding P10 and P90?
    let inBand = 0;
    let bandChecked = 0;
    if (locked.rows.length > 0 && plantActualRows.length > 0) {
      const lockedBySlot = new Map();
      for (const lr of locked.rows) {
        if (lr.p10_mw != null && lr.p90_mw != null) {
          lockedBySlot.set(lr.slot, { p10: lr.p10_mw, p90: lr.p90_mw });
        }
      }
      for (const ar of plantActualRows) {
        const band = lockedBySlot.get(ar.slot);
        if (band) {
          bandChecked += 1;
          if (ar.actual_mw >= band.p10 && ar.actual_mw <= band.p90) {
            inBand += 1;
          }
        }
      }
    }
    const actualWithinBandSoFarPct =
      bandChecked > 0 ? (inBand / bandChecked) * 100 : null;

    return res.json({
      ok: true,
      date,
      locked,
      intraday_solcast: { rows: intradaySolcastRows },
      plant_actual: { rows: plantActualRows },
      ml_final: { rows: mlFinalRows },
      meta: {
        plant_cap_mw: locked.plant_cap_mw,
        actual_total_mwh_so_far: Number((actualTotalKwhSoFar / 1000).toFixed(4)),
        p50_total_mwh: p50TotalKwh > 0 ? Number((p50TotalKwh / 1000).toFixed(4)) : null,
        p10_total_mwh:
          Number(locked.total_p10_kwh || 0) > 0
            ? Number((Number(locked.total_p10_kwh) / 1000).toFixed(4))
            : null,
        p90_total_mwh:
          Number(locked.total_p90_kwh || 0) > 0
            ? Number((Number(locked.total_p90_kwh) / 1000).toFixed(4))
            : null,
        variance_vs_p50_pct:
          varianceVsP50Pct != null ? Number(varianceVsP50Pct.toFixed(2)) : null,
        actual_within_band_so_far_pct:
          actualWithinBandSoFarPct != null
            ? Number(actualWithinBandSoFarPct.toFixed(1))
            : null,
        band_checked_slots: bandChecked,
      },
    });
  } catch (err) {
    console.error("[dayahead-chart] failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "unknown" });
  }
});

// ── Manual day-ahead lock capture (v2.8+) ────────────────────────────────
// POST /api/analytics/dayahead-lock-capture?date=YYYY-MM-DD
// Allows manual capture for any date (defaults to tomorrow).
app.post("/api/analytics/dayahead-lock-capture", async (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  const targetDate = String(req.query?.date || addDaysIso(localDateStr(), 1)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ ok: false, error: "invalid date" });
  }
  try {
    // Pre-fetch Solcast data
    try {
      await autoFetchSolcastSnapshots([targetDate], {
        toolkitHours: SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS,
      });
    } catch (fetchErr) {
      console.warn(`[manual-dayahead-lock] Solcast fetch failed: ${fetchErr.message}`);
    }
    const plantCapKw = computePlantMaxKwFromConfig();
    const plantCapMw = Number.isFinite(plantCapKw) ? plantCapKw / 1000 : null;
    const result = await captureDayAheadSnapshot(targetDate, "manual", { plantCapMw });
    console.log(`[manual-dayahead-lock] ${targetDate}: ${JSON.stringify(result)}`);
    return res.json(result);
  } catch (err) {
    console.error("[manual-dayahead-lock] failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "unknown" });
  }
});

app.get("/api/weather/weekly", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const day = parseIsoDateStrict(req.query?.date || localDateStr(), "date");
    const rows = await getWeeklyWeather(day);
    return res.json({ ok: true, date: day, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/weather/hourly-today", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const data = await fetchHourlyWeatherToday();
    return res.json({ ok: true, ...data });
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
          error: "Plant Resource ID is required for Toolkit mode.",
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
    const snapshotResults = buildAndPersistSolcastSnapshotAllDays(
      records,
      estActuals || [],
      cfg,
      accessMode,
      started,
    );
    const tomorrowSnap = snapshotResults[tomorrowTz] || {};

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
      snapshotOk: !!tomorrowSnap?.ok,
      snapshotRowsPersisted: Number(tomorrowSnap?.persistedRows || 0),
      snapshotWarning: String(tomorrowSnap?.warning || ""),
      snapshotDaysPersisted: Object.keys(snapshotResults).sort(),
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
          error: "Plant Resource ID is required for Toolkit mode.",
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
      toolkitHours: computeSolcastPreviewHoursForRequest(
        requestedDay,
        requestedDayCount,
        cfg,
        SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS,
      ),
    });
    const preview = buildSolcastPreviewSeries(
      requestedDay || localDateStrInTz(Date.now(), cfg.timeZone),
      requestedDayCount,
      records,
      estActuals || [],
      cfg,
      SOLCAST_TOOLKIT_PERIOD,
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
      sourcePeriod: preview.sourcePeriod,
      displayPeriod: preview.displayPeriod,
      bucketMinutes: preview.bucketMinutes,
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
        return res.status(400).json({ ok: false, error: "Plant Resource ID is required for Toolkit mode." });
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
    const requestedResolution = normalizeSolcastPreviewResolution(
      req.body?.resolution || SOLCAST_TOOLKIT_PERIOD,
    );
    const { records, estActuals } = await fetchSolcastForecastRecords(cfg, {
      toolkitHours: computeSolcastPreviewHoursForRequest(
        requestedDay,
        requestedDayCount,
        cfg,
        SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS,
      ),
    });
    const preview = buildSolcastPreviewSeries(
      requestedDay || localDateStrInTz(Date.now(), cfg.timeZone),
      requestedDayCount,
      records,
      estActuals || [],
      cfg,
      requestedResolution,
    );
    const rawOutPath = await runGatewayExportJob("solcast-preview", () =>
      exporter.exportSolcastPreview({
        rawRows: preview.rawRows,
        rows: preview.rows,
        startDay: preview.rangeStartDay,
        endDay: preview.rangeEndDay,
        resolution: preview.displayPeriod,
        exportFormat: req.body?.exportFormat,
        format: "xlsx",
      }),
    );
    const outPath = await exporter.ensureForecastExportSubfolder(rawOutPath, "Solcast/Preview");
    return res.json(buildExportResult(outPath, {
      day: preview.day,
      dayCount: preview.dayCount,
      rangeStartDay: preview.rangeStartDay,
      rangeEndDay: preview.rangeEndDay,
    }));
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});

app.get("/api/solcast/snapshot-dates", (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT forecast_day FROM solcast_snapshots ORDER BY forecast_day DESC`
    ).all();
    return res.json({ ok: true, dates: rows.map((r) => r.forecast_day) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/analytics/forecast-dates", (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT date FROM forecast_dayahead ORDER BY date DESC`
    ).all();
    return res.json({ ok: true, dates: rows.map((r) => r.date) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/solcast/week-ahead", (req, res) => {
  try {
    const tz = getSolcastConfig()?.timeZone || "Asia/Manila";
    const baseDate = localDateStrInTz(Date.now(), tz);
    const days = querySolcastWeekAheadDays(baseDate);
    return res.json({ ok: true, baseDate, generatedAt: Date.now(), days });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// v2.8.10 Phase F: refresh every data pipeline that feeds the Export page.
// Invoked by the Refresh button at the top of the Export tab. Best-effort
// across sources — partial success is OK; the response lists which sources
// refreshed and which failed so the UI can show per-source status.
//
// Pipelines touched:
//   - Solcast snapshots: triggers autoFetchSolcastSnapshots for today+tomorrow
//     (gateway-mode only; no-op in remote mode). Bounded by a per-request
//     timeout so a slow upstream can't stall the UI.
//   - Forecast dayahead: no explicit reload — reads are live queries.
//     Returns current row counts so the UI can show "N days available".
//   - Snapshot date list: returns current solcast_snapshots distinct dates.
//   - Analytics forecast date list: returns current forecast_dayahead dates.
//   - Audit log / energy / alarms / daily report: live queries at export
//     time. Returns row counts for visibility.
app.post("/api/export/refresh-pipelines", async (req, res) => {
  const started = Date.now();
  const report = {
    ok: true,
    remoteMode: isRemoteMode(),
    startedAt: started,
    durationMs: 0,
    sources: {},
  };

  const mark = (key, payload) => { report.sources[key] = payload; };

  // 1. Solcast — pull fresh snapshots if we are gateway-mode.
  if (isRemoteMode()) {
    mark("solcast", { status: "skipped", reason: "remote-mode" });
  } else {
    try {
      const cfg = getSolcastConfig();
      const tz = cfg?.timeZone || "Asia/Manila";
      const today = localDateStrInTz(Date.now(), tz);
      const tomorrow = addDaysIso(today, 1);
      const solcastTimeoutMs = Math.max(3000, Math.min(20000, Number(req.body?.solcastTimeoutMs) || 10000));
      const fetchPromise = autoFetchSolcastSnapshots([today, tomorrow], {
        toolkitHours: SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS,
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("solcast-timeout")), solcastTimeoutMs),
      );
      const result = await Promise.race([fetchPromise, timeoutPromise]);
      mark("solcast", {
        status: result?.pulled ? "ok" : "degraded",
        pulled: !!result?.pulled,
        persisted: Number(result?.persisted || 0),
        historyRowsAppended: Number(result?.historyRowsAppended || 0),
        reason: result?.reason || "",
        dates: [today, tomorrow],
      });
    } catch (err) {
      const msg = String(err?.message || err);
      mark("solcast", {
        status: msg === "solcast-timeout" ? "timeout" : "error",
        error: msg,
      });
    }
  }

  // 2. Solcast snapshot-date list (for the forecast export dropdown).
  try {
    const rows = db.prepare(
      `SELECT DISTINCT forecast_day FROM solcast_snapshots ORDER BY forecast_day DESC LIMIT 90`,
    ).all();
    mark("solcastSnapshotDates", {
      status: "ok",
      count: rows.length,
      dates: rows.map((r) => r.forecast_day),
    });
  } catch (err) {
    mark("solcastSnapshotDates", { status: "error", error: String(err?.message || err) });
  }

  // 3. Forecast day-ahead date list.
  try {
    const rows = db.prepare(
      `SELECT DISTINCT date FROM forecast_dayahead ORDER BY date DESC LIMIT 90`,
    ).all();
    mark("forecastDates", {
      status: "ok",
      count: rows.length,
      dates: rows.map((r) => r.date),
    });
  } catch (err) {
    mark("forecastDates", { status: "error", error: String(err?.message || err) });
  }

  // 4-7. Counts for the other export data sources (visibility only).
  const countQueries = [
    { key: "energy5min", sql: "SELECT COUNT(*) AS n FROM energy_5min" },
    { key: "dailyReport", sql: "SELECT COUNT(*) AS n FROM daily_report" },
    { key: "auditLog", sql: "SELECT COUNT(*) AS n FROM audit_log" },
    { key: "alarms", sql: "SELECT COUNT(*) AS n FROM alarms" },
    { key: "readings", sql: "SELECT COUNT(*) AS n FROM readings" },
  ];
  for (const q of countQueries) {
    try {
      const row = db.prepare(q.sql).get();
      mark(q.key, { status: "ok", count: Number(row?.n || 0) });
    } catch (err) {
      mark(q.key, { status: "error", error: String(err?.message || err) });
    }
  }

  report.durationMs = Date.now() - started;
  return res.json(report);
});

app.post("/api/export/solcast-week-ahead", async (req, res) => {
  try {
    const cfg = getSolcastConfig();
    const tz = cfg?.timeZone || "Asia/Manila";
    const baseDate = localDateStrInTz(Date.now(), tz);
    const dates = Array.from({ length: 7 }, (_, i) => addDaysIso(baseDate, i + 1));
    const format = String(req.body?.format || "xlsx").trim().toLowerCase();
    const resolution = String(req.body?.resolution || "1hr").trim().toLowerCase();
    // Mirror the Toolkit Preview fetch: compute hours the same way the preview endpoint does
    // (startDay=dates[0], dayCount=7, availableSpan=SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS=7).
    // For a week starting tomorrow this yields (1+7+1)*24=216 → capped to 192 h, which fully
    // covers all 7 export days.  The 48-h default would leave days 3-7 empty.
    const toolkitHours = computeSolcastPreviewHoursForRequest(
      dates[0],
      7,
      cfg,
      SOLCAST_TOOLKIT_PREVIEW_MAX_DAYS,
    );
    await autoFetchSolcastSnapshots(dates, { toolkitHours });
    const days = querySolcastWeekAheadDays(baseDate);
    const slotRows = querySlotRowsForWeekAhead(dates);
    const rawOutPath = await runGatewayExportJob("solcast-week-ahead", () =>
      exporter.exportSolcastWeekAhead({
        days,
        slotRows,
        format,
        resolution,
        startDay: dates[0],
        endDay: dates[dates.length - 1],
      }),
    );
    const outPath = await exporter.ensureForecastExportSubfolder(rawOutPath, "Solcast/Week-Ahead");
    return res.json(buildExportResult(outPath, { baseDate, days: days.length }));
  } catch (err) {
    return sendExportRouteError(res, err, "solcast-week-ahead");
  }
});

let forecastGenerating = false;
let _forecastCronRunning = false;
let _lastForecastPid = null; // M5 fix: track Python forecast process PID for emergency kill
const _forecastJobs = new Map(); // jobId → {status, startedAt, dates, result, error}

function _gcForecastJobs() {
  const runningCutoff = Date.now() - 60 * 60 * 1000; // FIX-10: 60 min for multi-date generation (was 30)
  const doneCutoff = Date.now() - 5 * 60 * 1000; // FIX-10: completed jobs freed after 5 min (was 2)
  for (const [id, job] of _forecastJobs) {
    // FIX-M6: Only delete running jobs if they exceed timeout; mark as error instead
    if (job.status === "running" && job.startedAt < runningCutoff) {
      console.warn(`[forecast] GC: marking stale running job ${id} as error (started ${Math.round((Date.now() - job.startedAt) / 60000)}m ago)`);
      job.status = "error";
      job.error = "Job exceeded maximum runtime (60 min)";
      job.completedAt = Date.now();
      continue;
    }
    if ((job.status === "done" || job.status === "error") && job.completedAt && job.completedAt < doneCutoff) {
      _forecastJobs.delete(id);
    }
  }
}

function _forecastResultToResponse(r, extra = {}) {
  return {
    ok: true,
    dates: r._dates,
    count: r._dates ? r._dates.length : 0,
    providerPreferred: r.provider_expected,
    providerUsed: r.provider_used,
    forecastVariant: r.forecast_variant,
    forecastVariantsByDate: r.forecast_variants_by_date,
    solcastFreshnessByDate: r.solcast_freshness_by_date,
    totalsKwhByDate: r.totals_kwh_by_date,
    fallbackUsed: r.provider_used !== r.provider_expected,
    fallbackReason:
      r.provider_used !== r.provider_expected
        ? r.attempts?.find((a) => a.provider === r.provider_expected && !a.ok)?.error || "Preferred provider unavailable."
        : "",
    durationMs: r.durationMs,
    normalizedRows: r.normalized_rows,
    writtenRows: r.written_rows,
    snapshotRowsPersisted: r.snapshot_rows_persisted,
    snapshotWarnings: r.snapshot_warnings,
    endpoint: r.endpoint,
    solcastPull: r.solcast_pull,
    attempts: r.attempts,
    ...extra,
  };
}

// FIX-13: Rate limiting cooldown for forecast generation
let _lastForecastRequestTime = 0;
const FORECAST_COOLDOWN_MS = 30 * 1000; // 30 seconds between requests

app.post("/api/forecast/generate", async (req, res) => {
  if (isRemoteMode()) {
    return res.status(403).json({
      ok: false,
      error:
        "Day-ahead generation is disabled in Client mode. Generate on the Gateway server.",
    });
  }
  // FIX-13: Cooldown rate limiting
  const now = Date.now();
  if (now - _lastForecastRequestTime < FORECAST_COOLDOWN_MS) {
    return res.status(429).json({
      ok: false,
      error: `Please wait ${Math.ceil((FORECAST_COOLDOWN_MS - (now - _lastForecastRequestTime)) / 1000)}s before retrying.`,
    });
  }
  _lastForecastRequestTime = now;
  if (forecastGenerating) {
    return res.status(409).json({ ok: false, error: "Forecast generation already in progress." });
  }

  const body = req.body || {};
  const mode = String(body.mode || "").trim();
  let dates = [];
  if (!mode || mode === "dayahead-days") {
    const dayCount = clampInt(body.dayCount, 1, 31, 1);
    const tomorrow = addDaysIso(localDateStr(), 1);
    const lastDay = addDaysIso(tomorrow, dayCount - 1);
    dates = daysInclusive(tomorrow, lastDay);
  } else {
    return res.status(400).json({ ok: false, error: "Invalid mode. Use 'dayahead-days'." });
  }

  // FIX-C1: Prevent concurrent manual + cron forecast generation
  if (_forecastCronRunning) {
    return res.status(409).json({ ok: false, error: "Cron-based forecast generation in progress. Please try again later." });
  }
  forecastGenerating = true;

  // Safety timeout: auto-reset if generation hangs for 45 minutes
  const _forecastGuardTimer = setTimeout(() => {
    if (forecastGenerating) {
      console.warn("[forecast] Safety timeout: forecastGenerating flag auto-reset after 45 minutes");
      forecastGenerating = false;
      // M5 fix: attempt to kill hanging forecast process
      if (_lastForecastPid) {
        try {
          if (process.platform === "win32") {
            require("child_process").execSync(`taskkill /pid ${_lastForecastPid} /T /F`, { stdio: "ignore" });
          } else {
            process.kill(_lastForecastPid, "SIGTERM");
          }
          console.warn(`[forecast] Killed hanging forecast process (PID ${_lastForecastPid})`);
        } catch {}
        _lastForecastPid = null;
      }
    }
  }, 45 * 60 * 1000);

  // Async mode: fire-and-forget, return jobId immediately so the client
  // can poll /api/forecast/generate/status/:jobId instead of blocking.
  if (body.async === true) {
    const jobId = crypto.randomUUID();
    _forecastJobs.set(jobId, { status: "running", startedAt: Date.now(), dates, result: null, error: null });
    _gcForecastJobs();
    runDayAheadGenerationPlan({ dates, trigger: "manual_api" })
      .then((result) => {
        result._dates = dates;
        const job = _forecastJobs.get(jobId);
        if (job) { job.status = "done"; job.result = result; job.completedAt = Date.now(); }
        // M12: notify connected clients that new forecast data is available
        try { broadcastUpdate && broadcastUpdate({ type: "live" }); } catch {}
      })
      .catch((e) => {
        const job = _forecastJobs.get(jobId);
        if (job) { job.status = "error"; job.error = e.message; job.completedAt = Date.now(); }
      })
      .finally(() => { forecastGenerating = false; clearTimeout(_forecastGuardTimer); });
    return res.json({ ok: true, jobId, status: "running", dates, count: dates.length });
  }

  // Sync mode (original behaviour — used by Python delegate and legacy callers).
  try {
    const result = await runDayAheadGenerationPlan({ dates, trigger: "manual_api" });
    result._dates = dates;
    // M12: notify connected clients that new forecast data is available
    try { broadcastUpdate && broadcastUpdate({ type: "live" }); } catch {}
    res.json({ mode, ...(_forecastResultToResponse(result)) });
  } catch (e) {
    const msg = String(e.message || "");
    const isClientError = msg.includes("No target dates") ||
                          msg.includes("exceeds") ||
                          msg.includes("Invalid mode");
    res.status(isClientError ? 400 : 500).json({ ok: false, error: e.message });
  } finally {
    forecastGenerating = false;
    clearTimeout(_forecastGuardTimer);
  }
});

app.get("/api/forecast/generate/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return res.status(400).json({ ok: false, error: "Invalid job ID format." });
  }
  const job = _forecastJobs.get(jobId);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found or expired." });
  const elapsedMs = Date.now() - job.startedAt;
  if (job.status === "done") {
    return res.json({ status: "done", elapsedMs, ...(_forecastResultToResponse(job.result)) });
  }
  if (job.status === "error") {
    return res.status(500).json({ ok: false, status: "error", elapsedMs, error: job.error });
  }
  res.json({ ok: true, status: "running", elapsedMs, dates: job.dates, count: job.dates.length });
});

// ── Internal auto-generation endpoint for Python scheduler delegation ─────
// The Python forecast service delegates day-ahead generation to this endpoint
// so both manual and automatic paths use the same provider-aware orchestrator.
// Localhost-only for security.
// FIX-14: Rate limiting cooldown for internal forecast endpoint
let _lastInternalForecastTime = 0;
const INTERNAL_FORECAST_COOLDOWN_MS = 60 * 1000; // 1 minute

app.post("/api/internal/forecast/generate-auto", async (req, res) => {
  const remoteIp = String(req.ip || req.connection?.remoteAddress || "").replace(/^::ffff:/, "");
  if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "localhost") {
    return res.status(403).json({ ok: false, error: "Internal endpoint — localhost only." });
  }
  if (isRemoteMode()) {
    return res.status(403).json({ ok: false, error: "Day-ahead generation is disabled in Client mode." });
  }
  // FIX-14: Cooldown rate limiting for internal endpoint
  const now = Date.now();
  if (now - _lastInternalForecastTime < INTERNAL_FORECAST_COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: "Internal cooldown active." });
  }
  _lastInternalForecastTime = now;
  // Validate trigger before acquiring the lock or starting timers
  const body = req.body || {};
  const trigger = String(body.trigger || "auto_service").trim();
  const validTriggers = new Set(["auto_service", "auto_service_fallback", "node_fallback", "manual_cli"]);
  if (!validTriggers.has(trigger)) {
    return res.status(400).json({ ok: false, error: "Invalid trigger." });
  }
  if (forecastGenerating) {
    return res.status(409).json({ ok: false, error: "Forecast generation already in progress." });
  }
  forecastGenerating = true;

  // Safety timeout: auto-reset if generation hangs for 45 minutes
  const _internalGuardTimer = setTimeout(() => {
    if (forecastGenerating) {
      console.warn("[forecast:internal] Safety timeout: forecastGenerating flag auto-reset after 45 minutes");
      forecastGenerating = false;
    }
  }, 45 * 60 * 1000);

  // T4.4 fix (Phase 2): cross-process advisory lock shared with Python.  If
  // a Python fallback is already running on the same date(s) we MUST NOT
  // start a parallel run — that produces duplicate forecast_run_audit rows.
  // Locks acquired here are released in finally; Python respects the same
  // files via services/forecast_engine.py:_dayahead_gen_lock_*.
  let _lockedDates = [];
  try {
    let dates = Array.isArray(body.dates)
      ? body.dates
          .map((d) => String(d || "").trim())
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [];
    if (dates.length) {
      dates = Array.from(new Set(dates)).sort();
    }
    if (!dates.length) {
      const tomorrow = addDaysIso(localDateStr(), 1);
      dates = [tomorrow];
    }

    // Acquire lock per date; if any is busy, back off atomically by
    // releasing everything already taken and returning 409.
    const lockOwner = `node-internal:${trigger}`;
    for (const d of dates) {
      if (!forecastGenLock.acquire(DATA_DIR, d, lockOwner)) {
        for (const taken of _lockedDates) forecastGenLock.release(DATA_DIR, taken);
        _lockedDates = [];
        return res.status(409).json({
          ok: false,
          error: `Day-ahead generation for ${d} already in progress (Python or Node).`,
        });
      }
      _lockedDates.push(d);
    }

    console.log(
      `[forecast:internal] Auto-generation requested: trigger=${trigger} dates=${dates.join(",")}`,
    );
    const result = await runDayAheadGenerationPlan({
      dates,
      trigger,
    });
    console.log(
      `[forecast:internal] Auto-generation complete: provider=${result.provider_used} variant=${result.forecast_variant} duration=${result.durationMs}ms`,
    );
    res.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    console.warn("[forecast:internal] Auto-generation failed:", e.message);
    const msg = String(e.message || "");
    const isClientError = msg.includes("No target dates") ||
                          msg.includes("exceeds") ||
                          msg.includes("Invalid trigger");
    res.status(isClientError ? 400 : 500).json({ ok: false, error: e.message });
  } finally {
    forecastGenerating = false;
    clearTimeout(_internalGuardTimer);
    // T4.4: always release any locks we acquired, even on error.
    for (const d of _lockedDates) forecastGenLock.release(DATA_DIR, d);
  }
});

// ── Forecast performance monitoring endpoints ──────────────────────────────

// GET /api/forecast/qa-actual/:date — QA-verified actual for a single date
app.get("/api/forecast/qa-actual/:date", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ ok: false });
  try {
    const row = db.prepare(
      `SELECT total_actual_kwh, total_forecast_kwh, total_abs_error_kwh,
              daily_wape_pct, comparison_quality, usable_slot_count
       FROM forecast_error_compare_daily
       WHERE target_date = ?
       ORDER BY computed_ts DESC LIMIT 1`
    ).get(dateStr);
    if (!row || row.total_actual_kwh == null) return res.json({ ok: true, found: false });
    res.json({ ok: true, found: true, ...row });
  } catch (e) {
    res.json({ ok: true, found: false });
  }
});

// GET /api/forecast/qa-history?days=N
// Returns the last N days of daily QA comparison rows for performance charts.
app.get("/api/forecast/qa-history", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const days = Math.min(180, Math.max(7, parseInt(req.query.days, 10) || 30));
    const cutoff = localDateStr(Date.now() - days * 86400000);

    // Primary source: QA-verified comparison table (latest row per target_date)
    let rows = db
      .prepare(
        `SELECT e.target_date, e.provider_used, e.forecast_variant,
                e.solcast_freshness_class, e.comparison_quality,
                e.include_in_error_memory, e.total_forecast_kwh,
                e.total_forecast_lo_kwh, e.total_forecast_hi_kwh,
                e.total_actual_kwh, e.total_abs_error_kwh,
                e.daily_wape_pct, e.daily_mape_pct,
                e.usable_slot_count, e.masked_slot_count, e.computed_ts
         FROM forecast_error_compare_daily e
         INNER JOIN (
           SELECT target_date, MAX(computed_ts) AS max_ts
           FROM forecast_error_compare_daily
           WHERE target_date >= ?
           GROUP BY target_date
         ) latest ON e.target_date = latest.target_date AND e.computed_ts = latest.max_ts
         ORDER BY e.target_date DESC`,
      )
      .all(cutoff);

    // Gap-fill: supplement QA rows with preview rows from forecast_run_audit for dates
    // not yet in the QA table. Previously this fallback only ran when the QA table was
    // completely empty, so a single QA row suppressed all historical preview data.
    const coveredDates = new Set(rows.map((r) => r.target_date));
    const fallbackRows = db
      .prepare(
        `SELECT fra.target_date,
                fra.provider_used,
                fra.forecast_variant,
                fra.solcast_freshness_class,
                'preview'  AS comparison_quality,
                0          AS include_in_error_memory,
                fra.final_forecast_total_kwh          AS total_forecast_kwh,
                NULL                                  AS total_forecast_lo_kwh,
                NULL                                  AS total_forecast_hi_kwh,
                dr.actual_kwh                         AS total_actual_kwh,
                CASE WHEN dr.actual_kwh > 0 AND fra.final_forecast_total_kwh IS NOT NULL
                     THEN ABS(fra.final_forecast_total_kwh - dr.actual_kwh) END AS total_abs_error_kwh,
                CASE WHEN dr.actual_kwh > 0 AND fra.final_forecast_total_kwh IS NOT NULL
                     THEN ROUND(ABS(fra.final_forecast_total_kwh - dr.actual_kwh) / dr.actual_kwh * 100, 2) END AS daily_wape_pct,
                NULL AS daily_mape_pct,
                NULL AS usable_slot_count,
                NULL AS masked_slot_count,
                fra.generated_ts AS computed_ts
         FROM forecast_run_audit fra
         JOIN (
           SELECT target_date, MAX(generated_ts) AS max_ts
           FROM forecast_run_audit
           WHERE is_authoritative_runtime = 1 AND run_status = 'success'
           GROUP BY target_date
         ) latest ON latest.target_date = fra.target_date AND latest.max_ts = fra.generated_ts
         LEFT JOIN (
           SELECT date, SUM(kwh_total) AS actual_kwh
           FROM daily_report
           GROUP BY date
         ) dr ON dr.date = fra.target_date
         WHERE fra.target_date >= ?
         ORDER BY fra.target_date DESC`,
      )
      .all(cutoff);
    const gapRows = fallbackRows.filter((r) => !coveredDates.has(r.target_date));
    if (gapRows.length > 0) {
      rows = [...rows, ...gapRows];
      rows.sort((a, b) => (a.target_date > b.target_date ? -1 : 1));
    }
    if (rows.length === 0) {
      console.warn("[forecast/qa-history] No data found in QA table or forecast_run_audit for the requested window.");
    }

    return res.json({ ok: true, rows });
  } catch (e) {
    console.warn("[forecast/qa-history] query failed:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/forecast/backfill-qa?days=N
// Re-runs QA evaluation for the last N days (default 15, max 30).
// Use after updating forecast engine thresholds to reclassify historical days.
let _lastBackfillRequestTime = 0;
app.post("/api/forecast/backfill-qa", async (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  if (forecastGenerating) {
    return res.status(409).json({ ok: false, error: "Forecast operation already in progress. Please wait." });
  }
  const now = Date.now();
  if (now - _lastBackfillRequestTime < 10000) {
    return res.status(429).json({ ok: false, error: `Please wait ${Math.ceil((10000 - (now - _lastBackfillRequestTime)) / 1000)}s before retrying.` });
  }
  _lastBackfillRequestTime = now;
  const days = Math.min(30, Math.max(1, parseInt(req.query.days || req.body?.days, 10) || 15));
  forecastGenerating = true;
  const _backfillGuardTimer = setTimeout(() => {
    if (forecastGenerating) {
      console.warn("[forecast/backfill-qa] Safety timeout: auto-reset after 45 minutes");
      forecastGenerating = false;
    }
  }, 45 * 60 * 1000);
  try {
    console.log(`[forecast/backfill-qa] Starting QA backfill for ${days} days...`);
    const result = await runForecastGenerator(["--backfill-qa", String(days)]);
    console.log(`[forecast/backfill-qa] Complete (${result?.durationMs || 0}ms)`);
    return res.json({ ok: true, days, durationMs: result?.durationMs || 0 });
  } catch (e) {
    console.warn("[forecast/backfill-qa] Failed:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    forecastGenerating = false;
    clearTimeout(_backfillGuardTimer);
  }
});

// GET /api/forecast/engine-health
// Returns ML training state (consecutive rejections) and latest audit run for health badge.
app.get("/api/forecast/engine-health", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const trainStatePath = path.join(PROGRAMDATA_ROOT, "forecast", "ml_train_state.json");
    let trainState = {};
    try {
      if (fs.existsSync(trainStatePath)) {
        trainState = JSON.parse(fs.readFileSync(trainStatePath, "utf8"));
      }
    } catch {
      // non-fatal — return empty state
    }

    const latestAudit = db
      .prepare(
        `SELECT target_date, generated_ts, provider_used, forecast_variant,
                run_status, solcast_freshness_class, final_forecast_total_kwh,
                is_authoritative_runtime, attempt_number, notes_json, weather_source,
                physics_total_kwh, hybrid_total_kwh,
                solcast_lo_total_kwh, solcast_hi_total_kwh, baseline_is_solcast_mid
         FROM forecast_run_audit
         ORDER BY generated_ts DESC LIMIT 1`,
      )
      .get();

    const recentQuality = db
      .prepare(
        `SELECT comparison_quality, COUNT(*) AS cnt
         FROM forecast_error_compare_daily
         WHERE computed_ts >= ?
         GROUP BY comparison_quality`,
      )
      .all(Date.now() - 14 * 24 * 3600 * 1000);

    // 3.1 sourceFreshness: Solcast age, weather source, last actuals date
    const _tomorrow = localDateStr(Date.now() + 86400000);
    const _today    = localDateStr();
    let _solcastPullTs = null;
    try {
      const _scRow = db.prepare(
        `SELECT MAX(pulled_ts) AS max_ts FROM solcast_snapshots WHERE forecast_day IN (?, ?)`
      ).get(_tomorrow, _today);
      _solcastPullTs = _scRow?.max_ts ? Number(_scRow.max_ts) : null;
    } catch { /* non-fatal */ }
    const _solcastAgeHours = _solcastPullTs
      ? Math.round((Date.now() - _solcastPullTs) / 3600000)
      : null;

    let _lastActualsDate = null;
    try {
      const _actRow = db.prepare(
        `SELECT MAX(date) AS last_date FROM daily_report WHERE kwh_total > 0`
      ).get();
      _lastActualsDate = _actRow?.last_date || null;
    } catch { /* non-fatal */ }

    let _metSource = null;
    if (latestAudit?.notes_json) {
      try {
        const _notes = JSON.parse(latestAudit.notes_json);
        _metSource = _notes?.weather_source_breakdown?.met_source || null;
      } catch { /* ignore */ }
    }
    if (!_metSource && latestAudit?.weather_source) {
      _metSource = latestAudit.weather_source;
    }

    // 3.2 recentBias: signed mean % bias from last 7 eligible QA rows
    let _recentBiasPct = null;
    try {
      const _biasRows = db.prepare(
        `SELECT total_forecast_kwh, total_actual_kwh
         FROM forecast_error_compare_daily
         WHERE comparison_quality = 'eligible' AND total_actual_kwh > 0
         ORDER BY target_date DESC LIMIT 7`
      ).all();
      if (_biasRows.length > 0) {
        const _biasVals = _biasRows.map(
          (r) => ((Number(r.total_forecast_kwh) - Number(r.total_actual_kwh)) / Number(r.total_actual_kwh)) * 100,
        );
        _recentBiasPct = Math.round((_biasVals.reduce((a, b) => a + b, 0) / _biasVals.length) * 10) / 10;
      }
    } catch { /* non-fatal */ }

    // C3: Compute plant-average transmission loss % from ipconfig (mirrors Python plant_capacity_profile)
    let plantAvgLossPct = 3.0;  // fallback = DEFAULT_INVERTER_LOSS_PCT
    let lossFactorSource = "default";
    try {
      const _ipCfg = loadIpConfigFromDb();
      const _invMap = _ipCfg?.inverters || {};
      const _unitMap = _ipCfg?.units || {};
      const _lossMap = _ipCfg?.losses || {};
      const _allIds = new Set([
        ...Object.keys(_invMap),
        ...Object.keys(_unitMap),
      ]);
      if (_allIds.size > 0) {
        let _enabledNodes = 0;
        let _lossAdjNodes = 0;
        for (const invId of _allIds) {
          const ip = String(_invMap[invId] || "").trim();
          if (Object.keys(_invMap).length > 0 && invId in _invMap && !ip) continue;
          const rawUnits = _unitMap[invId] ?? _unitMap[String(invId)];
          const nNodes = rawUnits === undefined ? 4
            : (Array.isArray(rawUnits) ? rawUnits.filter(n => Number(n) >= 1 && Number(n) <= 4).length : 0);
          _enabledNodes += nNodes;
          let lossPct = parseFloat(_lossMap[invId] ?? _lossMap[String(invId)] ?? 0) || 0;
          if (lossPct < 0 || lossPct > 100) lossPct = 0;
          _lossAdjNodes += nNodes * (1.0 - lossPct / 100.0);
        }
        if (_enabledNodes > 0) {
          plantAvgLossPct = Number(((1.0 - _lossAdjNodes / _enabledNodes) * 100).toFixed(2));
          lossFactorSource = "ipconfig";
        }
      }
    } catch { /* non-fatal — use default */ }

    const modelMtime = trainState.model_file_mtime_ms || null;

    // Extract errorMemory from trainState (new in v2.5.1, may be absent in older files)
    const errorMemory = trainState.error_memory || null;

    return res.json({
      ok: true,
      trainState: {
        consecutiveRejections: Number(trainState.consecutive_train_rejection_count || 0),
        lastRejectionTs: trainState.last_rejection_ts || null,
        lastSuccessfulTrainTs: trainState.last_successful_train_ts || null,
      },
      mlBackend: {
        type: trainState.ml_backend_type || "unknown",
        modelPath: trainState.model_file_path || null,
        modelAgeHours: modelMtime ? Math.round((Date.now() - modelMtime) / 3600000) : null,
        available: !!trainState.model_file_path,
      },
      trainingSummary: {
        samplesUsed: trainState.training_samples_count ?? null,
        featuresUsed: trainState.training_features_count ?? null,
        regimesCount: trainState.training_regimes_count ?? null,
        lastTrainingDate: trainState.last_training_date || null,
        trainingResult: trainState.training_result || null,
      },
      dataQualityFlags: Array.isArray(trainState.data_warnings) ? trainState.data_warnings : [],
      errorMemory,
      latestAudit: latestAudit || null,
      recentQualityBreakdown: recentQuality,
      sourceFreshness: {
        solcastAgeHours: _solcastAgeHours,
        solcastPulledTs: _solcastPullTs,
        weatherSource: _metSource || null,
        lastActualsDate: _lastActualsDate,
      },
      recentBias: {
        signedBiasPct: _recentBiasPct,
        rowsUsed: _recentBiasPct !== null ? 7 : 0,
      },
      outageSummary: trainState.outage_summary || null,
      estActualReconstruction: (trainState.outage_summary || {}).est_actual_reconstruction || null,
      solcastBaseline: {
        isActive: !!(latestAudit?.baseline_is_solcast_mid),
        baselineTotalKwh: latestAudit?.hybrid_total_kwh ?? null,
        physicsTotalKwh: latestAudit?.physics_total_kwh ?? null,
        solcastLoTotalKwh: latestAudit?.solcast_lo_total_kwh ?? null,
        solcastHiTotalKwh: latestAudit?.solcast_hi_total_kwh ?? null,
        forecastTotalKwh: latestAudit?.final_forecast_total_kwh ?? null,
      },
      plantAvgLossPct,
      lossFactorSource,
      trainingActualSourceDistribution: trainState.training_actual_source_distribution || null,
      meteredTrainingDays: trainState.metered_training_days || [],
      estActualWeightEffective: trainState.est_actual_weight_effective || null,
      lossCalibrationAudit: trainState.loss_calibration_audit || null,
    });
  } catch (e) {
    console.warn("[forecast/engine-health] failed:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/energy/today", (req, res) => {
  try {
    const rows = buildCurrentDayEnergySnapshot().rows;
    // Keep this endpoint strictly aligned with logged daily report rows.
    return res.json(rows);
  } catch (e) {
    console.warn("[energy/today] DB PAC total failed:", e.message);
    return res.json([]);
  }
});

// Daily energy totals per inverter for a time range — used by sparklines.
app.get("/api/energy/daily", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const end = req.query.end ? Number(req.query.end) : Date.now();
    const start = req.query.start ? Number(req.query.start) : end - 7 * 86400000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return res.status(400).json({ ok: false, error: "invalid range" });
    }
    const rows = queryEnergy5minRangeAll(start, end);
    const byInvDate = {};
    for (const row of rows) {
      const inv = Number(row.inverter || 0);
      if (!inv) continue;
      const dt = new Date(Number(row.ts || 0)).toISOString().slice(0, 10);
      const key = `${inv}|${dt}`;
      byInvDate[key] = (byInvDate[key] || 0) + Number(row.kwh_inc || 0);
    }
    const result = Object.entries(byInvDate).map(([k, kwh_total]) => {
      const [inverter, date] = k.split("|");
      return { inverter: Number(inverter), date, kwh_total };
    });
    return res.json(result);
  } catch (e) {
    console.warn("[energy/daily] failed:", e.message);
    return res.json([]);
  }
});

app.get("/api/report/daily", (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const _t0 = Date.now();
  try {
    const currentDaySnapshot = buildCurrentDayEnergySnapshot();
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
      currentDaySnapshot,
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
    const currentDaySnapshot = buildCurrentDayEnergySnapshot();
    const refreshRequested = ["1", "true", "yes", "on"].includes(
      String(req.query?.refresh || "")
        .trim()
        .toLowerCase(),
    );
    return res.json(
      buildDailyWeeklyReportSummary(day, {
        refreshDay: refreshRequested,
        currentDaySnapshot,
      }),
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

// ── Gap 1: Multi-day availability trend ────────────────────────────────────
app.get("/api/report/availability-trend", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
    const invFilter =
      req.query.inverter !== undefined ? Number(req.query.inverter) : null;
    const today = localDateStr();
    const startDate = localDateStr(Date.now() - (days - 1) * 86400000);
    let rows = stmts.getDailyReportRange.all(startDate, today);
    if (invFilter !== null) {
      rows = rows.filter((r) => Number(r.inverter) === invFilter);
    }
    // Group by date
    const byDate = {};
    for (const r of rows) {
      const d = r.date;
      if (!byDate[d]) byDate[d] = { date: d, avail_sum: 0, kwh_sum: 0, count: 0 };
      byDate[d].avail_sum += Number(r.availability_pct || 0);
      byDate[d].kwh_sum += Number(r.kwh_total || 0);
      byDate[d].count += 1;
    }
    const trend = Object.values(byDate)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        date: d.date,
        availability_avg_pct:
          d.count > 0
            ? Math.round((d.avail_sum / d.count) * 100) / 100
            : null,
        total_kwh: Math.round(d.kwh_sum * 1000) / 1000,
        inverter_count: d.count,
      }));
    return res.json({ ok: true, days, inverter: invFilter, trend });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Gap 2: Date-range availability aggregation ──────────────────────────────
app.get("/api/report/availability-range", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const today = localDateStr();
    const start = parseIsoDateStrict(req.query.start || today, "start");
    const end = parseIsoDateStrict(req.query.end || today, "end");
    if (end < start)
      return res.status(400).json({ ok: false, error: "end must be >= start" });
    const invFilter =
      req.query.inverter !== undefined ? Number(req.query.inverter) : null;
    let rows = stmts.getDailyReportRange.all(start, end);
    if (invFilter !== null) {
      rows = rows.filter((r) => Number(r.inverter) === invFilter);
    }
    // Per-inverter summary
    const byInv = {};
    for (const r of rows) {
      const inv = Number(r.inverter);
      if (!byInv[inv]) {
        byInv[inv] = {
          inverter: inv,
          avail_sum: 0,
          kwh_sum: 0,
          uptime_s: 0,
          day_count: 0,
        };
      }
      byInv[inv].avail_sum += Number(r.availability_pct || 0);
      byInv[inv].kwh_sum += Number(r.kwh_total || 0);
      byInv[inv].uptime_s += Number(r.uptime_s || 0);
      byInv[inv].day_count += 1;
    }
    const inverters = Object.values(byInv)
      .sort((a, b) => a.inverter - b.inverter)
      .map((d) => ({
        inverter: d.inverter,
        availability_avg_pct:
          d.day_count > 0
            ? Math.round((d.avail_sum / d.day_count) * 100) / 100
            : null,
        total_kwh: Math.round(d.kwh_sum * 1000) / 1000,
        uptime_h: Math.round((d.uptime_s / 3600) * 100) / 100,
        day_count: d.day_count,
      }));
    const overall =
      inverters.length > 0
        ? {
            availability_avg_pct:
              Math.round(
                (inverters.reduce((s, r) => s + (r.availability_avg_pct || 0), 0) /
                  inverters.length) *
                  100,
              ) / 100,
            total_kwh: Math.round(
              inverters.reduce((s, r) => s + r.total_kwh, 0) * 1000,
            ) / 1000,
            inverter_count: inverters.length,
          }
        : null;
    return res.json({ ok: true, start, end, overall, inverters });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Gap 6: Scheduled maintenance CRUD ──────────────────────────────────────
app.get("/api/maintenance", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const invFilter =
      req.query.inverter !== undefined ? Number(req.query.inverter) : undefined;
    const startTs =
      req.query.start !== undefined
        ? new Date(req.query.start).getTime()
        : undefined;
    const endTs =
      req.query.end !== undefined
        ? new Date(req.query.end).getTime()
        : undefined;
    const entries = getScheduledMaintenance({
      inverter: invFilter,
      startTs,
      endTs,
    });
    return res.json({ ok: true, entries });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/maintenance", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res.status(403).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const { inverter, start_ts, end_ts, reason } = req.body || {};
    const id = insertScheduledMaintenance({ inverter, start_ts, end_ts, reason });
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete("/api/maintenance/:id", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  if (!isAuthorizedPlantWideControl(req.body || {}, req)) {
    return res.status(403).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const changes = deleteScheduledMaintenance(req.params.id);
    if (!changes) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Gap 7: Downtime drill-down ──────────────────────────────────────────────
app.get("/api/report/downtime", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);
  try {
    const day = parseIsoDateStrict(
      req.query.date || localDateStr(),
      "date",
    );
    const invFilter =
      req.query.inverter !== undefined ? Number(req.query.inverter) : null;

    const { startTs: winStart, endTs: winEnd } = getReportSolarWindowBounds(day, false);

    // Load all summary rows for this day (or just one inverter)
    const allSummaryRows = stmts.getDailyReadingsSummaryDay.all(day);
    const summaryRows =
      invFilter !== null
        ? allSummaryRows.filter((r) => Number(r.inverter) === invFilter)
        : allSummaryRows;

    // Group by inverter
    const byInv = {};
    for (const r of summaryRows) {
      const inv = Number(r.inverter);
      if (!byInv[inv]) byInv[inv] = [];
      // intervals_json is [[startMs, endMs], ...]
      let intervals = [];
      try {
        intervals = JSON.parse(r.intervals_json || "[]");
      } catch {
        intervals = [];
      }
      byInv[inv].push(...intervals);
    }

    // For each inverter, merge online intervals clipped to solar window,
    // then compute downtime gaps
    const result = [];
    for (const [invStr, rawIntervals] of Object.entries(byInv)) {
      const inv = Number(invStr);
      const clipped = clipIntervalsToWindowMs(rawIntervals, winStart, winEnd);
      // Sort and merge overlapping online intervals
      const sorted = clipped.slice().sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const iv of sorted) {
        if (merged.length === 0 || iv[0] > merged[merged.length - 1][1]) {
          merged.push([iv[0], iv[1]]);
        } else {
          merged[merged.length - 1][1] = Math.max(
            merged[merged.length - 1][1],
            iv[1],
          );
        }
      }
      // Downtime gaps = solar window minus online intervals
      const gaps = [];
      let cursor = winStart;
      for (const [onStart, onEnd] of merged) {
        if (onStart > cursor) {
          gaps.push({ start_ts: cursor, end_ts: onStart, duration_s: Math.round((onStart - cursor) / 1000) });
        }
        cursor = Math.max(cursor, onEnd);
      }
      if (cursor < winEnd) {
        gaps.push({ start_ts: cursor, end_ts: winEnd, duration_s: Math.round((winEnd - cursor) / 1000) });
      }
      if (gaps.length > 0) {
        result.push({ inverter: inv, downtime: gaps });
      }
    }

    result.sort((a, b) => a.inverter - b.inverter);
    return res.json({ ok: true, date: day, window_start_ts: winStart, window_end_ts: winEnd, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

function getEnergySummarySupplementRowsForRange(
  startTs,
  endTs,
  currentDaySnapshot = null,
) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const today = localDateStr();
  const todayStart = new Date(`${today}T00:00:00.000`).getTime();
  const todayEnd = new Date(`${today}T23:59:59.999`).getTime();
  if (e < todayStart || s > todayEnd) return [];
  if (currentDaySnapshot && currentDaySnapshot.day === today) {
    return normalizeTodayEnergyRows(currentDaySnapshot.rows);
  }
  return buildCurrentDayEnergySnapshot().rows;
}

async function buildEnergySummarySourceRows(payload = {}) {
  const s = Number(payload?.startTs || 0) || Date.now() - 86400000;
  const e = Number(payload?.endTs || 0) || Date.now();
  const currentDaySnapshot = buildCurrentDayEnergySnapshot();
  return await exporter.buildEnergySummaryExportRows(s, e, payload?.inverter, {
    supplementalTodayRows: getEnergySummarySupplementRowsForRange(
      s,
      e,
      currentDaySnapshot,
    ),
  });
}

function exportTouchesCurrentDay(payload = {}) {
  const today = localDateStr();
  const dateText = String(payload?.date || "").trim();
  if (dateText) return dateText === today;

  const s = Number(payload?.startTs || 0);
  const e = Number(payload?.endTs || 0);
  if (Number.isFinite(s) && s > 0 && Number.isFinite(e) && e >= s) {
    const todayStart = new Date(`${today}T00:00:00.000`).getTime();
    const todayEnd = new Date(`${today}T23:59:59.999`).getTime();
    return e >= todayStart && s <= todayEnd;
  }

  return true;
}

function getConfiguredExportRoot() {
  const configured = String(
    getSetting("csvSavePath", "C:\\Logs\\InverterDashboard") || "",
  ).trim();
  return path.resolve(configured || "C:\\Logs\\InverterDashboard");
}

function isPathInsideBase(baseDir, targetPath) {
  const base = path.resolve(String(baseDir || ""));
  const target = path.resolve(String(targetPath || ""));
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeExportRelativePath(relativePath, fallbackPath = "") {
  const raw = String(relativePath || "").trim();
  const parts = raw
    ? raw.split(/[\\/]+/).filter(Boolean)
    : [];
  if (!parts.length && fallbackPath) {
    const base = getConfiguredExportRoot();
    const absFallback = path.resolve(String(fallbackPath || ""));
    if (isPathInsideBase(base, absFallback)) {
      return normalizeExportRelativePath(path.relative(base, absFallback));
    }
  }
  if (!parts.length) {
    throw new Error("Export relative path is missing.");
  }
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid export relative path.");
  }
  const normalized = path.normalize(parts.join(path.sep));
  if (!normalized || normalized === "." || path.isAbsolute(normalized)) {
    throw new Error("Invalid export relative path.");
  }
  return normalized;
}

function normalizeForecastExportRelativePathForRoute(routePath, relativePath, payload) {
  const route = String(routePath || "").trim();
  if (route === "/api/export/forecast-actual") {
    const source = String(payload?.source || "analytics").trim().toLowerCase();
    const subFolder = source === "solcast" ? "Solcast/Day-Ahead" : "Analytics/Day-Ahead";
    return exporter.rewriteForecastExportRelativePath(relativePath, subFolder);
  }
  if (route === "/api/export/solcast-preview") {
    return exporter.rewriteForecastExportRelativePath(relativePath, "Solcast/Preview");
  }
  return relativePath;
}

function resolveLocalExportPath(relativePath, fallbackPath = "") {
  const base = getConfiguredExportRoot();
  const rel = normalizeExportRelativePath(relativePath, fallbackPath);
  const absolute = path.resolve(base, rel);
  if (!isPathInsideBase(base, absolute)) {
    throw new Error("Resolved export path is outside the configured export directory.");
  }
  return absolute;
}

function buildExportResult(outPath, extra = {}) {
  const absolute = path.resolve(String(outPath || ""));
  const base = getConfiguredExportRoot();
  const relativePath = normalizeExportRelativePath("", absolute).replace(/\\/g, "/");
  return {
    ok: true,
    path: absolute,
    relativePath,
    basePath: base,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

function normalizeAlarmExportMinDurationSecServer(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(86400, Math.max(0, Math.trunc(raw)));
}

const MAX_EXPORT_RANGE_DAYS = 366;
const MAX_EXPORT_RANGE_MS = MAX_EXPORT_RANGE_DAYS * 24 * 60 * 60 * 1000;

function validateExportDateRange(payload) {
  const s = Number(payload?.startTs || 0);
  const e = Number(payload?.endTs || 0);
  if (s > 0 && e > 0) {
    if (s > e) {
      throw new Error("Export start date is after end date. Please correct your selection.");
    }
    if ((e - s) > MAX_EXPORT_RANGE_MS) {
      throw new Error(`Export date range exceeds maximum of ${MAX_EXPORT_RANGE_DAYS} days. Please narrow your selection.`);
    }
  }
}

function sendExportRouteError(res, err) {
  const status = isExportQueueBusyError(err) ? 429 : 500;
  if (status === 429) {
    res.setHeader("Retry-After", "5");
  }
  return res.status(status).json({
    ok: false,
    error: String(err?.message || err || "Export failed."),
  });
}

async function fetchRemoteExportJson(routePath, payload = {}) {
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    throw new Error("Remote gateway URL is not configured.");
  }
  if (isUnsafeRemoteLoop(base)) {
    throw new Error("Remote gateway URL cannot be localhost in remote mode.");
  }
  const targetUrl = `${base}${routePath}`;
  const response = await fetch(targetUrl, buildRemoteFetchOptions(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildRemoteProxyHeaders(),
    },
    body: JSON.stringify(payload || {}),
    timeout: REMOTE_REPLICATION_TIMEOUT_MS,
  }));
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(
      String(data?.error || text || `Remote export failed with HTTP ${response.status}`),
    );
  }
  if (!data?.ok) {
    throw new Error(String(data?.error || "Remote export failed."));
  }
  return data;
}

async function downloadRemoteExportToLocal(routePath, payload = {}) {
  const base = getRemoteGatewayBaseUrl();
  if (!base) {
    throw new Error("Remote gateway URL is not configured.");
  }
  if (isUnsafeRemoteLoop(base)) {
    throw new Error("Remote gateway URL cannot be localhost in remote mode.");
  }

  const exportResult = await fetchRemoteExportJson(routePath, payload);
  if (String(routePath || "").trim() === "/api/export/alarms") {
    const requestedMinDurationSec = normalizeAlarmExportMinDurationSecServer(
      payload?.minAlarmDurationSec,
    );
    const appliedMinDurationSec = normalizeAlarmExportMinDurationSecServer(
      exportResult?.appliedFilters?.minAlarmDurationSec,
    );
    if (requestedMinDurationSec > 0 && appliedMinDurationSec !== requestedMinDurationSec) {
      throw new Error(
        "Gateway alarm export did not confirm the requested minimum duration filter. Update and restart the gateway app, then export again.",
      );
    }
  }
  const remoteRelativePath = normalizeExportRelativePath(
    exportResult?.relativePath,
    exportResult?.path,
  );
  const localRelativePath = normalizeForecastExportRelativePathForRoute(
    routePath,
    remoteRelativePath,
    payload,
  );
  const localPath = resolveLocalExportPath(localRelativePath, exportResult?.path);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  const artifactUrl = `${base}/api/export/artifact`;
  const tempPath = `${localPath}.download-${process.pid}-${Date.now()}.part`;
  try {
    const response = await fetch(artifactUrl, buildRemoteFetchOptions(artifactUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildRemoteProxyHeaders(),
      },
      body: JSON.stringify({ relativePath: remoteRelativePath }),
      timeout: REMOTE_REPLICATION_TIMEOUT_MS,
    }));
    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = String(await response.text() || "").trim();
      } catch (_) {
        detail = "";
      }
      throw new Error(
        detail || `Remote export download failed with HTTP ${response.status}`,
      );
    }
    await pipeline(response.body, createTransferWriteStream(tempPath));
    try {
      await fs.promises.unlink(localPath);
    } catch (_) {
      // Ignore when the destination does not exist yet.
    }
    await fs.promises.rename(tempPath, localPath);
    return buildExportResult(localPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore cleanup failures.
    }
    throw err;
  }
}

app.post("/api/energy/summary-source", async (req, res) => {
  try {
    const rows = await buildEnergySummarySourceRows(req.body || {});
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/export/artifact", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  try {
    const relativePath = normalizeExportRelativePath(
      req?.body?.relativePath,
      req?.body?.path,
    );
    const filePath = resolveLocalExportPath(relativePath, req?.body?.path);
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ ok: false, error: "Export file not found." });
    }
    const fileName = path.basename(filePath).replace(/"/g, "");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(Math.max(0, Number(stat.size || 0))));
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("x-export-relative-path", relativePath.replace(/\\/g, "/"));
    const stream = createTransferReadStream(filePath);
    stream.on("error", (err) => {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: String(err?.message || err) });
        return;
      }
      res.destroy(err);
    });
    stream.pipe(res);
  } catch (e) {
    const msg = String(e?.message || "");
    const code =
      String(e?.code || "").toUpperCase() === "ENOENT" ||
      /not found|no such file/i.test(msg)
        ? 404
        : 400;
    return res.status(code).json({ ok: false, error: e.message });
  }
});

app.post("/api/export/alarms", async (req, res) => {
  try {
    const payload = req.body || {};
    const minAlarmDurationSec = normalizeAlarmExportMinDurationSecServer(
      payload?.minAlarmDurationSec,
    );
    if (isRemoteMode()) {
      return res.json(await downloadRemoteExportToLocal("/api/export/alarms", payload));
    }
    validateExportDateRange(payload);
    const outPath = await runGatewayExportJob("alarms", () =>
      exporter.exportAlarms(payload),
    );
    return res.json(
      buildExportResult(outPath, {
        appliedFilters: {
          minAlarmDurationSec,
        },
      }),
    );
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});
app.post("/api/export/energy", async (req, res) => {
  try {
    if (isRemoteMode()) {
      return res.json(await downloadRemoteExportToLocal("/api/export/energy", req.body || {}));
    }
    const payload = req.body || {};
    validateExportDateRange(payload);
    const currentDaySnapshot = exportTouchesCurrentDay(payload)
      ? buildCurrentDayEnergySnapshot()
      : null;
    const outPath = await runGatewayExportJob("energy", () =>
      exporter.exportEnergy({
        ...payload,
        supplementalTodayRows: getEnergySummarySupplementRowsForRange(
          payload?.startTs,
          payload?.endTs,
          currentDaySnapshot,
        ),
      }),
    );
    return res.json(buildExportResult(outPath));
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});
app.post("/api/export/inverter-data", async (req, res) => {
  try {
    if (isRemoteMode()) {
      return res.json(
        await downloadRemoteExportToLocal("/api/export/inverter-data", req.body || {}),
      );
    }
    const payload = req.body || {};
    validateExportDateRange(payload);
    const outPath = await runGatewayExportJob("inverter-data", () =>
      exporter.exportInverterData(payload),
    );
    return res.json(buildExportResult(outPath));
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});
app.post("/api/export/5min", async (req, res) => {
  try {
    if (isRemoteMode()) {
      return res.json(await downloadRemoteExportToLocal("/api/export/5min", req.body || {}));
    }
    const payload = req.body || {};
    validateExportDateRange(payload);
    const outPath = await runGatewayExportJob("energy-5min", () =>
      exporter.export5min(payload),
    );
    return res.json(buildExportResult(outPath));
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});
app.post("/api/export/audit", async (req, res) => {
  try {
    if (isRemoteMode()) {
      return res.json(await downloadRemoteExportToLocal("/api/export/audit", req.body || {}));
    }
    const payload = req.body || {};
    validateExportDateRange(payload);
    const outPath = await runGatewayExportJob("audit", () =>
      exporter.exportAudit(payload),
    );
    return res.json(buildExportResult(outPath));
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});
app.post("/api/export/daily-report", async (req, res) => {
  try {
    if (isRemoteMode()) {
      return res.json(
        await downloadRemoteExportToLocal("/api/export/daily-report", req.body || {}),
      );
    }
    const payload = req.body || {};
    validateExportDateRange(payload);
    const currentDaySnapshot = exportTouchesCurrentDay(payload)
      ? buildCurrentDayEnergySnapshot({ includeDailyReportRows: true })
      : null;
    const outPath = await runGatewayExportJob("daily-report", async () => {
      const dateText = String(payload?.date || "").trim();
      if (dateText) {
        try {
          const day = parseIsoDateStrict(dateText, "date");
          if (day !== localDateStr()) {
            buildDailyReportRowsForDate(day, {
              persist: true,
              includeTodayPartial: false,
            });
          }
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
            if (day > today || day === today) continue;
            buildDailyReportRowsForDate(day, {
              persist: true,
              includeTodayPartial: false,
            });
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }
      const rowsByDate =
        currentDaySnapshot &&
        Array.isArray(currentDaySnapshot.dailyReportRows) &&
        currentDaySnapshot.dailyReportRows.length
          ? { [currentDaySnapshot.day]: currentDaySnapshot.dailyReportRows }
          : null;
      return exporter.exportDailyReport({
        ...payload,
        rowsByDate,
      });
    });
    return res.json(buildExportResult(outPath));
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});
app.post("/api/export/forecast-actual", async (req, res) => {
  try {
    const payload = req.body || {};
    validateExportDateRange(payload);
    const source = String(payload.source || "analytics").trim().toLowerCase();
    const isSolcast = source === "solcast";
    if (isRemoteMode()) {
      return res.json(
        await downloadRemoteExportToLocal("/api/export/forecast-actual", req.body || {}),
      );
    }
    const currentDaySnapshot = exportTouchesCurrentDay(payload)
      ? buildCurrentDayEnergySnapshot()
      : null;
    const rawOutPath = await runGatewayExportJob("forecast-actual", () =>
      exporter.exportForecastActual({
        ...payload,
        source,
        supplementalActualRows: buildForecastActualSupplementRowsForRange(
          payload?.startTs,
          payload?.endTs,
          currentDaySnapshot,
        ),
      }),
    );
    const subFolder = isSolcast ? "Solcast/Day-Ahead" : "Analytics/Day-Ahead";
    const outPath = await exporter.ensureForecastExportSubfolder(rawOutPath, subFolder);
    return res.json(buildExportResult(outPath));
  } catch (e) {
    return sendExportRouteError(res, e);
  }
});

// v2.8.14 — moved from 03:30 to 21:30. The 03:30 slot sat inside the
// Windows Automatic Maintenance + Windows Update install window. VACUUM
// is the heaviest disk I/O event of the night (full DB file rewrite +
// exclusive lock), so running it alongside Windows' own disk/update
// activity was the single largest overnight I/O collision on the gateway.
// 21:30 runs after the 21:00 cloud backup (typically <30s) and well
// before the 22:00 forecast cron, leaving a clean window for the VACUUM
// to complete before other heavy tasks resume.
cron.schedule("30 21 * * *", pruneOldData);

// Prune solcast_snapshot_history rows older than 90 days (v2.8+).
// v2.8.14 — moved from 03:35 to 21:35, keeping the 5-minute offset from
// pruneOldData so any long-running VACUUM has released its write lock.
cron.schedule("35 21 * * *", () => {
  try {
    const deleted = pruneSnapshotHistory(90);
    if (deleted > 0) {
      console.log(`[Cron:history-prune] Deleted ${deleted} solcast_snapshot_history rows older than 90 days`);
    }
  } catch (e) {
    console.warn("[Cron:history-prune] failed:", e.message);
  }
});

// ── Day-ahead forecast auto-generation fallback ──────────────────────────
// The Python forecast service runs primary day-ahead passes at 06:00 and 18:00
// plus a constant post-solar checker outside the solar window, but if it
// crashes, misses its window, or is not running, this Node cron
// ensures tomorrow's forecast still gets generated.
// Runs at 04:30, 09:30, 18:30, 20:00, and 22:00 — each checks if tomorrow's forecast
// is healthy (not only complete) and regenerates when provider/freshness policy fails.
// Gateway mode only.
for (const cronExpr of ["30 4 * * *", "30 9 * * *", "30 18 * * *", "0 20 * * *", "0 22 * * *"]) {
  cron.schedule(cronExpr, async () => {
    if (_forecastCronRunning) {
      console.warn(`[Cron:forecast] skipping ${cronExpr} — previous cron run still active`);
      return;
    }
    if (forecastGenerating) {
      console.warn(`[Cron:forecast] skipping ${cronExpr} — manual forecast generation in progress`);
      return;
    }
    _forecastCronRunning = true;
    // FIX-08: Safety timeout — auto-reset if cron generation hangs for 45 minutes
    const cronSafetyTimer = setTimeout(() => {
      if (_forecastCronRunning) {
        console.warn("[Cron:forecast] Safety timeout: cron running flag auto-reset after 45 minutes");
        _forecastCronRunning = false;
        // M5 fix: attempt to kill hanging forecast process
        if (_lastForecastPid) {
          try {
            if (process.platform === "win32") {
              require("child_process").execSync(`taskkill /pid ${_lastForecastPid} /T /F`, { stdio: "ignore" });
            } else {
              process.kill(_lastForecastPid, "SIGTERM");
            }
            console.warn(`[Cron:forecast] Killed hanging forecast process (PID ${_lastForecastPid})`);
          } catch {}
          _lastForecastPid = null;
        }
      }
    }, 45 * 60 * 1000);
    try {
      if (isRemoteMode()) return;
      const tomorrow = addDaysIso(localDateStr(), 1);
      try {
        const existing = countDayAheadSolarWindowRows(tomorrow);
        const quality = assessTomorrowForecastQuality(tomorrow);
        if (quality === "healthy") {
          console.log(`[Cron:forecast] Day-ahead for ${tomorrow} already exists (${existing} solar slots) and quality is healthy - skip`);
          return;
        }
        console.log(`[Cron:forecast] Day-ahead for ${tomorrow} triggers fallback. Quality: ${quality} (${existing}/${FORECAST_SOLAR_SLOT_COUNT} slots). Triggering Node fallback generator.`);
        // M4 fix: re-check concurrency before generation to close race window
        if (forecastGenerating) {
          console.warn(`[Cron:forecast] skipping ${cronExpr} — manual generation started during quality assessment`);
          return;
        }
        const result = await runDayAheadGenerationPlan({
          dates: [tomorrow],
          trigger: "node_fallback",
          replaceExisting: true,
        });
        console.log(
          `[Cron:forecast] Day-ahead for ${tomorrow} generated via Node fallback (provider=${result?.provider_used}, variant=${result?.forecast_variant}, ${result?.durationMs || 0}ms)`,
        );
        // M12: notify connected clients that new forecast data is available
        try { broadcastUpdate && broadcastUpdate({ type: "live" }); } catch {}
      } catch (err) {
        console.warn(`[Cron:forecast] Fallback generation for ${tomorrow} failed:`, err.message);
      }
    } finally {
      _forecastCronRunning = false;
      clearTimeout(cronSafetyTimer);
    }
  });
}

// ── Day-ahead locked snapshot (v2.8+) ─────────────────────────────────────
// At or before 10 AM local, freeze Solcast's P10/P50/P90 forecast for
// tomorrow into `solcast_dayahead_locked`. This is the "what we would
// submit to WESM FAS" snapshot, used by the error memory system to learn
// from what was actually submittable rather than from whatever Solcast
// said most recently (which gets overwritten on every pull).
//
// Runs at 06:00 (primary) and 09:55 (fallback). First-write-wins semantics
// in `solcast_dayahead_locked` make the 09:55 call a no-op on days when
// 06:00 succeeded, so running both is free insurance against failures.
const { captureDayAheadSnapshot } = require("./dayAheadLock");
let _dayAheadLockRunning = false;
async function runDayAheadLockCapture(cronExpr, captureReason) {
  if (_dayAheadLockRunning) {
    console.warn(`[Cron:dayahead-lock] skipping ${cronExpr} — previous run still active`);
    return;
  }
  if (isRemoteMode()) return;
  _dayAheadLockRunning = true;
  try {
    const tomorrow = addDaysIso(localDateStr(), 1);
    // Step 1: ensure Solcast has fresh data for tomorrow before we freeze it
    try {
      await autoFetchSolcastSnapshots([tomorrow], {
        toolkitHours: SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS,
      });
    } catch (fetchErr) {
      console.warn(
        `[Cron:dayahead-lock] pre-capture Solcast fetch failed (${captureReason}): ${fetchErr.message}`,
      );
      // Continue anyway — if the live solcast_snapshots table has any data
      // for tomorrow, we still want to lock it; a stale day-ahead is better
      // than no locked snapshot at all.
    }
    // Step 2: compute plant capacity in MW (helper returns kW)
    const plantCapKw = computePlantMaxKwFromConfig();
    const plantCapMw = Number.isFinite(plantCapKw) ? plantCapKw / 1000 : null;
    // Step 3: capture
    const result = await captureDayAheadSnapshot(tomorrow, captureReason, {
      plantCapMw,
    });
    if (result?.ok && result?.reason === "captured") {
      console.log(
        `[Cron:dayahead-lock] Locked day-ahead for ${tomorrow}: ` +
          `${result.inserted} slots, spread avg=${(result.spread_pct_cap_avg || 0).toFixed(1)}% ` +
          `max=${(result.spread_pct_cap_max || 0).toFixed(1)}% (${captureReason})`,
      );
    } else if (result?.ok && result?.reason === "already_locked") {
      console.log(
        `[Cron:dayahead-lock] ${tomorrow} already locked (${result.existing} slots); ${captureReason} no-op`,
      );
    } else {
      console.warn(
        `[Cron:dayahead-lock] ${tomorrow} capture failed (${captureReason}): ${JSON.stringify(result)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[Cron:dayahead-lock] unexpected error in ${cronExpr} (${captureReason}):`,
      err?.message || err,
    );
  } finally {
    _dayAheadLockRunning = false;
  }
}
// 06:00 local — primary lock attempt. Overnight NWP has landed by now and
// Solcast has usually published the fresh day-ahead forecast.
cron.schedule("0 6 * * *", () => runDayAheadLockCapture("0 6 * * *", "scheduled_0600"));
// 09:55 local — fallback. Runs 5 minutes before the WESM FAS 10 AM deadline
// so we always have a locked snapshot before submission even if 06:00 failed.
cron.schedule("55 9 * * *", () => runDayAheadLockCapture("55 9 * * *", "scheduled_0955"));
// 11:00 local — catch-up safety net (v2.8 audit R5).
// Past the WESM FAS deadline but still useful for the learning loop.
// Fires only if both 06:00 and 09:55 missed (e.g. dashboard down 05:00–10:00).
// First-write-wins semantics make this a no-op when an earlier cron succeeded.
cron.schedule("0 11 * * *", () => runDayAheadLockCapture("0 11 * * *", "scheduled_1100_catchup"));

// ── Intraday Solcast fetch fillers (v2.8 audit R1) ────────────────────────
// The existing cron schedule (04:30, 06:00, 09:30, 09:55, 18:30, 20:00, 22:00)
// leaves an 8.5-hour gap between 09:55 and 18:30. With the 4-hour age threshold,
// every Solcast snapshot from ~14:00 onward auto-downgrades to "stale_usable",
// reducing trust in the operator-trusted primary source during the hottest part
// of the solar day.
//
// Two extra lightweight fetches at 12:30 and 15:30 close that gap (max gap
// becomes 3.5h from 15:30 to 18:30, comfortably under the 4h freshness window).
// These do NOT trigger ML regeneration — they only refresh `solcast_snapshots`
// so the next intraday-adjusted forecast picks up the latest Solcast state.
let _intradaySolcastFetchRunning = false;
async function runIntradaySolcastFetch(cronExpr) {
  if (_intradaySolcastFetchRunning) {
    console.warn(`[Cron:solcast-intraday] skipping ${cronExpr} — previous run still active`);
    return;
  }
  if (isRemoteMode()) return;
  _intradaySolcastFetchRunning = true;
  try {
    const today = localDateStr();
    const tomorrow = addDaysIso(today, 1);
    const result = await autoFetchSolcastSnapshots([today, tomorrow], {
      toolkitHours: SOLCAST_TOOLKIT_PREVIEW_MAX_HOURS,
    });
    if (result?.pulled) {
      console.log(
        `[Cron:solcast-intraday ${cronExpr}] refreshed ${result.persisted} slots ` +
          `(history rows appended: ${result.historyRowsAppended || 0})`,
      );
    } else {
      console.warn(
        `[Cron:solcast-intraday ${cronExpr}] fetch failed: ${result?.reason || "unknown"}`,
      );
    }
  } catch (err) {
    console.warn(
      `[Cron:solcast-intraday ${cronExpr}] unexpected error:`,
      err?.message || err,
    );
  } finally {
    _intradaySolcastFetchRunning = false;
  }
}
cron.schedule("30 12 * * *", () => runIntradaySolcastFetch("30 12 * * *"));
cron.schedule("30 15 * * *", () => runIntradaySolcastFetch("30 15 * * *"));

// Startup hook (v2.8 audit R5): if it's already past 10:00 local at startup
// AND tomorrow has zero locked rows, fire a delayed catch-up. Covers the
// case where the dashboard was down all morning and missed all 3 cron fires.
// Also catches up today if unlocked (so the Day-Ahead vs Reality chart works).
// Delayed by 60 seconds to let DB / config / Solcast settings finish loading.
setTimeout(async () => {
  try {
    if (isRemoteMode()) return;
    const now = new Date();
    if (now.getHours() < 10) return; // before 10 AM, regular crons will catch it
    const today = localDateStr();
    const tomorrow = addDaysIso(today, 1);

    // Catch up today if unlocked (chart needs today's locked data)
    const existingToday = countDayAheadLockedForDay(today);
    if (existingToday === 0) {
      console.log(`[Startup:dayahead-lock] today ${today} not locked — firing catch-up capture`);
      try {
        const plantCapKw = computePlantMaxKwFromConfig();
        const plantCapMw = Number.isFinite(plantCapKw) ? plantCapKw / 1000 : null;
        const result = await captureDayAheadSnapshot(today, "startup_catchup_today", { plantCapMw });
        console.log(`[Startup:dayahead-lock] today ${today}: ${JSON.stringify(result)}`);
      } catch (err) {
        console.warn("[Startup:dayahead-lock] today catch-up failed:", err?.message || err);
      }
    } else {
      console.log(`[Startup:dayahead-lock] today ${today} already locked (${existingToday} slots)`);
    }

    // Catch up tomorrow
    const existingTomorrow = countDayAheadLockedForDay(tomorrow);
    if (existingTomorrow > 0) {
      console.log(`[Startup:dayahead-lock] tomorrow ${tomorrow} already locked (${existingTomorrow} slots) — no catch-up needed`);
      return;
    }
    console.log(
      `[Startup:dayahead-lock] tomorrow ${tomorrow} not locked — firing catch-up capture`,
    );
    runDayAheadLockCapture("startup-catchup", "startup_catchup").catch((err) => {
      console.warn("[Startup:dayahead-lock] catch-up failed:", err?.message || err);
    });
  } catch (err) {
    console.warn("[Startup:dayahead-lock] hook error:", err?.message || err);
  }
}, 60 * 1000).unref();

cron.schedule("15 18 * * *", () => {
  // 18:15 — shifted from 18:05 to avoid solar-close (17:55–18:00) archive+polling contention
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

// ── Post-solar QA evaluation ─────────────────────────────────────────────
// 18:20 — right after daily report (18:15), solar window closes at 18:00.
// Evaluates today's forecast vs actual so the dashboard shows eligible/insufficient
// the same evening instead of waiting for the next day's generation cycle.
cron.schedule("20 18 * * *", async () => {
  if (isRemoteMode()) return;
  try {
    console.log("[Cron:qa] Running post-solar QA evaluation for today...");
    const result = await runForecastGenerator(["--qa-today"]);
    console.log(`[Cron:qa] QA evaluation complete (${result?.durationMs || 0}ms)`);
  } catch (e) {
    console.warn("[Cron:qa] Post-solar QA evaluation failed:", e.message);
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

// Periodic GC for forecast job store — runs every 10 min regardless of traffic.
setInterval(_gcForecastJobs, 10 * 60 * 1000).unref();

const httpServer = app.listen(PORT, () => {
  // Keep gateway sockets alive longer so remote bridge keep-alive connections
  // don't hit a server-side close between polls. Node defaults to 5 s which is
  // shorter than the client's keepAliveMsecs (15 s), causing spurious ECONNRESET.
  httpServer.keepAliveTimeout = 30000;   // 30 s — well above client keepAlive
  httpServer.headersTimeout = 35000;     // must be > keepAliveTimeout per Node docs
  console.log(`[Inverter] Server on http://localhost:${PORT}`);
  // v2.8.10 Phase C: record an audit_log row for any abnormal boot-time
  // integrity state. Two distinct events:
  //   - restored  → corrupt main DB was auto-restored from a backup slot
  //   - unrescuable → all candidates were corrupt; a fresh empty DB was opened
  // Audit rows are the authoritative record; the renderer banner only lives
  // in memory and comes from /api/health/db-integrity.
  try {
    if (startupIntegrityResult?.restored) {
      const slot = Number(startupIntegrityResult.restoredFromSlot);
      const qc = String(startupIntegrityResult.quickCheck || "unknown");
      db
        .prepare(
          "INSERT INTO audit_log(ts, operator, action, scope, result, reason) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          Date.now(),
          "system",
          "db-auto-restore",
          "startup-integrity",
          "ok",
          `Restored adsi.db from backup slot ${slot} after corrupt quick_check (${qc})`,
        );
      console.log(`[DB] audit_log row written for auto-restore from slot ${slot}`);
    } else if (startupIntegrityResult?.unrescuable) {
      db
        .prepare(
          "INSERT INTO audit_log(ts, operator, action, scope, result, reason) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          Date.now(),
          "system",
          "db-unrescuable",
          "startup-integrity",
          "warning",
          "Main DB and all backup slots were corrupt — quarantined and opened a fresh empty DB. Cloud restore required for historical data.",
        );
      console.warn("[DB] audit_log row written for unrescuable-fresh-DB event");
    }
  } catch (err) {
    console.warn("[DB] Could not write startup-integrity audit row:", err?.message || err);
  }
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
    if (readOperationMode() === "remote") {
      console.log("[Forecast] Remote mode active; skipped startup forecast DB sync.");
    } else {
      if (readForecastProvider() !== "solcast") {
        const storedRows = countStoredForecastRows("forecast_dayahead");
        const incompleteDays = getIncompleteDayAheadContextDays();
        if (storedRows <= 0 || incompleteDays.length > 0) {
          const r = syncDayAheadFromContextIfNewer(true);
          if (r?.changed) {
            console.log(
              `[Forecast] Day-ahead sync -> DB: days=${Number(r.days || 0)} rows=${Number(r.rows || 0)}`,
            );
          }
        } else {
          console.log(
            `[Forecast] Startup legacy context import skipped; forecast_dayahead already has ${storedRows} stored row(s) and no incomplete context day(s).`,
          );
        }
      } else {
        console.log("[Forecast] Solcast provider selected; skipped legacy context sync.");
      }
      const trimmed = normalizeForecastDbWindow();
      if (trimmed > 0) {
        console.log(`[Forecast] Normalized DB forecast window (removed ${trimmed} row(s) outside 05:00-18:00).`);
      }
    }
  } catch (e) {
    console.warn("[Forecast] startup sync failed:", e.message);
  }
  startKeepAlive();
  if (plantCapController) {
    plantCapController.start();
  }
  applyRuntimeMode();
  // Auto-start go2rtc if enabled and in gateway mode
  if (!isRemoteMode() && getSetting("go2rtcAutoStart", "0") === "1") {
    go2rtcManager
      .start(true)
      .then((r) => {
        if (r.ok) console.log(`[go2rtc] auto-started (PID: ${r.pid})`);
        else console.warn(`[go2rtc] auto-start failed: ${r.error || "unknown"}`);
      })
      .catch((err) => console.warn(`[go2rtc] auto-start error: ${err.message}`));
  }
  if (process.send) process.send("ready");
});

// â"€â"€â"€ Cloud Backup API Routes â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

/**
 * v2.8.14: Local backup is gateway-only.
 * In remote mode the dashboard is a viewer/replica — the local adsi.db is an
 * in-memory shadow of the gateway's data, the archive folder is empty, and
 * ipconfig/license/auth tokens belong to the upstream gateway. Backing up the
 * remote install would silently produce a misleading .adsibak with stale or
 * absent data. Refuse the operation up-front and tell the operator where
 * backups DO need to run (on the gateway PC).
 *
 * /api/backup/health stays accessible because the renderer reads it on every
 * page load to decide what to show; in remote mode it just reports the
 * disabled-by-mode state instead.
 */
function _refuseBackupInRemoteMode(res) {
  return res.status(409).json({
    ok: false,
    error: "Local backup is only available in Gateway operation mode. " +
           "Run this from the gateway PC; the remote viewer is a replica and " +
           "cannot produce a meaningful backup.",
    code: "REMOTE_MODE_DISABLED",
  });
}

/** GET /api/backup/health — unified health snapshot for all backup paths */
app.get("/api/backup/health", (req, res) => {
  try {
    res.json({
      ok: true,
      checked: Date.now(),
      mode: readOperationMode(),
      gatewayOnly: true,
      health: _backupHealth.getSnapshot(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

/** POST /api/backup/auth/s3/connect — validate and store S3-compatible credentials */
app.post("/api/backup/auth/s3/connect", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const result = await _s3.connect({
      accessKeyId: body.accessKeyId,
      secretAccessKey: body.secretAccessKey,
    });
    res.json({ ok: true, provider: "s3", info: result });
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
    else if (provider === "s3") _s3.disconnect();
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
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
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
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
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
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
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

// --- Portable Backup (.adsibak) -----------------------------------------------

function _validateAdsibakPath(p, mustExist) {
  if (typeof p !== "string" || !p.trim()) return "path required";
  if (!p.toLowerCase().endsWith(".adsibak")) return "file must have .adsibak extension";
  if (mustExist && !fs.existsSync(p)) return "file not found";
  return null;
}

/** GET /api/backup/local-settings -- scheduled .adsibak config (R1) */
app.get("/api/backup/local-settings", (req, res) => {
  try {
    res.json({ ok: true, settings: _cloudBackup.getLocalBackupSettings() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/local-settings -- save scheduled .adsibak config (R1) */
app.post("/api/backup/local-settings", (req, res) => {
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
  try {
    const saved = _cloudBackup.saveLocalBackupSettings(req.body || {});
    res.json({ ok: true, settings: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/run-scheduled-portable -- manually trigger scheduled .adsibak */
app.post("/api/backup/run-scheduled-portable", (req, res) => {
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
  try {
    const cfg = _cloudBackup.getLocalBackupSettings();
    // Skip enqueueCloudOp here — runScheduledPortableBackup wraps its work in
    // _withBackupMutex internally. Going through the queue too would
    // double-serialize identically to how cron triggers it (which also
    // bypass enqueueCloudOp). Stay consistent with the cron path.
    _cloudBackup.runScheduledPortableBackup(cfg.destination, cfg.retention).catch((err) => {
      console.error("[backup] manual scheduled-portable run failed:", err.message);
    });
    res.json({ ok: true, status: "started", destination: cfg.destination });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/create-portable -- export full system backup to .adsibak */
app.post("/api/backup/create-portable", (req, res) => {
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
  const { destPath } = req.body || {};
  const err = _validateAdsibakPath(destPath, false);
  if (err) return res.status(400).json({ ok: false, error: err });
  try {
    const q = enqueueCloudOp("createPortableBackup", async () => {
      return _cloudBackup.createPortableBackup(destPath);
    });
    res.json({ ok: true, status: "queued", queuePosition: q.position, message: "Portable backup queued." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/validate-portable -- preview .adsibak without importing */
app.post("/api/backup/validate-portable", async (req, res) => {
  const { srcPath } = req.body || {};
  const err = _validateAdsibakPath(srcPath, true);
  if (err) return res.status(400).json({ ok: false, error: err });
  try {
    const result = await _cloudBackup.validatePortableBackup(srcPath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/import-portable -- extract and register .adsibak */
app.post("/api/backup/import-portable", (req, res) => {
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
  const { srcPath } = req.body || {};
  const err = _validateAdsibakPath(srcPath, true);
  if (err) return res.status(400).json({ ok: false, error: err });
  try {
    const q = enqueueCloudOp("importPortableBackup", async () => {
      return _cloudBackup.importPortableBackup(srcPath);
    });
    res.json({ ok: true, status: "queued", queuePosition: q.position, message: "Import queued." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/backup/restore-portable/:id -- full restore including archive/license/auth */
app.post("/api/backup/restore-portable/:id", (req, res) => {
  if (isRemoteMode()) return _refuseBackupInRemoteMode(res);
  const backupId = decodeURIComponent(req.params.id);
  const { skipSafetyBackup } = req.body || {};
  try {
    const q = enqueueCloudOp("restorePortableBackup", async () => {
      await _cloudBackup.restorePortableBackup(backupId, {
        skipSafetyBackup: !!skipSafetyBackup,
      });
    });
    res.json({ ok: true, status: "queued", queuePosition: q.position, message: "Portable restore queued." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// â"€â"€â"€ Graceful Shutdown â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
let _shutdownCalled = false;
let _shutdownPromise = null;
let _flushClosed = false;

function _flushAndClose() {
  if (_flushClosed) return;
  _flushClosed = true;
  try { poller.flushPending(); } catch (_) {}   // recover last ~1 s of readings
  cleanupGatewayMainDbSnapshotSync();
  closeDb();                                      // WAL checkpoint + db.close
}

// Yield to libuv so handles entering UV_HANDLE_CLOSING can finish closing
// before the next phase runs. setImmediate runs after I/O polling, which
// is where libuv actually drains close callbacks. process.nextTick is
// NOT equivalent — it fires before the close-processing pass.
function _yieldToLibuv() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function _runShutdownPhases(mode, reason) {
  if (mode === "embedded") {
    console.log("[Server] Embedded shutdown: flushing DB...");
  } else {
    console.log(`[Server] Graceful shutdown (${reason || "signal"}): flushing DB...`);
  }

  // Phase 1 (sync): stop new work. Abort in-flight fetches; stop interval-
  // driven subsystems. These only flip flags / clear timers / fire
  // AbortControllers — they do NOT await the handles to finish closing.
  try { stopRemoteBridge(); } catch (_) {}
  try { stopRemoteChatBridge(); } catch (_) {}
  if (plantCapController) {
    try { plantCapController.stop(); } catch (_) {}
  }

  // Yield: let the uv_async_t handles owned by the aborted fetch requests
  // transition out of UV_HANDLE_CLOSING before the next close wave.
  await _yieldToLibuv();

  // Phase 2: poller (sync) + go2rtc (async — spawns taskkill child). The
  // pre-refactor code called go2rtcManager.stop() without awaiting, so the
  // child exit could still be in flight when _flushAndClose() ran. Await
  // here closes that window too.
  try { poller.stop(); } catch (_) {}
  try {
    const p = go2rtcManager.stop();
    if (p && typeof p.then === "function") {
      // go2rtc has its own internal SHUTDOWN_TIMEOUT_MS + SIGKILL fallback,
      // so this await always settles. Guard with a hard ceiling anyway.
      await Promise.race([
        p,
        new Promise((resolve) => {
          const t = setTimeout(resolve, 3000);
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
    }
  } catch (_) {}

  // Yield: let go2rtc's taskkill uv_async_t finish closing before we tear
  // down the HTTP server.
  await _yieldToLibuv();

  // Phase 3: close HTTP server with a 2 s deadline. If keep-alive sockets
  // linger, the timer short-circuits so shutdown stays bounded.
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let deadline = null;
    try {
      deadline = setTimeout(finish, 2000);
      if (deadline && typeof deadline.unref === "function") deadline.unref();
      httpServer.close(() => {
        if (deadline) clearTimeout(deadline);
        finish();
      });
    } catch (_) {
      if (deadline) clearTimeout(deadline);
      finish();
    }
  });

  // Phase 4: DB flush LAST, when no more event-loop traffic can touch it.
  _flushAndClose();
}

function _beginShutdown(mode, reason) {
  if (_shutdownPromise) return _shutdownPromise;
  _shutdownCalled = true;
  _shutdownPromise = _runShutdownPhases(mode, reason).catch((err) => {
    // Never let a shutdown failure leave the DB half-open.
    try { console.error("[Server] Shutdown error:", err); } catch (_) {}
    try { _flushAndClose(); } catch (_) {}
  });
  return _shutdownPromise;
}

// Called when running as a spawned child process (dev mode or future use).
function gracefulShutdown(reason) {
  const shutdownPromise = _beginShutdown("child", reason);
  shutdownPromise.finally(() => process.exit(0));
  // Safety ceiling: the serialized shutdown has up to ~5 s of work in the
  // worst case (3 s go2rtc SIGKILL fallback + 2 s httpServer close). Force
  // exit at 6 s so a stuck handle cannot keep the process alive forever.
  setTimeout(() => { _flushAndClose(); process.exit(0); }, 6000).unref();
}

// Called when running embedded in the Electron main process (packaged mode).
// Must NOT call process.exit â€" Electron controls the lifecycle.
function shutdownEmbedded() {
  return _beginShutdown("embedded");
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("message", (msg) => {
  if (msg && msg.type === "shutdown") gracefulShutdown("ipc");
});

// Safety net: ensure DB flush/close on any exit path, including unexpected crashes.
process.on("exit", () => {
  try { _flushAndClose(); } catch (_) {}
});

process.on("uncaughtException", (err) => {
  const code = String(err?.code || "");
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
  console.error("[Server] Uncaught exception — flushing DB:", err);
  try { _flushAndClose(); } catch (_) {}
});

process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection:", reason);
});

// â"€â"€â"€ Periodic WAL Checkpoint â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Keeps the WAL file from growing unbounded between auto-checkpoints.
setInterval(() => {
  // Defer checkpoint off the timer callback so it doesn't stack on queued work
  setImmediate(() => {
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch (_) {}
  });
}, 15 * 60 * 1000).unref();

// â"€â"€â"€ Periodic DB Backup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Rotates between 2 backup files every 2 hours. Uses SQLite's online backup API
// so it never blocks reads/writes and is always consistent.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
let _backupSlot = 0;
async function runPeriodicBackup() {
  // v2.8.14: skip Tier 1 in remote mode. The local DB is an in-memory shadow
  // of the gateway's data (see "Viewer model" notes in this file); copying it
  // to backups/adsi_backup_*.db would be misleading — operators might think
  // they have a recoverable snapshot when they don't.
  if (isRemoteMode()) {
    return;
  }
  // v2.8.14: defensive skip when a restore or another backup is in flight.
  // runPeriodicBackup doesn't go through CloudBackupService's mutex, so
  // without this check Tier 1's db.backup() could read a half-overwritten
  // adsi.db while a manual restore's fs.copyFileSync is mid-flight, capturing
  // a corrupt snapshot into the rotating slot. The state machine guarantees
  // the next 2h tick will succeed once the in-flight op finishes. We log the
  // skip but do NOT record it as a failure — a deliberate defer must not
  // increment the consecutive-failures counter (which would trigger an alert).
  try {
    const progress = _cloudBackup?.getProgress?.();
    const busyStatuses = new Set(["creating", "uploading", "restoring", "pulling"]);
    if (progress && busyStatuses.has(progress.status)) {
      console.log(`[DB] Tier 1 backup skipped: ${progress.status} in progress.`);
      return;
    }
  } catch (_) { /* progress unavailable — proceed */ }
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (_) {}
  const dest = path.join(BACKUP_DIR, `adsi_backup_${_backupSlot}.db`);
  _backupSlot = (_backupSlot + 1) % 2;
  const startedAt = Date.now();
  try {
    await db.backup(dest);
    let sizeBytes = null;
    try { sizeBytes = fs.statSync(dest).size; } catch (_) {}
    console.log("[DB] Backup written:", dest);
    _backupHealth.recordAttempt("tier1", true, {
      destination: dest,
      sizeBytes,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("[DB] Backup failed:", err.message);
    _backupHealth.recordAttempt("tier1", false, {
      destination: dest,
      error: err.message,
      durationMs: Date.now() - startedAt,
    });
  }
}
setInterval(runPeriodicBackup, 2 * 60 * 60 * 1000).unref();
setTimeout(runPeriodicBackup, 60 * 1000).unref(); // startup backup after 60 s
// Tier 1 fires every 2h. Surface the next-scheduled time in the health snapshot
// so the admin panel can show "Next at HH:mm". In remote mode runPeriodicBackup
// returns early, so clear the next-scheduled timestamp instead of advertising
// a future backup that will never actually run.
function _refreshTier1NextScheduled() {
  if (isRemoteMode()) {
    _backupHealth.setNextScheduled("tier1", null);
    return;
  }
  _backupHealth.setNextScheduled("tier1", Date.now() + 2 * 60 * 60 * 1000);
}
setTimeout(_refreshTier1NextScheduled, 60 * 1000 + 500).unref();
setInterval(_refreshTier1NextScheduled, 2 * 60 * 60 * 1000).unref();

module.exports = { shutdownEmbedded };

// Test hooks for solcastLazyBackfill tests
if (process.env.NODE_ENV === "test") {
  if (!global.__adsiTestHooks) {
    global.__adsiTestHooks = {};
  }
  global.__adsiTestHooks.lazyBackfillSolcastSnapshotIfMissing = lazyBackfillSolcastSnapshotIfMissing;
  global.__adsiTestHooks.resetLazyBackfillAttempts = () => {
    _solcastLazyBackfillAttempts.clear();
  };
  global.__adsiTestHooks.setSolcastLazyBackfillCooldown = (ms) => {
    SOLCAST_LAZY_BACKFILL_COOLDOWN_MS = Number(ms || 0);
  };
  global.__adsiTestHooks.setRemoteMode = (enabled) => {
    // Store in a test variable; we'll need to hook into isRemoteMode
    global.__adsiTestHooks._forceRemoteMode = enabled;
  };
}
