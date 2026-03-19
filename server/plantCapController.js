"use strict";

const UNIT_KW_MAX = 997.0;
const UNIT_KW_DEPENDABLE = 917.0;
const MAX_UNITS_PER_INVERTER = 4;
const DEFAULT_TICK_MS = 2000;
const DEFAULT_BREACH_HOLD_MS = 8000;
const DEFAULT_SETTLE_SEC = 30;
const DEFAULT_LIVE_FRESH_MS = 15000;

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function roundValue(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function getWriteActionLabel(value) {
  const numeric = Number(value);
  if (numeric === 1) return "START";
  if (numeric === 0) return "STOP";
  if (numeric === 2) return "RESET";
  return "WRITE";
}

function parseMaybeNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeSequenceMode(value) {
  const mode = String(value || "ascending")
    .trim()
    .toLowerCase();
  if (mode === "custom") return "exemption";
  if (mode === "descending" || mode === "exemption") return mode;
  return "ascending";
}

function normalizeSequenceCustom(raw, inverterCount = 27) {
  const invMax = clampInt(inverterCount, 1, 200, 27);
  let values = raw;
  if (typeof values === "string") {
    const trimmed = values.trim();
    if (!trimmed) return [];
    try {
      values = JSON.parse(trimmed);
    } catch (_) {
      values = trimmed.split(/[,\s]+/g).filter(Boolean);
    }
  }
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  values.forEach((item) => {
    const inv = Math.trunc(Number(item));
    if (!Number.isFinite(inv) || inv < 1 || inv > invMax || seen.has(inv)) {
      return;
    }
    seen.add(inv);
    out.push(inv);
  });
  return out;
}

function normalizePlantCapSettings(raw, options = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const inverterCount = clampInt(
    options.inverterCount ?? src.inverterCount,
    1,
    200,
    27,
  );
  const upperMw = parseMaybeNumber(src.upperMw ?? src.plantCapUpperMw);
  const lowerMw = parseMaybeNumber(src.lowerMw ?? src.plantCapLowerMw);
  const sequenceMode = normalizeSequenceMode(
    src.sequenceMode ?? src.plantCapSequenceMode,
  );
  const sequenceCustom = normalizeSequenceCustom(
    src.sequenceCustom ??
      src.plantCapSequenceCustom ??
      src.plantCapSequenceCustomJson,
    inverterCount,
  );
  const cooldownSec = clampInt(
    src.cooldownSec ?? src.plantCapCooldownSec,
    5,
    600,
    DEFAULT_SETTLE_SEC,
  );
  const errors = [];
  if (!(upperMw > 0)) {
    errors.push("Upper limit must be greater than 0 MW.");
  }
  if (!(lowerMw >= 0)) {
    errors.push("Lower limit must be 0 MW or higher.");
  }
  if (
    Number.isFinite(upperMw) &&
    Number.isFinite(lowerMw) &&
    !(lowerMw < upperMw)
  ) {
    errors.push("Lower limit must be less than the upper limit.");
  }
  return {
    upperMw,
    lowerMw,
    upperKw: Number.isFinite(upperMw) ? roundValue(upperMw * 1000, 3) : null,
    lowerKw: Number.isFinite(lowerMw) ? roundValue(lowerMw * 1000, 3) : null,
    gapKw:
      Number.isFinite(upperMw) && Number.isFinite(lowerMw)
        ? roundValue((upperMw - lowerMw) * 1000, 3)
        : null,
    sequenceMode,
    sequenceCustom,
    cooldownSec,
    inverterCount,
    valid: errors.length === 0,
    errors,
  };
}

function getConfiguredUnitsForInverter(ipConfig, inverter, nodeCount = 4) {
  const safeNodeCount = clampInt(
    nodeCount,
    1,
    MAX_UNITS_PER_INVERTER,
    MAX_UNITS_PER_INVERTER,
  );
  const fallback = Array.from({ length: safeNodeCount }, (_, i) => i + 1);
  const cfg = ipConfig && typeof ipConfig === "object" ? ipConfig : null;
  const unitsObj =
    cfg && cfg.units && typeof cfg.units === "object" ? cfg.units : null;
  if (!unitsObj) return fallback;
  const hasEntry =
    Object.prototype.hasOwnProperty.call(unitsObj, inverter) ||
    Object.prototype.hasOwnProperty.call(unitsObj, String(inverter));
  if (!hasEntry) return fallback;
  const raw = unitsObj[inverter] ?? unitsObj[String(inverter)];
  if (!Array.isArray(raw)) return fallback;
  const out = [];
  const seen = new Set();
  raw.forEach((item) => {
    const unit = Math.trunc(Number(item));
    if (
      !Number.isFinite(unit) ||
      unit < 1 ||
      unit > safeNodeCount ||
      seen.has(unit)
    ) {
      return;
    }
    seen.add(unit);
    out.push(unit);
  });
  return out;
}

function getInverterIp(ipConfig, inverter) {
  const cfg = ipConfig && typeof ipConfig === "object" ? ipConfig : null;
  const map =
    cfg && cfg.inverters && typeof cfg.inverters === "object"
      ? cfg.inverters
      : null;
  return String(map?.[inverter] ?? map?.[String(inverter)] ?? "").trim();
}

function buildSequenceOrder({ inverterCount = 27, mode = "ascending", custom = [] }) {
  const safeCount = clampInt(inverterCount, 1, 200, 27);
  const base = Array.from({ length: safeCount }, (_, i) => i + 1);
  const normalizedMode = normalizeSequenceMode(mode);
  if (normalizedMode === "descending") {
    return base.reverse();
  }
  if (normalizedMode !== "exemption") {
    return base;
  }
  const exempted = new Set(normalizeSequenceCustom(custom, safeCount));
  return base.filter((inv) => !exempted.has(inv));
}

function buildOwnedStoppedMap(raw) {
  const map = new Map();
  if (raw instanceof Map) {
    for (const [key, value] of raw.entries()) {
      const inv = Math.trunc(Number(key));
      if (!Number.isFinite(inv) || inv < 1 || !value) continue;
      map.set(inv, { ...value, inverter: inv });
    }
    return map;
  }
  const src = raw && typeof raw === "object" ? raw : {};
  Object.entries(src).forEach(([key, value]) => {
    const inv = Math.trunc(Number(key));
    if (!Number.isFinite(inv) || inv < 1 || !value) return;
    map.set(inv, { ...value, inverter: inv });
  });
  return map;
}

function buildInverterProfiles({
  liveData,
  ipConfig,
  inverterCount = 27,
  nodeCount = 4,
  liveFreshMs = DEFAULT_LIVE_FRESH_MS,
  nowTs = Date.now(),
  ownedStopped = {},
} = {}) {
  const data = liveData && typeof liveData === "object" ? liveData : {};
  const safeInvCount = clampInt(inverterCount, 1, 200, 27);
  const safeNodeCount = clampInt(
    nodeCount,
    1,
    MAX_UNITS_PER_INVERTER,
    MAX_UNITS_PER_INVERTER,
  );
  const ownedMap = buildOwnedStoppedMap(ownedStopped);
  const out = [];
  for (let inverter = 1; inverter <= safeInvCount; inverter += 1) {
    const ip = getInverterIp(ipConfig, inverter);
    const units = getConfiguredUnitsForInverter(ipConfig, inverter, safeNodeCount);
    const enabledNodes = units.length;
    const ratedKw = roundValue(
      (UNIT_KW_MAX * enabledNodes) / MAX_UNITS_PER_INVERTER,
      3,
    );
    const dependableKw = roundValue(
      (UNIT_KW_DEPENDABLE * enabledNodes) / MAX_UNITS_PER_INVERTER,
      3,
    );
    const freshUnits = [];
    const staleUnits = [];
    const missingUnits = [];
    let livePacKw = 0;
    let livePdcKw = 0;
    let anyUnitOn = false;
    units.forEach((unit) => {
      const row = data[`${inverter}_${unit}`];
      if (!row || typeof row !== "object") {
        missingUnits.push(unit);
        return;
      }
      const ts = Math.max(0, Number(row.bridgeTs ?? row.ts ?? 0));
      const online = Number(row.online ?? 0) === 1;
      const fresh = online && ts > 0 && nowTs - ts <= liveFreshMs;
      if (!fresh) {
        staleUnits.push(unit);
        return;
      }
      freshUnits.push(unit);
      livePacKw += Math.max(0, Number(row.pac || 0)) / 1000;
      livePdcKw += Math.max(0, Number(row.pdc || 0)) / 1000;
      if (
        Number(row.on_off ?? 0) === 1 ||
        Math.max(0, Number(row.pac || 0)) > 500
      ) {
        anyUnitOn = true;
      }
    });
    const owned = ownedMap.get(inverter) || null;
    const allUnitsFresh = enabledNodes === 0 ? true : freshUnits.length === enabledNodes;
    out.push({
      inverter,
      ip,
      units: [...units],
      enabledNodes,
      ratedKw,
      dependableKw,
      livePacKw: roundValue(livePacKw, 3),
      livePdcKw: roundValue(livePdcKw, 3),
      freshUnits: [...freshUnits],
      staleUnits: [...staleUnits],
      missingUnits: [...missingUnits],
      freshCoverage:
        enabledNodes > 0 ? roundValue(freshUnits.length / enabledNodes, 6) : 1,
      anyFreshData: freshUnits.length > 0,
      allUnitsFresh,
      controllable: Boolean(ip) && enabledNodes > 0,
      liveRunning: anyUnitOn,
      running: anyUnitOn,
      ownedStopped: owned,
      canStop: Boolean(ip) && enabledNodes > 0 && allUnitsFresh && anyUnitOn && !owned,
      canStart:
        Boolean(ip) &&
        enabledNodes > 0 &&
        (Boolean(owned) || (allUnitsFresh && !anyUnitOn)),
    });
  }
  return out;
}

function buildStepMetrics(profilesRaw) {
  const profiles = Array.isArray(profilesRaw) ? profilesRaw : [];
  const controllable = profiles.filter((profile) => profile.controllable);
  const configurableSteps = controllable
    .map((profile) => Number(profile.dependableKw || 0))
    .filter((kw) => kw > 0);
  const runningLiveSteps = controllable
    .filter((profile) => profile.running)
    .map((profile) => Number(profile.livePacKw || 0))
    .filter((kw) => kw > 0.05);
  const nodeShapes = new Set(
    controllable.map((profile) => Number(profile.enabledNodes || 0)).filter(Boolean),
  );
  return {
    smallestConfiguredStepKw: configurableSteps.length
      ? roundValue(Math.min(...configurableSteps), 3)
      : null,
    smallestConfiguredStepMw: configurableSteps.length
      ? roundValue(Math.min(...configurableSteps) / 1000, 3)
      : null,
    smallestLiveRunningStepKw: runningLiveSteps.length
      ? roundValue(Math.min(...runningLiveSteps), 3)
      : null,
    smallestLiveRunningStepMw: runningLiveSteps.length
      ? roundValue(Math.min(...runningLiveSteps) / 1000, 3)
      : null,
    partialNodeFleet: nodeShapes.size > 1,
    controllableInverterCount: controllable.length,
  };
}

function addWarning(target, code, severity, message, extra = {}) {
  if (!Array.isArray(target) || !code || !message) return;
  if (target.some((entry) => entry && entry.code === code)) return;
  target.push({
    code,
    severity: severity || "warning",
    message,
    ...extra,
  });
}

function buildPlantCapPreview({
  settings,
  liveData,
  ipConfig,
  inverterCount = 27,
  nodeCount = 4,
  liveFreshMs = DEFAULT_LIVE_FRESH_MS,
  ownedStopped = {},
  nowTs = Date.now(),
} = {}) {
  const config = normalizePlantCapSettings(settings, { inverterCount });
  const exemptedInverters = new Set(
    config.sequenceMode === "exemption" ? config.sequenceCustom : [],
  );
  const profiles = buildInverterProfiles({
    liveData,
    ipConfig,
    inverterCount,
    nodeCount,
    liveFreshMs,
    nowTs,
    ownedStopped,
  }).map((profile) => {
    const exempted = exemptedInverters.has(profile.inverter);
    return {
      ...profile,
      exempted,
      controllable: profile.controllable && !exempted,
      canStop: profile.canStop && !exempted,
      canStart: profile.canStart && !exempted,
    };
  });
  const sequence = buildSequenceOrder({
    inverterCount,
    mode: config.sequenceMode,
    custom: config.sequenceCustom,
  });
  const profileByInv = new Map(profiles.map((profile) => [profile.inverter, profile]));
  const orderedProfiles = sequence
    .map((inverter) => profileByInv.get(inverter))
    .filter(Boolean);
  const warnings = [];
  const errors = [...config.errors];
  const stepMetrics = buildStepMetrics(profiles);
  const currentPlantKw = roundValue(
    profiles.reduce((sum, profile) => sum + Number(profile.livePacKw || 0), 0),
    3,
  );
  const currentPlantMw = roundValue(currentPlantKw / 1000, 3);
  const staleProfiles = profiles.filter(
    (profile) =>
      profile.controllable &&
      !profile.ownedStopped &&
      profile.enabledNodes > 0 &&
      !profile.allUnitsFresh,
  );
  const missingFreshCount = staleProfiles.length;
  if (!stepMetrics.controllableInverterCount) {
    addWarning(
      warnings,
      "no_controllable_inverters",
      "critical",
      "No controllable inverters are configured for plant-wide capping.",
    );
  }
  if (stepMetrics.partialNodeFleet) {
    addWarning(
      warnings,
      "partial_node_fleet",
      "info",
      "Configured inverters do not all have the same enabled node count, so each shutdown step can remove a different amount of MW.",
    );
  }
  if (missingFreshCount > 0) {
    addWarning(
      warnings,
      "data_stale",
      "critical",
      `Fresh live data is incomplete for ${missingFreshCount} controllable inverter(s). Automatic cap actions are paused until all configured units report fresh PAC values.`,
      { affectedInverters: staleProfiles.map((profile) => profile.inverter) },
    );
  }
  if (
    config.valid &&
    Number.isFinite(stepMetrics.smallestConfiguredStepKw) &&
    Number.isFinite(config.gapKw)
  ) {
    if (config.gapKw < stepMetrics.smallestConfiguredStepKw * 0.5) {
      addWarning(
        warnings,
        "narrow_band_severe",
        "critical",
        "Upper and Lower limits are extremely close for whole-inverter control. The controller can overshoot the band or repeatedly stop and start inverters before it settles.",
        {
          gapMw: roundValue(config.gapKw / 1000, 3),
          smallestConfiguredStepMw: stepMetrics.smallestConfiguredStepMw,
        },
      );
    } else if (config.gapKw < stepMetrics.smallestConfiguredStepKw) {
      addWarning(
        warnings,
        "narrow_band",
        "warning",
        "Upper and Lower limits are close relative to the smallest controllable inverter step. This can cause unstable plant-wide capping and operator confusion about why the plant does not settle inside the band cleanly.",
        {
          gapMw: roundValue(config.gapKw / 1000, 3),
          smallestConfiguredStepMw: stepMetrics.smallestConfiguredStepMw,
        },
      );
    }
  }

  const stopCandidates = orderedProfiles.filter((profile) => profile.canStop);
  const stopPlan = stopCandidates.map((profile) => {
    const projectedPlantKw = roundValue(currentPlantKw - profile.livePacKw, 3);
    const fitsLower =
      Number.isFinite(config.lowerKw) && projectedPlantKw >= config.lowerKw;
    return {
      inverter: profile.inverter,
      enabledNodes: profile.enabledNodes,
      ratedKw: profile.ratedKw,
      dependableKw: profile.dependableKw,
      livePacKw: profile.livePacKw,
      projectedPlantKw,
      projectedPlantMw: roundValue(projectedPlantKw / 1000, 3),
      fitsLower,
      decisionReason: fitsLower
        ? "Keeps projected plant output above the lower limit."
        : "Would drop projected plant output below the lower limit.",
    };
  });
  let selectedStop = null;
  if (config.valid && currentPlantKw > config.upperKw) {
    selectedStop = stopPlan.find((step) => step.fitsLower) || null;
    if (!selectedStop && stopPlan.length) {
      selectedStop = {
        ...stopPlan[0],
        fallback: true,
        decisionReason:
          "No whole-inverter stop can keep the plant above the lower limit. This is the earliest configured stop candidate, but it will undershoot the band.",
      };
      addWarning(
        warnings,
        "band_unreachable_with_whole_inverters",
        "warning",
        "The configured plant cap band cannot be reached cleanly with whole-inverter shutdown steps. Any stop action will drop the plant below the lower limit.",
      );
    }
    if (!selectedStop && !stopPlan.length) {
      addWarning(
        warnings,
        "no_running_candidates",
        "warning",
        "Plant output is above the upper limit, but no eligible running inverter is available for a controller stop action.",
      );
    }
  }

  const ownedMap = buildOwnedStoppedMap(ownedStopped);
  const ownedRestartCandidates = [...ownedMap.values()]
    .sort((a, b) => Number(b.stoppedAt || 0) - Number(a.stoppedAt || 0))
    .map((entry) => {
      const profile = profileByInv.get(entry.inverter);
      return profile && profile.canStart
        ? { ...entry, profile, owned: true }
        : null;
    })
    .filter(Boolean);
  const nonOwnedRestartCandidates = orderedProfiles
    .filter((profile) => profile.canStart && !ownedMap.has(profile.inverter))
    .map((profile) => ({
      inverter: profile.inverter,
      stoppedAt: 0,
      pacBeforeStopKw: 0,
      dependableKw: profile.dependableKw,
      profile,
      owned: false,
    }));
  const restartCandidates = [
    ...ownedRestartCandidates,
    ...nonOwnedRestartCandidates,
  ];
  const restartPlan = restartCandidates.map((entry) => {
    const profile = entry.profile;
    const restartEstimateKw = roundValue(
      Math.min(
        Math.max(0, Number(entry.pacBeforeStopKw || 0)) || profile.dependableKw,
        Number(profile.dependableKw || 0) || Number(entry.dependableKw || 0) || 0,
      ),
      3,
    );
    const projectedPlantKw = roundValue(currentPlantKw + restartEstimateKw, 3);
    const fitsUpper =
      Number.isFinite(config.upperKw) && projectedPlantKw <= config.upperKw;
    return {
      inverter: profile.inverter,
      enabledNodes: profile.enabledNodes,
      ratedKw: profile.ratedKw,
      dependableKw: profile.dependableKw,
      livePacKw: profile.livePacKw,
      restartEstimateKw,
      projectedPlantKw,
      projectedPlantMw: roundValue(projectedPlantKw / 1000, 3),
      fitsUpper,
      stoppedAt: Number(entry.stoppedAt || 0),
      decisionReason: fitsUpper
        ? entry.owned
          ? "Restores one controller-owned inverter without exceeding the upper limit."
          : "Starts one eligible stopped non-exempt inverter without exceeding the upper limit."
        : "Would exceed the upper limit after restart.",
    };
  });
  let selectedRestart = null;
  if (config.valid && currentPlantKw < config.lowerKw) {
    selectedRestart = restartPlan.find((step) => step.fitsUpper) || null;
    if (!selectedRestart && restartPlan.length) {
      addWarning(
        warnings,
        "cannot_restore_without_exceeding_upper",
        "warning",
        "Plant output is below the lower limit, but restarting any eligible stopped non-exempt inverter would exceed the upper limit.",
      );
    }
    if (!selectedRestart && !restartPlan.length) {
      addWarning(
        warnings,
        "no_restart_candidates",
        "info",
        "Plant output is below the lower limit, but there are no eligible stopped non-exempt inverters available to restart.",
      );
    }
  }

  let recommendedAction = "hold";
  let reasonCode = "within_band";
  let reasonText = "Plant output is within the configured cap band.";
  const dataFresh = missingFreshCount === 0;
  const actionable = config.valid && dataFresh && stepMetrics.controllableInverterCount > 0;
  if (!config.valid) {
    recommendedAction = "pause";
    reasonCode = "settings_invalid";
    reasonText = errors[0] || "Plant cap settings are invalid.";
  } else if (!dataFresh) {
    recommendedAction = "pause";
    reasonCode = "data_stale";
    reasonText =
      "Automatic cap actions are paused because live PAC data is incomplete.";
  } else if (currentPlantKw > config.upperKw) {
    if (selectedStop) {
      recommendedAction = "stop";
      reasonCode = selectedStop.fallback
        ? "band_unreachable_with_whole_inverters"
        : "above_upper";
      reasonText = selectedStop.decisionReason;
    } else {
      recommendedAction = "hold";
      reasonCode = "no_stop_candidate";
      reasonText =
        "Plant output is above the upper limit, but no eligible stop candidate is available.";
    }
  } else if (currentPlantKw < config.lowerKw) {
    if (selectedRestart) {
      recommendedAction = "start";
      reasonCode = "below_lower";
      reasonText = selectedRestart.decisionReason;
    } else {
      recommendedAction = "hold";
      reasonCode = "no_restart_candidate";
      reasonText =
        "Plant output is below the lower limit, but no eligible stopped non-exempt inverter can be restarted safely.";
    }
  }

  return {
    ok: true,
    valid: config.valid,
    actionable,
    dataFresh,
    nowTs,
    upperMw: config.upperMw,
    lowerMw: config.lowerMw,
    upperKw: config.upperKw,
    lowerKw: config.lowerKw,
    gapMw: Number.isFinite(config.gapKw)
      ? roundValue(config.gapKw / 1000, 3)
      : null,
    gapKw: config.gapKw,
    cooldownSec: config.cooldownSec,
    sequenceMode: config.sequenceMode,
    sequenceCustom: [...config.sequenceCustom],
    sequence,
    errors,
    warnings,
    stepMetrics,
    currentPlantKw,
    currentPlantMw,
    recommendedAction,
    reasonCode,
    reasonText,
    profiles,
    stopPlan,
    restartPlan,
    selectedStop,
    selectedRestart,
    ownedStopped: restartCandidates.map((entry) => ({
      inverter: entry.inverter,
      stoppedAt: Number(entry.stoppedAt || 0),
      pacBeforeStopKw: roundValue(Number(entry.pacBeforeStopKw || 0), 3),
      enabledNodes: Number(entry.enabledNodes || entry.profile?.enabledNodes || 0),
      ratedKw: roundValue(
        Number(entry.ratedKw || entry.profile?.ratedKw || 0),
        3,
      ),
      dependableKw: roundValue(
        Number(entry.dependableKw || entry.profile?.dependableKw || 0),
        3,
      ),
    })),
  };
}

class PlantCapController {
  constructor(options = {}) {
    this.getLiveData =
      typeof options.getLiveData === "function" ? options.getLiveData : () => ({});
    this.getIpConfig =
      typeof options.getIpConfig === "function" ? options.getIpConfig : () => ({});
    this.getSettings =
      typeof options.getSettings === "function" ? options.getSettings : () => ({});
    this.isRemoteMode =
      typeof options.isRemoteMode === "function" ? options.isRemoteMode : () => false;
    this.executeWrite =
      typeof options.executeWrite === "function"
        ? options.executeWrite
        : async () => {
            throw new Error("executeWrite dependency is not configured.");
          };
    this.broadcast =
      typeof options.broadcast === "function" ? options.broadcast : () => {};
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.tickMs = clampInt(options.tickMs, 250, 60000, DEFAULT_TICK_MS);
    this.breachHoldMs = clampInt(
      options.breachHoldMs,
      0,
      300000,
      DEFAULT_BREACH_HOLD_MS,
    );
    this.liveFreshMs = clampInt(
      options.liveFreshMs,
      1000,
      600000,
      DEFAULT_LIVE_FRESH_MS,
    );
    this.operatorName = String(options.operatorName || "PLANT CAP").trim() || "PLANT CAP";
    this.timer = null;
    this.lastBroadcastKey = "";
    this.state = {
      enabled: false,
      status: "idle",
      reasonCode: "disabled",
      reasonText: "Plant-wide capping is disabled.",
      activeConfig: null,
      ownedStopped: new Map(),
      stopOrder: [],
      pendingAction: null,
      cooldownUntilTs: 0,
      breachSinceTs: 0,
      breachDirection: "",
      lastDecision: null,
      lastError: "",
      lastPreview: null,
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.state.status = "fault";
        this.state.reasonCode = "controller_error";
        this.state.reasonText =
          err?.message || "Plant cap controller tick failed.";
        this.state.lastError = err?.message || String(err || "");
        this.broadcastStatus(true);
      });
    }, this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getPersistedSettings() {
    const settings =
      this.getSettings && typeof this.getSettings === "function"
        ? this.getSettings()
        : {};
    return normalizePlantCapSettings(settings, {
      inverterCount: Number(settings?.inverterCount || 27),
    });
  }

  getActiveSettings(overrides = null) {
    if (overrides && typeof overrides === "object") {
      const merged = {
        ...(this.state.activeConfig || this.getPersistedSettings()),
        ...overrides,
      };
      return normalizePlantCapSettings(merged, {
        inverterCount: Number(
          overrides?.inverterCount ||
            this.state.activeConfig?.inverterCount ||
            this.getPersistedSettings().inverterCount,
        ),
      });
    }
    if (this.state.activeConfig) {
      return normalizePlantCapSettings(this.state.activeConfig, {
        inverterCount: Number(this.state.activeConfig.inverterCount || 27),
      });
    }
    return this.getPersistedSettings();
  }

  buildPreview(overrides = null) {
    const settings = this.getActiveSettings(overrides);
    const persistedSettings = this.getSettings();
    const inverterCount = clampInt(
      persistedSettings?.inverterCount ?? settings.inverterCount,
      1,
      200,
      27,
    );
    const nodeCount = clampInt(
      persistedSettings?.nodeCount,
      1,
      MAX_UNITS_PER_INVERTER,
      MAX_UNITS_PER_INVERTER,
    );
    return buildPlantCapPreview({
      settings,
      liveData: this.getLiveData(),
      ipConfig: this.getIpConfig(),
      inverterCount,
      nodeCount,
      liveFreshMs: this.liveFreshMs,
      ownedStopped: this.state.ownedStopped,
      nowTs: this.now(),
    });
  }

  getStatus(options = {}) {
    const preview =
      options.refresh === false && this.state.lastPreview
        ? this.state.lastPreview
        : this.buildPreview();
    this.state.lastPreview = preview;
    const cooldownRemainingSec = Math.max(
      0,
      Math.ceil((Number(this.state.cooldownUntilTs || 0) - this.now()) / 1000),
    );
    const status = {
      ok: true,
      enabled: Boolean(this.state.enabled),
      status: String(this.state.status || "idle"),
      reasonCode: String(this.state.reasonCode || preview.reasonCode || "disabled"),
      reasonText: String(this.state.reasonText || preview.reasonText || ""),
      lastError: String(this.state.lastError || ""),
      upperMw: preview.upperMw,
      lowerMw: preview.lowerMw,
      upperKw: preview.upperKw,
      lowerKw: preview.lowerKw,
      gapMw: preview.gapMw,
      gapKw: preview.gapKw,
      cooldownSec: preview.cooldownSec,
      cooldownRemainingSec,
      sequenceMode: preview.sequenceMode,
      sequenceCustom: [...preview.sequenceCustom],
      sequence: [...preview.sequence],
      currentPlantMw: preview.currentPlantMw,
      currentPlantKw: preview.currentPlantKw,
      valid: Boolean(preview.valid),
      actionable: Boolean(preview.actionable),
      dataFresh: Boolean(preview.dataFresh),
      warnings: [...preview.warnings],
      errors: [...preview.errors],
      stepMetrics: { ...preview.stepMetrics },
      ownedStopped: [...preview.ownedStopped],
      pendingAction: this.state.pendingAction
        ? { ...this.state.pendingAction }
        : null,
      lastDecision: this.state.lastDecision ? { ...this.state.lastDecision } : null,
    };
    if (options.includePreview) {
      status.preview = {
        recommendedAction: preview.recommendedAction,
        reasonCode: preview.reasonCode,
        reasonText: preview.reasonText,
        selectedStop: preview.selectedStop ? { ...preview.selectedStop } : null,
        selectedRestart: preview.selectedRestart
          ? { ...preview.selectedRestart }
          : null,
        stopPlan: preview.stopPlan.map((row) => ({ ...row })),
        restartPlan: preview.restartPlan.map((row) => ({ ...row })),
        profiles: preview.profiles.map((row) => ({ ...row })),
      };
    }
    return status;
  }

  broadcastStatus(force = false) {
    const status = this.getStatus({ refresh: true, includePreview: false });
    const key = JSON.stringify({
      enabled: status.enabled,
      status: status.status,
      reasonCode: status.reasonCode,
      lastError: status.lastError,
      pendingAction: status.pendingAction
        ? {
            type: status.pendingAction.type,
            inverter: status.pendingAction.inverter,
          }
        : null,
      ownedStopped: status.ownedStopped.map((entry) => entry.inverter),
      lastDecision: status.lastDecision
        ? {
            action: status.lastDecision.action,
            inverter: status.lastDecision.inverter,
            at: status.lastDecision.at,
          }
        : null,
      warnings: status.warnings.map((warning) => `${warning.code}:${warning.severity}`),
      errors: status.errors,
    });
    if (!force && key === this.lastBroadcastKey) return status;
    this.lastBroadcastKey = key;
    this.broadcast({ type: "plant_cap_status", plantCap: status });
    return status;
  }

  async enable(overrides = null) {
    const preview = this.buildPreview(overrides);
    if (!preview.valid) {
      const err = new Error(preview.errors[0] || "Invalid plant cap settings.");
      err.status = 400;
      throw err;
    }
    this.state.enabled = true;
    this.state.activeConfig = {
      upperMw: preview.upperMw,
      lowerMw: preview.lowerMw,
      sequenceMode: preview.sequenceMode,
      sequenceCustom: [...preview.sequenceCustom],
      cooldownSec: preview.cooldownSec,
      inverterCount: preview.sequence.length,
    };
    this.state.status = "monitoring";
    this.state.reasonCode = "enabled";
    this.state.reasonText = "Plant-wide capping is active.";
    this.state.lastError = "";
    this.state.breachSinceTs = 0;
    this.state.breachDirection = "";
    this.state.lastPreview = preview;
    this.broadcastStatus(true);
    await this.tick();
    return this.getStatus({ refresh: true, includePreview: true });
  }

  disable(reasonCode = "disabled", reasonText = "Plant-wide capping is disabled.") {
    this.state.enabled = false;
    this.state.status = reasonCode === "disabled" ? "idle" : "paused";
    this.state.reasonCode = reasonCode;
    this.state.reasonText = reasonText;
    this.state.breachSinceTs = 0;
    this.state.breachDirection = "";
    if (reasonCode === "disabled") {
      this.state.activeConfig = null;
    }
    this.broadcastStatus(true);
    return this.getStatus({ refresh: true, includePreview: true });
  }

  getManualWriteGuard(event = {}) {
    const scope = String(event.scope || "").trim().toLowerCase();
    if (scope === "plant-cap") {
      return { allowed: true };
    }
    const inverter = Math.trunc(Number(event.inverter));
    if (!this.state.enabled || !Number.isFinite(inverter) || inverter < 1) {
      return { allowed: true };
    }
    const activeSettings = this.getActiveSettings();
    const exempted =
      activeSettings.sequenceMode === "exemption" &&
      Array.isArray(activeSettings.sequenceCustom) &&
      activeSettings.sequenceCustom.includes(inverter);
    if (exempted) {
      return { allowed: true, exempted: true };
    }
    const action = getWriteActionLabel(event.value);
    return {
      allowed: false,
      status: 409,
      reasonCode: "plant_cap_manual_control_blocked",
      message: `Plant Output Cap is active and INV-${String(inverter).padStart(2, "0")} is not exempted. Manual ${action} cannot override the current plant cap session. Disable plant capping or exempt this inverter before changing it manually.`,
    };
  }

  handleManualWrite(event = {}) {
    const scope = String(event.scope || "").trim().toLowerCase();
    if (scope === "plant-cap") return;
    const inverter = Math.trunc(Number(event.inverter));
    if (!Number.isFinite(inverter) || inverter < 1) return;
    if (!this.state.ownedStopped?.has?.(inverter)) return;
    this.state.enabled = false;
    this.state.pendingAction = null;
    this.state.ownedStopped.delete(inverter);
    this.state.status = "paused";
    this.state.reasonCode = "manual_override_detected";
    this.state.reasonText = `Manual control was applied to controller-owned inverter ${String(inverter).padStart(2, "0")}. Re-enable plant-wide capping after operator review.`;
    this.state.lastDecision = {
      action: "pause",
      inverter,
      at: this.now(),
      reasonCode: "manual_override_detected",
      operator: String(event.operator || "").trim(),
    };
    this.broadcastStatus(true);
  }

  async releaseControlled() {
    this.state.enabled = false;
    const preview = this.buildPreview();
    const ownedOrder = [...preview.ownedStopped]
      .sort((a, b) => Number(b.stoppedAt || 0) - Number(a.stoppedAt || 0))
      .map((entry) => entry.inverter);
    const results = [];
    for (const inverter of ownedOrder) {
      const latest = this.buildPreview();
      const profile = latest.profiles.find((item) => item.inverter === inverter);
      const step = latest.restartPlan.find((item) => item.inverter === inverter) || null;
      if (!profile) continue;
      try {
        await this.executeInverterAction(profile, 1, {
          actionType: "start",
          step,
        });
        results.push({ inverter, ok: true });
      } catch (err) {
        results.push({
          inverter,
          ok: false,
          error: String(err?.message || err || "Release failed."),
        });
        this.state.status = "fault";
        this.state.reasonCode = "release_failed";
        this.state.reasonText = results[results.length - 1].error;
        this.state.lastError = results[results.length - 1].error;
        this.broadcastStatus(true);
        return {
          ok: false,
          results,
          status: this.getStatus({ refresh: true, includePreview: true }),
        };
      }
    }
    this.state.status = "idle";
    this.state.reasonCode = "released";
    this.state.reasonText = "Controller-owned inverters were released.";
    this.state.activeConfig = null;
    this.broadcastStatus(true);
    return {
      ok: true,
      results,
      status: this.getStatus({ refresh: true, includePreview: true }),
    };
  }

  async executeInverterAction(profile, value, options = {}) {
    const actionType = options.actionType || (Number(value) === 1 ? "start" : "stop");
    const step = options.step || null;
    const units = [...(profile?.units || [])].sort((a, b) => a - b);
    if (!profile?.inverter || !units.length) {
      throw new Error("No configured units are available for the selected inverter.");
    }
    this.state.pendingAction = {
      type: actionType,
      inverter: profile.inverter,
      units: [...units],
      startedAt: this.now(),
    };
    this.state.status = actionType === "stop" ? "stopping" : "starting";
    this.state.reasonCode =
      actionType === "stop" ? "stopping_inverter" : "starting_inverter";
    this.state.reasonText =
      actionType === "stop"
        ? `Stopping inverter ${String(profile.inverter).padStart(2, "0")} for plant-wide capping.`
        : `Starting controller-owned inverter ${String(profile.inverter).padStart(2, "0")}.`;
    this.broadcastStatus(true);
    try {
      for (const unit of units) {
        await this.executeWrite({
          inverter: profile.inverter,
          node: unit,
          unit,
          value,
          scope: "plant-cap",
          operator: this.operatorName,
          priority: "high",
          reason: String(step?.decisionReason || "").trim(),
        });
      }
      const actionAt = this.now();
      if (Number(value) === 0) {
        this.state.ownedStopped.set(profile.inverter, {
          inverter: profile.inverter,
          stoppedAt: actionAt,
          pacBeforeStopKw: roundValue(Number(profile.livePacKw || 0), 3),
          enabledNodes: Number(profile.enabledNodes || 0),
          ratedKw: roundValue(Number(profile.ratedKw || 0), 3),
          dependableKw: roundValue(Number(profile.dependableKw || 0), 3),
        });
        this.state.stopOrder = this.state.stopOrder.filter(
          (entry) => entry !== profile.inverter,
        );
        this.state.stopOrder.push(profile.inverter);
      } else {
        this.state.ownedStopped.delete(profile.inverter);
        this.state.stopOrder = this.state.stopOrder.filter(
          (entry) => entry !== profile.inverter,
        );
      }
      const cooldownSec = clampInt(
        this.state.activeConfig?.cooldownSec,
        5,
        600,
        DEFAULT_SETTLE_SEC,
      );
      this.state.cooldownUntilTs = actionAt + cooldownSec * 1000;
      this.state.lastDecision = {
        action: actionType,
        inverter: profile.inverter,
        at: actionAt,
        projectedPlantMw: roundValue(
          Number(
            step?.projectedPlantMw ??
              step?.projectedPlantKw / 1000 ??
              NaN,
          ),
          3,
        ),
        reasonCode: step?.fallback
          ? "band_unreachable_with_whole_inverters"
          : actionType === "stop"
            ? "above_upper"
            : "below_lower",
        reasonText: String(step?.decisionReason || "").trim(),
      };
      this.state.lastError = "";
    } catch (err) {
      const message = String(err?.message || err || "Control write failed.");
      this.state.status = "fault";
      this.state.reasonCode = "write_failed";
      this.state.reasonText = message;
      this.state.lastError = message;
      this.state.pendingAction = null;
      this.broadcastStatus(true);
      throw err;
    }
    this.state.pendingAction = null;
    this.broadcastStatus(true);
    return this.getStatus({ refresh: true, includePreview: true });
  }

  async tick() {
    const now = this.now();
    const preview = this.buildPreview();
    this.state.lastPreview = preview;

    if (this.state.pendingAction) {
      return this.getStatus({ refresh: false, includePreview: false });
    }

    if (!this.state.enabled) {
      if (this.state.status !== "paused" || this.state.reasonCode === "disabled") {
        this.state.status = "idle";
        this.state.reasonCode = "disabled";
        this.state.reasonText = "Plant-wide capping is disabled.";
      }
      return this.getStatus({ refresh: false, includePreview: false });
    }

    if (this.isRemoteMode()) {
      this.state.status = "paused";
      this.state.reasonCode = "remote_mode_viewer";
      this.state.reasonText =
        "Plant-wide capping can only run on the gateway workstation.";
      this.broadcastStatus();
      return this.getStatus({ refresh: false, includePreview: false });
    }

    if (!preview.valid) {
      this.state.status = "paused";
      this.state.reasonCode = "settings_invalid";
      this.state.reasonText = preview.errors[0] || "Plant cap settings are invalid.";
      this.broadcastStatus();
      return this.getStatus({ refresh: false, includePreview: false });
    }

    if (!preview.dataFresh) {
      this.state.status = "paused";
      this.state.reasonCode = "data_stale";
      this.state.reasonText =
        "Plant-wide capping is paused until all configured units report fresh live PAC values.";
      this.broadcastStatus();
      return this.getStatus({ refresh: false, includePreview: false });
    }

    if (now < Number(this.state.cooldownUntilTs || 0)) {
      this.state.status = "monitoring";
      this.state.reasonCode = "cooldown";
      this.state.reasonText =
        "Plant-wide capping is waiting for the last inverter action to settle.";
      this.broadcastStatus();
      return this.getStatus({ refresh: false, includePreview: false });
    }

    const breachDirection =
      preview.currentPlantKw > preview.upperKw
        ? "high"
        : preview.currentPlantKw < preview.lowerKw
          ? "low"
          : "";
    if (!breachDirection) {
      this.state.breachSinceTs = 0;
      this.state.breachDirection = "";
      this.state.status = "monitoring";
      this.state.reasonCode = "within_band";
      this.state.reasonText = "Plant output is within the configured cap band.";
      this.broadcastStatus();
      return this.getStatus({ refresh: false, includePreview: false });
    }

    if (this.state.breachDirection !== breachDirection) {
      this.state.breachDirection = breachDirection;
      this.state.breachSinceTs = now;
    }
    const holdMs = Math.max(0, now - Number(this.state.breachSinceTs || now));
    if (holdMs < this.breachHoldMs) {
      this.state.status = "monitoring";
      this.state.reasonCode =
        breachDirection === "high" ? "above_upper_waiting" : "below_lower_waiting";
      this.state.reasonText =
        breachDirection === "high"
          ? "Plant output is above the upper limit. Waiting for the hold timer before stopping an inverter."
          : "Plant output is below the lower limit. Waiting for the hold timer before restarting a controller-owned inverter.";
      this.broadcastStatus();
      return this.getStatus({ refresh: false, includePreview: false });
    }

    if (breachDirection === "high") {
      if (!preview.selectedStop) {
        this.state.status = "monitoring";
        this.state.reasonCode = "no_stop_candidate";
        this.state.reasonText =
          "Plant output is above the upper limit, but no eligible inverter can be stopped safely.";
        this.broadcastStatus();
        return this.getStatus({ refresh: false, includePreview: false });
      }
      const profile = preview.profiles.find(
        (item) => item.inverter === preview.selectedStop.inverter,
      );
      if (profile) {
        await this.executeInverterAction(profile, 0, {
          actionType: "stop",
          step: preview.selectedStop,
        });
      }
      return this.getStatus({ refresh: true, includePreview: false });
    }

    if (!preview.selectedRestart) {
      this.state.status = "monitoring";
      this.state.reasonCode = "no_restart_candidate";
      this.state.reasonText =
        "Plant output is below the lower limit, but no eligible stopped non-exempt inverter can be restarted without exceeding the upper limit.";
      this.broadcastStatus();
      return this.getStatus({ refresh: false, includePreview: false });
    }
    const profile = preview.profiles.find(
      (item) => item.inverter === preview.selectedRestart.inverter,
    );
    if (profile) {
      await this.executeInverterAction(profile, 1, {
        actionType: "start",
        step: preview.selectedRestart,
      });
    }
    return this.getStatus({ refresh: true, includePreview: false });
  }
}

module.exports = {
  UNIT_KW_MAX,
  UNIT_KW_DEPENDABLE,
  MAX_UNITS_PER_INVERTER,
  DEFAULT_TICK_MS,
  DEFAULT_BREACH_HOLD_MS,
  DEFAULT_SETTLE_SEC,
  DEFAULT_LIVE_FRESH_MS,
  normalizeSequenceMode,
  normalizeSequenceCustom,
  normalizePlantCapSettings,
  getConfiguredUnitsForInverter,
  buildSequenceOrder,
  buildInverterProfiles,
  buildPlantCapPreview,
  PlantCapController,
};
