# Inverter Dashboard Project Memory

## Project Overview
Industrial solar power plant monitoring desktop app. Hybrid Electron + Python.
- **Repo/package version baseline:** 2.3.13
- **Operator-noted deployed server-side app version:** 2.2.32
- **Author:** Engr. Clariden Montaño REE (Engr. M.)
- **Entry point:** electron/main.js
- **Stack:** Electron 29, Express 4, SQLite (better-sqlite3), Chart.js 4, FastAPI (Python), pymodbus
- **Version source-of-truth rule:** `package.json` is the repo version source of truth; hardcoded footer/about strings may lag and must not be trusted blindly.

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
- `better-sqlite3` is runtime-ABI specific:
  - `npm run rebuild:native:node` for plain Node shell checks
  - `npm run rebuild:native:electron` before Electron launch/build after any Node-ABI rebuild
- Some shells in this workspace export `ELECTRON_RUN_AS_NODE=1`.
  - Direct `electron.exe ...` launches and Playwright/Electron probes will act like plain Node unless that env var is removed.
  - This can surface misleading launch errors like `Unable to find Electron app ...`.
  - Clear the env var or use `start-electron.js`-style launch semantics for Electron UI work.
- Live Electron UI smoke:
  - `npx playwright test server/tests/electronUiSmoke.spec.js --reporter=line`
  - Covers dashboard metrics, Energy Summary Export single-date UI, and Settings connectivity rendering in the real Electron window.
- Inverter detail panel rule:
  - Do not block initial detail stats/alarms on the 7-day `/api/report/daily` history fetch.
  - Recent history is best-effort and should use a bounded timeout.

## Archive Replication Rule
- Manual archive pull/upload must stage monthly archive `.db` replacements while the app is running and apply them only on restart.
- Never overwrite or rename a live monthly archive DB in place during runtime.
- If a newer archive replacement is staged, archive manifest and archive download should expose that staged version immediately so later sync logic sees the newest content before restart.

## Replication Transport Rule
- Keep remote replication fast by default: reuse HTTP connections, gzip large replication JSON payloads, and gzip large main-DB / archive downloads when the peer accepts it.
- Keep hot-data push uploads chunked; large JSON push batches may be gzip-compressed in transit.
- Archive pull/push may run with small bounded concurrency, but restart-safe staging and deterministic failure handling still take priority over raw throughput.
- Transfer-monitor semantics must remain accurate after transport changes. Byte progress and phase reporting are part of the contract.

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

## v2.3.13 Changes - Forecast Backtest + Refined Forecast Export (2026-03-13)
- **Day-ahead forecast replay/backtest was added:** `services/forecast_engine.py` now exposes replay-oriented training state reuse, richer forecast metrics, and CLI backtest modes (`--backtest-range`, `--backtest-days`) that score historical day-ahead runs against saved forecast-weather snapshots without overwriting live forecast rows.
- **Forecast QA now logs more decision-useful metrics:** daily QA includes `WAPE`, `MAPE`, total-energy absolute percentage error, and first/last active-slot timing error instead of only `MAPE`, `MBE`, and `RMSE`.
- **Forecast export XLSX now carries a summary sheet:** `server/exporter.js` now writes a `Summary` worksheet for day-ahead vs actual exports so the file includes actual total, day-ahead total, variance, peak interval, absolute error total, `WAPE`, and mean absolute percentage error alongside the interval table.
- **Forecast interval export was simplified to MWh-only columns:** the analytics day-ahead export now omits `kWh` columns and keeps the interval sheet focused on `MWh` values, absolute `MWh` delta, and absolute error percentage.

## v2.3.11 Changes - Guarded Mode Switching + Standby Baseline Handoff (2026-03-12)
- **Mode changes are now guarded in the UI:** `public/js/app.js`, `public/index.html`, and `public/css/style.css` add a blocking transition overlay and readiness waits so the dashboard does not keep serving normal actions while switching between `gateway` and `remote`.
- **Remote Today MWh is gateway-authoritative again:** `server/index.js` now treats fresh gateway `todayEnergy` rows as authoritative in `remote` mode, scopes the fallback shadow to the active gateway source, and clears stale bridge state when the source changes.
- **Standby refresh now carries the current-day gateway baseline:** before a standby snapshot is transferred, the gateway persists today's partial report state; the remote also refreshes and preserves the current-day gateway today-energy shadow so `Refresh Standby DB -> Restart -> Gateway` does not fall back to older partial-day totals while the local poller catches up.
- **Regression coverage expanded:** `server/tests/remoteTodayShadow.test.js` now covers same-source fallback, cross-gateway shadow rejection, remote-display handoff capture, and preserved shadow behavior after standby restart.

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

## v2.2.31 Changes — Energy Summary Export Cleanup (2026-03-10)
- **Header icon-only controls were diagnosed as CDN-font dependent:** the top-right alarm/menu controls are icon-only MDI buttons, so when the icon stylesheet is unavailable they render as empty squares instead of showing a visible fallback.
- **Energy Summary export dropped per-inverter subtotal rows:** the export now keeps node detail rows and the bottom `DAY TOTAL` row while removing the extra per-inverter `TOTAL` lines.
- **Energy Summary export now uses a single date selector:** the export card and persisted export UI state were migrated from `From`/`To` to one `Date` field, with legacy saved values collapsing safely into the new single-day control.
- **Energy Summary filenames now match single-day exports:** same-day exports now write `DDMMYY <target> Energy Summary` instead of the generic date-range `Recorded Energy` naming.

## v2.2.30 Changes — Solcast Toolkit Preview Date-Range Fix (2026-03-10)
- **Start Day and Days to Display now follow actual toolkit feed dates:** the Solcast preview/export server path now sizes the toolkit `recent` fetch horizon from the selected start day plus the requested display span, instead of only from the display count.
- **Later preview start dates no longer get clipped to the first returned day:** preview and XLSX export now fetch enough hours to enumerate the feed's available days before slicing the selected range.
- **Existing client-side day-count limits now work against real returned availability:** once the server returns the full day list, the `Start Day` and `Days to Display` selectors correctly clamp to the dates actually exposed by the Solcast URL.

## v2.2.29 Changes — Remote Gateway Link Hotfix (2026-03-10)
- **Remote live bridge no longer self-fails after a successful gateway fetch:** `server/index.js` now imports `checkAlarms` before the remote live-ingest path calls it, which fixes the runtime `checkAlarms is not defined` fault.
- **Gateway Link now reports the real live state again:** because the post-fetch ingest no longer throws, `/api/runtime/perf`, `/api/runtime/network/reconnect`, and the Settings health panel can stay `connected` instead of falling back to `disconnected`.
- **Inverter cards receive live remote rows again:** the remote bridge now finishes the live broadcast path, so retained/live remote node data reaches `/api/live` and the renderer repopulates the inverter cards instead of staying blank/offline.

## v2.2.28 Changes — Remote Operation Mode Health Hardening (2026-03-10)
- **Remote health model is now explicit:** `server/index.js` now classifies remote live-bridge runtime as `connected`, `degraded`, `stale`, `disconnected`, `auth-error`, or `config-error` instead of only exposing a binary connected flag.
- **Short outages no longer blank the plant view immediately:** the remote bridge retains the last-good live snapshot for a bounded stale window, keeps `/api/live` populated from that retained snapshot, and marks the UI as degraded or stale instead of dropping straight to empty cards.
- **Failure reasons are operator-safe and specific:** live-bridge failures are classified into URL/config issues, auth failures, timeouts, connection refusal, DNS/route failures, socket resets, and bad payloads so `Gateway Link` and `Last Errors` can show the real cause.
- **Manual reconnect is no longer falsely green:** `/api/runtime/network/reconnect` now reports degraded/stale reconnects honestly, and the frontend surfaces that instead of treating every retained-snapshot refresh as a full recovery.
- **Inverter cards now distinguish stale from offline:** `public/js/app.js` and `public/css/style.css` add bounded stale rendering with a dedicated `STALE` badge and stale card styling, while preserving offline as the hard-disconnect state.

## v2.2.27 Changes — Remote Live Bridge Reconnect Hardening (2026-03-10)
- `Test Remote Gateway` and remote settings save now refresh the live remote bridge immediately instead of waiting for the next backoff tick.
- Added a dedicated runtime reconnect path so `Gateway Link` health and the inverter live cards reattach as soon as saved remote connectivity is valid.
- The UI now warns when a gateway test succeeded only with unsaved URL/token form values, which prevents the green test / disconnected runtime mismatch.

## v2.2.26 Changes — Forecast Integrity and Solcast-Aware ML Local Forecasting (2026-03-10)
- `ml_local` now consumes `solcast_snapshots` as a prior when available, builds a hybrid baseline, and preserves native Solcast PT5M shape instead of treating Solcast as a separate disconnected provider only.
- Forecast analytics reads are now DB-only. `/api/analytics/dayahead` and intraday-adjusted reads no longer mutate the DB by pulling from the Python context file during GET requests.
- Startup legacy context import is now guarded: it only runs when `forecast_dayahead` is empty, which prevents stored DB forecasts from being overwritten on restart.
- Solcast snapshot failures are now surfaced back to the operator as non-fatal warnings in test / preview / generate paths instead of being silently swallowed.

## v2.2.25 Changes — Replication Separation, Transfer Integrity, and Solcast Snapshot Persistence (2026-03-10)
- **Pull and Push are now strictly separated:** manual `Pull` is download-only, manual `Push` is upload-only, and startup auto-sync uses the same read-only local-newer check instead of auto-pushing gateway changes as a side effect. The leftover `/api/replication/reconcile-now` path was also hardened so it no longer modifies gateway data before a catch-up pull.
- **Transfer integrity is validated before apply:** main-DB and archive transfers now carry SHA-256 headers, downloaded/staged files are verified against size and hash, and staged SQLite replacements must pass header validation plus `PRAGMA quick_check(1)` before they can replace the live DB on restart.
- **Remote shutdown and health state were hardened:** embedded shutdown now stops the remote bridge before DB close, and reconcile health fields are updated by the new read-only pre-pull checks so status panels do not keep stale push-era state.
- **Solcast snapshots are now persisted:** toolkit/API fetches now normalize `PT5M` forecast and estimated-actual values into the new `solcast_snapshots` table, storing both raw `MW` and slot `kWh` for preview, export, reproducible day-ahead traces, and future ML hybrid work.
- **Release verification was expanded:** isolated server smoke confirmed pull stays read-only, push stays upload-only, reconcile-now no longer pushes, and live Electron startup smoke reached `/api/settings` before packaging.

## v2.2.24 Changes — Solcast Toolkit, Export Rehab, Remote Hardening, and Faster Replication (2026-03-09)
- **Solcast toolkit workflow added and hardened:** the Forecast settings now support `Toolkit Login` as a first-class Solcast access mode with chart URL, email, and password. Toolkit test, preview, and XLSX export stay local even in Remote mode, and the preview charts/export support `PT5M`, `05:00-18:00`, `1-7` selected days, and both `MWh` and raw `MW` values.
- **Solcast preview UI improved:** the settings layout and preview chart styling were cleaned up, the preview is no longer hidden just because runtime forecast provider stays on `Local ML`, and the export path now writes the currently displayed toolkit range.
- **Energy Summary export rehabilitated:** the export now follows the stricter output format, writes numeric XLSX values, uses PAC-based energy logic, and in Remote workflows relies on the local DB working copy after pull/live mirror instead of direct gateway fetch at export time.
- **Remote-mode behavior hardened:** operation-mode handling now respects the active saved mode, remote URL validation is stricter, remote live data mirrors locally after pull, and manual pull keeps the local DB as the machine's working copy while replacing stale state safely from the gateway snapshot.
- **Replication transport speed-up:** `server/index.js` now uses keep-alive HTTP/HTTPS agents for gateway transfer requests, larger incremental/push chunk sizes, gzip on large replication JSON payloads, gzip on large main-DB and archive downloads, gzip request bodies for large JSON push batches, and small bounded archive transfer concurrency.
- **Transfer path validation:** isolated smoke tests confirmed gzipped incremental pull, gzipped main-DB transfer, gzipped archive download, gzipped push request handling, and live Electron startup smoke reached `/api/settings`.

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
