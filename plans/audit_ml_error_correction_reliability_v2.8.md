# ML Error Correction Reliability Audit — v2.8

**Date:** 2026-04-12
**Scope:** Reliability and correctness of the ML error-correction learning loop — `compute_error_memory`, `_spread_weight`, legacy fallback, regime penalties, bias application, and eligibility gates.
**Companion docs:**
- `plans/audit_solcast_data_feed_reliability_v2.8.md`
- `plans/audit_solcast_data_feed_efficiency_v2.8.md`

This audit focuses on **correctness and signal integrity**, not throughput.
It assumes P1 → P3 efficiency batches are in place and looks for scenarios where
the error-memory learning loop would produce stale, biased, or silently-broken
output without the operator noticing.

---

## Executive Summary

| # | Finding | Severity | Signal |
|---|---------|----------|--------|
| **M1** | Legacy fallback uses stale provider names (`learning`, `ml_local`) — **every row gets 0.2× penalty always** | Critical | Any day we hit legacy fallback, the bias correction is silently 20% of what the operator expects |
| **M2** | Legacy fallback ignores `_spread_weight` entirely — loses v2.8 locked-snapshot weighting signal | High | Sparse-regime days (rainy/overcast) lose their spread-aware learning |
| **M3** | Legacy fallback ignores `ERR_MEMORY_REGIME_PENALTY_MATRIX` — no regime-mismatch discount | High | Clear-day forecasts can be biased by rainy-day errors during fallback |
| **H1** | `_spread_weight` floor docstring says `[0.3, 1.0]` but backfill path can return `0.09` | High | Telemetry and reasoning about minimum signal strength is wrong |
| **H2** | `_spread_weight` returns `1.0` for `None`/zero spread — highest trust for **unknown** spread | High | Pre-v2.8 rows get full weight instead of the intended skeptical discount |
| **H3** | `_persist_qa_comparison` eligibility requires `usable_slots >= 132` with `132` as a bare literal | Medium | Magic number is actually 85% of SOLAR_SLOTS (156); any SOLAR window change silently breaks the gate |
| **H4** | Bias-damping only fires when `used_solcast=True`; physics-only paths apply raw `ERROR_ALPHA × mem_err` | Medium | Correct by design for pure physics, but this branch is untested and could amplify any training-set bias |
| **H5** | `applied_bias_total_kwh` telemetry computed **before** damping — shows undamped magnitude | Medium | Operator sees inflated bias numbers vs what actually hit the final forecast |
| **M4** | TOD-zone floor keeps bias alive at 40% of zone mean when 80% consistent — can lock in stale biases | Medium | Prevents learning loop from forgetting old plant-response patterns after a module swap / cleaning event |
| **L1** | `ERR_MEMORY_DECAY = 0.72` → day-7 weight = 0.72⁶ = 0.14 (decays 86% in a week) | Low | Very aggressive decay; overcast/rainy regimes with 21-day windows still favor last 3-5 days |
| **L2** | `regime_confidence` clipped to `[0.60, 1.0]` in regime blend — always ≥60% regime influence | Low | Misclassified days still get heavy regime-model influence |
| **L3** | Error memory `applied_bias_total_kwh` in metadata doesn't distinguish solar vs total slots | Low | Non-solar slots are zeroed, so the sum is correct, but the telemetry label is misleading |
| **C1** | Constants `ERR_MEMORY_DAYS`, `ERR_MEMORY_DECAY`, `ERROR_ALPHA` lack test coverage for edge cases | Low | No regression tests ensure the hyperparameters stay within their intended envelopes |

**Critical findings: 1** (M1)
**High findings: 5** (M2, M3, H1, H2, H4/H5)
**Medium findings: 2** (H3, M4)
**Low: 4** (L1, L2, L3, C1)

---

## Pipeline Map

```
                      ┌─────────────────────────────┐
                      │  forecast_error_compare_    │
                      │  daily (eligibility gate)   │
                      │  + _slot (signed_error_kwh) │
                      └──────────────┬──────────────┘
                                     │
                                     ▼
┌─────────────────┐    ┌──────────────────────────┐    ┌──────────────────┐
│ _spread_weight  │───▶│   compute_error_memory   │───▶│  _LAST_ERROR_    │
│ ERR_MEMORY_     │    │   (regime-aware, spread- │    │  MEMORY_META     │
│ REGIME_PENALTY_ │    │   weighted, decay-weighted)│   │  (telemetry)     │
│ MATRIX          │    └────────┬───────┬─────────┘    └──────────────────┘
└─────────────────┘             │       │
                                │       └─► _compute_error_memory_legacy
                                │            (sparse-regime fallback)
                                ▼
                    ┌──────────────────────────┐
                    │   run_dayahead:          │
                    │   bias_correction        │
                    │   = ERROR_ALPHA × mem_err│
                    │   × _bias_damp(regime,   │
                    │     solcast_coverage)    │
                    └──────────────────────────┘
                                │
                                ▼
                    forecast = baseline + ml_residual
                             + error_class_term
                             + bias_correction      ← capped by plant cap
```

---

## Critical & High Findings

### **M1 — Legacy fallback applies a blanket `0.2×` penalty (CRITICAL)**

**File:** `services/forecast_engine.py:5446-5451`

```python
for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
    if exclude_arr[slot] or slot not in day_history:
        continue
    provider, slot_err = day_history[slot]
    err[slot] = float(np.clip(slot_err, -200.0, 200.0))
    w = ERR_MEMORY_DECAY ** (d - 1)
    if provider not in ("learning", "ml_local"):   # ← bug
        w *= source_mismatch_penalty  # 0.2
    weight_vec[slot] = w
```

The check `provider not in ("learning", "ml_local")` compares against **obsolete provider names** that no longer exist. The current providers are:
- `solcast_direct`
- `ml_solcast_hybrid_fresh`
- `ml_solcast_hybrid_stale`
- `ml_without_solcast`

Since *every* current provider name is "not in" the legacy tuple, **every row gets a 0.2× penalty when the legacy path is active**. The legacy path engages on any of:
- `fallback_reason == "no_eligible_rows"` (daily table empty)
- `fallback_reason == "sparse_regime_data"` (fewer than half the target regime days)
- `fallback_reason == "exception"` (SQL error in the main path)

So any time a new deployment starts with an empty compare table, **error memory is silently reduced to 20% strength** until the daily table fills up. Same for any regime that's been absent from the training window.

**Impact:** The fallback is supposed to be a degraded-but-useful mode. It is actually a degraded-to-1/5 mode, making error memory near-useless whenever the primary path isn't feasible.

**Fix:** Replace the legacy provider check with the current `_memory_source_weight` function and read the actual `provider_used` column from the slot table:

```python
# Pre-fetch the daily row to get forecast_variant / provider_expected
# and call _memory_source_weight() instead of the string-match penalty.
```

Alternatively, drop the legacy penalty entirely if the slot table already carries `usable_for_error_memory=1` (QA's filter is already the source of truth).

**Priority:** P1. This is a silent 5× under-correction whenever fallback fires.

---

### **M2 — Legacy fallback ignores `_spread_weight`**

**File:** `services/forecast_engine.py:5431-5455`

The main path weighs each slot by `base_w × source_weight × support_weight × regime_factor × spread_weight`. The legacy path only uses `ERR_MEMORY_DECAY × source_mismatch_penalty`. Notably:

- No `_spread_weight` → wide-spread days count equally with narrow-spread days
- No `support_weight` → all slots get equal weight regardless of QA support scoring
- No regime matrix → distant-regime history pollutes target-regime correction

**Fix:** The legacy path should either:
1. Be **deleted** entirely once the main path has been proven stable for 30+ days (the main path already has robust fallbacks for `no_eligible_rows`), OR
2. Be **upgraded** to use the same weighting primitives by selecting from `forecast_error_compare_slot` directly and joining to `solcast_dayahead_locked` for spread/capture_reason.

**Priority:** P2. Medium urgency — depends on how often the fallback actually fires in production. If M1 is fixed and the fallback rate is <5% of cycles, deletion is preferable.

---

### **M3 — Legacy fallback ignores regime mismatch penalty**

**File:** `services/forecast_engine.py:5431-5455`

`ERR_MEMORY_REGIME_PENALTY_MATRIX` (declared at line 371) applies 0.20-0.70 penalties depending on regime pair distance. The legacy path never consults it — days are weighted purely by recency decay.

This means in sparse-regime scenarios the legacy path will **cross-pollinate** errors between regimes. Example: a clear-day target with only rainy-day history available will apply full rainy-day bias to clear slots — exactly the case the penalty matrix exists to prevent.

**Fix:** Joined with M2 — the legacy path needs to fetch regime from the daily table (or from notes_json as the main path does) and apply the penalty matrix.

**Priority:** P2. Pairs with M2.

---

### **H1 — `_spread_weight` floor violation (docstring vs reality)**

**File:** `services/forecast_engine.py:5494-5511`

```python
def _spread_weight(spread_pct_cap_locked, capture_reason) -> float:
    """
    Returns:
        Weight multiplier [0.3, 1.0]   ← DOCSTRING
    """
    base = 1.0
    if spread_pct_cap_locked is not None and spread_pct_cap_locked > 0:
        base = max(0.3, 1.0 - (spread_pct_cap_locked / 100.0))
    if capture_reason == "backfill_approx":
        base *= 0.3   # ← can multiply past the 0.3 floor
    return base
```

Backfill + 70% spread produces `0.3 × 0.3 = 0.09`. Backfill + 0% spread produces `1.0 × 0.3 = 0.3`. Backfill + any positive spread: below 0.3.

**Actual range: `[0.09, 1.0]`**, not `[0.3, 1.0]`.

**Why it matters:** The docstring is load-bearing. `compute_error_memory` logs `avg_spread_weight` as a telemetry signal the operator uses to judge learning-loop health. If the operator believes 0.3 is the floor and sees 0.15, that looks like a bug — but it's actually the intended compound discount.

**Fix:** Two options:
1. **Tighten the floor to `0.3`:** `return max(0.3, base * 0.3)` for backfill — matches the docstring.
2. **Fix the docstring:** document the actual `[0.09, 1.0]` range and explain the compound rationale (unknown/backfilled spread ≈ 10% of a fresh narrow-spread signal).

Option 2 is probably correct — backfilled rows *should* be discounted more than fresh wide-spread rows. But the docstring must match.

**Priority:** P1 (cheap, 2-line fix).

---

### **H2 — `_spread_weight` gives full weight to unknown spread**

**File:** `services/forecast_engine.py:5506-5508`

```python
base = 1.0
if spread_pct_cap_locked is not None and spread_pct_cap_locked > 0:
    base = max(0.3, 1.0 - (spread_pct_cap_locked / 100.0))
# else: base remains 1.0
```

When `spread_pct_cap_locked is None` (pre-v2.8 rows, locked snapshot absent, or capture_reason path that never wrote a spread value), the function returns `1.0` — the **maximum trust**.

This inverts the intended semantics: the whole purpose of `_spread_weight` is to discount high-uncertainty signals. A completely unknown spread is infinite uncertainty, and should get the *lowest* trust, not the highest.

**Impact:** During the v2.8 migration window, rows without spread get the same weight as a perfect 0%-spread day. Pre-v2.8 history dominates the error memory signal for the first ~30 days after the migration.

**Fix:** Default None/zero spread to a mid-range weight (e.g. `0.5`):

```python
if spread_pct_cap_locked is None or spread_pct_cap_locked <= 0:
    base = 0.5  # unknown spread → medium trust
else:
    base = max(0.3, 1.0 - (spread_pct_cap_locked / 100.0))
```

**Priority:** P1 if v2.8 migration is still within ~30 days of go-live. P2 if migration is already well past.

---

### **H3 — Magic number `132` for eligibility threshold**

**File:** `services/forecast_engine.py:8670-8675`

```python
include_in_source_scoring = (
    actual_slots_count >= 132
    and forecast_slots_count >= 132
)
include_in_error_memory = (
    include_in_source_scoring
    and usable_slots >= 132
    ...
)
```

`132 / 156 = 84.6%` — this is "at least 85% of solar window present." But `132` is a bare literal; nothing documents the derivation. If SOLAR_START_H or SOLAR_END_H ever change (e.g. to include twilight), SOLAR_SLOTS changes but `132` stays fixed — silently shrinking the gate to a smaller fraction.

**Fix:** Replace with a named constant:

```python
MIN_USABLE_SLOTS_FOR_ELIGIBILITY = int(SOLAR_SLOTS * 0.85)  # 85% of solar window
```

**Priority:** P2. Not a bug today, but an obvious trap for the next refactor that touches the solar window.

---

### **H4 — Bias damping skipped on physics-only paths**

**File:** `services/forecast_engine.py:10233-10294`

```python
err_mem = compute_error_memory(today, w5, target_regime=target_regime)
bias_correction = ERROR_ALPHA * err_mem  # always applied

if bool(solcast_meta.get("used_solcast")):   # ← damping gate
    # ... regime-aware _bias_damp multiplier ...
    if _bias_damp < 1.0:
        bias_correction = bias_correction * _bias_damp
```

When `used_solcast=False` (Solcast missing, stale-reject, or the physics-only fallback path), damping is **skipped entirely**. Raw `0.28 × clip(mem_err, -100, 100)` lands in the final forecast.

Is this intentional? Plausibly yes — if we have no Solcast hedge, we need every bit of the learned error correction. But:
1. There's no comment documenting this branch.
2. There's no test that exercises it.
3. On physics-only days, the training set for `mem_err` still contains days where Solcast WAS used — so the learned bias may be compensating for a Solcast artifact that doesn't exist today.

**Fix:** Document the branch and add a test. Consider applying a **fixed** `_bias_damp = 0.5` on physics-only days to hedge against training-set drift.

**Priority:** P2. Design decision, not a bug.

---

### **H5 — `applied_bias_total_kwh` telemetry ignores damping**

**File:** `services/forecast_engine.py:5817`, `5734`, `5759`

```python
bias_applied = float((ERROR_ALPHA * mem_err).sum())   # ← undamped
_LAST_ERROR_MEMORY_META = {
    ...,
    "applied_bias_total_kwh": bias_applied,
}
```

This number is surfaced in `/api/forecast/engine-health` as the "applied bias" the operator uses to judge learning-loop magnitude. But it's computed **inside compute_error_memory** — before `run_dayahead` applies the `_bias_damp` multiplier.

On a clear-regime day with fresh Solcast, damping is `0.30`, so the reported `applied_bias_total_kwh` is **3.3× larger** than what actually hit the final forecast.

**Fix:** Two options:
1. Stop computing `applied_bias_total_kwh` inside `compute_error_memory`; let `run_dayahead` compute it post-damping and stuff it into the meta dict.
2. Rename the field to `raw_bias_total_kwh` and add a separate `applied_bias_total_kwh` at the run_dayahead level.

Option 1 is simpler. Option 2 preserves both signals (the raw magnitude is useful for sanity-checking the learning loop).

**Priority:** P2. Misleading telemetry, not a correctness issue.

---

### **M4 — TOD floor can lock in stale biases**

**File:** `services/forecast_engine.py:5785-5809`

```python
if _zone_abs_mean > 1.0:  # At least 1 kWh/slot bias
    _same_sign = np.sum(np.sign(_zone[_zone_active]) == np.sign(_zone_mean))
    _consistency = _same_sign / max(np.sum(_zone_active), 1)
    if _consistency > 0.80:
        # Floor: at least 40% of zone mean persists
        _floor = _zone_mean * 0.40
        if _zone_mean > 0:
            mem_err[_tod_start:_tod_end] = np.maximum(mem_err[_tod_start:_tod_end], _floor)
        else:
            mem_err[_tod_start:_tod_end] = np.minimum(mem_err[_tod_start:_tod_end], _floor)
```

When 80%+ of active slots in a TOD zone show the same-sign bias AND the zone mean magnitude exceeds 1 kWh/slot, this code installs a 40%-of-zone-mean floor. The intent: "don't let the smoother wipe out a consistent bias signal."

**Scenario that breaks:** After a plant-side change (module cleaning, new inverter, reconfigured string), the **previous** bias pattern is no longer real. Error memory needs to learn the new pattern, which means the smoothed `mem_err` should taper toward zero over ~ERR_MEMORY_DECAY days. But the floor mechanism *prevents* that tapering — any consistent-looking stale bias in the window stays at 40% until the window fully rolls over (~21 days for rainy).

**Fix:** Gate the floor on recency — only apply if the *newest* days (last 3) also show the same bias. If the most recent days have flipped, the floor should release even though the window average is still consistent.

**Priority:** P2. Only fires during plant-state transitions but the masking is silent.

---

## Low-severity observations

### L1 — ERR_MEMORY_DECAY = 0.72 is aggressive

`0.72⁶ = 0.14` → day-7 weight is 14% of day-1. For rainy regime with 21-day window, day-14 weight is `0.72¹³ = 0.013` (1.3% — essentially noise). The "21-day window" for rainy is effectively a 7-day window with a 14-day tail.

**Consideration:** Is the operator aware that the effective rainy-regime lookback is ~7 days? If not, they may expect smoother behavior from 21 days of data than they're actually getting. A decay of 0.85 (day-7 = 38%, day-14 = 10%) would give a genuinely 14-day-effective window.

**Priority:** Design decision. Defer.

### L2 — Regime confidence floor at 0.60

`regime_confidence` is clipped to `[0.60, 1.0]` in `predict_residual_with_bundle`:7774. A regime classification with 0.1 confidence still gets 60% blend weight. If the classifier is saying "I have no idea what regime this is," we should probably fall back to the global model entirely rather than forcing 60% regime influence.

**Fix:** Drop the floor and let low-confidence regimes pass through with `confidence × blend`. Zero out regime influence when confidence < 0.30.

**Priority:** L. Unlikely to bite in practice since the classifier is usually confident.

### L3 — Label: `applied_bias_total_kwh` is actually "solar-window applied bias"

The value is correct (non-solar slots are zeroed in `mem_err`), but the label doesn't distinguish. Cosmetic.

### C1 — No regression tests for the hyperparameters

`ERR_MEMORY_DAYS`, `ERR_MEMORY_DECAY`, `ERROR_ALPHA`, `ERR_MEMORY_REGIME_PENALTY_MATRIX` are bare module constants with no test coverage for boundary cases. A future refactor could change `ERROR_ALPHA` from 0.28 to 0.50 without any test failing.

**Fix:** Add a `test_error_memory_constants.py` that snapshots the current values and fails loudly on any change (forces an explicit code-review moment).

---

## What's already solid (do not touch)

- **Eligibility pipeline at `_persist_qa_comparison:8673`:** Correctly composes `usable_slots ≥ 132 AND constrained_ratio ≤ 0.30 AND not provider_mismatch AND solcast_freshness_class ∉ {missing, stale_reject} AND not degraded_variant`. This is thorough — excludes curtailed, stale, and mismatched days from the training set.
- **`_memory_source_weight`** (`:8597`) covers all current provider variants with sensible defaults. No dead branches.
- **Regime penalty matrix** (`:371`) is symmetric and sensible — neighboring regimes (overcast↔rainy: 0.70) get more credit than distant ones (clear↔rainy: 0.20).
- **Main path's per-day capture_reason pre-fetch** (post-P3: batched at `:5590-5624`) is correct — avoids N+1 queries.
- **`_LAST_ERROR_MEMORY_META` global** is a clean handoff pattern — written by `compute_error_memory`, read by `run_dayahead`, cleared/overwritten per call. No cross-call leakage.
- **LightGBM regime routing** (`predict_residual_with_bundle`) has proper fallback to global model on any regime failure. Bundle checksum validation at `load_model_bundle:7622` prevents corrupted-model silent fallback.
- **`_collect_data_quality_warnings`** surfaces `error_memory_sparse_regime`, `error_memory_stale`, etc. — the operator can see when fallback is firing.
- **Bias clip at ±100 kWh/slot** is appropriate for a 26 MW plant (max bias = 100 / 2200 kWh/slot ≈ 4.5% of plant capacity per slot).

---

## Prioritized Fix Queue

| Priority | Finding | Effort | Risk |
|---|---|---|---|
| **P1** | **M1** — legacy fallback provider-name bug | 30 min | Low |
| **P1** | **H1** — `_spread_weight` floor docstring vs reality | 5 min | None |
| **P1** | **H2** — `_spread_weight` None handling | 10 min | Low |
| P2 | H3 — named constant for 132 | 5 min | None |
| P2 | H5 — telemetry post-damping | 15 min | Low |
| P2 | H4 — document physics-only damping branch | 10 min | None |
| P2 | M2 + M3 — upgrade OR delete legacy fallback | 1 h / 15 min | Medium |
| P3 | M4 — recency-gate the TOD floor | 30 min | Medium |
| P4 | L1, L2, L3, C1 | 20 min each | None |

**P1 batch total effort: ~45 minutes.**
**P1 expected impact:** Fix a critical 5× under-correction (M1), bring docstring and code into alignment (H1), and eliminate pre-v2.8 full-weight leakage (H2).

---

## Recommended apply checklist

Before landing any fix:

1. `git diff services/forecast_engine.py` — confirm only target lines changed
2. `python -m py_compile services/forecast_engine.py`
3. `pytest services/tests/test_forecast_engine_error_classifier.py services/tests/test_forecast_engine_weather.py -x`
4. Create a **test fixture** that forces `fallback_to_legacy=True` by seeding only 2 eligible days against a 14-day rainy lookback, and assert the bias magnitude roughly matches the main path's magnitude ± 30%. This is the missing test that would have caught M1 the moment it shipped.
5. Snapshot-test `_spread_weight` boundary cases: `(None, None)`, `(0, None)`, `(0, "backfill_approx")`, `(50, None)`, `(50, "backfill_approx")`, `(100, None)`.

Rollback: each P1 fix is a <20-line change with obvious undo semantics.

---

## Non-goals (explicitly deferred)

- Replacing ERR_MEMORY_DECAY with an adaptive decay based on training-set stability — too much design space.
- Introducing a Bayesian posterior for error memory — overkill for a weekly-drift signal.
- Per-slot spread weighting (vs per-day) — slot-level locked-snapshot spread exists but would require restructuring `_spread_weight` to return an array.
- Cross-validation of ERROR_ALPHA — needs a backtest harness, out of scope.

---

**Status:** Audit complete, ready for user decision on P1 batch (M1 + H1 + H2).
