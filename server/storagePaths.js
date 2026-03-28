"use strict";
/**
 * storagePaths.js — Unified storage path helpers for the consolidated layout.
 *
 * v2.4.43+ stores ALL app data under %PROGRAMDATA%\InverterDashboard\
 * instead of scattered across APPDATA and multiple PROGRAMDATA namespaces.
 *
 * Migration is run during the Electron loading screen by
 * electron/storageConsolidationMigration.js.  Once complete it writes a
 * .adsi-migration-v2.4.43.json sentinel file under the new root so that all
 * path helpers in this module can detect the new layout at runtime.
 *
 * Portable mode is entirely unaffected — it already uses a clean single-root
 * layout (InverterDashboardData/).
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const MIGRATION_VERSION = "2.4.43";

function getProgramDataRoot() {
  return process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
}

/** Root of the unified storage tree: %PROGRAMDATA%\InverterDashboard */
function getNewRoot() {
  return path.join(getProgramDataRoot(), "InverterDashboard");
}

/** Returns true when the storage migration for v2.4.43 has completed. */
function isMigrationComplete() {
  try {
    const stateFile = path.join(getNewRoot(), ".adsi-migration-v2.4.43.json");
    if (!fs.existsSync(stateFile)) return false;
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return (st.status === "complete" || st.status === "completed-with-errors") && st.version === MIGRATION_VERSION;
  } catch {
    return false;
  }
}

/**
 * Returns the resolved DB directory if the app is on the new layout, or null
 * to signal that the caller should fall back to the legacy APPDATA path.
 */
function resolvedDbDir() {
  const newDir = path.join(getNewRoot(), "db");
  if (isMigrationComplete() || fs.existsSync(path.join(newDir, "adsi.db"))) {
    return newDir;
  }
  return null;
}

/**
 * Returns the cloud_backups directory, preferring the new consolidated root
 * and falling back to the legacy path inside legacyDataDir.
 */
function resolvedBackupDir(legacyDataDir) {
  const newDir = path.join(getNewRoot(), "cloud_backups");
  if (isMigrationComplete() || fs.existsSync(newDir)) return newDir;
  return path.join(legacyDataDir, "cloud_backups");
}

/**
 * Returns the backup_history.json path, preferring the new consolidated root.
 */
function resolvedBackupHistoryFile(legacyDataDir) {
  const newFile = path.join(getNewRoot(), "backup_history.json");
  if (isMigrationComplete() || fs.existsSync(newFile)) return newFile;
  return path.join(legacyDataDir, "backup_history.json");
}

/**
 * Returns the cloud_tokens.enc path, preferring the new consolidated root.
 */
function resolvedTokenFile(legacyDataDir) {
  const newFile = path.join(getNewRoot(), "auth", "cloud_tokens.enc");
  if (isMigrationComplete() || fs.existsSync(newFile)) return newFile;
  return path.join(legacyDataDir, "cloud_tokens.enc");
}

/**
 * Returns the license directory under the new unified root.
 * (Falls back to the old ADSI-InverterDashboard namespace if the new
 * location doesn't exist yet — e.g. very first boot before migration.)
 */
function resolvedLicenseDir() {
  const newDir = path.join(getNewRoot(), "license");
  if (isMigrationComplete() || fs.existsSync(newDir)) return newDir;
  // Pre-migration fallback
  const oldDir = path.join(getProgramDataRoot(), "ADSI-InverterDashboard", "license");
  return fs.existsSync(oldDir) ? oldDir : newDir;
}

module.exports = {
  MIGRATION_VERSION,
  getProgramDataRoot,
  getNewRoot,
  isMigrationComplete,
  resolvedDbDir,
  resolvedBackupDir,
  resolvedBackupHistoryFile,
  resolvedTokenFile,
  resolvedLicenseDir,
};
