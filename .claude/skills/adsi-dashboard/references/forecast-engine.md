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
| `build_solcast_reliability_artifact()` | Solcast trust calibration against loss-adjusted actuals |
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