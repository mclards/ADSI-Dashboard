"use strict";
/* ═══════════════════════════════════════════════════════════════════════
   Inverter Dashboard v2.2 — Main Application
   WebSocket-driven, real-time inverter monitoring & control
   Designed & Developed by Engr. Clariden Montaño REE (Engr. M.)
   © 2026 Engr. Clariden Montaño REE. All rights reserved.
   ═══════════════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  liveData: {}, // key: `${inv}_${unit}` → parsed row
  totals: {}, // key: inverter# → {pac, pdc, kwh}
  nodeStates: {}, // key: `${inv}_${node}` → 0|1
  ipConfig: null, // /api/ip-config snapshot
  settings: {
    operationMode: "gateway",
    remoteAutoSync: false,
    remoteGatewayUrl: "",
    remoteApiToken: "",
    tailscaleDeviceHint: "",
    inverterCount: 27,
    nodeCount: 4,
    plantName: "Solar Plant",
    operatorName: "OPERATOR",
    csvSavePath: "C:\\Logs\\InverterDashboard",
    forecastProvider: "ml_local",
    solcastBaseUrl: "https://api.solcast.com.au",
    solcastApiKey: "",
    solcastResourceId: "",
    solcastTimezone: "Asia/Manila",
    invGridLayout: "4",
    exportUiState: {},
  },
  todayKwh: {}, // key: inverter → kWh today
  alarmFilter: "all",
  ws: null,
  wsConnecting: false,
  charts: {},
  currentPage: "inverters",
  wsRetries: 0,
  invLastFresh: {}, // key: inverter -> last fresh timestamp
  analyticsReqId: 0,
  analyticsRealtimeTimer: null,
  analyticsFetchTimer: null,
  analyticsFetchInFlight: false,
  analyticsBaseRows: [],
  analyticsDayAheadBaseRows: [],
  analyticsIntervalMin: 5,
  analyticsWeeklyWeather: [],
  analyticsWeatherDate: "",
  activeAlarms: {}, // key: `${inv}_${unit}` -> active alarm row
  alarmSoundTimer: null,
  alarmAudioCtx: null,
  exportUiSaveTimer: null,
  exportBtnTimers: {},
  auditView: {
    rows: [],
    sortKey: "ts",
    sortDir: "desc",
  },
  reportView: {
    rows: [],
    sortKey: "inverter",
    sortDir: "asc",
    summary: null,
  },
  progressUi: {
    activeCount: 0,
    phasePct: 0,
    timer: null,
    hideTimer: null,
    lastLabel: "Ready",
  },
  pacToday: {
    day: "",
    lastTs: 0,
    lastTotalPacW: 0,
    totalKwh: 0,
  },
  netIO: {
    rxBytes: 0,        // cumulative bytes received (WS + HTTP response bodies)
    txBytes: 0,        // cumulative bytes sent (HTTP request bodies)
    rxBps: 0,          // rolling 1s rate
    txBps: 0,
    lastCalcTs: 0,
    lastRxBytes: 0,
    lastTxBytes: 0,
    rxFlashTimer: null,
    txFlashTimer: null,
    monitorTimer: null,
  },
  xfer: {
    active: false,
    dir: null,        // 'tx' | 'rx'
    label: "",        // optional custom action label (e.g., "Receiving push")
    totalBytes: 0,    // known total (TX only; 0 = unknown)
    doneBytes: 0,     // bytes sent/received so far
    chunkCount: 0,
    chunkDone: 0,
    totalRows: 0,
    importedRows: 0,
    hideTimer: null,
  },
  licenseStatus: null,
  licenseAudit: [],
  clockTimer: null,
  alarmBadgeTimer: null,
  replicationHealthTimer: null,
  todayMwhSyncTimer: null,
  cardRenderScheduled: false,
  cardRenderTimer: null,
  lastCardRenderTs: 0,
  nodeOrderSig: {},
};
const NODE_RATED_W  = Math.round(997000 / 4); // 249,250 W — rated per-node (997 kW ÷ 4, always 4 nodes)
const INV_RATED_KW  = 997;                    // rated per-inverter capacity kW
const DATA_FRESH_MS = 15000;
const CARD_OFFLINE_HOLD_MS = 15000;
const CARD_RENDER_MIN_INTERVAL_MS = 220;
const ANALYTICS_VIEW_START_HOUR = 5;
const ANALYTICS_VIEW_END_HOUR = 18;
const ANALYTICS_VIEW_END_MIN = 0;
const THEME_STORAGE_KEY = "adsi_theme";
const SUPPORTED_THEMES = ["dark", "light", "classic"];
const SUPPORTED_INV_GRID_LAYOUTS = ["auto", "2", "3", "4", "5", "6", "7"];
const TODAY_MWH_SYNC_INTERVAL_MS = 5000; // server caches for 5s; polling faster has no benefit
const THEME_META = {
  dark: {
    label: "Maroon",
    icon: "mdi mdi-palette",
  },
  light: {
    label: "Light",
    icon: "mdi mdi-white-balance-sunny",
  },
  classic: {
    label: "Classic",
    icon: "mdi mdi-weather-night",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const fmtKW = (v) => (v == null ? "—" : (v / 1000).toFixed(2));
const fmtKWh = (v) => (v == null ? "—" : Number(v).toFixed(2));
const fmtMWh = (kwh, d = 6) =>
  kwh == null ? "—" : (Number(kwh) / 1000).toFixed(d);
const fmtNum = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
const toAlarmHex = (v) => {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return "0000H";
  return Math.trunc(n).toString(16).toUpperCase().padStart(4, "0") + "H";
};
const normalizeAlarmHex = (hex, fallbackVal = 0) => {
  const s = String(hex || "")
    .trim()
    .toUpperCase();
  if (/^[0-9A-F]{1,8}H$/.test(s)) return s;
  return toAlarmHex(fallbackVal);
};
const pad2 = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => dateStr(new Date());
const relTime = (ts) => {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const fmtDateTime = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const fmtTime = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

function normalizeInvGridLayout(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return SUPPORTED_INV_GRID_LAYOUTS.includes(v) ? v : "4";
}

function applyInverterGridLayout(layout) {
  const normalized = normalizeInvGridLayout(layout);
  State.settings.invGridLayout = normalized;

  const sel = $("invGridLayout");
  if (sel && sel.value !== normalized) sel.value = normalized;

  const grid = $("invGrid");
  if (!grid) return normalized;

  grid.classList.remove(
    "layout-auto",
    "layout-2",
    "layout-3",
    "layout-4",
    "layout-5",
    "layout-6",
    "layout-7",
  );
  grid.classList.add(`layout-${normalized}`);
  return normalized;
}

async function setInverterGridLayout(layout, options = {}) {
  const { persist = true, silent = false } = options;
  const normalized = applyInverterGridLayout(layout);
  if (!persist) return normalized;
  try {
    await api("/api/settings", "POST", { invGridLayout: normalized });
  } catch (e) {
    if (!silent) {
      showToast(`Grid layout save failed: ${e.message}`, "warning", 3200);
    }
  }
  return normalized;
}

function fmtRemaining(msLeft) {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return "less than 1 hour";
  const totalMin = Math.max(1, Math.floor(msLeft / 60000));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function renderLicenseNotice(status) {
  const host = $("licenseNotice");
  const textEl = $("licenseNoticeText");
  if (!host || !textEl) return;
  const near = !!status?.valid && !!status?.nearExpiry && !status?.lifetime;
  if (!near) {
    host.classList.add("hidden");
    document.body.classList.remove("license-notice-open");
    return;
  }
  const remaining = fmtRemaining(Number(status?.msLeft || 0));
  const sourceLabel = status?.source === "trial" ? "Trial" : "License";
  textEl.textContent = `${sourceLabel} expires in ${remaining}. Upload a new license to avoid interruption.`;
  host.classList.remove("hidden");
  document.body.classList.add("license-notice-open");
}

function bindLicenseNoticeUpload() {
  const btn = $("licenseNoticeUpload");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    try {
      const res = await window.electronAPI?.uploadLicense?.();
      if (!res?.ok) {
        const msg = res?.canceled
          ? "License upload cancelled."
          : res?.error || "License upload failed.";
        pushToast("warning", msg);
        return;
      }
      pushToast("success", "License uploaded successfully.");
      if (res.status) {
        State.licenseStatus = res.status;
        renderLicenseNotice(res.status);
      }
    } catch (err) {
      pushToast("error", `License upload failed: ${err.message || err}`);
    }
  });
}

async function initLicenseBridge() {
  bindLicenseNoticeUpload();
  try {
    if (window.electronAPI?.onLicenseStatus) {
      window.electronAPI.onLicenseStatus((status) => {
        State.licenseStatus = status || null;
        renderLicenseNotice(State.licenseStatus);
        renderLicenseSummary();
      });
    }
    if (window.electronAPI?.getLicenseStatus) {
      const status = await window.electronAPI.getLicenseStatus();
      State.licenseStatus = status || null;
      renderLicenseNotice(State.licenseStatus);
      renderLicenseSummary();
    }
  } catch (err) {
    console.warn("[app] license check failed:", err.message);
  }
}

function renderLicenseSummary() {
  const status = State.licenseStatus || null;
  const statusEl = $("licenseStatusText");
  const sourceEl = $("licenseSourceText");
  const expiryEl = $("licenseExpiryText");
  const daysEl = $("licenseDaysLeftText");
  if (!statusEl || !sourceEl || !expiryEl || !daysEl) return;

  statusEl.classList.remove("ok", "warn", "error");

  if (!status) {
    statusEl.textContent = "Unknown";
    sourceEl.textContent = "—";
    expiryEl.textContent = "—";
    daysEl.textContent = "—";
    return;
  }

  let statusText = "Invalid";
  if (status.valid) {
    if (status.lifetime) statusText = "Valid (Lifetime)";
    else if (status.nearExpiry) statusText = "Valid (Expiring Soon)";
    else statusText = "Valid";
  } else {
    statusText = "Expired / Invalid";
  }
  statusEl.textContent = statusText;
  if (status.valid && !status.nearExpiry) statusEl.classList.add("ok");
  else if (status.valid && status.nearExpiry) statusEl.classList.add("warn");
  else statusEl.classList.add("error");

  const sourceMap = {
    trial: "Trial",
    license: "License",
    device: "Device",
  };
  sourceEl.textContent = sourceMap[String(status.source || "").toLowerCase()] || String(status.source || "—");

  if (status.lifetime) {
    expiryEl.textContent = "Never (Lifetime)";
    daysEl.textContent = "∞";
    return;
  }

  const exp = Number(status.expiresAt || 0);
  if (!Number.isFinite(exp) || exp <= 0) {
    expiryEl.textContent = "—";
    daysEl.textContent = "—";
    return;
  }

  expiryEl.textContent = fmtDateTime(exp);
  const dLeft = Math.max(0, Math.floor((exp - Date.now()) / 86400000));
  daysEl.textContent = `${dLeft}`;
}

function renderLicenseAuditRows() {
  const tbody = $("licenseAuditBody");
  if (!tbody) return;
  const rows = Array.isArray(State.licenseAudit) ? State.licenseAudit : [];
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty"><td colspan="4">No license audit entries.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const ts = fmtDateTime(Number(r.ts || 0));
      const action = String(r.action || "event");
      const details = String(r.details || "—");
      const level = String(r.level || "info").toUpperCase();
      return `<tr>
        <td>${ts}</td>
        <td>${action}</td>
        <td>${details}</td>
        <td>${level}</td>
      </tr>`;
    })
    .join("");
}

async function refreshLicenseSection() {
  try {
    if (window.electronAPI?.getLicenseStatus) {
      State.licenseStatus = await window.electronAPI.getLicenseStatus();
      renderLicenseNotice(State.licenseStatus);
      renderLicenseSummary();
    }
    if (window.electronAPI?.getLicenseAudit) {
      const audit = await window.electronAPI.getLicenseAudit();
      State.licenseAudit = Array.isArray(audit?.rows) ? audit.rows : [];
      renderLicenseAuditRows();
    }
  } catch (err) {
    showMsg("licenseMsg", `✗ License refresh failed: ${err.message}`, "error");
  }
}

async function uploadLicenseFromSettings() {
  try {
    const res = await window.electronAPI?.uploadLicense?.();
    if (!res?.ok) {
      if (res?.canceled) {
        showMsg("licenseMsg", "License upload cancelled.", "error");
      } else {
        showMsg("licenseMsg", `✗ ${res?.error || "License upload failed."}`, "error");
      }
      return;
    }
    showMsg("licenseMsg", "✔ License replaced successfully", "");
    await refreshLicenseSection();
  } catch (err) {
    showMsg("licenseMsg", `✗ License upload failed: ${err.message}`, "error");
  }
}

function cssVar(name, fallback = "") {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch (err) {
    console.warn("[app] cssVar failed:", err.message);
    return fallback;
  }
}

function getChartPalette() {
  return {
    tick: cssVar("--chart-tick", "#6b82a8"),
    grid: cssVar("--chart-grid", "rgba(30,45,71,.6)"),
    legend: cssVar("--chart-legend", "#6b82a8"),
    actual: cssVar("--chart-actual", "#22d3ee"),
    actualFill: cssVar("--chart-actual-fill", "rgba(34,211,238,.14)"),
    ahead: cssVar("--chart-ahead", "#f59e0b"),
    aheadFill: cssVar("--chart-ahead-fill", "rgba(245,158,11,.10)"),
  };
}

function refreshChartsTheme() {
  const pal = getChartPalette();
  Object.entries(State.charts || {}).forEach(([key, chart]) => {
    if (!chart) return;
    const opts = chart.options || {};
    if (opts.plugins?.legend?.labels) {
      opts.plugins.legend.labels.color = pal.legend;
    }
    if (opts.scales?.x?.ticks) opts.scales.x.ticks.color = pal.tick;
    if (opts.scales?.x?.grid) opts.scales.x.grid.color = pal.grid;
    if (opts.scales?.y?.ticks) opts.scales.y.ticks.color = pal.tick;
    if (opts.scales?.y?.grid) opts.scales.y.grid.color = pal.grid;
    if (opts.scales?.y?.title) opts.scales.y.title.color = pal.tick;

    if (key === "totalPac" && Array.isArray(chart.data?.datasets)) {
      if (chart.data.datasets[0]) {
        chart.data.datasets[0].borderColor = pal.actual;
        chart.data.datasets[0].backgroundColor = pal.actualFill;
      }
      if (chart.data.datasets[1]) {
        chart.data.datasets[1].borderColor = pal.ahead;
        chart.data.datasets[1].backgroundColor = pal.aheadFill;
      }
    }
    chart.update("none");
  });
}

function getStoredTheme() {
  try {
    const t = String(localStorage.getItem(THEME_STORAGE_KEY) || "").trim();
    return SUPPORTED_THEMES.includes(t) ? t : "dark";
  } catch (err) {
    console.warn("[app] getStoredTheme failed:", err.message);
    return "dark";
  }
}

function applyTheme(theme, persist = true) {
  const active = SUPPORTED_THEMES.includes(theme) ? theme : "dark";
  document.documentElement.setAttribute("data-theme", active);

  const label = $("themeToggleLabel");
  const icon = $("themeToggleIcon");
  if (label) label.textContent = THEME_META[active]?.label || "Theme";
  if (icon) icon.className = THEME_META[active]?.icon || "mdi mdi-palette";

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, active);
    } catch (err) {
      console.warn("[app] theme persist failed:", err.message);
    }
  }

  refreshChartsTheme();
}

function initThemeToggle() {
  applyTheme(getStoredTheme(), false);
  const btn = $("themeToggleBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const current =
      document.documentElement.getAttribute("data-theme") || "dark";
    const idx = SUPPORTED_THEMES.indexOf(current);
    const next = SUPPORTED_THEMES[(idx + 1) % SUPPORTED_THEMES.length];
    applyTheme(next, true);
  });
}
const EXPORT_DATE_FIELD_IDS = [
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
const EXPORT_NUM_FIELD_IDS = ["genDayCount"];
const DATE_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeDateInputValue(v) {
  const s = String(v || "").trim();
  return DATE_INPUT_RE.test(s) ? s : "";
}

function localDateStartMs(dateText) {
  const d = sanitizeDateInputValue(dateText);
  if (!d) return NaN;
  return new Date(`${d}T00:00:00.000`).getTime();
}

function localDateEndMs(dateText) {
  const d = sanitizeDateInputValue(dateText);
  if (!d) return NaN;
  return new Date(`${d}T23:59:59.999`).getTime();
}

function sanitizeExportUiStateClient(input) {
  const out = {};
  const src = input && typeof input === "object" ? input : {};
  EXPORT_DATE_FIELD_IDS.forEach((id) => {
    const v = sanitizeDateInputValue(src[id]);
    if (v) out[id] = v;
  });
  EXPORT_NUM_FIELD_IDS.forEach((id) => {
    const n = Number(src[id]);
    if (!Number.isFinite(n)) return;
    out[id] = Math.min(31, Math.max(1, Math.trunc(n)));
  });
  return out;
}

function applyExportUiStateToInputs(state) {
  const saved = sanitizeExportUiStateClient(state);
  EXPORT_DATE_FIELD_IDS.forEach((id) => {
    const input = $(id);
    if (!input) return;
    if (saved[id]) input.value = saved[id];
  });
  EXPORT_NUM_FIELD_IDS.forEach((id) => {
    const input = $(id);
    if (!input) return;
    if (saved[id] !== undefined) input.value = String(saved[id]);
  });
}

function collectExportUiStateFromInputs() {
  const out = {};
  EXPORT_DATE_FIELD_IDS.forEach((id) => {
    const input = $(id);
    if (!input) return;
    const v = sanitizeDateInputValue(input.value);
    if (v) out[id] = v;
  });
  EXPORT_NUM_FIELD_IDS.forEach((id) => {
    const input = $(id);
    if (!input) return;
    const n = Number(input.value);
    if (!Number.isFinite(n)) return;
    out[id] = Math.min(31, Math.max(1, Math.trunc(n)));
  });
  return out;
}

async function persistExportUiState() {
  const next = collectExportUiStateFromInputs();
  const prev = sanitizeExportUiStateClient(State.settings.exportUiState);
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  try {
    const r = await api("/api/settings/export-ui", "POST", {
      exportUiState: next,
    }, { progress: false });
    State.settings.exportUiState = sanitizeExportUiStateClient(
      r?.exportUiState || next,
    );
  } catch (err) {
    // Backward compatibility for older backend builds.
    console.warn("[app] exportUiState save (v2) failed, using legacy endpoint:", err.message);
    await api("/api/settings", "POST", { exportUiState: next }, { progress: false });
    State.settings.exportUiState = next;
  }
}

function queuePersistExportUiState() {
  if (State.exportUiSaveTimer) clearTimeout(State.exportUiSaveTimer);
  State.exportUiSaveTimer = setTimeout(() => {
    persistExportUiState().catch((e) => {
      console.warn("[Export UI] save failed:", e.message);
    });
  }, 250);
}

function bindExportUiStatePersistence() {
  [...EXPORT_DATE_FIELD_IDS, ...EXPORT_NUM_FIELD_IDS].forEach((id) => {
    const input = $(id);
    if (!input) return;
    if (input.dataset.exportPersistBound === "1") return;
    input.dataset.exportPersistBound = "1";
    input.addEventListener("change", queuePersistExportUiState);
    input.addEventListener("input", queuePersistExportUiState);
  });
}

function setupExportUiStateFlush() {
  const flush = () => {
    if (!State.exportUiSaveTimer) return;
    clearTimeout(State.exportUiSaveTimer);
    State.exportUiSaveTimer = null;
    persistExportUiState().catch(() => {});
  };
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
  });
}

function setWsState(connected, label) {
  const dot = $("wsDot");
  const state = $("wsState");
  if (!dot) return;
  dot.classList.toggle("connected", connected);
  dot.title = connected ? "Connected" : "Disconnected";
  if (state) {
    // Top status now uses dot-only state indicator.
    state.textContent = "";
    state.classList.toggle("connected", connected);
    state.classList.toggle("disconnected", !connected);
  }
}

function getProgressLabel(url, method = "GET") {
  const u = String(url || "").toLowerCase();
  const m = String(method || "GET").toUpperCase();

  if (u.includes("/api/write"))
    return m === "POST"
      ? "Sending control command..."
      : "Loading control state...";
  if (u.includes("/api/export/")) return "Exporting data...";
  if (u.includes("/api/forecast/generate"))
    return "Generating day-ahead forecast...";
  if (u.includes("/api/analytics/dayahead"))
    return "Loading day-ahead curve...";
  if (u.includes("/api/analytics/energy")) return "Loading analytics...";
  if (u.includes("/api/report/summary")) return "Calculating report summary...";
  if (u.includes("/api/report/daily")) return "Loading daily report...";
  if (u.includes("/api/energy/5min")) return "Loading energy history...";
  if (u.includes("/api/energy/today")) return "Refreshing daily energy...";
  if (u.includes("/api/alarms/ack-all")) return "Acknowledging all alarms...";
  if (u.includes("/api/alarms/active")) return "Loading active alarms...";
  if (u.includes("/api/alarms/") && u.includes("/ack"))
    return "Acknowledging alarm...";
  if (u.includes("/api/alarms")) return "Loading alarm log...";
  if (u.includes("/api/audit")) return "Loading audit log...";
  if (u.includes("/api/ip-config"))
    return m === "POST"
      ? "Saving IP configuration..."
      : "Loading IP configuration...";
  if (u.includes("/api/settings"))
    return m === "POST" ? "Saving settings..." : "Loading settings...";

  return m === "GET" ? "Loading data..." : "Processing request...";
}

function setProgressUi(label, pct, active) {
  const row = $("globalProgressRow");
  const fill = $("globalProgressFill");
  if (!row || !fill) return;

  const bounded = Math.max(0, Math.min(100, Number(pct) || 0));
  row.classList.toggle("active", !!active);
  fill.style.width = `${bounded}%`;
}

function beginProgress(label) {
  const p = State.progressUi;
  if (p.hideTimer) {
    clearTimeout(p.hideTimer);
    p.hideTimer = null;
  }
  p.activeCount += 1;
  p.lastLabel = String(label || p.lastLabel || "Processing...");
  if (!p.timer) {
    p.phasePct = Math.max(6, p.phasePct || 0);
    p.timer = setInterval(() => {
      const cap = p.activeCount > 0 ? 92 : 100;
      const step = p.activeCount > 2 ? 4.5 : 3.2;
      p.phasePct = Math.min(cap, p.phasePct + step);
      setProgressUi(p.lastLabel, p.phasePct, p.activeCount > 0);
    }, 120);
  }
  setProgressUi(p.lastLabel, Math.max(6, p.phasePct || 0), true);
}

function endProgress(doneLabel = "Done") {
  const p = State.progressUi;
  p.activeCount = Math.max(0, p.activeCount - 1);
  if (p.activeCount > 0) return;

  p.lastLabel = String(doneLabel || "Done");
  p.phasePct = 100;
  setProgressUi(p.lastLabel, 100, true);

  if (p.timer) {
    clearInterval(p.timer);
    p.timer = null;
  }
  p.hideTimer = setTimeout(() => {
    p.phasePct = 0;
    p.lastLabel = "Ready";
    setProgressUi("Ready", 0, false);
    p.hideTimer = null;
  }, 420);
}

// ─── Network I/O Tracking ─────────────────────────────────────────────────────
function fmtBps(bps) {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1048576).toFixed(2)} MB/s`;
}

function _netIOFlash(rowId, timerKey) {
  const io = State.netIO;
  const rowEl = document.getElementById(rowId);
  if (!rowEl) return;
  rowEl.classList.add("active");
  if (io[timerKey]) clearTimeout(io[timerKey]);
  io[timerKey] = setTimeout(() => {
    rowEl.classList.remove("active");
    io[timerKey] = null;
  }, 280);
}

function netIOTrackRx(bytes) {
  State.netIO.rxBytes += bytes;
  _netIOFlash("netIoRxRow", "rxFlashTimer");
}

function netIOTrackTx(bytes) {
  State.netIO.txBytes += bytes;
  _netIOFlash("netIoTxRow", "txFlashTimer");
}

function startNetIOMonitor() {
  const io = State.netIO;
  io.lastCalcTs = Date.now();
  io.lastRxBytes = io.rxBytes;
  io.lastTxBytes = io.txBytes;
  io.monitorTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - io.lastCalcTs) / 1000;
    if (elapsed <= 0) return;
    io.rxBps = (io.rxBytes - io.lastRxBytes) / elapsed;
    io.txBps = (io.txBytes - io.lastTxBytes) / elapsed;
    io.lastCalcTs = now;
    io.lastRxBytes = io.rxBytes;
    io.lastTxBytes = io.txBytes;
    const rxEl = document.getElementById("netIoRxSpeed");
    const txEl = document.getElementById("netIoTxSpeed");
    if (rxEl) rxEl.textContent = fmtBps(io.rxBps);
    if (txEl) txEl.textContent = fmtBps(io.txBps);
  }, 1000);
}

function handleXferProgress(msg) {
  const x = State.xfer;
  const dir = String(msg.dir || "");
  const phase = String(msg.phase || "");
  const msgLabel = String(msg.label || "").trim();

  // Clear any pending hide timer on new activity
  if (x.hideTimer) { clearTimeout(x.hideTimer); x.hideTimer = null; }

  // Update transfer state
  if (phase === "start") {
    x.active = true;
    x.dir = dir;
    x.label = msgLabel;
    x.totalBytes = Number(msg.totalBytes || 0);
    x.doneBytes = 0;
    x.chunkCount = Number(msg.chunkCount || 0);
    x.chunkDone = 0;
    x.totalRows = Number(msg.totalRows || 0);
    x.importedRows = 0;
  } else if (phase === "chunk") {
    x.active = true;
    x.dir = dir;
    if (msgLabel) x.label = msgLabel;
    const prev = x.doneBytes;
    x.doneBytes = dir === "tx" ? Number(msg.sentBytes || 0) : Number(msg.recvBytes || 0);
    x.chunkDone = dir === "tx" ? Number(msg.chunk || 0) : Number(msg.batch || 0);
    // Feed actual bytes into the speed tracker
    const delta = x.doneBytes - prev;
    if (delta > 0) { dir === "tx" ? netIOTrackTx(delta) : netIOTrackRx(delta); }
  } else if (phase === "done") {
    x.active = true;
    if (msgLabel) x.label = msgLabel;
    x.doneBytes = dir === "tx" ? Number(msg.sentBytes || msg.totalBytes || x.doneBytes) : Number(msg.recvBytes || x.doneBytes);
    x.importedRows = Number(msg.importedRows || 0);
    if (x.totalBytes === 0) x.totalBytes = x.doneBytes; // fill total for rx
    x.hideTimer = setTimeout(() => {
      x.active = false;
      x.label = "";
      renderXferPanel();
      x.hideTimer = null;
    }, 3500);
  } else if (phase === "error") {
    x.active = true;
    if (msgLabel) x.label = msgLabel;
    x.hideTimer = setTimeout(() => {
      x.active = false;
      x.label = "";
      renderXferPanel();
      x.hideTimer = null;
    }, 3000);
  }

  renderXferPanel();
}

function renderXferPanel() {
  const panel = document.getElementById("xferPanel");
  if (!panel) return;
  const x = State.xfer;

  if (!x.active) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  const dirIcon = document.getElementById("xferDirIcon");
  const labelEl = document.getElementById("xferLabel");
  const pctEl = document.getElementById("xferPct");
  const fillEl = document.getElementById("xferBarFill");
  const currEl = document.getElementById("xferSizeCurr");
  const totalEl = document.getElementById("xferSizeTotal");

  if (dirIcon) dirIcon.textContent = x.dir === "tx" ? "↑" : "↓";
  if (dirIcon) dirIcon.className = `xfer-dir-icon xfer-dir-${x.dir || "rx"}`;

  const done = x.doneBytes;
  const total = x.totalBytes;
  const known = total > 0;
  const pct = known ? Math.min(100, Math.round((done / total) * 100)) : 0;

  if (fillEl) {
    if (known) {
      fillEl.style.width = `${pct}%`;
      fillEl.classList.remove("xfer-bar-indeterminate");
    } else {
      fillEl.style.width = "100%";
      fillEl.classList.add("xfer-bar-indeterminate");
    }
  }

  if (labelEl) {
    const custom = String(x.label || "").trim();
    if (custom) {
      const suffix =
        x.chunkCount > 1
          ? ` · ${Math.max(0, Number(x.chunkDone || 0))}/${Math.max(0, Number(x.chunkCount || 0))}`
          : x.chunkDone > 0
            ? ` · ${Math.max(0, Number(x.chunkDone || 0))}`
            : "";
      labelEl.textContent = `${custom}${suffix}`;
    } else if (x.dir === "tx") {
      const cStr = x.chunkCount > 1 ? ` · chunk ${x.chunkDone}/${x.chunkCount}` : "";
      labelEl.textContent = `Pushing${cStr}`;
    } else {
      const bStr = x.chunkDone > 0 ? ` · batch ${x.chunkDone}` : "";
      labelEl.textContent = `Pulling${bStr}`;
    }
  }

  if (pctEl) pctEl.textContent = known ? `${pct}%` : "…";
  if (currEl) currEl.textContent = fmtBytes(done);
  if (totalEl) totalEl.textContent = known ? fmtBytes(total) : "?";
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

function renderEmptyRow(tbody, colspan, message) {
  if (!tbody) return;
  const tr = el("tr", "table-empty");
  tr.innerHTML = `<td colspan="${colspan}">${message}</td>`;
  tbody.appendChild(tr);
}
const duration_min = (ts1, ts2) => {
  if (!ts1 || !ts2) return "—";
  return Math.round((ts2 - ts1) / 60000) + "m";
};

function severityRank(sev) {
  return { critical: 4, fault: 3, warning: 2, info: 1 }[sev] || 0;
}

function higherSeverity(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return severityRank(b) > severityRank(a) ? b : a;
}

function alarmKey(inv, unit) {
  return `${Number(inv) || 0}_${Number(unit) || 0}`;
}

function syncActiveAlarmMap(rows) {
  const next = {};
  (rows || []).forEach((r) => {
    if (r?.cleared_ts) return;
    if (!isConfiguredNodeClient(r?.inverter, r?.unit)) return;
    const k = alarmKey(r?.inverter, r?.unit);
    if (!k || k === "0_0") return;
    const alarmValue = Number(r.alarm_value || 0);
    const candidate = {
      id: Number(r.id || 0),
      inverter: Number(r.inverter || 0),
      unit: Number(r.unit || 0),
      alarm_value: alarmValue,
      severity: r.severity || getRowSev(alarmValue) || "fault",
      acknowledged: !!r.acknowledged,
      ts: Number(r.ts || Date.now()),
      alarm_hex: normalizeAlarmHex(r.alarm_hex, alarmValue),
    };
    const prev = next[k];
    if (!prev) {
      next[k] = candidate;
      return;
    }
    if (
      candidate.ts > prev.ts ||
      (candidate.ts === prev.ts && candidate.id > prev.id)
    ) {
      next[k] = candidate;
    }
  });
  State.activeAlarms = next;
}

function getOrCreateAlarmAudioCtx() {
  if (State.alarmAudioCtx) return State.alarmAudioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    State.alarmAudioCtx = new Ctx();
    return State.alarmAudioCtx;
  } catch (err) {
    console.warn("[app] AudioContext creation failed:", err.message);
    return null;
  }
}

function playAlarmBeepOnce() {
  try {
    const ctx = getOrCreateAlarmAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 980;
    gain.gain.value = 0.028;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t0 = ctx.currentTime;
    osc.start(t0);
    osc.stop(t0 + 0.16);
  } catch (err) {
    console.warn("[app] alarm beep failed:", err.message);
  }
}

function setAlarmSoundActive(active) {
  if (!active) {
    if (State.alarmSoundTimer) {
      clearInterval(State.alarmSoundTimer);
      State.alarmSoundTimer = null;
    }
    return;
  }
  if (State.alarmSoundTimer) return;
  playAlarmBeepOnce();
  State.alarmSoundTimer = setInterval(playAlarmBeepOnce, 1600);
}
function resetPacTodayIfNeeded(ts = Date.now()) {
  const d = dateStr(new Date(ts));
  if (State.pacToday.day === d) return;
  State.pacToday.day = d;
  State.pacToday.lastTs = 0;
  State.pacToday.lastTotalPacW = 0;
  State.pacToday.totalKwh = 0;
}

function getCurrentFreshTotalPacW(now = Date.now()) {
  let totalPacW = 0;
  Object.values(State.liveData || {}).forEach((d) => {
    const isFresh = now - Number(d?.ts || 0) <= DATA_FRESH_MS;
    if (!d?.online || !isFresh) return;
    totalPacW += Number(d?.pac || 0);
  });
  return totalPacW;
}

function applySyncedTodayKwh(totalKwh, syncedAt = Date.now()) {
  resetPacTodayIfNeeded(syncedAt);
  State.pacToday.totalKwh = Math.max(0, Number(totalKwh) || 0);
  State.pacToday.lastTs = syncedAt;
  State.pacToday.lastTotalPacW = getCurrentFreshTotalPacW(syncedAt);
  const meter = $("totalKwh");
  if (meter) {
    meter.title = `Synced: ${fmtDateTime(syncedAt)}`;
  }
}

function integrateTodayFromPac(totals) {
  const now = Date.now();
  resetPacTodayIfNeeded(now);
  // Keep header total MWh server-authoritative so it matches report/energy outputs.
  State.pacToday.lastTs = now;
  State.pacToday.lastTotalPacW = getCurrentFreshTotalPacW(now);
}
function renderTodayKwhFromPac() {
  const el = $("totalKwh");
  if (el && el.firstChild) el.firstChild.nodeValue = fmtMWh(State.pacToday.totalKwh, 3);
}

async function fetchTodayEnergyTotalsRaw() {
  const r = await fetch("/api/energy/today", {
    method: "GET",
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return r.json();
}

async function seedTodayEnergyFromDb() {
  try {
    const rows = await fetchTodayEnergyTotalsRaw();
    const totalKwh = (rows || []).reduce(
      (sum, r) => sum + Number(r?.total_kwh || 0),
      0,
    );
    applySyncedTodayKwh(totalKwh, Date.now());
    renderTodayKwhFromPac();
  } catch (e) {
    console.warn("seedTodayEnergyFromDb:", e?.message || e);
  }
}

async function syncTodayMwhFromServer() {
  try {
    const rows = await fetchTodayEnergyTotalsRaw();
    const totalKwh = (rows || []).reduce(
      (sum, r) => sum + Number(r?.total_kwh || 0),
      0,
    );
    applySyncedTodayKwh(totalKwh, Date.now());
    renderTodayKwhFromPac();
  } catch (e) {
    // Non-fatal: live integration keeps the metric moving between sync polls.
    console.warn("syncTodayMwhFromServer:", e?.message || e);
  }
}

function stopTodayMwhSyncTimer() {
  if (State.todayMwhSyncTimer) {
    clearInterval(State.todayMwhSyncTimer);
    State.todayMwhSyncTimer = null;
  }
}

function startTodayMwhSyncTimer() {
  stopTodayMwhSyncTimer();
  syncTodayMwhFromServer().catch(() => {});
  State.todayMwhSyncTimer = setInterval(() => {
    syncTodayMwhFromServer().catch(() => {});
  }, TODAY_MWH_SYNC_INTERVAL_MS);
}

// ─── API fetch wrapper with enhanced error handling ──────────────────────────
function getDetailedErrorMessage(status, errorMsg) {
  // Provide user-friendly error messages with recovery suggestions
  if (status === 0 || status === undefined) {
    return "Network error. Please check your connection.";
  }
  if (status === 400 || status === 422) {
    return `Validation error: ${errorMsg}. Please check your input.`;
  }
  if (status === 401 || status === 403) {
    return "Authentication failed. Please log in again.";
  }
  if (status === 404) {
    return `Resource not found: ${errorMsg}`;
  }
  if (status === 500 || status === 502 || status === 503) {
    return "Server error. Please try again in a moment.";
  }
  if (status >= 500) {
    return `Server error (${status}). The backend service may be unavailable.`;
  }
  return errorMsg || "Request failed. Please try again.";
}

function shouldShowProgress(url, method = "GET", options = {}) {
  if (Object.prototype.hasOwnProperty.call(options || {}, "progress")) {
    return Boolean(options.progress);
  }
  const m = String(method || "GET").toUpperCase();
  // Keep strip for explicit user actions (POST/PUT/PATCH/DELETE) only.
  return m !== "GET";
}

async function api(url, method = "GET", body, options = {}) {
  const showProgress = shouldShowProgress(url, method, options);
  if (showProgress) beginProgress(getProgressLabel(url, method));
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  if (opts.body) netIOTrackTx(opts.body.length);
  let ok = false;
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    if (text) netIOTrackRx(text.length);
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (err) {
      console.warn("[app] API response JSON parse failed:", err.message);
      parsed = null;
    }
    if (!r.ok) {
      const rawMsg =
        parsed?.error ||
        parsed?.message ||
        (text && text.trim()) ||
        `HTTP ${r.status}`;
      let detailedMsg = getDetailedErrorMessage(r.status, rawMsg);
      if (
        url.includes("/api/forecast/generate") &&
        Number(r.status) >= 500
      ) {
        const providerAttempt = Array.isArray(parsed?.attempts)
          ? parsed.attempts
              .filter((a) => a && a.provider)
              .map((a) =>
                `${String(a.provider)}: ${a.ok ? "ok" : String(a.error || "failed")}`,
              )
              .join(" | ")
          : "";
        const detailText = String(parsed?.details || "").trim();
        const errText = String(parsed?.error || rawMsg || "").trim();
        const parts = [errText, detailText, providerAttempt].filter(Boolean);
        if (parts.length) detailedMsg = parts.join(" :: ");
      }
      if (
        url.includes("/api/replication/pull-now") ||
        url.includes("/api/replication/push-now") ||
        url.includes("/api/replication/reconcile-now")
      ) {
        detailedMsg = String(rawMsg || detailedMsg);
      }
      throw new Error(String(detailedMsg));
    }
    ok = true;
    return parsed ?? {};
  } catch (err) {
    // Network error or parsing failure
    if (err instanceof TypeError) {
      console.warn("[app] Network error:", err.message);
      throw new Error("Network error. Please check your internet connection.");
    }
    throw err;
  } finally {
    if (showProgress) endProgress(ok ? "Done" : "Request failed");
  }
}

// ─── Window controls (Electron) ───────────────────────────────────────────────
function winCtrl(a) {
  if (window.electronAPI) {
    if (a === "minimize") window.electronAPI.minimize();
    if (a === "maximize") window.electronAPI.maximize();
    if (a === "close") window.electronAPI.close();
  }
}

async function pickExportFolder() {
  const current = $("setCsvPath").value || State.settings.csvSavePath;
  if (window.electronAPI?.pickFolder) {
    const picked = await window.electronAPI.pickFolder(current);
    if (!picked) return;
    $("setCsvPath").value = picked;
    State.settings.csvSavePath = picked;
    showMsg(
      "settingsMsg",
      "Folder selected. Click Save Settings to apply.",
      "",
    );
    return;
  }

  // Browser fallback
  const manual = prompt(
    "Enter export folder path:",
    current || "C:\\Logs\\InverterDashboard",
  );
  if (!manual) return;
  $("setCsvPath").value = manual;
  State.settings.csvSavePath = manual;
  showMsg("settingsMsg", "Folder set. Click Save Settings to apply.", "");
}

async function openExportFolder() {
  const p = String(
    $("setCsvPath").value || State.settings.csvSavePath || "",
  ).trim();
  if (!p) {
    showMsg("settingsMsg", "Set export folder first.", "error");
    return;
  }

  if (window.electronAPI?.openFolder) {
    const ok = await window.electronAPI.openFolder(p);
    if (!ok) showMsg("settingsMsg", "Unable to open export folder.", "error");
    return;
  }

  if (window.electronAPI?.openLogs) {
    window.electronAPI.openLogs(p);
    return;
  }

  alert(`Export folder: ${p}`);
}

function openLogsFolder() {
  // Backward compatibility
  openExportFolder();
}
const REMOTE_GATEWAY_DEFAULT_PORT = 3500;

function normalizeRemoteGatewayUrlInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw);
  const candidate = hasScheme ? raw : `http://${raw}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname) return "";
    if (!u.port) u.port = String(REMOTE_GATEWAY_DEFAULT_PORT);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function applyRemoteGatewayInputNormalization() {
  const input = $("setRemoteGatewayUrl");
  if (!input) return "";
  const raw = String(input.value || "").trim();
  if (!raw) {
    input.value = "";
    return "";
  }
  const normalized = normalizeRemoteGatewayUrlInput(raw);
  if (normalized) input.value = normalized;
  return normalized;
}

function isClientModeActive() {
  const modeSetting = $("setOperationMode")?.value || State.settings?.operationMode;
  return String(modeSetting || "gateway").trim().toLowerCase() === "remote";
}

function syncDayAheadGeneratorAvailability() {
  const isClient = isClientModeActive();
  const input = $("genDayCount");
  const btn = document.querySelector(".analytics-gen-btn");
  const res = $("genDayResult");
  if (input) {
    input.disabled = isClient;
    input.readOnly = isClient;
    input.title = isClient
      ? "Day-ahead generation is available on Gateway mode only."
      : "";
  }
  if (btn) {
    btn.disabled = isClient;
    btn.setAttribute("aria-disabled", isClient ? "true" : "false");
    btn.title = isClient
      ? "Unavailable in Client mode. Use the Gateway server to generate day-ahead."
      : "";
  }
  if (res) {
    if (isClient) {
      res.className = "exp-result";
      res.textContent =
        "Day-ahead generation is disabled in Client mode. Generate on the Gateway server.";
    } else if (
      res.textContent &&
      /disabled in Client mode/i.test(String(res.textContent))
    ) {
      res.textContent = "";
    }
  }
}

function notifyClientModeUnavailable(featureLabel) {
  const safeFeature = String(featureLabel || "This feature");
  showToast(
    `${safeFeature} is unavailable in Client mode. Switch to Gateway mode in Settings.`,
    "warning",
    4200,
  );
}

function openIpConfigSettings() {
  if (isClientModeActive()) {
    notifyClientModeUnavailable("IP Configuration");
    return;
  }
  if (window.electronAPI?.openIpConfigWindow) {
    window.electronAPI.openIpConfigWindow();
    return;
  }
  window.location.href = "/ip-config.html";
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setSideNavOpen(open, persist = true) {
  const isOpen = !!open;
  document.body.classList.toggle("sidebar-open", isOpen);
  const toggleBtn = $("navToggleBtn");
  if (toggleBtn)
    toggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  if (persist) {
    try {
      localStorage.setItem("adsi_side_nav_open", isOpen ? "1" : "0");
    } catch (err) {
      console.warn("[app] nav state persist failed:", err.message);
    }
  }
}

function setupSideNav() {
  const toggleBtn = $("navToggleBtn");
  const sideNav = $("sideNav");
  // Always start closed on app load.
  setSideNavOpen(false, false);
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const next = !document.body.classList.contains("sidebar-open");
      setSideNavOpen(next, true);
    });
  }

  // Auto-hide sidebar when clicking outside it.
  document.addEventListener("pointerdown", (ev) => {
    if (!document.body.classList.contains("sidebar-open")) return;
    const target = ev.target;
    if (!target) return;
    if (toggleBtn && toggleBtn.contains(target)) return;
    if (sideNav && sideNav.contains(target)) return;
    setSideNavOpen(false, true);
  });
}

function setupNav() {
  const nav = $("mainNav");
  if (!nav) return;
  nav.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.page));
  });
}
function switchPage(page) {
  State.currentPage = page;
  if (page !== "analytics") {
    stopAnalyticsRealtime();
    stopAnalyticsAutoRefresh();
  }
  if (page !== "settings") {
    stopReplicationHealthPolling();
  }
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.remove("active"));
  const pg = $("page-" + page);
  if (pg) pg.classList.add("active");
  const btn = document.querySelector(`[data-page="${page}"]`);
  if (btn) btn.classList.add("active");
  if (window.innerWidth <= 1200) setSideNavOpen(false, true);

  if (page === "alarms") initAlarmsPage();
  if (page === "analytics") initAnalytics();
  if (page === "energy") initEnergyPage();
  if (page === "audit") initAuditPage();
  if (page === "report") initReportPage();
  if (page === "export") initExportPage();
  if (page === "settings") {
    unlockSettingsInputs();
    refreshLicenseSection().catch(() => {});
    startReplicationHealthPolling();
  }
}

function openGuideModal() {
  const m = $("guideModal");
  if (!m) return;
  m.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeGuideModal() {
  const m = $("guideModal");
  if (!m) return;
  m.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function initGuideModal() {
  const m = $("guideModal");
  if (!m || m.dataset.bound === "1") return;
  m.dataset.bound = "1";
  m.addEventListener("click", (e) => {
    if (e.target === m) closeGuideModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && m && !m.classList.contains("hidden")) {
      closeGuideModal();
    }
  });
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const n = new Date();
    $("clock").textContent =
      `${pad2(n.getHours())}:${pad2(n.getMinutes())}:${pad2(n.getSeconds())}`;
    $("dateLbl").textContent =
      `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())} PHT`;
  }
  tick();
  State.clockTimer = setInterval(tick, 1000);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s = await api("/api/settings");
    State.settings = { ...State.settings, ...s };
    State.settings.invGridLayout = normalizeInvGridLayout(s.invGridLayout);
    State.settings.exportUiState = sanitizeExportUiStateClient(
      s.exportUiState || {},
    );
    if ($("plantNameDisplay"))
      $("plantNameDisplay").textContent = s.plantName || "Solar Plant";
    $("setPlantName").value = s.plantName || "";
    $("setOperatorName").value = s.operatorName || "OPERATOR";
    $("setOperationMode").value = s.operationMode || "gateway";
    if ($("setRemoteAutoSync")) {
      $("setRemoteAutoSync").checked = Boolean(s.remoteAutoSync);
    }
    $("setRemoteGatewayUrl").value = s.remoteGatewayUrl || "";
    $("setRemoteApiToken").value = s.remoteApiToken || "";
    const tsHint = s.tailscaleDeviceHint || s.wireguardInterface || "";
    if ($("setTailscaleDeviceHint")) {
      $("setTailscaleDeviceHint").value = tsHint;
    }
    $("setInverterCount").value = s.inverterCount || 27;
    $("setNodeCount").value = s.nodeCount || 4;
    $("setApiUrl").value = s.apiUrl || "";
    $("setWriteUrl").value = s.writeUrl || "";
    $("setCsvPath").value = s.csvSavePath || "";
    $("setRetainDays").value = s.retainDays || 90;
    $("setForecastProvider").value = s.forecastProvider || "ml_local";
    $("setSolcastBaseUrl").value =
      s.solcastBaseUrl || "https://api.solcast.com.au";
    $("setSolcastApiKey").value = s.solcastApiKey || "";
    $("setSolcastResourceId").value = s.solcastResourceId || "";
    $("setSolcastTimezone").value = s.solcastTimezone || "Asia/Manila";
    $("setDataDir").textContent = s.dataDir || "—";
    const pc = s.inverterPollConfig || {};
    if ($("setPollModbusTimeout"))  $("setPollModbusTimeout").value  = pc.modbusTimeout  ?? 1.0;
    if ($("setPollReconnectDelay")) $("setPollReconnectDelay").value = pc.reconnectDelay ?? 0.5;
    if ($("setPollReadSpacing"))    $("setPollReadSpacing").value    = pc.readSpacing    ?? 0.005;
    if ($("invGridLayout")) $("invGridLayout").value = State.settings.invGridLayout;
    applyInverterGridLayout(State.settings.invGridLayout);
    const providerSel = $("setForecastProvider");
    if (providerSel && providerSel.dataset.bound !== "1") {
      providerSel.dataset.bound = "1";
      providerSel.addEventListener("change", syncForecastProviderUi);
    }
    applyExportUiStateToInputs(State.settings.exportUiState);
    unlockSettingsInputs();
    syncOperationModeUi();
    syncForecastProviderUi();
    refreshLicenseSection().catch(() => {});
  } catch (e) {
    console.warn("[Settings] load failed:", e.message);
  }
}

function unlockSettingsInputs() {
  const root = $("page-settings");
  if (!root) return;
  root.querySelectorAll("input, select, textarea").forEach((ctrl) => {
    ctrl.disabled = false;
    ctrl.readOnly = false;
    ctrl.removeAttribute("disabled");
    ctrl.removeAttribute("readonly");
  });
}

function syncForecastProviderUi() {
  const provider = String($("setForecastProvider")?.value || "ml_local")
    .trim()
    .toLowerCase();
  const useSolcast = provider === "solcast";
  [
    "setSolcastBaseUrl",
    "setSolcastApiKey",
    "setSolcastResourceId",
    "setSolcastTimezone",
  ].forEach((id) => {
    const ctrl = $(id);
    if (!ctrl) return;
    ctrl.disabled = !useSolcast;
  });
}

function syncOperationModeUi() {
  const mode = String($("setOperationMode")?.value || "gateway")
    .trim()
    .toLowerCase();
  const remote = mode === "remote";
  // Keep connectivity inputs editable in both modes so users can preconfigure
  // remote access while staying in Gateway mode.
  ["setRemoteGatewayUrl", "setRemoteApiToken", "setTailscaleDeviceHint"].forEach(
    (id) => {
      const ctrl = $(id);
      if (!ctrl) return;
      ctrl.disabled = false;
      ctrl.readOnly = false;
    },
  );
  showMsg(
    "networkMsg",
    remote
      ? `Remote mode selected. ${$("setRemoteAutoSync")?.checked ? "Startup Auto Sync is enabled." : "Startup Auto Sync is disabled; use manual Pull/Push."}`
      : "Gateway mode selected. Local polling is active; remote/Tailscale fields are optional.",
    "",
  );
  syncDayAheadGeneratorAvailability();
}

async function saveSettings() {
  const normalizedGateway = applyRemoteGatewayInputNormalization();
  const body = {
    plantName: $("setPlantName").value,
    operatorName: $("setOperatorName").value,
    operationMode: $("setOperationMode").value,
    remoteAutoSync: Boolean($("setRemoteAutoSync")?.checked),
    remoteGatewayUrl:
      normalizedGateway || String($("setRemoteGatewayUrl").value || "").trim(),
    remoteApiToken: $("setRemoteApiToken").value,
    tailscaleDeviceHint: $("setTailscaleDeviceHint")?.value || "",
    inverterCount: Number($("setInverterCount").value),
    nodeCount: Number($("setNodeCount").value),
    apiUrl: $("setApiUrl").value,
    writeUrl: $("setWriteUrl").value,
    csvSavePath: $("setCsvPath").value,
    retainDays: Number($("setRetainDays").value),
    forecastProvider: $("setForecastProvider").value,
    solcastBaseUrl: $("setSolcastBaseUrl").value,
    solcastApiKey: $("setSolcastApiKey").value,
    solcastResourceId: $("setSolcastResourceId").value,
    solcastTimezone: $("setSolcastTimezone").value,
    inverterPollConfig: {
      modbusTimeout:  Number($("setPollModbusTimeout")?.value  ?? 1.0),
      reconnectDelay: Number($("setPollReconnectDelay")?.value ?? 0.5),
      readSpacing:    Number($("setPollReadSpacing")?.value    ?? 0.005),
    },
  };
  try {
    const saved = await api("/api/settings", "POST", body);
    const nextCsvPath =
      String(saved?.csvSavePath || body.csvSavePath || "").trim() ||
      State.settings.csvSavePath;
    if ($("setCsvPath")) $("setCsvPath").value = nextCsvPath;
    State.settings = { ...State.settings, ...body, csvSavePath: nextCsvPath };
    if ($("plantNameDisplay"))
      $("plantNameDisplay").textContent = body.plantName;
    showMsg(
      "settingsMsg",
      saved?.exportDirCreated
        ? "✔ Settings saved. Export folder created."
        : "✔ Settings saved",
      "",
    );
    buildInverterGrid();
    buildSelects();
    syncDayAheadGeneratorAvailability();
    syncOperationModeUi();
    if (State.currentPage === "settings") {
      startReplicationHealthPolling();
      refreshReplicationHealth(true).catch(() => {});
    }
    return true;
  } catch (e) {
    showMsg("settingsMsg", "✗ Save failed: " + e.message, "error");
    return false;
  }
}

async function testRemoteGateway() {
  const btn = $("btnTestRemoteGateway");
  if (btn) btn.disabled = true;
  showMsg("networkMsg", "Testing remote gateway...", "");
  try {
    const normalizedGateway = applyRemoteGatewayInputNormalization();
    const r = await api("/api/runtime/network/test", "POST", {
      remoteGatewayUrl:
        normalizedGateway ||
        String($("setRemoteGatewayUrl")?.value || "").trim(),
      remoteApiToken: $("setRemoteApiToken")?.value || "",
    });
    const latency = Number(r?.latencyMs || 0);
    const nodes = Number(r?.liveNodeCount || 0);
    showMsg(
      "networkMsg",
      `✔ Remote gateway reachable (${nodes} node(s), ${latency} ms)`,
      "",
    );
  } catch (e) {
    showMsg("networkMsg", `✗ ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkTailscaleStatus() {
  const btn = $("btnCheckTailscale");
  if (btn) btn.disabled = true;
  showMsg("networkMsg", "Checking Tailscale...", "");
  try {
    const hint = $("setTailscaleDeviceHint")?.value || "";
    const q = hint ? `?deviceHint=${encodeURIComponent(hint)}` : "";
    const r = await api(`/api/tailscale/status${q}`);
    if (!r?.installed) {
      showMsg("networkMsg", "✗ Tailscale is not installed on this device.", "error");
      return;
    }
    if (r?.connected) {
      const label = r?.self?.dnsName || r?.self?.hostName || "this node";
      showMsg(
        "networkMsg",
        `✔ Tailscale connected (${label}${Array.isArray(r?.tailscaleIps) && r.tailscaleIps[0] ? `, ${r.tailscaleIps[0]}` : ""}).`,
        "",
      );
      return;
    }
    const backend = String(r?.backendState || "unknown");
    const health = Array.isArray(r?.health) && r.health.length
      ? ` | ${r.health[0]}`
      : "";
    showMsg(
      "networkMsg",
      `⚠ Tailscale installed but not fully connected (state: ${backend})${health}.`,
      "error",
    );
  } catch (e) {
    showMsg("networkMsg", `✗ ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setReplicationField(id, value, cls = "") {
  const node = $(id);
  if (!node) return;
  node.textContent = value == null || value === "" ? "—" : String(value);
  node.className = `license-value ${cls}`.trim();
}

function fmtTsWithAge(ts) {
  const n = Number(ts || 0);
  if (!n) return "—";
  return `${fmtDateTime(n)} (${relTime(n)})`;
}

function fmtUptimeSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatSyncDirection(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  const map = {
    idle: "Idle",
    "startup-auto-sync": "Startup auto sync",
    "startup-auto-sync-failed": "Startup auto sync failed",
    "pull-only": "Pull only",
    "pull-live": "Live pull",
    "pull-live-failed": "Live pull failed",
    "push-then-pull": "Push then pull",
    "push-full": "Push full",
    "push-full-failed": "Push full failed",
    "push-failed": "Push failed",
    "pull-full": "Full pull",
    "pull-full-failed": "Full pull failed",
    "pull-incremental": "Incremental pull",
    "pull-incremental-failed": "Incremental pull failed",
  };
  return map[v] || (v ? v.replace(/[-_]/g, " ") : "—");
}

function stopReplicationHealthPolling() {
  if (State.replicationHealthTimer) {
    clearInterval(State.replicationHealthTimer);
    State.replicationHealthTimer = null;
  }
}

function startReplicationHealthPolling() {
  stopReplicationHealthPolling();
  refreshReplicationHealth().catch(() => {});
  refreshRuntimePerf().catch(() => {});
  State.replicationHealthTimer = setInterval(() => {
    if (State.currentPage !== "settings") return;
    refreshReplicationHealth().catch(() => {});
    refreshRuntimePerf().catch(() => {});
  }, 6000);
}

async function refreshReplicationHealth(silent = true) {
  try {
    const n = await api("/api/runtime/network");
    const mode = String(n?.operationMode || State.settings.operationMode || "gateway")
      .trim()
      .toLowerCase();
    const pullOnly = Boolean(n?.remotePullOnly);
    const connected = Boolean(n?.remoteConnected);
    setReplicationField("repModeVal", mode === "remote" ? "Remote" : "Gateway");
    setReplicationField(
      "repGatewayVal",
      String(n?.remoteGatewayUrl || "—").trim() || "—",
    );
    setReplicationField(
      "repConnectedVal",
      mode === "remote"
        ? connected
          ? "Connected"
          : "Disconnected"
        : "Gateway local polling",
      mode === "remote" ? (connected ? "ok" : "warn") : "",
    );
    const directionRaw = pullOnly
      ? "pull-live-only"
      : String(n?.remoteLastSyncDirection || "idle");
    const directionClass =
      /failed/i.test(directionRaw)
        ? "error"
        : /push|pull/i.test(directionRaw)
          ? "ok"
          : "";
    setReplicationField(
      "repDirectionVal",
      formatSyncDirection(directionRaw),
      directionClass,
    );
    setReplicationField("repLastSuccessVal", fmtTsWithAge(n?.remoteLastSuccessTs || 0));
    setReplicationField(
      "repLastReplicationVal",
      fmtTsWithAge(n?.remoteLastReplicationTs || 0),
    );
    setReplicationField(
      "repLastRowsVal",
      Number(n?.remoteLastReplicationRows || 0).toLocaleString(),
    );
    setReplicationField(
      "repLastReconcileVal",
      fmtTsWithAge(n?.remoteLastReconcileTs || 0),
    );
    setReplicationField(
      "repLastReconcileRowsVal",
      Number(n?.remoteLastReconcileRows || 0).toLocaleString(),
    );
    const sig = String(n?.remoteLastReplicationSignature || "").trim();
    setReplicationField("repSignatureVal", sig ? `${sig.slice(0, 16)}…` : "—");
    const cursors = n?.remoteReplicationCursors || {};
    const cNode = $("repCursorsVal");
    if (cNode) cNode.textContent = pullOnly ? "N/A (pull-only)" : JSON.stringify(cursors);
    const bridgeErr = String(n?.remoteLastError || "").trim();
    const repErr = String(n?.remoteLastReplicationError || "").trim();
    const recErr = String(n?.remoteLastReconcileError || "").trim();
    const allErr = [bridgeErr, repErr, recErr].filter(Boolean);
    setReplicationField(
      "repErrorsVal",
      allErr.length ? allErr.join(" | ") : "None",
      allErr.length ? "warn" : "ok",
    );
    const pullBtn = $("btnRunReplicationPull");
    const pushBtn = $("btnRunReplicationPush");
    const manualDisabled = mode !== "remote";
    if (pullBtn) {
      pullBtn.disabled = manualDisabled;
      pullBtn.title = manualDisabled
        ? "Available only in Remote mode."
        : "Pull latest DB snapshot from server.";
    }
    if (pushBtn) {
      pushBtn.disabled = manualDisabled;
      pushBtn.title = manualDisabled
        ? "Available only in Remote mode."
        : "Push local DB snapshot to server, then pull back.";
    }
    if (!silent) {
      showMsg("replicationMsg", "✔ Replication health refreshed", "");
    }
  } catch (e) {
    if (!silent) showMsg("replicationMsg", `✗ ${e.message}`, "error");
  }
}

async function refreshRuntimePerf(silent = true) {
  try {
    const p = await api("/api/runtime/perf");
    const proc = p?.process || {};
    const poll = p?.poller || {};
    const ws = p?.ws || {};
    const remote = p?.remote || {};
    const mode = String(p?.operationMode || "gateway")
      .trim()
      .toLowerCase();

    setReplicationField("perfModeVal", mode === "remote" ? "Remote" : "Gateway");
    setReplicationField(
      "perfCpuVal",
      `${Number(proc?.cpuPercent || 0).toFixed(2)}%`,
    );
    setReplicationField(
      "perfMemVal",
      `${Number(proc?.memoryMb?.rss || 0).toFixed(2)} MB`,
    );
    setReplicationField("perfUptimeVal", fmtUptimeSec(proc?.uptimeSec || 0));
    setReplicationField(
      "perfLiveKeysVal",
      Number(poll?.liveKeyCount || 0).toLocaleString(),
    );
    setReplicationField(
      "perfPollTicksVal",
      Number(poll?.tickCount || 0).toLocaleString(),
    );
    setReplicationField(
      "perfPollDurVal",
      `last ${Number(poll?.lastPollDurationMs || 0).toFixed(1)} ms | avg ${Number(poll?.avgPollDurationMs || 0).toFixed(1)} ms | max ${Number(poll?.maxPollDurationMs || 0).toFixed(1)} ms`,
    );
    setReplicationField(
      "perfFetchErrVal",
      `${Number(poll?.fetchErrorCount || 0).toLocaleString()} error(s) / ${Number(poll?.fetchOkCount || 0).toLocaleString()} ok`,
      Number(poll?.fetchErrorCount || 0) > 0 ? "warn" : "ok",
    );
    setReplicationField(
      "perfPersistRowsVal",
      Number(poll?.rowsPersisted || 0).toLocaleString(),
    );
    setReplicationField(
      "perfPersistSkipVal",
      Number(poll?.rowsPersistSkippedCadence || 0).toLocaleString(),
    );
    setReplicationField(
      "perfWsClientsVal",
      Number(ws?.connectedClients || 0).toLocaleString(),
    );
    setReplicationField(
      "perfWsDropsVal",
      Number(ws?.droppedFramesBackpressure || 0).toLocaleString(),
      Number(ws?.droppedFramesBackpressure || 0) > 0 ? "warn" : "ok",
    );

    const errs = [
      String(poll?.lastFetchError || "").trim(),
      String(remote?.lastError || "").trim(),
      String(remote?.lastReplicationError || "").trim(),
    ].filter(Boolean);
    setReplicationField(
      "perfErrorsVal",
      errs.length ? errs.join(" | ") : "None",
      errs.length ? "warn" : "ok",
    );
    if (!silent) showMsg("perfMsg", "✔ Performance refreshed", "");
  } catch (e) {
    if (!silent) showMsg("perfMsg", `✗ ${e.message}`, "error");
  }
}

function ensureRemoteModeForReplicationActions() {
  const mode = String($("setOperationMode")?.value || State.settings.operationMode || "gateway")
    .trim()
    .toLowerCase();
  if (mode !== "remote") {
    showMsg(
      "replicationMsg",
      "Replication actions are available only in Remote mode.",
      "error",
    );
    return false;
  }
  return true;
}

async function runReplicationPullNow() {
  if (!ensureRemoteModeForReplicationActions()) return;
  if (
    !window.confirm(
      "Pull latest data from server now?\n\nThis will reload local client data from the gateway snapshot.",
    )
  ) {
    return;
  }

  const btn = $("btnRunReplicationPull");
  if (btn) btn.disabled = true;
  showMsg("replicationMsg", "Pulling latest data from server...", "");
  try {
    const result = await api("/api/replication/pull-now", "POST", {});
    const importedRows = Number(
      result?.incremental?.importedRows || result?.full?.importedRows || 0,
    );
    const mode = String(result?.mode || "incremental");
    const hasMore =
      mode === "incremental-partial" && Boolean(result?.incremental?.hasMore);
    const dir = formatSyncDirection(result?.direction || "idle");
    showMsg(
      "replicationMsg",
      `✔ Pull complete (${dir}) | mode=${mode}${hasMore ? " (partial)" : ""} | imported=${importedRows.toLocaleString()}`,
      "",
    );
    await refreshReplicationHealth(true);
    await refreshRuntimePerf(true);
  } catch (e) {
    showMsg("replicationMsg", `✗ ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runReplicationPushNow() {
  if (!ensureRemoteModeForReplicationActions()) return;
  if (
    !window.confirm(
      "Push local data to server now?\n\nThis sends local DB snapshot to gateway, then pulls back for consistency.",
    )
  ) {
    return;
  }

  const btn = $("btnRunReplicationPush");
  if (btn) btn.disabled = true;
  showMsg("replicationMsg", "Pushing local data to server...", "");
  try {
    const result = await api("/api/replication/push-now", "POST", {});
    const pushedRows = Number(result?.pushed?.importedRows || 0);
    const pulledRows = Number(
      result?.incremental?.importedRows || result?.full?.importedRows || 0,
    );
    const mode = String(result?.mode || "incremental");
    const hasMore =
      mode === "incremental-partial" && Boolean(result?.incremental?.hasMore);
    const dir = formatSyncDirection(result?.direction || "idle");
    showMsg(
      "replicationMsg",
      `✔ Push complete (${dir}) | mode=${mode}${hasMore ? " (partial)" : ""} | pushed=${pushedRows.toLocaleString()} pulled=${pulledRows.toLocaleString()}`,
      "",
    );
    await refreshReplicationHealth(true);
    await refreshRuntimePerf(true);
  } catch (e) {
    showMsg("replicationMsg", `✗ ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function testSolcastConnection() {
  const btn = $("btnSolcastTest");
  const payload = {
    solcastBaseUrl: $("setSolcastBaseUrl")?.value || "",
    solcastApiKey: $("setSolcastApiKey")?.value || "",
    solcastResourceId: $("setSolcastResourceId")?.value || "",
    solcastTimezone: $("setSolcastTimezone")?.value || "",
  };

  if (btn) btn.disabled = true;
  showMsg("solcastTestMsg", "Testing Solcast connection...", "");
  try {
    const r = await api("/api/forecast/solcast/test", "POST", payload);
    const covered = Array.isArray(r?.daysCovered) ? r.daysCovered.length : 0;
    const slots = Number(r?.dayAheadPreview?.slots || 0);
    const mwh = Number(r?.dayAheadPreview?.totalMwh || 0).toFixed(6);
    const msg =
      `✔ Solcast connected | records=${Number(r?.records || 0)} | days=${covered} | next-day slots=${slots} | next-day MWh=${mwh}`;
    showMsg("solcastTestMsg", msg, "");
    if (r?.warning) {
      showToast(`Solcast warning: ${r.warning}`, "warning", 4200);
    }
  } catch (e) {
    showMsg("solcastTestMsg", `✗ Solcast test failed: ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveAndTestSolcast() {
  const btn = $("btnSolcastSaveTest");
  if (btn) btn.disabled = true;
  try {
    const ok = await saveSettings();
    if (!ok) return;
    await testSolcastConnection();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showMsg(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = "smsg " + cls;
  setTimeout(() => {
    el.textContent = "";
    el.className = "smsg";
  }, 4000);
}

// ─── Inverter Grid ────────────────────────────────────────────────────────────
function buildInverterGrid() {
  const grid = $("invGrid");
  if (!grid) return;
  grid.innerHTML = "";
  State.nodeOrderSig = {};
  const count = State.settings.inverterCount;
  const nodes = State.settings.nodeCount || 4;
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= count; i++) {
    frag.appendChild(buildInverterCard(i, nodes));
  }
  frag.appendChild(buildBulkControlPanel());
  grid.appendChild(frag);
  applyInverterGridLayout(State.settings.invGridLayout);
}

function currentOperator() {
  const inState = String(State.settings.operatorName || "").trim();
  if (inState) return inState;
  const fromInput = String($("setOperatorName")?.value || "").trim();
  return fromInput || "OPERATOR";
}

function buildBulkControlPanel() {
  const wrap = el("div", "bulk-control-bar");
  wrap.innerHTML = `
    <div class="bulk-control-title">Bulk Inverter Command</div>
    <div class="bulk-control-main">
      <div class="bulk-range-wrap">
        <label class="bulk-range-label" for="bulkInvRangeInput">Inverter Numbers / Ranges</label>
        <input
          id="bulkInvRangeInput"
          class="inp bulk-range-input"
          type="text"
          inputmode="text"
          autocomplete="off"
          placeholder="1-13, 16, 18, 23-27"
        />
        <div class="bulk-range-helper">Accepts single values, ranges, or both. Duplicate inverter numbers are blocked.</div>
      </div>
      <div class="bulk-action-group">
        <button class="btn btn-outline" onclick="fillAllCommandTargets()">All Inverters</button>
        <button class="btn btn-outline" onclick="clearCommandTargets()">Clear</button>
      </div>
      <div class="bulk-action-group bulk-action-primary">
        <button class="btn btn-green" onclick="sendSelectedNodes(1)">START SELECTED</button>
        <button class="btn btn-red" onclick="sendSelectedNodes(0)">STOP SELECTED</button>
      </div>
    </div>`;
  return wrap;
}

function buildInverterCard(inv, nodeCount) {
  const card = el("div", "inv-card");
  card.id = `inv-card-${inv}`;
  card.innerHTML = `
    <div class="card-hdr">
      <div class="card-hdr-left">
        <div class="card-inv-icon" id="icon-${inv}">⚡</div>
        <div>
          <div class="card-title">INVERTER ${String(inv).padStart(2, "0")}</div>
        </div>
      </div>
      <div class="card-badges">
        <span class="badge badge-offline" id="badge-${inv}">OFFLINE</span>
      </div>
    </div>
    <div class="card-pac">
      <div class="pac-controls">
        <button class="card-ctrl-btn start" onclick="sendAllNodesInv(${inv},1)">Start</button>
        <button class="card-ctrl-btn stop" onclick="sendAllNodesInv(${inv},0)">Stop</button>
      </div>
      <div class="pac-cell">
        <div class="pac-label">DC POWER</div>
        <div class="pac-val zero" id="pdcsum-${inv}">0.00<span class="pac-unit">kW</span></div>
      </div>
      <div class="pac-cell">
        <div class="pac-label">AC POWER</div>
        <div class="pac-val zero" id="pac-${inv}">0.00<span class="pac-unit">kW</span></div>
      </div>
    </div>
    <div class="card-main">
      <div class="card-table-wrap">
        <table class="card-table">
          <thead>
            <tr><th>Node</th><th>Alarm</th><th>Pdc (W)</th><th>Pac (W)</th><th>Last Seen</th><th>Ctrl</th></tr>
          </thead>
          <tbody id="tbody-${inv}">
            ${buildNodeRows(inv, nodeCount)}
          </tbody>
        </table>
      </div>
    </div>`;
  return card;
}

function buildNodeRows(inv, nodeCount) {
  let html = "";
  const configured = new Set(getConfiguredUnits(inv, nodeCount));
  for (let n = 1; n <= nodeCount; n++) {
    const nodeConfigured = configured.has(n);
    const key = `${inv}_${n}`;
    const state = nodeConfigured ? State.nodeStates[key] || 0 : 0;
    const btnClass = nodeConfigured
      ? `node-btn ${state ? "cmd-stop" : "cmd-start"}`
      : "node-btn node-disabled";
    const btnText = nodeConfigured ? (state ? "STOP" : "START") : "ISOLATED";
    const btnTitle = nodeConfigured ? btnText : "Isolated";
    const btnAria = `Node ${n} ${nodeConfigured ? btnText : "Isolated"}`;
    html += `
      <tr id="row-${inv}-${n}" class="${nodeConfigured ? "" : "row-node-disabled"}">
        <td class="node-cell"><span class="node-cell-inner"><span class="node-power-indicator node-ind-off" id="nind-${inv}-${n}" aria-hidden="true"></span><span class="node-label">N${n}</span></span></td>
        <td><span class="cell-alarm no-alarm" id="alarm-${inv}-${n}">0000H</span></td>
        <td class="mono" id="pdc-${inv}-${n}">—</td>
        <td class="mono" id="rpac-${inv}-${n}">—</td>
        <td class="mono text-muted" id="rts-${inv}-${n}">—</td>
        <td class="ctrl-cell">
          <button class="${btnClass}" id="nbtn-${inv}-${n}"
            data-node="${n}"
            title="${btnTitle}"
            aria-label="${btnAria}"
            onclick="toggleNode(${inv},${n},this)" ${nodeConfigured ? "" : "disabled"}>${btnText}</button>
        </td>
      </tr>`;
  }
  return html;
}

// ─── Inverter card updates ────────────────────────────────────────────────────
function scheduleInverterCardsUpdate(force = false) {
  if (force) {
    if (State.cardRenderTimer) {
      clearTimeout(State.cardRenderTimer);
      State.cardRenderTimer = null;
    }
    State.cardRenderScheduled = false;
    State.lastCardRenderTs = Date.now();
    updateInverterCards();
    return;
  }

  if (State.cardRenderScheduled) return;
  const elapsed = Date.now() - Number(State.lastCardRenderTs || 0);
  const delay = Math.max(0, CARD_RENDER_MIN_INTERVAL_MS - elapsed);
  State.cardRenderScheduled = true;
  State.cardRenderTimer = setTimeout(() => {
    State.cardRenderTimer = null;
    requestAnimationFrame(() => {
      State.cardRenderScheduled = false;
      State.lastCardRenderTs = Date.now();
      updateInverterCards();
    });
  }, delay);
}

function updateInverterCards() {
  const data = State.liveData;
  const totals = State.totals;
  const now = Date.now();
  const nodeCount = Number(State.settings.nodeCount || 4);
  const invCount = Number(State.settings.inverterCount || 27);

  // Build lightweight lookup indexes once per render tick.
  const unitsByInv = Array.from({ length: invCount + 1 }, () => []);
  const unitMapByInv = Array.from({ length: invCount + 1 }, () =>
    Object.create(null),
  );
  const dataValues = Object.values(data || {});
  for (const row of dataValues) {
    const inv = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!inv || inv > invCount || unit <= 0) continue;
    unitsByInv[inv].push(row);
    unitMapByInv[inv][unit] = row;
  }

  const activeAlarmsByInv = Array.from({ length: invCount + 1 }, () => []);
  const activeAlarmValues = Object.values(State.activeAlarms || {});
  for (const alarm of activeAlarmValues) {
    const inv = Number(alarm?.inverter || 0);
    if (!inv || inv > invCount) continue;
    activeAlarmsByInv[inv].push(alarm);
  }

  let totalPac = 0,
    online = 0,
    alarmed = 0,
    offline = 0,
    activeNodes = 0,
    totalNodes = 0;

  for (let inv = 1; inv <= invCount; inv++) {
    const configuredUnits = getConfiguredUnits(inv, nodeCount);
    const configuredSet = new Set(configuredUnits);
    totalNodes += configuredUnits.length;
    const t = totals[inv];
    if (t) {
      totalPac += t.pac || 0;
    }

    // Aggregate units for this inverter
    const units = (unitsByInv[inv] || []).filter(
      (d) => d.inverter === inv && configuredSet.has(Number(d.unit || 0)),
    );
    const invUnitMap = unitMapByInv[inv] || Object.create(null);
    const freshUnits = units.filter(
      (d) => d.online && now - Number(d.ts || 0) <= DATA_FRESH_MS,
    );
    const activeAlarmEntries = (activeAlarmsByInv[inv] || []).filter(
      (a) =>
        Number(a.inverter) === inv && configuredSet.has(Number(a.unit || 0)),
    );
    const hasFreshData = freshUnits.length > 0;
    if (hasFreshData) State.invLastFresh[inv] = now;
    const inHold =
      !hasFreshData &&
      now - Number(State.invLastFresh[inv] || 0) <= CARD_OFFLINE_HOLD_MS;
    const anyOnline = hasFreshData || inHold;
    const anyAlarm =
      freshUnits.some((d) => d.alarm && d.alarm !== 0) ||
      activeAlarmEntries.length > 0;
    const topSev = higherSeverity(
      getTopSev(freshUnits),
      activeAlarmEntries.reduce(
        (best, a) => higherSeverity(best, a?.severity || "fault"),
        null,
      ),
    );

    const card = $(`inv-card-${inv}`);
    const badge = $(`badge-${inv}`);
    const iconEl = $(`icon-${inv}`);
    const pacEl = $(`pac-${inv}`);
    const pdcSumEl = $(`pdcsum-${inv}`);

    if (!card) continue;

    // Card class
    card.className = "inv-card";
    if (!anyOnline) {
      card.classList.add("offline");
      offline++;
    } else if (topSev === "critical") {
      card.classList.add("critical");
      alarmed++;
      online++;
    } else if (anyAlarm) {
      card.classList.add("alarm");
      alarmed++;
      if (anyOnline) online++;
    } else if (anyOnline) {
      online++;
    }
    if (iconEl) {
      iconEl.className = "card-inv-icon";
      if (!anyOnline) iconEl.classList.add("offline");
      else if (topSev === "critical" || anyAlarm) iconEl.classList.add("alarm");
    }

    // Badge
    if (!anyOnline) {
      badge.className = "badge badge-offline";
      badge.textContent = "OFFLINE";
    } else if (topSev === "critical") {
      badge.className = "badge badge-critical";
      badge.textContent = "CRITICAL";
    } else if (anyAlarm) {
      badge.className = "badge badge-alarm";
      badge.textContent = "ALARM";
    } else {
      badge.className = "badge badge-online";
      badge.textContent = "ONLINE";
    }

    // PAC
    const pac = t ? t.pac : 0;
    const pdc = t ? t.pdc : 0;
    const pacKw = (pac / 1000).toFixed(2);
    pacEl.innerHTML = `${pacKw}<span class="pac-unit">kW</span>`;
    pacEl.className = "pac-val" + (pac === 0 ? " zero" : " active");
    if (pdcSumEl) {
      pdcSumEl.innerHTML = `${(pdc / 1000).toFixed(2)}<span class="pac-unit">kW</span>`;
      pdcSumEl.className = "pac-val" + (pdc === 0 ? " zero" : " active");
    }

    // Per-node rows (always repaint to avoid stale values lingering in UI).
    const rowStateMap = new Map();
    for (let n = 1; n <= nodeCount; n++) {
      const nodeConfigured = configuredSet.has(n);
      const key = `${inv}_${n}`;
      const alarmEl = $(`alarm-${inv}-${n}`);
      const pdcEl = $(`pdc-${inv}-${n}`);
      const rpacEl = $(`rpac-${inv}-${n}`);
      const rtsEl = $(`rts-${inv}-${n}`);
      const rowEl = $(`row-${inv}-${n}`);
      const nbtnEl = $(`nbtn-${inv}-${n}`);
      const nindEl = $(`nind-${inv}-${n}`);

      if (!nodeConfigured) {
        if (alarmEl) {
          alarmEl.textContent = "—";
          alarmEl.className = "cell-alarm no-alarm";
        }
        if (pdcEl) pdcEl.textContent = "—";
        if (rpacEl) {
          rpacEl.textContent = "—";
          rpacEl.className = "mono";
        }
        if (rtsEl) rtsEl.textContent = "—";
        State.nodeStates[key] = 0;
        if (rowEl) {
          rowEl.classList.add("row-node-disabled");
          rowEl.classList.remove(
            "row-alarm-live",
            "row-alarm-unacked",
            "row-alarm-acked",
            "row-pac-high",
            "row-pac-mid",
            "row-pac-low",
            "row-pac-off",
            "row-pac-alarm",
          );
        }
        if (nindEl) nindEl.className = "node-power-indicator node-ind-isolated";
        if (nbtnEl) setNodeButtonVisual(nbtnEl, n, false, true);
        rowStateMap.set(n, "isolated");
        continue;
      }

      const d = invUnitMap[n];
      const rowFresh =
        d &&
        d.online &&
        now - Number(d.ts || 0) <= DATA_FRESH_MS + CARD_OFFLINE_HOLD_MS;
      const nodeReachable =
        d && d.online && now - Number(d.ts || 0) <= DATA_FRESH_MS;
      if (nodeReachable) activeNodes++;
      const nodeOn = nodeReachable && Number(d.on_off) === 1 ? 1 : 0;
      const activeAlarm = State.activeAlarms[key] || null;
      const liveAlarmValue = rowFresh ? Number(d?.alarm || 0) : 0;
      const persistedAlarmValue = Number(activeAlarm?.alarm_value || 0);
      // Alarm cell source-of-truth: use live tracker first when available,
      // then fallback to persisted active-alarm row.
      const alarmValue =
        liveAlarmValue !== 0 ? liveAlarmValue : persistedAlarmValue;
      const hasActiveAlarm = alarmValue !== 0;
      const alarmFromPersisted =
        !!activeAlarm &&
        persistedAlarmValue !== 0 &&
        persistedAlarmValue === alarmValue;
      const alarmAcked =
        hasActiveAlarm && alarmFromPersisted
          ? !!activeAlarm.acknowledged
          : false;
      const alarmSev =
        (liveAlarmValue !== 0
          ? getRowSev(liveAlarmValue)
          : activeAlarm?.severity || getRowSev(persistedAlarmValue)) ||
        getRowSev(alarmValue) ||
        "fault";

      if (alarmEl) {
        const hex = hasActiveAlarm
          ? alarmFromPersisted
            ? normalizeAlarmHex(activeAlarm?.alarm_hex, alarmValue)
            : toAlarmHex(alarmValue)
          : "0000H";
        alarmEl.textContent = hex;
        alarmEl.className = hasActiveAlarm
          ? `cell-alarm sev-${alarmSev} alarm-live ${alarmAcked ? "acknowledged" : "unacked"}`
          : "cell-alarm no-alarm";
      }
      if (pdcEl)
        pdcEl.textContent = rowFresh && d.pdc != null ? fmtNum(d.pdc, 0) : "—";
      if (rpacEl) {
        const pacVal = rowFresh && d.pac != null ? Number(d.pac) : 0;
        rpacEl.textContent = rowFresh && d.pac != null ? fmtNum(d.pac, 0) : "—";
        rpacEl.className = "mono";
        if (nindEl) {
          const pacIndicatorClass = getPacIndicatorClass(
            pacVal,
            hasActiveAlarm,
            rowFresh,
          );
          nindEl.className = `node-power-indicator ${pacIndicatorClass}`;
        }
      }
      if (rtsEl) rtsEl.textContent = rowFresh && d.ts ? fmtTime(d.ts) : "—";
      State.nodeStates[key] = nodeOn;
      if (rowEl) {
        rowEl.classList.remove("row-node-disabled");
        rowEl.classList.remove(
          "row-pac-high",
          "row-pac-mid",
          "row-pac-low",
          "row-pac-off",
          "row-pac-alarm",
        );
        rowEl.classList.toggle("row-alarm-live", hasActiveAlarm);
        rowEl.classList.toggle(
          "row-alarm-unacked",
          hasActiveAlarm && !alarmAcked,
        );
        rowEl.classList.toggle("row-alarm-acked", hasActiveAlarm && alarmAcked);
      }
      if (nbtnEl) {
        setNodeButtonVisual(nbtnEl, n, !!nodeOn, false);
        if (hasActiveAlarm) {
          nbtnEl.classList.add(alarmAcked ? "alarm-acked" : "alarm-unacked");
        }
      }
      if (nodeOn) rowStateMap.set(n, "active");
      else rowStateMap.set(n, "inactive");
    }

    applyNodeRowOrdering(inv, rowStateMap);
  }

  // Header totals
  const pacKw = Number(totalPac / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const pacEl = $("totalPac");
  if (pacEl && pacEl.firstChild) pacEl.firstChild.nodeValue = pacKw;

  // Stats
  $("statOnline").textContent = online;
  $("statAlarmed").textContent = alarmed;
  $("statOffline").textContent = offline;

  // Toolbar counters: active / total
  const micEl = $("metricInvCount");
  if (micEl) micEl.textContent = online;
  const mitEl = $("metricInvTotal");
  if (mitEl) mitEl.textContent = `/ ${invCount}`;
  const mncEl = $("metricNodeCount");
  if (mncEl) mncEl.textContent = activeNodes;
  const mntEl = $("metricNodeTotal");
  if (mntEl) mntEl.textContent = `/ ${totalNodes}`;
  renderTodayKwhFromPac();
}

function getNodeNumberFromRowId(rowId) {
  const m = String(rowId || "").match(/row-\d+-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function applyNodeRowOrdering(inv, rowStateMap) {
  const tbody = $(`tbody-${inv}`);
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll(`tr[id^="row-${inv}-"]`)).map(
    (row) => {
      const n = getNodeNumberFromRowId(row.id);
      return { row, n, state: rowStateMap.get(n) || "isolated" };
    },
  );
  if (!rows.length) return;

  const nextSig = rows.map(({ n, state }) => `${n}:${state}`).join("|");
  if (State.nodeOrderSig[inv] === nextSig) return;

  const rank = {
    // Configured nodes (online or offline) are treated the same.
    active: 0,
    inactive: 0,
    isolated: 1,
  };

  rows.sort((a, b) => {
    const rankA = rank[a.state] ?? 2;
    const rankB = rank[b.state] ?? 2;
    if (rankA !== rankB) return rankA - rankB;
    return a.n - b.n;
  });

  rows.forEach(({ row }) => tbody.appendChild(row));
  State.nodeOrderSig[inv] = nextSig;
}

async function updateTodayKwh() {
  // Backward-compatible hook: force immediate server sync + render.
  await syncTodayMwhFromServer();
  renderTodayKwhFromPac();
}

function getTopSev(units) {
  const sevOrder = { critical: 4, fault: 3, warning: 2, info: 1 };
  let top = null;
  units.forEach((d) => {
    if (!d.alarm) return;
    const s = getRowSev(d.alarm);
    if (!top || (sevOrder[s] || 0) > (sevOrder[top] || 0)) top = s;
  });
  return top;
}

function getRowSev(alarmVal) {
  if (!alarmVal) return null;
  // Rough severity from bit positions
  if (alarmVal & 0x4600) return "critical"; // bits 10,14,8,9
  if (alarmVal & 0x0088) return "fault"; // bits 3,7
  if (alarmVal & 0x0033) return "warning"; // bits 0,1,4,5
  return "fault";
}

function getPacRowClass(pacW, hasAlarm) {
  if (hasAlarm) return "row-pac-alarm";
  const v = Number(pacW || 0);
  if (v >= NODE_RATED_W * 0.80) return "row-pac-high"; // ≥80% rated (~199 kW); allows up to 103% over-production
  if (v >  NODE_RATED_W * 0.50) return "row-pac-mid";  // >50% rated (~125 kW)
  if (v >  0)                   return "row-pac-low";
  return "row-pac-off";
}

function getPacIndicatorClass(pacW, hasAlarm, isFresh = true) {
  if (!isFresh) return "node-ind-off";
  const band = getPacRowClass(pacW, hasAlarm);
  if (band === "row-pac-high") return "node-ind-high";
  if (band === "row-pac-mid") return "node-ind-mid";
  if (band === "row-pac-low") return "node-ind-low";
  if (band === "row-pac-alarm") return "node-ind-alarm";
  return "node-ind-off";
}

function nodeButtonText(isOn, isIsolated = false) {
  if (isIsolated) return "ISOLATED";
  return isOn ? "STOP" : "START";
}

function setNodeButtonVisual(btnEl, node, isOn, isIsolated = false) {
  if (!btnEl) return;
  const txt = nodeButtonText(isOn, isIsolated);
  btnEl.disabled = !!isIsolated;
  btnEl.className = isIsolated
    ? "node-btn node-disabled"
    : `node-btn ${isOn ? "cmd-stop" : "cmd-start"}`;
  btnEl.textContent = txt;
  btnEl.title = isIsolated ? "Isolated" : txt;
  btnEl.setAttribute(
    "aria-label",
    `Node ${node} ${isIsolated ? "Isolated" : txt}`,
  );
}

// Bulk command auth is intentionally separate from IP Config/Topology auth.
const PLANT_WIDE_AUTH_PREFIX = "sacups";
const BulkAuth = {
  resolver: null,
  open: false,
};

function getPlantWideAuthKeys() {
  const now = new Date();
  const prev = new Date(now.getTime() - 60000);
  return [
    `${PLANT_WIDE_AUTH_PREFIX}${pad2(now.getMinutes())}`,
    `${PLANT_WIDE_AUTH_PREFIX}${pad2(prev.getMinutes())}`,
  ];
}

function isBulkAuthOpen() {
  const modal = $("bulkAuthModal");
  return !!modal && !modal.classList.contains("hidden");
}

function closeBulkAuthModal(value) {
  const modal = $("bulkAuthModal");
  if (!modal) return;
  modal.classList.add("hidden");
  BulkAuth.open = false;
  const done = BulkAuth.resolver;
  BulkAuth.resolver = null;
  if (typeof done === "function") done(value || null);
}

function validatePlantWideAuthKey(input) {
  const entered = String(input || "")
    .trim()
    .toLowerCase();
  if (!entered) return { ok: false, error: "Auth key is required." };
  const validKeys = getPlantWideAuthKeys();
  if (!validKeys.includes(entered)) {
    return { ok: false, error: "Authorization failed. Invalid auth key." };
  }
  return { ok: true, key: entered };
}

function submitBulkAuthModal() {
  const inputEl = $("bulkAuthInput");
  const errEl = $("bulkAuthError");
  if (!inputEl || !errEl) return;
  const v = validatePlantWideAuthKey(inputEl.value);
  if (!v.ok) {
    errEl.textContent = v.error;
    inputEl.focus();
    inputEl.select();
    return;
  }
  closeBulkAuthModal(v.key);
}

function initBulkAuthModal() {
  const modal = $("bulkAuthModal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  const closeBtn = $("bulkAuthClose");
  const cancelBtn = $("bulkAuthCancel");
  const okBtn = $("bulkAuthOk");
  const inputEl = $("bulkAuthInput");

  if (closeBtn)
    closeBtn.addEventListener("click", () => closeBulkAuthModal(null));
  if (cancelBtn)
    cancelBtn.addEventListener("click", () => closeBulkAuthModal(null));
  if (okBtn) okBtn.addEventListener("click", submitBulkAuthModal);
  if (inputEl) {
    inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitBulkAuthModal();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeBulkAuthModal(null);
      }
    });
  }
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) closeBulkAuthModal(null);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isBulkAuthOpen()) {
      ev.preventDefault();
      closeBulkAuthModal(null);
    }
  });
}

function requestBulkAuthorization(action, scopeLabel, totalTargets) {
  const modal = $("bulkAuthModal");
  const msgEl = $("bulkAuthMessage");
  const inputEl = $("bulkAuthInput");
  const errEl = $("bulkAuthError");
  if (!modal || !msgEl || !inputEl || !errEl) {
    showToast("Authorization modal is unavailable.", "fault");
    return Promise.resolve(null);
  }

  msgEl.textContent = `${action} ${scopeLabel} (${totalTargets} nodes)?`;
  errEl.textContent = "";
  inputEl.value = "";
  modal.classList.remove("hidden");
  BulkAuth.open = true;
  setTimeout(() => {
    inputEl.focus();
  }, 0);

  return new Promise((resolve) => {
    BulkAuth.resolver = resolve;
  });
}

async function authorizeBulkCommand(action, scopeLabel, totalTargets) {
  initBulkAuthModal();
  return await requestBulkAuthorization(action, scopeLabel, totalTargets);
}

// ─── Node Control ─────────────────────────────────────────────────────────────
async function toggleNode(inv, node, btnEl) {
  if (!isConfiguredNodeClient(inv, node)) return;
  const key = `${inv}_${node}`;
  const curState = State.nodeStates[key] || 0;
  const newState = curState ? 0 : 1;
  const action = newState ? "START" : "STOP";
  try {
    await api("/api/write", "POST", {
      inverter: inv,
      node,
      unit: node,
      value: newState,
      scope: "single",
      operator: currentOperator(),
    });
    State.nodeStates[key] = newState;
    setNodeButtonVisual(btnEl, node, !!newState, false);
    showToast(
      `${action} sent: INV-${String(inv).padStart(2, "0")} N${node}`,
      "success",
      2600,
    );
  } catch (e) {
    showToast(
      `${action} failed: INV-${String(inv).padStart(2, "0")} N${node}: ${e.message}`,
      "fault",
      5000,
    );
  }
}

async function sendAllNodesInv(inv, val) {
  const nodeCount = State.settings.nodeCount || 4;
  const targetNodes = getConfiguredUnits(inv, nodeCount);
  if (!targetNodes.length) {
    showToast(`INV-${String(inv).padStart(2, "0")} is fully isolated`, "info");
    return;
  }
  const action = val ? "START" : "STOP";
  const scopeLabel = `INV-${String(inv).padStart(2, "0")}`;

  const tasks = [];
  for (const n of targetNodes) {
    tasks.push({
      inverter: inv,
      node: n,
      req: api("/api/write", "POST", {
        inverter: inv,
        node: n,
        unit: n,
        value: val,
        scope: "inverter",
        operator: currentOperator(),
      }),
    });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.req));
  let ok = 0;
  let fail = 0;

  results.forEach((r, i) => {
    const t = tasks[i];
    if (r.status === "fulfilled") {
      ok++;
      const key = `${t.inverter}_${t.node}`;
      State.nodeStates[key] = val;
      const btn = $(`nbtn-${t.inverter}-${t.node}`);
      if (btn) {
        setNodeButtonVisual(btn, t.node, !!val, false);
      }
    } else {
      fail++;
    }
  });

  if (fail === 0) {
    showToast(
      `${action} sent: ${scopeLabel} (${ok}/${targetNodes.length} nodes)`,
      "success",
      3200,
    );
  } else if (ok === 0) {
    const firstErr = results.find((r) => r.status === "rejected");
    const detail = firstErr?.reason?.message
      ? `: ${firstErr.reason.message}`
      : "";
    showToast(
      `${action} failed: ${scopeLabel} (0/${targetNodes.length})${detail}`,
      "fault",
      6000,
    );
  } else {
    showToast(
      `${action} partial: ${scopeLabel} (${ok}/${targetNodes.length})`,
      "warning",
      5000,
    );
  }
}

function formatInverterRangeList(values) {
  if (!Array.isArray(values) || !values.length) return "";
  const sorted = [...values].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === end + 1) {
      end = n;
      continue;
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = n;
    end = n;
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

function parseInverterRangeInput(rawInput, maxInverter) {
  const raw = String(rawInput || "").trim();
  if (!raw) {
    return { ok: false, error: "Enter inverter number(s) or range(s)." };
  }

  const compact = raw.replace(/\s+/g, "");
  const tokens = compact.split(",").filter(Boolean);
  if (!tokens.length) {
    return { ok: false, error: "Enter inverter number(s) or range(s)." };
  }

  const seen = new Set();
  const duplicates = new Set();
  const invalid = new Set();
  const values = [];

  const addValue = (n, token) => {
    if (!Number.isInteger(n) || n < 1 || n > maxInverter) {
      invalid.add(token);
      return;
    }
    if (seen.has(n)) {
      duplicates.add(n);
      return;
    }
    seen.add(n);
    values.push(n);
  };

  tokens.forEach((token) => {
    if (/^\d+$/.test(token)) {
      addValue(Number(token), token);
      return;
    }
    if (/^\d+-\d+$/.test(token)) {
      const [startRaw, endRaw] = token.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (start > end || start < 1 || end > maxInverter) {
        invalid.add(token);
        return;
      }
      for (let n = start; n <= end; n++) addValue(n, token);
      return;
    }
    invalid.add(token);
  });

  if (invalid.size) {
    return {
      ok: false,
      error: `Invalid range token(s): ${Array.from(invalid).join(", ")}. Allowed inverter range is 1-${maxInverter}.`,
    };
  }

  if (duplicates.size) {
    return {
      ok: false,
      error: `Duplicate inverter number(s): ${Array.from(duplicates)
        .sort((a, b) => a - b)
        .join(", ")}.`,
    };
  }

  values.sort((a, b) => a - b);
  return {
    ok: values.length > 0,
    values,
    normalized: formatInverterRangeList(values),
    error: values.length ? "" : "No inverter selected.",
  };
}

function getSelectedInverters() {
  const input = $("bulkInvRangeInput");
  const maxInverter = Number(State.settings.inverterCount || 27);
  return parseInverterRangeInput(input ? input.value : "", maxInverter);
}

function fillAllCommandTargets() {
  const input = $("bulkInvRangeInput");
  if (!input) return;
  const maxInverter = Number(State.settings.inverterCount || 27);
  input.value = `1-${maxInverter}`;
}

function clearCommandTargets() {
  const input = $("bulkInvRangeInput");
  if (!input) return;
  input.value = "";
  input.focus();
}

async function sendSelectedNodes(val) {
  const parsed = getSelectedInverters();
  if (!parsed.ok) {
    showToast(parsed.error || "Invalid inverter range input.", "warning");
    return;
  }
  const selected = parsed.values;
  const input = $("bulkInvRangeInput");
  if (input && parsed.normalized) input.value = parsed.normalized;
  const nodeCount = State.settings.nodeCount || 4;
  let totalTargets = 0;
  selected.forEach((inv) => {
    totalTargets += getConfiguredUnits(inv, nodeCount).length;
  });
  if (!totalTargets) {
    showToast("Selected inverters are isolated. No nodes to control.", "info");
    return;
  }
  const action = val ? "START" : "STOP";
  const authKey = await authorizeBulkCommand(
    action,
    `selected inverters (${selected.length})`,
    totalTargets,
  );
  if (!authKey) {
    showToast(`${action} cancelled: selected inverters`, "info", 3200);
    return;
  }

  const tasks = [];
  selected.forEach((inv) => {
    for (const n of getConfiguredUnits(inv, nodeCount)) {
      tasks.push({
        inverter: inv,
        node: n,
        req: api("/api/write", "POST", {
          inverter: inv,
          node: n,
          unit: n,
          value: val,
          scope: "selected",
          authKey,
          operator: currentOperator(),
        }),
      });
    }
  });

  const results = await Promise.allSettled(tasks.map((t) => t.req));
  let ok = 0;
  let fail = 0;
  results.forEach((r, i) => {
    const t = tasks[i];
    if (r.status === "fulfilled") {
      ok++;
      State.nodeStates[`${t.inverter}_${t.node}`] = val;
      const btn = $(`nbtn-${t.inverter}-${t.node}`);
      if (btn) {
        setNodeButtonVisual(btn, t.node, !!val, false);
      }
    } else {
      fail++;
    }
  });

  if (fail === 0) {
    showToast(
      `${action} sent: selected inverters (${ok}/${tasks.length} nodes)`,
      "success",
      3200,
    );
  } else if (ok === 0) {
    const firstErr = results.find((r) => r.status === "rejected");
    const detail = firstErr?.reason?.message
      ? `: ${firstErr.reason.message}`
      : "";
    showToast(
      `${action} failed: selected inverters (0/${tasks.length})${detail}`,
      "fault",
      6000,
    );
  } else {
    showToast(
      `${action} partial: selected inverters (${ok}/${tasks.length})`,
      "warning",
      5000,
    );
  }
}

// ─── Inverter filter ──────────────────────────────────────────────────────────
function filterInverters() {
  const v = $("invFilter").value;
  document.querySelectorAll(".inv-card").forEach((c) => {
    c.style.display = v === "all" || c.id === `inv-card-${v}` ? "" : "none";
  });
  scheduleInverterCardsUpdate(true);
}

// ─── Build selects ────────────────────────────────────────────────────────────
function buildSelects() {
  const count = State.settings.inverterCount;
  const opts = Array.from(
    { length: count },
    (_, i) =>
      `<option value="${i + 1}">INV-${String(i + 1).padStart(2, "0")}</option>`,
  ).join("");
  const allOpt = '<option value="all">All Inverters</option>';

  [
    "invFilter",
    "alarmInv",
    "energyInv",
    "auditInv",
    "auditFilterInverter",
    "reportFilterInverter",
    "expAlarmInv",
    "expEnergyInv",
    "expInvDataInv",
    "expAuditInv",
  ].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = allOpt + opts;
    if (prev && el.querySelector(`option[value="${prev}"]`)) el.value = prev;
  });

  const nodeSel = $("auditFilterNode");
  if (nodeSel) {
    const prev = nodeSel.value;
    const nodeCount = Number(State.settings.nodeCount || 4);
    const nodeOpts = [
      '<option value="all">All</option>',
      '<option value="ALL">ALL</option>',
      ...Array.from(
        { length: nodeCount },
        (_, i) => `<option value="N${i + 1}">N${i + 1}</option>`,
      ),
    ];
    nodeSel.innerHTML = nodeOpts.join("");
    if (prev && nodeSel.querySelector(`option[value="${prev}"]`)) {
      nodeSel.value = prev;
    }
  }

  const rangeInput = $("bulkInvRangeInput");
  if (rangeInput && !String(rangeInput.value || "").trim()) {
    rangeInput.value = `1-${count}`;
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function showOfflineIndicator(show, message) {
  const bannerId = "offlineBanner";
  let banner = $(bannerId);

  if (show) {
    if (!banner) {
      banner = el("div", "offline-banner");
      banner.id = bannerId;
      banner.setAttribute("role", "alert");
      banner.setAttribute("aria-live", "assertive");
      document.body.appendChild(banner);
    }
    banner.textContent = message || "Lost connection to server";
    banner.style.display = "flex";
  } else {
    if (banner) {
      banner.style.display = "none";
    }
  }
}

function connectWS() {
  if (State.wsConnecting) return;
  State.wsConnecting = true;

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProto}://${location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  State.ws = ws;

  ws.onopen = () => {
    State.wsConnecting = false;
    setWsState(true, "ONLINE");
    State.wsRetries = 0;
    showOfflineIndicator(false);  // Clear offline banner on reconnect
  };

  ws.onmessage = ({ data }) => {
    netIOTrackRx(typeof data === "string" ? data.length : (data.byteLength || 0));
    try {
      const msg = JSON.parse(data);
      handleWS(msg);
    } catch (err) {
      console.warn("[ws] message handling failed:", err.message);
    }
  };

  ws.onclose = () => {
    State.wsConnecting = false;
    setWsState(false, "RECONNECT");
    const delay = Math.min(5000, 500 * ++State.wsRetries);
    const delaySeconds = Math.ceil(delay / 1000);
    showOfflineIndicator(true, `Reconnecting in ${delaySeconds}s...`);
    setTimeout(connectWS, delay);
  };

  ws.onerror = () => {
    State.wsConnecting = false;
    showOfflineIndicator(true, "Connection lost. Retrying...");
    ws.close();
  };
}

function handleWS(msg) {
  if (msg.type === "init" || msg.type === "live") {
    if (msg.data) State.liveData = sanitizeLiveDataByConfig(msg.data);
    if (msg.totals) State.totals = msg.totals;
    integrateTodayFromPac();
    if (msg.settings) {
      State.settings.inverterCount = msg.settings.inverterCount || 27;
      State.settings.plantName = msg.settings.plantName || "Solar Plant";
      if ($("plantNameDisplay"))
        $("plantNameDisplay").textContent = State.settings.plantName;
    }
    scheduleInverterCardsUpdate();
  }
  if (msg.type === "configChanged") {
    loadSettings().then(() => buildInverterGrid()).catch((err) => {
      console.warn("[ws] configChanged rebuild failed:", err.message);
    });
  }
  if (msg.type === "alarm") {
    handleAlarmPush(msg.alarms || []);
  }
  if (msg.type === "offline") {
    const d = State.liveData[msg.key];
    if (d) {
      // Short debounce only: ignore only very-late races, not true offline transitions.
      if (Date.now() - Number(d.ts || 0) <= 2000) return;
      d.online = 0;
      integrateTodayFromPac();
      scheduleInverterCardsUpdate();
    }
  }
  if (msg.type === "xfer_progress") {
    handleXferProgress(msg);
  }
}

// ─── Alarm push handling ──────────────────────────────────────────────────────
function handleAlarmPush(alarms) {
  if (!alarms.length) return;

  // Toast per alarm
  alarms.forEach((a) => {
    if (!isConfiguredNodeClient(a.inverter, a.unit)) return;
    const key = alarmKey(a.inverter, a.unit);
    State.activeAlarms[key] = {
      id: Number(a.id || 0),
      inverter: Number(a.inverter || 0),
      unit: Number(a.unit || 0),
      alarm_value: Number(a.alarm_value || 0),
      severity: a.severity || "fault",
      acknowledged: false,
      ts: Date.now(),
      alarm_hex: toAlarmHex(a.alarm_value),
    };

    const invLabel = `INV-${String(a.inverter).padStart(2, "0")} N${a.unit}`;
    const hex = toAlarmHex(a.alarm_value);
    const desc =
      (a.decoded || []).map((b) => b.label).join(", ") || "Alarm triggered";
    showToast(
      `${invLabel} — <b>${hex}</b><br><small>${desc}</small>`,
      a.severity,
    );
  });

  setAlarmSoundActive(true);
  scheduleInverterCardsUpdate();

  // Badge
  refreshAlarmBadge();

  // Notification bell
  refreshNotifPanel();

  // If alarms page visible, refresh
  if (State.currentPage === "alarms") fetchAlarms();
}

function showToast(html, severity = "fault", ttlMs = 8000) {
  const toast = $("alarmToast");
  if (!toast) return;

  const maxStack = 5;
  while (toast.children.length >= maxStack) {
    toast.firstElementChild?.remove();
  }

  const item = el("div", `toast-item sev-${severity}`);
  const sevLabel =
    {
      success: "🟢 SUCCESS",
      critical: "🔴 CRITICAL",
      fault: "🟠 FAULT",
      warning: "🟡 WARNING",
      info: "🔵 INFO",
    }[severity] || "ALARM";
  item.innerHTML = `
    <div class="toast-hdr">
      <span class="toast-title">${sevLabel}</span>
      <button class="toast-close" onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <div class="toast-body">${html}</div>
    <div class="toast-time">${fmtDateTime(Date.now())}</div>`;
  toast.appendChild(item);
  setTimeout(
    () => {
      if (item.parentNode) item.remove();
    },
    Math.max(800, Number(ttlMs) || 8000),
  );
}

async function refreshAlarmBadge() {
  try {
    const rows = await api("/api/alarms/active");
    const filteredRows = (Array.isArray(rows) ? rows : []).filter((r) =>
      isConfiguredNodeClient(r?.inverter, r?.unit),
    );
    syncActiveAlarmMap(filteredRows);
    const unacked = filteredRows.filter((r) => !r.acknowledged).length;
    const badge = $("alarmBadge");
    const bell = $("notifBell");
    const count = $("notifCount");

    if (unacked > 0) {
      if (badge) { badge.textContent = unacked > 99 ? "99+" : unacked; badge.style.display = ""; }
      if (bell) bell.classList.remove("hidden");
      if (count) count.textContent = unacked;
    } else {
      if (badge) badge.style.display = "none";
      if (bell) bell.classList.add("hidden");
      closeNotif();
    }
    setAlarmSoundActive(unacked > 0);
    scheduleInverterCardsUpdate();
  } catch (err) {
    console.warn("[app] refreshAlarmBadge failed:", err.message);
  }
}

async function refreshNotifPanel() {
  try {
    const rows = await api("/api/alarms/active");
    const filteredRows = (rows || []).filter((r) =>
      isConfiguredNodeClient(r?.inverter, r?.unit),
    );
    const list = $("notifList");
    if (!list) return;
    list.innerHTML = "";
    filteredRows.slice(0, 50).forEach((r) => {
      const desc = (r.decoded || []).map((b) => b.label).join(", ") || "Alarm";
      const item = el("div", "notif-item");
      item.innerHTML = `
        <div class="notif-inv">INV-${String(r.inverter).padStart(2, "0")} / N${r.unit}</div>
        <div class="notif-code">${r.alarm_hex || "—"} <span class="sev-pill sev-${r.severity || "fault"}">${(r.severity || "fault").toUpperCase()}</span></div>
        <div class="notif-desc">${desc}</div>
        <div class="notif-ts">${fmtDateTime(r.ts)}</div>`;
      list.appendChild(item);
    });
  } catch (err) {
    console.warn("[app] refreshNotifPanel failed:", err.message);
  }
}

function toggleNotif() {
  $("notifPanel")?.classList.toggle("hidden");
  refreshNotifPanel();
}
function closeNotif() {
  $("notifPanel")?.classList.add("hidden");
}

// ─── Alarms Page ──────────────────────────────────────────────────────────────
function initAlarmsPage() {
  if (!$("alarmStart").value) {
    const s = new Date(Date.now() - 7 * 86400000);
    s.setHours(0, 0, 0, 0);
    $("alarmStart").value = dateStr(s);
    $("alarmEnd").value = today();
  }
  fetchAlarms();
}

async function fetchAlarms() {
  const inv = $("alarmInv").value;
  const start = $("alarmStart").value;
  const end = $("alarmEnd").value;
  const startMs = start ? new Date(`${start}T00:00:00`).getTime() : "";
  const endMs = end ? new Date(`${end}T23:59:59.999`).getTime() : "";
  const qs = new URLSearchParams({
    start: String(startMs),
    end: String(endMs),
    ...(inv !== "all" ? { inverter: inv } : {}),
  });
  try {
    const raw = await api(`/api/alarms?${qs}`);
    const rows = Array.isArray(raw) ? raw : [];
    renderAlarmTable(rows);
    const countEl = $("alarmCount");
    if (countEl) countEl.textContent = `${rows.length} records`;
    refreshAlarmBadge();
  } catch (e) {
    console.error("fetchAlarms:", e);
  }
}

function renderAlarmTable(rows) {
  const tbody = $("alarmBody");
  if (!tbody) return;
  const safeRows = Array.isArray(rows) ? rows : [];
  tbody.innerHTML = "";
  if (!safeRows.length) {
    renderEmptyRow(tbody, 10, "No alarm records for the selected filter.");
    return;
  }
  safeRows.forEach((r) => {
    const desc = (r.decoded || []).map((b) => b.label).join(", ") || "—";
    const occurredTs = Number(r.occurred_ts || r.ts || 0);
    const clearedTs = r.cleared_ts ? Number(r.cleared_ts) : null;
    const statusRaw = String(
      r.status || (clearedTs ? "CLEARED" : "ACTIVE"),
    ).toUpperCase();
    const dur =
      r.duration_text || duration_min(occurredTs, clearedTs || Date.now());
    const status =
      statusRaw === "CLEARED"
        ? '<span class="status-cleared">CLEARED</span>'
        : '<span class="status-active">ACTIVE</span>';
    const ackBtn = r.acknowledged
      ? '<button class="ack-btn acked" disabled>✔ ACK</button>'
      : `<button class="ack-btn" onclick="ackAlarm(${r.id},this)">ACK</button>`;
    const tr = el("tr");
    tr.id = `alarm-row-${r.id}`;
    tr.innerHTML = `
      <td>${fmtDateTime(occurredTs)}</td>
      <td>INV-${String(r.inverter).padStart(2, "0")}</td>
      <td>N${r.unit}</td>
      <td><span class="cell-alarm sev-${r.severity || "fault"}">${r.alarm_hex || "—"}</span></td>
      <td><span class="sev-pill sev-${r.severity || "fault"}">${(r.severity || "fault").toUpperCase()}</span></td>
      <td>${desc}</td>
      <td>${clearedTs ? fmtDateTime(clearedTs) : "—"}</td>
      <td>${dur}</td>
      <td>${status}</td>
      <td>${ackBtn}</td>`;
    tbody.appendChild(tr);
  });
}

async function ackAlarm(id, btn) {
  try {
    const res = await api(`/api/alarms/${id}/ack`, "POST");
    btn.className = "ack-btn acked";
    btn.textContent = "✔ ACK";
    btn.disabled = true;
    await fetchAlarms();
    await refreshAlarmBadge();
    await refreshNotifPanel();
    if (Number(res?.count || 0) <= 0) {
      showToast("Alarm already acknowledged.", "info", 1800);
    }
  } catch (e) {
    alert("ACK failed: " + e.message);
  }
}

async function loadIpConfig() {
  try {
    const cfg = await api("/api/ip-config");
    State.ipConfig = cfg && typeof cfg === "object" ? cfg : null;
  } catch (e) {
    console.warn("[IPCONFIG] load failed:", e.message);
    State.ipConfig = null;
  }
}

function getConfiguredUnits(inv, fallbackNodeCount) {
  const nodeCount = Number(fallbackNodeCount ?? State.settings.nodeCount ?? 4);
  const cfg = State.ipConfig;
  if (!cfg || typeof cfg !== "object") {
    return Array.from({ length: nodeCount }, (_, i) => i + 1);
  }
  const unitsRaw = cfg?.units?.[inv] ?? cfg?.units?.[String(inv)] ?? [];
  const units = Array.isArray(unitsRaw)
    ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
    : [];
  return [...new Set(units)];
}

function isConfiguredNodeClient(inv, node) {
  return getConfiguredUnits(inv).includes(Number(node));
}

function sanitizeLiveDataByConfig(rawMap) {
  const src = rawMap && typeof rawMap === "object" ? rawMap : {};
  const out = {};
  Object.entries(src).forEach(([k, v]) => {
    const inv = Number(v?.inverter ?? String(k).split("_")[0]);
    const unit = Number(v?.unit ?? String(k).split("_")[1]);
    if (!Number.isFinite(inv) || !Number.isFinite(unit)) return;
    if (!isConfiguredNodeClient(inv, unit)) return;
    out[`${inv}_${unit}`] = v;
  });
  return out;
}

async function ackAll() {
  if (!confirm("Acknowledge ALL unacknowledged alarms?")) return;
  try {
    const res = await api("/api/alarms/ack-all", "POST");
    document
      .querySelectorAll("#alarmBody .ack-btn:not(.acked)")
      .forEach((btn) => {
        btn.className = "ack-btn acked";
        btn.textContent = "✔ ACK";
        btn.disabled = true;
      });
    await fetchAlarms();
    await refreshAlarmBadge();
    await refreshNotifPanel();
    const count = Number(res?.count || 0);
    showToast(
      count > 0
        ? `Acknowledged ${count} alarm${count === 1 ? "" : "s"}.`
        : "No unacknowledged alarms found.",
      count > 0 ? "success" : "info",
      2200,
    );
  } catch (e) {
    alert("ACK ALL failed: " + e.message);
  }
}

// ─── Energy Page ──────────────────────────────────────────────────────────────
function initEnergyPage() {
  if (!$("energyStart").value) {
    $("energyStart").value = today();
    $("energyEnd").value = today();
  }
  fetchEnergy();
}

async function fetchEnergy() {
  const inv = $("energyInv").value;
  const start = $("energyStart").value;
  const end = $("energyEnd").value;
  const sTs = localDateStartMs(start);
  const eTs = localDateEndMs(end);
  const qs = new URLSearchParams({
    start: sTs,
    end: eTs,
    ...(inv !== "all" ? { inverter: inv } : {}),
  });
  try {
    const raw = await api(`/api/energy/5min?${qs}`);
    const rows = Array.isArray(raw) ? raw : [];
    renderEnergyTable(rows);
    renderEnergySummary(rows);
    const countEl = $("energyCount");
    if (countEl) countEl.textContent = `${rows.length} interval records`;
  } catch (e) {
    console.error("fetchEnergy:", e);
  }
}

function renderEnergyTable(rows) {
  const tbody = $("energyBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows.length) {
    renderEmptyRow(
      tbody,
      4,
      "No 5-minute energy records for the selected range.",
    );
    return;
  }
  const ordered = [...rows].sort(
    (a, b) =>
      Number(b.ts || 0) - Number(a.ts || 0) ||
      Number(a.inverter || 0) - Number(b.inverter || 0),
  );
  ordered.forEach((r) => {
    const dt = new Date(r.ts);
    const tr = el("tr");
    tr.innerHTML = `
      <td>${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}</td>
      <td>${pad2(dt.getHours())}:${pad2(dt.getMinutes())}</td>
      <td>INV-${String(r.inverter).padStart(2, "0")}</td>
      <td>${fmtMWh(Number(r.kwh_inc || 0), 6)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderEnergySummary(rows) {
  const setText = (id, v) => {
    const node = $(id);
    if (node) node.textContent = v;
  };

  if (!rows || !rows.length) {
    setText("energyTotalMwh", "— MWh");
    setText("energyAvgMwh", "— MWh");
    setText("energyPeakMwh", "— MWh");
    setText("energyPeakMeta", "—");
    setText("energyInvCount", "—");
    setText("energyLastTs", "—");
    return;
  }

  const norm = rows.map((r) => ({
    ts: Number(r?.ts || 0),
    inverter: Number(r?.inverter || 0),
    mwh: Number(r?.kwh_inc || 0) / 1000,
  }));

  const totalMwh = norm.reduce(
    (s, r) => s + (Number.isFinite(r.mwh) ? r.mwh : 0),
    0,
  );
  const avgMwh = totalMwh / Math.max(1, norm.length);
  const peak = norm.reduce((best, r) => (r.mwh > best.mwh ? r : best), {
    ts: 0,
    inverter: 0,
    mwh: 0,
  });
  const lastTs = norm.reduce((mx, r) => Math.max(mx, r.ts), 0);
  const invCount = new Set(norm.map((r) => r.inverter).filter(Boolean)).size;

  setText("energyTotalMwh", `${totalMwh.toFixed(6)} MWh`);
  setText("energyAvgMwh", `${avgMwh.toFixed(6)} MWh`);
  setText("energyPeakMwh", `${peak.mwh.toFixed(6)} MWh`);
  setText(
    "energyPeakMeta",
    peak.ts
      ? `INV-${String(peak.inverter).padStart(2, "0")} @ ${fmtDateTime(peak.ts)}`
      : "—",
  );
  setText("energyInvCount", String(invCount));
  setText("energyLastTs", lastTs ? fmtDateTime(lastTs) : "—");
}

// ─── Audit Log Page ───────────────────────────────────────────────────────────
function initAuditPage() {
  setupAuditTableControls();
  if (!$("auditStart").value) {
    const s = new Date(Date.now() - 7 * 86400000);
    $("auditStart").value = dateStr(s);
    $("auditEnd").value = today();
  }
  fetchAudit();
}

async function fetchAudit() {
  const inv = $("auditInv").value;
  const start = $("auditStart").value;
  const end = $("auditEnd").value;
  const startMs = start ? new Date(`${start}T00:00:00`).getTime() : "";
  const endMs = end ? new Date(`${end}T23:59:59.999`).getTime() : "";
  const qs = new URLSearchParams({
    start: String(startMs),
    end: String(endMs),
    ...(inv !== "all" ? { inverter: inv } : {}),
  });
  try {
    const rows = await api(`/api/audit?${qs}`);
    State.auditView.rows = Array.isArray(rows) ? rows : [];
    applyAuditTableView();
  } catch (e) {
    console.error("fetchAudit:", e);
  }
}

function renderAuditTable(rows) {
  const tbody = $("auditBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows.length) {
    renderEmptyRow(tbody, 8, "No audit records for the selected filter.");
    return;
  }
  rows.forEach((r) => {
    const action =
      r.action === "START"
        ? '<span class="action-start">START</span>'
        : '<span class="action-stop">STOP</span>';
    const result =
      r.result === "ok"
        ? '<span class="result-ok">✔ OK</span>'
        : `<span class="result-err">✗ ${r.result}</span>`;
    const tr = el("tr");
    tr.innerHTML = `
      <td>${fmtDateTime(r.ts)}</td>
      <td>${r.operator || "OPERATOR"}</td>
      <td>INV-${String(r.inverter).padStart(2, "0")}</td>
      <td>${r.node === 0 ? "ALL" : "N" + r.node}</td>
      <td>${action}</td>
      <td>${(r.scope || "single").toUpperCase()}</td>
      <td>${result}</td>
      <td>${r.ip || "—"}</td>`;
    $("auditBody").appendChild(tr);
  });
}

function setupAuditTableControls() {
  const table = $("auditTable");
  if (!table || table.dataset.bound === "1") return;
  table.dataset.bound = "1";

  table.querySelectorAll("th.audit-sort").forEach((th) => {
    th.addEventListener("click", () => {
      const key = String(th.dataset.key || "").trim();
      if (!key) return;
      if (State.auditView.sortKey === key) {
        State.auditView.sortDir =
          State.auditView.sortDir === "asc" ? "desc" : "asc";
      } else {
        State.auditView.sortKey = key;
        State.auditView.sortDir = key === "ts" ? "desc" : "asc";
      }
      applyAuditTableView();
    });
  });

  [
    "auditFilterTs",
    "auditFilterOperator",
    "auditFilterInverter",
    "auditFilterNode",
    "auditFilterAction",
    "auditFilterScope",
    "auditFilterResult",
    "auditFilterIp",
  ].forEach((id) => {
    const f = $(id);
    if (!f || f.dataset.bound === "1") return;
    f.dataset.bound = "1";
    f.addEventListener("input", applyAuditTableView);
    f.addEventListener("change", applyAuditTableView);
  });
}

function auditNodeLabel(node) {
  const n = Number(node || 0);
  return n === 0 ? "ALL" : `N${n}`;
}

function getAuditFilters() {
  const getVal = (id) => String($(id)?.value || "").trim();
  return {
    ts: getVal("auditFilterTs").toLowerCase(),
    operator: getVal("auditFilterOperator").toLowerCase(),
    inverter: getVal("auditFilterInverter"),
    node: getVal("auditFilterNode"),
    action: getVal("auditFilterAction").toUpperCase(),
    scope: getVal("auditFilterScope").toLowerCase(),
    result: getVal("auditFilterResult").toLowerCase(),
    ip: getVal("auditFilterIp").toLowerCase(),
  };
}

function compareAuditRows(a, b, key) {
  if (key === "ts") return Number(a.ts || 0) - Number(b.ts || 0);
  if (key === "inverter")
    return Number(a.inverter || 0) - Number(b.inverter || 0);
  if (key === "node") return Number(a.node || 0) - Number(b.node || 0);

  const aa = String(a?.[key] ?? "").toLowerCase();
  const bb = String(b?.[key] ?? "").toLowerCase();
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

function renderAuditSortIndicators() {
  const table = $("auditTable");
  if (!table) return;
  table.querySelectorAll("th.audit-sort").forEach((th) => {
    const key = String(th.dataset.key || "");
    const label = String(th.dataset.label || th.textContent || "").trim();
    const active = key === State.auditView.sortKey;
    const arrow = active
      ? State.auditView.sortDir === "asc"
        ? " ▲"
        : " ▼"
      : "";
    th.classList.toggle("active", active);
    th.textContent = `${label}${arrow}`;
  });
}

function applyAuditTableView() {
  const allRows = Array.isArray(State.auditView.rows)
    ? State.auditView.rows
    : [];
  const f = getAuditFilters();
  const filtered = allRows.filter((r) => {
    const tsText = fmtDateTime(r.ts).toLowerCase();
    if (f.ts && !tsText.includes(f.ts)) return false;
    if (
      f.operator &&
      !String(r.operator || "OPERATOR")
        .toLowerCase()
        .includes(f.operator)
    )
      return false;
    if (
      f.inverter &&
      f.inverter !== "all" &&
      Number(r.inverter || 0) !== Number(f.inverter)
    )
      return false;

    const nodeText = auditNodeLabel(r.node);
    if (f.node && f.node !== "all" && nodeText !== f.node) return false;

    if (
      f.action &&
      f.action !== "ALL" &&
      String(r.action || "").toUpperCase() !== f.action
    )
      return false;
    if (
      f.scope === "scope-all" &&
      String(r.scope || "").toLowerCase() !== "all"
    )
      return false;
    if (
      f.scope &&
      f.scope !== "all" &&
      f.scope !== "scope-all" &&
      String(r.scope || "").toLowerCase() !== f.scope
    )
      return false;

    if (f.result === "ok" && String(r.result || "").toLowerCase() !== "ok")
      return false;
    if (f.result === "error" && String(r.result || "").toLowerCase() === "ok")
      return false;

    if (
      f.ip &&
      !String(r.ip || "")
        .toLowerCase()
        .includes(f.ip)
    )
      return false;
    return true;
  });

  const dir = State.auditView.sortDir === "asc" ? 1 : -1;
  filtered.sort(
    (a, b) => dir * compareAuditRows(a, b, State.auditView.sortKey),
  );

  renderAuditTable(filtered);
  renderAuditSortIndicators();
  const auditCountEl = $("auditCount");
  if (auditCountEl) auditCountEl.textContent = `${filtered.length}/${allRows.length} records`;
}

function resetAuditFilters() {
  ["auditFilterTs", "auditFilterOperator", "auditFilterIp"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  [
    ["auditFilterInverter", "all"],
    ["auditFilterNode", "all"],
    ["auditFilterAction", "all"],
    ["auditFilterScope", "all"],
    ["auditFilterResult", "all"],
  ].forEach(([id, v]) => {
    const el = $(id);
    if (el) el.value = v;
  });
  State.auditView.sortKey = "ts";
  State.auditView.sortDir = "desc";
  applyAuditTableView();
}

// ─── Daily Report Page ────────────────────────────────────────────────────────
function initReportPage() {
  setupReportTableControls();
  if (!$("reportDate").value) {
    $("reportDate").value = today();
    queuePersistExportUiState();
  }
  fetchReport();
}

async function fetchReport() {
  const date = $("reportDate").value;
  queuePersistExportUiState();
  try {
    let rows = await api(`/api/report/daily?date=${date}`);
    if ((!Array.isArray(rows) || rows.length === 0) && date) {
      try {
        const latest = await api("/api/report/latest-date");
        const latestDate = String(latest?.latestDate || "").trim();
        if (latestDate && latestDate !== date) {
          $("reportDate").value = latestDate;
          rows = await api(`/api/report/daily?date=${latestDate}`);
          showToast(
            `No report rows for ${date}. Showing latest available date: ${latestDate}.`,
            "warning",
            3800,
          );
        }
      } catch (_) {
        // Non-fatal fallback; keep original empty result.
      }
    }
    State.reportView.rows = Array.isArray(rows)
      ? rows.map((r) => toReportViewRow(r))
      : [];
    applyReportTableView();
    await fetchReportSummary($("reportDate").value || date);
  } catch (e) {
    console.error("fetchReport:", e);
    State.reportView.rows = [];
    State.reportView.summary = null;
    applyReportTableView();
    renderReportKpis();
    showToast(`Report load failed: ${e.message}`, "error", 4200);
  }
}

async function fetchReportSummary(date) {
  try {
    const summary = await api(`/api/report/summary?date=${date}`);
    State.reportView.summary =
      summary && typeof summary === "object" ? summary : null;
    if (sanitizeDateInputValue(date) === today()) {
      const totalKwh = Number(summary?.daily?.total_kwh);
      if (Number.isFinite(totalKwh)) {
        applySyncedTodayKwh(totalKwh, Date.now());
        renderTodayKwhFromPac();
      }
    }
  } catch (e) {
    console.warn("fetchReportSummary:", e?.message || e);
    State.reportView.summary = null;
  }
  renderReportKpis();
}

function clampPctClient(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function getReportWindowHours(dateText = "") {
  const day = sanitizeDateInputValue(dateText) || today();
  const t = today();
  if (day > t) return 0;
  const solarStart = new Date(`${day}T05:00:00.000`).getTime();
  let solarEnd = new Date(`${day}T18:00:00.000`).getTime();
  if (day === t) solarEnd = Math.min(solarEnd, Date.now());
  return Math.max(0, (solarEnd - solarStart) / 3600000);
}

function calcReportAvailabilityPctClient(row, reportDay = "") {
  const explicit = Number(row?.availability_pct);
  if (Number.isFinite(explicit)) return clampPctClient(explicit);
  const uph =
    Number(row?.uptime_h || 0) || (Number(row?.uptime_s || 0) / 3600);
  const windowH = getReportWindowHours(reportDay || row?.date || today());
  if (!Number.isFinite(windowH) || windowH <= 0) return 0;
  return clampPctClient((Math.max(0, uph) / windowH) * 100);
}

function calcReportPerformancePctClient(row) {
  const explicit = Number(row?.performance_pct);
  if (Number.isFinite(explicit)) return clampPctClient(explicit);
  const kwh = Number(row?.kwh_total || 0);
  const uph =
    Number(row?.uptime_h || 0) || (Number(row?.uptime_s || 0) / 3600);
  const denom = INV_RATED_KW * Math.max(0, uph);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return clampPctClient((Math.max(0, kwh) / denom) * 100);
}

function toReportViewRow(r) {
  const kwh = Number(r?.kwh_total || 0);
  const mwh = kwh / 1000;
  const peak = Number(r?.pac_peak || 0) / 1000; // measured peak kW (display only)
  const avg = Number(r?.pac_avg || 0) / 1000;
  const uph = Number(r?.uptime_s || 0) / 3600;
  const reportDay = String(r?.date || $("reportDate")?.value || today()).trim();
  const availabilityPct = calcReportAvailabilityPctClient(
    { ...r, uptime_h: uph },
    reportDay,
  );
  const performancePct = calcReportPerformancePctClient({
    ...r,
    uptime_h: uph,
  });
  const perf = Math.round(performancePct);
  return {
    ...r,
    inverter: Number(r?.inverter || 0),
    mwh,
    peak_kw: peak,
    avg_kw: avg,
    uptime_h: uph,
    alarm_count: Number(r?.alarm_count || 0),
    availability_pct: Number(availabilityPct.toFixed(3)),
    performance_pct: Number(performancePct.toFixed(3)),
    perf,
  };
}

function setupReportTableControls() {
  const table = $("reportTable");
  if (!table || table.dataset.bound === "1") return;
  table.dataset.bound = "1";

  table.querySelectorAll("th.report-sort").forEach((th) => {
    th.addEventListener("click", () => {
      const key = String(th.dataset.key || "").trim();
      if (!key) return;
      if (State.reportView.sortKey === key) {
        State.reportView.sortDir =
          State.reportView.sortDir === "asc" ? "desc" : "asc";
      } else {
        State.reportView.sortKey = key;
        State.reportView.sortDir = key === "inverter" ? "asc" : "desc";
      }
      applyReportTableView();
    });
  });

  [
    "reportFilterInverter",
    "reportFilterEnergy",
    "reportFilterPeak",
    "reportFilterAvg",
    "reportFilterUptime",
    "reportFilterAlarms",
    "reportFilterPerf",
  ].forEach((id) => {
    const f = $(id);
    if (!f || f.dataset.bound === "1") return;
    f.dataset.bound = "1";
    f.addEventListener("input", applyReportTableView);
    f.addEventListener("change", applyReportTableView);
  });
}

function getReportFilters() {
  const getVal = (id) => String($(id)?.value || "").trim();
  return {
    inverter: getVal("reportFilterInverter"),
    energy: getVal("reportFilterEnergy").toLowerCase(),
    peak: getVal("reportFilterPeak").toLowerCase(),
    avg: getVal("reportFilterAvg").toLowerCase(),
    uptime: getVal("reportFilterUptime").toLowerCase(),
    alarms: getVal("reportFilterAlarms"),
    perf: getVal("reportFilterPerf").toLowerCase(),
  };
}

function compareReportRows(a, b, key) {
  if (
    key === "inverter" ||
    key === "mwh" ||
    key === "peak_kw" ||
    key === "avg_kw" ||
    key === "uptime_h" ||
    key === "alarm_count" ||
    key === "perf"
  ) {
    return Number(a?.[key] || 0) - Number(b?.[key] || 0);
  }
  const aa = String(a?.[key] ?? "").toLowerCase();
  const bb = String(b?.[key] ?? "").toLowerCase();
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

function renderReportSortIndicators() {
  const table = $("reportTable");
  if (!table) return;
  table.querySelectorAll("th.report-sort").forEach((th) => {
    const key = String(th.dataset.key || "");
    const label = String(th.dataset.label || th.textContent || "").trim();
    const active = key === State.reportView.sortKey;
    const arrow = active
      ? State.reportView.sortDir === "asc"
        ? " ▲"
        : " ▼"
      : "";
    th.classList.toggle("active", active);
    th.textContent = `${label}${arrow}`;
  });
}

function applyReportTableView() {
  const allRows = Array.isArray(State.reportView.rows)
    ? State.reportView.rows
    : [];
  const f = getReportFilters();
  const filtered = allRows.filter((r) => {
    if (
      f.inverter &&
      f.inverter !== "all" &&
      Number(r.inverter || 0) !== Number(f.inverter)
    )
      return false;

    if (
      f.energy &&
      !String(Number(r.mwh || 0).toFixed(6))
        .toLowerCase()
        .includes(f.energy)
    )
      return false;
    if (
      f.peak &&
      !String(Number(r.peak_kw || 0).toFixed(3))
        .toLowerCase()
        .includes(f.peak)
    )
      return false;
    if (
      f.avg &&
      !String(Number(r.avg_kw || 0).toFixed(3))
        .toLowerCase()
        .includes(f.avg)
    )
      return false;
    if (
      f.uptime &&
      !String(Number(r.uptime_h || 0).toFixed(2))
        .toLowerCase()
        .includes(f.uptime)
    )
      return false;
    if (
      f.perf &&
      !String(r.perf || 0)
        .toLowerCase()
        .includes(f.perf)
    )
      return false;

    if (f.alarms === "with" && Number(r.alarm_count || 0) <= 0) return false;
    if (f.alarms === "none" && Number(r.alarm_count || 0) > 0) return false;
    return true;
  });

  const dir = State.reportView.sortDir === "asc" ? 1 : -1;
  filtered.sort(
    (a, b) => dir * compareReportRows(a, b, State.reportView.sortKey),
  );

  renderReportTable(filtered, allRows.length);
  renderReportSortIndicators();
  renderReportKpis();
}

function renderReportTable(rows, totalRows = rows.length) {
  const tbody = $("reportBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows.length) {
    const msg =
      Number(totalRows || 0) > 0
        ? "No rows match current report filters."
        : "No daily report rows for this date.";
    renderEmptyRow(tbody, 7, msg);
    return;
  }

  rows.forEach((r) => {
    const mwh = Number(r.mwh || 0);
    const peak = Number(r.peak_kw || 0);
    const avg = Number(r.avg_kw || 0);
    const uph = Number(r.uptime_h || 0);
    const perf = Number(r.perf || 0);

    const tr = el("tr");
    tr.innerHTML = `
      <td>INV-${String(r.inverter).padStart(2, "0")}</td>
      <td class="text-accent">${mwh.toFixed(6)}</td>
      <td>${peak.toFixed(3)}</td>
      <td>${avg.toFixed(3)}</td>
      <td>${uph.toFixed(2)}</td>
      <td class="${r.alarm_count > 0 ? "text-red" : ""}">${r.alarm_count || 0}</td>
      <td>
        <div class="perf-bar">
          <div class="perf-track"><div class="perf-fill" style="width:${perf}%;background:${perf > 80 ? "var(--green)" : perf > 50 ? "var(--orange)" : "var(--red)"}"></div></div>
          <span>${perf}%</span>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

function computeReportSummaryFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return {
      inverter_count: 0,
      total_mwh: 0,
      peak_kw: 0,
      alarm_count: 0,
      availability_avg_pct: 0,
      performance_pct: 0,
    };
  }

  let totalMwh = 0;
  let peakKw = 0;
  let alarmCount = 0;
  let availSum = 0;
  let denomMwh = 0;
  list.forEach((r) => {
    const mwh = Number(r?.mwh || 0);
    const peak = Number(r?.peak_kw || 0);
    const uph = Number(r?.uptime_h || 0);
    const avail = calcReportAvailabilityPctClient(r, r?.date || $("reportDate")?.value || today());
    const denom = (INV_RATED_KW * uph) / 1000; // rated kW*h -> MWh
    totalMwh += Math.max(0, mwh);
    if (peak > peakKw) peakKw = peak;
    alarmCount += Math.max(0, Math.trunc(Number(r?.alarm_count || 0)));
    availSum += clampPctClient(avail);
    denomMwh += Math.max(0, denom);
  });
  const avgAvail = list.length ? availSum / list.length : 0;
  const perf = denomMwh > 0 ? (totalMwh / denomMwh) * 100 : 0;
  return {
    inverter_count: new Set(
      list.map((r) => Number(r?.inverter || 0)).filter((n) => n > 0),
    ).size,
    total_mwh: Number(totalMwh.toFixed(6)),
    peak_kw: Number(peakKw.toFixed(3)),
    alarm_count: alarmCount,
    availability_avg_pct: Number(
      clampPctClient(avgAvail).toFixed(3),
    ),
    performance_pct: Number(clampPctClient(perf).toFixed(3)),
  };
}

function renderReportKpis() {
  const host = $("reportKpis");
  if (!host) return;
  const daily =
    State.reportView.summary?.daily ||
    computeReportSummaryFromRows(State.reportView.rows);
  const weekly = State.reportView.summary?.weekly || {
    total_mwh: 0,
    availability_avg_pct: 0,
    performance_pct: 0,
  };
  host.innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Daily MWh</div><div class="kpi-val">${Number(daily.total_mwh || 0).toFixed(3)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Daily Availability</div><div class="kpi-val">${Number(daily.availability_avg_pct || 0).toFixed(1)}%</div></div>
    <div class="kpi-box"><div class="kpi-label">Daily Plant Performance</div><div class="kpi-val">${Number(daily.performance_pct || 0).toFixed(1)}%</div></div>
    <div class="kpi-box"><div class="kpi-label">Weekly MWh</div><div class="kpi-val">${Number(weekly.total_mwh || 0).toFixed(3)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Weekly Availability</div><div class="kpi-val">${Number(weekly.availability_avg_pct || 0).toFixed(1)}%</div></div>
    <div class="kpi-box"><div class="kpi-label">Weekly Plant Performance</div><div class="kpi-val">${Number(weekly.performance_pct || 0).toFixed(1)}%</div></div>`;
}

async function exportDailyReport() {
  await persistExportUiState().catch(() => {});
  const date = $("reportDate").value || today();
  if (!$("reportDate").value) $("reportDate").value = date;
  const ts = localDateStartMs(date);
  const format = $("reportExportFormat")?.value || "xlsx";
  setExportButtonState("btnExportDailyReport", "loading");
  try {
    // Ensure report rows are materialized in DB before export.
    await api(`/api/report/daily?date=${encodeURIComponent(date)}&refresh=1`, "GET");
    const r = await api("/api/export/daily-report", "POST", {
      date,
      startTs: ts,
      endTs: ts + 86399999,
      format,
    });
    if (!r?.path) throw new Error("Export did not return output path.");
    alert(`Saved to:\n${r.path}`);
    await openExportPathFolder(r.path);
    setExportButtonState("btnExportDailyReport", "ok");
  } catch (e) {
    alert("Export error: " + e.message);
    setExportButtonState("btnExportDailyReport", "fail");
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────
function initAnalytics() {
  if (!$("anaDate").value) $("anaDate").value = today();
  if ($("anaInterval") && !$("anaInterval").value) $("anaInterval").value = "5";
  ensureAnalyticsAutoRefresh();
  loadAnalytics({ force: true });
}

async function loadAnalytics(options = {}) {
  const force = options && options.force === true;
  if (State.analyticsFetchInFlight && !force) return;
  State.analyticsFetchInFlight = true;
  const reqId = (State.analyticsReqId || 0) + 1;
  State.analyticsReqId = reqId;
  let date = $("anaDate").value;
  if (!date || Number.isNaN(localDateStartMs(date))) {
    date = today();
    if ($("anaDate")) $("anaDate").value = date;
  }
  const intervalMin = Number($("anaInterval")?.value || 5);
  const sTs = localDateStartMs(date);
  const eTs = localDateEndMs(date);
  try {
    const qs = new URLSearchParams({
      date,
      start: sTs,
      end: eTs,
      bucketMin: 5,
    });
    let rows = [];
    let dayAheadRows = [];
    try {
      [rows, dayAheadRows] = await Promise.all([
        api(`/api/analytics/energy?${qs}`),
        api(`/api/analytics/dayahead?${qs}`).catch(() => []),
      ]);
    } catch (err) {
      // Backward fallback for older backend versions.
      console.warn("[app] analytics v2 endpoint failed, using legacy:", err.message);
      rows = await api(`/api/energy/5min?${qs}`);
      dayAheadRows = [];
    }
    if (reqId !== State.analyticsReqId) return;
    const bucketed = aggregateEnergyRows(rows, intervalMin);
    const dayAheadBucketed = aggregateForecastRows(dayAheadRows, intervalMin);
    State.analyticsBaseRows = bucketed;
    State.analyticsDayAheadBaseRows = dayAheadBucketed;
    State.analyticsIntervalMin = intervalMin;
    renderAnalyticsFromState();
    ensureAnalyticsRealtime();
    ensureAnalyticsAutoRefresh();
    loadWeeklyWeather(date, force).catch((err) => {
      console.warn("weekly weather load failed:", err?.message || err);
    });
  } catch (e) {
    console.error("loadAnalytics:", e);
  } finally {
    State.analyticsFetchInFlight = false;
  }
}

function weatherDayLabel(day) {
  const d = String(day || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || "—";
  const dt = new Date(`${d}T00:00:00`);
  return `${dt.toLocaleDateString("en-US", { weekday: "short" })} ${pad2(
    dt.getMonth() + 1,
  )}/${pad2(dt.getDate())}`;
}

function weatherSkyClass(sky) {
  const s = String(sky || "").toLowerCase();
  if (s.includes("rain")) return "rainy";
  if (s.includes("overcast")) return "overcast";
  if (s.includes("cloudy")) return "cloudy";
  if (s.includes("partly")) return "partly";
  if (s.includes("clear")) return "clear";
  return "na";
}

function renderWeeklyWeather(rows, selectedDate = "") {
  const host = $("anaWeeklyWeather");
  if (!host) return;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    host.innerHTML =
      '<div class="analytics-weather-empty">No weather data for this week.</div>';
    return;
  }

  host.innerHTML = list
    .map((r) => {
      const day = String(r?.date || "");
      const mark = day === selectedDate ? "today" : "";
      const skyRaw = String(r?.sky || "N/A");
      const skyCls = weatherSkyClass(skyRaw);
      const tMin = Number.isFinite(Number(r?.temp_min_c))
        ? `${Number(r.temp_min_c).toFixed(0)}`
        : "—";
      const tMax = Number.isFinite(Number(r?.temp_max_c))
        ? `${Number(r.temp_max_c).toFixed(0)}`
        : "—";
      const rain = Number.isFinite(Number(r?.precip_mm))
        ? Number(r.precip_mm).toFixed(1)
        : "0.0";
      const cloud = Number.isFinite(Number(r?.cloud_pct))
        ? Math.round(Number(r.cloud_pct))
        : 0;
      const wind = Number.isFinite(Number(r?.wind_kph))
        ? Number(r.wind_kph).toFixed(1)
        : "0.0";
      const solar = Number.isFinite(Number(r?.solar_kwh_m2))
        ? Number(r.solar_kwh_m2).toFixed(2)
        : "0.00";

      return `
      <div class="analytics-weather-item ${mark}">
        <div class="analytics-weather-day">${weatherDayLabel(day)}</div>
        <div class="analytics-weather-sky ${skyCls}">${skyRaw}</div>
        <div class="analytics-weather-meta">
          <span>${tMin}-${tMax}°C</span>
          <span>Rain ${rain} mm</span>
          <span>Cloud ${cloud}%</span>
          <span>Wind ${wind} km/h</span>
          <span>Solar ${solar} kWh/m²</span>
        </div>
      </div>`;
    })
    .join("");
}

async function loadWeeklyWeather(date, force = false) {
  const day = String(date || $("anaDate")?.value || today()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  if (
    !force &&
    State.analyticsWeatherDate === day &&
    Array.isArray(State.analyticsWeeklyWeather) &&
    State.analyticsWeeklyWeather.length
  ) {
    renderWeeklyWeather(State.analyticsWeeklyWeather, day);
    return;
  }
  const host = $("anaWeeklyWeather");
  if (host)
    host.innerHTML =
      '<div class="analytics-weather-empty">Loading weekly weather…</div>';

  const payload = await api(
    `/api/weather/weekly?date=${encodeURIComponent(day)}`,
  );
  const rows = Array.isArray(payload?.rows)
    ? payload.rows
    : Array.isArray(payload)
      ? payload
      : [];
  State.analyticsWeeklyWeather = rows;
  State.analyticsWeatherDate = day;
  renderWeeklyWeather(rows, day);
}

function isTodayAnalyticsDate() {
  const d = $("anaDate")?.value;
  return !!d && d === today();
}

function floorToInterval(ts, intervalMin) {
  const m = Math.max(1, Number(intervalMin) || 5);
  const intervalMs = m * 60000;
  return Math.floor(ts / intervalMs) * intervalMs;
}

function mergeRealtimeOverlay(baseRows, intervalMin) {
  if (!isTodayAnalyticsDate()) return Array.isArray(baseRows) ? baseRows : [];

  const now = Date.now();
  const intMin = Math.max(1, Number(intervalMin) || 5);
  const bucketTs = floorToInterval(now, intMin);
  const elapsedHours = Math.max(0, (now - bucketTs) / 3600000);
  const livePacByInv = {};

  Object.values(State.liveData || {}).forEach((d) => {
    const inv = Number(d?.inverter || 0);
    if (!inv) return;
    const fresh = d?.online && now - Number(d?.ts || 0) <= DATA_FRESH_MS;
    if (!fresh) return;
    livePacByInv[inv] = (livePacByInv[inv] || 0) + Number(d?.pac || 0); // W
  });

  const merged = new Map();
  (baseRows || []).forEach((r) => {
    const inv = Number(r?.inverter || 0);
    const ts = Number(r?.ts || 0);
    if (!inv || !ts) return;
    merged.set(`${inv}|${ts}`, {
      inverter: inv,
      ts,
      kwh_inc: Number(r?.kwh_inc || 0),
    });
  });

  // Overlay current in-progress bucket for today's date using live PAC estimate.
  // This keeps analytics moving in real time even before the next persisted 5-min row.
  Object.entries(livePacByInv).forEach(([inv, pacW]) => {
    const pacKw = Math.max(0, Number(pacW) / 1000);
    const kwhInc = pacKw * elapsedHours;
    merged.set(`${inv}|${bucketTs}`, {
      inverter: Number(inv),
      ts: bucketTs,
      kwh_inc: kwhInc,
    });
  });

  const out = Array.from(merged.values());
  out.sort((a, b) => a.inverter - b.inverter || a.ts - b.ts);
  return out;
}

function renderAnalyticsFromState() {
  const intervalMin = Number(State.analyticsIntervalMin || 5);
  const actualRows = mergeRealtimeOverlay(State.analyticsBaseRows, intervalMin);
  const dayAheadRows = aggregateForecastRows(
    State.analyticsDayAheadBaseRows,
    intervalMin,
  );
  renderAnalyticsCharts(actualRows, intervalMin, dayAheadRows);
}

function stopAnalyticsRealtime() {
  if (State.analyticsRealtimeTimer) {
    clearInterval(State.analyticsRealtimeTimer);
    State.analyticsRealtimeTimer = null;
  }
}

function stopAnalyticsAutoRefresh() {
  if (State.analyticsFetchTimer) {
    clearInterval(State.analyticsFetchTimer);
    State.analyticsFetchTimer = null;
  }
}

function ensureAnalyticsAutoRefresh() {
  stopAnalyticsAutoRefresh();
  if (State.currentPage !== "analytics") return;
  State.analyticsFetchTimer = setInterval(() => {
    if (State.currentPage !== "analytics") {
      stopAnalyticsAutoRefresh();
      return;
    }
    loadAnalytics().catch((e) => {
      console.warn("analytics auto-refresh failed:", e?.message || e);
    });
  }, 60000);
}

function ensureAnalyticsRealtime() {
  stopAnalyticsRealtime();
  if (State.currentPage !== "analytics") return;
  if (!isTodayAnalyticsDate()) return;
  State.analyticsRealtimeTimer = setInterval(() => {
    if (State.currentPage !== "analytics") {
      stopAnalyticsRealtime();
      return;
    }
    if (!isTodayAnalyticsDate()) {
      stopAnalyticsRealtime();
      return;
    }
    renderAnalyticsFromState();
  }, 2000);
}

function paletteByInv(inv) {
  const hue = (Number(inv) * 37) % 360;
  return {
    stroke: `hsl(${hue} 78% 58%)`,
    fill: `hsla(${hue} 78% 58% / 0.14)`,
  };
}

function aggregateEnergyRows(rows, intervalMin) {
  const safeInterval = [5, 15, 30, 60].includes(Number(intervalMin))
    ? Number(intervalMin)
    : 5;
  if (safeInterval === 5) return (rows || []).slice();

  const intervalMs = safeInterval * 60000;
  const map = new Map();
  (rows || []).forEach((r) => {
    const ts = Number(r.ts || 0);
    const inv = Number(r.inverter || 0);
    if (!ts || !inv) return;
    const bucketTs = Math.floor(ts / intervalMs) * intervalMs;
    const key = `${inv}|${bucketTs}`;
    const prev = Number(map.get(key) || 0);
    map.set(key, prev + Number(r.kwh_inc || 0));
  });

  const out = [];
  map.forEach((kwh_inc, key) => {
    const [inv, ts] = key.split("|");
    out.push({
      inverter: Number(inv),
      ts: Number(ts),
      kwh_inc: Number(kwh_inc),
    });
  });
  out.sort((a, b) => a.inverter - b.inverter || a.ts - b.ts);
  return out;
}

function aggregateForecastRows(rows, intervalMin) {
  const safeInterval = [5, 15, 30, 60].includes(Number(intervalMin))
    ? Number(intervalMin)
    : 5;
  if (safeInterval === 5) {
    return (rows || [])
      .map((r) => ({
        ts: Number(r?.ts || 0),
        kwh_inc: Number(r?.kwh_inc || 0),
      }))
      .filter((r) => r.ts > 0)
      .sort((a, b) => a.ts - b.ts);
  }

  const intervalMs = safeInterval * 60000;
  const map = new Map();
  (rows || []).forEach((r) => {
    const ts = Number(r?.ts || 0);
    if (!ts) return;
    const bucketTs = Math.floor(ts / intervalMs) * intervalMs;
    const prev = Number(map.get(bucketTs) || 0);
    map.set(bucketTs, prev + Number(r?.kwh_inc || 0));
  });

  return Array.from(map.entries())
    .map(([ts, kwh_inc]) => ({ ts: Number(ts), kwh_inc: Number(kwh_inc || 0) }))
    .sort((a, b) => a.ts - b.ts);
}

function buildSeriesByInverter(rows, intervalMin = 5) {
  const tsSet = new Set();
  const byInv = new Map();
  const safeInterval = Math.max(1, Number(intervalMin) || 5);
  (rows || []).forEach((r) => {
    const ts = Number(r.ts || 0);
    const inv = Number(r.inverter || 0);
    if (!ts || !inv) return;
    tsSet.add(ts);
    if (!byInv.has(inv)) byInv.set(inv, new Map());
    // Analytics is energy-based: interval increment converted to MWh.
    byInv.get(inv).set(ts, Number(r.kwh_inc || 0) / 1000);
  });
  const timeline = Array.from(tsSet).sort((a, b) => a - b);
  return { timeline, byInv };
}

function destroyAnalyticsCharts() {
  Object.values(State.charts || {}).forEach((chart) => {
    try {
      chart?.destroy?.();
    } catch (err) {
      console.warn("[app] chart destroy failed:", err.message);
    }
  });
  State.charts = {};
}

function ensureAnalyticsCards() {
  const host = $("analyticsCharts");
  if (!host) return;
  const count = Number(State.settings.inverterCount || 27);
  const expectedCanvasCount = count + 1; // total + per-inverter
  const existingCanvasCount = host.querySelectorAll(
    "canvas[id^='chart-']",
  ).length;
  const hasSideCard = !!host.querySelector("#analyticsTotalSideCard");
  if (
    host.dataset.count === String(count) &&
    existingCanvasCount === expectedCanvasCount &&
    hasSideCard
  ) {
    return;
  }

  destroyAnalyticsCharts();
  host.innerHTML = "";
  host.dataset.count = String(count);

  const totalCard = document.createElement("div");
  totalCard.className = "chart-card";
  totalCard.classList.add("chart-total-card");
  totalCard.innerHTML =
    '<div class="chart-title">🏭 Total Plant Energy — MWh</div><canvas id="chart-total-pac" height="120"></canvas>';
  host.appendChild(totalCard);

  const totalSideCard = document.createElement("div");
  totalSideCard.className = "chart-card chart-total-side-card";
  totalSideCard.id = "analyticsTotalSideCard";
  totalSideCard.innerHTML = `
    <div class="chart-title">📊 Selected Date Summary</div>
    <div class="analytics-side-grid">
      <div class="analytics-side-item">
        <div class="analytics-side-label">Actual MWh</div>
        <div class="analytics-side-value" id="anaSideActual">—</div>
      </div>
      <div class="analytics-side-item">
        <div class="analytics-side-label">Day-ahead MWh</div>
        <div class="analytics-side-value" id="anaSideDayAhead">—</div>
      </div>
      <div class="analytics-side-item">
        <div class="analytics-side-label">Variance MWh</div>
        <div class="analytics-side-value" id="anaSideVariance">—</div>
      </div>
      <div class="analytics-side-item">
        <div class="analytics-side-label">Peak Interval</div>
        <div class="analytics-side-value analytics-side-peak" id="anaSidePeak">—</div>
      </div>
    </div>
    <div class="analytics-gen-wrap">
      <div class="analytics-side-label">Day-ahead Generator</div>
      <div class="analytics-gen-row">
        <label for="genDayCount" class="analytics-gen-label">Days</label>
        <input
          type="number"
          id="genDayCount"
          class="inp analytics-gen-input"
          min="1"
          max="31"
          step="1"
          value="1"
        />
        <button class="btn btn-accent analytics-gen-btn" onclick="runDayAheadGeneration()">
          Generate
        </button>
      </div>
      <div class="exp-result analytics-gen-result" id="genDayResult"></div>
    </div>
    <div class="analytics-weather-wrap">
      <div class="analytics-side-label">7-Day Weather Outlook</div>
      <div id="anaWeeklyWeather" class="analytics-weather-list">
        <div class="analytics-weather-empty">Loading weekly weather…</div>
      </div>
    </div>
  `;
  host.appendChild(totalSideCard);

  const savedDayCount = Number(State.settings?.exportUiState?.genDayCount || 1);
  const genInput = totalSideCard.querySelector("#genDayCount");
  if (genInput && Number.isFinite(savedDayCount)) {
    genInput.value = String(
      Math.min(31, Math.max(1, Math.trunc(savedDayCount))),
    );
  }
  bindExportUiStatePersistence();
  syncDayAheadGeneratorAvailability();

  for (let inv = 1; inv <= count; inv++) {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.innerHTML = `<div class="chart-title">⚡ INVERTER ${pad2(inv)} Energy — MWh</div><canvas id="chart-inv-${inv}" height="120"></canvas>`;
    host.appendChild(card);
  }
}

function renderAnalyticsCharts(rows, intervalMin = 5, dayAheadRows = []) {
  const host = $("analyticsCharts");
  if (typeof Chart === "undefined") {
    if (host) {
      host.innerHTML =
        '<div class="chart-card"><div class="chart-title">Chart library failed to load. Please restart dashboard.</div></div>';
    }
    return;
  }
  ensureAnalyticsCards();

  const { timeline, byInv } = buildSeriesByInverter(rows, intervalMin);
  const dayAheadMwhByTs = new Map(
    (dayAheadRows || []).map((r) => [
      Number(r?.ts || 0),
      Number(Number(r?.kwh_inc || 0) / 1000),
    ]),
  );
  const mergedTimelineRaw = Array.from(
    new Set([
      ...timeline,
      ...Array.from(dayAheadMwhByTs.keys()).filter((ts) => Number(ts) > 0),
    ]),
  ).sort((a, b) => a - b);
  const displayTimeline = buildAnalyticsDisplayTimeline(intervalMin);
  const mergedTimeline = displayTimeline.length
    ? displayTimeline
    : mergedTimelineRaw;
  const labels = mergedTimeline.map((ts) => {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  });
  const count = Number(State.settings.inverterCount || 27);
  const selectedDate = String($("anaDate")?.value || today()).trim();
  const todayDate = today();
  let fillPastMissingAsZero = false;
  let pastCutoffTs = Number.NEGATIVE_INFINITY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    if (selectedDate < todayDate) {
      fillPastMissingAsZero = true;
      pastCutoffTs = Number.POSITIVE_INFINITY;
    } else if (selectedDate === todayDate) {
      fillPastMissingAsZero = true;
      pastCutoffTs = floorToInterval(Date.now(), intervalMin);
    }
  }

  const totalValues = mergedTimeline.map((ts) => {
    let sum = 0;
    let seen = 0;
    for (let inv = 1; inv <= count; inv++) {
      const m = byInv.get(inv);
      if (!m || !m.has(ts)) continue;
      seen += 1;
      sum += Number(m.get(ts) || 0);
    }
    if (!seen) {
      if (fillPastMissingAsZero && ts <= pastCutoffTs) return 0;
      return null;
    }
    return Number(sum.toFixed(6));
  });
  const dayAheadValues = mergedTimeline.map((ts) => {
    if (!dayAheadMwhByTs.has(ts)) return null;
    return Number(Number(dayAheadMwhByTs.get(ts) || 0).toFixed(6));
  });

  upsertTotalCompareChart(
    "totalPac",
    "chart-total-pac",
    labels,
    totalValues,
    dayAheadValues,
  );

  for (let inv = 1; inv <= count; inv++) {
    const p = paletteByInv(inv);
    upsertLineChart(
      `inv_${inv}`,
      `chart-inv-${inv}`,
      `INVERTER ${pad2(inv)} Energy (MWh)`,
      labels,
      mergedTimeline.map((ts) => {
        const m = byInv.get(inv);
        if (!m || !m.has(ts)) {
          if (fillPastMissingAsZero && ts <= pastCutoffTs) return 0;
          return null;
        }
        return Number(m.get(ts) || 0);
      }),
      p.stroke,
      p.fill,
      1.6,
    );
  }
  renderAnalyticsSummary(
    rows,
    intervalMin,
    totalValues,
    mergedTimeline,
    dayAheadValues,
  );

  // Clean up stale charts if inverter count changes downward.
  for (const [key, chart] of Object.entries(State.charts || {})) {
    if (key === "totalPac") continue;
    const m = /^inv_(\d+)$/.exec(key);
    if (!m) continue;
    if (Number(m[1]) > count) {
      try {
        chart?.destroy?.();
      } catch (err) {
        console.warn("[app] chart destroy failed:", err.message);
      }
      delete State.charts[key];
    }
  }
}

function upsertLineChart(
  key,
  canvasId,
  label,
  labels,
  data,
  stroke,
  fill,
  borderWidth = 1.6,
) {
  const compact = data.length <= 2;
  const pointRadius = compact ? 2.8 : 0;
  const pointHoverRadius = compact ? 3.6 : 2.2;
  const chart = State.charts[key];
  if (chart) {
    chart.data.labels = labels;
    if (!chart.data.datasets?.length) chart.data.datasets = [{}];
    chart.data.datasets[0].label = label;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].borderColor = stroke;
    chart.data.datasets[0].backgroundColor = fill;
    chart.data.datasets[0].borderWidth = borderWidth;
    chart.data.datasets[0].pointRadius = pointRadius;
    chart.data.datasets[0].pointHoverRadius = pointHoverRadius;
    chart.update("none");
    return;
  }

  const canvas = $(canvasId);
  if (!canvas) return;
  State.charts[key] = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          borderColor: stroke,
          backgroundColor: fill,
          borderWidth,
          pointRadius,
          pointHoverRadius,
          tension: 0.2,
          fill: true,
        },
      ],
    },
    options: chartOpts("MWh", false),
  });
}

function upsertTotalCompareChart(
  key,
  canvasId,
  labels,
  actualValues,
  dayAheadValues,
) {
  const pal = getChartPalette();
  const chart = State.charts[key];
  const actual = Array.isArray(actualValues) ? actualValues : [];
  const ahead = Array.isArray(dayAheadValues) ? dayAheadValues : [];
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets = [
      {
        label: "Actual (MWh)",
        data: actual,
        borderColor: pal.actual,
        backgroundColor: pal.actualFill,
        borderWidth: 2,
        pointRadius: actual.length <= 2 ? 2.8 : 0,
        pointHoverRadius: actual.length <= 2 ? 3.6 : 2.2,
        tension: 0.2,
        fill: true,
      },
      {
        label: "Day-ahead (MWh)",
        data: ahead,
        borderColor: pal.ahead,
        backgroundColor: pal.aheadFill,
        borderWidth: 2,
        pointRadius: ahead.length <= 2 ? 2.8 : 0,
        pointHoverRadius: ahead.length <= 2 ? 3.6 : 2.2,
        tension: 0.2,
        fill: false,
      },
    ];
    chart.update("none");
    return;
  }

  const canvas = $(canvasId);
  if (!canvas) return;
  State.charts[key] = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Actual (MWh)",
          data: actual,
          borderColor: pal.actual,
          backgroundColor: pal.actualFill,
          borderWidth: 2,
          pointRadius: actual.length <= 2 ? 2.8 : 0,
          pointHoverRadius: actual.length <= 2 ? 3.6 : 2.2,
          tension: 0.2,
          fill: true,
        },
        {
          label: "Day-ahead (MWh)",
          data: ahead,
          borderColor: pal.ahead,
          backgroundColor: pal.aheadFill,
          borderWidth: 2,
          pointRadius: ahead.length <= 2 ? 2.8 : 0,
          pointHoverRadius: ahead.length <= 2 ? 3.6 : 2.2,
          tension: 0.2,
          fill: false,
        },
      ],
    },
    options: chartOpts("MWh", true),
  });
}

function renderAnalyticsSummary(
  rows,
  intervalMin,
  totalValues,
  timeline,
  dayAheadValues,
) {
  const host = $("analyticsSummary");
  if (!host) return;

  const numericTotalValues = (totalValues || []).filter(
    (v) => v !== null && v !== undefined && Number.isFinite(Number(v)),
  );
  const totalMwh = Number(
    numericTotalValues.reduce((s, v) => s + Number(v || 0), 0).toFixed(6),
  );
  const peakRaw = (totalValues || []).map((v) =>
    v !== null && v !== undefined && Number.isFinite(Number(v))
      ? Number(v)
      : null,
  );
  let peakIdx = -1;
  let peakVal = 0;
  peakRaw.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    if (v >= peakVal) {
      peakVal = v;
      peakIdx = i;
    }
  });
  const peakIntervalMwh = Number(peakVal.toFixed(6));
  const peakTs =
    peakIdx >= 0 && timeline?.[peakIdx] ? Number(timeline[peakIdx]) : 0;
  const peakAt = peakTs ? fmtTime(peakTs) : "—";
  const dayAheadTotalMwh = Number(
    (dayAheadValues || [])
      .filter(
        (v) => v !== null && v !== undefined && Number.isFinite(Number(v)),
      )
      .reduce((s, v) => s + Number(v || 0), 0)
      .toFixed(6),
  );
  const varianceMwh = Number((totalMwh - dayAheadTotalMwh).toFixed(6));
  const activeInverters = new Set(
    (rows || [])
      .filter((r) => Number(r?.kwh_inc || 0) > 0)
      .map((r) => Number(r?.inverter || 0))
      .filter(Boolean),
  ).size;
  let lastTs = 0;
  if (Array.isArray(timeline) && Array.isArray(totalValues)) {
    for (let i = totalValues.length - 1; i >= 0; i--) {
      if (
        totalValues[i] !== null &&
        totalValues[i] !== undefined &&
        Number.isFinite(Number(totalValues[i]))
      ) {
        lastTs = Number(timeline[i] || 0);
        break;
      }
    }
  }
  const lastLabel = lastTs ? fmtTime(lastTs) : "—";

  host.innerHTML = `
    <span class="toolbar-info">Interval: <b>${intervalMin}m</b></span>
    <span class="toolbar-info">Total: <b>${totalMwh.toFixed(3)} MWh</b></span>
    <span class="toolbar-info">Day-ahead: <b>${dayAheadTotalMwh.toFixed(3)} MWh</b></span>
    <span class="toolbar-info">Variance: <b>${varianceMwh >= 0 ? "+" : ""}${varianceMwh.toFixed(3)} MWh</b></span>
    <span class="toolbar-info">Plant Peak (${intervalMin}m): <b>${peakIntervalMwh.toFixed(3)} MWh</b> @ <b>${peakAt}</b></span>
    <span class="toolbar-info">Active Inv: <b>${activeInverters}</b></span>
    <span class="toolbar-info">Last: <b>${lastLabel}</b></span>
  `;

  const sideActual = $("anaSideActual");
  const sideDayAhead = $("anaSideDayAhead");
  const sideVariance = $("anaSideVariance");
  const sidePeak = $("anaSidePeak");
  if (sideActual) sideActual.textContent = `${totalMwh.toFixed(6)} MWh`;
  if (sideDayAhead)
    sideDayAhead.textContent = `${dayAheadTotalMwh.toFixed(6)} MWh`;
  if (sideVariance) {
    sideVariance.textContent = `${varianceMwh >= 0 ? "+" : ""}${varianceMwh.toFixed(6)} MWh`;
    sideVariance.classList.toggle("pos", varianceMwh >= 0);
    sideVariance.classList.toggle("neg", varianceMwh < 0);
  }
  if (sidePeak)
    sidePeak.textContent = `${peakIntervalMwh.toFixed(6)} MWh @ ${peakAt}`;
}

function buildAnalyticsDisplayTimeline(intervalMin = 5) {
  const d = String($("anaDate")?.value || today()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  const stepMs = Math.max(1, Number(intervalMin) || 5) * 60000;
  const startTs = new Date(
    `${d}T${pad2(ANALYTICS_VIEW_START_HOUR)}:00:00`,
  ).getTime();
  const endTs = new Date(
    `${d}T${pad2(ANALYTICS_VIEW_END_HOUR)}:${pad2(ANALYTICS_VIEW_END_MIN)}:00`,
  ).getTime();
  if (
    !Number.isFinite(startTs) ||
    !Number.isFinite(endTs) ||
    endTs <= startTs
  ) {
    return [];
  }
  const out = [];
  for (let ts = startTs; ts <= endTs; ts += stepMs) out.push(ts);
  return out;
}

function chartOpts(unit, showLegend) {
  const pal = getChartPalette();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    spanGaps: true,
    plugins: {
      legend: {
        display: !!showLegend,
        labels: { color: pal.legend, font: { family: "'Share Tech Mono'" } },
      },
      decimation: {
        enabled: true,
        algorithm: "lttb",
        samples: 120,
      },
    },
    scales: {
      x: {
        ticks: {
          color: pal.tick,
          font: { size: 8 },
          autoSkip: false,
          callback(value, index, ticks) {
            const total = Math.max(1, ticks?.length || 1);
            const step = Math.max(1, Math.ceil(total / 8));
            if (index === 0 || index === total - 1 || index % step === 0) {
              return this.getLabelForValue(value);
            }
            return "";
          },
          maxRotation: 0,
          minRotation: 0,
        },
        grid: { color: pal.grid },
      },
      y: {
        ticks: { color: pal.tick, font: { size: 9 } },
        grid: { color: pal.grid },
        title: {
          display: true,
          text: unit,
          color: pal.tick,
          font: { size: 10 },
        },
      },
    },
    layout: {
      padding: { top: 6, right: 6, bottom: 2, left: 4 },
    },
    interaction: { mode: "index", intersect: false },
  };
}

// ─── Export Page ──────────────────────────────────────────────────────────────
function initExportPage() {
  applyExportUiStateToInputs(State.settings.exportUiState || {});
  const t = today(),
    s = dateStr(new Date(Date.now() - 7 * 86400000));
  [
    ["expAlarmStart", "expAlarmEnd"],
    ["expEnergyStart", "expEnergyEnd"],
    ["expInvDataStart", "expInvDataEnd"],
    ["expAuditStart", "expAuditEnd"],
    ["expReportStart", "expReportEnd"],
  ].forEach(([a, b]) => {
    const ea = $(a),
      eb = $(b);
    if (ea && !ea.value) ea.value = s;
    if (eb && !eb.value) eb.value = t;
  });
  const expForecastDate = $("expForecastDate");
  if (expForecastDate && !expForecastDate.value) expForecastDate.value = t;
  const genDayCount = $("genDayCount");
  if (genDayCount) {
    const n = Number(genDayCount.value);
    if (!Number.isFinite(n) || n < 1) genDayCount.value = "1";
  }
  queuePersistExportUiState();
}

function clearExportButtonTimer(btnId) {
  const key = String(btnId || "").trim();
  if (!key) return;
  const timer = State.exportBtnTimers[key];
  if (timer) {
    clearInterval(timer);
    delete State.exportBtnTimers[key];
  }
}

function setExportButtonState(btnId, mode = "idle") {
  const btn = $(btnId);
  if (!btn) return;
  const key = String(btnId || "").trim();
  if (!btn.dataset.baseLabel) {
    btn.dataset.baseLabel = String(btn.textContent || "").trim() || "Export";
  }
  const base = btn.dataset.baseLabel;

  clearExportButtonTimer(key);
  btn.classList.remove("btn-export-busy", "btn-export-ok", "btn-export-fail");

  if (mode === "loading") {
    btn.disabled = true;
    btn.classList.add("btn-export-busy");
    let step = 0;
    btn.textContent = "Please wait.";
    State.exportBtnTimers[key] = setInterval(() => {
      step = (step + 1) % 3;
      btn.textContent = `Please wait${".".repeat(step + 1)}`;
    }, 320);
    return;
  }

  btn.disabled = false;
  if (mode === "ok") {
    btn.classList.add("btn-export-ok");
    btn.textContent = "Saved...";
    setTimeout(() => {
      btn.classList.remove("btn-export-ok");
      btn.textContent = base;
    }, 1800);
    return;
  }

  if (mode === "fail") {
    btn.classList.add("btn-export-fail");
    btn.textContent = "Failed...";
    setTimeout(() => {
      btn.classList.remove("btn-export-fail");
      btn.textContent = base;
    }, 2200);
    return;
  }

  btn.textContent = base;
}

async function runExport(
  type,
  invId,
  startId,
  endId,
  resultId,
  extraBody = {},
  btnId = "",
) {
  await persistExportUiState().catch(() => {});
  const inv = $(invId)?.value;
  const start = $(startId)?.value;
  const end = $(endId)?.value;
  const formatIdMap = {
    expAlarmInv: "expAlarmFormat",
    expEnergyInv: "expEnergyFormat",
    expInvDataInv: "expInvDataFormat",
    expAuditInv: "expAuditFormat",
  };
  const format = $(formatIdMap[invId])?.value || "xlsx";
  const res = $(resultId);
  if (res) {
    res.className = "exp-result";
    res.textContent = "Exporting…";
  }
  setExportButtonState(btnId, "loading");
  const startTs = start ? localDateStartMs(start) : undefined;
  const endTs = end ? localDateEndMs(end) : undefined;
  const body = { inverter: inv, startTs, endTs, format, ...extraBody };
  try {
    const r = await api(`/api/export/${type}`, "POST", body);
    if (res) {
      res.className = "exp-result";
      res.textContent = "✔ Saved: " + r.path;
    }
    await openExportPathFolder(r.path);
    setExportButtonState(btnId, "ok");
  } catch (e) {
    if (res) {
      res.className = "exp-result error";
      res.textContent = "✗ " + e.message;
    }
    setExportButtonState(btnId, "fail");
  }
}

async function runEnergyExport() {
  await runExport(
    "energy",
    "expEnergyInv",
    "expEnergyStart",
    "expEnergyEnd",
    "expEnergyResult",
    {},
    "btnRunEnergyExport",
  );
}

async function runForecastActualExport() {
  await persistExportUiState().catch(() => {});
  const day = $("expForecastDate")?.value;
  const format = $("expForecastFormat")?.value || "xlsx";
  const resolution = $("expForecastResolution")?.value || "5min";
  const res = $("expForecastResult");
  if (res) {
    res.className = "exp-result";
    res.textContent = "Exporting…";
  }
  setExportButtonState("btnRunForecastExport", "loading");
  const startTs = day ? localDateStartMs(day) : undefined;
  const endTs = day ? localDateEndMs(day) : undefined;
  try {
    const r = await api("/api/export/forecast-actual", "POST", {
      startTs,
      endTs,
      resolution,
      format,
    });
    if (res) {
      res.className = "exp-result";
      res.textContent = "✔ Saved: " + r.path;
    }
    await openExportPathFolder(r.path);
    setExportButtonState("btnRunForecastExport", "ok");
  } catch (e) {
    if (res) {
      res.className = "exp-result error";
      res.textContent = "✗ " + e.message;
    }
    setExportButtonState("btnRunForecastExport", "fail");
  }
}

async function runDayAheadGeneration() {
  if (isClientModeActive()) {
    const resBlocked = $("genDayResult");
    if (resBlocked) {
      resBlocked.className = "exp-result error";
      resBlocked.textContent =
        "✗ Unavailable in Client mode. Generate day-ahead on the Gateway server.";
    }
    showToast(
      "Day-ahead generation is disabled in Client mode. Please generate from the Gateway server.",
      "warning",
      4200,
    );
    return;
  }
  await persistExportUiState().catch(() => {});
  const dayCount = Math.min(
    31,
    Math.max(1, Math.trunc(Number($("genDayCount")?.value || 1))),
  );
  const res = $("genDayResult");
  if (res) {
    res.className = "exp-result";
    res.textContent = "Generating…";
  }
  try {
    const r = await api("/api/forecast/generate", "POST", {
      mode: "dayahead-days",
      dayCount,
    });
    if (res) {
      res.className = "exp-result";
      const start = r?.dates?.[0] || "";
      const end = r?.dates?.[r.dates.length - 1] || "";
      const provider = String(r?.providerUsed || "ml_local")
        .replace("ml_local", "Local ML")
        .replace("solcast", "Solcast");
      const fb = r?.fallbackUsed ? " (fallback)" : "";
      res.textContent = `✔ Generated ${Number(r.count || 0)} day(s) from ${start} to ${end} via ${provider}${fb}`;
      if (r?.fallbackUsed && r?.fallbackReason) {
        showToast(`Forecast fallback: ${r.fallbackReason}`, "warning", 5000);
      }
    }
    if (State.currentPage === "analytics") {
      loadAnalytics({ force: true }).catch(() => {});
    }
  } catch (e) {
    if (res) {
      res.className = "exp-result error";
      res.textContent = `✗ ${e.message}`;
    }
  }
}

async function runInverterDataExport() {
  await runExport(
    "inverter-data",
    "expInvDataInv",
    "expInvDataStart",
    "expInvDataEnd",
    "expInvDataResult",
    {},
    "btnRunInvDataExport",
  );
}

async function runDailyReportExport() {
  await persistExportUiState().catch(() => {});
  let start = $("expReportStart").value;
  let end = $("expReportEnd").value;
  if (!start && !end) {
    start = today();
    end = start;
    if ($("expReportStart")) $("expReportStart").value = start;
    if ($("expReportEnd")) $("expReportEnd").value = end;
  } else if (start && !end) {
    end = start;
    if ($("expReportEnd")) $("expReportEnd").value = end;
  } else if (!start && end) {
    start = end;
    if ($("expReportStart")) $("expReportStart").value = start;
  }
  const format = $("expReportFormat")?.value || "xlsx";
  const res = $("expReportResult");
  if (res) {
    res.className = "exp-result";
    res.textContent = "Exporting…";
  }
  setExportButtonState("btnRunDailyReportExport", "loading");
  const startTs = start ? localDateStartMs(start) : undefined;
  const endTs = end ? localDateEndMs(end) : undefined;
  try {
    if (start) {
      await api(
        `/api/report/daily?date=${encodeURIComponent(start)}&refresh=1`,
        "GET",
      );
    }
    const r = await api("/api/export/daily-report", "POST", {
      startTs,
      endTs,
      format,
    });
    if (!r?.path) throw new Error("Export did not return output path.");
    if (res) {
      res.className = "exp-result";
      res.textContent = "✔ Saved: " + r.path;
    }
    await openExportPathFolder(r.path);
    setExportButtonState("btnRunDailyReportExport", "ok");
  } catch (e) {
    if (res) {
      res.className = "exp-result error";
      res.textContent = "✗ " + e.message;
    }
    setExportButtonState("btnRunDailyReportExport", "fail");
  }
}

function dirFromFilePath(filePath) {
  const p = String(filePath || "").trim();
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : p;
}

async function openExportPathFolder(filePath) {
  const dir = dirFromFilePath(filePath);
  if (!dir) return;
  try {
    if (window.electronAPI?.openFolder) {
      await window.electronAPI.openFolder(dir);
    }
  } catch (err) {
    console.warn("[app] openExportPathFolder failed:", err.message);
  }
}

// ─── Event Bindings ───────────────────────────────────────────────────────────
function bindEventHandlers() {
  // Logo fallback
  const logoImg = $("logo-img");
  if (logoImg) {
    logoImg.onerror = function () {
      this.style.display = "none";
      const logoText = $("logo-text");
      if (logoText) logoText.style.display = "flex";
    };
  }

  // Inverter page
  $("invFilter")?.addEventListener("change", filterInverters);
  $("invGridLayout")?.addEventListener("change", (e) => setInverterGridLayout(e.target.value));

  // Analytics page
  $("btnLoadAnalytics")?.addEventListener("click", () => loadAnalytics());

  // Alarms page
  $("btnFetchAlarms")?.addEventListener("click", fetchAlarms);
  $("btnAckAll")?.addEventListener("click", ackAll);

  // Energy page
  $("btnFetchEnergy")?.addEventListener("click", fetchEnergy);

  // Audit page
  $("btnFetchAudit")?.addEventListener("click", fetchAudit);
  $("btnResetAuditFilters")?.addEventListener("click", resetAuditFilters);

  // Daily Report page
  $("btnFetchReport")?.addEventListener("click", fetchReport);
  $("btnExportDailyReport")?.addEventListener("click", exportDailyReport);

  // Export page
  $("btnExportAlarms")?.addEventListener("click", () =>
    runExport(
      "alarms",
      "expAlarmInv",
      "expAlarmStart",
      "expAlarmEnd",
      "expAlarmResult",
      {},
      "btnExportAlarms",
    ));
  $("btnRunEnergyExport")?.addEventListener("click", runEnergyExport);
  $("btnRunForecastExport")?.addEventListener("click", runForecastActualExport);
  $("btnRunInvDataExport")?.addEventListener("click", runInverterDataExport);
  $("btnExportAudit")?.addEventListener("click", () =>
    runExport(
      "audit",
      "expAuditInv",
      "expAuditStart",
      "expAuditEnd",
      "expAuditResult",
      {},
      "btnExportAudit",
    ));
  $("btnRunDailyReportExport")?.addEventListener("click", runDailyReportExport);

  // Settings page
  $("btnSolcastSaveTest")?.addEventListener("click", saveAndTestSolcast);
  $("btnSolcastTest")?.addEventListener("click", testSolcastConnection);
  $("btnUploadLicense")?.addEventListener("click", uploadLicenseFromSettings);
  $("btnRefreshLicense")?.addEventListener("click", refreshLicenseSection);
  $("btnSaveSettings")?.addEventListener("click", saveSettings);
  $("setOperationMode")?.addEventListener("change", () => {
    syncOperationModeUi();
    syncDayAheadGeneratorAvailability();
  });
  $("setRemoteAutoSync")?.addEventListener("change", syncOperationModeUi);
  $("setRemoteGatewayUrl")?.addEventListener("blur", applyRemoteGatewayInputNormalization);
  $("btnTestRemoteGateway")?.addEventListener("click", testRemoteGateway);
  $("btnCheckTailscale")?.addEventListener("click", checkTailscaleStatus);
  $("btnRefreshReplicationHealth")?.addEventListener("click", () =>
    refreshReplicationHealth(false),
  );
  $("btnRefreshRuntimePerf")?.addEventListener("click", () =>
    refreshRuntimePerf(false),
  );
  $("btnRunReplicationPull")?.addEventListener("click", runReplicationPullNow);
  $("btnRunReplicationPush")?.addEventListener("click", runReplicationPushNow);
  $("btnPickExportFolder")?.addEventListener("click", pickExportFolder);
  $("btnOpenExportFolder")?.addEventListener("click", openExportFolder);
  $("btnOpenIpConfig")?.addEventListener("click", openIpConfigSettings);
  $("btnOpenGuide")?.addEventListener("click", openGuideModal);

  // Notification panel
  $("notifBell")?.addEventListener("click", toggleNotif);
  $("btnCloseNotif")?.addEventListener("click", closeNotif);

  // Guide modal
  $("btnCloseGuide")?.addEventListener("click", closeGuideModal);

  // Cleanup intervals on page unload
  window.addEventListener("beforeunload", () => {
    clearInterval(State.clockTimer);
    clearInterval(State.alarmBadgeTimer);
    if (State.netIO.monitorTimer) { clearInterval(State.netIO.monitorTimer); State.netIO.monitorTimer = null; }
    if (State.xfer.hideTimer) { clearTimeout(State.xfer.hideTimer); State.xfer.hideTimer = null; }
    stopReplicationHealthPolling();
    stopTodayMwhSyncTimer();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  initThemeToggle();
  await initLicenseBridge();
  startClock();
  setupSideNav();
  initGuideModal();
  setupNav();
  document.addEventListener(
    "pointerdown",
    () => {
      try {
        const ctx = getOrCreateAlarmAudioCtx();
        if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
      } catch (err) {
        console.warn("[app] audio resume failed:", err.message);
      }
    },
    { passive: true },
  );
  bindEventHandlers();
  await loadSettings();
  syncDayAheadGeneratorAvailability();
  bindExportUiStatePersistence();
  setupExportUiStateFlush();
  await loadIpConfig();
  await seedTodayEnergyFromDb();
  startTodayMwhSyncTimer();
  buildInverterGrid();
  buildSelects();
  connectWS();
  startNetIOMonitor();
  refreshAlarmBadge();

  // Refresh alarm badge every 30s
  State.alarmBadgeTimer = setInterval(refreshAlarmBadge, 30000);
}

document.addEventListener("DOMContentLoaded", init);
