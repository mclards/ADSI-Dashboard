# Solcast Toolkit Day-Ahead and ML Plan

## Status

Partially implemented as of `v2.4.1`.

Already in place:

- done: authenticated Solcast toolkit fetch in `server/index.js`
- done: direct Solcast-backed day-ahead write path in `generateDayAheadWithSolcast(...)`
- done: toolkit preview chart and XLSX export over the `05:00-18:00` window
- done: raw `PT5M` `MW` values exposed in preview payload, chart hover, and export
- done: `solcast_snapshots` table in `server/db.js` with `PRIMARY KEY (forecast_day, slot)` and `idx_ss_day` index
- done: `bulkUpsertSolcastSnapshot` transaction and `getSolcastSnapshotForDay` read helper exported from `server/db.js`
- done: `buildSolcastSnapshotRows(day, records, estActuals, cfg)` and `persistSolcastSnapshot(day, rows, source, pulledTs)` in `server/index.js`
- done: snapshot persisted on Solcast test, preview, and day-ahead generation; `estActuals` stored where available (toolkit mode); null for API mode

Still pending:

- pending: Phase 2 — refactor direct Solcast generation to read from persisted snapshot first; apply inverter startup/shutdown gating and low-power staging; store provenance linking day-ahead row to snapshot version
- pending: Phase 3 — add `solcast_snapshots` DB reader to `services/forecast_engine.py`; expose slot arrays without requiring Solcast credentials in Python
- pending: Phase 4 — `solcast_prior_from_snapshot` and `blend_physics_with_solcast` hybrid baseline in `services/forecast_engine.py`
- pending: Phase 5 — retrain residual ML against hybrid baseline with Solcast feature columns
- pending: Phase 6 — Solcast-specific bias and reliability artifact in `services/forecast_engine.py`
- pending: Phase 7 — production routing (`ml_local` with usable snapshot → hybrid path; fallback to current `ml_local`); log which path was used

Related note:

- completed elsewhere: the Solcast preview/export resolution selector work (`PT5M` / `PT10M` / `PT15M` / `PT30M` / `PT60M` plus export format selection) is already implemented and no longer needs a separate plan file
- completed elsewhere: current-day `Actual MWh` display and export actual totals now use the unified Node current-day snapshot backed by PAC-integrated day energy, so Solcast comparisons are measured against the same live authoritative actuals used in the dashboard
- completed elsewhere: alarm audio now ignores sub-5-second alarm blips and same-node active alarm expansions do not retrigger sound, which reduces nuisance noise during live Solcast/actual comparison work
- completed elsewhere: the forecast engine now honors app restart/update soft-stop requests through the shared service-stop-file contract, so local restart/install flows no longer depend only on hard-killing forecast work mid-run
- completed elsewhere: inverter-card UI polish now keeps the live `Pdc` / `Pac` summaries compact, readable, and above the row table, while PAC legend colors stay fixed across themes during live forecast-versus-actual review

This plan defines how the Solcast toolkit feed should improve:

- the operational day-ahead forecast written to `forecast_dayahead`
- the local ML forecast engine quality over time

The main goal is not to replace plant knowledge with a third-party feed. The main goal is to use Solcast's high-resolution `PT5M` site forecast as a strong external prior while keeping plant actual generation as the truth source.

## Goal

Improve day-ahead accuracy, especially intra-hour shape accuracy, by using the Solcast toolkit `PT5M` series to:

- reduce the weakness of hourly-weather interpolation
- give the forecast stack a real `5-minute` prior instead of a synthetic one
- preserve plant-specific startup, shutdown, and low-power behavior
- improve ML residual correction with better high-resolution forecast context

The target output remains:

- `05:00-18:00`
- `5-minute` slots
- stored in the existing dashboard forecast tables and context

## Why Solcast Helps

The current `ml_local` stack is already hardened, but it still starts from hourly weather and then interpolates to `5-minute` resolution. That means:

- the day shape is physically plausible
- the plant behavior is constrained
- but intra-hour cloud detail is still inferred, not observed from the forecast provider

The Solcast toolkit feed improves the forecast problem because it already gives:

- site-level `PT5M` forecast values
- `P10 / P50 / P90` forecast band information
- recent estimated actual series for comparison and diagnostics

This is valuable because the dashboard's day-ahead requirement is also `PT5M`.

Important limitation:

- Solcast toolkit values are still forecast/provider data
- they are not the same thing as plant meter truth
- `estActuals` must not replace plant `energy_5min` or hot data as ML labels

## Current Repo State

Current relevant implementation:

- `server/index.js`
  - fetches Solcast toolkit or API records
  - previews them
  - converts them into day-ahead rows
  - writes direct Solcast output into `forecast_dayahead`
- `services/forecast_engine.py`
  - runs the current hardened `ml_local` stack
  - does not currently consume persisted Solcast snapshots as a training or inference input

Current generation options:

- `ml_local`
  - Open-Meteo-driven local physics + ML stack
- `solcast`
  - direct provider write path without plant-specific ML correction

This means the repo already has:

- a direct Solcast provider path
- a strong local ML path

What it still lacks is the hybrid path that uses Solcast to improve the local ML system instead of treating them as separate alternatives.

## Core Principles

1. Plant actual generation remains the supervised truth.
2. Solcast forecast is a high-resolution prior, not ground truth.
3. `estActuals` are auxiliary diagnostics only, not primary training labels.
4. The Node server remains the only Solcast login/parser client.
5. The Python forecast engine should consume normalized Solcast snapshots from local storage or DB, not log in to Solcast directly.
6. The `05:00-18:00` operating window remains enforced.
7. Inverter startup/shutdown hysteresis and low-power staging still apply on top of Solcast.
8. The system must fall back cleanly to the current `ml_local` path if Solcast is unavailable or stale.

## Data Semantics

For toolkit mode, the Solcast chart feed is treated as power.

Normalization rules:

- raw provider series: `MW`
- per-slot energy:
  - `MWh_5m = MW * (5 / 60)`
  - `kWh_5m = MW * 1000 * (5 / 60)`

Normalized fields that matter for the dashboard:

- `forecast_mw`
- `forecast_lo_mw`
- `forecast_hi_mw`
- `est_actual_mw`
- `forecast_kwh`
- `forecast_lo_kwh`
- `forecast_hi_kwh`
- `est_actual_kwh`

Time rules:

- convert by configured local timezone
- keep only local slots inside `05:00-18:00`
- preserve the original provider `period_end` for traceability

## What Solcast Should Improve

### 1. Direct Day-Ahead Shape

Solcast should improve:

- intra-hour ramps
- cloud-driven `5-minute` curvature
- shoulder-period transitions
- uncertainty-aware confidence handling

This is the immediate accuracy gain because the feed already aligns with the dashboard's `PT5M` target.

### 2. ML Baseline Quality

Solcast should improve the local ML stack by giving it a stronger forecast prior than interpolated hourly weather alone.

That should improve:

- slot-level residual error
- sunrise timing
- late-afternoon decay shape
- shoulder-hour bias
- daily total consistency when weather is variable

### 3. Bias Learning

With stored Solcast snapshots, the system can learn:

- when Solcast tends to over-forecast this site
- when it under-forecasts low cloud / haze / unstable mornings
- how forecast band width relates to real site error

## What Solcast Must Not Do

Solcast must not:

- replace plant actuals as ML training labels
- bypass inverter-aware startup and shutdown logic
- write unrestricted rows outside `05:00-18:00`
- silently overwrite the current ML path without side-by-side validation

`estActuals` specifically must not be used as the training target except in an explicitly flagged fallback analysis workflow, and even then not for the main production model.

## Proposed Architecture

### Layer 1: Snapshot Ingestion

The first missing piece is persistence.

Current state:

- Solcast preview and direct generation fetch records live
- the fetched `PT5M` series is not yet stored as a reusable normalized history set for ML

Plan:

- on each Solcast generation or explicit preview refresh, normalize the toolkit records and persist them locally
- store both raw `MW` and derived slot `kWh`
- stamp each snapshot with:
  - `forecast_day`
  - `pulled_ts`
  - `access_mode`
  - `source_url`
  - `timezone`
  - `period`
  - `provider_units`

Recommended storage shape:

- a dedicated main-DB table for current/hot normalized Solcast snapshots
- monthly archive copy for older history if needed

Recommended table purpose:

- one row per `day + slot`
- immutable snapshot provenance for later backtesting and ML training

Suggested normalized table fields:

- `forecast_day`
- `slot`
- `ts_local`
- `period_end_utc`
- `period`
- `forecast_mw`
- `forecast_lo_mw`
- `forecast_hi_mw`
- `est_actual_mw`
- `forecast_kwh`
- `forecast_lo_kwh`
- `forecast_hi_kwh`
- `est_actual_kwh`
- `pulled_ts`
- `source`
- `updated_ts`

Important rule:

- do not require the Python forecast EXE to know Solcast credentials
- let `server/index.js` fetch and normalize
- let `services/forecast_engine.py` only read the normalized snapshot

That avoids duplicated login parsing logic across Node and Python.

### Layer 2: Direct Solcast Provider Hardening

The current direct Solcast provider already writes `forecast_dayahead`.

It should be hardened to:

- use persisted normalized snapshot rows instead of one-off live conversion only
- apply inverter-aware startup gating
- apply learned end-of-day activity gating
- apply low-power node staging at the final output layer
- preserve uncertainty metadata from `P10 / P90`

Recommended direct Solcast runtime chain:

```text
Solcast toolkit PT5M snapshot
  -> local timezone normalization
  -> 05:00-18:00 window clamp
  -> inverter startup / shutdown gating
  -> low-power node staging
  -> final slot kWh write
```

This makes the direct Solcast provider operationally safer even before the ML hybrid path is complete.

### Layer 3: Hybrid Baseline for `ml_local`

This is the main accuracy target.

Instead of choosing between:

- `ml_local`
- `solcast`

the improved path should be:

- `ml_local` uses Solcast as an additional high-resolution prior when available

Recommended hybrid structure:

```text
Open-Meteo hourly weather
  -> current local physics baseline
Solcast PT5M snapshot
  -> normalized slot prior
physics + Solcast
  -> hybrid baseline
hybrid baseline + residual ML
  -> final forecast
```

Recommended baseline composition:

- `physics_baseline`
  - preserves plant and weather consistency
- `solcast_prior`
  - adds real `PT5M` provider shape
- `hybrid_baseline`
  - weighted blend of the two

Suggested blend behavior:

- higher Solcast weight during stable active hours
- lower Solcast weight:
  - near sunrise
  - near shutdown
  - when forecast band spread is wide
  - when Solcast is stale or partially missing
  - when local physics and Solcast disagree beyond a safety threshold

This avoids over-trusting Solcast exactly where plant-specific operational behavior matters most.

### Layer 4: Residual ML on Top of the Hybrid Baseline

The residual target should evolve from:

- `actual - physics_baseline`

to:

- `actual - hybrid_baseline`

This lets the model focus on what neither physics nor Solcast already explains.

Recommended feature families:

- existing weather features from `forecast_engine.py`
- calendar and solar-geometry features
- Solcast slot features:
  - `forecast_kwh`
  - `forecast_lo_kwh`
  - `forecast_hi_kwh`
  - band width
  - local ramp over `5/10/15` minutes
  - daily cumulative forecast progress
- disagreement features:
  - `solcast - physics`
  - `|solcast - physics|`
  - relative disagreement ratio
- operational regime flags:
  - dawn shoulder
  - midday
  - dusk shoulder
  - rainy / convective / overcast

Recommended target:

- production target remains plant `energy_5min`
- residual target is relative to the hybrid baseline

Important rule:

- do not train the main production model against Solcast `estActuals`
- if `estActuals` are retained at all, use them only for provider QA, data completeness checks, or an explicitly separate experimental model

### Layer 5: Solcast-Specific Bias Artifact

The current system already has a weather-bias artifact for forecast weather.

Add a separate Solcast bias artifact that learns:

- site-specific systematic bias by month
- bias by shoulder vs midday periods
- bias by regime
- confidence-band spread vs actual error relationship

Inputs for this artifact:

- stored Solcast snapshot for day `D`
- actual plant `energy_5min` for day `D`

Outputs:

- slot-level additive or multiplicative correction bounds
- reliability score for the Solcast prior
- dynamic weight adjustment for the hybrid baseline

Recommended examples:

- if Solcast routinely starts too early under low-radiation mornings, reduce dawn weight
- if wide `P90-P10` spread correlates with poor site accuracy, downweight Solcast in those periods
- if a certain month has repeat over-forecast bias in hazy mornings, shift the baseline down before residual ML

### Layer 6: Intraday Product Separation

The current repo already has a separate intraday-adjusted product.

Solcast should help here too, but without changing the meaning of day-ahead:

- day-ahead remains the frozen forecast product
- intraday-adjusted remains the live corrected product

Recommended Solcast role:

- day-ahead uses the frozen Solcast snapshot captured at generation time
- intraday-adjusted may use a newer Solcast pull only if the product is explicitly marked as intraday-adjusted

This keeps product semantics clean.

## How This Helps ML Specifically

The main ML gain is not "train on Solcast instead of weather."

The real ML gain is:

- better baseline
- better high-resolution exogenous features
- clearer bias signals
- better regime detection from provider spread and ramp shape

Expected ML improvements:

- less burden on the residual model to invent intra-hour shape
- more stable dawn and dusk correction
- smaller extreme residuals in variable cloud periods
- better generalization on days where hourly interpolation is too smooth

The model should become more efficient because it is correcting a smarter baseline instead of compensating for missing `5-minute` structure.

## Detailed Implementation Plan

### Phase 1: Persist Normalized Solcast Snapshots

Files:

- `server/db.js`
- `server/index.js`

Work:

- add normalized Solcast snapshot table(s)
- add retention and archive policy
- persist snapshots whenever:
  - Solcast test succeeds
  - preview refresh succeeds
  - Solcast day-ahead generation runs
- keep immutable provenance metadata for backtesting

Acceptance:

- any generated Solcast-backed day can later be reconstructed exactly
- snapshot history exists for ML training days

### Phase 2: Use Snapshot Storage for Direct Solcast Generation

Files:

- `server/index.js`

Work:

- refactor direct Solcast generation to read the normalized snapshot first
- apply:
  - `05:00-18:00` clamp
  - startup/shutdown gating
  - low-power staging
- store provenance that the written day-ahead came from Solcast snapshot version `X`

Acceptance:

- direct Solcast forecast is reproducible from stored data
- day-ahead output no longer depends on one transient fetch only

### Phase 3: Add Solcast Snapshot Reader to Forecast Engine

Files:

- `services/forecast_engine.py`

Work:

- add DB read helpers for normalized Solcast snapshot rows
- load the Solcast snapshot for the target day if present
- normalize to the engine's `288-slot` indexing model
- expose slot arrays for:
  - forecast center
  - low/high band
  - optional estActuals for diagnostics only

Acceptance:

- the Python forecast engine can read Solcast snapshot data without handling credentials

### Phase 4: Build Hybrid Baseline

Files:

- `services/forecast_engine.py`

Work:

- create `solcast_prior_from_snapshot(...)`
- create `blend_physics_with_solcast(...)`
- add weight rules based on:
  - slot time
  - shoulder-period status
  - band spread
  - missingness
  - disagreement with physics baseline
- feed the result into the existing constrained post-processing chain

Acceptance:

- hybrid baseline can be logged and compared side-by-side against:
  - current physics baseline
  - direct Solcast baseline

### Phase 5: Retrain Residual ML Around Hybrid Baseline

Files:

- `services/forecast_engine.py`

Work:

- train residual target against the hybrid baseline
- add Solcast feature columns
- keep existing regime-aware routing
- require both:
  - good plant actual day
  - matching Solcast snapshot availability

Acceptance:

- training days with Solcast snapshots can produce a separate hybrid model bundle
- fallback to current model remains available when snapshot coverage is insufficient

### Phase 6: Add Solcast Reliability / Bias Artifact

Files:

- `services/forecast_engine.py`

Work:

- compare stored Solcast prior vs actual plant generation on historical days
- compute:
  - per-regime bias
  - spread-vs-error reliability
  - dawn and dusk timing bias
- save an artifact similar in spirit to the current weather-bias artifact

Acceptance:

- runtime can downweight or correct Solcast when historical confidence is poor

### Phase 7: Production Routing and Fallback

Files:

- `server/index.js`
- `services/forecast_engine.py`

Work:

- keep current provider setting semantics simple
- recommended routing:
  - `ml_local` with usable Solcast snapshot -> hybrid ML path
  - `ml_local` without usable Solcast snapshot -> current ML path
  - `solcast` provider -> direct Solcast path with operational gating
- log which path was used for every generation

Acceptance:

- no silent provider confusion
- no hard failure if Solcast is missing or stale

## Validation Plan

Validation must be side-by-side and data-driven.

Compare these products over rolling historical days:

1. current `ml_local`
2. direct Solcast
3. hybrid baseline without residual ML
4. hybrid baseline plus residual ML

Primary metrics:

- slot MAE
- slot RMSE
- daily total absolute error
- WAPE over the `05:00-18:00` window
- dawn first-active-slot timing error
- dusk last-active-slot timing error
- ramp error for `5-minute` deltas

Segmented metrics:

- clear days
- mixed cloud days
- overcast / rainy days
- shoulder periods only
- midday only

Promotion rule:

- do not promote the hybrid path to default until it beats current `ml_local` on both:
  - slot accuracy
  - daily total accuracy

and does not materially regress dawn/dusk behavior.

## Operational Risks

### Toolkit Page Stability

The toolkit integration is an authenticated page parse, not just a stable documented JSON API call.

Risk:

- Solcast may change page structure or embedded payload names

Mitigation:

- snapshot successful fetches locally
- fail gracefully to current `ml_local`
- add parser health diagnostics and clear operator error messaging

### Snapshot Coverage Gaps

If Solcast snapshots are not captured consistently, ML training coverage will be patchy.

Mitigation:

- persist snapshot on every successful generation run
- optionally persist on preview refresh only when explicitly enabled
- track snapshot coverage percentage before enabling hybrid training

### Wrong Use of `estActuals`

Risk:

- treating provider estimated actuals as plant truth would weaken the ML target quality

Mitigation:

- hard rule: production ML labels come from plant actuals only

## Recommended Rollout Order

1. Persist normalized Solcast snapshots.
2. Refactor direct Solcast day-ahead generation to use persisted snapshots plus gating.
3. Add snapshot read support inside `forecast_engine.py`.
4. Implement the hybrid baseline and backtest it.
5. Add Solcast-aware residual training and backtest it.
6. Add Solcast reliability artifact and dynamic weighting.
7. Promote hybrid `ml_local` path only after validation passes.

## Acceptance Criteria

This plan is successful when all of the following are true:

- the dashboard can reconstruct the exact Solcast-backed day-ahead used for a given day
- Solcast data improves `5-minute` day-ahead shape without breaking inverter-aware gating
- the local ML model uses Solcast as a high-resolution prior, not as a replacement truth source
- the hybrid path outperforms current `ml_local` in backtesting
- the system falls back safely when Solcast is unavailable or stale

## Immediate Next Step

Phase 1 is complete. The next step is Phase 2:

- refactor `generateDayAheadWithSolcast` to read the persisted snapshot first before falling back to a live fetch
- apply inverter-aware startup and shutdown gating to the Solcast output slots
- apply low-power node staging at the final output layer
- store provenance on the written `forecast_dayahead` rows linking them to the snapshot `pulled_ts`

This makes the direct Solcast provider reproducible and operationally safe before the ML hybrid path (Phases 3–7) is ready.
