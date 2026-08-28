# Plan — Per-Node Firmware Version Comparison (Fleet Homogeneity)

**Date:** 2026-05-19
**Status:** Documented, awaiting implementation sign-off
**Author:** Engr. M. (analysis + implementation assistance: Claude)
**Goal:** Surface and audit the firmware version running on every inverter
node so the operator can confirm the invariant **"all nodes run the same
firmware"**. Mirrors the existing Serial Number Setting / Plant Serial Map
feature, but the pass condition is *uniformity* instead of *uniqueness*.
Firmware must be visible **through the Utility / Calibration Tool** and also
on the dashboard fleet view.

---

## 1. Source-of-Truth Findings

### 1.1 Firmware already rides the FC11 payload — no new Modbus

The firmware strings live in the **same FC11 Report Slave ID payload** the
serial-number feature already reads. `services/vendor_pdu.py`
`parse_fc11_slave_id()` ([L194-L202](../services/vendor_pdu.py)) already
decodes:

| Field | FC11 offset | Example |
|---|---|---|
| `model_code` | `[34:44]` | `AAV1003BA` |
| `firmware_main` | `[70:79]` | `AAS1091AA` |
| `firmware_aux` | `[86:95]` | `AAS1092_F` |

`build/version` bytes at `[44:51]` are parsed-over but **not** exposed on
`SlaveIdInfo` — out of scope (exposing them is the only change that would
need a Python rebuild; deferred).

### 1.2 The data already reaches Node and is dropped

| Layer | State |
|---|---|
| `services/serial_io.py` `read_serial_with_lock` | returns `model_code`/`firmware_main`/`firmware_aux` |
| `services/inverter_engine.py:3402` FastAPI | passes through unfiltered |
| `server/index.js` `_proxySerialRead` | body returned as-is |
| `server/serialNumber.js` `fleetScan()` rows L405-L407 | **already carries all three** |
| `server/serialNumber.js` `setCachedSerial` L155 | drops firmware (serial only) |
| `serial_change_log` (`db.js:1125`) | no firmware columns |
| `_snbRenderFleetTable` (`app.js`) | renders serial only |

**Consequence:** This is a Node + DB + frontend feature. **No PyInstaller
rebuild for the dashboard side** — honours
`feedback_python_release_full_rebuild` (no Python wire change ⇒ no full
rebuild needed).

### 1.3 Calib tool already has the surfaces we need

* `server/calibratorServer.js` (:3600) → `services/calibrator_app.py`
  (:9200), single-transport registry (one inverter at a time).
* `calibrator_app.py` already exposes `GET /firmware/identity/{slave}`
  (FC11 per-node) and `calibratorServer.js` proxies it at
  `GET /api/firmware/identity/{slave}` (public, read-only).
* Calib-tool UI already has a fleet-scan host: `#fcalPanelFleet`,
  `#btnFcalFleetScan`, `#fcalFleetResult` (`.srn-table-host`) in
  `public/index.html:408-425`, and a `card-tabs` framework
  (`#paramTabs`). A firmware panel reuses these — no new modal.

---

## 2. Design Decisions (operator-confirmed 2026-05-19)

| Decision | Choice |
|---|---|
| **Scope** | Both — per-inverter intra-node homogeneity *and* fleet-wide canonical map |
| **Placement** | Both surfaces — dashboard "Firmware Map" tab *and* calib-tool per-inverter Firmware Check |
| **Persistence** | Snapshot + drift log (new tables, mirrors `serial_change_log`) |

### 2.1 Homogeneity model

Define the per-node firmware tuple `FW = (model_code, firmware_main,
firmware_aux)`.

* **Fleet-canonical** = the modal `FW` across all successfully-read nodes
  (operator-overridable — see §2.2).
* **Per-node status:**
  * `ok` — `FW` == canonical.
  * `bad` — `FW` != canonical (drift).
  * `unknown` — node unreadable this scan (transport error).
* **Per-inverter verdict:**
  * `uniform` — every readable slave shares one `FW`.
  * `split` — slaves disagree (the post-board-swap signature; the dual of
    the serial-relocation guard).

### 2.2 Canonical override

Modal value is a heuristic — a fleet uniformly stuck on an old build would
read all-green. Operator can pin an expected `FW` via setting
`firmwareExpectedTuple` (JSON `{model_code,firmware_main,firmware_aux}`);
when set it overrides the modal canonical and every off-tuple node is
`bad`.

### 2.3 One scan, two views (no extra bus traffic)

The dashboard firmware map is a **projection of the existing serial fleet
scan**, never a second Modbus sweep. RS-485 contention is a known sore
point (`FLEET_SCAN_CONCURRENCY` already lowered 8→3). The firmware scan
endpoint internally calls the existing `serialNumber.fleetScan()` and
projects the firmware columns; persistence happens in the same Node pass.

The calib-tool per-inverter check is single-transport and reads only
slaves 1..4 of the *connected* inverter via the existing
`/api/firmware/identity/{slave}` — native to its model, no fleet reach
required.

---

## 3. Work Units

### WU-1 — DB (`server/db.js`)

`inverter_firmware_state` (current snapshot, upserted per scan):

```
inverter_ip TEXT, slave INTEGER, inverter_id INTEGER,
model_code TEXT, firmware_main TEXT, firmware_aux TEXT,
canonical_match INTEGER,            -- 1 ok / 0 drift / NULL unknown
first_seen_ms INTEGER, last_seen_ms INTEGER,
PRIMARY KEY (inverter_ip, slave)
```

`firmware_drift_log` (append on tuple change between scans; mirrors
`serial_change_log` shape):

```
id INTEGER PK AUTOINCREMENT,
inverter_ip TEXT, slave INTEGER, inverter_id INTEGER,
old_tuple TEXT, new_tuple TEXT,     -- "model|main|aux"
detected_at_ms INTEGER, scan_by TEXT,
note TEXT, updated_ts INTEGER
```

Indexes: `idx_ifs_inv (inverter_ip)`, `idx_fdl_inv_ts (inverter_ip,
detected_at_ms DESC)`. Retention: drift log 365 days (operator-tunable
`firmwareDriftLogRetainDays`, default 365), mirrors clock-sync-log policy.

Helpers (Node owns all writes — Python read-only invariant):
`upsertFirmwareState(rows)`, `getFirmwareStateAll()`,
`logFirmwareDrift(row)`, `getFirmwareDriftLog({limit,inverterIp})`,
`pruneFirmwareDriftLog(days)`.

### WU-2 — Pure logic (`server/firmwareMap.js`)

No I/O. Unit-testable. Exports:

* `fwTuple(row) -> "model|main|aux"` (normalised, trimmed, upper).
* `computeCanonical(rows, expected=null) -> {canonical, counts}` (modal,
  or `expected` when pinned; ties broken by lexical order for
  determinism).
* `classifyFleet(rows, expected=null) -> { perNode[], perInverter[],
  summary }` — per-node `ok|bad|unknown`, per-inverter
  `uniform|split|partial`, fleet `homogeneous|drifted`.
* `diffForPersist(prevStateRows, scanRows) -> { upserts[], driftEvents[] }`
  — pure diff feeding WU-1 writes.

### WU-3 — Tests (`server/tests/firmwareMap.test.js`)

Pure, ABI-agnostic (no `better-sqlite3` import — pattern from
`serialBulkMap.test.js`). Cases: modal canonical; pinned-expected
override; intra-inverter split; unknown/partial node; drift diff
(old→new tuple emits one event); empty/all-unknown scan; tie-break
determinism. Target ≥ the 11-check bar of `serialBulkMap.test.js`.

### WU-4 — Node routes (`server/index.js`, `server/serialNumber.js`)

Registered **before** the `/api/serial/:inverter/:slave` catch-all
(route-order caveat from `v210_stop_reasons_serial_number`):

| Route | Auth | Mode |
|---|---|---|
| `GET /api/firmware/state` | public | both (replicated table) |
| `GET /api/firmware/drift-log` | public | both |
| `POST /api/firmware/fleet/scan` | bulk-auth | gateway-only (`_denySerialInRemote` shape) |

`POST /api/firmware/fleet/scan` calls `serialNumber.fleetScan()`,
projects firmware, computes classification (WU-2), persists
(WU-1), returns the classified map. No new Modbus. `_proxyFirmwareState`
not needed — reads hit the replicated SQLite table directly so remote
mode works (mirrors `/api/serial/fleet-cache`).

### WU-5 — Calib tool (`server/calibratorServer.js`)

`GET /api/firmware/check` (public, read-only): loops slaves 1..4 of the
connected inverter via existing Python `/firmware/identity/{slave}`,
returns per-node tuples + intra-inverter `uniform|split` verdict using
the WU-2 classifier. No `calibrator_app.py` change (endpoint already
exists). Calib tool persists nothing (single-transport, ephemeral) —
display only; the dashboard scan owns the audit trail.

### WU-6 — Dashboard UI (`public/js/app.js`, `index.html`, `style.css`)

New "Firmware Map" card-tab in `#serialNumberSection` beside Plant Serial
Map. `_fwmRenderFleetTable` cloned from `_snbRenderFleetTable`:
`.srn-fleet-block` per inverter, fixed `<colgroup>` (slave 70 / model
140 / fw-main 120 / fw-aux 120 / status auto), `ok/warn/bad` pills
(`ok`=canonical, `warn`=split inverter, `bad`=drift), `.srn-fleet-summary`
strip with canonical tuple + drift count, IP-octet sort. "Scan
firmware" (`POST /api/firmware/fleet/scan`, bulk-auth) + "Show last
snapshot" (`GET /api/firmware/state`, public, remote-safe) +
"Drift log" table. Reuse `initCardTabs("serialNumberSection",…)` and
`_snbApplyRemoteUiState` button-disable pattern. Grid-rescue rule
already covered by `#serialNumberSection > .cb-subsection`.

Calib-tool UI: a "Firmware Check" block in the existing `#fcalPanelFleet`
host — per-connected-inverter slaves 1..4 table + `uniform|split`
verdict, calling `GET /api/firmware/check`.

No `<small>`/intro copy — `title=` tooltips only
(`feedback_no_ui_intro_copy`).

### WU-7 — User Guide (`feedback_guide_sync`)

Add a "Firmware Map / Firmware Check" subsection to: User Guide **HTML**
(`docs/`), **Markdown**, regenerate **PDF** via
`scripts/_gen_userguide_pdf.js`. Done before handoff.

---

## 4. Verification (before audit finalize)

1. `node server/tests/firmwareMap.test.js` — new pure suite green.
2. Full node smoke suite — must stay **85/85** (no regression).
3. Python suite — unchanged but run to prove no collateral
   (`vendor_pdu`/`serial_io` untouched).
4. `node --check` on every edited `.js`; `py_compile` sweep.
5. After any Node-ABI smoke: `npm run rebuild:native:electron`
   (`feedback_native_rebuild`) — never leave repo in Node mode.
6. Manual UI smoke: dashboard Firmware Map tab + calib-tool Firmware
   Check render across dark/light/classic.

## 5. Out of Scope

* FC11 `[44:51]` build/version byte exposure (needs Python rebuild).
* Firmware *upgrade* (separate gated feature —
  `project_firmware_feature_status`).
* Auto-remediation of drift (display + audit only; flashing stays the
  manual gated tool).
* TI 32-byte payload firmware offsets (no TI hardware observed).

## 6. Constraints honoured

* No git commit (`feedback_no_auto_commit`).
* Python read-only for SQLite; Node owns all writes.
* Route order: firmware routes before `/api/serial/:inverter/:slave`.
* `git check-ignore` sweep before any handoff so nothing is silently
  excluded.
