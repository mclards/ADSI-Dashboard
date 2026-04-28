# CLAUDE.md

This file exists as a fallback in case `SKILL.md` is not consumed automatically.
**Read `SKILL.md` first** — it is the canonical codebase reference for this project.

Skill locations:
- `d:\ADSI-Dashboard\SKILL.md` (repo root)
- `.agents/skills/adsi-dashboard/SKILL.md` (Codex)
- `.claude/skills/adsi-dashboard/SKILL.md` (Claude Code)

Behavioral rules and constraints live in `CLAUDE.md` (this file) and `AGENTS.md`.
Detailed history and working notes live in `MEMORY.md`.

---

## Project Snapshot

| Field | Value |
|---|---|
| Product | ADSI Inverter Dashboard |
| Author | Engr. Clariden Montaño REE (Engr. M.) |
| Package | `inverter-dashboard` |
| Updater app ID | `com.engr-m.inverter-dashboard` — do not rename |
| Repo version baseline | `2.10.2` in `package.json` (source of truth) |
| Deployed server version | `2.2.32` (may legitimately lag) |
| Latest published release | `v2.10.2` |
| GitHub release channel | `mclards/ADSI-Dashboard` |

---

## Default Credentials and Access Keys

*(Internal only — do not mirror into public docs.)*

| Key | Value / Pattern |
|---|---|
| Login username | `admin` |
| Login password | `1234` |
| Admin auth key | `ADSI-2026` (resets to `admin` / `1234`) |
| Bulk inverter control | `sacupsMM` (MM = current minute ±1) |
| Topology / IP Config auth | `adsiM` or `adsiMM` |
| IP Config session | 1 hour |
| Topology session | 10 minutes |

No built-in defaults for: remote gateway API token, Solcast credentials, cloud-backup OAuth.
Live secrets go only in git-ignored `private/*.md`.

---

## Forecast Day-Ahead Generation Architecture (v2.4.31+)

All four generation paths route through the same Node orchestrator (`runDayAheadGenerationPlan`). Provider routing and Solcast freshness decisions are always made by Node. Python owns ML execution only.

| Path | Trigger | Audit |
|---|---|---|
| Manual UI | `POST /api/forecast/generate` | Node |
| Auto scheduler | Python loop → `_delegate_run_dayahead()` | Node |
| Python CLI | `--generate-date` → `_delegate_run_dayahead()` | Node |
| Python CLI fallback | Node unreachable, direct `run_dayahead(write_audit=True)` | Python |
| Node cron | 04:30/09:30/18:30/20:00/22:00, quality-aware | Node |

`_delegate_run_dayahead()` uses `ADSI_SERVER_PORT` (default 3500). Node cron classifies tomorrow quality (`missing`/`incomplete`/`wrong_provider`/`stale_input`/`weak_quality`/`healthy`) — only `healthy` suppresses regeneration.

---

## Solcast Reliability Dimensions (v2.4.33+)

`build_solcast_reliability_artifact()` produces a multi-dimensional trust profile at 5-min slot resolution:

| Dimension | Artifact Key | Effect |
|---|---|---|
| Weather regime | `regimes` (clear/mixed/overcast/rainy) | Per-regime bias_ratio + reliability |
| Season | `seasons` (dry/wet), `season_regimes` (dry:clear, etc.) | Season-aware lookup in `lookup_solcast_reliability()` |
| Time-of-day | `time_of_day` (morning/midday/afternoon), `time_of_day_by_regime` | Per-slot blend and floor modulation |
| Trend | `trend` (improving/stable/degrading) | Blend ±6-8%, residual damping adjustment |

All lookups have backward-compatible fallbacks — old artifacts without new keys load safely.

---

## Forecast Performance Monitor (v2.4.42)

`/api/forecast/engine-health` returns extended diagnostics including `mlBackend`, `trainingSummary`,
and `dataQualityFlags`. The Forecast Performance Monitor panel defaults to collapsed on first load.

New Python helpers:
- `_detect_ml_backend()` — identifies active LightGBM vs sklearn
- `_collect_data_quality_warnings()` — audits stale features, low sample count, regime imbalance

`ml_train_state.json` extended fields: `ml_backend_type`, `model_file_path`, `model_file_mtime_ms`,
`training_samples_count`, `training_features_count`, `training_regimes_count`, `training_result`,
`last_training_date`, `data_warnings`.

---

## Solcast Tri-Band LightGBM Features (v2.5.0+)

`solcast_prior_from_snapshot()` exposes Solcast P10/Lo and P90/Hi percentiles. `build_features()` derives 6 tri-band features:
`solcast_lo_kwh`, `solcast_hi_kwh`, `solcast_lo_vs_physics`, `solcast_hi_vs_physics`, `solcast_spread_pct`, `solcast_spread_ratio`.

FEATURE_COLS: 62 → 70. Legacy models auto-align with zero-spread fallback. P10/P90 available only from Solcast Toolkit for future-dated requests.
LightGBM hyperparams tuned: n_estimators=650, learning_rate=0.040, max_depth=8, num_leaves=71, subsample=0.78, colsample_bytree=0.75, min_child_samples=22, reg_alpha=0.08, reg_lambda=0.12.

See `references/forecast-engine.md` for full feature formulas, training details, and backward-compatibility rules.

---

## Power-Loss Resilience (v2.8.11+)

See `audits/2026-04-17/README.md`, `audits/2026-04-17/integrity-gate-asar-virtualization.md`,
and `plans/2026-04-17-power-loss-resilience.md` for full rationale. Short version:

- **v2.8.11 hotfix**: `electron/integrityGate.js` now uses `original-fs`
  (Electron built-in) instead of stock `fs`. Required because Electron's
  fs shim reports packaged `app.asar` as a directory with `size: 0`,
  which falsely tripped the "suspiciously small" check on every launch
  of v2.8.10. A defensive `isDirectory()` guard also degrades to
  `mode=skipped` if a future change breaks the original-fs resolution.
  Regression test: `testElectronAsarShimSimulation` in
  `server/tests/crashRecovery.test.js`.
- `electron/main.js` top-of-file block is the "survival boot" — Node+Electron
  core requires only, hoisted `uncaughtException` handler, `safeRequire()`
  wrapper for every third-party module, and an `app.asar` integrity gate
  via `electron/integrityGate.js` (SHA-512 sidecar manifest).
- `electron/recoveryDialog.js` shows a branded "Dashboard files are damaged"
  modal with `Reinstall Now` that spawns
  `C:\ProgramData\InverterDashboard\updates\last-good-installer.exe` silently.
- The stash is seeded by NSIS `customInstall` (`scripts/installer.nsh`) at
  first install, and refreshed after every signed auto-update by
  `stashLastGoodInstaller()` in main.js.
- `app.asar.sha512` is written by `scripts/afterPack.js` during
  electron-builder's afterPack phase.
- `server/db.js` runs a pre-open readonly probe; if `quick_check` fails, it
  auto-restores from the newer of the two rotating backups under
  `backups/adsi_backup_{0,1}.db`, quarantines the corrupt file, emits an
  `audit_log` row, and sets `startupIntegrityResult.restored = true`.
- `GET /api/health/db-integrity` exposes the snapshot. Renderer shows a red
  banner via `checkBootIntegrityBanner()` in `public/js/app.js`.
- Tests: `server/tests/crashRecovery.test.js` covers integrity gate + auto-
  restore under the Node-ABI smoke harness.

Do NOT remove the `app.asar.sha512` sidecar, the stash path, or the hoisted
`uncaughtException` handler — they are the chain that converts a torn-write
into a 60-second recovery.

---

## Hardware Counter Recovery + Clock Sync (v2.9.0)

See `plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md` for the
full spec and `audits/2026-04-24/counter-integrity/` for scan evidence.

- Python engine reads **60 input registers** (was 26) via `read_fast_async()`
  in [services/inverter_engine.py](services/inverter_engine.py), capturing
  Etotal@0-1, parcE@58-59, full 32-bit alarm@6-7, Fac@19.
- On restart, `kwh_today` per unit is seeded via
  `seed_pac_from_baseline()` from `(current_Etotal − midnight_baseline)`,
  with health-gate hierarchy: `trust_etotal` → `trust_parce` → zero.
  Controlled via `DISABLE_COUNTER_RECOVERY=1` env var.
- Inverter clocks are broadcast-synced daily at the `inverterClockAutoSyncAt`
  setting (default **04:25**, stagger before the 04:30 day-ahead regen).
  Drift > 1 h and RTC year-out-of-band (2047 pattern) trigger immediate sync.
- **Slice D clock-sync transport — template-gate retired in v2.9.0**:
  Wireshark capture of ISM's `Isla::Sincronizar` (`docs/capture-file.pcapng`,
  frame #8017) confirmed the on-wire protocol is plain Modbus FC16 (Write
  Multiple Registers) broadcast to unit 0, address 0, six UINT16s
  `[year, month, day, hour, minute, second]`. No vendor function code, no
  19-byte template — `sync_clock()` uses pymodbus' built-in
  `write_registers` directly (see `services/inverter_engine.py` ~line 1714
  for the design note). The earlier template-gate from
  `plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md` §9.2 D1
  is no longer required and the `isla-sincronizar-frame.bin` artifact does
  not need to exist.
- New tables in [server/db.js](server/db.js): `inverter_counter_state`,
  `inverter_counter_baseline`, `inverter_clock_sync_log`. Counter helpers
  live alongside in `persistCounterState`, `getCounterBaselinesForDate`,
  `getCounterStateAll`, `insertClockSyncLogRow`. Retention: baseline 90 days,
  clock-sync log 365 days (operator-tunable).
- Health-gate pure functions: [server/counterHealth.js](server/counterHealth.js)
  + matching Python helpers in `services/inverter_engine.py` (`rtc_year_valid`,
  `counter_advancing`, `parce_precision_ok`, `trust_etotal`, `trust_parce`,
  `classifyCounter`).
- New endpoints in [server/index.js](server/index.js):
  - `GET  /api/counter-baseline/:date_key`  (localhost-internal for Python engine)
  - `POST /api/audit/counter-recovery`      (system audit writes)
  - `GET  /api/counter-state/all`           (topology auth — admin UI feed)
  - `GET  /api/counter-state/summary`       (unauthenticated — top-bar chip)
  - `GET  /api/clock-sync-log`              (topology auth)
  - `POST /api/sync-clock/:inv/:unit`       (bulk auth — operator)
  - `POST /api/sync-clock/broadcast`        (bulk auth — operator)
  - `POST /api/sync-clock-internal`         (loopback only — Python triggers)
  - `POST /api/sync-clock/inverter/:inverter` (no operator auth — per-inverter daisy-chain broadcast; client auto-derives `sacupsMM` and Node injects upstream)
  - `GET  /admin/inverter-clock`            (topology-gated admin page)
- Export enhancement: [server/exporter.js](server/exporter.js)
  `exportInverterData` accepts `includeEtotal` / `includeParce` / `showQuarantine`
  payload flags. Adds columns `Etotal_kWh`, `parcE_kWh`, `Counter_Source`,
  `Etotal_Quarantined`, `Quarantine_Reason`. PAC-integrated `Energy_kWh`
  stays authoritative — hardware counters are reconciliation aids.
- UI: top-bar chip in [public/index.html](public/index.html) + 30-s polling
  in [public/js/app.js](public/js/app.js). The admin surface lives in
  **Settings → Inverter Clocks** (`#inverterClockSection`) — themed with
  the project's `--accent`/`--green`/`--orange`/`--red` token system.
  The old `/admin/inverter-clock` URL redirects to the settings deep link.
- Settings keys: `inverterClockAutoSyncEnabled` (default "1"),
  `inverterClockAutoSyncAt` (default "04:25"),
  `inverterClockDriftThresholdS` (default 3600),
  `counterBaselineRetainDays` (default 90),
  `clockSyncLogRetainDays` (default 365).
- Tests: `services/tests/test_read_fast_async.py`,
  `services/tests/test_counter_health.py`,
  `services/tests/test_sync_clock.py`,
  `server/tests/counterHealth.test.js`.

INVARIANT: PAC integration stays authoritative while the dashboard is up.
Hardware counters are used for crash-recovery seeding, export reconciliation,
and quarantine detection only — they never overwrite a running PAC value.

---

All other reference knowledge — architecture, data model, replication, forecast engine,
UI patterns, storage paths, build commands, smoke sequences — is in `SKILL.md`.
Do not duplicate it here.
