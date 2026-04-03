# ADSI Forecast Engine Architecture

**Version:** 2.7.0 (PHASE 4 — Solcast Tri-Band Baseline)
**Author:** Engr. Clariden D. Montano REE
**Last Updated:** 2026-04-03

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Data Inputs](#3-data-inputs)
4. [Solcast Integration](#4-solcast-integration)
5. [Day-Ahead Generation Pipeline](#5-day-ahead-generation-pipeline)
6. [Python ML Engine (forecast_engine.py)](#6-python-ml-engine)
7. [Feature Engineering (70 Features)](#7-feature-engineering)
8. [ML Model Training](#8-ml-model-training)
9. [Error Classifier & Bias Correction](#9-error-classifier--bias-correction)
10. [Post-Processing & Hardening](#10-post-processing--hardening)
11. [Solcast Reliability Artifact](#11-solcast-reliability-artifact)
12. [Trigger Paths & Cron Schedule](#12-trigger-paths--cron-schedule)
13. [Forecast Quality Assessment](#13-forecast-quality-assessment)
14. [Audit Trail (forecast_run_audit)](#14-audit-trail)
15. [Forecast Performance Monitor (FPM)](#15-forecast-performance-monitor)
16. [Snapshot Lifecycle & Tri-Band Constraints](#16-snapshot-lifecycle--tri-band-constraints)
17. [Confidence Bands](#17-confidence-bands)
18. [Sanity Checks & Safety Guards](#18-sanity-checks--safety-guards)

---

## 1. System Overview

The ADSI Forecast Engine is a **hybrid ML + Solcast** day-ahead solar generation forecasting system for the Alterpower Digos Solar (ADSI) plant. It generates 5-minute resolution forecasts for the next day's solar energy production.

**Key characteristics:**
- **288 time slots** per day (5-minute resolution, 24 hours)
- **132 solar slots** within the solar window (approximately 05:30 to 16:30 local time)
- **Plant capacity:** 8.2 MW dependable / 21.8 MW maximum (27 Ingeteam INGECON inverters)
- **Baseline:** Solcast mid (P50) — not physics (since PHASE 4, v2.5.0+)
- **ML correction:** LightGBM residual model trained on historical actual vs. Solcast baseline error
- **Output:** Per-slot kWh forecast with P10/P90 confidence bands

**Two execution environments:**
- **Node.js (server/index.js):** Orchestrator — handles provider routing, Solcast API calls, snapshot persistence, audit logging, cron scheduling, and the FPM endpoint
- **Python (services/forecast_engine.py):** ML engine — handles feature engineering, model training, residual prediction, error classification, and forecast generation

---

## 2. Architecture Diagram

```
                        +------------------+
                        |   TRIGGER        |
                        | Manual UI / Cron |
                        | Python CLI / Auto|
                        +--------+---------+
                                 |
                                 v
                  +------------------------------+
                  |  Node.js Orchestrator         |
                  |  runDayAheadGenerationPlan()  |
                  |                              |
                  |  1. Read preferred provider   |
                  |  2. Build provider order      |
                  |  3. Auto-fetch Solcast snap   |
                  |  4. Spawn Python subprocess   |
                  |  5. Write audit trail         |
                  +-----+---------------+--------+
                        |               |
              +---------+               +----------+
              v                                    v
  +---------------------+            +-------------------------+
  | generateDayAhead    |            | generateDayAhead        |
  | WithMl()            |            | WithSolcast()           |
  |                     |            |                         |
  | Spawns Python EXE   |            | Direct Solcast API call |
  | --generate-date     |            | Build rows from records |
  | forecast_engine.py  |            | No ML correction        |
  +-----+---------------+            +-------------------------+
        |
        v
  +-------------------------------+
  |  Python ML Engine             |
  |  run_dayahead()               |
  |                               |
  |  Step 1: Fetch weather        |
  |  Step 2: Load Solcast snap    |
  |  Step 3: Build 70 features    |
  |  Step 4: Predict ML residual  |
  |  Step 5: Error classifier     |
  |  Step 6: Bias correction      |
  |  Step 7: Combine & harden     |
  |  Step 8: Write forecast       |
  +-------------------------------+
```

---

## 3. Data Inputs

### 3.1 Weather Data
- **Source:** Open-Meteo API (forecast + archive)
- **Resolution:** Hourly, interpolated to 5-minute
- **Parameters:** GHI (rad), direct/diffuse radiation, cloud layers (low/mid/high), temperature, relative humidity, wind speed, precipitation, CAPE
- **Fallback chain:** Live forecast -> Saved weather snapshot -> Archive weather

### 3.2 Solcast Snapshot
- **Source:** Solcast Toolkit (web scraping) or Solcast API
- **Data:** Per-slot MW forecasts with P10 (lo), P50 (mid), P90 (hi) percentiles
- **Resolution:** 5-minute (aligned to 288 daily slots)
- **Storage:** `solcast_snapshots` table in SQLite (UPSERT on each pull)
- **Critical rule:** Tri-band P10/P90 is **only valid for day-ahead (future) slots**. Once the date passes, Solcast replaces forecasts with "estimated actuals" which do NOT have real confidence bands.

### 3.3 Historical Actuals
- **Source:** Inverter polling data (5-minute incremental kWh per node)
- **Loss adjustment:** Applied to match substation-metered totals
- **Used for:** ML training, error memory, reliability artifact, forecast QA

### 3.4 Plant Configuration
- **Inverter topology:** 27 inverters, 2-4 MPPT nodes each
- **Export limit:** Configurable MW cap (for curtailment detection)
- **Dependable capacity:** 8,195 kW (used for physics baseline reference)
- **Maximum capacity:** 21,816 kW (hard physical upper bound per slot)

---

## 4. Solcast Integration

### 4.1 Access Modes
| Mode | Method | Data Source |
|------|--------|-------------|
| **Toolkit** | Web scraping via headless browser | Solcast Toolkit portal (email/password) |
| **API** | REST API calls | Solcast API (API key + resource ID) |

### 4.2 Snapshot Building (`buildSolcastSnapshotRows`)
**File:** `server/index.js:9064`

Solcast returns records with variable-length periods (typically 30 min). The snapshot builder:

1. Parses each record's `period_end_utc` and duration
2. Extracts MW values: `pv_estimate` (mid), `pv_estimate10` (P10/lo), `pv_estimate90` (P90/hi)
3. Splits records into 5-minute slot buckets using overlap-weighted averaging
4. Converts MW to kWh: `kWh = MW * (5/60) * 1000`
5. Also captures estimated actuals (for past dates) in `est_actual_mw`

**Output per slot:**
| Field | Description |
|-------|-------------|
| `forecast_kwh` | P50 mid forecast in kWh |
| `forecast_lo_kwh` | P10 low forecast in kWh |
| `forecast_hi_kwh` | P90 high forecast in kWh |
| `forecast_mw` | P50 mid forecast in MW |
| `est_actual_kwh` | Estimated actual (past dates only) |

### 4.3 Snapshot Persistence (`bulkUpsertSolcastSnapshot`)
- **Table:** `solcast_snapshots`
- **Key:** `(forecast_day, slot)` — UPSERT replaces previous data
- **Metadata:** `pulled_ts` (timestamp of pull), `source` (toolkit/api)
- **Critical:** Each new pull **overwrites** the previous snapshot for the same day. Daily snapshots must be captured before the forecast date passes to preserve tri-band data.

### 4.4 Auto-Fetch Before Generation
**File:** `server/index.js:9901`

`autoFetchSolcastSnapshots(dates)` runs automatically before every ML generation:
1. Checks if Solcast is configured
2. Fetches forecast records from Solcast API/toolkit
3. Builds and persists snapshots for all target dates
4. Returns pull timestamp and count of persisted rows

---

## 5. Day-Ahead Generation Pipeline

### 5.1 Node Orchestrator (`runDayAheadGenerationPlan`)
**File:** `server/index.js:9638`

This is the **single entry point** for all forecast generation. Every trigger path routes through this function.

**Flow:**

```
1. Normalize and validate target dates
2. Determine preferred provider (from settings)
3. Build provider order:
   - If preferred = "solcast": try [solcast, ml_local]
   - If preferred = "ml_local" + Solcast configured: try [ml_local, solcast]
   - If preferred = "ml_local" no Solcast: try [ml_local]
4. For each provider in order:
   a. If "solcast": call generateDayAheadWithSolcast()
   b. If "ml_local": call generateDayAheadWithMl()
   c. On success: break
   d. On failure: try next provider
5. If all providers fail: write failed audit row
6. On success:
   a. Classify Solcast freshness per date
   b. Determine forecast variant
   c. Write success audit row per date
   d. Handle authoritative supersession
```

### 5.2 Forecast Variants
| Variant | Meaning |
|---------|---------|
| `solcast_direct` | Pure Solcast (no ML correction) |
| `ml_solcast_hybrid_fresh` | ML with fresh Solcast snapshot (<2h old, >95% coverage) |
| `ml_solcast_hybrid_stale` | ML with stale but usable Solcast snapshot |
| `ml_without_solcast` | ML without any Solcast input |
| `generation_failed` | All providers failed |

### 5.3 ML Generation Path (`generateDayAheadWithMl`)
**File:** `server/index.js:9935`

1. Auto-pulls fresh Solcast snapshots for target dates
2. Spawns Python subprocess: `ForecastCoreService.exe --generate-date YYYY-MM-DD`
3. Python runs `run_dayahead()` which produces the forecast
4. Node reads the written forecast data and proceeds with audit

### 5.4 Solcast Direct Path (`generateDayAheadWithSolcast`)
**File:** `server/index.js:9999`

1. Fetches records directly from Solcast API/toolkit
2. Builds day-ahead rows from raw Solcast data (P50 mid as forecast)
3. Writes rows to `forecast_day_ahead` table
4. Also persists snapshot for later reference
5. No ML correction — pure Solcast P50

---

## 6. Python ML Engine

### 6.1 `run_dayahead()` Pipeline
**File:** `services/forecast_engine.py:8720`

The core forecast generation function. Pipeline stages:

#### Stage 1: Weather
- Fetches weather for target day (forecast or archive)
- Falls back to saved weather snapshot if API unavailable
- Applies weather bias adjustment (calibration from historical weather errors)
- Interpolates hourly to 5-minute resolution
- Classifies day regime: `clear`, `mixed`, `overcast`, or `rainy`

#### Stage 2: Solcast Baseline (PHASE 4)
- Loads Solcast snapshot from database via `load_solcast_snapshot()`
- **Requires** valid Solcast snapshot — hard failure if missing
- Computes Solcast prior via `solcast_prior_from_snapshot()`:
  - Applies bias ratio correction (historical Solcast vs actual calibration)
  - Enforces P10 <= P50 <= P90 ordering
  - Computes per-slot blend weight (regime/season/coverage/reliability dependent)
  - Determines if "Solcast-primary mode" is active (high coverage + reliability)
- **Baseline = Solcast mid (P50)**, not physics
- Physics baseline computed only for diagnostic comparison

#### Stage 3: ML Residual Correction
- Builds 70-feature matrix from weather + Solcast data
- Loads trained model bundle (LightGBM or sklearn GBR)
- Predicts raw residual (error between baseline and expected actual)
- Applies weather-adaptive blending:
  - High cloud volatility / rain / convective -> lower ML trust
  - Dawn/dusk -> lower ML trust
  - Clear stable midday -> higher ML trust
- Applies Solcast residual damping (when Solcast is fresh, damp ML correction)
- Smooths with 3-slot rolling mean
- Clips extreme residuals to +-50% of slot capacity

#### Stage 4: Error Classifier
- Multi-class error classifier predicts error category per slot
- Error classes: `under_severe`, `under_moderate`, `neutral`, `over_moderate`, `over_severe`
- Per-slot bias correction based on predicted error class and historical error profiles
- Confidence-gated: low-confidence predictions are zeroed out
- Weather-bucket-aware: different corrections for clear/mixed/overcast/rainy slots

#### Stage 5: Bias Correction (Error Memory)
- Computes historical error memory: exponentially weighted average of recent forecast errors
- Applies `ERROR_ALPHA` scaling factor
- When Solcast is fresh (>95% coverage), damped by 70% to prevent over-correction
- When Solcast is usable (>80% coverage), damped by 50%

#### Stage 6: Combine
```python
forecast = baseline + ml_residual + error_class_term + bias_correction
```
Where:
- `baseline` = Solcast mid kWh per slot
- `ml_residual` = LightGBM predicted residual (weather-blended, Solcast-damped)
- `error_class_term` = Error classifier bias correction
- `bias_correction` = Error memory correction

#### Stage 7: Post-Processing (see Section 10)

---

## 7. Feature Engineering

### 7.1 Feature Matrix (70 features)
**File:** `services/forecast_engine.py:2300`

`build_features()` constructs a 288-row x 70-column feature matrix for each target day.

#### Weather Features (17)
| Feature | Description |
|---------|-------------|
| `rad` | Global Horizontal Irradiance (W/m2) |
| `rad_direct` | Direct Normal Irradiance |
| `rad_diffuse` | Diffuse Horizontal Irradiance |
| `rad_lag_1h` | GHI lagged 1 hour (12 slots) |
| `rad_lag_1slot` | GHI lagged 1 slot (5 min) — thermal lag |
| `rad_lag_2slots` | GHI lagged 2 slots (10 min) — thermal lag |
| `rad_grad_15m` | GHI gradient per 15 minutes |
| `cloud` | Total cloud cover (%) |
| `cloud_low` | Low cloud layer (%) |
| `cloud_mid` | Mid cloud layer (%) |
| `cloud_high` | High cloud layer (%) |
| `cloud_std_1h` | Cloud volatility (1-hour rolling std) |
| `cloud_grad_15m` | Cloud gradient per 15 minutes |
| `cloud_trans` | Cloud transmittance (derived) |
| `precip` | Precipitation (mm) |
| `precip_1h` | 1-hour rolling sum of precipitation |
| `cape` | Convective Available Potential Energy |

#### Derived Irradiance Physics (4)
| Feature | Description |
|---------|-------------|
| `csi` | Clear Sky Irradiance (theoretical max) |
| `kt` | Clearness Index (actual / clear-sky) |
| `dni_proxy` | Direct fraction of GHI |
| `cape_sqrt` | Square root of CAPE (non-linear convective) |

#### Atmospheric (7)
| Feature | Description |
|---------|-------------|
| `temp` | Temperature (C) |
| `temp_hot` | ReLU(temp - 30): high-temp penalty |
| `temp_delta` | Temperature deviation from 25C |
| `rh` | Relative Humidity (%) |
| `rh_sq` | RH squared (non-linear humidity effect) |
| `wind` | Wind speed (m/s) |
| `wind_sq` | Wind squared |

#### Solar Geometry (2)
| Feature | Description |
|---------|-------------|
| `cos_z` | Cosine of solar zenith angle |
| `air_mass` | Atmospheric air mass |

#### Time Context (11)
| Feature | Description |
|---------|-------------|
| `solar_prog` | Solar progression (0 at sunrise, 1 at sunset) |
| `solar_prog_sq` | Solar progression squared |
| `solar_prog_sin` | Solar progression sinusoidal (peaks at noon) |
| `tod_sin`, `tod_cos` | Time-of-day cyclic encoding |
| `slot_in_hour_sin`, `slot_in_hour_cos` | Within-hour cyclic encoding |
| `sunrise_rel`, `sunset_rel` | Relative distance from sunrise/sunset |
| `shoulder_flag` | Near-sunrise/sunset flag |
| `doy_sin`, `doy_cos` | Day-of-year cyclic encoding (seasonality) |

#### Day-Level Context (8)
| Feature | Description |
|---------|-------------|
| `day_cloud_mean` | Daily mean cloud cover |
| `day_vol_index` | Daily weather volatility index |
| `wet_season_flag` | Wet season indicator |
| `dry_season_flag` | Dry season indicator |
| `day_regime_clear` | One-hot: clear day |
| `day_regime_mixed` | One-hot: mixed day |
| `day_regime_overcast` | One-hot: overcast day |
| `day_regime_rainy` | One-hot: rainy day |

#### Solcast Features (13)
| Feature | Description |
|---------|-------------|
| `solcast_prior_kwh` | Solcast P50 forecast per slot (kWh) |
| `solcast_prior_mw` | Solcast P50 forecast per slot (MW) |
| `solcast_prior_spread` | Solcast confidence spread (P90-P10)/P50 |
| `solcast_prior_available` | Solcast data present flag per slot |
| `solcast_prior_blend` | Per-slot blend weight (0-1) |
| `solcast_prior_vs_physics` | Solcast / physics ratio |
| `solcast_prior_vs_irradiance` | Solcast / irradiance-scaled reference |
| `solcast_day_coverage` | Daily Solcast coverage ratio |
| `solcast_day_reliability` | Daily Solcast reliability score |
| `solcast_bias_ratio` | Historical actual/Solcast calibration |
| `solcast_resolution_weight` | Per-slot resolution-based trust |
| `solcast_resolution_support` | Resolution data support level |

#### Solcast Tri-Band Features (6) — NEW in v2.5.0+
| Feature | Description |
|---------|-------------|
| `solcast_lo_kwh` | Solcast P10 forecast per slot (kWh) |
| `solcast_hi_kwh` | Solcast P90 forecast per slot (kWh) |
| `solcast_lo_vs_physics` | P10 / physics ratio |
| `solcast_hi_vs_physics` | P90 / physics ratio |
| `solcast_spread_pct` | (P90 - P10) / P50 as percentage |
| `solcast_spread_ratio` | P90 / P10 ratio |

#### Plant Features (2)
| Feature | Description |
|---------|-------------|
| `expected_nodes` | Expected active inverter nodes based on clearness |
| `cap_kw` | Plant capacity in kW |

### 7.2 Legacy Model Compatibility
Models trained before tri-band features (62 features) auto-align with zero-spread fallback: the 6 tri-band features default to zero values, preserving backward compatibility.

---

## 8. ML Model Training

### 8.1 Training Pipeline (`train_model`)
**File:** `services/forecast_engine.py:7160`

Training runs daily (or on demand) and produces:
1. **Global residual model** — LightGBM GBR trained on all weather regimes
2. **Per-regime models** — Separate models for clear/mixed/overcast/rainy
3. **Error classifier** — Multi-class classifier for error categories
4. **Forecast artifacts** — Hour-shape profiles, activity patterns, block staging
5. **Weather bias artifact** — Calibration for weather forecast errors
6. **Solcast reliability artifact** — Multi-dimensional trust profile

### 8.2 Training Data Construction
For each historical day in the training window (~90 days):
1. Load loss-adjusted actual generation with inverter presence tracking
2. Load archived weather data
3. Load Solcast snapshot (if available for that day)
4. Build 70-feature matrix
5. Compute residual target: `actual_kwh - Solcast_baseline_kwh`
6. Exclude slots affected by:
   - Inverter outages (1000H alarm mask)
   - Export curtailment (cap-dispatch mask)
   - Insufficient data

### 8.3 Day Quality Filter
Days are rejected from training when:
- Capacity factor exceeds threshold (uses **maximum** capacity 21.8 MW, not dependable)
- Insufficient solar-hour data coverage
- Too many inverter outages
- Weather data gaps

### 8.4 LightGBM Hyperparameters
| Parameter | Value |
|-----------|-------|
| `n_estimators` | 650 |
| `learning_rate` | 0.040 |
| `max_depth` | 8 |
| `num_leaves` | 71 |
| `subsample` | 0.78 |
| `colsample_bytree` | 0.75 |
| `min_child_samples` | 22 |
| `reg_alpha` | 0.08 |
| `reg_lambda` | 0.12 |

### 8.5 ML Backend Detection
- **Preferred:** LightGBM (if available)
- **Fallback:** scikit-learn GradientBoostingRegressor (500 estimators, lr=0.025)
- Detected by `_detect_ml_backend()` and reported to FPM

---

## 9. Error Classifier & Bias Correction

### 9.1 Error Classifier
A secondary ML model that classifies each slot's expected error into 5 categories:

| Class | Meaning |
|-------|---------|
| `under_severe` | Forecast will significantly undershoot actual |
| `under_moderate` | Forecast will moderately undershoot |
| `neutral` | Forecast is approximately correct |
| `over_moderate` | Forecast will moderately overshoot |
| `over_severe` | Forecast will significantly overshoot |

**Process:**
1. Train per-regime classifiers on historical error categories
2. For each prediction slot, classify expected error
3. Look up historical error profiles for that class + weather bucket
4. Compute per-slot bias correction (kWh)
5. Apply confidence gating: zero out low-confidence corrections
6. Apply weather-bucket-aware blending
7. Clip to fraction of slot capacity

### 9.2 Error Memory (Bias Correction)
**File:** `services/forecast_engine.py:9067`

Exponentially weighted average of recent forecast errors:
```python
bias_correction = ERROR_ALPHA * error_memory
```

**Solcast freshness damping:**
| Solcast Coverage | Damping |
|-----------------|---------|
| >= 95% | Reduce bias by 70% |
| >= 80% | Reduce bias by 50% |
| < 80% | No damping |

**Rationale:** Historical error memory was built on runs that may not have had fresh Solcast input. Applying full bias correction when Solcast is fresh can drag the forecast below the reliable Solcast prior.

---

## 10. Post-Processing & Hardening

After combining baseline + residuals + corrections, the forecast goes through several hardening stages:

### 10.1 Hard Capacity Clamp
```python
forecast = np.clip(forecast, 0.0, cap_slot_max)
```
- `cap_slot_max` = 21,816 kW * (5/60) = ~1,818 kWh per 5-min slot
- Ensures no slot exceeds physical plant maximum

### 10.2 Hour-Shape Correction
- Matches forecast profile to historical hourly generation patterns
- **Skipped** when Solcast is the primary data source (shape preserved from Solcast)

### 10.3 Activity Hysteresis
- Adjusts sunrise/sunset timing based on historical inverter activity patterns
- Prevents premature ramp-up or delayed ramp-down

### 10.4 Block Staging
- Smooths transitions between generation blocks
- Enforces node-step quantization (each inverter node contributes discrete capacity)

### 10.5 Ramp Rate Limit
```python
max_step = 320 kWh per 5-min slot
```
- Prevents unrealistically steep ramps between consecutive slots
- Reflects physical inverter ramp-up/down limitations

### 10.6 Energy Sanity Check
```python
if forecast.sum() > max_kwh_day:
    forecast *= max_kwh_day / forecast.sum()
```
- Total daily energy cannot exceed `plant_capacity * solar_hours`

### 10.7 Solcast Per-Slot Floor
When Solcast is fresh (>95% coverage):
- Each slot cannot drop below `floor_ratio * Solcast_slot_kwh`
- Time-of-day modulated: reliability varies by morning/midday/afternoon
- Prevents ML from dragging individual slots far below the reliable Solcast prior

### 10.8 Solcast Per-Slot Ceiling (P90)
When Solcast data is available:
- Each slot cannot exceed the Solcast P90 (hi) value
- Prevents unrealistic overshoot beyond the 90th percentile confidence

### 10.9 Analog Ensemble (AnEn) Post-Correction
- Finds historically similar weather days (analog days)
- Computes actual/forecast ratio from analogs
- Applies multiplicative correction factor

---

## 11. Solcast Reliability Artifact

### 11.1 Multi-Dimensional Trust Profile
**File:** `services/forecast_engine.py:3680`

`build_solcast_reliability_artifact()` analyzes historical Solcast accuracy across multiple dimensions:

| Dimension | Keys | Purpose |
|-----------|------|---------|
| **Weather Regime** | `regimes` (clear/mixed/overcast/rainy) | Per-regime bias_ratio + reliability score |
| **Season** | `seasons` (dry/wet), `season_regimes` | Season-aware lookup |
| **Time-of-Day** | `time_of_day` (morning/midday/afternoon), `time_of_day_by_regime` | Per-zone blend modulation |
| **Trend** | `trend` (improving/stable/degrading) | Blend adjustment (+6-8% improving, -6-8% degrading) |

### 11.2 Building the Artifact
For each day in the lookback window (~90 days):
1. Load actual generation (loss-adjusted, with presence tracking)
2. Load Solcast snapshot for that day
3. Load day-ahead forecast for that day
4. Classify weather regime, season, and slot-level weather buckets
5. Exclude slots with inverter outages or curtailment
6. Compute per-slot accuracy metrics (bias ratio, MAPE)
7. Accumulate by regime, season, time-of-day, and bucket

### 11.3 How Reliability Affects the Forecast
The `solcast_prior_from_snapshot()` function uses the artifact to compute per-slot blend weights:

```python
blend = base_by_regime * reliability_score * (0.55 + 0.45 * coverage_ratio) * spread_weight * solar_weight
```

**Blend modifiers:**
- **Regime:** Clear=0.54, Mixed=0.50, Overcast=0.56, Rainy=0.44 base blend
- **Reliability:** 0-1 score from historical accuracy
- **Coverage:** How many slots have Solcast data
- **Spread:** Narrow P10-P90 spread = higher trust
- **Solar weight:** Higher at noon, lower at dawn/dusk
- **Weather bucket:** Per-slot modulation (clear_stable=1.12, rainy=0.65)
- **Resolution weight:** Based on historical resolution-level accuracy
- **Trend:** Improving +6-8%, degrading -6-8%

**Primary mode** activates when coverage >= threshold AND reliability >= threshold:
- Elevates base blend to >= 0.82
- Applies primary floor to prevent blend from dropping too low
- Suppressed if trend is "degrading"

---

## 12. Trigger Paths & Cron Schedule

### 12.1 All Generation Paths
| Path | Trigger | Provider Routing | Audit |
|------|---------|------------------|-------|
| **Manual UI** | `POST /api/forecast/generate` | Node orchestrator | Node |
| **Auto scheduler** | Python loop -> `_delegate_run_dayahead()` | Delegates to Node via HTTP | Node |
| **Python CLI** | `--generate-date` -> `_delegate_run_dayahead()` | Delegates to Node via HTTP | Node |
| **Python CLI fallback** | Node unreachable | Direct `run_dayahead(write_audit=True)` | Python |
| **Node cron** | Scheduled times (see below) | Node orchestrator | Node |

### 12.2 Cron Schedule
**File:** `server/index.js:15295`

| Time (Local) | Expression | Purpose |
|-------------|------------|---------|
| **04:30** | `30 4 * * *` | Early morning attempt — overnight Solcast data |
| **09:30** | `30 9 * * *` | Fresh morning Solcast with post-sunrise updates (before 10AM) |
| **18:30** | `30 18 * * *` | Evening catch-up after solar close |
| **20:00** | `0 20 * * *` | Late evening retry |
| **22:00** | `0 22 * * *` | Final safety net |

**Cron behavior:**
1. Skip if another cron run is active (mutual exclusion via `_forecastCronRunning`)
2. Skip if manual generation is in progress
3. Assess tomorrow's forecast quality via `assessTomorrowForecastQuality()`
4. If quality is `healthy`: skip (no regeneration needed)
5. Otherwise: trigger `runDayAheadGenerationPlan()` with `trigger: "node_fallback"`
6. 45-minute safety timeout auto-resets the running flag

### 12.3 Python Delegation
When Python CLI or auto scheduler wants to generate:
```python
_delegate_run_dayahead(target_date, trigger="auto_service")
```
- Calls `http://localhost:{ADSI_SERVER_PORT}/api/forecast/generate` (default port 3500)
- Node handles provider routing and audit
- If Node is unreachable, falls back to direct Python generation with `write_audit=True`

---

## 13. Forecast Quality Assessment

### 13.1 `assessTomorrowForecastQuality()`
**File:** `server/index.js:7338`

Evaluates if the current day-ahead forecast for tomorrow needs regeneration:

| Quality Class | Meaning | Action |
|--------------|---------|--------|
| `healthy` | Complete forecast, correct provider, fresh Solcast | Skip (no regen) |
| `missing` | No forecast rows exist | Regenerate |
| `incomplete` | Fewer slots than required | Regenerate |
| `wrong_provider` | Used different provider than configured | Regenerate |
| `stale_input` | Solcast snapshot is stale/missing | Regenerate |
| `weak_quality` | Run status is not "success" or variant is empty | Regenerate |
| `missing_audit` | Audit row not found | Regenerate |

### 13.2 Solcast Freshness Classification
**File:** `server/index.js:7301`

| Class | Criteria |
|-------|---------|
| `fresh` | Coverage >= 95%, age <= 2 hours |
| `stale_usable` | Coverage >= 80%, age <= 12 hours |
| `stale_reject` | Coverage < 80%, or age > 12 hours |
| `missing` | No snapshot or zero coverage |
| `not_expected` | Solcast not expected for this generation |

---

## 14. Audit Trail

### 14.1 `forecast_run_audit` Table
Every generation attempt (success or failure) writes a row with:

| Column | Description |
|--------|-------------|
| `target_date` | Forecast target day |
| `generated_ts` | Generation timestamp (ms) |
| `generator_mode` | Trigger: manual_api / auto_service / node_fallback / python_direct |
| `provider_used` | ml_local / solcast |
| `provider_expected` | Configured preferred provider |
| `forecast_variant` | solcast_direct / ml_solcast_hybrid_fresh / etc. |
| `weather_source` | forecast / snapshot / archive-fallback / solcast_direct |
| `solcast_snapshot_day` | Date of Solcast snapshot used |
| `solcast_snapshot_pulled_ts` | When snapshot was pulled |
| `solcast_snapshot_age_sec` | Snapshot age in seconds |
| `solcast_snapshot_coverage_ratio` | Fraction of solar slots with data |
| `solcast_freshness_class` | fresh / stale_usable / stale_reject / missing |
| `physics_total_kwh` | Physics baseline total (NULL in PHASE 4) |
| `hybrid_total_kwh` | Solcast mid baseline total (kWh) |
| `solcast_lo_total_kwh` | Solcast P10 total (kWh) — day-ahead only |
| `solcast_hi_total_kwh` | Solcast P90 total (kWh) — day-ahead only |
| `baseline_is_solcast_mid` | 1 = PHASE 4 architecture (Solcast baseline) |
| `final_forecast_total_kwh` | Final forecast total energy |
| `ml_residual_total_kwh` | ML residual correction total |
| `error_class_total_kwh` | Error classifier correction total |
| `bias_total_kwh` | Bias (error memory) correction total |
| `run_status` | success / failed / superseded |
| `is_authoritative_runtime` | 1 = this is the active forecast |
| `is_authoritative_learning` | 1 = use for ML training feedback |
| `notes_json` | JSON with generation details |

### 14.2 Authoritative Supersession
When a new forecast is generated for a date that already has one:
1. New row is marked `is_authoritative_runtime = 1`
2. Previous row is updated: `is_authoritative_runtime = 0`, `run_status = "superseded"`
3. `superseded_by_run_audit_id` links to the new row

### 14.3 Two Audit Writers
| Writer | File | When |
|--------|------|------|
| **Node** | `server/index.js:9789` | All generations through Node orchestrator |
| **Python** | `services/forecast_engine.py:8395` | Direct Python generation (Node unreachable fallback) |

Both write the same schema. Python writer includes enrichment notes (weather source breakdown, ML model routing, data warnings).

---

## 15. Forecast Performance Monitor (FPM)

### 15.1 Engine Health Endpoint
**File:** `server/index.js:14245`

`GET /api/forecast/engine-health` returns:

```json
{
  "ok": true,
  "trainState": {
    "consecutiveRejections": 0,
    "lastRejectionTs": null,
    "lastSuccessfulTrainTs": 1712100000000
  },
  "mlBackend": {
    "type": "lightgbm",
    "modelPath": "C:\\ProgramData\\InverterDashboard\\forecast\\model_bundle.joblib",
    "modelAgeHours": 12,
    "available": true
  },
  "trainingSummary": {
    "samplesUsed": 8500,
    "featuresUsed": 70,
    "regimesCount": 4,
    "lastTrainingDate": "2026-04-03",
    "trainingResult": "success"
  },
  "dataQualityFlags": [],
  "latestAudit": { ... },
  "recentQualityBreakdown": [ ... ],
  "sourceFreshness": {
    "solcastAgeHours": 5,
    "solcastPulledTs": 1712100000000,
    "weatherSource": "forecast",
    "lastActualsDate": "2026-04-02"
  },
  "recentBias": {
    "signedBiasPct": -2.3,
    "rowsUsed": 7
  },
  "outageSummary": null,
  "solcastBaseline": {
    "isActive": true,
    "baselineTotalKwh": 67715.54,
    "physicsTotalKwh": null,
    "solcastLoTotalKwh": 54093.17,
    "solcastHiTotalKwh": 135699.42,
    "forecastTotalKwh": 72500.00
  }
}
```

### 15.2 Data Quality Flags
**File:** `services/forecast_engine.py:6212`

| Flag | Meaning |
|------|---------|
| `insufficient_training_days` | Not enough historical days for ML training |
| `high_rejection_streak` | 3+ consecutive training rejections |
| `no_regime_data` | No weather regime models available |
| `lgbm_unavailable_fallback` | LightGBM not available, using sklearn fallback |
| `outage_days_detected` | Inverter outage days in training window |
| `solcast_snapshot_missing` | No Solcast snapshot exists for tomorrow |
| `solcast_triband_missing` | Solcast snapshot exists but P10/P90 data missing |

### 15.3 Frontend Display
**File:** `public/js/app.js`

The FPM panel shows:
- **ML Backend chip:** LightGBM vs sklearn, model age
- **Training chip:** Samples, features, regimes, result
- **Freshness chip:** Solcast age, weather source, last actuals
- **Bias chip:** Recent 7-day signed bias percentage
- **Solcast Baseline chip:** Forecast vs baseline MWh with P10-P90 tooltip
- **Data Quality flags:** Human-readable warnings

---

## 16. Snapshot Lifecycle & Tri-Band Constraints

### 16.1 Daily Snapshot Cycle

```
06:00  Solcast updates morning forecast
        |
09:30  CRON: auto-pull snapshot (fresh Solcast with post-sunrise data)
        |                            +--> P10/P50/P90 saved to solcast_snapshots
        |                            +--> ML generation uses this snapshot
        |
18:30  CRON: evening catch-up (if 09:30 was unhealthy)
        |
22:00  CRON: final safety net
        |
NEXT DAY:
        Solcast toolkit REPLACES forecast with "estimated actuals"
        --> P10/P90 tri-band data is LOST forever for that date
        --> Only the previously saved snapshot preserves real tri-band
```

### 16.2 Critical Rule: Tri-Band Temporal Validity

> **Solcast P10/P90 bands are ONLY valid for day-ahead (future) slots.**

Once a forecast date passes:
- Solcast toolkit replaces forecast data with "estimated actuals"
- The P10/P90 values for historical dates are **NOT** real confidence intervals
- There is **no way** to recover tri-band data retroactively
- The daily snapshot capture is the **ONLY** opportunity to preserve real P10/P90 bands

**Implications for audit data:**
- `solcast_lo_total_kwh` and `solcast_hi_total_kwh` are only populated for day-ahead generation runs
- Historical audit rows have these fields set to NULL
- Only future (day-ahead) generation runs should write tri-band totals

---

## 17. Confidence Bands

### 17.1 Band Construction
`confidence_bands()` generates P10 (lo) and P90 (hi) bands around the forecast:

Sources of band width:
1. **Weather uncertainty:** Higher clouds/rain -> wider bands
2. **Error classifier severity:** Higher severe probability -> wider bands
3. **Solcast P10/P90 spread:** Used to anchor bands to Solcast confidence
4. **Historical forecast error distribution**

### 17.2 Solcast P90 Ceiling
The final forecast is clamped per-slot to not exceed Solcast P90:
```python
forecast = min(forecast, solcast_hi_kwh)
```
This prevents overoptimistic forecasts beyond the 90th percentile confidence of the Solcast satellite model.

---

## 18. Sanity Checks & Safety Guards

### 18.1 Forecast Sanity Check (PHASE 4)
**File:** `services/forecast_engine.py:9321`

Validates forecast total against Solcast baseline:
```python
fc_ratio = forecast_total / solcast_baseline_total
```

| Ratio | Action |
|-------|--------|
| < 0.30 or > 2.50 | **SUPPRESS** — do not write forecast |
| < 0.50 or > 1.80 | **WARN** — unusual but within tolerance |
| 0.50 - 1.80 | Normal |

### 18.2 Confidence Band Ordering
```python
if lo > hi: hi = max(lo, hi)  # Clamp
```

### 18.3 Slot Capacity Guard
- Dependable cap: 8,195 kW * (5/60) = ~683 kWh per slot (for shaping reference)
- Maximum cap: 21,816 kW * (5/60) = ~1,818 kWh per slot (hard physical limit)

### 18.4 Ramp Rate Limit
- Maximum 320 kWh change between consecutive 5-min slots
- Prevents physically impossible generation spikes

### 18.5 NaN/Inf Guard
```python
if not np.all(np.isfinite(ml_residual)):
    ml_residual = np.zeros(SLOTS_DAY)  # Revert to zeros
```

---

## Appendix: File Reference

| File | Purpose |
|------|---------|
| `server/index.js` | Node.js orchestrator, API endpoints, cron, audit, Solcast API |
| `server/db.js` | SQLite schema, migrations, prepared statements |
| `services/forecast_engine.py` | Python ML engine (compiled to ForecastCoreService.exe) |
| `public/js/app.js` | Frontend dashboard including FPM panel |
| `C:\ProgramData\InverterDashboard\adsi.db` | Hot database (SQLite) |
| `C:\ProgramData\InverterDashboard\forecast\` | Model files, artifacts, train state |
