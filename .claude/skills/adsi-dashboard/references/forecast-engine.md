# Forecast Engine Reference

## Services

- `services/forecast_engine.py` — ML training, day-ahead generation, intraday adjustment, Solcast reliability, QA, backtest
- `ForecastCoreService.py` — entry point; runs the forecast engine in a continuous 60-second loop

## Day-Ahead Auto-Generation Schedule

| Trigger | Behavior |
|---|---|
| Hours 6 and 18 (primary) | Always retrain + generate |
| Post-solar checker (18:00–04:59) | Every 60 s — verifies tomorrow exists; regenerates if missing |
| Node.js cron at 04:30, 18:30, 20:00, 22:00 | Safety net when Python service is not running |
| Recovery during solar hours | Generates immediately if today's forecast is missing |

Forecast generation is always skipped in `remote` mode. Do not remove the dual-layer safety net (Python service + Node.js cron).

## Provider Variants and Freshness

Each target date stores its own variant at generation time:

| Variant | Meaning |
|---|---|
| `solcast_direct` | Solcast data fresh enough to use directly |
| `ml_solcast_hybrid_fresh` | ML with fresh Solcast prior |
| `ml_solcast_hybrid_stale` | ML with stale-but-usable Solcast |
| `ml_without_solcast` | ML only — no Solcast available |

Solcast freshness classes: `fresh` (coverage ≥ 0.95, pulled within 2 h), `stale_usable` (≥ 0.80, within 12 h), `stale_reject`, `missing`, `not_expected`.

Fallback quality classes: `missing`, `incomplete`, `missing_audit`, `wrong_provider`, `stale_input`, `weak_quality`, `healthy`. Only `healthy` suppresses regeneration — a complete rowset alone is not sufficient.

## Provider Orchestration Architecture

**Node owns provider routing and Solcast fetch decisions. Python owns ML execution, training, QA, and error correction.**

The Python scheduler resolves the target date and trigger reason, then delegates generation to the shared Node orchestrator via `/api/internal/forecast/generate-auto`. Node applies the same provider logic for automatic generation as for manual generation. `_delegate_run_dayahead()` uses `ADSI_SERVER_PORT:3500` — not `IM_SERVER_PORT:3000`.

Provider routing rules:
- `forecastProvider=solcast` → both manual and automatic use `solcast_direct` path
- `forecastProvider=ml_local` + Solcast configured → both refresh snapshot before running Python ML
- `forecastProvider=ml_local` + no Solcast → ML proceeds; audit row marks `forecast_variant='ml_without_solcast'`

Run authority order: `solcast_direct` > `ml_solcast_hybrid_fresh` > `ml_solcast_hybrid_stale` > `ml_without_solcast`. One run per target date is marked `authoritative_for_learning=1`. When a newer run supersedes an old one: store `superseded_by_run_audit_id` / `replaces_run_audit_id`, set `run_status='superseded'`.

## Solcast Authority and Usage

Solcast is a **high-authority input**. It must not be skipped or treated as optional when available.

**In ML training:**
- `collect_training_data()` and `collect_history_days()` must consume Solcast snapshot data as a training feature when available.
- Do not fall back to pure physics baseline when Solcast snapshots exist.
- `build_solcast_reliability_artifact()` builds per-weather-bucket trust scores feeding `solcast_resolution_weight` and `solcast_resolution_support` as ML features.

**In day-ahead generation (manual and automatic):**
- Always attempt to load Solcast snapshots for the target date before generating.
- Variant priority: `solcast_direct` → `ml_solcast_hybrid_fresh` → `ml_solcast_hybrid_stale` → `ml_without_solcast` (last resort).
- Do not skip Solcast loading as an optimization — a silent omission triggers quality-class `wrong_provider`.

**Normalization:**
- Raw Solcast arrives in `MW` — always normalize to `kWh per 5-minute slot` before scoring, blending, or comparison.
- `build_solcast_reliability_artifact()` compares Solcast against `load_actual_loss_adjusted()` — never against raw inverter totals.

## Solcast Reliability Artifact (v2.4.33+)

`build_solcast_reliability_artifact()` produces a multi-dimensional trust profile stored as `pv_solcast_reliability.joblib`. It compares 30 days of Solcast forecasts against loss-adjusted actuals at **5-minute slot resolution**.

### Dimensions

| Dimension | Keys | Purpose |
|---|---|---|
| Overall | `overall` | Global bias_ratio, MAPE, reliability |
| Weather regime | `regimes` → `clear` / `mixed` / `overcast` / `rainy` | Per-regime trust |
| Weather bucket | `resolution_profiles.buckets` → `clear_stable` / `clear_edge` / `mixed_stable` / `mixed_volatile` / `overcast` / `rainy` | Per-slot resolution weighting |
| Season | `seasons` → `dry` (Dec-May) / `wet` (Jun-Nov) | Seasonal trust |
| Season × regime | `season_regimes` → `dry:clear`, `wet:mixed`, etc. | Cross-dimensional |
| Time-of-day | `time_of_day` → `morning` (05:00-08:55) / `midday` (09:00-14:55) / `afternoon` (15:00-17:55) | Per-zone reliability |
| Time-of-day × regime | `time_of_day_by_regime` → `clear.morning`, etc. | Cross-dimensional |
| Trend | `trend` → `signal`, `magnitude` | Recent reliability direction |

### Seasonal Breakdown

`_season_bucket_from_day()` classifies dry (Dec-May) vs wet (Jun-Nov). `lookup_solcast_reliability(artifact, regime, season=)` checks `season_regimes["{season}:{regime}"]` first, then falls back to `regimes[regime]` → `seasons[season]` → `overall`.

### Time-of-Day Reliability

Three zones defined by `TOD_ZONES`:
- **morning**: slots 60–107 (05:00–08:55)
- **midday**: slots 108–179 (09:00–14:55)
- **afternoon**: slots 180–215 (15:00–17:55)

`_compute_tod_slot_metrics()` computes per-zone bias_ratio and MAPE from slot-level arrays. `lookup_solcast_tod_reliability(artifact, regime, zone)` retrieves zone metrics.

**Consumers:**
- `solcast_prior_from_snapshot()` — per-slot blend weight scaled by `clip(zone_rel / overall_rel, 0.85, 1.08)`
- `run_dayahead()` floor logic — per-slot floor modulated by `clip(zone_rel / overall_rel, 0.80, 1.10)`

Effect: tighter Solcast trust at midday (where Solcast is accurate), looser at dawn/dusk.

### Trend Detection

`_compute_solcast_trend()` splits the 30-day window into recent half vs older half. Computes reliability for each and determines:
- `"improving"` — recent half reliability > older by ≥ 5%
- `"degrading"` — recent half reliability < older by ≥ 5%
- `"stable"` — within ±5%

**Consumers:**
- `solcast_prior_from_snapshot()` — blend boosted up to +6% when improving, reduced up to -8% when degrading
- `solcast_residual_damp_factor()` — improving → damp more (trust Solcast), degrading → damp less (let ML through)

### Per-Slot Solcast Floor

When Solcast is fresh, each 5-min slot is individually floored:
- Coverage ≥ 95%: `floor = solcast[slot] × 0.95 × tod_mod[slot]`
- Coverage ≥ 80%: `floor = solcast[slot] × 0.88 × tod_mod[slot]`
- Coverage < 80%: floor disabled

`tod_mod` adjusts floor per time-of-day zone. Only slots where ML forecast < floor are lifted; slots above floor are untouched.

### Error-Memory Bias Damping

When Solcast is fresh, historical error-memory bias correction is damped:
- Coverage ≥ 95%: bias reduced by 70% (multiply by 0.30)
- Coverage ≥ 80%: bias reduced by 50% (multiply by 0.50)

Prevents old biases (built on weak-provider runs) from dragging forecast below reliable Solcast prior.

## Key Functions

| Function | Purpose |
|---|---|
| `run_dayahead()` | Main day-ahead generation entry point |
| `_delegate_run_dayahead()` | Delegates to Node orchestrator via `ADSI_SERVER_PORT:3500` |
| `run_manual_generation()` | Delegates to Node orchestrator first, with audit-backed fallback |
| `build_intraday_adjusted_forecast()` | Intraday adjustment; excludes cap-dispatched slots |
| `compute_error_memory()` | Bias correction using saved eligible rows with `decay × source_weight × support_weight` |
| `_compute_error_memory_legacy()` | Fallback for legacy DBs / migration gaps |
| `_fetch_run_audit_meta()` | Resolves rich run metadata for QA persistence |
| `_memory_source_weight()` | Source-quality weighting for provenance-aware correction |
| `_persist_qa_comparison()` | Writes day/slot comparison rows with eligibility rules and support weights |
| `collect_training_data()` / `collect_training_data_hardened()` | Training data with cap-dispatch reconstruction |
| `collect_history_days()` | Stores `cap_dispatch_mask` per sample |
| `forecast_qa()` | QA scoring — WAPE, MAPE, total-energy APE, slot timing error |
| `run_backtest()` | Historical scoring without overwriting live rows |
| `build_solcast_reliability_artifact()` | Solcast trust calibration — seasonal, ToD, trend, regime, bucket dimensions |
| `_compute_tod_slot_metrics()` | Per-zone (morning/midday/afternoon) bias_ratio and MAPE from slot arrays |
| `_compute_solcast_trend()` | Half-window split trend detection (improving/stable/degrading) |
| `lookup_solcast_reliability()` | Season+regime-aware reliability lookup with fallback chain |
| `lookup_solcast_tod_reliability()` | Time-of-day zone reliability lookup by regime |
| `lookup_solcast_trend()` | Trend signal and magnitude retrieval |
| `solcast_prior_from_snapshot()` | Builds per-slot blend weights with season, ToD, and trend modulation |
| `solcast_residual_damp_factor()` | ML residual damping — trend-aware |
| `load_actual_loss_adjusted()` / `load_actual_loss_adjusted_with_presence()` | Loss-adjusted actual energy loaders |
| `plant_capacity_profile()` | Returns `loss_adjusted_equiv`, `dependable_kw`, `max_kw` |

## Comparison Persistence Tables

`forecast_run_audit` — written immediately after a successful forecast write. Stores provenance, freshness class, run status, daily totals. Supported via dedicated audit helpers for direct-call paths (`write_audit` param on `run_dayahead()`).

`forecast_error_compare_daily` — written after actuals exist. Stores error metrics and eligibility flags (`include_in_error_memory`, `include_in_source_scoring`, `comparison_quality`).

`forecast_error_compare_slot` — per-slot rows with `usable_for_error_memory` and `support_weight`.

`compute_error_memory()` selects using `include_in_error_memory=1`, `comparison_quality='eligible'`, `usable_for_error_memory=1`.

Source quality weights: `solcast_direct` 1.00, `ml_solcast_hybrid_fresh` 0.95, `ml_solcast_hybrid_stale` 0.35, `ml_without_solcast` 0.20.

## Plant-Cap and Training Rules

`audit_log.scope = "plant-cap"` distinguishes cap-dispatch stops from manual/fault stops. Cap-dispatch-only slots have actual output replaced with the physics/hybrid baseline for training. Manually constrained slots are excluded entirely from the training mask.

`build_intraday_adjusted_forecast()` excludes cap-dispatched slots from actual-vs-dayahead ratio computation.

Do not remove the `scope` column from `audit_log` or change the `"plant-cap"` tag.

## Per-Inverter Transmission Loss

Loss factors in `ipconfig.json` under `losses: { "1": 2.5, ... }`. Default 2.5%. Affect forecast engine only — never raw telemetry, dashboard, or exports.

Loss-adjusted loaders used by: `collect_training_data()`, `collect_history_days()`, `compute_error_memory()`, `build_intraday_adjusted_forecast()`, `forecast_qa()`, `run_backtest()`, `build_solcast_reliability_artifact()`. When all losses are 0, short-circuit to raw `load_actual()` cache.

## Forecast Export Ceiling

`forecastExportLimitMw` read from settings table. `24 MW` is the fallback default only — not hardcoded.

## Implementation Work Packages

| Package | Scope | Status |
|---|---|---|
| WP1 | Shared Node orchestrator; Python scheduler delegates via internal route; parity tests | Done (v2.4.31) |
| WP2 | `forecast_run_audit` table; freshness-class logic; audit rows for all paths | Done (v2.4.31) |
| WP3 | Quality-aware fallback — classify tomorrow state; replace weak-but-complete forecasts | Done (v2.4.30) |
| WP4 | `forecast_error_compare_daily` + `forecast_error_compare_slot`; source-aware error memory | Done (v2.4.30) |
| WP5 | Replay validation over last 30–90 days before threshold tuning | Pending |
| WP6 | Enhanced Solcast reliability — seasonal, time-of-day, trend detection (all at 5-min slot resolution) | Done (v2.4.33) |