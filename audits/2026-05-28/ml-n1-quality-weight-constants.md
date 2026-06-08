# ML-N1 Closure — Quality-Weight Named Constants

**Date:** 2026-05-30
**Status:** DONE — verified (524/524 Python tests green)
**Scope:** `services/forecast_engine.py`, `services/tests/test_forecast_engine_audit_fixes.py`
**Audit ref:** `audits/2026-05-28/subsystem-deep-audit.md` §2.12 ML-N1 / §2.17 action items

---

## What

Closed the last open code item from the 2026-05-28 ML-training audit. The
per-day training-sample quality weight in `collect_training_data_hardened()`
used inline magic numbers:

```python
quality_weight = float(np.clip(0.70 + 0.30 * max(corr, 0.0), 0.55, 1.0))
```

Replaced the literals with named, documented module constants (defined directly
above the function):

| Constant | Value | Meaning |
|---|---|---|
| `TRAIN_QUALITY_WEIGHT_BASE` | `0.70` | weight when actual↔baseline correlation is zero/negative |
| `TRAIN_QUALITY_WEIGHT_CORR_SCALE` | `0.30` | extra weight scaled by `max(corr, 0)` |
| `TRAIN_QUALITY_WEIGHT_FLOOR` | `0.55` | lower clip — never fully discard a usable day |
| `TRAIN_QUALITY_WEIGHT_CEIL` | `1.00` | upper clip — never exceed full weight |

## Behavior

**Identical.** The constants reproduce the prior literals exactly. Verified
numerically across the correlation domain `corr ∈ {-0.5, 0.0, 0.3, 0.6, 1.0}`
(`old == new` for every point). No change to model training output.

## Verification

- `ast.parse` clean.
- New guard test `test_ml_n1_quality_weight_named_constants` asserts both the
  constant values and the behavior identity vs the old inline literals.
- Full Python suite: **524 passed** (was 523; +1 new test), RC=0, 0 failures.

## Audit status after this change

Forecast Engine (§1) + ML Training (§2) action items — all resolved or verified-fine:

| Item | State |
|---|---|
| ML-Me3 (regime transition) | Implemented + tested (prior session) |
| ML-Mi4 (cap-tolerance constant) | Implemented + tested (prior session) |
| ML-Mi5 (atomic legacy-model truncation) | Implemented + tested (prior session) |
| ML-FA3 (backend_fallback → status_flags) | Implemented + tested (prior session) |
| ML-M1 (sklearn-vs-LightGBM doc) | Done (prior session) |
| ML-D1 / F-D1 (doc drift) | Fixed in `references/forecast-engine.md` (uncommitted) |
| ML-N1 (quality-weight constants) | **Done this session** |
| F-Mi1 / F-FA1 / F-FA2 | Verified already-handled (§6.1) |
| ML-FA4 (12h "stale features") | Non-issue — the only 12h gate (`:10171`) is the correct Solcast freshness downgrade, not a misfiring warning |

No Critical / Major / Medium items remain. Subsystem verdict stays **SHIP**.

## Not changed (requires live backtest — operator-gated)

Real forecast-accuracy tuning derived from operator-flagged insights
(est_actual discount, Solcast-intraday trust, transmission-loss calibration,
substation-side variance basis) is **not** applied here because it changes
forecast output and must be validated by a `--train` + 30-day backtest against
the live `adsi.db` + Solcast snapshots on the gateway. See the handoff plan.
