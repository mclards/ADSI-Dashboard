# Forecast Tunables — Option A (settings-driven, default-preserving)

**Date:** 2026-05-30
**Status:** DONE — verified (531/531 Python tests green)
**Scope:** `services/forecast_engine.py`, `services/tests/test_forecast_engine_audit_fixes.py`,
`.claude/skills/adsi-dashboard/references/forecast-engine.md`
**Driver:** operator-flagged accuracy levers (est_actual trust, Solcast/observed intraday trust,
transmission loss) — exposed as **settings with current values as defaults** so behavior is
identical until the operator opts in (zero risk to existing forecasts/training data).

---

## What

Added one settings accessor and wired two operator-tunable knobs.

### Accessor

`_setting_float_or_none(key, lo, hi) -> float | None` — reads the `settings` table **fresh**
(bypasses the process-cached `_read_setting_value`, so a change takes effect on the next
forecast cycle without a service restart). Returns `None` when unset / blank / non-numeric /
non-finite; otherwise the value clamped to `[lo, hi]`. Invalid values are logged and ignored.

### Knobs

| Setting key | Range | Default (unset) | Wired at |
|---|---|---|---|
| `forecastEstActualWeight` | 0.50–1.00 | dynamic (`compute_solcast_accuracy_vs_metered`, floor 0.93) | `build_training_state()` — override takes precedence over the dynamic estimate when set |
| `forecastIntradayBlendMax` | 0.00–1.00 | `INTRADAY_BLEND_MAX` (0.72) | `build_intraday_adjusted_forecast()` — caps intraday blend strength |

Transmission loss intentionally **not** duplicated as a setting — already per-inverter
configurable in `ipconfig.json` (`losses`), the correct place to calibrate the 2.5–3.6% range.

## Safety / behavior

- **Zero behavior change at defaults.** With no setting present, each path keeps the exact
  prior constant/dynamic behavior. Verified: `INTRADAY_BLEND_MAX=0.72`, `EST_ACTUAL_WEIGHT_FACTOR=0.93`.
- Values are clamped to safe ranges; invalid input falls back to the engine default.
- No DB schema change (generic key/value `settings` table).

## Verification

- `ast.parse` clean.
- Helper unit-tested: unset→None, valid→passthrough, out-of-range→clamped, invalid→None.
- Wiring tested via `inspect.getsource` (keys present in both functions).
- Full Python suite: **531 passed** (was 524; +7 new tunable tests), RC=0, 0 failures.

## Operator handoff — how to use + validate

1. Set a knob, e.g. `POST /api/settings { "key": "forecastEstActualWeight", "value": "0.95" }`.
2. On the gateway, retrain + backtest to confirm it helps before relying on it:
   - `python services/forecast_engine.py` (or `ForecastCoreService`) `--generate-days 1` after a `--train` cycle,
   - `python services/forecast_engine.py --backtest-days 30` and compare WAPE/MAPE vs the prior config.
3. If WAPE/MAPE regress, clear the setting (engine reverts to the default automatically).

## Follow-up offered (not done this session)

- UI controls on the Forecast settings panel for these keys (would also require User Guide
  HTML/MD/PDF sync per project rule). Currently settable via `/api/settings` / DB only.
