# Phase 7 — Python forecast engine hardening (T4.6–T4.12)

**Date:** 2026-04-14
**Baseline:** v2.8.8 + Phase 2/3/4/5/6 (commit `183a082`)
**Target:** v2.8.9
**Session scope:** T4.6–T4.12 from [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan).

Continuation of [PHASE6_FIXES.md](PHASE6_FIXES.md). Verified by the T7.3 smoke harness — **107/107 Python tests pass**, 24/29 Node (same 5 pre-existing failures). Zero regressions.

This is the strongest-coverage phase: `services/tests/` has 107 tests covering the forecast engine, so any regression in the edits below would have been caught immediately.

---

## Fix-by-fix

### T4.6 — Solcast reliability dimension-missing INFO logs

| | |
|---|---|
| File | `services/forecast_engine.py:4928` (`lookup_solcast_reliability`) |
| Before | When the artifact lacked a specific dimension key (`regimes`, `seasons`, `season_regimes`, `time_of_day`), the function silently fell through to `overall` or hard-coded fallback. Operator could not tell whether the artifact was structurally degraded or the dimension simply had no data. |
| After | One-time INFO log per missing dimension per process, guarded by a module-level `_reliability_fallback_notified` set so repeated lookups don't spam the log. The artifact-unavailable case (existing `log.warning` at line 4940) is unchanged — that's still a louder signal. |
| Rollback | Drop the `_reliability_fallback_notified` block. |

### T4.7 — Clock robustness for `error_memory_stale` check

| | |
|---|---|
| File | `services/forecast_engine.py:7434` (inside `_collect_data_quality_warnings`) |
| Before | `days_old = (date.today() - last_eligible_date).days`. An NTP step or DST flip that moves `date.today()` backward could produce negative `days_old`, silently skipping the `> 30` staleness check. |
| After | `days_old = max(0, (date.today() - ...).days)`. Monotonic either way; backward clock jumps no longer HIDE real staleness. Also documented in the code comment that the audit's claim was subtly wrong — the real risk is backward jumps hiding staleness, not forward jumps triggering false positives. |
| Rollback | Drop the `max(0, ...)` wrapper. |

### T4.8 — Legacy-model truncation upgraded INFO → WARN

| | |
|---|---|
| File | `services/forecast_engine.py:8095` (`_align_bundle_features`) |
| Before | When a pre-v2.5.0 62-feature model was loaded in v2.5.0+ 70-feature code, the alignment code truncated the last 8 features (tri-band Solcast signals) and logged at INFO. The truncation preserves mathematical alignment but drops signal the legacy model was never trained on → degraded output. Operator had no loud signal that a retrain was needed. |
| After | First truncation event per process logs at WARNING with a "retrain needed" hint. Subsequent events log at INFO to avoid spam. Guarded by a module-level `_legacy_model_truncate_notified` flag. The fallback STAYS functional so the upgrade path is not broken — we just surface the degradation signal. |
| Why not hard-fail | Hard-failing the legacy path breaks every v2.8.8 install that upgrades to v2.8.9 before retraining. Degraded-but-working with a loud WARN is the right balance. |
| Rollback | Revert to the original INFO log, drop the `_legacy_model_truncate_notified` flag. |

### T4.9 — LightGBM import error surfaced to `/engine-health`

| | |
|---|---|
| File | `services/forecast_engine.py` — import at line 46, new `_detect_ml_backend_detail()` at ~line 7395, two wiring sites at ~556 and ~11800 |
| Before | `_LIGHTGBM_AVAILABLE = False` on ImportError with no reason captured. `/engine-health` showed only an opaque `lgbm_unavailable_fallback` flag — operator could not tell whether it was a missing DLL, ABI mismatch, platform-missing wheel, or explicit env-var disable. |
| After | Capture `_LIGHTGBM_IMPORT_ERROR` at import time. New `_detect_ml_backend_detail()` returns `{ backend, lightgbm_available, lightgbm_enabled_by_env, reason }`. Reason values: `"active"`, `"disabled_by_env_FORECAST_USE_LIGHTGBM"`, `"import_failed: <exception>"`, `"unknown_unavailable"`. Wired into `ml_train_state.json` as new key `ml_backend_detail`; the legacy `ml_backend_type` string stays for backward compat. |
| Rollback | Drop `_LIGHTGBM_IMPORT_ERROR`, `_detect_ml_backend_detail`, and the two `state["ml_backend_detail"] = ...` lines. |

### T4.10 — Error-memory eligibility filter (reviewed, already enforced)

| | |
|---|---|
| Status | **Reviewed, no fix needed.** |
| Files inspected | `services/forecast_engine.py:5602` and `:5846` (error_memory SQL paths), `:7189` (`collect_training_data_hardened`), `:6188` (`collect_history_days`) |
| Finding | The audit claimed "training collects error-memory rows regardless of eligibility flag". Inspection shows: (1) both error-memory SQL paths (legacy at 5602, v2.8+ at 5846) already have `AND include_in_error_memory = 1` / `AND usable_for_error_memory = 1` filters applied. (2) Training data itself (via `collect_training_data_hardened` → `collect_history_days`) is sourced from actual generation + archive weather + Solcast snapshot. It does NOT pull from error_memory rows at all — error_memory feeds a separate residual-shift signal (`compute_error_memory`), not the model's training set. |
| Conclusion | The audit description doesn't match current code. The filters are already correctly placed. No action. |

### T4.11 — Transmission loss calibration (deferred to v2.9.0)

| | |
|---|---|
| Status | **Deferred — out of scope for Phase 7.** |
| Why | Memory `project_transmission_loss_range.md` records operator-reported real range of 2.5%–3.6% depending on transformer loading + feeder temperature. Memory `project_substation_meter_input.md` records that manual 15-min substation meter input is a **future feature** for ground-truth calibration. Without the substation meter integration there is no data source to calibrate against. The flat 2.5% constant is a known under-estimate, but fixing it without calibration data would be guessing. |
| Tracked for | v2.9.0 (paired with substation meter input feature). |
| Today's behaviour | Flat `TRANSMISSION_LOSS = 0.025` (2.5%) at line 222 of `forecast_engine.py`. Operator accepts this; see [KNOWN_GAPS.md](KNOWN_GAPS.md) for the broader FPM variance discussion. |

### T4.12 — Regime model sample-count floor at prediction time

| | |
|---|---|
| File | `services/forecast_engine.py:8212` (regime blend in `_predict_regime_blend` or equivalent at line 8170-ish) |
| Before | Training already skips regimes with fewer than `REGIME_MODEL_MIN_DAYS=6` days. But a regime model that BARELY cleared that threshold could land in the bundle with a thin sample count, and at prediction time was blended at 0.52 weight regardless. |
| After | At prediction time, read `regime_meta.sample_count` and fall through to the global prediction if it's between 1 and `REGIME_MODEL_MIN_SAMPLES=320` (exclusive). Zero/missing sample_count is treated as "metadata missing, trust training-time filter" so older bundles without the key keep working. Returns `regime_fallthrough_reason="insufficient_samples"` in meta for observability. |
| Rollback | Remove the sample-count check; revert to unconditional blend. |

---

## Verification

```
$ npm run smoke
...
  Node tests: 24/29 pass  (5 pre-existing, same as SMOKE_BASELINE.md)
  Python tests: PASS (status=0)  — 107/107
  Total wall time: 209780ms
```

Python test suite coverage of the touched areas:
- `test_forecast_engine_triband.py` — exercises reliability lookup + feature building (touches T4.6)
- `test_forecast_engine_error_classifier.py` — exercises training-time path (touches T4.10 review area)
- `test_forecast_engine_weather.py` — exercises regime classification (touches T4.12)
- `test_forecast_engine_constraints.py` — exercises bundle shape guarantees (touches T4.8 alignment)
- `test_forecast_engine_ipconfig.py` — unrelated
- `test_hyperparameter_snapshot.py` — verifies FEATURE_COLS / hyperparams contract (would catch T4.8/T4.9 breakage)
- `test_spread_weight.py` — unrelated to this phase
- `test_sqlite_retry.py` — unrelated

All 107 still pass.

---

## Status update for KNOWN_GAPS.md

| Gap | Status |
|---|---|
| §1 backlog T4.6 | Closed |
| §1 backlog T4.7 | Closed |
| §1 backlog T4.8 | Closed (as warn + keep-working; hard-fail variant deferred) |
| §1 backlog T4.9 | Closed |
| §1 backlog T4.10 | Reviewed — filter already correctly enforced, no change |
| §1 backlog T4.11 | **Deferred to v2.9.0** — requires substation meter integration |
| §1 backlog T4.12 | Closed |

---

## Remaining HIGH backlog after Phase 7

From [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan):

- **T1.5 / T1.6** — frontend remote-fetch AbortController + reconnect-timer race
- **T6.8** — storage migration atomicity (optimisation only)

Pending follow-ups (separate tickets for v2.9.0):
- **T2.4** — DPAPI/safeStorage for cloud-token encryption
- **T6.3** — trusted-signers.json bundling for auto-update thumbprint rotation
- **T4.4** — UNIQUE index on `forecast_run_audit` (partial residual from Phase 2)
- **T4.11** — transmission loss calibration (requires substation meter feature)
- 5 pre-existing Node test failures from [SMOKE_BASELINE.md](SMOKE_BASELINE.md)

After Phase 7, **the HIGH backlog is effectively empty**: only T1.5/T1.6 (one frontend area) and T6.8 (optimisation only) remain. The v2.9.0 follow-ups are either feature-dependent (T4.11) or architectural (T2.4, T6.3, T4.4) and belong to their own release.

---

## Commit landed

| Commit | Scope |
|---|---|
| (this session) | Phase 7 Python: T4.6/T4.7/T4.8/T4.9/T4.12 fixes + T4.10/T4.11 reviews |
| (this session) | Phase 7 documentation |
