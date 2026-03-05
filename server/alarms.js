"use strict";
/**
 * alarms.js — Ingeteam INGECON SUN PowerMax 920TL DCAC Outdoor
 * Alarm register: 16-bit bitfield (AAV2015IQE01_B §19.2–19.4)
 * Audit log: every control action (start/stop node/all) is persisted
 */

const { db, stmts, getSetting } = require("./db");
const { broadcastUpdate } = require("./ws");

// ─── 16-bit alarm bitfield ───────────────────────────────────────────────────
const ALARM_BITS = [
  {
    bit: 0,
    hex: "0001",
    label: "Frequency Alarm",
    severity: "warning",
    description: "Grid frequency out of range",
    action: "Check grid frequency; verify FREC setpoints §16.5.2",
  },
  {
    bit: 1,
    hex: "0002",
    label: "Voltage Alarm",
    severity: "warning",
    description: "Grid voltage out of range (over/under)",
    action: "Check grid voltage at AC terminals; verify VAC setpoints",
  },
  {
    bit: 2,
    hex: "0004",
    label: "Current Control Fault",
    severity: "fault",
    description: "Internal current control loop saturation",
    action: "Restart inverter; if persists contact service §8.4",
  },
  {
    bit: 3,
    hex: "0008",
    label: "DSP Watchdog Reset",
    severity: "fault",
    description: "Inverter DSP watchdog reset — firmware fault",
    action: "Restart inverter; update firmware if repeating §19.4",
  },
  {
    bit: 4,
    hex: "0010",
    label: "RMS Overcurrent",
    severity: "fault",
    description: "RMS AC output current exceeds maximum",
    action: "Check AC wiring and load; reduce connected load",
  },
  {
    bit: 5,
    hex: "0020",
    label: "Overtemperature",
    severity: "fault",
    description: "Power electronics temperature > 80°C",
    action: "Check ventilation, ambient temp, and cooling fans §7.3",
  },
  {
    bit: 6,
    hex: "0040",
    label: "ADC / Sync Error",
    severity: "fault",
    description: "ADC reading error or loss of grid sync",
    action: "Check grid quality; verify CT/VT connections §9.2",
  },
  {
    bit: 7,
    hex: "0080",
    label: "Instantaneous Overcurrent",
    severity: "fault",
    description: "Instantaneous AC current out of range",
    action: "Check for AC short; inspect cabling and breaker Q2n",
  },
  {
    bit: 8,
    hex: "0100",
    label: "AC Protection Fault",
    severity: "critical",
    description: "AC surge arresters (RVAC), fuses (FAC), or breaker (Q2n)",
    action: "Inspect RVAC, FAC, and Q2n; replace if blown §10.3",
  },
  {
    bit: 9,
    hex: "0200",
    label: "DC Protection Fault",
    severity: "critical",
    description: "DC fuses (FDC), surge arresters (RVDC), or PV grounding",
    action: "Inspect FDC, RVDC, grounding kit; replace if blown §10.2",
  },
  {
    bit: 10,
    hex: "0400",
    label: "Insulation / Ground Fault",
    severity: "critical",
    description: "DC insulation failure in PV array or inverter",
    action: "Isolate strings; measure insulation resistance §11.4",
  },
  {
    bit: 11,
    hex: "0800",
    label: "Contactor Fault",
    severity: "fault",
    description: "AC contactor state mismatch",
    action: "Inspect AC contactor K1; verify control wiring §12.1",
  },
  {
    bit: 12,
    hex: "1000",
    label: "Manual Shutdown",
    severity: "info",
    description: "Emergency stop, display STOP, or remote command",
    action: "Check shutdown source; restart when safe §16.5.2",
  },
  {
    bit: 13,
    hex: "2000",
    label: "Configuration Change",
    severity: "info",
    description: "Firmware update or config parameter change",
    action: "Verify parameters after update; restart if needed §16.4",
  },
  {
    bit: 14,
    hex: "4000",
    label: "DC Overvoltage",
    severity: "critical",
    description: "DC input voltage exceeds 1000 VDC",
    action: "Disconnect PV strings immediately; inspect surge arresters §10.2",
  },
  {
    bit: 15,
    hex: "8000",
    label: "DC Undervoltage / Low Power",
    severity: "warning",
    description: "Vdc too low or insufficient PV power (normal at dawn/dusk)",
    action: "Normal at low irradiance; check strings if midday §11.3",
  },
];

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
  INSERT INTO audit_log (ts, operator, inverter, node, action, scope, result, ip)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      // First time seeing this unit
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

    if (cur !== prev) {
      // Close prior active alarm episode whenever alarm value changes
      // (nonzero->nonzero or nonzero->zero). This prevents multiple
      // simultaneous active rows for one node.
      if (prev !== 0) {
        stmts.clearAlarm.run(now, row.inverter, row.unit);
      }

      // New alarm raised (new active episode)
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
};

