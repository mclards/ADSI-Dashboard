# Inverter Dashboard Project Memory

## Project Overview
Industrial solar power plant monitoring desktop app. Hybrid Electron + Python.
- **Repo/package version baseline:** 2.7.17
- **Operator-noted deployed server-side app version:** 2.2.32
- **Author:** Engr. Clariden Montaño REE (Engr. M.)
- **Entry point:** electron/main.js
- **Stack:** Electron 29, Express 4, SQLite (better-sqlite3), Chart.js 4, FastAPI (Python), pymodbus
- **Version source-of-truth rule:** `package.json` is the repo version source of truth; hardcoded footer/about strings may lag and must not be trusted blindly.

## v2.7.17 Changes - Rainy/Overcast Error Memory Hardening (2026-04-09)
- **Forecast engine regime-aware lookback:** Clear regime uses 7-day lookback, mixed 10 days, overcast 14 days, rainy 21 days for error memory aggregation.
- **Removed rainy/overcast slot support weight penalties:** Storm slots now receive full weight in rainy regimes instead of being penalized.
- **Regime-aware Solcast fresh-damping:** Rainy regimes apply 10% cut instead of aggressive 70% reduction to Solcast confidence.
- **Graduated regime mismatch penalty matrix:** Overcast↔rainy transitions now use 0.70 penalty instead of flat 0.25 across all mismatches.
- **Lowered rainy/overcast reliability sample thresholds:** Reduced from 10 days to 5 days minimum for regime-specific reliability lookups.
- **Backfill day_regime fallback:** forecast_qa() now reconstructs missing day_regime from audit_trail with full-day regime inference.
- **Legacy error memory regime awareness:** Historical error memory functions now respect active regime for bias correction.
- **Test updates:** test_forecast_engine_constraints.py explicitly verifies target_regime handling.
- **Blueprint and proof files:** Added plans/rainy-overcast-error-memory-hardening.md and tests/proof_error_memory_hardening.py for documentation.
- **Files changed:** services/forecast_engine.py (main), services/tests/test_forecast_engine_constraints.py (test), plans/rainy-overcast-error-memory-hardening.md (new), tests/proof_error_memory_hardening.py (new).
- **Python-only release:** No Electron or EXE rebuilds needed.

## v2.7.6 Changes - Substation Meter Gateway Proxy, Auth Gate Removal, Blueprint Completion (2026-04-05)
- **Substation meter gateway proxy:** Added `_proxySubstationMeterToGateway()` helper in `server/index.js`. POST /api/substation-meter/:date now mirrors writes to the gateway when running in remote mode (Option A per blueprint E4b).
- **Auth gate removal:** Removed `requireSubstationAuth` middleware from three substation meter endpoints (save, upload-xlsx, recalculate) per user directive on 2026-04-05.
- **Frontend modal:** Removed time-based auth gate from `openSubstationMeterModal()` in `public/js/app.js`. Modal now shows content directly without x-substation-key header.
- **Est-actual weight calibration:** Updated `EST_ACTUAL_WEIGHT_FACTOR` from 0.85 to 0.93 (7% discount) per operator validation in `services/forecast_engine.py`.
- **Transmission loss calibration:** Updated `DEFAULT_INVERTER_LOSS_PCT` from 2.5 to 3.0 (midpoint of observed 2.5%-3.6% range) in `services/forecast_engine.py`.
- **Substation metering functions:** Added `_query_substation_metered_15min()`, `interpolate_15min_to_5min()`, and `resolve_actual_5min_for_date()` to forecast engine (E3/E4 fallback chain).
- **Gateway sync toast warning:** Added warning toast when gatewaySynced returns false in frontend.
- **Proxy timeout rule:** Added 20s timeout rule for `/api/substation-meter/` in PROXY_TIMEOUT_RULES.
- **Blueprint verification:** Phase 1-13 est-actual trust and loss calibration completed and verified.
- **Files changed:** `server/index.js`, `public/js/app.js`, `public/css/style.css`, `server/db.js`, `services/forecast_engine.py`.
- **Documentation:** Blueprint post-implementation notes added to `docs/blueprint-est-actual-trust-and-loss-calibration.md`.

## v2.5.7 Changes - Analytics and Settings UI Refinements (2026-03-30)
- **Analytics card row heights:** Reduced to 0.75x in the analytics section CSS. All card heights, canvas sizes, and label minimums scaled proportionally:
  - `chart-total-card` min-height: 420px → 315px
  - `chart-total-side-card` min-height/max-height: 380px/420px → 285px/315px
  - `chart-card` min-height: 330px → 248px
  - Chart canvas heights: 255px → 191px (cards), 360px → 270px (total card)
  - Label min-height: 54px → 41px
  - Category list max-height: 260px → 195px
- **Settings page sidebar redesign:** COMMON ACTIONS panel now sticky/fixed at bottom of sidebar; menu/options panel above made scrollable with flex layout. `overflow: hidden` applied to sidebar container, first card uses `flex: 1 1 0; min-height: 0; overflow-y: auto`.
- **Electron UI smoke test:** Updated artifacts to match new layout.
- **Files changed:** `public/css/style.css`, `server/tests/artifacts/electron-ui-smoke.png`.

## v2.4.42 Changes - Forecast Performance Monitor Extended Diagnostics (2026-03-25)
- **Forecast Performance Monitor second chip row:** added ML Backend, Training Data, and Data Quality diagnostic chips below forecast health status.
- **Extended /api/forecast/engine-health endpoint:** returns mlBackend, trainingSummary, and dataQualityFlags objects alongside existing forecast generation metrics.
- **Extended ml_train_state.json:** added ml_backend_type, model_file_path, model_file_mtime_ms, training_samples_count, training_features_count, training_regimes_count, training_result, last_training_date, data_warnings fields.
- **New Python helpers:** _detect_ml_backend() identifies active LightGBM vs sklearn, _collect_data_quality_warnings() audits data state (stale features, low sample count, regime imbalance, etc.).
- **Fixed build_training_state() call order:** _reset_train_rejection_streak() now called after bundle exists, not before.
- **Panel defaults to collapsed:** Forecast Performance Monitor panel collapses on first load to reduce initial dashboard clutter.
- **Validation:** All 31/31 unit smoke tests passed.
- **Files changed:** `services/forecast_engine.py`, `server/index.js`, `public/js/app.js`, `public/css/style.css`.

## v2.4.32 Changes - Forecast Solcast Alignment Hardening (2026-03-22)
- **Tightened ML residual cap:** `SOLCAST_RESIDUAL_PRIMARY_CAP` lowered from 0.40 to 0.30 for tighter ML residual damping when Solcast is primary.
- **Error-memory bias damping:** When Solcast is fresh (coverage >= 0.95), historical bias correction is reduced by 70%; at coverage >= 0.80, reduced by 50%. Prevents stale historical bias from overriding fresh Solcast priors.
- **Per-slot Solcast energy floor:** Each 5-min slot is individually floored at 95% of Solcast (fresh) or 88% (stale_usable), preserving ML shape while anchoring magnitude to Solcast.
- **New constants:** `SOLCAST_FORECAST_FLOOR_RATIO_FRESH = 0.95`, `SOLCAST_FORECAST_FLOOR_RATIO_USABLE = 0.88`.
- **Files changed:** `services/forecast_engine.py`.
- **Validation:** `python -m py_compile services/forecast_engine.py` passed. ForecastCoreService.exe rebuilt.

## v2.4.31 Changes - Forecast Provider Parity and Audit Completeness (2026-03-22)
- **Fixed port env var bug in Python delegation:** `_delegate_run_dayahead()` was using `IM_SERVER_PORT:3000` instead of `ADSI_SERVER_PORT:3500`, causing delegation to silently fail on the default port.
- **Delegation now returns rich metadata:** `_delegate_run_dayahead()` returns provider, variant, freshness, totals instead of just a bool, enabling better operator diagnostics.
- **Added audit helper functions:** Python-side `forecast_run_audit` row creation is now supported via dedicated audit helpers for direct-call paths.
- **Added `write_audit` param to `run_dayahead()`:** enables audit row creation from direct-call paths that bypass Node orchestration.
- **Rewrote `run_manual_generation()`:** now delegates to Node orchestrator first, with audit-backed fallback, instead of running independently.
- **Added `"manual_cli"` trigger to Node generation endpoint:** `server/index.js` now recognizes `manual_cli` as a valid trigger source.
- **Fixed supersession logic:** `run_status='superseded'` now matches Node-side behavior for authoritative run supersession.
- **Validation:** `python -m py_compile services/forecast_engine.py` passed. ForecastCoreService.exe rebuilt. All version surfaces aligned.
- **Files changed:** `services/forecast_engine.py`, `server/index.js`, `server/tests/forecastProviderParity.test.js`.

## Post-v2.4.30 Working Changes - Day-Ahead Solcast Alignment + Script Hardening (2026-03-20)
- **Scope completed:** implemented the day-ahead generator alignment plan across `server/index.js`, `server/db.js`, and `services/forecast_engine.py`, plus script hardening work in `scripts/` and supporting source-level tests.
- **Manual/auto/fallback provider parity is now enforced from one orchestrator path:** day-ahead generation now normalizes and deduplicates explicit target dates, and both manual API + Python auto delegation + Node fallback all route through shared provider-aware orchestration.
- **Critical audit write bug fixed:** audit inserts were previously attempted via `db.stmts...` (undefined path). This is now corrected to `stmts...`, so run audit rows are actually written.
- **ML generation target-date bug fixed:** ML generation no longer assumes `tomorrow + N` only. It now supports exact dates and ranges using Python CLI routing (`--generate-date`, `--generate-range`), with per-day fallback for non-contiguous date sets.
- **Fallback is now quality-aware (not only completeness-aware):** tomorrow quality is classified as `missing`, `incomplete`, `missing_audit`, `wrong_provider`, `stale_input`, `weak_quality`, or `healthy`; fallback regeneration triggers when policy quality is violated even if row count is complete.
- **Added early repair window:** fallback schedule now includes `04:30` in addition to `18:30`, `20:00`, and `22:00`.
- **Per-day Solcast freshness is now policy-based:** freshness classification uses target-day snapshot coverage and age (`fresh`, `stale_usable`, `stale_reject`, `missing`, `not_expected`) instead of a simplistic pulled-timestamp check.
- **Per-day forecast provenance is persisted from generation time:** each target date stores its own variant (`solcast_direct`, `ml_solcast_hybrid_fresh`, `ml_solcast_hybrid_stale`, `ml_without_solcast`), freshness class, and computed day total.
- **Authoritative run supersession is persisted:** when a newer run becomes authoritative, previous run authority flags are cleared and supersession metadata is written (`superseded_by_run_audit_id`, `replaces_run_audit_id`, `run_status='superseded'`).
- **Failed generation attempts are now auditable:** if all provider attempts fail, a failed run-audit row is inserted with attempt metadata and reason instead of failing silently.
- **Manual generation response now exposes more diagnostics:** API output now includes `forecastVariantsByDate`, `solcastFreshnessByDate`, and `totalsKwhByDate` for operator-side comparison/debug.

- **DB schema expanded for detailed comparison persistence and memory learning gates:**
- `forecast_error_compare_daily` now stores run linkage (`run_audit_id`), provider expectations, variant/freshness, totals/error aggregates, slot availability counts, mask counts, eligibility flags (`include_in_error_memory`, `include_in_source_scoring`), quality status (`comparison_quality`), and notes metadata.
- `forecast_error_compare_slot` now stores run linkage, slot-local timestamps/time labels, signed/absolute/normalized errors, opportunity, Solcast/hybrid references, weather-bucket/regime markers, mask flags, `usable_for_error_memory`, and `support_weight`.
- Migration-safe `ensureColumn(...)` coverage was added for all new compare columns so existing deployments upgrade in place.
- Added/updated indexes for run authority lookup and error-memory selection (`idx_fra_target_authority`, `idx_fecd_mem_target`, `idx_fecs_mem_target`, plus run-based uniqueness indexes).
- Resolved migration startup issue where new indexes referenced columns before migration by moving those index creations to the post-`ensureColumn` migration block.

- **Forecast engine (Python) comparison-save path was fully upgraded:**
- Replaced simple audit-provider fetch with richer run metadata resolver (`_fetch_run_audit_meta`).
- Added source-quality weighting helper (`_memory_source_weight`) to support provenance-aware correction weighting.
- `_persist_qa_comparison(...)` now writes detailed day/slot comparison rows, including eligibility rules, mask-aware filtering, and per-slot support weights.
- QA persistence now consumes forecast masks, operational masks, bucket labels, Solcast presence, and available hybrid/weather debug vectors when present.
- `compute_error_memory(...)` now prefers saved eligible comparison rows (`include_in_error_memory=1`, `comparison_quality='eligible'`, `usable_for_error_memory=1`) and applies decay * source weight * support weight.
- Added `_compute_error_memory_legacy(...)` fallback to keep correction resilient on legacy DBs / migration gaps.
- Added compatibility logic in persistence for legacy table conflict keys so both old and migrated schemas can still be written safely.

- **Script-folder hardening completed (plan-adjacent maintenance + tooling safety):**
- Added shared DOCX utilities in `scripts/_docx_utils.py` (safe IO resolution and anchor-based helpers).
- Added robust section reorder utility `scripts/reorder_perpetual_section.py`.
- Updated legacy wrappers `scripts/fix_order.py`, `scripts/fix_order2.py`, `scripts/fix_order3.py`, and `scripts/fix_swap.py` to delegate to the shared reorder utility.
- Fixed `scripts/backfill_forecast_history.py` for schema compatibility (`forecast_variant` included, epoch-ms `generated_ts`, improved arguments/dry-run behavior).
- Hardened `scripts/update_pricing.py`, `scripts/update_comparison.py`, and `scripts/update_section02.py` to avoid brittle fixed-index DOCX mutations.

- **Tests and validation executed during this implementation pass:**
- Syntax checks: `node --check server/index.js`, `node --check server/db.js`, `python -m py_compile services/forecast_engine.py`.
- DB startup/migration load check: `node -e "require('./server/db'); console.log('db-load-ok')"` passed after migration/index ordering fix.
- Existing source tests passed: `server/tests/forecastProviderParity.test.js`, `server/tests/scriptsSourceSanity.test.js`.
- Added and passed new source-guard test: `server/tests/dayAheadPlanImplementation.test.js`.

- **Files materially changed in this work:**
- `server/index.js`
- `server/db.js`
- `services/forecast_engine.py`
- `scripts/_docx_utils.py`
- `scripts/reorder_perpetual_section.py`
- `scripts/fix_order.py`
- `scripts/fix_order2.py`
- `scripts/fix_order3.py`
- `scripts/fix_swap.py`
- `scripts/backfill_forecast_history.py`
- `scripts/update_pricing.py`
- `scripts/update_comparison.py`
- `scripts/update_section02.py`
- `server/tests/dayAheadPlanImplementation.test.js`
- `server/tests/scriptsSourceSanity.test.js`

## v2.4.30 Changes - Startup Readiness Gating and Standby Refresh Smoothing (2026-03-20)
- **Loading screen now gates actual readiness:** the Electron main window stays hidden until the renderer reports startup complete, instead of showing the shell before the dashboard has real data. The loading screen now reflects live startup progress pushed from Electron rather than polling `/` and redirecting itself early.
- **Startup warmup now uses the loading phase intentionally:** bootstrap waits for settings, IP configuration, seeded current-day energy, first live WebSocket data, chat/alarm state, and sequential tab warmup before the dashboard is revealed. Cloud-backup settings loading was removed from the initial path so Settings-only work no longer slows first paint.
- **First standby refresh hit is lighter on the gateway:** gateway main-DB snapshot generation now reuses the authoritative current-day snapshot rows when building the current-day report payload, avoiding a duplicate full-range `energy_5min` scan during `Refresh Standby DB`.
- **Cloud-backup S3 surface exists in the tree:** `server/cloudProviders/s3.js` plus S3-focused tests are present for the backup provider path and should be considered part of the current release baseline.
- **Validation before release handoff:** `node --check electron/main.js`, `node --check electron/preload.js`, `node --check public/js/app.js`, `node --check server/index.js`, `node server/tests/standbySnapshotReadOnly.test.js`, and `node server/tests/manualPullGuard.test.js` all passed. A live Electron Playwright smoke was attempted but the local environment was missing `playwright/test`.

## v2.4.28 Changes - Real-Time Metric Alignment and Alarm Quick-ACK (2026-03-20)
- **All MWh metrics now update live when today is selected:** `extractCurrentDaySummary` in `public/js/app.js` was fixed to correctly parse the flat `todaySummary` object pushed over WebSocket instead of expecting a nested shape. The downstream `applyCurrentDaySummaryClient` now calls `renderAnalyticsFromState()` directly on every WS push when the Analytics or Energy page is active and the selected date is today, so Analytics summary cards, Energy KPI tiles, and related charts all update in real-time on the same cadence as `TODAY MWh` in the header.
- **Alarm quick-ACK added to toast notifications:** Alarm toasts are now generated by a new `showAlarmToast()` function instead of the generic `showToast()`. Each alarm toast shows an inline **ACK** button in the header row next to the dismiss button. Clicking ACK immediately disables the button, sends the acknowledgement request (`POST /api/alarms/:id/ack`), then auto-dismisses the toast after 1.2 s. Toast TTL extended from 8 s to 12 s to give operators time to react.
- **Alarm quick-ACK added to notification panel:** Each entry in the notification bell panel (`#notifPanel`) now shows a **✔ ACK** button for unacknowledged alarms, and a muted **✔ Acked** label for already-acknowledged ones. The panel item also gets a `.notif-item--active` modifier class while the alarm is unacknowledged. ACK from the panel calls the same `ackAlarm()` function used by the Alarms page, so badge count, sound sync, and alarm-table state all update consistently.
- **Event delegation extended:** The existing `alarmToast` click delegate now handles `.toast-ack-btn` in addition to `.toast-close`. A new delegate on `#notifList` handles `.notif-ack-btn` clicks.
- **CSS additions:** New rules for `.toast-hdr-actions`, `.toast-ack-btn`, `.notif-footer`, `.notif-ack-btn`, `.notif-acked`, and `.notif-item--active`.
- **Validation:** `node --check public/js/app.js` passed. `node server/tests/mwhHandoff.test.js` passed (24/24).

## v2.4.27 Changes - IP-Config Identity Authority and Today-Energy Repair (2026-03-19)
- **Current-day inverter energy totals are restart-safe again:** the gateway poller now seeds from persisted `energy_5min` totals plus a live PAC anchor and only adds post-seed live growth, instead of re-adding the full live day counter on top of the persisted baseline.
- **Telemetry ownership now follows IP Config directly:** the inverter service stamps each live frame with `source_ip` and `node_number`, and the Node poller resolves inverter identity from configured inverter IP plus configured node list before accepting the row. Unknown IPs and unconfigured nodes are rejected, and IP Config wins if a raw frame reports a conflicting inverter number.
- **Operator-facing inverter labels now expose the configured binding:** inverter cards, selectors, detail loading text, node-control toasts, and alarm notifications now show `INV-xx` together with the configured inverter IP so non-patterned IP allocations remain auditable from the UI.
- **Validation covered both identity and energy handoff paths:** `node --check public/js/app.js`, `node --check server/poller.js`, `python -m py_compile services\\inverter_engine.py`, `node server/tests/pollerIpConfigMapping.test.js`, `node server/tests/pollerTodayEnergyTotal.test.js`, `node server/tests/todayEnergyHealth.test.js`, `node server/tests/mwhHandoff.test.js`, `node server/tests/smokeGatewayLink.js`, `node server/tests/modeIsolation.test.js`, and `node server/tests/serviceSoftStopSource.test.js` all succeeded. `npm run rebuild:native:node` was attempted first but hit a transient Windows file-lock on `better_sqlite3.node`; the subsequent Node smoke/tests still passed on the already-working Node ABI.

## v2.4.26 Changes - Solcast Unit Normalization and Release Refresh (2026-03-19)
- **Raw Solcast MW is now normalized defensively inside the forecast engine:** `load_solcast_snapshot()` now derives per-slot `kWh` from raw `MW` when older or partial snapshot rows are missing the stored energy fields, so reliability scoring and hybrid blending stay on the correct 5-minute energy basis.
- **Unit metadata is now explicit in the forecast artifacts:** Solcast snapshot payloads and daily resolution-history records now tag raw provider power as `mw` and comparison energy as `kwh_per_slot`, which makes the basis of the learned weather-class source selection auditable.
- **Solcast export behavior was rechecked before release:** the forecast-engine changes do not alter the Solcast preview/export path in `server/exporter.js`, and a direct `exportSolcastPreview()` smoke run still produced an `.xlsx` under `Forecast\\Solcast`.
- **Final validation and build completed on the release tree:** `python -m py_compile services\\forecast_engine.py services\\tests\\test_forecast_engine_constraints.py services\\tests\\test_forecast_engine_ipconfig.py services\\tests\\test_forecast_engine_weather.py services\\tests\\test_forecast_engine_error_classifier.py`, `python -m unittest services.tests.test_forecast_engine_constraints services.tests.test_forecast_engine_ipconfig services.tests.test_forecast_engine_weather services.tests.test_forecast_engine_error_classifier`, `node --check electron/main.js`, `node --check server/index.js`, `pyinstaller --noconfirm services\\ForecastCoreService.spec`, `npm run rebuild:native:electron`, and `npm run build:installer` all succeeded.
- **Release version surfaces were advanced together:** `package.json`, `package-lock.json`, `SKILL.md`, `CLAUDE.md`, `MEMORY.md`, `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.html`, `public/user-guide.html`, and the forecast-ML plan now match `v2.4.26`.

## v2.4.25 Changes - Forecast Error-Classifier Optimization and Release Alignment (2026-03-19)
- **Forecast error classification is now fully hardened:** the day-ahead pipeline now uses blocked day-holdout probability calibration, slot-opportunity label normalization, cached historical feature/mask/residual artifacts, conservative centroid shrinkage, sparse-class damping, weather-profile reliability scaling, blocked estimator-stage selection, and raw-feature tree inference without the old `RobustScaler` coupling.
- **Solcast trust calibration now uses the same substation basis as the rest of forecasting:** `build_solcast_reliability_artifact()` compares Solcast snapshots against `load_actual_loss_adjusted()` so already-loss-subtracted Solcast data is not implicitly judged against raw inverter totals.
- **Weather-class source selection is now learned on a unit-consistent basis:** raw Solcast arrives in `MW`, is normalized to `kWh per 5-minute slot` for apples-to-apples scoring, and the artifact stores that daily resolution history for both `Solcast vs loss-adjusted actual` and `generated day-ahead vs loss-adjusted actual`, then feeds it back into Solcast authority and the ML feature set via `solcast_resolution_weight` / `solcast_resolution_support`.
- **Runtime hot paths are lighter without changing forecast rules:** slot weather-bucket classification is now vectorized, repeated pandas rolling calls were replaced with NumPy rolling helpers, and the optimized bucket path is covered by a direct reference-rule equivalence test.
- **Verification was broadened before release:** `python -m py_compile services\\forecast_engine.py services\\tests\\test_forecast_engine_constraints.py services\\tests\\test_forecast_engine_ipconfig.py services\\tests\\test_forecast_engine_weather.py services\\tests\\test_forecast_engine_error_classifier.py`, `python -m unittest services.tests.test_forecast_engine_constraints services.tests.test_forecast_engine_ipconfig services.tests.test_forecast_engine_weather services.tests.test_forecast_engine_error_classifier`, `node --check electron/main.js`, `node --check server/index.js`, `pyinstaller --noconfirm services\\ForecastCoreService.spec`, `npm run rebuild:native:electron`, and `npm run build:installer` all succeeded.
- **Live replay path was exercised too:** `run_backtest()` was attempted for `2026-03-14` and `2026-03-15`, and it exited through the expected training-unavailable branch because the local environment currently has `0` accepted history days for reference dates `2026-03-13` and `2026-03-14`.
- **Versioned docs were realigned to the new baseline:** `package.json`, `package-lock.json`, `SKILL.md`, `CLAUDE.md`, `MEMORY.md`, `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.html`, `public/user-guide.html`, and `docs/ADSI-Dashboard-User-Guide.pdf` now match `v2.4.25`.

## v2.4.23 Changes - Forecast Classifier, Runtime Supervision, and Plant Cap Settings Polish (2026-03-19)
- **Forecast inference is more weather-aware:** the day-ahead path now adds a conservative weather-conditioned error classifier on top of the physics/Solcast hybrid baseline and residual regressor, with stronger Solcast respect on clear-weather slots.
- **Day-ahead generation and recovery are harder to break:** the current codebase includes the pre-sunrise target-date fix, forecast-weather fallback, complete day-ahead rowset checks, DB-backed write success requirements, crash backoff, authoritative `ipconfig` loading, configurable export-cap detection, and cleaner plant-cap constraint handling in training, QA, and intraday adjustment.
- **Forecast process supervision is earlier and mode-aware:** Electron now starts forecast mode sync during server boot, can read `operationMode` from the local settings DB before HTTP is ready, keeps the forecast EXE alive in gateway mode, and still shuts it down intentionally in remote mode.
- **Plant Output Cap defaults in Settings were reorganized:** the settings UI now groups band and selection controls into clearer cards, shows a planner summary strip for selection mode / band gap / controllable count / smallest step, and renders structured inline guidance instead of a single plain note.
- **Validation and release build completed locally:** `python -m py_compile services\\forecast_engine.py services\\tests\\test_forecast_engine_weather.py services\\tests\\test_forecast_engine_error_classifier.py`, `python -m unittest discover -s services\\tests -p "test_*.py"`, `node --check electron/main.js`, `node --check server/index.js`, `node server/tests/forecastWatchdogSource.test.js`, `node server/tests/forecastCompletenessSource.test.js`, `node server/tests/ipConfigLossDefaultsSource.test.js`, `node server/tests/plantCapController.test.js`, `npm run rebuild:native:node`, `node server/tests/smokeGatewayLink.js`, `npm run rebuild:native:electron`, `pyinstaller --noconfirm services\\ForecastCoreService.spec`, and `npm run build:installer` all succeeded. The optional Electron Playwright smoke could not run because `playwright/test` is not installed in this repo.

## v2.4.22 Changes - Day-Ahead Target Resolution and Weather Fallback Recovery (2026-03-19)
- **Pre-sunrise day-ahead targeting is fixed:** the forecast service now treats the upcoming solar window as `today` before sunrise instead of incorrectly targeting `today + 1`, so missing day-ahead generation at `00:00-04:59` now repairs the correct date.
- **Current-day forecast weather recovery is more resilient:** if the live forecast provider fails or returns an invalid payload, the engine now falls back to cached forecast weather first, and then to the saved weather snapshot path already used by `run_dayahead()`.
- **Recovery execution now self-reports cleanly:** successful daytime recovery logs completion and refreshes the intraday-adjusted forecast immediately after writing the repaired day-ahead.
- **Validation passed locally:** `python -m py_compile services\\forecast_engine.py services\\tests\\test_forecast_engine_constraints.py services\\tests\\test_forecast_engine_weather.py` and `python -m unittest discover -s services\\tests -p "test_*.py"` both succeeded.

## v2.4.21 Changes - Forecast Resiliency and Default Loss Baseline (2026-03-19)
- **Day-ahead persistence and retry logic were hardened:** DB-backed day-ahead success now requires a real SQLite write, partial DB rowsets no longer suppress regeneration, and crashed post-solar attempts now enter the same cooldown path as clean failures.
- **Forecast completeness checks now match the solar window end-to-end:** Python overnight generation, the Node fallback cron, and startup legacy-context repair all require a complete solar-window day-ahead rowset instead of any stray row.
- **Per-inverter forecast loss defaults now start at `2.5%`:** missing or partial `losses` config values now default to `2.5` in forecast-engine config sanitization, server-side `ipConfigJson` defaults, inverter-engine file mirroring, and the IP Config UI.
- **Loss handling remains forecast-only:** the manual/rulebook wording was updated to state explicitly that `Loss %` does not alter dashboard telemetry, logged plant data, reports, or exports.

## v2.4.20 Changes - Forecast Release Alignment and Constraint-Hardened QA (2026-03-19)
- **Forecast export ceiling is now configurable:** the forecast engine reads `forecastExportLimitMw` from the settings table, with `24 MW` retained only as the fallback export ceiling instead of a silent hardcoded assumption.
- **Day-ahead QA and backtest scoring now match forecast-data hygiene:** slot metrics exclude missing actual/forecast slots and operationally constrained periods, so reported WAPE/MAPE/RMSE no longer penalize plant-cap or manual-stop intervals that training and error-memory already ignore.
- **Release docs and comments were realigned:** rulebook notes now describe the configurable forecast export ceiling and the constant post-solar day-ahead checker, and the bundled/public user-guide version markers are aligned to `2.4.20`.
- **Validation and release build completed locally:** `python -m py_compile services\\forecast_engine.py services\\tests\\test_forecast_engine_constraints.py`, `python -m unittest discover -s services\\tests -p "test_*.py"`, `npm run rebuild:native:node`, `node server/tests/smokeGatewayLink.js`, `npm run rebuild:native:electron`, `pyinstaller --noconfirm services\\ForecastCoreService.spec`, and `npm run build:installer` all succeeded.
- **Final local release output is clean:** `release/` contains only `Inverter-Dashboard-Setup-2.4.20.exe`, `Inverter-Dashboard-Setup-2.4.20.exe.blockmap`, and `latest.yml`.

## v2.4.2 Changes - Faster Gateway Inverter Control Batching (2026-03-15)
- **Whole-inverter and selected multi-inverter commands now batch per inverter:** the renderer groups configured node writes into one `/api/write/batch` request per inverter instead of firing one `/api/write` call per node.
- **Gateway-mode start/stop latency is lower:** local and proxied gateway control no longer wait through four separate HTTP request/response cycles for a 4-node inverter before the action completes.
- **The inverter backend now applies batched node writes inside one queued batch job:** `services/inverter_engine.py` exposes `/write/batch`, validates the requested units, and returns per-unit results while keeping the existing queued-write semantics.
- **Smoke validation:** `python -m py_compile services/inverter_engine.py`, `node --check server/index.js`, `node --check public/js/app.js`, and `server/tests/electronUiSmoke.spec.js` all passed on the release tree.

## v2.4.1 Changes - Dense Grid Card Auto-Height and Table Compaction (2026-03-15)
- **Dense inverter-grid cards now collapse to real content height:** in `5`, `6`, and `7` column layouts the inverter cards no longer keep a fixed blank lower area once the node table is shorter than the old card frame.
- **Dense-grid table spacing was compacted without shrinking text:** the node-table header/row heights, cell padding, indicator spacing, and control-cell padding were tightened while leaving the existing font scale intact.
- **Dense-grid width regression was corrected before release:** the temporary `flex: 0 0 auto` wrapper override caused the node table to resolve to an absurd width and visually blank the rows; the final shipped fix keeps the wrapper at `width: 100%` so the table tracks the card width again.
- **Smoke validation:** the live Electron Playwright smoke (`server/tests/electronUiSmoke.spec.js`) passed after the dense-grid CSS changes.

## v2.4.0 Changes - Plant Cap, Remote Proxying, and Forecast/UI Refinements (2026-03-14)
- **Plant output cap controller added:** the Inverters page now has a gateway-side plant-wide MW cap workflow with upper/lower MW banding, whole-inverter sequential stop/start decisions, exemption lists, preview/status reporting, authorization, and controller-owned release handling.
- **Plant cap planning is node-aware:** inverter step size uses current live `Pac` as the primary estimate and scales rated (`997.0 kW`) plus dependable (`917.0 kW`) capacity by enabled node count for fallback and deadband warnings.
- **Remote plant-cap actions are gateway-proxied:** a remote workstation can open the panel and call plant-cap routes through the configured gateway, but a `404` / `Cannot POST /api/plant-cap/...` response means the gateway build is older than the client feature or the remote target is wrong.
- **Plant-cap UI behavior tightened:** the panel is default-collapsed behind the inverter-toolbar toggle, uses theme-token styling in all themes, and exposes hover descriptions on controls, metrics, warnings, and preview headers.
- **Solcast preview export button was rethemed:** the forecast export action now uses a theme-aware export treatment so light-theme forecasting UI stays readable.

## v2.2.32 Changes - Dashboard Readability and Inverter Card Polish (2026-03-14)
- **Wide-screen readability polish:** dashboard typography was rebalanced for large displays, the runtime font baseline returned to `Arial`, and chart/inverter UI sizing was tuned so legends, card titles, and live values stay readable on wide monitors.
- **PAC legend signal colors are now fixed across themes:** the inverter toolbar legend indicators stay green, yellow, orange, red, and blinking red for alarm in `dark`, `light`, and `classic`, instead of inheriting theme-tinted status colors.
- **Inverter card header hierarchy was strengthened:** `INVERTER XX` titles, icons, and badges were scaled to read more clearly without inflating the rest of the card.
- **Inverter PAC strip was compacted and reworked:** card `Start` / `Stop` now sit side-by-side, the old stacked `DC POWER` / `AC POWER` block was replaced by separate inline `Pdc:` and `Pac:` cells, the strip height was shortened, and PAC totals were sized to stay visually above the node-table data.
- **Card table readability was cleaned up:** table headers/body text were normalized, light/classic card-table text tinting was neutralized, and row values were aligned more consistently.
- **Validation:** repeated live Electron UI smoke checks (`server/tests/electronUiSmoke.spec.js`) passed after the frontend CSS/JS changes.

## Default Credentials and Access Keys
- **Login default username:** `admin`
- **Login default password:** `1234`
- **Login admin auth key:** `ADSI-2026`
- **Login reset behavior:** `ADSI-2026` resets sign-in back to `admin` / `1234`
- **Bulk selected inverter control auth key:** `sacupsMM`
  - `MM` is the current minute
  - previous minute is also accepted as tolerance
  - applies only to `START SELECTED` / `STOP SELECTED`
  - per-node and per-inverter controls do not require this key
- **Topology and IP Configuration auth gate key:** `adsiM` or `adsiMM`
  - current minute in unpadded or zero-padded form
  - IP Configuration gate keeps a 1-hour session per window
  - Topology gate keeps a 10-minute session per window
- **No app-seeded defaults:** remote gateway API token, Solcast API/toolkit credentials, and cloud-backup provider credentials must be configured per deployment
- **Secret-storage rule:** live passwords and toolkit credentials must not go into tracked markdown; if the user asks to keep them in markdown, store them only under a git-ignored local path such as `private/*.md`

## Architecture
- **Electron main process:** electron/main.js — windows, IPC, license, process management
- **Express server:** server/index.js — REST API + WebSocket on port 3500
- **Frontend:** public/js/app.js — vanilla JS, Chart.js, multi-theme UI
- **Python services:** ADSI_InverterService.py (FastAPI port 9000, Modbus TCP), ADSI_ForecastService.py (ML forecasting)
- **DB:** SQLite at %APPDATA%\Inverter-Dashboard\adsi.db (migrates from ADSI-Dashboard)

## Key File Paths
- electron/main.js — Electron main
- electron/preload.js — Context bridge
- server/index.js — Express server
- server/db.js — SQLite wrapper
- server/poller.js — Inverter polling (500ms interval)
- server/alarms.js — Alarm decoding (Ingeteam INGECON, 16-bit bitfield)
- server/exporter.js — CSV/Excel export (31 KB)
- public/index.html — Main dashboard UI
- public/js/app.js — Frontend logic
- public/css/style.css — Themes (dark/light/classic)
- ADSI_InverterService.py — FastAPI inverter backend
- ADSI_ForecastService.py — Solar forecast engine (physics + ML)
- drivers/modbus_tcp.py — Modbus TCP wrapper
- ipconfig.json — 27 inverters, IPs, polling intervals

## Data Flow
Modbus TCP → FastAPI (9000) → Express (3500) → SQLite → WebSocket → Browser
Weather APIs → Python forecast → /ProgramData JSON → Express → Browser

## Current-Day Energy Rule
- `TODAY MWh`, analytics `ACTUAL MWh`, and per-inverter `TODAY ENERGY` are PAC-integrated metrics only.
- Authority path: raw PAC telemetry from Python → Node poller integration (`PAC x elapsed time`) → `energy_5min` / current-day snapshot → HTTP/WS/UI/export.
- Python/modbus register kWh and Python `/metrics` energy fields are not authoritative for current-day energy and should not be used to drive display, analytics, or export totals.
- If there is a disagreement between inverter register energy and PAC-integrated day energy, Node PAC integration wins for current-day totals.

## Alarm and Off-Solar Persistence Rules
- Polling continues outside the solar window so the dashboard can still show live status and alarm state.
- Raw telemetry persistence (`readings`, `energy_5min`) is solar-window only, including graceful shutdown flush.
- Alarm and audit persistence remain allowed outside the solar window.
- Alarm sound ignores sub-5-second alarm occurrences.
- If a node already has an active nonzero alarm and the alarm bitmask changes to a different nonzero value, that stays the same active alarm episode:
  - update the active alarm row in place
  - keep its acknowledged state
  - do not treat the change as a new raise
  - do not retrigger the alarm sound

## Hardware
27 inverters (Ingeteam INGECON), 2-4 units each, Modbus TCP, IP 192.168.1.x range.
Polling interval: 0.05s default per inverter.

## Features
Real-time monitoring, 5-min energy resolution, AI solar forecasting, alarm management, audit log, CSV/Excel export, multi-theme UI, license protection, topology view, IP config UI.

## Build
electron-builder: NSIS installer only. Output: release/
Extraresources: InverterCoreService.exe, ForecastCoreService.exe (PyInstaller from ADSI_*.py)
Release size: ~227-228 MB installer
- Hard rule: bump `package.json`, visible version text, and the baseline/version notes in `SKILL.md`, `CLAUDE.md`, and `MEMORY.md` together before a release.
- Hard rule: after the latest release is published, update the markdown docs so release notes, workflow rules, and version baselines remain aligned with what was actually shipped.
- Hard rule: before any EXE build, run the smoke test that matches the changed surface; backend/DB/replication/archive changes require an isolated server smoke test, and Electron/startup changes require a live Electron startup smoke test too.
- Hard rule: push the release commit and release tag before `gh release create`; if GitHub upload/create times out, inspect release state before retrying.
- Hard rule: verify `release/` cleanup instead of assuming it worked; after a default publish keep only installer, blockmap, and `latest.yml`.
- Hard rule: when the user says `publish latest release`, rebuild only the affected program EXEs, build the installer release, and publish only the installer assets to GitHub.
- Hard rule: clean installer builds must not embed workstation-local runtime state such as `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, Chromium cache/storage folders, or customer exports.
- `better-sqlite3` is runtime-ABI specific:
  - `npm run rebuild:native:node` for plain Node shell checks
  - `npm run rebuild:native:electron` before Electron launch/build after any Node-ABI rebuild
  - if desktop startup fails with a `NODE_MODULE_VERSION` mismatch for `better-sqlite3`, rebuild for Electron immediately
- Some shells in this workspace export `ELECTRON_RUN_AS_NODE=1`.
  - Direct `electron.exe ...` launches and Playwright/Electron probes will act like plain Node unless that env var is removed.
  - This can surface misleading launch errors like `Unable to find Electron app ...`.
  - Clear the env var or use `start-electron.js`-style launch semantics for Electron UI work.
- Live Electron UI smoke:
  - `Push-Location server/tests`
  - `npx playwright test electronUiSmoke.spec.js --reporter=line`
  - `Pop-Location`
  - Run the Playwright smoke from `server/tests` so duplicate scratch specs under `.tmp/` do not get discovered.
  - Covers dashboard metrics, Energy Summary Export single-date UI, and Settings connectivity rendering in the real Electron window.
- Gateway metric authority smoke sequence:
  - `npm run rebuild:native:node`
  - `node server/tests/smokeGatewayLink.js`
  - `node server/tests/modeIsolation.test.js`
  - `npm run rebuild:native:electron`
  - `Push-Location server/tests`
  - `npx playwright test electronUiSmoke.spec.js --reporter=line`
  - `Pop-Location`
- Inverter detail panel rule:
  - Do not block initial detail stats/alarms on the 7-day `/api/report/daily` history fetch.
  - Recent history is best-effort and should use a bounded timeout.

## Default Release Publish Workflow
- Current latest published GitHub release: `v2.4.32`
- Current repo/package baseline: `v2.4.32`
- Default meaning of `publish latest release`:
  - determine which program surfaces changed
  - rebuild only the affected Python service EXEs in `dist/`
  - run the required smoke tests for the changed surface
  - run `npm run rebuild:native:electron`
  - build the installer with `npm run build:installer`
  - publish only these assets to GitHub:
    - `Inverter-Dashboard-Setup-<version>.exe`
    - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
    - `latest.yml`
  - do not expect or upload a portable EXE from the current package config
- Changed-program rebuild mapping:
  - inverter-service code/spec changes -> rebuild `dist/InverterCoreService.exe`
  - forecast-service code/spec changes -> rebuild `dist/ForecastCoreService.exe`
  - shared Python or driver changes that affect both -> rebuild both service EXEs
  - Electron/server/frontend-only changes -> do not rebuild Python service EXEs unless packaging depends on changed Python binaries

## Archive Replication Rule
- Manual archive pull/upload must stage monthly archive `.db` replacements while the app is running and apply them only on restart.
- Never overwrite or rename a live monthly archive DB in place during runtime.
- If a newer archive replacement is staged, archive manifest and archive download should expose that staged version immediately so later sync logic sees the newest content before restart.

## Replication Transport Rule
- Keep remote replication fast by default: reuse HTTP connections, gzip large replication JSON payloads, and gzip large main-DB / archive downloads when the peer accepts it.
- Keep hot-data push uploads chunked; large JSON push batches may be gzip-compressed in transit.
- Archive pull/push may run with small bounded concurrency, but restart-safe staging and deterministic failure handling still take priority over raw throughput.
- Transfer-monitor semantics must remain accurate after transport changes. Byte progress and phase reporting are part of the contract.

## Completed Overhaul (2026-02)
Full 4-phase in-place overhaul completed. Key changes:
- **Security:** AES-256-GCM remembered passwords, random initial passwords, random admin auth key, execFile for taskkill, Electron webSecurity enabled everywhere
- **Context bridge:** Consolidated to single `window.electronAPI` object; all `window.electron.*` references removed
- **server/ws.js:** Dead connection cleanup on send failure
- **server/db.js:** Configurable audit retention (`auditRetainDays` setting)
- **server/poller.js:** Fixed KWH 32-bit overflow (multiplication vs left-shift), MAX_PAC_DT_S raised 5→30
- **server/alarms.js:** Module-level prepared statement for audit inserts, input validation in logControlAction
- **server/exporter.js:** Path traversal guard in resolveExportDir, date bounds checking, filename truncation to 200 chars
- **server/index.js:** Fixed uptime calc, atomic settings update, forecast race lock, timezone regex allows dots
- **public/index.html:** All 31+ inline event handlers removed; IDs added to all buttons; aria-live on metric elements
- **public/js/app.js:** bindEventHandlers() function; wsConnecting guard; DocumentFragment in buildInverterGrid; firstChild.nodeValue for totalPac/totalKwh; all catch(_) replaced with logging; timer refs stored; beforeunload cleanup

## Cloud Backup Feature (2026-03-04)
Full cloud backup/restore feature implemented. Key files:
- server/tokenStore.js — AES-256-GCM encrypted OAuth token storage (machine-derived key)
- server/cloudProviders/onedrive.js — Microsoft Graph API, OAuth PKCE (no client secret needed)
- server/cloudProviders/gdrive.js — Google Drive API v3, installed app OAuth flow
- server/cloudBackup.js — Core backup service (local-first, retry queue, schedule, restore)
- server/index.js — API routes: /api/backup/* (settings, auth, now, history, pull, restore, delete)
- public/index.html — Cloud Backup card in Settings page
- public/js/app.js — cbLoadSettings, cbSaveSettings, cbBackupNow, cbConnectProvider, etc.
- public/css/style.css — Cloud Backup panel styles
- electron/main.js — oauth-start IPC handler (BrowserWindow + webRequest intercept)
- electron/preload.js — openOAuthWindow bridge

OAuth flow: frontend → /api/backup/auth/:provider/start → Electron opens BrowserWindow → intercepts localhost:3500/oauth/callback/:provider → returns callbackUrl → frontend POSTs code to /api/backup/auth/:provider/callback → server exchanges for tokens.

User must register their own OAuth app:
- OneDrive: Azure AD app registration, redirect URI http://localhost:3500/oauth/callback/onedrive, PKCE public client
- Google Drive: GCP project, Desktop app type, redirect URI http://localhost:3500/oauth/callback/gdrive

## MWh Handoff (2026-03-05)
Remote→Gateway mode switch continuity hardened:
- `gatewayHandoffMeta` — in-memory handoff lifecycle: active, startedAt, day, baselines (per-inverter shadow kWh at switch time)
- `MAX_SHADOW_AGE_MS = 4h` — stale same-day shadow discarded unless handoff active
- `getRemoteTodayEnergyShadowRows()` — age check; clears+persists when stale
- `_checkHandoffCompletion(pollerMap, day)` — auto-completes handoff when all baselines met; logs elapsed time
- `getTodayEnergySupplementRows()` — logs carry_applied/caught_up per inverter, calls completion check
- `applyRuntimeMode()` — captures per-inverter baselines on Remote→Gateway switch; logs handoff start
- Test harness: `server/tests/mwhHandoff.test.js` (24 passing: Scenarios A-E, including timeout)
- `server/mwhHandoffCore.js` — shared pure logic imported by tests (created by user)

## v2.3.15 Changes - Gateway Today-MWh Release Guardrails (2026-03-13)
- **Gateway live TODAY MWh regression guard was added:** `server/tests/smokeGatewayLink.js` now asserts that gateway-mode live WS payloads are enriched with `todayEnergy`, that the server merges cached DB totals with live supplement rows, and that the client keeps WS `todayEnergy` authoritative once live updates start.
- **Empty WS todayEnergy payloads stay valid:** the release guard also checks that the renderer accepts an empty `todayEnergy` array instead of treating it as “missing”, which prevents stale non-WS fallback logic from reclaiming TODAY MWh authority.

- **Gateway metric fallback smoke procedure is now fixed:** the release workflow now explicitly runs `rebuild:native:node` -> `smokeGatewayLink.js` -> `rebuild:native:electron` -> Playwright Electron smoke from `server/tests`, because running Playwright from the repo root can pick up duplicate `.tmp` specs and produce a false failure.
- **Smoke run confirmed on 2026-03-13:** `node server/tests/smokeGatewayLink.js` passed (`32` checks), then `server/tests> npx playwright test electronUiSmoke.spec.js --reporter=line` passed (`1` test).

## Current-Day Energy Authority Cleanup (2026-03-13)
- **Register-based day-energy fallback was removed from the Node poller:** `TODAY MWh`, analytics `ACTUAL MWh`, and per-inverter `TODAY ENERGY` now stay PAC-integrated only for current-day authority.
- **Python inverter service no longer exposes current-day energy fields in `/metrics`:** the service remains responsible for raw telemetry acquisition, while Node remains the sole authority for current-day energy computation and export/display alignment.

## v2.3.15 Changes - Standby Pull Credibility + Gateway-Load Hardening (2026-03-14)
- **Manual pull is read-only and guarded again:** `server/index.js` now restores a local-newer preflight before standby pull, returns `LOCAL_NEWER_PUSH_FAILED` with `canForcePull: true`, and never auto-pushes as a side effect of pull.
- **False local-newer blocks were removed:** the preflight now ignores local-only remote-client `settings` drift, so a standby workstation changing its own gateway URL, token, or mode settings does not incorrectly block a pull.
- **Blocked standby pulls stay cheap on the gateway:** background pull preflight now happens before the live-stream pause and before any main-DB or archive transfer starts, and explicit `Force Pull` skips redundant summary prechecks to avoid extra gateway round trips.
- **Failed standby pulls no longer leave staged replacement state behind:** ordinary pull failures now discard staged main-DB and archive manifests plus temp downloads immediately instead of cleaning them only on operator cancel.
- **Operator messaging is explicit:** `public/js/app.js` now turns `LOCAL_NEWER_PUSH_FAILED` into a `Force Pull` confirmation instead of a generic error so overwrite intent is always explicit.
- **Focused regression coverage was added:** `manualPullGuard.test.js`, `manualPullFailureCleanup.test.js`, `manualReplicationCancel.test.js`, `modeIsolation.test.js`, `standbySnapshotReadOnly.test.js`, `remoteTodayShadow.test.js`, and `mwhHandoff.test.js` all passed after the hardening.
- **Validation workflow used for this change:** run Node syntax checks and isolated server regression tests first, then restore `better-sqlite3` for Electron with `npm run rebuild:native:electron` before desktop launch/build.

## v2.3.15 Changes - Restart/Update Child-Service Soft Stop (2026-03-14)
- **Restart/update shutdown now asks child services to exit cleanly first:** `electron/main.js` writes per-service stop files, passes both `IM_SERVICE_STOP_FILE` and `ADSI_SERVICE_STOP_FILE`, waits bounded grace windows, and only then falls back to force-kill.
- **The inverter backend now exits `uvicorn` cleanly on restart/install:** `services/inverter_engine.py` watches the service stop file, marks `server.should_exit = True`, and clears stale stop markers on startup/shutdown.
- **The forecast engine now honors stop requests during idle waits and run boundaries:** `services/forecast_engine.py` checks for the stop file between loop sleeps and before write-heavy forecast steps so restart/install does not rely on hard kill while forecast work is mid-flight.
- **This directly targets stale-after-restart risk:** the old child-service shutdown path could still end in hard `taskkill /f /t` while forecast/background writes were active, which was the most credible remaining source of stale or partial runtime state after `Restart & Install`.
- **Regression coverage was added for the contract itself:** `server/tests/serviceSoftStopSource.test.js` asserts the Electron stop-file contract plus inverter/forecast stop-file handling.
- **Validation completed:** `node server/tests/serviceSoftStopSource.test.js`, `python -m py_compile services\\inverter_engine.py services\\forecast_engine.py`, `node server/tests/smokeGatewayLink.js`, `node server/tests/dbPathEnvCompat.test.js`, and the Electron Playwright smoke all passed after the hardening.

## Clean Local Release Rebuild (2026-03-14)
- **Both Python service EXEs were rebuilt before packaging:** `services/inverter_engine.py` and `services/forecast_engine.py` changed, so both `dist/InverterCoreService.exe` and `dist/ForecastCoreService.exe` were rebuilt with PyInstaller before the final Electron package build.
- **Final local package build was rerun after the EXE rebuilds:** `npm run build:win` was executed only after both refreshed service EXEs were back in `dist/`.
- **Local release output now matches the final rebuild:** `release/` contains `Inverter-Dashboard-Setup-2.3.15.exe`, `Inverter-Dashboard-Setup-2.3.15.exe.blockmap`, and `latest.yml`.
- **This was a local rebuild only:** GitHub release state was not changed or published yet.

## Analytics Day-Ahead Export Format Alignment (2026-03-14)
- **Analytics export now supports the same `Standard` / `Average Table` choice used by the Solcast forecast export:** the analytics side card adds a shared export-format selector instead of forcing the old interval-sheet-only XLSX path.
- **Average-table analytics export now stays Solcast-clean:** when `Average Table` is selected, `server/exporter.js` writes only the day-ahead generation workbook in the same hour-by-minute tableized-average layout used by the Solcast export, without the comparison-style summary/extra sheets.
- **The format selection is shared across Analytics and Forecast:** `public/js/app.js` keeps the analytics and Solcast export-format controls in sync so operators do not end up with two competing format choices.
- **Forecast exports are now split inside the same `Forecast` root:** analytics day-ahead exports are written to `All Inverters\\Forecast\\Analytics`, while Solcast preview exports are written to `All Inverters\\Forecast\\Solcast`, so the two workspaces no longer mix files in one flat folder.
- **The export page now honors the same selected forecast format:** the day-ahead export card uses the shared `Standard` / `Average Table` selector, and `Average Table` forces `.xlsx` so the UI matches the workbook-only backend path.
- **Legacy flat forecast outputs are repaired automatically:** `server/index.js` and `server/exporter.js` relocate old `All Inverters\\Forecast\\<file>` results into `Forecast\\Analytics` or `Forecast\\Solcast`, so standard comparison files no longer leak into the flat `Forecast` root.
- **Shared forecast export format now has an authoritative UI state:** `public/js/app.js` stores the selected forecast export mode in app state before reading any page-local selector, preventing a newly rendered forecast control from silently snapping the mode back to `Standard`.
- **All XLSX exports now use a polished workbook style:** `server/exporter.js` applies fitted column widths, filled headers, bordered data cells, highlighted totals, and styled summary sheets across the shared XLSX writer, while the custom average-table sheets now use stronger header/side/average fills and row sizing.
- **Focused regression coverage was added:** `server/tests/forecastActualAverageTable.test.js` checks the average-table data shaping and the analytics UI wiring for the shared export-format selector.

## Installer-Only Packaging Config (2026-03-14)
- **Portable packaging was removed from `package.json`:** the Windows target list now includes only `nsis`, the `portable` artifact block was removed, and there is no `build:portable` script.
- **Both local build commands are now equivalent for packaging scope:** `npm run build:win` and `npm run build:installer` both produce the installer-only release set.
- **Docs were aligned with the new package baseline:** `SKILL.md`, `CLAUDE.md`, and the user manual now describe installer-only release artifacts while keeping the portable data-root path documented only as a legacy compatibility note.
- **Installer rebuild was rerun after the package change:** the refreshed local `release/` folder now contains only `Inverter-Dashboard-Setup-2.3.15.exe`, `Inverter-Dashboard-Setup-2.3.15.exe.blockmap`, and `latest.yml`.

## Windows Elevation Policy (2026-03-13)
- **Installed app should always launch elevated:** `package.json` now sets Windows `requestedExecutionLevel` to `requireAdministrator` so newly built installers stamp the app executable with an always-admin manifest.
- **This affects future builds only:** existing installed copies do not change until rebuilt/reinstalled from a package that includes the updated manifest.

## Alarm Episode and Off-Solar Logging Cleanup (2026-03-13)
- **Short alarm blips no longer trigger audio:** renderer alarm sound now waits for an unacknowledged alarm to stay active for at least 5 seconds before starting sound.
- **Active-alarm bitmask expansion stays one episode:** when a node changes from one nonzero alarm value to another nonzero value, the backend updates the same active alarm row instead of inserting a fresh raise event, preserving acknowledgment state and preventing sound retrigger.
- **Shutdown flush now respects the solar window:** off-window graceful shutdown no longer persists raw `readings` / `energy_5min` rows that would bypass the normal solar-window write gate.
- **Verification completed:** `alarmEpisodeCore.test.js`, `smokeGatewayLink.js`, and the Electron Playwright smoke all passed after the change.

## v2.3.14 Changes - Update Install Metrics Recovery + Safer Shutdown (2026-03-13)
- **Update install now waits for runtime shutdown:** `electron/main.js` routes normal exit, restart, license shutdown, and updater install through one coordinated shutdown path so the app does not exit before the local server flushes SQLite and closes cleanly.
- **Embedded server shutdown is now awaitable:** `server/index.js` returns a promise from the embedded shutdown path and guards double-close so updater-triggered restarts can wait for DB flush completion instead of racing the process exit.
- **Legacy data-path compatibility was restored:** the runtime now accepts both `IM_*` and `ADSI_*` data-dir env names across Electron, Node, and Python service layers, preventing updated builds from reading a different DB/config location than the shell configured.
- **Older userData folders now migrate forward:** Electron now also checks legacy `Inverter Dashboard` / `Dashboard V2` userData folder names so auth and config files are not stranded after branding-era updates.
- **Regression coverage was added for env-path compatibility:** `server/tests/dbPathEnvCompat.test.js` verifies the new env-resolution fallback and precedence rules.

## v2.3.13 Changes - Forecast Backtest + Refined Forecast Export (2026-03-13)
- **Day-ahead forecast replay/backtest was added:** `services/forecast_engine.py` now exposes replay-oriented training state reuse, richer forecast metrics, and CLI backtest modes (`--backtest-range`, `--backtest-days`) that score historical day-ahead runs against saved forecast-weather snapshots without overwriting live forecast rows.
- **Forecast QA now logs more decision-useful metrics:** daily QA includes `WAPE`, `MAPE`, total-energy absolute percentage error, and first/last active-slot timing error instead of only `MAPE`, `MBE`, and `RMSE`.
- **Forecast export XLSX now carries a summary sheet:** `server/exporter.js` now writes a `Summary` worksheet for day-ahead vs actual exports so the file includes actual total, day-ahead total, variance, peak interval, absolute error total, `WAPE`, and mean absolute percentage error alongside the interval table.
- **Forecast interval export was simplified to MWh-only columns:** the analytics day-ahead export now omits `kWh` columns and keeps the interval sheet focused on `MWh` values, absolute `MWh` delta, and absolute error percentage.

## v2.3.11 Changes - Guarded Mode Switching + Standby Baseline Handoff (2026-03-12)
- **Mode changes are now guarded in the UI:** `public/js/app.js`, `public/index.html`, and `public/css/style.css` add a blocking transition overlay and readiness waits so the dashboard does not keep serving normal actions while switching between `gateway` and `remote`.
- **Gateway mode now hard-stops upstream remote traffic:** `server/index.js` aborts any in-flight remote live/chat/today-energy fetches, closes the remote live WebSocket, and stops remote chat polling immediately when the workstation returns to `gateway` mode, so a local gateway no longer keeps listening to another gateway device.
- **Standby pull is lighter on the gateway now:** `server/index.js` no longer forces a full current-day report rebuild from raw readings on every main-DB snapshot request, reuses the cached main-DB snapshot for its TTL instead of discarding it after each transfer, and keeps priority archive pull concurrency at `1` to reduce gateway lag during manual pull.
- **Remote Today MWh is gateway-authoritative again:** `server/index.js` now treats fresh gateway `todayEnergy` rows as authoritative in `remote` mode, scopes the fallback shadow to the active gateway source, and clears stale bridge state when the source changes.
- **Standby refresh now carries the current-day gateway baseline:** before a standby snapshot is transferred, the gateway persists today's partial report state; the remote also refreshes and preserves the current-day gateway today-energy shadow so `Refresh Standby DB -> Restart -> Gateway` does not fall back to older partial-day totals while the local poller catches up.
- **Regression coverage expanded:** `server/tests/remoteTodayShadow.test.js` now covers same-source fallback, cross-gateway shadow rejection, remote-display handoff capture, and preserved shadow behavior after standby restart.
- **Mode handoff regression coverage was added:** `server/tests/modeIsolation.test.js` verifies that `remote` mode opens the gateway live/chat transports and that switching back to `gateway` closes the upstream WebSocket and stops upstream chat polling immediately.

## Performance Optimization (2026-03-05)
Tab-switch "Not Responding" eliminated. Key changes:
- **server/db.js:** Added `idx_e5_ts ON energy_5min(ts)` for range-scan queries
- **server/index.js (N+1 fix):** `buildDailyReportRowsForDate` now uses 3 batch SQL queries instead of 81 per-inverter queries (27×readings + 27×alarm_count + 27×audit_count → 3 queries): ~15× faster report generation
- **server/index.js (row cap):** `/api/energy/5min` unpaged path and `/api/analytics/energy` capped at 50,000 rows via `ENERGY_5MIN_UNPAGED_ROW_CAP`; returns 400 if exceeded
- **server/index.js (perf headers):** `X-Perf-Ms` header on /api/alarms, /api/audit, /api/energy/5min, /api/report/daily
- **public/js/app.js (stale tab cache):** `State.tabFetchTs{}` + `TAB_STALE_MS=60000`; initAlarmsPage/initEnergyPage/initAuditPage/initReportPage skip re-fetch and re-render from State if data is <60s old; `State.tabFetching{}` in-flight guard
- **public/js/app.js (loading state):** `showTableLoading(tbodyId, colspan)` helper shows "Loading…" row before fetch; called in fetchAlarms/fetchAudit/fetchReport
- **public/js/app.js (DocumentFragment):** renderAlarmTable, renderAuditTable, renderReportTable, renderEnergyTable all now use DocumentFragment + single `tbody.textContent=""` + `appendChild(frag)` instead of per-row `appendChild`

## v2.2.23 Changes — Gateway Main-DB Pull + Hot Transfer Monitor Hardening (2026-03-09)
- **Manual pull now stages the gateway main DB:** `runManualPullSync` reconciles local-newer hot data first, then downloads a fresh gateway `adsi.db` snapshot, stages it locally, and applies it on restart instead of mutating the live remote DB table by table.
- **Gateway DB snapshot stays consistent while the server is running:** the gateway flushes pending poller telemetry and exports the main DB through SQLite's online backup API before streaming it, so the pulled file is a transactionally consistent snapshot rather than a direct copy of the live `adsi.db`.
- **Remote-only settings are restored after DB takeover:** after restart, the staged gateway DB becomes the local DB, then the client's local-only remote settings (`operationMode`, `remoteAutoSync`, gateway URL/token, tailnet hint/interface, `csvSavePath`) are restored.
- **Transfer Monitor now covers hot-data DB transfer clearly:** main-DB pull/send emits byte-based `xfer_progress`, and inbound hot-data push RX now includes total bytes so the monitor can show proper percentage instead of only indeterminate progress.
- **Manual push final consistency now uses the gateway main DB too:** after sending local hot data to the gateway, the client stages the final gateway `adsi.db` back locally for restart-safe consistency.

## v2.2.31 Changes — Energy Summary Export Cleanup (2026-03-10)
- **Header icon-only controls were diagnosed as CDN-font dependent:** the top-right alarm/menu controls are icon-only MDI buttons, so when the icon stylesheet is unavailable they render as empty squares instead of showing a visible fallback.
- **Energy Summary export dropped per-inverter subtotal rows:** the export now keeps node detail rows and the bottom `DAY TOTAL` row while removing the extra per-inverter `TOTAL` lines.
- **Energy Summary export now uses a single date selector:** the export card and persisted export UI state were migrated from `From`/`To` to one `Date` field, with legacy saved values collapsing safely into the new single-day control.
- **Energy Summary filenames now match single-day exports:** same-day exports now write `DDMMYY <target> Energy Summary` instead of the generic date-range `Recorded Energy` naming.

## v2.2.30 Changes — Solcast Toolkit Preview Date-Range Fix (2026-03-10)
- **Start Day and Days to Display now follow actual toolkit feed dates:** the Solcast preview/export server path now sizes the toolkit `recent` fetch horizon from the selected start day plus the requested display span, instead of only from the display count.
- **Later preview start dates no longer get clipped to the first returned day:** preview and XLSX export now fetch enough hours to enumerate the feed's available days before slicing the selected range.
- **Existing client-side day-count limits now work against real returned availability:** once the server returns the full day list, the `Start Day` and `Days to Display` selectors correctly clamp to the dates actually exposed by the Solcast URL.

## v2.2.29 Changes — Remote Gateway Link Hotfix (2026-03-10)
- **Remote live bridge no longer self-fails after a successful gateway fetch:** `server/index.js` now imports `checkAlarms` before the remote live-ingest path calls it, which fixes the runtime `checkAlarms is not defined` fault.
- **Gateway Link now reports the real live state again:** because the post-fetch ingest no longer throws, `/api/runtime/perf`, `/api/runtime/network/reconnect`, and the Settings health panel can stay `connected` instead of falling back to `disconnected`.
- **Inverter cards receive live remote rows again:** the remote bridge now finishes the live broadcast path, so retained/live remote node data reaches `/api/live` and the renderer repopulates the inverter cards instead of staying blank/offline.

## v2.2.28 Changes — Remote Operation Mode Health Hardening (2026-03-10)
- **Remote health model is now explicit:** `server/index.js` now classifies remote live-bridge runtime as `connected`, `degraded`, `stale`, `disconnected`, `auth-error`, or `config-error` instead of only exposing a binary connected flag.
- **Short outages no longer blank the plant view immediately:** the remote bridge retains the last-good live snapshot for a bounded stale window, keeps `/api/live` populated from that retained snapshot, and marks the UI as degraded or stale instead of dropping straight to empty cards.
- **Failure reasons are operator-safe and specific:** live-bridge failures are classified into URL/config issues, auth failures, timeouts, connection refusal, DNS/route failures, socket resets, and bad payloads so `Gateway Link` and `Last Errors` can show the real cause.
- **Manual reconnect is no longer falsely green:** `/api/runtime/network/reconnect` now reports degraded/stale reconnects honestly, and the frontend surfaces that instead of treating every retained-snapshot refresh as a full recovery.
- **Inverter cards now distinguish stale from offline:** `public/js/app.js` and `public/css/style.css` add bounded stale rendering with a dedicated `STALE` badge and stale card styling, while preserving offline as the hard-disconnect state.

## v2.2.27 Changes — Remote Live Bridge Reconnect Hardening (2026-03-10)
- `Test Remote Gateway` and remote settings save now refresh the live remote bridge immediately instead of waiting for the next backoff tick.
- Added a dedicated runtime reconnect path so `Gateway Link` health and the inverter live cards reattach as soon as saved remote connectivity is valid.
- The UI now warns when a gateway test succeeded only with unsaved URL/token form values, which prevents the green test / disconnected runtime mismatch.

## v2.2.26 Changes — Forecast Integrity and Solcast-Aware ML Local Forecasting (2026-03-10)
- `ml_local` now consumes `solcast_snapshots` as a prior when available, builds a hybrid baseline, and preserves native Solcast PT5M shape instead of treating Solcast as a separate disconnected provider only.
- Forecast analytics reads are now DB-only. `/api/analytics/dayahead` and intraday-adjusted reads no longer mutate the DB by pulling from the Python context file during GET requests.
- Startup legacy context import is now guarded: it only runs when `forecast_dayahead` is empty, which prevents stored DB forecasts from being overwritten on restart.
- Solcast snapshot failures are now surfaced back to the operator as non-fatal warnings in test / preview / generate paths instead of being silently swallowed.

## v2.2.25 Changes — Replication Separation, Transfer Integrity, and Solcast Snapshot Persistence (2026-03-10)
- **Pull and Push are now strictly separated:** manual `Pull` is download-only, manual `Push` is upload-only, and startup auto-sync uses the same read-only local-newer check instead of auto-pushing gateway changes as a side effect. The leftover `/api/replication/reconcile-now` path was also hardened so it no longer modifies gateway data before a catch-up pull.
- **Transfer integrity is validated before apply:** main-DB and archive transfers now carry SHA-256 headers, downloaded/staged files are verified against size and hash, and staged SQLite replacements must pass header validation plus `PRAGMA quick_check(1)` before they can replace the live DB on restart.
- **Remote shutdown and health state were hardened:** embedded shutdown now stops the remote bridge before DB close, and reconcile health fields are updated by the new read-only pre-pull checks so status panels do not keep stale push-era state.
- **Solcast snapshots are now persisted:** toolkit/API fetches now normalize `PT5M` forecast and estimated-actual values into the new `solcast_snapshots` table, storing both raw `MW` and slot `kWh` for preview, export, reproducible day-ahead traces, and future ML hybrid work.
- **Release verification was expanded:** isolated server smoke confirmed pull stays read-only, push stays upload-only, reconcile-now no longer pushes, and live Electron startup smoke reached `/api/settings` before packaging.

## v2.2.24 Changes — Solcast Toolkit, Export Rehab, Remote Hardening, and Faster Replication (2026-03-09)
- **Solcast toolkit workflow added and hardened:** the Forecast settings now support `Toolkit Login` as a first-class Solcast access mode with chart URL, email, and password. Toolkit test, preview, and XLSX export stay local even in Remote mode, and the preview charts/export support `PT5M`, `05:00-18:00`, `1-7` selected days, and both `MWh` and raw `MW` values.
- **Solcast preview UI improved:** the settings layout and preview chart styling were cleaned up, the preview is no longer hidden just because runtime forecast provider stays on `Local ML`, and the export path now writes the currently displayed toolkit range.
- **Energy Summary export rehabilitated:** the export now follows the stricter output format, writes numeric XLSX values, uses PAC-based energy logic, and in Remote workflows relies on the local DB working copy after pull/live mirror instead of direct gateway fetch at export time.
- **Remote-mode behavior hardened:** operation-mode handling now respects the active saved mode, remote URL validation is stricter, remote live data mirrors locally after pull, and manual pull keeps the local DB as the machine's working copy while replacing stale state safely from the gateway snapshot.
- **Replication transport speed-up:** `server/index.js` now uses keep-alive HTTP/HTTPS agents for gateway transfer requests, larger incremental/push chunk sizes, gzip on large replication JSON payloads, gzip on large main-DB and archive downloads, gzip request bodies for large JSON push batches, and small bounded archive transfer concurrency.
- **Transfer path validation:** isolated smoke tests confirmed gzipped incremental pull, gzipped main-DB transfer, gzipped archive download, gzipped push request handling, and live Electron startup smoke reached `/api/settings`.

## v2.2.22 Changes — Restart-Safe Archive Apply (2026-03-09)
- **Archive staging instead of live swap:** manual archive pull/upload now keeps the current monthly `.db` live while the app is running, stages the downloaded/uploaded replacement in `archive/*.tmp`, and applies it only on the next restart.
- **Restart apply path:** startup now applies pending staged archive replacements before the server begins serving requests, so the newer archive file becomes active immediately after restart without the Windows `EPERM` rename race.
- **Manifest/transfer consistency:** archive manifest and archive download now surface the staged replacement immediately, so follow-up sync decisions and archive transfers see the newest content even before restart.

## v2.2.21 Changes — Authoritative Pull/Push Hardening + Transfer Monitor Polish (2026-03-09)
- **Authoritative merge:** `mergeAppendReplicationRow` and `mergeUpdatedReplicationRow` now accept `authoritative` flag; in auth mode, LWW `WHERE COALESCE(excluded.updated_ts,0) >= ...` guards are removed for all tables (`readings`, `energy_5min`, `settings`, `forecast_dayahead`, `forecast_intraday_adjusted`, `daily_report`, `daily_readings_summary`, `alarms`). Separate `stmtCached` keys used (e.g. `"merge:daily_report:auth"`) to avoid poisoning LWW cache entries. `audit_log` stays append-only. `REMOTE_REPLICATION_PRESERVE_SETTING_KEYS` always wins even in auth mode.
- **Reconcile-before-pull:** `runManualPullSync` now runs a reconcile step (Step 0) before the authoritative pull — pushes local-newer data to gateway first; if reconcile push fails and local is newer, throws `LOCAL_NEWER_PUSH_FAILED` (code) with `canForcePull: true`; accepts `forcePull` param to skip reconcile gate.
- **`LOCAL_NEWER_PUSH_FAILED` background gap fix:** `startManualReplicationJob` catch block now stores `errorCode: String(err?.code || "")` in failed job. `handleReplicationJobUpdate` detects `job.errorCode === "LOCAL_NEWER_PUSH_FAILED" && job.action === "pull"` and shows "Force Pull?" confirm dialog instead of plain error.
- **xfer_progress labels:** `pushDeltaInChunks`, `runRemoteIncrementalReplication`, `runRemoteCatchUpReplication` accept `opts.label`; all manual pull/push/reconcile/archive call sites pass descriptive labels ("Reconciling with gateway", "Applying gateway data", "Pushing local data", "Pulling final gateway state", "Downloading/Uploading archive files").
- **Transfer Monitor phase badge:** `#xferPhaseBadge` span added to `.xfer-panel-row` in `index.html`. `getXferPhaseBadge(x)` helper maps label+phase to badge text/class. Seven CSS classes: `xfer-phase-pull/push/reconcile/applying/archive/done/error`.
- **Pull/push confirm dialogs:** Updated to explicitly state gateway-overwrites-local semantics and list preserved local-only settings.
- **`/api/replication/pull-now`:** Destructures `forcePull` from body; passes to `runManualPullSync`; sync path returns HTTP 409 with `code:"LOCAL_NEWER_PUSH_FAILED"` on reconcile failure.
- **Startup auto-sync and live bridge polling keep LWW** (`authoritative: false`); only manual pull is authoritative.
- **Manual pull is now staged main-DB replace:** `runManualPullSync` reconciles local-newer hot data first, then downloads a transactionally consistent gateway `adsi.db` snapshot through `/api/replication/main-db`, stages it locally, and applies it on restart. The live remote DB stays unchanged until restart. Only the client-local remote settings (`operationMode`, `remoteAutoSync`, gateway URL/token, tailnet hint/interface, `csvSavePath`) are restored after the gateway DB takes over.
- **Gateway main DB export is snapshot-based:** the server flushes pending poller telemetry, creates a consistent SQLite snapshot with `db.backup(...)`, and streams that snapshot file. It does not stream the live `adsi.db` file directly while the gateway is running.

## v2.2.16 Changes (2026-03-08)
- **Operator messaging panel:** `chat_messages` table on gateway (500-row retention); 3 API routes `/api/chat/send|messages|read`; remote proxy + 5 s poll loop; floating `#chatBubble` + slide-in `#chatPanel`; `appConfirm`-style UX; `playChatSound()` via shared `getOrCreateAlarmAudioCtx()`; `markChatRead` in-flight guard + pending queue; alarm bell left / chat bubble right — no overlap
- **`renderChatThread` DocumentFragment:** converted to match `renderAlarmTable` / `renderReportTable` pattern

## v2.2.15 Changes (2026-03-08)
- **Availability fix:** `/api/report/daily` range handler now splices live `getDailyReportRowsForDay(today, { includeTodayPartial: true })` when today is in range — fixes stale persisted value
- **Detail panel refresh:** 60 s timer fetches both `/api/energy/today` (kWh) and `/api/report/daily?date=today` (availability); merges fresh today rows into `State.invDetailReportRows`
- **PAC thresholds:** ≥90% High, >70% Moderate, >40% Mild, ≤40% Low; `NODE_RATED_W = 249,250 W`; `.row-pac-high/mid/low/off` CSS classes
- **PAC legend:** Static `.pac-legend-wrap` in inverter toolbar; `|` separators via CSS `::before`; High/Moderate/Mild/Low/Alarm hierarchy
- **Startup tab prefetch:** `prefetchAllTabs()` fires 2 s after `init()`, pre-warms all 4 tabs; `TAB_STALE_MS` = 60 s
- **App confirm modal:** `appConfirm(title, body, {ok, cancel})` → Promise<bool>; `#appConfirmModal` in HTML, `.confirm-dialog` in CSS, `initConfirmModal()` called from `init()`; all 9 `confirm()` + 5 `alert()` calls in app.js replaced

## Notes
- See detailed-review.md for first project review findings
