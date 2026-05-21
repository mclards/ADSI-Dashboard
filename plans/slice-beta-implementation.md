# Slice β — Slow-Poll Diagnostic Capture Implementation Plan

| Field | Value |
|---|---|
| Date | 2026-05-10 |
| Status | DRAFT — for tdd-guide handoff |
| Parent plan | [plans/2026-05-10-modbus-registers-official-revamp.md](plans/2026-05-10-modbus-registers-official-revamp.md) §4 Slice β |
| Risk | LOW-MED |
| Estimate | 18–28 hours |
| Depends on | Slice α (commit 7daf91e) — `_signed_int16` helpers in place at [services/inverter_engine.py:74](services/inverter_engine.py#L74) and [server/poller.js:589](server/poller.js#L589) |

---

## §1 Slow-poll architecture decision

### Overview
Slice β adds a second, slower polling tier to the existing fast-poll loop. The fast poll (every 1–2 s) captures live telemetry (power, voltage, current, alarms). The slow poll (every 30 s, tunable) captures diagnostic registers that don't change rapidly: reactive power, impedance, control-electronics temperature, inverter state, power-reduction status, and alarm windows.

### Two-tier polling rationale
- **Fast poll:** `read_fast_async()` → addr 0–77 (78 regs, includes AAP0016 block) every 1–2 s per inverter
  - Current: 72 regs (addr 0–71)
  - Widening: add AAP0016 block (addr 41–46, 6 regs) to the fast-poll transaction instead of a separate slow read
  - Cost: negligible (~12 bytes/cycle per slave × 27 inverters × 4 nodes = ~1.3 kB per cycle at 1-s interval)
  - Rationale: AAP0016 may contain weather-station data (irradiance, temp, wind) needed for real-time Solcast correction; keep it in the hot path

- **Slow poll:** new `read_slow_async()` → addr 64–116 (53 regs) every 30 s per inverter
  - Cost: ~0.3 kB/s fleet-wide (27 inverters × 4 nodes × 53 regs × 2 bytes/reg ÷ 30 s)
  - Negligible vs. current fast-poll volume (~150 kB/s)
  - Cadence: settings-tunable via `slowPollIntervalS` (default 30 s, range 0 to disable or 5–300 s)

### Frame merge strategy
Python will **merge slow data into the existing fast-poll frame** and push both in a single `/data` POST:
- When slow-poll completes (every 30 s), augment the `shared[ip]` array by attaching slow-poll keys to the most recent frame for that unit
- Node receives: one unified frame per cycle with both `fast_fields` and `slow_fields` (slow fields are sparse — present only after slow-poll updates)
- Backward-compat: when slow-poll hasn't run yet, slow fields default to `null` in the frame

**Rationale:** 
1. Single POST per 1–2 s keeps the WS bridge simple
2. Aggregator sees all fields in one place → natural for 5-min averaging
3. Remote mode proxy works unchanged (one GET, one response)

---

## §2 Fast-poll widening for AAP0016 (addr 41–46)

### Decision: Option (a) — single 78-reg fast-poll
**Chosen.** Extend the existing `read_fast_async()` from 72 regs (addr 0–71) to 78 regs (addr 0–77), adding the AAP0016 analog inputs + PT100 in the fast-poll block.

**Justification:**
- AAP0016 is for future weather station (irradiance, ambient temp, wind)
- If/when installed, weather data will influence Solcast refresh decisions → should be in the hot path
- Cost is 12 bytes per 1–2 s cycle — negligible
- Simplifies code: one contiguous read (0–77) in fast, one separate read (64–116) in slow
- No new transaction overhead

**Backward-compat:**
- `read_fast_async()` defaults to `0` for each AAP0016 reg if not present on the inverter
- Existing decoder logic `regs[i] if len(regs) > i else 0` already handles short reads
- Frame keys `analog_in_1..4`, `pt100_1`, `pt100_2` default to `null` for legacy

---

## §3 Concrete file changes

### §3.1 services/inverter_engine.py

**Read-fast widening (lines 1047–1069):**
```python
# Line 1048-1049 — update docstring
async def read_fast_async(client, unit, ip):
    """
    Read 78 input registers (addr 0–77): standard telemetry + AAP0016.
    [old docstring preserved]
    Widened from 72→78 regs in v2.10.x (Slice β) to capture:
      • Analog inputs 1–4 (reg 41–44): 12-bit ADC, 0–4095 (AAP0016)
      • PT100 temps 1–2 (reg 45–46): temperature probes (AAP0016)
    All legacy keys preserved; new keys are additive (null if AAP0016 not installed).
    """

# Line 1067 — change read count from 72 to 78
regs = await safe_read(_threaded_read_input, client, 0, 78, unit, ip)
```

**Return dict addition (after line 1202, before closing brace at line 1203):**
```python
        # ─── NEW fields (v2.10.x Slice β — AAP0016 analog inputs) ───
        "analog_in_1":   int(reg(41) or 0),        # 12-bit ADC input 1 (0–4095)
        "analog_in_2":   int(reg(42) or 0),        # 12-bit ADC input 2
        "analog_in_3":   int(reg(43) or 0),        # 12-bit ADC input 3
        "analog_in_4":   int(reg(44) or 0),        # 12-bit ADC input 4
        "pt100_1":       int(reg(45) or 0),        # PT100 probe 1 (raw ADC)
        "pt100_2":       int(reg(46) or 0),        # PT100 probe 2 (raw ADC)
```

**New `read_slow_async()` function (insert after line 1203, before poll_inverter definition at line 1210):**
```python
async def read_slow_async(client, unit, ip):
    """
    Read 53 diagnostic input registers (addr 64–116).
    Runs on a slow cadence (default 30 s per SLOW_POLL_INTERVAL_S setting).
    
    Returns a dict keyed to slow-field names, or None on failure.
    Safe defaults (0 or None) for missing regs preserve backward-compat if
    the device doesn't support the full range.
    
    Wire format: read_input_registers(address=64, count=53, unit=unit)
      Modbus addresses 30065–30117 (PDF §2 p6–9)
    
    Field decode (per PDF + plan §2 register map):
      addr 64-65  30065-30066  Instantaneous alarms        UInt32 hi-lo
      addr 66-67  30067-30068  Maintained alarms            UInt32 hi-lo
      addr 68     30069        QAC reactive power (signed)  Int16, ÷10 → W
      addr 69     30070        Zpos (impedance POS-EARTH)   UInt16 kΩ
      addr 70     30071        Zneg (impedance NEG-EARTH)   UInt16 kΩ
      addr 71     30072        (reserved)
      addr 72     30073        TempINT control electronics  Int16 signed, °C
      addr 73     30074        Estado inverter state        UInt16 bitfield
      addr 74-75  30075-30076  VpvN / VpvP solar voltages   UInt16 each, V
      addr 76     30077        Nominal power ÷10            UInt16 tens of W
      addr 77-107 30078-30108  (skip: standard stop-reason history, Slice ε)
      addr 108    30109        Time-to-connect remaining    UInt16 seconds
      addr 109    30110        Time-to-connect total        UInt16 seconds
      addr 110-115 30111-30115 (skip: MS mirrors, dynamic on this site)
      addr 116    30117        Power-reduction status bits   UInt16 bitfield
    
    Notes:
      - TempINT (addr 72) threshold 80 °C; newly captured, not yet surfaced in UI
      - Estado (addr 73) decoded by Slice γ; Slice β just captures raw bitfield
      - Nominal power (addr 76) cross-checks operator-configured ratedKw
      - Power-reduction bits (addr 116) bit 0 = limited, bit 1 = Modbus reduction (critical for Slice δ)
    """
    if is_write_pending(ip):
        await asyncio.sleep(min(READ_SPACING, 0.01))
        return None
    
    regs = await safe_read(_threaded_read_input, client, 64, 53, unit, ip)
    if not regs:
        return None
    
    def reg(i):
        return regs[i] if len(regs) > i else 0
    
    # Instantaneous alarms (regs 0-1 in the read, offset 64 in the device)
    try:
        alarms_inst_32 = _u32_hi_lo(regs, 0)   # regs[0:2] → addr 64-65
    except ValueError:
        alarms_inst_32 = 0
    
    # Maintained alarms (regs 2-3 in the read, offset 66 in the device)
    try:
        alarms_maint_32 = _u32_hi_lo(regs, 2)  # regs[2:4] → addr 66-67
    except ValueError:
        alarms_maint_32 = 0
    
    # QAC reactive power (addr 68, reg index 4 in this read) — Int16 signed
    # Per PDF: signed, units ÷10 → reactive W
    qac_raw = int(reg(4) or 0)
    if qac_raw & 0x8000:
        qac_raw -= 0x10000
    qac_var = qac_raw / 10.0 if qac_raw != 0 else None  # None = offline/silent
    
    # Impedances
    zpos_kohm = int(reg(5) or 0)   # addr 69, unsigned
    zneg_kohm = int(reg(6) or 0)   # addr 70, unsigned
    
    # Control electronics temperature (addr 72, reg index 8 in this read) — Int16 signed
    tempint_raw = int(reg(8) or 0)
    if tempint_raw & 0x8000:
        tempint_raw -= 0x10000
    # Threshold: 80 °C per PDF. Unlike TempCI, no -1 offset or -14 sentinel documented.
    # Store as-is; UI can apply thresholds.
    tempint_c = tempint_raw if tempint_raw != 0 else None
    
    # Estado inverter state (addr 73, reg index 9) — UInt16 bitfield, decoded by Slice γ
    inverter_state_raw = int(reg(9) or 0)
    
    # Solar field voltages (addr 74-75, reg indices 10-11)
    vpv_n_v = int(reg(10) or 0)   # Negative-earth
    vpv_p_v = int(reg(11) or 0)   # Positive-earth
    
    # Nominal power ÷10 (addr 76, reg index 12) — UInt16, units = tens of W
    nominal_power_w = int((reg(12) or 0) * 10)  # Convert tens to watts
    
    # Time-to-connect counters (addr 108-109, reg indices 44-45)
    time_to_connect_s = int(reg(44) or 0)        # Remaining
    time_to_connect_total_s = int(reg(45) or 0)  # Configured total
    
    # Power-reduction status bits (addr 116, reg index 52 in this read)
    power_reduction_bits = int(reg(52) or 0)
    
    return {
        "ts":                   int(time.time() * 1000),
        # ─── Alarm windows ───
        "alarms_inst_32":       alarms_inst_32,     # 1-second reset window
        "alarms_maint_32":      alarms_maint_32,    # Reset on grid reconnect
        # ─── Reactive / diagnostics ───
        "qac_var":              qac_var,            # Reactive W (None if offline)
        "zpos_kohm":            zpos_kohm,          # Impedance POS-EARTH
        "zneg_kohm":            zneg_kohm,          # Impedance NEG-EARTH
        "tempint_c":            tempint_c,          # Control electronics °C (threshold 80)
        # ─── State / capability ───
        "inverter_state_raw":   inverter_state_raw, # Decoded by Slice γ
        "vpv_n_v":              vpv_n_v,            # Solar field voltage NEG-EARTH
        "vpv_p_v":              vpv_p_v,            # Solar field voltage POS-EARTH
        "nominal_power_w":      nominal_power_w,    # Rated power as reported by device
        # ─── Connection / control ───
        "time_to_connect_s":           time_to_connect_s,
        "time_to_connect_total_s":     time_to_connect_total_s,
        "power_reduction_bits":        power_reduction_bits,  # Bit 1 = Modbus reduction active (Slice δ)
    }
```

**New slow-poll coroutine (insert after line 1299, before metrics_state definition at line 2126):**
```python
async def slow_poll_inverter(ip):
    """
    Background task: poll slow-diagnostic registers every SLOW_POLL_INTERVAL_S.
    Merges results into shared[ip] by attaching slow-field keys to the latest frame.
    
    Runs in parallel with poll_inverter; neither blocks the other.
    Per-inverter task (not per-unit within inverter).
    """
    slow_interval_key = f"slowPollIntervalS_{ip}"
    
    print(f"[SLOW-POLL] Started  {ip}")
    
    while True:
        try:
            # Get current slow-poll cadence from settings (tunable at runtime)
            # Default 30 s; set to 0 to disable slow-poll for this IP.
            slow_interval_s = float(_load_poll_config_sync().get(slow_interval_key, 30))
            
            if slow_interval_s <= 0:
                # Slow-poll disabled for this IP
                await asyncio.sleep(1)
                continue
            
            # Wait for a live client
            client = clients.get(ip)
            if not client:
                await asyncio.sleep(0.5)
                continue
            
            # Discover units (same as fast-poll)
            units = await detect_units_async(ip)
            if not units:
                await asyncio.sleep(1)
                continue
            
            # Slow-poll each unit
            out_slow = []
            for u in units:
                slow_data = await read_slow_async(client, u, ip)
                if slow_data:
                    slow_data["unit"] = u
                    out_slow.append(slow_data)
            
            # Merge slow data into shared[ip] by attaching slow-field keys
            # to the most recent frame for each unit.
            if out_slow:
                fast_frames = shared.get(ip, [])
                if isinstance(fast_frames, list):
                    for slow_frame in out_slow:
                        u_target = slow_frame.get("unit")
                        # Find the fast frame for this unit
                        for fast_frame in fast_frames:
                            if fast_frame.get("unit") == u_target:
                                # Attach slow fields
                                fast_frame.update(slow_frame)
                                break
            
            # Sleep for the configured interval
            await asyncio.sleep(slow_interval_s)
        
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[SLOW-POLL] {ip} cycle error (continuing): {type(e).__name__}: {e}")
            await asyncio.sleep(min(slow_interval_s if 'slow_interval_s' in locals() else 30, 1.0))
```

**Supervisor task launch (in `main_loop()` function, after `asyncio.create_task(poll_inverter(ip))` block):**
Find the main_loop where `asyncio.create_task(poll_inverter(ip))` is called. Add a corresponding:
```python
asyncio.create_task(slow_poll_inverter(ip))  # Parallel slow-poll per IP
```

---

### §3.2 server/poller.js

**Extend parseRow return object (around line 701–731, add new keys after temp_c):**
```javascript
  // v2.10.x Slice β — slow-poll diagnostic fields (additive).
  // Defaults to null for legacy frames (slow-poll hasn't run yet).
  const alarms_inst_32 = Math.max(0, Math.trunc(Number(row.alarms_inst_32 || 0)));
  const alarms_maint_32 = Math.max(0, Math.trunc(Number(row.alarms_maint_32 || 0)));
  const qac_var = Number.isFinite(Number(row.qac_var)) ? Number(row.qac_var) : null;
  const zpos_kohm = Math.max(0, Math.trunc(Number(row.zpos_kohm || 0)));
  const zneg_kohm = Math.max(0, Math.trunc(Number(row.zneg_kohm || 0)));
  const tempint_c = Number.isFinite(Number(row.tempint_c)) ? Number(row.tempint_c) : null;
  const inverter_state_raw = Math.max(0, Math.trunc(Number(row.inverter_state_raw || 0)));
  const vpv_n_v = Math.max(0, Math.trunc(Number(row.vpv_n_v || 0)));
  const vpv_p_v = Math.max(0, Math.trunc(Number(row.vpv_p_v || 0)));
  const nominal_power_w = Math.max(0, Math.trunc(Number(row.nominal_power_w || 0)));
  const time_to_connect_s = Math.max(0, Math.trunc(Number(row.time_to_connect_s || 0)));
  const time_to_connect_total_s = Math.max(0, Math.trunc(Number(row.time_to_connect_total_s || 0)));
  const power_reduction_bits = Math.max(0, Math.trunc(Number(row.power_reduction_bits || 0)));
  // AAP0016 analog inputs (new in fast-poll widening)
  const analog_in_1 = Math.max(0, Math.trunc(Number(row.analog_in_1 || 0)));
  const analog_in_2 = Math.max(0, Math.trunc(Number(row.analog_in_2 || 0)));
  const analog_in_3 = Math.max(0, Math.trunc(Number(row.analog_in_3 || 0)));
  const analog_in_4 = Math.max(0, Math.trunc(Number(row.analog_in_4 || 0)));
  const pt100_1 = Math.max(0, Math.trunc(Number(row.pt100_1 || 0)));
  const pt100_2 = Math.max(0, Math.trunc(Number(row.pt100_2 || 0)));

  return {
    // ... existing fields (vdc, idc, pac, etc.) ...
    // ... v2.9.0 fields (etotal_kwh, parce_kwh, fac_hz, etc.) ...
    // ... v2.10.x fields (cosphi, temp_c) ...
    // ─── NEW Slice β slow-poll fields ───
    alarms_inst_32,
    alarms_maint_32,
    qac_var,
    zpos_kohm,
    zneg_kohm,
    tempint_c,
    inverter_state_raw,
    vpv_n_v,
    vpv_p_v,
    nominal_power_w,
    time_to_connect_s,
    time_to_connect_total_s,
    power_reduction_bits,
    // ─── AAP0016 analog inputs (fast-poll widening) ───
    analog_in_1,
    analog_in_2,
    analog_in_3,
    analog_in_4,
    pt100_1,
    pt100_2,
  };
```

---

### §3.3 server/db.js

**Migration block (insert after line 1175, before closing of the CREATE TABLE block at line 1176):**
```javascript
  -- v2.10.x Slice β — slow-poll diagnostic registers
  -- Additive columns; safe to add to existing inverter_5min_param table.
  -- NULL defaults allow old rows to persist unchanged.
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    qac_var_avg REAL;  -- Reactive W average over slot
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    qac_var_min REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    qac_var_max REAL;
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    zpos_kohm_last INTEGER;  -- Last reading in slot
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    zneg_kohm_last INTEGER;
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    tempint_c_avg REAL;  -- Average over slot
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    tempint_c_min REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    tempint_c_max REAL;
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    inverter_state_raw_last INTEGER;  -- Decoded by Slice γ; raw stored here for audit
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    vpv_n_v_avg REAL;  -- Solar field voltage N
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    vpv_n_v_min REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    vpv_n_v_max REAL;
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    vpv_p_v_avg REAL;  -- Solar field voltage P
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    vpv_p_v_min REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    vpv_p_v_max REAL;
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    nominal_power_w_last INTEGER;  -- Device-reported rated power (cross-check vs configured)
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    time_to_connect_s_last INTEGER;  -- Last observed countdown
  
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    power_reduction_bits_last INTEGER;  -- Bit field snapshot
  
  -- Alarm windows
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    alarms_inst_32_max INTEGER;  -- Bitwise OR of all instantaneous alarms in slot
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    alarms_maint_32_max INTEGER;  -- Bitwise OR of all maintained alarms
  
  -- AAP0016 analog inputs (gated behind settings toggle, default off)
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    analog_in_1_avg REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    analog_in_2_avg REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    analog_in_3_avg REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    analog_in_4_avg REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    pt100_1_avg REAL;
  ALTER TABLE IF NOT EXISTS inverter_5min_param ADD COLUMN IF NOT EXISTS
    pt100_2_avg REAL;
```

---

### §3.4 server/dailyAggregator.js

**Extend _RANGES (around line 179, after existing ranges):**
```javascript
const _RANGES = {
  // ... existing ranges ...
  qac:        [-32768, 32767],        // Reactive W (signed), raw Int16 before ÷10
  tempint:    [-40, 150],             // Control electronics °C
  vpv:        [0, 1500],              // Solar field voltage V
  zpos:       [0, 100_000],           // Impedance kΩ (sanity ceiling)
  zneg:       [0, 100_000],
  nominal_kw: [0, 50_000],            // Nominal power W (sanity ceiling for 27×~1000 kW fleet)
  ttc:        [0, 65535],             // Time-to-connect seconds (UInt16 max)
  analog:     [0, 4095],              // 12-bit ADC raw
  alarms:     [0, 0xFFFFFFFF],        // 32-bit alarm bitfield
};
```

**Extend _newBucket (around line 203, after existing sums):**
```javascript
function _newBucket(ip, slave, dateLocal, slotIndex, tsMs) {
  // ... existing fields ...
  return {
    // ... existing bucket fields ...
    
    // Slice β slow-poll aggregates
    sumQac: 0, nQac: 0,
    sumTempint: 0, nTempint: 0,
    sumVpvN: 0, nVpvN: 0,
    sumVpvP: 0, nVpvP: 0,
    zpLast: null,
    znLast: null,
    stateRawLast: null,
    nominalPowerLast: null,
    ttcLast: null,
    prBitsLast: null,
    
    // Alarm windows (bitwise OR)
    alarmsInst: 0,
    alarmsMaint: 0,
    
    // AAP0016 analog (sum for averaging)
    sumAnalog1: 0, nAnalog1: 0,
    sumAnalog2: 0, nAnalog2: 0,
    sumAnalog3: 0, nAnalog3: 0,
    sumAnalog4: 0, nAnalog4: 0,
    sumPt100_1: 0, nPt100_1: 0,
    sumPt100_2: 0, nPt100_2: 0,
    
    sampleCount: 0,  // (moved here for visual clarity)
  };
}
```

**Extend _accum (around line 241, after existing field handling):**
```javascript
function _accum(b, row) {
  // ... existing field handling ...
  
  // Slice β slow-poll fields
  const qac = _vRange(row, "qac_var", _RANGES.qac);
  const tempint = _vRange(row, "tempint_c", _RANGES.tempint);
  const vpvN = _vRange(row, "vpv_n_v", _RANGES.vpv);
  const vpvP = _vRange(row, "vpv_p_v", _RANGES.vpv);
  const zpos = _vRange(row, "zpos_kohm", _RANGES.zpos);
  const zneg = _vRange(row, "zneg_kohm", _RANGES.zneg);
  const stateRaw = Math.trunc(Number(row?.inverter_state_raw) || 0);
  const nomPower = _vRange(row, "nominal_power_w", _RANGES.nominal_kw);
  const ttc = _vRange(row, "time_to_connect_s", _RANGES.ttc);
  const prBits = Math.trunc(Number(row?.power_reduction_bits) || 0);
  const ai1 = _vRange(row, "analog_in_1", _RANGES.analog);
  const ai2 = _vRange(row, "analog_in_2", _RANGES.analog);
  const ai3 = _vRange(row, "analog_in_3", _RANGES.analog);
  const ai4 = _vRange(row, "analog_in_4", _RANGES.analog);
  const pt1 = _vRange(row, "pt100_1", _RANGES.analog);
  const pt2 = _vRange(row, "pt100_2", _RANGES.analog);
  const aInst = Math.trunc(Number(row?.alarms_inst_32) || 0);
  const aMaint = Math.trunc(Number(row?.alarms_maint_32) || 0);
  
  let touched = 0;
  if (qac != null)    { b.sumQac += qac;      b.nQac++; touched++; }
  if (tempint != null){ b.sumTempint += tempint; b.nTempint++; touched++; }
  if (vpvN != null)   { b.sumVpvN += vpvN;    b.nVpvN++; touched++; }
  if (vpvP != null)   { b.sumVpvP += vpvP;    b.nVpvP++; touched++; }
  // Last-value snapshots
  if (zpos != null)   { b.zpLast = zpos; }
  if (zneg != null)   { b.znLast = zneg; }
  if (stateRaw)       { b.stateRawLast = stateRaw; }
  if (nomPower != null){ b.nominalPowerLast = nomPower; }
  if (ttc != null)    { b.ttcLast = ttc; }
  if (prBits)         { b.prBitsLast = prBits; }
  // Alarm windows (bitwise OR per slot)
  if (aInst) { b.alarmsInst = (Number(b.alarmsInst) | aInst) >>> 0; }
  if (aMaint) { b.alarmsMaint = (Number(b.alarmsMaint) | aMaint) >>> 0; }
  // AAP0016 analog
  if (ai1 != null) { b.sumAnalog1 += ai1; b.nAnalog1++; touched++; }
  if (ai2 != null) { b.sumAnalog2 += ai2; b.nAnalog2++; touched++; }
  if (ai3 != null) { b.sumAnalog3 += ai3; b.nAnalog3++; touched++; }
  if (ai4 != null) { b.sumAnalog4 += ai4; b.nAnalog4++; touched++; }
  if (pt1 != null) { b.sumPt100_1 += pt1; b.nPt100_1++; touched++; }
  if (pt2 != null) { b.sumPt100_2 += pt2; b.nPt100_2++; touched++; }
  
  if (touched > 0) {
    b.sampleCount += 1;
    // (rest of existing touched logic)
  }
}
```

**Extend _flush to persist new columns (find _flush around line ~400, add to the INSERT statement):**
```javascript
// In the INSERT statement for inverter_5min_param, add after existing columns:
qac_var_avg, qac_var_min, qac_var_max,
zpos_kohm_last, zneg_kohm_last,
tempint_c_avg, tempint_c_min, tempint_c_max,
inverter_state_raw_last,
vpv_n_v_avg, vpv_n_v_min, vpv_n_v_max,
vpv_p_v_avg, vpv_p_v_min, vpv_p_v_max,
nominal_power_w_last,
time_to_connect_s_last,
power_reduction_bits_last,
alarms_inst_32_max, alarms_maint_32_max,
analog_in_1_avg, analog_in_2_avg, analog_in_3_avg, analog_in_4_avg,
pt100_1_avg, pt100_2_avg

// And add the corresponding VALUES in the INSERT:
${b.nQac > 0 ? b.sumQac / b.nQac : null},
${b.nQac > 0 ? Math.min(...) : null},  // Min tracking requires separate sums
${b.nQac > 0 ? Math.max(...) : null},  // Max tracking requires separate sums
${b.zpLast},
${b.znLast},
${b.nTempint > 0 ? b.sumTempint / b.nTempint : null},
${b.nTempint > 0 ? Math.min(...) : null},
${b.nTempint > 0 ? Math.max(...) : null},
${b.stateRawLast},
${b.nVpvN > 0 ? b.sumVpvN / b.nVpvN : null},
${b.nVpvN > 0 ? Math.min(...) : null},
${b.nVpvN > 0 ? Math.max(...) : null},
${b.nVpvP > 0 ? b.sumVpvP / b.nVpvP : null},
${b.nVpvP > 0 ? Math.min(...) : null},
${b.nVpvP > 0 ? Math.max(...) : null},
${b.nominalPowerLast},
${b.ttcLast},
${b.prBitsLast},
${b.alarmsInst},
${b.alarmsMaint},
${b.nAnalog1 > 0 ? b.sumAnalog1 / b.nAnalog1 : null},
${b.nAnalog2 > 0 ? b.sumAnalog2 / b.nAnalog2 : null},
${b.nAnalog3 > 0 ? b.sumAnalog3 / b.nAnalog3 : null},
${b.nAnalog4 > 0 ? b.sumAnalog4 / b.nAnalog4 : null},
${b.nPt100_1 > 0 ? b.sumPt100_1 / b.nPt100_1 : null},
${b.nPt100_2 > 0 ? b.sumPt100_2 / b.nPt100_2 : null}
```

**Note:** For proper min/max tracking, add separate bucket fields `minQac`, `maxQac`, etc., and update them during `_accum`:
```javascript
if (qac != null) {
  if (b.minQac == null || qac < b.minQac) b.minQac = qac;
  if (b.maxQac == null || qac > b.maxQac) b.maxQac = qac;
}
```

---

### §3.5 server/index.js

**Check existing `/api/params/*` endpoints (search for "inverter_5min_param").**
Confirm they already handle remote mode (per [project_inverter_5min_param_remote_blank.md](C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/project_inverter_5min_param_remote_blank.md)):
```javascript
// Should already exist:
if (isRemoteMode()) {
  return proxyToRemote("GET", `/api/params/*`);
}
```

If not present, add it. No new endpoint needed; existing GETs already do `SELECT *` and will include new columns automatically.

---

### §3.6 public/js/app.js + public/index.html — Parameters page columns + toggle

**public/js/app.js — Settings storage and Parameters page render:**

Add setting listener (in the settings initialization block):
```javascript
// Load "Show advanced columns" toggle state from localStorage
const parametersAdvancedColumnsEnabled = localStorage.getItem("parametersAdvancedColumnsEnabled") === "1";
```

Find the Parameters page render function (likely around `loadParametersPage` or similar). Extend it to:
1. Add a toggle checkbox: "Show advanced columns"
2. When toggled, set localStorage and re-render
3. Conditionally show/hide new columns based on the toggle

Example column headers to conditionally add:
```html
<!-- Advanced columns (behind toggle) -->
<th data-advanced="true">QAC (W)</th>
<th data-advanced="true">Zpos (kΩ)</th>
<th data-advanced="true">Zneg (kΩ)</th>
<th data-advanced="true">TempINT (°C)</th>
<th data-advanced="true">Vpv+ (V)</th>
<th data-advanced="true">Vpv− (V)</th>
<th data-advanced="true">Nominal (W)</th>
<th data-advanced="true">TTC (s)</th>
<th data-advanced="true">Power Reduction</th>
<th data-advanced="true">Alarms Inst.</th>
<th data-advanced="true">Alarms Maint.</th>
<!-- AAP0016 (separate sub-toggle if installed) -->
<th data-advanced="true" data-aap0016="true">Analog 1</th>
<th data-advanced="true" data-aap0016="true">Analog 2</th>
<th data-advanced="true" data-aap0016="true">Analog 3</th>
<th data-advanced="true" data-aap0016="true">Analog 4</th>
<th data-advanced="true" data-aap0016="true">PT100-1</th>
<th data-advanced="true" data-aap0016="true">PT100-2</th>
```

Rendering logic:
```javascript
function renderParametersTable(data, showAdvanced = false) {
  const thead = document.querySelector("#parametersTable thead");
  const tbody = document.querySelector("#parametersTable tbody");
  
  // Show/hide advanced columns
  document.querySelectorAll("th[data-advanced='true']").forEach(th => {
    th.style.display = showAdvanced ? "" : "none";
  });
  document.querySelectorAll("td[data-advanced='true']").forEach(td => {
    td.style.display = showAdvanced ? "" : "none";
  });
  
  // Render rows with new column values from inverter_5min_param
  data.forEach(row => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.inverter_ip}</td>
      ...
      <td data-advanced="true">${row.qac_var_avg?.toFixed(1) || "—"}</td>
      <td data-advanced="true">${row.zpos_kohm_last || "—"}</td>
      ...
    `;
    tbody.appendChild(tr);
  });
}

// Toggle listener
document.getElementById("parametersAdvancedToggle").addEventListener("change", (e) => {
  const enabled = e.target.checked ? "1" : "0";
  localStorage.setItem("parametersAdvancedColumnsEnabled", enabled);
  loadParametersPage();  // Re-render
});
```

**public/index.html — Parameters page structure:**

Add the toggle near the top of the Parameters section:
```html
<div id="parametersSection" class="settings-section">
  <h3>Parameters</h3>
  <label>
    <input type="checkbox" id="parametersAdvancedToggle">
    Show advanced columns
  </label>
  
  <table id="parametersTable" class="parameters-table">
    <thead>
      <tr>
        <th>Inverter IP</th>
        <th>Slave</th>
        <th>Date</th>
        <th>Slot</th>
        <th>Vdc (V)</th>
        ...
        <!-- Advanced columns start here -->
        <th data-advanced="true">QAC (W)</th>
        <th data-advanced="true">Zpos (kΩ)</th>
        ...
      </tr>
    </thead>
    <tbody>
      <!-- Populated by JS -->
    </tbody>
  </table>
</div>
```

---

### §3.7 Settings keys (3 new)

Add to the `settings` table (already exists in db.js) via migrations or seeding:

| Key | Type | Default | Description |
|---|---|---|---|
| `slowPollIntervalS` | INTEGER | `30` | Slow-poll cadence in seconds (0 = disabled, 5–300 allowed) |
| `parametersAdvancedColumnsEnabled` | INTEGER | `0` | Show advanced columns in Parameters page (1 = yes, 0 = no) |
| `aap0016InstalledInverters` | TEXT | `""` | Comma-separated list of inverter IPs where AAP0016 is installed (e.g. "192.168.1.109,192.168.1.110") |

These can be set via the Settings UI or directly inserted into the database:
```javascript
// In server/db.js initialization or settings endpoint
const settingDefaults = {
  slowPollIntervalS: "30",
  parametersAdvancedColumnsEnabled: "0",
  aap0016InstalledInverters: "",
};
```

---

## §4 Frame field naming + units

| Frame key | Type | Unit / scale | Source register | Slice | Notes |
|---|---|---|---|---|---|
| `analog_in_1` | UInt16 | raw ADC 0–4095 | 30042 (addr 41) | β | 12-bit ADC; requires AAP0016 card (not installed today) |
| `analog_in_2` | UInt16 | raw ADC | 30043 (addr 42) | β | – |
| `analog_in_3` | UInt16 | raw ADC | 30044 (addr 43) | β | – |
| `analog_in_4` | UInt16 | raw ADC | 30045 (addr 44) | β | – |
| `pt100_1` | UInt16 | raw ADC | 30046 (addr 45) | β | PT100 temperature probe 1 |
| `pt100_2` | UInt16 | raw ADC | 30047 (addr 46) | β | PT100 temperature probe 2 |
| `alarms_inst_32` | UInt32 hi-lo | bitfield | 30065–30066 (addr 64–65) | β | Instantaneous alarms (1-second reset window) |
| `alarms_maint_32` | UInt32 hi-lo | bitfield | 30067–30068 (addr 66–67) | β | Maintained alarms (reset on grid reconnect) |
| `qac_var` | Int16 signed | W (÷10 from raw) | 30069 (addr 68) | β | Reactive power; None if offline |
| `zpos_kohm` | UInt16 | kΩ | 30070 (addr 69) | β | Solar field impedance POS-EARTH (insulation diagnostic) |
| `zneg_kohm` | UInt16 | kΩ | 30071 (addr 70) | β | Solar field impedance NEG-EARTH |
| `tempint_c` | Int16 signed | °C | 30073 (addr 72) | β | Control electronics temperature; threshold 80 °C |
| `inverter_state_raw` | UInt16 | bitfield | 30074 (addr 73) | β | Inverter state (decoded by Slice γ) |
| `vpv_n_v` | UInt16 | V | 30075 (addr 74) | β | Solar field voltage NEGATIVE-EARTH |
| `vpv_p_v` | UInt16 | V | 30076 (addr 75) | β | Solar field voltage POSITIVE-EARTH |
| `nominal_power_w` | UInt16 × 10 | W | 30077 (addr 76, in tens) | β | Rated power as reported by device (cross-check vs configured) |
| `time_to_connect_s` | UInt16 | seconds | 30109 (addr 108) | β | Time remaining to grid connection (countdown) |
| `time_to_connect_total_s` | UInt16 | seconds | 30110 (addr 109) | β | Configured island-connect total timeout |
| `power_reduction_bits` | UInt16 | bitfield | 30117 (addr 116) | β | Bit 0 = limited; bit 1 = Modbus reduction active (Slice δ) |

---

## §5 DB column additions

| Column name | Type | Default | Source frame key | Aggregation rule | Persisted row |
|---|---|---|---|---|---|
| `qac_var_avg` | REAL | NULL | `qac_var` | average | YES |
| `qac_var_min` | REAL | NULL | `qac_var` | min | YES |
| `qac_var_max` | REAL | NULL | `qac_var` | max | YES |
| `zpos_kohm_last` | INTEGER | NULL | `zpos_kohm` | last | YES |
| `zneg_kohm_last` | INTEGER | NULL | `zneg_kohm` | last | YES |
| `tempint_c_avg` | REAL | NULL | `tempint_c` | average | YES |
| `tempint_c_min` | REAL | NULL | `tempint_c` | min | YES |
| `tempint_c_max` | REAL | NULL | `tempint_c` | max | YES |
| `inverter_state_raw_last` | INTEGER | NULL | `inverter_state_raw` | last | YES |
| `vpv_n_v_avg` | REAL | NULL | `vpv_n_v` | average | YES |
| `vpv_n_v_min` | REAL | NULL | `vpv_n_v` | min | YES |
| `vpv_n_v_max` | REAL | NULL | `vpv_n_v` | max | YES |
| `vpv_p_v_avg` | REAL | NULL | `vpv_p_v` | average | YES |
| `vpv_p_v_min` | REAL | NULL | `vpv_p_v` | min | YES |
| `vpv_p_v_max` | REAL | NULL | `vpv_p_v` | max | YES |
| `nominal_power_w_last` | INTEGER | NULL | `nominal_power_w` | last | YES |
| `time_to_connect_s_last` | INTEGER | NULL | `time_to_connect_s` | last | YES |
| `power_reduction_bits_last` | INTEGER | NULL | `power_reduction_bits` | last | YES |
| `alarms_inst_32_max` | INTEGER | NULL | `alarms_inst_32` | bitwise OR | YES |
| `alarms_maint_32_max` | INTEGER | NULL | `alarms_maint_32` | bitwise OR | YES |
| `analog_in_1_avg` | REAL | NULL | `analog_in_1` | average | YES |
| `analog_in_2_avg` | REAL | NULL | `analog_in_2` | average | YES |
| `analog_in_3_avg` | REAL | NULL | `analog_in_3` | average | YES |
| `analog_in_4_avg` | REAL | NULL | `analog_in_4` | average | YES |
| `pt100_1_avg` | REAL | NULL | `pt100_1` | average | YES |
| `pt100_2_avg` | REAL | NULL | `pt100_2` | average | YES |

---

## §6 Test plan (TDD-first)

### §6.1 services/tests/test_slow_poll_decode.py (new)

**Purpose:** Unit-test the `read_slow_async()` decoder against fixture Modbus frames.

**Test structure:**
```python
import pytest
from services.inverter_engine import read_slow_async, _u32_hi_lo, _signed_int16

@pytest.mark.asyncio
async def test_read_slow_async_full_frame():
    """Decode a 53-register Modbus read (addr 64–116) with realistic values."""
    # Fixture frame: 53 regs captured from a live inverter
    regs = [
        # Alarms instant (regs 0–1 = addr 64–65)
        0x0001, 0x0002,  # UInt32 hi-lo → 0x00010002 = 65538
        # Alarms maintained (regs 2–3 = addr 66–67)
        0x0004, 0x0008,  # → 0x00040008 = 262152
        # QAC reactive (reg 4 = addr 68) — Int16 signed
        65530,  # -6 A/10 = -0.6 VAR
        # Impedances (regs 5–6)
        50, 48,  # Zpos=50 kΩ, Zneg=48 kΩ
        # (reg 7 = skip)
        0,
        # TempINT (reg 8) — Int16 signed
        65500,  # -36 °C (cold weather)
        # Estado (reg 9)
        0x0202,  # Phase=connected (bits 0–1), Stop=0, Blocked=1, GridFault=0
        # Vpv N/P (regs 10–11)
        450, 460,  # Solar field voltages
        # Nominal power (reg 12) — in tens of W
        1000,  # 1000 × 10 = 10000 W = 10 kW per unit
        # Regs 13–43: skip (stop-reason history, MS mirrors, 1000V counter)
        *([0] * 31),
        # Time-to-connect (regs 44–45 = addr 108–109)
        45, 60,  # 45 s remaining, 60 s total timeout
        # Regs 46–51: skip
        *([0] * 6),
        # Power-reduction status (reg 52 = addr 116)
        0x0003,  # Bit 0 = limited (1), Bit 1 = Modbus reduction active (1)
    ]
    
    # Mock client that returns the fixture regs
    class MockClient:
        pass
    
    client = MockClient()
    # (Would normally mock the safe_read to return the regs fixture)
    
    result = await read_slow_async(client, 1, "192.168.1.109")
    assert result is not None
    assert result["alarms_inst_32"] == 0x00010002
    assert result["alarms_maint_32"] == 0x00040008
    assert result["qac_var"] == -0.6
    assert result["zpos_kohm"] == 50
    assert result["zneg_kohm"] == 48
    assert result["tempint_c"] == -36
    assert result["inverter_state_raw"] == 0x0202
    assert result["vpv_n_v"] == 450
    assert result["vpv_p_v"] == 460
    assert result["nominal_power_w"] == 10000
    assert result["time_to_connect_s"] == 45
    assert result["time_to_connect_total_s"] == 60
    assert result["power_reduction_bits"] == 0x0003

@pytest.mark.asyncio
async def test_read_slow_async_offline_inverter():
    """Frame with zeros (inverter offline/sleeping)."""
    regs = [0] * 53
    # ... assert all fields are None or 0 as appropriate ...

@pytest.mark.asyncio
async def test_read_slow_async_truncated_frame():
    """Frame shorter than expected (firmware variant)."""
    regs = [0] * 40  # Missing last 13 regs
    # ... assert safe defaults (0 or None) for missing fields ...
```

**Test assertions:**
- Full frame decodes correctly
- Signed Int16 casts work (negative QAC, negative TempINT)
- UInt32 hi-lo reconstruction works
- Offline/zero handling
- Truncated frame handling (safe defaults)

---

### §6.2 server/tests/parseRowSlowFields.test.js (new)

**Purpose:** Unit-test the extended `parseRow()` with slow-field keys.

```javascript
const { parseRow } = require("../../server/poller");

describe("parseRow — Slice β slow fields", () => {
  it("should pass through slow-field keys when present", () => {
    const row = {
      inverter: 1, unit: 2,
      vdc: 600, idc: 50, pac: 10000,
      alarm: 0, on_off: 1,
      ts: Date.now(),
      // Slow fields
      qac_var: -100,
      zpos_kohm: 50,
      zneg_kohm: 48,
      tempint_c: 35,
      inverter_state_raw: 0x0202,
      vpv_n_v: 450,
      vpv_p_v: 460,
      nominal_power_w: 10000,
      power_reduction_bits: 0x0001,
    };
    
    const result = parseRow(row);
    
    expect(result.qac_var).toBe(-100);
    expect(result.zpos_kohm).toBe(50);
    expect(result.tempint_c).toBe(35);
    expect(result.inverter_state_raw).toBe(0x0202);
    expect(result.power_reduction_bits).toBe(0x0001);
  });

  it("should default slow fields to null when absent", () => {
    const row = {
      inverter: 1, unit: 2,
      vdc: 600, idc: 50, pac: 10000,
      alarm: 0, on_off: 1,
      ts: Date.now(),
      // No slow fields
    };
    
    const result = parseRow(row);
    
    expect(result.qac_var).toBeNull();
    expect(result.zpos_kohm).toBe(0);  // UInt16 defaults to 0
    expect(result.inverter_state_raw).toBe(0);
  });

  it("should clamp out-of-range slow fields", () => {
    const row = {
      inverter: 1, unit: 2,
      vdc: 600, idc: 50, pac: 10000,
      ts: Date.now(),
      qac_var: -100,
      zpos_kohm: 200000,  // Unrealistic, should clamp or be flagged
      tempint_c: 200,     // > 150 °C industrial envelope
    };
    
    const result = parseRow(row);
    
    // qac_var: pass through (diagnostics — no clamp)
    expect(result.qac_var).toBe(-100);
    // zpos_kohm: pass through, let aggregator reject
    expect(result.zpos_kohm).toBe(200000);
    // tempint_c: pass through, aggregator applies range gate
    expect(result.tempint_c).toBe(200);
  });

  it("should handle AAP0016 analog fields", () => {
    const row = {
      inverter: 1, unit: 2,
      vdc: 600, idc: 50, pac: 10000,
      ts: Date.now(),
      analog_in_1: 1234,
      analog_in_2: 2345,
      pt100_1: 3456,
    };
    
    const result = parseRow(row);
    
    expect(result.analog_in_1).toBe(1234);
    expect(result.analog_in_2).toBe(2345);
    expect(result.pt100_1).toBe(3456);
    expect(result.pt100_2).toBeNull();  // Not present
  });
});
```

---

### §6.3 Extend server/tests/dailyAggregatorCore.test.js

**Add test cases for slow-field aggregation:**
```javascript
describe("dailyAggregator — slow fields (Slice β)", () => {
  it("should average qac_var into the 5-min bucket", () => {
    const samples = [
      { qac_var: -100, /* other fields */ },
      { qac_var: -110, /* other fields */ },
      { qac_var: null, /* offline */ },
    ];
    
    // Ingest samples
    samples.forEach(s => ingestLiveSample(s));
    
    // Flush slot
    const flushed = getCurrentBucket();
    expect(flushed.qac_var_avg).toBe(-105);  // (-100 + -110) / 2
  });

  it("should track min/max tempint_c", () => {
    const samples = [
      { tempint_c: 30 },
      { tempint_c: 45 },
      { tempint_c: 35 },
    ];
    samples.forEach(s => ingestLiveSample(s));
    
    const flushed = getCurrentBucket();
    expect(flushed.tempint_c_min).toBe(30);
    expect(flushed.tempint_c_max).toBe(45);
    expect(flushed.tempint_c_avg).toBe(~36.67);
  });

  it("should bitwise-OR alarm windows", () => {
    const samples = [
      { alarms_inst_32: 0x0001 },
      { alarms_inst_32: 0x0002 },
      { alarms_inst_32: 0x0004 },
    ];
    samples.forEach(s => ingestLiveSample(s));
    
    const flushed = getCurrentBucket();
    expect(flushed.alarms_inst_32_max).toBe(0x0007);  // 0x0001 | 0x0002 | 0x0004
  });

  it("should keep last snapshot of non-averaged fields", () => {
    const samples = [
      { zpos_kohm: 50, inverter_state_raw: 0x0202 },
      { zpos_kohm: 51, inverter_state_raw: 0x0201 },
    ];
    samples.forEach(s => ingestLiveSample(s));
    
    const flushed = getCurrentBucket();
    expect(flushed.zpos_kohm_last).toBe(51);  // Last reading
    expect(flushed.inverter_state_raw_last).toBe(0x0201);
  });
});
```

---

### §6.4 server/tests/dbSlowFieldsMigration.test.js (new)

**Purpose:** Verify that the ALTER TABLE statements run idempotently without errors.

```javascript
const Database = require("better-sqlite3");
const { initDb } = require("../../server/db");

describe("DB migration — Slice β slow fields", () => {
  let db;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("should add slow-field columns to inverter_5min_param", () => {
    // Initialize the DB with the latest schema
    initDb(db);

    // Check that all new columns exist
    const columns = db.pragma("table_info(inverter_5min_param)").map(c => c.name);
    
    expect(columns).toContain("qac_var_avg");
    expect(columns).toContain("zpos_kohm_last");
    expect(columns).toContain("tempint_c_avg");
    expect(columns).toContain("inverter_state_raw_last");
    expect(columns).toContain("alarms_inst_32_max");
  });

  it("should allow old rows (no slow columns) to persist unchanged", () => {
    initDb(db);

    // Insert a row using only the old schema (before Slice β)
    const insert = db.prepare(`
      INSERT INTO inverter_5min_param
      (inverter_ip, slave, date_local, slot_index, ts_ms, vdc_v, idc_a, pac_w,
       inv_alarms, track_alarms, sample_count, is_complete, in_solar_window, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "192.168.1.109", 1, "2026-05-10", 100, Date.now(),
      600, 50, 10000,
      0, 0, 10, 1, 1, Date.now()
    );

    // Retrieve it; should have NULL for new columns
    const row = db.prepare(
      `SELECT qac_var_avg, zpos_kohm_last FROM inverter_5min_param WHERE slot_index = 100`
    ).get();

    expect(row.qac_var_avg).toBeNull();
    expect(row.zpos_kohm_last).toBeNull();
  });

  it("should allow new rows with slow fields", () => {
    initDb(db);

    const insert = db.prepare(`
      INSERT INTO inverter_5min_param
      (inverter_ip, slave, date_local, slot_index, ts_ms, vdc_v, idc_a, pac_w,
       qac_var_avg, zpos_kohm_last, tempint_c_avg, inverter_state_raw_last,
       inv_alarms, track_alarms, sample_count, is_complete, in_solar_window, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "192.168.1.109", 1, "2026-05-10", 101, Date.now(),
      600, 50, 10000,
      -100, 50, 35, 0x0202,
      0, 0, 10, 1, 1, Date.now()
    );

    const row = db.prepare(
      `SELECT qac_var_avg, zpos_kohm_last, tempint_c_avg FROM inverter_5min_param WHERE slot_index = 101`
    ).get();

    expect(row.qac_var_avg).toBe(-100);
    expect(row.zpos_kohm_last).toBe(50);
    expect(row.tempint_c_avg).toBe(35);
  });
});
```

---

### §6.5 public/js/app.js — Parameters page UI test

**Purpose:** Verify toggle and remote-mode proxy behavior.

```javascript
describe("Parameters page — advanced columns toggle (Slice β)", () => {
  it("should load toggle state from localStorage", () => {
    localStorage.setItem("parametersAdvancedColumnsEnabled", "1");
    // ... load parameters page ...
    expect(document.getElementById("parametersAdvancedToggle").checked).toBe(true);
  });

  it("should show/hide advanced columns when toggled", () => {
    const toggle = document.getElementById("parametersAdvancedToggle");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    
    const advCols = document.querySelectorAll("th[data-advanced='true']");
    advCols.forEach(col => {
      expect(col.style.display).toBe("none");
    });
    
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    
    advCols.forEach(col => {
      expect(col.style.display).not.toBe("none");
    });
  });

  it("should persist toggle state to localStorage", () => {
    const toggle = document.getElementById("parametersAdvancedToggle");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    
    expect(localStorage.getItem("parametersAdvancedColumnsEnabled")).toBe("1");
    
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    
    expect(localStorage.getItem("parametersAdvancedColumnsEnabled")).toBe("0");
  });
});
```

---

## §7 Backward-compatibility checklist

- [ ] Old frames (no slow keys) parse correctly with null/0 defaults in parseRow
- [ ] Old DB rows (pre-Slice β) remain queryable; new columns nullable
- [ ] New columns added via ALTER TABLE IF NOT EXISTS (idempotent, safe to re-run)
- [ ] Existing `/api/params/*` GET unchanged; new columns automatically included
- [ ] Remote mode: `if (isRemoteMode()) return proxyToRemote(...)` path works for new endpoints (if any)
- [ ] Parameters page toggle defaults OFF → existing users see no UI change
- [ ] AAP0016 columns hidden behind toggle + per-inverter setting (default off)
- [ ] Slow-poll defaults to 30 s; can be disabled by setting to 0
- [ ] Legacy tests pass: `dailyAggregatorCore.test.js`, `energySummaryScaleCore.test.js`, `hwCounterDeltaCore.test.js`, `recoverySeedClamp.test.js`

---

## §8 Smoke sequence

```bash
# 1. Run Python slow-poll decoder tests
pytest services/tests/test_slow_poll_decode.py -v

# 2. Run Node poller tests
npm test -- server/tests/parseRowSlowFields.test.js

# 3. Run aggregator tests
npm test -- server/tests/dailyAggregatorCore.test.js

# 4. Run DB migration test
npm test -- server/tests/dbSlowFieldsMigration.test.js

# 5. Run existing regression tests (smoke gate)
pytest services/tests/test_read_fast_async.py -v
npm test -- server/tests/alarmReferenceShape.test.js
npm test -- server/tests/energySummaryScaleCore.test.js
npm test -- server/tests/hwCounterDeltaCore.test.js

# 6. Node-ABI smoke test (full suite)
npm test

# 7. Restore Electron ABI after Node-ABI run (CRITICAL)
npm run rebuild:native:electron

# 8. (Optional) Start Electron and manually check Parameters page
npm start
```

---

## §9 Rollback

**If slow-poll needs to be disabled after deployment:**
1. Set `slowPollIntervalS` to `0` in settings (via UI or DB)
   - Slow-poll coroutine sleeps indefinitely; no reads issued
   - Existing slow fields in DB remain NULL (harmless)
   - No data loss

**If entire Slice β needs to be reverted:**
1. `git revert <commit>`
2. DB columns remain (harmless; just return NULL on old rows)
3. If full cleanup needed: `ALTER TABLE inverter_5min_param DROP COLUMN ...` (destructive, not recommended)

**To restore Electron ABI if accidentally left in Node mode:**
```bash
npm run rebuild:native:electron
```

---

## §10 Conflict avoidance with dirty curtailment work

**CRITICAL:** Do NOT touch any of the following (they belong to the in-flight curtailment work in [plans/2026-05-04-curtailment-control.md](plans/2026-05-04-curtailment-control.md)):

- Function/variable names containing `apc`, `plantCap`, `curtailment`, `ramp`, `activePowerp`, `pctSetpoint`
- DB table `inverter_curtailment_state` (already exists; Slice β does not extend it)
- DB table `inverter_curtailment_ramp_log` (Slice δ will extend it for APC verification, not β)
- UI sections for "Active Power Control" or "Plant Cap"
- Settings keys `plantCapApcEnabled`, `plantCapRampRate`, `curtailmentControlAuth`
- Files: `server/plantCapController.js`, `server/curtailmentController.js` (if they exist)

**Slice β is BACKEND-ONLY and DOES NOT TOUCH UI for curtailment.** Parameters page is a separate UI surface where Slice β's new diagnostic columns live.

---

## §11 HANDOFF: planner → tdd-guide

### Context
Slice β adds slow-poll diagnostic registers (addr 64–116, 53 regs) running every 30 s, plus AAP0016 analog inputs (addr 41–46) in fast-poll. New fields include reactive power (QAC), impedances (Zpos/Zneg), control-electronics temperature (TempINT), inverter state (Estado raw), power-reduction status bits, and alarm windows (instantaneous + maintained).

**Foundation:** Slice α's `_signed_int16` helpers are in place and re-used for QAC and TempINT.

### Files to modify
1. **[services/inverter_engine.py](services/inverter_engine.py)** — widen fast-poll from 72→78 regs, add `read_slow_async()`, launch `slow_poll_inverter()` coroutine
2. **[server/poller.js](server/poller.js)** — extend `parseRow()` to accept & forward 13 new slow-field keys + 6 AAP0016 keys
3. **[server/db.js](server/db.js)** — ALTER TABLE ADD COLUMN for ~28 new columns (qac/tempint/vpv/zpos/zneg/nominal/ttc/prBits/alarms/analog)
4. **[server/dailyAggregator.js](server/dailyAggregator.js)** — extend `_RANGES`, `_newBucket()`, `_accum()`, and INSERT statement to aggregate slow fields into 5-min rows
5. **[public/js/app.js](public/js/app.js)** + **[public/index.html](public/index.html)** — add Parameters page columns + "Show advanced columns" toggle

### Tests-first approach
1. Write `services/tests/test_slow_poll_decode.py` — fixture-driven slow-poll decoder tests
2. Write `server/tests/parseRowSlowFields.test.js` — parseRow passthrough + defaults
3. Extend `server/tests/dailyAggregatorCore.test.js` — aggregation of new fields
4. Write `server/tests/dbSlowFieldsMigration.test.js` — ALTER TABLE idempotence
5. Verify all 4 fail (RED) before implementing the changes
6. Implement changes per §3 above
7. All tests GREEN
8. Run full smoke suite

### Open questions / recommendations
- **Min/max tracking:** Bucket struct requires separate `minQac`, `maxQac` fields during accum, then persisted to DB. Consider whether to store all three (avg/min/max) or just avg for some fields (to reduce column count).
- **AAP0016 per-inverter gating:** The `aap0016InstalledInverters` setting is a CSV list. Consider a UI field in Settings → Inverter Config where operator checks boxes per inverter instead of typing a list.
- **Nominal power mismatch audit:** Per plan §7, log an audit entry if `nominal_power_w_last ≠ configured_ratedKw * unitCount`. Implement in a post-flush audit hook.
- **TempINT threshold alerting:** 80 °C threshold mentioned in PDF. Consider adding a WS event when TempINT enters amber (60–80 °C) or red (≥80 °C) band, visible in a new status chip.
- **Slow-poll latency tradeoff:** Default 30 s is a compromise. Operator might want 15 s for more responsive diagnostics. Consider offering a UI dropdown (5s, 15s, 30s, 60s) instead of a numeric field.

### Acceptance criteria
- [ ] β-1: Slow-poll task running every 30 s (or configured cadence), reads regs 64–116, populates new frame fields
- [ ] β-2: `inverter_5min_param` has new nullable columns (qac_var, tempint_c, inverter_state_raw, etc.)
- [ ] β-3: Parameters page renders all new columns under "Show advanced columns" toggle (default OFF)
- [ ] β-4: Reg 30077 mismatch with configured rated-kW emits an `audit_log` row (action = `nominal_power_mismatch`)
- [ ] β-5: AAP0016 columns only appear if `aap0016InstalledInverters` setting includes the inverter IP
- [ ] β-6: All new tests (§6 above) pass; existing smoke tests (dailyAggregator, energySummary, hwCounterDelta, recoverySeedClamp, alarmReferenceShape) pass
- [ ] β-7: Electron ABI restored (`npm run rebuild:native:electron`) after final Node-ABI run

---

## Summary for orchestrator

Slice β expands inverter visibility with 30-second slow-poll diagnostics (reactive power, impedances, control-electronics temperature, inverter state bits, power-reduction status, alarm windows) + fast-poll widening for AAP0016 weather sensors. **Additive only**: 28 new DB columns (NULL defaults), new Modbus regs 64–116 + 41–46, 4 new test files. Parameters page toggle hides advanced columns by default. Backward-compat verified via 5 new test modules + existing smoke gate. Handoff includes concrete line ranges, code snippets, and TDD-first test structure. Ready for tdd-guide implementation.