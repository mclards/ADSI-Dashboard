"use strict";

/**
 * Slice β unit tests — slow-poll field pass-through in parseRow()
 *
 * Tests that parseRow() correctly handles the 19 new slow-poll fields:
 *   - Alarm windows (alarms_inst_32, alarms_maint_32)
 *   - Reactive power (qac_var)
 *   - Impedances (zpos_kohm, zneg_kohm)
 *   - Temperature (tempint_c)
 *   - Inverter state (inverter_state_raw)
 *   - Solar field voltages (vpv_n_v, vpv_p_v)
 *   - Nominal power (nominal_power_w)
 *   - Connection timers (time_to_connect_s, time_to_connect_total_s)
 *   - Power reduction (power_reduction_bits)
 *   - AAP0016 analog inputs (analog_in_1-4, pt100_1-2)
 *
 * Related plan: plans/slice-beta-implementation.md §6.2
 */

const assert = require("assert");

delete require.cache[require.resolve("../poller")];
const { parseRow } = require("../poller");

// Helper to create a minimal valid identity
function makeIdentity(inverter = 1, unit = 1, sourceIp = "192.168.1.10") {
  return {
    ok: true,
    inverter,
    unit,
    sourceIp,
  };
}

// Helper to create a minimal valid row
function makeRow(overrides = {}) {
  return {
    vdc: 800,
    idc: 5,
    vac1: 230, vac2: 231, vac3: 229,
    iac1: 4.3, iac2: 4.4, iac3: 4.2,
    pac: 1000,
    alarm: 0,
    on_off: 1,
    ts: Date.now(),
    ...overrides,
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  parseRowSlowFields.test.js — Slice β slow-poll fields");
  console.log("──────────────────────────────────────────────────────────\n");

  // ────────────────────────────────────────────────────────────────
  // Test 1: All slow fields present → pass through correctly
  // ────────────────────────────────────────────────────────────────
  test("parseRow: passes through all slow-poll fields when present", () => {
    const row = makeRow({
      alarms_inst_32: 0x00010002,
      alarms_maint_32: 0x00040008,
      qac_var: -100,
      zpos_kohm: 50,
      zneg_kohm: 48,
      tempint_c: 35,
      inverter_state_raw: 0x0202,
      vpv_n_v: 450,
      vpv_p_v: 460,
      nominal_power_w: 10000,
      time_to_connect_s: 45,
      time_to_connect_total_s: 60,
      power_reduction_bits: 0x0003,
      analog_in_1: 1234,
      analog_in_2: 2345,
      analog_in_3: 3456,
      analog_in_4: 4567,
      pt100_1: 0x0ABC,
      pt100_2: 0x0DEF,
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    assert.strictEqual(result.alarms_inst_32, 0x00010002);
    assert.strictEqual(result.alarms_maint_32, 0x00040008);
    assert.strictEqual(result.qac_var, -100);
    assert.strictEqual(result.zpos_kohm, 50);
    assert.strictEqual(result.zneg_kohm, 48);
    assert.strictEqual(result.tempint_c, 35);
    assert.strictEqual(result.inverter_state_raw, 0x0202);
    assert.strictEqual(result.vpv_n_v, 450);
    assert.strictEqual(result.vpv_p_v, 460);
    assert.strictEqual(result.nominal_power_w, 10000);
    assert.strictEqual(result.time_to_connect_s, 45);
    assert.strictEqual(result.time_to_connect_total_s, 60);
    assert.strictEqual(result.power_reduction_bits, 0x0003);
    assert.strictEqual(result.analog_in_1, 1234);
    assert.strictEqual(result.analog_in_2, 2345);
    assert.strictEqual(result.analog_in_3, 3456);
    assert.strictEqual(result.analog_in_4, 4567);
    assert.strictEqual(result.pt100_1, 0x0ABC);
    assert.strictEqual(result.pt100_2, 0x0DEF);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 2: Slow fields absent → default to null or 0
  // ────────────────────────────────────────────────────────────────
  test("parseRow: slow fields absent → defaults to null or 0", () => {
    const row = makeRow({
      // No slow fields
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    // Signed fields should be null (falsy)
    assert.strictEqual(result.qac_var, null);
    assert.strictEqual(result.tempint_c, null);

    // UInt16 fields default to 0
    assert.strictEqual(result.alarms_inst_32, 0);
    assert.strictEqual(result.alarms_maint_32, 0);
    assert.strictEqual(result.zpos_kohm, 0);
    assert.strictEqual(result.zneg_kohm, 0);
    assert.strictEqual(result.inverter_state_raw, 0);
    assert.strictEqual(result.vpv_n_v, 0);
    assert.strictEqual(result.vpv_p_v, 0);
    assert.strictEqual(result.nominal_power_w, 0);
    assert.strictEqual(result.time_to_connect_s, 0);
    assert.strictEqual(result.time_to_connect_total_s, 0);
    assert.strictEqual(result.power_reduction_bits, 0);
    assert.strictEqual(result.analog_in_1, 0);
    assert.strictEqual(result.analog_in_2, 0);
    assert.strictEqual(result.analog_in_3, 0);
    assert.strictEqual(result.analog_in_4, 0);
    assert.strictEqual(result.pt100_1, 0);
    assert.strictEqual(result.pt100_2, 0);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 3: Partial slow fields → only provided fields override
  // ────────────────────────────────────────────────────────────────
  test("parseRow: partial slow fields → only provided override", () => {
    const row = makeRow({
      qac_var: -50,
      zpos_kohm: 52,
      // tempint_c absent → should default to null
      // Other fields absent → defaults
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    assert.strictEqual(result.qac_var, -50);
    assert.strictEqual(result.zpos_kohm, 52);
    assert.strictEqual(result.tempint_c, null);
    assert.strictEqual(result.zneg_kohm, 0); // default
  });

  // ────────────────────────────────────────────────────────────────
  // Test 4: AAP0016 analog fields → pass through as-is
  // ────────────────────────────────────────────────────────────────
  test("parseRow: AAP0016 analog fields pass through", () => {
    const row = makeRow({
      analog_in_1: 100,
      analog_in_2: 200,
      analog_in_3: 300,
      analog_in_4: 400,
      pt100_1: 512,
      pt100_2: 1024,
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    assert.strictEqual(result.analog_in_1, 100);
    assert.strictEqual(result.analog_in_2, 200);
    assert.strictEqual(result.analog_in_3, 300);
    assert.strictEqual(result.analog_in_4, 400);
    assert.strictEqual(result.pt100_1, 512);
    assert.strictEqual(result.pt100_2, 1024);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 5: Out-of-range values → pass through (aggregator gates later)
  // ────────────────────────────────────────────────────────────────
  test("parseRow: out-of-range values pass through unclamped", () => {
    const row = makeRow({
      qac_var: -100,
      zpos_kohm: 200000, // Unrealistic impedance
      tempint_c: 200, // > 150 °C industrial envelope
      nominal_power_w: 50000000, // Way over fleet ceiling
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    // parseRow should NOT clamp — pass through as-is
    assert.strictEqual(result.qac_var, -100);
    assert.strictEqual(result.zpos_kohm, 200000);
    assert.strictEqual(result.tempint_c, 200);
    assert.strictEqual(result.nominal_power_w, 50000000);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 6: Signed fields (qac_var, tempint_c) with negative values
  // ────────────────────────────────────────────────────────────────
  test("parseRow: signed slow fields preserve negative values", () => {
    const row = makeRow({
      qac_var: -250, // Negative reactive power
      tempint_c: -15, // Cold weather
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    assert.strictEqual(result.qac_var, -250);
    assert.strictEqual(result.tempint_c, -15);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 7: Zero values for slow fields (offline inverter)
  // ────────────────────────────────────────────────────────────────
  test("parseRow: zero values → qac_var null, others zero", () => {
    const row = makeRow({
      qac_var: 0, // Offline — should become null
      tempint_c: 0, // Offline — should become null
      zpos_kohm: 0,
      zneg_kohm: 0,
      vpv_n_v: 0,
      vpv_p_v: 0,
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    // Signed fields with 0 should be null (offline marker)
    assert.strictEqual(result.qac_var, null);
    assert.strictEqual(result.tempint_c, null);

    // UInt16 fields with 0 stay 0
    assert.strictEqual(result.zpos_kohm, 0);
    assert.strictEqual(result.vpv_n_v, 0);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 8: Backward-compat: frame without slow fields (pre-Slice β)
  // ────────────────────────────────────────────────────────────────
  test("parseRow: backward-compat with pre-Slice β frames", () => {
    const row = makeRow({
      vdc: 600,
      pac: 5000,
      // No slow fields at all
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    // Should have basic fields
    assert.strictEqual(result.vdc, 600);
    assert.strictEqual(result.pac, 50000); // scaled

    // Should have all slow fields defaulted
    assert.strictEqual(result.qac_var, null);
    assert.strictEqual(result.alarms_inst_32, 0);
    assert.strictEqual(result.inverter_state_raw, 0);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 9: Full realistic inverter frame (fast + slow)
  // ────────────────────────────────────────────────────────────────
  test("parseRow: full realistic frame (fast + slow fields)", () => {
    const row = makeRow({
      // Fast fields (existing)
      vdc: 650,
      idc: 12,
      pac: 8500,
      alarm: 0,
      on_off: 1,
      fac_hz: 60.02,
      temp_c: 42,
      cosphi: 0.98,
      // Slow fields (new)
      alarms_inst_32: 0,
      alarms_maint_32: 0,
      qac_var: -50,
      zpos_kohm: 52,
      zneg_kohm: 50,
      tempint_c: 38,
      inverter_state_raw: 0x0100,
      vpv_n_v: 480,
      vpv_p_v: 490,
      nominal_power_w: 12500,
      time_to_connect_s: 0,
      time_to_connect_total_s: 120,
      power_reduction_bits: 0,
      analog_in_1: 0,
      analog_in_2: 0,
      pt100_1: 0,
      pt100_2: 0,
    });

    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");

    // Verify fast fields
    assert.strictEqual(result.vdc, 650);
    assert.strictEqual(result.pac, 85000);

    // Verify slow fields
    assert.strictEqual(result.qac_var, -50);
    assert.strictEqual(result.zpos_kohm, 52);
    assert.strictEqual(result.tempint_c, 38);
    assert.strictEqual(result.inverter_state_raw, 0x0100);
  });

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  All tests completed");
  console.log("──────────────────────────────────────────────────────────\n");
}

run();
