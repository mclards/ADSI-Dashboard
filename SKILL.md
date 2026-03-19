# SKILL.md

Project guidance for Codex, Claude, and other coding agents working in `d:\ADSI-Dashboard`.

This file is the canonical project rulebook. Keep `CLAUDE.md` aligned with it whenever this file changes.

## Project Identity

- User-facing product name: `ADSI Inverter Dashboard`
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.4.28` in `package.json`
- Operator-noted deployed server-side app version: `2.2.32`
- Release source of truth for versioning: `package.json`
- GitHub release channel: `mclards/ADSI-Dashboard`

Do not casually rename internal updater identifiers. Visible branding may change, but updater compatibility with installed legacy builds must remain intact unless a deliberate migration is implemented.
Do not treat hardcoded footer/about version strings as source of truth. `package.json` is the repo version source of truth, and deployed server/runtime versions may legitimately lag it.

## Default Credentials and Access Keys

Internal note. Keep this section aligned with the actual code paths and do not copy these defaults into public-facing docs unless the user explicitly asks for that.

- Login default username: `admin`
- Login default password: `1234`
- Login admin auth key for credential change/reset: `ADSI-2026`
- Login reset behavior: using `ADSI-2026` resets the login back to `admin` / `1234`
- Bulk selected inverter control auth key: `sacupsMM`
  - `MM` is the current minute
  - previous minute is also accepted as tolerance
  - applies only to `START SELECTED` / `STOP SELECTED`
  - per-node and per-inverter controls do not require this key
- Topology and IP Configuration auth gate key: `adsiM` or `adsiMM`
  - both pages accept the current minute in unpadded or zero-padded form
  - IP Configuration stores a 1-hour in-window auth session
  - Topology stores a 10-minute in-window auth session
- No built-in default is seeded for:
  - remote gateway API token
  - Solcast API/toolkit credentials
  - OneDrive / Google Drive OAuth credentials
  - cloud-backup provider credentials
- Secret handling rule:
  - do not store live passwords or toolkit credentials in tracked markdown
  - if the user explicitly asks to keep them locally, store them only under a git-ignored path such as `private/*.md`

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

### Current-Day Energy Authority

- `TODAY MWh`, analytics `ACTUAL MWh`, and per-inverter `TODAY ENERGY` must come from server-side `PAC x elapsed time` integration only.
- Do not use Python/modbus register kWh, raw inverter lifetime-energy registers, or Python `/metrics` energy fields as authority for current-day energy totals.
- Python inverter service should stay a raw telemetry acquisition layer for this area: timestamp, PAC, PDC, alarms, node status, and inverter clock fields are acceptable, but current-day energy authority belongs to Node.
- Current-day display, analytics, and export totals must stay aligned by using the same Node-computed current-day snapshot and the same persisted `energy_5min` plus live PAC supplement path.
- If a future change reintroduces energy-like fields in Python, treat them as non-authoritative diagnostics only unless the user explicitly changes this rule.

### Solar Window Persistence Rule

- Backend polling remains active outside the solar window so the live dashboard, connectivity state, and alarm visibility still update.
- Raw poll persistence for `readings` and `energy_5min` must stay inside the solar window only.
- The solar-window gate also applies to graceful shutdown flush behavior. Do not let `flushPending()` persist off-window raw telemetry.
- Alarm and audit persistence are separate from this rule and may still record events outside the solar window when required by operations.

### Alarm Episode and Sound Rules

- Alarm sound is not allowed to trigger for short alarm blips that clear in under 5 seconds.
- Sound eligibility is based on a sustained unacknowledged active alarm episode, not on every transient bitmask change.
- If a node already has an active nonzero alarm value and it changes to a different nonzero value, treat that as the same active alarm episode:
  - update the active alarm row in place
  - preserve acknowledgment state on that row
  - do not emit a fresh raise event solely because the bitmask expanded or changed
  - do not retrigger alarm sound for that node

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
- The local-newer manual-pull guard must compare replicated operational data only. Local-only remote-client `settings` drift must not trigger `LOCAL_NEWER_PUSH_FAILED`.
- Manual-pull preflight must finish before pausing the live stream or starting any main-DB or archive transfer. A blocked pull should fail fast and stay low-impact on the gateway.
- If the operator explicitly chooses `Force Pull`, reuse the successful preflight when available and skip redundant gateway-summary round trips so standby refresh adds the minimum extra load to the gateway.
- Use chunked push uploads to avoid HTTP `413`.
- When replacing the main DB from the gateway, preserve only the explicit local-only remote settings on the client machine: operation mode, remote auto-sync flag, gateway URL/token, tailnet hint/interface, `csvSavePath`, and `operatorName`.
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
- Any failed or cancelled standby pull must discard staged main-DB and archive replacement manifests plus temp downloads immediately. Do not leave pending replacements behind after a bad transfer.

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

### Inverter Card UI Baseline

- Keep the inverter card visual hierarchy obvious: `INVERTER XX` title first, compact `Pdc` / `Pac` summary second, node-table data third.
- The compact PAC strip should stay short and operational: left side keeps horizontal card `Start` / `Stop`, right side uses separate inline `Pdc:` and `Pac:` cells without a `|` separator.
- Do not let node-table font sizing overpower the PAC summary totals.
- PAC legend indicators are fixed signal colors across all themes: green, yellow, orange, red, and blinking red for alarm.
- The Bulk Command panel is a card in the inverter grid, placed as the first card before all inverter cards. It participates in grid layout columns and auto-height overrides just like `.inv-card`. Do not revert it to a full-width bar spanning the grid.
- After inverter-card CSS/HTML changes, run the live Electron Playwright smoke before handing off the change.

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

## Security and Privacy Rules

- Do not expose secrets, private keys, OAuth internals, signing details, or sensitive debugging information in the renderer unless explicitly required.
- Do not expose internal GitHub repo URLs, feed URLs, or API endpoints in user-facing status messages or UI text.
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
- Always update the markdown docs after the latest release is published so release workflow notes, version baselines, and recent-change records stay current.
- Keep default plant-name fallbacks aligned with the current baseline: `ADSI Plant`.
- Keep updater compatibility intact:
  - app ID stays `com.engr-m.inverter-dashboard`
  - release asset names stay compatible with existing updater expectations
  - GitHub release channel remains `mclards/ADSI-Dashboard`
- Never publish new installer or portable artifacts under an unchanged version.
- Every build release must append the latest app version to the release artifacts and release metadata.
- Never ship a release when the repo docs still describe an older baseline or older runtime behavior.
- When the user says `publish release` or `publish latest release`, the agent should perform the release workflow directly:
  - rebuild only the affected program EXEs if needed
  - build the installer release artifacts
  - create or upload the GitHub release itself
  - avoid stopping at copy-paste commands unless GitHub auth, repo permissions, or network access blocks execution
- If release publishing is blocked by auth, permissions, or network issues, state the exact blocker and then provide the minimal command(s) needed for the user to finish it.
- Push the release commit and the release tag before creating the GitHub release so the published tag always resolves to the intended commit.
- If a GitHub release create/upload call times out, inspect GitHub release state before retrying. Do not blindly rerun release creation and risk duplicate or broken draft state.
- Default publish behavior for `publish latest release`:
  - publish installer assets to GitHub
  - do not expect or publish a portable EXE from the current package config

## Build and Artifact Rules

Expected default GitHub release artifacts:

- `release/Inverter-Dashboard-Setup-<version>.exe`
- `release/Inverter-Dashboard-Setup-<version>.exe.blockmap`
- `release/latest.yml`

Do not include local-only license-generator builds in GitHub app releases unless explicitly requested.

- Before every release build, clean the workspace `release/` folder so old EXEs, blockmaps, unpacked folders, and transient build leftovers do not stack up.
- After publishing the latest release, remove previous build leftovers from `release/` and keep only the current installer release assets locally by default.
- Do not assume a cleanup command worked. Verify the `release/` folder contents before and after build/publish.
- Clean installer builds must not embed local runtime state. Do not package workstation-local `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, Chromium cache/storage folders, or customer exports into the app build.
- After a clean local installer build, `release/` should contain only the installer EXE, blockmap, and `latest.yml`. Move or remove transient build folders such as `win-unpacked` and `.icon-ico` from `release/`.
- The default post-publish `release/` folder should contain only:
  - `Inverter-Dashboard-Setup-<version>.exe`
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
  - `latest.yml`

Default release build commands:

```powershell
npm run rebuild:native:electron
npm run build:installer
```

`npm run build:win` and `npm run build:installer` are both installer-only.

## File and Directory Consistency

Preserve these storage and compatibility paths unless a migration is intentionally implemented:

- License root: `C:\ProgramData\ADSI-InverterDashboard\license`
- License mirror file: `C:\ProgramData\ADSI-InverterDashboard\license\license.dat`
- License state: `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json`
- License registry mirror: `HKCU\Software\ADSI\InverterDashboard\License`
- Server and export data root: `C:\ProgramData\InverterDashboard`
- Archive root: `C:\ProgramData\InverterDashboard\archive`
- Default export path: `C:\Logs\InverterDashboard`
- Forecast analytics export subfolder: `C:\Logs\InverterDashboard\All Inverters\Forecast\Analytics`
- Forecast Solcast export subfolder: `C:\Logs\InverterDashboard\All Inverters\Forecast\Solcast`
- Forecast export policy: legacy flat `...\Forecast\<file>` paths must be repaired into the correct forecast subfolder automatically.
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
- OneDrive and Google Drive backup folder name: `InverterDashboardBackups`

## Windows Elevation Rule

- The installed Windows app executable must keep `requestedExecutionLevel = requireAdministrator` in `package.json`.
- Treat this as packaging policy, not an optional shortcut tweak. The manifest should make Windows launch the installed app elevated by default.
- If the user later asks to relax elevation, change it deliberately and call out the operational impact on device access, local service control, and protected-path writes.

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
- While plant-cap monitoring is enabled, all non-exempted inverters are under controller authority. Manual control for non-exempted inverters must be blocked at the API layer with an operator-facing warning instead of pausing the controller after the fact.
- Restart planning may use any fresh stopped non-exempt inverter; controller-owned stops are still tracked separately for release order and forecast history.
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
- Export-cap curtailment detection (`curtailed_mask`) remains a separate mechanism. It catches output clipping at the configured forecast export ceiling (`forecastExportLimitMw`, default `24 MW`); plant-cap dispatch curtails below that ceiling via whole-inverter STOP commands.
- Do not remove the `scope` column from `audit_log` or change the plant-cap controller's `scope: "plant-cap"` tag — forecast training depends on it.

### Per-Inverter Transmission Loss Rules

- The IP Config page exposes a per-inverter `Loss %` field (0-100) representing MW transmission loss from inverter to substation (cable degradation, distance).
- Telemetry ownership is also anchored by IP Config: live frames are matched by configured inverter IP address plus configured node number, not by any assumed IP-numbering pattern.
- Dashboard labels may show `INV-xx` plus the configured inverter IP so operators can verify the binding visually.
- Loss factors are stored in `ipconfig.json` as `losses: { "1": 2.5, "2": 2.5, ... }` and persisted via the `ipConfigJson` settings key.
- Default loss is `2.5%` per inverter when the config omits a `losses` value; operators can still explicitly set any inverter to `0`.
- Loss factors are used exclusively by the forecast engine for substation-level accuracy. They must never alter raw inverter telemetry, dashboard display, health metrics, or energy exports.
- Forecast-engine consumers that use loss-adjusted actuals (`load_actual_loss_adjusted`, `load_actual_loss_adjusted_with_presence`):
  - `collect_training_data()` and `collect_history_days()` (feeds `collect_training_data_hardened`)
  - `compute_error_memory()` (bias correction)
  - `build_intraday_adjusted_forecast()` (intraday ratio)
  - `forecast_qa()` (QA scoring)
  - `run_backtest()` (backtest comparison)
  - `build_solcast_reliability_artifact()` / Solcast reliability scoring, because Solcast snapshots are already substation-level
  - `plant_capacity_profile()` returns `loss_adjusted_equiv`, `dependable_kw`, and `max_kw` reflecting losses so the physics baseline ceiling is consistent.
- Solcast reliability artifacts now also carry unit-tagged weather-bucket resolution history comparing `Solcast vs loss-adjusted actual` and `day-ahead vs loss-adjusted actual`; raw Solcast arrives in `MW` and is normalized onto the common `kWh per 5-minute slot` basis for those comparisons.
- Those resolution profiles feed both runtime Solcast blend/damping and ML features (`solcast_resolution_weight`, `solcast_resolution_support`), so weather-class source preference is learned rather than hardcoded.
- Raw `load_actual()` remains for non-forecast consumers and for the zero-loss fast path.
- When all losses are explicitly `0`, loss-adjusted loaders short-circuit to the cached raw `load_actual()` with zero overhead.
- `_cached_loss_factors` is a module-level snapshot refreshed each cycle via `clear_forecast_data_cache()`. Both `load_actual_loss_adjusted` and `load_actual_loss_adjusted_with_presence` are LRU-cached alongside the raw loaders.
- `_query_energy_5min_loss_adjusted()` queries per-inverter `energy_5min` rows and applies `kwh * (1 - loss_fraction)` before summing into plant-level 5-min totals. The original `_query_energy_5min_totals()` remains raw.

### Day-Ahead Auto-Generation Rules

- The Python forecast service (`services/forecast_engine.py`) runs a continuous main loop checking every 60 seconds.
- **Primary scheduled runs** at hours 6 and 18 (`DA_RUN_HOURS_PRIMARY = {6, 18}`): always retrain + generate, regardless of whether the day-ahead already exists.
- **Post-solar constant checker**: outside the solar window (18:00-04:59), every 60-second loop verifies that tomorrow's day-ahead exists in DB. If missing, it generates. If it disappears after being generated, it regenerates. During the solar window (05:00-17:59) the checker is inactive.
- **Recovery**: if today's forecast is missing during solar hours, the service generates it immediately.
- **Failure backoff**: after a failed generation attempt, the post-solar checker enters exponential cooldown (5 min, 10 min, 20 min, capped at 30 min). Primary scheduled runs bypass the cooldown. Cooldown resets on success.
- **Node.js cron fallback**: `server/index.js` schedules cron jobs at 18:30, 20:00, and 22:00 that check if tomorrow's day-ahead exists in DB and trigger a one-shot ML forecast CLI generation if missing. This provides a safety net when the Python forecast service is not running.
- Do not remove the dual-layer safety net (Python service + Node.js cron). Both layers are needed because the Python service can crash and the Node.js server may outlive it.
- Forecast generation in `remote` mode is always skipped (viewer model).

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

## Runtime Shutdown and Update Install Rule

- Normal quit, restart, license-expiry shutdown, and `Restart & Install` must go through one coordinated shutdown path.
- Do not reintroduce unconditional child-process `taskkill` during restart/update flows. The Electron shell must request a soft stop first and only force-kill as a bounded fallback.
- The restart/update contract is:
  - Electron writes a per-service stop file and passes both `IM_SERVICE_STOP_FILE` and `ADSI_SERVICE_STOP_FILE` env vars to child services.
  - The inverter backend must honor the stop file and exit `uvicorn` cleanly.
  - The forecast service must honor the stop file during loop sleeps and before write-heavy forecast steps.
  - Force-kill is allowed only after the bounded grace window expires.
- This protects against stale forecast/runtime state and partial child-service writes during restart or updater install.

## Service EXE Build Rule

- `npm run build:win` only packages the existing `dist/InverterCoreService.exe` and `dist/ForecastCoreService.exe`. It does not rebuild them.
- `npm run build:win` is now installer-only and should generate the same artifact set as `npm run build:installer`.
- `better-sqlite3` is runtime-ABI specific:
  - use `npm run rebuild:native:node` before direct shell-Node checks that load `server/db.js`
  - use `npm run rebuild:native:electron` before Electron run/build/release workflows
  - **After any Node-ABI smoke test, always run `npm run rebuild:native:electron`** before launching or building the Electron app. The smoke test rebuilds `better-sqlite3` for plain Node (different ABI), which breaks Electron until restored.
  - if desktop startup reports a `NODE_MODULE_VERSION` mismatch for `better-sqlite3`, rebuild with `npm run rebuild:native:electron`
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
- For `publish latest release`, build the installer release and publish only:
  - `Inverter-Dashboard-Setup-<version>.exe`
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
  - `latest.yml`
- Do not expect or upload a portable EXE from the current package config.
- Release hygiene still applies: clean `release/` before building and remove prior release leftovers after publish.
