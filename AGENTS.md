# AGENTS.md

Repository guidance for Codex and other coding agents in `d:\ADSI-Dashboard`.

Read `SKILL.md` first — it is the canonical reference. This file exists as an
always-on summary so agents have core project rules even before skill loading.
For server-layer rules see `server/AGENTS.md`. For Python-layer rules see
`services/AGENTS.md`.

---

## Project Identity

- **Product name**: `ADSI Inverter Dashboard`
- **Author**: Engr. Clariden Montaño REE (Engr. M.)
- **Package**: `inverter-dashboard`
- **Updater app ID**: `com.engr-m.inverter-dashboard` — do not rename
- **Version source of truth**: `package.json` — not footer strings
- **Repo version baseline**: `2.4.30`
- **Latest published release**: `v2.4.30`
- **GitHub release channel**: `mclards/ADSI-Dashboard`
- **Default plant name**: `ADSI Plant`

---

## Stack

- Electron 29 desktop shell (`electron/main.js`, `electron/preload.js`)
- Express 4 API server (`server/index.js`) on port 3500
- SQLite via `better-sqlite3` (`server/db.js`)
- Frontend vanilla JS + Chart.js 4 (`public/js/app.js`, `public/index.html`)
- Python inverter service (`InverterCoreService.py` → `services/inverter_engine.py`) — FastAPI port 9000, Modbus TCP
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
# Always run before Electron build/release
npm run rebuild:native:electron

# Build installer only (does NOT rebuild Python EXEs)
npm run build:installer

# Run before plain Node shell checks
npm run rebuild:native:node
```

> **Critical**: after any `rebuild:native:node` smoke test, always run
> `rebuild:native:electron` before launching or building the Electron app.

> **`ELECTRON_RUN_AS_NODE` warning**: some shells export `ELECTRON_RUN_AS_NODE=1`.
> Direct `electron.exe ...` launches will behave like plain Node and produce
> misleading errors like `Unable to find Electron app`. Clear the env var or
> use `start-electron.js`-style launch semantics for any Electron UI work.

---

## Smoke Test Sequences

**JS syntax check (run after any JS edit):**
```powershell
node --check server/index.js
node --check server/db.js
node --check server/poller.js
node --check server/exporter.js
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

**Live Electron UI smoke (run after frontend, Electron shell, or startup changes):**
```powershell
npm run rebuild:native:electron
Push-Location server/tests
npx playwright test electronUiSmoke.spec.js --reporter=line
Pop-Location
```
Always run from `server/tests` — never from repo root (`.tmp/` has duplicate specs).

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
- Push the release commit and tag **before** creating the GitHub release.
- If `gh release create` times out, inspect GitHub release state before retrying — do not blindly rerun and risk duplicate drafts.
- Clean `release/` before every build. After publish keep only:
  - `Inverter-Dashboard-Setup-<version>.exe`
  - `Inverter-Dashboard-Setup-<version>.exe.blockmap`
  - `latest.yml`
- Do not package `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, or Chromium cache into the build.
- When asked to `publish latest release`: rebuild affected EXEs → run smoke tests → `npm run build:installer` → publish installer assets to GitHub only.

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

## GitHub Hygiene

Do not commit: secrets, tokens, signing keys, `adsi.db` snapshots, archive DB copies,
`auth/` caches, customer exports, `ipconfig.json`, or portable runtime data.

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
| Python | `InverterCoreService.py`, `ForecastCoreService.py`, `services/inverter_engine.py`, `services/forecast_engine.py`, `services/shared_data.py`, `drivers/modbus_tcp.py` |