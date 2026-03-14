"use strict";
/* ═══════════════════════════════════════════════════════════════════════
   Dashboard V2 — Main Application
   WebSocket-driven, real-time inverter monitoring & control
   Designed & Developed by Engr. Clariden Montaño REE (Engr. M.)
   © 2026 Engr. Clariden Montaño REE. All rights reserved.
   ═══════════════════════════════════════════════════════════════════════ */

function createXferSlot(dir) {
  return {
    dir,
    active: false,
    phase: "idle",
    label: "",
    totalBytes: 0,
    doneBytes: 0,
    chunkCount: 0,
    chunkDone: 0,
    totalRows: 0,
    importedRows: 0,
    priorityMode: false,
    livePaused: false,
    stage: "",
    note: "",
    rateBps: 0,
    peakBps: 0,
    lastSampleBytes: 0,
    lastSampleTs: 0,
    hideTimer: null,
    updatedAt: 0,
  };
}

const REPLICATION_INCLUDE_ARCHIVE_PREF_KEY = "replicationIncludeArchiveNext";

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
    plantName: "ADSI Plant",
    operatorName: "OPERATOR",
    csvSavePath: "C:\\Logs\\InverterDashboard",
    forecastProvider: "ml_local",
    solcastBaseUrl: "https://api.solcast.com.au",
    solcastAccessMode: "toolkit",
    solcastApiKey: "",
    solcastResourceId: "",
    solcastToolkitEmail: "",
    solcastToolkitPassword: "",
    solcastToolkitSiteRef: "",
    solcastTimezone: "Asia/Manila",
    plantCapUpperMw: null,
    plantCapLowerMw: null,
    plantCapSequenceMode: "ascending",
    plantCapSequenceCustom: [],
    plantCapCooldownSec: 30,
    invGridLayout: "4",
    exportUiState: {},
  },
  plantCap: {
    status: null,
    preview: null,
  },
  plantCapPanelCollapsed: true,
  todayKwh: {}, // key: inverter → kWh today
  alarmFilter: "all",
  ws: null,
  wsConnecting: false,
  wsReconnectTimer: null,
  charts: {},
  currentPage: "inverters",
  wsRetries: 0,
  invLastFresh: {}, // key: inverter -> last fresh timestamp
  analyticsReqId: 0,
  alarmReqId: 0,
  energyReqId: 0,
  auditReqId: 0,
  reportReqId: 0,
  forecastExportFormat: "standard",
  analyticsRealtimeTimer: null,
  analyticsFetchTimer: null,
  analyticsFetchInFlight: false,
  analyticsBaseRows: [],
  analyticsDayAheadBaseRows: [],
  analyticsIntervalMin: 5,
  analyticsDailyTotalMwh: null,
  analyticsActualSummarySyncAt: 0,
  analyticsActualSummarySyncDay: "",
  analyticsWeeklyWeather: [],
  analyticsWeatherDate: "",
  analyticsRenderTimer: null,
  analyticsRenderToken: 0,
  // Dayahead aggregation cache — invalidated by reference/interval change (not a timer).
  analyticsDayAheadCache: null,  // { src, intervalMin, result }
  // Live-PAC signature used by the 2-s realtime timer to skip redundant re-renders.
  analyticsLastPacSig: "",
  activeAlarms: {}, // key: `${inv}_${unit}` -> active alarm row
  alarmSoundTimer: null,
  alarmSoundRecheckTimer: null,
  alarmAudioCtx: null,
  alarmSoundMuted: false,
  alarmLiveSig: "",
  alarmLiveSyncing: false,
  pendingAlarmLiveSig: "",
  exportUiSaveTimer: null,
  exportBtnTimers: {},
  exportAbortControllers: {},
  alarmView: {
    rows: [],
    page: 1,
    pageSize: 180,
    queryKey: "",
  },
  energyView: {
    page: 1,
    pageSize: 500,
    totalRows: 0,
    rows: [],
    summary: null,
    serverPaged: true,
    queryKey: "",
  },
  auditView: {
    rows: [],
    sortKey: "ts",
    sortDir: "desc",
    page: 1,
    pageSize: 200,
    queryKey: "",
  },
  reportView: {
    rows: [],
    sortKey: "inverter",
    sortDir: "asc",
    summary: null,
    page: 1,
    pageSize: 120,
    queryKey: "",
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
  todayEnergyByInv: {},
  currentDaySummary: {
    day: "",
    asOfTs: 0,
    totalKwh: null,
    totalMwh: null,
    inverterCount: 0,
  },
  todayMwh: {
    wsAuthoritative: false,
    wsLastFrameAt: 0,
    wsLastEnergyAt: 0,
    wsLastAdvanceAt: 0,
    wsLastTotalKwh: null,
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
  replication: {
    job: null,
    scope: null,
    restartPromptedJobId: "",
    includeArchiveNext: false,
  },
  modeTransition: {
    active: false,
    targetMode: "",
    startedAt: 0,
    detail: "",
    liveWaiters: [],
  },
  remoteHealth: {},
  solcastPreview: {
    day: "",
    days: [],
    dayCount: 1,
    selectedDays: [],
    rangeLabel: "",
    loaded: false,
    payload: null,
    resolution: "PT5M",
    unit: "mwh",
    exportFormat: "standard",
  },
  xfer: {
    slots: {
      tx: createXferSlot("tx"),
      rx: createXferSlot("rx"),
    },
  },
  licenseStatus: null,
  licenseAudit: [],
  appUpdate: {
    mode: "disabled",
    modeLabel: "Unavailable",
    appVersion: "",
    status: "idle",
    message: "",
    checking: false,
    updateAvailable: false,
    latestVersion: "",
    downloadPercent: 0,
    canDownload: false,
    canInstall: false,
    downloadUrl: "",
    checkedAt: 0,
    error: "",
  },
  chatOpen: false,
  chatUnread: 0,
  chatMessages: [],
  chatDismissTimer: null,
  chatLastReadId: 0,
  chatLastInboundId: 0,
  chatPendingSend: false,
  chatPendingClear: false,
  chatAudioReady: false,
  chatReadInFlight: false,
  chatPendingReadUpToId: 0,
  chatHistoryLoaded: false,
  clockTimer: null,
  alarmBadgeTimer: null,
  replicationHealthTimer: null,
  todayMwhSyncTimer: null,
  cardRenderScheduled: false,
  cardRenderTimer: null,
  lastCardRenderTs: 0,
  nodeOrderSig: {},
  // Stale-tab cache: tab name → ms of last successful data fetch.
  // Prevents redundant re-fetches when switching tabs rapidly.
  tabFetchTs: {},
  // In-flight fetch guard: tab name → true while HTTP request is active.
  tabFetching: {},
  // Tracks the calendar day when tab dates were last reset to today (YYYY-MM-DD).
  lastDateInitDay: "",
  // Single-inverter detail panel state.
  invDetailInv: 0,
  invDetailLoading: false,
  invDetailKwh: 0,          // kWh today for selected inverter (from /api/energy/today)
  invDetailAlarmRows: [],   // cached alarm rows for live chip refresh
  invDetailReportRows: [],  // cached report rows for live chip refresh
  invDetailRefreshTimer: null, // setInterval ref for periodic kWh refresh
};
const TAB_STALE_MS = 60000; // 60 s — prefetch on startup keeps cache warm; re-fetch after that
const MAX_INV_UNITS = 4;
const NODE_RATED_W  = Math.round(997000 / MAX_INV_UNITS); // 249,250 W — rated per-node (997 kW ÷ 4)
const INV_RATED_KW  = 997;                                 // rated per-inverter capacity kW
const INV_DEPENDABLE_KW = 917;
const DATA_FRESH_MS = 15000;
const CARD_OFFLINE_HOLD_MS = 15000;
const CARD_RENDER_MIN_INTERVAL_MS = 220;
const TABLE_FILTER_DEBOUNCE_MS = 140;
const ANALYTICS_VIEW_START_HOUR = 5;
const ANALYTICS_VIEW_END_HOUR = 18;
const ANALYTICS_VIEW_END_MIN = 0;
const ANALYTICS_CHART_RENDER_BATCH = 6;
const THEME_STORAGE_KEY = "adsi_theme";
const SUPPORTED_THEMES = ["dark", "light", "classic"];
const SUPPORTED_INV_GRID_LAYOUTS = ["auto", "2", "3", "4", "5", "6", "7"];
const TODAY_MWH_SYNC_INTERVAL_MS = 1000; // keep header near-realtime and aligned with server totals
const TODAY_MWH_WS_FRAME_STALE_MS = 15000;
const TODAY_MWH_WS_ENERGY_STALE_MS = 15000;
const TODAY_MWH_WS_NO_ADVANCE_MS = 30000;
const TODAY_MWH_WS_ADVANCE_MIN_PAC_W = 20000;
const ACTUAL_MWH_HTTP_SYNC_INTERVAL_MS = 5000;
const ALARM_SOUND_MIN_ACTIVE_MS = 5000;
const CHAT_THREAD_LIMIT = 20;
const CHAT_DISMISS_MS = 30000;
const SETTINGS_SECTION_IDS = [
  "plantConfigSection",
  "opsCompactSection",
  "connectivitySection",
  "licenseSection",
  "appUpdateSection",
  "cloudBackupSection",
];
const DEFAULT_SETTINGS_SECTION_ID = "plantConfigSection";
const SETTINGS_SECTION_META = {
  plantConfigSection: {
    title: "Plant Configuration",
    copy: "Review site identity, fleet sizing, and the core values used across the dashboard.",
  },
  opsCompactSection: {
    title: "Data & Polling",
    copy: "Review operational endpoints, export storage, and polling timing from one controlled section.",
  },
  connectivitySection: {
    title: "Connectivity & Gateway Link",
    copy: "Define gateway or remote operation, then review gateway link status and runtime health.",
  },
  licenseSection: {
    title: "License",
    copy: "Review entitlement state, remaining term, and license activity, then replace the current file when needed.",
  },
  appUpdateSection: {
    title: "App Updates",
    copy: "Review the installed build, compare it with the release channel, and run update actions from here.",
  },
  cloudBackupSection: {
    title: "Cloud Backup",
    copy: "Configure approved providers, backup scope, restore actions, and backup history.",
  },
};
const SETTINGS_CONFIG_KIND = "adsi-settings-config";
const SETTINGS_CONFIG_SCHEMA_VERSION = 1;
const SETTINGS_CONFIG_FILE_FILTERS = [
  { name: "ADSI Settings Config", extensions: ["json"] },
];
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
const SOLCAST_PREVIEW_RESOLUTIONS = ["PT5M", "PT10M", "PT15M", "PT30M", "PT60M"];

function normalizeSolcastPreviewResolutionClient(value) {
  const raw = String(value || "PT5M")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return SOLCAST_PREVIEW_RESOLUTIONS.includes(raw) ? raw : "PT5M";
}

function getSolcastPreviewBucketMinutesClient(value) {
  const resolution = normalizeSolcastPreviewResolutionClient(value);
  const minutes = Number.parseInt(resolution.replace(/^PT/i, "").replace(/M$/i, ""), 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
}

function normalizeSolcastPreviewExportFormatClient(value) {
  const raw = String(value || "standard")
    .trim()
    .toLowerCase();
  return raw === "average-table" ? "average-table" : "standard";
}

function getSelectedSolcastPreviewResolution() {
  return normalizeSolcastPreviewResolutionClient(
    $("solcastPreviewResolution")?.value || State.solcastPreview.resolution || "PT5M",
  );
}

function getSharedForecastExportFormat() {
  return normalizeSolcastPreviewExportFormatClient(
    State.forecastExportFormat ||
      State.solcastPreview.exportFormat ||
      $("anaDayAheadExportFormat")?.value ||
      $("expForecastExportFormat")?.value ||
      $("solcastPreviewExportFormat")?.value ||
      "standard",
  );
}

function syncForecastActualFileFormatControl(exportFormat) {
  const formatSel = $("expForecastFormat");
  if (!formatSel) return;
  const normalized = normalizeSolcastPreviewExportFormatClient(exportFormat);
  const forceXlsx = normalized === "average-table";
  if (forceXlsx) {
    formatSel.value = "xlsx";
  }
  formatSel.disabled = forceXlsx;
}

function syncSharedForecastExportFormatControls(value) {
  const normalized = normalizeSolcastPreviewExportFormatClient(value);
  State.forecastExportFormat = normalized;
  State.solcastPreview.exportFormat = normalized;
  ["solcastPreviewExportFormat", "anaDayAheadExportFormat", "expForecastExportFormat"].forEach((id) => {
    const input = $(id);
    if (!input || input.value === normalized) return;
    input.value = normalized;
  });
  syncForecastActualFileFormatControl(normalized);
  return normalized;
}

function getSelectedSolcastPreviewExportFormat() {
  return getSharedForecastExportFormat();
}

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

function parseOptionalNumberInputValue(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function normalizePlantCapSequenceModeClient(value) {
  const mode = String(value || "ascending")
    .trim()
    .toLowerCase();
  if (mode === "custom") return "exemption";
  if (mode === "descending" || mode === "exemption") return mode;
  return "ascending";
}

function parsePlantCapSequenceInputClient(raw, maxInverter = 27) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, values: [], error: "" };
  const tokens = text.split(/[,\s]+/g).filter(Boolean);
  const values = [];
  const seen = new Set();
  const invalid = [];
  tokens.forEach((token) => {
    const inv = Number(token);
    if (
      !Number.isInteger(inv) ||
      inv < 1 ||
      inv > maxInverter ||
      seen.has(inv)
    ) {
      invalid.push(token);
      return;
    }
    seen.add(inv);
    values.push(inv);
  });
  if (invalid.length) {
    return {
      ok: false,
      values: [],
      error: `Exempted inverter numbers must be a comma-separated list of unique inverter numbers from 1-${maxInverter}. Invalid item(s): ${invalid.join(", ")}.`,
    };
  }
  return { ok: true, values, error: "" };
}

function formatPlantCapSequenceInputClient(valuesRaw) {
  const values = Array.isArray(valuesRaw) ? valuesRaw : [];
  return values
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)
    .join(", ");
}

function getStoredPlantCapPanelCollapsed() {
  return true;
}

function syncPlantCapPanelCollapsedUi() {
  const inverterPage = $("page-inverters");
  const panel = $("plantCapPanel");
  const toolbarToggle = $("btnPlantCapToolbarToggle");
  const collapsed = Boolean(State.plantCapPanelCollapsed);
  if (inverterPage) {
    inverterPage.classList.toggle("plant-cap-panel-collapsed", collapsed);
  }
  if (panel) {
    panel.classList.toggle("is-collapsed", collapsed);
    panel.classList.toggle("is-hidden", collapsed);
    panel.hidden = collapsed;
    panel.style.display = collapsed ? "none" : "";
    panel.setAttribute("aria-hidden", collapsed ? "true" : "false");
  }
  if (toolbarToggle) {
    // Plant cap remains available in Remote mode via gateway proxy, so the
    // toolbar toggle must always stay usable even if broader control sweeps
    // temporarily disable nearby buttons.
    toolbarToggle.disabled = false;
    toolbarToggle.removeAttribute("disabled");
    toolbarToggle.setAttribute("aria-disabled", "false");
    toolbarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toolbarToggle.textContent = collapsed ? "Show Cap" : "Hide Cap";
    toolbarToggle.title = collapsed
      ? "Show plant output cap panel"
      : "Hide plant output cap panel";
  }
}

function setPlantCapPanelCollapsed(collapsed) {
  State.plantCapPanelCollapsed = !!collapsed;
  syncPlantCapPanelCollapsedUi();
}

function togglePlantCapPanelCollapsed() {
  setPlantCapPanelCollapsed(!State.plantCapPanelCollapsed);
}

function getPlantCapFieldIds(context = "live") {
  if (context === "settings") {
    return {
      upper: "setPlantCapUpperMw",
      lower: "setPlantCapLowerMw",
      sequenceMode: "setPlantCapSequenceMode",
      sequenceCustom: "setPlantCapSequenceCustom",
      sequenceCustomWrap: "setPlantCapSequenceCustomWrap",
      cooldown: "setPlantCapCooldownSec",
      warnings: "setPlantCapClientWarnings",
    };
  }
  return {
    upper: "plantCapUpperMw",
    lower: "plantCapLowerMw",
    sequenceMode: "plantCapSequenceMode",
    sequenceCustom: "plantCapSequenceCustom",
    sequenceCustomWrap: "plantCapSequenceCustomWrap",
    cooldown: "plantCapCooldownSec",
    warnings: "plantCapClientWarnings",
  };
}

function getPlantCapFormElements(context = "live") {
  const ids = getPlantCapFieldIds(context);
  return {
    upper: $(ids.upper),
    lower: $(ids.lower),
    sequenceMode: $(ids.sequenceMode),
    sequenceCustom: $(ids.sequenceCustom),
    sequenceCustomWrap: $(ids.sequenceCustomWrap),
    cooldown: $(ids.cooldown),
    warnings: $(ids.warnings),
  };
}

function readPlantCapFormRawValues(context = "live") {
  const els = getPlantCapFormElements(context);
  return {
    upper: String(els.upper?.value ?? ""),
    lower: String(els.lower?.value ?? ""),
    sequenceMode: normalizePlantCapSequenceModeClient(
      els.sequenceMode?.value || "ascending",
    ),
    sequenceCustom: String(els.sequenceCustom?.value ?? ""),
    cooldown: String(els.cooldown?.value ?? ""),
  };
}

function applyPlantCapFormRawValues(
  values,
  contexts = ["live", "settings"],
  options = {},
) {
  const skipContext = String(options.skipContext || "").trim().toLowerCase();
  const payload = values && typeof values === "object" ? values : {};
  contexts.forEach((contextRaw) => {
    const context = String(contextRaw || "").trim().toLowerCase();
    if (!context || context === skipContext) return;
    const els = getPlantCapFormElements(context);
    if (els.upper && Object.prototype.hasOwnProperty.call(payload, "upper")) {
      els.upper.value = String(payload.upper ?? "");
    }
    if (els.lower && Object.prototype.hasOwnProperty.call(payload, "lower")) {
      els.lower.value = String(payload.lower ?? "");
    }
    if (
      els.sequenceMode &&
      Object.prototype.hasOwnProperty.call(payload, "sequenceMode")
    ) {
      els.sequenceMode.value = normalizePlantCapSequenceModeClient(
        payload.sequenceMode,
      );
    }
    if (
      els.sequenceCustom &&
      Object.prototype.hasOwnProperty.call(payload, "sequenceCustom")
    ) {
      els.sequenceCustom.value = String(payload.sequenceCustom ?? "");
    }
    if (
      els.cooldown &&
      Object.prototype.hasOwnProperty.call(payload, "cooldown")
    ) {
      els.cooldown.value = String(payload.cooldown ?? "");
    }
  });
  syncPlantCapSequenceVisibility();
  renderPlantCapClientWarnings();
}

function readPlantCapRequestValues(context = "live") {
  const raw = readPlantCapFormRawValues(context);
  const maxInverter = Number(State.settings.inverterCount || 27);
  const sequenceMode = normalizePlantCapSequenceModeClient(raw.sequenceMode);
  const sequenceParsed = parsePlantCapSequenceInputClient(
    raw.sequenceCustom,
    maxInverter,
  );
  const upperMw = parseOptionalNumberInputValue(raw.upper);
  const lowerMw = parseOptionalNumberInputValue(raw.lower);
  const cooldownRaw = parseOptionalNumberInputValue(raw.cooldown);
  const cooldownSec =
    cooldownRaw == null ? Number(State.settings.plantCapCooldownSec || 30) : cooldownRaw;
  return {
    upperMw,
    lowerMw,
    sequenceMode,
    sequenceCustom: sequenceParsed.values,
    sequenceCustomText: raw.sequenceCustom,
    sequenceError: sequenceMode === "exemption" ? sequenceParsed.error : "",
    cooldownSec: Math.max(5, Math.min(600, Number(cooldownSec || 30))),
  };
}

function getClientPlantCapStepMetrics(context = "live", valuesOverride = null) {
  const invCount = Number(State.settings.inverterCount || 27);
  const nodeCount = Number(State.settings.nodeCount || 4);
  const values =
    valuesOverride && typeof valuesOverride === "object"
      ? valuesOverride
      : readPlantCapRequestValues(context);
  const exempted = new Set(
    values.sequenceMode === "exemption" ? values.sequenceCustom || [] : [],
  );
  const stepsKw = [];
  const nodeShapes = new Set();
  for (let inv = 1; inv <= invCount; inv += 1) {
    if (exempted.has(inv)) continue;
    const ip = String(
      State.ipConfig?.inverters?.[inv] ??
        State.ipConfig?.inverters?.[String(inv)] ??
        "",
    ).trim();
    const configuredUnits = getConfiguredUnits(inv, nodeCount);
    if (!ip || !configuredUnits.length) continue;
    const dependableKw = (INV_DEPENDABLE_KW * configuredUnits.length) / MAX_INV_UNITS;
    stepsKw.push(dependableKw);
    nodeShapes.add(configuredUnits.length);
  }
  const smallestConfiguredStepKw = stepsKw.length ? Math.min(...stepsKw) : null;
  return {
    smallestConfiguredStepKw,
    smallestConfiguredStepMw:
      smallestConfiguredStepKw != null
        ? smallestConfiguredStepKw / 1000
        : null,
    partialNodeFleet: nodeShapes.size > 1,
    controllableInverterCount: stepsKw.length,
  };
}

function buildPlantCapClientWarningMessages(context = "live") {
  const values = readPlantCapRequestValues(context);
  const warnings = [];
  const metrics = getClientPlantCapStepMetrics(context, values);
  if (values.sequenceError) {
    warnings.push(values.sequenceError);
  }
  if (
    values.sequenceMode === "exemption" &&
    values.sequenceCustom.length &&
    metrics.controllableInverterCount === 0
  ) {
    warnings.push(
      "Every controllable inverter is currently exempted, so automatic stop selection has no available target.",
    );
  }
  if (values.upperMw == null || values.lowerMw == null) {
    return warnings;
  }
  if (!(values.lowerMw < values.upperMw)) {
    warnings.push("Lower limit must be less than the upper limit.");
  }
  const gapMw = values.upperMw - values.lowerMw;
  if (metrics.smallestConfiguredStepMw != null) {
    if (gapMw < metrics.smallestConfiguredStepMw * 0.5) {
      warnings.push(
        `Upper and Lower limits are extremely close. The smallest configured inverter step is about ${metrics.smallestConfiguredStepMw.toFixed(3)} MW, so the controller can overshoot the band or repeatedly stop/start inverters before it settles.`,
      );
    } else if (gapMw < metrics.smallestConfiguredStepMw) {
      warnings.push(
        `Upper and Lower limits are close relative to the smallest configured inverter step of about ${metrics.smallestConfiguredStepMw.toFixed(3)} MW. Increase the band gap to reduce stop/start hunting and operator confusion.`,
      );
    }
  }
  if (metrics.partialNodeFleet) {
    warnings.push(
      "Configured inverters have different enabled node counts, so each inverter shutdown step can remove a different amount of MW.",
    );
  }
  return warnings;
}

function renderPlantCapClientWarningsForContext(context = "live") {
  const els = getPlantCapFormElements(context);
  if (!els.warnings) return;
  const warnings = buildPlantCapClientWarningMessages(context);
  if (!warnings.length) {
    els.warnings.className = "plant-cap-inline-warnings";
    els.warnings.textContent =
      "Whole-inverter control uses live PAC plus node-aware dependable capacity to plan each stop/start step. Exemption mode skips the listed inverter numbers during automatic stop selection.";
    els.warnings.title =
      "Planner guidance for the current plant cap settings. Exemption mode keeps the listed inverter numbers out of automatic stop selection.";
    return;
  }
  const critical = warnings.some((message) =>
    /extremely close|must be less/i.test(message),
  );
  els.warnings.className = `plant-cap-inline-warnings ${critical ? "critical" : "warning"}`;
  els.warnings.textContent = warnings[0];
  els.warnings.title = warnings.join(" ");
}

function renderPlantCapClientWarnings() {
  renderPlantCapClientWarningsForContext("live");
  renderPlantCapClientWarningsForContext("settings");
}

function syncPlantCapSequenceVisibility() {
  ["live", "settings"].forEach((context) => {
    const els = getPlantCapFormElements(context);
    if (!els.sequenceCustomWrap) return;
    const show =
      normalizePlantCapSequenceModeClient(els.sequenceMode?.value || "ascending") ===
      "exemption";
    els.sequenceCustomWrap.hidden = !show;
  });
}

function syncPlantCapFormContext(sourceContext) {
  const normalizedContext = String(sourceContext || "").trim().toLowerCase();
  const raw = readPlantCapFormRawValues(normalizedContext);
  applyPlantCapFormRawValues(raw, ["live", "settings"], {
    skipContext: normalizedContext,
  });
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

function licenseStatusLabel(status) {
  if (!status) return "Unknown";
  if (status.valid) {
    if (status.lifetime) return "Valid (Lifetime)";
    if (status.nearExpiry) return "Valid (Expiring Soon)";
    return "Valid";
  }
  switch (String(status.code || "").toLowerCase()) {
    case "trial_not_started":
      return "Trial Not Started";
    case "trial_expired":
      return "Expired (Trial)";
    case "license_expired":
      return "Expired";
    case "device_mismatch":
      return "Invalid (Device Mismatch)";
    case "license_error":
      return "License Error";
    default:
      return "Expired / Invalid";
  }
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
  const remaining = String(status?.remainingText || "").trim() || fmtRemaining(Number(status?.msLeft || 0));
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
        renderLicenseSummary();
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
  const aboutEl = $("aboutLicenseStatus");
  if (!statusEl || !sourceEl || !expiryEl || !daysEl) return;

  statusEl.classList.remove("ok", "warn", "error");
  if (aboutEl) aboutEl.className = "side-about-inline-status";

  if (!status) {
    statusEl.textContent = "Unknown";
    sourceEl.textContent = "—";
    expiryEl.textContent = "—";
    daysEl.textContent = "—";
    if (aboutEl) aboutEl.textContent = "Unknown";
    return;
  }

  const statusText = licenseStatusLabel(status);
  statusEl.textContent = statusText;
  if (status.valid && !status.nearExpiry) statusEl.classList.add("ok");
  else if (status.valid && status.nearExpiry) statusEl.classList.add("warn");
  else statusEl.classList.add("error");

  const sourceMap = {
    trial: "Trial",
    license: "License",
    device: "Device",
  };
  const sourceText =
    sourceMap[String(status.source || "").toLowerCase()] || String(status.source || "—");
  sourceEl.textContent = sourceText;
  if (aboutEl) {
    if (status.valid && !status.nearExpiry) aboutEl.classList.add("ok");
    else if (status.valid && status.nearExpiry) aboutEl.classList.add("warn");
    else aboutEl.classList.add("error");
  }

  if (status.lifetime) {
    expiryEl.textContent = "Never (Lifetime)";
    daysEl.textContent = "∞";
    if (aboutEl) {
      const prefix = sourceText === "License" ? "" : `${sourceText}: `;
      aboutEl.textContent = `${prefix}Lifetime`;
    }
    return;
  }

  const exp = Number(status.expiresAt || 0);
  if (!Number.isFinite(exp) || exp <= 0) {
    expiryEl.textContent = "—";
    daysEl.textContent = "—";
    if (aboutEl) aboutEl.textContent = statusText;
    return;
  }

  expiryEl.textContent = fmtDateTime(exp);
  const dLeft = Number.isFinite(Number(status.daysLeft))
    ? Math.max(0, Number(status.daysLeft))
    : Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
  daysEl.textContent = `${dLeft}`;
  if (aboutEl) {
    const prefix = sourceText === "License" ? "" : `${sourceText}: `;
    const remaining = String(status?.remainingText || "").trim() || fmtRemaining(Number(status.msLeft || 0));
    aboutEl.textContent = status.valid
      ? status.nearExpiry
        ? `${prefix}Expiring in ${remaining}`
        : `${prefix}${dLeft} day(s) left`
      : String(status.message || statusText);
  }
}

function renderLicenseAuditRows() {
  const tbody = $("licenseAuditBody");
  if (!tbody) return;
  const rows = Array.isArray(State.licenseAudit) ? State.licenseAudit : [];
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty"><td colspan="4">No license activity recorded.</td></tr>';
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

function setUpdateField(id, value, cls = "") {
  const node = $(id);
  if (!node) return;
  node.textContent = value == null || value === "" ? "—" : String(value);
  node.className = `license-value ${cls}`.trim();
}

function getUpdateStatusClass(update) {
  const status = String(update?.status || "").toLowerCase();
  if (status === "error") return "error";
  if (status === "up-to-date") return "ok";
  if (status === "update-available" || status === "downloading" || status === "downloaded") return "warn";
  if (status === "installing") return "warn";
  return "";
}

function applyAppUpdateState(nextState) {
  if (!nextState || typeof nextState !== "object") return;
  State.appUpdate = { ...State.appUpdate, ...nextState };
  renderAppUpdateSummary();
}

function renderAppUpdateSummary() {
  const update = State.appUpdate || {};
  const statusClass = getUpdateStatusClass(update);
  const currentVersion = String(update.appVersion || "—");
  const latestVersion = String(update.latestVersion || currentVersion || "—");
  const modeLabel = String(update.modeLabel || "Unavailable");
  const statusTextMap = {
    idle: "Idle",
    checking: "Checking",
    "up-to-date": "Up to date",
    "update-available": "Update available",
    downloading: "Downloading",
    downloaded: "Ready to install",
    installing: "Installing",
    disabled: "Disabled",
    error: "Error",
  };
  const statusText = statusTextMap[String(update.status || "").toLowerCase()] || "—";
  const detailText = String(update.message || "").trim()
    || "Use \"Check for Updates\" to verify the latest release.";

  setUpdateField("updCurrentVersion", currentVersion);
  setUpdateField("updMode", modeLabel);
  setUpdateField("updLatestVersion", latestVersion, update.updateAvailable ? "warn" : "ok");
  setUpdateField("updStatusText", statusText, statusClass);

  const detailEl = $("updStatusDetail");
  if (detailEl) detailEl.textContent = detailText;
  const aboutVersion = $("aboutAppVersion");
  if (aboutVersion) aboutVersion.textContent = currentVersion;
  const aboutStatus = $("aboutUpdateStatus");
  if (aboutStatus) aboutStatus.textContent = detailText;

  const checkBtn = $("btnCheckAppUpdate");
  const downloadBtn = $("btnDownloadAppUpdate");
  const installBtn = $("btnInstallAppUpdate");
  const isInstaller = String(update.mode || "").toLowerCase() === "installer";
  const isPortable = String(update.mode || "").toLowerCase() === "portable";

  if (checkBtn) checkBtn.disabled = !!update.checking;
  if (downloadBtn) {
    const canShow = isInstaller ? !!update.canDownload : isPortable && !!update.updateAvailable;
    downloadBtn.hidden = !canShow;
    downloadBtn.disabled = !!update.checking;
    downloadBtn.textContent = isPortable ? "Open Download" : "Download Update";
  }
  if (installBtn) {
    installBtn.hidden = !(isInstaller && !!update.canInstall);
    installBtn.disabled = !!update.checking;
  }
}

async function initAppUpdateBridge() {
  if (!window.electronAPI) return;
  try {
    if (window.electronAPI.onUpdateStatus) {
      window.electronAPI.onUpdateStatus((payload) => {
        applyAppUpdateState(payload || {});
      });
    }
    if (window.electronAPI.getUpdateState) {
      const state = await window.electronAPI.getUpdateState();
      applyAppUpdateState(state || {});
    } else {
      renderAppUpdateSummary();
    }
  } catch (err) {
    applyAppUpdateState({
      status: "error",
      message: `Updater bridge error: ${err.message}`,
      error: String(err.message || "Updater bridge error"),
    });
  }
}

async function checkForUpdatesNow() {
  if (!window.electronAPI?.checkForUpdates) {
    showMsg("updateMsg", "Updater is unavailable in this runtime.", "error");
    return;
  }
  showMsg("updateMsg", "Checking for updates...", "");
  try {
    const res = await window.electronAPI.checkForUpdates();
    applyAppUpdateState(res?.state || {});
    const msg = String(res?.state?.message || "Update check completed.");
    showMsg("updateMsg", res?.ok ? `✔ ${msg}` : `✗ ${msg}`, res?.ok ? "" : "error");
  } catch (err) {
    showMsg("updateMsg", `✗ Update check failed: ${err.message}`, "error");
  }
}

async function downloadUpdateNow() {
  if (!window.electronAPI?.downloadUpdate) {
    showMsg("updateMsg", "Updater is unavailable in this runtime.", "error");
    return;
  }
  const mode = String(State.appUpdate?.mode || "").toLowerCase();
  showMsg(
    "updateMsg",
    mode === "portable" ? "Opening latest download page..." : "Downloading update...",
    "",
  );
  try {
    const res = await window.electronAPI.downloadUpdate();
    applyAppUpdateState(res?.state || {});
    if (!res?.ok) {
      showMsg("updateMsg", `✗ ${res?.error || "Update download failed."}`, "error");
      return;
    }
    const okMsg = mode === "portable"
      ? "✔ Download page opened."
      : `✔ ${res?.state?.message || "Update download started."}`;
    showMsg("updateMsg", okMsg, "");
  } catch (err) {
    showMsg("updateMsg", `✗ Update download failed: ${err.message}`, "error");
  }
}

async function installUpdateNow() {
  if (!window.electronAPI?.installUpdate) {
    showMsg("updateMsg", "Updater is unavailable in this runtime.", "error");
    return;
  }
  showMsg("updateMsg", "Restarting app to install update...", "");
  try {
    const res = await window.electronAPI.installUpdate();
    applyAppUpdateState(res?.state || {});
    if (!res?.ok) {
      showMsg("updateMsg", `✗ ${res?.error || "Install failed."}`, "error");
    }
  } catch (err) {
    showMsg("updateMsg", `✗ Install failed: ${err.message}`, "error");
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

function cssNumberVar(name, fallback = 0) {
  const raw = parseFloat(cssVar(name, ""));
  return Number.isFinite(raw) ? raw : fallback;
}

function getChartTypography() {
  return {
    tickX: cssNumberVar("--chart-font-tick-x", 8),
    tickY: cssNumberVar("--chart-font-tick-y", 9),
    axis: cssNumberVar("--chart-font-axis", 10),
    legend: cssNumberVar("--chart-font-legend", 11),
    tooltip: cssNumberVar("--chart-font-tooltip", 11),
    legendBoxWidth: cssNumberVar("--chart-legend-box-w", 24),
    legendBoxHeight: cssNumberVar("--chart-legend-box-h", 8),
    legendPadding: cssNumberVar("--chart-legend-padding", 10),
  };
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
    bandBorder: cssVar("--chart-band-border", "rgba(245,158,11,.36)"),
    bandFill: cssVar("--chart-band-fill", "rgba(245,158,11,.16)"),
    tooltipBg: cssVar("--forecast-preview-tooltip-bg", "rgba(24,28,36,.96)"),
    tooltipBorder: cssVar("--forecast-preview-tooltip-border", "rgba(36,52,79,.84)"),
    tooltipText: cssVar("--forecast-preview-tooltip-text", "#dce8fa"),
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
    if (opts.plugins?.tooltip) {
      opts.plugins.tooltip.backgroundColor = pal.tooltipBg;
      opts.plugins.tooltip.borderColor = pal.tooltipBorder;
      opts.plugins.tooltip.titleColor = pal.tooltipText;
      opts.plugins.tooltip.bodyColor = pal.tooltipText;
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
    if (key === "solcastPreview" && Array.isArray(chart.data?.datasets)) {
      if (chart.data.datasets[0]) {
        chart.data.datasets[0].borderColor = "rgba(0,0,0,0)";
        chart.data.datasets[0].backgroundColor = "rgba(0,0,0,0)";
      }
      if (chart.data.datasets[1]) {
        chart.data.datasets[1].borderColor = pal.bandBorder;
        chart.data.datasets[1].backgroundColor = pal.bandFill;
      }
      if (chart.data.datasets[2]) {
        chart.data.datasets[2].borderColor = pal.actual;
        chart.data.datasets[2].backgroundColor = pal.actualFill;
        chart.data.datasets[2].pointBackgroundColor = pal.actual;
      }
      if (chart.data.datasets[3]) {
        chart.data.datasets[3].borderColor = pal.ahead;
        chart.data.datasets[3].backgroundColor = pal.aheadFill;
        chart.data.datasets[3].pointBackgroundColor = pal.ahead;
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
  "expAlarmDate",
  "expEnergyDate",
  "expForecastDate",
  "expInvDataDate",
  "expAuditDate",
  "expReportStart",
  "expReportEnd",
];
const EXPORT_NUM_FIELD_RULES = {
  genDayCount: { min: 1, max: 31, fallback: 1 },
  expAlarmMinDurationSec: { min: 0, max: 86400, fallback: 0 },
  expInvDataInterval: { min: 1, max: 60, fallback: 1 },
};
const EXPORT_NUM_FIELD_IDS = Object.keys(EXPORT_NUM_FIELD_RULES);
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

function localDateTimeMs(dateText, hour = 0, minute = 0, second = 0, ms = 0) {
  const d = sanitizeDateInputValue(dateText);
  if (!d) return NaN;
  return new Date(
    `${d}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${String(ms)
      .padStart(3, "0")
      .slice(0, 3)}`,
  ).getTime();
}

function getAnalyticsSolarWindowBounds(dateText = "") {
  const day = sanitizeDateInputValue(dateText) || today();
  return {
    startTs: localDateTimeMs(day, ANALYTICS_VIEW_START_HOUR, 0, 0, 0),
    endTs: localDateTimeMs(
      day,
      ANALYTICS_VIEW_END_HOUR,
      ANALYTICS_VIEW_END_MIN,
      0,
      0,
    ),
  };
}

function clampExportNumberValue(id, value) {
  const rule = EXPORT_NUM_FIELD_RULES[id];
  if (!rule) return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return Number(rule.fallback || rule.min || 1);
  return Math.min(
    Number(rule.max || raw),
    Math.max(Number(rule.min || raw), Math.trunc(raw)),
  );
}

function sanitizeExportUiStateClient(input) {
  const out = {};
  const src = input && typeof input === "object" ? input : {};
  EXPORT_DATE_FIELD_IDS.forEach((id) => {
    const v = sanitizeDateInputValue(src[id]);
    if (v) out[id] = v;
  });
  const migratedSingleDateFields = {
    expAlarmDate: ["expAlarmDate", "expAlarmStart", "expAlarmEnd"],
    expEnergyDate: ["expEnergyDate", "expEnergyEnd", "expEnergyStart"],
    expForecastDate: ["expForecastDate"],
    expInvDataDate: ["expInvDataDate", "expInvDataStart", "expInvDataEnd"],
    expAuditDate: ["expAuditDate", "expAuditStart", "expAuditEnd"],
  };
  Object.entries(migratedSingleDateFields).forEach(([targetId, sourceIds]) => {
    const value = sourceIds
      .map((id) => sanitizeDateInputValue(src[id]))
      .find(Boolean);
    if (value) out[targetId] = value;
  });
  EXPORT_NUM_FIELD_IDS.forEach((id) => {
    out[id] = clampExportNumberValue(id, src[id]);
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
    out[id] = clampExportNumberValue(id, input.value);
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

function normalizeExportNumberInput(id) {
  const input = $(id);
  if (!input) return 0;
  const value = clampExportNumberValue(id, input.value);
  if (value > 0) input.value = String(value);
  return value;
}

function bindExportNumberValidators() {
  EXPORT_NUM_FIELD_IDS.forEach((id) => {
    const input = $(id);
    if (!input || input.dataset.exportNumberBound === "1") return;
    input.dataset.exportNumberBound = "1";
    const sync = () => {
      normalizeExportNumberInput(id);
      queuePersistExportUiState();
    };
    input.addEventListener("change", sync);
    input.addEventListener("blur", sync);
  });
}

const EXPORT_DATE_RANGE_IDS = [
  ["expReportStart", "expReportEnd"],
];
const EXPORT_SINGLE_DATE_IDS = [
  "expAlarmDate",
  "expEnergyDate",
  "expForecastDate",
  "expInvDataDate",
  "expAuditDate",
];

function clampExportDateToToday(value) {
  const v = sanitizeDateInputValue(value);
  if (!v) return "";
  const maxDate = today();
  return v > maxDate ? maxDate : v;
}

function normalizeExportDatePair(startId, endId, options = {}) {
  const { forceDefault = false, preferred = "start" } = options;
  const startInput = $(startId);
  const endInput = $(endId);
  if (!startInput || !endInput) return { start: "", end: "" };

  const maxDate = today();
  let startValue = clampExportDateToToday(startInput.value);
  let endValue = clampExportDateToToday(endInput.value);

  if (forceDefault && !startValue && !endValue) {
    startValue = maxDate;
    endValue = maxDate;
  } else if (!startValue && endValue) {
    startValue = endValue;
  } else if (startValue && !endValue) {
    endValue = startValue;
  }

  if (startValue && endValue) {
    if (preferred === "end" && endValue < startValue) startValue = endValue;
    else if (preferred === "start" && startValue > endValue) endValue = startValue;
  }

  startInput.max = endValue && endValue < maxDate ? endValue : maxDate;
  endInput.min = startValue || "";
  endInput.max = maxDate;

  startInput.value = startValue;
  endInput.value = endValue;
  return { start: startValue, end: endValue };
}

function normalizeExportSingleDateInput(inputId, options = {}) {
  const { forceDefault = false } = options;
  const input = $(inputId);
  if (!input) return "";
  const maxDate = today();
  let value = clampExportDateToToday(input.value);
  if (forceDefault && !value) value = maxDate;
  input.max = maxDate;
  input.value = value;
  return value;
}

function normalizeAllExportDateInputs(options = {}) {
  EXPORT_DATE_RANGE_IDS.forEach(([startId, endId]) => {
    normalizeExportDatePair(startId, endId, options);
  });
  EXPORT_SINGLE_DATE_IDS.forEach((inputId) => {
    normalizeExportSingleDateInput(inputId, options);
  });
}

function bindExportDateValidators() {
  EXPORT_DATE_RANGE_IDS.forEach(([startId, endId]) => {
    const startInput = $(startId);
    const endInput = $(endId);
    if (startInput && startInput.dataset.exportDateBound !== "1") {
      startInput.dataset.exportDateBound = "1";
      const syncFromStart = () => {
        normalizeExportDatePair(startId, endId, {
          forceDefault: true,
          preferred: "start",
        });
        queuePersistExportUiState();
      };
      startInput.addEventListener("change", syncFromStart);
      startInput.addEventListener("input", syncFromStart);
    }
    if (endInput && endInput.dataset.exportDateBound !== "1") {
      endInput.dataset.exportDateBound = "1";
      const syncFromEnd = () => {
        normalizeExportDatePair(startId, endId, {
          forceDefault: true,
          preferred: "end",
        });
        queuePersistExportUiState();
      };
      endInput.addEventListener("change", syncFromEnd);
      endInput.addEventListener("input", syncFromEnd);
    }
  });

  EXPORT_SINGLE_DATE_IDS.forEach((inputId) => {
    const input = $(inputId);
    if (!input || input.dataset.exportDateBound === "1") return;
    input.dataset.exportDateBound = "1";
    const syncSingle = () => {
      normalizeExportSingleDateInput(inputId, { forceDefault: true });
      queuePersistExportUiState();
    };
    input.addEventListener("change", syncSingle);
    input.addEventListener("input", syncSingle);
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
  const rate = Math.max(0, Number(bps || 0));
  if (rate < 1024) return `${Math.round(rate)} B/s`;
  if (rate < 1048576) return `${(rate / 1024).toFixed(1)} KB/s`;
  return `${(rate / 1048576).toFixed(2)} MB/s`;
}

function fmtEtaSec(totalSec) {
  const sec = Math.max(0, Math.ceil(Number(totalSec || 0)));
  if (!(sec > 0)) return "0s";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function resetXferRateState(slot, now = Date.now()) {
  slot.rateBps = 0;
  slot.peakBps = 0;
  slot.lastSampleBytes = Math.max(0, Number(slot.doneBytes || 0));
  slot.lastSampleTs = now;
}

function updateXferRateState(slot, nextDoneBytes, now = Date.now()) {
  const nextDone = Math.max(0, Number(nextDoneBytes || 0));
  const lastTs = Math.max(0, Number(slot.lastSampleTs || 0));
  const lastBytes = Math.max(0, Number(slot.lastSampleBytes || 0));
  if (lastTs > 0 && now > lastTs && nextDone >= lastBytes) {
    const elapsedSec = (now - lastTs) / 1000;
    const instantBps = elapsedSec > 0 ? (nextDone - lastBytes) / elapsedSec : 0;
    if (instantBps > 0) {
      slot.rateBps =
        Number(slot.rateBps || 0) > 0
          ? Number(slot.rateBps || 0) * 0.55 + instantBps * 0.45
          : instantBps;
      slot.peakBps = Math.max(Number(slot.peakBps || 0), instantBps);
    }
  }
  slot.lastSampleBytes = nextDone;
  slot.lastSampleTs = now;
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
  const slots = State.xfer?.slots || {};
  const dir = String(msg?.dir || "").trim().toLowerCase() === "tx" ? "tx" : "rx";
  const slot = slots[dir];
  if (!slot) return;

  const phase = String(msg?.phase || "").trim().toLowerCase();
  const msgLabel = String(msg?.label || "").trim();
  const now = Date.now();
  const totalBytes = Math.max(0, Number(msg?.totalBytes || 0));
  const chunkCount = Math.max(0, Number(msg?.chunkCount || 0));
  const chunkOrd = Math.max(0, Number(msg?.chunk || msg?.batch || 0));
  const totalRows = Math.max(0, Number(msg?.totalRows || 0));
  const importedRows = Math.max(0, Number(msg?.importedRows || 0));
  const rawDoneBytes = Math.max(
    0,
    Number((dir === "tx" ? msg?.sentBytes : msg?.recvBytes) || 0),
  );

  if (slot.hideTimer) {
    clearTimeout(slot.hideTimer);
    slot.hideTimer = null;
  }

  if (phase === "start") {
    slot.active = true;
    slot.phase = "start";
    slot.label = msgLabel;
    slot.totalBytes = totalBytes;
    slot.doneBytes = rawDoneBytes;
    slot.chunkCount = chunkCount;
    slot.chunkDone = chunkOrd;
    slot.totalRows = totalRows;
    slot.importedRows = 0;
    slot.priorityMode = Boolean(msg?.priorityMode);
    slot.livePaused = Boolean(msg?.livePaused);
    slot.stage = String(msg?.stage || "").trim().toLowerCase();
    slot.note = String(msg?.note || "").trim();
    slot.updatedAt = now;
    resetXferRateState(slot, now);
    renderXferPanel();
    return;
  }

  if (phase === "chunk") {
    slot.active = true;
    slot.phase = "chunk";
    if (msgLabel) slot.label = msgLabel;
    if (totalBytes > 0) slot.totalBytes = totalBytes;
    if (chunkCount > 0) slot.chunkCount = chunkCount;
    if (chunkOrd > 0) slot.chunkDone = chunkOrd;
    if (totalRows > 0) slot.totalRows = totalRows;
    if (importedRows > 0) slot.importedRows = importedRows;
    slot.priorityMode = Boolean(msg?.priorityMode || slot.priorityMode);
    slot.livePaused = Boolean(msg?.livePaused || slot.livePaused);
    if (msg?.stage) slot.stage = String(msg.stage || "").trim().toLowerCase();
    if (msg?.note) slot.note = String(msg.note || "").trim();

    let prevDone = Math.max(0, Number(slot.doneBytes || 0));
    let nextDone = rawDoneBytes;
    // Some senders may miss a start frame; allow chunk#1 to restart the counter.
    if (nextDone < prevDone && chunkOrd <= 1) {
      prevDone = 0;
      slot.doneBytes = 0;
    }
    if (nextDone < prevDone) nextDone = prevDone;
    slot.doneBytes = nextDone;
    updateXferRateState(slot, nextDone, now);

    const delta = nextDone - prevDone;
    if (delta > 0) {
      if (dir === "tx") netIOTrackTx(delta);
      else netIOTrackRx(delta);
    }
    slot.updatedAt = now;
    renderXferPanel();
    return;
  }

  if (phase === "done" || phase === "error" || phase === "cancelled") {
    slot.active = true;
    slot.phase = phase;
    if (msgLabel) slot.label = msgLabel;
    if (totalBytes > 0) slot.totalBytes = totalBytes;
    if (chunkCount > 0) slot.chunkCount = chunkCount;
    if (chunkOrd > 0) slot.chunkDone = chunkOrd;
    if (totalRows > 0) slot.totalRows = totalRows;
    if (importedRows > 0) slot.importedRows = importedRows;
    if (rawDoneBytes > 0) slot.doneBytes = Math.max(slot.doneBytes, rawDoneBytes);
    slot.priorityMode = Boolean(msg?.priorityMode || slot.priorityMode);
    slot.livePaused = Boolean(msg?.livePaused || slot.livePaused);
    if (msg?.stage) slot.stage = String(msg.stage || "").trim().toLowerCase();
    if (msg?.note) slot.note = String(msg.note || "").trim();
    updateXferRateState(slot, slot.doneBytes, now);
    if (phase === "done" && slot.totalBytes <= 0 && slot.doneBytes > 0) {
      slot.totalBytes = slot.doneBytes;
    }
    slot.updatedAt = now;
    slot.hideTimer = setTimeout(() => {
      slot.active = false;
      slot.phase = "idle";
      slot.label = "";
      slot.priorityMode = false;
      slot.livePaused = false;
      slot.stage = "";
      slot.note = "";
      slot.rateBps = 0;
      slot.peakBps = 0;
      slot.lastSampleBytes = 0;
      slot.lastSampleTs = 0;
      slot.updatedAt = Date.now();
      slot.hideTimer = null;
      renderXferPanel();
    }, phase === "done" ? 3500 : phase === "cancelled" ? 2200 : 3000);
    renderXferPanel();
    return;
  }

  slot.updatedAt = now;
  renderXferPanel();
}

function getVisibleXferSlot() {
  const slots = State.xfer?.slots || {};
  const tx = slots.tx || null;
  const rx = slots.rx || null;
  const active = [tx, rx].filter((s) => s && s.active);
  if (active.length <= 0) return null;
  active.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return active[0];
}

function getXferPhaseBadge(x) {
  const lbl = String(x?.label || "").trim().toLowerCase();
  const phase = String(x?.phase || "");
  if (phase === "done") return { text: "Done", cls: "xfer-phase-done" };
  if (phase === "cancelled") return { text: "Cancelled", cls: "xfer-phase-cancelled" };
  if (phase === "error") return { text: "Failed", cls: "xfer-phase-error" };
  if (x?.priorityMode || x?.livePaused) return { text: "Priority", cls: "xfer-phase-priority" };
  if (lbl.includes("applying") || lbl.includes("gateway data")) return { text: "Applying", cls: "xfer-phase-applying" };
  if (lbl.includes("main database") && lbl.includes("final")) return { text: "Finalizing", cls: "xfer-phase-applying" };
  if (lbl.includes("final") || lbl.includes("final gateway")) return { text: "Finalizing", cls: "xfer-phase-applying" };
  if (lbl.includes("archive")) return { text: "Archive", cls: "xfer-phase-archive" };
  if (x?.dir === "tx") return { text: "Uploading", cls: "xfer-phase-push" };
  return { text: "Downloading", cls: "xfer-phase-pull" };
}

function getXferScopeInfo(x) {
  if (x?.priorityMode || x?.livePaused) {
    if (String(x?.stage || "").trim().toLowerCase() === "archive") {
      return { text: "Priority archive", cls: "priority" };
    }
    return { text: "Priority pull", cls: "priority" };
  }
  const label = String(x?.label || "")
    .trim()
    .toLowerCase();
  if (label.includes("main database") || label.includes("gateway database")) {
    return { text: "Standby DB", cls: "hot" };
  }
  if (label.includes("archive")) {
    return { text: "Archive DB", cls: "archive" };
  }
  if (label.includes("receiving push")) {
    return { text: "Incoming data", cls: "hot" };
  }
  if (x?.dir === "tx") {
    return { text: "Upload", cls: "hot" };
  }
  return { text: "Standby DB", cls: "hot" };
}

function getXferDetailText(x) {
  const parts = [];
  if (x.livePaused) {
    parts.push("live stream paused");
  }
  if (x.chunkCount > 1) {
    parts.push(`step ${Math.max(0, Number(x.chunkDone || 0))}/${Math.max(0, Number(x.chunkCount || 0))}`);
  } else if (x.chunkDone > 0) {
    parts.push(`step ${Math.max(0, Number(x.chunkDone || 0))}`);
  }
  if (Number(x.rateBps || 0) > 0 && x.phase !== "done" && x.phase !== "error") {
    parts.push(fmtBps(x.rateBps));
  }
  const remainingBytes =
    Math.max(0, Number(x.totalBytes || 0)) - Math.max(0, Number(x.doneBytes || 0));
  if (
    remainingBytes > 0 &&
    Number(x.rateBps || 0) > 0 &&
    x.phase !== "done" &&
    x.phase !== "error"
  ) {
    parts.push(`ETA ${fmtEtaSec(remainingBytes / Math.max(1, Number(x.rateBps || 0)))}`);
  }
  if (Number(x.totalRows || 0) > 0) {
    const imported = Math.max(0, Number(x.importedRows || 0));
    const totalRows = Math.max(0, Number(x.totalRows || 0));
    if (imported > 0) parts.push(`${imported.toLocaleString()} row${imported === 1 ? "" : "s"} applied`);
    else parts.push(`${totalRows.toLocaleString()} row${totalRows === 1 ? "" : "s"} scheduled`);
  } else if (x.note && !x.livePaused) {
    parts.push(String(x.note || "").trim());
  } else if (x.phase === "done") {
    parts.push("transfer finished");
  } else if (x.phase === "error") {
    parts.push("transfer failed");
  } else if (x.phase === "cancelled") {
    parts.push("transfer cancelled");
  } else {
    parts.push("background transfer running");
  }
  return parts.join(" · ");
}

function renderXferPanel() {
  const panel = document.getElementById("xferPanel");
  if (!panel) return;
  const x = getVisibleXferSlot();

  if (!x) {
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
  const scopeChipEl = document.getElementById("xferScopeChip");
  const detailEl = document.getElementById("xferDetail");
  const phaseBadgeEl = document.getElementById("xferPhaseBadge");

  if (dirIcon) dirIcon.textContent = x.dir === "tx" ? "↑" : "↓";
  if (dirIcon) dirIcon.className = `xfer-dir-icon xfer-dir-${x.dir || "rx"}`;
  panel.className = `xfer-panel xfer-panel-${x.phase || "idle"}`.trim();

  const done = Math.max(0, Number(x.doneBytes || 0));
  const total = Math.max(0, Number(x.totalBytes || 0));
  const known = total > 0;
  const pct = known
    ? Math.min(100, Math.round((done / total) * 100))
    : (x.phase === "done" ? 100 : 0);

  if (fillEl) {
    if (known || x.phase === "done") {
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
    } else if (x.phase === "done") {
      labelEl.textContent = x.dir === "tx" ? "Upload complete" : "Download complete";
    } else if (x.phase === "error") {
      labelEl.textContent = x.dir === "tx" ? "Upload failed" : "Download failed";
    } else if (x.phase === "cancelled") {
      labelEl.textContent = x.dir === "tx" ? "Upload cancelled" : "Download cancelled";
    } else if (x.dir === "tx") {
      const cStr = x.chunkCount > 1 ? ` · chunk ${x.chunkDone}/${x.chunkCount}` : "";
      labelEl.textContent = `Uploading${cStr}`;
    } else {
      const bStr = x.chunkDone > 0 ? ` · batch ${x.chunkDone}` : "";
      labelEl.textContent = `Downloading${bStr}`;
    }
  }

  const scopeInfo = getXferScopeInfo(x);
  if (scopeChipEl) {
    scopeChipEl.textContent = scopeInfo.text;
    scopeChipEl.className = `xfer-scope-chip xfer-scope-${scopeInfo.cls || "hot"}`;
  }
  if (detailEl) detailEl.textContent = getXferDetailText(x);

  if (phaseBadgeEl) {
    const badge = getXferPhaseBadge(x);
    phaseBadgeEl.textContent = badge.text;
    phaseBadgeEl.className = `xfer-phase-badge ${badge.cls}`;
    phaseBadgeEl.hidden = false;
  }

  if (pctEl) pctEl.textContent = known || x.phase === "done" ? `${pct}%` : "…";
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

function showTableLoading(tbodyId, colspan) {
  const tbody = $(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = `<tr class="table-loading"><td colspan="${colspan}" style="text-align:center;padding:14px;color:var(--muted,#888)">Loading\u2026</td></tr>`;
}

function debounce(fn, waitMs = TABLE_FILTER_DEBOUNCE_MS) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), Math.max(0, Number(waitMs) || 0));
  };
}

function paginateRows(rows, page, pageSize) {
  const list = Array.isArray(rows) ? rows : [];
  const size = Math.max(1, Math.trunc(Number(pageSize) || 1));
  const totalRows = list.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / size));
  const safePage = Math.min(
    totalPages,
    Math.max(1, Math.trunc(Number(page) || 1)),
  );
  const startIdx = (safePage - 1) * size;
  const endIdx = Math.min(totalRows, startIdx + size);
  return {
    rows: list.slice(startIdx, endIdx),
    page: safePage,
    pageSize: size,
    totalRows,
    totalPages,
    from: totalRows ? startIdx + 1 : 0,
    to: endIdx,
  };
}

function ensureTablePagerHost(hostId, tbodyId) {
  if (!hostId || !tbodyId) return null;
  let host = $(hostId);
  if (host) return host;
  const tbody = $(tbodyId);
  if (!tbody) return null;
  const table = tbody.closest("table");
  const wrap = table ? table.closest(".table-wrap") : null;
  if (!wrap || !wrap.parentElement) return null;
  host = el("div", "table-pagination");
  host.id = hostId;
  wrap.insertAdjacentElement("afterend", host);
  return host;
}

function renderTablePager({
  hostId,
  tbodyId,
  page,
  pageSize,
  totalRows,
  onPageChange,
}) {
  const host = ensureTablePagerHost(hostId, tbodyId);
  if (!host) return;
  const safeSize = Math.max(1, Math.trunc(Number(pageSize) || 1));
  const safeTotal = Math.max(0, Math.trunc(Number(totalRows) || 0));
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeSize));
  const safePage = Math.min(
    totalPages,
    Math.max(1, Math.trunc(Number(page) || 1)),
  );
  const from = safeTotal ? (safePage - 1) * safeSize + 1 : 0;
  const to = safeTotal ? Math.min(safeTotal, safePage * safeSize) : 0;

  host.innerHTML = `
    <div class="pager-meta">Showing ${from}-${to} of ${safeTotal}</div>
    <div class="pager-actions">
      <button class="btn btn-outline pager-btn" data-action="prev" ${safePage <= 1 ? "disabled" : ""}>Prev</button>
      <span class="pager-page">Page ${safePage}/${totalPages}</span>
      <button class="btn btn-outline pager-btn" data-action="next" ${safePage >= totalPages ? "disabled" : ""}>Next</button>
    </div>
  `;

  host.querySelector("[data-action=\"prev\"]")?.addEventListener("click", () => {
    if (safePage <= 1 || typeof onPageChange !== "function") return;
    onPageChange(safePage - 1);
  });
  host.querySelector("[data-action=\"next\"]")?.addEventListener("click", () => {
    if (safePage >= totalPages || typeof onPageChange !== "function") return;
    onPageChange(safePage + 1);
  });
}

const applyAuditTableViewDebounced = debounce(() => applyAuditTableView());
const applyReportTableViewDebounced = debounce(() => applyReportTableView());

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

function clearAlarmSoundRecheckTimer() {
  if (State.alarmSoundRecheckTimer) {
    clearTimeout(State.alarmSoundRecheckTimer);
    State.alarmSoundRecheckTimer = null;
  }
}

function getOrCreateAlarmAudioCtx() {
  if (State.alarmAudioCtx) return State.alarmAudioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    State.alarmAudioCtx = new Ctx();
    State.chatAudioReady = State.alarmAudioCtx.state === "running";
    return State.alarmAudioCtx;
  } catch (err) {
    console.warn("[app] AudioContext creation failed:", err.message);
    return null;
  }
}

function _scheduleAlarmBeep(ctx) {
  try {
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
    console.warn("[app] alarm beep schedule failed:", err.message);
  }
}

function playAlarmBeepOnce() {
  try {
    const ctx = getOrCreateAlarmAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      // Defer oscillator scheduling until AudioContext is actually running.
      // Scheduling against a frozen currentTime while suspended produces no sound.
      ctx.resume().then(() => _scheduleAlarmBeep(ctx)).catch(() => {});
    } else {
      _scheduleAlarmBeep(ctx);
    }
  } catch (err) {
    console.warn("[app] alarm beep failed:", err.message);
  }
}

function setAlarmSoundActive(active) {
  if (!active || State.alarmSoundMuted) {
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

function hasUnackedActiveAlarms() {
  return Object.values(State.activeAlarms || {}).some(
    (a) => a && a.acknowledged !== true,
  );
}

function getAlarmSoundEligibility(now = Date.now()) {
  let eligible = false;
  let nextDelayMs = 0;
  for (const row of Object.values(State.activeAlarms || {})) {
    if (!row || row.acknowledged === true) continue;
    const startedAt = Math.max(0, Number(row.ts || 0));
    const ageMs = startedAt > 0 ? Math.max(0, now - startedAt) : ALARM_SOUND_MIN_ACTIVE_MS;
    if (ageMs >= ALARM_SOUND_MIN_ACTIVE_MS) {
      eligible = true;
      continue;
    }
    const remaining = Math.max(0, ALARM_SOUND_MIN_ACTIVE_MS - ageMs);
    nextDelayMs =
      nextDelayMs > 0 ? Math.min(nextDelayMs, remaining) : remaining;
  }
  return { eligible, nextDelayMs };
}

function syncAlarmSoundPlayback() {
  clearAlarmSoundRecheckTimer();
  const { eligible, nextDelayMs } = getAlarmSoundEligibility(Date.now());
  setAlarmSoundActive(eligible);
  if (!eligible && !State.alarmSoundMuted && nextDelayMs > 0) {
    State.alarmSoundRecheckTimer = setTimeout(() => {
      State.alarmSoundRecheckTimer = null;
      syncAlarmSoundPlayback();
    }, Math.max(50, nextDelayMs + 25));
  }
}

function getLiveAlarmSignature() {
  const parts = [];
  for (const [key, row] of Object.entries(State.liveData || {})) {
    const alarmValue = Number(row?.alarm || 0);
    if (!alarmValue) continue;
    parts.push(`${key}:${alarmValue}`);
  }
  parts.sort();
  return parts.join("|");
}

async function syncAlarmStateFromLiveData() {
  State.pendingAlarmLiveSig = getLiveAlarmSignature();
  if (State.alarmLiveSyncing) return;

  State.alarmLiveSyncing = true;
  try {
    while (State.pendingAlarmLiveSig !== State.alarmLiveSig) {
      const targetSig = State.pendingAlarmLiveSig;
      const ok = await refreshAlarmBadge();
      if (!ok) break;
      State.alarmLiveSig = targetSig;
    }
  } finally {
    State.alarmLiveSyncing = false;
  }
}

function renderAlarmSoundBtn() {
  const btn = $("btnAlarmSound");
  const icon = $("alarmSoundIcon");
  if (!btn || !icon) return;
  if (State.alarmSoundMuted) {
    icon.className = "mdi mdi-volume-off";
    btn.classList.add("muted");
    btn.title = "Unmute alarm sound";
    btn.setAttribute("aria-label", "Unmute alarm sound");
  } else {
    icon.className = "mdi mdi-volume-high";
    btn.classList.remove("muted");
    btn.title = "Mute alarm sound";
    btn.setAttribute("aria-label", "Mute alarm sound");
  }
}

function toggleAlarmSound() {
  State.alarmSoundMuted = !State.alarmSoundMuted;
  try { localStorage.setItem("alarmSoundMuted", State.alarmSoundMuted ? "1" : "0"); } catch (_) {}
  // Apply immediately based on current alarm state (no need to wait for next poll tick).
  syncAlarmSoundPlayback();
  renderAlarmSoundBtn();
}
function resetPacTodayIfNeeded(ts = Date.now()) {
  const d = dateStr(new Date(ts));
  if (State.pacToday.day === d) return;
  State.pacToday.day = d;
  State.pacToday.lastTs = 0;
  State.pacToday.lastTotalPacW = 0;
  State.pacToday.totalKwh = 0;
  resetTodayMwhAuthority();
}

function summarizeLiveRows(rowsRaw = []) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  const out = { pac: 0, pdc: 0, kwh: 0 };
  rows.forEach((d) => {
    out.pac += Number(d?.pac || 0);
    out.pdc += Number(d?.pdc || 0);
    out.kwh += Number(d?.kwh || 0);
  });
  return out;
}

function buildFreshLiveTotalsByInverter(now = Date.now()) {
  const out = {};
  Object.values(State.liveData || {}).forEach((d) => {
    const inv = Number(d?.inverter || 0);
    const isFresh = d?.online && now - getLiveFreshTsClient(d) <= DATA_FRESH_MS;
    if (!inv || !isFresh) return;
    if (!out[inv]) out[inv] = { pac: 0, pdc: 0, kwh: 0 };
    out[inv].pac += Number(d?.pac || 0);
    out[inv].pdc += Number(d?.pdc || 0);
    out[inv].kwh += Number(d?.kwh || 0);
  });
  return out;
}

function getCurrentFreshTotalPacW(now = Date.now()) {
  return Object.values(buildFreshLiveTotalsByInverter(now)).reduce(
    (sum, totals) => sum + Number(totals?.pac || 0),
    0,
  );
}

function getLiveFreshTsClient(row) {
  return Math.max(0, Number(row?.bridgeTs || row?.ts || 0));
}

function setTodayEnergyRowsClient(rowsRaw) {
  const next = {};
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  rows.forEach((row) => {
    const inv = Math.floor(Number(row?.inverter || 0));
    const totalKwh = Number(row?.total_kwh || 0);
    if (!(inv > 0) || !Number.isFinite(totalKwh) || totalKwh < 0) return;
    next[inv] = totalKwh;
  });
  State.todayEnergyByInv = next;
}

function resetTodayMwhAuthority() {
  State.todayMwh.wsAuthoritative = false;
  State.todayMwh.wsLastFrameAt = 0;
  State.todayMwh.wsLastEnergyAt = 0;
  State.todayMwh.wsLastAdvanceAt = 0;
  State.todayMwh.wsLastTotalKwh = null;
}

function noteTodayMwhWsFrame(now = Date.now()) {
  State.todayMwh.wsLastFrameAt = Math.max(0, Number(now) || Date.now());
}

function noteTodayMwhWsEnergy(totalKwh, now = Date.now()) {
  const nextNow = Math.max(0, Number(now) || Date.now());
  const nextTotal = Math.max(0, Number(totalKwh) || 0);
  const prevTotal = Number(State.todayMwh.wsLastTotalKwh);
  State.todayMwh.wsLastEnergyAt = nextNow;
  if (
    !Number.isFinite(prevTotal) ||
    Math.abs(nextTotal - prevTotal) > 0.0001
  ) {
    State.todayMwh.wsLastAdvanceAt = nextNow;
  }
  State.todayMwh.wsLastTotalKwh = nextTotal;
}

function shouldExpectTodayMwhAdvance(now = Date.now()) {
  if (getActiveOperationModeClient() !== "gateway") return false;
  return getCurrentFreshTotalPacW(now) >= TODAY_MWH_WS_ADVANCE_MIN_PAC_W;
}

function isTodayMwhWsStale(now = Date.now()) {
  if (!State.todayMwh.wsAuthoritative) return false;
  if (getActiveOperationModeClient() !== "gateway") return false;
  const lastFrameAt = Number(State.todayMwh.wsLastFrameAt || 0);
  if (!lastFrameAt || now - lastFrameAt > TODAY_MWH_WS_FRAME_STALE_MS) {
    return true;
  }
  const lastEnergyAt = Number(State.todayMwh.wsLastEnergyAt || 0);
  if (!lastEnergyAt || now - lastEnergyAt > TODAY_MWH_WS_ENERGY_STALE_MS) {
    return true;
  }
  if (!shouldExpectTodayMwhAdvance(now)) return false;
  const lastAdvanceAt = Math.max(
    Number(State.todayMwh.wsLastAdvanceAt || 0),
    lastEnergyAt,
  );
  return Boolean(
    lastAdvanceAt &&
      now - lastAdvanceAt > TODAY_MWH_WS_NO_ADVANCE_MS,
  );
}

function hasTodayMwhWsAuthority() {
  if (
    !State.todayMwh.wsAuthoritative ||
    !State.ws ||
    Number(State.ws.readyState) !== 1
  ) {
    return false;
  }
  if (isTodayMwhWsStale()) {
    State.todayMwh.wsAuthoritative = false;
    return false;
  }
  return true;
}

function canApplyTodayMwhSync(source = "sync", { allowRemoteFallback = false } = {}) {
  const src = String(source || "sync").trim().toLowerCase();
  if (src === "ws") return true;
  if (hasTodayMwhWsAuthority()) return false;
  if (getActiveOperationModeClient() !== "remote") return true;
  return Boolean(allowRemoteFallback);
}

function applySyncedTodayKwh(totalKwh, syncedAt = Date.now(), opts = {}) {
  const source = String(opts?.source || "sync").trim().toLowerCase();
  const allowRemoteFallback = Boolean(opts?.allowRemoteFallback);
  resetPacTodayIfNeeded(syncedAt);
  if (!canApplyTodayMwhSync(source, { allowRemoteFallback })) return false;
  const serverKwh = Math.max(0, Number(totalKwh) || 0);
  // Keep header strictly server-authoritative so it matches report/analytics totals.
  State.pacToday.totalKwh = serverKwh;
  State.pacToday.lastTs         = syncedAt;
  State.pacToday.lastTotalPacW  = getCurrentFreshTotalPacW(syncedAt);
  if (source === "ws") {
    State.todayMwh.wsAuthoritative = true;
  } else if (getActiveOperationModeClient() === "gateway") {
    State.todayMwh.wsAuthoritative = false;
  }
  const meter = $("totalKwh");
  if (meter) {
    meter.title = `Synced: ${fmtDateTime(syncedAt)}`;
  }
  return true;
}

function integrateTodayFromPac() {
  const now = Date.now();
  resetPacTodayIfNeeded(now);
  // No client-side kWh integration here; server sync is authoritative.
  const currentPacW = getCurrentFreshTotalPacW(now);
  State.pacToday.lastTs         = now;
  State.pacToday.lastTotalPacW  = currentPacW;
  renderTodayKwhFromPac();
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
    setTodayEnergyRowsClient(rows);
    const totalKwh = (rows || []).reduce(
      (sum, r) => sum + Number(r?.total_kwh || 0),
      0,
    );
    const applied = applySyncedTodayKwh(totalKwh, Date.now(), {
      source: "seed",
      allowRemoteFallback: true,
    });
    if (applied) renderTodayKwhFromPac();
  } catch (e) {
    console.warn("seedTodayEnergyFromDb:", e?.message || e);
  }
}

async function syncTodayMwhFromServer(opts = {}) {
  if (!Boolean(opts?.force) && hasTodayMwhWsAuthority()) {
    return false;
  }
  try {
    const rows = await fetchTodayEnergyTotalsRaw();
    setTodayEnergyRowsClient(rows);
    const totalKwh = (rows || []).reduce(
      (sum, r) => sum + Number(r?.total_kwh || 0),
      0,
    );
    const applied = applySyncedTodayKwh(totalKwh, Date.now(), {
      source: "http",
      allowRemoteFallback: Boolean(opts?.allowRemoteFallback),
    });
    if (applied) renderTodayKwhFromPac();
    return applied;
  } catch (e) {
    // Non-fatal: next sync tick will refresh the metric.
    console.warn("syncTodayMwhFromServer:", e?.message || e);
    return false;
  }
}

function extractCurrentDaySummary(summaryRaw) {
  const candidate =
    summaryRaw && typeof summaryRaw === "object"
      ? summaryRaw.current_day || summaryRaw.todaySummary || summaryRaw.daily || null
      : null;
  if (!candidate || typeof candidate !== "object") return null;

  const day = sanitizeDateInputValue(candidate.day) || today();
  const totalKwhRaw = Number(candidate.total_kwh);
  const totalMwhRaw = Number(candidate.total_mwh);
  const totalKwh = Number.isFinite(totalKwhRaw)
    ? Number(totalKwhRaw.toFixed(6))
    : Number.isFinite(totalMwhRaw)
      ? Number((totalMwhRaw * 1000).toFixed(6))
      : NaN;
  const totalMwh = Number.isFinite(totalMwhRaw)
    ? Number(totalMwhRaw.toFixed(6))
    : Number.isFinite(totalKwh)
      ? Number((totalKwh / 1000).toFixed(6))
      : NaN;
  if (!Number.isFinite(totalKwh) && !Number.isFinite(totalMwh)) return null;

  return {
    day,
    asOfTs: Number(candidate.as_of_ts || candidate.asOfTs || 0),
    totalKwh: Number.isFinite(totalKwh) ? totalKwh : Number((totalMwh * 1000).toFixed(6)),
    totalMwh: Number.isFinite(totalMwh) ? totalMwh : Number((totalKwh / 1000).toFixed(6)),
    inverterCount: Math.max(0, Math.trunc(Number(candidate.inverter_count || 0))),
  };
}

function applyCurrentDaySummaryClient(summaryRaw, opts = {}) {
  const summary = extractCurrentDaySummary(summaryRaw);
  if (!summary) return false;

  State.currentDaySummary = {
    day: summary.day,
    asOfTs: summary.asOfTs,
    totalKwh: summary.totalKwh,
    totalMwh: summary.totalMwh,
    inverterCount: summary.inverterCount,
  };

  let analyticsChanged = false;
  if (summary.day === today()) {
    State.analyticsActualSummarySyncAt = Date.now();
    State.analyticsActualSummarySyncDay = summary.day;
    if (isTodayAnalyticsDate()) {
      const nextMwh = Number(summary.totalMwh.toFixed(6));
      if (State.analyticsDailyTotalMwh !== nextMwh) {
        State.analyticsDailyTotalMwh = nextMwh;
        analyticsChanged = true;
      }
    }
  }

  const reportDay = sanitizeDateInputValue($("reportDate")?.value) || today();
  if (
    summary.day === reportDay &&
    State.reportView.summary &&
    typeof State.reportView.summary === "object"
  ) {
    if (!State.reportView.summary.daily || typeof State.reportView.summary.daily !== "object") {
      State.reportView.summary.daily = {};
    }
    State.reportView.summary.daily.total_kwh = summary.totalKwh;
    State.reportView.summary.daily.total_mwh = summary.totalMwh;
    State.reportView.summary.daily.inverter_count = summary.inverterCount;
    if (summary.asOfTs > 0) {
      State.reportView.summary.daily.as_of_ts = summary.asOfTs;
    }
    State.reportView.summary.current_day = {
      day: summary.day,
      as_of_ts: summary.asOfTs,
      total_kwh: summary.totalKwh,
      total_mwh: summary.totalMwh,
      inverter_count: summary.inverterCount,
    };
    if (State.currentPage === "report") {
      renderReportKpis();
    }
  }

  if (
    analyticsChanged &&
    State.currentPage === "analytics" &&
    isTodayAnalyticsDate() &&
    !State.analyticsRealtimeTimer
  ) {
    renderAnalyticsFromState();
  }

  return analyticsChanged;
}

async function syncAnalyticsActualMwhFromServer(opts = {}) {
  if (getActiveOperationModeClient() !== "gateway") return false;
  if (State.currentPage !== "analytics") return false;
  const day = sanitizeDateInputValue($("anaDate")?.value) || today();
  if (day !== today()) return false;
  if (State.analyticsFetchInFlight && !Boolean(opts?.force)) return false;
  const now = Date.now();
  if (
    !Boolean(opts?.force) &&
    State.analyticsActualSummarySyncDay === day &&
    now - Number(State.analyticsActualSummarySyncAt || 0) <
      ACTUAL_MWH_HTTP_SYNC_INTERVAL_MS
  ) {
    return false;
  }
  try {
    const summary = await api(`/api/report/summary?date=${encodeURIComponent(day)}`);
    State.analyticsActualSummarySyncAt = now;
    State.analyticsActualSummarySyncDay = day;
    const previous = Number(State.analyticsDailyTotalMwh);
    const applied = applyCurrentDaySummaryClient(summary, {
      source: opts?.force ? "http-force" : "http",
    });
    if (applied && Number(State.analyticsDailyTotalMwh) !== previous) {
      renderAnalyticsFromState();
      return true;
    }
    return false;
  } catch (e) {
    console.warn("syncAnalyticsActualMwhFromServer:", e?.message || e);
    return false;
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
  // In remote mode, TODAY MWh is driven by WS todayEnergy updates to avoid
  // racing the bridge feed with parallel HTTP/report refreshes.
  if (getActiveOperationModeClient() === "remote") return;
  syncTodayMwhFromServer().catch(() => {});
  syncAnalyticsActualMwhFromServer().catch(() => {});
  State.todayMwhSyncTimer = setInterval(() => {
    syncTodayMwhFromServer().catch(() => {});
    syncAnalyticsActualMwhFromServer().catch(() => {});
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

function shouldPreserveServerErrorMessage(url = "") {
  const u = String(url || "");
  return (
    u.includes("/api/write") ||
    u.includes("/api/runtime/network") ||
    u.includes("/api/settings") ||
    u.includes("/api/replication/") ||
    u.includes("/api/export/") ||
    u.includes("/api/forecast/solcast/") ||
    u.includes("/api/export/solcast-preview")
  );
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
  const abortMessage = String(options?.abortMessage || "").trim();
  if (body) opts.body = JSON.stringify(body);
  if (options?.signal) opts.signal = options.signal;
  if (opts.body) netIOTrackTx(opts.body.length);
  let ok = false;
  let progressDoneLabel = "Request failed";
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
      if (shouldPreserveServerErrorMessage(url) && rawMsg) {
        detailedMsg = String(rawMsg);
      }
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
        const e2 = new Error(detailedMsg);
        e2.status = r.status;
        e2.body = parsed;
        throw e2;
      }
      if (url.includes("/api/chat/")) {
        detailedMsg = String(rawMsg || detailedMsg);
      }
      throw new Error(String(detailedMsg));
    }
    // Detect local-fallback when gateway is offline in remote mode
    if (
      r.headers.get("X-Data-Source") === "local-fallback" &&
      !State._localFallbackNotified
    ) {
      State._localFallbackNotified = true;
      showToast("Showing locally cached data \u2014 gateway is offline", "warn");
    }
    ok = true;
    progressDoneLabel = "Done";
    return parsed ?? {};
  } catch (err) {
    // Network error or parsing failure
    if (err?.name === "AbortError") {
      progressDoneLabel = "Cancelled";
      throw new Error(abortMessage || "Request cancelled.");
    }
    if (err instanceof TypeError) {
      console.warn("[app] Network error:", err.message);
      throw new Error("Network error. Please check your internet connection.");
    }
    throw err;
  } finally {
    if (showProgress) endProgress(progressDoneLabel);
  }
}

async function apiWithTimeout(
  url,
  timeoutMs,
  abortMessage,
  method = "GET",
  body,
  options = {},
) {
  const controller = new AbortController();
  const timeout = Math.max(1, Number(timeoutMs || 0));
  const timer = setTimeout(() => controller.abort(), timeout);
  const parentSignal = options?.signal || null;
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else {
      parentSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }
  try {
    return await api(url, method, body, {
      ...options,
      signal: controller.signal,
      abortMessage,
    });
  } finally {
    clearTimeout(timer);
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function rejectModeTransitionLiveWaiters(reason = "Mode transition cancelled.") {
  const waiters = Array.isArray(State.modeTransition?.liveWaiters)
    ? State.modeTransition.liveWaiters.splice(0)
    : [];
  waiters.forEach((entry) => {
    if (!entry) return;
    try { clearTimeout(entry.timer); } catch (_) {}
    try { entry.reject(new Error(reason)); } catch (_) {}
  });
}

function resolveModeTransitionLiveWaiters(payload = null) {
  const waiters = Array.isArray(State.modeTransition?.liveWaiters)
    ? State.modeTransition.liveWaiters.splice(0)
    : [];
  waiters.forEach((entry) => {
    if (!entry) return;
    try { clearTimeout(entry.timer); } catch (_) {}
    try { entry.resolve(payload); } catch (_) {}
  });
}

function isGatewayModeRestartCapable() {
  return Boolean(window.electronAPI?.restartApp);
}

function buildModeTransitionDetail(targetMode, detail = "") {
  const custom = String(detail || "").trim();
  if (custom) return custom;
  return targetMode === "remote"
    ? "Waiting for the first live snapshot from the gateway before re-enabling the dashboard."
    : "Waiting for the local poller to complete its first cycle before re-enabling the dashboard.";
}

function syncModeTransitionUi() {
  const active = Boolean(State.modeTransition?.active);
  const targetMode = normalizeOperationModeValue(State.modeTransition?.targetMode);
  const overlay = $("modeTransitionOverlay");
  const titleEl = $("modeTransitionTitle");
  const bodyEl = $("modeTransitionBody");
  const saveBtn = $("btnSaveSettings");
  const modeSelect = $("setOperationMode");
  const testBtn = $("btnTestRemoteGateway");
  const tailscaleBtn = $("btnCheckTailscale");
  const standbyBtn = $("btnRunReplicationPull");
  const refreshBtn = $("btnRefreshReplicationHealth");

  if (overlay) {
    overlay.classList.toggle("hidden", !active);
    overlay.setAttribute("aria-hidden", active ? "false" : "true");
  }
  if (titleEl) {
    titleEl.textContent = targetMode === "remote"
      ? "Switching to Remote Mode"
      : "Switching to Gateway Mode";
  }
  if (bodyEl) {
    bodyEl.textContent = buildModeTransitionDetail(
      targetMode,
      State.modeTransition?.detail || "",
    );
  }
  document.body.classList.toggle("mode-transition-active", active);
  [saveBtn, modeSelect, testBtn, tailscaleBtn, standbyBtn, refreshBtn].forEach((ctrl) => {
    if (!ctrl) return;
    ctrl.disabled = active;
  });
}

function setModeTransitionState(active, targetMode = "", detail = "") {
  if (!active) {
    rejectModeTransitionLiveWaiters();
  }
  State.modeTransition.active = Boolean(active);
  State.modeTransition.targetMode = active
    ? normalizeOperationModeValue(targetMode || State.settings.operationMode)
    : "";
  State.modeTransition.startedAt = active ? Date.now() : 0;
  State.modeTransition.detail = active
    ? buildModeTransitionDetail(targetMode, detail)
    : "";
  syncModeTransitionUi();
}

function updateModeTransitionDetail(detail = "") {
  if (!State.modeTransition?.active) return;
  State.modeTransition.detail = buildModeTransitionDetail(
    State.modeTransition.targetMode,
    detail,
  );
  syncModeTransitionUi();
}

function waitForModeTransitionLiveFrame(timeoutMs = 12000) {
  if (
    !State.modeTransition?.active ||
    normalizeOperationModeValue(State.modeTransition.targetMode) !== "remote"
  ) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = State.modeTransition.liveWaiters.indexOf(entry);
      if (idx >= 0) State.modeTransition.liveWaiters.splice(idx, 1);
      reject(new Error("Timed out waiting for a live gateway snapshot."));
    }, Math.max(1000, Number(timeoutMs || 0)));
    const entry = { resolve, reject, timer };
    State.modeTransition.liveWaiters.push(entry);
  });
}

async function waitForRemoteModeReady(readyStartedAt = Date.now(), timeoutMs = 12000) {
  const startedAt = Math.max(0, Number(readyStartedAt || 0));
  const liveFramePromise = waitForModeTransitionLiveFrame(timeoutMs).catch(() => null);
  await refreshRemoteBridgeNow(true).catch(() => null);
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 0));
  let lastReason = "";

  while (Date.now() < deadline) {
    const snap = await api("/api/runtime/network", "GET", null, { progress: false });
    const health = normalizeRemoteHealthClient(snap?.remoteHealth || null);
    lastReason = String(health.reasonText || snap?.remoteLastError || "").trim();
    if (health.state === "auth-error" || health.state === "config-error") {
      throw new Error(lastReason || "Remote gateway configuration is not ready.");
    }
    if (
      Number(snap?.remoteLastSuccessTs || 0) >= startedAt &&
      (health.state === "connected" || health.state === "degraded" || health.state === "stale")
    ) {
      await liveFramePromise;
      return snap;
    }
    await waitMs(450);
  }

  throw new Error(lastReason || "Timed out waiting for gateway live data.");
}

async function waitForGatewayModeReady(readyStartedAt = Date.now(), timeoutMs = 12000) {
  const startedAt = Math.max(0, Number(readyStartedAt || 0));
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 0));

  while (Date.now() < deadline) {
    const perf = await api("/api/runtime/perf", "GET", null, { progress: false });
    const poll = perf?.poller && typeof perf.poller === "object" ? perf.poller : {};
    if (
      Boolean(poll?.running) &&
      Number(poll?.lastPollStartedTs || 0) >= startedAt
    ) {
      return perf;
    }
    await waitMs(400);
  }

  throw new Error("Timed out waiting for local polling to restart.");
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

  showToast(`Export folder: ${p}`, "success", 5000);
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

function getSelectedOperationModeClient() {
  return normalizeOperationModeValue(
    $("setOperationMode")?.value || State.settings?.operationMode,
  );
}

function getActiveOperationModeClient() {
  return normalizeOperationModeValue(State.settings?.operationMode);
}

function isClientModeActive() {
  return getActiveOperationModeClient() === "remote";
}

function normalizeRemoteHealthClient(raw = null) {
  const src = raw && typeof raw === "object" ? raw : {};
  const activeMode = getActiveOperationModeClient();
  const fallbackState = activeMode === "remote" ? "disconnected" : "gateway-local";
  const liveFreshMsRaw = src?.liveFreshMs;
  return {
    mode: normalizeOperationModeValue(src?.mode || activeMode),
    state: String(src?.state || fallbackState).trim().toLowerCase() || fallbackState,
    reasonCode: String(src?.reasonCode || "").trim(),
    reasonText: String(src?.reasonText || "").trim(),
    hasUsableSnapshot: Boolean(src?.hasUsableSnapshot),
    snapshotRetainMs: Math.max(0, Number(src?.snapshotRetainMs || 0)),
    liveFreshMs:
      liveFreshMsRaw == null || liveFreshMsRaw === ""
        ? null
        : Math.max(0, Number(liveFreshMsRaw || 0)),
    lastAttemptTs: Math.max(0, Number(src?.lastAttemptTs || 0)),
    lastSuccessTs: Math.max(0, Number(src?.lastSuccessTs || 0)),
    lastFailureTs: Math.max(0, Number(src?.lastFailureTs || 0)),
    failureStreak: Math.max(0, Number(src?.failureStreak || 0)),
    backoffMs: Math.max(0, Number(src?.backoffMs || 0)),
    lastLatencyMs: Math.max(0, Number(src?.lastLatencyMs || 0)),
    liveNodeCount: Math.max(0, Number(src?.liveNodeCount || 0)),
    pausedForPriorityTransfer: Boolean(src?.pausedForPriorityTransfer),
    pauseReason: String(src?.pauseReason || "").trim(),
    pauseSince: Math.max(0, Number(src?.pauseSince || 0)),
  };
}

function applyRemoteHealthClient(raw = null) {
  State.remoteHealth = normalizeRemoteHealthClient(raw);
  // Reset local-fallback toast when gateway reconnects
  if (State.remoteHealth.state === "connected") {
    State._localFallbackNotified = false;
  }
  return State.remoteHealth;
}

function getRemoteHealthDisplay(healthRaw = null, modeRaw = "") {
  const mode = normalizeOperationModeValue(modeRaw || getActiveOperationModeClient());
  const health = normalizeRemoteHealthClient(healthRaw || State.remoteHealth);
  if (mode !== "remote") {
    return { text: "Gateway local polling", cls: "" };
  }
  switch (String(health.state || "").trim().toLowerCase()) {
    case "paused":
      return { text: "Paused for standby refresh", cls: "warn" };
    case "connecting":
      return { text: "Connecting", cls: "warn" };
    case "connected":
      return { text: "Connected", cls: "ok" };
    case "degraded":
      return { text: "Degraded", cls: "warn" };
    case "stale":
      return { text: "Stale snapshot", cls: "warn" };
    case "auth-error":
      return {
        text: health.hasUsableSnapshot ? "Auth error (stale data)" : "Auth error",
        cls: "error",
      };
    case "config-error":
      return {
        text: health.hasUsableSnapshot ? "Config error (stale data)" : "Config error",
        cls: "error",
      };
    default:
      return {
        text: health.hasUsableSnapshot ? "Disconnected (stale data)" : "Disconnected",
        cls: health.hasUsableSnapshot ? "warn" : "error",
      };
  }
}

function isRemoteSnapshotRetainedClient(healthRaw = null) {
  const health = normalizeRemoteHealthClient(healthRaw || State.remoteHealth);
  return getActiveOperationModeClient() === "remote" && Boolean(health.hasUsableSnapshot);
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
      ? "Day-ahead generation is available only in Gateway mode."
      : "";
  }
  if (btn) {
    btn.disabled = isClient;
    btn.setAttribute("aria-disabled", isClient ? "true" : "false");
    btn.title = isClient
      ? "Unavailable in Remote mode. Use the gateway workstation to generate the day-ahead forecast."
      : "";
  }
  if (res) {
    if (isClient) {
      res.className = "exp-result";
      res.textContent =
        "Day-ahead generation is unavailable in Remote mode. Run it from the gateway workstation.";
    } else if (
      res.textContent &&
      /unavailable in Remote mode/i.test(String(res.textContent))
    ) {
      res.textContent = "";
    }
  }
}

function notifyClientModeUnavailable(featureLabel) {
  const safeFeature = String(featureLabel || "This feature");
  showToast(
    `${safeFeature} is available only in Gateway mode. Change Operation Mode in Settings to continue.`,
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
  if (page === "forecast") initForecastPage();
  if (page === "settings") {
    initSettingsSectionNav();
    unlockSettingsInputs();
    refreshLicenseSection().catch(() => {});
    startReplicationHealthPolling();
    cbLoadSettings().catch(() => {});
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

function normalizeSettingsSectionId(value) {
  const v = String(value || "").trim();
  return SETTINGS_SECTION_IDS.includes(v) ? v : DEFAULT_SETTINGS_SECTION_ID;
}

function renderActiveSettingsMeta(sectionId) {
  const activeId = normalizeSettingsSectionId(sectionId);
  const meta = SETTINGS_SECTION_META[activeId] || SETTINGS_SECTION_META[DEFAULT_SETTINGS_SECTION_ID];
  const mainTitle = $("settingsMainSectionTitle");
  const mainCopy = $("settingsMainSectionCopy");
  const sidebarChip = $("settingsSidebarCurrentChip");
  if (mainTitle) mainTitle.textContent = meta.title;
  if (mainCopy) mainCopy.textContent = meta.copy;
  if (sidebarChip) sidebarChip.textContent = meta.title;
}

function setActiveSettingsSection(sectionId, persist = true) {
  const activeId = normalizeSettingsSectionId(sectionId);
  SETTINGS_SECTION_IDS.forEach((id) => {
    const node = $(id);
    if (!node) return;
    const isActive = id === activeId;
    node.classList.toggle("settings-section-active", isActive);
    node.hidden = !isActive;
  });

  renderActiveSettingsMeta(activeId);

  document
    .querySelectorAll("#settingsSectionMenu .settings-menu-btn")
    .forEach((btn) => {
      const isActive = String(btn.dataset.settingsSection || "") === activeId;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });

  if (persist) {
    const scroller = document.querySelector("#page-settings .settings-main");
    if (scroller && typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  if (persist) {
    try {
      localStorage.setItem("adsi_settings_section", activeId);
    } catch (err) {
      console.warn("[app] settings section persist failed:", err.message);
    }
  }
}

function initSettingsSectionNav() {
  const menu = $("settingsSectionMenu");
  if (!menu) return;

  if (menu && menu.dataset.bound !== "1") {
    menu.dataset.bound = "1";
    menu.addEventListener("click", (e) => {
      const btn = e.target.closest(".settings-menu-btn");
      if (!btn) return;
      setActiveSettingsSection(btn.dataset.settingsSection, true);
    });
  }

  let saved = "";
  try {
    saved = String(localStorage.getItem("adsi_settings_section") || "").trim();
  } catch (_) {}
  setActiveSettingsSection(saved || DEFAULT_SETTINGS_SECTION_ID, false);
}

function mountForecastSection() {
  const host = $("forecastPageSections");
  const section = $("forecastSection");
  if (!host || !section || section.parentElement === host) return;
  host.appendChild(section);
}

function updateForecastSidebarSummary() {
  const chip = $("forecastSidebarCurrentChip");
  if (!chip) return;
  const provider = String(
    $("setForecastProvider")?.value || State.settings.forecastProvider || "ml_local",
  )
    .trim()
    .toLowerCase();
  chip.textContent = provider === "solcast" ? "Active Source: Solcast" : "Active Source: Local ML";
}

function initForecastPage() {
  mountForecastSection();
  unlockSettingsInputs();
  syncForecastProviderUi();
  updateForecastSidebarSummary();
  updateSolcastPreviewUnitUi();
  const useToolkitPreview =
    String($("setSolcastAccessMode")?.value || State.settings.solcastAccessMode || "toolkit")
      .trim()
      .toLowerCase() === "toolkit";
  if (useToolkitPreview) {
    loadSolcastPreview({ silent: true }).catch(() => {});
  }
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const n = new Date();
    $("clock").textContent =
      `${pad2(n.getHours())}:${pad2(n.getMinutes())}:${pad2(n.getSeconds())}`;
    $("dateLbl").textContent =
      `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())} PHT`;
    // Day-rollover: reset tab dates and invalidate caches when the calendar day changes.
    if (State.lastDateInitDay && State.lastDateInitDay !== dateStr(n)) {
      initAllTabDatesToToday();
      State.tabFetchTs = {};
      State.alarmView.rows  = [];
      State.alarmView.queryKey = "";
      State.energyView.rows = [];
      State.energyView.queryKey = "";
      State.energyView.summary = null;
      State.auditView.rows  = [];
      State.auditView.queryKey = "";
      State.reportView.rows = [];
    }
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
      $("plantNameDisplay").textContent = s.plantName || "ADSI Plant";
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
    $("setSolcastBaseUrl").value = s.solcastBaseUrl || "https://api.solcast.com.au";
    $("setSolcastAccessMode").value = s.solcastAccessMode || "toolkit";
    $("setSolcastApiKey").value = s.solcastApiKey || "";
    $("setSolcastResourceId").value = s.solcastResourceId || "";
    $("setSolcastToolkitEmail").value = s.solcastToolkitEmail || "";
    $("setSolcastToolkitPassword").value = s.solcastToolkitPassword || "";
    $("setSolcastToolkitSiteRef").value = s.solcastToolkitSiteRef || "";
    $("setSolcastTimezone").value = s.solcastTimezone || "Asia/Manila";
    if ($("setPlantLatitude"))  $("setPlantLatitude").value  = s.plantLatitude  ?? "";
    if ($("setPlantLongitude")) $("setPlantLongitude").value = s.plantLongitude ?? "";
    if ($("setPlantCapUpperMw")) {
      $("setPlantCapUpperMw").value =
        s.plantCapUpperMw == null ? "" : String(s.plantCapUpperMw);
    }
    if ($("setPlantCapLowerMw")) {
      $("setPlantCapLowerMw").value =
        s.plantCapLowerMw == null ? "" : String(s.plantCapLowerMw);
    }
    if ($("setPlantCapSequenceMode")) {
      $("setPlantCapSequenceMode").value =
        s.plantCapSequenceMode || "ascending";
    }
    if ($("setPlantCapSequenceCustom")) {
      $("setPlantCapSequenceCustom").value = formatPlantCapSequenceInputClient(
        s.plantCapSequenceCustom || [],
      );
    }
    if ($("setPlantCapCooldownSec")) {
      $("setPlantCapCooldownSec").value = String(s.plantCapCooldownSec ?? 30);
    }
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
    const accessSel = $("setSolcastAccessMode");
    if (accessSel && accessSel.dataset.bound !== "1") {
      accessSel.dataset.bound = "1";
      accessSel.addEventListener("change", syncForecastProviderUi);
    }
    applyExportUiStateToInputs(State.settings.exportUiState);
    mountForecastSection();
    unlockSettingsInputs();
    syncOperationModeUi();
    syncModeTransitionUi();
    syncForecastProviderUi();
    updateForecastSidebarSummary();
    syncPlantCapFormsFromSettingsState();
    refreshPlantCapStatus(true).catch(() => {});
    refreshLicenseSection().catch(() => {});
  } catch (e) {
    console.warn("[Settings] load failed:", e.message);
  }
}

function unlockSettingsInputs() {
  ["page-settings", "page-forecast"].forEach((pageId) => {
    const root = $(pageId);
    if (!root) return;
    root.querySelectorAll("input, select, textarea").forEach((ctrl) => {
      ctrl.disabled = false;
      ctrl.readOnly = false;
      ctrl.removeAttribute("disabled");
      ctrl.removeAttribute("readonly");
    });
  });
}

function syncForecastProviderUi() {
  const provider = String($("setForecastProvider")?.value || "ml_local")
    .trim()
    .toLowerCase();
  const accessMode = String(
    $("setSolcastAccessMode")?.value || State.settings.solcastAccessMode || "toolkit",
  )
    .trim()
    .toLowerCase() === "api"
    ? "api"
    : "toolkit";
  const apiMode = accessMode === "api";
  const apiPanel = $("forecastSection")?.querySelector(".forecast-api-panel");
  const toolkitPanel = $("forecastSection")?.querySelector(".forecast-toolkit-panel");
  if (apiPanel) apiPanel.hidden = !apiMode;
  if (toolkitPanel) toolkitPanel.hidden = apiMode;
  ["setSolcastBaseUrl", "setSolcastAccessMode", "setSolcastTimezone"].forEach((id) => {
    const ctrl = $(id);
    if (!ctrl) return;
    ctrl.disabled = false;
  });
  ["setSolcastApiKey", "setSolcastResourceId"].forEach((id) => {
    const ctrl = $(id);
    if (!ctrl) return;
    ctrl.disabled = !apiMode;
  });
  [
    "setSolcastToolkitSiteRef",
    "setSolcastToolkitEmail",
    "setSolcastToolkitPassword",
  ].forEach((id) => {
    const ctrl = $(id);
    if (!ctrl) return;
    ctrl.disabled = apiMode;
  });
  const previewPanel = $("solcastPreviewPanel");
  if (previewPanel) {
    previewPanel.hidden = apiMode;
  }
  const previewDay = $("solcastPreviewDay");
  const previewDayCount = $("solcastPreviewDayCount");
  const previewResolution = $("solcastPreviewResolution");
  const previewUnit = $("solcastPreviewUnit");
  const previewExportFormat = $("solcastPreviewExportFormat");
  const previewBtn = $("btnSolcastPreviewRefresh");
  const previewExportBtn = $("btnSolcastPreviewExport");
  if (previewDay) previewDay.disabled = apiMode;
  if (previewDayCount) previewDayCount.disabled = apiMode;
  if (previewResolution) previewResolution.disabled = apiMode;
  if (previewUnit) previewUnit.disabled = apiMode;
  if (previewExportFormat) previewExportFormat.disabled = apiMode;
  if (previewBtn) previewBtn.disabled = apiMode;
  if (previewExportBtn) previewExportBtn.disabled = apiMode;
  if (apiMode) clearSolcastPreview(false);
  updateForecastSidebarSummary();
}

function getSettingsMessageTargetId() {
  return State.currentPage === "forecast" ? "forecastPageMsg" : "settingsMsg";
}

function readSolcastSettingsForm() {
  return {
    solcastBaseUrl: $("setSolcastBaseUrl")?.value || "https://api.solcast.com.au",
    solcastAccessMode: $("setSolcastAccessMode")?.value || "toolkit",
    solcastApiKey: $("setSolcastApiKey")?.value || "",
    solcastResourceId: $("setSolcastResourceId")?.value || "",
    solcastToolkitEmail: $("setSolcastToolkitEmail")?.value || "",
    solcastToolkitPassword: $("setSolcastToolkitPassword")?.value || "",
    solcastToolkitSiteRef: $("setSolcastToolkitSiteRef")?.value || "",
    solcastTimezone: $("setSolcastTimezone")?.value || "",
  };
}

function destroyChartByKey(key) {
  const chart = State.charts[key];
  if (!chart) return;
  try {
    chart.destroy();
  } catch (_) {}
  delete State.charts[key];
}

function fillSolcastPreviewDayOptions(days, selectedDay) {
  const sel = $("solcastPreviewDay");
  if (!sel) return;
  const safeDays = Array.isArray(days) ? days.filter(Boolean) : [];
  sel.innerHTML = "";
  if (!safeDays.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No preview days";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  safeDays.forEach((day) => {
    const opt = document.createElement("option");
    opt.value = day;
    opt.textContent = day;
    if (day === selectedDay) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.disabled = false;
}

function normalizeSolcastPreviewDayCountClient(value) {
  const n = Math.trunc(Number(value || 1));
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(7, Math.max(1, n));
}

function syncSolcastPreviewDayCountOptions(days, selectedDay, selectedCount) {
  const sel = $("solcastPreviewDayCount");
  if (!sel) return;
  const safeDays = Array.isArray(days) ? days.filter(Boolean) : [];
  const idx = Math.max(0, safeDays.indexOf(String(selectedDay || "").trim()));
  const maxAllowed = safeDays.length
    ? Math.min(7, Math.max(1, safeDays.length - idx))
    : 1;
  Array.from(sel.options).forEach((opt) => {
    const count = normalizeSolcastPreviewDayCountClient(opt.value);
    opt.disabled = count > maxAllowed;
  });
  sel.value = String(Math.min(normalizeSolcastPreviewDayCountClient(selectedCount), maxAllowed));
  sel.disabled = safeDays.length === 0;
}

function setSolcastPreviewTotals(
  forecastText = "—",
  actualText = "—",
  rangeText = "—",
  windowText = "05:00-18:00",
) {
  if ($("solcastPreviewForecastTotal")) {
    $("solcastPreviewForecastTotal").textContent = forecastText;
  }
  if ($("solcastPreviewActualTotal")) {
    $("solcastPreviewActualTotal").textContent = actualText;
  }
  if ($("solcastPreviewRange")) {
    $("solcastPreviewRange").textContent = rangeText;
  }
  if ($("solcastPreviewWindow")) {
    $("solcastPreviewWindow").textContent = windowText;
  }
}

function clearSolcastPreview(resetDays = false) {
  State.solcastPreview.loaded = false;
  State.solcastPreview.payload = null;
  if (resetDays) {
    State.solcastPreview.days = [];
    State.solcastPreview.day = "";
    State.solcastPreview.dayCount = 1;
    State.solcastPreview.selectedDays = [];
    State.solcastPreview.rangeLabel = "";
    State.solcastPreview.resolution = "PT5M";
    State.solcastPreview.unit = "mwh";
    fillSolcastPreviewDayOptions([], "");
    syncSolcastPreviewDayCountOptions([], "", 1);
  }
  const resolutionSel = $("solcastPreviewResolution");
  const unitSel = $("solcastPreviewUnit");
  if (resolutionSel && resetDays) resolutionSel.value = "PT5M";
  if (unitSel && resetDays) unitSel.value = "mwh";
  updateSolcastPreviewUnitUi();
  setSolcastPreviewTotals("—", "—", "—", "05:00-18:00");
  destroyChartByKey("solcastPreview");
}

function getSelectedSolcastPreviewUnit() {
  const raw = String($("solcastPreviewUnit")?.value || State.solcastPreview.unit || "mwh")
    .trim()
    .toLowerCase();
  return raw === "mw" ? "mw" : "mwh";
}

function updateSolcastPreviewUnitUi() {
  const unit = getSelectedSolcastPreviewUnit();
  const title = $("solcastPreviewChartTitle");
  const note = $("solcastPreviewChartNote");
  const emphasis = $("solcastPreviewChartEmphasis");
  if (title) {
    title.textContent = "Solcast PT5M Outlook";
  }
  if (note) {
    note.textContent =
      unit === "mw"
        ? "05:00-18:00 local window · displaying raw toolkit MW"
        : "05:00-18:00 local window · displaying MWh per 5-minute slot";
  }
  if (emphasis) {
    emphasis.textContent = unit === "mw" ? "Chart Unit: MW" : "Chart Unit: MWh";
  }
}

function buildSolcastPreviewChart(payload) {
  const canvas = $("solcastPreviewChart");
  if (!canvas) return;
  const pal = getChartPalette();
  const uiFont = cssVar("--font-main", "Arial");
  const chartType = getChartTypography();
  const labels = Array.isArray(payload?.labels) ? payload.labels : [];
  const unit = getSelectedSolcastPreviewUnit();
  const useMw = unit === "mw";
  const forecast = Array.isArray(useMw ? payload?.forecastMw : payload?.forecastMwh)
    ? (useMw ? payload.forecastMw : payload.forecastMwh)
    : [];
  const forecastLo = Array.isArray(useMw ? payload?.forecastLoMw : payload?.forecastLoMwh)
    ? (useMw ? payload.forecastLoMw : payload.forecastLoMwh)
    : [];
  const forecastHi = Array.isArray(useMw ? payload?.forecastHiMw : payload?.forecastHiMwh)
    ? (useMw ? payload.forecastHiMw : payload.forecastHiMwh)
    : [];
  const actual = Array.isArray(useMw ? payload?.actualMw : payload?.actualMwh)
    ? (useMw ? payload.actualMw : payload.actualMwh)
    : [];
  const forecastMw = Array.isArray(payload?.forecastMw) ? payload.forecastMw : [];
  const forecastLoMw = Array.isArray(payload?.forecastLoMw) ? payload.forecastLoMw : [];
  const forecastHiMw = Array.isArray(payload?.forecastHiMw) ? payload.forecastHiMw : [];
  const actualMw = Array.isArray(payload?.actualMw) ? payload.actualMw : [];
  const maxTickCount =
    labels.length > 900 ? 10 : labels.length > 450 ? 12 : labels.length > 220 ? 14 : 18;
  const unitLabel = useMw ? "MW" : "MWh";
  const opts = chartOpts(unitLabel, true);
  opts.maintainAspectRatio = false;
  opts.normalized = true;
  opts.layout.padding = { top: 0, right: 8, bottom: 0, left: 0 };
  opts.interaction = {
    mode: "index",
    intersect: false,
  };
  opts.plugins.legend.position = "top";
  opts.plugins.legend.align = "start";
  opts.plugins.legend.labels = {
    ...opts.plugins.legend.labels,
    usePointStyle: true,
    pointStyle: "line",
    boxWidth: chartType.legendBoxWidth,
    boxHeight: chartType.legendBoxHeight,
    padding: chartType.legendPadding,
    color: pal.legend,
    font: { family: uiFont, size: chartType.legend, weight: "700" },
  };
  opts.plugins.tooltip = {
    backgroundColor: pal.tooltipBg,
    borderColor: pal.tooltipBorder,
    borderWidth: 1,
    titleColor: pal.tooltipText,
    bodyColor: pal.tooltipText,
    titleFont: { family: uiFont, size: chartType.tooltip, weight: "700" },
    bodyFont: { family: uiFont, size: chartType.tooltip, weight: "600" },
    padding: chartType.legendPadding,
    cornerRadius: 10,
    displayColors: true,
    boxPadding: 4,
    callbacks: {
      title(items) {
        const raw = String(items?.[0]?.label || "").trim();
        return raw.replace(/^(\d{2}-\d{2})\s/, "$1 · ");
      },
      label(ctx) {
        const label = String(ctx.dataset?.label || "")
          .replace(/^_+/, "")
          .trim();
        const value = Number(ctx.parsed?.y);
        if (!Number.isFinite(value)) return `${label}: —`;
        const mwValue = Number(ctx.dataset?.rawMwData?.[ctx.dataIndex]);
        if (useMw) {
          return `${label}: ${value.toFixed(3)} MW`;
        }
        if (Number.isFinite(mwValue)) {
          return `${label}: ${value.toFixed(3)} MWh | ${mwValue.toFixed(3)} MW`;
        }
        return `${label}: ${value.toFixed(3)} MWh`;
      },
    },
  };
  if (opts.scales?.x?.ticks) {
    opts.scales.x.ticks.autoSkip = true;
    opts.scales.x.ticks.maxRotation = 0;
    opts.scales.x.ticks.minRotation = 0;
    opts.scales.x.ticks.maxTicksLimit = maxTickCount;
    opts.scales.x.ticks.padding = 8;
    opts.scales.x.ticks.font = { family: uiFont, size: 10, weight: "600" };
  }
  if (opts.scales?.x?.grid) {
    opts.scales.x.grid.color = pal.grid;
    opts.scales.x.grid.drawTicks = false;
  }
  if (opts.scales?.x) {
    opts.scales.x.border = { display: false };
  }
  if (opts.scales?.y?.ticks) {
    opts.scales.y.ticks.padding = 6;
    opts.scales.y.ticks.font = { family: uiFont, size: 11, weight: "600" };
  }
  if (opts.scales?.y?.grid) {
    opts.scales.y.grid.color = pal.grid;
    opts.scales.y.grid.drawTicks = false;
  }
  if (opts.scales?.y?.title) {
    opts.scales.y.title.font = { family: uiFont, size: 10, weight: "700" };
  }
  if (opts.scales?.y) {
    opts.scales.y.border = { display: false };
  }
  opts.plugins.legend.labels.filter = (item) =>
    !String(item?.text || "").startsWith("_");

  const datasets = [
    {
      label: "_Forecast Band Lower",
      data: forecastLo,
      borderColor: "rgba(0,0,0,0)",
      backgroundColor: "rgba(0,0,0,0)",
      borderWidth: 0,
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0.12,
      fill: false,
      spanGaps: true,
      rawMwData: forecastLoMw,
    },
    {
      label: "_Forecast Band Upper",
      data: forecastHi,
      borderColor: "rgba(0,0,0,0)",
      backgroundColor: pal.bandFill,
      borderWidth: 0,
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0.12,
      fill: "-1",
      spanGaps: true,
      rawMwData: forecastHiMw,
    },
    {
      label: "Estimated Actual",
      data: actual,
      borderColor: pal.actual,
      backgroundColor: pal.actualFill,
      borderWidth: 2.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointBorderWidth: 0,
      pointBackgroundColor: pal.actual,
      tension: 0.2,
      cubicInterpolationMode: "monotone",
      fill: false,
      spanGaps: true,
      rawMwData: actualMw,
    },
    {
      label: "Forecast",
      data: forecast,
      borderColor: pal.ahead,
      backgroundColor: pal.aheadFill,
      borderWidth: 2.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointBorderWidth: 0,
      pointBackgroundColor: pal.ahead,
      tension: 0.2,
      cubicInterpolationMode: "monotone",
      borderDash: [10, 5],
      fill: false,
      spanGaps: true,
      rawMwData: forecastMw,
    },
  ];

  const chart = State.charts.solcastPreview;
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets = datasets;
    chart.options = opts;
    chart.update("none");
    return;
  }

  State.charts.solcastPreview = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: opts,
  });
}

function applySolcastPreviewPayload(payload) {
  const days = Array.isArray(payload?.daysCovered) ? payload.daysCovered : [];
  const day = String(payload?.day || "").trim();
  const dayCount = normalizeSolcastPreviewDayCountClient(payload?.dayCount || 1);
  State.solcastPreview.payload = payload;
  State.solcastPreview.days = days;
  State.solcastPreview.day = day;
  State.solcastPreview.dayCount = dayCount;
  State.solcastPreview.selectedDays = Array.isArray(payload?.selectedDays)
    ? payload.selectedDays.filter(Boolean)
    : [];
  State.solcastPreview.rangeLabel = String(payload?.rangeLabel || "").trim();
  State.solcastPreview.loaded = true;
  syncSharedForecastExportFormatControls(State.solcastPreview.exportFormat || "standard");
  updateSolcastPreviewUnitUi();
  fillSolcastPreviewDayOptions(days, day);
  syncSolcastPreviewDayCountOptions(days, day, dayCount);
  setSolcastPreviewTotals(
    `${Number(payload?.forecastTotalMwh || 0).toFixed(3)} MWh`,
    Number(payload?.actualTotalMwh || 0) > 0
      ? `${Number(payload?.actualTotalMwh || 0).toFixed(3)} MWh`
      : "No estimated actuals",
    String(payload?.rangeLabel || payload?.day || "—").trim() || "—",
    `${payload?.startTime || "05:00"}-${payload?.endTime || "18:00"}`,
  );
  buildSolcastPreviewChart(payload);
}

function rerenderSolcastPreviewChartFromState() {
  if (!State.solcastPreview.loaded || !State.solcastPreview.payload) return;
  State.solcastPreview.unit = getSelectedSolcastPreviewUnit();
  updateSolcastPreviewUnitUi();
  buildSolcastPreviewChart(State.solcastPreview.payload);
}

const rerenderResponsiveChartsDebounced = debounce(() => {
  if (State.currentPage === "analytics" && State.analyticsBaseRows.length > 0) {
    renderAnalyticsFromState();
  }
  if (
    (State.currentPage === "forecast" || State.currentPage === "settings") &&
    State.solcastPreview.loaded &&
    State.solcastPreview.payload
  ) {
    rerenderSolcastPreviewChartFromState();
  }
}, 180);

async function loadSolcastPreview(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const accessMode = String(
    $("setSolcastAccessMode")?.value || State.settings.solcastAccessMode || "toolkit",
  )
    .trim()
    .toLowerCase();
  if (accessMode !== "toolkit") {
    clearSolcastPreview(false);
    return null;
  }
  const btn = $("btnSolcastPreviewRefresh");
  const payload = {
    ...readSolcastSettingsForm(),
    day:
      opts.day !== undefined
        ? opts.day
        : $("solcastPreviewDay")?.value || State.solcastPreview.day || "",
    dayCount:
      opts.dayCount !== undefined
        ? opts.dayCount
        : $("solcastPreviewDayCount")?.value || State.solcastPreview.dayCount || 1,
  };
  if (btn) btn.disabled = true;
  showMsg(
    "solcastPreviewMsg",
    opts.silent ? "Loading preview..." : "Loading Solcast toolkit preview...",
    "",
  );
  try {
    const preview = await api("/api/forecast/solcast/preview", "POST", payload);
    applySolcastPreviewPayload(preview);
    showMsg(
      "solcastPreviewMsg",
      `✔ Preview loaded for ${preview.rangeLabel || preview.day} (${preview.startTime}-${preview.endTime})`,
      "",
    );
    showSnapshotWarningToast("Solcast snapshot", preview?.snapshotWarnings || []);
    return preview;
  } catch (err) {
    clearSolcastPreview(false);
    showMsg("solcastPreviewMsg", `✗ Preview failed: ${err.message}`, "error");
    throw err;
  } finally {
    if (btn) btn.disabled = false;
    syncForecastProviderUi();
  }
}

async function exportSolcastPreviewXlsx() {
  const accessMode = String(
    $("setSolcastAccessMode")?.value || State.settings.solcastAccessMode || "toolkit",
  )
    .trim()
    .toLowerCase();
  if (accessMode !== "toolkit") {
    showMsg("solcastPreviewMsg", "Toolkit preview export is available only in Toolkit Login mode.", "error");
    return;
  }
  const btn = $("btnSolcastPreviewExport");
  if (btn) btn.disabled = true;
  State.solcastPreview.exportFormat = getSelectedSolcastPreviewExportFormat();
  showMsg("solcastPreviewMsg", "Exporting Solcast preview to Excel...", "");
  try {
    const payload = {
      ...readSolcastSettingsForm(),
      day: $("solcastPreviewDay")?.value || State.solcastPreview.day || "",
      dayCount:
        $("solcastPreviewDayCount")?.value || State.solcastPreview.dayCount || 1,
      resolution: getSelectedSolcastPreviewResolution(),
      exportFormat: getSelectedSolcastPreviewExportFormat(),
    };
    const result = await api("/api/export/solcast-preview", "POST", payload);
    showMsg("solcastPreviewMsg", `✔ Saved: ${result.path}`, "");
    await openExportPathFolder(result.path);
    return result;
  } catch (err) {
    showMsg("solcastPreviewMsg", `✗ Export failed: ${err.message}`, "error");
    throw err;
  } finally {
    if (btn) btn.disabled = false;
    syncForecastProviderUi();
  }
}

function syncOperationModeUi() {
  const selectedMode = getSelectedOperationModeClient();
  const activeMode = getActiveOperationModeClient();
  const remote = activeMode === "remote";
  const restartCapable = isGatewayModeRestartCapable();
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
    selectedMode !== activeMode
      ? selectedMode === "gateway" && activeMode === "remote"
        ? `Selected mode is Gateway, but the active runtime mode is still Remote. Save Settings to apply the mode change.${restartCapable ? " The app will restart for a clean Gateway startup." : " Restart the app after saving for a clean Gateway startup."}`
        : `Selected mode is ${selectedMode === "remote" ? "Remote" : "Gateway"}, but the active runtime mode is still ${activeMode === "remote" ? "Remote" : "Gateway"}. Save Settings to apply the mode change.`
      : remote
        ? "Remote mode active. Live data is streamed from the gateway. Use Refresh Standby DB when you need a fresh local database copy before switching to Gateway mode."
        : "Gateway mode active. Local polling is active; remote/Tailscale fields are optional.",
    "",
  );
  syncDayAheadGeneratorAvailability();
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function pickSettingsConfigFields(src) {
  const out = {};
  if (!src || typeof src !== "object" || Array.isArray(src)) return out;

  if (hasOwn(src, "plantName")) out.plantName = String(src.plantName ?? "");
  if (hasOwn(src, "operatorName"))
    out.operatorName = String(src.operatorName ?? "");
  if (hasOwn(src, "inverterCount"))
    out.inverterCount = Number(src.inverterCount);
  if (hasOwn(src, "nodeCount")) out.nodeCount = Number(src.nodeCount);
  if (hasOwn(src, "operationMode"))
    out.operationMode = String(src.operationMode ?? "");
  if (hasOwn(src, "remoteAutoSync"))
    out.remoteAutoSync = Boolean(src.remoteAutoSync);
  if (hasOwn(src, "remoteGatewayUrl"))
    out.remoteGatewayUrl = String(src.remoteGatewayUrl ?? "");
  if (hasOwn(src, "remoteApiToken"))
    out.remoteApiToken = String(src.remoteApiToken ?? "");
  if (hasOwn(src, "tailscaleDeviceHint"))
    out.tailscaleDeviceHint = String(src.tailscaleDeviceHint ?? "");
  if (hasOwn(src, "apiUrl")) out.apiUrl = String(src.apiUrl ?? "");
  if (hasOwn(src, "writeUrl")) out.writeUrl = String(src.writeUrl ?? "");
  if (hasOwn(src, "csvSavePath"))
    out.csvSavePath = String(src.csvSavePath ?? "");
  if (hasOwn(src, "retainDays")) out.retainDays = Number(src.retainDays);
  if (hasOwn(src, "forecastProvider"))
    out.forecastProvider = String(src.forecastProvider ?? "");
  if (hasOwn(src, "solcastBaseUrl"))
    out.solcastBaseUrl = String(src.solcastBaseUrl ?? "");
  if (hasOwn(src, "solcastAccessMode"))
    out.solcastAccessMode = String(src.solcastAccessMode ?? "");
  if (hasOwn(src, "solcastApiKey"))
    out.solcastApiKey = String(src.solcastApiKey ?? "");
  if (hasOwn(src, "solcastResourceId"))
    out.solcastResourceId = String(src.solcastResourceId ?? "");
  if (hasOwn(src, "solcastToolkitEmail"))
    out.solcastToolkitEmail = String(src.solcastToolkitEmail ?? "");
  if (hasOwn(src, "solcastToolkitPassword"))
    out.solcastToolkitPassword = String(src.solcastToolkitPassword ?? "");
  if (hasOwn(src, "solcastToolkitSiteRef"))
    out.solcastToolkitSiteRef = String(src.solcastToolkitSiteRef ?? "");
  if (hasOwn(src, "solcastTimezone"))
    out.solcastTimezone = String(src.solcastTimezone ?? "");
  if (hasOwn(src, "invGridLayout"))
    out.invGridLayout = String(src.invGridLayout ?? "");
  if (hasOwn(src, "plantCapUpperMw"))
    out.plantCapUpperMw =
      src.plantCapUpperMw == null ? "" : String(src.plantCapUpperMw ?? "");
  if (hasOwn(src, "plantCapLowerMw"))
    out.plantCapLowerMw =
      src.plantCapLowerMw == null ? "" : String(src.plantCapLowerMw ?? "");
  if (hasOwn(src, "plantCapSequenceMode"))
    out.plantCapSequenceMode = String(src.plantCapSequenceMode ?? "");
  if (hasOwn(src, "plantCapSequenceCustom")) {
    out.plantCapSequenceCustom = Array.isArray(src.plantCapSequenceCustom)
      ? src.plantCapSequenceCustom.map((item) => Number(item))
      : [];
  }
  if (hasOwn(src, "plantCapCooldownSec"))
    out.plantCapCooldownSec = Number(src.plantCapCooldownSec);
  if (
    hasOwn(src, "inverterPollConfig") &&
    src.inverterPollConfig &&
    typeof src.inverterPollConfig === "object"
  ) {
    const poll = {};
    if (hasOwn(src.inverterPollConfig, "modbusTimeout")) {
      poll.modbusTimeout = Number(src.inverterPollConfig.modbusTimeout);
    }
    if (hasOwn(src.inverterPollConfig, "reconnectDelay")) {
      poll.reconnectDelay = Number(src.inverterPollConfig.reconnectDelay);
    }
    if (hasOwn(src.inverterPollConfig, "readSpacing")) {
      poll.readSpacing = Number(src.inverterPollConfig.readSpacing);
    }
    if (Object.keys(poll).length) out.inverterPollConfig = poll;
  }

  return out;
}

function pickCloudBackupSettingsFields(src) {
  if (!src || typeof src !== "object" || Array.isArray(src)) return null;
  const out = {};
  const allowedScope = new Set(["database", "config", "logs"]);

  if (hasOwn(src, "enabled")) out.enabled = Boolean(src.enabled);
  if (hasOwn(src, "email")) out.email = String(src.email ?? "");
  if (hasOwn(src, "provider")) out.provider = String(src.provider ?? "");
  if (hasOwn(src, "schedule")) out.schedule = String(src.schedule ?? "");
  if (hasOwn(src, "scope")) {
    out.scope = Array.isArray(src.scope)
      ? Array.from(
          new Set(
            src.scope
              .map((item) => String(item || "").trim().toLowerCase())
              .filter((item) => allowedScope.has(item)),
          ),
        )
      : [];
  }
  if (hasOwn(src, "onedrive")) {
    out.onedrive = {
      clientId: String(src.onedrive?.clientId ?? ""),
    };
  }
  if (hasOwn(src, "gdrive")) {
    const nextGDrive = {
      clientId: String(src.gdrive?.clientId ?? ""),
    };
    const nextSecret = String(src.gdrive?.clientSecret ?? "").trim();
    if (nextSecret) nextGDrive.clientSecret = nextSecret;
    out.gdrive = nextGDrive;
  }

  return Object.keys(out).length ? out : null;
}

function getSettingsConfigFilename() {
  const now = new Date();
  return `inverter-dashboard-settings-${dateStr(now)}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.json`;
}

function getAppVersionLabel() {
  return String(document.querySelector(".side-about-ver")?.textContent || "")
    .replace(/^v/i, "")
    .trim();
}

function downloadTextFileFallback(content, filename) {
  const blob = new Blob([String(content ?? "")], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}

async function saveTextFileLocally(content, defaultPath, title) {
  if (window.electronAPI?.saveTextFile) {
    return window.electronAPI.saveTextFile({
      title,
      defaultPath,
      filters: SETTINGS_CONFIG_FILE_FILTERS,
      content,
    });
  }
  return downloadTextFileFallback(content, defaultPath);
}

function openTextFileFallback() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve({
          path: file.name,
          content: String(reader.result || ""),
        });
      reader.onerror = () =>
        reject(new Error("Unable to read the selected config file."));
      reader.readAsText(file);
    });
    input.click();
  });
}

async function openTextFileLocally(title) {
  if (window.electronAPI?.openTextFile) {
    return window.electronAPI.openTextFile({
      title,
      filters: SETTINGS_CONFIG_FILE_FILTERS,
    });
  }
  return openTextFileFallback();
}

function parseSettingsConfigPayload(rawContent) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawContent || ""));
  } catch {
    throw new Error("Invalid JSON file.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid settings config format.");
  }
  if (
    hasOwn(parsed, "kind") &&
    String(parsed.kind || "").trim() !== SETTINGS_CONFIG_KIND
  ) {
    throw new Error("Unsupported config file type.");
  }
  if (
    hasOwn(parsed, "schemaVersion") &&
    Number(parsed.schemaVersion) > SETTINGS_CONFIG_SCHEMA_VERSION
  ) {
    throw new Error("Config file was created by a newer app version.");
  }

  const settings = pickSettingsConfigFields(parsed.settings);
  const cloudBackupSettings = hasOwn(parsed, "cloudBackupSettings")
    ? pickCloudBackupSettingsFields(parsed.cloudBackupSettings)
    : null;

  if (!Object.keys(settings).length && !cloudBackupSettings) {
    throw new Error("Config file does not contain importable settings.");
  }

  return {
    settings: Object.keys(settings).length ? settings : null,
    cloudBackupSettings,
    containsSecrets: Boolean(parsed.containsSecrets),
    excludedSecrets: Array.isArray(parsed.excludedSecrets)
      ? parsed.excludedSecrets.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
  };
}

async function disconnectCloudProvidersForConfigChange() {
  await Promise.allSettled([
    api("/api/backup/auth/onedrive/disconnect", "POST", {}),
    api("/api/backup/auth/gdrive/disconnect", "POST", {}),
  ]);
}

async function refreshAfterSettingsConfigApply(prevMode, reason) {
  await loadSettings();
  await cbLoadSettings();
  try {
    await handleOperationModeTransition(
      prevMode,
      State.settings.operationMode,
      reason,
    );
  } catch (err) {
    const msg = String(err?.message || err || "unknown error");
    console.warn("[app] settings-config mode transition wait failed:", msg);
    showToast(`Mode applied, but runtime startup is still settling: ${msg}`, "warning", 6200);
  }
  buildInverterGrid();
  scheduleInverterCardsUpdate(true);
  buildSelects();
  syncOperationModeUi();
  syncDayAheadGeneratorAvailability();
  if (State.currentPage === "settings") {
    startReplicationHealthPolling();
    refreshReplicationHealth(true).catch(() => {});
  }
}

async function applySettingsConfigBundle(
  bundle,
  {
    reason = "settingsConfigApply",
    disconnectCloud = false,
    clearGDriveClientSecret = false,
  } = {},
) {
  const prevMode = State.settings.operationMode;
  const applied = {
    settings: false,
    cloudBackupSettings: false,
    cloudDisconnected: false,
  };

  try {
    if (bundle?.settings && Object.keys(bundle.settings).length) {
      await api("/api/settings", "POST", bundle.settings);
      applied.settings = true;
    }
    if (bundle?.cloudBackupSettings) {
      const cloudPayload = {
        ...bundle.cloudBackupSettings,
      };
      if (clearGDriveClientSecret) {
        cloudPayload.clearGDriveClientSecret = true;
      }
      await api("/api/backup/settings", "POST", cloudPayload);
      applied.cloudBackupSettings = true;
      if (disconnectCloud) {
        await disconnectCloudProvidersForConfigChange();
        applied.cloudDisconnected = true;
      }
    }
  } catch (err) {
    if (
      applied.settings ||
      applied.cloudBackupSettings ||
      applied.cloudDisconnected
    ) {
      await refreshAfterSettingsConfigApply(prevMode, `${reason}Partial`).catch(
        () => {},
      );
      const partial = [];
      if (applied.settings) partial.push("core settings applied");
      if (applied.cloudBackupSettings) partial.push("cloud settings applied");
      if (applied.cloudDisconnected) {
        partial.push("cloud sessions cleared");
      }
      throw new Error(`${partial.join(", ")}; ${err.message}`);
    }
    throw err;
  }

  await refreshAfterSettingsConfigApply(prevMode, reason);
  return applied;
}

async function exportSettingsConfig() {
  showMsg("settingsMsg", "Preparing settings config export...", "");
  try {
    const [settingsSnapshot, cloudData] = await Promise.all([
      api("/api/settings"),
      api("/api/backup/settings"),
    ]);
    const settings = pickSettingsConfigFields(settingsSnapshot);
    const cloudBackupSettings = pickCloudBackupSettingsFields(
      cloudData?.settings || {},
    );
    const containsSecrets = Boolean(
      settings?.remoteApiToken || settings?.solcastApiKey,
    );
    const payload = {
      kind: SETTINGS_CONFIG_KIND,
      schemaVersion: SETTINGS_CONFIG_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: getAppVersionLabel(),
      containsSecrets,
      excludedSecrets: ["gdrive.clientSecret", "oauthSessions"],
      settings,
      cloudBackupSettings,
    };
    const filePath = await saveTextFileLocally(
      JSON.stringify(payload, null, 2),
      getSettingsConfigFilename(),
      "Export Settings Configuration",
    );
    if (!filePath) {
      showMsg("settingsMsg", "Export cancelled.", "");
      return;
    }
    const exportMsg = containsSecrets
      ? "✔ Settings file exported. Treat it as restricted configuration data. Stored Google client secret and active cloud sessions were not included."
      : "✔ Settings file exported. Stored Google client secret and active cloud sessions were not included.";
    showMsg("settingsMsg", exportMsg, "");
  } catch (err) {
    showMsg("settingsMsg", `✗ Export failed: ${err.message}`, "error");
  }
}

async function importSettingsConfig() {
  try {
    const picked = await openTextFileLocally("Import Settings Configuration");
    if (!picked?.content) return;
    const bundle = parseSettingsConfigPayload(picked.content);
    const confirmLines = [
      "Import this settings file and replace the current configuration?",
    ];
    if (bundle.containsSecrets) {
      confirmLines.push(
        "This file may contain operational credentials. Handle it as restricted configuration data.",
      );
    }
    if (bundle.cloudBackupSettings) {
      confirmLines.push(
        "Cloud providers will be disconnected after import. The stored Google client secret is never included in exported files and must be entered again if required.",
      );
    }
    const ok = await appConfirm("Import Settings", confirmLines.join("\n\n"), { ok: "Import" });
    if (!ok) return;

    showMsg("settingsMsg", "Importing settings file...", "");
    const applied = await applySettingsConfigBundle(bundle, {
      reason: "importSettingsConfig",
      disconnectCloud: Boolean(bundle.cloudBackupSettings),
    });
    showMsg(
      "settingsMsg",
      applied.cloudBackupSettings
        ? "✔ Settings imported. Cloud providers were disconnected; reconnect them when ready."
        : "✔ Settings imported.",
      "",
    );
  } catch (err) {
    showMsg("settingsMsg", `✗ Import failed: ${err.message}`, "error");
  }
}

async function resetSettingsToDefaults() {
  const ok = await appConfirm(
    "Restore Defaults",
    "Restore dashboard settings and cloud backup configuration to their default values?\n\nThis will disconnect cloud providers and remove the stored Google client secret.",
    { ok: "Restore" },
  );
  if (!ok) return;

  showMsg("settingsMsg", "Restoring default settings...", "");
  try {
    const defaults = await api("/api/settings/defaults");
    const bundle = {
      settings: pickSettingsConfigFields(defaults?.settings || {}),
      cloudBackupSettings: pickCloudBackupSettingsFields(
        defaults?.cloudBackupSettings || {},
      ),
    };
    await applySettingsConfigBundle(bundle, {
      reason: "resetSettingsDefaults",
      disconnectCloud: true,
      clearGDriveClientSecret: true,
    });
    showMsg(
      "settingsMsg",
      "✔ Default settings restored. Cloud providers were disconnected and the stored Google client secret was removed.",
      "",
    );
  } catch (err) {
    showMsg("settingsMsg", `✗ Reset failed: ${err.message}`, "error");
  }
}

function normalizeOperationModeValue(mode) {
  return String(mode || "gateway").trim().toLowerCase() === "remote"
    ? "remote"
    : "gateway";
}

async function handleOperationModeTransition(
  prevModeRaw,
  nextModeRaw,
  reason = "",
) {
  const prevMode = normalizeOperationModeValue(prevModeRaw);
  const nextMode = normalizeOperationModeValue(nextModeRaw);
  if (prevMode === nextMode) return;
  const preserveAnalyticsView = State.currentPage === "analytics";
  const readinessStartedAt = Date.now();

  setModeTransitionState(true, nextMode);
  try {
    // Invalidate in-flight analytics reads so older mode responses cannot win.
    State.analyticsReqId = (State.analyticsReqId || 0) + 1;
    State.alarmReqId = (State.alarmReqId || 0) + 1;
    State.energyReqId = (State.energyReqId || 0) + 1;
    State.auditReqId = (State.auditReqId || 0) + 1;
    State.reportReqId = (State.reportReqId || 0) + 1;

    // Clear mode-specific runtime views immediately to avoid stale carry-over.
    State.liveData = {};
    State.totals = {};
    State.invLastFresh = {};
    State.alarmView.queryKey = "";
    State.energyView.queryKey = "";
    State.auditView.queryKey = "";
    State.reportView.queryKey = "";
    if (!preserveAnalyticsView) {
      State.analyticsBaseRows = [];
      State.analyticsDayAheadBaseRows = [];
      State.analyticsDayAheadCache = null;
      State.analyticsDailyTotalMwh = null;
      State.analyticsActualSummarySyncAt = 0;
      State.analyticsActualSummarySyncDay = "";
    }
    State.pacToday.lastTs = 0;
    State.pacToday.lastTotalPacW = 0;
    resetTodayMwhAuthority();
    State.remoteHealth = normalizeRemoteHealthClient({
      state: nextMode === "remote" ? "disconnected" : "gateway-local",
    });
    resetChatState();
    scheduleInverterCardsUpdate(true);

    if (nextMode === "remote") {
      stopTodayMwhSyncTimer();
      updateModeTransitionDetail("Waiting for the first live snapshot from the gateway...");
      // Allow a one-time HTTP seed while waiting for the first WS todayEnergy
      // payload after entering remote mode. Ongoing remote updates stay WS-only.
      await syncTodayMwhFromServer({ allowRemoteFallback: true }).catch((err) => {
        console.warn(
          `[app] mode transition today-MWh sync failed (${reason || "unknown"}):`,
          err?.message || err,
        );
      });
      renderTodayKwhFromPac();
      await waitForRemoteModeReady(readinessStartedAt);
    } else {
      startTodayMwhSyncTimer();
      renderTodayKwhFromPac();
      updateModeTransitionDetail("Waiting for the local poller to complete its first cycle...");
      await waitForGatewayModeReady(readinessStartedAt);
    }

    // Refresh currently visible data views only after the target runtime is ready.
    if (State.currentPage === "analytics") {
      await loadAnalytics({ force: true }).catch((err) => {
        console.warn("[app] mode transition analytics refresh failed:", err?.message || err);
      });
    } else if (State.currentPage === "alarms") {
      await fetchAlarms({ force: true }).catch((err) => {
        console.warn("[app] mode transition alarms refresh failed:", err?.message || err);
      });
    } else if (State.currentPage === "report") {
      await fetchReport({ force: true }).catch((err) => {
        console.warn("[app] mode transition report refresh failed:", err?.message || err);
      });
    } else if (State.currentPage === "energy") {
      await fetchEnergy({ force: true }).catch((err) => {
        console.warn("[app] mode transition energy refresh failed:", err?.message || err);
      });
    } else if (State.currentPage === "audit") {
      await fetchAudit({ force: true }).catch((err) => {
        console.warn("[app] mode transition audit refresh failed:", err?.message || err);
      });
    }

    await loadChatHistory({ silent: true }).catch((err) => {
      console.warn("[app] mode transition chat refresh failed:", err?.message || err);
    });
  } finally {
    setModeTransitionState(false);
  }
}

function hasUnsavedRemoteConnectivityChanges(normalizedGateway = "") {
  const formGateway = String(
    normalizedGateway || $("setRemoteGatewayUrl")?.value || "",
  ).trim();
  const savedGateway = String(State.settings.remoteGatewayUrl || "").trim();
  const formToken = String($("setRemoteApiToken")?.value || "").trim();
  const savedToken = String(State.settings.remoteApiToken || "").trim();
  return formGateway !== savedGateway || formToken !== savedToken;
}

async function refreshRemoteBridgeNow(silent = false) {
  const activeMode = getActiveOperationModeClient();
  if (activeMode !== "remote") return null;
  try {
    const result = await api("/api/runtime/network/reconnect", "POST", {}, {
      progress: false,
    });
    if (result?.remoteHealth) applyRemoteHealthClient(result.remoteHealth);
    await refreshReplicationHealth(true).catch(() => {});
    if (!silent) {
      const nodes = Number(result?.liveNodeCount || 0);
      const health = normalizeRemoteHealthClient(result?.remoteHealth || State.remoteHealth);
      if (result?.ok) {
        showMsg(
          "networkMsg",
          `✔ Live bridge refreshed (${nodes} node(s) visible).`,
          "",
        );
      } else {
        const reason = String(result?.error || health.reasonText || "Live bridge is using the last retained snapshot.").trim();
        showMsg(
          "networkMsg",
          `✗ Live bridge not fully healthy: ${reason}`,
          "error",
        );
      }
    }
    return result;
  } catch (err) {
    await refreshReplicationHealth(true).catch(() => {});
    if (!silent) {
      showMsg(
        "networkMsg",
        `✗ Live bridge refresh failed: ${err.message}`,
        "error",
      );
    }
    return null;
  }
}

async function confirmGatewayModeSwitch(nextMode, prevMode) {
  if (
    normalizeOperationModeValue(prevMode) !== "remote" ||
    normalizeOperationModeValue(nextMode) !== "gateway"
  ) {
    return true;
  }

  await refreshReplicationHealth(true).catch(() => {});
  const job = State.replication.job && typeof State.replication.job === "object"
    ? State.replication.job
    : null;
  const stagedStandbyReady =
    Boolean(job?.needsRestart) &&
    String(job?.status || "").trim().toLowerCase() === "completed";
  const restartCapable = isGatewayModeRestartCapable();
  const bodyText = stagedStandbyReady
    ? "A refreshed standby database is already staged locally.\n\nSaving this mode change should be followed by an app restart so Gateway mode starts from the staged local database.\n\nContinue with the Gateway mode switch?"
    : "Remote mode does not keep the local database current.\n\nRun Refresh Standby DB first if you need current local history before switching to Gateway mode.\n\nSaving this mode change should be followed by an app restart so Gateway mode starts cleanly.\n\nContinue with the Gateway mode switch?";

  return appConfirm(
    "Switch to Gateway Mode",
    bodyText,
    {
      ok: restartCapable ? "Save & Restart" : "Save Mode",
      cancel: "Cancel",
    },
  );
}

async function saveSettings() {
  const prevMode = State.settings.operationMode;
  const prevRetainDays = Math.max(1, Number(State.settings.retainDays || 90));
  const normalizedGateway = applyRemoteGatewayInputNormalization();
  const settingsMsgId = getSettingsMessageTargetId();
  const remoteConnectivityChanged = hasUnsavedRemoteConnectivityChanges(normalizedGateway);
  const solcastConfig = readSolcastSettingsForm();
  const plantCapRaw = readPlantCapFormRawValues("settings");
  const plantCapSequence = parsePlantCapSequenceInputClient(
    plantCapRaw.sequenceCustom,
    Number($("setInverterCount")?.value || State.settings.inverterCount || 27),
  );
  if (
    normalizePlantCapSequenceModeClient(plantCapRaw.sequenceMode) === "exemption" &&
    !plantCapSequence.ok
  ) {
    showMsg(settingsMsgId, plantCapSequence.error, "error");
    return false;
  }
  const remoteAutoSyncCtrl = $("setRemoteAutoSync");
  const body = {
    plantName: $("setPlantName").value,
    operatorName: $("setOperatorName").value,
    operationMode: $("setOperationMode").value,
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
    ...solcastConfig,
    plantLatitude:  Number($("setPlantLatitude")?.value  ?? ""),
    plantLongitude: Number($("setPlantLongitude")?.value ?? ""),
    plantCapUpperMw: String(plantCapRaw.upper || "").trim(),
    plantCapLowerMw: String(plantCapRaw.lower || "").trim(),
    plantCapSequenceMode: normalizePlantCapSequenceModeClient(
      plantCapRaw.sequenceMode,
    ),
    plantCapSequenceCustom: plantCapSequence.values,
    plantCapCooldownSec: Number(plantCapRaw.cooldown || 30),
    inverterPollConfig: {
      modbusTimeout:  Number($("setPollModbusTimeout")?.value  ?? 1.0),
      reconnectDelay: Number($("setPollReconnectDelay")?.value ?? 0.5),
      readSpacing:    Number($("setPollReadSpacing")?.value    ?? 0.005),
    },
  };
  if (remoteAutoSyncCtrl) {
    body.remoteAutoSync = Boolean(remoteAutoSyncCtrl.checked);
  }
  const nextMode = normalizeOperationModeValue(body.operationMode);
  const gatewayRestartPreferred =
    normalizeOperationModeValue(prevMode) === "remote" &&
    nextMode === "gateway";
  const proceed = await confirmGatewayModeSwitch(nextMode, prevMode);
  if (!proceed) return false;
  try {
    if (Number(body.retainDays || prevRetainDays) < prevRetainDays) {
      showMsg(
        settingsMsgId,
        "Saving settings and applying telemetry retention. This can take a while on large databases...",
        "",
      );
    }
    const saved = await api("/api/settings", "POST", body);
    const savedSettings =
      saved?.settings && typeof saved.settings === "object" ? saved.settings : null;
    const nextCsvPath =
      String(saved?.csvSavePath || savedSettings?.csvSavePath || body.csvSavePath || "").trim() ||
      State.settings.csvSavePath;
    if ($("setCsvPath")) $("setCsvPath").value = nextCsvPath;
    if ($("setRetainDays") && savedSettings?.retainDays !== undefined) {
      $("setRetainDays").value = String(savedSettings.retainDays);
    }
    State.settings = {
      ...State.settings,
      ...body,
      ...(savedSettings || {}),
      csvSavePath: nextCsvPath,
    };
    syncPlantCapFormsFromSettingsState();
    if ($("plantNameDisplay"))
      $("plantNameDisplay").textContent = State.settings.plantName || body.plantName;
    let transitionWarning = "";
    if (gatewayRestartPreferred && isGatewayModeRestartCapable()) {
      showMsg(
        settingsMsgId,
        "Gateway mode saved. Restarting the desktop app for a clean local startup...",
        "",
      );
      try {
        const restartResult = await window.electronAPI.restartApp();
        if (restartResult?.ok === false) {
          transitionWarning =
            ` Restart request failed: ${String(restartResult.error || "unknown error")}. Runtime switched without a full restart.`;
          console.warn("[app] gateway mode restart request failed:", restartResult.error);
        } else {
          return true;
        }
      } catch (err) {
        transitionWarning =
          ` Restart request failed: ${String(err?.message || err || "unknown error")}. Runtime switched without a full restart.`;
        console.warn("[app] gateway mode restart threw:", err?.message || err);
      }
    }
    try {
      await handleOperationModeTransition(prevMode, body.operationMode, "saveSettings");
    } catch (err) {
      transitionWarning =
        ` Mode applied, but the runtime is still settling: ${String(err?.message || err || "unknown error")}.`;
      console.warn("[app] mode transition wait failed:", err?.message || err);
    }
    let saveMsg = saved?.exportDirCreated
      ? "✔ Settings saved. Export folder created."
      : "✔ Settings saved";
    const retentionApplied =
      saved?.retentionApplied && typeof saved.retentionApplied === "object"
        ? saved.retentionApplied
        : null;
    if (retentionApplied) {
      if (retentionApplied.ok === false) {
        saveMsg += ` Retention apply failed: ${retentionApplied.error || "unknown error"}.`;
      } else {
        const archivedReadings = Number(retentionApplied?.archived?.readings || 0);
        const archivedEnergy = Number(retentionApplied?.archived?.energy5 || 0);
        if (archivedReadings > 0 || archivedEnergy > 0) {
          saveMsg += ` Retention applied: archived ${archivedReadings.toLocaleString()} readings and ${archivedEnergy.toLocaleString()} energy rows. Main DB ${fmtBytes(Number(retentionApplied.mainDbBytesBefore || 0))} -> ${fmtBytes(Number(retentionApplied.mainDbBytesAfter || 0))}.`;
        } else {
          saveMsg += ` Retention applied: no telemetry older than ${State.settings.retainDays} day(s) was found.`;
        }
      }
    }
    if (gatewayRestartPreferred && !isGatewayModeRestartCapable()) {
      transitionWarning += " Restart the desktop app now to start Gateway mode cleanly.";
    }
    if (transitionWarning) {
      saveMsg += transitionWarning;
    }
    showMsg(
      settingsMsgId,
      saveMsg,
      "",
    );
    buildInverterGrid();
    scheduleInverterCardsUpdate(true); // render cards immediately with cleared/current data
    buildSelects();
    syncDayAheadGeneratorAvailability();
    syncOperationModeUi();
    updateForecastSidebarSummary();
    if (State.currentPage === "forecast") {
      const useToolkitPreview =
        String($("setSolcastAccessMode")?.value || State.settings.solcastAccessMode || "toolkit")
          .trim()
          .toLowerCase() === "toolkit";
      if (useToolkitPreview) {
        loadSolcastPreview({ silent: true }).catch(() => {});
      }
    }
    if (State.currentPage === "settings") {
      startReplicationHealthPolling();
      refreshReplicationHealth(true).catch(() => {});
    }
    refreshPlantCapStatus(true).catch(() => {});
    if (transitionWarning) {
      showToast(transitionWarning.trim(), "warning", 6200);
    }
    if (
      normalizeOperationModeValue(body.operationMode) === "remote" &&
      (normalizeOperationModeValue(prevMode) !== "remote" || remoteConnectivityChanged)
    ) {
      refreshRemoteBridgeNow(true).catch(() => {});
    }
    return true;
  } catch (e) {
    showMsg(settingsMsgId, "✗ Save failed: " + e.message, "error");
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
    const unsavedConnectivity = hasUnsavedRemoteConnectivityChanges(normalizedGateway);
    if (unsavedConnectivity) {
      showToast(
        "Gateway test used unsaved URL/token values. Save Settings to apply them to the live bridge.",
        "warning",
        5200,
      );
    } else if (getActiveOperationModeClient() === "remote") {
      await refreshRemoteBridgeNow(true);
    }
    await refreshReplicationHealth(true).catch(() => {});
  } catch (e) {
    showMsg("networkMsg", `✗ ${e.message}`, "error");
    await refreshReplicationHealth(true).catch(() => {});
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
    "startup-auto-sync": "Standby DB refresh",
    "startup-auto-sync-failed": "Standby DB refresh failed",
    "pull-only": "Standby DB refresh",
    "pull-live": "Live stream",
    "pull-live-only": "Live stream",
    "pull-live-failed": "Live stream failed",
    "pull-priority-paused": "Priority standby refresh",
    "pull-full": "Standby DB refresh",
    "pull-full-failed": "Standby DB refresh failed",
    "pull-main-db-staged": "Standby DB staged",
    "pull-main-db-failed": "Standby DB refresh failed",
    "pull-incremental": "Standby DB catch-up",
    "pull-incremental-failed": "Standby DB catch-up failed",
    "push-full": "Push disabled",
    "push-full-failed": "Push disabled",
    "push-failed": "Push disabled",
  };
  return map[v] || (v ? v.replace(/[-_]/g, " ") : "—");
}

function loadReplicationArchiveSelectionPreference() {
  try {
    return localStorage.getItem(REPLICATION_INCLUDE_ARCHIVE_PREF_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function persistReplicationArchiveSelectionPreference(value) {
  try {
    localStorage.setItem(
      REPLICATION_INCLUDE_ARCHIVE_PREF_KEY,
      value ? "1" : "0",
    );
  } catch (_) {
    // Ignore local preference persistence failures.
  }
}

function setManualArchiveSyncSelected(checked, { persist = true, syncDom = true } = {}) {
  const next = Boolean(checked);
  State.replication.includeArchiveNext = next;
  if (syncDom) {
    const toggle = $("setReplicationIncludeArchive");
    if (toggle) toggle.checked = next;
  }
  if (persist) {
    persistReplicationArchiveSelectionPreference(next);
  }
  return next;
}

function isManualArchiveSyncSelected() {
  return Boolean(State.replication.includeArchiveNext);
}

function formatTailscaleStatus(ts) {
  const snap = ts && typeof ts === "object" ? ts : {};
  if (!snap.installed) return { text: "Not installed", cls: "error" };
  if (!snap.running) return { text: "Installed, not running", cls: "warn" };
  if (!snap.connected) return { text: "Running, not connected", cls: "warn" };
  const ip = Array.isArray(snap.tailscaleIps) && snap.tailscaleIps[0] ? snap.tailscaleIps[0] : "";
  return {
    text: ip ? `Connected (${ip})` : "Connected",
    cls: "ok",
  };
}

function formatReplicationScopeText(scope) {
  const hotTables = Array.isArray(scope?.hotTables) ? scope.hotTables : [];
  if (!hotTables.length) return "Gateway standby database scope is not available.";
  return `Standby DB source: ${hotTables.join(", ")}. Standby refresh replaces the local standby database with the latest gateway snapshot. During a manual refresh, the remote live stream pauses temporarily so the download gets priority.`;
}

function formatArchiveScopeText(scope) {
  const archive = scope?.archive && typeof scope.archive === "object" ? scope.archive : {};
  const count = Math.max(0, Number(archive?.fileCount || 0));
  const totalBytes = Math.max(0, Number(archive?.totalBytes || 0));
  const selected = isManualArchiveSyncSelected();
  return `${selected ? "Archive download is enabled for the next standby DB refresh and will stage the gateway monthly archive DB files." : "Archive download is optional and currently off."} Current local archive inventory: ${count.toLocaleString()} file${count === 1 ? "" : "s"} / ${fmtBytes(totalBytes)}. Live bridge polling never transfers archive files, and a manual standby refresh temporarily pauses the live stream so the DB download gets priority. Local mode settings, gateway credentials, Tailscale hint, and export path remain local.`;
}

function formatReplicationJobStatus(job) {
  const j = job && typeof job === "object" ? job : null;
  if (!j) return { text: "Idle", cls: "" };
  const status = String(j.status || "idle").trim().toLowerCase();
  const actionKey = String(j.action || "sync").trim().toLowerCase();
  const action = actionKey === "pull" ? "standby refresh" : actionKey;
  if (status === "running" || status === "queued") {
    const priorityLabel = j.priorityMode ? " · priority download" : "";
    const livePauseLabel = j.livePaused ? " · live paused" : "";
    return {
      text: `${action} ${status === "queued" ? "queued" : "running"}${j.includeArchive ? " · db + archive" : " · db only"}${priorityLabel}${livePauseLabel}`,
      cls: status === "queued" ? "warn" : "ok",
    };
  }
  if (status === "cancelling") {
    return {
      text: `${action} cancelling${j.includeArchive ? " · db + archive" : " · db only"}`,
      cls: "warn",
    };
  }
  if (status === "completed") {
    return {
      text: `${action} complete${j.needsRestart ? " · restart recommended" : ""}`,
      cls: "ok",
    };
  }
  if (status === "cancelled") {
    return { text: `${action} cancelled`, cls: "warn" };
  }
  if (status === "failed") {
    return { text: `${action} failed`, cls: "error" };
  }
  return { text: "Idle", cls: "" };
}

function updateReplicationActionButtons(job, mode) {
  const currentJob = job && typeof job === "object" ? job : null;
  const activeMode = String(mode || getActiveOperationModeClient() || "gateway")
    .trim()
    .toLowerCase();
  const pullBtn = $("btnRunReplicationPull");
  const cancelBtn = $("btnCancelReplicationJob");
  const archiveToggle = $("setReplicationIncludeArchive");
  const running = Boolean(currentJob?.running);
  const cancelling = String(currentJob?.status || "").trim().toLowerCase() === "cancelling";
  const canStartPull = activeMode === "remote" && !running;
  const canCancel = activeMode === "remote" && running && !cancelling;

  if (pullBtn) {
    pullBtn.disabled = !canStartPull;
    pullBtn.title = canStartPull
      ? "Download the gateway database for local standby use. Requires restart to apply."
      : activeMode !== "remote"
        ? "Available only in Remote mode."
        : "A standby DB refresh is already running.";
  }
  if (cancelBtn) {
    cancelBtn.disabled = !canCancel;
    cancelBtn.textContent = cancelling ? "Cancelling..." : "Force Cancel";
    cancelBtn.title = canCancel
      ? "Force-cancel the current standby DB refresh and clean up staged partial transfer files."
      : activeMode !== "remote"
        ? "Available only in Remote mode."
        : running
          ? "Cancellation has already been requested."
          : "No standby DB refresh is running.";
  }
  if (archiveToggle) {
    archiveToggle.checked = isManualArchiveSyncSelected();
    archiveToggle.disabled = activeMode !== "remote" || running;
  }
}

async function promptReplicationRestart(job) {
  const j = job && typeof job === "object" ? job : null;
  if (!j?.needsRestart || !j?.id) return;
  if (State.replication.restartPromptedJobId === j.id) return;
  State.replication.restartPromptedJobId = j.id;
  const summary = String(j.summary || "").trim();
  const ok = await appConfirm(
    "Standby DB Refresh Complete",
    `Standby DB refresh finished.\n\n${summary || "The transfer is complete."}\n\nRestart the app now to reload runtime state and archive metadata?`,
    { ok: "Restart Now", cancel: "Later" },
  );
  if (!ok) return;
  try {
    if (window.electronAPI?.restartApp) {
      const res = await window.electronAPI.restartApp();
      if (res?.ok === false) {
        throw new Error(String(res?.error || "Restart request failed."));
      }
      return;
    }
    showToast("Restart the desktop app manually to reload the refreshed standby data.", "info", 5000);
  } catch (err) {
    showToast(`Restart request failed: ${err.message}`, "warning", 5000);
  }
}

function handleReplicationJobUpdate(jobRaw, opts = {}) {
  const job = jobRaw && typeof jobRaw === "object" ? jobRaw : null;
  State.replication.job = job;
  const status = formatReplicationJobStatus(job);
  setReplicationField("repJobStatusVal", status.text, status.cls);
  updateReplicationActionButtons(job, getActiveOperationModeClient());

  if (!job) return;
  if (opts.showMessage !== false) {
    if (job.status === "running" || job.status === "queued") {
      const actionLabel =
        String(job.action || "").trim().toLowerCase() === "pull"
          ? "standby DB refresh"
          : String(job.action || "job").trim();
      const priorityNote =
        job.priorityMode || job.livePaused
          ? " Live stream is paused temporarily so the download gets priority."
          : "";
      showMsg("replicationMsg", `Background ${actionLabel} started.${priorityNote}`, "");
    } else if (job.status === "completed") {
      showMsg("replicationMsg", `✔ ${job.summary || "Standby DB refresh complete."}`, "");
      showToast(job.summary || "Standby DB refresh complete.", "success", 5200);
    } else if (job.status === "cancelling") {
      showMsg(
        "replicationMsg",
        job.summary || "Force-cancelling standby DB refresh...",
        "",
      );
    } else if (job.status === "cancelled") {
      const msg = job.summary || "Standby DB refresh cancelled.";
      showMsg("replicationMsg", msg, "");
      showToast(msg, "info", 4200);
    } else if (job.status === "failed") {
      const msg = job.error || job.summary || "Download failed.";
      showMsg("replicationMsg", `✗ ${msg}`, "error");
      showToast(`Download failed: ${msg}`, "warning", 6000);
    }
  }
  if (job.status === "completed") {
    promptReplicationRestart(job).catch(() => {});
  }
}

function updateReplicationArchiveSelectionUi(silent = false) {
  const checked = isManualArchiveSyncSelected();
  const hint = $("replicationArchiveHint");
  if (hint) {
    hint.textContent = checked
      ? "Archive download is enabled for the next standby DB refresh. All gateway monthly archive DB files will be staged, so expect a longer transfer while the remote live stream is paused."
      : "Optional. Leave this off for the fastest standby DB refresh. Enable it only when you need the gateway archive DB files staged too. The remote live stream still pauses during the transfer.";
  }
  if (State.replication.scope) {
    setReplicationField(
      "repArchiveScopeVal",
      formatArchiveScopeText(State.replication.scope),
    );
  }
  if (!silent) {
    showMsg(
      "replicationMsg",
      checked
        ? "Archive download enabled for the next standby DB refresh. All gateway archive DB files will be staged while the remote live stream is paused."
        : "Archive download disabled. Only the gateway standby database will be refreshed, with the remote live stream paused during the transfer.",
      checked ? "error" : "",
    );
  }
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
    const scope = n?.manualReplicationScope || null;
    const job = n?.manualReplicationJob || null;
    State.replication.scope = scope;
    State.replication.job = job;
    const mode = String(n?.operationMode || State.settings.operationMode || "gateway")
      .trim()
      .toLowerCase();
    const pullOnly = Boolean(n?.remotePullOnly);
    const health = applyRemoteHealthClient(n?.remoteHealth || null);
    const bridgeMeta = getRemoteHealthDisplay(health, mode);
    setReplicationField("repModeVal", mode === "remote" ? "Remote" : "Gateway");
    setReplicationField(
      "repGatewayVal",
      String(n?.remoteGatewayUrl || "—").trim() || "—",
    );
    setReplicationField("repConnectedVal", bridgeMeta.text, bridgeMeta.cls);
    const tailscaleState = formatTailscaleStatus(n?.tailscale || {});
    setReplicationField("repTailnetVal", tailscaleState.text, tailscaleState.cls);
    const directionRaw = pullOnly
      ? "pull-live-only"
      : String(n?.remoteLastSyncDirection || "idle");
    const directionClass =
      /failed/i.test(directionRaw)
        ? "error"
        : /^push/i.test(directionRaw)
          ? "warn"
          : /pull|live/i.test(directionRaw)
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
      fmtTsWithAge(n?.remoteLastReplicationTs || n?.remoteLastReconcileTs || 0),
    );
    const bridgeErr = String(n?.remoteLastError || "").trim();
    const repErr = String(n?.remoteLastReplicationError || "").trim();
    const recErr = String(n?.remoteLastReconcileError || "").trim();
    const allErr = Array.from(
      new Set([health.reasonText, bridgeErr, repErr, recErr].filter(Boolean)),
    );
    setReplicationField(
      "repErrorsVal",
      allErr.length ? allErr.join(" | ") : "None",
      allErr.length
        ? health.state === "auth-error" || health.state === "config-error"
          ? "error"
          : "warn"
        : "ok",
    );
    setReplicationField("repScopeVal", formatReplicationScopeText(scope));
    setReplicationField("repArchiveScopeVal", formatArchiveScopeText(scope));
    handleReplicationJobUpdate(job, { showMessage: false });
    updateReplicationActionButtons(job, mode);
    if (!silent) {
      showMsg("replicationMsg", "✔ Gateway link status refreshed", "");
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
  const activeMode = getActiveOperationModeClient();
  const selectedMode = getSelectedOperationModeClient();
  if (activeMode !== "remote") {
    showMsg(
      "replicationMsg",
      selectedMode === "remote"
        ? "Standby DB refresh actions require active Remote mode. Save Settings first to apply the mode change."
        : "Standby DB refresh is available only in Remote mode.",
      "error",
    );
    return false;
  }
  return true;
}

async function runReplicationPullNow() {
  if (!ensureRemoteModeForReplicationActions()) return;
  const includeArchive = isManualArchiveSyncSelected();
  const archiveLine = includeArchive
    ? "\n\nGateway archive DB files will be included. Expect a longer transfer."
    : "\n\nArchive files: Skipped for this run.";
  const _pullOk = await appConfirm(
    "Refresh Standby Database",
    "Download the gateway database for local standby use.\n\n" +
    "The gateway snapshot will replace your local database on restart.\n\n" +
    "While the standby refresh is running, the remote live stream will pause temporarily so the download gets priority.\n\n" +
    "Local-only settings (operation mode, gateway URL/token, tailnet hint, and export path) are preserved." +
    archiveLine +
    "\n\nYou will be prompted to restart after completion.",
    { ok: "Start Download" },
  );
  if (!_pullOk) return;

  const btn = $("btnRunReplicationPull");
  if (btn) btn.disabled = true;
  showMsg(
    "replicationMsg",
    "Starting priority standby refresh. Remote live stream will pause during the download…",
    "",
  );
  const startPull = async (forcePull = false) => {
    const result = await api("/api/replication/pull-now", "POST", {
      background: true,
      includeArchive,
      forcePull,
    });
    const job = result?.job || null;
    if (job) handleReplicationJobUpdate(job, { showMessage: false });
    setManualArchiveSyncSelected(false);
    updateReplicationArchiveSelectionUi(true);
    showMsg(
      "replicationMsg",
      forcePull
        ? includeArchive
          ? "Force Pull started. The gateway database will overwrite newer local standby data, then gateway archive DB files will be staged while live streaming is paused."
          : "Force Pull started. The gateway database will overwrite newer local standby data while live streaming is paused."
        : includeArchive
          ? "Priority download started. Staging the gateway database first. Gateway archive DB files will follow while live streaming is paused."
          : "Priority download started. Staging the gateway database while live streaming is paused.",
      "",
    );
    await refreshReplicationHealth(true);
    await refreshRuntimePerf(true);
  };
  try {
    await startPull(false);
  } catch (e) {
    if (
      e?.body?.errorCode === "LOCAL_NEWER_PUSH_FAILED" &&
      e?.body?.canForcePull
    ) {
      const conflictMsg = String(
        e?.body?.error ||
        e?.message ||
        "Local standby data is newer than the gateway.",
      ).trim();
      const forceOk = await appConfirm(
        "Force Pull Required",
        `${conflictMsg}\n\nUse Force Pull only if the gateway is the source of truth and you intentionally want to discard the newer local standby data on this machine.\n\nProceed with Force Pull now?`,
        { ok: "Force Pull", cancel: "Cancel" },
      );
      if (!forceOk) {
        showMsg("replicationMsg", `✗ ${conflictMsg}`, "error");
        return;
      }
      try {
        await startPull(true);
        return;
      } catch (forceErr) {
        showMsg("replicationMsg", `✗ ${forceErr.message}`, "error");
        return;
      }
    }
    showMsg("replicationMsg", `✗ ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runReplicationCancelNow() {
  const job = State.replication.job && typeof State.replication.job === "object"
    ? State.replication.job
    : null;
  if (!job?.running) {
    showMsg("replicationMsg", "No standby DB refresh is currently running.", "error");
    return;
  }
  const status = String(job.status || "").trim().toLowerCase();
  if (status === "cancelling") {
    showMsg("replicationMsg", "Cancellation is already in progress.", "");
    return;
  }
  const ok = await appConfirm(
    "Force Cancel Standby Refresh",
    "Force-cancel the current standby DB refresh.\n\n" +
    "Any partially downloaded main DB or archive files from this run will be cleaned up so they are not applied on restart.\n\n" +
    "Continue with the cancellation?",
    { ok: "Force Cancel", cancel: "Keep Running" },
  );
  if (!ok) return;

  updateReplicationActionButtons(
    { ...job, status: "cancelling", running: true, cancelRequested: true },
    getActiveOperationModeClient(),
  );
  showMsg("replicationMsg", "Force-cancelling standby DB refresh...", "");
  try {
    const result = await api("/api/replication/cancel", "POST", {});
    if (result?.job) {
      handleReplicationJobUpdate(result.job, { showMessage: false });
    }
    showMsg("replicationMsg", "Force-cancelling standby DB refresh...", "");
  } catch (err) {
    updateReplicationActionButtons(job, getActiveOperationModeClient());
    showMsg("replicationMsg", `✗ ${err.message}`, "error");
  }
}

// Viewer model: push is disabled — remote mode is a gateway-backed viewer.
async function runReplicationPushNow() {
  showMsg("replicationMsg", "Push is disabled. Remote mode is a gateway-backed viewer.", "error");
}

async function testSolcastConnection() {
  const btn = $("btnSolcastTest");
  const payload = readSolcastSettingsForm();

  if (btn) btn.disabled = true;
  showMsg("solcastTestMsg", "Testing Solcast connection...", "");
  try {
    const r = await api("/api/forecast/solcast/test", "POST", payload);
    const covered = Array.isArray(r?.daysCovered) ? r.daysCovered.length : 0;
    const slots = Number(r?.dayAheadPreview?.slots || 0);
    const mwh = Number(r?.dayAheadPreview?.totalMwh || 0).toFixed(6);
    const modeLabel =
      String(r?.accessMode || payload.solcastAccessMode || "").trim().toLowerCase() === "api"
        ? "API"
        : "Toolkit";
    const msg =
      `✔ Solcast ${modeLabel} connected | records=${Number(r?.records || 0)} | days=${covered} | next-day slots=${slots} | next-day MWh=${mwh}`;
    showMsg("solcastTestMsg", msg, "");
    if (r?.warning) {
      showToast(`Solcast warning: ${r.warning}`, "warning", 4200);
    }
    showSnapshotWarningToast("Solcast snapshot", r?.snapshotWarning || "");
    if (String(r?.accessMode || payload.solcastAccessMode || "").trim().toLowerCase() === "toolkit") {
      loadSolcastPreview({ silent: true }).catch(() => {});
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

function showSnapshotWarningToast(prefix, warningInput) {
  const warnings = Array.isArray(warningInput)
    ? warningInput
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [String(warningInput || "").trim()].filter(Boolean);
  if (!warnings.length) return;
  const extra = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : "";
  showToast(`${prefix}: ${warnings[0]}${extra}`, "warning", 5200);
}

// ─── Inverter Grid ────────────────────────────────────────────────────────────
function syncPlantCapFormsFromSettingsState() {
  applyPlantCapFormRawValues(
    {
      upper:
        State.settings.plantCapUpperMw == null
          ? ""
          : String(State.settings.plantCapUpperMw),
      lower:
        State.settings.plantCapLowerMw == null
          ? ""
          : String(State.settings.plantCapLowerMw),
      sequenceMode: State.settings.plantCapSequenceMode || "ascending",
      sequenceCustom: formatPlantCapSequenceInputClient(
        State.settings.plantCapSequenceCustom || [],
      ),
      cooldown: String(State.settings.plantCapCooldownSec ?? 30),
    },
    ["live", "settings"],
  );
}

function buildPlantCapPanel() {
  const wrap = el("div", "plant-cap-panel");
  wrap.id = "plantCapPanel";
  wrap.title =
    "Plant-wide MW capping controls. Use this panel to define the output band, review the next planner decision, and enable or release automatic whole-inverter control.";
  wrap.innerHTML = `
    <div class="plant-cap-head">
      <div class="plant-cap-head-main" title="Plant-wide MW capping settings and live controller summary.">
        <div class="bulk-control-title">Plant Output Cap</div>
        <div class="plant-cap-title-line">Gateway-directed whole-inverter MW capping</div>
      </div>
      <div class="plant-cap-head-actions">
        <div class="plant-cap-metrics">
          <div class="plant-cap-metric" title="Current total plant MW from fresh live PAC data. The cap controller uses this as the starting point for stop and restart decisions.">
            <span>Plant</span>
            <strong id="plantCapCurrentMw">—</strong>
          </div>
          <div class="plant-cap-metric" title="Configured lower and upper MW band for plant-wide capping. The controller tries to keep total plant output inside this range.">
            <span>Band</span>
            <strong id="plantCapBandValue">—</strong>
          </div>
          <div class="plant-cap-metric" title="Current controller mode. Idle means disabled, Paused means monitoring is blocked by data or safety conditions, and Enabled means the controller is active.">
            <span>Mode</span>
            <strong id="plantCapModeValue">Idle</strong>
          </div>
        </div>
      </div>
    </div>
    <div id="plantCapPanelBody" class="plant-cap-panel-body">
      <div class="plant-cap-form">
        <label title="Upper MW threshold. If total plant output stays above this limit long enough, the controller will plan a whole-inverter stop action.">
          Upper Limit (MW)
          <input id="plantCapUpperMw" class="inp" type="number" min="0" step="0.001" inputmode="decimal" title="Upper MW threshold for automatic capping decisions." />
        </label>
        <label title="Lower MW threshold. If total plant output stays below this limit and the controller owns stopped inverters, it may restart one safely.">
          Lower Limit (MW)
          <input id="plantCapLowerMw" class="inp" type="number" min="0" step="0.001" inputmode="decimal" title="Lower MW threshold for safe controller restart decisions." />
        </label>
        <label title="Candidate selection mode. Ascending and Descending walk inverter numbers in order. Exemption skips the listed inverter numbers and uses ascending order for the rest.">
          Sequence
          <select id="plantCapSequenceMode" class="sel" title="Choose how the controller selects inverters for automatic stop decisions.">
            <option value="ascending">Ascending</option>
            <option value="descending">Descending</option>
            <option value="exemption">Exemption</option>
          </select>
        </label>
        <label id="plantCapSequenceCustomWrap" hidden title="Exempted inverter numbers. These inverter numbers are skipped during automatic stop selection. Use a comma-separated list.">
          Exempted Inverter Numbers
          <input id="plantCapSequenceCustom" class="inp" type="text" placeholder="2, 5, 9" autocomplete="off" title="Comma-separated inverter numbers to exempt from automatic stop selection." />
        </label>
        <label title="Cooldown or settling time in seconds after each stop or restart action. The controller waits this long before making another decision.">
          Cooldown (s)
          <input id="plantCapCooldownSec" class="inp" type="number" min="5" max="600" step="1" inputmode="numeric" title="Seconds to wait after each controller action before the next plant cap decision." />
        </label>
      </div>
      <div id="plantCapClientWarnings" class="plant-cap-inline-warnings" title="Client-side guidance for the current cap band, node mix, and exemption list."></div>
      <div class="plant-cap-actions">
        <button id="btnPlantCapPreview" class="btn btn-outline" type="button" title="Preview the next stop or restart decision using the current band, live PAC, and exemption list.">Preview Plan</button>
        <button id="btnPlantCapEnable" class="btn btn-red" type="button" title="Enable gateway-side plant output capping with confirmation and authorization.">Enable Cap</button>
        <button id="btnPlantCapDisable" class="btn btn-outline" type="button" title="Disable automatic plant cap monitoring for the current session without restarting controlled inverters.">Disable Monitoring</button>
        <button id="btnPlantCapRelease" class="btn btn-green" type="button" title="Restart controller-owned inverters sequentially and release them from plant cap control.">Release Controlled Inverters</button>
      </div>
      <div class="plant-cap-status-grid">
        <div class="plant-cap-status-item" title="Current plant cap controller state.">
          <span>Status</span>
          <strong id="plantCapStatusText">Idle</strong>
        </div>
        <div class="plant-cap-status-item" title="Primary reason for the current controller state or next recommended action.">
          <span>Reason</span>
          <strong id="plantCapReasonText">Plant-wide capping is disabled.</strong>
        </div>
        <div class="plant-cap-status-item" title="Inverters currently owned by the plant cap controller because it stopped them earlier in this session.">
          <span>Controlled</span>
          <strong id="plantCapOwnedText">None</strong>
        </div>
        <div class="plant-cap-status-item" title="Most recent automatic stop or restart action, or the remaining settling time after a recent action.">
          <span>Last Action</span>
          <strong id="plantCapLastActionText">—</strong>
        </div>
      </div>
      <div id="plantCapServerWarnings" class="plant-cap-server-warnings" title="Server-side planner warnings, safety blocks, or advisory messages."></div>
      <div class="plant-cap-preview">
        <div class="plant-cap-preview-head">
          <div class="plant-cap-preview-title" title="Preview of the next whole-inverter controller decision based on the current band, live plant MW, and exemption list.">Cap Plan Preview</div>
          <div id="plantCapPreviewMeta" class="plant-cap-preview-meta" title="Planner summary for the next recommended stop or restart decision.">Preview the next stop/start decision before enabling control.</div>
        </div>
        <div class="plant-cap-preview-table-wrap">
          <table class="plant-cap-preview-table">
            <thead>
              <tr>
                <th title="Inverter number being evaluated by the planner.">Inverter</th>
                <th title="Configured enabled node count for this inverter.">Nodes</th>
                <th title="Node-adjusted rated inverter capacity in kW.">Rated kW</th>
                <th title="Node-adjusted dependable capacity in kW used for conservative planning.">Dependable kW</th>
                <th id="plantCapPreviewStepHdr" title="Estimated plant MW change if this inverter is stopped, or restart estimate if it is started.">Step kW</th>
                <th title="Projected total plant MW after applying this stop or restart step.">Projected Plant MW</th>
                <th title="Why this inverter step is preferred, allowed, or rejected by the planner.">Decision Reason</th>
              </tr>
            </thead>
            <tbody id="plantCapPreviewBody">
              <tr class="table-empty"><td colspan="7">No plant cap preview yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  if (State.plantCapPanelCollapsed) {
    wrap.classList.add("is-collapsed");
    wrap.classList.add("is-hidden");
    wrap.hidden = true;
    wrap.style.display = "none";
    wrap.setAttribute("aria-hidden", "true");
  }
  return wrap;
}

function normalizePlantCapStatusClient(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: Boolean(src.enabled),
    status: String(src.status || "idle"),
    reasonCode: String(src.reasonCode || "disabled"),
    reasonText: String(src.reasonText || "Plant-wide capping is disabled."),
    upperMw: src.upperMw == null ? null : Number(src.upperMw),
    lowerMw: src.lowerMw == null ? null : Number(src.lowerMw),
    currentPlantMw: src.currentPlantMw == null ? null : Number(src.currentPlantMw),
    warnings: Array.isArray(src.warnings) ? src.warnings : [],
    stepMetrics: src.stepMetrics && typeof src.stepMetrics === "object" ? src.stepMetrics : {},
    ownedStopped: Array.isArray(src.ownedStopped) ? src.ownedStopped : [],
    lastDecision: src.lastDecision && typeof src.lastDecision === "object" ? src.lastDecision : null,
    preview: src.preview && typeof src.preview === "object" ? src.preview : null,
    cooldownRemainingSec: Number(src.cooldownRemainingSec || 0),
  };
}

function formatPlantCapBandLabel(status) {
  if (status.upperMw == null || status.lowerMw == null) return "—";
  return `${Number(status.lowerMw).toFixed(3)} - ${Number(status.upperMw).toFixed(3)} MW`;
}

function renderPlantCapPreviewTable(previewRaw) {
  const tbody = $("plantCapPreviewBody");
  const meta = $("plantCapPreviewMeta");
  const stepHdr = $("plantCapPreviewStepHdr");
  if (!tbody || !meta || !stepHdr) return;
  const preview = previewRaw && typeof previewRaw === "object" ? previewRaw : null;
  if (!preview) {
    stepHdr.textContent = "Step kW";
    stepHdr.title =
      "Estimated plant output change for each candidate step in kW.";
    meta.textContent =
      "Preview the next stop/start decision before enabling control.";
    meta.title = meta.textContent;
    tbody.innerHTML =
      '<tr class="table-empty"><td colspan="7">No plant cap preview yet.</td></tr>';
    return;
  }
  const useRestart =
    preview.currentPlantKw < preview.lowerKw &&
    Array.isArray(preview.restartPlan) &&
    preview.restartPlan.length > 0;
  const rows = useRestart
    ? preview.restartPlan || []
    : (preview.stopPlan && preview.stopPlan.length
      ? preview.stopPlan
      : preview.restartPlan || []);
  const selectedInverter = useRestart
    ? preview.selectedRestart?.inverter
    : preview.selectedStop?.inverter;
  stepHdr.textContent = useRestart ? "Restart Est. kW" : "Live Pac kW";
  stepHdr.title = useRestart
    ? "Estimated plant output increase in kW if the controller restarts this inverter."
    : "Current live PAC contribution in kW that would be removed if the controller stops this inverter.";
  const recommended = String(preview.recommendedAction || "hold").toUpperCase();
  meta.textContent = `Recommended: ${recommended} · Current ${Number(
    preview.currentPlantMw || 0,
  ).toFixed(3)} MW · Band ${Number(preview.lowerMw || 0).toFixed(3)}-${Number(
    preview.upperMw || 0,
  ).toFixed(3)} MW`;
  meta.title = meta.textContent;
  if (!rows.length) {
    tbody.innerHTML =
      '<tr class="table-empty"><td colspan="7">No eligible inverter step is available for the current band.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((row) => {
      const stepKw = useRestart ? row.restartEstimateKw : row.livePacKw;
      const selectedClass =
        Number(row.inverter || 0) === Number(selectedInverter || 0)
          ? " plant-cap-preview-selected"
          : "";
      const reason = String(row.decisionReason || "—");
      const rowTitle =
        `INV-${String(row.inverter || 0).padStart(2, "0")} · ` +
        `Nodes ${Number(row.enabledNodes || 0)} · ` +
        `Rated ${Number(row.ratedKw || 0).toFixed(1)} kW · ` +
        `Dependable ${Number(row.dependableKw || 0).toFixed(1)} kW · ` +
        `${useRestart ? "Restart estimate" : "Live PAC"} ${Number(stepKw || 0).toFixed(1)} kW · ` +
        `Projected plant ${Number(row.projectedPlantMw || 0).toFixed(3)} MW · ` +
        reason;
      return `
        <tr class="${selectedClass.trim()}" title="${rowTitle}">
          <td title="Inverter number under evaluation.">INV-${String(row.inverter || 0).padStart(2, "0")}</td>
          <td title="Configured enabled node count for this inverter.">${Number(row.enabledNodes || 0)}</td>
          <td title="Node-adjusted rated inverter capacity in kW.">${Number(row.ratedKw || 0).toFixed(1)}</td>
          <td title="Node-adjusted dependable capacity in kW used for conservative planning.">${Number(row.dependableKw || 0).toFixed(1)}</td>
          <td title="${useRestart ? "Estimated plant output increase if this inverter is restarted." : "Current live PAC contribution that would be removed if this inverter is stopped."}">${Number(stepKw || 0).toFixed(1)}</td>
          <td title="Projected total plant output after applying this step.">${Number(row.projectedPlantMw || 0).toFixed(3)}</td>
          <td title="${reason}">${reason}</td>
        </tr>`;
    })
    .join("");
}

function renderPlantCapPanel() {
  syncPlantCapPanelCollapsedUi();
  const currentMwEl = $("plantCapCurrentMw");
  const bandEl = $("plantCapBandValue");
  const modeEl = $("plantCapModeValue");
  const statusEl = $("plantCapStatusText");
  const reasonEl = $("plantCapReasonText");
  const ownedEl = $("plantCapOwnedText");
  const lastActionEl = $("plantCapLastActionText");
  const warningsEl = $("plantCapServerWarnings");
  const releaseBtn = $("btnPlantCapRelease");
  const previewMetaEl = $("plantCapPreviewMeta");
  if (!currentMwEl || !bandEl || !modeEl || !statusEl || !reasonEl || !ownedEl || !lastActionEl || !warningsEl) {
    return;
  }
  const status = normalizePlantCapStatusClient(State.plantCap.status || {});
  currentMwEl.textContent =
    status.currentPlantMw == null ? "—" : `${Number(status.currentPlantMw).toFixed(3)} MW`;
  bandEl.textContent = formatPlantCapBandLabel(status);
  const modeText = status.enabled ? "Enabled" : status.status === "paused" ? "Paused" : "Idle";
  modeEl.textContent = modeText;
  statusEl.textContent = String(status.status || "idle").toUpperCase();
  reasonEl.textContent = status.reasonText || "Plant-wide capping is disabled.";
  if (status.ownedStopped.length) {
    ownedEl.textContent = status.ownedStopped
      .map((entry) => `INV-${String(entry.inverter || 0).padStart(2, "0")}`)
      .join(", ");
  } else {
    ownedEl.textContent = "None";
  }
  if (releaseBtn) {
    releaseBtn.disabled = !status.ownedStopped.length;
  }
  if (status.lastDecision) {
    const stamp = status.lastDecision.at ? fmtDateTime(status.lastDecision.at) : "";
    const label = String(status.lastDecision.action || "").toUpperCase();
    lastActionEl.textContent = stamp
      ? `${label} INV-${String(status.lastDecision.inverter || 0).padStart(2, "0")} @ ${stamp}`
      : `${label} INV-${String(status.lastDecision.inverter || 0).padStart(2, "0")}`;
  } else if (status.cooldownRemainingSec > 0) {
    lastActionEl.textContent = `Settling (${status.cooldownRemainingSec}s remaining)`;
  } else {
    lastActionEl.textContent = "—";
  }
  currentMwEl.closest(".plant-cap-metric")?.setAttribute(
    "title",
    status.currentPlantMw == null
      ? "Current total plant MW from fresh live PAC data used by the cap controller."
      : `Current total plant MW from fresh live PAC data: ${Number(status.currentPlantMw).toFixed(3)} MW.`,
  );
  bandEl.closest(".plant-cap-metric")?.setAttribute(
    "title",
    status.upperMw == null || status.lowerMw == null
      ? "Configured lower and upper MW cap band."
      : `Configured plant cap band: ${Number(status.lowerMw).toFixed(3)} to ${Number(status.upperMw).toFixed(3)} MW.`,
  );
  modeEl.closest(".plant-cap-metric")?.setAttribute(
    "title",
    `Current controller mode: ${modeText}. Idle means disabled, Paused means blocked by safety or freshness checks, and Enabled means active.`,
  );
  statusEl.closest(".plant-cap-status-item")?.setAttribute(
    "title",
    `Current plant cap controller state: ${statusEl.textContent}.`,
  );
  reasonEl.closest(".plant-cap-status-item")?.setAttribute(
    "title",
    `Current controller reason: ${reasonEl.textContent}`,
  );
  ownedEl.closest(".plant-cap-status-item")?.setAttribute(
    "title",
    status.ownedStopped.length
      ? `Controller-owned stopped inverters: ${ownedEl.textContent}.`
      : "No inverter is currently owned by the plant cap controller.",
  );
  lastActionEl.closest(".plant-cap-status-item")?.setAttribute(
    "title",
    lastActionEl.textContent === "—"
      ? "No automatic stop or restart action has been recorded for this session."
      : `Most recent controller action or settling state: ${lastActionEl.textContent}.`,
  );
  const warnings = Array.isArray(status.warnings) ? status.warnings : [];
  if (!warnings.length) {
    warningsEl.className = "plant-cap-server-warnings";
    warningsEl.textContent =
      "Server-side planner status is normal. Preview or enable the controller to apply the configured cap band.";
  } else {
    const critical = warnings.some((warning) => warning?.severity === "critical");
    warningsEl.className = `plant-cap-server-warnings ${critical ? "critical" : "warning"}`;
    warningsEl.textContent = warnings
      .slice(0, 2)
      .map((warning) => String(warning?.message || "").trim())
      .filter(Boolean)
      .join(" ");
  }
  warningsEl.title = warnings.length
    ? warnings
      .map((warning) => String(warning?.message || "").trim())
      .filter(Boolean)
      .join(" ")
    : "Server-side planner warnings, safety blocks, or advisory messages.";
  if (previewMetaEl) {
    previewMetaEl.title = previewMetaEl.textContent || "Planner summary for the next cap decision.";
  }
  renderPlantCapPreviewTable(
    State.plantCap.preview || status.preview || null,
  );
}

function applyPlantCapStatusClient(statusRaw, options = {}) {
  const normalized = normalizePlantCapStatusClient(statusRaw);
  State.plantCap.status = normalized;
  if (!options.preservePreview) {
    State.plantCap.preview = normalized.preview || State.plantCap.preview;
  } else if (normalized.preview && !State.plantCap.preview) {
    State.plantCap.preview = normalized.preview;
  }
  renderPlantCapPanel();
}

function buildInverterGrid() {
  const grid = $("invGrid");
  if (!grid) return;
  grid.innerHTML = "";
  State.nodeOrderSig = {};
  const count = State.settings.inverterCount;
  const nodes = State.settings.nodeCount || 4;
  const frag = document.createDocumentFragment();
  frag.appendChild(buildPlantCapPanel());
  for (let i = 1; i <= count; i++) {
    frag.appendChild(buildInverterCard(i, nodes));
  }
  frag.appendChild(buildBulkControlPanel());
  grid.appendChild(frag);
  applyInverterGridLayout(State.settings.invGridLayout);
  syncPlantCapFormsFromSettingsState();
  renderPlantCapPanel();
}

function currentOperator() {
  const inState = String(State.settings.operatorName || "").trim();
  if (inState) return inState;
  const fromInput = String($("setOperatorName")?.value || "").trim();
  return fromInput || "OPERATOR";
}

function currentChatMachine() {
  return normalizeOperationModeValue(State.settings.operationMode);
}

function getChatModeLabel(machine = currentChatMachine()) {
  return normalizeChatMachineClient(machine, "gateway") === "remote"
    ? "Remote"
    : "Server";
}

function buildChatSenderLabel(row) {
  const machine = normalizeChatMachineClient(row?.from_machine, currentChatMachine());
  const explicit = String(row?.from_name || "").trim();
  if (explicit) return explicit;
  return `${currentOperator()} - ${getChatModeLabel(machine)}`;
}

function normalizeChatMachineClient(value, def = "gateway") {
  return String(value || def).trim().toLowerCase() === "remote"
    ? "remote"
    : "gateway";
}

function isChatInboundRow(row, machine = currentChatMachine()) {
  const ownMachine = normalizeChatMachineClient(machine, currentChatMachine());
  return (
    !!row &&
    normalizeChatMachineClient(row.to_machine, ownMachine) === ownMachine &&
    normalizeChatMachineClient(row.from_machine, ownMachine) !== ownMachine
  );
}

function sanitizeChatRowClient(row) {
  if (!row || typeof row !== "object") return null;
  const id = Math.max(0, Math.trunc(Number(row.id || 0)));
  if (!id) return null;
  const fromMachine = normalizeChatMachineClient(row.from_machine, "gateway");
  const toMachine = normalizeChatMachineClient(
    row.to_machine,
    fromMachine === "remote" ? "gateway" : "remote",
  );
  return {
    id,
    ts: Math.max(0, Math.trunc(Number(row.ts || 0))),
    from_machine: fromMachine,
    to_machine: toMachine,
    from_name: String(row.from_name || "").trim().slice(0, 160),
    message: String(row.message || ""),
    read_ts:
      row.read_ts == null || row.read_ts === ""
        ? null
        : Math.max(0, Math.trunc(Number(row.read_ts || 0))),
  };
}

function syncChatRuntimeFromRows() {
  const machine = currentChatMachine();
  let lastInboundId = 0;
  let lastReadId = 0;
  let unread = 0;
  for (const row of State.chatMessages) {
    if (normalizeChatMachineClient(row.to_machine, machine) !== machine) continue;
    lastInboundId = Math.max(lastInboundId, Number(row.id || 0));
    if (row.read_ts) lastReadId = Math.max(lastReadId, Number(row.id || 0));
    else unread += 1;
  }
  State.chatLastInboundId = lastInboundId;
  State.chatLastReadId = Math.max(Number(State.chatLastReadId || 0), lastReadId);
  State.chatUnread = State.chatOpen ? 0 : unread;
}

function mergeChatRows(rows) {
  const merged = new Map();
  for (const row of State.chatMessages || []) {
    const normalized = sanitizeChatRowClient(row);
    if (normalized) merged.set(normalized.id, normalized);
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = sanitizeChatRowClient(row);
    if (!normalized) continue;
    const prev = merged.get(normalized.id);
    if (!prev) {
      merged.set(normalized.id, normalized);
      continue;
    }
    merged.set(normalized.id, {
      ...prev,
      ...normalized,
      read_ts: normalized.read_ts || prev.read_ts || null,
    });
  }
  State.chatMessages = Array.from(merged.values())
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
    .slice(-CHAT_THREAD_LIMIT);
  syncChatRuntimeFromRows();
  renderChatSendState();
  return State.chatMessages;
}

function renderChatBadge() {
  const badge = $("chatBadge");
  if (!badge) return;
  const count = Math.max(0, Math.trunc(Number(State.chatUnread || 0)));
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = count > 99 ? "99+" : String(count);
  } else {
    badge.hidden = true;
    badge.textContent = "0";
  }
}

function renderChatSendState() {
  const btn = $("chatSend");
  const clearBtn = $("chatClear");
  const input = $("chatInput");
  const busy = !!State.chatPendingSend || !!State.chatPendingClear;
  if (btn) {
    btn.disabled = busy;
    btn.textContent = State.chatPendingSend ? "Sending..." : "Send";
  }
  if (clearBtn) {
    clearBtn.disabled =
      busy || !Array.isArray(State.chatMessages) || State.chatMessages.length === 0;
    clearBtn.textContent = State.chatPendingClear ? "Clearing..." : "Clear";
  }
  if (input) input.disabled = busy;
}

function renderChatThread() {
  const thread = $("chatThread");
  if (!thread) return;
  const rows = Array.isArray(State.chatMessages) ? State.chatMessages : [];
  const frag = document.createDocumentFragment();
  if (!rows.length) {
    const empty = el("div", "chat-empty");
    empty.textContent = "No recent operator messages.";
    frag.appendChild(empty);
  } else {
    const machine = currentChatMachine();
    for (const row of rows) {
      const self = normalizeChatMachineClient(row.from_machine, machine) === machine;
      const item = el("div", `chat-message${self ? " is-self" : ""}`);
      const meta = el("div", "chat-message-meta");
      meta.textContent = `${buildChatSenderLabel(row)} • ${fmtDateTime(row.ts)}`;
      const body = el("div", "chat-message-body");
      body.textContent = String(row.message || "");
      item.appendChild(meta);
      item.appendChild(body);
      frag.appendChild(item);
    }
  }
  thread.textContent = "";
  thread.appendChild(frag);
  if (State.chatOpen) {
    requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
  }
}

function clearChatDismissTimer() {
  if (State.chatDismissTimer) {
    clearTimeout(State.chatDismissTimer);
    State.chatDismissTimer = null;
  }
}

function chatHasProtectedDraft() {
  const input = $("chatInput");
  if (!input) return false;
  return document.activeElement === input && String(input.value || "").trim().length > 0;
}

function resetChatDismissTimer() {
  clearChatDismissTimer();
  if (!State.chatOpen) return;
  if (State.chatPendingSend) return;
  if (State.chatPendingClear) return;
  if (chatHasProtectedDraft()) return;
  State.chatDismissTimer = setTimeout(() => {
    closeChatPanel();
  }, CHAT_DISMISS_MS);
}

function openChatPanel() {
  const panel = $("chatPanel");
  const bubble = $("chatBubble");
  if (!panel || !bubble) return;
  State.chatOpen = true;
  panel.classList.add("chat-panel--open");
  panel.setAttribute("aria-hidden", "false");
  bubble.setAttribute("aria-expanded", "true");
  State.chatUnread = 0;
  renderChatBadge();
  renderChatThread();
  markChatRead().catch((err) => {
    console.warn("[chat] mark read failed:", err.message);
  });
  resetChatDismissTimer();
}

function closeChatPanel() {
  const panel = $("chatPanel");
  const bubble = $("chatBubble");
  if (!panel || !bubble) return;
  State.chatOpen = false;
  panel.classList.remove("chat-panel--open");
  panel.setAttribute("aria-hidden", "true");
  bubble.setAttribute("aria-expanded", "false");
  clearChatDismissTimer();
}

function applyChatClearedState({ preserveDraft = true } = {}) {
  State.chatMessages = [];
  State.chatUnread = 0;
  State.chatLastReadId = 0;
  State.chatLastInboundId = 0;
  State.chatReadInFlight = false;
  State.chatPendingReadUpToId = 0;
  State.chatHistoryLoaded = true;
  if (!preserveDraft && $("chatInput")) $("chatInput").value = "";
  renderChatSendState();
  renderChatBadge();
  renderChatThread();
  if (State.chatOpen) resetChatDismissTimer();
}

async function loadChatHistory(options = {}) {
  try {
    const payload = await api(
      `/api/chat/messages?mode=thread&limit=${CHAT_THREAD_LIMIT}`,
      "GET",
      null,
      { progress: false },
    );
    mergeChatRows(payload?.rows);
    State.chatHistoryLoaded = true;
    renderChatBadge();
    if (State.chatOpen) {
      renderChatThread();
      await markChatRead();
      resetChatDismissTimer();
    }
    return State.chatMessages;
  } catch (err) {
    State.chatHistoryLoaded = false;
    if (!options?.silent) {
      console.warn("[chat] history load failed:", err.message);
    }
    return [];
  }
}

async function markChatRead(forcedUpToId = 0) {
  const machine = currentChatMachine();
  let upToId = Math.max(0, Math.trunc(Number(forcedUpToId || 0)));
  for (const row of State.chatMessages || []) {
    if (!isChatInboundRow(row, machine)) continue;
    upToId = Math.max(upToId, Number(row.id || 0));
  }
  if (!upToId || upToId <= Number(State.chatLastReadId || 0)) {
    State.chatUnread = 0;
    renderChatBadge();
    return 0;
  }
  if (State.chatReadInFlight) {
    State.chatPendingReadUpToId = Math.max(
      Number(State.chatPendingReadUpToId || 0),
      upToId,
    );
    return 0;
  }
  State.chatReadInFlight = true;
  try {
    const payload = await api(
      "/api/chat/read",
      "POST",
      { upToId },
      { progress: false },
    );
    const readTs = Date.now();
    State.chatLastReadId = Math.max(Number(State.chatLastReadId || 0), upToId);
    State.chatMessages = (State.chatMessages || []).map((row) => {
      if (!isChatInboundRow(row, machine)) return row;
      if (Number(row.id || 0) > upToId) return row;
      if (row.read_ts) return row;
      return {
        ...row,
        read_ts: readTs,
      };
    });
    State.chatUnread = 0;
    renderChatBadge();
    return Math.max(0, Math.trunc(Number(payload?.updated || 0)));
  } catch (err) {
    console.warn("[chat] read sync failed:", err.message);
    return 0;
  } finally {
    State.chatReadInFlight = false;
    const pending = Math.max(0, Math.trunc(Number(State.chatPendingReadUpToId || 0)));
    State.chatPendingReadUpToId = 0;
    if (pending > Number(State.chatLastReadId || 0)) {
      markChatRead(pending).catch(() => {});
    }
  }
}

function playChatSound() {
  try {
    const ctx = getOrCreateAlarmAudioCtx();
    if (!ctx || ctx.state !== "running") {
      State.chatAudioReady = false;
      return;
    }
    State.chatAudioReady = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.018;
    gain.connect(ctx.destination);
    const t0 = ctx.currentTime;
    [660, 880].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      const startAt = t0 + idx * 0.105;
      osc.start(startAt);
      osc.stop(startAt + 0.085);
    });
  } catch (err) {
    console.warn("[chat] sound failed:", err.message);
  }
}

function handleIncomingChatMessage(row) {
  const normalized = sanitizeChatRowClient(row);
  if (!normalized) return;
  const hadRow = (State.chatMessages || []).some(
    (item) => Number(item?.id || 0) === normalized.id,
  );
  const inbound = isChatInboundRow(normalized);
  mergeChatRows([normalized]);
  renderChatBadge();
  if (!hadRow && inbound) {
    openChatPanel();
    playChatSound();
    return;
  }
  if (State.chatOpen) {
    renderChatThread();
    if (inbound) {
      markChatRead(normalized.id).catch((err) => {
        console.warn("[chat] mark read failed:", err.message);
      });
    }
  }
  resetChatDismissTimer();
}

function handleChatCleared() {
  applyChatClearedState({ preserveDraft: true });
}

async function sendChatMessage() {
  const input = $("chatInput");
  if (!input || State.chatPendingSend || State.chatPendingClear) return;
  const draft = String(input.value || "").replace(/\r\n?/g, "\n");
  const message = draft.trim();
  if (!message) {
    input.value = message;
    resetChatDismissTimer();
    return;
  }
  if (message.length > 500) {
    showToast("Message must be 500 characters or fewer.", "warning", 3200);
    return;
  }
  State.chatPendingSend = true;
  renderChatSendState();
  try {
    const payload = await api(
      "/api/chat/send",
      "POST",
      { message },
      { progress: false },
    );
    const row = sanitizeChatRowClient(payload?.row);
    if (!row) throw new Error("Chat send completed without a message row.");
    mergeChatRows([row]);
    input.value = "";
    if (State.chatOpen) renderChatThread();
    renderChatBadge();
    resetChatDismissTimer();
  } catch (err) {
    showToast(String(err?.message || "Gateway unavailable. Message not sent."), "warning", 3600);
  } finally {
    State.chatPendingSend = false;
    renderChatSendState();
    if (State.chatOpen) resetChatDismissTimer();
  }
}

async function clearChatMessages() {
  if (State.chatPendingSend || State.chatPendingClear) return;
  if (!Array.isArray(State.chatMessages) || State.chatMessages.length === 0) {
    renderChatSendState();
    return;
  }
  const ok = await appConfirm(
    "Clear Operator Messages",
    "Clear the current operator message thread?\n\nThis removes the shared message history for both Server and Remote panels.",
    { ok: "Clear Messages", cancel: "Keep Messages" },
  );
  if (!ok) {
    resetChatDismissTimer();
    return;
  }
  State.chatPendingClear = true;
  renderChatSendState();
  try {
    await api("/api/chat/clear", "POST", {}, { progress: false });
    applyChatClearedState({ preserveDraft: true });
    showToast("Operator message history cleared.", "success", 2600);
  } catch (err) {
    showToast(
      String(err?.message || "Unable to clear operator messages."),
      "warning",
      3600,
    );
  } finally {
    State.chatPendingClear = false;
    renderChatSendState();
    if (State.chatOpen) resetChatDismissTimer();
  }
}

function toggleChatPanel() {
  if (State.chatOpen) {
    closeChatPanel();
    return;
  }
  openChatPanel();
  if (!State.chatHistoryLoaded) {
    loadChatHistory({ silent: true }).catch(() => {});
  }
}

function resetChatState() {
  clearChatDismissTimer();
  State.chatOpen = false;
  State.chatUnread = 0;
  State.chatMessages = [];
  State.chatLastReadId = 0;
  State.chatLastInboundId = 0;
  State.chatPendingSend = false;
  State.chatPendingClear = false;
  State.chatReadInFlight = false;
  State.chatPendingReadUpToId = 0;
  State.chatHistoryLoaded = false;
  if ($("chatInput")) $("chatInput").value = "";
  renderChatSendState();
  renderChatBadge();
  renderChatThread();
  closeChatPanel();
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
        <div class="bulk-range-helper">Enter individual inverter numbers, ranges, or a combination of both. Duplicate entries are not allowed.</div>
      </div>
      <div class="bulk-action-group">
        <button id="btnFillAllTargets" class="btn btn-outline">All Inverters</button>
        <button id="btnClearTargets" class="btn btn-outline">Clear</button>
      </div>
      <div class="bulk-action-group bulk-action-primary">
        <button id="btnStartSelected" class="btn btn-green">START SELECTED</button>
        <button id="btnStopSelected" class="btn btn-red">STOP SELECTED</button>
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
        <button class="card-ctrl-btn start" data-inv="${inv}" data-action="start">Start</button>
        <button class="card-ctrl-btn stop" data-inv="${inv}" data-action="stop">Stop</button>
      </div>
      <div class="pac-cell">
        <span class="pac-label">Pdc:</span>
        <span class="pac-val zero" id="pdcsum-${inv}">0.00</span>
        <span class="pac-unit">kW</span>
      </div>
      <div class="pac-cell">
        <span class="pac-label">Pac:</span>
        <span class="pac-val zero" id="pac-${inv}">0.00</span>
        <span class="pac-unit">kW</span>
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
    const btnText = nodeConfigured ? (state ? "STOP" : "START") : "N/A";
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
            data-inv="${inv}"
            data-node="${n}"
            title="${btnTitle}"
            aria-label="${btnAria}"
            ${nodeConfigured ? "" : "disabled"}>${btnText}</button>
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
  const now = Date.now();
  const nodeCount = Number(State.settings.nodeCount || 4);
  const invCount = Number(State.settings.inverterCount || 27);
  const remoteMode = getActiveOperationModeClient() === "remote";
  const remoteHealth = normalizeRemoteHealthClient(State.remoteHealth);
  const retainRemoteSnapshot = remoteMode && Boolean(remoteHealth.hasUsableSnapshot);
  const remoteDisplayHoldMs = retainRemoteSnapshot
    ? Math.max(CARD_OFFLINE_HOLD_MS, Number(remoteHealth.snapshotRetainMs || 0))
    : CARD_OFFLINE_HOLD_MS;

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

    // Aggregate units for this inverter
    const units = (unitsByInv[inv] || []).filter(
      (d) => d.inverter === inv && configuredSet.has(Number(d.unit || 0)),
    );
    const invUnitMap = unitMapByInv[inv] || Object.create(null);
    const freshUnits = units.filter(
      (d) => d.online && now - getLiveFreshTsClient(d) <= DATA_FRESH_MS,
    );
    const visibleUnits = units.filter(
      (d) => d.online && now - getLiveFreshTsClient(d) <= DATA_FRESH_MS + remoteDisplayHoldMs,
    );
    const activeAlarmEntries = (activeAlarmsByInv[inv] || []).filter(
      (a) =>
        Number(a.inverter) === inv && configuredSet.has(Number(a.unit || 0)),
    );
    const hasFreshData = freshUnits.length > 0;
    if (hasFreshData) State.invLastFresh[inv] = now;
    const staleSnapshot = retainRemoteSnapshot && !hasFreshData && visibleUnits.length > 0;
    const inHold =
      !hasFreshData &&
      !staleSnapshot &&
      now - Number(State.invLastFresh[inv] || 0) <= CARD_OFFLINE_HOLD_MS;
    const anyOnline = hasFreshData || staleSnapshot || inHold;
    const unitsForDisplay = staleSnapshot ? visibleUnits : freshUnits;
    const displayTotals = summarizeLiveRows(unitsForDisplay);
    const pac = Number(displayTotals.pac || 0);
    const pdc = Number(displayTotals.pdc || 0);
    totalPac += pac;
    const anyAlarm =
      unitsForDisplay.some((d) => d.alarm && d.alarm !== 0) ||
      activeAlarmEntries.length > 0;
    const topSev = higherSeverity(
      getTopSev(unitsForDisplay),
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
    } else if (staleSnapshot) {
      card.classList.add("stale");
      online++;
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
      else if (staleSnapshot) iconEl.classList.add("stale");
      else if (topSev === "critical" || anyAlarm) iconEl.classList.add("alarm");
    }

    // Badge
    if (!anyOnline) {
      badge.className = "badge badge-offline";
      badge.textContent = "OFFLINE";
    } else if (staleSnapshot) {
      badge.className = "badge badge-stale";
      badge.textContent = "STALE";
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
    const pacKw = (pac / 1000).toFixed(2);
    pacEl.textContent = pacKw;
    pacEl.className = "pac-val" + (pac === 0 ? " zero" : " active");
    if (pdcSumEl) {
      pdcSumEl.textContent = (pdc / 1000).toFixed(2);
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
      const rowVisible =
        d &&
        d.online &&
        now - getLiveFreshTsClient(d) <= DATA_FRESH_MS + remoteDisplayHoldMs;
      const nodeReachable =
        d && d.online && now - getLiveFreshTsClient(d) <= DATA_FRESH_MS;
      const rowStale = staleSnapshot && rowVisible && !nodeReachable;
      if (nodeReachable) activeNodes++;
      const nodeOn =
        (staleSnapshot ? rowVisible : nodeReachable) && Number(d?.on_off) === 1
          ? 1
          : 0;
      const activeAlarm = State.activeAlarms[key] || null;
      const liveAlarmValue = rowVisible ? Number(d?.alarm || 0) : 0;
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
        pdcEl.textContent = rowVisible && d.pdc != null ? fmtNum(d.pdc, 0) : "—";
      if (rpacEl) {
        const pacVal = rowVisible && d.pac != null ? Number(d.pac) : 0;
        rpacEl.textContent = rowVisible && d.pac != null ? fmtNum(d.pac, 0) : "—";
        rpacEl.className = "mono";
        if (nindEl) {
          const pacIndicatorClass = getPacIndicatorClass(
            pacVal,
            hasActiveAlarm,
            rowVisible,
          );
          nindEl.className = `node-power-indicator ${pacIndicatorClass}`;
        }
      }
      if (rtsEl) rtsEl.textContent = rowVisible && d.ts ? fmtTime(d.ts) : "—";
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
        rowEl.classList.toggle("row-stale-snapshot", rowStale);
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
  if (mntEl) mntEl.textContent = `/ ${invCount * nodeCount}`; // designed total, not configured-only
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
  await syncTodayMwhFromServer({ allowRemoteFallback: true });
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
  if (v >= NODE_RATED_W * 0.90) return "row-pac-high"; // ≥90% — High     (~224 kW)
  if (v >  NODE_RATED_W * 0.70) return "row-pac-mid";  // >70%  — Moderate (~175 kW)
  if (v >  NODE_RATED_W * 0.40) return "row-pac-low";  // >40%  — Mild     (~100 kW)
  return "row-pac-off";                                 // ≤40%  — Low
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
  if (isIsolated) return "N/A";
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
const BulkAuth = {
  resolver: null,
  open: false,
};

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
  const authKey = await requestBulkAuthorization(action, scopeLabel, totalTargets);
  if (!authKey) return null;
  const session = await api(
    "/api/write/auth/bulk",
    "POST",
    { authKey },
    { progress: false },
  );
  const authToken = String(session?.token || "").trim();
  if (!authToken) {
    throw new Error("Bulk authorization token was not issued.");
  }
  return {
    authKey,
    authToken,
    expiresAt: Number(session?.expiresAt || 0),
  };
}

function buildPlantCapRequestBody(context = "live") {
  const values = readPlantCapRequestValues(context);
  if (values.upperMw == null) {
    throw new Error("Upper limit is required.");
  }
  if (values.lowerMw == null) {
    throw new Error("Lower limit is required.");
  }
  if (!(values.lowerMw < values.upperMw)) {
    throw new Error("Lower limit must be less than the upper limit.");
  }
  if (values.sequenceMode === "exemption" && values.sequenceError) {
    throw new Error(values.sequenceError);
  }
  return {
    upperMw: values.upperMw,
    lowerMw: values.lowerMw,
    sequenceMode: values.sequenceMode,
    sequenceCustom: values.sequenceCustom,
    cooldownSec: values.cooldownSec,
  };
}

function countPlantCapTargetsFromPreview(previewRaw) {
  const preview = previewRaw && typeof previewRaw === "object" ? previewRaw : null;
  const previewProfiles = Array.isArray(preview?.profiles) ? preview.profiles : [];
  const controllableNodeCount = previewProfiles
    .filter((profile) => profile.controllable)
    .reduce((sum, profile) => sum + Number(profile.enabledNodes || 0), 0);
  if (controllableNodeCount > 0) return controllableNodeCount;
  const ownedStopped = Array.isArray(State.plantCap.status?.ownedStopped)
    ? State.plantCap.status.ownedStopped
    : [];
  const ownedNodeCount = ownedStopped.reduce(
    (sum, entry) => sum + Number(entry.enabledNodes || 0),
    0,
  );
  return Math.max(1, ownedNodeCount || 1);
}

async function refreshPlantCapStatus(silent = true) {
  try {
    const data = await api("/api/plant-cap/status");
    applyPlantCapStatusClient(data.status || null, { preservePreview: true });
    return data.status || null;
  } catch (err) {
    if (!silent) {
      showToast(`Plant cap status refresh failed: ${err.message}`, "fault", 5000);
    }
    throw err;
  }
}

async function previewPlantCap(options = {}) {
  const context = String(options.context || "live").trim().toLowerCase() || "live";
  const body = buildPlantCapRequestBody(context);
  const data = await api("/api/plant-cap/preview", "POST", body, {
    progress: false,
  });
  State.plantCap.preview = data.preview || null;
  applyPlantCapStatusClient(data.status || null, { preservePreview: true });
  renderPlantCapPanel();
  return data.preview || null;
}

function buildPlantCapEnableConfirmText(preview) {
  const warnings = Array.isArray(preview?.warnings) ? preview.warnings : [];
  const warningText = warnings
    .slice(0, 2)
    .map((warning) => String(warning?.message || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const bandText =
    preview && preview.upperMw != null && preview.lowerMw != null
      ? `Band: ${Number(preview.lowerMw).toFixed(3)} - ${Number(preview.upperMw).toFixed(3)} MW.`
      : "Band: not configured.";
  const plantText =
    preview && preview.currentPlantMw != null
      ? `Current plant output: ${Number(preview.currentPlantMw).toFixed(3)} MW.`
      : "Current plant output is unavailable.";
  const actionText = String(preview?.recommendedAction || "hold").toUpperCase();
  const recommendation =
    actionText === "STOP" && preview?.selectedStop
      ? `Next stop candidate: INV-${String(preview.selectedStop.inverter || 0).padStart(2, "0")}.`
      : actionText === "START" && preview?.selectedRestart
        ? `Next restart candidate: INV-${String(preview.selectedRestart.inverter || 0).padStart(2, "0")}.`
        : "No immediate inverter action is currently planned.";
  return [plantText, bandText, `Recommended action: ${actionText}.`, recommendation, warningText]
    .filter(Boolean)
    .join("\n\n");
}

async function enablePlantCapControl() {
  let preview;
  try {
    preview = await previewPlantCap({ context: "live" });
  } catch (err) {
    showToast(`Plant cap preview failed: ${err.message}`, "fault", 5000);
    return;
  }
  const ok = await appConfirm(
    "Enable Plant Output Cap",
    buildPlantCapEnableConfirmText(preview),
    { ok: "Enable" },
  );
  if (!ok) return;
  let authSession = null;
  try {
    authSession = await authorizeBulkCommand(
      "ENABLE",
      "plant cap monitoring",
      countPlantCapTargetsFromPreview(preview),
    );
  } catch (err) {
    showToast(`Plant cap enable failed: ${err.message}`, "fault", 5000);
    return;
  }
  if (!authSession) {
    showToast("Plant cap enable cancelled.", "info", 3200);
    return;
  }
  try {
    const response = await api(
      "/api/plant-cap/enable",
      "POST",
      {
        ...buildPlantCapRequestBody("live"),
        authToken: authSession.authToken,
      },
      { progress: false },
    );
    State.plantCap.preview = response?.status?.preview || State.plantCap.preview;
    applyPlantCapStatusClient(response?.status || null, { preservePreview: true });
    showToast("Plant cap monitoring enabled.", "success", 3200);
  } catch (err) {
    showToast(`Plant cap enable failed: ${err.message}`, "fault", 5000);
  }
}

async function disablePlantCapControl() {
  const ok = await appConfirm(
    "Disable Plant Output Cap",
    "Disable plant-wide capping monitoring?\n\nThis stops automatic control but does not restart any inverter that the controller previously stopped.",
    { ok: "Disable" },
  );
  if (!ok) return;
  let authSession = null;
  try {
    authSession = await authorizeBulkCommand("DISABLE", "plant cap monitoring", 1);
  } catch (err) {
    showToast(`Plant cap disable failed: ${err.message}`, "fault", 5000);
    return;
  }
  if (!authSession) {
    showToast("Plant cap disable cancelled.", "info", 3200);
    return;
  }
  try {
    const response = await api(
      "/api/plant-cap/disable",
      "POST",
      { authToken: authSession.authToken },
      { progress: false },
    );
    applyPlantCapStatusClient(response?.status || null, { preservePreview: true });
    showToast("Plant cap monitoring disabled.", "success", 3200);
  } catch (err) {
    showToast(`Plant cap disable failed: ${err.message}`, "fault", 5000);
  }
}

async function releasePlantCapControl() {
  const ok = await appConfirm(
    "Release Controlled Inverters",
    "Start all controller-owned inverters sequentially in reverse stop order?\n\nThis also disables plant-wide capping monitoring for the current session.",
    { ok: "Release" },
  );
  if (!ok) return;
  let authSession = null;
  try {
    authSession = await authorizeBulkCommand(
      "RELEASE",
      "controller-owned inverters",
      countPlantCapTargetsFromPreview(State.plantCap.preview),
    );
  } catch (err) {
    showToast(`Plant cap release failed: ${err.message}`, "fault", 5000);
    return;
  }
  if (!authSession) {
    showToast("Plant cap release cancelled.", "info", 3200);
    return;
  }
  try {
    const response = await api(
      "/api/plant-cap/release",
      "POST",
      { authToken: authSession.authToken },
      { progress: false },
    );
    if (response?.status) {
      State.plantCap.preview = response.status.preview || null;
      applyPlantCapStatusClient(response.status, { preservePreview: true });
    }
    showToast("Controller-owned inverters released.", "success", 3600);
  } catch (err) {
    showToast(`Plant cap release failed: ${err.message}`, "fault", 5000);
  }
}

async function runControlTasksWithConcurrency(tasksRaw, limit = 3) {
  const tasks = Array.isArray(tasksRaw) ? tasksRaw : [];
  if (!tasks.length) return [];
  const safeLimit = Math.max(1, Math.min(tasks.length, Number(limit || 1) || 1));
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try {
        const value = await api("/api/write", "POST", task?.body || {}, {
          progress: false,
        });
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  return results;
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
      priority: "high",
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
      body: {
        inverter: inv,
        node: n,
        unit: n,
        value: val,
        scope: "inverter",
        operator: currentOperator(),
      },
    });
  }

  const results = await runControlTasksWithConcurrency(tasks, 2);
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
  let authSession = null;
  try {
    authSession = await authorizeBulkCommand(
      action,
      `selected inverters (${selected.length})`,
      totalTargets,
    );
  } catch (e) {
    showToast(`${action} failed: ${e.message}`, "fault", 5000);
    return;
  }
  if (!authSession) {
    showToast(`${action} cancelled: selected inverters`, "info", 3200);
    return;
  }

  const tasks = [];
  selected.forEach((inv) => {
    for (const n of getConfiguredUnits(inv, nodeCount)) {
      tasks.push({
        inverter: inv,
        node: n,
        body: {
          inverter: inv,
          node: n,
          unit: n,
          value: val,
          scope: "selected",
          authToken: authSession.authToken,
          operator: currentOperator(),
        },
      });
    }
  });

  const results = await runControlTasksWithConcurrency(tasks, 2);
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
  if (v === "all") {
    clearInverterDetail();
  } else {
    loadInverterDetail(Number(v));
  }
}

// ─── Inverter Detail Panel ────────────────────────────────────────────────────

function clearInverterDetail() {
  // Return the inv-card to the grid before hiding the panel
  const inv = State.invDetailInv;
  if (inv) {
    const card = document.getElementById(`inv-card-${inv}`);
    const grid = $("invGrid");
    if (card && grid && !grid.contains(card)) {
      // re-insert before the bulk control panel (last child)
      const bulk = grid.querySelector(".bulk-control-bar");
      grid.insertBefore(card, bulk || null);
    }
  }
  const panel = $("invDetailPanel");
  if (panel) panel.style.display = "none";
  if (State.invDetailRefreshTimer) {
    clearInterval(State.invDetailRefreshTimer);
    State.invDetailRefreshTimer = null;
  }
  State.invDetailInv = 0;
  State.invDetailLoading = false;
  State.invDetailKwh = 0;
  State.invDetailAlarmRows = [];
  State.invDetailReportRows = [];
}

async function loadInverterDetail(inv) {
  if (State.invDetailInv === inv && State.invDetailLoading) return;
  // If switching inverters, return old card first
  if (State.invDetailInv && State.invDetailInv !== inv) clearInverterDetail();
  State.invDetailInv = inv;
  State.invDetailLoading = true;

  const panel = $("invDetailPanel");
  if (!panel) return;
  panel.style.display = "flex";

  // Move the live inv-card into the slot (card continues to update in real-time)
  const card = document.getElementById(`inv-card-${inv}`);
  const slot = $("invDetailCardSlot");
  if (card && slot) {
    slot.innerHTML = "";
    slot.appendChild(card);
  }

  const invLabel = `INV-${String(inv).padStart(2, "0")}`;
  const statsEl = $("invDetailStats");
  const alarmsEl = $("invDetailAlarms");
  const historyEl = $("invDetailHistory");
  if (statsEl) statsEl.innerHTML = `<div class="inv-detail-stat"><span class="inv-detail-stat-label">Loading ${invLabel} details…</span></div>`;
  if (alarmsEl) alarmsEl.innerHTML = `<div class="inv-detail-no-data">Loading current activity…</div>`;
  if (historyEl) historyEl.innerHTML = `<div class="inv-detail-no-data">Loading recent history…</div>`;

  const now = Date.now();
  const todayStr = today();
  const todayStartMs = localDateStartMs(todayStr);
  const sevenDayStart = dateStr(new Date(now - 7 * 86400000));

  try {
    const reportReq = apiWithTimeout(
      `/api/report/daily?start=${sevenDayStart}&end=${todayStr}`,
      15000,
      "Timed out while loading recent history.",
    ).catch((err) => {
      console.warn("loadInverterDetail report:", err?.message || err);
      return [];
    });

    const [alarmsResp, todayEnergyResp] = await Promise.all([
      api(`/api/alarms?inverter=${inv}&start=${Math.floor(todayStartMs)}&end=${now}`).catch((err) => {
        console.warn("loadInverterDetail alarms:", err?.message || err);
        return [];
      }),
      api(`/api/energy/today`).catch((err) => {
        console.warn("loadInverterDetail energy:", err?.message || err);
        return [];
      }),
    ]);

    if (State.invDetailInv !== inv) return; // selection changed while fetching

    const alarmRows  = Array.isArray(alarmsResp) ? alarmsResp : (Array.isArray(alarmsResp?.rows) ? alarmsResp.rows : []);
    const todayRows  = Array.isArray(todayEnergyResp) ? todayEnergyResp : [];

    // Store for live refresh
    State.invDetailAlarmRows  = alarmRows;
    State.invDetailKwh = Number(todayRows.find((r) => Number(r.inverter) === inv)?.total_kwh || 0);

    renderInverterDetailStats(inv);
    renderInverterDetailAlarms(alarmRows);

    const reportResp = await reportReq;
    if (State.invDetailInv !== inv) return;
    const reportRows = Array.isArray(reportResp)
      ? reportResp
      : Array.isArray(reportResp?.rows)
        ? reportResp.rows
        : [];
    State.invDetailReportRows = reportRows;
    renderInverterDetailHistory(inv, reportRows);
    renderInverterDetailStats(inv);

    // Refresh kWh and availability every 60 s.
    // /api/report/daily?date=today recomputes the partial-day window live so
    // availability_pct stays accurate throughout the day.
    if (State.invDetailRefreshTimer) clearInterval(State.invDetailRefreshTimer);
    State.invDetailRefreshTimer = setInterval(async () => {
      const curInv = State.invDetailInv;
      if (!curInv) return;
      try {
        const [energyRows, reportRows] = await Promise.all([
          api(`/api/energy/today`).catch(() => null),
          apiWithTimeout(
            `/api/report/daily?date=${today()}`,
            10000,
            "Timed out while refreshing today's summary.",
          ).catch(() => null),
        ]);
        if (Array.isArray(energyRows)) {
          State.invDetailKwh = Number(energyRows.find((r) => Number(r.inverter) === curInv)?.total_kwh || 0);
        }
        if (Array.isArray(reportRows) && reportRows.length) {
          const todayKey = today();
          const others = State.invDetailReportRows.filter((r) => String(r.date || "") !== todayKey);
          State.invDetailReportRows = [...others, ...reportRows];
        }
        renderInverterDetailStats(curInv);
      } catch (_) { /* silent — stale values stay */ }
    }, 60000);
  } catch (err) {
    if (statsEl) statsEl.innerHTML = `<div class="inv-detail-stat"><span class="inv-detail-stat-label" style="color:var(--red)">Unable to load detail view: ${err.message}</span></div>`;
  } finally {
    State.invDetailLoading = false;
  }
}

function renderInverterDetailStats(inv) {
  const el = $("invDetailStats");
  if (!el) return;

  const todayStr = today();
  const now = Date.now();
  const liveTotalsByInv = buildFreshLiveTotalsByInverter(now);
  const liveTotals = liveTotalsByInv[inv] || { pac: 0, pdc: 0, kwh: 0 };

  // Today Energy — use server-authoritative per-inverter totals tracked from
  // /api/energy/today or WS todayEnergy rows so restart-safe persisted totals
  // are not replaced by the poller's volatile in-memory kWh counters.
  const kwh = Number((State.todayEnergyByInv[inv] ?? State.invDetailKwh) || 0);

  // DC Power — live from WS (not shown elsewhere; replaces redundant AC Output chip)
  const pdc = Number(liveTotals.pdc || 0);

  // Today Availability — from daily_report via 60s API poll (same source as exports)
  const todayReport = State.invDetailReportRows.find((r) => r.date === todayStr && r.inverter === inv);
  let availPct = null;
  if (todayReport) {
    const hasSomeData = Number(todayReport.uptime_s || 0) > 0 || Number(todayReport.kwh_total || 0) > 0;
    availPct = hasSomeData ? Number(todayReport.availability_pct ?? 0) : null;
  }

  // Active Nodes — live count of online nodes for this inverter
  const allInvKeys = Object.entries(State.liveData || {}).filter(([, d]) => Number(d?.inverter) === inv);
  const totalNodes =
    getConfiguredUnits(inv, Number(State.settings.nodeCount || 4)).length ||
    Number(State.settings.nodeCount || 4) ||
    4;
  const nodeCount = allInvKeys.filter(
    ([, d]) => d?.online && now - getLiveFreshTsClient(d) <= DATA_FRESH_MS,
  ).length;

  const chips = [
    { label: "Today Energy", value: kwh.toFixed(2),                unit: "kWh" },
    { label: "DC Power",     value: (pdc / 1000).toFixed(2),       unit: "kW"  },
    { label: "Today Availability", value: availPct !== null ? availPct.toFixed(1) : "—", unit: availPct !== null ? "%" : "" },
    { label: "Active Nodes", value: String(nodeCount),             unit: "/ " + totalNodes },
  ];

  el.innerHTML = chips.map((c) => `
    <div class="inv-detail-stat">
      <span class="inv-detail-stat-label">${c.label}</span>
      <span class="inv-detail-stat-value">${c.value}</span>
      <span class="inv-detail-stat-unit">${c.unit}</span>
    </div>`).join("");
}

function renderInverterDetailAlarms(alarmRows) {
  const el = $("invDetailAlarms");
  if (!el) return;

  const rows = alarmRows.slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 15);
  if (!rows.length) {
    el.innerHTML = `<div class="inv-detail-no-data">No alarm activity recorded today.</div>`;
    return;
  }

  const sevPill = (sev) => {
    const cls = sev === "critical" ? "sev-critical" : sev === "fault" ? "sev-fault" : sev === "warning" ? "sev-warning" : "sev-info";
    return `<span class="inv-detail-sev-pill ${cls}">${sev || "?"}</span>`;
  };

  const thead = `<tr><th>Time</th><th>Node</th><th>Code</th><th>Severity</th><th>Status</th></tr>`;
  const tbody = rows.map((r) => {
    const ts = fmtDateTime(Number(r.ts || r.occurred_ts || 0));
    const node = r.unit ? `N${r.unit}` : "—";
    const code = r.alarm_code ? String(r.alarm_code).toUpperCase() : "—";
    const status = r.cleared_ts
      ? `<span class="status-cleared">Closed</span>`
      : `<span class="status-active">Active</span>`;
    return `<tr><td title="${ts}">${ts.slice(11, 19)}</td><td>${node}</td><td class="mono">${code}</td><td>${sevPill(r.severity)}</td><td>${status}</td></tr>`;
  }).join("");

  el.innerHTML = `
    <table class="inv-detail-alarm-table">
      <thead>${thead}</thead>
    </table>
    <div class="inv-detail-alarm-scroll">
      <table class="inv-detail-alarm-table">
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

function renderInverterDetailHistory(inv, reportRows) {
  const el = $("invDetailHistory");
  if (!el) return;

  const rows = reportRows
    .filter((r) => r.inverter === inv)
    .sort((a, b) => (b.date > a.date ? 1 : -1));

  if (!rows.length) {
    el.innerHTML = `<div class="inv-detail-no-data">No recent daily summary is available.</div>`;
    return;
  }

  const fmtKw  = (w)   => (Number(w || 0) / 1000).toFixed(2);
  const fmtPct = (pct) => pct != null ? `${Number(pct).toFixed(1)}%` : "—";

  const thead = `<tr>
    <th>Date</th><th>kWh</th><th>Peak (kW)</th><th>Avg (kW)</th><th>Avail</th><th>Alarms</th>
  </tr>`;
  const tbody = rows.map((r) => `<tr>
    <td>${r.date}</td>
    <td>${Number(r.kwh_total || 0).toFixed(2)}</td>
    <td>${fmtKw(r.pac_peak)}</td>
    <td>${fmtKw(r.pac_avg)}</td>
    <td>${fmtPct(r.availability_pct)}</td>
    <td>${r.alarm_count ?? 0}</td>
  </tr>`).join("");

  el.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
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

function _clearWsReconnectTimer() {
  if (State.wsReconnectTimer) {
    clearTimeout(State.wsReconnectTimer);
    State.wsReconnectTimer = null;
  }
}

function connectWS() {
  if (State.wsConnecting) return;
  const current = State.ws;
  if (
    current &&
    (current.readyState === WebSocket.OPEN ||
      current.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  State.wsConnecting = true;
  _clearWsReconnectTimer();

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProto}://${location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  State.ws = ws;

  ws.onopen = () => {
    State.wsConnecting = false;
    resetTodayMwhAuthority();
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
    if (State.ws === ws) State.ws = null;
    resetTodayMwhAuthority();
    setWsState(false, "RECONNECT");
    const retries = ++State.wsRetries;
    const delay = Math.min(30000, Math.floor(500 * Math.pow(1.5, retries) + Math.random() * 500 * retries));
    const delaySeconds = Math.ceil(delay / 1000);
    showOfflineIndicator(true, `Reconnecting in ${delaySeconds}s...`);
    _clearWsReconnectTimer();
    State.wsReconnectTimer = setTimeout(() => {
      State.wsReconnectTimer = null;
      connectWS();
    }, delay);
  };

  ws.onerror = () => {
    State.wsConnecting = false;
    resetTodayMwhAuthority();
    showOfflineIndicator(true, "Connection lost. Retrying...");
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };
}

function handleWS(msg) {
  if (msg.type === "init" || msg.type === "live") {
    noteTodayMwhWsFrame(Date.now());
    if (
      State.modeTransition?.active &&
      normalizeOperationModeValue(State.modeTransition.targetMode) === "remote"
    ) {
      resolveModeTransitionLiveWaiters(msg);
    }
    if (msg.remoteHealth) applyRemoteHealthClient(msg.remoteHealth);
    if (msg.data) State.liveData = sanitizeLiveDataByConfig(msg.data);
    if (msg.totals) State.totals = msg.totals;
    integrateTodayFromPac();
    // Apply server-authoritative today energy from WS so the header metric
    // updates on every bridge tick without depending on the HTTP sync timer.
    if (Array.isArray(msg.todayEnergy)) {
      const now = Date.now();
      setTodayEnergyRowsClient(msg.todayEnergy);
      const totalKwh = msg.todayEnergy.reduce(
        (sum, r) => sum + Number(r?.total_kwh || 0), 0
      );
      noteTodayMwhWsEnergy(totalKwh, now);
      const applied = applySyncedTodayKwh(totalKwh, now, {
        source: "ws",
      });
      if (applied) renderTodayKwhFromPac();
      if (!msg.todaySummary || typeof msg.todaySummary !== "object") {
        applyCurrentDaySummaryClient(
          {
            day: today(),
            as_of_ts: now,
            total_kwh: totalKwh,
            total_mwh: totalKwh / 1000,
            inverter_count: Object.keys(State.todayEnergyByInv || {}).length,
          },
          { source: "ws-energy" },
        );
      }
    }
    if (msg.todaySummary && typeof msg.todaySummary === "object") {
      applyCurrentDaySummaryClient(msg.todaySummary, { source: "ws" });
    }
    if (msg.settings) {
      State.settings.inverterCount = msg.settings.inverterCount || 27;
      State.settings.plantName = msg.settings.plantName || "ADSI Plant";
      if ($("plantNameDisplay"))
        $("plantNameDisplay").textContent = State.settings.plantName;
    }
    if (msg.plantCap) {
      applyPlantCapStatusClient(msg.plantCap, { preservePreview: true });
    }
    scheduleInverterCardsUpdate();
    // Keep detail panel stat chips live on every WS tick
    if (State.invDetailInv > 0) renderInverterDetailStats(State.invDetailInv);
    syncAlarmStateFromLiveData().catch((err) => {
      console.warn("[app] live alarm sync failed:", err.message);
    });
  }
  if (msg.type === "remote_health") {
    applyRemoteHealthClient(msg.health || msg.remoteHealth || null);
    scheduleInverterCardsUpdate(true);
    if (State.currentPage === "settings") {
      refreshReplicationHealth(true).catch(() => {});
    }
  }
  if (msg.type === "plant_cap_status") {
    applyPlantCapStatusClient(msg.plantCap || null, { preservePreview: true });
  }
  if (msg.type === "configChanged") {
    const prevModeWs = State.settings.operationMode;
    Promise.all([loadSettings(), loadIpConfig()])
      .then(async () => {
        await handleOperationModeTransition(
          prevModeWs,
          State.settings.operationMode,
          "configChanged",
        );
        buildInverterGrid();
        scheduleInverterCardsUpdate(true);
      })
      .catch((err) => {
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
      if (Date.now() - getLiveFreshTsClient(d) <= 2000) return;
      d.online = 0;
      integrateTodayFromPac();
      scheduleInverterCardsUpdate();
    }
  }
  if (msg.type === "xfer_progress") {
    handleXferProgress(msg);
  }
  if (msg.type === "replication_job") {
    handleReplicationJobUpdate(msg.job || null);
  }
  if (msg.type === "chat") {
    handleIncomingChatMessage(msg.row);
  }
  if (msg.type === "chat_clear") {
    handleChatCleared();
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
      ts: Number(a.ts || Date.now()),
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

  syncAlarmSoundPlayback();
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
      <button class="toast-close" aria-label="Dismiss">✕</button>
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
    syncAlarmSoundPlayback();
    scheduleInverterCardsUpdate();
    return true;
  } catch (err) {
    console.warn("[app] refreshAlarmBadge failed:", err.message);
    return false;
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

function buildModeAwareQueryKey(parts = []) {
  const mode = getActiveOperationModeClient();
  return [mode, ...parts.map((part) => String(part ?? "").trim())].join("|");
}

function buildAlarmViewQueryKey() {
  const date = sanitizeDateInputValue($("alarmDate")?.value) || today();
  const inv = String($("alarmInv")?.value || "all").trim() || "all";
  return buildModeAwareQueryKey([date, inv]);
}

function buildEnergyViewQueryKey() {
  const date = sanitizeDateInputValue($("energyDate")?.value) || today();
  const inv = String($("energyInv")?.value || "all").trim() || "all";
  const resolution = String($("energyRes")?.value || "5min").trim() || "5min";
  return buildModeAwareQueryKey([date, inv, resolution]);
}

function buildAuditViewQueryKey() {
  const date = sanitizeDateInputValue($("auditDate")?.value) || today();
  const inv = String($("auditInv")?.value || "all").trim() || "all";
  return buildModeAwareQueryKey([date, inv]);
}

function buildReportViewQueryKey(dateOverride = "") {
  const date =
    sanitizeDateInputValue(dateOverride || $("reportDate")?.value) || today();
  return buildModeAwareQueryKey([date]);
}

// ─── Alarms Page ──────────────────────────────────────────────────────────────
function initAlarmsPage() {
  if (!$("alarmDate").value) $("alarmDate").value = today();
  if (!Number.isFinite(Number(State.alarmView.page)) || State.alarmView.page < 1) {
    State.alarmView.page = 1;
  }
  const queryKey = buildAlarmViewQueryKey();
  // Stale cache: skip fetch and re-render from State if data is fresh.
  if (
    State.alarmView.rows.length > 0 &&
    State.alarmView.queryKey === queryKey &&
    Date.now() - (State.tabFetchTs.alarms || 0) < TAB_STALE_MS
  ) {
    applyAlarmTableView();
    return;
  }
  fetchAlarms();
}

async function fetchAlarms(options = {}) {
  const force = options?.force === true;
  if (State.tabFetching.alarms && !force) return;
  State.tabFetching.alarms = true;
  const reqId = (State.alarmReqId || 0) + 1;
  State.alarmReqId = reqId;
  showTableLoading("alarmBody", 10);
  const inv = $("alarmInv").value;
  let date = sanitizeDateInputValue($("alarmDate")?.value);
  if (!date) {
    date = today();
    if ($("alarmDate")) $("alarmDate").value = date;
  }
  const startMs = localDateStartMs(date);
  const endMs = localDateEndMs(date);
  const qs = new URLSearchParams({
    start: String(startMs),
    end: String(endMs),
    ...(inv !== "all" ? { inverter: inv } : {}),
  });
  try {
    const raw = await api(`/api/alarms?${qs}`);
    if (reqId !== State.alarmReqId) return;
    const rows = Array.isArray(raw) ? raw : [];
    State.alarmView.rows = rows;
    State.alarmView.page = 1;
    State.alarmView.queryKey = buildAlarmViewQueryKey();
    State.tabFetchTs.alarms = Date.now();
    applyAlarmTableView();
    refreshAlarmBadge();
  } catch (e) {
    console.error("fetchAlarms:", e);
  } finally {
    if (reqId === State.alarmReqId) {
      State.tabFetching.alarms = false;
    }
  }
}

function applyAlarmTableView() {
  const allRows = Array.isArray(State.alarmView.rows) ? State.alarmView.rows : [];
  const pageData = paginateRows(allRows, State.alarmView.page, State.alarmView.pageSize);
  State.alarmView.page = pageData.page;
  renderAlarmTable(pageData.rows);
  const countEl = $("alarmCount");
  if (countEl) {
    countEl.textContent = `${pageData.from}-${pageData.to} / ${allRows.length} records`;
  }
  renderTablePager({
    hostId: "alarmPager",
    tbodyId: "alarmBody",
    page: pageData.page,
    pageSize: pageData.pageSize,
    totalRows: pageData.totalRows,
    onPageChange(nextPage) {
      State.alarmView.page = nextPage;
      applyAlarmTableView();
    },
  });
}

function renderAlarmTable(rows) {
  const tbody = $("alarmBody");
  if (!tbody) return;
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    tbody.textContent = "";
    renderEmptyRow(tbody, 10, "No alarm records for the selected date.");
    return;
  }
  const frag = document.createDocumentFragment();
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
      : `<button class="ack-btn" data-alarm-id="${r.id}">ACK</button>`;
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
    frag.appendChild(tr);
  });
  tbody.textContent = "";
  tbody.appendChild(frag);
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
    showToast("ACK failed: " + e.message, "fault", 5000);
  }
}

async function loadIpConfig() {
  try {
    const cfg = await api("/api/ip-config");
    State.ipConfig = cfg && typeof cfg === "object" ? cfg : null;
    renderPlantCapClientWarnings();
    renderPlantCapPanel();
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
  const unitsObj =
    cfg.units && typeof cfg.units === "object" ? cfg.units : null;
  const hasEntry =
    !!unitsObj &&
    (Object.prototype.hasOwnProperty.call(unitsObj, inv) ||
      Object.prototype.hasOwnProperty.call(unitsObj, String(inv)));
  const unitsRaw = hasEntry
    ? unitsObj?.[inv] ?? unitsObj?.[String(inv)] ?? []
    : Array.from({ length: nodeCount }, (_, i) => i + 1);
  const units = Array.isArray(unitsRaw)
    ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
    : Array.from({ length: nodeCount }, (_, i) => i + 1);
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
  if (!await appConfirm("Acknowledge All Alarms", "Acknowledge all active alarms that have not yet been acknowledged?", { ok: "Acknowledge All" })) return;
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
    showToast("ACK ALL failed: " + e.message, "fault", 5000);
  }
}

// ─── Energy Page ──────────────────────────────────────────────────────────────
function initEnergyPage() {
  if (!$("energyDate").value) $("energyDate").value = today();
  if (!Number.isFinite(Number(State.energyView.page)) || State.energyView.page < 1) {
    State.energyView.page = 1;
  }
  const queryKey = buildEnergyViewQueryKey();
  // Stale cache: skip fetch and re-render from State if data is fresh.
  if (
    State.energyView.rows.length > 0 &&
    State.energyView.queryKey === queryKey &&
    Date.now() - (State.tabFetchTs.energy || 0) < TAB_STALE_MS
  ) {
    renderEnergyTable(State.energyView.rows);
    if (State.energyView.summary) {
      renderEnergySummaryFromStats(State.energyView.summary);
    } else {
      renderEnergySummary(State.energyView.rows);
    }
    return;
  }
  fetchEnergy({ page: State.energyView.page });
}

async function fetchEnergy(options = {}) {
  const force = options?.force === true;
  if (State.tabFetching.energy && !force) return;
  State.tabFetching.energy = true;
  const reqId = (State.energyReqId || 0) + 1;
  State.energyReqId = reqId;
  const inv = $("energyInv").value;
  let date = sanitizeDateInputValue($("energyDate")?.value);
  if (!date) {
    date = today();
    if ($("energyDate")) $("energyDate").value = date;
  }
  const sTs = localDateStartMs(date);
  const eTs = localDateEndMs(date);
  const requestedPage = Math.max(
    1,
    Math.trunc(Number(options?.page ?? State.energyView.page) || 1),
  );
  const pageSize = Math.max(
    100,
    Math.trunc(Number(State.energyView.pageSize || 500)),
  );
  const offset = (requestedPage - 1) * pageSize;
  const qs = new URLSearchParams({
    start: sTs,
    end: eTs,
    paged: "1",
    limit: String(pageSize),
    offset: String(offset),
    ...(inv !== "all" ? { inverter: inv } : {}),
  });
  try {
    const raw = await api(`/api/energy/5min?${qs}`);
    if (reqId !== State.energyReqId) return;
    const serverPaged = !Array.isArray(raw) && Array.isArray(raw?.rows);
    const fullRows = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.rows)
        ? raw.rows
        : [];
    const totalRowsRaw = Math.max(
      fullRows.length,
      Math.trunc(Number(raw?.total ?? fullRows.length) || fullRows.length),
    );
    let rows = fullRows;
    let safePage = requestedPage;
    if (!serverPaged) {
      const sliced = paginateRows(fullRows, requestedPage, pageSize);
      rows = sliced.rows;
      safePage = sliced.page;
    } else {
      const totalPages = Math.max(1, Math.ceil(totalRowsRaw / pageSize));
      safePage = Math.min(totalPages, requestedPage);
    }
    const totalRows = totalRowsRaw;
    State.energyView.page = safePage;
    State.energyView.totalRows = totalRows;
    State.energyView.rows = rows;
    State.energyView.summary =
      raw?.summary && typeof raw.summary === "object" ? raw.summary : null;
    State.energyView.serverPaged = serverPaged;
    State.energyView.queryKey = buildEnergyViewQueryKey();
    State.tabFetchTs.energy = Date.now();
    renderEnergyTable(rows);
    if (State.energyView.summary) {
      renderEnergySummaryFromStats(State.energyView.summary);
    } else {
      renderEnergySummary(serverPaged ? rows : fullRows);
    }
    const countEl = $("energyCount");
    if (countEl) {
      const from = totalRows ? (safePage - 1) * pageSize + 1 : 0;
      const to = totalRows ? Math.min(totalRows, safePage * pageSize) : 0;
      countEl.textContent = `${from}-${to} / ${totalRows} interval records`;
    }
    renderTablePager({
      hostId: "energyPager",
      tbodyId: "energyBody",
      page: safePage,
      pageSize,
      totalRows,
      onPageChange(nextPage) {
        fetchEnergy({ page: nextPage }).catch((err) => {
          console.warn("energy page change failed:", err?.message || err);
        });
      },
    });
  } catch (e) {
    console.error("fetchEnergy:", e);
  } finally {
    if (reqId === State.energyReqId) {
      State.tabFetching.energy = false;
    }
  }
}

function renderEnergyTable(rows) {
  const tbody = $("energyBody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.textContent = "";
    renderEmptyRow(
      tbody,
      4,
      "No 5-minute energy records for the selected date.",
    );
    return;
  }
  const ordered = State.energyView.serverPaged
    ? rows
    : [...rows].sort(
        (a, b) =>
          Number(b.ts || 0) - Number(a.ts || 0) ||
          Number(a.inverter || 0) - Number(b.inverter || 0),
      );
  const frag = document.createDocumentFragment();
  ordered.forEach((r) => {
    const dt = new Date(r.ts);
    const tr = el("tr");
    tr.innerHTML = `
      <td>${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}</td>
      <td>${pad2(dt.getHours())}:${pad2(dt.getMinutes())}</td>
      <td>INV-${String(r.inverter).padStart(2, "0")}</td>
      <td>${fmtMWh(Number(r.kwh_inc || 0), 6)}</td>`;
    frag.appendChild(tr);
  });
  tbody.textContent = "";
  tbody.appendChild(frag);
}

function renderEnergySummaryFromStats(summary) {
  const setText = (id, v) => {
    const node = $(id);
    if (node) node.textContent = v;
  };
  const stats = summary && typeof summary === "object" ? summary : null;
  if (!stats) {
    renderEnergySummary(State.energyView.rows);
    return;
  }
  const totalKwh = Number(stats.totalKwh || 0);
  const rowCount = Math.max(0, Number(stats.rowCount || 0));
  const avgKwh = rowCount > 0 ? totalKwh / rowCount : 0;
  const peak = stats.peak && typeof stats.peak === "object" ? stats.peak : {};
  const peakKwh = Number(peak.kwhInc || 0);
  const peakInv = Number(peak.inverter || 0);
  const peakTs = Number(peak.ts || 0);
  const invCount = Math.max(0, Number(stats.inverterCount || 0));
  const latestTs = Number(stats.latestTs || 0);

  setText("energyTotalMwh", `${fmtMWh(totalKwh, 6)} MWh`);
  setText("energyAvgMwh", `${fmtMWh(avgKwh, 6)} MWh`);
  setText("energyPeakMwh", `${fmtMWh(peakKwh, 6)} MWh`);
  setText(
    "energyPeakMeta",
    peakTs && peakInv
      ? `INV-${String(peakInv).padStart(2, "0")} @ ${fmtDateTime(peakTs)}`
      : "—",
  );
  setText("energyInvCount", String(invCount));
  setText("energyLastTs", latestTs ? fmtDateTime(latestTs) : "—");
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
  if (!$("auditDate").value) $("auditDate").value = today();
  const queryKey = buildAuditViewQueryKey();
  // Stale cache: skip fetch and re-render from State if data is fresh.
  if (
    State.auditView.rows.length > 0 &&
    State.auditView.queryKey === queryKey &&
    Date.now() - (State.tabFetchTs.audit || 0) < TAB_STALE_MS
  ) {
    applyAuditTableView();
    return;
  }
  fetchAudit();
}

async function fetchAudit(options = {}) {
  const force = options?.force === true;
  if (State.tabFetching.audit && !force) return;
  State.tabFetching.audit = true;
  const reqId = (State.auditReqId || 0) + 1;
  State.auditReqId = reqId;
  showTableLoading("auditBody", 8);
  const inv = $("auditInv").value;
  let date = sanitizeDateInputValue($("auditDate")?.value);
  if (!date) {
    date = today();
    if ($("auditDate")) $("auditDate").value = date;
  }
  const startMs = localDateStartMs(date);
  const endMs = localDateEndMs(date);
  const qs = new URLSearchParams({
    start: String(startMs),
    end: String(endMs),
    limit: "5000",
    ...(inv !== "all" ? { inverter: inv } : {}),
  });
  try {
    const rows = await api(`/api/audit?${qs}`);
    if (reqId !== State.auditReqId) return;
    State.auditView.rows = Array.isArray(rows) ? rows : [];
    State.auditView.page = 1;
    State.auditView.queryKey = buildAuditViewQueryKey();
    State.tabFetchTs.audit = Date.now();
    applyAuditTableView();
  } catch (e) {
    console.error("fetchAudit:", e);
  } finally {
    if (reqId === State.auditReqId) {
      State.tabFetching.audit = false;
    }
  }
}

function renderAuditTable(rows) {
  const tbody = $("auditBody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.textContent = "";
    renderEmptyRow(tbody, 8, "No audit records for the selected date.");
    return;
  }
  const frag = document.createDocumentFragment();
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
    frag.appendChild(tr);
  });
  tbody.textContent = "";
  tbody.appendChild(frag);
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
    f.addEventListener("input", () => {
      State.auditView.page = 1;
      applyAuditTableViewDebounced();
    });
    f.addEventListener("change", () => {
      State.auditView.page = 1;
      applyAuditTableView();
    });
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

  const pageData = paginateRows(
    filtered,
    State.auditView.page,
    State.auditView.pageSize,
  );
  State.auditView.page = pageData.page;
  renderAuditTable(pageData.rows);
  renderAuditSortIndicators();
  const auditCountEl = $("auditCount");
  if (auditCountEl) {
    auditCountEl.textContent = `${pageData.from}-${pageData.to} / ${filtered.length} filtered (${allRows.length} total)`;
  }
  renderTablePager({
    hostId: "auditPager",
    tbodyId: "auditBody",
    page: pageData.page,
    pageSize: pageData.pageSize,
    totalRows: pageData.totalRows,
    onPageChange(nextPage) {
      State.auditView.page = nextPage;
      applyAuditTableView();
    },
  });
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
  State.auditView.page = 1;
  applyAuditTableView();
}

// ─── Daily Report Page ────────────────────────────────────────────────────────
function initReportPage() {
  setupReportTableControls();
  if (!$("reportDate").value) {
    $("reportDate").value = today();
    queuePersistExportUiState();
  }
  // Stale cache: skip fetch and re-render from State if data is fresh.
  if (
    State.reportView.rows.length > 0 &&
    State.reportView.queryKey === buildReportViewQueryKey() &&
    Date.now() - (State.tabFetchTs.report || 0) < TAB_STALE_MS
  ) {
    applyReportTableView();
    return;
  }
  fetchReport();
}

async function fetchReport(options = {}) {
  const force = options?.force === true;
  if (State.tabFetching.report && !force) return;
  State.tabFetching.report = true;
  const reqId = (State.reportReqId || 0) + 1;
  State.reportReqId = reqId;
  showTableLoading("reportBody", 14);
  let date = sanitizeDateInputValue($("reportDate")?.value);
  if (!date) {
    date = today();
    if ($("reportDate")) $("reportDate").value = date;
  }
  queuePersistExportUiState();
  try {
    let rows = [];
    let summary = null;
    try {
      const payload = await api(`/api/report/payload?date=${encodeURIComponent(date)}`);
      if (reqId !== State.reportReqId) return;
      rows = Array.isArray(payload?.rows) ? payload.rows : [];
      summary = payload?.summary && typeof payload.summary === "object" ? payload.summary : null;
      const finalDate = String(payload?.date || "").trim();
      if (payload?.fallbackUsed && finalDate && finalDate !== date) {
        $("reportDate").value = finalDate;
        showToast(
          `No report rows for ${date}. Showing latest available date: ${finalDate}.`,
          "warning",
          3800,
        );
      }
    } catch (payloadErr) {
      console.warn("fetchReport payload:", payloadErr?.message || payloadErr);
      rows = await api(`/api/report/daily?date=${date}`);
      if (reqId !== State.reportReqId) return;
      if ((!Array.isArray(rows) || rows.length === 0) && date) {
        try {
          const latest = await api("/api/report/latest-date");
          if (reqId !== State.reportReqId) return;
          const latestDate = String(latest?.latestDate || "").trim();
          if (latestDate && latestDate !== date) {
            $("reportDate").value = latestDate;
            rows = await api(`/api/report/daily?date=${latestDate}`);
            if (reqId !== State.reportReqId) return;
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
      summary = await fetchReportSummary($("reportDate").value || date, {
        requestId: reqId,
      });
    }
    if (reqId !== State.reportReqId) return;
    State.reportView.rows = Array.isArray(rows) ? rows.map((r) => toReportViewRow(r)) : [];
    State.reportView.summary = summary;
    State.reportView.page = 1;
    State.reportView.queryKey = buildReportViewQueryKey();
    State.tabFetchTs.report = Date.now();
    applyReportTableView();
    renderReportKpis();
  } catch (e) {
    if (reqId !== State.reportReqId) return;
    console.error("fetchReport:", e);
    State.reportView.rows = [];
    State.reportView.summary = null;
    State.reportView.queryKey = buildReportViewQueryKey();
    applyReportTableView();
    renderReportKpis();
    showToast(`Report load failed: ${e.message}`, "error", 4200);
  } finally {
    if (reqId === State.reportReqId) {
      State.tabFetching.report = false;
    }
  }
}

async function fetchReportSummary(date, options = {}) {
  const requestId = Number(options?.requestId || 0);
  try {
    const summary = await api(`/api/report/summary?date=${date}`);
    if (requestId > 0 && requestId !== State.reportReqId) {
      return null;
    }
    State.reportView.summary =
      summary && typeof summary === "object" ? summary : null;
    if (sanitizeDateInputValue(date) === today()) {
      const currentDaySummary = extractCurrentDaySummary(summary);
      if (currentDaySummary) {
        applyCurrentDaySummaryClient(summary, { source: "report-summary" });
      }
      const totalKwh = Number(summary?.daily?.total_kwh);
      if (Number.isFinite(totalKwh)) {
        const applied = applySyncedTodayKwh(totalKwh, Date.now(), {
          source: "report",
        });
        if (applied) renderTodayKwhFromPac();
      }
    }
  } catch (e) {
    if (requestId > 0 && requestId !== State.reportReqId) {
      return null;
    }
    console.warn("fetchReportSummary:", e?.message || e);
    State.reportView.summary = null;
  }
  if (requestId > 0 && requestId !== State.reportReqId) {
    return null;
  }
  renderReportKpis();
  return State.reportView.summary;
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

function getReportRatedKwClient(row) {
  const explicit = Number(row?.rated_kw);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const expectedNodes = Number(row?.expected_nodes);
  if (Number.isFinite(expectedNodes) && expectedNodes > 0) {
    return (INV_RATED_KW * Math.min(MAX_INV_UNITS, expectedNodes)) / MAX_INV_UNITS;
  }
  return INV_RATED_KW;
}

function calcReportPerformancePctClient(row) {
  const explicit = Number(row?.performance_pct);
  if (Number.isFinite(explicit)) return clampPctClient(explicit);
  const kwh = Number(row?.kwh_total || 0);
  const uph =
    Number(row?.uptime_h || 0) || (Number(row?.uptime_s || 0) / 3600);
  const denom = getReportRatedKwClient(row) * Math.max(0, uph);
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
  const avail = Math.round(availabilityPct);
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
    expected_nodes: Number(r?.expected_nodes || 0),
    rated_kw: Number(r?.rated_kw || getReportRatedKwClient(r)),
    avail,
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
    "reportFilterAvail",
    "reportFilterPerf",
  ].forEach((id) => {
    const f = $(id);
    if (!f || f.dataset.bound === "1") return;
    f.dataset.bound = "1";
    f.addEventListener("input", () => {
      State.reportView.page = 1;
      applyReportTableViewDebounced();
    });
    f.addEventListener("change", () => {
      State.reportView.page = 1;
      applyReportTableView();
    });
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
    avail: getVal("reportFilterAvail").toLowerCase(),
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
    key === "availability_pct" ||
    key === "performance_pct" ||
    key === "avail" ||
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
      f.avail &&
      !String(Number(r.availability_pct || 0).toFixed(1))
        .toLowerCase()
        .includes(f.avail)
    )
      return false;
    if (
      f.perf &&
      !String(Number(r.performance_pct || 0).toFixed(1))
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

  const pageData = paginateRows(
    filtered,
    State.reportView.page,
    State.reportView.pageSize,
  );
  State.reportView.page = pageData.page;
  renderReportTable(pageData.rows, allRows.length);
  renderReportSortIndicators();
  renderReportKpis();
  renderTablePager({
    hostId: "reportPager",
    tbodyId: "reportBody",
    page: pageData.page,
    pageSize: pageData.pageSize,
    totalRows: pageData.totalRows,
    onPageChange(nextPage) {
      State.reportView.page = nextPage;
      applyReportTableView();
    },
  });
}

function renderReportTable(rows, totalRows = rows.length) {
  const tbody = $("reportBody");
  if (!tbody) return;
  if (!rows.length) {
    const msg =
      Number(totalRows || 0) > 0
        ? "No rows match current report filters."
        : "No daily report rows for this date.";
    tbody.textContent = "";
    renderEmptyRow(tbody, 8, msg);
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach((r) => {
    const mwh = Number(r.mwh || 0);
    const peak = Number(r.peak_kw || 0);
    const avg = Number(r.avg_kw || 0);
    const uph = Number(r.uptime_h || 0);
    const avail = Number(r.availability_pct || 0);
    const perf = Number(r.performance_pct || 0);

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
          <div class="perf-track"><div class="perf-fill ${avail > 80 ? "perf-fill-good" : avail > 50 ? "perf-fill-warn" : "perf-fill-poor"}" style="width:${avail}%"></div></div>
          <span>${avail.toFixed(1)}%</span>
        </div>
      </td>
      <td>
        <div class="perf-bar">
          <div class="perf-track"><div class="perf-fill ${perf > 80 ? "perf-fill-good" : perf > 50 ? "perf-fill-warn" : "perf-fill-poor"}" style="width:${perf}%"></div></div>
          <span>${perf.toFixed(1)}%</span>
        </div>
      </td>`;
    frag.appendChild(tr);
  });
  tbody.textContent = "";
  tbody.appendChild(frag);
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
    const denom = (getReportRatedKwClient(r) * uph) / 1000; // rated kW*h -> MWh
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
    showToast("Saved to: " + r.path, "success", 5000);
    await openExportPathFolder(r.path);
    setExportButtonState("btnExportDailyReport", "ok");
  } catch (e) {
    showToast("Export error: " + e.message, "fault", 5000);
    setExportButtonState("btnExportDailyReport", "fail");
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────
function initAnalytics() {
  if (!$("anaDate").value) $("anaDate").value = today();
  if ($("anaInterval") && !$("anaInterval").value) $("anaInterval").value = "5";
  // Render cached data immediately so the tab feels instant on revisit,
  // then kick off a fresh fetch in the background.
  if (State.analyticsBaseRows.length > 0) renderAnalyticsFromState();
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
  const { startTs: sTs, endTs: eTs } = getAnalyticsSolarWindowBounds(date);
  try {
    const qs = new URLSearchParams({
      date,
      start: sTs,
      end: eTs,
      bucketMin: String(intervalMin),
    });
    let rows = [];
    let dayAheadRows = [];
    let dailySummary = null;
    try {
      [rows, dayAheadRows, dailySummary] = await Promise.all([
        api(`/api/analytics/energy?${qs}`),
        api(`/api/analytics/dayahead?${qs}`).catch(() => []),
        api(`/api/report/summary?date=${encodeURIComponent(date)}`).catch(
          () => null,
        ),
      ]);
    } catch (err) {
      if (isClientModeActive()) throw err;
      // Backward fallback for older backend versions.
      console.warn("[app] analytics v2 endpoint failed, using legacy:", err.message);
      rows = await api(`/api/energy/5min?${qs}`);
      dayAheadRows = [];
      dailySummary = null;
    }
    if (reqId !== State.analyticsReqId) return;
    const bucketed = aggregateEnergyRows(rows, intervalMin);
    const dayAheadBucketed = aggregateForecastRows(dayAheadRows, intervalMin);
    State.analyticsBaseRows = bucketed;
    State.analyticsDayAheadBaseRows = dayAheadBucketed;
    State.analyticsIntervalMin = intervalMin;
    const currentDaySummary = extractCurrentDaySummary(dailySummary);
    State.analyticsDailyTotalMwh =
      currentDaySummary && currentDaySummary.day === date
        ? Number(currentDaySummary.totalMwh.toFixed(6))
        : Number.isFinite(Number(dailySummary?.daily?.total_mwh))
          ? Number(Number(dailySummary?.daily?.total_mwh).toFixed(6))
          : null;
    if (currentDaySummary) {
      applyCurrentDaySummaryClient(dailySummary, { source: "analytics-load" });
    }
    State.analyticsActualSummarySyncAt = Date.now();
    State.analyticsActualSummarySyncDay = date;
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
    const fresh = d?.online && now - getLiveFreshTsClient(d) <= DATA_FRESH_MS;
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

  // Cache dayahead aggregation — the source rows only change on a full fetch
  // (every 60 s or on tab switch), so re-aggregating on every 2-s realtime tick
  // is redundant. Invalidate by object-reference + interval.
  const daSrc = State.analyticsDayAheadBaseRows;
  const cache = State.analyticsDayAheadCache;
  let dayAheadRows;
  if (cache && cache.src === daSrc && cache.intervalMin === intervalMin) {
    dayAheadRows = cache.result;
  } else {
    dayAheadRows = aggregateForecastRows(daSrc, intervalMin);
    State.analyticsDayAheadCache = { src: daSrc, intervalMin, result: dayAheadRows };
  }

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
  State.analyticsLastPacSig = ""; // reset so the first tick always renders
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
    // Build a cheap live-PAC signature. Skip re-render when no inverter data
    // has changed since the last tick — avoids rebuilding 28 chart datasets
    // every 2 s when power output is stable.
    let s = 0;
    const now = Date.now();
    Object.values(State.liveData || {}).forEach((d) => {
      if (d?.online && now - getLiveFreshTsClient(d) <= DATA_FRESH_MS) {
        s += Number(d.pac || 0) * Number(d.inverter || 0);
      }
    });
    const actualSig = Number(State.analyticsDailyTotalMwh || 0).toFixed(6);
    const sig = `${s.toFixed(0)}|${State.analyticsIntervalMin}|${actualSig}`;
    if (sig === State.analyticsLastPacSig) return;
    State.analyticsLastPacSig = sig;
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
  if (State.analyticsRenderTimer) {
    clearTimeout(State.analyticsRenderTimer);
    State.analyticsRenderTimer = null;
  }
  State.analyticsRenderToken = Number(State.analyticsRenderToken || 0) + 1;
  Object.values(State.charts || {}).forEach((chart) => {
    try {
      chart?.destroy?.();
    } catch (err) {
      console.warn("[app] chart destroy failed:", err.message);
    }
  });
  State.charts = {};
}

function scheduleAnalyticsChartRender(step) {
  if (State.analyticsRenderTimer) {
    clearTimeout(State.analyticsRenderTimer);
    State.analyticsRenderTimer = null;
  }
  State.analyticsRenderTimer = setTimeout(() => {
    State.analyticsRenderTimer = null;
    step();
  }, 0);
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
  const sig = String(count);
  if (
    host.dataset.sig === sig &&
    existingCanvasCount === expectedCanvasCount &&
    hasSideCard
  ) {
    return;
  }

  destroyAnalyticsCharts();
  host.innerHTML = "";
  host.dataset.sig = sig;

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
        <label for="genDayCount" class="analytics-gen-field">
          <span class="analytics-gen-label">Days</span>
          <input
            type="number"
            id="genDayCount"
            class="inp analytics-gen-input"
            min="1"
            max="31"
            step="1"
            value="1"
          />
        </label>
        <label for="anaDayAheadExportFormat" class="analytics-gen-field analytics-gen-field-format">
          <span class="analytics-gen-label">Format</span>
          <select id="anaDayAheadExportFormat" class="sel analytics-gen-select">
            <option value="standard">Standard</option>
            <option value="average-table">Average Table</option>
          </select>
        </label>
        <div class="analytics-gen-actions">
          <button
            id="btnDayAheadGenerate"
            class="btn btn-accent analytics-gen-btn"
            type="button"
            title="Generate day-ahead forecast from the selected date."
          >
            Generate
          </button>
          <button
            id="btnDayAheadExport"
            class="btn btn-outline analytics-gen-btn analytics-gen-export-btn"
            type="button"
            title="Export day-ahead vs actual for the selected date and chart interval."
          >
            Export
          </button>
        </div>
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
  const analyticsFormatSel = totalSideCard.querySelector("#anaDayAheadExportFormat");
  if (analyticsFormatSel) {
    analyticsFormatSel.value = getSharedForecastExportFormat();
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

function renderAnalyticsInverterCharts(
  count,
  labels,
  mergedTimeline,
  byInv,
  fillPastMissingAsZero,
  pastCutoffTs,
) {
  if (State.analyticsRenderTimer) {
    clearTimeout(State.analyticsRenderTimer);
    State.analyticsRenderTimer = null;
  }
  State.analyticsRenderToken = Number(State.analyticsRenderToken || 0) + 1;
  const token = State.analyticsRenderToken;
  const jobs = [];

  for (let inv = 1; inv <= count; inv++) {
    jobs.push(() => {
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
    });
  }

  let index = 0;
  const runBatch = () => {
    if (token !== Number(State.analyticsRenderToken || 0)) return;
    const limit = Math.min(jobs.length, index + ANALYTICS_CHART_RENDER_BATCH);
    while (index < limit) {
      jobs[index]();
      index += 1;
    }
    if (index < jobs.length) {
      scheduleAnalyticsChartRender(runBatch);
    }
  };

  runBatch();
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
  const count = Number(State.settings.inverterCount || 27);
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

  renderAnalyticsInverterCharts(
    count,
    labels,
    mergedTimeline,
    byInv,
    fillPastMissingAsZero,
    pastCutoffTs,
  );
  renderAnalyticsSummary(
    rows,
    intervalMin,
    totalValues,
    mergedTimeline,
    dayAheadValues,
  );
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
  const computedTotalMwh = Number(
    numericTotalValues.reduce((s, v) => s + Number(v || 0), 0).toFixed(6),
  );
  const summaryMwh = Number(State.analyticsDailyTotalMwh);
  const totalMwh =
    Number.isFinite(summaryMwh) && summaryMwh >= 0
      ? Number(summaryMwh.toFixed(6))
      : computedTotalMwh;
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
  const { startTs, endTs } = getAnalyticsSolarWindowBounds(d);
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
  const chartType = getChartTypography();
  const uiFont = cssVar("--font-main", "Arial");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    spanGaps: true,
    plugins: {
      legend: {
        display: !!showLegend,
        labels: {
          color: pal.legend,
          font: { family: uiFont, size: chartType.legend, weight: "600" },
          boxWidth: chartType.legendBoxWidth,
          boxHeight: chartType.legendBoxHeight,
          padding: chartType.legendPadding,
        },
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
          font: { family: uiFont, size: chartType.tickX, weight: "500" },
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
        ticks: { color: pal.tick, font: { family: uiFont, size: chartType.tickY, weight: "500" } },
        grid: { color: pal.grid },
        title: {
          display: true,
          text: unit,
          color: pal.tick,
          font: { family: uiFont, size: chartType.axis, weight: "600" },
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
  syncSharedForecastExportFormatControls(getSharedForecastExportFormat());
  bindExportDateValidators();
  bindExportNumberValidators();
  normalizeAllExportDateInputs({ forceDefault: true, preferred: "start" });
  normalizeExportNumberInput("genDayCount");
  normalizeExportNumberInput("expInvDataInterval");
  [
    "btnCancelAlarmExport",
    "btnCancelEnergyExport",
    "btnCancelForecastExport",
    "btnCancelInvDataExport",
    "btnCancelAuditExport",
    "btnCancelDailyReportExport",
  ].forEach((id) => setExportCancelButtonState(id, !!State.exportAbortControllers[id]));
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

function setExportCancelButtonState(btnId, active = false) {
  const btn = $(btnId);
  if (!btn) return;
  btn.disabled = !active;
  btn.classList.toggle("btn-red", active);
  btn.classList.toggle("btn-outline", !active);
}

function registerExportAbortController(btnId, controller) {
  if (!btnId || !controller) return;
  State.exportAbortControllers[btnId] = controller;
  setExportCancelButtonState(btnId, true);
}

function releaseExportAbortController(btnId) {
  if (!btnId) return;
  delete State.exportAbortControllers[btnId];
  setExportCancelButtonState(btnId, false);
}

function requestExportCancellation(btnId, resultId) {
  const controller = State.exportAbortControllers[btnId];
  if (!controller) return;
  const res = $(resultId);
  if (res) {
    res.className = "exp-result";
    res.textContent = "Cancelling…";
  }
  setExportCancelButtonState(btnId, false);
  controller.abort();
}

function isExportCancelledError(err) {
  return String(err?.message || "").trim().toLowerCase() === "export cancelled.";
}

async function runExport(
  type,
  invId,
  startId,
  endId,
  resultId,
  extraBody = {},
  btnId = "",
  cancelBtnId = "",
) {
  normalizeExportDatePair(startId, endId, {
    forceDefault: true,
    preferred: "start",
  });
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
  const controller = new AbortController();
  registerExportAbortController(cancelBtnId, controller);
  const startTs = start ? localDateStartMs(start) : undefined;
  const endTs = end ? localDateEndMs(end) : undefined;
  const body = { inverter: inv, startTs, endTs, format, ...extraBody };
  try {
    const r = await api(`/api/export/${type}`, "POST", body, {
      signal: controller.signal,
    });
    if (res) {
      res.className = "exp-result";
      res.textContent = "✔ Saved: " + r.path;
    }
    await openExportPathFolder(r.path);
    setExportButtonState(btnId, "ok");
  } catch (e) {
    if (isExportCancelledError(e)) {
      if (res) {
        res.className = "exp-result";
        res.textContent = "Cancelled.";
      }
      setExportButtonState(btnId, "idle");
    } else {
      if (res) {
        res.className = "exp-result error";
        res.textContent = "✗ " + e.message;
      }
      setExportButtonState(btnId, "fail");
    }
  } finally {
    releaseExportAbortController(cancelBtnId);
  }
}

async function runSingleDateExport(
  type,
  invId,
  dateId,
  resultId,
  extraBody = {},
  btnId = "",
  cancelBtnId = "",
) {
  normalizeExportSingleDateInput(dateId, { forceDefault: true });
  await persistExportUiState().catch(() => {});
  const dateInput = $(dateId);
  const day = dateInput?.value || today();
  if (dateInput && !dateInput.value) dateInput.value = day;
  const inv = invId ? $(invId)?.value : undefined;
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
  const controller = new AbortController();
  registerExportAbortController(cancelBtnId, controller);
  const startTs = localDateStartMs(day);
  const endTs = localDateEndMs(day);
  const body = {
    ...(invId ? { inverter: inv } : {}),
    startTs,
    endTs,
    format,
    ...extraBody,
  };
  try {
    const r = await api(`/api/export/${type}`, "POST", body, {
      signal: controller.signal,
    });
    if (res) {
      res.className = "exp-result";
      res.textContent = "✔ Saved: " + r.path;
    }
    await openExportPathFolder(r.path);
    setExportButtonState(btnId, "ok");
  } catch (e) {
    if (isExportCancelledError(e)) {
      if (res) {
        res.className = "exp-result";
        res.textContent = "Cancelled.";
      }
      setExportButtonState(btnId, "idle");
    } else {
      if (res) {
        res.className = "exp-result error";
        res.textContent = "✗ " + e.message;
      }
      setExportButtonState(btnId, "fail");
    }
  } finally {
    releaseExportAbortController(cancelBtnId);
  }
}

async function runEnergyExport() {
  normalizeExportSingleDateInput("expEnergyDate", { forceDefault: true });
  await persistExportUiState().catch(() => {});
  const day = $("expEnergyDate")?.value || today();
  if (!$("expEnergyDate")?.value && $("expEnergyDate")) $("expEnergyDate").value = day;
  const inv = $("expEnergyInv")?.value;
  const format = $("expEnergyFormat")?.value || "xlsx";
  const res = $("expEnergyResult");
  if (res) {
    res.className = "exp-result";
    res.textContent = "Exporting…";
  }
  setExportButtonState("btnRunEnergyExport", "loading");
  const controller = new AbortController();
  registerExportAbortController("btnCancelEnergyExport", controller);
  try {
    const startTs = localDateStartMs(day);
    const endTs = localDateEndMs(day);
    const r = await api("/api/export/energy", "POST", {
      inverter: inv,
      startTs,
      endTs,
      format,
    }, {
      signal: controller.signal,
    });
    if (res) {
      res.className = "exp-result";
      res.textContent = "✔ Saved: " + r.path;
    }
    await openExportPathFolder(r.path);
    setExportButtonState("btnRunEnergyExport", "ok");
  } catch (e) {
    if (isExportCancelledError(e)) {
      if (res) {
        res.className = "exp-result";
        res.textContent = "Cancelled.";
      }
      setExportButtonState("btnRunEnergyExport", "idle");
    } else {
      if (res) {
        res.className = "exp-result error";
        res.textContent = "✗ " + e.message;
      }
      setExportButtonState("btnRunEnergyExport", "fail");
    }
  } finally {
    releaseExportAbortController("btnCancelEnergyExport");
  }
}

async function runForecastActualExport() {
  normalizeExportSingleDateInput("expForecastDate", { forceDefault: true });
  await persistExportUiState().catch(() => {});
  const day = $("expForecastDate")?.value;
  const exportFormat = getSharedForecastExportFormat();
  const format = exportFormat === "average-table"
    ? "xlsx"
    : ($("expForecastFormat")?.value || "xlsx");
  const resolution = $("expForecastResolution")?.value || "5min";
  const res = $("expForecastResult");
  if (res) {
    res.className = "exp-result";
    res.textContent = "Exporting…";
  }
  setExportButtonState("btnRunForecastExport", "loading");
  const controller = new AbortController();
  registerExportAbortController("btnCancelForecastExport", controller);
  const bounds = day ? getAnalyticsSolarWindowBounds(day) : null;
  const startTs = bounds?.startTs;
  const endTs = bounds?.endTs;
  try {
    const r = await api("/api/export/forecast-actual", "POST", {
      startTs,
      endTs,
      resolution,
      format,
      exportFormat,
    }, {
      signal: controller.signal,
    });
    if (res) {
      res.className = "exp-result";
      res.textContent =
        `✔ Saved: ${r.path}${exportFormat === "average-table" ? " (average table)" : " (standard)"}`;
    }
    await openExportPathFolder(r.path);
    setExportButtonState("btnRunForecastExport", "ok");
  } catch (e) {
    if (isExportCancelledError(e)) {
      if (res) {
        res.className = "exp-result";
        res.textContent = "Cancelled.";
      }
      setExportButtonState("btnRunForecastExport", "idle");
    } else {
      if (res) {
        res.className = "exp-result error";
        res.textContent = "✗ " + e.message;
      }
      setExportButtonState("btnRunForecastExport", "fail");
    }
  } finally {
    releaseExportAbortController("btnCancelForecastExport");
  }
}

function getAnalyticsForecastExportResolution() {
  const intervalMin = Number($("anaInterval")?.value || State.analyticsIntervalMin || 5);
  if (intervalMin === 15) return "15min";
  if (intervalMin === 30) return "30min";
  if (intervalMin === 60) return "1hr";
  return "5min";
}

async function runAnalyticsDayAheadExport() {
  const day = String($("anaDate")?.value || today()).trim();
  const res = $("genDayResult");
  const bounds = day ? getAnalyticsSolarWindowBounds(day) : null;
  const startTs = bounds?.startTs;
  const endTs = bounds?.endTs;
  const resolution = getAnalyticsForecastExportResolution();
  const exportFormat = getSharedForecastExportFormat();

  if (res) {
    res.className = "exp-result";
    res.textContent = "Exporting…";
  }

  try {
    const r = await api("/api/export/forecast-actual", "POST", {
      startTs,
      endTs,
      resolution,
      format: "xlsx",
      exportFormat,
    });
    if (res) {
      res.className = "exp-result";
      res.textContent = `✔ Exported ${day} (${resolution}${exportFormat === "average-table" ? ", average table" : ""})`;
    }
    await openExportPathFolder(r.path);
  } catch (e) {
    if (res) {
      res.className = "exp-result error";
      res.textContent = `✗ ${e.message}`;
    }
  }
}

async function runDayAheadGeneration() {
  if (isClientModeActive()) {
    const resBlocked = $("genDayResult");
    if (resBlocked) {
      resBlocked.className = "exp-result error";
      resBlocked.textContent =
        "✗ Unavailable in Remote mode. Run day-ahead generation from the gateway workstation.";
    }
    showToast(
      "Day-ahead generation is unavailable in Remote mode. Please generate it from the gateway workstation.",
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
      const solcastInfo = r?.solcastPull?.pulled ? " + Solcast" : "";
      res.textContent = `✔ Generated ${Number(r.count || 0)} day(s) from ${start} to ${end} via ${provider}${solcastInfo}${fb}`;
      if (r?.fallbackUsed && r?.fallbackReason) {
        showToast(`Forecast fallback: ${r.fallbackReason}`, "warning", 5000);
      }
      if (r?.solcastPull?.pulled === false && r?.solcastPull?.reason && r.solcastPull.reason !== "not_configured") {
        showToast(`Solcast auto-pull skipped: ${r.solcastPull.reason}`, "info", 4000);
      }
      showSnapshotWarningToast("Forecast snapshot", r?.snapshotWarnings || []);
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
  normalizeExportNumberInput("expInvDataInterval");
  await runSingleDateExport(
    "inverter-data",
    "expInvDataInv",
    "expInvDataDate",
    "expInvDataResult",
    { intervalMin: normalizeExportNumberInput("expInvDataInterval") || 1 },
    "btnRunInvDataExport",
    "btnCancelInvDataExport",
  );
}

async function runDailyReportExport() {
  normalizeExportDatePair("expReportStart", "expReportEnd", {
    forceDefault: true,
    preferred: "start",
  });
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
  const controller = new AbortController();
  registerExportAbortController("btnCancelDailyReportExport", controller);
  const startTs = start ? localDateStartMs(start) : undefined;
  const endTs = end ? localDateEndMs(end) : undefined;
  try {
    const body =
      start && end && start === end
        ? { date: start, format }
        : { startTs, endTs, format };
    const r = await api(
      "/api/export/daily-report",
      "POST",
      body,
      {
        signal: controller.signal,
      },
    );
    if (!r?.path) throw new Error("Export did not return output path.");
    if (res) {
      res.className = "exp-result";
      res.textContent = "✔ Saved: " + r.path;
    }
    await openExportPathFolder(r.path);
    setExportButtonState("btnRunDailyReportExport", "ok");
  } catch (e) {
    if (isExportCancelledError(e)) {
      if (res) {
        res.className = "exp-result";
        res.textContent = "Cancelled.";
      }
      setExportButtonState("btnRunDailyReportExport", "idle");
    } else {
      if (res) {
        res.className = "exp-result error";
        res.textContent = "✗ " + e.message;
      }
      setExportButtonState("btnRunDailyReportExport", "fail");
    }
  } finally {
    releaseExportAbortController("btnCancelDailyReportExport");
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

// ─── Cloud Backup UI ──────────────────────────────────────────────────────────

/** Lookup table for email domain → suggested provider. */
const CB_DOMAIN_MAP = [
  { domains: ["outlook.com","hotmail.com","live.com","msn.com","live.com.au","hotmail.co.uk","outlook.com.au"], provider: "onedrive", hint: "Microsoft account detected. OneDrive is the recommended backup provider." },
  { domains: ["gmail.com","googlemail.com"], provider: "gdrive", hint: "Google account detected. Google Drive is the recommended backup provider." },
];

function cbSuggestProvider(email) {
  const hint = $("cbEmailHint");
  if (!hint) return;
  const domain = (email || "").split("@")[1]?.toLowerCase().trim() || "";
  if (!domain) { hint.textContent = ""; return; }
  for (const { domains, hint: h } of CB_DOMAIN_MAP) {
    if (domains.includes(domain)) { hint.textContent = h; return; }
  }
  hint.textContent = "No provider recommendation is available for this domain. Select a provider manually or keep Auto.";
}

function cbSetProgress(data) {
  const wrap = $("cbProgressWrap");
  const icon = $("cbProgressIcon");
  const label = $("cbProgressLabel");
  const pct = $("cbProgressPct");
  const fill = $("cbProgressBarFill");
  if (!wrap) return;

  const icons = {
    idle: "mdi mdi-sleep",
    queued: "mdi mdi-timer-sand",
    creating: "mdi mdi-cog-outline",
    uploading: "mdi mdi-cloud-upload-outline",
    pulling: "mdi mdi-cloud-download-outline",
    restoring: "mdi mdi-backup-restore",
    done: "mdi mdi-check-circle-outline",
    error: "mdi mdi-alert-circle-outline",
    success: "mdi mdi-check-circle-outline",
    failed: "mdi mdi-alert-circle-outline",
  };
  const { status = "idle", pct: p = 0, message = "", updatedAt = 0, finishedAt = 0, startedAt = 0 } = data;

  if (status === "idle") { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (icon) {
    icon.className = `cb-progress-icon ${icons[status] || "mdi mdi-timer-sand"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "";
  }
  const ts = Number(updatedAt || finishedAt || startedAt || 0);
  const tsText = ts > 0 ? new Date(ts).toLocaleString() : "";
  if (label) label.textContent = tsText ? `${message || status} · Last: ${tsText}` : (message || status);
  if (pct) pct.textContent = p > 0 ? `${p}%` : "";
  if (fill) fill.style.width = `${p}%`;
}

let _cbProgressPoller = null;
function startCbProgressPolling() {
  if (_cbProgressPoller) return;
  _cbProgressPoller = setInterval(async () => {
    try {
      const data = await api("/api/backup/progress");
      cbSetProgress(data.progress || {});
      if (data.progress?.status === "done" || data.progress?.status === "error") {
        stopCbProgressPolling();
        await cbRefreshHistory();
        cbUpdateConnectionStatus();
      }
    } catch {
      // ignore
    }
  }, 1500);
}

function stopCbProgressPolling() {
  if (_cbProgressPoller) { clearInterval(_cbProgressPoller); _cbProgressPoller = null; }
}

function cbFormatSize(bytes) {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function cbStatusBadge(status) {
  const map = {
    local: "🗂 Local",
    cloud: "☁ Cloud",
    pulled: "⬇ Pulled",
    "pulled-unverified": "⚠ Pulled",
    restored: "🔄 Restored",
    "pre-restore-safety": "🛡 Safety",
  };
  return map[status] || status;
}

function cbCloudBadges(cloud) {
  if (!cloud || !Object.keys(cloud).length) return "—";
  return Object.keys(cloud).map((p) => (p === "onedrive" ? "☁OD" : "🔵GD")).join(" ");
}

async function cbRefreshHistory() {
  const body = $("cbHistoryBody");
  if (!body) return;
  try {
    const data = await api("/api/backup/history");
    const history = data.history || [];
    const filterDate = ($("cbRestoreDate")?.value || "").trim();
    const filtered = filterDate
      ? history.filter((h) => (h.createdAt || "").startsWith(filterDate))
      : history;

    if (!filtered.length) {
      body.innerHTML = '<tr class="table-empty"><td colspan="7">No backup activity available.</td></tr>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const h of filtered) {
      const tr = document.createElement("tr");
      const dt = h.createdAt ? new Date(h.createdAt).toLocaleString() : "—";
      const restoreAble = ["local","cloud","pulled"].includes(h.status);
      const localAble = ["local","cloud","pulled","pulled-unverified"].includes(h.status);
      tr.innerHTML = `
        <td style="white-space:nowrap">${dt}</td>
        <td>${escapeHtml(h.tag || "—")}</td>
        <td>${Array.isArray(h.scope) ? h.scope.join(", ") : "—"}</td>
        <td>${cbFormatSize(h.totalSize)}</td>
        <td>${cbStatusBadge(h.status)}</td>
        <td>${cbCloudBadges(h.cloud)}</td>
        <td style="white-space:nowrap">
          ${restoreAble ? `<button class="btn btn-xs btn-outline cb-action-restore" data-id="${escapeHtml(h.id)}" type="button">Restore</button>` : ""}
          ${localAble ? `<button class="btn btn-xs btn-outline cb-action-delete" data-id="${escapeHtml(h.id)}" type="button">Delete</button>` : ""}
        </td>`;
      frag.appendChild(tr);
    }
    body.innerHTML = "";
    body.appendChild(frag);

    // Bind action buttons.
    body.querySelectorAll(".cb-action-restore").forEach((btn) => {
      btn.addEventListener("click", () => cbRestoreBackup(btn.dataset.id));
    });
    body.querySelectorAll(".cb-action-delete").forEach((btn) => {
      btn.addEventListener("click", () => cbDeleteBackup(btn.dataset.id));
    });
  } catch (err) {
    console.warn("[CloudBackup] History refresh failed:", err.message);
  }
}

async function cbUpdateConnectionStatus() {
  try {
    const data = await api("/api/backup/status");
    const connected = data.connected || [];
    const odConn = connected.find((c) => c.provider === "onedrive");
    const gdConn = connected.find((c) => c.provider === "gdrive");

    const odBadge = $("cbOneDriveStatus");
    const gdBadge = $("cbGDriveStatus");
    const btnConnOD = $("btnConnectOneDrive");
    const btnDiscOD = $("btnDisconnectOneDrive");
    const btnConnGD = $("btnConnectGDrive");
    const btnDiscGD = $("btnDisconnectGDrive");

    if (odBadge) {
      odBadge.textContent = odConn ? (odConn.expired ? "Expired — reconnect" : "Connected") : "Not connected";
      odBadge.className = "cb-conn-badge" + (odConn && !odConn.expired ? " connected" : "");
    }
    if (gdBadge) {
      gdBadge.textContent = gdConn ? (gdConn.expired ? "Expired — reconnect" : "Connected") : "Not connected";
      gdBadge.className = "cb-conn-badge" + (gdConn && !gdConn.expired ? " connected" : "");
    }
    if (btnConnOD) btnConnOD.hidden = !!(odConn && !odConn.expired);
    if (btnDiscOD) btnDiscOD.hidden = !(odConn && !odConn.expired);
    if (btnConnGD) btnConnGD.hidden = !!(gdConn && !gdConn.expired);
    if (btnDiscGD) btnDiscGD.hidden = !(gdConn && !gdConn.expired);

    cbSetProgress(data.progress || {});
  } catch {
    // ignore
  }
}

async function cbLoadSettings() {
  try {
    const data = await api("/api/backup/settings");
    const s = data.settings || {};
    const c = data.connected || [];

    if ($("cbEmail")) $("cbEmail").value = s.email || "";
    if ($("cbEnabled")) $("cbEnabled").checked = !!s.enabled;
    if ($("cbProvider")) $("cbProvider").value = s.provider || "auto";
    if ($("cbSchedule")) $("cbSchedule").value = s.schedule || "manual";
    if ($("cbScopeDb")) $("cbScopeDb").checked = !s.scope || s.scope.includes("database");
    if ($("cbScopeConfig")) $("cbScopeConfig").checked = !s.scope || s.scope.includes("config");
    if ($("cbScopeLogs")) $("cbScopeLogs").checked = s.scope?.includes("logs") || false;
    if ($("cbOneDriveClientId")) $("cbOneDriveClientId").value = s.onedrive?.clientId || "";
    if ($("cbGDriveClientId")) $("cbGDriveClientId").value = s.gdrive?.clientId || "";
    if ($("cbGDriveClientSecret")) {
      const input = $("cbGDriveClientSecret");
      const secretSaved = Boolean(s.gdrive?.clientSecretSaved);
      input.value = "";
      input.placeholder = secretSaved
        ? "Stored securely. Enter a new secret to replace it."
        : "Desktop app client secret";
      input.title = secretSaved
        ? "A Google client secret is already stored securely. Leave this blank to keep it, or enter a new one to replace it."
        : "Enter the Google OAuth desktop client secret used for Drive access.";
    }
    if ($("cbGDriveSecretNote")) {
      $("cbGDriveSecretNote").textContent = s.gdrive?.clientSecretSaved
        ? "Stored securely in the app. Leave blank to keep it, or enter a new secret to replace it."
        : "The client secret is stored locally after save and is not shown again in this screen.";
    }

    cbSuggestProvider(s.email || "");
    await cbUpdateConnectionStatus();
    await cbRefreshHistory();
  } catch (err) {
    console.warn("[CloudBackup] Settings load failed:", err.message);
  }
}

async function cbSaveSettings() {
  const scope = [];
  if ($("cbScopeDb")?.checked) scope.push("database");
  if ($("cbScopeConfig")?.checked) scope.push("config");
  if ($("cbScopeLogs")?.checked) scope.push("logs");

  const body = {
    email: $("cbEmail")?.value || "",
    enabled: !!$("cbEnabled")?.checked,
    provider: $("cbProvider")?.value || "auto",
    schedule: $("cbSchedule")?.value || "manual",
    scope,
    onedrive: { clientId: ($("cbOneDriveClientId")?.value || "").trim() },
    gdrive: {
      clientId: ($("cbGDriveClientId")?.value || "").trim(),
      clientSecret: ($("cbGDriveClientSecret")?.value || "").trim(),
    },
  };
  try {
    await api("/api/backup/settings", "POST", body);
    showMsg("cbActionMsg", "✔ Cloud settings saved", "");
  } catch (err) {
    showMsg("cbActionMsg", "✗ Save failed: " + err.message, "error");
  }
}

async function cbConnectProvider(provider) {
  // Save credentials first.
  await cbSaveSettings();

  const msgId = provider === "onedrive" ? "cbOneDriveMsg" : "cbGDriveMsg";
  showMsg(msgId, "Opening browser for authentication…", "");

  try {
    // Get auth URL from server.
    const startData = await api(`/api/backup/auth/${provider}/start`, "POST", {});
    if (!startData.ok) throw new Error(startData.error || "Failed to start OAuth");

    if (!window.electronAPI?.openOAuthWindow) {
      showMsg(msgId, "✗ OAuth requires the desktop app (not browser preview)", "error");
      return;
    }

    // Open OAuth window in Electron.
    const result = await window.electronAPI.openOAuthWindow(startData.authUrl);
    if (!result?.ok) {
      showMsg(msgId, `✗ ${result?.error || "OAuth cancelled"}`, "error");
      return;
    }

    // Extract code and state from callbackUrl.
    const cbUrl = new URL(result.callbackUrl);
    const code = cbUrl.searchParams.get("code");
    const state = cbUrl.searchParams.get("state");

    if (!code) {
      const errMsg = cbUrl.searchParams.get("error_description") || cbUrl.searchParams.get("error") || "No code returned";
      showMsg(msgId, `✗ ${errMsg}`, "error");
      return;
    }

    // Exchange code for tokens.
    const cbData = await api(`/api/backup/auth/${provider}/callback`, "POST", { code, state });
    if (!cbData.ok) throw new Error(cbData.error || "Token exchange failed");

    const userName = cbData.user?.name || cbData.user?.email || "";
    showMsg(msgId, `✔ Connected${userName ? ` as ${userName}` : ""}`, "");
    await cbUpdateConnectionStatus();
  } catch (err) {
    showMsg(msgId, `✗ ${err.message}`, "error");
  }
}

async function cbDisconnectProvider(provider) {
  const msgId = provider === "onedrive" ? "cbOneDriveMsg" : "cbGDriveMsg";
  try {
    await api(`/api/backup/auth/${provider}/disconnect`, "POST", {});
    showMsg(msgId, `✔ Disconnected from ${provider}`, "");
    await cbUpdateConnectionStatus();
  } catch (err) {
    showMsg(msgId, `✗ ${err.message}`, "error");
  }
}

async function cbBackupNow() {
  const scope = [];
  if ($("cbScopeDb")?.checked) scope.push("database");
  if ($("cbScopeConfig")?.checked) scope.push("config");
  if ($("cbScopeLogs")?.checked) scope.push("logs");
  const provider = $("cbProvider")?.value || "auto";
  const dateTag = $("cbBackupDate")?.value || "";
  const tag = dateTag ? `manual-${dateTag}` : `manual-${new Date().toISOString().slice(0, 10)}`;

  showMsg("cbActionMsg", "Backup started…", "");
  cbSetProgress({ status: "queued", pct: 2, message: "Backup queued…" });
  $("cbProgressWrap").hidden = false;
  startCbProgressPolling();
  try {
    await api("/api/backup/now", "POST", { scope, provider, tag });
  } catch (err) {
    showMsg("cbActionMsg", `✗ ${err.message}`, "error");
    stopCbProgressPolling();
  }
}

async function cbListCloudBackups() {
  const providerPref = $("cbProvider")?.value || "auto";
  const providers =
    providerPref === "both" || providerPref === "auto"
      ? ["onedrive", "gdrive"]
      : [providerPref];
  const restoreDateFilter = ($("cbRestoreDate")?.value || "").trim();
  const listSection = $("cbCloudListSection");
  const listTitle = $("cbCloudListTitle");
  const listBody = $("cbCloudListBody");
  if (!listSection || !listBody) return;

  showMsg("cbActionMsg", `Listing ${providers.join(" + ")} backups…`, "");
  listSection.hidden = false;
  if (listTitle) listTitle.textContent = `Cloud Backups (${providers.join(" + ")})`;
  listBody.innerHTML = '<tr class="table-empty"><td colspan="3">Loading available backup files…</td></tr>';

  try {
    const results = await Promise.all(
      providers.map(async (provider) => {
        try {
          const data = await api(`/api/backup/cloud/${provider}`);
          return { provider, items: data.items || [], error: null };
        } catch (err) {
          return { provider, items: [], error: err };
        }
      }),
    );

    const items = [];
    const errors = [];
    for (const r of results) {
      if (r.error) {
        errors.push(`${r.provider}: ${r.error.message}`);
        continue;
      }
      for (const item of r.items) {
        items.push({ ...item, __provider: r.provider });
      }
    }

    const filtered = restoreDateFilter
      ? items.filter((item) => {
          const created = String(item.createdTime || item.createdDateTime || item.lastModifiedDateTime || "");
          return created.startsWith(restoreDateFilter);
        })
      : items;
    filtered.sort((a, b) => {
      const ta = Date.parse(a.createdTime || a.createdDateTime || a.lastModifiedDateTime || 0) || 0;
      const tb = Date.parse(b.createdTime || b.createdDateTime || b.lastModifiedDateTime || 0) || 0;
      return tb - ta;
    });
    if (!filtered.length) {
      listBody.innerHTML = '<tr class="table-empty"><td colspan="3">No cloud backups available.</td></tr>';
      showMsg("cbActionMsg", errors.length ? `⚠ ${errors.join(" | ")}` : "No cloud backups are currently available.", errors.length ? "error" : "");
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of filtered) {
      const tr = document.createElement("tr");
      const created = item.createdTime || item.createdDateTime || item.lastModifiedDateTime || "";
      const createdFmt = created ? new Date(created).toLocaleString() : "—";
      const p = String(item.__provider || "").toLowerCase();
      const providerTag = p === "onedrive" ? "OD" : p === "gdrive" ? "GD" : p;
      tr.innerHTML = `
        <td>[${escapeHtml(providerTag)}] ${escapeHtml(item.name)}</td>
        <td>${createdFmt}</td>
        <td>
          <button class="btn btn-xs btn-outline cb-cloud-pull" data-id="${escapeHtml(item.id)}"
            data-name="${escapeHtml(item.name)}" data-provider="${escapeHtml(item.__provider || "")}" type="button">
            ⬇ Pull
          </button>
        </td>`;
      frag.appendChild(tr);
    }
    listBody.innerHTML = "";
    listBody.appendChild(frag);

    listBody.querySelectorAll(".cb-cloud-pull").forEach((btn) => {
      btn.addEventListener("click", () =>
        cbPullFromCloud(btn.dataset.provider, btn.dataset.id, btn.dataset.name),
      );
    });
    if (errors.length) {
      showMsg("cbActionMsg", `✔ Found ${filtered.length} cloud backup(s) · ${errors.join(" | ")}`, "error");
    } else {
      showMsg("cbActionMsg", `✔ Found ${filtered.length} cloud backup(s)`, "");
    }
  } catch (err) {
    listBody.innerHTML = '<tr class="table-empty"><td colspan="3">Unable to load backup files.</td></tr>';
    showMsg("cbActionMsg", `✗ ${err.message}`, "error");
  }
}

async function cbPullFromCloud(provider, remoteId, remoteName) {
  showMsg("cbActionMsg", "Pulling from cloud…", "");
  cbSetProgress({ status: "queued", pct: 5, message: "Pull queued…" });
  $("cbProgressWrap").hidden = false;
  startCbProgressPolling();
  try {
    await api("/api/backup/pull", "POST", { provider, remoteId, remoteName });
  } catch (err) {
    showMsg("cbActionMsg", `✗ ${err.message}`, "error");
    stopCbProgressPolling();
  }
}

async function cbRestoreBackup(backupId) {
  if (!await appConfirm("Restore Backup", `Restore backup "${backupId}"?\n\nThis will overwrite the current database and config. A safety backup will be created first.\n\nThe app will need to restart after restore.`, { ok: "Restore" })) return;
  showMsg("cbActionMsg", "Restore started…", "");
  cbSetProgress({ status: "queued", pct: 5, message: "Restore queued…" });
  $("cbProgressWrap").hidden = false;
  startCbProgressPolling();
  try {
    await api(`/api/backup/restore/${encodeURIComponent(backupId)}`, "POST", {});
  } catch (err) {
    showMsg("cbActionMsg", `✗ ${err.message}`, "error");
    stopCbProgressPolling();
  }
}

async function cbDeleteBackup(backupId) {
  if (!await appConfirm("Delete Backup", `Delete local backup "${backupId}"?\n\nThis only removes the local copy. Cloud copies are not affected.`, { ok: "Delete" })) return;
  try {
    await api(`/api/backup/${encodeURIComponent(backupId)}`, "DELETE");
    showMsg("cbActionMsg", "✔ Backup deleted", "");
    await cbRefreshHistory();
  } catch (err) {
    showMsg("cbActionMsg", `✗ ${err.message}`, "error");
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  $("btnFetchEnergy")?.addEventListener("click", () => {
    State.energyView.page = 1;
    fetchEnergy({ page: 1 });
  });

  // Audit page
  $("btnFetchAudit")?.addEventListener("click", fetchAudit);
  $("btnResetAuditFilters")?.addEventListener("click", resetAuditFilters);

  // Daily Report page
  $("btnFetchReport")?.addEventListener("click", fetchReport);
  $("btnExportDailyReport")?.addEventListener("click", exportDailyReport);

  // Export page
  $("btnExportAlarms")?.addEventListener("click", () =>
    runSingleDateExport(
      "alarms",
      "expAlarmInv",
      "expAlarmDate",
      "expAlarmResult",
      {
        minAlarmDurationSec: normalizeExportNumberInput("expAlarmMinDurationSec"),
      },
      "btnExportAlarms",
      "btnCancelAlarmExport",
    ));
  $("btnRunEnergyExport")?.addEventListener("click", runEnergyExport);
  $("btnRunForecastExport")?.addEventListener("click", runForecastActualExport);
  $("btnRunInvDataExport")?.addEventListener("click", runInverterDataExport);
  $("btnExportAudit")?.addEventListener("click", () =>
    runSingleDateExport(
      "audit",
      "expAuditInv",
      "expAuditDate",
      "expAuditResult",
      {},
      "btnExportAudit",
      "btnCancelAuditExport",
    ));
  $("btnRunDailyReportExport")?.addEventListener("click", runDailyReportExport);
  $("btnCancelAlarmExport")?.addEventListener("click", () =>
    requestExportCancellation("btnCancelAlarmExport", "expAlarmResult"),
  );
  $("btnCancelEnergyExport")?.addEventListener("click", () =>
    requestExportCancellation("btnCancelEnergyExport", "expEnergyResult"),
  );
  $("btnCancelForecastExport")?.addEventListener("click", () =>
    requestExportCancellation("btnCancelForecastExport", "expForecastResult"),
  );
  $("btnCancelInvDataExport")?.addEventListener("click", () =>
    requestExportCancellation("btnCancelInvDataExport", "expInvDataResult"),
  );
  $("btnCancelAuditExport")?.addEventListener("click", () =>
    requestExportCancellation("btnCancelAuditExport", "expAuditResult"),
  );
  $("btnCancelDailyReportExport")?.addEventListener("click", () =>
    requestExportCancellation("btnCancelDailyReportExport", "expReportResult"),
  );

  // Settings page
  $("btnSolcastSaveTest")?.addEventListener("click", saveAndTestSolcast);
  $("btnSolcastTest")?.addEventListener("click", testSolcastConnection);
  $("btnSolcastPreviewRefresh")?.addEventListener("click", () =>
    loadSolcastPreview({ silent: false }).catch(() => {}),
  );
  $("btnSolcastPreviewExport")?.addEventListener("click", () =>
    exportSolcastPreviewXlsx().catch(() => {}),
  );
  $("solcastPreviewDay")?.addEventListener("change", (event) => {
    const nextDay = String(event?.target?.value || "").trim();
    if (!nextDay) return;
    syncSolcastPreviewDayCountOptions(
      State.solcastPreview.days,
      nextDay,
      $("solcastPreviewDayCount")?.value || State.solcastPreview.dayCount || 1,
    );
    loadSolcastPreview({ day: nextDay, silent: true }).catch(() => {});
  });
  $("solcastPreviewDayCount")?.addEventListener("change", (event) => {
    const nextCount = normalizeSolcastPreviewDayCountClient(event?.target?.value || 1);
    loadSolcastPreview({ dayCount: nextCount, silent: true }).catch(() => {});
  });
  $("solcastPreviewResolution")?.addEventListener("change", (event) => {
    State.solcastPreview.resolution = normalizeSolcastPreviewResolutionClient(
      event?.target?.value || "PT5M",
    );
  });
  $("solcastPreviewUnit")?.addEventListener("change", () => {
    rerenderSolcastPreviewChartFromState();
  });
  $("solcastPreviewExportFormat")?.addEventListener("change", (event) => {
    syncSharedForecastExportFormatControls(event?.target?.value || "standard");
  });
  $("expForecastExportFormat")?.addEventListener("change", (event) => {
    syncSharedForecastExportFormatControls(event?.target?.value || "standard");
  });
  $("btnUploadLicense")?.addEventListener("click", uploadLicenseFromSettings);
  $("btnRefreshLicense")?.addEventListener("click", refreshLicenseSection);
  $("btnSaveSettings")?.addEventListener("click", saveSettings);
  $("btnSaveForecastSettings")?.addEventListener("click", saveSettings);
  $("btnExportSettingsConfig")?.addEventListener("click", exportSettingsConfig);
  $("btnImportSettingsConfig")?.addEventListener("click", importSettingsConfig);
  $("btnResetSettingsDefaults")?.addEventListener("click", resetSettingsToDefaults);
  [
    "setPlantCapUpperMw",
    "setPlantCapLowerMw",
    "setPlantCapSequenceCustom",
    "setPlantCapCooldownSec",
  ].forEach((id) => {
    $(id)?.addEventListener("input", () => syncPlantCapFormContext("settings"));
  });
  $("setPlantCapSequenceMode")?.addEventListener("change", () =>
    syncPlantCapFormContext("settings"),
  );
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
  $("btnCancelReplicationJob")?.addEventListener("click", runReplicationCancelNow);
  // Push button removed — viewer model has no outbound data flows.
  $("setReplicationIncludeArchive")?.addEventListener("change", async (event) => {
    const target = event?.target;
    if (!target) return;
    if (target.checked) {
      const ok = await appConfirm(
        "Include Archive DB Files",
        "Include gateway archive DB files in the next standby DB refresh?\n\nThis stages the gateway monthly archive DB files after the main database and can take significantly longer.",
        { ok: "Include" },
      );
      if (!ok) {
        setManualArchiveSyncSelected(false);
        updateReplicationArchiveSelectionUi(true);
        return;
      }
      setManualArchiveSyncSelected(true, { syncDom: false });
      showToast(
        "Archive download enabled. The next standby DB refresh will also stage the gateway monthly archive DB files.",
        "warning",
        5200,
      );
    } else {
      setManualArchiveSyncSelected(false, { syncDom: false });
    }
    updateReplicationArchiveSelectionUi();
    refreshReplicationHealth(true).catch(() => {});
  });
  $("btnPickExportFolder")?.addEventListener("click", pickExportFolder);
  $("btnOpenExportFolder")?.addEventListener("click", openExportFolder);
  $("btnOpenIpConfig")?.addEventListener("click", openIpConfigSettings);
  $("btnCheckAppUpdate")?.addEventListener("click", checkForUpdatesNow);
  $("btnDownloadAppUpdate")?.addEventListener("click", downloadUpdateNow);
  $("btnInstallAppUpdate")?.addEventListener("click", installUpdateNow);
  $("btnAboutCheckUpdate")?.addEventListener("click", checkForUpdatesNow);
  $("btnOpenGuide")?.addEventListener("click", openGuideModal);

  // Cloud Backup
  $("cbEmail")?.addEventListener("input", () => cbSuggestProvider($("cbEmail").value));
  $("btnSaveCloudSettings")?.addEventListener("click", cbSaveSettings);
  $("btnBackupNow")?.addEventListener("click", cbBackupNow);
  $("btnListCloudBackups")?.addEventListener("click", cbListCloudBackups);
  $("btnConnectOneDrive")?.addEventListener("click", () => cbConnectProvider("onedrive"));
  $("btnDisconnectOneDrive")?.addEventListener("click", () => cbDisconnectProvider("onedrive"));
  $("btnConnectGDrive")?.addEventListener("click", () => cbConnectProvider("gdrive"));
  $("btnDisconnectGDrive")?.addEventListener("click", () => cbDisconnectProvider("gdrive"));
  $("btnRefreshBackupHistory")?.addEventListener("click", cbRefreshHistory);
  $("cbRestoreDate")?.addEventListener("change", cbRefreshHistory);
  $("btnClearRestoreDate")?.addEventListener("click", () => { if ($("cbRestoreDate")) { $("cbRestoreDate").value = ""; cbRefreshHistory(); } });
  $("cbOneDriveSetupLink")?.addEventListener("click", (e) => { e.preventDefault(); window.electronAPI?.openOAuthWindow?.("https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade") || window.open("https://portal.azure.com"); });
  $("cbGDriveSetupLink")?.addEventListener("click", (e) => { e.preventDefault(); window.electronAPI?.openOAuthWindow?.("https://console.cloud.google.com/apis/credentials") || window.open("https://console.cloud.google.com"); });

  // Bulk command form (static-param buttons built in buildBulkCommandTpl)
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("#btnPlantCapToolbarToggle")) { togglePlantCapPanelCollapsed(); return; }
    if (t.closest("#btnFillAllTargets")) { fillAllCommandTargets(); return; }
    if (t.closest("#btnClearTargets"))   { clearCommandTargets();   return; }
    if (t.closest("#btnStartSelected"))  { sendSelectedNodes(1);    return; }
    if (t.closest("#btnStopSelected"))   { sendSelectedNodes(0);    return; }
    if (t.closest("#btnPlantCapPreview")) {
      previewPlantCap().catch((err) => {
        showToast(`Plant cap preview failed: ${err.message}`, "fault", 5000);
      });
      return;
    }
    if (t.closest("#btnPlantCapEnable"))  { enablePlantCapControl().catch(() => {}); return; }
    if (t.closest("#btnPlantCapDisable")) { disablePlantCapControl().catch(() => {}); return; }
    if (t.closest("#btnPlantCapRelease")) { releasePlantCapControl().catch(() => {}); return; }
  });

  document.addEventListener("input", (e) => {
    const id = String(e.target?.id || "");
    if (
      id === "plantCapUpperMw" ||
      id === "plantCapLowerMw" ||
      id === "plantCapSequenceCustom" ||
      id === "plantCapCooldownSec"
    ) {
      syncPlantCapFormContext("live");
      return;
    }
  });
  document.addEventListener("change", (e) => {
    const id = String(e.target?.id || "");
    if (id === "plantCapSequenceMode") {
      syncPlantCapFormContext("live");
      return;
    }
  });

  // Inverter grid — card start/stop and node toggle buttons (event delegation)
  $("invGrid")?.addEventListener("click", (e) => {
    const ctrlBtn = e.target.closest(".card-ctrl-btn[data-inv]");
    if (ctrlBtn) {
      sendAllNodesInv(Number(ctrlBtn.dataset.inv), ctrlBtn.dataset.action === "start" ? 1 : 0);
      return;
    }
    const nodeBtn = e.target.closest("button[data-inv][data-node]");
    if (nodeBtn && !nodeBtn.disabled) {
      toggleNode(Number(nodeBtn.dataset.inv), Number(nodeBtn.dataset.node), nodeBtn);
    }
  });

  // Alarm table — ACK button (event delegation)
  $("alarmBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".ack-btn:not([disabled])");
    if (btn) ackAlarm(Number(btn.dataset.alarmId), btn);
  });

  // Toast close (event delegation on toast container)
  $("alarmToast")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".toast-close");
    if (btn) btn.closest(".toast-item")?.remove();
  });

  // Analytics day-ahead buttons (delegated on page container; rendered lazily by ensureAnalyticsCards)
  $("page-analytics")?.addEventListener("click", (e) => {
    if (e.target.closest("#btnDayAheadGenerate")) {
      runDayAheadGeneration();
      return;
    }
    if (e.target.closest("#btnDayAheadExport")) {
      runAnalyticsDayAheadExport();
    }
  });
  $("page-analytics")?.addEventListener("change", (e) => {
    if (e.target?.id === "anaDayAheadExportFormat") {
      syncSharedForecastExportFormatControls(e.target.value);
    }
  });

  // Alarm sound toggle
  $("btnAlarmSound")?.addEventListener("click", toggleAlarmSound);

  // Notification panel
  $("notifBell")?.addEventListener("click", toggleNotif);
  $("btnCloseNotif")?.addEventListener("click", closeNotif);

  // Operator chat
  $("chatBubble")?.addEventListener("click", toggleChatPanel);
  $("chatClose")?.addEventListener("click", closeChatPanel);
  $("chatSend")?.addEventListener("click", sendChatMessage);
  $("chatClear")?.addEventListener("click", () => {
    clearChatMessages().catch((err) => {
      console.warn("[chat] clear failed:", err.message);
    });
  });
  $("chatPanel")?.addEventListener("pointerdown", () => {
    if (State.chatOpen) resetChatDismissTimer();
  });
  $("chatThread")?.addEventListener("scroll", () => {
    if (State.chatOpen) resetChatDismissTimer();
  });
  $("chatInput")?.addEventListener("focus", () => {
    if (!State.chatOpen) openChatPanel();
    resetChatDismissTimer();
  });
  $("chatInput")?.addEventListener("blur", () => {
    setTimeout(() => resetChatDismissTimer(), 0);
  });
  $("chatInput")?.addEventListener("input", () => {
    resetChatDismissTimer();
  });
  $("chatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Guide modal
  $("btnCloseGuide")?.addEventListener("click", closeGuideModal);

  // Cleanup intervals on page unload
  window.addEventListener("beforeunload", () => {
    clearInterval(State.clockTimer);
    clearInterval(State.alarmBadgeTimer);
    clearChatDismissTimer();
    if (State.netIO.monitorTimer) { clearInterval(State.netIO.monitorTimer); State.netIO.monitorTimer = null; }
    const slots = State.xfer?.slots || {};
    for (const key of Object.keys(slots)) {
      const slot = slots[key];
      if (slot?.hideTimer) {
        clearTimeout(slot.hideTimer);
        slot.hideTimer = null;
      }
    }
    stopReplicationHealthPolling();
    stopTodayMwhSyncTimer();
  });
}

// ─── Date defaults ────────────────────────────────────────────────────────────
// Force all tab date inputs to today's values. Called at startup (to override
// any stale exportUiState) and automatically by startClock on day rollover.
function initAllTabDatesToToday() {
  const d = today();
  if ($("anaDate"))     $("anaDate").value = d;
  if ($("reportDate"))  $("reportDate").value = d;
  if ($("alarmDate"))   $("alarmDate").value = d;
  if ($("energyDate"))  $("energyDate").value = d;
  if ($("auditDate"))   $("auditDate").value = d;
  State.lastDateInitDay = d;
}

// ─── Startup Tab Prefetch ─────────────────────────────────────────────────────
// Fires ~2 s after startup (after WS connects and grid settles) so the first
// visit to any data tab renders from State instead of waiting for a fetch.
async function prefetchAllTabs() {
  await new Promise((r) => setTimeout(r, 2000));
  await Promise.allSettled([
    fetchAlarms().catch(() => {}),
    fetchReport().catch(() => {}),
    fetchAudit().catch(() => {}),
    fetchEnergy({ page: 1 }).catch(() => {}),
  ]);
}

// ─── App Confirm Modal ────────────────────────────────────────────────────────
const _appConfirmState = { resolver: null };

function _resolveConfirm(result) {
  const modal = $("appConfirmModal");
  if (modal) modal.classList.add("hidden");
  document.body.classList.remove("modal-open");
  const done = _appConfirmState.resolver;
  _appConfirmState.resolver = null;
  if (typeof done === "function") done(result);
}

function initConfirmModal() {
  const modal = $("appConfirmModal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";
  $("confirmOk")?.addEventListener("click", () => _resolveConfirm(true));
  $("confirmCancel")?.addEventListener("click", () => _resolveConfirm(false));
  modal.addEventListener("click", (e) => { if (e.target === modal) _resolveConfirm(false); });
  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("hidden")) {
      if (e.key === "Escape") _resolveConfirm(false);
      if (e.key === "Enter") _resolveConfirm(true);
    }
  });
}

function appConfirm(title, bodyText, { ok = "OK", cancel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    _appConfirmState.resolver = resolve;
    const modal = $("appConfirmModal");
    const titleEl = $("confirmTitle");
    const bodyEl = $("confirmBody");
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) {
      bodyEl.innerHTML = bodyText
        .split("\n\n")
        .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("");
    }
    const okBtn = $("confirmOk");
    const cancelBtn = $("confirmCancel");
    if (okBtn) okBtn.textContent = ok;
    if (cancelBtn) cancelBtn.textContent = cancel;
    if (modal) { modal.classList.remove("hidden"); modal.focus(); }
    document.body.classList.add("modal-open");
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  initThemeToggle();
  State.plantCapPanelCollapsed = getStoredPlantCapPanelCollapsed();
  await initLicenseBridge();
  await initAppUpdateBridge();
  startClock();
  setupSideNav();
  initGuideModal();
  initConfirmModal();
  setupNav();
  initSettingsSectionNav();
  const resumeAlarmAudio = () => {
    try {
      const ctx = getOrCreateAlarmAudioCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") {
        ctx.resume().then(() => {
          State.chatAudioReady = ctx.state === "running";
        }).catch(() => {});
      } else {
        State.chatAudioReady = ctx.state === "running";
      }
    } catch (err) {
      console.warn("[app] audio resume failed:", err.message);
    }
  };
  document.addEventListener("pointerdown", resumeAlarmAudio, { passive: true });
  document.addEventListener("keydown", resumeAlarmAudio, { passive: true });
  window.addEventListener("resize", rerenderResponsiveChartsDebounced, { passive: true });
  bindEventHandlers();
  syncPlantCapPanelCollapsedUi();
  renderChatSendState();
  renderChatBadge();
  renderChatThread();
  setManualArchiveSyncSelected(loadReplicationArchiveSelectionPreference(), {
    persist: false,
  });
  updateReplicationArchiveSelectionUi(true);
  // Restore alarm sound mute preference
  try { State.alarmSoundMuted = localStorage.getItem("alarmSoundMuted") === "1"; } catch (_) {}
  renderAlarmSoundBtn();
  await loadSettings();
  initAllTabDatesToToday();    // override any stale exportUiState date with today
  queuePersistExportUiState(); // persist today's reportDate immediately
  cbLoadSettings().catch(() => {});
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
  await loadChatHistory({ silent: true });
  refreshAlarmBadge();

  // Refresh alarm badge every 30s
  State.alarmBadgeTimer = setInterval(refreshAlarmBadge, 30000);
  // Background prefetch so all data tabs are ready before the user visits them
  prefetchAllTabs().catch(() => {});
}

document.addEventListener("DOMContentLoaded", init);
