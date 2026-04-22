# Local Backup Logic Audit

Date: 2026-04-22
Status: Findings only — no remediation applied
Scope: All local backup, archive, restore, and recovery logic in ADSI-Dashboard v2.8.13
Auditors: Explore + Code-Reviewer + Security-Reviewer (orchestrated, independent passes)

---

## Executive Summary

The dashboard implements a **four-tier local backup chain** plus an installer-stash recovery path. Tier 1 (rotating SQLite slots) is **production-grade for accidental power-loss**. The full chain is **vulnerable to intentional tampering** by any local user on the gateway PC because (a) backup API endpoints have no session auth on localhost and (b) the backup directories are explicitly granted `Users:(OI)(CI)M` (full Modify) by the app at startup.

Total findings: **6 CRITICAL, 11 HIGH/MAJOR, 8 MEDIUM/MINOR, 2 LOW/INFO**.

The most material gaps are:

1. **Archive month DBs (`archive/YYYY-MM.db`) are NOT in the default cloud backup scope** — losing the archive folder loses 90+ days of historical telemetry permanently, even with a working cloud backup.
2. **Stashed installer (`last-good-installer.exe`) has no signature/hash verification before silent execution** — attacker who can write to ProgramData can trigger SYSTEM-level code execution on next recovery click.
3. **All `/api/backup/*` endpoints (including restore) skip auth on localhost** — and the dashboard runs on localhost.
4. **`runPeriodicBackup` silent failures**: console.error only, no audit_log row, no UI banner. A backup that fails for days is invisible.

---

## 1. Inventory of Backup Mechanisms

### Tier 1 — Rotating SQLite Backup Slots (Emergency)
| Aspect | Value |
|---|---|
| Source | Entire `adsi.db` via `better-sqlite3 .backup()` (online API, consistent snapshot) |
| Destination | `%PROGRAMDATA%\InverterDashboard\backups\adsi_backup_{0,1}.db` |
| Trigger | `setTimeout(60s).unref()` + `setInterval(2h).unref()` — `d:\ADSI-Dashboard\server\index.js:17648-17662` |
| Retention | 2 slots (oldest overwritten every 2h) |
| Verify | Header check + `PRAGMA quick_check(1)` at startup — `d:\ADSI-Dashboard\server\db.js:377-424` |
| Restore | `_autoRestoreMainDbFromBackupSync` newest-first iteration + corrupt quarantine — `d:\ADSI-Dashboard\server\db.js:426-505` |
| Failure mode | `console.error("[DB] Backup failed:", err.message)` — silent |

### Tier 2 — Nightly Archive + Prune (Scheduled)
| Aspect | Value |
|---|---|
| Source | `readings`, `energy_5min`, `solcast_snapshot_history` rows past `retainDays` (default 90) |
| Destination | `%PROGRAMDATA%\InverterDashboard\archive\YYYY-MM.db` (one SQLite per month) |
| Trigger | `cron.schedule("30 3 * * *", pruneOldData)` + `cron.schedule("35 3 * * *", () => pruneSnapshotHistory(90))` — `d:\ADSI-Dashboard\server\index.js:16777, 16783-16785` |
| Retention | Archive DBs kept indefinitely; no cleanup |
| Verify | Row counts returned; **no checksum** |
| Restore | None automatic; analytics queries can read archive DBs read-only |
| Failure mode | Caught + console-logged + UI-invisible — `d:\ADSI-Dashboard\server\db.js:3010` |

### Tier 3 — Cloud Backup Service (User-Initiated / Scheduled)
| Aspect | Value |
|---|---|
| Source (default scope) | `adsi.db` + `ipconfig.json` + `settings.json` |
| Source (portable only) | adds archive DBs, recovery.log, forecast artifacts |
| Destination (local) | `%PROGRAMDATA%\InverterDashboard\cloud_backups\inverter-backup-<ts>-<uuid>\` |
| Destination (cloud) | OneDrive, Google Drive, S3 (chunked-v1 dedup) |
| Trigger | Manual button OR `0 3 * * *` (daily) OR `0 */6 * * *` (every6h) — `d:\ADSI-Dashboard\server\cloudBackup.js:1414-1440` |
| Retention | Local: 20 packages (FIFO prune). Cloud: unbounded. |
| Verify | SHA-256 per file in `manifest.json` (manifest itself unsigned) |
| Restore | `restoreBackup(packageId)` closes poller, `fs.copyFileSync` over live DB; pre-restore safety backup taken |
| Failure mode | Retry queue with exponential backoff; **no UI alert on persistent failure** |

### Tier 4 — Installer Stash (Offline Recovery)
| Aspect | Value |
|---|---|
| Source | The signed installer EXE itself (`$EXEPATH` at install time) |
| Destination | `%PROGRAMDATA%\InverterDashboard\updates\last-good-installer.exe` |
| Trigger | NSIS `customInstall` (`d:\ADSI-Dashboard\scripts\installer.nsh:15-30`) + `stashLastGoodInstaller()` after every signed auto-update (`d:\ADSI-Dashboard\electron\main.js:958-987`) |
| Retention | Survives uninstall (`customUnInstall` is no-op) |
| Verify | **None** — no SHA sidecar, no signature re-check before silent exec |
| Restore (consume) | `electron/recoveryDialog.js:141-165` spawns `<stashed.exe> /S` |

### Implicit — `app.asar.sha512` Sidecar
| Aspect | Value |
|---|---|
| Purpose | Detect torn `app.asar` writes from power loss |
| Written | `d:\ADSI-Dashboard\scripts\afterPack.js` during electron-builder afterPack |
| Verified | `d:\ADSI-Dashboard\electron\integrityGate.js` using `original-fs` (not stock fs — required because Electron's fs shim returns size:0 for asar; v2.8.11 hotfix) |
| On failure | Recovery dialog (`recoveryDialog.js`) |

---

## 2. Data Coverage Matrix — What IS and IS NOT Backed Up

### Covered by Tier 1 (entire adsi.db every 2h)
- `readings`, `energy_5min`, `alarms`, `audit_log`
- `forecast_run_audit`, `forecast_error_compare_daily`, `forecast_error_compare_slot`
- `solcast_snapshots`, `solcast_snapshot_history`, `solcast_dayahead_locked`
- `settings`, `scheduled_maintenance`, every other table inside adsi.db
- → **All schema-resident data is backed up at the database level.**

### NOT Covered by Tier 1 (filesystem files outside adsi.db)
| Item | Path | Backed up by | Risk |
|---|---|---|---|
| `ipconfig.json` | `%PROGRAMDATA%\InverterDashboard\` | Tier 3 only (if config scope) | App crashes before any Tier 3 → IPs lost |
| `settings.json` (export) | `%PROGRAMDATA%\InverterDashboard\` | Tier 3 only (if config scope) | Same |
| Archive month DBs | `%PROGRAMDATA%\InverterDashboard\archive\*.db` | **Portable backup only** — NOT default Tier 3 | 90+ days of history single-point-of-failure |
| `recovery.log` | `%PROGRAMDATA%\InverterDashboard\logs\` | **Portable backup only** | Diagnostic trail lost when most needed |
| Application logs | `%PROGRAMDATA%\InverterDashboard\logs\*.log` | None (logs scope referenced but not implemented) | No audit trail |
| Forecast Solcast cache | `%PROGRAMDATA%\InverterDashboard\forecast\` | Yes if database scope (verified at cloudBackup.js:566-574) | OK |
| `last-good-installer.exe` | `%PROGRAMDATA%\InverterDashboard\updates\` | None | Recovery loop broken if deleted |
| User CSV/PDF exports | Browser Downloads | None (out of app's control) | N/A |

---

## 3. Correctness Findings (Code-Reviewer Pass)

### CRITICAL

**C-1. WAL/SHM not cleaned in cloudBackup restore** — `d:\ADSI-Dashboard\server\cloudBackup.js:1156-1172`
The startup auto-restore correctly removes `-wal` and `-shm` before the copy (`d:\ADSI-Dashboard\server\db.js:462-463`), but the cloud restore does NOT. After `fs.copyFileSync(srcDb, destDb)`, stale WAL/SHM from the previous DB can be replayed against the freshly restored file → silent corruption.

**C-2. `archiveTelemetryBeforeCutoff` is not transactional across archive→delete** — `d:\ADSI-Dashboard\server\db.js:2928-2952`
`archiveRowsByMonth` (insert into archive DB) and `deleteReadingsBatchTx` (delete from main) run in independent transactions, in different DB files (cross-DB transactions are not supported by SQLite anyway). If the delete fails after the archive insert succeeds, the row exists in BOTH databases. Next prune cycle will re-archive it (duplicate).

**C-3. Poller shutdown is fire-and-forget before fs.copyFileSync** — `d:\ADSI-Dashboard\server\cloudBackup.js:1148-1158`
`this.poller?.stop()` is called without `await` and without confirming the poller has actually released its handle. If a write is in flight, the copy may overwrite a file that's still being touched. The `finally` block at 1174-1188 also restarts the poller silently if `start()` throws.

### MAJOR

- **M-1.** `recovery.log` (`%PROGRAMDATA%\InverterDashboard\logs\recovery.log`) is NOT in default Tier 3 scope — only included in portable backups.
- **M-2.** Default Tier 3 scope `["database", "config"]` does NOT include archive DBs (`d:\ADSI-Dashboard\server\cloudBackup.js:201`). Portable backup is the only path that captures them.
- **M-3.** `runPeriodicBackup` swallows errors with `console.error` only — no `audit_log` row, no UI banner, no email/notification (`d:\ADSI-Dashboard\server\index.js:17658`).
- **M-4.** `restoreBackup` finally-block silently swallows poller restart failures (`d:\ADSI-Dashboard\server\cloudBackup.js:1185-1186` ≈ `catch { /* ignore */ }`). UI shows "restored OK" while backend is dead.
- **M-5.** Pre-restore safety backup is never explicitly deleted on success. Only cleaned by FIFO-20 prune (`d:\ADSI-Dashboard\server\cloudBackup.js:1134, 696-711`). Heavy restore use → multi-GB local accumulation.
- **M-6.** Cron collisions: 03:00 cloud backup + 03:30 prune + deferred VACUUM + 03:35 snapshot prune. If the 03:00 backup runs long, 03:30 prune blocks on the SQLite write lock and may push into the 04:30 forecast cron (`d:\ADSI-Dashboard\server\cloudBackup.js:1422`, `d:\ADSI-Dashboard\server\index.js:16777`).

### MINOR

- **N-1.** No max-attempts guard on backup-slot iteration (low risk; list size is hard-capped at 2 anyway).
- **N-2.** `.unref()` on the 2h interval and 60s timeout (`d:\ADSI-Dashboard\server\index.js:17661-17662`) means the backup loop dies if Node has nothing else keeping the loop alive. Accept-as-designed but worth documenting.
- **N-3.** `createLocalBackup` doesn't pre-check disk space; can leave partial packages (`d:\ADSI-Dashboard\server\cloudBackup.js:518-543`).
- **N-4.** VACUUM is `setImmediate`'d with no time bound; if it runs long, the next 2h Tier 1 backup blocks.
- **N-5.** `recovery.log` grows unbounded (`d:\ADSI-Dashboard\electron\recoveryDialog.js:55-63` — `fs.appendFileSync`, no rotation).

---

## 4. Security Findings (Security-Reviewer Pass)

### CRITICAL

**S-1. All `/api/backup/*` endpoints are unauthenticated on localhost** — `d:\ADSI-Dashboard\server\index.js:17191-17480`
The only gate is `remoteApiTokenGate` which exempts loopback (`d:\ADSI-Dashboard\server\index.js:6904-6911`). The dashboard always runs on localhost. Any local user can `POST /api/backup/restore/<id>` to overwrite the live DB — including with a poisoned package they wrote into `cloud_backups\` themselves.

**S-2. Stashed installer is silently exec'd with no signature or hash check** — `d:\ADSI-Dashboard\electron\recoveryDialog.js:141-165`
`spawn(installerPath, ["/S"], { detached: true })`. No SHA sidecar, no Authenticode thumbprint verify (the auto-update path DOES verify thumbprint at `electron/main.js:781-829` — the stash path bypasses it). Local user with write access to `%PROGRAMDATA%\InverterDashboard\updates\` can replace the EXE; next operator click runs it as the operator.

**S-3. ProgramData backup directories are world-writable by app design** — `d:\ADSI-Dashboard\server\db.js:81`
Startup runs `icacls DATA_DIR /grant Users:(OI)(CI)M /T`. Required for SQLite WAL writeability under multi-user Windows, but applied to the entire data tree — including `backups\`, `updates\`, `cloud_backups\`. Combined with S-1 and S-2 this is the substrate that makes both attacks trivial.

### HIGH

- **S-4. `manifest.json` is not signed** — only file-level SHA-256s. Tampering with the cloud copy is undetectable because the attacker can re-hash the file and update the manifest entry. The verify loop even explicitly skips `manifest.json` (`d:\ADSI-Dashboard\server\cloudBackup.js:1378-1392`).
- **S-5. No audit_log entries for any backup/restore** — restore is the most destructive operation in the app and produces zero audit trail. Compare to control actions which are logged via `logControlAction()`.
- **S-6. TOCTOU on restore** — `d:\ADSI-Dashboard\server\cloudBackup.js:1109-1159`: hash-verify happens at line 1124, copy happens at 1158. A concurrent process can swap the file between the two.
- **S-7. TOCTOU on stashed installer** — `d:\ADSI-Dashboard\electron\recoveryDialog.js:86-145`: `existsSync` then `spawn`. Same race window.
- **S-8. Pre-restore safety backup is also poisoned if the source was poisoned** — design limitation rather than a code bug. Rolling back via the safety backup gives you the same compromised DB.

### MEDIUM

- **S-9.** `adsi.db` includes `audit_log` and operational history; cloud breach exposes it. No encryption-at-rest option. (`settings` correctly redacts `remoteApiToken`/`solcastApiKey`/`cloudBackupSettings` per `d:\ADSI-Dashboard\server\cloudBackup.js:682-694`.)
- **S-10.** No disk-space pre-check before restore; partial copy + restart leaves DB corrupt (recovers via Tier 1).
- **S-11.** `_verifyChecksums` skips `manifest.json` self-hash (line 1381) — combined with S-4 this means manifest tamper is doubly undetected.
- **S-12.** No rate limit on `POST /api/backup/restore/:id` — DoS via repeated restore loops (compounds S-1).
- **S-13.** Quarantine files (`adsi.db.corrupt-<ts>`, `adsi.db.unrescuable-<ts>`) never cleaned; an attacker who can repeatedly induce corruption can fill the disk.

### LOW / INFO

- **S-14.** Portable backup endpoints (`/api/backup/create-portable`, `/api/backup/import-portable`) inherit the same no-auth situation as S-1.
- **S-15.** S3 chunked-v1 dedup layout has no documented migration path if the layout version bumps.

---

## 5. Single Points of Failure

| SPOF | Trigger | Impact | Mitigation present? |
|---|---|---|---|
| Archive folder deleted/corrupted | User cleanup, disk error | 90+ days of telemetry permanently gone | **No** — not in default cloud scope |
| Tier 3 cron silently fails for weeks | Network/auth issue | Operator believes backup is healthy | **No UI surface for last-success timestamp** |
| Both Tier 1 slots torn by 3 successive power events | Pathological power | ~2h reading loss + boot from fresh DB | Tier 1 fallback works |
| Stashed installer missing AND no internet | Uninstall + offline | Cannot recover at all | **No** — no offline-USB option documented |
| Poller writing while restore copies | Tier 3 restore mid-poll | DB corruption | Partial — `poller.stop()` not awaited |

---

## 6. Silent Failure Inventory

1. `runPeriodicBackup` errors → console only.
2. Both Tier 1 slots overwritten with torn data → not detected until the next time auto-restore runs.
3. `pruneOldData` archive succeeds, delete fails → row in both DBs, no alert.
4. Tier 3 scheduled cron fails → no UI banner, no audit_log.
5. Cloud manifest checksum never re-verified after pull (relies on transport integrity).
6. Archive month DBs accumulate forever → eventual disk-full → cascading silent failures of every other backup mechanism.

---

## 7. Prioritized Remediation List

### Immediate (next hotfix candidate, v2.8.14)
1. **S-3 → S-1 → S-2 chain**: tighten ACLs on `backups\`, `updates\`, `cloud_backups\` to `SYSTEM:(F) Administrators:(F) <appuser>:(M) Users:(RX)`; gate `/api/backup/*` with the existing session login (NOT remoteApiToken); add SHA-256 sidecar + Authenticode thumbprint check before exec'ing the stashed installer.
2. **C-1**: in `restoreBackup`, delete `<destDb>-wal` and `<destDb>-shm` before `fs.copyFileSync` (mirror what `db.js:462-463` already does for auto-restore).
3. **M-3**: emit `audit_log` row + WS event on every `runPeriodicBackup` failure; surface in the admin UI.

### Short-term (v2.8.x)
4. **M-2**: add archive DBs to the default Tier 3 scope (or at least surface a "missing archive in last cloud backup" warning).
5. **M-1**: same for `recovery.log`.
6. **C-3**: await `poller.stop()` and verify before any `fs.copyFileSync` on the live DB.
7. **S-4 + S-11**: HMAC the manifest with a key derived from install ID; verify HMAC on restore.
8. **S-5**: log every restore + pull to `audit_log` with backup id, source, checksum result.
9. **S-6 + S-7**: re-hash post-copy; refuse if mismatch.

### Medium-term (v2.9.x)
10. **C-2**: rework `archiveTelemetryBeforeCutoff` to mark archived rows in main DB before delete (idempotency token), so a partial failure can be reconciled.
11. **M-6**: shift cron schedule so 03:00 backup and 03:30 prune cannot overlap; or have prune wait on the backup mutex.
12. **S-9**: optional AES-256-GCM at-rest encryption with passphrase.
13. **S-13**: quarantine cleanup policy (keep newest N, delete past 30d).
14. **N-5**: rotate `recovery.log` (size or count cap).

---

## 8. Verification Spot-Checks Performed

The orchestrating agent verified the following before publishing this report:
- `d:\ADSI-Dashboard\server\cloudBackup.js` exists (67 KB, mtime Apr 15)
- `d:\ADSI-Dashboard\scripts\afterPack.js` exists (1857 B, mtime Apr 17)
- `d:\ADSI-Dashboard\scripts\installer.nsh` exists (1560 B, mtime Apr 17)
- `d:\ADSI-Dashboard\electron\integrityGate.js` exists (8072 B, mtime Apr 18)
- `d:\ADSI-Dashboard\electron\recoveryDialog.js` exists (6041 B, mtime Apr 17)
- `runPeriodicBackup` location and `.unref()` behavior at `d:\ADSI-Dashboard\server\index.js:17648-17662` (grep)
- `pruneOldData` and `archiveTelemetryBeforeCutoff` at `d:\ADSI-Dashboard\server\db.js:2928-3023` (grep)
- Cron registrations at `d:\ADSI-Dashboard\server\index.js:16777, 16783-16785` (grep)

Findings tagged with file:line above were grounded against the codebase. Severity assignments are the auditor agents' own; the project owner should confirm severities against operational threat model (e.g., is the gateway PC truly multi-user, or is "operator on console" the sole local user?).

---

## 9. Open Questions for Project Owner

1. Is the gateway PC effectively single-user (one operator at console), or are non-admin Windows accounts created on it? — answers severity of S-1/S-2/S-3.
2. Are cloud backups currently ENABLED in production, or is local-only the operating posture? — determines whether S-4/S-5/S-9 are theoretical or live risks.
3. What is the acceptable RPO (recovery point objective)? Tier 1 is 2 hours; if RPO is <2 hours, the cron interval needs to drop and silent-failure detection becomes critical.
4. Is offline-installer-on-USB an acceptable Tier 5 safety net for the "stashed installer + no internet" SPOF?
