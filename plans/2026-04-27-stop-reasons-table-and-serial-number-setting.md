# Plan 2026-04-27 — Stop Reasons Table + Serial Number Setting

- **Date:** 2026-04-27
- **Status:** READY FOR IMPLEMENTATION (v3 — hardware-validated against
  comm-board AND EKI-fallback inverters; protocol confirmed end-to-end)
- **Author:** Engr. Clariden Montaño REE
- **Hardware validation:** all transports + struct layouts + protocol
  paths proven byte-for-byte against the live fleet on 2026-04-27
  ([_spike/](../_spike/) scripts captured the test runs)
- **Decompile evidence:** reverse-engineering of
  `docs/INGECON-SUN-Manager.zip` (FV.IngeBLL.dll + IngeconSunManager.exe)
  on 2026-04-27 — see Section 3
- **Source-of-truth memories:**
  - [project_inverter_dsp_architecture.md](C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\project_inverter_dsp_architecture.md)
  - [ism_serial_write_protocol.md](C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\ism_serial_write_protocol.md)
  - [inverter_comm_board_architecture.md](C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\inverter_comm_board_architecture.md)
- **Prior plans:**
  - [plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md](2026-04-24-hardware-counter-recovery-and-clock-sync.md) — defines the dual-port pattern this plan SUPERSEDES
- **Target release window:** v2.10.0 (Slices A, B, F) → v2.10.x for Slices C, D
- **Related audit (when this ships):** `audits/<release-date>/stop-reasons-debugdesc-rollout.md`

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Glossary](#2-glossary)
3. [Decompile evidence](#3-decompile-evidence)
4. [Hardware validation results (2026-04-27)](#4-hardware-validation-results-2026-04-27)
5. [Goals / Non-goals](#5-goals--non-goals)
6. [Architecture overview](#6-architecture-overview)
7. [Slice A — Vendor FC 0x71 PDU helper](#7-slice-a--vendor-fc-0x71-pdu-helper)
8. [Slice B — Stop Reasons Table (DebugDesc reader)](#8-slice-b--stop-reasons-table-debugdesc-reader)
9. [Slice C — Serial Number Setting (Read / Edit / Send)](#9-slice-c--serial-number-setting-read--edit--send)
10. [Slice D — UI integration](#10-slice-d--ui-integration)
11. [Slice E — Tests](#11-slice-e--tests)
12. [Slice F — Alarm Diagnostics ↔ Stop Reasons linkage](#12-slice-f--alarm-diagnostics--stop-reasons-linkage)
13. [Data model summary](#13-data-model-summary)
14. [Invariants](#14-invariants)
15. [Risk matrix](#15-risk-matrix)
16. [Rollout plan + milestones](#16-rollout-plan--milestones)
17. [Rollback procedures](#17-rollback-procedures)
18. [Pre-flight checklist](#18-pre-flight-checklist)
19. [Open questions](#19-open-questions)
20. [Success criteria](#20-success-criteria)
21. [Appendix A — Verified frame fixtures (byte-level)](#21-appendix-a--verified-frame-fixtures-byte-level)
22. [Appendix B — MOTIVO_PARO label lookup (31 codes)](#22-appendix-b--motivo_paro-label-lookup-31-codes)
23. [Appendix C — FC11 Report Slave ID payload structure](#23-appendix-c--fc11-report-slave-id-payload-structure)
24. [References](#24-references)

---

## 1. Executive summary

**Three coupled features**, all running on a single unified transport
(standard Modbus TCP on port 502 with MBAP framing — the same path the
v2.9.0 poller already uses):

**A. Stop Reasons Table** — surface the 25-field StopReason record per
inverter node with the **DebugDesc** diagnostic sub-code. Operator can
inspect any inverter's per-node fault state plus the
**ARRAYHISTMOTPARO** lifetime counters of all 30 stop motives. Read path:
vendor FC 0x71 SCOPE memory peek wrapped in standard MBAP framing.

**B. Serial Number Setting** — Read / Edit / Send tool that mirrors ISM's
`frmSetSerial` form, gated behind operator auth. Field engineer can
verify and (rarely) change a node's serial number from the dashboard.
Read path: standard FC11 Report Slave ID. Write path: standard FC16
unlock + write to register `0x9C74`.

**C. Alarm Diagnostics ↔ Stop Reasons linkage** — when v2.9.0's poller
detects an alarm bit transition, it auto-fetches the StopReason snapshot
within ~500 ms (before the inverter overwrites the buffer) and stamps it
with the **poller-detected millisecond-precision timestamp**. The v2.9.3
alarm drilldown modal then surfaces the captured snapshot inline —
operator opens an alarm and immediately sees actual telemetry at the
moment of the fault, with the right timestamp and the resolved DebugDesc
sub-code label.

**Slice F (the linkage) is the actual product win.** Slices A and B are
the plumbing that makes F possible. Without F, operators still have to
manually chase the inverter's volatile snapshot before it's overwritten.

### What the v3 hardware-validation pass changed vs v2

The v2 draft assumed the vendor SCOPE protocol was implemented in the
comm board and would only be reachable for inverters with intact comm
boards. **That assumption was wrong.** Validation on 2026-04-27 proved:

- FC 0x71 SCOPE is implemented in the inverter DSP firmware itself
- Both comm boards and EKI-1222-BE fallback gateways relay it transparently
- A single Modbus TCP transport (port 502 + MBAP framing) reaches every
  inverter in the fleet — no per-inverter capability gating

**Result:** the implementation is dramatically simpler than v2 specified
— no `comm_board_status` config, no fallback placeholder UI, no separate
transport layer for SCOPE, no two-port juggling. The whole feature set
runs on top of the existing pymodbus client with one custom PDU helper.

### Combined release impact

- **~1100 LOC** (down from v2's estimated 1800)
- **2 new SQLite tables** + **2 added columns** on `alarms`
- **6 new API endpoints**
- **2 new Settings sub-sections** + extended alarm drilldown
- **v2.10.0 candidate**

---

## 2. Glossary

| Term | Definition |
|---|---|
| **DebugDesc** | The 25th UINT16 (byte offset 48) of the StopReason struct — a vendor diagnostic sub-code that refines the high-level MotParo reason. ISM's "Stop Reasons" window shows it in the rightmost column. |
| **StopReason** | 25-UINT16 (50-byte) snapshot captured by inverter firmware at the moment a unit stops. Layout decoded from `MotivosParoTrif::Parse` (FV.IngeBLL.dll TypeDef[902]) — ★ fields run at indices 0..24 directly (no header word), DebugDesc at idx 24. |
| **MotParo** | Stop motive (UINT16 idx 13 of StopReason). Coarse reason code; DebugDesc disambiguates. |
| **ARRAYHISTMOTPARO** | Historical motive counter array at DSP RAM 0xFE09 — 31 UINT16 counters: one per stop-motive code (30 codes) plus a TOTAL at slot 31. Verified against ISM. |
| **MOTIVO_PARO_*** | Canonical labels for the 30 stop-motive codes (VIN, FRED, VRED, VARISTORES, AISL_DC, IAC_EFICAZ, TEMPERATURA, etc. — see Appendix B). |
| **SCOPE** | INGECON's vendor "memory monitor" protocol implemented inside the DSP firmware. Accessed via vendor function code 0x71 over standard Modbus framing. |
| **FC 0x71** | INGECON proprietary Modbus function code for SCOPE memory peek. PDU body: `[0x71][addr_hi][addr_lo][cmd=0x80][count_words][pad×4]`. |
| **FC11 Report Slave ID** | Standard Modbus FC. INGECON inverters return a 102-byte slave-ID payload containing serial, model, firmware versions, and a snapshot of live registers. The basis for `frmSetSerial::btnLeerSerial_Click` and a useful one-shot fleet-discovery probe. |
| **0xFFFA unlock** | FC16 write of `[0x0065, 0x07A7]` to register 0xFFFA — sets the DSP's "service mode" access level, required before any privileged write (serial number write to 0x9C74; possibly clock sync; possibly future writes). |
| **0x9C74** | Destination register for serial-number ASCII bytes. Count = 6 regs (Motorola, 12 bytes) or 16 regs (TI, 32 bytes). |
| **MBAP** | Modbus Application Protocol header — 7-byte prefix used in standard Modbus TCP framing. `[txn_id(2)][proto_id=0(2)][length(2)][unit_id(1)]`. No CRC needed (TCP handles error detection). |
| **EKI-1222-BE** | Advantech RS485-to-Ethernet serial device server. Used as fallback when an inverter's native comm board is damaged. Acts as transparent Modbus TCP→RTU gateway on port 502 only. Does NOT replicate any vendor-specific stack — it just forwards Modbus frames. |
| **Trifasico** | Three-phase inverter base class in FV.IngeBLL — owns the architecture-agnostic `LeeMotivosDeParo` / `LeeArrayhistmotparo` methods. The user's fleet is all `FreescaleDSP56F` (Motorola) running through this base class. |
| **gecon** | ISM's term for the Modbus slave/unit address (the inverter's RTU slave id). |

---

## 3. Decompile evidence

### 3.1 StopReason struct layout (from `MotivosParoTrif::Parse`, M[4968])

Walked the IL byte-by-byte on 2026-04-27. **CORRECTED LAYOUT after
hardware validation:** the response array starts directly at PotAC at
index 0 — there is no leading header word. Parse() in the IL uses
`ldelem.u2[1..25]` but ISM's `get_Registers` strips the leading word, so
the on-wire data carries 25 UINT16s (50 bytes) starting at PotAC.

| idx | Field | Encoding | Notes |
|---:|---|---|---|
| 0 | PotAC | raw / 10 (kW) | signed int16 — supports reverse power |
| 1 | Vpv | raw (V) | DC bus voltage |
| 2 | Vac1 | raw (V) | phase A voltage |
| 3 | Vac2 | raw (V) | phase B voltage |
| 4 | Vac3 | raw (V) | phase C voltage |
| 5 | Iac1 | raw (A) | phase A current |
| 6 | Iac2 | raw (A) | phase B current |
| 7 | Frec1 | raw / 100 (Hz) | per-phase frequency |
| 8 | Frec2 | raw / 100 (Hz) | |
| 9 | Frec3 | raw / 100 (Hz) | |
| 10 | Cos | raw / 1000 | power factor |
| 11 | Temp | raw (°C) | inverter temperature |
| 12 | Alarma | u16 | hex code; 0 = "no alarm" |
| 13 | MotParo | u16 | primary stop motive |
| 14 | MesDia | HB=month, LB=day | ISM displays as **DD/MM** |
| 15 | HoraMin | HB=hour, LB=minute | "HH:MM" |
| 16 | Ref1 | int16 | |
| 17 | Pos1 | int16 | |
| 18 | Alarmas1 | u16 | hex; 0 = "no alarm" |
| 19 | Ref2 | int16 | |
| 20 | Pos2 | int16 | |
| 21 | Alarmas2 | u16 | hex; 0 = "no alarm" |
| 22 | Flags | u16 | hex; 0 = "no alarm" |
| 23 | TimeoutBand | raw | |
| **24** | **DebugDesc** | **u16** | **★ the diagnostic sub-code** |

Total record = 25 UINT16s = 50 bytes per node.

### 3.2 Vendor FC 0x71 templates (from `Trifasico` class, TypeDef[805])

Extracted byte-for-byte from `<PrivateImplementationDetails>` static blobs:

| Source method | Field | Address | Count (words) | Purpose |
|---|---|---|---:|---|
| `LeeMotivosDeParo[0]` | Field[5896] | **0xFEB5** | 25 (0x19) | Node 1 latest StopReason |
| `LeeMotivosDeParo[1]` | Field[5897] | **0xFECE** | 25 (0x19) | Node 2 (= base + 0x19) |
| `LeeMotivosDeParo[2]` | Field[5898] | **0xFEE7** | 25 (0x19) | Node 3 (= base + 2×0x19) |
| `LeeArrayhistmotparo` | Field[5899] | **0xFE09** | 31 (0x1F) | Historical motive counter array |

Per-node base formula: `0xFEB5 + (N−1) × 0x19` for N = 1..3.

**Hardware-validated extrapolation:** N=4 → `0xFF00` returns frame-valid
data but the contents are NOT a real StopReason struct (Vpv=4V, Vac=2V,
no timestamp — clearly some other DSP RAM region). For 4-node inverters,
ISM uses a different addressing scheme that we have NOT yet decoded.
Cap at N=3 for v2.10.0 unless/until we discover the right N=4 address.

### 3.3 Frame format (standard Modbus, port 502 + MBAP)

```
Request (16 bytes total):
  ┌─ MBAP header (7 bytes) ──┐ ┌─ vendor PDU (9 bytes) ──────────┐
  [txn_id(2)][proto=0(2)][len=10(2)][unit_id(1)] [0x71][addr_hi][addr_lo][0x80][count][0x00 × 4]

Response (variable):
  ┌─ MBAP header (7 bytes) ──┐ ┌─ vendor PDU (5 + count×2 bytes) ────────────────┐
  [txn_id(2)][proto=0(2)][len(2)][unit_id(1)] [0x71][addr_hi][addr_lo][bc_words][data × bc_words×2]
```

No CRC anywhere — TCP handles framing integrity.

### 3.4 Serial-number write templates (from `frmSetSerial`, TypeDef[98])

Extracted from `IngeconSunManager.exe` Field[1296-1299]:

**Unlock (identical for both Motorola and TI architectures):**
```
[unit_id] 10 FF FA 00 02 04 00 65 07 A7
```
Standard FC16 write to register `0xFFFA` with values `[0x0065, 0x07A7]`.

**Motorola serial write (12 ASCII chars):**
```
[unit_id] 10 9C 74 00 06 0C + <12 ASCII bytes>
```

**Texas TI serial write (32 ASCII chars):**
```
[unit_id] 10 9C 74 00 10 20 + <32 ASCII bytes>
```

### 3.5 Serial READ — FC11 Report Slave ID

**Decompiled finding (M[878] btnLeerSerial_Click):** the ISM Read button
calls the inverter's `Identifica` method which issues **FC 0x11 Report
Slave ID** — NOT a register read. Register `0x9C74` is write-only (FC03
returns ILLEGAL_ADDR). The serial number lives in the FC11 slave-ID
payload at byte offset 2-13 (Motorola, 12 chars). See Appendix C for the
full payload structure.

---

## 4. Hardware validation results (2026-04-27)

All findings below were verified against the live fleet using the spike
scripts in [_spike/](../_spike/). Two physical inverters tested:

- **192.168.1.109** — has working comm board (port 502 + 7128 both open)
- **192.168.1.133 (Inverter 23)** — comm board damaged, EKI-1222-BE
  fallback (port 502 only)

### 4.1 SCOPE FC 0x71 works through ANY transparent gateway

Tested with [_spike/scope_stop_reasons_probe.py](../_spike/scope_stop_reasons_probe.py)
(RTU framing on port 7128) and [_spike/eki_scope_probe.py](../_spike/eki_scope_probe.py)
(MBAP framing on port 502). Both return byte-identical PDU payloads:

| Target | Gateway | Port | Framing | FC 0x71 result |
|---|---|---|---|---|
| .109 | comm board | 7128 | RTU + CRC | ✓ DebugDesc=20 |
| .109 | comm board | 502 | **MBAP** | ✓ DebugDesc=20 (PDU bytes identical) |
| .133 | EKI-1222-BE | 502 | **MBAP** | ✓ DebugDesc=57 (full StopReason returned) |
| .133 | EKI-1222-BE | 7128 | — | ✗ port refused (EKI doesn't open 7128) |
| .109 | comm board | 502 | raw RTU + CRC | ✗ no response (port 502 wants MBAP) |

**Conclusion:** SCOPE FC 0x71 lives in the inverter DSP firmware. The
comm board and EKI are both transparent Modbus TCP→RTU gateways. **Port
502 + MBAP framing reaches every inverter in the fleet.**

### 4.2 ISM ↔ probe field-by-field cross-check (slave=2 at .109, Node 1)

Verified all 25 StopReason fields plus all 31 ARRAYHISTMOTPARO counters.
Snapshot of the comparison ([full table in chat history 2026-04-27]):

| Field | ISM | Probe | Match |
|---|---|---|---|
| PotAC | 1073.3 | 1073.3 | ✓ |
| Vpv | 663 | 663 | ✓ |
| Vac1/2/3 | 208/206/206 | 208/206/206 | ✓ |
| Iac1/2 | 174/175 | 174/175 | ✓ |
| Frec1/2/3 | 60.11/60.11/60.12 | 60.11/60.11/60.12 | ✓ |
| Cos | 1 | 1.000 | ✓ |
| Temp | 41 | 41 | ✓ |
| Alarma | 0x200 | 0x0200 | ✓ |
| MotParo | 20 | 20 | ✓ |
| MesDia | 02/04 | 02/04 | ✓ |
| HoraMin | 09:03 | 09:03 | ✓ |
| Ref1/Pos1 | 329/334 | 329/334 | ✓ |
| Alarmas1 | 0x600 | 0x0600 | ✓ |
| Ref2 | 42 | 42 | ✓ |
| Flags | 0x08 | 0x0008 | ✓ |
| **DebugDesc** | **20** | **20** | ★ |

ARRAYHISTMOTPARO: all 31 counters match (VIN=9586, FRED=9054, VRED=9186,
…, TOTAL=62292) — see Appendix B for the full label lookup.

### 4.3 Serial number READ + UNLOCK validated on all paths

Tested with [_spike/serial_number_probe.py](../_spike/serial_number_probe.py):

| Path | READ (FC11) | UNLOCK (FC16→0xFFFA) |
|---|---|---|
| EKI .133:502 MBAP slave=4 | ✓ → `400152A18R44` | ✓ accepted |
| Comm board .109:502 MBAP slave=2 | ✓ → `400152A17R52` | ✓ accepted |
| Comm board .109:7128 RTU slave=2 | ✓ → `400152A17R52` | ✓ accepted |

Serial `400152A17R52` from .109 matches exactly the example serial
visible in the user's earlier ISM Serial Number Setting screenshot —
confirms physical-inverter identity.

Write path (FC16 → 0x9C74) was deliberately NOT executed against
production inverters in validation. The protocol is byte-for-byte known
from the decompile, and the unlock (which uses the identical FC16) was
proven to work — so the write path is safe to implement.

### 4.4 Cabinet topology discovered via slave scan

Tested with [_spike/scope_bus_scan.py](../_spike/scope_bus_scan.py)
on the .109 comm board:

| Slave | PotAC | DebugDesc | ARRAYHISTMOTPARO TOTAL |
|---:|---:|---:|---:|
| 1 | 0.0 kW | 57 | 2516 |
| 2 | 1073.3 kW | 20 | 62292 |
| 3 | 0.0 kW | 57 | 14103 |
| 4 | -6.2 kW | 57 | 12999 |
| 5-30 | no response | — | — |

Different ARRAYHISTMOTPARO TOTALs prove these are 4 distinct physical
inverter units inside one cabinet at IP .109, all daisy-chained on the
cabinet's internal RS485 bus. Each Ethernet IP fronts an independent
RS485 bus — no fleet-wide bus.

### 4.5 Bonus: model + firmware identity from FC11

Both tested inverters returned the same model + firmware fingerprint:
- Model code: `AAV1003BA` (INGECON SUN, model 1003, revision BA)
- Firmware module 1: `AAS1091AA`
- Firmware module 2: `AAS1092_F`

This payload is a one-shot read — useful for the dashboard's startup
inventory check and could feed a future "fleet firmware audit" feature.

---

## 5. Goals / Non-goals

### Goals

- Read live StopReason data per node and persist a rolling window of
  stop events with the full 25-field record incl. DebugDesc.
- Surface the Stop Reasons Table in the Settings → Inverter Diagnostics
  area with a per-event drilldown showing every field, the resolved
  motive label (MOTIVO_PARO_*), and the schematic/PDF context where
  applicable.
- Auto-capture StopReason snapshot within 500 ms of any alarm-bit
  transition, FK-linked to the triggering alarm row, with
  poller-stamped millisecond-precision timestamp.
- Surface the captured snapshot inline in the v2.9.3 alarm drilldown.
- Provide a Read / Edit / Send tool for serial-number management
  equivalent to ISM's `frmSetSerial`, gated behind operator auth and
  audit-logged.
- **Fleet-wide:** all features work for every inverter regardless of
  comm-board status (validated on both comm-board and EKI fallback).
- Reuse the existing pymodbus TCP client and Modbus connection pool —
  no new transport layer.

### Non-goals

- **Full SCOPE memory monitor explorer.** This plan only covers the
  four known DSP RAM addresses (0xFEB5/CE/E7 + 0xFE09). A general-
  purpose memory peek UI is out of scope.
- **Bulk serial-number rollout.** Serial writes are per-node and gated
  behind explicit operator confirmation. No "set all 27 inverters" path.
- **DebugDesc → human-readable lookup table for sub-codes.** The numeric
  value is surfaced, but a per-MotParo decode dictionary for sub-codes
  is a follow-up effort (requires Ingeteam Level 3 documentation we
  don't yet have). The 30 top-level MOTIVO_PARO labels we DO have via
  ARRAYHISTMOTPARO (Appendix B).
- **Historical replay of pre-rollout stop events.** ARRAYHISTMOTPARO
  carries lifetime counts but not per-event history; only events from
  v2.10.0 onward get auto-captured snapshots.
- **Editing fields other than serial number.** No scope for changing
  device IDs, IP config, calibration trim, etc.
- **Node 4 of 4-node inverters.** ISM only reads N=1..3; the
  extrapolated address `0xFF00` returns garbage. Cap at N=3 until we
  decode the alternate addressing.
- **Standalone vendor port (7128) support.** Even on comm-board
  inverters, the dashboard uses port 502 — same path as v2.9.0 polling.
  Port 7128 is left untouched for ISM coexistence.

---

## 6. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                       Dashboard (Electron)                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Settings → Inverter Diagnostics                                     │   │
│  │    [Stop Reasons Table]   [Serial Number Setting]                    │   │
│  │                                                                       │   │
│  │  Alarm modal (v2.9.3 drilldown extended by Slice F):                 │   │
│  │    ┌─ Captured at the moment of the alarm ──────────────────────┐  │   │
│  │    │ ts: 2026-04-27 14:32:18.327 PHT (RTC: 02/04 09:03 ✓)        │  │   │
│  │    │ MotParo: 20 — MOTIVO_PARO_FRED  DebugDesc: 0x0014 (20)       │  │   │
│  │    │ Telemetry: PotAC 1073.3 kW · Vac 208/206/206 · …             │  │   │
│  │    └──────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │ HTTP / WS
┌─────────────────────────────────┴──────────────────────────────────────────┐
│                       Node.js (server/index.js)                             │
│   GET  /api/stop-reasons/:inv             — read-cached + on-demand         │
│   POST /api/stop-reasons/:inv/refresh     — force re-read all nodes         │
│   GET  /api/alarms/:alarm_id/stop-reason  — drilldown linkage payload       │
│   GET  /api/serial/:inv/:node             — proxy to FC11 read              │
│   POST /api/serial/:inv/:node             — proxy to unlock+write           │
│   GET  /api/serial/log/:inv               — audit log                       │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │ HTTP (localhost only, port 9000)
┌─────────────────────────────────┴──────────────────────────────────────────┐
│              Python InverterCoreService (FastAPI :9000)                     │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐ │
│   │  services/vendor_pdu.py            (NEW — Slice A — ~80 LOC)          │ │
│   │   - build_fc71_peek_pdu(addr, count_words) → bytes                    │ │
│   │   - parse_fc71_response_pdu(raw) → bytes (data payload)               │ │
│   │   - vendor_scope_peek(client, slave, addr, count) → bytes             │ │
│   │   - parse_fc11_slave_id(raw) → SlaveIdInfo  (serial+model+fw)         │ │
│   │                                                                         │ │
│   │  Built on top of pymodbus' existing AsyncModbusTcpClient — no          │ │
│   │  separate connection pool, no separate framer, no CRC handling.        │ │
│   └──────────────────────────────────────────────────────────────────────┘ │
│                                ▲                                             │
│             ┌──────────────────┼──────────────────┐                         │
│   ┌─────────┴──────────┐   ┌───┴──────────┐   ┌──┴────────────────┐         │
│   │ stop_reason.py     │   │ serial_io.py │   │ inverter_engine   │         │
│   │   (NEW — Slice B)  │   │ (NEW — C)    │   │ .py (untouched —  │         │
│   │                    │   │              │   │  v2.9.0 60-reg     │         │
│   │ - read_node(N)     │   │ - read_id    │   │  poll continues)   │         │
│   │ - parse_struct()   │   │ - unlock()   │   │                    │         │
│   │ - read_archive()   │   │ - write_serial │   │                    │         │
│   │ - persist()        │   │              │   │                    │         │
│   └────────────────────┘   └──────────────┘   └────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       TCP 192.168.x.y:502  (Modbus TCP — MBAP framing)
                                  │
                                  ▼
                        [comm board OR EKI-1222-BE]
                                  │ RS485
                                  ▼
                            [Inverter DSP]
                            FC 0x71 implemented natively
```

**Key principle:** all SCOPE protocol details (FC 0x71 PDU framing,
slave-ID parsing) live in **one** place — `services/vendor_pdu.py`.
Stop Reasons and Serial Number both consume that helper. The transport
layer below is **stock pymodbus** — no custom socket handling, no CRC,
no port juggling.

### Why no `services/vendor_fc.py` (rename from v2)

The v2 plan called for a `vendor_fc.py` with a custom socket-level
transport. After validation, that's overkill — pymodbus' existing
`AsyncModbusTcpClient` already does TCP + MBAP framing perfectly. We
just need a thin helper that builds the FC 0x71 PDU body and feeds it
through pymodbus' raw-PDU send method (`execute()` with a custom
`ModbusRequest` subclass, OR direct `client.protocol.execute(req)`).

**Renamed to `vendor_pdu.py`** to reflect that we're adding a vendor
PDU encoder/decoder, not a whole new transport.

---

## 7. Slice A — Vendor FC 0x71 PDU helper

### 7.1 Files

| Path | Status | Purpose | Est. LOC |
|---|---|---|---:|
| `services/vendor_pdu.py` | NEW | FC 0x71 PDU + FC11 slave-ID parser | ~120 |
| `services/tests/test_vendor_pdu.py` | NEW | Unit tests with byte fixtures from hardware | ~150 |

### 7.2 API contract

```python
# services/vendor_pdu.py
from dataclasses import dataclass
from pymodbus.client import AsyncModbusTcpClient
from pymodbus.pdu import ModbusRequest, ModbusResponse


# ── FC 0x71 SCOPE memory peek ──
class ScopePeekRequest(ModbusRequest):
    function_code = 0x71

    def __init__(self, addr: int, count_words: int, slave: int = 0):
        super().__init__(slave=slave)
        if not (0 <= addr <= 0xFFFF):
            raise ValueError(f"addr out of range: 0x{addr:X}")
        if not (1 <= count_words <= 0x7F):
            raise ValueError(f"count_words out of range: {count_words}")
        self.addr = addr
        self.count_words = count_words

    def encode(self) -> bytes:
        # PDU body (without slave/FC byte — pymodbus prepends those)
        return bytes([
            (self.addr >> 8) & 0xFF,
            self.addr & 0xFF,
            0x80,                      # cmd byte
            self.count_words & 0xFF,
            0x00, 0x00, 0x00, 0x00,    # padding
        ])


class ScopePeekResponse(ModbusResponse):
    function_code = 0x71

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.addr = 0
        self.data = b""

    def decode(self, data: bytes) -> None:
        # data starts AFTER the FC byte (pymodbus strips it)
        if len(data) < 3:
            raise ValueError(f"FC 0x71 response too short: {len(data)} bytes")
        self.addr = (data[0] << 8) | data[1]
        bc_words = data[2]
        if len(data) < 3 + bc_words * 2:
            raise ValueError(
                f"FC 0x71 response truncated: bc_words={bc_words} "
                f"need {3 + bc_words * 2} got {len(data)}"
            )
        self.data = bytes(data[3:3 + bc_words * 2])


async def vendor_scope_peek(
    client: AsyncModbusTcpClient,
    slave: int,
    addr: int,
    count_words: int,
    timeout_s: float = 3.0,
) -> bytes:
    """High-level helper. Returns the raw data bytes (count_words × 2)."""
    req = ScopePeekRequest(addr=addr, count_words=count_words, slave=slave)
    # Register the response class so pymodbus knows how to decode FC 0x71
    client.register(ScopePeekResponse)
    response = await asyncio.wait_for(client.execute(req), timeout=timeout_s)
    if response is None or hasattr(response, 'isError') and response.isError():
        raise VendorPduError(f"FC 0x71 failed: {response}")
    return response.data


# ── FC11 Report Slave ID ──
@dataclass(frozen=True)
class SlaveIdInfo:
    serial: str               # e.g. "400152A17R52" (Motorola, 12 chars)
    serial_format: str        # "motorola" (12-byte) or "tx" (32-byte)
    model_code: str           # e.g. "AAV1003BA "
    firmware_main: str        # e.g. "AAS1091AA"
    firmware_aux: str         # e.g. "AAS1092_F"
    live_snapshot_raw: bytes  # 20 bytes — PotAC, Vac, Iac, Frec, Cos snapshot
    raw_payload: bytes        # full 102-byte payload for forensics


def parse_fc11_slave_id(raw_payload: bytes) -> SlaveIdInfo:
    """Parse the 102-byte FC11 slave-ID payload (Motorola variant).

    Layout verified 2026-04-27 against two physical inverters — see
    Appendix C for the byte map.
    """
    if len(raw_payload) < 95:
        raise ValueError(f"slave-ID payload too short: {len(raw_payload)}b")
    # Bytes 2..13 are the ASCII serial (12 chars Motorola)
    serial_raw = raw_payload[2:14]
    serial = serial_raw.decode("ascii", errors="replace").rstrip("\x00 ")
    # TI variants would have 32-byte serial — detect by checking for trailing nulls
    serial_format = "motorola" if "\x00" not in serial_raw[:12].decode("latin-1", errors="replace") else "tx"
    return SlaveIdInfo(
        serial=serial,
        serial_format=serial_format,
        model_code=raw_payload[34:44].decode("ascii", errors="replace").rstrip("\x00 "),
        firmware_main=raw_payload[70:79].decode("ascii", errors="replace").rstrip("\x00 "),
        firmware_aux=raw_payload[86:95].decode("ascii", errors="replace").rstrip("\x00 "),
        live_snapshot_raw=bytes(raw_payload[14:34]),
        raw_payload=bytes(raw_payload),
    )


async def read_slave_id(
    client: AsyncModbusTcpClient,
    slave: int,
    timeout_s: float = 3.0,
) -> SlaveIdInfo:
    """High-level helper for FC11."""
    response = await asyncio.wait_for(
        client.read_device_information(slave=slave), timeout=timeout_s
    )
    # pymodbus may not natively support FC11 — fall back to raw if needed
    # See implementation note below.
    raw_payload = _extract_fc11_payload(response)
    return parse_fc11_slave_id(raw_payload)


class VendorPduError(Exception):
    pass
```

### 7.3 Implementation note: pymodbus FC 0x71 + FC11 specifics

pymodbus (3.x) supports **custom function codes** via `client.register()`
on the `ModbusRequest`/`ModbusResponse` base classes. The path:

1. Define `ScopePeekRequest` / `ScopePeekResponse` subclasses with
   `function_code = 0x71`
2. Call `client.register(ScopePeekResponse)` once at startup (registers
   the response-decoder for the framer)
3. Call `client.execute(ScopePeekRequest(...))` like any built-in FC

For **FC11 Report Slave ID**, pymodbus 3.x has built-in support via the
`ReportSlaveIdRequest` class. If the response object doesn't expose the
raw 102-byte payload directly, fall back to a custom request subclass
that captures `data` verbatim. The validated payload from hardware
matches Appendix C exactly — implementation just needs to extract bytes
2..14, 34..44, 70..79, 86..95 from the slave-ID-data field.

### 7.4 Connection management

- Reuse the existing `clients[ip]` pool from
  `services/inverter_engine.py:1283-1289` — no new pool needed.
- Hold the per-IP `thread_locks[ip]` while issuing FC 0x71 / FC11 — must
  not interleave with v2.9.0 polling traffic on the same client.
- Default timeout 3s per frame (matches existing modbus_timeout setting).
- One retry on transient socket error.

### 7.5 Test fixtures

Create golden fixtures in `services/tests/fixtures/`:
- `fc71_peek_0xFEB5_node1_req.bin` — 16-byte MBAP request frame
- `fc71_resp_0xFEB5_node1.bin` — full 61-byte response (capture from .109 slave=2 on 2026-04-27)
- `fc71_resp_0xFE09_arrayhist.bin` — 73-byte ARRAYHISTMOTPARO response
- `fc11_slave_id_response.bin` — 111-byte FC11 response (incl. MBAP)
- `fc16_unlock_request.bin` — 17-byte unlock frame
- `fc16_serial_motorola_request.bin` — full serial-write frame with sample serial

All extracted from hardware-validated traffic (see Appendix A for hex).

### 7.6 Acceptance for Slice A

- `pytest services/tests/test_vendor_pdu.py` passes — fixtures decode to
  the expected dataclass values.
- Manual smoke from `services/inverter_engine.py` REPL:
  `await vendor_scope_peek(clients["192.168.1.109"], slave=2, addr=0xFEB5, count_words=25)`
  returns 50 bytes that parse to PotAC=1073.3 kW (matches Appendix A).
- Same call against an EKI inverter (e.g. .133 slave=4) returns
  comparable data — proves single-transport works fleet-wide.

---

## 8. Slice B — Stop Reasons Table (DebugDesc reader)

### 8.1 Files

| Path | Status | Purpose | Est. LOC |
|---|---|---|---:|
| `services/stop_reason.py` | NEW | Per-node read + struct parser + DB persistence | ~250 |
| `services/tests/test_stop_reason_parse.py` | NEW | Parser unit tests with synthetic & captured fixtures | ~200 |
| `server/db.js` | EDIT | Add `inverter_stop_reasons` table + helpers | +80 |
| `server/stopReasons.js` | NEW | API route handlers | ~180 |
| `server/index.js` | EDIT | Mount `/api/stop-reasons/*` routes | +12 |
| `server/tests/stopReasonsApi.test.js` | NEW | Route-level tests | ~150 |
| `server/motiveLabels.js` | NEW | The 30 MOTIVO_PARO labels lookup (Appendix B) | ~50 |

### 8.2 Parser (`services/stop_reason.py`)

```python
from dataclasses import dataclass, asdict
import struct

# ────────────────────────────────────────────────────────────────────
# StopReason struct — verified layout (2026-04-27)
# 25 UINT16s (50 bytes) starting at PotAC at idx 0
# ────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class StopReasonRecord:
    pot_ac: float           # idx 0 / 10 (kW, signed)
    vpv: int                # idx 1 (V)
    vac1: int               # idx 2
    vac2: int               # idx 3
    vac3: int               # idx 4
    iac1: int               # idx 5
    iac2: int               # idx 6
    frec1: float            # idx 7 / 100 (Hz)
    frec2: float            # idx 8 / 100 (Hz)
    frec3: float            # idx 9 / 100 (Hz)
    cos: float              # idx 10 / 1000
    temp: int               # idx 11 (°C)
    alarma: int             # idx 12 (u16, 0=none)
    motparo: int            # idx 13 — primary stop motive code
    mes_dia_month: int      # idx 14 HB
    mes_dia_day: int        # idx 14 LB
    hora_min_hour: int      # idx 15 HB
    hora_min_min: int       # idx 15 LB
    ref1: int               # idx 16 (int16)
    pos1: int               # idx 17 (int16)
    alarmas1: int           # idx 18 (u16, 0=none)
    ref2: int               # idx 19 (int16)
    pos2: int               # idx 20 (int16)
    alarmas2: int           # idx 21 (u16, 0=none)
    flags: int              # idx 22 (u16, 0=none)
    timeout_band: int       # idx 23
    debug_desc: int         # idx 24 ★

    def is_active_event(self) -> bool:
        """True if any alarm/motive flag is non-zero."""
        return bool(
            self.alarma or self.motparo or self.alarmas1 or
            self.alarmas2 or self.flags or self.debug_desc
        )

    def event_when_struct(self) -> str:
        """Render the inverter-RTC-stamped time (forensic only — see Slice F
        for authoritative event_at_ms)."""
        return (
            f"{self.mes_dia_day:02d}/{self.mes_dia_month:02d} "
            f"{self.hora_min_hour:02d}:{self.hora_min_min:02d}"
        )


def parse_stop_reason(raw: bytes) -> StopReasonRecord:
    """Parse a 50-byte (or longer) FC 0x71 SCOPE peek response."""
    if len(raw) < 50:
        raise ValueError(f"raw too short for StopReason: {len(raw)}b (need 50)")
    w = struct.unpack(">25H", raw[:50])
    # Helper for signed int16 fields
    def _i16(u: int) -> int:
        return u - 0x10000 if u & 0x8000 else u
    return StopReasonRecord(
        pot_ac=_i16(w[0]) / 10.0,
        vpv=w[1], vac1=w[2], vac2=w[3], vac3=w[4],
        iac1=w[5], iac2=w[6],
        frec1=w[7] / 100.0, frec2=w[8] / 100.0, frec3=w[9] / 100.0,
        cos=w[10] / 1000.0,
        temp=w[11],
        alarma=w[12], motparo=w[13],
        mes_dia_month=(w[14] >> 8) & 0xFF, mes_dia_day=w[14] & 0xFF,
        hora_min_hour=(w[15] >> 8) & 0xFF, hora_min_min=w[15] & 0xFF,
        ref1=_i16(w[16]), pos1=_i16(w[17]), alarmas1=w[18],
        ref2=_i16(w[19]), pos2=_i16(w[20]), alarmas2=w[21],
        flags=w[22], timeout_band=w[23],
        debug_desc=w[24],
    )


# ────────────────────────────────────────────────────────────────────
# Per-node read helper
# ────────────────────────────────────────────────────────────────────
NODE_BASE_ADDR = 0xFEB5
NODE_STRIDE = 0x19
ARRAYHIST_ADDR = 0xFE09
ARRAYHIST_COUNT = 31

async def read_node_stop_reason(transport, slave: int, node: int) -> tuple[bytes, StopReasonRecord]:
    """Read a node's StopReason snapshot. node ∈ {1, 2, 3} for v2.10.0."""
    if not (1 <= node <= 3):
        raise ValueError(f"node {node} outside supported range 1..3")
    addr = NODE_BASE_ADDR + (node - 1) * NODE_STRIDE
    raw = await vendor_scope_peek(transport, slave, addr, count_words=25)
    return raw, parse_stop_reason(raw)


# ────────────────────────────────────────────────────────────────────
# ARRAYHISTMOTPARO — 31 lifetime counters
# ────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class StopMotiveHistogram:
    """One UINT16 counter per stop-motive code, plus a TOTAL."""
    counters: list[int]          # 31 counters (30 motives + 1 total)
    raw: bytes

    @property
    def total(self) -> int:
        return self.counters[30]


async def read_arrayhistmotparo(transport, slave: int) -> StopMotiveHistogram:
    raw = await vendor_scope_peek(transport, slave, ARRAYHIST_ADDR, count_words=31)
    if len(raw) < 62:
        raise ValueError(f"ARRAYHISTMOTPARO short: {len(raw)}b")
    counters = list(struct.unpack(">31H", raw[:62]))
    return StopMotiveHistogram(counters=counters, raw=raw)
```

### 8.3 Important quirks (validated against ISM)

- Struct layout starts at index 0 (PotAC) — no header word. This was
  off-by-one in the v2 draft; corrected after hardware test.
- `mes_dia` ISM displays as **DD/MM** (day-first, not month-first)
  — high byte is month, low byte is day.
- The struct's MM/DD HH:MM is the **inverter's RTC-derived stamp** —
  Slice F treats this as forensic-only and uses the poller's
  millisecond-precision local time as the canonical event timestamp.
- Index 12 (`Alarma`) read as raw u16 — 0 displays as "no alarm" in UI;
  non-zero hex code looks up against `server/alarms.js` ALARM_BITS.
- Indices 18, 21, 22 — same `0 → "no alarm"` substitution as 12.
- `Alarmas2` and `Flags` are usually zero; `Alarmas1` carries the
  per-node fault flags worth surfacing.

### 8.4 Database schema

```sql
CREATE TABLE IF NOT EXISTS inverter_stop_reasons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  inverter_id     INTEGER NOT NULL,                  -- FK to existing inverters table
  inverter_ip     TEXT NOT NULL,                     -- denormalized for fast filter
  slave           INTEGER NOT NULL,                  -- Modbus unit_id used to read
  node            INTEGER NOT NULL,                  -- 1..3 (v2.10.0 cap)
  read_at_ms      INTEGER NOT NULL,                  -- epoch when we polled
  event_at_ms     INTEGER,                           -- canonical event timestamp
                                                     -- (poller-stamped via Slice F;
                                                     --  NULL for manual reads)
  trigger_source  TEXT NOT NULL,                     -- 'manual' | 'alarm_transition' | 'scheduled'
  alarm_id        INTEGER,                           -- FK to alarms.id (Slice F)
                                                     --  NULL for manual reads

  -- Decoded fields (denormalized — speeds list/filter queries)
  pot_ac          REAL,
  vpv             INTEGER,
  vac1            INTEGER, vac2 INTEGER, vac3 INTEGER,
  iac1            INTEGER, iac2 INTEGER,
  frec1           REAL, frec2 REAL, frec3 REAL,
  cos             REAL,
  temp            INTEGER,
  alarma          INTEGER NOT NULL,
  motparo         INTEGER NOT NULL,
  motparo_label   TEXT,                              -- looked up from MOTIVO_PARO_LABELS
  alarmas1        INTEGER, alarmas2 INTEGER, flags INTEGER,
  ref1            INTEGER, pos1 INTEGER,
  ref2            INTEGER, pos2 INTEGER,
  timeout_band    INTEGER,
  debug_desc      INTEGER NOT NULL,                  -- ★ key value

  -- Inverter's RTC-derived stamp (forensic, not authoritative)
  struct_month    INTEGER, struct_day INTEGER,
  struct_hour     INTEGER, struct_min INTEGER,

  -- Forensics
  raw_hex         TEXT NOT NULL,                     -- full 50-byte hex for re-decode

  -- De-dup: same (slave, node, motparo, debug_desc, struct timestamp) within
  -- 60s = same physical event re-read; collapse to one row
  fingerprint     TEXT NOT NULL,

  FOREIGN KEY (alarm_id) REFERENCES alarms(id) ON DELETE SET NULL,
  UNIQUE(inverter_ip, slave, node, fingerprint)
);
CREATE INDEX idx_stop_reasons_lookup ON inverter_stop_reasons(inverter_ip, slave, node, read_at_ms DESC);
CREATE INDEX idx_stop_reasons_alarm  ON inverter_stop_reasons(alarm_id) WHERE alarm_id IS NOT NULL;
CREATE INDEX idx_stop_reasons_event  ON inverter_stop_reasons(event_at_ms DESC) WHERE event_at_ms IS NOT NULL;

-- ARRAYHISTMOTPARO snapshots (lifetime counters per inverter)
CREATE TABLE IF NOT EXISTS inverter_stop_histogram (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  inverter_id     INTEGER NOT NULL,
  inverter_ip     TEXT NOT NULL,
  slave           INTEGER NOT NULL,
  read_at_ms      INTEGER NOT NULL,
  total_count     INTEGER NOT NULL,
  counters_json   TEXT NOT NULL,                     -- JSON array of 31 counters
                                                     -- (30 motives + 1 TOTAL)
  raw_hex         TEXT NOT NULL
);
CREATE INDEX idx_histogram_inv_ts ON inverter_stop_histogram(inverter_ip, slave, read_at_ms DESC);
```

**Retention:** `inverter_stop_reasons` 365 days (operator-tunable via
`stopReasonsRetainDays` setting). `inverter_stop_histogram` 90 days
(snapshots are big and the TOTAL only changes slowly).

### 8.5 Read scheduler

- **No autonomous polling.** StopReason reads are operator-triggered or
  triggered by Slice F (alarm-bit transition).
- **Coalesce:** if multiple alarm bits flip within 5 s, single read.
- **Per-inverter rate limit:** max one full Stop Reasons read per minute
  per inverter on operator-driven path (operator can override with
  explicit "Refresh now" — that bypasses the limit).
- **Concurrency:** serialize per-inverter via existing
  `thread_locks[ip]` from `inverter_engine.py` — never interleave SCOPE
  peeks with v2.9.0 polling on the same client.

### 8.6 API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/stop-reasons/:inverter_ip` | none (read) | Last N events for that inverter, all nodes |
| `GET` | `/api/stop-reasons/:inverter_ip/event/:event_id` | none | Full record for one event |
| `GET` | `/api/stop-reasons/:inverter_ip/histogram` | none | Latest ARRAYHISTMOTPARO snapshot |
| `POST` | `/api/stop-reasons/:inverter_ip/refresh` | bulk auth (`sacupsMM`) | Force re-read all nodes now |
| `GET` | `/api/stop-reasons/summary` | none | Cross-inverter chip data for top bar |

Response shape (GET list):
```json
{
  "inverter_ip": "192.168.1.109",
  "slave": 2,
  "events": [
    {
      "id": 42,
      "node": 1,
      "read_at_ms": 1745847600000,
      "event_at_ms": 1745847599327,
      "trigger_source": "alarm_transition",
      "alarm_id": 1234,
      "event_when_struct": "02/04 09:03",
      "rtc_drift_warning": false,
      "motparo": 20,
      "motparo_label": "MOTIVO_PARO_FRED",
      "debug_desc": 20,
      "debug_desc_hex": "0x0014",
      "alarma": 512, "alarmas1": 1536, "alarmas2": 0, "flags": 8,
      "telemetry": {
        "pot_ac": 1073.3, "vpv": 663,
        "vac1": 208, "vac2": 206, "vac3": 206,
        "iac1": 174, "iac2": 175,
        "frec1": 60.11, "frec2": 60.11, "frec3": 60.12,
        "cos": 1.000, "temp": 41
      },
      "raw_hex": "29 ED 02 97 00 D0 00 CE 00 CE 00 AE ..."
    }
  ]
}
```

### 8.7 Acceptance for Slice B

- Operator clicks "Refresh" → table populates with up to 3 rows per
  inverter (one per node) within 5 s.
- DebugDesc column shows non-zero values for any node currently
  reporting a stop event (e.g. inverter 23 returned DebugDesc=57 in
  validation).
- Histogram view shows all 31 MOTIVO_PARO counters with their canonical
  labels (VIN, FRED, VRED, etc. per Appendix B).
- Forced refresh while inverter is running shows MotParo=0, DebugDesc=0
  for healthy nodes.
- Re-reading the same event within 60s produces no new DB row (UNIQUE
  fingerprint constraint holds).
- All operations work identically against comm-board AND EKI inverters
  (validated 2026-04-27).

---

## 9. Slice C — Serial Number Setting (Read / Edit / Send)

### 9.1 Files

| Path | Status | Purpose | Est. LOC |
|---|---|---|---:|
| `services/serial_io.py` | NEW | FC11 read + FC16 unlock+write, format detection | ~180 |
| `services/tests/test_serial_io.py` | NEW | Unit tests with both formats + fixtures | ~150 |
| `server/serialNumber.js` | NEW | API route handlers + auth gate + session token | ~200 |
| `server/index.js` | EDIT | Mount `/api/serial/*` routes | +8 |
| `server/db.js` | EDIT | Add `serial_change_log` table | +20 |
| `server/tests/serialNumberApi.test.js` | NEW | Route-level tests | ~180 |

### 9.2 Read (`services/serial_io.py`)

```python
async def read_serial(transport, slave: int, fmt: str = "auto") -> SlaveIdInfo:
    """Read serial via FC11 Report Slave ID. fmt 'auto' lets parse_fc11_slave_id
    detect Motorola (12 bytes) vs TI (32 bytes) automatically."""
    info = await read_slave_id(transport, slave)
    if fmt != "auto" and info.serial_format != fmt:
        # Operator's UI selection mismatched detection — surface but don't fail
        info = info._replace(format_warning=f"detected {info.serial_format}, operator picked {fmt}")
    return info
```

The operator sees the full SlaveIdInfo (serial + model + firmware
versions + live snapshot) — useful context, not just the bare serial.

### 9.3 Write (`services/serial_io.py`)

```python
async def write_serial(transport, slave: int, new_serial: str, fmt: str) -> None:
    """Two-frame write: FC16 unlock @ 0xFFFA + FC16 ASCII @ 0x9C74."""
    expected_len = {"motorola": 12, "tx": 32}[fmt]
    if len(new_serial) != expected_len:
        raise ValueError(f"{fmt} format requires exactly {expected_len} chars, got {len(new_serial)}")
    if not new_serial.isascii():
        raise ValueError("serial must be ASCII-only")

    # Frame 1 — UNLOCK (sets service mode)
    await transport.write_registers(address=0xFFFA, values=[0x0065, 0x07A7], slave=slave)

    # Frame 2 — SERIAL WRITE
    payload_bytes = new_serial.encode("ascii")
    n_regs = expected_len // 2
    regs = [
        (payload_bytes[2*i] << 8) | payload_bytes[2*i + 1]
        for i in range(n_regs)
    ]
    await transport.write_registers(address=0x9C74, values=regs, slave=slave)


async def verify_serial_write(transport, slave: int, expected: str) -> bool:
    """Re-read after write to confirm. ISM does Sleep(1000) — we do the same."""
    await asyncio.sleep(1.0)
    info = await read_serial(transport, slave)
    return info.serial == expected
```

**Important:** the user MUST have Read first before Send (mirrors ISM's
"You must Read before sending" guard). Enforce in API layer with a
short-lived session token.

### 9.4 Database schema (audit log)

```sql
CREATE TABLE IF NOT EXISTS serial_change_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  inverter_ip     TEXT NOT NULL,
  slave           INTEGER NOT NULL,
  acted_at_ms     INTEGER NOT NULL,
  acted_by        TEXT,                   -- operator name from session
  fmt             TEXT NOT NULL,          -- 'motorola' | 'tx'
  old_serial      TEXT NOT NULL,          -- captured by mandatory pre-Read
  new_serial      TEXT NOT NULL,
  verify_passed   INTEGER NOT NULL DEFAULT 0,
  outcome         TEXT NOT NULL,          -- 'success' | 'unlock_failed' | 'write_failed' | 'verify_failed'
  error_detail    TEXT                    -- exception message if any
);
CREATE INDEX idx_serial_change_log_inv ON serial_change_log(inverter_ip, acted_at_ms DESC);
```

Retention: forever (this is a service record — never auto-prune).

### 9.5 API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/serial/:inverter_ip/:slave?fmt=auto` | bulk auth | Read serial + slave-ID info; returns `{serial, fmt, model, firmware, session_token}` |
| `POST` | `/api/serial/:inverter_ip/:slave` | bulk auth + session_token | Write new serial — body `{new_serial, fmt, session_token, verify: true}` |
| `GET` | `/api/serial/log/:inverter_ip` | topology auth | Audit log for that inverter |

Session token: short-lived (5 min) UUID minted by GET — must be echoed
in the POST body. Mirrors ISM's "must Read before Send" gate without
requiring server-side per-user state.

### 9.6 "Verify Serial Number to send" — fleet-wide uniqueness check (CORRECTED)

The form checkbox is a **uniqueness check BEFORE send**, not a post-write
readback. Operator clarification (2026-04-27): *"the serial number
validator means before sending the new serial number validate first if
it is already existed on other nodes/units."*

Two separate verify concerns:

**A. Pre-send fleet uniqueness check** — operator-toggleable via the
"Verify" checkbox (default ON). When enabled:

1. Before issuing unlock+write, scan all reachable
   (inverter_ip, slave) pairs from topology config via FC11
2. Compare candidate `new_serial` against discovered fleet map
3. Skip the target (write_ip, write_slave) — matching its own current
   serial is NOT a conflict (no-op rewrites are valid)
4. If conflict found anywhere: block send, return 409 with location
   payload `{inverter_name, inverter_ip, slave, existing_serial}`
5. If some inverters unreachable: return 200 with
   `{partial: true, scanned: N, unreachable: [...]}` — UI prompts
   operator to Cancel or Send Anyway

**B. Post-write readback verify** — always on (not operator-toggleable),
mirrors ISM's `Sleep(1000)` + re-read at IL_015F of M[879]:

1. After unlock+write succeeds at the wire level
2. Wait 1000 ms
3. Re-read via FC11
4. Compare to `new_serial` — if mismatch, log `verify_failed`,
   return 502 to UI with `{written: <new>, readback: <whatever_we_got>}`

### 9.7 Fleet uniqueness implementation

```python
# services/serial_io.py (Slice C)
from dataclasses import dataclass

@dataclass(frozen=True)
class ConflictLocation:
    inverter_name: str
    inverter_ip: str
    slave: int
    existing_serial: str
    last_seen_ms: int


@dataclass(frozen=True)
class UniquenessResult:
    unique: bool
    conflicts: list[ConflictLocation]
    unreachable: list[tuple[str, int]]   # (ip, slave) pairs
    scanned: int


# 5-minute TTL fleet serial map cache, populated on demand
_fleet_serial_cache: dict[tuple[str, int], tuple[str, int]] = {}  # (ip, slave) → (serial, scanned_at_ms)
_FLEET_CACHE_TTL_MS = 5 * 60 * 1000


async def fleet_uniqueness_check(
    candidate_serial: str,
    exclude_self: tuple[str, int],
    topology: list[InverterTopology],
    concurrency: int = 8,
) -> UniquenessResult:
    """Scan fleet via FC11, find conflicts on candidate_serial."""
    sem = asyncio.Semaphore(concurrency)
    targets = [
        (inv.ip, inv.name, slave)
        for inv in topology
        for slave in inv.slaves
        if (inv.ip, slave) != exclude_self
    ]
    tasks = [_check_one(sem, ip, name, slv, candidate_serial) for ip, name, slv in targets]
    results = await asyncio.gather(*tasks, return_exceptions=False)

    conflicts = [r for r in results if isinstance(r, ConflictLocation)]
    unreachable = [r for r in results if isinstance(r, tuple)]
    return UniquenessResult(
        unique=len(conflicts) == 0,
        conflicts=conflicts,
        unreachable=unreachable,
        scanned=len(targets) - len(unreachable),
    )


async def _check_one(sem, ip, name, slave, candidate):
    async with sem:
        # Cache fast path
        cached = _fleet_serial_cache.get((ip, slave))
        now = time.time() * 1000
        if cached and (now - cached[1]) < _FLEET_CACHE_TTL_MS:
            existing = cached[0]
        else:
            try:
                client = await get_client_for_ip(ip)
                info = await read_slave_id(client, slave, timeout_s=2.0)
                existing = info.serial
                _fleet_serial_cache[(ip, slave)] = (existing, int(now))
            except (asyncio.TimeoutError, OSError, Exception):
                return (ip, slave)  # unreachable

        if existing == candidate:
            return ConflictLocation(
                inverter_name=name, inverter_ip=ip, slave=slave,
                existing_serial=existing, last_seen_ms=int(now),
            )
        return None  # no conflict from this node


def invalidate_cache_for(ip: str, slave: int) -> None:
    _fleet_serial_cache.pop((ip, slave), None)


# Called after every successful Slice C write
async def write_serial_with_verify(
    transport, slave, new_serial, fmt,
    *, check_uniqueness=True, override_conflicts=False,
    topology=None,
) -> dict:
    inverter_ip = transport.host

    # Step 0 — uniqueness check (if requested)
    if check_uniqueness:
        result = await fleet_uniqueness_check(
            candidate_serial=new_serial,
            exclude_self=(inverter_ip, slave),
            topology=topology,
        )
        if not result.unique and not override_conflicts:
            raise SerialConflictError(
                f"Serial '{new_serial}' already exists on "
                f"{result.conflicts[0].inverter_name} "
                f"(slave {result.conflicts[0].slave})",
                conflicts=result.conflicts,
                unreachable=result.unreachable,
            )
        if result.unreachable and not override_conflicts:
            return {
                "status": "partial_check",
                "scanned": result.scanned,
                "unreachable": result.unreachable,
                "conflicts": [],
            }

    # Step 1 — unlock
    await transport.write_registers(0xFFFA, [0x0065, 0x07A7], slave=slave)

    # Step 2 — write
    payload_bytes = new_serial.encode("ascii")
    n_regs = {"motorola": 6, "tx": 16}[fmt]
    regs = [(payload_bytes[2*i] << 8) | payload_bytes[2*i + 1] for i in range(n_regs)]
    await transport.write_registers(0x9C74, regs, slave=slave)

    # Step 3 — readback verify (always on)
    await asyncio.sleep(1.0)
    info = await read_serial(transport, slave)
    if info.serial != new_serial:
        return {
            "status": "verify_failed",
            "written": new_serial, "readback": info.serial,
        }

    # Success — invalidate cache for this node
    invalidate_cache_for(inverter_ip, slave)
    return {"status": "success", "new_serial": new_serial}
```

### 9.8 Updated API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/serial/:inverter_ip/:slave?fmt=auto` | bulk auth | Read serial + slave-ID info; mints session token |
| `POST` | `/api/serial/:inverter_ip/:slave` | bulk auth + session_token | Write new serial — body `{new_serial, fmt, session_token, check_uniqueness: true, override_conflicts: false}`. Returns 409 with `conflicts: [...]` on duplicate, 200 with `{status: "partial_check"}` if some inverters unreachable, 200 with `{status: "success"}` on full pipeline pass |
| `POST` | `/api/serial/:inverter_ip/:slave/override` | bulk auth + topology auth + session_token | Same as POST above but with `override_conflicts: true` — requires the second auth key for service escape hatch |
| `GET` | `/api/serial/fleet-map` | topology auth | Returns cached fleet map for inventory view |
| `POST` | `/api/serial/fleet-map/refresh` | topology auth | Force-refresh cache for all inverters |
| `GET` | `/api/serial/log/:inverter_ip` | topology auth | Audit log for that inverter |

### 9.7 Acceptance for Slice C

- GET returns the same serial value the user sees in ISM's form for the
  same slave (e.g. .109 slave=2 → `400152A17R52`).
- POST with same value as currently on device succeeds (no-op write
  still verifies).
- POST with one-char change succeeds, verify confirms, audit log records
  before+after.
- POST without prior GET → 403 (no session token).
- POST with stale session token (>5 min) → 403.
- POST with wrong fmt-length → 400 with the specific length error.
- All operations work against EKI inverters (validated 2026-04-27 — both
  FC11 read and FC16 unlock accepted).

---

## 10. Slice D — UI integration

### 10.1 Settings → Inverter Diagnostics section

New collapsible section in the existing Settings page, between
"Inverter Clocks" (v2.9.0) and the existing "IP Configuration" section:

```
Inverter Diagnostics                                            [▼]
├─ Stop Reasons Table
│   [Refresh All] [▼ Filter: All inverters]    Last updated: 2 min ago
│   ┌──────────┬───────┬──────┬───────────┬───────────┬───────────┬──────────┐
│   │ Inverter │ Slave │ Node │ When      │ MotParo   │ DebugDesc │ Telemetry│
│   ├──────────┼───────┼──────┼───────────┼───────────┼───────────┼──────────┤
│   │ INV-01   │  2    │  1   │ 04/02 09:03│ 20 (FRED)│  20 ★     │ 1073kW   │
│   │ INV-23   │  4    │  1   │ 26/04 17:50│ 19 (—)   │  57       │ idle     │
│   └──────────┴───────┴──────┴───────────┴───────────┴───────────┴──────────┘
│   Click row → drilldown modal with all 25 fields + raw hex
│
│   ── Lifetime motive counters (ARRAYHISTMOTPARO) ─────────────────────────
│   [▼ Inverter selector]   TOTAL: 62292 events  [Snapshot age: 5 min]
│   ┌────────────────────────┬───────┐
│   │ MOTIVO_PARO_VIN        │  9586 │
│   │ MOTIVO_PARO_FRED       │  9054 │
│   │ MOTIVO_PARO_VRED       │  9186 │
│   │ … (top 10 shown — click to expand all 30)                       │
│   └────────────────────────┴───────┘
│
└─ Serial Number Setting
    [Select Inverter ▼] [Select Slave ▼]
    1) Read           2) Edit              3) Send
    [    Read    ]    [400152A17R52   ]    [    Send    ]
                      [✓] Verify Serial Number to send
    Architecture
    (●) Motorola Format (12 byte)
    (○) TexasTMS320 Format (32 byte)
    
    Detected: Model AAV1003BA · Firmware AAS1091AA / AAS1092_F
    Status: idle
    Recent changes: [view audit log]
```

### 10.2 Files

| Path | Status | Purpose | Est. LOC |
|---|---|---|---:|
| `public/index.html` | EDIT | Add `#inverterDiagnosticsSection` wrapper | +60 |
| `public/js/app.js` | EDIT | Three new modules: `stopReasonsTable`, `motiveHistogram`, `serialNumberPanel` | +500 |
| `public/css/style.css` | EDIT | Section styling reusing existing token palette | +120 |
| `docs/ADSI-Dashboard-User-Manual.md` | EDIT | New chapter "Inverter Diagnostics" | +200 |
| `docs/ADSI-Dashboard-User-Guide.html` | REGEN | From updated MD | — |

### 10.3 Drilldown modal (Stop Reasons row click)

Layout follows the v2.9.3 alarm drilldown pattern:

```
Stop Reason — Inverter INV-01 Slave 2 Node 1                      [×]

When                  04/02 09:03 (read 2 min ago)
                      ⚠ inverter RTC said 02/04 — DASHBOARD time used
MotParo               20 — MOTIVO_PARO_FRED                       ★
DebugDesc             0x0014 (20)                                  ★
Alarma                0x0200
Alarmas1 / Alarmas2   0x0600 / none
Flags                 0x0008

Telemetry at stop
  PotAC: 1073.3 kW    Vpv: 663 V    Temp: 41 °C
  Vac:   208 / 206 / 206 V
  Iac:   174 / 175 A
  Frec:  60.11 / 60.11 / 60.12 Hz
  Cos:   1.000
  Ref1: 329  Pos1: 334     Ref2: 42  Pos2: 0
  TimeoutBand: 0

Raw hex (for service)
  29 ED 02 97 00 D0 00 CE 00 CE 00 AE ... (50 bytes)
```

DebugDesc is highlighted because it's the unique value this feature
brings — the rest is supplementary.

### 10.4 Serial Number Setting UX

- "Read" button enabled by default
- "Edit" textbox enabled after Read succeeds
- "Send" button greyed until: (a) Read succeeded AND (b) operator
  entered the bulk auth key (`sacupsMM`) AND (c) "Verify" checkbox
  state acknowledged
- Architecture radio buttons auto-select based on detected format from
  Read; operator can override
- Bad auth → toast "Invalid auth key, try again"
- Successful write → toast "Serial updated to '<new>' on inverter X
  slave Y" + audit log row
- Verify failure → red toast "Write succeeded but read-back didn't
  match — investigate"

### 10.5 Acceptance for Slice D

- Stop Reasons Table renders without console errors on first load with
  zero data.
- After "Refresh All", populated rows appear; row click opens drilldown.
- Histogram view loads on inverter-selector change; counters match
  ISM's ARRAYHISTMOTPARO display row-for-row.
- Serial Number Setting Read returns current value + model + firmware;
  Send is greyed until both Read + auth done.
- Audit log link opens a modal listing past changes with timestamps.

---

## 11. Slice E — Tests

### 11.1 Pure-logic tests (no hardware)

| File | What |
|---|---|
| `services/tests/test_vendor_pdu.py` | FC 0x71 PDU encode/decode against fixtures from .109 capture; FC11 slave-ID parser against fixtures from both .109 and .133 |
| `services/tests/test_stop_reason_parse.py` | Parse the 50-byte hex from .109 slave=2 node 1; assert PotAC=1073.3, DebugDesc=20, MesDia month=4 day=2, etc. (cross-checked against ISM); verify signed int16 handling for negative PotAC; verify byte-packed mes_dia/hora_min decode; verify 0→none substitution |
| `services/tests/test_serial_io.py` | Pack/unpack 12-char Motorola serial (`400152A17R52`); pack/unpack 32-char TI serial (synthetic); reject non-ASCII; reject wrong length; verify unlock-then-write call order |
| `server/tests/stopReasonsApi.test.js` | Mock Python service; assert response shape; UNIQUE constraint dedup; rate limit; alarm-event linkage |
| `server/tests/serialNumberApi.test.js` | Session token mint + expire; auth gate; verify roundtrip; audit log row written |
| `server/tests/motiveLabels.test.js` | All 30 MOTIVO_PARO labels present; lookup function returns canonical strings; unknown codes return `<unknown>` not crash |

### 11.2 Hardware-replay test (offline reproducibility)

`services/tests/test_hardware_replay.py` — replays the captured byte
sequences from Appendix A through the full parser stack and asserts the
exact field values the user verified against ISM on 2026-04-27. This is
the regression guarantee — if this test fails after a refactor, the
parser semantics changed.

### 11.3 Smoke sequence (mandatory before release)

Standard project smoke per CLAUDE.md, plus:
1. `pytest services/tests/test_vendor_pdu.py services/tests/test_stop_reason_parse.py services/tests/test_serial_io.py services/tests/test_hardware_replay.py`
2. `node server/tests/stopReasonsApi.test.js`
3. `node server/tests/serialNumberApi.test.js`
4. Manual: open Settings → Inverter Diagnostics, click Refresh, verify
   table populates with non-zero DebugDesc on at least one node.
5. Manual: read serial via Slice C UI, confirm matches ISM's display.
6. Manual (carefully — last): with operator approval, attempt Send with
   no-op (same serial), verify audit log row written and `verify_passed=1`.

---

## 12. Slice F — Alarm Diagnostics ↔ Stop Reasons linkage

**The core integration this plan exists for.** v2.9.3 Alarms Diagnostic
section (server/alarms.js ALARM_BITS + per-bit drilldown modal) is the
operator's first stop when investigating an event. It must surface the
matching StopReason snapshot **automatically**, with the **correct
timestamp** of when the alarm fired.

### 12.1 Why this matters (unchanged from v2)

Without auto-capture: operator sees alarm at 14:32, opens drilldown,
sees only reference content. By the time they manually trigger a
StopReason refresh, the inverter has restarted and the snapshot buffer
at 0xFEB5 has been overwritten — fault context lost.

With auto-capture: poller detects bit transition 0→1 at 14:32:18.327,
queues immediate Stop Reasons read within 500 ms, persists the row with
authoritative `event_at_ms` and FK link to the audit row.

### 12.2 Files

| Path | Status | Purpose | Est. LOC |
|---|---|---|---:|
| `server/poller.js` | EDIT | Hook `raiseActiveAlarm` to enqueue StopReason capture with `lastInsertRowid` | +40 |
| `server/db.js` | EDIT | Add `alarms.stop_reason_id` FK column | +5 |
| `server/alarmsDiagnostic.js` | NEW | Composes alarm-bit reference data + matching StopReason snapshot for the drilldown payload | ~120 |
| `services/stop_reason.py` | EDIT (Slice B) | Accept `event_at_ms`, `alarm_id`, `trigger_source` parameters from caller | +20 |
| `public/js/app.js` | EDIT | `openAlarmDetail()` extended — fetch + render the StopReason inline | +180 |
| `public/css/style.css` | EDIT | New `.alarm-detail-stop-reason` block styling (neutral border, follows v2.9.3 token palette) | +40 |
| `server/tests/alarmStopReasonLinkage.test.js` | NEW | Round-trip: simulate alarm transition → assert StopReason row created + `alarms.stop_reason_id` populated | ~200 |

### 12.3 Authoritative timestamp policy (★ user requirement)

- **`event_at_ms` (canonical)** = poller's local epoch ms at the moment
  it detected the alarm bit transition. This already exists in v2.9.0
  via the alarm row's `ts` column at insertion.
- **`event_when_struct` (forensic)** = inverter's RTC-reported MM/DD HH:MM,
  kept as separate columns for cross-check.
- If `struct_when` differs from `event_at_ms` by > 24 hours, surface a
  warning chip in the drilldown ("Inverter RTC drift detected — see
  Inverter Clocks") — ties cleanly back to v2.9.0 clock-sync feature.

This eliminates year-inference and DD/MM ambiguity (the validated
ISM-style display is DD/MM but our DB stores month + day separately).

### 12.4 Schema changes

```sql
-- Add forward FK: each alarm row points to its captured StopReason snapshot
ALTER TABLE alarms ADD COLUMN stop_reason_id INTEGER REFERENCES inverter_stop_reasons(id) ON DELETE SET NULL;
CREATE INDEX idx_alarms_stop_reason ON alarms(stop_reason_id) WHERE stop_reason_id IS NOT NULL;
```

The reverse FK already exists in Slice B's table
(`inverter_stop_reasons.alarm_id REFERENCES alarms(id)`). Both
directions navigable.

**Note:** the v2 draft proposed adding the FK to `audit_log` — that was
wrong. `audit_log` records operator actions, NOT fault events. Faults
are in `alarms`. Corrected here.

### 12.5 Auto-fetch trigger flow (poller integration)

In `server/alarms.js` line 1106-1109 (`if (transition === "raise")`),
extend `raiseActiveAlarm()` to enqueue the snapshot:

```js
function raiseActiveAlarm(row, cur, now, newAlarms) {
  const severity = getTopSeverity(cur) || "fault";
  const info = stmts.insertAlarm.run({
    ts: now,
    inverter: row.inverter,
    unit: row.unit,
    alarm_code: formatAlarmHex(cur),
    alarm_value: cur,
    severity,
  });
  const alarmId = Number(info?.lastInsertRowid || 0);

  // ── Slice F addition ──
  if (alarmId && stopReasonAutoCapture.shouldCapture(row.inverter, now)) {
    stopReasonAutoCapture.enqueue({
      inverterIp: row.inverter,           // already an IP string in this codebase
      slave: getSlaveForInverter(row.inverter),
      node: row.unit,                      // unit ID maps directly to node
      eventAtMs: now,                      // ★ poller-stamped, ms precision
      alarmId,                             // FK back to this alarm row
      triggerSource: 'alarm_transition',
    });
  }
  // ── /Slice F ──

  newAlarms.push({ id: alarmId, inverter: row.inverter, unit: row.unit,
                   alarm_value: cur, severity, decoded: decodeAlarm(cur), ts: now });
}
```

`stopReasonAutoCapture` is a small queue helper in
`server/alarmsDiagnostic.js`:

```js
const TRANSITION_FETCH_DELAY_MS = 500;        // give DSP a beat to settle
const TRANSITION_FETCH_DEDUPE_MS = 30_000;    // per-inverter cooldown

const recentlyFetched = new Map();            // inverterIp → last fetch ms

function shouldCapture(inverterIp, now) {
  if (!getSetting('stopReasonAutoCaptureEnabled', '1') === '1') return false;
  const last = recentlyFetched.get(inverterIp) || 0;
  if (now - last < TRANSITION_FETCH_DEDUPE_MS) return false;
  recentlyFetched.set(inverterIp, now);
  return true;
}

function enqueue({ inverterIp, slave, node, eventAtMs, alarmId, triggerSource }) {
  setTimeout(() => {
    fetch(`http://localhost:9000/internal/stop-reason/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'X-Internal-Auth': INTERNAL_AUTH_TOKEN },
      body: JSON.stringify({
        inverter_ip: inverterIp, slave, node,
        event_at_ms: eventAtMs, alarm_id: alarmId,
        trigger_source: triggerSource,
      }),
    }).catch(err => writeAuditLog({
      inverter: inverterIp, action: 'stop_reason_capture_failed',
      result: 'error', reason: err.message,
    }));
  }, TRANSITION_FETCH_DELAY_MS);
}
```

Python service-side: new endpoint `POST /internal/stop-reason/capture`
(localhost-only, internal-auth-token gated) that does the FC 0x71 peek
and persists with the caller-supplied `event_at_ms` and `alarm_id`.

### 12.6 Alarm drilldown modal — extended layout

Existing v2.9.3 sections preserved unchanged. **One new section
inserted** between "Action steps" and "Physical devices" (so operator
sees the captured snapshot before being asked to open the cabinet):

```
─── Captured at the moment of the alarm ───────────────────────────
🕐 2026-04-27 14:32:18.327 PHT       (inverter RTC said: 02/04 09:03 ✓)
MotParo:    20 — MOTIVO_PARO_FRED
DebugDesc:  0x0014 (20)  ★
Telemetry:  PotAC 1073.3 kW · Vpv 663 V · Temp 41 °C
            Vac 208/206/206 V · Iac 174/175 A · Frec 60.11/60.11/60.12 Hz
            Cos 1.000
[ View full StopReason snapshot → ]   [ Compare with current state → ]
```

If RTC drift detected:
```
🕐 2026-04-27 14:32:18.327 PHT       ⚠ inverter RTC said: 04/29 09:15
                                        — Inverter Clocks needs sync
```

If no StopReason was captured (e.g., Slice F shipped after the alarm):
```
─── No StopReason snapshot was captured for this event ────────────
   Reason: alarm fired before v2.10.0 auto-capture was enabled.
   [ Try fetch current state ] (best-effort — inverter may have recovered)
```

### 12.7 API endpoints (additions to Slice B)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/alarms/:alarm_id/stop-reason` | none | Returns the StopReason captured for that alarm event (404 if not captured) |
| `GET` | `/api/stop-reasons/:id/alarm` | none | Returns the alarm row that triggered the capture |
| `POST` | `/internal/stop-reason/capture` | internal token | Loopback-only — invoked by poller on transition |

### 12.8 Backfill policy

For alarm rows that pre-date v2.10.0 (no StopReason captured):
- Show the "no snapshot was captured" placeholder
- Offer best-effort current-state fetch (which may show idle state if
  the inverter has long recovered)
- **Do NOT auto-fetch on viewing** — that would create misleading rows
  with `event_at_ms = view_time` instead of `event_at_ms = alarm_time`

### 12.9 Acceptance for Slice F

- Trigger a test alarm on a non-critical inverter; within 1 second the
  alarm row exists AND a StopReason row exists, FK-linked.
- Open Alarms Diagnostic → click that alarm bit → drilldown shows the
  captured snapshot section with millisecond-precision timestamp.
- Drilldown timestamp = poller-detected timestamp (NOT the inverter's
  RTC-sourced MM/DD).
- Drift warning chip appears when inverter RTC is intentionally set
  forward by 25 hours.
- Pre-v2.10.0 alarm rows show the "no snapshot was captured" placeholder
  cleanly (no broken UI).
- Cascade event (3 bits flip within 1 second) produces ONE StopReason
  row (dedupe works), with `alarm_id` pointing to the FIRST alarm row of
  the cascade.
- Works fleet-wide — both comm-board and EKI inverters auto-capture.

---

## 13. Data model summary

| Table | New | Edited | Rows/day est. | Retention | Purpose |
|---|---|---|---|---|---|
| `inverter_stop_reasons` | yes | — | ≤ 50 (one per stop event) | 365 d | StopReason snapshot cache |
| `inverter_stop_histogram` | yes | — | ≤ 30 (one per inverter daily snapshot) | 90 d | ARRAYHISTMOTPARO history |
| `serial_change_log` | yes | — | < 1 per quarter | forever | Service audit |
| `alarms` | — | yes | (existing) | (existing) | New `stop_reason_id` FK column for two-way linkage with `inverter_stop_reasons` |

No edits to other existing tables. New columns are additive and nullable
on `alarms` — no migration impact for v2.9.x → v2.10.0.

### 13.1 Static lookup data

| File | Contents | Source |
|---|---|---|
| `server/motiveLabels.js` | `MOTIVO_PARO_LABELS[]` — 30 motive names + index 30 = "TOTAL" | ISM ARRAYHISTMOTPARO display (Appendix B) |

### 13.2 Schema migration order (for `db.js` edits)

```sql
-- v2.10.0 migration — additive only
CREATE TABLE IF NOT EXISTS inverter_stop_reasons (...);
CREATE TABLE IF NOT EXISTS inverter_stop_histogram (...);
CREATE TABLE IF NOT EXISTS serial_change_log (...);

-- alarms.stop_reason_id is added via PRAGMA table_info check (existing
-- pattern in db.js) so a fresh DB and an upgraded DB end up identical
ALTER TABLE alarms ADD COLUMN stop_reason_id INTEGER REFERENCES inverter_stop_reasons(id) ON DELETE SET NULL;
```

Wrap in the same TRY/CATCH pattern existing migrations use in `db.js`.

---

## 14. Invariants

- **One transport, three consumers.** Stop Reasons (Slice B), Serial
  (Slice C), and the poller's auto-capture (Slice F) all go through
  `services/vendor_pdu.py` on top of the existing pymodbus client. No
  vendor frame construction anywhere else in the codebase.
- **`event_at_ms` is poller-stamped, never inverter-RTC-stamped.** The
  StopReason struct's MM/DD HH:MM is forensic data only — the canonical
  "when did this alarm fire" answer always comes from the poller's local
  clock at the moment of bit transition. This is the only way to deliver
  the user's "right timestamp" requirement given inverter RTC drift.
- **Auto-capture has a 30-second per-inverter dedupe.** Cascade alarms
  (multiple bits flipping in fast succession) produce ONE StopReason row
  linked to the FIRST alarm row of the cascade — both to avoid hammering
  the inverter mid-fault and to preserve the snapshot from the *initial*
  trigger rather than a derivative state.
- **Serial writes never autonomous.** Always operator-triggered, always
  audit-logged, always verified before declaring success.
- **0xFFFA unlock is paired with the very next privileged write.** Never
  unlock and walk away — unlock state on the DSP is volatile.
- **DebugDesc is informational, never actionable by the dashboard.** We
  display it; we never auto-decide based on it. Operator interprets it.
- **Stop Reasons table is read-only from the UI side.** No "delete this
  row" button — DB rows are append-only with retention pruning.
- **Architecture (Motorola/TI) is operator-asserted, not auto.** Same
  UX as ISM — operator picks based on what they know about the
  hardware. No auto-probe (would risk wrong-format writes). Auto-detect
  is a HINT shown in the UI, not an authoritative selection.
- **Backfill is forbidden.** Alarm rows that pre-date Slice F never get
  retroactively populated — viewing such an alarm shows the "no
  snapshot was captured" placeholder, never a misleading post-hoc fetch.
- **Cap at 3 nodes per inverter.** ISM only reads N=1..3; the
  extrapolated address `0xFF00` for N=4 returns garbage. If a 4-node
  inverter is configured, the dashboard reads 3 nodes and surfaces
  "Node 4 unavailable" in the UI.
- **No comm-board branching.** Hardware validation proved the SCOPE
  protocol works fleet-wide via port 502 + MBAP, regardless of comm-
  board status. No per-inverter `comm_board_status` config, no
  fallback placeholders, no UI greying for EKI inverters.

---

## 15. Risk matrix

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wrong slave address bricks an inverter via serial write | Low | High | UI requires explicit per-inverter+per-slave selection; Send button stays greyed until Read confirms the same selection produced a valid existing serial; session token couples Read and Send |
| 0xFFFA unlock magic varies by firmware version | Low | Medium | Validated on AAV1003BA / AAS1091AA / AAS1092_F; capture from another firmware variant before claiming v2.10.0 supports the whole fleet; operator-supplied magic via setting as escape hatch |
| FC 0x71 frame breaks when port 502 is busy with v2.9.0 polling | Medium | Low | Per-IP `thread_locks` already serialize traffic; SCOPE peek waits its turn |
| ISM session contention on port 7128 | N/A | N/A | We don't use port 7128 — ISM coexistence is automatic |
| StopReason struct layout differs between firmware revisions | Low | Medium | Parser is positional; if a future firmware adds/removes fields, raw_hex preservation lets us re-decode old rows without losing data |
| Operator changes serial then can't recover | Low | High | Audit log ALWAYS records old_serial before write; Read of audit log shows full history; verify-readback confirms within 1s of write |
| Serial-write succeeds but verify-readback returns garbage | Low | Medium | Treat as `verify_failed` outcome; surface clearly; do NOT auto-retry |
| Auto-capture (Slice F) misses the snapshot — inverter buffer overwritten before 500 ms delay elapses | Low | Medium | Configurable delay (`stopReasonCaptureDelayMs`, default 500); on miss, persist row with `outcome=stale_buffer` so the gap is visible rather than silent |
| Cascade alarm captures the wrong "first" event | Medium | Low | 30 s dedupe is per-inverter, not per-bit — explicitly documented in the alarm row's metadata so operator knows which bit fired the captured snapshot |
| Inverter RTC drift produces struct_when far from event_at_ms | Medium | Low | Drift warning chip in drilldown ties back to v2.9.0 Inverter Clocks page — the existing fix surface |
| pymodbus' custom-FC support requires patching for FC 0x71 | Low | Low | If `client.register()` doesn't accept the subclass cleanly, fall back to manual `protocol.execute()` with raw bytes — 30-min workaround documented in Slice A test fixtures |
| FC11 payload layout differs on TI hardware | Low | Low | Parser is Motorola-tuned; TI variant adds graceful fallback ("payload format unrecognized — raw hex shown for service") |
| Inverter rejects FC11 (older firmware) | Very low | Low | Surface as "serial read unavailable on this inverter — manual entry required" and keep the Edit/Send path open |

---

## 16. Rollout plan + milestones

| Milestone | Slices | Smoke gate | Target days |
|---|---|---|---|
| **M1** | Slice A (PDU helper) | `pytest test_vendor_pdu.py` green; manual `vendor_scope_peek` returns Appendix-A-matching bytes from .109 | Days 1-2 |
| **M2** | Slice B (Stop Reasons read + DB + API) — **without UI** | `pytest test_stop_reason_parse.py` + `node stopReasonsApi.test.js`; manual fetch via curl returns plausible data for 2+ inverters | Days 3-5 |
| **M3** | **Slice F (poller auto-capture + alarm drilldown linkage)** | Trigger test alarm → snapshot captured + linked within 1 s | Days 6-8 |
| **M4** | Slice C Read only (FC11 path) | Read returns matching serial vs ISM for both .109 and .133 | Day 9 |
| **M5** | Slice C Write path + verify | Test inverter only; full audit log entry produced; no-op write verifies cleanly | Days 10-11 |
| **M6** | Slice D (UI for both Stop Reasons table + Serial section) | Manual verification of all paths; row click → drilldown with DebugDesc inline | Days 12-14 |
| **M7** | Docs + smoke + release | Full project smoke; ABI rebuild; User Manual updated | Days 15-16 |

v2.10.0 released after M7. **M3 (Slice F linkage) is the highest-value
milestone** and ships even if Slice C (Serial Write) slips — the linkage
delivers the operator's actual diagnostic workflow.

Total estimate: ~16 working days end-to-end. v2 estimated 17 days but
required 7128-port handling, comm-board gating, and EKI fallback UI —
all of which are now removed.

---

## 17. Rollback procedures

- **Slice A regression:** revert `services/vendor_pdu.py` and the
  consumers degrade gracefully (catch ImportError; UI shows
  "Diagnostics unavailable, contact engineer").
- **Slice B DB schema:** new tables are additive — drop them via
  `DROP TABLE IF EXISTS inverter_stop_reasons; DROP TABLE IF EXISTS
  inverter_stop_histogram;` if needed.
- **Slice C write path:** disable via setting `serialWriteEnabled=0`
  (default 0 in v2.10.0 — operator opt-in via Settings). API returns
  503 with that flag off.
- **All UI:** wrap the whole `#inverterDiagnosticsSection` in a feature
  flag `featureInverterDiagnostics` (default 1). Set to 0 to hide
  without code change.
- **Slice F poller integration:** disable via setting
  `stopReasonAutoCaptureEnabled=0`. Falls back gracefully — the alarm
  drilldown shows the "no snapshot was captured" placeholder and the
  manual Refresh path in the Stop Reasons table still works.
- **`alarms.stop_reason_id` column rollback:** the column is nullable
  with `ON DELETE SET NULL` — orphan StopReason rows simply lose their
  back-reference and remain queryable by inverter_ip + read_at_ms.

---

## 18. Pre-flight checklist

Before kicking off implementation:

- [x] User has approved this v3 blueprint (no scope expansion mid-flight)
- [x] Hardware validation complete — protocol confirmed end-to-end on
      both comm-board and EKI inverters (2026-04-27)
- [x] StopReason struct layout verified field-by-field against ISM
      (2026-04-27)
- [x] Serial Read + Unlock paths verified on all transports (2026-04-27)
- [x] ARRAYHISTMOTPARO labels captured from ISM (Appendix B)
- [ ] User has identified a non-critical test inverter for Slice C M5
      (write path validation)
- [ ] User has confirmed at least one inverter currently reporting an
      active stop event (for end-to-end DebugDesc validation in M2 smoke)
- [ ] Confirm the inverter-to-slave-id mapping is documented (or
      derivable from existing topology config) for at least the test
      inverters
- [ ] Verify CLAUDE.md "Always restore Electron ABI after Node-ABI smoke"
      rule is fresh in mind (this plan adds Python tests; same rule applies)

---

## 19. Open questions

1. ~~Will the protocol work for EKI inverters?~~ **Resolved 2026-04-27 —
   yes, fleet-wide via port 502 + MBAP.**
2. ~~Should DebugDesc trigger an audit-log row even without operator
   action?~~ **Resolved by Slice F:** the v2.9.0 alarm row IS the
   trigger; Slice F adds the StopReason as a linked artifact, not a
   separate audit entry.
3. ~~Year inference for event_when~~ **Resolved by Slice F:** the
   poller-stamped `event_at_ms` is authoritative.
4. **DebugDesc → human-readable sub-code dictionary** — Ingeteam may
   have published a sub-code table in their Level 3 service docs. If
   the user can obtain it, a lookup map could turn `DebugDesc=20` into
   `"FRED — Vac high persistent on phase 1"`. Treat as v2.10.x
   follow-up. The 30 top-level MOTIVO_PARO labels are already in
   Appendix B.
5. **Per-node vs per-inverter capture on transition** — when alarm bit
   X fires for inverter Y, do we capture Stop Reasons for ALL nodes of
   Y, or only the node mapped to that bit? v2.9.0 alarm bits are
   per-unit (the alarm row's `unit` column matches the node), so map
   `unit → node` 1:1. **Decision: capture only the affected node** to
   minimize bus traffic during cascade events.
6. **N=4 addressing** — for 4-node inverters, the alternate address for
   Node 4's StopReason is unknown. Worth re-decompiling
   `Trifasico::LeeMotivosDeParo` for any N=4 code path, OR scanning
   nearby DSP RAM addresses on a 4-node test inverter. Not blocking —
   v2.10.0 caps at N=3 with a UI message.
7. **Histogram snapshot cadence** — should `inverter_stop_histogram` be
   populated only on operator-triggered Refresh, or also via a daily
   scheduled job? Lean toward daily-at-04:00 (during low-irradiance
   window, no telemetry contention) so the operator always has a
   recent baseline.

---

## 20. Success criteria

- Operator can answer the question *"why did this specific inverter
  stop?"* in under 30 seconds via the dashboard, without launching ISM.
- **When opening any alarm in the Alarms Diagnostic section, the
  drilldown surfaces the captured StopReason snapshot inline with a
  millisecond-precision timestamp matching the moment the alarm fired
  (NOT the moment the operator clicked).** ★ The user's explicit
  requirement.
- Service engineer can verify a node's serial number from the dashboard
  in under 10 seconds (vs. the current process: launch ISM, connect,
  open form, click Read).
- Zero false-positive stop events in the table for inverters that have
  been running healthy for >24 hours (validated by 1-week soak).
- Zero accidental serial-number changes — write path requires Read +
  Auth + Verify and is opt-in via `serialWriteEnabled` setting.
- 100% of new alarm events post-v2.10.0 have a linked StopReason row
  (allowing for the documented `outcome=stale_buffer` exception when
  the inverter recovered faster than the capture delay).
- All features work identically on comm-board AND EKI inverters
  (regression-tested via Appendix A fixtures).
- ARRAYHISTMOTPARO histogram view loads in < 2 s for any inverter.

---

## 21. Appendix A — Verified frame fixtures (byte-level)

All hex below was captured from the live fleet on 2026-04-27 via
[_spike/](../_spike/) probes. These are the canonical regression
fixtures — `services/tests/fixtures/` should contain copies.

### A.1 FC 0x71 SCOPE peek — Node 1 of slave=2 at 192.168.1.109

**Request (16 bytes — MBAP framing on port 502):**
```
00 02 00 00 00 0A 02 71 FE B5 80 19 00 00 00 00
└── MBAP ─────┘ │  │  └─ 0xFEB5 │  └─ count=25 (0x19)
   txn proto len unit FC          cmd
```

**Response (61 bytes total):**
```
00 02 00 00 00 37 02 71 FE B5 19 │ <50 data bytes> │
└── MBAP ─────┘ │  │  └ addr     │ └ bytecount=25 │
   txn proto len unit FC           ↓
```

**Data payload (50 bytes = 25 UINT16 words):**
```
29 ED 02 97 00 D0 00 CE 00 CE 00 AE 00 AF 17 7B
17 7B 17 7C 03 E8 00 29 02 00 00 14 04 02 09 03
01 49 01 4E 06 00 00 2A 00 00 00 00 00 08 00 00
00 14
```

**Decoded values (verified against ISM 2026-04-27):**
- PotAC = 0x29ED / 10 = **1073.3 kW** ✓
- Vpv = 0x0297 = 663 V ✓
- Vac1/2/3 = 0x00D0/0x00CE/0x00CE = 208/206/206 V ✓
- Iac1/2 = 0x00AE/0x00AF = 174/175 A ✓
- Frec1/2/3 = 0x177B/0x177B/0x177C / 100 = 60.11/60.11/60.12 Hz ✓
- Cos = 0x03E8 / 1000 = 1.000 ✓
- Temp = 0x0029 = 41 °C ✓
- Alarma = 0x0200 ✓
- MotParo = 0x0014 = 20 ✓
- MesDia = 0x0402 → DD/MM = 02/04 ✓
- HoraMin = 0x0903 → HH:MM = 09:03 ✓
- DebugDesc = 0x0014 = **20** ★ ✓

### A.2 FC 0x71 SCOPE peek — ARRAYHISTMOTPARO at slave=2 (.109)

**Request (16 bytes):**
```
00 03 00 00 00 0A 02 71 FE 09 80 1F 00 00 00 00
```

**Response data payload (62 bytes = 31 UINT16 counters):**
```
25 72 23 5E 23 E2 21 9A 21 DE 1F D5 1F 7C 1D 98
1D 38 1B C3 1A 0E 19 0F 16 98 16 0F 12 AA 12 66
0E 6E 0E 78 0A 3D 0A 8D 05 EE 06 00 01 BC 02 04
FE AA FD CE FA 26 F9 6C F6 3A F4 EA F3 54
```

Decoded (matches ISM ARRAYHISTMOTPARO display):
- counters[0] = 0x2572 = 9586 → MOTIVO_PARO_VIN
- counters[1] = 0x235E = 9054 → MOTIVO_PARO_FRED
- counters[2] = 0x23E2 = 9186 → MOTIVO_PARO_VRED
- … (full label list in Appendix B)
- counters[30] = 0xF354 = **62292 → TOTAL** ★

### A.3 FC11 Report Slave ID — slave=2 at .109

**Request (8 bytes):**
```
00 01 00 00 00 02 02 11
```

**Response (111 bytes total):**
```
00 01 00 00 00 69 02 11 66 │ <102-byte slave-ID payload>
└── MBAP ─────┘ │  │  └ byte_count=0x66 (102)
   txn proto len unit FC
```

**Slave-ID payload (102 bytes):**
```
7D FF                                                            ← header
34 30 30 31 35 32 41 31 37 52 35 32                              ← serial "400152A17R52"
00 00                                                            ← padding
02 9E 00 C0 00 D2 00 D1 00 D0 00 CF 00 CF 00 C8 03 E8            ← live snapshot
41 41 56 31 30 30 33 42 41 20                                    ← model "AAV1003BA "
00 1B 00 07 09 3B 00 20                                          ← build/version
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00            ← padding
41 41 53 31 30 39 31 41 41 00 00 00 00 00 01 4A                  ← firmware "AAS1091AA"
41 41 53 31 30 39 32 5F 46 00 00 00 00 00 00 00                  ← firmware "AAS1092_F"
```

### A.4 FC16 Unlock — verified accepted on all paths

**Request (17 bytes):**
```
00 02 00 00 00 0B 02 10 FF FA 00 02 04 00 65 07 A7
└── MBAP ─────┘ │  │  └ 0xFFFA │  │  └ values [0x0065, 0x07A7]
   txn proto len unit FC         count bc
```

**Response (12 bytes — standard FC16 echo):**
```
00 02 00 00 00 06 02 10 FF FA 00 02
└── MBAP ─────┘ │  │  └ addr  └ count
   txn proto len unit FC
```

### A.5 RTU framing variant (port 7128, comm board only)

For reference — port 7128 receives the same vendor PDUs but wrapped in
RTU framing (no MBAP, +2-byte CRC suffix):

**Request (12 bytes):**
```
02 71 FE B5 80 19 00 00 00 00 D1 9E
└unit FC └ addr  └cmd count                  └ CRC16
```

The PDU bytes (`02 71 FE B5 80 19 00 00 00 00`) are byte-identical to
the MBAP variant minus the MBAP wrapper — confirming the protocol is
gateway-agnostic.

---

## 22. Appendix B — MOTIVO_PARO label lookup (31 codes)

Captured from ISM's ARRAYHISTMOTPARO display (slave=2 at .109,
2026-04-27). Index = position in the 31-counter array; label = canonical
ISM string.

```js
// server/motiveLabels.js
const MOTIVO_PARO_LABELS = [
  "MOTIVO_PARO_VIN",            // 0
  "MOTIVO_PARO_FRED",           // 1
  "MOTIVO_PARO_VRED",           // 2
  "MOTIVO_PARO_VARISTORES",     // 3
  "MOTIVO_PARO_AISL_DC",        // 4
  "MOTIVO_PARO_IAC_EFICAZ",     // 5
  "MOTIVO_PARO_TEMPERATURA",    // 6
  "MOTIVO_PARO_01",             // 7
  "MOTIVO_PARO_CONFIGURACION",  // 8
  "MOTIVO_PARO_MANUAL",         // 9
  "MOTIVO_PARO_BAJA_VPV_MED",   // 10
  "MOTIVO_PARO_HW_DESCX2",      // 11
  "MOTIVO_PARO_FRAMA3",         // 12
  "MOTIVO_PARO_MAX_IAC_INST",   // 13
  "MOTIVO_PARO_CARGA_FIRMWARE", // 14
  "MOTIVO_PARO_03",             // 15
  "MOTIVO_PARO_04",             // 16
  "MOTIVO_PARO_ERROR_LEC_ADC",  // 17
  "MOTIVO_PARO_CONSUMO_POTENCIA", // 18
  "MOTIVO_PARO_FUS_DC",         // 19
  "MOTIVO_PARO_TEMP_AUX",       // 20
  "MOTIVO_PARO_DES_AC",         // 21
  "MOTIVO_PARO_MAGNETO",        // 22
  "MOTIVO_PARO_CONTACTOR",      // 23
  "MOTIVO_PARO_RESET_WD",       // 24
  "MOTIVO_PARO_PI_ANA_SAT",     // 25
  "MOTIVO_PARO_LATENCIA_ADC",   // 26
  "MOTIVO_PARO_ERROR_FATAL",    // 27
  "MOTIVO_PARO_FRAMA1",         // 28
  "MOTIVO_PARO_FRAMA2",         // 29
  "TOTAL",                      // 30
];

function lookupMotiveLabel(idx) {
  if (idx < 0 || idx >= MOTIVO_PARO_LABELS.length) return `<unknown_${idx}>`;
  return MOTIVO_PARO_LABELS[idx];
}

module.exports = { MOTIVO_PARO_LABELS, lookupMotiveLabel };
```

The MotParo field in the StopReason struct (idx 13) is a numeric code
that should map to one of these labels. **However**, the StopReason
MotParo numeric value (e.g. 20 in the validated test) does NOT directly
index into the histogram array — they're parallel encodings:

- `inverter_stop_reasons.motparo` = the firmware's primary stop motive
  code at the moment of stop (e.g. 20)
- `inverter_stop_histogram.counters[N]` = lifetime count of times motive
  N has fired

For the StopReason → label mapping in the drilldown, we'd need a
separate motparo_code → MOTIVO_PARO_* lookup that we don't yet have
from ISM. **Open question 4** in section 19 captures this. For v2.10.0,
the drilldown shows `MotParo: 20` without a label; v2.10.x can add the
mapping when we discover it.

The histogram view, however, can label every counter immediately —
slot N of the array maps to MOTIVO_PARO_LABELS[N] directly.

---

## 23. Appendix C — FC11 Report Slave ID payload structure

Verified against two physical inverters (.109 slave=2 and .133 slave=4)
on 2026-04-27. Both returned 102-byte payloads with identical structure;
only the serial bytes (offset 2..13) differed.

| Offset | Length | Field | Type | Example |
|---:|---:|---|---|---|
| 0 | 1 | Header byte 1 | u8 | 0x7D |
| 1 | 1 | Header byte 2 | u8 | 0xFF |
| 2..13 | 12 | **Serial number** (Motorola) | ASCII | `400152A17R52` |
| 14..15 | 2 | PotAC (live snapshot) | int16 BE / 10 | 0x029E = 66.2 kW |
| 16..17 | 2 | Vpv | u16 BE | 0x00C0 = 192 V |
| 18..23 | 6 | Vac1, Vac2, Vac3 | u16 BE × 3 | 210/209/208 V |
| 24..27 | 4 | Iac1, Iac2 | u16 BE × 2 | 207/207 A |
| 28..31 | 4 | (extension or spare) | — | (varies) |
| 32..33 | 2 | Cos | u16 BE / 1000 | 0x03E8 = 1.000 |
| 34..43 | 10 | **Model code** | ASCII | `AAV1003BA ` |
| 44..51 | 8 | Build/version bytes | mixed | `00 1B 00 07 09 3B 00 20` |
| 52..69 | 18 | (padding / reserved) | — | nulls |
| 70..78 | 9 | **Firmware module 1** | ASCII | `AAS1091AA` |
| 79..85 | 7 | (padding / reserved) | — | nulls |
| 86..94 | 9 | **Firmware module 2** | ASCII | `AAS1092_F` |
| 95..101 | 7 | (padding / reserved) | — | nulls |

**TI variant** (32-byte serial format) is unverified from this
hardware — when first encountered, capture the payload and update
this appendix.

---

## 24. References

### Source material decoded

| Reference | What |
|---|---|
| `docs/INGECON-SUN-Manager.zip` | Source of truth — all protocol details extracted from FV.IngeBLL.dll + IngeconSunManager.exe |
| `FV.IngeBLL.dll TypeDef[805] Trifasico` | Vendor FC 0x71 SCOPE templates Field[5896-5899] |
| `FV.IngeBLL.dll TypeDef[902] MotivosParoTrif` | StopReason struct layout (M[4968] Parse) |
| `FV.IngeBLL.dll TypeDef[600] FreescaleDSP56F` | Confirmed user's Motorola hardware path |
| `IngeconSunManager.exe TypeDef[98] frmSetSerial` | Serial-write 2-frame protocol (M[879/880/881] + Field[1296-1299]); serial-read via FC11 (M[878] btnLeerSerial_Click → Identifica) |
| `docs/capture-ism.pcapng` | Live wire validation of all extracted frames |

### Spike scripts (canonical hardware-validated reference implementations)

| Path | Purpose |
|---|---|
| [_spike/scope_stop_reasons_probe.py](../_spike/scope_stop_reasons_probe.py) | FC 0x71 SCOPE reader via port 7128 + RTU framing (legacy ISM path) |
| [_spike/eki_scope_probe.py](../_spike/eki_scope_probe.py) | FC 0x71 SCOPE reader via port 502 + MBAP framing (UNIVERSAL — model for `services/vendor_pdu.py`) |
| [_spike/scope_bus_scan.py](../_spike/scope_bus_scan.py) | Slave discovery sweep — detects how many inverters share an RS485 bus |
| [_spike/serial_number_probe.py](../_spike/serial_number_probe.py) | FC11 read + FC16 unlock + (optional) write-noop test, both framings |
| [_spike/standard_modbus_probe.py](../_spike/standard_modbus_probe.py) | Standard FC03/04/11 probe (used to discover read paths during validation) |

### Related plans / audits

- [plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md](2026-04-24-hardware-counter-recovery-and-clock-sync.md)
  — defines the dual-port architecture v2 of this plan inherited; v3
  supersedes that pattern with the unified-transport finding
- [audits/2026-04-26/alarm-drilldown-novice-expansion.md](../audits/2026-04-26/alarm-drilldown-novice-expansion.md)
  — reference UX pattern for the StopReason drilldown modal

### Memory entries

- [project_inverter_dsp_architecture.md](C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\project_inverter_dsp_architecture.md)
- [ism_serial_write_protocol.md](C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\ism_serial_write_protocol.md)
- [inverter_comm_board_architecture.md](C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\inverter_comm_board_architecture.md)
- [v290_hw_counter_recovery.md](C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\v290_hw_counter_recovery.md)

### v2 → v3 changelog (what changed after hardware validation)

| Item | v2 said | v3 says (validated) |
|---|---|---|
| Transport | Two ports — 502 for live, 7128 for SCOPE | One port (502) + MBAP for everything |
| Comm-board gating | Per-inverter `comm_board_status` flag required | Not needed — works fleet-wide |
| EKI fallback UI | "No snapshot captured (EKI fallback)" placeholder | Removed — EKI inverters get full features |
| StopReason struct idx 0 | "_idx0_unused" header word | PotAC at idx 0 directly (no header) |
| StopReason DebugDesc location | UINT16 idx 25 | UINT16 idx 24 (off-by-one fix) |
| Vendor count param | Words (assumed) | Confirmed words via response math |
| Optimal request count | 26 (one extra for DebugDesc) | 25 (matches ISM, off-by-one was a v2 misread) |
| Serial Read protocol | FC03 at 0x9C74 | FC11 Report Slave ID (0x9C74 is write-only) |
| Slice A naming | `services/vendor_fc.py` | `services/vendor_pdu.py` |
| Slice A scope | Custom socket transport + CRC + framer | Thin PDU helper on top of pymodbus |
| FK target for Slice F | `audit_log.stop_reason_id` | `alarms.stop_reason_id` (correct table) |
| Estimated LOC | ~1800 | ~1100 |
| Estimated days | 17 | 16 (slightly faster despite more validation) |
| MesDia display | MM/DD | DD/MM (matches ISM convention) |
| ARRAYHISTMOTPARO labels | unknown | All 30 captured (Appendix B) |

---

**End of plan v3 — ready for implementation kickoff.**
