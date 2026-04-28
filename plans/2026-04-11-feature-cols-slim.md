# FEATURE_COLS Slim-Down Patch (v2.8)

**Date:** 2026-04-11
**Status:** PENDING — apply only with the next `train_dayahead` cycle.
**Author:** v2.8 cleanup pass
**Created against:** `services/forecast_engine.py` post Tier 1 + Tier 2 cleanup (line counts as of 11036 LOC)
**Target:** Reduce `FEATURE_COLS` from **72 → 58** (drop 14 features) and retrain LightGBM in the same commit.

---

## Why this is a separate document, not an applied edit

The trained LightGBM bundle at `services/models/model_lgb.txt` (or wherever `MODEL_FILE` resolves) was fit on exactly the current 72 columns. Removing features from `FEATURE_COLS` and `build_features` without retraining would:

1. Make `_align_bundle_features` fall through the zero-fill branch (lines ~7332-7348) for the 14 missing columns,
2. Silently degrade WAPE until the next training run,
3. Pollute the alignment debug log with 14 missing-column warnings every prediction.

The patch is therefore **inert until applied**. When applied, it MUST land in the same commit as a fresh training cycle so the new bundle's `feature_names` already lists 58 columns and the alignment path stays clean.

---

## Stale-check before applying

If `forecast_engine.py` has changed materially since this document was written, the line anchors below may have shifted. Run this **first** — if it returns anything other than the expected counts, re-derive the diffs by hand:

```bash
# Should print 72 (current FEATURE_COLS length)
python -c "import sys; sys.path.insert(0,'services'); import forecast_engine; print(len(forecast_engine.FEATURE_COLS))"

# Should print: FEATURE_COLS = [
grep -n "^FEATURE_COLS\s*=" services/forecast_engine.py

# Should match the 14 names below — if any are missing, the file has drifted
grep -nE '"(solcast_prior_blend|solcast_prior_mw|expected_nodes|cap_kw|day_regime_clear|day_regime_mixed|day_regime_overcast|day_regime_rainy|temp_hot|rh_sq|wind_sq|cape_sqrt|solar_prog_sq|solar_prog_sin)"' services/forecast_engine.py
```

If any check fails, **stop** and re-derive — do not blindly apply.

---

## The 14 features being dropped, by category

### Tier A — Constants and duplicates (4)

| Feature | Why dropped |
|---|---|
| `solcast_prior_blend` | Hard-coded to constant 1.0 since Phase 4 (Solcast is 100% baseline). Tree splits on a constant feature contribute zero predictive value. Genuinely dead. |
| `solcast_prior_mw` | Same data as `solcast_prior_kwh` in different units. LightGBM is invariant to scale — keeping both adds no signal. |
| `expected_nodes` | Computed as `clip((cap_kw × kt) / NODE_KW_NOMINAL, 0, node_count)`. Single-plant constant times kt — the model already has `kt` directly. The `cap_kw / node_count` factor is fixed for this site. |
| `cap_kw` | Broadcast to all 288 slots as a single plant constant. Zero within-day variance, zero predictive contribution. Used internally by `slot_cap_arr` — that internal use stays. |

### Tier B — Regime anti-pattern (4)

| Feature | Why dropped |
|---|---|
| `day_regime_clear` | The LightGBM bundle uses **per-regime models** (`predict_residual_with_bundle` routes by `target_regime`). Inside the "clear" model, `day_regime_clear=1` for every training sample — it's a constant. Same logic for the other three. |
| `day_regime_mixed` | Same — constant within the per-regime model. |
| `day_regime_overcast` | Same. |
| `day_regime_rainy` | Same. |

This is not opinion — it's a mathematical fact about per-regime routing. The features only had value in the legacy single-model path, which Phase 4 retired.

### Tier C — Hand-engineered transforms LightGBM doesn't need (4)

| Feature | Build expression | Why dropped |
|---|---|---|
| `temp_hot` | `np.clip(temp - 35.0, 0, None)` | Tree models split on `temp >= 35` natively. The clip operation is a relic of linear models. |
| `rh_sq` | `(rh / 100.0) ** 2` | Same — trees handle nonlinearity via splits, not pre-squared inputs. |
| `wind_sq` | `wind ** 2` | Same. |
| `cape_sqrt` | `np.sqrt(cape)` | Same. The sqrt was added because CAPE has a long right tail; trees handle long tails by splitting. |

### Tier D — Redundant time encodings (2)

| Feature | Build expression | Why dropped |
|---|---|---|
| `solar_prog_sq` | `solar_rel ** 2` | Squared transform of `solar_prog` — trees can split on `solar_prog` for any monotone transform. |
| `solar_prog_sin` | `solar_rel_sin = np.sin(np.pi * solar_rel)` | Half-cycle sinusoid on solar window. The model already has `solar_prog`, `tod_sin`, `tod_cos`, `sunrise_rel`, `sunset_rel` covering time-of-day. This is one encoding too many. |

### Features explicitly KEPT (do not touch)

To remove confusion about what's NOT in this patch:

- `temp_delta` — kept (TEMP_REF_C-shifted; small but meaningful semantic anchor; conservative)
- `slot_in_hour_sin/cos` — kept (sub-hour granularity; could matter for ramp slots)
- `shoulder_flag` — kept (binary edge marker; cheap signal)
- `solcast_lo_vs_physics`, `solcast_hi_vs_physics` — kept (physics-normalized ratios, distinct from `_spread_pct`)
- `solcast_spread_ratio` — kept (alt encoding of spread; conservative)
- `solcast_resolution_support` — kept (pair with `_weight`, conservative)
- `spread_pct_cap_locked`, `hours_since_lock` — kept (just shipped in v2.8, need data first)

---

## Apply checklist

Run this checklist on the day you trigger the next `train_dayahead`:

1. **Stale-check** — run the 3 commands in the "Stale-check before applying" section above. All must pass.

2. **Apply Diff 1** (FEATURE_COLS list).

3. **Apply Diff 2** (build_features intermediate variables — orphaned computations).

4. **Apply Diff 3** (build_features DataFrame dict).

5. **Syntax check:**
   ```bash
   python -c "import ast; ast.parse(open('services/forecast_engine.py', encoding='utf-8').read()); print('OK')"
   ```

6. **Feature count assertion** (build_features asserts `len(df.columns) == len(FEATURE_COLS)`):
   ```bash
   python -c "import sys; sys.path.insert(0,'services'); import forecast_engine; print('FEATURE_COLS:', len(forecast_engine.FEATURE_COLS))"
   # Expected: FEATURE_COLS: 58
   ```

7. **Trigger retraining:**
   ```bash
   # Via the CLI entry point (matches the cron path)
   python services/forecast_engine.py --train --today $(date +%Y-%m-%d)
   ```
   Watch the log for:
   - `feature_count=58` in the training summary
   - No `Feature alignment: N features missing` messages
   - WAPE/MAPE values in the same range as the previous run (regime-dependent — typically 12–18% WAPE)

8. **Verify the new bundle:**
   ```bash
   python -c "
   import sys, joblib
   sys.path.insert(0,'services')
   import forecast_engine as fe
   bundle = fe.load_model_bundle()
   if bundle:
       cols = bundle.get('feature_cols') or []
       print('bundle feature_cols:', len(cols))
       print('first 5:', cols[:5])
       print('last 5:', cols[-5:])
   "
   # Expected: bundle feature_cols: 58
   ```

9. **Run a dry forecast** for tomorrow:
   ```bash
   python services/forecast_engine.py --generate-date $(date -d '+1 day' +%Y-%m-%d) --dry-run
   ```
   Should complete without zero-fill warnings.

10. **Smoke the model + DB pipeline** end-to-end (use whatever your team's smoke command is — e.g., `npm run smoke`).

11. **Commit** all three changes (code patch + new model file + updated `ml_train_state.json`) in a single commit titled something like:
    ```
    forecast: slim FEATURE_COLS 72 -> 58 (drop 14 redundant features)
    ```

---

## Diff 1 — FEATURE_COLS list

**File:** `services/forecast_engine.py`
**Anchor:** `^FEATURE_COLS = \[` (currently around line 2540)

**BEFORE:**
```python
FEATURE_COLS = [
    "rad", "rad_direct", "rad_diffuse", "rad_lag_1h", "rad_lag_1slot", "rad_lag_2slots", "rad_grad_15m",
    "cloud", "cloud_low", "cloud_mid", "cloud_high", "cloud_std_1h", "cloud_grad_15m", "cloud_trans",
    "csi", "kt", "dni_proxy",
    "precip", "precip_1h", "cape", "cape_sqrt",
    "temp", "temp_hot", "temp_delta", "rh", "rh_sq", "wind", "wind_sq",
    "cos_z", "air_mass",
    "solar_prog", "solar_prog_sq", "solar_prog_sin", "tod_sin", "tod_cos",
    "slot_in_hour_sin", "slot_in_hour_cos", "sunrise_rel", "sunset_rel", "shoulder_flag",
    "doy_sin", "doy_cos",
    "day_cloud_mean", "day_vol_index", "wet_season_flag", "dry_season_flag",
    "day_regime_clear", "day_regime_mixed", "day_regime_overcast", "day_regime_rainy",
    "solcast_prior_kwh", "solcast_prior_mw", "solcast_prior_spread", "solcast_prior_available",
    "solcast_prior_blend", "solcast_prior_vs_physics", "solcast_prior_vs_irradiance",
    "solcast_day_coverage", "solcast_day_reliability", "solcast_bias_ratio",
    "solcast_resolution_weight", "solcast_resolution_support",
    # Solcast tri-band (NEW)
    "solcast_lo_kwh", "solcast_hi_kwh",
    "solcast_lo_vs_physics", "solcast_hi_vs_physics",
    "solcast_spread_pct", "solcast_spread_ratio",
    # Locked snapshot (NEW v2.8)
    "spread_pct_cap_locked", "hours_since_lock",
    # Plant
    "expected_nodes", "cap_kw",
]
```

**AFTER:**
```python
FEATURE_COLS = [
    "rad", "rad_direct", "rad_diffuse", "rad_lag_1h", "rad_lag_1slot", "rad_lag_2slots", "rad_grad_15m",
    "cloud", "cloud_low", "cloud_mid", "cloud_high", "cloud_std_1h", "cloud_grad_15m", "cloud_trans",
    "csi", "kt", "dni_proxy",
    "precip", "precip_1h", "cape",
    "temp", "temp_delta", "rh", "wind",
    "cos_z", "air_mass",
    "solar_prog", "tod_sin", "tod_cos",
    "slot_in_hour_sin", "slot_in_hour_cos", "sunrise_rel", "sunset_rel", "shoulder_flag",
    "doy_sin", "doy_cos",
    "day_cloud_mean", "day_vol_index", "wet_season_flag", "dry_season_flag",
    # day_regime_* features removed in v2.8 slim-down — see plans/2026-04-11-feature-cols-slim.md
    # (per-regime models already condition on regime by routing, making these constant-within-model)
    "solcast_prior_kwh", "solcast_prior_spread", "solcast_prior_available",
    "solcast_prior_vs_physics", "solcast_prior_vs_irradiance",
    "solcast_day_coverage", "solcast_day_reliability", "solcast_bias_ratio",
    "solcast_resolution_weight", "solcast_resolution_support",
    # Solcast tri-band (NEW)
    "solcast_lo_kwh", "solcast_hi_kwh",
    "solcast_lo_vs_physics", "solcast_hi_vs_physics",
    "solcast_spread_pct", "solcast_spread_ratio",
    # Locked snapshot (NEW v2.8)
    "spread_pct_cap_locked", "hours_since_lock",
]
```

**Verify:** the list above has exactly **58 names** (count by hand or use `python -c "exec(open('...').read()); print(len(FEATURE_COLS))"`).

---

## Diff 2 — build_features intermediate variables

**File:** `services/forecast_engine.py`
**Anchor:** `def build_features(` then locate the local variable assignments around lines 2316–2333.

The following intermediate variables become **fully orphaned** after Diff 3 below removes their dict entries. They can be deleted to save a few microseconds and reduce confusion:

**REMOVE these lines** (currently 2316, 2320–2323):
```python
expected_nodes = np.clip((cap_kw * np.clip(kt, 0.0, 1.0)) / max(NODE_KW_NOMINAL, 1.0), 0.0, float(node_count))
```
```python
day_regime_clear = 1.0 if day_regime == "clear" else 0.0
day_regime_mixed = 1.0 if day_regime == "mixed" else 0.0
day_regime_overcast = 1.0 if day_regime == "overcast" else 0.0
day_regime_rainy = 1.0 if day_regime == "rainy" else 0.0
```

Inside the `if solcast_prior:` branch (currently around line 2326, 2333), **REMOVE**:
```python
solcast_mw = np.clip(np.asarray(solcast_prior.get("prior_mw"), dtype=float), 0.0, None)[:SLOTS_DAY]
```
```python
solcast_blend = np.clip(np.asarray(solcast_prior.get("blend"), dtype=float), 0.0, 1.0)[:SLOTS_DAY]
```

Inside the corresponding `else:` branch (currently around line 2358, 2361), **REMOVE**:
```python
solcast_mw = np.zeros(SLOTS_DAY, dtype=float)
```
```python
solcast_blend = np.zeros(SLOTS_DAY, dtype=float)
```

The `solar_rel_sin` line (currently around line 2268–2269) becomes orphaned too:
```python
solar_rel_sin = np.sin(np.pi * solar_rel)
solar_rel_sin = np.clip(solar_rel_sin, 0, 1)
```
**REMOVE both lines.**

The `node_count` local (currently line 2315) is only used by `expected_nodes`:
```python
node_count = max(1, plant_node_count())
```
**REMOVE this line** (verify it has no other consumers — `grep -n "\bnode_count\b" services/forecast_engine.py` should show only build_features after the patch).

**KEEP these intermediates** (still used elsewhere in build_features even though their direct feature is dropped):
- `cap_kw` (line 2309) — still used by `slot_cap_arr` at line 2389
- `solar_rel` — still used by `solar_prog` and other calcs
- `kt` — still used as its own feature

---

## Diff 3 — build_features DataFrame dict

**File:** `services/forecast_engine.py`
**Anchor:** `df = pd.DataFrame({` (currently around line 2440)

**REMOVE these dict entries** (14 lines):

```python
"temp_hot":      np.clip(temp - 35.0, 0, None),   # severe heat
```
```python
"rh_sq":         (rh / 100.0) ** 2,
```
```python
"wind_sq":       wind ** 2,
```
```python
"cape_sqrt":     np.sqrt(cape),
```
```python
"solar_prog_sq": solar_rel ** 2,
```
```python
"solar_prog_sin": solar_rel_sin,
```
```python
"day_regime_clear": np.full(SLOTS_DAY, day_regime_clear),
"day_regime_mixed": np.full(SLOTS_DAY, day_regime_mixed),
"day_regime_overcast": np.full(SLOTS_DAY, day_regime_overcast),
"day_regime_rainy": np.full(SLOTS_DAY, day_regime_rainy),
```
```python
"solcast_prior_mw": solcast_mw,
```
```python
"solcast_prior_blend": solcast_blend,
```
```python
"expected_nodes": expected_nodes,
"cap_kw":        np.full(SLOTS_DAY, cap_kw),
```

**Total dict entries removed:** 14.

The assertion at the bottom of `build_features` will catch any mismatch:
```python
assert len(df.columns) == len(FEATURE_COLS), (
    f"build_features returned {len(df.columns)} columns, expected {len(FEATURE_COLS)}"
)
```
After both diffs, both sides should equal 58.

---

## Verification commands (run after applying)

```bash
# 1. Syntax
python -c "import ast; ast.parse(open('services/forecast_engine.py', encoding='utf-8').read()); print('SYNTAX OK')"

# 2. Feature count + assertion
python -c "
import sys; sys.path.insert(0,'services')
import forecast_engine as fe
print('FEATURE_COLS:', len(fe.FEATURE_COLS))
assert len(fe.FEATURE_COLS) == 58, f'expected 58, got {len(fe.FEATURE_COLS)}'

# Verify all dropped names are absent from FEATURE_COLS
dropped = {
    'solcast_prior_blend','solcast_prior_mw','expected_nodes','cap_kw',
    'day_regime_clear','day_regime_mixed','day_regime_overcast','day_regime_rainy',
    'temp_hot','rh_sq','wind_sq','cape_sqrt','solar_prog_sq','solar_prog_sin',
}
intersection = dropped & set(fe.FEATURE_COLS)
assert not intersection, f'still present: {intersection}'
print('All 14 dropped features confirmed absent')
"

# 3. End-to-end build_features smoke (will fire the internal assertion)
IM_DATA_DIR=C:/tmp/adsi_test_layer7 python -c "
import sys; sys.path.insert(0,'services')
import forecast_engine as fe
import pandas as pd, numpy as np

# Use real loaders against the temp DB
day = '2026-04-04'
snapshot = fe.load_solcast_snapshot(day)
w5 = fe.fetch_weather(day, source='auto')
prior = fe.solcast_prior_from_snapshot(day, w5, snapshot)
feat = fe.build_features(w5, day, prior)
print(f'build_features returned {len(feat.columns)} cols (expect 58)')
assert len(feat.columns) == 58
"

# 4. Run training (this is the load-bearing step)
python services/forecast_engine.py --train --today $(date +%Y-%m-%d)

# 5. Verify new bundle has 58 features
python -c "
import sys; sys.path.insert(0,'services')
import forecast_engine as fe
bundle = fe.load_model_bundle()
cols = bundle.get('feature_cols') or []
print(f'bundle feature_cols: {len(cols)}')
assert len(cols) == 58, f'bundle still has {len(cols)} columns — retrain failed?'
"
```

---

## Rollback instructions

If WAPE drifts upward by >3% after one full day of forecasts, **revert in this order**:

1. **Revert the patch commit:**
   ```bash
   git revert <commit-hash>
   ```

2. **Restore the old model bundle.** The previous bundle should be at `services/models/model_lgb.txt.bak` if your training pipeline keeps backups, or fetch from the previous commit:
   ```bash
   git checkout <previous-commit> -- services/models/model_lgb.txt services/models/scaler.joblib services/models/ml_train_state.json
   ```

3. **Verify rollback restored 72 features:**
   ```bash
   python -c "import sys; sys.path.insert(0,'services'); import forecast_engine as fe; print(len(fe.FEATURE_COLS))"
   # Expected: 72
   ```

4. **Run the next forecast cycle** to confirm the old model loads cleanly.

5. **File a note** in `plans/` documenting which feature(s) appeared load-bearing — that informs the next attempt.

---

## What NOT to touch as part of this patch

- Any feature in `FEATURE_COLS` that isn't in the 14-name list above
- The `slot_cap_arr` computation (still uses `cap_kw` internally)
- Per-regime model routing in `predict_residual_with_bundle` (the entire reason `day_regime_*` features can be dropped)
- The `_align_bundle_features` zero-fill fallback (it's a safety net for OTHER schema changes — leave it)
- The `expected_nodes` reference in the OTHER function around line 2673 (different scope, same name — local to a different block)
- Any test fixtures (verified zero references; no test should break)
- Node side, UI, DB schema, model file format

---

## Why these specific 14 and not more

I had a longer list (~18 candidates) that included `temp_delta`, `slot_in_hour_sin/cos`, and `shoulder_flag`. I dropped them from this patch because:

- **`temp_delta`** — `TEMP_REF_C` is a meaningful semantic anchor (the reference temperature for the panel datasheet). Even though trees can learn any threshold, the centered representation may help convergence. Conservative: keep.
- **`slot_in_hour_sin/cos`** — sub-hour granularity. With 5-min slots, the model has 12 slots per hour to learn intra-hour patterns. The sinusoidal encoding gives a smooth signal at ramp slots. Could matter for sunrise/sunset shoulder dynamics. Keep until measured.
- **`shoulder_flag`** — binary edge marker. Cheap to compute, provides a clean "is this a shoulder slot?" indicator that the model can split on directly. Keep.

These could be revisited in a v2.9 trim if the v2.8 trim shows good results.

---

## Expected impact post-application

| Metric | Before (72 features) | After (58 features) |
|---|---|---|
| FEATURE_COLS length | 72 | 58 |
| Training samples per feature | ~180 | ~225 |
| Inference: build_features cost | baseline | ~5–8% faster (one less PCA-style normalization, fewer dict allocs) |
| Model file size | baseline | ~10–15% smaller (fewer trees needed for same depth) |
| WAPE / MAPE | baseline | **target: same ±1%** |
| SHAP interpretability | 72-feature dependency plot | 58-feature plot, less correlated noise |
| Risk of overfitting on noise | moderate | reduced |

If WAPE moves >2% in either direction after a week, that's a signal worth investigating, not necessarily a reason to revert.

---

## Sign-off

When this patch is applied successfully:
- [ ] All 11 apply-checklist steps complete
- [ ] WAPE comparison done over 3 forecast days post-apply
- [ ] Decision recorded: **keep** / **revert** / **partial revert**
- [ ] This file's `Status:` header updated from PENDING to APPLIED / REVERTED / PARTIAL, with the deciding commit hash recorded
