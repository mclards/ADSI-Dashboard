# PPC Capabilities Implementation — Audit Trail

**Date:** 2026-05-12
**Status:** Complete — Phases 1–4 landed on `main` working tree; user has not yet committed
**Operator:** Engr. M. (Clariden Montaño REE)
**Plan:** [plans/2026-05-12-ppc-capabilities-implementation.md](../../plans/2026-05-12-ppc-capabilities-implementation.md)

---

## §1 Scope Recap

User authorisation on 2026-05-12: "proceed, implement those gracefully and comprehensively precise" — referring to PPC-class capabilities raised earlier in the conversation (automatic voltage regulation, active/reactive power control, power curtailment, ramp-rate control, frequency droop, data logging, utility comms).

Implementation phases all landed behind feature flags, all OFF by default:

| Phase | Status | Files |
|---|---|---|
| 1 — Grid-Code Visibility | ✅ Always-on (read-only telemetry) | `server/gridCodeMonitor.js`, `server/poller.js`, `server/index.js`, `public/js/app.js`, `public/css/style.css` |
| 2 — APC Ramp-Rate Limiter | ✅ Opt-in via `apcRampRateEnabled = "1"` | `server/apcRampLimiter.js`, `server/index.js` |
| 3 — Slice ζ Hardening | ✅ Critical-block lock + read-back verifier; writes still gated by `gridControlEnabled` | `server/gridControlVerifier.js`, `server/index.js`, `server/db.js` |
| 4 — Compliance Test Wiring | ✅ Run-start critical-block lock for T3/T5 | `server/index.js` |

---

## §2 Files Touched

**New:**
- `server/gridCodeMonitor.js` — pure ring buffer + droop-slope math (262 lines)
- `server/apcRampLimiter.js` — pure ramp pacer (118 lines)
- `server/gridControlVerifier.js` — closed-loop verifier (180 lines)
- `server/tests/gridCodeMonitorCore.test.js` — 17 tests, all green
- `server/tests/apcRampLimiterCore.test.js` — 11 tests, all green
- `server/tests/gridControlVerifierCore.test.js` — 11 tests, all green
- `plans/2026-05-12-ppc-capabilities-implementation.md` — implementing plan

**Edited:**
- `server/db.js` — added `grid_control_verify_log` table + DAO (CREATE + 4 helpers, exported)
- `server/poller.js` — push every parsed frame into `gridCodeMonitor` (try/catch isolated; cannot break polling)
- `server/index.js` — wired both new modules, added `GET /api/grid-code/live`, integrated ramp limiter into setpoint-apply, added critical-block lock + verifier scheduling to all three `/api/grid-control/*` writes, added compliance run-start critical-block lock
- `public/js/app.js` — Grid Monitor sub-section with 4 Chart.js charts inside the existing Grid Code tab; `startGridMonitor`/`stopGridMonitor` wired into `switchPlantCapTab`
- `public/css/style.css` — added `cmp-badge-blue`, `cmp-badge-grey`, `cmp-chart-card`, `cmp-chart-title`, `cmp-chart-hint` styles

---

## §3 Test Results

```text
gridCodeMonitorCore.test.js     17/17 ✓
apcRampLimiterCore.test.js      11/11 ✓
gridControlVerifierCore.test.js 11/11 ✓
```

Pure-JS tests (no `better-sqlite3` dependency) so they run unchanged against the current Electron-ABI build. Per `feedback_native_rebuild.md`, the repo was intentionally NOT rebuilt to Node ABI; DB-dependent regressions are scoped to the formal `npm run smoke` run.

Existing regression tests touched indirectly:
- `criticalAlarmPatternsCore.test.js` — pass (no surface contact)
- `criticalPatternEnforcerCore.test.js` — pass (no surface contact)
- `parseRowSlowFields.test.js` — environmental ABI mismatch (pre-existing; not introduced by this branch)

Syntax verified on every edited JS file via `node --check`.

---

## §4 Behaviour Summary

### Phase 1 — Grid Code Visibility
- `gridCodeMonitor` is a singleton (`require("./gridCodeMonitor").sharedMonitor`).
- Every parsed poller frame pushes one sample (no Modbus reads added).
- 5-min × 5-sec rolling ring per (ip, slave); auto-evicts older samples.
- `GET /api/grid-code/live` returns:
  - `{ mode: "plant", plant: {...aggregate}, nodes: [...rings] }` by default
  - `{ mode: "node", inverter, slave, ip, node: {...} }` when `?inverter=N&slave=N`
- WS: not added in this phase — UI polls the HTTP endpoint every 5 s while the Grid Code tab is visible (paused otherwise).
- Four Chart.js charts: P-vs-f scatter, Q-vs-V scatter, dP/dt time-series, PF time-series. NGCP envelope overlays (59.7–60.3 Hz continuous, 58.2–61.8 Hz withstand) baked into chart axes.

### Phase 2 — APC Ramp Limiter
- Disabled by default (`apcRampRateEnabled = "0"`).
- When enabled, every `/api/plant-cap/setpoint/apply` `set` opcode is wrapped in `planApcRamp`. Worst-case mover (largest |current − target|) drives the plan.
- Step interval 15 s, default 10 %/min (`apcRampRatePctPerMin`).
- Each paced step is scheduled via `setTimeout` (un-refed), logged to `audit_log` as `apc.ramp_paced` / `apc.ramp_step`, and broadcast over WS as `apc:throttled`.
- Slice δ APC verifier delayed by `total_duration_ms` when throttled (otherwise it would flag every paced ramp as a mismatch).
- Disabling the flag is instant: subsequent writes ship the operator's literal target_pct.

### Phase 3 — Slice ζ Hardening
- Critical-block lock now applies to `POST /api/grid-control/phi` and `/reactive`. Mirrors the gate at `server/index.js:5984-6011`. Returns HTTP 423 with `{ pattern_hex, pattern_key }` so the UI can surface a specific message.
- `POST /api/grid-control/disable` (cmd 11) is **intentionally exempt** — releasing reactive control during a block is the SAFE direction.
- Inverter number is resolved from `ip` via `_inverterFromIp(ip)`. Unknown IP → block check skipped (defensive: block requires identity).
- Verifier (`gridControlVerifier.js`) schedules a delayed `read_grid_control_state` 10 s after every successful write. Classifies `ok` / `mismatch` / `no_response` / `timeout`. New `grid_control_verify_log` table mirrors `apc_verify_log` shape. Broadcasts `grid_control:verify` over WS.

### Phase 4 — Compliance Test Wiring
- `POST /api/compliance/run/start` enumerates each target inverter, queries `getActiveCriticalBlock(inv)`, and refuses (HTTP 423) when any target is locked.
- T2 (frequency observation, read-only) is exempted from the gate — no control happens, no risk.
- T3 (Q-V sweep) and T5 (APC sweep) both honour the gate. T5 inherits Phase 2 ramp pacing automatically because it calls through `applySetpoint`.

---

## §5 New Settings (operator-visible)

| Key | Default | Range | Effect |
|---|---|---|---|
| `apcRampRateEnabled` | `"0"` | `"0"` / `"1"` | Master switch for Phase 2 ramp pacer |
| `apcRampRatePctPerMin` | `"10"` | 1–100 | Max abs change per minute when Phase 2 enabled |

`gridControlEnabled` (Phase 3 enablement) was pre-existing and untouched.

---

## §6 Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Ramp limiter delays operator's intended setpoint | Medium | Limiter disabled by default; total horizon capped at 60 steps (15 min @ 15 s) so a flag-stuck-on scenario is bounded |
| Critical-block lock blocks legitimate manual recovery | Medium | `disable` (cmd 11 reactive release) is exempt — operator can always restore safe defaults |
| New ring buffer leaks memory on long uptime | Low | Ring is bounded (≤ 60 samples × ≤ 200 nodes ≈ 12 000 sample objects ≈ < 1 MB) |
| `/api/grid-code/live` hammered by UI | Low | UI polls only while tab visible; offsetParent gate keeps it free when hidden |
| Verifier schedules pile up under high write rate | Low | `pendingByKey` collapses to newest write per node, mirroring `apcVerify` behaviour |
| Better-sqlite3 ABI mismatch breaks DB-dependent test | None | Pure-JS tests for new modules; DB regressions covered by separate `npm run smoke` |

---

## §7 What's Still NOT Implemented (per plan §6)

These remain out of scope and would need separate workstreams:

- DNP3 / IEC 61850 utility northbound (requires PPC appliance / months of protocol work)
- Closed-loop AVR with PCC voltage feedback (requires substation-meter input — see `project_substation_meter_input.md`)
- Hardware-fast P-f droop (firmware territory; NGCP Country Code 42 already governs)

The dashboard is now **PPC-adjacent** but is still **not a certified PPC**.

---

## §8 Operator Roll-out Posture

1. **Phase 1 ships always-on.** Operator can open the Grid Code tab today and see live P-f / Q-V / dP/dt charts without any flag toggle.
2. **Phase 2 (`apcRampRateEnabled = "1"`)** is the low-risk next step. Recommended only after operator has used Phase 1 visibility long enough to know what current dP/dt traces look like at this plant.
3. **Phase 3 hardening is automatic.** `gridControlEnabled` flag remains the master gate for Slice ζ writes — hardening only changes behaviour AFTER the operator flips that flag (which is still pending 2-week soak per `inverter-engineer` sign-off).
4. **Phase 4 critical-block lock on T3/T5** auto-enforces once a recurring critical pattern fires — no operator action required.

---

## §9 Cross-references

- Plan: [plans/2026-05-12-ppc-capabilities-implementation.md](../../plans/2026-05-12-ppc-capabilities-implementation.md)
- Earlier critical-block design: [audits/2026-05-11/igbt-contactor-hardening.md](../2026-05-11/igbt-contactor-hardening.md) §8.4–§8.5
- NGCP compliance research: [audits/2026-05-10/ngcp-grid-compliance-research.md](../2026-05-10/ngcp-grid-compliance-research.md)
- Modbus reference: [docs/Inverter-Modbus-Reference.md](../../docs/Inverter-Modbus-Reference.md)
- Slice ζ original plan: [plans/2026-05-10-modbus-registers-official-revamp.md](../../plans/2026-05-10-modbus-registers-official-revamp.md) §4 Slice ζ
- Memory: `feedback_no_auto_commit.md` — operator reviews each commit by hand; this branch left uncommitted on purpose.

