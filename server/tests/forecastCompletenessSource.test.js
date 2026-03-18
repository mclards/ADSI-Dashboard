"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function run() {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

  assert(src.includes("const FORECAST_SOLAR_SLOT_COUNT ="));
  assert(src.includes("function countDayAheadSolarWindowRows(day)"));
  assert(src.includes("function hasCompleteDayAheadRowsForDate(day)"));
  assert(src.includes("function getIncompleteDayAheadContextDays()"));
  assert(src.includes("if (hasCompleteDayAheadRowsForDate(tomorrow))"));
  assert(src.includes("const incompleteDays = getIncompleteDayAheadContextDays();"));
  assert(src.includes("storedRows <= 0 || incompleteDays.length > 0"));

  console.log("forecastCompletenessSource.test.js: PASS");
}

run();
