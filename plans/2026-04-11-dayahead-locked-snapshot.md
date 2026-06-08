# Day-Ahead Locked Snapshot + Analytics Chart + Active Learning

**Date:** 2026-04-11
**Status:** DRAFT — awaiting review
**Author:** Claude (session 2026-04-11)
**Target version:** v2.8.x
**Related:** [rainy-overcast-error-memory-hardening.md](2026-04-10-rainy-overcast-error-memory-hardening.md)

---

## 1. Problem statement

Solcast's day-ahead forecast at this plant is **structurally conservative** on
convective/rainy days — a known artifact of NWP-driven day-ahead models that
smooth out small convective features. Solcast's intraday nowcast (which switches
to live geostationary satellite imagery) is substantially more accurate and
"collapses" toward reality as the day unfolds.

The dashboard currently has **three data-loss issues** that together prevent
the system from learning this pattern:

1. **Day-ahead forecasts are overwritten by intraday updates.** The
   `solcast_snapshots` table has `PRIMARY KEY (forecast_day, slot)`, so every
   Solcast pull does an upsert that destroys the prior prediction.
   ([server/db.js:517-536](../server/db.js#L517-L536))

2. **Past-day forecasts are erased entirely.** Verified via audit on
   2026-04-11: rows for 2026-04-10 have `p50 = p10 = p90 = NULL` while
   `est_actual_mw` is populated. The day-ahead prediction that was actually
   submitted to WESM is gone.

3. **No append-only history of the day-ahead → intraday evolution exists.**
   We cannot measure the band-collapse trajectory, cannot compute bias vs
   lead-time, and cannot train on "what we knew at 10 AM" vs "what happened".

The error memory system described in
[rainy-overcast-error-memory-hardening.md](2026-04-10-rainy-overcast-error-memory-hardening.md)
is therefore learning from the **wrong signal**: "latest snapshot before
forecast run" vs actual, rather than "10 AM locked day-ahead" vs actual. On
high-volatility days these are materially different numbers.

## 2. User requirements (decisions captured 2026-04-11)

| # | Question | Decision |
|---|---|---|
| 1 | Which `forecast_day` gets locked at 10 AM? | **(b)** Tomorrow (day D+1) — matches WESM FAS day-ahead submission reality. At 10 AM on day D, capture Solcast's prediction for day D+1. |
| 2 | Plot plant actual generation on the chart? | Yes |
| 3 | Plot the dashboard's final ML forecast? | Yes |
| 4 | Historical view? | Yes — arbitrary date picker (assumed; confirm in review) |
| 5 | Snapshot history granularity? | Append to history on **every Solcast network pull** (not every 5 min — actual pull cadence is 5–10/day driven by existing auto-fetch schedule). Retain 90 days. |
| 6 | Backfill? | Yes — from `adsi_backup_1.db` (April 3 backup, 2049 tri-band rows), honestly labeled as `capture_reason = 'backfill_approx'`. **No backfill possible from archive DBs** — they don't contain solcast data. |
| 7 | Research vs active mode? | **Active mode** — apply the learning loop immediately. User reasoning: ML is continuous, not batch, so locked snapshots are just another signal plugged into the existing learning loop. |

## 3. Architecture overview

```
                  ┌────────────────────────────────┐
                  │ Existing Solcast auto-fetch    │
                  │ (autoFetchSolcastSnapshots)    │
                  │ cadence: 04:30, 09:30, 18:30,  │
                  │          20:00, 22:00, manual  │
                  └───────────┬────────────────────┘
                              │
                              ├──► solcast_snapshots        (existing, overwrite)
                              │    = "latest state"
                              │
                              └──► solcast_snapshot_history (NEW, append-only)
                                   = "every pull, forever (90d retention)"

  ┌────────────────────────────────┐
  │ Day-ahead lock scheduler       │
  │ cron: 06:00 and 09:55 local    │
  │ (runs INSIDE existing pre-10AM │
  │  scheduler window)             │
  │                                │
  │ captureDayAheadSnapshot(D+1)   │
  └───────────┬────────────────────┘
              │
              │  read-only SELECT from solcast_snapshots for forecast_day=D+1
              │
              └──► solcast_dayahead_locked (NEW, immutable, first-write-wins)
                   = "frozen 10 AM prediction"
                   PRIMARY KEY (forecast_day, slot)
                   INSERT OR IGNORE — later calls are no-ops
```

## 4. Schema (new tables, no changes to existing)

### 4.1 `solcast_dayahead_locked` — immutable frozen day-ahead

```sql
CREATE TABLE IF NOT EXISTS solcast_dayahead_locked (
  forecast_day     TEXT    NOT NULL,   -- YYYY-MM-DD the forecast is FOR
  slot             INTEGER NOT NULL,   -- 0..287 (5-min slot of day)
  ts_local         INTEGER NOT NULL,   -- Unix ms, start of slot in Asia/Manila
  period_end_utc   TEXT,
  period           TEXT,                -- e.g. "PT5M"

  -- Forecast values (MW)
  p50_mw           REAL,
  p10_mw           REAL,
  p90_mw           REAL,
  p50_kwh          REAL,
  p10_kwh          REAL,
  p90_kwh          REAL,

  -- Pre-computed derived fields (avoid re-computing on every chart render)
  spread_mw        REAL,               -- p90_mw - p10_mw
  spread_pct_cap   REAL,               -- spread_mw / plant_cap_mw * 100
                                        -- (robust; does NOT divide by p50)

  -- Capture metadata
  captured_ts      INTEGER NOT NULL,   -- Unix ms when we froze this
  captured_local   TEXT    NOT NULL,   -- "YYYY-MM-DDTHH:MM:SS" Asia/Manila
  capture_reason   TEXT    NOT NULL,   -- 'scheduled_0600' | 'scheduled_0955'
                                        -- | 'manual' | 'backfill_approx'
  solcast_source   TEXT    NOT NULL,   -- 'toolkit' | 'api'
  plant_cap_mw     REAL,               -- plant capacity at capture time
                                        -- (for historical reproducibility)

  PRIMARY KEY (forecast_day, slot)
);

CREATE INDEX IF NOT EXISTS idx_sdl_captured_ts
  ON solcast_dayahead_locked(captured_ts);
```

**Write rule:** `INSERT OR IGNORE` only. **Never update.** The first successful
capture per `(forecast_day, slot)` wins and is frozen forever. If the 06:00
capture succeeds, the 09:55 capture is a no-op. If 06:00 fails, 09:55 is the
fallback.

**`spread_pct_cap` rationale:** audit showed `(p90-p10)/p50*100` produces
values up to 12,000% because P50 approaches zero at dawn/dusk. Normalizing by
plant capacity (~26.4 MW) gives a stable 0–100 range that's interpretable as
"uncertainty as fraction of nameplate".

### 4.2 `solcast_snapshot_history` — append-only pull log

```sql
CREATE TABLE IF NOT EXISTS solcast_snapshot_history (
  forecast_day     TEXT    NOT NULL,
  slot             INTEGER NOT NULL,
  captured_ts      INTEGER NOT NULL,   -- unique per pull (autoFetchSolcastSnapshots call time)
  pulled_ts        INTEGER NOT NULL,   -- Solcast's own pulled_ts for the record
  p50_mw           REAL,
  p10_mw           REAL,
  p90_mw           REAL,
  est_actual_mw    REAL,
  age_sec          INTEGER,            -- at capture time, how old was Solcast's data
  solcast_source   TEXT,
  PRIMARY KEY (forecast_day, slot, captured_ts)
);

CREATE INDEX IF NOT EXISTS idx_ssh_day_captured
  ON solcast_snapshot_history(forecast_day, captured_ts);
CREATE INDEX IF NOT EXISTS idx_ssh_day_slot
  ON solcast_snapshot_history(forecast_day, slot);
```

**Write rule:** Every successful `autoFetchSolcastSnapshots()` call appends
rows for all slots in the pulled days. No deduplication. No upsert.

**Retention:** 90 days. A daily housekeeping job (`pruneSolcastHistory()`)
deletes rows where `captured_ts < now - 90d`. Hooked into the existing
nightly cleanup cron.

**Storage estimate:**
- Pull cadence: ~6 network pulls/day (per existing auto-fetch schedule)
- Rows per pull: ~2 forecast_days × 288 slots = 576 rows
- Daily growth: ~3,500 rows/day
- 90-day retention: ~315,000 rows ≈ ~30 MB uncompressed

Trivial vs the current 327 MB `adsi.db`.

### 4.3 `forecast_error_compare_daily` / `_slot` — extend existing

Add columns to the existing error-compare tables (used by
`compute_error_memory()`):

```sql
ALTER TABLE forecast_error_compare_slot ADD COLUMN p50_locked_mw REAL;
ALTER TABLE forecast_error_compare_slot ADD COLUMN p10_locked_mw REAL;
ALTER TABLE forecast_error_compare_slot ADD COLUMN p90_locked_mw REAL;
ALTER TABLE forecast_error_compare_slot ADD COLUMN spread_pct_cap_locked REAL;
ALTER TABLE forecast_error_compare_slot ADD COLUMN err_vs_p50_locked_mw REAL;
ALTER TABLE forecast_error_compare_slot ADD COLUMN err_vs_p10_locked_mw REAL;
ALTER TABLE forecast_error_compare_slot ADD COLUMN err_vs_p90_locked_mw REAL;
ALTER TABLE forecast_error_compare_slot ADD COLUMN actual_within_band INTEGER;
                                                  -- 1 if p10 <= actual <= p90, else 0
```

These are populated by the post-day QA job that already runs — just read
from `solcast_dayahead_locked` instead of (or in addition to) the live
`solcast_snapshots`.

## 5. Capture logic

### 5.1 New function: `captureDayAheadSnapshot(forecastDay, reason)`

Location: new file `server/dayAheadLock.js` (keeps `server/index.js` from
growing further — it's already 14k+ lines).

Pseudocode:

```js
async function captureDayAheadSnapshot(forecastDay, reason) {
  // 1. Read from solcast_snapshots for this forecast_day
  const rows = stmts.getSolcastSnapshotDay.all(forecastDay);
  if (!rows.length) {
    log('[dayahead-lock] no snapshot rows for', forecastDay);
    return { ok: false, reason: 'no_data' };
  }

  // 2. Check if already locked (first-write-wins)
  const existing = db.prepare(
    'SELECT COUNT(*) AS n FROM solcast_dayahead_locked WHERE forecast_day = ?'
  ).get(forecastDay);
  if (existing.n > 0) {
    return { ok: true, reason: 'already_locked', count: existing.n };
  }

  // 3. Compute derived fields (spread, plant cap)
  const plantCapMw = computePlantMaxKwFromConfig() / 1000;
  const now = Date.now();
  const nowLocal = formatLocal(now);

  // 4. Insert OR IGNORE all slots atomically
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO solcast_dayahead_locked
      (forecast_day, slot, ts_local, period_end_utc, period,
       p50_mw, p10_mw, p90_mw, p50_kwh, p10_kwh, p90_kwh,
       spread_mw, spread_pct_cap,
       captured_ts, captured_local, capture_reason, solcast_source, plant_cap_mw)
    VALUES (@forecast_day, @slot, @ts_local, @period_end_utc, @period,
            @p50, @p10, @p90, @p50_kwh, @p10_kwh, @p90_kwh,
            @spread_mw, @spread_pct_cap,
            @captured_ts, @captured_local, @reason, @source, @cap)
  `);

  const txn = db.transaction((rows) => {
    for (const r of rows) {
      const spreadMw = (r.forecast_hi_mw ?? 0) - (r.forecast_lo_mw ?? 0);
      const spreadPctCap = plantCapMw > 0
        ? (spreadMw / plantCapMw) * 100
        : null;
      insertStmt.run({
        forecast_day: r.forecast_day,
        slot: r.slot,
        ts_local: r.ts_local,
        period_end_utc: r.period_end_utc,
        period: r.period,
        p50: r.forecast_mw,
        p10: r.forecast_lo_mw,
        p90: r.forecast_hi_mw,
        p50_kwh: r.forecast_kwh,
        p10_kwh: r.forecast_lo_kwh,
        p90_kwh: r.forecast_hi_kwh,
        spread_mw: spreadMw,
        spread_pct_cap: spreadPctCap,
        captured_ts: now,
        captured_local: nowLocal,
        reason: reason,
        source: r.source,
        cap: plantCapMw,
      });
    }
  });
  txn(rows);

  return { ok: true, count: rows.length };
}
```

### 5.2 Scheduler hooks

Add two cron entries to existing scheduler (uses node-schedule or similar,
already wired for existing crons at `04:30 09:30 18:30 20:00 22:00`):

```js
// 06:00 local — primary day-ahead lock attempt
schedule.scheduleJob('0 6 * * *', async () => {
  const tomorrow = addDaysLocal(today(), 1);
  const result = await captureDayAheadSnapshot(tomorrow, 'scheduled_0600');
  logForecastRunAudit({ type: 'dayahead_lock_attempt', ...result });
});

// 09:55 local — fallback if 06:00 failed or Solcast hadn't pulled yet
schedule.scheduleJob('55 9 * * *', async () => {
  const tomorrow = addDaysLocal(today(), 1);
  const result = await captureDayAheadSnapshot(tomorrow, 'scheduled_0955');
  logForecastRunAudit({ type: 'dayahead_lock_attempt', ...result });
});
```

**Why two times:**
- 06:00 is the primary target — gives Solcast overnight NWP pull plenty of time to land.
- 09:55 is the fallback — runs 5 min before the 10 AM WESM FAS deadline, ensures
  we get *something* before the deadline even if 06:00 had a network error.
- Because the insert is `OR IGNORE`, the 09:55 call is a harmless no-op when 06:00 succeeded.

**Pre-capture trigger:** both cron hooks should first call
`autoFetchSolcastSnapshots([tomorrow])` to ensure the solcast_snapshots table
has *a* pull before we freeze from it. Existing function, already there.

### 5.3 History append hook

Extend `autoFetchSolcastSnapshots()` at
[server/index.js:10094](../server/index.js#L10094) to append to
`solcast_snapshot_history` after every successful pull. Single new helper
function, ~30 lines. No change to existing behavior.

## 6. Backfill procedure

### 6.1 Source: `adsi_backup_1.db` (Apr 3 snapshot)

Contains 2,049 tri-band rows covering 2026-03-14 to 2026-04-06. One-shot
migration script: `scripts/backfill_dayahead_locked.py`.

```
python scripts/backfill_dayahead_locked.py --source backup_apr03 --dry-run
python scripts/backfill_dayahead_locked.py --source backup_apr03 --apply
```

**Honesty constraint:** rows backfilled from the April 3 backup are **not**
10 AM locked snapshots. They represent Solcast's state at Apr 3 22:37. They
are labeled `capture_reason = 'backfill_approx'` and `captured_ts` = 1712158620000
(Apr 3 22:37 UTC). Downstream consumers MUST filter on `capture_reason` if
they want only real locked snapshots.

For the **active learning loop**, backfilled rows are weighted at 0.3x
(vs 1.0x for real locked snapshots) to reflect their reduced fidelity.

### 6.2 Rows to skip
- Rows where `forecast_mw IS NULL` (est_actual-only rows, forecasted-past)
- Rows where `forecast_day < '2026-04-04'` (backup was taken ~22:37 on Apr 3,
  so anything before Apr 4 in the backup is already historical from the
  backup's own perspective — not a useful day-ahead)

Expected backfill yield: ~3 days × ~144 slots ≈ ~432 usable rows.

### 6.3 Forward-looking note
After this plan ships, the backup rotation
(`adsi_backup_0.db` / `adsi_backup_1.db`) continues, but we no longer
*need* it for backfill — `solcast_dayahead_locked` is the authoritative
record going forward.

## 7. API endpoint

New route: `GET /api/analytics/dayahead-chart?date=YYYY-MM-DD`

**Response shape:**

```json
{
  "ok": true,
  "date": "2026-04-11",
  "locked": {
    "captured_ts": 1712808000000,
    "captured_local": "2026-04-10T06:00:03",
    "capture_reason": "scheduled_0600",
    "spread_pct_cap_avg": 8.4,
    "spread_pct_cap_max": 22.1,
    "rows": [
      { "slot": 0, "ts_local": ..., "p50_mw": 0.0, "p10_mw": 0.0, "p90_mw": 0.0 },
      ...
      { "slot": 144, "ts_local": ..., "p50_mw": 12.4, "p10_mw": 8.1, "p90_mw": 18.3 }
    ]
  },
  "intraday_solcast": {
    "rows": [
      { "slot": 0, "est_actual_mw": 0.0 },
      ...
    ]
  },
  "plant_actual": {
    "rows": [
      { "slot": 0, "actual_mw": 0.0 },
      ...
    ]
  },
  "ml_final": {
    "rows": [
      { "slot": 0, "ml_mw": 0.0 },
      ...
    ]
  },
  "meta": {
    "plant_cap_mw": 26.4,
    "actual_total_mwh_so_far": 89.3,
    "p50_total_mwh": 147.2,
    "variance_vs_p50_pct": 3.2,
    "actual_within_band_so_far_pct": 92.3
  }
}
```

All 4 series aligned on the same slot grid (0..287 for 5-min, or aggregated
to 0..23 for hourly). Client-side Chart.js renders directly from this.

**Data sources:**
- `locked.*` ← `solcast_dayahead_locked` WHERE forecast_day = date
- `intraday_solcast.*` ← `solcast_snapshots.est_actual_mw` WHERE forecast_day = date
- `plant_actual.*` ← existing energy aggregation (PAC-based) for the date
- `ml_final.*` ← existing `forecast_intraday_adjusted` + any other ML output tables

## 8. Frontend chart (analytics section)

Location: analytics tab, new panel below the existing Forecast Performance Monitor.

HTML skeleton (add to [public/index.html](../public/index.html) near existing
analytics panels):

```html
<div class="analytics-dayahead-wrap" id="anaDayAheadWrap">
  <div class="analytics-side-label">Day-Ahead vs Reality — Locked @ Previous 10 AM</div>
  <div class="ana-dayahead-header">
    <span id="anaDayAheadCaptured">captured: —</span>
    <span id="anaDayAheadSpread">spread: —</span>
    <span id="anaDayAheadWithinBand">—</span>
  </div>
  <div class="ana-dayahead-chart-box">
    <canvas id="chartDayAhead"></canvas>
  </div>
  <div class="ana-dayahead-empty" id="anaDayAheadEmpty" style="display:none">
    No locked day-ahead snapshot for this date.
  </div>
</div>
```

JS (new function in [public/js/app.js](../public/js/app.js), analytics section):

```js
async function loadDayAheadChart(date) {
  const payload = await api(`/api/analytics/dayahead-chart?date=${date}`);
  if (!payload?.ok) return;
  renderDayAheadChart(payload);
}

function renderDayAheadChart(payload) {
  // Destroy previous chart instance
  if (State.dayAheadChart) {
    State.dayAheadChart.destroy();
    State.dayAheadChart = null;
  }

  const canvas = $("chartDayAhead");
  const locked = payload.locked || {};
  const rows = locked.rows || [];
  const intraday = payload.intraday_solcast?.rows || [];
  const actual = payload.plant_actual?.rows || [];
  const ml = payload.ml_final?.rows || [];

  const labels = rows.map(r => slotToHHMM(r.slot));
  const p50 = rows.map(r => r.p50_mw);
  const p10 = rows.map(r => r.p10_mw);
  const p90 = rows.map(r => r.p90_mw);

  State.dayAheadChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // Confidence band: rendered as p90 line with fill to p10
        { label: 'P90 (day-ahead)', data: p90,
          borderColor: 'rgba(80,130,220,0.35)', borderDash: [4,3],
          backgroundColor: 'rgba(80,130,220,0.12)',
          fill: '+1',  // fill to next dataset (p10)
          pointRadius: 0, tension: 0.3 },
        { label: 'P10 (day-ahead)', data: p10,
          borderColor: 'rgba(80,130,220,0.35)', borderDash: [4,3],
          fill: false, pointRadius: 0, tension: 0.3 },

        // P50 solid
        { label: 'P50 (day-ahead, locked)', data: p50,
          borderColor: '#3b82f6', borderWidth: 2.2,
          fill: false, pointRadius: 0, tension: 0.3 },

        // Intraday est_actual
        { label: 'Solcast intraday', data: alignToSlots(intraday, 'est_actual_mw'),
          borderColor: '#f59e0b', borderWidth: 1.8,
          fill: false, pointRadius: 0, tension: 0.3 },

        // Plant actual
        { label: 'Plant actual', data: alignToSlots(actual, 'actual_mw'),
          borderColor: '#10b981', borderWidth: 2.0,
          fill: false, pointRadius: 0, tension: 0.3 },

        // ML final
        { label: 'ML final', data: alignToSlots(ml, 'ml_mw'),
          borderColor: '#a855f7', borderWidth: 1.4, borderDash: [2,2],
          fill: false, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: { /* responsive, tooltip, legend, etc. — match existing charts */ },
  });

  // Header text
  $("anaDayAheadCaptured").textContent =
    `captured: ${locked.captured_local || '—'} (${locked.capture_reason || '—'})`;
  $("anaDayAheadSpread").textContent =
    `spread: ${fmtPct(locked.spread_pct_cap_avg)} avg / ${fmtPct(locked.spread_pct_cap_max)} max`;
  $("anaDayAheadWithinBand").textContent =
    `${fmtPct(payload.meta?.actual_within_band_so_far_pct)} of actual within band`;
}
```

**Refresh cadence:** wire into existing `ensureAnalyticsAutoRefresh()` 60 s
timer at [public/js/app.js:13665](../public/js/app.js#L13665). Reads from
local DB only, zero network cost.

**Date picker:** reuse existing `anaDate` picker. When user changes date, call
`loadDayAheadChart(date)` alongside the existing analytics loaders.

## 9. Active learning loop integration

Once `solcast_dayahead_locked` starts filling up, these existing learning
components switch to the locked snapshot:

### 9.1 `compute_error_memory()` — spread-weighted

Current behavior: weights errors by recency × regime × source quality.

New behavior (in `services/forecast_engine.py` near line 3695 where
error memory lives):

```python
def compute_error_memory(day, regime, ...):
    # Existing logic reads from forecast_error_compare_*
    rows = load_error_compare_rows(...)

    for r in rows:
        # NEW: if locked snapshot exists, prefer it over legacy latest-snapshot error
        if r.err_vs_p50_locked_mw is not None:
            err = r.err_vs_p50_locked_mw
            # Wide spread → lower confidence in the learning signal
            spread = r.spread_pct_cap_locked or 0
            spread_weight = max(0.3, 1.0 - spread / 100.0)  # 0.3 floor
        else:
            # Legacy path
            err = r.err_mw
            spread_weight = 1.0

        # Existing recency/regime/source weights
        weight = recency_weight * regime_weight * source_weight * spread_weight
        ...
```

**Rationale:** wide-band day-ahead forecasts were inherently uncertain to
begin with — a big error on those days isn't a strong signal that the model
is biased, just that the day was volatile. Narrow-band misses are the real
learning signal.

### 9.2 ML training feature swap

At the training data assembly path (feature engineering for LightGBM),
replace "Solcast at generation time" features with locked-snapshot features:

- `solcast_kwh_locked` (was: `solcast_kwh`)
- `solcast_lo_kwh_locked` (was: `solcast_lo_kwh`)
- `solcast_hi_kwh_locked` (was: `solcast_hi_kwh`)
- `solcast_spread_pct_cap_locked` (NEW)
- `hours_since_lock` (NEW — always ~24 for day-ahead use, but useful for research)

Feature count: 70 → 72 (adds `spread_pct_cap_locked` and `hours_since_lock`).
Legacy models auto-align with zero-spread fallback as they do in v2.5.0+.

**Fallback during rollout:** if `solcast_dayahead_locked` has no row for a
(forecast_day, slot), fall back to the legacy feature values. This lets the
system keep training during the 30-day accumulation window without a hard cutover.

### 9.3 Rainy-regime hardening (from other plan)

Relax the 10% rainy Solcast damping to 25–30% **once 30 days of locked
history accumulate** and the spread-weighted error memory is validated.
The damping was conservative specifically because the legacy error signal
couldn't distinguish "Solcast was wrong" from "day was uncertain". With
spread weighting, the signal is cleaner and less damping is safe.

See [rainy-overcast-error-memory-hardening.md](2026-04-10-rainy-overcast-error-memory-hardening.md)
for the current damping logic.

### 9.4 WESM submission risk (optional, future)

Once we have 30+ locked days, we can start measuring: for each day, where
inside the P10–P90 band did the actual outcome land? Over time this yields
a histogram that reveals systematic bias, e.g.:

> "On convective-regime days with spread > 15%, actuals land at P70 on
> average — Solcast's P50 is underestimating by 4.2 MWh/day."

This information can drive a **submission-time bias correction**: at 10 AM,
before submitting to WESM, apply the learned bias based on the day's
regime classification and spread. Not in scope for this plan — flagged for
a future v2.9 feature.

## 10. Execution order

Each step is independently shippable and reversible. Numbered for
dependency order, not calendar.

| # | Step | Deliverable | Est. size | Risk |
|---|---|---|---|---|
| 1 | **Schema migration** | Add `solcast_dayahead_locked`, `solcast_snapshot_history`, ALTER `forecast_error_compare_slot`. Migration script in `server/db.js` | ~80 lines | Low — additive only |
| 2 | **`captureDayAheadSnapshot()` helper** | New file `server/dayAheadLock.js`. Unit test with fixture rows. | ~150 lines | Low |
| 3 | **Scheduler hooks** | Cron entries at 06:00 and 09:55, pre-capture `autoFetchSolcastSnapshots([tomorrow])` call | ~30 lines | Low |
| 4 | **History append hook** | Extend `autoFetchSolcastSnapshots` to append every pull to `solcast_snapshot_history` | ~30 lines | Low |
| 5 | **90-day prune cron** | Daily housekeeping deletes rows older than 90 days | ~20 lines | Low |
| 6 | **Backfill script** | One-shot `scripts/backfill_dayahead_locked.py` reads `adsi_backup_1.db`, inserts with `capture_reason='backfill_approx'` | ~120 lines | Low — read-only on backup |
| 7 | **Analytics API** | `GET /api/analytics/dayahead-chart?date=...` returning 4-series payload | ~200 lines | Low |
| 8 | **Frontend chart** | New panel in analytics tab, Chart.js with P10/P50/P90 band + 3 additional lines | ~150 lines | Low |
| 9 | **60 s refresh wire-up** | Add `loadDayAheadChart()` to existing `ensureAnalyticsAutoRefresh()` | ~10 lines | Low |
| 10 | **Post-day QA extension** | Populate `err_vs_p50_locked_mw`, `err_vs_p10_locked_mw`, etc. in the nightly error-compare job | ~60 lines | Medium — touches existing QA |
| 11 | **Spread-weighted `compute_error_memory()`** | Python: read `spread_pct_cap_locked`, apply spread_weight | ~40 lines | Medium — affects learning loop |
| 12 | **ML training feature swap** | Python: `build_features()` reads locked snapshots, adds `spread_pct_cap_locked` and `hours_since_lock` | ~80 lines | Medium — FEATURE_COLS 70→72, legacy-model fallback required |
| 13 | **Rainy-regime damping relaxation** | Separate flag, activated only after 30 days of locked history | ~15 lines | Medium — deferred to 30-day mark |

**Ship order:** 1 → 2 → 3 → 4 → 5 (foundation) → 6 (backfill) → 7 → 8 → 9
(user-visible) → 10 → 11 → 12 → 13 (learning loop).

Stages 1–9 are user-visible and deliver the chart. Stages 10–13 activate the
learning loop. They can ship in one release or several.

## 11. Risks and unknowns

| Risk | Mitigation |
|---|---|
| 06:00 cron fires before Solcast has pulled tomorrow's forecast | Pre-capture call to `autoFetchSolcastSnapshots([tomorrow])` guarantees a fresh pull; 09:55 fallback covers failures |
| Solcast Toolkit scraper breaks (prior probe showed HTML structure matches current code) | Existing monitor already detects this; capture returns `{ ok: false, reason: 'no_data' }` and audit logs |
| Spread-weighting makes error memory too passive | Floor at 0.3x prevents full cancellation; monitor `forecast_error_compare_*` aggregate error after rollout |
| Backfilled rows contaminate learning | `capture_reason='backfill_approx'` + 0.3x weight in learning loop; consumer can filter |
| Feature count change (70 → 72) breaks legacy ML models | Existing auto-alignment logic at v2.5.0+ handles this — add zero-spread fallback for the two new columns |
| 90-day history table grows unexpectedly | Retention cron + size monitor in Forecast Performance panel |
| User wants small multiples in Q4 clarification but we built date picker | Small multiples are a later view, additive to the date picker — not mutually exclusive |

## 12. Open questions (need user confirmation)

1. **Q4 clarification:** historical view — was "yes" for (a) arbitrary date picker, (b) small multiples week view, or (c) both? Plan assumes (a) for v1. Confirm.
2. **Forecast_day = D+1 semantics:** chart for "date X" in the UI shows:
   - The **locked snapshot captured on X-1 at 10 AM** (predicting day X)
   - vs the **intraday/actual that unfolded on day X**
   Is this the right UX, or should the date picker show "snapshot date" (X-1) and chart the predicted day (X)?
3. **Plant actual units:** the chart is in MW. Plant actual is pulled from energy tables — need to confirm the per-slot MW basis matches (5-min slot mean vs instantaneous vs integrated-kWh-divided-by-slot-dt). Audit required during implementation.
4. **ML final line:** which table(s) feed this? `forecast_intraday_adjusted` is one. Others?
5. **Error classifier (already-trained 180-day model):** does it need retraining on locked data? Session notes flagged it as "static ML pattern recognition, not adaptive". Not retraining keeps scope small for this plan but flagging for future.
6. **Backfill scope:** only `adsi_backup_1.db`, or also scan `cloud_backups/` folder for older snapshots? Cloud backups weren't checked during audit.

## 13. Out of scope (for this plan)

- **New Solcast API calls.** Everything uses existing snapshot data.
- **Schema change to `solcast_snapshots`.** Leave existing table alone.
- **WESM submission-time bias correction.** Deferred to a future plan after 30 days of locked data accumulates.
- **Retraining the error classifier.** Static ML, keeps current behavior.
- **UI for browsing `solcast_snapshot_history`.** Table is for research and learning loop only, no direct UI.
- **Weather chart replacement** (Open-Meteo → Solcast-derived). Separate proposal, independent of this.

---

## Approval checklist

- [ ] User confirms Q4 interpretation (arbitrary date picker)
- [ ] User confirms Q12.2 date semantics (forecast day = chart date)
- [ ] User agrees on 06:00 + 09:55 capture times
- [ ] User agrees on 90-day history retention
- [ ] User agrees with the 13-step execution order
- [ ] User approves starting with step 1 (schema migration)

Once approved, implementation begins at step 1. Each step gets its own
commit and passes `npm run smoke` before proceeding.
