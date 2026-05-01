# v2.10.0-beta.3 — Daily Data Export hardening + anchor self-healing

Pre-release. Three rounds of verification fixes plus filename alignment, all
gap-fixes from the parallel `/orchestrate` audits in `audits/2026-04-28/`.

## Operator-visible changes

- **Daily Data Export filename** now matches every other export — `28-04-26 Inverter 1 Daily Data.xlsx` instead of `INV-01 daily-data 2026-04-28.xlsx`.
- **New gap detection endpoint** — `GET /api/params/:inverter/:slave/coverage/:date` reports expected vs present 5-min slots, missing-slot ranges as plant-local HH:MM, and a complete/partial/empty status. Lets operators confirm a date's export is complete before shipping the workbook.
- **Heartbeat now surfaces every aggregator drop-sample reason** — `samplesDroppedOffline`, `samplesDroppedStaleTs`, `samplesDroppedFutureTs`, `samplesDroppedOoOrder`, `samplesDroppedReapedSlot`, `fieldClampCount`, plus `bucketsOpened`, `reaped`, `shutdownFlushes`. Operators can now diagnose "why is my row count low?" without scraping `/api/params/diagnostics`.
- **Anchor pill self-heals on cold-boot scenarios** — the dark-window snapshot capture is now INSERT-or-UPDATE (was UPDATE-only), so it can create yesterday's row when missing. After every successful eod_clean capture, today's `POLL` row is retroactively upgraded to `EOD` if yesterday's eod_clean is now available. Fresh-boot fleet that opened the day on POLL now flips to EOD within seconds.
- **New `EOD-ONLY` pill** surfaces the transitional late-create state (yesterday's close known, morning baseline unknown). Self-heals to EOD/CLEAN tomorrow.
- **POLL tooltip rewritten** to honestly state the trust loss — Etotal Δ undercounts today's energy by whatever the inverter produced before the gateway's first poll.
- **`Temp (°C)` column documented as blank-by-design in v2.10.x** — INGECON SUN does not expose inverter heatsink temperature on the standard FC04 register block. Schema reserves the column so a future register decode populates it without a migration.

## Internal changes

- New pure-function modules: `server/hwCounterDeltaCore.js`, `server/dailyAggregatorCoverage.js`, `server/baselineUpgradeCore.js` — each with regression tests.
- 79 pure-function scenarios green across `hwCounterDeltaCore.test.js` (17), `dailyAggregatorCoverage.test.js` (15), `dailyAggregatorCore.test.js` (18), `baselineUpgradeCore.test.js` (12), `energySummaryScaleCore.test.js` (PASS, contract updated to v2.10.x graceful coverage).
- Refactor: `_hwDeltasForUnitDay` extracted from server/exporter.js into the pure module — exporter is now a thin shim. Production behavior unchanged.

## Audits

- `audits/2026-04-28/v2102beta2-verification-gap-fixes.md` — round 1 (filename + HW delta refactor + doc-sync)
- `audits/2026-04-28/daily-data-export-gap-fixes.md` — round 2 (gap detection + aggregator tests + temp_c docs)
- `audits/2026-04-28/anchor-classification-fixes.md` — round 3 (UPSERT + retroactive upgrade + EOD-ONLY pill + trust ladder)

## Known limitations

- Stream cancellation cleanup test for partial `.xlsx` files is deferred (P2 — would need full integration harness).
- HTTP 423 today-lock integration test is deferred (P2 — would need supertest + clock mocking).
- Recommended: run `npm run smoke` on hardware before promoting any beta to stable.
