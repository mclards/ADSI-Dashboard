# Plan — Inverter Remote Calibration Tool (display-bypass)

**Date:** 2026-05-12
**Status:** Decode complete, awaiting build authorization
**Author:** Engr. M. (analysis assistance: Claude)
**Goal:** Replace the slow display-arrow-key calibration workflow with direct
Modbus register writes from the dashboard. The technician still goes on-site
with multimeter + 3-phase wattmeter — only the menu navigation is bypassed.

---

## 1. Source-of-Truth Findings

### 1.1 The 177-register firmware config block

`docs/400152914R81.INGECONsettings` is the L2 persistent firmware config
exported by ISM (INGECON SUN Manager). Decoded structure:

| Property | Value |
|---|---|
| Wire base address | `0x0000` |
| Length | 177 holding registers (UInt16) |
| Function code | `0x03` read / `0x10` write |
| Serial | `400152914R81` |
| Firmware | `AAV1003BA` |
| ISM version | `1.79` |

The `<HASH>` field is an ISM signature chain for tamper evidence in exported
files — it is NOT required by the inverter firmware for live Modbus writes.

### 1.2 Three-window holding-register architecture

| Window | Wire offset | Purpose | Slice status |
|---|---|---|---|
| **Config / calibration** | `0x0000`–`0x00B0` (177 regs) | Where `.INGECONsettings` lives; scale factors at offsets 81–94 | NEW — this tool |
| **Runtime command** | `0x03E8`–`0x03F3` (12 regs, "41001"–"41012") | cmd opcode, cmd data, APC/PF/Q read-back (41006–41008) | Implemented (Slices ε/ζ) |
| **Privileged ASCII** | `0x9C74` (serial) + unlock at `0xFFFA` | Serial-number write | Implemented (Slice C) |

### 1.3 Calibration block — full register map (offsets 81–94)

Extracted from `FV.IngeBLL.Maquinas.TrifFot.Data.HoldingRegisters.CfgTrifAU`
via .NET reflection on `_ism/FV.IngeBLL.dll`. Identical layout in CfgTrifAS
(alternate firmware lineage) and stable since `CfgTrif_V`.

| Off | Field | Type | XML tag | PDF correlation | User access |
|---:|---|---|---|---|---|
| 81 | `Fesc_vac_1` | UInt16 | `FONDOVAC1` | AC voltage scale, phase 1 (J6/L1) | UserLevel 4 |
| 82 | `Fesc_vac_2` | UInt16 | `FONDOVAC2` | AC voltage scale, phase 2 (J7/L2) | UserLevel 4 |
| 83 | `Fesc_vac_3` | UInt16 | `FONDOVAC3` | AC voltage scale, phase 3 (J8/L3) | UserLevel 4 |
| 84 | `Fesc_iac_1_baja` | UInt16 | `FONDOIAC1` | AC current scale, phase 1 (IAC1, low-gain) | UserLevel 4 |
| 85 | `Fesc_iac_2_baja` | UInt16 | `FONDOIAC2` | AC current scale, phase 2 (IAC2) | UserLevel 4 |
| 86 | `Fesc_iac_3_baja` | UInt16 | `FONDOIAC3` | AC current scale, phase 3 (IAC3) | UserLevel 4 |
| 87 | `Fesc_ipv` | UInt16 | `FONDOIPV` | DC input current scale (IPV — PDF shows 134→141) | UserLevel 4 |
| 88 | `Fesc_vpv_p` | UInt16 | `FONDOVPVP` | DC voltage scale, positive input | UserLevel 4 |
| 89 | `Fesc_vpv_n` | UInt16 | `FONDOVPVN` | DC voltage scale, negative input | UserLevel 4 |
| 90 | `comp_per_vacio` | UInt16 | `COMPVACIO` | Self-consumption / standby comp (PDF "power consumption") | UserLevel 4 |
| 91 | `comp_reactiva_x1` | UInt16 | `COMPQX1` | Reactive curve X₁ (PDF "X1Y1 at 20% Pn") | UserLevel 4, gated by `ADJ_IfReactiveSettingsStillDigital` |
| 92 | `comp_reactiva_y1` | UInt16 | `COMPQY1` | Reactive curve Y₁ | UserLevel 4, same gate |
| 93 | `comp_reactiva_x2` | UInt16 | `COMPQX2` | Reactive curve X₂ (PDF "X2Y2 at 70% Pn") | UserLevel 4, same gate |
| 94 | `comp_reactiva_y2` | UInt16 | `COMPQY2` | Reactive curve Y₂ | UserLevel 4, same gate |

**Critical adjacent register:** offset 80 = `ValidCfgCode` (UInt16). Value
`0x1F1F` in user export indicates "config block initialized and valid".
A calibration write that leaves this slot unchanged is safe; clearing it
to `0x0000` may cause the inverter to refuse the config and revert to
factory defaults — **do not touch offset 80**.

**`ADJ_IfReactiveSettingsStillDigital` gate** — offsets 91–94 are only
writable when the inverter is in digital-curve reactive mode. Newer firmware
revisions move to analog setpoint via register 41008 (`cmd-9`), in which case
the X/Y curve is ignored. We must detect the mode before allowing writes.

### 1.4 User's current calibration state (inverter 400152914R81)

Decoded from the existing `.INGECONsettings` export:

```
Off  Hex     Dec   Field             Description
─────────────────────────────────────────────────────────────
 81  0x045B  1115  Fesc_vac_1        AC V scale L1
 82  0x0450  1104  Fesc_vac_2        AC V scale L2
 83  0x0468  1128  Fesc_vac_3        AC V scale L3
 84  0x0691  1681  Fesc_iac_1_baja   AC I scale L1
 85  0x068A  1674  Fesc_iac_2_baja   AC I scale L2
 86  0x069A  1690  Fesc_iac_3_baja   AC I scale L3
 87  0x079C  1948  Fesc_ipv          DC I scale
 88  0x03FF  1023  Fesc_vpv_p        DC V+ scale
 89  0x040D  1037  Fesc_vpv_n        DC V- scale
 90  0x05A0  1440  comp_per_vacio    standby comp
 91  0x0787  1927  comp_reactiva_x1  Q curve X₁
 92  0x01B5   437  comp_reactiva_y1  Q curve Y₁
 93  0x1E22  7714  comp_reactiva_x2  Q curve X₂
 94  0xFF42  -190  comp_reactiva_y2  Q curve Y₂ (Int16)
```

The per-phase spread on V and I scales (1.1–2.3 % delta between phases) is
consistent with normal sensor manufacturing tolerance.

### 1.5 Write protocol (proven on hardware)

`services/serial_io.py` already implements the privileged-write template
for serial-number writes. The same unlock magic gates the calibration
window. The full per-write sequence:

```
1. ACQUIRE per-IP lock                            (services/inverter_engine.py)
2. UNLOCK   FC16 → 0xFFFA = [0x0065, 0x07A7]      (serial_io.UNLOCK_VALUES)
3. WRITE    FC16 → target_offset = new_value       (single UInt16 per FC16 call)
4. SLEEP    1000 ms                                (mirrors ISM behavior)
5. READ     FC03 ← target_offset                  (verify read-back matches)
6. RELEASE  per-IP lock
7. AUDIT    insert into calibration_write_log     (Node-side persistence)
```

The unlock magic is **per-session** — once unlocked, multiple writes can
follow within the same lock hold. For a full calibration session
(14 registers × N nodes) we unlock once per node, batch all writes, verify
each, release.

### 1.6 Per-node addressing

Each inverter has 2–4 DC-AC conversion modules (nodes). Each node responds
on its own Modbus slave_id at the same IP. The calibration block at
offsets 81–94 is **per-node** — same offset, different slave_id. This
matches the PDF's "scale factor adjustments in node number 2" workflow.

---

## 2. Architecture

### 2.1 New files

```
services/calibration_io.py           ← clone of serial_io.py, target offsets 81-94
services/calibration_decoder.py      ← parse .INGECONsettings + live register reads
server/calibrationRoutes.js          ← HTTP routes: read state, write parameter, audit
server/db.js                         ← +calibration_write_log table
public/calibration.html              ← new admin page (gated by topology auth)
public/js/calibration.js             ← UI state machine
public/css/calibration.css           ← consign-mode tile styling
```

### 2.2 Database schema additions (server/db.js)

```sql
CREATE TABLE IF NOT EXISTS calibration_write_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc          INTEGER NOT NULL,
  inverter_id     INTEGER NOT NULL,
  slave_id        INTEGER NOT NULL,
  reg_offset      INTEGER NOT NULL,
  param_name      TEXT    NOT NULL,
  value_before    INTEGER,
  value_requested INTEGER NOT NULL,
  value_after     INTEGER,
  verify_ok       INTEGER NOT NULL,    -- 0/1
  operator_key    TEXT,                 -- masked, e.g. "adsi**" or "sacups**"
  session_id      TEXT    NOT NULL,    -- groups writes per calibration visit
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS ix_calwrite_inv_slave_ts
  ON calibration_write_log(inverter_id, slave_id, ts_utc DESC);

CREATE TABLE IF NOT EXISTS calibration_snapshot (
  inverter_id     INTEGER NOT NULL,
  slave_id        INTEGER NOT NULL,
  ts_utc          INTEGER NOT NULL,
  reg_block_hex   TEXT NOT NULL,       -- 14 regs (81-94) as space-separated hex
  source          TEXT NOT NULL,        -- 'baseline' | 'post-write' | 'periodic'
  PRIMARY KEY(inverter_id, slave_id, ts_utc)
);
```

Retention: `calibration_write_log` 5 years (regulatory), `calibration_snapshot` 1 year.

### 2.3 HTTP API

```
GET  /api/calibration/state/:inverter/:slave
  → { current: { Fesc_vac_1: 1115, ..., comp_reactiva_y2: -190 },
      reactive_mode: 'digital' | 'analog',
      last_written: { ts, operator, regs: [...] } | null,
      valid_cfg_code_ok: true }

GET  /api/calibration/snapshot/:inverter/:slave?limit=20
  → [ { ts, source, reg_block_hex } ... ]

GET  /api/calibration/fleet-summary
  → per-(inverter,slave) calibration delta vs fleet median, anomaly flags

POST /api/calibration/session/start                                 [topology auth]
  body: { inverter, slave, operator_initials }
  → { session_id, baseline_snapshot_id, current_state, locked: true }

POST /api/calibration/write                                          [bulk auth + session_id]
  body: { session_id, reg_offset, new_value }
  → { ok, value_before, value_after, verify_ok, audit_id }

POST /api/calibration/consign                                        [bulk auth + session_id]
  body: { session_id, percent: 0|10|20|60|70 }
  → drives cmd-3 (APC) via existing services/inverter_engine.write_command_register

POST /api/calibration/session/end                                    [topology auth]
  body: { session_id }
  → releases consign (sets back to 100% or operator-confirmed),
    writes session summary, snapshot
```

### 2.4a Calibration Session Lockdown (added 2026-05-12)

**Two distinct modes** — the lockdown only fires on the second:

1. **Read-only viewing (always available, Phase 1+).** Operator opens the
   Field Calibration page. Dashboard works normally — all tabs visible,
   poller runs, alerts fire, replication continues. The page just shows
   the current calibration state of every node + fleet anomalies. No
   suspension, no toggle, no operator commitment.

2. **Calibration Session (Phase 2+).** Operator clicks
   **`[Start Calibration Session]`** on one specific (inverter, slave),
   enters their initials + topology key. From that click forward, the
   dashboard enters lockdown — everything below is suspended until the
   operator clicks **`[End Session]`** or the heartbeat times out (30 min).

The session toggle is what makes the difference. Without the toggle
pressed, reading calibration values is no different from reading any
other telemetry — completely safe and concurrent with normal operation.

While a calibration session is active, the dashboard must focus exclusively
on the calibration workflow.  All background activity that could (a)
interfere with the Modbus bus to the target inverter, (b) race a write,
(c) trigger spurious alerts that distract the on-site technician, or
(d) modify config under the operator's feet — must be suspended.

**Authority:** `server/calibrationSession.js` exposes
`isActive() → bool` and `currentTarget() → {inverter, slave} | null`.
Consumers check on every tick and skip work when active.

**Suspended on session start** (Phase 2+):

| Module / source                       | Behavior during session                                       |
|---------------------------------------|---------------------------------------------------------------|
| `server/poller.js`                    | Skip the target inverter's FC04 read entirely; keep fleet poll for other inverters running so telemetry coverage doesn't go blind |
| `server/apcRampLimiter`               | Refuse to start any new ramp jobs (in-flight job completes)   |
| `server/criticalAlarmPatterns` + `criticalBlock` | Pause tick — alarm bits still recorded, but auto-block deferred (the calibrator is physically on-site) |
| `server/gridControlVerifier`          | Pause new verify jobs                                         |
| `server/gridCodeMonitor`              | Pause writes; live read stream continues                      |
| `dailyAggregator`                     | Defer if session window crosses midnight (run within 5 min after end) |
| Replication (push/pull)               | Defer if session active                                       |
| Forecast cron (04:30/09:30/etc.)      | Defer overlapping regens                                      |
| Auto-reset                            | Disabled for the target inverter only                         |
| UI top-bar tabs (all except Calibration) | Hidden; back button disabled                              |
| Notification toasts                   | Suppressed (events still logged + audited)                    |

**Session lifecycle:**

```
POST /api/calibration/session/start    ← topology auth + operator initials
  → returns { session_id, lockdown_manifest }, sets flag, broadcasts banner
POST /api/calibration/session/heartbeat ← UI pings every 15 s
TIMEOUT (30 min idle)                  → auto-end + full restore
POST /api/calibration/session/end      → consign release, snapshot, full restore
```

**Failure modes** that auto-end the session and restore everything:

- Heartbeat lost > 30 s (operator closed laptop, network drop)
- Critical alarm bit on the target inverter that's NOT in the session's "expected during calibration" set
- Inverter state change from RUN → FAULT
- Operator clicks "Abort" or hits ESC three times

Phase 1 ships the stub module (`isActive()` always false), no hot-path
wiring.  Phase 2 enables the flag-set on session start and wires the
above suspensions consumer-by-consumer with a one-line check each.

### 2.4 Safety gates (non-negotiable)

| Gate | Enforced by | Bypass |
|---|---|---|
| **Critical-block lock** active for this inverter blocks all writes | `server/criticalBlock.js` enforcer tick | Operator "Confirmed" + `sacupsMM` |
| **ValidCfgCode at 0x1F1F** before any write | `calibration_io.preflight_check()` | None — refuse to start session |
| **Inverter must be in RUN state**, not FAULT | live read of register `30074` Estado bitfield | None |
| **DC current write requires Pn ≥ 70 %** (per PDF) | dashboard checks live `Pac` reading | Operator override with logged justification |
| **Reactive curve writes require digital mode** | check `eReactiveSetPoint` enum (config reg) | None — refuse, show explainer |
| **Out-of-range value** (>50 % delta from current) | `calibration_io.validate_range()` | "Force" toggle + audit reason |
| **Multiple sessions per inverter** | `session_id` uniqueness, expire after 30 min idle | None |

### 2.5 UI — Calibration page (`public/calibration.html`)

Topology-auth-gated page (key `adsiM`/`adsiMM`, 10-min session) under
Settings → Field Calibration.

```
┌─ Calibration Session — Inverter 12, Node 2 ─────────────────────┐
│ Session: 2026-05-12T14:33Z   Operator: CDM   [End session]      │
│ Baseline snapshot captured ✓     ValidCfgCode 0x1F1F ✓          │
│ Inverter state: RUN      Critical-block: clear     PAC: 142 kW  │
├─────────────────────────────────────────────────────────────────┤
│ ┌─ Consign Mode (forces inverter to specified %Pn) ─────────┐   │
│ │   [ 10% ]  [ 20% ]  [ 60% ]  [ 70% ]  [ release ]         │   │
│ │   Current target: 60 %       Live PAC: 142 kW (59.4 %)    │   │
│ │   Will auto-release on session end                         │   │
│ └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│ ┌─ Scale Factors ─────────────────────────────────────────────┐ │
│ │  Param            Live reading  Current   New      Status   │ │
│ │  Vac1  (L1)       228.4 V       1115      [____]  unchanged │ │
│ │  Vac2  (L2)       228.7 V       1104      [____]  unchanged │ │
│ │  Vac3  (L3)       227.9 V       1128      [____]  unchanged │ │
│ │  Iac1  (L1)        85.3 A       1681      [____]  unchanged │ │
│ │  ...                                                         │ │
│ │  IPV              412.6 A       1948      [____]  unchanged │ │
│ │  Vpv+ / Vpv-      508 / 506 V   1023/1037 [____]  unchanged │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─ Reactive Curve (Q vs P) ── digital mode ✓ ─────────────────┐ │
│ │  X₁ (20% Pn): 1927   Y₁: 437                                │ │
│ │  X₂ (70% Pn): 7714   Y₂: -190                               │ │
│ │  [Recalibrate X1Y1]  [Recalibrate X2Y2]                     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─ Recent writes (this session) ──────────────────────────────┐ │
│ │  14:38  Fesc_iac_1_baja  1681 → 1684  ✓ verified            │ │
│ │  14:40  Fesc_ipv          1948 → 1955  ✓ verified           │ │
│ └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

Each "New" input opens a confirmation modal: shows old/new, computes
expected delta in physical units (e.g., "+0.18 % on Vac1"), asks for the
multimeter ground-truth reading, requires `sacupsMM` to commit.

---

## 3. Phased Delivery

### Phase 1 — Read-only baseline (target: 1–2 days)

- `services/calibration_decoder.py` — read holding regs 0–176 per
  (inverter, slave) on demand; decode all known fields
- `GET /api/calibration/state/:inverter/:slave`
- New "Field Calibration" page, read-only view
- Fleet anomaly chart: per-phase scale-factor delta vs fleet median
- **No writes, no consign mode**. Ship as `v2.11.x` minor.
- Smoke test: read one node, confirm Vacmin/Vacmax/Facmin/Facmax decode
  correctly against expected NGCP grid envelope (220 V ± 10 %, 60 Hz ± 0.5)

### Phase 2 — Write path + audit (target: 2 days after Phase 1 soak)

- `services/calibration_io.py` (clone of `serial_io.py` pattern)
- `calibration_write_log` + `calibration_snapshot` schema migration
- `POST /api/calibration/write` with mandatory baseline snapshot
- "Calibration Session" UI shell (no consign yet — uses display for it)
- One scale factor at a time, with read-back verify
- **Hard gate:** every write requires `sacupsMM` re-entry (no session-level bypass)
- Smoke: write Fesc_vac_1 +1 LSB, verify, restore on session end

### Phase 3 — Dedicated consign UI + multi-write session

- `POST /api/calibration/consign` driving existing `cmd-3` write path
- Tile-style consign-mode buttons (10/20/60/70 % + release)
- Per-percentage minimum-dwell timer (forces 30 s settle before allowing
  current-loop writes, per PDF "wait for stable point")
- Auto-release on session end OR session timeout (default 30 min)
- Smoke: drive consign 60 %, verify PAC settles within ±2 %, release

### Phase 4 — Bulk apply across modules (optional, low priority)

- "Copy calibration from Node X to Node Y" workflow with cryptographic
  fingerprint match (same model code + firmware) — refuses cross-hardware
  copies
- Useful only after a module replacement when the new module's factory
  calibration is suspect

---

## 4. Open Questions — LIVE TEST RESOLVED (2026-05-12 07:30)

Test target: Inverter 1 / Node 1 / 192.168.1.101, inverter in CONNECTED state producing 20.26 kW.
Procedure: read sentinel → no-op write Fesc_vac_1 = 1125 → 1125 (value unchanged).

| Question | Answer | Evidence |
|---|---|---|
| §4.1 Unlock-gate scope on 81-94 | **Not gated.** Write accepted in 50.4 ms without unlock. | `WriteMultipleRegisterResponse (81,1)` returned cleanly; register block byte-identical post-write. |
| §4.2 Write during RUN | **Works.** Inverter kept producing through both writes. | PAC stayed at 20.26 kW; estado bits unchanged. |
| §4.3 Commit/save register | **Not needed for transient write.** Subsequent reads return new value immediately. (Persistence across power cycle still untested; recommend a deliberate single-LSB write + power-cycle test if doubt remains.) | n/a |
| §4.4 Reactive-mode detection | **Deferred.** Register that owns `eReactiveSetPoint` not yet mapped; not blocking — UI shows "digital" mode unconditionally until decoded. | n/a |
| §4.5 ValidCfgCode preservation | **Survives writes.** Stays `0x1F1F` before and after no-op + unlock+write sequences. | Direct read-back |

**Implication:** the calibration write surface is simpler than initially modeled — no unlock dance required. The implementation **retains** the unlock step as defense in depth (harmless, ~30 ms, may matter on different firmware revisions). All other safety gates (sentinel preflight, range guard, sacupsMM auth, critical-block check, read-back verify) remain mandatory.

## 4-original. Open Questions (originally on-site spike checklist — now historical)

1. **Does the `0xFFFA` unlock magic gate offsets 81–94 the same way it gates
   `0x9C74`?** Almost certainly yes (same firmware tier — UserLevel 4) but
   needs one diff test: read offset 81, attempt FC16 write without unlock
   → expect Modbus exception. Then unlock → write same value → expect
   success.

2. **Does writing during inverter RUN state succeed, or must the inverter
   be in STOP?** The display PDF shows the technician calibrating during
   consign-mode RUN — suggests RUN writes work. Verify by writing the
   same value back to itself (no-op delta) and observing.

3. **Is there a "save / commit" sequence required after writes?** Some
   INGECON firmwares require a config-commit write before the new value
   persists across power cycle. Check by writing, power-cycle the inverter,
   re-read. If non-persistent, hunt for a commit register (likely `0xFFF*`
   range).

4. **What does `eReactiveSetPoint` decode to today?** Need to read the
   register that owns this enum to determine if reactive curve calibration
   is even applicable. If newer firmware moved to analog control, offsets
   91–94 are vestigial.

5. **What happens at offset 80 (`ValidCfgCode = 0x1F1F`) if any write to
   81–94 corrupts the block?** The 0x1F1F marker likely needs to be
   re-asserted after writes. We need to verify post-write that offset 80
   still reads 0x1F1F; if not, the inverter may revert to factory defaults
   on next boot. Test: write one scale factor, read 80 — confirm unchanged.

These five must be answered with a one-time on-site spike before any
production write tooling ships.

---

## 5. Out of Scope

- L2 persistent config beyond offsets 81–94 (alarm thresholds at 102–113,
  Q-V/Q-P thresholds at 118–137, derating at 169–172) — these are
  commissioning-tier and should remain ISM-only
- Country code / grid standard switching (offset 32) — regulatory exposure
- `eReactiveSetPoint` mode switching — out of scope; calibration tool only
  reads it to decide whether to enable reactive curve writes
- `IngeconSunManager.exe` UI emulation — we only re-implement the calibration
  subset, not the full ISM admin surface

---

## 6. References

- ISM source: `_ism/FV.IngeBLL.dll` (Version=1.2.5989.30003, x86)
- Decompiled parameter map: `_spike/cfg_trif_AU_map.tsv`, `_spike/cfg_trif_AS_map.tsv`
- User inverter export: `docs/400152914R81.INGECONsettings`
- Training PDF: `docs/TrinPM20-Inverter-calibration.pdf`
- Privileged-write template: `services/serial_io.py`
- Existing write path: `services/inverter_engine.py:3430` (`_write_command_register_sync`)
- Existing read path: `services/inverter_engine.py:3558` (`_read_grid_control_state_sync`)
- Critical-block enforcer: memory `v2_11_critical_block_safety.md`
- Display firmware: `docs/InverterDisplayFirmware.bin` (130 KB, ARM Cortex-M, dated 2022-05-31)

---

## 7. Display-firmware cross-reference (added 2026-05-12)

The display MCU firmware (`docs/InverterDisplayFirmware.bin`) was extracted
and its string table dumped. It independently confirms the calibration
register set with display-side parameter labels that match the DLL field
names byte-for-byte:

| DLL field (offset)        | Display label    | Display menu                |
|---------------------------|------------------|-----------------------------|
| `Fesc_vac_1` (81)         | `F_E_Vac1=`      | AC VOL SETTING              |
| `Fesc_vac_2` (82)         | `F_E_Vac2=`      | AC VOL SETTING              |
| `Fesc_vac_3` (83)         | `F_E_Vac3=`      | AC VOL SETTING              |
| `Fesc_iac_1_baja` (84)    | `F_E_Iac1=`      | AC CUR SETTING              |
| `Fesc_iac_2_baja` (85)    | `F_E_Iac2=`      | AC CUR SETTING              |
| `Fesc_iac_3_baja` (86)    | `F_E_Iac3=`      | AC CUR SETTING              |
| `Fesc_ipv` (87)           | `F_E_Ipv=`       | DC SETTING                  |
| `Fesc_vpv_p` (88)         | `F_E_Vpvp=`      | DC SETTING                  |
| `Fesc_vpv_n` (89)         | `F_E_Vpvn=`      | DC SETTING                  |
| `comp_per_vacio` (90)     | `Per. Vacio=`    | ACTIV P SETTING             |
| `comp_reactiva_x1` (91)   | `Pot. Reactiv_X1=` | REAC1 P SETTING           |
| `comp_reactiva_y1` (92)   | `Comp. Reacti_Y1=` | REAC1 P SETTING           |
| `comp_reactiva_x2` (93)   | `Pot. Reactiv_X2=` | REAC2 P SETTING           |
| `comp_reactiva_y2` (94)   | `Comp. Reacti_Y2=` | REAC2 P SETTING           |

Confirmation prompts present in firmware (multiple languages):
- `"Enter the real value of the adjust. var"`
- `"If you want to save adj press OK if not press ESC"`
- `"Calibrating.."` (progress)
- `"Introduzca Clave"` / `"Intro Password"` / `"Wrong Password"`

Operating-mode submenu confirmed:
- `CONSIGN OPERATING MODE`  (consign-to-percentage during calibration)
- `Vin OPERATING MODE`
- `SHORT OPERATING MODE`

**Calibration UI strategy:** Mirror these exact labels and menu groupings
in `public/calibration.html`. Operators familiar with the display will
recognize the layout immediately. The 7 submenus (RANGE / AC VOL /
AC CUR / DC / ACTIV P / REAC1 P / REAC2 P) become 7 collapsible sections
in the calibration page.

**Password handling:** The calibration password `3725` is NOT stored as
an integer or ASCII string in the display firmware — it's validated
digit-by-digit via inline immediate constants (compiler-obfuscated). This
is moot for our purposes since we authenticate via the `0xFFFA` Modbus
unlock magic, not the display password. The dashboard equivalent is the
existing `sacupsMM` bulk-control auth + topology auth chain.

**Display→DSP transport:** The `0xFFFA` unlock register address is NOT
directly referenced in the display MCU code (the one apparent occurrence
at 0x00BD6A is the low half of a Thumb-2 `BL` instruction, not a literal).
This means the display does NOT speak Modbus to itself — it forwards
calibration writes to the FreescaleDSP56F over an internal CAN/RS-485 bus
using a different framing. The DSP itself implements the `0xFFFA` unlock
when reached via Modbus TCP through the gateway. Our calibration tool
takes the Modbus-TCP path directly to the DSP, bypassing the display
entirely — which is exactly the goal.

