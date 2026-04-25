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
    description: "Grid frequency out of range — inverter disconnects until the grid stabilizes.",
    action: "Verify grid frequency. The inverter auto-reconnects once the grid is back within FREC setpoints.",
    actionSteps: [
      "Read grid frequency at the AC terminals (meter or SUN Manager live view).",
      "Reading within ±0.5 Hz of nominal: no action — inverter auto-reconnects.",
      "Reading out of range: grid-side issue — notify utility / plant operator.",
      "Alarm persists on a stable grid: verify FREC high/low setpoints in SUN Manager (§16.5.2).",
    ],
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
    description: "Grid voltage out of range (over/under) — inverter disconnects until the grid stabilizes.",
    action: "Verify grid voltage. The inverter auto-reconnects once the grid is back within VAC setpoints.",
    actionSteps: [
      "Read line-to-line voltage at the AC terminals (meter or SUN Manager live view).",
      "Reading within VAC min/max setpoints: no action — inverter auto-reconnects.",
      "Reading out of range: grid-side issue — notify utility.",
      "Alarm persists on a stable grid: verify VAC min/max setpoints in SUN Manager.",
    ],
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
    description: "Internal current control loop saturated — the inverter could not hold its AC current reference.",
    action: "Attempt a remote restart; follow the DebugDesc value to narrow the cause; escalate if it repeats.",
    actionSteps: [
      "Remote-restart from the dashboard or INGECON SUN Manager.",
      "DebugDesc 40: reseat the J4/J5/J21 measuring-board connectors and restart.",
      "DebugDesc 92: reactive-power calibration required (TrinPM20).",
      "DebugDesc 107/108/109: cross-check the DC Undervoltage (0x8000) workflow — Vdc source is suspect.",
      "Fault repeats within 1 hour: pull a SCOPE log and escalate to Ingeteam SAT (§8.4).",
    ],
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
    description: "Inverter DSP watchdog fired — firmware or comms-induced reset.",
    action: "One-off resets self-recover. Only intervene if the reset loops: verify poll rate, then comms, then firmware.",
    actionSteps: [
      "Single reset with clean reconnect: no action required.",
      "Verify SCADA / poller interval is ≥ 1 s. Faster polling forces repeat resets (see Note).",
      "Inspect CAN bus and fiber to the synchronism card — reseat any loose connectors.",
      "Loop persists after poll-rate and comms checks: firmware update required (§19.4) — escalate to Ingeteam SAT.",
    ],
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
    description: "RMS AC output current exceeded the inverter's rated maximum.",
    action: "Do NOT reset first. Inspect the AC output for shorts and verify current sensors before re-energizing.",
    actionSteps: [
      "⚠ Do not attempt a remote reset until the AC output is physically inspected.",
      "Open Q2n and verify AC cabling integrity; check for short-to-ground downstream of the inverter.",
      "Inspect AC current sensors (schematic p.6) — reseat or clean contaminated connectors.",
      "If 0x0090 / 0x0880 / 0x0890 co-occur on the same unit: replace the electronic block (TrinPM03/04).",
      "Close Q2n and remote-restart only after the circuit is verified clean.",
    ],
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
    description: "Power-electronics temperature exceeded 80 °C — the inverter de-rates then stops to protect the IGBTs.",
    action: "Distinguish environment-driven from hardware-driven. Clean cooling path and allow cooldown before restart.",
    actionSteps: [
      "Check cabinet ambient. Above 45 °C → environment-driven (weather), not a defect.",
      "Inspect cooling fans (rotation, bearing noise) and air filters — clean or replace if clogged.",
      "Verify the 15 Vdc PSU is energizing the fans.",
      "Check NTC sensors and thermal switches (schematic p.17) for open or out-of-tolerance readings.",
      "Allow cooldown below 70 °C, then remote-restart (§7.3).",
    ],
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
    description: "ADC reading error or loss of grid synchronism — the inverter cannot trust its measurement path.",
    action: "Check the measurement path (CT/VT, fiber, sync card) and follow the DebugDesc sub-code.",
    actionSteps: [
      "Verify CT / VT wiring at X8.4–X8.8 and the synchronism card (schematic p.21).",
      "Check fiber-optic links between inverter and LVRT kit — reseat if dusty or misaligned.",
      "DebugDesc 55 / 56: master-slave stop cascade — reconnect the master first; slaves recover automatically.",
      "DebugDesc 119: DC contactor or LVRT kit state is abnormal — inspect before any reset.",
      "Grid quality (harmonics, dips, flicker) suspected: escalate to utility (§9.2).",
    ],
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
    description: "Instantaneous AC current exceeded the peak protection threshold — a hard AC fault is likely.",
    action: "De-energize before inspection. Look for AC short, then sensor/IGBT damage.",
    actionSteps: [
      "⚠ Open Q2n AND Qac before any physical inspection — the AC side may remain energized from the grid.",
      "Visually inspect AC cabling for insulation damage, burn marks, or water ingress.",
      "Check current-sensor connectors on the electronic block (schematic p.5); reseat if disturbed.",
      "No external fault found: internal sensor or IGBT gate driver may be damaged — pull a SCOPE log and escalate to SAT.",
    ],
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
    description: "AC protection device tripped — surge arresters (RVAC), fuses (FAC), or breakers (Qac/Q2n/Qaux/Q4n).",
    action: "Lockout before inspection. Check every AC protection device; replace if tripped or degraded.",
    actionSteps: [
      "⚠ Lockout / tag-out Q2n AND Qac — the AC side stays live from the grid even with inverter stopped.",
      "Inspect RVAC surge arresters (schematic p.12). Pilot flag or discoloration → replace.",
      "Inspect FAC AC fuses. Replace with the same rating if any are blown.",
      "Inspect Q2n / Qac / Qaux / Q4n magnetic breakers. Reset if tripped; replace if mechanically damaged.",
      "Inspect K1 AC contactor for welded or burned contacts.",
      "0x0102 co-occurrence (this bit + Voltage) = post-reconnect frequency follow-on — work the bit 1 (Voltage) flow first.",
      "Close breakers and re-energize only after every protection device is verified. Escalate to SAT on repeat (§10.3).",
    ],
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
    description: "DC protection device tripped — fuses (XFDC), surge arresters (RVDC), or the grounding-kit breaker.",
    action: "Lockout QDC before inspection. PV strings still feed DC side even at night.",
    actionSteps: [
      "⚠ Open QDC and lockout (schematic p.14). DC side remains energized by the PV strings.",
      "Inspect XFDC DC fuses. Replace all fuses in a parallel bank as a set if any are blown.",
      "Inspect RVDC surge arresters (schematic p.16). Replace if pilot flag is shown.",
      "Verify the grounding-kit breaker state; reset if tripped.",
      "Measure DC insulation resistance before reconnecting (follow the bit 10 workflow).",
      "Close QDC only after every protection device is confirmed intact. Escalate to SAT on repeat (§10.2).",
    ],
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
    description: "DC insulation resistance fell below the safe threshold — the PV array or wiring is leaking to ground.",
    action: "Lockout. Isolate strings and find the faulty one with an insulation tester.",
    actionSteps: [
      "⚠ Open QDC and place the inverter in SAFE state before any string work.",
      "Disconnect all PV strings at the combiner or string inputs.",
      "Measure insulation resistance (PV+ vs. GND, PV- vs. GND) at 1000 Vdc per string. IEC 62446 threshold: ≥ 1 MΩ per string.",
      "Reconnect strings one at a time to identify the faulty string.",
      "Inspect the faulty string for water ingress, damaged cable jackets, or degraded MC4 connectors.",
      "All strings pass but alarm persists: DC contactor or the internal insulation monitor may be faulty — escalate to SAT (§11.4).",
    ],
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
    description: "AC contactor K1 state does not match the commanded state (fleet-specific — see variant warning).",
    action: "Use the fleet (920TL) K1 procedure. Do NOT follow the AAV2011 branch-fault flow.",
    actionSteps: [
      "⚠ Follow the 920TL fleet procedure below. AAV2011 Level 1/2 map this bit to branch-fault, which does NOT apply here.",
      "Open Q2n to isolate the AC output.",
      "Inspect K1 AC contactor (schematic p.12) for welded contacts, burned auxiliaries, or open-circuit coil.",
      "Verify XK1 auxiliary feedback matches the actual contactor state — mismatched feedback is the usual trigger.",
      "Measure coil resistance against the value stamped on the contactor body.",
      "K1 mechanically good and wiring intact: replace the control board that drives K1 (§12.1). Escalate to SAT on repeat.",
    ],
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
    description: "Inverter was stopped by emergency stop, door sensor, display STOP, or a remote command.",
    action: "Identify the shutdown source before restart. Do NOT blind-restart.",
    actionSteps: [
      "Do NOT blind-restart — identify the shutdown source first.",
      "Check SW2 emergency stop (schematic p.15). Release if engaged.",
      "Check door sensors, limit switches, and XMON(n).7 wiring. Open-circuit (contacts released) reads as STOP.",
      "Review the stop-reason sub-code (see table below): 1320 → replace PSU; 1360 / 1363 → auxiliaries fault, check +15 Vdc at U(n)J19.8↔U(n)J19.10 (TrinPM05).",
      "Remote STOP sent via SUN Manager / SCADA: clear at the source before local restart.",
      "Once safe and source is cleared: remote-restart (§16.5.2).",
    ],
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
    description: "Firmware update or parameter change was logged — informational, not a fault.",
    action: "Verify the changed parameters match the commissioning record. No physical inspection needed.",
    actionSteps: [
      "Informational only — firmware or parameter change was logged.",
      "Open SUN Manager and review the changed parameters (grid code, setpoints, curtailment curves).",
      "Values match the commissioning record: acknowledge this alarm — no further action.",
      "Values drifted or unexpected: revert from the commissioning backup (§16.4) before the inverter runs unattended.",
    ],
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
    description: "DC input voltage exceeded 1000 Vdc — above the IGBT block rating; continued exposure damages hardware.",
    action: "IMMEDIATE: open QDC. Do NOT re-energize until the root cause (PV sizing / arrester) is resolved.",
    actionSteps: [
      "⚠ IMMEDIATE: open QDC. Vdc > 1000 V exceeds the IGBT rating; every additional minute risks cascading hardware damage.",
      "Disconnect PV strings at the combiner.",
      "Inspect RVDC surge arresters (schematic p.4) for trigger.",
      "Verify PV array sizing against inverter spec. Recurring 0x4000 at Tmin means the Voc cold-morning clamp was exceeded — the string is oversized for this inverter.",
      "Per AAV2011 L1 p.14: an oversized array voids the inverter guarantee. Contact the plant designer before re-energizing.",
      "Do NOT re-close QDC until the root cause is resolved.",
    ],
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
    description: "Vdc is below the MPPT operating range — usually irradiance-driven, not a fault.",
    action: "Expected at dawn / dusk / heavy overcast. Only investigate if alarming 09:00–15:00 on a clear day.",
    actionSteps: [
      "Alarming at dawn, dusk, or under heavy overcast: expected — no action.",
      "Alarming 09:00–15:00 on a clear day: investigate below.",
      "Read per-string voltages at the combiner. Any string below peers = string-level fault.",
      "Inspect the affected string for shading, soiling, or a disconnected MC4 connector.",
      "Verify QDC is fully closed and seated.",
      "All strings healthy but Vdc remains low: MPPT tracking may need recalibration (§11.3).",
    ],
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
    // getActiveAlarms returns rows ORDER BY ts DESC — keep first seen per
    // (inv,unit) so legacy duplicate open rows don't leave us tracking an
    // older alarm_value, which would then mis-classify the next batch as
    // update_active and cascade updates across stale rows.
    const rows = stmts.getActiveAlarms.all();
    for (const r of rows || []) {
      const inv = Number(r?.inverter || 0);
      const unit = Number(r?.unit || 0);
      const alarmVal = Number(r?.alarm_value || 0);
      if (!inv || !unit || !alarmVal) continue;
      if (!isConfiguredNode(inv, unit)) continue;
      const key = `${inv}_${unit}`;
      if (activeAlarmState[key] !== undefined) continue;
      activeAlarmState[key] = alarmVal;
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

  const invMax = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const nodeMax = Math.max(1, Number(getSetting("nodeCount", 4)) || 4);
  const defaultUnits = Array.from({ length: nodeMax }, (_, i) => i + 1);

  const set = new Set();
  try {
    const row = stmts.getSetting.get("ipConfigJson");
    const raw = row && row.value ? JSON.parse(row.value) : {};
    const unitsMap = raw && typeof raw === "object" ? raw.units || {} : {};
    for (let inv = 1; inv <= invMax; inv++) {
      const unitsRaw = unitsMap[inv] ?? unitsMap[String(inv)] ?? defaultUnits;
      const units = Array.isArray(unitsRaw)
        ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= nodeMax)
        : defaultUnits;
      for (const unit of [...new Set(units)]) {
        set.add(`${inv}_${unit}`);
      }
    }
  } catch (err) {
    // Fail-open fallback: keep all possible nodes if config is temporarily unreadable.
    console.warn("[alarms] getConfiguredNodeSet failed, using all nodes as fallback:", err.message);
    for (let inv = 1; inv <= invMax; inv++) {
      for (let unit = 1; unit <= nodeMax; unit++) {
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

function raiseActiveAlarm(row, cur, now, newAlarms) {
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
}

function updateActiveAlarmValue(row, cur) {
  const severity = getTopSeverity(cur) || "fault";
  stmts.updateActiveAlarm.run(
    formatAlarmHex(cur),
    cur,
    severity,
    row.inverter,
    row.unit,
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
        // Re-attach to existing episode. Patch in place on drift; do NOT
        // re-broadcast — the operator has already seen this toast.
        if (Number(existing.alarm_value) !== cur) {
          updateActiveAlarmValue(row, cur);
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
        raiseActiveAlarm(row, cur, now, newAlarms);
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
      updateActiveAlarmValue(row, cur);
      activeAlarmState[key] = cur;
      continue;
    }

    if (transition === "raise") {
      raiseActiveAlarm(row, cur, now, newAlarms);
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

