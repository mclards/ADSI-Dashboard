# Comprehensive Integrity Audit: Day-Ahead Forecast Generation Pipeline
**File:** `services/forecast_engine.py`  
**Date:** 2026-04-02  
**Auditor:** Claude Code  
**Scope:** Complete 7-step pipeline, data flow, Solcast integration, ML backend, error memory, audit persistence, Node delegation

---

## Executive Summary

The day-ahead forecast generation pipeline is fundamentally sound with excellent defensive programming. However, **5 issues were identified** ranging from CRITICAL to MEDIUM severity:

1. **CRITICAL:** Missing slot array bounds checking in solar window operations
2. **HIGH:** Potential undefined behavior when model file exists but bundle/model object is None
3. **HIGH:** Array shape assumption violations in confidence band construction
4. **MEDIUM:** Solcast coverage ratio clipping inconsistency
5. **MEDIUM:** Feature alignment silent fallback to zero-fill masks legacy data loss

---

## 1. RUN_DAYAHEAD PIPELINE ANALYSIS

### Overview
The 7-step pipeline (lines 8413–9061) is well-structured:
1. **Weather loading & validation** (lines 8453–8523)
2. **Physics baseline** (lines 8524–8560)
3. **Solcast integration & blend** (lines 8526–8560)
4. **ML residual prediction** (lines 8562–8713)
5. **Error memory correction** (lines 8715–8744)
6. **Shape/activity correction & clipping** (lines 8746–8869)
7. **Confidence bands & audit persistence** (lines 8871–9061)

### Step 1: Weather Loading & Validation ✓ SOUND
**Lines 8453–8522**

**Strengths:**
- Proper fallback chain: forecast → snapshot → archive-fallback
- Explicit presence checks before data use
- Comprehensive validation via `validate_weather_5min()`
- Returns early with `False`/`None` on missing weather

**No issues found.**

---

### Step 2: Physics Baseline ✓ SOUND
**Lines 8524–8525**

**Code:**
```python
baseline = physics_baseline(target_s, w5)
```

**Function verification** (lines 1717–1776):
- Returns `np.ndarray` of shape (SLOTS_DAY,) guaranteed
- Proper zero-clipping outside solar window (lines 1773–1774)
- Temperature derating with bounds (lines 1750–1751)
- Ramp guard at sunrise (lines 1764–1767)
- RAD_MIN_WM2 threshold applied (line 1761)

**No issues found.**

---

### Step 3: Solcast Integration & Blend ✓ MOSTLY SOUND
**Lines 8526–8560**

#### 3.1 Solcast Prior Loading
**Function:** `solcast_prior_from_snapshot()` (lines 4125–4315)

**Strengths:**
- Coverage check: `int(snapshot.get("coverage_slots", 0)) < SOLCAST_MIN_USABLE_SLOTS` → returns `None`
- P10/P90 ordering constraint enforcement (lines 4161–4169)
- Tri-band feature detection with fallback to zero-spread (lines 4286–4290)
- Bias ratio clipping (line 4152)
- Trend signal integration with degrading mode suppression (lines 4197–4200)

**Potential issue:** Lines 4145–4148
```python
prior_kwh = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None).copy()
prior_lo = np.clip(np.asarray(snapshot["forecast_lo_kwh"], dtype=float), 0.0, None).copy()
prior_hi = np.asarray(snapshot["forecast_hi_kwh"], dtype=float), 0.0, None).copy()
prior_mw = np.clip(np.asarray(snapshot["forecast_mw"], dtype=float), 0.0, None).copy()
```
- **Issue:** Array shapes are not validated. If `snapshot` contains arrays of length ≠ 288, downstream `blend_physics_with_solcast()` will silently operate on misaligned data.
- **Severity:** HIGH (silent data corruption)
- **Fix:** Add validation:
  ```python
  if prior_kwh.size != SLOTS_DAY:
      log.warning("Solcast prior array size mismatch: %d != %d", prior_kwh.size, SLOTS_DAY)
      return None
  ```

#### 3.2 Blend Physics with Solcast
**Function:** `blend_physics_with_solcast()` (lines 4318–4424)

**Strengths:**
- Returns consistent metadata on both branches (with/without Solcast)
- Proper ratio clipping (line 4372)
- Presence masking in blending (line 4387)
- Solar window enforcement (lines 4388–4389)

**Critical Issue:** Lines 4366–4383
```python
solar_present = present[SOLAR_START_SLOT:SOLAR_END_SLOT]
base_solar = base[SOLAR_START_SLOT:SOLAR_END_SLOT]
prior_solar = prior[SOLAR_START_SLOT:SOLAR_END_SLOT]
...
if base_total > 0.0 and prior_total > 0.0 and np.any(solar_present):
    solar_profile = np.zeros_like(prior_solar)
    solar_profile[solar_present] = prior_solar[solar_present] / max(prior_total, 1.0)
    adjusted_total = base_total * applied_ratio
    adjusted_prior[SOLAR_START_SLOT:SOLAR_END_SLOT] = solar_profile * adjusted_total
    adjusted_prior[:SOLAR_START_SLOT] = 0.0
    adjusted_prior[SOLAR_END_SLOT:] = 0.0
```

**Issue:** If `prior` array size < SLOTS_DAY, the slicing `prior[SOLAR_START_SLOT:SOLAR_END_SLOT]` will produce an undersized array. Downstream operations then silently propagate truncated data.

- **Severity:** CRITICAL
- **Impact:** Forecast would be computed with partial Solcast data, degrading accuracy
- **Fix:** Add guard at function entry:
  ```python
  if prior.size != SLOTS_DAY:
      log.error("Solcast prior size %d != SLOTS_DAY %d — cannot blend", prior.size, SLOTS_DAY)
      return base.copy(), {...with used_solcast: False...}
  ```

---

### Step 4: ML Residual Prediction ✓ MOSTLY SOUND
**Lines 8562–8713**

#### 4.1 Feature Building
**Function:** `build_features()` (lines 2270–2597)

**Feature count verification** (lines 2561–2571):
```python
if len(df.columns) != len(FEATURE_COLS):
    log.error("build_features column count mismatch: got %d, expected %d...")
    assert len(df.columns) == len(FEATURE_COLS)
```
**Excellent:** Runtime assertion prevents silent feature misalignment.

**Tri-band feature handling** (lines 2424–2475):
- Fallback to zero-spread when `has_triband=False` (lines 2440–2442)
- Spread percentage with division-by-zero guard (lines 2452–2461)
- Spread ratio with safe division (lines 2464–2473)
- **No issues found here.**

#### 4.2 Model Bundle Loading & Prediction
**Function:** `load_model_bundle()` (lines 6473–6521)

**Strengths:**
- Checksum validation (lines 6479–6486) with fallback to None on mismatch
- Legacy model support with wrapper dict (lines 6493–6518)
- Feature name preservation in metadata (line 6506)

**Issue:** Lines 6487–6489
```python
data = load(MODEL_BUNDLE_FILE)
if isinstance(data, dict):
    return data
```
- **Missing:** If `load()` succeeds but returns a non-dict (e.g., a numpy array or single model object), the function continues to legacy fallback. This could mask file corruption.
- **Severity:** MEDIUM
- **Fix:** Add explicit type check with logging:
  ```python
  data = load(MODEL_BUNDLE_FILE)
  if isinstance(data, dict):
      return data
  else:
      log.error("Model bundle invalid type: %s (expected dict)", type(data).__name__)
      return None
  ```

#### 4.3 Feature Alignment
**Function:** `_align_bundle_features()` (lines 6524–6558)

**Strengths:**
- Fallback to zero-fill for missing columns (line 6536)
- Legacy model truncation with logging (lines 6546–6552)

**Issue:** Line 6536 - Silent zero-fill masks feature loading failures
```python
else:
    X_aligned[col] = 0.0
```
- If the feature is expected but missing from w5/computed features, zeroing it will degrade prediction accuracy silently.
- **Severity:** MEDIUM (data loss, no exception)
- **Recommendation:** Log at DEBUG level for explicit audit trail:
  ```python
  X_aligned[col] = 0.0
  log.debug("Feature '%s' not in X_pred — using 0.0 fallback", col)
  ```

#### 4.4 ML Prediction Call
**Lines 8602–8643:**
```python
raw_residual, model_meta = predict_residual_with_bundle(
    model_bundle,
    X_pred,
    target_regime,
    regime_confidence=float(bias_meta.get("regime_confidence", 1.0)),
)
ml_residual[:] = raw_residual
```

**Potential issue:** Lines 8608–8609
```python
ml_residual           = np.zeros(SLOTS_DAY)
ml_residual[:] = raw_residual
```
- If `raw_residual` size ≠ SLOTS_DAY (from `predict_residual_with_bundle`), this will fail with a shape mismatch.
- **Check:** `predict_residual_with_bundle()` at line 6586 calls `global_model.predict(X_global)` which should return shape (n_samples,) matching X_global rows = len(X_pred) = SLOTS_DAY.
- **Verdict:** Safe (depends on X_global shape being SLOTS_DAY, which is correct).

#### 4.5 Error Class Prediction
**Lines 8644–8695:**

The error classifier prediction (`predict_error_classifier_with_bundle()`) is complex. Key checks:

**Line 8655–8658:**
```python
class_cap_frac = np.asarray(classifier_meta.get("cap_frac"), dtype=float).reshape(-1)
if class_cap_frac.size < SLOTS_DAY:
    class_cap_frac = np.pad(class_cap_frac, (0, SLOTS_DAY - class_cap_frac.size), constant_values=ERROR_CLASS_BIAS_CAP_FRAC)
```
**Good:** Handles undersized arrays with padding.

**Line 8673–8676:**
```python
class_trust_scale = np.asarray(classifier_meta.get("trust_scale"), dtype=float).reshape(-1)
if class_trust_scale.size < SLOTS_DAY:
    class_trust_scale = np.pad(class_trust_scale, (0, SLOTS_DAY - class_trust_scale.size), constant_values=1.0)
```
**Good:** Same padding pattern.

**No issues in error class branch.**

---

### Step 5: Error Memory Correction ✓ SOUND
**Lines 8715–8744**

#### 5.1 Error Memory Computation
**Function:** `compute_error_memory()` (lines 4594–4758)

**Key validation:**
- Date range query with backward offset (line 4613)
- Regime mismatch penalty (lines 4664–4667)
- Regime factor weighting (line 4667): `ERR_MEMORY_REGIME_MISMATCH_PENALTY`
- Decay formula: `ERR_MEMORY_DECAY ** (days_ago - 1)` (line 4694)
- Source weight computation: `_memory_source_weight()` (line 4651)

**Strengths:**
- Fallback to legacy method on DB error (lines 4632–4633, 4707–4708)
- Support weight clipping (line 4693)
- Per-TOD zone flooring (lines 4726–4752) ensures bias doesn't vanish in consistent regimes
- Final clipping to ±100 kWh/slot (line 4757) prevents extreme outliers

**Issue:** Line 4713
```python
weighted_sum = np.sum(np.stack([w * e for w, e in zip(weight_vectors, errors)]), axis=0)
```
- If `weight_vectors` or `errors` is empty, `np.stack()` raises ValueError
- **Check:** Line 4710 guards with `if not errors: return _compute_error_memory_legacy(today)`
- **Verdict:** Safe.

#### 5.2 Bias Correction Application
**Lines 8717–8744:**
```python
bias_correction = ERROR_ALPHA * err_mem
bias_correction[:SOLAR_START_SLOT] = 0.0
bias_correction[SOLAR_END_SLOT:]   = 0.0
```
**Good:** Scales by ERROR_ALPHA (0.28) and zeros outside solar window.

**Solcast dampening** (lines 8724–8737):
```python
if bool(solcast_meta.get("used_solcast")):
    _sc_cov = float(solcast_meta.get("coverage_ratio", 0.0))
    if _sc_cov >= 0.95:
        _bias_damp = 0.30
    elif _sc_cov >= 0.80:
        _bias_damp = 0.50
    else:
        _bias_damp = 1.0
```
**Strengths:**
- High-confidence Solcast (cov ≥ 0.95) dampens bias by 70%
- Usable Solcast (0.80–0.95) dampens by 50%
- Fallback case keeps full bias

**No issues found.**

---

### Step 6: Final Clipping & Solar Window Enforcement ✓ SOUND
**Lines 8746–8869**

#### 6.1 Forecast Combination
**Line 8747:**
```python
forecast = hybrid_baseline + ml_residual + error_class_term + bias_correction
```
**Verified:** All four arrays are SLOTS_DAY-sized.

#### 6.2 Clipping to Slot Capacity
**Lines 8752–8765:**
```python
cap_slot_dep = slot_cap_kwh(dependable=True)
cap_slot_max = slot_cap_kwh(dependable=False)
cap_slot = cap_slot_max
forecast = np.clip(forecast, 0.0, cap_slot)
forecast[:SOLAR_START_SLOT] = 0.0
forecast[SOLAR_END_SLOT:]   = 0.0
```
**Good:** Clips to hard physical max, then zeros non-solar.

#### 6.3 Shape Correction
**Lines 8767–8777:**
```python
if bool(solcast_meta.get("used_solcast")):
    shape_meta = {
        "hours_shaped": 0,
        "avg_matches": 0.0,
        "avg_score": None,
        "skipped_for_solcast": True,
    }
else:
    forecast, shape_meta = apply_hour_shape_correction(forecast, target_s, w5, artifacts)
```
**Good:** Skips shape correction when Solcast is primary (preserves Solcast shape).

#### 6.4 Solcast Per-Slot Floor
**Lines 8814–8857:**

This is a sophisticated feature. Critical code:

```python
if bool(solcast_meta.get("used_solcast")):
    _sc_cov_f = float(solcast_meta.get("coverage_ratio", 0.0))
    _sc_kwh = np.asarray(solcast_snapshot.get("forecast_kwh", []), dtype=float)
    if _sc_kwh.size == SLOTS_DAY:  # ← Bounds check!
        if _sc_cov_f >= 0.95:
            _floor_ratio = SOLCAST_FORECAST_FLOOR_RATIO_FRESH
        elif _sc_cov_f >= 0.80:
            _floor_ratio = SOLCAST_FORECAST_FLOOR_RATIO_USABLE
        else:
            _floor_ratio = 0.0
```

**Critical Issue:** Lines 8815–8816
```python
_sc_cov_f = float(solcast_meta.get("coverage_ratio", 0.0))
_sc_kwh = np.asarray(solcast_snapshot.get("forecast_kwh", []), dtype=float)
```

- **Issue:** If `solcast_snapshot` is `None` or does not have "forecast_kwh", `_sc_kwh` becomes an empty array, and `_sc_kwh.size == SLOTS_DAY` returns False safely.
- However, the **coverage_ratio** in solcast_meta is used to decide floor_ratio, but the code then tries to use `_sc_kwh` which could have different coverage.
- **Verdict:** Code is defensive; `if _sc_kwh.size == SLOTS_DAY:` guards the operation. **Safe.**

**Potential issue:** Line 8853
```python
"%.0f%.0f kWh (floor=%.0f%% coverage=%.2f)",
_fc_before, float(forecast.sum()),
_floor_ratio * 100.0, _sc_cov_f,
```
- **Format string error:** `"%.0f%.0f kWh"` with two format args separated by nothing produces garbled output like "1234567 kWh" instead of "1234 567 kWh".
- **Severity:** MEDIUM (logging only, doesn't affect forecast)
- **Fix:** Change to `"%.0f->%.0f kWh"` or `"%.0f / %.0f kWh"`

#### 6.5 AnEn Correction
**Lines 8859–8869:**
```python
_anen_ratio = _anen_correction_ratio(_anen_analogs)
if abs(_anen_ratio - 1.0) > 0.005:
    forecast = np.clip(forecast * _anen_ratio, 0.0, None)
```
**Good:** Applies post-correction if ratio deviates >0.5% from unity.

#### 6.6 Activity Hysteresis
**Line 8776:**
```python
forecast, activity_meta = apply_activity_hysteresis(forecast, target_s, w5, artifacts, bias_meta=bias_meta)
```
**Function:** `apply_activity_hysteresis()` (lines 5686–5727)

**Potential issue:** Function signature has `bias_meta=bias_meta` parameter. Verify it's defined:
- **Line 5686:** `def apply_activity_hysteresis(forecast: np.ndarray, day: str, w5: pd.DataFrame, artifacts: dict, bias_meta: dict | None = None) -> tuple[np.ndarray, dict]:`
- **Verified:** Parameter exists. **Safe.**

#### 6.7 Ramp Rate Limiting
**Lines 8795–8799:**
```python
forecast = apply_ramp_limit(forecast)
forecast = np.clip(forecast, 0.0, cap_slot)
```
**Function:** `apply_ramp_limit()` (lines 6928–6938)

```python
def apply_ramp_limit(arr: np.ndarray, max_step: float = 320.0) -> np.ndarray:
    """Enforce maximum ramp rate between consecutive 5-min slots: 320 kWh/slot ≈ 96 MW/h."""
    arr = np.asarray(arr, dtype=float)
    diff = np.diff(arr, prepend=arr[0])
    ramp_violation = np.abs(diff) > max_step
    if not np.any(ramp_violation):
        return arr
    out = np.zeros_like(arr)
    out[0] = arr[0]
    for i in range(1, len(arr)):
        ramp = np.clip(diff[i], -max_step, max_step)
        out[i] = out[i - 1] + ramp
    return out
```

**Issue:** Lines 6934–6937
```python
for i in range(1, len(arr)):
    ramp = np.clip(diff[i], -max_step, max_step)
    out[i] = out[i - 1] + ramp
```

- If `arr` size < 2, the loop never executes and `out` remains all zeros except `out[0]`.
- **Check:** arr comes from forecast combination (always SLOTS_DAY = 288). **Safe for this use case.**
- **Verdict:** Function works but would fail silently on undersized arrays. **Not a blocker for forecast_engine usage.**

#### 6.8 Sanity Check
**Lines 8950–8961:**
```python
_fc_total_kwh = float(np.sum(forecast))
_physics_total_kwh = float(np.sum(baseline))
if _physics_total_kwh > 0:
    _fc_ratio = _fc_total_kwh / _physics_total_kwh
    if _fc_ratio < 0.30 or _fc_ratio > 2.50:
        log.error("FORECAST SANITY FAIL: total=%.1f kWh is %.1f%% of physics...")
        return {"status": "error", "reason": "sanity_check_failed", "fc_ratio": round(_fc_ratio, 3)} if not persist else False
```

**Good:** Catches pathological forecasts with ratio outside [0.30, 2.50].

---

### Step 7: Confidence Bands & Audit Persistence ✓ MOSTLY SOUND
**Lines 8871–9061**

#### 7.1 Confidence Bands
**Function:** `confidence_bands()` (lines 7055–7139)

**Critical Issue:** Line 7072–7074
```python
if len(w5) < SLOTS_DAY:
    log.warning("confidence_bands: w5 has %d rows, expected %d — padding with forward-fill", len(w5), SLOTS_DAY)
    w5 = w5.reindex(range(SLOTS_DAY)).ffill().fillna(0.0)
```

**Problem:** Forward-fill can propagate NaN indefinitely. If w5 has 150 rows of data and then all NaN, ffill + fillna(0.0) will fill remaining 138 rows with 0.0, which is conservative but wrong for cloud cover (should be 50%, not 0%).

- **Severity:** MEDIUM (confidence bands will be overly conservative on partial data)
- **Recommendation:** Use a more robust interpolation or explicit solar-window default:
  ```python
  if len(w5) < SLOTS_DAY:
      cloud_default = 50.0  # mid-range conservative estimate
      w5 = w5.reindex(range(SLOTS_DAY)).ffill().fillna(cloud_default)
  ```

**Lines 7084–7089:** Padding for array size mismatch
```python
if class_confidence.size < SLOTS_DAY:
    class_confidence = np.pad(class_confidence, (0, SLOTS_DAY - class_confidence.size), constant_values=1.0)
class_confidence = class_confidence[:SLOTS_DAY]
```
**Good:** Safe padding to SLOTS_DAY.

**Solcast P10/P90 blending** (lines 7118–7137):
```python
if solcast_prior is not None:
    _sc_lo = np.asarray(solcast_prior.get("prior_lo_kwh", []), dtype=float)
    _sc_hi = np.asarray(solcast_prior.get("prior_hi_kwh", []), dtype=float)
    if _sc_lo.size != SLOTS_DAY or _sc_hi.size != SLOTS_DAY:
        log.debug("Solcast P10/P90 skipped: size mismatch...")
```
**Good:** Validates array sizes before use.

#### 7.2 Series Conversion
**Lines 8894–8921:**
```python
series = to_ui_series(forecast, lo, hi, target_s)
```

**Function:** `to_ui_series()` (lines 7946–7966)

```python
def to_ui_series(
    forecast: np.ndarray,
    lo: np.ndarray | None,
    hi: np.ndarray | None,
    day: str,
) -> list[dict]:
    out = []
    for slot_idx in range(SLOTS_DAY):
        out.append({
            "slot": slot_idx,
            "kwh": float(forecast[slot_idx]) if forecast.size > slot_idx else 0.0,
            "lo": float(lo[slot_idx]) if lo is not None and lo.size > slot_idx else 0.0,
            "hi": float(hi[slot_idx]) if hi is not None and hi.size > slot_idx else 0.0,
            "time": _slot_time_text(slot_idx, day),
        })
    return out
```

**Issue:** Line 7953–7954
```python
"kwh": float(forecast[slot_idx]) if forecast.size > slot_idx else 0.0,
```
- **Defensive:** Checks `forecast.size > slot_idx` before access.
- However, since `forecast` is guaranteed SLOTS_DAY from combination, this check is redundant but harmless.

**No issues found.**

#### 7.3 Audit Persistence
**Function:** `_write_forecast_run_audit_from_python()` (lines 8117–8242)

**Key fields populated:**
- target_date, generated_ts, generator_mode
- provider_used, provider_expected (both "ml_local")
- forecast_variant, weather_source
- solcast metadata (coverage, blend, reliability, primary_mode, source)
- forecast totals (physics, hybrid, final, ml residual, error_class, bias)
- run_status, solcast_freshness_class
- is_authoritative_runtime, is_authoritative_learning
- replaces_run_audit_id (supersession chain)

**Authoritative flag logic** (lines 8148–8159):
```python
prev_row = conn.execute(
    """
    SELECT id FROM forecast_run_audit
     WHERE target_date = ?
       AND is_authoritative_runtime = 1
       AND run_status = 'success'
     ORDER BY generated_ts DESC LIMIT 1
    """,
    (target_s,),
).fetchone()
prev_id = int(prev_row[0]) if prev_row else None
```

**Logic:**
- Find the most recent authoritative success for same day
- Insert new row with `is_authoritative_runtime = 1`
- If prev_id found, update it to `is_authoritative_runtime = 0` and set supersession chain

**Issue:** Lines 8218–8230
```python
if prev_id is not None and new_id:
    conn.execute(
        """
        UPDATE forecast_run_audit
           SET is_authoritative_runtime = 0,
               is_authoritative_learning = 0,
               superseded_by_run_audit_id = ?,
               run_status = 'superseded'
         WHERE id = ?
        """,
        (new_id, prev_id),
    )
```

- **Missing:** No commit before the UPDATE query in the visible code. Check next line...
- **Line 8232:** `conn.commit()` is present. **Safe.**

**Quality class logic** (line 8143):
```python
quality_class = "ml_fallback" if ml_failed else "healthy"
```
- **Issue:** Only two classes used. Per spec, should include:
  - `missing`, `incomplete`, `missing_audit`, `wrong_provider`, `stale_input`, `weak_quality`, `healthy`
- **Severity:** HIGH (incorrect quality classification)
- **Current behavior:** Python direct runs always report "healthy" or "ml_fallback", missing `wrong_provider` class for Solcast variants
- **Fix:** Implement full quality classification:
  ```python
  if ml_failed:
      quality_class = "ml_fallback"
  elif not solcast_meta.get("used_solcast") and (target_regime == "clear" and dt.now().hour in DA_RUN_HOURS_PRIMARY):
      quality_class = "wrong_provider"  # Missing Solcast when it should be available
  else:
      quality_class = "healthy"
  ```

---

## 2. DATA FLOW INTEGRITY ANALYSIS

### Array Shape Contracts
| Function | Input Shape | Output Shape | Validation |
|----------|-------------|--------------|-----------|
| `physics_baseline()` | w5: (288,) | (288,) | Explicit zeros |
| `solcast_prior_from_snapshot()` | snapshot: varies | dict with (288,) arrays | **MISSING: no validation** |
| `blend_physics_with_solcast()` | baseline: (288,), prior: varies | (288,) | **MISSING: assumes prior=(288,)** |
| `build_features()` | w5: (288,) | pd.DataFrame: (288, 68) | Assertion at line 2569 ✓ |
| `predict_residual_with_bundle()` | X_pred: (288, n) | (288,) | Implicit (relies on X shape) |
| `compute_error_memory()` | — | (288,) | Explicit zeros |
| `confidence_bands()` | values: (288,) | lo, hi: (288,) | Defensive padding |
| `to_ui_series()` | forecast: (288,), lo: (288,), hi: (288,) | list[288 dicts] | Defensive array.size checks |

### Key Finding: Solcast Array Shape Not Validated
**Risk:** If `solcast_snapshot` contains forecast_kwh of size ≠ 288, the functions will silently operate on misaligned data, producing a forecast with incorrect day-to-day energy totals.

**Recommended Guard** (add after line 8531 in run_dayahead):
```python
if solcast_prior is not None:
    for key in ("prior_kwh", "prior_lo_kwh", "prior_hi_kwh", "prior_mw", "spread_frac", "present"):
        arr = solcast_prior.get(key)
        if arr is not None:
            arr = np.asarray(arr, dtype=float)
            if arr.size != SLOTS_DAY:
                log.error("Solcast prior '%s' size %d != SLOTS_DAY %d — discarding Solcast", key, arr.size, SLOTS_DAY)
                solcast_prior = None
                break
```

---

### NaN Propagation Risk Analysis

| Step | Potential NaN Source | Handling |
|------|----------------------|----------|
| Weather load | Missing columns in w5 | fillna(0.0) in `col()` function (line 2296) |
| Physics baseline | divide-by-zero in temp derating | Clipping to [0.7, 1.05] (line 1751) |
| Solcast blend | divide-by-zero in ratio | Uses `np.maximum(..., 1.0)` (line 4371) |
| ML residual | NaN from model prediction | No explicit guard — relies on scaler/model |
| Confidence bands | NaN in cloud_i | Guard at line 7105: `if not np.isfinite(cloud_i): cloud_i = 50.0` ✓ |
| Error memory | divide-by-zero in per-slot weighting | Uses `np.divide(..., where=weight_sum > 0)` (line 4715–4720) ✓ |

**Risk:** ML model prediction (line 8586) could return NaN if:
- Scaler produces NaN on out-of-range inputs
- Model has NaN weights (corrupted file)

**Recommended Guard** (add after line 8609):
```python
if not np.all(np.isfinite(ml_residual)):
    nan_count = int(np.sum(~np.isfinite(ml_residual)))
    log.error("ML residual contains %d NaN/Inf values — falling back to zero", nan_count)
    ml_residual = np.zeros(SLOTS_DAY)
    _ml_failed = True
```

---

### Division by Zero Analysis

| Location | Denominator | Guard |
|----------|-------------|-------|
| Line 4371: ratio calc | `max(base_total, 1.0)` | ✓ Guarded |
| Line 4381: profile norm | `max(prior_total, 1.0)` | ✓ Guarded |
| Line 2346: Kt calc | `np.maximum(csi_arr, 1)` | ✓ Guarded |
| Line 2350: DNI proxy | `np.maximum(rad, 1)` | ✓ Guarded |
| Line 2458: spread pct | `np.where(solcast_kwh > 0.05)` | ✓ Conditional |
| Line 2468: spread ratio | `np.where(sum_bands > 0.1)` | ✓ Conditional |
| Line 1753: power calc | G_stc = 1000 (constant) | N/A |

**All major divisions are guarded.** ✓

---

### Off-by-One Errors

| Location | Operation | Verification |
|----------|-----------|--------------|
| Line 8612: `ml_residual[:SOLAR_START_SLOT] = 0.0` | Zero before slot 60 | Correct (SOLAR_START_SLOT = 5 * 60 / 5 = 60) |
| Line 8613: `ml_residual[SOLAR_END_SLOT:] = 0.0` | Zero from slot 216 onward | Correct (SOLAR_END_SLOT = 18 * 60 / 5 = 216) |
| Line 8682: `_rolling_mean(ml_residual, 3, center=True)` | 3-slot window | Verified in `_rolling_mean()` at lines 1223–1236 |
| Line 4366: `solar_present = present[SOLAR_START_SLOT:SOLAR_END_SLOT]` | Slicing [60:216] | Correct (156 solar slots) |

**All indexing is correct.** ✓

---

## 3. SOLCAST INTEGRATION INTEGRITY

### Freshness Policy
**Lines 8531, 8572, 8724–8737:**

Solcast freshness determines behavior:
1. **Fresh** (cov ≥ 0.95, pulled ≤ 2h): Primary mode eligible, bias damp 0.30
2. **Stale usable** (cov ≥ 0.80, ≤ 12h): Secondary blend, bias damp 0.50
3. **Stale reject** (cov < 0.80 OR pulled > 12h): Not used
4. **Missing**: Physics baseline only

**Logic verification** (line 4131):
```python
if not snapshot or int(snapshot.get("coverage_slots", 0)) < SOLCAST_MIN_USABLE_SLOTS:
    return None
```
- SOLCAST_MIN_USABLE_SLOTS ≈ 150 (52% of 288 slots)
- This ensures minimum coverage before computing prior

**Blend formula** (line 4210):
```python
blend = base_by_regime * reliability_score * (0.55 + 0.45 * coverage_ratio) * spread_weight * solar_weight
```
- **base_by_regime**: Regime-specific baseline (0.44–0.82 kWh)
- **reliability_score**: Historical MAPE correlation (0.25–1.0)
- **coverage_ratio**: Fraction of slots with data (0.0–1.0)
- **spread_weight**: Tri-band confidence (0.58–1.0)
- **solar_weight**: Time-of-day modifier (0.45–1.0)

**Result:** blend scales from ~0.05 (rainy, low-coverage, low-confidence) to ~0.95 (clear, full-coverage, high-confidence).

**Coverage ratio clipping issue** (line 4154):
```python
coverage_ratio = float(np.clip(snapshot.get("coverage_ratio", 0.0), 0.0, 1.0))
```

vs. line 4393 in blend_physics_with_solcast:
```python
"coverage_ratio": float(solcast_prior.get("coverage_ratio", 0.0)),
```

**No clipping in output.** This is consistent. ✓

---

### Primary Mode Activation
**Lines 4193–4208:**

```python
primary_mode = bool(
    coverage_ratio >= SOLCAST_PRIMARY_COVERAGE_MIN  # 0.72
    and reliability_score >= SOLCAST_PRIMARY_RELIABILITY_MIN  # 0.65
)
if primary_mode and _trend_signal == "degrading":
    log.info("Solcast primary mode suppressed: trend signal is degrading")
    primary_mode = False
if primary_mode:
    base_by_regime = max(base_by_regime, 0.82)
```

**Good:** Trend check prevents primary mode on degrading forecasts.

---

### Tri-Band Feature Detection
**Lines 4286–4312:**

```python
has_triband = bool(
    np.any(prior_lo < prior_kwh - 0.01)
    and np.any(prior_hi > prior_kwh + 0.01)
)
return {
    ...
    "has_triband": has_triband,
    ...
}
```

**Threshold of 0.01 kWh** is conservative (50 W). If Solcast returns P10/P90 but all are within 10 W of forecast, `has_triband` is False and features default to zero-spread (lines 2440–2442).

**Recommendation:** This is a user-facing feature; document the 0.01 kWh threshold in SKILL.md.

---

### Potential Issue: Tri-Band Constraints Not Re-enforced
**Problem:** Lines 4161–4169 enforce P10 ≤ forecast ≤ P90 in `solcast_prior_from_snapshot()`.
However, `build_features()` at lines 2437–2438 re-enforces:
```python
solcast_lo_kwh = np.minimum(solcast_lo_kwh, solcast_kwh)
solcast_hi_kwh = np.maximum(solcast_hi_kwh, solcast_kwh)
```

**Why two levels?** Because features are built from solcast_prior dict which is the output of `solcast_prior_from_snapshot()`. The re-enforcement is defensive redundancy, which is good.

**No issues found.** ✓

---

## 4. ML MODEL INTEGRITY

### Model Loading & Fallback Chain
**Lines 8599–8713:**

1. **Load bundle** (line 8599)
2. **If no bundle, return zeros** (line 8712)
3. **Attempt prediction** (line 8602)
4. **On exception, fallback** (line 8708)

**Strength:** Explicit exception handling with log and zero-filling.

### Legacy Model Support
**Lines 6493–6518:**

```python
if MODEL_FILE.exists():
    try:
        model = load(MODEL_FILE)
        scaler = load(SCALER_FILE) if SCALER_FILE.exists() else None
        return {
            "created_ts": int(time.time()),
            "training_basis": "legacy-single-model",
            "global": {
                "model": model,
                "scaler": scaler,
                ...
            },
            ...
        }
```

**Issue:** If model exists but scaler doesn't, `scaler = None`. The wrapper dict still has a valid structure, so downstream code calls `_transform_bundle_features()` which checks `if scaler is not None` (line 6563).

**Verdict:** Safe due to None guard. ✓

### Feature Alignment Safety
**Lines 6524–6558:**

**Case 1: feature_names available** (line 6529)
```python
expected_cols = list((block.get("meta") or {}).get("feature_names") or bundle_feature_cols or [])
if expected_cols:
    X_aligned = pd.DataFrame(index=X_pred.index)
    for col in expected_cols:
        if col in X_pred.columns:
            X_aligned[col] = pd.to_numeric(X_pred[col], errors="coerce").fillna(0.0)
        else:
            X_aligned[col] = 0.0
```

- **Strength:** Preserves named features, fills missing with 0.0
- **Weakness:** No logging of which columns were zero-filled (makes auditing harder)

**Case 2: Legacy model by count** (line 6541–6557)
```python
if expected_count is not None and expected_count != int(X_pred.shape[1]):
    if expected_count < int(X_pred.shape[1]):
        # Legacy model with fewer features — truncate to match
        return X_pred.iloc[:, :expected_count]
    else:
        raise ValueError(...)
```

- **Strength:** Explicit truncation with logging
- **Safe:** Raises if more features expected than available

**Overall:** Feature alignment is conservative and defensive. ✓

---

## 5. ERROR MEMORY INTEGRITY

### Computation Flow
**Lines 4594–4758:**

1. **Query eligible rows** from `forecast_error_compare_daily` (lines 4619–4630)
2. **Fallback to legacy if no rows** (line 4632)
3. **For each day:** Extract regime, compute source & regime weights
4. **For each slot:** Apply decay, support_weight, regime_factor
5. **Stack & average** with weights (lines 4713–4720)
6. **Apply rolling mean** (line 4721)
7. **Per-TOD flooring** (lines 4726–4752)
8. **Final clipping** to ±100 (line 4757)

### Source Weighting
**Function:** `_memory_source_weight()` (lines 7436–7449)

```python
def _memory_source_weight(forecast_variant: str, provider_expected: str) -> float:
    variant = str(forecast_variant or "").strip().lower()
    provider = str(provider_expected or "").strip().lower()

    # Tier 1: Solcast direct (highest trust)
    if "solcast_direct" in variant and provider in ("solcast", "solcast_direct"):
        return 1.00
    # Tier 2: Solcast hybrid fresh
    if "solcast_hybrid_fresh" in variant and provider in ("solcast", "solcast_direct"):
        return 0.95
    # Tier 3: Solcast hybrid stale
    if "solcast_hybrid_stale" in variant and provider in ("solcast", "solcast_direct"):
        return 0.35
    # Tier 4: ML without Solcast (weakest signal)
    if "without_solcast" in variant:
        return 0.20
    return 0.0
```

**Spec compliance:** Matches spec exactly.
- solcast_direct: 1.00 ✓
- ml_solcast_hybrid_fresh: 0.95 ✓
- ml_solcast_hybrid_stale: 0.35 ✓
- ml_without_solcast: 0.20 ✓

### Decay Function
**Line 4694:**
```python
base_w = ERR_MEMORY_DECAY ** (days_ago - 1)
```
where `ERR_MEMORY_DECAY` (line 346) ≈ 0.87

- Days 1–7: weights 0.87, 0.76, 0.66, 0.57, 0.50, 0.43, 0.38
- **Meaning:** 7 days ago contributes 38% of recent day (1 day ago)
- **Reasonable:** Exponential decay biases recent history

### Per-TOD Flooring
**Lines 4726–4752:**

```python
for _tod_start, _tod_end in [
    (SOLAR_START_SLOT, SOLAR_START_SLOT + _tod_thirds),
    (SOLAR_START_SLOT + _tod_thirds, SOLAR_START_SLOT + 2 * _tod_thirds),
    (SOLAR_START_SLOT + 2 * _tod_thirds, SOLAR_END_SLOT),
]:
    _zone = mem_err[_tod_start:_tod_end]
    _zone_weights = weight_sum[_tod_start:_tod_end]
    _zone_active = _zone_weights > 0
    if np.sum(_zone_active) < 3:
        continue
    _zone_mean = np.mean(_zone[_zone_active])
    _zone_abs_mean = np.abs(_zone_mean)
    if _zone_abs_mean > 1.0:
        _same_sign = np.sum(np.sign(_zone[_zone_active]) == np.sign(_zone_mean))
        _consistency = _same_sign / max(np.sum(_zone_active), 1)
        if _consistency > 0.80:
            _floor = _zone_mean * 0.40
            if _zone_mean > 0:
                mem_err[_tod_start:_tod_end] = np.maximum(mem_err[_tod_start:_tod_end], _floor)
            else:
                mem_err[_tod_start:_tod_end] = np.minimum(mem_err[_tod_start:_tod_end], _floor)
```

**Logic:**
- Split solar window into 3 zones (morning, midday, afternoon)
- If zone has ≥3 active slots AND >80% same-sign bias AND bias magnitude >1 kWh/slot:
  - Floor = 40% of zone mean
  - Preserve at least 40% of persistent bias

**Good:** Prevents bias from being smoothed to zero by rolling mean.

**No issues found.** ✓

---

## 6. AUDIT PERSISTENCE

### Audit Row Structure
**Lines 8167–8193:**

Required fields populated:
- target_date ✓
- generated_ts ✓
- generator_mode ✓
- provider_used, provider_expected (both "ml_local") ✓
- forecast_variant ✓
- weather_source ✓
- solcast metadata (7 fields) ✓
- Forecast totals (6 fields: physics, hybrid, final, ml residual, error_class, bias) ✓
- shape_skipped_for_solcast ✓
- run_status ✓
- solcast_freshness_class ✓
- is_authoritative_runtime, is_authoritative_learning ✓
- replaces_run_audit_id ✓
- notes_json ✓

**All required fields present.** ✓

### Authoritative Flag Logic
**Issue Found:** Quality class logic (line 8143)

```python
quality_class = "ml_fallback" if ml_failed else "healthy"
```

But this variable is **never used in the INSERT statement**. Looking at lines 8165–8214, there's no `quality_class` column in the insert.

**Spec says:** Quality class should be one of:
- missing, incomplete, missing_audit, wrong_provider, stale_input, weak_quality, healthy

**Current behavior:** Python direct runs always insert:
- run_status = 'success'
- is_authoritative_runtime = 1
- is_authoritative_learning = 1

**Missing:** No way to mark a generation as `wrong_provider` if Solcast is unavailable when expected.

**Severity:** HIGH (breaks quality-aware regeneration rules)

**Recommendation:** Add quality_class to insert:
```python
quality_class = "healthy"
if ml_failed:
    quality_class = "ml_fallback"
elif not solcast_meta.get("used_solcast") and is_solcast_expected_for_regime(target_regime):
    quality_class = "wrong_provider"

# In INSERT columns
quality_class,
# In VALUES
quality_class,
```

---

### Supersession Chain
**Lines 8148–8230:**

Current behavior:
1. Find previous authoritative success for same target_date
2. Insert new row with is_authoritative_runtime = 1
3. Update previous row: is_authoritative_runtime = 0, run_status = 'superseded', superseded_by_run_audit_id = new_id

**Strength:** Creates immutable chain of generation attempts.

**Verified:** Safe (commit happens, chain is consistent). ✓

---

## 7. NODE ORCHESTRATOR DELEGATION

### Delegation Function
**Lines 9480–9511:**

```python
def _delegate_run_dayahead(target_date: date, trigger: str = "auto_service") -> dict | None:
    port = os.getenv("ADSI_SERVER_PORT", "3500")
    url = f"http://127.0.0.1:{port}/api/internal/forecast/generate-auto"
    target_s = target_date.isoformat()
    try:
        resp = requests.post(url, json={
            "dates": [target_s],
            "trigger": trigger,
        }, timeout=180)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            log.error("Node.js orchestrator returned error: %s", data.get("error"))
            return None
        return data
    except Exception as e:
        log.error("Failed to delegate generation to Node.js: %s", e)
        return None
```

**Port selection:** Uses ADSI_SERVER_PORT (default 3500) ✓ [Matches spec requirement]

**Timeout:** 180 seconds (3 minutes) ✓ [Reasonable for generation]

**Return:** `dict | None` ✓

**Fallback in auto loop** (lines 9639–9650):
```python
ok = _delegate_run_dayahead(target)
if not ok:
    log.warning("Node delegation failed in auto loop — attempting direct Python fallback...")
    try:
        _direct_result = run_dayahead(target, today, write_audit=True, audit_generator_mode="auto_service_fallback")
        if _direct_result:
            log.info("Auto loop Python fallback generation succeeded for %s", target_s)
            ok = True
```

**Good:** Fallback to direct run_dayahead() with audit_generator_mode="auto_service_fallback"

**Audit tracking:** Fallback is marked in generator_mode for audit trail ✓

---

## Summary Table: Issues by Severity

| Severity | Issue | Location | Impact | Status |
|----------|-------|----------|--------|--------|
| **CRITICAL** | Solcast array size not validated in blend | Line 4366 | Silent forecast corruption if array size ≠ 288 | **UNFIXED** |
| **CRITICAL** | Missing slot array bounds check | Line 4145–4148 | Forecast produced from truncated Solcast | **UNFIXED** |
| **HIGH** | Quality class not computed for Python direct path | Line 8143 | Cannot detect wrong_provider condition | **UNFIXED** |
| **HIGH** | Model bundle type not validated | Line 6487–6489 | Corrupted bundle could cause silent fallback | **UNFIXED** |
| **MEDIUM** | Feature alignment silent zero-fill | Line 6536 | Data loss masked, harder to audit | **UNFIXED** |
| **MEDIUM** | Confidence bands w5 padding uses zero | Line 7073–7074 | Overly conservative on partial data | **UNFIXED** |
| **MEDIUM** | Solcast per-slot floor format string error | Line 8853 | Garbled log output (cosmetic only) | **UNFIXED** |

---

## Recommendations

### Immediate Fixes (CRITICAL)

1. **Add Solcast array size validation in `solcast_prior_from_snapshot()`** (line 4147):
   ```python
   prior_kwh = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None).copy()
   if prior_kwh.size != SLOTS_DAY:
       log.warning("Solcast prior array size %d != SLOTS_DAY %d — discarding prior", prior_kwh.size, SLOTS_DAY)
       return None
   ```

2. **Add array size check in `blend_physics_with_solcast()`** (line 4322):
   ```python
   prior = np.clip(np.asarray(solcast_prior["prior_kwh"], dtype=float), 0.0, None)
   if prior.size != SLOTS_DAY:
       log.error("Solcast prior size mismatch — cannot blend")
       return base.copy(), {...}
   ```

### High Priority Fixes

3. **Implement full quality class logic** (line 8143):
   - Detect `wrong_provider` when Solcast unavailable for clear days
   - Mark `stale_input` for aged weather
   - Mark `missing_audit` if no audit row created

4. **Validate model bundle type** (line 6487):
   ```python
   data = load(MODEL_BUNDLE_FILE)
   if not isinstance(data, dict):
       log.error("Invalid model bundle type: %s", type(data).__name__)
       return None
   ```

### Medium Priority Fixes

5. **Add ML residual NaN check** (after line 8609):
   ```python
   if not np.all(np.isfinite(ml_residual)):
       log.error("ML residual contains NaN — falling back")
       ml_residual = np.zeros(SLOTS_DAY)
   ```

6. **Log feature zero-fill events** (line 6536):
   ```python
   X_aligned[col] = 0.0
   log.debug("Feature '%s' missing from X_pred — using 0.0", col)
   ```

7. **Fix Solcast per-slot floor log** (line 8853):
   ```python
   "%.0f→%.0f kWh (floor=%.0f%% coverage=%.2f)",
   ```

---

## Code Quality Observations

### Strengths
✓ Explicit error handling with fallbacks  
✓ Comprehensive logging for debugging  
✓ Defensive array size padding in critical paths  
✓ NaN/infinity checks where data flows from external sources  
✓ Feature column count assertion (line 2569)  
✓ Solcast coverage minimum threshold (line 4131)  
✓ Supersession chain for audit immutability  
✓ Timeout and retry logic for SQL operations  

### Weaknesses
✗ Silent zero-fill masks data loss (feature alignment)  
✗ Array size assumptions without validation (Solcast)  
✗ Quality class computation logic incomplete  
✗ No explicit bounds checking on raw Solcast arrays  
✗ Limited logging of feature alignment decisions  

---

## Conclusion

The day-ahead forecast pipeline is fundamentally well-designed with strong defensive programming. However, **5 unfixed issues** ranging from CRITICAL to MEDIUM severity compromise data integrity, particularly around Solcast array validation and quality classification. 

**The CRITICAL issues should be fixed before production runs** to prevent silent forecast corruption from malformed Solcast snapshots.

All 7 pipeline steps execute correctly when input data is well-formed, but the pipeline lacks explicit validation of external data shapes (Solcast arrays, weather arrays in edge cases).

**Recommend:**
1. Deploy critical fixes immediately
2. Add comprehensive integration tests for edge cases (truncated Solcast, missing arrays)
3. Enhanced audit trail for feature alignment decisions
4. Quality class logic for regeneration decisions

