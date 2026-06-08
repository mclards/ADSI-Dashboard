# Reference / Baseline Setpoint UI — Deferred Work

**Date:** 2026-05-12
**Status:** Documented today, UI deferred — implement when operator prioritises
**Owner:** Engr. M.
**Cross-refs:**
- [docs/Inverter-Modbus-Reference.md §2.1](../../docs/Inverter-Modbus-Reference.md) — runtime vs persistent reference layers (added today)
- [audits/2026-05-12/ppc-capabilities-implementation.md](ppc-capabilities-implementation.md) — Phase 1–4 main audit
- [plans/2026-05-12-ppc-capabilities-implementation.md](../../plans/2026-05-12-ppc-capabilities-implementation.md)

---

## §1 Context

While discussing the 2-week single-inverter soak gate for Slice ζ writes on 2026-05-12, operator pointed out that the inverter already has **documented reference/baseline setpoint storage** (holding regs 41006–41008 = L1 runtime; ISM `*.INGECONsettings` = L2 persistent firmware config). With L1 round-trip already wired through `gridControlVerifier`, the operator can confirm "I requested X, the inverter stored X" within ~10 s of every write.

This makes single-write verification a solved problem. The remaining residual risk that the soak addresses is **operational** (thermal drift under continuous reactive load, IGBT cycle wear, substation harmonic profile changes at scale) — none of which are visible in single-write verification.

---

## §2 What's already done (no follow-up needed)

- ✅ L1 storage is documented in `Inverter-Modbus-Reference.md §2.1` (added today).
- ✅ `read_grid_control_state` reads 41006-41010 in one FC 0x03 transaction.
- ✅ `gridControlVerifier` round-trips every cmd-1/9/11 write against L1 and records the result in `grid_control_verify_log`.
- ✅ Read-back panel surfaces the L1 state when the operator clicks "Read state".
- ✅ Read-back panel shows "Last verify" status (OK / MISMATCH / PENDING / TIMEOUT) inline.

---

## §3 Deferred — UI niceties

These were proposed in the same conversation; deferred for future operator-driven prioritisation. Estimated effort: each item is ½ – 1 day.

### 3.1 Persistent "Last reference setpoint" chip

**Idea:** show the latest 41006 / 41007 / 41008 values as small chips at the top of the Grid Code panel so the baseline is one glance away, without requiring the operator to click "Read state" first.

**Implementation sketch:**
- Poll `/api/grid-control/state/:ip/:slave` every ~10 s while the Grid Code tab is visible (same pause-on-hidden pattern as Grid Monitor).
- Render three chips next to the existing read-only badge:
  - `APC ref: 75.0 %`
  - `PF ref: 1.000 (raw 0)`
  - `Q ref: 0.00 kVAr (raw 0)`
- Chips colour amber when the value drifts from the "expected default" (PF=1, Q=0, APC=100%).

**Why deferred:** the Read-back panel already shows this on demand; chip is convenience, not safety.

### 3.2 Side-by-side "requested vs reference" diff after every write

**Idea:** when the verifier returns, show a small overlay near the Set PF / Set kVAr buttons with the requested raw vs observed raw side-by-side for ~5 s.

**Implementation sketch:**
- WS handler for `grid_control:verify` is already there (Phase 3, Round 2 Gap 4 fix).
- Add a small fade-in toast next to the action buttons rendering `req=10780 obs=10780 ✓` or `req=10780 obs=8200 ✗`.

**Why deferred:** the Read-back panel auto-refreshes on `grid_control:verify` already (Phase 3, Round 2 Gap 4) — the verify line shows status. A near-button diff is a polish item.

### 3.3 ISM `*.INGECONsettings` baseline comparator (much larger)

**Idea:** allow operator to upload an ISM-exported `*.INGECONsettings` file; dashboard reads the same 177 UInt16 holding-register snapshot from the live inverter (using FC 0x03 over a wider address window) and surfaces a diff so the operator can spot drift from commissioned baseline.

**Implementation sketch:**
- Python: new `read_full_holding_snapshot(ip, slave)` that pulls regs 0..176 in chunks.
- Node: new `/api/grid-control/baseline-diff` endpoint that takes an uploaded HEXSETTINGS blob and computes per-register delta.
- UI: new "Baseline Audit" sub-tab inside Plant Controller → Grid Code with a side-by-side diff table.
- Cryptography: ISM XML carries SHA-512 + RSA signatures — we should verify those before trusting the uploaded file as ground truth.

**Why deferred:** non-trivial (signature verification, full-register-map mapping for human-readable diffs, ISM-style register decoding). This is a v2.12+ feature, not Slice ζ scope. ISM is still the authoritative tool for L2 audit; the dashboard would just give an in-app convenience view.

---

## §4 What is NOT deferred

The operational risk that motivates the 2-week soak (thermal, wear, harmonic) is unchanged by these UI items. If the operator decides the protocol-level verification is enough and wants to shorten or remove the soak gate, that's a separate decision tracked in the banner copy at [public/js/app.js:10580](../../public/js/app.js#L10580) — not blocked by this deferred work.

---

## §5 When to revisit

- When operator schedules the Slice ζ hardware soak start → §3.1 (chip) becomes worthwhile so the soak operator has continuous visibility without clicking.
- When an inverter shows unexplained drift → §3.3 (ISM comparator) becomes worthwhile to rule out L2 corruption vs L1 transient.
- §3.2 is pure polish; only build if operator explicitly requests.

