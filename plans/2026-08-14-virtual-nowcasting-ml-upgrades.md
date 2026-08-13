# Virtual Nowcasting and ML Upgrade Plan

**Date:** 2026-08-14
**Status:** Revised design; implementation not started
**Scope:** Forecast service, forecast persistence/audit, analytics API/UI, tests, documentation, and release packaging

## 1. Executive Decision

This work must extend the existing forecast architecture rather than introduce a
second nowcasting pipeline.

The dashboard already:

- generates an ML/Solcast day-ahead forecast;
- builds `forecast_intraday_adjusted` from observed generation every five minutes;
- excludes known cap-dispatch and outage conditions from the preferred ratio basis;
- learns aggregate activity onset/offset history;
- applies activity hysteresis and module staging near the solar shoulders; and
- serves Solcast estimated actual, plant actual, locked day-ahead, and ML-final
  series as separate analytics products.

The upgrade will improve those existing paths in four controlled areas:

1. Replace the current linear recent/global ratio adjustment with a robust,
   lead-time-decaying nowcast correction.
2. Extend the existing activity artifact with leakage-safe, capacity-weighted
   inverter synchronization behavior.
3. Add weather-trend features only after issue-time input coverage and ablation
   testing show that they add real forecast skill.
4. Render the already-served ML intraday result as a distinct chart series and
   expose enough diagnostics to understand every correction.

No component is promoted to production solely because it is mathematically
plausible. Offline rolling-origin replay and a live shadow period are required.

---

## 2. Non-Negotiable Architecture Rules

### 2.1 Forecast authority

- Node owns provider selection, Solcast refresh decisions, day-ahead orchestration,
  freshness classification, and authoritative day-ahead audit creation.
- Python owns ML training, day-ahead ML execution, intraday correction, replay,
  QA, and model/artifact generation.
- `forecast_dayahead` remains untouched by intraday generation.
- `forecast_run_audit` remains the day-ahead run ledger. Intraday runs must never
  supersede or become authoritative learning rows in that table.
- Solcast remains a high-authority day-ahead input when usable, with the existing
  physics fallback retained for outages.

### 2.2 Actual-energy authority

Live nowcasting must use server-side PAC x elapsed-time integration only:

- primary live basis: loss-adjusted `energy_5min` through
  `load_actual_loss_adjusted_with_presence()`;
- optional higher-authority basis: substation-metered slots when they are timely,
  correctly aligned, and explicitly marked as metered; and
- forbidden as a live observation: Solcast `est_actual` or any Python/Modbus kWh
  register.

`resolve_actual_5min_for_date()` must not be used directly by live nowcasting
because it can fill missing plant observations with Solcast estimated actuals.
Estimated actuals may remain available for training reconstruction under the
existing provenance and weighting rules, but not for plant-as-a-sensor correction
or nowcast scoring.

### 2.3 Operating modes

- Generation, artifact rebuilding, shadow evaluation, and intraday writes run in
  `gateway` mode only.
- `remote` remains a viewer and proxies forecast/analytics requests to the gateway.
- No new remote-side persistence of live forecast rows is allowed.
- Switching from remote to gateway must continue to stop all remote activity before
  local forecast work becomes eligible.

### 2.4 Scheduling

- Keep the existing Python service loop as the only regular intraday scheduler.
- Continue evaluating the current day once per five-minute slot during the
  05:00-18:00 forecast window.
- Do not add 10:30/13:30 Node cron jobs; they would duplicate a more frequent
  existing writer.
- Node may gain a read-only watchdog for intraday freshness, but a recovery trigger
  must be idempotent, gateway-only, lock-protected, and used only when the Python
  service is stale or unavailable.

### 2.5 Backward compatibility

- Existing model bundles must continue to load by aligning to their stored feature
  names.
- Existing `forecast_intraday_adjusted` readers and replication behavior must keep
  working during upgrade and rollback.
- The legacy JSON forecast context remains a compatibility fallback; SQLite remains
  authoritative.
- All new artifact formats require a schema version and a safe fallback to current
  behavior when missing, stale, corrupt, or unsupported.

---

## 3. Forecast Product Definitions

These products must remain semantically separate in storage, APIs, UI, and logs:

| Product | Meaning | Mutability |
|---|---|---|
| Locked day-ahead P10/P50/P90 | Frozen Solcast submission-time reference | First-write-wins |
| ML day-ahead | Node-orchestrated final forecast for the target day | Replaceable through audited generation |
| Plant actual | PAC-integrated plant energy/power | Appended as observations arrive |
| Solcast estimated actual | Satellite/provider estimate of realized conditions | Provider snapshot overwrite semantics |
| ML intraday nowcast | Observed slots plus corrected future ML day-ahead slots | Refreshed each eligible five-minute slot |

The frontend label `Solcast est. actual` must continue to mean Solcast estimated
actual. The new/updated line must be labeled `ML intraday nowcast` and consume the
API's `ml_final` payload, never `intraday_solcast`.

---

## 4. Work Package 0 - Baseline and Replay Harness

No model or production behavior changes begin until a reproducible baseline exists.

### 4.1 Freeze the comparison baseline

Record:

- package version and commit;
- active model bundle checksum and feature names;
- active forecast artifact versions;
- operator forecast settings;
- Solcast/provider configuration class without recording credentials;
- training-day/sample counts and weather-regime distribution; and
- current intraday algorithm constants and operator overrides.

### 4.2 Add an intraday replay mode

Implement a non-persistent replay path that can evaluate historical issue times
without overwriting live rows or audits.

For every replayed target date and simulated issuance time:

1. Load the day-ahead forecast that was available at that historical time, or use
   an explicitly identified locked/replay baseline.
2. Expose only actual slots whose timestamps are at or before the simulated cutoff.
3. Exclude future actuals even though they exist in the historical DB.
4. Exclude Solcast estimated actuals from the observation and scoring basis.
5. Apply the same outage, cap-dispatch, manual-control, maintenance, freshness, and
   data-quality masks intended for production.
6. Score only future horizons relative to the simulated issuance time.

Required replay horizons:

- +5 minutes;
- +15 minutes;
- +30 minutes;
- +60 minutes;
- +120 minutes; and
- remaining-day total energy.

### 4.3 Champion/challenger outputs

Every replay run must compare:

- unchanged day-ahead;
- current intraday algorithm;
- robust decay nowcast challenger;
- optional activity-profile challenger;
- optional derivative-feature model challenger; and
- the combined challenger only after individual ablations pass.

Persist replay results to a dedicated experiment output, not the live forecast
tables. The output must include algorithm version, baseline run identity, cutoff,
actual provenance, masks, metrics, and feature/artifact versions.

---

## 5. Work Package 1 - Robust Lead-Time-Decaying Nowcast

### 5.1 Implementation location

Refactor and extend `build_intraday_adjusted_forecast()` and
`run_intraday_adjusted()`. Do not create a parallel scheduler or a second
production table for the active nowcast.

### 5.2 Eligible observations

An observed slot is eligible only when all conditions are true:

- PAC-integrated or accepted metered actual is present;
- the observation timestamp is not later than the current/replay cutoff;
- day-ahead baseline energy exceeds a safe denominator threshold;
- the slot is within the forecast solar window;
- data freshness passes;
- the slot is not plant-cap dispatched or export curtailed;
- the slot is not covered by an inverter outage, manual stop, or maintenance event;
  and
- enough configured plant capacity was observable to make the plant ratio credible.

The current fallback from unconstrained observations to increasingly contaminated
sets must be removed or made explicit. A nowcast should fall back to unchanged
day-ahead rather than silently learn from constrained or provider-estimated slots.

### 5.3 Robust correction calculation

The clear-sky normalization in the original proposal is not a separate signal when
the same clear-sky denominator is used for actual and forecast: it reduces to an
actual/day-ahead ratio. Implement the ratio directly and robustly.

For each eligible observed slot `i`:

```text
r_i = log(max(actual_i, epsilon) / max(dayahead_i, epsilon))
```

Compute:

- `b_recent`: weighted median of `r_i` over the most recent 6-12 eligible slots;
- `b_session`: weighted median of `r_i` over at most the most recent 36 eligible
  slots; and
- `strength`: a bounded confidence factor derived from eligible-slot count,
  baseline energy, observed-capacity coverage, source quality, and volatility,
  capped by the existing fresh `forecastIntradayBlendMax` setting.

For future lead time `h` minutes:

```text
short_weight(h) = exp(-ln(2) * h / half_life_minutes)
bias(h) = strength * ((1 - recent_mix) * b_session
                      + recent_mix * b_recent * short_weight(h))
factor(h) = clip(exp(bias(h)), ratio_floor, ratio_ceiling)
nowcast(h) = clip(dayahead(h) * factor(h), 0, physical_slot_cap)
```

Design intent:

- short-lived cloud/measurement deviations decay toward the session bias;
- persistent day-level bias may remain through the remaining day;
- ratios are symmetric in log space and resistant to single-slot spikes;
- existing safety caps remain effective; and
- no correction is applied when evidence is insufficient.

Initial half-life and `recent_mix` values must come from offline replay. They are
not operator-facing settings until validation shows that operator tuning is useful
and safe.

### 5.4 Time gating

Do not hardcode a new 08:00-16:00 operating window.

The service continues running during 05:00-18:00, but correction eligibility is
controlled by:

- minimum baseline energy;
- minimum clear-sky/solar-elevation opportunity;
- minimum eligible observation count;
- denominator stability; and
- remaining forecast horizon.

This permits useful early/late corrections when evidence is good and naturally
falls back when shoulder ratios are unstable.

### 5.5 Past slots and confidence bands

- Past observed slots in `forecast_intraday_adjusted` remain actual observations.
- Future P50 slots use the nowcast formula above.
- Future P10/P90 must be transformed consistently with the point forecast and then
  adjusted for horizon-dependent nowcast uncertainty.
- Always enforce `0 <= P10 <= P50 <= P90 <= physical_slot_cap`.
- Confidence must decrease when eligible support is weak, plant availability is
  partial, or recent ratios are volatile.

### 5.6 Safe fallback

If any input, artifact, or calculation is invalid:

- keep observed past slots where authoritative actual exists;
- use unchanged day-ahead for future slots;
- record a fallback reason;
- do not delete a previously valid intraday series unless replacement succeeds;
  and
- never modify `forecast_dayahead`.

---

## 6. Work Package 2 - Intraday Audit and Observability

### 6.1 Separate audit authority

Create `forecast_intraday_run_audit`. Do not write intraday runs into
`forecast_run_audit` as day-ahead providers or authoritative learning runs.

Minimum fields:

| Field | Purpose |
|---|---|
| `id` | Intraday run identity |
| `target_date` | Forecast date |
| `generated_ts` | Generation timestamp |
| `cutoff_slot` | Last observation allowed into the run |
| `base_run_audit_id` | Day-ahead run used as baseline, when resolvable |
| `base_forecast_updated_ts` | Fallback baseline identity |
| `algorithm_version` | Reproducible nowcast implementation version |
| `execution_mode` | `shadow` or `active` |
| `actual_source` | PAC-integrated, metered, or mixed authoritative source |
| `eligible_slots` | Support count |
| `excluded_cap_slots` | Cap/curtailment exclusions |
| `excluded_outage_slots` | Outage/maintenance exclusions |
| `excluded_quality_slots` | Freshness/denominator/data-quality exclusions |
| `recent_log_ratio` | Robust short-window bias |
| `session_log_ratio` | Robust session bias |
| `strength` | Applied confidence/blend |
| `half_life_minutes` | Decay parameter |
| `dayahead_total_kwh` | Baseline total |
| `nowcast_total_kwh` | Adjusted total |
| `run_status` | Success, skipped, fallback, or failed |
| `notes_json` | Versioned supplemental diagnostics |

Add indexes for `(target_date, generated_ts)` and latest successful run lookup.
Apply a bounded retention policy after the experiment/operational requirements are
agreed; do not allow five-minute audit growth to become unbounded.

### 6.2 Transaction and concurrency behavior

- Use the existing SQLite retry/backoff pattern.
- Serialize same-date intraday writes with an advisory lock or equivalent
  single-writer guard.
- Replace all rows for a date transactionally.
- Commit the successful audit record with, or immediately after, the successful
  series transaction so the UI never reports an audit for data that was not saved.
- Preserve the last valid series when generation fails.

### 6.3 Shadow evaluation storage

Do not store a full 156-slot candidate curve every five minutes indefinitely.
For the live shadow stage, persist only scheduled evaluation checkpoints and the
predictions needed for +15/+30/+60/+120-minute scoring, with a 30-60 day retention
window. This keeps evaluation reproducible without excessive DB growth.

### 6.4 Diagnostics API

Extend forecast engine health with:

- active nowcast mode (`off`, `shadow`, `active`);
- last successful and attempted intraday timestamps;
- last cutoff slot;
- algorithm version;
- eligible/excluded counts;
- correction strength and decay settings;
- baseline run identity;
- fallback reason; and
- artifact age/support warnings.

Intraday audit data is gateway-authoritative. Remote clients access it through
proxy routes; do not invent an independent remote audit history.

---

## 7. Work Package 3 - Inverter Activity and Shoulder Modeling

### 7.1 Extend the existing artifact

Extend the existing forecast activity artifact rather than creating an unrelated
nightly cache. Preserve existing `activity_records`, `estimate_activity_window()`,
`apply_activity_hysteresis()`, and `apply_block_staging()` as the fallback.

The upgraded artifact requires:

- `schema_version`;
- creation timestamp;
- training cutoff date;
- source DB identity where safe;
- lookback window;
- accepted/rejected day counts and rejection reasons;
- per-inverter support counts;
- capacity-weighted activity profiles; and
- checksum/atomic replacement behavior.

### 7.2 Define inverter synchronization from energy, not communications

Derive inverter activity from server-integrated per-inverter `energy_5min` or an
equivalent PAC-integrated series.

Do not use `online` communication status as grid-synchronization truth.

For each inverter/day:

- define activation using a capacity-relative energy threshold sustained for at
  least three consecutive slots;
- define deactivation with a lower threshold and sustained hysteresis;
- reject isolated non-zero artifacts;
- respect configured inverter/node enablement and capacity;
- exclude firmware maintenance, manual STOP, plant-cap dispatch, confirmed outage,
  and materially incomplete data; and
- record why an inverter/day was excluded.

### 7.3 Learn solar-relative, capacity-weighted behavior

Use features relative to solar geometry rather than a single absolute-clock rolling
average:

- minutes from modeled sunrise/solar-elevation threshold to activation;
- minutes from deactivation to modeled sunset/solar-elevation threshold;
- season and day-of-year;
- weather regime and forecast irradiance/cloud class;
- inverter identity/topological grouping where support exists; and
- enabled capacity represented by each inverter.

The primary profile is `expected_active_capacity_fraction`, not raw active-inverter
count. It must include support and uncertainty so weak profiles fall back safely.

### 7.4 Prevent temporal leakage

For every historical training or replay target, build the activity profile using
only dates strictly before that target. Do not compute one rolling profile from the
full dataset and reuse it for earlier samples.

Production inference uses the latest artifact whose training cutoff precedes the
forecast target date.

### 7.5 Determine integration by ablation

Evaluate these alternatives independently:

1. Existing activity hysteresis/staging only (champion).
2. Capacity-weighted activity fraction as a shoulder baseline adjustment.
3. Capacity-weighted activity fraction as an ML feature.

Do not apply alternatives 2 and 3 together unless their combined replay beats both
individual variants.

If the baseline-adjustment variant wins, apply the local activity fraction to
Solcast P10/P50/P90 consistently in high-confidence shoulder slots before final ML
clamping. This prevents the later Solcast floor/tri-band clamp from undoing the
local physical activity model and keeps the adjusted uncertainty band coherent.

---

## 8. Work Package 4 - Weather Derivative Features

### 8.1 Candidate features

Use names that match their actual calculations:

| Feature | Definition |
|---|---|
| `cloud_delta_1h` | `cloud[t] - cloud[t-12]` at five-minute resolution |
| `temp_delta_1h` | `temperature[t] - temperature[t-12]` |
| `rad_std_30m` | Trailing standard deviation of irradiance over six slots |

`rad_std_30m` is volatility, not momentum. If directional momentum is later
needed, define a separate signed irradiance slope/delta.

### 8.2 Input-resolution and issue-time rules

Open-Meteo is hourly and interpolated to five minutes. Therefore:

- do not claim that 30-minute variation from interpolated hourly data resolves
  passing clouds;
- prefer provider-native five-minute Solcast trend/spread inputs where available;
- calculate derivative windows identically in training and inference;
- use trailing rather than centered windows for any feature described as causal;
  and
- record whether a training row came from issue-time forecast weather or hindsight
  archive weather.

Before promotion, audit how many historical days have saved issue-time weather
snapshots. Derivative training requires adequate issue-time coverage. If coverage
is insufficient, keep the features experimental or neutral and do not train a
production model that learns precise storm timing from hindsight archive weather.

### 8.3 Feature compatibility

- Append approved features to `FEATURE_COLS` only after ablation.
- Update feature-count assertions and tests in the same change.
- Store exact feature names and schema version in every new bundle.
- Continue aligning old bundles to their stored feature list.
- Neutral-fill a missing new feature only for loading an old model or an explicitly
  marked unavailable input; do not rewrite historical DB rows with zero defaults.
- Retrain to gain benefit from new features; an old bundle should continue using
  its original feature set unchanged.

### 8.4 No feature-cache DB backfill

There is no historical DB feature matrix that needs migration. `build_features()`
reconstructs features from weather and snapshot inputs at training time.

If operators need a manual maintenance command, implement an artifact-only command
such as:

```text
--rebuild-forecast-artifacts --lookback-days N --dry-run
```

It must:

- run only in gateway mode;
- read SQLite in query-only mode or from a transactionally consistent snapshot;
- acquire the forecast maintenance/generation lock;
- report estimated work and accepted/rejected coverage;
- write to a temporary artifact;
- validate schema/checksum before atomic replacement; and
- leave the previous artifact intact on failure.

A solar-window clock check may be an additional operational guard, but it is not
the concurrency or DB-safety mechanism.

---

## 9. Work Package 5 - Node, API, and Frontend Integration

### 9.1 Node responsibilities

Node changes are limited to:

- DB schema/migration and prepared statements for the intraday audit/evaluation
  tables;
- read-only health/audit APIs;
- existing analytics payload enrichment where needed;
- optional stale-intraday watchdog behavior; and
- settings validation for the nowcast rollout mode.

Node must not duplicate Python's five-minute nowcast calculation.

### 9.2 Rollout setting

Add one fresh-read setting with safe values:

```text
forecastVirtualNowcastMode = off | shadow | active
```

Behavior:

- `off`: current intraday algorithm remains authoritative;
- `shadow`: current algorithm remains authoritative and the challenger is evaluated
  without overwriting it; and
- `active`: validated challenger writes `forecast_intraday_adjusted`, with immediate
  fallback to the current algorithm on error.

Default for existing and new installations is `off` until the replay and shadow
promotion gates pass. Invalid values resolve to `off` and emit a bounded warning.

### 9.3 Analytics API

The day-ahead chart API already returns:

- `locked`;
- `intraday_solcast`;
- `plant_actual`; and
- `ml_final`.

Keep those names stable. Add nowcast metadata separately, including generated time,
algorithm version, cutoff, support, execution mode, and fallback state.

### 9.4 Frontend

Update the merged analytics chart to render `ml_final.rows` as
`ML intraday nowcast`.

Requirements:

- keep `Solcast est. actual` separate;
- show the nowcast generation/cutoff time in compact metadata;
- visually distinguish observed history from future nowcast where practical;
- preserve compact layout;
- use shared theme tokens and validate dark, light, and classic themes;
- avoid implying that shadow output is production-authoritative; and
- proxy all remote analytics through the gateway as today.

Any UI change requires synchronized updates to:

- `docs/ADSI-Dashboard-User-Guide.html`;
- `docs/ADSI-Dashboard-User-Manual.md`; and
- `docs/ADSI-Dashboard-User-Guide.pdf`.

---

## 10. Validation and Promotion Gates

### 10.1 Dataset

Use at least 60-90 eligible completed days when available, with chronological
rolling-origin evaluation. Report days skipped for missing issue-time inputs,
actuals, constraints, or insufficient model training.

Do not randomly split five-minute slots from the same day across train and test.

### 10.2 Metrics

Day-ahead metrics:

- overall WAPE;
- median and mean daily WAPE;
- total-energy APE;
- slot MAE and RMSE;
- first-active and last-active timing error;
- P10-P90 empirical coverage; and
- error by weather regime and season.

Dedicated shoulder metrics:

- 05:00-08:00 MAE/WAPE;
- 16:00-18:00 MAE/WAPE;
- synchronization timing error; and
- active-capacity-fraction calibration.

Intraday metrics:

- +5/+15/+30/+60/+120-minute MAE and WAPE;
- remaining-day total-energy APE;
- improvement relative to unchanged day-ahead;
- improvement relative to the current intraday algorithm;
- performance by issue time, weather regime, and observed-support bucket; and
- fallback/skipped-run frequency.

Score against metered or PAC-integrated actuals only. Provider estimated actuals
must be excluded from promotion metrics.

### 10.3 Minimum promotion gates

A challenger may enter live shadow only when:

- replay covers at least 30 eligible days and more data is not reasonably available;
- there is no future-observation or full-history artifact leakage;
- no critical weather regime shows an unexplained material regression; and
- all persistence, fallback, and compatibility tests pass.

A challenger may become active only when the combined replay plus live-shadow
results meet all of these gates:

| Gate | Requirement |
|---|---|
| Intraday skill | At least 5% relative improvement in median nowcast WAPE over the current intraday algorithm across +15 to +120 minute horizons |
| Shoulder skill | At least 10% relative improvement in shoulder MAE for the promoted activity component |
| Overall regression | No more than 0.5 percentage-point overall WAPE regression |
| Regime regression | No regime regresses by more than 2 percentage points without documented operator acceptance |
| Reliability | No increase in missing/incomplete production series; all failures fall back successfully |
| Runtime | P95 intraday execution comfortably completes before the next five-minute slot |
| Data integrity | Zero unauthorized writes to `forecast_dayahead` or day-ahead learning authority |

If a component fails its individual ablation, omit it from the combined model even
if the overall project continues.

---

## 11. Rollout and Rollback

### Stage A - Offline only

- Implement replay and unit tests.
- Produce baseline and challenger reports.
- Select parameters from training/validation periods only.
- Keep `forecastVirtualNowcastMode=off`.

### Stage B - Live shadow

- Enable `shadow` on the gateway for at least 14 completed solar days.
- Include clear/mixed and at least one overcast/rainy period where naturally
  available; extend the shadow period if regime coverage is inadequate.
- Continue writing the current intraday algorithm to the production table.
- Store bounded challenger checkpoints for later scoring.

### Stage C - Controlled activation

- Switch to `active` only after promotion gates pass and an operator explicitly
  enables it.
- Retain the old algorithm in code as the automatic fallback.
- Monitor engine health, run duration, eligible-slot counts, correction magnitude,
  fallback count, DB busy retries, and chart freshness.

### Automatic rollback triggers

Immediately fall back to the current intraday algorithm when:

- the challenger raises or returns invalid/missing rows;
- fewer than the required eligible observations exist;
- ratios or bands contain NaN/Inf or violate ordering/cap constraints;
- artifact schema/checksum validation fails;
- the base day-ahead identity cannot be safely resolved;
- the generation lock cannot be acquired within the bounded retry window; or
- execution risks missing the next five-minute cadence.

Operator rollback is a single setting change from `active` to `off`. No schema
rollback or model deletion is required.

---

## 12. Test Plan

### 12.1 Python unit tests

Add tests for:

- authoritative actual-source selection and rejection of Solcast estimated actual;
- cutoff enforcement with no future-slot leakage;
- denominator/low-energy gates;
- weighted-median log ratios;
- half-life decay and long-horizon session bias;
- ratio, blend, capacity, and band constraints;
- outage, manual, maintenance, cap-dispatch, and curtailment exclusions;
- insufficient-evidence fallback;
- prior-series preservation on write failure;
- activity sync/desync hysteresis;
- capacity weighting and configured-node changes;
- rolling/as-of activity artifacts with no future-day access;
- derivative definitions and trailing windows;
- issue-time weather coverage handling;
- old model/artifact compatibility;
- replay cutoff/horizon scoring; and
- shadow versus active behavior.

### 12.2 Node/database tests

Add tests for:

- idempotent migration of intraday audit/evaluation tables;
- required indexes and bounded retention;
- transactional series replacement;
- day-ahead audit authority remaining unchanged;
- settings validation/defaults;
- gateway-only writes and remote proxy behavior;
- backup/restore behavior for new schema;
- any replication allowlist changes that are intentionally required; and
- watchdog idempotency/locking if a watchdog is added.

### 12.3 Frontend tests

Verify:

- `ml_final` renders as `ML intraday nowcast`;
- `intraday_solcast` remains `Solcast est. actual`;
- missing/fallback/shadow metadata is accurate;
- chart units and five-minute MW/MWh conversion remain correct;
- no duplicate datasets appear on refresh;
- remote mode displays gateway data; and
- dark, light, and classic themes remain readable.

### 12.4 Regression and smoke checks

At minimum:

```powershell
python -m pytest services/tests/test_forecast_engine_audit_fixes.py `
  services/tests/test_forecast_engine_constraints.py `
  services/tests/test_forecast_engine_weather.py `
  services/tests/test_forecast_engine_triband.py -q

node --check server/index.js
node --check server/db.js
node --check public/js/app.js
python -m py_compile services/forecast_engine.py ForecastCoreService.py
```

Run all new replay/nowcast/activity tests plus existing provider-parity tests.

For DB-backed plain-Node tests:

1. Run `npm run rebuild:native:node`.
2. Run the Node forecast/mode/database suite.
3. Always restore `npm run rebuild:native:electron` before Electron or UI work.

For UI changes:

```powershell
npm run rebuild:native:electron
Push-Location server/tests
npx playwright test electronUiSmoke.spec.js --reporter=line
Pop-Location
```

---

## 13. Build, Documentation, and Release Requirements

If `services/forecast_engine.py` or `ForecastCoreService.py` changes:

```powershell
pyinstaller --noconfirm services/ForecastCoreService.spec
```

Only `ForecastCoreService.exe` requires rebuilding unless a shared Python module
covered by the repository's multi-service rebuild rule also changes.

Before an Electron build:

```powershell
npm run rebuild:native:electron
```

Before a release:

- bump `package.json` first;
- align `package-lock.json`, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `MEMORY.md`,
  `public/user-guide.html`, and all user-guide version headers;
- regenerate the PDF guide after HTML/Markdown updates;
- confirm rebuilt Python service binaries are current;
- use the signed installer workflow and pass signing, thumbprint, size, and SHA-512
  gates; and
- keep updater app ID `com.engr-m.inverter-dashboard` unchanged.

---

## 14. Expected File Impact

| Area | Expected files |
|---|---|
| Python algorithm/model/replay | `services/forecast_engine.py`, `ForecastCoreService.py` |
| Python tests | `services/tests/test_forecast_engine_*.py`, new focused nowcast/activity replay tests |
| DB and API | `server/db.js`, `server/index.js` |
| Node tests | `server/tests/*forecast*.test.js`, mode/restore tests as needed |
| Frontend | `public/js/app.js`, possibly `public/index.html` and `public/css/style.css` |
| UI smoke | `server/tests/electronUiSmoke.spec.js` |
| Documentation | HTML, Markdown, PDF user guides; project references on release |
| Packaged service | `dist/ForecastCoreService.exe` |

No change is expected in inverter Modbus polling, write control, current-day energy
authority, licensing, updater identity, or unrelated services.

---

## 15. Definition of Done

The project is complete only when:

- the robust nowcast extends the existing single intraday path;
- no live correction uses provider-estimated actual as plant truth;
- intraday audits cannot supersede day-ahead authority;
- replay proves there is no cutoff, artifact, or weather-input leakage;
- every promoted feature passes its individual ablation;
- production activation passes the defined replay and shadow gates;
- active mode automatically falls back to the current algorithm on failure;
- the analytics chart displays ML nowcast and Solcast estimated actual as separate
  products;
- gateway/remote behavior remains correct;
- DB growth and retention are bounded;
- Python, Node, UI, migration, backup/restore, and compatibility tests pass;
- user guides are synchronized in HTML, Markdown, and PDF; and
- the rebuilt Forecast service EXE and signed installer pass release gates.

Until these conditions are met, the work remains experimental and
`forecastVirtualNowcastMode` stays `off` or `shadow`.
