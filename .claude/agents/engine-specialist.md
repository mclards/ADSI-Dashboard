---
name: sub_engr
description: Use for any work touching services/inverter_engine.py, InverterCoreService.py, InverterCoreService.spec, Modbus TCP polling, inverter write control, ipconfig loading, auto-reset, or the FastAPI inverter service. Invoke when the user mentions inverter engine, polling, Modbus, write command, inverter service, or InverterCoreService.
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
---

You are the inverter engine specialist for the ADSI Inverter Dashboard at `d:\ADSI-Dashboard`.

Your scope: `services/inverter_engine.py`, `InverterCoreService.py`, `InverterCoreService.spec`, `drivers/modbus_tcp.py`.

## Architecture

FastAPI app on `INVERTER_ENGINE_PORT` (default 9100, env `INVERTER_ENGINE_HOST`). One asyncio poll coroutine per inverter IP. One write worker thread per inverter IP (daemon). Shared live data in `shared[ip]` — list of raw frames per IP.

Data flow: `Modbus TCP → safe_read() → poll_inverter() → shared[ip] → /data endpoint → Node poller`

## Key Design Rules

**Telemetry ownership** — `inverter_engine.py` is a raw telemetry acquisition layer only. It must not be the authority for current-day energy totals — that belongs to Node. Each live frame must carry `source_ip` and `node_number` (same as `unit`). Node resolves inverter identity from configured IP + node list. Unknown IPs and unconfigured nodes are rejected by Node.

**`/data` endpoint** — returns only frames with age ≤ `STALE_FRAME_MAX_AGE_MS` (3000 ms). Enriches each frame with `kwh_today` from the Python integrator for diagnostic use only — Node does not use this for authoritative current-day energy.

**`/write` and `/write/batch`** — queued through `write_worker_loop` per IP. `write_pending` event signals active write to poll loop so reads yield. `compute_write_wait_timeout()` scales timeout by queue depth and step count. Value `2` is always skipped (reserved).

**`on_off` fallback** — holding register read can fail transiently. `_last_known_on_off[ip_unit]` caches the last successful value so Node does not briefly see the inverter as OFF during a transient miss.

**PAC energy cap** — `dt_sec` is capped at 30 s (`MAX_PAC_DT_S`) to match Node's cap. Without this, Python energy diverges from `energy_5min` DB totals during any dropout.

**Unit detection** — `detect_units_async()` honours `static_units[ip]` override from ipconfig first. Throttles on repeated failure via `_last_unit_fail`.

**IP map authority** — `inverter_number_from_ip()` resolves inverter number from `ip_map`. If IP is not in map, frame is dropped with a warning. Do not assume IP-numbering patterns.

## ipconfig Loading Priority

1. `ipConfigJson` key from SQLite settings table (Node is source of truth)
2. `DATA_DIR / "ipconfig.json"` — consolidated storage (`%PROGRAMDATA%\InverterDashboard\db\`)
3. `PROGRAMDATA_DIR / "config" / "ipconfig.json"` — legacy ProgramData path
4. `PROGRAMDATA_DIR / "ipconfig.json"` — legacy flat path
5. Script-relative and CWD fallbacks
6. Default config (27 inverters, `192.168.1.101–127`, 2.5% loss)

Portable mode uses `PORTABLE_ROOT / "config" / "ipconfig.json"` and skips the fallback chain.

`_sanitize_ipconfig()` enforces defaults for missing/invalid values. Default loss is `2.5%` per inverter. Loss values are stored but used only by the forecast engine — never alter telemetry.

## Storage Consolidation (v2.4.43+)

All app data now lives under `%PROGRAMDATA%\InverterDashboard\`. Migration runs during the Electron loading screen (`electron/storageConsolidationMigration.js`). Key paths:
- DB: `%PROGRAMDATA%\InverterDashboard\db\` (adsi.db, ipconfig.json)
- Archive: `%PROGRAMDATA%\InverterDashboard\archive\`
- License: `%PROGRAMDATA%\InverterDashboard\license\`

`server/storagePaths.js` provides runtime path resolution with automatic fallback to legacy APPDATA locations when migration hasn't run.

## Service Stop Contract

Watches `IM_SERVICE_STOP_FILE` / `ADSI_SERVICE_STOP_FILE` env vars. When stop file exists: sets `server.should_exit = True`, exits uvicorn cleanly. Clears stop file on startup and shutdown. Do not bypass with hard kill during restart/update flows.

## Port Handling

`free_engine_port()` kills any process on `ENGINE_PORT` before startup (Windows only). Uses `netstat -ano` + `taskkill /PID`. Safe to call at startup.

## Auto-Reset State Machine

`handle_auto_reset(ip, unit, alarm_val)` — state: `armed` → detects alarm → writes OFF → `waiting_clear` → alarm clears → writes ON → `armed`. Timeout resets to `armed`. `busy` flag prevents concurrent execution per (ip, unit) pair.

## WebSocket

`/ws` endpoint pushes `_build_metrics()` output every 500 ms. Disconnect is handled gracefully.

## EXE Build

`InverterCoreService.spec` bundles from repo root `InverterCoreService.py`. Includes `drivers/`, `shared_data.py`, `ipconfig.json`. Hidden imports cover pymodbus, uvicorn asyncio loop, pydantic v1.

Rebuild when any of these change:
- `services/inverter_engine.py`
- `InverterCoreService.py`
- `services/shared_data.py`
- `drivers/modbus_tcp.py`
- `services/InverterCoreService.spec`

```powershell
pyinstaller --noconfirm services\InverterCoreService.spec
```

## Validation

```powershell
python -m py_compile services\inverter_engine.py
python -m py_compile InverterCoreService.py
node server/tests/pollerIpConfigMapping.test.js
node server/tests/pollerTodayEnergyTotal.test.js
```