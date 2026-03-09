"use strict";
/**
 * db.js — SQLite database layer (WAL mode, production hardened)
 * Adds: audit_log table for control action tracking
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXPLICIT_DATA_DIR = String(process.env.IM_DATA_DIR || "").trim();
const PORTABLE_ROOT = String(process.env.IM_PORTABLE_DATA_DIR || "").trim();
function resolveDataDir() {
  if (EXPLICIT_DATA_DIR) return EXPLICIT_DATA_DIR;
  if (PORTABLE_ROOT) return path.join(PORTABLE_ROOT, "db");
  if (process.env.APPDATA) {
    const preferred = path.join(process.env.APPDATA, "Inverter-Dashboard");
    const legacy    = path.join(process.env.APPDATA, "ADSI-Dashboard");
    // Migrate: if old dir exists and new does not, rename it transparently.
    if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
      try { fs.renameSync(legacy, preferred); } catch (_) { return legacy; }
    }
    return preferred;
  }
  return path.join(os.homedir(), ".inverter-dashboard");
}

function pad2(n) {
  return String(Math.trunc(Number(n) || 0)).padStart(2, "0");
}

function localDateStr(ts = Date.now()) {
  const d = new Date(Number(ts || Date.now()));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthKeyFromTs(ts) {
  const d = new Date(Number(ts || 0));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function iterateMonthKeys(startTs, endTs) {
  const start = new Date(Number(startTs || 0));
  const end = new Date(Number(endTs || 0));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
  if (start.getTime() > end.getTime()) return [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const stop = new Date(end.getFullYear(), end.getMonth(), 1);
  const out = [];
  while (cur.getTime() <= stop.getTime()) {
    out.push(`${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}
const DATA_DIR = resolveDataDir();

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "adsi.db");
const MAIN_DB_PENDING_REPLACEMENT_PATH = path.join(
  DATA_DIR,
  ".pending-main-db-replacement.json",
);
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const SUMMARY_SOLAR_START_H = 5;
const SUMMARY_SOLAR_END_H = 18;
const SUMMARY_MAX_GAP_S = 120;
const ARCHIVE_BATCH_SIZE = 5000;
const ARCHIVE_DB_CACHE = new Map();
const ARCHIVE_DB_REPLACE_LOCKS = new Set();
const STARTUP_COMPACT_MAX_BYTES = 64 * 1024 * 1024;
const READING_STORAGE_COLUMNS = [
  "id",
  "ts",
  "inverter",
  "unit",
  "pac",
  "kwh",
  "alarm",
  "online",
];
const READING_VALUE_COLUMNS = READING_STORAGE_COLUMNS.filter((col) => col !== "id");
const READING_SELECT_SQL = READING_VALUE_COLUMNS.join(",");
const READING_TABLE_DDL = `
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  inverter  INTEGER NOT NULL,
  unit      INTEGER NOT NULL,
  pac       REAL DEFAULT 0,
  kwh       REAL DEFAULT 0,
  alarm     INTEGER DEFAULT 0,
  online    INTEGER DEFAULT 1
`;
const ARCHIVE_READING_TABLE_DDL = `
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  inverter  INTEGER NOT NULL,
  unit      INTEGER NOT NULL,
  pac       REAL DEFAULT 0,
  kwh       REAL DEFAULT 0,
  alarm     INTEGER DEFAULT 0,
  online    INTEGER DEFAULT 1
`;

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function sanitizePreservedSettings(entriesRaw) {
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
  const deduped = new Map();
  for (const entry of entries) {
    const key = String(entry?.key || "").trim().slice(0, 128);
    if (!key) continue;
    deduped.set(key, {
      key,
      value: String(entry?.value ?? ""),
    });
  }
  return Array.from(deduped.values()).sort((a, b) =>
    String(a?.key || "").localeCompare(String(b?.key || "")),
  );
}

function readPendingMainDbReplacement() {
  try {
    if (!fs.existsSync(MAIN_DB_PENDING_REPLACEMENT_PATH)) return null;
    const parsed = JSON.parse(
      fs.readFileSync(MAIN_DB_PENDING_REPLACEMENT_PATH, "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    return {
      tempName: path.basename(String(parsed?.tempName || "").trim()),
      size: Math.max(0, Number(parsed?.size || 0)),
      mtimeMs: Math.max(0, Number(parsed?.mtimeMs || 0)),
      stagedAt: Math.max(0, Number(parsed?.stagedAt || 0)),
      fileApplied: Boolean(parsed?.fileApplied),
      fileAppliedAt: Math.max(0, Number(parsed?.fileAppliedAt || 0)),
      preservedSettings: sanitizePreservedSettings(parsed?.preservedSettings),
    };
  } catch (_) {
    return null;
  }
}

function writePendingMainDbReplacement(entryRaw) {
  const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : null;
  if (!entry) {
    try {
      fs.unlinkSync(MAIN_DB_PENDING_REPLACEMENT_PATH);
    } catch (_) {
      // Ignore missing manifest cleanup failures.
    }
    return;
  }
  const payload = {
    tempName: path.basename(String(entry?.tempName || "").trim()),
    size: Math.max(0, Number(entry?.size || 0)),
    mtimeMs: Math.max(0, Number(entry?.mtimeMs || 0)),
    stagedAt: Math.max(0, Number(entry?.stagedAt || 0)),
    fileApplied: Boolean(entry?.fileApplied),
    fileAppliedAt: Math.max(0, Number(entry?.fileAppliedAt || 0)),
    preservedSettings: sanitizePreservedSettings(entry?.preservedSettings),
  };
  const tempPath = `${MAIN_DB_PENDING_REPLACEMENT_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, MAIN_DB_PENDING_REPLACEMENT_PATH);
}

function stagePendingMainDbReplacement({
  tempName,
  size = 0,
  mtimeMs = 0,
  preservedSettings = [],
}) {
  const safeTempName = path.basename(String(tempName || "").trim());
  if (!safeTempName) {
    throw new Error("Invalid staged main DB replacement payload.");
  }
  const previous = readPendingMainDbReplacement();
  const oldTempName = path.basename(String(previous?.tempName || "").trim());
  if (
    oldTempName &&
    oldTempName !== safeTempName &&
    /\.tmp$/i.test(oldTempName)
  ) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, oldTempName));
    } catch (_) {
      // Ignore stale temp cleanup failures.
    }
  }
  const staged = {
    tempName: safeTempName,
    size: Math.max(0, Number(size || 0)),
    mtimeMs: Math.max(0, Number(mtimeMs || 0)),
    stagedAt: Date.now(),
    fileApplied: false,
    fileAppliedAt: 0,
    preservedSettings: sanitizePreservedSettings(preservedSettings),
  };
  writePendingMainDbReplacement(staged);
  return staged;
}

function validateSqliteFileSync(filePath) {
  const target = String(filePath || "").trim();
  if (!target || !fs.existsSync(target)) {
    throw new Error("SQLite file is missing.");
  }
  const fd = fs.openSync(target, "r");
  let probe;
  try {
    probe = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, probe, 0, probe.length, 0);
    if (bytesRead < 16 || probe.toString("utf8", 0, 16) !== "SQLite format 3\u0000") {
      throw new Error("SQLite header is invalid.");
    }
  } finally {
    fs.closeSync(fd);
  }

  let verifyDb = null;
  try {
    verifyDb = new Database(target, { readonly: true, fileMustExist: true });
    const quickCheck = String(
      verifyDb.prepare("PRAGMA quick_check(1)").pluck().get() || "",
    )
      .trim()
      .toLowerCase();
    if (quickCheck !== "ok") {
      throw new Error(`SQLite quick_check failed: ${quickCheck || "unknown error"}`);
    }
  } finally {
    try {
      verifyDb?.close();
    } catch (_) {
      // Ignore validation close failures.
    }
  }
  return true;
}

function applyPendingMainDbReplacementFileSync() {
  const pending = readPendingMainDbReplacement();
  if (!pending) return { applied: 0, failed: 0, pending: 0 };
  if (pending.fileApplied) {
    return { applied: 0, failed: 0, pending: 1, awaitingSettingsRestore: true };
  }
  const tempName = path.basename(String(pending?.tempName || "").trim());
  const tempPath = path.join(DATA_DIR, tempName);
  if (!tempName || !fs.existsSync(tempPath)) {
    return {
      applied: 0,
      failed: 1,
      pending: 1,
      error: "Staged main DB snapshot is missing.",
    };
  }
  try {
    validateSqliteFileSync(tempPath);
    for (const suffix of ["-wal", "-shm", ""]) {
      try {
        fs.unlinkSync(`${DB_PATH}${suffix}`);
      } catch (_) {
        // Ignore missing current DB files.
      }
    }
    fs.renameSync(tempPath, DB_PATH);
    const targetMtimeMs = Math.max(0, Number(pending?.mtimeMs || 0));
    if (targetMtimeMs > 0) {
      const mtime = new Date(targetMtimeMs);
      fs.utimesSync(DB_PATH, mtime, mtime);
    }
    writePendingMainDbReplacement({
      ...pending,
      tempName: "",
      fileApplied: true,
      fileAppliedAt: Date.now(),
    });
    return { applied: 1, failed: 0, pending: 1, awaitingSettingsRestore: true };
  } catch (err) {
    return {
      applied: 0,
      failed: 1,
      pending: 1,
      error: String(err?.message || err),
    };
  }
}

const pendingMainDbFileApplyResult = applyPendingMainDbReplacementFileSync();

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");   // fsync every WAL commit — safe on hard power cut
db.pragma("cache_size = -64000");
db.pragma("temp_store = memory");
db.pragma("mmap_size = 268435456");

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    ${READING_TABLE_DDL}
  );
  CREATE INDEX IF NOT EXISTS idx_r_ts      ON readings(ts);
  CREATE INDEX IF NOT EXISTS idx_r_inv_ts  ON readings(inverter, unit, ts);

  CREATE TABLE IF NOT EXISTS energy_5min (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    inverter  INTEGER NOT NULL,
    kwh_inc   REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_e5_inv_ts ON energy_5min(inverter, ts);
  CREATE INDEX IF NOT EXISTS idx_e5_ts     ON energy_5min(ts);

  CREATE TABLE IF NOT EXISTS alarms (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    inverter     INTEGER NOT NULL,
    unit         INTEGER NOT NULL,
    alarm_code   TEXT,
    alarm_value  INTEGER,
    severity     TEXT DEFAULT 'fault',
    cleared_ts   INTEGER,
    acknowledged INTEGER DEFAULT 0,
    updated_ts   INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_a_ts     ON alarms(ts);
  CREATE INDEX IF NOT EXISTS idx_a_inv_ts ON alarms(inverter, ts);

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    operator  TEXT DEFAULT 'OPERATOR',
    inverter  INTEGER NOT NULL,
    node      INTEGER DEFAULT 0,
    action    TEXT NOT NULL,
    scope     TEXT DEFAULT 'single',
    result    TEXT DEFAULT 'ok',
    ip        TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_audit_inv_ts ON audit_log(inverter, ts);

  CREATE TABLE IF NOT EXISTS daily_report (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date      TEXT NOT NULL,
    inverter  INTEGER NOT NULL,
    kwh_total REAL DEFAULT 0,
    pac_peak  REAL DEFAULT 0,
    pac_avg   REAL DEFAULT 0,
    uptime_s  INTEGER DEFAULT 0,
    alarm_count INTEGER DEFAULT 0,
    control_count INTEGER DEFAULT 0,
    availability_pct REAL DEFAULT 0,
    performance_pct REAL DEFAULT 0,
    node_uptime_s INTEGER DEFAULT 0,
    expected_node_uptime_s INTEGER DEFAULT 0,
    expected_nodes INTEGER DEFAULT 4,
    rated_kw REAL DEFAULT 0,
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    UNIQUE(date, inverter)
  );

  CREATE TABLE IF NOT EXISTS daily_readings_summary (
    date TEXT NOT NULL,
    inverter INTEGER NOT NULL,
    unit INTEGER NOT NULL,
    sample_count INTEGER DEFAULT 0,
    online_samples INTEGER DEFAULT 0,
    pac_online_sum REAL DEFAULT 0,
    pac_online_count INTEGER DEFAULT 0,
    pac_peak REAL DEFAULT 0,
    first_ts INTEGER DEFAULT 0,
    last_ts INTEGER DEFAULT 0,
    first_kwh REAL DEFAULT 0,
    last_kwh REAL DEFAULT 0,
    last_online INTEGER DEFAULT 0,
    intervals_json TEXT DEFAULT '[]',
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY(date, inverter, unit)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT,
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    from_machine TEXT NOT NULL CHECK (from_machine IN ('gateway', 'remote')),
    to_machine   TEXT NOT NULL CHECK (to_machine IN ('gateway', 'remote')),
    from_name    TEXT NOT NULL DEFAULT '',
    message      TEXT NOT NULL,
    read_ts      INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_to_machine_id
    ON chat_messages(to_machine, id);

  CREATE TABLE IF NOT EXISTS forecast_dayahead (
    date       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    time_hms   TEXT NOT NULL,
    kwh_inc    REAL NOT NULL DEFAULT 0,
    kwh_lo     REAL DEFAULT 0,
    kwh_hi     REAL DEFAULT 0,
    source     TEXT DEFAULT 'service',
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY(date, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_fd_ts      ON forecast_dayahead(ts);
  CREATE INDEX IF NOT EXISTS idx_fd_date_ts ON forecast_dayahead(date, ts);

  CREATE TABLE IF NOT EXISTS forecast_intraday_adjusted (
    date       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    time_hms   TEXT NOT NULL,
    kwh_inc    REAL NOT NULL DEFAULT 0,
    kwh_lo     REAL DEFAULT 0,
    kwh_hi     REAL DEFAULT 0,
    source     TEXT DEFAULT 'service',
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY(date, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_fia_ts      ON forecast_intraday_adjusted(ts);
  CREATE INDEX IF NOT EXISTS idx_fia_date_ts ON forecast_intraday_adjusted(date, ts);

  CREATE TABLE IF NOT EXISTS solcast_snapshots (
    forecast_day    TEXT    NOT NULL,
    slot            INTEGER NOT NULL,
    ts_local        INTEGER NOT NULL,
    period_end_utc  TEXT,
    period          TEXT,
    forecast_mw     REAL,
    forecast_lo_mw  REAL,
    forecast_hi_mw  REAL,
    est_actual_mw   REAL,
    forecast_kwh    REAL,
    forecast_lo_kwh REAL,
    forecast_hi_kwh REAL,
    est_actual_kwh  REAL,
    pulled_ts       INTEGER NOT NULL,
    source          TEXT    NOT NULL,
    updated_ts      INTEGER NOT NULL,
    PRIMARY KEY (forecast_day, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_ss_day ON solcast_snapshots(forecast_day);
`);

function finalizePendingMainDbReplacementSync(database) {
  const pending = readPendingMainDbReplacement();
  if (!pending?.fileApplied) {
    return {
      applied: Number(pendingMainDbFileApplyResult?.applied || 0),
      settingsRestored: 0,
      failed: Number(pendingMainDbFileApplyResult?.failed || 0),
      pending: Number(pendingMainDbFileApplyResult?.pending || 0),
      awaitingSettingsRestore: false,
      error: String(pendingMainDbFileApplyResult?.error || ""),
    };
  }
  try {
    const rows = sanitizePreservedSettings(pending?.preservedSettings);
    if (rows.length > 0) {
      const now = Date.now();
      const upsert = database.prepare(
        `INSERT INTO settings(key,value,updated_ts) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value,
           updated_ts=excluded.updated_ts`,
      );
      const tx = database.transaction((entries) => {
        for (const row of entries) {
          upsert.run(row.key, row.value, now);
        }
      });
      tx(rows);
    }
    writePendingMainDbReplacement(null);
    return {
      applied: Number(pendingMainDbFileApplyResult?.applied || 0),
      settingsRestored: rows.length,
      failed: Number(pendingMainDbFileApplyResult?.failed || 0),
      pending: 0,
      awaitingSettingsRestore: false,
      error: "",
    };
  } catch (err) {
    return {
      applied: Number(pendingMainDbFileApplyResult?.applied || 0),
      settingsRestored: 0,
      failed: 1,
      pending: 1,
      awaitingSettingsRestore: true,
      error: String(err?.message || err),
    };
  }
}

function getTableColumns(database, tableName) {
  return database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean);
}

function isCompactReadingsShape(columns) {
  const cols = Array.isArray(columns) ? columns : [];
  return (
    cols.length === READING_STORAGE_COLUMNS.length &&
    READING_STORAGE_COLUMNS.every((name, idx) => cols[idx] === name)
  );
}

function compactReadingsTable(database) {
  const cols = getTableColumns(database, "readings");
  if (!cols.length || isCompactReadingsShape(cols)) return false;

  console.info("[DB] Compacting readings table to operational columns only.");
  const tempTable = "readings__compact_migrate";
  database.exec(`DROP TABLE IF EXISTS ${tempTable}`);
  const migrateTx = database.transaction(() => {
    database.exec(`
      CREATE TABLE ${tempTable} (
        ${READING_TABLE_DDL}
      );
      INSERT INTO ${tempTable}(id, ts, inverter, unit, pac, kwh, alarm, online)
      SELECT id, ts, inverter, unit, pac, kwh, alarm, online
        FROM readings
       ORDER BY id ASC;
      DROP TABLE readings;
      ALTER TABLE ${tempTable} RENAME TO readings;
      CREATE INDEX IF NOT EXISTS idx_r_ts ON readings(ts);
      CREATE INDEX IF NOT EXISTS idx_r_inv_ts ON readings(inverter, unit, ts);
    `);
  });
  migrateTx();
  try {
    database.exec("VACUUM");
  } catch (err) {
    console.warn("[DB] readings VACUUM skipped:", err.message);
  }
  return true;
}

function getDbStartupFootprintBytes(dbPath) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(filePath)) total += Number(fs.statSync(filePath).size || 0);
    } catch (_) {
      // Best effort only.
    }
  }
  return total;
}

function maybeCompactReadingsTableOnStartup(database, dbPath) {
  const cols = getTableColumns(database, "readings");
  if (!cols.length || isCompactReadingsShape(cols)) return false;

  const startupBytes = getDbStartupFootprintBytes(dbPath);
  if (startupBytes > STARTUP_COMPACT_MAX_BYTES) {
    console.warn(
      `[DB] Skipping startup readings compaction (${Math.round(startupBytes / (1024 * 1024))} MB footprint). ` +
        "Compact raw storage is still used for new rows; existing DB can be compacted later during maintenance.",
    );
    return false;
  }

  return compactReadingsTable(database);
}

maybeCompactReadingsTableOnStartup(db, DB_PATH);

function ensureColumn(tableName, columnName, columnDDL) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (cols.some((c) => String(c?.name || "") === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDDL}`);
}

// Migration: ensure replication-friendly update tracking columns exist.
ensureColumn("alarms", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("daily_report", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("settings", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
// Migration: daily audit control-action count per inverter (added 2026-03).
ensureColumn("daily_report", "control_count", "control_count INTEGER DEFAULT 0");
ensureColumn("daily_report", "availability_pct", "availability_pct REAL DEFAULT 0");
ensureColumn("daily_report", "performance_pct", "performance_pct REAL DEFAULT 0");
ensureColumn("daily_report", "node_uptime_s", "node_uptime_s INTEGER DEFAULT 0");
ensureColumn(
  "daily_report",
  "expected_node_uptime_s",
  "expected_node_uptime_s INTEGER DEFAULT 0",
);
ensureColumn("daily_report", "expected_nodes", "expected_nodes INTEGER DEFAULT 4");
ensureColumn("daily_report", "rated_kw", "rated_kw REAL DEFAULT 0");
ensureColumn(
  "daily_readings_summary",
  "updated_ts",
  "updated_ts INTEGER NOT NULL DEFAULT 0",
);
ensureColumn(
  "daily_readings_summary",
  "last_online",
  "last_online INTEGER DEFAULT 0",
);
ensureColumn(
  "daily_readings_summary",
  "intervals_json",
  "intervals_json TEXT DEFAULT '[]'",
);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_a_updated_ts ON alarms(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_daily_report_updated_ts ON daily_report(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_settings_updated_ts ON settings(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_summary_date_inv ON daily_readings_summary(date, inverter, unit);
  CREATE INDEX IF NOT EXISTS idx_summary_updated_ts ON daily_readings_summary(updated_ts);
`);

const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
db.exec(`
  UPDATE alarms
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       WHEN COALESCE(cleared_ts, 0) > 0 THEN cleared_ts
       WHEN COALESCE(ts, 0) > 0 THEN ts
       ELSE ${NOW_MS_SQL}
     END;
  UPDATE daily_report
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       ELSE ${NOW_MS_SQL}
     END;
  UPDATE settings
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       ELSE ${NOW_MS_SQL}
      END;
  UPDATE daily_readings_summary
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       ELSE ${NOW_MS_SQL}
     END,
         intervals_json = CASE
           WHEN TRIM(COALESCE(intervals_json, '')) <> '' THEN intervals_json
           ELSE '[]'
         END;
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_alarms_touch_updated_ts
  AFTER UPDATE ON alarms
  FOR EACH ROW
  WHEN NEW.updated_ts = OLD.updated_ts
  BEGIN
    UPDATE alarms SET updated_ts = ${NOW_MS_SQL} WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_alarms_insert_updated_ts
  AFTER INSERT ON alarms
  FOR EACH ROW
  WHEN COALESCE(NEW.updated_ts, 0) = 0
  BEGIN
    UPDATE alarms SET updated_ts = ${NOW_MS_SQL} WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_daily_report_touch_updated_ts
  AFTER UPDATE ON daily_report
  FOR EACH ROW
  WHEN NEW.updated_ts = OLD.updated_ts
  BEGIN
    UPDATE daily_report SET updated_ts = ${NOW_MS_SQL} WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_summary_touch_updated_ts
  AFTER UPDATE ON daily_readings_summary
  FOR EACH ROW
  WHEN NEW.updated_ts = OLD.updated_ts
  BEGIN
    UPDATE daily_readings_summary
       SET updated_ts = ${NOW_MS_SQL}
     WHERE date = NEW.date AND inverter = NEW.inverter AND unit = NEW.unit;
  END;
`);

const pendingMainDbFinalizeResult = finalizePendingMainDbReplacementSync(db);
if (Number(pendingMainDbFinalizeResult?.applied || 0) > 0) {
  console.log("[DB] Applied staged main DB replacement on startup.");
}
if (Number(pendingMainDbFinalizeResult?.settingsRestored || 0) > 0) {
  console.log(
    `[DB] Restored ${Number(pendingMainDbFinalizeResult.settingsRestored || 0)} preserved local setting(s) after main DB replacement.`,
  );
}
if (Number(pendingMainDbFinalizeResult?.failed || 0) > 0) {
  console.warn(
    "[DB] Staged main DB replacement is still pending:",
    String(pendingMainDbFinalizeResult?.error || "unknown error"),
  );
}

const stmts = {
  insertReading: db.prepare(`
    INSERT INTO readings (ts,inverter,unit,pac,kwh,alarm,online)
    VALUES (@ts,@inverter,@unit,@pac,@kwh,@alarm,@online)
  `),
  insertAlarm: db.prepare(`
    INSERT INTO alarms (ts,inverter,unit,alarm_code,alarm_value,severity)
    VALUES (@ts,@inverter,@unit,@alarm_code,@alarm_value,@severity)
  `),
  clearAlarm: db.prepare(
    `UPDATE alarms SET cleared_ts=? WHERE inverter=? AND unit=? AND cleared_ts IS NULL`,
  ),
  ackAlarm: db.prepare(`UPDATE alarms SET acknowledged=1 WHERE id=?`),
  // Keep semantics aligned with per-row ACK: acknowledge every unacked alarm row.
  ackAllAlarms: db.prepare(`UPDATE alarms SET acknowledged=1 WHERE acknowledged=0`),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key=?`),
  setSetting: db.prepare(
    `INSERT INTO settings(key,value,updated_ts) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       value=excluded.value,
       updated_ts=excluded.updated_ts`,
  ),
  insertEnergy5: db.prepare(
    `INSERT INTO energy_5min(ts,inverter,kwh_inc) VALUES(?,?,?)`,
  ),
  getActiveAlarms: db.prepare(
    `SELECT * FROM alarms WHERE cleared_ts IS NULL ORDER BY ts DESC`,
  ),
  getAlarmsRange: db.prepare(
    `SELECT * FROM alarms WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000`,
  ),
  getReadingsRange: db.prepare(
    `SELECT ${READING_SELECT_SQL} FROM readings WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  getReadingsRangeAll: db.prepare(
    `SELECT ${READING_SELECT_SQL} FROM readings WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, unit ASC, ts ASC`,
  ),
  get5minRange: db.prepare(
    `SELECT * FROM energy_5min WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  get5minRangeAll: db.prepare(
    `SELECT * FROM energy_5min WHERE ts BETWEEN ? AND ? ORDER BY inverter, ts ASC`,
  ),
  sumEnergy5minRange: db.prepare(
    `SELECT inverter, SUM(kwh_inc) AS total_kwh
       FROM energy_5min
      WHERE ts BETWEEN ? AND ?
      GROUP BY inverter
      ORDER BY inverter ASC`,
  ),
  sumEnergy5minRangeByInv: db.prepare(
    `SELECT inverter, SUM(kwh_inc) AS total_kwh
       FROM energy_5min
      WHERE inverter=? AND ts BETWEEN ? AND ?
      GROUP BY inverter`,
  ),
  upsertDailyReport: db.prepare(`
    INSERT INTO daily_report(
      date,inverter,kwh_total,pac_peak,pac_avg,uptime_s,alarm_count,control_count,
      availability_pct,performance_pct,node_uptime_s,expected_node_uptime_s,expected_nodes,rated_kw,updated_ts
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(date,inverter) DO UPDATE SET
      kwh_total=excluded.kwh_total,
      pac_peak=excluded.pac_peak,
      pac_avg=excluded.pac_avg,
      uptime_s=excluded.uptime_s,
      alarm_count=excluded.alarm_count,
      control_count=excluded.control_count,
      availability_pct=excluded.availability_pct,
      performance_pct=excluded.performance_pct,
      node_uptime_s=excluded.node_uptime_s,
      expected_node_uptime_s=excluded.expected_node_uptime_s,
      expected_nodes=excluded.expected_nodes,
      rated_kw=excluded.rated_kw,
      updated_ts=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  `),
  getDailyReport: db.prepare(
    `SELECT * FROM daily_report WHERE date=? ORDER BY inverter`,
  ),
  getDailyReportRange: db.prepare(
    `SELECT * FROM daily_report WHERE date BETWEEN ? AND ? ORDER BY date, inverter`,
  ),
  getDailyReadingsSummaryOne: db.prepare(
    `SELECT * FROM daily_readings_summary WHERE date=? AND inverter=? AND unit=?`,
  ),
  getDailyReadingsSummaryDay: db.prepare(
    `SELECT * FROM daily_readings_summary WHERE date=? ORDER BY inverter ASC, unit ASC`,
  ),
  deleteDailyReadingsSummaryDay: db.prepare(
    `DELETE FROM daily_readings_summary WHERE date=?`,
  ),
  upsertDailyReadingsSummary: db.prepare(`
    INSERT INTO daily_readings_summary(
      date,inverter,unit,sample_count,online_samples,pac_online_sum,pac_online_count,pac_peak,
      first_ts,last_ts,first_kwh,last_kwh,last_online,intervals_json,updated_ts
    )
    VALUES(
      @date,@inverter,@unit,@sample_count,@online_samples,@pac_online_sum,@pac_online_count,@pac_peak,
      @first_ts,@last_ts,@first_kwh,@last_kwh,@last_online,@intervals_json,@updated_ts
    )
    ON CONFLICT(date,inverter,unit) DO UPDATE SET
      sample_count=excluded.sample_count,
      online_samples=excluded.online_samples,
      pac_online_sum=excluded.pac_online_sum,
      pac_online_count=excluded.pac_online_count,
      pac_peak=excluded.pac_peak,
      first_ts=excluded.first_ts,
      last_ts=excluded.last_ts,
      first_kwh=excluded.first_kwh,
      last_kwh=excluded.last_kwh,
      last_online=excluded.last_online,
      intervals_json=excluded.intervals_json,
      updated_ts=excluded.updated_ts
  `),
  upsertForecastDayAhead: db.prepare(`
    INSERT INTO forecast_dayahead(date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts)
    VALUES (@date, @ts, @slot, @time_hms, @kwh_inc, @kwh_lo, @kwh_hi, @source, @updated_ts)
    ON CONFLICT(date, slot) DO UPDATE SET
      ts=excluded.ts,
      time_hms=excluded.time_hms,
      kwh_inc=excluded.kwh_inc,
      kwh_lo=excluded.kwh_lo,
      kwh_hi=excluded.kwh_hi,
      source=excluded.source,
      updated_ts=excluded.updated_ts
  `),
  upsertForecastIntradayAdjusted: db.prepare(`
    INSERT INTO forecast_intraday_adjusted(date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts)
    VALUES (@date, @ts, @slot, @time_hms, @kwh_inc, @kwh_lo, @kwh_hi, @source, @updated_ts)
    ON CONFLICT(date, slot) DO UPDATE SET
      ts=excluded.ts,
      time_hms=excluded.time_hms,
      kwh_inc=excluded.kwh_inc,
      kwh_lo=excluded.kwh_lo,
      kwh_hi=excluded.kwh_hi,
      source=excluded.source,
      updated_ts=excluded.updated_ts
  `),
  upsertSolcastSnapshot: db.prepare(`
    INSERT INTO solcast_snapshots(
      forecast_day, slot, ts_local, period_end_utc, period,
      forecast_mw, forecast_lo_mw, forecast_hi_mw, est_actual_mw,
      forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, est_actual_kwh,
      pulled_ts, source, updated_ts
    ) VALUES(
      @forecast_day, @slot, @ts_local, @period_end_utc, @period,
      @forecast_mw, @forecast_lo_mw, @forecast_hi_mw, @est_actual_mw,
      @forecast_kwh, @forecast_lo_kwh, @forecast_hi_kwh, @est_actual_kwh,
      @pulled_ts, @source, @updated_ts
    )
    ON CONFLICT(forecast_day, slot) DO UPDATE SET
      ts_local=excluded.ts_local,
      period_end_utc=excluded.period_end_utc,
      period=excluded.period,
      forecast_mw=excluded.forecast_mw,
      forecast_lo_mw=excluded.forecast_lo_mw,
      forecast_hi_mw=excluded.forecast_hi_mw,
      est_actual_mw=excluded.est_actual_mw,
      forecast_kwh=excluded.forecast_kwh,
      forecast_lo_kwh=excluded.forecast_lo_kwh,
      forecast_hi_kwh=excluded.forecast_hi_kwh,
      est_actual_kwh=excluded.est_actual_kwh,
      pulled_ts=excluded.pulled_ts,
      source=excluded.source,
      updated_ts=excluded.updated_ts
  `),
  getSolcastSnapshotDay: db.prepare(
    `SELECT forecast_day, slot, ts_local, period_end_utc, period,
            forecast_mw, forecast_lo_mw, forecast_hi_mw, est_actual_mw,
            forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, est_actual_kwh,
            pulled_ts, source, updated_ts
       FROM solcast_snapshots
      WHERE forecast_day = ?
      ORDER BY slot ASC`,
  ),
  deleteForecastDayAheadDate: db.prepare(
    `DELETE FROM forecast_dayahead WHERE date=?`,
  ),
  deleteForecastIntradayAdjustedDate: db.prepare(
    `DELETE FROM forecast_intraday_adjusted WHERE date=?`,
  ),
  getForecastDayAheadDate: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_dayahead
     WHERE date=?
     ORDER BY ts ASC`,
  ),
  getForecastIntradayAdjustedDate: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_intraday_adjusted
     WHERE date=?
     ORDER BY ts ASC`,
  ),
  getForecastDayAheadRange: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_dayahead
     WHERE ts BETWEEN ? AND ?
     ORDER BY ts ASC`,
  ),
  getForecastIntradayAdjustedRange: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_intraday_adjusted
     WHERE ts BETWEEN ? AND ?
     ORDER BY ts ASC`,
  ),
  insertChatMessage: db.prepare(`
    INSERT INTO chat_messages (ts, from_machine, to_machine, from_name, message, read_ts)
    VALUES (@ts, @from_machine, @to_machine, @from_name, @message, @read_ts)
  `),
  getChatMessageById: db.prepare(
    `SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
       FROM chat_messages
      WHERE id=?`,
  ),
  getChatThread: db.prepare(
    `SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
       FROM (
         SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
           FROM chat_messages
          ORDER BY id DESC
          LIMIT ?
       )
      ORDER BY id ASC`,
  ),
  getChatInboxAfterId: db.prepare(
    `SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
       FROM chat_messages
      WHERE to_machine=? AND id>?
      ORDER BY id ASC
      LIMIT ?`,
  ),
  getLatestChatInboundId: db.prepare(
    `SELECT COALESCE(MAX(id), 0) AS id
       FROM chat_messages
      WHERE to_machine=?`,
  ),
  markChatReadUpToId: db.prepare(
    `UPDATE chat_messages
        SET read_ts=?
      WHERE to_machine=?
        AND id<=?
        AND read_ts IS NULL`,
  ),
  clearChatMessages: db.prepare(`DELETE FROM chat_messages`),
  purgeChatOverflow: db.prepare(
    `DELETE FROM chat_messages
      WHERE id<=COALESCE((
        SELECT id
          FROM chat_messages
         ORDER BY id DESC
         LIMIT 1 OFFSET ?
      ), 0)`,
  ),
};

const bulkInsert = db.transaction((rows) => {
  for (const row of rows) {
    try {
      stmts.insertReading.run(row);
    } catch (err) {
      console.error("[DB] bulkInsert row failed:", err.message, row);
    }
  }
});

const bulkUpsertForecastDayAhead = db.transaction((date, rows, source = "service") => {
  stmts.deleteForecastDayAheadDate.run(String(date || ""));
  const now = Date.now();
  for (const r of rows || []) {
    stmts.upsertForecastDayAhead.run({
      date: String(date || ""),
      ts: Number(r?.ts || 0),
      slot: Number(r?.slot || 0),
      time_hms: String(r?.time_hms || ""),
      kwh_inc: Number(r?.kwh_inc || 0),
      kwh_lo: Number(r?.kwh_lo || 0),
      kwh_hi: Number(r?.kwh_hi || 0),
      source: String(source || "service"),
      updated_ts: now,
    });
  }
});

const bulkUpsertForecastIntradayAdjusted = db.transaction((date, rows, source = "service") => {
  stmts.deleteForecastIntradayAdjustedDate.run(String(date || ""));
  const now = Date.now();
  for (const r of rows || []) {
    stmts.upsertForecastIntradayAdjusted.run({
      date: String(date || ""),
      ts: Number(r?.ts || 0),
      slot: Number(r?.slot || 0),
      time_hms: String(r?.time_hms || ""),
      kwh_inc: Number(r?.kwh_inc || 0),
      kwh_lo: Number(r?.kwh_lo || 0),
      kwh_hi: Number(r?.kwh_hi || 0),
      source: String(source || "service"),
      updated_ts: now,
    });
  }
});

const bulkUpsertSolcastSnapshot = db.transaction((day, rows, source, pulledTs) => {
  const now = Date.now();
  for (const r of rows || []) {
    stmts.upsertSolcastSnapshot.run({
      forecast_day:    String(day || ""),
      slot:            Number(r.slot),
      ts_local:        Number(r.ts_local),
      period_end_utc:  r.period_end_utc != null ? String(r.period_end_utc) : null,
      period:          r.period         != null ? String(r.period)         : null,
      forecast_mw:     r.forecast_mw     != null ? Number(r.forecast_mw)     : null,
      forecast_lo_mw:  r.forecast_lo_mw  != null ? Number(r.forecast_lo_mw)  : null,
      forecast_hi_mw:  r.forecast_hi_mw  != null ? Number(r.forecast_hi_mw)  : null,
      est_actual_mw:   r.est_actual_mw   != null ? Number(r.est_actual_mw)   : null,
      forecast_kwh:    r.forecast_kwh    != null ? Number(r.forecast_kwh)    : null,
      forecast_lo_kwh: r.forecast_lo_kwh != null ? Number(r.forecast_lo_kwh) : null,
      forecast_hi_kwh: r.forecast_hi_kwh != null ? Number(r.forecast_hi_kwh) : null,
      est_actual_kwh:  r.est_actual_kwh  != null ? Number(r.est_actual_kwh)  : null,
      pulled_ts:       Number(pulledTs || now),
      source:          String(source || "toolkit"),
      updated_ts:      now,
    });
  }
});

function getSolcastSnapshotForDay(day) {
  return stmts.getSolcastSnapshotDay.all(String(day || ""));
}

function getSetting(key, def = null) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  stmts.setSetting.run(key, String(value), Date.now());
}

function normalizeChatMachine(machine, def = "gateway") {
  const v = String(machine || def)
    .trim()
    .toLowerCase();
  return v === "remote" ? "remote" : "gateway";
}

const insertChatMessage = db.transaction((row, retainCount = 500) => {
  const info = stmts.insertChatMessage.run({
    ts: Number(row?.ts || Date.now()),
    from_machine: normalizeChatMachine(row?.from_machine, "gateway"),
    to_machine: normalizeChatMachine(row?.to_machine, "remote"),
    from_name: String(row?.from_name || "").trim(),
    message: String(row?.message || ""),
    read_ts:
      row?.read_ts == null || row?.read_ts === ""
        ? null
        : Number(row.read_ts || 0),
  });
  const keep = Math.max(1, Math.trunc(Number(retainCount || 500)));
  stmts.purgeChatOverflow.run(keep);
  return stmts.getChatMessageById.get(info.lastInsertRowid);
});

function getChatThread(limit = 20) {
  const cap = Math.max(1, Math.min(100, Math.trunc(Number(limit || 20))));
  return stmts.getChatThread.all(cap);
}

function getChatInboxAfterId(machine, afterId = 0, limit = 50) {
  const normalizedMachine = normalizeChatMachine(machine, "gateway");
  const after = Math.max(0, Math.trunc(Number(afterId || 0)));
  const cap = Math.max(1, Math.min(200, Math.trunc(Number(limit || 50))));
  return stmts.getChatInboxAfterId.all(normalizedMachine, after, cap);
}

function getLatestChatInboundId(machine) {
  const normalizedMachine = normalizeChatMachine(machine, "gateway");
  const row = stmts.getLatestChatInboundId.get(normalizedMachine);
  return Math.max(0, Math.trunc(Number(row?.id || 0)));
}

function markChatReadUpToId(machine, upToId, readTs = Date.now()) {
  const normalizedMachine = normalizeChatMachine(machine, "gateway");
  const maxId = Math.max(0, Math.trunc(Number(upToId || 0)));
  if (!maxId) return 0;
  const info = stmts.markChatReadUpToId.run(
    Math.max(0, Math.trunc(Number(readTs || Date.now()))),
    normalizedMachine,
    maxId,
  );
  return Math.max(0, Math.trunc(Number(info?.changes || 0)));
}

function clearAllChatMessages() {
  const info = stmts.clearChatMessages.run();
  return Math.max(0, Math.trunc(Number(info?.changes || 0)));
}

function ensureArchiveSchema(archiveDb) {
  archiveDb.pragma("journal_mode = WAL");
  archiveDb.pragma("synchronous = NORMAL");
  archiveDb.pragma("temp_store = memory");
  archiveDb.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      ${ARCHIVE_READING_TABLE_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_ar_ts ON readings(ts);
    CREATE INDEX IF NOT EXISTS idx_ar_inv_ts ON readings(inverter, unit, ts);

    CREATE TABLE IF NOT EXISTS energy_5min (
      id        INTEGER PRIMARY KEY,
      ts        INTEGER NOT NULL,
      inverter  INTEGER NOT NULL,
      kwh_inc   REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ae5_ts ON energy_5min(ts);
    CREATE INDEX IF NOT EXISTS idx_ae5_inv_ts ON energy_5min(inverter, ts);
  `);
}

function createArchiveEntry(filePath) {
  const archiveDb = new Database(filePath);
  ensureArchiveSchema(archiveDb);
  const entry = {
    db: archiveDb,
    insertReading: archiveDb.prepare(`
      INSERT OR IGNORE INTO readings
      (id,ts,inverter,unit,pac,kwh,alarm,online)
      VALUES (@id,@ts,@inverter,@unit,@pac,@kwh,@alarm,@online)
    `),
    insertEnergy5: archiveDb.prepare(`
      INSERT OR IGNORE INTO energy_5min (id,ts,inverter,kwh_inc)
      VALUES (@id,@ts,@inverter,@kwh_inc)
    `),
    selectReadingsRangeAll: archiveDb.prepare(
      `SELECT ${READING_SELECT_SQL} FROM readings WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, unit ASC, ts ASC`,
    ),
    selectReadingsRangeByInv: archiveDb.prepare(
      `SELECT ${READING_SELECT_SQL} FROM readings WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
    ),
    selectEnergyRangeAll: archiveDb.prepare(
      `SELECT * FROM energy_5min WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, ts ASC`,
    ),
    selectEnergyRangeByInv: archiveDb.prepare(
      `SELECT * FROM energy_5min WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
    ),
    sumEnergyRangeAll: archiveDb.prepare(
      `SELECT inverter, SUM(kwh_inc) AS total_kwh
         FROM energy_5min
        WHERE ts BETWEEN ? AND ?
        GROUP BY inverter
        ORDER BY inverter ASC`,
    ),
    sumEnergyRangeByInv: archiveDb.prepare(
      `SELECT inverter, SUM(kwh_inc) AS total_kwh
         FROM energy_5min
        WHERE inverter=? AND ts BETWEEN ? AND ?
        GROUP BY inverter`,
    ),
  };
  entry.insertReadingsTx = archiveDb.transaction((rows) => {
    for (const row of rows || []) entry.insertReading.run(row);
  });
  entry.insertEnergyTx = archiveDb.transaction((rows) => {
    for (const row of rows || []) entry.insertEnergy5.run(row);
  });
  return entry;
}

function normalizeArchiveMonthKey(monthKey) {
  return String(monthKey || "")
    .trim()
    .replace(/\.db$/i, "");
}

function getArchiveEntry(monthKey, createIfMissing = false) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return null;
  if (ARCHIVE_DB_REPLACE_LOCKS.has(key)) return null;
  if (ARCHIVE_DB_CACHE.has(key)) return ARCHIVE_DB_CACHE.get(key);
  const filePath = path.join(ARCHIVE_DIR, `${key}.db`);
  if (!createIfMissing && !fs.existsSync(filePath)) return null;
  const entry = createArchiveEntry(filePath);
  ARCHIVE_DB_CACHE.set(key, entry);
  return entry;
}

function closeArchiveDbForMonth(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return false;
  const entry = ARCHIVE_DB_CACHE.get(key);
  if (!entry) return false;
  try {
    entry.db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (_) {
    // Ignore archive checkpoint failures during targeted close.
  }
  try {
    entry.db.close();
  } catch (_) {
    // Ignore archive close failures during targeted close.
  }
  ARCHIVE_DB_CACHE.delete(key);
  return true;
}

function beginArchiveDbReplacement(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return "";
  ARCHIVE_DB_REPLACE_LOCKS.add(key);
  closeArchiveDbForMonth(key);
  return key;
}

function endArchiveDbReplacement(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return false;
  return ARCHIVE_DB_REPLACE_LOCKS.delete(key);
}

function parseIntervalsJson(text) {
  try {
    const parsed = JSON.parse(String(text || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return null;
        const start = Number(pair[0] || 0);
        const end = Number(pair[1] || 0);
        return end > start && start > 0 ? [start, end] : null;
      })
      .filter(Boolean)
      .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
  } catch (_) {
    return [];
  }
}

function addMergedInterval(intervals, start, end) {
  const s = Number(start || 0);
  const e = Number(end || 0);
  if (!(e > s) || !(s > 0)) return;
  const list = Array.isArray(intervals) ? intervals : [];
  if (!list.length) {
    list.push([s, e]);
    return;
  }
  const last = list[list.length - 1];
  if (s <= Number(last[1] || 0)) {
    if (e > Number(last[1] || 0)) last[1] = e;
    return;
  }
  list.push([s, e]);
}

function createSummaryState(day, inverter, unit, row = null) {
  return {
    date: String(day || ""),
    inverter: Number(inverter || row?.inverter || 0),
    unit: Number(unit || row?.unit || 0),
    sample_count: Math.max(0, Math.trunc(Number(row?.sample_count || 0))),
    online_samples: Math.max(0, Math.trunc(Number(row?.online_samples || 0))),
    pac_online_sum: Number(row?.pac_online_sum || 0),
    pac_online_count: Math.max(0, Math.trunc(Number(row?.pac_online_count || 0))),
    pac_peak: Number(row?.pac_peak || 0),
    first_ts: Number(row?.first_ts || 0),
    last_ts: Number(row?.last_ts || 0),
    first_kwh: Number(row?.first_kwh || 0),
    last_kwh: Number(row?.last_kwh || 0),
    last_online: Number(row?.last_online || 0) === 1 ? 1 : 0,
    intervals: parseIntervalsJson(row?.intervals_json),
  };
}

function applyReadingToSummaryState(state, row) {
  if (!state || !row) return;
  const ts = Number(row?.ts || 0);
  if (!(ts > 0)) return;
  const pac = Math.max(0, Number(row?.pac || 0));
  const kwh = Number(row?.kwh || 0);
  const isOnline = Number(row?.online || 0) === 1 && pac > 0;

  state.sample_count += 1;
  if (isOnline) {
    state.online_samples += 1;
    state.pac_online_sum += pac;
    state.pac_online_count += 1;
  }
  if (pac > state.pac_peak) state.pac_peak = pac;

  if (!(state.first_ts > 0) || ts < state.first_ts) {
    state.first_ts = ts;
    state.first_kwh = Number.isFinite(kwh) ? kwh : 0;
  }

  if (state.last_ts > 0 && ts > state.last_ts && state.last_online === 1) {
    const maxEnd = state.last_ts + SUMMARY_MAX_GAP_S * 1000;
    addMergedInterval(state.intervals, state.last_ts, Math.min(ts, maxEnd));
  }

  if (!(state.last_ts > 0) || ts >= state.last_ts) {
    state.last_ts = ts;
    state.last_kwh = Number.isFinite(kwh) ? kwh : state.last_kwh;
    state.last_online = isOnline ? 1 : 0;
  }
}

function summaryStateToPayload(state, updatedTs = Date.now()) {
  return {
    date: state.date,
    inverter: Number(state.inverter || 0),
    unit: Number(state.unit || 0),
    sample_count: Math.max(0, Math.trunc(Number(state.sample_count || 0))),
    online_samples: Math.max(0, Math.trunc(Number(state.online_samples || 0))),
    pac_online_sum: Number(Number(state.pac_online_sum || 0).toFixed(6)),
    pac_online_count: Math.max(0, Math.trunc(Number(state.pac_online_count || 0))),
    pac_peak: Number(Number(state.pac_peak || 0).toFixed(3)),
    first_ts: Number(state.first_ts || 0),
    last_ts: Number(state.last_ts || 0),
    first_kwh: Number(Number(state.first_kwh || 0).toFixed(6)),
    last_kwh: Number(Number(state.last_kwh || 0).toFixed(6)),
    last_online: Number(state.last_online || 0) === 1 ? 1 : 0,
    intervals_json: JSON.stringify(Array.isArray(state.intervals) ? state.intervals : []),
    updated_ts: Number(updatedTs || Date.now()),
  };
}

const writeSummaryPayloadsTx = db.transaction((payloads, dayToDelete = "") => {
  if (dayToDelete) stmts.deleteDailyReadingsSummaryDay.run(String(dayToDelete));
  for (const payload of payloads || []) {
    stmts.upsertDailyReadingsSummary.run(payload);
  }
});

function getDailyReadingsSummaryRows(dayInput) {
  const day = String(dayInput || "").trim();
  if (!day) return [];
  return stmts.getDailyReadingsSummaryDay.all(day);
}

function ingestDailyReadingsSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;
  const states = new Map();
  for (const row of list) {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!(ts > 0) || !(inverter > 0) || !(unit > 0)) continue;
    const day = localDateStr(ts);
    const key = `${day}|${inverter}|${unit}`;
    let state = states.get(key);
    if (!state) {
      const existing = stmts.getDailyReadingsSummaryOne.get(day, inverter, unit);
      state = createSummaryState(day, inverter, unit, existing);
      states.set(key, state);
    }
    applyReadingToSummaryState(state, row);
  }
  if (!states.size) return;
  const now = Date.now();
  const payloads = Array.from(states.values()).map((state) => summaryStateToPayload(state, now));
  writeSummaryPayloadsTx(payloads);
}

function readingsNaturalKey(row) {
  return `${Number(row?.ts || 0)}|${Number(row?.inverter || 0)}|${Number(row?.unit || 0)}`;
}

function energyNaturalKey(row) {
  return `${Number(row?.ts || 0)}|${Number(row?.inverter || 0)}`;
}

function sortReadingsAsc(a, b) {
  return (
    Number(a?.inverter || 0) - Number(b?.inverter || 0) ||
    Number(a?.unit || 0) - Number(b?.unit || 0) ||
    Number(a?.ts || 0) - Number(b?.ts || 0)
  );
}

function sortEnergyAsc(a, b) {
  return (
    Number(a?.inverter || 0) - Number(b?.inverter || 0) ||
    Number(a?.ts || 0) - Number(b?.ts || 0)
  );
}

function annotateRowsWithComputedKwh(rowsRaw, maxGapMs = 30000) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw.slice() : [];
  const lastByKey = new Map();
  const totalByKey = new Map();
  return rows.map((row) => {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    const pac = Math.max(0, Number(row?.pac || 0));
    const key = `${localDateStr(ts)}|${inverter}|${unit}`;
    const prev = lastByKey.get(key);
    let totalKwh = Number(totalByKey.get(key) || 0);

    if (prev && ts > prev.ts) {
      const dtMs = ts - prev.ts;
      if (dtMs > 0 && dtMs <= maxGapMs) {
        const avgPac = (prev.pac + pac) / 2;
        totalKwh += (avgPac * dtMs) / 3600000000.0;
      }
    }

    totalKwh = Number(totalKwh.toFixed(6));
    lastByKey.set(key, { ts, pac });
    totalByKey.set(key, totalKwh);
    return { ...row, kwh: totalKwh };
  });
}

function pushUniqueRows(targetMap, rows, keyFn) {
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!targetMap.has(key)) targetMap.set(key, row);
  }
}

function queryReadingsRangeAll(startTs, endTs) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectReadingsRangeAll.all(s, e), readingsNaturalKey);
  }
  pushUniqueRows(out, stmts.getReadingsRangeAll.all(s, e), readingsNaturalKey);
  return Array.from(out.values()).sort(sortReadingsAsc);
}

function queryReadingsRange(inverter, startTs, endTs) {
  const inv = Number(inverter || 0);
  if (!(inv > 0)) return [];
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectReadingsRangeByInv.all(inv, s, e), readingsNaturalKey);
  }
  pushUniqueRows(out, stmts.getReadingsRange.all(inv, s, e), readingsNaturalKey);
  return Array.from(out.values()).sort(sortReadingsAsc);
}

function queryEnergy5minRangeAll(startTs, endTs) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectEnergyRangeAll.all(s, e), energyNaturalKey);
  }
  pushUniqueRows(out, stmts.get5minRangeAll.all(s, e), energyNaturalKey);
  return Array.from(out.values()).sort(sortEnergyAsc);
}

function queryEnergy5minRange(inverter, startTs, endTs) {
  const inv = Number(inverter || 0);
  if (!(inv > 0)) return [];
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectEnergyRangeByInv.all(inv, s, e), energyNaturalKey);
  }
  pushUniqueRows(out, stmts.get5minRange.all(inv, s, e), energyNaturalKey);
  return Array.from(out.values()).sort(sortEnergyAsc);
}

function sumEnergy5minByInverterRange(startTs, endTs, inverter = null) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  const inv = Number(inverter || 0);
  const out = new Map();
  if (!(e >= s)) return out;

  function addSumRows(rows) {
    for (const row of rows || []) {
      const key = Number(row?.inverter || 0);
      if (!(key > 0)) continue;
      out.set(key, Number(out.get(key) || 0) + Number(row?.total_kwh || 0));
    }
  }

  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    addSumRows(
      inv > 0
        ? entry.sumEnergyRangeByInv.all(inv, s, e)
        : entry.sumEnergyRangeAll.all(s, e),
    );
  }

  addSumRows(
    inv > 0
      ? stmts.sumEnergy5minRangeByInv.all(inv, s, e)
      : stmts.sumEnergy5minRange.all(s, e),
  );

  return out;
}

function rebuildDailyReadingsSummaryForDate(dayInput) {
  const day = String(dayInput || "").trim();
  if (!day) return [];
  const startTs = new Date(`${day}T00:00:00.000`).getTime();
  const endTs = new Date(`${day}T23:59:59.999`).getTime();
  const rows = annotateRowsWithComputedKwh(queryReadingsRangeAll(startTs, endTs));
  const states = new Map();
  for (const row of rows) {
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!(inverter > 0) || !(unit > 0)) continue;
    const key = `${day}|${inverter}|${unit}`;
    let state = states.get(key);
    if (!state) {
      state = createSummaryState(day, inverter, unit);
      states.set(key, state);
    }
    applyReadingToSummaryState(state, row);
  }
  const now = Date.now();
  const payloads = Array.from(states.values()).map((state) => summaryStateToPayload(state, now));
  writeSummaryPayloadsTx(payloads, day);
  return getDailyReadingsSummaryRows(day);
}
const deleteReadingById = db.prepare(`DELETE FROM readings WHERE id=?`);
const deleteEnergy5ById = db.prepare(`DELETE FROM energy_5min WHERE id=?`);
const deleteReadingsBatchTx = db.transaction((ids) => {
  for (const id of ids || []) deleteReadingById.run(id);
});
const deleteEnergyBatchTx = db.transaction((ids) => {
  for (const id of ids || []) deleteEnergy5ById.run(id);
});
const selectOldReadingsBatch = db.prepare(`
  SELECT id, ts, inverter, unit, pac, kwh, alarm, online
    FROM readings
   WHERE ts < ?
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);
const selectOldEnergyBatch = db.prepare(`
  SELECT id, ts, inverter, kwh_inc
    FROM energy_5min
   WHERE ts < ?
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);

function archiveRowsByMonth(rows, type) {
  const groups = new Map();
  for (const row of rows || []) {
    const monthKey = monthKeyFromTs(row?.ts);
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(row);
  }
  for (const [monthKey, groupedRows] of groups.entries()) {
    const entry = getArchiveEntry(monthKey, true);
    if (!entry) throw new Error(`Archive DB open failed for month ${monthKey}`);
    if (type === "readings") entry.insertReadingsTx(groupedRows);
    else entry.insertEnergyTx(groupedRows);
  }
}

function archiveReadingsRows(rows) {
  archiveRowsByMonth(rows, "readings");
}

function archiveEnergyRows(rows) {
  archiveRowsByMonth(rows, "energy");
}

function safeFileSize(filePath) {
  try {
    return Number(fs.statSync(filePath).size || 0);
  } catch (_) {
    return 0;
  }
}

function getArchiveDirStats() {
  const stats = { fileCount: 0, totalBytes: 0 };
  try {
    const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.db$/i.test(entry.name)) continue;
      stats.fileCount += 1;
      stats.totalBytes += safeFileSize(path.join(ARCHIVE_DIR, entry.name));
    }
  } catch (_) {
    // Ignore archive stats failures during best-effort telemetry pruning.
  }
  return stats;
}

function checkpointArchiveDbs(mode = "TRUNCATE") {
  for (const entry of ARCHIVE_DB_CACHE.values()) {
    try {
      entry.db.pragma(`wal_checkpoint(${mode})`);
    } catch (_) {
      // Ignore archive checkpoint failures during routine maintenance.
    }
  }
}

function checkpointMainDb(mode = "TRUNCATE") {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
    return true;
  } catch (err) {
    console.error("[DB] WAL checkpoint failed:", err.message);
    return false;
  }
}

function vacuumMainDb() {
  try {
    db.exec("VACUUM");
    return true;
  } catch (err) {
    console.error("[DB] VACUUM failed:", err.message);
    return false;
  }
}

function getTelemetryHotCutoffTs(now = Date.now()) {
  const retainDays = Math.max(1, Number(getSetting("retainDays", 90)));
  return Number(now || Date.now()) - retainDays * 24 * 60 * 60 * 1000;
}

function archiveTelemetryBeforeCutoff(cutoffTs) {
  const cutoff = Number(cutoffTs || 0);
  const stats = { readings: 0, energy5: 0 };
  if (!(cutoff > 0)) return stats;

  while (true) {
    const rows = selectOldReadingsBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "readings");
    deleteReadingsBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    stats.readings += rows.length;
  }

  while (true) {
    const rows = selectOldEnergyBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "energy");
    deleteEnergyBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    stats.energy5 += rows.length;
  }

  return stats;
}

function pruneOldData(options = {}) {
  const opts =
    options && typeof options === "object" ? options : {};
  try {
    const retainDays = Math.max(1, Number(getSetting("retainDays", 90)));
    const auditRetainDays = Math.max(1, Number(getSetting("auditRetainDays", 365)));
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditRetainDays * 24 * 60 * 60 * 1000;
    const mainDbBytesBefore = safeFileSize(DB_PATH);
    const archiveBefore = getArchiveDirStats();
    const archived = archiveTelemetryBeforeCutoff(cutoff);
    db.prepare("DELETE FROM alarms WHERE ts < ? AND cleared_ts IS NOT NULL").run(cutoff);
    db.prepare("DELETE FROM audit_log WHERE ts < ?").run(auditCutoff);
    checkpointArchiveDbs("TRUNCATE");
    const checkpointed = checkpointMainDb("TRUNCATE");
    const vacuumRequested =
      !!opts.vacuum && (archived.readings > 0 || archived.energy5 > 0 || !!opts.forceVacuum);
    const vacuumed = vacuumRequested ? vacuumMainDb() : false;
    if (vacuumed) checkpointMainDb("TRUNCATE");
    const mainDbBytesAfter = safeFileSize(DB_PATH);
    const archiveAfter = getArchiveDirStats();
    const result = {
      ok: true,
      retainDays,
      auditRetainDays,
      archived,
      checkpointed,
      vacuumed,
      mainDbBytesBefore,
      mainDbBytesAfter,
      archiveDbFilesBefore: archiveBefore.fileCount,
      archiveDbFilesAfter: archiveAfter.fileCount,
      archiveBytesBefore: archiveBefore.totalBytes,
      archiveBytesAfter: archiveAfter.totalBytes,
    };
    console.log(
      `[DB] Old data pruned. Archived readings=${archived.readings}, energy_5min=${archived.energy5}, vacuumed=${vacuumed}.`,
    );
    return result;
  } catch (err) {
    console.error("[DB] pruneOldData failed:", err.message);
    return {
      ok: false,
      error: err.message || "Unknown prune error.",
      archived: { readings: 0, energy5: 0 },
      checkpointed: false,
      vacuumed: false,
      mainDbBytesBefore: safeFileSize(DB_PATH),
      mainDbBytesAfter: safeFileSize(DB_PATH),
      archiveDbFilesBefore: getArchiveDirStats().fileCount,
      archiveDbFilesAfter: getArchiveDirStats().fileCount,
      archiveBytesBefore: getArchiveDirStats().totalBytes,
      archiveBytesAfter: getArchiveDirStats().totalBytes,
    };
  }
}

function closeArchiveDbs() {
  for (const entry of ARCHIVE_DB_CACHE.values()) {
    try {
      entry.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (_) {
      // Ignore archive checkpoint failures during shutdown.
    }
    try {
      entry.db.close();
    } catch (_) {
      // Ignore archive close failures during shutdown.
    }
  }
  ARCHIVE_DB_CACHE.clear();
}

function closeDb() {
  checkpointMainDb("TRUNCATE");
  closeArchiveDbs();
  try {
    db.close();
  } catch (err) {
    console.error("[DB] close failed:", err.message);
  }
}

module.exports = {
  db,
  stmts,
  bulkInsert,
  bulkUpsertForecastDayAhead,
  bulkUpsertForecastIntradayAdjusted,
  bulkUpsertSolcastSnapshot,
  getSolcastSnapshotForDay,
  getSetting,
  setSetting,
  pruneOldData,
  closeDb,
  DATA_DIR,
  ARCHIVE_DIR,
  SUMMARY_SOLAR_START_H,
  SUMMARY_SOLAR_END_H,
  SUMMARY_MAX_GAP_S,
  localDateStr,
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
  readPendingMainDbReplacement,
  beginArchiveDbReplacement,
  endArchiveDbReplacement,
  validateSqliteFileSync,
  insertChatMessage,
  getChatThread,
  getChatInboxAfterId,
  getLatestChatInboundId,
  markChatReadUpToId,
  clearAllChatMessages,
};
