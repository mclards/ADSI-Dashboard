# CLAUDE.md

Repository guidance for Claude Code in `d:\ADSI-Dashboard`.

Claude should read [SKILL.md](d:/ADSI-Dashboard/SKILL.md) first and use it as the canonical project rulebook. This file exists so Claude still has the same guidance even if `SKILL.md` is not consumed automatically.

## Project Snapshot

- User-facing product: `Dashboard V2`
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.2.10` in `package.json`
- Stack:
  - Electron desktop app
  - Express server (`server/index.js`) on `:3500`
  - Python inverter service on `:9100`
  - Python forecast service
  - SQLite (`better-sqlite3`)

## Repo Layout Rules

- Keep the repo root focused on app entrypoints, app metadata, and user-visible config.
- Put Python backend support files, shared Python modules, and PyInstaller spec files under `services/`.
- Do not reintroduce legacy duplicate service files at the repo root.
- Current intended root Python surface:
  - `InverterCoreService.py`
  - `ForecastCoreService.py`
  - `package.json`
  - `package-lock.json`
  - `start-electron.js`
  - `ipconfig.json` only when intentionally kept as a visible local config seed or legacy mirror

## Core Priorities

1. Do not break live polling, write control, replication, reporting, export, backup, restore, licensing, or updates.
2. In remote mode, treat gateway as source of truth.
3. Keep UI compact, aligned, readable, and theme-consistent.
4. Preserve updater compatibility with old installed builds.
5. Protect secrets, credentials, license internals, and user data.

## UX and Theming Rules

- Keep theming consistent across `dark`, `light`, and `classic`.
- Prefer shared CSS theme tokens over hardcoded one-off colors.
- When adding or removing UI, clean up stale CSS/HTML/JS so old layouts do not conflict with the new one.
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
- If visible branding changes, audit header/about/footer/build metadata together.

## Current Storage and Compatibility Paths

Preserve these unless a deliberate migration is implemented:

- License root: `C:\ProgramData\ADSI-InverterDashboard\license`
- License state: `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json`
- License mirror: `C:\ProgramData\ADSI-InverterDashboard\license\license.dat`
- License registry mirror: `HKCU\Software\ADSI\InverterDashboard\License`
- Server/export root: `C:\ProgramData\InverterDashboard`
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

## Replication Guardrails

- Prefer incremental cursor-based pull.
- Remote startup reconcile must happen before pull.
- If local data is newer and reconciliation push fails, do not force pull.
- Use chunked push uploads to avoid HTTP `413`.
- Keep local-only settings protected during merge/import.

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
- Treat imported/exported config files as sensitive when they contain secrets.

## GitHub Repo Hygiene

- Exclude confidential files from Git tracking and GitHub releases.
- Do not commit secrets, tokens, OAuth client secrets, signing keys, private keys, local auth caches, customer exports, local database snapshots, or portable runtime data.
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
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

## Build Warning Policy

- Address actionable build warnings.
- Do not over-fix non-fatal electron-builder dependency-scanner warnings when artifacts build successfully.
