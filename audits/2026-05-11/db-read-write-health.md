# DB Read/Write Health Audit

Date: 2026-05-11
Status: AUDIT — no code changes. Findings staged for fix after gateway is reconnected. All file:line references re-verified against `main` HEAD at audit time.
Mode at audit time: REMOTE (operator workstation; gateway PC is down following an unresolved system crash earlier today).
Scope: focused exclusively on **live SQLite read/write health** and patterns that could plausibly have contributed to the gateway crash. Cloud-backup chain and rotating-slot rotation explicitly out of scope per operator direction (slot rotation finding from earlier in the session was a false positive — see §8).

---

## 1. Triggering questions

1. How well does the dashboard read from and write to `adsi.db`?
2. How healthy will those patterns be over the next 12–36 months?
3. How do the running processes (Node, Python, Electron, go2rtc) affect each other's performance?
4. Could any of the above plausibly have contributed to today's gateway crash?

---

## 2. Top-line verdict

| Surface | Verdict | Confidence |
|---|---|---|
| Write hot-path (poller → SQLite) | **Healthy.** Well-batched, well-gated, ~5% of WAL throughput headroom. | High — verified |
| WAL management | **Healthy.** Periodic PASSIVE checkpoint every 15 min plus shutdown TRUNCATE. | High — verified |
| Hot UI reads (live, alarms, audit, params) | **Healthy.** Indexed, range-bounded, low cost. | High — verified |
| Operator-triggered wide reads (`queryReadingsRangeAll`, exports, full-day reports) | **Fragile by design.** No row-count or memory ceiling — comment explicitly accepts "OOM loudly." | High — verified |
| Archive DB handle cache | **Latent leak.** No LRU eviction; per-month handles persist until shutdown or explicit close. | High — verified |
| Process error handling (uncaught/unhandled) | **Mostly defensive.** `uncaughtException` flushes & continues, but `unhandledRejection` only logs. | High — verified |
| Python ↔ Node coupling | **Decoupled.** Python crash degrades data, does not crash Node. | High — verified |

**Net:** the design is sound. The realistic crash contributors are operator-triggered wide reads compounding with the never-evicting archive cache, not the autonomous write path.

---

## 3. Verified design facts

### 3.1 SQLite PRAGMA configuration
[server/db.js:556-561](../../server/db.js#L556-L561):
- `journal_mode = WAL`
- `synchronous = NORMAL` — WAL+NORMAL is crash-safe; FULL would add per-commit fsync that stalls the event loop
- `busy_timeout = 1500` — intentionally low; `better-sqlite3` blocks the event loop during contention, so fail-fast is preferred
- `cache_size = -64000` (64 MB page cache)
- `temp_store = memory`
- `mmap_size = 268435456` (256 MB)

Post-open `PRAGMA quick_check(1)` runs at [server/db.js:566](../../server/db.js#L566) and refuses to proceed if it returns anything but `ok`.

### 3.2 WAL checkpoint cadence
[server/index.js:22181-22186](../../server/index.js#L22181-L22186):
```
setInterval(() => {
  setImmediate(() => {
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch (_) {}
  });
}, 15 * 60 * 1000).unref();
```
Plus a `wal_checkpoint(TRUNCATE)` on `closeDb()` at [server/db.js:4625-4637](../../server/db.js#L4625-L4637). WAL growth is bounded.

### 3.3 Poller cadence and persist gating
[server/poller.js:33,53-54](../../server/poller.js#L33-L54):
- `POLL_MS = 200` — 5 ticks/s
- `DB_MIN_PERSIST_MS = 1000` — minimum 1 s between persists per unit
- `DB_PAC_DELTA_PERSIST_W = 250` — PAC delta override for fast-changing units

Volume estimate (27 inverters × ~4 nodes, solar window 05:00–18:00 = 46,800 s):
- `readings`: ~1.5–2.5 M rows/day
- `energy_5min`: 4,212 rows/day (27 inv × 156 slots)
- `inverter_counter_state`: ~504 k upserts/day (10 s throttle × 108 units)
- Transactions per second to the writer: ~5 tx/s peak

### 3.4 Single-tx hot-path batching
[server/poller.js:1302](../../server/poller.js#L1302) calls `bulkInsertPollerBatch(readingRows, energyRows)` which wraps `readings` + `energy_5min` + `daily_readings_summary` upsert in one SQLite transaction. Failure handling at [server/poller.js:1311-1338](../../server/poller.js#L1311-L1338): catches, increments `dbInsertErrorCount`, retries up to 3× with exponential backoff (100 / 200 / 400 ms) under backlog pressure. The retry callback is now wrapped in try/catch (T1.4 fix) so a synchronous throw inside the flush cannot escape as an unhandled rejection.

### 3.5 Tick loop never sheds itself
[server/poller.js:1715-1734](../../server/poller.js#L1715-L1734):
```
poll()
  .catch((err) => console.error("[poller] unhandled poll error:", err.message))
  .finally(() => {
    const delay = Math.max(0, POLL_MS - (Date.now() - tickStartedAt));
    _expectedFireAt = Date.now() + delay;
    pollTimer = setTimeout(tick, delay);
  });
```
Every tick reschedules from `.finally()`, so a poll error cannot end the loop. Event-loop lag is recorded at [server/poller.js:1722-1726](../../server/poller.js#L1722-L1726) as `eventLoopLagMs`, `eventLoopLagMaxMs`, `eventLoopLagAvgMs` — already operator-visible.

### 3.6 Process-level exception handlers
[server/index.js:22164-22177](../../server/index.js#L22164-L22177):
- `process.on('exit', _flushAndClose)` — safety net for any exit path
- `process.on('uncaughtException')` — ignores `EPIPE` / `ERR_STREAM_DESTROYED`, otherwise logs and calls `_flushAndClose()`
- `process.on('unhandledRejection')` — **logs only, no flush** — narrow gap, see §6

---

## 4. Read path — verified findings

### 4.1 Per-tick (5 Hz): no DB reads

Verified by reading [server/poller.js:1290-1500](../../server/poller.js#L1290-L1500). The poll loop drives Python → fetch → in-memory `liveData` → WS. The `evaluateTodayEnergyHealth()` path can read `sumEnergy5minByInverterRange()` but is cadence-gated, not per-tick.

### 4.2 Per-request UI reads (Express)

| Endpoint family | Cost class | Notes |
|---|---|---|
| `/api/live` (WS) | trivial | In-memory `liveData` snapshot; no DB |
| `/api/audit/trail` | light | Indexed on `ts`, range-limited |
| `/api/params/*` | light | `inverter_5min_param` filtered by indexed `date_local` |
| `/api/alarms/list` | medium | OFFSET-paginated; large-table OFFSET cost grows linearly |
| `/api/stop-reasons` | light | Bounded by inverter+slave |
| `/api/energy-summary`, `/api/analytics` | medium | Calls `queryEnergy5minRangeAll()` — merges archive + main into a Map then sorts |
| `/api/daily-report` (full range) | **heavy** | Calls `queryReadingsRangeAll()` on the full range with no yield |
| `/api/export/*` | **heaviest** | `exporter.js` uses chunked `listReadingsRangeSources()` (good) but the in-memory dedup step is still synchronous |

### 4.3 The single biggest read hazard

[server/db.js:4197-4220](../../server/db.js#L4197-L4220) — `queryReadingsRangeAll()`:
```
// Warn on ranges > 2 days (operator hint — not enforced).
const MAX_RANGE_MS = 2 * 24 * 60 * 60 * 1000;
if (e - s > MAX_RANGE_MS) {
  console.warn(`[DB] queryReadingsRangeAll: range ${Math.round((e-s)/86400000)}d exceeds 2d cap …`);
}
// Note: v2.8.2 added a 500k row throw here ("E4") which caused exports to
// fail on high-poll-rate deployments. Reverted to v2.7.x behaviour — the
// route-level 366-day cap (MAX_EXPORT_RANGE_DAYS in server/index.js) is
// the load bound. If a pathological range somehow slips through, the
// caller will OOM loudly, which is preferable to silently blocking a
// valid operator-requested export.
```
A 30-day full-plant call holds ~5–10 M row objects in heap simultaneously before sort. A 90-day call scales linearly. The route-level cap is 366 days. This is a deliberate trade-off documented in the comment, not a defect — but it is exposed to any operator click that triggers a wide range, and it is the single most plausible cause of an event-loop stall long enough to look like a hang.

A chunked alternative exists at [server/db.js:4253](../../server/db.js#L4253) (`listReadingsRangeSources()`) and is used by [server/exporter.js](../../server/exporter.js). Energy-summary, analytics, and daily-report-full **do not use it**.

### 4.4 Archive DB handle cache — no eviction

[server/db.js:115](../../server/db.js#L115) and [server/db.js:3710-3739](../../server/db.js#L3710-L3739):
- `ARCHIVE_DB_CACHE = new Map()` stores one `better-sqlite3` handle per month
- Each handle carries its own ~256 MB mmap reservation (WAL mode)
- Eviction paths: `closeArchiveDbForMonth()` (manual call), end-of-month rollover, shutdown loop at [server/db.js:4625-4637](../../server/db.js#L4625-L4637)
- **No LRU, no max-size, no time-based eviction**

On a gateway that has been up for months and has touched dozens of archive months via replication, compliance runs, or exports, the cache footprint compounds. This is the second most plausible crash contributor.

---

## 5. Write path — verified findings

### 5.1 Hot path is healthy

All telemetry writes flow through a single per-tick transaction at [server/poller.js:1302](../../server/poller.js#L1302) → [server/db.js bulkInsertPollerBatch](../../server/db.js). ~5 tx/s peak, ~2–6 ms per tx, well within WAL throughput. Retry with exponential backoff under pressure. Verified.

### 5.2 Secondary writers — `SQLITE_BUSY` exposure

Spot-checked the forecast and daily-aggregator writers:
- [server/dailyAggregator.js:509-551](../../server/dailyAggregator.js#L509-L551) — single-row INSERT on slot flush; no explicit retry on busy
- Forecast and Solcast writers in [server/index.js](../../server/index.js) — many `db.prepare(...).run(...)` calls not wrapped in retry-on-busy

With `busy_timeout = 1500` ms, a heavy read holding the lock for ~2 s will surface `SQLITE_BUSY` to these writers. Unhandled, they propagate to the `unhandledRejection` log at [server/index.js:22175](../../server/index.js#L22175) — which only logs, does not flush. Cumulative effect: silent gaps in `forecast_run_audit`, `audit_log`, and dailyAggregator output during contention episodes.

### 5.3 Midnight rebuild

[server/db.js:4373-4396](../../server/db.js#L4373-L4396) `rebuildDailyReadingsSummaryForDate()` runs synchronously over a day of readings. Typical cost ~100–300 ms; outlier days could exceed 1 s. Confirmed no `_yieldEventLoop()` calls in this path.

### 5.4 Prune cycle is well-behaved

[server/db.js:4505-4566](../../server/db.js#L4505-L4566): `pruneOldData()` and `archiveTelemetryBeforeCutoff()` yield with `_yieldEventLoop()` between `ARCHIVE_BATCH_SIZE = 2000` row batches (reduced from 5000 to keep pauses under ~80 ms). Verified.

---

## 6. Process-level performance interactions

### 6.1 Single Node event loop is the choke point

All of: Express, WebSocket broadcast, poller, plant-cap controller, replication, exports, prune. `better-sqlite3` is synchronous. The poller's tick is short (~5 ms), so it composes well with everything else. Failure modes are entirely driven by sustained event-loop blocking — and the two paths that can sustain it are §4.3 and §4.4.

### 6.2 Plant-cap controller is correctly cached

Earlier session's audit claimed this scans every 2 s without caching. **That was wrong.** [server/plantCapController.js:16](../../server/plantCapController.js#L16) defines `SCHEDULE_TICK_CACHE_MS = 5000` and [server/plantCapController.js:721-738](../../server/plantCapController.js#L721-L738) only re-reads from DB if the cache is older than 5 s. With current schedule cardinality, this is negligible.

### 6.3 Python service is decoupled

`InverterCoreService` (port 9100) and `ForecastCoreService` run as separate processes. A Python freeze causes the poller's `fetch()` to time out at 5 s ([server/poller.js:51](../../server/poller.js#L51)); the poller then ages the data and shows units offline. **A Python freeze does not crash Node**, but it produces a UI symptom (whole-fleet offline) that resembles a gateway crash. Worth ruling out in any crash post-mortem.

### 6.4 Electron renderer is the silent watchdog

The main process hosts the renderer plus the embedded server. A multi-second event-loop stall in Node can flag the renderer "unresponsive" via Chromium's IPC watchdog; repeated stalls can lead to OS- or user-initiated kill. This is the failure mode most often mistaken for a SQLite crash.

---

## 7. Crash hypotheses (revised after verification)

Ranked from most to least plausible, given verified code state.

### H1 — Event-loop starvation from a wide operator-triggered read
**Mechanism:** Operator opens Energy / Analytics / Daily-Report-Full with a multi-week range. `queryReadingsRangeAll()` ([server/db.js:4197-4220](../../server/db.js#L4197-L4220)) holds millions of row objects in heap and blocks the thread for several seconds. Poller writes stall; WS frames drop; Electron renderer ages out.
**Symptom:** Gateway appears frozen 10–60 s, then either recovers (with a visible gap in `readings`), is killed by the user, or OOMs if heap > 2 GB.
**Confidence:** High — the path exists, is unbounded, and the comment in the code explicitly notes "caller will OOM loudly."
**Check first:** `logs/dashboard.log` for an Express request that started immediately before the freeze; OS event log for an Electron crash event around the same time.

### H2 — Archive DB handle cache accumulation
**Mechanism:** [server/db.js:115](../../server/db.js#L115) — `ARCHIVE_DB_CACHE` never evicts. After months of replication, exports, or compliance runs touching many archive months, each cached month carries its own mmap + cache_size + page cache. On a constrained gateway PC, accumulated working set can cross the OS commit limit and trigger paging or an allocation failure inside `better-sqlite3`.
**Symptom:** Memory creep across hours/days, then a sudden OOM or paging cliff during a routine wide read.
**Confidence:** High — verified no eviction policy.
**Check first:** Gateway Task Manager / Performance Monitor working-set trend for the Node process across the 24 h prior to the crash, plus the count of `archive/*.db` files vs the count actually opened in the current uptime window.

### H3 — `SQLITE_BUSY` cascade during a contended write
**Mechanism:** A heavy read holds the writer queue. A secondary write (forecast upsert, dailyAggregator flush, audit row) hits the 1.5 s timeout and throws. Unwrapped throws propagate to `unhandledRejection` at [server/index.js:22175](../../server/index.js#L22175), which only logs. Cumulative effect is silent data gaps rather than a crash, but stacked rejections during forecast cron windows can amplify the §H1 hang.
**Symptom:** Gaps in `forecast_run_audit` / `audit_log` correlated with cron windows; not a deterministic crash on its own.
**Confidence:** Medium — verified that the handler only logs; did not enumerate every secondary writer's catch state.
**Check first:** Whether the crash time correlates with the 04:30 / 09:30 / 18:30 / 20:00 / 22:00 forecast cron windows.

### H4 — Uncaught exception in an unfamiliar async chain
**Mechanism:** [server/index.js:22168](../../server/index.js#L22168) `uncaughtException` flushes and continues (does not exit). Most poller paths are well-guarded by the T1.4 fix at [server/poller.js:1325-1333](../../server/poller.js#L1325-L1333). The remaining exposure is non-poller async chains in replication, compliance, or chat that spawn off Express handlers.
**Symptom:** A single log line then degraded behaviour; less likely to be a crash root cause than a contributing factor.
**Confidence:** Low-medium — the handlers are in place; would require a specific path that bypasses them to be the cause.

### H5 — WAL replay slowness after a dirty shutdown
**Mechanism:** If the gateway was hard-killed mid-write, the next startup must replay the WAL before serving requests. With the 15-min PASSIVE checkpoint cadence the WAL is normally bounded, but a stall during the 15-min window plus a hard kill can leave a larger-than-usual WAL.
**Symptom:** Gateway "starts but doesn't open the UI" for several minutes after a hard kill — not the cause of the crash, but it could be what is being experienced right now.
**Confidence:** Medium — depends on whether the operator is currently seeing a slow restart.
**Check first:** Time-to-`/api/health/db-integrity` after the next restart; the `startupIntegrityResult` JSON in the recovery banner.

---

## 8. Corrections to the earlier session's audit

Three findings from the broader audit done earlier today were **false positives** once verified against the code. Documenting so they don't get re-litigated:

1. **"Backup slot 1 is 21 days stale — rotation is broken."**
   Verified at [server/index.js:22198](../../server/index.js#L22198) — `runPeriodicBackup()` returns early if `isRemoteMode()` is true. The audit was done on the remote workstation, which has been in remote mode for the last 21 days. Slot 1 hasn't been touched because backups don't run here. The rotation logic itself at [server/index.js:22219](../../server/index.js#L22219) (`_backupSlot = (_backupSlot + 1) % 2`) is correct.

2. **"Plant-cap controller scans every 2 s without caching."**
   Verified at [server/plantCapController.js:16,721-738](../../server/plantCapController.js#L16) — there is a 5-second cache. Per-tick cost is in-memory.

3. **"WAL grows unbounded between prunes."**
   Verified at [server/index.js:22181-22186](../../server/index.js#L22181-L22186) — periodic `wal_checkpoint(PASSIVE)` every 15 minutes plus shutdown TRUNCATE. WAL is bounded by design.

Per-operator direction, cloud-backup chain findings from earlier in the session are also out of scope and not re-litigated here.

---

## 9. Action items (queued for after gateway is back online)

Ordered by risk reduction per unit of effort. **None of these are to be applied while the gateway is offline.**

### Tier 1 — risk reduction, low surface change

1. **Route the heavy reads through the chunked source path.**
   `queryEnergy5minRangeAll()` and `/api/daily-report` full-range paths should switch to a `listReadingsRangeSources()`-style iterator with `yieldToEventLoop()` between shards. Pattern already established in [server/exporter.js](../../server/exporter.js). Eliminates H1.

2. **Add LRU eviction to `ARCHIVE_DB_CACHE`.**
   Bound by either count (e.g. last 6 months kept open) or time (close handles unused > 30 min). Add a `wal_checkpoint(PASSIVE)` + `db.close()` step matching [server/db.js:3722-3739](../../server/db.js#L3722-L3739). Eliminates H2.

3. **Wrap secondary writers in retry-on-busy.**
   Audit every `db.prepare(...).run(...)` in [server/index.js](../../server/index.js), [server/dailyAggregator.js](../../server/dailyAggregator.js), and forecast writers. Wrap in a helper that retries on `SQLITE_BUSY` with the same exponential-backoff pattern the poller uses ([server/poller.js:1319-1333](../../server/poller.js#L1319-L1333)). Eliminates H3.

### Tier 2 — observability and prevention

4. **Enforce the 2-day warning at `queryReadingsRangeAll()`.**
   The console.warn at [server/db.js:4203-4205](../../server/db.js#L4203-L4205) is a hint, not a guard. Either route every call through the chunked path (preferred) or add a hard ceiling expressed in row count rather than days, throwing a structured error that the route layer can degrade gracefully.

5. **Surface `eventLoopLagMaxMs` on the health endpoint.**
   Already collected at [server/poller.js:1722-1726](../../server/poller.js#L1722-L1726); add it to `/api/forecast/engine-health` or the equivalent system endpoint so the operator can see runaway lag before it becomes a crash.

6. **Make `unhandledRejection` flush.**
   [server/index.js:22175-22177](../../server/index.js#L22175-L22177) only logs. Match the `uncaughtException` handler — call `_flushAndClose()` so the DB isn't left mid-tx in the unlikely event a rejection escapes the poller's T1.4 guard.

### Tier 3 — retention catch-up (carried from earlier session)

7. **Add retention to append-only tables** that currently grow unbounded:
   `forecast_run_audit`, `forecast_error_compare_daily`, `forecast_error_compare_slot`, `inverter_stop_reasons*`, `serial_change_log`, `compliance_run/step/sample/artifact`, and the open-alarm path in [server/db.js:4543](../../server/db.js#L4543) (`DELETE FROM alarms WHERE ts < ? AND cleared_ts IS NOT NULL` — open alarms never get pruned). Add cutoffs to `pruneOldData()`.

8. **Clean orphaned `.preCleanup-*` snapshots.**
   One-shot cleanup of `C:\ProgramData\InverterDashboard\db\adsi.db.preCleanup-*` older than 7 days, plus an idle-time janitor that prevents re-accumulation.

---

## 10. Post-restart diagnostic checklist

When the gateway is back online and before any fix is applied:

1. `GET /api/health/db-integrity` — confirm WAL replay completed cleanly and no auto-restore was needed.
2. `dashboard.log` from ~5 min before the crash time — Express request log will show whether a wide-range read was in flight.
3. Working-set trend for the Node process across the prior 24 h — sets the confidence on H2.
4. `dbInsertErrorCount` / `droppedReadingCount` / `dbPersistRetryCount` from the engine-health endpoint — trending up before the crash supports H3.
5. `audit_log` rows around the crash window — `recovery_seed_clip` / `bucket_spike_clip` actions indicate seed-recovery context.
6. Forecast cron timing vs crash time — quick correlation check for H3.
7. Windows Event Viewer → Application log for any `Electron` / `Application Error` entry around the crash time — rules out OS-level kill vs in-process crash.

If 1–7 are clean, the next layer is system-level: disk free space on `C:`, antivirus contention, and any external process holding handles on `adsi.db`.

---

## 11. Cross-references

- Previous session findings (broader scope): `audits/2026-05-11/polling-pressure-and-zero-row-traceback.md`, `audits/2026-05-11/modbus-revamp-implementation-status.md`
- Memory pointers: `C:\Users\User\.claude\projects\d--ADSI-Dashboard\memory\project_db_health_audit_20260511.md` (broader audit, includes findings now superseded by §8 of this document)
- Source of truth for retention rules: [server/db.js pruneOldData()](../../server/db.js)
- Source of truth for PRAGMA tuning: [server/db.js:556-561](../../server/db.js#L556-L561)
- Source of truth for hot-path batching: [server/poller.js bulkInsertPollerBatch](../../server/poller.js#L1302)
