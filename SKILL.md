# SKILL.md

Project guidance for Codex, Claude, and other coding agents working in `d:\ADSI-Dashboard`.

This file is the canonical project rulebook. Keep `CLAUDE.md` aligned with it whenever this file changes.

## Project Identity

- User-facing product name: `ADSI Inverter Dashboard`
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.3.2` in `package.json`
- Operator-noted deployed server-side app version: `2.2.32`
- Release source of truth for versioning: `package.json`
- GitHub release channel: `mclards/ADSI-Dashboard`

Do not casually rename internal updater identifiers. Visible branding may change, but updater compatibility with installed legacy builds must remain intact unless a deliberate migration is implemented.
Do not treat hardcoded footer/about version strings as source of truth. `package.json` is the repo version source of truth, and deployed server/runtime versions may legitimately lag it.

## Core Stack

- Electron desktop shell
- Express API server in `server/index.js`
- Python inverter core service
- Python forecast service
- SQLite via `better-sqlite3`
- Frontend in `public/index.html`, `public/js/app.js`, `public/css/style.css`

## Repo Layout Rules

- Keep the repo root focused on app entrypoints, app metadata, and user-visible config only.
- Put Python backend support files, shared Python modules, and PyInstaller spec files under `services/`.
- Do not reintroduce legacy duplicate service files at the repo root.
- Treat `ipconfig.json` and `server/ipconfig.json` as local machine config in normal workflows. Do not commit or release them unless a deliberate config-baseline change is intended.
- Current intended root surface:
  - `InverterCoreService.py`
  - `ForecastCoreService.py`
  - `package.json`
  - `package-lock.json`
  - `start-electron.js`
  - `ipconfig.json` only when intentionally kept as a visible local config seed or legacy mirror

## Non-Negotiable Priorities

1. Do not break live polling, write control, replication, reporting, export, backup, restore, licensing, or update flows.
2. In `remote` mode, treat the gateway as source of truth.
3. Preserve updater compatibility with old app releases.
4. Keep UI compact, readable, and consistent across `dark`, `light`, and `classic`.
5. Treat credentials, license internals, archives, and user data as sensitive.

## Data Architecture Rules

The project now uses a hot/cold telemetry model. Keep future work aligned with that model.

- Hot DB: main SQLite file under `C:\ProgramData\InverterDashboard`
- Cold DBs: monthly archive SQLite files under `C:\ProgramData\InverterDashboard\archive`
- Hot telemetry tables:
  - `readings`
  - `energy_5min`
- Persistent summary/report tables kept in the main DB:
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

- `retainDays` controls how long raw `readings` and `energy_5min` stay hot in the main DB.
- Old raw telemetry must be archived, not simply discarded.
- Archived telemetry must remain readable for historical analytics, exports, and report rebuilds.
- Do not bypass the configured `retainDays` window when deciding what remains in the hot DB.

### Historical Read Rules

- Use archive-aware helpers when reading historical telemetry:
  - `queryReadingsRange(All)`
  - `queryEnergy5minRange(All)`
  - `sumEnergy5minByInverterRange()`
- Do not add new direct SQL scans over hot-only `readings` or `energy_5min` for date ranges that may cross retention boundaries.
- Historical reports and exports must continue to work even after raw telemetry is archived.

### Daily Report Strategy

- For past days, prefer persisted `daily_report` rows.
- Rebuild past daily reports only when:
  - persisted rows are missing
  - refresh is explicitly requested
  - a repair or backfill action intentionally regenerates them
- Use `daily_readings_summary` as the normal source for inverter/day/unit uptime and PAC rollups.
- Do not reintroduce full-day raw `readings` scans as the normal report path.
- Daily report exports should keep one row per inverter per day and then append one `TOTAL` row for that same date.
- Do not fake plant `Peak Pac` or `Avg Pac` totals by summing inverter peak or average values. Leave them blank unless they come from a real plant-level aggregate query.

### Replication and Archive Guardrails

- Replicate `daily_report` and `daily_readings_summary` so historical reporting survives across machines.
- Startup and live remote sync should keep the incremental cursor-based replication model.
- Manual `Pull` is download-only: check if local data is newer than the gateway, and if so stop with `LOCAL_NEWER_PUSH_FAILED` — never push data to the gateway as a side effect of pull. If allowed to proceed, download a transactionally consistent gateway `adsi.db` snapshot and stage it for restart-safe local replacement.
- Manual `Push` is upload-only: send local replicated hot-data delta to the gateway, and if requested upload local archive files. Push must not pull the gateway DB back down or stage a local DB replacement. Push does not require restart.
- Remote startup auto-sync must also stay read-only toward the gateway: it may check whether local data is newer, but it must not auto-push local data as a side effect of startup pull behavior.
- If local data is newer before a manual pull, return `LOCAL_NEWER_PUSH_FAILED` with `canForcePull: true`. Do not auto-push. Allow `Force Pull` only if the operator explicitly chooses it.
- Use chunked push uploads to avoid HTTP `413`.
- When replacing the main DB from the gateway, preserve only the explicit local-only remote settings on the client machine: operation mode, remote auto-sync flag, gateway URL/token, tailnet hint/interface, and `csvSavePath`.
- Never copy the live gateway `adsi.db` file directly. Flush pending in-memory telemetry first, then export a consistent SQLite snapshot from the running gateway DB and transfer that snapshot file instead.
- Keep replication transport optimized by default:
  - reuse HTTP connections for gateway transfer requests
  - allow gzip compression for large replication JSON payloads and large main-DB / archive downloads
  - keep push uploads chunked and allow gzip request bodies for large JSON push batches
  - archive pull/push may run with small bounded concurrency, but do not remove restart-safe staging
- Boost HTTP socket pool to `REMOTE_FETCH_MAX_SOCKETS_REPLICATION` (16) during manual pull/push operations, and restore the default (8) afterward. Use `boostSocketPoolForReplication()` / `restoreSocketPoolAfterReplication()` in a try/finally around replication workflows.
- Archive file downloads must support HTTP Range requests (resume-on-failure). The gateway serves `Accept-Ranges: bytes` and responds with 206 Partial Content when a `Range` header is present. The client retries up to 3 times, resuming from the partial temp file.
- After a main-DB pull, the gateway sends replication cursors via the `x-main-db-cursors` response header. The remote must persist these cursors so incremental sync converges correctly from the pulled state.
- Do not silently revert transfer optimization settings without measuring the impact on slow links first.
- Never rehydrate the hot DB with inbound telemetry older than the local hot cutoff.
- If replicated `readings` or `energy_5min` rows are already older than local `retainDays`, write them directly into the local archive instead of the hot DB.
- Archive DB file transfer is now implemented, but monthly archive `.db` replacement must be restart-safe:
  - never rename or overwrite a live archive DB in place while the app is running
  - stage pulled or uploaded archive replacements as temp files first
  - apply staged archive replacements only during startup / restart before the server begins serving requests
  - if an archive replacement is staged, archive manifest and archive download logic must expose the staged version immediately so follow-up sync decisions see the newest content
  - manual pull/push messaging must state that staged archive DB changes apply after restart
  - bounded parallel archive transfer must still keep transfer-monitor progress accurate and failure handling deterministic

## UX and Theming Rules

When adding, removing, or restructuring UI:

- Use shared theme tokens such as `--bg`, `--surface`, `--surface2`, `--border`, `--border2`, `--text`, `--text2`, `--text3`, and `--accent`.
- Avoid hardcoded one-off colors for reusable panels, forms, cards, toolbars, status chips, and action bars unless the area is intentionally isolated.
- If a component exists in one theme, validate it conceptually against all three themes. Do not leave light/classic with dark-only styling.
- Keep spacing, radius, shadows, and panel hierarchy aligned with existing dashboard patterns.
- Remove stale CSS, HTML, and JS when replacing an older UI pattern. Do not leave dead layouts, orphan selectors, or unused controls behind.
- Prefer one clear interaction path over duplicated controls that do the same thing.
- If a page is dense or long, make the right area scrollable instead of allowing overlap or hidden actions.
- Keep analytics quick actions close to the chart they affect. The day-ahead generator area should keep `Generate` and `Export` together, and the quick export should use the currently selected analytics date and interval.

### Scrollable Page Body Pattern

`.page` is `position: absolute; overflow: hidden; display: flex; flex-direction: column`. To make content below the toolbar scrollable, wrap it in a body div — do not give `flex: 1` directly to a grid or content block inside the page:

```css
.some-page-body {
  flex: 1;
  min-height: 0;      /* required: prevents flex child from overflowing */
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

The existing `#page-inverters` uses `.inv-page-body` for this. Apply the same pattern to any future page that has a pinned toolbar and scrollable body content.

## Icons, Logos, and Visual Consistency

- Use the existing MDI icon system for navigation, settings, actions, and status wherever possible.
- Do not mix emoji icons with MDI icons in the same workflow.
- If the app icon, brand logo, or visible product name changes, update all affected surfaces together:
  - `package.json` build metadata
  - header, about, and footer branding
  - installer icon references
  - release artifact expectations if intentionally changed
- Current Windows build icon reference: `icon-256.png`

## Hover Help and User Guidance

The UI should reduce operator confusion without making screens noisy.

- Any icon-only action or non-obvious control should expose short hover help, tooltip text, or inline helper text.
- Use hover info for controls with operational consequences, technical abbreviations, or hidden assumptions.
- Keep hover text concise and operational. Prefer "what this does" and "why it matters".
- Do not rely on hover only for critical safety information. Pair it with visible labels when the action is destructive or high impact.

## Security and Privacy Rules

- Do not expose secrets, private keys, OAuth internals, signing details, or sensitive debugging information in the renderer unless explicitly required.
- Keep client secrets, API keys, tokens, and license material out of normal UI displays by default.
- Do not add logs that print tokens, OAuth responses, license payload internals, filesystem secrets, or personally sensitive data.
- If a UI flow can be simplified without exposing security internals, prefer the simpler user-facing flow.
- License generation and verification UI should not reveal unnecessary implementation hints.
- Treat exported configuration files and archived operational data as sensitive when they contain credentials or customer telemetry.

## GitHub Repo Hygiene

Keep the public repository clean, professional, and safe to publish.

- Exclude confidential files from Git tracking and GitHub releases.
- Do not commit secrets, tokens, OAuth client secrets, private keys, signing keys, local database snapshots, local auth caches, archive DB copies, portable runtime data, or customer-specific exports.
- Keep local-only tooling out of app releases unless explicitly requested.
- Before push or release, review staged files for accidental sensitive content and stale generated artifacts.
- Keep public docs, screenshots, and release notes aligned with the current app name, version, and UX.
- Remove obsolete generated files and stale binaries from the workspace before publishing new releases.
- Exclude local machine config such as `ipconfig.json` and `server/ipconfig.json` from normal commits and GitHub releases.

Confidential or local-only examples to keep out of GitHub unless there is a deliberate reason:

- `.env`, `.env.*`
- `keys/`, `secrets/`, `private/`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- local license files, signing outputs, and auth/token caches
- local database copies, archive DB copies, and runtime backup folders
- local-only license generator tools and their outputs

## Versioning and Release Rules

- Always bump `package.json` version before building any release EXE.
- Keep visible version text aligned with `package.json`.
- Keep `SKILL.md`, `CLAUDE.md`, and `MEMORY.md` aligned with the current released version whenever a release baseline changes.
- Keep default plant-name fallbacks aligned with the current baseline: `ADSI Plant`.
- Keep updater compatibility intact:
  - app ID stays `com.engr-m.inverter-dashboard`
  - release asset names stay compatible with existing updater expectations
  - GitHub release channel remains `mclards/ADSI-Dashboard`
- Never publish new installer or portable artifacts under an unchanged version.
- Every build release must append the latest app version to the release artifacts and release metadata.
- Never ship a release when the repo docs still describe an older baseline or older runtime behavior.
- When the user says `publish release`, the agent should perform the release workflow directly:
  - build the required artifacts if needed
  - create or upload the GitHub release itself
  - avoid stopping at copy-paste commands unless GitHub auth, repo permissions, or network access blocks execution
- If release publishing is blocked by auth, permissions, or network issues, state the exact blocker and then provide the minimal command(s) needed for the user to finish it.
- Push the release commit and the release tag before creating the GitHub release so the published tag always resolves to the intended commit.
- If a GitHub release create/upload call times out, inspect GitHub release state before retrying. Do not blindly rerun release creation and risk duplicate or broken draft state.

## Build and Artifact Rules

Expected app artifacts:

- `release/Inverter-Dashboard-Setup-<version>.exe`
- `release/Inverter-Dashboard-Setup-<version>.exe.blockmap`
- `release/Inverter-Dashboard-Portable-<version>.exe`
- `release/latest.yml`

Do not include local-only license-generator builds in GitHub app releases unless explicitly requested.

- Before every release build, clean the workspace `release/` folder so old EXEs, blockmaps, unpacked folders, and transient build leftovers do not stack up.
- After publishing the latest release, remove previous build leftovers from `release/` and keep only the current release assets when they still need to be referenced locally.
- Do not assume a cleanup command worked. Verify the `release/` folder contents before and after build/publish.
- The post-publish `release/` folder should contain only:
  - `Inverter-Dashboard-Setup-<version>.exe`
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
  - `Inverter-Dashboard-Portable-<version>.exe`
  - `latest.yml`

Build commands:

```powershell
npm run rebuild:native:electron
npm run build:installer
npm run build:portable
```

## File and Directory Consistency

Preserve these storage and compatibility paths unless a migration is intentionally implemented:

- License root: `C:\ProgramData\ADSI-InverterDashboard\license`
- License mirror file: `C:\ProgramData\ADSI-InverterDashboard\license\license.dat`
- License state: `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json`
- License registry mirror: `HKCU\Software\ADSI\InverterDashboard\License`
- Server and export data root: `C:\ProgramData\InverterDashboard`
- Archive root: `C:\ProgramData\InverterDashboard\archive`
- Default export path: `C:\Logs\InverterDashboard`
- Portable data root: `<portable exe dir>\InverterDashboardData`
- OneDrive and Google Drive backup folder name: `InverterDashboardBackups`

If a visible product rename affects install directory behavior, assess updater impact and migration impact before changing it.

## Current Operating Modes

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

## Operator Messaging Rules

- The operator messaging panel is a compact two-machine note channel between `gateway` and `remote`.
- Canonical operator messages are stored only on the gateway in `chat_messages`.
- The browser should always call its own local `/api/chat/*` routes. In `remote` mode, the local server is responsible for forwarding to the gateway.
- Remote inbound messaging is transport-only polling. It must use monotonic `id` cursors and must not mark rows as read during background fetches.
- `read_ts` should only change when the operator actually opens or reads the thread.
- Keep the messaging UI operational and discreet:
  - short plain-text notes only
  - visible sender identity should use only `operatorName` plus the role label `Server` or `Remote`
  - provide a clear-thread action with confirmation so operators can intentionally reset the shared note history
  - chat notification sound should fire only for inbound messages from the opposite machine
  - self-sent messages should remain silent
  - the sound depends on the browser audio context already being unlocked by a user gesture
  - no token, transport, or server-internal wording exposed in the renderer
  - no overlap with the alarm notification control
- Chat send rate is limited to `CHAT_RATE_LIMIT_MAX` (10) messages per `CHAT_RATE_LIMIT_WINDOW_MS` (60 s) per machine, enforced server-side via a sliding-window bucket (`_chatRateBuckets`). Do not remove this rate limiter.

## Current Metrics Guardrails

- Expected full inverter node count: `4`
- Baseline max inverter power: `997.0 kW`
- Equivalent per node at 4 nodes: `249.25 kW`
- Dependable full inverter baseline: `917.0 kW`

Performance:

- Performance is the metric affected by active node count.
- A reduced-node inverter should have normalized expected capacity based on active nodes.

Availability:

- Availability is inverter-level uptime only.
- Use plant daytime operation window `5:00 AM` to `6:00 PM`.
- Node count should not reduce availability by itself.
- `4 active nodes` and inverter up for the full window means `100% availability`.
- If all `4` nodes for an inverter are offline or inactive, availability must be `0`.

## Frontend Patterns

### Inverter Detail Panel

When a single inverter is selected from the `invFilter` dropdown, `filterInverters()` calls `loadInverterDetail(inv)` to populate `#invDetailPanel` with:
- Stat chips: Today kWh, Current PAC, Availability %, Active Alarms
- Today's AC Power chart (5-min energy → average kW via `kwh_inc * 12`)
- Recent Alarms table (last 30 days, max 15 rows)
- Last 7 Days summary table

Functions: `clearInverterDetail()`, `loadInverterDetail(inv)`, `renderInverterDetailStats()`, `renderInverterDetailChart()`, `renderInverterDetailAlarms()`, `renderInverterDetailHistory()` — all in `public/js/app.js` after `filterInverters()`.

`#invDetailPanel` lives inside `.inv-page-body` alongside `#invGrid`. Both scroll together in the wrapper.

### Tab Date Initialization

`initAllTabDatesToToday()` sets all date inputs (Analytics, Alarms, Energy, Audit, Report) to today's date. It is called:
- On `init()` after `loadSettings()`, overriding any stale `exportUiState` dates
- On day rollover inside `startClock()` tick (compares `dateStr(now)` to `State.lastDateInitDay`)

Day rollover also clears `State.tabFetchTs` and all tab row caches so data re-fetches on next tab visit.

### Startup Tab Prefetch

`prefetchAllTabs()` fires 2 s after startup and runs `fetchAlarms / fetchReport / fetchAudit / fetchEnergy` in parallel so the first tab switch renders instantly from cache. `TAB_STALE_MS` is set to `60000` (60 s). Called at the end of `init()`.

### PAC Indicator Thresholds

Each inverter node has a 6×14 px colored bar (`getPacRowClass()`) based on `NODE_RATED_W = 249,250 W`:
- ≥ 90% rated → `.row-pac-high` (green, #00cf00) — **High**
- > 70% rated  → `.row-pac-mid`  (yellow, #ffff00) — **Moderate**
- > 40% rated  → `.row-pac-low`  (orange, #ffa500) — **Mild**
- ≤ 40% rated  → `.row-pac-off`  (red, #ff0000) — **Low**
- Alarm active → blink animation — **Alarm**

A compact static legend (`.pac-legend-wrap`) sits in the inverter toolbar between the layout selector and the counters.

### App Confirm Modal (replaces native `window.confirm`)

`appConfirm(title, bodyText, { ok, cancel })` → `Promise<boolean>`. Renders `#appConfirmModal` (`.modal-backdrop` + `.confirm-dialog`) with a title, body (paragraphs split on `\n\n`), and labelled OK/Cancel buttons. Supports Escape (cancel), Enter (confirm), backdrop click (cancel). `initConfirmModal()` called from `init()`. All `confirm()` / `window.confirm()` calls in `app.js` replaced with `await appConfirm(...)`. All `alert()` calls replaced with `showToast(...)`.

### Availability Computation

Availability for today is computed live via `getDailyReportRowsForDay(today, { includeTodayPartial: true })`. The `/api/report/daily?start&end` range endpoint detects when today falls in the requested range and splices in the live result rather than serving the stale persisted row. The detail panel 60 s refresh timer fetches `/api/report/daily?date=<today>` and merges the fresh rows into `State.invDetailReportRows` so the availability chip stays current.

### WebSocket Reconnection

The frontend uses exponential backoff with jitter for WebSocket reconnection: `Math.min(30000, 500 * 1.5^retries + random * 500 * retries)`. Do not revert to linear backoff — it causes thundering herd on gateway restarts with multiple remote clients.

### Gateway Link Stability

The remote bridge polls the gateway `/api/live` endpoint and must stay resilient over VPN/Tailscale links:

- **Adaptive polling interval:** `getRemoteBridgeNextDelayMs()` scales to `max(1200, latency×2)` when gateway latency exceeds 400 ms. Do not revert to a fixed interval — it causes request pileup on slow links.
- **Gateway `/api/live` ETag support:** Gateway `/api/live` returns a timestamp-based `ETag` via raw `writeHead`/`end` (bypasses Express ETag) for direct conditional GET consumers. The remote bridge still performs full live polls so downstream clients keep fresh timestamps and totals; do not reintroduce bridge-side `304` skipping unless freshness semantics are redesigned first.
- **Non-blocking energy piggyback:** The `/api/energy/today` fetch inside `pollRemoteLiveOnce()` is fire-and-forget (`.then()` chain). It must not block the bridge tick, but it must only stamp `lastTodayEnergyFetchTs` after a successful payload and must ignore stale responses from an older bridge session.
- **Gateway `keepAliveTimeout`:** Set to 30 s (`headersTimeout` 35 s). Must stay above the client `REMOTE_FETCH_KEEPALIVE_MSECS` (15 s) to prevent the gateway from closing idle sockets that the client thinks are alive.
- **Failure thresholds:** `REMOTE_LIVE_FAILURES_BEFORE_OFFLINE = 6` (10 during sync). `REMOTE_LIVE_DEGRADED_GRACE_MS = 60000`. `REMOTE_LIVE_STALE_RETENTION_MS = 180000`. Do not lower these — they prevent UI flicker on intermittent drops.

### Proxy Timeout Rules

Remote-to-gateway proxy timeouts are centralized in the `PROXY_TIMEOUT_RULES` array and resolved via `resolveProxyTimeout(method, path)`. When adding new proxy routes, add a matching rule to the array instead of inline if/else logic.

### Weather Offline Hardening

`fetchDailyWeatherRange()` in `server/index.js` wraps the external weather API fetch in try/catch. On any network or HTTP error, it serves the stale in-memory cache (even if past TTL) with a `console.warn`. It only re-throws if there is no cached data at all. This keeps forecast and analytics working without internet.

## High-Impact Files

- Electron: `electron/main.js`, `electron/preload.js`
- Server: `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js`
- Frontend: `public/index.html`, `public/js/app.js`, `public/css/style.css`
- Python: `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py`

## Validation After Changes

Useful checks after JS edits:

```powershell
node --check server/index.js
node --check server/db.js
node --check server/poller.js
node --check server/exporter.js
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

Useful checks after CSS or HTML UX edits:

```powershell
git diff -- public/index.html public/css/style.css
```

## Build Warning Policy

- Fix actionable build warnings.
- Do not waste time over-fixing non-fatal electron-builder scanner noise when artifacts are valid.

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
