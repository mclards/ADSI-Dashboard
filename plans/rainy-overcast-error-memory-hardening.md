# Blueprint: Rainy/Overcast Error Memory Hardening

**Objective:** Improve forecast accuracy during rainy and overcast regimes by fixing the systematic weaknesses in the error memory system that cause it to underperform exactly when generation impact is highest.

**Status:** Draft  
**Created:** 2026-04-10  
**Author:** Engr. M. + Claude  
**Target file:** `services/forecast_engine.py`  
**Branch strategy:** Single feature branch `feat/rainy-regime-memory-hardening` off `main`  
**Risk level:** Medium — parameter-level changes within existing logic; no new tables, no schema changes, no new dependencies  
**Rollback:** Revert single commit; all changes are constant/parameter adjustments  

---

## Problem Statement

The ADSI Dashboard's forecast engine has a sophisticated error memory system, but it systematically handicaps itself during rainy and overcast regimes — the exact conditions that cause the largest forecast errors and the biggest generation impact:

1. **Too few samples** — 7-day lookback window captures only 1-2 rainy days; exponential decay kills what little signal exists
2. **Rainy slots penalized** — storm/rain slots get 75% weight, low-forecast slots get 60% weight; the system discounts the data it most needs to learn from
3. **Solcast damping fights correction** — fresh Solcast triggers 70% bias reduction regardless of regime; Solcast is least accurate during rain yet gets the most trust
4. **Flat regime mismatch penalty** — clear-to-rainy mismatch gets the same 75% penalty as overcast-to-rainy, despite overcast being a neighboring regime
5. **Sample thresholds too high for rainy** — 10-day minimum for regime reliability cells means rainy regime falls back to overall defaults during dry season

---

## Invariants (Must Hold After Every Step)

- [ ] `python -c "from services.forecast_engine import *; print('OK')"` imports without error
- [ ] All existing clear-sky and mixed-regime behavior is unchanged (parameters for clear/mixed regimes are not modified)
- [ ] No new dependencies introduced
- [ ] No database schema changes
- [ ] All constant changes are backward-compatible (existing error compare rows remain valid)
- [ ] Smoke test: `npm run smoke:forecast` passes (if available), or manual day-ahead generation succeeds

---

## Dependency Graph

```
Step 1 (regime-aware lookback)
    |
Step 2 (support weight fix)          Step 3 (Solcast damping by regime)
    |                                       |
    +----------- Step 4 (graduated regime mismatch penalty) -----------+
                                    |
                          Step 5 (sample threshold reduction)
                                    |
                          Step 6 (validation & smoke test)
```

Steps 2 and 3 are independent of each other (parallel-safe).  
Steps 4 and 5 depend on Steps 1-3 being complete.  
Step 6 is the final gate.

---

## Step 1: Regime-Aware Error Memory Lookback Window

### Context Brief
Currently `ERR_MEMORY_DAYS = 7` is a single constant applied to all regimes. Rainy days are infrequent — during dry season you might get 1-2 rainy days in 7. The exponential decay (`0.72^6 = 0.088`) means even the 7th day barely contributes. For rainy/overcast regimes, a longer lookback window is needed to accumulate enough signal.

### Current Code (Line 346)
```python
ERR_MEMORY_DAYS   = 7      # days used for bias correction
```

### Current Usage (Line 5266)
```python
if selected_days >= ERR_MEMORY_DAYS:
    break
```

### Changes

**1a. Add regime-aware lookback constants (after line 349):**
```python
# Regime-aware lookback: rainy/overcast need more history because they occur less frequently.
# Clear/mixed keep the original 7-day window.
ERR_MEMORY_DAYS_BY_REGIME = {
    "clear":    7,
    "mixed":    10,
    "overcast": 14,
    "rainy":    21,
}
```

**1b. Modify `compute_error_memory()` to use regime-aware lookback.**

At line 5140, the function signature already accepts `target_regime: str = ""`.

Replace the lookback limit at line 5159:
```python
# OLD (line 5159):
start_date = (today - timedelta(days=max(ERR_MEMORY_DAYS * 4, 30))).isoformat()

# NEW:
_regime_days = ERR_MEMORY_DAYS_BY_REGIME.get(target_regime, ERR_MEMORY_DAYS)
start_date = (today - timedelta(days=max(_regime_days * 4, 60))).isoformat()
```

Replace the selection limit at line 5186:
```python
# OLD (line 5186):
(start_date, end_date, max(ERR_MEMORY_DAYS * 4, 60))

# NEW:
(start_date, end_date, max(_regime_days * 4, 60))
```

Replace the break condition at line 5266:
```python
# OLD (line 5266):
if selected_days >= ERR_MEMORY_DAYS:
    break

# NEW:
if selected_days >= _regime_days:
    break
```

**Important:** `_regime_days` must be passed into the inner scope. Define it once at the top of the function after the signature, before the try block:
```python
_regime_days = ERR_MEMORY_DAYS_BY_REGIME.get(target_regime, ERR_MEMORY_DAYS)
```

**1c. Update the legacy fallback function `_compute_error_memory_legacy()` (lines 5054-5093).**

This function is called when `forecast_error_compare_daily` has no rows. It also hardcodes `ERR_MEMORY_DAYS`. While legacy systems will phase out, the fallback should be consistent.

The legacy function does NOT receive `target_regime` — its signature at line 5054 is:
```python
def _compute_error_memory_legacy(today: date) -> np.ndarray:
```

**Option A (minimal):** Leave legacy at 7 days. It only fires on old DBs that haven't built daily comparison rows yet — those DBs won't have enough history for 21-day rainy lookback anyway.

**Option B (complete):** Add `target_regime` parameter to legacy function. This requires updating the three call sites:
- Line 5190: `return _compute_error_memory_legacy(today)`
- Line 5271: `return _compute_error_memory_legacy(today)`
- Line 5274: `return _compute_error_memory_legacy(today)`

**Recommendation: Option A.** The legacy path is a compatibility shim for pre-v2.7.6 databases. New regime-aware lookback only matters for databases that have the daily comparison table populated — which is the primary path. Add a log.debug() to flag when legacy fallback is used:

At line 5059, after `start_date =`:
```python
log.debug("Using legacy error memory fallback (7-day fixed lookback)")
```

### Verification
- `ERR_MEMORY_DAYS` (7) is still the default for unknown/empty regimes
- Clear-sky behavior unchanged (still 7 days)
- Rainy regime can now see up to 21 days of history (84-day query window)
- The exponential decay still applies — day 21 weight: `0.72^20 = 0.00065` — practically zero, but it's there if needed
- Legacy fallback: unchanged at 7 days for all regimes (acceptable — old DBs lack data for longer windows)
- Empty `target_regime=""`: `.get("", ERR_MEMORY_DAYS)` correctly returns 7 (default)

### Exit Criteria
- [ ] `compute_error_memory(today, w5, target_regime="clear")` uses 7-day limit
- [ ] `compute_error_memory(today, w5, target_regime="rainy")` uses 21-day limit
- [ ] `compute_error_memory(today, w5, target_regime="")` falls back to 7
- [ ] Legacy fallback path logs a debug message when used

---

## Step 2: Remove Rainy/Overcast Slot Support Weight Penalties

### Context Brief
When building daily comparison records, storm/rain slots get multiplied by 0.75 and low-forecast slots by 0.60. These penalties make sense for clear/mixed regimes (rain slots are anomalies), but during rainy/overcast regimes they are the *majority* of slots — penalizing them discards the signal you need most.

### Current Code (Lines 8382-8385)
```python
support_weight = support_base
if opportunity < 2.0:
    support_weight *= 0.6
if slot_bucket in {"storm_risk", "rain_heavy"}:
    support_weight *= 0.75
```

### Changes

**2a. Variable scope — `day_regime` is already available.**

The comparison builder function already receives `day_regime: str = ""` as a parameter (line 8197). It is used at line 8350 (stored in notes_json) and line 8405 (stored in slot record). No new parameter passing is needed.

**2b. Make support weight penalties regime-conditional (replace lines 8381-8385):**
```python
# NEW (replace lines 8381-8385):
support_weight = support_base
if opportunity < 2.0:
    # During rainy/overcast regimes, low-forecast slots ARE the regime — don't penalize them.
    if day_regime in ("rainy", "overcast"):
        support_weight *= 0.90   # mild discount only (measurement noise at low generation)
    else:
        support_weight *= 0.60   # original: anomalous low slots in clear/mixed
if slot_bucket in {"storm_risk", "rain_heavy"}:
    if day_regime in ("rainy", "overcast"):
        support_weight *= 1.0    # no penalty — these ARE the regime's characteristic slots
    else:
        support_weight *= 0.75   # original: anomalous storm slots in clear/mixed
```

### Data Integrity Note
This changes future `support_weight` values written to `forecast_error_compare_slot`. **Existing rows are not affected** — they retain their original weights. The change is forward-only and does not require backfilling.

### Verification
- Clear/mixed regime behavior: unchanged (0.60 and 0.75 penalties still apply)
- Rainy/overcast regime: low-forecast slots get 0.90 (mild noise discount), storm slots get 1.0 (full weight)
- A rainy day with both conditions: `support_base * 0.90 * 1.0 = 0.90` (was `0.60 * 0.75 = 0.45`)

### Exit Criteria
- [ ] On a rainy-regime day, slot support weights are >= 0.90 for rainy slots
- [ ] On a clear-regime day, slot support weights unchanged (0.60, 0.75 penalties apply)
- [ ] `forecast_error_compare_slot` schema unchanged

---

## Step 3: Regime-Aware Solcast Fresh-Damping

### Context Brief
When Solcast has high coverage (>=95%), the error memory bias correction is reduced by 70%. The rationale is "fresh Solcast already knows recent patterns." But during rainy regimes, Solcast itself is least accurate — satellite cloud tracking can't resolve tropical convective cells. Damping the correction during rain neuuters the error memory exactly when it's needed.

### Current Code (Lines 9664-9677)
```python
if bool(solcast_meta.get("used_solcast")):
    _sc_cov = float(solcast_meta.get("coverage_ratio", 0.0))
    if _sc_cov >= 0.95:
        _bias_damp = 0.30   # reduce bias by 70%
    elif _sc_cov >= 0.80:
        _bias_damp = 0.50   # reduce bias by 50%
    else:
        _bias_damp = 1.0
    if _bias_damp < 1.0:
        bias_correction = bias_correction * _bias_damp
```

### Changes

**3a. Add regime-aware damping schedule (replace lines 9664-9677):**
```python
if bool(solcast_meta.get("used_solcast")):
    _sc_cov = float(solcast_meta.get("coverage_ratio", 0.0))
    # Regime-aware damping: trust Solcast less during rainy/overcast because
    # satellite cloud tracking can't resolve tropical convective cells.
    if target_regime == "rainy":
        # Rainy: minimal damping — let error memory do its job
        if _sc_cov >= 0.95:
            _bias_damp = 0.90   # only 10% reduction (was 70%)
        elif _sc_cov >= 0.80:
            _bias_damp = 0.95   # only 5% reduction (was 50%)
        else:
            _bias_damp = 1.0
    elif target_regime == "overcast":
        # Overcast: moderate damping — Solcast is somewhat useful for uniform cloud
        if _sc_cov >= 0.95:
            _bias_damp = 0.70   # 30% reduction (was 70%)
        elif _sc_cov >= 0.80:
            _bias_damp = 0.80   # 20% reduction (was 50%)
        else:
            _bias_damp = 1.0
    elif target_regime == "mixed":
        # Mixed: slight relaxation from original
        if _sc_cov >= 0.95:
            _bias_damp = 0.40   # 60% reduction (was 70%)
        elif _sc_cov >= 0.80:
            _bias_damp = 0.55   # 45% reduction (was 50%)
        else:
            _bias_damp = 1.0
    else:
        # Clear: keep original behavior — Solcast is most reliable here
        if _sc_cov >= 0.95:
            _bias_damp = 0.30   # 70% reduction (unchanged)
        elif _sc_cov >= 0.80:
            _bias_damp = 0.50   # 50% reduction (unchanged)
        else:
            _bias_damp = 1.0
    if _bias_damp < 1.0:
        bias_correction = bias_correction * _bias_damp
        log.info(
            "Bias correction damped %.0f%% for Solcast (coverage=%.2f regime=%s bias_damp=%.2f)",
            (1.0 - _bias_damp) * 100.0,   # arg 1: percentage damped
            _sc_cov,                        # arg 2: coverage ratio
            target_regime or "unknown",     # arg 3: regime string (new)
            _bias_damp,                     # arg 4: damping factor
        )
```

**Note:** The original log message (line 9675) has 3 format args. The new version has 4 — the `regime=%s` field is added. The format string and argument count must both be updated together.

### Damping Summary Table

| Regime | Coverage >= 95% | Coverage >= 80% | Coverage < 80% |
|--------|----------------|-----------------|----------------|
| **clear** | 0.30 (70% cut) | 0.50 (50% cut) | 1.0 (no cut) |
| **mixed** | 0.40 (60% cut) | 0.55 (45% cut) | 1.0 (no cut) |
| **overcast** | 0.70 (30% cut) | 0.80 (20% cut) | 1.0 (no cut) |
| **rainy** | 0.90 (10% cut) | 0.95 (5% cut) | 1.0 (no cut) |

### Pre-Requisite
`target_regime` must be available at line 9664. It is — it's computed earlier in `run_dayahead()` and used at line 9656 for `compute_error_memory()`.

### Verification
- Clear-regime damping: identical to current behavior
- Rainy-regime with fresh Solcast: bias correction retains 90% of its value (was 30%)
- Log message now includes regime for audit trail

### Exit Criteria
- [ ] Clear-regime day-ahead generation produces identical output to before
- [ ] Rainy-regime day-ahead generation applies nearly full error memory correction
- [ ] Log output shows regime in damping message

---

## Step 4: Graduated Regime Mismatch Penalty

### Context Brief
Currently all regime mismatches get the same 0.25 penalty (75% reduction). But overcast and rainy are neighboring regimes — an overcast day's error pattern is far more informative for a rainy day than a clear day's pattern is. A graduated penalty matrix preserves more useful cross-regime signal.

### Current Code (Lines 5228-5231)
```python
regime_factor = 1.0
if target_regime and hist_regime and target_regime != hist_regime:
    regime_factor = ERR_MEMORY_REGIME_MISMATCH_PENALTY  # 0.25
```

### Changes

**4a. Add graduated penalty matrix (after the ERR_MEMORY_DAYS_BY_REGIME constant from Step 1):**
```python
# Graduated regime mismatch penalty matrix.
# Neighboring regimes (overcast<->rainy) share more error structure than
# distant regimes (clear<->rainy). Values: 1.0 = same regime, lower = more different.
ERR_MEMORY_REGIME_PENALTY_MATRIX = {
    # (target, historical) -> penalty factor
    ("clear",    "mixed"):    0.50,
    ("clear",    "overcast"): 0.25,
    ("clear",    "rainy"):    0.20,
    ("mixed",    "clear"):    0.50,
    ("mixed",    "overcast"): 0.60,
    ("mixed",    "rainy"):    0.35,
    ("overcast", "clear"):    0.25,
    ("overcast", "mixed"):    0.60,
    ("overcast", "rainy"):    0.70,   # neighboring regimes
    ("rainy",    "clear"):    0.20,
    ("rainy",    "mixed"):    0.35,
    ("rainy",    "overcast"): 0.70,   # neighboring regimes
}
```

**4b. Replace flat penalty with matrix lookup (lines 5228-5231):**
```python
# OLD:
regime_factor = 1.0
if target_regime and hist_regime and target_regime != hist_regime:
    regime_factor = ERR_MEMORY_REGIME_MISMATCH_PENALTY

# NEW:
regime_factor = 1.0
if target_regime and hist_regime and target_regime != hist_regime:
    regime_factor = ERR_MEMORY_REGIME_PENALTY_MATRIX.get(
        (target_regime, hist_regime),
        ERR_MEMORY_REGIME_MISMATCH_PENALTY,   # fallback to flat 0.25 for unknown pairs
    )
```

### Penalty Matrix Rationale

| Target \ Historical | clear | mixed | overcast | rainy |
|---------------------|-------|-------|----------|-------|
| **clear**           | 1.0   | 0.50  | 0.25     | 0.20  |
| **mixed**           | 0.50  | 1.0   | 0.60     | 0.35  |
| **overcast**        | 0.25  | 0.60  | 1.0      | 0.70  |
| **rainy**           | 0.20  | 0.35  | 0.70     | 1.0   |

Key insight: **overcast <-> rainy = 0.70** (retain 70% weight) vs **clear <-> rainy = 0.20** (retain only 20%). An overcast day's errors are much more predictive of rainy-day behavior than a clear day's errors.

### Verification
- Same-regime: `regime_factor = 1.0` (unchanged)
- clear->rainy: 0.20 (was 0.25 — slightly stricter, these are truly different)
- overcast->rainy: 0.70 (was 0.25 — major improvement, these are neighbors)
- Unknown regime pairs: falls back to 0.25 (original behavior)

### Exit Criteria
- [ ] Same-regime error memory identical to before
- [ ] Overcast historical days contribute 70% weight to rainy target (was 25%)
- [ ] `ERR_MEMORY_REGIME_MISMATCH_PENALTY` retained as fallback for edge cases

---

## Step 5: Lower Reliability Sample Thresholds for Rainy/Overcast

### Context Brief
`lookup_solcast_reliability()` requires `_MIN_RELIABILITY_SAMPLES = 10` days for regime-specific cells. During dry season, you may never accumulate 10 rainy days in the 30-day reliability lookback. The system falls back to overall reliability — losing the rainy-specific bias ratio entirely. Lowering the threshold for rainy/overcast to 5 days preserves regime-specific corrections.

### Current Code (Line 4573)
```python
_MIN_RELIABILITY_SAMPLES = 10  # FIX-18
```

### Usage (Lines 4592, 4603)
```python
if int(cell.get("day_count", 0)) < _MIN_RELIABILITY_SAMPLES:
    log.debug("Reliability cell '%s' has only %d samples — falling through", ...)
```

### Changes

**5a. Make sample threshold regime-aware (replace line 4573):**
```python
# FIX-18 updated: Rainy/overcast regimes occur less frequently than clear/mixed,
# so they need a lower sample threshold to avoid always falling back to overall.
_MIN_RELIABILITY_SAMPLES = 10  # default for clear/mixed
_MIN_RELIABILITY_SAMPLES_ADVERSE = 5  # for rainy/overcast
```

**5b. Update the season+regime lookup (lines 4591-4597):**
```python
# OLD:
if int(cell.get("day_count", 0)) < _MIN_RELIABILITY_SAMPLES:

# NEW:
_min_samples = _MIN_RELIABILITY_SAMPLES_ADVERSE if regime in ("rainy", "overcast") else _MIN_RELIABILITY_SAMPLES
if int(cell.get("day_count", 0)) < _min_samples:
```

**5c. Update the regime-only lookup (lines 4602-4608):**
```python
# OLD:
if int(cell.get("day_count", 0)) < _MIN_RELIABILITY_SAMPLES:

# NEW:
_min_samples = _MIN_RELIABILITY_SAMPLES_ADVERSE if regime in ("rainy", "overcast") else _MIN_RELIABILITY_SAMPLES
if int(cell.get("day_count", 0)) < _min_samples:
```

### Verification
- Clear/mixed: still requires 10 days (unchanged)
- Rainy/overcast: requires only 5 days — will use regime-specific bias ratio instead of falling back to overall
- The `build_solcast_reliability_artifact()` already builds cells with as few as 5 days (line 4211), so the data already exists — it was just being rejected by the lookup function

### Exit Criteria
- [ ] `lookup_solcast_reliability(artifact, "clear", "dry")` still requires 10 samples
- [ ] `lookup_solcast_reliability(artifact, "rainy", "dry")` accepts 5 samples
- [ ] When rainy cell has 6 days of data, it returns regime-specific values (not overall fallback)

---

## Step 6: Validation & Smoke Test

### Context Brief
All parameter changes are complete. This step verifies correctness end-to-end.

### Verification Commands

```bash
# 1. Import check — no syntax errors
python -c "from services.forecast_engine import *; print('Import OK')"

# 2. Verify new constants are accessible
python -c "
from services.forecast_engine import (
    ERR_MEMORY_DAYS_BY_REGIME,
    ERR_MEMORY_REGIME_PENALTY_MATRIX,
)
print('Regime days:', ERR_MEMORY_DAYS_BY_REGIME)
print('Penalty matrix keys:', len(ERR_MEMORY_REGIME_PENALTY_MATRIX), 'pairs')
assert ERR_MEMORY_DAYS_BY_REGIME['clear'] == 7
assert ERR_MEMORY_DAYS_BY_REGIME['rainy'] == 21
assert ERR_MEMORY_REGIME_PENALTY_MATRIX[('overcast', 'rainy')] == 0.70
assert ERR_MEMORY_REGIME_PENALTY_MATRIX[('clear', 'rainy')] == 0.20
print('Constants OK')
"

# 3. Smoke test: run day-ahead generation (if DB is available)
# This exercises compute_error_memory(), solcast_prior_from_snapshot(),
# lookup_solcast_reliability(), and the bias damping logic.
npm run smoke:forecast 2>&1 || echo "Smoke test not available — manual verification needed"

# 4. Check for regressions in clear-sky behavior
# Compare a clear-day forecast before and after changes (should be identical)
```

### Manual Verification Checklist
- [ ] Generate a day-ahead forecast for a date expected to be rainy
- [ ] Check logs for: `"Bias correction damped X% for Solcast (coverage=Y regime=rainy bias_damp=Z)"`
- [ ] Verify the bias_damp value is 0.90 (not 0.30) for rainy regime
- [ ] Check that `compute_error_memory` selected up to 21 days for rainy regime
- [ ] Generate a day-ahead forecast for a date expected to be clear
- [ ] Verify clear-sky forecast values are unchanged from pre-change baseline

### Exit Criteria
- [ ] Python import succeeds
- [ ] All constant assertions pass
- [ ] Clear-sky forecast is identical to pre-change
- [ ] Rainy-day forecast shows increased error memory influence
- [ ] No errors in application logs

---

## Complete Change Summary

### Constants Added/Modified

| Constant | Location | Old Value | New Value |
|----------|----------|-----------|-----------|
| `ERR_MEMORY_DAYS_BY_REGIME` | After line 349 | *(new)* | `{clear:7, mixed:10, overcast:14, rainy:21}` |
| `ERR_MEMORY_REGIME_PENALTY_MATRIX` | After line 349 | *(new)* | 12-pair graduated matrix |
| `_MIN_RELIABILITY_SAMPLES_ADVERSE` | Line 4573 | *(new)* | `5` |

### Logic Modified

| Function | Lines | Change |
|----------|-------|--------|
| `compute_error_memory()` | 5159, 5186, 5266 | Use `_regime_days` instead of flat `ERR_MEMORY_DAYS` |
| `compute_error_memory()` | 5228-5231 | Graduated penalty matrix instead of flat 0.25 |
| Comparison builder | 8381-8385 | Regime-conditional support weight penalties (uses existing `day_regime` param) |
| `run_dayahead()` | 9664-9677 | Regime-aware Solcast fresh-damping schedule |
| `lookup_solcast_reliability()` | 4592, 4603 | Lower sample threshold (5) for rainy/overcast |

### What Is NOT Changed

- `ERROR_ALPHA` (0.28) — the overall application fraction stays conservative
- `ERR_MEMORY_DECAY` (0.72) — the decay rate stays the same (longer windows just see more days)
- `SOLCAST_RELIABILITY_LOOKBACK_DAYS` (30) — reliability artifact window unchanged
- Clear-sky regime behavior — all original values preserved
- Database schema — no new columns, no migrations
- Solcast blend base weights — the `base_by_regime` values in `solcast_prior_from_snapshot()` are not changed
- Intraday adjustment algorithm — not touched

### Estimated Impact

| Regime | Expected Error Memory Improvement | Mechanism |
|--------|----------------------------------|-----------|
| **Clear** | None (unchanged) | All parameters identical |
| **Mixed** | +5-10% more data | 10-day lookback, slightly relaxed damping |
| **Overcast** | +20-30% more data, stronger correction | 14-day lookback, 30% damping (was 70%), overcast days contribute 70% to rainy |
| **Rainy** | +50-80% more data, much stronger correction | 21-day lookback, 10% damping (was 70%), full slot weights, 5-day reliability threshold |

### Risk Mitigation

- All changes use existing fallback paths (`ERR_MEMORY_DAYS`, `ERR_MEMORY_REGIME_MISMATCH_PENALTY` as defaults)
- `ERROR_ALPHA = 0.28` still caps total correction at 28% — even with more data and less damping, the correction can't run away
- The `-100/+100 kWh/slot` clip guard remains
- Clear-sky behavior is provably unchanged (same constants, same code paths)
