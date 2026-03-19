# Weather-Conditioned Error Classification for Forecast ML

## Summary
Add an auxiliary ML error-classification path on top of the existing residual regressor in [forecast_engine.py](d:/ADSI-Dashboard/services/forecast_engine.py). Keep the current physics + Solcast + residual-regression pipeline as the primary forecast path, then add a weather-conditioned classifier that learns whether each 5-minute slot is likely to be `strong_over`, `mild_over`, `neutral`, `mild_under`, or `strong_under` relative to the hybrid baseline. Use it in two places: a conservative capped bias term during day-ahead inference, and explicit QA/backtest breakdowns by weather bucket.

## Release Status
- Included in release baseline `v2.4.26` with forecast-engine verification and installer rebuild completed on `2026-03-19`.

## Progress
- [x] Core weather-conditioned error classifier path implemented in `forecast_engine.py`
- [x] QA/backtest weather-bucket breakdowns and classifier diagnostics implemented
- [x] Focused unit coverage added for bucket classification, class labeling, confidence-band widening, and diagnostic payloads
- [x] Calibrate classifier probabilities on blocked day-level holdout so `class_confidence` is more trustworthy for blending and confidence bands
- [x] Change error-class labeling from full-slot-cap normalization to slot-opportunity normalization tied to hybrid baseline / usable slot opportunity
- [x] Cache reusable historical feature / mask / residual artifacts so global training, regime training, and profile aggregation do not recompute the same frames
- [x] Add centroid shrinkage so rare extreme classes are converted into more conservative bias centroids
- [x] Add sparse-class fallback so rare extreme classes and thin regime splits do not overreact even when class counts are structurally low
- [x] Use historical weather-bucket error profiles during inference to scale blend / caps based on bucket reliability, not just diagnostics
- [x] Replace random early-stopping validation with blocked day-level validation for estimator selection to reduce slot leakage across train/validation
- [x] Remove tree-model scaling and simplify inference/training bundle transforms
- [x] Vectorize bucket classification and replace hot-path pandas rolling calls with lighter NumPy smoothing where it improves runtime without changing behavior

## Current Implementation Order
1. Optional cleanup: address existing temp-log warnings in tests
2. Optional validation: run a wider historical backtest to quantify aggregate gains vs baseline

## Key Changes
- Keep existing day regimes unchanged: `clear`, `mixed`, `overcast`, `rainy`.
- Add a new 5-minute slot weather bucket classifier, derived from the interpolated weather frame:
  - `rainy`: `precip > 0.05 mm/slot` or `(cape >= 650 and cloud >= 82)`
  - `clear_stable`: `cloud < 25`, `kt >= 0.70`, `abs(drad) < 90`
  - `clear_edge`: `cloud < 40`, `kt >= 0.55`, `abs(drad) >= 90`
  - `mixed_stable`: `25 <= cloud < 70`, `kt >= 0.40`, `abs(drad) < 120`, not rainy
  - `mixed_volatile`: `25 <= cloud < 80`, `abs(drad) >= 120`, not rainy
  - `overcast`: everything else inside usable solar slots
- Train an auxiliary classifier from the same accepted historical samples already used by the hardened trainer:
  - Inputs: the same `FEATURE_COLS` feature matrix already used by the residual regressor.
  - Labels: based on `residual = actual_effective - hybrid_baseline`, normalized by slot opportunity tied to hybrid baseline / usable slot cap.
  - Fixed class thresholds:
    - `strong_over` if `residual_norm <= -0.14`
    - `mild_over` if `-0.14 < residual_norm <= -0.04`
    - `neutral` if `-0.04 < residual_norm < 0.04`
    - `mild_under` if `0.04 <= residual_norm < 0.14`
    - `strong_under` if `residual_norm >= 0.14`
- Extend training state and model bundle with:
  - one global classifier
  - optional regime-specific classifiers, using the same regime split rules as the residual models
  - per-class residual centroids and per-day-regime + slot-bucket error summaries for calibration and QA
- Use `GradientBoostingClassifier` with the same sample weights as the residual regressor; tree models consume aligned raw features directly.
- Use blocked day-level holdout selection to choose tree stage counts and classifier calibration temperature without slot-level leakage.
- Keep Solcast reliability calibration on the same substation-delivered basis as the rest of the forecast stack by comparing snapshots against `load_actual_loss_adjusted()` when per-inverter losses are configured.
- Learn per-weather-class resolution preference between `Solcast vs loss-adjusted actual` and `generated day-ahead vs loss-adjusted actual`, and feed that history back into both Solcast authority and ML features.
- Store daily unit-tagged resolution/error history (`MW` Solcast normalized to `kWh per 5-minute slot` against loss-adjusted actuals) so training has more basis than one-off live comparisons.
- In inference:
  - predict class probabilities for each slot from the weather/features of the target day
  - convert probabilities into an expected class residual bias using the trained class centroids
  - apply the same solar/radiation masking, weather-adaptive dampening, and Solcast dampening used for ML residuals
  - blend conservatively into the forecast as an extra additive term:
    - `class_confidence = max(class_probabilities)`
    - `class_blend = clip(0.10 + 0.25 * ((class_confidence - 0.40) / 0.60), 0.10, 0.35)`
    - `class_bias = clip(expected_class_bias_kwh, -0.18 * cap_slot, 0.18 * cap_slot)`
    - final additive classifier term = `class_blend * class_bias`
  - do not let the classifier replace or override the residual regressor
- Extend QA/backtest reporting so each evaluated day includes:
  - overall metrics as today
  - metrics by day regime
  - metrics by slot weather bucket
  - classifier sign hit-rate and severe-class hit-rate
  - mean predicted class confidence
- Keep all classifier logic forecast-only. Do not change raw dashboard logging/export data, DB history rows, or non-forecast operational records.

## Interfaces / Outputs
- `model_bundle` gains a new sibling block for classifier state alongside the existing global/regime regressors.
- `build_training_state()` and `train_model()` save classifier artifacts in the same bundle file; no new standalone DB tables.
- `run_dayahead(..., persist=False)` gains an `error_class_meta` payload containing:
  - predicted class distribution summary
  - mean classifier confidence
  - total classifier bias contribution
  - per-bucket forecast summary for diagnostics
- `forecast_qa()` and `run_backtest()` log and return weather-bucketed error summaries in addition to current aggregate metrics.

## Test Plan
- Unit-test slot weather bucket classification for clear, volatile, overcast, and rainy weather frames.
- Unit-test residual-to-error-class labeling at each threshold boundary.
- Verify classifier training skips cleanly when data is insufficient or only one class is present.
- Verify inference keeps classifier bias at zero outside solar hours and below the radiation floor.
- Verify classifier bias stays capped and is damped when Solcast is strong.
- Verify QA/backtest bucket metrics exclude missing and operationally constrained slots exactly like current aggregate scoring.
- Verify the non-persist forecast result includes `error_class_meta` and that day-regime + slot-bucket breakdowns are populated.

## Assumptions
- No UI work is included; initial visibility is through logs, backtest output, and non-persist diagnostic payloads.
- Existing day-regime logic remains the top-level regime taxonomy.
- The new classifier is additive and conservative by design; it does not replace the residual regressor or the existing error-memory path.
- No database schema changes are needed.
