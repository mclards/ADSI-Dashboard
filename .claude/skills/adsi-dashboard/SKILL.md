---
name: adsi-dashboard
description: >
  Reference knowledge for the ADSI Inverter Dashboard (package: inverter-dashboard,
  app ID: com.engr-m.inverter-dashboard). Load this skill for any task touching
  this codebase — feature work, bug fixes, refactors, releases, DB changes,
  UI tweaks, Python service changes, replication logic, forecast engine edits,
  or documentation updates. Relevant whenever the user mentions ADSI, ADSI Dashboard,
  InverterCoreService, ForecastCoreService, inverter dashboard, adsi.db, or any
  file path from this repo (server/index.js, public/js/app.js, etc.).
---

# ADSI Inverter Dashboard — Codebase Reference

> **Deployment** — This file lives at three locations; keep them in sync:
> - `d:\ADSI-Dashboard\SKILL.md` (repo root)
> - `.agents/skills/adsi-dashboard/SKILL.md` (Codex / OpenAI Agents)
> - `.claude/skills/adsi-dashboard/SKILL.md` (Claude Code)
>
> `CLAUDE.md` and `AGENTS.md` carry behavioral rules and constraints.
> This file describes what the project is, how it works, and where things live.
>
> `references/frontend-patterns.md` under both agent skill paths is superseded
> by the inline Frontend Patterns section below.

---

## Project Identity

| Field | Value |
|---|---|
| User-facing name | `ADSI Inverter Dashboard` |
| Author | Engr. Clariden Montaño REE (Engr. M.) |
| Internal package name | `inverter-dashboard` |
| Auto-updater app ID | `com.engr-m.inverter-dashboard` |
| Repo version baseline | `2.4.30` — source of truth: `package.json` |
| Deployed server version | `2.2.32` (may legitimately lag the repo) |
| Latest published GitHub release | `v2.4.30` |
| GitHub release channel | `mclards/ADSI-Dashboard` |
| Default plant name fallback | `ADSI Plant` |

Hardcoded footer and about-screen version strings are display-only. `package.json` is the single version source of truth.

---

## Credentials and Access Keys

*(Internal — not for public docs.)*

| Key | Value / Pattern |
|---|---|
| Login username | `admin` |
| Login password | `1234` |
| Admin auth key | `ADSI-2026` — resets credentials to `admin` / `1234` |
| Bulk inverter control auth | `sacupsMM` where MM = current minute; previous minute also accepted |
| Topology / IP Config auth | `adsiM` or `adsiMM` (unpadded or zero-padded current minute) |
| IP Config session window | 1 hour |
| Topology session window | 10 minutes |

No built-in defaults for: remote gateway API token, Solcast API credentials, OneDrive / Google Drive OAuth. Live secrets stored only in git-ignored `private/*.md`.

---

## Core Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 29 |
| API server | Express 4 — `server/index.js`, port 3500 |
| Database | SQLite via `better-sqlite3` |
| Frontend | Vanilla JS + Chart.js 4 — `public/js/app.js` |
| Inverter service | Python FastAPI, port 9000, Modbus TCP — `services/inverter_engine.py` |
| Forecast service | Python ML engine — `services/forecast_engine.py` |
| Modbus driver | `drivers/modbus_tcp.py` — pymodbus |

Data flow: `Modbus TCP → FastAPI (9000) → Express (3500) → SQLite → WebSocket → Browser`

---

## Repo Layout

| Location | Contents |
|---|---|
| Repo root | App entrypoints, `package.json`, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `MEMORY.md` |
| `electron/` | Electron main process (`main.js`) and preload (`preload.js`) |
| `server/` | Express server, DB layer, poller, exporter, subsystem modules |
| `server/cloudProviders/` | OneDrive, Google Drive, S3 backup providers |
| `server/tests/` | Node.js smoke tests and Playwright UI spec |
| `services/` | Python backend modules, shared data layer, PyInstaller specs |
| `services/tests/` | Python unit tests |
| `public/` | Frontend HTML, JS, CSS |
| `drivers/` | Modbus TCP driver |
| `docs/` | User guide — HTML, Markdown, PDF |
| `dist/` | Built Python service EXEs (`InverterCoreService.exe`, `ForecastCoreService.exe`) |
| `release/` | Installer build artifacts |
| `scripts/` | One-off maintenance and DOCX utility scripts |
| `.tmp/` | Transient test fixtures, debug artifacts, release backups |

`ipconfig.json` (root) and `server/ipconfig.json` are local machine config — not committed under normal workflow.

---

## Data Architecture

The backend uses a **hot/cold telemetry model**.

### Databases

| DB | Location |
|---|---|
| Hot DB (main) | `C:\ProgramData\InverterDashboard\adsi.db` |
| Archive DBs | `C:\ProgramData\InverterDashboard\archive\` (monthly SQLite files) |

### Key Tables

| Table | Purpose |
|---|---|
| `readings` | Raw per-poll inverter telemetry (hot only) |
| `energy_5min` | 5-minute energy accumulation (hot only) |
| `daily_report` | Per-inverter daily summary rows |
| `daily_readings_summary` | Per-unit uptime and PAC rollup |
| `audit_log` | Operator and system action log; `scope` column distinguishes plant-cap dispatch (`"plant-cap"`) from manual actions |
| `chat_messages` | Operator messaging thread (gateway-side, 500-row retention) |
| `forecast_dayahead` | ML-trained day-ahead forecast output; stores per-date variant, freshness class, provenance, supersession metadata |
| `forecast_error_compare_daily` | Per-day QA comparison rows with run linkage, eligibility flags, quality status |
| `forecast_error_compare_slot` | Per-slot QA comparison rows with mask flags, support weights, weather-bucket markers |
| `forecast_run_audit` | One row per generation run per target date; stores provenance, freshness class, run status, daily totals |
| `solcast_snapshots` | Stored Solcast API snapshots — raw MW and slot kWh |

### Current-Day Energy

`TODAY MWh`, analytics `ACTUAL MWh`, and per-inverter `TODAY ENERGY` are derived exclusively from server-side **PAC × elapsed time** integration. Python/Modbus register kWh and inverter lifetime-energy registers are raw telemetry sources only — not authoritative for current-day totals.

Authority path: `raw PAC telemetry from Python → Node poller integration → energy_5min / current-day snapshot → HTTP/WS/UI/export`

### Solar Window

Approximately **05:00–18:00**. Raw poll persistence to `readings` and `energy_5min` is gated inside this window. Polling continues outside the window for dashboard visibility and alarm detection. The shutdown flush path respects the same gate.

### SQLite Configuration

WAL mode with `synchronous = NORMAL`. Routine checkpoints use `PASSIVE` mode; `TRUNCATE` only at `closeDb()` during shutdown. `bulkInsertWithSummary()` combines reading inserts and daily summary upserts in a single transaction. `pruneOldData()` and `archiveTelemetryBeforeCutoff()` yield the event loop between 5,000-row batches via `setImmediate`.

### Retention and Archival

`retainDays` controls how long raw telemetry stays in the hot DB. Rows older than the retention cutoff are archived into monthly cold DBs. Archive-aware query helpers span hot and cold storage: `queryReadingsRange(All)`, `queryEnergy5minRange(All)`, `sumEnergy5minByInverterRange()`.

### Daily Reports

Past-date reporting uses persisted `daily_report` rows. `daily_readings_summary` is the source for per-unit uptime and PAC rollups. Daily exports produce one row per inverter per day plus one `TOTAL` row. Plant-level Peak/Avg PAC comes from real aggregates only.

---

## Alarms

### Episode Model

An alarm episode is a sustained unacknowledged active alarm on a node. When a node's nonzero alarm value changes to another nonzero value, the existing active row is updated in place and the acknowledged state is preserved. A bitmask change on an already-active node is not a new episode.

### Sound

Alarm audio is tied to a sustained unacknowledged active episode. Blips that clear within 5 seconds do not trigger sound.

### Quick-ACK UI

Alarm toasts are rendered by `showAlarmToast()` (not `showToast()`), which includes an inline ACK button. The notification bell panel renders a `.notif-ack-btn` per unacknowledged alarm and a `.notif-acked` label for acknowledged ones. Both paths call `ackAlarm(id, btn)` → `POST /api/alarms/:id/ack`. Toast TTL is 12 s; after ACK from the toast it auto-dismisses after 1.2 s.

---

## Replication

### Pull vs Push

**Manual Pull** downloads the gateway main DB snapshot and newer archive files for standby use, applied after restart. If local replicated data is newer than the gateway it returns `LOCAL_NEWER_PUSH_FAILED`. A `Force Pull` option is available on explicit operator choice. The local-newer check ignores local-only remote-client `settings` drift (gateway URL, token, mode) to avoid false blocks.

**Manual Push** uploads local hot-data delta (and optionally archive files) to the gateway. It does not pull the gateway DB or stage a local replacement.

**Startup auto-sync** (gateway mode) is incremental, read-only toward the gateway, and LWW-based.

### Transport

- Chunked uploads to avoid HTTP `413`
- HTTP Range resume for archive downloads (up to 3 retries)
- HTTP socket pool boosted to 16 during manual pull/push via `boostSocketPoolForReplication()`, restored afterward
- Large replication payloads and DB downloads gzip-compressed when the peer accepts it
- `x-main-db-cursors` response header carries replication cursors after a main-DB pull
- The gateway creates a transactionally consistent snapshot via SQLite online backup API before transfer — it never streams its live `adsi.db` directly

### Archive Replacement Safety

Pulled archive DB replacements are staged as temp files and applied only during startup before the server begins serving requests. A failed or cancelled pull discards all staged replacements immediately.

### Inbound Telemetry Age

Replicated raw `readings` or `energy_5min` older than the local `retainDays` cutoff are written into the local archive rather than the hot DB.

### MWh Handoff (Remote → Gateway Switch)

`gatewayHandoffMeta` tracks the in-memory handoff lifecycle. `MAX_SHADOW_AGE_MS = 4h`. Per-inverter kWh baselines captured at switch time via `applyRuntimeMode()`. `getTodayEnergySupplementRows()` applies carry/caught-up logic and auto-completes handoff when all baselines are met. Core logic lives in `server/mwhHandoffCore.js`.

---

## UI and Theming

### Theme Tokens

Three themes: `dark`, `light`, `classic`. Shared CSS custom properties:
`--bg`, `--surface`, `--surface2`, `--border`, `--border2`, `--text`, `--text2`, `--text3`, `--accent`

### PAC Legend Colors

Fixed signal colors across all themes: green (high ≥90%), yellow (moderate >70%), orange (mild >40%), red (low ≤40%), blinking red (alarm).

### Scrollable Page Body Pattern

`.page` is `position: absolute; overflow: hidden; display: flex; flex-direction: column`. Scrollable content areas use a body div with `flex: 1; min-height: 0; overflow: auto`. The Inverters page uses `.inv-page-body`.

```css
.inv-page-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

### Inverter Card Layout

Card hierarchy: `INVERTER XX` title → compact `Pdc`/`Pac` summary → node-table data. The PAC strip has `Start`/`Stop` on the left and separate inline `Pdc:` / `Pac:` cells on the right with no `|` separator. Node-table typography is visually subordinate to the PAC summary totals.

The Bulk Command panel is a card in the inverter grid, placed first before all inverter cards. It participates in grid column layout and auto-height overrides like any `.inv-card`.

### User Guide

Three formats kept in sync: `docs/ADSI-Dashboard-User-Guide.html`, `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.pdf`. PDF regenerated from HTML via:

```
chrome --headless=new --disable-gpu --no-sandbox --print-to-pdf="<pdf>" --print-to-pdf-no-header "<html>"
```

The User Guide version header tracks `package.json`.

---

## Frontend Patterns

### Inverter Detail Panel
`filterInverters()` calls `loadInverterDetail(inv)` / `clearInverterDetail()`. Render functions `renderInverterDetailStats`, `renderInverterDetailChart`, `renderInverterDetailAlarms`, `renderInverterDetailHistory` live after `filterInverters()`. Panel sits inside `.inv-page-body` alongside `#invGrid`. Stats and alarms render first; the 7-day `/api/report/daily` history fetch is best-effort and bounded by a timeout.

### Tab Date Initialization
`initAllTabDatesToToday()` runs on startup and on day rollover inside `startClock()`. Day rollover also clears `State.tabFetchTs`.

### Startup Tab Prefetch
`prefetchAllTabs()` warms Alarms, Report, Audit, and Energy sequentially during the loading phase. The main window stays behind the loading screen until critical bootstrap data and the first live sample are ready. `TAB_STALE_MS = 60000`.

### PAC Indicator Thresholds
`getPacRowClass()` uses `NODE_RATED_W = 249,250 W`. ≥90% → High (green), >70% → Moderate (yellow), >40% → Mild (orange), ≤40% → Low (red). Static `.pac-legend-wrap` in the inverter toolbar.

### App Confirm Modal
`appConfirm(title, body, {ok, cancel})` returns `Promise<boolean>`. Replaces all native `confirm()` and `alert()` calls. DOM: `#appConfirmModal` + `.confirm-dialog` CSS. Initialized via `initConfirmModal()` from `init()`.

### Real-Time Metric Alignment
When the selected date on Analytics or Energy is today, `applyCurrentDaySummaryClient` calls `renderAnalyticsFromState()` on every WebSocket `todaySummary` push. `extractCurrentDaySummary()` parses the flat `todaySummary` WS object — not a nested shape. Analytics summary cards, Energy KPI tiles, and charts stay aligned with the header `TODAY MWh`.

### WebSocket Reconnection
Exponential backoff with jitter: `Math.min(30000, 500 × 1.5^retries + random × 500 × retries)`. Prevents thundering herd across multiple remote clients.

### Gateway Link Stability
Adaptive polling interval: `max(1200, latency × 2)` when latency exceeds 400 ms. Gateway `/api/live` supports ETag for conditional GET. Gateway `keepAliveTimeout` is 30 s (above the client keepAlive of 15 s). Failure thresholds: 6 / 10 / 60 s / 180 s.

### Proxy Timeout Rules
All proxy route timeouts are centralized in the `PROXY_TIMEOUT_RULES` array, resolved via `resolveProxyTimeout()`.

### Weather Offline Hardening
`fetchDailyWeatherRange()` in `server/index.js` wraps the external weather API fetch in try/catch. On any network or HTTP error, it serves the stale in-memory cache (even if past TTL) with a `console.warn`. It only re-throws if there is no cached data at all. This keeps forecast and analytics working without internet.

---

## Forecast Engine

### Services

- `services/forecast_engine.py` — ML training, day-ahead generation, intraday adjustment, Solcast reliability, QA, backtest
- `ForecastCoreService.py` — entry point; runs the forecast engine in a continuous 60-second loop

### Day-Ahead Provider Pipeline

Day-ahead generation normalizes and deduplicates explicit target dates. Manual API, Python auto-delegation, and Node fallback all route through shared provider-aware orchestration. Per-day forecast provenance is persisted at generation time: variant (`solcast_direct`, `ml_solcast_hybrid_fresh`, `ml_solcast_hybrid_stale`, `ml_without_solcast`), Solcast freshness class (`fresh`, `stale_usable`, `stale_reject`, `missing`, `not_expected`), and computed day total. Authoritative run supersession tracked via `superseded_by_run_audit_id` / `replaces_run_audit_id` / `run_status`.

### Day-Ahead Auto-Generation Schedule

| Trigger | Behavior |
|---|---|
| Hours 6 and 18 (primary) | Always retrain + generate |
| Post-solar checker (18:00–04:59) | Every 60 s — verifies tomorrow's day-ahead exists; regenerates if missing |
| Node.js cron at 04:30, 18:30, 20:00, 22:00 | Safety net when Python forecast service is not running |
| Recovery during solar hours | Generates immediately if today's forecast is missing |

Forecast generation is always skipped in `remote` mode.

### Training Data and Curtailment

`audit_log.scope = "plant-cap"` marks stops dispatched by the plant-cap controller, distinguishing them from manual or fault-caused stops. Cap-dispatch-only slots have their actual output replaced with the physics/hybrid baseline for training, preserving high-irradiance samples. Manually constrained slots are excluded from the training mask entirely.

`build_intraday_adjusted_forecast()` excludes cap-dispatched observed slots from the actual-vs-dayahead ratio computation.

`compute_error_memory()` prefers saved eligible comparison rows (`include_in_error_memory=1`, `comparison_quality='eligible'`, `usable_for_error_memory=1`) and applies `decay × source_weight × support_weight`.

### Per-Inverter Transmission Loss

Loss factors stored in `ipconfig.json` under `losses: { "1": 2.5, "2": 2.5, ... }`. Default is `2.5%` per inverter. Loss factors affect **forecast engine only** — they never alter raw telemetry, dashboard display, health metrics, or energy exports.

Loss-adjusted loaders (`load_actual_loss_adjusted`, `load_actual_loss_adjusted_with_presence`) are used by: `collect_training_data()`, `collect_history_days()`, `compute_error_memory()`, `build_intraday_adjusted_forecast()`, `forecast_qa()`, `run_backtest()`, and Solcast reliability scoring. When all losses are explicitly 0, these short-circuit to the raw `load_actual()` cache.

### Solcast Integration

Solcast snapshots arrive in MW and are normalized to kWh per 5-minute slot. Reliability artifacts carry per-weather-bucket resolution history comparing Solcast vs loss-adjusted actual and day-ahead vs loss-adjusted actual. These feed runtime Solcast blend/damping and ML features (`solcast_resolution_weight`, `solcast_resolution_support`).

### Solcast Authority and Usage

Solcast is a **high-authority input** — it carries real irradiance and sky-condition data the ML model cannot derive on its own. It must not be skipped or treated as optional when available.

**In ML training:**
- `collect_training_data()` and `collect_history_days()` must consume Solcast snapshot data as a training feature when available for the target date.
- Do not fall back to pure physics baseline when Solcast snapshots exist — Solcast-informed samples produce more accurate residual learning.
- `build_solcast_reliability_artifact()` builds per-weather-bucket trust scores feeding `solcast_resolution_weight` and `solcast_resolution_support` as ML features — keep these populated.

**In day-ahead generation (manual and automatic):**
- Always attempt to load Solcast snapshots for the target date before generating.
- Variant priority order: `solcast_direct` → `ml_solcast_hybrid_fresh` → `ml_solcast_hybrid_stale` → `ml_without_solcast` (last resort only).
- Only fall back to `ml_without_solcast` when Solcast snapshots are genuinely missing or `stale_reject` for the target date.
- Do not skip Solcast loading as an optimization — a run that silently omits available Solcast produces an inferior forecast and may trigger quality-class `wrong_provider` on the next check.

**Normalization:**
- Raw Solcast arrives in `MW` — always normalize to `kWh per 5-minute slot` before scoring, blending, or comparison.
- `build_solcast_reliability_artifact()` compares Solcast against `load_actual_loss_adjusted()` — never against raw inverter totals.

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

Ship WP1+WP2 together. Ship WP3 next. WP4 after enough audit data exists. Tune thresholds only after WP5 replay confirms results.

### Forecast Export Ceiling

`forecastExportLimitMw` is read from the settings table. `24 MW` is the fallback default only.

---

## Plant Output Cap

The plant output cap controller runs on `gateway` only. It performs whole-inverter sequential STOP/START to keep plant output within a configured ceiling. Exempted inverter numbers are excluded from automatic stop selection and controllable-step math.

Live inverter `Pac` is the primary shed estimate. Planning and stability warnings scale the `997.0 kW` rated and `917.0 kW` dependable baselines by enabled node count.

While cap monitoring is active, all non-exempted inverters are under controller authority. The cap panel defaults to collapsed behind the inverter-toolbar `Show Cap` button. STOP/START commands from the cap controller are recorded in `audit_log` with `scope = "plant-cap"`.

In `remote` mode, all `/api/plant-cap/*` routes are proxied to the gateway.

---

## Operating Modes

### `gateway`
Polls the plant locally via the Python inverter service. Authoritative source of truth for live data, telemetry persistence, daily reports, forecasts, and replication snapshots. The only mode in which forecast generation runs.

### `remote`
A gateway-backed viewer. Displays live gateway data in memory only — no local DB persistence from the live stream. Historical views, reports, analytics, and exports are proxied to the gateway. Inverter write control is available via gateway proxy.

Live bridge health states: `connected`, `degraded`, `stale`, `disconnected`, `auth-error`, `config-error`.

Short live-bridge failures retain the last-good in-memory snapshot for a bounded stale window — inverter cards show a `STALE` badge rather than dropping immediately to offline.

Switching from `remote` back to `gateway` immediately stops all upstream gateway traffic: in-flight remote live/chat/today-energy fetches are aborted, the remote live WebSocket is closed, and remote chat polling stops.

---

## Operator Messaging

The operator messaging panel is a compact gateway-to-remote note channel. Canonical message storage lives in `chat_messages` on the gateway (500-row retention).

The renderer uses local `/api/chat/*` routes. In `remote` mode the local server polls upstream through the configured gateway token path using monotonic `id` cursors.

`read_ts` changes only when the operator opens or reads the visible thread. Visible sender identity is `operatorName` plus `Server` or `Remote` only.

Chat notification sound is inbound-only, silent for self-send echoes, and requires the shared browser audio context to already be unlocked by user interaction.

Chat send rate: 10 messages per 60 s per machine, enforced server-side via sliding-window bucket (`_chatRateBuckets`).

---

## Storage Paths

| Path | Purpose |
|---|---|
| `C:\ProgramData\ADSI-InverterDashboard\license` | License root |
| `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json` | License state |
| `C:\ProgramData\ADSI-InverterDashboard\license\license.dat` | License mirror |
| `HKCU\Software\ADSI\InverterDashboard\License` | Registry mirror |
| `C:\ProgramData\InverterDashboard` | Server and export root (hot DB) |
| `C:\ProgramData\InverterDashboard\archive` | Archive root |
| `C:\Logs\InverterDashboard` | Default export path |
| `C:\Logs\InverterDashboard\All Inverters\Forecast\Analytics` | Forecast analytics export |
| `C:\Logs\InverterDashboard\All Inverters\Forecast\Solcast` | Forecast Solcast export |
| `InverterDashboardBackups` | Cloud provider backup folder |
| `<portable exe dir>\InverterDashboardData` | Legacy portable data root (older deployments only) |

Legacy flat `...\Forecast\<file>` results are relocated automatically into the matching forecast subfolder.

### Forecast Export Naming

Three distinct sources — do not merge prefixes:

| Source | Prefix | Folder |
|---|---|---|
| Trained Day-Ahead (ML, `forecast_dayahead`) | `Trained Day-Ahead vs Actual <res>` / `Trained Day-Ahead <PTxM> AvgTable` | `...\Forecast\Analytics` |
| Solcast Day-Ahead (stored snapshots, `solcast_snapshots`) | `Solcast Day-Ahead vs Actual <res>` / `Solcast Day-Ahead <PTxM> AvgTable` | `...\Forecast\Solcast` |
| Solcast Toolkit (live API preview) | `Solcast Toolkit <PTxM>` / `Solcast Toolkit <PTxM> AvgTable` | `...\Forecast\Solcast` |

### Solcast Toolkit URL Construction

Built server-side from structured settings — operators enter only:
- **Plant Resource ID** → `solcastToolkitSiteRef`
- **Forecast Days** (1–7, default 2) → `solcastToolkitDays`
- **Resolution** (PT5M/PT10M/PT15M/PT30M/PT60M, default PT5M) → `solcastToolkitPeriod`

Constructed pattern:
```
https://api.solcast.com.au/utility_scale_sites/{resourceId}/recent?view=Toolkit&theme=light&hours={days*24}&period={period}
```

---

## Build and Release

### Build Commands

```powershell
npm run rebuild:native:electron   # rebuild better-sqlite3 for Electron ABI
npm run build:installer           # build NSIS installer only
```

`npm run build:win` and `npm run build:installer` are equivalent — both produce installer-only output. Neither rebuilds Python service EXEs.

### Python Service EXE Rebuild Mapping

| Changed surface | Rebuild |
|---|---|
| Inverter-service code / spec | `dist/InverterCoreService.exe` |
| Forecast-service code / spec | `dist/ForecastCoreService.exe` |
| Shared Python or driver changes | Both EXEs |
| Electron / server / frontend only | Neither (unless packaging depends on changed Python binaries) |

### `better-sqlite3` ABI

- `npm run rebuild:native:node` — before plain Node shell checks
- `npm run rebuild:native:electron` — before Electron run / build / release
- After any Node-ABI smoke test, always restore with `npm run rebuild:native:electron` before launching Electron

### `ELECTRON_RUN_AS_NODE` Warning

Some shells export `ELECTRON_RUN_AS_NODE=1`. Direct `electron.exe ...` launches will behave like plain Node, producing misleading errors like `Unable to find Electron app`. Clear the env var or use `start-electron.js`-style launch semantics for Electron UI work.

### JS Syntax Checks

```powershell
node --check server/index.js
node --check server/db.js
node --check server/poller.js
node --check server/exporter.js
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

### Smoke Test Sequences

**Live Electron UI smoke:**
```powershell
Push-Location server/tests
npx playwright test electronUiSmoke.spec.js --reporter=line
Pop-Location
```
Run from `server/tests` so duplicate scratch specs under `.tmp/` are not discovered. Covers dashboard metrics, Energy Summary Export single-date UI, and Settings connectivity.

**Gateway metric authority changes:**
```powershell
npm run rebuild:native:node
node server/tests/smokeGatewayLink.js
node server/tests/modeIsolation.test.js
npm run rebuild:native:electron
Push-Location server/tests
npx playwright test electronUiSmoke.spec.js --reporter=line
Pop-Location
```

**Restart / update shutdown changes:**
```powershell
node server/tests/serviceSoftStopSource.test.js
npm run rebuild:native:electron
# + Electron Playwright smoke if startup/update behavior touched
```

### Release Artifacts

Default publish output — installer only, no portable EXE:
- `release/Inverter-Dashboard-Setup-<version>.exe`
- `release/Inverter-Dashboard-Setup-<version>.exe.blockmap`
- `release/latest.yml`

Clean `release/` before every build. After publish, `release/` should contain only these three files. Do not package `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, Chromium cache, or customer exports into the build.

### Version Alignment on Release

These files are all bumped together before a release:
`package.json`, `package-lock.json`, `SKILL.md`, `CLAUDE.md`, `MEMORY.md`, `docs/ADSI-Dashboard-User-Guide.html`, `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.pdf`, `public/user-guide.html`

---

## High-Impact Files

| Layer | Files |
|---|---|
| Electron | `electron/main.js`, `electron/preload.js` |
| Server — core | `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js` |
| Server — subsystems | `server/alarmEpisodeCore.js`, `server/currentDayEnergyCore.js`, `server/plantCapController.js`, `server/mwhHandoffCore.js`, `server/todayEnergyHealthCore.js`, `server/ws.js`, `server/bulkControlAuth.js`, `server/cloudBackup.js`, `server/tokenStore.js` |
| Frontend | `public/index.html`, `public/js/app.js`, `public/css/style.css` |
| Python | `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py` |

---

## Current Metrics Guardrails

| Metric | Value |
|---|---|
| Expected full inverter node count | 4 |
| Baseline max inverter power | 997.0 kW |
| Per node at 4 nodes | 249.25 kW |
| Dependable full inverter baseline | 917.0 kW |

Availability is inverter-level uptime only, plant window 05:00–18:00. Node count alone does not reduce availability. All 4 nodes offline = 0% availability.

---

## Cloud Backup

OAuth flow: `frontend → /api/backup/auth/:provider/start → Electron BrowserWindow → intercepts localhost:3500/oauth/callback/:provider → returns callbackUrl → frontend POSTs code to /api/backup/auth/:provider/callback → server exchanges for tokens`

- **OneDrive**: Azure AD app registration, PKCE public client, redirect URI `http://localhost:3500/oauth/callback/onedrive`
- **Google Drive**: GCP project, Desktop app type, redirect URI `http://localhost:3500/oauth/callback/gdrive`
- **S3**: `server/cloudProviders/s3.js` present in tree as of v2.4.30 baseline
- Token storage: AES-256-GCM in `server/tokenStore.js` with machine-derived key
- Cloud backup folder name: `InverterDashboardBackups`

---

## Hardware Reference

27 inverters (Ingeteam INGECON), 2–4 nodes each, Modbus TCP, IP range `192.168.1.x`. Default polling interval 0.05 s per inverter.