# Audit 2026-04-17 — Power-Loss Resilience (v2.8.10)

Date: 2026-04-17
Status: IMPLEMENTED — pending release build + field verification

## Trigger event

2026-04-17, field site: dashboard PC experienced a sudden Windows shutdown.
Next boot reached the Intel UNDI PXE network-boot prompt (no local OS
found). After manual boot recovery, Windows loaded but ADSI Inverter
Dashboard failed to start with:

> A JavaScript error occurred in the main process
> Uncaught Exception:
> SyntaxError: Error parsing
> C:\Program Files\ADSI Inverter Dashboard\resources\app.asar\node_modules\electron-updater\package.json:
> Unexpected token '

Operator recovered by re-running the installer MSI. Dashboard then booted
and resumed normally (~ several minutes of downtime).

## Root cause

1. Hard power loss while Windows had dirty NTFS metadata.
2. NTFS journal replay on next boot restored the filesystem structure but
   some data blocks under `C:\Program Files\ADSI Inverter Dashboard\` were
   left torn — metadata said "file is N bytes" but the underlying sectors
   held stale / garbage bytes.
3. One of the corrupted regions fell inside `app.asar`'s embedded
   `electron-updater\package.json`. `Unexpected token '` is the classic
   fingerprint of JSON.parse hitting a quote where a structural token was
   expected.
4. Electron's main process loads `electron-updater` via `require()` at
   `electron/main.js:17`. That runs BEFORE the existing
   `process.on("uncaughtException")` handler registered at line 87. The
   SyntaxError therefore bypasses the app's recovery path and falls through
   to Electron's default fatal dialog.
5. Data at `C:\ProgramData\InverterDashboard\adsi.db` was unaffected — the
   SQLite layer's WAL + NORMAL + periodic checkpoint kept it consistent.
   Reinstall restored app files and the DB was picked up intact.

## Fixes shipped in v2.8.10

### Phase A — Boot survival (eliminate cryptic dialog)

A1. **Hoisted fatal handlers** (`electron/main.js` top of file).
    `process.on("uncaughtException")` and `unhandledRejection` are now
    registered before any third-party require. A SyntaxError during
    `require("electron-updater")` is caught and routed through our own
    recovery dialog instead of Electron's default.

A2. **`safeRequire()` wrapper** for every third-party module in the
    Electron main process (`better-sqlite3`, `electron-updater`,
    `../server/runtimeEnvPaths`, `../server/storagePaths`). A corrupt
    app.asar cannot stop boot — the app degrades gracefully (auto-update
    disabled, etc.) and the recovery dialog explains what to do.

A3. **Pre-boot integrity gate** (`electron/integrityGate.js`). Verifies
    `app.asar` against a SHA-512 sidecar manifest (`app.asar.sha512`)
    written at build time. To avoid paying the hash cost on every boot
    (~2–4 s for the ~500 MB asar), the full check only runs when
    `wevtutil` reports a Kernel-Power event 41 or event 6008 (dirty
    shutdown) within the last 24 h. A fast header + size check always
    runs.

A4. **Branded recovery dialog** (`electron/recoveryDialog.js`). Replaces
    Electron's cryptic fatal SyntaxError with:
    - "Dashboard files are damaged" headline
    - "Reinstall Now" button → spawns the stashed installer silently
    - "Show Log" button → opens the recovery log
    - "Quit" button
    Non-destructive to plant data under `C:\ProgramData\InverterDashboard\`.

### Phase B — Offline recovery (cut downtime to ~60 s)

B1. **Auto-update installer stash** (`electron/main.js`
    `stashLastGoodInstaller`). After every signature-verified download,
    copies the installer to
    `C:\ProgramData\InverterDashboard\updates\last-good-installer.exe`
    plus a `.meta.json` sidecar with version + SHA + timestamp.

B2. **NSIS `customInstall` macro** (`scripts/installer.nsh`) seeds the
    same location with the installer at first-install time. Guarantees a
    local copy exists even before the first auto-update cycle.

    **`afterPack` hook** (`scripts/afterPack.js`) writes the
    `app.asar.sha512` manifest during the build pipeline. Wired via
    `package.json` `"build.afterPack": "scripts/afterPack.js"` and
    `"build.nsis.include": "scripts/installer.nsh"`.

### Phase C — DB-layer visibility + auto-restore

C1. **`startupIntegrityResult`** exported from `server/db.js`. Captures
    the pre-open probe result, post-open quick_check, and auto-restore
    action (if any).

C2. **Auto-restore path** (`_autoRestoreMainDbFromBackupSync` in
    `server/db.js`). Before opening `adsi.db`, runs a readonly
    `PRAGMA quick_check(1)` probe. If corrupt, enumerates the 2-slot
    rotating backups under `backups/adsi_backup_{0,1}.db` (written
    every 2 h by `server/index.js runPeriodicBackup`), probes them,
    and copies the newest healthy slot over `adsi.db` — quarantining
    the corrupt file as `adsi.db.corrupt-<ISO-timestamp>`.

C3. **`GET /api/health/db-integrity`** endpoint returns the snapshot as
    JSON for the renderer banner.

C4. **Audit log row** written at server startup when
    `startupIntegrityResult.restored === true`:
    `action=db-auto-restore`, `scope=startup-integrity`, `result=ok`,
    `reason="Restored adsi.db from backup slot N after corrupt
    quick_check (<qc>)"`.

C5. **Renderer red banner** (`public/js/app.js checkBootIntegrityBanner`).
    Persistent, dismissable; tells operator that up to ~2 h of recent
    readings may show gaps (they re-fill as the poller continues running).

### Phase D — Verification

- New `server/tests/crashRecovery.test.js` covers:
  - integrityGate: missing asar, valid asar, corrupt asar, bad header,
    no manifest
  - DB auto-restore: corrupt main DB + valid backup slot → restored and
    readable
- `forecastWatchdogSource.test.js` updated to accept the new
  `safeRequire("better-sqlite3")` form.
- Smoke result: **29 / 30 Node tests pass**.
  - The 1 failing test (`solcastLazyBackfill.test.js`) is a pre-existing
    libuv `UV_HANDLE_CLOSING` native assertion during shutdown cleanup
    on Windows + Node 24. All 11 test assertions pass before the crash.
    Unrelated to this patch. Tracked separately.

### Phase E — Documentation

- This file: `audits/2026-04-17/README.md`
- Plan: `plans/2026-04-17-power-loss-resilience.md`
- User Guide section "Recovering from a sudden power loss"
- CLAUDE.md + MEMORY.md updated for the new version + subsystem

### Phase F — Export page refresh button (co-shipped v2.8.10)

Operator-requested UX addition bundled into v2.8.10. Initial version only
reloaded UI state; revised (same release) to drive every data pipeline
that feeds the Export page, including the Solcast snapshot cache.

**Toolbar**
- Sits above the export grid: `Export Center` title + status line +
  **Refresh** button.
- Status line shows `Last refreshed HH:MM:SS` plus an inline summary of
  the latest refresh result. Hover tooltip exposes full per-source JSON.

**Client — `refreshExportPageData()`**
1. `loadSettings()` — pulls fresh settings from the server.
2. `buildSelects()` — rebuilds every inverter dropdown.
3. `applyExportUiStateToInputs()` + `syncSharedForecastExportFormatControls()`
   + `normalizeAllExportDateInputs()` + `normalizeExportNumberInput()`.
4. `loadForecastDateOptions()` pre-refresh — populates the Day-Ahead
   Comparison card's snapshot/forecast date dropdown with whatever is
   currently in the DB.
5. `POST /api/export/refresh-pipelines` — server-side pipeline refresh
   (see below).
6. `loadForecastDateOptions()` post-refresh — picks up any newly-arrived
   snapshot dates from step 5.
7. `updateExportLastRefreshedLabel(report, errors)` — renders the status
   summary.

**Server — `POST /api/export/refresh-pipelines`**
- Triggers `autoFetchSolcastSnapshots([today, tomorrow])` in gateway
  mode, capped by `Promise.race` against a 10-12 s timeout so a slow
  upstream cannot stall the UI.
- Returns per-source report: `solcast`, `solcastSnapshotDates`,
  `forecastDates`, `energy5min`, `dailyReport`, `auditLog`, `alarms`,
  `readings`. Each carries a `status` (`ok` / `skipped` / `degraded` /
  `timeout` / `error`) plus counts / dates / reason where applicable.
- Remote mode skips the Solcast fetch with `status: "skipped"` so the
  operator sees an explanation rather than a hang.

**Files touched**
- `public/index.html` — `#page-export .exp-toolbar` block at
  `public/index.html:518`.
- `public/js/app.js` — `refreshExportPageData()`,
  `updateExportLastRefreshedLabel()` at `public/js/app.js:15586-15694`;
  handler binding at `public/js/app.js:17468`.
- `public/css/style.css` — `.exp-toolbar*` + shared `.mdi-spin` keyframe
  at `public/css/style.css:6451-6490`.
- `server/index.js` — `POST /api/export/refresh-pipelines` at
  `server/index.js:15032-15145`.
- `docs/ADSI-Dashboard-User-Manual.md` §6.8 — full behavior description.

**In-flight exports are unaffected.** Exports hold their own
`AbortController`; refresh only touches form state + the Solcast cache.

## Files touched

| File | Change type |
|---|---|
| `electron/main.js` | Modified (hoist handlers, safeRequire, integrity gate call, updater guards, installer stash) |
| `electron/integrityGate.js` | New |
| `electron/recoveryDialog.js` | New |
| `scripts/afterPack.js` | New (electron-builder afterPack hook) |
| `scripts/installer.nsh` | New (NSIS customInstall macro) |
| `package.json` | Modified (version 2.8.9 → 2.8.10, afterPack hook, nsis.include) |
| `server/db.js` | Modified (pre-open probe, auto-restore, startupIntegrityResult export) |
| `server/index.js` | Modified (import startupIntegrityResult, `/api/health/db-integrity`, audit_log row) |
| `public/js/app.js` | Modified (checkBootIntegrityBanner, invoked from init) |
| `server/tests/crashRecovery.test.js` | New (integrity gate + auto-restore) |
| `server/tests/forecastWatchdogSource.test.js` | Modified (accept safeRequire form) |
| `docs/user-guide.md` | Modified (power-loss recovery runbook) |

## Verification matrix

| Scenario | Expected | Verified |
|---|---|---|
| Clean boot, healthy asar | No dialog, normal UI | Integration test + smoke |
| Boot after dirty shutdown, healthy asar | Full hash check runs, no dialog | Unit test |
| Corrupt app.asar (torn write) | Recovery dialog appears, "Reinstall Now" stashes-then-spawns installer silently, relaunch | Unit test (integrity gate); manual TBD on build |
| Corrupt `adsi.db` + valid backup slot | Auto-restore, banner shown, audit_log row written | Unit test `crashRecovery.test.js` |
| Corrupt `adsi.db` + no valid backup | App boots with empty DB, banner shown, quickCheck=corrupt | Code path; manual TBD |
| `electron-updater` fails to load but app.asar otherwise OK | App boots, auto-update disabled, normal UI | Code path review; manual TBD on build |
| PXE boot recovery | Documented in User Guide runbook | Docs only (environmental) |

## Known limitations

- **NTFS is still the filesystem.** This patch cannot prevent NTFS metadata
  corruption on power loss. It only ensures the dashboard recovers
  gracefully after the OS recovers. Operator must still run
  `chkdsk C: /f /r` and `sfc /scannow` after any PXE event.
- **UPS is strongly recommended** on the dashboard PC. The patch reduces
  the cost of power-loss events but does not eliminate them.
- **Disable Windows Fast Startup** so a reboot always fully flushes NTFS.
  Documented in User Guide.

## Operator runbook additions

1. If dashboard shows "Dashboard files are damaged" → click Reinstall Now.
2. If PC boots to PXE → Power off, wait 10 s, power on, F12 → Windows
   Boot Manager. Run `chkdsk C: /f /r` and `sfc /scannow` after boot.
3. If dashboard shows "Database auto-restored" banner → normal; gaps refill.
4. Install a UPS, disable Windows Fast Startup.
