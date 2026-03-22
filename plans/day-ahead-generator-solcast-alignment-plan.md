# Day-Ahead Generator Review and Structured Plan

## Review Date

2026-03-20

## Problem Summary

Observed case for target date `2026-03-21`:

- Manual generation reported: `Generated 1 day(s) from 2026-03-21 to 2026-03-21 via Solcast`
- Automatic next-day forecast total was approximately `89.xx MWh`
- Solcast next-day total was `116.908 MWh`

This variance is too large for a path that is expected to stay aligned with a trusted Solcast day-ahead signal, especially when Solcast has recently been closer to actual than the automatic result.

## Code Paths Reviewed

- Manual generate route in `server/index.js`
- Auto Solcast snapshot pull in `server/index.js`
- Direct Solcast generation path in `server/index.js`
- Automatic Python scheduler in `services/forecast_engine.py`
- Solcast snapshot loading and hybrid blend in `services/forecast_engine.py`
- Error-memory correction path in `services/forecast_engine.py`
- Node fallback cron in `server/index.js`

## Review Findings

### 1. Automatic generation does not honor the same provider-routing logic as manual generation

Manual generation uses the configured provider order:

- `server/index.js` reads `forecastProvider`
- manual `/api/forecast/generate` can choose `solcast` directly
- manual ML generation can also pre-pull Solcast snapshots before calling Python

Automatic generation does not do that:

- `services/forecast_engine.py` scheduled loop directly calls `train_model(today)` and `run_dayahead(target, today)`
- there is no corresponding read of `forecastProvider`
- there is no direct scheduled path that writes `forecast_dayahead` from the pure Solcast provider

Impact:

- if the operator expects Solcast to be the active source, the manual button can produce a Solcast result while the automatic scheduler still produces ML/hybrid output
- manual and automatic generation are not functionally equivalent today

### 2. Manual ML generation refreshes Solcast snapshots before forecasting, but the automatic scheduler does not

Manual ML path:

- `generateDayAheadWithMl(...)` in `server/index.js` calls `autoFetchSolcastSnapshots(dates)`
- only after that does it run Python with `--generate-days`

Automatic scheduled path:

- `services/forecast_engine.py` loads `load_solcast_snapshot(target_s)`
- but it never fetches a fresh snapshot before scheduled generation

Impact:

- the scheduled run can use stale Solcast data
- the scheduled run can use no Solcast data at all and silently fall back toward physics-only or weaker hybrid behavior
- this is the most likely primary reason for the large gap between the automatic total and the manual Solcast total

### 3. The fallback cron only checks completeness, not provider parity or snapshot freshness

`server/index.js` fallback cron at `18:30`, `20:00`, and `22:00` only regenerates when tomorrow is missing or incomplete.

It does not regenerate when:

- the rows exist but were written by the wrong provider
- the rows were written without a fresh Solcast snapshot
- the rows are complete but materially inconsistent with a newly available Solcast forecast

Impact:

- a low-quality automatic forecast can survive for the full day as long as the rowset is complete
- the fallback layer repairs missing data, not bad data

### 4. Forecast correction and QA are not provenance-aware enough

The schema already stores `forecast_dayahead.source`, but the main historical loader does not use it:

- `_load_dayahead_from_db(...)` reads only `slot, kwh_inc`
- `compute_error_memory(...)` learns from forecast-vs-actual history without separating:
  - pure Solcast days
  - fresh-snapshot hybrid ML days
  - stale-snapshot or no-snapshot auto days

Impact:

- the correction loop is active, but it is not source-aware
- low-quality automatic runs can pollute the same learning pool as higher-trust runs
- the current feedback loop cannot answer which generation path actually produced the historical error being learned

### 5. The ML pipeline intentionally damps itself when Solcast is active

Inside `services/forecast_engine.py`:

- `blend_physics_with_solcast(...)` blends physics with a Solcast prior
- `solcast_residual_damp_factor(...)` reduces ML residual authority when Solcast authority is high
- clear-sky slots get additional Solcast preference

Impact:

- once a fresh Solcast snapshot is present, the ML path is intentionally conservative about overriding Solcast
- this is reasonable design
- but it also means the quality of the Solcast snapshot and the timing of the snapshot pull matter even more

### 6. The hybrid baseline still constrains Solcast against the physics total

`blend_physics_with_solcast(...)` rescales the Solcast day total relative to the physics baseline using `SOLCAST_PRIOR_TOTAL_RATIO_CLIP = (0.65, 1.70)`.

For the reported example:

- `116.908 / 89.xx` is still inside that clip range
- so the ratio clip is probably not the immediate blocker in this specific case

But:

- the final ML/hybrid result can still remain below the direct Solcast total depending on blend weight, snapshot availability, reliability score, and residual damping

## Working Root-Cause Hypothesis

Primary issue:

- the automatic scheduler is not using the same provider-aware and fresh-snapshot-aware generation path that the manual route uses

Secondary issue:

- the historical error-correction loop is mixing forecast runs of different quality and provenance, so it cannot cleanly learn from the better Solcast-aligned days

## Recommended Direction

Use one provider-aware orchestration path for both manual and automatic day-ahead generation.

Recommended behavior:

- if `forecastProvider=solcast`, both manual and automatic generation should write the direct Solcast day-ahead path
- if `forecastProvider=ml_local`, both manual and automatic generation should first refresh Solcast snapshots when Solcast is configured, then run the ML/hybrid forecast
- no scheduled day-ahead run should proceed with unknown Solcast freshness when Solcast is configured and expected to influence the result

## Structured Plan

### Phase 1. Restore manual-vs-automatic parity

Objective:

- make the automatic scheduler use the same provider decision and Solcast-input preparation as the manual route

Tasks:

- extract a shared provider-aware day-ahead orchestration path instead of keeping separate manual and automatic logic
- ensure scheduled generation reads the active `forecastProvider`
- if provider is `solcast`, scheduled generation must use the direct Solcast writer
- if provider is `ml_local`, scheduled generation must refresh Solcast snapshots before running Python ML
- keep Node as the only Solcast fetch/login client

Files expected to change:

- `server/index.js`
- `services/forecast_engine.py`

Acceptance criteria:

- manual and automatic generation choose the same provider for the same settings
- manual and automatic generation use the same Solcast snapshot freshness policy
- the auto path can no longer silently diverge into ML-only behavior when Solcast is configured and expected

### Phase 1A. Detailed execution design for provider parity

Recommended architecture decision:

- Node should be the orchestration owner for provider routing and Solcast fetch decisions
- Python should remain the ML forecast engine and training engine
- direct Solcast generation should not be reimplemented inside Python

Reason:

- Node already owns:
  - settings access for `forecastProvider`
  - Solcast credentials
  - toolkit/API fetch logic
  - direct Solcast write logic
- Python already owns:
  - training
  - hybrid inference
  - QA
  - error correction

The clean boundary is:

- Node decides what generation path should run
- Python executes only the ML/hybrid path when requested

#### A. Current vs target flow

Current manual flow:

- UI calls `/api/forecast/generate`
- Node checks provider order
- Node may:
  - run direct Solcast generation
  - or pull Solcast snapshots then spawn Python

Current automatic flow:

- Python service loop decides target date
- Python service loop directly trains and generates
- no shared provider router is used

Target automatic flow:

- scheduler determines the target date and trigger reason
- scheduler hands off to one shared orchestration path
- shared orchestration path decides:
  - direct Solcast
  - ML with fresh Solcast snapshot
  - ML fallback only if explicitly allowed

#### B. Recommended shared orchestration surface

Recommended new orchestrator contract:

- one internal function in `server/index.js` such as:
  - `runDayAheadGenerationPlan({ dates, trigger, allowMlFallback, forceFreshSolcast, expectedProvider })`

Suggested inputs:

- `dates`
- `trigger`
  - `manual_api`
  - `auto_service`
  - `node_fallback`
- `allowMlFallback`
- `forceFreshSolcast`
- `expectedProvider`
- `replaceExisting`

Suggested outputs:

- `provider_expected`
- `provider_used`
- `forecast_variant`
- `solcast_pull`
- `run_audit_id`
- `written_rows`
- `target_dates`
- `warnings`

#### C. How the Python scheduler should be realigned

Recommended short-term design:

- keep the Python scheduler for timing and target-date resolution
- do not let it directly generate day-ahead rows
- instead, Python scheduler should delegate generation to the shared Node orchestrator

Recommended long-term design:

- move all scheduled day-ahead orchestration into Node
- leave Python responsible for:
  - training
  - run_dayahead ML execution
  - intraday-adjusted generation
  - QA/replay/backtest

Preferred immediate implementation:

- add a localhost-only internal route or helper callable from Python, for example:
  - `/api/internal/forecast/generate-auto`
- Python service loop resolves:
  - target date
  - trigger reason
  - whether this is scheduled, recovery, or post-solar repair
- Python then calls the internal Node route
- Node applies the same provider logic as manual generation

Reason this is safer than duplicating logic:

- only one place decides provider behavior
- only one place decides Solcast freshness policy
- only one place writes direct Solcast output

#### D. Detailed behavior rules

If `forecastProvider=solcast`:

- manual generate must call direct Solcast generation
- auto scheduled generate must call direct Solcast generation
- fallback repair must call direct Solcast generation
- if direct Solcast fails and fallback is permitted:
  - record failure
  - optionally fall back to ML only if explicitly configured
  - do not silently present the result as equivalent to direct Solcast

If `forecastProvider=ml_local` and Solcast is configured:

- manual generate must refresh snapshot first
- auto scheduled generate must refresh snapshot first
- fallback repair must refresh snapshot first
- Python ML run must receive data only after Node confirms snapshot freshness status

If `forecastProvider=ml_local` and Solcast is not configured:

- ML may proceed normally
- audit row must mark:
  - `forecast_variant='ml_without_solcast'`
  - `solcast_snapshot_coverage_ratio=0`

#### E. Snapshot freshness policy

Recommended first-pass freshness rule:

- `fresh` means:
  - snapshot exists for the exact target day
  - solar-window coverage ratio is at least `0.95`
  - snapshot was pulled within `2` hours before generation

Recommended fallback freshness rule:

- `stale but usable` means:
  - snapshot exists for the exact target day
  - coverage ratio is at least `0.80`
  - snapshot was pulled within `12` hours before generation

Recommended hard-fail cases when Solcast influence is expected:

- no target-day snapshot
- coverage ratio below `0.80`
- pulled timestamp missing

#### F. Replacement policy for existing rows

When a new run is more authoritative than an existing run:

- keep full audit history
- replace the active `forecast_dayahead` rowset
- mark the new run authoritative for learning
- mark the replaced run non-authoritative for learning

Authoritative order recommendation:

1. direct Solcast run when provider is `solcast`
2. ML run with fresh Solcast when provider is `ml_local`
3. ML run with stale Solcast only as temporary operational fallback
4. ML without Solcast only as emergency fallback

#### G. Detailed tests for Phase 1

Required tests:

- same settings produce same provider choice for manual and automatic generation
- Python auto trigger delegates to the shared Node orchestration path
- direct Solcast auto generation writes `source='solcast'`
- ML auto generation with Solcast configured refuses to proceed without freshness metadata unless emergency fallback is allowed
- replaced forecasts preserve audit history but only one run remains authoritative
- manual and automatic generation both emit the same forecast variant labels for the same scenario

### Phase 2. Add generation provenance and freshness auditing

Objective:

- make every generated forecast explainable after the fact

Tasks:

- persist per-run audit metadata for each target day:
  - provider used
  - snapshot pulled timestamp
  - snapshot coverage ratio
  - Solcast mean blend
  - weather source
  - raw Solcast total
  - applied hybrid total
  - final forecast total
- expose whether a day-ahead rowset was generated from:
  - pure Solcast
  - ML with fresh Solcast
  - ML with stale Solcast
  - ML without Solcast
- log the exact target date and freshness state during scheduled runs

Files expected to change:

- `server/db.js`
- `server/index.js`
- `services/forecast_engine.py`

Acceptance criteria:

- for any date, the team can explain why the forecast total landed where it did
- the system can distinguish bad automatic runs from valid Solcast-aligned runs

### Phase 2A. Detailed audit and freshness design

Objective:

- persist enough run metadata so every forecast can be reconstructed and judged later without guessing

#### A. Minimum audit questions the data must answer

For any target date, the stored audit must answer:

1. Who generated this rowset?
2. Why did it run?
3. Which provider was expected?
4. Which provider was actually used?
5. Was Solcast fetched fresh before the run?
6. If Solcast was not used, was that intentional or degraded fallback?
7. What were the daily totals for:
   - physics
   - raw Solcast
   - applied hybrid baseline
   - final forecast
8. Was the run later replaced by a better run?

#### B. Recommended audit states

Recommended lifecycle states for a run:

- `created`
- `writing_forecast`
- `written`
- `scored`
- `superseded`
- `failed`

Recommended authority states:

- `authoritative_runtime`
- `authoritative_learning`
- `non_authoritative`

These should not be inferred only from timestamps. Store them explicitly.

#### C. Freshness classification

Recommended stored classification field:

- `solcast_freshness_class`

Expected values:

- `fresh`
- `stale_usable`
- `stale_reject`
- `missing`
- `not_expected`

Reason:

- later QA and fallback logic should query a categorical decision, not recalculate policy from raw timestamps in multiple places

#### D. How audit rows should be written

Write timing:

- create audit row before the generation starts
- update it after forecast writing succeeds or fails

Pre-write fields:

- target dates
- trigger
- provider expected
- snapshot freshness state

Post-write fields:

- provider used
- totals
- warnings
- run status

If generation fails:

- keep the failed audit row
- store the failure message and stage
- do not silently discard the failed attempt

#### E. Recommended cross-links

Every `forecast_run_audit` row should be linkable to:

- the active `forecast_dayahead` rowset for that target date
- any comparison row created after actuals exist
- any later run that superseded it

Recommended link fields:

- `superseded_by_run_audit_id`
- `replaces_run_audit_id`

#### F. Operator-facing usefulness

Optional but recommended later:

- show the last auto-generated target day with:
  - provider used
  - snapshot freshness
  - final total
  - whether the run is authoritative

This is not required for Phase 1 correctness, but it makes support much easier.

#### G. Tests for Phase 2

Required tests:

- failed runs still create audit rows
- successful runs update audit rows with final totals
- superseding a run updates authority flags correctly
- freshness class is stored consistently for manual, auto, and fallback runs
- scoring rows reference the right `run_audit_id`

### Phase 3. Make fallback regeneration quality-aware, not only completeness-aware

Objective:

- stop preserving obviously low-quality forecasts just because the row count is complete

Tasks:

- extend the Node fallback check beyond `hasCompleteDayAheadRowsForDate(...)`
- regenerate when tomorrow exists but fails quality gates such as:
  - wrong provider for current settings
  - stale or missing Solcast snapshot when ML should have used Solcast
  - audit metadata missing
- optionally add a post-18:00 revalidation window after the first auto run so a newer Solcast pull can replace an earlier weaker forecast

Files expected to change:

- `server/index.js`

Acceptance criteria:

- a complete but low-confidence day-ahead can be replaced automatically
- the fallback layer protects forecast quality, not only forecast existence

### Phase 3A. Detailed fallback regeneration design

Objective:

- make fallback logic deterministic, safe, and quality-aware

#### A. Required distinction: missing vs weak vs wrong

The fallback system must classify tomorrow into one of these states:

- `missing`
  - no usable solar-window rowset
- `incomplete`
  - rowset exists but fewer than required slots
- `wrong_provider`
  - rowset exists but does not match current provider policy
- `stale_input`
  - rowset exists but Solcast freshness is below policy
- `weak_quality`
  - rowset exists, but audit metadata indicates degraded fallback path
- `healthy`
  - rowset exists and passes all policy checks

Only `healthy` should suppress regeneration.

#### B. First implementation rule set

Recommended hard regeneration triggers:

- tomorrow missing
- tomorrow incomplete
- tomorrow written by non-authoritative provider for current settings
- tomorrow generated from `ml_without_solcast` when Solcast was expected
- tomorrow generated from `ml_solcast_hybrid_stale` when a fresh pull is now available
- tomorrow missing audit metadata

Recommended soft alert only for first implementation:

- daily total differs from direct Solcast by more than a threshold

Do not auto-replace based only on total variance in the first pass unless the provider/freshness policy is already violated. Deterministic policy violations are safer than heuristic replacement.

#### C. Recommended time windows

Keep existing fallback times:

- `18:30`
- `20:00`
- `22:00`

Add one optional early-morning repair window for tomorrow if needed:

- `04:30`

Purpose:

- if a late-night process failed or a run was degraded, there is still one more repair chance before the next solar day begins

#### D. Concurrency rules

The fallback system must not race against:

- manual generate
- Python auto scheduler
- another fallback cycle

Required controls:

- one generation lock per target date
- one global forecast generation lock if per-target locking is not practical yet
- if a run is already in progress:
  - fallback cycle logs skip reason
  - does not start a second overlapping run

#### E. Replacement safety

When fallback replaces an existing forecast:

- old rows remain represented by audit history
- active `forecast_dayahead` table is overwritten only after the new run succeeds
- do not delete the current active rowset before the replacement run is ready

Recommended sequence:

1. generate candidate run
2. write audit row
3. if successful, replace active rowset in one transaction
4. mark old run superseded
5. mark new run authoritative

#### F. Quality gates to evaluate before skipping regeneration

Recommended pre-skip checklist:

1. target day exists
2. solar-window row count is complete
3. audit metadata exists
4. provider used matches expected provider
5. freshness class is acceptable
6. run status is `success`
7. run is marked `authoritative_runtime`

If any item fails:

- do not call the day healthy

#### G. Tests for Phase 3

Required tests:

- complete but wrong-provider day triggers regeneration
- complete but stale-input day triggers regeneration when fresh Solcast becomes available
- healthy authoritative day is skipped
- overlapping fallback cycles do not race
- failed replacement does not erase previously active forecast
- superseded runs remain queryable in audit history

### Phase 4. Make error correction and QA provenance-aware

Objective:

- prevent the learning loop from mixing strong and weak forecast histories without context

Tasks:

- extend historical QA so it compares actuals against forecast provenance groups
- update `compute_error_memory(...)` or add a new source-aware variant that can:
  - exclude stale/no-Solcast auto days
  - down-weight days generated from the wrong provider path
  - optionally maintain separate correction memory for Solcast-backed vs non-Solcast-backed runs
- use the existing `source` column and new audit metadata instead of treating all day-ahead rows as equivalent

Files expected to change:

- `services/forecast_engine.py`

Acceptance criteria:

- the correction layer learns from the right days
- QA can show whether Solcast-backed runs are actually outperforming the old auto path

### Phase 4A. Detailed design for saving comparison data used by error correction

Objective:

- persist a clean, queryable, replayable comparison history so error correction is based on explicit saved evidence instead of re-deriving mixed history ad hoc every time

Why this must exist:

- `compute_error_memory(...)` currently re-reads historical day-ahead and actual arrays but does not know enough about:
  - which generator path produced the forecast
  - whether the run used a fresh Solcast snapshot
  - whether the forecast was direct Solcast, ML+Solcast hybrid, or degraded ML
  - whether that day should be trusted for future correction learning
- if the comparison data is not saved explicitly, the correction layer keeps learning from an opaque mixture of good and bad runs

Design principle:

- save the comparison artifact once, after actuals for that target day are sufficiently complete
- make the saved artifact the source of truth for:
  - error memory
  - QA summaries
  - source-quality analysis
  - backtest/replay review
  - operator-side investigation when totals look wrong

#### A. What must be saved

Save two levels of comparison data:

- daily-level comparison rows
- slot-level comparison rows

The daily-level row is for filtering, ranking, and high-level QA.

The slot-level rows are for actual error correction learning.

Both are required. Daily-level data alone cannot build a 5-minute bias vector. Slot-level data alone is too expensive and too hard to filter without a daily summary row.

#### B. Proposed storage objects

Recommended new tables:

- `forecast_run_audit`
- `forecast_error_compare_daily`
- `forecast_error_compare_slot`

Recommended optional helper view:

- `forecast_error_compare_eligible_v`

Purpose of each object:

- `forecast_run_audit`
  - one row per forecast generation run per target day
  - stores provenance and run-time metadata
- `forecast_error_compare_daily`
  - one row per target day per forecast run variant after actual comparison is computed
  - stores summarized error metrics and eligibility flags
- `forecast_error_compare_slot`
  - one row per target day per slot per forecast run variant
  - stores aligned forecast, actual, error, masks, weather context, and correction eligibility

#### C. Detailed schema proposal

##### 1. `forecast_run_audit`

Suggested columns:

- `id INTEGER PRIMARY KEY`
- `target_date TEXT NOT NULL`
- `generated_ts INTEGER NOT NULL`
- `generator_mode TEXT NOT NULL`
  - expected values:
    - `auto_service`
    - `manual_api`
    - `node_fallback`
    - `backtest`
- `provider_used TEXT NOT NULL`
  - expected values:
    - `solcast`
    - `ml_local`
- `provider_expected TEXT`
  - expected active setting at runtime
- `forecast_variant TEXT NOT NULL`
  - expected values:
    - `solcast_direct`
    - `ml_solcast_hybrid_fresh`
    - `ml_solcast_hybrid_stale`
    - `ml_without_solcast`
    - `physics_only`
- `weather_source TEXT`
  - expected values:
    - `forecast`
    - `snapshot`
    - `snapshot-fallback`
    - `archive-fallback`
- `solcast_snapshot_day TEXT`
- `solcast_snapshot_pulled_ts INTEGER`
- `solcast_snapshot_age_sec INTEGER`
- `solcast_snapshot_coverage_ratio REAL`
- `solcast_snapshot_source TEXT`
- `solcast_mean_blend REAL`
- `solcast_reliability REAL`
- `solcast_primary_mode INTEGER NOT NULL DEFAULT 0`
- `solcast_raw_total_kwh REAL`
- `solcast_applied_total_kwh REAL`
- `physics_total_kwh REAL`
- `hybrid_total_kwh REAL`
- `final_forecast_total_kwh REAL`
- `ml_residual_total_kwh REAL`
- `error_class_total_kwh REAL`
- `bias_total_kwh REAL`
- `shape_skipped_for_solcast INTEGER NOT NULL DEFAULT 0`
- `run_status TEXT NOT NULL`
  - expected values:
    - `success`
    - `failed`
    - `partial`
- `notes_json TEXT`

Recommended uniqueness:

- unique on `(target_date, generated_ts, forecast_variant)`

Recommended index:

- index on `(target_date)`
- index on `(forecast_variant, generated_ts DESC)`

Why this table matters:

- it captures how the forecast was generated before actuals exist
- later comparison rows can reference it
- it becomes possible to compare multiple runs for the same target date instead of overwriting history conceptually

##### 2. `forecast_error_compare_daily`

Suggested columns:

- `id INTEGER PRIMARY KEY`
- `target_date TEXT NOT NULL`
- `run_audit_id INTEGER NOT NULL`
- `comparison_ts INTEGER NOT NULL`
- `actual_basis TEXT NOT NULL`
  - expected value:
    - `loss_adjusted_actual`
- `actual_total_kwh REAL NOT NULL`
- `forecast_total_kwh REAL NOT NULL`
- `solcast_total_kwh REAL`
- `daily_error_kwh REAL NOT NULL`
  - `actual_total_kwh - forecast_total_kwh`
- `daily_abs_error_kwh REAL NOT NULL`
- `daily_ape_pct REAL`
- `wape_pct REAL`
- `mape_pct REAL`
- `rmse_kwh REAL`
- `mbe_kwh REAL`
- `usable_slot_count INTEGER NOT NULL`
- `masked_slot_count INTEGER NOT NULL`
- `missing_actual_slot_count INTEGER NOT NULL`
- `missing_forecast_slot_count INTEGER NOT NULL`
- `manual_constraint_slot_count INTEGER NOT NULL`
- `cap_dispatch_slot_count INTEGER NOT NULL`
- `curtailed_slot_count INTEGER NOT NULL`
- `solcast_slot_count INTEGER NOT NULL`
- `fresh_solcast_used INTEGER NOT NULL DEFAULT 0`
- `comparison_quality TEXT NOT NULL`
  - expected values:
    - `eligible`
    - `review`
    - `reject`
- `eligibility_reason TEXT`
- `include_in_error_memory INTEGER NOT NULL DEFAULT 0`
- `include_in_source_scoring INTEGER NOT NULL DEFAULT 0`
- `include_in_qA INTEGER NOT NULL DEFAULT 1`
- `bucket_summary_json TEXT`
- `classifier_summary_json TEXT`
- `notes_json TEXT`

Recommended uniqueness:

- unique on `(target_date, run_audit_id)`

Recommended index:

- index on `(target_date DESC)`
- index on `(include_in_error_memory, target_date DESC)`
- index on `(comparison_quality, target_date DESC)`

Why this table matters:

- `compute_error_memory(...)` should not decide eligibility by re-deriving everything from scratch
- this row becomes the filter gate for whether a day can contribute to correction learning

##### 3. `forecast_error_compare_slot`

Suggested columns:

- `id INTEGER PRIMARY KEY`
- `target_date TEXT NOT NULL`
- `run_audit_id INTEGER NOT NULL`
- `daily_compare_id INTEGER NOT NULL`
- `slot INTEGER NOT NULL`
- `ts_local INTEGER NOT NULL`
- `time_hms TEXT NOT NULL`
- `forecast_kwh REAL NOT NULL`
- `actual_kwh REAL`
- `solcast_kwh REAL`
- `physics_kwh REAL`
- `hybrid_baseline_kwh REAL`
- `ml_residual_kwh REAL`
- `error_class_bias_kwh REAL`
- `memory_bias_kwh REAL`
- `signed_error_kwh REAL`
  - `actual_kwh - forecast_kwh`
- `abs_error_kwh REAL`
- `ape_pct REAL`
- `normalized_error REAL`
  - recommended:
    - `signed_error_kwh / max(opportunity_kwh, floor)`
- `opportunity_kwh REAL`
- `slot_weather_bucket TEXT`
- `day_regime TEXT`
- `actual_present INTEGER NOT NULL DEFAULT 0`
- `forecast_present INTEGER NOT NULL DEFAULT 0`
- `solcast_present INTEGER NOT NULL DEFAULT 0`
- `usable_for_metrics INTEGER NOT NULL DEFAULT 0`
- `usable_for_error_memory INTEGER NOT NULL DEFAULT 0`
- `manual_constraint_mask INTEGER NOT NULL DEFAULT 0`
- `cap_dispatch_mask INTEGER NOT NULL DEFAULT 0`
- `curtailed_mask INTEGER NOT NULL DEFAULT 0`
- `operational_mask INTEGER NOT NULL DEFAULT 0`
- `solar_mask INTEGER NOT NULL DEFAULT 0`
- `rad_wm2 REAL`
- `cloud_pct REAL`
- `support_weight REAL`
  - this is the final weight to use for error memory learning

Recommended uniqueness:

- unique on `(target_date, run_audit_id, slot)`

Recommended index:

- index on `(target_date, slot)`
- index on `(usable_for_error_memory, target_date DESC)`
- index on `(slot_weather_bucket, target_date DESC)`

Why this table matters:

- this is the table the error correction vector should learn from
- it preserves the exact aligned numbers used to build correction memory
- it makes debugging possible at the 5-minute slot level

#### D. When the comparison data should be saved

Comparison rows must not be written only at generation time because actuals do not yet exist.

Recommended save timing:

1. Save `forecast_run_audit` immediately after a successful forecast write.
2. Save `forecast_error_compare_daily` and `forecast_error_compare_slot` only after the target day has enough actual data to score.

Recommended scoring windows:

- primary scoring run:
  - after the solar window closes for the target day
  - recommended first attempt: `18:10` local time for same-day scoring
- stabilization scoring run:
  - run again after archive/hot data has settled
  - recommended second attempt: `00:15` local time on the next calendar day

Reason for two-step scoring:

- hot actual data may still be incomplete right after `18:00`
- some data may arrive late or be repaired
- the second pass can overwrite the first daily comparison row for the same `run_audit_id`

Idempotency rule:

- for the same `run_audit_id`, recomputing comparison data should replace the old comparison rows, not append duplicates

#### E. How the comparison data should be built

For each target day eligible for comparison:

1. Resolve the forecast run to score.
2. Load the aligned forecast rowset from the exact run variant.
3. Load loss-adjusted actual data.
4. Load Solcast snapshot for the same target day if available.
5. Load operational masks:
   - manual constraints
   - cap dispatch
   - curtailment
   - other operational exclusions
6. Build daily-level metrics.
7. Build slot-level rows.
8. Save daily row first.
9. Save slot rows second.

Important alignment rule:

- all comparisons must use the same slot basis:
  - local timezone
  - `05:00-18:00`
  - `5-minute` slots
  - loss-adjusted actuals

If the exact forecast arrays used during generation are available in memory, save them into `forecast_run_audit.notes_json` or a companion artifact reference so the comparison does not have to infer them later.

#### F. How to determine if a day is eligible for error correction

Recommended eligibility rules for `include_in_error_memory=1`:

- target day must have a complete or near-complete actual rowset
  - recommended threshold: at least `150` out of `156` solar slots
- forecast rowset must be complete
  - recommended threshold: at least `150` out of `156` solar slots
- daily comparison quality must be `eligible`
- day must not be flagged as operationally distorted beyond tolerance
  - recommended rejection if manual or dispatch masks cover more than `25%` of solar slots
- if provider is expected to use Solcast:
  - reject `ml_without_solcast`
  - reject `ml_solcast_hybrid_stale`
- reject days with obvious telemetry anomalies
- reject days with missing forecast provenance

Recommended eligibility rules for `include_in_source_scoring=1`:

- same as above, but allow more days than strict error-memory use
- for example, a day may be valid for QA but not valid for memory learning

This distinction matters:

- QA needs more visibility
- error memory needs cleaner data

#### G. How `compute_error_memory(...)` should change

Current problem:

- `compute_error_memory(...)` reconstructs historical error directly from `forecast_dayahead` and `actual`
- it cannot filter using the richer provenance that the fix requires

Recommended new flow:

1. Query `forecast_error_compare_daily` for the most recent eligible days where:
   - `include_in_error_memory=1`
   - `comparison_quality='eligible'`
2. Select up to `ERR_MEMORY_DAYS` daily rows ordered by most recent target date descending.
3. Load matching slot rows from `forecast_error_compare_slot`.
4. For each day:
   - use only rows where `usable_for_error_memory=1`
   - read `signed_error_kwh`
   - apply decay by recency
   - apply `support_weight`
5. Aggregate into the correction vector.
6. Smooth the final vector exactly as the current memory function already does.

Recommended weighting model:

- base recency weight:
  - existing `ERR_MEMORY_DECAY`
- multiplied by source-quality weight:
  - `1.00` for `solcast_direct`
  - `0.95` for `ml_solcast_hybrid_fresh`
  - `0.35` or `0.00` for `ml_solcast_hybrid_stale`
  - `0.20` or `0.00` for `ml_without_solcast` when Solcast was expected
- multiplied by slot support weight:
  - lower weight for slots with marginal opportunity or poor data quality

Recommended implementation approach:

- keep `compute_error_memory(...)` as a wrapper
- add a new helper such as:
  - `load_saved_error_memory_basis(today: date) -> list[dict]`
  - `compute_error_memory_from_saved_comparisons(today: date) -> np.ndarray`
- fall back to the old method only if the new tables are empty during migration

#### H. Slot-level formulas to save

Recommended saved formulas:

- `signed_error_kwh = actual_kwh - forecast_kwh`
- `abs_error_kwh = abs(signed_error_kwh)`
- `ape_pct = abs_error_kwh / max(actual_kwh, 1.0) * 100`
- `opportunity_kwh = max(hybrid_baseline_kwh, floor_kwh)`
- `normalized_error = signed_error_kwh / max(opportunity_kwh, floor_kwh)`

Recommended `floor_kwh`:

- use the same opportunity floor logic already used by the classifier path, or a fixed fraction of slot capacity

Why normalized error should be saved too:

- raw `kWh` bias is needed for correction
- normalized error is needed for comparing morning shoulders, midday peaks, and weak late-afternoon slots on a fair basis

#### I. Where in code the save should happen

Recommended write points:

- in `services/forecast_engine.py`
  - after `write_forecast(...)` succeeds, write or update `forecast_run_audit`
  - after QA/scoring pass, write `forecast_error_compare_daily` and `forecast_error_compare_slot`
- in `server/index.js`
  - when the manual direct Solcast path writes rows, also write `forecast_run_audit`
  - when the Node fallback writes rows, also write `forecast_run_audit`

Recommended new helpers:

- `save_forecast_run_audit(...)`
- `replace_forecast_error_compare_daily(...)`
- `replace_forecast_error_compare_slots(...)`
- `score_forecast_run_against_actuals(target_date, run_audit_id, force=False)`
- `list_error_memory_eligible_days(limit)`

Recommended DB ownership:

- SQL schema and prepared statements in `server/db.js`
- Python may write through SQLite directly if that remains the existing pattern for the forecast engine
- but the schema contract must stay centralized and documented

#### J. Handling multiple forecasts for the same day

This is critical.

A single target day may have:

- an automatic forecast at `18:00`
- a fallback repair at `18:30`
- a manual direct Solcast generation later

Do not collapse these into one anonymous historical day.

Required behavior:

- each run gets its own `forecast_run_audit` row
- each run can get its own comparison row after actuals exist
- exactly one run may be marked as:
  - `is_authoritative_for_learning=1`

Recommended authority rule:

- choose the latest successful run that matches provider expectations and freshness expectations

This allows:

- audit of all runs
- learning only from the best qualified run

#### K. Retention policy

Recommended retention:

- keep `forecast_run_audit` for at least `400` days
- keep `forecast_error_compare_daily` for at least `400` days
- keep `forecast_error_compare_slot` for at least `400` days if storage is acceptable

If storage becomes a concern:

- keep all daily rows
- keep slot rows for `180-400` days
- archive older slot rows into a compressed export or archive database

Do not delete slot rows too aggressively because:

- they are needed for replay analysis
- they are needed to prove whether a correction rule helped or hurt

#### L. Migration and backfill

Recommended rollout:

1. Add the new tables.
2. Start writing `forecast_run_audit` for new generations immediately.
3. Backfill recent comparison history for at least the last `30-90` completed days.
4. Switch `compute_error_memory(...)` to prefer saved comparison rows.
5. Keep legacy fallback reading for one release only.

Backfill rule:

- for historical dates, only backfill comparison rows when:
  - actuals are available
  - a valid saved day-ahead exists
  - provenance can be inferred with reasonable confidence

If provenance cannot be inferred confidently:

- backfill with:
  - `comparison_quality='review'`
  - `include_in_error_memory=0`

#### M. Tests required for this persistence design

Minimum tests:

- saves one `forecast_run_audit` row per generation run
- scoring pass writes one daily comparison row and `156` slot rows for a full solar-window day
- recomputing comparison for the same `run_audit_id` replaces old rows idempotently
- `compute_error_memory(...)` excludes ineligible days
- stale-Solcast auto runs are not included in error memory when Solcast was expected
- manual direct Solcast runs can be included if actual data is complete and masks are acceptable
- multiple runs for the same target date preserve separate audit/comparison history

#### N. Acceptance criteria for this detailed comparison-save design

- the system can answer, for any target day, exactly which forecast run was compared against actuals
- the system can show whether that run used fresh Solcast, stale Solcast, or no Solcast
- the slot-level error vector used for memory correction is reproducible from saved rows
- `compute_error_memory(...)` no longer depends on opaque mixed historical rows
- the team can query whether Solcast-backed runs outperform degraded auto runs on a like-for-like basis

### Phase 5. Validate with replay and side-by-side totals

Objective:

- prove the fix solves the real production complaint before rollout

Tasks:

- replay at least the last `30` days of completed forecasts
- compare:
  - current automatic path
  - fixed automatic path
  - direct Solcast totals
  - actual totals
- include daily-total error and slot-level error
- pay special attention to clear and mixed-weather days where Solcast is expected to be strong

Suggested acceptance targets:

- `100%` provider parity between manual and automatic generation
- `100%` of scheduled ML runs use a fresh same-cycle Solcast snapshot when Solcast is configured
- automatic total should not remain materially below direct Solcast on days where the chosen mode is expected to respect Solcast authority
- measurable reduction in daily-total error versus the current automatic path over the replay window

Files expected to change:

- `services/forecast_engine.py`
- `server/tests/*`
- `services/tests/*`

### Phase 5A. Detailed replay, validation, and rollout gating

Objective:

- verify the design with evidence before declaring the forecast path fixed

#### A. Validation datasets

Recommended replay windows:

- primary window:
  - last `30` completed days
- preferred window:
  - last `60-90` completed days if snapshots and actuals are available

Recommended slices:

- clear days
- mixed days
- overcast days
- rainy days
- days with fresh Solcast
- days where old auto path likely used stale or missing Solcast

The result should not be judged only on one good day or one bad day.

#### B. Scenarios to compare

For each scored day, compare:

- old automatic path result
- fixed automatic path result
- direct Solcast day total and slot shape
- actual loss-adjusted total and slot shape

If available, also compare:

- pure physics baseline
- hybrid baseline before residual corrections

This makes it possible to answer:

- whether the main gain came from provider parity
- whether the gain came from snapshot freshness
- whether the residual correction is helping or hurting after parity is restored

#### C. Metrics to report

Daily-level metrics:

- daily total actual
- daily total forecast
- daily error kWh
- daily APE percent
- WAPE
- MAPE
- RMSE
- MBE

Slot-level metrics:

- first active error minute
- last active error minute
- mean absolute slot error
- normalized slot error by weather bucket
- clear-sky slot error vs mixed-weather slot error

Provenance metrics:

- count of runs by forecast variant
- count of runs by freshness class
- count of days included in error memory
- count of days excluded from learning

#### D. Required validation reports

Recommended generated outputs:

- one CSV or JSON summary row per day
- one aggregate report grouped by:
  - forecast variant
  - day regime
  - freshness class
- one report showing:
  - old auto vs fixed auto deltas

Minimum report questions:

1. Did provider parity eliminate the worst underforecast cases?
2. Did fresh Solcast usage improve the average daily total error?
3. Did source-aware error memory improve or worsen results after rollout?
4. Are clear-day results now closer to direct Solcast where Solcast is known to perform well?

#### E. Acceptance thresholds

Minimum acceptance thresholds before rollout:

- `100%` of new automatic runs must produce an audit row
- `100%` of new automatic ML runs must record freshness class
- `100%` of comparison-eligible days must produce comparison rows
- `0` silent degraded runs when provider parity or freshness policy is violated
- measurable reduction in daily-total error versus the old automatic path over the replay window

Preferred performance threshold:

- fixed automatic path should outperform the old automatic path in:
  - overall WAPE
  - median daily total APE
  - clear-day total APE

#### F. Rollout stages

Recommended rollout:

1. ship audit-only instrumentation first if needed
2. ship shared provider orchestration second
3. ship quality-aware fallback third
4. ship comparison-save and source-aware error memory fourth
5. run replay validation after each stage

Reason:

- this isolates regressions
- it becomes obvious whether the main improvement came from parity, freshness, or error-memory cleanup

#### G. Post-rollout watch period

Recommended watch period:

- at least `14` live operating days

Watch-list items:

- any auto-generated day with freshness class not equal to expected value
- any fallback replacement triggered by wrong-provider or stale-input state
- any day where fixed automatic total still deviates materially from direct Solcast without a clear operational reason
- any increase in daily-total error after source-aware memory goes live

#### H. Tests for Phase 5

Required tests:

- replay summary includes forecast variant and freshness class
- aggregate report groups correctly by regime and source
- ineligible comparison days are excluded from memory-learning metrics
- authoritative run selection remains stable when multiple runs exist for one target day

## Recommended Implementation Order

### Detailed Work Packages

1. Work Package 1: shared orchestration and parity
   - add shared provider-routing path in Node
   - delegate automatic generation into that path
   - keep Python ML execution only
   - add unit tests for parity
2. Work Package 2: audit and freshness persistence
   - add `forecast_run_audit`
   - add freshness-class logic
   - write audit rows for manual, auto, and fallback paths
3. Work Package 3: quality-aware fallback
   - classify tomorrow state as healthy or not
   - replace weak complete forecasts when policy requires it
   - preserve superseded history
4. Work Package 4: comparison persistence and source-aware correction
   - add `forecast_error_compare_daily`
   - add `forecast_error_compare_slot`
   - switch error memory to saved comparison rows
5. Work Package 5: replay validation and threshold tuning
   - backfill recent history
   - score old vs fixed behavior
   - tune only after parity and provenance are proven

### Release Sequence

Recommended release sequence:

1. release audit and parity together if possible
2. release fallback quality gates next
3. release comparison-save and source-aware memory after enough audit data exists
4. release any threshold tuning only after replay results confirm which gate is still too conservative

## Immediate Hotfix Candidate

If a short-term mitigation is needed before the full refactor:

- do not let the automatic scheduler write tomorrow's day-ahead without a fresh Solcast snapshot when Solcast is configured
- if `forecastProvider=solcast`, force the automatic path to use the direct Solcast writer
- if the first scheduled run already wrote a complete but weak forecast, allow the `18:30` fallback cycle to replace it when provider/freshness parity is wrong

Detailed hotfix boundaries:

- do not change ML blend tuning yet
- do not change error-memory math yet
- do not tune `SOLCAST_PRIOR_TOTAL_RATIO_CLIP` yet

Reason:

- provider parity and snapshot freshness are the highest-confidence root causes
- changing blend math before fixing orchestration would make diagnosis harder

Hotfix success definition:

- automatic output path matches manual provider behavior
- stale or missing Solcast cannot silently produce the final authoritative forecast when Solcast should have been used

## Summary

The current issue is not just "ML needs better correction."

The bigger design problem is that manual and automatic generation are not running through the same decision path. The manual route can use fresh Solcast and direct Solcast generation, while the automatic scheduler can still produce ML/hybrid output without a fresh snapshot and without honoring the configured provider. That mismatch must be fixed first. After that, provenance-aware QA and error-memory cleanup should improve the correction loop in a way that is actually aligned with the better-performing Solcast-informed forecasts.
