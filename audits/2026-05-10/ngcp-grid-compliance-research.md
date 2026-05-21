# NGCP Grid Compliance Research — Solar Plant Inverters

**Date:** 2026-05-10  
**Status:** Research summary — for planning and dashboard feature input  
**Scope:** NGCP transmission-connected utility-scale solar PV in the Philippines  
**Grid:** 60 Hz nominal  
**Plant Reference:** Alterpower Digos Solar (~24.84 MW, 27 × Ingeteam INGECON SUN, Mindanao)

---

## §1 Regulatory Framework

### 1.1 Primary Authority
The **Philippine Grid Code (PGC) 2016 Edition**, approved under **ERC Resolution No. 22, Series of 2016**, is the operative instrument governing connection and operation of generating facilities to the NGCP transmission system. The PGC absorbed the earlier Variable Renewable Energy (VRE) Addendum (ERC Resolution No. 7, Series of 2013) into integrated sections.

**Relevant chapters for solar PV compliance:**
- **Chapter 4 — Grid Connection Requirements (GCR):** Technical performance requirements
  - GCR 4.4.4: Specific requirements for **Large Photovoltaic Generation Systems** (≥ 20 MW)
  - GCR 4.5: Reduced set for non-large plants (< 20 MW)
- **Chapter 6 — Grid Operations (GO):** Testing and witnessing mandates
  - GO 6.12: On-site compliance testing program for VRE facilities
  - GO 6.12.3: Requires authorized witnesses from NGCP (Transmission Network Provider)
- **Chapter 9 — Power Quality Standards:** Harmonics, voltage unbalance, flicker, frequency deviation

**Classification note:** The Alterpower Digos Solar plant (~24.84 MW) straddles the 20 MW threshold; assume **full GCR 4.4.4 obligations** (conservative approach for transmission-connected plants).

### 1.2 Test Witnessing & Recordkeeping (GO 6.12.3)
All compliance tests must be **recorded and witnessed by authorized representatives** of NGCP. This creates three dashboard obligations:
1. **Pre-test notification:** NGCP advance notice (5–10 working days) with test plan
2. **Live witnessing:** Real-time data visibility with tamper-proof timestamps
3. **Post-test documentation:** Signed test report with raw data, pass/fail determination, instrument calibration certificates

### 1.3 Adjacent Standards Referenced by NGCP
While not embedded in the PGC, NGCP's accepted test protocols reference:
- IEEE 1547 (Standard for Distributed Energy Resources – Interconnection with the Electrical Power System)
- IEEE 1547.1 (Distributed Energy Resource Unit Testing)
- IEC 60038 (Nominal voltages)
- SEMI F42 (Guide for Characterizing Photovoltaic Inverter Performance)

**Dashboard implication:** Calibration certificates for test instruments must map to the standard referenced in the test procedure.

---

## §2 Frequency Operating Thresholds (60 Hz Nominal)

### 2.1 Continuous Operating Band (Normal Operation)
The Philippine grid maintains frequency nominally at **60.0 Hz ± 0.3 Hz** (per plant operators and NGCP bulletins). This ensures synchronization of all generators connected to the transmission backbone.

**Requirement:** Within **59.7–60.3 Hz**, the inverter's active power output and reactive power shall **not change** by more than ±2% (instrument noise tolerance) during normal, steady-state operation.

**GCR reference:** GCR 4.4.2.3 (Frequency Insensitivity Sub-test B)

| Band | Hz Range | Duration | Action | GCR Ref |
|------|----------|----------|--------|---------|
| Continuous | 59.7–60.3 | Unlimited | P, Q stable ± 2% | 4.4.2.3B |

### 2.2 Extended Withstand Band (Ride-Through Required)
Per **GCR 4.4.2.2 (Frequency Withstand Capability)**, the inverter must remain **connected and operational** across a much wider band without automatic disconnection.

| Band | Hz Range | Min Duration | Action |
|------|----------|--------------|--------|
| Withstand | 58.2–61.8 | ≥ 1 hour | Remain connected, no trip |
| Extended +ve | 61.8–62.4 | ≥ 5 minutes | Remain connected, no trip |
| Extended −ve | 57.6–58.2 | ≥ 60 minutes | Remain connected, no trip |
| Trip threshold (−ve) | ≤ 57.6 Hz | — | Allowed to disconnect after 5 seconds |

**Evidence source:** Local documentation (*Grid_Compliance_Testing_Manual_PGC2016.docx*, §1.4.1); web search confirms 58.2–61.8 Hz specification in PGC 2016.

**Test procedure (GCR 4.4.2.2):**
1. Operate at rated active power, rated voltage, nominal frequency.
2. Step frequency in 0.2 Hz increments to reach 58.2 and 61.8 Hz.
3. Hold each setpoint for observation window; verify no disconnection or alarm latching.
4. Log frequency, active power, reactive power, inverter state, alarm flags at 1 Hz minimum.

**Pass criteria:** PVS remains connected throughout the band; no breaker trip, no protective relay action.

---

## §3 Voltage Ride-Through Curves (LVRT/HVRT)

### 3.1 Low Voltage Ride-Through (LVRT)
**GCR reference:** GCR 4.4.2.5 (Voltage Withstand Capability)

The inverter must remain connected during voltage sags at the point of common coupling (PCC). The Philippine Grid Code specifies an LVRT profile; exact curve parameters extracted from local documentation and IRENA renewable grid codes reference:

**Typical PGC 2016 LVRT profile (60 Hz grid):**

| Voltage (% nominal) | Min Duration (seconds) | Action |
|---|---|---|
| 0 (3-phase bolted fault) | 0.3–0.6 | Remain connected, inject reactive current |
| 20–50 | 1.0–2.0 | Remain connected, reactive support |
| 50–70 | 5.0 | Remain connected |
| 70–90 | 10.0+ | Remain connected |
| 90–100 | Unlimited | Normal operation |

**Reactive current injection requirement:** During voltage dips below ~70% nominal, the inverter SHALL inject reactive current (lagging, i.e., capacitive support). Typical requirement: **2–3 A per 1% voltage drop** (normalized to rated power) to accelerate voltage recovery.

**Test procedure (GCR 4.4.2.5):**
1. Operate at rated active power, rated voltage.
2. Apply programmed voltage sag via test voltage source or simulation.
3. Log voltage, active power, reactive power, reactive current injection, inverter state at ≥ 1 Hz.
4. Verify:
   - PVS does not disconnect
   - Reactive current flows during sag
   - Active power may reduce but reactive increases
   - No protection relay nuisance trips

**Pass criteria:** Inverter remains connected and reactive current flows within specified window; post-sag voltage recovery completed within clearing time.

### 3.2 High Voltage Ride-Through (HVRT)
**Analogous requirement** for overvoltage transients (GCR 4.4.2.5). The inverter must tolerate voltage surges up to ~120–130% nominal for 0.5–1.0 seconds without tripping. Exact curve is plant-specific; set in inverter firmware per the System Impact Study (SIS).

**Common parameters (Philippine utilities):**
- **110% nominal:** Unlimited operation
- **110–120% nominal:** 10+ seconds
- **120–130% nominal:** 1–2 seconds
- **>130% nominal:** Allowed to disconnect

---

## §4 Active Power Curtailment Requirements

### 4.1 Setpoint Resolution and Response Time
**GCR reference:** GCR 4.4.3.2 (Power Ramp Rate) and Plant Control Requirements

The PGC does not explicitly mandate a specific MW/min ramp rate in the public-facing sections reviewed; however, local documentation and NGCP operational experience indicate the following **typical requirements for transmission-connected solar plants:**

| Parameter | Typical Range | Ingeteam Modbus Register |
|-----------|---|---|
| Curtailment setpoint resolution | 0.1–1% of rated capacity | 41001 (Power Limit Percentage) |
| Minimum setpoint granularity | 1% increments | — |
| Response time (setpoint to output) | 5–30 seconds | Depends on DC-side control loop |
| Ramp rate (upward) | 10–50 MW/min (fast upward) | Inherent to dc:ac ratio |
| Ramp rate (downward / curtailment) | 10–20 MW/min (controlled descent) | Dc-link voltage droop control |

**Plant-level curtailment pathway:**
- **Manual:** Plant operator via SCADA → sends active power setpoint (% rated) to plant controller
- **Automatic:** NGCP dispatch → plant PPC (Power Plant Controller) receives curtailment signal via:
  - **Modbus TCP** (local plant LAN) — direct command to inverter string controllers
  - **DNP3 / IEC 60870-5-104** — future; not yet operational at most Philippine plants
  - **Direct inverter register write** (Modbus 41001: power limit percentage) by plant SCADA

**Ingeteam implementation (local documentation):**
- **Modbus register 41001:** Power Limit (% of Max, 0–100), signed 16-bit
- **Modbus register 41002:** Reactive Power Target (% of Max Reactive, −100 to +100), signed 16-bit
- **Write function:** FC 16 (Write Multiple Registers, 0x10)
- **Command response:** Within 500 ms; curtailment ramps follow configured dc-link voltage setpoint

### 4.2 Curtailment Measurement & Verification
**Dashboard must log:**
- Curtailment setpoint (register 41001) at every state change + periodic 1 Hz polling
- Measured active power output (register 30019) at 1 Hz
- DC-link voltage (register 30005) at 1 Hz to infer curtailment state
- Timestamp with GPS precision (≤ 100 ms uncertainty for compliance reports)

**Plant-level compliance:** Curtailment must be verifiable at the PCC (substation metering), not just at inverter terminals. The dashboard measures inverter-side; the utility measures PCC; the two must agree within transmission loss tolerance (~2.5–3.6% per plant calibration).

---

## §5 Reactive Power and Power Factor at PCC

### 5.1 Power Factor Operating Range
**GCR reference:** GCR 4.4.3.3 (Reactive Power Capability)

The inverter plant must maintain a **power factor between 0.95 lagging and 0.95 leading** at the point of common coupling (PCC), simultaneously with rated active power output, across the full continuous voltage range (0.95–1.05 p.u. nominal).

**Interpretation:**
- **0.95 lagging:** Reactive power **exported to grid** (capacitive, absorbs reactive power)
- **0.95 leading:** Reactive power **imported from grid** (inductive, supplies reactive power / reactive support)
- Both extremes must be sustainable for ≥ 10 minutes at rated active power without overshooting

### 5.2 Reactive Droop (Q(V) Curve)
The PGC does not specify a *mandatory* Q(V) droop curve for solar PV (as it does for synchronous generators); however, **recommended practice** for grid stability is:

**Typical Philippine utility requirement (per NGCP operational guidelines):**

```
Q(V) droop: ΔQ/ΔV = 2–4 p.u. (e.g., 1% voltage rise → 2–4% reactive power increase)

At 1.05 pu voltage: inject ~10–15% reactive power (supporting)
At 0.95 pu voltage: absorb ~5–10% reactive power (short)
Deadband: ±2% around nominal voltage (no control action)
```

This is **not hard-coded** in the PGC; instead, it appears as a **recommendation** in NGCP's System Impact Study (SIS) for each plant, tailored to local grid conditions (short-circuit strength, reactive demand, etc.).

**Ingeteam implementation:**
- **Manual mode:** Plant operator sets Q target via register 41002 (Reactive Power Target, %)
- **Automatic mode:** Plant PPC software applies Q(V) droop logic; register 41002 is computed automatically
- **Measurement:** Register 30069 (Reactive Power, kVAr, signed 16-bit)

### 5.3 Reactive Power Measurement & Verification
The dashboard must log:
- Reactive power output (register 30069) at 1 Hz
- Voltage at inverter terminals (register 30010, in 0.01 V units)
- Power factor (computed as cos(arctan(Q/P))) at 1 Hz
- Timestamp with GPS sync

**Compliance check:** At rated active power, measured PF must remain within ±5% of the declared range (0.95–0.95) during steady-state operation.

---

## §6 ROCOF (Rate of Change of Frequency) Requirements

### 6.1 Ride-Through Requirement
The PGC 2016 does not explicitly state a ROCOF trip threshold; however, **international standards** referenced by NGCP (IEEE 1547, IEC 60038) and **emerging Philippine guidance** suggest:

| Condition | df/dt threshold | Action |
|-----------|---|---|
| Normal operation | ≤ 0.5 Hz/s | No protection action |
| Moderate disturbance | 0.5–1.0 Hz/s | May trigger voltage support; no frequency trip |
| Severe disturbance | > 1.0 Hz/s | May trigger active power ramp-down or disconnection after ride-through duration |

**Context:** Modern solar plants with fast frequency response can **inject synthetic inertia** to slow ROCOF during generator loss events. The Alterpower Digos Solar plant currently has **no explicit synthetic inertia control** (not required by PGC 2016 baseline), but the dashboard should **measure and log ROCOF** for future grid studies and compliance audits.

### 6.2 Measurement Requirements
**Dashboard must calculate (at ≥ 10 Hz sampling):**
- Instantaneous frequency from zero-crossing detection or PLL (Phase-Locked Loop) output
- ROCOF = df/dt as a 1-second rolling derivative (Hz/s)
- Log ROCOF at 1 Hz during any frequency event (outside 59.7–60.3 Hz band)

**Evidence threshold:** When ROCOF exceeds ±0.5 Hz/s, emit an audit log event with timestamp, ROCOF value, context (fault type, recovery duration).

---

## §7 Measurement, Logging, and Archival Requirements

### 7.1 Sampling Rates and Measurement Standards
**GCR and GO mandate:**

| Measurement | Sampling Rate | Averaging Window | Logging Interval | Instrument Class |
|---|---|---|---|---|
| Voltage (V, p.u.) | ≥ 10 Hz | 1 sec RMS | 1 sec average | IEC 61000-4-7, Class A |
| Current (A) | ≥ 10 Hz | 1 sec RMS | 1 sec average | IEC 61000-4-7 |
| Active Power (kW) | ≥ 1 Hz | 1 sec avg | 1 sec | Watt-hour meter accuracy ≤ 1% |
| Reactive Power (kVAr) | ≥ 1 Hz | 1 sec avg | 1 sec | ≤ 2% class |
| Frequency (Hz) | ≥ 10 Hz | 1 sec avg | 1 sec | ±10 mHz accuracy (GPS synced) |

**Timestamp requirement:** All data points must be **GPS-synchronized** with ≤ 100 millisecond uncertainty. The dashboard's Linux kernel can achieve this via `gpsd` daemon + PPS (Pulse-Per-Second) discipline on a local GNSS receiver, or via NTP to a Stratum-1 server with ≤ 50 ms network latency.

### 7.2 Data Retention Policy
**Per GO 6.12 and general grid code practice:**

| Data Class | Min Retention | Typical Practice |
|---|---|---|
| Real-time telemetry (1 Hz) | 30–90 days | SQLite hot database |
| Daily summaries (5-min aggregates) | 7 years | Archive on NAS / cloud backup |
| Test reports + raw evidence | 10 years | Immutable audit log + signed PDF |
| Alarm/event log | 3–5 years | Searchable index, queryable by date/inverter/alarm |

**Ingeteam Modbus register map** (for dashboard implementation):

| Register | Parameter | Units | Data Type | Notes |
|---|---|---|---|---|
| 30001–30002 | Energy Total (Etotal) | kWh | UINT32 | Cumulative since commissioning |
| 30005 | DC-Link Voltage | V × 0.01 | INT16 | Physical dc bus (all strings) |
| 30010 | Grid Voltage (line-to-neutral) | V × 0.01 | INT16 | PCC proxy or local sample |
| 30019 | Active Power | kW × 10 | INT16 | Instantaneous, signed |
| 30067–30068 | Alarm Word (64-bit) | — | UINT32 pair | Bit-field for fault flags |
| 30069 | Reactive Power | kVAr × 10 | INT16 | Signed (lagging negative) |
| 30074 | Grid Frequency | Hz × 100 | INT16 | 60.00 Hz → 6000 |
| 30117 | Power Limit | % (0–100) | UINT16 | Read-back of 41001 setpoint |
| 41001 | Power Limit Setpoint | % (0–100) | UINT16 | Write to curtail active power |
| 41002 | Reactive Power Target | % (−100 to +100) | INT16 | Write to set reactive mode |

---

## §8 Reporting Requirements and SCADA Integration

### 8.1 Real-Time Telemetry to NGCP
As of May 2026, **most Philippine solar plants do NOT have direct real-time SCADA links to the NGCP NCC** (National Control Center). Reporting occurs via:

1. **Daily compliance report:** E-mail or portal upload to NGCP by 08:00 on next business day
   - Format: CSV with 5-min or 1-hour aggregates
   - Contents: P, Q, V, f, alarms, curtailment setpoint, any out-of-bounds events

2. **Event-triggered reporting:** Immediate (within 24 hours) notification of:
   - Frequency excursions outside 58.2–61.8 Hz
   - Voltage sags triggering LVRT response
   - Unplanned disconnections / protective relay trips
   - Inverter faults > 5 minutes duration

3. **Periodic compliance test results:** Post-test PDF report with evidence attachments (raw CSV, calibration certs, witness signature)

**Planned integration (future):** NGCP is piloting DNP3 and IEC 60870-5-104 links for real-time dispatch. Dashboard should support export in both formats for future grid integration.

### 8.2 Post-Test Documentation
**Per GO 6.12.3**, each compliance test must produce:

1. **Test plan** (pre-test, approved by NGCP): objective, procedure, acceptance criteria, instruments, witness schedule
2. **Live test log:** CSV with timestamp, P, Q, V, f, inverter alarms, setpoint changes
3. **Summary report (PDF):** 
   - Test date, witnesses, weather, plant condition
   - Pass/fail determination per acceptance criterion
   - Time-series plots (V vs t, P vs t, Q vs t, f vs t)
   - Instrument calibration references
   - Operator signature + NGCP witness signature (digital or wet-ink)

**Dashboard feature:** Auto-generate pre-filled PDF test reports with embedded plots and CSV attachments, signed with plant operator key.

---

## §9 Inverter-Terminal vs. PCC Scope

### 9.1 Scope Distinction
The Philippine Grid Code distinguishes **two measurement points** for compliance:

| Point | Scope | Measurement Method | Responsibility |
|---|---|---|---|
| **Inverter terminals** | AC output of each inverter unit | Modbus registers 30010, 30019, 30069, 30074 | Inverter DSP + plant SCADA (dashboard) |
| **PCC (Point of Common Coupling)** | Substation metering point, upstream of plant disconnect | Utility reference meter (revenue-grade wattmeter) | Utility + plant operator co-witness |
| **Plant-level compliance** | Aggregated across all inverters, adjusted for transformer loss | Plant SCADA sums inverter measurements + applies loss compensation | Plant operator |

### 9.2 Inverter-Terminal Compliance
**Inverter-side tests (T1–T7 in the local documentation) are pass/fail per individual unit.** If any unit trips during a frequency or voltage withstand test, the plant **fails** that test criterion.

**Dashboard role:**
- Log per-inverter voltage, current, frequency, power at ≥ 1 Hz
- Detect and flag inverter disconnection (P → 0, Q → 0, simultaneous with alarm latching)
- Auto-pause test if disconnection detected; alert operator

### 9.3 PCC-Level Compliance
**Plant-level tests require measurement at the substation.** The transformer and cable plant loss (~2.5–3.6%) means:

```
Measured PCC Power = Σ(Inverter Power) × (1 - Loss_%)
Measured PCC Voltage = Substation metering voltage (scaled to LV equivalence)
Measured PCC Frequency = Common to all inverters (grid frequency)
```

**Reconciliation requirement:** For each test, the plant must show:
- **Inverter-side aggregated power** (via dashboard)
- **PCC metering power** (utility reference meter)
- **Agreement within ±3%** (loss tolerance + instrument error)

If discrepancy exceeds ±3%, the test result is flagged for investigation (possible transformer issue, cable loss mismatch, or metering miscalibration).

---

## §10 Implications for the ADSI Dashboard

### 10.1 Critical Monitoring Register List
The dashboard **must continuously log** the following Ingeteam Modbus registers at **≥ 1 Hz** for each of the 27 inverters:

```
Per-inverter read loop (100 ms or faster):
  30001–30002 : Energy total (reference for startup seeding)
  30005       : DC-link voltage (curtailment state indicator)
  30010       : Grid voltage (LVRT detection)
  30019       : Active power (load for curtailment verification)
  30067–30068 : Alarm word (fault detection)
  30069       : Reactive power (Q(V) droop verification)
  30074       : Frequency (withstand band verification)
  30117       : Power limit read-back (curtailment echo)

Plant-level aggregate:
  Σ(30019)    : Total active power
  Σ(30069)    : Total reactive power
  MEAN(30074) : Grid frequency (should be identical across inverters)
  MAX(ALARM)  : Any active alarm across fleet
```

### 10.2 Critical Control Registers
The dashboard **may write** the following to implement grid compliance tests:

```
Curtailment test (active power sweep):
  Per-inverter write to 41001 (Power Limit Setpoint):
    0% (offline) → 20% → 40% → 60% → 80% → 100%
    Hold ≥ 1 min at each step
    Log 30019 response at 1 Hz for ramp-rate verification

Reactive power test (Q(V) sweep):
  Per-inverter write to 41002 (Reactive Power Target):
    0% (unity PF) → +50% (capacitive/absorbing) → −50% (inductive/supplying)
    Hold ≥ 1 min at each step
    Log 30069 response at 1 Hz

Note: Frequency and voltage withstand tests are *observational only* — the test 
authority (e.g., utility service truck with programmable voltage source) applies 
the disturbance; the dashboard measures the response.
```

### 10.3 Audit Log Entries (Database Inserts Required)
For each compliance test session, the dashboard must emit audit log rows:

```sql
INSERT INTO audit_log (timestamp, action, status, inverter, register, old_value, new_value, reason)
VALUES
  ('2026-05-10 10:30:00.123', 'test_curtailment_start', 'initiated', 'all', 41001, NULL, NULL, 'operator requested'),
  ('2026-05-10 10:31:15.456', 'register_write', 'success', 'inv_001', 41001, 100, 80, 'curtailment test step 1 of 5'),
  ('2026-05-10 10:32:45.789', 'frequency_withstand_event', 'observed', 'all', 30074, 60.0, 59.8, 'frequency sag 0.2 Hz/s ROCOF'),
  ('2026-05-10 10:34:00.012', 'test_curtailment_pass', 'success', 'all', 41001, NULL, 100, 'all setpoints reached, ramps nominal'),
  ('2026-05-10 10:35:30.345', 'test_report_generated', 'success', 'all', NULL, NULL, 'TestReport_20260510_001.pdf', 'compliance evidence PDF');
```

### 10.4 UI/UX Changes for Operators
The dashboard's **Settings → Grid Compliance** section (future) should expose:

1. **Pre-test checklist:**
   - Confirm all 27 inverters online and alarms clear
   - Confirm PCC metering synchronized (< 100 ms skew)
   - Confirm weather (irradiance ≥ 600 W/m² for active power tests, optional for voltage/frequency)
   - Confirm NGCP witness present on site

2. **Test selection dropdown:**
   - T1: Power Output Verification
   - T2: Frequency Withstand
   - T3: Reactive Power Capability
   - T4: LVRT (observational, witness controls)
   - T5: Voltage Sensitivity
   - T6: Power Ramp Rate
   - T7: Island Detection (anti-islanding)

3. **Real-time test dashboard (during test):**
   - 27-column table showing P, Q, V, f, alarm state for each inverter
   - Automated pass/fail indicator for each setpoint
   - Live plot: P(t), Q(t), V(t), f(t), ROCOF(t) vs elapsed time
   - Operator abort button (emergency disconnect)

4. **Post-test report download:**
   - Auto-generated PDF with embedded plots, CSV attachments
   - Operator + witness signature fields (fillable, digitally signed)
   - Calibration certificate reference dropdowns

---

## §11 Open Questions for Follow-Up

1. **NGCP dispatch communication protocol:** Does NGCP currently transmit curtailment setpoints to Alterpower Digos Solar? If so, via what protocol (manual phone call, DNP3, IEC 61850)? How is the plant currently receiving dispatch commands?

2. **System Impact Study (SIS) specifics:** What are the plant-specific Q(V) droop parameters, ROCOF trip thresholds, and reactive support requirements mandated in the approved SIS for this plant? These are typically more stringent than the PGC minimum.

3. **Sub-hourly metering:** Does the utility provide 5-minute or 1-minute interval data to the plant operator? If not, how does the operator reconcile daily compliance with plant SCADA?

4. **Frequency event history:** Has the Mindanao grid experienced frequency excursions outside 59.7–60.3 Hz in the past 12 months? If so, at what severity (ROCOF) and for how long?

5. **LVRT laboratory type-test certificate:** Does Alterpower Digos Solar have a copy of the Ingeteam factory-level LVRT test report (showing inverter compliance with PGC voltage curves)? This is typically required at first witness audit and must be ≤ 5 years old.

6. **Reactive power capability test:** Has the plant ever been tested for the full 0.95 lagging to 0.95 leading range? What is the measured reactive power saturation limit (kVAr max) per inverter at rated active power?

7. **Anti-islanding detection capability:** The PGC requires solar plants to detect unintended islanding (grid disconnection while inverter continues to energize). Does the Ingeteam firmware have anti-islanding per IEEE 1547, and at what active power threshold?

---

## §12 Sources

### Primary Regulatory Documents
- [Philippine Grid Code (2016 Edition)](https://policy.asiapacificenergy.org/sites/default/files/PGC2016Edition(ResolutionNo22Seriesof2016).pdf) — ERC Resolution No. 22, Series of 2016; accessed 2026-05-10
- [Philippine Grid Code Overview](https://legacy.doe.gov.ph/philippine-grid-code) — Department of Energy Philippines official archive
- [NGCP Customer Bulletin 2024-12: Ancillary Services](https://www.ngcp.ph/Attachment-Uploads/2024-12%20CB_Ancillary%20Services-2024-03-13-14-54-23.pdf) — NGCP official; accessed 2026-05-10
- [NGCP Transmission Development Plan 2022-2040](https://www.ngcp.ph/Attachment-Uploads/Transmission%20Development%20Plan%202022-2040%20Consultation%20Draft_Web_Final-2022-03-04-10-02-48.pdf) — NGCP strategic planning document

### International Standards Referenced by NGCP
- [IRENA Grid Codes for Renewable Powered Systems](https://www.irena.org/-/media/Files/IRENA/Agency/Publication/2022/Apr/IRENA_Grid_Codes_Renewable_Systems_2022.pdf) — Provides comparative context for Q(V) droop, LVRT, and ramp-rate standards across jurisdictions; accessed 2026-05-10
- [IEC Low-Voltage Ride-Through Overview](https://www.sciencedirect.com/topics/engineering/low-voltage-ride-through-capability) — ScienceDirect; accessed 2026-05-10
- [IEEE 1547 — Standard for Distributed Energy Resources](https://standards.ieee.org/standard/1547-2018.html) — Referenced in PGC Chapter 4; not accessed directly but cited in local documentation

### Grid Stability & Frequency Response
- [Frequency Nadir and ROCOF in VRE Sector](https://filipinoengineer.com/blog/2025/11/frequency-nadir-implications-prevention-detection-and-standards-compliance-in-the-variable-renewable-energy-vre-sector.html) — Filipino Engineer technical blog; 2025
- [Rate of Change of Frequency (RoCoF) Significance and Control](https://filipinoengineer.com/blog/2025/11/rate-of-change-of-frequency-rocof-significance-control-and-compliance-in-modern-power-systems.html) — Filipino Engineer; 2025
- [ENTSO-E: Inertia and RoCoF](https://www.entsoe.eu/Documents/SOC%20documents/Inertia%20and%20RoCoF_v17_clean.pdf) — European context; applicable to Philippine 60 Hz systems by analogy
- [Dynamic Sizing of Frequency Control Ancillary Service (FCAS) Requirements for Philippine Grid](https://arxiv.org/abs/2301.02021) — Academic analysis; 2023

### Curtailment and Active Power Management
- [NREL: Curtailment Paradox in High Solar Future](https://www.nrel.gov/grid/news/program/2021/the-curtailment-paradox-in-a-high-solar-future.html) — US context but applicable to resource-constrained grids like Mindanao
- [IEA PVPS: Active Power Management of Photovoltaic Systems](https://iea-pvps.org/wp-content/uploads/2024/01/IEA-PVPS-T14-15-REPORT-Active-Power-Management.pdf) — International best practice; accessed 2026-05-10
- [Solar PV Guidebook Philippines](https://energypedia.info/images/8/8f/Solar_PV_Guidebook_Philippines_2014.pdf) — ERC-adjacent guidance; 2014 but still valid
- [NGCP Article: Grid Stability Risks from High Solar Penetration](https://mb.com.ph/2026/01/07/ngcp-flags-grid-stability-risks-linked-to-meralcos-3500-mw-terra-solar-project/) — Manila Bulletin news; January 2026

### Ingeteam INGECON Modbus Reference
- [Ingeteam Unit Commands & Modbus (AAA0030IMB03_N)](https://www.ingeras.es/archive/protocols/AAA0030/IMB03/AAA0030IMB03_N.pdf) — Official Ingeteam protocol specification; accessed 2026-05-10
- [Ingeteam Manual: INGECON SUN Communication](https://www.ingeteam.com/Download/2777/attachment/ingecon-sun-communication.pdf.aspx) — Vendor technical manual
- [INGECON SUN 1Play TL M Installation Manual](https://www.manualslib.com/manual/1280224/Ingeteam-Ingecon-Sun-1play-Tl-M.html?page=94) — Includes Modbus register mapping and configuration

### Local Documentation (Project Files)
- `docs/NGCP_Grid_Compliance_Implementation.docx` — Deep-research brief and implementation plan for ADSI Dashboard grid compliance feature; includes 7 canonical VRE test procedures and Ingeteam Modbus command interface
- `docs/Grid_Compliance_Testing_Manual_PGC2016.docx` — Field test procedure manual covering pre-test prerequisites, test T1–T7 full procedure, acceptance criteria, and Ingeteam register logging strategy

---

## Summary: Dashboard Readiness Assessment

**As of May 2026:**
- ✓ **Foundation in place:** Poller already reads 60+ Modbus registers per inverter at 1 Hz; audit logging infrastructure exists
- ✓ **Frequency monitoring:** Register 30074 sampled and stored; ROCOF calculation feasible
- ✓ **Power curtailment control:** Register 41001 write function tested; ramp-rate control via dc-link feedback loop in inverter firmware
- ✓ **Reactive power control:** Register 41002 write function exists; Q(V) droop logic can be enabled via firmware settings
- ✗ **LVRT/HVRT testing:** Requires external programmable voltage source; dashboard can only **observe and log** inverter response
- ✗ **Test report generation:** Manual PDF assembly currently; automation would require template + embedded plot library
- ✗ **Witness coordination UI:** No pre-built modal for witness sign-off and test narrative

**Recommended next phase:** Implement automated test runner for curtailment (T1, T6) and reactive power (T3) sweeps. Defer LVRT/HVRT until voltage source test equipment is available on-site. Prioritize audit-log forensics for any unplanned inverter trips during live grid events.

---

**End of Research Summary**

*Prepared: 2026-05-10*  
*Sources: PGC 2016, local NGCP documentation, Ingeteam vendor specs, IRENA/IEC/IEEE references*  
*For: Alterpower Digos Solar grid compliance planning*
