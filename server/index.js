"use strict";
const express = require("express");
const expressWs = require("express-ws");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
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
} = require("./db");
const { registerClient, broadcastUpdate } = require("./ws");
const poller = require("./poller");
const exporter = require("./exporter");
const {
  getActiveAlarms,
  decodeAlarm,
  formatAlarmHex,
  logControlAction,
  getAuditLog,
} = require("./alarms");

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
app.use(express.json());
app.use("/assets", express.static(path.join(__dirname, "../assets")));
app.use(express.static(path.join(__dirname, "../public")));
app.use("/api", remoteApiTokenGate);
const PORT = 3500;
const PORTABLE_ROOT = String(process.env.ADSI_PORTABLE_DATA_DIR || "").trim();
const PROGRAMDATA_ROOT = PORTABLE_ROOT
  ? path.join(PORTABLE_ROOT, "programdata")
  : path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ADSI-InverterDashboard");
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
const REMOTE_BRIDGE_INTERVAL_MS = 1200;
const REMOTE_FETCH_TIMEOUT_MS = 5000;
const REMOTE_REPLICATION_TIMEOUT_MS = 120000;
const REMOTE_REPLICATION_RETRY_MS = 30000;
const REMOTE_INCREMENTAL_INTERVAL_MS = 3000;
const REMOTE_INCREMENTAL_APPEND_LIMIT = 20000;
const LIVE_FRESH_MS = 20000;
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
  replicationRunning: false,
  lastReplicationAttemptTs: 0,
  lastReplicationTs: 0,
  lastReplicationError: "",
  lastReplicationSignature: "",
  lastReplicationRows: 0,
  lastIncrementalTs: 0,
  replicationCursors: null,
};

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
  if (!isHttpUrl(raw)) return "";
  return raw.replace(/\/+$/, "");
}

function readOperationMode() {
  return sanitizeOperationMode(getSetting("operationMode", "gateway"), "gateway");
}

function isRemoteMode() {
  return readOperationMode() === "remote";
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
  if (p === "/settings" || p.startsWith("/settings/")) return false;
  if (p === "/runtime/network" || p.startsWith("/runtime/network/")) return false;
  if (p === "/tailscale/status" || p.startsWith("/tailscale/status/")) return false;
  if (p === "/wireguard/status" || p.startsWith("/wireguard/status/")) return false;
  if (p === "/runtime/network/test" || p.startsWith("/runtime/network/test/"))
    return false;
  if (p === "/live" || p.startsWith("/live/")) return false;
  if (p === "/write" || p.startsWith("/write/")) return false;
  return true;
}

function getRuntimeLiveData() {
  return isRemoteMode() ? remoteBridgeState.liveData || {} : poller.getLiveData();
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
    let importedRows = 0;
    for (const def of REPLICATION_TABLE_DEFS) {
      const incoming = Array.isArray(tables[def.name]) ? tables[def.name] : [];
      db.prepare(`DELETE FROM ${def.name}`).run();
      if (!incoming.length) continue;

      const cols = def.columns;
      const sql = `INSERT INTO ${def.name} (${cols.join(", ")}) VALUES (${cols
        .map((c) => `@${c}`)
        .join(", ")})`;
      const stmt = db.prepare(sql);
      for (const row of incoming) {
        const payload = {};
        for (const c of cols) {
          payload[c] = Object.prototype.hasOwnProperty.call(row || {}, c) ? row[c] : null;
        }
        stmt.run(payload);
        importedRows += 1;
      }
    }

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

    return { importedRows, nextCursors };
  });

  const applied = importTx();
  return {
    importedRows: Number(applied?.importedRows || 0),
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

  const tx = db.transaction(() => {
    let importedRows = 0;
    for (const def of REPLICATION_TABLE_DEFS) {
      const incoming = Array.isArray(tables[def.name]) ? tables[def.name] : [];
      if (!incoming.length) continue;
      const cols = def.columns;
      const sql = `INSERT OR REPLACE INTO ${def.name} (${cols.join(", ")}) VALUES (${cols
        .map((c) => `@${c}`)
        .join(", ")})`;
      const stmt = db.prepare(sql);

      for (const row of incoming) {
        if (
          def.name === "settings" &&
          REMOTE_REPLICATION_PRESERVE_SETTING_KEYS.has(String(row?.key || "").trim())
        ) {
          continue;
        }
        const payload = {};
        for (const c of cols) {
          payload[c] = Object.prototype.hasOwnProperty.call(row || {}, c) ? row[c] : null;
        }
        stmt.run(payload);
        importedRows += 1;
      }
    }

    const safe = saveReplicationCursorsSetting(nextCursors);
    setSetting("remoteReplicationLastTs", String(Date.now()));
    if (signature) setSetting("remoteReplicationLastSignature", signature);
    return { importedRows, safeCursors: safe };
  });

  const applied = tx();
  return {
    importedRows: Number(applied?.importedRows || 0),
    nextCursors: normalizeReplicationCursors(applied?.safeCursors || nextCursors),
    hasMoreAny,
    signature,
  };
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

    return { ok: true, ...stats };
  } catch (err) {
    remoteBridgeState.lastReplicationError = String(err?.message || err);
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
    let cursors = normalizeReplicationCursors(
      remoteBridgeState.replicationCursors || readReplicationCursorsSetting(),
    );

    do {
      const r = await fetch(`${baseUrl}/api/replication/incremental`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildRemoteProxyHeaders(),
        },
        body: JSON.stringify({ cursors }),
        timeout: REMOTE_REPLICATION_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`Incremental replication HTTP ${r.status} ${r.statusText}`);
      const data = await r.json();
      if (!data?.ok || !data?.delta) {
        throw new Error(String(data?.error || "Gateway returned invalid incremental payload."));
      }

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
    return { ok: true, importedRows, hasMore, batches, signature, nextCursors: cursors };
  } catch (err) {
    remoteBridgeState.lastReplicationError = String(err?.message || err);
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
      timeout: REMOTE_FETCH_TIMEOUT_MS,
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

async function pollRemoteLiveOnce() {
  const wasConnected = Boolean(remoteBridgeState.connected);
  const now = Date.now();
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
    if (!wasConnected) {
      runRemoteFullReplication(base).catch(() => {});
    } else if (
      !remoteBridgeState.lastReplicationTs &&
      !remoteBridgeState.replicationRunning &&
      now - Number(remoteBridgeState.lastReplicationAttemptTs || 0) >=
        REMOTE_REPLICATION_RETRY_MS
    ) {
      runRemoteFullReplication(base).catch(() => {});
    } else if (
      remoteBridgeState.lastReplicationTs &&
      !remoteBridgeState.replicationRunning &&
      now - Number(remoteBridgeState.lastIncrementalTs || 0) >= REMOTE_INCREMENTAL_INTERVAL_MS
    ) {
      runRemoteIncrementalReplication(base).catch(() => {});
    }
  } catch (err) {
    remoteBridgeState.connected = false;
    remoteBridgeState.lastError = String(err.message || err);
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
}

function startRemoteBridge() {
  if (remoteBridgeState.running) return;
  remoteBridgeState.running = true;
  remoteBridgeState.replicationCursors = readReplicationCursorsSetting();
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
    poller.stop();
    startRemoteBridge();
  } else {
    stopRemoteBridge();
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
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
    remoteGatewayUrl: "",
    remoteApiToken: "",
    tailscaleDeviceHint: "",
    wireguardInterface: "",
    apiUrl: `${INVERTER_ENGINE_BASE_URL}/data`,
    writeUrl: `${INVERTER_ENGINE_BASE_URL}/write`,
    csvSavePath: "C:\\Logs\\ADSI",
    inverterCount: "27",
    nodeCount: "4",
    invGridLayout: "4",
    plantName: "ADSI Solar Plant",
    operatorName: "OPERATOR",
    retainDays: "90",
    forecastProvider: "ml_local",
    solcastBaseUrl: "https://api.solcast.com.au",
    solcastApiKey: "",
    solcastResourceId: "",
    solcastTimezone: "Asia/Manila",
    remoteReplicationCursors: JSON.stringify(normalizeReplicationCursors({})),
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
  const explicit = String(process.env.ADSI_FORECAST_PATH || "").trim();
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
  const dtCapSec = 10;

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
  const s = startOfLocalDayMs(Date.now());
  const e = Date.now();
  const rows = buildPacEnergyBuckets({
    inverter: "all",
    startTs: s,
    endTs: e,
    bucketMin: 5,
  });
  const byInv = new Map();
  for (const r of rows) {
    const inv = Number(r?.inverter || 0);
    if (!inv) continue;
    byInv.set(inv, Number(byInv.get(inv) || 0) + Number(r?.kwh_inc || 0));
  }
  const out = [];
  for (const [inv, total] of byInv.entries()) {
    out.push({
      inverter: Number(inv),
      total_kwh: Number(total.toFixed(6)),
    });
  }
  out.sort((a, b) => a.inverter - b.inverter);
  return out;
}

const getAlarmCountByInverterStmt = db.prepare(
  "SELECT COUNT(*) AS cnt FROM alarms WHERE inverter=? AND ts BETWEEN ? AND ?",
);

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
  const pacRows = buildPacEnergyBuckets({
    inverter: "all",
    startTs,
    endTs,
    bucketMin: 5,
  });

  const pacKwhByInv = new Map();
  for (const row of pacRows) {
    const inv = Number(row?.inverter || 0);
    if (!inv) continue;
    const next =
      Number(pacKwhByInv.get(inv) || 0) + Number(row?.kwh_inc || 0);
    pacKwhByInv.set(inv, next);
  }

  const out = [];
  for (let inv = 1; inv <= invCount; inv++) {
    const rows = stmts.getReadingsRange.all(inv, startTs, endTs);
    const alarmCount = Number(
      getAlarmCountByInverterStmt.get(inv, startTs, endTs)?.cnt || 0,
    );
    const pacKwh = Number(pacKwhByInv.get(inv) || 0);
    const hasLiveData = rows.length > 0 || pacKwh > 0 || alarmCount > 0;
    if (!hasLiveData) continue;

    const onlineRows = rows.filter(
      (r) => Number(r?.online || 0) === 1 && Number(r?.pac || 0) > 0,
    );
    const pacValues = rows
      .map((r) => Number(r?.pac || 0))
      .filter((v) => Number.isFinite(v) && v >= 0);

    const pacPeak = pacValues.length ? Math.max(...pacValues) : 0;
    const pacAvg = onlineRows.length
      ? onlineRows.reduce((s, r) => s + Number(r?.pac || 0), 0) /
        onlineRows.length
      : 0;
    // Compute uptime from the actual timestamp span of online readings (not row count).
    const uptimeS = onlineRows.length >= 2
      ? Math.max(0, (Number(onlineRows[onlineRows.length - 1]?.ts || 0) - Number(onlineRows[0]?.ts || 0)) / 1000)
      : onlineRows.length === 1 ? 1 : 0;

    let kwhTotal = Math.max(0, pacKwh);
    if (kwhTotal <= 0 && rows.length >= 2) {
      const firstKwh = Number(rows[0]?.kwh || 0);
      const lastKwh = Number(rows[rows.length - 1]?.kwh || 0);
      const regDiff = lastKwh - firstKwh;
      if (Number.isFinite(regDiff) && regDiff > 0) kwhTotal = regDiff;
    }

    const row = {
      date: day,
      inverter: inv,
      kwh_total: Number(kwhTotal.toFixed(6)),
      pac_peak: Number(Math.max(0, pacPeak).toFixed(3)),
      pac_avg: Number(Math.max(0, pacAvg).toFixed(3)),
      uptime_s: Math.max(0, Math.round(uptimeS)),
      alarm_count: Math.max(0, Math.trunc(alarmCount)),
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
      );
    }

    out.push(row);
  }

  out.sort((a, b) => a.inverter - b.inverter);
  return out;
}

function calcAvailabilityPctFromRow(row) {
  const kwh = Number(row?.kwh_total || 0);
  const peakKw = Number(row?.pac_peak || 0) / 1000;
  const uph = Number(row?.uptime_s || 0) / 3600;
  const denom = peakKw * uph;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  const pct = (kwh / denom) * 100;
  return Math.max(0, Math.min(100, pct));
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
    const rowDenom = Math.max(0, rowPeakKw * uph);

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
      Math.max(0, Math.min(100, availabilityAvgPct)).toFixed(3),
    ),
    performance_pct: Number(Math.max(0, Math.min(100, perfPct)).toFixed(3)),
  };
}

function buildDailyWeeklyReportSummary(targetDateText) {
  const day = parseIsoDateStrict(targetDateText || localDateStr(), "date");
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
  const isFutureDay = day > today;
  let dailyRows = [];
  if (!isFutureDay) {
    dailyRows = buildDailyReportRowsForDate(day, {
      persist: true,
      includeTodayPartial: isToday,
    });
  } else {
    dailyRows = stmts.getDailyReport.all(day);
  }
  byDateRows.set(day, dailyRows);

  for (const d of dates) {
    if (d === day) continue;
    let rows = stmts.getDailyReport.all(d);
    if (!rows.length && d <= today) {
      rows = buildDailyReportRowsForDate(d, {
        persist: true,
        includeTodayPartial: d === today,
      });
    }
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
  const update = db.prepare(
    `UPDATE audit_log
     SET ip = ?
     WHERE inverter = ?
       AND (
         ip IS NULL OR TRIM(ip) = '' OR LOWER(TRIM(ip)) IN ('::1','127.0.0.1','localhost','::ffff:127.0.0.1')
       )`,
  );
  const tx = db.transaction(() => {
    for (let inv = 1; inv <= 27; inv++) {
      const ip = String(invMap[inv] ?? invMap[String(inv)] ?? "").trim();
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
        plantName: getSetting("plantName", "ADSI Solar Plant"),
      },
    }),
  );
});

app.get("/api/live", (req, res) => res.json(getRuntimeLiveData()));

app.get("/api/replication/full", async (req, res) => {
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

app.post("/api/write", async (req, res) => {
  if (isRemoteMode()) {
    return proxyToRemote(req, res);
  }
  const url = getSetting("writeUrl", `${INVERTER_ENGINE_BASE_URL}/write`);
  const { inverter, node, unit, value, scope, operator, authKey } = req.body || {};
  const invNum = Number(inverter);
  const unitNum = Number(unit ?? node);
  const valueNum = Number(value);

  if (!Number.isFinite(invNum) || invNum < 1) {
    return res.status(400).json({ ok: false, error: "Invalid inverter" });
  }
  if (!Number.isFinite(unitNum) || unitNum < 1 || unitNum > 4) {
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
    csvSavePath: getSetting("csvSavePath", "C:\\Logs\\ADSI"),
    inverterCount: Number(getSetting("inverterCount", 27)),
    nodeCount: Number(getSetting("nodeCount", 4)),
    invGridLayout: sanitizeInvGridLayout(getSetting("invGridLayout", "4")),
    plantName: getSetting("plantName", "ADSI Solar Plant"),
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
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/settings", (req, res) => {
  const updates = {};
  const modeBefore = readOperationMode();
  const remoteGatewayBefore = getRemoteGatewayBaseUrl();
  const remoteTokenBefore = getRemoteApiToken();
  const {
    operationMode,
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
  } =
    req.body || {};

  if (operationMode !== undefined) {
    updates.operationMode = sanitizeOperationMode(operationMode, "gateway");
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
    if (!isHttpUrl(apiUrl))
      return res.status(400).json({ ok: false, error: "Invalid apiUrl" });
    updates.apiUrl = apiUrl;
  }
  if (writeUrl !== undefined) {
    if (!isHttpUrl(writeUrl))
      return res.status(400).json({ ok: false, error: "Invalid writeUrl" });
    updates.writeUrl = writeUrl;
  }
  if (csvSavePath !== undefined) {
    const pathVal = String(csvSavePath).trim();
    if (!pathVal)
      return res.status(400).json({ ok: false, error: "Invalid csvSavePath" });
    updates.csvSavePath = pathVal;
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
  }
  res.json({ ok: true });
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
    remoteReplicationCursors: normalizeReplicationCursors(
      remoteBridgeState.replicationCursors || readReplicationCursorsSetting(),
    ),
    tailscale: getTailscaleStatusSnapshot(),
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
  res.json(
    rows
      .filter((r) =>
        configured.has(`${Number(r.inverter) || 0}_${Number(r.unit) || 0}`),
      )
      .map((r) => enrichAlarmRow(r, nowTs)),
  );
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
  const { start, end, inverter, limit } = req.query;
  const s = parseDateMs(start, Date.now() - 7 * 86400000, false);
  const e = parseDateMs(end, Date.now(), true);
  res.json(
    getAuditLog({
      start: s,
      end: e,
      inverter: inverter && inverter !== "all" ? Number(inverter) : null,
      limit: Number(limit) || 500,
    }),
  );
});

app.get("/api/energy/5min", (req, res) => {
  const { inverter, start, end } = req.query;
  const s = start ? Number(start) : Date.now() - 86400000;
  const e = end ? Number(end) : Date.now();
  if (s >= e) return res.status(400).json({ ok: false, error: "start must be before end" });
  res.json(
    !inverter || inverter === "all"
      ? stmts.get5minRangeAll.all(s, e)
      : stmts.get5minRange.all(Number(inverter), s, e),
  );
});

// Analytics-specific energy source:
// Always PAC-integrated kWh buckets (never register kWh deltas).
app.get("/api/analytics/energy", (req, res) => {
  const { inverter, start, end, bucketMin } = req.query;
  const s = start ? Number(start) : Date.now() - 86400000;
  const e = end ? Number(end) : Date.now();
  if (s >= e) return res.status(400).json({ ok: false, error: "start must be before end" });
  const bm = clampInt(bucketMin, 1, 60, 5);
  const pacRows = buildPacEnergyBuckets({
    inverter: inverter || "all",
    startTs: s,
    endTs: e,
    bucketMin: bm,
  });
  if (pacRows.length) {
    res.json(pacRows);
    return;
  }
  // Safety fallback: don't leave charts blank if PAC reconstruction has no range rows.
  res.json(
    !inverter || inverter === "all"
      ? stmts.get5minRangeAll.all(s, e)
      : stmts.get5minRange.all(Number(inverter), s, e),
  );
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
    const rows = buildTodayPacTotalsFromDb();
    if (rows.length) {
      res.json(rows);
      return;
    }
  } catch (e) {
    console.warn("[energy/today] DB PAC total failed:", e.message);
  }
  // Fallback to in-memory live integrator if DB query returns empty/unavailable.
  res.json(poller.getTodayPacKwh());
});

app.get("/api/report/daily", (req, res) => {
  try {
    const { date, start, end, refresh } = req.query;
    if (date) {
      const day = parseIsoDateStrict(date, "date");
      const isToday = day === localDateStr();
      const forceRefresh = String(refresh || "").trim() === "1" || isToday;

      if (!forceRefresh) {
        const cached = stmts.getDailyReport.all(day);
        if (cached.length) return res.json(cached);
      }

      const generated = buildDailyReportRowsForDate(day, {
        persist: true,
        includeTodayPartial: true,
      });
      if (generated.length) return res.json(generated);
      return res.json(stmts.getDailyReport.all(day));
    }

    const s = start || localDateStr(Date.now() - 7 * 86400000);
    const e = end || localDateStr();
    return res.json(stmts.getDailyReportRange.all(s, e));
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/api/report/summary", (req, res) => {
  try {
    const day = parseIsoDateStrict(req.query?.date || localDateStr(), "date");
    return res.json(buildDailyWeeklyReportSummary(day));
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
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

app.listen(PORT, () => {
  console.log(`[Inverter] Server on http://localhost:${PORT}`);
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
