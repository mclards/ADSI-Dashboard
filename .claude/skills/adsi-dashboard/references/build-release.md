# Build and Release Reference

## Build Commands

```powershell
npm run rebuild:native:electron   # rebuild better-sqlite3 for Electron ABI
npm run build:installer           # build NSIS installer only
```

`npm run build:win` and `npm run build:installer` are equivalent — both installer-only. Neither rebuilds Python service EXEs.

## `better-sqlite3` ABI Rules

- `npm run rebuild:native:node` — before plain Node shell checks
- `npm run rebuild:native:electron` — before Electron run / build / release
- **After any Node-ABI smoke test, always restore with `npm run rebuild:native:electron`** before launching Electron
- If desktop startup fails with `NODE_MODULE_VERSION` mismatch, fix with `npm run rebuild:native:electron`

## `ELECTRON_RUN_AS_NODE` Warning

Some shells export `ELECTRON_RUN_AS_NODE=1`. Direct `electron.exe ...` launches will behave like plain Node, producing misleading errors like `Unable to find Electron app`. Clear the env var or use `start-electron.js`-style launch semantics.

## Python Service EXE Rebuild Mapping

| Changed surface | Rebuild |
|---|---|
| Inverter-service code / spec | `pyinstaller --noconfirm services\InverterCoreService.spec` |
| Forecast-service code / spec | `pyinstaller --noconfirm services\ForecastCoreService.spec` |
| `shared_data.py` or `drivers/modbus_tcp.py` | Rebuild both |
| Electron / server / frontend only | Neither |

Do not publish if EXEs were built against stale Python binaries.

## JS Syntax Checks

```powershell
node --check server/index.js
node --check server/db.js
node --check server/poller.js
node --check server/exporter.js
node --check public/js/app.js
node --check electron/main.js
node --check electron/preload.js
```

## Smoke Test Sequences

**Live Electron UI smoke** (frontend / Electron shell / startup changes):
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

**Restart / update shutdown changes:**
```powershell
node server/tests/serviceSoftStopSource.test.js
npm run rebuild:native:electron
```

**Forecast provider / parity changes:**
```powershell
node server/tests/forecastProviderParity.test.js
node server/tests/dayAheadPlanImplementation.test.js
```

## Release Workflow

1. **Determine what changed** — check git log and MEMORY.md since last release
2. **Rebuild Python EXEs** if needed (see mapping above)
3. **Bump version** — update `package.json`, then align all together:
   `package.json`, `package-lock.json`, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, `docs/ADSI-Dashboard-User-Guide.html`, `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.pdf`, `public/user-guide.html`
4. **Build**: `npm run rebuild:native:electron` then `npm run build:installer`
5. **Commit and tag before creating GitHub release**:
   ```powershell
   git add -A && git commit -m "Release v<version>"
   git tag v<version>
   git push origin main --tags
   ```
6. **Publish** — installer only, no portable EXE:
   ```powershell
   gh release create v<version> `
     "release\Inverter-Dashboard-Setup-<version>.exe" `
     "release\Inverter-Dashboard-Setup-<version>.exe.blockmap" `
     "release\latest.yml" --title "v<version>"
   ```
7. **Post-publish** — clean `release/` down to the three current files

If `gh release create` times out, inspect GitHub release state before retrying — do not blindly rerun.

## Release Artifacts

After publish, `release/` contains only:
- `Inverter-Dashboard-Setup-<version>.exe`
- `Inverter-Dashboard-Setup-<version>.exe.blockmap`
- `latest.yml`

Do not package `adsi.db`, `archive/`, `auth/`, `cloud_backups/`, Chromium cache, or customer exports into the build.

## Version Alignment on Release

These files are all bumped together before a release:
`package.json`, `package-lock.json`, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, `docs/ADSI-Dashboard-User-Guide.html`, `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.pdf`, `public/user-guide.html`

The User Guide version header inside `docs/ADSI-Dashboard-User-Guide.html` and `docs/ADSI-Dashboard-User-Manual.md` must match `package.json`. Update it explicitly on every release — do not leave it on the old version.

Additionally, any UI change (regardless of release) must update all three User Guide formats before handoff:
- `docs/ADSI-Dashboard-User-Guide.html`
- `docs/ADSI-Dashboard-User-Manual.md`
- `docs/ADSI-Dashboard-User-Guide.pdf`

PDF regeneration: `chrome --headless=new --disable-gpu --no-sandbox --print-to-pdf="docs\ADSI-Dashboard-User-Guide.pdf" --print-to-pdf-no-header "docs\ADSI-Dashboard-User-Guide.html"`

Electron writes stop files (`IM_SERVICE_STOP_FILE`, `ADSI_SERVICE_STOP_FILE`) → Python services exit cleanly → force-kill only after bounded grace window. Do not reintroduce unconditional `taskkill` during restart/update flows.

## Windows Elevation

`requestedExecutionLevel = requireAdministrator` in `package.json`. Do not change without assessing impact on device access, local service control, and protected-path writes.