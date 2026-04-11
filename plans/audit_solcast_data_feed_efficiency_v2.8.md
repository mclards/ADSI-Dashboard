# Solcast Data Feed Efficiency Audit — v2.8

**Date:** 2026-04-11
**Scope:** Efficiency of data-feed utilization from Solcast → forecast engine → ML error correction
**Companion doc:** `plans/audit_solcast_data_feed_reliability_v2.8.md`

Reliability fixes (R1-R6) landed first because correctness always beats speed.
This audit assumes those are in place and focuses on **hot-path waste**:
redundant DB reads, redundant function calls, and unnecessary SQLite churn
during a single forecast cycle.

---

## Executive Summary

| # | Finding | Severity | Impact | Fix Effort |
|---|---------|----------|--------|------------|
| E1 | `load_solcast_snapshot` called 90+ times per full training/reliability cycle | High | ~450-900 ms wasted per regen | Medium |
| E2 | `solar_geometry(day)` / `clear_sky_radiation(day, rh)` recomputed every call, no memoization | High | ~15-25% of build_features CPU | Low |
| E3 | `fetch_weather(day, source="archive")` re-parses same CSV up to 3× per cycle | Medium | ~200-400 ms wasted | Low |
| E4 | `_open_sqlite` opens fresh connection for every read helper (24+ per cycle) | Medium | ~100-300 ms connection churn | Medium |
| E5 | Snapshot history append round-trips DB via `getSolcastSnapshotDay` per day after write | Low | ~20-60 ms, N/A on non-WAL | Low |
| E6 | `compute_error_memory` slot query issued per-day (N+1 on run_audit_id) | Low | ~50-120 ms on 45-day window | Low |
| E7 | PRAGMA cache_size / mmap_size unset — sqlite uses 2 MB default | Low | Page churn on 45-day scans | Trivial |

Cumulative wall-clock saving on a full `run_dayahead` cycle (training + reliability + QA): estimated **1.2-2.0 s** on the current dev box, proportionally more on the deployed Windows NUC.

**None of these are correctness bugs.** They are pure throughput wins. All fixes below are behavior-preserving.

---

## Hot-Path Inventory

### Per-cycle call counts (current `run_dayahead` end-to-end)

| Function | Callsites | Iterations | Total calls |
|---|---|---:|---:|
| `load_solcast_snapshot` | 5 (3234, 3990, 5551, 8818, 9673) | 45+45 loops + 3 scalar | **~93** |
| `fetch_weather(day, source="archive")` | 3 (3994, 5550, 6005) | 45+45+21 | **~111** |
| `load_forecast_weather_snapshot` + `_weather_records_to_frame` | 1 per run + N in loop | varies | ~50 |
| `solar_geometry(day)` | indirect via `clear_sky_radiation` + `build_features` | ~200+ | **~200** |
| `clear_sky_radiation(day, rh)` | `build_features`, `validate_weather_5min`, etc. | per day × loops | ~100 |
| `analyse_weather_day` / `classify_day_regime` | 15+ direct callsites | per day × loops | ~120 |
| `build_features(w5, day, prior)` | 5 callsites | per day in training + QA + final | ~92 |
| `_open_sqlite` (read) | 24 unique callsites | per-call | **~24 conns** |

The repeated-day hotspots are **`build_solcast_reliability_artifact`** (45 days) and **`collect_history_days`** (45 days), which run back-to-back during full regen and almost always load the same day range.

---

## Findings

### E1 — `load_solcast_snapshot` called redundantly across loops

**File:** `services/forecast_engine.py`
**Callsites:** 3234, 3990, 5551, 8818, 9673

```python
# build_solcast_reliability_artifact (3990) — 45 days
for days_ago in range(1, lookback + 1):
    day = ...
    snapshot = load_solcast_snapshot(day)    # ← 45 calls, one conn each

# collect_history_days (5551) — 45 days, SAME day range
for days_ago in range(1, lookback_days + 1):
    day = ...
    snapshot = load_solcast_snapshot(day)    # ← another 45 calls
```

Every call:
1. Opens a new SQLite read connection with retry wrapper.
2. Selects all slots for one day, iterates 288 rows.
3. Allocates 8 fresh numpy arrays + a presence vector.
4. Runs est-actual fallback logic.

For a full regen that runs both reliability + training, **each day is loaded twice**, on separate connections, and then a third time in QA. Plus scalar calls from `resolve_actual_5min_for_date` (3234) and the final `run_dayahead` (9673).

**Fix E1a (in-memory cache, low-risk):**
Add a `functools.lru_cache`-style wrapper keyed on `(day, mtime(APP_DB_FILE))` so the second and third loads are O(dict). mtime-gating is the cheap invalidation story — if Solcast appends a new row, the file mtime bumps and the cache drops. On warm runs we never touch mtime twice anyway because reliability + training are back-to-back.

**Fix E1b (batch load, medium-risk):**
Pre-load all `lookback` days in one query, keyed by `forecast_day`:

```python
def load_solcast_snapshots_range(start_day: str, end_day: str) -> dict[str, dict]:
    # one connection, one SELECT ... WHERE forecast_day BETWEEN ?
    # returns {day: snapshot_dict}
```

Then the loops become `for day in days: snapshot = cache.get(day)`.

**Recommendation:** Ship E1a as a preserving overlay first (no callsite changes except a decorator). Measure. If still a hotspot, implement E1b and retrofit the two 45-day loops.

---

### E2 — `solar_geometry` / `clear_sky_radiation` are pure day-keyed functions, never memoized

**File:** `services/forecast_engine.py:1535`, `1597`

```python
def solar_geometry(day: str) -> dict:
    doy = datetime.strptime(day, "%Y-%m-%d").timetuple().tm_yday
    # 288-slot python loop computing zenith, air_mass, extra_rad
    # PURE function of day-of-year — identical output for same `day`
```

`build_features` calls `solar_geometry(day)` **once** per invocation, then `clear_sky_radiation(day, rh)` which **calls solar_geometry again internally** (1609). So every `build_features` triggers 2 recomputations of the same 288-slot python loop for the same day. Across 92 `build_features` calls per cycle, that's **~184 needless 288-slot python loops**.

Both functions are also called directly from `validate_weather_5min`, `compute_hybrid_baseline`, and reliability scoring — another ~50 redundant calls per cycle.

**Fix E2:**

```python
@lru_cache(maxsize=128)
def _solar_geometry_cached(day: str) -> dict:
    # existing body
    ...

def solar_geometry(day: str) -> dict:
    # return a shallow copy so callers can't mutate the cached arrays
    cached = _solar_geometry_cached(day)
    return {k: v.copy() if isinstance(v, np.ndarray) else v for k, v in cached.items()}
```

Same pattern for `clear_sky_radiation(day, None)` — but the `rh_hourly` version varies per call, so only cache the `rh_hourly is None` branch.

**Safety:** `solar_geometry` is called with `day` as a string in all 15+ callsites. No mutable state, no time-dependent input besides `day`. The shallow-copy wrapper guarantees no cross-caller mutation.

**Benefit:** 45-day reliability loop goes from 45 × 288 = 12,960 python iterations to 1 × 288 = 288 for the geometry portion. `clear_sky_radiation` skips the nested `solar_geometry` call when the cache is warm.

---

### E3 — `fetch_weather` re-parses the same archive CSV across loops

**File:** `services/forecast_engine.py:1352-1401`

Disk cache logic is already present: `_load_cached_weather` reads the CSV and validates. But it re-runs CSV parse + `validate_weather_hourly` on **every call**, even when the same day gets requested by three different loops in a single cycle (reliability 3994 → training 5550 → weather bias 6005).

For archive-source days, the CSV contents never change within one forecast cycle.

**Fix E3:**

```python
@lru_cache(maxsize=256)
def _fetch_weather_cached(day: str, source_kind: str) -> pd.DataFrame | None:
    # existing fetch_weather body for source_kind, forgo the top-level cache read
    ...

def fetch_weather(day: str, source: str = "auto") -> pd.DataFrame | None:
    source_kind = _resolve_source_kind(source, day)
    if source_kind == "forecast" and day == today_str():
        return _fetch_weather_cached.__wrapped__(day, source_kind)  # bypass cache for live
    df = _fetch_weather_cached(day, source_kind)
    return df.copy() if df is not None else None  # prevent mutation
```

**Why a copy:** pandas DataFrames are mutable. A handful of callsites do in-place column operations on the returned frame (e.g. `compute_hybrid_baseline` adds intermediate columns). Returning a copy is cheap relative to the CSV parse and keeps the cache pure.

**Invalidation:** cache is per-process lifetime. The forecast service process restarts on new code deploys, so stale entries never cross a real invalidation boundary. For the archive case, data is historical and immutable.

---

### E4 — `_open_sqlite` opens a fresh connection for each read helper

**File:** `services/forecast_engine.py:571`

Every SQLite read helper (`load_solcast_snapshot`, `load_dayahead_with_presence`, `load_actual_loss_adjusted_with_presence`, etc.) opens its own connection. One `run_dayahead` fires ~24 distinct read helpers; during the 45-day reliability+training loop that expands to **~150+ sqlite3.connect() calls**.

Each `sqlite3.connect()` on Windows has fixed overhead:
- Parse URI (~0.5 ms)
- Create file handle (~1-3 ms)
- Apply `PRAGMA busy_timeout` (~0.5 ms)
- Teardown at close (~1 ms)

Net: **2-5 ms per open**, × 150 = 300-750 ms of pure overhead per cycle.

**Fix E4a (conservative):** Pass an optional `conn` kwarg down the 2-3 hottest helpers (`load_solcast_snapshot`, `load_dayahead_with_presence`, `load_actual_loss_adjusted_with_presence`). Callers that already have a connection pass it in. Only `build_solcast_reliability_artifact` and `collect_history_days` need this change.

```python
def load_solcast_snapshot(day: str, conn: sqlite3.Connection | None = None) -> dict | None:
    if conn is not None:
        return _load_solcast_snapshot_from_conn(conn, day)
    # existing open-and-retry path for scalar callers
    ...
```

**Fix E4b (aggressive):** Contextvar-scoped connection pool — opt in via `with _scoped_read_conn(APP_DB_FILE) as conn:` at the top of each loop body. Helpers introspect the contextvar.

**Recommendation:** E4a is ~40 LOC, zero risk, and captures most of the benefit. Defer E4b.

---

### E5 — Snapshot history append re-reads fresh rows after upsert

**File:** `server/index.js:10174-10212`

```javascript
for (const day of dates) {
  const snapRows = stmts.getSolcastSnapshotDay.all(String(day || ""));
  for (const r of snapRows) { historyRows.push({...}); }
}
```

Right after `buildAndPersistSolcastSnapshot` finishes upserting `solcast_snapshots`, the history append round-trips back through `getSolcastSnapshotDay` to read exactly what was just written. The upsert function already computes `forecast_mw/lo/hi/est_actual_mw` from the overlap algorithm — those values are in memory inside `buildSolcastSnapshotRows` → `upsertSolcastSnapshot`.

**Fix E5:** Return the enriched rows from `buildAndPersistSolcastSnapshot` alongside the status:

```javascript
return { ok, persistedRows, warning, persistedRowsData };
// caller uses snap.persistedRowsData directly instead of getSolcastSnapshotDay
```

**Impact:** Low. Solcast fetches run 5-10× per day, not per forecast cycle. But the fix is trivial and removes a surprising double-read.

---

### E6 — `compute_error_memory` issues one slot query per day

**File:** `services/forecast_engine.py:5365-5373`

```python
for slot_row in conn.execute(
    """
    SELECT slot, signed_error_kwh, support_weight, usable_for_error_memory,
           spread_pct_cap_locked
      FROM forecast_error_compare_slot
     WHERE target_date = ? AND run_audit_id = ?
    """,
    (day_s, run_audit_id),
):
```

N+1 pattern inside the day loop. For a 45-day window that's 45 separate cursor executions, each binding fresh parameters. SQLite prepared statement reuse handles most of this, but:
- Each execute flushes and re-binds params.
- Each cursor builds Python row tuples separately.

**Fix E6:** Pre-fetch all slot rows in one query, bucket by `(target_date, run_audit_id)` in Python:

```python
day_pairs = [(row[0], int(row[1] or 0)) for row in daily_rows]
placeholders = ",".join("(?,?)" for _ in day_pairs)
flat = [v for pair in day_pairs for v in pair]
slot_rows_by_pair = defaultdict(list)
for row in conn.execute(f"""
    SELECT target_date, run_audit_id, slot, signed_error_kwh, support_weight,
           usable_for_error_memory, spread_pct_cap_locked
      FROM forecast_error_compare_slot
     WHERE (target_date, run_audit_id) IN (VALUES {placeholders})
""", flat):
    slot_rows_by_pair[(row[0], int(row[1] or 0))].append(row[2:])
```

Then the outer loop consumes `slot_rows_by_pair[(day_s, run_audit_id)]` without touching the DB. Saves 44 execute calls.

**Impact:** ~50-120 ms savings, but only runs once per forecast cycle. Low priority unless we're paying down the cumulative budget.

---

### E7 — SQLite PRAGMA tuning unused

**File:** `services/forecast_engine.py:571`

Current `_open_sqlite` sets only `busy_timeout`. For read helpers that scan 45 days × 288 slots × multiple tables, raising the page cache helps avoid page churn:

```python
def _open_sqlite(db_path, timeout_sec, readonly=False):
    conn = sqlite3.connect(...)
    conn.execute(f"PRAGMA busy_timeout = {int(timeout_sec * 1000)}")
    if readonly:
        conn.execute("PRAGMA cache_size = -16384")  # 16 MB (negative = KB)
        conn.execute("PRAGMA temp_store = MEMORY")
        conn.execute("PRAGMA mmap_size = 67108864")  # 64 MB
    return conn
```

**Safety:** All three PRAGMAs are connection-scoped in read mode and have zero effect on the on-disk file. `mmap_size` is a ceiling hint, not an allocation.

**Impact:** ~5-15% faster scans on the 45-day loops.

---

## Prioritized Fix Queue

| Priority | Finding | Effort | Dep |
|---|---|---|---|
| P1 | E2: memoize `solar_geometry` + `clear_sky_radiation(day, None)` | 30 min | none |
| P1 | E3: lru_cache on `fetch_weather` archive branch | 20 min | none |
| P1 | E7: read-conn PRAGMA tune | 10 min | none |
| P2 | E1a: mtime-gated snapshot cache wrapper | 45 min | none |
| P2 | E4a: pass `conn` kwarg through 3 hot helpers | 1 h | E1a |
| P3 | E1b: batch `load_solcast_snapshots_range` | 1.5 h | E1a landed |
| P3 | E6: batch compute_error_memory slot query | 45 min | none |
| P4 | E5: return persisted rows from snapshot upsert | 30 min | none |

**Total P1 effort:** ~1 hour. Ship as a single commit.
**P1 expected saving:** 700-1200 ms per full cycle.

---

## What's Already Efficient (do not touch)

- `compute_error_memory` already uses a **single read connection** for all queries inside the function (5271). Good pattern.
- `compute_error_memory` pre-fetches `capture_reason` **once per day** (5357-5363) to avoid N+1 inside the slot loop. Already optimized.
- `upsertSolcastSnapshot` uses `ON CONFLICT DO UPDATE` + prepared statement (db.js:1301). Can't be improved without losing COALESCE semantics.
- `bulkInsertSnapshotHistory` wraps inserts in a single `db.transaction` (db.js:1881). Already batched.
- SQLite WAL mode is set at DB creation by Node (db.js startup), so read connections get snapshot isolation without explicit PRAGMA.
- `fetch_weather` already has a disk CSV cache layer — just missing an in-memory tier on top.
- `_spread_weight` is a pure numpy function with no DB access. Already lean.

---

## Apply Checklist (when executing fixes)

Before any fix lands:

1. `git diff services/forecast_engine.py` — confirm only target callsites changed
2. `python -m py_compile services/forecast_engine.py` — syntax check
3. Run existing tests: `pytest services/tests/test_forecast_engine_*.py -x`
4. Smoke: `python services/forecast_engine.py --generate-date <tomorrow>` and compare metrics vs pre-fix run
5. Verify `_LAST_ERROR_MEMORY_META.selected_days` unchanged
6. Verify `build_features` output shape still 72 columns

Rollback: each P1 fix is a 3-10 line decorator add; `git revert <sha>` safe.

---

## Non-Goals (explicitly deferred)

- Switching to a persistent worker connection or connection pool (E4b) — too much state surface for the current risk budget.
- Rewriting `build_features` to accept pre-computed solar geometry (would push caching into every caller; E2 memoization is simpler).
- Converting the 45-day loops to vectorized numpy over the whole window — would require schema changes to `solcast_snapshots` indexing.
- Async DB access — single-threaded forecast service by design.

---

**Status:** Audit complete, ready for user decision on P1 batch.
