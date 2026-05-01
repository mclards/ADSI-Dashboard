# Audit 2026-04-24 — Alarm Handlers Deep Verification + Refactor

Date: 2026-04-24
Status: IMPLEMENTED (pending Electron smoke on a rebuilt tree)
Trigger: operator request — "deep verify and evaluate the alarms handlers. refactor it. and give me audit."
Owner: Engr. Clariden Montaño REE

## Scope

Every code path that classifies, persists, broadcasts, queries, or exports an
alarm for the POWER MAX 920TL fleet. No changes to the 16-bit alarm bitfield
spec itself (`AAV2015IQE01_B §19.2-19.4`), the service-doc integration shipped
in v2.8.13, or the frontend toast-dedup logic.

| Layer | File | Role |
|---|---|---|
| Transition classifier (pure) | `server/alarmEpisodeCore.js` | `classifyAlarmTransition(prev, next)` → `noop` / `raise` / `clear` / `update_active` |
| Bitfield + decode + HTTP | `server/alarms.js` | `decodeAlarm`, `getTopSeverity`, `formatAlarmHex`, `checkAlarms`, `getActiveAlarms`, `logControlAction`, `getAuditLog` |
| Storage + prepared stmts | `server/db.js` | `alarms` DDL, `stmts.insertAlarm` / `updateActiveAlarm` / `clearAlarm` / `ackAlarm` / `ackAllAlarms` / `getActiveAlarmForUnit` / `getAlarmsRange` / `getActiveAlarms` |
| Ingest (gateway) | `server/poller.js` | `checkAlarms(alarmBatch)` at line 1077 |
| Ingest (remote viewer) | `server/index.js` | `syncRemoteBridgeAlarmTransitions(liveData)` at line 1612 |
| HTTP read/ack API | `server/index.js` | `/api/alarms`, `/api/alarms/active`, `/api/alarms/reference`, `/api/alarms/:id/ack`, `/api/alarms/ack-all` |
| CSV/PDF export | `server/exporter.js` | `exportAlarms({startTs,endTs,inverter,format,minAlarmDurationSec})` |
| WS push + UI | `public/js/app.js` | `handleAlarmPush`, `_shouldEmitAlarmToast`, `State.activeAlarms`, drilldown modal |

## Storage model (unchanged)

```
alarms(id PK, ts, inverter, unit, alarm_code, alarm_value, severity,
       cleared_ts NULL, acknowledged, updated_ts)
```

An **episode** = one row from first raise (`INSERT`) to clear (`UPDATE cleared_ts`).
Bits changing mid-episode trigger an `UPDATE` of `alarm_code / alarm_value / severity`
on the still-open row — no new row, no new toast. `updated_ts` is auto-stamped
by triggers `trg_alarms_insert_updated_ts` and `trg_alarms_touch_updated_ts`
for cloud-backup cursor ordering.

## Behaviors verified ✓

| # | Behavior | Location |
|---|---|---|
| B1 | `decodeAlarm(0)` → `[]`; non-zero decodes only set bits with full metadata | `server/alarms.js:297` |
| B2 | `getTopSeverity` ranks critical > fault > warning > info; `null` on zero | `server/alarms.js:295-312` |
| B3 | `formatAlarmHex(0)` → `"0000H"`, `0x1040` → `"1040H"` | `server/alarms.js:314` |
| B4 | `classifyAlarmTransition` guards NaN/negative via `normalizeAlarmValue` | `server/alarmEpisodeCore.js` — unit test passes |
| B5 | Raise → `insertAlarm` + WS `{type:"alarm"}` broadcast | `raiseActiveAlarm` helper |
| B6 | Clear → `clearAlarm` stamps `cleared_ts`; **no** WS toast (viewer reconciles via `/api/alarms/active`) | `server/alarms.js:497-501` |
| B7 | `update_active` → `updateActiveAlarm` patches value/code/severity in place; no new row, no toast | `updateActiveAlarmValue` helper |
| B8 | First batch after restart, DB has open row, `cur!==0` → silent re-attach (patch on drift); no re-toast | `server/alarms.js:451-476` |
| B9 | First batch after restart, DB has open row, `cur===0` → close the row | `server/alarms.js:478-482` |
| B10 | Unconfigured nodes filtered at ingest, read, and hydration layers | `isConfiguredNode` / `getConfiguredNodeSet` |
| B11 | Node removed from `ipConfigJson.units` → in-memory state cleaned on next tick | `server/alarms.js:429-431` |
| B12 | `getActiveAlarms` dedups legacy duplicate open rows by (inv,unit), preferring newer ts/id | `server/alarms.js:390-421` |
| B13 | `ackAllAlarms` acks every unacknowledged row, including cleared ones | `server/db.js:1366` |
| B14 | Alarm export enforces `minAlarmDurationSec` (0..86400) filter server-side + gateway-confirmed | `server/exporter.js:1348`, `server/index.js:16547` |
| B15 | `logControlAction` rejects out-of-range inverter/node via `Number.isFinite`; node=0 encodes "ALL" | `server/alarms.js:559-567` |
| B16 | Audit IP fallback: loopback/empty IPs replaced with configured IP at read time only — DB row untouched | `withAuditIpFallback` |
| B17 | `updated_ts` auto-stamped on INSERT + UPDATE via triggers | `server/db.js:1294-1308` |
| B18 | Frontend toast dedup keyed on `(inv, unit, alarm_id)` over 1.5 s — requires `id` on raise payload (see F2) | `public/js/app.js:12449-12468` |

## Findings and disposition

| # | Finding | Disposition |
|---|---|---|
| F1 | `hydrateActiveAlarmStateFromDb` picks the OLDEST open row per (inv,unit) when legacy duplicates exist — `ORDER BY ts DESC` iterated, map key overwritten on each pass, final state = oldest value. Next batch misclassifies transition as `update_active` and cascade-updates stale rows. | **Fixed** — `server/alarms.js:330-354` |
| F2 | First-batch raise WS payload missing `id` and `ts` — `"Acknowledge"` button hit `POST /api/alarms/0/ack` → 400. Toast dedup collapsed to `${inv}_${unit}_0`; toast ts fell back to render-time. | **Fixed** — `raiseActiveAlarm` helper now guarantees identical payload from both raise branches; `server/alarms.js:423-445` |
| F3 | `syncRemoteBridgeAlarmTransitions` duplicated transition logic inline instead of calling the shared classifier; no clear-silencing guarantee, no `ts` field on WS payload. | **Fixed** — now calls `classifyAlarmTransition`, keeps only `raise` + `update_active`, attaches `ts`; `server/index.js:1612-1648` |
| F4 | `getConfiguredNodeSet` hardcoded `inv = 1..27` / `unit = 1..4`, ignoring `inverterCount` + `nodeCount` settings. Fleet-size-mismatch hazard (no observed impact on 27-unit fleet). | **Fixed** — now reads both settings via `getSetting(...)`; `server/alarms.js:352-388` |
| F5 | Legacy duplicate open rows from pre-v2.8.x restart race inflated per-inverter `alarm_count` aggregates and distorted export duration math. Runtime dedup in `getActiveAlarms` hid the symptom at the UI but not at the aggregate/export layers. | **Fixed** — one-time idempotent consolidation migration closes all but the newest open row per (inv,unit) and stamps `updated_ts` explicitly (the migration runs before `trg_alarms_touch_updated_ts` is created, so the cursor-based cloud replication would not pull the consolidation to viewers otherwise); runtime dedup retained as defense-in-depth; `server/db.js:1295-1331` |
| F6 | No index covered `(cleared_ts, inverter, unit)` — `stmts.getActiveAlarmForUnit` fell back to `idx_a_inv_ts(inverter, ts)` + filter. Imperceptible today (small table after retention pruning); grew with alarms-per-inverter. | **Fixed** — added `idx_a_open_inv_unit ON alarms(inverter, unit, cleared_ts)`; `server/db.js:1248-1253` |

## Why UNIQUE partial index was NOT added

A `CREATE UNIQUE INDEX ... ON alarms(inverter, unit) WHERE cleared_ts IS NULL`
would structurally prevent F1/F5 but would break alarms replication on viewers.

- Gateway merge (`server/index.js:2859-2868`) uses `ON CONFLICT(id)` only.
- Pull order on viewer could in edge cases deliver a new-raise row before the
  prior clear-row's UPDATE, producing a `UNIQUE constraint failed` at merge
  and stalling the pull cycle.

The consolidation migration (F5) + hydration fix (F1) + `checkAlarms` `existing`
guard together prevent any new duplicates on the gateway side, where all writes
originate. Runtime dedup in `getActiveAlarms` covers the pathological replication
case. Adding the UNIQUE constraint requires extending the replication merge
with `ON CONFLICT(inverter, unit) WHERE cleared_ts IS NULL` handling — tracked
as a separate replication-aware hardening task, not shipped here.

## Change summary

| File | Before → After | Lines |
|---|---|---|
| `server/alarms.js` | hardcoded inv range; 2 duplicated raise branches; missing id/ts in first-batch raise; hydration overwrites map | +60 / −55 |
| `server/db.js` | no consolidation of legacy dupes; no covering index for per-unit active lookup | +36 / −0 |
| `server/index.js` | remote bridge hand-rolled transition check | +9 / −1 |

Total: 3 files, ~105 insertions, ~56 deletions.

## Public contract — unchanged

Nothing in this patch changes any externally observable contract:

- `ALARM_BITS`, `STOP_REASONS`, `STOP_REASON_SUBCODES`, `SERVICE_DOCS`,
  `SERVICE_DOCS_GITHUB_BASE`, `FATAL_ALARM_VALUE` — byte-identical.
- `decodeAlarm`, `getTopSeverity`, `formatAlarmHex` — signatures and return
  shapes unchanged.
- HTTP response schemas for `/api/alarms`, `/api/alarms/active`,
  `/api/alarms/reference`, `/api/alarms/:id/ack`, `/api/alarms/ack-all`,
  `/api/audit` — unchanged.
- WS `{type:"alarm", alarms:[...]}` — payload is now strictly **more**
  consistent (every raise carries `id` and `ts`); no field was removed.
- SQLite schema for `alarms` — unchanged (new INDEX only; no new columns).

## Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| F5 migration closes a row that should have stayed open | Very low | Only rows with `rn > 1` per (inv,unit) are closed; the newest row (by `ts`, tie-broken by `id`) is always kept open. Idempotent — re-running emits zero changes. |
| F5 migration changes episode duration for consolidated rows | Low | The losers get `cleared_ts = now`, so their duration reflects migration time. Acceptable — the losers were open forever under the bug, so any bound is an improvement. Only affects historical CSV exports that include cleared alarms. |
| F6 index regresses INSERT/UPDATE throughput | Very low | One extra B-tree maintenance on a low-write-volume table (a handful of ops per minute at most). No observable latency impact expected. |
| Unified remote bridge classifier misses a toast that the inline code would have shown | Very low | `classifyAlarmTransition` is strictly more inclusive — it surfaces `raise` AND `update_active`; the inline code covered the same two cases (coalesced under `alarmValue !== prevAlarmValue && alarmValue !== 0`). |
| UNIQUE partial index is added later without updating the replication merge | Medium if forgotten | Documented in §"Why UNIQUE partial index was NOT added" and in `audits/2026-04-24/alarm-handlers-audit.md` §Follow-up; added to the repo memory as a tracked item. |
| `getConfiguredNodeSet` now excludes inv >= inverterCount and unit > nodeCount | Very low | Matches what every other helper in the codebase already does; if anything this **removes** a latent bug for sub-27-inverter deployments. |

## Smoke sequence (pending)

1. `npm run smoke:no-rebuild` — Node-ABI checks (includes `alarmEpisodeCore.test.js`, which still passes under these edits).
2. `npm run rebuild:native:electron` — per `feedback_native_rebuild.md`, restore Electron ABI.
3. Cold-boot check: on first launch with existing duplicate open rows, `[db]` log should print `Consolidated N legacy duplicate open alarm row(s)` if any existed. On a clean DB, no log line.
4. Manual UI smoke:
   - Alarm raises a new alarm → toast appears with hex code + description → clicking the hex opens the drilldown → "Acknowledge" button succeeds (not 400).
   - Alarm `update_active` (bit mask change mid-episode) → hex code updates in-place in the active-alarms table; no new toast.
   - Alarm clears → active-alarms table drops the row within one refresh cycle; no toast.
   - Server restart while an alarm is active → no duplicate row inserted, no duplicate toast, active-alarms count unchanged.
   - Remote viewer: same checks against a live gateway; all three transitions should produce correct UI state.
5. `EXPLAIN QUERY PLAN SELECT id FROM alarms WHERE cleared_ts IS NULL AND inverter=1 AND unit=1` — expect `USING INDEX idx_a_open_inv_unit`.

## Follow-ups (out of scope for this audit)

1. **Integration test** — DB-backed test (temp `DATA_DIR`) exercising `checkAlarms` through all four transitions + restart hydration + F5 migration. Current `alarmEpisodeCore.test.js` covers only the pure classifier.
2. **Replication-aware UNIQUE index** — combine a `UNIQUE(inverter, unit) WHERE cleared_ts IS NULL` partial index with extended `ON CONFLICT` handling in `server/index.js:2859-2868` alarms merge. Would let the runtime dedup in `getActiveAlarms` be removed.
3. **Optional: remove runtime dedup** — after Follow-up #2 ships, the N² scan in `getActiveAlarms` becomes pure dead weight.

## Cross-references

- Code (this audit):
  - `d:\ADSI-Dashboard\server\alarms.js` — F1, F2, F3 refactor, F4 fix
  - `d:\ADSI-Dashboard\server\db.js` — F5 consolidation migration, F6 covering index
  - `d:\ADSI-Dashboard\server\index.js` — F3 remote bridge unification
- Tests: `d:\ADSI-Dashboard\server\tests\alarmEpisodeCore.test.js` (unchanged; still PASS)
- Fleet alarm register spec: `AAV2015IQE01_B §19.2-19.4` (in-code citation in `server/alarms.js` header)
- Prior audits touching alarm handlers:
  - `audits/2026-04-14/PHASE5_FIXES.md` — T2.5 hydration-from-DB + `getActiveAlarmForUnit` introduction
  - `audits/2026-04-14/PHASE3_FIXES.md` — T5.6 frontend toast dedup by `alarm_id`
  - `audits/2026-04-14/BUG_SWEEP.md` — original bug inventory that introduced `classifyAlarmTransition`
  - `audits/2026-04-20/v2.8.13-service-docs-integration.md` — alarm metadata enrichment + `/api/alarms/reference` endpoint
- Memory:
  - `C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\feedback_audit_folder_convention.md`
  - `C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\feedback_native_rebuild.md`
