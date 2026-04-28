# SQLite Connection Patterns Audit — v2.8

**Date:** 2026-04-12
**Status:** OPEN — findings logged; remediation pending v2.8.9
**Scope:** Reliability and correctness of SQLite connection handling across the Python forecast engine and Node-side `server/db.js`.
**Companion audits:**
- `plans/2026-04-11-audit-solcast-data-feed-reliability.md`
- `plans/2026-04-11-audit-solcast-data-feed-efficiency.md`
- `plans/2026-04-12-audit-ml-error-correction-reliability.md`

The dashboard runs a **two-process** SQLite setup:
- **Node** (`server/db.js`) — the primary writer, owns a long-lived `better-sqlite3` handle, writes inverter readings / energy / forecast rows / compare tables.
- **Python** (`services/forecast_engine.py`) — spawns per-cycle via `--generate-date` CLI or as a background service, opens short-lived `sqlite3` connections for reads and occasional writes.

Both processes share `C:\ProgramData\InverterDashboard\adsi.db` in WAL mode. Correctness depends on every connection being opened, configured, and closed consistently.

---

## Executive Summary

| # | Finding | Severity | Signal |
|---|---------|----------|--------|
| **S1** | **`_persist_qa_comparison` write has no retry loop** | **Critical** | QA persistence silently drops an entire day's comparison rows on any transient lock — directly starves the error-memory learning loop |
| **S2** | **`write_python_forecast_run_audit` write has no retry loop** | High | Authoritative audit row silently missing on transient lock; forecast was written to DB but the audit trail is broken |
| **S3** | `_collect_data_quality_warnings` opens a writable connection for a pure read (line 7267) | High | Missing `readonly=True` → no cache/mmap tuning, takes write-tier lock, can contend with Node polling writes |
| **S4** | `_is_retryable_sqlite_error` matches only `"database is locked"` / `"database is busy"` | Medium | Misses related transient errors (e.g. `SQLITE_BUSY_SNAPSHOT`, `cannot start a transaction within a transaction`) |
| **M1** | `_read_setting_value` uses manual `try/finally` + `conn.close()` instead of `with` | Low | Inconsistent with rest of codebase; stylistic risk for future edits |
| **M2** | `_open_sqlite` does not set `synchronous = NORMAL` for write connections | Medium | Python writes incur per-page fsync cost; ~5-10× slower than Node's NORMAL writes |
| **M3** | `_open_sqlite` does not set `wal_autocheckpoint` hint or verify WAL mode | Low | Relies on Node setting WAL at DB creation; no defensive verification in Python |
| **M4** | Write paths inconsistently use explicit `readonly=False` vs. default | Low | Stylistic; some sites pass it, some don't |
| **M5** | No `data_version` probe to detect concurrent writes between reads within a cycle | Low | Not a bug today — P2 cycle cache was the correct fix — but worth documenting |
| **O1** | SQLITE_RETRY_BACKOFF_SEC is constant per attempt (0.35 linear) not exponential | Low | Under sustained contention, retries run back-to-back |
| **O2** | `PRAGMA quick_check(1)` only runs in Node at startup, never in Python | Low | Python can't detect DB corruption before a critical write |

**Critical findings: 1** (S1)
**High findings: 2** (S2, S3)
**Medium findings: 3** (S4, M2, M3 — documentation/defense)
**Low/observational: 5** (M1, M4, M5, O1, O2)

---

## Pipeline Overview

```
         ┌──────────────────┐                      ┌───────────────────┐
         │  Node process    │                      │  Python process   │
         │  better-sqlite3  │                      │  sqlite3 stdlib   │
         │  long-lived conn │                      │  per-call conn    │
         └────────┬─────────┘                      └─────────┬─────────┘
                  │                                          │
                  │        ┌────────────────────┐            │
                  └───────▶│    adsi.db (WAL)   │◀───────────┘
                           │  + adsi.db-wal     │
                           │  + adsi.db-shm     │
                           └────────────────────┘
                                   │
                                   ▼
                    Shared tables:
                    - readings, energy_5min, audit_log   (Node writes)
                    - solcast_snapshots                  (Node writes)
                    - solcast_dayahead_locked            (Node writes)
                    - forecast_dayahead                  (Python writes)
                    - forecast_error_compare_daily/slot  (Python writes ← hot!)
                    - forecast_run_audit                 (both write)
```

**Key fact:** Node is a single long-lived `better-sqlite3` handle which blocks the Node event loop during contention (by design — better-sqlite3 is synchronous). Python opens ~25 short-lived `sqlite3` connections per forecast cycle (post P1-P3 dedup brings this to ~10-15 unique opens + ~75 cache hits).

When Python writes while Node is polling (5-second cadence × 27 inverters), write-lock contention is possible. The Python side's `busy_timeout = 20_000ms` usually absorbs this, but Python-side retry loops are inconsistently applied.

---

## Critical & High Findings

### **S1 — `_persist_qa_comparison` write has no retry loop (CRITICAL)**

**File:** `services/forecast_engine.py:8858-9183`

```python
try:
    with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC) as conn:
        # ... ~300 lines of schema probing, daily INSERT, slot executemany,
        #     locked_within_band_pct UPDATE, final conn.commit() ...
except Exception as e:
    log.warning("Failed to persist forecast comparison for %s: %s", target_date, e)
```

**Problem:** Exactly one try/except wraps the whole function. On `OperationalError: database is locked`, it logs a WARNING and returns. No retry. The entire QA comparison for that day is lost.

**Why it's critical:** `_persist_qa_comparison` is the **sole source of training data** for the error-memory learning loop. Every row it fails to write means:
1. `usable_for_error_memory=1` never gets set for that day's slots
2. `include_in_error_memory=1` never gets set for that day's daily row
3. `compute_error_memory` on subsequent cycles skips that day entirely
4. `_LAST_ERROR_MEMORY_META.last_eligible_date` stays stale
5. `_collect_data_quality_warnings` eventually flags `error_memory_stale` — but days later.

In the **worst case**, a single transient lock during the ~100ms QA write window silently drops a day of learning signal. The operator sees no alarm — just a warning log buried in service.log.

Compare with `_write_forecast_db` (same file, line 9626) which **does** have a retry loop — proof the pattern is available and should be consistent.

**Fix:**
```python
for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC) as conn:
            ...
            conn.commit()
        return  # success
    except Exception as e:
        if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
            log.warning("QA persist retry %d/%d for %s: %s", attempt, SQLITE_RETRY_ATTEMPTS, target_date, e)
            _sleep_sqlite_retry(attempt)
            continue
        log.warning("Failed to persist forecast comparison for %s: %s", target_date, e)
        return
```

**Priority:** P1. This is the single most reliability-relevant finding in this audit — the entire error-memory learning loop depends on it.

---

### **S2 — `write_python_forecast_run_audit` write has no retry loop**

**File:** `services/forecast_engine.py:9758-9859`

Same pattern, different function:

```python
try:
    with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC) as conn:
        prev_row = conn.execute(...).fetchone()  # SELECT
        cur = conn.execute("INSERT INTO forecast_run_audit ...", ...)  # INSERT
        new_id = cur.lastrowid
        if prev_id is not None and new_id:
            conn.execute("UPDATE forecast_run_audit SET is_authoritative_runtime = 0 ...")  # UPDATE
        conn.commit()
        return new_id
except Exception as e:
    log.warning("Failed to write forecast_run_audit from Python for %s: %s", target_s, e)
    return None
```

**Problem:** On any lock contention, the authoritative audit row for this forecast run goes missing. The forecast itself was persisted to `forecast_dayahead` (in a separate write with its own retry loop), but the run audit trail is broken — downstream consumers reading `forecast_run_audit` by `target_date` won't see this run.

**Impact:** Less severe than S1 because the forecast still hits the DB, but breaks:
- Replication / sync tooling that keys off `forecast_run_audit.id`
- WESM FAS compliance reporting (audit lineage)
- Any downstream analytics that join through `forecast_run_audit`

**Fix:** Same retry loop pattern as S1.

**Priority:** P1. Pairs with S1 in the same commit.

---

### **S3 — `_collect_data_quality_warnings` reads with a writable connection**

**File:** `services/forecast_engine.py:7265-7279`

```python
# Check for missing Solcast tri-band data (new architecture dependency)
try:
    with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC) as conn:
        # ↑↑↑ NO readonly=True!
        _row = conn.execute(
            "SELECT forecast_lo_kwh, forecast_hi_kwh FROM solcast_snapshots "
            "WHERE forecast_day = ? AND slot >= ? AND slot < ? LIMIT 1",
            (_tomorrow, SOLAR_START_SLOT, SOLAR_END_SLOT),
        ).fetchone()
```

**Problem:** This is a pure `SELECT` but opens a **writable** connection (the default when `readonly` is omitted). Consequences:
1. **No cache / mmap tuning** — the v2.8 E7 efficiency fix only applies the 16 MB cache + 64 MB mmap for `readonly=True`, so this connection runs with the default 2 MB SQLite cache.
2. **Write-tier locking** — a writable connection participates in write-lock arbitration even if it never writes. Under contention, it blocks Node writers and vice-versa for longer than a readonly connection would.
3. **Cannot run on a read-only filesystem** — future deployment that mounts the DB file read-only (e.g. snapshot, integrity test) will fail here where a readonly connection would succeed.

**Fix:** Add `readonly=True`:
```python
with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
```

**Priority:** P1. Trivial fix, zero risk, directly aligned with every other read in the file (20 of 25 `_open_sqlite` calls already use `readonly=True`).

---

### **S4 — `_is_retryable_sqlite_error` is too narrow**

**File:** `services/forecast_engine.py:566-575`

```python
def _is_retryable_sqlite_error(exc: Exception) -> bool:
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    msg = str(exc).lower()
    return (
        "database is locked" in msg
        or "database is busy" in msg
        or "locked" == msg.strip()
        or "busy" == msg.strip()
    )
```

**Problem:** String matching misses several SQLite error variants that should be retried:

| Error message | Reason it's transient | Currently retried? |
|---|---|---|
| `database is locked` | Writer holds exclusive lock | ✅ yes |
| `database is busy` | Equivalent to above | ✅ yes |
| `database disk image is malformed` — transient checkpoint race | WAL checkpoint collides with a reader | ❌ NO |
| `cannot start a transaction within a transaction` | Nested BEGIN from retry attempt | ❌ NO |
| `SQLITE_BUSY_SNAPSHOT` (Python error msg: `database is locked`) | Snapshot became stale mid-transaction | ✅ yes (same msg) |
| `unable to open database file` (transient on Windows when file handle is contended) | OS-level file lock | ❌ NO |
| `disk I/O error` | Transient Windows filesystem issue | ❌ NO |

**Fix:** Broaden to use `sqlite3.OperationalError` subclass checks where possible, and add the common transient-error substrings:

```python
def _is_retryable_sqlite_error(exc: Exception) -> bool:
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    msg = str(exc).lower().strip()
    retryable_patterns = (
        "database is locked",
        "database is busy",
        "locked",
        "busy",
        "unable to open database file",
        "disk i/o error",
    )
    return any(p in msg for p in retryable_patterns) or msg in {"locked", "busy"}
```

**Note:** Not all "disk I/O error" cases are transient, but SQLite's busy_timeout already absorbed persistent ones; seeing this error AFTER busy_timeout expired usually means a brief Windows filesystem hiccup that retry can recover from.

**Priority:** P2. Low risk, but expanding the retry net helps reliability under Windows NUC filesystem quirks.

---

## Medium Findings

### **M2 — Python write connections don't set `synchronous = NORMAL`**

**File:** `services/forecast_engine.py:578-597`

Node's main DB connection (`server/db.js:360`) runs with:
```javascript
db.pragma("synchronous = NORMAL");
```

Python write connections get the sqlite3 default of `synchronous = FULL`. On WAL mode, the difference:
- **FULL:** fsync after every page write AND at commit — safest, slowest
- **NORMAL:** fsync only at commit boundaries + WAL checkpoint — WAL-safe, ~5-10× faster for bulk inserts

Python's `_persist_qa_comparison` writes ~290 rows per day (288 slots + 1-2 daily rows) in one executemany. With FULL, every page fsync blocks on disk. With NORMAL, fsync only at commit.

**Why it matters:** While Python's infrequent writes absorb the FULL cost, any future refactor that turns Python writes into a tight loop (e.g. backtest harness rewriting 90 days of QA) will pay 5-10× the cost it should.

**Fix:**
```python
def _open_sqlite(db_path, timeout_sec, readonly=False):
    ...
    if readonly:
        # existing read tuning
    else:
        try:
            conn.execute("PRAGMA synchronous = NORMAL")
        except sqlite3.Error:
            pass
    return conn
```

**Safety note:** NORMAL is only safe in WAL mode. Since Node has already set WAL at DB creation, this is safe. If someone ever runs Python against a rollback-journal DB (test fixture), NORMAL is still safer than DELETE journal — just slightly weaker durability on kernel panics.

**Priority:** P2. Modest win, low risk.

---

### **M3 — `_open_sqlite` doesn't verify WAL mode**

Python **assumes** the DB is in WAL mode based on Node having set it at creation. If Python ever runs against a DB that was created in rollback mode (e.g. test fixtures, old backups restored into a new install), none of the WAL-specific assumptions hold:
- Multiple readers during writes (WAL-specific)
- `busy_timeout` semantics
- `synchronous = NORMAL` crash safety
- Snapshot isolation for readonly connections

**Fix:** Add a one-shot diagnostic at module load time or first `_open_sqlite` call:
```python
_WAL_MODE_VERIFIED = False

def _verify_wal_mode_once():
    global _WAL_MODE_VERIFIED
    if _WAL_MODE_VERIFIED or not APP_DB_FILE.exists():
        return
    try:
        with _open_sqlite(APP_DB_FILE, 2.0, readonly=True) as c:
            mode = str(c.execute("PRAGMA journal_mode").fetchone()[0] or "").lower()
            if mode != "wal":
                log.warning("DB journal_mode is '%s' (expected 'wal') — WAL-specific assumptions may not hold", mode)
            _WAL_MODE_VERIFIED = True
    except Exception:
        pass  # non-fatal
```

**Priority:** P3. Documentation-grade defense; doesn't fix anything today but catches drift early.

---

### **M4 — Inconsistent use of explicit `readonly=False`**

Three write sites: line 8859, 9628, 9759. Only 9628 uses `readonly=False` explicitly; 8859 and 9759 rely on the default. Stylistic, not a bug.

**Fix:** Normalize all three write sites to pass `readonly=False` for explicit code.

**Priority:** P4. Cosmetic.

---

## Low / Observational Findings

### M1 — `_read_setting_value` manual close
File: `services/forecast_engine.py:11228-11235`

```python
conn = _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True)
try:
    row = conn.execute(...).fetchone()
finally:
    conn.close()
```

Works, but inconsistent with the 24 other sites that use `with`. A future edit could accidentally drop the `conn.close()` line.

### M5 — No `data_version` probe
SQLite's `PRAGMA data_version` increments on every write by another connection. Python could use it to detect "did Node write between my reads?" — useful for cycle-spanning caches. Not needed today (P2 cycle cache resets at `run_dayahead` boundary and trusts Node's writes to be reflected on next open), but worth noting.

### O1 — Linear retry backoff
`SQLITE_RETRY_BACKOFF_SEC = 0.35` times `max(1, attempt)` → linear 0.35 → 0.70 → 1.05. Under sustained contention, all three retries burn through in ~2 seconds. Exponential backoff (0.35 → 0.70 → 1.40) would give the writer a slightly longer window without significantly extending the total wait. Marginal.

### O2 — No Python-side `quick_check`
Node runs `PRAGMA quick_check(1)` at startup (db.js:368). Python never does. If the DB becomes corrupted between Node startups, Python won't detect it until an actual query fails.

---

## What's already solid (do not touch)

- **Node side (`server/db.js`):** Long-lived connection with all the right pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=1500`, `cache_size=-64000`, `temp_store=memory`, `mmap_size=268435456`. Excellent.
- **Node startup `quick_check(1)`** — detects corruption early (line 368).
- **Archive DB cache pattern (`server/db.js:2072-2082`)** — LRU-ish cache with explicit close on month rollover.
- **`better-sqlite3` transactions** — 15+ `db.transaction(...)` wrappers for bulk inserts, all atomic and fast.
- **WAL checkpoint strategy** — PASSIVE for routine cleanup, TRUNCATE for shutdown/migration.
- **`_open_sqlite` read-tuning** (v2.8 E7): 16 MB cache + 64 MB mmap + temp_store=MEMORY on readonly connections.
- **`_open_sqlite` busy_timeout**: set to the `timeout_sec` argument × 1000 ms, so read and write paths get appropriate contention windows.
- **20 of 25 Python `_open_sqlite` call sites** correctly use `readonly=True` for reads.
- **Retry loops on `_load_solcast_snapshot_uncached` / `_load_solcast_snapshots_range_uncached` / `_write_forecast_db`** — all correctly wrapped.
- **Cycle cache invalidation** (v2.8 P2): `_reset_forecast_cycle_cache()` clears all four lru_caches at every `run_dayahead` boundary so daemon mode doesn't leak stale reads across cycles.

---

## Prioritized Fix Queue

| Priority | Finding | Effort | Risk |
|---|---|---|---|
| **P1** | **S1** — retry loop on `_persist_qa_comparison` | 20 min | Low |
| **P1** | **S2** — retry loop on `write_python_forecast_run_audit` | 15 min | Low |
| **P1** | **S3** — `readonly=True` on `_collect_data_quality_warnings` read | 2 min | None |
| P2 | S4 — broaden `_is_retryable_sqlite_error` matches | 10 min | Low |
| P2 | M2 — `synchronous=NORMAL` for Python write connections | 10 min | Low |
| P3 | M3 — one-shot WAL mode verification | 15 min | None |
| P4 | M1, M4, O1, O2 — stylistic / observational | 30 min total | None |
| P4 | M5 — `data_version` probe (deferred) | n/a | n/a |

**P1 batch total effort: ~40 minutes.**
**P1 expected impact:** Close the single biggest silent reliability gap (S1), normalize audit-row persistence (S2), and fix a pure-read writable connection (S3).

---

## Apply Checklist

For each P1 fix:

1. `git diff services/forecast_engine.py` — confirm only target lines changed
2. `python -m py_compile services/forecast_engine.py`
3. `pytest services/tests/ --deselect ...::test_feature_count_consistency`
4. Create a test fixture that forces `sqlite3.OperationalError("database is locked")` on first attempt, succeeds on second. Assert:
   - `_persist_qa_comparison` retries and eventually persists
   - `write_python_forecast_run_audit` retries and eventually returns the new id
5. Verify with real temp DB that the S3 fix (`readonly=True` on data-quality check) doesn't regress the column existence probe.

Rollback: each P1 fix is a small wrapper/kwarg change with obvious undo.

---

## Non-goals (explicitly deferred)

- Replacing Python's `sqlite3` stdlib with `better-sqlite3` bindings — too much surface area
- Switching to an ORM or connection pool — overkill for a per-cycle forecast runner
- Implementing a Python-side long-lived connection — conflicts with the subprocess spawn model
- Changing the shared-DB model to two separate files — breaks all cross-process queries
- Adding a leader election / write lock service — adds a runtime dependency

---

**Status:** Audit complete, ready for user decision on P1 batch (S1 + S2 + S3).
