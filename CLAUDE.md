# CLAUDE.md

Repository guidance for Claude Code in `d:\ADSI-Dashboard`.

Claude should read `SKILL.md` first and treat it as the canonical rulebook. This file exists so Claude still has the same project guidance if `SKILL.md` is not consumed automatically.

## Project Snapshot

- User-facing product: `Dashboard V2`
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.3.2` in `package.json`
- Operator-noted deployed server-side app version: `2.2.32`
- GitHub release channel: `mclards/ADSI-Dashboard`
- Stack:
  - Electron desktop app
  - Express server in `server/index.js`
  - Python inverter service
  - Python forecast service
  - SQLite via `better-sqlite3`

Do not casually rename updater identifiers. Visible branding may change, but old installed versions must still detect updates unless a deliberate migration is implemented.
Do not treat hardcoded footer/about version strings as source of truth. `package.json` is the repo version source of truth, and deployed server/runtime versions may legitimately lag it.

## Repo Layout Rules

- Keep the repo root focused on app entrypoints, app metadata, and user-visible config.
- Put Python backend support files, shared Python modules, and PyInstaller spec files under `services/`.
- Do not reintroduce legacy duplicate service files at the repo root.
- Treat `ipconfig.json` and `server/ipconfig.json` as local machine config in normal workflows. Do not commit or release them unless a deliberate baseline change is intended.
- Current intended root surface:
  - `InverterCoreService.py`
  - `ForecastCoreService.py`
  - `package.json`
  - `package-lock.json`
  - `start-electron.js`
  - `ipconfig.json` only when intentionally kept as a visible local config seed or legacy mirror

## Core Priorities

1. Do not break live polling, write control, replication, reporting, export, backup, restore, licensing, or updates.
2. In `remote` mode, treat the gateway as source of truth.
3. Keep UI compact, aligned, readable, and theme-consistent.
4. Preserve updater compatibility with old installed builds.
5. Protect secrets, credentials, archive data, license internals, and user data.

## Data Architecture Rules

The implemented backend now uses a hot/cold telemetry model. Keep future work aligned with it.

- Main hot DB under `C:\ProgramData\InverterDashboard`
- Monthly archive DBs under `C:\ProgramData\InverterDashboard\archive`
- Hot raw telemetry:
  - `readings`
  - `energy_5min`
- Main DB summary and reporting data:
  - `daily_report`
  - `daily_readings_summary`
  - alarms, audit, forecast, settings, and other operational tables

### SQLite Performance Rules

- The hot DB uses WAL mode with `synchronous = NORMAL`. Do not change this to `FULL` — WAL+NORMAL is already crash-safe and FULL adds costly fsync on every commit.
- The poller uses `bulkInsertWithSummary()` to combine reading inserts and daily summary upserts in a single transaction. Do not split these back into separate transactions — each transaction commit fsyncs in WAL mode.
- `pruneOldData()` and `archiveTelemetryBeforeCutoff()` are async and yield the event loop (`setImmediate`) between batches of 5,000 rows. Do not convert these back to synchronous blocking loops.
- Routine WAL checkpoints during operation must use `PASSIVE` mode (non-blocking). Only use `TRUNCATE` during `closeDb()` at app shutdown.
- Long-running DB operations (archival, multi-day report generation, vacuum) must yield control between batches so the event loop can process WebSocket frames and HTTP requests.

### Retention

- `retainDays` controls how long raw `readings` and `energy_5min` remain in the hot DB.
- Old raw telemetry must be archived, not simply deleted.
- Historical analytics, exports, and report rebuilds must still work after archival.

### Historical Read Rules

- Use archive-aware helpers for date ranges that may cross retention:
  - `queryReadingsRange(All)`
  - `queryEnergy5minRange(All)`
  - `sumEnergy5minByInverterRange()`
- Do not add new hot-only direct SQL scans over `readings` or `energy_5min` for historical workloads.

### Daily Report Strategy

- For past dates, prefer persisted `daily_report`.
- Rebuild past daily reports only when rows are missing, refresh is explicitly requested, or a deliberate repair flow requires it.
- Use `daily_readings_summary` as the normal source for per-unit uptime and PAC rollups.
- Do not reintroduce full-day raw `readings` scans as the default report path.
- Daily report exports should keep one row per inverter per day and then append one `TOTAL` row for that same date.
- Do not fake plant `Peak Pac` or `Avg Pac` totals by summing inverter peak or average values. Leave them blank unless they come from a real plant-level aggregate query.

### Replication and Archive Guardrails

- Replicate `daily_report` and `daily_readings_summary` between machines.
- Prefer incremental cursor-based pull.
- Remote startup auto-sync must also stay read-only toward the gateway: it may check whether local data is newer, but it must not auto-push local data as a side effect of startup pull behavior.
- Manual `Pull` is download-only: check for local-newer data and stop with `LOCAL_NEWER_PUSH_FAILED` if found — never push as a side effect. If allowed, stage the gateway `adsi.db` for restart-safe local replacement so stale remote state is removed.
- Manual `Push` is upload-only: send local hot-data delta (and optionally archive files) to the gateway. Push must not pull the gateway DB back or stage a local DB replacement. Push does not require restart.
- If local data is newer before a manual pull, return `LOCAL_NEWER_PUSH_FAILED` and allow `Force Pull` only on explicit operator choice.
- Use chunked push uploads to avoid HTTP `413`.
- Protect local-only settings during merge/import.
- Startup and live remote sync should stay incremental/LWW.
- Never stream the live gateway `adsi.db` file directly. Flush pending in-memory telemetry, create a transactionally consistent SQLite snapshot from the running gateway DB, and transfer that snapshot file instead.
- During a staged gateway main-DB replacement, preserve only the client-local remote settings: operation mode, remote auto-sync flag, gateway URL/token, tailnet hint/interface, and `csvSavePath`.
- Keep replication transport optimized by default:
  - reuse HTTP connections for gateway transfer requests
  - gzip large replication JSON payloads and large main-DB / archive downloads when the peer accepts it
  - keep push uploads chunked and allow gzip request bodies for large JSON push batches
  - allow only small bounded archive concurrency; do not trade restart-safe staging for raw throughput
- Boost HTTP socket pool to `REMOTE_FETCH_MAX_SOCKETS_REPLICATION` (16) during manual pull/push, restore default (8) afterward via `boostSocketPoolForReplication()` / `restoreSocketPoolAfterReplication()` in try/finally.
- Archive file downloads support HTTP Range requests (resume-on-failure). Gateway serves `Accept-Ranges: bytes` + 206 Partial Content. Client retries up to 3 times, resuming from partial temp file.
- After a main-DB pull, the gateway sends replication cursors via the `x-main-db-cursors` response header. The remote must persist these so incremental sync converges correctly.
- Do not remove transfer-speed optimizations casually. Measure first if a rollback is really needed.
- Never rehydrate the hot DB with inbound telemetry older than the local hot cutoff.
- If replicated raw `readings` or `energy_5min` are older than local `retainDays`, write them directly into the local archive instead of the hot DB.
- Archive DB file transfer is implemented, but monthly archive `.db` replacement must be restart-safe:
  - never rename or overwrite a live archive DB in place while the app is running
  - stage pulled or uploaded archive replacements as temp files first
  - apply staged archive replacements only during startup / restart before the server begins serving requests
  - if an archive replacement is staged, archive manifest and archive download logic must expose the staged version immediately so follow-up sync decisions see the newest content
  - manual pull/push messaging must state that staged archive DB changes apply after restart
  - bounded parallel archive transfer must still keep transfer-monitor progress accurate and failure handling deterministic

## UX and Theming Rules

- Keep theming consistent across `dark`, `light`, and `classic`.
- Prefer shared CSS theme tokens over hardcoded one-off colors.
- When adding or removing UI, clean up stale CSS, HTML, and JS so old layouts do not conflict with the new one.
- If a page is dense or long, prefer proper scrolling over overlap or hidden actions.
- Keep iconography consistent. Prefer the existing MDI icon system over mixed emoji usage.
- Any non-obvious or icon-only control should expose short hover help, tooltip text, or helper text.
- Do not hide critical safety or destructive behavior behind hover-only messaging.
- Keep analytics quick actions close to the chart they affect. The day-ahead generator area should keep `Generate` and `Export` together, and the quick export should use the currently selected analytics date and interval.

### Scrollable Page Body Pattern

`.page` is `overflow: hidden; display: flex; flex-direction: column`. Content below the toolbar must be wrapped in a body div (`flex: 1; min-height: 0; overflow: auto`) — never give `flex: 1` directly to a grid or content block inside the page, as it will steal all vertical space and clip siblings. The Inverters page uses `.inv-page-body` for this.

### Key Frontend Patterns (app.js)

- **Inverter detail panel**: `filterInverters()` calls `loadInverterDetail(inv)` / `clearInverterDetail()`. Functions `renderInverterDetailStats/Chart/Alarms/History` live after `filterInverters()`. Panel is inside `.inv-page-body` alongside `#invGrid`.
- **Tab date init**: `initAllTabDatesToToday()` called on startup and on day rollover in `startClock()`. Also clears `State.tabFetchTs` on rollover.
- **Weather offline**: `fetchDailyWeatherRange()` (server/index.js) serves stale cache on any API/network failure.
- **Startup tab prefetch**: `prefetchAllTabs()` fires 2 s after `init()` and pre-warms all 4 tabs in parallel. `TAB_STALE_MS = 60000`.
- **PAC indicator thresholds**: `getPacRowClass()` uses `NODE_RATED_W = 249,250 W`. ≥90% → High (green), >70% → Moderate (yellow), >40% → Mild (orange), ≤40% → Low (red). Static `.pac-legend-wrap` in inverter toolbar.
- **App confirm modal**: `appConfirm(title, body, {ok, cancel})` → `Promise<boolean>`. Replaces all native `confirm()` and `alert()` calls. `#appConfirmModal` + `.confirm-dialog` CSS. `initConfirmModal()` called from `init()`.
- **WebSocket reconnect**: Exponential backoff with jitter: `Math.min(30000, 500 * 1.5^retries + random * 500 * retries)`. Do not revert to linear — prevents thundering herd with multiple remote clients.
- **Proxy timeouts**: Centralized in `PROXY_TIMEOUT_RULES` array + `resolveProxyTimeout()`. Add new proxy route timeouts there, not inline.
- **Gateway link stability**: Adaptive polling (`max(1200, latency×2)` when >400 ms), gateway `/api/live` ETag support for direct consumers, guarded fire-and-forget energy piggyback, gateway `keepAliveTimeout=30s` (must stay > client keepAlive 15s), failure thresholds 6/10/60s/180s. Do not lower thresholds or revert to fixed polling.
- **Availability today**: `/api/report/daily` range handler splices live `getDailyReportRowsForDay(today, { includeTodayPartial: true })` when today is in range. Detail panel 60 s refresh also fetches today's report rows to keep availability chip current.

## Version, Branding, and Release Compatibility

- Always bump `package.json` version before every EXE release build.
- Keep visible version text aligned with `package.json`.
- Keep `SKILL.md`, `CLAUDE.md`, and `MEMORY.md` aligned with the current released version whenever a release baseline changes.
- Keep default plant-name fallbacks aligned with the current baseline: `ADSI Plant`.
- Preserve updater compatibility:
  - app ID stays `com.engr-m.inverter-dashboard`
  - GitHub repo stays `mclards/ADSI-Dashboard`
  - release asset names stay:
    - `Inverter-Dashboard-Setup-<version>.exe`
    - `Inverter-Dashboard-Portable-<version>.exe`
- Keep Windows build icon usage aligned with `icon-256.png`.
- If visible branding changes, audit header, about, footer, and build metadata together.
- Never ship a release when the repo docs still describe an older baseline or older runtime behavior.
- When the user says `publish release`, Claude should execute the release workflow directly:
  - build artifacts if needed
  - create or upload the GitHub release itself
  - do not stop at providing commands unless auth, permissions, or network access prevent publishing
- If publishing is blocked, report the exact blocker and then provide only the minimum command(s) the user needs to run.
- Push the release commit and release tag before creating the GitHub release so the published tag resolves to the intended commit.
- If a GitHub release create/upload call times out, inspect GitHub release state before retrying. Do not blindly rerun release creation and risk duplicate or broken draft state.

## Storage and Compatibility Paths

Preserve these unless a deliberate migration is implemented:

- License root: `C:\ProgramData\ADSI-InverterDashboard\license`
- License state: `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json`
- License mirror: `C:\ProgramData\ADSI-InverterDashboard\license\license.dat`
- License registry mirror: `HKCU\Software\ADSI\InverterDashboard\License`
- Server and export root: `C:\ProgramData\InverterDashboard`
- Archive root: `C:\ProgramData\InverterDashboard\archive`
- Default export path: `C:\Logs\InverterDashboard`
- Portable data root: `<portable exe dir>\InverterDashboardData`
- Cloud provider folder: `InverterDashboardBackups`

## Operating Modes

- `gateway`
  - polls plant locally
  - is the authoritative source of truth for live data, reports, forecasts, chat, and replication snapshots
  - is the only mode allowed to generate day-ahead and intraday-adjusted forecast data
- `remote` (viewer model)
  - is a gateway-backed viewer, not a replicated working copy
  - displays live gateway data in-memory only — no local DB persistence from the live stream
  - historical views, reports, analytics, and exports are served from the gateway via proxy
  - manual Pull ("Refresh Standby DB") downloads the gateway main DB for local standby use (applied after restart, for later `gateway`-mode use)
  - push, reconciliation, and startup auto-sync are disabled
  - forecast generation (day-ahead and intraday-adjusted) does not run in any layer
  - when gateway is unavailable, historical pages show "Gateway unavailable" instead of stale local data
  - live bridge health is stateful: `connected`, `degraded`, `stale`, `disconnected`, `auth-error`, or `config-error`
  - short live-bridge failures retain the last-good in-memory snapshot for a bounded window and mark inverter cards stale
  - inverter on/off write control stays enabled via gateway proxy
  - may run local remote-side utilities such as Solcast toolkit test / preview / export
  - switching from remote to gateway warns about stale local DB

## Operator Messaging

- The operator messaging panel is a compact gateway-to-remote note channel, not a general chat product.
- Canonical message storage lives on the gateway in `chat_messages`.
- The renderer should always use local `/api/chat/*` routes. In `remote` mode, the local server forwards or polls upstream through the configured gateway token path.
- Remote inbox transport must use monotonic `id` cursors and must never mark messages read while polling.
- `read_ts` should change only when the operator opens or reads the visible thread.
- Visible sender identity should use only `operatorName` plus `Server` or `Remote`.
- The panel should expose an explicit clear-thread action with confirmation and sync it through the shared gateway-backed history.
- Chat notification sound is inbound-only, stays silent for self-send echoes, and depends on the shared browser audio context already being unlocked by user interaction.
- Keep visible UI wording operational and reserved. Do not expose transport details, tokens, or server terminology.
- Chat send rate is limited to 10 messages per 60 s per machine, enforced server-side via a sliding-window bucket (`_chatRateBuckets`). Do not remove this rate limiter.

## Current Metrics Guardrails

- Expected full inverter node count: `4`
- Max inverter baseline: `997.0 kW`
- Dependable baseline: `917.0 kW`
- Per-node equivalent at 4 nodes: `249.25 kW`

Performance:

- Performance is affected by active node count.
- Reduced-node inverters must use normalized expected capacity.

Availability:

- Availability is inverter-level uptime only.
- Use the operation window `5:00 AM` to `6:00 PM`.
- Node count alone must not reduce availability.
- If all `4` nodes are offline or inactive, availability must be `0`.
- A fully active inverter across the full window should resolve to `100% availability`.

## Security and Privacy

- Do not expose tokens, client secrets, license signing details, or private material in normal UI.
- Do not log credentials or sensitive payloads.
- Prefer simpler UX if it removes exposed security internals without harming operations.
- Treat imported or exported config files and archive telemetry as sensitive.

## GitHub Repo Hygiene

- Exclude confidential files from Git tracking and GitHub releases.
- Do not commit secrets, tokens, OAuth client secrets, signing keys, private keys, local auth caches, customer exports, local database snapshots, archive DB copies, or portable runtime data.
- Keep local-only tooling out of app releases unless explicitly requested.
- Review staged files before push or release so stale binaries and sensitive files do not leak into GitHub.
- Keep public repo docs and release notes aligned with the current app name, version, and UX.
- If `SKILL.md` changes, keep `CLAUDE.md` aligned instead of letting the two drift.
- Exclude local machine config such as `ipconfig.json` and `server/ipconfig.json` from normal commits and GitHub releases.

## High-Impact Files

- Electron: `electron/main.js`, `electron/preload.js`
- Server: `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js`
- Frontend: `public/index.html`, `public/js/app.js`, `public/css/style.css`
- Python: `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py`

## Build and Validation

Run from repo root:

```powershell
npm run rebuild:native:electron
npm run build:installer
npm run build:portable
```

- Before every release build, clean the workspace `release/` folder so old EXEs, blockmaps, unpacked folders, and transient build leftovers do not accumulate.
- After publishing the latest release, remove prior build leftovers from `release/` and keep only the current release assets when they still need to remain local.

Useful checks after JS edits:

```powershell
node --check public/js/app.js
node --check server/index.js
node --check server/db.js
node --check server/poller.js
node --check server/exporter.js
node --check electron/main.js
node --check electron/preload.js
```

## Build Warning Policy

- Address actionable build warnings.
- Do not over-fix non-fatal electron-builder dependency-scanner warnings when artifacts build successfully.

## Service EXE Build Rule

- `npm run build:win` only packages the existing `dist/InverterCoreService.exe` and `dist/ForecastCoreService.exe`. It does not rebuild them.
- `better-sqlite3` is runtime-ABI specific:
  - use `npm run rebuild:native:node` before direct shell-Node checks that load `server/db.js`
  - use `npm run rebuild:native:electron` before Electron run/build/release workflows
  - **After any Node-ABI smoke test, always run `npm run rebuild:native:electron`** before launching or building the Electron app. The smoke test rebuilds `better-sqlite3` for plain Node (different ABI), which breaks Electron until restored.
- Some shells in this workspace export `ELECTRON_RUN_AS_NODE=1`.
  - Direct `electron.exe ...` launches and Playwright/Electron probes will behave like plain Node unless that env var is removed.
  - This can produce misleading errors such as `Unable to find Electron app ...`.
  - Clear `ELECTRON_RUN_AS_NODE` or launch through `start-electron.js` semantics before any Electron/UI smoke.
- Before any EXE build, run the required smoke test for the changed surface and do not skip it unless the user explicitly says to skip smoke testing.
  - backend / DB / replication / archive changes: isolated server smoke test
  - Electron shell / preload / startup / packaging-sensitive changes: live Electron startup smoke test
- Browser-side / live Electron UI verification is available via:
  - `npx playwright test server/tests/electronUiSmoke.spec.js --reporter=line`
  - This smoke covers dashboard metrics, the Energy Summary Export single-date UI, and Settings connectivity health in the real Electron window.
- Inverter detail panel rule:
  - Do not block initial detail rendering on the 7-day `/api/report/daily` history fetch.
  - Stats and alarms should render first; recent-history loading must be best-effort and bounded by a timeout.
- Whenever changes are made to `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `drivers/modbus_tcp.py`, or either PyInstaller spec, rebuild the affected Python service EXE in `dist/` before any Electron build or release.
- If both Python services changed, rebuild both EXEs first, then run the Electron build.
- Do not publish or hand off app EXEs if they were built against stale Python service binaries.
- Release hygiene still applies: clean `release/` before building and remove prior release leftovers after publish.
- Do not assume release-folder cleanup worked. Verify the `release/` folder contents before and after build/publish.
- The post-publish `release/` folder should contain only:
  - `Inverter-Dashboard-Setup-<version>.exe`
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
  - `Inverter-Dashboard-Portable-<version>.exe`
  - `latest.yml`
