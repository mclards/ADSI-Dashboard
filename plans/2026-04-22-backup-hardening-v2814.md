# Plan: Backup Chain Hardening (v2.8.14 + v2.8.15)

Date: 2026-04-22
Status: APPROVED 2026-04-22 — implementing as single v2.8.14 release
Source audit: `d:\ADSI-Dashboard\audits\2026-04-22\local-backup-audit.md`
Architect agent: invoked 2026-04-22, full design captured below

---

## Locked decisions (user approval 2026-04-22)

| Decision | Locked value |
|---|---|
| Release strategy | Single v2.8.14 — ship R1+R2+R3+R4+R5+R6+R7 together (NOT split into v2.8.14+v2.8.15) |
| Schedule default | `off`, but UI exposes the dropdown (off / daily 02:30 / weekly Sunday 02:30) |
| Health UI updates | NO 60s polling. Page-load fetch + WS push on backup completion + manual refresh button. (User correctly noted polling is overkill for local-only with 2h+ cadence.) |
| Scheduled .adsibak destination default | `%PROGRAMDATA%\InverterDashboard\portable_backups`; UI Browse button for override |
| Manual .adsibak destination | User-picked at export time (preserves current `Export .adsibak` flow) |
| Restore preview modal | Always require explicit confirm; no "don't ask again" |
| Additional v2.8.14 scope | None — stick to R1-R7 |

---

## Goal

Harden the local backup chain so the user's primary recovery scenario (OS reinstall / machine migration via `.adsibak`) is reliable and observable. Defer all security-level remediations (auth, ACLs, HMAC) to a separate later release — single-user gateway and cloud-optional posture make them lower priority.

## Phasing decision (architect's recommendation)

**Split into two releases.** Safety first, UX second.

### v2.8.14 — Safety Foundation (~450 LOC)
- **R2** — `BackupHealthRegistry` + audit_log emission for every Tier 1 attempt
- **R4** — `/api/backup/health` endpoint + admin UI badges ("Last success: …", red badge after 3 consecutive failures)
- **R5** — Auto-rollback on partial restore failure (wraps `_restoreBackupLocked` with pre-restore safety backup + try/catch + auto-restore on throw)
- **C-1 fix** — Delete `<destDb>-wal` and `<destDb>-shm` BEFORE `fs.copyFileSync` in `_restoreBackupLocked` (mirrors the correct behavior already at `d:\ADSI-Dashboard\server\db.js:462-463` for startup auto-restore)

### v2.8.15 — User Control + UX Polish (~610 LOC)
- **R1** — Scheduled `.adsibak` auto-export (off / daily 02:00 / weekly Sunday 02:00) with configurable destination (USB, network share, etc.) + retention (keep last N)
- **R3** — Pre-restore preview modal (shows captured timestamp, app version, file count, row counts per table, scope summary, before/after warning)
- **R6** — Add `recovery.log` to `.adsibak` file enumeration
- **R7** — Document `ipconfig.json` machine-specific path caveat in user guide

---

## Architecture summary

```
┌─────────────────────────────────────────────────────────────┐
│              BackupMutex (reuse existing _withBackupMutex)  │
│        (serializes Tier 1, Tier 3, .adsibak, restore)       │
└─────────────────────────────────────────────────────────────┘
   │           │           │            │           │
   ▼           ▼           ▼            ▼           ▼
runPeriodic  cloud      scheduled   portable    restore
Backup       backup     .adsibak    Import      (auto-rollback)
(Tier 1)     (Tier 3)   (NEW R1)    Export

   │           │           │            │           │
   └───────────┴───────────┴────────────┴───────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────────────────┐
   │     BackupHealthRegistry (NEW — server module)      │
   │  • lastAttempt / lastSuccess / nextScheduled        │
   │  • consecutiveFailures counter                      │
   │  • Persists to backupHealth.json + audit_log        │
   │  • Reconstructable from audit_log on JSON corrupt   │
   └─────────────────────────────────────────────────────┘
                          │
                          ▼
              GET /api/backup/health
                          │
                          ▼
       Admin Panel "Local Backup" section
       (badges + schedule config + preview modal)
```

## Key design decisions

| Decision | Choice | Why |
|---|---|---|
| Health persistence | JSON file + audit_log (both) | JSON is human-readable for debugging; audit_log is the durable trail; reconstructable if JSON corrupt |
| New table | None — reuse `audit_log` with new `action` values | Avoids migration; `audit_log` already accepts JSON `value` |
| Mutex | Reuse existing `_withBackupMutex` from cloudBackup.js | Already serializes; no new concurrency primitive needed |
| Auto-rollback scope | Wraps the whole restore body; rolls back on any throw after safety backup is taken | Catches both DB-copy and post-copy failures |
| Catastrophic case (rollback also fails) | Hard-stop with red UI message + audit_log `RESTORE_FAILURE_ROLLBACK_FAILED` | Operator must manually investigate; no silent loss |
| `.adsibak` schedule default | `off` | Conservative; user opts in |
| `.adsibak` destination default | `%PROGRAMDATA%\InverterDashboard\portable_backups` | Same disk = better than nothing; user can change to USB |
| Backwards compat | v2.8.13 `.adsibak` files import; manifest `rowCounts` is optional | Graceful degradation |
| Cron collision risk | Tier 3 (02:00) + scheduled .adsibak (also 02:00 default) → choose 02:30 for .adsibak | Avoid mutex contention with cloud upload |

## File-by-file change list

### v2.8.14
| File | Change | LOC | Risk |
|---|---|---|---|
| `server/backupHealthRegistry.js` | NEW class | +350 | Low — additive |
| `server/index.js` | Modify `runPeriodicBackup` (lines 17648-17662); add `/api/backup/health` route; init registry at startup | +60 | Low — additive |
| `server/cloudBackup.js` | Wrap `_restoreBackupLocked` with auto-rollback; fix C-1 (WAL/SHM cleanup); record attempts to registry | +200 | Medium — touches restore hot path |
| `public/index.html` | Add health badge section to Local Backup panel | +30 | Low |
| `public/js/app.js` | Poll `/api/backup/health` every 60s; render badges | +80 | Low |
| `public/css/style.css` | Style for status badges (ok/alert) | +20 | Low |
| `server/tests/cloudBackupAutoRollback.test.js` | NEW test file | +200 | None |

**v2.8.14 total: ~940 LOC delta** (architect's earlier 450 estimate was code-only; tests + UI bring it up).

### v2.8.15
| File | Change | LOC |
|---|---|---|
| `server/cloudBackup.js` | `scheduleLocalBackup`, `runScheduledPortableBackup`, `prunePortableBackups`, `getFreeDiskSpace`, manifest row counts, recovery.log inclusion | +250 |
| `server/index.js` | Initialize scheduler at startup; new `POST /api/backup/validate-portable` route | +40 |
| `public/index.html` | Schedule config form + preview modal HTML | +130 |
| `public/js/app.js` | Schedule UI handlers + preview modal logic | +250 |
| `public/css/style.css` | Modal styling | +60 |
| `docs/user-guide.md` | R7 documentation | +30 |

**v2.8.15 total: ~760 LOC delta**

## New settings keys (v2.8.15)

```js
{
  "localBackupSchedule": "off",                  // off | daily | weekly
  "localBackupDestination": "<programdata>/portable_backups",
  "localBackupRetention": 5,                     // 0 = unlimited
  "localBackupLastAttemptAt": null,
  "localBackupLastSuccessAt": null,
  "localBackupNextScheduledAt": null
}
```

## New audit_log action codes

| action | when | value (JSON) |
|---|---|---|
| `BACKUP_TIER1_SUCCESS` | every 2h slot succeeds | `{ dest, size_bytes, duration_ms }` |
| `BACKUP_TIER1_FAIL` | every 2h slot fails | `{ error, consecutive_failures }` |
| `BACKUP_PORTABLE_SUCCESS` | scheduled .adsibak succeeds | `{ destination, filename, size_bytes }` |
| `BACKUP_PORTABLE_FAIL` | scheduled .adsibak fails | `{ error, consecutive_failures, destination }` |
| `RESTORE_SUCCESS` | restore completes cleanly | `{ backup_id, scope, app_version }` |
| `RESTORE_FAILURE_ROLLED_BACK` | restore failed but rollback worked | `{ backup_id, error, rolled_back_to }` |
| `RESTORE_FAILURE_ROLLBACK_FAILED` | catastrophic | `{ backup_id, restore_error, rollback_error }` |
| `RESTORE_FAILURE_NO_ROLLBACK` | restore failed before safety backup | `{ backup_id, error }` |

## API contracts

### GET /api/backup/health
Returns unified view of Tier 1, Tier 3, and scheduled .adsibak status — last success, next scheduled, consecutive failures, free disk at destination.

### POST /api/backup/validate-portable (v2.8.15)
Already exists internally; new HTTP wrapper that returns manifest + row counts + scope for the preview modal.

### POST /api/backup/restore/:id
Same endpoint, new response shapes:
- Success → `{ ok: true, manifest }`
- Restore failed, rollback succeeded → `{ ok: false, error, rolledBack: true }`
- Catastrophic → `{ ok: false, error, rolledBack: false, requiresManualIntervention: true }`

## Test plan (architect's enumeration)

### Unit (`server/tests/backupHealthRegistry.test.js`)
- Constructor initializes JSON + DB
- `recordAttempt` increments/zeros consecutive counter correctly
- `getHealth` returns correct shape
- Persistence survives module reload
- Migration: corrupt JSON reconstructs from audit_log

### Integration (`server/tests/cloudBackupAutoRollback.test.js`)
- `runPeriodicBackup` records success in registry
- `runPeriodicBackup` records failure with error
- Restore with simulated failure → rollback succeeds
- Restore + rollback both fail → proper catastrophic error
- Safety backup not created → restore aborts cleanly
- WAL/SHM cleanup before fs.copyFileSync (C-1 regression test)
- `/api/backup/health` returns expected shape

### Integration (v2.8.15)
- Scheduled .adsibak: destination unwritable → recorded
- Scheduled .adsibak: retention prune removes oldest
- Backward compat: v2.8.13 .adsibak imports with degraded preview
- Preview modal data: validatePortableBackup returns row counts

### Smoke
- Admin panel health badges update every 60s
- Schedule dropdown enables/disables cron
- Restore flow shows preview modal → confirm → restore

## Risks + tradeoffs

1. **Auto-rollback adds nested try/catch complexity in `_restoreBackupLocked`** — accepted; data integrity is paramount, complexity contained to one function.
2. **Scheduled .adsibak competes with Tier 3 for backup mutex** — accepted; default off, user enables explicitly, default schedules don't collide (Tier 3 02:00, .adsibak 02:30).
3. **Health JSON + audit_log redundant** — accepted; <1 KB JSON, audit_log already happening, dual store improves debuggability.
4. **Pre-restore safety backup kept indefinitely** — accepted; FIFO-20 prune still applies, audit value > disk cost.
5. **Row counts in manifest may drift between export and restore** — accepted; preview is informational only, restore is transactional.

## What this plan does NOT do

- No auth/session gate on `/api/backup/*` endpoints (S-1) — defer to security release
- No ACL tightening on `%PROGRAMDATA%\InverterDashboard\` (S-3) — defer
- No HMAC signature on cloud manifest (S-4) — defer; cloud is optional
- No code-signing verification on stashed installer before exec (S-2) — defer
- No archive DB inclusion in default Tier 3 cloud scope (M-2) — moot if cloud isn't primary
- No quarantine cleanup policy (S-13) — low operational impact
- No rate limiting on restore endpoint (S-12) — single-user, irrelevant

## Migration story

### v2.8.13 → v2.8.14 (this release)
- On first launch: `BackupHealthRegistry` initializes empty `backupHealth.json`
- Tier 1 cron continues; first run populates health state
- Existing `.adsibak` files import unchanged (no preview row counts; degraded gracefully)
- Existing restore behavior unchanged unless restore fails (then auto-rollback kicks in)
- Zero user action required

### v2.8.14 → v2.8.15 (next release)
- Schedule defaults to `off`; user opts in via UI
- Existing manifests without `rowCounts` show "Row count data not available for this backup version" in preview

## Commit structure (architect's recommendation)

### v2.8.14 PR
1. Add BackupHealthRegistry for Tier 1 visibility (new file + index.js wiring)
2. Add /api/backup/health endpoint + UI badges
3. Auto-rollback on restore failure + WAL cleanup fix
4. Audit logging for all backup attempts

### v2.8.15 PR
1. Scheduled .adsibak auto-export
2. UI for schedule config
3. Pre-restore preview modal
4. Add recovery.log to portable backup
5. Docs: machine-specific path guidance

---

## Open questions for user before implementation

1. **Approve the v2.8.14 / v2.8.15 split**, or want everything as one v2.8.14?
2. **Default scheduled .adsibak destination** — keep default `%PROGRAMDATA%\InverterDashboard\portable_backups` (same disk), or surface USB picker on first config?
3. **Default schedule** — keep `off` (opt-in), or default to `weekly` so a fresh install gets safety automatically?
4. **Health check polling cadence** — 60 seconds OK for the admin panel, or want WS push instead so failures show instantly?
5. **Pre-restore preview modal** — required confirm, or remember "don't ask again" per session?
6. Any additional gaps from the audit you want pulled into v2.8.14?
