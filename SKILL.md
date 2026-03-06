# SKILL.md

Project guidance for Codex and other coding agents working in `d:\ADSI-Dashboard`.

This file is intended to be reusable by local coding agents and as the canonical project rulebook. If another agent such as Claude cannot consume `SKILL.md` directly, keep the same rules mirrored in `CLAUDE.md`.

## Project Identity

- User-facing product name: `Dashboard V2`
- Internal package name: `inverter-dashboard`
- Internal updater app ID: `com.engr-m.inverter-dashboard`
- Current repo version baseline: `2.2.10` in [package.json](d:/ADSI-Dashboard/package.json)
- Release source of truth for versioning: `package.json`

Do not casually rename internal updater identifiers. The visible app name may change, but updater compatibility with old installed versions must remain intact unless a deliberate migration is implemented.

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
- Do not let legacy duplicate service files accumulate again at the repo root.
- Current intended root Python surface:
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
5. Treat credentials, license internals, and user data as sensitive.

## UX and Theming Rules

When adding, removing, or restructuring UI:

- Use shared theme tokens such as `--bg`, `--surface`, `--surface2`, `--border`, `--border2`, `--text`, `--text2`, `--text3`, and `--accent`.
- Avoid hardcoded one-off colors for reusable panels, forms, cards, toolbars, status chips, and action bars unless the area is intentionally isolated.
- If a component exists in one theme, validate it conceptually against all three themes. Do not leave light/classic with dark-only styling.
- Keep spacing, radius, shadows, and panel hierarchy aligned with existing dashboard patterns.
- Remove stale CSS, HTML, and JS when replacing an older UI pattern. Do not leave dead settings layouts, orphan selectors, or unused controls behind.
- Prefer one clear interaction path over duplicated controls that do the same thing.

## Icons, Logos, and Visual Consistency

- Use the existing MDI icon system for navigation, settings, actions, and status where possible.
- Do not mix emoji icons with MDI icons in the same workflow.
- If the app icon, brand logo, or visible product name changes, update all affected surfaces together:
  - `package.json` build metadata
  - header/about/footer branding
  - installer icon references
  - release artifact expectations if intentionally changed
- Current Windows build icon reference: `icon-256.png`

## Hover Help and User Guidance

The UI should reduce operator confusion without making screens noisy.

- Any icon-only action or non-obvious control should expose short hover help, tooltip text, or inline helper text.
- Use hover info for controls with operational consequences, technical abbreviations, or hidden assumptions.
- Keep hover text concise and operational. Prefer "what this does" and "why it matters".
- Do not rely on hover only for critical safety information; pair it with visible labels when the action is destructive or high impact.

## Security and Privacy Rules

- Do not expose secrets, private keys, OAuth internals, signing details, or sensitive debugging information in the renderer unless explicitly required.
- Keep client secrets, API keys, tokens, and license material out of normal UI displays by default.
- Do not add logs that print tokens, OAuth responses, license payload internals, filesystem secrets, or personally sensitive data.
- If a UI flow can be simplified without exposing security internals, prefer the simpler user-facing flow.
- License generation and verification UI should not reveal unnecessary implementation hints.
- Treat exported configuration files as sensitive when they contain credentials.

## GitHub Repo Hygiene

Keep the public repository clean, professional, and safe to publish.

- Exclude confidential files from Git tracking and GitHub releases.
- Do not commit secrets, tokens, OAuth client secrets, private keys, signing keys, local database snapshots, local auth caches, portable runtime data, or customer-specific exports.
- Keep local-only tooling out of app releases unless explicitly requested.
- Before push or release, review staged files for accidental sensitive content and stale generated artifacts.
- Keep public docs, screenshots, and release notes aligned with the current app name, version, and UX.
- Remove obsolete generated files and stale binaries from the workspace before publishing new releases.

Confidential or local-only examples to keep out of GitHub unless there is a deliberate reason:

- `.env`, `.env.*`
- `keys/`, `secrets/`, `private/`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- local license files, signing outputs, and auth/token caches
- local database copies and runtime backup folders
- local-only license generator tools and their outputs

## Versioning and Release Rules

- Always bump `package.json` version before building any release EXE.
- Keep visible version text aligned with `package.json`.
- Keep updater compatibility intact:
  - app ID stays `com.engr-m.inverter-dashboard`
  - release asset names stay compatible with existing updater expectations
  - GitHub release channel remains `mclards/ADSI-Dashboard`
- Never publish new installer/portable artifacts under an unchanged version.
- Every build release must append the latest app version to the release artifacts and release metadata.

## Build and Artifact Rules

Expected app artifacts:

- `release/Inverter-Dashboard-Setup-<version>.exe`
- `release/Inverter-Dashboard-Setup-<version>.exe.blockmap`
- `release/Inverter-Dashboard-Portable-<version>.exe`
- `release/latest.yml`

Do not include local-only license-generator builds in GitHub app releases unless explicitly requested.

Build commands:

```powershell
npm run build:installer
npm run build:portable
```

## File and Directory Consistency

Preserve these storage and compatibility paths unless a migration is intentionally implemented:

- License root: `C:\ProgramData\ADSI-InverterDashboard\license`
- License mirror file: `C:\ProgramData\ADSI-InverterDashboard\license\license.dat`
- License state: `C:\ProgramData\ADSI-InverterDashboard\license\license-state.json`
- License registry mirror: `HKCU\Software\ADSI\InverterDashboard\License`
- Server/export data root: `C:\ProgramData\InverterDashboard`
- Default export path: `C:\Logs\InverterDashboard`
- Portable data root: `<portable exe dir>\InverterDashboardData`
- OneDrive/Google Drive backup folder name: `InverterDashboardBackups`

If a visible product rename affects install directory behavior, assess updater impact and migration impact before changing it.

## Current Operating Modes

- `gateway`
  - polls plant locally
  - can generate day-ahead forecast
- `remote`
  - pulls live data from gateway
  - can run replication workflows
  - must not run day-ahead generation

## Replication Guardrails

- Prefer incremental cursor-based pull.
- Remote startup sync must reconcile before pull.
- If local data is newer and reconciliation push fails, do not force pull.
- Use chunked push uploads to avoid HTTP `413`.
- Protect local-only settings during merge/import.

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

## High-Impact Files

- Electron: `electron/main.js`, `electron/preload.js`
- Server: `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js`
- Frontend: `public/index.html`, `public/js/app.js`, `public/css/style.css`
- Python: `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py`

## Validation After Changes

Useful checks after JS edits:

```powershell
node --check server/index.js
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

Useful checks after CSS/HTML UX edits:

```powershell
git diff -- public/index.html public/css/style.css
```

## Build Warning Policy

- Fix actionable build warnings.
- Do not waste time over-fixing non-fatal electron-builder scanner noise when artifacts are valid.
