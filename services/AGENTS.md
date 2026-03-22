# services/AGENTS.md

Python-layer rules for Codex and other coding agents working in `services/`.
Root `AGENTS.md` and `SKILL.md` still apply — this file adds Python-specific depth.

---

## Key Files in This Layer

| File | Purpose |
|---|---|
| `inverter_engine.py` | FastAPI inverter backend, Modbus TCP polling, node management |
| `forecast_engine.py` | ML solar forecasting, day-ahead generation, QA, backtest |
| `shared_data.py` | Shared state between inverter and forecast services |
| `InverterCoreService.spec` | PyInstaller spec for inverter service EXE |
| `ForecastCoreService.spec` | PyInstaller spec for forecast service EXE |
| `tests/` | Python unit tests for forecast engine |

Root-level entry points (`InverterCoreService.py`, `ForecastCoreService.py`) are thin
launchers only — the real logic lives here in `services/`.

---

## EXE Build Rules

- Rebuild only the changed service EXE before any Electron build or release:
  - inverter-service changes → `pyinstaller --noconfirm services\InverterCoreService.spec`
  - forecast-service changes → `pyinstaller --noconfirm services\ForecastCoreService.spec`
  - shared changes (`shared_data.py`, `drivers/modbus_tcp.py`) → rebuild both
- Do not publish or hand off if EXEs were built against stale Python binaries.
- After rebuilding Python EXEs, always run `npm run rebuild:native:electron` before the Electron build.

---

## Python Syntax Check

```powershell
python -m py_compile services\inverter_engine.py
python -m py_compile services\forecast_engine.py
python -m py_compile services\shared_data.py
```

Run Python unit tests:
```powershell
python -m unittest discover -s services\tests -p "test_*.py"
```

---

## Inverter Service Rules

- `inverter_engine.py` is a **raw telemetry acquisition layer only**.
- It must not be the authority for current-day energy totals — that belongs to Node.
- Live frames must be stamped with `source_ip` and `node_number`.
- The Node poller resolves inverter identity from configured inverter IP + node list. Unknown IPs and unconfigured nodes must be rejected.
- Expose `/write/batch` for batched node writes per inverter.
- Honor the service stop file (`IM_SERVICE_STOP_FILE`) — mark `server.should_exit = True` and exit `uvicorn` cleanly on stop request.

---

## Forecast Engine Rules

### Day-Ahead Auto-Generation

- **Primary runs** at hours 6 and 18: always retrain + generate regardless of existing rows.
- **Post-solar checker** (18:00–04:59 every 60s): verifies tomorrow's day-ahead exists; regenerates if missing.
- **Recovery**: if today's forecast is missing during solar hours, generate immediately.
- **Failure backoff**: exponential cooldown after failure (5→10→20→30 min cap). Primary runs bypass cooldown.
- Node.js cron fallback runs at **04:30, 18:30, 20:00, and 22:00** — safety net when Python service is not running. Do not remove the dual-layer approach.
- Forecast generation is always skipped in `remote` mode.

### Provider Pipeline and Provenance

Day-ahead generation normalizes and deduplicates explicit target dates. Manual API, Python auto-delegation, and Node fallback all route through shared provider-aware orchestration.

Per-day forecast provenance is persisted at generation time:

| Field | Values |
|---|---|
| Variant | `solcast_direct`, `ml_solcast_hybrid_fresh`, `ml_solcast_hybrid_stale`, `ml_without_solcast` |
| Solcast freshness | `fresh`, `stale_usable`, `stale_reject`, `missing`, `not_expected` |
| Quality class | `missing`, `incomplete`, `missing_audit`, `wrong_provider`, `stale_input`, `weak_quality`, `healthy` |

Fallback regeneration triggers when policy quality is violated even if row count is complete.

Authoritative run supersession is tracked via `superseded_by_run_audit_id`, `replaces_run_audit_id`, `run_status`. When a newer run becomes authoritative, previous run authority flags are cleared.

### Key Forecast Functions

| Function | Purpose |
|---|---|
| `run_dayahead()` | Main day-ahead generation entry point |
| `build_intraday_adjusted_forecast()` | Intraday adjustment; excludes cap-dispatched slots from ratio computation |
| `compute_error_memory()` | Bias correction; prefers saved eligible comparison rows with `decay × source_weight × support_weight` |
| `_compute_error_memory_legacy()` | Fallback for legacy DBs / migration gaps |
| `_fetch_run_audit_meta()` | Resolves rich run metadata for QA persistence |
| `_memory_source_weight()` | Source-quality weighting for provenance-aware correction |
| `_persist_qa_comparison()` | Writes detailed day/slot comparison rows including eligibility rules, mask-aware filtering, per-slot support weights |
| `collect_training_data()` / `collect_training_data_hardened()` | Training data collection with cap-dispatch reconstruction |
| `collect_history_days()` | Stores `cap_dispatch_mask` per sample for downstream hardened training |
| `forecast_qa()` | QA scoring — reports WAPE, MAPE, total-energy APE, first/last active-slot timing error |
| `run_backtest()` | Historical day-ahead scoring without overwriting live rows |
| `build_solcast_reliability_artifact()` | Solcast trust calibration against loss-adjusted actuals |
| `load_actual_loss_adjusted()` / `load_actual_loss_adjusted_with_presence()` | Loss-adjusted actual energy loaders |
| `plant_capacity_profile()` | Returns `loss_adjusted_equiv`, `dependable_kw`, `max_kw` |

### Comparison Persistence Tables

`_persist_qa_comparison()` writes to two tables:

**`forecast_error_compare_daily`** — per-day rows storing: run linkage (`run_audit_id`), provider expectations, variant/freshness, totals/error aggregates, slot availability counts, mask counts, eligibility flags (`include_in_error_memory`, `include_in_source_scoring`), quality status (`comparison_quality`), notes metadata.

**`forecast_error_compare_slot`** — per-slot rows storing: run linkage, slot timestamps/time labels, signed/absolute/normalized errors, opportunity, Solcast/hybrid references, weather-bucket/regime markers, mask flags, `usable_for_error_memory`, `support_weight`.

`compute_error_memory()` selects from these tables using `include_in_error_memory=1`, `comparison_quality='eligible'`, `usable_for_error_memory=1`.

### Plant Cap and Training Rules

- `audit_log.scope = "plant-cap"` distinguishes cap-dispatch stops from manual/fault stops.
- Cap-dispatch-only slots → replace actual output with physics/hybrid baseline for training (preserves high-irradiance samples).
- Manually constrained slots are excluded entirely from the training mask.
- `build_intraday_adjusted_forecast()` excludes cap-dispatched slots from actual-vs-dayahead ratio computation.
- Do not remove the `scope` column from `audit_log` or change the `"plant-cap"` tag — training depends on it.

### Per-Inverter Transmission Loss Rules

- Loss factors from `ipconfig.json` as `losses: { "1": 2.5, ... }` (default `2.5%`).
- Loss factors affect **forecast engine only** — never alter raw telemetry, dashboard display, health metrics, or energy exports.
- Forecast-engine consumers that use loss-adjusted actuals:
  - `collect_training_data()`, `collect_history_days()`
  - `compute_error_memory()`
  - `build_intraday_adjusted_forecast()`
  - `forecast_qa()`, `run_backtest()`
  - `build_solcast_reliability_artifact()`
- When all losses are explicitly `0`, loss-adjusted loaders short-circuit to the cached raw loader.

### Provider Orchestration Architecture

#### Boundary rule

**Node owns provider routing and Solcast fetch decisions. Python owns ML execution, training, QA, and error correction.** This boundary must not be blurred.

The Python scheduler must not make provider decisions or run direct Solcast generation. It resolves the target date and trigger reason, then delegates to the shared Node orchestrator via an internal route such as `/api/internal/forecast/generate-auto`. Node applies the same provider logic for automatic generation as for manual generation.

#### Manual vs automatic parity

Manual and automatic generation must use the same provider decision and Solcast-input preparation. The current divergence — where the manual ML path refreshes Solcast snapshots before spawning Python but the automatic scheduler does not — must not be reintroduced.

#### Provider routing rules

If `forecastProvider=solcast`:
- both manual and automatic must use `solcast_direct` path
- if direct Solcast fails and fallback is permitted, record the failure explicitly — do not present ML output as equivalent

If `forecastProvider=ml_local` and Solcast is configured:
- both manual and automatic must refresh snapshot before running Python ML
- Python ML runs only after Node confirms snapshot freshness status

If `forecastProvider=ml_local` and Solcast is not configured:
- ML may proceed; audit row must mark `forecast_variant='ml_without_solcast'` and `solcast_snapshot_coverage_ratio=0`

#### Snapshot freshness policy

| Class | Criteria |
|---|---|
| `fresh` | Snapshot for target day, coverage ≥ 0.95, pulled within 2 h |
| `stale_usable` | Snapshot for target day, coverage ≥ 0.80, pulled within 12 h |
| `stale_reject` | Coverage < 0.80 or pulled > 12 h ago |
| `missing` | No snapshot for target day |
| `not_expected` | Solcast not configured |

Do not proceed with `stale_reject` or `missing` when Solcast influence is required.

#### Fallback quality classification

The fallback layer classifies tomorrow into one state before deciding to regenerate:

| State | Meaning |
|---|---|
| `missing` | No usable solar-window rowset |
| `incomplete` | Fewer than required slots |
| `wrong_provider` | Does not match current provider policy |
| `stale_input` | Complete but Solcast freshness below policy |
| `weak_quality` | Complete but audit metadata indicates degraded path |
| `healthy` | Passes all policy checks |

Only `healthy` suppresses regeneration. A complete rowset is not sufficient on its own.

#### Run authority and supersession

Authoritative order: `solcast_direct` > `ml_solcast_hybrid_fresh` > `ml_solcast_hybrid_stale` > `ml_without_solcast`.

When a newer run supersedes an old one: store `superseded_by_run_audit_id` on the old run and `replaces_run_audit_id` on the new. One run per target date is marked `authoritative_for_learning=1` — only this run feeds error memory.

#### Comparison persistence tables

`forecast_run_audit` — written immediately after a successful forecast write. One row per generation run per target date. Stores provenance, freshness class, run status, and daily totals.

`forecast_error_compare_daily` — written after actuals exist for the target day. One row per target date per run. Stores error metrics and eligibility flags (`include_in_error_memory`, `include_in_source_scoring`, `comparison_quality`).

`forecast_error_compare_slot` — written alongside the daily row. One row per slot per run. Stores aligned forecast/actual/error/masks/weather context, `usable_for_error_memory`, and `support_weight`.

Scoring timing: primary at ~18:10 after solar window closes; stabilization pass at ~00:15 next day. Recomputing for the same `run_audit_id` replaces rows idempotently.

#### Source-aware error memory

`compute_error_memory()` queries `forecast_error_compare_daily` / `forecast_error_compare_slot` for eligible rows and applies:

`weight = recency_decay × source_quality_weight × support_weight`

Source quality weights:
- `solcast_direct` → 1.00
- `ml_solcast_hybrid_fresh` → 0.95
- `ml_solcast_hybrid_stale` → 0.35
- `ml_without_solcast` (when Solcast was expected) → 0.20

Fall back to `_compute_error_memory_legacy()` only when the new tables are empty during migration.

#### Implementation work packages

| Package | Scope |
|---|---|
| WP1 | Shared Node orchestrator; Python scheduler delegates via internal route; parity tests |
| WP2 | `forecast_run_audit` table; freshness-class logic; audit rows for all paths |
| WP3 | Quality-aware fallback — classify tomorrow state; replace weak-but-complete forecasts |
| WP4 | `forecast_error_compare_daily` + `forecast_error_compare_slot`; source-aware error memory |
| WP5 | Replay validation over last 30–90 days before threshold tuning |

Ship WP1+WP2 together. Ship WP3 next. WP4 after enough audit data exists. Tune thresholds only after WP5 replay confirms results.

- `_cached_loss_factors` is a module-level snapshot refreshed each cycle via `clear_forecast_data_cache()`.
- Both `load_actual_loss_adjusted` and `load_actual_loss_adjusted_with_presence` are LRU-cached alongside the raw loaders.
- Raw `load_actual()` remains for non-forecast consumers and the zero-loss fast path.

### Forecast Export Ceiling

`forecastExportLimitMw` is read from the settings table. `24 MW` is the fallback default only — not a hardcoded assumption.

### Solcast Authority and Usage Rules

Solcast is a **high-authority input** — it carries real irradiance and sky-condition data that the ML model alone cannot derive. It must not be skipped, ignored, or treated as optional when available.

**In ML training:**
- `collect_training_data()` and `collect_history_days()` must consume Solcast snapshot data as a training feature when available for the target date.
- Solcast-informed training samples produce more accurate residual learning — do not fall back to pure physics baseline when Solcast snapshots exist.
- `build_solcast_reliability_artifact()` builds per-weather-bucket trust scores from historical Solcast vs loss-adjusted actual comparisons. These scores feed `solcast_resolution_weight` and `solcast_resolution_support` as ML features — keep them populated.

**In day-ahead generation (manual and automatic):**
- Always attempt to load Solcast snapshots for the target date before generating.
- If fresh Solcast data is available (`fresh` or `stale_usable` freshness class), use it — prefer `ml_solcast_hybrid_fresh` or `ml_solcast_hybrid_stale` over `ml_without_solcast`.
- `solcast_direct` is the highest-confidence variant — use it when Solcast snapshot coverage is sufficient and freshness is `fresh`.
- Only fall back to `ml_without_solcast` when Solcast snapshots are genuinely missing or `stale_reject` for the target date.
- Do not skip Solcast loading as an optimization. A generation run that silently omits available Solcast data produces an inferior forecast and may trigger quality-class `wrong_provider` on the next check.

**Normalization:**
- Raw Solcast arrives in `MW` — always normalize to `kWh per 5-minute slot` before any scoring, blending, or comparison.
- `build_solcast_reliability_artifact()` compares Solcast against `load_actual_loss_adjusted()` — never against raw inverter totals.
- Do not compare already-loss-adjusted Solcast snapshots against raw (non-loss-adjusted) actuals.

---

## Service Soft-Stop Contract

The forecast service must:
1. Check for the stop file (`ADSI_SERVICE_STOP_FILE`) between loop sleeps.
2. Check before write-heavy forecast steps.
3. Exit cleanly without requiring force-kill.

This protects against partial writes during `Restart & Install`.

---

## Python Test Files

| File | What it guards |
|---|---|
| `test_forecast_engine_constraints.py` | Operational constraint mask, cap-dispatch handling |
| `test_forecast_engine_ipconfig.py` | Loss factor loading, per-inverter config |
| `test_forecast_engine_weather.py` | Weather bucket classification, vectorized path |
| `test_forecast_engine_error_classifier.py` | Error classification, calibration |

---

## Metrics Guardrails

| Metric | Value |
|---|---|
| Expected full inverter node count | 4 |
| Baseline max inverter power | 997.0 kW |
| Per node at 4 nodes | 249.25 kW |
| Dependable full inverter baseline | 917.0 kW |

- **Performance**: affected by active node count — normalize expected capacity for reduced-node inverters.
- **Availability**: inverter-level uptime only, window 5:00 AM–6:00 PM. All 4 nodes offline = 0%.