# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Run / Develop
```bash
npm start                   # Launch full Electron app (production mode)
npm run dev                 # Launch with NODE_ENV=development
npm run server              # Run Express server standalone (no Electron)
node server/index.js        # Same as above
```

### Build (Windows x64 only)
```bash
npm run build:win           # NSIS installer + portable exe → release/
npm run build:installer     # NSIS installer only
npm run build:portable      # Portable exe only
```

### Python services (PyInstaller)
```bash
# Build inverter backend (outputs dist/InverterCoreService.exe)
pyinstaller InverterCoreService.spec

# Build forecast backend (outputs dist/ForecastCoreService.exe)
pyinstaller ForecastCoreService.spec
```
The electron-builder `extraResources` copies the two EXEs from `dist/` into `resources/backend/` in the packaged app.

### Run Python services manually (dev only)
```bash
python InverterCoreService.py   # Starts FastAPI on port 9100
python ForecastCoreService.py   # Starts forecast daemon
```

## Architecture

### Process topology
```
Electron main.js
  ├─ spawns → InverterCoreService.exe  (FastAPI, port 9100, Modbus TCP to inverters)
  ├─ spawns → ForecastCoreService.exe  (ML forecast daemon)
  └─ spawns → node server/index.js     (Express + WebSocket, port 3500)
                 └─ serves → public/index.html  (Chromium renderer)
```

### Data flow
```
Modbus TCP (inverters 192.168.1.x)
  → InverterCoreService (FastAPI :9100, asyncio polling + ThreadPoolExecutor writes)
  → Express server/poller.js (polls :9100 every 500 ms, integrates Pac→kWh)
  → SQLite (adsi.db, WAL mode)
  → WebSocket broadcast (server/ws.js)
  → Browser (Chart.js, live update)

Weather APIs (Open-Meteo, Solcast)
  → ForecastCoreService (physics model + GradientBoosting residual ML)
  → ProgramData JSON files  (forecast/context/global/global.json)
  → Express /api/forecast*  → Browser
```

### Key source files

| File | Purpose |
|---|---|
| `electron/main.js` | Electron entry: window management, IPC handlers, license check, process spawning/restart |
| `electron/preload.js` | Context bridge — exposes `window.electronAPI` (the sole IPC surface) |
| `server/index.js` | Express REST API + WebSocket; proxies to Python engine; cron for forecast/pruning |
| `server/db.js` | better-sqlite3 wrapper; schema migrations; `readings`, `energy_5min`, `alarms`, `audit_log`, `settings`, `forecast_day_ahead` tables |
| `server/poller.js` | 500 ms poll loop against InverterCoreService; Pac integrator; offline detection; 5-min energy buckets |
| `server/alarms.js` | Ingeteam INGECON 16-bit alarm bitfield decoder; alarm persistence; audit log |
| `server/ws.js` | WebSocket client registry; `broadcastUpdate()` |
| `server/exporter.js` | CSV/Excel export (ExcelJS); path traversal guard; filename sanitisation |
| `public/js/app.js` | Vanilla JS frontend; Chart.js charts; WebSocket client; all UI logic |
| `public/index.html` | Single-page dashboard shell; no inline event handlers (all bound in `bindEventHandlers()`) |
| `ADSI_InverterService.py` | FastAPI app with asyncio polling + ThreadPoolExecutor DB writes; one persistent Modbus client per inverter |
| `ADSI_ForecastService.py` | 9-stage forecast pipeline (solar geometry → clear-sky → cloud transmittance → physics baseline → GBR residual → error memory → anomaly guard → QA → output) |
| `drivers/modbus_tcp.py` | Thin pymodbus wrapper: `create_client`, `read_input`, `read_holding`, `write_single` (with reconnect retry) |
| `shared_data.py` | Single `shared = {}` dict used as in-process state between inverter service modules |
| `ipconfig.json` | 27 inverter IPs (192.168.1.x) + per-inverter Modbus unit IDs + poll intervals |

### Ports
- **3500** — Express HTTP + WebSocket (browser connects here)
- **9100** — InverterCoreService FastAPI (internal only; controlled by `INVERTER_ENGINE_PORT` env var)

### Data directories (runtime)
The app resolves paths from environment variables with this priority:

| Env var | Override |
|---|---|
| `ADSI_DATA_DIR` | Explicit SQLite DB directory |
| `ADSI_PORTABLE_DATA_DIR` | Portable mode root (relative sub-dirs for db, config, programdata) |
| *(default)* | `%APPDATA%\ADSI-Dashboard` (DB), `%PROGRAMDATA%\ADSI-InverterDashboard` (forecast/weather JSON) |

### IPC (Electron ↔ renderer)
All communication goes through `window.electronAPI` (defined in `electron/preload.js`). Never add `window.electron.*` — the single `electronAPI` object is the contract. IPC channels use `ipcMain.handle` (invoke/handle pattern) for async and `ipcMain.on` (fire-and-forget) for events.

### SQLite schema notes
- `readings` — raw per-unit telemetry (vdc, idc, vac1-3, iac1-3, pac, kwh, alarm, online)
- `energy_5min` — 5-minute kWh increment buckets derived from Pac integration
- `alarms` — decoded alarm events with severity, cleared_ts, acknowledged flag
- `audit_log` — every control action (start/stop node/all) with operator, result, reason
- `settings` — key/value store (adminPassword AES-256-GCM encrypted, authKey, plant config)
- `forecast_day_ahead` — 5-min kWh_inc slots with confidence bands

### Alarm decoding
`server/alarms.js` maps the 16-bit Modbus alarm register to named faults per Ingeteam AAV2015IQE01_B §19.2–19.4. Each bit has `label`, `severity` (`warning`|`fault`), `description`, and `action`.

### Forecast pipeline
`ADSI_ForecastService.py` runs as a daemon (cycle configured via settings). It writes output to `%PROGRAMDATA%\ADSI-InverterDashboard\forecast\context\global\global.json`. Express polls that file (mtime-gated) and loads new data via `bulkUpsertForecastDayAhead`. The ML model (`GradientBoostingRegressor` + `RobustScaler`) is persisted to `.joblib` files in the same programdata tree.

### Build artifacts
- `dist/InverterCoreService.exe` — PyInstaller one-file exe (no console window)
- `dist/ForecastCoreService.exe` — PyInstaller one-file exe (no console window)
- `release/` — electron-builder output (NSIS setup + portable exe)

The PyInstaller specs bundle `drivers/`, `shared_data.py`, and `ipconfig.json` as data files so the frozen EXEs are self-contained.
