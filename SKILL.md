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

Detailed reference material lives in `references/` — read those files when working in the relevant area:

| File | When to read |
|---|---|
| `references/data-architecture.md` | DB model, energy authority, solar window, alarms, replication, MWh handoff |
| `references/forecast-engine.md` | Forecast engine, Solcast authority, provider orchestration, training rules |
| `references/frontend-patterns.md` | UI patterns, theming, inverter cards, frontend functions |
| `references/build-release.md` | Build commands, smoke tests, release workflow, ABI rules |
| `references/storage-paths.md` | File paths, forecast export naming, cloud backup, hardware |

---

## Project Identity

| Field | Value |
|---|---|
| User-facing name | `ADSI Inverter Dashboard` |
| Author | Engr. Clariden Montaño REE (Engr. M.) |
| Package name | `inverter-dashboard` |
| Updater app ID | `com.engr-m.inverter-dashboard` — do not rename |
| Repo version baseline | `2.8.6` — source of truth: `package.json` |
| Deployed server version | `2.2.32` (may legitimately lag) |
| Latest published release | `v2.8.6` |
| GitHub release channel | `mclards/ADSI-Dashboard` |
| Default plant name | `ADSI Plant` |

---

## Credentials and Access Keys

*(Internal — not for public docs.)*

| Key | Value / Pattern |
|---|---|
| Login username | `admin` |
| Login password | `1234` |
| Admin auth key | `ADSI-2026` — resets to `admin` / `1234` |
| Bulk inverter control | `sacupsMM` (MM = current minute ±1) |
| Topology / IP Config auth | `adsiM` or `adsiMM` |
| IP Config session | 1 hour |
| Topology session | 10 minutes |

No built-in defaults for: remote gateway API token, Solcast credentials, cloud-backup OAuth. Live secrets in git-ignored `private/*.md` only.

---

## Core Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 29 |
| API server | Express 4 — `server/index.js`, port 3500 |
| Database | SQLite via `better-sqlite3` |
| Frontend | Vanilla JS + Chart.js 4 — `public/js/app.js` |
| Inverter service | Python FastAPI port 9000, Modbus TCP — `services/inverter_engine.py` |
| Forecast service | Python ML engine — `services/forecast_engine.py`; trains on weather + Solcast tri-band (P10/Lo, forecast, P90/Hi) as of v2.5.1+ |
| Camera streaming | Bundled go2rtc (HLS/WebRTC) + FFmpeg fallback — `server/go2rtcManager.js`, `server/go2rtc/` |
| Modbus driver | `drivers/modbus_tcp.py` |

Data flow: `Modbus TCP → FastAPI (9000) → Express (3500) → SQLite → WebSocket → Browser`

---

## Repo Layout

| Location | Contents |
|---|---|
| Repo root | App entrypoints, `package.json`, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `MEMORY.md` |
| `electron/` | `main.js`, `preload.js` |
| `server/` | Express server, DB, poller, exporter, subsystem modules |
| `server/cloudProviders/` | OneDrive, Google Drive, S3 |
| `server/go2rtc/` | Bundled go2rtc binary + YAML config (extraResources → `backend/go2rtc/`) |
| `server/tests/` | Node.js smoke tests, Playwright UI spec |
| `services/` | Python backend, shared data layer, PyInstaller specs |
| `services/tests/` | Python unit tests |
| `public/` | Frontend HTML, JS, CSS |
| `drivers/` | Modbus TCP driver |
| `docs/` | User guide — HTML, Markdown, PDF |
| `dist/` | Built Python service EXEs |
| `release/` | Installer build artifacts |
| `scripts/` | Maintenance and DOCX utility scripts |

---

## Key Tables

| Table | Purpose |
|---|---|
| `readings` | Raw per-poll inverter telemetry (hot only) |
| `energy_5min` | 5-minute energy accumulation (hot only) |
| `daily_report` | Per-inverter daily summary rows |
| `daily_readings_summary` | Per-unit uptime and PAC rollup |
| `audit_log` | Action log; `scope="plant-cap"` distinguishes cap dispatch from manual |
| `chat_messages` | Operator messaging (gateway-side, 500-row retention) |
| `forecast_dayahead` | Day-ahead forecast; stores variant, freshness, provenance, supersession |
| `forecast_run_audit` | One row per generation run per target date |
| `forecast_error_compare_daily` | Per-day QA comparison rows with eligibility flags |
| `forecast_error_compare_slot` | Per-slot QA rows with mask flags and support weights |
| `solcast_snapshots` | Stored Solcast API snapshots — raw MW and slot kWh |

---

## Operating Modes

**`gateway`** — polls plant locally; authoritative source of truth for live data, reports, forecasts, and replication snapshots; the only mode in which forecast generation runs.

**`remote`** — gateway-backed viewer; no local DB persistence from the live stream; historical views proxied to gateway; inverter write control via gateway proxy. If the gateway is unreachable during startup, a **Connection Mode** picker appears on the loading screen allowing the operator to switch to `gateway` or retry `remote`.

Live bridge health states: `connected`, `degraded`, `stale`, `disconnected`, `auth-error`, `config-error`.

Switching from `remote` to `gateway` must immediately abort in-flight remote fetches, close the remote WebSocket, and stop remote chat polling. The mode picker on the loading screen persists the chosen mode via `/api/settings` POST (with direct SQLite fallback) then calls `retryServerStartup()`.

---

## High-Impact Files

| Layer | Files |
|---|---|
| Electron | `electron/main.js`, `electron/preload.js` |
| Server — core | `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js` |
| Server — subsystems | `server/alarmEpisodeCore.js`, `server/currentDayEnergyCore.js`, `server/plantCapController.js`, `server/mwhHandoffCore.js`, `server/todayEnergyHealthCore.js`, `server/ws.js`, `server/bulkControlAuth.js`, `server/cloudBackup.js`, `server/tokenStore.js`, `server/go2rtcManager.js` |
| Frontend | `public/index.html`, `public/js/app.js`, `public/css/style.css` |
| Python | `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py` |

---

## Non-Negotiable Priorities

1. Do not break live polling, write control, replication, reporting, export, backup, restore, licensing, or update flows.
2. In `remote` mode, treat the gateway as source of truth.
3. Preserve updater compatibility with old installed builds.
4. Keep UI compact and consistent across `dark`, `light`, and `classic` themes.
5. Treat credentials, license internals, archives, and user data as sensitive.

---

## Current Metrics

| Metric | Value |
|---|---|
| Full inverter node count | 4 |
| Baseline max inverter power | 997.0 kW |
| Per node at 4 nodes | 249.25 kW |
| Dependable baseline | 917.0 kW |

Availability: inverter-level uptime only, window 05:00–18:00. All 4 nodes offline = 0%.
