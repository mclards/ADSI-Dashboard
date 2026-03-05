"use strict";
/**
 * cloudBackup.js — Local-first cloud backup/restore service.
 *
 * Architecture: Local-first + cloud sync.
 * - All backups are created locally first (guaranteed consistency via SQLite online backup API).
 * - Cloud upload is a best-effort secondary step (retried on failure).
 * - Restore always reads from local backup packages; cloud pull fetches to local first.
 *
 * Backup package format (directory):
 *   cloud_backups/<id>/
 *     manifest.json       checksums, metadata, scope, version
 *     adsi.db             SQLite snapshot (scope: database)
 *     ipconfig.json       inverter IP config (scope: config)
 *     settings.json       app settings export (scope: config)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cron = require("node-cron");
const fetch = require("node-fetch");

const APP_VERSION = "2.2.1";
const DB_SCHEMA_VERSION = "2";

// Limit how many local backup packages to keep.
const MAX_LOCAL_PACKAGES = 20;

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listFilesRecursive(rootDir) {
  const out = [];
  const walk = (absDir, relBase) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile()) {
        out.push(rel.replace(/\\/g, "/"));
      }
    }
  };
  walk(rootDir, "");
  return out;
}

function semverCompare(a, b) {
  const parse = (v) =>
    String(v || "")
      .split(".")
      .map((x) => Number.parseInt(String(x).replace(/[^0-9].*$/, ""), 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
      .slice(0, 3);
  const va = parse(a);
  const vb = parse(b);
  while (va.length < 3) va.push(0);
  while (vb.length < 3) vb.push(0);
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return 1;
    if (va[i] < vb[i]) return -1;
  }
  return 0;
}

class CloudBackupService {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir          DATA_DIR from db.js
   * @param {object} deps.db               better-sqlite3 db instance
   * @param {object} deps.getSetting       getSetting fn from db.js
   * @param {object} deps.setSetting       setSetting fn from db.js
   * @param {object} deps.tokenStore       TokenStore instance
   * @param {object} deps.onedrive         OneDriveProvider instance
   * @param {object} deps.gdrive           GDriveProvider instance
   * @param {object} deps.poller           poller module (optional, for stop/start around restore)
   * @param {string} deps.ipConfigPath     Path to ipconfig.json (for config scope backup)
   */
  constructor(deps) {
    this.dataDir = deps.dataDir;
    this.db = deps.db;
    this.getSetting = deps.getSetting;
    this.setSetting = deps.setSetting;
    this.tokenStore = deps.tokenStore;
    this.onedrive = deps.onedrive;
    this.gdrive = deps.gdrive;
    this.poller = deps.poller || null;
    this.ipConfigPath = deps.ipConfigPath || null;

    this.backupDir = path.join(this.dataDir, "cloud_backups");
    this.historyFile = path.join(this.dataDir, "backup_history.json");

    fs.mkdirSync(this.backupDir, { recursive: true });

    this.history = this._loadHistory();
    this._cronJob = null;
    this._retryQueue = [];
    this._retryTimer = null;

    this.progress = {
      status: "idle", // idle | creating | uploading | restoring | pulling | error | done
      pct: 0,
      message: "",
      provider: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: null,
      error: null,
    };
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  getCloudSettings() {
    const raw = this.getSetting("cloudBackupSettings", null);
    const defaults = {
      enabled: false,
      email: "",
      provider: "auto",            // auto | onedrive | gdrive | both
      scope: ["database", "config"], // database | config | logs
      schedule: "manual",          // manual | daily | every6h
      onedrive: { clientId: "" },
      gdrive: { clientId: "", clientSecret: "" },
    };
    if (!raw) return defaults;
    try {
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return defaults;
    }
  }

  saveCloudSettings(s) {
    const current = this.getCloudSettings();
    const body = s && typeof s === "object" ? s : {};
    const merged = {
      ...current,
      ...body,
      onedrive: {
        ...(current.onedrive || {}),
        ...((body.onedrive && typeof body.onedrive === "object") ? body.onedrive : {}),
      },
      gdrive: {
        ...(current.gdrive || {}),
        ...((body.gdrive && typeof body.gdrive === "object") ? body.gdrive : {}),
      },
    };
    // Validate provider
    if (!["auto", "onedrive", "gdrive", "both"].includes(merged.provider)) {
      merged.provider = "auto";
    }
    if (!["manual", "daily", "every6h"].includes(merged.schedule)) {
      merged.schedule = "manual";
    }
    this.setSetting("cloudBackupSettings", JSON.stringify(merged));
    this._applySchedule(merged.schedule, merged.enabled);
    return merged;
  }

  // ─── Progress ─────────────────────────────────────────────────────────────

  _setProgress(update) {
    Object.assign(this.progress, update, { updatedAt: Date.now() });
  }

  getProgress() {
    return { ...this.progress };
  }

  // ─── History ──────────────────────────────────────────────────────────────

  _loadHistory() {
    try {
      if (!fs.existsSync(this.historyFile)) return [];
      return JSON.parse(fs.readFileSync(this.historyFile, "utf8")) || [];
    } catch {
      return [];
    }
  }

  _saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    } catch (err) {
      console.error("[CloudBackup] Failed to save history:", err.message);
    }
  }

  _addHistoryEntry(entry) {
    this.history.unshift(entry);
    // Keep max 200 history entries.
    if (this.history.length > 200) this.history.length = 200;
    this._saveHistory();
  }

  getHistory() {
    return [...this.history];
  }

  // ─── Local Backup Creation ─────────────────────────────────────────────────

  /**
   * Create a local backup package.
   * @param {object} opts
   * @param {string[]} opts.scope   e.g. ["database","config"]
   * @param {string}   [opts.tag]  Optional label (e.g. "manual-2026-03-04")
   * @returns {Promise<{id, dir, manifest}>}
   */
  async createLocalBackup(opts = {}) {
    const scope = Array.isArray(opts.scope)
      ? opts.scope
      : ["database", "config"];
    const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `inverter-backup-${nowIso}`;
    const dir = path.join(this.backupDir, id);
    fs.mkdirSync(dir, { recursive: true });

    this._setProgress({
      status: "creating",
      pct: 5,
      message: "Creating local backup package…",
      startedAt: Date.now(),
      error: null,
    });

    const checksums = {};
    const files = [];

    // ── Database scope ──
    if (scope.includes("database")) {
      const dbDest = path.join(dir, "adsi.db");
      this._setProgress({ pct: 15, message: "Backing up database…" });
      await this.db.backup(dbDest);
      checksums["adsi.db"] = sha256File(dbDest);
      files.push({ name: "adsi.db", size: fs.statSync(dbDest).size });
    }

    // ── Config scope ──
    if (scope.includes("config")) {
      this._setProgress({ pct: 40, message: "Backing up config files…" });

      // IP config
      if (this.ipConfigPath && fs.existsSync(this.ipConfigPath)) {
        const dest = path.join(dir, "ipconfig.json");
        fs.copyFileSync(this.ipConfigPath, dest);
        checksums["ipconfig.json"] = sha256File(dest);
        files.push({ name: "ipconfig.json", size: fs.statSync(dest).size });
      }

      // Export current settings from DB as JSON
      try {
        const settingsExport = this._exportSettingsJson();
        const dest = path.join(dir, "settings.json");
        fs.writeFileSync(dest, JSON.stringify(settingsExport, null, 2));
        checksums["settings.json"] = sha256File(dest);
        files.push({ name: "settings.json", size: fs.statSync(dest).size });
      } catch (err) {
        console.warn("[CloudBackup] Settings export failed:", err.message);
      }
    }

    // ── Logs scope ──
    if (scope.includes("logs")) {
      this._setProgress({ pct: 55, message: "Backing up logs…" });
      const logsDir = path.join(this.dataDir, "logs");
      if (fs.existsSync(logsDir)) {
        const logDest = path.join(dir, "logs");
        fs.mkdirSync(logDest, { recursive: true });
        for (const f of fs.readdirSync(logsDir).slice(-50)) { // last 50 log files max
          const src = path.join(logsDir, f);
          const dst = path.join(logDest, f);
          try {
            fs.copyFileSync(src, dst);
            checksums[`logs/${f}`] = sha256File(dst);
            files.push({ name: `logs/${f}`, size: fs.statSync(dst).size });
          } catch {
            // skip unreadable log files
          }
        }
      }
    }

    const totalSize = files.reduce((s, f) => s + f.size, 0);

    const manifest = {
      id,
      appVersion: APP_VERSION,
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      scope,
      tag: opts.tag || "manual",
      checksums,
      files,
      totalSize,
      cloud: {},
    };

    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    checksums["manifest.json"] = sha256File(manifestPath);
    manifest.checksums = checksums;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    this._setProgress({ pct: 70, message: "Local backup package created." });

    this._addHistoryEntry({
      id,
      createdAt: manifest.createdAt,
      scope,
      tag: manifest.tag,
      totalSize,
      status: "local",
      cloud: {},
      dir,
    });

    this._pruneOldLocalPackages();
    console.log(`[CloudBackup] Created local package: ${id}`);
    return { id, dir, manifest };
  }

  _exportSettingsJson() {
    // Read settings from DB for backup — excludes sensitive tokens
    const sensitiveKeys = [
      "remoteApiToken", "solcastApiKey", "cloudBackupSettings",
    ];
    const stmts = this.db
      .prepare("SELECT key, value FROM settings")
      .all();
    const obj = {};
    for (const row of stmts) {
      if (!sensitiveKeys.includes(row.key)) {
        obj[row.key] = row.value;
      }
    }
    return obj;
  }

  _pruneOldLocalPackages() {
    try {
      const dirs = fs
        .readdirSync(this.backupDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith("inverter-backup-"))
        .sort((a, b) => a.name.localeCompare(b.name));
      while (dirs.length > MAX_LOCAL_PACKAGES) {
        const oldest = dirs.shift();
        const p = path.join(this.backupDir, oldest.name);
        fs.rmSync(p, { recursive: true, force: true });
        console.log("[CloudBackup] Pruned old package:", oldest.name);
      }
    } catch (err) {
      console.warn("[CloudBackup] Prune failed:", err.message);
    }
  }

  // ─── Cloud Upload ──────────────────────────────────────────────────────────

  /**
   * Upload a local backup package to cloud provider(s).
   * @param {string} backupId  ID of local backup package
   * @param {string[]} providers  ["onedrive","gdrive"] or subset
   */
  async uploadToCloud(backupId, providers = []) {
    const entry = this.history.find((h) => h.id === backupId);
    const dir = entry?.dir || path.join(this.backupDir, backupId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Backup package not found: ${backupId}`);
    }
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = safeReadJson(manifestPath);
    if (!manifest) throw new Error("Backup manifest missing or corrupted");
    if (!this._verifyChecksums(dir, manifest)) {
      throw new Error("Backup package failed checksum verification before upload");
    }

    const errors = [];
    let uploadedCount = 0;

    for (const provider of providers) {
      const adapter = provider === "onedrive" ? this.onedrive : this.gdrive;
      if (!adapter?.isConnected()) {
        errors.push(`${provider}: not connected`);
        continue;
      }
      this._setProgress({
        status: "uploading",
        pct: 75,
        message: `Uploading to ${provider}…`,
        provider,
      });
      try {
        const cloudFiles = {};
        const allFiles = listFilesRecursive(dir);
        if (!allFiles.length) {
          throw new Error("No files found in backup package");
        }

        for (let i = 0; i < allFiles.length; i++) {
          const fname = allFiles[i];
          const localPath = path.join(dir, ...fname.split("/"));
          const remoteName = `${backupId}/${fname}`;
          const result = await adapter.uploadFile(
            localPath,
            remoteName,
            (pct) => {
              const overall = 75 + Math.round(((i + pct / 100) / allFiles.length) * 20);
              this._setProgress({ pct: Math.min(overall, 95) });
            },
          );
          cloudFiles[fname] = result;
        }

        // Update manifest cloud metadata in the local package.
        manifest.cloud[provider] = {
          uploadedAt: new Date().toISOString(),
          files: cloudFiles,
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        // Update history entry.
        if (entry) {
          entry.cloud = entry.cloud || {};
          entry.cloud[provider] = { uploadedAt: new Date().toISOString() };
          entry.status = "cloud";
          this._saveHistory();
        }

        uploadedCount++;
        console.log(`[CloudBackup] Uploaded ${backupId} → ${provider}`);
      } catch (err) {
        console.error(`[CloudBackup] Upload to ${provider} failed:`, err.message);
        errors.push(`${provider}: ${err.message}`);
        // Add to retry queue.
        this._retryQueue.push({ backupId, provider, attempts: 0 });
        this._scheduleRetry();
      }
    }

    if (uploadedCount === 0 && errors.length > 0) {
      throw new Error(`All uploads failed: ${errors.join("; ")}`);
    }
    return { uploaded: uploadedCount, errors };
  }

  // ─── Full Backup Workflow ──────────────────────────────────────────────────

  /**
   * Run the full backup workflow: create local → upload to cloud.
   * @param {object} opts
   * @param {string[]} opts.scope
   * @param {string}   opts.provider  "auto"|"onedrive"|"gdrive"|"both"
   * @param {string}   [opts.tag]
   */
  async backupNow(opts = {}) {
    if (this.progress.status !== "idle" && this.progress.status !== "done" && this.progress.status !== "error") {
      throw new Error("A backup/restore operation is already in progress");
    }

    this._setProgress({
      status: "creating",
      pct: 0,
      message: "Starting backup…",
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    try {
      const settings = this.getCloudSettings();
      const scope = opts.scope || settings.scope || ["database", "config"];
      const providerPref = opts.provider || settings.provider || "auto";
      const tag = opts.tag || `manual-${new Date().toISOString().slice(0, 10)}`;

      // Create local backup.
      const { id, manifest } = await this.createLocalBackup({ scope, tag });

      // Resolve upload providers.
      const uploadProviders = this._resolveProviders(providerPref);
      if (uploadProviders.length > 0) {
        const result = await this.uploadToCloud(id, uploadProviders);
        this._setProgress({
          status: "done",
          pct: 100,
          message: `Backup complete. Uploaded to: ${uploadProviders.join(", ")}`,
          finishedAt: Date.now(),
        });
        return { id, manifest, uploaded: result.uploaded, errors: result.errors };
      } else {
        this._setProgress({
          status: "done",
          pct: 100,
          message: "Local backup created. No cloud providers connected.",
          finishedAt: Date.now(),
        });
        return { id, manifest, uploaded: 0, errors: [] };
      }
    } catch (err) {
      this._setProgress({
        status: "error",
        pct: 0,
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      });
      throw err;
    }
  }

  // ─── Cloud Pull ────────────────────────────────────────────────────────────

  /**
   * List backup packages available on a cloud provider.
   * @param {string} provider  "onedrive" | "gdrive"
   */
  async listCloudBackups(provider) {
    const adapter = provider === "onedrive" ? this.onedrive : this.gdrive;
    if (!adapter?.isConnected()) {
      throw new Error(`${provider}: not connected`);
    }
    return adapter.listBackups();
  }

  /**
   * Pull (download) a specific backup from cloud to local.
   * @param {string} provider
   * @param {string} remoteId  remote folder/file ID
   * @param {string} remoteName  folder name (e.g. "inverter-backup-...")
   */
  async pullFromCloud(provider, remoteId, remoteName) {
    const adapter = provider === "onedrive" ? this.onedrive : this.gdrive;
    if (!adapter?.isConnected()) {
      throw new Error(`${provider}: not connected`);
    }

    this._setProgress({
      status: "pulling",
      pct: 10,
      message: `Pulling backup from ${provider}…`,
      provider,
      startedAt: Date.now(),
      error: null,
    });

    const dir = path.join(this.backupDir, remoteName);
    fs.mkdirSync(dir, { recursive: true });

    try {
      // Recursively list all files in the backup folder for both providers.
      let fileItems = [];
      if (provider === "onedrive") {
        const accessToken = await adapter.getAccessToken();
        const walkOneDrive = async (folderId, relBase = "") => {
          const r = await fetch(
            `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            },
          );
          if (!r.ok) throw new Error(`OneDrive folder list failed: ${r.status}`);
          const { value } = await r.json();
          const entries = Array.isArray(value) ? value : [];
          for (const entry of entries) {
            const name = String(entry?.name || "").trim();
            if (!name) continue;
            if (entry.folder) {
              await walkOneDrive(entry.id, `${relBase}${name}/`);
            } else {
              fileItems.push({ id: entry.id, name: `${relBase}${name}` });
            }
          }
        };
        await walkOneDrive(remoteId, "");
      } else {
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files/${remoteId}?fields=id,name,mimeType`,
          {
            headers: {
              Authorization: `Bearer ${await adapter.getAccessToken()}`,
            },
          },
        );
        const accessToken = await adapter.getAccessToken();
        if (!r.ok) throw new Error(`Google Drive folder check failed: ${r.status}`);
        const rootInfo = await r.json().catch(() => ({}));
        const FOLDER_MIME = "application/vnd.google-apps.folder";
        if (String(rootInfo?.mimeType || "") !== FOLDER_MIME) {
          throw new Error("Selected Google Drive backup item is not a folder");
        }
        const walkGDrive = async (folderId, relBase = "") => {
          const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
          const resp = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,mimeType)`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!resp.ok) throw new Error(`Google Drive folder list failed: ${resp.status}`);
          const { files } = await resp.json();
          const entries = Array.isArray(files) ? files : [];
          for (const entry of entries) {
            const name = String(entry?.name || "").trim();
            if (!name) continue;
            if (String(entry?.mimeType || "") === FOLDER_MIME) {
              await walkGDrive(entry.id, `${relBase}${name}/`);
            } else {
              fileItems.push({ id: entry.id, name: `${relBase}${name}` });
            }
          }
        };
        await walkGDrive(remoteId, "");
      }

      for (let i = 0; i < fileItems.length; i++) {
        const f = fileItems[i];
        const localPath = path.join(dir, ...String(f.name || "").split("/").filter(Boolean));
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        this._setProgress({
          pct: 10 + Math.round(((i + 1) / fileItems.length) * 80),
          message: `Downloading ${f.name}…`,
        });
        await adapter.downloadFile(f.id, localPath);
      }

      // Verify manifest + checksums.
      const manifestPath = path.join(dir, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("Downloaded backup is missing manifest.json");
      }
      const manifest = safeReadJson(manifestPath);
      const ok = this._verifyChecksums(dir, manifest);

      this._addHistoryEntry({
        id: remoteName,
        createdAt: manifest?.createdAt || new Date().toISOString(),
        scope: manifest?.scope || [],
        tag: manifest?.tag || "cloud-pull",
        totalSize: manifest?.totalSize || 0,
        status: ok ? "pulled" : "pulled-unverified",
        cloud: { [provider]: { pulledAt: new Date().toISOString() } },
        dir,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: ok
          ? `Pull complete. Checksum verified.`
          : `Pull complete. WARNING: checksum mismatch.`,
        finishedAt: Date.now(),
      });

      console.log(`[CloudBackup] Pulled ${remoteName} from ${provider}`);
      return { id: remoteName, dir, verified: ok, manifest };
    } catch (err) {
      this._setProgress({
        status: "error",
        pct: 0,
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      });
      throw err;
    }
  }

  // ─── Restore ──────────────────────────────────────────────────────────────

  /**
   * Restore a backup to the active app data.
   * Before restore, auto-creates a safety local backup for rollback.
   * @param {string} backupId  ID of local backup package to restore
   * @param {object} opts
   * @param {boolean} [opts.skipSafetyBackup=false]  Skip pre-restore safety backup
   */
  async restoreBackup(backupId, opts = {}) {
    if (
      this.progress.status !== "idle" &&
      this.progress.status !== "done" &&
      this.progress.status !== "error"
    ) {
      throw new Error("A backup/restore operation is already in progress");
    }

    const dir =
      this.history.find((h) => h.id === backupId)?.dir ||
      path.join(this.backupDir, backupId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Backup package not found locally: ${backupId}`);
    }

    const manifest = safeReadJson(path.join(dir, "manifest.json"));
    if (!manifest) throw new Error("Backup manifest missing or corrupted");

    this._setProgress({
      status: "restoring",
      pct: 5,
      message: "Verifying backup integrity...",
      startedAt: Date.now(),
      error: null,
      finishedAt: null,
    });

    try {
      this._checkCompatibility(manifest);

      const checksumOk = this._verifyChecksums(dir, manifest);
      if (!checksumOk) {
        throw new Error(
          "Backup integrity check failed (checksum mismatch). Refusing to restore.",
        );
      }

      if (!opts.skipSafetyBackup) {
        this._setProgress({ pct: 15, message: "Creating safety backup before restore..." });
        try {
          await this.createLocalBackup({ scope: ["database", "config"], tag: "pre-restore-safety" });
        } catch (err) {
          console.warn("[CloudBackup] Safety backup failed (continuing):", err.message);
        }
      }

      if (manifest.scope?.includes("database")) {
        const srcDb = path.join(dir, "adsi.db");
        if (fs.existsSync(srcDb)) {
          this._setProgress({ pct: 40, message: "Restoring database..." });
          const destDb = path.join(this.dataDir, "adsi.db");

          let pollerWasRunning = false;
          try {
            if (this.poller?.isRunning?.()) {
              this.poller.stop();
              pollerWasRunning = true;
            }
          } catch {
            // ignore
          }

          try {
            try {
              fs.copyFileSync(srcDb, destDb);
            } catch (copyErr) {
              if (!this.db?.exec || !this.db?.prepare || !this.db?.transaction) {
                throw copyErr;
              }
              this._setProgress({ pct: 45, message: "Database file copy failed; applying live restore..." });
              try {
                this._restoreDbViaAttach(srcDb);
              } catch (liveErr) {
                const copyMsg = String(copyErr?.message || copyErr || "copy failed");
                const liveMsg = String(liveErr?.message || liveErr || "live restore failed");
                throw new Error(`Database restore failed: copy step error (${copyMsg}); live-restore error (${liveMsg})`);
              }
            }
            console.log("[CloudBackup] Database restored from:", srcDb);
          } finally {
            if (pollerWasRunning) {
              try { this.poller.start(); } catch {
                // ignore restart errors; server restart may be needed
              }
            }
          }
        }
      }

      if (manifest.scope?.includes("config")) {
        this._setProgress({ pct: 70, message: "Restoring config files..." });

        const srcIp = path.join(dir, "ipconfig.json");
        if (fs.existsSync(srcIp) && this.ipConfigPath) {
          fs.copyFileSync(srcIp, this.ipConfigPath);
          console.log("[CloudBackup] IP config restored.");
        }

        const srcSettings = path.join(dir, "settings.json");
        if (fs.existsSync(srcSettings)) {
          try {
            const settingsData = safeReadJson(srcSettings);
            if (settingsData && typeof settingsData === "object") {
              const sensitive = ["remoteApiToken", "solcastApiKey", "cloudBackupSettings"];
              for (const [k, v] of Object.entries(settingsData)) {
                if (!sensitive.includes(k)) {
                  this.setSetting(k, v);
                }
              }
              console.log("[CloudBackup] Settings restored.");
            }
          } catch (err) {
            console.warn("[CloudBackup] Settings restore failed:", err.message);
          }
        }
      }

      this._addHistoryEntry({
        id: `restore-${Date.now()}`,
        createdAt: new Date().toISOString(),
        scope: manifest.scope,
        tag: `restore-from-${backupId}`,
        totalSize: 0,
        status: "restored",
        cloud: {},
        dir: null,
        restoredFrom: backupId,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: "Restore complete. Please restart the app to apply changes.",
        finishedAt: Date.now(),
      });

      console.log("[CloudBackup] Restore complete from:", backupId);
      return { ok: true, manifest };
    } catch (err) {
      this._setProgress({
        status: "error",
        pct: 0,
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      });
      throw err;
    }
  }

  _quoteIdent(name) {
    return `"${String(name || "").replace(/"/g, '""')}"`;
  }

  _restoreDbViaAttach(srcDbPath) {
    if (!this.db?.exec || !this.db?.prepare || !this.db?.transaction) {
      throw new Error("Live database restore is unavailable (db handle missing).");
    }
    const src = String(srcDbPath || "").trim();
    if (!src || !fs.existsSync(src)) {
      throw new Error(`Restore source DB not found: ${src}`);
    }

    const alias = "restore_src";
    const escapedPath = src.replace(/'/g, "''");
    const detach = () => {
      try { this.db.exec(`DETACH DATABASE ${alias}`); } catch (_) {}
    };

    detach();
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.exec(`ATTACH DATABASE '${escapedPath}' AS ${alias}`);

      const dstRows = this.db
        .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      const srcRows = this.db
        .prepare(`SELECT name FROM ${alias}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all();
      const srcTableSet = new Set(srcRows.map((r) => String(r?.name || "")));

      const tx = this.db.transaction(() => {
        for (const row of dstRows) {
          const tableName = String(row?.name || "");
          if (!tableName || !srcTableSet.has(tableName)) continue;

          const qTable = this._quoteIdent(tableName);
          const dstCols = this.db
            .prepare(`PRAGMA main.table_info(${qTable})`)
            .all()
            .map((c) => String(c?.name || ""));
          const srcCols = new Set(
            this.db
              .prepare(`PRAGMA ${alias}.table_info(${qTable})`)
              .all()
              .map((c) => String(c?.name || "")),
          );
          const cols = dstCols.filter((c) => c && srcCols.has(c));

          this.db.exec(`DELETE FROM ${qTable}`);
          if (!cols.length) continue;

          const qCols = cols.map((c) => this._quoteIdent(c)).join(", ");
          this.db.exec(`INSERT INTO ${qTable} (${qCols}) SELECT ${qCols} FROM ${alias}.${qTable}`);
        }

        const hasDstSeq = !!this.db
          .prepare("SELECT 1 AS ok FROM main.sqlite_master WHERE type='table' AND name='sqlite_sequence' LIMIT 1")
          .get();
        const hasSrcSeq = !!this.db
          .prepare(`SELECT 1 AS ok FROM ${alias}.sqlite_master WHERE type='table' AND name='sqlite_sequence' LIMIT 1`)
          .get();
        if (hasDstSeq && hasSrcSeq) {
          this.db.exec("DELETE FROM main.sqlite_sequence");
          this.db.exec(`INSERT INTO main.sqlite_sequence(name, seq) SELECT name, seq FROM ${alias}.sqlite_sequence`);
        }
      });
      tx();
    } finally {
      detach();
      try { this.db.pragma("foreign_keys = ON"); } catch (_) {}
    }
  }

  // Verification
  _verifyChecksums(dir, manifest) {
    if (!manifest?.checksums) return false;
    for (const [fname, expected] of Object.entries(manifest.checksums)) {
      if (fname === "manifest.json") continue; // self-referential, skip
      const fpath = path.join(dir, ...fname.split("/"));
      try {
        if (!fs.existsSync(fpath)) return false;
        const actual = sha256File(fpath);
        if (actual !== expected) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  _checkCompatibility(manifest) {
    const schema = String(manifest.schemaVersion || "1");
    const currentSchema = DB_SCHEMA_VERSION;
    if (Number(schema) > Number(currentSchema)) {
      throw new Error(
        `Backup schema version (${schema}) is newer than this app (${currentSchema}). ` +
          `Update the app before restoring.`,
      );
    }
    const backupAppVersion = String(manifest.appVersion || "0.0.0");
    if (semverCompare(backupAppVersion, APP_VERSION) > 0) {
      throw new Error(
        `Backup app version (${backupAppVersion}) is newer than this app (${APP_VERSION}). ` +
          `Update the app before restoring.`,
      );
    }
  }

  // ─── Scheduling ───────────────────────────────────────────────────────────

  _applySchedule(schedule, enabled) {
    if (this._cronJob) {
      this._cronJob.stop();
      this._cronJob = null;
    }
    if (!enabled || schedule === "manual") return;

    const cronExpr =
      schedule === "daily" ? "0 3 * * *" : // 3:00 AM daily
      schedule === "every6h" ? "0 */6 * * *" : null;

    if (!cronExpr) return;

    this._cronJob = cron.schedule(cronExpr, async () => {
      console.log("[CloudBackup] Scheduled backup triggered:", schedule);
      try {
        await this.backupNow({ tag: `scheduled-${schedule}` });
      } catch (err) {
        console.error("[CloudBackup] Scheduled backup failed:", err.message);
      }
    });
    console.log("[CloudBackup] Schedule active:", schedule, cronExpr);
  }

  applyInitialSchedule() {
    const s = this.getCloudSettings();
    this._applySchedule(s.schedule, s.enabled);
  }

  // ─── Retry Queue ──────────────────────────────────────────────────────────

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._processRetryQueue();
    }, 5 * 60 * 1000); // retry after 5 minutes
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  async _processRetryQueue() {
    const MAX_ATTEMPTS = 5;
    const queue = [...this._retryQueue];
    this._retryQueue = [];

    for (const item of queue) {
      if (item.attempts >= MAX_ATTEMPTS) {
        console.warn(
          `[CloudBackup] Retry limit reached for ${item.backupId} → ${item.provider}`,
        );
        continue;
      }
      item.attempts++;
      try {
        await this.uploadToCloud(item.backupId, [item.provider]);
        console.log(
          `[CloudBackup] Retry ${item.attempts}: uploaded ${item.backupId} → ${item.provider}`,
        );
      } catch (err) {
        console.error(
          `[CloudBackup] Retry ${item.attempts} failed: ${err.message}`,
        );
        this._retryQueue.push(item);
      }
    }

    if (this._retryQueue.length > 0) {
      this._scheduleRetry();
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _resolveProviders(pref) {
    const connected = [];
    if (
      (pref === "auto" || pref === "onedrive" || pref === "both") &&
      this.onedrive?.isConnected()
    ) {
      connected.push("onedrive");
    }
    if (
      (pref === "auto" || pref === "gdrive" || pref === "both") &&
      this.gdrive?.isConnected()
    ) {
      connected.push("gdrive");
    }
    return connected;
  }

  getConnectedProviders() {
    return this.tokenStore.listConnected();
  }

  /** Delete a local backup package and remove from history. */
  deleteLocalBackup(backupId) {
    const idx = this.history.findIndex((h) => h.id === backupId);
    const dir =
      idx >= 0 ? this.history[idx]?.dir : path.join(this.backupDir, backupId);
    if (idx >= 0) this.history.splice(idx, 1);
    this._saveHistory();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true };
  }
}

module.exports = CloudBackupService;
