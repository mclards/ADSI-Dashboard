# pac_w Decascale Fix — dailyAggregator Double-Scale Bug

**Date:** 2026-04-28
**Status:** ✅ Fixed in main, migration auto-runs on next boot
**Severity:** P1 (operator-visible, but cosmetic — authoritative dashboard energy unaffected)
**Affected releases:** v2.10.0-beta.1, beta.2, beta.3, beta.4

## Symptom

Operator screenshot of the Parameters page totals strip on 2026-04-28:

```
PAC-INTEGRATED  ETOTAL Δ   PARCE Δ
13.315 MWh      1.319 MWh  1.319 MWh
```

Ratio: 13.315 / 1.319 = **10.094** — exactly 10× too high.

Etotal Δ and parcE Δ are correct (independently computed from hardware counters). PAC-INTEGRATED was the only inflated value.

## Root cause

[server/poller.js:596](../../server/poller.js#L596) converts the raw register-18 value (deca-watts) to watts inside `parseRow`:

```js
const safePac = pac * 10 <= 260000 ? pac * 10 : 0;
```

After `parseRow`, `parsed.pac` is **already in watts** (capped at 260 kW per node). All downstream consumers correctly treat it as watts:

- [server/db.js:2484](../../server/db.js#L2484) — `Math.round(frame.pac)` (correct, with explicit comment "already ×10")
- [server/db.js:2683](../../server/db.js#L2683) — `eod_clean_pac_w: pac_w` (correct)

The new v2.10.0 5-min aggregator regressed:

```js
// server/dailyAggregator.js:267 (BEFORE FIX)
if (pac != null)  { b.sumPac += pac * 10; b.nPac++; touched++; }
                                  ^^^^
                            // double-scale — comment claimed reg 18 was deca-W
                            // but parseRow already handled the conversion.
```

Stored `pac_w` = `(avg watts) × 10`. Every consumer of `inverter_5min_param.pac_w` then computed:

```
PAC-INTEGRATED kWh = pac_w × (5 min / 60 min) / 1000
                   = (avg_W × 10) × 0.0833 / 1000
                   = 10 × correct value
```

## Affected surfaces (all 10× inflated before fix)

1. Parameters page — totals strip "PAC-INTEGRATED" cell
2. Parameters page — per-row `Pac` and `Partial Energy` columns
3. Daily Data Export XLSX — `Pac_W` column, `PartialEnergy_kWh` column, `DAY TOTAL — Pac-integrated (kWh)` row

## NOT affected (verified)

- Header "Today Energy" chip — uses `pacTodayByInverter` (Path B) anchored on Python's per-unit `kwh_today`. Never touches `inverter_5min_param`.
- `inverter_counter_state.pac_w` and `inverter_counter_baseline.eod_clean_pac_w` — written by [server/db.js:2484](../../server/db.js#L2484) without re-scaling.
- Cloud DB / Postgres replication — `inverter_5min_param` is gateway-local (not in replicated table list at [server/index.js:580](../../server/index.js#L580)).
- Forecast / ML training data — `services/inverter_engine.py` uses Python's own integration; Node forecast features pull from `inverter_5min` + `energy_5min`, never `inverter_5min_param`.
- Frozen-counter detection — uses `inverter_counter_state.pac_w` (correct path).
- Etotal Δ, parcE Δ in totals strip and Daily Data Export — read from `inverter_counter_state` / `inverter_counter_baseline`.

## Fix — three parts

### 1. Code fix ([server/dailyAggregator.js:267](../../server/dailyAggregator.js#L267))

```js
// BEFORE
if (pac != null)  { b.sumPac += pac * 10; b.nPac++; touched++; }   // reg 18 is deca-watts

// AFTER
if (pac != null)  { b.sumPac += pac; b.nPac++; touched++; }   // poller.parseRow already scaled deca-watts → watts
```

### 2. Range gate alignment ([server/dailyAggregator.js:177](../../server/dailyAggregator.js#L177))

```js
// BEFORE
pac:    [0, 1_000_000],     // per-unit deca-watts; 1 GW ceiling well above 250 kW × 4 nodes

// AFTER
pac:    [0, 260_000],       // per-unit watts; matches poller.parseRow safePac clamp (260 kW)
```

### 3. One-shot historical migration ([server/db.js](../../server/db.js))

Idempotent post-schema repair, gated by `settings.pac_w_decascale_repaired`:

```sql
UPDATE inverter_5min_param
   SET pac_w = CAST(ROUND(pac_w / 10.0) AS INTEGER)
 WHERE pac_w IS NOT NULL AND pac_w > 0;
```

Sets the flag to `'1'` on success, writes an `audit_log` row, no-ops on subsequent boots. Safe because the bug was uniform across every row written from beta.1 onward — there are no mixed-correctness rows.

### 4. Live-bucket time-fraction scaling ([server/index.js:_computeParamTotals](../../server/index.js#L12976))

The live bucket's contribution to PAC-INTEGRATED was previously projected through the full 5-min slot regardless of elapsed time, causing a ~25 kWh-per-inverter wobble at every slot rollover. Now scaled by `(now − slot_start_ms) / 300_000`:

```js
const slotStartMs = Number(live.slot_start_ms || 0);
const elapsedMs = slotStartMs > 0
  ? Math.max(0, Math.min(5 * 60 * 1000, Date.now() - slotStartMs))
  : 5 * 60 * 1000;  // fallback: full slot
pacKwh += w * elapsedMs / 3_600_000 / 1000;  // W × hours / 1000 = kWh
```

`getCurrentBucket()` extended with `slot_start_ms` so the totals computation can perform the fraction inline.

## Tests updated

[server/tests/dailyAggregatorCore.test.js](../../server/tests/dailyAggregatorCore.test.js) had locked in the buggy convention with assertions like `assert.strictEqual(insertedRows[0].pac_w, 1000, "100 deca-W * 10 = 1000 W")`. Re-baselined to the post-`parseRow` watts convention:

| Site | Before | After |
|---|---|---|
| `makeFrame.pac` default | `100` (deca-W) | `1000` (W) |
| Slot-rollover assertion | `pac_w === 1000` (`pac × 10`) | `pac_w === 1000` (input already W) |
| Aggregated row shape | `pac_w === 1100` (`(100+120)/2 × 10`) | `pac_w === 1100` (`(1000+1200)/2`) |

## Validation

```
$ node server/tests/dailyAggregatorCore.test.js
dailyAggregatorCore.test.js — all 18 scenarios passed.

$ node server/tests/dailyAggregatorCoverage.test.js
dailyAggregatorCoverage.test.js — all 15 scenarios passed.

$ node server/tests/energySummaryScaleCore.test.js
energySummaryScaleCore.test.js: PASS

$ node server/tests/counterHealth.test.js
counterHealth.test: OK
```

## Rollout

- Code fix ships in next release (v2.10.0-beta.5 or rc.1).
- Migration runs automatically on first gateway boot of the new version.
- Operators previously issued Daily Data Exports with inflated `Pac_W` and `PartialEnergy_kWh` columns can re-export after the migration runs to get corrected XLSX files.
- `Etotal_kWh`, `ParcE_kWh`, `Energy_kWh` columns in those historical exports are correct — no need to re-issue if the operator only needs energy figures.

## Forensic provenance

- Bug introduced: commit [`18aa3bc`](../../) — "Version bump to 2.10.0-beta.1" (initial dailyAggregator addition)
- Bug detected: 2026-04-28, operator screenshot of Parameters page
- Diagnosis: 10.094× ratio against Etotal Δ on the same row + grep of `pac * 10` revealing the double-scale path
- Fix committed: 2026-04-28
- Migration safe to auto-apply: every row in `inverter_5min_param` was written through the buggy path; no row was ever correct.
