"use strict";
/**
 * main.js - Electron entry point for ADSI Inverter Dashboard
 * Starts a Python backend (PyInstaller EXE preferred, python script fallback).
 */

const { app, BrowserWindow, ipcMain, shell, globalShortcut, dialog, Menu } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");

// Allow dashboard alarm audio to start immediately on packaged clients.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Prevent packaged app crashes when stdout/stderr pipe is unavailable (EPIPE).
function makeSafeConsoleWriter(method) {
  const original = console[method].bind(console);
  return (...args) => {
    try {
      original(...args);
    } catch (err) {
      const code = String(err?.code || "");
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
      try {
        process.stderr.write(`[console-${method}-fallback] ${args.map((v) => String(v)).join(" ")}\n`);
      } catch (_) {
        // Ignore secondary logging failures.
      }
    }
  };
  
}

console.log = makeSafeConsoleWriter("log");
console.warn = makeSafeConsoleWriter("warn");
console.error = makeSafeConsoleWriter("error");

if (process.stdout && typeof process.stdout.on === "function") {
  process.stdout.on("error", (err) => {
    const code = String(err?.code || "");
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
  });
}
if (process.stderr && typeof process.stderr.on === "function") {
  process.stderr.on("error", (err) => {
    const code = String(err?.code || "");
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
  });
}

process.on("uncaughtException", (err) => {
  const code = String(err?.code || "");
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
    return;
  }
  try {
    console.error("[main] Uncaught exception:", err);
  } catch (_) {
    // Ignore secondary logging issues.
  }
});

const PORTABLE_EXEC_DIR = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
const PORTABLE_DATA_DIR = PORTABLE_EXEC_DIR
  ? path.join(PORTABLE_EXEC_DIR, "InverterDashboardData")
  : "";

// ─── Config ───────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "../public");
const SERVER_URL = "http://localhost:3500";
const SERVER_HTTP = new URL(SERVER_URL);
const SERVER_HOST = SERVER_HTTP.hostname || "127.0.0.1";
const SERVER_PORT = Number(SERVER_HTTP.port || 80);
const TOPOLOGY_URL = `${SERVER_URL}/topology.html`;
const IP_CONFIG_URL = `${SERVER_URL}/ip-config.html`;
const POLL_INTERVAL = 600;
const POLL_TIMEOUT = 120000;
const INITIAL_LOAD_RETRY_DELAY = 1200;
const INITIAL_LOAD_RETRY_MAX = 8;
const FORECAST_RESTART_BASE_MS = 1500;
const FORECAST_RESTART_MAX_MS = 30000;
const FORECAST_MODE_SYNC_MS = 10000;
const IS_DEV = process.env.NODE_ENV === "development";
const BACKEND_EXE_NAMES = ["InverterCoreService.exe"];
const BACKEND_SCRIPT_NAMES = ["InverterCoreService.py", "main2.py"];
const FORECAST_EXE_NAMES = ["ForecastCoreService.exe"];
const FORECAST_SCRIPT_NAMES = ["ForecastCoreService.py"];
const LEGACY_SERVICE_IMAGE_NAMES = ["ADSI_InverterService.exe", "ADSI_ForecastService.exe"];
// Login-page admin auth key is intentionally fixed across devices.
const LOGIN_ADMIN_AUTH_KEY = "ADSI-2026";
const DEFAULT_LOGIN_USERNAME = "admin";
const DEFAULT_LOGIN_PASSWORD = "1234";
const APP_ICON = path.join(__dirname, "../assets/icon.ico");
const PROGRAMDATA_ROOT = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
const PROGRAMDATA_DIR = path.join(PROGRAMDATA_ROOT, "ADSI-InverterDashboard");
const LICENSE_DIR = path.join(PROGRAMDATA_DIR, "license");
const LICENSE_STATE_PATH = path.join(LICENSE_DIR, "license-state.json");
const LICENSE_FILE_MIRROR = path.join(LICENSE_DIR, "license.dat");
const LICENSE_REG_PATH = "HKCU\\Software\\ADSI\\InverterDashboard\\License";
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 7;
const LICENSE_WARN_MS = DAY_MS; // 1 day
const LICENSE_CHECK_INTERVAL_MS = 5 * 1000;
const LICENSE_PUBLIC_KEY_PATH = String(process.env.ADSI_LICENSE_PUBLIC_KEY_PATH || "").trim();
const LICENSE_PUBLIC_KEY_PEM = String(process.env.ADSI_LICENSE_PUBLIC_KEY || "").trim();
const LICENSE_REQUIRE_SIGNATURE =
  String(process.env.ADSI_LICENSE_REQUIRE_SIGNATURE || "0").trim() === "1";
const UPDATE_REPO_OWNER = String(process.env.ADSI_UPDATE_REPO_OWNER || "mclards").trim();
const UPDATE_REPO_NAME = String(process.env.ADSI_UPDATE_REPO_NAME || "ADSI-Dashboard").trim();
const UPDATE_FEED_URL = String(
  process.env.ADSI_UPDATE_FEED_URL
  || `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest/download`,
).trim();
const UPDATE_GITHUB_TOKEN = String(process.env.ADSI_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();
const UPDATE_CHECK_TIMEOUT_MS = 10000;
const LEGACY_USERDATA_DIR_NAMES = [
  "adsi-dashboard",
  "adsi-inverter-dashboard",
];

// ─── State ────────────────────────────────────────────────────────────────────
let mainWin = null;
let loadingWin = null;
let loginWin = null;
let topologyWin = null;
let ipConfigWin = null;
let webProc = null;
let embeddedServerStarted = false;
let embeddedServerModule = null;
let backendProc = null;
let forecastProc = null;
let serverBootError = "";
let serverReadyFired = false;
let mainPageLoadedOnce = false;
let initialLoadRetries = 0;
let initialLoadRetryTimer = null;
let isAppShuttingDown = false;
let forecastRestartTimer = null;
let forecastRestartAttempts = 0;
let forecastModeSyncTimer = null;
let forecastModeSyncInFlight = false;
let forecastStopExpected = false;
let lastForecastLaunch = null;
let hasAuthenticated = false;
let bootStarted = false;
let shortcutsRegistered = false;
let licenseStateCache = null;
let licenseCheckerTimer = null;
let licenseShutdownTriggered = false;
let lastBroadcastLicenseSignature = "";
let allowMainWindowClose = false;
let appUpdateAutoCheckTimer = null;
let appUpdateAutoCheckStarted = false;
let appUpdateBridgeBound = false;
let appUpdateState = {
  mode: "disabled",
  appVersion: "0.0.0",
  status: "idle",
  message: "Updater not initialized.",
  checking: false,
  updateAvailable: false,
  latestVersion: "",
  downloadPercent: 0,
  canDownload: false,
  canInstall: false,
  downloadUrl: "",
  checkedAt: 0,
  error: "",
};

function configurePortableDataPaths() {
  if (!PORTABLE_DATA_DIR) return;
  try {
    fs.mkdirSync(PORTABLE_DATA_DIR, { recursive: true });
    const userDataDir = path.join(PORTABLE_DATA_DIR, "userData");
    const dbDir = path.join(PORTABLE_DATA_DIR, "db");
    const cfgDir = path.join(PORTABLE_DATA_DIR, "config");
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    app.setPath("userData", userDataDir);
    process.env.ADSI_PORTABLE_DATA_DIR = PORTABLE_DATA_DIR;
    process.env.ADSI_DATA_DIR = dbDir;
    console.log("[main] Portable data root:", PORTABLE_DATA_DIR);
  } catch (err) {
    console.error("[main] Portable path setup failed:", err.message);
  }
}

configurePortableDataPaths();

function copyFileIfMissing(src, dest) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch (err) {
    console.warn("[migrate] file copy failed:", src, "->", dest, err.message);
    return false;
  }
}

function copyDirIfMissing(srcDir, destDir) {
  try {
    if (!fs.existsSync(srcDir)) return 0;
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    console.warn("[migrate] dir init failed:", srcDir, "->", destDir, err.message);
    return 0;
  }
  let copied = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    console.warn("[migrate] dir read failed:", srcDir, err.message);
    return 0;
  }
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirIfMissing(src, dest);
    } else if (entry.isFile()) {
      copied += copyFileIfMissing(src, dest) ? 1 : 0;
    }
  }
  return copied;
}

function migrateLegacyUserDataIfNeeded() {
  if (isPortableRuntime()) return { migrated: false, source: "", files: 0 };
  let appDataDir = "";
  let currentUserData = "";
  try {
    appDataDir = app.getPath("appData");
    currentUserData = app.getPath("userData");
  } catch (err) {
    console.warn("[migrate] userData path resolve failed:", err.message);
    return { migrated: false, source: "", files: 0 };
  }
  if (!appDataDir || !currentUserData) return { migrated: false, source: "", files: 0 };
  try {
    fs.mkdirSync(currentUserData, { recursive: true });
  } catch (err) {
    console.warn("[migrate] current userData init failed:", currentUserData, err.message);
    return { migrated: false, source: "", files: 0 };
  }

  const currentNorm = path.resolve(currentUserData).toLowerCase();
  const candidateDirs = [];
  for (const name of LEGACY_USERDATA_DIR_NAMES) {
    const abs = path.join(appDataDir, name);
    const norm = path.resolve(abs).toLowerCase();
    if (norm === currentNorm) continue;
    candidateDirs.push(abs);
  }

  for (const legacyDir of candidateDirs) {
    if (!fs.existsSync(legacyDir)) continue;
    const authCopied = copyDirIfMissing(
      path.join(legacyDir, "auth"),
      path.join(currentUserData, "auth"),
    );
    const configCopied = copyDirIfMissing(
      path.join(legacyDir, "config"),
      path.join(currentUserData, "config"),
    );
    const rootConfigCopied = copyFileIfMissing(
      path.join(legacyDir, "ipconfig.json"),
      path.join(currentUserData, "config", "ipconfig.json"),
    ) ? 1 : 0;
    const totalCopied = authCopied + configCopied + rootConfigCopied;
    if (totalCopied > 0) {
      console.log(
        `[migrate] userData migrated from ${legacyDir} -> ${currentUserData} (${totalCopied} file(s))`,
      );
      return { migrated: true, source: legacyDir, files: totalCopied };
    }
  }
  return { migrated: false, source: "", files: 0 };
}

function parseVersionParts(input) {
  const normalized = String(input || "")
    .trim()
    .replace(/^v/i, "");
  if (!normalized) return [0, 0, 0];
  return normalized.split(".").map((part) => {
    const n = Number.parseInt(String(part).replace(/[^\d].*$/, ""), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = Number(pa[i] || 0);
    const vb = Number(pb[i] || 0);
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function isPortableRuntime() {
  return !!String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim()
    || !!String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
}

function getAppUpdateMode() {
  if (!app.isPackaged) return "dev";
  if (isPortableRuntime()) return "portable";
  return "installer";
}

function buildPublicAppUpdateState() {
  return {
    ...appUpdateState,
    appVersion: app.getVersion(),
    modeLabel:
      appUpdateState.mode === "installer"
        ? "Installer (Auto)"
        : appUpdateState.mode === "portable"
          ? "Portable (Manual)"
          : appUpdateState.mode === "dev"
            ? "Development"
            : "Unavailable",
  };
}

function setAppUpdateState(patch, broadcast = true) {
  appUpdateState = {
    ...appUpdateState,
    ...patch,
    appVersion: app.getVersion(),
  };
  if (broadcast) broadcastAppUpdateState();
  return buildPublicAppUpdateState();
}

function broadcastAppUpdateState() {
  const payload = buildPublicAppUpdateState();
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send("app-update-status", payload);
    } catch (_) {}
  }
}

function requestJsonHttps(url, timeoutMs = UPDATE_CHECK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "InverterDashboard-Updater",
      Accept: "application/vnd.github+json",
    };
    if (UPDATE_GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${UPDATE_GITHUB_TOKEN}`;
    }
    const req = https.request(
      url,
      {
        method: "GET",
        headers,
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk || "");
        });
        res.on("end", () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`GitHub API HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(raw || "{}"));
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${err.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Update check timed out")));
    req.end();
  });
}

function findPortableAssetUrl(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const scored = assets
    .map((asset) => {
      const name = String(asset?.name || "").toLowerCase();
      const url = String(asset?.browser_download_url || "").trim();
      if (!name || !url) return null;
      if (!name.endsWith(".exe")) return null;
      let score = 0;
      if (name.includes("portable")) score += 100;
      if (name.includes("setup")) score -= 25;
      if (name.includes(app.getVersion().split(".")[0])) score += 1;
      return { score, url };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  if (scored.length) return scored[0].url;
  const pageUrl = String(release?.html_url || "").trim();
  return pageUrl || "";
}

async function checkPortableUpdates() {
  const currentVersion = app.getVersion();
  setAppUpdateState({
    mode: "portable",
    status: "checking",
    checking: true,
    message: "Checking latest release from GitHub...",
    error: "",
  });

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_REPO_OWNER)}/${encodeURIComponent(UPDATE_REPO_NAME)}/releases/latest`;
  try {
    const release = await requestJsonHttps(apiUrl, UPDATE_CHECK_TIMEOUT_MS);
    const latestVersion = String(release?.tag_name || release?.name || "")
      .trim()
      .replace(/^v/i, "");
    if (!latestVersion) {
      throw new Error("Latest release version is missing.");
    }
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    const downloadUrl = hasUpdate ? findPortableAssetUrl(release) : "";
    return setAppUpdateState({
      status: hasUpdate ? "update-available" : "up-to-date",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: hasUpdate,
      latestVersion,
      canDownload: hasUpdate && !!downloadUrl,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl,
      message: hasUpdate
        ? `Update ${latestVersion} is available. Download the new portable EXE.`
        : `You are up to date (${currentVersion}).`,
      error: "",
    });
  } catch (err) {
    return setAppUpdateState({
      status: "error",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: false,
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl: "",
      message: `Update check failed: ${err.message}`,
      error: String(err.message || "Update check failed"),
    });
  }
}

function bindAutoUpdaterEventsOnce() {
  if (appUpdateBridgeBound) return;
  appUpdateBridgeBound = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setAppUpdateState({
      mode: "installer",
      status: "checking",
      checking: true,
      message: "Checking for updates...",
      error: "",
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl: "",
    });
  });

  autoUpdater.on("update-available", (info) => {
    const latestVersion = String(info?.version || "").trim();
    setAppUpdateState({
      mode: "installer",
      status: "update-available",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: true,
      latestVersion,
      canDownload: true,
      canInstall: false,
      downloadPercent: 0,
      message: `Update ${latestVersion || "available"} found. Click Download Update.`,
      error: "",
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    const latestVersion = String(info?.version || app.getVersion()).trim();
    setAppUpdateState({
      mode: "installer",
      status: "up-to-date",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: false,
      latestVersion,
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      downloadUrl: "",
      message: `You are up to date (${app.getVersion()}).`,
      error: "",
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
    setAppUpdateState({
      mode: "installer",
      status: "downloading",
      checking: false,
      updateAvailable: true,
      canDownload: false,
      canInstall: false,
      downloadPercent: percent,
      message: `Downloading update... ${percent.toFixed(1)}%`,
      error: "",
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const latestVersion = String(info?.version || appUpdateState.latestVersion || "").trim();
    setAppUpdateState({
      mode: "installer",
      status: "downloaded",
      checking: false,
      checkedAt: Date.now(),
      updateAvailable: true,
      latestVersion,
      canDownload: false,
      canInstall: true,
      downloadPercent: 100,
      message: `Update ${latestVersion || ""} is ready. Click Restart & Install.`,
      error: "",
    });
  });

  autoUpdater.on("error", (err) => {
    const friendly = getUpdateErrorMessage(err);
    setAppUpdateState({
      mode: "installer",
      status: "error",
      checking: false,
      checkedAt: Date.now(),
      canDownload: false,
      canInstall: false,
      message: `Updater error: ${friendly}`,
      error: String(friendly || "Updater error"),
    });
  });
}

function initAppUpdater() {
  const mode = getAppUpdateMode();
  if (mode === "installer") {
    bindAutoUpdaterEventsOnce();
    try {
      autoUpdater.setFeedURL({
        provider: "generic",
        url: UPDATE_FEED_URL,
      });
      console.log("[updater] Generic feed URL:", UPDATE_FEED_URL);
    } catch (err) {
      console.warn("[updater] setFeedURL failed:", err.message);
    }
    setAppUpdateState({
      mode,
      status: "idle",
      checking: false,
      updateAvailable: false,
      latestVersion: "",
      downloadPercent: 0,
      canDownload: false,
      canInstall: false,
      downloadUrl: "",
      message: `Installer update channel ready (${UPDATE_FEED_URL}).`,
      error: "",
    }, false);
    return;
  }
  if (mode === "portable") {
    setAppUpdateState({
      mode,
      status: "idle",
      checking: false,
      updateAvailable: false,
      latestVersion: "",
      downloadPercent: 0,
      canDownload: false,
      canInstall: false,
      downloadUrl: "",
      message: "Portable mode uses manual download updates.",
      error: "",
    }, false);
    return;
  }
  setAppUpdateState({
    mode,
    status: "disabled",
    checking: false,
    updateAvailable: false,
    latestVersion: "",
    downloadPercent: 0,
    canDownload: false,
    canInstall: false,
    downloadUrl: "",
    message: "Update checks are disabled in development mode.",
    error: "",
  }, false);
}

async function checkForAppUpdates(options = {}) {
  const mode = getAppUpdateMode();
  const manual = !!options?.manual;
  if (mode === "dev") {
    return setAppUpdateState({
      mode,
      status: "disabled",
      checking: false,
      message: "Update checks are disabled in development mode.",
      error: "",
    });
  }
  if (appUpdateState.checking) {
    return buildPublicAppUpdateState();
  }
  if (mode === "portable") {
    return checkPortableUpdates();
  }
  if (mode !== "installer") {
    return setAppUpdateState({
      mode: "disabled",
      status: "disabled",
      checking: false,
      message: "Updater is unavailable for this runtime.",
      error: "",
    });
  }

  bindAutoUpdaterEventsOnce();
  try {
    if (manual) {
      setAppUpdateState({
        mode: "installer",
        status: "checking",
        checking: true,
        message: "Checking for updates...",
        error: "",
      });
    }
    await autoUpdater.checkForUpdates();
    return buildPublicAppUpdateState();
  } catch (err) {
    const friendly = getUpdateErrorMessage(err);
    return setAppUpdateState({
      mode: "installer",
      status: "error",
      checking: false,
      checkedAt: Date.now(),
      message: `Update check failed: ${friendly}`,
      error: String(friendly || "Update check failed"),
      canDownload: false,
      canInstall: false,
    });
  }
}

async function downloadAppUpdate() {
  const mode = getAppUpdateMode();
  if (mode === "portable") {
    let url = String(appUpdateState.downloadUrl || "").trim();
    if (!url) {
      await checkPortableUpdates();
      url = String(appUpdateState.downloadUrl || "").trim();
    }
    if (!url) {
      return { ok: false, error: "No download URL found for latest portable release.", state: buildPublicAppUpdateState() };
    }
    try {
      await shell.openExternal(url);
      setAppUpdateState({
        mode: "portable",
        message: "Opened latest release download page.",
      });
      return { ok: true, state: buildPublicAppUpdateState(), openedUrl: url };
    } catch (err) {
      setAppUpdateState({
        mode: "portable",
        status: "error",
        message: `Unable to open download URL: ${err.message}`,
        error: String(err.message || "Unable to open download URL"),
      });
      return { ok: false, error: err.message, state: buildPublicAppUpdateState() };
    }
  }

  if (mode !== "installer") {
    return { ok: false, error: "Updater is unavailable in this runtime mode.", state: buildPublicAppUpdateState() };
  }
  if (!appUpdateState.updateAvailable) {
    return { ok: false, error: "No update is available to download.", state: buildPublicAppUpdateState() };
  }
  if (appUpdateState.canInstall) {
    return { ok: true, state: buildPublicAppUpdateState() };
  }
  try {
    setAppUpdateState({
      mode: "installer",
      status: "downloading",
      checking: false,
      canDownload: false,
      canInstall: false,
      downloadPercent: 0,
      message: "Downloading update...",
      error: "",
    });
    await autoUpdater.downloadUpdate();
    return { ok: true, state: buildPublicAppUpdateState() };
  } catch (err) {
    setAppUpdateState({
      mode: "installer",
      status: "error",
      checking: false,
      canDownload: false,
      canInstall: false,
      message: `Download failed: ${err.message}`,
      error: String(err.message || "Download failed"),
    });
    return { ok: false, error: err.message, state: buildPublicAppUpdateState() };
  }
}

async function installAppUpdateNow() {
  const mode = getAppUpdateMode();
  if (mode !== "installer") {
    return { ok: false, error: "Install is only available for installer builds.", state: buildPublicAppUpdateState() };
  }
  if (!appUpdateState.canInstall) {
    return { ok: false, error: "No downloaded update is ready to install.", state: buildPublicAppUpdateState() };
  }
  setAppUpdateState({
    mode: "installer",
    status: "installing",
    message: "Restarting app to install update...",
    checking: false,
  });
  setTimeout(() => {
    try {
      allowMainWindowClose = true;
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      setAppUpdateState({
        mode: "installer",
        status: "error",
        message: `Install failed: ${err.message}`,
        error: String(err.message || "Install failed"),
      });
    }
  }, 150);
  return { ok: true, state: buildPublicAppUpdateState() };
}

function scheduleAutoUpdateCheck() {
  if (appUpdateAutoCheckStarted) return;
  appUpdateAutoCheckStarted = true;
  const mode = getAppUpdateMode();
  if (mode === "dev") return;
  appUpdateAutoCheckTimer = setTimeout(() => {
    checkForAppUpdates({ manual: false }).catch((err) => {
      console.warn("[updater] startup update check failed:", err.message);
    });
  }, 8000);
  if (appUpdateAutoCheckTimer && typeof appUpdateAutoCheckTimer.unref === "function") {
    appUpdateAutoCheckTimer.unref();
  }
}

function getUpdateErrorMessage(err) {
  const raw = String(err?.message || err || "Update check failed");
  const lower = raw.toLowerCase();
  const has404 = lower.includes(" 404") || lower.includes("http 404") || lower.includes("status code 404");
  const feedBlocked = lower.includes("releases.atom") || lower.includes("latest.yml") || lower.includes("/releases/latest/download");
  if (has404 && feedBlocked) {
    return [
      "Update feed returned 404 (not publicly reachable).",
      "Ensure this repo release feed is public and has latest.yml + setup artifacts.",
      "If private, set ADSI_UPDATE_FEED_URL to a public generic feed URL.",
    ].join(" ");
  }
  if (has404) {
    return "Update feed returned 404. Verify publish URL and release assets.";
  }
  return raw;
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.inverter.dashboard");
  }
  app.setName("ADSI Inverter Dashboard");
  migrateLegacyUserDataIfNeeded();
  initAppUpdater();
  // Remove default app menu (File/Edit/View/Window/Help) while keeping native window chrome.
  Menu.setApplicationMenu(null);
  const licensed = await ensureLicenseAtStartup();
  if (!licensed) {
    app.exit(0);
    return;
  }
  startLicenseChecker();
  showLoginWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length !== 0) return;
  const status = buildLicensePublicStatus();
  if (!status.valid) {
    const ok = await ensureLicenseAtStartup();
    if (!ok) {
      app.exit(0);
      return;
    }
  }
  startLicenseChecker();
  if (!hasAuthenticated) {
    showLoginWindow();
    return;
  }
  if (serverReadyFired) createMainWindow();
  else if (bootStarted) showLoadingWindow();
});

app.on("before-quit", () => {
  allowMainWindowClose = true;
  isAppShuttingDown = true;
  if (appUpdateAutoCheckTimer) {
    clearTimeout(appUpdateAutoCheckTimer);
    appUpdateAutoCheckTimer = null;
  }
  if (licenseCheckerTimer) {
    clearInterval(licenseCheckerTimer);
    licenseCheckerTimer = null;
  }
  // Embedded mode (packaged): server runs in-process — call its shutdown directly.
  if (embeddedServerModule && typeof embeddedServerModule.shutdownEmbedded === "function") {
    try { embeddedServerModule.shutdownEmbedded(); } catch (_) {}
  }
  killServer();
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// ─── Loading Window ───────────────────────────────────────────────────────────
function showLoadingWindow() {
  if (loadingWin && !loadingWin.isDestroyed()) {
    focusWindow(loadingWin);
    return;
  }
  loadingWin = new BrowserWindow({
    width: 600,
    height: 720,
    minWidth: 600,
    minHeight: 500,
    useContentSize: true,
    title: "ADSI Inverter Dashboard",
    icon: APP_ICON,
    frame: false,
    resizable: false,
    autoHideMenuBar: true,
    // No alwaysOnTop: loading should be visible during startup but must not trap
    // clicks on other OS windows (e.g. the user's taskbar or other apps).
    center: true,
    backgroundColor: "#07111e",
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: true },
  });
  loadingWin.loadFile(path.join(PUBLIC_DIR, "loading.html"));
  loadingWin.show();
}

function registerShortcutsOnce() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;
  const safeRegister = (accelerator, handler) => {
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) console.warn(`[main] Failed to register shortcut: ${accelerator}`);
    } catch (err) {
      console.warn(`[main] Shortcut error (${accelerator}):`, err.message);
    }
  };
  const withFocusedWebContents = (fn) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    fn(wc);
  };
  const adjustZoom = (delta) => {
    withFocusedWebContents((wc) => {
      const current = Number(wc.getZoomFactor?.() || 1);
      const next = Math.max(0.5, Math.min(3, current + delta));
      wc.setZoomFactor(next);
    });
  };
  const resetZoom = () => {
    withFocusedWebContents((wc) => {
      wc.setZoomFactor(1);
    });
  };

  globalShortcut.register("Control+T", () => {
    const focused = BrowserWindow.getFocusedWindow() || mainWin || null;
    openTopologyWindowGuarded(focused).catch((err) => {
      console.warn("[main] topology shortcut guard failed:", err.message);
    });
  });
  globalShortcut.register("Control+I", () => {
    const focused = BrowserWindow.getFocusedWindow() || mainWin || null;
    openIpConfigWindowGuarded(focused).catch((err) => {
      console.warn("[main] ip-config shortcut guard failed:", err.message);
    });
  });
  // Native Electron zoom shortcuts (Cmd/Ctrl + / - / 0).
  safeRegister("CommandOrControl+=", () => adjustZoom(0.1));
  safeRegister("CommandOrControl+Plus", () => adjustZoom(0.1));
  safeRegister("CommandOrControl+numadd", () => adjustZoom(0.1));
  safeRegister("CommandOrControl+-", () => adjustZoom(-0.1));
  safeRegister("CommandOrControl+numsub", () => adjustZoom(-0.1));
  safeRegister("CommandOrControl+0", resetZoom);
}

function showLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) {
    focusWindow(loginWin);
    return;
  }
  loginWin = new BrowserWindow({
    width: 500,
    height: 540,
    minWidth: 500,
    minHeight: 540,
    icon: APP_ICON,
    frame: true,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: "#102029",
    center: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-login.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  loginWin.loadFile(path.join(PUBLIC_DIR, "login.html")).catch((err) => {
    console.error("[main] load login error:", err.message);
  });
  loginWin.once("ready-to-show", () => {
    focusWindow(loginWin);
    broadcastLicenseStatus(true);
  });
  loginWin.on("closed", () => {
    loginWin = null;
    if (!hasAuthenticated) quit();
  });
}

function startAfterLogin() {
  if (bootStarted) return;
  bootStarted = true;
  showLoadingWindow();
  startServer();
}

function hashText(v) {
  return crypto.createHash("sha256").update(String(v || ""), "utf8").digest("hex");
}

function getAuthStoreDir() {
  const dir = path.join(app.getPath("userData"), "auth");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLoginCredPath() {
  return path.join(getAuthStoreDir(), "login-credentials.json");
}

function getRememberPath() {
  return path.join(getAuthStoreDir(), "user-remember.json");
}

function defaultLoginCredentials() {
  // Deterministic defaults so installer/portable behave the same on every device.
  const initFile = path.join(getAuthStoreDir(), "initial-password.txt");
  try {
    fs.writeFileSync(
      initFile,
      `Initial Username: ${DEFAULT_LOGIN_USERNAME}\nInitial Password: ${DEFAULT_LOGIN_PASSWORD}\nAdmin Auth Key: ${LOGIN_ADMIN_AUTH_KEY}\nChange these after first login.\n`,
      "utf8",
    );
  } catch (err) {
    console.error("[auth] initial password file write failed:", err.message);
  }
  return {
    username: DEFAULT_LOGIN_USERNAME,
    passwordHash: hashText(DEFAULT_LOGIN_PASSWORD),
  };
}

function loadLoginCredentials() {
  const p = getLoginCredPath();
  try {
    if (!fs.existsSync(p)) {
      const def = defaultLoginCredentials();
      fs.writeFileSync(p, JSON.stringify(def, null, 2), "utf8");
      return def;
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const username = String(raw?.username || "admin").trim() || "admin";
    const passwordHash = String(raw?.passwordHash || "");
    if (!/^[a-f0-9]{64}$/i.test(passwordHash)) {
      const def = defaultLoginCredentials();
      fs.writeFileSync(p, JSON.stringify(def, null, 2), "utf8");
      return def;
    }
    return { username, passwordHash };
  } catch (err) {
    console.error("[auth] credentials load failed:", err.message);
    const def = defaultLoginCredentials();
    try {
      fs.writeFileSync(p, JSON.stringify(def, null, 2), "utf8");
    } catch (writeErr) {
      console.error("[auth] credentials write failed:", writeErr.message);
    }
    return def;
  }
}

function saveLoginCredentials(username, password) {
  const p = getLoginCredPath();
  const safe = {
    username: String(username || "").trim(),
    passwordHash: hashText(password),
  };
  fs.writeFileSync(p, JSON.stringify(safe, null, 2), "utf8");
}

function verifyLogin(username, password) {
  const creds = loadLoginCredentials();
  return String(username || "").trim() === creds.username && hashText(password) === creds.passwordHash;
}

function loadRememberedLogin() {
  const p = getRememberPath();
  try {
    if (!fs.existsSync(p)) return { remember: false };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw?.remember) return { remember: false };
    const username = String(raw?.username || "");
    let password = null;
    if (raw.enc) {
      // Encrypted format (current)
      password = decryptText(raw.enc);
    } else if (raw.password) {
      // Legacy base64 format — decrypt and migrate to encrypted format
      password = Buffer.from(String(raw.password), "base64").toString("utf8");
      if (password) saveRememberedLogin({ username, password, remember: true });
    }
    if (!password) return { remember: false };
    return { remember: true, username, password };
  } catch (err) {
    console.error("[auth] load remembered failed:", err.message);
    return { remember: false };
  }
}

function saveRememberedLogin(payload) {
  const p = getRememberPath();
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  const remember = !!payload?.remember;
  if (!remember) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  const body = { username, enc: encryptText(password), remember: true };
  fs.writeFileSync(p, JSON.stringify(body, null, 2), "utf8");
}

function clearRememberedLogin() {
  const p = getRememberPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function parseDateMs(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  const d = new Date(String(v));
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function parseLicenseExpiryMs(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  const raw = String(v || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = new Date(`${raw}T23:59:59.999`).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function readWindowsMachineGuid() {
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const line = String(out || "")
      .split(/\r?\n/)
      .find((ln) => /MachineGuid/i.test(ln) && /REG_/i.test(ln));
    if (!line) return "";
    const parts = line.trim().split(/\s+/);
    return String(parts[parts.length - 1] || "").trim();
  } catch (_) {
    return "";
  }
}

function readRegistryValue(regPath, valueName) {
  try {
    const out = execFileSync(
      "reg",
      ["query", regPath, "/v", valueName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const line = String(out || "")
      .split(/\r?\n/)
      .find((ln) => ln.includes(valueName) && /REG_/i.test(ln));
    if (!line) return "";
    const parts = line.trim().split(/\s+/);
    const typeIdx = parts.findIndex((part) => /^REG_/i.test(part));
    if (typeIdx < 0) return "";
    return String(parts.slice(typeIdx + 1).join(" ") || "").trim();
  } catch (_) {
    return "";
  }
}

function writeRegistryValue(regPath, valueName, value) {
  try {
    execFileSync(
      "reg",
      ["add", regPath, "/v", valueName, "/t", "REG_SZ", "/d", String(value || ""), "/f"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
    );
    return true;
  } catch (_) {
    return false;
  }
}

function deleteRegistryValue(regPath, valueName) {
  try {
    execFileSync(
      "reg",
      ["delete", regPath, "/v", valueName, "/f"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
    );
    return true;
  } catch (_) {
    return false;
  }
}

function pickEarliestTimestamp(...values) {
  const items = values
    .map((v) => parseDateMs(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!items.length) return null;
  return Math.min(...items);
}

function loadLicenseRegistryMarker() {
  return {
    deviceFingerprint: String(readRegistryValue(LICENSE_REG_PATH, "DeviceFingerprint") || "").trim(),
    firstInstallAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "FirstInstallAt")),
    trialAcceptedAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "TrialAcceptedAt")),
    trialExpiresAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "TrialExpiresAt")),
    licenseFingerprint: String(readRegistryValue(LICENSE_REG_PATH, "LicenseFingerprint") || "").trim(),
    licenseActivatedAt: parseDateMs(readRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt")),
    licenseExpiresAt: parseLicenseExpiryMs(readRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt")),
    licenseType: String(readRegistryValue(LICENSE_REG_PATH, "LicenseType") || "").trim().toLowerCase(),
    licenseLifetime: String(readRegistryValue(LICENSE_REG_PATH, "LicenseLifetime") || "").trim() === "1",
  };
}

function saveLicenseRegistryMarker(state) {
  const fp = String(state?.deviceFingerprint || getDeviceFingerprint()).trim();
  if (fp) writeRegistryValue(LICENSE_REG_PATH, "DeviceFingerprint", fp);

  const firstInstallAt = parseDateMs(state?.firstInstallAt);
  if (Number.isFinite(firstInstallAt) && firstInstallAt > 0) {
    writeRegistryValue(LICENSE_REG_PATH, "FirstInstallAt", String(firstInstallAt));
  }

  const trialAcceptedAt = parseDateMs(state?.trialAcceptedAt);
  if (Number.isFinite(trialAcceptedAt) && trialAcceptedAt > 0) {
    writeRegistryValue(LICENSE_REG_PATH, "TrialAcceptedAt", String(trialAcceptedAt));
  }

  const trialExpiresAt = parseDateMs(state?.trialExpiresAt);
  if (Number.isFinite(trialExpiresAt) && trialExpiresAt > 0) {
    writeRegistryValue(LICENSE_REG_PATH, "TrialExpiresAt", String(trialExpiresAt));
  }

  const lic = normalizeStoredLicense(state?.license);
  if (lic?.fingerprint) {
    writeRegistryValue(LICENSE_REG_PATH, "LicenseFingerprint", lic.fingerprint);
    writeRegistryValue(LICENSE_REG_PATH, "LicenseLifetime", lic.lifetime ? "1" : "0");
    if (lic.type) writeRegistryValue(LICENSE_REG_PATH, "LicenseType", lic.type);
    else deleteRegistryValue(LICENSE_REG_PATH, "LicenseType");

    const activatedAt = parseDateMs(lic.activatedAt);
    if (Number.isFinite(activatedAt) && activatedAt > 0) {
      writeRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt", String(activatedAt));
    } else {
      deleteRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt");
    }

    const expiresAt = parseLicenseExpiryMs(lic.expiresAt);
    if (!lic.lifetime && Number.isFinite(expiresAt) && expiresAt > 0) {
      writeRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt", String(expiresAt));
    } else {
      deleteRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt");
    }
    return;
  }

  deleteRegistryValue(LICENSE_REG_PATH, "LicenseFingerprint");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseActivatedAt");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseExpiresAt");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseType");
  deleteRegistryValue(LICENSE_REG_PATH, "LicenseLifetime");
}

// ─── Credential Encryption ─────────────────────────────────────────────────
// Derive a machine-bound AES key so remembered passwords are unreadable outside this device.
function deriveEncryptionKey() {
  const machineGuid = readWindowsMachineGuid();
  const seed = `adsi-remember-v1-${machineGuid}-${process.platform}`;
  return crypto.createHash("sha256").update(seed, "utf8").digest();
}

function encryptText(plaintext) {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString("hex"), tag: tag.toString("hex"), data: encrypted.toString("hex") });
}

function decryptText(encoded) {
  try {
    const obj = JSON.parse(String(encoded || ""));
    if (!obj || obj.v !== 1) return null;
    const key = deriveEncryptionKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(obj.iv, "hex"));
    decipher.setAuthTag(Buffer.from(obj.tag, "hex"));
    return decipher.update(Buffer.from(obj.data, "hex")).toString("utf8") + decipher.final("utf8");
  } catch (err) {
    return null;
  }
}

// Return fixed login-page admin auth key.
function getAdminAuthKey() {
  const key = LOGIN_ADMIN_AUTH_KEY;
  const p = path.join(getAuthStoreDir(), "admin-key.json");
  try {
    fs.writeFileSync(p, JSON.stringify({ key }, null, 2), "utf8");
    const infoFile = path.join(getAuthStoreDir(), "admin-key.txt");
    fs.writeFileSync(infoFile, `Admin Auth Key: ${key}\nStore this securely. You need it to change credentials.\n`, "utf8");
  } catch (err) {
    console.error("[auth] admin key save failed:", err.message);
  }
  return key;
}

function getDeviceFingerprint() {
  const machineGuid = readWindowsMachineGuid();
  const base = [
    machineGuid || "no-machine-guid",
    process.env.COMPUTERNAME || "",
    process.platform,
    process.arch,
  ].join("|");
  return crypto.createHash("sha256").update(base, "utf8").digest("hex");
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${pairs.join(",")}}`;
}

function stripLicenseSignature(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const clone = { ...payload };
  delete clone.signature;
  delete clone._signature;
  delete clone.sig;
  return clone;
}

function buildLicensePayloadFingerprint(payload) {
  const canonical = stableStringify(stripLicenseSignature(payload));
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function extractLicenseSignature(payload) {
  if (!payload || typeof payload !== "object") return null;

  if (payload.signature && typeof payload.signature === "object") {
    const sigObj = payload.signature;
    const value = String(sigObj.value || sigObj.signature || sigObj.sig || "").trim();
    if (!value) return null;
    const alg = String(sigObj.alg || sigObj.algorithm || "RSA-SHA256").trim().toUpperCase();
    const kid = String(sigObj.kid || sigObj.keyId || "").trim();
    return { value, alg, kid };
  }

  if (payload._signature && typeof payload._signature === "object") {
    const sigObj = payload._signature;
    const value = String(sigObj.value || sigObj.signature || sigObj.sig || "").trim();
    if (!value) return null;
    const alg = String(sigObj.alg || sigObj.algorithm || "RSA-SHA256").trim().toUpperCase();
    const kid = String(sigObj.kid || sigObj.keyId || "").trim();
    return { value, alg, kid };
  }

  const flat = String(payload.signature || payload.sig || "").trim();
  if (!flat) return null;
  return { value: flat, alg: "RSA-SHA256", kid: "" };
}

function loadLicensePublicKeys() {
  const out = [];
  const addKey = (pem, source) => {
    const key = String(pem || "").trim();
    if (!key) return;
    if (!/BEGIN (RSA )?PUBLIC KEY/.test(key)) return;
    out.push({ key, source: String(source || "unknown") });
  };

  addKey(LICENSE_PUBLIC_KEY_PEM, "env:ADSI_LICENSE_PUBLIC_KEY");

  if (LICENSE_PUBLIC_KEY_PATH) {
    try {
      addKey(fs.readFileSync(path.resolve(LICENSE_PUBLIC_KEY_PATH), "utf8"), "env:ADSI_LICENSE_PUBLIC_KEY_PATH");
    } catch (err) {
      console.warn("[license] failed to read configured public key path:", err.message);
    }
  } else {
    const defaultPath = path.join(LICENSE_DIR, "public-key.pem");
    if (fs.existsSync(defaultPath)) {
      try {
        addKey(fs.readFileSync(defaultPath, "utf8"), defaultPath);
      } catch (err) {
        console.warn("[license] failed to read default public key path:", err.message);
      }
    }
  }

  return out;
}

function verifyLicenseSignature(payload) {
  const sig = extractLicenseSignature(payload);
  if (!sig) {
    if (LICENSE_REQUIRE_SIGNATURE) {
      return { ok: false, error: "License signature is required." };
    }
    return { ok: true, verified: false, missing: true, kid: "", alg: "" };
  }

  if (sig.alg && sig.alg !== "RSA-SHA256") {
    return { ok: false, error: `Unsupported signature algorithm: ${sig.alg}` };
  }

  const publicKeys = loadLicensePublicKeys();
  if (!publicKeys.length) {
    return { ok: false, error: "License signature found but no public key is configured." };
  }

  const unsignedPayload = stripLicenseSignature(payload);
  const canonical = stableStringify(unsignedPayload);
  const data = Buffer.from(canonical, "utf8");
  let signatureBuffer = null;
  try {
    signatureBuffer = Buffer.from(sig.value, "base64");
  } catch (_) {
    return { ok: false, error: "License signature is not valid base64." };
  }
  if (!signatureBuffer || !signatureBuffer.length) {
    return { ok: false, error: "License signature is empty." };
  }

  for (const pub of publicKeys) {
    try {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(data);
      verifier.end();
      const valid = verifier.verify(pub.key, signatureBuffer);
      if (valid) {
        return {
          ok: true,
          verified: true,
          missing: false,
          kid: sig.kid || "",
          alg: sig.alg || "RSA-SHA256",
          source: pub.source,
        };
      }
    } catch (err) {
      console.warn("[license] signature verify failed with key:", pub.source, err.message);
    }
  }

  return { ok: false, error: "License signature verification failed." };
}

function normalizeStoredLicense(value) {
  if (!value || typeof value !== "object") return null;
  const fingerprint = String(value.fingerprint || value.identity || "").trim();
  const activatedAt = parseDateMs(value.activatedAt);
  const expiresAt = parseLicenseExpiryMs(value.expiresAt);
  const rawType = String(value.type || "").trim().toLowerCase();
  const lifetime = !!value.lifetime || rawType === "lifetime";
  return {
    ...value,
    fingerprint,
    activatedAt: Number.isFinite(activatedAt) && activatedAt > 0 ? Math.trunc(activatedAt) : null,
    expiresAt: !lifetime && Number.isFinite(expiresAt) && expiresAt > 0 ? Math.trunc(expiresAt) : null,
    type: lifetime ? "lifetime" : rawType,
    lifetime,
    metadata: value.metadata && typeof value.metadata === "object" ? { ...value.metadata } : {},
  };
}

function buildRegistryLicenseSnapshot(regState) {
  const fingerprint = String(regState?.licenseFingerprint || "").trim();
  if (!fingerprint) return null;
  return normalizeStoredLicense({
    fingerprint,
    activatedAt: regState?.licenseActivatedAt,
    expiresAt: regState?.licenseExpiresAt,
    type: regState?.licenseType || "",
    lifetime: !!regState?.licenseLifetime,
    metadata: {},
  });
}

function mergeLicenseRecords(primary, secondary) {
  const a = normalizeStoredLicense(primary);
  const b = normalizeStoredLicense(secondary);
  if (!a) return b;
  if (!b) return a;
  if (a.fingerprint && b.fingerprint && a.fingerprint !== b.fingerprint) return a;
  return normalizeStoredLicense({
    ...b,
    ...a,
    fingerprint: a.fingerprint || b.fingerprint || "",
    activatedAt: pickEarliestTimestamp(a.activatedAt, b.activatedAt) || a.activatedAt || b.activatedAt || null,
    expiresAt:
      a.lifetime || b.lifetime
        ? null
        : pickEarliestTimestamp(a.expiresAt, b.expiresAt) || a.expiresAt || b.expiresAt || null,
    type: a.type || b.type || "",
    lifetime: !!(a.lifetime || b.lifetime),
    metadata: {
      ...(b.metadata && typeof b.metadata === "object" ? b.metadata : {}),
      ...(a.metadata && typeof a.metadata === "object" ? a.metadata : {}),
    },
  });
}

function resolveLicenseActivationAnchor(priorLicense, nextFingerprint, durationMs) {
  const prior = normalizeStoredLicense(priorLicense);
  if (!prior || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  if (prior.fingerprint && nextFingerprint && prior.fingerprint !== nextFingerprint) return null;
  const activatedAt = parseDateMs(prior.activatedAt);
  if (Number.isFinite(activatedAt) && activatedAt > 0) return Math.trunc(activatedAt);
  const expiresAt = parseLicenseExpiryMs(prior.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    return Math.trunc(expiresAt - durationMs);
  }
  return null;
}

function tryRestoreMirroredLicense(priorLicense) {
  try {
    if (!fs.existsSync(LICENSE_FILE_MIRROR)) return null;
    const raw = fs.readFileSync(LICENSE_FILE_MIRROR, "utf8").replace(/^\uFEFF/, "");
    const payload = JSON.parse(raw);
    const normalized = normalizeLicensePayload(payload, LICENSE_FILE_MIRROR, priorLicense);
    return normalized.ok ? normalized.license : null;
  } catch (err) {
    console.warn("[license] mirror restore failed:", err.message);
    return null;
  }
}

function resolvePersistedLicense(rawLicense, regState) {
  const regLicense = buildRegistryLicenseSnapshot(regState);
  const merged = mergeLicenseRecords(rawLicense, regLicense);
  if (merged?.fingerprint) return { license: merged, restoredFromMirror: false };
  const restored = tryRestoreMirroredLicense(merged || regLicense);
  if (!restored) return { license: merged, restoredFromMirror: false };
  return {
    license: mergeLicenseRecords(restored, merged),
    restoredFromMirror: true,
  };
}

function defaultLicenseState() {
  return {
    schema: 1,
    deviceFingerprint: getDeviceFingerprint(),
    firstInstallAt: Date.now(),
    trialAcceptedAt: null,
    trialExpiresAt: null,
    license: null,
    audit: [],
  };
}

function normalizeLicenseAudit(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const ts = parseDateMs(e.ts) || Date.now();
    const action = String(e.action || "").trim();
    if (!action) continue;
    out.push({
      ts,
      action,
      level: String(e.level || "info"),
      details: String(e.details || ""),
    });
  }
  out.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  return out.slice(0, 500);
}

function loadLicenseState() {
  ensureDir(LICENSE_DIR);
  const regState = loadLicenseRegistryMarker();
  try {
    if (!fs.existsSync(LICENSE_STATE_PATH)) {
      const resolved = resolvePersistedLicense(null, regState);
      const def = defaultLicenseState();
      const state = {
        ...def,
        deviceFingerprint: String(regState.deviceFingerprint || def.deviceFingerprint),
        firstInstallAt: pickEarliestTimestamp(regState.firstInstallAt, def.firstInstallAt) || def.firstInstallAt,
        trialAcceptedAt: pickEarliestTimestamp(regState.trialAcceptedAt),
        trialExpiresAt: pickEarliestTimestamp(regState.trialExpiresAt),
        license: resolved.license,
      };
      state.audit = normalizeLicenseAudit([
        {
          ts: Date.now(),
          action: "install_initialized",
          level: "info",
          details: "License state created on this device.",
        },
        ...(resolved.restoredFromMirror
          ? [
              {
                ts: Date.now(),
                action: "license_restored",
                level: "success",
                details: "Recovered current license from the mirrored license file.",
              },
            ]
          : []),
      ]);
      fs.writeFileSync(LICENSE_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
      saveLicenseRegistryMarker(state);
      licenseStateCache = state;
      return state;
    }
    const raw = JSON.parse(fs.readFileSync(LICENSE_STATE_PATH, "utf8"));
    const resolved = resolvePersistedLicense(raw?.license, regState);
    const def = defaultLicenseState();
    const state = {
      schema: Number(raw?.schema || 1),
      deviceFingerprint: String(regState.deviceFingerprint || raw?.deviceFingerprint || def.deviceFingerprint),
      firstInstallAt: pickEarliestTimestamp(raw?.firstInstallAt, regState.firstInstallAt, def.firstInstallAt) || def.firstInstallAt,
      trialAcceptedAt: pickEarliestTimestamp(raw?.trialAcceptedAt, regState.trialAcceptedAt),
      trialExpiresAt: pickEarliestTimestamp(raw?.trialExpiresAt, regState.trialExpiresAt),
      license: resolved.license,
      audit: normalizeLicenseAudit([
        ...(resolved.restoredFromMirror
          ? [
              {
                ts: Date.now(),
                action: "license_restored",
                level: "success",
                details: "Recovered current license from the mirrored license file.",
              },
            ]
          : []),
        ...(Array.isArray(raw?.audit) ? raw.audit : []),
      ]),
    };
    fs.writeFileSync(LICENSE_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    saveLicenseRegistryMarker(state);
    licenseStateCache = state;
    return state;
  } catch (err) {
    console.error("[license] state load failed:", err.message);
    const resolved = resolvePersistedLicense(null, regState);
    const def = defaultLicenseState();
    const state = {
      ...def,
      deviceFingerprint: String(regState.deviceFingerprint || def.deviceFingerprint),
      firstInstallAt: pickEarliestTimestamp(regState.firstInstallAt, def.firstInstallAt) || def.firstInstallAt,
      trialAcceptedAt: pickEarliestTimestamp(regState.trialAcceptedAt),
      trialExpiresAt: pickEarliestTimestamp(regState.trialExpiresAt),
      license: resolved.license,
      audit: normalizeLicenseAudit(
        [
          {
            ts: Date.now(),
            action: "state_reinitialized",
            level: "warning",
            details: `License state was reinitialized after a read error: ${err.message}`,
          },
          ...(resolved.restoredFromMirror
            ? [
                {
                  ts: Date.now(),
                  action: "license_restored",
                  level: "success",
                  details: "Recovered current license from the mirrored license file.",
                },
              ]
            : []),
        ],
      ),
    };
    try {
      fs.writeFileSync(LICENSE_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
      saveLicenseRegistryMarker(state);
    } catch (writeErr) {
      console.error("[license] fallback state write failed:", writeErr.message);
    }
    licenseStateCache = state;
    return state;
  }
}

function saveLicenseState(state) {
  ensureDir(LICENSE_DIR);
  state.audit = normalizeLicenseAudit(state.audit);
  // Write to a temp file then atomically rename to avoid corruption on crash.
  const tmpPath = LICENSE_STATE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, LICENSE_STATE_PATH);
  saveLicenseRegistryMarker(state);
  licenseStateCache = state;
}

function appendLicenseAudit(action, details = "", level = "info") {
  try {
    const state = licenseStateCache || loadLicenseState();
    const row = {
      ts: Date.now(),
      action: String(action || "event"),
      details: String(details || ""),
      level: String(level || "info"),
    };
    const next = [row, ...(Array.isArray(state.audit) ? state.audit : [])].slice(0, 500);
    state.audit = next;
    saveLicenseState(state);
  } catch (err) {
    console.error("[license] audit append failed:", err.message);
  }
}

function getLicenseAuditRows() {
  const state = licenseStateCache || loadLicenseState();
  return normalizeLicenseAudit(state.audit);
}

function normalizeLicensePayload(payload, sourcePath, priorLicense = null) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "License file must contain a JSON object." };
  }

  const signatureCheck = verifyLicenseSignature(payload);
  if (!signatureCheck.ok) {
    return { ok: false, error: signatureCheck.error || "License signature is invalid." };
  }

  const now = Date.now();
  const prior = normalizeStoredLicense(priorLicense);
  const fp = getDeviceFingerprint();
  const boundDevice = String(
    payload.deviceFingerprint ||
      payload.device_id ||
      payload.deviceId ||
      payload.machineHash ||
      payload.machine_id ||
      payload.machineId ||
      "",
  ).trim();
  if (boundDevice && boundDevice !== fp) {
    return { ok: false, error: "License file is bound to a different device." };
  }

  const rawType = String(
    payload.type || payload.licenseType || payload.mode || "",
  ).toLowerCase().trim();
  const lifetime = Boolean(payload.lifetime) || ["lifetime", "perpetual", "forever"].includes(rawType);

  const durationDays = Number(
    payload.duration_days ?? payload.durationDays ?? payload.days ?? payload.validDays ?? NaN,
  );
  const durationHours = Number(payload.duration_hours ?? payload.durationHours ?? NaN);
  const durationMsField = Number(payload.duration_ms ?? payload.durationMs ?? NaN);
  const fingerprint = buildLicensePayloadFingerprint(payload);
  let durationMs = null;
  if (Number.isFinite(durationMsField) && durationMsField > 0) {
    durationMs = Math.trunc(durationMsField);
  } else if (Number.isFinite(durationHours) && durationHours > 0) {
    durationMs = Math.trunc(durationHours * 60 * 60 * 1000);
  } else if (Number.isFinite(durationDays) && durationDays > 0) {
    durationMs = Math.trunc(durationDays * 24 * 60 * 60 * 1000);
  }

  const explicitExpiry = parseLicenseExpiryMs(
    payload.expiresAt ||
      payload.expires_at ||
      payload.validUntil ||
      payload.valid_until ||
      payload.expiry ||
      payload.expiration ||
      payload.endAt ||
      payload.end_at,
  );
  const activatedAt =
    resolveLicenseActivationAnchor(prior, fingerprint, durationMs) || now;
  const expiresAt = lifetime
    ? null
    : Number.isFinite(explicitExpiry)
      ? explicitExpiry
      : Number.isFinite(durationMs)
        ? activatedAt + durationMs
        : null;

  if (!lifetime && !expiresAt) {
    return { ok: false, error: "License type is unsupported. Use lifetime, duration, or expiry datetime." };
  }
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return { ok: false, error: "License file is already expired." };
  }

  const normalized = {
    sourcePath: String(sourcePath || ""),
    importedAt: now,
    activatedAt,
    fingerprint,
    type: lifetime ? "lifetime" : Number.isFinite(durationMs) && !Number.isFinite(explicitExpiry) ? "duration" : "datetime",
    lifetime: !!lifetime,
    expiresAt: Number.isFinite(expiresAt) ? Math.trunc(expiresAt) : null,
    metadata: {
      issuedTo: payload.issuedTo || payload.customer || payload.customerName || "",
      notes: payload.notes || "",
      serial: payload.serial || payload.keyId || payload.licenseId || "",
      signatureVerified: !!signatureCheck.verified,
      signatureKid: signatureCheck.kid || "",
      signatureAlg: signatureCheck.alg || "",
      signatureSource: signatureCheck.source || "",
    },
  };

  return { ok: true, license: normalized };
}

function installLicenseFromFile(filePath) {
  try {
    const fullPath = String(filePath || "").trim();
    if (!fullPath) return { ok: false, error: "No license file selected." };
    const raw = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
    const payload = JSON.parse(raw);
    const state = loadLicenseState();
    const normalized = normalizeLicensePayload(payload, fullPath, state.license);
    if (!normalized.ok) {
      appendLicenseAudit("license_import_failed", normalized.error || "Invalid license payload.", "error");
      return normalized;
    }

    state.deviceFingerprint = getDeviceFingerprint();
    state.license = normalized.license;
    if (!state.firstInstallAt) state.firstInstallAt = Date.now();
    saveLicenseState(state);

    try {
      fs.copyFileSync(fullPath, LICENSE_FILE_MIRROR);
    } catch (err) {
      console.warn("[license] mirror copy failed:", err.message);
    }

    appendLicenseAudit(
      "license_imported",
      normalized.license.lifetime
        ? `Lifetime license imported. ${
            normalized.license?.metadata?.signatureVerified
              ? "Signature verified."
              : "Unsigned license accepted."
          }`
        : `License imported. Expires at ${new Date(normalized.license.expiresAt).toISOString()}. ${
            normalized.license?.metadata?.signatureVerified
              ? "Signature verified."
              : "Unsigned license accepted."
          }`,
      "success",
    );

    return { ok: true, path: fullPath, license: normalized.license };
  } catch (err) {
    appendLicenseAudit("license_import_failed", `File parse error: ${err.message}`, "error");
    return { ok: false, error: `Invalid license file: ${err.message}` };
  }
}

function activateTrialNow() {
  const state = loadLicenseState();
  if (state.trialAcceptedAt && state.trialExpiresAt) return state;
  const now = Date.now();
  state.deviceFingerprint = getDeviceFingerprint();
  state.firstInstallAt = state.firstInstallAt || now;
  state.trialAcceptedAt = now;
  state.trialExpiresAt = now + TRIAL_DAYS * DAY_MS;
  saveLicenseState(state);
  appendLicenseAudit(
    "trial_started",
    `7-day trial activated. Expires at ${new Date(state.trialExpiresAt).toISOString()}.`,
    "success",
  );
  return state;
}

function humanRemaining(msLeft) {
  if (!Number.isFinite(msLeft)) return "lifetime";
  const totalSec = Math.max(0, Math.floor(msLeft / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

function calcRemainingDays(msLeft) {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 0;
  return Math.max(1, Math.ceil(msLeft / DAY_MS));
}

function evaluateStoredLicenseEntitlement(license, now) {
  const lic = normalizeStoredLicense(license);
  if (!lic) return null;
  const expiresAt = parseLicenseExpiryMs(lic.expiresAt);
  if (lic.lifetime || lic.type === "lifetime") {
    return {
      valid: true,
      source: "license",
      code: "lifetime",
      lifetime: true,
      expiresAt: null,
      msLeft: Number.POSITIVE_INFINITY,
      nearExpiry: false,
      message: "Lifetime license active.",
    };
  }
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    const msLeft = expiresAt - now;
    return {
      valid: true,
      source: "license",
      code: "licensed",
      lifetime: false,
      expiresAt,
      msLeft,
      nearExpiry: msLeft <= LICENSE_WARN_MS,
      message: `License expires in ${humanRemaining(msLeft)}.`,
    };
  }
  return {
    valid: false,
    source: "license",
    code: "license_expired",
    lifetime: false,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    msLeft: 0,
    nearExpiry: false,
    message: "License expired.",
  };
}

function evaluateTrialEntitlement(state, now) {
  const trialAcceptedAt = parseDateMs(state.trialAcceptedAt);
  const trialExpiresAt = parseDateMs(state.trialExpiresAt);
  if (trialAcceptedAt && trialExpiresAt && trialExpiresAt > now) {
    const msLeft = trialExpiresAt - now;
    return {
      valid: true,
      source: "trial",
      code: "trial_active",
      lifetime: false,
      expiresAt: trialExpiresAt,
      msLeft,
      nearExpiry: msLeft <= LICENSE_WARN_MS,
      message: `Trial expires in ${humanRemaining(msLeft)}.`,
    };
  }
  if (trialAcceptedAt && trialExpiresAt && trialExpiresAt <= now) {
    return {
      valid: false,
      source: "trial",
      code: "trial_expired",
      lifetime: false,
      expiresAt: trialExpiresAt,
      msLeft: 0,
      nearExpiry: false,
      message: "Trial expired.",
    };
  }
  return {
    valid: false,
    source: "trial",
    code: "trial_not_started",
    lifetime: false,
    expiresAt: null,
    msLeft: 0,
    nearExpiry: false,
    message: "Trial has not been started.",
  };
}

function evaluateLicense(now = Date.now()) {
  const state = licenseStateCache || loadLicenseState();
  const fp = getDeviceFingerprint();
  const mismatch = String(state.deviceFingerprint || "") !== String(fp || "");
  if (mismatch) {
    return {
      valid: false,
      source: "device",
      code: "device_mismatch",
      expiresAt: null,
      msLeft: 0,
      nearExpiry: false,
      message: "License storage belongs to another device fingerprint.",
    };
  }

  const licenseStatus = evaluateStoredLicenseEntitlement(state.license, now);
  if (licenseStatus?.valid) return licenseStatus;
  const trialStatus = evaluateTrialEntitlement(state, now);
  if (trialStatus?.valid) return trialStatus;
  return licenseStatus || trialStatus;
}

function buildLicensePublicStatus() {
  const v = evaluateLicense();
  const expiresAt = Number.isFinite(v.expiresAt) ? v.expiresAt : null;
  const msLeft = Number.isFinite(v.msLeft) ? v.msLeft : null;
  const daysLeft = expiresAt == null ? null : calcRemainingDays(msLeft || 0);
  return {
    valid: !!v.valid,
    source: v.source || "trial",
    code: v.code || "",
    lifetime: !!v.lifetime,
    expiresAt,
    expiresAtIso: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
    msLeft,
    daysLeft,
    remainingText: v.lifetime ? "lifetime" : msLeft && msLeft > 0 ? humanRemaining(msLeft) : "",
    nearExpiry: !!v.nearExpiry,
    message: String(v.message || ""),
  };
}

function maybeSendLicenseStatus(win, status) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("license-status", status);
  } catch (err) {
    // Renderer may be destroyed — ignore send failure.
  }
}

function broadcastLicenseStatus(force = false) {
  const status = buildLicensePublicStatus();
  const signature = JSON.stringify([
    status.valid,
    status.source,
    status.code,
    status.lifetime,
    status.expiresAtIso,
    status.daysLeft,
    status.remainingText,
    status.nearExpiry,
  ]);
  if (!force && signature === lastBroadcastLicenseSignature) return status;
  lastBroadcastLicenseSignature = signature;
  [mainWin, topologyWin, ipConfigWin, loginWin].forEach((win) => maybeSendLicenseStatus(win, status));
  return status;
}

async function promptLicenseUpload(parentWin) {
  const result = await dialog.showOpenDialog(parentWin || undefined, {
    title: "Select License File",
    filters: [
      { name: "License Files", extensions: ["json", "dat", "lic"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths?.length) {
    return { ok: false, canceled: true };
  }
  return installLicenseFromFile(result.filePaths[0]);
}

async function ensureLicenseAtStartup() {
  loadLicenseState();
  while (true) {
    const status = buildLicensePublicStatus();
    if (status.valid) return true;

    if (status.code === "trial_not_started") {
      const choice = await dialog.showMessageBox({
        type: "question",
        buttons: ["Start 7-Day Trial", "Upload License", "Exit"],
        defaultId: 0,
        cancelId: 2,
        title: "License Required",
        message: "Welcome to ADSI Inverter Dashboard",
        detail:
          "This device has not started its one-time 7-day trial yet.\n\nChoose an option to continue:\n• Start 7-day trial on this device\n• Upload a valid license file",
      });
      if (choice.response === 0) {
        activateTrialNow();
        broadcastLicenseStatus(true);
        continue;
      }
      if (choice.response === 1) {
        const uploaded = await promptLicenseUpload(loginWin || undefined);
        if (uploaded.ok) {
          broadcastLicenseStatus(true);
          continue;
        }
        if (!uploaded.canceled) {
          dialog.showErrorBox("License Error", uploaded.error || "Invalid license file.");
        }
        continue;
      }
      appendLicenseAudit("startup_blocked_exit", "User exited from initial license gate.", "warning");
      return false;
    }

    const choice = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Upload License", "Exit"],
      defaultId: 0,
      cancelId: 1,
      title: "License Expired",
      message: "Your license/trial is not valid.",
      detail: `${status.message}\n\nUpload a license to continue.`,
    });
    if (choice.response === 0) {
      const uploaded = await promptLicenseUpload(loginWin || undefined);
      if (uploaded.ok) {
        broadcastLicenseStatus(true);
        continue;
      }
      if (!uploaded.canceled) {
        dialog.showErrorBox("License Error", uploaded.error || "Invalid license file.");
      }
      continue;
    }
    appendLicenseAudit("startup_blocked_exit", `User exited on ${status.code || "invalid_license"}.`, "warning");
    return false;
  }
}

function enforceLicenseShutdown(status) {
  if (licenseShutdownTriggered || isAppShuttingDown) return;
  licenseShutdownTriggered = true;
  appendLicenseAudit(
    "runtime_expired_shutdown",
    `Runtime shutdown due to ${status?.code || "expired"} (${status?.source || "license"}).`,
    "error",
  );
  const detail =
    status?.source === "trial"
      ? "Trial/license expired while dashboard is running. Services will stop now."
      : "License expired while dashboard is running. Services will stop now.";
  dialog.showErrorBox("License Expired", `${detail}\n\nPlease upload a valid license and restart the dashboard.`);
  killServer();
  app.exit(0);
}

function handleLicenseRuntimeTick() {
  const status = broadcastLicenseStatus();
  if (!status.valid && (bootStarted || hasAuthenticated)) {
    enforceLicenseShutdown(status);
  }
}

function startLicenseChecker() {
  if (licenseCheckerTimer) return;
  handleLicenseRuntimeTick();
  licenseCheckerTimer = setInterval(handleLicenseRuntimeTick, LICENSE_CHECK_INTERVAL_MS);
}

// ─── Server Spawn (system Node, not Electron's Node) ─────────────────────────
function resolveServerEntry() {
  const candidates = [
    path.join(__dirname, "../server/index.js"),
    path.join(app.getAppPath(), "server", "index.js"),
    path.join(process.resourcesPath || "", "app.asar", "server", "index.js"),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "server", "index.js"),
    path.join(process.cwd(), "server", "index.js"),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function startEmbeddedServer(serverEntry) {
  if (embeddedServerStarted) return true;
  try {
    console.log("[main] Starting embedded web server:", serverEntry);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    embeddedServerModule = require(serverEntry);
    embeddedServerStarted = true;
    serverBootError = "";
    return true;
  } catch (err) {
    const code = String(err?.code || "").trim().toUpperCase();
    const baseMsg = String(err?.message || err || "unknown error");
    serverBootError =
      code === "EADDRINUSE"
        ? `Port ${SERVER_PORT} is already in use. Close any previous dashboard or local server process that is still bound to localhost:${SERVER_PORT}, then retry.`
        : baseMsg;
    console.error("[main] Embedded web server start failed:", serverBootError);
    return false;
  }
}

function showLoadingErrorMessage(message) {
  if (!loadingWin || loadingWin.isDestroyed()) return;
  const safeMessage = String(message || "").replace(/<br\s*\/?>/gi, "\n");
  const fallbackHtml = `<div style="font-family:Segoe UI,sans-serif;color:#ffd8df;padding:20px;text-align:center;line-height:1.6;background:#09121f">${safeMessage
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br/>")}</div>`;
  loadingWin.webContents
    .executeJavaScript(
      `if (typeof window.showStartupError === "function") {
         window.showStartupError(${JSON.stringify(safeMessage)});
       } else {
         document.body.innerHTML = ${JSON.stringify(fallbackHtml)};
       }`,
    )
    .catch(() => {});
}

function killImageNames(imageNames = []) {
  const seen = new Set();
  for (const name of imageNames) {
    const image = String(name || "").trim();
    if (!image || seen.has(image)) continue;
    seen.add(image);
    try {
      execFileSync("taskkill", ["/IM", image, "/F"], { stdio: "ignore" });
    } catch (_) {
      // Process image may not be running, ignore.
    }
  }
}

function startServer() {
  // Ensure no stale backend instances accumulate across repeated starts.
  killImageNames(LEGACY_SERVICE_IMAGE_NAMES);
  killImageNames(BACKEND_EXE_NAMES);
  killImageNames(FORECAST_EXE_NAMES);

  startBackendProcess();

  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    console.error("[main] Web server entry not found.");
    showLoadingErrorMessage("Web server entry not found.<br/>Please reinstall the dashboard.");
    return;
  }

  // Run the Express server in-process for both packaged and workspace runs.
  // This avoids stale detached dev server processes serving old backend code.
  const ok = startEmbeddedServer(serverEntry);
  if (!ok) {
    showLoadingErrorMessage(
      `Web server failed to start.<br/>${serverBootError || "Unknown startup error."}`,
    );
    return;
  }
  pollUntilReady();
}

function resolveBackendLaunch() {
  const explicit = process.env.ADSI_BACKEND_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return buildLaunch(explicit);
  }

  const exeBaseDirs = [
    path.dirname(process.execPath),
    path.join(process.resourcesPath || "", "backend"),
    process.resourcesPath || "",
    path.join(app.getAppPath(), "backend"),
    app.getAppPath(),
    process.cwd(),
  ].filter(Boolean);
  const exeCandidates = BACKEND_EXE_NAMES.flatMap((name) =>
    exeBaseDirs.map((dir) => path.join(dir, name)),
  );

  for (const p of exeCandidates) {
    if (fs.existsSync(p)) return buildLaunch(p);
  }

  const scriptBaseDirs = [app.getAppPath(), path.join(app.getAppPath(), "backend"), process.cwd()];
  const scriptCandidates = BACKEND_SCRIPT_NAMES.flatMap((name) =>
    scriptBaseDirs.map((dir) => path.join(dir, name)),
  );

  for (const p of scriptCandidates) {
    if (fs.existsSync(p)) {
      const pyCmd = process.env.PYTHON || "python";
      return { cmd: pyCmd, args: [p], cwd: path.dirname(p) };
    }
  }

  return null;
}

function resolveForecastLaunch() {
  const explicit = process.env.ADSI_FORECAST_PATH;
  if (explicit && fs.existsSync(explicit)) return buildLaunch(explicit);

  const exeBaseDirs = [
    path.dirname(process.execPath),
    path.join(process.resourcesPath || "", "backend"),
    process.resourcesPath || "",
    path.join(app.getAppPath(), "backend"),
    app.getAppPath(),
    process.cwd(),
  ].filter(Boolean);
  const exeCandidates = FORECAST_EXE_NAMES.flatMap((name) =>
    exeBaseDirs.map((dir) => path.join(dir, name)),
  );
  for (const p of exeCandidates) {
    if (fs.existsSync(p)) return buildLaunch(p);
  }

  const scriptBaseDirs = [app.getAppPath(), path.join(app.getAppPath(), "backend"), process.cwd()];
  const scriptCandidates = FORECAST_SCRIPT_NAMES.flatMap((name) =>
    scriptBaseDirs.map((dir) => path.join(dir, name)),
  );
  for (const p of scriptCandidates) {
    if (fs.existsSync(p)) {
      const pyCmd = process.env.PYTHON || "python";
      return { cmd: pyCmd, args: [p], cwd: path.dirname(p) };
    }
  }

  return null;
}

function buildLaunch(targetPath) {
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === ".py") {
    const pyCmd = process.env.PYTHON || "python";
    return { cmd: pyCmd, args: [targetPath], cwd: path.dirname(targetPath) };
  }
  return { cmd: targetPath, args: [], cwd: path.dirname(targetPath) };
}

function spawnBackendProcess(backendLaunch, logPrefix = "[main] Spawning backend:") {
  console.log(logPrefix, backendLaunch.cmd, ...backendLaunch.args);
  backendProc = spawn(backendLaunch.cmd, backendLaunch.args, {
    cwd: backendLaunch.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
    shell: false,
  });
  backendProc.on("error", (err) => {
    console.error("[main] Backend spawn error:", err.message);
  });
  backendProc.on("exit", (code, signal) => {
    console.warn("[main] Backend exited - code=" + code + " signal=" + signal);
  });
}

function spawnForecastProcess(forecastLaunch, logPrefix = "[main] Spawning forecast:") {
  lastForecastLaunch = {
    cmd: forecastLaunch.cmd,
    args: Array.isArray(forecastLaunch.args) ? [...forecastLaunch.args] : [],
    cwd: forecastLaunch.cwd,
  };
  clearForecastRestartTimer();
  forecastStopExpected = false;
  console.log(logPrefix, forecastLaunch.cmd, ...forecastLaunch.args);
  forecastProc = spawn(forecastLaunch.cmd, forecastLaunch.args, {
    cwd: forecastLaunch.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
    shell: false,
  });
  forecastProc.on("error", (err) => {
    console.error("[main] Forecast spawn error:", err.message);
    scheduleForecastRestart("spawn error");
  });
  forecastProc.on("spawn", () => {
    forecastRestartAttempts = 0;
  });
  forecastProc.on("exit", (code, signal) => {
    const expectedStop = forecastStopExpected;
    forecastStopExpected = false;
    forecastProc = null;
    if (expectedStop || isAppShuttingDown) {
      console.log("[main] Forecast stopped - code=" + code + " signal=" + signal);
      return;
    }
    console.warn("[main] Forecast exited - code=" + code + " signal=" + signal);
    scheduleForecastRestart(`exit code=${code} signal=${signal}`);
  });
}

function startBackendProcess() {
  const backendLaunch = resolveBackendLaunch();
  if (!backendLaunch) {
    console.error("[main] Backend not found. Set ADSI_BACKEND_PATH or place backend executable.");
    return false;
  }
  spawnBackendProcess(backendLaunch);
  return true;
}

function startForecastProcess() {
  if (forecastProc && !forecastProc.killed) return true;
  const launch = resolveForecastLaunch();
  if (!launch) {
    console.warn("[main] Forecast service not found. Skipping day-ahead background process.");
    return false;
  }
  spawnForecastProcess(launch);
  return true;
}

function stopForecastProcess(reason = "") {
  clearForecastRestartTimer();
  forecastRestartAttempts = 0;
  if (!forecastProc || forecastProc.killed) {
    forecastProc = null;
    return;
  }
  forecastStopExpected = true;
  if (reason) {
    console.log(`[main] Stopping forecast service (${reason})`);
  }
  forceKillProc(forecastProc, "forecast");
  forecastProc = null;
}

function clearForecastRestartTimer() {
  if (!forecastRestartTimer) return;
  clearTimeout(forecastRestartTimer);
  forecastRestartTimer = null;
}

function scheduleForecastRestart(reason) {
  if (isAppShuttingDown) return;
  if (forecastRestartTimer) return;
  if (forecastProc && !forecastProc.killed) return;

  const delay = Math.min(
    FORECAST_RESTART_MAX_MS,
    FORECAST_RESTART_BASE_MS * Math.pow(2, Math.min(forecastRestartAttempts, 5)),
  );
  forecastRestartAttempts += 1;
  console.warn(`[main] Forecast restart scheduled in ${delay}ms (${reason})`);

  forecastRestartTimer = setTimeout(() => {
    forecastRestartTimer = null;
    if (isAppShuttingDown) return;
    syncForecastProcessForCurrentMode().catch((err) => {
      console.warn("[main] Forecast restart sync failed:", err?.message || err);
    });
  }, delay);
}

function restartBackendProcess() {
  // Kill by image name first so updated ipconfig is reloaded by a clean process.
  killImageNames(BACKEND_EXE_NAMES);

  // Best effort for currently tracked process tree.
  if (backendProc && !backendProc.killed) {
    execFile("taskkill", ["/pid", String(backendProc.pid), "/f", "/t"], { stdio: "ignore" }, (err) => {
      if (err) console.warn("[main] taskkill backend pid failed:", err.message);
    });
  }
  backendProc = null;

  const backendLaunch = resolveBackendLaunch();
  if (!backendLaunch) {
    console.error("[main] Backend restart failed: launch target not found.");
    return false;
  }
  spawnBackendProcess(backendLaunch, "[main] Restarting backend:");
  return true;
}

// ─── Poll HTTP until server responds ─────────────────────────────────────────
function pollUntilReady() {
  if (serverReadyFired) return;
  const deadline = Date.now() + POLL_TIMEOUT;

  function attempt() {
    if (serverReadyFired) return;

    const req = http.get(SERVER_URL, (res) => {
      res.resume();
      onServerReady();
    });

    req.on("error", () => {
      if (Date.now() < deadline) setTimeout(attempt, POLL_INTERVAL);
      else {
        console.error("[main] Poll timed out - backend did not become ready.");
        showLoadingErrorMessage(
          "Backend startup timed out. If this is the first run after an update, database maintenance may still be finishing. Please retry.",
        );
      }
    });

    req.setTimeout(1200, () => {
      req.destroy();
      if (Date.now() < deadline) setTimeout(attempt, POLL_INTERVAL);
    });
  }

  setTimeout(attempt, 1000); // give server a 1s head-start
}

// ─── Open Main Window ─────────────────────────────────────────────────────────
function onServerReady() {
  if (serverReadyFired) return;
  serverReadyFired = true;
  registerShortcutsOnce();
  startForecastModeSync();
  console.log("[main] Server ready - opening main window");
  createMainWindow();
}

function createMainWindow() {
  mainPageLoadedOnce = false;
  initialLoadRetries = 0;
  if (initialLoadRetryTimer) {
    clearTimeout(initialLoadRetryTimer);
    initialLoadRetryTimer = null;
  }

  mainWin = new BrowserWindow({
    width: 1600,
    height: 960,
    icon: APP_ICON,
    minWidth: 1100,
    minHeight: 680,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  if (IS_DEV) {
    mainWin.webContents.openDevTools({ mode: "detach" });
  }

  loadMainUrlWithRetry();

  mainWin.webContents.on("did-finish-load", () => {
    const loadedUrl = String(mainWin?.webContents.getURL() || "");
    const isAppPage = loadedUrl.startsWith(`${SERVER_URL}/`) || loadedUrl === SERVER_URL;
    if (!isAppPage) {
      console.warn("[main] Ignoring non-app load:", loadedUrl || "(empty)");
      return;
    }
    if (!mainPageLoadedOnce) console.log("[main] Page loaded OK");
    mainPageLoadedOnce = true;
    initialLoadRetries = 0;
    if (initialLoadRetryTimer) {
      clearTimeout(initialLoadRetryTimer);
      initialLoadRetryTimer = null;
    }
    // Bring the dashboard to front BEFORE closing the loading window so there
    // is no focus vacuum that lets it slip behind other OS windows.
    mainWin.show();
    mainWin.focus();
    if (loadingWin && !loadingWin.isDestroyed()) {
      loadingWin.close();
      loadingWin = null;
    }
    broadcastLicenseStatus(true);
    broadcastAppUpdateState();
    scheduleAutoUpdateCheck();
  });

  mainWin.webContents.on("did-fail-load", (e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED during navigation is expected
    console.error("[main] did-fail-load:", code, desc);
    if (mainPageLoadedOnce) return;
    if (initialLoadRetries >= INITIAL_LOAD_RETRY_MAX) {
      console.error("[main] Initial load retries exhausted.");
      showLoadingErrorMessage(
        "Unable to connect to the local dashboard backend on localhost:3500.\nPlease verify InverterCoreService.exe and retry.",
      );
      return;
    }
    initialLoadRetries += 1;
    if (initialLoadRetryTimer) clearTimeout(initialLoadRetryTimer);
    initialLoadRetryTimer = setTimeout(() => {
      loadMainUrlWithRetry();
    }, INITIAL_LOAD_RETRY_DELAY);
  });

  mainWin.on("closed", () => {
    if (initialLoadRetryTimer) {
      clearTimeout(initialLoadRetryTimer);
      initialLoadRetryTimer = null;
    }
    mainWin = null;
    allowMainWindowClose = false;
    quit();
  });

  mainWin.on("close", (e) => {
    if (isAppShuttingDown || allowMainWindowClose) return;
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: "question",
      buttons: ["Cancel", "Exit"],
      defaultId: 0,
      cancelId: 0,
      title: "Confirm Exit",
      message: "Exit ADSI Inverter Dashboard?",
      detail: "This will stop local services and close the dashboard.",
    });
    if (choice !== 1) {
      e.preventDefault();
      return;
    }
    allowMainWindowClose = true;
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function loadMainUrlWithRetry() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const doLoad = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.loadURL(SERVER_URL).catch((err) => {
      console.error("[main] loadURL error:", err.message);
    });
  };
  if (mainWin.__cacheClearedOnce) {
    doLoad();
    return;
  }
  mainWin.__cacheClearedOnce = true;
  const ses = mainWin.webContents?.session || null;
  if (!ses) {
    doLoad();
    return;
  }
  Promise.resolve()
    .then(() => ses.clearCache())
    .then(() => ses.clearStorageData({ storages: ["cache"] }))
    .catch((err) => {
      console.warn("[main] cache clear before load failed:", err.message);
    })
    .finally(doLoad);
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openTopologyWindow() {
  if (topologyWin && !topologyWin.isDestroyed()) {
    focusWindow(topologyWin);
    return;
  }
  topologyWin = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    icon: APP_ICON,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  topologyWin.loadURL(TOPOLOGY_URL).catch((err) => {
    console.error("[main] load topology error:", err.message);
  });
  topologyWin.once("ready-to-show", () => {
    focusWindow(topologyWin);
    broadcastLicenseStatus(true);
  });
  topologyWin.on("closed", () => {
    topologyWin = null;
  });
}

function openIpConfigWindow() {
  if (ipConfigWin && !ipConfigWin.isDestroyed()) {
    focusWindow(ipConfigWin);
    return;
  }
  ipConfigWin = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    icon: APP_ICON,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#080c14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  ipConfigWin.loadURL(IP_CONFIG_URL).catch((err) => {
    console.error("[main] load ip-config error:", err.message);
  });
  ipConfigWin.once("ready-to-show", () => {
    focusWindow(ipConfigWin);
    broadcastLicenseStatus(true);
  });
  ipConfigWin.on("closed", () => {
    ipConfigWin = null;
  });
}

function requestServerJson(method, routePath, payload, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    let body = "";
    if (payload !== undefined) {
      try {
        body = JSON.stringify(payload);
      } catch (e) {
        reject(new Error("Invalid JSON payload"));
        return;
      }
    }

    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: routePath,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const status = Number(res.statusCode || 0);
          const ok = status >= 200 && status < 300;
          if (!raw) {
            if (ok) resolve({});
            else reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (ok) resolve(parsed);
            else reject(new Error(parsed?.error || `HTTP ${status}`));
          } catch (_) {
            if (ok) resolve({});
            else reject(new Error(`HTTP ${status}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

async function tryGetCurrentOperationMode(timeoutMs = 1500) {
  try {
    const settings = await requestServerJson(
      "GET",
      "/api/settings",
      undefined,
      timeoutMs,
    );
    const mode = String(settings?.operationMode || "gateway")
      .trim()
      .toLowerCase();
    return mode === "remote" ? "remote" : "gateway";
  } catch {
    return null;
  }
}

async function getCurrentOperationMode(timeoutMs = 1500) {
  return (await tryGetCurrentOperationMode(timeoutMs)) || "gateway";
}

async function syncForecastProcessForCurrentMode(timeoutMs = 1500) {
  if (isAppShuttingDown || !serverReadyFired || forecastModeSyncInFlight) {
    return false;
  }
  forecastModeSyncInFlight = true;
  try {
    const mode = await tryGetCurrentOperationMode(timeoutMs);
    if (!mode) return false;
    if (mode === "remote") {
      stopForecastProcess("remote mode active");
      return false;
    }
    return startForecastProcess();
  } finally {
    forecastModeSyncInFlight = false;
  }
}

function startForecastModeSync() {
  if (forecastModeSyncTimer) return;
  syncForecastProcessForCurrentMode().catch((err) => {
    console.warn("[main] Initial forecast mode sync failed:", err?.message || err);
  });
  forecastModeSyncTimer = setInterval(() => {
    syncForecastProcessForCurrentMode().catch((err) => {
      console.warn("[main] Forecast mode sync failed:", err?.message || err);
    });
  }, FORECAST_MODE_SYNC_MS);
}

function stopForecastModeSync() {
  if (!forecastModeSyncTimer) return;
  clearInterval(forecastModeSyncTimer);
  forecastModeSyncTimer = null;
  forecastModeSyncInFlight = false;
}

async function ensureGatewayModeForWindow(featureLabel, ownerWin) {
  const mode = await getCurrentOperationMode();
  if (mode !== "remote") return true;
  const target = ownerWin && !ownerWin.isDestroyed() ? ownerWin : mainWin || undefined;
  const detail =
    "This feature is disabled in Client mode.\nSwitch Operation Mode to Gateway in Settings to access it.";
  try {
    await dialog.showMessageBox(target, {
      type: "info",
      title: `${featureLabel} Unavailable`,
      message: `${featureLabel} is not available while running in Client mode.`,
      detail,
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    });
  } catch (_) {}
  return false;
}

async function openTopologyWindowGuarded(ownerWin) {
  const allowed = await ensureGatewayModeForWindow("Topology", ownerWin);
  if (!allowed) return false;
  openTopologyWindow();
  return true;
}

async function openIpConfigWindowGuarded(ownerWin) {
  const allowed = await ensureGatewayModeForWindow("IP Configuration", ownerWin);
  if (!allowed) return false;
  openIpConfigWindow();
  return true;
}

function getConfigPath() {
  const portableRoot = String(process.env.ADSI_PORTABLE_DATA_DIR || "").trim();
  if (portableRoot) {
    const cfgDir = path.join(portableRoot, "config");
    try {
      fs.mkdirSync(cfgDir, { recursive: true });
    } catch (_) {}
    return path.join(cfgDir, "ipconfig.json");
  }
  const cfgDir = path.join(app.getPath("userData"), "config");
  try {
    fs.mkdirSync(cfgDir, { recursive: true });
  } catch (_) {}
  return path.join(cfgDir, "ipconfig.json");
}

function defaultConfig() {
  const cfg = { inverters: {}, poll_interval: {}, units: {} };
  for (let i = 1; i <= 27; i++) {
    cfg.inverters[i] = `192.168.1.${100 + i}`;
    cfg.poll_interval[i] = 0.05;
    cfg.units[i] = [1, 2, 3, 4];
  }
  return cfg;
}

function sanitizeConfig(input) {
  const out = defaultConfig();
  const src = input && typeof input === "object" ? input : {};
  for (let i = 1; i <= 27; i++) {
    const ip = String(src?.inverters?.[i] ?? src?.inverters?.[String(i)] ?? out.inverters[i]).trim();
    const poll = Number(src?.poll_interval?.[i] ?? src?.poll_interval?.[String(i)] ?? out.poll_interval[i]);
    const unitsRaw = src?.units?.[i] ?? src?.units?.[String(i)] ?? out.units[i];
    const units = Array.isArray(unitsRaw)
      ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
      : [1, 2, 3, 4];
    out.inverters[i] = ip;
    out.poll_interval[i] = Number.isFinite(poll) && poll >= 0.01 ? poll : 0.05;
    // Preserve explicit "all nodes disabled" as an empty array.
    out.units[i] = units.length ? [...new Set(units)] : [];
  }
  return out;
}

function loadIpConfigFile() {
  const p = getConfigPath();
  try {
    if (!fs.existsSync(p)) {
      const cfg = defaultConfig();
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
      return cfg;
    }
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const cfg = sanitizeConfig(parsed);
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
    return cfg;
  } catch (err) {
    console.error("[config] load failed:", err.message);
    return defaultConfig();
  }
}

function saveIpConfigFile(cfg) {
  const p = getConfigPath();
  const safe = sanitizeConfig(cfg);
  fs.writeFileSync(p, JSON.stringify(safe, null, 2), "utf8");
  return safe;
}

function checkReachable(ip, port = 80, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle("check-login", async (_, username, password) => {
  try {
    return verifyLogin(username, password);
  } catch (err) {
    console.error("[ipc] check-login failed:", err.message);
    return false;
  }
});

ipcMain.handle("change-username-password", async (_, authKey, newUsername, newPassword) => {
  try {
    const keyOk = String(authKey || "") === getAdminAuthKey();
    const user = String(newUsername || "").trim();
    const pass = String(newPassword || "").trim();
    if (!keyOk || !user || !pass) return false;
    saveLoginCredentials(user, pass);
    clearRememberedLogin();
    return true;
  } catch (err) {
    console.error("[ipc] change-username-password failed:", err.message);
    return false;
  }
});

ipcMain.handle("reset-password", async (_, authKey) => {
  try {
    const keyOk = String(authKey || "") === getAdminAuthKey();
    if (!keyOk) return false;
    const def = defaultLoginCredentials();
    fs.writeFileSync(getLoginCredPath(), JSON.stringify(def, null, 2), "utf8");
    clearRememberedLogin();
    return true;
  } catch (err) {
    console.error("[ipc] reset-password failed:", err.message);
    return false;
  }
});

ipcMain.handle("login-get-remembered", async () => {
  try {
    return loadRememberedLogin();
  } catch (err) {
    console.error("[ipc] login-get-remembered failed:", err.message);
    return { remember: false };
  }
});

ipcMain.handle("login-save-remembered", async (_, payload) => {
  try {
    saveRememberedLogin(payload || {});
    return true;
  } catch (err) {
    console.error("[ipc] login-save-remembered failed:", err.message);
    return false;
  }
});

ipcMain.handle("login-clear-remembered", async () => {
  try {
    clearRememberedLogin();
    return true;
  } catch (err) {
    console.error("[ipc] login-clear-remembered failed:", err.message);
    return false;
  }
});

ipcMain.handle("get-auth-key", async () => {
  try {
    return getAdminAuthKey();
  } catch (err) {
    console.error("[ipc] get-auth-key failed:", err.message);
    return null;
  }
});

ipcMain.handle("license-get-status", async () => {
  try {
    return buildLicensePublicStatus();
  } catch (err) {
    console.error("[ipc] license-get-status failed:", err.message);
    return {
      valid: false,
      source: "trial",
      code: "license_error",
      lifetime: false,
      expiresAt: null,
      expiresAtIso: null,
      msLeft: null,
      daysLeft: null,
      remainingText: "",
      nearExpiry: false,
      message: "Unable to read license status.",
    };
  }
});

ipcMain.handle("license-upload", async () => {
  try {
    const uploaded = await promptLicenseUpload(mainWin || loginWin || undefined);
    if (!uploaded.ok) {
      if (uploaded.canceled) {
        appendLicenseAudit("license_upload_cancelled", "User cancelled license upload dialog.", "warning");
      } else {
        appendLicenseAudit("license_upload_failed", uploaded.error || "License upload failed.", "error");
      }
      return uploaded;
    }
    broadcastLicenseStatus(true);
    return {
      ok: true,
      path: uploaded.path || "",
      status: buildLicensePublicStatus(),
    };
  } catch (err) {
    appendLicenseAudit("license_upload_failed", err.message || "License upload failed.", "error");
    return { ok: false, error: err.message || "License upload failed." };
  }
});

ipcMain.handle("license-get-audit", async () => {
  try {
    return { ok: true, rows: getLicenseAuditRows() };
  } catch (err) {
    return { ok: false, error: err.message || "Failed to load license audit.", rows: [] };
  }
});

ipcMain.handle("app-update-get-state", async () => {
  try {
    return buildPublicAppUpdateState();
  } catch (err) {
    return {
      ...buildPublicAppUpdateState(),
      status: "error",
      message: `Unable to read updater state: ${err.message}`,
      error: String(err.message || "Unable to read updater state"),
    };
  }
});

ipcMain.handle("app-update-check", async () => {
  const state = await checkForAppUpdates({ manual: true });
  return { ok: state.status !== "error", state };
});

ipcMain.handle("app-update-download", async () => {
  return downloadAppUpdate();
});

ipcMain.handle("app-update-install", async () => {
  return installAppUpdateNow();
});

ipcMain.handle("app-restart", async () => {
  try {
    allowMainWindowClose = true;
    app.relaunch();
    killServer();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.on("login-success", async () => {
  if (hasAuthenticated) return;
  const status = buildLicensePublicStatus();
  if (!status.valid) {
    const ok = await ensureLicenseAtStartup();
    if (!ok) {
      app.exit(0);
      return;
    }
  }
  hasAuthenticated = true;
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.close();
    loginWin = null;
  }
  broadcastLicenseStatus(true);
  startAfterLogin();
});

ipcMain.on("window-minimize", () => mainWin?.minimize());
ipcMain.on("window-maximize", () => {
  if (!mainWin) return;
  mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize();
});
ipcMain.on("window-close", () => quit());
ipcMain.on("open-logs-folder", (_, folder) => {
  if (folder) shell.openPath(folder).catch(console.error);
});
ipcMain.on("open-topology-window", async (event) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || null;
  await openTopologyWindowGuarded(ownerWin);
});
ipcMain.on("open-ip-config-window", async (event) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || null;
  await openIpConfigWindowGuarded(ownerWin);
});
ipcMain.on("close-current-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.close();
});
ipcMain.handle("pick-folder", async (_, startPath) => {
  try {
    const result = await dialog.showOpenDialog(mainWin || undefined, {
      title: "Select Export Folder",
      defaultPath: startPath && String(startPath).trim() ? String(startPath).trim() : undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return result.filePaths[0];
  } catch (err) {
    console.error("[main] pick-folder failed:", err.message);
    return null;
  }
});
ipcMain.handle("save-text-file", async (_, options = {}) => {
  try {
    const targetWin = BrowserWindow.getFocusedWindow() || mainWin || undefined;
    const result = await dialog.showSaveDialog(targetWin, {
      title: String(options.title || "Save File"),
      defaultPath:
        options.defaultPath && String(options.defaultPath).trim()
          ? String(options.defaultPath).trim()
          : undefined,
      filters:
        Array.isArray(options.filters) && options.filters.length
          ? options.filters
          : [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, String(options.content ?? ""), "utf8");
    return result.filePath;
  } catch (err) {
    console.error("[main] save-text-file failed:", err.message);
    return null;
  }
});
ipcMain.handle("open-text-file", async (_, options = {}) => {
  try {
    const targetWin = BrowserWindow.getFocusedWindow() || mainWin || undefined;
    const result = await dialog.showOpenDialog(targetWin, {
      title: String(options.title || "Open File"),
      properties: ["openFile"],
      filters:
        Array.isArray(options.filters) && options.filters.length
          ? options.filters
          : [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      content: fs.readFileSync(filePath, "utf8"),
    };
  } catch (err) {
    console.error("[main] open-text-file failed:", err.message);
    return null;
  }
});
ipcMain.handle("open-folder", async (_, folder) => {
  try {
    const target = String(folder || "").trim();
    if (!target) return false;
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    const err = await shell.openPath(target);
    return !err;
  } catch (e) {
    console.error("[main] open-folder failed:", e.message);
    return false;
  }
});
ipcMain.handle("config-get", async () => {
  try {
    const cfg = await requestServerJson("GET", "/api/ip-config");
    // Keep legacy file in sync for backend compatibility.
    try {
      saveIpConfigFile(cfg);
    } catch (err) {
      console.warn("[config] file sync failed:", err.message);
    }
    return sanitizeConfig(cfg);
  } catch (err) {
    console.warn("[config] DB load failed, fallback to file:", err.message);
    return loadIpConfigFile();
  }
});
ipcMain.handle("config-save", async (_, newConfig) => {
  try {
    const safe = sanitizeConfig(newConfig);
    let saved = safe;
    let dbSynced = false;
    let backendRestarted = false;
    try {
      saved = sanitizeConfig(await requestServerJson("POST", "/api/ip-config", safe, 5000));
      dbSynced = true;
    } catch (err) {
      console.warn("[config] DB save failed, keeping legacy file:", err.message);
    }

    // Always mirror to legacy file for backend compatibility.
    saveIpConfigFile(saved);
    backendRestarted = restartBackendProcess();

    return {
      success: true,
      config: saved,
      backendRestarted,
      ...(dbSynced ? {} : { warning: "Saved locally, DB sync unavailable." }),
    };
  } catch (err) {
    console.error("[config] save failed:", err.message);
    return { success: false, error: err.message };
  }
});
ipcMain.on("open-ip", async (event, ip) => {
  if (!ip || typeof ip !== "string") return;
  const cleanIp = ip.replace(/^https?:\/\//i, "");
  const url = ip.startsWith("http://") || ip.startsWith("https://") ? ip : `http://${ip}`;
  const reachable = await checkReachable(cleanIp, 80, 2000);
  if (!event.sender.isDestroyed()) {
    event.sender.send("ip-status", { ip: cleanIp, ok: reachable });
  }
  if (!reachable) return;
  const parentWin = BrowserWindow.fromWebContents(event.sender);
  const invWin = new BrowserWindow({
    width: 920,
    height: 680,
    icon: APP_ICON,
    parent: parentWin || null,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: true },
  });
  invWin.loadURL(url).catch((err) => {
    console.error("[main] open-ip load error:", err.message);
  });
});
ipcMain.on("open-ip-check", async (event, ip) => {
  if (!ip || typeof ip !== "string") return;
  const cleanIp = ip.replace(/^https?:\/\//i, "");
  const ok = await checkReachable(cleanIp, 80, 1500);
  if (!event.sender.isDestroyed()) {
    event.sender.send("ip-status", { ip: cleanIp, ok });
  }
});

// ─── Cloud Backup OAuth Window ────────────────────────────────────────────────
// Opens a temporary BrowserWindow for OAuth, intercepts the localhost:3500
// callback URL before it loads, and returns the code to the renderer.
ipcMain.handle("oauth-start", async (_, { authUrl }) => {
  return new Promise((resolve) => {
    const CALLBACK_ORIGIN = "http://localhost:3500/oauth/callback";

    const oauthWin = new BrowserWindow({
      width: 900,
      height: 720,
      title: "Cloud Backup — Connect Account",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:oauth-temp",  // isolated session
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    });

    let settled = false;
    let timeout = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        oauthWin.webContents.session.webRequest.onBeforeRequest({ urls: [] }, null);
      } catch (_) {}
      if (timeout) clearTimeout(timeout);
      if (!oauthWin.isDestroyed()) oauthWin.destroy();
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({ ok: false, error: "OAuth timed out (5 minutes)" });
    }, 5 * 60 * 1000);

    // Intercept the redirect to localhost before it hits the server.
    oauthWin.webContents.session.webRequest.onBeforeRequest(
      { urls: [`${CALLBACK_ORIGIN}/*`] },
      (details, callback) => {
        callback({ cancel: true });
        finish({ ok: true, callbackUrl: details.url });
      },
    );

    oauthWin.on("closed", () => {
      finish({ ok: false, error: "OAuth window closed by user" });
    });

    oauthWin.loadURL(String(authUrl)).catch((err) => {
      finish({ ok: false, error: err.message });
    });
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function forceKillProc(proc, label) {
  if (!proc || proc.killed) return;
  execFile("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" }, (err) => {
    if (err) console.warn(`[main] taskkill ${label} failed:`, err.message);
  });
}

function killServer() {
  isAppShuttingDown = true;
  stopForecastModeSync();
  clearForecastRestartTimer();

  // Always force-kill Python processes (no graceful shutdown path)
  forceKillProc(backendProc, "backend");
  stopForecastProcess("application shutdown");
  backendProc = null;
  forecastProc = null;

  if (embeddedServerStarted && embeddedServerModule?.shutdownEmbedded) {
    try {
      embeddedServerModule.shutdownEmbedded();
    } catch (err) {
      console.warn("[main] embedded web server shutdown failed:", err.message);
    }
  }
  embeddedServerStarted = false;
  embeddedServerModule = null;

  // Ask the web server (Node.js child) to flush the DB and exit cleanly,
  // then force-kill it if it hasn't gone away within 1.5 s.
  const wp = webProc;
  webProc = null;
  if (!wp || wp.killed) return;
  try { wp.send({ type: "shutdown" }); } catch (_) {}
  const deadline = setTimeout(() => forceKillProc(wp, "web-server"), 1500);
  if (deadline.unref) deadline.unref();
  wp.once("exit", () => clearTimeout(deadline));
}

function quit() {
  allowMainWindowClose = true;
  killServer();
  app.quit();
}
