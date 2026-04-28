# Plan 2026-04-17 — Power-Loss Resilience (v2.8.10)

Date: 2026-04-17
Status: IMPLEMENTED (code + tests + docs) — pending release build.
Audit: `audits/2026-04-17/README.md`

## Goal

After a sudden Windows shutdown (power loss, forced reboot, PXE recovery),
the ADSI Inverter Dashboard must either:

1. Launch normally (plant data intact; app files intact), or
2. Launch into a branded recovery dialog with a one-click "Reinstall Now"
   that completes in under 60 seconds without network access.

The cryptic Electron
`SyntaxError: Error parsing …\electron-updater\package.json` dialog that
the operator saw on 2026-04-17 must be impossible to reach from any
single-file-corruption failure mode.

## Non-goals

- Preventing NTFS corruption itself (out of scope — OS/hardware).
- Detecting tampering / supply-chain attacks (Authenticode + electron-
  updater SHA-512 already own that surface).
- Surviving damage to `C:\ProgramData\InverterDashboard\` itself. The
  2-slot rotating backup provides a last line of defence (Phase C), but
  catastrophic ProgramData damage still requires restore from cloud
  backup (existing feature).

## Architecture (5 slices)

### Slice A — Boot survival

The Electron main process must defend against any third-party require
throwing synchronously.

- A1: Hoist `uncaughtException` + `unhandledRejection` handlers above all
  third-party requires.
- A2: `safeRequire()` wrapper for third-party modules. Failures collect in
  `_startupFailures[]` for the recovery dialog.
- A3: `electron/integrityGate.js` verifies `app.asar` against an
  `app.asar.sha512` sidecar. Full check gated on `wasDirtyShutdown()`
  (Event Log probe) to keep boot fast on normal restarts.
- A4: `electron/recoveryDialog.js` renders a branded modal with
  "Reinstall Now" / "Show Log" / "Quit" actions. Logs to
  `C:\ProgramData\InverterDashboard\logs\recovery.log`.

### Slice B — Offline recovery

Operator must have a local installer available for reinstall without
needing network or access to the MSI file.

- B1: After each successful auto-update, `stashLastGoodInstaller()` in
  `electron/main.js` copies the verified signed installer to
  `C:\ProgramData\InverterDashboard\updates\last-good-installer.exe`
  plus `.meta.json`.
- B2a: NSIS `customInstall` macro in `scripts/installer.nsh` seeds the
  same path with the current installer at first-install time.
- B2b: `scripts/afterPack.js` writes `app.asar.sha512` during
  electron-builder `afterPack` phase.

### Slice C — Data-layer integrity visibility + auto-restore

SQLite data layer already has WAL+NORMAL crash-safety + 2-slot backup.
Missing pieces:

- C1: Pre-open readonly probe in `server/db.js`. If `PRAGMA
  quick_check(1)` fails or header is invalid, auto-restore from the
  newer of the two backup slots. Quarantine the corrupt file as
  `adsi.db.corrupt-<ISO-timestamp>`.
- C2: `startupIntegrityResult` exported from `server/db.js`.
- C3: `GET /api/health/db-integrity` endpoint in `server/index.js`.
- C4: Write an `audit_log` row at server boot when `restored === true`
  (scope=`startup-integrity`, action=`db-auto-restore`).
- C5: Renderer banner in `public/js/app.js` (`checkBootIntegrityBanner`)
  shown persistently until dismissed.

### Slice D — Verification

- `server/tests/crashRecovery.test.js` — integrity gate (5 cases) + DB
  auto-restore (1 case) under the Node-ABI smoke harness.
- `server/tests/forecastWatchdogSource.test.js` — accept the new
  `safeRequire("better-sqlite3")` form.
- Full `npm run smoke` must keep the baseline green. Acceptable: 29/30
  (the known-flaky `solcastLazyBackfill.test.js` Windows native shutdown
  crash is out of scope).

### Slice E — Documentation

- `audits/2026-04-17/README.md` (this audit)
- `plans/2026-04-17-power-loss-resilience.md` (this plan)
- User Guide "Recovering from a sudden power loss" runbook
- CLAUDE.md version bump to 2.8.10 + brief changelog line
- MEMORY.md pointer to this plan

## Invariants (explicit)

I1. No code path between Electron `app ready` and the recovery dialog may
    require parsing JSON from `app.asar`. The integrity gate is Node-core
    only (fs, path, crypto, child_process).

I2. The `app.asar.sha512` manifest must live outside `app.asar`.
    Otherwise a corrupt asar invalidates the checker itself.

I3. Recovery must not depend on network. The installer stash under
    `%PROGRAMDATA%\InverterDashboard\updates\` is authoritative.

I4. Data layer behaviour must not regress for healthy DBs. The pre-open
    probe is readonly + throwaway. No schema changes.

I5. Backwards compatible with old installs. Updater app ID unchanged.
    Existing v2.8.9 machines auto-update to v2.8.10 normally.

## Rollout

1. Cut v2.8.10 installer (signed).
2. Deploy to 1 pilot site first. Observe integrity log + auto-update
    stash for 48 h.
3. If no regressions, push GitHub Release for fleet auto-update.
4. Field site (PXE incident): manual reinstall with v2.8.10 MSI. Verify
    recovery dialog visually via a synthetic torn-write drill.

## Synthetic drill procedure (post-build)

On a staging PC with v2.8.10 installed:

```powershell
# 1. Confirm stashed installer exists
Test-Path "$Env:PROGRAMDATA\InverterDashboard\updates\last-good-installer.exe"

# 2. Confirm integrity manifest exists
Test-Path "C:\Program Files\ADSI Inverter Dashboard\resources\app.asar.sha512"

# 3. Stop the dashboard
Stop-Process -Name "ADSI Inverter Dashboard" -Force -ErrorAction SilentlyContinue

# 4. Corrupt app.asar deliberately
$asar = "C:\Program Files\ADSI Inverter Dashboard\resources\app.asar"
$bytes = [IO.File]::ReadAllBytes($asar)
$bytes[1000] = 0x27  # apostrophe
[IO.File]::WriteAllBytes($asar, $bytes)

# 5. Launch app
& "C:\Program Files\ADSI Inverter Dashboard\ADSI Inverter Dashboard.exe"

# Expected: recovery dialog appears within 3 s. Click "Reinstall Now".
# Silent NSIS reinstalls, app relaunches, integrity check passes.
```

Pass criteria:

- Dialog text reads "Dashboard files are damaged"
- Stash installer path visible
- Clicking Reinstall Now completes under 60 s wall time
- Post-reinstall, dashboard boots normally; no red banner
- `recovery.log` contains the torn-write event record

## Telemetry to track post-rollout

- Count of recovery.log entries across the fleet
- Count of `audit_log` rows where `scope=startup-integrity`
- Number of PCs that auto-updated to v2.8.10 vs still on v2.8.9
- Did any machine ship without the `app.asar.sha512` sidecar (pre-2.8.10
  installs will see `mode=skipped` — acceptable)
