# Build and Release Reference

## Build Commands

```powershell
npm run rebuild:native:electron   # rebuild better-sqlite3 for Electron ABI
npm run build:installer           # build signed NSIS installer (runs 3 safety gates)
```

`npm run build:win`, `npm run build:installer`, and `npm run build:installer:signed` are **all aliases** for `node scripts/build-installer-signed.js`. There is no longer an unsigned direct-to-electron-builder path. All three enforce the same signing gates.

Neither rebuilds Python service EXEs — do that first with `pyinstaller` if the Python code changed.

## Signed Build Gates

Every installer build runs through `scripts/build-installer-signed.js` and applies three gates in order:

1. **Gate 1 — signing required.** The wrapper reads `build/private/codesign.env` and validates `CSC_LINK` + `CSC_KEY_PASSWORD` + PFX file exist. If any are missing, the build fails in under 2 seconds before electron-builder starts. Dev escape hatch: `ADSI_ALLOW_UNSIGNED=1 npm run build:installer` (never use this for releases — auto-update will break for existing signed installs).

2. **Gate 2 — post-build signature verification.** After electron-builder finishes, the wrapper invokes `scripts/verify-signed-installer.ps1` via PowerShell to:
   - Confirm the file was actually signed (electron-builder can silently skip signing on timestamp-server errors)
   - Pin the signing thumbprint against `build/private/codesign-thumbprint.txt`
   - Reject statuses `NotSigned`, `HashMismatch`, `NotSupportedFileFormat`, `Incompatible`
   - Accept `Valid`, `NotTrusted`, `UnknownError` (CI hosts without the self-signed root installed)

3. **Gate 3 — size floor + SHA-512 log.** 300 MB minimum size (historical builds are ~500-620 MB; a broken build missing Python services would be <100 MB). SHA-512 computed via streaming and logged as base64 — matches what electron-updater expects in `latest.yml`.

**Pre-flight check before running any release build:**
```powershell
Test-Path build\private\codesign.env           # must be True
Test-Path build\private\codesign.pfx           # must be True
Test-Path build\private\codesign-thumbprint.txt # should be True
```

**Gate failure handling — never blindly retry:**

| Output | Meaning | Fix |
|---|---|---|
| `FATAL: code signing is required` | Gate 1 — env file missing | Restore from password manager |
| `FATAL: signature verification FAILED` | Gate 2 — electron-builder silently skipped signing | Check timestamp server, cert expiry, signtool.exe |
| `FATAL: THUMBPRINT MISMATCH` | Gate 2 — wrong PFX or stale thumbprint file | Do NOT ship |
| `FATAL: installer is only X MB, below 300 MB floor` | Gate 3 — Python service EXEs missing | Rebuild with `pyinstaller` first |

A successful build always ends with `[build-installer-signed] Build OK — ready for upload` — verify this line before moving to the publish step.

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