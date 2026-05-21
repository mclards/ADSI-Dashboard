# Data Architecture Reference

## Hot/Cold Model

- **Hot DB**: `C:\ProgramData\InverterDashboard\adsi.db`
- **Archive DBs**: `C:\ProgramData\InverterDashboard\archive\` (monthly SQLite files)
- Hot tables: `readings`, `energy_5min`
- Summary tables in main DB: `daily_report`, `daily_readings_summary`, alarms, audit, forecast, settings

## Current-Day Energy Authority

`TODAY MWh`, `ACTUAL MWh`, and per-inverter `TODAY ENERGY` come from **server-side PAC × elapsed time** only. Python/Modbus register kWh and inverter lifetime-energy registers are raw telemetry only — not authoritative for current-day totals.

Authority path: `raw PAC from Python → Node poller integration → energy_5min / snapshot → HTTP/WS/UI/export`

The gateway poller seeds from persisted `energy_5min` totals plus a live PAC anchor on restart — it does not re-add the full live day counter on top of the persisted baseline.

## Solar Window

Approximately **05:00–18:00**. Raw poll persistence to `readings` and `energy_5min` is gated inside this window. Polling continues outside for dashboard and alarm visibility. Shutdown flush respects the same gate.

## SQLite Configuration

WAL mode + `synchronous = NORMAL`. Routine checkpoints: `PASSIVE` only. `TRUNCATE` only at `closeDb()`. `bulkInsertWithSummary()` combines reading inserts and daily summary upserts in one transaction. `pruneOldData()` and `archiveTelemetryBeforeCutoff()` yield the event loop between 5,000-row batches via `setImmediate`.

## Retention and Archival

`retainDays` controls hot raw telemetry window. Old data must be archived, not discarded. Archive-aware helpers for historical queries: `queryReadingsRange(All)`, `queryEnergy5minRange(All)`, `sumEnergy5minByInverterRange()`. Do not add new hot-only SQL scans for date ranges that may cross retention boundaries.

## Daily Reports

Past-date reporting uses persisted `daily_report` rows. `daily_readings_summary` for per-unit uptime and PAC rollups. Exports: one row per inverter per day + one `TOTAL` row. Plant Peak/Avg PAC from real aggregates only — do not fake by summing inverter values.

## IP Config Identity Authority

Telemetry ownership follows IP Config directly — not assumed IP-numbering patterns. The inverter service stamps each live frame with `source_ip` and `node_number`. The Node poller resolves inverter identity from configured inverter IP + configured node list. Unknown IPs and unconfigured nodes are rejected. IP Config wins if a raw frame reports a conflicting inverter number.

---

## Alarms

**Episode model**: when a node's nonzero alarm changes to another nonzero value, the active row is updated in place and acknowledged state is preserved. A bitmask change on an already-active node is not a new episode.

**Sound**: tied to a sustained unacknowledged active episode. Blips clearing within 5 seconds do not trigger sound.

**Quick-ACK**: `showAlarmToast()` (not `showToast()`) renders an inline ACK button. Bell panel renders `.notif-ack-btn` per unacknowledged alarm. Both paths call `ackAlarm(id, btn)` → `POST /api/alarms/:id/ack`. Toast TTL 12 s; auto-dismisses 1.2 s after ACK.

---

## Replication

**Manual Pull** — download-only. If local replicated data is newer → `LOCAL_NEWER_PUSH_FAILED` with `canForcePull: true`. Local-newer check ignores local-only `settings` drift (gateway URL, token, mode) to avoid false blocks. Downloads a transactionally consistent gateway `adsi.db` snapshot; staged for restart-safe local replacement.

**Manual Push** — upload-only. Does not pull gateway DB or stage a local replacement.

**Startup auto-sync** — incremental, read-only toward gateway, LWW-based.

### Transport
- Chunked uploads (avoid HTTP `413`)
- HTTP Range resume for archive downloads (3 retries)
- Socket pool boosted to 16 during manual pull/push via `boostSocketPoolForReplication()`, restored after in try/finally
- Large payloads and DB downloads gzip-compressed when peer accepts it
- `x-main-db-cursors` header carries replication cursors after main-DB pull
- Gateway creates a transactionally consistent snapshot via SQLite online backup API — never streams live `adsi.db` directly

### Archive Replacement Safety
Pulled archive DB replacements are staged as temp files and applied only during startup before the server begins serving requests. A failed or cancelled pull discards all staged replacements immediately.

### Inbound Telemetry Age
Replicated raw `readings` or `energy_5min` older than local `retainDays` cutoff are written into the local archive rather than the hot DB.

### MWh Handoff (Remote → Gateway Switch)
`gatewayHandoffMeta` tracks the in-memory handoff lifecycle. `MAX_SHADOW_AGE_MS = 4h`. Per-inverter kWh baselines captured at switch time via `applyRuntimeMode()`. `getTodayEnergySupplementRows()` applies carry/caught-up logic and auto-completes handoff when all baselines are met. Core logic in `server/mwhHandoffCore.js`.

---

## Plant Output Cap

Plant cap controller runs on **gateway only**. Whole-inverter sequential STOP/START to keep plant output within a configured ceiling. Exempted inverter numbers excluded from automatic stop selection.

Live inverter `Pac` is the primary shed estimate. Planning scales `997.0 kW` rated and `917.0 kW` dependable baselines by enabled node count.

While cap monitoring is active, all non-exempted inverters are under controller authority — manual control must be blocked at the API layer. Cap panel defaults collapsed behind `Show Cap` button. STOP/START commands recorded in `audit_log` with `scope = "plant-cap"`.

In `remote` mode, all `/api/plant-cap/*` routes are proxied to the gateway.

---

## Operator Messaging

Canonical messages stored in `chat_messages` on the gateway (500-row retention). Renderer uses local `/api/chat/*` routes. In `remote` mode the local server polls upstream using monotonic `id` cursors. `read_ts` changes only when the operator opens the thread.

Visible sender identity: `operatorName` plus `Server` or `Remote` only. Chat sound is inbound-only, silent for self-send. Requires shared browser audio context already unlocked by user interaction.

Chat send rate: 10 messages per 60 s per machine, enforced server-side via `_chatRateBuckets`.