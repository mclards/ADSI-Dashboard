# Daily Data Export — Gap Fixes (Verification Round 2)

**Date:** 2026-04-28
**Status:** Closed — all P0 + P1 gaps from the parallel verification addressed; tests green.
**Triggered by:** `/orchestrate` parallel verification of the v2.10.x Daily Data Export pipeline.
**Predecessor:** [audits/2026-04-28/v2102beta2-verification-gap-fixes.md](audits/2026-04-28/v2102beta2-verification-gap-fixes.md) (filename alignment + first-round audit).

---

## 1. Gap List (from the three parallel agents)

| # | Severity | Gap |
|---|---|---|
| 1 | P0 | **No operator-facing slot-gap detection.** Daily Data Export silently emits fewer rows when an inverter was offline mid-day; partial days are indistinguishable from complete days unless the operator counts rows by hand. |
| 2 | P0 | **`temp_c` is permanently NULL** in `inverter_5min_param` because the carrying register is unmapped — undocumented behavior that surprises operators. |
| 3 | P1 | **Zero unit tests** for `dailyAggregator.js` — slot math, range gates, reaped-slot LRU, out-of-order rejection, day rollover, parcE monotone gate, and offline-skip logic could all silently regress. |
| 4 | P1 | `/api/system/heartbeat` only exposes 8 of the 13 aggregator counters — operator can't see drop-sample reasons (offline, stale_ts, future_ts, oo_order, reaped_slot, no_unit, field_clamp). |
| 5 | P1 | **No unit test for the `_hwDeltasForUnitDay` close-out paths** — covered by the prior audit's `hwCounterDeltaCore.test.js`, no further action needed. |
| 6 | P2 | Stream cancellation cleanup — partial `.xlsx` files when the HTTP socket closes mid-stream. Deferred (would need full integration harness). |
| 7 | P2 | HTTP 423 today-lock integration test. Deferred (would need supertest + clock mock). |

---

## 2. Resolution Summary

### P0-1 — Operator-facing slot-gap detection ✅

New pure-function module + DB-backed wrapper + REST endpoint:

| Layer | File | Change |
|---|---|---|
| Pure math | [server/dailyAggregatorCoverage.js](server/dailyAggregatorCoverage.js) | NEW (~155 lines) — `expectedSolarWindowSlots()`, `slotIndexToHHMM()`, `compressSlotRuns()`, `computeSlotCoverage()` |
| Pure tests | [server/tests/dailyAggregatorCoverage.test.js](server/tests/dailyAggregatorCoverage.test.js) | NEW — 15 regression scenarios |
| DB wrapper | [server/dailyAggregator.js](server/dailyAggregator.js) | Added `getSlotCoverage(ip, slave, dateLocal)` — queries `inverter_5min_param` and feeds the pure core |
| REST endpoint | [server/index.js:13068-13103](server/index.js#L13068-L13103) | NEW `GET /api/params/:inverter/:slave/coverage/:date` with input validation, IP resolution, remote-mode proxy |

**Response shape** (operator-readable, ranges as plant-local HH:MM):

```json
{
  "ok": true,
  "inverter": 1,
  "inverter_ip": "192.168.1.10",
  "slave": 1,
  "date_local": "2026-04-28",
  "expected": 156,
  "present": 150,
  "missing": 6,
  "coveragePct": 0.9615,
  "missingSlots": [96, 97, 98, 99, 100, 101],
  "missingRuns": [
    { "startSlot": 96, "endSlot": 101, "startHHMM": "08:00", "endHHMM": "08:30" }
  ],
  "status": "partial",
  "solar_window_start_hour": 5,
  "eod_snapshot_hour_local": 18,
  "slot_minutes": 5
}
```

`status` is `complete` (all slots present), `partial` (some missing), or `empty` (zero present or degenerate window). Outside-window slots in the input are silently dropped — operators never see "157 of 156" because of a clock-skewed 04:55 row.

### P0-2 — `temp_c` road-to-resolution ✅

Three coordinated documentation updates so the design intent is recorded everywhere it matters:

| File | Update |
|---|---|
| [services/inverter_engine.py:1127-1144](services/inverter_engine.py#L1127-L1144) | Expanded the inline FIXME from 3 lines to 17 — names the three candidate sources, the trade-offs, and the road to populating the column when (1) is identified. |
| [server/dailyAggregator.js:39-46](server/dailyAggregator.js#L39-L46) | Added a header note alongside the existing Track Alarms note so the aggregator's design contract is self-describing. |
| [docs/ADSI-Dashboard-User-Manual.md §6.5 + §6.8.2](docs/ADSI-Dashboard-User-Manual.md) | `Temp` column row reads "Blank by design in v2.10.x — see §6.8.2"; §6.8.2 describes the road-to-resolution. |
| [docs/ADSI-Dashboard-User-Guide.html §14](docs/ADSI-Dashboard-User-Guide.html) | Mirrored bullet under Daily Data Export (v2.10.x). |

### P1-3 — `dailyAggregator` regression tests ✅

| File | Change |
|---|---|
| [server/tests/dailyAggregatorCore.test.js](server/tests/dailyAggregatorCore.test.js) | NEW — 18 scenarios covering slot math, solar window, offline-skip, stale-ts gate, future-ts gate, no-unit drop, range gate (single-field reject), parcE monotone, out-of-order, slot rollover, reaped-slot guard, reaped-slot LRU bound, day rollover, `flushAll`, in_solar_window stamping, and aggregated row shape (averages + LATEST parcE + bitwise OR alarms). |

The tests use a stub `db.prepare()` that captures rows, avoiding the `better-sqlite3` ABI gate documented in `CLAUDE.md`. They run under raw Node — no Electron rebuild required.

Notable test design choice: time-anchored tests use a `midSlotNow()` helper that snaps `Date.now()` to **60 s into the current 5-min slot**, leaving ±60 s of headroom for the ±5-min sanity gates and the slot-boundary arithmetic. Without this, the suite would be flaky if run during the last 10 s of a slot.

### P1-4 — Heartbeat exposes every aggregator counter ✅

[server/index.js:12214-12241](server/index.js#L12214-L12241) — added 11 new fields under `aggregator.*`:

```text
samplesDroppedOffline      ← inverter reported online=0 + zero readings
samplesDroppedStaleTs      ← ts > 5 min in the past
samplesDroppedFutureTs     ← ts > 5 min in the future (clock skew)
samplesDroppedOoOrder      ← out-of-order within current slot
samplesDroppedReapedSlot   ← late sample for already-flushed slot
samplesDroppedNoUnit       ← missing source_ip or unit field
fieldClampCount            ← individual fields rejected by range gate
bucketsOpened              ← lifetime bucket creation count
reaped                     ← slots force-flushed by reaper
shutdownFlushes            ← buckets persisted at shutdown
reapedSlotMemory           ← current size of reaped-slot LRU (bound 256)
```

Every counter is monotonically increasing since process start. External monitors (operator UI, Prometheus exporter, /loop checks) can now alert on dropped-sample rates without scraping `/api/params/diagnostics`.

### P2 items (deferred)

- Stream cancellation cleanup (partial `.xlsx` files): would need a full integration harness driving `ExcelJS.WorkbookWriter` against a mock fs. Not worth the harness complexity in v2.10.x — the operator can simply re-run the export and any orphan file will be overwritten by the next run with the same filename.
- HTTP 423 today-lock integration test: covered by manual smoke; would need supertest + clock mocking to lock down. Recommend if/when the lock logic is touched.

---

## 3. Files Changed

| File | Change | Lines |
|---|---|---|
| [server/dailyAggregatorCoverage.js](server/dailyAggregatorCoverage.js) | NEW pure module | +155 |
| [server/tests/dailyAggregatorCoverage.test.js](server/tests/dailyAggregatorCoverage.test.js) | NEW — 15 scenarios | +175 |
| [server/tests/dailyAggregatorCore.test.js](server/tests/dailyAggregatorCore.test.js) | NEW — 18 scenarios | +315 |
| [server/dailyAggregator.js](server/dailyAggregator.js) | + `getSlotCoverage()` wrapper, header note for `temp_c` | +60 |
| [server/index.js](server/index.js) | + `GET /api/params/.../coverage/:date` route, expanded heartbeat aggregator block | +50 |
| [services/inverter_engine.py](services/inverter_engine.py) | Expanded `temp_c` FIXME with road-to-resolution | +14 |
| [docs/ADSI-Dashboard-User-Manual.md](docs/ADSI-Dashboard-User-Manual.md) | Updated §6.5 Temp column note + new §6.8.2 gap-detection block | +60 |
| [docs/ADSI-Dashboard-User-Guide.html](docs/ADSI-Dashboard-User-Guide.html) | Mirrored gap-detection block in Section 14 | +12 |

No production behavior change in the existing aggregator code — the `getSlotCoverage()` addition is read-only and additive.

---

## 4. Test Status

| Test | Status | Notes |
|---|---|---|
| `dailyAggregatorCoverage.test.js` | ✅ 15/15 PASS | NEW — locks slot-coverage rules |
| `dailyAggregatorCore.test.js` | ✅ 18/18 PASS | NEW — locks aggregator behavior end-to-end |
| `hwCounterDeltaCore.test.js` | ✅ 15/15 PASS | Adjacent — verified no regression |
| `energySummaryScaleCore.test.js` | ✅ PASS | Adjacent — verified no regression |
| Other 30+ pure-function tests | ✅ PASS (unchanged) | |
| Better-sqlite3 ABI-bound tests | ⚠ Skipped | Native module currently built against Electron ABI per project rule. |

Syntax checks (`node --check`) clean for: `server/exporter.js`,
`server/dailyAggregator.js`, `server/dailyAggregatorCoverage.js`,
`server/index.js`, both new test files, `services/inverter_engine.py`
(`python -m py_compile`).

---

## 5. Operator Workflow Impact

**Before this round:**
- Open Daily Data Export → pick inverter + date → workbook generates → no idea if it's complete → operator counts rows by hand or trusts the file blindly.

**After this round:**
- Open `GET /api/params/1/1/coverage/2026-04-28` → see `coveragePct: 0.9615, missingRuns: [{08:00–08:30}]` → know the day is partial before opening the workbook.
- Or: `GET /api/system/heartbeat` → see `aggregator.samplesDroppedStaleTs: 1247` → know the gateway has a clock-skew problem affecting capture quality across many days.

UI surfaces for these endpoints (chip on the Parameters page, status hint in the Daily Data Export card) are out of scope for this audit but the data is now available behind stable contracts.

---

## 6. Sign-Off

- ✅ All P0 gaps closed: gap detection live, `temp_c` documented in code + manual.
- ✅ All P1 gaps closed: 33 new test scenarios across 2 files; heartbeat exposes every aggregator counter.
- ✅ User Manual + User Guide HTML synchronized.
- ⚠ P2 (stream cancellation cleanup, today-lock integration test) deferred — manual smoke recommended before stable promotion.
- ⚠ User Guide PDF regeneration runs from the updated MD via the project's normal doc pipeline; not part of this change.
- ⚠ `npm run smoke` full Electron-ABI sweep still pending — recommend running before publishing.

**Recommendation:** SHIP — Daily Data Export is now operator-aware (gap detection) and regression-locked (33 new test scenarios). The pipeline can be promoted from beta to stable once the smoke sweep clears on hardware.
