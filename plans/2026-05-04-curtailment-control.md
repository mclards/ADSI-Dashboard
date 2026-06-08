# Curtailment Control — UI + Smooth-Ramp Orchestrator

**Date:** 2026-05-04
**Status:** PLANNING — no code changes yet
**Author:** Claude (planning) for Engr. M.
**Owner:** Engr. Clariden D. Montaño REE
**UI home:** existing **Plant Cap** page ([public/index.html:888](../public/index.html#L888) `#page-plant-cap`) — extended, NOT a new page.

---

## 0. Goal

Add operator-facing **continuous active-power curtailment** to the dashboard at three scopes:

1. **Per-node** — one Modbus slave on one IP
2. **Per-inverter** — every node on one IP (typically 2–4 nodes per the project's `ipconfig`)
3. **Plant-wide** — every node across every IP (currently 27 inverters → ~80 slaves)

This **extends the existing Plant Cap subsystem** ([server/plantCapController.js](../server/plantCapController.js), 1751 LOC). Plant Cap today is a **binary STOP/START sequencer** that keeps plant output below an MW upper band by stopping inverters in a configured sequence with a cooldown between actions. The new feature adds **continuous %P (Q15) setpoint control** as a complementary lever. Both share the page, the audit history, the schedule engine, the auth surface, and the operator's mental model.

The protocol is verified (2026-05-04) — see §1. The hard part is **smooth timing**: applying a setpoint change to many inverters without producing a grid step that violates WESM FAS limits, trips substation protection, or hammers the day-ahead forecast tracker.

---

## 1. Verified protocol (recap — DO NOT re-derive)

Decoded from `http://192.168.1.126/inverter/map/1` (firmware AAV1003BA, fileversion 8) and proven against a live inverter on **2026-05-04**:

```
Function code : 0x10 (Write Multiple Registers, FC16)
Start address : 0x03E8  (= 1000)
Quantity      : 1 reg for STOP/START, 2 regs for SET-P
Reg[1000]     : opcode  0x0005 STOP | 0x0006 START | 0x0003 SET-ACTIVE-PCT
Reg[1001]     : Q15 setpoint  (pct/100 × 0x7FFF)  — only when opcode=0x0003
```

Frame for 50% on slave 1: `01 10 03E8 0002 04 0003 4000` (RTU) or wrapped in MBAP for TCP. Wire test: PAC dropped from ~143 kW → ~125 kW within 8 s (consistent with 250 kW rated × 50% = 125 kW), confirming **the setpoint is a fraction of rated power, not of current PAC**.

Spike artefacts:
- [_spike/verify_command_write.py](../_spike/verify_command_write.py) — pymodbus harness
- [_spike/inverter_webui_192.168.1.126/api/map_slave1.json](../_spike/inverter_webui_192.168.1.126/api/map_slave1.json) — full register/command catalog
- [_spike/inverter_webui_192.168.1.126/api/maps_available.json](../_spike/inverter_webui_192.168.1.126/api/maps_available.json) — fleet checksum index

---

## 2. Reusable primitives we already have

| Need | Existing component | File |
|---|---|---|
| **Plant Cap controller (binary sequencer + schedule engine + history)** | `PlantCapController` + `ScheduleEngine` classes | [server/plantCapController.js](../server/plantCapController.js) (1751 LOC) |
| **Plant Cap REST surface (`/api/plant-cap/*`)** | status, preview, enable, disable, release, history, forecast-impact, schedule-status, schedules | [server/index.js:15104](../server/index.js#L15104)+ |
| **Plant Cap page** | `#page-plant-cap` section + toolbar (status badge, plant MW, band label, Add Schedule btn) + `#plantCapPageContainer` host div | [public/index.html:888](../public/index.html#L888) |
| **Plant Cap renderer + state** | `renderPlantCapPanel()`, `plantCapPageContainer` mount at app.js:4557, state keys `plantCapUpperMw / plantCapLowerMw / plantCapSequenceMode / plantCapSequenceCustom / plantCapCooldownSec` | [public/js/app.js:64-72](../public/js/app.js#L64), [public/js/app.js:4557](../public/js/app.js#L4557) |
| **Plant Cap CSS** | `.plant-cap-page-container`, `.plant-cap-panel` token system | [public/css/style.css:5381](../public/css/style.css#L5381) |
| FastAPI write endpoint pattern | `@app.post("/write")` and `/write/batch` | [services/inverter_engine.py:2412](../services/inverter_engine.py#L2412) |
| Per-IP write/read serialization | `thread_locks[ip] = threading.Lock()` | [services/inverter_engine.py:194](../services/inverter_engine.py#L194) |
| Per-inverter pymodbus client pool | `read_fast_async()` connection cache | [services/inverter_engine.py:1359](../services/inverter_engine.py#L1359) |
| Bulk-action auth (`sacupsMM`) | Topology / bulk auth shared by sync-clock, stop-reasons | [server/index.js](../server/index.js) — search `sacupsMM` |
| Generic audit log | `insertAuditLogRow({ts, operator, inverter, node, action, scope, result, reason})` | [server/db.js:2412](../server/db.js#L2412) |
| WS broadcast for live progress | Existing `wsBroadcast(type, payload)` infra | [server/index.js](../server/index.js) |
| 1 IP ↔ N nodes mapping | `ipconfig.json` (loaded by InverterCoreService) | per CLAUDE.md inverter-engine section |
| Forecast cap-awareness scope filter | `forecast_cap_awareness.md` memory — ML training already excludes capped windows | [memory/forecast_cap_awareness.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/forecast_cap_awareness.md) |

**Implication:** the new feature is mostly composition + extension of Plant Cap. Required net-new code is one Python ramp orchestrator (~150 LOC), `PlantCapController.applySetpoint()` + ramp methods (~120 LOC added in `plantCapController.js`), 4 new endpoints under `/api/plant-cap/setpoint/*` (~80 LOC), two DB tables, and a new tab inside the existing Plant Cap page (no new sidebar entry, no new route).

---

## 3. Three scopes — blast-radius and authentication

| Scope | Targets per call | Worst-case ΔP | Auth tier |
|---|---|---|---|
| Per-node | 1 slave | ≤ 250 kW | Admin password (existing `admin/1234` or upgraded) |
| Per-inverter | 1 IP × 2–4 nodes | ≤ 1 MW | Admin password |
| Plant-wide | All IPs × all nodes | ≤ 6.75 MW (27×250 kW) | **`sacupsMM`** (current minute or ±1) — same gate as bulk control |

Rejection rules at the API layer:
- Plant-wide setpoint < 5% requires confirm dialog AND `sacupsMM`.
- Plant-wide STOP requires double-confirm + `sacupsMM` AND a typed phrase ("STOP ALL INVERTERS").
- A per-node setpoint < 5% just warns; not gated harder.

---

## 4. Smooth-timing algorithm

### 4.1 Why it matters

Going 100 → 50 % across 27 inverters at 250 kW = **3.375 MW step**. Hitting all simultaneously creates:
- A grid-side reactive transient at the substation
- WESM FAS MAPE/PERC95 spike against the submitted forecast (per [memory/wesm_fas_compliance.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/wesm_fas_compliance.md))
- Unnecessary substation regulator hunting
- Forecast-error attribution noise (the ML residual classifier sees a step it didn't predict)
- Stop-reason auto-capture cascade if any inverter rejects (per stop-reason auto-capture memory)

Inverters have their own internal ramp (~2–3 kW/s observed in the §1 wire test), but they cannot smooth a fleet-wide synchronous step. We must **(a) sub-divide the magnitude** and **(b) stagger across the fleet**.

### 4.2 The two-axis ramp

Two independent dimensions:

- **Magnitude axis** — split a large delta into N intermediate setpoints.
- **Fleet axis** — split the inverter list into M batches and write each batch B ms after the previous.

```
Inputs:
  current_pct       (read from inverter_curtailment_state, default 100)
  target_pct        (operator slider value)
  scope_targets     [(ip, slave), ...]   ← per-node = 1 entry, plant = ~80 entries

Config (settings keys, see §6):
  curtailRampMagStepMaxPct      default 25   — magnitude per sub-step
  curtailRampSubStepHoldS       default 6    — pause between sub-steps
  curtailRampBatchCount         default 4    — fleet batches
  curtailRampBatchSpacingMs     default 1500 — ms between batches
  curtailRampWriteJitterMs      default 80   — random ±jitter on each write to avoid TCP burst

Algorithm:
  delta = abs(target_pct - current_pct)
  sub_n = max(1, ceil(delta / curtailRampMagStepMaxPct))
  sub_setpoints = linear_interp(current_pct, target_pct, sub_n)   # excludes current, includes target
  batches = round_robin_split(scope_targets, curtailRampBatchCount)

  for sub in sub_setpoints:
      for batch in batches:
          fanout(batch, sub):
              for (ip, slave) in batch:
                  jitter = random(-J, +J)
                  schedule write_fc16(ip, slave, sub) at (now + jitter) ms
                  using thread_locks[ip] to serialize with poller
          sleep(curtailRampBatchSpacingMs)
      if sub != last:
          sleep(curtailRampSubStepHoldS * 1000)
```

### 4.3 Total ramp time examples (default config)

| Operation | Sub-steps | Time per sub-step | Total |
|---|---|---|---|
| Per-node 100→50% | 2 | ~100 ms (1 batch) + 6 s hold | ~6.2 s |
| Per-inverter 100→50% (4 nodes) | 2 | ~150 ms + 6 s | ~6.3 s |
| Plant-wide 100→75% | 1 | 4 batches × 1.5 s | ~6 s |
| Plant-wide 100→50% | 2 | 2 × (6 s + 6 s hold) | **~24 s** |
| Plant-wide 100→0% | 4 | 4 × (6 s + 6 s hold) | **~48 s** |
| Plant-wide STOP | 1 (single opcode 0x0005) | 4 batches × 1.5 s | ~6 s — STOP is intentionally fast |

Tunable in `settings` so the operator can favour faster (smaller plants) or slower (grid-tight plants) ramps without code changes.

### 4.4 Ramp atomicity and abort

- A ramp is a single `RampJob` with a UUID, persisted as it runs.
- New ramp request while one is active: **reject with 409 Conflict** unless `force=true` (which cancels the in-flight job and starts the new one).
- If a write fails mid-ramp:
  - Per-node failure → log to `inverter_curtailment_ramp_log`, continue with remaining batches (the failed slave keeps its previous setpoint, surfaced as a yellow card in UI).
  - Whole-batch failure (network down) → **abort remaining sub-steps**, hold at the partial state. UI shows operator the partial outcome and offers Retry / Restore-to-current.
- On dashboard restart mid-ramp: see §7.2.

---

## 5. Backend structure

### 5.1 Python — `services/inverter_engine.py` additions (no code yet)

New module-level state:
```
curtailment_state: dict[(ip, slave), CurtailEntry]
ramp_jobs: dict[UUID, RampJob]
ramp_lock = threading.Lock()
```

New helpers:
- `write_command_register(ip: str, slave: int, opcode: int, setpoint: int|None) -> dict`
  Single FC16 to reg 1000 (and 1001 if opcode requires). Uses `thread_locks[ip]`. Returns `{ok, raw_response, error?}`.
- `set_active_power_pct(ip, slave, pct)` — wraps above with `opcode=0x0003` and Q15 conversion.
- `stop_inverter(ip, slave)` / `start_inverter(ip, slave)` — opcodes 0x0005 / 0x0006.

New endpoints:
- `POST /curtail/preview` body `{scope, targets, target_pct, current_pct}` → returns the planned ramp (no writes), used by UI to show "this will take ~24 s in 2 sub-steps".
- `POST /curtail/run` body `{scope, targets, target_pct, mode='ramp'|'immediate', force?}` → starts a `RampJob`, returns `{job_id}`. WS broadcasts progress.
- `POST /curtail/abort/{job_id}` → cancels ramp; remaining batches are skipped; partial state recorded.
- `GET  /curtail/state` → returns `curtailment_state` dict for UI hydration.
- `GET  /curtail/jobs/{job_id}` → returns `RampJob` snapshot (status, completed_steps, errors).

### 5.2 Node — `server/index.js` + `server/plantCapController.js` additions

New endpoints **under the existing `/api/plant-cap/` namespace** (consistent with `enable / disable / release / preview / status / history / forecast-impact / schedule-status / schedules`):

- `POST /api/plant-cap/setpoint/preview` — proxies to Python `/curtail/preview`.
- `POST /api/plant-cap/setpoint/apply` — auth-gated; logs to `audit_log` BEFORE proxying (so even an aborted-pre-write attempt is auditable); proxies to Python `/curtail/run`; broadcasts WS event `plantCap.setpoint.start`.
- `POST /api/plant-cap/setpoint/abort/:job_id` — auth-gated; proxies; WS broadcasts `plantCap.setpoint.abort`.
- `GET  /api/plant-cap/setpoint/state` — public read; returns merged setpoint table; consumed by both the Plant Cap status badge and the new tab.
- `GET  /api/plant-cap/setpoint/jobs/:job_id` — returns ramp snapshot for progress bar.

`PlantCapController` (in [server/plantCapController.js](../server/plantCapController.js)) gets new methods so the controller owns the cross-feature state machine in one place:

- `previewSetpoint({ scope, targets, target_pct })`
- `applySetpoint({ scope, targets, target_pct, force, operator })`
- `abortSetpoint(job_id, operator)`
- `getSetpointState()` — returns `{ perSlave: [...], plantAvgPct, lastJob }`
- Internal: `_isMwSequencerActive()` — used by `applySetpoint` to enforce the lockout from §7.6

Auth gating (mirrors existing Plant Cap rules):
- Per-node and per-inverter setpoint → admin password (same as `/api/plant-cap/release`).
- Plant-wide setpoint or any STOP → `sacupsMM` (same as `/api/plant-cap/enable` for the binary sequencer).

WS broadcast events:
- `curtailment.state` (global setpoint table changed)
- `curtailment.job` (ramp progress: `{job_id, sub_step, sub_total, batch, batch_total, target_pct}`)
- `curtailment.error` (per-write failure inside a ramp)

### 5.3 Database — `server/db.js`

Two new tables:

```sql
CREATE TABLE IF NOT EXISTS inverter_curtailment_state (
  inverter_ip   TEXT NOT NULL,
  slave         INTEGER NOT NULL,
  active_pct    REAL NOT NULL DEFAULT 100,   -- last successfully written %
  opcode        INTEGER NOT NULL DEFAULT 6,  -- last opcode (5/6/3)
  applied_ts    INTEGER NOT NULL,
  job_id        TEXT,
  source        TEXT,                         -- 'operator' | 'auto' | 'recovery'
  PRIMARY KEY (inverter_ip, slave)
);

CREATE TABLE IF NOT EXISTS inverter_curtailment_ramp_log (
  job_id        TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  inverter_ip   TEXT,
  slave         INTEGER,
  sub_step      INTEGER,
  batch_idx     INTEGER,
  setpoint_pct  REAL,
  result        TEXT,            -- 'ok' | 'error' | 'aborted' | 'skipped'
  error         TEXT,
  PRIMARY KEY (job_id, ts, inverter_ip, slave)
);
CREATE INDEX IF NOT EXISTS idx_ramp_job_ts ON inverter_curtailment_ramp_log(job_id, ts);
```

Also reuse existing `audit_log` for the operator-level event (one row per `apply` call regardless of how many writes the ramp executes — the per-write detail lives in `ramp_log`).

Retention defaults: state table is durable (no TTL); ramp_log retains 90 days (settings key `curtailmentRampLogRetainDays`).

Replication: per [memory/replication_modes.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/replication_modes.md), if remote viewers need to see curtailment state, add both new tables to the replication whitelist. Default: **state** is replicated, **ramp_log** is local-only (it can get verbose).

---

## 6. Settings (operator-tunable)

Add to settings page under a new "Curtailment" subsection (collapsed by default):

| Key | Default | Range | Tooltip |
|---|---|---|---|
| `plantCapSetpointEnabled` | `0` | 0/1 | Enables the **Setpoint (%P)** tab on the Plant Cap page. Off by default to prevent accidental access. |
| `curtailRampMagStepMaxPct` | `25` | 5–100 | Max %P change per sub-step. Smaller = smoother ramp, longer total time. |
| `curtailRampSubStepHoldS` | `6` | 1–60 | Pause between sub-steps so each step's ramp completes before the next is issued. |
| `curtailRampBatchCount` | `4` | 1–10 | Fleet split for plant-wide ramps. 1 = simultaneous (worst for grid). |
| `curtailRampBatchSpacingMs` | `1500` | 100–10000 | Delay between batch starts. |
| `curtailRampWriteJitterMs` | `80` | 0–500 | Per-write random jitter. 0 disables. |
| `curtailmentBulkRequiresSacups` | `1` | 0/1 | Require `sacupsMM` for plant-wide / STOP. |
| `curtailmentRampLogRetainDays` | `90` | 7–730 | Retention for ramp_log. |
| `curtailmentRestoreOnDashboardStart` | `0` | 0/1 | If on, dashboard re-issues the persisted setpoints on startup. Off = inverters keep whatever they had. |

Per [memory/feedback_no_ui_intro_copy.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_no_ui_intro_copy.md), all explanatory text goes in `title=` tooltips, NOT inline copy.

---

## 7. Edge cases and recovery

### 7.1 Coordination with the read poller

The poller already calls `read_fast_async(ip, ...)` under `thread_locks[ip]`. Our writes use the same lock — guaranteed no interleaving on the wire. **But** holding the lock for the entire 24-s ramp would freeze reads. Therefore:

- Acquire the lock **per individual FC16 write only** (~50 ms).
- Sub-step `sleep` and batch `sleep` happen OUTSIDE the lock.
- Worst-case: a 5-s poll cycle sees one or two of its slaves return briefly stale data. Acceptable.

### 7.2 Dashboard restart mid-ramp

- A `RampJob` row in `inverter_curtailment_ramp_log` with `result=null` indicates an in-flight job at shutdown.
- On boot, mark all such rows `result='aborted'` with `error='dashboard_restart'`.
- The setpoint state in `inverter_curtailment_state` reflects only **successfully applied** sub-steps, so the plant is left in the last cleanly-written state.
- Optional `curtailmentRestoreOnDashboardStart=1` re-issues those setpoints (useful if the operator wants idempotent boots; off by default because a startup that re-curtails surprises the operator).

### 7.3 Inverter reboot / comm loss

- INGECON inverters reset to 100% on power-cycle (verify against vendor docs — flagged as **OPEN QUESTION 1**).
- If an inverter goes offline mid-ramp: that batch's writes log `error=connect_failed`, ramp continues for other batches. UI surfaces a yellow chip "1 inverter unreachable — setpoint not applied".
- After reconnect, optionally auto-reapply the persisted setpoint (controlled by `curtailmentRestoreOnReconnect` — defaults off, but ML training memory and grid contracts may push this to "on" later).

### 7.4 Forecast / ML training contamination

- New `curtailment_state` flag must be joined into the training-data extractor. Per [memory/forecast_cap_awareness.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/forecast_cap_awareness.md), the existing scope-aware audit query already excludes capped windows from training. Extend the same predicate: `EXCLUDE WHERE inverter_curtailment_state.active_pct < 100 AT slot_time`.
- Day-ahead generator should read the current curtailment state and either:
  - Cap the forecast to `min(physics, fleet_avg_curtail_pct × IC)`, or
  - Refuse to generate if a curtailment is active (force operator decision).

  Default = cap. Document in plan §11.

### 7.6 Coordination with the binary MW-cap sequencer (existing Plant Cap)

The existing `PlantCapController` enforces an MW upper band by **stopping** inverters in sequence (write opcode `0` per `getWriteActionLabel`) with a cooldown. The new continuous %P curtailment uses a **different opcode space** (catalog opcode `0x03` to register `1000`). Both can target the same inverter, so we need clear precedence:

- **Active MW sequencer + new %P request → reject** the %P request with a clear UI message ("Plant Cap MW sequencer is active; release it first or wait for the schedule window to end."). The %P controller does not interleave with an in-flight MW-cap action — that risks oscillation between "stop because MW too high" and "set 75% because operator wanted curtailment".
- **Active %P curtailment + MW upper band breached → MW sequencer takes precedence** but logs `reason: "mw_breach_during_pct_curtailment"` so the audit trail explains the override. Once MW returns inside band, the %P setpoint is **re-issued** to all inverters that were stopped (idempotency: the persisted `inverter_curtailment_state` is the source of truth).
- **Schedule engine triggers a binary stop while %P is curtailed → schedule wins** (same precedence rule), and the post-schedule restore re-applies the %P state.
- All transitions emit a single `audit_log` row with `action='plantCap.precedence'` so support has one place to look.

This rule lives in `PlantCapController._isMwSequencerActive()` (new) called from `applySetpoint()`. The existing MW sequencer code is **not modified** — the new path defers to it, never the other way around.

### 7.7 WESM FAS reporting

- Per [memory/wesm_fas_compliance.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/wesm_fas_compliance.md), MAPE/PERC95 use IC normalization. During curtailment windows, IC effectively becomes `IC × current_curtailment_pct`. Without this correction, every minute of operator-curtailed output looks like a forecast bust.
- Add a curtailment-aware MAPE variant: `MAPE_corr = (forecast - actual) / max(IC × curtail_factor, IC × 0.05)`.
- Tag-only first; reporting fix is a follow-up plan once the data is being captured.

---

## 8. UI design

### 8.1 Entry point — extends the existing Plant Cap page

**No new sidebar entry, no new route.** The feature lives inside the existing **Plant Cap** page ([public/index.html:888](../public/index.html#L888) `#page-plant-cap`). The current page layout is:

- Toolbar: Status badge, Plant MW, Band label, "Add Schedule" button
- Body: `#plantCapPageContainer` populated by `renderPlantCapPanel()` ([public/js/app.js:4571](../public/js/app.js#L4571))

We add **a tab strip at the top of `#plantCapPageContainer`** with two tabs:

1. **MW Cap (Sequencer)** — the existing controls (upper/lower band, sequence mode, schedules, history). Default tab; renderer untouched.
2. **Setpoint (%P)** — new tab, hosting the per-node / per-inverter / plant-wide controls below.

The toolbar stays shared. Status badge gains a second line when a setpoint is active (e.g. "Idle • Plant 75%"). Plant MW reading is reused as-is.

### 8.2 Setpoint tab layout (inside `#plantCapPageContainer`)

```
┌─ Setpoint (%P) tab ────────────────────────────────────────┐
│ Scope:  ( ) Per-Node   ( ) Per-Inverter   (•) Plant-Wide   │
├────────────────────────────────────────────────────────────┤
│ ── Per-Node controls ── (when scope = Per-Node)            │
│  IP: [192.168.1.126 ▾]   Node: [1 ▾]                       │
├────────────────────────────────────────────────────────────┤
│ ── Per-Inverter controls ── (when scope = Per-Inverter)    │
│  IP: [192.168.1.126 ▾]                                     │
│  Nodes affected (auto from ipconfig): 1, 2, 3              │
├────────────────────────────────────────────────────────────┤
│ ── Plant-Wide controls ── (when scope = Plant-Wide)        │
│  Targets: 27 inverters × ~3 nodes = ~81 slaves             │
│  Current fleet avg: 100%                                   │
├────────────────────────────────────────────────────────────┤
│ Setpoint slider:   ◀━━━━━━━━━━●━━━━━━━━━▶   50%            │
│ Presets:           [0%] [25%] [50%] [75%] [100%]           │
│ Operations:        [STOP all] [START all]                  │
│ Ramp preview:      2 sub-steps × 6 s = ~24 s               │
│                                                            │
│ Auth: admin pw (per-node/per-inverter) | sacupsMM (plant)  │
│                                              [Apply]       │
├────────────────────────────────────────────────────────────┤
│ Live ramp progress (when active):                          │
│ ▓▓▓▓▓▓░░░░  Step 1/2, batch 3/4 — 11.2 s elapsed           │
│ [Abort]                                                    │
├────────────────────────────────────────────────────────────┤
│ Recent setpoint actions (joined into existing history):    │
│ 10:32  per-node 192.168.1.126/1  100% → 50%  ok            │
│ 10:30  plant     all              100% → 75%  ok           │
└────────────────────────────────────────────────────────────┘
```

The "Recent actions" list **shares the existing `/api/plant-cap/history` view** — both binary-sequencer events and setpoint events render in one timeline, distinguished by an action-type column (badge: `MW-STOP`, `%P-SET`, `%P-RAMP`, `STOP`, `START`). Operators see one chronological story.

If the binary MW sequencer is currently active, the Setpoint tab renders disabled with the inline reason from §7.6: *"MW Cap sequencer is active. Release it on the MW Cap tab to enable %P controls."* — clickable link switches tabs.

### 8.3 Schedule integration

The existing `ScheduleEngine` ([server/plantCapController.js:683](../server/plantCapController.js#L683)) supports time-windowed cap actions. **Phase E** adds a `setpointPct` field to the schedule schema so an operator can schedule a curtailment window (e.g. "every weekday 11:00–13:00 set plant to 80%"). This composes the same orchestrator from §4 with the existing schedule trigger. UI: existing "Add Schedule" toolbar button gets a "Schedule type" radio: *MW Cap* (existing) or *Setpoint %P* (new).

Until Phase E lands, schedules and setpoints are independent — operator handles both manually.

### 8.4 Sliders, presets, and CSS

Sliders snap to 1% steps. Preset buttons emit the **canonical Q15 values** (`0x0000 / 0x2000 / 0x4000 / 0x5FFF / 0x7FFF`) — same bytes as the comm-board's SPA — so audit-trail diffs vs the vendor UI match byte-for-byte.

Reuse existing CSS tokens: `.plant-cap-page-container`, `.plant-cap-panel` ([public/css/style.css:5381](../public/css/style.css#L5381)). New `.plant-cap-setpoint-*` classes follow the same `--accent`/`--green`/`--orange`/`--red` scheme. Per project memory rules:

- No uppercase headers
- Auto-sized cards
- Tooltips, no inline `<small>` copy
- Settings (if any) follow 12-col grid (`grid-column: 1/-1` on wrapper)
- User Guide HTML + Markdown + PDF must update together per [memory/feedback_guide_sync.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_guide_sync.md)

### 8.5 Real-time feedback during ramp

- Subscribe to WS `plantCap.setpoint.job` events.
- Progress bar = `(completed_writes / total_writes)` — not `(elapsed / total_time)` — so a slow network does not lie about progress.
- Per-batch status line shows which inverters in that batch succeeded/failed.

---

## 9. Audit and observability

Every operator action emits exactly one `audit_log` row, **using `plantCap.*` action verbs** so the Plant Cap history view (`GET /api/plant-cap/history`) renders binary-sequencer events and setpoint events in one timeline:

```
ts        : epoch ms
operator  : session user (admin / bulk)
inverter  : ip OR 'plant' OR 'inverter:192.168.1.126'
node      : slave OR null OR 'all'
action    : 'plantCap.setpoint.set'    — operator-issued setpoint write
            'plantCap.setpoint.stop'   — operator-issued STOP via setpoint controls
            'plantCap.setpoint.start'  — operator-issued START via setpoint controls
            'plantCap.setpoint.abort'  — operator cancelled in-flight ramp
            'plantCap.precedence'      — auto-event: MW sequencer overrode active %P (per §7.6)
scope     : 'node' | 'inverter' | 'plant'
result    : 'queued' | 'partial' | 'ok' | 'failed' | 'aborted' | 'rejected'
reason    : 'from=100 to=50 ramp=24s job=<uuid>'
            (or 'mw_breach_during_pct_curtailment' for precedence rows)
```

Per-write detail in `inverter_curtailment_ramp_log`. The history endpoint joins both tables; UI badges colour-code by action prefix.

Metrics (surfaced in Analytics → existing engine-health endpoint):
- `plantCap_setpoint_pct_avg` — fleet average current setpoint (drives the toolbar status badge's second line)
- `plantCap_setpoint_jobs_total` / `plantCap_setpoint_job_errors_total` (counters)
- Existing `plantCap_*` MW-cap metrics unchanged.

---

## 10. Phased rollout

| Phase | Slice | Scope | Auth | Risk gate |
|---|---|---|---|---|
| **A** | Python primitives | `write_command_register`, `set_active_power_pct`, `stop`, `start` in `services/inverter_engine.py` | Internal only (no Node, no UI) | Bench test against single dev inverter using a copy of `_spike/verify_command_write.py` |
| **B** | Node REST + audit + Plant Cap controller methods | `/api/plant-cap/setpoint/apply` for **per-node only**; new tab on Plant Cap page hidden behind feature flag | Admin pw | Manual operator test on one production inverter, observe PAC drop in Plant Cap history view |
| **C** | Per-inverter scope + ramp orchestrator | RampJob, sub-steps, batch logic; precedence lockout from §7.6 against MW sequencer | Admin pw | Operator soak test for 1 week — verify lockout triggers correctly when MW sequencer fires during a %P window |
| **D** | Plant-wide scope | `sacupsMM` gate, double-confirm dialogs, "STOP ALL INVERTERS" typed phrase | `sacupsMM` | Run during low-irradiance window first |
| **E** | ScheduleEngine integration | Add `setpointPct` field to schedule schema; "Add Schedule" UI gains Setpoint type; same trigger plumbing as MW-cap schedules | Admin pw + schedule auth | Schedule a low-impact 95% window for 1 hour, observe |
| **F** | Forecast + WESM FAS integration | Training-data exclusion + MAPE_corr per §7.7 | n/a | Compare 7-day MAPE before vs after |
| **G** | Restore-on-restart, restore-on-reconnect | Optional features off by default | settings | Operator decision per site |

Feature flag: `settings.plantCapSetpointEnabled` defaults to **0**. Setpoint tab is hidden until flipped on; the existing MW Cap tab is unaffected throughout all phases.

---

## 11. Open questions

1. **Inverter behaviour on power-cycle** — does an INGECON SUN reset to 100% after a reboot, or remember the last setpoint? Verify against firmware docs OR by intentionally power-cycling one inverter on bench. Drives §7.3 design.
2. **Setpoint lower bound** — is 0% a valid `set_active_power` (vs requiring `STOP` opcode)? Wire test of `0x0003 0x0000` to confirm. Affects whether the slider can reach 0%.
3. **Reactive power coupling** — does curtailing P also clamp Q? Some grid contracts require us to maintain reactive support even at 0% P. May need a separate Q-control catalog later (catalog `cat: "Inverter"` only had P commands; check other firmware versions).
4. **Multiple maps** — `maps_available.json` showed all 27 inverters share `AAV1003BA` checksum, but new firmware may ship a different opcode set. Plan should fetch `/inverter/map/{slave}` from each inverter on startup and warn if catalogs diverge.
5. **Concurrent operator sessions** — two admins both opening the curtailment panel: how do we prevent overlapping ramps? §4.4 says reject 409, but UI needs to surface "another session is running ramp X" instead of just an error toast.
6. **Day-ahead behaviour during active curtailment** — cap the forecast (default), refuse to generate, or let it run uncorrected? Operator preference; document choice in §7.4 once decided.
7. **STOP mid-curtailment** — is sending STOP (0x0005) while a `set_active_power` ramp is in flight safe, or does it confuse the inverter state machine? Bench test before plant-wide STOP is unblocked.
8. **Opcode-space coexistence** — the existing `PlantCapController` writes `0=STOP / 1=START / 2=RESET` (per [server/plantCapController.js:32](../server/plantCapController.js#L32) `getWriteActionLabel`). Our new path writes the comm-board catalog values `0x0005=STOP / 0x0006=START / 0x0003=SET-P` to register `0x03E8`. Confirm during Phase A which physical register the existing MW sequencer targets — if it is the SAME register `0x03E8` with a translated value space, the precedence rule in §7.6 must also serialize on that register, not just on a logical lock. If it is a DIFFERENT register (more likely — a legacy command register from an earlier firmware), document the historical reason and leave the existing path untouched.

---

## 12. Test plan

Smoke (per [memory/release_rules.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/release_rules.md)):
- Unit test: Q15 conversion table matches SPA presets (0%, 25%, 50%, 75%, 100% map to `0x0000, 0x2000, 0x4000, 0x5FFF, 0x7FFF`).
- Unit test: ramp planner returns expected sub-steps and batches for each scope.
- Integration test: mock pymodbus client; ramp completes with all writes accounted for in `ramp_log`.
- Integration test: pymodbus failure in batch 2 — remaining batches still execute, state shows partial.
- Integration test: dashboard restart mid-ramp marks job aborted, preserves last-good state.
- Bench: real inverter, 100→75→50→100% sequence, verify PAC follows.
- Plant: low-irradiance day, plant-wide 100→90→100% (small delta, safe), confirm WESM FAS metrics not impacted.

After each Node-ABI smoke test, run `npm run rebuild:native:electron` per [memory/feedback_native_rebuild.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_native_rebuild.md).

---

## 13. Documentation deliverables (per project conventions)

- This plan: `plans/2026-05-04-curtailment-control.md` (this file)
- Audit folder when development begins: `audits/2026-05-04/curtailment-protocol-verification/` containing:
  - `verify_command_write.py` (a copy of the spike harness)
  - `wire-trace.txt` (the tcpdump/pcap of one Run click — TODO during Phase A)
  - `map_slave1.json` snapshot
- User Guide section to add (Phase B): "Curtailment Control" — explain auth model, ramp behaviour, what each preset does, how to abort. HTML + MD + PDF must update together per [memory/feedback_guide_sync.md](file://C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/feedback_guide_sync.md).
- README + SKILL.md update at v2.10.x release time — add `inverter_curtailment_state` and `inverter_curtailment_ramp_log` to data-architecture section.

---

## 14. What this plan deliberately does NOT include

- **Voltage/frequency ride-through tuning** — separate vendor-set, not operator territory.
- **Reactive (Q) control** — different command catalog, separate plan once §11.3 is resolved.
- **Auto-curtailment by day-ahead schedule** — would compose this primitive but adds scheduler complexity. Defer to a follow-up plan once Phase E lands.
- **REST passthrough to comm-board's `/inverter/command/write/`** — we deliberately use direct Modbus TCP because (a) it avoids comm-board auth state, (b) it composes with the existing per-IP lock, (c) it's the same path our reads use. Comm-board REST is a fallback option only.

---

**End of plan.** Ready for review. No code or DB changes have been made. The only artefacts produced today are this plan + the read-only spike captures under `_spike/`.
