# Security Remediation Guide: Substation Meter Auth Restoration

**Status:** REMEDIATION REQUIRED  
**Priority:** CRITICAL  
**Affected Component:** Substation Meter Endpoints  
**Files to Modify:**
- `server/index.js` (add middleware to 3 routes)
- `public/js/app.js` (restore auth header in fetch calls)
- `services/forecast_engine.py` (optional: add validation layer)

---

## Issue Summary

The `requireSubstationAuth` middleware was removed from the substation meter endpoints, creating an unauthenticated write path to data used in ML model training. This allows any network client to poison forecast predictions.

---

## REMEDIATION #1: Restore Auth Middleware to Routes

### File: `server/index.js`

**Current State (VULNERABLE):**
```javascript
// Line 12853: NO AUTH REQUIRED
app.post("/api/substation-meter/:date", async (req, res) => {
  // ... write to database without authorization
});

// Line 12934: NO AUTH REQUIRED
app.post("/api/substation-meter/:date/upload-xlsx", express.raw(...), async (req, res) => {
  // ... parse user-supplied file without authorization
});

// Line 13095: NO AUTH REQUIRED
app.post("/api/substation-meter/:date/recalculate", (req, res) => {
  // ... trigger expensive QA computation without authorization
});
```

**Fixed State:**
```javascript
// Line 12853: ADD MIDDLEWARE
app.post("/api/substation-meter/:date", requireSubstationAuth, async (req, res) => {
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });
  const { readings, daily } = req.body || {};
  const readingsErr = validateSubstationReadings(readings);
  if (readingsErr) return res.status(400).json({ ok: false, error: readingsErr });
  try {
    // ... rest of code unchanged
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Line 12934: ADD MIDDLEWARE
app.post("/api/substation-meter/:date/upload-xlsx", 
  requireSubstationAuth,  // <-- ADD THIS LINE
  express.raw({ type: "application/octet-stream", limit: "10mb" }), 
  async (req, res) => {
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });
  try {
    // ... rest of code unchanged
  } catch (e) {
    console.error("[substation-meter] xlsx parse error:", e.message);
    res.status(400).json({ ok: false, error: `Failed to parse xlsx: ${e.message}` });
  }
});

// Line 13095: ADD MIDDLEWARE
app.post("/api/substation-meter/:date/recalculate", 
  requireSubstationAuth,  // <-- ADD THIS LINE
  (req, res) => {
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });

  if (_substationRecalcLocks.has(dateStr)) {
    return res.status(409).json({ ok: false, error: "Recalculation already in progress for this date." });
  }

  _triggerSubstationRecalc(dateStr);
  res.status(202).json({ ok: true, message: `QA recalculation for ${dateStr} scheduled (5s debounce).` });
});
```

**Commit Message:**
```
Restore auth middleware to substation meter endpoints

The requireSubstationAuth middleware was removed from all substation meter
routes (POST /api/substation-meter/:date, POST /api/substation-meter/:date/upload-xlsx,
and POST /api/substation-meter/:date/recalculate), creating an unauthenticated
write path to metered energy data used directly in ML model training.

This change re-applies the time-based auth middleware (adsiMM pattern) to
all three write endpoints. GET requests remain unauthenticated as they are
read-only.

Security Impact: Prevents unauthorized model poisoning via metered data injection.
```

---

## REMEDIATION #2: Restore Auth Header in Frontend

### File: `public/js/app.js`

**Current State (VULNERABLE):**
```javascript
// Line 14573: No auth header sent
const r = await fetch(`/api/substation-meter/${dateStr}/upload-xlsx`, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body: buf,
});

// Line 14627: No auth header sent
const r = await fetch(`/api/substation-meter/${dateStr}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    readings: SubstationMeter.parsedReadings,
    daily: SubstationMeter.parsedDaily,
  }),
});
```

**Fixed State:**
```javascript
// Around line 14573: ADD AUTH HEADER
const r = await fetch(`/api/substation-meter/${dateStr}/upload-xlsx`, {
  method: "POST",
  headers: { 
    "Content-Type": "application/octet-stream",
    "x-substation-key": getSubstationAuthKey(),  // <-- ADD THIS
  },
  body: buf,
});

// Around line 14627: ADD AUTH HEADER
const r = await fetch(`/api/substation-meter/${dateStr}`, {
  method: "POST",
  headers: { 
    "Content-Type": "application/json",
    "x-substation-key": getSubstationAuthKey(),  // <-- ADD THIS
  },
  body: JSON.stringify({
    readings: SubstationMeter.parsedReadings,
    daily: SubstationMeter.parsedDaily,
  }),
});
```

**Helper Function to Add:**
```javascript
// Add this function near other auth helpers (around line 14450)
function getSubstationAuthKey() {
  // Generate time-based key adsiMM (where MM = current minute ±1)
  const m = new Date().getMinutes();
  const key = `adsi${String(m).padStart(2, "0")}`;
  return key;
}
```

**Commit Message:**
```
Restore x-substation-key auth header to substation meter API calls

Re-add the x-substation-key header to fetch requests for:
- POST /api/substation-meter/:date/upload-xlsx
- POST /api/substation-meter/:date (upsert readings)

The header value is a time-based key (adsiMM pattern) generated client-side
and validated by requireSubstationAuth middleware on the server.

Security Impact: Enables auth validation for metered data uploads.
```

---

## REMEDIATION #3: Improve Audit Trail (RECOMMENDED)

### File: `server/index.js`

**Current State (WEAK):**
```javascript
// Lines 12864, 12867: Hardcoded 'admin' user
const upsert = db.prepare(`
  INSERT INTO substation_metered_energy (date, ts, mwh, entered_by, entered_at)
  VALUES (?, ?, ?, 'admin', ?)  // <-- Always 'admin'
  ON CONFLICT(date, ts) DO UPDATE SET
    mwh = excluded.mwh,
    updated_by = 'admin',       // <-- Always 'admin'
    updated_at = ?
`);
```

**Improved State (requires session auth - future enhancement):**
```javascript
// Future: Once session auth is implemented
// For now, add IP address and timestamp
const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
const enteredBy = `api_${clientIp}_${new Date().toISOString()}`; // Temporary tracking

const upsert = db.prepare(`
  INSERT INTO substation_metered_energy (date, ts, mwh, entered_by, entered_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(date, ts) DO UPDATE SET
    mwh = excluded.mwh,
    updated_by = ?,
    updated_at = ?
`);

const now = Date.now();
const tx = db.transaction(() => {
  for (const r of readings) {
    upsert.run(dateStr, r.ts, r.mwh, enteredBy, now);  // <-- Use enteredBy variable
  }
  // ... rest of transaction
});
```

**Better State (when session auth is added):**
```javascript
// After implementing session-based auth on the entire app:
// Extract from req.session or req.user
const enteredBy = req.session?.userId || req.user?.username || 'unknown';

const upsert = db.prepare(`
  INSERT INTO substation_metered_energy (date, ts, mwh, entered_by, entered_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(date, ts) DO UPDATE SET
    mwh = excluded.mwh,
    updated_by = ?,
    updated_at = ?
`);

const now = Date.now();
const tx = db.transaction(() => {
  for (const r of readings) {
    upsert.run(dateStr, r.ts, r.mwh, enteredBy, now);
  }
  // ... rest of transaction
});
```

---

## REMEDIATION #4: Add Sanity Validation (OPTIONAL)

### File: `services/forecast_engine.py`

**Add validation layer before accepting metered data:**

```python
# Around line 3220, after resolve_actual_5min_for_date definition

def _validate_metered_plausibility(day: str, metered_5min: dict) -> dict:
    """Check if metered readings are physically plausible.
    
    Returns {
        'valid': bool,
        'reason': str,
        'confidence': float (0.0-1.0)
    }
    """
    if not metered_5min:
        return {'valid': False, 'reason': 'empty', 'confidence': 0.0}
    
    try:
        # Convert metered data to array for analysis
        metered_arr = np.zeros(SLOTS_DAY, dtype=float)
        for ts_ms, kwh in metered_5min.items():
            # Convert epoch ms to slot index
            day_start_ms = int(datetime.strptime(day, "%Y-%m-%d")
                               .replace(hour=0, minute=0, second=0, microsecond=0)
                               .timestamp() * 1000)
            slot_idx = int((ts_ms - day_start_ms) // (5 * 60 * 1000))
            if 0 <= slot_idx < SLOTS_DAY and kwh >= 0:
                metered_arr[slot_idx] = kwh
        
        # Check 1: Total generation should be within plant physics envelope
        total_metered_kwh = float(np.sum(metered_arr[SOLAR_START_SLOT:SOLAR_END_SLOT]))
        if total_metered_kwh < 0:
            return {
                'valid': False,
                'reason': 'negative_total',
                'confidence': 0.0
            }
        
        # Check 2: Peak single interval should not exceed plant peak capacity
        peak_5min = float(np.max(metered_arr))
        plant_peak_kwh = 5000  # Example: 20 MW × 15 min / 3 slots
        if peak_5min > plant_peak_kwh:
            return {
                'valid': False,
                'reason': f'peak_exceeds_plant_limit ({peak_5min} > {plant_peak_kwh})',
                'confidence': 0.0
            }
        
        # Check 3: Compare against Solcast forecast for consistency
        snapshot = load_solcast_snapshot(day)
        if snapshot:
            solcast_kwh = np.asarray(snapshot.get('forecast_kwh', np.zeros(SLOTS_DAY)), dtype=float)
            solar_mask = np.zeros(SLOTS_DAY, dtype=bool)
            solar_mask[SOLAR_START_SLOT:SOLAR_END_SLOT] = True
            
            metered_solar = metered_arr[solar_mask]
            solcast_solar = solcast_kwh[solar_mask]
            
            # Calculate deviation from Solcast baseline
            if np.any(solcast_solar > 0):
                ratio = np.sum(metered_solar) / np.sum(solcast_solar)
                deviation_pct = abs(ratio - 1.0) * 100
                
                # Allow ±30% deviation, flag higher
                if deviation_pct > 30:
                    log.warning(
                        "Metered data for %s deviates %.1f%% from Solcast (ratio=%.3f)",
                        day, deviation_pct, ratio
                    )
                    # Return with lower confidence
                    return {
                        'valid': True,
                        'reason': f'deviation_from_solcast_{deviation_pct:.1f}%',
                        'confidence': max(0.5, 1.0 - (deviation_pct / 100.0))
                    }
        
        # All checks passed
        return {
            'valid': True,
            'reason': 'plausible',
            'confidence': 1.0
        }
    
    except Exception as e:
        log.error("Metered validation error for %s: %s", day, e)
        return {
            'valid': False,
            'reason': f'validation_exception: {str(e)[:50]}',
            'confidence': 0.0
        }


def resolve_actual_5min_for_date(day: str) -> tuple[np.ndarray, np.ndarray, str]:
    """E4 fallback chain: resolve best-available actual energy for a date.

    Priority: metered substation → loss-adjusted inverter → Solcast est_actual.
    Per-slot: if metered covers partial solar window, remaining slots fall back.

    Returns (actual_kwh[288], present_mask[288], source_label)
    where source_label is 'metered', 'estimated', or 'mixed'.
    """
    actual = np.zeros(SLOTS_DAY, dtype=float)
    present = np.zeros(SLOTS_DAY, dtype=bool)
    source = "estimated"

    # ... existing code for day bounds ...
    d_dt = datetime.strptime(day, "%Y-%m-%d")
    day_start_ms = int(
        d_dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
    )
    day_end_ms = day_start_ms + 86400 * 1000
    loss_factors = _load_inverter_loss_factors()
    inv_5min = _query_energy_5min_loss_adjusted(APP_DB_FILE, day_start_ms, day_end_ms, loss_factors)

    # Step 1: Check for metered substation data
    metered_15min = _query_substation_metered_15min(day)
    
    # NEW: Validate metered data before accepting
    if metered_15min:
        validation = _validate_metered_plausibility(day, metered_15min)
        if not validation['valid']:
            log.warning(
                "Metered data for %s rejected: %s",
                day, validation['reason']
            )
            metered_15min = None  # Fall through to inverter data
        elif validation['confidence'] < 1.0:
            log.info(
                "Metered data for %s accepted with reduced confidence (%.0f%%): %s",
                day, validation['confidence'] * 100, validation['reason']
            )
            # Could downweight in training: see REMEDIATION #5
    
    if metered_15min:
        metered_5min = interpolate_15min_to_5min(metered_15min, inv_5min)
        metered_present = metered_5min > 0
        if np.any(metered_present):
            actual[metered_present] = metered_5min[metered_present]
            present[metered_present] = True
            source = "metered"

    # ... rest of function unchanged ...
    if not np.all(present[SOLAR_START_SLOT:SOLAR_END_SLOT]):
        for ts_ms, kwh in inv_5min.items():
            local_ms = ts_ms + 8 * 3600 * 1000
            day_ms = local_ms % (86400 * 1000)
            slot_idx = int(day_ms // (SLOT_MIN * 60 * 1000))
            if 0 <= slot_idx < SLOTS_DAY and not present[slot_idx] and kwh > 0:
                actual[slot_idx] = kwh
                present[slot_idx] = True

        if source == "metered" and not np.all(present[SOLAR_START_SLOT:SOLAR_END_SLOT]):
            source = "mixed"

    if not np.all(present[SOLAR_START_SLOT:SOLAR_END_SLOT]):
        snap = load_solcast_snapshot(day)
        if snap:
            est_kwh = np.asarray(
                snap.get("est_actual_kwh", np.zeros(SLOTS_DAY)), dtype=float
            )
            solar_mask = np.zeros(SLOTS_DAY, dtype=bool)
            solar_mask[SOLAR_START_SLOT:SOLAR_END_SLOT] = True
            fill_mask = (~present) & solar_mask & (est_kwh > 0) & np.isfinite(est_kwh)
            if np.any(fill_mask):
                actual[fill_mask] = est_kwh[fill_mask]
                present[fill_mask] = True
                if source == "estimated":
                    source = "estimated"
                else:
                    source = "mixed"

    return actual, present, source
```

---

## REMEDIATION #5: Add Confidence Weighting (OPTIONAL)

### File: `services/forecast_engine.py`

**When training, downweight data from lower-confidence sources:**

```python
# Around line 5220 in train_lightgbm_model_v2()

def _get_source_weight_multiplier(source: str, validation_confidence: float = 1.0) -> float:
    """Return training weight multiplier based on data source."""
    base_weights = {
        'metered': 1.0,      # Highest trust (if validated)
        'mixed': 0.95,       # Mixed metered + inverter
        'estimated': 0.85,   # Loss-adjusted inverter data
    }
    base = base_weights.get(source, 0.85)
    
    # Apply validation confidence
    return base * validation_confidence


# In the training loop, modify sample weighting:
for days_ago in range(1, lookback_days + 1):
    day = (today - timedelta(days=days_ago)).isoformat()
    actual, actual_present, actual_source = resolve_actual_5min_for_date(day)
    
    # ... validation code (see REMEDIATION #4) ...
    validation = _validate_metered_plausibility(day, metered_15min) if actual_source == 'metered' else {'confidence': 1.0}
    
    # ... existing feature/baseline/prior code ...
    
    # Apply source-weighted sample weight
    days_weight = _sample_weight_for_days_ago(days_ago)
    source_weight = _get_source_weight_multiplier(actual_source, validation['confidence'])
    final_weight = days_weight * source_weight
    
    # Use final_weight in model.fit()
```

---

## Testing Plan

### Test 1: Verify Auth is Required
```bash
# Should FAIL with 401 (no key)
curl -X POST http://localhost:3500/api/substation-meter/2026-04-04 \
  -H "Content-Type: application/json" \
  -d '{"readings": []}'

# Should FAIL with 403 (wrong key)
curl -X POST http://localhost:3500/api/substation-meter/2026-04-04 \
  -H "Content-Type: application/json" \
  -H "x-substation-key: invalid123" \
  -d '{"readings": []}'

# Should SUCCEED with 400 (auth passes, validation fails on empty readings)
curl -X POST http://localhost:3500/api/substation-meter/2026-04-04 \
  -H "Content-Type: application/json" \
  -H "x-substation-key: adsi$(date +%M)" \
  -d '{"readings": []}'
```

### Test 2: Verify Frontend Auth Header
Open browser DevTools → Network tab → Upload a file → Check request headers include `x-substation-key`

### Test 3: Verify Audit Trail
```sql
SELECT entered_by, date, COUNT(*) as count 
FROM substation_metered_energy 
GROUP BY entered_by, date 
LIMIT 10;
```
Should show meaningful `entered_by` values instead of always 'admin'

### Test 4: Verify Validation (after REMEDIATION #4)
```python
# In Python shell
from services.forecast_engine import _validate_metered_plausibility
result = _validate_metered_plausibility('2026-04-04', {1712233200000: 1000})  # Unrealistic spike
print(result)  # Should show {'valid': False, 'reason': 'peak_exceeds_plant_limit', ...}
```

---

## Rollback Plan

If remediation causes unexpected issues:

1. **Temporary disable auth (NOT RECOMMENDED):**
   ```javascript
   // Comment out middleware requirement temporarily
   app.post("/api/substation-meter/:date", /* requireSubstationAuth, */ async (req, res) => {
   ```

2. **Restore from git:**
   ```bash
   git checkout HEAD~1 -- server/index.js public/js/app.js
   ```

3. **Verify reversion:**
   ```bash
   grep -n "requireSubstationAuth" server/index.js
   # Should return only line 12757 (definition)
   ```

---

## Deployment Checklist

- [ ] Both remediation #1 and #2 are implemented together
- [ ] All three write endpoints have `requireSubstationAuth` middleware
- [ ] Frontend sends `x-substation-key` header in all POST requests
- [ ] Time-based key generation works correctly (test with multiple time offsets)
- [ ] Audit trail shows meaningful `entered_by` values (or implement session auth)
- [ ] Unit tests pass: `npm test` in server/tests/
- [ ] Smoke test passes: manual upload via UI
- [ ] No existing metered data is lost (read-only operation for GET)
- [ ] Next forecast generation completes without errors
- [ ] Monitoring alerts are configured for auth failures

---

## References

- **Previous auth pattern:** `requireSubstationAuth` (line 12757) uses time-based keys `adsiMM`
- **Time-based auth concept:** Same as `isBulkControlAuthValid()` (server/bulkControlAuth.js)
- **Frontend patterns:** See existing auth headers in `_checkMeteredSubstation()` fetch call
- **Database impact:** No schema changes required; only adds auth gate, not data modifications
