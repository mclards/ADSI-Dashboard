# 2026-04-27 — Best Approach Recommendation

- **Date:** 2026-04-27
- **Status:** RECOMMENDATION — companion to blueprint
- **Pairs with:** [plans/2026-04-27-stop-reasons-table-and-serial-number-setting.md](plans/2026-04-27-stop-reasons-table-and-serial-number-setting.md)
- **Author:** Engr. Clariden Montaño REE

---

## Why this document exists

The blueprint is comprehensive but contains **one major assumption that the
pcap evidence contradicts**, plus a handful of smaller issues that I caught
on a verification pass through the codebase. This doc captures what
actually changed and the recommended sequence — no production code edits
yet, per your direction.

---

## 1. Verified codebase hooks (good news first)

Quick reads against the actual repo confirmed the blueprint's dependencies
exist:

| Hook | Location | Status |
|---|---|---|
| Alarm-transition raise | [server/alarms.js:1106-1109](server/alarms.js#L1106-L1109) `if (transition === "raise") { raiseActiveAlarm(...) }` | ✓ exists, clean callback site |
| Per-event row insertion | [server/alarms.js:1014](server/alarms.js#L1014) `stmts.insertAlarm.run(...)` returns `lastInsertRowid` | ✓ exists, gives us the FK seed |
| Inverter unit-count discovery | [server/poller.js:866](server/poller.js#L866) `getConfiguredUnitCountForInverter(parsed.inverter)` | ✓ exists, blueprint's `n_nodes` is satisfied by this |
| Per-event broadcast | [server/alarms.js:1112-1114](server/alarms.js#L1112-L1114) `broadcastUpdate({ type: "alarm", alarms: newAlarms })` | ✓ already broadcasting; renderer can listen and trigger drilldown |

**One blueprint correction**: the FK should be on the `alarms` table, NOT
on `audit_log`. They're separate:
- `alarms` (id, ts, inverter, unit, alarm_code, alarm_value, severity,
  cleared_ts, ...) — per-fault-event row, written by `raiseActiveAlarm()`
- `audit_log` (id, ts, operator, inverter, node, action, scope, ...) —
  per-operator-action row, written by control commands

Linking `alarms.stop_reason_id → inverter_stop_reasons.id` is cleaner and
matches the existing data model. Audit_log stays untouched.

---

## 2. CORRECTION — protocol IS fully solved, no fresh pcap needed

**An earlier draft of this section claimed there was a blocking unknown
about whether DebugDesc could be read from per-node addresses. That claim
was wrong** — I misread the bytecount unit. Striking it.

### 2.1 Pcap math proves bytecount is in WORDS

```
Total TCP payload for one 0xFEB5 response = 57 bytes
57 = 5 (header) + 50 (data) + 2 (CRC)  →  50 data bytes  →  25 UINT16 words
```

Bytecount 0x19 = 25 **words** (not bytes). The response carries the FULL
50 bytes of data corresponding to 25 of the 26 UINT16 indices Parse uses.

Decoded against Parse's struct layout, the well-defined fields match the
expected physical values for a running inverter:

| idx | Field | Value | Sanity check |
|---:|---|---|---|
| 1 | PotAC | 0x0269 = 617 → 61.7 kW | ✓ plausible |
| 3 | Vac1 | 0x00CD = 205 V | ✓ matches 220V mains |
| 4 | Vac2 | 0x00CD = 205 V | ✓ |
| 8 | Frec1 | 0x1769 → 59.93 Hz | ✓ matches 60Hz |
| 9 | Frec2 | 0x176A → 59.94 Hz | ✓ |

A few fields look "off" (Vac3=8, Frec3=0.18, Iac2=5993). Most likely
these reflect either a partly-loaded / single-phase node state at capture
time, or a minor per-firmware struct variation. They're not blocking —
the dashboard codec proves itself by cross-checking values against ISM
on a known-good running node.

### 2.2 The only practical adjustment: request count=26 instead of 25

ISM's vendor templates use `count=25`, which returns words 0-24 — exactly
ONE word short of DebugDesc at idx 25. The dashboard should request
`count=26` (one byte change in the frame template) so DebugDesc lands at
the end of the response.

Risk: the DSP firmware might cap at count=25. If it does, we fall back
to either (a) read ARRAYHISTMOTPARO at 0xFE09 for compact MotParo+DebugDesc
records, or (b) accept that DebugDesc is unavailable on Motorola hardware
via this path. But there's no reason to assume it'll cap — 1-line code
experiment validates either way.

### 2.3 No fresh pcap required

Original recommendation said "capture Stop Reasons window pcap before
implementing." That was over-cautious. The protocol is fully understood
from the existing pcap + decompile. Proceed directly to Phase 1 spike.

---

## 3. Recommended approach (revised sequence)

### Phase 1 — Spike-quality codec (1 day, throwaway code in `_spike/`)

Build a minimal Python script (NOT in `services/`, NOT in production
paths) that:

- Connects to one inverter on TCP/7128
- Sends FC 0x71 with addr=0xFEB5, **count=26** (one more than ISM uses)
- Parses the response and prints all 25 StopReason fields including
  DebugDesc at idx 25
- If count=26 is rejected by firmware, falls back to ARRAYHISTMOTPARO
  read at 0xFE09 and pulls the most-recent (MotParo, DebugDesc) entry

Acceptance: an engineer sitting next to ISM can read the same DebugDesc
value via both tools simultaneously. If values diverge, the codec is wrong
and we don't proceed.

**Deliverable lives in `_spike/scope_stop_reasons_probe.py` and is
committed for reproducibility but never imported by production code.**

### Phase 2 — Production codec (Slice A from blueprint, 2 days)

Only after Phase 1 succeeds. `services/vendor_fc.py` is the production
home of what Phase 1 proved out. Tests use the verified pcap fixtures.

### Phase 3 — Slice F linkage FIRST, not Slice B/C

The blueprint already moved Slice F (alarm linkage) to M3, ahead of
Serial Write. Reinforcing that here: **Slice F is the user's stated
product win**. The shortest path is:

```
M1 = Phase 1 spike + Slice A           (2 days)
M2 = Slice B minus the UI table        (Stop Reasons read + DB persist)
M3 = Slice F (auto-capture on raise + drilldown extension)  ★
M4 = Slice D StopReason table UI       (operator-driven view)
M5 = Slice C Serial Read only
M6 = Slice C Serial Write + verify
M7 = Docs + smoke + release
```

The reordering buys you the "alarm has a real timestamp + DebugDesc
inline" experience by M3 (~ 1 week in), with Serial Number Setting
shipping behind it. If Serial Write hits unexpected friction, M1-M4 still
ship and deliver the diagnostic upgrade.

---

## 4. Decision points needed from you

These are blocking enough that I'd rather ask now than assume:

### D1. ~~Capture Stop Reasons pcap~~ — RESOLVED, not needed
The earlier draft asked for a fresh pcap. After §2 correction, the existing
pcap + decompile already give us everything. Spike validates count=26 in
Phase 1 directly against running hardware.

### D2. Test inverter for write-path validation
Slice C M5/M6 (Serial Write) needs a non-critical inverter to test
against. The risk is non-trivial (writing to register 0x9C74 changes a
node's reported serial). Options:
- (a) Use a spare inverter that's not in production rotation
- (b) Test against a node that's currently off-grid for maintenance
- (c) Skip Slice C Write entirely and ship Slice C Read-only in v2.10.0

**Recommendation:** option (b) if you have one in maintenance, otherwise
(c) — Read alone is genuinely useful for fleet inventory; Write can wait.

### D3. Where does "Inverter Diagnostics" live in the nav?
Blueprint Section 9.1 puts it under Settings → between Inverter Clocks
and IP Configuration. Alternatives:
- (a) Settings (current proposal — engineer-facing area)
- (b) New top-level nav item "Diagnostics" (more visible to operators)
- (c) Inside the existing Alarms area (couples it tightly to alarm flow)

**Recommendation:** (a) for v2.10.0. Operators rarely need direct table
access — Slice F surfaces the data inline in the alarm modal where they
already are. The Settings location is fine for the engineer's "fleet
sweep" workflow.

### D4. Slice F dedupe window — 30 s right?
The blueprint specifies 30 s per-inverter dedupe for cascade alarms.
ISM's poll cadence is ~1 s. Cascade events typically resolve within 5-10 s.
- 30 s is conservative (safe, but might miss a second distinct event
  that happens 35 s later)
- 5 s would catch every distinct event but might hammer the inverter
  during prolonged cascades

**Recommendation:** 30 s default, configurable via setting
`stopReasonCaptureDedupeMs`. Most ops sites won't tune it.

### D5. Should Slice F capture happen on EVERY transition, or only on RAISE?
The `raise` transition (alarm bit goes from 0 → non-zero) is the
interesting one. The blueprint already targets `raise`. But what about:
- `update_active` (bit value changes while still non-zero — different
  alarm bit fires)
- `clear` (bit goes back to 0)

**Recommendation:** capture on `raise` AND `update_active` (both
represent new info worth a snapshot). Skip `clear` (nothing to read —
inverter has already returned to idle).

---

## 5. What I'm NOT changing in the blueprint

These passed verification and need no edits:

- ✓ Vendor FC 0x71 frame format (4 capture frames decoded byte-perfect)
- ✓ Per-node base formula `0xFEB5 + (N−1)×0x19` (validated for N=1,2,3)
- ✓ Serial-write protocol (Field[1296-1299] templates extracted, FC16
  with 0xFFFA unlock magic)
- ✓ DSP architecture identification (FreescaleDSP56F = Motorola)
- ✓ Trifasico class is the architecture-agnostic owner
- ✓ Audit timestamp policy (poller-stamped event_at_ms)
- ✓ 7-milestone rollout structure with Slice F at M3

---

## 6. Concrete next step

Confirmed via decoded pcap math: **the protocol is fully solved**, no
fresh capture needed. Two practical paths from here:

1. **Phase 1 spike now** — `_spike/scope_stop_reasons_probe.py`, point
   at one inverter, request count=26 at 0xFEB5, print all 25 fields
   including DebugDesc. ~1 day of throwaway code that proves the codec
   end-to-end before any production paths are written.
2. **Defer the spike** — record the analysis as the canonical reference
   (this doc + the blueprint), wait until the user runs ISM side-by-side
   with the dashboard codec to cross-validate values match what ISM
   displays. Implementation proceeds on the strength of the analysis;
   any value-level discrepancies get caught at the live cross-check stage.

The user's preference (per their note: *"we'll test that again later if
your analisation will coencide to what the ISM read"*) is path 2 —
defer hardware validation until the codec is built and can be A/B'd
against ISM directly. That's a sound call: we have enough confidence
from the protocol decode to write the codec, and the only thing the
spike would buy us is one extra day of certainty before production code.

---

**End of recommendation.**
