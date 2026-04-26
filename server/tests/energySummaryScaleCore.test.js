"use strict";

// Regression test for the Energy Summary export's per-inverter scaling math.
// Specifically verifies that the v2.9.2 clamp interaction does not produce
// inflated, deflated, or NaN-poisoned exports under the documented scenarios.

const assert = require("assert");
const {
  computeInverterScale,
  applyInverterScale,
} = require("../energySummaryScaleCore");

function approxEqual(actual, expected, tol = 1e-6, msg = "") {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ≈${expected} got ${actual} (tol=${tol})`,
  );
}

function makeRow({ unit, energyKwh, etotalKwh = NaN, parceKwh = NaN }) {
  return {
    Date: "2026-04-26",
    Inverter_Number: 1,
    Node_Number: unit,
    First_Seen: "05:00:00",
    Last_Seen: "18:00:00",
    Peak_Pac_kW: 250,
    rawEnergyKwh: energyKwh,
    rawEtotalKwh: etotalKwh,
    rawParceKwh:  parceKwh,
  };
}

function run() {
  // ── 1. Pre-v2.9.2 spike scenario reproduces the inflated output ───────
  // Scenario: 1.86 MWh spike at 06:40 landed in energy_5min (no clamp).
  //   rawSubtotalKwh = 50 (real PAC integration, normal pre-dawn)
  //   authoritativeKwh = 1910 (50 normal + 1860 spike)
  // Without v2.9.2, scale = 38.2 → per-unit values are 38× inflated.
  // We assert this so any future regression that disables the clamp surfaces.
  {
    const detailRows = [
      makeRow({ unit: 1, energyKwh: 12.5 }),
      makeRow({ unit: 2, energyKwh: 12.5 }),
      makeRow({ unit: 3, energyKwh: 12.5 }),
      makeRow({ unit: 4, energyKwh: 12.5 }),
    ];
    const result = applyInverterScale({
      detailRows,
      authoritativeKwh: 1910,
      rawSubtotalKwh: 50,
    });
    approxEqual(result.scale, 38.2, 1e-6, "pre-clamp scale is 38× inflated");
    // Each unit should show 12.5 × 38.2 / 1000 = 0.4775 MWh — clearly wrong
    approxEqual(
      result.scaledRows[0].Total_MWh,
      0.4775,
      1e-6,
      "without clamp, per-unit Total_MWh is inflated by scale",
    );
    approxEqual(result.subtotalMwh, 1.91, 1e-6, "day total = authoritative/1000 = 1.91 MWh");
  }

  // ── 2. Post-v2.9.2 clamp: same scenario produces clean output ─────────
  //   authoritativeKwh = 50 (clamp dropped the spike row)
  //   rawSubtotalKwh = 50
  // Scale = 1, per-unit shows real values, day total matches reality.
  {
    const detailRows = [
      makeRow({ unit: 1, energyKwh: 12.5 }),
      makeRow({ unit: 2, energyKwh: 12.5 }),
      makeRow({ unit: 3, energyKwh: 12.5 }),
      makeRow({ unit: 4, energyKwh: 12.5 }),
    ];
    const result = applyInverterScale({
      detailRows,
      authoritativeKwh: 50,
      rawSubtotalKwh: 50,
    });
    approxEqual(result.scale, 1, 1e-9, "post-clamp scale is 1");
    approxEqual(result.scaledRows[0].Total_MWh, 0.0125, 1e-6);
    approxEqual(result.subtotalMwh, 0.05, 1e-6, "day total reflects real production");
  }

  // ── 3. authoritativeKwh > 0 but rawSubtotalKwh = 0 — fallback to scale=1
  //    edge case if PAC recompute is empty but energy_5min has data
  {
    const result = applyInverterScale({
      detailRows: [],
      authoritativeKwh: 100,
      rawSubtotalKwh: 0,
    });
    approxEqual(result.scale, 1, 1e-9);
    approxEqual(
      result.subtotalMwh,
      0.1,
      1e-9,
      "day total still uses authoritativeKwh / 1000",
    );
  }

  // ── 4. rawSubtotalKwh > 0 but authoritativeKwh = 0 — fallback path ───
  //    energy_5min unavailable; export uses scaled subtotal
  {
    const detailRows = [
      makeRow({ unit: 1, energyKwh: 100 }),
      makeRow({ unit: 2, energyKwh: 50 }),
    ];
    const result = applyInverterScale({
      detailRows,
      authoritativeKwh: 0,
      rawSubtotalKwh: 150,
    });
    approxEqual(result.scale, 1, 1e-9);
    approxEqual(result.subtotalMwh, 0.15, 1e-6, "fallback to PAC-recompute total");
    approxEqual(result.scaledRows[0].Total_MWh, 0.1, 1e-6);
    approxEqual(result.scaledRows[1].Total_MWh, 0.05, 1e-6);
  }

  // ── 5. HW counter columns NaN-propagate when ANY unit invalid ────────
  // Per the v2.9.1 invariant: if any unit's HW baseline isn't eod_clean,
  // the day-total Etotal must be NaN (not silently treat invalid as 0).
  {
    const detailRows = [
      makeRow({ unit: 1, energyKwh: 100, etotalKwh: 100, parceKwh: 100 }),
      makeRow({ unit: 2, energyKwh: 100, etotalKwh: NaN, parceKwh: 100 }),
      makeRow({ unit: 3, energyKwh: 100, etotalKwh: 100, parceKwh: NaN }),
    ];
    const result = applyInverterScale({
      detailRows,
      authoritativeKwh: 300,
      rawSubtotalKwh: 300,
    });
    assert.equal(
      result.dayEtotalValid,
      false,
      "any NaN unit invalidates day total Etotal",
    );
    assert.equal(
      result.dayParceValid,
      false,
      "any NaN unit invalidates day total ParcE",
    );
    // Per-unit cells: valid units show their value, invalid units show NaN
    assert.equal(result.scaledRows[0].Etotal_MWh, 0.1);
    assert.ok(Number.isNaN(result.scaledRows[1].Etotal_MWh), "invalid unit → NaN");
    assert.equal(result.scaledRows[2].Etotal_MWh, 0.1);
  }

  // ── 6. All HW counters valid → day-total sum is finite ───────────────
  {
    const detailRows = [
      makeRow({ unit: 1, energyKwh: 100, etotalKwh: 99,  parceKwh: 99 }),
      makeRow({ unit: 2, energyKwh: 100, etotalKwh: 101, parceKwh: 101 }),
    ];
    const result = applyInverterScale({
      detailRows,
      authoritativeKwh: 200,
      rawSubtotalKwh: 200,
    });
    assert.equal(result.dayEtotalValid, true);
    assert.equal(result.dayParceValid, true);
    approxEqual(result.dayEtotalKwh, 200, 1e-6);
    approxEqual(result.dayParceKwh,  200, 1e-6);
  }

  // ── 7. Reconciliation gap — Total_MWh < Etotal_MWh after clamp ───────
  // This is the diagnostic the operator uses to spot clamp activity:
  //   Total_MWh (PAC, clamped) < Etotal_MWh (HW, true)
  // The export delivers this signal directly via the two columns.
  {
    const detailRows = [
      makeRow({ unit: 1, energyKwh: 12.5, etotalKwh: 477.5, parceKwh: 477.5 }),
      makeRow({ unit: 2, energyKwh: 12.5, etotalKwh: 477.5, parceKwh: 477.5 }),
      makeRow({ unit: 3, energyKwh: 12.5, etotalKwh: 477.5, parceKwh: 477.5 }),
      makeRow({ unit: 4, energyKwh: 12.5, etotalKwh: 477.5, parceKwh: 477.5 }),
    ];
    const result = applyInverterScale({
      detailRows,
      authoritativeKwh: 50,    // post-clamp
      rawSubtotalKwh: 50,
    });
    approxEqual(result.subtotalMwh, 0.05,  1e-6, "Total_MWh shows clamped value");
    approxEqual(result.dayEtotalKwh,  1910, 1e-6, "Etotal_MWh shows full HW value");
    approxEqual(
      result.dayEtotalKwh / 1000 - result.subtotalMwh,
      1.86,
      1e-6,
      "reconciliation gap = quarantined energy = 1.86 MWh",
    );
  }

  // ── 8. Empty input → safe defaults, no division-by-zero ──────────────
  {
    const result = applyInverterScale({
      detailRows: [],
      authoritativeKwh: 0,
      rawSubtotalKwh: 0,
    });
    approxEqual(result.scale, 1, 1e-9);
    approxEqual(result.subtotalMwh, 0, 1e-9);
    assert.equal(result.scaledRows.length, 0);
    assert.equal(result.dayEtotalValid, true,  "empty → still valid (vacuously)");
    assert.equal(result.dayParceValid,  true);
  }

  // ── 9. Defensive: negative and NaN inputs produce safe outputs ───────
  {
    const result = applyInverterScale({
      detailRows: [makeRow({ unit: 1, energyKwh: -5 })],
      authoritativeKwh: -10,
      rawSubtotalKwh: NaN,
    });
    approxEqual(result.scale, 1, 1e-9, "NaN/negative inputs → scale=1");
    approxEqual(
      result.scaledRows[0].Total_MWh,
      0,
      1e-9,
      "negative rawEnergyKwh clamped to 0",
    );
    approxEqual(result.subtotalMwh, 0, 1e-9, "negative authoritative clamped to 0");
  }

  // ── 10. computeInverterScale boundary cases ──────────────────────────
  approxEqual(computeInverterScale(100, 50), 2, 1e-9, "scale up");
  approxEqual(computeInverterScale(50, 100), 0.5, 1e-9, "scale down (clamp suppression)");
  approxEqual(computeInverterScale(0, 100), 1, 1e-9, "zero authoritative → fallback");
  approxEqual(computeInverterScale(100, 0), 1, 1e-9, "zero raw → fallback");
  approxEqual(computeInverterScale(0, 0), 1, 1e-9, "both zero → fallback");

  console.log("energySummaryScaleCore.test.js: PASS");
}

run();
