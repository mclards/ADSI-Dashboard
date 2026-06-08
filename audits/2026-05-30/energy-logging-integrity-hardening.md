# Energy-Logging Data-Integrity Hardening Review

Date: 2026-05-30
Status: AUDIT + PARTIAL IMPLEMENTATION. Tier 0.1 (restart energy recovery) and Tier 1.1 (chunked `buildPacEnergyBuckets`) implemented 2026-05-30 — see §8. Tier 1.2/1.3 + Tier 2/3 still queued. All file:line refs verified against `main` HEAD at audit time (2026-05-30 ~22:30 local); §8 reflects post-change line numbers.
Scope: the operator-reported symptom "dashboard freezes and loses data, especially energy logging." Two distinct problems are separated below: (1) what makes it **freeze**, and (2) what is **lost** when a freeze ends in a non-graceful kill.
Supersedes nothing. Builds directly on `audits/2026-05-11/db-read-write-health.md` — re-checks which of that audit's action items actually landed.

---

## 0. TL;DR

- The freeze and the data loss are **two separate failures that compound**. Hardening one without the other leaves the symptom in place.
- **Energy logging loses up to a full in-progress 5-minute slot, plant-wide, on every ungraceful exit.** `energy_5min` is written **once per slot at the 5-minute boundary** ([poller.js:1172](../../server/poller.js#L1172)) via a plain `INSERT` ([db.js:2214-2216](../../server/db.js#L2214-L2216)). Until the boundary crosses, the slot's energy lives **only in memory** (`energyBuckets` + `pacTodayByInverter`).
- The graceful-shutdown partial flush that was added to cover *clean* restarts ([poller.js:1880-1972](../../server/poller.js#L1880-L1972), called from [index.js:24237](../../server/index.js#L24237)) **cannot run during a freeze** — the event loop is the thing that is frozen, so a force-kill / OOM / power-loss skips it entirely.
- On restart, today's total is re-seeded by **summing `energy_5min`** ([poller.js:441](../../server/poller.js#L441)) — which is missing the lost slot. The raw `readings` rows needed to reconstruct it **were persisted every second and survive**, but the seed path never looks at them. **The data to recover the loss exists; nothing uses it.**
- The single strongest fix is therefore **restart-time re-integration from `readings`**, and the PAC-integration logic to do it **already exists** as `buildPacEnergyBuckets` ([index.js:11269-11294](../../server/index.js#L11269-L11294)). This is reuse, not new math.
- The freeze root cause flagged as **H1** in the 2026-05-11 audit (unbounded wide reads) is **still live** — `queryReadingsRangeAll` still only `console.warn`s ([db.js:4710-4733](../../server/db.js#L4710-L4733)) and is reached by two operator/midnight paths.

---

## 1. What already landed since 2026-05-11 (verified)

Re-checking the prior audit's action items against current code so we don't re-litigate solved problems:

| Prior item | Status | Evidence |
|---|---|---|
| LRU eviction for `ARCHIVE_DB_CACHE` (Tier 1 #2) | **DONE** | `ARCHIVE_DB_CACHE_MAX_ENTRIES = 6` + LRU touch/evict ([db.js:125-126](../../server/db.js#L125-L126), [db.js:4162-4216](../../server/db.js#L4162-L4216)); regression test `server/tests/archiveCacheLru.test.js`. Kills crash hypothesis **H2**. |
| Bounded persist queue + shed-visibility (new since audit) | **DONE** | `enqueueBounded` + `pendingReadingQueue`/`pendingEnergyQueue` with `DB_*_BACKLOG_MAX_ROWS` and an audit_log `persist_backlog_overflow` summary on recovery ([poller.js:1297-1403](../../server/poller.js#L1297-L1403)). Good: a sustained DB stall now sheds visibly instead of growing heap without bound. |
| Priority retry-on-busy for the **hot** path (Tier 1 #3, partial) | **DONE for poller** | 3× exponential backoff guarded against unhandled rejection ([poller.js:1383-1401](../../server/poller.js#L1383-L1401)). |
| Route the heavy reads through the chunked iterator (Tier 1 #1) | **NOT DONE** | `queryReadingsRangeAll` still materialises the full range ([db.js:4710-4733](../../server/db.js#L4710-L4733)). See §3. |
| Hard ceiling / enforced cap on `queryReadingsRangeAll` (Tier 2 #4) | **NOT DONE** | Still a `console.warn` only ([db.js:4714-4718](../../server/db.js#L4714-L4718)). |
| `unhandledRejection` should flush (Tier 2 #6) | **NOT DONE** | Still logs only ([index.js:24386-24388](../../server/index.js#L24386-L24388)). |
| Retry-on-busy for **secondary** writers (Tier 1 #3, rest) | **NOT DONE** (not re-verified exhaustively) | dailyAggregator / forecast / audit writers still mostly un-wrapped. |

Net: the **memory-growth** crash vector (H2) and the **silent-shed** blind spot were closed. The **event-loop-starvation** vector (H1) and the **energy-loss-on-kill** vector (this audit's focus) were not.

---

## 2. The energy-logging data-loss mechanism (core finding)

### 2.1 How a 5-minute slot is committed

`update5minBucket` ([poller.js:1155-1243](../../server/poller.js#L1155-L1243)) runs every persist tick, but:

```
if (bucketStart <= state.bucketStart) return;   // poller.js:1172
```

A row is pushed to `energy_5min` **only when the wall-clock 5-minute boundary is crossed**. The value written is the whole slot's increment, `kwh_inc = kwhNow − kwhStart` ([poller.js:1184](../../server/poller.js#L1184), [poller.js:1230-1235](../../server/poller.js#L1230-L1235)), and the writer is a plain insert, **not** an accumulating upsert:

```
insertEnergy5: INSERT INTO energy_5min(ts,inverter,kwh_inc) VALUES(?,?,?)   // db.js:2214-2216
```

So between boundaries the slot's energy exists **only** in two in-memory structures: `energyBuckets[inv].kwhStart` ([poller.js:1099](../../server/poller.js#L1099)) and the running `pacTodayByInverter[inv]` ([poller.js:166](../../server/poller.js#L166)). **Window of in-memory-only energy: up to ~5 minutes, for every inverter simultaneously.**

### 2.2 Why the existing shutdown flush does not save it

`flushPending` writes the in-progress slot as a `partialEnergyBatch` ([poller.js:1896-1971](../../server/poller.js#L1896-L1971)) and is invoked by `_flushAndClose` ([index.js:24237](../../server/index.js#L24237)). Its own comment — *"FIX: server restart was losing active bucket"* — shows the team already fixed this for the **graceful** case.

But every path to `flushPending` runs **on the event loop**:
- `gracefulShutdown` / `_runShutdownPhases` ([index.js:24270-24360](../../server/index.js#L24270-L24360)) — needs the loop to turn.
- `process.on('exit')` safety net ([index.js:24375-24377](../../server/index.js#L24375-L24377)) — only fires on an orderly `process.exit`, not on `SIGKILL` / OOM / power cut.

A **freeze** is, by definition, the event loop blocked for seconds. The classic kill sequence (2026-05-11 audit §6.4): Node stalls → Chromium IPC watchdog flags the renderer "unresponsive" → user hits **End Task** / OS kills it / it OOMs. None of those deliver a runnable graceful shutdown. **The partial flush is structurally unable to run in exactly the scenario the operator reports.**

### 2.3 Why restart does not recover it (even though it could)

On restart, `ensureTodayEnergyBaseline` ([poller.js:431-464](../../server/poller.js#L431-L464)) rebuilds today's total as:

```
seededDb = sumEnergy5minByInverterRange(dayStart, now)   // poller.js:441 — SUM of committed slots only
```

The lost in-progress slot was never committed, so it is absent from the sum and never re-added. Live integration then resumes *on top of* this seed — the gap is baked in permanently.

Crucially, the raw `readings` rows **were** persisted at the 1 s cadence right up to the moment of the freeze ([poller.js:1737-1754](../../server/poller.js#L1737-L1754)). The PAC trace needed to reconstruct the lost slot is sitting in the `readings` table. The seed path simply never integrates it.

### 2.4 Magnitude

Plant ≈ 1 MW. A lost 5-minute slot at full sun ≈ `1000 kW × (5/60) h ≈ 83 kWh` of **under-reported** daily energy, plant-wide, **per ungraceful exit**. At partial sun, proportionally less. This recurs on every freeze-kill and on every hard power event — exactly the "data loss especially on energy logging" the operator sees. It also silently biases ML day-ahead training (the missing slot reads as a real production dip).

---

## 3. The freeze itself (root cause, still live)

The data loss only happens because the process dies ungracefully; the thing that makes it die ungracefully is the freeze. From the 2026-05-11 audit, **H1 — event-loop starvation from a wide read — is still present**:

- `queryReadingsRangeAll` materialises the entire range into a heap `Map` then sorts ([db.js:4710-4733](../../server/db.js#L4710-L4733)); the only guard is a `console.warn` over 2 days. The route-level 366-day cap is the only real bound, and the comment explicitly accepts "the caller will OOM loudly."
- Live callers that bypass the safe chunked path:
  - `buildPacEnergyBuckets({ inverter: "all", … })` ([index.js:11269-11294](../../server/index.js#L11269-L11294)) — the operator-triggered PAC energy recompute (Energy/Analytics range, all-inverters).
  - `rebuildDailyReadingsSummaryForDate` ([db.js:5107-5112](../../server/db.js#L5107-L5112)) — full-day scan at midnight rollover and on demand; synchronous, no `_yieldEventLoop()`.
- A safe, chunked, archive-aware iterator already exists and is used by the exporter: `listReadingsRangeSources` ([db.js:4987](../../server/db.js#L4987), used at [exporter.js:1317-1322](../../server/exporter.js#L1317-L1322)).

Because `better-sqlite3` is synchronous and everything (Express, WS broadcast, poller, plant-cap, replication) shares one event loop, a multi-second materialise-and-sort blocks the poller's writes too — so the freeze and the energy-loss window open at the same instant.

Secondary contributors unchanged from the prior audit: `SQLITE_BUSY` on un-wrapped secondary writers during contention (**H3**), `unhandledRejection` logs-only ([index.js:24386-24388](../../server/index.js#L24386-L24388)), and the synchronous midnight rebuild (§3 bullet 2).

---

## 4. Hardening plan (prioritized by risk-reduction per unit of effort)

### Tier 0 — Make energy loss recoverable (highest value, lowest hot-path risk)

**0.1 — Restart-time re-integration of the uncommitted tail from `readings`.**
When `ensureTodayEnergyBaseline` seeds today, for the window between the last committed `energy_5min` slot and `now`, re-integrate PAC from persisted `readings` and write the missing `energy_5min` slot(s) before live integration resumes. Reuse `buildPacEnergyBuckets` ([index.js:11269](../../server/index.js#L11269)) — the per-bucket PAC trapezoid with the same `dtCapSec = 30` the live integrator uses, so totals reconcile exactly. This recovers everything up to the freeze onset with **zero hot-path cost** (runs once, at startup). Gate it on gateway mode and on "today only."
*Interaction:* respects the existing v2.9.x HW-counter crash-recovery seed (`seed_pac_from_baseline`) — PAC-from-`readings` covers the slot lost to the kill; HW Etotal covers any longer gap where polling itself stopped. Keep PAC authoritative per the CLAUDE.md invariant.

**0.2 — Provisional in-slot checkpoint (shrink the in-memory window).**
Periodically (e.g. every 30–60 s, off a `.unref()` timer) write the *running* value of the current slot so a hard kill loses ≤ the checkpoint interval instead of ≤ 5 min. Requires `energy_5min` to become an **upsert keyed on `(ts, inverter)`** that *replaces* (not adds) the slot's `kwh_inc`, so the boundary write and intermediate writes are idempotent. This is a schema/writer change — do it carefully and behind a test that asserts no double-count vs. the boundary writer. Lower priority than 0.1 because 0.1 already recovers the same data on restart; 0.2 mainly helps when `readings` themselves are thin (outside solar window / heartbeat-only).

### Tier 1 — Stop the freeze (prevents the kill in the first place)

**1.1 — Route the wide reads through the chunked iterator.** Convert `buildPacEnergyBuckets({inverter:"all"})` and `rebuildDailyReadingsSummaryForDate` to consume `listReadingsRangeSources` with a `yieldToEventLoop()` between shards (exporter pattern). Eliminates **H1** — the dominant freeze cause.
**1.2 — Add a real ceiling to `queryReadingsRangeAll`.** A row-count ceiling that throws a structured error the route layer degrades gracefully (e.g. "range too large, narrow it") — not a silent OOM. Belt-and-suspenders for any path missed by 1.1.
**1.3 — Make `unhandledRejection` flush** to match `uncaughtException` ([index.js:24386](../../server/index.js#L24386) → call `_flushAndClose()`), so a stray rejection during contention can't leave a slot un-flushed.

### Tier 2 — Self-heal + observability

**2.1 — Event-loop-lag watchdog.** Lag is already measured ([poller.js:1856-1861](../../server/poller.js#L1856-L1861)) but **nothing acts on it.** When `eventLoopLagMs` crosses a threshold (e.g. > 3 s) on consecutive ticks, proactively `flushPersistBacklog` + checkpoint the in-progress slot and emit an audit row. Turns a forming freeze into a near-real-time energy save.
**2.2 — Surface `eventLoopLagMaxMs`, `dbPersistDropped*Count`, `partialBucketFlushCount`** on the health endpoint + a UI chip so a degrading gateway is visible *before* it gets killed.
**2.3 — Retry-on-busy wrapper for secondary writers** (dailyAggregator, forecast, audit) — closes **H3**'s silent gaps.

### Tier 3 — Structural (larger lift, optional)

**3.1 — Move heavy historical reads off the main thread** (`worker_threads` for export/analytics range scans) so no operator click can ever stall the poller. Largest change; only if Tier 1 proves insufficient under real load.

---

## 5. Recommended first cut

Tier 0.1 + Tier 1.1 together remove the symptom: 1.1 stops the freeze that triggers the kill; 0.1 makes any kill that still happens (power loss, OOM) self-heal on restart from data already on disk. Both are additive, test-coverable, and touch the hot path minimally (0.1 is startup-only; 1.1 only changes read paths). 1.3 and 2.1 are cheap follow-ons. 0.2 and 2.3 are the second wave.

---

## 6. Verification targets (when implementing)

- New test: kill -9 simulation — seed `energy_5min` with a gap vs. a full `readings` trace for the same window, run the restart re-integration, assert the recovered daily total matches the `readings`-integrated total within rounding.
- New test: provisional checkpoint idempotency — N intermediate writes + 1 boundary write for the same slot must equal exactly one slot's true `kwh_inc` (no double-count).
- Existing guards to keep green: `bucket_spike_clip` / `recovery_seed_clip` classifier behavior ([poller.js:1184-1242](../../server/poller.js#L1184-L1242)), `archiveCacheLru.test.js`, smoke 85/85.
- Manual: drive `buildPacEnergyBuckets` over a 30-day all-inverter range before/after 1.1 and watch `eventLoopLagMaxMs`.

---

## 7. Cross-references

- `audits/2026-05-11/db-read-write-health.md` — H1/H2/H3 origin; this audit closes H2, re-opens H1 + the energy-loss vector it did not cover.
- CLAUDE.md "Hardware Counter Recovery + Clock Sync (v2.9.0)" invariant — PAC stays authoritative; HW counters are reconciliation/seed aids.
- Memory: `v292_recovery_seed_clamp.md`, `v291_eod_clean_and_energy_selector.md`, `project_db_health_audit_20260511.md`.
- Source of truth: energy commit [poller.js:1155-1243](../../server/poller.js#L1155-L1243); seed [poller.js:431-464](../../server/poller.js#L431-L464); shutdown flush [poller.js:1880-1972](../../server/poller.js#L1880-L1972); wide read [db.js:4710-4733](../../server/db.js#L4710-L4733).

---

## 8. Implemented 2026-05-30 (Tier 0.1 + Tier 1.1)

Shipped in this working tree (not yet committed — operator reviews commits by hand):

### 8.1 Tier 0.1 — restart recovery of today's lost energy slots
- **New** `recoverTodayEnergyFromReadings(nowTs)` in [server/db.js](../../server/db.js) (after `sumEnergy5minByInverterRange`). At gateway boot it re-integrates PAC from persisted `readings` into today's **completed** 5-min slots that are **missing** from `energy_5min`, then inserts only the missing `(inverter, slot_ts)` pairs in one transaction and writes an `energy_slot_recovery` audit row.
- **Wired** into the gateway branch of `applyRuntimeMode()` in [server/index.js](../../server/index.js), synchronously **before** `poller.start()`.
- **Safety (verified by test + adversarial review):**
  - Today-only + hot-DB-only → bounded; synchronous at boot is fine (runs once before serving).
  - **Completed slots only** (`bucketTs < floor(now/5min)*5min`); the in-progress slot is owned by the live poller → no duplicate-row / double-count race (note `energy_5min` has **no** `UNIQUE(ts,inverter)`, so the existence check is the idempotency guard).
  - Idempotent: only `(inverter, slot_ts)` pairs not already present are written; never overwrites an existing slot.
  - PAC trapezoid, 30 s dt cap (identical to `buildPacEnergyBuckets` / the live integrator) → a readings gap (the freeze window) adds no energy; no catch-up spike, no `classifyBucketInc()` clamp needed.
  - Gateway branch only → never runs in `remote` mode.
- **Residual (documented, accepted):** if a crash *and* restart both fall inside the **same** 5-min slot, that slot's pre-crash portion is still lost (it is treated as the in-progress slot and left to the live poller). This is strictly better than the prior behavior (the **entire** in-progress slot was always lost) and avoids the duplicate-row hazard that touching the current slot would create.

### 8.2 Tier 1.1 — chunked `buildPacEnergyBuckets`
- `buildPacEnergyBuckets` in [server/index.js](../../server/index.js) is now **async** and streams the range via `listReadingsRangeSources(s,e,invFilter)`, yielding the event loop between shards and every 5000 rows, instead of materializing the whole range via `queryReadingsRangeAll`. Its sole caller — the `/api/analytics/energy` route — is now `async` with a `try/catch` (Express 4 does not catch async rejections).
- **Parity:** numerically identical to the old materialize-then-loop for all realistic inputs — `nodeState` persists across shards, `listReadingsRangeSources` yields shards chronologically, and the per-node `ts > prev.ts` guard makes any archive/hot boundary-duplicate contribute 0 energy (so no per-row dedup `Set` is needed; heap stays `O(nodes+buckets)`).

### 8.3 Deferred (deliberate scope cut)
- **Tier 1.2** (`rebuildDailyReadingsSummaryForDate` → chunked): **not done.** It is a one-day-bounded (~100–300 ms) op and lives inside the synchronous `buildDailyReportRowsForDate`, which has **7 callers** (several in cron/scheduled contexts). Converting it to async ripples through the `daily_report` data path — disproportionate risk for the benefit. Queued as its own change.

### 8.4 Tests
- **New** [server/tests/energyRestartRecovery.test.js](../../server/tests/energyRestartRecovery.test.js): seeds a continuous PAC stream with exactly one missing completed slot, asserts (T1) gap-fill matches a reference integrator, (T2) a pre-existing slot is not overwritten, (T3) the in-progress slot is never touched, (T4) a second run recovers nothing and creates no duplicate rows. Green under the Node-ABI smoke harness.
- Full node smoke: pass (the only non-green entries are the two pre-existing libuv-teardown crashes documented in memory `smoke_libuv_teardown_crash.md`).
