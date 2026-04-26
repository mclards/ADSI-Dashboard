"use strict";
/**
 * db.js — SQLite database layer (WAL mode, production hardened)
 * Adds: audit_log table for control action tracking
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { getExplicitDataDir, getPortableDataRoot } = require("./runtimeEnvPaths");
const { resolvedDbDir, getNewRoot, isMigrationComplete } = require("./storagePaths");

const EXPLICIT_DATA_DIR = getExplicitDataDir();
const PORTABLE_ROOT = getPortableDataRoot();
function resolveDataDir() {
  if (EXPLICIT_DATA_DIR) return EXPLICIT_DATA_DIR;
  if (PORTABLE_ROOT) return path.join(PORTABLE_ROOT, "db");
  // v2.4.43+: prefer consolidated layout under %PROGRAMDATA%\InverterDashboard\db
  const newDir = resolvedDbDir();
  if (newDir) return newDir;
  // Legacy fallback for pre-migration installs.
  if (process.env.APPDATA) {
    const preferred = path.join(process.env.APPDATA, "Inverter-Dashboard");
    const legacy    = path.join(process.env.APPDATA, "ADSI-Dashboard");
    // Rename pre-v2.x dir transparently on first run.
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

// On Windows, %PROGRAMDATA% directories default to Users:RX only.
// Ensure the DB directory is writable so SQLite can open in WAL mode.
(function ensureWritableOnWindows() {
  if (process.platform !== "win32") return;
  if (!DATA_DIR.toLowerCase().includes("programdata")) return;
  try {
    // Quick probe: try creating a temp file to verify write access.
    const probe = path.join(DATA_DIR, ".write-probe");
    fs.writeFileSync(probe, "", { flag: "w" });
    fs.unlinkSync(probe);
  } catch {
    // Write failed — attempt to fix ACL.
    try {
      const { spawnSync } = require("child_process");
      const r = spawnSync("icacls", [DATA_DIR, "/grant", "Users:(OI)(CI)M", "/T", "/Q"], {
        windowsHide: true,
        timeout: 15000,
      });
      if (r.error) throw r.error;
      console.log("[db] Granted Users write access to", DATA_DIR);
    } catch (err) {
      console.warn("[db] Could not grant Users write access to", DATA_DIR, ":", err.message);
    }
  }
})();

const DB_PATH = path.join(DATA_DIR, "adsi.db");
const MAIN_DB_PENDING_REPLACEMENT_PATH = path.join(
  DATA_DIR,
  ".pending-main-db-replacement.json",
);
// v2.5.0+ consolidated layout: archive lives at %PROGRAMDATA%\InverterDashboard\archive\
// (one level above DATA_DIR which is the db/ subdirectory). Explicit data-dir overrides
// and portable mode continue to use DATA_DIR/archive as before.
const ARCHIVE_DIR = (() => {
  if (EXPLICIT_DATA_DIR || PORTABLE_ROOT) return path.join(DATA_DIR, "archive");
  const newArchive = path.join(getNewRoot(), "archive");
  if (isMigrationComplete() || fs.existsSync(newArchive)) return newArchive;
  return path.join(DATA_DIR, "archive");
})();
const SUMMARY_SOLAR_START_H = 5;
const SUMMARY_SOLAR_END_H = 18;
const SUMMARY_MAX_GAP_S = 120;
const ARCHIVE_BATCH_SIZE = 2000; // reduced from 5000 — smaller batches keep event-loop pauses under ~80ms
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

function discardPendingMainDbReplacement(tempName = "") {
  const pending = readPendingMainDbReplacement();
  if (!pending) {
    return { cleared: false, tempRemoved: false };
  }
  const expectedTempName = path.basename(String(tempName || "").trim());
  const pendingTempName = path.basename(String(pending?.tempName || "").trim());
  if (expectedTempName && pendingTempName && pendingTempName !== expectedTempName) {
    return { cleared: false, tempRemoved: false, skipped: true };
  }
  let tempRemoved = false;
  if (pendingTempName) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, pendingTempName));
      tempRemoved = true;
    } catch (_) {
      tempRemoved = false;
    }
  }
  writePendingMainDbReplacement(null);
  return { cleared: true, tempRemoved };
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

// v2.8.10 Phase C: pre-open integrity probe + auto-restore from rotating
// backup slots. Before the live `new Database(DB_PATH)` call, we cheaply
// inspect the main DB for corruption (sqlite header + quick_check in a
// throwaway readonly handle). If it fails, we swap in the newer of the
// two 2-hour backup slots written by server/index.js runPeriodicBackup.
// This converts "app fails to boot after torn write" into "app boots,
// shows banner, and loses at most ~2h of readings that the poller refills".
const BACKUP_DIR_FOR_RESTORE = path.join(DATA_DIR, "backups");
const startupIntegrityResult = {
  mainDb: "unknown",          // "ok" | "corrupt" | "missing" | "error"
  restored: false,             // true if we swapped in a backup slot
  restoredFromSlot: null,      // 0 | 1 | null
  restoredAt: 0,               // epoch ms
  unrescuable: false,          // true if main + all backups were corrupt → fresh DB
  unrescuableAt: 0,            // epoch ms when we gave up
  quickCheck: "",              // raw PRAGMA quick_check(1) result
  backupCandidates: [],        // [{slot, path, size, mtimeMs, ok}]
  checkedAt: 0,
  // v2.8.14 nightly-reboot diagnostics. Populated from the ADSI_LAST_SHUTDOWN_JSON
  // env var written by electron/main.js via electron/shutdownReason.js. When the
  // env bridge isn't available (e.g. running the server standalone in tests)
  // we fall back to reading the archived prev-marker file directly.
  lastShutdown: null,          // { classification, priorReason, sentinelWasPresent, checkedAt }
};

(function _loadLastShutdownSnapshot() {
  const raw = String(process.env.ADSI_LAST_SHUTDOWN_JSON || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        startupIntegrityResult.lastShutdown = parsed;
        return;
      }
    } catch (_) { /* fall through to file read */ }
  }
  // Fallback: read prev-marker file directly. Kept simple — if anything
  // throws, we leave lastShutdown as null and the banner stays silent.
  try {
    const programData = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
    const prevPath = path.join(programData, "InverterDashboard", "lifecycle", "shutdown-reason.prev.json");
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      startupIntegrityResult.lastShutdown = {
        classification: prev?.reason === "unexpected-shutdown" ? "unexpected" : "graceful",
        priorReason: prev,
        sentinelWasPresent: true,
        checkedAt: Number(prev?.timestamp || 0),
      };
    }
  } catch (_) { /* leave lastShutdown null */ }
})();

function _sqliteFileLooksValidSync(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return false;
    const st = fs.statSync(targetPath);
    if (!st.isFile() || st.size < 64) return false;
    const fd = fs.openSync(targetPath, "r");
    try {
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
      return header.toString("utf8", 0, 15) === "SQLite format 3";
    } finally {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  } catch (_) {
    return false;
  }
}

function _probeDbIntegritySync(targetPath) {
  let probe = null;
  try {
    probe = new Database(targetPath, { readonly: true, fileMustExist: true });
    const qc = String(probe.prepare("PRAGMA quick_check(1)").pluck().get() || "").trim().toLowerCase();
    return { ok: qc === "ok", quickCheck: qc };
  } catch (err) {
    return { ok: false, quickCheck: String(err?.message || err) };
  } finally {
    try { probe?.close(); } catch (_) { /* ignore */ }
  }
}

function _listBackupSlotsForRestore() {
  const slots = [];
  try {
    if (!fs.existsSync(BACKUP_DIR_FOR_RESTORE)) return slots;
    for (const slot of [0, 1]) {
      const p = path.join(BACKUP_DIR_FOR_RESTORE, `adsi_backup_${slot}.db`);
      if (!_sqliteFileLooksValidSync(p)) continue;
      try {
        const st = fs.statSync(p);
        slots.push({ slot, path: p, size: st.size, mtimeMs: st.mtimeMs, ok: null });
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  // Newest first
  slots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return slots;
}

function _autoRestoreMainDbFromBackupSync() {
  const mainExists = fs.existsSync(DB_PATH);
  startupIntegrityResult.checkedAt = Date.now();
  if (!mainExists) {
    startupIntegrityResult.mainDb = "missing";
    console.warn(`[DB] adsi.db missing at ${DB_PATH} — fresh DB will be created on open`);
    return;
  }
  if (!_sqliteFileLooksValidSync(DB_PATH)) {
    startupIntegrityResult.mainDb = "corrupt";
    startupIntegrityResult.quickCheck = "header invalid";
  } else {
    const probe = _probeDbIntegritySync(DB_PATH);
    startupIntegrityResult.quickCheck = probe.quickCheck;
    startupIntegrityResult.mainDb = probe.ok ? "ok" : "corrupt";
  }
  if (startupIntegrityResult.mainDb === "ok") {
    console.log("[DB] Startup quick_check: ok");
    return;
  }
  console.error(
    `[DB] Main DB corrupt at startup (${startupIntegrityResult.quickCheck}). ` +
    `Attempting auto-restore from rotating backup slots.`,
  );
  const candidates = _listBackupSlotsForRestore();
  startupIntegrityResult.backupCandidates = candidates.map((c) => ({ ...c }));
  for (const cand of candidates) {
    const probe = _probeDbIntegritySync(cand.path);
    cand.ok = probe.ok;
    if (!probe.ok) {
      console.warn(`[DB] Backup slot ${cand.slot} also corrupt: ${probe.quickCheck}`);
      continue;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${DB_PATH}.corrupt-${stamp}`;
    try {
      for (const suffix of ["-wal", "-shm"]) {
        try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch (_) { /* ignore */ }
      }
      try { fs.renameSync(DB_PATH, quarantinePath); }
      catch (err) { console.warn(`[DB] Quarantine rename failed: ${err.message}`); }
      fs.copyFileSync(cand.path, DB_PATH);
      startupIntegrityResult.restored = true;
      startupIntegrityResult.restoredFromSlot = cand.slot;
      startupIntegrityResult.restoredAt = Date.now();
      // The restored file is known-good — clear the corrupt flag so the
      // post-open quick_check path can assert "ok". `restored` remains
      // true so the renderer banner fires.
      startupIntegrityResult.mainDb = "ok";
      startupIntegrityResult.quickCheck = "restored-from-backup";
      console.log(
        `[DB] Auto-restored adsi.db from backup slot ${cand.slot} ` +
        `(${cand.size} bytes, mtime=${new Date(cand.mtimeMs).toISOString()}). ` +
        `Previous corrupt DB quarantined at ${quarantinePath}.`,
      );
      return;
    } catch (err) {
      console.error(`[DB] Auto-restore from slot ${cand.slot} failed: ${err.message}`);
    }
  }
  // Last-resort fallback: the main DB is corrupt and no backup rescued us.
  // Opening a file that isn't a valid SQLite DB throws SQLITE_NOTADB from
  // better-sqlite3, crashing the server. For a 24/7 monitoring system it is
  // better to quarantine the dead file and boot with a fresh empty DB —
  // the poller will fill it with new readings and the operator can perform
  // a cloud restore if they need the historical record back.
  if (!_sqliteFileLooksValidSync(DB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${DB_PATH}.unrescuable-${stamp}`;
    try {
      fs.renameSync(DB_PATH, quarantinePath);
      for (const suffix of ["-wal", "-shm"]) {
        try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch (_) { /* ignore */ }
      }
      startupIntegrityResult.unrescuable = true;
      startupIntegrityResult.unrescuableAt = Date.now();
      startupIntegrityResult.quickCheck = "quarantined-fresh-db";
      console.error(
        `[DB] Unrescuable DB quarantined at ${quarantinePath}. ` +
        `Booting with a fresh empty DB — live polling and cloud restore can recover data.`,
      );
    } catch (err) {
      console.error(`[DB] Unrescuable-quarantine rename failed: ${err.message}`);
    }
  } else {
    console.error("[DB] No usable backup slot found — opening corrupt DB as-is (live data may be inaccessible).");
  }
}

_autoRestoreMainDbFromBackupSync();

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");  // WAL+NORMAL is crash-safe; FULL adds fsync per commit that blocks the event loop
db.pragma("busy_timeout = 1500");   // Low timeout: better-sqlite3 blocks event loop during contention; fail fast
db.pragma("cache_size = -64000");
db.pragma("temp_store = memory");
db.pragma("mmap_size = 268435456");

// Post-open quick_check — covers the case where the file validated readonly
// but became inconsistent after WAL playback on open.
try {
  const qc = String(db.prepare("PRAGMA quick_check(1)").pluck().get() || "").trim().toLowerCase();
  startupIntegrityResult.quickCheck = qc;
  if (qc !== "ok") {
    startupIntegrityResult.mainDb = "corrupt";
    console.error(`[DB] Post-open quick_check FAILED: ${qc}`);
  } else if (startupIntegrityResult.mainDb !== "corrupt") {
    startupIntegrityResult.mainDb = "ok";
    console.log("[DB] Post-open quick_check: ok");
  }
} catch (qcErr) {
  console.error("[DB] Post-open quick_check error:", qcErr.message);
}

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

  CREATE TABLE IF NOT EXISTS availability_5min (
    ts              INTEGER PRIMARY KEY,
    online_count    INTEGER NOT NULL DEFAULT 0,
    expected_count  INTEGER NOT NULL DEFAULT 0
  );

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
    ip        TEXT DEFAULT '',
    reason    TEXT DEFAULT ''
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

  CREATE TABLE IF NOT EXISTS forecast_run_audit (
    id                          INTEGER PRIMARY KEY,
    target_date                 TEXT    NOT NULL,
    generated_ts                INTEGER NOT NULL,
    generator_mode              TEXT    NOT NULL,
    provider_used               TEXT    NOT NULL,
    provider_expected           TEXT,
    forecast_variant            TEXT    NOT NULL,
    weather_source              TEXT,
    solcast_snapshot_day         TEXT,
    solcast_snapshot_pulled_ts   INTEGER,
    solcast_snapshot_age_sec     INTEGER,
    solcast_snapshot_coverage_ratio REAL,
    solcast_snapshot_source      TEXT,
    solcast_mean_blend           REAL,
    solcast_reliability          REAL,
    solcast_primary_mode         INTEGER NOT NULL DEFAULT 0,
    solcast_raw_total_kwh        REAL,
    solcast_applied_total_kwh    REAL,
    physics_total_kwh            REAL,
    hybrid_total_kwh             REAL,
    final_forecast_total_kwh     REAL,
    ml_residual_total_kwh        REAL,
    error_class_total_kwh        REAL,
    bias_total_kwh               REAL,
    shape_skipped_for_solcast    INTEGER NOT NULL DEFAULT 0,
    run_status                   TEXT    NOT NULL,
    solcast_freshness_class      TEXT,
    is_authoritative_runtime     INTEGER NOT NULL DEFAULT 1,
    is_authoritative_learning    INTEGER NOT NULL DEFAULT 1,
    superseded_by_run_audit_id   INTEGER,
    replaces_run_audit_id        INTEGER,
    attempt_number               INTEGER NOT NULL DEFAULT 1,
    notes_json                   TEXT,
    UNIQUE(target_date, generated_ts, forecast_variant)
  );
  CREATE INDEX IF NOT EXISTS idx_fra_target ON forecast_run_audit(target_date);
  CREATE INDEX IF NOT EXISTS idx_fra_variant_ts ON forecast_run_audit(forecast_variant, generated_ts DESC);

  CREATE TABLE IF NOT EXISTS forecast_error_compare_daily (
    id                        INTEGER PRIMARY KEY,
    target_date               TEXT    NOT NULL,
    run_audit_id              INTEGER NOT NULL DEFAULT 0,
    generator_mode            TEXT,
    provider_used             TEXT    NOT NULL,
    provider_expected         TEXT,
    forecast_variant          TEXT,
    weather_source            TEXT,
    solcast_freshness_class   TEXT,
    total_forecast_kwh        REAL,
    total_forecast_lo_kwh     REAL,
    total_forecast_hi_kwh     REAL,
    total_actual_kwh          REAL,
    total_abs_error_kwh       REAL,
    daily_wape_pct            REAL,
    daily_mape_pct            REAL,
    daily_total_ape_pct       REAL,
    usable_slot_count         INTEGER NOT NULL DEFAULT 0,
    masked_slot_count         INTEGER NOT NULL DEFAULT 0,
    available_actual_slots    INTEGER NOT NULL DEFAULT 0,
    available_forecast_slots  INTEGER NOT NULL DEFAULT 0,
    manual_masked_slots       INTEGER NOT NULL DEFAULT 0,
    cap_masked_slots          INTEGER NOT NULL DEFAULT 0,
    operational_masked_slots  INTEGER NOT NULL DEFAULT 0,
    include_in_error_memory   INTEGER NOT NULL DEFAULT 0,
    include_in_source_scoring INTEGER NOT NULL DEFAULT 0,
    comparison_quality        TEXT    NOT NULL DEFAULT 'review',
    computed_ts               INTEGER NOT NULL,
    notes_json                TEXT,
    UNIQUE(target_date, run_audit_id)
  );

  CREATE TABLE IF NOT EXISTS forecast_error_compare_slot (
    id                        INTEGER PRIMARY KEY,
    target_date               TEXT    NOT NULL,
    run_audit_id              INTEGER NOT NULL DEFAULT 0,
    daily_compare_id          INTEGER,
    slot                      INTEGER NOT NULL,
    ts_local                  INTEGER NOT NULL DEFAULT 0,
    time_hms                  TEXT    NOT NULL DEFAULT '',
    provider_used             TEXT    NOT NULL,
    forecast_kwh              REAL,
    actual_kwh                REAL,
    solcast_kwh               REAL,
    physics_kwh               REAL,
    hybrid_baseline_kwh       REAL,
    ml_residual_kwh           REAL,
    error_class_bias_kwh      REAL,
    memory_bias_kwh           REAL,
    signed_error_kwh          REAL,
    abs_error_kwh             REAL,
    ape_pct                   REAL,
    normalized_error          REAL,
    opportunity_kwh           REAL,
    slot_weather_bucket       TEXT,
    day_regime                TEXT,
    actual_present            INTEGER NOT NULL DEFAULT 0,
    forecast_present          INTEGER NOT NULL DEFAULT 0,
    solcast_present           INTEGER NOT NULL DEFAULT 0,
    usable_for_metrics        INTEGER NOT NULL DEFAULT 0,
    usable_for_error_memory   INTEGER NOT NULL DEFAULT 0,
    manual_constraint_mask    INTEGER NOT NULL DEFAULT 0,
    cap_dispatch_mask         INTEGER NOT NULL DEFAULT 0,
    curtailed_mask            INTEGER NOT NULL DEFAULT 0,
    operational_mask          INTEGER NOT NULL DEFAULT 0,
    solar_mask                INTEGER NOT NULL DEFAULT 0,
    rad_wm2                   REAL,
    cloud_pct                 REAL,
    support_weight            REAL,
    UNIQUE(target_date, run_audit_id, slot)
  );
  CREATE TABLE IF NOT EXISTS scheduled_maintenance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter   INTEGER NOT NULL DEFAULT 0,
    start_ts   INTEGER NOT NULL,
    end_ts     INTEGER NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_maintenance_time ON scheduled_maintenance(start_ts, end_ts);

  CREATE TABLE IF NOT EXISTS plant_cap_schedules (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    name                     TEXT NOT NULL DEFAULT 'Schedule',
    enabled                  INTEGER NOT NULL DEFAULT 1,
    start_time               TEXT NOT NULL DEFAULT '08:00',
    stop_time                TEXT NOT NULL DEFAULT '17:00',
    upper_mw                 REAL,
    lower_mw                 REAL,
    sequence_mode            TEXT DEFAULT NULL,
    sequence_custom_json     TEXT NOT NULL DEFAULT '[]',
    cooldown_sec             INTEGER DEFAULT NULL,
    current_state            TEXT NOT NULL DEFAULT 'waiting',
    active_session_id        TEXT DEFAULT NULL,
    total_stop_actions       INTEGER NOT NULL DEFAULT 0,
    total_start_actions      INTEGER NOT NULL DEFAULT 0,
    inverter_stop_count_json TEXT NOT NULL DEFAULT '{}',
    continuous_run_minutes   INTEGER NOT NULL DEFAULT 0,
    safety_pause_reason      TEXT DEFAULT NULL,
    watchdog_last_tick_at    INTEGER DEFAULT NULL,
    last_activated_at        INTEGER DEFAULT NULL,
    last_run_date            TEXT DEFAULT NULL,
    created_ts               INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    updated_ts               INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );

  CREATE TABLE IF NOT EXISTS substation_metered_energy (
    date         TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    mwh          REAL NOT NULL,
    entered_by   TEXT DEFAULT 'admin',
    entered_at   INTEGER DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    updated_by   TEXT,
    updated_at   INTEGER,
    PRIMARY KEY (date, ts)
  );

  CREATE TABLE IF NOT EXISTS substation_meter_daily (
    date            TEXT PRIMARY KEY,
    sync_time       TEXT,
    desync_time     TEXT,
    total_gen_mwhr  REAL,
    net_kwh         REAL,
    deviation_pct   REAL,
    entered_by      TEXT DEFAULT 'admin',
    entered_at      INTEGER DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );

  -- Day-ahead locked snapshot (v2.8+): immutable frozen Solcast P10/P50/P90
  -- captured at or before 10 AM local for the NEXT trading day. First write
  -- per (forecast_day, slot) wins; subsequent captures are no-ops.
  CREATE TABLE IF NOT EXISTS solcast_dayahead_locked (
    forecast_day    TEXT    NOT NULL,   -- YYYY-MM-DD the forecast is FOR (day D+1)
    slot            INTEGER NOT NULL,   -- 0..287 (5-min slot of day)
    ts_local        INTEGER NOT NULL,   -- Unix ms, start of slot in Asia/Manila
    period_end_utc  TEXT,
    period          TEXT,                -- e.g. "PT5M"
    p50_mw          REAL,                -- Solcast forecast_mw at capture time
    p10_mw          REAL,                -- Solcast forecast_lo_mw
    p90_mw          REAL,                -- Solcast forecast_hi_mw
    p50_kwh         REAL,
    p10_kwh         REAL,
    p90_kwh         REAL,
    spread_mw       REAL,                -- p90_mw - p10_mw
    spread_pct_cap  REAL,                -- spread_mw / plant_cap_mw * 100 (robust; NOT divided by p50)
    captured_ts     INTEGER NOT NULL,    -- Unix ms when we froze this
    captured_local  TEXT    NOT NULL,    -- "YYYY-MM-DDTHH:MM:SS" Asia/Manila
    capture_reason  TEXT    NOT NULL,    -- 'scheduled_0600' | 'scheduled_0955' | 'manual' | 'backfill_approx'
    solcast_source  TEXT    NOT NULL,    -- 'toolkit' | 'api'
    plant_cap_mw    REAL,                -- plant capacity at capture time
    PRIMARY KEY (forecast_day, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_sdl_captured_ts ON solcast_dayahead_locked(captured_ts);
  CREATE INDEX IF NOT EXISTS idx_sdl_capture_reason ON solcast_dayahead_locked(capture_reason);

  -- Full append-only Solcast pull history (v2.8+): every autoFetchSolcastSnapshots()
  -- call appends rows for all pulled slots. Used to measure band-collapse trajectory
  -- and feed the spread-weighted learning loop. 90-day retention via prune cron.
  CREATE TABLE IF NOT EXISTS solcast_snapshot_history (
    forecast_day    TEXT    NOT NULL,
    slot            INTEGER NOT NULL,
    captured_ts     INTEGER NOT NULL,    -- unique per pull
    pulled_ts       INTEGER NOT NULL,    -- Solcast's own pulled_ts for the record
    p50_mw          REAL,
    p10_mw          REAL,
    p90_mw          REAL,
    est_actual_mw   REAL,
    age_sec         INTEGER,              -- at capture time, how old was Solcast's data
    solcast_source  TEXT,
    PRIMARY KEY (forecast_day, slot, captured_ts)
  );
  CREATE INDEX IF NOT EXISTS idx_ssh_day_captured ON solcast_snapshot_history(forecast_day, captured_ts);
  CREATE INDEX IF NOT EXISTS idx_ssh_day_slot ON solcast_snapshot_history(forecast_day, slot);
  CREATE INDEX IF NOT EXISTS idx_ssh_captured_ts ON solcast_snapshot_history(captured_ts);

  -- v2.9.0 Slice B: hardware-counter state (upserted on every poll).
  -- One row per (inverter, unit); constant-size table (~91 rows).
  CREATE TABLE IF NOT EXISTS inverter_counter_state (
    inverter      INTEGER NOT NULL,
    unit          INTEGER NOT NULL,
    ts_ms         INTEGER NOT NULL,
    etotal_kwh    INTEGER DEFAULT 0,
    parce_kwh     INTEGER DEFAULT 0,
    rtc_ms        INTEGER,
    rtc_valid     INTEGER NOT NULL DEFAULT 0,
    rtc_drift_s   REAL,
    pac_w         INTEGER DEFAULT 0,
    fac_hz        REAL,
    alarm_32      INTEGER DEFAULT 0,
    counter_advancing INTEGER DEFAULT 1,
    updated_ts    INTEGER NOT NULL
                  DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY (inverter, unit)
  );
  CREATE INDEX IF NOT EXISTS idx_ics_updated ON inverter_counter_state(updated_ts);

  -- v2.9.0 Slice B: per-day baselines (one row per unit per local date).
  -- v2.9.1: extended with eod_clean_* columns capturing the day's
  --         post-1800H rolling-last hardware-counter snapshot. Tomorrow's
  --         baseline is derived from this row's eod_clean fields, not from
  --         tomorrow's first-poll value (which may be a transient bad read).
  CREATE TABLE IF NOT EXISTS inverter_counter_baseline (
    inverter           INTEGER NOT NULL,
    unit               INTEGER NOT NULL,
    date_key           TEXT NOT NULL,
    etotal_baseline    INTEGER NOT NULL,
    parce_baseline     INTEGER NOT NULL,
    baseline_ts_ms     INTEGER NOT NULL,
    source             TEXT NOT NULL DEFAULT 'poll',
    etotal_eod_clean   INTEGER,
    parce_eod_clean    INTEGER,
    eod_clean_ts_ms    INTEGER,
    eod_clean_pac_w    INTEGER,
    updated_ts         INTEGER NOT NULL
                       DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY (inverter, unit, date_key)
  );
  CREATE INDEX IF NOT EXISTS idx_icb_date    ON inverter_counter_baseline(date_key);
  CREATE INDEX IF NOT EXISTS idx_icb_updated ON inverter_counter_baseline(updated_ts);

  -- v2.9.0 Slice D: clock-sync attempt log.
  CREATE TABLE IF NOT EXISTS inverter_clock_sync_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               INTEGER NOT NULL,
    inverter         INTEGER NOT NULL,
    unit             INTEGER NOT NULL,
    trigger          TEXT NOT NULL,
    target_iso       TEXT,
    drift_before_s   REAL,
    drift_after_s    REAL,
    accepted         INTEGER DEFAULT 0,
    error            TEXT,
    updated_ts       INTEGER NOT NULL
                     DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_icsl_ts  ON inverter_clock_sync_log(ts);
  CREATE INDEX IF NOT EXISTS idx_icsl_inv ON inverter_clock_sync_log(inverter, ts);
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
// Migration: store plant-cap decision reason in audit_log (added 2026-03).
ensureColumn("audit_log", "reason", "reason TEXT DEFAULT ''");

// v2.9.1 — EOD-clean rolling-last snapshot columns. Captured post-1800H local
// from the last PAC>0 polls; tomorrow's etotal_baseline is derived from these
// fields so a transient bad first-poll value cannot inflate today's recovered
// kWh.
ensureColumn("inverter_counter_baseline", "etotal_eod_clean", "etotal_eod_clean INTEGER");
ensureColumn("inverter_counter_baseline", "parce_eod_clean",  "parce_eod_clean INTEGER");
ensureColumn("inverter_counter_baseline", "eod_clean_ts_ms",  "eod_clean_ts_ms INTEGER");
ensureColumn("inverter_counter_baseline", "eod_clean_pac_w",  "eod_clean_pac_w INTEGER");

// v2.9.1 Phase 3 — daily totals per energy source. PAC remains in kwh_total
// (back-compat). Hardware-counter totals are NULL until end-of-day rollup
// computes them from the day's first/last counter_state ticks.
ensureColumn("daily_report", "kwh_total_etotal", "kwh_total_etotal REAL");
ensureColumn("daily_report", "kwh_total_parce",  "kwh_total_parce REAL");
// Forecast compare persistence (detailed provenance/error-memory basis).
ensureColumn("forecast_error_compare_daily", "run_audit_id", "run_audit_id INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "generator_mode", "generator_mode TEXT");
ensureColumn("forecast_error_compare_daily", "provider_expected", "provider_expected TEXT");
ensureColumn("forecast_error_compare_daily", "weather_source", "weather_source TEXT");
ensureColumn("forecast_error_compare_daily", "solcast_freshness_class", "solcast_freshness_class TEXT");
ensureColumn("forecast_error_compare_daily", "total_abs_error_kwh", "total_abs_error_kwh REAL");
ensureColumn("forecast_error_compare_daily", "daily_mape_pct", "daily_mape_pct REAL");
ensureColumn("forecast_error_compare_daily", "daily_total_ape_pct", "daily_total_ape_pct REAL");
ensureColumn("forecast_error_compare_daily", "usable_slot_count", "usable_slot_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "masked_slot_count", "masked_slot_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "available_actual_slots", "available_actual_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "available_forecast_slots", "available_forecast_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "manual_masked_slots", "manual_masked_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "cap_masked_slots", "cap_masked_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "operational_masked_slots", "operational_masked_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "include_in_error_memory", "include_in_error_memory INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "include_in_source_scoring", "include_in_source_scoring INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "comparison_quality", "comparison_quality TEXT NOT NULL DEFAULT 'review'");
ensureColumn("forecast_error_compare_daily", "computed_ts", "computed_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "notes_json", "notes_json TEXT");

// Migration: forecast confidence band totals for EMOS-B spread calibration (added 2026-03).
ensureColumn("forecast_error_compare_daily", "total_forecast_lo_kwh", "total_forecast_lo_kwh REAL");
ensureColumn("forecast_error_compare_daily", "total_forecast_hi_kwh", "total_forecast_hi_kwh REAL");
// Migration: track actual data source (metered, mixed, estimated) for error memory & loss calibration (added 2026-04).
ensureColumn("forecast_error_compare_daily", "actual_source", "actual_source TEXT DEFAULT 'estimated'");
ensureColumn("forecast_error_compare_slot", "actual_source", "actual_source TEXT DEFAULT 'estimated'");
// Migration: track retry attempt number per forecast run (added 2026-03).
ensureColumn("forecast_run_audit", "attempt_number", "attempt_number INTEGER NOT NULL DEFAULT 1");
// Migration: Solcast tri-band baseline totals for FPM pipeline (added 2026-04).
ensureColumn("forecast_run_audit", "solcast_lo_total_kwh", "solcast_lo_total_kwh REAL");
ensureColumn("forecast_run_audit", "solcast_hi_total_kwh", "solcast_hi_total_kwh REAL");
ensureColumn("forecast_run_audit", "baseline_is_solcast_mid", "baseline_is_solcast_mid INTEGER NOT NULL DEFAULT 0");
// Backfill: mark all rows as Solcast-based, backfill mid baseline, clear stale physics.
// NOTE: solcast_lo/hi_total_kwh are NOT backfilled from snapshots — tri-band P10/P90
// only exists for day-ahead (future) slots. Past dates have estimated actuals, not real bands.
try {
  // 1. Mark all rows as Solcast-based (new architecture)
  db.prepare(
    `UPDATE forecast_run_audit SET baseline_is_solcast_mid = 1 WHERE baseline_is_solcast_mid = 0`
  ).run();

  // 2. Backfill hybrid_total_kwh (Solcast mid) from snapshots for rows missing it
  const _auditRows = db.prepare(
    `SELECT DISTINCT target_date FROM forecast_run_audit WHERE hybrid_total_kwh IS NULL`
  ).all();
  if (_auditRows.length > 0) {
    const _updMid = db.prepare(`
      UPDATE forecast_run_audit
         SET hybrid_total_kwh = @mid
       WHERE target_date = @day AND hybrid_total_kwh IS NULL
    `);
    const _getSnapMid = db.prepare(`
      SELECT ROUND(SUM(forecast_kwh), 2) AS mid FROM solcast_snapshots WHERE forecast_day = ?
    `);
    let _filled = 0;
    for (const { target_date } of _auditRows) {
      const snap = _getSnapMid.get(target_date);
      if (snap && snap.mid > 0) {
        _updMid.run({ day: target_date, mid: snap.mid });
        _filled++;
      }
    }
    if (_filled > 0) console.log(`[db] Backfilled Solcast mid baseline on ${_filled} audit date(s)`);
  }

  // 3. Clear stale physics_total_kwh and incorrectly-backfilled lo/hi on historical rows
  db.prepare(
    `UPDATE forecast_run_audit SET physics_total_kwh = NULL WHERE physics_total_kwh IS NOT NULL`
  ).run();
  const _clearedLo = db.prepare(
    `UPDATE forecast_run_audit SET solcast_lo_total_kwh = NULL, solcast_hi_total_kwh = NULL
     WHERE solcast_lo_total_kwh IS NOT NULL
       AND target_date < date('now', '+1 day')`
  ).run();
  if (_clearedLo.changes > 0) console.log(`[db] Cleared historical lo/hi on ${_clearedLo.changes} audit rows (tri-band only valid for day-ahead)`);
} catch (e) { console.warn("[db] Solcast baseline backfill warning:", e.message); }
ensureColumn("forecast_error_compare_slot", "run_audit_id", "run_audit_id INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "daily_compare_id", "daily_compare_id INTEGER");
ensureColumn("forecast_error_compare_slot", "ts_local", "ts_local INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "time_hms", "time_hms TEXT NOT NULL DEFAULT ''");
ensureColumn("forecast_error_compare_slot", "solcast_kwh", "solcast_kwh REAL");
ensureColumn("forecast_error_compare_slot", "physics_kwh", "physics_kwh REAL");
ensureColumn("forecast_error_compare_slot", "hybrid_baseline_kwh", "hybrid_baseline_kwh REAL");
ensureColumn("forecast_error_compare_slot", "ml_residual_kwh", "ml_residual_kwh REAL");
ensureColumn("forecast_error_compare_slot", "error_class_bias_kwh", "error_class_bias_kwh REAL");
ensureColumn("forecast_error_compare_slot", "memory_bias_kwh", "memory_bias_kwh REAL");
ensureColumn("forecast_error_compare_slot", "signed_error_kwh", "signed_error_kwh REAL");
ensureColumn("forecast_error_compare_slot", "abs_error_kwh", "abs_error_kwh REAL");
ensureColumn("forecast_error_compare_slot", "ape_pct", "ape_pct REAL");
ensureColumn("forecast_error_compare_slot", "normalized_error", "normalized_error REAL");
ensureColumn("forecast_error_compare_slot", "opportunity_kwh", "opportunity_kwh REAL");
ensureColumn("forecast_error_compare_slot", "slot_weather_bucket", "slot_weather_bucket TEXT");
ensureColumn("forecast_error_compare_slot", "day_regime", "day_regime TEXT");
ensureColumn("forecast_error_compare_slot", "actual_present", "actual_present INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "forecast_present", "forecast_present INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "solcast_present", "solcast_present INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "usable_for_metrics", "usable_for_metrics INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "usable_for_error_memory", "usable_for_error_memory INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "manual_constraint_mask", "manual_constraint_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "cap_dispatch_mask", "cap_dispatch_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "curtailed_mask", "curtailed_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "operational_mask", "operational_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "solar_mask", "solar_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "rad_wm2", "rad_wm2 REAL");
ensureColumn("forecast_error_compare_slot", "cloud_pct", "cloud_pct REAL");
ensureColumn("forecast_error_compare_slot", "support_weight", "support_weight REAL");

// Migration: day-ahead locked snapshot errors (v2.8+, added 2026-04).
// These capture the 10 AM locked P10/P50/P90 vs actual, letting the error
// memory system learn from what was actually submittable at submission time,
// not from "whatever Solcast said most recently".
ensureColumn("forecast_error_compare_slot", "p50_locked_mw", "p50_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "p10_locked_mw", "p10_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "p90_locked_mw", "p90_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "spread_pct_cap_locked", "spread_pct_cap_locked REAL");
ensureColumn("forecast_error_compare_slot", "err_vs_p50_locked_mw", "err_vs_p50_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "err_vs_p10_locked_mw", "err_vs_p10_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "err_vs_p90_locked_mw", "err_vs_p90_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "actual_within_band", "actual_within_band INTEGER");
// Daily roll-up of locked-snapshot accuracy (for FPM dashboard and learning-loop aggregates).
ensureColumn("forecast_error_compare_daily", "locked_captured_ts", "locked_captured_ts INTEGER");
ensureColumn("forecast_error_compare_daily", "locked_capture_reason", "locked_capture_reason TEXT");
ensureColumn("forecast_error_compare_daily", "locked_spread_pct_cap_avg", "locked_spread_pct_cap_avg REAL");
ensureColumn("forecast_error_compare_daily", "locked_total_p50_kwh", "locked_total_p50_kwh REAL");
ensureColumn("forecast_error_compare_daily", "locked_total_p10_kwh", "locked_total_p10_kwh REAL");
ensureColumn("forecast_error_compare_daily", "locked_total_p90_kwh", "locked_total_p90_kwh REAL");
ensureColumn("forecast_error_compare_daily", "locked_within_band_pct", "locked_within_band_pct REAL");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_a_updated_ts ON alarms(updated_ts);
  -- Covers stmts.getActiveAlarmForUnit (WHERE cleared_ts IS NULL AND inverter=? AND unit=?).
  -- Keeps per-unit active-row lookup O(log N) on large historical alarm tables.
  CREATE INDEX IF NOT EXISTS idx_a_open_inv_unit ON alarms(inverter, unit, cleared_ts);
  CREATE INDEX IF NOT EXISTS idx_daily_report_updated_ts ON daily_report(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_settings_updated_ts ON settings(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_summary_date_inv ON daily_readings_summary(date, inverter, unit);
  CREATE INDEX IF NOT EXISTS idx_summary_updated_ts ON daily_readings_summary(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_fra_target_authority ON forecast_run_audit(target_date, is_authoritative_runtime, generated_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_fecd_target ON forecast_error_compare_daily(target_date);
  CREATE INDEX IF NOT EXISTS idx_fecd_mem_target ON forecast_error_compare_daily(include_in_error_memory, target_date DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fecd_target_run ON forecast_error_compare_daily(target_date, run_audit_id);
  CREATE INDEX IF NOT EXISTS idx_fecs_target_slot ON forecast_error_compare_slot(target_date, slot);
  CREATE INDEX IF NOT EXISTS idx_fecs_mem_target ON forecast_error_compare_slot(usable_for_error_memory, target_date DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fecs_target_run_slot ON forecast_error_compare_slot(target_date, run_audit_id, slot);
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

// One-time consolidation of legacy duplicate open alarm rows (audit 2026-04-24,
// finding F5).  Before the v2.8.x hydration fix landed, a server restart that
// coincided with a still-active alarm could insert a second open row for the
// same (inverter, unit).  The runtime dedup in getActiveAlarms hides the
// symptom at the UI layer, but the duplicate rows still inflate per-inverter
// alarm counts and distort episode-duration export.  This migration closes
// all but the newest open row per (inverter, unit), marking the losers with
// cleared_ts=now so they stop participating in active-alarm queries.
try {
  // updated_ts is set explicitly here (not via trigger) because this block runs
  // BEFORE trg_alarms_touch_updated_ts is created below. Without the explicit
  // stamp the cloud-backup replication cursor (updated_ts ASC) would never
  // pull the consolidation to remote viewers, and they would keep the stale
  // duplicate open rows forever.
  const consolidateResult = db.prepare(`
    UPDATE alarms
       SET cleared_ts = ${NOW_MS_SQL},
           updated_ts = ${NOW_MS_SQL}
     WHERE cleared_ts IS NULL
       AND id NOT IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (PARTITION BY inverter, unit
                                     ORDER BY ts DESC, id DESC) AS rn
             FROM alarms
            WHERE cleared_ts IS NULL
         )
         WHERE rn = 1
       )
  `).run();
  if (consolidateResult?.changes > 0) {
    console.log(
      `[db] Consolidated ${consolidateResult.changes} legacy duplicate open alarm row(s) — kept newest per (inverter, unit)`,
    );
  }
} catch (e) {
  console.warn("[db] Alarm duplicate consolidation warning:", e.message);
}

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
  updateActiveAlarm: db.prepare(
    `UPDATE alarms
       SET alarm_code=?,
           alarm_value=?,
           severity=?
     WHERE inverter=? AND unit=? AND cleared_ts IS NULL`,
  ),
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
  upsertAvailability5min: db.prepare(
    `INSERT INTO availability_5min(ts, online_count, expected_count) VALUES(?, ?, ?)
     ON CONFLICT(ts) DO UPDATE SET online_count=excluded.online_count, expected_count=excluded.expected_count`,
  ),
  getAvailability5minRange: db.prepare(
    `SELECT ts, online_count, expected_count FROM availability_5min WHERE ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  getActiveAlarms: db.prepare(
    `SELECT * FROM alarms WHERE cleared_ts IS NULL ORDER BY ts DESC`,
  ),
  // T2.5 fix (Phase 5, 2026-04-14): fetch the still-active alarm row for a
  // single (inverter, unit), if any.  Used on first batch after restart to
  // avoid inserting a duplicate active row when the in-memory tracker has
  // not yet been hydrated from DB state.
  getActiveAlarmForUnit: db.prepare(
    `SELECT id, alarm_code, alarm_value, severity, ts FROM alarms
      WHERE cleared_ts IS NULL AND inverter = ? AND unit = ?
      ORDER BY ts DESC LIMIT 1`,
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
  countReadingsRange: db.prepare(
    `SELECT COUNT(*) AS n FROM readings WHERE inverter=? AND ts BETWEEN ? AND ?`,
  ),
  countReadingsRangeAll: db.prepare(
    `SELECT COUNT(*) AS n FROM readings WHERE ts BETWEEN ? AND ?`,
  ),
  countEnergy5minRangeAll: db.prepare(
    `SELECT COUNT(*) AS n FROM energy_5min WHERE ts BETWEEN ? AND ?`,
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
      availability_pct,performance_pct,node_uptime_s,expected_node_uptime_s,expected_nodes,rated_kw,
      kwh_total_etotal,kwh_total_parce,updated_ts
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
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
      kwh_total_etotal=excluded.kwh_total_etotal,
      kwh_total_parce=excluded.kwh_total_parce,
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
      period_end_utc=COALESCE(excluded.period_end_utc, solcast_snapshots.period_end_utc),
      period=COALESCE(excluded.period, solcast_snapshots.period),
      -- v2.8 audit fix (R2): COALESCE the forecast_* columns. Previous behavior
      -- force-overwrote them, so a partial late-day fetch (e.g. network timeout
      -- mid-parse) could erase morning slots that were good. The est_actual_*
      -- columns already used COALESCE; this brings forecast_* in line.
      forecast_mw=COALESCE(excluded.forecast_mw, solcast_snapshots.forecast_mw),
      forecast_lo_mw=COALESCE(excluded.forecast_lo_mw, solcast_snapshots.forecast_lo_mw),
      forecast_hi_mw=COALESCE(excluded.forecast_hi_mw, solcast_snapshots.forecast_hi_mw),
      est_actual_mw=COALESCE(excluded.est_actual_mw, solcast_snapshots.est_actual_mw),
      forecast_kwh=COALESCE(excluded.forecast_kwh, solcast_snapshots.forecast_kwh),
      forecast_lo_kwh=COALESCE(excluded.forecast_lo_kwh, solcast_snapshots.forecast_lo_kwh),
      forecast_hi_kwh=COALESCE(excluded.forecast_hi_kwh, solcast_snapshots.forecast_hi_kwh),
      est_actual_kwh=COALESCE(excluded.est_actual_kwh, solcast_snapshots.est_actual_kwh),
      pulled_ts=excluded.pulled_ts,
      source=excluded.source,
      updated_ts=excluded.updated_ts
  `),
  backfillSolcastEstActual: db.prepare(`
    UPDATE solcast_snapshots
       SET est_actual_mw  = @est_actual_mw,
           est_actual_kwh = @est_actual_kwh,
           updated_ts     = @updated_ts
     WHERE forecast_day = @forecast_day
       AND slot = @slot
       AND est_actual_kwh IS NULL
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
  // Day-ahead locked snapshot (v2.8+): INSERT OR IGNORE — first write wins.
  insertDayAheadLocked: db.prepare(`
    INSERT OR IGNORE INTO solcast_dayahead_locked(
      forecast_day, slot, ts_local, period_end_utc, period,
      p50_mw, p10_mw, p90_mw, p50_kwh, p10_kwh, p90_kwh,
      spread_mw, spread_pct_cap,
      captured_ts, captured_local, capture_reason, solcast_source, plant_cap_mw
    ) VALUES (
      @forecast_day, @slot, @ts_local, @period_end_utc, @period,
      @p50_mw, @p10_mw, @p90_mw, @p50_kwh, @p10_kwh, @p90_kwh,
      @spread_mw, @spread_pct_cap,
      @captured_ts, @captured_local, @capture_reason, @solcast_source, @plant_cap_mw
    )
  `),
  countDayAheadLocked: db.prepare(
    `SELECT COUNT(*) AS n FROM solcast_dayahead_locked WHERE forecast_day = ?`,
  ),
  getDayAheadLocked: db.prepare(
    `SELECT forecast_day, slot, ts_local, period_end_utc, period,
            p50_mw, p10_mw, p90_mw, p50_kwh, p10_kwh, p90_kwh,
            spread_mw, spread_pct_cap,
            captured_ts, captured_local, capture_reason, solcast_source, plant_cap_mw
       FROM solcast_dayahead_locked
      WHERE forecast_day = ?
      ORDER BY slot ASC`,
  ),
  getDayAheadLockedMeta: db.prepare(
    `SELECT forecast_day,
            MIN(captured_ts)   AS captured_ts,
            MIN(captured_local) AS captured_local,
            MIN(capture_reason) AS capture_reason,
            MIN(solcast_source) AS solcast_source,
            MIN(plant_cap_mw)   AS plant_cap_mw,
            AVG(spread_pct_cap) AS spread_pct_cap_avg,
            MAX(spread_pct_cap) AS spread_pct_cap_max,
            SUM(p50_kwh)        AS total_p50_kwh,
            SUM(p10_kwh)        AS total_p10_kwh,
            SUM(p90_kwh)        AS total_p90_kwh,
            COUNT(*)            AS slot_count
       FROM solcast_dayahead_locked
      WHERE forecast_day = ?`,
  ),
  // Append-only snapshot history (v2.8+): every autoFetchSolcastSnapshots() call writes here.
  insertSnapshotHistory: db.prepare(`
    INSERT OR REPLACE INTO solcast_snapshot_history(
      forecast_day, slot, captured_ts, pulled_ts,
      p50_mw, p10_mw, p90_mw, est_actual_mw, age_sec, solcast_source
    ) VALUES (
      @forecast_day, @slot, @captured_ts, @pulled_ts,
      @p50_mw, @p10_mw, @p90_mw, @est_actual_mw, @age_sec, @solcast_source
    )
  `),
  pruneSnapshotHistoryBefore: db.prepare(
    `DELETE FROM solcast_snapshot_history WHERE captured_ts < ?`,
  ),
  getSnapshotHistoryDayTrajectory: db.prepare(
    `SELECT forecast_day, slot, captured_ts, pulled_ts,
            p50_mw, p10_mw, p90_mw, est_actual_mw, age_sec, solcast_source
       FROM solcast_snapshot_history
      WHERE forecast_day = ?
      ORDER BY slot ASC, captured_ts ASC`,
  ),
  getLatestForecastRunAuditForDate: db.prepare(
    `SELECT * FROM forecast_run_audit
      WHERE target_date = ?
      ORDER BY generated_ts DESC LIMIT 1`
  ),
  getLatestAuthoritativeForecastRunAuditForDate: db.prepare(
    `SELECT * FROM forecast_run_audit
      WHERE target_date = ?
        AND run_status = 'success'
      ORDER BY is_authoritative_runtime DESC, generated_ts DESC
      LIMIT 1`
  ),
  insertForecastRunAudit: db.prepare(`
    INSERT INTO forecast_run_audit (
      target_date, generated_ts, generator_mode, provider_used, provider_expected,
      forecast_variant, weather_source, solcast_snapshot_day, solcast_snapshot_pulled_ts,
      solcast_snapshot_age_sec, solcast_snapshot_coverage_ratio, solcast_snapshot_source,
      solcast_mean_blend, solcast_reliability, solcast_primary_mode,
      solcast_raw_total_kwh, solcast_applied_total_kwh, physics_total_kwh, hybrid_total_kwh,
      final_forecast_total_kwh, ml_residual_total_kwh, error_class_total_kwh, bias_total_kwh,
      shape_skipped_for_solcast, run_status, solcast_freshness_class,
      is_authoritative_runtime, is_authoritative_learning,
      superseded_by_run_audit_id, replaces_run_audit_id, notes_json,
      solcast_lo_total_kwh, solcast_hi_total_kwh, baseline_is_solcast_mid
    ) VALUES (
      @target_date, @generated_ts, @generator_mode, @provider_used, @provider_expected,
      @forecast_variant, @weather_source, @solcast_snapshot_day, @solcast_snapshot_pulled_ts,
      @solcast_snapshot_age_sec, @solcast_snapshot_coverage_ratio, @solcast_snapshot_source,
      @solcast_mean_blend, @solcast_reliability, @solcast_primary_mode,
      @solcast_raw_total_kwh, @solcast_applied_total_kwh, @physics_total_kwh, @hybrid_total_kwh,
      @final_forecast_total_kwh, @ml_residual_total_kwh, @error_class_total_kwh, @bias_total_kwh,
      @shape_skipped_for_solcast, @run_status, @solcast_freshness_class,
      @is_authoritative_runtime, @is_authoritative_learning,
      @superseded_by_run_audit_id, @replaces_run_audit_id, @notes_json,
      @solcast_lo_total_kwh, @solcast_hi_total_kwh, @baseline_is_solcast_mid
    )
  `),
  updateForecastRunAudit: db.prepare(`
    UPDATE forecast_run_audit
       SET is_authoritative_runtime = @is_authoritative_runtime,
           is_authoritative_learning = @is_authoritative_learning,
           superseded_by_run_audit_id = @superseded_by_run_audit_id,
           replaces_run_audit_id = COALESCE(@replaces_run_audit_id, replaces_run_audit_id),
           run_status = COALESCE(@run_status, run_status),
           notes_json = @notes_json
     WHERE id = @id
  `),
  getForecastRunAuditById: db.prepare(
    `SELECT * FROM forecast_run_audit WHERE id = ? LIMIT 1`
  ),
  insertForecastErrorCompareDaily: db.prepare(`
    INSERT INTO forecast_error_compare_daily(
      target_date, run_audit_id, generator_mode,
      provider_used, provider_expected, forecast_variant, weather_source, solcast_freshness_class,
      total_forecast_kwh, total_actual_kwh, total_abs_error_kwh,
      daily_wape_pct, daily_mape_pct, daily_total_ape_pct,
      usable_slot_count, masked_slot_count,
      available_actual_slots, available_forecast_slots,
      manual_masked_slots, cap_masked_slots, operational_masked_slots,
      include_in_error_memory, include_in_source_scoring, comparison_quality,
      computed_ts, notes_json
    ) VALUES(
      @target_date, @run_audit_id, @generator_mode,
      @provider_used, @provider_expected, @forecast_variant, @weather_source, @solcast_freshness_class,
      @total_forecast_kwh, @total_actual_kwh, @total_abs_error_kwh,
      @daily_wape_pct, @daily_mape_pct, @daily_total_ape_pct,
      @usable_slot_count, @masked_slot_count,
      @available_actual_slots, @available_forecast_slots,
      @manual_masked_slots, @cap_masked_slots, @operational_masked_slots,
      @include_in_error_memory, @include_in_source_scoring, @comparison_quality,
      @computed_ts, @notes_json
    )
    ON CONFLICT(target_date, run_audit_id) DO UPDATE SET
      generator_mode=excluded.generator_mode,
      provider_used=excluded.provider_used,
      provider_expected=excluded.provider_expected,
      forecast_variant=excluded.forecast_variant,
      weather_source=excluded.weather_source,
      solcast_freshness_class=excluded.solcast_freshness_class,
      total_forecast_kwh=excluded.total_forecast_kwh,
      total_actual_kwh=excluded.total_actual_kwh,
      total_abs_error_kwh=excluded.total_abs_error_kwh,
      daily_wape_pct=excluded.daily_wape_pct,
      daily_mape_pct=excluded.daily_mape_pct,
      daily_total_ape_pct=excluded.daily_total_ape_pct,
      usable_slot_count=excluded.usable_slot_count,
      masked_slot_count=excluded.masked_slot_count,
      available_actual_slots=excluded.available_actual_slots,
      available_forecast_slots=excluded.available_forecast_slots,
      manual_masked_slots=excluded.manual_masked_slots,
      cap_masked_slots=excluded.cap_masked_slots,
      operational_masked_slots=excluded.operational_masked_slots,
      include_in_error_memory=excluded.include_in_error_memory,
      include_in_source_scoring=excluded.include_in_source_scoring,
      comparison_quality=excluded.comparison_quality,
      computed_ts=excluded.computed_ts,
      notes_json=excluded.notes_json
  `),
  insertForecastErrorCompareSlot: db.prepare(`
    INSERT INTO forecast_error_compare_slot(
      target_date, run_audit_id, daily_compare_id, slot, ts_local, time_hms,
      provider_used, forecast_kwh, actual_kwh, solcast_kwh, physics_kwh, hybrid_baseline_kwh,
      ml_residual_kwh, error_class_bias_kwh, memory_bias_kwh,
      signed_error_kwh, abs_error_kwh, ape_pct, normalized_error, opportunity_kwh,
      slot_weather_bucket, day_regime,
      actual_present, forecast_present, solcast_present,
      usable_for_metrics, usable_for_error_memory,
      manual_constraint_mask, cap_dispatch_mask, curtailed_mask, operational_mask, solar_mask,
      rad_wm2, cloud_pct, support_weight
    ) VALUES(
      @target_date, @run_audit_id, @daily_compare_id, @slot, @ts_local, @time_hms,
      @provider_used, @forecast_kwh, @actual_kwh, @solcast_kwh, @physics_kwh, @hybrid_baseline_kwh,
      @ml_residual_kwh, @error_class_bias_kwh, @memory_bias_kwh,
      @signed_error_kwh, @abs_error_kwh, @ape_pct, @normalized_error, @opportunity_kwh,
      @slot_weather_bucket, @day_regime,
      @actual_present, @forecast_present, @solcast_present,
      @usable_for_metrics, @usable_for_error_memory,
      @manual_constraint_mask, @cap_dispatch_mask, @curtailed_mask, @operational_mask, @solar_mask,
      @rad_wm2, @cloud_pct, @support_weight
    )
    ON CONFLICT(target_date, run_audit_id, slot) DO UPDATE SET
      daily_compare_id=excluded.daily_compare_id,
      ts_local=excluded.ts_local,
      time_hms=excluded.time_hms,
      provider_used=excluded.provider_used,
      forecast_kwh=excluded.forecast_kwh,
      actual_kwh=excluded.actual_kwh,
      solcast_kwh=excluded.solcast_kwh,
      physics_kwh=excluded.physics_kwh,
      hybrid_baseline_kwh=excluded.hybrid_baseline_kwh,
      ml_residual_kwh=excluded.ml_residual_kwh,
      error_class_bias_kwh=excluded.error_class_bias_kwh,
      memory_bias_kwh=excluded.memory_bias_kwh,
      signed_error_kwh=excluded.signed_error_kwh,
      abs_error_kwh=excluded.abs_error_kwh,
      ape_pct=excluded.ape_pct,
      normalized_error=excluded.normalized_error,
      opportunity_kwh=excluded.opportunity_kwh,
      slot_weather_bucket=excluded.slot_weather_bucket,
      day_regime=excluded.day_regime,
      actual_present=excluded.actual_present,
      forecast_present=excluded.forecast_present,
      solcast_present=excluded.solcast_present,
      usable_for_metrics=excluded.usable_for_metrics,
      usable_for_error_memory=excluded.usable_for_error_memory,
      manual_constraint_mask=excluded.manual_constraint_mask,
      cap_dispatch_mask=excluded.cap_dispatch_mask,
      curtailed_mask=excluded.curtailed_mask,
      operational_mask=excluded.operational_mask,
      solar_mask=excluded.solar_mask,
      rad_wm2=excluded.rad_wm2,
      cloud_pct=excluded.cloud_pct,
      support_weight=excluded.support_weight
  `),
  getForecastErrorCompareSlotsForDays: db.prepare(`
    SELECT target_date, run_audit_id, slot, provider_used,
           forecast_kwh, actual_kwh, signed_error_kwh, abs_error_kwh,
           usable_for_error_memory, support_weight
      FROM forecast_error_compare_slot
     WHERE target_date IN (SELECT value FROM json_each(?))
     ORDER BY target_date ASC, run_audit_id ASC, slot ASC
  `),
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
  // v2.9.0 Slice B — hardware counter persistence
  upsertCounterState: db.prepare(
    `INSERT INTO inverter_counter_state
       (inverter, unit, ts_ms, etotal_kwh, parce_kwh,
        rtc_ms, rtc_valid, rtc_drift_s, pac_w, fac_hz, alarm_32,
        counter_advancing, updated_ts)
     VALUES
       (@inverter, @unit, @ts_ms, @etotal_kwh, @parce_kwh,
        @rtc_ms, @rtc_valid, @rtc_drift_s, @pac_w, @fac_hz, @alarm_32,
        @counter_advancing, @now)
     ON CONFLICT(inverter, unit) DO UPDATE SET
       ts_ms             = excluded.ts_ms,
       etotal_kwh        = excluded.etotal_kwh,
       parce_kwh         = excluded.parce_kwh,
       rtc_ms            = excluded.rtc_ms,
       rtc_valid         = excluded.rtc_valid,
       rtc_drift_s       = excluded.rtc_drift_s,
       pac_w             = excluded.pac_w,
       fac_hz            = excluded.fac_hz,
       alarm_32          = excluded.alarm_32,
       counter_advancing = excluded.counter_advancing,
       updated_ts        = excluded.updated_ts`,
  ),
  selectCounterStateOne: db.prepare(
    `SELECT inverter, unit, ts_ms, etotal_kwh, parce_kwh,
            rtc_ms, rtc_valid, rtc_drift_s, pac_w, fac_hz, alarm_32,
            counter_advancing
       FROM inverter_counter_state
      WHERE inverter=? AND unit=?`,
  ),
  selectCounterStateAll: db.prepare(
    `SELECT inverter, unit, ts_ms, etotal_kwh, parce_kwh,
            rtc_ms, rtc_valid, rtc_drift_s, pac_w, fac_hz, alarm_32,
            counter_advancing
       FROM inverter_counter_state
      ORDER BY inverter, unit`,
  ),
  insertBaseline: db.prepare(
    `INSERT OR IGNORE INTO inverter_counter_baseline
       (inverter, unit, date_key, etotal_baseline, parce_baseline,
        baseline_ts_ms, source, updated_ts)
     VALUES
       (@inverter, @unit, @date_key, @etotal_baseline, @parce_baseline,
        @baseline_ts_ms, @source, @now)`,
  ),
  selectBaselineOne: db.prepare(
    `SELECT etotal_baseline, parce_baseline, baseline_ts_ms, source,
            etotal_eod_clean, parce_eod_clean, eod_clean_ts_ms, eod_clean_pac_w
       FROM inverter_counter_baseline
      WHERE inverter=? AND unit=? AND date_key=?`,
  ),
  selectBaselinesForDate: db.prepare(
    `SELECT inverter, unit, etotal_baseline, parce_baseline,
            baseline_ts_ms, source,
            etotal_eod_clean, parce_eod_clean, eod_clean_ts_ms, eod_clean_pac_w
       FROM inverter_counter_baseline
      WHERE date_key=?
      ORDER BY inverter, unit`,
  ),
  // v2.9.1 — Roll the post-1800H clean snapshot. Etotal/parcE are monotonic
  // so we always overwrite with the latest values; pac_w stamp helps audit.
  upsertEodClean: db.prepare(
    `UPDATE inverter_counter_baseline
        SET etotal_eod_clean = @etotal_eod_clean,
            parce_eod_clean  = @parce_eod_clean,
            eod_clean_ts_ms  = @eod_clean_ts_ms,
            eod_clean_pac_w  = @eod_clean_pac_w,
            updated_ts       = @now
      WHERE inverter=@inverter AND unit=@unit AND date_key=@date_key`,
  ),
  selectBaselineEodClean: db.prepare(
    `SELECT inverter, unit, date_key, etotal_eod_clean, parce_eod_clean,
            eod_clean_ts_ms, eod_clean_pac_w
       FROM inverter_counter_baseline
      WHERE date_key=?`,
  ),
  insertClockSyncLog: db.prepare(
    `INSERT INTO inverter_clock_sync_log
       (ts, inverter, unit, trigger, target_iso,
        drift_before_s, drift_after_s, accepted, error)
     VALUES
       (@ts, @inverter, @unit, @trigger, @target_iso,
        @drift_before_s, @drift_after_s, @accepted, @error)`,
  ),
  selectClockSyncLog: db.prepare(
    `SELECT id, ts, inverter, unit, trigger, target_iso,
            drift_before_s, drift_after_s, accepted, error
       FROM inverter_clock_sync_log
      ORDER BY ts DESC
      LIMIT ?`,
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

// Combined transaction: insert readings + update daily summary in one commit.
// Halves fsync cost compared to running bulkInsert then ingestDailyReadingsSummary separately.
const bulkInsertWithSummary = db.transaction((rows) => {
  for (const row of rows) {
    try {
      stmts.insertReading.run(row);
    } catch (err) {
      console.error("[DB] bulkInsertWithSummary row failed:", err.message, row);
    }
  }
  // Inline the summary ingestion within the same transaction.
  const states = new Map();
  for (const row of rows) {
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
  if (states.size) {
    const now = Date.now();
    const payloads = Array.from(states.values()).map((s) => summaryStateToPayload(s, now));
    for (const payload of payloads) {
      stmts.upsertDailyReadingsSummary.run(payload);
    }
  }
});

// v2.9.0 Slice B/F — in-memory counter history for counter_advancing gate.
// Keyed by `${inverter}_${unit}`; list of {ts_ms, etotal_kwh, parce_kwh, pac_w}.
// Bounded by COUNTER_HISTORY_MAX_SAMPLES per key (default 30 ≈ 5 minutes @10s).
const COUNTER_HISTORY_MAX_SAMPLES = 30;
const counterHistory = new Map();

function _pushCounterHistory(inverter, unit, sample) {
  const key = `${inverter}_${unit}`;
  const arr = counterHistory.get(key) || [];
  arr.push(sample);
  while (arr.length > COUNTER_HISTORY_MAX_SAMPLES) arr.shift();
  counterHistory.set(key, arr);
  return arr;
}

function getCounterHistory(inverter, unit) {
  return counterHistory.get(`${inverter}_${unit}`) || [];
}

function evaluateCounterAdvancing(history, pacIdleW = 500, windowS = 300) {
  if (!history || history.length < 2) return 1; // insufficient data → assume OK
  const latestMs = history[history.length - 1].ts_ms || 0;
  const cutoff = latestMs - windowS * 1000;
  const recent = history.filter((r) => (r.ts_ms || 0) >= cutoff);
  if (recent.length < 2) return 1;
  const meanPac =
    recent.reduce((s, r) => s + Number(r.pac_w || 0), 0) / recent.length;
  if (meanPac < pacIdleW) return 1; // idle — no expected counter tick
  for (let i = 1; i < recent.length; i++) {
    if (Number(recent[i].etotal_kwh || 0) > Number(recent[i - 1].etotal_kwh || 0)) {
      return 1;
    }
  }
  return 0;
}

// ── Generic audit_log writer (v2.9.2) ────────────────────────────────────
//
// Used by the poller's recovery-seed/bucket spike clamps and any other
// background subsystem that needs to record a one-off event without
// duplicating the INSERT SQL. Failures are logged but never thrown — an
// audit-write failure must not break the hot poll path.
function insertAuditLogRow({
  ts,
  operator = "SYSTEM",
  inverter = 0,
  node = 0,
  action = "",
  scope = "single",
  result = "ok",
  ip = "",
  reason = "",
} = {}) {
  try {
    db.prepare(
      `INSERT INTO audit_log
         (ts, operator, inverter, node, action, scope, result, ip, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(ts) || Date.now(),
      String(operator),
      Math.trunc(Number(inverter) || 0),
      Math.trunc(Number(node) || 0),
      String(action),
      String(scope),
      String(result),
      String(ip),
      String(reason),
    );
    return true;
  } catch (err) {
    console.warn("[audit_log] insert failed:", err && err.message);
    return false;
  }
}

// ── eod_clean hardening helpers ──────────────────────────────────────────
//
// Verifies that yesterday's eod_clean snapshot is populated for every unit
// once we cross into the next solar window. Runs ONCE per local day (keyed
// on `todayKey`) so the audit cost is bounded regardless of poll frequency.
// Missing snapshots are surfaced in the console + an audit_log row so the
// operator can correlate "unit X shows NaN today" with "unit X did not
// capture last night" without grepping the live frames.
const _eodVerifyState = { lastVerifiedKey: "" };

// Per-(inverter, unit) "we already warned about a bad timestamp" cache so
// the log doesn't get drowned every poll cycle when one unit has clock skew.
// Cleared on local-day rollover via _eodVerifyOncePerDay.
const _eodTsWarnedKeys = new Set();

function _eodVerifyOncePerDay(todayKey, nowMs) {
  if (!todayKey || _eodVerifyState.lastVerifiedKey === todayKey) return;
  _eodVerifyState.lastVerifiedKey = todayKey;
  // New local day — purge per-unit ts-warn cache so transient skew issues
  // get re-surfaced instead of silently squelched forever.
  _eodTsWarnedKeys.clear();

  try {
    const yesterdayKey = localDateStr((Number(nowMs) || Date.now()) - 86400000);
    const rows = stmts.selectBaselinesForDate.all(yesterdayKey) || [];
    if (!rows.length) return; // no baselines for yesterday at all (fresh install / downtime)

    const missing = rows.filter((r) => {
      const ts = Number(r?.eod_clean_ts_ms || 0);
      const etot = Number(r?.etotal_eod_clean || 0);
      return ts <= 0 || etot <= 0;
    });
    if (!missing.length) return;

    const sample = missing
      .slice(0, 8)
      .map((r) => `inv${r.inverter}/u${r.unit}`)
      .join(", ");
    const more = missing.length > 8 ? `, +${missing.length - 8} more` : "";
    console.warn(
      `[counter] eod_clean MISSING on ${yesterdayKey} ` +
      `(${missing.length}/${rows.length} units): ${sample}${more}. ` +
      `Tomorrow's baseline for these units will fall back to first-frame value (source="poll"); ` +
      `Etotal/parcE today displays will show NaN until next post-1800H snapshot lands.`,
    );

    try {
      db.prepare(
        `INSERT INTO audit_log
           (ts, operator, inverter, node, action, scope, result, ip, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Number(nowMs) || Date.now(),
        "SYSTEM",
        0, // plant-wide
        0,
        "eod_clean_verify",
        `production_day=${yesterdayKey}`,
        "warn",
        "",
        `${missing.length}/${rows.length} units missing eod_clean snapshot: ` +
          missing.map((r) => `${r.inverter}/${r.unit}`).join(","),
      );
    } catch (auditErr) {
      console.warn("[counter] audit_log write failed:", auditErr.message);
    }
  } catch (err) {
    console.warn("[counter] eod_clean verify failed:", err.message);
  }
}

/**
 * v2.9.0 Slice B — persist hardware counter + RTC state for one poll frame.
 * Idempotent upsert; also records the first-of-day baseline for crash recovery.
 *
 * Frame MUST carry: inverter, unit, ts, etotal_kwh, parce_kwh,
 *                   rtc_valid, rtc_ms, rtc_drift_s, pac, fac_hz, alarm_32.
 * Fields default to zero/null when the underlying Python engine is pre-2.9.
 */
function persistCounterState(frame) {
  try {
    if (!frame) return;
    const inverter = Number(frame.inverter || 0);
    const unit = Number(frame.unit || 0);
    if (!inverter || !unit) return;

    const ts_ms = Number(frame.ts || Date.now());
    const etotal_kwh = Math.max(0, Math.trunc(Number(frame.etotal_kwh || 0)));
    const parce_kwh = Math.max(0, Math.trunc(Number(frame.parce_kwh || 0)));
    const rtc_valid = frame.rtc_valid === true || frame.rtc_valid === 1 ? 1 : 0;
    const rtc_ms_raw = Number(frame.rtc_ms);
    const rtc_ms = rtc_valid && Number.isFinite(rtc_ms_raw) ? rtc_ms_raw : null;
    const rtc_drift_s =
      rtc_valid && Number.isFinite(Number(frame.rtc_drift_s))
        ? Number(frame.rtc_drift_s)
        : null;
    // pac field in the poller row is already ×10 (W); keep as-is but clamp.
    const pac_w = Math.max(0, Math.min(Math.round(Number(frame.pac || 0)), 260_000));
    const fac_hz = Number.isFinite(Number(frame.fac_hz)) ? Number(frame.fac_hz) : null;
    const alarm_32 = Math.max(0, Math.trunc(Number(frame.alarm_32 || 0)));

    const history = _pushCounterHistory(inverter, unit, {
      ts_ms,
      etotal_kwh,
      parce_kwh,
      pac_w,
    });
    const counter_advancing = evaluateCounterAdvancing(history);

    const now = Date.now();
    stmts.upsertCounterState.run({
      inverter,
      unit,
      ts_ms,
      etotal_kwh,
      parce_kwh,
      rtc_ms,
      rtc_valid,
      rtc_drift_s,
      pac_w,
      fac_hz,
      alarm_32,
      counter_advancing,
      now,
    });

    // Seed today's baseline only from a trustworthy frame (RTC valid + non-zero).
    // v2.9.1 — preferred source for today's baseline is yesterday's
    // etotal_eod_clean (captured post-1800H, so identical to value-at-midnight
    // for a healthy unit). This avoids inflation when the dashboard's first
    // poll of the day lands on a transient bad read. Fall back to the first
    // frame's value only when yesterday has no clean EOD snapshot (e.g. fresh
    // install or downtime > 24 h).
    if (rtc_valid && etotal_kwh > 0) {
      const date_key = localDateStr(ts_ms);
      try {
        const existing = stmts.selectBaselineOne.get(inverter, unit, date_key);
        if (!existing) {
          const yesterdayKey = localDateStr(ts_ms - 86400000);
          const yPrev = stmts.selectBaselineOne.get(inverter, unit, yesterdayKey);
          const yEtotal = Number(yPrev?.etotal_eod_clean || 0);
          const yParce  = Number(yPrev?.parce_eod_clean  || 0);
          const yTs     = Number(yPrev?.eod_clean_ts_ms  || 0);
          const useEod  = yEtotal > 0 && yEtotal <= etotal_kwh && yTs > 0;
          stmts.insertBaseline.run({
            inverter,
            unit,
            date_key,
            etotal_baseline: useEod ? yEtotal : etotal_kwh,
            parce_baseline:  useEod ? yParce  : parce_kwh,
            baseline_ts_ms:  useEod ? yTs     : ts_ms,
            source: useEod ? "eod_clean" : "poll",
            now,
          });
          // Refresh the live-frame compute cache so the next tick picks up
          // the new baseline.source immediately (don't wait the 60 s TTL).
          invalidateBaselineCache();
        }

        // v2.9.1 hardening — roll-last EOD-clean snapshot during the FULL
        // dark window (18:00–04:59 local). Etotal/parcE are monotonic so
        // always-overwrite-within-window is correct; when PAC drops below
        // the clean-floor (sunset / cloud / alarm) we stop updating, freezing
        // the last clean values. Captures past midnight (00:00–04:59) are
        // attributed back to the PRODUCTION DAY that opened the window
        // (yesterday's date_key), not the calendar day they fall on, so the
        // snapshot always lives on the row of the day it represents.
        const eodHour = Math.max(
          0,
          Math.min(23, Number(getSetting("eodSnapshotHourLocal", 18)) || 18),
        );
        const pacCleanThreshold = Math.max(
          0,
          Number(getSetting("eodPacCleanThresholdW", 50)) || 50,
        );
        const solarStart = Math.max(
          0,
          Math.min(23, Number(getSetting("solarWindowStartHour", 5)) || 5),
        );
        const localHour = new Date(ts_ms).getHours();
        const inDarkWindow = localHour >= eodHour || localHour < solarStart;

        // ── Timestamp accuracy guard ────────────────────────────────────
        // Reject the capture if the frame's timestamp is corrupt, in the
        // future (clock skew on the gateway), or stale beyond the polling
        // budget. Without this, a bad ts_ms could anchor eod_clean_ts_ms
        // to a value that misrepresents WHEN the snapshot was actually
        // captured, and downstream "is yesterday's snapshot fresh?" checks
        // would silently accept it.
        const TS_FUTURE_TOL_MS = 5 * 1000;          // gateway is single-host; tiny tol is enough
        const TS_STALE_TOL_MS = 5 * 60 * 1000;       // poll cycle ≪ 5 min; anything older = stale
        const TS_SANE_FLOOR = 1700000000000;         // 2023-11-14 — sanity floor against ts=0/garbage
        const tsValid =
          Number.isFinite(ts_ms) &&
          ts_ms >= TS_SANE_FLOOR &&
          ts_ms - now <= TS_FUTURE_TOL_MS &&
          now - ts_ms <= TS_STALE_TOL_MS;

        if (inDarkWindow && pac_w >= pacCleanThreshold && tsValid) {
          // Date-key normalization: a capture at 02:00 belongs to the
          // production day that ENDED last evening, not the new calendar
          // day we're sitting in. Map (00:00–solarStart) back one day.
          const productionDayKey = localHour < solarStart
            ? localDateStr(ts_ms - 86400000)
            : date_key;

          // Monotonicity guard: existing snapshot present? Only overwrite
          // when the new value is greater-or-equal. A regression (new <
          // existing) signals an inverter rollover, replacement, or bus
          // glitch — don't poison the snapshot. Etotal is the authoritative
          // counter; parcE follows.
          let shouldUpdate = true;
          let regressionReason = "";
          try {
            const existing = stmts.selectBaselineOne.get(
              inverter, unit, productionDayKey,
            );
            const existingEtotal = Number(existing?.etotal_eod_clean || 0);
            const existingTsMs = Number(existing?.eod_clean_ts_ms || 0);
            if (existingEtotal > 0 && existingTsMs > 0) {
              if (etotal_kwh < existingEtotal) {
                shouldUpdate = false;
                regressionReason = `etotal regressed ${existingEtotal}→${etotal_kwh}`;
              } else if (ts_ms < existingTsMs) {
                // Out-of-order frame (poller backlog catching up). The
                // existing snapshot is more recent in wall-clock terms;
                // don't replace newer data with older.
                shouldUpdate = false;
                regressionReason = `frame ts older than existing snapshot ts`;
              }
            }
          } catch (_) { /* best-effort; fall through to write */ }

          if (shouldUpdate) {
            stmts.upsertEodClean.run({
              inverter,
              unit,
              date_key: productionDayKey,
              etotal_eod_clean: etotal_kwh,
              parce_eod_clean:  parce_kwh,
              eod_clean_ts_ms:  ts_ms,
              eod_clean_pac_w:  pac_w,
              now,
            });
          } else if (regressionReason) {
            console.warn(
              `[counter] eod_clean SKIPPED inv=${inverter} u=${unit} ` +
              `day=${productionDayKey} (${regressionReason})`,
            );
          }
        } else if (inDarkWindow && pac_w >= pacCleanThreshold && !tsValid) {
          // Frame met the time/PAC gate but timestamp failed sanity. Surface
          // it once-per-error so operators can chase the upstream cause.
          if (!_eodTsWarnedKeys.has(`${inverter}_${unit}`)) {
            _eodTsWarnedKeys.add(`${inverter}_${unit}`);
            console.warn(
              `[counter] eod_clean REJECTED for bad ts inv=${inverter} u=${unit} ` +
              `frame_ts=${ts_ms} now=${now} delta=${now - ts_ms}ms`,
            );
          }
        }

        // Verify-before-solar-window: once per day, at the first frame past
        // solar-window-start, audit yesterday's eod_clean coverage across
        // every baseline row. Missing snapshots are logged + recorded in
        // audit_log so an operator can correlate "unit X shows NaN today"
        // with "unit X did not capture last night".
        if (localHour >= solarStart && localHour < eodHour) {
          _eodVerifyOncePerDay(date_key, ts_ms);
        }
      } catch (err) {
        // Non-fatal: baseline seeding is best-effort.
        console.warn(
          `[counter] baseline seed failed inv=${inverter} u=${unit}: ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.warn("[counter] persistCounterState error:", err.message);
  }
}

function getCounterBaselinesForDate(dateKey) {
  try {
    return stmts.selectBaselinesForDate.all(String(dateKey || ""));
  } catch {
    return [];
  }
}

// v2.9.1 — In-memory cache of today's baseline rows per (inverter, unit).
// Refreshed on local-day rollover and on demand. Used by the poller hot path
// to compute kwh_today_etotal / kwh_today_parce + validity flags without
// querying SQLite on every frame.
const _baselineCache = {
  dateKey: "",
  byKey: new Map(),     // `${inv}_${unit}` -> {etotal_baseline, parce_baseline, source}
  loadedAtMs: 0,
};
const _BASELINE_CACHE_REFRESH_MS = 60_000;

function _loadBaselineCache(dateKey) {
  try {
    const rows = stmts.selectBaselinesForDate.all(String(dateKey || "")) || [];
    const byKey = new Map();
    for (const r of rows) {
      byKey.set(`${Number(r.inverter)}_${Number(r.unit)}`, {
        etotal_baseline: Number(r.etotal_baseline || 0),
        parce_baseline:  Number(r.parce_baseline  || 0),
        source:          String(r.source || ""),
      });
    }
    _baselineCache.dateKey = dateKey;
    _baselineCache.byKey = byKey;
    _baselineCache.loadedAtMs = Date.now();
  } catch {
    // Keep stale cache rather than blanking on transient DB error.
  }
}

function getTodayBaselineCached(inverter, unit, ts = Date.now()) {
  const dateKey = localDateStr(ts);
  if (
    dateKey !== _baselineCache.dateKey ||
    Date.now() - _baselineCache.loadedAtMs > _BASELINE_CACHE_REFRESH_MS
  ) {
    _loadBaselineCache(dateKey);
  }
  return _baselineCache.byKey.get(`${Number(inverter)}_${Number(unit)}`) || null;
}

// Force a baseline-cache refresh — called when persistCounterState writes a
// new baseline row, so the poller picks up the new "source" the very next tick
// instead of waiting up to 60 s for the cache TTL.
function invalidateBaselineCache() {
  _baselineCache.loadedAtMs = 0;
}

// v2.9.1 — Per-inverter daily hardware-counter totals for daily_report writes.
// Sums each unit's (current_etotal − etotal_baseline) across the inverter, but
// only when EVERY contributing unit has a clean baseline (`source =
// "eod_clean"`). If any unit lacks a clean anchor, the inverter total is
// returned as NULL so the daily_report column stays NULL → renders as NaN in
// the UI. Mirrors the per-unit validity rule in computeTodayHardwareEnergy.
function computeInverterDailyHwTotals(inverter, dateKey, ts = Date.now()) {
  const out = { kwh_total_etotal: null, kwh_total_parce: null };
  try {
    const inv = Number(inverter || 0);
    if (!inv) return out;
    const day = String(dateKey || localDateStr(ts));
    // Pull baselines for this inverter on the requested day.
    const baselines = stmts.selectBaselinesForDate
      .all(day)
      .filter((b) => Number(b.inverter || 0) === inv);
    if (!baselines.length) return out;
    // All baselines must be eod_clean to trust the inverter's HW total.
    if (baselines.some((b) => String(b.source || "") !== "eod_clean")) return out;
    // Pull current counter state per unit; bail on any missing.
    let etotalSum = 0;
    let parceSum = 0;
    for (const b of baselines) {
      const cur = stmts.selectCounterStateOne.get(inv, Number(b.unit || 0));
      if (!cur) return { kwh_total_etotal: null, kwh_total_parce: null };
      const dE = Number(cur.etotal_kwh || 0) - Number(b.etotal_baseline || 0);
      const dP = Number(cur.parce_kwh  || 0) - Number(b.parce_baseline  || 0);
      if (!Number.isFinite(dE) || dE < 0) return { kwh_total_etotal: null, kwh_total_parce: null };
      if (!Number.isFinite(dP) || dP < 0) return { kwh_total_etotal: null, kwh_total_parce: null };
      etotalSum += dE;
      parceSum  += dP;
    }
    out.kwh_total_etotal = Number(etotalSum.toFixed(6));
    out.kwh_total_parce  = Number(parceSum.toFixed(6));
    return out;
  } catch {
    return out;
  }
}

// v2.9.1 — Compute the per-unit today-energy fields for the live frame.
// `etotal_today_valid` / `parce_today_valid` are gated on the baseline having
// been derived from yesterday's clean post-1800H snapshot (source="eod_clean").
// When invalid, the frontend renders the field literally as "NaN".
function computeTodayHardwareEnergy(frame) {
  if (!frame) return null;
  const inv = Number(frame.inverter || 0);
  const unit = Number(frame.unit || 0);
  if (!inv || !unit) return null;
  const ts = Number(frame.ts || Date.now());
  const baseline = getTodayBaselineCached(inv, unit, ts);
  const sourceClean = !!baseline && baseline.source === "eod_clean";
  const cur_etotal = Math.max(0, Number(frame.etotal_kwh || 0));
  const cur_parce  = Math.max(0, Number(frame.parce_kwh  || 0));
  const etotal_delta = baseline ? cur_etotal - Number(baseline.etotal_baseline || 0) : NaN;
  const parce_delta  = baseline ? cur_parce  - Number(baseline.parce_baseline  || 0) : NaN;
  return {
    kwh_today_etotal: sourceClean && etotal_delta >= 0 ? etotal_delta : null,
    kwh_today_parce:  sourceClean && parce_delta  >= 0 ? parce_delta  : null,
    etotal_today_valid: sourceClean && Number.isFinite(etotal_delta) && etotal_delta >= 0 ? 1 : 0,
    parce_today_valid:  sourceClean && Number.isFinite(parce_delta)  && parce_delta  >= 0 ? 1 : 0,
    baseline_source: baseline?.source || null,
  };
}

// v2.9.1 — Yesterday's clean end-of-day snapshot per unit. Sourced from
// inverter_counter_baseline.eod_clean_* which is rolled post-1800H local time
// from PAC>0 frames — independent of when the dashboard last polled. This is
// the canonical anchor for today's baseline + crash-recovery seed gate.
//
// Returned shape (for Python seed_pac_from_baseline compatibility):
//   { inverter, unit, etotal_kwh, parce_kwh, ts_ms }
//
// Units with no clean EOD snapshot for yesterday are simply omitted; the
// recovery path treats them as "no_yesterday_snapshot" and refuses to seed.
function getYesterdaySnapshotForDate(todayDateKey) {
  try {
    const key = String(todayDateKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return [];
    const todayStartMs = new Date(`${key}T00:00:00.000`).getTime();
    if (!Number.isFinite(todayStartMs)) return [];
    const yesterdayKey = localDateStr(todayStartMs - 86400000);
    const rows = stmts.selectBaselineEodClean.all(yesterdayKey);
    return (rows || [])
      .filter((r) => Number(r?.etotal_eod_clean || 0) > 0)
      .map((r) => ({
        inverter:    Number(r.inverter || 0),
        unit:        Number(r.unit || 0),
        etotal_kwh:  Number(r.etotal_eod_clean || 0),
        parce_kwh:   Number(r.parce_eod_clean  || 0),
        ts_ms:       Number(r.eod_clean_ts_ms  || 0),
        pac_w:       Number(r.eod_clean_pac_w  || 0),
      }));
  } catch {
    return [];
  }
}

function getCounterStateAll() {
  try {
    return stmts.selectCounterStateAll.all();
  } catch {
    return [];
  }
}

function getCounterStateOne(inverter, unit) {
  try {
    return stmts.selectCounterStateOne.get(Number(inverter || 0), Number(unit || 0)) || null;
  } catch {
    return null;
  }
}

// Coerce a drift value to a finite number or null.
// Number(null) is 0 and Number.isFinite(0) is true, so the naive check
// silently turned "no readback" into "0 second drift" in the UI.
function _coerceDrift(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function insertClockSyncLogRow(row) {
  try {
    stmts.insertClockSyncLog.run({
      ts: Number(row?.ts || Date.now()),
      inverter: Number(row?.inverter || 0),
      unit: Number(row?.unit || 0),
      trigger: String(row?.trigger || "operator"),
      target_iso: row?.target_iso ? String(row.target_iso) : null,
      drift_before_s: _coerceDrift(row?.drift_before_s),
      drift_after_s: _coerceDrift(row?.drift_after_s),
      accepted: row?.accepted ? 1 : 0,
      error: row?.error ? String(row.error) : null,
    });
  } catch (err) {
    console.warn("[clock-sync] log insert failed:", err.message);
  }
}

function getClockSyncLog(limit = 50) {
  try {
    return stmts.selectClockSyncLog.all(Math.max(1, Math.min(500, Number(limit) || 50)));
  } catch {
    return [];
  }
}

const bulkInsertPollerBatch = db.transaction((readingRows, energyRows = []) => {
  for (const row of readingRows || []) {
    try {
      stmts.insertReading.run(row);
    } catch (err) {
      console.error("[DB] bulkInsertPollerBatch reading row failed:", err.message, row);
    }
  }
  for (const row of energyRows || []) {
    try {
      stmts.insertEnergy5.run(
        Number(row?.ts || 0),
        Number(row?.inverter || 0),
        Number(row?.kwh_inc || 0),
      );
    } catch (err) {
      console.error("[DB] bulkInsertPollerBatch energy row failed:", err.message, row);
    }
  }
  const states = new Map();
  for (const row of readingRows || []) {
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
  if (states.size) {
    const now = Date.now();
    const payloads = Array.from(states.values()).map((s) => summaryStateToPayload(s, now));
    for (const payload of payloads) {
      stmts.upsertDailyReadingsSummary.run(payload);
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

/**
 * Backfill only est_actual_mw/est_actual_kwh for existing snapshot rows.
 * Skips rows that already have est_actual data to preserve earlier writes.
 * Returns the number of rows actually updated.
 */
const bulkBackfillSolcastEstActual = db.transaction((day, slotEstActuals) => {
  const now = Date.now();
  let updated = 0;
  for (const r of slotEstActuals || []) {
    if (r.est_actual_mw == null && r.est_actual_kwh == null) continue;
    const info = stmts.backfillSolcastEstActual.run({
      forecast_day:   String(day || ""),
      slot:           Number(r.slot),
      est_actual_mw:  r.est_actual_mw  != null ? Number(r.est_actual_mw)  : null,
      est_actual_kwh: r.est_actual_kwh != null ? Number(r.est_actual_kwh) : null,
      updated_ts:     now,
    });
    updated += info.changes;
  }
  return updated;
});

function getSolcastSnapshotForDay(day) {
  return stmts.getSolcastSnapshotDay.all(String(day || ""));
}

/**
 * Day-ahead locked snapshot bulk insert (v2.8+).
 * Uses INSERT OR IGNORE — first-write-wins per (forecast_day, slot).
 * Returns the number of rows actually inserted (0 if already locked).
 */
const bulkInsertDayAheadLocked = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows || []) {
    const info = stmts.insertDayAheadLocked.run({
      forecast_day:    String(r.forecast_day || ""),
      slot:            Number(r.slot),
      ts_local:        Number(r.ts_local || 0),
      period_end_utc:  r.period_end_utc != null ? String(r.period_end_utc) : null,
      period:          r.period         != null ? String(r.period)         : null,
      p50_mw:          r.p50_mw  != null ? Number(r.p50_mw)  : null,
      p10_mw:          r.p10_mw  != null ? Number(r.p10_mw)  : null,
      p90_mw:          r.p90_mw  != null ? Number(r.p90_mw)  : null,
      p50_kwh:         r.p50_kwh != null ? Number(r.p50_kwh) : null,
      p10_kwh:         r.p10_kwh != null ? Number(r.p10_kwh) : null,
      p90_kwh:         r.p90_kwh != null ? Number(r.p90_kwh) : null,
      spread_mw:       r.spread_mw      != null ? Number(r.spread_mw)      : null,
      spread_pct_cap:  r.spread_pct_cap != null ? Number(r.spread_pct_cap) : null,
      captured_ts:     Number(r.captured_ts || Date.now()),
      captured_local:  String(r.captured_local || ""),
      capture_reason:  String(r.capture_reason || "manual"),
      solcast_source:  String(r.solcast_source || "toolkit"),
      plant_cap_mw:    r.plant_cap_mw != null ? Number(r.plant_cap_mw) : null,
    });
    inserted += info.changes;
  }
  return inserted;
});

function countDayAheadLockedForDay(day) {
  return Number(stmts.countDayAheadLocked.get(String(day || ""))?.n || 0);
}

function getDayAheadLockedForDay(day) {
  return stmts.getDayAheadLocked.all(String(day || ""));
}

function getDayAheadLockedMetaForDay(day) {
  return stmts.getDayAheadLockedMeta.get(String(day || ""));
}

/**
 * Append Solcast snapshot history rows (v2.8+).
 * Append-only; INSERT OR REPLACE used because PRIMARY KEY includes captured_ts
 * so real duplicates should be rare but safe against collisions within the same ms.
 */
const bulkInsertSnapshotHistory = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows || []) {
    stmts.insertSnapshotHistory.run({
      forecast_day:   String(r.forecast_day || ""),
      slot:           Number(r.slot),
      captured_ts:    Number(r.captured_ts || Date.now()),
      pulled_ts:      Number(r.pulled_ts   || 0),
      p50_mw:         r.p50_mw        != null ? Number(r.p50_mw)        : null,
      p10_mw:         r.p10_mw        != null ? Number(r.p10_mw)        : null,
      p90_mw:         r.p90_mw        != null ? Number(r.p90_mw)        : null,
      est_actual_mw:  r.est_actual_mw != null ? Number(r.est_actual_mw) : null,
      age_sec:        r.age_sec       != null ? Number(r.age_sec)       : null,
      solcast_source: r.solcast_source != null ? String(r.solcast_source) : null,
    });
    inserted += 1;
  }
  return inserted;
});

/**
 * Delete snapshot history rows older than `retainDays`. Returns rows deleted.
 */
function pruneSnapshotHistory(retainDays = 90) {
  const days = Math.max(1, Math.min(3650, Math.trunc(Number(retainDays || 90))));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const info = stmts.pruneSnapshotHistoryBefore.run(cutoff);
  return Number(info?.changes || 0);
}

function getSnapshotHistoryDayTrajectory(day) {
  return stmts.getSnapshotHistoryDayTrajectory.all(String(day || ""));
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
  archiveDb.pragma("busy_timeout = 1000");   // Low timeout: archive DBs written only during migration; fail fast
  archiveDb.pragma("temp_store = memory");
  archiveDb.pragma("cache_size = -8000");    // 8 MB per archive DB (was 64 MB default)
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
  const existed = fs.existsSync(filePath);
  const archiveDb = new Database(filePath);
  if (!existed) {
    // New file — run full schema setup
    ensureArchiveSchema(archiveDb);
  } else {
    // Existing file — only set pragmas, trust schema is already created
    archiveDb.pragma("journal_mode = WAL");
    archiveDb.pragma("synchronous = NORMAL");
    archiveDb.pragma("busy_timeout = 1000");   // Low timeout: archive DBs written only during migration; fail fast
    archiveDb.pragma("temp_store = memory");
    archiveDb.pragma("cache_size = -8000");    // 8 MB per archive DB (was 64 MB default)
  }
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
    entry.db.pragma("wal_checkpoint(PASSIVE)"); // PASSIVE: non-blocking — checkpoints what it can without waiting for readers
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

function prepareArchiveDbForTransfer(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return { closed: false, checkpointed: false, walBytes: 0 };
  const entry = ARCHIVE_DB_CACHE.get(key);
  if (!entry) return { closed: false, checkpointed: false, walBytes: 0 };
  const filePath = path.join(ARCHIVE_DIR, `${key}.db`);
  const walPath = `${filePath}-wal`;
  let walBytes = 0;
  try {
    walBytes = Math.max(0, Number(fs.statSync(walPath).size || 0));
  } catch (_) {
    walBytes = 0;
  }
  if (!(walBytes > 0)) {
    return { closed: false, checkpointed: false, walBytes: 0 };
  }
  try {
    entry.db.pragma("wal_checkpoint(PASSIVE)");
  } catch (_) {
    // Ignore passive checkpoint failures; we may still need a targeted close.
  }
  try {
    walBytes = Math.max(0, Number(fs.statSync(walPath).size || 0));
  } catch (_) {
    walBytes = 0;
  }
  if (!(walBytes > 0)) {
    return { closed: false, checkpointed: true, walBytes: 0 };
  }
  return {
    closed: closeArchiveDbForMonth(key),
    checkpointed: true,
    walBytes,
  };
}

async function createSqliteTransferSnapshot(
  sourcePath,
  { targetDir = "", prefix = "", mtimeMs = 0 } = {},
) {
  const resolvedSource = path.resolve(String(sourcePath || "").trim());
  if (!resolvedSource || !fs.existsSync(resolvedSource)) {
    throw new Error("SQLite snapshot source file is missing.");
  }
  const snapshotDir = String(targetDir || path.dirname(resolvedSource)).trim() ||
    path.dirname(resolvedSource);
  await fs.promises.mkdir(snapshotDir, { recursive: true });
  const sourceBase = path.basename(resolvedSource, path.extname(resolvedSource)) || "sqlite";
  const safePrefix = String(prefix || `${sourceBase}.snapshot`)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || `${sourceBase}.snapshot`;
  const tempPath = path.join(
    snapshotDir,
    `${safePrefix}-${Date.now()}-${process.pid}.tmp`,
  );
  let sourceDb = null;
  try {
    sourceDb = new Database(resolvedSource, { fileMustExist: true });
    try { sourceDb.pragma("busy_timeout = 1000"); } catch (_) {}  // Low timeout: source DB for archive transfer; fail fast
    await sourceDb.backup(tempPath);
    const stat = await fs.promises.stat(tempPath);
    const targetMtimeMs = Math.max(0, Number(mtimeMs || stat?.mtimeMs || Date.now()));
    if (targetMtimeMs > 0) {
      const mtime = new Date(targetMtimeMs);
      await fs.promises.utimes(tempPath, mtime, mtime);
    }
    return {
      tempPath,
      size: Math.max(0, Number(stat?.size || 0)),
      mtimeMs: targetMtimeMs,
    };
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore temp cleanup failures after snapshot build errors.
    }
    throw err;
  } finally {
    if (sourceDb) {
      try { sourceDb.close(); } catch (_) {}
    }
  }
}

async function disposeSqliteTransferSnapshot(snapshotOrPath) {
  const tempPath =
    typeof snapshotOrPath === "string"
      ? String(snapshotOrPath || "").trim()
      : String(snapshotOrPath?.tempPath || "").trim();
  if (!tempPath) return false;
  try {
    await fs.promises.unlink(tempPath);
    return true;
  } catch (err) {
    if (String(err?.code || "").trim().toUpperCase() === "ENOENT") return false;
    throw err;
  }
}

function upsertDailyReportRowsToSnapshot(snapshotPath, rowsRaw = []) {
  const targetPath = String(snapshotPath || "").trim();
  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new Error("Snapshot file is missing.");
  }
  const rows = Array.isArray(rowsRaw)
    ? rowsRaw
      .map((row) => ({
        date: String(row?.date || "").trim(),
        inverter: Math.max(0, Number(row?.inverter || 0)),
        kwh_total: Number(row?.kwh_total || 0),
        pac_peak: Number(row?.pac_peak || 0),
        pac_avg: Number(row?.pac_avg || 0),
        uptime_s: Math.max(0, Math.round(Number(row?.uptime_s || 0))),
        alarm_count: Math.max(0, Math.trunc(Number(row?.alarm_count || 0))),
        control_count: Math.max(0, Math.trunc(Number(row?.control_count || 0))),
        availability_pct: Number(row?.availability_pct || 0),
        performance_pct: Number(row?.performance_pct || 0),
        node_uptime_s: Math.max(0, Math.round(Number(row?.node_uptime_s || 0))),
        expected_node_uptime_s: Math.max(0, Math.round(Number(row?.expected_node_uptime_s || 0))),
        expected_nodes: Math.max(0, Math.trunc(Number(row?.expected_nodes || 0))),
        rated_kw: Number(row?.rated_kw || 0),
      }))
      .filter((row) => row.date && row.inverter > 0)
    : [];
  if (!rows.length) return 0;

  const snapshotDb = new Database(targetPath, { fileMustExist: true });
  try {
    try { snapshotDb.pragma("journal_mode = DELETE"); } catch (_) {}
    try { snapshotDb.pragma("synchronous = NORMAL"); } catch (_) {}
    const upsert = snapshotDb.prepare(`
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
    `);
    const tx = snapshotDb.transaction((entries) => {
      for (const row of entries) {
        upsert.run(
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
    });
    tx(rows);
    return rows.length;
  } finally {
    try { snapshotDb.close(); } catch (_) {}
  }
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
  /* Availability rule: only manual-stop alarm (0x1000 = 4096) counts as
     unavailable.  Other fault/warning alarms are disregarded — the node is
     still considered "available" if it is communicating (online=1).
     A non-manual-stop alarm with pac=0 still counts as available. */
  const alarmVal = Number(row?.alarm || 0);
  const isManualStop = (alarmVal & 0x1000) !== 0;
  const hasFaultAlarm = alarmVal > 0 && !isManualStop;
  const isOnline = Number(row?.online || 0) === 1 && (pac > 0 || hasFaultAlarm);

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
  // Warn on ranges > 2 days (operator hint — not enforced).
  const MAX_RANGE_MS = 2 * 24 * 60 * 60 * 1000;
  if (e - s > MAX_RANGE_MS) {
    console.warn(`[DB] queryReadingsRangeAll: range ${Math.round((e-s)/86400000)}d exceeds 2d cap — please use per-inverter path or batch with yields`);
  }
  // Note: v2.8.2 added a 500k row throw here ("E4") which caused exports to
  // fail on high-poll-rate deployments. Reverted to v2.7.x behaviour — the
  // route-level 366-day cap (MAX_EXPORT_RANGE_DAYS in server/index.js) is
  // the load bound. If a pathological range somehow slips through, the
  // caller will OOM loudly, which is preferable to silently blocking a
  // valid operator-requested export.
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
  // Note: v2.8.2's 500k "E4" guard removed — see queryReadingsRangeAll for
  // rationale. Route-level 366-day cap bounds the worst case.
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

function _yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function archiveTelemetryBeforeCutoff(cutoffTs) {
  const cutoff = Number(cutoffTs || 0);
  const stats = { readings: 0, energy5: 0 };
  if (!(cutoff > 0)) return stats;

  while (true) {
    const rows = selectOldReadingsBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "readings");
    deleteReadingsBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    stats.readings += rows.length;
    await _yieldEventLoop(); // let polling, WS, and HTTP continue between batches
  }

  while (true) {
    const rows = selectOldEnergyBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "energy");
    deleteEnergyBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    stats.energy5 += rows.length;
    await _yieldEventLoop();
  }

  return stats;
}

async function pruneOldData(options = {}) {
  const opts =
    options && typeof options === "object" ? options : {};
  try {
    const retainDays = Math.max(1, Number(getSetting("retainDays", 90)));
    const auditRetainDays = Math.max(1, Number(getSetting("auditRetainDays", 365)));
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditRetainDays * 24 * 60 * 60 * 1000;
    const mainDbBytesBefore = safeFileSize(DB_PATH);
    const archiveBefore = getArchiveDirStats();
    const archived = await archiveTelemetryBeforeCutoff(cutoff);
    await _yieldEventLoop();
    db.prepare("DELETE FROM alarms WHERE ts < ? AND cleared_ts IS NOT NULL").run(cutoff);
    await _yieldEventLoop();
    db.prepare("DELETE FROM audit_log WHERE ts < ?").run(auditCutoff);
    await _yieldEventLoop();
    // v2.9.0 Slice B/D: retention for new counter + clock-sync tables.
    try {
      const baselineRetainDays = Math.max(30, Number(getSetting("counterBaselineRetainDays", 90)));
      const baselineCutoffDate = (() => {
        const d = new Date(Date.now() - baselineRetainDays * 24 * 60 * 60 * 1000);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      })();
      db.prepare(
        "DELETE FROM inverter_counter_baseline WHERE date_key < ?",
      ).run(baselineCutoffDate);
      const clockSyncRetainDays = Math.max(30, Number(getSetting("clockSyncLogRetainDays", 365)));
      const clockSyncCutoff = Date.now() - clockSyncRetainDays * 24 * 60 * 60 * 1000;
      db.prepare("DELETE FROM inverter_clock_sync_log WHERE ts < ?").run(clockSyncCutoff);
    } catch (err) {
      console.warn("[DB] counter/clock-sync retention skipped:", err.message);
    }
    await _yieldEventLoop();
    checkpointArchiveDbs("PASSIVE");
    const checkpointed = checkpointMainDb("PASSIVE");
    const vacuumRequested =
      !!opts.vacuum && (archived.readings > 0 || archived.energy5 > 0 || !!opts.forceVacuum);
    let vacuumed = false;
    if (vacuumRequested) {
      await _yieldEventLoop();
      // Defer VACUUM to background via setImmediate — never block event loop
      setImmediate(() => {
        try {
          vacuumMainDb();
          checkpointMainDb("PASSIVE");
        } catch (e) {
          console.warn("[DB] deferred VACUUM failed:", e.message);
        }
      });
      vacuumed = true; // Mark as requested; actual completion is async
      console.log("[DB] VACUUM deferred — will run in background after prune");
    }
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

// ---------- Scheduled Maintenance CRUD ----------

function getScheduledMaintenance({ inverter, startTs, endTs } = {}) {
  let sql =
    "SELECT * FROM scheduled_maintenance WHERE 1=1";
  const params = [];
  if (inverter !== undefined && inverter !== null) {
    sql += " AND inverter = ?";
    params.push(Number(inverter));
  }
  // Return entries that overlap the requested time window
  if (startTs !== undefined && startTs !== null) {
    sql += " AND end_ts >= ?";
    params.push(Number(startTs));
  }
  if (endTs !== undefined && endTs !== null) {
    sql += " AND start_ts <= ?";
    params.push(Number(endTs));
  }
  sql += " ORDER BY start_ts ASC";
  return db.prepare(sql).all(...params);
}

function insertScheduledMaintenance({ inverter, start_ts, end_ts, reason }) {
  const inv = Number(inverter || 0);
  const s = Number(start_ts);
  const e = Number(end_ts);
  if (!(e > s)) throw new Error("end_ts must be after start_ts");
  const result = db
    .prepare(
      `INSERT INTO scheduled_maintenance (inverter, start_ts, end_ts, reason)
       VALUES (?, ?, ?, ?)`,
    )
    .run(inv, s, e, String(reason || "").trim());
  return result.lastInsertRowid;
}

function deleteScheduledMaintenance(id) {
  const result = db
    .prepare("DELETE FROM scheduled_maintenance WHERE id = ?")
    .run(Number(id));
  return result.changes;
}

module.exports = {
  db,
  stmts,
  bulkInsert,
  bulkInsertWithSummary,
  bulkInsertPollerBatch,
  bulkUpsertForecastDayAhead,
  bulkUpsertForecastIntradayAdjusted,
  bulkUpsertSolcastSnapshot,
  bulkBackfillSolcastEstActual,
  getSolcastSnapshotForDay,
  // Day-ahead locked snapshot (v2.8+)
  bulkInsertDayAheadLocked,
  countDayAheadLockedForDay,
  getDayAheadLockedForDay,
  getDayAheadLockedMetaForDay,
  // Solcast snapshot history (v2.8+)
  bulkInsertSnapshotHistory,
  pruneSnapshotHistory,
  getSnapshotHistoryDayTrajectory,
  getSetting,
  setSetting,
  pruneOldData,
  closeDb,
  // v2.8.10 Phase C: startup integrity snapshot + auto-restore result.
  // Consumed by server/index.js GET /api/health/db-integrity.
  startupIntegrityResult,
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
  prepareArchiveDbForTransfer,
  createSqliteTransferSnapshot,
  disposeSqliteTransferSnapshot,
  upsertDailyReportRowsToSnapshot,
  stagePendingMainDbReplacement,
  discardPendingMainDbReplacement,
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
  getScheduledMaintenance,
  insertScheduledMaintenance,
  deleteScheduledMaintenance,
  upsertAvailability5min: (ts, onlineCount, expectedCount) =>
    stmts.upsertAvailability5min.run(ts, onlineCount, expectedCount),
  getAvailability5minRange: (startTs, endTs) =>
    stmts.getAvailability5minRange.all(startTs, endTs),
  // v2.9.0 Slice B/D — counter + clock-sync helpers
  persistCounterState,
  getCounterHistory,
  evaluateCounterAdvancing,
  getCounterBaselinesForDate,
  getYesterdaySnapshotForDate,
  getCounterStateAll,
  getCounterStateOne,
  getTodayBaselineCached,
  invalidateBaselineCache,
  computeTodayHardwareEnergy,
  computeInverterDailyHwTotals,
  insertClockSyncLogRow,
  getClockSyncLog,
  // v2.9.2 — generic audit writer used by poller spike clamps
  insertAuditLogRow,
};
