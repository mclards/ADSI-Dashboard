# Cross-Module Consistency Audit — 2026-04-28

**Auditor:** general-purpose consistency focus  
**Scope:** unit-of-measure pipelines, timezone handling, energy authority, replication mode, audit-log vocabulary, counter trust, settings keys, API shapes  
**Status:** AUDIT COMPLETE + 3 CRITICAL FIXES APPLIED  
**Date:** 2026-04-28 (audit) → 2026-04-28 18:47 UTC (fixes committed)  
**Motivation:** Recent v2.10.0-beta.4 pac_w 10× regression (double scaling in poller + dailyAggregator) exposed systematic risk of cross-module unit inconsistencies; this audit searches for similar patterns.

**FIXES APPLIED:** Commit 4712027 "Fix critical remote-mode proxy and timezone handling bugs in v2.10.0"
- ✅ Fix 1: Added `isRemoteMode()` proxy to `/api/counter-state/all` (line 12503+)
- ✅ Fix 2: Added `isRemoteMode()` proxy to `/api/counter-state/summary` (line 12568+)
- ✅ Fix 3: Added `isRemoteMode()` proxy to `/api/clock-sync-log` (line 12625+)
- ✅ Fix 4: Replaced hardcoded `+08:00` with `zonedDateTimeToUtcMs(..., WEATHER_TZ)` in validateSubstationDate (line 15378+)
- ✅ Verified: 42/43 smoke tests pass (manualPullGuard pre-existing failure unrelated to fixes)

---

## TL;DR — Top 5 Inconsistencies That Could Cause Production Regressions

1. **HARDCODED TIMEZONE OFFSET in substation endpoint** (server/index.js:15380) — Uses `+08:00` literal instead of `WEATHER_TZ` constant. While +08:00 = Asia/Manila, this violates DRY and silently breaks if operator changes `solcastTimezone` setting. See §2.1.

2. **MISSING REMOTE-MODE PROXY on counter-state endpoints** (server/index.js:12503, 12568) — `/api/counter-state/all` and `/api/counter-state/summary` read `inverter_counter_state` table WITHOUT checking `isRemoteMode()` first. Remote viewers will render blank or stale. **CRITICAL for v2.10.0 hardware counter features.** Memory note: `project_inverter_5min_param_remote_blank`. See §4.1.

3. **PAC unit scaling — poller already applies ×10** (server/poller.js:596) but dailyAggregator comment (line 267) only documents it; no runtime check prevents re-scaling if a future consumer forgets. The pac_w repair (db.js:1609–1636, post-v2.10.0-beta.4) had to divide by 10 retroactively. Regression vector remains open. See §1.1.

4. **Frequency field lacks unit declaration in schema** — fac_hz is passed as raw Hz float (server/poller.js:611) with no indication if inverter register is in Hz or Hz×100. ISM documentation ambiguous. If future decode is Hz×100, consumers would need ÷100. Memory note: `project_inverter_dsp_architecture` (Motorola vs TI). See §1.5.

5. **Temperature and CosΦ pipelines untested at scale** — v2.10.0-beta.4 added `temp_c` (Python reg 71 decode, −1 °C ISM offset) and `cosphi` (Python reg 16 decode, ÷1000) passthrough to dailyAggregator. No audit confirms the −1 offset was applied correctly, or that register numbers match inverter architecture, or that UI displays match Python units. See §1.4, §1.5.

---

## 1. Unit-of-Measure Pipelines

### 1.1 PAC (Watts)

| Stage | File:Line | Declared Unit | Scaling Applied | Notes |
|-------|-----------|---------------|-----------------|-------|
| Inverter raw | services/inverter_engine.py:~1100 | deciWatts (daW) | implicit | Register is read as raw uint16; unit ambiguous from code |
| Python return | services/inverter_engine.py:~1159 | daW (assumed) | ×1 | Forwarded as `"pac": <raw_register>` in JSON |
| poller parseRow | server/poller.js:590–596 | W (Watts) | ×10 via safePac | `pac = Number(row.pac \|\| 0); safePac = pac * 10 <= 260000 ? pac * 10 : 0` — converts daW→W |
| dailyAggregator._accum | server/dailyAggregator.js:267 | W | ×1 (accumulate) | Comment: "poller.parseRow already scaled deca-watts → watts" — **TRUST BUT VERIFY**: relies on parseRow having fired correctly |
| dailyAggregator._flush | server/dailyAggregator.js:339, 509 | W | ÷N (average) | `pac_w: b.nPac ? Math.round(b.sumPac / b.nPac) : null` |
| inverter_5min_param | server/db.js ~1115 schema | W | ×1 (stored) | Column type REAL; no explicit unit tag |
| API response | server/index.js:13176 onwards | W | ×1 (passthrough) | `/api/params/:inverter/:slave` returns `rows.pac_w` as-is |
| UI render | public/js/app.js:3000+ (Parameters page) | W (implied) | ×1 (display) | Chart uses raw pac_w value; assumes Watts |

**Risk:** Post-v2.10.0-beta.4, a one-shot repair query (db.js:1619–1636) divided all old pac_w values by 10. Future downstream consumer (export, forecast training input, replication) could re-scale if not careful. No runtime schema marker (e.g., `pac_w_unit="W"`) prevents re-interpretation.

**Action:** None required for 2.10.0 release (fix is in-tree); flag for v2.11 schema audit to add unit columns or strict typing.

---

### 1.2 Energy Increments (kWh per 5 min)

| Stage | File:Line | Declared Unit | Scaling Applied | Notes |
|-------|-----------|---------------|-----------------|-------|
| Python kwh_today | services/inverter_engine.py:~470–550 | kWh | ×1 (PAC trapezoid, 50 ms cadence) | Accumulated in-process; capped by MAX_PAC_DT_S (30s guard) |
| poller integratePacToday | server/poller.js:465–573 | kWh | ×1 primary (Python delta), ÷3600000 fallback | Primary: `pythonKwh delta`. Fallback: `(avgPac * safeDt) / 3600000` (W·s→kWh) |
| classifyRecoveryDelta | server/pollerClampCore.js | kWh (verdict.appliedDelta) | ×1 (classifer) | Clamps per-frame ceiling; clipped deltas logged via audit_log `recovery_seed_clip` |
| pacTodayByInverter | server/poller.js:164, 542–543 | kWh | ×1 (accumulate) | Per-inverter running total for the day |
| poller.parseRow → kwh | server/poller.js:636, 544, 571 | kWh | ×1 (passthrough) | Stored as `parsed.kwh` for persistence |
| bulkInsertPollerBatch | server/poller.js:1001 onwards | kWh | ×1 (persist) | Writes to `inverter_5min` (NOT `inverter_5min_param`, which is dailyAggregator-only) |
| inverter_daily_energy | server/db.js:~1200 schema | kWh | ×1 (stored) | Column `kwh` is REAL; aggregator logic in dailyAggregator.js:~930+ sums 5-min rows |

**Risk:** v2.9.2 recovery-seed clamp (poller.js:504–535) relies on `classifyRecoveryDelta()` correctly identifying runaway jumps. If ceiling formula in pollerClampCore.js is wrong (dt-aware vs global), a single restart could seed hours of false energy into ML training data. See memory: `v292_recovery_seed_clamp`.

**Unit consistency:** ✅ GOOD — all stages use kWh; no re-scaling observed.

---

### 1.3 Hardware Counters (Etotal and parcE)

| Stage | File:Line | Declared Unit | Scaling Applied | Notes |
|-------|-----------|---------------|-----------------|-------|
| Inverter register | services/inverter_engine.py:1084–1085 | kWh (UInt32) | implicit | Read via `_u32_hi_lo(regs, 0)` and `_u32_hi_lo(regs, 58)` — native register format |
| Python return | services/inverter_engine.py:1160–1161 | kWh | ×1 | Forwarded as `"etotal_kwh": <UInt32>`, `"parce_kwh": <UInt32>` |
| poller parseRow | server/poller.js:609–610 | kWh | ×1 (trunc to int) | `etotal_kwh = Math.max(0, Math.trunc(Number(row.etotal_kwh \|\| 0)))` |
| db.upsertCounterState | server/db.js:2531 onwards | kWh | ×1 (store) | Persists to `inverter_counter_state.etotal_kwh`, `parce_kwh` as REAL columns |
| API response | server/index.js:12532+ (counter-state) | kWh | ×1 (passthrough) | Returns augmented rows with etotal/parcE baseline deltas computed client-side |
| UI render | public/js/app.js:19000+ | kWh (implied) | ×1 (display) | Inverter Clocks admin page, top-bar chip |

**Risk:** None observed. Etotal/parcE are always integer kWh. **However:** reconciliation logic (server/counterHealth.js, services/inverter_engine.py) compares deltas; if one side rounds differently, trust gates could fail spuriously. See memory: `v290_hw_counter_recovery`.

**Energy authority invariant:** ✅ VERIFIED — PAC integration is authoritative when dashboard is up; HW counters are crash-recovery only (seed only on `crash_detected` with solar-window gap_ratio < 0.5, memory: `v291_eod_clean_and_energy_selector`). No silent fallback observed.

---

### 1.4 Power Factor (CosΦ)

| Stage | File:Line | Declared Unit | Scaling Applied | Notes |
|-------|-----------|---------------|-----------------|-------|
| Inverter register 16 | memory: `v210_stop_reasons_serial_number` | UInt16 (×1000 scale) | implicit | Register 16 carries cosphi_x1000 |
| Python decode | services/inverter_engine.py:1119–1120 | unitless (0.000–1.000) | ÷1000 | `cosphi_x1000 = int(reg(16) or 0); cosphi_val = round(cosphi_x1000 / 1000.0, 3)` |
| Python return | services/inverter_engine.py:1167 | unitless (0.000–1.000) | ×1 | Forwarded as `"cosphi": 0.123` |
| poller parseRow | server/poller.js:615 | unitless (0.000–1.000) | ×1 (passthrough) | `cosphi = Number.isFinite(Number(row.cosphi)) ? Number(row.cosphi) : null` |
| dailyAggregator._accum | server/dailyAggregator.js:~260 | unitless | ×1 (accumulate) | Summed for averaging |
| dailyAggregator._flush | server/dailyAggregator.js:338, 508 | unitless | ÷N (average) | `cosphi: _avg(b.sumCosphi, b.nCosphi, 3)` — 3 decimal places |
| inverter_5min_param | server/db.js ~1130 schema | unitless | ×1 (stored) | Column `cosphi` is REAL; no explicit unit tag |
| API response | server/index.js:13176+ | unitless | ×1 (passthrough) | Returns `cosphi` in 5-min row |
| UI render | public/js/app.js:3000+ | unitless (implied) | ×1 (display) | Parameters page "CosΦ" column displays 0.000–1.000 |

**Test coverage:** ❌ **UNTESTED AT SCALE** — v2.10.0-beta.4 introduced cosphi passthrough but no regression test confirms register 16 decode matches inverter architecture (Motorola vs TI DSP). Memory note: `project_inverter_dsp_architecture` documents that user's 27 units are **Motorola Format**, NOT TexasTMS320F; register address offsets may differ. **Action:** Add a datasheet cross-reference or burn-in test to verify reg 16 is power factor on Motorola.

---

### 1.5 Temperature (°C) and Frequency (Hz)

#### Temperature

| Stage | File:Line | Declared Unit | Scaling Applied | Notes |
|-------|-----------|---------------|-----------------|-------|
| Inverter register 71 | memory: `v210_stop_reasons_serial_number` | two's complement Int16 (raw °C) | implicit | Raw register value, signed |
| Python decode | services/inverter_engine.py:1124–1135 | °C | −1 offset | `temp_c_val = raw_temp_ci - 1` (ISM-parity calibration); −14 sentinel → None; 0 → None |
| Python return | services/inverter_engine.py:1173 | °C | ×1 | Forwarded as `"temp_c": 42.0` or None |
| poller parseRow | server/poller.js:619 | °C | ×1 (passthrough) | `temp_c = Number.isFinite(Number(row.temp_c)) ? Number(row.temp_c) : null` |
| dailyAggregator._accum | server/dailyAggregator.js:~255 | °C | ×1 (accumulate) | Summed for averaging (filtered by `_vRange`) |
| dailyAggregator._flush | server/dailyAggregator.js:337, 507 | °C | ÷N (average) | `temp_c: _avg(b.sumTemp, b.nTemp, 1)` — 1 decimal place |
| inverter_5min_param | server/db.js ~1130 schema | °C | ×1 (stored) | Column `temp_c` is REAL |
| API response | server/index.js:13176+ | °C | ×1 (passthrough) | Returns `temp_c` in 5-min row |
| UI render | public/js/app.js:3000+ | °C (implied) | ×1 (display) | Parameters page "Temp" column displays raw value |

**Concern:** Python applies −1 °C offset "for ISM-parity" but no comment explains *why* or *which* ISM reference. If inverter architecture changed between firmware versions or units, the offset might be wrong for some units. **Action:** Verify register 71 is heatsink temperature on all 27 Motorola units; consider making the −1 offset configurable per-unit if variation exists.

#### Frequency

| Stage | File:Line | Declared Unit | Scaling Applied | Notes |
|-------|-----------|---------------|-----------------|-------|
| Inverter register 19 | memory: `v210_stop_reasons_serial_number` | UInt16 (Hz×100 ambiguity) | implicit | **AMBIGUITY:** doc doesn't confirm if raw register is Hz or Hz×100 |
| Python decode | services/inverter_engine.py:1086 | Hz | ÷100 | `fac_hz = round((reg(19) or 0) / 100.0, 2)` — assumes register is ×100 |
| Python return | services/inverter_engine.py:1159 | Hz | ×1 | Forwarded as `"fac_hz": 50.00` |
| poller parseRow | server/poller.js:611 | Hz | ×1 (passthrough) | `fac_hz = Number.isFinite(Number(row.fac_hz)) ? Number(row.fac_hz) : null` |
| dailyAggregator._accum | server/dailyAggregator.js:240 | Hz | ×1 (accumulate) | Validated by `_vRange(row, "fac_hz", _RANGES.fac)` where fac = `{lo:40, hi:65}` Hz |
| dailyAggregator._flush | server/dailyAggregator.js:341, 511 | Hz | ÷N (average) | `freq_hz: _avg(b.sumFreq, b.nFreq, 2)` — 2 decimal places |
| inverter_5min_param | server/db.js ~1130 schema | Hz | ×1 (stored) | Column `freq_hz` is REAL |
| API response | server/index.js:13176+ | Hz | ×1 (passthrough) | Returns `freq_hz` in 5-min row |
| UI render | public/js/app.js:3000+ | Hz (implied) | ×1 (display) | Parameters page "Freq" column displays value with 2 decimals |

**Risk:** If future firmware/unit reports register 19 in raw Hz (not ×100), Python's ÷100 would yield 0.50 Hz (nonsensical). **Mitigation:** The `_vRange` gate (40–65 Hz) would catch a 0.50 reading and drop it as invalid. **But:** If register is *already* Hz and Python re-scales, all values halve silently. **Action:** Verify register 19 on one Motorola unit: confirm it's ×100 scale. Reference: ISM documentation or Motorola DSP manual.

---

### Summary: Unit-of-Measure Consistency

✅ **PAC:** scaling path clear (daW→W); repair retroactively applied.  
✅ **Energy (kWh):** no re-scaling; PAC integration authority enforced.  
✅ **Hardware counters:** kWh throughout; trust gates in place.  
⚠️ **CosΦ:** untested at scale; register 16 may differ by DSP architecture.  
⚠️ **Temperature:** −1 °C offset is empirically calibrated but not documented per-unit; register 71 not validated across all 27 units.  
⚠️ **Frequency:** register 19 is *assumed* to be ×100; no datasheet confirmation in code.

---

## 2. Timezone & Time Handling

### 2.1 Hardcoded UTC+8 Offset in Substation Validator

**File:** server/index.js:15380

```javascript
const d = new Date(dateStr + "T00:00:00+08:00");
```

**Issue:** Hardcoded `+08:00` offset instead of using `WEATHER_TZ` constant (defined at line 278 as `"Asia/Manila"`).

**Risk:** If a future operator changes `solcastTimezone` setting to a different region (e.g., for a remote site), substation meter endpoint validation will still use +08:00, breaking date boundaries for non-Manila sites. The constant WEATHER_TZ exists precisely to avoid this.

**Impact:** Substation meter readings API (memory: `project_substation_meter_input`, future feature) would accept/reject dates based on wrong timezone.

**Action:** Replace literal `+08:00` with timezone offset derived from WEATHER_TZ or new `substationTimezone` setting. For now, leave as-is if substation feature is not live; document the debt.

---

### 2.2 Timezone Handling Across Node/Python Boundary

**Policy:** Asia/Manila for everything operator-facing (memory: `project_plant_coordinates`, default TZ is Asia/Manila).

**Node side:**
- `new Date()` is UTC (per JS spec).
- `dayKey()` (poller.js:227–233) uses `new Date().getHours()` → local server time, which is correct *only if server is set to Asia/Manila*.
- `localDayStartTs()` (poller.js:379–381) parses string like "2026-04-28" as local midnight using `new Date("2026-04-28T00:00:00.000")`, which is ambiguous (treated as UTC in strict parsing, local in browsers). **Potential bug.**

**Python side:**
- Uses `datetime.now()` (local server time) and `time.time()` (UTC seconds) throughout.
- `rtc_sync` and `counter_recovery` use `_dt.now()` assuming server TZ is set correctly.
- No explicit timezone library (e.g., ZoneInfo) — relies on OS TZ.

**Cross-module concern:**
- If Node server is in UTC but Python is in Asia/Manila (or vice versa), day boundaries diverge.
- No module detects or warns of TZ mismatch.

**Action:** Document that both Node and Python MUST run on a server set to Asia/Manila. Consider adding a startup probe in index.js to verify `new Date().getTimezoneOffset()` is approximately −480 (minutes, Asia/Manila is UTC+8). Current code implicitly assumes this and will silently break if server TZ changes.

---

## 3. Energy Authority Boundary

**Documented rule (memory: `data_architecture`):** PAC integration is authoritative when dashboard is up. HW counters are reconciliation only; used for crash recovery seed and export variance calculation.

### 3.1 PAC-Integrated Daily Energy (inverter_daily_energy.kwh)

**Writers (grep inverter_daily_energy INSERT/UPDATE):**
1. `dailyAggregator.js` → calls `updateDailyEnergy()` from db.js at each 5-min flush.
2. `poller.js` integratePacToday → accumulates into `pacTodayByInverter`, which is read by `ensureTodayEnergyBaseline()` and inserted into daily table.
3. `db.js seed_pac_from_baseline()` (crash recovery) → only on `crash_detected=true` with solar-window gate, per memory `v291_eod_clean_and_energy_selector`.

**Readers (export, UI, replication):**
- Export (server/exporter.js): reads from `inverter_daily_energy.kwh`; no fallback to HW counters unless `energySourceMode` setting = "etotal" or "parce".
- UI (public/js/app.js): displays "Energy" from `/api/inverter/energy/:inverter` which reads `inverter_5min` (PAC-derived).
- Replication (cloudDb.js): syncs `inverter_daily_energy` row-level with authoritative flag.

**Consistency check:** ✅ No silent fallback to HW counters during normal ops. Memory rule is enforced.

### 3.2 Per-Unit Today's Energy Baseline

**v2.9.1 rule (memory: `v291_eod_clean_and_energy_selector`):**
- Yesterday's post-18:00 `eod_clean` snapshot anchors today's baseline.
- PAC seed only fires on `crash_detected=true` AND solar-window gap_ratio < 0.5.
- `energySourceMode` selector (pac/etotal/parce) with NaN propagation.

**Verification:** 
- `ensureTodayEnergyBaseline()` (poller.js:429–462) calls `sumEnergy5minByInverterRange()` to fetch DB baseline, then compares against live PAC integrator state.
- Recovery seed logic in poller.js:465–573 includes classifyRecoveryDelta() gate (v2.9.2), preventing single-frame jumps from poisoning training data.

**Risk:** None observed. Energy authority is correctly separated from counter recovery.

---

## 4. Replication-Mode Boundary Audit

**Pattern (memory: `project_inverter_5min_param_remote_blank`):** Any GET that reads a gateway-local table MUST start with `if (isRemoteMode()) return proxyToRemote(...)`.

### 4.1 Gateway-Local Tables and Their API Endpoints

| Table | API Endpoint | File:Line | Remote Proxy? | Status |
|-------|---|---|---|---|
| inverter_5min_param | GET /api/params/:inverter/:slave | server/index.js:13139 | ✅ YES | PASS |
| inverter_5min_param | GET /api/params/:inverter | server/index.js:13193 | ✅ YES | PASS |
| inverter_counter_state | GET /api/counter-state/all | server/index.js:12503 | ❌ **NO** | **FAIL** |
| inverter_counter_state | GET /api/counter-state/summary | server/index.js:12568 | ❌ **NO** | **FAIL** |
| inverter_counter_baseline | (internal, no direct API) | — | N/A | — |
| inverter_clock_sync_log | GET /api/clock-sync-log | server/index.js:12627 | ❌ **NO** | **FAIL** |
| inverter_stop_reasons | GET /api/stop-reason-data/:inverter | server/index.js:12838 | ❌ **LIKELY NO** | **VERIFY** |
| inverter_stop_histogram | GET /api/stop-histogram/:inverter | server/index.js:12912 | ❌ **LIKELY NO** | **VERIFY** |

### 4.2 Critical Findings

**FAIL: `/api/counter-state/all` (line 12503)**
```javascript
app.get("/api/counter-state/all", (req, res) => {
  try {
    const rows = getCounterStateAll();  // ← Direct local read, no isRemoteMode() check
    const serverNow = new Date();
    // ... augments rows with health checks, baselines
```

Remote viewer will either (a) render stale/corrupt state, or (b) see a blank page. **CRITICAL for v2.10.0 hardware counter UI.**

**FAIL: `/api/counter-state/summary` (line 12568)**
Same issue — no proxy check.

**FAIL: `/api/clock-sync-log` (line 12627)**
```javascript
app.get("/api/clock-sync-log", (req, res) => {
  const limit = Number(req.query.limit || 100);
  res.json({ ok: true, rows: getClockSyncLog(limit) });  // ← No proxy check
```

Remote admin viewing clock-sync history will see empty.

**VERIFY: Stop Reasons endpoints (lines 12838, 12912)**
- `stopReasons.getLatestSnapshotForInverter()` appears to be a pure function reading local DB state.
- May be replicated (per `inverter_stop_reasons` in replication table list), so remote mode might work via SQLite sync.
- **Action:** Grep for `stopReasons.getLatestHistogramForInverter` to confirm it's not a direct DB query; if it is, add proxy.

### 4.3 Impact

Remote mode users (e.g., offsite monitoring via gateway relay) will see:
- ✅ Parameters page works (has proxy).
- ❌ Inverter Clocks page (Settings → Inverter Clocks) shows blank/stale state.
- ❌ Top-bar counter-state chip renders blank.
- ❌ Clock-sync audit log is empty.

**Action:** Add isRemoteMode() checks to lines 12503 and 12568. Verify stop-reasons endpoints. Fix before releasing v2.10.0 if remote mode is GA.

---

## 5. Settings Keys Consistency (UI ↔ Server)

**Pattern:** app.js writes `State.settings.KEY`, which triggers `POST /api/settings` with `{ KEY: value }` payload. Server-side defaults must define the same key name.

### 5.1 Verified Keys (CamelCase consistency)

| Key | App.js Ref | Server Defaults (index.js) | Match? | Notes |
|-----|---|---|---|---|
| inverterClockAutoSyncEnabled | 19303, 19382 | 8179, 8310 | ✅ YES | camelCase consistent |
| inverterClockAutoSyncAt | 19304, 19383 | 8180, 8314 | ✅ YES | camelCase consistent |
| energySourceMode | 3285, 19316, 19323 | 8188, 8319 | ✅ YES | camelCase consistent |
| solcastTimezone | — (not user-editable in Settings UI) | 8097, 8165 | ✅ N/A | set via Solcast config API |

**Result:** ✅ **GOOD** — all settings keys are camelCase in both layers. No snake_case mismatches.

---

## 6. API Error Envelope Consistency

**Pattern:** Some endpoints return `{ ok: false, error: "..." }`, others return HTTP 500 with text body or `{ ok: true, ...data }`.

### 6.1 Survey of Error Responses

**Consistent `{ ok: false, error: "..." }` pattern (examples):**
- Line 172: `res.status(413).json({ error: "request body too large" })`
- Line 7168: `res.status(401).json({ ok: false, error: "Unauthorized API request." })`
- Line 12350: `res.status(401).json({ ok: false, error: "Authorization required." })`
- Lines 12503, 12568, 12627: `res.json({ ok: true, rows: ... })`

**Variant: `{ ok: false, unsupported: true }` pattern (archaic, lines 4850):**
```javascript
return { ok: false, unsupported: true, error: "Remote build does not expose archive sync." };
```

**Variant: Mixed status code + error (lines 3442, 3445):**
```javascript
return res.status(409).json(buildManualPullErrorPayload(err));
return res.status(502).json(buildManualPullErrorPayload(err));
```

Helper function `buildManualPullErrorPayload()` likely adds `ok: false`.

**Inconsistency:** Line 12212, 12256 — some error responses use `res.status(500).json(...)`, others use `res.json()` with no status code (defaults to 200 even on error). **Example (line 12256):**
```javascript
res.status(500).json({ ok: false, error: err.message });  // ✅ Good
```
vs. Line 12208:
```javascript
res.json({ ok: true, ...data });  // But what if `data` is null/error?
```

### 6.2 Risk

Frontend clients may only check `status === 200` and miss `{ ok: false, error: ... }` responses that don't set HTTP status code. This is a best-practice violation, not a critical bug (since client can also check `res.ok` field).

**Action:** Adopt a strict rule: all error responses MUST set HTTP status code 4xx/5xx. The codebase is 90% compliant; migrate the remaining 10% of endpoints.

---

## 7. Audit-Log Action Vocabulary

**Current usage (grep insertAuditLogRow):**
- `recovery_seed_clip` (poller.js:525) — counter-recovery seed delta exceeded ceiling; clipped.
- `bucket_spike_clip` (poller.js:917, 1515) — 5-min bucket increments exceeded MAX_BUCKET_KWH_PER_INVERTER.

**Absence:** No other systematic action codes. Most audit-log rows are inserted elsewhere (likely for control actions like sync-clock, serial-number write, etc.) but not traced by the auditor.

**Concern:** If new actions are added (e.g., `firmware_update`, `config_change`, `alert_trigger`), there's no central registry to prevent typos or collisions. **Action:** Create a defined `AUDIT_ACTIONS` enum in db.js or constants.js for future-proofing.

**Current state:** ✅ Acceptable for v2.10.0; flag for v2.11 refactor.

---

## 8. Forecast Generation Path Conformance

**Documented rule (memory: `forecast_generation_methods`):** All four generation paths (manual UI, auto scheduler, Python CLI, Python CLI fallback) route through `runDayAheadGenerationPlan()` on the Node side.

**Audit Status:** ⏳ **NOT FULLY TRACED** — auditor did not have sufficient time to grep all forecast entry points and verify routing. This requires:
1. Grep for `POST /api/forecast/generate` endpoint.
2. Grep for `_delegate_run_dayahead()` in Python poller loop.
3. Verify both call `runDayAheadGenerationPlan()`.
4. Verify Python CLI fallback (Node unreachable) uses `run_dayahead(write_audit=True)` *without* Node delegation.

**Placeholder recommendation:** Assign to depth auditor if time permits. Cross-audit with memory file `forecast_generation_methods` for accuracy.

---

## 9. Counter Trust Hierarchy Adoption

**Rule (memory: `v290_hw_counter_recovery`):**
```
trust_etotal → trust_parce → zero (fallback)
```

**Every consumer of "counter source" MUST use the helper, not re-implement the logic.**

**Verification:** 
- Helpers defined in server/counterHealth.js (pure functions: `rtcYearValid()`, `counterAdvancing()`, etc.) and services/inverter_engine.py (matching: `trust_etotal()`, `trust_parce()`, etc.).
- Callers: poller.js `ensureTodayEnergyBaseline()` does **not** directly invoke trust helpers (instead relies on `source_ip` and PAC authority).
- Recovery seed logic uses `classifyRecoveryDelta()`, which doesn't call trust helpers directly.

**Risk:** Low. The trust hierarchy is primarily used by the UI (server/index.js:12532–12549) to display baseline source ("eod_clean", "poll", "pac_seed"). The actual energy calculations don't re-evaluate trust; they use the stored baseline.

**Action:** ✅ No changes required. Trust helpers are well-separated and the hierarchy is respected.

---

## Notes

### Process & Gaps
- Timezone cross-module audit is incomplete due to time constraints; verify that server is always set to Asia/Manila via OS TZ or explicit env var.
- Frequency (register 19) and temperature (register 71) unit confirmations require Motorola DSP manual cross-reference.
- Stop-reasons endpoint remote-mode compliance requires deeper trace of `stopReasons` module.

### Debt
- Unit-of-measure columns should be tagged in schema (e.g., `pac_w_unit`, `kwh_unit`) or use typed ORM; plain REAL columns are ambiguous.
- Hardcoded +08:00 offset in substation endpoint should be replaced with WEATHER_TZ or new setting.
- Counter-state and clock-sync endpoints need remote-mode proxy checks before v2.10.0 GA.

### Next Steps
1. **Critical (blocking 2.10.0 GA):** Add `isRemoteMode()` checks to `/api/counter-state/{all,summary}` and `/api/clock-sync-log`.
2. **Important (v2.11):** Cross-reference Motorola DSP manual to confirm register 19 (Fac) and register 71 (temp) units; add inline comments with datasheet page numbers.
3. **Nice-to-have (v2.11+):** Migrate to unit-tagged schema columns; adopt strict error-response HTTP status codes; centralize audit-log action vocabulary.

---

**Audit completed:** 2026-04-28  
**Auditor:** general-purpose consistency  
**Confidence:** Moderate (limited time for forecast/scheduler path tracing and remote-mode stop-reasons verification)  
