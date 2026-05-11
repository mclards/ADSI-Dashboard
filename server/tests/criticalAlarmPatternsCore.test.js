"use strict";

/**
 * criticalAlarmPatternsCore.test.js — pure-function tests for the forensic
 * precursor detector (Slice κ.3).
 */

const assert = require("assert");

delete require.cache[require.resolve("../criticalAlarmPatterns")];
const {
  CRITICAL_PATTERNS,
  DEFAULT_WINDOW_MS,
  DEFAULT_MIN_COUNT,
  matchesPattern,
  countPatternEpisodesInWindow,
  evaluateCriticalPatterns,
  hasAnyCriticalPattern,
  worstSeverity,
} = require("../criticalAlarmPatterns");

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
  console.log("  criticalAlarmPatternsCore.test.js");
  console.log("──────────────────────────────────────────────────────────\n");

  // ── catalogue sanity ───────────────────────────────────────────────────
  test("CRITICAL_PATTERNS contains 0x0240, 0x0210, and 0x0040", () => {
    const masks = CRITICAL_PATTERNS.map(p => p.mask);
    assert.ok(masks.includes(0x0240), "missing 0x0240 entry");
    assert.ok(masks.includes(0x0210), "missing 0x0210 entry");
    assert.ok(masks.includes(0x0040), "missing 0x0040 entry");
  });

  test("Catalogue rank order: 0x0240 > EOL-rank > 0x0040 > 0x0210", () => {
    const breach = CRITICAL_PATTERNS.find((p) => p.mask === 0x0240);
    const adc    = CRITICAL_PATTERNS.find((p) => p.mask === 0x0040);
    const acoc   = CRITICAL_PATTERNS.find((p) => p.mask === 0x0210);
    // Direct ordering between catalogue entries.
    assert.ok(breach.severity_rank > adc.severity_rank,
      `expected 0x0240 (${breach.severity_rank}) > 0x0040 (${adc.severity_rank})`);
    assert.ok(adc.severity_rank > acoc.severity_rank,
      `expected 0x0040 (${adc.severity_rank}) > 0x0210 (${acoc.severity_rank})`);
    // The EOL synthetic signal (server/index.js, severity_rank=3) is checked
    // against this scale; verify there's room for it between 0x0240 and 0x0040.
    assert.ok(breach.severity_rank >= adc.severity_rank + 2,
      "need a free rank between 0x0240 and 0x0040 for synthetic IGBT_HEALTH_EOL");
  });

  test("0x0040 carries exclude_mask = 0x0200 (mutually exclusive with 0x0240)", () => {
    const adc = CRITICAL_PATTERNS.find((p) => p.mask === 0x0040);
    assert.strictEqual(adc.exclude_mask, 0x0200,
      "0x0040 must exclude bit 9 (0x0200) to avoid double-counting with 0x0240");
  });

  test("DEFAULT_WINDOW_MS = 48h, DEFAULT_MIN_COUNT = 2", () => {
    assert.strictEqual(DEFAULT_WINDOW_MS, 48 * 60 * 60 * 1000);
    assert.strictEqual(DEFAULT_MIN_COUNT, 2);
  });

  test("CRITICAL_PATTERNS entries are frozen", () => {
    assert.throws(() => { CRITICAL_PATTERNS.push({}); });
    assert.throws(() => { CRITICAL_PATTERNS[0].label = "tampered"; });
  });

  // ── matchesPattern ─────────────────────────────────────────────────────
  test("matchesPattern: exact mask matches", () => {
    assert.strictEqual(matchesPattern(0x0240, 0x0240), true);
    assert.strictEqual(matchesPattern(0x0210, 0x0210), true);
  });

  test("matchesPattern: superset matches (extra bits OK)", () => {
    // alarm value 0x0241 (bits 0, 6, 9) still has bits 6+9, so matches 0x0240
    assert.strictEqual(matchesPattern(0x0241, 0x0240), true);
    // alarm value 0x0F50 (lots of bits) still has bits 4+9, so matches 0x0210
    assert.strictEqual(matchesPattern(0x0F50, 0x0210), true);
  });

  test("matchesPattern: missing bit fails", () => {
    // 0x0040 = bit 6 only, missing bit 9 → does NOT match 0x0240
    assert.strictEqual(matchesPattern(0x0040, 0x0240), false);
    // 0x0200 = bit 9 only, missing bit 6 → does NOT match 0x0240
    assert.strictEqual(matchesPattern(0x0200, 0x0240), false);
    // 0x0010 = bit 4 only, missing bit 9 → does NOT match 0x0210
    assert.strictEqual(matchesPattern(0x0010, 0x0210), false);
  });

  test("matchesPattern: zero / NaN / non-finite handled safely", () => {
    assert.strictEqual(matchesPattern(0, 0x0240), false);
    assert.strictEqual(matchesPattern(NaN, 0x0240), false);
    assert.strictEqual(matchesPattern(0x0240, 0), false);
    assert.strictEqual(matchesPattern("0x0240", 0x0240), true);  // numeric coercion
  });

  // ── countPatternEpisodesInWindow ────────────────────────────────────────
  test("countPatternEpisodesInWindow: empty / non-array → 0", () => {
    const r = countPatternEpisodesInWindow([], 0x0240, Date.now(), DEFAULT_WINDOW_MS);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.last_seen_ts, null);
  });

  test("countPatternEpisodesInWindow: counts matching rows in window (legacy, no dedup)", () => {
    const now = 1_000_000_000;
    const oneHour = 3600_000;
    const rows = [
      { ts: now - 1 * oneHour, alarm_value: 0x0240 },  // in window
      { ts: now - 10 * oneHour, alarm_value: 0x0240 }, // in window
      { ts: now - 50 * oneHour, alarm_value: 0x0240 }, // out of 48h window
      { ts: now - 5 * oneHour,  alarm_value: 0x0200 }, // wrong mask (bit 9 only)
    ];
    // minSpacingMs=0 disables the Slice κ.4 dedup gate so this asserts the
    // raw-count semantics.
    const r = countPatternEpisodesInWindow(rows, 0x0240, now, 48 * oneHour, 0);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.last_seen_ts,  now - 1 * oneHour);
    assert.strictEqual(r.first_seen_ts, now - 10 * oneHour);
  });

  // ── Slice κ.4 false-positive hardening ─────────────────────────────────
  test("matchesPattern: rejects 0xFFFF (sensor glitch — too many bits set)", () => {
    // 0xFFFF has 16 bits set. A real INGECON alarm payload rarely has
    // more than 4–5 bits raised; treating this as a match would let a
    // single comm reset look like every pattern in the catalogue.
    assert.strictEqual(matchesPattern(0xFFFF, 0x0240), false);
    assert.strictEqual(matchesPattern(0xFFFF, 0x0210), false);
  });

  test("matchesPattern: still accepts realistic multi-bit payloads", () => {
    // 0x02F0 has bits 4,5,6,7,9 set (5 bits) — still under the popcount cap,
    // so it must still match 0x0240 (bits 6+9 both present).
    assert.strictEqual(matchesPattern(0x02F0, 0x0240), true);
  });

  test("countPatternEpisodesInWindow: dedups flaps within minSpacingMs", () => {
    const now = 1_000_000_000;
    const min30 = 30 * 60 * 1000;
    // Three matches within 1 min should collapse to one episode under the
    // 30-min spacing rule. A fourth match 2 hours later is a separate
    // episode.
    const rows = [
      { ts: now - 500,         alarm_value: 0x0240 },  // flap of next
      { ts: now - 1_000,       alarm_value: 0x0240 },  // anchor of first cluster
      { ts: now - 30_000,      alarm_value: 0x0240 },  // flap of anchor
      { ts: now - 2 * 60 * 60 * 1000, alarm_value: 0x0240 }, // distinct, 2 h later
    ];
    const r = countPatternEpisodesInWindow(rows, 0x0240, now, 48 * 60 * 60 * 1000, min30);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.raw_matches, 4);   // forensic: pre-dedup matches
  });

  test("countPatternEpisodesInWindow: rejects 0xFFFF rows entirely (popcount gate)", () => {
    const now = 1_000_000_000;
    const rows = [
      { ts: now - 1000, alarm_value: 0xFFFF }, // sensor glitch
      { ts: now - 2000, alarm_value: 0xFFFF }, // sensor glitch
    ];
    const r = countPatternEpisodesInWindow(rows, 0x0240, now, 48 * 60 * 60 * 1000, 0);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.raw_matches, 0);
  });

  test("evaluateCriticalPatterns: production default applies 30-min spacing", () => {
    const now = 1_000_000_000;
    // 5 flaps within 5 seconds — would have been "critical" pre-Slice-κ.4,
    // but the production default spacing collapses to 1 episode = watch.
    const rows = [
      { ts: now - 1000, alarm_value: 0x0240 },
      { ts: now - 2000, alarm_value: 0x0240 },
      { ts: now - 3000, alarm_value: 0x0240 },
      { ts: now - 4000, alarm_value: 0x0240 },
      { ts: now - 5000, alarm_value: 0x0240 },
    ];
    const res = evaluateCriticalPatterns(rows, { now });
    const breach = res.find((r) => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.count_in_window, 1);
    assert.strictEqual(breach.severity, "watch");
    assert.strictEqual(breach.raw_matches, 5);
    assert.strictEqual(breach.min_spacing_ms, 30 * 60 * 1000);
  });

  test("matchesPattern: excludeMask blocks otherwise-matching value", () => {
    // Bit 6 alone (0x0040) matches mask=0x0040
    assert.strictEqual(matchesPattern(0x0040, 0x0040, 0x0200), true);
    // Bit 6 + bit 9 (0x0240) ALSO has bit 6 — but the exclude (bit 9 = 0x0200)
    // blocks it from matching the 0x0040 pattern.
    assert.strictEqual(matchesPattern(0x0240, 0x0040, 0x0200), false);
    // Bit 6 + bit 0 = 0x0041 — bit 9 not set, still matches 0x0040.
    assert.strictEqual(matchesPattern(0x0041, 0x0040, 0x0200), true);
  });

  test("evaluateCriticalPatterns: 0x0040 (alone) recurs → critical; 0x0240 unchanged", () => {
    const now = 1_000_000_000;
    const oneHour = 3_600_000;
    // Two ADC/Sync-alone events 2 h apart (passes spacing) — fires 0x0040.
    // Neither has bit 9 set, so 0x0240 should NOT fire.
    const rows = [
      { ts: now - 1 * oneHour, alarm_value: 0x0040 },
      { ts: now - 3 * oneHour, alarm_value: 0x0040 },
    ];
    const res = evaluateCriticalPatterns(rows, { now });
    const adc    = res.find((r) => r.key === "ADC_SYNC_PERSISTENT");
    const breach = res.find((r) => r.key === "DC_SUBSTRATE_BREACH");
    const acoc   = res.find((r) => r.key === "DC_FAULT_AC_OVERCURRENT");
    assert.strictEqual(adc.count_in_window, 2);
    assert.strictEqual(adc.severity, "critical");
    assert.strictEqual(breach.count_in_window, 0);
    assert.strictEqual(breach.severity, "ok");
    assert.strictEqual(acoc.count_in_window, 0);
  });

  test("evaluateCriticalPatterns: 0x0240 event does NOT also count toward 0x0040 (mutual exclusion)", () => {
    const now = 1_000_000_000;
    const oneHour = 3_600_000;
    // Two 0x0240 events (bits 6 + 9) — should fire 0x0240 only.
    // Without exclude_mask, both rows would also match 0x0040 (subset).
    const rows = [
      { ts: now - 1 * oneHour, alarm_value: 0x0240 },
      { ts: now - 3 * oneHour, alarm_value: 0x0240 },
    ];
    const res = evaluateCriticalPatterns(rows, { now });
    const adc    = res.find((r) => r.key === "ADC_SYNC_PERSISTENT");
    const breach = res.find((r) => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.count_in_window, 2);
    assert.strictEqual(breach.severity, "critical");
    assert.strictEqual(adc.count_in_window, 0,
      "0x0240 events must not double-count toward 0x0040");
    assert.strictEqual(adc.severity, "ok");
  });

  test("evaluateCriticalPatterns: mixed 0x0040 + 0x0240 — each counted in its own bucket only", () => {
    const now = 1_000_000_000;
    const oneHour = 3_600_000;
    const rows = [
      // 3 ADC/Sync alone, spaced
      { ts: now - 1 * oneHour, alarm_value: 0x0040 },
      { ts: now - 3 * oneHour, alarm_value: 0x0040 },
      { ts: now - 5 * oneHour, alarm_value: 0x0040 },
      // 2 escalated to 0x0240, spaced
      { ts: now - 7 * oneHour, alarm_value: 0x0240 },
      { ts: now - 9 * oneHour, alarm_value: 0x0240 },
    ];
    const res = evaluateCriticalPatterns(rows, { now });
    const adc    = res.find((r) => r.key === "ADC_SYNC_PERSISTENT");
    const breach = res.find((r) => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(adc.count_in_window, 3);
    assert.strictEqual(breach.count_in_window, 2);
    // Both are critical; ranks (4 for breach, 2 for ADC) make the worst-pick
    // pick breach in the enforcer.
    assert.strictEqual(adc.severity, "critical");
    assert.strictEqual(breach.severity, "critical");
  });

  test("evaluateCriticalPatterns: explicit minSpacingMs=0 restores legacy raw count", () => {
    const now = 1_000_000_000;
    const rows = [
      { ts: now - 1000, alarm_value: 0x0240 },
      { ts: now - 2000, alarm_value: 0x0240 },
    ];
    const res = evaluateCriticalPatterns(rows, { now, minSpacingMs: 0 });
    const breach = res.find((r) => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.count_in_window, 2);
    assert.strictEqual(breach.severity, "critical");
  });

  test("countPatternEpisodesInWindow: counts all matching rows (no cap on raw count)", () => {
    const now = 1_000_000_000;
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push({ ts: now - i * 60_000, alarm_value: 0x0240 });
    }
    // minSpacingMs=0 → legacy raw-count semantics (1 episode per row).
    const r = countPatternEpisodesInWindow(rows, 0x0240, now, DEFAULT_WINDOW_MS, 0);
    assert.strictEqual(r.count, 50);
    assert.strictEqual(r.episodes.length, 50);
  });

  test("evaluateCriticalPatterns: caps episodes list at 20 for UI sanity", () => {
    const now = 1_000_000_000;
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push({ ts: now - i * 60_000, alarm_value: 0x0240 });
    }
    // Pass minSpacingMs:0 so we get all 50 episodes (not deduped) and
    // can assert the 20-cap.
    const res = evaluateCriticalPatterns(rows, { now, minSpacingMs: 0 });
    const breach = res.find(r => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.count_in_window, 50);
    assert.strictEqual(breach.episodes.length, 20);  // capped for UI
  });

  // ── evaluateCriticalPatterns ────────────────────────────────────────────
  test("evaluateCriticalPatterns: no rows → every catalogue entry 'ok', not recurring", () => {
    const res = evaluateCriticalPatterns([], { now: 1_000_000_000 });
    assert.strictEqual(res.length, CRITICAL_PATTERNS.length);
    for (const r of res) {
      assert.strictEqual(r.severity, "ok");
      assert.strictEqual(r.recurring, false);
      assert.strictEqual(r.count_in_window, 0);
    }
  });

  test("evaluateCriticalPatterns: 1 episode → 'watch', not yet critical", () => {
    const now = 1_000_000_000;
    const rows = [{ ts: now - 3600_000, alarm_value: 0x0240 }];
    const res = evaluateCriticalPatterns(rows, { now });
    const breach = res.find(r => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.severity, "watch");
    assert.strictEqual(breach.recurring, false);
    assert.strictEqual(breach.count_in_window, 1);
  });

  test("evaluateCriticalPatterns: 2 episodes within 48h → CRITICAL, recurring", () => {
    const now = 1_000_000_000;
    const rows = [
      { ts: now - 2 * 3600_000,  alarm_value: 0x0240 },
      { ts: now - 30 * 3600_000, alarm_value: 0x0240 },
    ];
    const res = evaluateCriticalPatterns(rows, { now });
    const breach = res.find(r => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.severity, "critical");
    assert.strictEqual(breach.recurring, true);
    assert.strictEqual(breach.count_in_window, 2);
  });

  test("evaluateCriticalPatterns: 0x0210 path independent of 0x0240", () => {
    const now = 1_000_000_000;
    const rows = [
      { ts: now - 2 * 3600_000,  alarm_value: 0x0210 },
      { ts: now - 20 * 3600_000, alarm_value: 0x0210 },
      { ts: now - 30 * 3600_000, alarm_value: 0x0211 },  // bits 0+4+9 → superset match
    ];
    const res = evaluateCriticalPatterns(rows, { now });
    const acoc = res.find(r => r.key === "DC_FAULT_AC_OVERCURRENT");
    assert.strictEqual(acoc.severity, "critical");
    assert.strictEqual(acoc.recurring, true);
    assert.strictEqual(acoc.count_in_window, 3);
    const breach = res.find(r => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.severity, "ok");
  });

  test("evaluateCriticalPatterns: 2 episodes spanning > 48h → only counts in-window", () => {
    const now = 1_000_000_000;
    const rows = [
      { ts: now - 5 * 3600_000,  alarm_value: 0x0240 },
      { ts: now - 60 * 3600_000, alarm_value: 0x0240 },  // outside 48h
    ];
    const res = evaluateCriticalPatterns(rows, { now });
    const breach = res.find(r => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.count_in_window, 1);
    assert.strictEqual(breach.severity, "watch");
    assert.strictEqual(breach.recurring, false);
  });

  test("evaluateCriticalPatterns: custom minCount=3 raises threshold", () => {
    const now = 1_000_000_000;
    const rows = [
      { ts: now - 1 * 3600_000, alarm_value: 0x0240 },
      { ts: now - 2 * 3600_000, alarm_value: 0x0240 },
    ];
    const res = evaluateCriticalPatterns(rows, { now, minCount: 3 });
    const breach = res.find(r => r.key === "DC_SUBSTRATE_BREACH");
    assert.strictEqual(breach.recurring, false);
    assert.strictEqual(breach.severity, "watch");  // 2 < 3 but > 0
  });

  // ── hasAnyCriticalPattern / worstSeverity ───────────────────────────────
  test("hasAnyCriticalPattern: detects critical entry", () => {
    const statuses = [{ severity: "ok" }, { severity: "critical" }, { severity: "watch" }];
    assert.strictEqual(hasAnyCriticalPattern(statuses), true);
  });

  test("hasAnyCriticalPattern: no critical → false", () => {
    const statuses = [{ severity: "ok" }, { severity: "watch" }];
    assert.strictEqual(hasAnyCriticalPattern(statuses), false);
  });

  test("worstSeverity ranks critical > watch > ok", () => {
    assert.strictEqual(worstSeverity([{ severity: "ok" }]), "ok");
    assert.strictEqual(worstSeverity([{ severity: "watch" }, { severity: "ok" }]), "watch");
    assert.strictEqual(worstSeverity([{ severity: "critical" }, { severity: "watch" }]), "critical");
    assert.strictEqual(worstSeverity([]), "ok");
    assert.strictEqual(worstSeverity(null), "ok");
  });

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  criticalAlarmPatternsCore.test.js complete\n");
}

run();
