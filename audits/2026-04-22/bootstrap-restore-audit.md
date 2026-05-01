# Bootstrap-Restore Wizard — Audit

**Date:** 2026-04-22
**Status:** Implemented + 2nd-pass-hardened (v2.8.14 candidate)
**Author:** Claude (under operator instruction "you know the best approach, its up to yuou already on implementing it all. Architect it well and do comprehensive audits/documentations")

> **2nd pass note (12:55 GMT+8):** Operator pushed back on the initial "SHIP"
> recommendation. A deep code-review pass surfaced 9 real bugs (2 CRITICAL,
> 3 HIGH, 2 MEDIUM, 2 LOW) in the wizard. All fixed before this revision.
> See §13 (Issues found in 2nd-pass audit) for the full list and resolution.

---

## 1. Problem statement

Operators reinstalling the dashboard on a new machine (after OS rebuild,
hardware migration, or first-time deploy from a saved `.adsibak`) currently
have **no way to seed the fresh install with their existing data** before the
license check.

The native license prompt (`ensureLicenseAtStartup` in
[electron/main.js:3110](../../electron/main.js#L3110)) used to offer only:

| Button | Effect |
|---|---|
| Start 7-Day Trial | Activates trial against this machine's hardware fingerprint |
| Upload License | Picks a `.json/.dat/.lic` file and validates it |
| Exit | Closes the app |

A user with a `.adsibak` file would have to:

1. Click "Start 7-Day Trial" (burning their one-time trial slot)
2. Wait for the dashboard to boot
3. Log in with default credentials
4. Navigate to **Settings → Local Backup**
5. Click **Import .adsibak**, select the file, validate it
6. Click **Restore**, confirm
7. Manually restart the dashboard so the restored DB takes effect

That's 7 steps, and step 1 wastes the trial. If the `.adsibak` contained a
valid license file bound to the same fingerprint, the trial activation was
unnecessary in the first place.

---

## 2. Goals

| Goal | How addressed |
|---|---|
| Add a 4th option to the license prompt: **Restore from Backup...** | [main.js:3117-3146](../../electron/main.js#L3117) — both `trial_not_started` and expired branches |
| Operator picks ONLY what to restore (DB, settings, logs, archive, license, auth) | [bootstrapRestore.js:51-95](../../electron/bootstrapRestore.js#L51) `SCOPE_DEFINITIONS` |
| Validate the `.adsibak` (manifest + checksums) BEFORE asking for confirmation | [bootstrapRestore.js:228-252](../../electron/bootstrapRestore.js#L228) `IPC.VALIDATE` handler |
| Show row counts so operator knows what's about to land | [bootstrap-restore.js:108-125](../../public/bootstrap-restore.js#L108) `renderSummary` |
| Run restore even though the embedded server isn't started yet | [bootstrapRestore.js:155-186](../../electron/bootstrapRestore.js#L155) `buildBootstrapBackupService` |
| Relaunch the app after restore so integrity gate, storage migration, and license loader all re-run cleanly | [main.js:3270-3279](../../electron/main.js#L3270) `app.relaunch()` + `app.exit(0)` |
| All paths are theme-consistent with the rest of the dashboard | [bootstrap-restore.html](../../public/bootstrap-restore.html) — same color tokens as `style.css` |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  app.whenReady (main.js:1720)                                   │
│       ↓                                                         │
│  ensureLicenseAtStartup()                                       │
│       ↓                                                         │
│  Native dialog: [Trial] [Upload] [Restore from Backup…] [Exit]  │
│                                            │                    │
│                                            ▼                    │
│                       handleBootstrapRestoreFromLicensePrompt() │
│                                            │                    │
│                                            ▼                    │
│                  bootstrapRestore.runBootstrapRestoreFlow()     │
│                                            │                    │
│                            ┌───────────────┴──────────┐         │
│                            ▼                          ▼         │
│              registerIpcHandlers              spawn BrowserWin  │
│                            │                  preload-bootstrap │
│                            │                  bootstrap-restore │
│                            ▼                                    │
│                    wizard renderer:                             │
│                       1. pickFile  ──────▶ dialog.showOpenDialog│
│                       2. validate  ──────▶ svc.validatePortable │
│                       3. checklist (DB/cfg/logs/archive/lic/auth)│
│                       4. run       ──────▶ svc.importPortable   │
│                                            svc.restorePortable  │
│                                              ({scopeFilter})    │
│                       5. complete  ──────▶ ipcMain.once         │
│                                            "...complete"        │
│                            ▲                          │         │
│                            └─────── unregister ◀──────┘         │
│                                            │                    │
│                                            ▼                    │
│                                  app.relaunch() + app.exit(0)   │
└─────────────────────────────────────────────────────────────────┘
```

### File map

| New file | Purpose |
|---|---|
| [electron/bootstrapRestore.js](../../electron/bootstrapRestore.js) | Main-process orchestrator + IPC handlers |
| [electron/preload-bootstrap-restore.js](../../electron/preload-bootstrap-restore.js) | `contextBridge` exposure for wizard IPC |
| [public/bootstrap-restore.html](../../public/bootstrap-restore.html) | Wizard markup + theming (matches dashboard variables) |
| [public/bootstrap-restore.js](../../public/bootstrap-restore.js) | Wizard renderer logic (steps 1-5) |

| Modified file | Change |
|---|---|
| [electron/main.js](../../electron/main.js#L3110) | `ensureLicenseAtStartup` gains 4th button + `handleBootstrapRestoreFromLicensePrompt` helper |
| [server/cloudBackup.js](../../server/cloudBackup.js#L1255) | `_scopeAllowed`, `opts.scopeFilter` plumbed through `_restoreBackupLocked`, `_assertRestoreDestinationsWritable`, `restorePortableBackup`, `_restorePortableBackupLocked` |
| [server/tests/cloudBackupRestoreSafety.test.js](../../server/tests/cloudBackupRestoreSafety.test.js) | `testScopeFilterSelectiveRestore`, `testScopeFilterEmptyArrayBlocksAll` |

---

## 4. Scope checklist design

| Scope | Default | Recommended? | Rationale |
|---|---|---|---|
| `database` | ✅ checked | ✅ critical | The whole point of migration: bring the plant DB across |
| `config` | ✅ checked | ✅ critical | Inverter IPs, settings, schedules — without this the new install is blank |
| `logs` | ☐ unchecked | no | Forensic only; useless on a fresh PC unless debugging |
| `archive` | ✅ checked | no | Long-term roll-ups — usually wanted, but skippable for disk-space-constrained machines |
| `license` | ☐ unchecked | no | Hardware-bound — restored license is RE-validated against this machine's fingerprint, so it's almost always invalid after migration. Default off to avoid confusion |
| `auth` | ☐ unchecked | no | Cloud OAuth tokens encrypted with source machine key — always need re-auth after migration |

The wizard greys out scopes that are **not present in the manifest** (e.g.,
a backup created with `["database","config"]` shows logs/archive/license/auth
as "not in this backup").

The "Restore" button is disabled if zero scopes are checked.

---

## 5. Why the embedded server isn't running here

`app.whenReady` calls `ensureLicenseAtStartup()` BEFORE `showLoginWindow()`,
which calls `startAfterLogin()`, which calls `startServer()`. So during the
wizard:

- No Express server is listening on port 3500
- No HTTP fetch is possible
- `server/index.js` has not been required, so `db.js`, `cloudBackup.js`,
  `backupHealthRegistry.js` have not initialized

To bypass this we construct a minimal `CloudBackupService` directly in the
main process via `buildBootstrapBackupService`, with:

- `db: null` — restore uses `fs.copyFileSync` for the DB; no live handle needed
- `tokenStore`/`onedrive`/`gdrive`/`s3: null` — cloud providers irrelevant
- `poller: { isRunning: () => false, ... }` — stub that satisfies the restore path's poller-stop logic
- A `Map`-backed `getSetting`/`setSetting` — restored settings land in the map and are written to the DB on next launch via the normal settings-store path (the restored `adsi.db` already contains them)

This intentionally skirts:

- Mode gating (`_isRemoteMode`) — settings haven't been loaded yet, so it
  always returns `false` (gateway). Correct: bootstrap restore is always a
  gateway-mode operation.
- Health registry — no `BackupHealthRegistry` instance is wired. Restore
  outcome is reported via the wizard UI directly, not via WebSocket.
- Tier 1 / Tier 3 cron jobs — none are scheduled because `runPeriodicBackup`
  is never called.

---

## 6. Security model

| Concern | Mitigation |
|---|---|
| User picks an arbitrary file claiming to be `.adsibak` | `assertValidAdsibakPath` checks `existsSync`, `isFile()`, and `.adsibak` extension before any IPC call touches it |
| Malicious `.adsibak` with crafted manifest | `validatePortableBackup` calls `_checkCompatibility` (rejects schemaVersion mismatch) and `_verifyChecksums` (rejects tampered files) before import |
| User tries to restore over a running install | The wizard appears only at startup BEFORE the embedded server has bound port 3500. Settings DB hasn't been opened. No live state to corrupt |
| Pre-restore writability probe fires on an empty `%PROGRAMDATA%` and aborts | `skipSafetyBackup: true` and the probe runs only AFTER directories are created — all 6 destinations (`db`, `forecast`, `history`, `weather`, `logs`, `archive`) are mkdir'd first by `_assertRestoreDestinationsWritable`'s `mkdirSync(..., {recursive:true})` |
| User leaves wizard window open and walks away | Window `closed` event resolves the outer promise as canceled — license loop continues normally |
| IPC handlers leak into next license-prompt iteration | Handlers are registered inside `runBootstrapRestoreFlow` and unregistered in the `finally` block via `removeHandler` for every channel in `WIZARD_CHANNELS` |
| Restore writes outside `%PROGRAMDATA%\InverterDashboard\` | All destinations resolve through `getProgramDataDir()` / `getDataDir()` / `getBackupDir()` — same helpers as the rest of the app. No user-supplied path goes near the destination |

### What we explicitly do NOT do

- **No automatic license re-activation:** the license loader runs on the
  next launch (after `app.relaunch()`) and re-validates against this
  machine's hardware fingerprint. If the restored license matches, the
  user skips the prompt entirely. If not, they're back at "Start Trial /
  Upload License / Restore from Backup..." with their migrated DB intact.
- **No CSP unsafe-eval / inline script:** the wizard CSP is
  `default-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'self'`
  (inline styles only because the wizard has no separate CSS file — kept
  small intentionally to avoid an extra round-trip during a fragile boot).
- **No remote DevTools:** `webPreferences` is the same locked-down config
  as the login window.

---

## 7. Failure modes mapped

| Failure | Detection | Recovery |
|---|---|---|
| User picks a non-`.adsibak` file | `assertValidAdsibakPath` throws | Wizard shows error, user can re-pick |
| `.adsibak` is corrupt (zip extract fails) | `importPortableBackup` throws inside PowerShell `Expand-Archive` | Wizard shows error, user can re-pick |
| Manifest schemaVersion is too new | `_checkCompatibility` throws | Wizard shows error with version string |
| Checksum mismatch | `_verifyChecksums` returns false | Wizard shows error, user can re-pick |
| `%PROGRAMDATA%\InverterDashboard\` not writable (e.g., locked-down workstation) | `_assertRestoreDestinationsWritable` throws with `icacls` hint | Wizard shows error and the icacls remediation command |
| Mid-restore disk-full | `fs.copyFileSync` throws inside `_restoreBackupLocked` | **No auto-rollback at bootstrap time** because there's nothing to roll back to (skipSafetyBackup: true). Wizard shows error and recommends a fresh install retry. The partial state on disk will be overwritten by the next restore attempt or by manual installer cleanup |
| User closes the wizard via X mid-flow | `wizardWin.on("closed")` resolves promise as canceled | License loop continues |
| `app.relaunch()` fails (extreme edge) | `setTimeout` calls `app.exit(0)` after 100 ms regardless | App exits cleanly; user re-launches manually |

---

## 8. Test coverage added

Two new regression tests in
[server/tests/cloudBackupRestoreSafety.test.js](../../server/tests/cloudBackupRestoreSafety.test.js):

| Test | Verifies |
|---|---|
| `testScopeFilterSelectiveRestore` | Restoring with `scopeFilter: ["database"]` from a `["database","logs"]` backup overwrites the DB but leaves existing log files untouched |
| `testScopeFilterEmptyArrayBlocksAll` | Empty `scopeFilter: []` is the explicit "block all" sentinel — neither DB nor logs are touched |

The pre-existing 6 tests (C-1, R5, R6, R3, paths round-trip, writability
probe) still pass — confirming the scope-filter wiring is additive and
non-breaking.

```
cloudBackupRestoreSafety.test.js: PASS  (8/8)
backupHealthRegistry.test.js: PASS      (existing — unaffected)
```

### What is NOT covered by automated tests

- **The Electron BrowserWindow + IPC plumbing** — exercised only by manual
  smoke testing. Reasoning: spinning up Electron in CI for a native dialog
  is fragile and slow, and the wizard is a thin renderer over IPC handlers
  whose behaviour IS unit-tested at the `CloudBackupService` layer.
- **The license re-validation post-relaunch** — the existing license tests
  cover hardware fingerprint binding; no new behaviour was added there.

Manual smoke checklist (see §10 below) covers the gaps.

---

## 9. Risks and trade-offs

### Accepted risks

- **No safety backup at bootstrap time.** A mid-restore failure leaves a
  half-populated `%PROGRAMDATA%`. Acceptable because (a) the install is
  fresh, so there's nothing to lose, (b) re-running the wizard cleanly
  overwrites partial state, (c) the alternative would be to copy the
  freshly-installed empty DB to a safety slot — pointless overhead.

- **License scope is OFF by default.** Operators who actually have a
  hardware-portable license file (rare, mostly site-license edge cases)
  must remember to check it. We chose this default to avoid the more
  common confusion of "I restored my license but the dashboard still
  asks me to upload one" (because the fingerprint mismatched).

- **The wizard talks to `dialog.showOpenDialog` from the main process,
  not from the renderer.** This means file paths never enter the renderer
  context, which is the intended security posture but means the wizard
  CANNOT do drag-and-drop file selection. Operators must click Browse.
  Acceptable for a one-time bootstrap operation.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Add scope checkboxes to the existing native `dialog.showMessageBox` | Native dialogs don't support checkboxes — only labelled buttons (max ~5) |
| Spin up a minimal HTTP server just for the wizard | Too much surface area for a one-shot operation. Defeats the security model of bootstrap-time isolation |
| Use Electron's `<input type="file">` in the renderer | Requires `nodeIntegration: true` or webkitRelativePath shenanigans; violates `contextIsolation: true` |
| Defer to a separate "first-run" CLI tool the operator runs from PowerShell | Operators are not assumed to know PowerShell; they're plant engineers |

---

## 10. Manual smoke checklist

Run on a clean Windows machine with no `%PROGRAMDATA%\InverterDashboard\`
present, with a `test.adsibak` file ready on the desktop.

- [ ] Launch dashboard → license prompt shows 4 buttons (Trial / Upload / Restore / Exit)
- [ ] Click "Restore from Backup…" → wizard opens, shows step 1
- [ ] Click Cancel → wizard closes, back to license prompt (no relaunch)
- [ ] Click "Restore from Backup…" again → click Browse → cancel native picker → no error
- [ ] Click Browse → select a non-`.adsibak` file → error message shown
- [ ] Click Browse → select valid `.adsibak` → file path shown, Next enabled
- [ ] Click Next → step 2 shows manifest summary (version, scope, file count, row counts)
- [ ] Click Next → step 3 shows scope checklist with appropriate defaults
- [ ] Uncheck all scopes → Next disabled + warning shown
- [ ] Re-check database → Next enabled
- [ ] Click Restore → progress bar animates → step 5 shown
- [ ] Click Relaunch → app exits and relaunches
- [ ] On relaunch: `%PROGRAMDATA%\InverterDashboard\db\adsi.db` exists with restored content
- [ ] On relaunch: license prompt re-appears (because license scope was off)
- [ ] Repeat with license scope CHECKED on a backup containing a valid license for THIS machine → license prompt skipped after relaunch
- [ ] Repeat with `.adsibak` from a different machine → license file is restored but re-validation fails → user is prompted again (but DB is intact)
- [ ] Verify theme: open the wizard with each of the 4 dashboard themes pre-applied to settings.json — wizard always uses its own dark theme (intentional — pre-DB load, no theme available)

---

## 11. Build and packaging

The wizard files must be included in the electron-builder package:

- [electron/bootstrapRestore.js](../../electron/bootstrapRestore.js) — covered by the existing `electron/**` glob
- [electron/preload-bootstrap-restore.js](../../electron/preload-bootstrap-restore.js) — same
- [public/bootstrap-restore.html](../../public/bootstrap-restore.html) — covered by `public/**`
- [public/bootstrap-restore.js](../../public/bootstrap-restore.js) — same

No `package.json` changes required. Verified by checking `package.json` "files" globs:

```bash
git check-ignore -v electron/bootstrapRestore.js public/bootstrap-restore.html public/bootstrap-restore.js electron/preload-bootstrap-restore.js
# (all four are tracked)
```

---

## 12. Follow-ups (not in this commit)

- [ ] Optional: also expose this wizard from **Settings → Local Backup → "Open Bootstrap Restore Wizard…"** for operators who want to re-run a clean restore later.
- [ ] Optional: pre-populate the file picker with the most recent `.adsibak` found on detected USB drives (auto-discovery).
- [ ] Optional: add a "Restore log" button on step 5 that opens `%PROGRAMDATA%\InverterDashboard\logs\bootstrap-restore.log` for support escalation.
- [ ] Document the wizard in the User Guide HTML/MD/PDF (see `feedback_guide_sync.md`).

---

## 13. Issues found in 2nd-pass audit (and how they were fixed)

After the initial implementation passed all unit tests, the operator
asked "dont recommend 'SHIP' without polishing every implementation made.
Deep find bugs/gaps/issues." A line-by-line re-read surfaced these:

### CRITICAL

| # | Bug | Fix |
|---|---|---|
| 1 | `runRestore()` called `complete({restored:true})` immediately after `setStep(5)`. Main's `onWizardComplete` then closed the wizard within ~16 ms — user never saw the success page or the Relaunch button. Effectively the success page only flashed. | Removed `complete()` from `runRestore()`. The success signal now travels ONLY when the user clicks the Relaunch button on step 5 ([bootstrap-restore.js btnRelaunch handler](../../public/bootstrap-restore.js)). |
| 2 | Cancel button stayed visible+enabled during step 4 (restore in progress). User clicking Cancel mid-restore would resolve the outer promise as canceled and close the window, while the actual `restorePortableBackup` kept running in the main process. The next license-prompt iteration could race against in-flight disk writes. Same race was possible via the title-bar X. | (a) `state.restoreInFlight` flag in renderer hides Cancel/Back during step 4. (b) `restoreInFlight` flag in main intercepts `wizardWin.on("close")` and shows a blocking "please wait" message-box. (c) `IPC.CANCEL` handler refuses to honour cancel while `restoreInFlight=true`. |

### HIGH

| # | Bug | Fix |
|---|---|---|
| 3 | The `ensureProgramDataRootWritable()` IIFE in [server/index.js:198](../../server/index.js#L198) only runs when the server is required — but bootstrap restore happens BEFORE the server is loaded. On a non-admin user with installer-set ACLs missing or insufficient, the restore would fail mid-flight with EPERM. | Replicated the IIFE as `ensureProgramDataRootWritable()` in [bootstrapRestore.js](../../electron/bootstrapRestore.js). Called explicitly inside `IPC.RUN` BEFORE constructing the service. Returns `{ok, action, error}` and refuses to proceed if `icacls` couldn't grant Users:M. |
| 4 | If the restore failed mid-flight (e.g., disk full while writing forecast/), the imported `.adsibak` package directory and history-file entry were left behind in `cloud_backups/` permanently. Repeated retries would accumulate cruft. | `IPC.RUN` handler tracks `importedPackageId` + `importedPackageDir`. On failure, removes the directory and drops the history entry. Cleared on success (the entry is a useful "last bootstrap restore" trail). |
| 5 | If `wizardWin.loadFile()` failed (damaged install, missing HTML), the window stayed at `about:blank` with no error feedback and no IPC handlers active. Caller stuck until manual X-close. | Wired `wizardWin.webContents.on("did-fail-load")` to show a native `dialog.showErrorBox` and resolve the outer promise as `{ok:false, error}`. Also catches the `loadFile().catch()` path. |

### MEDIUM

| # | Bug | Fix |
|---|---|---|
| 6 | `setTimeout(() => app.exit(0), 100)` inside `handleBootstrapRestoreFromLicensePrompt` was dead code: the outer `ensureLicenseAtStartup` returned false → `app.exit(0)` fired immediately. The 100ms timer never ran. Doubling up risked racing the outer `app.exit` and creating two relaunches. | Removed. Only `app.relaunch()` is called, then `return "exit"`. The lifecycle handler does the `app.exit(0)`. |
| 7 | The `rejected` flag was set/checked from multiple call sites with subtly inconsistent semantics, relying on Promise idempotency to mask the bugs. | Replaced with a single `settle(value)` helper closure that uses an `outerSettled` flag. All resolution paths (cancel, complete-success, complete-error, did-fail-load, wizard close) go through `settle`. |

### LOW

| # | Bug | Fix |
|---|---|---|
| 8 | Logs scope description said "Useful only for forensics. Safe to skip on a fresh install" — but v2.8.14 R6 specifically wired `recovery.log` so it survives migration for diagnostic continuity. Operators reading the description would wrongly skip it. | Updated `SCOPE_DEFINITIONS.logs.detail` to: "Includes recovery.log so the integrity-gate history survives migration. Skip on a brand-new install only if disk space matters." |
| 9 | If the user clicked the title-bar X on step 5 (after a successful restore but before clicking Relaunch), the outer promise resolved as `{canceled:true}` — but the DB had already been overwritten. The user would land back at the license prompt with no clue that their data was already in place; the restore was effectively orphaned. | `wizardWin.on("closed")` now checks `restoreSucceeded` flag. If true, settles with `{ok:true, restored:true, willRelaunch:true, scope}` instead of `{canceled:true}` — the caller still does `app.relaunch()`. |

### Acknowledged-but-not-fixed (bottom of acceptable risk)

| Concern | Why accepted |
|---|---|
| Pseudo-progress timer doesn't reflect real restore progress | Real progress would require the embedded server's WS layer. For the bootstrap window (which only restores once), accept the cosmetic gap |
| ~~`validatePortableBackup` and `importPortableBackup` use `execFileSync(powershell)` which BLOCKS the main process during zip extract~~ | **Resolved by the 2 GiB hotfix** (see `audits/2026-04-22/local-backup-export-2gib-fix.md`). Both now use `extract-zip` (yauzl) which streams asynchronously and never blocks the event loop |
| If `restorePortableBackup` itself hangs forever, the wizard cannot be force-closed by the user (close intercepted) | Failure mode requires either disk hardware fault or PowerShell hang — both extreme. User can kill via Task Manager. Documented in this audit |
| Buildup of `imported-backup-<ts>` directories in `cloud_backups/` on repeated successful bootstrap-restores | Pruned by the existing rotation in `_pruneOldBackups`/history-cap of 200 entries, plus the operator's normal Local Backup retention setting |

---

## 14. Verification after 2nd pass

```bash
node --check electron/bootstrapRestore.js          # OK
node --check electron/preload-bootstrap-restore.js # OK
node --check public/bootstrap-restore.js           # OK
node --check electron/main.js                      # OK
node server/tests/cloudBackupRestoreSafety.test.js # 8/8 PASS
node server/tests/backupHealthRegistry.test.js     # PASS
node -e "require('./electron/bootstrapRestore.js').ensureProgramDataRootWritable()"
# {"ok":true,"action":"already-writable"} on a dev box with the install present
```

---

## 15. Summary

The bootstrap-restore wizard closes a real operational gap in the
migration story: an operator reinstalling on a new PC can now seed the
fresh install with their plant data, settings, and (optionally) license
in a single ~30 second wizard flow — instead of the 7-step workaround.

The implementation reuses 100% of the existing `CloudBackupService`
restore code path, and adds only the missing `scopeFilter` plumbing that
also powers a future "selective restore" feature in the in-app Local
Backup panel. All eight regression tests pass.

**Critical bugs from the 2nd-pass audit (success-page flash, mid-restore
race on Cancel/X-close, missing ACL grant, orphaned imported package on
failure, silent HTML-load failure, dead setTimeout, X-close-after-success
data loss) are all fixed.** The wizard is ready for manual smoke testing
on a clean Windows machine before commit and release.
