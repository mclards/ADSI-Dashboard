# Day-Ahead Forecast Hardening Plan

## Status

Implemented in core forecast generation for Phases `1-6`.

Current implementation status:

- done: stronger training-data hardening
- done: longer historical training / shaping window with recency-weighted sample weights
- done: explicit actual-weather + actual-generation training basis
- done: historical hour-preserving `5-minute` shape correction
- done: startup / shutdown hysteresis from learned activity windows
- done: conservative low-power node staging
- done: separate forecast-provider bias layer with persisted forecast-weather snapshots
- done: regime-aware residual model routing
- done: separate intraday rebias product

This document is an implementation plan for improving free day-ahead forecast precision when the primary weather feed is hourly, but the dashboard output must remain a `5-minute` series over the `05:00-18:00` operating window.

Implemented in:

- [forecast_engine.py](/d:/ADSI-Dashboard/services/forecast_engine.py)

## Goal

Improve day-ahead accuracy and operational realism without paid weather providers by hardening the existing physics + ML forecast stack with:

- better use of historical plant data
- learned intra-hour shape correction
- startup / shutdown hysteresis
- low-power block activation staging
- stronger validation and fallback behavior

## Primary Constraint

The current free weather path is hourly. A `5-minute` forecast derived from hourly weather cannot become truly high-frequency just by interpolation. The missing intra-hour cloud detail must be approximated from historical plant behavior, physics, and conservative operational rules.

## Current State

### Current Engine Behavior

The existing forecast service in `services/forecast_engine.py` already has a solid baseline:

- `fetch_weather(day)`
  - pulls hourly weather from Open-Meteo
- `interpolate_5min(df, day)`
  - upsamples hourly weather to `5-minute`
  - uses `pchip` for radiation columns
  - uses linear interpolation for non-radiation weather columns
- `physics_baseline(day, w5)`
  - produces a plant-constrained baseline forecast
- `train_model(today)`
  - trains a `GradientBoostingRegressor` residual model
- `run_dayahead(target_date, today)`
  - combines:
    - physics baseline
    - ML residual correction
    - rolling error-memory bias correction
    - hard capacity clipping
    - ramp limiting
    - confidence bands

### Existing Strengths

- Physics-first design already exists.
- ML is residual-only, not full black-box.
- The model already rejects bad training days through anomaly guards.
- The engine already uses recency weighting, uncertainty-aware ML blending, and QA logging.
- Output is already constrained to the solar window and plant capacity.

### Existing Weaknesses

- Hourly weather is still the limiting signal.
- `5-minute` weather after interpolation is smooth, but not truly informative.
- Sunrise behavior is still too weather-smooth and not inverter-aware enough.
- Low-power operation is still too continuous for a modular inverter plant.
- A single residual model across all sky regimes can blur correction behavior.
- A `14-day` training window is often too short for a stable free-weather setup.

### Important Training Principle

The forecast stack should distinguish clearly between:

- plant-response learning
- weather-provider forecast error

The plant-response model should learn from:

- actual generation for a historical day
- actual observed weather for that same historical day

It should not be trained primarily on the weather forecast that happened to be used when the historical day-ahead was generated.

Reason:

- training on forecast weather mixes two different problems into one:
  - how the plant responds to real weather
  - how wrong the weather provider was
- this makes the model harder to stabilize and less interpretable

The correct separation is:

- train core plant-response behavior on actual weather + actual generation
- use forecast weather only at inference time to drive the day-ahead output
- treat forecast-provider error as a separate optional correction layer only if forecast snapshots are stored

## Source References

Operational references gathered for this plan:

- [Inverter Parameters.pdf](/c:/Users/User/Downloads/Inverter%20Parameters.pdf)
  - `Starting Input Voltage VDC = 586`
  - `Stopping input Voltage VDC = 528`
  - `Starting Vin Time = 60 s`
  - `Stopping Vin Time = 5 s`
  - `Nominal Power (Watts) = 226730`
- [Inverter - Manual.pdf](/c:/Users/User/Desktop/ClardsFiles/ADSI/ADSI%20Inverters/Inverter%20Guides/Inverter%20-%20Manual.pdf)
  - `920TL M360` is a `4 power module` inverter family variant

Important interpretation:

- the inverter documentation provides startup voltage thresholds, not a clean published `minimum startup kW` threshold
- low-power startup must therefore be modeled as a combination of:
  - weather / irradiance
  - learned historical first-active-slot behavior
  - inverter startup hysteresis
  - block activation staging

## Problem Analysis

### What Interpolation Can and Cannot Do

Interpolation can:

- smooth hourly weather into a continuous `5-minute` curve
- remove ugly step changes
- produce weather features that are easier for the current model to use

Interpolation cannot:

- invent real intra-hour cloud movements
- infer sudden irradiance collapses or recoveries
- reproduce actual dawn wake-up delays reliably
- reproduce staged block pickup behavior at low power

### Why Historical Learning Matters More

The plant itself already contains the missing information that the hourly weather feed lacks:

- how fast the site ramps inside each hour
- how the dawn pickup behaves by month and cloud regime
- how low-power periods behave when some power blocks are active and others are not
- how humid, hazy, rainy, and convective mornings distort the clear-sky expectation

This is the main free signal worth exploiting harder.

### Why Actual Weather Must Be the Training Basis

If the model is trained on historical forecast weather instead of historical actual weather, it learns a blurred combination of:

- weather forecast error
- plant response
- dispatch or outage side effects

That usually degrades precision.

The cleaner approach is:

- use actual archived weather for historical training
- learn the mapping from actual weather to actual `energy_5min`
- at day-ahead runtime, feed forecast weather through that learned plant-response model

This keeps the main model focused on the plant itself.

If forecast-provider bias correction is desired later, that should be built as a separate layer that compares:

- stored forecast-weather snapshot for day `D`
- actual observed weather for day `D`

That comparison is only possible if forecast snapshots are deliberately persisted.

## Non-Goals

Out of scope for this hardening plan:

- paid forecast providers
- replacing the forecast stack with a fully black-box ML model
- changing the user-facing day-ahead UI before forecast quality improves
- introducing remote-mode forecast generation
- changing the `05:00-18:00` solar window definition

## Key Design Decisions

1. Keep the current physics-first architecture.
2. Keep the existing free weather path as the backbone.
3. Do not assume sub-hourly weather detail exists if it does not.
4. Learn intra-hour `5-minute` behavior from plant history, not from interpolation alone.
5. Treat startup/shutdown and low-power block pickup as explicit operational logic, not as a side effect of smoothing.
6. Keep every new ML layer bounded by physical and operational constraints.
7. Roll out behind backtesting and side-by-side comparison first.
8. Train the core plant-response model on actual weather and actual generation, not on historical forecast-weather inputs.
9. Keep forecast-provider bias modeling separate from plant-response modeling.

## Proposed Architecture

### Baseline to Preserve

Keep the current chain:

```text
Hourly weather
  -> 5-minute interpolated weather features
  -> physics baseline
  -> ML residual correction
  -> error-memory bias correction
  -> hard caps / ramp limits / confidence bands
```

### New Layers to Add

Add the following hardening layers around the current baseline:

```text
Hourly weather
  -> 5-minute feature interpolation
  -> physics baseline
  -> residual ML
  -> hourly energy preservation / shape correction
  -> startup / shutdown hysteresis
  -> block activation staging
  -> final physical constraints
```

The important shift is this:

- interpolation remains only a feature-construction tool
- plant history becomes the main driver for intra-hour shape realism
- actual weather remains the preferred training basis for core ML

### Training vs Inference Separation

The hardened design should separate these paths explicitly:

```text
Historical training path
  actual archived weather
  + actual energy_5min
  -> physics baseline
  -> residual / shape / startup learning

Day-ahead inference path
  forecast weather
  -> interpolated 5-minute features
  -> trained plant-response model
  -> operational hardening layers
```

Optional later path:

```text
Forecast-bias correction path
  stored forecast weather snapshot
  vs actual archived weather
  -> provider-bias model
```

That last path should not be merged into the first hardening phase unless forecast snapshots are persisted first.

## Proposed Workstreams

### 1. Training Data Hardening

#### Objective

Improve the quality and breadth of the historical data used by residual ML.

#### Proposed Changes

- extend training horizon from `14` days to a configurable range such as `45-90` days
- keep recency weighting so recent behavior still dominates
- make the training data contract explicit:
  - historical inputs should come from actual archived weather, not historical forecast weather
  - historical targets should come from actual `energy_5min`
- improve rejection of poor training days:
  - missing weather data
  - missing `energy_5min`
  - outage days
  - maintenance days
  - curtailed days
  - impossible capacity factor
  - inconsistent radiation-generation correlation
  - flatlined or obviously corrupt sensor sequences
- normalize targets and diagnostics by effective available plant capacity

#### Why It Matters

With hourly weather, the free path depends heavily on stable residual learning. Bad labels corrupt the residual model quickly. Better training-day hygiene is a high-return, low-risk change.

#### Current Repo Alignment

The current engine already moves in the right direction:

- `fetch_weather(day)` uses archive weather for past days
- `collect_training_data(today)` pairs that historical weather with actual plant output

This should be preserved and made more explicit in the hardened design.

### 2. Historical Intra-Hour Shape Library

#### Objective

Replace naive smooth intra-hour shape assumptions with historical plant-informed `5-minute` shapes.

#### Core Idea

For each forecast hour:

- preserve the hour-level energy target
- redistribute that hour into `12` five-minute slots using a historical shape profile selected from similar conditions

#### Similarity Inputs

Candidate similarity keys:

- sky regime
  - clear
  - partly cloudy
  - overcast
  - rainy / convective
- month or seasonal bucket
- solar hour bucket
- cloud volatility
- humidity band
- recent ramp tendency

#### Output Rule

The selected profile must:

- sum to `1.0` within the hour
- preserve the forecast hour total exactly
- be clipped to zero outside the solar window

#### Fallback

If there are not enough historical matches, fall back to the current interpolated shape.

#### Why It Matters

This is the best free replacement for missing sub-hourly weather detail.

### 3. Startup / Shutdown Hysteresis

#### Objective

Make dawn and dusk behavior operationally realistic instead of weather-smooth.

#### Reference Inputs

From [Inverter Parameters.pdf](/c:/Users/User/Downloads/Inverter%20Parameters.pdf):

- `Starting Input Voltage VDC = 586`
- `Stopping input Voltage VDC = 528`
- `Starting Vin Time = 60 s`
- `Stopping Vin Time = 5 s`

#### Proposed Modeling Approach

Because the forecast engine does not have a true future DC voltage forecast, approximate startup behavior using:

- irradiance and solar geometry
- historical first-active-slot timing
- cloud regime
- temperature / humidity
- previous observed morning patterns

#### Output Rule

- keep forecast zero before the estimated first active slot
- prevent tiny nonzero values from appearing too early
- hold low-power output through brief instability rather than toggling slot-by-slot

#### Why It Matters

Dawn error is one of the most visible failures when `5-minute` curves are derived from hourly weather alone.

### 4. Block Activation Staging

#### Objective

Represent the plant as a modular inverter instead of a single smooth analog source at low power.

#### Reference Inputs

- `920TL` family uses `4` power modules
- parameter sheet shows nominal per-node power around `226.73 kW`

#### Proposed Modeling Approach

Add a low-power staging layer that estimates active block count:

- `0`
- `1`
- `2`
- `3`
- `4`

Use historical data to estimate pickup/drop behavior and hysteresis, not just equal quarter splits.

#### Output Rule

- keep low-power periods from looking unrealistically smooth
- allow staged pickup and drop-off
- still pass through ramp limits and hard plant caps afterward

#### Why It Matters

Low irradiance is exactly where hourly weather is weakest and plant modularity matters most.

### 5. Residual ML Hardening

#### Objective

Make the current residual ML more stable and more context-aware.

#### Proposed Changes

- keep residual learning instead of moving to direct full-output prediction
- preserve the distinction between:
  - core residual learning from actual weather + actual generation
  - any future forecast-bias correction layer
- consider regime-aware training:
  - single global model plus regime feature enrichment, or
  - separate residual models per sky regime
- add features that better encode local behavior:
  - sunrise-relative slot
  - month / season bucket
  - recent morning error statistics
  - cloud volatility summary
  - similar-day archetype id or distance
  - expected active block count
- keep robust losses and conservative clipping

#### Important Constraint

Do not let ML bypass:

- solar window clipping
- capacity guardrails
- startup hysteresis
- block staging
- ramp-rate limits

Do not mix forecast-provider error into the core residual target unless that is a deliberate second-stage model.

### 5A. Optional Forecast-Bias Layer

#### Objective

Model systematic weather-provider error separately from plant-response behavior.

#### Requirement

Persist day-ahead forecast-weather snapshots for later comparison against actual archived weather.

#### Proposed Inputs

- forecast weather that was used for generation
- actual archived weather for the same day
- day / season / sky regime metadata

#### Proposed Output

- conservative bias adjustment factors for:
  - radiation
  - cloud regime confidence
  - morning ramp expectation

#### Important Note

This is explicitly optional and should come after the core plant-response hardening. Without forecast snapshot storage, it cannot be done correctly.

### 6. Intraday Re-Bias Layer

#### Objective

Improve the remaining curve after the first real plant data arrives.

#### Scope

Treat this as a second-stage enhancement, not the first hardening task.

#### Proposed Behavior

- once actual `energy_5min` exists for the day
- compare actual vs predicted for the early morning slots
- rebias the remaining slots conservatively

#### Product Separation

Keep the concepts separate:

- `day-ahead`: frozen forecast basis
- `intraday-adjusted`: corrected operational forecast

This avoids contaminating reporting and QA comparisons.

## Rejected Alternatives

### Akima-Only Upgrade

Rejected as a primary solution.

Reason:

- it improves smoothness
- it does not materially solve missing sub-hourly weather information

### Pure Black-Box ML

Rejected.

Reason:

- too risky for edge cases
- harder to debug
- more likely to violate physical constraints

### Flat Hour Splitting

Rejected.

Reason:

- easy to implement
- produces operationally unrealistic `5-minute` curves

## Proposed File-Level Changes

### Primary File

- `services/forecast_engine.py`

### Likely New Helpers

Add helper families such as:

- `build_shape_library(...)`
- `save_shape_library(...)`
- `load_shape_library(...)`
- `classify_sky_regime(...)`
- `select_shape_profile(...)`
- `apply_hour_shape_correction(...)`
- `estimate_first_active_slot(...)`
- `estimate_last_active_slot(...)`
- `estimate_active_block_count(...)`
- `apply_block_staging(...)`
- `backtest_forecast_variant(...)`

### Optional Persistent Artifacts

If needed, persist derived training artifacts under `C:\ProgramData\InverterDashboard\forecast`:

- shape library artifact
- metadata / QA summary
- backtest comparison report

### Secondary Files

Later, only if needed:

- `server/index.js`
  - expose forecast QA or model-basis metadata
- `public/js/app.js`
  - optionally show forecast basis / quality note in analytics

## Implementation Order

### Phase 1

- training data hardening
- longer training window
- stronger anomaly rejection
- explicit enforcement of actual-weather / actual-generation training basis

Status:
implemented in the current forecast engine

### Phase 2

- historical shape library
- hour-preserving `5-minute` redistribution
- fallback to current interpolation

Status:
implemented in the current forecast engine

### Phase 3

- startup / shutdown hysteresis
- learned first-active-slot logic

Status:
implemented in the current forecast engine

### Phase 4

- block activation staging
- low-power modular behavior

Status:
implemented in the current forecast engine

### Phase 5

- residual ML hardening
- regime-aware training
- richer feature set

Status:
implemented in the current forecast engine

Implemented now:

- richer temporal / shoulder-period features
- recency-weighted sample weighting instead of row duplication
- explicit separate regime models with conservative blending against the global residual model
- richer day-regime and seasonal feature enrichment

### Phase 6

- intraday rebias as a separate operational forecast layer

Status:
implemented in the current forecast engine

## Validation Plan

### Backtesting

Use walk-forward validation on recent historical days:

- train using only data available before the forecast day
- generate the full `05:00-18:00` forecast
- compare against actual `energy_5min`

### Metrics

Track at least:

- total-day energy error
- `5-minute` MAE
- `5-minute` RMSE
- morning first-active-slot error
- peak timing error
- peak magnitude error
- error by sky regime
- error by solar hour bucket

Track separately when possible:

- plant-response model quality against actual weather inputs
- day-ahead runtime quality against forecast weather inputs

This separation will make it easier to tell whether misses come from:

- plant modeling
- weather forecast quality
- startup / block logic

### Success Criteria

The hardened variant should beat the current baseline on:

- intra-hour realism
- dawn behavior
- low-power modular behavior
- median `5-minute` error

without increasing:

- impossible peaks
- false pre-sunrise generation
- noisy slot-to-slot oscillation
- catastrophic cloudy-day misses

## Risks

- Overfitting if the historical window is extended without stronger filtering.
- Poor startup-slot estimation if weather proxies do not correlate well with real DC voltage.
- Block staging can become too discrete if thresholds are too aggressive.
- Similar-day shape transfer can smear fast storm transitions if the match logic is weak.
- More moving parts mean more QA burden before rollout.

## Rollout Strategy

1. Backtest-only mode first.
2. Log current vs hardened forecast side by side for several days.
3. Enable for manual generation only.
4. Enable for scheduled generation after observed improvement.
5. Optionally expose forecast basis / quality notes in analytics after the model is trusted.

## Recommendation

The highest-return free implementation order is:

1. stronger training data hygiene
2. historical intra-hour shape correction
3. startup hysteresis
4. block activation staging

This should improve forecast realism more than changing interpolation method alone.

One rule should remain explicit throughout implementation:

- core ML learns from actual weather and actual generation
- forecast weather is used to drive inference, not to define the core historical truth set
