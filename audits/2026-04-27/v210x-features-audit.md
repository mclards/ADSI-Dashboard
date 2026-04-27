# v2.10.x Implemented Features Audit

**Date:** 2026-04-27
**Status:** Complete (code review only — no live hardware soak in this pass)
**Author:** Claude Opus 4.7 (audit), Engr. M. (work)
**Scope:** All features touched on `branch=main` that are uncommitted as of
2026-04-27 18:30 PHT. Verifies wiring, schema, error paths, and contract
compatibility against the existing system.

> **Read first:**
> [CLAUDE.md](../../CLAUDE.md), [SKILL.md](../../SKILL.md),
> [plans/2026-04-27-all-parameters-data-page.md](../../plans/2026-04-27-all-parameters-data-page.md),
> [plans/2026-04-27-stop-reasons-table-and-serial-number-setting.md](../../plans/2026-04-27-stop-reasons-table-and-serial-number-setting.md)

---

## 0 · Summary table

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | All Parameters Data page (UI replacement) | ✅ wired end-to-end | live + history paths, blank state, mode badge, live-poll timer |
| 2 | `inverter_5min_param` schema + aggregator | ✅ ingest → flush → read | reaper, retention pruner, cloud-sync untouched |
| 3 | `/api/params/:inv` and `/api/params/:inv/:slave` | ✅ remote + gateway | solar-window filtered, live bucket appended for today |
| 4 | Daily Data XLSX export | ✅ end-to-end | per-node sheets, ISM column order, today-lock until eodSnapshotHourLocal |
| 5 | Energy Summary HW counter hardening | ✅ multi-fallback rule | gateway-restart-day no longer blanks Etotal/ParcE columns |
| 6 | Stop Reasons (Slice B persist + getRecent/histogram) | ✅ schema + APIs + retention | UNIQUE-dedup safe, FK back to alarms |
| 7 | Stop Reasons auto-capture (Slice F) | ✅ alarms.js hook + 30 s cooldown | 500 ms post-transition delay, audit row on every outcome |
| 8 | Serial Number Read / Edit / Send (Slice C) | ✅ Python + Node + UI tabs | 5-min session token, fleet uniqueness scan, override gate |
| 9 | Legacy Energy page UI cleanup | ✅ stubbed cleanly | data tables and downstream consumers untouched |

---

## 1 · All Parameters Data page

### Frontend ([public/js/app.js:14079-14451](../../public/js/app.js#L14079-L14451))

State container + lifecycle:

| Concern | Implementation |
|---|---|
| State | `ParamPageUI = { inited, inverter, date, isToday, activeSlave, slaves, liveTimer, rowsBySlave, solarStartH, solarEndH, reqId }` |
| Page entry | `initEnergyPage()` → `initAllParamsPage()` (kept the legacy name to avoid touching the dispatch wiring at [app.js:4540](../../public/js/app.js#L4540)) |
| Re-fetch | `_paramFetchAndRender({ silent, force })`, raceguarded by `reqId` |
| Live timer | `_paramSyncLiveTimer()` — 30 s cadence, only when `currentPage === "energy" && isToday && inverter` |
| Day-rollover handler | resets `rowsBySlave + date` at [app.js:6031-6032](../../public/js/app.js#L6031-L6032) |
| Mode-transition refresh | swapped `fetchEnergy({force:true})` → `initAllParamsPage()` at [app.js:7212](../../public/js/app.js#L7212) |

### DOM ([public/index.html:319-362](../../public/index.html#L319-L362))

`#page-energy` markup contains: inverter+date pickers, mode badge, refresh
button, solar-window indicator, blank state, dynamic `#paramTabs` and
`#paramPanels`. Sidebar nav item label is now **ALL PARAMETERS**
([index.html:111](../../public/index.html#L111)).

### Read API ([server/index.js:12791-12887](../../server/index.js#L12791-L12887))

Two endpoints:

- `GET /api/params/:inverter/:slave?date=YYYY-MM-DD` — single-node,
  date-of-day rows; live bucket appended for today.
- `GET /api/params/:inverter?date=YYYY-MM-DD` — all configured slaves in
  one round-trip (used on first load and on inverter switch).

Both query `inverter_5min_param` filtered by `in_solar_window=1` and
include the live in-progress bucket from `dailyAggregator.getCurrentBucket(...)`
ONLY for today AND only when the slot itself falls inside the solar window.

### Aggregator ([server/dailyAggregator.js](../../server/dailyAggregator.js))

| Hook | Where | Notes |
|---|---|---|
| ingest | `poller.js:1280` | best-effort, never gates the persist flush |
| reaper | 30 s interval inside `init({db, getSetting})` | force-flushes any bucket whose slot is past `_slotEndMs + 30 s` |
| retention | `pruneOldRows({reasonsRetainDays, histogramRetainDays})` daily timer at `index.js:19755` | default 365 days, min 7, max 3650 |

Schema lives at [server/db.js:1097-1142](../../server/db.js#L1097-L1142):
`PRIMARY KEY (inverter_ip, slave, date_local, slot_index) WITHOUT ROWID`
plus three indices for date / inv-date / solar-window queries.

### Findings

- ✅ `getConfiguredUnits` is the source of truth for slave order — matches
  the IpConfig that the API also reads, so tabs always line up.
- ✅ Fetch is guarded by a monotonic `reqId` so rapid date changes don't
  let a stale response overwrite the current view.
- ✅ Live timer self-clears whenever the user navigates away.
- ⚠ Operator note: `temp_c` is listed in the table but the column is NULL
  until a temperature register is identified — comment in
  [dailyAggregator.js:148](../../server/dailyAggregator.js#L148) records
  the intent. Renderer shows `—` so users see it's unmapped, not zero.

No dead code in the legacy Energy page area. Verified with
`grep -n "energyDate|energyInv|energyTable|energyBody|renderEnergyTable|
renderEnergySummary|State\.energyView|State\.energyReqId|
buildEnergyViewQueryKey" public/js/app.js` → zero hits.

---

## 2 · Daily Data XLSX Export

### Frontend ([public/js/app.js:18127-18195](../../public/js/app.js#L18127-L18195))

`runDailyDataExport()` posts `{inverter, date}` → `/api/export/daily-data`,
opens the resulting folder via `openExportPathFolder`. AbortController is
registered against `btnCancelDailyDataExport` so the operator can cancel
mid-flight. Today-lock 423 surfaces as "✗ Today's daily data unlocks at
HH:00 — try a past date or wait for the End-of-Day snapshot." (raw error
string from the API, rendered verbatim).

DOM card: [public/index.html:750-791](../../public/index.html#L750-L791).
Default date: yesterday (set at `initExportPage()` [app.js:17066-17068](../../public/js/app.js#L17066-L17068)).

### API ([server/index.js:18545-18583](../../server/index.js#L18545-L18583))

- Remote-mode passthrough via `downloadRemoteExportToLocal`.
- Body validation: `inverter` (Number > 0), `date` (`YYYY-MM-DD` regex).
- Today-lock: HTTP **423** if `date === _todayLocal()` and current hour
  `< eodSnapshotHourLocal`. Returns `{ ok:false, error, lockedUntilHour }`
  so the UI can render the unlock time.
- Job runs through `runGatewayExportJob("daily-data", ...)` so it inherits
  the standard cancel/abort plumbing.

### Workbook ([server/exporter.js:2888-3009](../../server/exporter.js#L2888-L3009))

| Concern | Implementation |
|---|---|
| Output path | `resolveExportSubDir(inv, EXPORT_FOLDERS.energy, 'Daily Data')` → `INV-XX daily-data YYYY-MM-DD.xlsx` |
| Streaming | ExcelJS `WorkbookWriter` (`useStyles`, `useSharedStrings:false`) |
| One sheet per slave | `Node N` — only iterates slaves from `readInverterConfig().units[inv]` |
| Column order | ISM-compatible (Pdc, Vdc, Idc, Vac1-3, Iac1-3, Temp, Pac, Partial Energy, CosΦ, Freq, Inv Alarms, Track Alarms) |
| Partial Energy formula | `pacW * 5 / 60 / 1000` kWh per slot — same as the inline doc-string at line 2924 (`pac_w/12/1000`) |
| Solar-window filter | `WHERE in_solar_window = 1 ORDER BY slot_index ASC` |

Yields `await yieldToEventLoop()` between sheets so a 4-node export
doesn't block the poller persist flush.

### Findings

- ✅ Schema validation is strict at the API layer and re-validated inside
  `exportDailyData` (defense in depth).
- ✅ Inverter-without-IP and inverter-without-nodes both return clear
  errors (caught by `sendExportRouteError`).
- ✅ Error path uses `sendExportRouteError` which already maps Errors to
  the standard envelope `{ ok:false, error, code? }`.

---

## 3 · Energy Summary HW Counter Hardening

### Problem (motivated by the screenshot)

`Etotal MWh (HW)` and `ParcE MWh (HW)` columns were blank for every row of
a normal multi-day export when the gateway booted **after** `eodSnapshotHourLocal`.
The strict v2.9.x rule was: *if today's baseline `source != 'eod_clean'`,
emit NaN for both columns*. A fresh-boot day always had `source = 'poll'`
or `source = 'pac_seed'` → entire export came back blank.

### Fix ([server/exporter.js:1259-1424](../../server/exporter.js#L1259-L1424))

Multi-path fallback:

| Day type | Path 1 (preferred) | Path 2 (fallback) |
|---|---|---|
| **TODAY** | `current_counter − today's baseline` (any source — poll, pac_seed, eod_clean) | `current_counter − yesterday's eod_clean` if today's baseline row missing |
| **PAST DAY D** | `baseline[D].eod_clean − baseline[D].baseline` (the v2.9.x rule) | `baseline[D+1].baseline − baseline[D].baseline` (tomorrow's open ≈ today's close) |

Sanity gate via `_acceptDelta(deltaKwh)` — rejects negative or
`> PER_UNIT_DAY_KWH_CEILING (9000 kWh)`. 9000 = 250 kW × 24 h × 1.5
safety, per-unit.

DAY-TOTAL row still NaN-propagates when **any** unit's HW value is
invalid, so a single bad node visibly poisons the day-total cell rather
than silently understating fleet energy.

### Cache layer

`_baselinesForDay(dayKey)` memoizes `getCounterBaselinesForDate` calls so
the today / yesterday / tomorrow lookups don't re-query SQLite N times
across a multi-day window.

### Findings

- ✅ Pure scaling math (`applyInverterScale`) at
  [server/energySummaryScaleCore.js:32-81](../../server/energySummaryScaleCore.js#L32-L81)
  preserves NaN-propagation semantics for both columns and the day-total
  cell.
- ✅ Today path checks `cur` (from `getCounterStateAll`) is present before
  computing — gateway-just-booted-no-counter-state-yet does NOT divide by
  zero, just emits NaN.
- ⚠ Field-test required: when both today's baseline AND yesterday's
  eod_clean are missing (e.g. fresh install, first-boot day), HW columns
  remain blank by design. This is the correct outcome — no anchor =
  no delta — but the operator should know.

---

## 4 · Stop Reasons (Slices B + F)

### Schema ([server/db.js:1019-1072](../../server/db.js#L1019-L1072))

| Table | Purpose |
|---|---|
| `inverter_stop_reasons` | One row per (inverter_ip, slave, node) per `fingerprint` (UNIQUE-dedup). Captures the full DebugDesc record + 19 register fields + `event_at_ms` + `alarm_id` FK. |
| `inverter_stop_histogram` | One row per ARRAYHISTMOTPARO refresh; counters_json holds the 30 motive slots + total. |
| `alarms.stop_reason_id` | NEW column ([db.js:1317](../../server/db.js#L1317)); FK back to `inverter_stop_reasons.id`. Set by Slice F's auto-capture hook. |

Indices:
- `idx_isr_lookup` (inverter_ip, slave, node, read_at_ms DESC)
- `idx_isr_alarm` partial — only rows where `alarm_id IS NOT NULL`
- `idx_isr_event` partial — only rows where `event_at_ms IS NOT NULL`
- `idx_isr_inv_ts` (inverter_id, read_at_ms DESC) for the recent-list API

### Persist ([server/stopReasons.js](../../server/stopReasons.js))

| Function | Purpose |
|---|---|
| `persistStopReasonRow` | Insert one StopReason record. UNIQUE-dedup returns the *existing* row id so `alarms.stop_reason_id` can still link. |
| `persistHistogramRow` | Insert one ARRAYHISTMOTPARO snapshot. |
| `persistEngineResponse` | Single SQLite transaction for the full Python response (nodes + histogram). Differentiates `inserted` vs `deduped` per node. |
| `getRecentForInverter` / `getEventById` / `getEventByAlarmId` | Read paths used by the drilldown + Settings page. |
| `pruneOldRows` | Retention (default 365 d reasons / 90 d histogram). |

### Read APIs ([server/index.js:12712-12747](../../server/index.js#L12712-L12747), [12926-12950](../../server/index.js#L12926-L12950))

- `GET /api/stop-reasons/:inverter/recent`
- `GET /api/stop-reasons/:inverter/event/:event_id`
- `GET /api/stop-reasons/:inverter/histogram`
- `GET /api/alarms/:alarm_id/stop-reason` — drilldown integration; falls
  back to `getEventByAlarmId` when `alarms.stop_reason_id` is missing.

### Refresh API ([server/index.js:12959+](../../server/index.js#L12959))

`POST /api/stop-reasons/:inverter/refresh` — proxies to Python
`/stop-reasons/{inv}/{slave}` (FastAPI handler at
[services/inverter_engine.py:2592-2674](../../services/inverter_engine.py#L2592-L2674)),
persists in one DB transaction. Bulk-auth gated; gateway-only via
`_denyStopReasonsInRemote`.

### Auto-capture (Slice F) ([server/alarmsDiagnostic.js](../../server/alarmsDiagnostic.js))

Hook signature: `({ alarmId, inverter, unit, alarmValue, eventAtMs }) => void`,
registered via `setStopReasonAutoCapture` at
[server/alarms.js:1015-1018](../../server/alarms.js#L1015-L1018) and
called from `raiseActiveAlarm` ([alarms.js:1044-1056](../../server/alarms.js#L1044-L1056)).

| Constraint | Where |
|---|---|
| 500 ms post-transition delay | `TRANSITION_FETCH_DELAY_MS` |
| 30 s per-inverter cooldown | `TRANSITION_FETCH_DEDUPE_MS` |
| 8 s fetch timeout | `FETCH_TIMEOUT_MS` |
| Operator disable | `stopReasonAutoCaptureEnabled` setting |
| Remote-mode safe | `isRemoteMode()` short-circuits |
| Audit log row | every outcome (`ok`/`noop`/`fail`) via `logControlAction` |
| Fire-and-forget | scheduled via `setTimeout` so the poller batch never blocks |
| WS broadcast | `stopReasonCaptured` event when a snapshot is captured |

### Frontend

Settings page card `#stopReasonsSection` ([index.html:2450-2525](../../public/index.html#L2450-L2525))
with two card-tabs (Captured Snapshots + Lifetime Counters). Drilldown
panel for an alarm shows the captured StopReason inline — gated on
`Number(alarmId) > 0` at [app.js:13750](../../public/js/app.js#L13750).

### Findings

- ✅ The poller never waits on the auto-capture; failure paths only emit
  to `audit_log`, never throw.
- ✅ De-dup race fixed: the v2.10.0 hotfix in `persistStopReasonRow` now
  returns the existing row id when UNIQUE fires, so the alarm row's FK
  still gets populated even on a re-fired identical fault.
- ✅ Per-IP serialization is preserved — Python's `thread_locks[ip]` is
  the bottleneck, Node never parallelizes against the same IP.

---

## 5 · Serial Number Read / Edit / Send (Slice C)

### Wire protocol ([memory: ism_serial_write_protocol.md](../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/ism_serial_write_protocol.md))

Decoded byte-for-byte from `frmSetSerial::SetMotorolaSerialNumber` /
`SetTexasSerialNumber` IL templates:

1. **UNLOCK** — FC16 to register `0xFFFA` with values `[0x0065, 0x07A7]`.
2. **WRITE** — FC16 to register `0x9C74`, count `6` regs (Motorola, 12 B)
   or `16` regs (TX, 32 B).
3. **VERIFY** — `Sleep(1000 ms)` then re-read via FC11.

All three stages happen under one `thread_locks[ip]` acquisition so the
poller cannot interleave between unlock and write.

### Python ([services/serial_io.py](../../services/serial_io.py))

| Function | Behaviour |
|---|---|
| `validate_serial_format` | length check (12 / 32) + ASCII-only + printable-only |
| `serial_to_registers` | pack ASCII into UINT16 big-endian byte pairs |
| `read_serial_with_lock` | FC11 Report Slave ID; returns serial + format + warning + model + fw |
| `write_serial_with_lock` | UNLOCK → WRITE → 1 s sleep → readback compare |

### FastAPI handlers ([services/inverter_engine.py:2679-2817](../../services/inverter_engine.py#L2679-L2817))

- `GET /serial/{inv}/{slave}?fmt=auto|motorola|tx`
- `POST /serial/{inv}/{slave}` body `{ new_serial, fmt, verify_delay_s? }`

Both bulk-auth gated, executor-pinned so the asyncio event loop stays
responsive.

### Node ([server/serialNumber.js](../../server/serialNumber.js) + [server/index.js:13104-13520](../../server/index.js#L13104-L13520))

| Concern | Implementation |
|---|---|
| Session-token store | in-memory `Map` keyed by random 32-hex bytes; `SESSION_TTL_MS = 5 min` |
| Mint | every successful Read mints `(token, expiresAt)` bound to (ip, slave, oldSerial, fmt) |
| Consume | every Send must present a fresh, target-matching token |
| Fleet uniqueness | `fleetUniquenessCheck` reads every (inv, slave) via FC11 with concurrency 3 (chosen because the EKI bus exception 0x0B at higher fan-out) |
| Fleet cache | TTL 5 min; bypassed via Send body `bypass_cache:true` or fleet-scan body |
| Override gate | `override_conflicts:true` requires header `x-topology-key = adsiM | adsiMM` |
| Audit | `serial_change_log` row on every outcome (success / verify_failed / engine_error / engine_unreachable) — captures both old and new serial |
| Cache hygiene | success → `invalidateCachedSerial` then `setCachedSerial(new)` |

Routes:

| Verb | Path | Auth |
|---|---|---|
| GET | `/api/serial/log/:inverter` | none — read-only audit |
| GET | `/api/serial/fleet-cache` | none — diagnostic |
| GET | `/api/serial/:inverter/:slave?fmt=...` | bulk-auth (header) |
| POST | `/api/serial/:inverter/read-all` | bulk-auth |
| POST | `/api/serial/fleet/scan` | bulk-auth |
| POST | `/api/serial/:inverter/:slave` | bulk-auth + session token + (override-only) topology auth |

### Frontend ([public/index.html:2319-2447](../../public/index.html#L2319-L2447))

Settings card `#serialNumberSection` with two card-tabs:

- **Read / Edit / Send** — picker (inverter + slave + format), Read button
  mints the session, Edit panel only enables when a Read has succeeded
  (`btnSnbSend disabled` by default).
- **Plant Serial Map** — Scan plant + Show cached map + bypass-cache
  toggle. Diff view of duplicates.

### Findings

- ✅ `_currentSacupsKey()` is injected into the Python upstream so the
  Python side can re-verify bulk-auth without trusting the proxy header
  blindly.
- ✅ Format gate runs **before** UNLOCK on Python — operator typos can't
  leave the inverter in unlocked state.
- ✅ Audit row is persisted even on `engine_unreachable` (catch-all in
  the route handler) so a network blip never hides an attempted change.
- ⚠ **Risk**: `crypto.randomBytes(16)` for the session token is fine for
  same-host trust, but if the gateway is exposed publicly the token
  becomes the only barrier between bulk-auth and a destructive write.
  Bulk auth (`sacupsMM`) is a low-entropy minute-derived key, so the
  server-side topology-key gate on `override_conflicts` is the actual
  defense. Recommend stress-testing with deliberately wrong tokens
  during the next soak.

---

## 6 · Legacy Energy page UI cleanup

### Status

The old Energy page (5-min `inverter_5min` ascending list) is gone from
the UI. Verified by `grep`:

```
grep -n "energyDate|energyInv|energyTable|energyBody|renderEnergyTable|
renderEnergySummary|State\.energyView|State\.energyReqId|
buildEnergyViewQueryKey" public/js/app.js
```

→ **zero hits**. Stubs preserved for upstream callers:

- `initEnergyPage()` ([app.js:14095](../../public/js/app.js#L14095)) →
  forwards to `initAllParamsPage()`.
- `fetchEnergy()` ([app.js:14451](../../public/js/app.js#L14451)) →
  `Promise.resolve()` no-op.

### Data preservation

Untouched and continuously consumed:

| Layer | Status |
|---|---|
| `energy_5min` table | unchanged, populated by `poller.js` flush logic |
| `inverter_5min` table | unchanged |
| `/api/energy/today` | unchanged ([index.js:17722](../../server/index.js#L17722)) |
| `/api/energy/5min` | unchanged ([index.js:16111](../../server/index.js#L16111)) |
| `/api/energy/daily` | unchanged ([index.js:17734](../../server/index.js#L17734)) |
| Forecast / Analytics / Reports / cloud sync | all unchanged |
| Energy Summary export | unchanged path; HW columns hardened (above) |

### Sidebar nav ([index.html:111-113](../../public/index.html#L111-L113))

`data-page="energy"` button now reads **ALL PARAMETERS** with an updated
tooltip pointing at the new feature scope. The page section
`#page-energy` ([index.html:319-362](../../public/index.html#L319-L362))
has `data-page-label="All Parameters Data"`.

---

## 7 · Lint / syntax verification

```
node --check server/exporter.js                 OK
node --check server/index.js                    OK
node --check server/dailyAggregator.js          OK
node --check server/stopReasons.js              OK
node --check server/serialNumber.js             OK
node --check server/alarmsDiagnostic.js         OK
node --check public/js/app.js                   OK

python -c "ast.parse(...)"  inverter_engine     OK
python -c "ast.parse(...)"  serial_io           OK
python -c "ast.parse(...)"  stop_reason         OK
python -c "ast.parse(...)"  vendor_pdu          OK
```

Tests on disk (not yet executed in this session — Electron-ABI rebuild
required first):

- `services/tests/test_stop_reason_parse.py`
- `services/tests/test_vendor_pdu.py`
- `services/tests/test_serial_io.py`
- `server/tests/crashRecovery.test.js`
- `server/tests/counterHealth.test.js`
- `server/tests/alarmReferenceShape.test.js`

Per the project rule (`feedback_native_rebuild.md`), `npm run smoke`
should be run during a soak window so the Node-ABI rebuild doesn't
interfere with the running Electron dashboard.

---

## 8 · Recommended follow-ups

| Priority | Item | Why |
|---|---|---|
| P0 | Live-fleet field test — re-export the Energy Summary spreadsheet | Verify the HW-counter hardening on the same gateway that produced the empty screenshot |
| P0 | `npm run smoke` during soak window | Confirm Node-ABI tests pass before publishing as a release |
| P1 | First successful Send in the field | Validate UNLOCK+WRITE+VERIFY end-to-end against an inverter you don't mind re-stamping |
| P1 | Trigger a fresh alarm and watch the auto-capture audit row | Confirms Slice F end-to-end |
| P2 | Add a unit test for the `_hwDeltasForUnitDay` fallback paths | Today path / yesterday-eod_clean / tomorrow-baseline-anchor — easier to lock down with a Node test than a hardware soak |
| P3 | Update the User Guide PDFs | All Parameters page replaces what the guide currently calls the "Energy" page |

---

## 9 · Files touched (this session)

```
M plans/2026-04-27-ism-daily-data-export-study.md
M public/css/style.css
M public/index.html
M public/js/app.js
M server/alarms.js
M server/db.js
M server/exporter.js
M server/index.js
M server/poller.js
M services/inverter_engine.py

?? plans/2026-04-27-all-parameters-data-page.md
?? plans/2026-04-27-stop-reasons-best-approach.md
?? plans/2026-04-27-stop-reasons-table-and-serial-number-setting.md
?? release-notes-v293.md
?? server/alarmsDiagnostic.js
?? server/dailyAggregator.js
?? server/motiveLabels.js
?? server/serialNumber.js
?? server/stopReasons.js
?? services/serial_io.py
?? services/stop_reason.py
?? services/tests/test_serial_io.py
?? services/tests/test_stop_reason_parse.py
?? services/tests/test_vendor_pdu.py
?? services/vendor_pdu.py
```

Net delta on tracked files: ~`+4.7k / -700` lines.
