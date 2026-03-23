# SKILL.md

Project guidance for Codex, Claude, and other coding agents working in `d:\ADSI-Dashboard`.

This file is the canonical project rulebook. Keep `CLAUDE.md` and `AGENTS.md` aligned with it whenever this file changes.

Copies of this file must be kept in sync at:
- `d:\ADSI-Dashboard\SKILL.md` (repo root — this file)
- `.agents/skills/adsi-dashboard/SKILL.md` (Codex)
- `.claude/skills/adsi-dashboard/SKILL.md` (Claude Code)

`references/frontend-patterns.md` under both agent skill paths is superseded by the inline Frontend Patterns section below.

---

## Project Identity

- User-facing product name: `ADSI Inverter Dashboard`
- Author: Engr. Clariden Montaño REE (Engr. M.)
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.4.37` in `package.json`
- Latest published GitHub release: `v2.4.37`
- Operator-noted deployed server-side app version: `2.2.32`
- Release source of truth for versioning: `package.json`
- GitHub release channel: `mclards/ADSI-Dashboard`
- Default plant name fallback: `ADSI Plant`

Do not casually rename internal updater identifiers. Visible branding may change, but updater compatibility with installed legacy builds must remain intact unless a deliberate migration is implemented.
Do not treat hardcoded footer/about version strings as source of truth. `package.json` is the repo version source of truth, and deployed server/runtime versions may legitimately lag it.

---

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

---

## Core Stack

- Electron 29 desktop shell
- Express 4 API server in `server/index.js`, port 3500
- Python inverter core service — FastAPI port 9000, Modbus TCP
- Python forecast service — ML day-ahead and intraday engine
- SQLite via `better-sqlite3`
- Frontend vanilla JS + Chart.js 4 in `public/index.html`, `public/js/app.js`, `public/css/style.css`

---

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

---

## Non-Negotiable Priorities

1. Do not break live polling, write control, replication, reporting, export, backup, restore, licensing, or update flows.
2. In `remote` mode, treat the gateway as source of truth.
3. Preserve updater compatibility with old app releases.
4. Keep UI compact, readable, and consistent across `dark`, `light`, and `classic`.
5. Treat credentials, license internals, archives, and user data as sensitive.

---

## Data Architecture Rules

The project uses a hot/cold telemetry model. Keep future work aligned with that model.

- Hot DB: main SQLite file under `C:\ProgramData\InverterDashboard`
- Cold DBs: monthly archive SQLite files under `C:\ProgramData\InverterDashboard\archive`
- Hot telemetry tables:
  - `readings`
  - `energy_5min`
- Persistent summary/report tables kept in the main DB:
  - `daily_report`
  - `daily_readings_summary`
  - alarms, audit, forecast, settings, and other operational tables
- Forecast comparison tables (written by Python QA, read by error-memory selection):
  - `forecast_run_audit` — one row per generation run per target date; stores provenance, freshness class, run status, daily totals
  - `forecast_error_compare_daily` — per-day QA comparison rows with run linkage, eligibility flags (`include_in_error_memory`, `include_in_source_scoring`), quality status
  - `forecast_error_compare_slot` — per-slot QA comparison rows with mask flags, support weights, weather-bucket markers, `usable_for_error_memory`

### Current-Day Energy Authority

- `TODAY MWh`, analytics `ACTUAL MWh`, and per-inverter `TODAY ENERGY` must come from server-side `PAC x elapsed time` integration only.
- Do not use Python/modbus register kWh, raw inverter lifetime-energy registers, or Python `/metrics` energy fields as authority for current-day energy totals.
- Python inverter service stays a raw telemetry acquisition layer: timestamp, PAC, PDC, alarms, node status, and inverter clock fields are acceptable, but current-day energy authority belongs to Node.
- Current-day display, analytics, and export totals must stay aligned by using the same Node-computed current-day snapshot and the same persisted `energy_5min` plus live PAC supplement path.

### Solar Window Persistence Rule

- Backend polling remains active outside the solar window so the live dashboard, connectivity state, and alarm visibility still update.
- Raw poll persistence for `readings` and `energy_5min` must stay inside the solar window only.
- The solar-window gate also applies to graceful shutdown flush behavior. Do not let `flushPending()` persist off-window raw telemetry.
- Alarm and audit persistence are separate from this rule and may still record events outside the solar window.

### Alarm Episode and Sound Rules

- Alarm sound is not allowed to trigger for short alarm blips that clear in under 5 seconds.
- Sound eligibility is based on a sustained unacknowledged active alarm episode, not on every transient bitmask change.
- If a node already has an active nonzero alarm value and it changes to a different nonzero value, treat that as the same active alarm episode:
  - update the active alarm row in place
  - preserve acknowledgment state on that row
  - do not emit a fresh raise event solely because the bitmask expanded or changed
  - do not retrigger alarm sound for that node

### Alarm Quick-ACK Pattern

- Alarm toast notifications use `showAlarmToast()`, not the generic `showToast()`. `showAlarmToast` renders a `.toast-hdr-actions` row with an inline **ACK** button (`.toast-ack-btn`) alongside the dismiss button.
- The notification bell panel (`#notifPanel`) renders a `.notif-footer` row per alarm entry containing the timestamp and a `.notif-ack-btn` button for unacknowledged alarms, or a `.notif-acked` label for already-acknowledged ones.
- Both ACK paths call `ackAlarm(id, btn)` which POSTs to `/api/alarms/:id/ack`, refreshes the badge, and syncs sound state.
- Toast TTL is 12 s. After ACK from a toast, the toast auto-dismisses after 1.2 s.
- Do not bypass this pattern and reintroduce a generic `showToast()` call for alarms — the ACK button would be lost.

### SQLite Performance Rules

- The hot DB uses WAL mode with `synchronous = NORMAL`. Do not change this to `FULL`.
- The poller uses `bulkInsertWithSummary()` to combine reading inserts and daily summary upserts in a single transaction. Do not split these back into separate transactions.
- `pruneOldData()` and `archiveTelemetryBeforeCutoff()` are async and yield the event loop (`setImmediate`) between batches of 5,000 rows. Do not convert these back to synchronous blocking loops.
- Routine WAL checkpoints during operation must use `PASSIVE` mode. Only use `TRUNCATE` during `closeDb()` at app shutdown.
- Long-running DB operations must yield control between batches so the event loop can process WebSocket frames and HTTP requests.

### Retention

- `retainDays` controls how long raw `readings` and `energy_5min` stay hot in the main DB.
- Old raw telemetry must be archived, not simply discarded.
- Archived telemetry must remain readable for historical analytics, exports, and report rebuilds.

### Historical Read Rules

- Use archive-aware helpers when reading historical telemetry:
  - `queryReadingsRange(All)`
  - `queryEnergy5minRange(All)`
  - `sumEnergy5minByInverterRange()`
- Do not add new direct SQL scans over hot-only `readings` or `energy_5min` for date ranges that may cross retention boundaries.

### Daily Report Strategy

- For past days, prefer persisted `daily_report` rows.
- Rebuild past daily reports only when rows are missing, refresh is explicitly requested, or repair is intentional.
- Use `daily_readings_summary` as the normal source for inverter/day/unit uptime and PAC rollups.
- Daily report exports keep one row per inverter per day then one `TOTAL` row.
- Do not fake plant `Peak Pac` or `Avg Pac` totals by summing inverter peak or average values.

### Replication and Archive Guardrails

- Manual `Pull` is download-only: check if local data is newer than the gateway, and if so stop with `LOCAL_NEWER_PUSH_FAILED` — never push data as a side effect of pull. If allowed to proceed, download a transactionally consistent gateway `adsi.db` snapshot and stage it for restart-safe local replacement.
- Manual `Push` is upload-only: send local replicated hot-data delta to the gateway, optionally upload local archive files. Push must not pull the gateway DB back down or stage a local DB replacement. Push does not require restart.
- Remote startup auto-sync must stay read-only toward the gateway.
- The local-newer manual-pull guard must compare replicated operational data only. Local-only remote-client `settings` drift must not trigger `LOCAL_NEWER_PUSH_FAILED`.
- Manual-pull preflight must finish before pausing the live stream or starting any main-DB or archive transfer.
- Never copy the live gateway `adsi.db` file directly. Flush pending in-memory telemetry first, then export a consistent SQLite snapshot and transfer that snapshot file.
- Keep replication transport optimized:
  - reuse HTTP connections for gateway transfer requests
  - allow gzip compression for large replication JSON payloads and large main-DB / archive downloads
  - keep push uploads chunked and allow gzip request bodies for large JSON push batches
  - archive pull/push may run with small bounded concurrency but do not remove restart-safe staging
- Boost HTTP socket pool to `REMOTE_FETCH_MAX_SOCKETS_REPLICATION` (16) during manual pull/push; restore default (8) afterward in try/finally.
- Archive file downloads support HTTP Range requests (resume-on-failure). Gateway serves `Accept-Ranges: bytes` + 206 Partial Content. Client retries up to 3 times, resuming from the partial temp file.
- After a main-DB pull, persist the gateway's `x-main-db-cursors` response header so incremental sync converges correctly.
- Never rehydrate the hot DB with inbound telemetry older than the local hot cutoff. Write stale inbound rows directly into the local archive.
- Archive DB replacement must be restart-safe: stage pulled replacements as temp files, apply only during startup before the server begins serving requests.
- Any failed or cancelled standby pull must discard staged main-DB and archive replacement manifests plus temp downloads immediately.

---

## UX and Theming Rules

When adding, removing, or restructuring UI:

- Use shared theme tokens: `--bg`, `--surface`, `--surface2`, `--border`, `--border2`, `--text`, `--text2`, `--text3`, `--accent`.
- Avoid hardcoded one-off colors for reusable panels, forms, cards, toolbars, status chips, and action bars.
- Validate every component conceptually against all three themes (`dark`, `light`, `classic`).
- Remove stale CSS, HTML, and JS when replacing an older UI pattern. Do not leave dead layouts, orphan selectors, or unused controls behind.
- If a page is dense or long, make the right area scrollable instead of allowing overlap or hidden actions.
- Keep analytics quick actions close to the chart they affect.

### Inverter Card UI Baseline

- Keep the inverter card visual hierarchy obvious: `INVERTER XX` title first, compact `Pdc` / `Pac` summary second, node-table data third.
- The compact PAC strip: left side keeps horizontal card `Start` / `Stop`, right side uses separate inline `Pdc:` and `Pac:` cells without a `|` separator.
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

The existing `#page-inverters` uses `.inv-page-body` for this pattern.

### Icons, Logos, and Visual Consistency

- Use the existing MDI icon system for navigation, settings, actions, and status wherever possible.
- Do not mix emoji icons with MDI icons in the same workflow.
- If the app icon, brand logo, or visible product name changes, update all affected surfaces together: `package.json` build metadata, header/about/footer branding, installer icon references.
- Current Windows build icon reference: `icon-256.png`

### Hover Help and User Guidance

- Any icon-only action or non-obvious control should expose short hover help, tooltip text, or inline helper text.
- Use hover info for controls with operational consequences, technical abbreviations, or hidden assumptions.
- Keep hover text concise and operational. Prefer "what this does" and "why it matters".
- Do not rely on hover only for critical safety information. Pair it with visible labels when the action is destructive or high impact.

---

## User Guide Sync Rule

The User Guide must always match the dashboard's latest version. Any UI change must be accompanied by corresponding documentation updates.

- Update all three User Guide artifacts when any UI element is added, removed, or restructured:
  - HTML guide: `docs/ADSI-Dashboard-User-Guide.html`
  - Markdown manual: `docs/ADSI-Dashboard-User-Manual.md`
  - PDF: `docs/ADSI-Dashboard-User-Guide.pdf` (regenerated from the HTML)
- The User Guide version header must match the `package.json` version baseline.
- PDF regeneration: `chrome --headless=new --disable-gpu --no-sandbox --print-to-pdf="<pdf>" --print-to-pdf-no-header "<html>"`
- Do not ship or hand off UI changes when the User Guide still describes older behavior or is missing the new feature.

---

## Security and Privacy Rules

- Do not expose secrets, private keys, OAuth internals, signing details, or sensitive debugging information in the renderer.
- Do not expose internal GitHub repo URLs, feed URLs, or API endpoints in user-facing status messages or UI text.
- Do not add logs that print tokens, OAuth responses, license payload internals, or personally sensitive data.
- Treat exported configuration files and archived operational data as sensitive.

---

## GitHub Repo Hygiene

- Do not commit secrets, tokens, OAuth client secrets, private keys, signing keys, local database snapshots, local auth caches, archive DB copies, portable runtime data, or customer-specific exports.
- Before push or release, review staged files for accidental sensitive content and stale generated artifacts.
- Exclude local machine config such as `ipconfig.json` and `server/ipconfig.json` from normal commits and GitHub releases.

---

## Versioning and Release Rules

- Always bump `package.json` version before building any release EXE.
- Keep visible version text aligned with `package.json`.
- Keep `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, and `MEMORY.md` aligned with the current released version whenever a release baseline changes.
- Always update the markdown docs after the latest release is published so release workflow notes, version baselines, and recent-change records stay current.
- Keep updater compatibility intact:
  - app ID stays `com.engr-m.inverter-dashboard`
  - GitHub release channel remains `mclards/ADSI-Dashboard`
  - release asset name stays compatible: `Inverter-Dashboard-Setup-<version>.exe`
- Push the release commit and the release tag before creating the GitHub release so the published tag always resolves to the intended commit.
- If a GitHub release create/upload call times out, inspect GitHub release state before retrying. Do not blindly rerun release creation and risk duplicate or broken draft state.
- When the user says `publish release` or `publish latest release`, the agent should perform the release workflow directly:
  - rebuild only the affected program EXEs if needed
  - build the installer release artifacts
  - create or upload the GitHub release itself
  - avoid stopping at copy-paste commands unless GitHub auth, repo permissions, or network access blocks execution
- Default publish behavior: publish installer assets to GitHub only — do not expect or publish a portable EXE from the current package config.

---

## Build and Artifact Rules

Expected default GitHub release artifacts:

- `release/Inverter-Dashboard-Setup-<version>.exe`
- `release/Inverter-Dashboard-Setup-<version>.exe.blockmap`
- `release/latest.yml`

- Before every release build, clean the workspace `release/` folder.
- After publishing the latest release, remove previous build leftovers from `release/` and keep only the current installer release assets locally.
- Do not assume a cleanup command worked. Verify `release/` contents before and after build/publish.
- Clean installer builds must not embed local runtime state: do not package `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, Chromium cache/storage folders, or customer exports into the app build.

Default release build commands:

```powershell
npm run rebuild:native:electron
npm run build:installer
```

`npm run build:win` and `npm run build:installer` are both installer-only.

---

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
- Forecast export file naming convention — three distinct sources, do not merge or confuse prefixes:
  - **Trained Day-Ahead** (ML output from `forecast_dayahead`): `Trained Day-Ahead vs Actual <res>` / `Trained Day-Ahead <PTxM> AvgTable 05-18` → saved under `...\Forecast\Analytics`
  - **Solcast Day-Ahead** (stored snapshots from `solcast_snapshots`): `Solcast Day-Ahead vs Actual <res>` / `Solcast Day-Ahead <PTxM> AvgTable 05-18` → saved under `...\Forecast\Solcast`
  - **Solcast Toolkit** (live API preview from Settings page): `Solcast Toolkit <PTxM> 05-18` / `Solcast Toolkit <PTxM> AvgTable 05-18` → saved under `...\Forecast\Solcast`
- Solcast Toolkit URL construction: built server-side from structured settings — operators enter only Plant Resource ID, Forecast Days (1-7, default 2), and Resolution (PT5M/PT10M/PT15M/PT30M/PT60M, default PT5M). Do not reintroduce a raw URL input field.
- Constructed URL pattern: `https://api.solcast.com.au/utility_scale_sites/{resourceId}/recent?view=Toolkit&theme=light&hours={days*24}&period={period}`
- Settings keys: `solcastToolkitSiteRef` (resource ID only), `solcastToolkitDays`, `solcastToolkitPeriod`.
- Legacy portable data root for older deployments only: `<portable exe dir>\InverterDashboardData`
- OneDrive and Google Drive backup folder name: `InverterDashboardBackups`

---

## Windows Elevation Rule

- The installed Windows app executable must keep `requestedExecutionLevel = requireAdministrator` in `package.json`.
- Treat this as packaging policy. The manifest should make Windows launch the installed app elevated by default.

---

## Current Operating Modes

- `gateway`
  - polls plant locally
  - is the authoritative source of truth for live data, reports, forecasts, chat, and replication snapshots
  - is the only mode allowed to generate day-ahead and intraday-adjusted forecast data
- `remote` (viewer model)
  - is a gateway-backed viewer, not a replicated working copy
  - displays live gateway data in-memory only — no local DB persistence from the live stream
  - historical views, reports, analytics, and exports are served from the gateway via proxy
  - manual Pull ("Refresh Standby DB") downloads the gateway main DB plus the current-day gateway energy baseline for local standby use (applied after restart)
  - forecast generation does not run in any layer
  - live bridge health is stateful: `connected`, `degraded`, `stale`, `disconnected`, `auth-error`, or `config-error`
  - short live-bridge failures retain the last-good in-memory snapshot for a bounded window and mark inverter cards stale
  - inverter on/off write control stays enabled via gateway proxy
  - whole-inverter and selected multi-inverter write actions should batch configured node commands per inverter through `/api/write/batch`
  - switching to `gateway` must immediately stop upstream gateway traffic: abort any in-flight remote live/chat/today-energy fetches, close the remote live WebSocket, and stop remote chat polling
  - manual standby pull must stay low-impact on the gateway: reuse the cached main-DB snapshot inside its TTL, keep priority archive pull concurrency at a single file

---

## Plant Output Cap Rules

- Plant output cap control executes on the `gateway` only. Do not run the controller loop locally on a `remote` workstation.
- In `remote` mode, proxy all `/api/plant-cap/*` routes to the gateway.
- The Inverters-page `Show Cap` toggle must stay usable in `remote` mode.
- The current planner is whole-inverter sequential control only.
- Use live inverter `Pac` as the primary shed estimate, and scale the `997.0 kW` rated plus `917.0 kW` dependable baselines by enabled node count for planning and stability warnings.
- Exempted inverter numbers must be excluded from automatic stop selection and controllable-step math.
- While plant-cap monitoring is enabled, all non-exempted inverters are under controller authority. Manual control for non-exempted inverters must be blocked at the API layer with an operator-facing warning.
- The plant-cap panel defaults collapsed behind the inverter-toolbar `Show Cap` button.
- Plant-cap UI must use shared theme tokens in `dark`, `light`, and `classic`, and controls should expose hover descriptions.
- Plant-cap controller STOP/START commands are recorded in `audit_log` with `scope = "plant-cap"`.

---

## Forecast Training Rules

- The ML forecast engine (`services/forecast_engine.py`) reads `audit_log.scope` to distinguish plant-cap-dispatched STOPs (`scope = "plant-cap"`) from manual / fault-caused STOPs.
- `load_operational_constraint_profile()` tracks two separate per-slot node counts: `commanded_off_nodes` (all stops) and `cap_dispatched_off_nodes` (cap controller only).
- `build_operational_constraint_mask()` exposes `cap_dispatch_mask` (boolean array) and `cap_dispatch_slot_count` alongside the full `operational_mask`.
- For training data collection:
  - Slots that are cap-dispatch-only get their actual output replaced with the physics/hybrid baseline, preserving high-irradiance training samples.
  - Only manually constrained slots are excluded from the training mask.
- `collect_history_days()` stores `cap_dispatch_mask` per sample so downstream hardened training can reuse it.
- `build_intraday_adjusted_forecast()` excludes cap-dispatched observed slots from the actual-vs-dayahead ratio computation.
- `compute_error_memory()` excludes all operationally constrained slots from error correction.
- Export-cap curtailment detection (`curtailed_mask`) remains a separate mechanism using `forecastExportLimitMw` (default `24 MW` — configurable from settings, not hardcoded).
- Do not remove the `scope` column from `audit_log` or change the plant-cap controller's `scope: "plant-cap"` tag.

### Solcast Authority and Usage

Solcast is a **high-authority input** — it carries real irradiance and sky-condition data the ML model cannot derive on its own. It must not be skipped or treated as optional when available.

**In ML training:**
- `collect_training_data()` and `collect_history_days()` must consume Solcast snapshot data as a training feature when available for the target date.
- Do not fall back to pure physics baseline when Solcast snapshots exist — Solcast-informed samples produce more accurate residual learning.
- `build_solcast_reliability_artifact()` builds multi-dimensional trust scores across weather regime, weather bucket, season (dry/wet), time-of-day (morning/midday/afternoon), and trend — feeding `solcast_resolution_weight` and `solcast_resolution_support` as ML features. Keep these populated.

**In day-ahead generation (manual and automatic):**
- Always attempt to load Solcast snapshots for the target date before generating.
- Variant priority order: `solcast_direct` → `ml_solcast_hybrid_fresh` → `ml_solcast_hybrid_stale` → `ml_without_solcast` (last resort only).
- Only fall back to `ml_without_solcast` when Solcast snapshots are genuinely missing or `stale_reject` for the target date.
- Do not skip Solcast loading as an optimization — a run that silently omits available Solcast produces an inferior forecast and may trigger quality-class `wrong_provider` on the next check.

**Normalization:**
- Raw Solcast arrives in `MW` — always normalize to `kWh per 5-minute slot` before scoring, blending, or comparison.
- `build_solcast_reliability_artifact()` compares Solcast against `load_actual_loss_adjusted()` at 5-min slot resolution — never against raw inverter totals or day-level aggregates only.

**Reliability dimensions (v2.4.33+):**
- **Season**: dry (Dec-May) vs wet (Jun-Nov) — `lookup_solcast_reliability(artifact, regime, season=)` checks `season_regimes["{season}:{regime}"]` first
- **Time-of-day**: morning (05:00-08:55), midday (09:00-14:55), afternoon (15:00-17:55) — per-slot blend and floor modulated by zone reliability
- **Trend**: 30-day window split into recent/older halves — `improving`/`stable`/`degrading` signal affects blend weight (±6-8%) and residual damping

### Provider Orchestration Architecture

**Node owns provider routing and Solcast fetch decisions. Python owns ML execution, training, QA, and error correction.** This boundary must not be blurred.

The Python scheduler resolves the target date and trigger reason, then delegates generation to the shared Node orchestrator via an internal route (e.g. `/api/internal/forecast/generate-auto`). Node applies the same provider logic for automatic generation as for manual generation.

Provider routing rules:
- If `forecastProvider=solcast`: both manual and automatic must use `solcast_direct` path. If direct Solcast fails and fallback is permitted, record the failure explicitly — do not present ML output as equivalent.
- If `forecastProvider=ml_local` and Solcast is configured: both manual and automatic must refresh snapshot before running Python ML.
- If `forecastProvider=ml_local` and Solcast is not configured: ML may proceed; audit row must mark `forecast_variant='ml_without_solcast'` and `solcast_snapshot_coverage_ratio=0`.

Snapshot freshness classes: `fresh` (coverage ≥ 0.95, pulled within 2 h), `stale_usable` (coverage ≥ 0.80, pulled within 12 h), `stale_reject`, `missing`, `not_expected`.

Fallback quality classes: `missing`, `incomplete`, `wrong_provider`, `stale_input`, `weak_quality`, `healthy`. Only `healthy` suppresses regeneration — a complete rowset alone is not sufficient.

Run authority order: `solcast_direct` > `ml_solcast_hybrid_fresh` > `ml_solcast_hybrid_stale` > `ml_without_solcast`. One run per target date is marked `authoritative_for_learning=1`.

Implementation work packages:
- WP1: shared Node orchestrator; Python scheduler delegates via internal route; parity tests
- WP2: `forecast_run_audit` table; freshness-class logic; audit rows for all paths
- WP3: quality-aware fallback — classify tomorrow state; replace weak-but-complete forecasts
- WP4: `forecast_error_compare_daily` + `forecast_error_compare_slot`; source-aware error memory
- WP5: replay validation over last 30–90 days before threshold tuning
- WP6: enhanced Solcast reliability — seasonal, time-of-day, trend detection (all at 5-min slot resolution)

Ship WP1+WP2 together. Ship WP3 next. WP4 after enough audit data exists. Tune thresholds only after WP5 replay confirms results. WP6 is additive — old artifacts without new keys load safely via fallback dicts.

### Per-Inverter Transmission Loss Rules

- The IP Config page exposes a per-inverter `Loss %` field (0-100) representing MW transmission loss from inverter to substation.
- Telemetry ownership is also anchored by IP Config: live frames are matched by configured inverter IP address plus configured node number, not by any assumed IP-numbering pattern.
- Dashboard labels may show `INV-xx` plus the configured inverter IP so operators can verify the binding visually.
- Loss factors are stored in `ipconfig.json` as `losses: { "1": 2.5, "2": 2.5, ... }` and persisted via the `ipConfigJson` settings key.
- Default loss is `2.5%` per inverter when the config omits a `losses` value; operators can explicitly set any inverter to `0`.
- Loss factors are used exclusively by the forecast engine for substation-level accuracy. They must never alter raw inverter telemetry, dashboard display, health metrics, or energy exports.
- Forecast-engine consumers that use loss-adjusted actuals (`load_actual_loss_adjusted`, `load_actual_loss_adjusted_with_presence`):
  - `collect_training_data()` and `collect_history_days()`
  - `compute_error_memory()` (bias correction)
  - `build_intraday_adjusted_forecast()` (intraday ratio)
  - `forecast_qa()` (QA scoring)
  - `run_backtest()` (backtest comparison)
  - `build_solcast_reliability_artifact()`
  - `plant_capacity_profile()` returns `loss_adjusted_equiv`, `dependable_kw`, and `max_kw`
- Raw `load_actual()` remains for non-forecast consumers and for the zero-loss fast path.
- When all losses are explicitly `0`, loss-adjusted loaders short-circuit to the cached raw `load_actual()` with zero overhead.
- `_cached_loss_factors` is a module-level snapshot refreshed each cycle via `clear_forecast_data_cache()`. Both loss-adjusted loaders are LRU-cached alongside the raw loaders.

### Day-Ahead Auto-Generation Rules

- The Python forecast service runs a continuous main loop checking every 60 seconds.
- **Primary scheduled runs** at hours 6 and 18: always retrain + generate, regardless of whether the day-ahead already exists.
- **Post-solar constant checker** (18:00–04:59): every 60-second loop verifies that tomorrow's day-ahead exists in DB. If missing, it generates. During the solar window (05:00–17:59) the checker is inactive.
- **Recovery**: if today's forecast is missing during solar hours, the service generates it immediately.
- **Failure backoff**: after a failed generation attempt, the post-solar checker enters exponential cooldown (5 min, 10 min, 20 min, capped at 30 min). Primary scheduled runs bypass the cooldown.
- **Node.js cron fallback**: `server/index.js` schedules cron jobs at **04:30, 18:30, 20:00, and 22:00** that check if tomorrow's day-ahead exists in DB and trigger a one-shot ML forecast CLI generation if missing. Safety net when the Python forecast service is not running.
- Do not remove the dual-layer safety net (Python service + Node.js cron).
- Forecast generation in `remote` mode is always skipped.

---

## Operator Messaging Rules

- The operator messaging panel is a compact two-machine note channel between `gateway` and `remote`.
- Canonical operator messages are stored only on the gateway in `chat_messages` (500-row retention).
- The browser always calls its own local `/api/chat/*` routes. In `remote` mode, the local server forwards to the gateway.
- Remote inbound messaging uses monotonic `id` cursors and must not mark rows as read during background fetches.
- `read_ts` changes only when the operator actually opens or reads the thread.
- Visible sender identity uses only `operatorName` plus `Server` or `Remote`.
- Chat notification sound fires only for inbound messages from the opposite machine. Self-sent messages are silent. Sound depends on the browser audio context already being unlocked by a user gesture.
- Chat send rate is limited to `CHAT_RATE_LIMIT_MAX` (10) messages per `CHAT_RATE_LIMIT_WINDOW_MS` (60 s) per machine, enforced server-side via `_chatRateBuckets`. Do not remove this rate limiter.

---

## Current Metrics Guardrails

- Expected full inverter node count: `4`
- Baseline max inverter power: `997.0 kW`
- Equivalent per node at 4 nodes: `249.25 kW`
- Dependable full inverter baseline: `917.0 kW`

Availability is inverter-level uptime only, plant window 5:00 AM–6:00 PM. Node count does not reduce availability by itself. All 4 nodes offline = 0% availability.

---

## Frontend Patterns

### Inverter Detail Panel

When a single inverter is selected from the `invFilter` dropdown, `filterInverters()` calls `loadInverterDetail(inv)` to populate `#invDetailPanel` with:
- Stat chips: Today kWh, Current PAC, Availability %, Active Alarms
- Today's AC Power chart (5-min energy → average kW via `kwh_inc * 12`)
- Recent Alarms table (last 30 days, max 15 rows)
- Last 7 Days summary table

Functions: `clearInverterDetail()`, `loadInverterDetail(inv)`, `renderInverterDetailStats()`, `renderInverterDetailChart()`, `renderInverterDetailAlarms()`, `renderInverterDetailHistory()` — all in `public/js/app.js` after `filterInverters()`.

`#invDetailPanel` lives inside `.inv-page-body` alongside `#invGrid`. Do not block initial detail rendering on the 7-day `/api/report/daily` history fetch. Stats and alarms render first; recent-history loading is best-effort and bounded by a timeout.

### Tab Date Initialization

`initAllTabDatesToToday()` sets all date inputs to today's date. Called on `init()` after `loadSettings()` and on day rollover inside `startClock()`. Day rollover also clears `State.tabFetchTs` and all tab row caches.

### Startup Tab Prefetch

`prefetchAllTabs()` warms Alarms / Report / Audit / Energy sequentially during the loading phase. The main window stays behind the loading screen until critical bootstrap data and the first live WebSocket sample are ready. `TAB_STALE_MS = 60000`. Do not revert to a delayed parallel fire-and-forget path.

### PAC Indicator Thresholds

`getPacRowClass()` uses `NODE_RATED_W = 249,250 W`:
- ≥ 90% rated → `.row-pac-high` (green, #00cf00) — **High**
- > 70% rated → `.row-pac-mid` (yellow, #ffff00) — **Moderate**
- > 40% rated → `.row-pac-low` (orange, #ffa500) — **Mild**
- ≤ 40% rated → `.row-pac-off` (red, #ff0000) — **Low**
- Alarm active → blink animation — **Alarm**

Static legend `.pac-legend-wrap` in the inverter toolbar. PAC legend colors are fixed across all themes.

### App Confirm Modal

`appConfirm(title, bodyText, { ok, cancel })` → `Promise<boolean>`. Renders `#appConfirmModal` with title, body, and labelled OK/Cancel buttons. Supports Escape (cancel), Enter (confirm), backdrop click (cancel). `initConfirmModal()` called from `init()`. All `confirm()` and `alert()` calls in `app.js` replaced with `await appConfirm(...)` and `showToast(...)`.

### Availability Computation

Availability for today is computed live via `getDailyReportRowsForDay(today, { includeTodayPartial: true })`. The `/api/report/daily?start&end` range endpoint splices in the live result when today falls in range. The detail panel 60 s refresh timer fetches both `/api/energy/today` and `/api/report/daily?date=<today>` and merges fresh rows into `State.invDetailReportRows`.

### Real-Time Metric Alignment

When the selected date on the Analytics or Energy page is today, `applyCurrentDaySummaryClient` calls `renderAnalyticsFromState()` on every WebSocket `todaySummary` push. `extractCurrentDaySummary()` parses the flat `todaySummary` object — do not wrap it in extra nesting without updating this parser. Do not reintroduce a separate `patchAnalyticsSummaryLive` function.

### WebSocket Reconnection

Exponential backoff with jitter: `Math.min(30000, 500 * 1.5^retries + random * 500 * retries)`. Do not revert to linear backoff — it causes thundering herd on gateway restarts with multiple remote clients.

### Gateway Link Stability

- Adaptive polling interval: `max(1200, latency×2)` when latency exceeds 400 ms.
- `REMOTE_LIVE_FAILURES_BEFORE_OFFLINE = 6` (10 during sync). Do not lower.
- `REMOTE_LIVE_DEGRADED_GRACE_MS = 60000`. Do not lower.
- `REMOTE_LIVE_STALE_RETENTION_MS = 180000`. Do not lower.
- Gateway `keepAliveTimeout = 30 s` (`headersTimeout 35 s`) — must stay above client `REMOTE_FETCH_KEEPALIVE_MSECS` (15 s).
- `/api/energy/today` fetch inside `pollRemoteLiveOnce()` is fire-and-forget — must not block the bridge tick.

### Proxy Timeout Rules

Remote-to-gateway proxy timeouts are centralized in the `PROXY_TIMEOUT_RULES` array, resolved via `resolveProxyTimeout(method, path)`. Add new proxy route timeouts there, not inline.

### Weather Offline Hardening

`fetchDailyWeatherRange()` in `server/index.js` wraps the external weather API fetch in try/catch. On any network or HTTP error, it serves the stale in-memory cache (even if past TTL) with a `console.warn`. It only re-throws if there is no cached data at all.

---

## High-Impact Files

- Electron: `electron/main.js`, `electron/preload.js`
- Server core: `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js`
- Server subsystems: `server/alarmEpisodeCore.js`, `server/currentDayEnergyCore.js`, `server/plantCapController.js`, `server/mwhHandoffCore.js`, `server/todayEnergyHealthCore.js`, `server/ws.js`, `server/bulkControlAuth.js`, `server/cloudBackup.js`, `server/tokenStore.js`
- Frontend: `public/index.html`, `public/js/app.js`, `public/css/style.css`
- Python: `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py`

---

## Validation After Changes

JS syntax checks after any JS edit:

```powershell
node --check server/index.js
node --check server/db.js
node --check server/poller.js
node --check server/exporter.js
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

CSS or HTML UX diff check:

```powershell
git diff -- public/index.html public/css/style.css
```

---

## Build Warning Policy

- Fix actionable build warnings.
- Do not waste time over-fixing non-fatal electron-builder scanner noise when artifacts are valid.

---

## Runtime Shutdown and Update Install Rule

- Normal quit, restart, license-expiry shutdown, and `Restart & Install` must go through one coordinated shutdown path.
- Do not reintroduce unconditional child-process `taskkill` during restart/update flows. Request a soft stop first; force-kill only as a bounded fallback.
- The restart/update contract:
  - Electron writes a per-service stop file and passes both `IM_SERVICE_STOP_FILE` and `ADSI_SERVICE_STOP_FILE` env vars to child services.
  - The inverter backend honors the stop file and exits `uvicorn` cleanly.
  - The forecast service honors the stop file during loop sleeps and before write-heavy forecast steps.
  - Force-kill is allowed only after the bounded grace window expires.

---

## Service EXE Build Rule

- `npm run build:win` and `npm run build:installer` are both installer-only. Neither rebuilds Python service EXEs.
- `better-sqlite3` is runtime-ABI specific:
  - `npm run rebuild:native:node` — before direct shell-Node checks that load `server/db.js`
  - `npm run rebuild:native:electron` — before Electron run/build/release workflows
  - **After any Node-ABI smoke test, always run `npm run rebuild:native:electron`** before launching or building the Electron app.
  - If desktop startup reports a `NODE_MODULE_VERSION` mismatch for `better-sqlite3`, rebuild with `npm run rebuild:native:electron`.
- Some shells in this workspace export `ELECTRON_RUN_AS_NODE=1`.
  - Direct `electron.exe ...` launches will behave like plain Node and produce misleading errors like `Unable to find Electron app`.
  - Clear `ELECTRON_RUN_AS_NODE` or launch through `start-electron.js` semantics before any Electron/UI smoke.
- Before any EXE build, run the required smoke test for the changed surface:
  - backend / DB / replication / archive changes: isolated server smoke test
  - Electron shell / preload / startup / packaging-sensitive changes: live Electron startup smoke test
- Live Electron UI smoke — always run from `server/tests` (not repo root, avoids `.tmp/` spec discovery):
  - `Push-Location server/tests`
  - `npx playwright test electronUiSmoke.spec.js --reporter=line`
  - `Pop-Location`
- Gateway metric authority changes require this full smoke sequence:
  - `npm run rebuild:native:node`
  - `node server/tests/smokeGatewayLink.js`
  - `node server/tests/modeIsolation.test.js`
  - `npm run rebuild:native:electron`
  - `Push-Location server/tests`
  - `npx playwright test electronUiSmoke.spec.js --reporter=line`
  - `Pop-Location`
- Restart/update shutdown changes require:
  - `node server/tests/serviceSoftStopSource.test.js`
  - `npm run rebuild:native:electron`
  - the Electron Playwright smoke if startup/update behavior or packaging was touched
- Rebuild only the changed Python service EXE:
  - inverter-service changes → rebuild `dist/InverterCoreService.exe`
  - forecast-service changes → rebuild `dist/ForecastCoreService.exe`
  - shared changes (`services/shared_data.py`, `drivers/modbus_tcp.py`) → rebuild both
- Do not publish or hand off app EXEs if they were built against stale Python service binaries.
- For `publish latest release`, build the installer release and publish only the three installer artifacts. Do not expect or upload a portable EXE.