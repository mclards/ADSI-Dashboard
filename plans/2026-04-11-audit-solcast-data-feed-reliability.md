# Solcast Data Feed Reliability Audit (v2.8)

**Date:** 2026-04-11
**Status:** OPEN — findings logged, fixes tracked per section (R1-R6)
**Audit type:** Read-only — no code changed.
**Scope:** Full Solcast data path from API ingestion → DB storage → Python read → ML/forecast consumption.
**Goal:** Identify reliability gaps, silent-degradation paths, and inconsistencies.
**Operator context:** Solcast Toolkit is configured for the plant's actual configuration and is the **trusted primary** data source. Dashboard's own config (Open-Meteo, physics, plant config) is the **fallback**.

---

## Executive summary

The Solcast data feed has **3 reliability gaps** that under-utilize a trusted source, **2 silent-degradation paths** that lose data without alerting the operator, and **1 architectural inconsistency** that makes future tuning error-prone.

| # | Finding | Severity | Effort to fix |
|---|---|---|---|
| **R1** | Mid-afternoon Solcast auto-downgraded to "stale_usable" because cron only fetches 7×/day with 8.5h max gap | **High** — under-utilizes operator-trusted source | Low (add 2 cron entries) |
| **R2** | `solcast_snapshots` upsert force-overwrites `forecast_mw/lo/hi` without COALESCE — late-day fetch can erase morning data | **High** — silent data loss | Low (one SQL change) |
| **R3** | P10/P90 silently fall back to P50 when Solcast doesn't provide them — tri-band clamp becomes a no-op with no signal | **Medium** — disables safety net silently | Low (add log + flag) |
| **R4** | Solcast Toolkit HTML scraping has zero retry, zero format-change detection | **Medium** — single point of failure | Medium (retry + structured parse check) |
| **R5** | Lock capture has no recovery if both 06:00 AND 09:55 miss (e.g., dashboard down 05:00–10:30) | **Medium** — day stays unlocked permanently | Low (catch-up cron at 11:00) |
| **R6** | Locked snapshot read in `solcast_prior_from_snapshot` doesn't validate snapshot age | **Low** — 6-day-old locked snapshot would still be used | Low (add age check) |
| **C1** | Coverage thresholds 0.95 and 0.80 are hardcoded throughout instead of named constants | **Low** — inconsistency risk on future tuning | Low (define constants) |
| **C2** | Age threshold (4h) doesn't match cron schedule (8.5h gap), causing automatic degradation operators can't see | **Low** — symptom of R1 | Low (depends on R1 fix) |

**No critical findings.** The pipeline is structurally sound — the data flows correctly when everything works. The gaps are about handling failure modes and exploiting the Solcast trust level the operator has confirmed.

---

## How the data flows (current state)

```
   ┌─────────────────────────────────────────────────────────┐
   │ NODE — Ingestion (server/index.js)                      │
   │                                                          │
   │ ┌─────────────┐       ┌─────────────────────────┐       │
   │ │ Cron 04:30  │──────▶│ autoFetchSolcastSnapshots│      │
   │ │ Cron 06:00  │       └────────┬─────────────────┘      │
   │ │ Cron 09:30  │                │                         │
   │ │ Cron 09:55  │                ▼                         │
   │ │ Cron 18:30  │       ┌──────────────────┐               │
   │ │ Cron 20:00  │       │ Solcast Toolkit  │               │
   │ │ Cron 22:00  │       │ HTML scrape      │               │
   │ │ (7×/day)    │       │ (4 sequential    │               │
   │ │             │       │  HTTP requests)  │               │
   │ └─────────────┘       └────────┬─────────┘               │
   │                                │                         │
   │                                ▼                         │
   │           ┌───────────────────────────────┐              │
   │           │ buildSolcastSnapshotRows      │              │
   │           │ - 144 slots per day           │              │
   │           │ - p10/p90 fallback to p50 ⚠   │              │
   │           └───────────────┬───────────────┘              │
   │                           │                              │
   │                           ▼                              │
   │           ┌───────────────────────────────┐              │
   │           │ persistSolcastSnapshot →      │              │
   │           │ bulkUpsertSolcastSnapshot     │              │
   │           │ ⚠ FORCE-overwrites forecast_* │              │
   │           │ ✓ COALESCE est_actual_*       │              │
   │           └───────────────┬───────────────┘              │
   │                           │                              │
   │            ┌──────────────┴──────────────┐               │
   │            ▼                              ▼              │
   │   ┌──────────────────┐         ┌──────────────────┐      │
   │   │ solcast_snapshots │         │ solcast_snapshot_│      │
   │   │ (overwrite)       │         │ history (append) │      │
   │   └──────────────────┘         └──────────────────┘      │
   │            │                                              │
   │            │     ┌────────────────────────┐               │
   │            │     │ Cron 06:00 + 09:55     │               │
   │            │     │ runDayAheadLockCapture │               │
   │            │     └────────────┬───────────┘               │
   │            │                  │                           │
   │            │                  ▼                           │
   │            │     ┌────────────────────────┐               │
   │            │     │ captureDayAheadSnapshot│               │
   │            │     │ ✓ INSERT OR IGNORE     │               │
   │            │     │   first-write-wins     │               │
   │            │     └────────────┬───────────┘               │
   │            │                  │                           │
   │            │                  ▼                           │
   │            │     ┌────────────────────────┐               │
   │            │     │ solcast_dayahead_locked│               │
   │            │     │ (immutable)            │               │
   │            │     └────────────────────────┘               │
   └────────────┼─────────────────┬─────────────────────────┘
                │                 │
   ┌────────────┼─────────────────┼─────────────────────────┐
   │ PYTHON — Read side          │                          │
   │            ▼                 ▼                          │
   │   ┌──────────────────────────────────────┐              │
   │   │ load_solcast_snapshot(day)           │              │
   │   │ - reads solcast_snapshots            │              │
   │   │ - backfills past-date forecast_kwh   │              │
   │   │   from est_actual_kwh                │              │
   │   │ - computes coverage_ratio            │              │
   │   └────────────────┬─────────────────────┘              │
   │                    │                                    │
   │                    ▼                                    │
   │   ┌──────────────────────────────────────┐              │
   │   │ solcast_prior_from_snapshot(...)     │              │
   │   │ - validates SOLCAST_MIN_USABLE_SLOTS │              │
   │   │ - applies bias_ratio                 │              │
   │   │ - reads solcast_dayahead_locked      │              │
   │   │   for spread_pct_cap features (v2.8) │              │
   │   └────────────────┬─────────────────────┘              │
   │                    │                                    │
   │                    ▼                                    │
   │   ┌──────────────────────────────────────┐              │
   │   │ run_dayahead                         │              │
   │   │ - baseline = Solcast P50             │              │
   │   │ - ml_residual + error_class_term     │              │
   │   │ - bias_correction = error_memory     │              │
   │   │ - tri-band clamp [P10, P90]          │              │
   │   └──────────────────────────────────────┘              │
   └─────────────────────────────────────────────────────────┘
```

**Two write paths to know about:**
1. **`solcast_snapshots`** — overwrite-on-pull. Latest state, gets erased and re-written on every fetch.
2. **`solcast_dayahead_locked`** — first-write-wins, immutable. Frozen at 06:00 / 09:55 — what you would have submitted to WESM FAS.

Both paths are read by different consumers; locked is the authoritative source for the learning loop.

---

## Detailed findings

### R1 — Mid-afternoon Solcast auto-downgraded to "stale_usable" 🔴 HIGH

**Where:** Cron schedule in [server/index.js:16289-16432](server/index.js) + freshness gate at [forecast_engine.py:9180-9201](services/forecast_engine.py).

**The math:**
- Cron fires at: 04:30, 06:00, 09:30, 09:55, 18:30, 20:00, 22:00
- Largest gap: **09:55 → 18:30 = 8 hours 35 minutes**
- Freshness rule: `if age_hours > 4.0: downgrade fresh → stale_usable`
- Therefore: **between ~13:55 and 18:30 every day**, every Solcast snapshot is automatically classified as stale_usable

**What this changes downstream:**
| Consumer | Fresh path | Stale_usable path |
|---|---|---|
| Per-slot Solcast floor | 95% of P50 | 88% of P50 |
| Regime damping (rainy) | `_bias_damp = 1 - 0.10 = 0.90` | `_bias_damp = 1 - 0.05 = 0.95` |
| Regime damping (overcast) | `_bias_damp = 0.70` | `_bias_damp = 0.80` |
| Regime damping (mixed) | `_bias_damp = 0.40` | `_bias_damp = 0.55` |
| Regime damping (clear) | `_bias_damp = 0.30` | `_bias_damp = 0.50` |
| `solcast_residual_damp_factor` | Higher damping | Lower damping (ML trusted more) |

**Translation in plain English:** Between 14:00 and 18:30 every day, the engine **trusts Solcast less and ML more** — the opposite of what the operator wants. Per the operator's own memory, intraday Solcast is highly trusted, more reliable than the dashboard's own ML correction.

**Why it happens:** The age threshold was tuned for a less aggressive fetch schedule. With 7 cron fires/day, the longest gap exceeds the 4h threshold by more than 2x.

**Recommended fix:**
- **Either** add 2 more cron fires (e.g., 12:30 and 15:30) to bring max gap below 4h
- **Or** raise the freshness age threshold from 4h to 9h to match the actual cron cadence
- **Or** make the threshold operator-configurable

**Effort:** Trivial — single constant or two cron lines.

---

### R2 — Force-overwrite of `forecast_mw/lo/hi` columns on upsert 🔴 HIGH

**Where:** [server/db.js:1313-1327](server/db.js) — `upsertSolcastSnapshot` prepared statement.

**The bug:**
```sql
ON CONFLICT(forecast_day, slot) DO UPDATE SET
  ...
  forecast_mw=excluded.forecast_mw,         -- ⚠ NO COALESCE
  forecast_lo_mw=excluded.forecast_lo_mw,   -- ⚠ NO COALESCE
  forecast_hi_mw=excluded.forecast_hi_mw,   -- ⚠ NO COALESCE
  est_actual_mw=COALESCE(excluded.est_actual_mw, solcast_snapshots.est_actual_mw),  -- ✓ preserved
  ...
```

The forecast columns are **force-overwritten** even when the new value is NULL. The `est_actual_*` columns correctly use COALESCE to preserve previous values, but forecasts don't.

**What can go wrong:**

Scenario: Today is the 11th. At 09:55, Solcast Toolkit successfully scrapes tomorrow's (12th) forecast — all 144 slots have forecast_mw filled in. At 18:30, Solcast Toolkit response is partial (e.g., HTML page truncated, network timeout mid-parse) and only 80 slots return forecast values for the 12th. The remaining 64 slots come back with `forecast_mw = null`.

**Result:** Those 64 slots' previously-good forecasts are **wiped to NULL**. The next time `load_solcast_snapshot` is called for the 12th, coverage drops from 1.0 to ~0.55 — silently. The operator has no warning that morning data was lost; the engine just sees lower coverage.

**Why this exists:** When Phase 4 made Solcast the primary baseline, the upsert was written assuming "newer is always better." That's true for est_actuals (intraday observations) but **wrong for day-ahead forecasts** — a partial later fetch is worse than a complete earlier fetch.

**Why locked snapshots help (but don't fix this):** v2.8's `solcast_dayahead_locked` was added to preserve the **decision-time** state. But:
- The locked snapshot only captures at 06:00 / 09:55
- The live `solcast_snapshots` table is what the engine reads for prediction (not the locked one)
- So forecast generation between 09:55 and the next pull still suffers from any data loss at 18:30

**Recommended fix:** Add COALESCE to the three forecast columns:
```sql
forecast_mw=COALESCE(excluded.forecast_mw, solcast_snapshots.forecast_mw),
forecast_lo_mw=COALESCE(excluded.forecast_lo_mw, solcast_snapshots.forecast_lo_mw),
forecast_hi_mw=COALESCE(excluded.forecast_hi_mw, solcast_snapshots.forecast_hi_mw),
```

**Effort:** One SQL change. Zero behavior change in the success path; only changes the partial-fetch failure path.

**Risk:** None I can see. Old data being preserved is strictly better than NULL in every consumer.

---

### R3 — Silent P10/P90 fallback to P50 disables tri-band clamp 🟡 MEDIUM

**Where:** [server/index.js:9192-9199](server/index.js) — `buildSolcastSnapshotRows`.

```javascript
const loMw = convertSolcastPowerToMw(
  rec?.pv_estimate10 ?? rec?.pv_estimate_10 ?? rec?.pv_estimate_low,
  accessMode,
) ?? mw;   // ⚠ falls back to mw if P10 absent

const hiMw = convertSolcastPowerToMw(
  rec?.pv_estimate90 ?? rec?.pv_estimate_90 ?? rec?.pv_estimate_high,
  accessMode,
) ?? mw;   // ⚠ falls back to mw if P90 absent
```

**What happens when Solcast Toolkit doesn't return P10/P90:**
1. `loMw = mw`, `hiMw = mw` — zero spread
2. Stored as: `forecast_lo_mw == forecast_mw == forecast_hi_mw`
3. `spread_frac` = 0 in `solcast_prior_from_snapshot`
4. `solcast_dayahead_locked.spread_pct_cap` = 0 in the next lock capture
5. `_spread_weight(spread_pct_cap=0, ...)` returns the **maximum** weight (1.0) — narrow-spread heavy weighting
6. Tri-band hard clamp at the end of `run_dayahead` becomes a **no-op** because P10 == P90 == forecast → no slot can be "below P10" or "above P90"

**Why this is bad:** The whole tri-band safety net (your "physics shape must stay within P10/P90" rule) is silently disabled. The operator has no signal that the safety net is off.

**Why it might happen:** Solcast Toolkit's HTML may not always include P10/P90 — it depends on plan tier and the specific page format. The current code handles missing data permissively (better some forecast than no forecast) but loses the safety guarantee.

**Recommended fix:**
1. **Distinguish** "P10/P90 absent" from "P10 == P50 == P90 by design" — set them to NULL when absent, not equal to P50
2. **Log** a warning when P10/P90 are absent: `log.warn("Solcast snapshot for ${day} has no P10/P90 — tri-band clamp will be disabled")`
3. **Add a meta field** `has_triband: bool` so downstream consumers can detect this and either skip the clamp or use alternative bounds

The current code at [forecast_engine.py:2418-2419](services/forecast_engine.py) already has a `has_triband` flag in `solcast_prior_from_snapshot`, but it's set based on whether `prior_lo < prior_kwh - 0.01 OR prior_hi > prior_kwh + 0.01` — which silently passes when the fallback equates them all.

**Effort:** Small. Two changes: (1) change the `?? mw` fallback to `?? null`, (2) add log warning when null, (3) update consumers to handle null lo/hi as "no triband."

**Risk:** Higher than R2 — this changes the meaning of stored data. Need to verify all consumers handle null lo/hi correctly. Worth doing carefully.

---

### R4 — Solcast Toolkit HTML scraping has zero retry, zero format-change detection 🟡 MEDIUM

**Where:** [server/index.js:8505-8590](server/index.js) — `fetchSolcastToolkitForecastRecords`.

**The fragility chain:**
1. Landing page fetch (HTTP) — single attempt
2. Auth POST (HTTP) — single attempt
3. Authenticated page fetch (HTTP) — single attempt
4. HTML parse via `parseSolcastToolkitHtml` — single attempt
5. Records normalize — throws if zero records

**What can fail:**

| Failure | Detection | Recovery |
|---|---|---|
| Network timeout on landing | HTTP error → throw | None |
| Auth fail (wrong creds, expired session) | HTTP 4xx → throw with detail | None |
| Auth succeeds but cookies don't propagate | Page fetch returns login page HTML | None — parse will return zero records |
| Page fetch rate-limited | HTTP 429 → throw | None |
| HTML format changed (Solcast UI redesign) | Parse returns zero/malformed records | None — `if (!records.length) throw` |
| Partial HTML (truncated response) | Parse returns some but not all records | **None — silent partial coverage** |

**No retry. No exponential backoff. No format-change health check.**

The whole `fetchSolcastForecastRecords` is wrapped in `autoFetchSolcastSnapshots`'s try/catch, which:
- Logs `console.warn("[forecast] Solcast auto-pull failed (will use cached/physics fallback)")`
- Returns `{pulled: false}` to caller
- Caller continues with whatever's already in `solcast_snapshots`

**Why this matters:** Per the operator, Solcast is the **primary trusted source**. If Solcast fails for a day and we're running on cached data + physics fallback, the operator should know immediately, not discover it after a degraded forecast lands in WESM FAS.

**Recommended fix:**
1. **Retry with exponential backoff** at the fetch layer: 3 attempts at 0s, 30s, 90s
2. **Health check field** in `autoFetchSolcastSnapshots` return: `{ pulled, healthCheckPassed: bool, formatVersionDetected: string }`
3. **Surface the failure** in the dashboard UI as a non-blocking alert: "Solcast Toolkit fetch failed at HH:MM, using cached data"
4. **Sentinel test** that runs once a day to verify the parser still works against a known-good payload (could be a saved HTML fixture)

**Effort:** Medium. Retry logic is small. UI surfacing requires touching a few files. The health check sentinel is the biggest piece.

**Risk:** None to current behavior — all additions, no removals.

---

### R5 — Lock capture has no recovery if both 06:00 AND 09:55 miss 🟡 MEDIUM

**Where:** [server/index.js:16429-16432](server/index.js).

```javascript
cron.schedule("0 6 * * *", () => runDayAheadLockCapture("0 6 * * *", "scheduled_0600"));
cron.schedule("55 9 * * *", () => runDayAheadLockCapture("55 9 * * *", "scheduled_0955"));
```

**Failure scenario:** Dashboard crashed at 03:00 on day D. Restarted at 10:30. Both crons missed. Day D+1 has zero locked snapshot rows.

**Impact:**
- The day-ahead state for D+1 will never be captured (the lock is meant to be the 10 AM submission state)
- `solcast_dayahead_locked` stays empty for D+1
- `_spread_weight` reads will return 1.0 (no weighting) for that day's slots in error_memory
- The active learning loop can't measure how the forecast differed from the day-ahead lock for D+1
- WESM FAS submission proof is lost

**Why this matters:** The whole point of locked snapshots is that they survive `solcast_snapshots` overwrites. A missed lock means the day-ahead state for that day is **gone forever** — the next Solcast pull will overwrite it.

**Recommended fix:**
1. **Add a catch-up cron at 11:00** (after WESM deadline, but still recoverable for learning) that locks tomorrow if not already locked
2. **Add a startup hook** in `server/index.js` initialization that checks "is tomorrow's lock missing?" and runs a delayed capture if so (with a 2-minute startup grace)
3. **Add an alarm** if the day's lock is missing past 10:30 — surfaced in UI

**Effort:** Low. The infrastructure (`captureDayAheadSnapshot`, `countDayAheadLockedForDay`) already exists. Just needs scheduling.

**Risk:** None — `INSERT OR IGNORE` ensures multiple lock attempts are idempotent.

---

### R6 — Locked snapshot read doesn't validate snapshot age 🟢 LOW

**Where:** [forecast_engine.py:4866-4898](services/forecast_engine.py) — the v2.8 patch I added.

```python
with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as _conn:
    _conn.execute("PRAGMA query_only = ON")
    _rows = _conn.execute(
        "SELECT slot, spread_pct_cap, captured_ts "
        "FROM solcast_dayahead_locked WHERE forecast_day = ?",
        (day,),
    ).fetchall()
    if _rows:
        # ... loads spread + captured_ts unconditionally
```

**The gap:** No age check. If `solcast_dayahead_locked` somehow has rows for a day that are 6 days old (e.g., backfilled with stale capture_ts), they'll still feed `spread_pct_cap_locked` and `hours_since_lock` features.

**Realistic failure mode:** Backfill scripts can write rows with arbitrary `captured_ts`. The current backfill (`scripts/backfill_dayahead_locked.py`) uses the source DB's mtime, which can be weeks old. The `_spread_weight` function applies a 0.3x discount for `capture_reason='backfill_approx'`, so backfill rows ARE downweighted — but for the ML feature `hours_since_lock`, the discount doesn't apply; the feature value is just `current_time - captured_ts` which can be huge.

**Impact:** Small — the `hours_since_lock` feature is clipped to [0, 48] hours so it can't blow up. But it's still a stale signal feeding a fresh model.

**Recommended fix:**
- Add: if all rows for the day have `capture_reason = 'backfill_approx'`, set `has_locked_snapshot = False` so the model uses the zero-fallback for the locked features
- This ensures backfill data only feeds the error_memory pipeline (where it's properly weighted), not the ML feature pipeline

**Effort:** Trivial.

**Risk:** None — only changes behavior for backfill-only days.

---

### C1 — Coverage thresholds 0.95 / 0.80 hardcoded throughout 🟢 LOW

**Where:** ~15 callsites in `forecast_engine.py` use literal `0.95` and `0.80` for coverage gating instead of named constants.

**Examples:**
```python
# Different files, same threshold:
if _sc_cov >= 0.95: ...                                        # line 9903
elif _sc_cov >= 0.80: ...                                      # line 9905
freshness_class = "fresh" if coverage >= 0.95 else (...)      # line 9186
if coverage >= 0.95 and mean_blend >= 0.5: ...                 # line 9175
if _sc_cov_final >= 0.80: ...                                  # tri-band clamp
```

**Why it matters:** If you ever want to change the freshness threshold (e.g., as part of fixing R1), you have to grep for both literals and update each callsite consistently. Easy to miss one and create silent inconsistency.

**Recommended fix:**
```python
SOLCAST_COVERAGE_FRESH_THRESHOLD = 0.95
SOLCAST_COVERAGE_USABLE_THRESHOLD = 0.80
```
And replace all 15 literal callsites.

**Effort:** Low — straightforward grep+replace.

**Risk:** None — pure refactor, behavior unchanged.

---

### C2 — Age threshold doesn't match cron cadence 🟢 LOW

**Same root cause as R1.** The 4-hour age threshold and the 8.5-hour cron gap don't agree. Fixing R1 (either side) eliminates this.

---

## What's working correctly (don't touch)

To balance the findings list, here's what the audit confirmed is working as designed:

### ✅ Past-date est_actual backfill in `load_solcast_snapshot`
[forecast_engine.py:3876-3910](services/forecast_engine.py) — when reading a past day, sparse `forecast_kwh` slots are backfilled from `est_actual_kwh`. This is correct: for training data, observed actuals are at least as informative as the original forecast. Logged with slot count. Good.

### ✅ Locked snapshot capture: first-write-wins
[server/dayAheadLock.js](server/dayAheadLock.js) `captureDayAheadSnapshot` correctly checks `countDayAheadLockedForDay > 0` before writing, and uses `INSERT OR IGNORE` at the SQL layer as a second safety net. Idempotent.

### ✅ Snapshot history append is non-fatal
[server/index.js:10141-10173](server/index.js) — wrapped in its own try/catch, doesn't fail the main fetch if it fails. Correct prioritization.

### ✅ `est_actual_*` columns use COALESCE on upsert
[server/db.js:1320-1324](server/db.js) — preserves previous est_actuals when new fetch returns null. Correct.

### ✅ `_dayAheadLockRunning` mutex prevents overlap
[server/index.js:16373-16380](server/index.js) — guards against concurrent lock capture if the previous run hasn't finished. Correct.

### ✅ Lock capture pre-fetches Solcast before locking
[server/index.js:16383-16395](server/index.js) — `autoFetchSolcastSnapshots([tomorrow])` runs INSIDE the lock cron before `captureDayAheadSnapshot`. Ensures the lock captures the freshest available data. The "continue anyway on fetch fail" comment is correct policy: a stale lock is better than no lock.

### ✅ Lazy backfill cooldown (5 min) prevents fetch hammering
[server/index.js:228-229](server/index.js) — `SOLCAST_LAZY_BACKFILL_COOLDOWN_MS = 5 * 60 * 1000`. Per-date cooldown map prevents repeated retries on the same failed day.

### ✅ SQLite WAL + retry on `_open_sqlite`
[forecast_engine.py:3818](services/forecast_engine.py) — `for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1)` with `_is_retryable_sqlite_error` filter. Handles transient lock contention correctly.

### ✅ `solcast_dayahead_locked` schema has the right indexes
PK on `(forecast_day, slot)` + indexes on `captured_ts` and `capture_reason`. Supports all current query patterns efficiently.

### ✅ `solcast_snapshot_history` schema is well-indexed
3 indexes covering the typical query shapes (day+captured, day+slot, captured alone). Append-only with 90-day retention via prune cron at 03:35.

---

## Suggested fix priority order

If you want to act on findings in the order of risk-adjusted impact:

### Phase 1: Stop silent data loss (do this first)
1. **R2** — Add COALESCE to the upsert. **Effort: 5 minutes. Risk: zero. Impact: prevents partial-fetch data loss.**
2. **R3** — Distinguish "P10/P90 absent" from "P10 = P50 = P90". **Effort: 30 min. Risk: low (need to check consumers). Impact: tri-band safety net stays armed.**

### Phase 2: Recover from cron misses
3. **R5** — Add 11:00 catch-up lock cron + startup hook. **Effort: 15 minutes. Risk: zero. Impact: locked snapshots survive dashboard outages.**
4. **R6** — Add backfill-only day check in `solcast_prior_from_snapshot`. **Effort: 5 minutes. Risk: zero. Impact: clean ML signal.**

### Phase 3: Better utilize the trusted source
5. **R1** — Either add 12:30 + 15:30 cron fires OR raise age threshold to 9h. **Effort: 5 minutes. Risk: low. Impact: stops auto-downgrading mid-afternoon Solcast.**

### Phase 4: Failure resilience
6. **R4** — Add fetch retry + dashboard health surfacing. **Effort: 1-2 hours. Risk: zero (additions only). Impact: operator visibility into Solcast failures.**

### Phase 5: Maintenance cleanup
7. **C1** — Replace 15 literal thresholds with named constants. **Effort: 15 minutes. Risk: zero. Impact: future-proof tuning.**
8. **C2** — Resolved by R1 fix.

---

## What I did NOT audit (out of scope for Option 1)

These are deferred to Options 2, 3, 4 in the original menu:

- **Option 2 (Efficiency)**: redundant snapshot reads, N+1 queries, weather fetch redundancy, build_features overhead
- **Option 3 (ML error correction reliability)**: locked-snapshot integration in compute_error_memory, capture_reason consistency, per-regime data sufficiency, training data freshness, QA → error_memory feedback loop
- **Option 4 (Cross-cutting DB patterns)**: SQLite connection counts per forecast cycle, snapshot isolation consistency, transaction boundaries

I touched these only enough to confirm they didn't have data feed reliability bugs. Option 3 in particular probably has interesting findings — the locked snapshot pipeline only just shipped.

---

## Summary in one paragraph

The Solcast data feed is **structurally sound but operationally under-tuned**. There are no critical bugs and no data integrity violations in the success path. The 3 high/medium findings (R1, R2, R3) are all about silent failure modes that under-utilize a trusted source: the upsert can erase morning data on a partial late-day fetch, the P10/P90 fallback silently disables your tri-band safety net, and the age threshold + cron schedule auto-downgrade Solcast in the afternoon when the operator wants it trusted most. The 3 medium-severity findings (R4, R5, R6) are about recoverability from failures. None of the fixes require architectural changes — most are 5-30 minute edits. **Recommended action: ship R2 first (one SQL change, zero risk, prevents data loss), then R5 + R1 in sequence.**
