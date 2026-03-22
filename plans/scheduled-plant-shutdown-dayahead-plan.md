# Scheduled Plant Shutdown Day-Ahead Adjustment Plan

## Summary
Add a plant-wide scheduled shutdown feature that lets operators define one-off and recurring shutdown windows in plant-local time, with `server_down=true` as a first-class flag. Scheduled shutdown windows must force day-ahead and intraday-adjusted forecast slots to `0` inside the affected window. Raw telemetry and history stay immutable; the feature is stored as separate schedule metadata and then applied consistently to forecast logic, analytics/history views, reports, and exports. Shutdown windows are treated as planned exclusions, not faults, so they are excluded from forecast QA/training and from derived KPI penalties in reports.

## Draft Status
- Drafted on `2026-03-20`
- Scope: forecast adjustment, dashboard note/flagging, history/report/export awareness for scheduled plant shutdown windows
- Decisions locked:
  - forecast behavior: force zero during scheduled shutdown windows
  - history basis: annotate only, do not rewrite raw telemetry/history
  - report math: planned exclusion, not real downtime penalty
  - schedule scope: one-off and recurring
  - dashboard visibility: global banner/chip plus affected date/page indicators

## Progress
- [x] Confirm no existing scheduled-shutdown feature already exists in the forecast flow
- [x] Map the current forecast, report, export, and settings integration points
- [x] Define the product behavior for forecast adjustment, dashboard notes, and report treatment
- [ ] Add persistent schedule storage and APIs
- [ ] Apply scheduled shutdown masks to forecast generation, QA, and training
- [ ] Surface scheduled shutdown banners, notes, and affected-window indicators in the dashboard
- [ ] Extend reports and exports to honor planned shutdown windows without rewriting raw history
- [ ] Add automated coverage for schedule resolution, forecast zeroing, report math, and exports

## Implementation Plan

### 1. Data Model and APIs
- Add a new replicated SQLite table `scheduled_shutdowns` in `server/index.js`.
- Store plant-wide rules only in `v1`. No per-inverter or per-node shutdown scheduling.
- Rule schema:
  - `id`
  - `title`
  - `note`
  - `active`
  - `server_down` default `1`
  - `forecast_mode` fixed to `force_zero`
  - `history_mode` fixed to `annotate_only`
  - `report_mode` fixed to `planned_exclusion`
  - `start_local`
  - `end_local`
  - `recurrence_kind` one of `none`, `daily`, `weekly`, `monthly_date`
  - `recurrence_interval` integer default `1`
  - `recurrence_weekdays_json` for weekly rules
  - `recurrence_day_of_month` for monthly-date rules
  - `until_local_date` nullable
  - `created_ts`
  - `updated_ts`
- Resolve all schedule windows in the configured plant timezone from Settings, falling back to `Asia/Manila`.
- Support windows that cross midnight by resolving against local start/end datetimes, not slot-only ranges.
- Add API endpoints:
  - `GET /api/scheduled-shutdowns?from=YYYY-MM-DD&to=YYYY-MM-DD&resolved=1`
  - `POST /api/scheduled-shutdowns` for create/update
  - `POST /api/scheduled-shutdowns/delete`
- Return both raw rules and resolved occurrences when `resolved=1`.
- Add resolved shutdown occurrences to affected date/range endpoints as metadata, not by mutating raw interval rows.

### 2. Forecast Engine Behavior
- Extend the existing operational-constraint path in `services/forecast_engine.py` with a distinct `scheduled_shutdown_mask`.
- Keep manual-stop and cap-dispatch masks separate, but introduce a shared exclusion mask for forecast consumers:
  - `effective_constraint_mask = operational_mask | scheduled_shutdown_mask`
- Apply the scheduled shutdown mask to:
  - day-ahead generation
  - intraday-adjusted forecast generation
  - forecast QA metrics
  - backtests
  - Solcast reliability scoring
  - training sample collection
  - residual/error-class model fitting
  - weather-error profiles and artifact generation
- Force generated forecast values to `0` for scheduled shutdown slots before persistence.
- Persist schedule metadata in forecast response payloads and snapshot metadata so the UI and exports can explain why those slots are zeroed.

### 3. Dashboard, History, Reports, and Exports
- Add a schedule editor UI under the existing Forecast settings area, and mount the same block on the Forecast page.
- UI fields:
  - title
  - note
  - start date/time
  - end date/time
  - recurrence kind
  - recurrence interval
  - weekly weekdays when needed
  - monthly day-of-month when needed
  - until date
  - active toggle
  - server down badge, fixed on
- Add a global banner/chip system in `public/js/app.js`:
  - current-day pages show `upcoming` or `active` scheduled shutdown windows
  - date-selected pages show `selected date has scheduled shutdown`
  - banner text includes exact local dates/times and `dashboard server will be down` when `server_down=1`
- Do not rewrite `readings`, `energy_5min`, or persisted `daily_report` rows.
- For history/report/export behavior:
  - interval/history APIs expose resolved shutdown windows as metadata for the requested range
  - analytics and forecast pages shade or mark the affected time range
  - report summary logic excludes scheduled shutdown seconds from availability/performance denominator math
  - forecast variance, QA, and comparison logic exclude scheduled shutdown slots
  - interval exports add `scheduled_shutdown` and `scheduled_shutdown_note` columns
  - daily report exports add day-level shutdown metadata such as `planned_shutdown_flag`, `planned_shutdown_seconds`, and window text in the export header or summary block
- Include the new table in replication automatically by registering it in the replication table map and merge rules.

## Test Plan
- CRUD tests for `scheduled_shutdowns` create, update, list, delete, and replication merge behavior.
- Resolution tests for:
  - one-off same-day window
  - one-off cross-midnight window
  - daily recurrence
  - weekly recurrence with multiple weekdays
  - monthly-date recurrence
  - inactive rules
  - timezone-local resolution
- Forecast tests proving scheduled slots are zeroed in both day-ahead and intraday-adjusted output while unscheduled slots remain unchanged.
- Forecast QA/training tests proving scheduled shutdown slots are excluded from metrics, residual fitting, classifier labels, and historical weather-profile scoring.
- Report and summary tests proving planned shutdown seconds are excluded from KPI penalty math.
- API tests proving history/report/date-range endpoints return resolved shutdown metadata without rewriting raw rows.
- Export tests proving affected exports carry shutdown flags and notes.
- UI checks proving:
  - schedule editor renders and saves correctly
  - global banner appears for active, upcoming, and selected-date shutdowns
  - forecast and analytics visuals clearly mark the shutdown window

## Assumptions and Defaults
- `v1` is plant-wide only.
- The feature is advisory plus forecast-adjusting only; it does not auto-stop or auto-start the dashboard server.
- Raw telemetry/history remains the source of truth and is never rewritten for scheduled shutdowns.
- Scheduled shutdown windows are treated as planned exclusions everywhere derived math is computed.
- The recurrence scope for `v1` is exactly `none`, `daily`, `weekly`, and `monthly_date`; do not implement arbitrary RRULE parsing.
