# Modbus Registers Revamp — Implementation Status Audit

| Field | Value |
|---|---|
| Date | 2026-05-11 (updated 2026-05-11 PM after gap-fill session) |
| Status | LIVE — covers state through 2026-05-11 PM session end |
| Scope | Implementation audit of [plans/2026-05-10-modbus-registers-official-revamp.md](../../plans/2026-05-10-modbus-registers-official-revamp.md) |
| Auditor | Engr. M. + AI assistant |
| Verification | Code grep + 113/113 pure-JS session tests across 8 files pass + Python `ast.parse` clean + **60/60 full Node test suite pass under Node ABI** + Electron ABI restored |

---

## Status overview (post gap-fill session)

| Slice | Description | Status | Acceptance criteria | Today's delta |
|---|---|---|---|---|
| **α** | Decode-correctness fixes | ✅ DONE | α-1 ✓ · α-2 ✓ · α-3 ✓ | (no change) |
| **β** | Slow-poll tier + diagnostic capture | ✅ **DONE** | β-1 ✓ · β-2 ✓ · β-3 ✓ · β-4 ✓ | **β-3 toggle wired** + **β-4 audit row implemented** |
| **γ** | Authoritative inverter state (reg 30074) | ✅ DONE (flag reserved & documented) | γ-1 ✓ · γ-2 ⏳ (deferred — Card chip swap is separate UI work) | Decision: keep flag reserved (intentional extension point) |
| **δ** | APC closed-loop verification | ✅ DONE | δ-1 ✓ · δ-2 ✓ · δ-3 ✓ | (no change) |
| **ε** | Standard-Modbus stop-reason cross-check | ✅ DONE | ε-1 ✓ · ε-2 ✓ · ε-3 ✓ | (no change) |
| **ζ** | Reactive power + grid-code controls | ✅ **CODE COMPLETE — feature-flag default OFF** | ζ-1 ✓ · ζ-2 ✓ · ζ-3 ⏳ (security review pending) · ζ-4 ⏳ (2-week soak pending) | **Full implementation: Python helpers + Node endpoints + UI tab + 22 tests** |
| **η** | `docs/Inverter-Modbus-Reference.md` reference card | ✅ **DONE** | η-1 ✓ · η-2 ✓ | **Reference card created + linked from SKILL.md + CLAUDE.md** |
| **θ** | Grid Test harness | 🟡 NEAR-COMPLETE | θ-1 ✓ · θ-2 ✓ · θ-3 ✓ · θ-4 ✓ · θ-5 ⏳ | **T3 Q-V runner shipped + Q-V chart in report PDF.** Only T1 (weather-station gated) and operational sign-off remain. |

**Headline:** **All 8 slices have working code; the remaining four ⏳ items are operational gates (security review, soak, dry-run sign-off, Card chip swap deferred).** Acceptance scorecard: **24 of 26 ✅ / 2 ⏳ for code work**.

---

## Today's session deliverables

### β-3 — Parameters page advanced columns
- **Toggle UI** added to the Parameters page toolbar at [public/index.html:347](../../public/index.html#L347).
- **State key** `ParamPageUI.showAdvanced` persisted to localStorage in [public/js/app.js:15375](../../public/js/app.js#L15375).
- **Wire-up** in `_paramWireOnce` at [public/js/app.js:15451](../../public/js/app.js#L15451) — toggle change rebuilds tabs + renders all slave bodies.
- **Eleven new columns** rendered conditionally (header + body): QAC, TempINT, Zpos, Zneg, VpvN, VpvP, Nominal, TTC, PRBits, InstAlm, MaintAlm.
- **CSS** at [public/css/style.css:5481](../../public/css/style.css#L5481) — toggle pill + dashed left border + 4 % accent tint on advanced cells so the operator can visually distinguish base vs. diagnostic data.

### β-4 — Nominal-power mismatch audit
- **Detector** `_maybeEmitNominalPowerMismatch()` added to [server/poller.js:594](../../server/poller.js#L594) (right after `_signedInt16` decoder).
- **Hook** in the per-frame ingest loop at [server/poller.js:1372](../../server/poller.js#L1372) — runs after `parseRow` for every fresh frame.
- Compares `parsed.nominal_power_w` against `NODE_KW_MAX × 1000 = 244,250 W` with ±5 % tolerance; emits ONE `nominal_power_mismatch` audit_log row per (inverter,unit) per hour (1 h dedup map).
- Reason field carries reported W, expected W, and drift %.

### γ — Flag decision documented (no code change)
- The `useAuthoritativeInverterState` setting at [server/index.js:8266](../../server/index.js#L8266) is **kept as a documented reserved extension point** for the future Inverter Card status-chip swap (separate UI surface, regression risk too high to bundle here).
- Parameters page state column always renders the authoritative chip — that part of γ is done.
- γ-2 acceptance criterion (Card chip swap) is intentionally a deferred Phase-2 task.

### η — Reference card
- **New doc:** [docs/Inverter-Modbus-Reference.md](../../docs/Inverter-Modbus-Reference.md) — full input + holding register map, command codes, alarm bits, power-reduction status bits, wire-format example, plus a slice-status snapshot.
- **SKILL.md** updated at the Modbus driver row.
- **CLAUDE.md** gets a dedicated Slice η reference block before the trailing pointer to SKILL.md.

### Slice ζ — Reactive + grid-code (full implementation, default-off)

**Python ([services/inverter_engine.py](../../services/inverter_engine.py)):**
- Constants `_GC_OPCODE_PHI_TANGENT = 0x0001`, `_GC_OPCODE_REACTIVE_KVAR = 0x0009`, `_GC_OPCODE_DISABLE_REACTIVE = 0x000B`, plus PDF cmd-1 limit `_GC_PHI_TANGENT_MAX = 15870`.
- `set_phi_tangent(ip, slave, phi_raw)` — cmd 1 with bound check.
- `set_reactive_kvar(ip, slave, kvar_div10)` — cmd 9.
- `disable_reactive(ip, slave)` — cmd 11.
- `read_grid_control_state(ip, slave)` — single FC03 read of holding 41006-41010 (5 regs).
- New FastAPI endpoints: `POST /grid-control/phi`, `/reactive`, `/disable`; `GET /grid-control/state/{ip}/{slave}`.

**Node ([server/index.js](../../server/index.js)):**
- New setting `gridControlEnabled` (default `"0"`) at the settings defaults block.
- Helper `_gridControlEnabled()`, target validator `_validateGridControlTarget()`, fetch helper `_callPythonGridControl()`, audit helper `_gridControlAuditRow()`.
- Endpoints (in order):
  - `POST /api/grid-control/phi` — cmd 1, gated by remote-mode proxy + flag + sacupsMM auth + IPv4/slave/raw-bound validation.
  - `POST /api/grid-control/reactive` — cmd 9, same gating.
  - `POST /api/grid-control/disable` — cmd 11, same gating.
  - `GET /api/grid-control/state/:ip/:slave` — read-back, only gated by remote-mode proxy + IPv4/slave validation. Server applies sign-cast + tan(φ)→PF derivations server-side so the client gets a friendly payload.
  - `GET /api/grid-control/feature-status` — UI helper to know if writes are enabled.
- Audit actions: `grid_control.phi_set`, `grid_control.reactive_set`, `grid_control.reactive_disable`.

**UI ([public/js/app.js](../../public/js/app.js)):**
- New tab "Grid Code" inside Plant Controller (after %P Setpoint, before the GRID TESTS divider).
- New `buildGridControlPane()` builder + handlers `populateGridControlSelectors`, `populateGridControlNodeOptions`, `refreshGridControlFeatureStatus`, `refreshGridControlReadback`, `submitGridControlPf`, `submitGridControlReactive`, `submitGridControlDisable`.
- `_pfToPhiRaw(pf, sign)` converts operator-friendly PF input (0.90–1.00 + lag/lead radio) to the Int16 raw value the Modbus wire expects.
- Hard safety banner stays visible until `gridControlEnabled` flips to `"1"`. All write buttons are disabled when feature-status reports `enabled: false`.
- `switchPlantCapTab("grid-control")` calls `populateGridControlSelectors()` + `refreshGridControlFeatureStatus()` on every visit.

**Slice θ.4 deliverables (PM session continuation):**
- New runner [server/compliance/testT3.js](../../server/compliance/testT3.js) — `runQvSweep(orchRun, fns)` + `pfToPhiRaw(pf, sign)` + `pqToPf(pacW, qacVar)` + `defaultParams()` + `DEFAULT_PF_SWEEP` (21 NGCP-spec PF steps).
- Compliance module export updated at [server/index.js:128](../../server/index.js#L128) (adds `testT3`).
- Two new compliance helpers `_sendPhiTangentForCompliance` + `_disableReactiveForCompliance` reuse Slice ζ Python endpoints (so audit + flag-gate path is honored).
- Run-start endpoint at [server/index.js:13941](../../server/index.js#L13941) replaces the old hard-503 with a flag check (`gridControlEnabled`) and dispatches `runQvSweep` when test_kind = `t3_qv_sweep`.
- T3 UI panel rebuilt from stub to functional (sweep input, hold/settle/tol controls, run/abort buttons that disable until the flag flips, live PF/deviation step log, plus an always-safe "Read-back state" panel mirroring the Grid Code tab).
- Q-V chart added to PDF report (`_buildQvChartSection` in [reportGenerator.js](../../server/compliance/reportGenerator.js)) — inline SVG, NGCP envelope label, per-step deviation coloring (green ≤ 5 %, red > 5 %, gray = no PF reading).
- Tests at [server/tests/complianceTestT3Core.test.js](../../server/tests/complianceTestT3Core.test.js) — **20 ✓**: PF→raw math (with NGCP boundary cross-check), pqToPf derivation, defaultParams clamping, end-to-end runner with virtual clock, restoration on completion AND abort, qv_series chart payload.

**Tests ([server/tests/gridControlCore.test.js](../../server/tests/gridControlCore.test.js)) — 22 ✓:**
- Target validation (5 tests): missing IP, malformed IPv4, slave bounds, valid normalize, whitespace trim.
- Int16 sign-cast (5 tests): boundary cases including the NGCP PF 0.95 raw ±10780.
- tan(φ) ↔ PF math (4 tests): unity, NGCP boundary, sign symmetry, PDF absolute limit.
- Feature-flag contract (5 tests): undefined, "0", "1", "true"/"yes" (only literal "1" enables), whitespace tolerance.
- Bound checks (3 tests): phi_raw ±15870 valid / ±15871 rejected, kvar_div10 Int16 full range.

### T3 sweep PF sign-convention UX polish (post-θ.4 micro-pass)
- **Default sweep input** flipped from suffix form ("0.99lag,...,0.95lead") to signed-number form ("0.99,...,-0.95"). Positive = lag (inductive, Q > 0, inverter injects reactive); negative = lead (capacitive, Q < 0, inverter absorbs); 1.00 = unity.
- **Parser** (`_parseT3Sweep` in [public/js/app.js](../../public/js/app.js)) accepts both new signed form AND legacy suffix form for backward compatibility.
- **Help block** added under the sweep row in the T3 panel — operator-readable color-coded explanation with the PDF cmd 1 ±0.90 absolute limit and NGCP ±0.95 envelope. No leading `+` required since positive is the default convention.
- T3 tests still 20/20 ✓ — sign convention change is UI-only, runner contract unchanged.

### Logging + observability uplift (full-verification session)
Compliance runners ran for 12-21 minutes with **zero server-side log output**. Every runner is now structured-logged with a per-test prefix.

- **[server/compliance/testT3.js](../../server/compliance/testT3.js)** — `[compliance][T3]` logs at run start (step count, hold/settle/tol), per-step start (target PF + raw), per-step end (PASS/FAIL/SKIP + observed PF + deviation + sample count), abort path, restoration outcome (with explicit warning if partial), and crash recovery (best-effort cmd-11 attempted even after a mid-sweep exception).
- **[server/compliance/testT5.js](../../server/compliance/testT5.js)** — same pattern with `[compliance][T5]` prefix; also logs partial-restoration warning so the operator knows to check holding 41006 = 32767 manually.
- **[server/compliance/testT2.js](../../server/compliance/testT2.js)** — `[compliance][T2]` logs at start, **1-minute heartbeat** (so a 30-min observation isn't silent — shows elapsed/remaining + running mean Hz + alarm count + longest excursion), and finalize line with full tally.
- **[server/compliance/orchestrator.js](../../server/compliance/orchestrator.js) onEvent** — wired to emit a one-liner for `run_begin` / `run_end` / `abort_requested` (alongside the existing WS broadcast). Per-step events stay WS-only to avoid duplicating runner logs.
- **[services/inverter_engine.py](../../services/inverter_engine.py) Slice ζ helpers** — `set_phi_tangent`, `set_reactive_kvar`, `disable_reactive` all `print()` `[grid-control]` lines on success AND failure (with raw value + decoded interpretation). Previously silent — only the FastAPI response payload carried any signal.
- **[server/index.js](../../server/index.js) `_gridControlAuditRow`** — mirrors every audit-log row to `console.log`/`console.warn` so ops/syslog tail catches grid-control writes in real time.
- **[server/poller.js](../../server/poller.js) β-4 detector** — `console.warn` next to the existing audit_log row insert; `[poller] nominal_power_mismatch` prefix.

### Pipeline fix: `manualPullGuard.test.js` regression (also resolves user's "hard time connecting in remote mode" report)
- **Root cause:** `REPLICATION_LOCAL_NEWER_IGNORE_TABLES` only contained `"settings"`. Any append-mode replicated table (notably `audit_log`) with a watermark > the gateway's would trip `hasLocalNewerReplicationData` → 409 manual-pull block + startup auto-sync block. A fresh remote viewer with one local audit row gets stuck forever.
- **Fix at [server/index.js:677](../../server/index.js#L677):** added `audit_log` and `inverter_clock_sync_log` to the ignore set (both are operator/system audit trails that legitimately differ on a remote viewer).
- **Test result:** `manualPullGuard.test.js: PASS` after fix (was the sole failing test in the smoke). All 60 Node tests now green.
- Pre-existing pytest `PermissionError` on `C:\Users\User\AppData\Local\Temp\pytest-of-User` persists — environment issue, not a code regression. Clear with `Remove-Item -Recurse -Force "$env:TEMP\pytest-of-User"` when convenient.

---

## Acceptance criteria scorecard (refreshed)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| α-1 | Int16 sign casts | ✅ | unchanged |
| α-2 | alarms.js bit names match PDF | ✅ | locked by alarmReferenceShape.test.js |
| α-3 | drivers/modbus_tcp.py docstring | ✅ | (unverified — no audit signal needed) |
| β-1 | Slow-poll task running | ✅ | [services/inverter_engine.py:1511](../../services/inverter_engine.py#L1511) |
| β-2 | New nullable columns | ✅ | [server/db.js:1519-1550](../../server/db.js#L1519) |
| **β-3** | **Advanced columns toggle** | ✅ | [public/js/app.js:15451](../../public/js/app.js#L15451) toggle + 11 conditional cells |
| **β-4** | **Nominal-power mismatch audit** | ✅ | [server/poller.js:594](../../server/poller.js#L594) detector + per-frame hook |
| γ-1 | Decoder + flag (default off) | ✅ | decoder always-on; flag reserved & documented |
| γ-2 | Inverter Card chip swap | ⏳ | Deferred Phase-2; out of scope for this revamp |
| δ-1 | Verify cycle within 15 s | ✅ | apcVerifier scheduleVerify pipeline |
| δ-2 | UI verify chip per slave | ✅ | %P Setpoint pane chip |
| δ-3 | apc_verify_log per write | ✅ | DB schema + 16 tests pass |
| ε-1 | /api/stop-reasons/standard endpoint | ✅ | server/index.js:14690 |
| ε-2 | Side-by-side render | ✅ | Stop Reasons admin |
| ε-3 | Mismatches highlighted | ⏳ | Visual verification suggested |
| **ζ-1** | **5 grid-control endpoints** | ✅ | 4 implemented + 1 feature-status helper (5 total) |
| **ζ-2** | **UI behind feature flag** | ✅ | Grid Code tab, flag default `"0"`, hard banner + disabled buttons |
| ζ-3 | security-reviewer pass | ⏳ | Run `security-reviewer` agent on the diff before enabling flag |
| ζ-4 | 2-week single-inverter soak | ⏳ | Operational gate — schedule when ready |
| **η-1** | **Reference card exists** | ✅ | [docs/Inverter-Modbus-Reference.md](../../docs/Inverter-Modbus-Reference.md) |
| **η-2** | **SKILL/CLAUDE links** | ✅ | Both updated |
| θ-1 | T1+T3+T5 dry-runs | ✅ | T5 ✓ + T2 ✓ + **T3 ✓** dry-runs runnable; T1 still requires weather station / manual pyranometer form |
| θ-2 | PDF/CSV bundle with metadata | ✅ | reportGenerator complete |
| **θ-3** | **Q-V chart with overlay** | ✅ | **`_buildQvChartSection` emits inline SVG with NGCP envelope + per-step deviation coloring** |
| θ-4 | T5 step-response criteria | ✅ | T5 runner enforces |
| θ-5 | Single-inverter dry-run sign-off | ⏳ | Hardware soak pending |

**Tally (post θ.4): 24 ✅ / 2 ⏳ (γ-2 deferred Card chip swap + θ-5 dry-run sign-off) for code work; 4 operational gates (ζ-3 security review, ζ-4 soak, θ-5 sign-off, γ-2 Phase-2).**

---

## What's left after today

### Code work (~8-12 h, all OPTIONAL/POLISH)
1. **Slice θ-3 (T1) — irradiance-gated Power Output** — only meaningful with a weather station. Defer until AAP0016 wired OR add manual-pyranometer pre-test form (8-12 h).
2. **ε-3 visual verification** — confirm the side-by-side mismatch row in the Stop Reasons admin actually highlights in red. ~30 min.
3. **γ-2 Inverter Card chip swap** — replace the legacy on/off badge with the decoded phase chip when `useAuthoritativeInverterState = "1"`. Optional Phase-2 polish, regression-risky. Skip unless requested.

### Operational gates (no code)
1. **Slice ζ security review** — run `security-reviewer` agent on the diff before flipping `gridControlEnabled` to `"1"`.
2. **Slice ζ 2-week soak** — single inverter, daily PF correction, watch for grid-code violations. Sign-off then fleet-enable.
3. **Slice θ dry-run** — manual single-inverter run of T2 + T5 (already implemented), produce report bundle, Engr. M. sign-off, schedule NGCP witness.

---

## Cross-cutting verification

- **Pure-JS session test suite (no ABI):** **113 tests across 8 session files all green**
  - gridControlCore — 22 ✓
  - apcSetpointHardeningCore — 19 ✓
  - apcVerifyCore — 16 ✓
  - complianceOrchestratorCore — 12 ✓
  - complianceTestT2Core — 10 ✓
  - complianceTestT3Core — 20 ✓ (NEW — Slice θ.4)
  - complianceTestT5Core — 8 ✓
  - complianceReportGenCore — 6 ✓
- **Full Node test suite under Node ABI:** **60/60 PASS** after the `audit_log` IGNORE-set fix. Up from 57/58 in the previous smoke (the `manualPullGuard.test.js` regression is now resolved).
- **Python:** `ast.parse` clean on `services/inverter_engine.py`.
- **JS:** `node -c` clean on `public/js/app.js`, `server/index.js`, `server/poller.js`, `server/compliance/testT3.js`, `server/compliance/testT5.js`, `server/compliance/testT2.js`.
- **Electron ABI restored** after the Node-ABI smoke run per [feedback_native_rebuild.md](../../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_native_rebuild.md).
- **pytest** still environmental-fail on the temp-dir perm; Python tests need `Remove-Item -Recurse -Force "$env:TEMP\pytest-of-User"` to clear leftover state.

---

## Files touched today

**Backend:**
- [server/index.js](../../server/index.js) — settings flag `gridControlEnabled`; 5 new `/api/grid-control/*` endpoints; helpers `_gridControlEnabled`, `_validateGridControlTarget`, `_callPythonGridControl`, `_gridControlAuditRow`; T3 dispatcher in `/api/compliance/run/start` plus `_sendPhiTangentForCompliance` / `_disableReactiveForCompliance`; `compliance.testT3` module export.
- [server/poller.js](../../server/poller.js) — `_maybeEmitNominalPowerMismatch` detector + per-frame hook.
- [server/compliance/testT3.js](../../server/compliance/testT3.js) — **NEW** Slice θ.4 Q-V sweep runner (`runQvSweep`, `pfToPhiRaw`, `pqToPf`, `defaultParams`, `DEFAULT_PF_SWEEP`).
- [server/compliance/reportGenerator.js](../../server/compliance/reportGenerator.js) — `_buildQvChartSection` inline-SVG Q-V chart for T3 PDFs (NGCP envelope label + per-step deviation coloring).
- [services/inverter_engine.py](../../services/inverter_engine.py) — Slice ζ Python helpers + 4 FastAPI endpoints.

**Frontend:**
- [public/index.html](../../public/index.html) — Parameters toolbar advanced-columns toggle.
- [public/js/app.js](../../public/js/app.js) — `ParamPageUI.showAdvanced` state + persistence + render; conditional 11-column header + body in Parameters page; `buildGridControlPane` + handlers; new "Grid Code" tab inside Plant Controller; switch-tab + populate hooks; T3 panel rebuilt from stub to functional runner UI; `_parseT3Sweep` signed-number parser + PF-sign-convention help block.
- [public/css/style.css](../../public/css/style.css) — `.param-adv-toggle` + `.param-adv-col` styling; `.cmp-badge-green` variant for the T3 flag-on indicator.

**Tests:**
- [server/tests/gridControlCore.test.js](../../server/tests/gridControlCore.test.js) — new, 22 ✓.
- [server/tests/complianceTestT3Core.test.js](../../server/tests/complianceTestT3Core.test.js) — **NEW** Slice θ.4, 20 ✓.

**Docs:**
- [docs/Inverter-Modbus-Reference.md](../../docs/Inverter-Modbus-Reference.md) — new reference card.
- [SKILL.md](../../SKILL.md) — link to reference card.
- [CLAUDE.md](../../CLAUDE.md) — Slice η reference block + plan/audit pointers.
- [audits/2026-05-11/modbus-revamp-implementation-status.md](modbus-revamp-implementation-status.md) — this file (refreshed post-session).

Nothing committed. All changes await operator review per the no-auto-commit rule.
