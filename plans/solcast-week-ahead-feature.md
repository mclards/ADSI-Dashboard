# Plan: Solcast Week-Ahead Computation, Table, and Export

**Objective:** Add a Solcast-only 7-day outlook feature: multi-day snapshot persistence, a week-ahead table card with a bar chart, and an export function. Base date is always the present date; range is today+1 through today+7.

**Mode:** Direct (edit-in-place, no branch needed for a feature of this scope)
**Version baseline:** v2.4.36
**Primary files:** `server/index.js`, `server/exporter.js`, `public/js/app.js`, `public/index.html`

---

## Dependency Graph

```
Step 1 (multi-day persistence)
  └─▶ Step 2 (server GET endpoint) ──┐
        └─▶ Step 3 (exporter fn)     │
              └─▶ Step 4 (export      │─▶ Step 5 (UI)
                          endpoint) ──┘
```

Steps 2 and 3 can be developed in parallel once Step 1 is done. Step 4 requires both 2 and 3. Step 5 requires Step 4 (the export endpoint) but the table/chart portion can be wired to Step 2's GET endpoint independently.

---

## Step 1 — Multi-Day Solcast Snapshot Persistence

**Context:**
Currently `buildAndPersistSolcastSnapshot(day, records, ...)` is called with a single `day` value (always `tomorrowTz`). The Solcast API actually returns data spanning up to 7 days, all present in the `records` array. The `buildSolcastSnapshotRows(day, records, cfg)` function filters records where `p.date === day` — so calling it for each unique day in the records is all that's needed to persist the full week.

**Files to change:**
- `server/index.js` only

**Tasks:**

1. Add helper `buildAndPersistSolcastSnapshotAllDays(records, estActuals, cfg, source, pulledTs)` near the existing `buildAndPersistSolcastSnapshot` (around line 9158):
   ```js
   function buildAndPersistSolcastSnapshotAllDays(records, estActuals, cfg, source, pulledTs) {
     // Extract unique local dates from all records
     const daySet = new Set();
     for (const rec of records || []) {
       const endRaw = rec?.period_end ?? rec?.periodEnd ?? rec?.period_end_utc ?? rec?.periodEndUtc;
       const ts = Date.parse(String(endRaw || ''));
       if (Number.isFinite(ts) && ts > 0) {
         daySet.add(getTzParts(ts, cfg.timeZone).date);
       }
     }
     const results = {};
     for (const day of [...daySet].sort()) {
       try {
         results[day] = buildAndPersistSolcastSnapshot(day, records, estActuals, cfg, source, pulledTs);
       } catch (err) {
         results[day] = { ok: false, warning: err.message };
       }
     }
     return results;
   }
   ```

2. In the `POST /api/solcast/fetch` endpoint (around line 13105, currently calls `buildAndPersistSolcastSnapshot(tomorrowTz, ...)`):
   - Replace `buildAndPersistSolcastSnapshot(tomorrowTz, records, estActuals, ...)` with `buildAndPersistSolcastSnapshotAllDays(records, estActuals, ...)`.
   - Update the response fields accordingly (`snapshotDaysPersisted: Object.keys(results)` etc.).

3. In `autoFetchSolcastSnapshots(dates)` (around line 9716) — **no change needed**: this function already loops over dates and calls `buildAndPersistSolcastSnapshot` per date, so it remains valid for targeted prefetch.

**Exit criteria:**
- After calling the Solcast fetch endpoint, `SELECT DISTINCT forecast_day FROM solcast_snapshots ORDER BY forecast_day` returns at least 7 rows spanning today+1..today+7 (when the API has that horizon).
- Existing "tomorrow" snapshot behavior unchanged — tomorrow's data still persisted.

---

## Step 2 — Server GET Endpoint: Week-Ahead Summary

**Context:**
A new lightweight read-only endpoint that queries `solcast_snapshots` for the 7 days ahead of today and returns per-day totals. No Solcast API call — reads from DB only so it's fast and works offline with cached data.

**Files to change:**
- `server/index.js` only

**Tasks:**

1. Add helper `querySolcastWeekAheadDays(baseDateTz)` near the Solcast snapshot helpers (after `persistSolcastSnapshot`):
   ```js
   function querySolcastWeekAheadDays(baseDateTz) {
     // baseDateTz = today in plant timezone (e.g. "2026-03-23")
     const dates = [];
     for (let i = 1; i <= 7; i++) dates.push(addDaysIso(baseDateTz, i));

     const rows = db.prepare(
       `SELECT forecast_day, slot, forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, pulled_ts
        FROM solcast_snapshots WHERE forecast_day IN (${dates.map(() => '?').join(',')})
        ORDER BY forecast_day, slot`
     ).all(...dates);

     // Aggregate per day
     const byDay = {};
     for (const d of dates) byDay[d] = { date: d, totalKwh: 0, totalLoKwh: 0, totalHiKwh: 0, slots: 0, pulledTs: null, hasData: false };
     for (const r of rows) {
       const d = byDay[r.forecast_day];
       if (!d) continue;
       d.totalKwh    += Number(r.forecast_kwh    || 0);
       d.totalLoKwh  += Number(r.forecast_lo_kwh || 0);
       d.totalHiKwh  += Number(r.forecast_hi_kwh || 0);
       d.slots++;
       if (r.pulled_ts) d.pulledTs = Math.max(d.pulledTs ?? 0, Number(r.pulled_ts));
       d.hasData = true;
     }
     return Object.values(byDay);
   }
   ```

2. Add endpoint (place near other solcast endpoints, around line 13140):
   ```js
   app.get('/api/solcast/week-ahead', (req, res) => {
     try {
       const tz = getSolcastConfig().timeZone || 'Asia/Manila';
       const baseDate = localDateStrInTz(Date.now(), tz);
       const days = querySolcastWeekAheadDays(baseDate);
       return res.json({ ok: true, baseDate, generatedAt: Date.now(), days });
     } catch (err) {
       return res.status(500).json({ ok: false, error: err.message });
     }
   });
   ```

**Exit criteria:**
- `GET /api/solcast/week-ahead` returns `200` with `{ ok: true, baseDate, days: [{date, totalKwh, ...}] }`.
- Days with no DB data have `hasData: false`, `totalKwh: 0`.
- Response is instantaneous (DB read only).

---

## Step 3 — Exporter Function: exportSolcastWeekAhead

**Context:**
Add `exportSolcastWeekAhead` to `server/exporter.js`. Supports two resolutions: `"daily"` (7 summary rows) and `"slot"` (per-5min rows across all 7 days). Output goes to `Forecast/Solcast/` subfolder. Reuses existing XLSX builder patterns already in the file.

**Files to change:**
- `server/exporter.js` only

**Tasks:**

1. Add `exportSolcastWeekAhead({ days, slotRows, resolution, format, startDay, endDay })` function near `exportSolcastPreview` (around line 2193):
   ```js
   async function exportSolcastWeekAhead({ days, slotRows, resolution, format, startDay, endDay }) {
     const isCsv = String(format || 'xlsx').trim().toLowerCase() === 'csv';
     const isSlot = String(resolution || 'daily').trim().toLowerCase() === 'slot';
     const dir = resolveForecastExportDir(FORECAST_EXPORT_SUBFOLDERS.solcast);
     const label = `WeekAhead_${startDay}_${endDay}`;
     const ext = isCsv ? 'csv' : 'xlsx';
     const outPath = path.join(dir, `Solcast_${label}.${ext}`);
     await fs.mkdir(dir, { recursive: true });

     if (isSlot) {
       // slotRows: [{ date, time, forecastKwh, forecastLoKwh, forecastHiKwh }]
       const headers = ['Date', 'Time', 'ForecastKWh', 'ForecastLo_KWh', 'ForecastHi_KWh'];
       const rows = (slotRows || []).map(r => [r.date, r.time, r.forecastKwh, r.forecastLoKwh, r.forecastHiKwh]);
       await writeExportFile(outPath, headers, rows, { isCsv });
     } else {
       // days: [{ date, totalKwh, totalLoKwh, totalHiKwh, hasData }]
       const headers = ['Date', 'ForecastTotal_KWh', 'ForecastLo_KWh', 'ForecastHi_KWh', 'DataAvailable'];
       const rows = (days || []).map(d => [d.date, d.totalKwh, d.totalLoKwh, d.totalHiKwh, d.hasData ? 'Yes' : 'No']);
       await writeExportFile(outPath, headers, rows, { isCsv });
     }
     return outPath;
   }
   ```
   > **Note:** Use whatever `writeExportFile` / XLSX-builder pattern is already established in `exporter.js` (check the `exportSolcastPreview` implementation for the exact helper name and signature).

2. Export the function at the bottom of `exporter.js` in the `module.exports` block.

**Exit criteria:**
- Calling `exportSolcastWeekAhead` produces a valid `.xlsx` or `.csv` file in the `Forecast/Solcast/` folder.
- Daily resolution: 7 rows with date + KWh totals.
- Slot resolution: up to 7 × 156 rows (5-min slots × 7 days, 05:00–18:00 window).

---

## Step 4 — Export Endpoint: POST /api/export/solcast-week-ahead

**Context:**
New server endpoint that reads week-ahead data from DB, formats slot rows if needed, calls the exporter, and returns the file path via the standard `buildExportResult` pattern. Uses `runGatewayExportJob` for serialization (same as other export endpoints).

**Files to change:**
- `server/index.js` only

**Tasks:**

1. Add helper `querySlotRowsForWeekAhead(dates)` (can be co-located with `querySolcastWeekAheadDays`):
   ```js
   function querySlotRowsForWeekAhead(dates) {
     const rows = db.prepare(
       `SELECT forecast_day, slot, ts_local, forecast_kwh, forecast_lo_kwh, forecast_hi_kwh
        FROM solcast_snapshots WHERE forecast_day IN (${dates.map(() => '?').join(',')})
        ORDER BY forecast_day, slot`
     ).all(...dates);
     return rows.map(r => {
       const d = new Date(r.ts_local);
       const hh = String(d.getHours()).padStart(2, '0');
       const mm = String(d.getMinutes()).padStart(2, '0');
       return {
         date: r.forecast_day,
         time: `${hh}:${mm}`,
         forecastKwh:   Number(r.forecast_kwh    || 0),
         forecastLoKwh: Number(r.forecast_lo_kwh || 0),
         forecastHiKwh: Number(r.forecast_hi_kwh || 0),
       };
     });
   }
   ```

2. Add endpoint (place after `GET /api/solcast/week-ahead`):
   ```js
   app.post('/api/export/solcast-week-ahead', async (req, res) => {
     try {
       const tz = getSolcastConfig().timeZone || 'Asia/Manila';
       const baseDate = localDateStrInTz(Date.now(), tz);
       const dates = Array.from({ length: 7 }, (_, i) => addDaysIso(baseDate, i + 1));
       const resolution = String(req.body?.resolution || 'daily').trim().toLowerCase();
       const format = String(req.body?.format || 'xlsx').trim().toLowerCase();

       const days = querySolcastWeekAheadDays(baseDate);
       const slotRows = resolution === 'slot' ? querySlotRowsForWeekAhead(dates) : [];

       const rawOutPath = await runGatewayExportJob('solcast-week-ahead', () =>
         exporter.exportSolcastWeekAhead({
           days, slotRows, resolution, format,
           startDay: dates[0], endDay: dates[dates.length - 1],
         }),
       );
       const outPath = await exporter.ensureForecastExportSubfolder(rawOutPath, 'Solcast');
       return res.json(buildExportResult(outPath, { baseDate, days: days.length }));
     } catch (err) {
       return sendExportRouteError(res, err, 'solcast-week-ahead');
     }
   });
   ```

3. Add route to the cancel-eligible route list (if it exists in index.js — search for `"solcast-preview"` in the cancel handler and add `"solcast-week-ahead"` beside it).

**Exit criteria:**
- `POST /api/export/solcast-week-ahead` with `{ resolution: "daily", format: "xlsx" }` returns `{ ok: true, path: "..." }` and a file exists on disk.
- Route is cancellable via the existing cancel mechanism.

---

## Step 5 — UI: Week-Ahead Card, Table, and Chart

**Context:**
Add a new export card in the Export section of `public/index.html`, below the existing "Day-Ahead Forecast Export" card. The card shows:
- A 7-day bar chart (Chart.js, reuse `new Chart(...)` pattern)
- A summary table (Date | Total MWh | Lo | Hi | Status)
- Refresh button (pulls fresh Solcast data → refreshes table/chart)
- Export button (triggers POST to `/api/export/solcast-week-ahead`)
- Resolution select (Daily / Per-Slot 5min)
- Format select (Excel / CSV)

Base date is **always today** — no date picker. The label auto-updates on load/refresh.

**Files to change:**
- `public/index.html`
- `public/js/app.js`

### HTML tasks (`public/index.html`):

Add after the Day-Ahead Forecast Export card (`</div>` that closes the card ending at line ~672):

```html
<div class="exp-card" id="solcastWeekAheadCard">
  <div class="exp-icon exp-icon-report"><span class="mdi mdi-calendar-week" aria-hidden="true"></span></div>
  <div class="exp-title">Solcast Week-Ahead Outlook</div>
  <div class="exp-desc">
    7-day Solcast forecast from today's date. Data refreshes from the stored Solcast snapshots.
    Use <strong>Refresh Solcast</strong> to pull a fresh API fetch first.
  </div>
  <div class="exp-form">
    <label>Resolution
      <select id="solcastWeekAheadResolution" class="sel">
        <option value="daily" selected>Daily Summary</option>
        <option value="slot">Per Slot (5 min)</option>
      </select>
    </label>
    <label>Format
      <select id="solcastWeekAheadFormat" class="sel">
        <option value="xlsx" selected>Excel (.xlsx)</option>
        <option value="csv">CSV</option>
      </select>
    </label>
  </div>
  <div id="solcastWeekAheadChartWrap" style="display:none; margin-bottom:0.5rem;">
    <canvas id="solcastWeekAheadChart" height="180"></canvas>
  </div>
  <div id="solcastWeekAheadTableWrap" style="display:none; overflow-x:auto;">
    <table class="data-table" id="solcastWeekAheadTable">
      <thead><tr>
        <th>Date</th><th>Forecast (MWh)</th><th>Lo (MWh)</th><th>Hi (MWh)</th><th>Status</th>
      </tr></thead>
      <tbody id="solcastWeekAheadTableBody"></tbody>
    </table>
  </div>
  <div class="exp-actions">
    <button id="btnRefreshSolcastWeekAhead" class="btn btn-outline btn-full" type="button"
      title="Fetch fresh Solcast data from the API, then reload the week-ahead table.">
      <span class="mdi mdi-cloud-download-outline" aria-hidden="true"></span><span>Refresh Solcast</span>
    </button>
    <button id="btnExportSolcastWeekAhead" class="btn btn-accent btn-full" type="button"
      title="Export the 7-day Solcast outlook to a file.">
      <span class="mdi mdi-download-outline" aria-hidden="true"></span><span>Export Week-Ahead</span>
    </button>
  </div>
  <div class="exp-result" id="solcastWeekAheadResult"></div>
</div>
```

### JS tasks (`public/js/app.js`):

1. **`loadSolcastWeekAhead()`** — fetches `GET /api/solcast/week-ahead`, populates table and chart:
   ```js
   async function loadSolcastWeekAhead() {
     const result = $('solcastWeekAheadResult');
     if (result) result.textContent = 'Loading…';
     try {
       const data = await api('/api/solcast/week-ahead', 'GET');
       renderSolcastWeekAheadTable(data.days || []);
       renderSolcastWeekAheadChart(data.days || []);
       if (result) result.textContent = '';
     } catch (err) {
       if (result) result.textContent = `✗ ${err.message}`;
     }
   }
   ```

2. **`renderSolcastWeekAheadTable(days)`** — builds `<tr>` rows in `#solcastWeekAheadTableBody`, shows `#solcastWeekAheadTableWrap`.

3. **`renderSolcastWeekAheadChart(days)`** — creates/updates a Chart.js bar chart on `#solcastWeekAheadChart` with daily MWh totals. Key: destroy existing chart before recreating (use `State.charts.solcastWeekAhead` pattern).

4. **`runSolcastWeekAheadExport()`** — POSTs to `/api/export/solcast-week-ahead` with `{ resolution, format }`, shows result in `#solcastWeekAheadResult`.

5. **Button bindings** (in the existing button-binding section):
   ```js
   $('btnRefreshSolcastWeekAhead')?.addEventListener('click', async () => {
     // 1. Trigger Solcast fetch (reuse existing solcast fetch flow or POST to /api/solcast/fetch)
     // 2. Then reload the table
     await loadSolcastWeekAhead();
   });
   $('btnExportSolcastWeekAhead')?.addEventListener('click', runSolcastWeekAheadExport);
   ```

6. **Auto-load on page init**: call `loadSolcastWeekAhead()` from the export section init path (wherever other export cards load their initial state — search for `bindExportUiStatePersistence` or `initExportSection`).

**Exit criteria:**
- On loading the Export page, the week-ahead table auto-populates with 7 rows (today+1 to today+7).
- Days with no Solcast data in DB show "No Data" in the Status column.
- The bar chart renders correctly (days with no data show zero bar).
- "Refresh Solcast" triggers a fresh API fetch and then reloads the table.
- "Export Week-Ahead" downloads an Excel/CSV file to the configured export path.
- No regressions to the existing Day-Ahead Forecast Export card.

---

## Invariants (checked after every step)

- `server/index.js` starts cleanly: `node server/index.js` — no crash.
- Existing Solcast fetch behavior (tomorrow snapshot) still works.
- Existing export cards (Energy, Day-Ahead, Operational Data) unchanged.

## Rollback Strategy

Each step is a pure addition (new function/endpoint/UI block). Rollback = delete the added block. No existing functions are modified beyond the single `buildAndPersistSolcastSnapshot` call in the fetch handler (Step 1).

## Parallelism Note

Steps 2 and 3 are independent and can be developed in parallel. Step 5 (UI) can be partially drafted while Steps 2–4 are in progress; wire the export button last.
