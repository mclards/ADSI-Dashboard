# Register Decode Traceback vs Official PDF

Date: 2026-05-11
Status: AUDIT — no code changes proposed without operator sign-off.
Source PDF: [docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf](../../docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf)
Page extracts:
[pg04](../../docs/IngeconSunPMax-Modbus-pg04.txt) ·
[pg05](../../docs/IngeconSunPMax-Modbus-pg05.txt) ·
[pg06](../../docs/IngeconSunPMax-Modbus-pg06.txt) ·
[pg07](../../docs/IngeconSunPMax-Modbus-pg07.txt) ·
[pg08](../../docs/IngeconSunPMax-Modbus-pg08.txt) ·
[pg10](../../docs/IngeconSunPMax-Modbus-pg10.txt) ·
[pg15](../../docs/IngeconSunPMax-Modbus-pg15.txt) ·
[pg16](../../docs/IngeconSunPMax-Modbus-pg16.txt) ·
[pg17](../../docs/IngeconSunPMax-Modbus-pg17.txt)

Triggered by: operator screenshot of Energy Summary export with zero-data
nodes + PAC↔HW counter discrepancies (audit thread above). Before changing
any baseline-anchor or filtering logic, we audited the raw register decode
to make sure none of the upstream values were already wrong.

---

## Reading model (confirmed)

PDF §2.1 pg10: `0x30001 register is addressed at 0`. We confirmed this with
our actual reads:

| Decoded variable | PDF reg | Code reg index | Status |
|---|---|---|---|
| Etotal kWh hi/lo | 30001-30002 | regs[0..1] | ✓ |
| Alarm bits hi/lo | 30007-30008 | regs[6..7] | ✓ |
| Vdc | 30009 | regs[8] | ✓ |
| Idc (signed) | 30010 | regs[9] | ✓ |
| Vac1-3 | 30011-30013 | regs[10..12] | ✓ |
| Iac1-3 | 30014-30016 | regs[13..15] | ✓ |
| CosΦ × 1000 | 30017 | regs[16] | ✓ |
| Sign of sin Φ | 30018 | regs[17] | ✓ |
| PAC (signed, tens of W) | 30019 | regs[18] | ✓ |
| Fac (×100 Hz) | 30020 | regs[19] | ✓ |
| RTC year/mo/day/h/m/s | 30021-30026 | regs[20..25] | ✓ |
| AAP0016 analog 1-4 | 30042-30045 | regs[41..44] | ✓ |
| PT100 1-2 | 30046-30047 | regs[45..46] | ✓ |
| parcE kWh hi/lo | 30059-30060 | regs[58..59] | ✓ |
| TempCI heatsink (signed) | 30072 | regs[71] | ✓ (with -1 ISM offset) |
| Inst alarms (slow) | 30065-30066 | slow regs[0..1] | ✓ |
| Maint alarms (slow) | 30067-30068 | slow regs[2..3] | ✓ |
| QAC reactive (slow, signed) | 30069 | slow regs[4] | ⚠️ see §1 |
| Zpos / Zneg | 30070-30071 | slow regs[5..6] | ⚠️ see §3 |
| TempINT control | 30073 | slow regs[8] | ✓ |
| Inverter state raw | 30074 | slow regs[9] | ✓ |
| VpvN / VpvP | 30075-30076 | slow regs[10..11] | ✓ |
| Nominal power ÷10 | 30077 | slow regs[12] | ✓ raw × 10 = W |
| Time-to-connect | 30109-30110 | slow regs[44..45] | ✓ |
| Power-reduction bits | 30117 | slow regs[52] | ✓ |

---

## Findings (severity-ordered)

### 🔴 Finding 1 — QAC reactive-power scaling is reversed (read side)

**Spec ([pg07](../../docs/IngeconSunPMax-Modbus-pg07.txt) line 7):**
`30069 QAC (Reactive power DIV 10) yes`

The PDF uses identical phrasing for two reactive-power-class registers we
already trust:

| Register | PDF phrasing | Decoded as |
|---|---|---|
| 30019 PAC | "in tens of Watt" | `raw × 10 = W` ✓ confirmed (`pac_w` max 245 kW for a 250 kW inverter) |
| 30077 Nominal power | "Nominal power DIV 10" | `raw × 10 = W` ✓ used by Slice β-4 detector |
| 30069 QAC | "Reactive power DIV 10" | should be `raw × 10 = VAr` ❌ |

**Our code ([services/inverter_engine.py:1291](../../services/inverter_engine.py#L1291)):**
```python
qac_var = qac_raw / 10.0 if qac_raw != 0 else None  # None = offline/silent
```

This computes `raw ÷ 10`, which is the **inverse** of the spec convention.
Net effect: QAC is reported **100× smaller** than the inverter is actually
producing (factor of 100 because we divide by 10 instead of multiplying by
10). Variable is even named `qac_var` (intent: VAr) so the math, not the
intent, is wrong.

**Why we missed it:** the Slice β plan parameter map line 1243 in
`services/inverter_engine.py` documents the field as `Int16, ÷10 → W` —
the same direction as the buggy code. The plan and the code share the
mistake; the PDF is the only source of truth that contradicts both.

**Why we couldn't catch it from runtime data:** the dev DB has
`qac_var_avg` NULL in **0/634** `inverter_5min_param` rows — slow-poll
either didn't run or always read 0 on this gateway. No empirical anchor
to choose between the two interpretations from data alone. The symmetry
argument with 30077 (which we DID validate against 244-kW operator
inverters reading ~24,425 raw → ×10 → 244,250 W) is the basis for this
finding.

**Severity:** moderate to high. Reactive power is currently consumed by:
- `inverter_5min_param.qac_var_avg` (storage, no operator-visible output yet)
- Slice ζ Q-V chart in T3 compliance PDFs ([server/compliance/reportGenerator.js:_buildQvChartSection](../../server/compliance/reportGenerator.js))
- The Grid Code tab read-back UI ([public/js/app.js:9783+](../../public/js/app.js#L9783))

Until corrected, T3 compliance PDFs show Q values ~100× too small. None of
these flows compare QAC against an external truth, so the dashboard "looks
internally consistent" — but the absolute magnitudes are wrong.

**Recommended fix (one-line):**
```python
# services/inverter_engine.py:1291 — was qac_raw / 10.0
qac_var = qac_raw * 10 if qac_raw != 0 else None
```
Plus a matching update to the parameter-map docstring at line 1243 and to
the regs-90 comment at line 94.

**Verification before merge:** ask operator to (a) verify a single inverter
running with non-trivial PF (e.g., during a T3 sweep) reports QAC in the
correct tens-of-kVAr range, and (b) confirm Q ≈ √(S² − P²) holds within
±5 % using the simultaneous PAC and CosΦ readings.

---

### 🔴 Finding 2 — Slice ζ kVAr write under-writes by 10× (likely)

**Spec ([pg16](../../docs/IngeconSunPMax-Modbus-pg16.txt) line 26):**
> `9 Change reactive power ref · React. power in (KVAr/10) · Nominal power of the inverter div 10`

The phrasing `(KVAr/10)` is ambiguous, but the LIMIT clause says max raw =
"Nominal power of the inverter div 10" — exactly the value we read from
register 30077 (e.g. 24,425 for a 244-kW inverter). For raw 24,425 to
correspond to the inverter's max reactive capacity (≈ 244 kVAr at PF 0),
the unit must be:
```
244,000 VAr / 24,425 raw ≈ 10 VAr per LSB
```
i.e. **raw × 10 = VAr** — same convention as PAC and Nominal Power.

**Our UI code ([public/js/app.js:10061](../../public/js/app.js#L10061)):**
```js
const kvar_div10 = Math.round(kvar * 10);   // operator types kVAr → raw
```
This converts `1 kVAr → raw=10 → inverter writes 100 VAr = 0.1 kVAr`. So
the operator typing 50 kVAr would actually set the inverter to **5 kVAr**.

**Caveat:** because the read-back of 41008 ([app.js:10006](../../public/js/app.js#L10006))
applies the SAME `÷10` interpretation, the displayed value matches what
the operator typed. The discrepancy is only visible if you compare against
the QAC measurement (which is also wrong by 100×, masking the issue).

**Severity:** high once Slice ζ is unlocked for production (currently flag-
gated). Compliance T3 sweeps drive PF setpoints, not kVAr setpoints, so
this is dormant for the planned NGCP test sequence — but it WILL bite if
an operator manually sets a kVAr reference for the first time.

**Recommended fix (matched pair):**
```js
// public/js/app.js:10061
const kvar_div10 = Math.round(kvar * 100);   // raw = kVAr × 100 (= VAr / 10)
// app.js:10006 read-back display
${Number(data.reactive_kvar || 0).toFixed(2)} kVAr  // computed as raw / 100
```
And in [server/index.js:14343](../../server/index.js#L14343):
```js
result.reactive_kvar = result.reactive_signed / 100;   // was /10
```

---

### ⚠️ Finding 3 — Idc/Iac scaling is correct but comments lie

**Spec ([pg05](../../docs/IngeconSunPMax-Modbus-pg05.txt) lines 3, 7-9):**
- `30010 Idc : Average input current estimation. In Amps yes`  (signed)
- `30014-30016 Iac1-3 : Grid RMS Current, In Amps`

i.e. **1 A per LSB**.

**Our code ([server/poller.js:688-694](../../server/poller.js#L688-L694)):**
```js
const idc  = Number(_signedInt16(row.idc  || 0));   // raw, no scaling
const iac1 = Number(row.iac1 || 0);                  // raw, no scaling
…
const safePdc = vdc * idc <= 265000 ? vdc * idc : 0; // V × A → W
```
Math is consistent with **1 A/LSB**: a 600-V × 408-A inverter computes
Pdc ≈ 245 kW, and the 265-kW clamp gives ~6 % headroom — sane.

**Code comments ([poller.js:723-727](../../server/poller.js#L723-L727)):**
```js
//   idc  — 0.1 A/LSB,  real DC current 0..150 A (raw 0..1500)
//   iac* — 0.1 A/LSB,  real AC current 0..500 A (raw 0..5000)
```
**These comments are wrong** — they describe `0.1 A/LSB` while the code
uses `1 A/LSB`. Plan
[plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice α](../../plans/2026-05-10-modbus-registers-official-revamp.md)
contains the same mistake (the comment in [services/inverter_engine.py:95](../../services/inverter_engine.py#L95)
calls Idc "signed, 0.1 A/LSB" too).

**Severity:** doc-only — math is right, runtime behavior matches the spec.
The comments will mislead future maintainers if not corrected, especially
during noise-floor / clamp tuning.

**Recommended fix:** doc-only edit to the three comment blocks; no runtime
change.

---

### ⚠️ Finding 4 — Zpos / Zneg unit unclear in spec

**Spec ([pg07](../../docs/IngeconSunPMax-Modbus-pg07.txt) lines 8-9):**
- `30070 Zpos (Solar field impedance, POS-EARTH)`
- `30071 Zneg (Solar field impedance, NEG-EARTH)`

The PDF gives no unit. Our variable name (`zpos_kohm`) implies kΩ but we
have no spec-side confirmation. The ALARMA_PARO_AISL_DC isolation alarm
fires below some impedance threshold; we should cross-check the threshold
the inverter UI shows against our raw values.

**Severity:** low. Currently used only as min/max/last in `inverter_5min_param`;
no decisions are made on the absolute magnitude.

**Recommended action:** when slow-poll is observed live, capture a known
"healthy" Zpos value and compare against the ISM display. If ISM shows
e.g. `1500 kΩ` and the slow-poll reports `1500`, the unit is kΩ as
assumed. If it shows `1.5 MΩ`, raw might be in Ω. Document the answer.

---

### ⚠️ Finding 5 — Slice α plan claims Idc 0.1 A/LSB; PDF says 1 A/LSB

This is the same mismatch as Finding 3 but tracked separately because the
acceptance criterion in the implementation status audit
([audits/2026-05-11/modbus-revamp-implementation-status.md](modbus-revamp-implementation-status.md))
is checked against the plan's claim, not the PDF. Update the plan, the
status audit, and the reference card simultaneously to keep them in sync.

---

## Things explicitly verified as correct

- **Etotal kWh** — `_u32_hi_lo(regs, 0)` produces values like 4,014,354 (= 4 GWh
  lifetime, plausible for an 8-year-old 250-kW unit). Hi-lo order verified
  by reading consecutive frames where Etotal advances ~17 kWh per hour at
  200-kW PAC ≈ correct rate.
- **PAC sign extension (Slice α)** — operator data shows pac_w max 245,379 W
  for a 250-kW inverter. The Int16 sign extension is the right call:
  without it, large positive values (>32,767 raw, i.e. PAC > 327 kW)
  would silently appear as negative; with it, both signs render correctly
  and the > 260 kW raw clamp catches word-swapped firmware variants.
- **PAC × 10 scaling** — pac_w averages ~129 kW under partial sun, max 245 kW —
  consistent with a 250-kW inverter. Decoded as `raw × 10 = W`.
- **Fac ÷ 100 scaling** — confirmed by ISM-display parity in the operator's
  Wireshark capture (referenced in [services/inverter_engine.py:1133](../../services/inverter_engine.py#L1133)).
- **Etotal/parcE hi-lo word order** — `_u32_hi_lo` puts the higher-address
  register in the high half, matching the PDF byte-order example
  ([pg10](../../docs/IngeconSunPMax-Modbus-pg10.txt) lines 27-30): "Value
  of E_total (byte 0, highest)" appears at offset 3 in the data block.
- **TempCI -1 °C ISM-parity offset** — cross-validated against Stop Reason
  snapshot's idx-11 `temp` field (verified 2026-04-27, see comment block
  in [services/inverter_engine.py:1140-1154](../../services/inverter_engine.py#L1140-L1154)).
- **Cmd 1 phi tangent ±15870 limit** — matches PDF
  ([pg16](../../docs/IngeconSunPMax-Modbus-pg16.txt) line 12).
- **Cmd 11 disable_reactive** — single-frame write with no data parameter,
  matches PDF ([pg16](../../docs/IngeconSunPMax-Modbus-pg16.txt) line 29).
- **Clock sync transport** — Wireshark-confirmed plain FC16 broadcast to
  unit 0, addr 0, six UINT16s `[year, month, day, hour, minute, second]`.
  Matches our `sync_clock()` implementation
  ([CLAUDE.md "Slice D clock-sync transport — template-gate retired in v2.9.0"](../../CLAUDE.md)).

---

## Recommended fix order (lowest risk first)

1. **Doc-only**: correct the Idc/Iac "0.1 A/LSB" comments in
   [server/poller.js:723-727](../../server/poller.js#L723-L727) and
   [services/inverter_engine.py:95](../../services/inverter_engine.py#L95)
   and the Slice α plan/audit references. Zero runtime risk; locks in the
   correct convention for future contributors. (Finding 3 + 5)
2. **QAC read fix** (Finding 1): one-line change in
   [services/inverter_engine.py:1291](../../services/inverter_engine.py#L1291).
   Run a single inverter for one solar day, compare Q against
   `√(S² − P²)` from PAC and CosΦ — should agree within 5 %.
3. **Slice ζ kVAr write fix** (Finding 2): two-file change (app.js +
   index.js) plus updated unit in any tests. Validate on the operator's
   bench inverter at low setpoint (e.g. 5 kVAr) before opening the gate
   for fleet use.
4. **Zpos/Zneg unit confirmation** (Finding 4): no code change needed;
   add a one-line comment naming the unit once the operator confirms it
   from the ISM display.

No findings invalidate the PAC↔HW discrepancy diagnosis from the parent
audit — the BASELINE_LATE root cause stands. Both the Energy Summary
columns and the new Status classifier read PAC- and Etotal-side values
that we've now confirmed are decoded correctly.
