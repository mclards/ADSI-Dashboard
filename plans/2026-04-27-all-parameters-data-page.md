# All Parameters Data — Replace Energy Page + Daily-Data Export Blueprint

**Date:** 2026-04-27
**Author:** Claude Code (architecture spike, no production source modified)
**Status:** Blueprint awaiting operator review. No code changes yet.
**Replaces:** existing Energy page (`#page-energy`)
**Related:** [plans/2026-04-27-ism-daily-data-export-study.md](2026-04-27-ism-daily-data-export-study.md) — protocol-decode foundation that proved we already capture everything ISM's "Reading → Daily data" shows

---

## 0. TL;DR

Build a dashboard-native equivalent of ISM's "Reading → Daily data" that doesn't depend on the comm-board-only vendor protocol.

- **New page** at the existing Energy nav slot: **"All Parameters Data"** — inverter picker + date picker + 4 tabs (Node 1..N, dynamic from ipconfig). Live mode when date == today; historical mode otherwise. Blank by default until an inverter is picked.
- **New aggregator** in Node that bucketizes the existing 50-ms WS poll stream into 5-minute slots and persists them to a new `inverter_5min_param` SQLite table.
- **Solar-window clipping** — both the on-screen table and exports only show samples in `[solarWindowStartHour, eodSnapshotHourLocal)` (defaults 05:00..18:00, operator-tunable).
- **Today-export restriction** — exporting today's data is blocked until `now ≥ eodSnapshotHourLocal`. Operators see a clear "Day not complete yet — exports unlock at 18:00" message.
- **Per-inverter XLSX export** with one sheet per configured node — added as a new section to the existing Export page.
- **🔒 Data-preservation guarantee** — only the **Energy page UI** is removed. The underlying `inverter_5min` table, the `/api/energy/...` endpoints it reads, and every consumer of that data (Forecast trainer, Analytics MWh totals, Reports, daily/weekly emails, cloud-replication) **stay untouched**. The Energy page's KPIs are not moved or duplicated — the data they read continues to feed Analytics' existing tiles via the same code path it always has.

Effort: **5 engineering days** end-to-end (backend 2 + frontend 2 + migration & export 1).

---

## 1. User stories

| As a … | I want … | So that … |
|---|---|---|
| Operator | to open a single page and see all 16 parameter columns for any inverter on any past date, drilled down per node | I can investigate why one node behaved differently from the others on a particular day, without opening ISM |
| Operator | when picking today's date, to see live 5-minute samples streaming in for the chosen inverter | I can monitor a specific inverter's behaviour during the day without leaving the dashboard |
| Operator | to export one inverter's full month of daily-data as a single XLSX with one sheet per node | I can hand a single file to the plant owner without re-running the export N times |
| Operator | the export to never silently include partial data | I never email a stakeholder a "today" report that's missing the afternoon |
| Operator | the on-screen table to never include 19:00-04:59 zero-rows | the screen isn't 60 % filler |

---

## 2. What's being replaced

### 2.1 Current Energy page (`#page-energy`)

Today's Energy page shows a 4-column table — `Date | Interval End | Inverter | Interval Energy (MWh)` — plus 5 KPIs across the top: Date Total, Average per Interval, Peak Interval, Reporting Inverters, Latest Interval End. Backed by the existing `inverter_5min` rolling table that stores Pac-integrated kWh per 5-minute window per inverter.

### 2.2 Migration plan — UI surface only

The user directive is **strict**: remove only the Energy page's visible UI, leave every byte of underlying data + every consumer of that data alone. Analytics, Forecast, Reports, MWh totals, scheduled exports, and cloud replication all continue using `inverter_5min` exactly as they do today.

| Existing element | Disposition | Action |
|---|---|---|
| `<section id="page-energy">` markup (the toolbar, KPI strip, table) | **Removed visually** | DOM section emptied. The shell and the route stay. |
| `#energyTotalMwh`, `#energyAvgMwh`, `#energyPeakMwh`, `#energyInvCount`, `#energyLastTs` | **Removed** | These elements only render data that Analytics already displays via its own tiles. No data path is touched. |
| 4-column 5-min interval-energy table (`#energyTable` / `#energyBody`) | **Removed** | Table markup deleted. The new All-Parameters table on the same page replaces the visible function. |
| `data-page="energy"` nav button | **Repurposed (re-labelled)** | Same button, same DOM id (`#page-energy`), same hash-route (`#energy`). Label flips from "Energy" → "All Parameters Data". Bookmarks keep working. |
| `buildEnergyViewQueryKey()` / `renderEnergyTable()` / `renderEnergySummary()` / `renderEnergySummaryFromStats()` | **Deleted as dead code** | These functions render the removed UI; they are not called by any other page. Remove only after grep confirms zero callers. |
| **`inverter_5min` SQLite table** | **🔒 KEPT — DO NOT TOUCH** | Drives Forecast trainer, Analytics MWh aggregates, Reports, scheduled exports, cloud replication. Schema unchanged. Writers unchanged. Readers unchanged. |
| **`/api/energy/*` endpoints** (used by the Energy page) | **🔒 KEPT** | Even though the Energy page UI is removed, leave the endpoints in place — they're a stable API surface that external integrations (cron jobs, reports, third-party pulls) may rely on. Tag them `@deprecated_ui` in code comments only; don't remove. |
| `State.energyView`, `State.energyView.queryKey` etc. | **Removed** | Client-side state objects only used by the deleted UI. Free for cleanup. |

### 2.3 🔒 Data-preservation guarantee (do not violate)

This section is load-bearing. If a future contributor reads only one part of this document, make it this one.

**What gets removed:**
- Energy page DOM (`<section id="page-energy">` body — toolbar, KPI strip, table)
- Energy page client-side render helpers (`buildEnergyViewQueryKey`, `renderEnergyTable`, `renderEnergySummary*`)
- `State.energyView` client-side state object
- "Energy" label in the nav (relabelled, button reused)

**What MUST stay (writes, reads, schema, scheduled jobs all unchanged):**

| Asset | Why it matters |
|---|---|
| `inverter_5min` table | Pac-integrated MWh per inverter per 5-min slot. Forecast trainer reads this. Analytics MWh tiles read this. Reports read this. Cloud replication syncs this. |
| `inverter_5min` write path (poller → DB insert) | Continuous writer — the moment it stops, every downstream consumer breaks. |
| `/api/energy/list`, `/api/energy/summary`, `/api/energy/*` HTTP endpoints | Consumed by Analytics, Reports, scheduled exports, possibly external integrations. Stable API surface. |
| `inverter_5min`-derived columns (`kwh_inc`, `kwh_today`, `Etotal`, `parcE`) | Authoritative energy figures across the whole product. |
| Energy-page-related Settings keys (`solarWindowStartHour`, `eodSnapshotHourLocal`, retention windows) | Settings live independently of any one page; the new All Parameters page reads the same keys. |
| `inverter_data_5min` cloud-replication cursor | Cursor would re-checkpoint if the table were emptied; that's destructive. |

**Validation checklist before the flip:**
1. `grep -rn "inverter_5min"` — zero changes inside the diff.
2. `grep -rn "/api/energy"` — zero changes inside the diff.
3. Forecast trainer dry-run produces identical predictions before vs after.
4. Analytics MWh tiles render identical numbers before vs after.
5. Cloud replication cursor advances normally during the deploy window.

If any of those fail, **stop and roll back**. Re-launching is cheaper than data corruption.

### 2.4 Why reuse the route

Reusing `#page-energy` and the nav slot avoids:
- Settings → "open default page" shortcut breaking
- Bookmarks / WS reconnect URL preservation
- A separate migration to relocate the nav button

Operators see "All Parameters Data" in the navigation strip after the rename; URL is unchanged.

---

## 3. Architecture

```
┌─────────────────────┐    ┌──────────────────────┐
│  Python engine      │    │  Node Express + WS   │
│  (services/         │    │  (server/)           │
│   inverter_engine)  │    │                      │
│                     │    │  ┌───────────────┐   │
│  read_fast_async()  │───▶│  │ live WS hub   │   │
│  (60-reg poll @ 50  │    │  └───────┬───────┘   │
│   ms, +4 new fields)│    │          │           │
└─────────────────────┘    │          ▼           │
                           │  ┌───────────────┐   │
                           │  │ dailyAgg-     │   │
                           │  │ regator.js    │   │
                           │  │ - rolling     │   │
                           │  │   5-min bucket│   │
                           │  │   per (inv,   │   │
                           │  │   node)       │   │
                           │  │ - flush at    │   │
                           │  │   :00/:05/... │   │
                           │  └───────┬───────┘   │
                           │          │           │
                           │          ▼           │
                           │  ┌───────────────┐   │
                           │  │ SQLite        │   │
                           │  │ inverter_5min │   │
                           │  │ _param        │   │
                           │  └───────┬───────┘   │
                           │          │           │
                           │  ┌───────┴───────┐   │
                           │  │  REST API     │   │
                           │  │  /api/params/ │   │
                           │  └───────┬───────┘   │
                           └──────────┼───────────┘
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                  ┌──────▼──────┐         ┌────────▼───────┐
                  │ #page-      │         │ #page-export   │
                  │ energy →    │         │ (new daily-    │
                  │ "All        │         │ data card)     │
                  │ Parameters  │         │                │
                  │ Data"       │         │ XLSX builder   │
                  │             │         │ exceljs        │
                  │ live mode:  │         └────────────────┘
                  │  WS push    │
                  │ historical: │
                  │  REST GET   │
                  └─────────────┘
```

---

## 4. Data model

### 4.1 New SQLite table

```sql
CREATE TABLE IF NOT EXISTS inverter_5min_param (
  inverter_ip       TEXT    NOT NULL,
  slave             INTEGER NOT NULL,         -- 1..4 (node)
  date_local        TEXT    NOT NULL,         -- 'YYYY-MM-DD' Asia/Manila
  slot_index        INTEGER NOT NULL,         -- 0..287  ((hour*60+minute) / 5)
  ts_ms             INTEGER NOT NULL,         -- bucket-end epoch ms

  -- Power & DC chain (avg over the 5-min window)
  vdc_v             REAL,
  idc_a             REAL,
  pdc_w             INTEGER,

  -- Three-phase AC (avg)
  vac1_v            REAL, vac2_v REAL, vac3_v REAL,
  iac1_a            REAL, iac2_a REAL, iac3_a REAL,

  -- Misc (avg unless noted)
  temp_c            INTEGER,
  pac_w             INTEGER,
  cosphi            REAL,                     -- 0..1
  freq_hz           REAL,

  -- Bitmaps (max-merge across the bucket)
  inv_alarms        INTEGER NOT NULL DEFAULT 0,
  track_alarms      INTEGER NOT NULL DEFAULT 0,

  -- Bucket metadata
  sample_count      INTEGER NOT NULL DEFAULT 0,  -- how many 50-ms polls fed this bucket
  is_complete       INTEGER NOT NULL DEFAULT 0,  -- 1 once the 5-min boundary closed
  in_solar_window   INTEGER NOT NULL DEFAULT 0,  -- 1 if slot is between solarWindowStartHour and eodSnapshotHourLocal

  PRIMARY KEY (inverter_ip, slave, date_local, slot_index)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_param_date    ON inverter_5min_param (date_local, inverter_ip);
CREATE INDEX IF NOT EXISTS idx_param_invdate ON inverter_5min_param (inverter_ip, date_local);
```

**Volume:** 27 inverters × 4 nodes × 288 slots/day = **31 104 rows/day = 11.4 M rows/year**. With WITHOUT_ROWID + the two indices, the on-disk footprint is ~1.8 GB/year. Rotational pruner (default 365-day retention, operator-tunable) keeps it bounded.

**Partial Energy is NOT stored** — it's `pac_w * 5/60` and computed at render time. Saves a column and keeps the schema lean.

### 4.2 Solar window definition

- Already in settings: `solarWindowStartHour` (default 5) and `eodSnapshotHourLocal` (default 18). Both u8 hours, local time.
- `in_solar_window = (5 ≤ hour_of_slot < 18)` — this is set when the bucket is persisted, so query-time filters can use a simple `WHERE in_solar_window = 1`.
- If an operator changes the boundaries mid-flight, the flag is **forward-only** — already-persisted rows keep their value. A nightly re-flagger (00:05) re-stamps the previous day's rows so reports stay consistent.

### 4.3 Retention

- Setting: `paramRetentionDays` (new, default `365`).
- Pruner: `setInterval(_prunParamRetention, 6 * 60 * 60 * 1000).unref();` — same shape as the existing Stop Reasons pruner ([server/index.js retention pattern](../server/index.js)).

---

## 5. Backend

### 5.1 Python engine — find & expose 4 missing register slots

`read_fast_async` already pulls 60 input registers but only surfaces 25 fields. The 4 columns ISM shows that we don't yet expose are **Pdc, Temp, CosΦ, Track Alarms**. We can find their register addresses by byte-pattern matching the **first FC04 reply in the captures** against the screenshot's known live-snapshot values.

Both captures contain the frame `02 04 00 00 00 1a` (read 26 input regs). The 52-byte payload of that frame on 4/27 was:

```
2825 e272 2824 2ac1 27ae 2922 0000 0000 0287 00d8 00d3 00d0 00d0 00df 00df 00dc 03e8 ffff 35a0 1760 07ea 0004 001b 000e 0006 0033
```

We already know reg 8=Vdc, reg 18=Pac, reg 19=Fac, reg 6-7=alarm_32. The screenshot's "live snapshot" line at the moment the operator clicked Reading shows specific Pac/Vdc/Temp/CosΦ values; we can match those to byte positions in 30 minutes of work and update [services/inverter_engine.py:1086-1115](../services/inverter_engine.py#L1086-L1115) with 4 new keys (`pdc`, `temp_c`, `cosphi_x1000`, `track_alarms`). Zero extra Modbus traffic — these come from the same 60-reg poll we already do.

If the byte-pattern attack doesn't fully resolve all 4, we fall back to one short FC04 probe (5 ms) per inverter to read a different known register block. The polling loop's existing per-IP lock makes this safe to add.

### 5.2 Node aggregator — `server/dailyAggregator.js`

New module, mirrors the shape of `server/alarms.js`'s rolling state machine:

```js
// State: per (inverter, slave) → in-progress bucket
const buckets = new Map(); // key = `${ip}|${slave}` → { slotIndex, sums, sampleCount, alarmsAccum }

function ingestLiveSample(row) {
  // row comes from the existing WS broadcaster (ws.broadcastLiveData)
  // and contains the keys read_fast_async returns.
  const slot = computeSlotIndex(row.ts);                  // (hour*60+min)/5
  const dateLocal = formatLocalDate(row.ts);
  const key = `${row.source_ip}|${row.unit}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.dateLocal !== dateLocal || bucket.slotIndex !== slot) {
    if (bucket) flushBucket(bucket);                      // close previous slot
    bucket = createBucket(row.source_ip, row.unit, dateLocal, slot, row.ts);
    buckets.set(key, bucket);
  }
  accumulate(bucket, row);                                // += vdc, etc.
}

function flushBucket(b) {
  if (b.sampleCount === 0) return;                        // no live samples — skip
  db.prepare(`INSERT OR REPLACE INTO inverter_5min_param (...) VALUES (...)`)
    .run({
      ...averages(b),
      sample_count: b.sampleCount,
      is_complete:  1,
      in_solar_window: isSolarWindow(b.slotIndex) ? 1 : 0,
    });
}

// Periodic timer — wakes every 30s, force-flushes any bucket that's
// rolled past its 5-min boundary even if the inverter went silent.
setInterval(reapStaleBuckets, 30_000).unref();
```

**Live-row exposure**: in addition to persisted rows, the aggregator also makes its in-progress bucket queryable via `getCurrentBucket(ip, slave)` for the live UI tile. This is the "currently filling" row at the bottom of the live table.

### 5.3 REST API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/params/:inverter/:slave?date=YYYY-MM-DD` | none (read-only, replicated) | Returns the 288 (or fewer, after solar-window clip) rows for that day. Today's response also includes a `live_bucket` field with the in-progress slot. |
| GET | `/api/params/:inverter?date=YYYY-MM-DD` | none | Returns rows for **all configured nodes** of that inverter — used by the page when initially loading. |
| GET | `/api/params/:inverter/:slave/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=xlsx` | bulk-auth | Returns a streamed XLSX file (server-side built via `exceljs`). One sheet per node when called via the `:inverter` form (see §6.2). |
| WS push | `param.bucketClosed` (existing channel) | none | Broadcast when a 5-min bucket is persisted. Payload: `{inverter, slave, date, slot, row}`. The page subscribes only when in live mode. |

All `:inverter/:slave/export` paths are **gateway-only** (`_denyExportInRemote`) because today-export checking depends on the gateway's wall clock; remote viewers can still read past data via the GET endpoints.

---

## 6. Front end

### 6.1 All Parameters Data page (replaces `#page-energy`)

**New markup outline** (replaces lines 320-380 of `public/index.html`):

```html
<section id="page-energy" class="page" data-page-label="All Parameters Data">
  <div class="page-toolbar">
    <div class="tl-left">
      <label>Inverter
        <select id="paramInv" class="sel" title="Pick an inverter to view its 5-minute parameter log.">
          <option value="">— select —</option>
          <!-- populated from State.ipConfig.inverters -->
        </select>
      </label>
      <label>Date
        <input type="date" id="paramDate" class="inp" title="Pick a date. Today shows live samples; past dates show the persisted log." />
      </label>
      <span id="paramModeBadge" class="param-mode-badge" hidden></span>
      <button id="btnParamRefresh" class="btn btn-outline" title="Re-fetch the selected day's data.">Refresh</button>
    </div>
    <div class="tl-right">
      <span class="toolbar-info" id="paramSolarWindow" title="Slots are clipped to the configured solar window.">Solar window: 05:00–18:00</span>
      <span class="toolbar-info" id="paramRowCount">—</span>
    </div>
  </div>

  <!-- Blank state -->
  <div id="paramBlank" class="param-blank">
    <span class="mdi mdi-table-large icon-inline" aria-hidden="true"></span>
    <div class="param-blank-title">Pick an inverter to view its parameter log</div>
    <div class="param-blank-sub">
      Today's date streams live 5-minute samples. Past dates load from history. Each tab is one node on the inverter.
    </div>
  </div>

  <!-- Loaded state — tab strip + 4 panels -->
  <div id="paramTabs" class="card-tabs" role="tablist" aria-label="Inverter nodes" hidden>
    <!-- Buttons added dynamically based on ipconfig.units[invId] -->
  </div>
  <div id="paramPanels" hidden>
    <!-- One <div class="card-tab-panel" data-card-tab-panel="node-N"> per configured node -->
  </div>
</section>
```

**State machine:**

| State | Toolbar | Tabs | Panels |
|---|---|---|---|
| `blank` (no inverter picked) | inverter picker enabled, date picker enabled but inert | hidden | `#paramBlank` shown, panels hidden |
| `loading` | spinner on Refresh | greyed | "Loading…" placeholder |
| `historical` (date < today) | date picker active, badge "Historical" | full | data table, no live updates |
| `live` (date == today) | badge "Live" with green dot | full | data table + 1 in-progress row pinned to bottom; WS subscribed |
| `empty` (data fetched, 0 rows) | "no rows" toast | shown | "No samples logged for this slave on this date" |

**Tab layout:** uses the existing `card-tabs` framework (Inverter Clocks / Stop Reasons / Serial Number all use it). Tabs are dynamic — only show what `State.ipConfig.units[invId]` lists. Single-node inverters get a 1-tab strip, 4-node inverters get 4. State persisted in `localStorage["adsi_param_active_tab"]`.

**Per-tab table — exact ISM column order:**

```
Time | Pdc (W) | Vdc (V) | Idc (A) | Vac1 (V) | Vac2 (V) | Vac3 (V) | Iac1 (A) | Iac2 (A) | Iac3 (A) | Temp (°C) | Pac (W) | Partial Energy (Wh) | Cos Φ | Freq (Hz) | Inv. Alarms | Track Alarms
```

- **Time column**: `HH:MM` slot end. Past dates: 156 rows max (5h to 18h × 12 = 156 slots in default solar window). Today: rows fill in as they close.
- **Partial Energy** computed `Pac * 5/60`, displayed as `2295.83`.
- **Alarm columns** rendered as `0x0600` (uppercase hex, click for breakdown — reuses existing `openAlarmDetail`).
- **Live in-progress row** at the bottom in live mode, with a faint background, label `now ▸ HH:MM` (slot end), and `sample_count` shown so the operator knows how stable the average is.
- **Sortable** by every column, default sort = Time ascending.

### 6.2 Solar-window display clip

- All rendered rows have `WHERE in_solar_window = 1` applied server-side.
- Top toolbar shows the active range: "Solar window: 05:00–18:00" (reads from `/api/settings`).
- Edge case: if an operator widens the window mid-day, today's already-flagged rows don't change retroactively — the badge shows "Window changed mid-day" with a tooltip explaining old slots still use the previous window.

### 6.3 Live-mode mechanics

- On entering `live` state, the page subscribes to the existing WS channel and listens for `param.bucketClosed` events.
- When a `bucketClosed` arrives that matches `(inverter, slave, date)`, the page appends the row to the active tab's table and removes the live in-progress row's prior content. A new live row is started for the next slot.
- The in-progress row is updated every **5 seconds** (the existing live-data WS cadence) — the dashboard already broadcasts every poll, so the page just averages the last N samples for that bucket. No new server work.
- On tab change, only the active tab's WS handler runs to avoid 4× redundant DOM writes.

### 6.4 Empty / error states

| Condition | UI |
|---|---|
| Inverter has no nodes configured | "No nodes configured for Inverter X — check Settings → IP Config" |
| Date picked, no rows for that day | "No samples logged for Inverter X / Node Y on YYYY-MM-DD. The inverter may have been offline." |
| Date picked, only some nodes have data | Tabs for nodes-with-data are normal; tabs for nodes-without are dimmed and show the empty message inside |
| Network error fetching | "Failed to load — check connection to gateway. Click Refresh to retry." |
| Date in the future | inline error: "Cannot view future dates — the data hasn't been logged yet." |

### 6.5 Toolbar interactions

- Picker change → fetch.
- Date change → fetch.
- Refresh button → re-fetch (useful in live mode if WS dropped).
- "Solar window" badge clickable → opens Settings → solar-window section.
- Row count: `156 / 156 (live)` for today, `156 / 156 (historical)` for past dates.

---

## 7. Export — new "Daily Data" section in `#page-export`

### 7.1 New card (added to `public/index.html` inside `#page-export`)

```
┌──────────────────────────────────────────────────────────┐
│ ⇩ DAILY DATA EXPORT (PER-INVERTER, MULTI-SHEET XLSX)     │
├──────────────────────────────────────────────────────────┤
│ Inverter:    [ Inverter 9 (192.168.1.109)        ▼ ]    │
│ From:        [ 2026-04-25 ]                              │
│ To:          [ 2026-04-27 ]                              │
│                                                           │
│ ☐ Include live (in-progress) bucket           [disabled] │
│                                                           │
│ Output preview:                                          │
│   Inverter_9_DailyData_2026-04-25_to_2026-04-27.xlsx     │
│   • Sheet "Node 1" — 468 rows                            │
│   • Sheet "Node 2" — 468 rows                            │
│   • Sheet "Node 3" — 468 rows                            │
│   • Sheet "Node 4" — 468 rows                            │
│   Solar window 05:00–18:00 enforced.                     │
│                                                           │
│   ⚠ Today (2026-04-27) is incomplete — exports unlock at │
│   18:00. Until then, today's samples are not included.   │
│                                                           │
│ [ Export to xlsx ]                       (disabled)      │
└──────────────────────────────────────────────────────────┘
```

### 7.2 XLSX structure

- **One workbook per inverter.**
- **One sheet per configured node** (N=1..4), named `Node 1`, `Node 2`, …. Sheet count = `len(ipConfig.units[invId])`. If an inverter has no node 4, no "Node 4" sheet is generated — file size scales naturally.
- **Sheet header** (rows 1-5):

  | Row | Content |
  |---|---|
  | 1 | `Plant: <plantName>` |
  | 2 | `Inverter: <invId>  (<ip>)`, `Slave: <N>` |
  | 3 | `Date range: <from> to <to>`, `Solar window: <start>:00 – <end>:00` |
  | 4 | `Generated: <ISO ts>` (gateway clock) |
  | 5 | (blank) |
- **Sheet column header** (row 6) — exact ISM column order, English labels:

  ```
  Date | Time | Pdc (W) | Vdc (V) | Idc (A) | Vac1 (V) | Vac2 (V) | Vac3 (V)
       | Iac1 (A) | Iac2 (A) | Iac3 (A) | Temp (°C) | Pac (W) | Partial Energy (Wh)
       | Cos Φ | Freq (Hz) | Inv. Alarms | Track Alarms
  ```
- **Data rows** (row 7+): one row per 5-min slot in the date range, sorted ascending. Only rows with `in_solar_window = 1`.
- **Numerical formats**: integer for Pdc/Pac/Vdc, 1-decimal for Idc/Iac, 2-decimal for Vac/Freq, 3-decimal for CosΦ, hex for alarms (`0x0600`). Excel will preserve these via `cell.numFmt`.
- **Footer row** (last row + 1, bold): daily totals — `Σ PartialEnergy (Wh)`, `max Pac`, `min Temp`, `max Temp`, `max alarm bitmap`. Per-day footer when range > 1 day, plus a grand total at the very end.

### 7.3 Export restrictions (the new constraint)

#### Solar-window clipping (always-on)

- Server-side query has `WHERE in_solar_window = 1` always. There's no UI option to disable it — the rule is "exports represent the production day".
- Operators who want night-time data can use the Audit log or the existing inverter-data export.

#### Today-export restriction

The rule:

> Exporting **today's** data is blocked until `now ≥ eodSnapshotHourLocal`.
> If the date range includes today and today is still inside the solar window, `today` is **silently excluded** (other dates in the range still export). The UI shows a warning so the operator isn't surprised.

Pseudocode:

```js
function exportEligibleDates(from, to, eodHour) {
  const today = formatLocalDate(Date.now());
  const nowHour = new Date().getHours();
  const todayInRange = (from <= today && today <= to);
  const todayLocked = todayInRange && nowHour < eodHour;

  return {
    eligible: dateRange(from, to).filter((d) => d !== today || !todayLocked),
    todayLocked,
    unlockTime: `${eodHour}:00`,
  };
}
```

- If `todayLocked` is true and the range was **only** today → button is disabled, message: `"Today's data is incomplete — exports unlock at 18:00. Try again then or pick a past date."`
- If `todayLocked` is true and the range includes other dates → button enabled, message: `"Note: today (YYYY-MM-DD) is excluded from this export — exports unlock at 18:00."`
- If `now ≥ eodSnapshotHourLocal` and today is in range → today included, no message.
- The export endpoint enforces the rule too — even if a remote-viewer crafts a direct API call, the gateway rejects today's slice with HTTP 423 Locked + the same message body.

#### Future-date guard

Selecting a future date — UI inline error before any request: `"Cannot export future dates."`

### 7.4 File-naming convention

```
Inverter_<ID>_DailyData_<from-yyyymmdd>_to_<to-yyyymmdd>.xlsx
```

Single-day exports collapse to:

```
Inverter_<ID>_DailyData_<yyyymmdd>.xlsx
```

ID is the dashboard inverter number (1-27), not the IP, so files are sortable.

### 7.5 Server-side implementation

`server/exporters/dailyDataXlsx.js` (new) using the existing `exceljs` dependency. Builder pattern mirroring `server/exporter.js exportInverterData` but multi-sheet:

```js
async function buildDailyDataWorkbook({ inverter, from, to, ipConfig, eodHour }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ADSI Dashboard";
  wb.created = new Date();

  const slaves = ipConfig.units[String(inverter)] || [1, 2, 3, 4];
  const { eligible, todayLocked, unlockTime } = exportEligibleDates(from, to, eodHour);
  if (eligible.length === 0) {
    throw new HttpError(423, `Range fully locked. Today's data unlocks at ${unlockTime}.`);
  }

  for (const slave of slaves) {
    const rows = db.prepare(`
      SELECT * FROM inverter_5min_param
      WHERE inverter_ip = ? AND slave = ?
        AND date_local IN (${eligible.map(() => "?").join(",")})
        AND in_solar_window = 1
      ORDER BY date_local, slot_index
    `).all(ipFromInverter(inverter), slave, ...eligible);

    const ws = wb.addWorksheet(`Node ${slave}`);
    writeHeader(ws, { inverter, slave, from, to, eodHour, todayLocked, unlockTime });
    writeColumns(ws);
    rows.forEach((r) => ws.addRow(toIsmRow(r)));
    writeFooter(ws, rows);
  }

  return wb.xlsx.writeBuffer();
}
```

### 7.6 Performance

- Worst case: 1-month range × 4 nodes × 156 rows/day = 18 720 rows total. ExcelJS builds that in <200 ms.
- Average file size: ~250 KB per inverter-month (XLSX is zipped XML, very compact). Well under any browser/email limit.
- Streamed response via `res.attachment(filename); wb.xlsx.write(res);` — no buffering large files in RAM.

---

## 8. Migration & backfill

### 8.1 Backfill from existing 5-min table

- The dashboard already has `inverter_5min` (Pac-integrated kWh per inverter, no node breakdown, no per-phase voltages).
- It does NOT carry the column granularity the new page needs (no Vac1/2/3 or Iac1/2/3, no CosΦ, no per-node alarms).
- Decision: **no historical backfill** is possible for the new columns — they were never persisted. The new page will simply have a "history starts on YYYY-MM-DD" floor, where YYYY-MM-DD is the deploy date.
- The aggregator goes live on first-deploy. From that point, every 5-min slot lands in `inverter_5min_param`.
- Operators who want pre-deploy data still have access to ISM's vendor downloads on inverter 9 + the existing `inverter_5min` MWh totals on Analytics.

### 8.2 Energy-page KPI migration — none required

Operator directive: **only the UI is removed; data and every consumer stay**. The 5 KPI tiles disappear from the Energy page along with the rest of its UI. Their data continues feeding Analytics' existing tiles unchanged. **No KPI tiles need to be added to Analytics** — it already shows date-total, peak, reporting-inverter count, etc. via its own code paths.

If a stakeholder later asks "where did the Energy peak number go?", the answer is: **Analytics → Today card → Peak Interval line** (already there).

### 8.3 Deletion order (safe roll-out)

1. **Backend silent deploy** — build new aggregator + table + endpoints. Run silently on the gateway for 3 days, watch for table growth, retention behaviour, sample-count sanity.
2. **Build new page UI** alongside the existing Energy markup, behind a feature flag (`PARAM_PAGE_ENABLED`).
3. **Add Daily Data export card** to `#page-export` (also feature-flagged).
4. **Internal QA** on the gateway — operator validates the new page + export.
5. **Flip the flag** — replace Energy markup with new All Parameters Data markup in one commit. Rename nav button. Same release ships the export card.
6. **Confirm** Forecast / Analytics / Reports / cloud replication all still work — they should be untouched.
7. **One release later**: delete dead UI helpers (`buildEnergyViewQueryKey`, `renderEnergyTable`, `renderEnergySummary*`) after grep confirms zero callers. **Do not** remove `inverter_5min` writers, `/api/energy/*` endpoints, or any other Energy-data path.

---

## 9. Edge cases & gotchas

| Scenario | Handling |
|---|---|
| Inverter offline for the whole day | No rows logged → tab shows empty state. No fake zeros. |
| Inverter offline for part of the day | Rows missing for those slots. Table shows actual rows; missing slots are not synthesized. |
| Sample arrives 0.4 s before slot rollover | `computeSlotIndex(ts)` is millisecond-accurate; no "edge of slot" double counting. Bucket flush at `:05.000` includes all samples whose `floor(ts/5min) == slot`. |
| WS reconnects mid-bucket | Live row rebuilt from samples received post-reconnect. `sample_count` makes it visible to the operator that the row is partial. |
| Plant grid frequency briefly drops to 0 | Stored as 0; doesn't affect averaging because the dashboard already filters obvious-zero PAC samples before broadcasting. |
| Solar window edited mid-day | New bucket flushes use the new flag. Already-persisted rows keep old flag. Nightly re-flagger restamps yesterday's rows; today's stays consistent within itself. |
| All zeros at sunrise/sunset | Rows are persisted (we capture the boundary), but `in_solar_window` is set per the configured window. The operator sees them only on the page (not the export), so the table mirrors ISM. |
| Operator changes timezone | Dashboard runs Asia/Manila only (no DST). Documented assumption; future timezone support is out of scope. |
| Date math near year boundary | `date_local` is a string (`'YYYY-MM-DD'`); slot index 0..287 is independent of date. No off-by-one. |
| Inverter's RTC drifts > 1h from gateway | The aggregator buckets by **gateway wall clock**, not inverter RTC, because gateway time is authoritative across the fleet. Inverter RTC drift shows up as alarms but doesn't affect bucketing. |
| Today export attempted at 17:59:59 | Blocked. At 18:00:00.001 the gateway's clock crosses; UI re-checks every 30 s and unlocks. |
| Operator wants night-time data (after 18:00) | Out of scope; covered by the existing audit log and inverter_data export. The new page's solar-window clip is a hard rule. |

---

## 10. Testing strategy

### 10.1 Backend

- `services/tests/test_param_aggregator.py` — unit tests for slot-index math, bucket close, alarm max-merge, in-solar-window flag, retention pruner.
- `server/tests/dailyAggregator.test.js` — synthetic WS event stream → assert row written at slot rollover with correct averages.
- `server/tests/dailyDataExport.test.js` — XLSX builder unit tests (sheet count == node count, header rows, today-locked behaviour, future-date guard, hex alarm formatting).

### 10.2 Front-end

- `public/tests/param_page.spec.js` — Playwright/Vitest covering: blank state, picker change, tab switch, live-row update, empty-day state, future-date guard, solar-window badge.
- Manual matrix:
  - Inverter 9 (4 nodes) live at 14:00 → all 4 tabs filled, live row pulses
  - Inverter 9 historical 4/27 → all 4 tabs filled, no live row, 156 rows per tab
  - Inverter 3 (4 nodes via EKI) live → identical UX to inverter 9 (the architecture doesn't depend on comm board)
  - Inverter with only 1 configured node → only 1 tab visible
  - Date = 4/25/2026 from inverter 3 → empty state (no data for that pre-deploy date)

### 10.3 Export

- Single-day, single-inverter, all 4 sheets — file opens cleanly in Excel + LibreOffice + Numbers
- Multi-day (28 days × 4 nodes) — file size <2 MB, opens in <5 s
- Today before 18:00 → button disabled, message visible
- Today after 18:00 → button enabled, file includes today
- Range straddling today (yesterday + today) before 18:00 → button enabled, file excludes today, warning shown
- Range fully in past → no warning, file includes everything

---

## 11. Rollout plan

| Day | Work |
|---|---|
| Day 1 (backend) | Find missing register addresses, expose in `read_fast_async`, build aggregator, schema, retention pruner. Unit tests. Run silently for 24h on dev gateway. |
| Day 2 (backend) | API endpoints, WS push channel, gateway-only guards. Manual smoke from `curl`. Verify 24h of data is sane. |
| Day 3 (frontend) | Replace Energy page markup with new All Parameters Data layout. Tab framework. Historical fetch. Empty/error states. |
| Day 4 (frontend) | Live-mode WS subscription. In-progress row. Solar-window display clip. Toolbar polish. |
| Day 5 (export + polish) | Daily Data export card on Export page. XLSX builder. Today-restriction enforcement (UI + server). End-to-end test matrix. |

After Day 5: ship as a minor-version bump (likely v2.10.x), advertise in release notes as "All Parameters Data view + export, replaces Energy page".

---

## 12. Effort estimate

**Total: 5 engineering days.**

| Slice | Days | Confidence |
|---|---|---|
| Find 4 missing register addresses | 0.25 | high (byte-pattern attack on existing captures) |
| Python register exposure + tests | 0.5 | high |
| Node aggregator + SQLite schema + retention | 1.0 | medium (state-machine has edge cases) |
| API + WS push channel | 0.5 | high |
| Front-end page (tabs, table, states) | 1.5 | high (mirrors existing tabbed sections) |
| Front-end live mode + WS wiring | 0.5 | medium |
| Export card + XLSX builder + today-lock | 0.75 | medium (exceljs is already in the project) |

---

## 13. Open questions

1. **Should the live in-progress row also be exportable?** Current blueprint says no — exports are persisted-only. The "Include live bucket" checkbox in the export card mockup is shown disabled by default. Confirm with operator: is "live preview" useful for the export, or is partial data always misleading?

2. **Per-node solar window?** Some plants have nodes facing different cardinal directions and producing on different schedules. Out of scope for v1, but the schema's `in_solar_window` flag could be made per-node later.

3. **Backfill for high-value historical dates?** ISM's vendor download still works on inverter 9. Worth a one-shot scraper that pulls 30 days back through ISM's protocol and seeds the new table for inverter 9 only? Adds ~2 days of work but recovers historical visibility for one inverter.

4. **Compression for old months?** At 365-day retention × 11 M rows, on-disk size is ~1.8 GB. Acceptable for the plant's hardware, but a cold-tier (Parquet roll-up) for months ≥ 90 days old would shrink it 10×. Out of scope for v1.

5. **Mobile view?** The 17-column table is wide. Future enhancement: collapse to a "key metrics" view on narrow screens, with a "show all" toggle.

6. **Rename the URL hash?** Current plan keeps `#energy` for backwards-compat. Cleaner future state would be `#parameters` with a redirect. Not blocking.

---

## 14. Decisions captured

| Decision | Rationale |
|---|---|
| Reuse `#page-energy` route + DOM id | Avoids breaking bookmarks, settings shortcuts, WS reconnect logic |
| 5-min slot index 0..287 + per-day `is_complete` flag | Same shape as the existing `inverter_5min` rolling table; simpler joins for analysts |
| Solar-window clip in DB, not in render | Server stays the single source of truth; clients never see clipped-vs-unclipped ambiguity |
| Today-lock in **both** UI and server | Defence-in-depth — a remote viewer can't bypass via direct API call |
| Per-inverter XLSX (sheets = nodes) | Matches operator's mental model of "one inverter, one report" |
| Reuse exceljs (already a dep) | No new dependency footprint |
| Reuse `card-tabs` framework | Consistent UX with Inverter Clocks, Stop Reasons, Serial Number |
| Drop ISM-protocol pursuit | Direct vendor protocol only works on inverter 9. Building our own logger gives fleet-wide coverage without a hardware constraint. |
