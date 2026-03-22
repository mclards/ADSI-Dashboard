# Free/Open Weather Source Plan for Forecast Engine

## Summary
Evaluate and integrate a better free/open weather-source stack for solar forecasting without breaking the current `Solcast + Open-Meteo + local ML` workflow. The target is not a blind provider swap. The target is a source-aware forecast stack that can learn which free/open source is most reliable for each weather classification and fall back safely when a source is weak or unavailable.

## Draft Status
- Drafted on `2026-03-19`
- Scope: forecast-engine weather-source strategy only
- Current recommendation:
  - primary free/open path: `Open-Meteo` expanded into multi-model scoring
  - secondary/reference path: `ECMWF Open Data`
  - auxiliary Philippine-local reference only: `PANaHON / PAGASA`

## Progress
- [x] Map the current weather-source flow in `server/index.js` and `services/forecast_engine.py`
- [x] Evaluate viable free/open candidates for solar forecasting
- [x] Rank the current candidates by integration fit, replay support, and solar usefulness
- [ ] Define the target source architecture and fallback order
- [ ] Lock the exact variable, unit, and resolution contract for all weather providers
- [ ] Design storage changes for per-source forecast snapshots and replayable historical forecast scoring
- [ ] Design ML changes so the engine can learn source reliability by weather classification
- [ ] Define implementation milestones, tests, and rollout gates

## Current Baseline
- The app already fetches daily weather from `Open-Meteo` in [server/index.js](d:/ADSI-Dashboard/server/index.js).
- The forecast engine already fetches hourly weather from `Open-Meteo` in [forecast_engine.py](d:/ADSI-Dashboard/services/forecast_engine.py).
- The current forecast stack already uses `Solcast` as a strong external solar prior and persists forecast-weather snapshots as provider `open-meteo`.
- The current baseline therefore favors extending existing weather infrastructure instead of introducing a completely separate first-class source immediately.

## Evaluated Sources

### 1. Open-Meteo
- Best current fit for this codebase.
- Strengths:
  - already partially integrated
  - clean point-forecast API
  - historical forecast replay support
  - multiple weather models behind one API shape
  - solar/radiation variables available
  - satellite radiation support for intraday correction paths
- Caveats:
  - hosted API licensing/pricing must be checked for production use
  - some higher-frequency outputs outside certain regions may be interpolated rather than native model resolution

### 2. ECMWF Open Data
- Best fully open high-authority reference source.
- Strengths:
  - strong authoritative model lineage
  - open-data path suitable for direct benchmark/reference use
  - useful as a second scored source even if not the easiest first integration
- Caveats:
  - more operational complexity than `Open-Meteo`
  - more ingestion and normalization work
  - not the lowest-risk first implementation

### 3. PANaHON / PAGASA
- Good Philippine-local operational reference, not recommended as the primary forecast-engine source.
- Strengths:
  - local operational relevance
  - map-based weather and forecast views
  - useful for radar/satellite/reference validation
- Caveats:
  - not a clean documented solar-forecast API
  - observed direct endpoints are map-layer oriented and inconsistent
  - no confirmed stable solar-specific point-forecast contract
  - integration risk is high relative to value as a primary training source

## Target Architecture Direction

### Near-Term
- Keep `Solcast` as the premium external solar benchmark and prior.
- Upgrade `Open-Meteo` from a single weather fetch path into a scored multi-model free/open source.
- Add source-aware scoring so the engine can compare:
  - `Open-Meteo model A vs loss-adjusted actual`
  - `Open-Meteo model B vs loss-adjusted actual`
  - `ECMWF/Open reference vs loss-adjusted actual`
  - `Solcast vs loss-adjusted actual`
  - `generated day-ahead vs loss-adjusted actual`

### Medium-Term
- Add `ECMWF Open Data` direct ingestion as an independently scored reference source if operational complexity is acceptable.
- Use satellite/radar-style sources only as intraday correction or weather-regime assist, not as the main day-ahead solar source.

### Not Recommended
- Do not make `PANaHON` the primary forecast-engine provider.
- Do not let map-layer/image endpoints become the main training backbone for ML.

## Required Data Contract
All provider ingestion must preserve source units before any solar-energy conversion.

### Weather / Radiation Inputs
- `shortwave_radiation`: `W/m^2`
- `direct_radiation`: `W/m^2`
- `diffuse_radiation`: `W/m^2`
- `cloud_cover`: `%`
- `temperature_2m`: `deg C`
- `relative_humidity`: `%`
- `wind_speed_10m`: `m/s` or `kph`, normalized explicitly
- `precipitation`: `mm`
- `cape`: provider-native convective energy units, stored explicitly

### Derived Energy Contract
- Convert weather/radiation to plant forecast energy only after provider normalization.
- `Solcast` raw power remains provider-native power first, then normalized to `kWh per 5-minute slot` for scoring.
- Day-ahead forecast scoring must stay on `loss-adjusted actual` basis when the forecast target is substation-delivered output.

### Metadata
Each stored forecast-weather artifact should retain:
- `provider`
- `model`
- `init_time`
- `forecast_valid_time`
- `resolution_minutes`
- `timezone`
- `source_unit_map`
- `actual_basis`

## Storage Plan
- Persist per-source weather snapshots, not only a single merged `open-meteo` snapshot.
- Preserve replayable forecast history by source/model/init so the engine can evaluate how a source actually performed at the time it was issued.
- Store daily source-vs-actual scoring summaries by:
  - overall day
  - day regime
  - slot weather bucket
- Store enough metadata to separate:
  - raw source weather values
  - normalized weather values
  - forecast-energy outputs derived from those values

## ML Plan
- Extend the current weather-conditioned training path so source reliability becomes a learnable feature, not just a one-time heuristic.
- Train reliability by:
  - day regime
  - slot weather classification
  - source/model
  - recent support depth
- Let the engine choose or blend sources per regime/weather class rather than hard-coding one winner globally.
- Keep source selection conservative:
  - require minimum support days
  - shrink toward a neutral fallback when evidence is thin
  - avoid abrupt source flips from sparse data

## Implementation Order
1. Expand the weather snapshot schema to support per-source/per-model storage with full unit metadata.
2. Add an `Open-Meteo` multi-model fetch path while preserving current behavior as fallback.
3. Add daily source-vs-actual scoring on the same `loss-adjusted actual` basis already used by the forecast engine.
4. Feed source reliability into training and inference as a weather-conditioned feature.
5. Add `ECMWF Open Data` direct ingestion only after the storage/scoring contract is stable.
6. Keep `PANaHON` optional and reference-only unless a stable documented machine-readable contract is confirmed.

## Validation Gates
- Verify no regression in current `Solcast` export or day-ahead generation flows.
- Verify provider units are preserved and converted exactly once.
- Verify replayed historical forecasts remain attributable to the original source and model.
- Verify source selection falls back safely when a provider is missing, stale, or partially available.
- Verify the free/open path improves or at least matches current baseline on blocked historical backtests before any default-source change.

## Decision Snapshot
- Best immediate path: extend `Open-Meteo`, do not replace everything.
- Best longer-term open benchmark: add direct `ECMWF Open Data`.
- Best role for `PANaHON`: operational local reference, not primary ML forecast input.
