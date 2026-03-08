# Inverter Dashboard Project Memory

## Project Overview
Industrial solar power plant monitoring desktop app. Hybrid Electron + Python.
- **Version:** 2.2.19
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
- Important: `npm run build:win` packages the existing `dist/InverterCoreService.exe` and `dist/ForecastCoreService.exe`; it does not rebuild them
- Rule: whenever Python service code or the PyInstaller specs change, rebuild the affected service EXE in `dist/` before any Electron build or release
- Release hygiene: clean `release/` before building and remove old release leftovers after publish

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

## v2.2.17 Changes (2026-03-08)
- **Clear thread control:** Operator Messages now includes a confirmed clear action that removes the shared message history through local `POST /api/chat/clear` routing and gateway-backed canonical deletion
- **Renderer sync refinement:** `public/js/app.js` now tracks `chatPendingClear`, disables chat actions while clearing, handles `chat_clear` WebSocket events, preserves unsent drafts, and resets the thread state cleanly without reopening transport logic
- **Chat responsiveness:** Hidden-panel thread rerenders stay suppressed, sender labels remain limited to `Operator Name - Server/Remote`, and clear-state updates keep the panel operational without extra churn
- **Release hygiene:** Version baseline moved to `2.2.17`; release builds must clean `release/` before build and keep only current release artifacts after publish

## v2.2.18 Changes (2026-03-08)
- **Day-ahead window enforcement:** Analytics fetch/export and server-side day-ahead normalization now clamp to the `05:00-18:00` operating window
- **Forecast hardening:** `services/forecast_engine.py` now uses a hardened historical basis from actual archived weather plus actual generation, learned intra-hour shape correction, startup/shutdown activity gating, and conservative low-power node staging
- **ML fallback correctness:** `server/index.js` now treats forecast generator exit code `0` correctly, so successful physics-fallback day-ahead runs no longer report false `code -1` failures
- **Build rule:** project docs now explicitly require rebuilding `dist/ForecastCoreService.exe` and/or `dist/InverterCoreService.exe` whenever the corresponding Python service code or PyInstaller spec changes before any Electron build or release

## v2.2.19 Changes (2026-03-08)
- **Forecast hardening completed:** `services/forecast_engine.py` now fully implements the remaining day-ahead hardening phases with strict archive-vs-forecast weather separation, persisted forecast-weather snapshots, a separate weather-bias layer, regime-aware residual model routing, and a distinct `PacEnergy_IntradayAdjusted` forecast product
- **Server forecast support:** `server/db.js` and `server/index.js` now persist, replicate, and expose `forecast_intraday_adjusted`, while `/api/analytics/dayahead` can return the separate intraday-adjusted product when requested
- **Native module workflow:** `package.json` now includes `rebuild:native:node` and `rebuild:native:electron` scripts so `better-sqlite3` can be rebuilt explicitly for shell-Node checks or Electron release/runtime use without ABI confusion
- **Release readiness verification:** `dist/ForecastCoreService.exe` was rebuilt after the forecast changes, direct `server/db.js` loads were verified in shell Node, and a live Electron startup smoke test reached `/api/settings` successfully

## v2.2.16 Changes (2026-03-08)
- **Operator messaging panel:** Compact bottom-right operator message bubble + slide-in panel added to the dashboard; latest 20 notes, unread badge, auto-open on inbound, 30 s auto-dismiss, draft-safe hold, soft inbound-only Web Audio notification, and sender labels limited to `Operator Name - Server/Remote`
- **Gateway canonical chat storage:** `server/db.js` now provisions `chat_messages` with monotonic `id`, explicit `from_machine` / `to_machine`, `read_ts`, and 500-row retention pruning
- **Gateway/remote transport:** `server/index.js` adds local `/api/chat/send`, `/api/chat/messages`, and `/api/chat/read` routes; remote mode forwards sends/reads to the gateway and runs a 5 s inbox poll loop that rebroadcasts inbound rows over the local WebSocket
- **Renderer chat state:** `public/js/app.js` now merges chat rows by `id`, loads thread history through the local server, marks inbound rows read only on actual panel open/read, and keeps failed remote drafts intact
- **Operational copy polish:** Main dashboard, login/loading, IP config, and topology copy were tightened to be more specific and professional without exposing unnecessary internal detail

## v2.2.15 Changes (2026-03-08)
- **Availability fix:** `/api/report/daily` range handler now splices live `getDailyReportRowsForDay(today, { includeTodayPartial: true })` when today is in range — fixes stale persisted value
- **Detail panel refresh:** 60 s timer fetches both `/api/energy/today` (kWh) and `/api/report/daily?date=today` (availability); merges fresh today rows into `State.invDetailReportRows`
- **PAC thresholds:** ≥90% High, >70% Moderate, >40% Mild, ≤40% Low; `NODE_RATED_W = 249,250 W`; `.row-pac-high/mid/low/off` CSS classes
- **PAC legend:** Static `.pac-legend-wrap` in inverter toolbar; `|` separators via CSS `::before`; High/Moderate/Mild/Low/Alarm hierarchy
- **Startup tab prefetch:** `prefetchAllTabs()` fires 2 s after `init()`, pre-warms all 4 tabs; `TAB_STALE_MS` = 60 s
- **App confirm modal:** `appConfirm(title, body, {ok, cancel})` → Promise<bool>; `#appConfirmModal` in HTML, `.confirm-dialog` in CSS, `initConfirmModal()` called from `init()`; all 9 `confirm()` + 5 `alert()` calls in app.js replaced

## Notes
- See detailed-review.md for first project review findings
