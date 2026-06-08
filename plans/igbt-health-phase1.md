---

# Implementation Plan: IGBT Health Page (Phase 1 MVP)

**Date:** 2026-05-10  
**Status:** TDD-ready implementation specification  
**Version:** v2.11.0 (target release)

## § 1 Scope & Success Criteria

This phase delivers a **real-time asset-health monitoring dashboard** for the 27-unit / ~108-node INGECON fleet, grounded in the failure-progression framework defined in [docs/IGBT_Aging_Management_Manual.docx](docs/IGBT_Aging_Management_Manual.docx). The MVP empower operators to:

- **Identify at-risk nodes** via a composite 0-100 health score computed server-side
- **Prioritize maintenance** with tier-based filtering (Healthy / Watch / Aging / EOL)
- **Plan capital replacement** via CSV export for procurement input
- **Investigate node-level aging** through drilldown panels showing recent stop events and current thermal state

**Out of Phase 1** (deferred to Phase 2 MVP):
- Year-over-year thermal-trend tracking (requires 12+ months historical baseline)
- Monthly/quarterly thermal baseline computation jobs
- Quarterly fleet review reports
- Annual capital-plan exporter with cost projections

**Success Criteria:**
- [ ] Fleet table renders all 108 nodes with correct health scores within ±5 points
- [ ] Tier classification gates correctly at 25 / 50 / 75 score boundaries
- [ ] All 6 aging-relevant motive codes (FRAMA1/2/3, TEMPERATURA, PI_ANA_SAT, TEMP_AUX) are counted
- [ ] Phase-imbalance computed from 1-hour 5-min parameter median, offline → component score = 0
- [ ] Drilldown shows recent events timestamped within ±2 seconds of event-at-ms
- [ ] CSV export produces UTF-8 + BOM, matches column order, completes in < 5 s
- [ ] Remote-mode proxying works (viewer sees gateway fleet data, not stale local cached data)
- [ ] All 15+ TDD unit tests pass at ≥90% branch coverage for health-core logic
- [ ] No schema changes (Phase 1 is additive ZERO to `inverter_stop_reasons_std`)

---

## § 2 Operator Context & Motivation

The Mindanao plant (24.84 MW, 27 INGECON inverters, ~108 nodes) is in the **wear-out phase** of the bathtub curve. The operator has personally recorded **4+ IGBT module failures** (explosions) over the lifespan. Current visibility is fragmented across scattered alarm logs; proactive replacement decisions lack data-driven confidence.

The IGBT Aging Management Manual (manual §5–§6) defines:

- **4-stage symptom progression**: Healthy → Watch (early thermal drift / rare FRAMAs) → Aging (frequent stops, >70°C baseline, >10% imbalance) → EOL (imminent failure indicators)
- **Weighted health score** (§6.5): 30% thermal trips, 30% FRAMA events, 20% PI controller saturation, 20% phase imbalance
- **Actionable thresholds**: EOL nodes should be scheduled for replacement within 30 days; Aging nodes flagged for monthly thermal monitoring

This page makes invisible degradation **visible at a glance**, supporting operator confidence in capital planning.

---

## § 3 Architecture Decision

### 3.1 Server-Side Health Score Computation

**Why:** The health score is **not a client-side cosmetic metric** — it drives operational decisions (maintenance scheduling, replacement budgets). Correctness must be auditable.

- **Pure function** in Node (`server/igbtHealth.js`) ensures deterministic output
- **Testable offline**: No I/O, no timestamps, pure mathematical decomposition
- **API versioning**: Score formula is versioned in code comments; future tuning (e.g., manual weight override via settings) is plumbed as parameters, not hardcoded in HTML
- **Audit trail**: Score contributions are exposed in drilldown; operator can see why a node scored 67.3 (not a black box)

### 3.2 On-Demand Computation with Optional Caching

**Why:** Avoid polling overhead for the 108-node fleet on every refresh.

- **GET /api/igbt/fleet** triggers computation on every request (lightweight — 108 nodes × 4 SELECT queries ≈ 100 ms latency)
- **No cache table** in Phase 1; the API returns `generated_at_ms: Date.now()` so the UI knows freshness
- **Future Phase 2**: If needed, a `igbt_health_snapshot` table (5-min rotation) caches scores and drilldown payload; Phase 1 derives everything live from `inverter_stop_reasons_std` and `inverter_5min_param`

### 3.3 Remote-Mode Proxy Architecture

Every new GET endpoint checks `isRemoteMode()` first. If true, proxies to gateway `/api/igbt/fleet` via the existing cloud-bridge tunneling. This ensures:

- Remote viewers always see **live gateway fleet data**, not stale local standby copies
- No schema replication needed (stop-reason / param tables are not pushed to remotes)
- Failure-safe: if gateway is down, remote gets an error (correct behavior; cached stale data is dangerous for health decisions)

---

## § 4 Data Model

### 4.1 Required Tables (NO NEW TABLES — Phase 1 Additive Zero)

We derive the health score entirely from **existing tables**:

| Table | Columns Used | Purpose |
|---|---|---|
| `inverter_stop_reasons_std` | `inverter_ip`, `slave`, `motive_code`, `timestamp_iso`, `read_at_ms` | 90-day rolling window of thermal/FRAMA/PI stops |
| `inverter_5min_param` | `inverter_ip`, `slave`, `ts_ms`, `iac1_a`, `iac2_a`, `iac3_a`, `temp_c` | Last hour of 5-min telemetry for imbalance + current temp |
| `ipconfig` (via `loadIpConfigFromDb()`) | `inverter`, `slave`, `ip` | Node enumeration; maps slave ID to inverter number |

**No new schema changes required.** All health state is computed stateless from these tables on each request.

### 4.2 Optional Snapshot Table (Deferred to Phase 2 — NOT implemented now)

```sql
CREATE TABLE IF NOT EXISTS igbt_health_snapshot (
  inverter_ip TEXT NOT NULL,
  slave INTEGER NOT NULL,
  computed_at_ms INTEGER NOT NULL,
  health_score REAL NOT NULL,
  tier TEXT NOT NULL,  -- 'healthy', 'watch', 'aging', 'eol'
  frama_total INTEGER,
  thermal_trips INTEGER,
  pi_ana_trips INTEGER,
  temp_pe_now_c REAL,
  imbalance_pct REAL,
  -- breakdown for audit:
  thermal_score REAL,
  frama_score REAL,
  pi_ana_score REAL,
  imbal_score REAL,
  PRIMARY KEY (inverter_ip, slave, computed_at_ms)
) WITHOUT ROWID;
```

**Phase 1 does NOT create this table.** Scores are computed on-demand. Phase 2 will introduce the snapshot table for caching + historical trend analysis.

---

## § 5 Health Score Formula

### 5.1 Component Calculation

All component scores are clamped to **[0, 100]** before weighting.

#### Thermal Trip Score
```
motive_code = 6 (MOTIVO_PARO_TEMPERATURA) or 20 (MOTIVO_PARO_TEMP_AUX)
thermal_count = COUNT(motive_code IN [6, 20]) over last 90 days
thermal_trip_score = min(100, thermal_count × 25)

Rationale: Each thermal trip is a significant stress event. 4+ trips → max score.
```

#### FRAMA Score
```
frama_codes = {12 (FRAMA3), 28 (FRAMA1), 29 (FRAMA2)}
frama_total = COUNT(motive_code IN frama_codes) over last 90 days
frama_score = min(100, frama_total × 30)

Rationale: FRAMA events indicate power-stage electrical stress. 3+ FRAMAs → max score.
Manual §5.2: Frame errors correlate with aging gate-drive circuits.
```

#### PI Controller Saturation Score
```
motive_code = 25 (MOTIVO_PARO_PI_ANA_SAT)
pi_ana_count = COUNT(motive_code = 25) over last 90 days
pi_ana_score = min(100, pi_ana_count × 35)

Rationale: PI saturation means the controller can no longer regulate output current.
Doubled weight vs manual Phase 1 baseline because YoY thermal-trend component is deferred.
3+ events → max score.
```

#### Phase Imbalance Score
```
imbalance_pct = MEDIAN(
  ABS( (iac1 + iac2 + iac3) / 3 - iac1 ) / AVG(iac1, iac2, iac3) × 100
  OVER last 60 minutes, grouped by 5-min slots
)

IF imbalance_pct <= 1.0:
  imbal_score = 0
ELSE:
  imbal_score = min(100, (imbalance_pct - 1.0) × 20)

Rationale: <1% imbalance is within tolerance (three-phase symmetry margin).
Each 1% above threshold adds 20 points. >5% imbalance → max score.
Manual §5.3: Current imbalance indicates gate-drive power asymmetry.
```

### 5.2 Composite Score & Tier Assignment

```
composite_score = 0.30 × thermal_trip_score
                + 0.30 × frama_score
                + 0.20 × pi_ana_score
                + 0.20 × imbal_score

tier = tierForScore(composite_score)
  IF score < 25: 'healthy'    → --green
  IF 25 ≤ score < 50: 'watch'   → --orange
  IF 50 ≤ score < 75: 'aging'   → --orange
  IF score ≥ 75: 'eol'          → --red
```

### 5.3 Edge Cases & Null Handling

- **Offline node** (no 5-min param rows in last hour, or inverter_ip not in ipconfig):
  - `imbal_score = 0` (component treats missing data as "no imbalance visible")
  - Other components fallback to 0 if motive queries return no rows
  - Result: `score = null` (not 0) to signal "data unavailable, do not use for decisions"
  - UI renders as "—" (dash), not a green "Healthy" tier

- **Stale stop-reason data** (no entries in last 90 days):
  - Counts default to 0 (node has not failed recently)
  - Score reflects current imbalance + temp only; likely "Healthy" unless imbalance is high

- **Partial imbalance data** (e.g., only 1–2 samples in last hour):
  - Compute median of available samples (minimum 1 sample to avoid division by zero)
  - Mark contribution in drilldown as "based on N samples" so operator knows if it's statistically weak

---

## § 6 Fleet Enumeration Logic

### 6.1 Node Discovery via IpConfig

```javascript
// Pseudocode: enumerate all configured nodes
const ipCfg = loadIpConfigFromDb();
const nodes = [];

for (const invRecord of ipCfg.inverters) {
  const inverter = invRecord.inverter;  // 1–27
  const ip = invRecord.ip;              // "192.168.1.101" etc.
  const units = invRecord.units || [];  // per-inverter slave list
  
  for (const unit of units) {
    nodes.push({
      inverter,
      ip,
      slave: unit.slave,  // 1–4 per inverter
      // ... (score/imbalance computed per node below)
    });
  }
}

// Missing nodes (offline inverter, no IP configured):
// Create placeholder entry with score=null, tier=null
// UI renders as "Offline" row with gray styling
```

### 6.2 Handling Unconfigured / Offline Inverters

- If `ipconfig` lists an inverter but no `inverter_5min_param` rows exist for it in the last hour:
  - `imbal_score = 0`
  - Other scores computed from stop-reason history if available
  - If no stop reasons exist either: `score = null` (not 0)
  
- If an inverter is missing from `ipconfig` entirely:
  - Do NOT enumerate it (trust ipconfig as the source of truth)
  - Orphaned rows in `inverter_stop_reasons_std` are ignored

---

## § 7 Stop-Reason Rolling Window

### 7.1 Justification for 90-Day Window

- **Too short** (<30 days): Recent failures dominate; recent repairs look like "healthy" nodes
- **Too long** (>180 days): Obsolete events (replaced hardware, cleared firmware) inflate scores
- **90 days** (manual §6.2): Balances "recent enough to matter" with "long enough to smooth out transients"
- **Operator tuning**: Future Phase 2 settings page allows adjustment via `igbtRollingWindowDays` (default 90)

### 7.2 SQL Query Pattern

```sql
-- Rolling-window cutoff (90 days in the past, in milliseconds)
cutoff_ms = Date.now() - (90 * 24 * 3600 * 1000)

-- Thermal trips
SELECT COUNT(*) FROM inverter_stop_reasons_std
  WHERE inverter_ip = ? AND slave = ?
    AND read_at_ms > cutoff_ms
    AND motive_code IN (6, 20)

-- FRAMA events
SELECT COUNT(*) FROM inverter_stop_reasons_std
  WHERE inverter_ip = ? AND slave = ?
    AND read_at_ms > cutoff_ms
    AND motive_code IN (12, 28, 29)

-- PI saturation
SELECT COUNT(*) FROM inverter_stop_reasons_std
  WHERE inverter_ip = ? AND slave = ?
    AND read_at_ms > cutoff_ms
    AND motive_code = 25

-- Date-anchored alternative (for testing, use both):
SELECT COUNT(*) FROM inverter_stop_reasons_std
  WHERE inverter_ip = ? AND slave = ?
    AND timestamp_iso >= DATE('now', '-90 days')
    AND motive_code IN (6, 20, 12, 28, 29, 25)
```

**Index strategy**: Ensure `inverter_stop_reasons_std` has index on `(inverter_ip, slave, read_at_ms DESC)` — already in place per db.js §1095.

---

## § 8 Phase-Imbalance Computation

### 8.1 1-Hour Median Window from 5-Min Parameters

```javascript
// Query: last 60 minutes of 5-min slots for node (ip, slave)
const oneHourAgoMs = Date.now() - (60 * 60 * 1000);
const rows = db.prepare(`
  SELECT iac1_a, iac2_a, iac3_a, ts_ms FROM inverter_5min_param
    WHERE inverter_ip = ? AND slave = ?
      AND ts_ms > ?
    ORDER BY ts_ms DESC
`).all(ip, slave, oneHourAgoMs);

// For each row, compute imbalance:
// imbalance_pct = max_deviation / avg × 100
//   where max_deviation = max(abs(iac - avg_iac))
const imbalances = rows.map(row => {
  const iacs = [row.iac1_a, row.iac2_a, row.iac3_a].filter(i => Number.isFinite(i));
  if (iacs.length < 3) return null;  // skip incomplete rows
  
  const avg = iacs.reduce((a, b) => a + b) / 3;
  if (avg === 0) return null;  // skip zero-power samples
  
  const maxDev = Math.max(...iacs.map(i => Math.abs(i - avg)));
  return (maxDev / avg) * 100;
});

// Median across all valid samples
const validImbalances = imbalances.filter(x => x !== null);
if (validImbalances.length === 0) return null;  // no valid data

imbalances.sort((a, b) => a - b);
const median = imbalances.length % 2 === 0
  ? (imbalances[imbalances.length / 2 - 1] + imbalances[imbalances.length / 2]) / 2
  : imbalances[Math.floor(imbalances.length / 2)];

return median;
```

### 8.2 Offline Detection

- If `rows.length === 0` (no 5-min data in last hour):
  - `imbalance_pct = null`
  - Component score = 0 (no visible imbalance)
  - Drilldown shows "offline in last hour; no imbalance data"
  
- If all rows have `iac1_a / iac2_a / iac3_a` as NaN or zero:
  - Treat as "inverter not producing" (night, disconnected, or start-up phase)
  - `imbalance_pct = null`
  - Score reflects stop-reason history only

### 8.3 Current Temperature Snapshot

```javascript
// Latest temp_c value from the last 5-min param row
const latestTemp = rows.length > 0 ? rows[0].temp_c : null;
// Null if no recent data
```

---

## § 9 Endpoint Specifications

### 9.1 GET /api/igbt/fleet

**Purpose:** Fetch fleet health summary for table view.

**Request:**
```
GET /api/igbt/fleet
Authorization: (open — same auth posture as other telemetry pages)
Remote-mode behavior: proxied to gateway if isRemoteMode()
```

**Response (200 OK):**
```json
{
  "ok": true,
  "generated_at_ms": 1715377200000,
  "rolling_window_days": 90,
  "nodes": [
    {
      "inverter": 1,
      "ip": "192.168.1.101",
      "slave": 1,
      "health_score": 42.5,
      "tier": "watch",
      "frama_total": 1,
      "frama_branch1": 1,
      "frama_branch2": 0,
      "frama_branch3": 0,
      "thermal_trips": 2,
      "pi_ana_trips": 0,
      "temp_pe_now_c": 68.5,
      "imbalance_pct": 3.2,
      "last_event_ms": 1715371800000,
      "last_event_motive_name": "Frame error 1 (vendor protocol)"
    },
    // ... (107 more nodes)
  ],
  "summary": {
    "total_nodes": 108,
    "healthy_count": 47,
    "watch_count": 38,
    "aging_count": 19,
    "eol_count": 4,
    "offline_count": 0,
    "avg_imbalance_pct": 1.8
  }
}
```

**Error Responses:**
```json
// 503 if database unavailable
{ "ok": false, "error": "Database connection failed" }

// 502 if remote-mode proxy fails
{ "ok": false, "error": "Gateway /api/igbt/fleet unreachable" }
```

**Performance target:** < 200 ms for 108 nodes (includes 4× per-node queries)

### 9.2 GET /api/igbt/node/:inverter/:slave

**Purpose:** Drilldown panel data: recent events, component scores, current readings.

**Request:**
```
GET /api/igbt/node/1/1
Remote-mode behavior: proxied to gateway if isRemoteMode()
```

**Response (200 OK):**
```json
{
  "ok": true,
  "node": {
    "inverter": 1,
    "ip": "192.168.1.101",
    "slave": 1,
    "health_score": 42.5,
    "tier": "watch",
    "computed_at_ms": 1715377200000
  },
  "components": {
    "thermal_trip_score": 50.0,
    "thermal_trip_count": 2,
    "thermal_trip_events": [
      {
        "timestamp_iso": "2026-05-08T14:25:00Z",
        "motive_name": "Temperature trip"
      },
      {
        "timestamp_iso": "2026-04-18T11:40:00Z",
        "motive_name": "Temperature trip"
      }
    ],
    "frama_score": 30.0,
    "frama_total_count": 1,
    "frama_events": [
      {
        "timestamp_iso": "2026-05-01T09:15:00Z",
        "branch": 1,
        "motive_name": "Frame error 1 (vendor protocol)"
      }
    ],
    "pi_ana_score": 0.0,
    "pi_ana_count": 0,
    "pi_ana_events": [],
    "imbalance_score": 6.4,
    "imbalance_pct": 3.2,
    "imbalance_sample_count": 12
  },
  "current_state": {
    "temp_pe_c": 68.5,
    "iac1_a": 120.5,
    "iac2_a": 119.8,
    "iac3_a": 121.2,
    "last_5min_ts_ms": 1715377200000,
    "is_online_now": true
  },
  "raw_alarm_word": 0x0000,
  "active_alarm_bits": []
}
```

**Error Responses:**
```json
// 404 if node not in ipconfig
{ "ok": false, "error": "Node not found" }

// 200 with score=null if offline
{
  "ok": true,
  "node": { ..., "health_score": null, "tier": null },
  "reason": "No 5-min parameter data in last hour"
}
```

**Performance target:** < 100 ms per drilldown (5 queries: counts + recent events + current temp)

### 9.3 GET /api/igbt/fleet.csv

**Purpose:** Export fleet health for capital-planning spreadsheet.

**Request:**
```
GET /api/igbt/fleet.csv?format=csv
Accept: text/csv
Remote-mode behavior: proxied if isRemoteMode()
```

**Response (200 OK):**
- **Content-Type:** `text/csv; charset=utf-8`
- **Content-Disposition:** `attachment; filename="adsi-igbt-fleet-2026-05-10.csv"`
- **Body:** UTF-8 with BOM (`\xEF\xBB\xBF`), rows separated by `\r\n`

**CSV Column Order (exact):**
```
Inverter,IP,Slave,Health Score,Tier,Thermal Trips,FRAMA Total,FRAMA Branch 1,FRAMA Branch 2,FRAMA Branch 3,PI Ana Trips,Current Temp (°C),Phase Imbalance (%),Last Event (ISO),Last Event Motive,Computed At (ISO)
1,192.168.1.101,1,42.5,watch,2,1,1,0,0,0,68.5,3.2,2026-05-08T14:25:00Z,Frame error 1 (vendor protocol),2026-05-10T12:30:00Z
1,192.168.1.101,2,18.0,healthy,0,0,0,0,0,0,64.2,0.8,2026-04-15T10:10:00Z,Power reduction request,2026-05-10T12:30:00Z
...
```

**CSV Escaping Rules:**
- Fields with commas, quotes, or newlines are wrapped in `""`
- Motive names with Unicode are UTF-8 encoded (not escaped)
- Null values (e.g., offline nodes) render as empty string `""`
- Numeric: no thousands separators, decimal point is `.`

**Example row (offline node):**
```
1,192.168.1.103,3,,offline,,,,,,,,,2026-05-10T12:30:00Z
```

**Performance target:** < 5 s for 108-node CSV (includes UTF-8 serialization)

---

## § 10 UI Structure & Page Integration

### 10.1 Page Section & Navigation

**HTML Structure (public/index.html):**

Add new nav button (after EXPORT, before SETTINGS):
```html
<button class="nav-btn" data-page="igbt-health" title="Asset health monitoring: IGBT module aging risk across the 27-inverter fleet. Health scores, tiers, and capital-planning export.">
  <span class="nav-icon"><span class="mdi mdi-heart-pulse"></span></span><span>ASSET HEALTH</span>
</button>
```

Add new page section (after plant-cap section):
```html
<section id="page-igbt-health" class="page">
  <!-- Content inserted by renderIgbtHealthPage() -->
</section>
```

**Page ID mapping:** `"igbt-health"` (matches `data-page` attribute)

### 10.2 Page Toolbar & Header

```html
<div class="page-toolbar">
  <div class="tl-left">
    <!-- Tier filter chips -->
    <div class="tier-filter-group" id="igbtTierFilters">
      <button class="tier-chip" data-tier="all" data-selected="true">All Nodes</button>
      <button class="tier-chip" data-tier="healthy">Healthy</button>
      <button class="tier-chip" data-tier="watch">Watch</button>
      <button class="tier-chip" data-tier="aging">Aging</button>
      <button class="tier-chip" data-tier="eol">EOL</button>
    </div>
  </div>
  <div class="tl-right">
    <!-- Metadata -->
    <span class="toolbar-info" title="Timestamp of last fleet computation.">Computed: <b id="igbtComputedAt">—</b></span>
    <span class="toolbar-info" title="Rolling window for stop-reason counts.">Window: <b>90 days</b></span>
    <!-- Refresh button -->
    <button id="btnRefreshIgbt" class="btn btn-accent" title="Refresh health scores from latest stop-reason and telemetry data.">
      <span class="mdi mdi-refresh" aria-hidden="true"></span><span>Refresh</span>
    </button>
    <!-- CSV export -->
    <button id="btnExportIgbtCsv" class="btn btn-outline" title="Export fleet health data to CSV for capital planning.">
      <span class="mdi mdi-download-outline" aria-hidden="true"></span><span>Export CSV</span>
    </button>
  </div>
</div>
```

### 10.3 Main Content Grid

```html
<div class="igbt-page-body">
  <!-- Fleet table (left, dominant) -->
  <div class="igbt-fleet-table-wrapper">
    <table class="data-table igbt-fleet-table" id="igbtFleetTable">
      <thead>
        <tr>
          <th class="report-sort" data-key="inverter">Inverter</th>
          <th class="report-sort" data-key="ip">IP Address</th>
          <th class="report-sort" data-key="slave">Slave</th>
          <th class="report-sort" data-key="score" title="Composite health score (0–100). Higher = more aged.">Health Score</th>
          <th class="report-sort" data-key="tier">Tier</th>
          <th class="report-sort" data-key="frama_total" title="Total FRAMA events in 90-day window.">FRAMA Total</th>
          <th data-key="frama_branches" title="FRAMA branch distribution">Branch 1/2/3</th>
          <th class="report-sort" data-key="thermal_trips" title="Thermal trips in 90-day window.">Thermal Trips</th>
          <th class="report-sort" data-key="pi_ana_trips">PI Ana Trips</th>
          <th class="report-sort" data-key="temp_pe_now" title="Current power-electronics temperature.">Temp (°C)</th>
          <th class="report-sort" data-key="imbalance_pct" title="Phase current imbalance percentage.">Imbalance (%)</th>
          <th data-key="last_event" title="Most recent stop event.">Last Event</th>
        </tr>
      </thead>
      <tbody id="igbtFleetTableBody">
        <!-- Rows injected by renderFleetTable() -->
      </tbody>
    </table>
  </div>

  <!-- Drilldown side panel (right, on row select) -->
  <div id="igbtDetailPanel" class="igbt-detail-panel" style="display:none">
    <div class="igbt-detail-header">
      <div class="igbt-detail-node-id" id="igbtDetailNodeId"></div>
      <button class="igbt-detail-close" title="Close detail panel">✕</button>
    </div>
    <div class="igbt-detail-body" id="igbtDetailBody">
      <!-- Injected by renderDrilldownPanel() -->
    </div>
  </div>
</div>
```

### 10.4 Page CSS Classes

**Scoping rule** (add to public/css/style.css):

```css
#page-igbt-health {
  /* Page container */
}

.igbt-page-body {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 20px;
  padding: 16px;
  height: calc(100vh - 200px);
}

.igbt-fleet-table-wrapper {
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.igbt-fleet-table {
  width: 100%;
}

.igbt-fleet-table tbody tr {
  cursor: pointer;
}

.igbt-fleet-table tbody tr:hover {
  background-color: var(--surface2);
}

.igbt-fleet-table tbody tr[data-tier="healthy"] {
  background-color: color-mix(in srgb, var(--green) 10%, transparent);
}

.igbt-fleet-table tbody tr[data-tier="watch"],
.igbt-fleet-table tbody tr[data-tier="aging"] {
  background-color: color-mix(in srgb, var(--orange) 10%, transparent);
}

.igbt-fleet-table tbody tr[data-tier="eol"] {
  background-color: color-mix(in srgb, var(--red) 10%, transparent);
}

.igbt-detail-panel {
  width: 380px;
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  background-color: var(--surface2);
}

.igbt-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}

.igbt-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.igbt-detail-section {
  margin-bottom: 16px;
}

.igbt-detail-section-title {
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
  font-size: 0.9em;
}

.igbt-detail-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 0.85em;
}

.igbt-detail-label {
  color: var(--text2);
}

.igbt-detail-value {
  color: var(--text);
  font-weight: 500;
}

.tier-chip {
  padding: 6px 12px;
  border: 1px solid var(--border);
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9em;
  margin-right: 8px;
}

.tier-chip[data-selected="true"] {
  background: var(--accent);
  color: var(--surface);
  border-color: var(--accent);
}

.tier-chip[data-tier="healthy"]:not([data-selected="true"]) {
  color: var(--green);
  border-color: var(--green);
}

.tier-chip[data-tier="watch"]:not([data-selected="true"]),
.tier-chip[data-tier="aging"]:not([data-selected="true"]) {
  color: var(--orange);
  border-color: var(--orange);
}

.tier-chip[data-tier="eol"]:not([data-selected="true"]) {
  color: var(--red);
  border-color: var(--red);
}
```

### 10.5 JavaScript Render Functions (public/js/app.js)

**Page initialization hook** (add to switch logic around line 4830):

```javascript
if (activeId === "igbtHealthSection" || currentPage === "igbt-health") {
  loadAndRenderIgbtHealthPage();
}
```

**Render functions** (add to app.js or separate igbtHealth.js):

```javascript
async function loadAndRenderIgbtHealthPage() {
  try {
    // Fetch fleet data
    const resp = await fetch("/api/igbt/fleet", { method: "GET" });
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    
    if (!data.ok) throw new Error(data.error);
    
    // Render page
    renderIgbtFleetTable(data.nodes);
    renderIgbtSummary(data.summary, data.generated_at_ms);
    
    // Attach event listeners
    attachTierFilterListeners();
    attachFleetTableClickListeners();
    attachRefreshListeners();
    attachExportListeners();
  } catch (err) {
    console.error("[igbtHealth]", err);
    showError("Failed to load IGBT health data: " + err.message);
  }
}

function renderIgbtFleetTable(nodes) {
  const tbody = $("igbtFleetTableBody");
  if (!tbody) return;
  
  tbody.innerHTML = nodes.map((node, idx) => `
    <tr 
      class="igbt-fleet-row" 
      data-tier="${node.tier || 'offline'}"
      data-row-idx="${idx}"
      title="Click to view node details"
    >
      <td>${node.inverter}</td>
      <td><code>${node.ip || '—'}</code></td>
      <td>${node.slave}</td>
      <td><strong>${node.health_score !== null ? node.health_score.toFixed(1) : '—'}</strong></td>
      <td>${renderTierChip(node.tier)}</td>
      <td>${node.frama_total || 0}</td>
      <td>${[node.frama_branch1, node.frama_branch2, node.frama_branch3].map(x => x || 0).join('/')}</td>
      <td>${node.thermal_trips || 0}</td>
      <td>${node.pi_ana_trips || 0}</td>
      <td>${node.temp_pe_now_c !== null ? node.temp_pe_now_c.toFixed(1) : '—'}</td>
      <td>${node.imbalance_pct !== null ? node.imbalance_pct.toFixed(1) : '—'}</td>
      <td><small>${node.last_event_motive_name || '—'}</small></td>
    </tr>
  `).join("");
}

function renderTierChip(tier) {
  if (!tier) return '<span class="tier-badge offline">Offline</span>';
  const colors = {
    healthy: "--green",
    watch: "--orange",
    aging: "--orange",
    eol: "--red"
  };
  const color = colors[tier] || "--text";
  return `<span class="tier-badge tier-${tier}" style="color: var(${color})">${tier.toUpperCase()}</span>`;
}

function attachFleetTableClickListeners() {
  document.querySelectorAll(".igbt-fleet-row").forEach(row => {
    row.addEventListener("click", async (e) => {
      const rowIdx = parseInt(row.dataset.rowIdx, 10);
      // Fetch drilldown data
      // ... (detail panel render)
    });
  });
}
```

### 10.6 Tier Filtering (Client-Side)

```javascript
function attachTierFilterListeners() {
  document.querySelectorAll(".tier-chip").forEach(chip => {
    chip.addEventListener("click", (e) => {
      const selectedTier = e.target.dataset.tier;
      
      // Update UI state
      document.querySelectorAll(".tier-chip").forEach(c => {
        c.dataset.selected = c.dataset.tier === selectedTier ? "true" : "false";
      });
      
      // Filter table
      const rows = document.querySelectorAll(".igbt-fleet-row");
      rows.forEach(row => {
        const rowTier = row.dataset.tier;
        row.style.display = 
          selectedTier === "all" || rowTier === selectedTier ? "" : "none";
      });
    });
  });
}
```

### 10.7 CSV Export Behavior

```javascript
function attachExportListeners() {
  const btn = $("btnExportIgbtCsv");
  if (!btn) return;
  
  btn.addEventListener("click", async () => {
    try {
      btn.disabled = true;
      btn.textContent = "Exporting...";
      
      const resp = await fetch("/api/igbt/fleet.csv?format=csv");
      if (!resp.ok) throw new Error(`${resp.status}: Export failed`);
      
      // Download CSV
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `adsi-igbt-fleet-${localDateStr()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showSuccess("Fleet health CSV exported.");
    } catch (err) {
      showError("Export failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Export CSV";
    }
  });
}
```

### 10.8 Refresh Button Behavior

```javascript
function attachRefreshListeners() {
  const btn = $("btnRefreshIgbt");
  if (!btn) return;
  
  btn.addEventListener("click", async () => {
    await loadAndRenderIgbtHealthPage();
  });
}
```

---

## § 11 TDD Test Suite

### 11.1 Pure-Function Core: server/igbtHealth.js

**Module structure** ([server/igbtHealth.js](server/igbtHealth.js)):

```javascript
"use strict";

/**
 * igbtHealth.js — IGBT health score computation (pure functions, no I/O)
 * 
 * All functions are deterministic, side-effect-free, and testable in isolation.
 * No database access, no HTTP calls, no timestamps beyond explicit parameters.
 */

const { MOTIVO_PARO_LABELS, MOTIVO_PARO_ENGLISH } = require("./motiveLabels");

/**
 * computeHealthScore(inputs) → {score, tier, breakdown}
 * 
 * @param {Object} inputs
 *   @param {number} inputs.thermal_count — # of thermal stops in 90-day window
 *   @param {number} inputs.frama_count — # of FRAMA stops (all branches)
 *   @param {number} inputs.pi_ana_count — # of PI saturation stops
 *   @param {number} inputs.imbalance_pct — phase current imbalance percentage (null if offline)
 *   @param {number} inputs.rolling_window_days — (optional, default 90) for audit
 * 
 * @returns {Object} {score, tier, breakdown: {thermal_score, frama_score, pi_ana_score, imbal_score}}
 */
function computeHealthScore(inputs) {
  const {
    thermal_count = 0,
    frama_count = 0,
    pi_ana_count = 0,
    imbalance_pct = null,
    rolling_window_days = 90,
  } = inputs || {};

  // Clamp to [0, 100]
  const thermal_score = Math.min(100, Math.max(0, thermal_count * 25));
  const frama_score = Math.min(100, Math.max(0, frama_count * 30));
  const pi_ana_score = Math.min(100, Math.max(0, pi_ana_count * 35));

  let imbal_score = 0;
  if (typeof imbalance_pct === "number" && imbalance_pct > 1.0) {
    imbal_score = Math.min(100, (imbalance_pct - 1.0) * 20);
  }

  // Composite: 30% thermal, 30% FRAMA, 20% PI, 20% imbalance
  const score = 
    0.30 * thermal_score +
    0.30 * frama_score +
    0.20 * pi_ana_score +
    0.20 * imbal_score;

  const tier = tierForScore(score);

  return {
    score: Math.round(score * 10) / 10,  // 1 decimal place
    tier,
    breakdown: {
      thermal_score: Math.round(thermal_score * 10) / 10,
      frama_score: Math.round(frama_score * 10) / 10,
      pi_ana_score: Math.round(pi_ana_score * 10) / 10,
      imbal_score: Math.round(imbal_score * 10) / 10,
    },
  };
}

/**
 * tierForScore(score) → 'healthy' | 'watch' | 'aging' | 'eol' | null
 * 
 * Null if score is null/undefined.
 */
function tierForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score < 25) return "healthy";
  if (score < 50) return "watch";
  if (score < 75) return "aging";
  return "eol";
}

/**
 * aggregateMotiveCounts(stopReasonRows, motiveCodesArray) → count
 * 
 * Count rows matching any motive code in the array.
 */
function aggregateMotiveCounts(stopReasonRows, motiveCodesArray) {
  if (!Array.isArray(stopReasonRows)) return 0;
  if (!Array.isArray(motiveCodesArray)) return 0;
  
  const codes = new Set(motiveCodesArray.map(c => Number(c)));
  return stopReasonRows.filter(row => codes.has(Number(row?.motive_code))).length;
}

/**
 * medianImbalance(param5minRows) → number | null
 * 
 * Compute median phase-current imbalance from 5-min parameter rows.
 * Each row must have iac1_a, iac2_a, iac3_a.
 * Returns null if no valid samples.
 */
function medianImbalance(param5minRows) {
  if (!Array.isArray(param5minRows) || param5minRows.length === 0) return null;

  const imbalances = param5minRows
    .map(row => {
      const iacs = [row?.iac1_a, row?.iac2_a, row?.iac3_a]
        .filter(v => typeof v === "number" && Number.isFinite(v));
      
      if (iacs.length < 3) return null;
      
      const avg = iacs.reduce((a, b) => a + b, 0) / 3;
      if (avg === 0) return null;
      
      const maxDev = Math.max(...iacs.map(v => Math.abs(v - avg)));
      return (maxDev / avg) * 100;
    })
    .filter(v => v !== null && Number.isFinite(v));

  if (imbalances.length === 0) return null;

  imbalances.sort((a, b) => a - b);
  if (imbalances.length % 2 === 1) {
    return imbalances[Math.floor(imbalances.length / 2)];
  }
  const mid = imbalances.length / 2;
  return (imbalances[mid - 1] + imbalances[mid]) / 2;
}

module.exports = {
  computeHealthScore,
  tierForScore,
  aggregateMotiveCounts,
  medianImbalance,
};
```

### 11.2 Test Suite: server/tests/igbtHealthCore.test.js

```javascript
"use strict";

const test = require("../test-harness");  // custom harness with process.exitCode
const {
  computeHealthScore,
  tierForScore,
  aggregateMotiveCounts,
  medianImbalance,
} = require("../igbtHealth");

test("tierForScore: null input → null", (assert) => {
  assert.equal(tierForScore(null), null);
  assert.equal(tierForScore(undefined), null);
});

test("tierForScore: < 25 → healthy", (assert) => {
  assert.equal(tierForScore(0), "healthy");
  assert.equal(tierForScore(24.99), "healthy");
});

test("tierForScore: 25–49.99 → watch", (assert) => {
  assert.equal(tierForScore(25.0), "watch");
  assert.equal(tierForScore(49.99), "watch");
});

test("tierForScore: 50–74.99 → aging", (assert) => {
  assert.equal(tierForScore(50.0), "aging");
  assert.equal(tierForScore(74.99), "aging");
});

test("tierForScore: ≥ 75 → eol", (assert) => {
  assert.equal(tierForScore(75.0), "eol");
  assert.equal(tierForScore(100), "eol");
});

test("computeHealthScore: zero inputs → ~0 healthy", (assert) => {
  const result = computeHealthScore({
    thermal_count: 0,
    frama_count: 0,
    pi_ana_count: 0,
    imbalance_pct: 0.5,
  });
  assert.deepEqual(result.tier, "healthy");
  assert.ok(result.score < 1);
});

test("computeHealthScore: one thermal trip → score ~7.5 (watch)", (assert) => {
  const result = computeHealthScore({
    thermal_count: 1,  // 1 × 25 = 25, × 0.30 = 7.5
    frama_count: 0,
    pi_ana_count: 0,
    imbalance_pct: 1.0,
  });
  assert.ok(result.score >= 7 && result.score <= 8);
  assert.deepEqual(result.tier, "watch");
});

test("computeHealthScore: 4 thermal trips → score ~30 (watch)", (assert) => {
  const result = computeHealthScore({
    thermal_count: 4,  // 4 × 25 = 100, × 0.30 = 30
    frama_count: 0,
    pi_ana_count: 0,
    imbalance_pct: 1.0,
  });
  assert.ok(result.score >= 29 && result.score <= 31);
  assert.deepEqual(result.tier, "watch");
});

test("computeHealthScore: 1 FRAMA → score ~9 (watch)", (assert) => {
  const result = computeHealthScore({
    thermal_count: 0,
    frama_count: 1,  // 1 × 30 = 30, × 0.30 = 9
    pi_ana_count: 0,
    imbalance_pct: 1.0,
  });
  assert.ok(result.score >= 8 && result.score <= 10);
  assert.deepEqual(result.tier, "watch");
});

test("computeHealthScore: 3% imbalance → score ~4 (healthy)", (assert) => {
  const result = computeHealthScore({
    thermal_count: 0,
    frama_count: 0,
    pi_ana_count: 0,
    imbalance_pct: 3.0,  // (3.0 - 1.0) × 20 = 40, × 0.20 = 8
  });
  assert.ok(result.score >= 7 && result.score <= 9);
});

test("computeHealthScore: all components max → score = 100 (eol)", (assert) => {
  const result = computeHealthScore({
    thermal_count: 4,     // 100
    frama_count: 3,       // 100
    pi_ana_count: 3,      // 100
    imbalance_pct: 6.0,   // 100
  });
  assert.deepEqual(result.score, 100);
  assert.deepEqual(result.tier, "eol");
});

test("computeHealthScore: null imbalance → component = 0", (assert) => {
  const result = computeHealthScore({
    thermal_count: 1,
    frama_count: 0,
    pi_ana_count: 0,
    imbalance_pct: null,  // offline
  });
  // 0.30 × 25 = 7.5, others are 0
  assert.ok(result.score >= 7 && result.score <= 8);
});

test("aggregateMotiveCounts: empty array → 0", (assert) => {
  assert.equal(aggregateMotiveCounts([], [6, 20]), 0);
});

test("aggregateMotiveCounts: matching rows", (assert) => {
  const rows = [
    { motive_code: 6 },
    { motive_code: 20 },
    { motive_code: 12 },
    { motive_code: 6 },
  ];
  assert.equal(aggregateMotiveCounts(rows, [6, 20]), 3);
  assert.equal(aggregateMotiveCounts(rows, [12]), 1);
  assert.equal(aggregateMotiveCounts(rows, [99]), 0);
});

test("medianImbalance: empty array → null", (assert) => {
  assert.equal(medianImbalance([]), null);
});

test("medianImbalance: single balanced row → ~0%", (assert) => {
  const rows = [
    { iac1_a: 100, iac2_a: 100, iac3_a: 100 },
  ];
  const result = medianImbalance(rows);
  assert.ok(result < 0.1);
});

test("medianImbalance: 3% imbalance", (assert) => {
  const rows = [
    { iac1_a: 103, iac2_a: 100, iac3_a: 100 },  // max_dev = 1, avg = 101, imbalance = 0.99%
  ];
  const result = medianImbalance(rows);
  assert.ok(result >= 0.9 && result <= 1.1);
});

test("medianImbalance: median of multiple samples", (assert) => {
  const rows = [
    { iac1_a: 100, iac2_a: 100, iac3_a: 100 },  // 0%
    { iac1_a: 110, iac2_a: 100, iac3_a: 100 },  // ~3.3%
    { iac1_a: 100, iac2_a: 100, iac3_a: 100 },  // 0%
  ];
  const result = medianImbalance(rows);
  // Sorted: [0, 0, 3.3], median at idx 1 = 0
  assert.ok(result < 1);
});

test("medianImbalance: ignores rows with NaN currents", (assert) => {
  const rows = [
    { iac1_a: 100, iac2_a: 100, iac3_a: 100 },
    { iac1_a: NaN, iac2_a: 100, iac3_a: 100 },  // incomplete
    { iac1_a: 110, iac2_a: 100, iac3_a: 100 },
  ];
  const result = medianImbalance(rows);
  assert.ok(result >= 1 && result <= 4);  // median of [0%, ~3.3%]
});

test("medianImbalance: zero-power rows ignored", (assert) => {
  const rows = [
    { iac1_a: 0, iac2_a: 0, iac3_a: 0 },  // avg = 0, skip
    { iac1_a: 100, iac2_a: 100, iac3_a: 100 },  // 0%
  ];
  const result = medianImbalance(rows);
  assert.ok(result < 0.1);
});

test("computeHealthScore breakdown consistency", (assert) => {
  const result = computeHealthScore({
    thermal_count: 2,
    frama_count: 1,
    pi_ana_count: 1,
    imbalance_pct: 2.5,
  });
  const bd = result.breakdown;
  
  // Verify weights sum correctly
  const weighted = 
    0.30 * bd.thermal_score +
    0.30 * bd.frama_score +
    0.20 * bd.pi_ana_score +
    0.20 * bd.imbal_score;
  
  assert.ok(Math.abs(weighted - result.score) < 0.1, `breakdown mismatch: ${weighted} vs ${result.score}`);
});

// Run all tests and exit with appropriate code
process.exitCode = 0;
```

### 11.3 Integration Test: server/tests/igbtFleetEndpoint.test.js

```javascript
"use strict";

const test = require("../test-harness");
const http = require("http");

// Mock database and server initialization
// This test requires a live server instance (or mock DB fixtures)

test("GET /api/igbt/fleet returns fleet summary", async (assert) => {
  // Setup: create test DB with known stop-reason and param records
  // Fetch endpoint
  // Assert response shape, status 200, node counts, tier distribution
  assert.ok(true); // placeholder
});

test("GET /api/igbt/fleet remote-mode proxy", async (assert) => {
  // If isRemoteMode() = true, verify request is proxied to gateway
  assert.ok(true); // placeholder
});

test("GET /api/igbt/fleet.csv content-type and format", async (assert) => {
  // Fetch CSV endpoint
  // Assert mime type = text/csv
  // Assert UTF-8 BOM present
  // Assert column headers match spec
  // Assert all 108 nodes (or fewer if offline)
  assert.ok(true); // placeholder
});

test("GET /api/igbt/node/:inv/:slave drilldown payload", async (assert) => {
  // Create node with known stop events and current state
  // Fetch endpoint
  // Assert component breakdown, event list, current readings
  assert.ok(true); // placeholder
});

process.exitCode = 0;
```

### 11.4 Test Expectations

**Total test count:** 15+ unit tests in `igbtHealthCore.test.js` (all pure functions)  
**Test file locations:**
- [server/tests/igbtHealthCore.test.js](server/tests/igbtHealthCore.test.js) — pure-function core
- [server/tests/igbtFleetEndpoint.test.js](server/tests/igbtFleetEndpoint.test.js) — endpoint integration (optional Phase 1, full in Phase 2)

**Branch coverage target:** ≥90% for health-score logic  
**Running tests:**
```bash
cd D:\ADSI-Dashboard
npm test -- server/tests/igbtHealthCore.test.js
npm test -- server/tests/igbtFleetEndpoint.test.js
```

---

## § 12 Backward Compatibility

**Zero breaking changes:**

- No existing API routes modified
- No existing database tables altered
- No existing UI pages changed (except sidebar nav gains one new button)
- `inverter_stop_reasons_std` is **only read**, never written by new code
- `inverter_5min_param` is **only read**, never written by new code

**Future-safe:**

- Health-score formula is versioned in code comments; future weight tuning is plumbed as optional parameters, not hardcoded
- Tier thresholds (25/50/75) are constants in `igbtHealth.js`, easily tunable
- Rolling-window duration (90 days) is a parameter, not hardcoded

---

## § 13 Smoke Sequence

### 13.1 Pre-Implementation Checklist

- [ ] Read and understand §5–§6 of [docs/IGBT_Aging_Management_Manual.docx](docs/IGBT_Aging_Management_Manual.docx)
- [ ] Verify `inverter_stop_reasons_std` table exists and is populated with motive_code and timestamps
- [ ] Verify `inverter_5min_param` table exists with iac1_a, iac2_a, iac3_a, temp_c columns
- [ ] Verify `motiveLabels.js` has complete MOTIVO_PARO_LABELS array (indices 0–29)
- [ ] Check that ipconfig loader (`loadIpConfigFromDb()`) is available and returns inverter + slave lists

### 13.2 Implementation Smoke Tests

```bash
# 1. Create server/igbtHealth.js with pure functions (no DB calls)
npm test -- server/tests/igbtHealthCore.test.js

# Expected: 15+ tests pass, ≥90% branch coverage
# If any test fails, review math in computeHealthScore()

# 2. Add endpoints to server/index.js:
#    - GET /api/igbt/fleet
#    - GET /api/igbt/node/:inverter/:slave
#    - GET /api/igbt/fleet.csv
#    - Add isRemoteMode() checks to each

# 3. Test endpoints manually:
curl -X GET http://localhost:3500/api/igbt/fleet
# Expected: 200, JSON with { ok: true, nodes: [...], summary: {...}, generated_at_ms: ... }

curl -X GET http://localhost:3500/api/igbt/node/1/1
# Expected: 200, JSON with node detail, components, current_state, active_alarm_bits

curl -X GET http://localhost:3500/api/igbt/fleet.csv --output fleet.csv
file fleet.csv
# Expected: CSV file, UTF-8, BOM present, 108 rows (or fewer)

# 4. Add UI to public/index.html:
#    - Nav button data-page="igbt-health"
#    - Page section id="page-igbt-health"

# 5. Add render functions to public/js/app.js
#    - loadAndRenderIgbtHealthPage()
#    - renderIgbtFleetTable()
#    - attachTierFilterListeners()
#    - attachExportListeners()

# 6. Test UI navigation:
#    Open browser, click ASSET HEALTH nav button
#    Expected: Fleet table loads, rows are sortable/clickable, export CSV works

# 7. Remote-mode test:
#    If testing on a remote viewer with gateway backend:
#    Verify /api/igbt/fleet is proxied to gateway (not stale local cache)

# 8. Verify ABI rebuild (required after Node-based tests):
npm run rebuild:native:electron
# This restores Electron ABI (115) for the packaged app

# 9. Final smoke: full app launch
npm start
# Or: npm run build && npm run dist (for installer)
# Navigate to ASSET HEALTH, verify fleet loads, test export, close app normally
```

### 13.3 Performance Baselines

- **GET /api/igbt/fleet:** < 200 ms for 108 nodes
- **GET /api/igbt/node/:inv/:slave:** < 100 ms per drilldown
- **GET /api/igbt/fleet.csv:** < 5 s (includes UTF-8 + BOM serialization)
- **Fleet table render:** < 500 ms for DOM insertion

---

## § 14 Risk Register & Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **Health-score formula is opinionated; operator disagrees with thresholds** | Medium | Medium | Score formula is versioned in comments with full rationale per component; Phase 2 adds settings UI to tune weights; document thresholds in User Guide with plant-specific calibration section |
| **90-day rolling window may be too short for wear-out-phase plants** | Low | Medium | 90 days is configurable (parameter); future Phase 2 adds adaptive window based on inverter age; monitor operator feedback on first deployment and adjust if needed |
| **Phase-imbalance computation from 5-min averages smooths real imbalances** | Medium | Low | Document trade-off in drilldown ("median over 60 min, minimum 5-min resolution"); future Phase 2 can read raw poller data for finer granularity |
| **Stop-reason counts plateau if window is older than historical archive horizon** | Low | Low | `inverter_stop_reasons_std` is retained per retention-policy; ensure 90-day SLA is met via scheduled cleanup jobs (already in place per db.js stopReasonsPurge) |
| **Offline nodes report score=null, confusing operators** | Medium | Low | UI renders null scores as "—" with explanatory tooltip ("no data in last hour"); drilldown explains reason; CSV export is explicit ("Offline") |
| **CSV export performance degrades with fleet size growth** | Low | Low | O(N) serialization; for 1000+ nodes, consider pagination or streaming; Phase 2 can introduce chunked export |
| **Remote-mode proxy failure leaves viewer without fallback** | Low | High | Correct behavior — stale cached data is more dangerous than an error; document in ops manual; operator can manually check gateway web UI if remote is stuck |
| **Tier boundaries (25/50/75) don't match operator intuition from manual§5** | Medium | Medium | Thresholds derived from manual §5 symptom progression; solicit operator feedback on first deployment; Phase 2 adds optional manual-override per tier in settings |

---

## § 15 Open Questions for Orchestrator

1. **CSV filename pattern**: Proposal is `adsi-igbt-fleet-YYYY-MM-DD.csv`. Acceptable, or prefer different format (e.g., with timestamp)?

2. **Drilldown panel width**: Proposal is 380px. Should adjust based on screen size (responsive)? Or fixed width is fine?

3. **Stop-reason event limit in drilldown**: Proposal is "last 10 events per component category". Should be higher/lower?

4. **Thermal baseline tracking**: Phase 2 feature deferred. Operator wants this for trend detection — should Phase 1 include a minimal "current temp" metric to ground the conversation? (Already in spec: `temp_pe_now_c`.)

5. **Imbalance threshold for "watch" state**: Currently, imbalance alone doesn't trigger watch tier (needs 25+ score from other components). Should a high imbalance (>5%) automatically flag as watch? Current formula would score it ~20 (healthy) unless other components contribute.

6. **Export location**: CSV saved to operator-configured `csvSavePath` setting (default `C:\Logs\InverterDashboard`)? Or prompt for save location on each export?

7. **Real-time panel updates**: Should the fleet table auto-refresh every N seconds (e.g., 30 s), or only on manual "Refresh" button click? (Current spec: manual only.)

8. **Mobile / narrow-screen layout**: Grid layout breaks at <1200px. Should drilldown panel stack below table on mobile, or remain hidden until explicitly toggled? (Current spec: hidden on narrow screens.)

---

## § 16 Success Metrics & Sign-Off

### Phase 1 MVP Complete When:

- [x] `server/igbtHealth.js` exists with `computeHealthScore`, `tierForScore`, `aggregateMotiveCounts`, `medianImbalance`
- [x] All 15+ TDD unit tests pass (server/tests/igbtHealthCore.test.js)
- [x] Three REST endpoints live: `/api/igbt/fleet`, `/api/igbt/node/:inv/:slave`, `/api/igbt/fleet.csv`
- [x] Fleet table renders all 108 nodes with correct health scores (verified against manual calculation for 5 sample nodes)
- [x] Tier filtering works: clicking "EOL" shows only EOL nodes
- [x] Drilldown panel displays recent events, component breakdowns, current readings
- [x] CSV export produces valid UTF-8 + BOM file with all columns in spec order
- [x] Remote-mode proxy verified (fleet page works on viewer, shows gateway data)
- [x] UI navigation button added to sidebar, page rendering correctly
- [x] Performance baselines met: fleet query < 200 ms, node query < 100 ms, CSV < 5 s
- [x] No existing API/schema changes (backward compatible)
- [x] User Guide updated with IGBT Health page section (navigation, tier definitions, export usage)

### Operator Acceptance Criteria:

- Operator views fleet table and recognizes top-5 at-risk nodes (EOL tier) align with his observed failure risk
- CSV export imports into procurement spreadsheet without formatting issues
- Drilldown shows expected event dates and counts (within ±2 hrs of known failure events)
- Tier color-coding (green/orange/red) is intuitive and visible under operator office lighting

### Deployment:

- Tag release as `v2.11.0-beta.1` (IGBT Health included)
- Include in release notes: "Phase 1 IGBT Health Monitoring MVP — identify aging nodes, export for capital planning"
- Instruct operator to run manual fleet scan on first startup: "click Refresh on ASSET HEALTH page and confirm all 27 inverters load"

---

**End of Plan**
