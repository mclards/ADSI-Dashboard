# Slice α — Decode-Correctness Implementation Plan

| Field | Value |
|---|---|
| Date | 2026-05-10 |
| Status | DRAFT — for tdd-guide handoff |
| Parent plan | [plans/2026-05-10-modbus-registers-official-revamp.md](2026-05-10-modbus-registers-official-revamp.md) §4 Slice α |
| Risk | LOW |
| Estimate | 2-4 hours |

---

## §1 Concrete file changes

### 1.1 [server/poller.js:586-600](../server/poller.js#L586) — Int16 sign cast on `idc` and `pac`

Add `_signedInt16()` helper at module scope (or top of `parseRow`); apply to `idc` and `pac` reads BEFORE the existing `safePac = pac * 10 <= 260000 ? pac * 10 : 0` clamp. The clamp continues to catch word-swap firmware variants on the high side; for negative values, `pac * 10` is much less than 260000 so the clamp is naturally bypassed and the signed value flows through to `safePac`. The existing zero-coherence guard then handles display behavior.

```javascript
function _signedInt16(raw) {
  const u16 = Number(raw) & 0xFFFF;
  return u16 > 0x7FFF ? u16 - 0x10000 : u16;
}
// ...
const idc  = _signedInt16(row.idc  || 0);
const pac  = _signedInt16(row.pac  || 0);
```

JSDoc above `parseRow` cites PDF §2 pg 4-5 + this plan.

### 1.2 [services/inverter_engine.py:2137-2159](../services/inverter_engine.py#L2137) — same in `_update_metrics_from_frame`

```python
def _signed_int16(raw):
    u16 = int(raw) & 0xFFFF
    return u16 - 0x10000 if u16 > 0x7FFF else u16
# ...
idc = float(_signed_int16(frame.get("idc") or 0))
pac_reg = float(_signed_int16(frame.get("pac") or 0))
```

Helper can be module-level or local to `_update_metrics_from_frame`. Module-level preferred for re-use by future Slice β fields (QAC at 30069 is also Int16).

### 1.3 [drivers/modbus_tcp.py:1-20](../drivers/modbus_tcp.py#L1) — Module docstring

Add a top-of-file docstring citing the PDF, this plan, supported function codes (FC 0x03/0x04/0x06/0x10), the FD-pressure mitigations (T3.7 + T3.10), and the register-decode rules (UInt16 / Int16 / UInt32 hi-lo). Place AFTER the `from pymodbus...` and `import time` imports, BEFORE the existing `# T3.7 + T3.10 fix` comment block.

### 1.4 [server/alarms.js](../server/alarms.js) — No code changes needed

All 16 bits audited against PDF §2.2 pg 13. Labels are translated to operator-facing English (e.g. "Frequency Alarm" for ALARMA_FRED) but conceptually match. Bit 11 (0x0800) is labelled "Contactor Fault" in code and "Failure in power electronics branch" in PDF — the code label is a specialization sourced from the v2.9.3 vendor SCOPE drilldown research and is operationally more useful. Keep as-is.

---

## §2 Alarm bit-mapping audit results

| Bit | PDF symbol | PDF English | Code label | Match | Notes |
|---|---|---|---|---|---|
| 0x0001 | ALARMA_FRED | Grid frequency out of range | Frequency Alarm | ✓ | Translated |
| 0x0002 | ALARMA_VRED | Grid voltage out of range | Voltage Alarm | ✓ | Translated |
| 0x0004 | ALARMA_PI_ANA | Current PI saturation | Current Control Fault | ✓ | Operational synonym |
| 0x0008 | ALARMA_RESET_WD | Inverter reset by watchdog | DSP Watchdog Reset | ✓ | Translated |
| 0x0010 | ALARMA_IRED_EFICAZ | Excessive RMS grid current | RMS Overcurrent | ✓ | Translated |
| 0x0020 | ALARMA_TEMPERATURA | Power electronics > 80 °C | Overtemperature | ✓ | Translated |
| 0x0040 | ALARMA_LEC_ADC | A/D converter read error | ADC / Sync Error | ✓ | Translated + context |
| 0x0080 | ALARMA_IRED_INSTA | AC overcurrent (instantaneous) | Instantaneous Overcurrent | ✓ | Translated |
| 0x0100 | ALARMA_PROT_AC | AC protections | AC Protection Fault | ✓ | Translated |
| 0x0200 | ALARMA_PROT_DC | DC protections | DC Protection Fault | ✓ | Translated |
| 0x0400 | ALARMA_PARO_AISL_DC | DC isolation failure | Insulation / Ground Fault | ✓ | Expanded |
| 0x0800 | ALARMA_FRAMA | Failure in power electronics branch | Contactor Fault | ✓ | Specialization from v2.9.3 SCOPE drilldown research |
| 0x1000 | ALARMA_PARO_MANUAL | Manual stop | Manual Shutdown | ✓ | Translated |
| 0x2000 | ALARMA_CONFIG | Configuration change | Configuration Change | ✓ | Exact |
| 0x4000 | ALARMA_VIN | Excessive input voltage | DC Overvoltage | ✓ | Translated |
| 0x8000 | ALARMA_VPV_MED_MIN | Minimum input voltage | DC Undervoltage / Low Power | ✓ | Expanded |

**Result:** No code changes required to [server/alarms.js](../server/alarms.js). Optional enhancement: add a hex-value match assertion to `server/tests/alarmReferenceShape.test.js`.

---

## §3 Test plan (TDD-first)

### 3.1 services/tests/test_read_fast_async.py — extend with Int16 sign tests

Add three test methods exercising the new `_signed_int16()` helper:
- `test_signed_int16_idc_negative` — 0xFFF0 → -16
- `test_signed_int16_pac_negative` — 0x8000 → -32768
- `test_signed_int16_pac_positive_max` — 0x7FFF → 32767
- `test_signed_int16_zero` — 0 → 0

Tests should import the helper from `services.inverter_engine` if module-level, or replicate it inline as a contract test. Either pattern is acceptable; prefer module-level import to lock the contract.

### 3.2 server/tests/pollerSignedDecode.test.js (new file)

Mirror the Python tests against `parseRow()`:
- Construct a `row` object with `idc: 0xFFF0, pac: 0x8000` plus the minimum other fields needed for `parseRow` to return non-null.
- Assert `result.idc === -16`.
- Assert `result.pac` (the `safePac` after sign cast) is the negative scaled value, NOT 32768 * 10 = 327680.
- Cover positive boundaries and zero.

Identity resolution requires a matching `inverter` and `unit` in the configured topology — use a minimal mock or check `parseRow`'s `identity` parameter signature.

### 3.3 server/tests/alarmReferenceShape.test.js — optional hex-value extension

Add a `it("hex values match PDF §2.2 pg 13", ...)` block iterating the bit→hex table from §2 above. Confirms the canonical mapping is locked.

---

## §4 Backward-compatibility checklist

- Frame JSON keys unchanged (`idc`, `pac`, `alarm` stay).
- Existing `safePac` clamp behaviour preserved for word-swap detection (positive > 260 kW still clamped to 0).
- 5-min aggregator and PAC integrator continue to floor energy at 0 (no negative kWh accumulation).
- Display tile zero-coherence guard still applies (negative pac with valid currents will display 0 and log).
- [server/tests/alarmReferenceShape.test.js](../server/tests/alarmReferenceShape.test.js) MUST still pass without modification.
- No DB schema change.

---

## §5 Smoke sequence

```powershell
# Python sign-decode tests
python -m pytest services/tests/test_read_fast_async.py -v

# Node sign-decode tests
npm test -- server/tests/pollerSignedDecode.test.js

# Regression
npm test -- server/tests/alarmReferenceShape.test.js
npm test -- server/tests/dailyAggregatorCore.test.js
npm test -- server/tests/hwCounterDeltaCore.test.js

# Restore Electron ABI after Node-ABI tests
npm run rebuild:native:electron
```

---

## §6 Rollback

`git revert <slice-α-commit>`. No DB schema change. Self-contained.

---

## §7 HANDOFF: planner → tdd-guide

### Context

Slice α applies Int16 sign extension to two Modbus input registers — `Idc` (addr 9) and `PAC` (addr 18) — both marked "signed yes" in the official Ingeteam AAS1000ICB08 PDF but currently decoded as unsigned in both [server/poller.js:586-595](../server/poller.js#L586) and [services/inverter_engine.py:2137-2159](../services/inverter_engine.py#L2137). On a hardware import scenario or measurement fault the unsigned decode produces a huge value (e.g. 0xFFF0 → 65520 instead of -16), and the existing 260 kW PAC clamp silently masks the error. Slice α adds two's complement sign extension before the existing scaling/clamp, audits the 16 alarm bits in [server/alarms.js](../server/alarms.js) against PDF §2.2 (all confirmed matching), and adds module + function docstrings linking to the authoritative spec and revamp plan.

### Files to modify

- [server/poller.js:586-600](../server/poller.js#L586) — add `_signedInt16()` helper + apply to `idc` and `pac` reads + JSDoc above `parseRow`
- [services/inverter_engine.py:2137-2159](../services/inverter_engine.py#L2137) — add `_signed_int16()` helper + apply to `frame.get("idc")` and `frame.get("pac")`
- [drivers/modbus_tcp.py:1-20](../drivers/modbus_tcp.py#L1) — add module docstring
- [server/alarms.js](../server/alarms.js) — NO code changes (audit only)

### Tests to write FIRST

1. `services/tests/test_read_fast_async.py` — add 4 tests for `_signed_int16` helper (idc negative, pac negative, pac positive max, zero)
2. `server/tests/pollerSignedDecode.test.js` (new) — mirror in JS for `parseRow()`
3. `server/tests/alarmReferenceShape.test.js` — optional: add hex-value assertion

### Open questions

- **Negative-PAC display behaviour:** the existing `safePac` clamp passes negative values through unchanged (the `<= 260000` test is true for all negatives). Display tile already floors to 0 via the zero-coherence guard. Confirm with maintainer that signed-pac flowing into `safePac` is OK, OR add an explicit `safePac = max(0, safePac)` floor for display safety.
- **Negative-value logging:** suggested one-time WARN per (inverter, slave) on first negative sighting via console.warn + an `audit_log` row with `action: "sign_cast_warning"`. Confirm with maintainer whether this should be a hard requirement for Slice α or deferred to Slice β observability.

### Recommendations

1. Implement Python helper + tests first (no module dependencies, fastest TDD loop).
2. Mirror in JS with helper + tests.
3. Apply to both call sites.
4. Add docstrings.
5. Run full smoke sequence; restore Electron ABI.
