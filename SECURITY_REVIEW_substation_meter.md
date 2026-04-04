# Security Review: Substation Meter Auth Removal & Gateway Proxy

**Date:** 2026-04-05  
**Reviewer:** Claude Code Security  
**Component:** Substation Meter Endpoints (`/api/substation-meter/*`)  
**Files Reviewed:**
- `server/index.js` (lines 12757–13106)
- `public/js/app.js` (lines 14461–14700)
- `services/forecast_engine.py` (lines 3154–3284, 5150–5250)

---

## Executive Summary

**CRITICAL ISSUE FOUND:** Removal of `requireSubstationAuth` middleware creates an **unauthenticated, publicly-writable endpoint** that accepts substation meter data used directly in ML model training. Any attacker on the network can inject arbitrary metered energy readings to poison the forecast model (weight 1.0 in training data), causing systematic forecast errors.

**Risk Level: CRITICAL**  
**Exploitability: TRIVIAL** — Single HTTP POST request, no credentials needed  
**Impact: HIGH** — Forecast poisoning leads to misplaced generation predictions, affecting real-world dispatch decisions

---

## Findings

### 1. **AUTH REMOVAL: Unauthenticated Write Access to Metered Energy (CRITICAL)**

#### Location
- `server/index.js` lines 12757–12931
- Middleware `requireSubstationAuth` defined but **not applied** to any route
- Endpoints:
  - `GET /api/substation-meter/:date` (read)
  - `POST /api/substation-meter/:date` (write — **unauthenticated**)
  - `POST /api/substation-meter/:date/upload-xlsx` (read-only parse, **unauthenticated**)
  - `POST /api/substation-meter/:date/recalculate` (triggers QA, **unauthenticated**)

#### Code Evidence
```javascript
// Line 12757: Middleware defined but not used anywhere
function requireSubstationAuth(req, res, next) {
  const key = String(req.headers["x-substation-key"] || "").trim().toLowerCase();
  if (!key) return res.status(401).json({ ok: false, error: "Authorization required." });
  const m = new Date().getMinutes();
  const valid = [`adsi${m}`, `adsi${String(m).padStart(2, "0")}`];
  const mPrev = (m + 59) % 60;
  valid.push(`adsi${mPrev}`, `adsi${String(mPrev).padStart(2, "0")}`);
  if (!valid.includes(key)) return res.status(403).json({ ok: false, error: "Invalid authorization key." });
  next();
}

// Line 12853: POST endpoint with NO middleware check
app.post("/api/substation-meter/:date", async (req, res) => {
  const dateStr = req.params.date;
  const dateErr = validateSubstationDate(dateStr);
  if (dateErr) return res.status(400).json({ ok: false, error: dateErr });
  const { readings, daily } = req.body || {};
  const readingsErr = validateSubstationReadings(readings);
  // ✗ No auth check before proceeding to write
  // ... proceeds to INSERT/UPSERT into substation_metered_energy
```

#### Attack Scenario
```bash
# Attacker: inject false high-generation data for a past date
curl -X POST http://localhost:3500/api/substation-meter/2026-04-04 \
  -H "Content-Type: application/json" \
  -d '{
    "readings": [
      {"ts": 1712217600000, "mwh": 5.0},
      {"ts": 1712221200000, "mwh": 5.0},
      {"ts": 1712224800000, "mwh": 5.0}
    ],
    "daily": {"sync_time": "0500H", "desync_time": "1800H", "net_kwh": 15000}
  }'

# Result: 3 false readings written to substation_metered_energy
# Next training run includes these false readings at weight 1.0
# Forecast model learns bogus patterns → systematic overestimation
```

#### Why This Is Critical
1. **Direct DB write** — Data persisted to `substation_metered_energy`
2. **Highest training weight** — `resolve_actual_5min_for_date()` prioritizes metered data over inverter estimates and Solcast (see `forecast_engine.py:3223`)
3. **No validation of data source** — No tracking of who/what changed the data
4. **Model poisoning** — Metered data flows directly into training at weight 1.0 (lines 5150–5250 in forecast_engine.py)
5. **No audit trail** — `entered_by` hardcoded to `'admin'` (line 12864), masking unauthorized writes

---

### 2. **INPUT VALIDATION: Weak But Present (MEDIUM)**

#### What Works
- ✓ Date format validation: `SUBSTATION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/` (line 12769)
- ✓ No future dates allowed (line 12780)
- ✓ MWh range capped: 0–5.0 MWh per 15-min interval (line 12770)
- ✓ Max 96 readings per request (line 12771)
- ✓ Timestamp alignment to 15-min boundaries (line 12792)
- ✓ Time field regex sanitization for sync/desync times (line 12877)

#### What Doesn't Help Against Auth Bypass
These validations **cannot prevent model poisoning** if an attacker can submit any valid readings. The constraints are just range limits, not source authentication.

**Example:** Attacker submits readings within valid ranges but for wrong date/time:
```javascript
// All validations pass:
dateStr = "2026-03-15" // valid past date
readings = [
  {ts: 1710446400000, mwh: 4.9},  // within 0-5.0 range, 15-min aligned
  {ts: 1710450000000, mwh: 4.9},  // valid
  // ... repeated for full day
]
// Forecast engine accepts as "metered" source with highest priority
```

---

### 3. **GATEWAY PROXY: URL Validation Insufficient (HIGH)**

#### Location
`server/index.js` lines 12821–12850

#### Code
```javascript
async function _proxySubstationMeterToGateway(dateStr, body) {
  const base = getRemoteGatewayBaseUrl();
  if (!base) return { ok: false, error: "No gateway URL configured." };
  if (isUnsafeRemoteLoop(base)) return { ok: false, error: "Gateway URL cannot be localhost." };
  const target = `${base}/api/substation-meter/${encodeURIComponent(dateStr)}`;
  // ... proxy to gateway with buildRemoteProxyHeaders()
}
```

#### Issues

**3a. Path Traversal via dateStr Not Fully Mitigated**
- ✓ `encodeURIComponent(dateStr)` is used (line 12825)
- ✓ `validateSubstationDate()` restricts to `YYYY-MM-DD` format
- ✓ **Result: Safe from path traversal**

However, the protection relies entirely on client-side validation + date format regex. A direct API call bypassing the UI could try:
```javascript
dateStr = "2026-04-04/../../config" // would encode to "2026-04-04%2F..%2F..%2Fconfig"
```
This is **actually safe** because `validateSubstationDate()` would reject it before reaching the proxy. No path traversal vulnerability found.

**3b. Localhost Loop Check (isUnsafeRemoteLoop)**
- ✓ Blocks `localhost`, `127.0.0.1`, `[::1]`, `::1` (line 3522)
- ✓ Regex: `/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i`
- **Issue: Does NOT block private IP ranges** (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- **Attack:** On a corporate network, attacker configures gateway URL as `http://192.168.1.1:3500` → proxy loops back to itself or reaches internal systems
- **Severity: MEDIUM** — Requires network-level access, but enables SSRF attacks

---

### 4. **AUTHENTICATION TOKENS: Properly Transmitted (INFORMATIONAL)**

#### Location
`server/index.js` lines 5153–5161

#### Code
```javascript
function buildRemoteProxyHeaders(tokenOverride = "") {
  const token = String(tokenOverride || getRemoteApiToken() || "").trim();
  const headers = {};
  if (token) {
    headers["x-inverter-remote-token"] = token;
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
```

#### Assessment
- ✓ Remote gateway token correctly included in proxy requests
- ✓ Used in `_proxySubstationMeterToGateway()` via `buildRemoteProxyHeaders()`
- ✓ Token validated on gateway side (not verified in this review, but architecture is correct)
- **Note:** This does NOT protect the **unauthenticated local endpoint** (`POST /api/substation-meter/:date`)

---

### 5. **NO GLOBAL EXPRESS AUTHENTICATION (CRITICAL FINDING)**

#### Location
`server/index.js` lines 118–150

#### Analysis
```javascript
const app = express();
expressWs(app);
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
app.use(cors({...}));
app.use(express.json({ limit: "50mb" }));
app.use((err, req, res, next) => {...});
// NO global auth middleware applied
```

**Finding:** There is **no session auth, no JWT validation, no API key check** at the Express layer. All authentication is per-endpoint.

**Impact:** Since `requireSubstationAuth` middleware was removed from substation meter routes, those endpoints are now **completely open to any HTTP client on the network**.

**Comparison to other endpoints:**
- Replication endpoints (`/api/replication/*`) have `requireSubstationAuth` applied? **NO** — they check mode directly
- IP config (`/api/ip-config`) has `requireSubstationAuth`? **NO** — checks mode and proxies
- Chat messages (`/api/chat/*`) have auth? **Likely NO** — not reviewed

**Conclusion:** The entire Express app assumes local network isolation. No endpoint requires authentication except topology operations that use time-based auth.

---

### 6. **AUDIT TRAIL: Hardcoded Admin User (HIGH)**

#### Location
`server/index.js` lines 12864, 12867

#### Code
```javascript
const upsert = db.prepare(`
  INSERT INTO substation_metered_energy (date, ts, mwh, entered_by, entered_at)
  VALUES (?, ?, ?, 'admin', ?)  // <-- 'admin' hardcoded
  ON CONFLICT(date, ts) DO UPDATE SET
    mwh = excluded.mwh,
    updated_by = 'admin',        // <-- 'admin' hardcoded
    updated_at = ?
`);
```

#### Issue
- ✗ All metered data inserts attributed to `'admin'` regardless of source
- ✗ No user/session tracking
- ✗ Makes it impossible to audit who uploaded which data
- ✗ Enables insider threats to hide malicious uploads

#### Severity
**HIGH** — Obfuscates the origin of data poisoning attacks

---

### 7. **FRONTEND AUTH REMOVAL: No Client-Side Gate (MEDIUM)**

#### Location
`public/js/app.js` lines 14461–14700

#### Evidence
```javascript
function openSubstationMeterModal() {
  const modal = $("substationMeterModal");
  if (!modal) return;
  const dateStr = String($("anaDate")?.value || "").trim();
  // No auth check before opening modal or allowing uploads
  
  // ... later:
  const r = await fetch(`/api/substation-meter/${dateStr}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },  // No auth header sent
    body: JSON.stringify({
      readings: SubstationMeter.parsedReadings,
      daily: SubstationMeter.parsedDaily,
    }),
  });
}
```

#### Issue
- ✗ No `x-substation-key` header sent in fetch requests (previously removed)
- ✗ No session token validation
- ✗ Any user on the local network can call the API directly

---

### 8. **MODEL TRAINING DATA FLOW CONFIRMATION (CRITICAL CONTEXT)**

#### Verified Path: Substation Data → Training
```
1. POST /api/substation-meter/:date accepts readings
   ↓
2. INSERT INTO substation_metered_energy (line 12862)
   ↓
3. resolve_actual_5min_for_date(day) — forecast_engine.py:3220
   ├─ Step 1: _query_substation_metered_15min(day) — line 3243
   ├─ If metered_15min exists, interpolate to 5-min — line 3245
   └─ Set actual[metered_present] = metered_5min, source='metered' — lines 3249–3251
   ↓
4. Training data build — forecast_engine.py:5154
   ├─ actual, actual_present, source = resolve_actual_5min_for_date(day)
   └─ actual_effective = actual (no downweighting for metered source) — line 5239
   ↓
5. Model.fit() with actual_effective at weight 1.0
   ├─ weight = 1.0 for all data in training loop
   └─ No per-source confidence adjustment
```

**Confirmation:** Metered substation data **directly poisons the LightGBM model** with no confidence penalty.

---

## Summary of Vulnerabilities

| # | Issue | Severity | Attack Vector | Impact |
|---|-------|----------|---|---------|
| 1 | Auth removal from substation endpoints | CRITICAL | Network POST to `/api/substation-meter/:date` | Model poisoning, forecast errors |
| 2 | No global Express auth | CRITICAL | Direct HTTP to any endpoint | Lateral movement, data theft |
| 3 | Private IP ranges not blocked in proxy | MEDIUM | Configure gateway URL to internal IP | SSRF to internal systems |
| 4 | Hardcoded 'admin' audit trail | HIGH | Mask source of malicious uploads | Hide attack evidence |
| 5 | No input validation on data sanity | MEDIUM | Submit readings inconsistent with weather | Undetected model poisoning |
| 6 | No rate limiting | MEDIUM | Rapid file uploads (10MB xlsx) | DoS via resource exhaustion |
| 7 | Frontend auth removal | MEDIUM | Direct API calls bypass UI | Any network client can write |

---

## Recommendations

### IMMEDIATE (CRITICAL)
1. **Re-enable substation auth on all write endpoints:**
   ```javascript
   // server/index.js
   app.post("/api/substation-meter/:date", requireSubstationAuth, async (req, res) => {
     // ... existing code
   });
   app.post("/api/substation-meter/:date/upload-xlsx", requireSubstationAuth, express.raw(...), async (req, res) => {
     // ... existing code
   });
   app.post("/api/substation-meter/:date/recalculate", requireSubstationAuth, (req, res) => {
     // ... existing code
   });
   ```

2. **Track audit trail of who changed data:**
   ```javascript
   // Extract user/session from request (add session auth first)
   const enteredBy = req.user?.username || "system";
   const upsert = db.prepare(`
     INSERT INTO substation_metered_energy (date, ts, mwh, entered_by, entered_at)
     VALUES (?, ?, ?, ?, ?)
   `);
   // ... run with enteredBy from request
   ```

3. **Extend auth to upload endpoint:**
   ```javascript
   app.post("/api/substation-meter/:date/upload-xlsx", 
     requireSubstationAuth,
     express.raw({ type: "application/octet-stream", limit: "10mb" }),
     async (req, res) => {...}
   );
   ```

### SHORT-TERM (HIGH)
4. **Add sanity checks before accepting metered data:**
   ```python
   # forecast_engine.py
   def _validate_metered_readings(day: str, metered_5min: dict) -> bool:
       """Reject metered data that conflicts with physical constraints."""
       # Check if metered total matches weather regime baseline ±25%
       # Check if metered has implausible spikes or dips
       # Require explanation/signature for >15% variance from Solcast
       return is_plausible
   
   def resolve_actual_5min_for_date(day: str):
       # ... after step 1:
       if metered_15min:
           if not _validate_metered_readings(day, metered_15min):
               log.warning("Metered data rejected for %s (failed sanity check)", day)
               metered_15min = None  # Fall back to inverter data
   ```

5. **Add confidence weighting for metered source:**
   ```python
   # Downweight metered data with lower confidence than inverter data
   if source == "metered":
       sample_weight *= 0.9  # 90% confidence in metered vs 100% for inverter
   ```

6. **Expand SSRF protection to block private IP ranges:**
   ```javascript
   function isUnsafeRemoteLoop(baseUrl) {
     const unsafe = /^https?:\/\/(localhost|127\.0\.0\.1|::1|\[::1\])(:\d+)?$/i;
     const private = /^https?:\/\/(10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[01]\.|192\.168\.)(.*)/i;
     return unsafe.test(baseUrl) || private.test(baseUrl);
   }
   ```

### MEDIUM-TERM
7. **Implement session-based auth for entire Express app:**
   - Add JWT or session tokens to `/api/login`
   - Apply global middleware to verify auth on all protected routes
   - Store session info including user, IP, timestamp

8. **Add rate limiting to file upload endpoints:**
   ```javascript
   const rateLimitXlsx = rateLimit({
     windowMs: 60 * 1000,  // 1 minute
     max: 5,               // 5 requests per minute
     message: "Too many file uploads"
   });
   app.post("/api/substation-meter/:date/upload-xlsx", rateLimitXlsx, ...);
   ```

9. **Add versioning and approval workflow:**
   - Store all metered readings with version/timestamp
   - Require approval before data is used in training
   - Maintain changelog of modifications

10. **Monitor for anomalous metered data:**
    ```python
    # forecast_engine.py
    def _detect_metered_anomalies(day: str, metered_5min: dict) -> list:
        """Flag suspicious metered readings."""
        anomalies = []
        # Check for unrealistic generation spikes
        # Check for inconsistency with inverter data
        # Check for repeating patterns (copy-paste attacks)
        return anomalies
    ```

---

## Testing Checklist

- [ ] Attempt unauthenticated POST to `/api/substation-meter/2026-04-03` — should return **401**
- [ ] Attempt authenticated POST with invalid key — should return **403**
- [ ] Attempt authenticated POST with valid time-based key — should return **201**
- [ ] Verify uploaded readings appear in database under correct date
- [ ] Verify audit trail shows actual user/session, not hardcoded 'admin'
- [ ] Verify gateway proxy rejects private IP range URLs
- [ ] Monitor next forecast training run — verify metered data is included or safely rejected
- [ ] Check Excel parser for XXE/zip bomb attacks (ExcelJS library scan)

---

## Cleanup

The middleware function `requireSubstationAuth` (line 12757) is now dead code. Once auth is re-enabled on routes, keep it for reference. If not re-enabled, remove to reduce confusion.

---

## References

- **OWASP:** Broken Access Control (A1/2021), Injection (A3/2021)
- **CWE-434:** Unrestricted Upload of Dangerous File Type (though data, not files)
- **CWE-863:** Incorrect Authorization
- **CVSS v3.1 Score (Issue #1):** 9.1 (Critical) — Network/Low complexity/Low privilege/High impact on integrity
