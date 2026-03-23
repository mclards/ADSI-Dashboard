"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const tempPortableRoot = path.join(
  __dirname,
  "..",
  "..",
  ".tmp",
  "forecast-average-table-test",
);
fs.mkdirSync(tempPortableRoot, { recursive: true });
process.env.IM_PORTABLE_DATA_DIR = tempPortableRoot;
process.env.ADSI_PORTABLE_DATA_DIR = tempPortableRoot;

const {
  buildForecastActualAverageTableRows,
  buildSolcastAverageTableDays,
  rewriteForecastExportRelativePath,
  ensureForecastExportSubfolder,
  exportForecastActual,
  exportSolcastPreview,
} = require("../exporter");
const { closeDb, setSetting } = require("../db");

const indexSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "index.html"),
  "utf8",
);
const appSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "js", "app.js"),
  "utf8",
);
const exporterSource = fs.readFileSync(
  path.join(__dirname, "..", "exporter.js"),
  "utf8",
);
const indexServerSource = fs.readFileSync(
  path.join(__dirname, "..", "index.js"),
  "utf8",
);

async function run() {
  const exportRoot = path.join(tempPortableRoot, "exports");
  setSetting("csvSavePath", exportRoot);

  const rawRows = [
    { ts: new Date("2026-03-14T05:05:00").getTime(), kwh_inc: 0.5 },
    { ts: new Date("2026-03-14T05:10:00").getTime(), kwh_inc: 1.0 },
    { ts: new Date("2026-03-14T05:15:00").getTime(), kwh_inc: 1.5 },
  ];

  const mappedRows = buildForecastActualAverageTableRows(rawRows);
  assert.strictEqual(mappedRows.length, 3, "Expected 3 mapped 5-minute rows.");
  // period_start 05:05 → period_end 05:10
  assert.strictEqual(mappedRows[0].time, "05:10");
  assert.strictEqual(mappedRows[0].forecastMw, 0.006);
  assert.strictEqual(mappedRows[2].forecastMwh, 0.0015);

  const days = buildSolcastAverageTableDays(mappedRows, "PT15M");
  assert.strictEqual(days.length, 1, "Expected a single day entry.");
  assert.strictEqual(days[0].day, "2026-03-14");
  // Minute 5 is now null (no slot ends at 05:05); Minute 10=0.006, Minute 15=0.012
  assert.deepStrictEqual(days[0].rows[4].values.slice(0, 3), [null, 0.006, 0.012]);
  // PT15M buckets: bucket0=[null,0.006,0.012]→avg=0.009, bucket1=[0.018]→avg=0.018 → mean=0.0135
  assert.strictEqual(days[0].rows[4].average, 0.0135);
  assert.strictEqual(days[0].totalMwh, 0.003);

  // Boundary: day-ahead period_start 05:55 → period_end 06:00 → Hour 5, Minute 60 (index 11)
  const boundaryRaw = [{ ts: new Date("2026-03-14T05:55:00").getTime(), kwh_inc: 2.0 }];
  const boundaryMapped = buildForecastActualAverageTableRows(boundaryRaw);
  assert.strictEqual(boundaryMapped.length, 1, "05:55 slot should survive solar-window filter.");
  assert.strictEqual(boundaryMapped[0].time, "06:00", "05:55 period_start should map to 06:00 period_end.");
  const boundaryDays = buildSolcastAverageTableDays(boundaryMapped, "PT5M");
  assert.strictEqual(boundaryDays[0].rows[4].values[11], 0.024, "05:55 slot should land at Hour 5, Minute 60.");
  assert.strictEqual(boundaryDays[0].rows[5].values[11], null, "05:55 slot must NOT land at Hour 6, Minute 60.");

  // Boundary: Solcast period_end 06:00 → Hour 5, Minute 60 (not Hour 6)
  const solcastBoundaryRows = [{ date: "2026-03-14", time: "06:00", forecastMw: 0.006, forecastMwh: 0.0005 }];
  const solcastBoundaryDays = buildSolcastAverageTableDays(solcastBoundaryRows, "PT5M");
  assert.strictEqual(solcastBoundaryDays[0].rows[4].values[11], 0.006, "Solcast 06:00 period_end should land at Hour 5, Minute 60.");
  assert.strictEqual(solcastBoundaryDays[0].rows[5].values[11], null, "Solcast 06:00 must NOT land at Hour 6, Minute 60.");

  assert(
    appSource.includes('id="anaDayAheadExportFormat"'),
    "Analytics day-ahead card should expose the shared export-format selector.",
  );
  assert(
    indexSource.includes('id="expForecastExportFormat"'),
    "Export page forecast card should expose the shared export-format selector.",
  );
  assert(
    appSource.includes("const exportFormat = getSharedForecastExportFormat();") &&
      appSource.includes("exportFormat,"),
    "Forecast exports should send the selected export format to the backend.",
  );
  assert(
    appSource.includes('forecastExportFormat: "standard"') &&
      appSource.includes("State.forecastExportFormat ||") &&
      appSource.includes("State.forecastExportFormat = normalized;"),
    "Shared forecast export format should be driven by app state before any page-local selector defaults.",
  );
  assert(
    exporterSource.includes("writeDayAheadAverageTableXlsx") &&
      exporterSource.includes("totalLabel: 'GENERATION FORECAST (MWh)'") &&
      !exporterSource.includes("ACTUAL GENERATION (MWh)") &&
      !exporterSource.includes("DAY-AHEAD GENERATION (MWh)"),
    "Average-table analytics export should stay a clean day-ahead-only workbook.",
  );
  assert(
    exporterSource.includes("rewriteForecastExportRelativePath") &&
      exporterSource.includes("ensureForecastExportSubfolder"),
    "Forecast exports should include legacy flat-path repair helpers.",
  );
  assert(
    indexServerSource.includes("normalizeForecastExportRelativePathForRoute") &&
      indexServerSource.includes('isSolcast ? "Solcast" : "Analytics"') &&
      indexServerSource.includes('ensureForecastExportSubfolder(rawOutPath, "Solcast")') &&
      indexServerSource.includes("relativePath: remoteRelativePath"),
    "Server routes should repair legacy flat forecast export paths for local and remote flows.",
  );

  const legacyRelative = path.join(
    "All Inverters",
    "Forecast",
    "140326 All Inverters Day-Ahead vs Actual 5min.xlsx",
  );
  assert.strictEqual(
    path.normalize(rewriteForecastExportRelativePath(legacyRelative, "Analytics")),
    path.normalize(
      path.join(
        "All Inverters",
        "Forecast",
        "Analytics",
        "140326 All Inverters Day-Ahead vs Actual 5min.xlsx",
      ),
    ),
    "Legacy forecast comparison exports should be rewritten into Forecast\\Analytics.",
  );

  const legacyAbsolute = path.join(
    exportRoot,
    "All Inverters",
    "Forecast",
    "legacy-standard.xlsx",
  );
  fs.mkdirSync(path.dirname(legacyAbsolute), { recursive: true });
  fs.writeFileSync(legacyAbsolute, "legacy");
  const repairedAbsolute = await ensureForecastExportSubfolder(legacyAbsolute, "Analytics");
  assert(
    path.normalize(repairedAbsolute).includes(
      path.normalize(path.join("All Inverters", "Forecast", "Analytics")),
    ),
    "Legacy flat forecast exports should be moved into Forecast\\Analytics.",
  );
  assert(fs.existsSync(repairedAbsolute), "Repaired forecast export should exist.");
  assert(
    !fs.existsSync(legacyAbsolute),
    "Legacy flat forecast export should be removed after repair.",
  );

  const analyticsStandardPath = await exportForecastActual({
    startTs: new Date("2026-03-14T05:00:00").getTime(),
    endTs: new Date("2026-03-14T18:00:00").getTime(),
    resolution: "5min",
    format: "xlsx",
    exportFormat: "standard",
  });
  assert(
    path.normalize(analyticsStandardPath).includes(
      path.normalize(path.join("All Inverters", "Forecast", "Analytics")),
    ),
    "Standard analytics export should also be written under Forecast\\Analytics.",
  );
  assert(fs.existsSync(analyticsStandardPath), "Standard analytics export file should exist.");

  const analyticsPath = await exportForecastActual({
    startTs: new Date("2026-03-14T05:00:00").getTime(),
    endTs: new Date("2026-03-14T18:00:00").getTime(),
    resolution: "5min",
    format: "xlsx",
    exportFormat: "average-table",
  });
  assert(
    path.normalize(analyticsPath).includes(
      path.normalize(path.join("All Inverters", "Forecast", "Analytics")),
    ),
    "Analytics day-ahead export should be written under Forecast\\Analytics.",
  );
  assert(fs.existsSync(analyticsPath), "Analytics export file should exist.");

  const solcastPath = await exportSolcastPreview({
    rawRows: [
      {
        date: "2026-03-14",
        time: "05:05",
        forecastMw: 9.876,
        forecastMwh: 0.823,
      },
    ],
    rows: [],
    startDay: "2026-03-14",
    endDay: "2026-03-14",
    resolution: "PT5M",
    exportFormat: "average-table",
    format: "xlsx",
  });
  assert(
    path.normalize(solcastPath).includes(
      path.normalize(path.join("All Inverters", "Forecast", "Solcast")),
    ),
    "Solcast preview export should be written under Forecast\\Solcast.",
  );
  assert(fs.existsSync(solcastPath), "Solcast export file should exist.");
}

run()
  .then(() => {
    console.log("forecastActualAverageTable.test.js: PASS");
  })
  .catch((err) => {
    console.error("forecastActualAverageTable.test.js: FAIL", err?.stack || err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      closeDb();
    } catch {}
    try {
      fs.rmSync(tempPortableRoot, { recursive: true, force: true });
    } catch {}
  });
