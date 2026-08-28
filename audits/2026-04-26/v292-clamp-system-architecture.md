# v2.9.2 Clamp System — Architecture and End-to-End Audit

**Date:** 2026-04-26
**Status:** Complete — all gaps closed
**Scope:** Recovery-seed and 5-min bucket spike protection in [server/poller.js](../../server/poller.js), plus every downstream pipeline that reads `energy_5min`.

---

## 1. Background

On 2026-04-26 ~06:40 the analytics chart's Actual (MWh) line showed a 1.86 MWh / 22.331 MW spike — physically impossible for a 27 MW plant at dawn. Root cause: the v2.9.0 hardware-counter recovery path (`seed_pac_from_baseline()` in [services/inverter_engine.py](../../services/inverter_engine.py)) re-seeds Python's `kwh_today` to `current_Etotal − midnight_baseline` after a restart. Node's poller computed the delta against the prior-frame `pythonKwh`, producing a multi-MWh `pythonDelta` that landed in a single 5-min bucket on `energy_5min` and polluted the actual-MWh series the ML day-ahead model trains on.

v2.9.2 closes this failure by adding multi-rule clamps at the writer side in [server/poller.js](../../server/poller.js), backed by pure helpers in [server/pollerClampCore.js](../../server/pollerClampCore.js).

---

## 2. The clamp system in three rules

### Rule 1 — Per-frame recovery-seed clamp

Location: `integratePacToday()` in [server/poller.js:506](../../server/poller.js#L506).

dt-aware ceiling computed by `maxRecoveryDeltaKwhForDt(dtSec)`:

```
ceiling = (INVERTER_MAX_KW × max(FRAME_DT_FLOOR_S, dtSec) × RECOVERY_CLAMP_SAFETY) / 3600
        = (1000 × max(1.5, dtSec) × 1.5) / 3600
```

| dtSec | ceiling (kWh) | Use case |
|---|---|---|
| 0.2 (200 ms typical poll) | 0.625 | Hard ceiling on a per-poll delta — 1860 kWh seed × 2978× over |
| 1.5 (floor) | 0.625 | Below-floor dt uses the floor |
| 30 (`MAX_PAC_DT_S`) | 12.5 | Boundary for trapezoid fallback |
| 60 (Node event-loop stall) | 25 | Legitimate Python catch-up passes |
| 600 (10-min Modbus chain reconnect) | 250 | Passes; bucket clamp catches single-slot dump |

Action when tripped:
1. `verdict.appliedDelta = 0` (drop entirely — do not bleed across frames).
2. `prev.pythonKwh ← pythonKwh` (re-anchor; subsequent frames measure from new baseline).
3. `pollStats.recoverySeedClipCount++`, `recoverySeedClipTotalKwh += rawDelta`.
4. `audit_log` row with `action='recovery_seed_clip'`, full prev/new/dt/ceiling context.

The decision to drop (vs. spread the delta over later frames) is deliberate: spreading would distort the time-of-day distribution that ML training relies on. The quarantined energy is preserved in `inverter_counter_state` (HW counters) for export reconciliation.

### Rule 2 — Per-bucket physical ceiling (per inverter, scaled by configured unit count)

Location: `update5minBucket()` in [server/poller.js:835](../../server/poller.js#L835), `flushPending()` partial-flush in [server/poller.js:1453](../../server/poller.js#L1453).

The physical ceiling is **scaled per inverter** by its configured unit count from `ipConfigCache.units[inv]`:

```
physicalCeiling = (unitsCount × UNIT_RATED_KW × 5 × BUCKET_CEILING_SAFETY) / 60
                = (unitsCount × 250 × 5 × 1.2) / 60
                = unitsCount × 25 kWh
```

| Configured units | Rated kW | Slot max (no safety) | Physical ceiling |
|---|---|---|---|
| 1 unit | 250 kW | 20.83 kWh | **25 kWh** |
| 2 units | 500 kW | 41.67 kWh | **50 kWh** |
| 3 units | 750 kW | 62.50 kWh | **75 kWh** |
| 4 units | 1000 kW | 83.33 kWh | **100 kWh** |

The math is reordered to be integer-exact for the canonical 4-unit case:
`(4 × 250 × 5 × 1.2) / 60 = 6000/60 = 100` exactly (no floating-point drift).

Defensive normalization for `unitsCount`:
- `undefined`/`null`/`NaN` → 4 (default — no value specified).
- explicit 1–4 → use as-is.
- 0 / negative / 5+ → clamped into [1, 4].

### Rule 3 — Contextual gap-backfill (with 1-hour warm-up gate)

Location: same as Rule 2.

The operator's mental model: a slot's value is suspect if the preceding window says the inverter **wasn't reporting** (real outage), regardless of whether the value is below the physical ceiling. The contextual rule encodes this directly using a per-inverter ring buffer of the last 12 (`RECENT_SLOTS_WINDOW = 1 hour`) bucket-inc values.

Decision flow (post warm-up):
1. Walk preceding slots from newest → oldest, count consecutive zeros.
2. If `consecutiveZeros ≥ CONSECUTIVE_ZEROS_FOR_GAP (= 4)` AND a non-zero exists further back AND `inc > postGapThreshold` → trip.
3. `postGapThreshold = unitsCount × 250 × 5 × 0.4 / 60 = unitsCount × 8.33 kWh`. Per-inverter scaling means a 2-unit inverter trips at smaller absolute values where appropriate.

Two checks gate the rule:
- **`foundNonZero` further back**: prevents false positives during nighttime/dawn (when preceding zeros are natural, not gap).
- **Warm-up**: contextual rule is dormant until ring buffer holds `WARM_UP_SLOTS = 12` entries (= 1 hour of poll observation since boot). Until then, only Rule 2 (physical ceiling) plus the per-frame Rule 1 protect.

Per-inverter unit-count-scaled ceilings:

| Configured units | Physical ceiling | Gap-backfill threshold | Catch-up minimum |
|---|---|---|---|
| 1 unit | 25 kWh | 8.33 kWh | Catches very small catch-up |
| 2 units | 50 kWh | 16.67 kWh | |
| 3 units | 75 kWh | 25.00 kWh | |
| 4 units | 100 kWh | 33.33 kWh | |

---

## 3. End-to-end pipeline trace

### 3.1 Writer side (energy_5min producers)

| Writer | Location | Clamp applied? | Note |
|---|---|---|---|
| `update5minBucket` regular flush | [poller.js:835](../../server/poller.js#L835) | ✅ All three rules | Primary path — wall-clock 5-min boundary |
| `flushPending` partial bucket flush | [poller.js:1453](../../server/poller.js#L1453) | ✅ All three rules (v2.9.2 fix) | Shutdown path — was bypass before this audit |
| Replication writer (incoming peer rows) | [index.js:2790](../../server/index.js#L2790-L2820) | N/A (downstream, "REDUCTION blocked") | Cross-DB consistency rule |
| `daily_report` rebuild rollup | [index.js daily report logic](../../server/index.js) | Reads only | Consumes `energy_5min`, never writes |
| Forecast training data | [forecast_engine.py:3312](../../services/forecast_engine.py#L3312) | Reads only | Consumes via `_query_energy_5min_totals()` |

### 3.2 Reader side (consumers of `energy_5min.kwh_inc`)

| Reader | Location | Clamp-aware? | Behaviour after clamp |
|---|---|---|---|
| Analytics chart (Actual MWh line) | [index.js:15347](../../server/index.js#L15347) | ✅ Yes | Clamped slot renders as 0 (notch in curve) |
| Energy summary export `Total_MWh` | [exporter.js:1322](../../server/exporter.js#L1322) via `sumEnergy5minByInverterRange` | ✅ Yes | Clamped value reflected in scaled per-unit + day total |
| Energy summary export `Etotal_MWh` / `ParcE_MWh` | [exporter.js:1280](../../server/exporter.js#L1280) `_hwDeltasForUnitDay` | ❌ Independent | Reads HW counter directly — shows true energy for reconciliation |
| Forecast engine training data | [forecast_engine.py:3312](../../services/forecast_engine.py#L3312) | ✅ Yes | Trains on clamp-clean ground truth |
| Daily report rollup | [index.js daily logic](../../server/index.js) | ✅ Yes | Daily totals reflect clamped values; legacy rows need `DELETE FROM daily_report WHERE date=...` after manual cleanup |
| Today MWh top-bar chip | `pacTodayByInverter` accumulator (clamp-aware via Rule 1) | ✅ Yes | Reflects per-frame-clamped running total |
| Replication push to remote | [index.js replication logic](../../server/index.js) | ✅ Yes | Pushes clamped (lower) values; remote's `REDUCTION blocked` rule means manual cleanup needed on remote DB too |

### 3.3 State management

| State | Scope | Reset on | Ring buffer cap |
|---|---|---|---|
| `pacIntegratorState[key]` | per (inverter, unit) | day rollover ([poller.js:251](../../server/poller.js#L251)), Node restart | n/a |
| `pacTodayByInverter[inv]` | per inverter | day rollover, Node restart | n/a |
| `energyBuckets[inv]` | per inverter | day rollover (lazy on first bucket of new day) | n/a |
| `recentBucketIncByInv[inv]` | per inverter | day rollover (lazy via `resetRecentBucketIncForInverter`), Node restart | 12 entries (= 1 hour) |
| `pollStats.recoverySeedClip*` | global | Node restart | n/a |
| `pollStats.bucketSpikeClip*` | global | Node restart | n/a |

Total in-memory cost: 12 floats × 27 inverters = **2.6 KB** for the contextual ring buffer state.

---

## 4. Audit-log forensics

Two action codes distinguish trip causes:

```sql
-- All clamp activity in the last 30 days
SELECT action, COUNT(*) AS trips,
       SUM(CASE WHEN reason LIKE '%physical_ceiling%' THEN 1 ELSE 0 END) AS physical,
       SUM(CASE WHEN reason LIKE '%gap_backfill%' THEN 1 ELSE 0 END) AS gap,
       SUM(CASE WHEN reason LIKE '%recovery_seed%' THEN 1 ELSE 0 END) AS frame
  FROM audit_log
 WHERE action IN ('recovery_seed_clip','bucket_spike_clip')
   AND ts > strftime('%s','now','-30 days') * 1000
 GROUP BY action;
```

Each row's `reason` field includes:
- For `recovery_seed_clip`: prev/new pythonKwh, dt, ceiling.
- For `bucket_spike_clip`: rawInc, ceiling, unitsCount, ratedKw, gapMinutes (when gap_backfill).

---

## 5. Failure-mode → protection coverage

Verifies each documented failure mode has at least one clamp catching it.

| Failure mode | Caught by | Stage |
|---|---|---|
| Python restart with stale baseline → multi-MWh seed jump | Rule 1 (per-frame) | First post-restart frame |
| Cold dawn boot with broken eod_clean snapshot | Rule 1 (per-frame, dt-aware) | Earliest frame |
| Modbus chain reconnect after 30+ min | Rule 1 (frame ceiling at long dt accommodates legit progression; if delta still > ceiling, drops) | Reconnect frame |
| Modbus chain reconnect after 5–15 min | Rule 1 may pass; Rule 2 (physical ceiling) catches at bucket level | Bucket boundary after reconnect |
| Subtle catch-up < 100 kWh after long Node stall | Rule 3 (contextual gap, post-warm-up) | Bucket boundary after gap |
| Per-frame clamp itself bug or future regression | Rule 2 + Rule 3 in update5minBucket and partial flush | Defense-in-depth |
| Spike during partial bucket flush at shutdown | Rules 2 + 3 in partial flush (v2.9.2 fix) | Shutdown |
| Day-rollover edge case | `resetPacTodayIfNeeded` clears integrator + lazy ring-buffer reset | Midnight |
| Cold-boot mid-day false positive | Warm-up gate (Rule 3 dormant for 1 hour) | First hour after boot |
| 4-unit inverter ceiling too lenient for 2-unit inverters | Per-inverter unit-count scaling (50 kWh ceiling for 2-unit) | Bucket level |

**Failure modes deliberately NOT addressed** (acceptable risk):
- Pre-v2.9.2 historical spike rows in `energy_5min`: must be cleaned manually via SQL UPDATE on each DB (gateway, remote, archives, rotating backups). Documented in [memory/v292_recovery_seed_clamp.md](../../../C%3A/Users/User/.claude/projects/d--ADSI-Dashboard/memory/v292_recovery_seed_clamp.md).
- Replication of clamped rows to peer with un-clamped existing data: `REDUCTION blocked` rule means the peer keeps its higher (potentially polluted) value; manual cleanup needed there too.

---

## 6. Test coverage

[server/tests/recoverySeedClamp.test.js](../../server/tests/recoverySeedClamp.test.js) — 28 scenarios covering:

| # | Scenario | Verdict |
|---|---|---|
| 1 | Physics ceiling math at canonical dt values | dt-aware computation correct |
| 2 | Canonical 1.86 MWh spike at 200 ms | trips frame clamp |
| 3 | Mid-day Python restart 1700 kWh jump | trips |
| 4 | Legitimate 60s Node event-loop stall | does NOT trip (false-positive guard) |
| 5–6 | Exact ceiling boundaries | uses `>`, not `>=` |
| 7 | Cold dawn boot second frame | small delta passes |
| 8–10 | Bucket clamp basics + cumulative scenario | correct |
| 11 | Operator's exact scenario: 70 kWh after 25-min gap | trips with `reason=gap_backfill` |
| 12 | Same gap but 5 kWh — could be legit ramp | passes |
| 13 | Dawn case (all preceding zeros, no production further back) | NOT a gap (handled correctly) |
| 14 | Sporadic 1-slot blips | not a gap |
| 15–16 | 3-zero vs 4-zero boundary | exactly at threshold |
| 17 | Physical ceiling beats contextual rule | reason=`physical_ceiling` wins |
| 18 | Backward compat (single-arg form) | works |
| 19 | Warm-up: short history disables contextual rule | only Rule 1 fires |
| 20 | Warm-up: exactly 12 entries activates | rule fires correctly |
| 21 | Warm-up: physical ceiling fires regardless | hard rule never gated |
| 22 | Warm-up: short history with no gap pattern | passes cleanly |
| 23 | 2-unit inverter has 50 kWh physical ceiling | trips at 60 kWh |
| 24 | 3-unit inverter has 75 kWh physical ceiling | trips at 80 kWh |
| 25 | 1-unit inverter has 25 kWh physical ceiling | trips at 30 kWh |
| 26 | 2-unit gap threshold ≈ 16.67 kWh | trips at 20 kWh post-gap |
| 27 | Defensive normalization (0/99/NaN → safe defaults) | handles edge cases |
| 28 | Default behaviour preserved (no `unitsCount` → 4 units) | backward compat |

[server/tests/energySummaryScaleCore.test.js](../../server/tests/energySummaryScaleCore.test.js) — 10 scenarios covering the export's per-inverter scaling math, including the pre-v2.9.2 inflation sentinel that fails loudly if anyone disables the upstream clamp.

---

## 7. Files touched (v2.9.2)

```
server/poller.js                            ← clamp wiring + per-inverter unit count + ring buffer + partial-flush fix
server/pollerClampCore.js                   ← NEW: pure clamp helpers (no native deps)
server/db.js                                ← insertAuditLogRow helper
server/exporter.js                          ← refactored to call applyInverterScale
server/energySummaryScaleCore.js            ← NEW: pure export scaling helpers
server/tests/recoverySeedClamp.test.js      ← NEW: 28 scenarios
server/tests/energySummaryScaleCore.test.js ← NEW: 10 scenarios
package.json                                ← 2.9.1 → 2.9.2
```

---

## 8. Operator playbook

### Forward (after gateway upgrades to v2.9.2)
- Spikes are blocked at write time. No action needed.
- Audit-log query for clamp activity:
  ```sql
  SELECT * FROM audit_log
   WHERE action IN ('recovery_seed_clip','bucket_spike_clip')
     AND ts > strftime('%s','now','-7 days') * 1000
   ORDER BY ts DESC;
  ```

### Backward (cleanup of pre-v2.9.2 spike rows)

Per-DB cleanup required (replication won't propagate downward corrections). For each DB at:
- `C:\ProgramData\InverterDashboard\db\adsi.db` (live)
- `C:\ProgramData\InverterDashboard\db\backups\adsi_backup_0.db`
- `C:\ProgramData\InverterDashboard\db\backups\adsi_backup_1.db`
- `C:\ProgramData\InverterDashboard\archive\<YYYY-MM>.db` (if spike date has aged out)

```sql
-- 1. Backup before edits
-- 2. Open DB with sqlite3.exe (safe with WAL mode while dashboard is running)
-- 3. Inspect:
SELECT id, datetime(ts/1000,'unixepoch','localtime') AS t, inverter, kwh_inc
  FROM energy_5min WHERE kwh_inc > 100 ORDER BY kwh_inc DESC;

-- 4. Clean (drop the per-inverter-aware threshold for safety, use 100 as the
--    physical max possible — any legitimate slot is below this):
UPDATE energy_5min SET kwh_inc = 0 WHERE kwh_inc > 100;

-- 5. Force daily report re-roll for affected dates:
DELETE FROM daily_report WHERE date IN ('2026-04-26', /* ... */);

-- 6. Audit trail:
INSERT INTO audit_log (ts, operator, inverter, node, action, scope, result, ip, reason)
VALUES (strftime('%s','now')*1000, 'OPERATOR', 0, 0, 'manual_spike_cleanup',
        'plant', 'ok', '', 'Pre-v2.9.2 spike cleanup');
```

---

## 9. Verification commands

Run these on the gateway after deploy to confirm protection is live:

```bash
# Syntax
node --check server/poller.js
node --check server/pollerClampCore.js
node --check server/exporter.js
node --check server/energySummaryScaleCore.js

# Tests (no native binding needed — pure logic)
node server/tests/recoverySeedClamp.test.js
node server/tests/energySummaryScaleCore.test.js
node server/tests/currentDayEnergyCore.test.js
node server/tests/counterHealth.test.js
```

All four must report PASS.

---

## 10. Open items (non-blocking for v2.9.2 release)

- **DB-bootstrap ring buffer on Node start**: would shorten the warm-up window after planned restarts. Not implemented — adds DB-load complexity for a benefit that's only meaningful during mid-day restarts (rare). Tracked as a future enhancement.
- **Plant-cap controller interaction**: `server/plantCapController.js` may emit dispatch commands that affect inverter output. Not currently believed to interact with the clamp (the clamp protects against accumulation anomalies, not legit cap-induced output changes), but worth re-verifying after the next plant-cap event.
- **2-week telemetry check**: in ~2 weeks, query `audit_log` for `recovery_seed_clip` / `bucket_spike_clip` row counts to see if the clamps are firing in production. Frequent firing means the underlying Python-restart issue still happens and warrants a deeper fix to that.
