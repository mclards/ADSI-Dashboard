# Slice ε — Standard-Modbus Stop-Reason Cross-Check Implementation Plan

| Field | Value |
|---|---|
| Date | 2026-05-10 |
| Status | DRAFT — for tdd-guide handoff |
| Parent plan | [plans/2026-05-10-modbus-registers-official-revamp.md](2026-05-10-modbus-registers-official-revamp.md) §4 Slice ε |
| Risk | MED |
| Estimate | 10–16 hours |
| Depends on | Slice β (committed 313c48f) — `read_slow_async()` + stop-reason register map documented |

---

## §1 Scope & non-goals

### In scope
- **On-demand read** of 31 standard-Modbus input registers (30078–30108) from the Stop Reasons admin page
- **5-slot ring buffer** with pointer reg 30078 (slot index 0–4)
- **Motive code lookup** for all 30 documented INGECON stop reasons (MOTIVO_PARO_VIN through MOTIVO_PARO_FRAMA2)
- **Cross-check logic** comparing standard-Modbus slot timestamps + motive codes against the existing vendor SCOPE DebugDesc + MotParo
- **UI render** side-by-side in Stop Reasons admin page, marking mismatches in red
- **New database table** `inverter_stop_reasons_std` to persist the reads
- **Remote-mode proxy** per existing memory rule

### NOT in scope
- **Replacement** of the vendor SCOPE peek path (Slice B continues unchanged)
- **Feature flag gating** (reads happen unconditionally when admin clicks refresh)
- **Automatic polling** (on-demand only; saves bandwidth)
- **Reactive power / grid-code functionality** (Slice ζ)

---

## §2 Architecture decision: on-demand vs. auto-poll

### Decision: On-demand only

**Justification:**
1. **Bandwidth:** Standard-Modbus read (31 regs × 2 bytes + overhead) ≈ 70 bytes per transaction. Auto-polling every 30 s across 27 inverters × 4 slaves = ~10 kB/s. Vendor SCOPE already provides the authoritative event data; standard-Modbus cross-check is validation, not operational necessity.
2. **User value:** Operator clicks "Refresh" on Stop Reasons admin page → Node invokes the standard-Modbus read → JS renders side-by-side comparison. Fast feedback, minimal latency (< 1 s per inverter).
3. **Simplicity:** No new Python background loop; existing stop-reason refresh handler is the triggering point.
4. **Precedent:** Slice γ (authoritative inverter state) reads reg 30074 on every poll because state informs run/stop display. Standard-Modbus stop reasons are *supplemental* validation — vendor SCOPE is the source of truth for historical events.

**Trade-off:** If operator suspects SCOPE data corruption, they manually refresh to validate. Acceptable given the rare-event nature of stop reasons.

---

## §3 Wire-format specification

### Register layout: 30078–30108 (31 regs total, address 77–107 in zero-based indexing)

Per [docs/IngeconSunPMax-Modbus-pg07.txt](../docs/IngeconSunPMax-Modbus-pg07.txt) and pg08.txt:

| Reg Index | Modbus Addr | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 30078 | Pos. Last Stop Reason | UInt16 | Pointer 0–4 → most recent slot index |
| 1–6 | 30079–30084 | Slot 0: Year, Month, Day, Hour, Min, MotCode | 6×UInt16 | Timestamp + motive code |
| 7–12 | 30085–30090 | Slot 1 (same layout) | 6×UInt16 | " |
| 13–18 | 30091–30096 | Slot 2 (same layout) | 6×UInt16 | " |
| 19–24 | 30097–30102 | Slot 3 (same layout) | 6×UInt16 | " |
| 25–30 | 30103–30108 | Slot 4 (same layout) | 6×UInt16 | " |

**Single transaction:** `read_input_registers(addr=77, count=31, slave=slave_id)` (zero-based addr 77 = reg 30078 since input registers start at 30001 = addr 0)

**Timestamp fields per slot:**
- Year (UInt16): likely 2-digit year + 2000 offset; verify against PDF + live captures
- Month (UInt16): 1–12
- Day (UInt16): 1–31
- Hour (UInt16): 0–23
- Minute (UInt16): 0–59
- MotCode (Int16 signed): codes 1–30 documented; 0 = "no recorded reason" (empty slot); negative values are **not expected** but handled safely

---

## §4 Motive code lookup table (canonical source of truth)

### Full 30-entry mapping

Per [docs/IngeconSunPMax-Modbus-pg07.txt](../docs/IngeconSunPMax-Modbus-pg07.txt) + [pg08.txt](../docs/IngeconSunPMax-Modbus-pg08.txt), extracted byte-for-byte:

| Code | PDF Symbol | PDF English | Notes |
|---|---|---|---|
| 0 | (none) | No fault / empty slot | Recorded when no stop event has occurred |
| 1 | MOTIVO_PARO_VIN | Input voltage very high | DC overvoltage |
| 2 | MOTIVO_PARO_FRED | Grid frequency out of range | AC frequency deviation |
| 3 | MOTIVO_PARO_VRED | Grid voltage out of range | AC voltage deviation |
| 4 | MOTIVO_PARO_VARISTORES | Failure in protection varistors | Hardware protection trip |
| 5 | MOTIVO_PARO_AISL_DC | Isolation failure in solar field | Ground fault detection |
| 6 | MOTIVO_PARO_IAC_EFICAZ | RMS output current higher than limit | Overcurrent (RMS) |
| 7 | MOTIVO_PARO_TEMPERATURA | Stop because of high temperature | Thermal shutdown |
| 8 | MOTIVO_PARO_LATENCIA_SPI | Communication error in SPI bus | Internal DSP communication fault |
| 9 | MOTIVO_PARO_CONFIGURACION | Stop because of configuration change | Parameter update triggered shutdown |
| 10 | MOTIVO_PARO_PARO_MANUAL | Manual stop inverter | Operator shutdown |
| 11 | MOTIVO_PARO_BAJA_VPV_MED | Stop due to low voltage in solar field | DC undervoltage |
| 12 | MOTIVO_PARO_HW_DESCX2 | Hardware error (NOT IN USE) | Deprecated / unused |
| 13 | MOTIVO_PARO_FRAMA3 | Failure in branch 3 | Power electronics branch 3 fault |
| 14 | MOTIVO_PARO_MAX_IAC_INST | Instantaneous output current higher | Overcurrent (instantaneous) |
| 15 | MOTIVO_PARO_CARGA_FIRMWARE | Stop by firmware load | Firmware update in progress |
| 16 | MOTIVO_PARO_REDUNDANTE | Error from redundant DSP | Redundancy DSP mismatch |
| 17 | MOTIVO_PARO_PROTECCION_PIB | Error in PIB protection (multistring only) | Multistring protection activation |
| 18 | MOTIVO_PARO_ERROR_LEC_ADC | Internal error in ADC | Analog-to-digital converter fault |
| 19 | MOTIVO_PARO_CONSUMO_POTENCIA | Stop due to power consumption | Parasitic load trigger |
| 20 | MOTIVO_PARO_FUS_DC | DC fuses melt | DC fuse blown |
| 21 | MOTIVO_PARO_TEMP_AUX | Error in temperature auxiliary protection | Auxiliary temperature threshold exceeded |
| 22 | MOTIVO_PARO_PROT_AC | Failure in AC controller | AC control circuit fault |
| 23 | MOTIVO_PARO_MAGNETO | Trigger from thermomagnetic protection | AC disconnect (mechanical) |
| 24 | MOTIVO_PARO_CONTACTOR | Error in grid connection contactor | Grid contactor stuck / sensing error |
| 25 | MOTIVO_PARO_RESET_WD | Reset WD from DSP | Watchdog timer reset |
| 26 | MOTIVO_PARO_PI_ANA_SAT | Saturation in current control | Current PI loop saturation |
| 27 | MOTIVO_PARO_LATENCIA_ADC | Latent error in ADC | ADC latency / timing fault |
| 28 | MOTIVO_PARO_ERROR_FATAL | Fatal error from power electronics | Critical PE fault (unrecoverable) |
| 29 | MOTIVO_PARO_FRAMA1 | Failure in branch 1 | Power electronics branch 1 fault |
| 30 | MOTIVO_PARO_FRAMA2 | Failure in branch 2 | Power electronics branch 2 fault |

**Canonical location:** New file [server/motiveLabelsStd.js](../server/motiveLabelsStd.js) (Node consumes directly). Python embeds an equivalent dict inline in `services/inverter_engine.py`'s `_get_motive_label()` for self-containedness — both must stay in sync; the JS file is human-readable canonical.

---

## §5 Database schema

### New table: inverter_stop_reasons_std

[server/db.js](../server/db.js) — insert after the existing `inverter_stop_histogram` table:

```sql
CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  inverter_id     INTEGER NOT NULL,
  inverter_ip     TEXT NOT NULL,
  slave           INTEGER NOT NULL,
  slot            INTEGER NOT NULL,           -- 0–4 ring-buffer slot
  timestamp_iso   TEXT NOT NULL,              -- ISO 8601 (UTC) reconstructed from y/m/d/h/m
  motive_code     INTEGER NOT NULL,           -- 0–30 per motive lookup table
  motive_name     TEXT,                       -- MOTIVO_PARO_* symbol for display
  read_at_ms      INTEGER NOT NULL,           -- wall-clock when read() was invoked
  captured_at_ms  INTEGER,                    -- event datetime → ms (for sorting)
  source          TEXT NOT NULL DEFAULT 'standard_modbus',
  updated_ts      INTEGER NOT NULL
                  DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  UNIQUE(inverter_ip, slave, slot, timestamp_iso, motive_code)
);
CREATE INDEX IF NOT EXISTS idx_iss_lookup ON inverter_stop_reasons_std(inverter_ip, slave, read_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_iss_slot ON inverter_stop_reasons_std(inverter_ip, slave, slot);
```

**Rationale:**
- **UNIQUE on (ip, slave, slot, timestamp_iso, motive_code):** prevents duplicate captures on repeated refresh; slot is volatile (ring buffer), so timestamp is the stable key
- **timestamp_iso:** reconstructed from y/m/d/h/m registers; enables client sorting + comparison against vendor SCOPE event_at_ms
- **captured_at_ms:** for efficient index scans by time
- **source:** future-proof for additional cross-check sources

### Migration logic (idempotent ensureColumn pattern)

```javascript
ensureColumn(db, "inverter_stop_reasons_std", "motive_name", "TEXT");
ensureColumn(db, "inverter_stop_reasons_std", "captured_at_ms", "INTEGER");
ensureColumn(db, "inverter_stop_reasons_std", "source", "TEXT NOT NULL DEFAULT 'standard_modbus'");
```

---

## §6 Python read function

### New function: `read_standard_stop_reasons()`

[services/inverter_engine.py](../services/inverter_engine.py) — insert after `read_slow_async()`:

```python
async def read_standard_stop_reasons(client, slave, ip):
    """
    Read 31 input registers (30078–30108) — standard-Modbus stop-reason ring buffer.

    Returns a dict:
      {
        "inverter_ip": str,
        "slave": int,
        "read_at_ms": int,
        "pointer": int,         # 0..4, slot index of most recent event
        "slots": [ {slot, pointer_points_here, timestamp_iso, motive_code, motive_name, raw} × 5 ]
      }

    Triggered on-demand from Node via the /stop-reasons/standard FastAPI route.
    Per-IP lock mirrors Slice β (read_slow_async) to avoid concurrent reads.

    Offline marker: year=0 → timestamp_iso="offline", motive_code=-1.

    Wire format (Slice ε spec §3):
      read_input_registers(addr=77, count=31, slave=slave)
      Pointer at reg 30078 → most recent slot (0–4)
      5 slots of 6 regs each: [year, month, day, hour, minute, motive_code]

    Related plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice ε
    """
    # Implementation per planner spec §6.
```

Plus a helper `_get_motive_label(code)` returning the 30-entry name lookup.

**Key decisions:**
- **On-demand trigger:** Node calls this via FastAPI route (see §7)
- **Per-IP lock:** Prevents concurrent reads on the same inverter (matches Slice β pattern)
- **Year-byte handling:** Assume 2-digit year + 2000 offset; clamp month/day/hour/minute to valid ranges; fall back to `"invalid(YYYY-MM-DDTHH:MM)"` ISO-shaped string for out-of-range datetimes
- **Offline marker:** `year=0` → empty slot; timestamp_iso="offline", code=-1
- **Sort order:** chronological descending; offline slots last

---

## §7 Node persistence and endpoint

### Internal POST handler — Node persists to `inverter_stop_reasons_std`

[server/index.js](../server/index.js) — add **localhost-only** internal endpoint:

```javascript
app.post("/api/stop-reasons/internal/standard-save", (req, res) => {
  const remoteIp = req.ip || req.socket.remoteAddress || "";
  const isLoopback = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
  if (!isLoopback) return res.status(403).json({ ok: false, error: "forbidden" });

  const payload = req.body;
  if (!payload?.inverter_ip || payload.slave === undefined || !Array.isArray(payload.slots)) {
    return res.status(400).json({ ok: false, error: "invalid payload" });
  }

  // Upsert per slot (skip offline / invalid)
  // Returns { ok, inverter_ip, slave, slots_persisted }
});
```

**Rationale:** Python is read-only on SQLite per architecture rule; all writes flow through Node.

### Public GET endpoint

```javascript
app.get("/api/stop-reasons/standard/:inverter/:slave", (req, res) => {
  if (isRemoteMode()) return proxyToRemote(req, res);

  // Returns { ok, inverter, slave, slots: [...] } from DB
});
```

### Refresh-trigger wiring

Extend the existing `app.post("/api/stop-reasons/:inverter/refresh", ...)` handler to additionally call the Python `/stop-reasons/standard` route for each slave, then have Python POST back to `/api/stop-reasons/internal/standard-save`. Failures here log a warning but do not fail the vendor SCOPE refresh.

---

## §8 Cross-check logic (pure function)

### `crossCheckStopReasons()` in new file [server/stopReasonsCrossCheck.js](../server/stopReasonsCrossCheck.js)

```javascript
/**
 * Compare a vendor SCOPE stop-reason record against a standard-Modbus slot.
 *
 * Match rules:
 *   1. Both have valid timestamps (not offline / invalid)
 *   2. Timestamps within ±60 seconds
 *   3. Motive codes equal (vendor.motparo === std.motive_code)
 *
 * Returns { match: bool, delta?: { ... }, reason?: string }
 */
function crossCheckStopReasons(vendorSlot, stdSlot) { /* ... */ }

module.exports = { crossCheckStopReasons };
```

Exposes `delta` with `timeDeltaMs`, `timeMatchOk`, `codeMatchOk`, plus original values for UI tooltip rendering.

---

## §9 UI changes — Stop Reasons admin page

### app.js changes

Extend the existing `_renderStopReasonsPanel` (or equivalent) to fetch both vendor SCOPE rows AND standard-Modbus slots, then render side-by-side. Mismatches get a `tr.mismatch` class. Cell value with mismatch gets `td.std-mismatch`.

### CSS

```css
/* v2.10.x Slice ε — Stop Reasons cross-check */
.stop-reasons-table tr.mismatch {
  background-color: color-mix(in srgb, var(--red) 10%, transparent);
}
.stop-reasons-table td.std-mismatch {
  color: var(--red);
  font-weight: 600;
}
```

### HTML (header extension only — no new section)

Add `<th>Standard-Modbus</th>` and `<th>Match</th>` to existing `<table id="stopReasonsTable">`.

---

## §10 TDD test suite

### Test file 1: `services/tests/test_standard_stop_reasons.py`

Pytest cases:
1. All 30 motive codes resolve to correct symbol via `_get_motive_label()`
2. Code 0 → "MOTIVO_PARO_NONE"; code -1 → "unknown(-1)"; code 99 → "unknown(99)"
3. Empty ring buffer (year=0 across all slots) → all slots offline
4. Single event in slot 0 → decoded correctly with timestamp + name
5. Ring-buffer wrap (pointer=3, all 5 slots populated) → `pointer_points_here` set on slot 3
6. Invalid datetime (month=13, day=32, hour=25, min=99) → clamped to valid ranges
7. Signed motive code (0xFFFF → -1) → motive_code becomes -1
8. Sort order verification: most recent first, offline last
9. read_input_registers returns None → function returns None gracefully
10. Per-IP lock acquired and released even on exception

### Test file 2: `server/tests/stopReasonsCrossCheck.test.js`

Custom test() harness, 6+ cases:
1. match: vendor and std within 60 s, same code → `match=true`
2. mismatch: different codes → `match=false`, `codeMatchOk=false`
3. mismatch: timestamps > 60 s apart → `match=false`, `timeMatchOk=false`
4. no match: std offline → `match=false`, `reason="offline_slot"`
5. no match: vendor missing → `match=false`, `reason="missing_data"`
6. invalid std timestamp string → `match=false`, `reason="invalid_std_timestamp"`

### Test file 3: `server/tests/dbStopReasonsStdMigration.test.js`

Custom test() harness against a temp `testdb_std_migration.db`:
1. Schema creation (table exists with all columns)
2. UNIQUE constraint upsert idempotence
3. Query by (inverter_ip, slave) returns expected rows
4. ensureColumn idempotency (running migration twice does not error)

All tests MUST pass RED before implementation begins.

---

## §11 Backward-compatibility checklist

- [ ] **Vendor SCOPE path untouched** — existing `inverter_stop_reasons` table + `/api/stop-reasons/:inverter/recent` endpoint unchanged
- [ ] **New table additive** — `inverter_stop_reasons_std` does not alter existing schema
- [ ] **Remote-mode proxy** — `/api/stop-reasons/standard/:inverter/:slave` routes via `proxyToRemote()` if `isRemoteMode()` (per memory rule)
- [ ] **No feature flag needed** — reads happen unconditionally; UI shows both columns always
- [ ] **Python read-only rule** — all DB writes via Node endpoint `/api/stop-reasons/internal/standard-save`
- [ ] **Settings unchanged** — no new settings keys required
- [ ] **Existing tests pass** — Slice α / β / γ test suites green

---

## §12 Smoke sequence

```powershell
npm run rebuild:native:node

python -m pytest services/tests/test_standard_stop_reasons.py -v
python -m pytest services/tests/test_read_fast_async.py services/tests/test_slow_poll_decode.py -v

node server/tests/stopReasonsCrossCheck.test.js
node server/tests/dbStopReasonsStdMigration.test.js
node server/tests/pollerSignedDecode.test.js
node server/tests/parseRowSlowFields.test.js
node server/tests/inverterStateDecode.test.js
node server/tests/dailyAggregatorCore.test.js
node server/tests/alarmReferenceShape.test.js

npm run rebuild:native:electron
```

---

## §13 Rollback

`git revert <slice-ε-commit>`. No data loss; `inverter_stop_reasons_std` table remains in DB (harmless). Old vendor SCOPE path + UI entirely unaffected.

---

## §14 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Year-byte ambiguity** | MED | Timestamps off-by-century if encoding differs | Fallback to "invalid(YYYY-MM-DD)" string; live-capture verification on first hardware integration |
| **Empty-slot detection** | LOW | offline marker (year=0) not met | Test fixture explicitly covers year=0; offline slots filtered before DB persist |
| **Ring-buffer wrap-around** | LOW | Most recent event misordered | Test case `test_ring_buffer_wrap_pointer` covers all 5 slots; pointer parsed as `regs[0] & 0x07` |
| **High-frequency polling in future** | MED | Bandwidth creep if someone auto-polls | Architecture decision enforces on-demand only; no background loop |
| **Remote-mode proxy gap** | LOW | Remote viewer renders blank if proxy fails | Memory rule `project_inverter_5min_param_remote_blank.md`; test should cover proxy path |
| **UNIQUE constraint conflict** | LOW | Duplicate rows on concurrent refresh | Per-IP lock mirrors Slice β pattern |

---

## §15 Open questions for orchestrator

1. **Year-byte convention:** Does the inverter send 2-digit year (2000-offset) or 4-digit? Assumption: 2-digit + 2000. Recommend: live capture on first integration to verify.
2. **Timestamp comparison tolerance:** ±60 seconds chosen. Confirm acceptable; SCOPE peek read may have additional latency.
3. **Motive code "0" semantics:** PDF lists 1–30 only. Code 0 assumed = "no recorded reason" / empty slot. If the inverter uses 0 differently, adjust filter logic.
4. **Remote gateway sync:** `inverter_stop_reasons_std` is NOT in `REPLICATION_TABLE_DEFS`. Should this table replicate to remote viewers? Current assumption: **local-only** (cross-check is gateway-side diagnostic, not operator-facing data).
5. **Motive labels: separate dict vs shared file:** Plan currently embeds the 30-entry table inline in BOTH `server/motiveLabelsStd.js` and `services/inverter_engine.py` `_get_motive_label()`. Both must stay in sync. Acceptable, or worth wiring a single source via JSON?

---

## §16 HANDOFF: planner → tdd-guide

### Context

Slice ε is a **cross-validation feature** — it reads standard-Modbus stop-reason ring buffer (regs 30078–30108) on-demand and displays side-by-side against the existing vendor SCOPE data. The goal is to detect firmware bugs or Modbus corruption. No replacement of vendor SCOPE; vendor SCOPE remains the authoritative event source.

Key architectural decisions:
- **On-demand only** (operator clicks Refresh) to save bandwidth
- **Python read-only** → Node writes via internal HTTP endpoint
- **New table** `inverter_stop_reasons_std` (additive, no schema changes to existing tables)
- **Remote-mode proxy** for remote viewer support

### Files to create / modify

1. [services/inverter_engine.py](../services/inverter_engine.py) — add `read_standard_stop_reasons()` + `_get_motive_label()` helper. Expose via FastAPI on the Python service (port 9100).
2. [server/db.js](../server/db.js) — add `CREATE TABLE inverter_stop_reasons_std` + `ensureColumn` migrations
3. [server/motiveLabelsStd.js](../server/motiveLabelsStd.js) — NEW file, canonical 30-entry lookup
4. [server/stopReasonsCrossCheck.js](../server/stopReasonsCrossCheck.js) — NEW file, pure function `crossCheckStopReasons()`
5. [server/index.js](../server/index.js) — POST `/api/stop-reasons/internal/standard-save` (localhost-gated) + GET `/api/stop-reasons/standard/:inverter/:slave` (remote-mode proxied) + extend existing POST `/api/stop-reasons/:inverter/refresh` to trigger standard-Modbus read
6. [public/js/app.js](../public/js/app.js) — extend Stop Reasons admin page to fetch + render both columns
7. [public/index.html](../public/index.html) — add table headers for standard-Modbus column and Match column
8. [public/css/style.css](../public/css/style.css) — `.stop-reasons-table tr.mismatch` styling

### Tests to write FIRST (TDD)

1. [services/tests/test_standard_stop_reasons.py](../services/tests/test_standard_stop_reasons.py) — 12+ test cases
2. [server/tests/stopReasonsCrossCheck.test.js](../server/tests/stopReasonsCrossCheck.test.js) — 6+ test cases
3. [server/tests/dbStopReasonsStdMigration.test.js](../server/tests/dbStopReasonsStdMigration.test.js) — 4+ test cases

All tests MUST pass RED before implementation begins.

### Verification grep (run before declaring done)

```bash
grep -n "read_standard_stop_reasons\|_get_motive_label" services/inverter_engine.py
grep -n "/api/stop-reasons/internal/standard-save\|/api/stop-reasons/standard" server/index.js
grep -n "inverter_stop_reasons_std" server/db.js
ls -la server/motiveLabelsStd.js server/stopReasonsCrossCheck.js
grep -n "function crossCheckStopReasons" server/stopReasonsCrossCheck.js
ls -la services/tests/test_standard_stop_reasons.py server/tests/stopReasonsCrossCheck.test.js server/tests/dbStopReasonsStdMigration.test.js
grep -n "stop-reasons-table\|Slice ε\|Standard-Modbus" public/js/app.js public/index.html public/css/style.css
```

If any of those greps return empty, the slice is INCOMPLETE — do not declare done.

---

**End of plan. Ready for tdd-guide dispatch.**
