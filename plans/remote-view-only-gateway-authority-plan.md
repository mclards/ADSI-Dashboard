# Remote View-Only Gateway Authority Plan

## Summary

Redefine `remote` mode from a replicated working copy to a gateway-backed viewer with write-through inverter control.

**Before:** Remote mirrors gateway telemetry into its local DB, runs startup auto-sync, supports push/pull/reconciliation, generates exports from local data, and can fall back to local DB when the gateway is unavailable.

**After:** Remote displays live gateway data in memory only, proxies all historical reads and exports through the gateway, keeps manual Pull as a standby DB refresh for later gateway-mode use, and retains inverter on/off control via gateway proxy.

## Operating Rules

| # | Rule |
|---|------|
| 1 | `remote` is a viewer, not a replicated working copy |
| 2 | The local DB on a remote machine is standby-only (used after switching to `gateway`) |
| 3 | Manual `Pull` is the only mechanism that refreshes the remote local DB |
| 4 | Manual `Push`, reconciliation, and startup auto-sync are removed |
| 5 | Remote exports are gateway-sourced downloads saved to the local filesystem |
| 6 | Remote inverter on/off control stays enabled via gateway proxy |
| 7 | Day-ahead and intraday-adjusted forecasting run only in `gateway` mode |
| 8 | Solcast toolkit remains local and unchanged |
| 9 | Cloud/local backup remains local-first and unchanged |

## Current Code Inventory

All references are in `server/index.js` unless noted otherwise.

### Must remove: live DB mirroring

| Function | Line | What it does |
|----------|------|-------------|
| `persistRemoteLiveRows()` | ~1198 | Inserts gateway live readings into local `readings` table, runs `bulkInsert()` + `ingestDailyReadingsSummary()` + `checkAlarms()` with smart cadence thresholds |
| `mirrorRemoteTodayEnergyRowsToLocal()` | ~1257 | Mirrors gateway today-energy into local `energy_5min` buckets with day-rollover and regression detection |
| `pollRemoteLiveOnce()` | ~4382 | Calls both of the above after each successful `/api/live` fetch from gateway |

These three functions are the core conflict with the viewer-only model. Removing the calls to `persistRemoteLiveRows()` and `mirrorRemoteTodayEnergyRowsToLocal()` from `pollRemoteLiveOnce()` is the primary change.

### Must remove: startup auto-sync and incremental replication

| Function | Line | What it does |
|----------|------|-------------|
| `runRemoteStartupAutoSync()` | ~4322 | On startup, checks local-newer state, then runs incremental + catch-up replication in up to 8 passes of 200 batches each |
| `runRemoteIncrementalReplication()` | ~2644 | Cursor-based incremental delta pull from gateway into local DB |
| `runRemoteCatchUpReplication()` | ~2705 | Batch catch-up replication for large gaps |

These maintain the replicated-client model and must be removed or disabled in `remote` mode.

### Must remove: push and reconciliation

| Function | Line | What it does |
|----------|------|-------------|
| `runManualPushSync()` | ~2881 | Upload-only push of local hot-data delta + optional archive files to gateway |
| `/api/replication/push-now` | route handler | Triggers `runManualPushSync()` |

Push is upload-only since v2.2.21 but is no longer needed under the viewer model.

### Must simplify: manual pull

| Function | Line | What it does |
|----------|------|-------------|
| `runManualPullSync()` | ~2803 | Downloads gateway main DB snapshot + optional archive files; stages for restart-safe replacement |
| `/api/replication/pull-now` | route handler | Triggers `runManualPullSync()` with optional `forcePull` |

Pull is already download-only since v2.2.21. Simplification needed:
- Remove the `LOCAL_NEWER_PUSH_FAILED` pre-check (no longer meaningful when push doesn't exist)
- Remove `Force Pull` confirmation flow (pull always overwrites standby data)
- Remove replication cursor persistence after pull (cursors only matter for incremental sync, which is being removed)

### Must change: export proxy exclusion

| Code | Line | What it does |
|------|------|-------------|
| `shouldProxyApiPath()` | ~925 | Excludes `/export/*` from remote proxy — forces local generation |

Export routes (lines ~10657–10742):
- `/api/export/alarms`, `/api/export/energy`, `/api/export/inverter-data`
- `/api/export/5min`, `/api/export/audit`, `/api/export/daily-report`
- `/api/export/forecast-actual`

All currently call local `exporter.js` functions directly. Must be changed to proxy to gateway, download the generated file, and save locally.

Exception: `/api/export/solcast-preview` (~10280) stays local since Solcast is local.

### Must change: local history fallback

| Code | Line | What it does |
|------|------|-------------|
| `shouldServeLocalFallback()` | near `shouldProxyApiPath()` | Allows local DB reads when gateway is unavailable |
| Catch-all proxy middleware | ~9770 | Falls through to local route handlers on proxy failure |

Under the new model, historical reads (reports, energy history, analytics, alarms history, audit history) must return a gateway-unavailable error instead of silently serving stale local data.

Live in-memory snapshot retention (`remoteBridgeState.liveData`, `remoteBridgeState.todayEnergyRows`) stays unchanged for real-time card display.

### Must harden: forecast generation guards

| Code | Location | Current state |
|------|----------|--------------|
| `/api/forecast/generate` | ~10360 | Returns 403 when `isRemoteMode()` — already correct |
| `startForecastProcess()` | `electron/main.js` ~2176 | Spawns `ForecastCoreService.exe` on startup regardless of mode |
| Python forecast scheduler | `services/forecast_engine.py` | Runs scheduled day-ahead and intraday-adjusted generation regardless of mode |

API guard exists but Electron and Python layers have no mode check. Both must skip forecast generation work in `remote` mode.

### Already correct: inverter write control

| Code | Line | What it does |
|------|------|-------------|
| `/api/write` | ~9215 | When `isRemoteMode()`, proxies to gateway via `proxyToRemote()` |

No changes needed. This path must be explicitly preserved.

### Already correct: proxy infrastructure

| Code | Line | What it does |
|------|------|-------------|
| `proxyToRemote()` | ~4130 | Forwards requests to gateway `/api` endpoint with auth token |
| Catch-all proxy middleware | ~9770 | Routes non-excluded `/api` paths through `proxyToRemote()` |

This is the correct foundation. The change is expanding what gets proxied (exports, removing local fallback for history).

### Impact area: MWh handoff

| Code | Location | What it does |
|------|----------|-------------|
| `gatewayHandoffMeta` | `server/index.js` | Tracks per-inverter energy baselines during remote→gateway mode switch |
| `getRemoteTodayEnergyShadowRows()` | `server/index.js` | Returns cached shadow kWh rows with staleness check |
| `getTodayEnergySupplementRows()` | `server/index.js` | Supplements today energy with carried-over remote values during handoff |

Currently, handoff relies on remote-side mirrored energy data to bridge the transition. With DB mirroring removed, the handoff must use the last in-memory `remoteBridgeState.todayEnergyRows` snapshot instead. This is a design risk: if the remote machine restarts before completing a mode switch, in-memory data is lost and no local DB fallback exists. The operator must Pull before switching, or accept a gap in today's energy continuity.

## Scope

### Files that must change

| File | Changes |
|------|---------|
| `server/index.js` | Remove live DB mirroring calls, remove startup auto-sync, remove push/reconcile flows, simplify pull, proxy exports, remove local history fallback, adjust handoff logic |
| `server/exporter.js` | No changes (stays as gateway-side generator) |
| `public/js/app.js` | Remove Push button, remove reconciliation UI, update Settings panel, add mode-switch warning, update wording |
| `public/index.html` | Remove push/reconcile HTML elements, simplify replication panel |
| `public/css/style.css` | Remove dead replication-related styles |
| `electron/main.js` | Add mode guard to skip forecast process spawn in `remote` |
| `services/forecast_engine.py` | Add mode guard to skip scheduled generation in `remote` |
| `CLAUDE.md` | Update Operating Modes section |
| `SKILL.md` | Update replication/sync rules |

### Files that do not change

| File | Reason |
|------|--------|
| `server/db.js` | No schema or query changes needed |
| `server/poller.js` | Gateway-mode polling unchanged |
| `server/cloudBackup.js` | Backup unchanged |
| `server/tokenStore.js` | Backup auth unchanged |
| Solcast-related code | Stays local |

## Implementation Phases

### Phase 1: Stop remote live DB mirroring

**Goal:** Remote live polling keeps only in-memory state; local DB stops growing.

**Changes in `server/index.js`:**
1. In `pollRemoteLiveOnce()` (~4382): remove the calls to `persistRemoteLiveRows()` and `mirrorRemoteTodayEnergyRowsToLocal()`
2. Keep: `remoteBridgeState.liveData`, `remoteBridgeState.todayEnergyRows`, WebSocket broadcasts, health classification, bounded stale snapshot retention, ETag conditional requests, adaptive polling

**Verify after:**
- Dashboard cards still show live gateway values
- Gateway outages still use bounded stale in-memory snapshots
- Local DB size does not grow during remote operation
- No `readings`, `energy_5min`, or `daily_readings_summary` rows are inserted from stream

### Phase 2: Remove push, reconciliation, and startup auto-sync

**Goal:** Remote mode has no outbound data flows and no automatic DB imports.

**Remove or disable:**
1. `runManualPushSync()` (~2881) — disable the function body, return `{ error: "Push is disabled in viewer mode" }`
2. `/api/replication/push-now` route — return 410 Gone
3. `runRemoteStartupAutoSync()` (~4322) — skip entirely when `isRemoteMode()`
4. `runRemoteIncrementalReplication()` (~2644) — no longer called from any remote path
5. `runRemoteCatchUpReplication()` (~2705) — no longer called from any remote path

**UI changes:**
- Remove Push button from Settings panel
- Remove reconciliation status fields (rows sent, last reconciliation stats, state signature, sync markers)
- Remove sync-direction display

**Verify after:**
- `/api/replication/push-now` returns 410
- App startup in remote mode does not import any data
- No `lastSyncDirection` updates occur except for pull

### Phase 3: Simplify manual pull to standby DB refresh

**Goal:** Pull is a clean gateway-DB download with no reconciliation semantics.

**Changes in `runManualPullSync()` (~2803):**
1. Remove `checkLocalNewerBeforePull()` pre-check — pull always overwrites standby data
2. Remove `LOCAL_NEWER_PUSH_FAILED` error code handling — no push exists to fail
3. Remove `Force Pull` confirmation flow — all pulls are unconditional
4. Remove replication cursor persistence after pull — cursors are no longer used
5. Keep: main DB snapshot download, archive file download, restart-safe staging, socket pool boost

**UI changes:**
- Pull button label: "Refresh Standby DB" or keep "Pull" with updated tooltip
- Remove Force Pull button/flow
- Update pull confirmation dialog to say: "Download the gateway database for local standby use. Requires restart to apply."

**Verify after:**
- Pull downloads and stages the gateway DB
- No pre-check blocks the pull
- Restart applies the staged DB
- After switching to `gateway`, the pulled DB is used as the active DB

### Phase 4: Remove local history fallback for remote reads

**Goal:** Historical views in remote mode always come from the gateway; gateway unavailability is surfaced honestly.

**Changes in `server/index.js`:**
1. In `shouldServeLocalFallback()`: return `false` for all historical read paths when `isRemoteMode()` (reports, energy history, analytics, alarms history, audit history)
2. In the catch-all proxy middleware (~9770): when proxy fails for a historical read in remote mode, return 502/503 with `{ error: "Gateway unavailable" }` instead of falling through to local handlers

**Keep unchanged:**
- Live in-memory snapshot retention for real-time cards (`remoteBridgeState`)
- Local Solcast data reads (Solcast is local)
- Local settings reads (settings are always local)

**Verify after:**
- Reports page in remote mode shows gateway data
- When gateway is down, historical pages show "Gateway unavailable" error
- Real-time cards still show stale in-memory data during brief outages

### Phase 5: Proxy remote exports through the gateway

**Goal:** Remote exports use gateway data; files are saved locally for the existing folder-open UX.

**Changes in `server/index.js`:**
1. In `shouldProxyApiPath()` (~925): remove `/export/*` from the exclusion list (except `/export/solcast-preview`)
2. For each export route (~10657–10742), add remote-mode handling:
   - Proxy the export request to the gateway
   - Receive the generated file bytes from the gateway response
   - Save to local `csvSavePath` with the same file naming conventions
   - Return the local file path in the response

**Export routes to proxy (7 total):**
- `/api/export/alarms` (~10657)
- `/api/export/energy` (~10665)
- `/api/export/inverter-data` (~10680)
- `/api/export/5min` (~10688)
- `/api/export/audit` (~10696)
- `/api/export/daily-report` (~10704)
- `/api/export/forecast-actual` (~10742)

**Keep local:** `/api/export/solcast-preview` (~10280)

**Verify after:**
- Each export type produces a file with gateway-sourced content
- Files are saved to the local export directory
- "Open folder" UX still works after export
- File naming conventions are unchanged

### Phase 6: Enforce gateway-only forecasting in all runtime layers

**Goal:** No forecast generation work runs in `remote` mode at any layer.

**Changes:**
1. **`electron/main.js` (~2176):** In `startForecastProcess()`, check mode before spawning. If `remote`, do not spawn `ForecastCoreService.exe` (or spawn it but pass a flag that disables scheduled generation)
2. **`services/forecast_engine.py`:** Add a mode check at the top of the scheduling loop. If the app is in `remote` mode, skip day-ahead and intraday-adjusted generation entirely
3. **`/api/forecast/generate` (~10360):** Already returns 403 in remote mode — keep as-is

**Design choice:** Option A is to not spawn the forecast process at all in remote mode (cleanest). Option B is to spawn it but have it idle. Option A is preferred unless Solcast preview depends on the forecast process being alive.

**Verify after:**
- Forecast process does not run (or runs idle) in remote mode
- No day-ahead or intraday-adjusted rows are generated locally
- Switching to gateway mode restarts the forecast process normally

### Phase 7: Simplify Settings panel and update UI wording

**Goal:** Settings panel reflects the viewer model; no replication-era terminology.

**Remove from UI:**
- Push button
- Reconciliation wording and status fields
- Rows sent / last reconciliation stats
- State signature display
- Sync markers / convergence fields
- "Sync direction" semantics

**Replace with:**
- Gateway link status (connected/degraded/stale/disconnected/auth-error/config-error)
- Last standby DB pull timestamp
- Archive pull scope
- Export download status
- Remote write-control availability indicator

**Update wording throughout:**
- Remove: "reconciliation", "sync convergence", "cursors", "rows sent", "push/pull symmetry"
- Use: "gateway live link", "standby DB refresh", "gateway-backed export", "write-through control"

### Phase 8: Handle remote→gateway mode switch

**Goal:** Operator understands the local DB is stale when switching from remote to gateway.

**Add mode-switch warning:**
When saving settings with mode change from `remote` to `gateway`, show `appConfirm()` dialog:
> "Remote mode does not keep the local database current. Run Pull first if you need fresh local history before switching to Gateway mode."

**MWh handoff adjustment:**
- `gatewayHandoffMeta` must use last in-memory `remoteBridgeState.todayEnergyRows` as baseline instead of local DB shadow rows
- Document that if the app restarts mid-handoff, in-memory data is lost and today's energy may have a gap
- Recommend: Pull before switching modes to minimize discontinuity

### Phase 9: Dead code cleanup

**Goal:** Remove code that no longer has operational meaning.

**Remove after Phases 1–8 are stable:**
- `persistRemoteLiveRows()` function body (~1198)
- `mirrorRemoteTodayEnergyRowsToLocal()` function body (~1257)
- `runRemoteStartupAutoSync()` function body (~4322)
- `runRemoteIncrementalReplication()` if no longer called (~2644)
- `runRemoteCatchUpReplication()` if no longer called (~2705)
- `runManualPushSync()` function body (~2881)
- Replication cursor state in `remoteBridgeState`
- Row-count counters and signature tracking for push/reconcile
- Dead archive upload code paths from remote to gateway
- Dead CSS classes for removed UI elements

**Do this last** so rollback to the old model remains possible during early phases.

## Rollout Order

| Step | Phase | Risk | Rollback |
|------|-------|------|----------|
| 1 | Phase 7 (partial): Update UI wording and docs | Low | Revert text |
| 2 | Phase 1: Stop live DB mirroring | Medium | Re-enable two function calls |
| 3 | Phase 2: Remove push/reconcile/startup sync | Medium | Re-enable functions |
| 4 | Phase 3: Simplify pull | Low | Restore pre-check |
| 5 | Phase 4: Remove local history fallback | Medium | Restore fallback |
| 6 | Phase 5: Proxy exports | Medium | Restore local export |
| 7 | Phase 6: Forecast guards | Low | Remove mode checks |
| 8 | Phase 7 (full) + Phase 8: Settings panel + mode switch | Low | Revert UI |
| 9 | Phase 9: Dead code cleanup | Low | N/A (code is already disabled) |

Architecture changes land early (steps 2–3) so the new model is visible. Destructive code removal (step 9) happens last.

## Acceptance Criteria

1. Remote dashboard shows live gateway data without inserting into local DB tables
2. No startup auto-sync, push, or reconciliation occurs in remote mode
3. Manual Pull downloads and stages the gateway DB unconditionally (no pre-check, no cursor sync)
4. Historical pages (reports, energy, analytics, alarms, audit) serve gateway data; gateway-down shows error, not stale local data
5. All 7 export types proxy through gateway; files save locally with existing naming/folder UX
6. Inverter on/off control works in remote mode via `/api/write` gateway proxy
7. No forecast generation (day-ahead or intraday-adjusted) runs in remote mode at any layer
8. Solcast toolkit works unchanged
9. Backup works unchanged
10. Mode switch from remote to gateway warns about stale local DB
