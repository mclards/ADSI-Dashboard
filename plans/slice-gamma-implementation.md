# Slice γ — Authoritative Inverter State Implementation Plan

| Field | Value |
|---|---|
| Date | 2026-05-10 |
| Status | DRAFT — for tdd-guide handoff |
| Parent plan | [plans/2026-05-10-modbus-registers-official-revamp.md](2026-05-10-modbus-registers-official-revamp.md) §4 Slice γ |
| Risk | MED |
| Estimate | 12-18 hours |
| Depends on | Slice β (commit `313c48f` — `inverter_state_raw` captured + aggregated to `inverter_5min_param.inverter_state_raw_last`) |

---

## §1 Reg 30074 bit layout reference

Per [docs/IngeconSunPMax-Modbus-pg07.txt](../docs/IngeconSunPMax-Modbus-pg07.txt) §2 pg 7, register 30074 is a UInt16 bitfield:

**Low byte (bits 0-7) — operating phase (mutually exclusive):**
- `0x00` Initial state
- `0x01` Initial magnetization state
- `0x02` Grid connected
- `0x03` Error state
- `0x04+` undefined → treat as `unknown`

**High byte (bits 8-15) — status flags (combinable):**
- `bit 0` (= 0x0100): Stop flag — 1 = stopped, 0 = running
- `bit 1` (= 0x0200): Blocked flag
- `bit 2` (= 0x0400): Grid fault detected

**Example decodings:**
- `0x0002` → `{phase:"connected", stop:false, blocked:false, gridFault:false}` (running normally)
- `0x0102` → `{phase:"connected", stop:true,  blocked:false, gridFault:false}` (stopped while grid present)
- `0x0402` → `{phase:"connected", stop:false, blocked:false, gridFault:true}` (grid fault during operation)
- `0x0001` → `{phase:"magnetizing", stop:false, ...}` (DC bus precharge)
- `0x0003` → `{phase:"error", ...}` (firmware error state)
- `0x0700` → `{phase:"initial", stop:true, blocked:true, gridFault:true}` (all flags + initial)

---

## §2 Concrete file changes

### §2.1 [server/poller.js](../server/poller.js) — `decodeInverterState()` helper

Insert **after** [`_signedInt16`](../server/poller.js#L589) (around line 593, before `parseRow`):

```javascript
/**
 * Decode authoritative inverter state register (reg 30074) into structured form.
 *
 * Per Ingeteam INGECON SUN Modbus RTU spec
 * (docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf §2 pg 7):
 *   Low byte (bits 0-7) — phase: 0=initial, 1=magnetizing, 2=connected, 3=error
 *   High byte bit 0 — stop (1 = stopped, 0 = running)
 *   High byte bit 1 — blocked
 *   High byte bit 2 — grid fault detected
 *
 * Returns null-safe shape; inputs that aren't finite numbers decode as `unknown`.
 *
 * Related plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice γ
 */
function decodeInverterState(raw_u16) {
  const n = Number(raw_u16);
  if (!Number.isFinite(n)) {
    return { phase: "unknown", phaseCode: -1, stop: false, blocked: false, gridFault: false, raw: null };
  }
  const u16 = n & 0xFFFF;
  const lo = u16 & 0xFF;
  const hi = (u16 >> 8) & 0xFF;
  const phaseMap = { 0: "initial", 1: "magnetizing", 2: "connected", 3: "error" };
  const phase = phaseMap[lo] || "unknown";
  const phaseCode = lo <= 3 ? lo : -1;
  return {
    phase,
    phaseCode,
    stop:      (hi & 0x01) !== 0,
    blocked:   (hi & 0x02) !== 0,
    gridFault: (hi & 0x04) !== 0,
    raw: u16,
  };
}
```

### §2.2 `parseRow()` extension — attach decoded state to frame

Inside [`parseRow`](../server/poller.js#L600), after the existing `inverter_state_raw` line (around 741):

```javascript
    inverter_state_raw:   Number.isFinite(Number(row.inverter_state_raw)) ? Number(row.inverter_state_raw) : 0,
    // v2.10.x Slice γ — decoded authoritative state (additive). Always computed
    // when a row carries inverter_state_raw; downstream consumers gate on the
    // useAuthoritativeInverterState setting before USING the decoded values.
    inverter_state:       (Number.isFinite(Number(row.inverter_state_raw)) && Number(row.inverter_state_raw) !== 0)
      ? decodeInverterState(Number(row.inverter_state_raw))
      : null,
```

The 0-check matches the existing offline-marker pattern used for `qac_var` / `tempint_c` in Slice β.

### §2.3 Module exports — add `decodeInverterState` to `module.exports`

At the bottom of [server/poller.js](../server/poller.js) (find `module.exports = { ... }` line ~1637), add `decodeInverterState` to the exports list alongside `_signedInt16` and `parseRow`.

### §2.4 [server/index.js](../server/index.js) — feature flag default

Find the existing settings-defaults block (search for the existing default settings registration in `buildDefaultSettingsSnapshot()` — currently dirty with curtailment additions; add the new key in the SLICE γ region carefully).

Add the key with default `"0"` (off):

```javascript
useAuthoritativeInverterState: "0",
```

The settings table accepts arbitrary key/value strings via the existing `setSetting`/`getSetting` API — no schema change. The flag is **read** by any downstream consumer that wants to use the decoded state; Slice γ itself does NOT switch any existing logic.

### §2.5 [public/index.html](../public/index.html) — add State column header

Find the param-table `<thead>` block (around line 14993). After the `<th>Freq (Hz)</th>` row, **before** `<th title="...Inv Alarms">`:

```html
<th title="Inverter operating state from Modbus reg 30074: phase (init/magnetizing/connected/error) + flags (stop/blocked/grid-fault).">State</th>
```

Result: 18 columns total (was 17). One-line additive change.

### §2.6 [public/js/app.js](../public/js/app.js) — render decoded state cell

Find `_paramRowHtml` (around line 15253 in the post-Slice-β tree; line numbers may have shifted). The function builds a template string of `<td>` cells. Add:

1. **Inline helper** at the top of `_paramRowHtml` (or as a module-scoped helper if cleaner):

```javascript
function _decodeInverterStateClient(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  const u16 = n & 0xFFFF;
  const lo = u16 & 0xFF;
  const hi = (u16 >> 8) & 0xFF;
  const phaseMap = { 0: "initial", 1: "magnetizing", 2: "connected", 3: "error" };
  const phase = phaseMap[lo] || "unknown";
  return {
    phase,
    stop:      (hi & 0x01) !== 0,
    blocked:   (hi & 0x02) !== 0,
    gridFault: (hi & 0x04) !== 0,
  };
}

function _stateChip(stateRaw) {
  const s = _decodeInverterStateClient(stateRaw);
  if (!s) return "—";
  const label = s.phase === "connected" ? "RUN"
    : s.phase === "magnetizing" ? "MAG"
    : s.phase === "initial" ? "INIT"
    : s.phase === "error" ? "ERR"
    : "?";
  const flags = [
    s.stop ? "STOP" : null,
    s.blocked ? "BLK" : null,
    s.gridFault ? "GFAULT" : null,
  ].filter(Boolean).join(" ");
  return flags ? `${label} (${flags})` : label;
}
```

2. **Add the cell** at the end of the row template (after `track_alarms` cell, before the closing backtick):

```javascript
<td class="state-cell" title="Inverter state (reg 30074).">${_stateChip(r.inverter_state_raw_last ?? r.inverter_state_raw)}</td>
```

The `r.inverter_state_raw_last ?? r.inverter_state_raw` chain handles BOTH the persisted-row format (Slice β aggregated `_last` suffix) AND the live-bucket format (raw frame field). Both are present in the API response.

### §2.7 [public/css/style.css](../public/css/style.css) — minimal styling (optional)

Add near the existing `.alarm-cell` styles:

```css
/* v2.10.x Slice γ — Parameters page state column */
.param-table td.state-cell {
  font-family: var(--mono-font, "Cascadia Mono", "Consolas", monospace);
  font-size: 0.9em;
  text-align: center;
  white-space: nowrap;
}
```

Optional — skip if it conflicts with the dirty curtailment styles already in `style.css`.

---

## §3 Test plan (TDD-first)

### New test file [server/tests/inverterStateDecode.test.js](../server/tests/inverterStateDecode.test.js)

Match the test framework pattern of [pollerSignedDecode.test.js](../server/tests/pollerSignedDecode.test.js) (custom `test()` harness with `process.exitCode`).

**Required test cases (write FIRST, confirm RED before implementing):**

Phase decoding (5):
- `decodeInverterState(0x0000)` → phase `initial`, phaseCode 0, no flags
- `decodeInverterState(0x0001)` → phase `magnetizing`, phaseCode 1
- `decodeInverterState(0x0002)` → phase `connected`, phaseCode 2
- `decodeInverterState(0x0003)` → phase `error`, phaseCode 3
- `decodeInverterState(0x0004)` → phase `unknown`, phaseCode -1

Status flags (6):
- `0x0102` → stop true, phase `connected`
- `0x0202` → blocked true
- `0x0402` → gridFault true
- `0x0702` → all three flags true + connected
- `0x0103` → stop true + phase `error`
- `0x0700` → all flags + phase `initial`

Edge cases (5):
- `null` → phase `unknown`, raw `null`
- `undefined` → phase `unknown`
- `NaN` → phase `unknown`
- `"0x0202"` (string) → phase `unknown` (we want strict numeric input)
- `0x10000` (overflow) → masks to `0x0000` → phase `initial`
- `-1` (passes Number.isFinite) → masks to `0xFFFF` → phase `unknown` (lo=0xFF)

parseRow integration (3):
- `parseRow({...minRow, inverter_state_raw: 0x0202})` → `result.inverter_state.blocked === true`
- `parseRow({...minRow})` (no inverter_state_raw) → `result.inverter_state === null`
- `parseRow({...minRow, inverter_state_raw: 0})` → `result.inverter_state === null` (offline marker)

Total: ~19 assertions across 19 test cases.

**Test framework:** Use `delete require.cache[require.resolve("../poller")]` then `const { decodeInverterState, parseRow } = require("../poller")` so the test re-imports clean.

**Identity helper:** Reuse the `makeIdentity()` / `makeRow()` pattern from `parseRowSlowFields.test.js`.

---

## §4 Backward-compatibility checklist

- [ ] **Feature flag default OFF** — `useAuthoritativeInverterState = "0"`. Operators see no change in run/stop inference until they explicitly enable.
- [ ] **Existing parseRow keys preserved** — `inverter_state_raw` stays as before (Slice β); new `inverter_state` is additive.
- [ ] **Parameters page renders for ALL rows** regardless of flag (per parent plan §4 constraint "always visible").
- [ ] **Dashboard Inverter Card unchanged** — current PAC + alarm + on_off inference remains the source of truth for the run/stop badge until flag enabled.
- [ ] **Existing tests pass** — `pollerSignedDecode.test.js`, `parseRowSlowFields.test.js`, `dailyAggregatorCore.test.js`, `dbSlowFieldsMigration.test.js` all green.
- [ ] **No DB schema change** — Slice β already added `inverter_state_raw_last`; Slice γ READS only.

---

## §5 Smoke sequence

```powershell
# Switch to Node ABI
npm run rebuild:native:node

# Run new + regression
node server/tests/inverterStateDecode.test.js
node server/tests/pollerSignedDecode.test.js
node server/tests/parseRowSlowFields.test.js
node server/tests/dbSlowFieldsMigration.test.js
node server/tests/dailyAggregatorCore.test.js
node server/tests/alarmReferenceShape.test.js

# Python regression (no changes here, just confirm)
python -m pytest services/tests/test_read_fast_async.py services/tests/test_slow_poll_decode.py -v

# Restore Electron ABI
npm run rebuild:native:electron
```

---

## §6 Rollback

`git revert <slice-γ-commit>`. The settings-table value `useAuthoritativeInverterState=0` persists harmlessly. No DB schema change. No data migration to undo.

---

## §7 Conflict avoidance with dirty curtailment work

| Dirty file | Slice γ touches | Where | Risk |
|---|---|---|---|
| `public/index.html` | YES | One `<th>State</th>` inside `param-table` block (lines ~14993-15011) | LOW — curtailment UI is in different sections (`#plantCapSection` / `#activePowerSection`); zero overlap with `param-table` |
| `public/js/app.js` | YES | Inside `_paramRowHtml` only (~line 15253+) | LOW — curtailment renderers are separate functions (search for `plantCap` / `apc`) |
| `server/index.js` | YES | One key in settings-defaults block | LOW — curtailment routes are different functions; settings-defaults is shared but additive |
| `public/css/style.css` | OPTIONAL | One `.state-cell` rule | LOW — skip if collision; styling is non-critical |

**Strategy at commit time:** Same hunk-staging pattern as Slice α / β. Backup dirty files, revert to HEAD, re-apply Slice γ only, stage, restore working tree. ~5 min of git gymnastics.

---

## §8 HANDOFF: planner → tdd-guide

### Context

Slice γ is **pure JS** — no Python changes, no DB schema changes, no new Modbus reads. Slice β (commit `313c48f`) already captures `inverter_state_raw` from reg 30074 and aggregates it into `inverter_5min_param.inverter_state_raw_last`. Slice γ adds the bit-decoder, attaches the decoded object to every parsed frame, registers a feature flag (default off), and adds ONE column "State" to the Parameters page (always visible, not gated).

### Files to modify (ALL must be touched for Slice γ to be DONE)

1. [server/poller.js:~593](../server/poller.js#L593) — add `decodeInverterState` helper after `_signedInt16`
2. [server/poller.js:~742](../server/poller.js#L742) — extend parseRow with `inverter_state` field
3. [server/poller.js: end](../server/poller.js) — add `decodeInverterState` to module.exports
4. [server/index.js settings-defaults](../server/index.js) — add `useAuthoritativeInverterState: "0"`
5. [public/index.html:~15009](../public/index.html#L15009) — add `<th>State</th>` to param-table thead
6. [public/js/app.js:~15253](../public/js/app.js#L15253) — add `_decodeInverterStateClient` + `_stateChip` helpers + render `<td class="state-cell">` in `_paramRowHtml`
7. [public/css/style.css](../public/css/style.css) — OPTIONAL `.state-cell` rule

### Tests to write FIRST (TDD)

Create [server/tests/inverterStateDecode.test.js](../server/tests/inverterStateDecode.test.js) with the 19 test cases in §3 above. Confirm all FAIL before implementing.

### Open questions (resolve in implementation)

1. **State column placement** — proposed at the END of the table after Track Alarms. Acceptable? (Lower risk than inserting mid-table.)
2. **Decoder duplication** — backend `decodeInverterState` in poller.js + client `_decodeInverterStateClient` in app.js are intentional duplicates (different runtimes). Keep them in sync as a code-review checkpoint.
3. **Settings UI control** — DEFER to the planned "Plant Controller" UI rename pass. For Slice γ, the flag exists in DB; operators can toggle via direct settings POST or via a future Settings UI section.

### Recommendations

1. Write the test file first, run it RED, then implement. Decoder is pure logic; should reach GREEN in <30 min.
2. Then add the parseRow extension + module.exports update.
3. Then UI work: HTML header → JS helpers → CSS (optional).
4. Settings flag last (it's a no-op until enabled by an operator).
5. Final smoke: Python regression + Node tests + Electron rebuild.

### What "DONE" means for tdd-guide

Verify with grep BEFORE handing off to code-reviewer:
```bash
# Backend decoder + parseRow integration
grep -n "decodeInverterState\|inverter_state:" server/poller.js
# Should show: function definition, parseRow attachment, module.exports

# UI changes
grep -n "<th.*State<\|state-cell\|_stateChip" public/index.html public/js/app.js
# Should show: header in HTML, helper + cell in app.js

# Settings flag
grep -n "useAuthoritativeInverterState" server/index.js
# Should show at least one entry

# Test file
ls -la server/tests/inverterStateDecode.test.js
# Should exist
```

If any of those greps return empty, the slice is INCOMPLETE — do not declare done.

---

**End of plan.** Ready for tdd-guide dispatch.
