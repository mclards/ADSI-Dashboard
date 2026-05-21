# Plan: Bootstrap-Restore Wizard at License Prompt

**Date:** 2026-04-22
**Status:** Implemented (pending manual smoke + commit)
**Target release:** v2.8.14 (rolled into the existing backup-hardening release)

---

## Decision context

Previous chat (see `audits/2026-04-22/local-backup-audit.md` and
`plans/2026-04-22-backup-hardening-v2814.md`) shipped:

- R1 scheduled `.adsibak` exports
- R3 row counts in manifest
- R4 backup health registry
- R5 auto-rollback on partial restore
- R6 recovery.log preservation
- C-1 WAL/SHM cleanup before restore
- Remote-mode gating on all 8 destructive backup endpoints
- ProgramData ACL pre-emptive grant

The operator then asked: *"why not also add backup restore prompt during
license prompt after fresh installation… it must have a checklist to what
should only be restored"* and granted full autonomy: *"you know the best
approach, its up to yuou already on implementing it all. Architect it well
and do comprehensive audits/documentations."*

This plan documents the resulting bootstrap-restore wizard.

---

## What ships

| New | Path |
|---|---|
| Main-process orchestrator + IPC handlers | `electron/bootstrapRestore.js` |
| Wizard preload (contextBridge) | `electron/preload-bootstrap-restore.js` |
| Wizard HTML + theming | `public/bootstrap-restore.html` |
| Wizard renderer logic | `public/bootstrap-restore.js` |
| Audit | `audits/2026-04-22/bootstrap-restore-audit.md` |
| This plan | `plans/2026-04-22-bootstrap-restore-wizard.md` |

| Modified | Path | Change |
|---|---|---|
| Native license dialog | `electron/main.js` | 4th button "Restore from Backup…" + helper `handleBootstrapRestoreFromLicensePrompt` |
| Restore engine | `server/cloudBackup.js` | `_scopeAllowed` + `opts.scopeFilter` plumbed through `_restoreBackupLocked`, `_assertRestoreDestinationsWritable`, `restorePortableBackup`, `_restorePortableBackupLocked` |
| Tests | `server/tests/cloudBackupRestoreSafety.test.js` | `testScopeFilterSelectiveRestore`, `testScopeFilterEmptyArrayBlocksAll` |

---

## Architectural decisions (locked)

1. **Embedded server is NOT started for the wizard.** We construct
   `CloudBackupService` directly in the main process with stub deps. This
   preserves the security model that nothing listens on `localhost:3500`
   until the user has authenticated.

2. **Wizard is a BrowserWindow, not a native dialog.** Native dialogs can't
   render checkboxes; we need 6 scope toggles. The wizard runs with the
   same locked-down `webPreferences` as the login window
   (`nodeIntegration:false`, `contextIsolation:true`, `webSecurity:true`).

3. **File picker stays in main.** `dialog.showOpenDialog` is invoked over
   IPC from the wizard renderer. Paths never enter the renderer context
   except as opaque strings sent back to main for validation.

4. **Restore triggers `app.relaunch()` + `app.exit(0)`.** The next process
   start re-runs the integrity gate, storage migration, and license loader
   against the freshly populated `%PROGRAMDATA%`. If the restored license
   matches this machine's hardware fingerprint, the prompt is skipped
   entirely on relaunch.

5. **Scope filter defaults are inclusive-but-safe:**

   | Scope | Default | Rationale |
   |---|---|---|
   | database | ✅ on | Whole point of migration |
   | config | ✅ on | Without this, install is blank |
   | logs | ☐ off | Forensic only |
   | archive | ✅ on | Long-term roll-ups, usually wanted |
   | license | ☐ off | Hardware-bound, usually invalid post-migration |
   | auth | ☐ off | OAuth tokens can't survive a machine change |

6. **`skipSafetyBackup: true` at bootstrap time.** Nothing to roll back
   to on a fresh install — the safety backup would just snapshot empty
   directories. Skipping avoids the pre-restore writability probe failing
   on a not-yet-initialized layout.

7. **Empty `scopeFilter: []` is the explicit "block all" sentinel.**
   Tested by `testScopeFilterEmptyArrayBlocksAll`. The wizard prevents
   reaching that state via the disabled "Restore" button + warning.

---

## API contracts

### IPC channels (registered only while wizard is open)

| Channel | Direction | Args | Returns |
|---|---|---|---|
| `bootstrap-restore:get-scopes` | invoke | — | `[{key,label,detail,defaultChecked,critical}]` |
| `bootstrap-restore:pick-file` | invoke | — | `{ok,path?,size?,canceled?,error?}` |
| `bootstrap-restore:validate` | invoke | `sourcePath:string` | `{ok,info?,error?}` |
| `bootstrap-restore:run` | invoke | `{sourcePath,scopeFilter}` | `{ok,restored?,scope?,error?}` |
| `bootstrap-restore:cancel` | invoke | — | `{ok}` |
| `bootstrap-restore:complete` | send | `{restored?,canceled?,error?,scope?}` | (one-way) |

### CloudBackupService extension

```js
restoreBackup(backupId, {
  skipSafetyBackup?: boolean,
  scopeFilter?: string[]    // v2.8.14 — whitelist intersected with manifest.scope
})

restorePortableBackup(backupId, {
  skipSafetyBackup?: boolean,
  scopeFilter?: string[]    // v2.8.14 — covers archive/license/auth too
})
```

`scopeFilter` semantics:
- `undefined` / `null` / non-array → "no filter, restore everything in manifest"
- `[]` → explicit "block all"
- `["database","config"]` → only intersect those two with the manifest scope

---

## Audit log codes added

| Code | Severity | When |
|---|---|---|
| `bootstrap_restore_opened` | info | User clicked "Restore from Backup…" |
| `bootstrap_restore_canceled` | info | User backed out without restoring |
| `bootstrap_restore_completed` | info | Restore succeeded; relaunching |
| `bootstrap_restore_failed` | error | Wizard or restore threw |

These flow through the existing `appendLicenseAudit` mechanism so they end
up in the same license-audit log alongside trial activations and license
uploads.

---

## Test plan

### Automated (passing)

```
node server/tests/cloudBackupRestoreSafety.test.js
  • C-1 WAL/SHM cleanup: PASS
  • R5 auto-rollback on restore failure: PASS
  • R6 recovery.log included in backup (from programDataDir): PASS
  • R3 manifest row counts: PASS
  • Restore destination paths round-trip correctly: PASS
  • Pre-restore writability probe aborts cleanly: PASS
  • Scope filter selective restore: PASS         ← new
  • Scope filter empty array blocks all scopes: PASS  ← new
cloudBackupRestoreSafety.test.js: PASS

node server/tests/backupHealthRegistry.test.js
backupHealthRegistry.test.js: PASS
```

### Manual smoke (see audit §10 for full checklist)

Critical paths:
- Browse → cancel → no error
- Browse → invalid file → error shown, can re-pick
- Validate → manifest summary + row counts
- Scope checklist → defaults match the table above
- Empty checklist → Restore disabled + warning
- Restore → progress → relaunch
- Post-relaunch: DB and settings intact at `%PROGRAMDATA%\InverterDashboard\db\adsi.db`
- License re-validation runs as expected (skipped if fingerprint matches, prompted if not)

---

## Risks accepted

1. **No safety backup at bootstrap time** — `skipSafetyBackup: true`. A
   mid-restore failure leaves a half-populated `%PROGRAMDATA%`. Re-running
   the wizard cleanly overwrites it.
2. **No automated UI test for the BrowserWindow + IPC plumbing** — covered
   by manual smoke. The underlying restore logic is unit-tested.
3. **License scope OFF by default** — operators who DO have a portable
   license must opt in. Trade-off: avoids the more common confusion of
   "license restored but still asks for upload" due to fingerprint mismatch.

---

## Out of scope (explicitly)

- Drag-and-drop file selection (security: paths never enter renderer)
- Auto-discovery of `.adsibak` files on USB drives
- Re-exposing the wizard from the in-app Settings panel (deferred to a
  follow-up if operator demand materialises)
- User Guide updates (HTML / MD / PDF) — operator triggers `feedback_guide_sync.md`
  rule, but this commit is engineering-only

---

## Phasing

Single commit, single release. The change is additive:

- `cloudBackup.js` `scopeFilter` is a no-op when callers don't pass it
- `ensureLicenseAtStartup` adds a 4th button without changing the other 3
- New files are net-additive

No migration steps. No DB schema change. No settings key additions.

---

## Verification before commit

```bash
node --check electron/bootstrapRestore.js
node --check electron/preload-bootstrap-restore.js
node --check public/bootstrap-restore.js
node --check electron/main.js
node server/tests/cloudBackupRestoreSafety.test.js
node server/tests/backupHealthRegistry.test.js
git check-ignore -v electron/bootstrapRestore.js public/bootstrap-restore.html public/bootstrap-restore.js electron/preload-bootstrap-restore.js audits/2026-04-22/bootstrap-restore-audit.md plans/2026-04-22-bootstrap-restore-wizard.md
```

All must pass / return "no match" (i.e., not gitignored) before commit.
