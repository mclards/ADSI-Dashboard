# ADSI Inverter Dashboard User Manual

**Applies to:** ADSI Inverter Dashboard `v2.6.5`
**Document type:** Operator and administrator reference  
**Scope:** Main dashboard, forecast workspace, settings center, cloud backup, standby database workflow, alarm handling, exports, IP Configuration, and Topology

---

## 1. Purpose

This manual provides a complete operational guide for the ADSI Inverter Dashboard. It is intended for plant operators, supervisors, maintenance personnel, and authorized administrators who use the dashboard to:

- monitor inverter and node status in real time
- review alarms, energy history, analytics, and daily reports
- generate or validate day-ahead forecast data
- export operational records
- manage gateway or remote workstation behavior
- maintain settings, licensing, updates, backups, and standby database refreshes

This document follows the current implementation in this repository and is written to match the dashboard labels and workflows used by the application.

---

## 2. System Overview

### 2.1 Primary Functions

The dashboard is a plant operations workstation for centralized inverter supervision. It combines live telemetry, historical review, controlled command actions, forecast support, reporting, and administrative maintenance in one application.

### 2.2 Operating Modes

| Mode | Purpose | Main Behavior | Typical Use |
| --- | --- | --- | --- |
| `Gateway` | Local plant-connected workstation | Polls and persists plant data locally | Main on-site control and reporting station |
| `Remote` | Gateway-linked viewer workstation | Streams live data from the gateway and proxies historical access | Off-site monitoring, review, and supervised control |

If the application starts in `Remote` mode and the gateway is unreachable, the startup loading screen displays a **Connection Mode** picker. The picker allows the operator to switch to `Gateway` mode immediately or retry the `Remote` connection without restarting the application manually.

### 2.3 Data Architecture

| Data Layer | Description | Used For |
| --- | --- | --- |
| `Main DB` | Current working database containing hot operational data | Live history, reports, analytics, exports, local gateway operation |
| `Archive DBs` | Monthly historical database files | Long-term history, older reports, historical exports |
| `Standby DB` | Staged local copy of the gateway main database | Local standby use before switching back to `Gateway` mode |
| `Live Stream` | Real-time gateway-fed runtime data in `Remote` mode | Current values, live status, alarms, control visibility |

### 2.3.1 Live Updates vs Historical Queries

The dashboard keeps the live operations path separate from the historical-read path so the gateway can continue polling devices, persisting data, and serving the active dashboard without unnecessary lag.

Typical operating flow:

```text
Devices
   ->
Gateway poller
   -> Main DB
   -> Live stream -> Dashboard UI

Dashboard UI
   -> On-demand history/report/export request
   -> Gateway API
   -> Main DB or Archive DBs
```

Operational rule:

- Use the live stream for current values, alarm visibility, topology state, and other continuously changing dashboard elements.
- Use HTTP API reads for initial page state, historical charts, reports, analytics ranges, and export jobs.
- Request history on demand and by explicit time range instead of repeatedly reloading large windows in the background.
- Prefer summarized datasets such as daily reports or interval-energy tables when they satisfy the screen requirement.
- Keep full standby DB refreshes and archive transfers as separate maintenance actions, not as part of normal live viewing.

This split protects the source gateway from avoidable load. Large historical pulls, archive downloads, and export generation may consume noticeable disk, CPU, and network resources, so they should stay off the live refresh path.

### 2.3.2 Historical Data Without Slowing the Gateway

When a remote operator needs history without collapsing or lagging the source dashboard, use this pattern:

```text
Client start
   ->
GET lightweight current snapshot
   ->
connect live stream
   ->
render live dashboard updates

Only when needed:
   ->
GET or POST bounded history/report/export request
   ->
render the returned historical dataset separately
```

Implementation guidance for this repository:

- Do not tie historical reloads to every live update tick.
- Do not keep refetching large date ranges while the live dashboard is open.
- Use bounded queries, pagination, or aggregated intervals for long ranges.
- Run heavy export and standby-refresh tasks in their dedicated background flow.
- Schedule full standby DB refreshes during lower-traffic windows when fresh local offline history is required.

### 2.4 Important Standby DB Rule

The `Refresh Standby DB` action stages archive DB files first (when included) for historical consistency, then downloads the gateway main database for local use. The staged database is **not** applied immediately — a restart is needed to activate the new data.

The staged standby refresh also preserves the gateway's current-day energy baseline so that, after restart and switch back to `Gateway` mode, `TODAY MWh` can bridge cleanly while the local poller catches up.

### 2.5 Current-Day Energy Authority

For the current day, the dashboard treats these values as one aligned metric family:

- `TODAY MWh`
- analytics `Actual MWh` when the selected date is today
- per-inverter `Today Energy`

Operational rule:

- these values are computed on the server from `PAC x elapsed time`
- the server combines persisted `energy_5min` totals with the current live partial interval
- they are **not** taken directly from inverter lifetime-energy registers or Python `/metrics` energy fields
- current-day exports use the same server-side current-day snapshot so exported totals match the displayed totals as of export time

### 2.6 Polling and Logging Outside Solar Hours

Outside the normal solar window, the system still polls devices so operators can continue to see:

- communication status
- current online or offline state
- active alarm state
- gateway or remote health

Operational rule:

- raw telemetry persistence for `readings` and `energy_5min` remains limited to the solar window
- alarm and audit logging may still continue outside the solar window
- graceful shutdown does not force an off-window raw-telemetry write

---

## 3. Interface Layout

### 3.1 Header Bar

The fixed header is the primary global status strip.

| Element | Meaning | Operator Use |
| --- | --- | --- |
| Plant logo/title area | Identifies the plant and dashboard instance | Visual confirmation of the correct workstation |
| `TOTAL PAC` | Total present plant active power | Quick view of current plant output in `kW` |
| `TODAY MWh` | Today accumulated plant energy | Daily generation reference in `MWh` |
| Alarm sound button | Mutes or unmutes alarm audio | Silence notification sound without disabling alarms |
| Theme toggle | Changes dashboard appearance | Switch between available visual themes |
| Connection dot | Live connection indicator | Quick check of data-link health |
| Clock and date | Local workstation time | Time reference for operations and event review |
| Menu button | Opens or closes the side navigation | Access page tabs and About section |

### 3.2 Global Progress and Notice Areas

| Element | Meaning |
| --- | --- |
| Progress row under header | App-level background progress feedback |
| License notice | Appears when license action is required or recommended |

### 3.3 Side Navigation

The right-side navigation contains the main pages:

- `Inverters`
- `Analytics`
- `Forecast`
- `Alarms`
- `Energy`
- `Audit`
- `Report`
- `Export`
- `Settings`

The `About` card also shows:

- installed application version
- data directory
- license state
- update state
- website reference
- user guide access

### 3.4 Overlay Panels and Popups

| Overlay | Purpose |
| --- | --- |
| Alarm notification bell/panel | Quick list of active unacknowledged alarms |
| Operator Messages panel | Short notes exchanged between gateway and remote operators |
| User Guide modal | Embedded quick-reference guide |
| Bulk authorization modal | Required for selected multi-inverter control actions |
| Mode transition overlay | Temporarily blocks normal actions while the selected runtime becomes ready |
| Confirm dialogs | Used before important actions such as restore, mode switch, refresh, or delete |
| Camera Settings modal | Configures camera stream mode, connection, and go2rtc service controls |

---

## 4. Data Types, Units, and Uses

### 4.1 Operational Data Types

| Data Type | Typical Fields | Where Used | Operational Purpose |
| --- | --- | --- | --- |
| Live telemetry | inverter, node, `pac`, `pdc`, online, alarm, last seen | Inverters page, header metrics, topology | Real-time operating awareness |
| Interval energy | date, interval end, inverter, interval energy | Energy page, Analytics page, exports | Production tracking and interval review |
| Alarm event | alarm time, inverter, node, code, severity, description, cleared, status, acknowledged | Alarms page, notification panel, inverter detail | Fault review and operator response |
| Audit event | timestamp, operator, inverter, node, action, scope, result, IP | Audit page, audit export | Command accountability and traceability |
| Daily report record | inverter, energy, peak output, average output, uptime, alarms, availability, performance | Report page, report export | Formal daily performance review |
| Forecast data | date, interval, forecast energy/power, estimated actual, variance | Analytics page, Forecast page, forecast export | Day-ahead planning and comparison |
| Weather data | date, sky, temperature min/max, rainfall, cloud cover | Analytics page, Forecast context | Production context and expectation setting |
| Runtime health data | CPU, memory, uptime, polling metrics, fetch errors, connected clients | Settings -> Connectivity & Sync | Technical health monitoring |
| Replication and standby data | mode, gateway link, last success, standby status, transfer progress, archive option | Settings -> Connectivity & Sync | Remote readiness and local standby maintenance |
| Backup package | provider, scope, size, created time, status | Settings -> Cloud Backup & Restore | Disaster recovery and controlled rollback |

### 4.2 Core Display Units

| Item | Unit | Meaning |
| --- | --- | --- |
| `PAC` | `W` or `kW` | Active AC output power |
| `PDC` | `W` or `kW` | DC-side input power |
| Energy | `MWh` | Produced electrical energy |
| Duration | seconds, minutes, hours, days | Event age, uptime, or interval length |
| CPU | percent | Runtime processor load |
| Memory | RSS size | Resident memory used by the app |
| RX / TX | `B/s`, `KB/s`, etc. | Current transfer speed during link or file activity |

### 4.3 Status Terms

| Status | Meaning |
| --- | --- |
| `Online` | Fresh data is available and the unit is communicating normally |
| `Offline` | No current live data is available |
| `Stale` | Last retained snapshot is shown while fresh data is temporarily unavailable |
| `Alarm` | Alarm condition is active |
| `Critical` | Highest alarm condition in the current summary |
| `Acknowledged` | Alarm has been operator-acknowledged |
| `Isolated` / `N/A` | Node is not configured for that inverter position |

### 4.4 Node Power Band Legend

The inverter toolbar legend classifies node PAC against the configured node rated output.

| Band | Rule |
| --- | --- |
| `High` | `>= 90%` of rated node output |
| `Moderate` | `> 70%` of rated node output |
| `Mild` | `> 40%` of rated node output |
| `Low` | `<= 40%` of rated node output |
| `Alarm` | Alarm condition overrides the normal band display |

---

## 5. Header and Global Features

### 5.1 Alarm Sound Control

Use the speaker button in the header to mute or restore alarm sound. This affects sound only; alarms continue to be detected, displayed, and logged.

Current behavior:

- alarm sound starts only when an unacknowledged alarm remains active for at least `5` seconds
- very short alarm blips do not trigger audio
- if a node already has an active alarm and the alarm value expands or changes while staying active, the dashboard keeps that as the same active alarm episode and does not replay the sound just because an additional alarm bit appeared

### 5.2 Theme Selection

Use the theme toggle to switch the dashboard visual theme. Theme choice persists between restarts.

### 5.3 Alarm Notification Bell and Quick-ACK

The alarm bell appears when active unacknowledged alarms exist. It opens the alarm notification panel without forcing page navigation.

The notification panel shows up to 50 recent active alarms. Each unacknowledged alarm entry includes:

- inverter label and alarm code with severity
- alarm description
- timestamp
- **`✔ ACK` button** — acknowledges the alarm directly from the panel without navigating to the Alarms page

Already-acknowledged alarms show a muted **`✔ Acked`** label instead of the button.

Alarm toasts (the pop-up notifications that appear in the corner when a new alarm is raised) also include an inline **`ACK`** button. Clicking ACK from a toast:

- immediately registers the acknowledgement
- auto-dismisses the toast after a short delay

Use the Alarms page for formal review, bulk acknowledgement, and history. Use the bell panel and toast buttons for quick acknowledgement without leaving the current page.

### 5.4 Operator Messages

The floating message bubble opens the `Operator Messages` panel. This panel supports:

- viewing gateway or remote notes
- sending short operational messages
- clearing recent messages
- auto-close after inactivity

### 5.5 License Notice

If the current license requires attention, the dashboard displays a notice bar with a direct upload action for a replacement license.

### 5.6 Administrator Launch Behavior

New installer builds are configured so the Windows app launches with administrator rights.

Operational note:

- Windows may show a User Account Control prompt when the app starts
- operators should allow the elevation prompt so the workstation can access protected local resources consistently
- this behavior comes from the application manifest in the installed executable, not from a desktop shortcut setting alone
- the current Windows release set is installer-only; a portable EXE is not generated by current builds

---

## 6. Main Pages

## 6.1 Inverters Page

The `Inverters` page is the primary live operations page.

### Purpose

- monitor the full inverter fleet in real time
- review node-by-node operating state
- send start or stop commands
- review or supervise plant-wide MW capping (now on the dedicated **Plant Cap** page)
- inspect current alarms and recent inverter history

### Toolbar Controls

| Control | Function |
| --- | --- |
| `All Inverters` filter | Show the full fleet or focus on one inverter |
| `Layout` | Change the grid column layout |
| _(Plant Cap has moved to its own dedicated page — see Section 5.2)_ | |
| Status legend | Shows output-band colors and alarm state meaning |
| Fleet stat chips | Summarize inverter count, node count, online, alarmed, and offline totals |

The status legend keeps fixed signal colors across all themes:

- green for `High`
- yellow for `Moderate`
- orange for `Mild`
- red for `Low`
- blinking red for `Alarm`

### Inverter Card Contents

Each inverter card contains:

- inverter title and current state badge
- inverter-wide start and stop buttons displayed side by side
- compact inline `Pdc` and `Pac` summary cells
- node table

The PAC strip is intentionally shorter than the node table area so the card keeps a dense operational layout without making the summary values smaller than the row data.

### Node Table Columns

| Column | Meaning |
| --- | --- |
| `Node` | Node label such as `N1`, `N2`, `N3`, `N4` |
| `Alarm` | Current alarm code shown in hexadecimal format such as `0000H` |
| `Pdc (W)` | Node DC power |
| `Pac (W)` | Node AC power |
| `Last Seen` | Last telemetry timestamp for that node |
| `Ctrl` | Node-level start/stop or `N/A` for isolated nodes |

### Node Controls

| Action Type | Scope | Notes |
| --- | --- | --- |
| Node button | Single node | Sends a single `START` or `STOP` command |
| Card `Start` / `Stop` | Entire inverter | Sends the same command to all configured nodes in that inverter |
| Bulk control | Selected inverter set | Requires a separate authorization step |

### Bulk Inverter Command Panel

The bulk control panel is located with the inverter grid and supports structured inverter targeting.

| Field or Action | Function |
| --- | --- |
| `Inverter Numbers / Ranges` | Accepts values such as `1-13, 16, 18, 23-27` |
| `All Inverters` | Fills the full valid inverter range automatically |
| `Clear` | Clears the current selection |
| `START SELECTED` | Sends start command to configured nodes in selected inverters |
| `STOP SELECTED` | Sends stop command to configured nodes in selected inverters |

Important behavior:

- duplicate inverter entries are rejected
- invalid range tokens are rejected
- isolated inverters are skipped automatically
- current builds batch whole-inverter and selected-inverter node writes per inverter so one inverter action does not wait for a separate gateway HTTP request per node
- selected multi-inverter actions require an authorization key from authorized personnel

### 5.2 Plant Cap Page

The **Plant Cap** page is a dedicated workspace accessible from the navigation bar. It contains the full plant output cap controller, schedule management, and action history.

#### Page Toolbar

The toolbar at the top displays live summary indicators:

| Element | Function |
| --- | --- |
| `Status` badge | Current controller mode: **Enabled**, **Paused**, or **Idle** |
| `Plant MW` | Current total plant AC output from live PAC data |
| `Band` | Configured lower–upper MW cap band |
| `+ Add Schedule` button | Opens the schedule creation modal |

#### Cap Inputs

| Field | Function |
| --- | --- |
| `Upper Limit (MW)` | Upper plant MW threshold that triggers automatic capping decisions |
| `Lower Limit (MW)` | Lower plant MW threshold used to decide whether eligible stopped non-exempt inverters may be restarted |
| `Sequence` | Inverter selection mode: `Ascending`, `Descending`, or `Exemption` |
| `Exempted Inverter Numbers` | Comma-separated inverter numbers skipped during automatic stop selection |
| `Cooldown (s)` | Settling time after each automatic stop or restart before the next controller decision |

#### Cap Actions

| Action | Function |
| --- | --- |
| `Preview Plan` | Simulates the next stop or restart decision using the current live plant state |
| `Enable Cap` | Enables gateway-side plant output capping after confirmation and authorization |
| `Disable Monitoring` | Stops automatic capping for the current session without automatically restarting controller-owned inverters |
| `Release Controlled Inverters` | Restarts controller-owned inverters sequentially and ends the current plant-cap session |

#### Cap Status Panel

The status panel reports live controller state through a set of labeled metrics:

| Metric | Meaning |
| --- | --- |
| `Status` | Controller state: Idle, Monitoring, Stopping, Starting, Paused, or Fault |
| `Reason` | Human-readable explanation of the current state or pending action |
| `Last Action` | Most recent automatic stop or restart, with inverter number and timestamp |
| `Cooldown` | Remaining settling time after the most recent controller action |
| `Curtailed` | Total MW removed by controller-owned stops (sum of Pac at each stop time) |
| `Controllable` | Number of inverters eligible for stop selection |
| `Pending` | In-flight controller action, if any |
| `Exempted` | Inverter numbers excluded from automatic stop selection |

#### Controlled Inverters Table

When the controller owns one or more stopped inverters, a detailed table appears inside the cap panel:

| Column | Meaning |
| --- | --- |
| `Inverter` | Inverter number stopped by the controller |
| `Stopped At` | Time the controller issued the stop command |
| `Duration` | Elapsed time since the stop (e.g. 12m 35s or 2h 05m), updated each render cycle |
| `Pac Removed (kW)` | AC power output at the moment of stop |
| `Nodes` | Enabled node count at the time of stop |
| `Rated kW` | Node-adjusted rated inverter capacity |
| `Depend. kW` | Node-adjusted dependable inverter capacity |

#### Cap-Stopped Inverter Card Indicators

Inverters stopped by the plant cap controller are visually distinct in the inverter grid:

- the card badge changes from `OFFLINE` to `CAP STOPPED` (blue)
- a stoppage timestamp appears below the badge showing when the controller stopped the inverter
- the card border and icon shift to a blue accent instead of the dimmed gray used for regular offline inverters
- the card stays at full opacity, unlike ordinary offline cards which are dimmed
- indicators appear on all three themes (dark, light, classic) and clear automatically when the inverter is released or the cap session ends

#### Cap Plan Preview

The preview table shows each candidate inverter in sequence order with its node count, rated and dependable capacity, estimated step kW, projected plant MW after the step, and the planner's decision reason. The selected candidate (the next action the controller would execute) is highlighted.

#### Operational Rules

- current builds use whole-inverter sequential stopping and starting only
- planning is node-aware and capacity-aware; enabled node count affects each inverter step size
- live inverter `Pac` is the primary estimate for the next shedding step
- dependable inverter capacity is used as the fallback and as the stability guard when the cap band is very narrow
- while plant-cap monitoring is enabled, all non-exempted inverters are treated as controller-controlled assets
- the controller may restart any eligible fresh stopped non-exempt inverter; controller-owned stops are still tracked separately for release order and history
- manual control for non-exempted inverters is blocked while plant cap is active; the operator is warned that the cap session is still ongoing and must disable or exempt first
- a very small gap between `Upper Limit` and `Lower Limit` produces warnings because the controller may overshoot or fail to settle cleanly
- hover descriptions are available on plant-cap controls, metrics, warnings, and preview fields
- in `Remote` mode, the panel remains viewable and the requests are proxied to the gateway workstation
- if a remote workstation reports `Cannot POST /api/plant-cap/...`, the gateway is usually running an older build or the remote gateway target is incorrect
- all cap controller stop and start actions are recorded in the Audit page with scope `PLANT-CAP`

#### Scheduled Auto-Cap

The **Scheduled Auto-Cap** section displays compact chip cards for each configured schedule. Each chip shows the time window, schedule name, and a state badge (Active, Waiting, Paused, Completed, or Disabled).

| Action | How |
| --- | --- |
| Create schedule | Click **+ Add Schedule** in the toolbar or **+ Add** in the chip section |
| Edit schedule | Click the pencil icon on any schedule chip |
| Delete schedule | Use the delete option in the schedule detail |

##### Schedule Form (Modal)

The schedule form opens as a centered modal overlay:

| Field | Description |
| --- | --- |
| `Name` | Display label for the schedule |
| `Start Time` * | 24-hour HH:MM when the cap activates daily |
| `Stop Time` * | 24-hour HH:MM when the cap releases daily (must be after start) |
| `Upper MW` | Override for this schedule (blank uses global default) |
| `Lower MW` | Override for this schedule (blank uses global default) |
| `Sequence Mode` | Override inverter selection order (blank uses global default) |
| `Cooldown (s)` | Override cooldown seconds (blank uses global default) |
| `Auth Key` * | Plant-wide control authorization key (required for all mutations) |

### Inverter Detail Panel

Selecting an inverter opens a focused detail view with:

- live inverter card
- `Today's Alarm Activity`
- `Last 7 Days Summary`

Use this view for closer troubleshooting or shift handover review.

---

## 6.2 Analytics Page

The `Analytics` page supports interval-based review of production and day-ahead comparison.

### Main Controls

| Control | Function |
| --- | --- |
| `Date` | Selects the day to analyze |
| `Interval` | Chooses chart interval: `5 min`, `15 min`, `30 min`, or `1 hour` |
| `Load View` | Loads the analytics set for the selected date and interval |

### Top Summary Row

The toolbar summary shows:

- selected interval
- total energy
- peak plant output
- reporting inverter count
- latest interval

### Generated Analytics Cards

The page builds:

- one total plant energy chart
- one selected-date summary card
- one chart per inverter

### Selected Date Summary Card

| Item | Meaning |
| --- | --- |
| `Actual MWh` | Authoritative total daily energy. For today's date this stays live and updates automatically as new energy data arrives over the gateway connection |
| `Day-ahead MWh` | Forecast total daily energy |
| `Variance MWh` | Difference between actual and day-ahead values |
| `Peak Interval` | Highest interval energy or output summary for the selected view |

Operational note:

- when **today's date** is selected, the summary card and interval charts update automatically on each server push, at the same cadence as `TODAY MWh` in the header — no manual reload is needed
- for past dates, data is loaded on demand by pressing `Load View`

### Day-ahead Generator

The analytics side card includes:

- `Days` input
- `Generate` button

Operational rule:

- day-ahead generation is available on the `Gateway` workstation only
- in `Remote` mode, generation is blocked and should be performed from the gateway workstation
- generated day-ahead data can be exported from the dedicated Export page

### Weekly Weather Outlook

The `7-Day Weather Outlook` provides context for expected production behavior using:

- sky condition
- temperature range
- rainfall
- cloud percentage

Use this view to support planning, performance interpretation, and forecast review.

---

## 6.3 Forecast Page

The `Forecast` page provides a dedicated workspace for forecast configuration and validation. In the current UI, this page hosts the forecast settings section directly in its own workspace.

### Purpose

- manage forecast source selection
- configure Solcast access
- test connectivity
- preview toolkit forecast data
- export preview data

### Forecast Source Options

| Option | Use |
| --- | --- |
| `Local ML (Current)` | Standard local forecasting source |
| `Solcast` | External forecast source for validation or alternate use |

### Solcast Access Modes

| Access Mode | Use |
| --- | --- |
| `Toolkit Login` | Reads the Solcast toolkit chart feed using account sign-in |
| `API Key` | Uses formal Solcast API credentials and resource ID |

### Forecast Fields

| Field | Purpose |
| --- | --- |
| `Solcast Base URL` | Target Solcast service endpoint |
| `Timezone` | Timezone used for forecast interpretation |
| `Solcast API Key` | API credential for API mode |
| `Resource ID` | Solcast site or resource identifier |
| `Toolkit Chart URL` | Exact Solcast toolkit chart link |
| `Toolkit Email` | Toolkit account user name |
| `Toolkit Password` | Toolkit account password |

### Toolkit Preview

When toolkit preview is enabled, the forecast workspace provides:

| Control or Metric | Purpose |
| --- | --- |
| `Start Day` | First day shown in preview |
| `Days to Display` | Number of days included |
| `Chart Unit` | View values as `MWh` or `MW` |
| `Forecast Total` | Total forecasted energy in the selected window |
| `Estimated Actual` | Estimated actual value for comparison |
| `Selected Range` | Exact date window shown |
| `Window` | Solar review window, shown as `05:00-18:00` in the current UI |

### Forecast Actions

| Button | Function |
| --- | --- |
| `Save Forecast Settings` | Saves forecast settings using the same settings save flow |
| `Refresh Preview` | Reloads toolkit preview using current form values |
| `Save and Test Solcast` | Saves active values, then tests the chosen Solcast mode |

| `Test Solcast Connection` | Tests current values without saving |

### Forecast Performance Monitor

The Forecast Performance Monitor provides a visual audit of the ML forecast engine: health status, accuracy trends, and a per-day comparison table for the selected look-back window. Access it from the **Analytics** page (scroll below the analytics charts).

#### Health Chips

| Chip | What it shows |
| --- | --- |
| `ML Training` | Status of the last model training run: *Trained*, *Rejected (N consecutive)*, or *No data* |
| `Last Run` | Outcome of the most recent day-ahead generation attempt and its timestamp |
| `Provider` | Data provider used for the last run: *Local ML* or *Solcast* |
| `Recent Quality` | Aggregate quality rating over the selected window: *Good*, *Acceptable*, or *Poor* |

#### Charts

| Chart | Description |
| --- | --- |
| Compare | Overlays day-ahead forecast (line) against actual generation (bars) with a shaded confidence band |
| WAPE | Daily Weighted Absolute Percentage Error bar chart; bar colour reflects quality tier |

#### History Table Columns

| Column | Description |
| --- | --- |
| `Date` | Target date of the forecast |
| `Provider` | Data provider used (*Local ML* or *Solcast*) |
| `Variant` | Forecast variant tag (e.g. *day_ahead*) |
| `WAPE %` | Weighted Absolute Percentage Error for that day |
| `Forecast MWh` | Forecasted daily energy total |
| `Actual MWh` | Observed actual energy total |
| `Freshness` | Solcast input freshness classification |
| `Quality` | Overall quality tier for that forecast run |
| `In-Memory` | Whether the forecast is held in the in-memory error-correction pool |

#### Controls

| Control | Function |
| --- | --- |
| Day-range selector | Sets the look-back window: 7, 14, 30, 60, 90, or 180 days |
| Refresh | Reloads all panel data from the server |

### ML Backend — LightGBM

The forecast engine uses **LightGBM** as its primary ML backend when installed (enabled by default from v2.4.40). If LightGBM is not installed the engine falls back automatically to sklearn's Gradient Boosting Regressor — no configuration change is required.

#### Installation

```
pip install lightgbm
```

Install into the Python environment used by the Forecast Service. On Windows the Visual C++ Redistributable (usually already present) is also required by the LightGBM DLL.

#### Requirements

| Requirement | Details |
| --- | --- |
| Python | 3.8 or later |
| LightGBM package | 3.x or later (`pip install lightgbm`) |
| Visual C++ Redistributable | Windows only — usually already present |
| CPU / RAM | Standard workstation hardware; no GPU required |
| Disk | ~50 MB for package and DLLs |

#### Verifying the Active Backend

- Check the **ML Training** health chip in the Forecast Performance Monitor after the next training run.
- The Forecast Service log prints `[LightGBM]` entries during model fit when LightGBM is active.
- To force the sklearn fallback (e.g. for debugging), set `FORECAST_USE_LIGHTGBM=0` before starting the Forecast Service.
- PyInstaller builds bundle LightGBM automatically if it is installed on the build machine; if not, the packaged EXE uses the sklearn fallback at runtime.

### Solcast Tri-Band Integration

When Solcast Toolkit data is available, the forecast engine automatically uses all three confidence levels — the standard forecast value plus Solcast's P10 (low confidence) and P90 (high confidence) intervals — as additional ML features. This provides the model with explicit weather uncertainty information, which is especially valuable on partly cloudy or changeable-weather days.

The tri-band integration is fully transparent to the operator. No configuration or action is required — the model automatically detects and incorporates tri-band data when it is available from your Solcast Toolkit feed. Historical forecasts generated without tri-band data continue to work normally, and the model gracefully switches to using all three bands as new data arrives.

This enhancement improves forecast accuracy across uncertain weather regimes by helping the model learn how weather unpredictability affects generation variance and timing.

---

## 6.4 Alarms Page

The `Alarms` page is the formal alarm review and acknowledgement workspace.

### Controls

| Control | Function |
| --- | --- |
| `Inverter` | Filter by specific inverter or all inverters |
| `Date` | Select review date |
| `Load Records` | Query alarms for the selected date |
| `Acknowledge All` | Acknowledge active alarms in the current scope |

### Alarm Table Columns

| Column | Meaning |
| --- | --- |
| `Alarm Time` | Timestamp of the event |
| `Inverter` | Inverter identifier |
| `Node` | Node identifier |
| `Alarm Code` | Code in operational hexadecimal form |
| `Severity` | Severity classification such as warning, fault, or critical |
| `Description` | Human-readable alarm description |
| `Cleared` | Clear time if the event has ended |
| `Duration` | Active or total duration |
| `Status` | Active or closed state |
| `Ack.` | Acknowledgement state |

Use this page for:

- shift alarm review
- confirmation that alarms were acknowledged
- incident reporting and maintenance coordination

---

## 6.5 Energy Page

The `Energy` page focuses on interval production records.

### Controls

| Control | Function |
| --- | --- |
| `Inverter` | Filter by inverter or all |
| `Date` | Select day to review |
| `Resolution` | Current implementation uses `5-Minute` resolution |
| `Load Records` | Loads interval energy data |

### Energy KPI Tiles

| Tile | Meaning |
| --- | --- |
| `Date Total` | Total daily energy |
| `Average per Interval` | Mean energy per recorded interval |
| `Peak Interval` | Highest recorded interval value |
| `Reporting Inverters` | Count of inverters with records |
| `Latest Interval End` | End time of the latest interval shown |

Operational note:

- when **today's date** is selected, all KPI tiles update automatically on each server push alongside the header `TODAY MWh` — no manual reload is needed
- for past dates, records are loaded on demand by pressing `Load Records`

### Energy Table Columns

| Column | Meaning |
| --- | --- |
| `Date` | Calendar date |
| `Interval End` | End of the recorded interval |
| `Inverter` | Inverter identifier |
| `Interval Energy (MWh)` | Energy produced during that interval |

Use this page for detailed production verification and interval-level validation.

---

## 6.6 Audit Page

The `Audit` page records operator command activity.

### Purpose

- review who performed a command
- confirm whether the command succeeded
- filter by operator, inverter, node, scope, result, or IP

### Main Controls

| Control | Function |
| --- | --- |
| `Inverter` | Top-level inverter filter |
| `Date` | Day filter |
| `Load Records` | Loads the audit data |
| `Clear Filters` | Clears the filter row |

### Audit Columns

| Column | Meaning |
| --- | --- |
| `Date/Time` | Command timestamp |
| `Operator` | Operator name recorded at execution |
| `Inverter` | Affected inverter |
| `Node` | Affected node or aggregated scope (`ALL` if the command targeted all nodes) |
| `Action` | `START` or `STOP` |
| `Scope` | `SINGLE`, `INVERTER`, `SELECTED`, `ALL`, or `PLANT-CAP` |
| `Result` | `OK` or `ERROR` |
| `IP` | Source workstation or inverter IP address |
| `Reason` | Controller decision reason for automatic actions (`PLANT-CAP` scope); blank for manual commands |

### Plant-Cap Scope Indicator

Audit entries generated by the Plant Output Cap controller display a `PLANT-CAP` badge in the Scope column with a blue highlight on the row. The `Reason` column shows the controller's decision reason (e.g. "Keeps projected plant output above the lower limit."), making it straightforward to distinguish automatic cap actions from manual operator commands.

### Filter Row

The filter row allows targeted review by:

- timestamp text
- operator name
- inverter
- node
- action
- scope (including `PLANT-CAP` for cap controller actions)
- result
- IP address

This page is the primary accountability record for command execution.

---

## 6.7 Report Page

The `Report` page provides the daily inverter-by-inverter performance summary.

### Controls

| Control | Function |
| --- | --- |
| `Date` | Selects the report day |
| `Load Report` | Loads the calculated daily report |
| `Format` | Selects `Excel (.xlsx)` or `CSV` for export |
| `Export Report` | Exports the current report |

### Report Columns

| Column | Meaning |
| --- | --- |
| `Inverter` | Inverter identifier |
| `Energy (MWh)` | Daily energy total |
| `Peak Pac (kW)` | Highest AC active power for the day |
| `Avg Pac (kW)` | Average AC active power |
| `Uptime (h)` | Operating uptime for the day |
| `Alarms` | Alarm count |
| `Availability (%)` | Availability indicator |
| `Performance (%)` | Performance indicator |

### Filter Row

The filter row supports:

- inverter-specific selection
- text filters for energy, peak, average, uptime, availability, and performance
- alarm-state filter such as `With Alarms` or `No Alarms`

Use this page for formal daily reporting, operational review, and management handoff.

---

## 6.8 Export Page

The `Export` page provides dedicated export packages for common operational records.

### Export Packages

| Package | Inputs | Output Use |
| --- | --- | --- |
| `Alarm History Export` | inverter, date, minimum alarm duration, format | Formal alarm records |
| `Energy Summary Export` | inverter, date, format | Production summary and performance review |
| `Day-Ahead Comparison Export` | date, resolution, format | Forecast-versus-actual comparison |
| `Operational Data Export` | inverter, date, interval, format | Detailed engineering or troubleshooting data |
| `Operator Audit Export` | inverter, date, format | Command accountability records |
| `Daily Performance Report` | from date, to date, format | Shift, management, or archival reporting |

### Common Export Behavior

- exports are written to the configured export folder
- most export cards support `Cancel` while running
- result text appears at the bottom of each export card
- format choices are typically `Excel (.xlsx)` and `CSV`
- XLSX exports now apply fitted column widths, colored headers, bordered cells, and highlighted summary or total rows for easier review in Excel

---

## 6.9 Settings Page

The `Settings` page is the administrative center. It is organized as a section-based review workflow.

### Global Settings Actions

| Action | Function |
| --- | --- |
| `Save Settings` | Saves the active configuration |
| `Export Settings` | Exports a configuration file |
| `Import Settings` | Imports a saved configuration file |
| `Export Folder...` | Selects the export destination path |
| `Open Folder` | Opens the current export path |
| `IP Configuration` | Opens the network configuration window |
| `Restore Defaults` | Resets settings and disconnects cloud providers |

### 6.9.1 Plant Configuration

| Field | Use |
| --- | --- |
| `Plant Name` | Display and document naming |
| `Operator Name` | Recorded operator identity |
| `Inverter Count` | Total inverter count used by the dashboard |
| `Nodes/Inverter` | Reporting nodes per inverter |
| `Plant Latitude` | Weather and forecast context |
| `Plant Longitude` | Weather and forecast context |

### 6.9.2 Data & Polling

#### Service Endpoints

| Field | Use |
| --- | --- |
| `Data API URL` | Read-side service endpoint |
| `Write API URL` | Command/write service endpoint |

#### Storage

| Field | Use |
| --- | --- |
| `Export Folder` | Destination for generated files |
| `Retention Window (days)` | Number of days kept in the main hot database before archival logic applies |

#### Polling Timing

| Field | Use |
| --- | --- |
| `Modbus Timeout (s)` | Max wait time for read response |
| `Reconnect Delay (s)` | Delay before read retry after reconnect |
| `Read Spacing (s)` | Pause between register groups to reduce device pressure |

#### Plant Output Cap Defaults

These settings define the default values loaded into the **Plant Cap** page. The settings view also shows a small planner summary for selection mode, band gap, controllable inverter count, and the smallest available controller step.

| Field | Use |
| --- | --- |
| `Upper Limit (MW)` | Default upper plant MW cap threshold |
| `Lower Limit (MW)` | Default lower plant MW threshold |
| `Sequence` | Default inverter selection mode |
| `Exempted Inverter Numbers` | Default comma-separated inverter exclusion list used by `Exemption` mode |
| `Cooldown (s)` | Default settling delay after each controller action |

### 6.9.3 Connectivity & Sync

This section defines whether the workstation is acting locally at the plant or as a remote viewer.

#### Mode & Remote Access

| Field | Use |
| --- | --- |
| `Operation Mode` | `Gateway` or `Remote` |
| `Remote Gateway URL` | URL of the authoritative gateway workstation |
| `Remote API Token` | Shared API token for remote access |
| `Tailscale Device Hint` | Optional identifier used when checking secure-network status |

#### Connectivity Actions

| Button | Function |
| --- | --- |
| `Test Remote Gateway` | Confirms the configured remote URL is reachable |
| `Check Tailscale` | Verifies Tailscale installation and connection state |
| `Refresh` | Refreshes replication and link-health information |
| `Refresh Standby DB` | Stages archive DB files first (when included) for historical consistency, then downloads a fresh gateway main DB snapshot for local use; if newer local standby data exists, the app blocks and offers explicit `Force Pull` |

#### Gateway Link and Standby Fields

| Field | Meaning |
| --- | --- |
| `Mode` | Current runtime mode |
| `Gateway URL` | Remote gateway target |
| `Gateway Link` | Link status to the gateway |
| `Tailscale` | Secure path status |
| `Gateway Live Link` | Current data-link activity state |
| `Last Successful Contact` | Last successful contact timestamp |
| `Last Standby Refresh` | Last background or manual standby operation |
| `Rows Received` | Received row counter for related operations |
| `Last Standby DB Pull` | Last full standby DB staging event |
| `Background Job` | Current standby or transfer job state |
| `Last Errors` | Most recent connectivity or transfer errors |
| `Standby DB Scope` | Current meaning of standby DB refresh |
| `Archive Scope` | Whether archive inclusion is optional or enabled |

#### Transfer Monitor

The transfer monitor reports:

- current RX and TX speeds
- transfer direction
- transfer phase
- transfer scope
- percent complete
- current bytes versus total bytes

#### Standby Refresh Safety Behavior

Operational rules for `Refresh Standby DB`:

- normal standby refresh is download-only; it does not push local standby data back to the gateway
- if the local standby copy contains newer replicated operational data than the gateway, the app stops with a `Force Pull` choice instead of overwriting silently
- this safety check happens before the heavy transfer starts, helping protect gateway responsiveness
- `Force Pull` should be used only when the gateway is the intended source of truth and overwriting newer local standby data is deliberate
- failed or cancelled standby refreshes discard staged replacement files automatically; partial failed downloads are not applied on restart

#### Runtime Health

This area reports application health indicators such as:

- CPU
- memory
- uptime
- live value key count
- polling cycles
- poll duration
- fetch errors
- rows persisted
- persist skipped
- connected clients

### 6.9.4 Forecast

The dedicated forecast settings content is presented in the `Forecast` page workspace. Refer to Section `6.3 Forecast Page`.

### 6.9.5 License

| Field or Action | Purpose |
| --- | --- |
| `Status` | Current license state |
| `Source` | Where the license was loaded from |
| `Expiry` | License expiry date |
| `Remaining Days` | Remaining term |
| `Upload Replacement` | Applies a new license file |
| `Refresh License` | Reloads license state |
| License audit table | Shows license-related events and messages |

### 6.9.6 App Updates

| Field or Action | Purpose |
| --- | --- |
| `Current Version` | Installed application version |
| `Channel` | Release/update channel |
| `Latest Version` | Most recent release available |
| `Status` | Current update state |
| `Check for Updates` | Queries the update channel |
| `Download Update` | Downloads the update package when available |
| `Restart & Install` | Restarts the app and installs the downloaded update |

Operational note:

- `Restart & Install` now uses an orderly shutdown path before the installer handoff.
- The app first asks the local dashboard server, inverter backend, and forecast background service to stop cleanly.
- Force termination is used only as a fallback if a background service does not exit within its bounded grace window.
- Do not power off the workstation or relaunch the app manually while the restart/install handoff is in progress.
- After restart, wait for the first local poll cycle before relying on fresh `TODAY MWh` or gateway-only forecast actions.

### 6.9.7 Cloud Backup & Restore

#### Provider Access

| Field or Action | Use |
| --- | --- |
| `Email` | Provider suggestion or reference only |
| `Backup Provider` | `Auto`, `OneDrive`, `Google Drive`, `S3-compatible`, or `Both` |
| `Authorize OneDrive` | Starts Microsoft provider authorization |
| `Authorize Google Drive` | Starts Google provider authorization |
| `Validate & Connect` | Validates the configured S3-compatible bucket and stores the credential pair locally |
| `Disconnect Provider` | Disconnects the current provider session |
| `Azure Client ID` | OneDrive authorization client ID |
| `Google Client ID` | Google authorization client ID |
| `Google Client Secret` | Stored locally after save; not shown again |
| `S3 Endpoint / Region / Bucket / Prefix` | Object-storage location and folder-style prefix |
| `S3 Access Key ID / Secret Access Key` | Stored locally after validation; not shown again |

#### Backup Policy

| Field | Use |
| --- | --- |
| `Enable scheduled cloud backup` | Enables scheduled backup execution |
| `Application data` | Include the main database plus forecast model bundles, forecast history context, weather cache, Solcast reliability artifacts, and forecast snapshots |
| `Configuration files` | Include configuration settings |
| `Logs (optional)` | Include log files when needed |
| `Schedule` | `Manual only`, `Daily at 3:00 AM`, or `Every 6 hours` |
| `Backup date tag` | Date tag used for package labeling |

#### Backup Actions

| Action | Function |
| --- | --- |
| `Save Backup Settings` | Saves cloud backup configuration |
| `Backup Now` | Creates and uploads a backup package immediately |
| `Refresh Cloud List` | Lists available cloud backups |
| `Refresh backup history` | Refreshes local backup activity and restore list |

#### Backup Activity and Restore

The backup activity table reports:

- date and time
- backup tag
- included scope
- backup size
- backup status
- cloud provider

Forecast data is packaged under the same backup when `Application data` is selected. This includes the active SQLite database and the forecast engine artifact directories stored under `ProgramData\\InverterDashboard`.

For `S3-compatible` storage, unchanged backup content is chunk-deduplicated and reused across later backups instead of being uploaded again.
- available actions

Restore behavior:

- restore creates a safety backup first
- restore overwrites the active database and configuration
- restore requires application restart to complete cleanly

---

## 6.10 Camera Viewer

The `Camera Viewer` is a live IP camera card displayed within the main inverter grid. It supports three streaming modes and includes an integrated go2rtc process manager for RTSP-to-browser streaming.

### Camera Card

The camera card is a draggable card that participates in the inverter grid layout alongside inverter cards. It displays:

- **Live video viewport** filling the card body
- **Top-left overlay**: Camera name label (e.g., `Tapo C110 - Live`)
- **Top-right overlay**: Blinking red dot indicator when the stream is active
- **Bottom controls bar**:
  - ⚙️ Settings — opens the Camera Settings modal
  - 🔇/🔊 Mute/unmute toggle
  - ⛶ Fullscreen toggle
- **Loading spinner** while buffering
- **Error overlay** with `Retry` button when the stream fails
- **Auto-reconnect** every 5 seconds on stream drop

### Stream Modes

| Mode | Backend | Description |
| --- | --- | --- |
| **HLS** | go2rtc | HTTP Live Streaming. Best compatibility, ~2-5 s delay. Default mode. |
| **WebRTC** | go2rtc | Ultra-low latency (<1 s). Requires STUN/TURN for NAT traversal. |
| **FFmpeg** | Server | Direct RTSP transcode via FFmpeg. MPEG1/TS over WebSocket. Requires FFmpeg installed on server. |

### Camera Settings Modal

Click the **⚙️ Settings** icon on the camera card to open the modal. The modal is a page-level dialog centered on the screen (not card-scoped).

#### Stream Mode Selection

Three visual mode cards at the top of the modal. Click a card to select that mode. The selected card is highlighted with an accent-colored border. Selecting a mode dynamically shows or hides the relevant input sections below.

#### go2rtc Connection Fields (HLS and WebRTC modes)

| Field | Default | Description |
| --- | --- | --- |
| `Tailscale / Server IP` | `100.93.11.9` | IP address where go2rtc is reachable (localhost or Tailscale VPN IP) |
| `API Port` | `1984` | go2rtc API port |
| `Stream Key` | `tapo_cam` | Stream name configured in `go2rtc.yaml` |

#### RTSP Connection Fields (FFmpeg mode)

| Field | Default | Description |
| --- | --- | --- |
| `Camera IP` | `192.168.4.211` | RTSP camera IP address |
| `RTSP Port` | `554` | RTSP port |
| `Stream Path` | `stream1` (High Quality) | `stream1` or `stream2` (Low Quality) |
| `Username` | `Adsicamera` | Camera login username |
| `Password` | *(empty)* | Camera login password (masked with show/hide toggle) |

A warning banner appears in FFmpeg mode: *Direct FFmpeg mode requires FFmpeg installed on the server.*

#### go2rtc Service Controls (HLS and WebRTC modes, gateway mode only)

This section is hidden when FFmpeg mode is selected or when operating in remote mode.

| Control | Description |
| --- | --- |
| **Status** | Current process state: `running`, `stopped`, `starting`, `error` |
| **PID** | Process ID when running |
| **Crashes** | Consecutive crash count (resets on manual start) |
| **Health** | Timestamp of last successful health check |
| **Auto-start on server boot** | When checked, go2rtc starts automatically when the Express server boots in gateway mode |
| **Start** | Starts the go2rtc process |
| **Stop** | Stops the go2rtc process gracefully |

The service status grid polls `GET /api/streaming/go2rtc-status` every 5 seconds while the modal is open. Polling stops when the modal is closed.

#### Modal Actions

| Button | Function |
| --- | --- |
| `Reset Defaults` | Restores all fields to factory defaults |
| `Apply & Connect` | Saves settings to localStorage, persists auto-start to server, closes modal, and reconnects stream |

### Settings Persistence

| Setting | Storage | Scope |
| --- | --- | --- |
| Stream mode, IPs, ports, credentials | `localStorage` (per key) | Browser/client |
| go2rtc auto-start | Server setting (`go2rtcAutoStart`) | Server-wide |

### go2rtc Service Behavior

| Behavior | Detail |
| --- | --- |
| **Gateway-mode only** | Start is blocked with HTTP 403 in remote mode |
| **Localhost-only binding** | API on `127.0.0.1:1984`, WebRTC on `127.0.0.1:8555` |
| **Auto-restart on crash** | Up to 3 consecutive crashes, then stops with `error` status |
| **Non-blocking** | go2rtc failure never blocks server startup or other dashboard features |
| **Graceful shutdown** | Stopped automatically during app shutdown, update install, or server stop |
| **Config override** | Place a `go2rtc.yaml` in `C:\ProgramData\InverterDashboard\go2rtc\` to override bundled defaults |

### Troubleshooting

| Problem | Likely Cause | Action |
| --- | --- | --- |
| Stream fails to load | go2rtc not running | Open camera settings, check Status, click Start |
| go2rtc won't start | Port 1984 or 8555 already in use | Stop conflicting process or change ports in `go2rtc.yaml` |
| WebRTC shows no video | NAT or firewall blocking UDP | Ensure STUN server is reachable, configure TURN if behind strict NAT |
| FFmpeg mode shows no video | FFmpeg not installed | Install FFmpeg and add to system PATH |
| Service controls hidden | Remote operation mode | Switch to Gateway mode in Settings > Connectivity |
| Status shows `error` | 3+ consecutive crashes | Check RTSP source and `go2rtc.yaml` config, then manually restart |

---

## 7. Auxiliary Windows

## 7.1 IP Configuration

The `IP Configuration` window manages per-inverter network and operational settings. Open it from **Settings > IP Configuration** or `Ctrl+I`. Access requires an auth gate key (`adsiM` or `adsiMM`, where M is the current minute). The session lasts 1 hour.

### Configuration Table

Each of the 27 inverters has one row with the following columns:

| Column | Description |
|--------|-------------|
| **Inverter** | Inverter number and device label (INV-01 -- INV-27). Click the gear icon to open the inverter web page. |
| **IP Address** | IPv4 address of the inverter on the local network. |
| **Polling Interval (s)** | How often the gateway polls this inverter, in seconds (min 0.01, default 0.05). |
| **Enabled Units** | Which nodes (1--4) are active. Use **All** to toggle all four. Empty selection disables the inverter. |
| **Loss %** | Estimated MW transmission loss from this inverter to the substation (0--100%). Default is `2.5%` per inverter unless overridden. Used exclusively by the forecast engine for substation-level accuracy; does *not* affect live dashboard readings, energy totals, or exports. |
| **Save** | Saves the individual row. Use **Save All Changes** at the bottom to save every row at once. |

IP Config is also the authority for live inverter identity. The dashboard binds telemetry to an inverter by the configured IP address and enabled node list, not by any assumed IP numbering pattern. Cards, selectors, and alarm labels may show the configured IP alongside `INV-xx` so operators can verify the assignment directly.

### Loss % and Forecasting

Loss % is forecast-only. The dashboard, logged telemetry, daily reports, and exports continue using raw measured values. The day-ahead forecast engine adjusts historical 5-minute energy data per inverter before training so the ML model and Solcast reliability calibration learn substation-level output patterns rather than raw inverter output. Solcast forecasts themselves are treated as already substation-based and are not reduced again by `Loss %`. Raw Solcast power arrives in `MW` and is normalized to `kWh` per 5-minute slot for forecast scoring, and the forecast artifact keeps daily weather-bucket resolution history on that same loss-adjusted actual basis.

Example: if INV-15 has a 2.5% loss (degraded cable) and INV-26 has 1.0% (far from substation), the forecast engine reduces their historical energy contributions by those percentages when building training data, computing error corrections, and scoring forecast quality.

### Additional Controls

- **Check Status** -- scans all configured IPs for reachability and shows an online count.
- **Open Topology** -- opens the visual plant topology map.
- **Theme toggle** -- switches between light and dark mode for this window.

### Operational Notes

- This function is intended for authorized personnel only.
- In `Remote` mode, the dashboard blocks access to gateway-only configuration actions.

## 7.2 Topology

The `Topology` window provides a plant-wide visual status overview.

Typical use:

- review fleet structure visually
- identify online, offline, or unknown device states
- move quickly between a status map and IP configuration

Operational note:

- topology is treated as a gateway-side operational tool
- access may be blocked in `Remote` mode

---

## 8. Standard Operating Workflows

## 8.1 Daily Startup Check

1. Launch the application and complete sign-in if required.
2. Wait for the startup loading screen to finish before evaluating live values.
3. If operating in `Remote` mode and the gateway is unreachable, the loading screen will present a **Connection Mode** picker instead of a generic error. Choose **Gateway Mode** to switch to local Modbus polling, or choose **Remote Mode** to retry the gateway connection.
4. Confirm the license notice area is clear.
5. Check the header connection dot and clock.
6. Review `TOTAL PAC` and `TODAY MWh`.
7. Open the `Inverters` page and confirm online, alarmed, and offline counts.
8. If operating remotely, confirm `Connectivity & Sync` status in Settings.

## 8.2 Live Control Workflow

1. Open the `Inverters` page.
2. Select the target inverter or node.
3. Review current alarm state and last-seen freshness.
4. Send the required `START` or `STOP` action.
5. Confirm the result through status updates, toast feedback, and audit history.

## 8.3 Bulk Inverter Workflow

1. Enter inverter numbers or ranges in the bulk command field.
2. Normalize the entry if needed by using `All Inverters` or reviewing the accepted range.
3. Click `START SELECTED` or `STOP SELECTED`.
4. Enter the required authorization key when prompted.
5. Confirm results from toast messages and the `Audit` page.

## 8.4 Plant Output Cap Workflow

1. Open the **Plant Cap** page from the navigation bar.
2. Enter the required `Upper Limit (MW)` and `Lower Limit (MW)`.
3. Choose the inverter `Sequence` and add any `Exempted Inverter Numbers` if needed.
4. Review the client warnings, especially narrow-band warnings.
5. Click `Preview Plan`.
6. Review the proposed inverter step, projected plant MW, and reason text.
7. Click `Enable Cap` and complete the required authorization.
8. Monitor `Status`, `Reason`, `Last Action`, `Cooldown`, `Curtailed`, and planner warnings while the session is active.
9. Cap-stopped inverter cards show a blue `CAP STOPPED` badge with the stoppage time for at-a-glance identification in the inverter grid.
10. Review the `Controlled Inverters` table inside the cap panel for duration, removed Pac, rated kW, and dependable kW per stopped inverter.
11. Use `Disable Monitoring` to stop automation without restarting controller-owned inverters, or use `Release Controlled Inverters` to restart them sequentially and end the session.
12. Check the `Audit` page for a full record of cap controller actions (scope: `PLANT-CAP`) with decision reasons.

## 8.5 Scheduled Auto-Cap Workflow

1. Open the **Plant Cap** page.
2. Click **+ Add Schedule** in the toolbar.
3. Fill in Name, Start Time, Stop Time, and optional MW/Sequence/Cooldown overrides.
4. Enter the Auth Key and click **Save**.
5. Monitor schedule chips for state transitions (Waiting → Active → Completed).
6. Edit or delete schedules via the pencil icon on each chip.

Important:

- plant-cap control runs as whole-inverter sequential control in current builds
- very narrow MW bands may not be reachable cleanly with whole-inverter steps
- in `Remote` mode, plant-cap actions are proxied to the gateway workstation
- if preview or enable fails with `Cannot POST /api/plant-cap/...`, update or restart the gateway app and verify the configured `Remote Gateway URL`

## 8.5 Alarm Review Workflow

1. Open the `Alarms` page.
2. Filter by inverter and date if needed.
3. Load records.
4. Review severity, duration, status, and acknowledgement state.
5. Acknowledge alarms when permitted.
6. Use the alarm bell for quick active-alarm review.

## 8.6 Daily Performance Review

1. Open `Analytics` for interval review and day-ahead comparison.
2. Open `Energy` for interval production detail.
3. Open `Report` for the formal daily inverter summary.
4. Export the required package from `Report` or `Export`.

## 8.7 Remote Standby Refresh Workflow

1. Confirm the workstation is in `Remote` mode.
2. Open `Settings -> Connectivity & Sync`.
3. Review gateway link and transfer monitor status.
4. Decide whether archive DB files are required.
5. Run `Refresh Standby DB`.
6. Allow the preflight phase to finish before expecting the heavier snapshot transfer to begin.
7. If the app reports that local standby data is newer than the gateway, decide whether to cancel or use explicit `Force Pull`.
8. Wait for completion and confirm success.
9. Restart the application when you need the refreshed standby DB to become the active local database.
10. After restart, allow the startup loading screen and the first local poll cycle to finish before relying on live totals.

Important:

- remote live streaming pauses temporarily during manual standby refresh
- archive inclusion extends transfer time
- remote mode itself does not keep the local database current
- the refreshed standby DB is the safe path before returning a remote workstation to `Gateway` mode for local history use
- if the refresh is blocked before transfer begins, the gateway should not see the heavier standby-download load
- use `Force Pull` only when you intentionally want the gateway copy to replace newer local standby data

## 8.8 Cloud Backup Workflow

1. Configure provider access.
2. Save backup settings.
3. Select backup scope.
4. Run `Backup Now` or rely on the configured schedule.
5. Review history and cloud file listings.

## 8.9 Cloud Restore Workflow

1. Open `Settings -> Cloud Backup & Restore`.
2. Refresh backup history or cloud list.
3. Choose the correct restore point.
4. Confirm the restore action.
5. Allow the app to create a safety backup.
6. Restart when prompted to apply the restored state.

## 8.10 Camera Setup Workflow

1. Ensure the workstation is in `Gateway` mode (camera streaming is gateway-only).
2. Click the **⚙️ gear icon** on the camera card to open Camera Settings.
3. Select the desired stream mode (HLS, WebRTC, or FFmpeg).
4. For HLS or WebRTC:
   a. Enter the go2rtc server IP (localhost or Tailscale IP) and API port.
   b. Enter the stream key matching `go2rtc.yaml` (default: `tapo_cam`).
   c. In the go2rtc Service section, click **Start** to launch the go2rtc process.
   d. Optionally check **Auto-start on server boot** for automatic startup.
5. For FFmpeg:
   a. Enter the camera IP, RTSP port, stream path, username, and password.
   b. Ensure FFmpeg is installed on the server and available on PATH.
6. Click **Apply & Connect**.
7. Verify the live feed appears in the camera card.
8. If the stream fails, check the go2rtc service status, verify network connectivity, and retry.

---

## 9. Operational Notes and Best Practices

- Use `Gateway` mode on the plant-connected workstation.
- Use `Remote` mode only from approved monitored workstations.
- Do not treat `Remote` mode live viewing as proof that the local standby DB is current.
- Use `Refresh Standby DB` before switching a remote workstation back to `Gateway` mode if fresh local history is required.
- Include archive DB files only when historical records are needed locally.
- Protect exported settings files, backup files, and exported operational data as controlled records.
- Do not expose authorization keys, API tokens, client secrets, or toolkit credentials in shared documents.
- Use the `Audit` page after control actions when traceability matters.
- Use `Cloud Backup` and export functions as complementary controls, not substitutes for one another.

---

## 10. Troubleshooting Reference

| Symptom | Likely Meaning | Recommended Action |
| --- | --- | --- |
| Connection dot shows disconnected | Live link is unavailable | Check mode, gateway URL, token, and Tailscale status |
| `Stale` status appears | Last retained snapshot is being shown | Check live link health and recent gateway contact |
| `Refresh Standby DB` completes but data is unchanged locally | Staged data is not applied until restart | Restart the application to activate the new database |
| `Refresh Standby DB` stops with a newer-local warning or `Force Pull` prompt | The local standby copy has newer replicated data than the gateway | Review which machine is authoritative. Cancel to preserve local standby data, or use `Force Pull` only if overwriting local standby data is intentional |
| `TODAY MWh` looks older immediately after returning to `Gateway` mode | Local polling has not caught up yet or standby data was not refreshed before restart | Run `Refresh Standby DB`, restart, and wait for the first local poll cycle |
| Live totals or forecast status look old immediately after `Restart & Install` | Background services are still completing clean shutdown/startup handoff or the first local poll cycle has not finished yet | Wait for the app to reopen fully, confirm gateway mode/runtime health, and allow the first local poll cycle to complete before judging data freshness |
| Startup loading screen shows a **Connection Mode** picker | The workstation is in `Remote` mode and the remote gateway did not respond within the connection timeout | Choose **Gateway Mode** to switch to local Modbus polling, or choose **Remote Mode** to retry the gateway connection. If the gateway is expected to be online, verify the `Remote Gateway URL`, API token, and network connectivity (e.g. Tailscale) before retrying |
| Day-ahead generation is unavailable | Workstation is in `Remote` mode | Run generation from the gateway workstation |
| Plant-cap preview or control fails with `Cannot POST /api/plant-cap/...` | The request reached a server that does not expose the plant-cap routes, usually an older gateway build or a wrong remote gateway target | Restart or update the gateway app, then verify `Remote Gateway URL` and token settings |
| Plant-cap band warning says the limits are too close | Whole-inverter step size is larger than the configured deadband or close to it | Increase the gap between `Lower Limit` and `Upper Limit`, or review exempted inverters and node counts |
| Whole-inverter `Start` / `Stop` still feels slow on one workstation | The workstation or gateway is still running an older build without batched inverter writes, or the backend link itself is slow | Update both gateway and remote builds to the same release first, then review Python service health and network latency |
| Cloud restore is unavailable or incomplete | Provider or backup state is not ready | Refresh cloud list and verify provider authorization |
| IP Configuration or Topology cannot be opened | Current mode is `Remote` or access is restricted | Use the gateway workstation |
| Alarm sound is silent | Sound is muted or system audio is unavailable | Re-enable alarm sound and check workstation audio |
| Export fails | Path, date, format, or dataset issue | Verify export folder, input filters, and current mode |

---

## 11. Keyboard Shortcuts and Interface Tips

| Shortcut | Function |
| --- | --- |
| `Ctrl+T` | Open the Topology window |
| `Ctrl+I` | Open the IP Configuration window |
| `Ctrl+=` | Zoom in where supported |
| `Ctrl+-` | Zoom out where supported |
| `Ctrl+0` | Reset zoom where supported |
| `Ctrl+L` | Theme toggle in auxiliary windows where implemented |

Additional tips:

- use the alarm bell for active alarm review without changing pages
- use the operator message bubble for shift notes and remote coordination
- use `Open Folder` in Settings to verify export output quickly
- use `Check for Updates` and `Refresh License` during planned maintenance windows

---

## 12. Security and Administrative Caution

This dashboard includes controlled operational actions and credential-bearing configuration fields. Only authorized personnel should:

- change operation mode
- edit endpoint URLs or polling timing
- upload replacement licenses
- connect or disconnect cloud providers
- restore from backup
- manage Solcast credentials
- use bulk inverter control authorization
- modify IP configuration and topology-related network settings

This manual intentionally does not publish authorization-key generation rules or private credential formats.

---

## 13. Quick Reference Summary

| Need | Best Page or Section |
| --- | --- |
| Live plant status | `Inverters` |
| Interval production analysis | `Analytics` and `Energy` |
| Day-ahead comparison | `Analytics` and `Export` |
| Forecast source setup | `Forecast` |
| Alarm review and acknowledgement | `Alarms` |
| Operator action traceability | `Audit` |
| Formal daily summary | `Report` |
| File generation | `Export` |
| Mode, link, standby DB, runtime health | `Settings -> Connectivity & Sync` |
| License and update management | `Settings -> License` and `Settings -> App Updates` |
| Backup and restore | `Settings -> Cloud Backup & Restore` |
| Network configuration | `IP Configuration` |
| Visual plant map | `Topology` |

---

## 14. Revision Note

This manual reflects the current ADSI Dashboard implementation present in this repository as of **March 14, 2026**. If the dashboard UI, operating modes, export packages, or administrative workflows change, this document should be updated together with the application.
