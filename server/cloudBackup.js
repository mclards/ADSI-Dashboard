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
const { execFileSync } = require("child_process");

const APP_VERSION = require("../package.json").version;
const { resolvedBackupDir, resolvedBackupHistoryFile, resolvedLicenseDir, getNewRoot } = require("./storagePaths");
const DB_SCHEMA_VERSION = "2";

// Limit how many local backup packages to keep.
const MAX_LOCAL_PACKAGES = 20;
const S3_DEDUPE_LAYOUT = "chunked-v1";
const S3_DEDUPE_CHUNK_BYTES = 8 * 1024 * 1024;

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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

function copyDirRecursive(srcDir, destDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  return true;
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
   * @param {object} deps.s3               S3CompatibleProvider instance
   * @param {object} deps.poller           poller module (optional, for stop/start around restore)
   * @param {string} deps.ipConfigPath     Path to ipconfig.json (for config scope backup)
   * @param {string} deps.programDataDir   ProgramData root for forecast artifacts
   */
  constructor(deps) {
    this.dataDir = deps.dataDir;
    this.db = deps.db;
    this.getSetting = deps.getSetting;
    this.setSetting = deps.setSetting;
    this.tokenStore = deps.tokenStore;
    this.onedrive = deps.onedrive;
    this.gdrive = deps.gdrive;
    this.s3 = deps.s3;
    this.poller = deps.poller || null;
    this.ipConfigPath = deps.ipConfigPath || null;
    this.programDataDir = deps.programDataDir || null;

    this.backupDir = resolvedBackupDir(this.dataDir);
    this.historyFile = resolvedBackupHistoryFile(this.dataDir);

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

  getDefaultSettings() {
    return {
      enabled: false,
      email: "",
      provider: "auto",              // auto | onedrive | gdrive | s3 | both
      scope: ["database", "config"], // database | config | logs
      schedule: "manual",            // manual | daily | every6h
      onedrive: { clientId: "" },
      gdrive: { clientId: "", clientSecret: "" },
      s3: {
        endpoint: "",
        region: "",
        bucket: "",
        prefix: "InverterDashboardBackups",
        forcePathStyle: false,
      },
    };
  }

  getCloudSettings() {
    const raw = this.getSetting("cloudBackupSettings", null);
    const defaults = this.getDefaultSettings();
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        onedrive: {
          ...defaults.onedrive,
          ...(parsed?.onedrive && typeof parsed.onedrive === "object"
            ? parsed.onedrive
            : {}),
        },
        gdrive: {
          ...defaults.gdrive,
          ...(parsed?.gdrive && typeof parsed.gdrive === "object"
            ? parsed.gdrive
            : {}),
        },
        s3: {
          ...defaults.s3,
          ...(parsed?.s3 && typeof parsed.s3 === "object"
            ? parsed.s3
            : {}),
        },
      };
    } catch {
      return defaults;
    }
  }

  getCloudSettingsForClient(settings = null) {
    const source = settings && typeof settings === "object"
      ? settings
      : this.getCloudSettings();
    const secret = String(source?.gdrive?.clientSecret || "").trim();
    return {
      ...source,
      onedrive: {
        ...(source?.onedrive || {}),
      },
      gdrive: {
        ...(source?.gdrive || {}),
        clientSecret: "",
        clientSecretSaved: secret.length > 0,
      },
      s3: {
        ...(source?.s3 || {}),
        accessKeyId: "",
        secretAccessKey: "",
        credentialsSaved: this.tokenStore.isConnected("s3"),
      },
    };
  }

  saveCloudSettings(s, options = {}) {
    const current = this.getCloudSettings();
    const body = s && typeof s === "object" ? s : {};
    const clearGDriveClientSecret = Boolean(options?.clearGDriveClientSecret);
    const incomingOneDrive = {
      clientId: String(body?.onedrive?.clientId ?? ""),
    };
    const incomingGDrive = {
      clientId: String(body?.gdrive?.clientId ?? ""),
      clientSecret: String(body?.gdrive?.clientSecret ?? ""),
    };
    const incomingS3 = {
      endpoint: String(body?.s3?.endpoint ?? "").trim(),
      region: String(body?.s3?.region ?? "").trim(),
      bucket: String(body?.s3?.bucket ?? "").trim(),
      prefix: String(body?.s3?.prefix ?? "").trim(),
      forcePathStyle: Boolean(body?.s3?.forcePathStyle),
    };
    const merged = {
      ...current,
      ...body,
      onedrive: {
        ...(current.onedrive || {}),
        ...incomingOneDrive,
      },
      gdrive: {
        ...(current.gdrive || {}),
        ...incomingGDrive,
      },
      s3: {
        ...(current.s3 || {}),
        ...incomingS3,
      },
    };
    const nextSecret = String(incomingGDrive.clientSecret ?? "").trim();
    if (clearGDriveClientSecret) {
      merged.gdrive.clientSecret = "";
    } else if (nextSecret) {
      merged.gdrive.clientSecret = nextSecret;
    } else {
      merged.gdrive.clientSecret = String(current.gdrive?.clientSecret || "");
    }
    // Validate provider
    if (!["auto", "onedrive", "gdrive", "s3", "both"].includes(merged.provider)) {
      merged.provider = "auto";
    }
    if (!["manual", "daily", "every6h"].includes(merged.schedule)) {
      merged.schedule = "manual";
    }
    this.setSetting("cloudBackupSettings", JSON.stringify(merged));
    this._applySchedule(merged.schedule, merged.enabled);
    return merged;
  }

  _getProviderAdapter(provider) {
    if (provider === "onedrive") return this.onedrive;
    if (provider === "gdrive") return this.gdrive;
    if (provider === "s3") return this.s3;
    return null;
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

  _recordFilesFromDir(dir, relPrefix, checksums, files) {
    if (!dir || !fs.existsSync(dir)) return;
    for (const rel of listFilesRecursive(dir)) {
      const abs = path.join(dir, ...rel.split("/"));
      const outRel = relPrefix ? `${relPrefix}/${rel}` : rel;
      checksums[outRel] = sha256File(abs);
      files.push({ name: outRel, size: fs.statSync(abs).size });
    }
  }

  _getS3ChunkKey(chunkHash) {
    return `objects/chunks/${String(chunkHash || "").slice(0, 2)}/${chunkHash}`;
  }

  async _uploadS3DeduplicatedBackup(dir, backupId, manifest, adapter) {
    if (
      typeof adapter?.objectExists !== "function" ||
      typeof adapter?.uploadBuffer !== "function"
    ) {
      throw new Error("S3 adapter does not support deduplicated backup uploads");
    }

    const manifestPath = path.join(dir, "manifest.json");
    const allFiles = listFilesRecursive(dir).filter((fname) => fname !== "manifest.json");
    if (!allFiles.length) {
      throw new Error("No files found in backup package");
    }

    const totalBytes = allFiles.reduce((sum, fname) => {
      const localPath = path.join(dir, ...fname.split("/"));
      return sum + Number(fs.statSync(localPath).size || 0);
    }, 0);
    const knownChunks = new Set();
    const cloudFiles = {};
    let processedBytes = 0;
    let uploadedBytes = 0;
    let reusedBytes = 0;

    for (const fname of allFiles) {
      const localPath = path.join(dir, ...fname.split("/"));
      const fileSize = Number(fs.statSync(localPath).size || 0);
      const fileChecksum = String(manifest?.checksums?.[fname] || sha256File(localPath));
      const fileMeta = {
        format: S3_DEDUPE_LAYOUT,
        size: fileSize,
        checksum: fileChecksum,
        chunks: [],
      };

      if (fileSize > 0) {
        const fd = fs.openSync(localPath, "r");
        try {
          let offset = 0;
          while (offset < fileSize) {
            const bytesToRead = Math.min(S3_DEDUPE_CHUNK_BYTES, fileSize - offset);
            const buffer = Buffer.allocUnsafe(bytesToRead);
            const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
            if (!(bytesRead > 0)) break;
            const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
            const chunkHash = sha256Buffer(chunk);
            const chunkKey = this._getS3ChunkKey(chunkHash);
            let chunkExists = knownChunks.has(chunkKey);
            if (!chunkExists) {
              chunkExists = await adapter.objectExists(chunkKey);
              if (!chunkExists) {
                await adapter.uploadBuffer(chunk, chunkKey);
                uploadedBytes += chunk.length;
              } else {
                reusedBytes += chunk.length;
              }
              knownChunks.add(chunkKey);
            } else {
              reusedBytes += chunk.length;
            }
            fileMeta.chunks.push({
              id: chunkKey,
              sha256: chunkHash,
              size: chunk.length,
            });
            processedBytes += chunk.length;
            const ratio = totalBytes > 0 ? processedBytes / totalBytes : 1;
            this._setProgress({
              pct: Math.min(95, 75 + Math.round(ratio * 18)),
            });
            offset += chunk.length;
          }
        } finally {
          fs.closeSync(fd);
        }
      }

      cloudFiles[fname] = fileMeta;
    }

    manifest.cloud.s3 = {
      uploadedAt: new Date().toISOString(),
      layout: S3_DEDUPE_LAYOUT,
      chunkBytes: S3_DEDUPE_CHUNK_BYTES,
      uploadedBytes,
      reusedBytes,
      files: cloudFiles,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const manifestResult = await adapter.uploadFile(
      manifestPath,
      `${backupId}/manifest.json`,
      (pct) => {
        this._setProgress({
          pct: Math.min(95, 93 + Math.round((Number(pct || 0) / 100) * 2)),
        });
      },
    );
    manifest.cloud.s3.manifest = manifestResult;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await adapter.uploadFile(manifestPath, `${backupId}/manifest.json`);
    return cloudFiles;
  }

  async _downloadS3ChunkedFile(adapter, localPath, meta, onChunk) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const chunks = Array.isArray(meta?.chunks) ? meta.chunks : [];
    if (!chunks.length) {
      fs.writeFileSync(localPath, Buffer.alloc(0));
      return;
    }

    const fd = fs.openSync(localPath, "w");
    try {
      for (const chunkMeta of chunks) {
        const chunkId = String(chunkMeta?.id || "").trim();
        if (!chunkId) continue;
        const data = await adapter.downloadBuffer(chunkId);
        const expectedHash = String(chunkMeta?.sha256 || "").trim();
        if (expectedHash && sha256Buffer(data) !== expectedHash) {
          throw new Error(`Checksum mismatch while restoring chunk for ${path.basename(localPath)}`);
        }
        fs.writeSync(fd, data, 0, data.length);
        if (typeof onChunk === "function") onChunk(chunkMeta, data.length);
      }
    } finally {
      fs.closeSync(fd);
    }
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
      const forecastDir = this.programDataDir
        ? path.join(this.programDataDir, "forecast")
        : null;
      const historyDir = this.programDataDir
        ? path.join(this.programDataDir, "history")
        : null;
      const weatherDir = this.programDataDir
        ? path.join(this.programDataDir, "weather")
        : null;
      const forecastDest = path.join(dir, "forecast");
      const historyDest = path.join(dir, "history");
      const weatherDest = path.join(dir, "weather");
      if (forecastDir && copyDirRecursive(forecastDir, forecastDest)) {
        this._recordFilesFromDir(forecastDest, "forecast", checksums, files);
      }
      if (historyDir && copyDirRecursive(historyDir, historyDest)) {
        this._recordFilesFromDir(historyDest, "history", checksums, files);
      }
      if (weatherDir && copyDirRecursive(weatherDir, weatherDest)) {
        this._recordFilesFromDir(weatherDest, "weather", checksums, files);
      }
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
      const forecastLogSrc = this.programDataDir
        ? path.join(this.programDataDir, "logs", "forecast_dayahead.log")
        : null;
      if (forecastLogSrc && fs.existsSync(forecastLogSrc)) {
        const logDest = path.join(dir, "logs");
        fs.mkdirSync(logDest, { recursive: true });
        const dst = path.join(logDest, "forecast_dayahead.log");
        fs.copyFileSync(forecastLogSrc, dst);
        checksums["logs/forecast_dayahead.log"] = sha256File(dst);
        files.push({ name: "logs/forecast_dayahead.log", size: fs.statSync(dst).size });
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
      const adapter = this._getProviderAdapter(provider);
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
        if (provider === "s3") {
          Object.assign(
            cloudFiles,
            await this._uploadS3DeduplicatedBackup(dir, backupId, manifest, adapter),
          );
        } else {
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
        }

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
    const adapter = this._getProviderAdapter(provider);
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
    const adapter = this._getProviderAdapter(provider);
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
      } else if (provider === "s3") {
        const remoteFiles = await adapter.listBackupFiles(remoteId);
        const manifestItem = remoteFiles.find((item) => String(item?.name || "") === "manifest.json");
        if (!manifestItem) {
          throw new Error("S3 backup manifest not found");
        }
        const manifestBuffer = await adapter.downloadBuffer(manifestItem.id);
        const manifestPath = path.join(dir, "manifest.json");
        fs.writeFileSync(manifestPath, manifestBuffer);
        const remoteManifest = safeReadJson(manifestPath);
        const s3CloudMeta =
          remoteManifest &&
          remoteManifest.cloud &&
          typeof remoteManifest.cloud.s3 === "object"
            ? remoteManifest.cloud.s3
            : null;
        const s3Files =
          s3CloudMeta && s3CloudMeta.files && typeof s3CloudMeta.files === "object"
            ? s3CloudMeta.files
            : null;
        if (s3CloudMeta?.layout === S3_DEDUPE_LAYOUT && s3Files) {
          const dedupedEntries = Object.entries(s3Files);
          const totalBytes = dedupedEntries.reduce(
            (sum, [, meta]) => sum + Number(meta?.size || 0),
            0,
          );
          let restoredBytes = 0;
          for (const [fname, meta] of dedupedEntries) {
            const localPath = path.join(dir, ...String(fname || "").split("/").filter(Boolean));
            await this._downloadS3ChunkedFile(adapter, localPath, meta, (_chunkMeta, chunkBytes) => {
              restoredBytes += Number(chunkBytes || 0);
              const ratio = totalBytes > 0 ? restoredBytes / totalBytes : 1;
              this._setProgress({
                pct: Math.min(92, 10 + Math.round(ratio * 80)),
                message: `Downloading ${fname}…`,
              });
            });
          }
          fileItems = [];
        } else {
          fileItems = remoteFiles.filter((item) => String(item?.name || "") !== "manifest.json");
        }
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
        if (this.programDataDir) {
          const srcForecastDir = path.join(dir, "forecast");
          const srcHistoryDir = path.join(dir, "history");
          const srcWeatherDir = path.join(dir, "weather");
          if (fs.existsSync(srcForecastDir)) {
            this._setProgress({ pct: 58, message: "Restoring forecast artifacts..." });
            const destForecastDir = path.join(this.programDataDir, "forecast");
            fs.rmSync(destForecastDir, { recursive: true, force: true });
            copyDirRecursive(srcForecastDir, destForecastDir);
          }
          if (fs.existsSync(srcHistoryDir)) {
            const destHistoryDir = path.join(this.programDataDir, "history");
            fs.rmSync(destHistoryDir, { recursive: true, force: true });
            copyDirRecursive(srcHistoryDir, destHistoryDir);
          }
          if (fs.existsSync(srcWeatherDir)) {
            const destWeatherDir = path.join(this.programDataDir, "weather");
            fs.rmSync(destWeatherDir, { recursive: true, force: true });
            copyDirRecursive(srcWeatherDir, destWeatherDir);
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

      if (manifest.scope?.includes("logs")) {
        this._setProgress({ pct: 82, message: "Restoring logs..." });
        const srcLogsDir = path.join(dir, "logs");
        if (fs.existsSync(srcLogsDir)) {
          const dataLogsDir = path.join(this.dataDir, "logs");
          fs.mkdirSync(dataLogsDir, { recursive: true });
          for (const entry of fs.readdirSync(srcLogsDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (entry.name === "forecast_dayahead.log") continue;
            const src = path.join(srcLogsDir, entry.name);
            const dst = path.join(dataLogsDir, entry.name);
            fs.copyFileSync(src, dst);
          }
          if (this.programDataDir) {
            const srcForecastLog = path.join(srcLogsDir, "forecast_dayahead.log");
            if (fs.existsSync(srcForecastLog)) {
              const forecastLogsDir = path.join(this.programDataDir, "logs");
              fs.mkdirSync(forecastLogsDir, { recursive: true });
              fs.copyFileSync(
                srcForecastLog,
                path.join(forecastLogsDir, "forecast_dayahead.log"),
              );
            }
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
    if (
      (pref === "auto" || pref === "s3" || pref === "both") &&
      this.s3?.isConnected()
    ) {
      connected.push("s3");
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

  // ─── Portable Backup (Full System) ────────────────────────────────────────

  /**
   * Create a full-system backup and export as a portable .adsibak file.
   * Includes: database, config, forecast, archive, license, auth.
   * @param {string} destPath  Destination file path (.adsibak)
   * @returns {Promise<{ok, path, manifest}>}
   */
  async createPortableBackup(destPath) {
    if (
      this.progress.status !== "idle" &&
      this.progress.status !== "done" &&
      this.progress.status !== "error"
    ) {
      throw new Error("A backup/restore operation is already in progress");
    }

    this._setProgress({
      status: "creating",
      pct: 2,
      message: "Creating full system backup…",
      startedAt: Date.now(),
      error: null,
      finishedAt: null,
    });

    try {
      // Step 1: Create standard backup with database + config + logs
      this._setProgress({ pct: 5, message: "Backing up database and config…" });
      const { id, dir, manifest } = await this.createLocalBackup({
        scope: ["database", "config", "logs"],
        tag: "portable-full",
      });

      // Step 2: Copy additional directories into the package
      const root = getNewRoot();

      // Archive databases
      const archiveDir = path.join(root, "archive");
      if (fs.existsSync(archiveDir)) {
        this._setProgress({ pct: 50, message: "Backing up archive databases…" });
        const archiveDest = path.join(dir, "archive");
        copyDirRecursive(archiveDir, archiveDest);
        this._recordFilesFromDir(archiveDest, "archive", manifest.checksums, manifest.files);
      }

      // License files
      const licenseDir = resolvedLicenseDir();
      if (licenseDir && fs.existsSync(licenseDir)) {
        this._setProgress({ pct: 58, message: "Backing up license files…" });
        const licenseDest = path.join(dir, "license");
        copyDirRecursive(licenseDir, licenseDest);
        this._recordFilesFromDir(licenseDest, "license", manifest.checksums, manifest.files);
      }

      // Auth tokens
      const authDir = path.join(root, "auth");
      if (fs.existsSync(authDir)) {
        this._setProgress({ pct: 62, message: "Backing up auth tokens…" });
        const authDest = path.join(dir, "auth");
        copyDirRecursive(authDir, authDest);
        this._recordFilesFromDir(authDest, "auth", manifest.checksums, manifest.files);
      }

      // Update manifest with full scope
      manifest.scope = ["database", "config", "logs", "archive", "license", "auth"];
      manifest.tag = "portable-full";
      manifest.totalSize = manifest.files.reduce((s, f) => s + f.size, 0);
      const manifestPath = path.join(dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Step 3: Zip the package then rename to .adsibak
      // PowerShell Compress-Archive only supports .zip extension
      this._setProgress({ pct: 70, message: "Compressing backup…" });
      const zipTmp = destPath.replace(/\.adsibak$/i, ".zip");

      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Compress-Archive -Path '${String(dir).replace(/'/g, "''")}\\*' -DestinationPath '${String(zipTmp).replace(/'/g, "''")}' -Force`,
      ], { timeout: 300000, windowsHide: true });

      if (!fs.existsSync(zipTmp)) {
        throw new Error("Failed to create backup archive");
      }
      fs.renameSync(zipTmp, destPath);

      const archiveSize = fs.statSync(destPath).size;

      // Step 4: Clean up the temporary package directory
      this._setProgress({ pct: 90, message: "Cleaning up…" });
      this.deleteLocalBackup(id);

      this._addHistoryEntry({
        id: `portable-${Date.now()}`,
        createdAt: manifest.createdAt,
        scope: manifest.scope,
        tag: "portable-full",
        totalSize: archiveSize,
        status: "exported",
        cloud: {},
        dir: null,
        exportedTo: destPath,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: `Backup exported (${(archiveSize / 1048576).toFixed(1)} MB)`,
        finishedAt: Date.now(),
      });

      console.log(`[CloudBackup] Portable backup exported: ${destPath}`);
      return { ok: true, path: destPath, manifest, archiveSize };
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

  /**
   * Import a portable .adsibak file, validate it, and make it available for restore.
   * @param {string} srcPath  Path to the .adsibak file
   * @returns {Promise<{ok, id, manifest}>}
   */
  async importPortableBackup(srcPath) {
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Backup file not found: ${srcPath}`);
    }

    if (
      this.progress.status !== "idle" &&
      this.progress.status !== "done" &&
      this.progress.status !== "error"
    ) {
      throw new Error("A backup/restore operation is already in progress");
    }

    this._setProgress({
      status: "creating",
      pct: 5,
      message: "Importing backup file…",
      startedAt: Date.now(),
      error: null,
      finishedAt: null,
    });

    try {
      // Step 1: Extract to a temporary directory
      const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
      const id = `imported-backup-${nowIso}`;
      const dir = path.join(this.backupDir, id);
      fs.mkdirSync(dir, { recursive: true });

      this._setProgress({ pct: 20, message: "Extracting backup archive…" });

      // Expand-Archive only supports .zip — copy to a temp .zip, extract, then clean up
      const zipTmp = path.join(this.backupDir, `_import-${Date.now()}.zip`);
      try {
        fs.copyFileSync(srcPath, zipTmp);
        execFileSync("powershell", [
          "-NoProfile", "-Command",
          `Expand-Archive -Path '${String(zipTmp).replace(/'/g, "''")}' -DestinationPath '${String(dir).replace(/'/g, "''")}' -Force`,
        ], { timeout: 300000, windowsHide: true });
      } finally {
        try { fs.unlinkSync(zipTmp); } catch (_) { /* best-effort cleanup */ }
      }

      // Step 2: Read and validate manifest
      this._setProgress({ pct: 50, message: "Validating backup…" });
      const manifest = safeReadJson(path.join(dir, "manifest.json"));
      if (!manifest) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error("Invalid backup file: manifest.json not found or corrupted");
      }

      // Check compatibility
      this._checkCompatibility(manifest);

      // Step 3: Verify checksums
      this._setProgress({ pct: 60, message: "Verifying file integrity…" });
      const checksumOk = this._verifyChecksums(dir, manifest);
      if (!checksumOk) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error("Backup integrity check failed (checksum mismatch)");
      }

      // Step 4: Add to history
      this._setProgress({ pct: 85, message: "Registering backup…" });
      this._addHistoryEntry({
        id,
        createdAt: manifest.createdAt,
        scope: manifest.scope || ["database", "config"],
        tag: manifest.tag || "imported",
        totalSize: manifest.totalSize || 0,
        status: "imported",
        cloud: {},
        dir,
        importedFrom: srcPath,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: "Backup imported and validated. Ready to restore.",
        finishedAt: Date.now(),
      });

      console.log(`[CloudBackup] Portable backup imported: ${id}`);
      return { ok: true, id, manifest };
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

  /**
   * Validate a portable .adsibak file without importing it.
   * Returns manifest info for user preview.
   * @param {string} srcPath  Path to the .adsibak file
   * @returns {Promise<{ok, manifest, fileCount, totalSize}>}
   */
  async validatePortableBackup(srcPath) {
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Backup file not found: ${srcPath}`);
    }

    // Extract to temp dir for validation
    const tempDir = path.join(this.backupDir, `_validate-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Expand-Archive only supports .zip — copy to a temp .zip, extract, then clean up
    const zipTmp = path.join(this.backupDir, `_validate-${Date.now()}.zip`);
    try {
      fs.copyFileSync(srcPath, zipTmp);
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${String(zipTmp).replace(/'/g, "''")}' -DestinationPath '${String(tempDir).replace(/'/g, "''")}' -Force`,
      ], { timeout: 300000, windowsHide: true });
      try { fs.unlinkSync(zipTmp); } catch (_) { /* best-effort cleanup */ }

      const manifest = safeReadJson(path.join(tempDir, "manifest.json"));
      if (!manifest) {
        throw new Error("Invalid backup: manifest.json not found");
      }

      this._checkCompatibility(manifest);
      const checksumOk = this._verifyChecksums(tempDir, manifest);

      return {
        ok: true,
        manifest: {
          appVersion: manifest.appVersion,
          schemaVersion: manifest.schemaVersion,
          createdAt: manifest.createdAt,
          scope: manifest.scope,
          tag: manifest.tag,
        },
        fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
        totalSize: manifest.totalSize || 0,
        archiveSize: fs.statSync(srcPath).size,
        checksumOk,
      };
    } finally {
      try { fs.unlinkSync(zipTmp); } catch (_) { /* already cleaned or never created */ }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Restore a portable backup including archive, license, and auth directories.
   * Extends standard restoreBackup with extra scope handling.
   * @param {string} backupId  ID of the imported backup package
   * @returns {Promise<{ok, manifest}>}
   */
  async restorePortableBackup(backupId) {
    // First run the standard restore (handles database, config, logs)
    const result = await this.restoreBackup(backupId);
    const dir =
      this.history.find((h) => h.id === backupId)?.dir ||
      path.join(this.backupDir, backupId);

    if (!fs.existsSync(dir)) return result;

    const manifest = safeReadJson(path.join(dir, "manifest.json"));
    const scope = manifest?.scope || [];
    const root = getNewRoot();

    // Restore archive databases
    if (scope.includes("archive")) {
      const srcArchive = path.join(dir, "archive");
      if (fs.existsSync(srcArchive)) {
        const destArchive = path.join(root, "archive");
        fs.mkdirSync(destArchive, { recursive: true });
        copyDirRecursive(srcArchive, destArchive);
        console.log("[CloudBackup] Archive databases restored.");
      }
    }

    // Restore license files
    if (scope.includes("license")) {
      const srcLicense = path.join(dir, "license");
      if (fs.existsSync(srcLicense)) {
        const destLicense = resolvedLicenseDir();
        fs.mkdirSync(destLicense, { recursive: true });
        copyDirRecursive(srcLicense, destLicense);
        console.log("[CloudBackup] License files restored.");
      }
    }

    // Restore auth tokens
    if (scope.includes("auth")) {
      const srcAuth = path.join(dir, "auth");
      if (fs.existsSync(srcAuth)) {
        const destAuth = path.join(root, "auth");
        fs.mkdirSync(destAuth, { recursive: true });
        copyDirRecursive(srcAuth, destAuth);
        console.log("[CloudBackup] Auth tokens restored.");
      }
    }

    return result;
  }
}

module.exports = CloudBackupService;
