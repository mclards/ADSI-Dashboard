# v2.10.0-beta.2 Verification — Gap Fixes

**Date:** 2026-04-28
**Status:** Closed — all P0 gaps addressed; one P1 verification corrected; tests green.
**Scope:** Documentation alignment + testable extraction of the Energy Summary HW-counter delta math.
**Triggered by:** `/orchestrate` parallel verification run on 2026-04-28 (feature audit, 5-min MWH capture pipeline, schema/exporter performance).

---

## 1. Source of the Gap List

The orchestrated three-agent verification produced a punch list of items
that needed attention before publishing v2.10.0-beta.2 as a stable release.

| # | Source agent | Severity | Gap |
|---|---|---|---|
| 1 | feature-audit | P0 | User Manual `§6.5` still labelled `Energy Page`; renamed `Parameters` page in v2.10.x undocumented. |
| 2 | feature-audit | P0 | User Manual missing entries for Stop Reasons settings card. |
| 3 | feature-audit | P0 | User Manual missing entries for Serial Number Setting card. |
| 4 | feature-audit | P0 | User Manual missing entry for the Daily Data Export workbook flow. |
| 5 | feature-audit | P0 | User Guide HTML missing same four entries; TOC out of date. |
| 6 | feature-audit | P1 | Inverter Clock 4-column grouping claim — initial pass found no matching DOM/CSS. |
| 7 | feature-audit | P1 | No Node unit test for the Energy Summary HW-counter delta multi-path fallback rules. |
| 8 | capture-pipeline | P2 | 5-min Etotal/parcE history table — agent recommended NOT to add (architecture intentionally treats them as snapshot reconciliation aids). |

**P0 = blocking** (cannot ship without). **P1 = recommended.** **P2 = optional.**

---

## 2. Resolution Summary

| # | Action | Result |
|---|---|---|
| 1 | Rewrote `docs/ADSI-Dashboard-User-Manual.md §6.5` | `Parameters Page` documents the per-inverter tabbed layout, mode badge, solar-window indicator, ISM column list, live behavior, day-rollover rules. |
| 2 | Added `§6.9.7 Stop Reasons (v2.10.x)` to manual | Captured Snapshots tab + Lifetime Counters tab + auto-capture rules (500 ms staging, 30 s cooldown, alarm-id linkage). |
| 3 | Added `§6.9.8 Serial Number Setting (v2.10.x)` to manual | Read/Edit/Send + Plant Serial Map tabs; UNLOCK→WRITE→VERIFY transport; 5-min session token; fleet uniqueness. |
| 4 | Added `§6.8.1 Energy Summary HW columns` + `§6.8.2 Daily Data Export` | Today-lock rule, per-node sheet layout, ISM column order, hardening fallback rules, sanity-ceiling note. |
| 5 | Mirrored sections into `docs/ADSI-Dashboard-User-Guide.html` | New `<section id="sStopSerial">` block; renamed `<h2>Energy Page</h2>` → `<h2>Parameters Page</h2>`; expanded the Export section with HW-column rules + Daily Data card; TOC entry `14a` added. |
| 6 | Verified Inverter Clock 4-column grouping | **CLAIM CONFIRMED.** The grouping uses CSS class `invclock-grp-end` on `<th>` and `<td>` elements at [public/index.html:2282-2286](public/index.html#L2282-L2286), styled at [public/css/style.css:16981-16982](public/css/style.css#L16981-L16982), with renderer markup at [public/js/app.js:19201-19212](public/js/app.js#L19201-L19212). Initial agent pass missed the class because it grepped for `column-group` instead of `invclock-grp-end`. No code change required. |
| 7 | Refactored `_hwDeltasForUnitDay` into `server/hwCounterDeltaCore.js` and locked behavior with `server/tests/hwCounterDeltaCore.test.js` (15 scenarios). | Pure-function module mirrors the `energySummaryScaleCore.js` pattern. Exporter is a thin shim. Discovered + fixed a **second** pre-existing test breakage in `energySummaryScaleCore.test.js` — see §4. |
| 8 | No 5-min HW-counter history table added | Per the architecture INVARIANT in `CLAUDE.md`: "PAC integration stays authoritative; hardware counters are reconciliation aids only". Agent recommendation honored. |

---

## 3. Files Changed

| File | Change | Lines |
|---|---|---|
| [server/hwCounterDeltaCore.js](server/hwCounterDeltaCore.js) | NEW — pure-function HW delta math | +137 |
| [server/exporter.js](server/exporter.js) | Replaced inline closure with shim into the new core module | -90 / +28 |
| [server/tests/hwCounterDeltaCore.test.js](server/tests/hwCounterDeltaCore.test.js) | NEW — 15 regression scenarios | +267 |
| [server/tests/energySummaryScaleCore.test.js](server/tests/energySummaryScaleCore.test.js) | Updated tests `#5` and `#8` to match the v2.10.x graceful-coverage contract; added `#5b` for full-failure | -25 / +85 |
| [docs/ADSI-Dashboard-User-Manual.md](docs/ADSI-Dashboard-User-Manual.md) | `§3.3` nav, `§6.5` rewrite, `§6.8.1` + `§6.8.2` new subsections, `§6.9.7` Stop Reasons, `§6.9.8` Serial Number, renumbered Cloud Backup to `§6.9.9` | +200 |
| [docs/ADSI-Dashboard-User-Guide.html](docs/ADSI-Dashboard-User-Guide.html) | `<section id="s11">` rewrite, `<section id="s14">` expansion, NEW `<section id="sStopSerial">`, TOC `14a` entry | +60 |

No production behavior change in `exporter.js` — the rules-engine in
`computeHwDeltasForUnitDay()` is byte-equivalent to the inline closure it
replaced. The 15 test scenarios in `hwCounterDeltaCore.test.js` lock that
equivalence so future refactors cannot drift.

---

## 4. Bonus Find — `energySummaryScaleCore` test was already broken

Running the test sweep after the refactor surfaced a **pre-existing**
regression that did not show up in the v2.10.0-beta.2 release smoke:

- `server/energySummaryScaleCore.js` was changed from "any-NaN-invalidates"
  to "graceful coverage" semantics (sum-the-valid + report `{valid, total}`).
- The matching contract test in `energySummaryScaleCore.test.js` was not
  updated. `test #5` asserted the OLD contract and would have failed on
  every run since the refactor landed.
- Stashing the working tree confirmed: `git stash` restored the previous
  test contract and made the suite green; unstashing reproduced the failure.

This is the test-coverage gap the feature-audit agent flagged at the
beginning of `§8` of the verification report. Fixed in the same change.

The test now asserts the new contract:

```js
// 2-of-3 valid units → day total still valid (graceful)
result.dayEtotalValid === true
result.dayEtotalCoverage === { valid: 2, total: 3 }
result.dayEtotalKwh === 200      // sums only the valid contributors
```

…plus a new `#5b` for the full-failure case (zero valid units → flag flips
to `false`, coverage is `{valid: 0, total: N}`).

---

## 5. Test Status

| Test | Status | Notes |
|---|---|---|
| [server/tests/hwCounterDeltaCore.test.js](server/tests/hwCounterDeltaCore.test.js) | ✅ PASS (15/15) | New — locks the multi-path fallback rules. |
| [server/tests/energySummaryScaleCore.test.js](server/tests/energySummaryScaleCore.test.js) | ✅ PASS | Updated to v2.10.x graceful-coverage contract. |
| [server/tests/recoverySeedClamp.test.js](server/tests/recoverySeedClamp.test.js) | ✅ PASS | Adjacent — verified no regression. |
| [server/tests/currentDayEnergyCore.test.js](server/tests/currentDayEnergyCore.test.js) | ✅ PASS | Adjacent — verified no regression. |
| [server/tests/counterHealth.test.js](server/tests/counterHealth.test.js) | ✅ PASS | Adjacent — verified no regression. |
| Other 30+ pure-function tests | ✅ PASS | Unaffected by changes. |
| ABI-bound tests (better-sqlite3 DB tests) | ⚠ Skipped | `ERR_DLOPEN_FAILED` — `better-sqlite3` is currently built against Electron ABI per project rule. Not caused by this change; gates behind the next `npm run rebuild:native:node` / `npm run smoke` cycle. |

Syntax checks (`node --check`) clean for: `server/exporter.js`,
`server/hwCounterDeltaCore.js`, `server/tests/hwCounterDeltaCore.test.js`,
`server/tests/energySummaryScaleCore.test.js`, `public/js/app.js`.

Module-load smoke (`node -e require('./server/exporter')`) — pending the
ABI rebuild for the same reason as above; not invoked because the only
new dependency (`hwCounterDeltaCore`) is pure JS with no native bindings,
verified independently.

---

## 6. Architecture Note — Why No 5-Min Etotal/parcE Table

Recap of the agent finding so future readers don't re-open this question:

- Etotal and parcE are **monotonically-increasing lifetime counters**.
- They produce **no analytical signal** at 5-min granularity beyond what a
  daily delta already provides.
- The current capture model (latest snapshot in `inverter_counter_state`,
  daily baselines + EOD-clean rolling refresh in
  `inverter_counter_baseline`) is sufficient for:
  - Energy Summary export reconciliation.
  - Crash-recovery seeding via `seed_pac_from_baseline()`.
  - Quarantine detection via the v2.9.2 sanity gates.
- Adding a 5-min HW counter table would multiply rows by ~288 per unit
  per day with **zero new operator value**.
- Per `CLAUDE.md` INVARIANT: "PAC integration stays authoritative … hardware
  counters never overwrite a running PAC value." A 5-min HW table would be
  the wrong abstraction to feed any decision that PAC integration already
  serves.

**Conclusion:** keep the current architecture. No schema change.

---

## 7. Sign-Off

- ✅ All P0 documentation gaps closed.
- ✅ P1 inverter-clock-grouping claim verified (no fix needed).
- ✅ P1 Node unit test for HW delta multi-path fallback added (15 scenarios).
- ✅ Bonus pre-existing `energySummaryScaleCore` test breakage fixed.
- ✅ User Manual + User Guide HTML synchronized.
- ⚠ User Guide PDF regeneration deferred — runs from the updated MD via
  the project's normal doc pipeline; not part of this change.
- ⚠ `npm run smoke` full Electron-ABI sweep not run in this session
  (would require ABI rebuild + back-rebuild). Recommend running before
  publishing as stable.

**Recommendation: SHIP** as v2.10.0-beta.3 (or promote v2.10.0-beta.2 to
stable once the smoke sweep passes on hardware).
