# Inverter Dashboard Project Memory

## Project Overview
Industrial solar power plant monitoring desktop app. Hybrid Electron + Python.
- **Version:** 2.2.23
- **Author:** Engr. Clariden Montaño REE (Engr. M.)
- **Entry point:** electron/main.js
- **Stack:** Electron 29, Express 4, SQLite (better-sqlite3), Chart.js 4, FastAPI (Python), pymodbus

## Architecture
- **Electron main process:** electron/main.js — windows, IPC, license, process management
- **Express server:** server/index.js — REST API + WebSocket on port 3500
- **Frontend:** public/js/app.js — vanilla JS, Chart.js, multi-theme UI
- **Python services:** ADSI_InverterService.py (FastAPI port 9000, Modbus TCP), ADSI_ForecastService.py (ML forecasting)
- **DB:** SQLite at %APPDATA%\Inverter-Dashboard\adsi.db (migrates from ADSI-Dashboard)

## Key File Paths
- electron/main.js — Electron main
- electron/preload.js — Context bridge
- server/index.js — Express server
- server/db.js — SQLite wrapper
- server/poller.js — Inverter polling (500ms interval)
- server/alarms.js — Alarm decoding (Ingeteam INGECON, 16-bit bitfield)
- server/exporter.js — CSV/Excel export (31 KB)
- public/index.html — Main dashboard UI
- public/js/app.js — Frontend logic
- public/css/style.css — Themes (dark/light/classic)
- ADSI_InverterService.py — FastAPI inverter backend
- ADSI_ForecastService.py — Solar forecast engine (physics + ML)
- drivers/modbus_tcp.py — Modbus TCP wrapper
- ipconfig.json — 27 inverters, IPs, polling intervals

## Data Flow
Modbus TCP → FastAPI (9000) → Express (3500) → SQLite → WebSocket → Browser
Weather APIs → Python forecast → /ProgramData JSON → Express → Browser

## Hardware
27 inverters (Ingeteam INGECON), 2-4 units each, Modbus TCP, IP 192.168.1.x range.
Polling interval: 0.05s default per inverter.

## Features
Real-time monitoring, 5-min energy resolution, AI solar forecasting, alarm management, audit log, CSV/Excel export, multi-theme UI, license protection, topology view, IP config UI.

## Build
electron-builder: NSIS installer + portable exe. Output: release/
Extraresources: InverterCoreService.exe, ForecastCoreService.exe (PyInstaller from ADSI_*.py)
Release size: ~228 MB each
- Hard rule: bump `package.json`, visible version text, and the baseline/version notes in `SKILL.md`, `CLAUDE.md`, and `MEMORY.md` together before a release.
- Hard rule: before any EXE build, run the smoke test that matches the changed surface; backend/DB/replication/archive changes require an isolated server smoke test, and Electron/startup changes require a live Electron startup smoke test too.
- Hard rule: push the release commit and release tag before `gh release create`; if GitHub upload/create times out, inspect release state before retrying.
- Hard rule: verify `release/` cleanup instead of assuming it worked; after publish keep only installer, portable exe, blockmap, and `latest.yml`.

## Archive Replication Rule
- Manual archive pull/upload must stage monthly archive `.db` replacements while the app is running and apply them only on restart.
- Never overwrite or rename a live monthly archive DB in place during runtime.
- If a newer archive replacement is staged, archive manifest and archive download should expose that staged version immediately so later sync logic sees the newest content before restart.

## Completed Overhaul (2026-02)
Full 4-phase in-place overhaul completed. Key changes:
- **Security:** AES-256-GCM remembered passwords, random initial passwords, random admin auth key, execFile for taskkill, Electron webSecurity enabled everywhere
- **Context bridge:** Consolidated to single `window.electronAPI` object; all `window.electron.*` references removed
- **server/ws.js:** Dead connection cleanup on send failure
- **server/db.js:** Configurable audit retention (`auditRetainDays` setting)
- **server/poller.js:** Fixed KWH 32-bit overflow (multiplication vs left-shift), MAX_PAC_DT_S raised 5→30
- **server/alarms.js:** Module-level prepared statement for audit inserts, input validation in logControlAction
- **server/exporter.js:** Path traversal guard in resolveExportDir, date bounds checking, filename truncation to 200 chars
- **server/index.js:** Fixed uptime calc, atomic settings update, forecast race lock, timezone regex allows dots
- **public/index.html:** All 31+ inline event handlers removed; IDs added to all buttons; aria-live on metric elements
- **public/js/app.js:** bindEventHandlers() function; wsConnecting guard; DocumentFragment in buildInverterGrid; firstChild.nodeValue for totalPac/totalKwh; all catch(_) replaced with logging; timer refs stored; beforeunload cleanup

## Cloud Backup Feature (2026-03-04)
Full cloud backup/restore feature implemented. Key files:
- server/tokenStore.js — AES-256-GCM encrypted OAuth token storage (machine-derived key)
- server/cloudProviders/onedrive.js — Microsoft Graph API, OAuth PKCE (no client secret needed)
- server/cloudProviders/gdrive.js — Google Drive API v3, installed app OAuth flow
- server/cloudBackup.js — Core backup service (local-first, retry queue, schedule, restore)
- server/index.js — API routes: /api/backup/* (settings, auth, now, history, pull, restore, delete)
- public/index.html — Cloud Backup card in Settings page
- public/js/app.js — cbLoadSettings, cbSaveSettings, cbBackupNow, cbConnectProvider, etc.
- public/css/style.css — Cloud Backup panel styles
- electron/main.js — oauth-start IPC handler (BrowserWindow + webRequest intercept)
- electron/preload.js — openOAuthWindow bridge

OAuth flow: frontend → /api/backup/auth/:provider/start → Electron opens BrowserWindow → intercepts localhost:3500/oauth/callback/:provider → returns callbackUrl → frontend POSTs code to /api/backup/auth/:provider/callback → server exchanges for tokens.

User must register their own OAuth app:
- OneDrive: Azure AD app registration, redirect URI http://localhost:3500/oauth/callback/onedrive, PKCE public client
- Google Drive: GCP project, Desktop app type, redirect URI http://localhost:3500/oauth/callback/gdrive

## MWh Handoff (2026-03-05)
Remote→Gateway mode switch continuity hardened:
- `gatewayHandoffMeta` — in-memory handoff lifecycle: active, startedAt, day, baselines (per-inverter shadow kWh at switch time)
- `MAX_SHADOW_AGE_MS = 4h` — stale same-day shadow discarded unless handoff active
- `getRemoteTodayEnergyShadowRows()` — age check; clears+persists when stale
- `_checkHandoffCompletion(pollerMap, day)` — auto-completes handoff when all baselines met; logs elapsed time
- `getTodayEnergySupplementRows()` — logs carry_applied/caught_up per inverter, calls completion check
- `applyRuntimeMode()` — captures per-inverter baselines on Remote→Gateway switch; logs handoff start
- Test harness: `server/tests/mwhHandoff.test.js` (24 passing: Scenarios A-E, including timeout)
- `server/mwhHandoffCore.js` — shared pure logic imported by tests (created by user)

## Performance Optimization (2026-03-05)
Tab-switch "Not Responding" eliminated. Key changes:
- **server/db.js:** Added `idx_e5_ts ON energy_5min(ts)` for range-scan queries
- **server/index.js (N+1 fix):** `buildDailyReportRowsForDate` now uses 3 batch SQL queries instead of 81 per-inverter queries (27×readings + 27×alarm_count + 27×audit_count → 3 queries): ~15× faster report generation
- **server/index.js (row cap):** `/api/energy/5min` unpaged path and `/api/analytics/energy` capped at 50,000 rows via `ENERGY_5MIN_UNPAGED_ROW_CAP`; returns 400 if exceeded
- **server/index.js (perf headers):** `X-Perf-Ms` header on /api/alarms, /api/audit, /api/energy/5min, /api/report/daily
- **public/js/app.js (stale tab cache):** `State.tabFetchTs{}` + `TAB_STALE_MS=60000`; initAlarmsPage/initEnergyPage/initAuditPage/initReportPage skip re-fetch and re-render from State if data is <60s old; `State.tabFetching{}` in-flight guard
- **public/js/app.js (loading state):** `showTableLoading(tbodyId, colspan)` helper shows "Loading…" row before fetch; called in fetchAlarms/fetchAudit/fetchReport
- **public/js/app.js (DocumentFragment):** renderAlarmTable, renderAuditTable, renderReportTable, renderEnergyTable all now use DocumentFragment + single `tbody.textContent=""` + `appendChild(frag)` instead of per-row `appendChild`

## v2.2.23 Changes — Gateway Main-DB Pull + Hot Transfer Monitor Hardening (2026-03-09)
- **Manual pull now stages the gateway main DB:** `runManualPullSync` reconciles local-newer hot data first, then downloads a fresh gateway `adsi.db` snapshot, stages it locally, and applies it on restart instead of mutating the live remote DB table by table.
- **Gateway DB snapshot stays consistent while the server is running:** the gateway flushes pending poller telemetry and exports the main DB through SQLite's online backup API before streaming it, so the pulled file is a transactionally consistent snapshot rather than a direct copy of the live `adsi.db`.
- **Remote-only settings are restored after DB takeover:** after restart, the staged gateway DB becomes the local DB, then the client's local-only remote settings (`operationMode`, `remoteAutoSync`, gateway URL/token, tailnet hint/interface, `csvSavePath`) are restored.
- **Transfer Monitor now covers hot-data DB transfer clearly:** main-DB pull/send emits byte-based `xfer_progress`, and inbound hot-data push RX now includes total bytes so the monitor can show proper percentage instead of only indeterminate progress.
- **Manual push final consistency now uses the gateway main DB too:** after sending local hot data to the gateway, the client stages the final gateway `adsi.db` back locally for restart-safe consistency.

## v2.2.22 Changes — Restart-Safe Archive Apply (2026-03-09)
- **Archive staging instead of live swap:** manual archive pull/upload now keeps the current monthly `.db` live while the app is running, stages the downloaded/uploaded replacement in `archive/*.tmp`, and applies it only on the next restart.
- **Restart apply path:** startup now applies pending staged archive replacements before the server begins serving requests, so the newer archive file becomes active immediately after restart without the Windows `EPERM` rename race.
- **Manifest/transfer consistency:** archive manifest and archive download now surface the staged replacement immediately, so follow-up sync decisions and archive transfers see the newest content even before restart.

## v2.2.21 Changes — Authoritative Pull/Push Hardening + Transfer Monitor Polish (2026-03-09)
- **Authoritative merge:** `mergeAppendReplicationRow` and `mergeUpdatedReplicationRow` now accept `authoritative` flag; in auth mode, LWW `WHERE COALESCE(excluded.updated_ts,0) >= ...` guards are removed for all tables (`readings`, `energy_5min`, `settings`, `forecast_dayahead`, `forecast_intraday_adjusted`, `daily_report`, `daily_readings_summary`, `alarms`). Separate `stmtCached` keys used (e.g. `"merge:daily_report:auth"`) to avoid poisoning LWW cache entries. `audit_log` stays append-only. `REMOTE_REPLICATION_PRESERVE_SETTING_KEYS` always wins even in auth mode.
- **Reconcile-before-pull:** `runManualPullSync` now runs a reconcile step (Step 0) before the authoritative pull — pushes local-newer data to gateway first; if reconcile push fails and local is newer, throws `LOCAL_NEWER_PUSH_FAILED` (code) with `canForcePull: true`; accepts `forcePull` param to skip reconcile gate.
- **`LOCAL_NEWER_PUSH_FAILED` background gap fix:** `startManualReplicationJob` catch block now stores `errorCode: String(err?.code || "")` in failed job. `handleReplicationJobUpdate` detects `job.errorCode === "LOCAL_NEWER_PUSH_FAILED" && job.action === "pull"` and shows "Force Pull?" confirm dialog instead of plain error.
- **xfer_progress labels:** `pushDeltaInChunks`, `runRemoteIncrementalReplication`, `runRemoteCatchUpReplication` accept `opts.label`; all manual pull/push/reconcile/archive call sites pass descriptive labels ("Reconciling with gateway", "Applying gateway data", "Pushing local data", "Pulling final gateway state", "Downloading/Uploading archive files").
- **Transfer Monitor phase badge:** `#xferPhaseBadge` span added to `.xfer-panel-row` in `index.html`. `getXferPhaseBadge(x)` helper maps label+phase to badge text/class. Seven CSS classes: `xfer-phase-pull/push/reconcile/applying/archive/done/error`.
- **Pull/push confirm dialogs:** Updated to explicitly state gateway-overwrites-local semantics and list preserved local-only settings.
- **`/api/replication/pull-now`:** Destructures `forcePull` from body; passes to `runManualPullSync`; sync path returns HTTP 409 with `code:"LOCAL_NEWER_PUSH_FAILED"` on reconcile failure.
- **Startup auto-sync and live bridge polling keep LWW** (`authoritative: false`); only manual pull is authoritative.
- **Manual pull is now staged main-DB replace:** `runManualPullSync` reconciles local-newer hot data first, then downloads a transactionally consistent gateway `adsi.db` snapshot through `/api/replication/main-db`, stages it locally, and applies it on restart. The live remote DB stays unchanged until restart. Only the client-local remote settings (`operationMode`, `remoteAutoSync`, gateway URL/token, tailnet hint/interface, `csvSavePath`) are restored after the gateway DB takes over.
- **Gateway main DB export is snapshot-based:** the server flushes pending poller telemetry, creates a consistent SQLite snapshot with `db.backup(...)`, and streams that snapshot file. It does not stream the live `adsi.db` file directly while the gateway is running.

## v2.2.16 Changes (2026-03-08)
- **Operator messaging panel:** `chat_messages` table on gateway (500-row retention); 3 API routes `/api/chat/send|messages|read`; remote proxy + 5 s poll loop; floating `#chatBubble` + slide-in `#chatPanel`; `appConfirm`-style UX; `playChatSound()` via shared `getOrCreateAlarmAudioCtx()`; `markChatRead` in-flight guard + pending queue; alarm bell left / chat bubble right — no overlap
- **`renderChatThread` DocumentFragment:** converted to match `renderAlarmTable` / `renderReportTable` pattern

## v2.2.15 Changes (2026-03-08)
- **Availability fix:** `/api/report/daily` range handler now splices live `getDailyReportRowsForDay(today, { includeTodayPartial: true })` when today is in range — fixes stale persisted value
- **Detail panel refresh:** 60 s timer fetches both `/api/energy/today` (kWh) and `/api/report/daily?date=today` (availability); merges fresh today rows into `State.invDetailReportRows`
- **PAC thresholds:** ≥90% High, >70% Moderate, >40% Mild, ≤40% Low; `NODE_RATED_W = 249,250 W`; `.row-pac-high/mid/low/off` CSS classes
- **PAC legend:** Static `.pac-legend-wrap` in inverter toolbar; `|` separators via CSS `::before`; High/Moderate/Mild/Low/Alarm hierarchy
- **Startup tab prefetch:** `prefetchAllTabs()` fires 2 s after `init()`, pre-warms all 4 tabs; `TAB_STALE_MS` = 60 s
- **App confirm modal:** `appConfirm(title, body, {ok, cancel})` → Promise<bool>; `#appConfirmModal` in HTML, `.confirm-dialog` in CSS, `initConfirmModal()` called from `init()`; all 9 `confirm()` + 5 `alert()` calls in app.js replaced

## Notes
- See detailed-review.md for first project review findings
