"use strict";

/**
 * Canonical MOTIVO_PARO labels — Slice B of v2.10.0.
 *
 * 30 stop-motive labels (slots 0..29) plus a TOTAL aggregator at slot 30.
 * Slots map directly to ARRAYHISTMOTPARO counter positions, which means
 * `inverter_stop_histogram.counters_json[N]` = lifetime count of times
 * `MOTIVO_PARO_LABELS[N]` has fired.
 *
 * Labels were extracted from the ISM "Stop Reasons" window on 2026-04-27.
 *
 * Note: the StopReason struct's MotParo field (idx 13) is a parallel
 * primary-cause code and does NOT index into this array directly. A
 * motparo_code → MOTIVO_PARO_* mapping is deferred to v2.10.x.
 */

const MOTIVO_PARO_LABELS = Object.freeze([
  "MOTIVO_PARO_VIN",              // 0
  "MOTIVO_PARO_FRED",             // 1
  "MOTIVO_PARO_VRED",             // 2
  "MOTIVO_PARO_VARISTORES",       // 3
  "MOTIVO_PARO_AISL_DC",          // 4
  "MOTIVO_PARO_IAC_EFICAZ",       // 5
  "MOTIVO_PARO_TEMPERATURA",      // 6
  "MOTIVO_PARO_01",               // 7
  "MOTIVO_PARO_CONFIGURACION",    // 8
  "MOTIVO_PARO_MANUAL",           // 9
  "MOTIVO_PARO_BAJA_VPV_MED",     // 10
  "MOTIVO_PARO_HW_DESCX2",        // 11
  "MOTIVO_PARO_FRAMA3",           // 12
  "MOTIVO_PARO_MAX_IAC_INST",     // 13
  "MOTIVO_PARO_CARGA_FIRMWARE",   // 14
  "MOTIVO_PARO_03",               // 15
  "MOTIVO_PARO_04",               // 16
  "MOTIVO_PARO_ERROR_LEC_ADC",    // 17
  "MOTIVO_PARO_CONSUMO_POTENCIA", // 18
  "MOTIVO_PARO_FUS_DC",           // 19
  "MOTIVO_PARO_TEMP_AUX",         // 20
  "MOTIVO_PARO_DES_AC",           // 21
  "MOTIVO_PARO_MAGNETO",          // 22
  "MOTIVO_PARO_CONTACTOR",        // 23
  "MOTIVO_PARO_RESET_WD",         // 24
  "MOTIVO_PARO_PI_ANA_SAT",       // 25
  "MOTIVO_PARO_LATENCIA_ADC",     // 26
  "MOTIVO_PARO_ERROR_FATAL",      // 27
  "MOTIVO_PARO_FRAMA1",           // 28
  "MOTIVO_PARO_FRAMA2",           // 29
  "TOTAL",                        // 30
]);

const TOTAL_INDEX = 30;
const MOTIVE_COUNT = 30;
const TOTAL_LABEL = "TOTAL";

function lookupMotiveLabel(idx) {
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= MOTIVO_PARO_LABELS.length) {
    return `<unknown_${idx}>`;
  }
  return MOTIVO_PARO_LABELS[i];
}

/**
 * Decorate a 31-counter array with labels for UI consumption.
 * Returns [{idx, label, count, isTotal}, ...] sorted by idx.
 */
function decorateHistogramCounters(counters) {
  if (!Array.isArray(counters)) return [];
  return counters.map((c, idx) => ({
    idx,
    label: lookupMotiveLabel(idx),
    count: Number.isFinite(Number(c)) ? Number(c) : 0,
    isTotal: idx === TOTAL_INDEX,
  }));
}

module.exports = {
  MOTIVO_PARO_LABELS,
  TOTAL_INDEX,
  TOTAL_LABEL,
  MOTIVE_COUNT,
  lookupMotiveLabel,
  decorateHistogramCounters,
};
