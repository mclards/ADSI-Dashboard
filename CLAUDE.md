# CLAUDE.md

Repository guidance for Claude Code in `d:\ADSI-Dashboard`.

## Project Snapshot

- Product: `Inverter Dashboard`
- Stack:
  - Electron desktop app
  - Express server (`server/index.js`) on `:3500`
  - Python inverter service on `:9100`
  - Python forecast service
  - SQLite (`better-sqlite3`)

## Core Priorities

1. Do not break live polling, write control, replication, report, or export.
2. In remote mode, treat gateway as source of truth.
3. Keep UI compact, aligned, and readable in all themes.
4. Keep theming consistent across reusable components in `dark`, `light`, and `classic`; prefer shared CSS theme tokens and avoid ad-hoc hardcoded overrides outside intentional scoped areas (for example, titlebar-only styling).
5. Keep export default format `.xlsx`.
6. Keep Windows build outputs working (`installer` and `portable`).

## Current UI Decisions

- Keep About panel in the sidebar.
- Keep Settings cards uniform height on desktop layouts.
- Preserve responsive fallback (auto-height stacked cards on small screens).

## Operating Modes

- `gateway`:
  - polls plant locally
  - can generate day-ahead forecast
- `remote`:
  - pulls live data from gateway
  - can run replication workflows
  - must not run day-ahead generation

## Replication Guardrails

- Prefer incremental cursor-based pull.
- Startup auto-sync in remote mode must reconcile before pull.
- If local data is newer and reconciliation push fails, do not force pull.
- Use chunked push uploads to avoid HTTP `413 Payload Too Large`.
- Keep local-only settings protected during merge.

## Computation Guardrails

- Expected nodes per inverter: `4`.
- Inverter max peak baseline: `997.0 kW`.
- Per-node equivalent at 4 nodes: `249.25 kW`.
- Capacity normalization:
  - `equiv_inverters = enabled_nodes / 4`
  - `dependable_kw = equiv_inverters * 917.0`
  - `max_kw = equiv_inverters * 997.0`
- Availability:
  - `availability_pct = (kwh_total / ((pac_peak_W/1000) * (uptime_s/3600))) * 100`
  - clamp to `0..100`

## High-Impact Files

- Electron: `electron/main.js`, `electron/preload.js`
- Server: `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js`
- Frontend: `public/index.html`, `public/js/app.js`, `public/css/style.css`
- Python: `ADSI_InverterService.py`, `ADSI_ForecastService.py`, `drivers/modbus_tcp.py`

## Build and Validation

Run from repo root:

```powershell
npm run build:installer
npm run build:portable
```

Release versioning rule:

- Always bump app version in `package.json` before every release build.
- Keep UI-visible version text aligned (About/footer/guide labels) with `package.json` version.
- Never publish installer/portable artifacts with an unchanged version number.

## App Update Model (Required)

Keep these 3 update behaviors intact:

1. Installer auto-update:
   - Runtime: installed NSIS build (non-portable, packaged app).
   - Use `electron-updater` flow: check -> download -> restart/install.
   - UI must expose `Check for Updates`, `Download Update`, and `Restart & Install`.

2. Portable manual update:
   - Runtime: portable EXE.
   - Do not attempt in-place self-install.
   - Check latest GitHub release metadata and open release/asset download link for user.

3. In-app update checker UI:
   - Show current version, latest version, channel/mode, and status.
   - Provide update actions in Settings and a quick `Check App Update` entry in About.
   - Keep renderer state synced from main-process updater events.

Release channel defaults:

- GitHub repo: `mclards/ADSI-Dashboard`
- Build publish config in `package.json` must remain aligned with updater code.

Useful checks after JS edits:

```powershell
node --check server/index.js
node --check public/js/app.js
```

Expected artifacts:

- `release/Inverter Dashboard-Setup-<version>.exe`
- `release/Inverter Dashboard-Portable-<version>.exe`

## Build Warning Policy

- Address actionable build warnings.
- Do not over-fix non-fatal electron-builder dependency-scanner warnings when artifacts build successfully.
