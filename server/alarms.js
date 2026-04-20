"use strict";
/**
 * alarms.js — Ingeteam INGECON SUN PowerMax 920TL DCAC Outdoor
 * Alarm register: 16-bit bitfield (AAV2015IQE01_B §19.2–19.4)
 * Audit log: every control action (start/stop node/all) is persisted
 */

const { db, stmts, getSetting } = require("./db");
const { broadcastUpdate } = require("./ws");
const { classifyAlarmTransition } = require("./alarmEpisodeCore");

// ─── 16-bit alarm bitfield ───────────────────────────────────────────────────
// Bit labels: fleet-canonical per AAV2015IQE01_B §19.2-19.4 (920TL variant).
// Metadata fields (altLabel/level1Ref/level2Ref/trinPM/schematicPage/
// physicalDevices) sourced from the Ingeteam service-reference PDFs in docs/:
//   Inverter-Incident-Workflow.pdf       (AAV2011IMC01_, Level 1, 06/2014)
//   Inverter-Incident-Workflow-Level2.pdf (AAV2011IFA01_, Level 2, 06/2014)
//   Inverter-Schematic-Diagram.pdf        (AQM0027, 22pp wiring)
const ALARM_BITS = [
  {
    bit: 0,
    hex: "0001",
    label: "Frequency Alarm",
    severity: "warning",
    description: "Grid frequency out of range",
    action: "Check grid frequency; verify FREC setpoints §16.5.2",
    altLabel: "Grid frequency out of range (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=6",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=6",
    trinPM: ["TrinPM12", "TrinPM16", "TrinPM18", "TrinPM20", "TrinPM10"],
    schematicPage: 6,
    physicalDevices: ["AC output terminal bars", "Q4 thermal magnetic breaker", "AC varistors", "AC surge arresters (RVAC)"],
  },
  {
    bit: 1,
    hex: "0002",
    label: "Voltage Alarm",
    severity: "warning",
    description: "Grid voltage out of range (over/under)",
    action: "Check grid voltage at AC terminals; verify VAC setpoints",
    altLabel: "Grid voltage out of range (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=6",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=6",
    trinPM: ["TrinPM12", "TrinPM16", "TrinPM18", "TrinPM20", "TrinPM10"],
    schematicPage: 6,
    physicalDevices: ["AC output terminal bars", "Q4 thermal magnetic breaker", "AC varistors", "AC surge arresters (RVAC)"],
  },
  {
    bit: 2,
    hex: "0004",
    label: "Current Control Fault",
    severity: "fault",
    description: "Internal current control loop saturation",
    action: "Restart inverter; if persists contact service §8.4",
    altLabel: "Control current saturation (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=7",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=7",
    trinPM: ["TrinPM18", "TrinPM20", "TrinPM03", "TrinPM04"],
    schematicPage: 5,
    physicalDevices: ["Back inductors", "Q2 disconnect", "K1 contactor", "Current sensor wiring"],
    debugDesc: { "40": "Check J4/J5/J21 measuring-board connectors", "92": "Calibrate reactive power (TrinPM20)", "107,108,109": "Check Vdc values; route to 8000H workflow" },
  },
  {
    bit: 3,
    hex: "0008",
    label: "DSP Watchdog Reset",
    severity: "fault",
    description: "Inverter DSP watchdog reset — firmware fault",
    action: "Restart inverter; update firmware if repeating §19.4",
    altLabel: "Reset (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=7",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=8",
    trinPM: ["TrinPM21", "TrinPM19"],
    schematicPage: 22,
    physicalDevices: ["CAN bus", "SCADA comms link"],
    note: "If SCADA polls faster than 1/sec the inverter will repeatedly reset.",
  },
  {
    bit: 4,
    hex: "0010",
    label: "RMS Overcurrent",
    severity: "fault",
    description: "RMS AC output current exceeds maximum",
    action: "Check AC wiring and load; reduce connected load",
    altLabel: "Effective grid current (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=8",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=8",
    trinPM: ["TrinPM18", "TrinPM20", "TrinPM19", "TrinPM03", "TrinPM04"],
    schematicPage: 6,
    physicalDevices: ["AC current sensors"],
    note: "If 0090/0880/0890 co-occur, replace electronic block (TrinPM03/04).",
  },
  {
    bit: 5,
    hex: "0020",
    label: "Overtemperature",
    severity: "fault",
    description: "Power electronics temperature > 80°C",
    action: "Check ventilation, ambient temp, and cooling fans §7.3",
    altLabel: "Temperature (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=8",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=9",
    trinPM: ["TrinPM14", "TrinPM03", "TrinPM04", "TrinPM05"],
    schematicPage: 17,
    physicalDevices: ["NTC sensors", "Thermal switches", "15Vdc power supply", "Cooling fans", "Air filters"],
    note: "If ambient > 45°C, classify as weather-driven (see Phase 4 roadmap).",
  },
  {
    bit: 6,
    hex: "0040",
    label: "ADC / Sync Error",
    severity: "fault",
    description: "ADC reading error or loss of grid sync",
    action: "Check grid quality; verify CT/VT connections §9.2",
    altLabel: "Hardware fault (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=9",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=10",
    trinPM: ["TrinPM23", "TrinPM08", "TrinPM18"],
    schematicPage: 21,
    physicalDevices: ["Fiber optic cables", "Synchronism card", "LVRT kit", "X8.4-X8.8 aux wiring"],
    debugDesc: { "55,56": "Master-slave stop cascade — reconnect master", "119": "DC contactor or LVRT kit status" },
  },
  {
    bit: 7,
    hex: "0080",
    label: "Instantaneous Overcurrent",
    severity: "fault",
    description: "Instantaneous AC current out of range",
    action: "Check for AC short; inspect cabling and breaker Q2n",
    altLabel: "Instantaneous grid current (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=9",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=11",
    trinPM: ["TrinPM18", "TrinPM03", "TrinPM04"],
    schematicPage: 5,
    physicalDevices: ["Current sensor connectors on electronic block"],
  },
  {
    bit: 8,
    hex: "0100",
    label: "AC Protection Fault",
    severity: "critical",
    description: "AC surge arresters (RVAC), fuses (FAC), or breaker (Q2n)",
    action: "Inspect RVAC, FAC, and Q2n; replace if blown §10.3",
    altLabel: "AC protection (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=10",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=12",
    trinPM: ["TrinPM10", "TrinPM25", "TrinPM26", "TrinPM19"],
    schematicPage: 12,
    physicalDevices: ["Qac/Qaux/Q2n/Q4n magnetic breakers", "K1 AC contactor", "RVAC arresters"],
    note: "0102 co-occurrence (0x0100|0x0002) indicates post-reconnect frequency follow-on.",
  },
  {
    bit: 9,
    hex: "0200",
    label: "DC Protection Fault",
    severity: "critical",
    description: "DC fuses (FDC), surge arresters (RVDC), or PV grounding",
    action: "Inspect FDC, RVDC, grounding kit; replace if blown §10.2",
    altLabel: "DC protection (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=11",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=13",
    trinPM: ["TrinPM10", "TrinPM03", "TrinPM04"],
    schematicPage: 14,
    schematicPageExtra: 16,
    physicalDevices: ["QDC disconnect (schematic p.14)", "RVDC arresters (schematic p.16)", "XFDC DC fuses", "Grounding-kit breaker"],
  },
  {
    bit: 10,
    hex: "0400",
    label: "Insulation / Ground Fault",
    severity: "critical",
    description: "DC insulation failure in PV array or inverter",
    action: "Isolate strings; measure insulation resistance §11.4",
    altLabel: "DC insulation (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=12",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=13",
    trinPM: ["TrinPM06", "TrinPM10", "TrinPM27", "TrinPM28", "TrinPM29"],
    schematicPage: 4,
    physicalDevices: ["DC contactor", "RVDC arresters", "PV string insulation"],
  },
  {
    bit: 11,
    hex: "0800",
    label: "Contactor Fault",
    severity: "fault",
    description: "AC contactor state mismatch",
    action: "Inspect AC contactor K1; verify control wiring §12.1",
    altLabel: "Branch fault (AAV2011 L1/L2 — variant may differ)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=12",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=14",
    trinPM: ["TrinPM18"],
    schematicPage: 12,
    physicalDevices: ["K1 AC contactor (per fleet doc)", "Branches 1-3 (per 2011 docs, variant-only)"],
    variantWarning: "Bit 11 diverges between fleet and 2011 docs. Fleet (920TL, AAV2015IQE01_B) = contactor fault → inspect K1. AAV2011 Level 1/2 map 0x0800 to branch fault → download 15-day history via SUN Manager, escalate to SAT. Verify fleet doc FIRST; the L2 branch-fault flow does NOT apply to the 920TL.",
  },
  {
    bit: 12,
    hex: "1000",
    label: "Manual Shutdown",
    severity: "info",
    description: "Emergency stop, display STOP, or remote command",
    action: "Check shutdown source; restart when safe §16.5.2",
    altLabel: "Manual shutdown (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=13",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=15",
    trinPM: ["TrinPM05", "TrinPM19", "TrinPM03", "TrinPM04"],
    schematicPage: 15,
    physicalDevices: ["Emergency stop SW2", "Limit switches", "Door sensors", "XMON(n).7 wiring"],
    stopReasonSubcodes: ["1320", "1360", "1363"],
  },
  {
    bit: 13,
    hex: "2000",
    label: "Configuration Change",
    severity: "info",
    description: "Firmware update or config parameter change",
    action: "Verify parameters after update; restart if needed §16.4",
    altLabel: "Configuration / Firmware (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=14",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=16",
    trinPM: ["TrinPM19"],
    schematicPage: null,
    physicalDevices: ["Firmware configuration (no physical device)"],
  },
  {
    bit: 14,
    hex: "4000",
    label: "DC Overvoltage",
    severity: "critical",
    description: "DC input voltage exceeds 1000 VDC",
    action: "Disconnect PV strings immediately; inspect surge arresters §10.2",
    altLabel: "High input voltage (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=14",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=16",
    trinPM: ["TrinPM20", "TrinPM19"],
    schematicPage: 4,
    physicalDevices: ["PV array (oversized — contact plant designer)"],
    note: "AAV2011 L1 p.14: 'inverter status is fine but PV array has been sized incorrectly — inverter guarantee lost'.",
  },
  {
    bit: 15,
    hex: "8000",
    label: "DC Undervoltage / Low Power",
    severity: "warning",
    description: "Vdc too low or insufficient PV power (normal at dawn/dusk)",
    action: "Normal at low irradiance; check strings if midday §11.3",
    altLabel: "Panel voltage / Low input voltage (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=14",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=17",
    trinPM: ["TrinPM20", "TrinPM19"],
    schematicPage: 4,
    physicalDevices: ["PV array (undersized) or nightfall (normal)"],
  },
];

// Fatal-error state (all lower 15 bits set). Per AAV2011 L1 p.14:
//   "When a FATAL ERROR occurs, the inverter is unblocked by entering a code
//    through the display." — cannot be auto-reset remotely.
const FATAL_ALARM_VALUE = 0x7fff;

// Stop-reason sub-codes surfaced under 0x1000 (Manual shutdown) per L2 p.15.
// Read from the inverter display / stop-reason register (not in the 16-bit
// alarm word). Included here for UI drilldown reference.
const STOP_REASON_SUBCODES = {
  "1320": "15 Vdc power supply LED off — replace PSU if damaged",
  "1360": "Auxiliaries state fault — check auxiliary services (TrinPM05)",
  "1363": "Auxiliaries state fault — check +15Vdc at U(n)J19.8↔U(n)J19.10",
};

// Service reference documents, resolved relative to the app's /docs folder
// served by Express static. GitHub raw URLs provide the canonical copy so the
// renderer can offer a cross-origin auto-download that survives installer
// boundaries.
const SERVICE_DOCS = {
  schematic:    "Inverter-Schematic-Diagram.pdf",
  level1:       "Inverter-Incident-Workflow.pdf",
  level2:       "Inverter-Incident-Workflow-Level2.pdf",
  sunManager:   "INGECON-SUN-Manager-User-Manual.pdf",
};
const SERVICE_DOCS_GITHUB_BASE =
  "https://raw.githubusercontent.com/mclards/ADSI-Dashboard/main/docs";

const STOP_REASONS = {
  FREC: "Grid Frequency Out of Range",
  VAC: "Grid Voltage Out of Range",
  TEMPERATURE: "Overtemperature",
  "INS.FAILURE": "Insulation / Ground Fault",
  "FATAL ERROR": "Fatal Firmware Error — Contact Service",
  "LOW POWER": "Insufficient PV Power (Low Irradiance)",
  "REMOTE STOP": "Remote Stop Command Received",
  "EMERG STOP": "Emergency Stop Activated",
  OVERCURRENT: "AC Overcurrent Protection Triggered",
};

const SEV_ORDER = { critical: 4, fault: 3, warning: 2, info: 1 };

function decodeAlarm(val) {
  if (!val || val === 0) return [];
  return ALARM_BITS.filter((b) => (val & (1 << b.bit)) !== 0).map((b) => ({
    ...b,
    active: true,
  }));
}

function getTopSeverity(val) {
  const bits = decodeAlarm(val);
  if (!bits.length) return null;
  return bits.reduce(
    (best, b) => (SEV_ORDER[b.severity] > SEV_ORDER[best.severity] ? b : best),
    bits[0],
  ).severity;
}

function formatAlarmHex(val) {
  if (!val) return "0000H";
  return val.toString(16).toUpperCase().padStart(4, "0") + "H";
}

// ─── Active alarm state tracker ───────────────────────────────────────────────
const activeAlarmState = {}; // key: `${inv}_${unit}` → last alarm_value logged
const CONFIG_CACHE_MS = 5000;
let configuredNodeCache = { ts: 0, set: null };

// Module-level prepared statement — avoids re-preparing on every logControlAction call.
const stmtInsertAudit = db.prepare(`
  INSERT INTO audit_log (ts, operator, inverter, node, action, scope, result, ip, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function hydrateActiveAlarmStateFromDb() {
  try {
    // Reset to DB truth at process start so persistent active alarms
    // are not re-recorded/re-broadcast as new events after restart.
    for (const key of Object.keys(activeAlarmState)) {
      delete activeAlarmState[key];
    }
    const rows = stmts.getActiveAlarms.all();
    for (const r of rows || []) {
      const inv = Number(r?.inverter || 0);
      const unit = Number(r?.unit || 0);
      const alarmVal = Number(r?.alarm_value || 0);
      if (!inv || !unit || !alarmVal) continue;
      if (!isConfiguredNode(inv, unit)) continue;
      activeAlarmState[`${inv}_${unit}`] = alarmVal;
    }
  } catch (err) {
    // Best effort only; polling path will recover naturally.
    console.warn("[alarms] hydrateActiveAlarmStateFromDb failed:", err.message);
  }
}

function getConfiguredNodeSet() {
  const now = Date.now();
  if (configuredNodeCache.set && now - configuredNodeCache.ts < CONFIG_CACHE_MS) {
    return configuredNodeCache.set;
  }

  const set = new Set();
  try {
    const row = stmts.getSetting.get("ipConfigJson");
    const raw = row && row.value ? JSON.parse(row.value) : {};
    const unitsMap = raw && typeof raw === "object" ? raw.units || {} : {};
    for (let inv = 1; inv <= 27; inv++) {
      const unitsRaw = unitsMap[inv] ?? unitsMap[String(inv)] ?? [1, 2, 3, 4];
      const units = Array.isArray(unitsRaw)
        ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
        : [1, 2, 3, 4];
      for (const unit of [...new Set(units)]) {
        set.add(`${inv}_${unit}`);
      }
    }
  } catch (err) {
    // Fail-open fallback: keep all possible nodes if config is temporarily unreadable.
    console.warn("[alarms] getConfiguredNodeSet failed, using all nodes as fallback:", err.message);
    for (let inv = 1; inv <= 27; inv++) {
      for (let unit = 1; unit <= 4; unit++) {
        set.add(`${inv}_${unit}`);
      }
    }
  }

  configuredNodeCache = { ts: now, set };
  return set;
}

function isConfiguredNode(inverter, unit) {
  return getConfiguredNodeSet().has(`${Number(inverter) || 0}_${Number(unit) || 0}`);
}

function getActiveAlarms() {
  const rows = stmts
    .getActiveAlarms
    .all()
    .filter((r) => isConfiguredNode(r.inverter, r.unit));

  // Harden: if legacy duplicate active rows exist for one node,
  // keep only the latest row so UI tracker + table stay consistent.
  const latestByNode = new Map();
  for (const r of rows) {
    if (r.inverter == null || r.unit == null) continue;
    const key = `${Number(r.inverter || 0)}_${Number(r.unit || 0)}`;
    if (!key || key === "0_0") continue;
    if (!latestByNode.has(key)) {
      latestByNode.set(key, r);
      continue;
    }
    const prev = latestByNode.get(key);
    const curTs = Number(r?.ts || 0);
    const prevTs = Number(prev?.ts || 0);
    const curId = Number(r?.id || 0);
    const prevId = Number(prev?.id || 0);
    if (curTs > prevTs || (curTs === prevTs && curId > prevId)) {
      latestByNode.set(key, r);
    }
  }
  return Array.from(latestByNode.values()).sort(
    (a, b) =>
      Number(b?.ts || 0) - Number(a?.ts || 0) ||
      Number(b?.id || 0) - Number(a?.id || 0),
  );
}

function checkAlarms(batch) {
  const newAlarms = [];
  const now = Date.now();
  const configured = getConfiguredNodeSet();

  // Remove in-memory alarm states for nodes no longer configured.
  for (const key of Object.keys(activeAlarmState)) {
    if (!configured.has(key)) delete activeAlarmState[key];
  }

  for (const row of batch) {
    if (!isConfiguredNode(row.inverter, row.unit)) continue;
    const key = `${row.inverter}_${row.unit}`;
    const prev = activeAlarmState[key];
    const cur = row.alarm || 0;

    if (prev === undefined) {
      // T2.5 fix (Phase 5, 2026-04-14): hydrate from any existing
      // not-yet-cleared DB row before deciding whether to INSERT a new
      // active alarm.  Without this, every server restart that finds a
      // unit still alarming would insert a SECOND active row, inflating
      // counts and breaking episode grouping.
      const existing = stmts.getActiveAlarmForUnit
        ? stmts.getActiveAlarmForUnit.get(row.inverter, row.unit)
        : null;
      if (existing && cur !== 0) {
        // Re-attach to existing episode.  If the alarm value drifted while
        // we were down (e.g. additional bits set), patch the stored row in
        // place rather than spawning a duplicate.
        if (Number(existing.alarm_value) !== cur) {
          const severity = getTopSeverity(cur) || "fault";
          stmts.updateActiveAlarm.run(
            formatAlarmHex(cur),
            cur,
            severity,
            row.inverter,
            row.unit,
          );
        }
        activeAlarmState[key] = cur;
        continue;
      }
      if (existing && cur === 0) {
        // We're down, the unit cleared; close the existing row.
        stmts.clearAlarm.run(now, row.inverter, row.unit);
        activeAlarmState[key] = 0;
        continue;
      }
      activeAlarmState[key] = cur;
      if (cur !== 0) {
        const severity = getTopSeverity(cur) || "fault";
        stmts.insertAlarm.run({
          ts: now,
          inverter: row.inverter,
          unit: row.unit,
          alarm_code: formatAlarmHex(cur),
          alarm_value: cur,
          severity,
        });
        newAlarms.push({
          inverter: row.inverter,
          unit: row.unit,
          alarm_value: cur,
          severity,
          decoded: decodeAlarm(cur),
        });
      }
      continue;
    }

    const transition = classifyAlarmTransition(prev, cur);
    if (transition === "noop") continue;

    if (transition === "clear") {
      stmts.clearAlarm.run(now, row.inverter, row.unit);
      activeAlarmState[key] = 0;
      continue;
    }

    if (transition === "update_active") {
      const severity = getTopSeverity(cur) || "fault";
      stmts.updateActiveAlarm.run(
        formatAlarmHex(cur),
        cur,
        severity,
        row.inverter,
        row.unit,
      );
      activeAlarmState[key] = cur;
      continue;
    }

    if (transition === "raise") {
      const severity = getTopSeverity(cur) || "fault";
      const info = stmts.insertAlarm.run({
        ts: now,
        inverter: row.inverter,
        unit: row.unit,
        alarm_code: formatAlarmHex(cur),
        alarm_value: cur,
        severity,
      });
      newAlarms.push({
        id: Number(info?.lastInsertRowid || 0),
        inverter: row.inverter,
        unit: row.unit,
        alarm_value: cur,
        severity,
        decoded: decodeAlarm(cur),
        ts: now,
      });
      activeAlarmState[key] = cur;
    }
  }

  if (newAlarms.length) {
    broadcastUpdate({ type: "alarm", alarms: newAlarms });
  }
}

// ─── Audit Log ────────────────────────────────────────────────────────────────
function logControlAction({
  operator = "OPERATOR",
  inverter,
  node,
  action,
  scope,
  result,
  ip,
  reason,
}) {
  const inv = Number(inverter || 0);
  const nd  = Number(node || 0);
  const invMax = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const nodeMax = Math.max(1, Number(getSetting("nodeCount", 4)) || 4);

  if (!Number.isFinite(inv) || inv < 1 || inv > invMax) {
    console.warn("[alarms] logControlAction: invalid inverter value:", inverter);
    return;
  }
  // node 0 = ALL nodes; 1..nodeMax are individual nodes.
  if (!Number.isFinite(nd) || nd < 0 || nd > nodeMax) {
    console.warn("[alarms] logControlAction: invalid node value:", node);
    return;
  }

  const ts = Date.now();
  stmtInsertAudit.run(
    ts,
    operator || "OPERATOR",
    inv,
    nd,
    action,
    scope || "single",
    result || "ok",
    ip || "",
    reason || "",
  );
}

// Seed active in-memory alarm state from persisted active alarms.
hydrateActiveAlarmStateFromDb();

function getInverterIpMap() {
  try {
    const row = stmts.getSetting.get("ipConfigJson");
    const raw = row && row.value ? JSON.parse(row.value) : {};
    const src = raw && typeof raw === "object" ? raw.inverters || {} : {};
    const invCount = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
    const map = {};
    for (let inv = 1; inv <= invCount; inv++) {
      const v = String(src[inv] ?? src[String(inv)] ?? "").trim();
      if (v) map[inv] = v;
    }
    for (const [k, vRaw] of Object.entries(src || {})) {
      const inv = Math.trunc(Number(k));
      if (!Number.isFinite(inv) || inv < 1 || map[inv]) continue;
      const v = String(vRaw ?? "").trim();
      if (v) map[inv] = v;
    }
    return map;
  } catch (err) {
    console.warn("[alarms] getInverterIpMap failed:", err.message);
    return {};
  }
}

function isLoopbackIp(v) {
  const ip = String(v || "").trim().toLowerCase();
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip === "localhost" ||
    ip === "::ffff:127.0.0.1"
  );
}

function withAuditIpFallback(rows) {
  const ipMap = getInverterIpMap();
  return (rows || []).map((r) => {
    const cur = String(r?.ip || "").trim();
    if (cur && !isLoopbackIp(cur)) return r;
    const inv = Number(r?.inverter || 0);
    const fallbackIp = String(ipMap[inv] || "").trim();
    if (!fallbackIp) return r;
    return { ...r, ip: fallbackIp };
  });
}

function getAuditLog({ start, end, inverter, limit = 500 } = {}) {
  const s = start || 0;
  const e = end || Date.now();
  const safeLimit = Math.min(20000, Math.max(1, Math.trunc(Number(limit) || 5000)));
  const invNum = Math.trunc(Number(inverter || 0));
  let rows;
  if (Number.isFinite(invNum) && invNum > 0) {
    rows = db
      .prepare(
        `SELECT * FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(invNum, s, e, safeLimit);
    return withAuditIpFallback(rows);
  }
  rows = db
    .prepare(
      `SELECT * FROM audit_log WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(s, e, safeLimit);
  return withAuditIpFallback(rows);
}

module.exports = {
  decodeAlarm,
  getTopSeverity,
  formatAlarmHex,
  checkAlarms,
  getActiveAlarms,
  logControlAction,
  getAuditLog,
  ALARM_BITS,
  STOP_REASONS,
  STOP_REASON_SUBCODES,
  SERVICE_DOCS,
  SERVICE_DOCS_GITHUB_BASE,
  FATAL_ALARM_VALUE,
  classifyAlarmTransition,
};

