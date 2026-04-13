Energy Summary Export: 500K raw-row cap incorrectly blocks single-day all-inverter exports
==========================================================================================

Issue
-----
In v2.8.4, opening Energy Summary Export with:
  - Inverter: All Inverters
  - Date: any single date
  - Format: Excel (.xlsx) or CSV

returns:
  "Export would return X rows (limit: 500,000). Please narrow the date
   range or select a single inverter."

The dialog only offers a single Date picker -- there is no date range
to narrow -- so the only actionable guidance is "select a single inverter",
which defeats the purpose of the All Inverters option.

Root cause
----------
server/db.js (queryReadingsRangeAll) enforces a 500K row cap measured
against the RAW readings table (per-sample Modbus rows, ~1 sec cadence).
One day of data at 4 inverters * ~6 nodes * 86,400 samples = ~2M raw
rows, which trips the cap.

But the Energy Summary export's FINAL output is tiny -- days * invCount
* nodes rows (~24 rows for one day / 4 inverters / 6 nodes) -- because
buildEnergySummaryExportRows aggregates per-(day, inverter, unit).

The cap is measuring INPUT rows, not OUTPUT rows.

Fix
---
server/exporter.js :: buildEnergySummaryExportRows
  Replace the single queryReadingsRangeAll(s, e) call for the
  all-inverters path with a loop over selectedInvs calling the
  per-inverter queryReadingsRange(inv, s, e) (which has no cap).
  Accumulate rowsByDay incrementally across inverters.

The downstream summarization logic is unchanged; output file is
byte-identical for any range the original call would have processed.

Patch
-----
See docs/fixes/energy-summary-500k-cap.patch for the unified diff.

Affected file:  server/exporter.js
Function:       buildEnergySummaryExportRows (line ~1222)
Scope:          lines 1230-1240 only (+13, -6)

Safety
------
- queryReadingsRange is already used elsewhere and handles archive-DB
  merging the same as queryReadingsRangeAll.
- The 366-day route-level cap (server/index.js: MAX_EXPORT_RANGE_DAYS)
  still guards against pathologically large ranges.
- Other queryEnergy5minRangeAll callers (export5min, exportForecastActual)
  operate on pre-aggregated 5-min rows (~288/day/inv) and won't trip
  the cap for normal ranges, so they are not modified here.

Not addressed here (follow-up work)
-----------------------------------
- server/db.js cap message copy: "Please narrow the date range" is
  misleading when the calling dialog has no date range input.
- Formula-injection escaping (v2.8.2 E1) claimed in release notes but
  not verified present in exporter.js writeExport().
