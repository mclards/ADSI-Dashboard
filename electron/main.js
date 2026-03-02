"use strict";
/**
 * main.js - Electron entry point for Inverter Dashboard v2.2
 * Designed & Developed by Engr. Clariden Montaño REE (Engr. M.)
 * Starts a Python backend (PyInstaller EXE preferred, python script fallback).
 */

const { app, BrowserWindow, ipcMain, shell, globalShortcut, dialog, Menu } = require("electron");
const path = require("path");
const http = require("http");
const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

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
const POLL_TIMEOUT = 60000;
const INITIAL_LOAD_RETRY_DELAY = 1200;
const INITIAL_LOAD_RETRY_MAX = 8;
const FORECAST_RESTART_BASE_MS = 1500;
const FORECAST_RESTART_MAX_MS = 30000;
const IS_DEV = process.env.NODE_ENV === "development";
const BACKEND_EXE_NAMES = ["InverterCoreService.exe"];
const BACKEND_SCRIPT_NAMES = ["InverterCoreService.py", "main2.py"];
const FORECAST_EXE_NAMES = ["ForecastCoreService.exe"];
const FORECAST_SCRIPT_NAMES = ["ForecastCoreService.py"];
// Legacy service image names from previous ADSI-branded releases (kept for cleanup on upgrade).
const LEGACY_SERVICE_IMAGE_NAMES = ["ADSI_InverterService.exe", "ADSI_ForecastService.exe", "InverterCoreService.exe", "ForecastCoreService.exe"];
// Login-page admin auth key is intentionally fixed across devices.
const LOGIN_ADMIN_AUTH_KEY = "IM-2026";
const DEFAULT_LOGIN_USERNAME = "admin";
const DEFAULT_LOGIN_PASSWORD = "1234";
const APP_ICON = path.join(__dirname, "../assets/icon.ico");
const PROGRAMDATA_ROOT = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
const PROGRAMDATA_DIR = path.join(PROGRAMDATA_ROOT, "InverterDashboard");
const LICENSE_DIR = path.join(PROGRAMDATA_DIR, "license");
const LICENSE_STATE_PATH = path.join(LICENSE_DIR, "license-state.json");
const LICENSE_FILE_MIRROR = path.join(LICENSE_DIR, "license.dat");
const TRIAL_DAYS = 7;
const LICENSE_WARN_MS = 24 * 60 * 60 * 1000; // 1 day
const LICENSE_CHECK_INTERVAL_MS = 30 * 1000;

// ─── State ────────────────────────────────────────────────────────────────────
let mainWin = null;
let loadingWin = null;
let loginWin = null;
let topologyWin = null;
let ipConfigWin = null;
let webProc = null;
let embeddedServerStarted = false;
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
let lastForecastLaunch = null;
let hasAuthenticated = false;
let bootStarted = false;
let shortcutsRegistered = false;
let licenseStateCache = null;
let licenseCheckerTimer = null;
let licenseShutdownTriggered = false;
let lastBroadcastLicenseSignature = "";
let allowMainWindowClose = false;

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
    process.env.IM_PORTABLE_DATA_DIR = PORTABLE_DATA_DIR;
    process.env.IM_DATA_DIR = dbDir;
    console.log("[main] Portable data root:", PORTABLE_DATA_DIR);
  } catch (err) {
    console.error("[main] Portable path setup failed:", err.message);
  }
}

configurePortableDataPaths();

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.inverter.dashboard");
  }
  app.setName("Inverter Dashboard");
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
  if (licenseCheckerTimer) {
    clearInterval(licenseCheckerTimer);
    licenseCheckerTimer = null;
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
    width: 500,
    height: 420,
    minWidth: 500,
    minHeight: 420,
    useContentSize: true,
    icon: APP_ICON,
    frame: false,
    resizable: false,
    alwaysOnTop: false,
    center: true,
    backgroundColor: "#0f1117",
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
    alwaysOnTop: false,
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
  try {
    if (!fs.existsSync(LICENSE_STATE_PATH)) {
      const def = defaultLicenseState();
      def.audit = normalizeLicenseAudit([
        {
          ts: Date.now(),
          action: "install_initialized",
          level: "info",
          details: "License state created on this device.",
        },
      ]);
      fs.writeFileSync(LICENSE_STATE_PATH, JSON.stringify(def, null, 2), "utf8");
      licenseStateCache = def;
      return def;
    }
    const raw = JSON.parse(fs.readFileSync(LICENSE_STATE_PATH, "utf8"));
    const def = defaultLicenseState();
    const state = {
      schema: Number(raw?.schema || 1),
      deviceFingerprint: String(raw?.deviceFingerprint || def.deviceFingerprint),
      firstInstallAt: parseDateMs(raw?.firstInstallAt) || def.firstInstallAt,
      trialAcceptedAt: parseDateMs(raw?.trialAcceptedAt),
      trialExpiresAt: parseDateMs(raw?.trialExpiresAt),
      license: raw?.license && typeof raw.license === "object" ? raw.license : null,
      audit: normalizeLicenseAudit(raw?.audit),
    };
    fs.writeFileSync(LICENSE_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    licenseStateCache = state;
    return state;
  } catch (err) {
    console.error("[license] state load failed:", err.message);
    const def = defaultLicenseState();
    try {
      fs.writeFileSync(LICENSE_STATE_PATH, JSON.stringify(def, null, 2), "utf8");
    } catch (writeErr) {
      console.error("[license] fallback state write failed:", writeErr.message);
    }
    licenseStateCache = def;
    return def;
  }
}

function saveLicenseState(state) {
  ensureDir(LICENSE_DIR);
  state.audit = normalizeLicenseAudit(state.audit);
  // Write to a temp file then atomically rename to avoid corruption on crash.
  const tmpPath = LICENSE_STATE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, LICENSE_STATE_PATH);
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

function normalizeLicensePayload(payload, sourcePath) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "License file must contain a JSON object." };
  }

  const now = Date.now();
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
  let durationMs = null;
  if (Number.isFinite(durationMsField) && durationMsField > 0) {
    durationMs = Math.trunc(durationMsField);
  } else if (Number.isFinite(durationHours) && durationHours > 0) {
    durationMs = Math.trunc(durationHours * 60 * 60 * 1000);
  } else if (Number.isFinite(durationDays) && durationDays > 0) {
    durationMs = Math.trunc(durationDays * 24 * 60 * 60 * 1000);
  }

  const explicitExpiry = parseDateMs(
    payload.expiresAt ||
      payload.expires_at ||
      payload.validUntil ||
      payload.valid_until ||
      payload.expiry ||
      payload.expiration ||
      payload.endAt ||
      payload.end_at,
  );
  const activatedAt = now;
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
    type: lifetime ? "lifetime" : Number.isFinite(durationMs) && !Number.isFinite(explicitExpiry) ? "duration" : "datetime",
    lifetime: !!lifetime,
    expiresAt: Number.isFinite(expiresAt) ? Math.trunc(expiresAt) : null,
    metadata: {
      issuedTo: payload.issuedTo || payload.customer || payload.customerName || "",
      notes: payload.notes || "",
      serial: payload.serial || payload.keyId || payload.licenseId || "",
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
    const normalized = normalizeLicensePayload(payload, fullPath);
    if (!normalized.ok) {
      appendLicenseAudit("license_import_failed", normalized.error || "Invalid license payload.", "error");
      return normalized;
    }

    const state = loadLicenseState();
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
        ? "Lifetime license imported."
        : `License imported. Expires at ${new Date(normalized.license.expiresAt).toISOString()}.`,
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
  state.trialExpiresAt = now + TRIAL_DAYS * 24 * 60 * 60 * 1000;
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

  const lic = state.license && typeof state.license === "object" ? state.license : null;
  if (lic) {
    const expiresAt = parseDateMs(lic.expiresAt);
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

function buildLicensePublicStatus() {
  const v = evaluateLicense();
  return {
    valid: !!v.valid,
    source: v.source || "trial",
    code: v.code || "",
    lifetime: !!v.lifetime,
    expiresAt: Number.isFinite(v.expiresAt) ? v.expiresAt : null,
    expiresAtIso: Number.isFinite(v.expiresAt) ? new Date(v.expiresAt).toISOString() : null,
    msLeft: Number.isFinite(v.msLeft) ? v.msLeft : null,
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
        message: "Welcome to Inverter Dashboard",
        detail:
          "Choose an option to continue:\n• Start one-time 7-day trial on this device\n• Upload a valid license file",
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
    require(serverEntry);
    embeddedServerStarted = true;
    serverBootError = "";
    return true;
  } catch (err) {
    serverBootError = String(err?.message || err || "unknown error");
    console.error("[main] Embedded web server start failed:", serverBootError);
    return false;
  }
}

function showLoadingErrorMessage(message) {
  if (!loadingWin || loadingWin.isDestroyed()) return;
  const safe = String(message || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, "<br/>");
  loadingWin.webContents
    .executeJavaScript(
      `document.body.innerHTML='<div style="font-family:Arial,sans-serif;color:#ff7b7b;padding:18px;text-align:center;line-height:1.45">${safe}</div>';`,
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
  startForecastProcess();

  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    console.error("[main] Web server entry not found.");
    showLoadingErrorMessage("Web server entry not found.<br/>Please reinstall the dashboard.");
    return;
  }

  // Packaged app: run the Express server in-process for startup reliability.
  if (app.isPackaged) {
    const ok = startEmbeddedServer(serverEntry);
    if (!ok) {
      showLoadingErrorMessage(
        `Web server failed to start.<br/>${serverBootError || "Unknown startup error."}`,
      );
      return;
    }
    pollUntilReady();
    return;
  }

  const runtimeBin = process.execPath;
  console.log("[main] Spawning web server:", runtimeBin, serverEntry);
  webProc = spawn(runtimeBin, [serverEntry], {
    cwd: path.dirname(serverEntry),
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      ELECTRON_RUN_AS_NODE: "1",
    },
    shell: false,
  });
  webProc.on("error", (err) => {
    console.error("[main] Web server spawn error:", err.message);
  });
  webProc.on("exit", (code, signal) => {
    console.warn("[main] Web server exited - code=" + code + " signal=" + signal);
  });

  // Poll HTTP until server is ready
  pollUntilReady();
}

function resolveBackendLaunch() {
  const explicit = process.env.IM_BACKEND_PATH;
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
  const explicit = process.env.IM_FORECAST_PATH;
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
    forecastProc = null;
    console.warn("[main] Forecast exited - code=" + code + " signal=" + signal);
    scheduleForecastRestart(`exit code=${code} signal=${signal}`);
  });
}

function startBackendProcess() {
  const backendLaunch = resolveBackendLaunch();
  if (!backendLaunch) {
    console.error("[main] Backend not found. Set IM_BACKEND_PATH or place backend executable.");
    return false;
  }
  spawnBackendProcess(backendLaunch);
  return true;
}

function startForecastProcess() {
  const launch = resolveForecastLaunch();
  if (!launch) {
    console.warn("[main] Forecast service not found. Skipping day-ahead background process.");
    return false;
  }
  spawnForecastProcess(launch);
  return true;
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
    const launch = resolveForecastLaunch() || lastForecastLaunch;
    if (!launch) {
      console.error("[main] Forecast restart failed: launch target not found.");
      return;
    }
    spawnForecastProcess(launch, "[main] Restarting forecast:");
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
        if (loadingWin && !loadingWin.isDestroyed()) {
          loadingWin.webContents
            .executeJavaScript(
              "document.body.innerHTML='<div style=\"font-family:Arial,sans-serif;color:#ff7b7b;padding:18px;text-align:center;line-height:1.45\">Backend startup timed out.<br/>Please close the app and retry.</div>';",
            )
            .catch(() => {});
        }
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
    if (loadingWin && !loadingWin.isDestroyed()) {
      loadingWin.close();
      loadingWin = null;
    }
    if (!mainWin.isVisible()) {
      mainWin.show();
      mainWin.focus();
    }
    broadcastLicenseStatus(true);
  });

  mainWin.webContents.on("did-fail-load", (e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED during navigation is expected
    console.error("[main] did-fail-load:", code, desc);
    if (mainPageLoadedOnce) return;
    if (initialLoadRetries >= INITIAL_LOAD_RETRY_MAX) {
      console.error("[main] Initial load retries exhausted.");
      if (loadingWin && !loadingWin.isDestroyed()) {
        loadingWin.webContents
          .executeJavaScript(
            "document.body.innerHTML='<div style=\"font-family:Arial,sans-serif;color:#ff7b7b;padding:18px;text-align:center;line-height:1.45\">Unable to connect to backend on localhost:3500.<br/>Please check InverterCoreService.exe and retry.</div>';",
          )
          .catch(() => {});
      }
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
      message: "Exit Inverter Dashboard?",
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
  mainWin.loadURL(SERVER_URL).catch((err) => {
    console.error("[main] loadURL error:", err.message);
  });
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

async function getCurrentOperationMode(timeoutMs = 1500) {
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
    return "gateway";
  }
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
  const portableRoot = String(process.env.IM_PORTABLE_DATA_DIR || "").trim();
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

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function killServer() {
  isAppShuttingDown = true;
  clearForecastRestartTimer();
  for (const proc of [webProc, backendProc, forecastProc]) {
    if (!proc || proc.killed) continue;
    execFile("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" }, (err) => {
      if (err) console.warn("[main] taskkill pid failed:", err.message);
    });
  }
  webProc = null;
  backendProc = null;
  forecastProc = null;
}

function quit() {
  allowMainWindowClose = true;
  killServer();
  app.quit();
}
