# AGENTS.md

Repository guidance for Codex and other coding agents in `d:\ADSI-Dashboard`.

Read `SKILL.md` first — it is the canonical codebase reference. This file exists as an
always-on summary so agents have core project rules even before skill loading.
For server-layer rules see `server/AGENTS.md`. For Python-layer rules see `services/AGENTS.md`.

---

## Project Identity

- **Product name**: `ADSI Inverter Dashboard`
- **Author**: Engr. Clariden Montaño REE (Engr. M.)
- **Package**: `inverter-dashboard`
- **Updater app ID**: `com.engr-m.inverter-dashboard` — do not rename
- **Version source of truth**: `package.json` — not footer strings
- **Repo version baseline**: `2.10.7`
- **Latest published release**: `v2.10.7`
- **GitHub release channel**: `mclards/ADSI-Dashboard`

---

## Stack

- Electron 29 desktop shell (`electron/main.js`, `electron/preload.js`)
- Express 4 API server (`server/index.js`) on port 3500
- SQLite via `better-sqlite3` (`server/db.js`)
- Frontend vanilla JS + Chart.js 4 (`public/js/app.js`, `public/index.html`)
- Python inverter service (`InverterCoreService.py` → `services/inverter_engine.py`) — FastAPI port 9100, Modbus TCP
- Python forecast service (`ForecastCoreService.py` → `services/forecast_engine.py`) — ML day-ahead and intraday

---

## Non-Negotiable Priorities

1. Do not break live polling, write control, replication, reporting, export, backup, restore, licensing, or update flows.
2. In `remote` mode, treat the gateway as source of truth.
3. Preserve updater compatibility with old installed builds.
4. Keep UI compact and consistent across `dark`, `light`, and `classic` themes.
5. Treat credentials, license internals, archives, and user data as sensitive.

---

## Repo Layout Rules

- Repo root: app entrypoints, metadata, user-visible config only.
- Python backend support, shared modules, PyInstaller specs → `services/`
- Do not reintroduce legacy duplicate service files at the repo root.
- `ipconfig.json` and `server/ipconfig.json` are local machine config — do not commit unless intentional.

---

## Current-Day Energy Authority

`TODAY MWh`, `ACTUAL MWh`, and per-inverter `TODAY ENERGY` must come from
**server-side PAC × elapsed time integration only**. Never use Python/modbus
register kWh or Python `/metrics` energy fields as authority for current-day totals.

---

## Forecast Day-Ahead Generation Architecture (v2.4.31+)

All four generation paths route through the same Node orchestrator (`runDayAheadGenerationPlan`).
Provider routing and Solcast freshness decisions are always made by Node. Python owns ML execution only.

| Path | Trigger | Audit |
|---|---|---|
| Manual UI | `POST /api/forecast/generate` | Node |
| Auto scheduler | Python loop → `_delegate_run_dayahead()` | Node |
| Python CLI | `--generate-date` → `_delegate_run_dayahead()` | Node |
| Python CLI fallback | Node unreachable, direct `run_dayahead(write_audit=True)` | Python |
| Node cron | 04:30/18:30/20:00/22:00, quality-aware | Node |

`_delegate_run_dayahead()` uses `ADSI_SERVER_PORT` (default 3500).
Node cron classifies tomorrow quality (`missing`/`incomplete`/`wrong_provider`/`stale_input`/`weak_quality`/`healthy`) — only `healthy` suppresses regeneration.

---

## Solcast Reliability Dimensions (v2.4.33+)

`build_solcast_reliability_artifact()` produces a multi-dimensional trust profile at 5-min slot resolution:

| Dimension | Artifact Key | Effect |
|---|---|---|
| Weather regime | `regimes` (clear/mixed/overcast/rainy) | Per-regime bias_ratio + reliability |
| Season | `seasons` (dry/wet), `season_regimes` | Season-aware lookup |
| Time-of-day | `time_of_day` (morning/midday/afternoon), `time_of_day_by_regime` | Per-slot blend and floor modulation |
| Trend | `trend` (improving/stable/degrading) | Blend ±6-8%, residual damping adjustment |

All lookups have backward-compatible fallbacks — old artifacts without new keys load safely.

---

## Forecast Performance Monitor (v2.4.42)

`/api/forecast/engine-health` returns extended diagnostics including `mlBackend`, `trainingSummary`,
and `dataQualityFlags`. The Forecast Performance Monitor panel defaults to collapsed on first load.

New Python helpers:
- `_detect_ml_backend()` — identifies active LightGBM vs sklearn
- `_collect_data_quality_warnings()` — audits stale features, low sample count, regime imbalance

`ml_train_state.json` extended fields: `ml_backend_type`, `model_file_path`, `model_file_mtime_ms`,
`training_samples_count`, `training_features_count`, `training_regimes_count`, `training_result`,
`last_training_date`, `data_warnings`.

---

## Operating Modes

| Mode | Description |
|---|---|
| `gateway` | Polls plant locally; authoritative source of truth; only mode that generates forecasts |
| `remote` | Gateway-backed viewer; no local DB persistence from live stream; historical views proxied to gateway |

- Switching to `gateway` must immediately abort in-flight remote fetches, close the remote WebSocket, and stop remote chat polling.
- Standby pull must stay low-impact on the gateway.

---

## Build Commands

```powershell
npm run rebuild:native:electron
npm run build:installer         # signed build — enforces 3 safety gates
npm run rebuild:native:node     # before plain Node shell checks
```

**`build:installer` is signed by default** (v2.7.18+). All three of `build:win`, `build:installer`, and `build:installer:signed` route through `scripts/build-installer-signed.js` and enforce:
1. Signing required — fails fast if `build/private/codesign.env` is missing, unless `ADSI_ALLOW_UNSIGNED=1` is set
2. Post-build signature verification with thumbprint pin against `build/private/codesign-thumbprint.txt`
3. Installer size floor (300 MB) + SHA-512 log

A release build must succeed all three gates before publishing. For dev-only unsigned builds: `ADSI_ALLOW_UNSIGNED=1 npm run build:installer`. See `docs/CODE_SIGNING.md` for the full signing workflow.

After any `rebuild:native:node` smoke test, always run `rebuild:native:electron` before launching Electron.

**`ELECTRON_RUN_AS_NODE` warning**: some shells export `ELECTRON_RUN_AS_NODE=1`.
Clear the env var or use `start-electron.js`-style launch before any Electron/UI work.

---

## Smoke Test Sequences

**JS syntax check:**
```powershell
node --check server/index.js
node --check server/db.js
node --check server/poller.js
node --check server/exporter.js
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

**Live Electron UI smoke:**
```powershell
npm run rebuild:native:electron
Push-Location server/tests
npx playwright test electronUiSmoke.spec.js --reporter=line
Pop-Location
```

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

**Restart/update shutdown changes:**
```powershell
node server/tests/serviceSoftStopSource.test.js
npm run rebuild:native:electron
```

---

## Release Rules

- Always bump `package.json` before building any release EXE.
- Keep `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, and `MEMORY.md` aligned after every release.
- The User Guide version header must match `package.json` — update explicitly on every release.
- Push the release commit and tag **before** creating the GitHub release.
- If `gh release create` times out, inspect GitHub release state before retrying.
- Clean `release/` before every build. After publish keep only:
  - `Inverter-Dashboard-Setup-<version>.exe`
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
  - `latest.yml`
- Do not package `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, or Chromium cache into the build.

---

## Python Service EXE Rules

- `npm run build:installer` packages existing `dist/*.exe` — it does **not** rebuild them.
- Rebuild only the changed service EXE:
  - inverter-service changes → `dist/InverterCoreService.exe`
  - forecast-service changes → `dist/ForecastCoreService.exe`
  - shared changes (`services/shared_data.py`, `drivers/modbus_tcp.py`) → rebuild both
- Do not publish if EXEs were built against stale Python binaries.
- After rebuilding Python EXEs, always run `npm run rebuild:native:electron` before the Electron build.

---

## Security Rules

- Do not expose secrets, tokens, OAuth internals, or signing details in the renderer.
- Do not log tokens, OAuth responses, license payload internals, or sensitive data.
- Do not expose internal GitHub repo URLs in user-facing UI text.
- Treat exported config files and archived operational data as sensitive.

---

## User Guide Sync

Any UI change must update all three artifacts before handoff:
- `docs/ADSI-Dashboard-User-Guide.html`
- `docs/ADSI-Dashboard-User-Manual.md`
- `docs/ADSI-Dashboard-User-Guide.pdf`

PDF regeneration:
```
chrome --headless=new --disable-gpu --no-sandbox --print-to-pdf="<pdf>" --print-to-pdf-no-header "<html>"
```

---

## High-Impact Files

| Layer | Files |
|---|---|
| Electron | `electron/main.js`, `electron/preload.js` |
| Server — core | `server/index.js`, `server/db.js`, `server/poller.js`, `server/exporter.js` |
| Server — subsystems | `server/alarmEpisodeCore.js`, `server/currentDayEnergyCore.js`, `server/plantCapController.js`, `server/mwhHandoffCore.js`, `server/todayEnergyHealthCore.js`, `server/ws.js`, `server/bulkControlAuth.js`, `server/cloudBackup.js`, `server/tokenStore.js` |
| Frontend | `public/index.html`, `public/js/app.js`, `public/css/style.css` |
| Python | `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `services/InverterCoreService.spec`, `services/ForecastCoreService.spec`, `drivers/modbus_tcp.py` |
