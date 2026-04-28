"use strict";

// Pure-function core for the Energy Summary export's hardware-counter delta
// math (Etotal_kWh / parcE_kWh per unit per day).
//
// Extracted from server/exporter.js so the multi-path fallback rules can be
// regression-tested without spinning up SQLite, the poller, or the live
// counter snapshot. The exporter retains all DB I/O — this module just
// answers "given these baselines and this snapshot, what's the delta?".
//
// Rules — kept intentionally identical to v2.10.x exporter behavior:
//
//   TODAY:
//     1. If today's baseline row exists, ΔkWh = current_counter − baseline.
//        Any baseline source (eod_clean | poll | pac_seed) anchors the delta
//        to the window the dashboard actually polled, lining up with the
//        PAC-integrated Total_MWh column on the same row.
//     2. If today's baseline row is missing OR produced no usable delta,
//        fall back to yesterday's eod_clean snapshot as the anchor.
//
//   PAST DAY D:
//     1. Prefer baseline[D].eod_clean − baseline[D].baseline (the v2.9.x rule).
//     2. For halves still missing, fall back to baseline[D+1].baseline −
//        baseline[D].baseline. Tomorrow's open ≈ yesterday's close for
//        counters that don't run overnight.
//
//   Sanity ceiling — every accepted delta must be `≥ 0` and bounded by
//   `perUnitDayCeilingKwh` (default 9000 kWh = 250 kW × 24 h × 1.5 safety).
//   Anything outside that range falls back to NaN.

const DEFAULT_PER_UNIT_DAY_CEILING_KWH = 9000;

function _toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function acceptDelta(deltaKwh, perUnitDayCeilingKwh = DEFAULT_PER_UNIT_DAY_CEILING_KWH) {
  if (!Number.isFinite(deltaKwh)) return false;
  if (deltaKwh < 0) return false;
  if (deltaKwh > perUnitDayCeilingKwh) return false;
  return true;
}

// computeHwDeltasForUnitDay
//
// Inputs:
//   day                    YYYY-MM-DD — the day this row represents
//   today                  YYYY-MM-DD — gateway local "today"
//   baseline               { etotal_baseline, parce_baseline,
//                            etotal_eod_clean?, parce_eod_clean?,
//                            source? } | null  (today's or D's row)
//   curCounter             { etotal_kwh, parce_kwh } | null
//                          (only consulted when day === today)
//   yesterdayBaseline      same shape — D-1's row, only consulted when
//                          day === today (eod_clean fallback anchor)
//   tomorrowBaseline       same shape — D+1's row, only consulted when
//                          day !== today (close-out anchor)
//   perUnitDayCeilingKwh   sanity ceiling, default 9000
//
// Output:
//   { etotalKwh, parceKwh } — each NaN if the rules above can't produce
//   a valid delta. Day-total NaN-propagation is the caller's responsibility.

function computeHwDeltasForUnitDay({
  day,
  today,
  baseline = null,
  curCounter = null,
  yesterdayBaseline = null,
  tomorrowBaseline = null,
  perUnitDayCeilingKwh = DEFAULT_PER_UNIT_DAY_CEILING_KWH,
} = {}) {
  const out = { etotalKwh: NaN, parceKwh: NaN };
  const ceiling = Number.isFinite(perUnitDayCeilingKwh)
    ? perUnitDayCeilingKwh
    : DEFAULT_PER_UNIT_DAY_CEILING_KWH;

  if (day === today) {
    // ── Today path ────────────────────────────────────────────────────
    if (!curCounter) return out;
    const curE = _toFiniteNumber(curCounter.etotal_kwh);
    const curP = _toFiniteNumber(curCounter.parce_kwh);

    // Path 1: today's baseline row exists — use it regardless of source.
    if (baseline) {
      const dE = curE - _toFiniteNumber(baseline.etotal_baseline || 0);
      const dP = curP - _toFiniteNumber(baseline.parce_baseline  || 0);
      if (acceptDelta(dE, ceiling)) out.etotalKwh = dE;
      if (acceptDelta(dP, ceiling)) out.parceKwh  = dP;
      if (Number.isFinite(out.etotalKwh) || Number.isFinite(out.parceKwh)) {
        return out;
      }
      // fall through if baseline existed but produced no usable delta
    }

    // Path 2: yesterday's eod_clean as anchor (gateway booted today and
    // never wrote a today-baseline row, but yesterday's snapshot is here).
    if (yesterdayBaseline) {
      const yE = _toFiniteNumber(yesterdayBaseline.etotal_eod_clean || 0);
      const yP = _toFiniteNumber(yesterdayBaseline.parce_eod_clean  || 0);
      if (yE > 0) {
        const dE = curE - yE;
        if (acceptDelta(dE, ceiling)) out.etotalKwh = dE;
      }
      if (yP > 0) {
        const dP = curP - yP;
        if (acceptDelta(dP, ceiling)) out.parceKwh = dP;
      }
    }
    return out;
  }

  // ── Past day path ────────────────────────────────────────────────────
  if (!baseline) return out;

  // v2.10.x — `source='eod_clean_only'` rows are late-created by the
  // dark-window capture for days when the morning baseline was never
  // recorded (gateway booted post-midnight, fresh install, etc.). Their
  // `etotal_baseline` was set equal to `etotal_eod_clean` as a placeholder
  // so the row can serve as the NEXT day's anchor — but the day's own Δ
  // is unknown because we have no morning value. NaN-propagate so the
  // export blanks the column rather than reporting a misleading 0 kWh.
  const baselineSource = String(baseline.source || "").toLowerCase();
  if (baselineSource === "eod_clean_only") {
    return out; // both NaN
  }

  // Path 1: same-day eod_clean delta (the v2.9.x rule).
  const eClean = _toFiniteNumber(baseline.etotal_eod_clean || 0);
  const pClean = _toFiniteNumber(baseline.parce_eod_clean  || 0);
  let etotalDone = false;
  let parceDone = false;
  if (eClean > 0) {
    const dE = eClean - _toFiniteNumber(baseline.etotal_baseline || 0);
    if (acceptDelta(dE, ceiling)) { out.etotalKwh = dE; etotalDone = true; }
  }
  if (pClean > 0) {
    const dP = pClean - _toFiniteNumber(baseline.parce_baseline || 0);
    if (acceptDelta(dP, ceiling)) { out.parceKwh = dP; parceDone = true; }
  }
  if (etotalDone && parceDone) return out;

  // Path 2: tomorrow's baseline as the close-out anchor for the missing
  // halves. Fires when the gateway was offline for the entire dark window.
  if (tomorrowBaseline) {
    if (!etotalDone) {
      const dE = _toFiniteNumber(tomorrowBaseline.etotal_baseline || 0)
               - _toFiniteNumber(baseline.etotal_baseline || 0);
      if (acceptDelta(dE, ceiling)) out.etotalKwh = dE;
    }
    if (!parceDone) {
      const dP = _toFiniteNumber(tomorrowBaseline.parce_baseline || 0)
               - _toFiniteNumber(baseline.parce_baseline || 0);
      if (acceptDelta(dP, ceiling)) out.parceKwh = dP;
    }
  }
  return out;
}

module.exports = {
  DEFAULT_PER_UNIT_DAY_CEILING_KWH,
  acceptDelta,
  computeHwDeltasForUnitDay,
};
