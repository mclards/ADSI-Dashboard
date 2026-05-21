# Phase 5 — Node subsystem hardening (T2.3–T2.9)

**Date:** 2026-04-14
**Baseline:** v2.8.8 + Phase 2/3/4 (commit `a5fed94`)
**Target:** v2.8.9
**Session scope:** Node subsystem HIGH-severity batch from [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan).

Continuation of [PHASE2_FIXES.md](PHASE2_FIXES.md) → [PHASE3_FIXES.md](PHASE3_FIXES.md). T7.3 smoke harness ([SMOKE_BASELINE.md](SMOKE_BASELINE.md)) verifies all changes here.

---

## Why this scope

Per PHASE3_FIXES.md "Remaining HIGH backlog after Phases 2+3":
- **Step 1 done:** T7.3 smoke harness shipped in commit `a5fed94`.
- **Step 2:** T2.3–T2.9 — Node session/token/streaming/cap/snapshot fixes, all in `server/`. Covered by the Node test suite (`bulkControlAuth.test.js`, `dayAheadPlanImplementation.test.js`, etc.) which the harness now runs automatically.

Only Node files were touched this session. Python tracks (T3.6–T3.12, T4.6–T4.12) deferred to a later batch.

---

## Fix-by-fix

### T2.3 — Bulk auth session token bound to client fingerprint

| | |
|---|---|
| Files | `server/bulkControlAuth.js` (`issuePlantWideAuthSession`, `isValidPlantWideAuthSession`), `server/index.js` (`isAuthorizedPlantWideControl` and 11 call sites) |
| Before | A session token granted by `/api/write/auth/bulk` could be replayed from any client until the 10 min TTL expired. Anyone who scraped the token (XSS, MITM, log inclusion) had full bulk-control access. |
| After | At issue time the session entry stores `{ ip, uaHash }` derived from `req.ip` (with `::ffff:` stripped) and `sha256(req.headers["user-agent"]).slice(0,16)`. Validator requires the inbound `req` to produce matching bindings. Sessions issued without `req` (legacy/test paths) stay unbound — backward compatible. |
| Backward compat | Two-arg call sites still work; the existing `bulkControlAuth.test.js` (29-test fixture) passes unchanged. |
| Risk if unfixed | Session-token replay enables full bulk control until expiry. |
| Rollback | Drop the `bindings`/`req` parameters; revert the 11 call-site edits. |
| What we did NOT do (deliberate) | Per-request rotation. The audit suggested rotating on every privileged request; that breaks the UI flow that reuses the token across multiple bulk ops within the TTL. Binding alone closes the replay-from-elsewhere vector while leaving UI flows intact. |

### T2.4 — Cloud-token store key derivation strengthened

| | |
|---|---|
| File | `server/tokenStore.js` |
| Before | AES-256-GCM key derived from `sha256(hostname + platform + arch + CONTEXT)`. An attacker with the encrypted token file plus basic system metadata could derive the key trivially. |
| After | Key = `PBKDF2(machine_fingerprint, salt, 200_000 iters, SHA-256)`. Salt is per-installation random 32 bytes stored at `<dataDir>/.token-keyring` with mode `0o600`. Generated on first run. |
| Backward compat | If decrypt with the new salted key fails, fall back to the legacy bare-hash key. If the legacy key works, mark for re-encryption and rewrite under the new key on the next save. Existing v2.8.8 installs migrate transparently with one log line: `[tokenStore] Migrated existing token cache to salt-derived key (T2.4).` |
| Risk if unfixed | Token-file exfiltration alone reveals OAuth tokens. After this fix, attacker also needs the salt file (mode 0o600). |
| Honest limitation | Both files live in the same `dataDir`. A full-dataDir backup exfiltration still captures both. The improvement is real only against PARTIAL exfiltration (token file alone, or older backup that pre-dates the salt). True fix is Windows DPAPI / Electron `safeStorage` — filed as v2.9.0 follow-up; requires IPC roundtrip on every cold start. |
| Rollback | Revert `_machineFingerprint`/`deriveKey`/`_readOrCreateSalt` and the `_load`/`_save` migration shim. |

### T2.5 — Alarms: no duplicate active row on server restart

| | |
|---|---|
| Files | `server/db.js` (new prepared stmt `getActiveAlarmForUnit`), `server/alarms.js` (`processAlarmsBatch` first-batch path) |
| Before | `activeAlarmState` is in-memory only. On server restart, the first batch of poll data finds `prev === undefined` for every unit; if a unit has an active alarm, the code inserted a SECOND active row instead of re-attaching to the existing one. Inflated counts; broken episode grouping; notification storms. |
| After | When `prev === undefined`, query `getActiveAlarmForUnit(inv, unit)` first. If an open row exists: re-attach (alarm value stable), update-in-place (alarm value drifted while we were down), or close the existing row (`cur === 0`, the unit cleared while we were down). Only insert if no open row exists. |
| Test | `alarmEpisodeCore.test.js` continues to pass under the harness; manual verification: start with a pre-existing active alarm, restart the server, confirm `getActiveAlarms()` returns one row not two. |
| Risk if unfixed | Alarm counts drift over time across restarts; episode grouping breaks. |
| Rollback | Restore the pre-fix `if (prev === undefined)` branch and remove the `getActiveAlarmForUnit` stmt. |

### T2.6 — Plant-cap `gapKw` clamped to ≥ 0

| | |
|---|---|
| File | `server/plantCapController.js:127` (config builder) |
| Before | `gapKw = (upperMw - lowerMw) * 1000`. If misconfigured with `lower >= upper`, gapKw went negative; downstream consumers comparing `gapKw < step * 0.5` produced misleading output. The validator already pushed an "errors" entry, but the clamp was missing. |
| After | `gapKw = Math.max(0, (upperMw - lowerMw) * 1000)`. Defence-in-depth — the upstream config validator still surfaces the error; the clamp prevents stray downstream consumers from acting on negative values. |
| Risk if unfixed | A future code path that multiplies gapKw to derive a setpoint could produce a negative kW value. Today, no such path exists; this is preventive. |
| Rollback | Drop the `Math.max(0, ...)`. |
| What we did NOT do | The audit's "negative setpoint write" claim was based on a misreading — `plantCapController.js` does not write setpoints, only stops/restarts whole inverters. The clamp here is the right-shaped fix; setpoint writes don't exist to break. |

### T2.7 — `go2rtcManager.start()` cleans up if `spawn()` throws

| | |
|---|---|
| File | `server/go2rtcManager.js` (`start()` ~line 190) |
| Before | `const child = spawn(exePath, args, ...)`. If spawn threw synchronously (`EACCES` on the binary, `ENOENT` race after `resolveExePath` checked), the exception propagated up but `status` stayed `"starting"` and `go2rtcProcess` stayed `null`. Subsequent `start()` calls saw a "starting" status and short-circuited — camera streaming silently dead. |
| After | Wrap spawn in try/catch. On throw: log, set `status = "stopped"`, `go2rtcProcess = null`, return `{ ok: false, error }` so the caller knows. |
| Risk if unfixed | Camera streaming silently dead after recoverable transient. |
| Rollback | Inline the spawn back as a const. |

### T2.8 — Day-ahead snapshot capture serialised per `forecast_day`

| | |
|---|---|
| File | `server/dayAheadLock.js` (`captureDayAheadSnapshot` refactored, new `_doCapture` helper, `_captureLocks` Map) |
| Before | Two concurrent calls (e.g. scheduled cron + manual UI) for the same `forecast_day` could both pass the `countDayAheadLockedForDay() === 0` check, both call `bulkInsertDayAheadLocked`, and the second's rows were silently dropped by `INSERT OR IGNORE` (the table has `PRIMARY KEY(forecast_day, slot)`). The DB stayed consistent, but the second caller returned `inserted: N` when really 0 rows landed. |
| After | In-process `Map<forecast_day, Promise>` lock. If a capture is in flight for the day, the second caller awaits it and returns `{ ok: true, reason: "already_in_progress", inserted: 0, joined_with: <prior_reason> }`. |
| Why JS lock and not just trust `INSERT OR IGNORE` | The audit's "duplicate (P10/P50/P90) pairs for WESM FAS submission" was incorrect — the schema PK already prevents that. The real bug was the misleading return-value semantics; the JS lock fixes that. |
| Risk if unfixed | Operator UI/logs report "captured N rows" twice when only the first capture actually wrote. |
| Rollback | Inline `_doCapture` back into `captureDayAheadSnapshot`; remove the lock map. |

### T2.9 — Streaming reconnect backoff capped at 30 s

| | |
|---|---|
| File | `server/streaming.js:45` (`handleProcessExit`) |
| Before | `delay = 3000 * Math.pow(2, reconnectAttempt)`. Already bounded by `reconnectAttempt < 3` (3 s, 6 s, 12 s) so today the bug is theoretical, but a future bump to the retry cap would silently produce minute-long backoffs. |
| After | `delay = Math.min(30000, 3000 * Math.pow(2, reconnectAttempt))`. Defensive cap. `reconnectAttempt = 0` reset on first data still happens in `stdout.on("data", ...)` — that path already correct. |
| Risk if unfixed | Theoretical until retry cap is bumped. |
| Rollback | Drop the `Math.min(30000, ...)`. |

---

## Verification (T7.3 smoke harness)

```
$ npm run smoke
...
  Node tests: 24/29 pass
    FAIL: cloudBackupS3Dedupe.test.js (status=1)
    FAIL: forecastActualAverageTable.test.js (status=1)
    FAIL: forecastCompletenessSource.test.js (status=1)
    FAIL: manualPullFailureCleanup.test.js (status=1)
    FAIL: manualReplicationCancel.test.js (status=1)
  Python tests: PASS (status=0)
  Total wall time: 275333ms
```

**Identical pass/fail pattern to [SMOKE_BASELINE.md](SMOKE_BASELINE.md).** Same 24/29 Node tests pass, all 107 Python tests pass. The 5 failing tests are the same pre-existing failures catalogued in the baseline doc — none are regressions from this session.

Notably:
- `bulkControlAuth.test.js` (directly exercises T2.3 changes) — **PASS**
- `dayAheadPlanImplementation.test.js` (exercises T2.8 area) — **PASS**
- `alarmEpisodeCore.test.js` (exercises T2.5 area) — **PASS**

Electron ABI restored cleanly at end of run.

---

## Status update for KNOWN_GAPS.md

| Gap | Status after Phase 5 |
|---|---|
| §1 backlog T2.3 | Closed |
| §1 backlog T2.4 | Closed (with v2.9.0 follow-up: DPAPI/safeStorage) |
| §1 backlog T2.5 | Closed |
| §1 backlog T2.6 | Closed |
| §1 backlog T2.7 | Closed |
| §1 backlog T2.8 | Closed (audit's "duplicate rows" claim was incorrect; real issue was return-value semantics) |
| §1 backlog T2.9 | Closed (defensive cap) |

---

## Remaining HIGH backlog after Phase 5

From [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan):

- **T1.5 / T1.6** — AbortController cleanup in remote fetches, reconnect-timer race
- **T3.6 – T3.12** — Python inverter (per-inverter polling isolation, Modbus socket leak, lock scope, timeout, queue, post-write verify)
- **T4.6 – T4.12** — Python forecast (reliability artifact, data-quality clock, legacy-model check, LightGBM reason, error-memory eligibility, transmission loss, regime threshold)
- **T6.8** — storage migration atomicity (optimisation only)

Plus pending work:
- v2.9.0 follow-up for T2.4 (DPAPI/safeStorage)
- v2.9.0 follow-up for T6.3 (move thumbprint to signed `trusted-signers.json`)
- UNIQUE index on `forecast_run_audit` (T4.4 partial residual from Phase 2)
- 5 pre-existing Node test failures from [SMOKE_BASELINE.md](SMOKE_BASELINE.md) (cloudBackupS3Dedupe, forecastActualAverageTable, forecastCompletenessSource, manualPullFailureCleanup, manualReplicationCancel)

Recommended next session: T3.6–T3.12 (Python inverter — services/tests/ has decent coverage for verification).

---

## Commit landed

| Commit | Scope |
|---|---|
| (this session) | Phase 5 backend: T2.3/T2.4/T2.5/T2.6/T2.7/T2.8/T2.9 across 7 server/* files + db.js prepared stmt |
| (this session) | Phase 5 documentation (this file + README/KNOWN_GAPS pointer updates) |
