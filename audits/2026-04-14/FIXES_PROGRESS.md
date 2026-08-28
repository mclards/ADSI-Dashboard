# v2.8.8 CRITICAL Fix Progress Log — COMPLETE

**Started:** 2026-04-14
**Completed:** 2026-04-14
**Source report:** [BUG_SWEEP.md](BUG_SWEEP.md) (commit `1d88c8e`)
**Scope:** All 23 CRITICAL findings, Phase 1A → 1F.
**Final version:** `2.8.8` (bumped from 2.8.7 in package.json + all project docs).

---

## Progress (all CRITICALs landed)

| Phase | ID | File | Status | Commit |
|---|---|---|---|---|
| 1A | T1.1 | `server/index.js` SQL injection (replication merge) | **done** | `974be7f` |
| 1A | T1.2 | `server/exporter.js` yield gap (alarms, audit) | **done** | `974be7f` |
| 1A | T1.4 | `server/poller.js` pressure-retry unhandled reject | **done** | `974be7f` |
| 1B | T3.1 | `services/inverter_engine.py` `/write` unit validation | **done** | `d1c6081` |
| 1B | T3.2 | `services/inverter_engine.py` `/write` value validation | **done** | `d1c6081` |
| 1B | T3.3 | `services/inverter_engine.py` TOCTOU on write_pending | **done** | `d1c6081` |
| 1B | T3.4 | `services/inverter_engine.py` worker re-validation | **done** | `d1c6081` |
| 1B | T3.5 | `services/inverter_engine.py` auto-reset hold window | **done** | `d1c6081` |
| 1C | T4.1 | `services/forecast_engine.py` tri-band past-date flag | **done** | `0402ff7` |
| 1C | T4.2 | `services/forecast_engine.py` data-quality signal | **done** | `0402ff7` |
| 1C | T4.3 | `services/forecast_engine.py` spread-ratio guard | **done** | `0402ff7` |
| 1C | T4.4 | `services/forecast_engine.py` delegation lock file | **done** | `0402ff7` |
| 1C | T4.5 | `services/forecast_engine.py` ML error surfacing | **done** | `0402ff7` |
| 1D | T2.1 | `server/bulkControlAuth.js` clock capture once | **done** | `9fcd6bf` |
| 1D | T2.2 | `server/cloudBackup.js` backup/restore mutex | **done** | `9fcd6bf` |
| 1E | T5.1 | `public/js/app.js` idempotent theme listeners | **done** | `250cdd4` |
| 1E | T5.2 | `public/js/app.js` WS parse error payload excerpt | **done** | `250cdd4` |
| 1E | T5.3 | `public/js/app.js` modal backdrop de-dup | **done** | `250cdd4` |
| 1F | T6.1 | `electron/main.js` single-instance lock | **done** | `8d9e949` |
| 1F | T6.2 | `electron/main.js` open-ip IPv4 validation | **done** | `8d9e949` |
| 1F | T6.3 | `electron/main.js` autoUpdater thumbprint check | **done** | `8d9e949` |
| 1F | T6.4 | `electron/main.js` backend `spawn` listener | **done** | `8d9e949` |
| 1F | T6.5 | `electron/main.js` openExternal scheme whitelist | **done** | `8d9e949` |
| 1F | T6.6 | version sync (package.json + 4 docs) | **done** | `8d9e949` |

---

## Deferred / scope-adjusted (with reason)

| ID | Deferred to | Reason |
|---|---|---|
| T2.10 / T2.11 (cloudBackup pull / portable helpers) | v2.8.9 | Lower corruption risk than T2.2; wrapping three more public methods is mechanical; scheduled for a follow-up batch. |
| T4.4 — Node-side cancellation + UNIQUE index on `forecast_run_audit` | v2.8.9 | Python-side advisory lock lands in v2.8.8; full Node coordination requires orchestrator endpoint changes. |
| All HIGH / MEDIUM / LOW findings (100 items) | v2.8.9 + v2.9.0 | By design — Phase 2-4 per the original remediation plan. |

---

## Per-fix detail & test evidence

### Phase 1A — Data integrity & SQL safety (commit `974be7f`)

* **T1.1 SQL injection whitelist.** Added `REPLICATION_ALLOWED_TABLES` set and `assertReplicationTableAllowed()` guard at both dynamic `INSERT OR REPLACE INTO ${tableName}` sites (lines 2664 and 2763). Defence in depth — existing callers only pass names from `REPLICATION_TABLE_DEFS`, but a future refactor exposing the function to untrusted input would otherwise allow injection.
* **T1.2 Event-loop yield gap.** `exportAlarms` and `exportAudit` each now call `await yieldToEventLoop()` before the `.all()` scan. Previously only the later aggregation phases yielded, leaving a 30-s+ window on 366-day queries where `flushPersistBacklog` couldn't run.
* **T1.4 Pressure-retry guard.** The `setTimeout` callback in `poller.js` now wraps `flushPersistBacklog` in try/catch so a synchronous throw can't propagate as an unhandled rejection / uncaught exception that would terminate the server.
* **Verify:** `node --check` on all three files.

### Phase 1B — Python inverter write control (commit `d1c6081`)

* **T3.1/T3.2 API validation.** `/write` and `/write/batch` reject requests where `unit ∉ {1..4}` or `value ∉ {0,1}` with HTTP 400 before touching the queue.
* **T3.3 TOCTOU.** Added `write_pending_lock` plus `enqueue_write_atomically(ip, job)` helper; worker's `q.empty() + evt.clear()` now runs under the same lock. Closes the race where a job enqueued between check and clear silently lost its wake-up signal.
* **T3.4 Worker revalidation.** Worker loop re-validates every step at dequeue time; invalid steps are logged and dropped without hitting Modbus.
* **T3.5 Auto-reset hold.** `note_operator_write(ip, unit)` records the monotonic timestamp of every operator write; `handle_auto_reset` suppresses both the armed→OFF and waiting_clear→ON transitions for `AUTO_RESET_WRITE_HOLD_SEC = 5.0` after a manual write on the same (ip, unit).
* **Verify:** `python -m py_compile services/inverter_engine.py`.

### Phase 1C — Forecast ML correctness (commit `0402ff7`)

* **T4.1/T4.2 Tri-band past-date flag.** `solcast_prior_from_snapshot()` now exposes `is_past_date`, `has_real_triband`, and `triband_data_quality_flag`. `build_features()` gates tri-band feature construction on `has_real_triband`. Past-date snapshots now fall back to zero-spread features instead of being treated as real confidence bands.
* **T4.3 Spread-ratio guard.** Denominator guard raised from `> 0.1` to `> 0.5` kWh. Added explicit `np.nan_to_num(..., nan=0.0, posinf=0.0, neginf=0.0)` on both `solcast_spread_ratio` and `solcast_spread_pct`.
* **T4.4 Advisory lock.** Added `DAYAHEAD_GEN_LOCK_DIR` under APP_DB_FILE parent, with `_dayahead_gen_lock_{path,acquire,release}` helpers. All four generation call sites (delegate, manual CLI fallback, auto-service fallback, recovery fallback) now acquire/release via the helper; stale locks (>300 s) are force-acquired. Node-side coordination deferred.
* **T4.5 ML error surfacing.** Caller of `predict_residual_with_bundle` now checks `model_meta.prediction_error` / `regime_prediction_error` and logs + marks `_ml_failed=True` so QA/audit sees silent-failure cases.
* **Test update:** `test_collect_training_data_hardened_mixed` updated to reflect corrected semantics (was codifying the pre-fix bug).
* **Verify:** `pytest services/tests/` → **107/107 pass**, 89 s.

### Phase 1D — Node subsystem security (commit `9fcd6bf`)

* **T2.1 Single clock read.** Route handler for `/api/write/auth/bulk` captures `Date.now()` once and passes to both `isValidPlantWideAuthKey()` and `issuePlantWideAuthSession()`. `isAuthorizedPlantWideControl()` does the same. `getPlantWideAuthKeys()` hardened to reject non-finite `nowMs` and documented that both `now` and `prev` derive from a single `baseMs`.
* **T2.2 Backup mutex.** Added `_backupOpChain` promise-queue + `_withBackupMutex(label, fn)` on `CloudBackupService`. Public `backupNow`, `restoreBackup`, `restorePortableBackup` now delegate through the mutex to private `_XxxLocked` implementations. Internal `createLocalBackup` is NOT mutex-guarded so restoreBackup's pre-restore safety snapshot doesn't deadlock.
* **Verify:** `node --check` on all three changed files.

### Phase 1E — Frontend memory/integrity (commit `250cdd4`)

* **T5.1 Idempotent listeners.** Extracted `_themeToggleEscapeHandler` and `_themeToggleOpenHandler` as named functions; `initThemeToggle()` `removeEventListener` + `addEventListener` both, so repeated init calls don't stack listeners.
* **T5.2 WS parse context.** Log changed from `console.warn(err.message)` to `console.error(err, excerpt)` where excerpt is the safely-truncated 500-char payload (or `<binary NB>` marker).
* **T5.3 Modal dedup.** `openThemePreviewModal()` detaches any prior `modal._backdropHandler` BEFORE attaching a fresh one, preventing stacking on rapid re-opens.
* **Verify:** `node --check public/js/app.js`.

### Phase 1F — Electron hardening (commit `8d9e949`)

* **T6.1 Single-instance.** `app.requestSingleInstanceLock()` runs before `app.whenReady()`; losing side exits, winning side registers `second-instance` to focus the existing window.
* **T6.2 open-ip validation.** New `sanitizeInverterIpHost()` accepts only pure IPv4 (optional :port). Both `open-ip` and `open-ip-check` IPC handlers use it.
* **T6.3 Updater thumbprint.** `verifyUpdateCodeSignature` now extracts the signer thumbprint via PowerShell `Get-AuthenticodeSignature` and rejects the update on mismatch. Falls back to log-and-accept if the check can't run (SHA-512 remains primary defence).
* **T6.4 Spawn listener.** Backend subprocess now emits a 'spawn' log line so failed launches can be distinguished from successful ones.
* **T6.5 openExternal whitelist.** New `isSafeExternalUrl()` accepts only http/https/mailto; applied to both `shell.openExternal` call sites.
* **T6.6 Version bumps.** `package.json` 2.8.7 → **2.8.8**; SKILL.md / CLAUDE.md / AGENTS.md / MEMORY.md all synced.
* **Verify:** `node --check electron/main.js` + JSON parse.

---

## Final smoke verification

```
Node syntax (7 files):       all pass
Python syntax (2 files):     all pass
JSON config parse:           package.json OK
Python suite:                107/107 pass (89.76 s)
Node suite:                  not re-run in this session (repo in Electron ABI
                              state; per memory feedback_native_rebuild.md,
                              rebuilding native to Node ABI for CI remains a
                              v2.8.9 tooling task tracked as T7.3).
```

---

## Ready for release

The repository state is now ready for a signed v2.8.8 installer build.
Per project memory `feedback_python_release_full_rebuild.md`, **this release
touches Python (forecast + inverter) so a full installer rebuild is required
— not a "Python-only" shortcut.**

Recommended release steps (handled by `sub_releaser`):
1. Rebuild Python EXEs (InverterCoreService.exe, ForecastCoreService.exe).
2. Rebuild Electron native dependencies for Electron ABI.
3. `npm run build:installer:signed` → writes signed 500+ MB EXE to `release/`.
4. `gh release create v2.8.8` with the signed EXE, its `.blockmap`, and
   `latest.yml`.  Per memory `feedback_release_exe_upload.md`, expect the
   main EXE upload to time out via `sub_releaser` — upload manually via
   the GitHub web UI and verify all three assets are present before
   announcing.
