"use strict";
/**
 * db.js — SQLite database layer (WAL mode, production hardened)
 * Adds: audit_log table for control action tracking
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXPLICIT_DATA_DIR = String(process.env.ADSI_DATA_DIR || "").trim();
const PORTABLE_ROOT = String(process.env.ADSI_PORTABLE_DATA_DIR || "").trim();
const DATA_DIR = EXPLICIT_DATA_DIR
  ? EXPLICIT_DATA_DIR
  : PORTABLE_ROOT
    ? path.join(PORTABLE_ROOT, "db")
    : process.env.APPDATA
      ? path.join(process.env.APPDATA, "ADSI-Dashboard")
      : path.join(os.homedir(), ".adsi-dashboard");

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "adsi.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -64000");
db.pragma("temp_store = memory");
db.pragma("mmap_size = 268435456");

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    inverter  INTEGER NOT NULL,
    unit      INTEGER NOT NULL,
    vdc       REAL DEFAULT 0,
    idc       REAL DEFAULT 0,
    vac1      REAL DEFAULT 0,
    vac2      REAL DEFAULT 0,
    vac3      REAL DEFAULT 0,
    iac1      REAL DEFAULT 0,
    iac2      REAL DEFAULT 0,
    iac3      REAL DEFAULT 0,
    pac       REAL DEFAULT 0,
    kwh       REAL DEFAULT 0,
    alarm     INTEGER DEFAULT 0,
    online    INTEGER DEFAULT 1
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
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    UNIQUE(date, inverter)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT,
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );

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
`);

function ensureColumn(tableName, columnName, columnDDL) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (cols.some((c) => String(c?.name || "") === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDDL}`);
}

// Migration: ensure replication-friendly update tracking columns exist.
ensureColumn("alarms", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("daily_report", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("settings", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_a_updated_ts ON alarms(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_daily_report_updated_ts ON daily_report(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_settings_updated_ts ON settings(updated_ts);
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
`);

const stmts = {
  insertReading: db.prepare(`
    INSERT INTO readings (ts,inverter,unit,vdc,idc,vac1,vac2,vac3,iac1,iac2,iac3,pac,kwh,alarm,online)
    VALUES (@ts,@inverter,@unit,@vdc,@idc,@vac1,@vac2,@vac3,@iac1,@iac2,@iac3,@pac,@kwh,@alarm,@online)
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
    `SELECT * FROM readings WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  get5minRange: db.prepare(
    `SELECT * FROM energy_5min WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  get5minRangeAll: db.prepare(
    `SELECT * FROM energy_5min WHERE ts BETWEEN ? AND ? ORDER BY inverter, ts ASC`,
  ),
  upsertDailyReport: db.prepare(`
    INSERT INTO daily_report(date,inverter,kwh_total,pac_peak,pac_avg,uptime_s,alarm_count,updated_ts)
    VALUES(?,?,?,?,?,?,?,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(date,inverter) DO UPDATE SET
      kwh_total=excluded.kwh_total,
      pac_peak=excluded.pac_peak,
      pac_avg=excluded.pac_avg,
      uptime_s=excluded.uptime_s,
      alarm_count=excluded.alarm_count,
      updated_ts=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  `),
  getDailyReport: db.prepare(
    `SELECT * FROM daily_report WHERE date=? ORDER BY inverter`,
  ),
  getDailyReportRange: db.prepare(
    `SELECT * FROM daily_report WHERE date BETWEEN ? AND ? ORDER BY date, inverter`,
  ),
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
  deleteForecastDayAheadDate: db.prepare(
    `DELETE FROM forecast_dayahead WHERE date=?`,
  ),
  getForecastDayAheadDate: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_dayahead
     WHERE date=?
     ORDER BY ts ASC`,
  ),
  getForecastDayAheadRange: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_dayahead
     WHERE ts BETWEEN ? AND ?
     ORDER BY ts ASC`,
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

function getSetting(key, def = null) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  stmts.setSetting.run(key, String(value), Date.now());
}
function pruneOldData() {
  try {
    const retainDays = Math.max(1, Number(getSetting("retainDays", 90)));
    const auditRetainDays = Math.max(1, Number(getSetting("auditRetainDays", 365)));
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditRetainDays * 24 * 60 * 60 * 1000;
    db.prepare("DELETE FROM readings    WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM energy_5min WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM alarms      WHERE ts < ? AND cleared_ts IS NOT NULL").run(cutoff);
    db.prepare("DELETE FROM audit_log   WHERE ts < ?").run(auditCutoff);
    console.log("[DB] Old data pruned.");
  } catch (err) {
    console.error("[DB] pruneOldData failed:", err.message);
  }
}

module.exports = {
  db,
  stmts,
  bulkInsert,
  bulkUpsertForecastDayAhead,
  getSetting,
  setSetting,
  pruneOldData,
  DATA_DIR,
};
