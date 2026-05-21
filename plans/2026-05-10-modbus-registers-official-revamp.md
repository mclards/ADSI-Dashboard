# Modbus Registers — Official Ingeteam Map Revamp

| Field | Value |
|---|---|
| Date | 2026-05-10 |
| Status | DRAFT — awaiting operator review |
| Owner | Engr. Clariden Montaño REE (Engr. M.) |
| Source-of-truth | [docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf](../docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf) — AAS1000ICB08, Ingeteam Power Technology S.A., 09/01/2013 |
| Related plans | [2026-04-24-hardware-counter-recovery-and-clock-sync.md](2026-04-24-hardware-counter-recovery-and-clock-sync.md) · [2026-04-27-stop-reasons-table-and-serial-number-setting.md](2026-04-27-stop-reasons-table-and-serial-number-setting.md) · [2026-05-04-curtailment-control.md](2026-05-04-curtailment-control.md) |
| Compliance references | [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) · [docs/Grid_Compliance_Testing_Manual_PGC2016.docx](../docs/Grid_Compliance_Testing_Manual_PGC2016.docx) · [docs/Ingeteam_Modbus_RTU_Manual.docx](../docs/Ingeteam_Modbus_RTU_Manual.docx) · [audits/2026-05-10/ngcp-grid-compliance-research.md](../audits/2026-05-10/ngcp-grid-compliance-research.md) |
| Plant context | Alterpower Digos Solar — ~24.84 MW, 27 INGECON SUN inverters, 108 string nodes, Mindanao PH (60 Hz NGCP grid) |
| PDF text extracts | [docs/IngeconSunPMax-Modbus-pg01.txt](../docs/IngeconSunPMax-Modbus-pg01.txt) … pg17.txt |

---

## §1 Goals & Non-Goals

### Goals

1. **Reconcile the dashboard's Modbus integration with the authoritative Ingeteam register reference.** Until now the codebase has been built from packet captures, ISM display cross-checks, and operator screenshots. We now have the manufacturer's full input + holding register list for the INGECON SUN three-phase family.
2. **Fix decode errors** where the public spec contradicts current code (signedness in particular).
3. **Capture useful fields we are leaving on the floor:** reactive power (QAC), authoritative inverter state, power-reduction status bits, time-to-connect countdown, nominal power as reported by the device, insulation impedances, control-electronics temperature, and the standard-Modbus stop-reason history.
4. **Close the APC control loop:** read back holding registers `41006` (power-reduction target) and input register `30117` bit 1 (`Modbus power reduction on`) after every curtailment write so the operator sees confirmation that the inverter accepted the setpoint.
5. **Unlock additional grid-code controls** documented by Ingeteam: reactive power injection (cmd 9 / 11 / 13 / 14) and restrictive frequency limits (cmd 12). **Note:** restrictive-freq cmd 12 in the PDF is specified for European 50 Hz CEI 0-21 (49.5/50.5 Hz). Our Philippine 60 Hz site does NOT use this command directly — frequency thresholds are set at inverter-firmware configuration time per NGCP Country Code 42, not via runtime Modbus. We capture the read-back at 41010 for visibility only.
6. **Document the protocol in-repo** as [docs/Inverter-Modbus-Reference.md](../docs/Inverter-Modbus-Reference.md) so future contributors stop reverse-engineering from packet captures.
7. **Lay the groundwork for NGCP Grid Compliance Test automation** (PGC 2016 Tests T1 / T2 / T3 / T5 — see Slice θ + [audits/2026-05-10/ngcp-grid-compliance-research.md](../audits/2026-05-10/ngcp-grid-compliance-research.md)). Slices α-δ produce the per-register telemetry foundation; Slice θ ties them into a witness-grade evidence engine.

### Non-Goals

- **NOT replacing the vendor FC 0x71 SCOPE peek path** ([services/stop_reason.py](../services/stop_reason.py)). The SCOPE peek goes deeper than the public spec (DebugDesc sub-codes, per-frame Vpv/Iac/Cos snapshot). Slice ε runs the standard-Modbus history alongside it for cross-check, not as a replacement.
- **NOT touching the vendor clock-sync transport** ([services/inverter_engine.py:1857](../services/inverter_engine.py#L1857)). Broadcast FC 0x10 to address 0 with `[Y, M, D, H, M, S]` is an Ingeteam vendor extension that this PDF does not document. Working in production; no reason to disturb.
- **NOT touching the Serial Number setter or FC11 Report Slave ID path.** Those are vendor extensions covered by [plans/2026-04-27-stop-reasons-table-and-serial-number-setting.md](2026-04-27-stop-reasons-table-and-serial-number-setting.md).
- **NOT touching the survival-boot block** in [electron/main.js](../electron/main.js) or the `app.asar` integrity gate. Per `MEMORY.md` → [power_loss_resilience.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/power_loss_resilience.md).
- **NOT pre-committing to a version number or a release.** Versioning + EXE rebuild + GitHub publishing are owned by `sub_releaser`. Each slice ships under whatever `2.10.x` or `2.11.x` line the maintainer chooses at release time.
- **NOT redesigning the Active Power Control feature** that landed in v2.10.x (slices C/D of [plans/2026-05-04-curtailment-control.md](2026-05-04-curtailment-control.md)). We *augment* it with read-back verification, we do not replace the write opcodes — they already match the public spec (cmd 3 / 5 / 6).

---

## §2 Authoritative Register Map

All addresses are **0-indexed on-the-wire** (Modbus convention). The PDF uses the human-readable `30001` / `41001` aliases. The map below shows both.

### 2.1 Input Registers — FC 0x04 (read-only) — PDF §2

#### Lifetime counters (PDF pg 4)

| Modbus alias | Wire addr | Field | Type | Scale / unit | Notes |
|---|---|---|---|---|---|
| 30001-30002 | 0-1 | `Etotal` | UInt32 hi-lo | kWh | Lifetime energy |
| 30003-30004 | 2-3 | `Hours up` | UInt32 hi-lo | hours | Lifetime running hours |
| 30005-30006 | 4-5 | `Conex` | UInt32 hi-lo | count | Lifetime grid-connection count |
| 30007-30008 | 6-7 | `Alarmas_Inv` | UInt32 hi-lo | bitfield | Latched alarm bitmap (16 documented bits, see §2.5) |

#### Live AC/DC metrics (PDF pg 4-5)

| Modbus alias | Wire addr | Field | Type | Scale / unit | Notes |
|---|---|---|---|---|---|
| 30009 | 8 | `Vdc` | UInt16 | V | DC bus voltage (1000 Vdc nominal — INGECON SUN PMax built-in) |
| 30010 | 9 | `Idc` | **Int16 signed** | A | "signed yes" per PDF — current code treats as unsigned |
| 30011-30013 | 10-12 | `Vac1/2/3` | UInt16 | V | Per-phase RMS grid voltage |
| 30014-30016 | 13-15 | `Iac1/2/3` | UInt16 | 0.1 A/LSB | Per-phase RMS grid current |
| 30017 | 16 | `CosFi` | UInt16 | thousandths | Cos(φ) × 1000 — drives PF for Slice ζ + NGCP T3 |
| 30018 | 17 | `SigSinFi` | UInt16 | flag | 0 = positive sin(φ), 1 = negative |
| 30019 | 18 | `PAC` | **Int16 signed** | tens of W | "signed yes" — current code clamps as unsigned |
| 30020 | 19 | `Fac2` | UInt16 | hundredths Hz | **Grid frequency. Philippine grid = 60 Hz nominal.** NGCP continuous band 59.7-60.3 Hz; withstand 58.2-61.8 Hz (NOT the European 50 Hz numbers in the PDF). |
| 30021-30026 | 20-25 | RTC year / month / day / hour / minute / second | UInt16 ×6 | – | Inverter wall clock |
| 30027 | 26 | `Pos_grad_solPor10` | UInt16 | degrees ×10 | Sun position (used by suntracker) |

#### Suntracker (skip — not deployed on this site)

PDF registers 30028-30041 cover suntrackers 1 & 2. Our 27 INGECON-SUN units have no trackers; reads will be `0` and the registers consume bandwidth in the wide-poll block. Decode but **do not surface in UI**.

#### Analog inputs (PDF pg 5-6)

| Modbus alias | Wire addr | Field | Notes |
|---|---|---|---|
| 30042-30045 | 41-44 | `Analog Input 1-4` | 12-bit ADC, 0-4095. Requires AAP0016 card. **Not installed today** — may be added later for a weather station (ambient temperature, irradiance, wind). Slice β decodes the regs into the frame; UI columns gated behind a settings toggle (default off). |
| 30046-30047 | 45-46 | `PT100 #1 / #2` | Temperature probes via AAP0016. Same handling as above. |

#### Resettable counters (PDF pg 6)

| Modbus alias | Wire addr | Field | Type | Scale | Notes |
|---|---|---|---|---|---|
| 30048-30058 | 47-57 | – | – | – | Reserved |
| 30059-30060 | 58-59 | `parcE` | UInt32 hi-lo | kWh | Partial energy since last reset (already used for crash-recovery seeding, v2.9.0) |
| 30061-30062 | 60-61 | Resettable hours | UInt32 hi-lo | hours | Not currently captured |
| 30063-30064 | 62-63 | Resettable connection count | UInt32 hi-lo | count | Not currently captured — could detect "power cycle since last poll" |

#### Alarm windows (PDF pg 6-7)

| Modbus alias | Wire addr | Field | Reset behavior |
|---|---|---|---|
| 30065-30066 | 64-65 | Instantaneous alarms (UInt32 hi-lo) | **Resets every 1 second** — useful for transient alarm UI |
| 30067-30068 | 66-67 | Maintained alarms (UInt32 hi-lo) | **Resets on grid reconnection** — mid-session memory |

Both share the same 16-bit bitmap layout as `Alarmas_Inv` at 30007-30008. See §2.5.

#### Diagnostic & state (PDF pg 7)

| Modbus alias | Wire addr | Field | Type | Scale | Notes |
|---|---|---|---|---|---|
| 30069 | 68 | `QAC` | **Int16 signed** | reactive W ÷10 | "signed yes" — **NOT CURRENTLY CAPTURED** |
| 30070 | 69 | `Zpos` | UInt16 | kΩ (per ISM) | Solar field impedance, POS-EARTH (insulation health) |
| 30071 | 70 | `Zneg` | UInt16 | kΩ | Solar field impedance, NEG-EARTH |
| 30072 | 71 | `TempCI` (power electronics) | **Int16 signed** | °C | Already captured; -1 ISM-parity offset applied. -14 = NTC sensor fault. |
| 30073 | 72 | Control electronics temperature | **Int16 signed** | °C | "TempINT" — second sensor, threshold 80 °C; **noted in code but not surfaced** |
| 30074 | 73 | **`Estado`** (inverter state) | UInt16 | bitfield | **Low byte:** 0=initial, 1=initial-magnetization, 2=grid-connected, 3=error. **High byte:** bit 0 = 1:Stop / 0:Run, bit 1 = blocked, bit 2 = grid fault detected. **NOT CURRENTLY CAPTURED — most authoritative status signal in the device.** |
| 30075 | 74 | `VpvN` | UInt16 | V | Solar field voltage NEGATIVE-EARTH (insulation diagnostic) |
| 30076 | 75 | `VpvP` | UInt16 | V | Solar field voltage POSITIVE-EARTH |
| 30077 | 76 | Nominal power ÷10 | UInt16 | tens of W | **Rated power as reported by the device.** Lets us cross-check the operator-configured `unitsCount × ratedKw`. |

#### Stop-reason history (standard Modbus) — PDF pg 7-8

| Modbus alias | Wire addr | Field | Notes |
|---|---|---|---|
| 30078 | 77 | Pos. last stop reason (0-4) | Index of newest entry in the 5-slot ring buffer |
| 30079-30084 | 78-83 | Stop reason 0: year / month / day / hour / minute / motive | 30 stop-motive codes documented (PDF pg 7-8) |
| 30085-30090 | 84-89 | Stop reason 1 | – |
| 30091-30096 | 90-95 | Stop reason 2 | – |
| 30097-30102 | 96-101 | Stop reason 3 | – |
| 30103-30108 | 102-107 | Stop reason 4 | – |

**Cross-walks to the existing vendor SCOPE peek** ([services/stop_reason.py](../services/stop_reason.py)): the standard-Modbus history exposes `(timestamp, motive_code)` only. The vendor SCOPE peek adds `Vpv`, `Iac1/2`, `Frec1/2/3`, `Cos`, `Temp`, `Alarma` snapshot, plus the `DebugDesc` vendor sub-code. Both are useful; Slice ε keeps both running.

#### Connection countdown (PDF pg 8)

| Modbus alias | Wire addr | Field | Notes |
|---|---|---|---|
| 30109 | 108 | Remaining seconds to grid connection | **Useful UI signal** — "starting in 47 s" |
| 30110 | 109 | Total seconds to connect | The configured island-connection timeout |

#### MS-mode mirrors (PDF pg 8-9)

| Modbus alias | Wire addr | Field | Notes |
|---|---|---|---|
| 30111-30115 | 110-114 | Mirrors of state / cos / sin / power / qac | **Only meaningful in master-slave installations.** Skip until §8 question is answered. |

#### Curtailment status (PDF pg 9)

| Modbus alias | Wire addr | Field | Notes |
|---|---|---|---|
| 30116 | 115 | 1000 V kit usage counter | Increments when 1000 Vdc operating mode engages; site-dependent |
| 30117 | 116 | **`Power reduction register`** | **Critical APC feedback bitfield.** See §2.6 below. |

### 2.2 Holding Registers — FC 0x10 (write) / FC 0x03 (read) — PDF §3

| Modbus alias | Wire addr | Field | RW | Notes |
|---|---|---|---|---|
| 41001 | 1000 (0x03E8) | Command code | RW | Range 0-14 (PDF says 0-12 in table but 13/14 documented) |
| 41002 | 1001 | Command data | RW | Per-command meaning |
| 41003-41005 | 1002-1004 | Reserved | R | – |
| 41006 | 1005 | **Power reduction target** | R | Q15: 0 = 0%, 32767 = 100%. **Read-back of last cmd-3 setpoint.** |
| 41007 | 1006 | **Phi tangent target** | R | Int16, ±15729 |
| 41008 | 1007 | **Reactive target** | R | Int16, ±32767 |
| 41009 | 1008 | Reserved | R | – |
| 41010 | 1009 | **Restrictive freq limits** | R | 0 = OFF (47.5/51.5 Hz), 1 = ON (49.5/50.5 Hz, CEI 0-21) |
| 41011-41012 | 1010-1011 | Reserved | R | – |

### 2.3 Command codes — PDF §3 pg 15-17

| Code | Action | Data parameter | Limits | Response data | Notes for our site |
|---|---|---|---|---|---|
| 0 | No-op | – | – | – | – |
| 1 | Change phi tangent target | Int16 phi×32767 | ±15870 (±0.48) | Current phi target | NGCP PGC GCR 4.4.4.1 PF 0.95 lag/lead → tan(φ) = ±0.329 → raw ±10780 (Slice ζ + Slice θ Test T3) |
| 2 | Read phi tangent target | – | – | Current phi target | – |
| **3** | **Change power-reduction target** | UInt16 Q15 | 0 (0%) … 32767 (100%) | Current Q15 | **Already implemented** (v2.10.x APC). Slice δ adds read-back. Slice θ wraps in Test T5 sweep. |
| **4** | **Read power-reduction target** | – | – | Current Q15 (min 1638 = 5%) | Slice δ verifies via this OR direct read of holding 41006 |
| **5** | **Stop inverter** | UInt16 sender node | 1 … 254 | 1 = Stopped, 2 = Started | **Already implemented** (1-reg form, working). PDF spec is for multi-master RTU; our TCP transport doesn't need it. |
| **6** | **Start inverter** | UInt16 sender node | 1 … 254 | 1 = Stopped, 2 = Started | Same |
| 7-8 | No-op | – | – | – | – |
| 9 | Change reactive power ref | Int16 KVAr / 10 | ± nominal÷10 | KVAr / 10 | Slice ζ + Slice θ (Test T3 Q-V capability) |
| 10 | No-op | – | – | – | – |
| 11 | Disable reactive ref | – | – | – | Slice ζ — restore default after Q-V test |
| 12 | Enable restrictive freq limits | UInt16 0/1 | 0 / 1 | – | **DO NOT ISSUE.** PDF restrictive limits are 49.5/50.5 Hz European 50 Hz semantic — our 60 Hz NGCP envelope is firmware-baked via Country Code 42. We READ holding 41010 for visibility, never WRITE cmd 12. |
| 13 | Inject reactive without DC | Int16 KVAr / 10 | ± nominal÷10 | KVAr / 10 | Slice ζ — night-time PF correction (rarely useful — defer) |
| 14 | Stop reactive injection w/o DC | – | – | – | Slice ζ paired with cmd 13 |

**Response semantics:** "If the INGECON SUN receives a command it resends the frame to the sender" (PDF pg 17). I.e. after writing 41001 + 41002, the value at those registers is the inverter's *response* — not a copy of what we wrote. STOP/START in particular replies with `1` (currently stopped) or `2` (currently started), which is **different from the command code 5/6**.

### 2.4 Wire format — FC 0x04 example (PDF pg 10-12)

47-register read starting at address 0:

```
Request:  [slave][0x04][0x00 0x00][0x00 0x2F][CRC]
Response: [slave][0x04][0x5E][94 data bytes][CRC]
```

Data ordering: high byte first, big-endian per register. UInt32 fields (Etotal, Hours, Conex, Alarmas) are hi-lo register order, big-endian within each register.

### 2.5 Alarm bit reference — PDF §2.2 pg 13

| Bit | Symbol | Meaning |
|---|---|---|
| 0x0001 | `ALARMA_FRED` | Grid frequency outside limits (49-51 Hz) |
| 0x0002 | `ALARMA_VRED` | Grid voltage outside limits (195-253 V) |
| 0x0004 | `ALARMA_PI_ANA` | Current PI saturation |
| 0x0008 | `ALARMA_RESET_WD` | Inverter reset by watchdog |
| 0x0010 | `ALARMA_IRED_EFICAZ` | Excessive RMS grid current |
| 0x0020 | `ALARMA_TEMPERATURA` | Power electronics > 80 °C |
| 0x0040 | `ALARMA_LEC_ADC` | A/D converter read error |
| 0x0080 | `ALARMA_IRED_INSTA` | Instantaneous AC overcurrent |
| 0x0100 | `ALARMA_PROT_AC` | AC protections |
| 0x0200 | `ALARMA_PROT_DC` | DC protections |
| 0x0400 | `ALARMA_PARO_AISL_DC` | DC isolation failure |
| 0x0800 | `ALARMA_FRAMA` | Power electronics branch failure |
| 0x1000 | `ALARMA_PARO_MANUAL` | Manual stop |
| 0x2000 | `ALARMA_CONFIG` | Configuration change |
| 0x4000 | `ALARMA_VIN` | Excessive input voltage |
| 0x8000 | `ALARMA_VPV_MED_MIN` | Minimum input voltage |

Cross-check current implementation: [server/alarms.js](../server/alarms.js) defines the human-readable labels. Audit needed (Slice α) to confirm our bit names match the PDF — symbol names are translated, but bit positions must match.

### 2.6 Power-reduction status (reg 30117) — PDF pg 9

| Bit | Meaning |
|---|---|
| 0 | Power limitation **active** (inverter is NOT injecting all available solar power) |
| 1 | **Modbus power reduction on** ← this is the APC write feedback |
| 2 | Max-frequency power reduction on |
| 3 | Grid-fault power reduction on |
| 4 | High-Vdc power reduction on |
| 5 | High-temperature power reduction on |

When we send command 3 (Change power-reduction target), the inverter will:
1. Set bit 1 of reg 30117 → 1 within ~1-2 seconds.
2. Return the Q15 value at 41006.

If bit 1 stays 0 after a successful FC16 write, the setpoint was rejected.

---

## §3 Gap analysis vs current code

| Register / behavior | Currently? | Used by | Action | Slice |
|---|---|---|---|---|
| 30001-30002 Etotal | Read at addr 0-1, decoded UInt32 hi-lo | [services/inverter_engine.py:1093](../services/inverter_engine.py#L1093) `etotal_kwh` | None — correct | – |
| 30003-30006 Lifetime hours / connections | **Not read** | – | Optional read in slow-poll tier; not displayed | β |
| 30007-30008 Latched alarms | Read as `alarm_32` UInt32 | [services/inverter_engine.py:1092](../services/inverter_engine.py#L1092) | Audit bit-name mapping in [server/alarms.js](../server/alarms.js) against PDF §2.2 | α |
| 30009 Vdc | Read at addr 8 (UInt16) | [services/inverter_engine.py:1153](../services/inverter_engine.py#L1153) | None — correct | – |
| **30010 Idc** | Read at addr 9, **treated as unsigned** | [server/poller.js:587](../server/poller.js#L587) | **Apply Int16 sign cast** + document; backfeed scenarios produce negative values | α |
| 30011-30016 Vac/Iac per phase | Read | [services/inverter_engine.py:1155-1160](../services/inverter_engine.py#L1155) | None — correct, Iac scaling 0.1 A/LSB documented | – |
| 30017-30018 CosFi + sign | Read at addr 16-17 | [services/inverter_engine.py:1131-1133](../services/inverter_engine.py#L1131) | None — correct (×1000 + 0/1 sign) | – |
| **30019 PAC** | Read at addr 18, **clamped 0-260 kW unsigned** (`safePac = pac*10 if pac*10 ≤ 260000 else 0`) | [server/poller.js:600](../server/poller.js#L600), [services/inverter_engine.py:2148](../services/inverter_engine.py#L2148) | **Apply Int16 sign cast**; even though our inverters never import, the negative-clamp window currently masks any accidental sign flip | α |
| 30020 Fac | Read at addr 19 (×100 Hz) | [services/inverter_engine.py:1098](../services/inverter_engine.py#L1098) | None — correct | – |
| 30021-30026 RTC | Read at addr 20-25 | [services/inverter_engine.py:1071-1082](../services/inverter_engine.py#L1071), [services/inverter_engine.py:1086-1090](../services/inverter_engine.py#L1086) | None — correct, used by clock-sync chain | – |
| 30027 Sun position | **Not read** | – | Skip — no trackers on site | – |
| 30028-30041 Suntrackers | **Not read** | – | Skip — no trackers | – |
| 30042-30047 Analog inputs / PT100 | **Not read** | – | Skip — AAP0016 card not installed (confirm in §8) | – |
| 30059-30060 parcE | Read at addr 58-59 | [services/inverter_engine.py:1094](../services/inverter_engine.py#L1094), recovery seed [services/inverter_engine.py:1693](../services/inverter_engine.py#L1693) | None — correct (v2.9.0) | – |
| 30061-30062 Resettable hours | **Not read** | – | Optional in slow-poll | β |
| 30063-30064 Resettable connections | **Not read** | – | Optional — could detect "power cycle since last poll" | β |
| **30065-30066 Instantaneous alarms** | **Not read** | – | Add to slow-poll; useful for "alarm just fired" UI even before the latched bit shows | β |
| **30067-30068 Maintained alarms** | **Not read** | – | Add to slow-poll; mid-session alarm memory | β |
| **30069 QAC reactive power** | **Not read** | – | **Add — Int16, ÷10 → reactive W** | β |
| **30070-30071 Zpos / Zneg** | **Not read** | – | Add to slow-poll; insulation health diagnostic | β |
| 30072 Power electronics temp | Read at addr 71, -1 ISM offset, -14 sentinel | [services/inverter_engine.py:1136-1147](../services/inverter_engine.py#L1136) | None — correct | – |
| **30073 Control electronics temp** | **Not surfaced** (commented "capture but don't surface yet") | [services/inverter_engine.py:1129](../services/inverter_engine.py#L1129) | Add to frame dict + 5-min param table; show in Parameters page | β |
| **30074 Inverter state** | **Not read** — current run/stop inferred from PAC + alarm + on_off (FC3 reg 16) | – | **Add — most authoritative status in the device** | β + γ |
| **30075-30076 VpvN / VpvP** | **Not read** | – | Add to slow-poll; insulation diagnostic | β |
| **30077 Nominal power ÷10** | **Not read** — we hardcode `unitKwMax = 997` in [server/plantCapController.js:3](../server/plantCapController.js#L3) | – | Read on poll; cross-validate against config; warn on mismatch | β |
| **30078-30108 Standard stop-reason history** | **Not read** — we use vendor FC 0x71 SCOPE | [services/stop_reason.py](../services/stop_reason.py) | Add parallel reader for cross-check; persist into separate suffix table | ε |
| **30109-30110 Time-to-connect** | **Not read** | – | Add to slow-poll; live UI signal "connecting in N s" | β |
| 30111-30115 MS-mode mirrors | **Not read** | – | Skip until §8 confirms MS deployment | – |
| 30116 1000 V kit counter | **Not read** | – | Optional in slow-poll | β |
| **30117 Power-reduction status** | **Not read** | – | **Critical APC feedback** — bit 1 confirms cmd-3 acceptance | β + δ |
| 41001/41002 Command code + data | Write FC16 with 1 register only (opcode) | [services/inverter_engine.py:2953-2964](../services/inverter_engine.py#L2953) | **STOP/START currently sends opcode-only — PDF spec wants opcode + sender_node.** Works empirically (live test 2026-05-04) but spec-noncompliant. Decide in §8 whether to align. | α (decision) / δ (impl) |
| **41006 Power-reduction target** | **Not read back** | – | Read after every cmd 3 to confirm setpoint stuck | δ |
| **41007 Phi tangent target** | **Not read back** | – | Required for Slice ζ | ζ |
| **41008 Reactive target** | **Not read back** | – | Required for Slice ζ | ζ |
| **41010 Restrictive freq limits** | **Not read back** | – | Required for Slice ζ | ζ |
| Cmd 3 (set %P) | Implemented as opcode `0x0003` | [services/inverter_engine.py:2989](../services/inverter_engine.py#L2989) `set_active_power_pct` | None — matches spec | – |
| Cmd 5 (STOP) | Implemented as opcode `0x0005` | [services/inverter_engine.py:2993](../services/inverter_engine.py#L2993) `stop_inverter_apc` | Spec wants 2-reg write with sender node | α (decision) |
| Cmd 6 (START) | Implemented as opcode `0x0006` | [services/inverter_engine.py:2999](../services/inverter_engine.py#L2999) `start_inverter_apc` | Spec wants 2-reg write with sender node | α (decision) |
| Cmd 4 (read %P) | **Not implemented** | – | Use as alternative to reading 41006 directly | δ |
| Cmd 9 (set reactive) | **Not implemented** | – | New endpoint + UI | ζ |
| Cmd 11 (disable reactive) | **Not implemented** | – | – | ζ |
| Cmd 12 (restrictive freq) | **Not implemented** | – | Grid-code compliance | ζ |
| Cmd 13/14 (reactive w/o DC) | **Not implemented** | – | Optional — only useful for night-time PF correction | ζ |

---

## §4 Phased slice breakdown

Each slice ships **independently**. Smoke gate per [feedback_native_rebuild.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_native_rebuild.md): after any Node-ABI test run, execute `npm run rebuild:native:electron`.

### Slice α — Decode-correctness fixes & docstring sweep

**Risk:** LOW · **Estimate:** 2-4 h · **Releasable:** standalone

**Purpose:** Fix the two unsigned/signed bugs the PDF reveals, audit alarm bit-name mapping, document scaling rules in the code itself.

**Files touched:**
- [server/poller.js:587-595](../server/poller.js#L587) — apply Int16 sign cast on `idc` and `pac`. Add JSDoc citing PDF §2 pg 4-5.
- [services/inverter_engine.py:2138-2200](../services/inverter_engine.py#L2138) — same in `_update_metrics_from_frame`.
- [server/alarms.js](../server/alarms.js) — verify all 16 alarm bits match PDF §2.2 pg 13. Update labels if any drift.
- [drivers/modbus_tcp.py](../drivers/modbus_tcp.py) — add module docstring linking to PDF + this plan.

**Wire-format details:**
- `idc` register at addr 9: cast as `int16` if MSB set, subtract 0x10000.
- `pac` register at addr 18: same. (Existing 260 kW unsigned clamp masks negative values silently — they fall through to 0; we keep the clamp but log a warning.)
- Decision needed (§8): for STOP/START, do we extend the FC16 write to 2 registers `[opcode, sender_node]` per PDF, or stay with the working 1-register form?

**Backward compat:** No frame field renames. Same JSON keys. Sign fix is invisible to consumers since our inverters do not export.

**Smoke tests:**
- `services/tests/test_read_fast_async.py` — add a fixture row with `idc = 0xFFF0` (signed -16) and assert decoded value is -16, not 65520.
- `server/tests/pollerSignedDecode.test.js` (new) — same fixture for `parseRow`.
- `server/tests/alarmReferenceShape.test.js` — extend to assert all 16 bits in §2.5 are present in the alarm-reference table.

**Rollback:** `git revert` of the slice commit. No DB schema change.

### Slice β — Capture additional fields + slow-poll tier

**Risk:** LOW-MED · **Estimate:** 18-28 h · **Releasable:** standalone

**Purpose:** Capture every documented input register that earns its keep on this site. Add a 30-second slow-poll tier so we don't pay 117-reg latency on every 1-2 s fast cycle.

**Files touched:**
- [services/inverter_engine.py](../services/inverter_engine.py) — add `read_slow_async()` reading addr 64-116 (53 regs) once per `SLOW_POLL_INTERVAL_S` (default 30 s, settings-tunable). Merge into `shared` under a separate key `slow_data` so `_build_metrics` can union the two.
- [server/poller.js](../server/poller.js) — extend `parseRow` to accept and forward new keys: `qac_var`, `tempci_ext_c`, `inverter_state_raw`, `vpv_n`, `vpv_p`, `nominal_power_w`, `time_to_connect_s`, `time_to_connect_total_s`, `power_reduction_bits`, `alarms_inst_32`, `alarms_maint_32`, `zpos`, `zneg`. Each defaults to `null` for legacy frame compat.
- [server/db.js](../server/db.js) — extend `inverter_5min_param` (line 1105) with new columns via `ALTER TABLE IF NOT EXISTS` (one column per slow field). Migration is additive only.
- [server/dailyAggregator.js](../server/dailyAggregator.js) — average / max / min for new metrics into the 5-min bucket.
- [public/js/app.js](../public/js/app.js) + [public/index.html](../public/index.html) — add columns to Parameters page (gated behind a "Show advanced columns" toggle to keep the default view clean).

**Wire-format details:**
- Slow-poll block: `read_input_registers(address=64, count=53, unit=u)` covers regs 30065-30117. Could optionally extend to addr 0 + 117 for one-shot full read on cold start.
- Decode rules embedded in this file's §2 are the authoritative reference. Mirror in code as constants.

**Backward compat:** Additive only. New DB columns nullable. Old `inverter_5min_param` rows untouched.

**Smoke tests:**
- `services/tests/test_slow_poll_decode.py` — new fixture per field.
- `server/tests/dailyAggregatorCore.test.js` — extend with new metrics.
- `server/tests/parameterPageColumnsCore.test.js` (new) — assert new columns render under remote + local mode.
- Per `MEMORY.md` → `inverter_5min_param_remote_blank`: any new GET reading `inverter_5min_param` MUST start with `if (isRemoteMode()) return proxyToRemote(...)`. Existing `/api/params/*` already does — verify.

**Rollback:** Drop the new columns is destructive — instead, set the slow-poll cadence to 0 (disabled) via the new setting; columns remain `NULL`. Full rollback = `git revert` + leave nullable columns in place (harmless).

### Slice γ — Authoritative inverter state (reg 30074)

**Risk:** MED · **Estimate:** 12-18 h · **Releasable:** behind feature flag

**Purpose:** Replace inferred run/stop logic with the device's own state register. Adds proper "blocked", "magnetizing", "grid-fault" UI states.

**Files touched:**
- [server/poller.js](../server/poller.js) — new `decodeInverterState(raw_u16)` returning `{ phase: "init"|"magnetizing"|"connected"|"error", stop: bool, blocked: bool, gridFault: bool }`. Persist into the live frame.
- [server/index.js](../server/index.js) — feature flag `useAuthoritativeInverterState` (settings boolean, default false in this slice). When enabled, status chips and the dashboard Inverter Card use the new decode; when disabled, current behavior unchanged.
- [public/js/app.js](../public/js/app.js) — add a new state column to the Parameters page (always visible) showing the decoded phase + bit flags.
- [server/tests/inverterStateDecode.test.js](../server/tests/inverterStateDecode.test.js) (new) — table-driven tests for every documented state encoding.

**Wire-format:** Slow-poll already pulls reg 30074 in Slice β; this slice is pure decode + UI work.

**Backward compat:** Feature flag default off. Old behaviour preserved verbatim.

**Smoke tests:** Above plus existing `server/tests/dailyAggregatorCore.test.js` regression.

**Rollback:** Toggle feature flag off. No DB change to undo.

### Slice δ — APC closed-loop verification

**Risk:** MED · **Estimate:** 16-24 h · **Releasable:** standalone (depends on Slice β slow-poll for reg 30117)

**Purpose:** After every curtailment write, read holding 41006 + input 30117 bit 1 to confirm the inverter accepted the setpoint. Surface in UI + WS event + audit log.

**Files touched:**
- [services/inverter_engine.py](../services/inverter_engine.py) ~`set_active_power_pct` (line 2989), `stop_inverter_apc` (line 2993), `start_inverter_apc` (line 2999) — after the write returns OK, schedule a delayed read of `read_holding_registers(1005, 1)` and poll reg 30117 from the live `shared` cache. Update `curtailment_state[(ip, slave)]` with `{ requested_pct, observed_q15, observed_pct, modbus_reduction_active, last_verify_ts }`.
- [server/plantCapController.js](../server/plantCapController.js) — propagate verification result to clients via existing `apc:state` WebSocket channel.
- [server/db.js](../server/db.js) — extend `inverter_curtailment_state` (line 1149) with `observed_pct REAL`, `modbus_reduction_active INTEGER`, `verify_ts INTEGER`. Additive ALTER.
- [public/js/app.js](../public/js/app.js) — Active Power Control card shows live "Inverter accepted: ✓ / pending / ✗" per slave.
- New audit_log action `apc_write_verified` with `result ∈ {ok, mismatch, no_response}`.

**Wire-format:**
- Verify cycle: T+0 send write → T+2s read 41006 → T+5s check reg 30117 bit 1 → mark verified or mismatch.
- If `observed_q15 ≠ requested_q15` within 5% tolerance OR bit 1 stays 0 after 10 s, raise `apc:write_failed` event.

**Backward compat:** Existing APC flow unchanged on the write side. Verification is additive observability.

**Smoke tests:**
- `services/tests/test_apc_verify.py` (new) — mock client returning matching / mismatched / silent responses.
- `server/tests/plantCapControllerVerify.test.js` (new) — propagate verification through WS pipeline.
- Manual hardware test: live curtailment to 50%, confirm readback matches within 5 s, watch reg 30117 bit 1 transition 0→1.

**Rollback:** Disable the verify-after-write call (one-line guard). Existing APC functionality intact.

### Slice ε — Standard-Modbus stop-reason cross-check

**Risk:** MED · **Estimate:** 10-16 h · **Releasable:** standalone (no UI gate)

**Purpose:** Read regs 30078-30108 alongside the vendor SCOPE peek for cross-validation. Surface side-by-side in the existing Stop Reasons admin page so we can verify the SCOPE-decoded `MotParo` matches the standard-Modbus motive code.

**Files touched:**
- [services/inverter_engine.py](../services/inverter_engine.py) — new `read_standard_stop_reasons(client, slave)` returning the 5-slot ring buffer. Triggered on demand from the existing Stop Reasons endpoint, NOT on every poll (saves bandwidth).
- [server/db.js](../server/db.js) — new table `inverter_stop_reasons_std` (PRIMARY KEY ip, slave, slot, fingerprint) — additive.
- [server/index.js](../server/index.js) — new GET `/api/stop-reasons/standard/:inverter/:slave` (proxy in remote mode per memory rule).
- [public/js/app.js](../public/js/app.js) — Stop Reasons admin page renders both columns. Mark mismatches in red.

**Wire-format:** `read_input_registers(78, 30, slave)` — single transaction.

**Backward compat:** New table + new endpoint. Old vendor SCOPE path untouched.

**Smoke tests:**
- `services/tests/test_standard_stop_reasons.py` (new) — fixture decoding all 30 documented motive codes.
- `server/tests/stopReasonsCrossCheck.test.js` (new) — assert side-by-side render shows matches and mismatches.

**Rollback:** Drop the new endpoint route; table remains harmless.

### Slice ζ — Reactive power + grid-code read-back

**Risk:** MED-HIGH · **Estimate:** 25-40 h · **Releasable:** behind a hard "advanced operations" feature flag

**Purpose:** Expose **commands 9, 11** (reactive setpoint + disable) as authenticated endpoints + UI controls. Add **read-back** of holding 41007 / 41008 / 41010 for visibility. **Cmd 12 (restrictive freq limits) is intentionally OMITTED** because the PDF semantics are European 50 Hz; our Philippine 60 Hz envelope is firmware-baked via Country Code 42. Cmd 13/14 (reactive without DC) deferred — rarely useful (night-time PF correction only) and operator can request a follow-up slice if needed.

Same auth model as APC (sacupsMM bulk-control key). REQUIRES `security-reviewer` agent pass before merge. This slice is a **prerequisite for Slice θ Test T3** (Q-V capability) per [docs/Grid_Compliance_Testing_Manual_PGC2016.docx](../docs/Grid_Compliance_Testing_Manual_PGC2016.docx) §2.3.

**Files touched:**
- [services/inverter_engine.py](../services/inverter_engine.py) — new helpers:
  - `set_reactive_kvar(ip, slave, kvar)` — cmd 9
  - `set_phi_tangent(ip, slave, phi)` — cmd 1 (PF control via tan(φ); tan(φ) = √(1/PF² − 1) per [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) §3.2.1)
  - `disable_reactive(ip, slave)` — cmd 11
  - `read_grid_control_state(ip, slave)` — reads holding 41006-41010
- New REST endpoints under `/api/grid-control/*` — same auth as APC.
- [server/db.js](../server/db.js) — extend `audit_log` with new actions: `reactive_set`, `reactive_disable`, `phi_set`. Audit table already supports arbitrary actions; no schema change needed.
- [public/js/app.js](../public/js/app.js) — new "Grid Code" tab inside the Active Power Control page. Per-inverter reactive-power slider (kVAr) + PF slider (0.95 lag → 0.95 lead). Live read-back chip showing current state from 41006-41010 + reg 30069 (QAC actual).
- Mandatory: confirmation modal + audit-trail per write (matches existing curtailment pattern).

**Wire-format:**
- Cmd 9 (kVAr setpoint): write `[0x0009, kvar_int16]` to addr 1000. Limits ± nominal_kVA ÷ 10.
- Cmd 1 (tan(φ)): write `[0x0001, phi_int16]` to addr 1000. Limits ±15870 = ±0.48 tan(φ) ≈ PF 0.90 lag/lead. NGCP requires 0.95 → ±10780.
- Cmd 11: write `[0x000B]` to addr 1000.
- Read-back: `read_holding_registers(1005, 5, slave)` returns regs 41006-41010 in one transaction.

**Backward compat:** Entirely new feature path. No existing endpoint touched. Cmd 12 / 13 / 14 not implemented — placeholders documented.

**Smoke tests:**
- `services/tests/test_grid_control.py` — every cmd round-trip decode.
- `server/tests/gridControlEndpoint.test.js` — auth gating.
- **Hardware soak:** 2-week soak with daily PF correction enabled on one inverter only. Operator sign-off required before fleet rollout.

**Rollback:** Feature flag off. New endpoints return 503. Audit-log entries already written are retained.

### Slice η — Documentation reference card

**Risk:** LOW · **Estimate:** 4-6 h · **Releasable:** standalone, anytime

**Purpose:** Convert §2 of this plan into [docs/Inverter-Modbus-Reference.md](../docs/Inverter-Modbus-Reference.md) so this knowledge is discoverable without re-reading a planning doc. Link from [SKILL.md](../SKILL.md).

**Files touched:**
- New [docs/Inverter-Modbus-Reference.md](../docs/Inverter-Modbus-Reference.md) — full register map, command table, alarm bits, power-reduction bits, wire-format example.
- [SKILL.md](../SKILL.md) — add reference link in the Modbus / inverter-engine section.
- [CLAUDE.md](../CLAUDE.md) — one-line pointer in the project snapshot block.

**Smoke tests:** N/A — pure docs.

### Slice θ — NGCP Grid Compliance Test Harness

**Risk:** MED-HIGH · **Estimate:** 80-120 h · **Releasable:** behind a hard feature flag, multi-stage rollout

**Purpose:** Wire the new register telemetry (Slices α-ε) and grid-code controls (Slice ζ) into a **PGC 2016 GCR 4.4.4 compliance test harness** as designed in [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) and [docs/Grid_Compliance_Testing_Manual_PGC2016.docx](../docs/Grid_Compliance_Testing_Manual_PGC2016.docx). Turns the dashboard from a monitor into an **audit-grade evidence engine** for NGCP-witnessed Factory & Site Acceptance and periodic compliance verification.

**Strict prerequisites:**
- Slice α (decode correctness) — without sign fixes, P / Q values are wrong
- Slice β (slow-poll diagnostic capture) — without QAC + state + alarm windows, no compliance evidence
- Slice δ (APC closed-loop verification) — Test T5 needs setpoint-tracking proof
- Slice ε (stop-reason logging) — needed for incident attribution in test reports
- Slice ζ (reactive control + read-back) — Test T3 needs cmd 9 / cmd 1 + 41006-41010 read-back

**What this slice DOES include** (4 of the 7 PGC tests are Modbus-doable):
- **Test T1 — Generating Unit Power Output** (GCR 4.4.4.2) — irradiance-gated 10-min capture window, per-inverter PAC + plant aggregate vs. reference meter, alarm + curtailment-status snapshots. Auto-PDF report.
- **Test T2 — Frequency Withstand** (GCR 4.4.4.3) — observation-only mode (we cannot inject frequency, but we can capture inverter behavior during natural grid events; document with state + alarm timeline). Test mode where operator triggers via a grid simulator: dashboard gives the witness a live readout chart.
- **Test T3 — Reactive Power Capability / Q-V** (GCR 4.4.4.1) — automated PF sweep 1.00 → 0.95 lag → 1.00 → 0.95 lead → 1.00 in 0.01 increments via cmd 1 (tan(φ)) or cmd 9 (kVAr). Per-step capture of P, Q, V, PF. Generates Q-V capability chart per [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) §2.3.
- **Test T5 — Active Power Control** (GCR 4.4.4.6) — automated setpoint sequence 100% → 75% → 50% → 25% → 75% → 100% via cmd 3, with optional ramp-rate constraint (default 10%/min). Step-response charts, time-to-target, overshoot, steady-state error.

**What this slice does NOT include** (separate efforts):
- **Test T4 — Voltage Control** — partially covered (we capture V + Q but cannot drive voltage from inverter side; needs PPC integration)
- **Test T6 — LVRT** — requires Mobile LVRT Test Container (voltage sag generator). Dashboard captures + reports the inverter's response oscillographically using existing fast-poll, but does not generate the sag.
- **Test T7 — Power Quality** — requires Class A IEC 61000-4-30 instrument (Fluke 1760 / Dranetz HDPQ / Hioki PQ3198). Dashboard imports the instrument's PQDIF / CSV export and bundles into the report; does not measure PQ itself.

**Files touched (substantial — staged sub-slices):**

**Sub-slice θ.1 — Test orchestrator (foundation)**
- New [server/compliance/orchestrator.js](../server/compliance/orchestrator.js) — state machine for run / abort / pause; per-test step sequencing; capture buffers.
- New [server/compliance/captureBuffer.js](../server/compliance/captureBuffer.js) — in-memory ring buffer + flush to `compliance_run` SQLite table.
- New [server/db.js](../server/db.js) tables: `compliance_run`, `compliance_run_step`, `compliance_run_sample`, `compliance_run_artifact`.

**Sub-slice θ.2 — Test T5 (Active Power Control sweep) — easiest, builds on Slice δ**
- Reuses APC opcode-3 path; orchestrator drives the 100→75→50→25→75→100% sequence with configurable hold time (default 2 min/step).
- Auto-captures step-response chart using existing fast-poll PAC stream.

**Sub-slice θ.3 — Test T1 (Generating Unit Power Output)**
- Irradiance-gated capture (requires future weather-station integration via AAP0016 — until then, operator manually records ambient irradiance from on-site pyranometer and types it into a pre-test form).
- 10-min synchronized window across all inverters with end-of-window alarm + curtailment snapshot.

**Sub-slice θ.4 — Test T3 (Q-V capability sweep) — depends on Slice ζ**
- PF sweep via cmd 1 (preferred) or cmd 9 (fallback).
- Per-step V / P / Q / PF table + Q-V chart generation.

**Sub-slice θ.5 — Test T2 (Frequency withstand observation mode)**
- Live frequency + state + alarm timeline chart for the witness.
- No write-side frequency control (we cannot inject; we observe).

**Sub-slice θ.6 — Report generator**
- Per-test PDF + CSV evidence bundle.
- GPS-timestamp metadata (≤ 100 ms uncertainty per [audits/2026-05-10/ngcp-grid-compliance-research.md](../audits/2026-05-10/ngcp-grid-compliance-research.md) §6).
- Calibration-cert attachment slot (operator uploads scanned PDFs of instrument certs).
- Witness sign-off block.

**Sub-slice θ.7 — Compliance dashboard page**
- New nav button "Grid Compliance" (visible only when feature flag enabled + operator has bulk-control auth).
- Test runner UI: pre-test checklist, per-step live readout, abort button, post-test report download.

**Wire-format:** All writes use existing Slice δ + ζ helpers. No new opcodes.

**Backward compat:** Entirely new feature path. No existing endpoint touched.

**Smoke tests:**
- `server/tests/complianceOrchestratorCore.test.js` — state machine, abort handling, capture buffer flush.
- `server/tests/complianceTestT1Core.test.js`, `T3Core`, `T5Core` — per-test fixture-driven scenarios.
- `server/tests/complianceReportGeneratorCore.test.js` — PDF + CSV bundle integrity.
- **Hardware soak:** dry-run all 4 tests on a single inverter. Operator + Engr. M. sign-off before NGCP witness invitation.

**Rollback:** Feature flag off. Compliance pages 404. Stored test runs preserved (queryable via DB).

**Cross-references:**
- Test specs: [docs/Grid_Compliance_Testing_Manual_PGC2016.docx](../docs/Grid_Compliance_Testing_Manual_PGC2016.docx) §3 (T1), §4 (T2), §5 (T3), §7 (T5)
- Implementation blueprint: [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) — already drafted by prior session
- Web-research summary: [audits/2026-05-10/ngcp-grid-compliance-research.md](../audits/2026-05-10/ngcp-grid-compliance-research.md)
- Critical conversion formulas (tan(φ) ↔ PF, Q15 ↔ %): [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) §3.2

---

## §5 Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Bandwidth pressure** from polling 117 regs every cycle on 27 inverters × 2-4 nodes | MED | Polling latency increases, dashboard freshness drops | **Two-tier poll:** keep fast-poll at 72 regs (unchanged), add slow-poll @ 30 s for regs 64-116. Net new traffic ≈ 27 × 3 × 53 × 2 = ~8.6 kB per slow cycle, ~0.3 kB/s averaged. Negligible vs. existing fast-poll volume. |
| **Firmware variant truncates the read** (PDF dated 2013; some inverters may not implement full 30001-30117) | MED | Slow-poll returns shorter frame, decoder out-of-bounds | The existing `read_fast_async` already uses `safe_read` + `regs[i] if len(regs) > i else 0` defaulting. Reuse this pattern in `read_slow_async`. Log a one-time warning per IP if frame is shorter than expected. |
| **Newer firmware exposes regs > 30117** that this PDF doesn't document | LOW | We miss useful fields | Out of scope — this revamp is for the **documented** spec. Reverse-engineering newer regs is a separate effort. |
| **Sign cast on PAC reveals existing negative-PAC behavior we masked** | LOW | UI shows negative PAC briefly during evening shutdown | Mitigation: keep the existing 0-floor for the dashboard tile but record the signed value into the diagnostic table. Operator-visible behavior unchanged. |
| **STOP/START spec-vs-actual mismatch** (sender-node data register) | LOW | None observed in production | §8 question — gather operator preference before changing. Default to leaving working code alone. |
| **Verification false-positive in Slice δ** if reg 30117 bit 1 takes >10 s to set on slow inverters | MED | Spurious `apc_write_failed` audit_log entries | Make the verify timeout configurable (default 15 s); operator can extend on slow firmware. |
| **Slice ζ grid-code mistakes could cause grid-code violations** | HIGH if wrong | Disconnection event, POSSIBLE plant fines | Mandatory `security-reviewer` agent pass + 2-week soak on one unit + operator sign-off + hard feature flag default-off. |
| **Memory says PAC stays in WATTS after `safePac=pac*10`** ([project_pac_units_convention.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/project_pac_units_convention.md)) | – | – | Slice α sign-cast happens BEFORE the ×10 scaling. New diagnostic fields (QAC) follow the same convention: convert to watts at the boundary, never re-scale downstream. |

---

## §6 Test strategy

| Slice | New tests | Existing tests to re-run |
|---|---|---|
| α | `test_read_fast_async` extended with signed fixtures · new `pollerSignedDecode.test.js` · extend `alarmReferenceShape.test.js` | `dailyAggregatorCore.test.js`, `hwCounterDeltaCore.test.js`, `recoverySeedClamp.test.js`, `crashRecovery.test.js` |
| β | `test_slow_poll_decode.py` · `parameterPageColumnsCore.test.js` (new) | `dailyAggregatorCore.test.js`, `energySummaryScaleCore.test.js` |
| γ | `inverterStateDecode.test.js` (table-driven) | `dailyAggregatorCore.test.js`, regression on existing alarm + on_off pipeline |
| δ | `test_apc_verify.py` · `plantCapControllerVerify.test.js` | Existing curtailment regression in [plans/2026-05-04-curtailment-control.md](2026-05-04-curtailment-control.md) §test plan |
| ε | `test_standard_stop_reasons.py` · `stopReasonsCrossCheck.test.js` | Vendor SCOPE tests (`test_stop_reason_parse.py`, `alarmReferenceShape.test.js`) |
| ζ | `test_grid_control.py` · `gridControlEndpoint.test.js` · 2-week hardware soak | All APC + curtailment tests |
| η | N/A — docs only | N/A |
| θ | `complianceOrchestratorCore.test.js` · `complianceTestT1Core.test.js` · `complianceTestT3Core.test.js` · `complianceTestT5Core.test.js` · `complianceReportGeneratorCore.test.js` · single-inverter dry run | All slices α-ζ + APC + WS pipeline |

**Smoke gate per slice:** `sub_smoker` agent invocation before handoff to `sub_releaser`. Restore Electron ABI (`npm run rebuild:native:electron`) after every Node-ABI run.

---

## §7 Observability

### New audit_log actions
- `reg_decode_signed_warn` — first-time PAC or Idc negative-value observation per inverter
- `apc_write_verified` — Slice δ, with `result` ∈ `{ok, mismatch, no_response, timeout}`
- `inverter_state_change` — Slice γ, when reg 30074 transitions
- `nominal_power_mismatch` — Slice β, if reg 30077 ≠ configured rated kW
- `reactive_set` / `reactive_disable` / `freq_limits_set` / `reactive_inject_no_dc` / `reactive_stop_no_dc` — Slice ζ

Every audit row carries `actor` (operator key fingerprint or `system`), `action`, `target` (`{inverter, unit}`), `value`, `result`. Already enforced by [server/db.js:614](../server/db.js#L614) `audit_log` schema.

### New WS events
- `apc:verify` (Slice δ) — `{ip, slave, requested_pct, observed_pct, bit1_active}`
- `inverter:state` (Slice γ) — `{ip, slave, phase, stop, blocked, grid_fault}`
- `slow_poll:diagnostic` (Slice β) — periodic snapshot for the diagnostic panel

### New UI status chips
- "Modbus reduction active" indicator on the APC card (Slice δ)
- Inverter state phase chip on each inverter card (Slice γ, default off)
- Insulation health amber/red on Parameters page if Zpos or Zneg crosses thresholds (Slice β)

---

## §8 Operator answers (resolved 2026-05-10)

1. **Master-Slave installations:** **No fleet-level MS.** Within each inverter cabinet's 2-4 internal nodes, the master role is **dynamic and rotates per cycle** — no static master designation. → **Skip mirror block decode (regs 30111-30115).** They would not contain meaningful steady-state data for this fleet.

2. **NGCP grid compliance:** Researched in [audits/2026-05-10/ngcp-grid-compliance-research.md](../audits/2026-05-10/ngcp-grid-compliance-research.md) and confirmed by [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx). Plant ≥ 20 MW falls under **PGC 2016 GCR 4.4.4** (Large PV) with the full test battery. Reactive 0.95 lag/lead at PCC required, LVRT mandatory, active-power curtailment ±2% / 30 s. → **Slice ζ becomes a compliance prerequisite, not optional.** New Slice θ added below to drive the test harness.

3. **Frequency thresholds (60 Hz, NGCP):** Inverters configured at firmware level for **Country Code 42** = Philippines 60 Hz. **The European 50 Hz CEI 0-21 cmd-12 restrictive-limits semantics in the PDF do NOT apply.** Per [docs/Grid_Compliance_Testing_Manual_PGC2016.docx](../docs/Grid_Compliance_Testing_Manual_PGC2016.docx) GCR 4.4.2.2 + agent research:
   - **Continuous-stable band (P/Q must not change):** 59.7-60.3 Hz
   - **Withstand band (no disconnect, ≥ 1 hour):** 58.2-61.8 Hz
   - **Trip-allowed:** ≤ 57.6 Hz after 5 s; 61.8-62.4 Hz with ≥ 5 min ride-through
   → We **read** holding 41010 for visibility (Slice ζ) but do NOT issue cmd 12 — the firmware-baked Country Code 42 already implements the correct envelope. See [images/page-1.png](../images/page-1.png) showing operator's ISM screenshot of inverter config block.

4. **AAP0016 analog input card:** **Not currently installed.** Not LVRT — those are different things (see clarification §1.6). May be installed in future for a weather station integration (ambient temperature, irradiance, wind speed, etc.). → **Decode regs 30042-30047 in the slow-poll** (so the data path is ready) but **gate the UI columns behind a settings toggle** that defaults off. When the operator wires up the weather station, flip the toggle and the columns appear.

5. **1000 Vdc operation:** **Built-in to INGECON SUN PMax design** for this site — not an optional add-on. Reg 30116 is just a usage stat. → **Decode but do not surface in UI.** No operator value.

6. **Stop-reason cross-check (Slice ε):** **GO** — utilize stop-reason logging fully for diagnostic accuracy. Slice ε approved.

7. **STOP/START sender-node data:** The PDF "Sender Node number" is the Modbus address of the SENDER (our SCADA), used in old multi-master RS-485 setups so the inverter knows who to reply to. **We use Modbus TCP through a comm board / EKI gateway** — the gateway handles routing on the same TCP socket, so the inverter doesn't need a sender-node hint. **Live test 2026-05-04 confirms our 1-register STOP frame works.** → **Leave working code alone.** Mark as "spec-non-strict but transport-justified" in §3 + code comments.

8. **Slow-poll cadence:** **Default 30 s** with a settings-tunable knob. Plain-English explanation in §1.7 below.

### §1.6 Clarification — AAP0016 vs LVRT

The earlier draft conflated two distinct things:

| | AAP0016 | LVRT |
|---|---|---|
| What | Optional analog-input expansion **card** (hardware PCB) | **Capability** (firmware + hardware) to ride through grid voltage dips |
| Function | Adds 4 × 12-bit ADC inputs + 2 × PT100 temperature inputs to the inverter | Keeps the inverter connected during a brief grid voltage sag instead of tripping offline |
| Why it exists | Wire in external sensors (ambient temperature, pyranometer, wind, etc.) | NGCP grid-code requirement for utility-scale plants — PGC 2016 GCR 4.4.4.4 / Test T6 |
| Modbus footprint | Exposes regs 30042-30047 (analog inputs 1-6) | No new Modbus registers — modifies how the inverter reacts to voltage anomalies |

**Operator confirmed:** LVRT is installed (great — Test T6 capability satisfied). AAP0016 is not installed yet but may be added later for a weather station.

### §1.7 Clarification — Slow-poll cadence in plain terms

The dashboard already polls each inverter every 1-2 seconds asking for live data ("**fast poll**" — current power, voltage, current, alarms). Diagnostic registers added in this revamp (insulation impedance, reactive power, control electronics temperature, time-to-connect countdown, power-reduction status bits, etc.) **don't change every second.** Asking for them every 1-2 s wastes bandwidth across 27 inverters × 2-4 nodes.

Proposal: **add a second, slower polling loop just for diagnostic registers — defaults to every 30 seconds.** That 30-second interval is the "**slow-poll cadence**."

| Cadence | Best for | Bandwidth cost |
|---|---|---|
| 5 s | Near-live diagnostics | High |
| 15 s | Balanced | Medium |
| **30 s (default)** | Slowly-changing fields | Low (~0.3 KB/s fleet-wide) |
| 60 s | Long-term trending only | Very low |

For comparison: the current fast poll generates ~150 KB/s fleet-wide. The slow poll adds < 0.5%. Negligible. Operator can re-tune from Settings → Inverter Polling.

### §1.8 Clarification — STOP/START "node" terminology

Two concepts, easily confused:

1. **What our dashboard already does correctly:** STOP/START targets ONE node (one of the 2-4 internal slaves inside an inverter cabinet), not the whole cabinet. `set_active_power_pct(ip, slave, pct)` is per-slave. ✓
2. **What the PDF "Sender Node number" data field means:** the Modbus address of the SCADA / dashboard sending the command — used so the inverter can resend the frame back to the originator on multi-master RS-485 buses. **In our TCP-tunneled setup it's irrelevant** because the gateway handles routing automatically. That's why our 1-register STOP frame works.

Conclusion: our per-slave targeting is correct. The PDF's 2-register form is a vestige of older multi-master RTU deployments and is not required on our transport.

---

## §9 Acceptance criteria

The revamp is **done** when all of the following are testable-true:

- [ ] **α-1** `parseRow` and `_update_metrics_from_frame` apply Int16 sign casts to `pac` and `idc`. Fixture-driven unit tests pass.
- [ ] **α-2** [server/alarms.js](../server/alarms.js) bit names match PDF §2.2 pg 13 verbatim (allowed translation only). Lock test in `alarmReferenceShape.test.js`.
- [ ] **α-3** [drivers/modbus_tcp.py](../drivers/modbus_tcp.py) docstring links to this plan and the PDF.
- [ ] **β-1** Slow-poll task running every 30 s (or configured cadence), reads regs 64-116, populates new frame fields.
- [ ] **β-2** [server/db.js](../server/db.js) `inverter_5min_param` has new nullable columns: `qac_var`, `tempint_c`, `inverter_state_raw`, `vpv_n`, `vpv_p`, `nominal_power_w`, `time_to_connect_s`, `power_reduction_bits`, `alarms_inst_32`, `alarms_maint_32`, `zpos`, `zneg`.
- [ ] **β-3** Parameters page renders all new columns under "Show advanced columns" toggle.
- [ ] **β-4** Reg 30077 mismatch with configured rated-kW emits an audit_log row.
- [ ] **γ-1** Reg 30074 decoded into `{phase, stop, blocked, grid_fault}` with feature flag default off.
- [ ] **γ-2** Toggle on a single inverter card; Inverter Card phase chip updates within one slow-poll cycle.
- [ ] **δ-1** Every cmd-3 write triggers a verify cycle within 15 s.
- [ ] **δ-2** Operator sees "Verified ✓" or "Mismatch ✗" per slave on the APC card.
- [ ] **δ-3** Audit log shows `apc_write_verified` rows for every write.
- [ ] **ε-1** New endpoint `/api/stop-reasons/standard/:inverter/:slave` returns the 5-slot ring buffer.
- [ ] **ε-2** Stop Reasons admin page shows side-by-side vendor SCOPE vs. standard-Modbus columns.
- [ ] **ε-3** Mismatches highlighted in red.
- [ ] **ζ-1** All 5 grid-control endpoints implemented + auth-gated.
- [ ] **ζ-2** UI controls behind a feature flag default-off.
- [ ] **ζ-3** `security-reviewer` agent pass on the slice diff.
- [ ] **ζ-4** 2-week soak on one inverter with operator sign-off before fleet enable.
- [ ] **η-1** [docs/Inverter-Modbus-Reference.md](../docs/Inverter-Modbus-Reference.md) exists and matches §2 of this plan.
- [ ] **η-2** [SKILL.md](../SKILL.md) and [CLAUDE.md](../CLAUDE.md) link to the new reference.
- [ ] **θ-1** Compliance orchestrator runs T1, T3, T5 dry-runs on a single inverter without hardware faults.
- [ ] **θ-2** PDF + CSV report bundle generated for each test, including GPS-timestamp metadata + alarm + curtailment snapshots.
- [ ] **θ-3** Q-V capability chart (T3) overlays measured points on the registered capability curve and flags any > 5% deviation.
- [ ] **θ-4** T5 step-response chart shows time-to-95%-target ≤ 30 s and steady-state error ≤ ±2% per [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) §2.5 pass criteria.
- [ ] **θ-5** Operator + Engr. M. sign-off on a single-inverter dry run before NGCP witness invitation.
- [ ] **Cross-cutting:** all Node-ABI smoke runs followed by `npm run rebuild:native:electron`. No regression in `dailyAggregatorCore`, `hwCounterDeltaCore`, `crashRecovery`, `recoverySeedClamp`, `alarmReferenceShape`.

---

## Appendix A — PDF page index

| PDF page | Content |
|---|---|
| 1 | Title — AAS1000ICB08, three-phase inverter management via Modbus-RTU |
| 2 | TOC |
| 3 | Introduction |
| 4-6 | Input register map 30001-30058 (lifetime, live, suntracker, analog) |
| 6-7 | Resettable counters + alarm windows 30059-30068 |
| 7 | Diagnostic + state 30069-30077 |
| 7-8 | Stop-reason history 30078-30108 + 30 motive-code definitions |
| 8 | Connection countdown + MS mirrors 30109-30115 |
| 9 | 1000 V kit + power-reduction status 30116-30117 |
| 10-12 | FC 0x04 wire-format example (47-reg read, 94 data bytes) |
| 13-14 | Alarm bit reference + suntracker / MS bits |
| 15 | Holding registers 41001-41012 |
| 16-17 | Command code table (0-14) + response semantics |

## Appendix C — Operator-supplied compliance documents

The operator (Engr. M.) provided three reference documents at the §8 review stage:

| Document | Path | Role in this plan |
|---|---|---|
| NGCP Grid Compliance Implementation | [docs/NGCP_Grid_Compliance_Implementation.docx](../docs/NGCP_Grid_Compliance_Implementation.docx) | Authoritative blueprint for Slice θ. Already covers regulatory framework (PGC 2016 Ch. 4 GCR + Ch. 6 GO 6.12), the 7 PGC tests, Modbus mapping per test, conversion formulas (tan(φ) ↔ PF, Q15 ↔ %), and report-bundle structure. **Slice θ implementation should follow this blueprint section-by-section.** |
| Grid Compliance Testing & Validation Manual (PGC 2016) | [docs/Grid_Compliance_Testing_Manual_PGC2016.docx](../docs/Grid_Compliance_Testing_Manual_PGC2016.docx) | Field test procedures, pass/fail criteria, equipment requirements per test. Drives Slice θ test orchestrator state machine. |
| Ingeteam Modbus RTU Manual (operator's annotated copy) | [docs/Ingeteam_Modbus_RTU_Manual.docx](../docs/Ingeteam_Modbus_RTU_Manual.docx) | Field-engineer-friendly reorganization of AAS1000ICB08. Treat as secondary to the original PDF (any discrepancies → PDF wins). |
| ISM inverter configuration screenshot | [images/page-1.png](../images/page-1.png) | Operator's screenshot showing actual inverter config: Country Code 42 (Philippines), 1000 Vdc operation, LVRT enabled, max Vac 1820, ambient temp reduction settings. Cited in §8 Q3 frequency discussion. |

Web-research cross-check: [audits/2026-05-10/ngcp-grid-compliance-research.md](../audits/2026-05-10/ngcp-grid-compliance-research.md) — independent verification of frequency thresholds, LVRT curve parameters, sampling/retention requirements via ERC, NGCP, IRENA, and IEEE 1547 sources.

**Caveat from operator:** "These might not fully be correct" — treat the docx files as draft working documents. Slice θ implementation should re-verify against the live PGC 2016 text and the operator's prevailing Connection Agreement before NGCP witness invitation.

---

## Appendix B — Memory + plan cross-references

- [project_pac_units_convention.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/project_pac_units_convention.md) — PAC is in WATTS after `safePac=pac*10`. Sign cast in Slice α happens BEFORE this scaling.
- [project_inverter_5min_param_remote_blank.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/project_inverter_5min_param_remote_blank.md) — every new GET reading `inverter_5min_param` must proxy in remote mode.
- [feedback_audit_folder_convention.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_audit_folder_convention.md) — this plan lives at `plans/YYYY-MM-DD-<topic>.md` with `Date:` + `Status:` headers.
- [feedback_native_rebuild.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_native_rebuild.md) — restore Electron ABI after every Node-ABI smoke run.
- [v290_hw_counter_recovery.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/v290_hw_counter_recovery.md) — `read_fast_async` widened 26 → 60 → 72 regs; this plan adds a parallel slow-poll, NOT a third widening.
- [v210_stop_reasons_serial_number.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/v210_stop_reasons_serial_number.md) — vendor SCOPE peek lives alongside the standard-Modbus history added in Slice ε.
- [plans/2026-05-04-curtailment-control.md](2026-05-04-curtailment-control.md) — APC opcodes 0x0003 / 0x0005 / 0x0006 are spec-compliant per PDF §3 cmd 3 / 5 / 6. Slice δ adds verification, not replacement.

---

**End of plan.** §8 operator answers received 2026-05-10. Ready for slice-α dispatch.

**Slice order recap:** α (decode-correctness, LOW) → β (slow-poll + diagnostic capture, LOW-MED) → γ (authoritative state, MED, flag-gated) → δ (APC closed-loop verification, MED) → ε (stop-reason cross-check, MED) → ζ (reactive + grid-code read-back, MED-HIGH) → η (docs reference card, LOW) → **θ (NGCP Grid Compliance Test Harness, MED-HIGH, ~80-120 h, depends on α-ζ)**.
