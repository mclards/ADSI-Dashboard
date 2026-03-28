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

---

## Solcast Alignment Hardening (v2.4.32)

- `SOLCAST_RESIDUAL_PRIMARY_CAP` lowered from 0.40 to 0.30 — tighter ML residual damping when Solcast is primary
- Error-memory bias damping: fresh Solcast (coverage ≥ 0.95) reduces historical bias correction by 70%; coverage ≥ 0.80 reduces by 50%
- Per-slot Solcast energy floor: each 5-min slot floored at 95% of Solcast (fresh) or 88% (stale_usable)
- Constants: `SOLCAST_FORECAST_FLOOR_RATIO_FRESH = 0.95`, `SOLCAST_FORECAST_FLOOR_RATIO_USABLE = 0.88`

---

## Solcast Reliability Dimensions (v2.4.33+)

`build_solcast_reliability_artifact()` produces a multi-dimensional trust profile at 5-min slot resolution:

| Dimension | Artifact Key | Effect |
|---|---|---|
| Weather regime | `regimes` (clear/mixed/overcast/rainy) | Per-regime bias_ratio + reliability |
| Season | `seasons` (dry/wet), `season_regimes` | Season-aware lookup in `lookup_solcast_reliability()` |
| Time-of-day | `time_of_day` (morning/midday/afternoon), `time_of_day_by_regime` | Per-slot blend and floor modulation |
| Trend | `trend` (improving/stable/degrading) | Blend ±6-8%, residual damping adjustment |

All lookups have backward-compatible fallbacks — old artifacts without new keys load safely.

---

## Forecast Performance Monitor (v2.4.42)

`/api/forecast/engine-health` returns extended diagnostics:
- `mlBackend` — active backend type (LightGBM vs sklearn)
- `trainingSummary` — sample count, feature count, regime count, last training date
- `dataQualityFlags` — warnings for stale features, low sample count, regime imbalance

New Python helpers:
- `_detect_ml_backend()` — identifies active ML backend
- `_collect_data_quality_warnings()` — audits data state and returns warning list

`ml_train_state.json` extended fields: `ml_backend_type`, `model_file_path`, `model_file_mtime_ms`,
`training_samples_count`, `training_features_count`, `training_regimes_count`, `training_result`,
`last_training_date`, `data_warnings`.

The Forecast Performance Monitor panel defaults to collapsed on first dashboard load.

---

## Solcast Tri-Band LightGBM Features (v2.5.0+)

`solcast_prior_from_snapshot()` now exposes tri-band P10/Lo and P90/Hi values alongside the forecast point estimate.
`build_features()` derives 6 new feature columns to train LightGBM on forecast uncertainty:

| Feature | Formula | Meaning |
|---|---|---|
| `solcast_lo_kwh` | P10 percentile from Solcast Toolkit | Lower bound (10th percentile) forecast |
| `solcast_hi_kwh` | P90 percentile from Solcast Toolkit | Upper bound (90th percentile) forecast |
| `solcast_lo_vs_physics` | `lo_kwh / slot_cap_kwh` | Normalized lower bound (0–1.5 scale) |
| `solcast_hi_vs_physics` | `hi_kwh / slot_cap_kwh` | Normalized upper bound (0–1.5 scale) |
| `solcast_spread_pct` | `100 × (hi - lo) / forecast` | Uncertainty as percentage of point estimate (0–200%) |
| `solcast_spread_ratio` | `(hi - lo) / (hi + lo)` | Symmetric spread metric, scale-robust (-1 to 1) |

**FEATURE_COLS expansion:** 62 → 68 columns. Updated feature count must match active ML bundles; legacy 62-feature models auto-align via `_align_bundle_features()` padding new columns with zeros.

**Data availability:**
- P10/P90 available only from Solcast Toolkit API for **future-dated requests** (forecast generation, not historical backfill)
- When unavailable or stale, `has_triband=False` in `solcast_prior_from_snapshot()` — new features fall back to zero spread (lo/hi both equal forecast)
- No DB migration required — `solcast_snapshots` already stores `forecast_lo_kwh`, `forecast_hi_kwh` from Solcast API

**Backward compatibility:**
- Old 62-feature trained models load safely when loaded by new 68-feature code
- Auto-alignment pads missing tri-band features with zeros (valid for zero-spread data)
- Training with zero-spread data (before tri-band availability) produces redundant tri-band features; model ignores or learns zero importance

**LightGBM hyperparameter tuning for expanded feature space:**
- `n_estimators=650` (larger ensemble for wider feature space)
- `learning_rate=0.040` (moderate learning rate for stability)
- `max_depth=8, num_leaves=71` (deeper trees to capture feature interactions)
- `subsample=0.78, colsample_bytree=0.75` (aggressive subsampling for robustness)
- `min_child_samples=22` (regularization to prevent overfitting)
- `reg_alpha=0.08, reg_lambda=0.12` (L1/L2 penalty for sparsity)

**Feature importance expectations:**
- Tri-band features combined typically contribute 4–5% of total importance
- `solcast_spread_ratio` often higher importance than percentage variant (more stable numerically)
- `solcast_lo_vs_physics` and `solcast_hi_vs_physics` capture quantile-specific physics alignment
- Under-cloud conditions: spread features aid model detection of high-variance regimes
