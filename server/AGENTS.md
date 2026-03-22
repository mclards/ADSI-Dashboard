# server/AGENTS.md

Server-layer rules for Codex and other coding agents working in `server/`.
Root `AGENTS.md` and `SKILL.md` still apply — this file adds server-specific depth.

---

## Key Files in This Layer

| File | Purpose |
|---|---|
| `index.js` | Express API + WebSocket, replication, remote bridge, plant cap, chat |
| `db.js` | SQLite wrapper, migrations, archive-aware helpers |
| `poller.js` | Inverter polling, PAC integration, energy authority, IP config identity |
| `exporter.js` | CSV/Excel export, forecast export, energy summary |
| `alarms.js` | Alarm decoding, episode tracking |
| `alarmEpisodeCore.js` | Alarm episode and sound eligibility logic |
| `plantCapController.js` | Plant output cap controller (gateway only) |
| `currentDayEnergyCore.js` | Current-day energy computation |
| `mwhHandoffCore.js` | Remote→Gateway MWh handoff logic |
| `todayEnergyHealthCore.js` | Today-energy health checks |
| `bulkControlAuth.js` | Bulk inverter control auth (sacupsMM) |
| `cloudBackup.js` | Cloud backup/restore orchestration |
| `tokenStore.js` | AES-256-GCM encrypted OAuth token storage |
| `ws.js` | WebSocket broadcast, dead connection cleanup |
| `cloudProviders/onedrive.js` | Microsoft Graph API, OAuth PKCE |
| `cloudProviders/gdrive.js` | Google Drive API v3, OAuth flow |
| `cloudProviders/s3.js` | S3 backup provider |

---

## Data Architecture

### Hot/Cold Model

- **Hot DB**: `C:\ProgramData\InverterDashboard\adsi.db`
- **Cold DBs**: `C:\ProgramData\InverterDashboard\archive\<YYYYMM>.db`
- **Hot tables**: `readings`, `energy_5min`
- **Summary tables** (stay in main DB): `daily_report`, `daily_readings_summary`, alarms, audit, forecast, settings
- **Forecast comparison tables**: `forecast_error_compare_daily`, `forecast_error_compare_slot` — written by Python QA persistence, read by error-memory selection

### SQLite Performance Rules

- WAL mode + `synchronous = NORMAL` — do not change to `FULL`.
- Use `bulkInsertWithSummary()` for combined reading + daily summary upserts (single transaction).
- `pruneOldData()` and `archiveTelemetryBeforeCutoff()` must yield event loop between 5,000-row batches via `setImmediate`.
- Routine WAL checkpoints: `PASSIVE` only. `TRUNCATE` only in `closeDb()` at shutdown.
- Long-running operations must yield between batches so the event loop can process WebSocket frames.

### Archive-Aware Helpers

Always use these for date ranges that may cross retention boundaries:
- `queryReadingsRange(All)`
- `queryEnergy5minRange(All)`
- `sumEnergy5minByInverterRange()`

Never add new hot-only SQL scans over `readings` or `energy_5min` for historical workloads.

---

## Current-Day Energy Authority

- Authority path: raw PAC from Python → Node PAC × elapsed time → `energy_5min` → HTTP/WS/UI/export.
- `poller.js` owns current-day energy computation. Do not let Python `/metrics` energy fields override it.
- `TODAY MWh`, `ACTUAL MWh`, and per-inverter `TODAY ENERGY` are PAC-integrated only.
- The gateway poller seeds from persisted `energy_5min` totals plus a live PAC anchor on restart — it does not re-add the full live day counter on top of the persisted baseline.

---

## IP Config Identity Authority

- Telemetry ownership follows IP Config directly — not assumed IP-numbering patterns.
- The inverter service stamps each live frame with `source_ip` and `node_number`.
- `poller.js` resolves inverter identity from configured inverter IP + configured node list before accepting any row.
- Unknown IPs and unconfigured nodes are rejected.
- IP Config wins if a raw frame reports a conflicting inverter number.

---

## Solar Window Persistence Rule

- Raw poll persistence for `readings` and `energy_5min` stays **inside the solar window only**.
- Backend polling continues outside the solar window (dashboard, alarms still update).
- `flushPending()` must also obey the solar-window gate — do not persist off-window raw telemetry during graceful exit.
- Alarm and audit persistence are exempt from this rule.

---

## Alarm Rules

- Sound must not trigger for alarm blips clearing in under 5 seconds.
- If a node's nonzero alarm changes to another nonzero value: update the active row in place, preserve ACK state, do not emit a fresh raise event, do not retrigger sound.
- Use `showAlarmToast()` (not generic `showToast()`) — it renders the inline ACK button.
- Toast TTL: 12 s. After ACK: auto-dismiss after 1.2 s.

---

## Replication Guardrails

- **Manual Pull** = download-only. Local-newer data → stop with `LOCAL_NEWER_PUSH_FAILED`. Never push as side effect. The local-newer check ignores local-only remote-client `settings` drift (gateway URL, token, operation mode) — only replicated operational data counts.
- **Manual Push** = upload-only. Must not pull gateway DB or stage local DB replacement.
- Remote startup auto-sync must stay read-only toward the gateway.
- Archive DB replacement must be restart-safe: stage as temp files, apply only at startup before serving requests.
- Any failed/cancelled pull must discard staged main-DB and archive manifests immediately.
- Never rehydrate hot DB with telemetry older than local hot cutoff — write stale inbound rows directly to archive.
- After a main-DB pull, persist the gateway's `x-main-db-cursors` response header.
- Use chunked push uploads (avoid HTTP `413`). Support HTTP Range resume for archive downloads (3 retries).
- Boost socket pool to `REMOTE_FETCH_MAX_SOCKETS_REPLICATION` (16) during manual pull/push; restore to 8 in try/finally.
- The gateway flushes pending poller telemetry and creates a consistent SQLite snapshot via online backup API before transfer — never streams the live `adsi.db` directly.

---

## MWh Handoff (Remote → Gateway Switch)

- `gatewayHandoffMeta` tracks the in-memory handoff lifecycle: `active`, `startedAt`, `day`, `baselines` (per-inverter shadow kWh at switch time).
- `MAX_SHADOW_AGE_MS = 4h` — stale same-day shadow is discarded unless handoff is active.
- `applyRuntimeMode()` captures per-inverter baselines at switch time and logs handoff start.
- `getTodayEnergySupplementRows()` applies carry/caught-up logic per inverter and calls `_checkHandoffCompletion()`.
- `_checkHandoffCompletion()` auto-completes handoff when all baselines are met and logs elapsed time.
- Core pure logic lives in `mwhHandoffCore.js` — imported by both `index.js` and tests.

---

## Daily Report Strategy

- Past days → prefer persisted `daily_report` rows.
- Use `daily_readings_summary` for inverter/day/unit uptime and PAC rollups.
- Export: one row per inverter per day + one `TOTAL` row. Do not fake plant Peak/Avg PAC by summing inverter values.
- Rebuild past reports only when rows are missing, refresh is requested, or repair is intentional.

---

## Plant Cap Rules

- Plant cap controller runs on **gateway only** — never on remote.
- In `remote` mode, proxy all `/api/plant-cap/*` routes to the gateway.
- While cap monitoring is enabled, non-exempted inverter manual control must be blocked at the API layer.
- Cap STOP/START commands logged in `audit_log` with `scope = "plant-cap"`.
- Do not remove `scope` from `audit_log` — forecast training depends on it.

---

## Remote Mode Bridge

- Adaptive polling: `max(1200, latency×2)` when gateway latency exceeds 400 ms.
- `REMOTE_LIVE_FAILURES_BEFORE_OFFLINE = 6` (10 during sync). Do not lower.
- `REMOTE_LIVE_DEGRADED_GRACE_MS = 60000`. Do not lower.
- `REMOTE_LIVE_STALE_RETENTION_MS = 180000`. Do not lower.
- Gateway `keepAliveTimeout = 30s` (`headersTimeout 35s`) — must stay above client keepAlive (15s).
- `/api/energy/today` fetch inside `pollRemoteLiveOnce()` is fire-and-forget — must not block the bridge tick.
- Switching from `remote` to `gateway` must immediately abort in-flight remote live/chat/today-energy fetches, close the remote live WebSocket, and stop remote chat polling.

---

## Node.js Cron Fallback

Cron jobs in `server/index.js` at **04:30, 18:30, 20:00, and 22:00** check if tomorrow's day-ahead exists in DB and trigger a one-shot ML forecast CLI generation if missing. Safety net when the Python forecast service is not running. Do not remove — it is half of the dual-layer safety net.

---

## Proxy Timeout Rules

Add new proxy route timeouts to the `PROXY_TIMEOUT_RULES` array via `resolveProxyTimeout(method, path)`.
Never use inline if/else timeout logic for proxy routes.

---

## Operator Messaging

- Canonical messages stored on gateway only in `chat_messages` (500-row retention).
- Remote forwards to gateway via local `/api/chat/*` routes.
- Remote inbound uses monotonic `id` cursors. `read_ts` changes only when operator opens the thread.
- Rate limit: `CHAT_RATE_LIMIT_MAX` (10) messages per `CHAT_RATE_LIMIT_WINDOW_MS` (60s) per machine. Do not remove.

---

## Runtime Shutdown Rule

Shutdown path: Electron writes stop files (`IM_SERVICE_STOP_FILE`, `ADSI_SERVICE_STOP_FILE`) → Python services honor stop file and exit cleanly → force-kill only after grace window expires. Do not reintroduce unconditional `taskkill` during restart/update flows.

---

## Test Files in `server/tests/`

| Test | What it guards |
|---|---|
| `smokeGatewayLink.js` | Gateway live WS enrichment, today-energy authority |
| `modeIsolation.test.js` | Remote/gateway mode handoff contract |
| `mwhHandoff.test.js` | Remote→Gateway MWh handoff (24 scenarios) |
| `manualPullGuard.test.js` | Pull stays read-only, local-newer guard |
| `manualPullFailureCleanup.test.js` | Staged files discarded on failed pull |
| `manualReplicationCancel.test.js` | Cancelled pull discards staged state |
| `standbySnapshotReadOnly.test.js` | Standby snapshot stays read-only |
| `remoteTodayShadow.test.js` | Remote today-energy shadow, cross-gateway rejection |
| `serviceSoftStopSource.test.js` | Soft-stop contract for child services |
| `electronUiSmoke.spec.js` | Live Electron UI — run from `server/tests/` only |
| `plantCapController.test.js` | Plant cap controller logic |
| `plantCapManualAuthoritySource.test.js` | Manual control blocked while cap active |
| `alarmEpisodeCore.test.js` | Alarm episode and sound eligibility |
| `bulkControlAuth.test.js` | Bulk inverter control auth key validation |
| `currentDayEnergyCore.test.js` | Current-day energy computation |
| `todayEnergyHealth.test.js` | Today-energy health checks |
| `pollerIpConfigMapping.test.js` | Telemetry ownership follows IP Config |
| `pollerTodayEnergyTotal.test.js` | Poller energy total computation |
| `forecastProviderParity.test.js` | Forecast provider orchestration parity |
| `forecastWatchdogSource.test.js` | Forecast watchdog/cron source check |
| `forecastCompletenessSource.test.js` | Forecast completeness check logic |
| `forecastActualAverageTable.test.js` | Forecast average-table export shaping |
| `dayAheadPlanImplementation.test.js` | Day-ahead provider plan implementation |
| `ipConfigLossDefaultsSource.test.js` | IP config loss defaults |
| `dbPathEnvCompat.test.js` | DB path env-var resolution and fallback |
| `xlsxExportStyling.test.js` | XLSX export styling |
| `scriptsSourceSanity.test.js` | Scripts folder source sanity |
| `cloudBackupForecastData.test.js` | Cloud backup forecast data handling |
| `cloudBackupS3Dedupe.test.js` | S3 backup deduplication |
| `s3Provider.test.js` | S3 provider logic |

Run Playwright smoke from `server/tests/` — not from repo root (avoids `.tmp/` spec discovery).