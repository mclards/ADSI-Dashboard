# Forecast System Fix Plan

**Created:** 2026-03-29
**Source:** 4-agent orchestrated review (Python reviewer, Node code reviewer, architecture reviewer, security reviewer)
**Scope:** `services/forecast_engine.py` and `server/index.js`
**Target version:** v2.5.1

---

## Priority Matrix

| Priority | Label | Criteria | Timeline |
|----------|-------|----------|----------|
| **P0** | Blocking | Data corruption risk, model crash, upgrade breakage | Before next release |
| **P1** | High | Race conditions, missing error handling, audit gaps | This sprint |
| **P2** | Medium | Operational hardening, observability, cleanup | Next sprint |
| **P3** | Low | Polish, documentation, future-proofing | Backlog |

---

## P0 - BLOCKING (Must fix before v2.5.1 release)

### FIX-01: Feature Column Alignment Bug (Legacy Model Crash)

**File:** `services/forecast_engine.py`
**Function:** `_align_bundle_features()` (lines 6458-6483)
**Risk:** Any site upgrading from v2.4.x to v2.5.0 with an existing trained model will crash

**Problem:**
The function has two branches:
1. Lines 6464-6470: If `expected_cols` exist (feature names stored in bundle), it pads missing columns with 0.0. This works correctly.
2. Lines 6474-6483: If `expected_cols` is empty (legacy bundles without feature names), it falls back to counting features via `scaler.n_features_in_` or `model.n_features_in_`. If the count doesn't match `X_pred.shape[1]`, it raises `ValueError`.

Legacy v2.4.x models have 62 features but no stored feature names. v2.5.0 builds 68-column X_pred (6 new tri-band Solcast features). The count check fails: `expected=62, got=68`.

**Current code (lines 6472-6483):**
```python
    scaler = block.get("scaler")
    model = block.get("model")
    expected_count = None
    if hasattr(scaler, "n_features_in_"):
        expected_count = int(scaler.n_features_in_)
    elif hasattr(model, "n_features_in_"):
        expected_count = int(model.n_features_in_)
    if expected_count is not None and expected_count != int(X_pred.shape[1]):
        raise ValueError(
            f"Feature count mismatch for model bundle (expected {expected_count}, got {int(X_pred.shape[1])})"
        )
    return X_pred
```

**Fix:**
When legacy bundles lack feature names but we know the current `FEATURE_COLS`, align by truncating X_pred to the model's expected count (first N columns). The new tri-band columns are appended at the end of `FEATURE_COLS`, so dropping the last 6 gives exact v2.4.x alignment.

```python
    scaler = block.get("scaler")
    model = block.get("model")
    expected_count = None
    if hasattr(scaler, "n_features_in_"):
        expected_count = int(scaler.n_features_in_)
    elif hasattr(model, "n_features_in_"):
        expected_count = int(model.n_features_in_)
    if expected_count is not None and expected_count != int(X_pred.shape[1]):
        if expected_count < int(X_pred.shape[1]):
            # Legacy model with fewer features — truncate to match (new cols are appended at end)
            log.info(
                "Legacy model alignment: truncating %d -> %d features (dropping newest columns)",
                int(X_pred.shape[1]), expected_count,
            )
            return X_pred.iloc[:, :expected_count]
        else:
            raise ValueError(
                f"Feature count mismatch for model bundle (expected {expected_count}, "
                f"got {int(X_pred.shape[1])}). Model expects more features than available."
            )
    return X_pred
```

**Validation:**
- Load a v2.4.x model bundle (62 features) in v2.5.0 environment
- Confirm prediction succeeds with truncated 62-column input
- Confirm new v2.5.0 models (68 features) still work normally

---

### FIX-02: Wrap model.predict() in try/except

**File:** `services/forecast_engine.py`
**Function:** `predict_residual_with_bundle()` (lines 6493-6529)
**Risk:** Corrupted or incompatible model crashes forecast generation with no diagnostic info

**Problem:**
Two `model.predict()` calls at lines 6510 and 6517 have no error handling. If the model is corrupted, has wrong feature count, or LightGBM/sklearn version mismatch, the exception propagates with no context about which model failed or what the shape mismatch was.

**Current code (lines 6509-6517):**
```python
    X_global = _transform_bundle_features(global_block, X_pred)
    global_pred = np.asarray(global_model.predict(X_global), dtype=float)
    regime_block = ((bundle.get("regimes") or {}).get(target_regime) or {})
    regime_model = regime_block.get("model")
    if regime_model is None:
        return global_pred, {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    X_regime = _transform_bundle_features(regime_block, X_pred)
    regime_pred = np.asarray(regime_model.predict(X_regime), dtype=float)
```

**Fix:**
```python
    X_global = _transform_bundle_features(global_block, X_pred)
    try:
        global_pred = np.asarray(global_model.predict(X_global), dtype=float)
    except Exception as e:
        log.error(
            "Global model prediction failed: %s (X shape=%s, model type=%s)",
            e, X_global.shape, type(global_model).__name__,
        )
        return np.zeros(len(X_pred), dtype=float), {
            "target_regime": target_regime, "used_regime_model": False,
            "blend": 0.0, "prediction_error": str(e),
        }

    regime_block = ((bundle.get("regimes") or {}).get(target_regime) or {})
    regime_model = regime_block.get("model")
    if regime_model is None:
        return global_pred, {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    X_regime = _transform_bundle_features(regime_block, X_pred)
    try:
        regime_pred = np.asarray(regime_model.predict(X_regime), dtype=float)
    except Exception as e:
        log.warning(
            "Regime model prediction failed for '%s': %s (X shape=%s). Falling back to global.",
            target_regime, e, X_regime.shape,
        )
        return global_pred, {
            "target_regime": target_regime, "used_regime_model": False,
            "blend": 0.0, "regime_prediction_error": str(e),
        }
```

**Validation:**
- Intentionally corrupt a model bundle file, confirm graceful fallback to zeros
- Confirm normal prediction still works

---

### FIX-03: Validate Solcast P10/P90 Ordering Constraint

**File:** `services/forecast_engine.py`
**Function:** `solcast_prior_from_snapshot()` (lines 4081-4115)
**Risk:** Inverted P10/P90 values corrupt confidence bands and ML features

**Problem:**
Lines 4102-4104 load P10 (lo) and P90 (hi) arrays from the snapshot and apply bias_ratio, but never enforce the ordering constraint `P10 <= forecast <= P90`. If the snapshot has bad data, downstream features (`solcast_spread_pct`, `solcast_spread_ratio`) and confidence bands receive garbage values.

The constraint IS enforced later in `build_features()` (lines 4417-4418), but `confidence_bands()` at line 6990-7009 consumes the prior directly without that fix.

**Current code (after bias application, around line 4108):**
```python
    prior_kwh *= bias_ratio
    prior_lo *= bias_ratio
    prior_hi *= bias_ratio
    prior_mw *= bias_ratio
```

**Fix — add after the bias application:**
```python
    prior_kwh *= bias_ratio
    prior_lo *= bias_ratio
    prior_hi *= bias_ratio
    prior_mw *= bias_ratio

    # Enforce P10 <= forecast <= P90 ordering constraint
    violated = int(np.sum((prior_lo > prior_kwh) | (prior_hi < prior_kwh)))
    if violated > 0:
        log.warning(
            "Solcast P10/P90 ordering violated in %d slots for %s — clamping",
            violated, day,
        )
    prior_lo = np.minimum(prior_lo, prior_kwh)
    prior_hi = np.maximum(prior_hi, prior_kwh)
```

**Validation:**
- Inject a snapshot with inverted P10 > P90 values
- Confirm warning is logged and values are clamped
- Confirm confidence bands render correctly

---

### FIX-04: Race Condition on forecastGenerating Flag

**File:** `server/index.js`
**Location:** Lines 13511-13609 (`/api/forecast/generate` route)
**Risk:** Two concurrent async requests both pass the flag check and run simultaneously, potentially corrupting forecast DB rows

**Problem:**
The `forecastGenerating` boolean is checked then set across an async boundary. Two requests arriving within milliseconds can both see `false`, both set `true`, and both fire off generation.

**Current code (lines 13561-13577):**
```javascript
  if (forecastGenerating) {
    return res.status(409).json({ ok: false, error: "Forecast generation already in progress." });
  }
  // ... date computation ...
  forecastGenerating = true;
```

**Fix — use a synchronous lock pattern with generation ID:**
```javascript
  // Replace the boolean flag with a lock object
  if (forecastGenerating) {
    return res.status(409).json({ ok: false, error: "Forecast generation already in progress." });
  }
  forecastGenerating = true;  // Set immediately after check — no async gap
```

Actually, the current code IS synchronous (Node.js single-threaded event loop). The check-then-set happens in the same tick before any `await`. The real race is only possible if the flag is NOT set before the first `await`. Let me re-examine...

Looking at the actual code flow:
1. Line 13561: Check `forecastGenerating` (sync)
2. Lines 13563-13575: Compute dates (sync — no await)
3. Line 13577: Set `forecastGenerating = true` (sync)

Since steps 1-3 are all synchronous with no `await` between them, **the race condition is theoretical in Node.js's single-threaded model**. Two HTTP requests cannot interleave between the check and the set. The Node reviewer's finding is technically incorrect for Node.js's concurrency model.

**Revised assessment:** No code change needed for the flag race. However, the flag DOES have a real issue: if the async promise rejects before `.finally()` runs, there's a brief window. But `.finally()` is guaranteed to run in the microtask queue, so this is also safe.

**Actual fix needed:** Move the flag set BEFORE date computation to eliminate even theoretical risk, and add a safety timeout:

```javascript
  if (forecastGenerating) {
    return res.status(409).json({ ok: false, error: "Forecast generation already in progress." });
  }
  forecastGenerating = true;  // Already correct position in current code

  // Add safety timeout: auto-reset if generation hangs for 45 minutes
  const _forecastGuardTimer = setTimeout(() => {
    if (forecastGenerating) {
      console.warn("[forecast] Safety timeout: forecastGenerating flag auto-reset after 45 minutes");
      forecastGenerating = false;
    }
  }, 45 * 60 * 1000);
  // Clear timer in finally block
```

In both the async `.finally()` and sync `finally {}` blocks, add:
```javascript
  finally {
    forecastGenerating = false;
    clearTimeout(_forecastGuardTimer);
  }
```

**Validation:**
- Start a forecast generation, wait for completion, confirm flag resets
- Simulate a hanging generation (mock), confirm 45-min timeout resets the flag

---

### FIX-05: HTTP Status Code Consistency (400 vs 500)

**File:** `server/index.js`
**Locations:**
- Line 13605: `/api/forecast/generate` sync catch block
- Line 13679: `/api/internal/forecast/generate-auto` catch block
**Risk:** API clients cannot distinguish retryable (500) from non-retryable (400) errors

**Problem:**
Both catch blocks return `status(500)` for ALL errors, including client-side validation errors ("No target dates provided", "exceeds ML weather horizon").

**Current code (line 13604-13606):**
```javascript
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
```

**Fix:**
```javascript
  } catch (e) {
    const msg = String(e.message || "");
    const isClientError = msg.includes("No target dates") ||
                          msg.includes("exceeds") ||
                          msg.includes("Invalid mode");
    res.status(isClientError ? 400 : 500).json({ ok: false, error: e.message });
  } finally {
```

Apply same pattern at line 13679.

**Validation:**
- Send POST with empty dates array, confirm 400 response
- Send POST with date 2 years in future (exceeds horizon), confirm 400
- Simulate internal Python timeout, confirm 500

---

## P1 - HIGH (Fix this sprint)

### FIX-06: Model Bundle Integrity Check (SHA256)

**File:** `services/forecast_engine.py`
**Function:** `save_model_bundle()` (lines 6408-6415) and `load_model_bundle()` counterpart
**Risk:** Corrupted model file silently produces bad forecasts

**Problem:**
Model bundles are saved via `joblib.dump()` with no integrity verification. If the file is partially written (power loss), bit-rotted, or tampered with, `joblib.load()` may succeed but return corrupted data that silently produces wrong predictions.

**Fix — save_model_bundle():**
```python
import hashlib

def save_model_bundle(bundle: dict) -> bool:
    try:
        MODEL_BUNDLE_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: save to temp file, then rename
        tmp_path = MODEL_BUNDLE_FILE.with_suffix(".tmp")
        dump(bundle, tmp_path)
        # Compute SHA256 of the saved file
        sha256 = hashlib.sha256(tmp_path.read_bytes()).hexdigest()
        tmp_path.rename(MODEL_BUNDLE_FILE)
        # Persist checksum in ml_train_state.json
        _update_train_state({"model_file_sha256": sha256})
        log.info("Model bundle saved: %s (sha256=%s)", MODEL_BUNDLE_FILE.name, sha256[:16])
        return True
    except Exception as e:
        log.error("Model bundle save failed %s: %s", MODEL_BUNDLE_FILE, e)
        return False
```

**Fix — load_model_bundle() (add checksum validation):**
After loading the bundle, before returning:
```python
    # Validate checksum if available
    train_state = _load_json(ML_TRAIN_STATE_FILE)
    expected_sha = train_state.get("model_file_sha256")
    if expected_sha:
        actual_sha = hashlib.sha256(MODEL_BUNDLE_FILE.read_bytes()).hexdigest()
        if actual_sha != expected_sha:
            log.error(
                "Model bundle checksum mismatch! Expected %s, got %s. File may be corrupted.",
                expected_sha[:16], actual_sha[:16],
            )
            return None  # Force physics-only fallback
```

**Validation:**
- Save a model, verify SHA256 appears in ml_train_state.json
- Corrupt the model file (flip a byte), confirm load rejects it
- Confirm physics fallback activates when model is rejected

---

### FIX-07: Feature Count Assertion After build_features()

**File:** `services/forecast_engine.py`
**Function:** `build_features()` return point (line 2539-2540)
**Risk:** Silent feature column drift causes model training/prediction shape mismatch

**Problem:**
`build_features()` returns a DataFrame but never asserts the column count matches `FEATURE_COLS`. If a code change accidentally adds/removes a column, the mismatch is only caught much later at prediction time (or silently in training).

**Current code (lines 2539-2540):**
```python
    })

    return df
```

**Fix:**
```python
    })

    if len(df.columns) != len(FEATURE_COLS):
        log.error(
            "build_features column count mismatch: got %d, expected %d. Extra: %s, Missing: %s",
            len(df.columns), len(FEATURE_COLS),
            sorted(set(df.columns) - set(FEATURE_COLS)),
            sorted(set(FEATURE_COLS) - set(df.columns)),
        )
    assert len(df.columns) == len(FEATURE_COLS), (
        f"build_features returned {len(df.columns)} columns, expected {len(FEATURE_COLS)}"
    )
    return df
```

**Validation:**
- Run normal build_features(), confirm assertion passes
- Temporarily add a column to FEATURE_COLS, confirm assertion catches the mismatch

---

### FIX-08: Cron Job Timeout Safety

**File:** `server/index.js`
**Location:** Lines 14766-14803 (cron scheduling block)
**Risk:** If a cron-triggered forecast hangs forever, all subsequent cron runs are permanently disabled

**Problem:**
The `_forecastCronRunning` flag is set to `true` at the start of a cron job. If `runDayAheadGenerationPlan()` hangs (e.g., Python service unresponsive, Solcast API timeout), the `finally` block never executes and the flag stays `true` forever.

**Current code (lines 14766-14803):**
```javascript
    _forecastCronRunning = true;
    try {
      // ... generation logic ...
    } finally {
      _forecastCronRunning = false;
    }
```

**Fix — add a safety timeout alongside the existing finally:**
```javascript
    _forecastCronRunning = true;
    const cronSafetyTimer = setTimeout(() => {
      if (_forecastCronRunning) {
        console.warn("[Cron:forecast] Safety timeout: cron running flag auto-reset after 45 minutes");
        _forecastCronRunning = false;
      }
    }, 45 * 60 * 1000);
    try {
      // ... existing generation logic (unchanged) ...
    } finally {
      _forecastCronRunning = false;
      clearTimeout(cronSafetyTimer);
    }
```

**Validation:**
- Run cron job, confirm it completes and clears the flag
- Mock a hanging `runDayAheadGenerationPlan()`, confirm 45-min timer resets the flag

---

### FIX-09: Python Fallback Audit Tagging

**File:** `services/forecast_engine.py`
**Function:** `_delegate_run_dayahead()` fallback path (around line 9501-9512 in the main loop)
**Risk:** When Python fallback generates a forecast after Node fails, the audit trail doesn't indicate this was a fallback

**Problem:**
In the main service loop, if `_delegate_run_dayahead()` returns `None` (Node unreachable), `run_dayahead()` is called directly with `write_audit=True`. But the audit row doesn't capture that this was a fallback from a failed Node delegation.

**Current code (around lines 9501-9512):**
```python
    ok = _delegate_run_dayahead(target)
    if not ok:
        _direct_result = run_dayahead(
            target, today,
            write_audit=True,
            audit_generator_mode="auto_service",
        )
```

**Fix:**
```python
    ok = _delegate_run_dayahead(target)
    if not ok:
        log.warning("Node delegation failed for %s — running direct Python fallback", target)
        _direct_result = run_dayahead(
            target, today,
            write_audit=True,
            audit_generator_mode="auto_service_fallback",
        )
```

Then in `run_dayahead()`, when writing the audit row, ensure `audit_generator_mode` is persisted in `notes_json`:
```python
    # In the audit row write section, add to notes_json:
    notes["generator_mode"] = audit_generator_mode
    if "fallback" in audit_generator_mode:
        notes["fallback_reason"] = "node_delegation_failed"
```

**Validation:**
- Stop the Node server, trigger Python auto-generation
- Confirm audit row has `generator_mode="auto_service_fallback"` and `fallback_reason`

---

### FIX-10: Job GC Timeout Increase

**File:** `server/index.js`
**Function:** `_gcForecastJobs()` (lines 13514-13523)
**Risk:** Long-running multi-date forecast jobs are garbage-collected while still running

**Problem:**
Running jobs older than 30 minutes are deleted. Multi-date generation (e.g., 7 days) with Solcast can take 35-40 minutes.

**Current code (line 13515):**
```javascript
  const runningCutoff = Date.now() - 30 * 60 * 1000;
```

**Fix:**
```javascript
  const runningCutoff = Date.now() - 60 * 60 * 1000;  // 60 minutes for multi-date generation
  const doneCutoff = Date.now() - 5 * 60 * 1000;  // completed jobs: 5 min (was 2 min)
```

**Validation:**
- Start a multi-date generation, confirm job status is available for 60 minutes
- Confirm completed jobs are cleaned up after 5 minutes

---

## P2 - MEDIUM (Next sprint)

### FIX-11: Confidence Bands w5 Bounds and NaN Safety

**File:** `services/forecast_engine.py`
**Function:** `confidence_bands()` (lines 6934-7011)
**Risk:** IndexError if w5 has < SLOTS_DAY rows; NaN propagation from cloud values

**Problem:**
The function accesses `w5["cloud"].values[i]` without checking that w5 has enough rows. Also, if `cloud_i` is NaN, downstream math produces NaN confidence values.

**Fix — add at the top of the function (after `stats = analyse_weather_day(...)`):**
```python
    if len(w5) < SLOTS_DAY:
        log.warning("confidence_bands: w5 has %d rows, expected %d — padding with defaults", len(w5), SLOTS_DAY)
        w5 = w5.reindex(range(SLOTS_DAY)).fillna(method="ffill").fillna(0.0)
```

**Fix — in the per-slot loop, guard NaN:**
```python
    cloud_i = w5["cloud"].values[i]
    if not np.isfinite(cloud_i):
        cloud_i = 0.5  # conservative fallback
```

---

### FIX-12: compute_error_memory() Transaction Isolation

**File:** `services/forecast_engine.py`
**Function:** `compute_error_memory()` (lines 4518-4607)
**Risk:** If DB is modified between daily_rows and slot_rows queries, weight calculation is inconsistent

**Problem:**
Multiple sequential SQL queries read from `forecast_error_compare_daily` and `forecast_error_compare_slot` without transactional isolation. The connection is already `readonly=True` which provides snapshot consistency in SQLite WAL mode, but this should be explicit.

**Fix:**
The `readonly=True` flag + SQLite WAL mode already provides snapshot isolation for reads. Add a comment confirming this is intentional:
```python
        # SQLite WAL mode + readonly=True provides snapshot isolation —
        # all reads within this connection see a consistent point-in-time view.
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
```

If the project ever migrates to a different DB, this assumption must be revisited.

---

### FIX-13: Rate Limiting on Forecast Endpoints

**File:** `server/index.js`
**Routes:** `/api/forecast/generate`, `/api/internal/forecast/generate-auto`
**Risk:** DoS via repeated forecast generation requests

**Problem:**
No rate limiting exists. While `forecastGenerating` prevents concurrent runs, a client can still spam requests that each individually trigger generation.

**Fix — simple cooldown (no new dependencies):**
```javascript
let _lastForecastRequestTime = 0;
const FORECAST_COOLDOWN_MS = 30 * 1000; // 30 seconds between requests

// Add at the top of /api/forecast/generate handler:
  const now = Date.now();
  if (now - _lastForecastRequestTime < FORECAST_COOLDOWN_MS) {
    return res.status(429).json({
      ok: false,
      error: `Please wait ${Math.ceil((FORECAST_COOLDOWN_MS - (now - _lastForecastRequestTime)) / 1000)}s before retrying.`,
    });
  }
  _lastForecastRequestTime = now;
```

---

### FIX-14: Internal Endpoint Rate Limiting

**File:** `server/index.js`
**Route:** `/api/internal/forecast/generate-auto` (lines 13632-13683)
**Risk:** Python service in crash loop floods the internal endpoint

**Fix — simple cooldown:**
```javascript
let _lastInternalForecastTime = 0;
const INTERNAL_FORECAST_COOLDOWN_MS = 60 * 1000; // 1 minute

// Add at the top of the route handler:
  const now = Date.now();
  if (now - _lastInternalForecastTime < INTERNAL_FORECAST_COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: "Internal cooldown active." });
  }
  _lastInternalForecastTime = now;
```

---

## P3 - LOW (Backlog)

### FIX-15: Feature Importance Logging

**File:** `services/forecast_engine.py`
**Location:** After `train_ml_model()` / LightGBM training completes
**Risk:** None (observability improvement)

**Fix:**
After training, extract and log feature importances:
```python
    if hasattr(model, "feature_importances_"):
        importances = dict(zip(FEATURE_COLS, model.feature_importances_))
        sorted_imp = sorted(importances.items(), key=lambda x: x[1], reverse=True)
        log.info("Top-10 features: %s", [(k, f"{v:.1f}") for k, v in sorted_imp[:10]])
        log.info("Bottom-5 features: %s", [(k, f"{v:.1f}") for k, v in sorted_imp[-5:]])
        # Persist to train state for UI display
        _update_train_state({
            "feature_importance_top10": [{"name": k, "importance": float(v)} for k, v in sorted_imp[:10]],
        })
```

---

### FIX-16: Atomic Model Persistence

**File:** `services/forecast_engine.py`
**Function:** `save_model_bundle()` (lines 6408-6415)
**Risk:** Half-written model file loaded during race condition

**Note:** This is already addressed as part of FIX-06 (SHA256 fix includes atomic temp+rename).

---

### FIX-17: Model Checkpoint History (Keep Last 3)

**File:** `services/forecast_engine.py`
**Function:** `save_model_bundle()`
**Risk:** One bad training run deletes the last good model

**Fix:**
Before saving the new model, rename the current one:
```python
    # Keep last 3 checkpoints
    for i in range(2, 0, -1):
        src = MODEL_BUNDLE_FILE.with_suffix(f".prev{i}.joblib")
        dst = MODEL_BUNDLE_FILE.with_suffix(f".prev{i+1}.joblib")
        if src.exists():
            if i == 2:
                src.unlink()  # Delete oldest
            else:
                src.rename(dst)
    if MODEL_BUNDLE_FILE.exists():
        MODEL_BUNDLE_FILE.rename(MODEL_BUNDLE_FILE.with_suffix(".prev1.joblib"))
```

---

### FIX-18: Solcast Reliability Artifact Minimum Sample Threshold

**File:** `services/forecast_engine.py`
**Function:** `lookup_solcast_reliability()`
**Risk:** Over-confident corrections on rare weather regimes with n=1 sample

**Fix:**
In the lookup function, check sample count and skip correction if too low:
```python
    support = cell.get("support_weight", 0)
    if support < 10:
        log.debug("Reliability cell '%s/%s' has only %d samples — using defaults", regime, season, support)
        return {"bias_ratio": 1.0, "reliability": 0.62}
```

---

## Implementation Order

```
Phase 1 (P0 — before release):
  FIX-01 → FIX-03 → FIX-02 → FIX-05 → FIX-04
  |         |         |         |         |
  Python    Python    Python    Node.js   Node.js

Phase 2 (P1 — this sprint):
  FIX-06 → FIX-07 → FIX-09    FIX-08 → FIX-10
  |         |         |         |         |
  Python    Python    Python    Node.js   Node.js
  (depends on FIX-01)

Phase 3 (P2 — next sprint):
  FIX-11 → FIX-12    FIX-13 → FIX-14
  |         |         |         |
  Python    Python    Node.js   Node.js

Phase 4 (P3 — backlog):
  FIX-15, FIX-17, FIX-18
```

---

## Smoke Test Checklist

After implementing each phase, run these validations:

### Phase 1 (P0)
- [ ] Start server with v2.4.x model bundle (62 features) — confirm forecast generation succeeds
- [ ] Start server with v2.5.0 model bundle (68 features) — confirm forecast generation succeeds
- [ ] Corrupt model file — confirm graceful fallback to physics baseline
- [ ] Inject inverted P10 > P90 snapshot — confirm warning logged and values clamped
- [ ] Send POST `/api/forecast/generate` with empty dates — confirm 400 response (not 500)
- [ ] Send POST `/api/forecast/generate` with future date > 15 days — confirm 400 response
- [ ] Trigger two concurrent forecast requests — confirm second gets 409

### Phase 2 (P1)
- [ ] Save model, verify SHA256 in ml_train_state.json
- [ ] Corrupt model file byte, confirm load rejects with checksum mismatch
- [ ] Run build_features() — confirm assertion passes
- [ ] Stop Node server, trigger Python auto — confirm audit has `auto_service_fallback`
- [ ] Start multi-date (7-day) generation — confirm job visible for 60 minutes
- [ ] Simulate cron hang — confirm 45-min safety timeout resets flag

### Phase 3 (P2)
- [ ] Feed w5 with < SLOTS_DAY rows to confidence_bands() — confirm no crash
- [ ] Send 3 rapid forecast requests within 30 seconds — confirm 429 on 2nd and 3rd
- [ ] Confirm Python internal delegation respects 60s cooldown

---

## Files Modified

| File | Fixes |
|------|-------|
| `services/forecast_engine.py` | FIX-01, 02, 03, 06, 07, 09, 11, 12, 15, 17, 18 |
| `server/index.js` | FIX-04, 05, 08, 10, 13, 14 |

---

## Notes

- FIX-04 (race condition): Re-analysis confirms this is not a real race in Node.js's single-threaded event loop, but the safety timeout is still valuable for hung generation recovery.
- FIX-12 (transaction isolation): SQLite WAL + readonly already provides snapshot isolation. The fix is documentation-only.
- FIX-16 is merged into FIX-06.
- Year 2038 timestamp issue (from Python review): Python uses arbitrary-precision integers natively, so `int(ts * 1000)` will not overflow. The reviewer's concern applies to C/32-bit platforms, not CPython. No fix needed.
