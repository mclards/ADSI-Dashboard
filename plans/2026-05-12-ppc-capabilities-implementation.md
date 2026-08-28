# PPC Capability Implementation — Visibility, Ramp Limiter, Reactive Hardening

**Date:** 2026-05-12
**Status:** In progress — Phases 1–4 in single branch, all features gated OFF by default
**Authorisation:** Engr. M. confirmed scope on 2026-05-12 — "implement those gracefully and comprehensively precise"
**Reference plans:**
- [plans/2026-05-10-modbus-registers-official-revamp.md](2026-05-10-modbus-registers-official-revamp.md) §4 Slice ζ / θ
- [plans/2026-05-04-curtailment-control.md](2026-05-04-curtailment-control.md)
- [audits/2026-05-10/ngcp-grid-compliance-research.md](../audits/2026-05-10/ngcp-grid-compliance-research.md)
- [docs/Inverter-Modbus-Reference.md](../docs/Inverter-Modbus-Reference.md)

---

## §1 Scope vs. PGC 2016 GCR 4.4.4 PPC Clause

The dashboard is **not** a certified PPC. A PPC sits between NGCP RTU and inverters with PCC metering and DNP3/IEC 61850 northbound — that scope stays out of this branch (see §6 Out-of-scope). This branch lifts the dashboard from "APC-only" to "PPC-adjacent" by adding closed-loop visibility, paced writes, and a hardened reactive-control path that is verifiable and safely gated.

| PPC capability | Existing | This branch | Notes |
|---|---|---|---|
| Active Power Curtailment | ✅ v2.10.x (cmd 3) | ramp-rate limiter wraps writes | Phase 2 |
| Active/Reactive Power control | partial (cmd 1/9/11 endpoints exist) | + critical-block lock + read-back verifier | Phase 3 |
| Automatic Voltage Regulation | ❌ no PCC meter | visibility only (Q-V scatter) | Phase 1 |
| Ramp-rate control | test-sweep only | continuous APC throttle | Phase 2 |
| Power-frequency droop | ❌ | visibility only (P-f scatter) | Phase 1 |
| Data logging | ✅ SQLite + Postgres | + grid-code 5-sec ring | Phase 1 |
| Utility comms (DNP3/IEC 61850) | ❌ | **OUT OF SCOPE** | §6 |
| Compliance reports | scaffold (T2/T3/T5) | T3 wired to Slice ζ, T5 paced by Phase 2 | Phase 4 |

---

## §2 Phase 1 — Grid-Code Visibility

**Goal:** Operator can see P-vs-f, Q-vs-V, dP/dt, dQ/dt at 5-sec resolution over a rolling 5-min window, with NGCP compliance bands overlaid.

**Files (new):**
- [server/gridCodeMonitor.js](../server/gridCodeMonitor.js) — pure ring buffer + droop-slope math, no I/O.

**Files (edit):**
- [server/index.js](../server/index.js) — add `GET /api/grid-code/live`, hook the existing 5-sec frame broadcast to push frames into the monitor, add WS `grid_code:tick` emission.
- [public/js/app.js](../public/js/app.js) — extend the existing Grid Code tab with a "Grid Monitor" sub-section containing four charts. Polls `/api/grid-code/live` every 5 s when the tab is visible; pauses when hidden.
- [public/index.html](../public/index.html) — no new top-level tab; add chart canvases inside `#plantCapTabPaneGridControl`.

**Charts (rolling 5-min, 5-sec resolution):**
1. **P vs f** scatter — points colored by per-inverter; overlay NGCP continuous band (59.7–60.3 Hz) + withstand band (58.2–61.8 Hz).
2. **Q vs V** scatter — points show observed PF as marker color; overlay nominal voltage ±5% band.
3. **dP/dt (kW/s) time series** — overlay configured ramp limit (Phase 2 setting `apcRampRatePctPerMin` × rated_kw / 6000 = kW/s ceiling).
4. **PF / cos(φ) time series** — overlay NGCP PF 0.95 lag/lead boundaries.

**Data source:** existing 5-sec WS frame already broadcast by the poller. We tap the same broadcast (no new Modbus reads).

**Source of truth:** `inverter_5min_param` rows (slower) and the live `frame:tick` events (faster). The monitor maintains an in-memory ring per (ip, slave) — 60 slots × 5 s = 5 min, drops oldest. No DB writes in Phase 1.

**Computed metrics (per inverter, per tick):**
- `dP_dt_w_per_s`: (pac_now − pac_prev) / (t_now − t_prev), clamped to ±200 kW/s sanity
- `dQ_dt_var_per_s`: same for QAC
- `pf_observed`: derived via `pqToPf` (existing helper) when not directly read
- `droop_slope_kw_per_hz`: linear regression over last 60 samples (only when |Δf| > 0.05 Hz)
- `droop_slope_kvar_per_v`: same for Q-vs-V

---

## §3 Phase 2 — APC Ramp-Rate Limiter

**Goal:** Every `set_active_power_pct` write the dashboard issues is paced so the absolute change |Δpct| never exceeds `apcRampRatePctPerMin` per minute, per node. T5 sweeps inherit this automatically.

**Files (new):**
- [server/apcRampLimiter.js](../server/apcRampLimiter.js) — pure pacer: takes (current_pct, requested_pct, rate_pct_per_min, now_ms, last_write_ms) → returns the *paced* setpoint to write *now* + scheduled follow-ups.

**Files (edit):**
- [server/plantCapController.js](../server/plantCapController.js) — `applySetpoint` consults the limiter when `apcRampRateEnabled === "1"`. Paced writes generate follow-up timers and broadcast `apc:throttled` over WS.
- [server/index.js](../server/index.js) — surface the setting via existing `/api/settings`; broadcast WS event.
- [public/js/app.js](../public/js/app.js) — Plant Cap setpoint card shows a chip "Throttled @ 10%/min" while a paced ramp is in flight.

**Settings:**
- `apcRampRateEnabled` (default `"0"`)
- `apcRampRatePctPerMin` (default `"10"`, range 1–100)

**Audit:** every paced step writes an `audit_log` row `action="apc.ramp_paced"`, scope=`grid-control`, reason=`"current=X.X → step=Y.Y → target=Z.Z (rate=N%/min)"`.

---

## §4 Phase 3 — Slice ζ Hardening (Critical-Block Lock + Read-Back Verifier)

**Goal:** All three grid-control endpoints (`/api/grid-control/phi`, `/reactive`, `/disable`) honour the critical-pattern auto-block. Every successful write schedules a delayed read-back to confirm the inverter accepted the setpoint.

**Files (new):**
- [server/gridControlVerifier.js](../server/gridControlVerifier.js) — mirrors `apcVerify.js`: scheduled read-back of `read_grid_control_state` 10 s after every write; classifies `ok` / `mismatch` / `no_response`; writes to a new `grid_control_verify_log` table; broadcasts `grid_control:verify`.

**Files (edit):**
- [server/index.js](../server/index.js) — three grid-control POSTs gain the `getActiveCriticalBlock(invFromIp)` gate (status 423 Locked when blocked). After Python returns ok, schedule a verify via the new verifier.
- [server/db.js](../server/db.js) — new table `grid_control_verify_log` (mirror of `apc_verify_log` schema).

**Critical-block lock:** the grid-control endpoints don't currently carry an `inverter` number — only `ip`. We resolve inverter from IP via `State.ipConfig.inverters` (server-side equivalent: `_inverterFromIp(ip)`). If lookup fails the write is *allowed* (defensive — block enforcement requires inverter identity).

**No change to default state:** writes remain OFF (`gridControlEnabled = "0"`). This is hardening, not enablement.

---

## §5 Phase 4 — Compliance-Test Wiring

**Goal:** T3 already drives Slice ζ writes (verified). T5 inherits Phase 2 ramp-rate pacing automatically because it goes through `applySetpoint`. Add explicit critical-block honor in the run-start path.

**Files (edit):**
- [server/index.js](../server/index.js) — `POST /api/compliance/run/start` consults `getActiveCriticalBlock` for each target inverter; refuses the run with status 423 if any target is locked.
- [server/compliance/testT3.js](../server/compliance/testT3.js) — no code change; relies on existing `sendPhiTangent`/`disableReactive` wiring.
- [server/compliance/testT5.js](../server/compliance/testT5.js) — no code change; ramp limiter is at the controller layer.

---

## §6 Out-of-scope (explicitly)

- **DNP3 / IEC 61850 utility northbound.** Months of work + NGCP coordination + protocol stack + cert. Recommend dedicated PPC appliance.
- **Closed-loop AVR with PCC voltage feedback.** Requires PCC metering hardware integration; defer until substation-meter input feature lands ([project_substation_meter_input.md](../C%3A/Users/User/.claude/projects/d--ADSI-Dashboard/memory/project_substation_meter_input.md)).
- **Hardware-fast P-f droop (sub-second).** Hardware-firmware territory; NGCP Country Code 42 already governs.
- **Auto-enabling grid-control writes.** `gridControlEnabled` stays `"0"`. Operator MUST sign off per inverter after soak.

---

## §7 Test Plan

- [server/tests/gridCodeMonitorCore.test.js](../server/tests/gridCodeMonitorCore.test.js) — pure ring buffer + droop-slope math, no DB.
- [server/tests/apcRampLimiterCore.test.js](../server/tests/apcRampLimiterCore.test.js) — pacer math, zero-time and partial-tick cases.
- [server/tests/gridControlVerifierCore.test.js](../server/tests/gridControlVerifierCore.test.js) — mirrors `apcVerifyCore.test.js`.
- Existing `compliance/*Core.test.js` continue green.
- Smoke: Node-ABI smoke + Electron-ABI rebuild after tests.

---

## §8 Roll-out posture

- Feature flags all default OFF.
- `apcRampRateEnabled = "1"` is a low-risk operator-controlled flip that affects only when curtailment is in use anyway.
- `gridControlEnabled = "1"` is the high-risk flip; UI banner already enforces sign-off language.
- Phase 1 visibility ships always-on (read-only telemetry).

