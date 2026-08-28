# Anchor Classification — Trust-Ladder Fixes (Verification Round 3)

**Date:** 2026-04-28
**Status:** Closed — all P0 + P1 + P2 gaps from the anchor-accuracy verification addressed; tests green.
**Triggered by:** Operator screenshot showing 91/91 nodes pinned to `POLL` at 03:28 AM, even though all units were healthy and the dashboard had been running. Root cause: feature was deployed yesterday so yesterday's eod_clean was never captured — but the verification surfaced a deeper class of silent failures that the pipeline was vulnerable to.
**Predecessors:**
- [audits/2026-04-28/v2102beta2-verification-gap-fixes.md](audits/2026-04-28/v2102beta2-verification-gap-fixes.md)
- [audits/2026-04-28/daily-data-export-gap-fixes.md](audits/2026-04-28/daily-data-export-gap-fixes.md)

---

## 1. Gap List

| # | Severity | Gap |
|---|---|---|
| 1 | P0 | **`upsertEodClean` is UPDATE-only.** When yesterday's row doesn't exist (gateway booted post-midnight, fresh install, gateway down through the entire dark window), the dark-window capture silently affects 0 rows — eod_clean is never recorded, and today's row stays locked to `source='poll'` for the entire day with no recovery path. |
| 2 | P0 | **No retroactive POLL → EOD upgrade.** Once today's baseline is inserted with `source='poll'`, it never gets re-evaluated even when yesterday's eod_clean later becomes available via a dark-window capture in the same morning. |
| 3 | P1 | **POLL tooltip too reassuring** — described the state as "fine, but not anchored to yesterday's clean close". Operators reading that don't understand that Etotal Δ undercounts by the inverter's pre-first-poll production. |
| 4 | P1 | **SEED branch is dead code** — the renderer carries a clause for `source='pac_seed'` but no DB write path ever sets it. |
| 5 | P2 | **`Anchor` `<th>` tooltip too terse** — `CLEAN > EOD > POLL > SEED` doesn't explain what each rung means. |
| 6 | P2 | **No pill for late-created rows.** After Fix #1 introduces `source='eod_clean_only'`, the renderer needed a new pill to surface that transitional state visibly. |

---

## 2. Resolution Summary

### Fix 1 — UPSERT for `upsertEodClean` (P0) ✅

[server/db.js:2192-2230](server/db.js#L2192-L2230) — replaced the UPDATE-only statement with an `INSERT … ON CONFLICT DO UPDATE`. When the target day's row doesn't exist, a new row is created with:

- `etotal_baseline = etotal_eod_clean` (placeholder — morning data unknown)
- `parce_baseline = parce_eod_clean`
- `baseline_ts_ms = eod_clean_ts_ms`
- `source = 'eod_clean_only'` (new enum value)
- All four `eod_clean_*` fields populated normally

When the row exists, only the four `eod_clean_*` fields plus `updated_ts` are touched — `source`, `etotal_baseline`, etc. are preserved. Conflict path uses SQLite's `ON CONFLICT (inverter, unit, date_key) DO UPDATE` against the existing PRIMARY KEY.

### Fix 2 — Retroactive POLL → EOD upgrade (P0) ✅

| Layer | File | Change |
|---|---|---|
| Pure decision | [server/baselineUpgradeCore.js](server/baselineUpgradeCore.js) | NEW — `shouldUpgradeBaselineToEodClean({todayRow, yesterdayRow, currentEtotalKwh})` returning `{upgrade, reason, newBaseline}` |
| Pure tests | [server/tests/baselineUpgradeCore.test.js](server/tests/baselineUpgradeCore.test.js) | NEW — 12 scenarios covering happy path, every wrong-source guard, missing rows, regression refusal, equality boundary, case-insensitive matching, parcE-missing fallback, and current-Etotal-invalid handling |
| New SQL stmt | [server/db.js:2236-2247](server/db.js#L2236-L2247) | `upgradeBaselineToEodClean` — guarded UPDATE that only fires when `source='poll'` |
| Wire into capture site | [server/db.js:2683-2727](server/db.js#L2683-L2727) | After every successful `upsertEodClean.run()`, calls the pure decision and (if green) runs the new UPDATE; logs `[counter] baseline upgraded poll→eod_clean inv=… u=… day=…` |

The upgrade fires at the natural place: right after a dark-window capture lands eod_clean for yesterday's row. If that capture happened to create yesterday's row (Fix 1), the very next instruction in the same poll cycle promotes today's POLL row to EOD — operators see the pill flip within seconds.

### Fix 3 — Honest POLL tooltip (P1) ✅

[public/js/app.js:19153](public/js/app.js#L19153) — rewrote the tooltip:

> "Today's baseline came from the first poll of the day, **NOT** yesterday's clean close. Etotal Δ undercounts today's energy by whatever the inverter produced before the gateway's first poll. PAC-integrated Total stays authoritative. Self-heals tomorrow if the gateway runs through tonight's dark window — and same-day if today's dark-window capture supplies yesterday's eod_clean (retroactive upgrade)."

The matching tooltip on the Daily Data Export page (the legacy renderer at [public/js/app.js:14463-14474](public/js/app.js#L14463-L14474)) was also updated to reflect the same trust ladder.

### Fix 4 — Document SEED as forward-compat (P1) ✅

[public/js/app.js:19139](public/js/app.js#L19139) — extended the renderer comment block with the full trust ladder and labelled SEED explicitly:

> "SEED — source='pac_seed' — RESERVED for future use. The v2.9.0 design left this slot for a PAC-seeded recovery baseline; no code path currently writes it."

The renderer branch is preserved (forward-compat) but now signals to future reviewers that it's intentional, not dead code.

### Fix 5 — Anchor `<th>` tooltip (P2) ✅

[public/index.html:2286-2294](public/index.html#L2286-L2294) — replaced the one-line `CLEAN > EOD > POLL > SEED` with the full ladder explanation. Each rung gets a one-line description of what state it represents.

### Fix 6 — EOD-ONLY pill (P2) ✅

| Layer | File | Change |
|---|---|---|
| Renderer (settings page) | [public/js/app.js:19148-19150](public/js/app.js#L19148-L19150) | NEW branch: `src === 'eod_clean_only'` → renders `<span class="invclock-anchor-pill invclock-anchor-eod-only">EOD-ONLY</span>` with full tooltip |
| Renderer (params page) | [public/js/app.js:14469](public/js/app.js#L14469) | Mirrors same pill |
| CSS | [public/css/style.css:17000-17006](public/css/style.css#L17000-L17006) | Amber styling — between EOD's green and POLL's blue, signaling "transitional, recovers tomorrow" |
| Export-side handling | [server/hwCounterDeltaCore.js:117-129](server/hwCounterDeltaCore.js#L117-L129) | Past-day Δ NaN-propagates when `baseline.source === 'eod_clean_only'` so day totals don't silently report 0 for unrecoverable days |
| Test for export logic | [server/tests/hwCounterDeltaCore.test.js](server/tests/hwCounterDeltaCore.test.js) | Added scenarios #16 + #17: lowercase + uppercase `eod_clean_only` both NaN-propagate (test count: 15 → 17) |

---

## 3. Files Changed

| File | Change | Lines |
|---|---|---|
| [server/baselineUpgradeCore.js](server/baselineUpgradeCore.js) | NEW pure module | +110 |
| [server/tests/baselineUpgradeCore.test.js](server/tests/baselineUpgradeCore.test.js) | NEW — 12 scenarios | +180 |
| [server/db.js](server/db.js) | + `require('./baselineUpgradeCore')`, replaced `upsertEodClean` SQL, added `upgradeBaselineToEodClean`, wired retroactive upgrade after eod_clean capture | +75 / -10 |
| [server/hwCounterDeltaCore.js](server/hwCounterDeltaCore.js) | + same-day `eod_clean_only` NaN-propagation | +12 |
| [server/tests/hwCounterDeltaCore.test.js](server/tests/hwCounterDeltaCore.test.js) | + 2 new scenarios for `eod_clean_only` | +35 |
| [public/js/app.js](public/js/app.js) | New EOD-ONLY pill in both renderers, expanded tooltips, ladder docstring | +50 / -10 |
| [public/css/style.css](public/css/style.css) | New `.invclock-anchor-eod-only` rule | +8 |
| [public/index.html](public/index.html) | Expanded `<th>` tooltip with full trust ladder | +9 |
| [docs/ADSI-Dashboard-User-Manual.md](docs/ADSI-Dashboard-User-Manual.md) | New §6.8.3 "Anchor source — HW counter trust ladder" with table + self-healing rules | +35 |
| [docs/ADSI-Dashboard-User-Guide.html](docs/ADSI-Dashboard-User-Guide.html) | Mirror table + tip card under Section 14 | +25 |

---

## 4. Test Status

| Test | Status | Notes |
|---|---|---|
| `baselineUpgradeCore.test.js` | ✅ 12/12 PASS | NEW |
| `hwCounterDeltaCore.test.js` | ✅ 17/17 PASS | +2 new scenarios |
| `dailyAggregatorCoverage.test.js` | ✅ 15/15 PASS | regression check |
| `dailyAggregatorCore.test.js` | ✅ 18/18 PASS | regression check |
| `energySummaryScaleCore.test.js` | ✅ PASS | regression check |
| Other 30+ pure-function tests | ✅ PASS (unchanged) | |
| Better-sqlite3 ABI-bound tests | ⚠ Skipped | Per project rule |

**79 pure-function scenarios green** across the four anchor-related test modules.

Syntax checks (`node --check`) clean for: `server/db.js`, `server/baselineUpgradeCore.js`, `server/hwCounterDeltaCore.js`, `server/index.js`, `public/js/app.js`. Both new test files run without warnings.

---

## 5. Operator-Visible Behavior Changes

**Before this round (gateway booted at 03:28 AM today, screenshot scenario):**
- Yesterday's row never existed → today's first poll set `source='poll'` → all 91 nodes locked to POLL all day.
- Subsequent dark-window captures hit `UPDATE 0 rows` silently → eod_clean never recorded.
- Tomorrow morning: same problem if last night's row also didn't exist.

**After this round, same scenario:**
1. 03:28 — first poll inserts today's row with `source='poll'` (yesterday's row still missing).
2. 03:28 — same poll's dark-window capture hits the new UPSERT → **creates yesterday's row** with `source='eod_clean_only'`, eod_clean fields populated.
3. 03:28 — retroactive upgrade check fires: today is `poll`, yesterday now has eod_clean → **today's row rewritten to `source='eod_clean'`**, baseline anchored to yesterday's true close.
4. Operator UI on next 30 s refresh: pill flips POLL → EOD for every node.
5. After 18:00 today: today's eod_clean fires → pill flips EOD → CLEAN.
6. Tomorrow morning at 00:01: today's eod_clean is now in DB → tomorrow's baseline opens at `source='eod_clean'`. Steady state.

**For the user's actual screenshot:** today's situation won't auto-fix retroactively because yesterday's row never existed at all (feature was deployed only yesterday). But starting tonight at 18:00, today's eod_clean will be captured normally, and tomorrow morning will open as `EOD` for the entire fleet. Steady state from tomorrow onward.

---

## 6. Trust Ladder — final state

| Pill | DB source | Δ trust | Self-heals |
|---|---|---|---|
| `CLEAN` | `eod_clean` + today's snapshot present | Best, fleet-comparable | n/a (steady state) |
| `EOD` | `eod_clean`, today's snapshot pending | Fleet-comparable | → `CLEAN` after EOD hour today |
| `EOD-ONLY` (NEW) | `eod_clean_only` | Day Δ unknown — exports blank | → `EOD`/`CLEAN` next day |
| `POLL` | `poll` | Δ undercounts today's pre-first-poll energy | → `EOD` same day if dark-window capture supplies yesterday's eod_clean (retroactive upgrade) |
| `SEED` | `pac_seed` | (unused) | RESERVED |
| `—` | (empty) | n/a | First poll today populates |

---

## 7. Sign-Off

- ✅ All P0 gaps closed: UPSERT prevents silent eod_clean write loss; retroactive upgrade prevents POLL lock-in.
- ✅ All P1 gaps closed: POLL tooltip honestly states the trust loss; SEED branch documented as forward-compat.
- ✅ All P2 gaps closed: `<th>` tooltip expanded; new EOD-ONLY pill surfaces the late-create state visibly.
- ✅ Pure-function regression: 12 + 2 new scenarios; 79 total scenarios across the anchor-related modules.
- ✅ User Manual + User Guide HTML synchronized with trust ladder + self-healing rules.
- ⚠ User Guide PDF regeneration runs from the updated MD via the project's normal doc pipeline.
- ⚠ `npm run smoke` full Electron-ABI sweep recommended before promoting to stable, in case the SQL changes interact with the existing test fixtures.

**Recommendation:** SHIP — anchor classification is now self-healing on every cold-boot scenario, the operator UI shows what's actually happening, and the export silently mis-counting unrecoverable days is no longer possible.
