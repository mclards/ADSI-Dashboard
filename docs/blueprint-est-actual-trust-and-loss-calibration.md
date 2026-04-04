# Blueprint: Est_Actual Trust Elevation & Transmission Loss Calibration

**Author:** Engr. Clariden D. Montano REE  
**Date:** 2026-04-04  
**Status:** IMPLEMENTED (Phases 1–13 complete, Phase 14 pending)  
**Applies to:** forecast_engine.py, ipconfig losses, QA pipeline, public/js/app.js (Analytics Summary)  
**Last updated:** 2026-04-05

---

## Motivation

Two operator-validated observations that should inform forecast engine tuning:

1. **Solcast estimated actuals are very nearly accurate.** The current 15% training
   weight discount (`EST_ACTUAL_WEIGHT_FACTOR = 0.85`) may be overly conservative.
   Est_actual data represents satellite-derived measurements of what the plant
   actually produced — it should not go to waste.

2. **Inverter-to-substation transmission loss varies between 2.5% and 3.6%.**
   The current system defaults all 27 inverters to a flat 2.5%
   (`DEFAULT_INVERTER_LOSS_PCT = 2.5`). Cable length, routing, and connection
   quality differ per inverter, so a per-inverter calibration within that range
   would improve substation-level accuracy.

---

## Part A: Elevate Est_Actual Trust in Training & QA

### Current Behavior

| Component | How est_actual is used | Trust level |
|-----------|----------------------|-------------|
| **Training data** (L3637-3664) | Backfills sparse Solcast forecast slots with est_actual_kwh | Zero-spread (P10=P90=est_actual) |
| **Training weights** (L6206-6209) | Days with est_actual reconstruction get 0.85x weight | 15% discount |
| **QA comparison** (L8226-8272) | Replaces outage/cap/manual slots with est_actual | Full trust for metrics, but slot count logged |
| **Outage recovery** (L5074-5117) | Fills actual_effective for severe outage days | Gated by 80% coverage threshold |
| **Error memory** (L6326-6329) | Flags `est_actual_reconstruction_active` as warning | Advisory only |

### Proposed Changes

#### A1. Raise EST_ACTUAL_WEIGHT_FACTOR from 0.85 to 0.93

**Rationale:** Operator confirms est_actual is nearly exact. A 7% discount (down
from 15%) still acknowledges it's satellite-derived rather than metered, but
respects the high accuracy. This directly increases training influence of
outage-recovered days instead of wasting that data.

```python
# Before
EST_ACTUAL_WEIGHT_FACTOR = 0.85   # training weight discount

# After
EST_ACTUAL_WEIGHT_FACTOR = 0.93   # satellite-derived, nearly accurate per operator validation
```

**Impact:** ~5-8% more weight on reconstructed training days. Most visible on
overcast/rainy days where outage recovery is common and training data is already
scarce.

#### A2. Use est_actual as primary actual source for QA (not just reconstruction)

**Current:** QA only falls back to est_actual when outage/cap/manual flags are set.  
**Proposed:** When actual data has gaps (presence < 100%) within solar window but
est_actual is available, prefer est_actual for those missing slots even without
an explicit outage flag. This captures scenarios like:
- Brief inverter communication drops (not flagged as outage)
- Partial-day SCADA gaps
- Individual inverter timeouts during cloud transients

```
New logic in _compare_forecast_qa():
  for each solar slot:
    if actual_present[slot] == False AND est_actual_kwh[slot] > 0:
      actual_recon[slot] = est_actual_kwh[slot]
      actual_present_recon[slot] = True
      # No constraint flag to clear — this is gap-fill, not constraint override
```

**Impact:** Higher QA coverage on days with minor data gaps. More days qualify
for error memory. No risk of double-counting because est_actual IS the actual.

#### A3. Allow est_actual to enrich training even without outage flags

**Current:** Training only backfills when `forecast_kwh` (Solcast mid) is sparse.  
**Proposed:** When loading training history for a past day, if metered actual
has gaps but est_actual covers those slots, blend them in:
- Metered actual takes priority where present
- Est_actual fills gaps where metered is missing
- No weight discount for gap-filled slots (they ARE measured, just via satellite)

This is distinct from A1 (which discounts entire reconstructed days). Here,
individual slots filled by est_actual get full weight because the satellite
measurement for that specific slot is accurate.

---

## Part B: Transmission Loss Calibration

### Current Behavior (Already Implemented)

- Per-inverter loss already configurable via **IP Config** page (`ipconfig.losses` map)
- `DEFAULT_INVERTER_LOSS_PCT = 2.5` used when no per-inverter value is set
- Loss adjustment already applied to: training actuals, QA actuals, error memory, capacity profile
- Dashboard telemetry and exports intentionally use raw (unadjusted) inverter values
- `_query_energy_5min_loss_adjusted()` reduces each inverter's kWh by its configured loss %
- `plant_capacity_profile()` applies loss to node counts for dependable/max kW

### Proposed Changes

#### B1. Update DEFAULT_INVERTER_LOSS_PCT to midpoint of observed range

```python
# Before
DEFAULT_INVERTER_LOSS_PCT = 2.5

# After  
DEFAULT_INVERTER_LOSS_PCT = 3.0   # midpoint of observed 2.5%-3.6% range
```

**Rationale:** For any inverter not yet individually calibrated via ipconfig,
the default should reflect the center of the observed range rather than the low end.

#### B2. Validate per-inverter loss values against billing meter

**Method:** Compare loss-adjusted plant total against substation billing meter
for a representative clear day:

```
substation_metered_kwh  vs  sum(inverter_kwh[i] * (1 - loss[i]))
```

If the residual error is < 0.5%, the per-inverter loss map is well-calibrated.
If > 1%, investigate transformer losses or other unaccounted factors.

#### B3. Ensure all 27 inverters have site-specific loss values

Review each inverter's configured loss % in ipconfig and adjust within the
2.5%-3.6% range based on actual cable distance/routing to the substation.
The infrastructure already supports this — this is a data-entry task, not code.

---

## Part C: Estimated Substation Actual MWh in Analytics Summary

### Current Behavior

The **Analytics Summary** side card (Selected Date Summary) displays:
- **Actual MWh** — raw inverter-measured total (no loss adjustment)
- **Day-ahead MWh** — forecasted energy
- **Variance MWh** — actual minus forecast
- **Peak Interval** — highest single interval reading

The forecast engine internally uses loss-adjusted actuals for training and QA,
but the user-facing Analytics page only shows raw inverter output. There is no
visibility into what the substation actually received.

### Proposed Change

#### C1. Add "Est. Substation MWh" column to the Actual MWh row

Add a secondary column to the existing **Actual MWh** row (not a new row):

```
                          Inverter          Substation (est.)
  Actual MWh              24.567890 MWh     23.812345 MWh      ← NEW column (loss-adjusted)
  Day-ahead MWh           24.100000 MWh
  Variance MWh            -0.287655 MWh     ← CHANGED: substation vs forecast
  Peak Interval           ...
```

**Computation (frontend):**
```javascript
// Option A: Server provides a plant-average loss factor
const avgLossPct = State.plantAvgLossPct || 3.0;  // from /api/settings or /api/ipconfig
const estSubstationMwh = totalMwh * (1.0 - avgLossPct / 100.0);

// Option B: Server provides pre-computed loss-adjusted total via summary endpoint
const estSubstationMwh = summary.lossAdjustedMwh;  // from /api/analytics/energy
```

**Preferred approach: Option A** — simpler, no backend change needed beyond
exposing the plant-average loss percentage (which `plant_capacity_profile()`
already computes as `loss_adjusted_nodes / enabled_nodes`).

**UI element:** Add a secondary value column inside the existing Actual MWh row:
```html
<!-- Existing Actual MWh row — add substation column alongside -->
<div class="analytics-side-item">
  <div class="analytics-side-label">Actual MWh</div>
  <div class="analytics-side-value" id="anaSideTotalMwh">—</div>
  <div class="analytics-side-value analytics-substation-col"
       id="anaSideSubstation"
       title="Estimated energy delivered to substation after transmission losses (${avgLossPct}%).">
    —
  </div>
</div>
```

The substation column should be visually secondary (smaller font or muted color)
with a "Substation (est.)" sub-header visible in the column or tooltip.

**Where:** Only in the Analytics Summary side card (`analyticsTotalSideCard`).
Not in the toolbar, not in the Energy page header, not in exports.

#### C1b. Change Variance MWh basis to substation vs forecast

**Current:** `Variance = Inverter Actual MWh - Day-ahead MWh`  
**Proposed:** `Variance = Est. Substation MWh - Day-ahead MWh`

Computed at 5-min interval resolution (per-slot loss adjustment, then sum),
not as a bulk percentage of the daily total. This matches how the forecast
engine trains and evaluates — substation-level, not inverter-level.

**Note:** Using a plant-average loss factor (node-weighted from
`plant_capacity_profile()`) is an acceptable approximation here because the
per-inverter range is narrow (2.5%-3.6%). An energy-weighted average would be
more precise but the difference is negligible for this range.

```javascript
// Per-slot loss-adjusted actual, then sum
const substationValues = totalValues.map(v =>
  v !== null ? v * (1.0 - avgLossPct / 100.0) : null
);
const estSubstationMwh = substationValues.reduce((s, v) => s + (v || 0), 0);
// Guard: if dayAheadTotalMwh is null/undefined (no forecast for date), show "—" not NaN
const varianceMwh = (estSubstationMwh != null && dayAheadTotalMwh != null)
  ? estSubstationMwh - dayAheadTotalMwh
  : null;
```

#### C2. Show loss percentage in tooltip

The tooltip should show the configured average loss percentage so the user
understands the deduction:

```
title="Estimated energy delivered to substation after transmission losses (3.0%)."
```

If per-inverter losses vary, show the effective plant-average derived from
`plant_capacity_profile()`.

#### C3. Expose plant-average loss percentage from server

Add to `/api/forecast/engine-health` (preferred — this is a forecast/ML
diagnostic endpoint, not user settings) a field like:

```json
{
  "plantAvgLossPct": 3.05,
  "lossFactorSource": "ipconfig"
}
```

Derived from `plant_capacity_profile()`:
```python
avg_loss = 1.0 - (profile["loss_adjusted_nodes"] / max(profile["enabled_nodes"], 1))
avg_loss_pct = avg_loss * 100.0
```

---

## Part D: Actual-Source Architecture — How the Four Sources Drive Forecast Accuracy

### D1. The four data sources

| # | Source | Origin | Resolution | Availability | Curtailment-affected? | What it represents |
|---|--------|--------|-----------|-------------|----------------------|-------------------|
| 1 | **Est Dashboard Actual** | Inverter telemetry × (1 − loss%) | 5-min | Always (real-time) | **Yes** — reflects capped output | Estimated substation delivery based on inverter output minus configured transmission loss per inverter |
| 2 | **Est Solcast Actual** | Satellite imagery (Solcast est_actual) | 5-min (interpolated from 15/30-min) | T+2–4 hours after solar window | **No** — satellite sees irradiance, not dispatch | Satellite-derived estimate of what the plant produced — independent of inverter telemetry |
| 3 | **SCADA Exported Actual** | Substation meter log (69kV sheet) | 15-min (interpolated to 5-min) | Manual upload, any past date | **Yes** — meter reads capped delivery | Ground truth — metered energy at the substation point of interconnection |
| 4 | **Day-ahead Forecast** | LightGBM model + Solcast forecast + error memory | 5-min | Generated daily | N/A | The prediction to be evaluated and improved |

> **Critical note — curtailment / export capping:**
> Sources 1 (Est Dashboard) and 3 (SCADA) both reflect what the plant *actually
> delivered*, which on capped days is less than what it *could have produced*.
> If a cap/curtailment event suppresses output, these values are artificially low.
> Using them naively as training targets or error-memory baselines would teach
> the model to under-predict on similar high-irradiance days.
>
> Source 2 (Est Solcast) is **not** affected by curtailment — it estimates
> generation from satellite irradiance regardless of dispatch commands. This makes
> Solcast the correct reconstruction baseline for capped slots.

### D2. Priority chain (per 5-min slot)

Every consumer in the system resolves "actual substation MWh" for a given slot
using this fallback chain. Resolution is **per-slot** — a single day can mix
sources if some slots have metered data and others don't.

```
┌──────────────────────────────────────────────────────────────────┐
│  For each 5-min slot:                                            │
│                                                                  │
│  Step 0 — Curtailment check (applies before source selection):   │
│    Is this slot flagged as cap-dispatched or export-curtailed?   │
│      YES → slot is EXCLUDED from training & error memory;        │
│             for QA/analytics, actual value is shown but           │
│             annotated as "capped" (see D3 per-consumer rules)    │
│      NO  → proceed to source selection ↓                         │
│                                                                  │
│  Step 1 — Source selection (normal, non-capped slots):           │
│  1. SCADA metered (15→5min interpolated)  weight = 1.0           │
│     ↓ not available                                              │
│  2. Est Dashboard Actual (loss-adjusted)  weight = 1.0           │
│     ↓ inverter data gap for this slot                            │
│  3. Est Solcast Actual                    weight = 0.93          │
│     ↓ Solcast not available                                      │
│  4. Slot marked missing — excluded from metrics                  │
│                                                                  │
│  Step 2 — Reconstruction (capped slots only, training/errm):    │
│  Capped slots are replaced with Solcast mid baseline             │
│  (hybrid_base) so the model learns unconstrained potential,      │
│  not the artificially depressed capped output.                   │
│  If Solcast is unavailable → slot excluded entirely.             │
└──────────────────────────────────────────────────────────────────┘
```

**Why this order:**
- SCADA is metered at the substation — no estimation, no loss assumption
- Est Dashboard is real-time inverter data with a configured loss factor — good
  but subject to loss-factor calibration error (±0.5%)
- Est Solcast is satellite-derived — independent and nearly accurate per operator
  validation, but still an estimate (7% discount from 1.0)

**Why curtailment must be checked first:**
- Both SCADA and Dashboard actuals are *metered/observed* — on capped days
  they show what the plant delivered, not what it could have produced
- Without the curtailment check, SCADA's high trust (weight 1.0) would cause
  the model to treat capped output as the "correct" target for high-irradiance
  conditions, systematically depressing future forecasts
- The existing engine already detects this via `curtailed_mask()` (export-cap
  detection) and `cap_dispatch_mask` (commanded cap events) — these checks
  must apply identically to SCADA data when it enters the pipeline

### D3. How each consumer uses the chain

#### D3a. ML Training (historical actuals → model learns patterns)

| What the model needs | How it's sourced |
|---------------------|-----------------|
| Target variable (y) | Actual substation MWh per 5-min slot, resolved via D2 chain |
| Sample weight | 1.0 if SCADA or Dashboard source; 0.93 if any slot in the day used Solcast |
| Gap handling | Slots with no actual from any source → day excluded from training if coverage < 80% |
| **Curtailment handling** | **Capped slots excluded from training regardless of source** (see below) |

**Curtailment-aware training (existing engine behavior, extended to SCADA):**

The engine already applies two curtailment detection mechanisms:
1. `cap_dispatch_mask` — slots where inverters were commanded off for export
   limiting. These are replaced with the Solcast hybrid baseline (`hybrid_base`)
   so the model sees unconstrained potential, not capped output.
2. `curtailed_mask()` — detects export-capped slots by comparing actual
   generation against the export limit (actual ≥ 97% of cap and baseline > 105%
   of cap). These slots are excluded from training entirely.

**When SCADA is the actual source, the same two checks must apply:**
- If SCADA MWh for a slot is at or near the export cap → `curtailed_mask()`
  flags it, slot excluded from training
- If `cap_dispatch_mask` is set for a slot → SCADA value replaced with
  `hybrid_base` (Solcast mid), same as Dashboard actuals
- Non-capped SCADA slots proceed normally with weight 1.0

This prevents SCADA's high trust from backfiring on capped days — without this
guard, metered capped output at weight 1.0 would have outsized negative impact
on the model's high-irradiance predictions.

**How SCADA improves training (non-capped days):**
- Model currently trains on Est Dashboard (loss-estimated) targets → systematic
  bias if loss factors are slightly wrong (e.g., configured 2.5% but real is 3.2%)
- SCADA provides the true substation value → model learns the real relationship
  between weather/forecast inputs and actual substation output
- Over time, as SCADA data accumulates, training set shifts from estimated to
  measured targets → model accuracy converges toward metered ground truth
- SCADA days get weight 1.0 (no discount) — they are the highest-quality samples

#### D3b. QA Comparison (post-day forecast evaluation)

```
For selected date:
  actual_slot[i] = resolve via D2 chain
  forecast_slot[i] = day-ahead forecast for slot i
  
  error[i] = actual_slot[i] - forecast_slot[i]
  MAPE = mean(|error[i]| / actual_slot[i]) × 100
  Bias = mean(error[i])
```

**How SCADA improves QA:**
- Currently QA compares forecast vs Est Dashboard — if loss factors are wrong,
  the "actual" baseline itself is inaccurate, making QA metrics unreliable
- SCADA gives a trustworthy baseline → QA metrics reflect true forecast quality
- Days with SCADA data produce higher-confidence QA scores
- QA can flag loss-factor drift: if `|SCADA_total - EstDashboard_total|` is
  consistently > 1%, the per-inverter loss config needs recalibration

**Curtailment in QA:**
QA metrics on capped days are reported but annotated. Capped slots show actual
(curtailed) delivery, which makes the forecast appear to "over-predict" — this
is correct behavior, not a forecast error. QA should:
- Flag capped days in the classification (existing `cap_dispatch_slot_count`)
- Exclude capped slots from MAPE/bias calculation (they distort accuracy metrics)
- Optionally show a separate "capped-day MAPE" for operational awareness

#### D3c. Error Memory (systematic bias correction)

Error memory tracks per-regime (clear/mixed/overcast/rainy) forecast bias and
applies corrections to future forecasts.

| Without SCADA | With SCADA |
|--------------|-----------|
| Error = EstDashboard − Forecast | Error = SCADA − Forecast |
| Contaminated by loss-factor error | Pure forecast error signal |
| May learn to "correct" for wrong loss factor instead of weather bias | Corrects only for actual weather-driven forecast errors |

**Key insight:** If the loss factor is misconfigured by 0.5%, error memory will
incorporate that 0.5% as a systematic "forecast bias" and try to correct for it.
SCADA data breaks this feedback loop — the error signal reflects real forecast
shortcomings, not measurement artifacts.

**Curtailment guard for error memory:**
Error memory must exclude capped slots from both SCADA and Dashboard actuals.
On a capped day, the error signal `(actual − forecast)` is negative not because
the forecast was wrong, but because the plant was constrained. If this enters
error memory for the "clear" regime (which is when capping typically occurs),
it would teach the system to apply a *negative* correction on clear days —
exactly the opposite of what's needed. The existing `cap_dispatch_mask` and
`curtailed_mask()` exclusions apply here identically:
- Capped slots → excluded from error computation for that date
- If too many solar-window slots are capped → entire day excluded from error
  memory (same coverage threshold as training)

#### D3d. Intraday Adjustment (real-time correction during the day)

Intraday uses **Est Dashboard Actual** (real-time inverter telemetry) since
SCADA is only available post-day. Solcast est_actual has a 2-4 hour delay,
so it's also not useful for intraday.

```
Intraday source: Est Dashboard Actual only (real-time)
SCADA/Solcast: not applicable (delayed)
```

#### D3e. Analytics Display (variance shown to user)

**Implemented layout:** Three separate cards in a 3×2 grid:
- **Inverter MWh** — raw inverter total (no loss adjustment)
- **Substation (est.)** — always shows loss-adjusted estimate
- **Subs. Metered MWh** — shows uploaded meter data when available, otherwise "—"

```
Variance = best available substation actual − Day-ahead forecast
  Metered available → uses metered value
  No metered data   → uses Substation (est.) value
```

### D4. Accuracy improvement mechanisms

| Mechanism | Source needed | Effect on forecast |
|-----------|-------------|-------------------|
| **Better training targets** | SCADA replaces estimated actuals | Model learns real substation output, not loss-estimated. Eliminates ~0.5% systematic target bias |
| **Loss factor calibration** | SCADA vs Est Dashboard comparison | Reveals if per-inverter loss% is correct. Enables data-driven recalibration |
| **Cleaner error memory** | SCADA provides pure error signal | Error corrections address real weather bias, not measurement artifacts |
| **Curtailment-safe actuals** | All sources checked against cap/curtailment masks | Capped SCADA/Dashboard slots excluded from training & error memory; Solcast baseline used for reconstruction. Prevents the model from learning suppressed output as "normal" on high-irradiance days |
| **Higher QA coverage** | Solcast fills inverter gaps | More days qualify for QA → richer error memory → better corrections |
| **Trusted training weight** | Solcast weight raised 0.85→0.93 | Outage-recovered days contribute more to training instead of being discounted |
| **Better default loss** | 2.5%→3.0% midpoint | Uncalibrated inverters use a more representative default |

### D5. Data accumulation and feedback loop

```
Day 1-30:   Mostly Est Dashboard + Solcast → model trains on estimated targets
Day 30-90:  SCADA uploads accumulate → mixed training set, QA starts flagging
            loss-factor discrepancies
Day 90+:    Majority of training days have SCADA → model converges on metered
            ground truth, error memory is clean, loss factors are validated

Cross-validation available at any time:
  SCADA total vs Est Dashboard total → validates loss factors
  SCADA total vs Est Solcast total   → validates Solcast accuracy
  All three vs Day-ahead             → true forecast MAPE

Curtailment interaction over time:
  - Capped days are common during high-irradiance clear-sky periods
  - Without curtailment guards, SCADA accumulation would worsen clear-sky
    forecasts (more capped "truth" samples depressing the model)
  - With guards: capped slots excluded or Solcast-reconstructed, so SCADA
    accumulation improves accuracy monotonically even for capped-heavy months
  - Solcast serves a dual role: fallback source AND reconstruction baseline
    for capped slots from both Dashboard and SCADA
```

**Expected outcome:** 1-3% MAPE improvement from cleaner training targets and
error memory, plus elimination of systematic bias from loss-factor uncertainty.
Curtailment guards ensure this improvement holds even during high-cap months
where a naive approach would degrade clear-sky forecast accuracy.

---

## Implementation Order (Recommended)

### Tier 1 — Quick wins (no architectural change)
| Phase | Change | Risk | Effort | Status |
|-------|--------|------|--------|--------|
| 1 | B1: Raise default loss to 3.0% | Low | 1 line | DONE |
| 2 | A1: Raise EST_ACTUAL_WEIGHT_FACTOR to 0.93 | Low | 1 line | DONE |
| 3 | C3: Expose plant-avg loss % from server | Low | ~10 lines | DONE |
| 4 | C1+C1b+C2: Add Est. Substation MWh + rebase Variance to substation | Low | ~20 lines (frontend) | DONE |

### Tier 2 — Forecast quality improvements
| Phase | Change | Risk | Effort | Status |
|-------|--------|------|--------|--------|
| 5 | A2: Est_actual gap-fill in QA | Medium | ~20 lines | DONE |
| 6 | B3: Review per-inverter loss values in ipconfig | Low | Config/data entry | DONE |
| 7 | A3: Est_actual gap-fill in training loader | Medium | ~30 lines | DONE |

### Tier 3 — Substation meter ground truth
| Phase | Change | Risk | Effort | Status |
|-------|--------|------|--------|--------|
| 8 | E1: substation_metered_energy DB table (with audit columns) | Low | ~15 lines | DONE |
| 9 | E2a-c: Auth gate, input validation, manual input UI (admin-gated) | Medium | ~120 lines | DONE |
| 10 | E3: 15-min → 5-min shape-preserving interpolation | Medium | ~40 lines | DONE |
| 11 | E4: Fallback chain (metered → estimated) + recalculate API (with debounce/locking) | Medium | ~80 lines | DONE |
| 12 | E5: Priority chain in QA/training/error-memory consumers | Medium | ~50 lines | DONE |
| 13 | E6: Analytics display (conditional metered row + variance rebase) | Low | ~20 lines | DONE |
| 14 | B2: Billing meter validation (once E1-E2 exist) | Low | Analysis only | PENDING |

### Post-Implementation Deviations and Polish Notes

Phases 1–13 were implemented across v2.5.0–v2.7.5. Below are deviations from
the original blueprint design, plus items that need polish or cleanup:

**UI layout change (C1/E6):** The blueprint specified a two-column Actual MWh row
(Inverter + Substation side-by-side). The final implementation uses a **3×2 grid**
with six separate cards: Inverter MWh, Substation (est.), Subs. Metered MWh,
Day-ahead MWh, Variance MWh, Peak Interval. This provides clearer separation
between estimated and metered data.

**Terminology change:** "SCADA" was renamed to "Substation Metered" / "Metered"
throughout the UI (upload button, modal title, toast messages, card labels).
The blueprint still uses "SCADA Exported Actual" in Part D — this is acceptable
for the internal document but the user-facing label is now "Subs. Metered MWh".

**Time format fix (E2d):** The xlsx parser originally used `dt.toISOString()` which
shifted times to UTC, causing date mismatches for early morning PHT readings.
Fixed to format as local PHT string. This was not anticipated in the blueprint.

**Auth gate removal (E2a):** The blueprint specified `requireSubstationAuth`
middleware (time-based `adsiMM` key) on all substation meter endpoints. This was
implemented but later removed (v2.7.5+) to simplify the upload workflow — the
operator opens the modal and uploads directly without entering a key. The
dashboard's existing login gate (admin/1234) is sufficient for the intended
single-site deployment. The `requireSubstationAuth` function remains in code
and can be re-applied if multi-user access is introduced.

**Remote mode proxy (E4b):** The blueprint did not address remote-mode behavior
for metered data. In remote mode, `POST /api/substation-meter/:date` now mirrors
the save to the gateway via `_proxySubstationMeterToGateway()` so the forecast
engine on the gateway receives metered data. Local save succeeds even if gateway
is unreachable; a `gatewaySynced` field in the response alerts the frontend
to warn the user on sync failure.

**Items needing polish:**
- `_fetchScadaActual()` in app.js is now disconnected from UI cards — it was the
  QA-table lookup path that competed with `_checkMeteredSubstation()`. Can be
  removed or repurposed for QA-sourced display in a future iteration.
- `.analytics-side-grid-4` CSS class exists but is unused — can be cleaned up.
- Phase 14 (B2: billing meter validation) is pending — requires accumulated
  metered data across multiple clear days to perform meaningful comparison.

---

## Part E: Substation Meter Manual Input (Implemented)

### Motivation

Engr. M. manually inputs 15-min MWh data logs from the substation meter
into the dashboard after the solar window closes each day. This provides a
ground-truth reference that can be compared directly against:
- Est. Substation MWh (loss-adjusted inverter data)
- Solcast est_actual (satellite-derived)
- Day-ahead forecast

### Proposed Design

#### E1. Database table for substation meter readings

```sql
CREATE TABLE IF NOT EXISTS substation_metered_energy (
  date         TEXT NOT NULL,           -- YYYY-MM-DD
  ts           INTEGER NOT NULL,        -- epoch ms (15-min interval start)
  mwh          REAL NOT NULL,           -- MWh for this 15-min interval (from SCADA MW-hr column)
  entered_by   TEXT DEFAULT 'admin',    -- username who entered the record
  entered_at   INTEGER DEFAULT (strftime('%s','now')*1000),
  updated_by   TEXT,                    -- username who last updated (NULL if never)
  updated_at   INTEGER,                -- epoch ms of last update (NULL if never)
  PRIMARY KEY (date, ts)
);

-- Daily metadata (sync/desync times, total gen for cross-validation)
CREATE TABLE IF NOT EXISTS substation_meter_daily (
  date            TEXT PRIMARY KEY,      -- YYYY-MM-DD
  sync_time       TEXT,                  -- e.g. "0550H"
  desync_time     TEXT,                  -- e.g. "1746H"
  total_gen_mwhr  REAL,                  -- sum of uploaded MW-hr values
  net_kwh         REAL,                  -- Net (kWh) from SCADA summary row
  deviation_pct   REAL,                  -- |total_gen - net/1000| / (net/1000) × 100
  entered_by      TEXT DEFAULT 'admin',
  entered_at      INTEGER DEFAULT (strftime('%s','now')*1000)
);
```

~48 rows per day for solar window (6AM–6PM). MWh values come directly from the
SCADA MW-hr column — no conversion needed. `substation_meter_daily` stores
per-day metadata for audit and cross-validation against the SCADA Net kWh total.
Audit columns (`entered_by`, `updated_by`, `updated_at`) support traceability
for manual data entry — important since this data overrides estimated values.

#### E2. Input UI & Security

##### E2a. Server-side auth gate

All substation meter endpoints require server-side authentication middleware,
matching the IP Config auth pattern (`adsiM`/`adsiMM` time-based key). Do **not**
rely on client-side-only auth checks.

```
POST /api/substation-meter/:date        — upsert 15-min readings
GET  /api/substation-meter/:date        — retrieve readings for date
POST /api/substation-meter/:date/recalculate — trigger QA/metric recalc
```

Each endpoint checks auth token in request header before processing.

##### E2b. Input validation

Server-side validation on all input:
- **Date format:** Must be `YYYY-MM-DD`, reject future dates (no forecast override)
- **Timestamps:** Must align to 15-min boundaries (epoch ms divisible by 900000)
- **MWh bounds:** `0 ≤ mwh ≤ 5.0` per 15-min interval (plant max ~20 MW × 0.25h = 5.0 MWh). Reject negative or unreasonably large values
- **Row count:** Max 96 intervals per date (24h ÷ 15min). Reject payloads exceeding this
- **Total gen cross-check:** Sum of uploaded MWh vs SCADA Net kWh summary. Warn (not reject) if deviation > 1%

##### E2c. Source format

The substation meter log is a **SCADA-exported xlsx** file ("Data Log Sheet").
One file per day. The relevant sheet is `69kV`. The parser only extracts
energy-related columns — voltage, current, PF, Hz are ignored.

**Columns used:**

| Column | Field | Notes |
|--------|-------|-------|
| A | datetime | 15-min intervals (e.g., `2026-04-03 06:00`) |
| P | MW-hr | **Energy per 15-min interval** — primary input, already computed by SCADA |
| Q | Hourly POV | Hourly subtotal at `:00` marks (cross-check only) |

All other columns (voltage, current, MW, MVAR, PF, Hz) are ignored.

**Summary rows** (after last data row):

| Location | Field | Example |
|----------|-------|---------|
| Col P (total row) | Sum MW-hr | 137.055 |
| Col K (summary row) | Net (kWh) | 137588 |
| Col F (summary row) | Sync Time | 0550H |
| Col H (summary row) | Desync Time | 1746H |

**Example data (April 3, 2026 — `03-042026 Data Log Sheet.xlsx`):**

| Time  | MW-hr (col P) |
|-------|--------------|
| 05:45 | 0.039655     |
| 06:00 | 0.194670     |
| 06:15 | 0.410970     |
| 06:30 | 0.692160     |
| ...   | ...          |
| 16:30 | 1.121155     |
| 16:45 | 0.764260     |
| 17:00 | 0.447020     |
| 17:15 | 0.162225     |
| 17:30 | 0.018025     |
| **Total** | **137.055 MWh** |

MWh values are directly usable — no MW→MWh conversion needed.

##### E2d. Upload and parsing

**Primary method — xlsx upload:**
1. Operator uploads the SCADA Data Log Sheet `.xlsx` file
2. System opens the `69kV` sheet (or first sheet matching the known layout)
3. Parser extracts:
   - **Date** from column A datetime values
   - **MW-hr** from column P for each 15-min row (the energy value)
   - **Sync Time, Desync Time, Net kWh** from the summary rows
4. Parsed result shown in an **editable review table** before saving
5. Sum of MW-hr values cross-checked against Net kWh summary (warn if > 1% deviation)

**Xlsx parsing rules:**
- Identify data rows by: column A contains a datetime value
- Skip rows where MW-hr (col P) is 0 or null (pre-sync / post-desync intervals)
- Summary rows identified by: column P has a numeric value without a corresponding
  datetime in column A, or column K contains a large integer (Net kWh)
- If sheet name `69kV` not found, fall back to first sheet with datetime in column A

**Alternative methods:**

2. **Table form (manual):** Pre-populated table with 15-min solar window slots.
   Operator types MWh values directly. For quick corrections or partial entries
   when the full xlsx is not available.

3. **CSV upload:** Flat file with `time,mwh` columns as fallback:
   ```csv
   time,mwh
   05:45,0.039655
   06:00,0.194670
   06:15,0.410970
   ...
   17:15,0.162225
   17:30,0.018025
   ```
   Rules: `HH:MM` 24h local time, 15-min boundaries, header row required.
   Optional metadata rows: `#sync,0550H` / `#desync,1746H` / `#net_kwh,137588`

All methods display the parsed data in a review table for confirmation before saving.

**UI location:** Analytics page, accessible after selecting a date. A
"Substation Meter" button (admin-gated, hidden for non-admin users) opens
the input form. Auth enforced server-side per E2a.

#### E3. Interpolation to 5-min resolution

The SCADA log provides **MWh per 15-min interval**. The dashboard operates at
**5-min**. Distribute each 15-min MWh across its three 5-min sub-slots:

- **Flat:** Divide equally (`mwh / 3` per slot)
- **Shape-preserving:** Use the inverter 5-min energy profile within each
  15-min window to distribute proportionally, preserving ramp shapes while
  anchoring to the metered magnitude

**Recommended: shape-preserving** — important during sunrise/sunset ramps
where the three 5-min slots within a 15-min window can differ significantly.

**Timezone assumption:** All timestamps use the plant-local timezone (Asia/Manila,
UTC+8). The 15-min interval start times in `substation_metered_energy` must align
with the same epoch-ms convention used by the inverter 5-min data in `energy_5min`.

#### E4. Fallback and Retroactive Input

**Fallback rule:** If substation meter data has not been inputted for a given
date, the system falls back to the dashboard's estimated substation MWh
(loss-adjusted inverter data). This is seamless — no user action required,
no error state, no missing-data warning. The estimated value is always available.

**Retroactive input:** The operator can input real substation meter data for
**any past date**, not just the current day. The date picker in the Analytics
page already allows selecting past dates — the meter input form uses the same
selected date. There is no deadline or lockout period.

**Recalculation on input:** When substation meter data is entered (or updated)
for a date, the system automatically recalculates:

1. **QA comparison** for that date — re-runs `_compare_forecast_qa()` with
   metered substation as the actual source instead of loss-adjusted estimate
2. **Error memory** — if the date was already in error memory, update with
   the metered-based metrics; if it was previously rejected (e.g., data gaps),
   re-evaluate eligibility with the new ground-truth data
3. **Variance MWh** in Analytics — immediately reflects metered value when
   the user views that date
4. **Training data** — next model retrain automatically picks up the metered
   substation values for that date (weight = 1.0, no discount)

Recalculation is triggered server-side via an API call after input:
```
POST /api/substation-meter/:date/recalculate
```
This re-runs QA for the affected date and invalidates any cached metrics.
The retrain happens on the normal schedule (not immediately triggered).

**Rate limiting & locking:** The recalculate endpoint should:
- **Debounce:** If the operator enters data for the same date multiple times in
  quick succession, only the final recalculate runs (debounce window: 5 seconds)
- **Lock:** Prevent concurrent recalculations for the same date (simple in-memory
  lock per date key; reject with 409 Conflict if already running)
- **Async option:** For bulk retroactive input (e.g., entering a week of data),
  recalculate runs synchronously per-date but the endpoint returns immediately
  with a 202 Accepted status, and the UI polls or receives a WS notification
  on completion

#### E5. Priority chain for actual data

The system resolves "actual substation energy" for any date using this chain:

```
1. substation_metered_energy (manual input) — weight 1.0, no discount
2. inverter_loss_adjusted (estimated)  — weight 1.0 (standard training weight)
3. est_actual (Solcast satellite)      — weight 0.93 (EST_ACTUAL_WEIGHT_FACTOR)
```

Each consumer (QA, training, analytics display, error memory) checks for
metered data first, then falls back through the chain. The fallback is
per-slot: if metered data covers only partial solar window (e.g., operator
entered 15 of 40 intervals), the remaining slots fall back to estimated.

#### E6. Analytics display

**Implemented as a 3×2 grid** (deviates from original two-column design):

```
  Inverter MWh        Substation (est.)    Subs. Metered MWh
  24.5679 MWh         23.8123 MWh          23.7500 MWh  ← from uploaded xlsx
  Day-ahead MWh       Variance MWh         Peak Interval
  24.1000 MWh         -0.3500 MWh          4.5678 MWh @ 11:30
```

- **Substation (est.)** always shows the loss-adjusted inverter estimate
- **Subs. Metered MWh** shows uploaded meter data when available, "—" otherwise
- **Variance** uses metered value when available, falls back to estimated
- Values displayed to 4 decimal places

The side-by-side display of Est. Substation and Metered Substation serves as
a **validation metric** for the per-inverter loss calibration — if they
consistently diverge, the loss factors need adjustment.

---

## Resolved Questions

1. **Transformer losses:** The 2.5%-3.6% range **includes** step-up transformer
   losses at the substation — not just cable losses. No separate transformer
   deduction needed.

2. **Est_actual validation:** Engr. M. has personally compared Solcast est_actual
   against the substation billing meter and confirms near-accuracy. Future plan:
   manual input of 15-min substation meter logs into the dashboard for direct
   comparison (see Part E below).

3. **Seasonal variation:** Not necessary — loss factors can remain static.
   Temperature-dependent resistance variation is not significant enough to warrant
   seasonal adjustment for this plant.

4. **Variance basis:** Variance should always be **substation-side vs forecast**,
   computed at **5-min interval resolution**. This means the Analytics Summary
   Variance MWh must use loss-adjusted actual (est. substation), not raw inverter
   total. This aligns with how the forecast engine trains and evaluates.

---

## References

- `forecast_engine.py` — `DEFAULT_INVERTER_LOSS_PCT` (raised to 3.0)
- `forecast_engine.py` — `EST_ACTUAL_WEIGHT_FACTOR` (raised to 0.93)
- `forecast_engine.py` — `plant_capacity_profile()` (loss-adjusted nodes)
- `forecast_engine.py` — `_load_inverter_loss_factors()`
- `forecast_engine.py` — `_query_energy_5min_loss_adjusted()`
- `forecast_engine.py` — Outage recovery with est_actual
- `forecast_engine.py` — Training weight discount
- `forecast_engine.py` — QA est_actual reconstruction
- `public/js/app.js` — Analytics Summary 3×2 grid HTML + `renderAnalyticsSummary()`
- `public/js/app.js` — `_checkMeteredSubstation()` (metered card data pipeline)
- `server/index.js` — `/api/substation-meter/:date` endpoints + xlsx parser
- `server/db.js` — `substation_metered_energy` and `substation_meter_daily` tables
- `public/ip-config.html` — Per-inverter loss configuration UI
