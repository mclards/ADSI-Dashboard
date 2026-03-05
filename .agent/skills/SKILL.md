---
name: adsi-dashboard
description: Project skill for the Inverter Dashboard repository (Electron + Express + Python + SQLite) at d:\ADSI-Dashboard. Use when implementing or reviewing UI, polling, replication, analytics, reporting, exports, licensing, or Windows build/release behavior.
---

# Inverter Dashboard Skill

## Purpose

Use this skill for code changes in this repository. Prioritize production stability and data safety over broad refactors.

## Agent Compatibility

- This file is written to work for both Codex and Claude Code.
- Keep this file as the technical source of truth for repository behavior.
- Keep `CLAUDE.md` aligned with this skill when rules change so Claude Code can apply the same guardrails.
- Prefer neutral, tool-agnostic instructions (commands, formulas, file paths) over agent-specific wording.

## System Overview

- Product: `Inverter Dashboard`
- Domain: Solar inverter monitoring and control (SCADA-lite)
- Runtime:
  - Electron desktop shell
  - Express API/UI server on port `3500`
  - Python inverter core service on port `9100`
  - Python forecast service
  - SQLite via `better-sqlite3`

## Architecture

```text
electron/main.js
  -> starts backend services
  -> opens login + dashboard windows
  -> manages auxiliary windows (topology, IP config)

server/index.js
  -> REST + websocket + replication + export/report endpoints
  -> replication and remote/gateway behavior
  -> settings and runtime diagnostics

server/poller.js
  -> fetches/normalizes live telemetry
  -> persists readings and interval energy

Python services
  -> ADSI_InverterService.py / InverterCoreService.exe
  -> ADSI_ForecastService.py / ForecastCoreService.exe
```

## Non-Negotiable Product Rules

1. Keep gateway server as source of truth in remote mode.
2. Do not break live polling, write control, replication, or export.
3. Keep UI readable and aligned across `dark`, `light`, and `classic`.
4. Keep default export format as `.xlsx`.
5. Keep `build:installer` and `build:portable` working.

## Operating Modes

- `gateway`:
  - local polling and write control
  - generates day-ahead forecast
- `remote`:
  - pull live from gateway
  - supports replication pull/push/reconcile workflows
  - day-ahead generation must stay disabled

## Replication Rules

- Prefer incremental cursor-based sync for pull paths.
- Treat transient network failures as retryable where implemented.
- Reconcile before pull when startup auto-sync runs in remote mode.
- If local data is newer and push reconciliation fails, block startup pull and surface clear error.
- Push payloads can be large. Use chunked push uploads to avoid HTTP `413 Payload Too Large`.
- Keep local-only settings preserved by merge rules.

## Data and Computation Constraints

### Expected topology

- Default expectation: `4` nodes per inverter.
- Performance assumptions use that baseline.
- The Inverter can operate with fewer enabled nodes, but capacity and performance should be normalized to the 4-node baseline for consistency in reporting and user expectations. Regardless of the Node number, the max peak and dependable capacity should be scaled proportionally to the 4-node equivalent to reflect the actual available capacity while maintaining a consistent performance framework.

### Capacity model

- Per inverter max peak: `997.0 kW`.
- Expected per-node share at 4 nodes: `997.0 / 4 = 249.25 kW`.
- When enabled nodes differ from 4-per-inverter equivalent, normalize capacity using:
  - `equiv_inverters = enabled_nodes / 4`
  - `max_kw = equiv_inverters * 997.0`
  - `dependable_kw = equiv_inverters * 917.0`

### Telemetry normalization

- `safePacW = (pac_register * 10 <= 260000) ? pac_register * 10 : 0`
- `safePdcW = (vdc * idc <= 265000) ? (vdc * idc) : 0`
- Register energy:
  - `kwh = (((kwh_high & 0xFFFF) * 65536) + (kwh_low & 0xFFFF)) / 10`

### Energy integration

- Trapezoidal:
  - `kwh_inc = ((pac_prev_W + pac_now_W) / 2) * dt_sec / 3600000`
- Clamp non-negative increments.
- Keep bucketing by configured interval (5/15/30/60/daily paths depending endpoint).

### Availability and performance

- Per inverter:
  - `uptime_s` must be computed from the union of online intervals across all observed positive unit IDs (not unit `1` only).
  - `availability_pct = (node_uptime_s / expected_node_uptime_s) * 100`
  - where `expected_node_uptime_s = solar_window_s * 4`.
  - where `node_uptime_s` is the sum of per-node online seconds for up to 4 strongest observed nodes.
  - Clamp to `0..100`.
  - `performance_pct = (kwh_total / (997.0 * (uptime_s / 3600))) * 100`
  - Clamp to `0..100`.
- Fleet summary:
  - `total_kwh = sum(kwh_total)`
  - `total_mwh = total_kwh / 1000`
  - `peak_kw = max(pac_peak_W / 1000)`
  - `performance_pct = (total_kwh / sum(997.0 * (uptime_s/3600))) * 100`
  - `availability_avg_pct = avg(availability_pct)`
  - Clamp to `0..100`.

### Report windows

- Weekly window is fixed Sunday through Saturday.
- Day-ahead generation starts from tomorrow and overwrites same date/slot rows.
- Solar active window baseline: `05:00` to `18:00`.

## UI and UX Rules

- Preserve compact card/table alignment.
- Keep controls deterministic with clear busy/success/error feedback.
- Keep theming consistent across all reusable components in `dark`, `light`, and `classic`.
- Use shared theme tokens (`--bg*`, `--surface*`, `--text*`, `--border*`, `--accent*`) and avoid one-off hardcoded overrides in Settings cards/components unless scoped intentionally (for example, titlebar-only styles).
- Keep About content in the sidebar (not as a Settings-grid card) unless user requests a revert.
- Keep Settings cards uniform height on desktop.
- In remote mode, visibly disable or block unsupported gateway-only actions.

## Key Files

### Electron

- `electron/main.js`
- `electron/preload.js`
- `electron/preload-login.js`

### Server

- `server/index.js`
- `server/db.js`
- `server/poller.js`
- `server/exporter.js`
- `server/alarms.js`
- `server/ws.js`

### Frontend

- `public/index.html`
- `public/js/app.js`
- `public/css/style.css`
- `public/ip-config.html`
- `public/topology.html`

### Python

- `ADSI_InverterService.py`
- `ADSI_ForecastService.py`
- `drivers/modbus_tcp.py`

## Build and Run Commands

```powershell
npm run server
npm run start
npm run build:installer
npm run build:portable
```

Portable artifact:

- `release/Inverter Dashboard-Portable-<version>.exe`

Installer artifact:

- `release/Inverter Dashboard-Setup-<version>.exe`

## Build Warning Policy

- Fix actionable warnings that improve correctness or maintainability.
- Do not force resolution of non-fatal electron-builder dependency-scanner noise when builds are successful.
- Keep practical metadata/build hygiene:
  - valid `description` and `author` in `package.json`
  - use `postinstall: electron-builder install-app-deps`
  - keep icon paths valid for Windows packaging

## App Update Rules (3 Required Behaviors)

Preserve this exact update architecture unless user explicitly changes it:

1. Installer auto-update (NSIS install runtime):
   - Use `electron-updater` in `electron/main.js`.
   - Flow: check -> download -> `quitAndInstall`.
   - Renderer must expose update controls and status from main-process events.

2. Portable manual-update fallback:
   - Portable EXE must not self-replace/install.
   - Check latest GitHub release and open download URL externally.
   - Surface clear guidance in UI that portable updates are manual.

3. In-app update checker UX:
   - Keep update card in Settings with current/latest version, mode, status, and actions.
   - Keep About quick action (`Check App Update`) and summary status.
   - Keep IPC bridge in `preload.js` synchronized with main updater state/events.

Release metadata expectation:

- GitHub update source defaults to repo `mclards/ADSI-Dashboard`.
- `package.json` `build.publish` must stay aligned with updater runtime.

Release versioning requirement:

- Bump `package.json` `version` for every release build (installer and/or portable).
- Sync UI-exposed version labels with `package.json` before packaging.
- Do not ship release artifacts when the version was not incremented.

## Implementation Checklist

1. Keep changes scoped and backward compatible.
2. Add actionable API errors for network/replication failures.
3. Preserve persistent settings and export folder behavior.
4. Run syntax checks for changed JS files:
   - `node --check server/index.js`
   - `node --check public/js/app.js`
5. Build portable exe when user asks for release artifacts.

## Handover Checklist

1. Live telemetry updates still work.
2. Write controls still work with auth flow.
3. Replication pull/push/reconcile paths respond correctly.
4. Exports write to configured folder and return clear status.
5. Report and availability computations remain consistent with formulas above.
6. Portable and/or installer artifacts exist when requested.
