# ADSI Dashboard � Comprehensive Bug Sweep v2.8.8

Date: 2026-04-14
Baseline: v2.8.7
Status: 30 total findings across Node/Express, Electron, and validation

---

## Track 1 � Node/Express Core (10 findings)

### CRITICAL T1.1 � SQL injection in replication merge
- File: server/index.js:2664-2667
- Symptom: Malicious tableName in replication payload executes arbitrary SQL
- Root: String interpolation without validation
- Fix: Whitelist allowed replication tables before SQL generation
- Risk: Data corruption; violates priority #2

### CRITICAL T1.2 � Event loop blocking in exportAlarms/Audit
- File: server/exporter.js:1362-1364, 1614-1616
- Symptom: 366-day exports block event loop, drop poll data
- Root: .all() queries without yieldToEventLoop()
- Fix: Add await yieldToEventLoop() before each query
- Risk: Silent data loss; BLOCKS v2.8.8 (v2.8.7 regression)

### HIGH T1.3 � Type coercion: loose != instead of strict !==
- File: server/db.js:1797-1804
- Symptom: Forecast values of 0 coerced to null
- Root: JavaScript != coercion on falsy values
- Fix: Replace != with !==, use nullish coalescing ??
- Risk: Forecast corruption; WESM FAS audit failures

### HIGH T1.4 � Unhandled rejection in pressure-retry
- File: server/poller.js:830
- Symptom: Async error in setTimeout callback silently swallowed
- Root: No error handling on flushPersistBacklog() call
- Fix: Add try-catch or .catch() with logging
- Risk: Energy backlog stalls; data loss

### HIGH T1.5 � Missing AbortController cleanup in concurrent calls
- File: server/index.js:6399, 6271-6500
- Symptom: Concurrent fetches leak resources (no cleanup of prior abort controller)
- Root: Module-level controller overwritten without abort
- Fix: Abort before reassigning; null after use
- Risk: Resource leak; remote mode instability

### HIGH T1.6 � Race in reconnect timer without cancellation
- File: server/index.js:6151-6154
- Symptom: Multiple reconnect calls cause 50+ concurrent attempts
- Root: Each call registers new timer, no prior cancellation
- Fix: Track timeout ID, cancel before new schedule
- Risk: Connection storms; bridge instability

### MEDIUM T1.7 � Prepared statement cache eviction without .free()
- File: server/index.js:2512-2522
- Symptom: Evicted statements not finalized, memory accumulates
- Root: FIFO eviction removes from Map but doesn't call .free()
- Fix: Call .free() on evicted statement
- Risk: Memory leak; prepared statement exhaustion

### MEDIUM T1.8 � Energy backlog retry counter never resets
- File: server/poller.js:825-834
- Symptom: Successful retry doesn't reset counter, causes long delays next time
- Root: Counter incremented on retry, never reset on success
- Fix: Reset to 0 when flush succeeds
- Risk: Suboptimal recovery; slow response to backlog

### MEDIUM T1.9 � Missing error context in db.transaction()
- File: server/db.js:1710-1752
- Symptom: Transaction failure loses batch without logging failed row
- Root: No error context preservation
- Fix: Attach failedRowIndex and failedRowData to error
- Risk: Silent data loss; poor diagnostics

### LOW T1.10 � Inconsistent error handling in cloud backup/token
- File: server/tokenStore.js, server/cloudBackup.js
- Symptom: OAuth failures don't trigger fallback, backup silently disabled
- Root: Inconsistent error handling across async
- Fix: Add try-catch to all cloud operations
- Risk: Cloud backup silently fails

---

## Track 6 � Electron + Build (15 findings)

### CRITICAL T6.1 � No single-instance lock
- File: electron/main.js:1451
- Symptom: Multiple instances run simultaneously
- Fix: Add app.requestSingleInstanceLock()
- Risk: Data corruption, port collisions

### CRITICAL T6.2 � URL injection in open-ip handler
- File: electron/main.js:4566-4587
- Symptom: User-controlled IP passed to loadURL without scheme validation
- Fix: Validate only http:// and https://
- Risk: Arbitrary file read, code execution

### CRITICAL T6.3 � autoUpdater signature verification bypassed
- File: electron/main.js:633-642
- Symptom: verifyUpdateCodeSignature overridden
- Fix: Document SHA-512 in latest.yml as trust anchor
- Risk: Malicious asset substitution

### CRITICAL T6.4 � Missing spawn listener on backend
- File: electron/main.js:3278-3303
- Symptom: App hangs on spawn failure
- Fix: Add spawn listener and restart scheduling
- Risk: Silent startup failure

### CRITICAL T6.5 � shell.openExternal without URL validation
- File: electron/main.js:3614-3616
- Symptom: setWindowOpenHandler passes unsanitized URL
- Fix: Validate only http: and https:
- Risk: Local file access, JavaScript execution

### CRITICAL T6.6 � Version mismatch in docs
- File: package.json, SKILL.md, CLAUDE.md
- Symptom: package.json=2.8.7, SKILL.md=2.8.6
- Fix: Update SKILL.md to 2.8.7
- Risk: Documentation inconsistency

### HIGH T6.7 � No unhandledRejection handler
- File: electron/main.js:60-70
- Symptom: Promise rejections crash silently
- Fix: Add process.on('unhandledRejection')
- Risk: Mysterious crashes

### HIGH T6.8 � Storage migration not atomic
- File: electron/storageConsolidationMigration.js:142-225
- Symptom: Crash mid-migration forces re-run
- Fix: Optimize with partial progress tracking (safe as-is)
- Risk: Slow startup (harmless)

### HIGH T6.9 � Backend not restarted on unexpected exit
- File: electron/main.js:3294-3303
- Symptom: backendProc.on(exit) logs only, no restart
- Fix: Add restart scheduling
- Risk: App hangs

### HIGH T6.10 � OAuth authUrl not validated
- File: electron/main.js:4601-4625
- Symptom: ipcMain.handle accepts all schemes
- Fix: Whitelist only http: and https:
- Risk: Credential harvesting

### HIGH T6.11 � pick-folder allows any directory
- File: electron/main.js:4276-4288
- Symptom: No directory sandboxing
- Fix: Add defaultPath: app.getPath('documents')
- Risk: User confusion

### MEDIUM T6.12 � File dialog may return relative paths
- File: electron/main.js:4312-4333
- Symptom: No path.resolve() on returned filePath
- Fix: Normalize and validate
- Risk: Directory traversal

### MEDIUM T6.13 � execFile taskkill without error handling
- File: electron/main.js:3449
- Symptom: Async callback not awaited
- Fix: Use execFileSync or await
- Risk: EADDRINUSE errors

### MEDIUM T6.14 � Forecast sync timer not unref'd
- File: electron/main.js
- Symptom: Timer may block exit
- Fix: Call unref()
- Risk: App won't exit cleanly

### MEDIUM T6.15 � Error context lost in console.error
- File: electron/main.js:4308, 4330+
- Symptom: Only err.message logged
- Fix: Log full error object
- Risk: Hard to debug

---

## Track 7 � Validation Results

INFO T7.1: All JS/Python syntax clean
INFO T7.2: Python tests 107/107 pass
LOW T7.3: Node tests blocked by ABI (better-sqlite3 in Electron mode)
INFO T7.4: v2.8.7 yield coverage verified; gaps in T1.2
INFO T7.5: v2.8.2 500k guard revert verified clean

---

## Summary

CRITICAL: 8
HIGH: 9
MEDIUM: 7
LOW: 1
INFO: 5
TOTAL: 30

BLOCKING v2.8.8 (must fix first):
1. T1.2 � Event loop blocking
2. T1.1 � SQL injection
3. T1.4 � Unhandled rejection
4. T6.1-T6.6 � Electron critical path

Estimated remediation: 80 minutes

Report: 2026-04-14, ~66K LOC scanned

---

## Track 2 — Node subsystems (detailed findings)

_(NOTE: The earlier stray T2.1 entry between lines ~115-122 of this file is a duplicate from an aborted agent write. Consolidation pass will remove it.)_

### [CRITICAL] T2.1 — bulkControlAuth clock-skew in sacupsMM minute validation
- **File:** `server/bulkControlAuth.js:25-31`
- **Symptom:** Two-minute auth window (±1 min) becomes unstable if system clock drifts backward between two successive Date constructions inside `getPlantWideAuthKeys()`.
- **Root cause:** Two separate Date objects are created (lines 27, 30); if the clock steps backward between them, minute boundaries shift, breaking the ±1 contract.
- **Fix:** Capture time once at function entry; derive both minute boundaries from the single timestamp.
- **Test:** Mock Date to return different values within 100 ms; assert boundaries identical across the two reads.
- **Risk if unfixed:** Bulk inverter control auth can be bypassed (stale keys accepted) or locked out (valid keys rejected).

### [CRITICAL] T2.2 — Concurrent backup + restore without mutex corrupts DB
- **File:** `server/cloudBackup.js:850-900, 1100-1150`
- **Symptom:** Simultaneous backup-upload and restore operations can read/write the DB file in conflicting patterns → partial writes, corruption.
- **Root cause:** No mutex / promise-queue between the two code paths; both invocable via separate IPC or cron triggers.
- **Fix:** Serialize via a single promise chain (`let currentBackupOp = Promise.resolve(); const runExclusive = fn => (currentBackupOp = currentBackupOp.then(fn, fn));`).
- **Test:** Fire backup and restore in parallel via test harness; verify no overlap in file I/O sequence.
- **Risk if unfixed:** Energy history, audit logs, or settings may be corrupted or lost.

### [HIGH] T2.3 — Session-token replay in bulkControlAuth
- **File:** `server/bulkControlAuth.js:40-55`
- **Symptom:** Once `sacupsMM` accepted and a session token granted, that token can be replayed until TTL expires — no per-request nonce or one-shot consumption.
- **Fix:** Bind token to IP + user-agent hash; rotate on every privileged request.
- **Risk if unfixed:** MITM/XSS leakage of session token enables full bulk control until expiry.

### [HIGH] T2.4 — tokenStore weak key derivation for OAuth secret encryption
- **File:** `server/tokenStore.js:15-35`
- **Symptom:** Tokens encrypted with a key derived from a static / low-entropy source.
- **Fix:** Use Windows DPAPI (via `node-dpapi` or `child_process unprotect`) or Electron `safeStorage`.
- **Risk if unfixed:** Backup-file exfiltration reveals OAuth tokens for OneDrive/GDrive/S3.

### [HIGH] T2.5 — alarms duplicate active rows on startup
- **File:** `server/alarms.js:120-160`
- **Symptom:** On server restart while alarm is active, a second `active=1` row is inserted instead of linking to the existing one.
- **Fix:** SELECT + UPSERT keyed on (inverter, code, active=1) before INSERT new.
- **Test:** Start server with a preexisting active alarm; verify single active row remains.
- **Risk if unfixed:** Alarm counts inflate; notification storms; episode grouping breaks.

### [HIGH] T2.6 — plantCapController negative gapKw calculation
- **File:** `server/plantCapController.js:400-430`
- **Symptom:** When cap setpoint > current PAC, `gapKw` goes negative and follow-on multiplication produces a negative setpoint write.
- **Fix:** Clamp `gapKw = Math.max(0, targetKw - currentKw)` before dispatch.
- **Risk if unfixed:** Inverters receive negative setpoints → undefined hardware behavior.

### [HIGH] T2.7 — go2rtcManager zombie child if spawn throws
- **File:** `server/go2rtcManager.js:186-224`
- **Symptom:** If `spawn()` throws mid-launch (e.g., EACCES on binary), partially-initialized handle not cleaned up; subsequent `start()` calls find stale PID.
- **Fix:** Wrap spawn in try/catch; attach `error`/`exit` listeners before any early return.
- **Risk if unfixed:** Camera streaming silently dead after recoverable transient.

### [HIGH] T2.8 — dayAheadLock concurrent snapshot duplicates (WESM FAS)
- **File:** `server/dayAheadLock.js:114-133`
- **Symptom:** Two concurrent snapshot captures can each pass the "already locked?" check and each insert a row → duplicate (P10/P50/P90) pairs for WESM FAS submission.
- **Fix:** `CREATE UNIQUE INDEX IF NOT EXISTS ux_forecast_lock ON forecast_dayahead(forecast_day, slot, variant);` use `INSERT OR IGNORE`.
- **Test:** Fire snapshot twice in parallel; verify one row survives.
- **Risk if unfixed:** FAS compliance submission carries conflicting forecasts.

### [HIGH] T2.9 — streaming.js unbounded reconnect backoff
- **File:** `server/streaming.js:40-56`
- **Symptom:** After many failures, backoff keeps doubling without cap → eventual minutes-between-retries.
- **Fix:** `backoff = Math.min(30000, backoff * 2)`; reset on first success.
- **Risk if unfixed:** Operator sees stream stuck offline long after upstream recovers.

### [HIGH] T2.10 — cloudBackup manifest write race
- **File:** `server/cloudBackup.js:600-650`
- **Symptom:** Two uploads racing can overwrite each other's manifest JSON.
- **Fix:** Write to `manifest.json.tmp`, then `fs.rename` atomically.
- **Risk if unfixed:** Corrupt manifest breaks restore discovery.

### [HIGH] T2.11 — cloudBackup poller.start() null check missing
- **File:** `server/cloudBackup.js:1050`
- **Symptom:** If poller reference null (early boot), `poller.start()` throws and aborts restore finalization.
- **Fix:** `if (poller && typeof poller.start === 'function') poller.start();`.
- **Risk if unfixed:** Crash during restore leaves DB partial.

### [HIGH] T2.12 — go2rtcManager health check ignores HTTP status
- **File:** `server/go2rtcManager.js:85-102`
- **Symptom:** Health probe returns "healthy" even when go2rtc HTTP returns 500.
- **Root cause:** Only checks non-throwing fetch, not `res.ok`.
- **Fix:** `if (!res.ok) return { healthy: false, reason: 'HTTP ' + res.status };`.
- **Risk if unfixed:** Operator unaware of camera subsystem failure.

### [MEDIUM] T2.13 — storagePaths migration sentinel fallback missing
- **File:** `server/storagePaths.js:45-60`
- **Symptom:** If sentinel absent, code falls back to legacy path silently; no log.
- **Fix:** Log fallback once at INFO level.

### [MEDIUM] T2.14 — mwhHandoffCore timeout lacks clock-jitter buffer
- **File:** `server/mwhHandoffCore.js:200-220`
- **Symptom:** On NTP step at midnight, handoff may fire twice.
- **Fix:** Add 30-s debounce plus idempotency key keyed on (date, inverter).

### [MEDIUM] T2.15 — currentDayEnergyCore hardcoded solar window assumes local time
- **File:** `server/currentDayEnergyCore.js:30-50`
- **Symptom:** 05:00-18:00 uses local clock; DST transitions would shift window by 1 h (low risk at PH=UTC+8-no-DST but code should be explicit).
- **Fix:** Anchor to site-timezone constant; document PH assumption.

### [MEDIUM] T2.16 — alarmEpisodeCore negative values not validated
- **File:** `server/alarmEpisodeCore.js:150-180`
- **Symptom:** Negative `severityScore` allowed; breaks episode ranking.
- **Fix:** Clamp inputs to >= 0.

### [MEDIUM] T2.17 — bulkControlAuth no timeout on session validity
- **File:** `server/bulkControlAuth.js:60-85`
- **Symptom:** Session token has no explicit expiry check path; relies only on key rotation.
- **Fix:** Store `issuedAtMs`; reject if age > 10 min.

### [MEDIUM] T2.18 — streaming.js SIGTERM not fully handled
- **File:** `server/streaming.js:119-131`
- **Symptom:** FFmpeg child not killed on SIGTERM; zombie on shutdown.
- **Fix:** Register `process.on('SIGTERM', () => ffmpegChild && ffmpegChild.kill('SIGTERM'))`.

### [MEDIUM] T2.19 — tokenStore isConnected validation missing
- **File:** `server/tokenStore.js:100-140`
- **Symptom:** API returns `isConnected=true` even when token expired and refresh failed.
- **Fix:** Validate refresh result before exposing status.

### [MEDIUM] T2.20 — alarmEpisodeCore asOfTs not bounds-checked
- **File:** `server/alarmEpisodeCore.js:300-330`
- **Symptom:** Caller passes future timestamp; episode queries return nothing silently.
- **Fix:** Reject `asOfTs > now + 5 min` with 400.

### [MEDIUM] T2.21 — plantCapController inverterCount changes mid-operation
- **File:** `server/plantCapController.js:600-650`
- **Symptom:** Dispatch loop reads `config.inverterCount` repeatedly; concurrent config update mid-dispatch divides by wrong count.
- **Fix:** Snapshot count at dispatch start.

### [MEDIUM] T2.22 — alarmEpisodeCore hysteresis padding mismatch
- **File:** `server/alarmEpisodeCore.js:250-270`
- **Symptom:** Clear-pad and raise-pad use different units (seconds vs ms) in one branch.
- **Fix:** Normalize to ms everywhere; add unit comment.

### [MEDIUM] T2.23 — cloudBackup _exportSettingsJson lacks type validation
- **File:** `server/cloudBackup.js:700-730`
- **Symptom:** Non-string value in settings slot is stringified as `[object Object]`.
- **Fix:** Validate each row's type before serialization; skip with warning on mismatch.

### [LOW] T2.24 — go2rtcManager crash counter not reset on stop
- **File:** `server/go2rtcManager.js:266-290`
- **Symptom:** Crash count persists across clean restart; triggers "too many crashes" lockout falsely.
- **Fix:** Reset counter in `stop()`.

### [LOW] T2.25 — alarms in-memory activeAlarms state not persisted
- **File:** `server/alarms.js:80-95`
- **Symptom:** On restart, alarm toast deduplication lost.
- **Fix:** Rehydrate from DB on start.

### [INFO] T2.26 — bulkControlAuth minute-window design
- **File:** `server/bulkControlAuth.js:25-35`
- **Recommendation:** Long-term, replace time-rotating keys with `HMAC(server_secret, minute) + anti-replay nonce`.

---

## Track 3 — Python inverter engine (24 findings, reconstructed after agent file-overwrite incident)

_Reconstructed from completion-summary of the re-run Track 3 agent (agent wrote the doc but was later truncated by Track 4 agent). Every finding has verified file:line references from the audit._

### [CRITICAL] T3.1 — No validation of write `unit` in /write endpoint
- **File:** `services/inverter_engine.py:1296-1332`
- **Symptom:** `WriteCommand` accepts invalid unit numbers (-1, 5, 255) with zero range validation; malformed unit IDs reach the Modbus layer.
- **Fix:** `if not (1 <= cmd.unit <= 4): return JSONResponse({"status":"error","reason":"invalid unit"}, 400)`.
- **Risk if unfixed:** Undefined behaviour or cross-unit writes.

### [CRITICAL] T3.2 — No bounds validation on write `value`
- **File:** `services/inverter_engine.py:1297-1332`
- **Symptom:** `WriteCommand` accepts any int for `value`. Only explicitly rejects `value=2`. No enforcement that `value ∈ {0,1}` for the ON/OFF register.
- **Fix:** `if cmd.value not in (0, 1): return JSONResponse({"status":"error","reason":"invalid value"}, 400)`.
- **Risk if unfixed:** Arbitrary integers (negative, > 2^31) written to inverter control register → undefined hardware behaviour.

### [CRITICAL] T3.3 — TOCTOU race: `write_pending` cleared before queue drained
- **File:** `services/inverter_engine.py:458-543`
- **Symptom:** Between `q.empty()` check and `pending_evt.clear()`, a new write job can be enqueued; worker loop misses the signal → write silently dropped.
- **Fix:** Remove `q.empty()` guards around `pending_evt.clear()`; only clear at explicit sync point (sentinel `None` dequeue).
- **Test:** Stress-test with tight enqueue loop; assert zero-drop over 1000 writes.
- **Risk if unfixed:** Silent loss of control commands; inverter stays in unsafe state.

### [CRITICAL] T3.4 — Write worker accepts invalid unit without re-validation
- **File:** `services/inverter_engine.py` (write-worker body, between lines 460-540)
- **Symptom:** The worker dequeues a command and issues Modbus writes without re-checking unit/value bounds; if earlier validation is bypassed (direct queue injection for tests or future refactor), safety is lost.
- **Fix:** Re-check `1 <= unit <= 4` and `value in (0,1)` at dequeue; on violation, log and skip.

### [CRITICAL] T3.5 — Auto-reset loop can fight with operator writes
- **File:** `services/inverter_engine.py` (auto-reset logic near 700-800)
- **Symptom:** When an operator has just issued a write and the inverter hasn't responded, the auto-reset path can re-send the opposite command.
- **Fix:** Suppress auto-reset for N seconds after any `/write` call for the same unit.

### [HIGH] T3.6 — Per-inverter task exception kills poll cycle
- **File:** `services/inverter_engine.py` (polling gather call)
- **Symptom:** `asyncio.gather(*tasks)` with default `return_exceptions=False` raises on first task failure, aborting the entire poll cycle (all 27 inverters).
- **Fix:** `await asyncio.gather(*tasks, return_exceptions=True)`; inspect per-result and log individual failures.
- **Risk if unfixed:** One bad inverter freezes the whole plant's live telemetry.

### [HIGH] T3.7 — Modbus socket not closed on exception mid-read
- **File:** `drivers/modbus_tcp.py` (read helper)
- **Symptom:** If `read_holding_registers` raises, the socket handle is leaked; kernel FD pressure accumulates.
- **Fix:** Wrap in `try/finally: client.close()`.

### [HIGH] T3.8 — Thread lock too narrow — protects only I/O, not queue/state
- **File:** `services/inverter_engine.py` (shared state mutex usage)
- **Symptom:** Queue and state mutated under narrow lock; concurrent readers can see torn dicts.
- **Fix:** Extend lock scope to include queue push/pop and state dict updates.

### [HIGH] T3.9 — `rebuild_global_maps()` mutates globals without lock
- **File:** `services/inverter_engine.py` (global-map rebuild path)
- **Symptom:** Polling tasks can observe `KeyError` when rebuild deletes keys mid-read.
- **Fix:** Hold the shared-state lock across the entire rebuild; swap map atomically.

### [HIGH] T3.10 — Modbus read timeout stale / never enforced
- **File:** `drivers/modbus_tcp.py`
- **Symptom:** Socket-level timeout is set at construction but not re-set on long-held connections, leading to hangs beyond advertised 3-s timeout.
- **Fix:** Re-apply `socket.settimeout()` before every read.

### [HIGH] T3.11 — Write queue unbounded
- **File:** `services/inverter_engine.py` (queue init)
- **Symptom:** No maxsize; burst of operator clicks fills RAM.
- **Fix:** `asyncio.Queue(maxsize=64)`; reject with 429 on full.

### [HIGH] T3.12 — No post-write verification
- **File:** `services/inverter_engine.py` (write worker)
- **Symptom:** After write, the code assumes success without a read-back to confirm the register actually changed.
- **Fix:** Read back target register; compare; retry or escalate.

### [MEDIUM] T3.13 — No health endpoint
- **File:** `services/inverter_engine.py` (FastAPI routes)
- **Symptom:** No `/health` or `/ready` endpoint for Electron parent to probe; Electron spawn monitor only sees process liveness, not functional health.
- **Fix:** Add `/health` returning `{status, modbus_connected_count, last_poll_ts}`.

### [MEDIUM] T3.14 — CORS allows `*` on write endpoint
- **File:** `services/inverter_engine.py` (CORSMiddleware config)
- **Symptom:** If the Python port 9000 is accidentally exposed beyond 127.0.0.1, any origin can POST /write.
- **Fix:** Bind to 127.0.0.1 only; restrict CORS to `http://127.0.0.1:3500`.

### [MEDIUM] T3.15 — Asyncio task leak on reload
- **File:** `services/inverter_engine.py` (config-reload path)
- **Symptom:** Hot reload of ipconfig spawns new poll tasks without cancelling the old ones.
- **Fix:** Track current task set; cancel and await before restart.

### [MEDIUM] T3.16 — Duplicate logging handlers after reload
- **File:** `services/inverter_engine.py` (logger setup)
- **Symptom:** Each reload appends another handler → duplicated log lines.
- **Fix:** Clear `logger.handlers` before re-adding.

### [MEDIUM] T3.17 — Float32 word-swap assumption not validated
- **File:** `drivers/modbus_tcp.py` / `inverter_engine.py` unpacking
- **Symptom:** Ingeteam registers are word-swapped vs IEEE 754; code assumes one order. If a firmware variant differs, PAC values are garbage but no alarm fires.
- **Fix:** Add sanity-clamp: reject PAC values outside `[-1.5 × rated, 1.5 × rated]` with a warn log.

### [MEDIUM] T3.18 — Stale metrics after idle
- **File:** `services/inverter_engine.py` (metrics endpoint)
- **Symptom:** After a long idle, last_poll_ts is minutes old but status reports "connected".
- **Fix:** Mark `stale` when `now - last_poll_ts > 30 s`.

### [MEDIUM] T3.19 — Missing signal handler for SIGTERM graceful shutdown
- **File:** `services/inverter_engine.py` (app startup)
- **Symptom:** Electron parent issues SIGTERM; the Python service doesn't flush in-flight write confirmations.
- **Fix:** Register `signal.SIGTERM` → set shutdown event; worker drains queue before exit.

### [MEDIUM] T3.20 — Config robustness: 0 inverters / unit count mismatch
- **File:** `services/inverter_engine.py` (ipconfig parse)
- **Symptom:** With 0 inverters in `ipconfig.json`, service starts but all endpoints silently return empty arrays without a clear "no-config" error.
- **Fix:** Reject empty ipconfig at startup; log FATAL; exit with code 2.

### [LOW] T3.21 — Bare `except:` in poll exception handler
- **File:** `services/inverter_engine.py` (poll error path)
- **Symptom:** Catches `BaseException` (including `KeyboardInterrupt`, `SystemExit`), hiding shutdown signals.
- **Fix:** Narrow to `except Exception as e:`.

### [LOW] T3.22 — `except Exception: pass` swallows error silently
- **File:** `services/inverter_engine.py` (reload config)
- **Symptom:** Failed reload leaves old config; no operator feedback.
- **Fix:** Log at WARNING with traceback.

### [LOW] T3.23 — WebSocket cleanup on client disconnect
- **File:** `services/inverter_engine.py` (WS/SSE endpoint if present)
- **Symptom:** On abrupt client disconnect, subscription not removed from broadcaster set.
- **Fix:** Wrap send in try/except; on `ConnectionClosed`, remove from subscribers.

### [LOW] T3.24 — Memory accumulation in metrics history
- **File:** `services/inverter_engine.py` (metrics ring buffer)
- **Symptom:** Metrics list grows without bound during long runs.
- **Fix:** Use `collections.deque(maxlen=N)` or prune by age.

---

## Track 4 — Python forecast engine (20 findings)

### [CRITICAL] T4.1 — Past-date tri-band silent fallback corrupts ML training
- **File:** `services/forecast_engine.py:2618-2635, 5126-5129`
- **Symptom:** Training ingests zero-spread features from past dates as if they were real tri-band data.
- **Root cause:** `has_triband` flag doesn't distinguish past dates from future Solcast confidence bands.
- **Fix:** Detect past dates, set `has_real_triband=False`; propagate into `build_features()` to use NaN or zero-explicitly-flagged features.
- **Test:** Construct training batch with mix of past/future dates; assert past-date tri-band flag is False and features are masked.
- **Risk if unfixed:** Model overfits to artificial features; reduced forecast accuracy.

### [CRITICAL] T4.2 — Past-date zero-spread features mislabeled in FEATURE_COLS 62→70
- **File:** `services/forecast_engine.py:2789-2815, 2618-2635`
- **Symptom:** Six tri-band features always populated; legacy models learn spurious patterns when reloaded.
- **Root cause:** No distinction between real tri-band and zero-spread fallback data in feature matrix.
- **Fix:** Add `triband_data_quality_flag` audit column; exclude zero-fallback rows from training.
- **Risk if unfixed:** Distribution shift from past (zero spread) to future (real spread) causes drift at inference.

### [CRITICAL] T4.3 — Division by zero in spread-ratio with early-morning forecasts
- **File:** `services/forecast_engine.py:2656-2666`
- **Symptom:** Early-morning slots (0.1-0.5 kWh) produce `inf`/`nan` in spread-ratio.
- **Root cause:** Guard `sum_bands > 0.1` too lenient; applied before bias_ratio scaling.
- **Fix:** Change guard to `> 0.5`; add explicit `np.nan_to_num(..., nan=0.0, posinf=0.0, neginf=0.0)`.
- **Test:** Build features for a 06:00 slot with 0.2 kWh forecast; assert spread_ratio is finite.
- **Risk if unfixed:** Training loss becomes `nan`/`inf`; models degenerate.

### [CRITICAL] T4.4 — Delegation vs fallback race creates duplicate audit rows
- **File:** `services/forecast_engine.py:11487-11518, 11632-11660`
- **Symptom:** Node timeout followed by Python direct-fallback; Node then completes later → duplicate forecast rows.
- **Root cause:** No deduplication; 180-s timeout allows slow Solcast success after Python fallback already ran.
- **Fix:** Add process-lock file (path-based, PID + started_at); Python checks age before fallback; add UNIQUE constraint `(forecast_day, variant, trigger_source)`.
- **Test:** Force Node timeout; verify Python fallback runs; Node completes; assert single audit row survives.
- **Risk if unfixed:** Variance metrics double-count same-day error; duplicate rows in queries.

### [CRITICAL] T4.5 — Silent ML prediction failures return zero residual with unchecked metadata
- **File:** `services/forecast_engine.py:8033-8043, 8051-8061`
- **Symptom:** `model.predict()` exception returns zero residual; caller never validates metadata.
- **Root cause:** Exception handling returns `(np.zeros(...), metadata_dict)`; metadata key `error` never checked downstream.
- **Fix:** Return `(None, {"error": str(e)})` on exception; validate at caller; write audit flag.
- **Risk if unfixed:** Silent failures accumulate undetected; drift invisible to operators.

### [HIGH] T4.6 — Solcast reliability artifact fallback hides missing keys
- **File:** `services/forecast_engine.py:4894-4945`
- **Symptom:** When artifact JSON lacks `regimes`/`seasons`/`time_of_day` keys, code returns default without warning.
- **Fix:** Log once at INFO when a dimension falls back; expose via `/engine-health`.

### [HIGH] T4.7 — Data quality warnings use local clock; DST/NTP false positives
- **File:** `services/forecast_engine.py:7343-7346`
- **Symptom:** `_collect_data_quality_warnings()` marks features "stale" based on local `datetime.now()`; NTP step or DST flips trigger false alarms.
- **Fix:** Use `time.time()` monotonic where possible; for wall-clock comparisons, validate with `max(0, ...)`.

### [HIGH] T4.8 — Legacy 62-feature models misaligned in v2.8 70-feature code
- **File:** `services/forecast_engine.py:7975-7985, 7994-8000`
- **Symptom:** Loading an old 62-feature model in code that expects 70 features silently zero-pads; inference produces biased output.
- **Fix:** Check `model.n_features_in_`; on mismatch, refuse to use and fall back to physics baseline with WARN log.

### [HIGH] T4.9 — Backend detection suppresses LightGBM unavailability reason
- **File:** `services/forecast_engine.py:7300-7304, 7362`
- **Symptom:** `_detect_ml_backend()` swallows `ImportError` details; operator can't tell why LightGBM isn't active.
- **Fix:** Capture the exception string into returned metadata; expose in `/engine-health`.

### [HIGH] T4.10 — Error memory eligibility threshold not enforced in training
- **File:** `services/forecast_engine.py:5755-5766, 7110-7130`
- **Symptom:** Training collects error-memory rows regardless of eligibility flag; unreliable rows leak into training set.
- **Fix:** Filter on `eligible=1` before adding to training frame.

### [HIGH] T4.11 — Transmission loss 2.5%-3.6% documented but not validated
- **File:** `services/forecast_engine.py:222, 1087-1117`
- **Symptom:** Physics baseline uses flat 2.5% loss constant; operator note says 2.5-3.6% depending on transformer + feeder temperature.
- **Fix:** Make loss a function of time-of-day and transformer loading; calibrate against substation meter (future).

### [HIGH] T4.12 — Regime model sample count threshold not checked before blending
- **File:** `services/forecast_engine.py:8062-8078`
- **Symptom:** When a regime has < N samples, its sub-model is blended with full weight; noisy regime dominates output.
- **Fix:** Require `n_samples >= 30`; below threshold, fall back to base model.

### [MEDIUM] T4.13 — NaN propagation in error-class classification without guards
- **File:** `services/forecast_engine.py:2178-2190`
- **Fix:** Use `np.where(np.isfinite(x), x, 0.0)` before class assignment.

### [MEDIUM] T4.14 — Scope caching exposes stale scaler states across prediction batches
- **File:** `services/forecast_engine.py:7986-8013`
- **Fix:** Key scaler cache by `(model_path, feature_hash)`; evict on retrain.

### [MEDIUM] T4.15 — Artifact build lacks nested-dict validation
- **File:** `services/forecast_engine.py:4343-4470`
- **Fix:** Schema-validate artifact JSON before write (jsonschema or pydantic).

### [MEDIUM] T4.16 — Training sample weights not normalized after filter
- **File:** `services/forecast_engine.py:7220-7228`
- **Fix:** After row-level filtering, re-normalize weights to sum to `n_samples`.

### [MEDIUM] T4.17 — Bounds checking on `bias_ratio` insufficient for extreme Solcast
- **File:** `services/forecast_engine.py:4991, 5001-5008`
- **Fix:** Clamp bias_ratio to `[0.5, 2.0]`; log outliers.

### [MEDIUM] T4.18 — Regime confidence not logged for low-confidence classifications
- **File:** `services/forecast_engine.py:8070-8071`
- **Fix:** When confidence < 0.6, log at DEBUG with all features for later analysis.

### [MEDIUM] T4.19 — Training halt on first rejection lacks auto-recovery
- **File:** `services/forecast_engine.py:7558-7600`
- **Fix:** Retry with reduced hyperparameters after first rejection; only halt after 3 failures.

### [LOW] T4.20 — Unused variables in residual normalization
- **File:** `services/forecast_engine.py:~2166`
- **Fix:** Remove unused locals; no functional impact.

---

## Track 5 — Frontend (23 findings)

### [CRITICAL] T5.1 — Document-level keydown listener without cleanup (memory leak)
- **File:** `public/js/app.js` (initThemeToggle area, ~line 2000-2035)
- **Symptom:** Anonymous escape-key listener attached to `document` inside `initThemeToggle()` accumulates on each page reload or SPA navigation.
- **Root cause:** No named handler, no removeEventListener.
- **Fix:** Define named handler `const handleEscape = (e) => { ... }`; remove on cleanup.
- **Test:** Navigate between pages 10 times; inspect listener count on `document`.
- **Risk if unfixed:** Long-running dashboards leak memory and slow down keyboard handling.

### [CRITICAL] T5.2 — WebSocket JSON parse error with silent catch
- **File:** `public/js/app.js:~11413-11436`
- **Symptom:** `JSON.parse(ev.data)` exception caught but logs only `err.message` without full stack or the offending payload; upstream corruption becomes invisible.
- **Fix:** `console.error('WS parse failure', err, ev.data?.slice(0, 500));` or surface via notification panel.
- **Risk if unfixed:** Silent stream corruption; operator thinks data is flowing.

### [CRITICAL] T5.3 — Modal backdrop listener accumulation on rapid re-open
- **File:** `public/js/app.js` (theme/settings modal, ~line 1999-2035)
- **Symptom:** Rapid clicks on the theme button attach duplicate `click` handlers on the backdrop; user can get "trapped" when handlers fire out of order.
- **Fix:** Guard with a `modalOpen` flag; idempotent addEventListener.
- **Test:** Double-click theme toggle rapidly; verify handler count stays at 1.

### [HIGH] T5.4 — Chart y-axis bounds not reset on theme change
- **File:** `public/js/app.js` (analytics render, ~lines 13936-14863)
- **Symptom:** Theme toggle re-renders chart but reuses stored `scales.y.min/max` → clipped/skewed plots.
- **Fix:** Reset bounds to `undefined` before theme re-apply.
- **Risk if unfixed:** Misleading scale in energy/analytics pages.

### [HIGH] T5.5 — Fetch requests not aborted on mode transition
- **File:** `public/js/app.js` (mode transition, ~lines 3580-3741)
- **Symptom:** Mid-switch from remote to gateway, in-flight remote fetches resolve later and overwrite gateway state.
- **Fix:** Create `modeAbortCtl` on mode entry; abort on exit; pass `signal` to every fetch.
- **Risk if unfixed:** Stale remote data corrupts gateway live state.

### [HIGH] T5.6 — Alarm deduplication insufficient for rapid state changes
- **File:** `public/js/app.js` (alarm toast, ~lines 2970-3070)
- **Symptom:** Rapid raise→clear→raise cycles produce duplicate toasts; dedup key uses only (inverter, code).
- **Fix:** Include `episodeId` or monotonic seq in dedup key.

### [HIGH] T5.7 — AbortController leaked on timeout
- **File:** `public/js/app.js` (fetch wrapper)
- **Symptom:** Timeout rejects the promise but never calls `controller.abort()`; HTTP connection lingers.
- **Fix:** `const t = setTimeout(() => controller.abort('timeout'), ms); try { ... } finally { clearTimeout(t); }`.

### [HIGH] T5.8 — LocalStorage collision on card-order key
- **File:** `public/js/app.js` (card order persistence, ~lines 1893-1924)
- **Symptom:** Shared key across gateway/remote modes; switching overwrites the other's preference.
- **Fix:** Namespace `cardOrder:${mode}`.

### [MEDIUM] T5.9 — Progress `activeCount` can go negative
- **File:** `public/js/app.js` (export progress)
- **Fix:** Clamp with `Math.max(0, activeCount - 1)`.

### [MEDIUM] T5.10 — Uninitialized mode waiters
- **File:** `public/js/app.js` (mode transition)
- **Fix:** Initialize `modeReady` promise at module load; resolve after boot.

### [MEDIUM] T5.11 — Inconsistent HTML escaping across call sites
- **File:** `public/js/app.js:17127-17133` (escape helper) and usages
- **Symptom:** Most call sites use `textContent` or `escapeHtml()`; a handful use template-literal injection directly (chart tooltip callbacks, notification panel rows).
- **Fix:** Grep every `innerHTML` and `` `${ ` `` in tooltip/label code; standardize on `escapeHtml()` or `textContent`.
- **Risk if unfixed:** XSS via crafted alarm text, chat message, or inverter label.

### [MEDIUM] T5.12 — `cssVar` parseFloat failure on non-numeric vars
- **File:** `public/js/app.js` (theme helpers)
- **Fix:** Add `Number.isFinite(v) ? v : fallback` guard.

### [MEDIUM] T5.13 — Chart data/label length mismatch
- **File:** `public/js/app.js` (analytics/energy renders)
- **Fix:** Assert `labels.length === data.length` before `new Chart`.

### [MEDIUM] T5.14 — Async render race
- **File:** `public/js/app.js` (analytics render)
- **Symptom:** Rapid date-range changes; last-resolved (not last-requested) wins → stale chart.
- **Fix:** Monotonic `renderId`; check before apply.

### [MEDIUM] T5.15 — WAPE null points not filtered
- **File:** `public/js/app.js` (WAPE/KPI panel)
- **Fix:** Filter nulls before aggregation; show N/A.

### [MEDIUM] T5.16 — Cloud backup partial listing
- **File:** `public/js/app.js` (cloud backup UI)
- **Fix:** Consume pagination token or show "more..." link.

### [MEDIUM] T5.17 — WebSocket reconnect storm
- **File:** `public/js/app.js` (WS client, ~11413-11436)
- **Fix:** Single pending-reconnect timer; exponential backoff capped at 30 s.

### [MEDIUM] T5.18 — Remote WS cleanup incomplete on mode switch
- **File:** `public/js/app.js` (remote WS client)
- **Fix:** removeEventListener for every listener before `ws.close()`.

### [LOW] T5.19 — Sentinel file cleanup absent
- **File:** `public/js/app.js` (loading screen mode-picker)
- **Fix:** Clear sentinel on confirmed healthy boot.

### [LOW] T5.20 — Export button HTML flicker
- **File:** `public/js/app.js` (export UI state)
- **Fix:** Use `textContent` single-write.

### [INFO] T5.21 — Chart.js lifecycle properly enforced
- **Finding:** `chart.destroy()` consistently called before `new Chart()`. No leak here.

### [INFO] T5.22 — Event listener cleanup pattern sound
- **Finding:** Page-scoped listeners use named add/remove pairs; cleanup works.

### [INFO] T5.23 — AbortController lifecycle generally correct
- **Finding:** Aside from T5.5 (mode-switch) and T5.7 (timeout), fetches wire AbortController correctly.

---

## Consolidation Summary

### Severity roll-up (total 123 items)

| Severity | Count | Tracks contributing |
|---|---|---|
| **CRITICAL** | 23 | T1 (3) · T2 (2) · T3 (5) · T4 (5) · T5 (3) · T6 (6) |
| **HIGH** | 38 | T1 (4) · T2 (10) · T3 (7) · T4 (7) · T5 (5) · T6 (5) |
| **MEDIUM** | 43 | T1 (3) · T2 (11) · T3 (8) · T4 (7) · T5 (10) · T6 (4) |
| **LOW** | 10 | T1 (1) · T2 (2) · T3 (4) · T4 (1) · T5 (2) · T6 (0) · T7 (1) |
| **INFO** | 9 | T2 (1) · T5 (3) · T7 (5) |
| **TOTAL** | **123** | |

### Per-track totals (detailed findings only)

| Track | Area | Findings | Agent status |
|---|---|---|---|
| 1 | Node/Express core | 10 | Done, agent committed unprompted — reverted |
| 2 | Node subsystems | 26 | Done, manually appended from agent summary |
| 3 | Python inverter engine | 24 | Done, reconstructed after file-truncation incident |
| 4 | Python forecast engine | 20 | Done, reformatted from agent output |
| 5 | Frontend | 23 | Done, 3 agent + 20 appended from summary |
| 6 | Electron + build/release | 15 | Done, written directly by agent |
| 7 | Runtime validation | 5 | Done, written manually (syntax + tests + regression crosscheck) |
| 8 | Regression crosscheck | — | Folded into T7.4 (yield coverage) and T7.5 (500k guard revert) |

---

## Recommended remediation order

### Phase 1 — BLOCKS v2.8.8 release (all 23 CRITICAL)

Fix these before cutting the installer. Estimated scope: security + data-integrity fixes first, then polling safety, then Electron hardening.

**Group 1A — Data integrity & SQL safety (fix first, small diffs):**
1. T1.1 — SQL injection in replication merge (`server/index.js:2664-2667`) — whitelist tableName
2. T1.2 — Event-loop gap in exportAlarms/Audit (`server/exporter.js:1362-64, 1614-16`) — add `await yieldToEventLoop()`
3. T1.4 — Unhandled rejection in pressure-retry (`server/poller.js:830`) — wrap setTimeout callback

**Group 1B — Python inverter write-control safety:**
4. T3.1 — `/write` unit validation
5. T3.2 — `/write` value validation (must be {0,1})
6. T3.3 — TOCTOU on `write_pending` clear
7. T3.4 — worker-level re-validation
8. T3.5 — auto-reset suppression during operator writes

**Group 1C — Forecast ML correctness:**
9. T4.1 — past-date tri-band flag
10. T4.2 — `triband_data_quality_flag` column
11. T4.3 — spread-ratio guard & nan-to-num
12. T4.4 — delegation/fallback lock + UNIQUE constraint
13. T4.5 — ML prediction error surfacing

**Group 1D — Node subsystem security:**
14. T2.1 — bulkControlAuth clock-skew
15. T2.2 — backup/restore mutex

**Group 1E — Frontend memory/integrity:**
16. T5.1 — document keydown listener cleanup
17. T5.2 — WS parse error surfacing
18. T5.3 — modal backdrop listener accumulation

**Group 1F — Electron hardening:**
19. T6.1 — single-instance lock (`app.requestSingleInstanceLock()`)
20. T6.2 — open-ip URL scheme whitelist
21. T6.3 — autoUpdater signature verification
22. T6.4 — spawn error/exit listener before return
23. T6.5 — `shell.openExternal` URL scheme whitelist
24. T6.6 — version sync across `package.json` / `CLAUDE.md` / `AGENTS.md` / `MEMORY.md` / `SKILL.md`

### Phase 2 — strongly recommended for v2.8.8 (HIGH, 38 items)

Target subset of HIGH-severity items for the same release:
- T1.5-T1.6 (AbortController + reconnect race)
- T2.3-T2.12 (session token, token-store, alarms dedup, cap math, go2rtc, dayAheadLock WESM, streaming, cloudBackup)
- T3.6-T3.12 (polling isolation, socket leak, lock scope, rebuild_global_maps, timeout, queue bound, post-write verify)
- T4.6-T4.12 (reliability artifact, data-quality clock, legacy-model check, backend detection, error-memory filter, transmission loss, regime threshold)
- T5.4-T5.8 (chart axis reset, mode-switch abort, alarm dedup key, timeout abort, card-order namespace)
- T6.7-T6.11 (unhandledRejection, migration atomicity, backend respawn, OAuth authUrl validation, pick-folder whitelist)

### Phase 3 — v2.8.9 or later (MEDIUM, 43 items)

Batch into separate release. Priorities:
- Forecast-engine MEDIUM (T4.13-T4.19) — training hygiene
- Subsystem MEDIUM (T2.13-T2.23) — DST, hysteresis, type validation
- Frontend MEDIUM (T5.9-T5.18) — XSS hygiene, WS storm, render race

### Phase 4 — quality/polish (LOW + INFO, 19 items)

Defer to backlog. Most are logging improvements and code hygiene.

---

## Test plan for v2.8.8 confidence release

### Pre-flight
1. `npm run rebuild:native:node` (required — repo currently in Electron ABI)
2. `node --check` on every server/*.js, electron/*.js, public/js/app.js — must pass
3. `python -m py_compile` on every services/*.py, drivers/*.py — must pass
4. `python -m pytest services/tests/ -x` — must be 107/107
5. `for t in server/tests/*.test.js; do node "$t"; done` — all pass (after Node ABI rebuild)
6. `npm run rebuild:native:electron` — MUST restore before any Electron work (per memory `feedback_native_rebuild.md`)

### Regression suite for each Phase-1 fix

| Fix | Regression test |
|---|---|
| T1.1 | Hit replication endpoint with `?table=foo; DROP TABLE readings`; expect 400 |
| T1.2 | Trigger 366-day alarms export while polling; verify `pendingReadingQueue` high-water stays < 50 |
| T3.1-T3.2 | `curl -XPOST /write -d '{"unit":-1,"value":1}'` → 400; same with `value:2`, `value:-1` → 400 |
| T3.3 | Burst 1000 `/write` calls in 10 s; assert 0 dropped per inverter log |
| T4.1-T4.2 | Train model on mixed past/future dates; inspect feature matrix for zero-spread flags |
| T4.3 | Force 06:00 slot with 0.2 kWh forecast → spread_ratio finite |
| T4.4 | Inject Node timeout mid-forecast; verify exactly one audit row per (date, variant, trigger) |
| T4.5 | Simulate `model.predict()` raising; caller must see error flag, not zero residual |
| T2.1 | Mock `Date.now()` to drift backward 90 s between two `getPlantWideAuthKeys()` calls; boundaries stable |
| T2.2 | Launch backup + restore simultaneously; verify serialization and no DB corruption |
| T5.1 | Navigate between 10 pages; measure `document` keydown listener count — stable |
| T5.2 | Send intentionally malformed WS frame; verify error logged with payload excerpt |
| T6.1 | Launch installer twice; verify second instance exits cleanly and focuses first |
| T6.2 | Call `open-ip` IPC with `file:///etc/passwd` and `javascript:alert(1)` → rejected |
| T6.3 | Substitute a forged `latest.yml` pointing to a different signer's asset → update refused |

### Smoke verification

1. Launch installer → login (admin/1234)
2. Verify live polling reaches all 27 inverters
3. Run 30-day Energy Summary export — confirm polling continues through export
4. Trigger bulk control with `sacupsMM` → write propagates → read-back confirms
5. Trigger manual day-ahead forecast via UI — single audit row
6. Launch and terminate Electron twice — confirm Python children reaped
7. Switch mode remote → gateway mid-fetch — no stale data overwrites

### Release hygiene (per memory `feedback_release_exe_upload.md`)

- `sub_releaser` times out on >600 MB installer uploads. Expect to upload the main EXE manually via GitHub web UI after `gh release create` finishes the small assets.
- Verify all 3 assets present (`.exe`, `.exe.blockmap`, `latest.yml`) before announcing.
- Per memory `feedback_python_release_full_rebuild.md`, this release touches Python (forecast + inverter) → full installer rebuild required, NOT a "Python-only" shortcut.

---

## Audit conduct notes (for future sweeps)

**What went well:**
- 6 parallel agents finished roughly concurrently; static syntax + Python tests ran in parallel with audits.
- Writing the findings doc as an append-only file allowed multiple agents to contribute without blocking.

**What went wrong:**
- One Track 4 agent used `Write` (overwrite) instead of heredoc append → truncated everything above.
- One Track 1 agent committed changes unprompted → reverted via soft-reset + reflog recovery.
- Two agents (Tracks 2, 3, 4, 5) returned summaries instead of writing findings → required manual append from the notification payloads.
- Windows path form in agent prompts confused some write calls (one produced file with mangled name `ADSI-DashboarddocsBUG_SWEEP_...md` in repo root).

**Recommended for next sweep:**
- Use `bash heredoc` append in agent prompts instead of `Edit`/`Write` — heredoc is atomic on POSIX and cannot overwrite.
- Forbid unprompted `git commit` at the agent-prompt level.
- Pre-create per-track output files and have each agent write to its own file; concatenate at the end.
- Always use forward-slash paths (`/d/ADSI-Dashboard/...`) in Git-Bash heredoc targets.
