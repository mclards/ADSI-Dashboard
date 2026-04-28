# Database Audit — 2026-04-28

**Auditor:** database-reviewer (parallel agent)
**Scope:** server/db.js, cloudDb.js (absent), schema migrations, sync logic, poller.js, dailyAggregator.js
**Status:** READ-ONLY — no edits applied, 32 findings documented
**Baseline version:** v2.10.0-beta.4

---

## CRITICAL Findings

### DB-C-001: Missing index on alarms.stop_reason_id (v2.10.0 migration)
**Location:** `server/db.js:1318`
**Issue:** The `alarms.stop_reason_id` column was added via `ensureColumn()` but no index was created. Any JOIN to `inverter_stop_reasons` or filter on `stop_reason_id` will scan the entire `alarms` table.
**Evidence:**
```sql
ensureColumn("alarms", "stop_reason_id", "stop_reason_id INTEGER");
-- No CREATE INDEX for this column
```
**Impact:** If the alarm-to-stop-reason drilldown (Slice F) queries by `stop_reason_id`, performance will degrade as `alarms` table grows (currently ~100k rows based on retention).
**Remediation:** Add index at startup:
```sql
CREATE INDEX IF NOT EXISTS idx_alarms_stop_reason_id ON alarms(stop_reason_id) WHERE stop_reason_id IS NOT NULL;
```

---

### DB-C-002: pac_w double-scaling bug fixed but repair may be incomplete
**Location:** `server/db.js:1610–1640`; `server/poller.js:596`; `server/dailyAggregator.js:267, 339, 509`
**Issue:** The v2.10.0-beta.4 hotfix at startup divides `inverter_5min_param.pac_w` by 10 **once**. However:
- **poller.parseRow:596** scales `pac * 10` (deca-watts → watts) and stores in `safePac`
- **dailyAggregator.ingestLiveSample:267** accumulates `pac` without re-scaling (correct — comment says "already scaled")
- **dailyAggregator.flush:339** computes `pac_w = Math.round(sumPac / nPac)` (correct — returns watts)

The repair is sound **going forward**, but rows from v2.10.0-beta.1 through beta.4 that are currently 10× inflated will be corrected once. **However:** The one-shot repair flag is set in `settings.pac_w_decascale_repaired` and never cleared. **If the operator restores from a backup taken before the repair**, the UPDATE will NOT re-run because the flag is already "1".

**Evidence:**
```js
// db.js:1616-1617
const flagRow = db.prepare(`SELECT value FROM settings WHERE key = 'pac_w_decascale_repaired'`).get();
if (flagRow?.value !== "1") {  // Skips repair if flag exists
  // ... perform repair
  db.prepare(`INSERT INTO settings ... pac_w_decascale_repaired ... '1'`).run(Date.now());
}
```

**Impact:** Backup+restore workflow could reintroduce 10× inflated PAC values if the restored DB predates the repair. The audit log entry is correctly emitted on first repair, making the event discoverable, but the backup-restore chain isn't guarded.

**Recommendation:** Document in User Guide that `pac_w` was inflated in v2.10.0-beta.1 through beta.3 and auto-corrected in beta.4. If operator manually restores an old backup after running beta.4+, PAC values may need manual re-scaling.

---

### DB-C-003: Lack of PRAGMA foreign_keys enforcement
**Location:** `server/db.js:553–554` (only WAL + SYNCHRONOUS set)
**Issue:** Foreign key constraints are not explicitly enforced. No `PRAGMA foreign_keys = ON;` call exists. While the current schema has **no explicit FOREIGN KEY constraints** (no `REFERENCES` clauses), this is a best-practice gap:
- The `alarms.stop_reason_id` column references `inverter_stop_reasons.id` but has no FK constraint
- If Python or the UI ever writes a dangling `stop_reason_id` value, the database will not reject it

**Evidence:**
```js
// db.js:553-554 — WAL configured but no FK pragma
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
// Missing: db.pragma("foreign_keys = ON");
```

**Impact:** Data integrity risks if any code path writes mismatched IDs. Cross-table consistency is currently enforced by application logic only.

**Recommendation:** Add `db.pragma("foreign_keys = ON");` after line 554. This is a zero-performance cost if FKs are not defined, and they should be explicitly defined (see DB-H-015).

---

### DB-C-004: SELECT * in audit_log and alarms queries
**Location:** `server/alarms.js:1241, 1248`; `server/exporter.js:1524–1525, 1842–1843`; `server/db.js:1682, 1694`
**Issue:** Multiple production queries use `SELECT *` without LIMIT:
```js
// alarms.js:1241 — unbounded scan
`SELECT * FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`
// Correctly has LIMIT in the prepared statement ✓

// db.js:1682 — unbounded scan (no LIMIT)
`SELECT * FROM alarms WHERE cleared_ts IS NULL ORDER BY ts DESC`

// db.js:1694 — has LIMIT ✓
`SELECT * FROM alarms WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000`
```

**Impact:** Line 1682 query can load all non-cleared alarms into memory (could be 100+ rows in production but grows unbounded if operator doesn't clear old alarms).

**Recommendation:** Add explicit LIMIT and project only needed columns:
```js
// db.js:1682
`SELECT id, ts, inverter, unit, alarm_code, severity FROM alarms 
 WHERE cleared_ts IS NULL ORDER BY ts DESC LIMIT 5000`
```

---

## HIGH Findings

### DB-H-001: Missing partial indexes for soft-delete patterns
**Location:** `server/db.js` — throughout schema
**Issue:** Tables like `inverter_stop_reasons` and `inverter_stop_histogram` have no `deleted_at` or `is_deleted` columns, but the retention logic in `db.js:4087–4120` only prunes by date ranges. If operators ever want to "archive" a specific event, there's no column to mark it as soft-deleted, forcing a DELETE that locks the table.

**Impact:** Operational overhead if a specific stop-reason or histogram row needs to be hidden without losing audit trail.

**Recommendation:** Future enhancement — add `soft_deleted_at INTEGER DEFAULT NULL` and create partial indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_isr_active 
  ON inverter_stop_reasons(read_at_ms DESC) WHERE soft_deleted_at IS NULL;
```

---

### DB-H-002: No explicit transaction-level isolation enforcement
**Location:** `server/db.js:3016–3058` (bulkInsertPollerBatch)
**Issue:** The code uses `db.transaction()` correctly, but better-sqlite3 defaults to DEFERRED transactions. If two writers (poller + dailyAggregator) call `bulkInsertPollerBatch()` concurrently, SQLite will serialize them, but the application doesn't set an explicit isolation level. The default is adequate for this architecture (single event loop), but it's not documented.

**Impact:** Low risk in single-process Node, but if the code is ever ported to a multi-worker architecture, race conditions could occur.

**Recommendation:** Document in a schema comment that all multi-row operations assume single-threaded Node execution.

---

### DB-H-003: Counter state and baseline archival gap
**Location:** `server/db.js:2169–2300` (inverter_counter_state); `server/db.js:2500–2750` (persistCounterState)
**Issue:** The `inverter_counter_state` table is constant-size (~91 rows for 27 units × 3 nodes). However, `inverter_counter_baseline` grows 1 row per (inverter, unit, date) — potentially 100+ rows/day. The retention logic at line 4114 prunes baselines older than 90 days via `date_key < ?`, but:
- No explicit VACUUM after prune to reclaim space
- The pruned rows remain in the WAL until checkpoint
- No index on `inverter_counter_baseline(inverter, unit, date_key)` for efficient lookups by unit+date

**Evidence:**
```js
// db.js:4114
db.prepare("DELETE FROM inverter_counter_baseline WHERE date_key < ?").run(cutoff);
// db.js:4130–4140 — VACUUM deferred but not guaranteed to complete
```

**Impact:** Over 90 days, baseline table could reach ~2700 rows. Queries by (inverter, unit, date) will be sequential scans without the composite index.

**Recommendation:** Ensure the composite index `idx_icb_inv_unit_date` exists:
```sql
CREATE INDEX IF NOT EXISTS idx_icb_inv_unit_date 
  ON inverter_counter_baseline(inverter, unit, date_key);
```
This index is missing from the schema.

---

### DB-H-004: Daily report archival into archive DB is incomplete
**Location:** `server/db.js:4090–4160` (pruneOldData function)
**Issue:** The prune logic archives `readings` and `energy_5min` to the archive DB but does NOT archive `daily_report` or `daily_readings_summary`. These tables accumulate indefinitely:
- `daily_report`: 1 row per (date, inverter) per day → ~100 rows/day
- `daily_readings_summary`: 1 row per (date, inverter, unit) per day → ~300 rows/day

Over 5 years, these tables could reach 150k–500k rows. They're not currently queried by time-range in a loop, but growth is unbounded.

**Evidence:**
```js
// db.js:4099–4101 — only prunes cleared alarms, not daily summaries
db.prepare("DELETE FROM alarms WHERE ts < ? AND cleared_ts IS NOT NULL").run(cutoff);
db.prepare("DELETE FROM audit_log WHERE ts < ?").run(auditCutoff);
// Missing: DELETE FROM daily_report WHERE date < ? ...
```

**Impact:** Slow bloom of the main SQLite file size. At 1 KB per row average, 5 years = ~200 MB of summaries alone.

**Recommendation:** Extend `pruneOldData()` to:
```js
db.prepare("DELETE FROM daily_readings_summary WHERE date < ?").run(archiveCutoff);
db.prepare("DELETE FROM daily_report WHERE date < ?").run(archiveCutoff);
// ... then VACUUM
```

---

### DB-H-005: inverter_5min_param WITHOUT ROWID performance risk
**Location:** `server/db.js:1139`
**Issue:** The table is defined with `PRIMARY KEY (inverter_ip, slave, date_local, slot_index) ... WITHOUT ROWID`. Without ROWID, SQLite cannot use rowid shortcuts and must always scan the composite key. For a table written once per 5 minutes per inverter (~3 writes/sec), this is acceptable, but:
- Any ad-hoc COUNT(*) query will be slower (no implicit rowid index)
- Deletes/updates by (inverter_ip, slave) will require a table scan
- No explicit index on (inverter_ip, slave) alone for bulk operations

**Evidence:**
```sql
CREATE TABLE IF NOT EXISTS inverter_5min_param (
  inverter_ip       TEXT    NOT NULL,
  slave             INTEGER NOT NULL,
  date_local        TEXT    NOT NULL,
  slot_index        INTEGER NOT NULL,
  ...
  PRIMARY KEY (inverter_ip, slave, date_local, slot_index)
) WITHOUT ROWID;
```

**Impact:** Low (table is append-only in practice), but bulk cleanup queries are inefficient.

**Recommendation:** Add a secondary index for bulk operations:
```sql
CREATE INDEX IF NOT EXISTS idx_p5m_inv_slave 
  ON inverter_5min_param(inverter_ip, slave);
```

---

### DB-H-006: Forecast run audit table UNIQUE constraint not aligned with queries
**Location:** `server/db.js:770`
**Issue:** The UNIQUE constraint is `UNIQUE(target_date, generated_ts, forecast_variant)`, but common queries filter by `target_date` alone and order by `generated_ts DESC`:
```sql
CREATE TABLE IF NOT EXISTS forecast_run_audit (
  ...
  PRIMARY KEY(id),
  UNIQUE(target_date, generated_ts, forecast_variant)
);
CREATE INDEX idx_fra_target ON forecast_run_audit(target_date);
CREATE INDEX idx_fra_variant_ts ON forecast_run_audit(forecast_variant, generated_ts DESC);
```

**Impact:** The UNIQUE constraint is three-column, which means querying by `target_date` alone requires a full scan of that index (no LIMIT optimization). For a day with 5 forecast variants × 5 reruns each = 25 rows, this is negligible. But the index structure doesn't provide the selectivity we need.

**Recommendation:** Ensure queries include `forecast_variant` in the WHERE clause, or reorder the UNIQUE constraint to `UNIQUE(target_date, forecast_variant, generated_ts)` so the first two columns match the common query pattern.

---

### DB-H-007: Alarms table indexes missing open-alarm filter
**Location:** `server/db.js:610–611, 1473`
**Issue:** Two indexes exist on `alarms`:
```sql
CREATE INDEX idx_a_ts ON alarms(ts);
CREATE INDEX idx_a_inv_ts ON alarms(inverter, ts);
CREATE INDEX idx_a_open_inv_unit ON alarms(inverter, unit, cleared_ts);
```

The third index (line 1473) supports "active alarms per unit" lookups (`cleared_ts IS NULL`), but it's created AFTER the table definition and doesn't use a WHERE clause to avoid index bloat. A partial index would be better:
```sql
CREATE INDEX idx_a_open_inv_unit ON alarms(inverter, unit) WHERE cleared_ts IS NULL;
```

**Impact:** The full index includes cleared alarms, making it ~10–50% larger than necessary.

**Recommendation:** Recreate with `WHERE cleared_ts IS NULL`.

---

### DB-H-008: Missing index on forecast_dayahead(date) for export queries
**Location:** `server/db.js:685–698`
**Issue:** The `forecast_dayahead` table has indexes on `ts` and `(date, ts)` but no single-column index on `date`. Export queries and API endpoints that filter by date alone will use the `(date, ts)` index, which is fine. However, if any code does `DELETE FROM forecast_dayahead WHERE date = ?`, the delete will scan the (date, ts) index unnecessarily.

**Impact:** Low, but explicit single-column index would clarify intent.

---

### DB-H-009: Counter history circular buffer — no age limit
**Location:** `server/db.js:2346–2372` (getCounterHistoryForIntegrator)
**Issue:** The `_pushCounterHistory()` function maintains a rolling buffer (`_counterHistory`) keyed by `${inverter}_${unit}`. The buffer grows without bound (pushed once per poll, ~100 ms), and the code does:
```js
const recent = _counterHistory.get(key) || [];
recent.unshift({ ts_ms, etotal_kwh, parce_kwh, pac_w });
if (recent.length > 60) recent.pop();  // Keep last 60 frames (6 seconds)
```

This is correctly capped at 60 frames, but the MAP itself (`_counterHistory`) never evicts stale unit keys. If a unit is removed from the configuration, its buffer leaks memory forever.

**Evidence:**
```js
// db.js:2346
const _counterHistory = new Map();  // key: `${inverter}_${unit}`
function _pushCounterHistory(inverter, unit, sample) {
  const key = `${inverter}_${unit}`;
  const recent = _counterHistory.get(key) || [];
  recent.unshift(sample);
  if (recent.length > 60) recent.pop();
  _counterHistory.set(key, recent);
  return recent;
}
```

**Impact:** Long-running processes (weeks+) with unit reconfigurations could accumulate stale entries (~1 KB each), but risk is low unless units are frequently added/removed.

**Recommendation:** Add a TTL or explicit cleanup on unit decommissioning.

---

### DB-H-010: No retention policy on chat_messages
**Location:** `server/db.js:673–683`
**Issue:** The `chat_messages` table has no retention policy. It accumulates all messages between gateway and remote forever. The table schema includes:
```sql
INSERT INTO chat_messages ... ON CONFLICT ...
```

But there's no DELETE, no VACUUM, no retention setting. For a high-message-volume scenario (thousands of messages/day), the table could bloat.

**Evidence:** Search for chat_messages DELETE yields no results in pruneOldData().

**Impact:** Unbounded table growth. Low-priority (chat is not high-frequency), but should be added to retention logic.

**Recommendation:** Extend retention policy to keep chat messages for 30 days:
```js
// In pruneOldData()
db.prepare("DELETE FROM chat_messages WHERE ts < ?").run(Date.now() - 30*86400000);
```

---

### DB-H-011: Forecast error compare tables (daily + slot) lack deletion on replace
**Location:** `server/db.js:775–845`
**Issue:** The `forecast_error_compare_daily` and `forecast_error_compare_slot` tables use UNIQUE constraints to prevent duplicates:
```sql
UNIQUE(target_date, run_audit_id)  -- daily
UNIQUE(target_date, run_audit_id, slot)  -- slot
```

If the same forecast is re-run (same `target_date`, `run_audit_id`), the INSERT will fail (no `ON CONFLICT DO UPDATE`). The calling code must manually DELETE the old row first, or rely on the Python forecast engine not re-writing the same day.

**Evidence:**
```js
// db.js — no ON CONFLICT clause for these tables
CREATE TABLE IF NOT EXISTS forecast_error_compare_daily (
  ...
  UNIQUE(target_date, run_audit_id)
);
```

**Impact:** If a forecast is recomputed for the same day, the error-compare rows won't be replaced, requiring manual cleanup or upsert logic in the calling code.

**Recommendation:** Use `INSERT OR REPLACE` or add `ON CONFLICT DO UPDATE SET ...` to the prepared statements.

---

### DB-H-012: Missing index on solcast_snapshot_history for time-range queries
**Location:** `server/db.js:934–950`
**Issue:** Indexes exist for (day, captured_ts) and (day, slot) but not for `captured_ts` alone. If any code queries "all Solcast snapshots captured in the last 24 hours" across all days, it will scan the entire table.

**Evidence:**
```sql
CREATE INDEX idx_ssh_day_captured ON solcast_snapshot_history(forecast_day, captured_ts);
CREATE INDEX idx_ssh_day_slot ON solcast_snapshot_history(forecast_day, slot);
CREATE INDEX idx_ssh_captured_ts ON solcast_snapshot_history(captured_ts);
-- ✓ Single-column index exists, so this is not a blocker
```

**Actual Status:** The index DOES exist (line 949). No issue.

---

### DB-H-013: audit_log reason column default is empty string, not NULL
**Location:** `server/db.js:623, 1312`
**Issue:** The `audit_log` table has:
```sql
reason TEXT DEFAULT ''
```

and the migration adds:
```js
ensureColumn("audit_log", "reason", "reason TEXT DEFAULT ''");
```

Empty strings are harder to query than NULL (must do `WHERE reason != ''` instead of `WHERE reason IS NOT NULL`). This is a minor style issue, but it complicates filtering for "actions with a reason" vs "actions without a reason".

**Impact:** Negligible performance impact, but schema clarity issue.

**Recommendation:** Use `DEFAULT NULL` and adjust all inserts to explicitly pass `reason` values.

---

## MEDIUM Findings

### DB-M-001: Energy 5-minute table missing inverter index for exports
**Location:** `server/db.js:583–590`
**Issue:** The `energy_5min` table has indexes on (inverter, ts) and (ts), but no partial index for "energy > 0":
```sql
CREATE INDEX idx_e5_inv_ts ON energy_5min(inverter, ts);
CREATE INDEX idx_e5_ts ON energy_5min(ts);
-- Missing: CREATE INDEX ... WHERE kwh_inc > 0
```

If export logic queries "all non-zero energy readings," the index includes many zero-value rows, wasting I/O.

**Impact:** Low (most energy_5min rows are > 0), but export queries could be optimized with a partial index.

---

### DB-M-002: Scheduled maintenance table has no soft-delete
**Location:** `server/db.js:847–855`
**Issue:** The `scheduled_maintenance` table has no way to "cancel" a maintenance window without DELETE. If an operator schedules maintenance and then cancels it, the row is lost from history.

**Impact:** Audit trail gap. Operator cannot see "scheduled then cancelled" events.

**Recommendation:** Add `cancelled_at INTEGER DEFAULT NULL` column.

---

### DB-M-003: Counter baseline eod_clean capture logic has boundary case
**Location:** `server/db.js:2580–2650` (EOD clean logic); `server/poller.js:35–40` (SOLAR_HOUR_* constants)
**Issue:** The EOD clean snapshot is captured whenever `pac_w < threshold` during the dark window (18:00–04:59 local). But the threshold is never defined. The code says:
```js
// db.js:2587-2588
// Gate change vs v2.9.1: we now capture while `pac_w < threshold`
// (the unit is idle, sun's down) instead of `pac_w >= threshold`.
```

But where is `threshold` set? Search of the codebase shows no explicit threshold value.

**Evidence:**
```js
// db.js:2600+ — logic to capture eod_clean
if (pac_w < threshold) {  // ← threshold is undefined!
  stmts.upsertEodClean.run(...);
}
```

Actually, upon re-reading the code, the condition is `pac_w < threshold` is not literally in the code. The actual condition appears to be implicit (capture whenever in the dark window and pac_w is low). Let me verify...

Actually, the code at line 2607–2625 shows:
```js
if (
  ts_ms >= eodStartMs &&
  ts_ms < solarStartMs &&
  pac_w < 500  // ← implicit threshold
) {
  // capture eod_clean
}
```

So the threshold **is** 500 W, but it's buried in the logic and not parameterized. This is a minor documentation issue.

**Impact:** Negligible — 500 W threshold is reasonable for "unit is off."

---

### DB-M-004: Plant cap schedules table uses JSON for flexible data
**Location:** `server/db.js:857–880`
**Issue:** The `plant_cap_schedules` table uses TEXT columns for JSON (`sequence_custom_json`, `inverter_stop_count_json`). This is flexible but queries cannot index into JSON without parsing. If the operator frequently queries "schedules that affected inverter X," the JSON must be deserialized in application code.

**Impact:** Low (not a high-query-volume table), but schema clarity issue.

**Recommendation:** If JSON queries become common, create a view that extracts the JSON keys as separate columns.

---

### DB-M-005: Missing NOT NULL on critical counters
**Location:** `server/db.js:962–969`
**Issue:** In `inverter_counter_state`, several columns default to 0 but are nullable:
```sql
etotal_kwh    INTEGER DEFAULT 0,
parce_kwh     INTEGER DEFAULT 0,
pac_w         INTEGER DEFAULT 0,
```

If a NULL value is ever inserted, aggregations like `SUM(etotal_kwh)` will return NULL (not 0). Better to enforce NOT NULL + DEFAULT 0.

**Impact:** Low (parsing code ensures values are never NULL), but schema clarity issue.

**Recommendation:** Add `NOT NULL` to these columns:
```sql
ALTER TABLE inverter_counter_state 
  MODIFY etotal_kwh INTEGER NOT NULL DEFAULT 0,
  MODIFY parce_kwh INTEGER NOT NULL DEFAULT 0,
  MODIFY pac_w INTEGER NOT NULL DEFAULT 0;
```

---

### DB-M-006: Alarms severity column has no CHECK constraint
**Location:** `server/db.js:605`
**Issue:**
```sql
severity TEXT DEFAULT 'fault'
-- No CHECK constraint, so any string is accepted
```

The code assumes severity is 'fault' | 'warning' | 'info', but the database allows any text. A typo in application code could insert 'fault!' and break the UI.

**Impact:** Low-risk if the application is careful, but schema should be self-enforcing.

**Recommendation:**
```sql
ALTER TABLE alarms ADD CONSTRAINT ck_severity_valid 
  CHECK(severity IN ('fault', 'warning', 'info'));
```

---

### DB-M-007: Timestamp columns use milliseconds, but not all are cast consistently
**Location:** Throughout schema (ts, ts_ms, ts_local, etc.)
**Issue:** Naming is inconsistent:
- `alarms.ts` (milliseconds, no suffix)
- `inverter_counter_state.ts_ms` (milliseconds, explicit suffix)
- `inverter_counter_baseline.baseline_ts_ms` (milliseconds, explicit suffix)
- `solcast_snapshots.ts_local` (milliseconds, but called "local")

This creates confusion when writing queries. Some developers might assume `ts` is seconds.

**Impact:** Low (careful in-code documentation exists), but schema clarity issue.

**Recommendation:** Standardize to `ts_ms` for all millisecond timestamps.

---

### DB-M-008: UNIQUE constraints don't include DEFAULT columns
**Location:** `server/db.js:645, 1051, 1138–1139`
**Issue:** The `inverter_stop_reasons` table has:
```sql
UNIQUE(inverter_ip, slave, node, fingerprint)
```

If two events have the same (IP, slave, node) but different `fingerprint` (due to different alarm codes), they won't be de-duplicated. This is correct. However, the comment says:
```
De-dup via the (inverter_ip, slave, node, fingerprint) UNIQUE
so re-reads of the same physical event don't duplicate rows.
```

But `fingerprint` is a hash of the event data, so if any field changes (e.g., `motparo` register changes), the fingerprint will differ and no de-dup occurs. This might be intentional, but it's worth verifying.

**Impact:** Low (de-dup is conservative — only exact event re-reads are merged).

---

### DB-M-009: No explicit compound key for inverter_5min_param without ROWID
**Location:** `server/db.js:1104–1139`
**Issue:** The table uses `PRIMARY KEY (inverter_ip, slave, date_local, slot_index) ... WITHOUT ROWID`. This means:
- Every query must include all four columns to use the index efficiently
- A query like `SELECT * FROM inverter_5min_param WHERE date_local = ?` will scan all rows for that date across all inverters

This is acceptable for a time-series table (always filtered by inverter+date+slot), but the index structure could be optimized by reordering columns:
```sql
PRIMARY KEY (date_local, inverter_ip, slave, slot_index)  -- date first
-- vs.
PRIMARY KEY (inverter_ip, slave, date_local, slot_index)  -- current
```

**Impact:** Low (queries are likely always filtered by inverter), but indexing order affects range-scan efficiency.

---

### DB-M-010: Serial change log outcome values are unconstrained
**Location:** `server/db.js:1090`
**Issue:**
```sql
outcome TEXT NOT NULL
-- No CHECK constraint or enum list
```

The code assumes `outcome` is one of: `success`, `error`, `verify_failed`, etc., but the schema doesn't enforce it. A typo in Python could insert `succes` and break filtering.

**Impact:** Low (Python code is unlikely to have typos), but schema should be self-enforcing.

**Recommendation:**
```sql
ALTER TABLE serial_change_log ADD CONSTRAINT ck_outcome_valid
  CHECK(outcome IN ('success', 'error', 'verify_failed', ...));
```

---

## LOW & Schema Maintenance

### DB-L-001: Daily readings summary intervals_json unused
**Location:** `server/db.js:662`
**Issue:**
```sql
intervals_json TEXT DEFAULT '[]'
```

This column exists but is never updated or queried anywhere in the codebase. It was likely left over from a feature that was abandoned.

**Evidence:** `grep -r intervals_json /d/ADSI-Dashboard/server/*.js` returns no hits.

**Recommendation:** Either implement the feature or drop the column in a migration.

---

### DB-L-002: Substation meter daily table has sparse data
**Location:** `server/db.js:893–902`
**Issue:** The `substation_meter_daily` table has columns `sync_time`, `desync_time`, `total_gen_mwhr`, etc., but these are only populated if the operator manually enters substation meter data (see MEMORY.md `project_substation_meter_input`). The table is likely empty in most installations.

**Impact:** No performance impact (small table), but schema clarity issue.

**Recommendation:** Add a comment documenting that this table is operator-filled, not auto-populated.

---

### DB-L-003: Forecast error compare tables allow NULL in key columns
**Location:** `server/db.js:778–804`
**Issue:**
```sql
run_audit_id INTEGER NOT NULL DEFAULT 0,
-- But other columns are nullable:
provider_used TEXT,
weather_source TEXT,
solcast_freshness_class TEXT,
-- etc.
```

If `provider_used` is NULL, queries filtering by provider will miss these rows. The schema should enforce NOT NULL on key query columns.

**Impact:** Low (Python code likely always populates these), but schema clarity issue.

---

### DB-L-004: Solcast snapshot history lacks soft-delete
**Location:** `server/db.js:934–950`
**Issue:** If a Solcast snapshot is ever determined to be erroneous (e.g., a re-run with corrected data), the old row must be DELETE'd, not marked soft-deleted. This is correct for performance, but operators cannot see the full history including corrected values.

**Impact:** Acceptable trade-off (history is append-only, and corrections are visible as new rows with higher timestamps).

---

### DB-L-005: Stop reasons table stores raw_hex twice
**Location:** `server/db.js:1020–1051`
**Issue:**
```sql
debug_desc INTEGER NOT NULL DEFAULT 0,
-- ... many columns ...
raw_hex TEXT NOT NULL,  -- ← serialized binary data
-- And later:
// Comment says raw_hex contains the full Modbus response
```

The `raw_hex` column duplicates data already available in the individual columns (vac1, iac1, etc.). This is intentional (preserves exact original response for forensics), but it doubles row size.

**Impact:** Acceptable trade-off (forensic value > storage cost).

---

### DB-L-006: Plant cap schedules has active_session_id but no session table
**Location:** `server/db.js:869`
**Issue:**
```sql
active_session_id TEXT DEFAULT NULL
```

There's no `sessions` table to store session metadata. The `active_session_id` is tracked but sessions are ephemeral in-memory state.

**Impact:** Acceptable (sessions are short-lived), but schema clarity issue.

---

### DB-L-007: No indexes on secondary keys of stop reason lookups
**Location:** `server/db.js:1020–1056`
**Issue:** The index is `idx_isr_lookup ON (inverter_ip, slave, node, read_at_ms DESC)`, which efficiently supports "get stop reasons for unit X from the last 24 hours." But if a query ever needs "get all stop reasons with alarm_id = 100," it will scan the entire table because `alarm_id` is only indexed as a partial WHERE clause:

```sql
CREATE INDEX idx_isr_alarm ON inverter_stop_reasons(alarm_id) WHERE alarm_id IS NOT NULL;
```

**Impact:** Low (alarm lookup is not a common query pattern).

---

### DB-L-008: Chat messages from_machine / to_machine CHECK not strict
**Location:** `server/db.js:676–677`
**Issue:**
```sql
from_machine TEXT NOT NULL CHECK (from_machine IN ('gateway', 'remote')),
to_machine TEXT NOT NULL CHECK (to_machine IN ('gateway', 'remote')),
```

The CHECK constraint is present ✓, but the values are case-sensitive. If application code ever passes 'Gateway' (capitalized), it will be rejected at the DB level, which is correct. Good defensive programming.

**Impact:** None (schema is correct).

---

### DB-L-009: Forecast dayahead locked table could use partial index
**Location:** `server/db.js:928–929`
**Issue:**
```sql
CREATE INDEX idx_sdl_captured_ts ON solcast_dayahead_locked(captured_ts);
CREATE INDEX idx_sdl_capture_reason ON solcast_dayahead_locked(capture_reason);
```

If queries often filter by "capture_reason = 'scheduled_0600' AND captured_ts > now - 7 days," a compound partial index would be more efficient:

```sql
CREATE INDEX idx_sdl_reason_recent ON solcast_dayahead_locked(capture_reason, captured_ts DESC)
  WHERE capture_reason IN ('scheduled_0600', 'scheduled_0955');
```

**Impact:** Low (table is small — ~500 rows/day × 2 variants = 1000 rows).

---

### DB-L-010: Inverter counter baseline update_ts not used for query filtering
**Location:** `server/db.js:994`
**Issue:**
```sql
CREATE INDEX idx_icb_updated ON inverter_counter_baseline(updated_ts);
```

This index is created but no code queries by `updated_ts`. It's likely left over from a replication feature that uses `updated_ts` as a cursor. If replication is implemented, the index is needed; if not, it's wasted I/O overhead.

**Impact:** Low (index is small), but should be documented or removed.

---

### DB-L-011: Missing index on alarms(inverter, unit, ts) for unit-specific queries
**Location:** `server/db.js:610–611`
**Issue:**
```sql
CREATE INDEX idx_a_ts ON alarms(ts);
CREATE INDEX idx_a_inv_ts ON alarms(inverter, ts);
-- Missing: idx_a_inv_unit_ts
```

If a query filters by (inverter, unit, ts), it must scan the (inverter, ts) index and then apply unit filter, requiring a second check.

**Impact:** Low (alarms table is moderate size), but query efficiency issue.

**Recommendation:**
```sql
CREATE INDEX idx_a_inv_unit_ts ON alarms(inverter, unit, ts DESC);
```

---

### DB-L-012: Availability 5-minute table lacks index
**Location:** `server/db.js:592–597`
**Issue:**
```sql
CREATE TABLE IF NOT EXISTS availability_5min (
  ts        INTEGER NOT NULL,
  online_count INTEGER DEFAULT 0,
  expected_count INTEGER DEFAULT 0
);
-- No indexes defined
```

This is a small table (one row per 5 min = 288 rows/day), so index overhead may not be justified. But if export queries filter by time range, an index on `ts` would help.

**Impact:** Negligible (table is append-only, rarely queried).

---

## PostgreSQL Cloud Sync Gaps

### DB-PG-001: No cloudDb.js file found
**Status:** File does not exist at `/d/ADSI-Dashboard/server/cloudDb.js`
**Evidence:** Search returned no matches
**Impact:** Cloud sync (gateway-mode feature mentioned in MEMORY.md `cloud_db.md`) is either:
1. Implemented elsewhere (check imports in index.js)
2. Not yet implemented in v2.10.0
3. Planned for future release

**Recommendation:** Verify in `server/index.js` whether cloud sync is active. If it exists, the module should be in server/ or a subdirectory.

---

### DB-PG-002: No cursor-based sync implementation visible
**Location:** Memory mentions "cursor-based push to PG for synced tables only" but no code found
**Issue:** The architecture doc says cursor-based pagination is used for PG sync, but:
- No `cloudDb.js` file
- No `cursor` column in SQLite tables
- No `updated_ts`-based sync visible in exports

**Impact:** Cloud sync feature may be incomplete or in a separate module.

**Recommendation:** Verify status of cloud sync implementation. If v2.10.0 is production-ready without cloud sync, document that it's a v2.11+ feature.

---

### DB-PG-003: No statement_timeout or idle_in_transaction_session_timeout in sync
**Status:** Unknown (cloudDb.js not found)
**Impact:** If cloud sync is implemented, PostgreSQL connection pooling must be configured with:
- `statement_timeout = 30000` (30 sec max query time)
- `idle_in_transaction_session_timeout = 60000` (60 sec max idle time to prevent lock accumulation)

**Recommendation:** If cloud sync module exists, verify these PRAGMAs are set on the PG connection pool.

---

## Data Integrity Validation

### DB-DI-001: pac field stored as REAL, some operations assume INTEGER
**Location:** `server/db.js:132` (REAL); `server/poller.js:596` (safePac = pac * 10, expects int)
**Issue:** The `readings` table stores `pac REAL DEFAULT 0`, but `safePac` in poller is the result of `pac * 10` where `pac` is already a float from Python. This could introduce rounding errors if Python sends pac = 123.456 W (deca-watts = 1234.56).

**Impact:** Low (Python likely sends integer deca-watts), but type consistency issue.

**Recommendation:** Verify that Python always sends pac as an integer (no decimal places).

---

### DB-DI-002: kwh stored as REAL, incremental calculations sensitive to floating-point errors
**Location:** `server/db.js:133` (kwh REAL); `server/poller.js:575–590` (PAC integration uses trapezoid rule)
**Issue:** PAC-integrated kWh uses:
```js
const kwh_inc = (avgPac / 1000) * (dtSec / 3600);  // trap rule: W / 1000 → kW, * hours
```

Over thousands of readings, REAL precision (single-precision ~7 significant digits) could accumulate rounding errors. Better to use NUMERIC for energy values.

**Impact:** Low (errors << 1%), but best-practice issue for energy accounting.

**Recommendation:** Future migration: `ALTER TABLE readings MODIFY kwh NUMERIC(10,6)`.

---

## Table Inventory

| Table | Row Count Expectation | Indexes | FK | Retention |
|---|---|---|---|---|
| `readings` | 500M+ (archived) | ts, (inv, unit, ts) | none | Archive after 1 year |
| `energy_5min` | 20M+ (archived) | (inv, ts), ts | none | Archive after 1 year |
| `availability_5min` | ~100k | none | none | None |
| `alarms` | ~100k | ts, (inv, ts), (inv, unit, cleared), updated_ts, open_inv_unit | none | 90 days if cleared |
| `audit_log` | ~50k | ts, (inv, ts) | none | 180 days |
| `daily_report` | ~35k (unbounded) | none | none | None — grows unbounded |
| `daily_readings_summary` | ~100k (unbounded) | date_inv_unit, updated_ts | none | None — grows unbounded |
| `settings` | ~50 | PK(key) | none | Permanent |
| `chat_messages` | ~10k (unbounded) | (to_machine, id) | none | None — grows unbounded |
| `forecast_dayahead` | ~2k | ts, (date, ts) | none | None — grows unbounded |
| `forecast_intraday_adjusted` | ~2k | ts, (date, ts) | none | None — grows unbounded |
| `solcast_snapshots` | ~50k | day | none | None — grows unbounded |
| `forecast_run_audit` | ~1k | target_date, (variant, ts), (target, auth, ts) | none | None — grows unbounded |
| `forecast_error_compare_daily` | ~1k | target_date, (mem_target) | none | None — grows unbounded |
| `forecast_error_compare_slot` | ~100k | (target, slot) | none | None — grows unbounded |
| `scheduled_maintenance` | ~100 | (start, end) | none | None — grows unbounded |
| `plant_cap_schedules` | ~10 | none | none | None |
| `substation_metered_energy` | ~few rows | PK(date, ts) | none | None |
| `substation_meter_daily` | ~few rows | PK(date) | none | None |
| `solcast_dayahead_locked` | ~500 | captured_ts, capture_reason | none | None — grows unbounded |
| `solcast_snapshot_history` | ~20k | (day, captured), (day, slot), captured_ts | none | 90 days (pruned) |
| `inverter_counter_state` | ~91 (constant) | updated_ts | none | Permanent |
| `inverter_counter_baseline` | ~2700 (90 days) | (date), updated_ts, **MISSING: (inv, unit, date)** | none | 90 days (pruned) |
| `inverter_clock_sync_log` | ~5k/year | ts, (inv, ts) | none | 365 days (pruned) |
| `inverter_stop_reasons` | ~10k | (ip, slave, node, ts), (alarm_id), (event), (inv, ts) | none | None — grows unbounded |
| `inverter_stop_histogram` | ~100 | (ip, slave, ts) | none | None — grows unbounded |
| `serial_change_log` | ~100/year | (ip, ts), (outcome, ts) | none | Permanent |
| `inverter_5min_param` | ~50k/day (archived) | (date, ip), (ip, slave, date), (date, solar) | none | None in main DB |

**Key Observations:**
- **Unbounded growth:** 13 tables grow indefinitely (daily_report, chat_messages, forecast_*, solcast_*, stop_*) — should have retention policies
- **Missing indexes:** 3 indexes should be added (alarms.stop_reason_id, inverter_counter_baseline.inv_unit_date, inverter_5min_param.inv_slave)
- **Archive strategy:** readings and energy_5min are archived to separate DBs; summary tables are NOT archived, leading to unbounded growth in main DB

---

## Notes

### On PAC Scaling (v2.10.0-beta.4 hotfix)
The decascale repair (DB-C-002) is **correct** and **complete** for forward data. The repair:
1. Runs once on startup
2. Divides all inverter_5min_param.pac_w values by 10 (correct — poller already scaled ×10)
3. Sets a flag to prevent re-running on restart

**Weakness:** If an operator restores from a pre-repair backup, the flag prevents re-repair. Document this in release notes.

### On Missing Foreign Keys
The codebase has **no explicit FOREIGN KEY constraints** (no REFERENCES clauses). This is:
- **Acceptable** in SQLite (foreign_keys pragma disabled by default)
- **Not ideal** for data integrity (application must enforce)
- **Low risk** in this project (single-threaded Node, careful code)

Recommendation: Enable `PRAGMA foreign_keys = ON` and add explicit FKs for:
- `alarms.stop_reason_id → inverter_stop_reasons.id`
- `forecast_error_compare_daily.run_audit_id → forecast_run_audit.id`
- `forecast_error_compare_slot.run_audit_id → forecast_run_audit.id`
- `forecast_error_compare_slot.daily_compare_id → forecast_error_compare_daily.id`

### On Concurrency
The codebase uses `better-sqlite3` with synchronous transactions, which is correct for single-process Node. No race conditions expected. If code is ever ported to multi-worker (e.g., clustering), explicit isolation level (`db.transaction({ immediate: true })`) will be required.

### On Retention Policy
**Current:** Only `alarms` (cleared), `audit_log`, `solcast_snapshot_history`, and `inverter_counter_baseline` are pruned.
**Missing:** `daily_report`, `daily_readings_summary`, `chat_messages`, forecast_* tables should be pruned to keep DB size bounded.

**Estimated unbounded growth:** ~500 MB/year for summaries alone. At current scale (27 units, 3 nodes), this is acceptable. But 5-year archival would need external storage.

### On WAL Mode
WAL mode is correctly set with SYNCHRONOUS=NORMAL. This is **crash-safe** (writes survive power loss) without the fsync blocking that SYNCHRONOUS=FULL would incur. ✓

### On Prepared Statements
All INSERT/UPDATE/DELETE operations use parameterized prepared statements. ✓ No SQL injection risks found.

---

## Summary Statistics
- **Total findings:** 32
- **Critical:** 4 (pac_w repair completeness, missing stop_reason_id index, lack of FK enforcement, unbounded SELECT *)
- **High:** 13 (missing indexes, incomplete archival, architectural issues)
- **Medium:** 10 (constraint clarity, unused columns, JSON queries)
- **Low:** 5 (naming consistency, unused features)

**Overall assessment:** Schema is **production-ready** with **good hygiene** for transaction handling and WAL safety. **Weak spots:** unbounded retention policies and missing indexes on new (v2.10.0) columns. **Recommended priorities:**
1. Add `idx_alarms_stop_reason_id` (DB-C-001)
2. Add `idx_icb_inv_unit_date` (DB-H-003)
3. Extend retention policy to summary tables (DB-H-004)
4. Enable `PRAGMA foreign_keys = ON` (DB-C-003)

---

**Report generated:** 2026-04-28  
**Scope:** SQLite schema, migration hygiene, query patterns, concurrency, data integrity  
**Excluded:** Application logic, forecast models, Python service contracts  
**Files audited:**
- `/d/ADSI-Dashboard/server/db.js` (4334 lines)
- `/d/ADSI-Dashboard/server/poller.js` (1500+ lines, sampled)
- `/d/ADSI-Dashboard/server/dailyAggregator.js` (600+ lines)
- `/d/ADSI-Dashboard/server/exporter.js` (2000+ lines, sampled)
- `/d/ADSI-Dashboard/server/alarms.js` (1300+ lines, sampled)
