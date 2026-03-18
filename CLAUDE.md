# CLAUDE.md

Repository guidance for Claude Code in `d:\ADSI-Dashboard`.

Claude should read `SKILL.md` first and treat it as the canonical rulebook. This file exists so Claude still has the same project guidance if `SKILL.md` is not consumed automatically.

## Project Snapshot

- User-facing product: `ADSI Inverter Dashboard`
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.4.15` in `package.json`
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

## Default Credentials and Access Keys

Internal note. Keep this aligned with the actual implementation and do not mirror it into public docs unless explicitly requested.

- Login default username: `admin`
- Login default password: `1234`
- Login admin auth key for credential change/reset: `ADSI-2026`
- Login reset behavior: `ADSI-2026` restores `admin` / `1234`
- Bulk selected inverter control auth key: `sacupsMM`
  - `MM` is the current minute
  - previous minute is also accepted
  - applies only to `START SELECTED` / `STOP SELECTED`
  - per-node and per-inverter controls remain unauthenticated
- Topology and IP Configuration auth gate key: `adsiM` or `adsiMM`
  - current minute in unpadded or zero-padded form
  - IP Configuration gate keeps a 1-hour window session
  - Topology gate keeps a 10-minute window session
- No built-in default exists for:
  - remote gateway API token
  - Solcast API/toolkit credentials
  - OneDrive / Google Drive OAuth credentials
  - cloud-backup provider credentials
- Secret handling rule:
  - do not place live passwords or toolkit credentials in tracked markdown
  - if the user explicitly wants a markdown record, keep it only in a git-ignored location such as `private/*.md`

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

### Current-Day Energy Authority

- `TODAY MWh`, analytics `ACTUAL MWh`, and per-inverter `TODAY ENERGY` must be derived only from server-side `PAC x elapsed time`.
- Do not treat Python/modbus register kWh, inverter lifetime-energy registers, or Python `/metrics` energy fields as authoritative for current-day energy totals.
- For this area, Python is only the raw telemetry source; Node owns current-day energy computation, persistence, summary generation, and UI/export authority.
- Keep current-day display, analytics, and export totals aligned by using the same Node-computed current-day snapshot backed by persisted `energy_5min` plus live PAC supplement rows.
- If Python ever exposes energy-like diagnostics again, keep them explicitly non-authoritative unless the project rule is deliberately changed.

### Solar Window Persistence Rule

- Polling continues outside the solar window so live plant visibility and alarm detection remain available.
- Raw poll persistence for `readings` and `energy_5min` must remain inside the solar window only.
- Shutdown flush behavior must obey the same solar-window gate; do not write off-window raw telemetry during graceful exit.
- Alarm and audit persistence remain operationally independent from the solar-window raw-telemetry rule.

### Alarm Episode and Sound Rules

- Alarm audio must ignore short alarm occurrences that clear in under 5 seconds.
- Sound is tied to a sustained unacknowledged active alarm episode, not every individual alarm-value mutation.
- If a node already has an active nonzero alarm and a new nonzero alarm value is added or changed on that same node, treat it as the same active episode:
  - update the existing active alarm row in place
  - preserve its acknowledged state
  - do not emit a fresh raise event just because the active bitmask changed
  - do not retrigger the alarm sound

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
- The local-newer manual-pull guard must compare replicated operational data only. Local-only remote-client `settings` drift must not trigger `LOCAL_NEWER_PUSH_FAILED`.
- Manual-pull preflight must finish before pausing the live stream or starting any main-DB or archive transfer. A blocked pull should fail fast and stay low-impact on the gateway.
- If the operator explicitly chooses `Force Pull`, reuse the successful preflight when available and skip redundant gateway-summary round trips so standby refresh adds the minimum extra load to the gateway.
- Use chunked push uploads to avoid HTTP `413`.
- Protect local-only settings during merge/import.
- Startup and live remote sync should stay incremental/LWW.
- Never stream the live gateway `adsi.db` file directly. Flush pending in-memory telemetry, create a transactionally consistent SQLite snapshot from the running gateway DB, and transfer that snapshot file instead.
- During a staged gateway main-DB replacement, preserve only the client-local remote settings: operation mode, remote auto-sync flag, gateway URL/token, tailnet hint/interface, `csvSavePath`, and `operatorName`.
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
- Any failed or cancelled standby pull must discard staged main-DB and archive replacement manifests plus temp downloads immediately. Do not leave pending replacements behind after a bad transfer.

## UX and Theming Rules

- Keep theming consistent across `dark`, `light`, and `classic`.
- Prefer shared CSS theme tokens over hardcoded one-off colors.
- When adding or removing UI, clean up stale CSS, HTML, and JS so old layouts do not conflict with the new one.
- If a page is dense or long, prefer proper scrolling over overlap or hidden actions.
- Keep iconography consistent. Prefer the existing MDI icon system over mixed emoji usage.
- Any non-obvious or icon-only control should expose short hover help, tooltip text, or helper text.
- Do not hide critical safety or destructive behavior behind hover-only messaging.
- Keep analytics quick actions close to the chart they affect. The day-ahead generator area should keep `Generate` and `Export` together, and the quick export should use the currently selected analytics date and interval.

### Inverter Card UI Baseline

- Keep the inverter card hierarchy explicit: `INVERTER XX` title first, compact `Pdc` / `Pac` summary second, node-table data third.
- The PAC strip should remain short: left side keeps horizontal card `Start` / `Stop`, right side uses separate inline `Pdc:` and `Pac:` cells without a `|` separator.
- Do not let node-table typography visually outrank the PAC summary totals.
- PAC legend indicators are fixed signal colors across `dark`, `light`, and `classic`: green, yellow, orange, red, and blinking red for alarm.
- The Bulk Command panel is a card in the inverter grid, placed as the first card before all inverter cards. It participates in grid layout columns and auto-height overrides just like `.inv-card`. Do not revert it to a full-width bar spanning the grid.
- After inverter-card CSS/HTML changes, run the live Electron Playwright smoke before handoff.

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

## User Guide Sync Rule

The User Guide must always match the dashboard's latest version. Any UI change must be accompanied by corresponding documentation updates.

- When any UI element is added, removed, or restructured, update all three User Guide artifacts:
  - HTML guide: `docs/ADSI-Dashboard-User-Guide.html`
  - Markdown manual: `docs/ADSI-Dashboard-User-Manual.md`
  - PDF: `docs/ADSI-Dashboard-User-Guide.pdf` (regenerated from the HTML)
- The User Guide version header must match the `package.json` version baseline.
- PDF regeneration uses Chrome headless: `chrome --headless=new --disable-gpu --no-sandbox --print-to-pdf="<pdf>" --print-to-pdf-no-header "<html>"`
- Do not ship or hand off UI changes when the User Guide still describes older behavior or is missing the new feature.
- When multiple UI changes land in a single session, batch the guide updates but ensure all changes are reflected before handoff.

## Version, Branding, and Release Compatibility

- Always bump `package.json` version before every EXE release build.
- Keep visible version text aligned with `package.json`.
- Keep `SKILL.md`, `CLAUDE.md`, and `MEMORY.md` aligned with the current released version whenever a release baseline changes.
- Always update the markdown docs after the latest release is published so version baselines, release workflow notes, and recent-change records stay current.
- Keep default plant-name fallbacks aligned with the current baseline: `ADSI Plant`.
- Preserve updater compatibility:
  - app ID stays `com.engr-m.inverter-dashboard`
  - GitHub repo stays `mclards/ADSI-Dashboard`
  - release asset name stays compatible:
    - `Inverter-Dashboard-Setup-<version>.exe`
- Keep Windows build icon usage aligned with `icon-256.png`.
- If visible branding changes, audit header, about, footer, and build metadata together.
- Never ship a release when the repo docs still describe an older baseline or older runtime behavior.
- When the user says `publish release` or `publish latest release`, Claude should execute the release workflow directly:
  - rebuild only the affected program EXEs if needed
  - build installer artifacts
  - create or upload the GitHub release itself
  - do not stop at providing commands unless auth, permissions, or network access prevent publishing
- If publishing is blocked, report the exact blocker and then provide only the minimum command(s) the user needs to run.
- Push the release commit and release tag before creating the GitHub release so the published tag resolves to the intended commit.
- If a GitHub release create/upload call times out, inspect GitHub release state before retrying. Do not blindly rerun release creation and risk duplicate or broken draft state.
- Default `publish latest release` behavior:
  - publish installer assets to GitHub
  - do not expect or publish a portable EXE from the current package config

## Storage and Compatibility Paths

Preserve these unless a deliberate migration is implemented:

- License root: `C:\ProgramData\ADSI-InverterDashboard\license`
- License state: `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json`
- License mirror: `C:\ProgramData\ADSI-InverterDashboard\license\license.dat`
- License registry mirror: `HKCU\Software\ADSI\InverterDashboard\License`
- Server and export root: `C:\ProgramData\InverterDashboard`
- Archive root: `C:\ProgramData\InverterDashboard\archive`
- Default export path: `C:\Logs\InverterDashboard`
- Forecast analytics export subfolder: `C:\Logs\InverterDashboard\All Inverters\Forecast\Analytics`
- Forecast Solcast export subfolder: `C:\Logs\InverterDashboard\All Inverters\Forecast\Solcast`
- Forecast export policy: legacy flat `...\Forecast\<file>` results should be relocated into the matching forecast subfolder automatically.
- Forecast export source selector: the Day-Ahead Forecast Export dialog exposes a `Source` dropdown (`Analytics` or `Solcast`). Both share the same `/api/export/forecast-actual` route via a `source` body parameter.
- Forecast export file naming convention — three distinct sources, uniform pattern:
  - **Trained Day-Ahead** (ML-trained model output from `forecast_dayahead`): `Trained Day-Ahead vs Actual <res>` / `Trained Day-Ahead <PTxM> AvgTable 05-18` → saved under `...\Forecast\Analytics`
  - **Solcast Day-Ahead** (stored Solcast API snapshots from `solcast_snapshots`): `Solcast Day-Ahead vs Actual <res>` / `Solcast Day-Ahead <PTxM> AvgTable 05-18` → saved under `...\Forecast\Solcast`
  - **Solcast Toolkit** (live Solcast API preview from Settings page): `Solcast Toolkit <PTxM> 05-18` / `Solcast Toolkit <PTxM> AvgTable 05-18` → saved under `...\Forecast\Solcast`
- Do not merge or confuse the three naming prefixes. Each identifies a different data origin.
- Solcast Toolkit URL construction: the full toolkit chart URL is built server-side from structured settings — operators enter only the Plant Resource ID, Forecast Days (1-7, default 2), and Resolution (PT5M/PT10M/PT15M/PT30M/PT60M, default PT5M). Do not reintroduce a raw URL input field.
- The constructed URL pattern is: `https://api.solcast.com.au/utility_scale_sites/{resourceId}/recent?view=Toolkit&theme=light&hours={days*24}&period={period}`
- Settings keys: `solcastToolkitSiteRef` (resource ID only), `solcastToolkitDays`, `solcastToolkitPeriod`.
- Legacy portable data root for older deployments only: `<portable exe dir>\InverterDashboardData`
- Cloud provider folder: `InverterDashboardBackups`

## Windows Elevation Rule

- The installed Windows app executable must keep `requestedExecutionLevel = requireAdministrator` in `package.json`.
- Treat this as executable-manifest policy, not a shortcut-only preference. The built installed app should always launch elevated by default.
- If this is changed later, call out the operational impact on device access, local service control, and protected-path writes.

## Operating Modes

- `gateway`
  - polls plant locally
  - is the authoritative source of truth for live data, reports, forecasts, chat, and replication snapshots
  - is the only mode allowed to generate day-ahead and intraday-adjusted forecast data
- `remote` (viewer model)
  - is a gateway-backed viewer, not a replicated working copy
  - displays live gateway data in-memory only — no local DB persistence from the live stream
  - historical views, reports, analytics, and exports are served from the gateway via proxy
  - manual Pull ("Refresh Standby DB") downloads the gateway main DB plus the current-day gateway energy baseline for local standby use (applied after restart, for later `gateway`-mode use)
  - push, reconciliation, and startup auto-sync are disabled
  - forecast generation (day-ahead and intraday-adjusted) does not run in any layer
  - when gateway is unavailable, historical pages show "Gateway unavailable" instead of stale local data
  - live bridge health is stateful: `connected`, `degraded`, `stale`, `disconnected`, `auth-error`, or `config-error`
  - short live-bridge failures retain the last-good in-memory snapshot for a bounded window and mark inverter cards stale
  - inverter on/off write control stays enabled via gateway proxy
  - whole-inverter and selected multi-inverter write actions should batch configured node commands per inverter through `/api/write/batch` so gateway control does not pay one full HTTP round trip per node
  - may run local remote-side utilities such as Solcast toolkit test / preview / export
  - switching from remote to gateway warns about stale local DB and should prefer `Refresh Standby DB` plus restart before local gateway use
  - mode changes should stay guarded until the target runtime is actually ready: first remote live snapshot for `remote`, first local poll cycle for `gateway`
  - switching to `gateway` must immediately stop upstream gateway traffic: abort any in-flight remote live/chat/today-energy fetches, close the remote live WebSocket, and stop remote chat polling so the local gateway does not keep listening to another gateway device
  - manual standby pull must stay low-impact on the gateway: reuse the cached main-DB snapshot inside its TTL, avoid forcing a raw-reading day-summary rebuild on every `/api/replication/main-db` request, and keep priority archive pull concurrency at a single file unless there is a measured reason to raise it
  - if a standby pull is blocked by newer local replicated data, fail before the live stream pause and before any heavyweight gateway transfer starts

## Plant Output Cap Rules

- Plant output cap control executes on the `gateway` only. Do not run the controller loop locally on a `remote` workstation.
- In `remote` mode, `/api/plant-cap/status`, `/api/plant-cap/preview`, `/api/plant-cap/enable`, `/api/plant-cap/disable`, and `/api/plant-cap/release` should proxy to the gateway.
- The Inverters-page `Show Cap` toggle must stay usable in `remote` mode because operators still need to inspect status and invoke proxied plant-cap actions.
- If a remote operator sees `404` or `Cannot POST /api/plant-cap/...`, assume an outdated gateway build or a wrong `Remote Gateway URL` / upstream target before changing client logic.
- The current planner is whole-inverter sequential control only.
- Use live inverter `Pac` as the primary shed estimate, and scale the `997.0 kW` rated plus `917.0 kW` dependable baselines by enabled node count for plant-cap planning and stability warnings.
- Exempted inverter numbers must be excluded from automatic stop selection and controllable-step math.
- Only controller-owned stopped inverters may be auto-started again. Manual operator stops remain manual.
- The plant-cap panel defaults collapsed behind the inverter-toolbar `Show Cap` button.
- Plant-cap UI must use shared theme tokens in `dark`, `light`, and `classic`, and plant-cap controls, metrics, warnings, and preview headers should expose hover descriptions.
- Plant-cap controller STOP/START commands are recorded in `audit_log` with `scope = "plant-cap"`. The forecast engine uses this scope to distinguish cap-dispatch curtailment from manual operator stops and faults; see Forecast Training Rules.

## Forecast Training Rules

- The ML forecast engine (`services/forecast_engine.py`) reads `audit_log.scope` to distinguish plant-cap-dispatched STOPs (`scope = "plant-cap"`) from manual / fault-caused STOPs.
- `load_operational_constraint_profile()` tracks two separate per-slot node counts: `commanded_off_nodes` (all stops) and `cap_dispatched_off_nodes` (cap controller only).
- `build_operational_constraint_mask()` exposes `cap_dispatch_mask` (boolean array) and `cap_dispatch_slot_count` in its meta dict alongside the full `operational_mask`.
- For training data collection (`collect_training_data`, `collect_training_data_hardened`):
  - Slots that are cap-dispatch-only (no concurrent manual stop or fault) get their actual output replaced with the physics/hybrid baseline. This preserves high-irradiance training samples that would otherwise be lost.
  - Only manually constrained slots are excluded from the training mask. Cap-reconstructed slots contribute with residual ≈ 0 (baseline − baseline).
- `collect_history_days()` stores `cap_dispatch_mask` per sample so downstream hardened training can reuse it without re-querying.
- `build_intraday_adjusted_forecast()` excludes cap-dispatched observed slots from the actual-vs-dayahead ratio computation so that cap-depressed output does not propagate as under-forecast into remaining slots. Falls back to all observed if too few uncapped observations remain.
- `compute_error_memory()` already excludes all operationally constrained slots (superset of cap-dispatch) from error correction — cap-depressed actuals do not create false negative bias.
- Export-cap curtailment detection (`curtailed_mask`, 24 MW export ceiling) remains a separate mechanism. It catches output clipping at the export limit; plant-cap dispatch curtails below that ceiling via whole-inverter STOP commands.
- Do not remove the `scope` column from `audit_log` or change the plant-cap controller's `scope: "plant-cap"` tag — forecast training depends on it.

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
- Do not expose internal GitHub repo URLs, feed URLs, or API endpoints in user-facing status messages or UI text.
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
```

- Before every release build, clean the workspace `release/` folder so old EXEs, blockmaps, unpacked folders, and transient build leftovers do not accumulate.
- `npm run build:win` and `npm run build:installer` are both installer-only.
- After publishing the latest release, remove prior build leftovers from `release/` and keep only the current installer release assets locally by default.
- Clean installer builds must not embed workstation-local runtime state. Do not package `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, Chromium cache/storage folders, or customer exports into the app build.
- After a clean local installer build, `release/` should contain only the installer EXE, blockmap, and `latest.yml`. Move or remove transient build folders such as `win-unpacked` and `.icon-ico` from `release/`.

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

## Runtime Shutdown and Update Install Rule

- Normal quit, restart, license-expiry shutdown, and `Restart & Install` must use one coordinated shutdown path.
- Do not reintroduce unconditional child-process `taskkill` during restart/update flows. Electron must request a soft stop first and only force-kill as a bounded fallback.
- The shutdown/update contract is:
  - Electron writes a per-service stop file and passes both `IM_SERVICE_STOP_FILE` and `ADSI_SERVICE_STOP_FILE` env vars to child services.
  - The inverter backend must honor the stop file and exit `uvicorn` cleanly.
  - The forecast service must honor the stop file during loop sleeps and before write-heavy forecast steps.
  - Force-kill is allowed only after the bounded grace window expires.
- This protects against stale forecast/runtime state and partial child-service writes during restart or updater install.

## Service EXE Build Rule

- `npm run build:win` only packages the existing `dist/InverterCoreService.exe` and `dist/ForecastCoreService.exe`. It does not rebuild them.
- `npm run build:win` is installer-only and should produce the same artifact set as `npm run build:installer`.
- `better-sqlite3` is runtime-ABI specific:
  - use `npm run rebuild:native:node` before direct shell-Node checks that load `server/db.js`
  - use `npm run rebuild:native:electron` before Electron run/build/release workflows
  - **After any Node-ABI smoke test, always run `npm run rebuild:native:electron`** before launching or building the Electron app. The smoke test rebuilds `better-sqlite3` for plain Node (different ABI), which breaks Electron until restored.
  - if desktop startup reports a `NODE_MODULE_VERSION` mismatch for `better-sqlite3`, fix it with `npm run rebuild:native:electron`
- Some shells in this workspace export `ELECTRON_RUN_AS_NODE=1`.
  - Direct `electron.exe ...` launches and Playwright/Electron probes will behave like plain Node unless that env var is removed.
  - This can produce misleading errors such as `Unable to find Electron app ...`.
  - Clear `ELECTRON_RUN_AS_NODE` or launch through `start-electron.js` semantics before any Electron/UI smoke.
- Before any EXE build, run the required smoke test for the changed surface and do not skip it unless the user explicitly says to skip smoke testing.
  - backend / DB / replication / archive changes: isolated server smoke test
  - Electron shell / preload / startup / packaging-sensitive changes: live Electron startup smoke test
- Browser-side / live Electron UI verification is available via:
  - `Push-Location server/tests`
  - `npx playwright test electronUiSmoke.spec.js --reporter=line`
  - `Pop-Location`
  - Run the Playwright smoke from `server/tests` so duplicate scratch specs under `.tmp/` do not get discovered.
  - This smoke covers dashboard metrics, the Energy Summary Export single-date UI, and Settings connectivity health in the real Electron window.
- Gateway metric authority changes (`TODAY MWh`, `ACTUAL MWh`, WS/HTTP fallback, analytics summary reconciliation) require this exact smoke sequence:
  - `npm run rebuild:native:node`
  - `node server/tests/smokeGatewayLink.js`
  - `node server/tests/modeIsolation.test.js`
  - `npm run rebuild:native:electron`
  - `Push-Location server/tests`
  - `npx playwright test electronUiSmoke.spec.js --reporter=line`
  - `Pop-Location`
- `server/tests/modeIsolation.test.js` proves the mode handoff contract:
  - `remote` mode must open the upstream gateway live WebSocket and chat polling transport
  - switching back to `gateway` must close that WebSocket and stop upstream chat polling/fetches immediately
- Restart/update shutdown changes touching `electron/main.js`, `services/inverter_engine.py`, or `services/forecast_engine.py` require:
  - `node server/tests/serviceSoftStopSource.test.js`
  - `npm run rebuild:native:electron`
  - the Electron Playwright smoke if startup/update behavior or packaging was touched
- Inverter detail panel rule:
  - Do not block initial detail rendering on the 7-day `/api/report/daily` history fetch.
  - Stats and alarms should render first; recent-history loading must be best-effort and bounded by a timeout.
- Whenever changes are made to `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `drivers/modbus_tcp.py`, or either PyInstaller spec, rebuild the affected Python service EXE in `dist/` before any Electron build or release.
- Rebuild only the changed service EXE by default:
  - inverter-service changes -> rebuild `dist/InverterCoreService.exe`
  - forecast-service changes -> rebuild `dist/ForecastCoreService.exe`
  - shared changes that affect both services -> rebuild both EXEs
- If both Python services changed, rebuild both EXEs first, then run the Electron build.
- Do not publish or hand off app EXEs if they were built against stale Python service binaries.
- Release hygiene still applies: clean `release/` before building and remove prior release leftovers after publish.
- Do not assume release-folder cleanup worked. Verify the `release/` folder contents before and after build/publish.
- The default post-publish `release/` folder should contain only:
  - `Inverter-Dashboard-Setup-<version>.exe`
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
  - `latest.yml`
- For `publish latest release`, upload only the installer EXE, blockmap, and `latest.yml` to GitHub.
