"use strict";

/**
 * server/calibrationSafety.js — TrinPM20 per-offset write-safety gates.
 *
 * Plan: plans/2026-05-12-inverter-calibration-tool.md §2.4
 *
 * The original calibrationRoutes.js shipped with two enforced gates
 *   (1) critical-block lock, (2) ValidCfgCode sentinel preserved
 *   (3) range-guard ±50 %, (4) sacupsMM auth, (5) session-id match)
 * but three gates from the original spec were never wired:
 *
 *   • Inverter must be in RUN state (not error / not stop / not blocked)
 *   • Fesc_ipv (DC current scale, offset 87) write requires Pac ≥ 70 % Pn
 *     so the IPV scale read-back is in the high-accuracy band the PDF
 *     specifies (TrinPM20 page on "DC SETTING" workflow)
 *   • Reactive-curve writes need consign at the matching setpoint
 *       offsets 91/92 → X1/Y1 require Pac ≈ 20 % Pn
 *       offsets 93/94 → X2/Y2 require Pac ≈ 70 % Pn
 *
 * This module exposes one pure function — `evaluateWriteSafety(offset,
 * liveSnapshot)` — that returns the per-offset writability verdict. The
 * route layer calls it before each write; if `ok=false` and the caller
 * has not passed `force_safety_gate=true`, the write is refused with a
 * 409 explaining which gate fired.
 *
 * Pure-function, no DB / no Modbus — testable from a fixture object.
 */

// Inverter Estado bitfield (reg 30074). Low byte = phase, high byte = flags.
//   phase: 0=initial, 1=initial-magnetization, 2=grid-connected, 3=error
//   bit 8 = stop, bit 9 = blocked, bit 10 = grid fault
const STATE_PHASE_GRID_CONNECTED = 2;
const STATE_PHASE_ERROR          = 3;

// TrinPM20 PDF page on DC SETTING. The IPV scale factor accuracy collapses
// at low current — the calibration target band is 70 % Pn ± 10 pp.
const FESC_IPV_OFFSET            = 87;
const FESC_IPV_MIN_PCT_OF_PN     = 70.0;

// Reactive-curve calibration points per TrinPM20:
//   X1Y1 at 20 % Pn (offsets 91, 92)
//   X2Y2 at 70 % Pn (offsets 93, 94)
const REACTIVE_X1Y1_OFFSETS = new Set([91, 92]);
const REACTIVE_X2Y2_OFFSETS = new Set([93, 94]);
const REACTIVE_X1Y1_TARGET_PCT = 20.0;
const REACTIVE_X2Y2_TARGET_PCT = 70.0;
// Tolerance window — the PAC reading must be within ±5 pp of the consign
// target. Mirrors the dwell-settled accuracy band on the field.
const REACTIVE_TOLERANCE_PCT_PP = 5.0;

function _stateOk(live) {
  if (!live) return { ok: false, reason: "no live snapshot" };
  // If state register couldn't be read at all (offline / Modbus miss),
  // refuse — calibration writes against an unobserved state risk writing
  // into a faulted inverter.
  if (live.state_raw == null) {
    return { ok: false, reason: "Inverter state register unreadable" };
  }
  if (Number(live.state_phase) === STATE_PHASE_ERROR) {
    return { ok: false, reason: "Inverter is in ERROR phase" };
  }
  if (Number(live.state_blocked) === 1) {
    return { ok: false, reason: "Inverter is BLOCKED" };
  }
  if (Number(live.state_grid_fault) === 1) {
    return { ok: false, reason: "Inverter reports GRID FAULT" };
  }
  if (Number(live.state_phase) !== STATE_PHASE_GRID_CONNECTED) {
    return { ok: false, reason: `Inverter not grid-connected (phase=${live.state_phase})` };
  }
  // bit 8 = stop. Calibration writes during stop are allowed for some
  // offsets (Per. Vacio in standby) — we don't refuse on `stop` here;
  // that's an offset-level decision below.
  return { ok: true };
}

/**
 * @param {number} offset
 * @param {object|null} live
 *   { state_raw, state_phase, state_stop, state_blocked, state_grid_fault,
 *     pac_w, nominal_power_w, pct_of_pn }
 * @returns {{ offset:number, ok:boolean, severity:"info"|"warn"|"block",
 *             reason:string, required:{pct_of_pn?:[number,number]} }}
 */
function evaluateWriteSafety(offset, live) {
  const off = Number(offset);
  const out = { offset: off, ok: true, severity: "info", reason: "", required: {} };

  const s = _stateOk(live);
  if (!s.ok) {
    out.ok = false;
    out.severity = "block";
    out.reason = s.reason;
    return out;
  }

  const pct = live && live.pct_of_pn != null ? Number(live.pct_of_pn) : null;

  // DC current scale (Fesc_ipv) — requires high-load read-back to be
  // numerically meaningful per TrinPM20.
  if (off === FESC_IPV_OFFSET) {
    if (pct == null) {
      out.ok = false;
      out.severity = "warn";
      out.reason = "Cannot verify Pac/Pn (nominal power read failed) — required ≥ 70 %";
      out.required.pct_of_pn = [FESC_IPV_MIN_PCT_OF_PN, 100];
      return out;
    }
    if (pct < FESC_IPV_MIN_PCT_OF_PN) {
      out.ok = false;
      out.severity = "block";
      out.reason = `Pac/Pn = ${pct.toFixed(1)} % — TrinPM20 requires ≥ ${FESC_IPV_MIN_PCT_OF_PN} % for DC current scale write`;
      out.required.pct_of_pn = [FESC_IPV_MIN_PCT_OF_PN, 100];
      return out;
    }
  }

  if (REACTIVE_X1Y1_OFFSETS.has(off) || REACTIVE_X2Y2_OFFSETS.has(off)) {
    const target = REACTIVE_X1Y1_OFFSETS.has(off)
      ? REACTIVE_X1Y1_TARGET_PCT : REACTIVE_X2Y2_TARGET_PCT;
    const lo = target - REACTIVE_TOLERANCE_PCT_PP;
    const hi = target + REACTIVE_TOLERANCE_PCT_PP;
    if (pct == null) {
      out.ok = false;
      out.severity = "warn";
      out.reason = `Cannot verify Pac/Pn (nominal power read failed) — required ${lo}–${hi} %`;
      out.required.pct_of_pn = [lo, hi];
      return out;
    }
    if (pct < lo || pct > hi) {
      out.ok = false;
      out.severity = "block";
      out.reason = `Pac/Pn = ${pct.toFixed(1)} % — TrinPM20 reactive ${REACTIVE_X1Y1_OFFSETS.has(off) ? "X1Y1" : "X2Y2"} calibration requires ${target} ± ${REACTIVE_TOLERANCE_PCT_PP} % (consign mode)`;
      out.required.pct_of_pn = [lo, hi];
      return out;
    }
  }

  return out;
}

/**
 * Build a per-field writability map for the read endpoint — UI can render
 * each Write button with the gate's verdict in advance, so the operator
 * sees red/amber/green before clicking.
 *
 * @param {object} live
 * @param {number[]} offsets
 * @returns {Object<number, ReturnType<typeof evaluateWriteSafety>>}
 */
function buildWriteSafetyMap(live, offsets) {
  const out = {};
  for (const off of offsets || []) {
    out[Number(off)] = evaluateWriteSafety(off, live);
  }
  return out;
}

module.exports = {
  evaluateWriteSafety,
  buildWriteSafetyMap,
  // Exposed for tests
  FESC_IPV_OFFSET,
  FESC_IPV_MIN_PCT_OF_PN,
  REACTIVE_X1Y1_OFFSETS,
  REACTIVE_X2Y2_OFFSETS,
  REACTIVE_X1Y1_TARGET_PCT,
  REACTIVE_X2Y2_TARGET_PCT,
  REACTIVE_TOLERANCE_PCT_PP,
  STATE_PHASE_GRID_CONNECTED,
  STATE_PHASE_ERROR,
};
