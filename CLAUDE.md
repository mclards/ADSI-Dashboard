# CLAUDE.md

Repository guidance for Claude Code in `d:\ADSI-Dashboard`.

Claude should read `SKILL.md` first and treat it as the canonical rulebook. This file exists so Claude still has the same project guidance if `SKILL.md` is not consumed automatically.

## Project Snapshot

- User-facing product: `Dashboard V2`
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.2.12` in `package.json`
- GitHub release channel: `mclards/ADSI-Dashboard`
- Stack:
  - Electron desktop app
  - Express server in `server/index.js`
  - Python inverter service
  - Python forecast service
  - SQLite via `better-sqlite3`

Do not casually rename updater identifiers. Visible branding may change, but old installed versions must still detect updates unless a deliberate migration is implemented.

## Repo Layout Rules

- Keep the repo root focused on app entrypoints, app metadata, and user-visible config.
- Put Python backend support files, shared Python modules, and PyInstaller spec files under `services/`.
- Do not reintroduce legacy duplicate service files at the repo root.
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

### Replication and Archive Guardrails

- Replicate `daily_report` and `daily_readings_summary` between machines.
- Prefer incremental cursor-based pull.
- Remote startup reconcile must happen before pull.
- If local data is newer and reconciliation push fails, do not force pull.
- Use chunked push uploads to avoid HTTP `413`.
- Protect local-only settings during merge/import.
- Never rehydrate the hot DB with inbound telemetry older than the local hot cutoff.
- If replicated raw `readings` or `energy_5min` are older than local `retainDays`, write them directly into the local archive instead of the hot DB.
- Archive DB files themselves are local artifacts unless a deliberate archive-file replication design is added later.

## UX and Theming Rules

- Keep theming consistent across `dark`, `light`, and `classic`.
- Prefer shared CSS theme tokens over hardcoded one-off colors.
- When adding or removing UI, clean up stale CSS, HTML, and JS so old layouts do not conflict with the new one.
- If a page is dense or long, prefer proper scrolling over overlap or hidden actions.
- Keep iconography consistent. Prefer the existing MDI icon system over mixed emoji usage.
- Any non-obvious or icon-only control should expose short hover help, tooltip text, or helper text.
- Do not hide critical safety or destructive behavior behind hover-only messaging.

## Version, Branding, and Release Compatibility

- Always bump `package.json` version before every EXE release build.
- Keep visible version text aligned with `package.json`.
- Preserve updater compatibility:
  - app ID stays `com.engr-m.inverter-dashboard`
  - GitHub repo stays `mclards/ADSI-Dashboard`
  - release asset names stay:
    - `Inverter-Dashboard-Setup-<version>.exe`
    - `Inverter-Dashboard-Portable-<version>.exe`
- Keep Windows build icon usage aligned with `icon-256.png`.
- If visible branding changes, audit header, about, footer, and build metadata together.
- When the user says `publish release`, Claude should execute the release workflow directly:
  - build artifacts if needed
  - create or upload the GitHub release itself
  - do not stop at providing commands unless auth, permissions, or network access prevent publishing
- If publishing is blocked, report the exact blocker and then provide only the minimum command(s) the user needs to run.

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
  - can generate day-ahead forecast
- `remote`
  - pulls live data from gateway
  - can run replication workflows
  - must not run day-ahead generation

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

## High-Impact Files

- Electron: `electron/main.js`, `electron/preload.js`
- Server: `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js`
- Frontend: `public/index.html`, `public/js/app.js`, `public/css/style.css`
- Python: `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py`

## Build and Validation

Run from repo root:

```powershell
npm run build:installer
npm run build:portable
```

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

## Build Warning Policy

- Address actionable build warnings.
- Do not over-fix non-fatal electron-builder dependency-scanner warnings when artifacts build successfully.
