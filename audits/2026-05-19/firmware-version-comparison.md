# Per-Node Firmware Version Comparison — Feature Audit

Date: 2026-05-19
Status: Backend + UI + docs COMPLETE; verification green; independent
        code-review = SHIP, security-review = PASS. NO git commit
        (no-auto-commit). Live-fleet operator smoke PENDING.
Author: Claude (paired with Engr. Clariden Montaño REE)
Plan: `d:/ADSI-Dashboard/plans/2026-05-19-firmware-version-comparison.md`
Decision basis: operator-confirmed 2026-05-19 — scope=both,
        placement=both surfaces, persistence=snapshot+drift log.

---

## 1. Summary

The operator invariant **"every inverter node runs the same firmware"** is
now auditable. Firmware strings (`model_code`, `firmware_main`,
`firmware_aux`) ride the SAME FC11 Report-Slave-ID payload the existing
serial-number feature already reads — verified in
`d:/ADSI-Dashboard/services/vendor_pdu.py` `parse_fc11_slave_id()`
(offsets [34:44]/[70:79]/[86:95]) and already returned by
`serialNumber.fleetScan()` rows. The feature is therefore a **projection
of the existing serial fleet scan** plus persistence + UI. **No new
Modbus, no Python wire change → no PyInstaller rebuild required** for the
dashboard side.

It is the mirror image of the serial feature: serials must be UNIQUE per
node; firmware must be UNIFORM across nodes. A within-inverter `split` is
the firmware-side dual of the serial relocation guard (post-board-swap
signature).

## 2. What shipped

| Layer | File | Change |
|---|---|---|
| DB | `server/db.js` (~L1144) | `inverter_firmware_state` (snapshot, PK (ip,slave)) + `firmware_drift_log` (append-on-change) + indexes, after the `serial_change_log` block |
| Logic | `server/firmwareMap.js` (NEW) | PURE: `fwTuple`/`parseExpectedTuple`/`computeCanonical`/`classifyFleet`/`diffForPersist`; persistence helpers (db-handle injected, mirrors serialNumber.js): `upsertFirmwareState`/`logFirmwareDrift`/`getFirmwareStateAll`/`getFirmwareDriftLog`/`pruneFirmwareDriftLog` |
| Tests | `server/tests/firmwareMap.test.js` (NEW) | 14 pure checks, ABI-agnostic (no better-sqlite3 import), mirrors `serialBulkMap.test.js` |
| Routes | `server/index.js` | `require("./firmwareMap")`; `GET /api/firmware/state` (public, replicated read), `GET /api/firmware/drift-log` (public), `POST /api/firmware/fleet/scan` (`express.json`+`_proxySerialInRemote`+`_requireBulkAuth`, gateway-only) — reuses `serialNumber.fleetScan` then projects/classifies/persists |
| Calib tool | `server/calibratorServer.js` | `GET /api/firmware/check` (public, single-transport: loops slaves 1..4 of the connected inverter via existing Python `/firmware/identity/{slave}`, classifies, persists nothing) |
| UI | `public/index.html`, `public/js/app.js` | 4th card-tab "Firmware Map" in `#serialNumberSection`; `_fwmHandleScan`/`_fwmHandleLoadState`/`_fwmHandleDriftLog`/`_fwmRenderClassified`/`_fwmVerdictPill`; wired in `initSerialNumberSection`; `btnFwmScan` added to `_snbApplyRemoteUiState` remote-disable list; reuses existing `srn-*` CSS (no new CSS) |
| Docs | `docs/ADSI-Dashboard-User-Manual.md`, `…-User-Guide.html`, `…-User-Guide.pdf` | Firmware Map subsection (controls, verdict pills, canonical/pin, field check); PDF regenerated via `scripts/_gen_userguide_pdf.js` |

## 3. Classification model

- `FW = (model_code|firmware_main|firmware_aux)`, normalised trim+upper.
- **Canonical** = modal `FW` across OK non-empty rows; deterministic
  lexical tie-break; **operator-pinned** `firmwareExpectedTuple` setting
  overrides outright (defends a fleet uniformly stuck on an old build).
- Per-node: `ok` (==canonical) / `bad` (drift) / `unknown` (unread).
- Per-inverter: `uniform` / `split` (nodes disagree — board swap) /
  `partial` (a node unread) / `none`.
- Drift logged ONLY on a real tuple change of a previously-seen node;
  first sightings and unknown reads never log; an unknown read never
  clobbers a good snapshot.

## 4. Verification (run 2026-05-19, ~14:30–14:55 GMT+8)

| Gate | Result |
|---|---|
| `node server/tests/firmwareMap.test.js` | **14/14 green** |
| `node --check` (db.js, index.js, firmwareMap.js, calibratorServer.js, app.js) | all clean |
| `npm run smoke` (authoritative — node-ABI rebuild → node tests → pytest → electron-ABI rebuild) | **Node 85/86**, **Python 432/432**, final `rebuild:native:electron` exit 0 |
| Lone node failure `manualPullGuard.test.js` | **Proven pre-existing** — stashed ALL feature changes, ran on pristine HEAD: fails *identically* at `new Database()` `NODE_MODULE_VERSION 121 vs 115` (`server/db.js:571`), a post-release Electron-ABI environment flake unrelated to this feature. Stash cleanly popped. |
| Python collateral | 432/432 — `vendor_pdu`/`serial_io` untouched, no regression |
| Independent code-review (everything-claude-code:code-reviewer) | **SHIP** — no issues; architecture rule (Python read-only / Node owns writes) respected; persistence atomic; error-isolated (persist failure never sinks the live scan result) |
| Independent security-review (everything-claude-code:security-reviewer) | **PASS** — no SQLi (parameterised + clamped), public reads same exposure class as already-public serial cache, scan auth equivalent to sibling serial scan, no Modbus write path, slaves param int/range-validated |

Repo correctly left in **Electron ABI** (smoke's final rebuild step,
authoritative per `project_better_sqlite3_napi_abi_stable`; honours
`feedback_native_rebuild`).

## 5. Invariants / constraints honoured

- Python read-only for SQLite; Node owns all `inverter_firmware_state` /
  `firmware_drift_log` writes.
- No new Modbus / no wire protocol change → dashboard side needs no full
  Python rebuild.
- Firmware routes do not collide with `/api/serial/:inverter/:slave`
  (distinct `/api/firmware/*` namespace; index.js has no prior
  `/api/firmware/*`).
- Public reads work in remote mode off replicated tables; the scan is
  gateway-only via `_proxySerialInRemote`.
- One scan, two views — firmware map never issues a second Modbus sweep
  (RS-485 contention guard).
- No `<small>`/intro copy (title= tooltips only); User Guide HTML+MD+PDF
  synced before handoff; no git commit (operator reviews).

## 5b. Protocol verification + scope correction (2026-05-19, later same day)

Two operator corrections after first review:

1. **Per-inverter only (not plant-wide).** The displayed comparison judges
   each inverter against ITS OWN nodes; no fleet canonical / no
   `firmwareExpectedTuple` in the UI. `_fwmInvAnalysis` (app.js) computes
   the inverter-local majority. Server `classifyFleet` canonical code is
   retained but UI-dead.

2. **`firmware_aux` is NOT the display firmware — VERIFIED by ISM
   decompile.** Using the gitignored 32-bit IL tooling
   (`_spike/ism_il.ps1`), decompiled
   `FV.IngeBLL.Maquinas.Ingecones.Ingecon::Identifica` →
   `FV.IngeBLL.Base.Modbus.SlaveID.IngeconModbusSlaveID(+_Freescale)`
   (artifacts: `_spike/ism_identifica.txt`, `_spike/ism_slaveid2.txt`).
   Findings:
   - `IngeconModbusSlaveID` exposes `Firmware`, `FirmwareDisplay`,
     `FirmwareBoot`, `FirmwareBootDisplay`.
   - **`IngeconModbusSlaveID_Freescale::SetData` (our Motorola fleet) sets
     ONLY `NumSerie` (`GetStringFromData(data,5,12)`) and `Firmware`
     (`GetStringFromData(data,17,10)`).** It never calls
     `set_FirmwareDisplay`/`set_FirmwareBoot` — the display firmware is
     NOT in the Freescale FC11 slave-ID payload.
   - `GetStringFromData` = collect bytes > 0x20 in `[off,off+len)`, ASCII,
     trim.
   - Therefore the single authoritative firmware = the `AAV1003xx` code
     (our `model_code`), matching the `AAV1003…_InverterFirmware.S`
     upgrade image and the `400152914R81.INGECONsettings`
     "firmware AAV1003BA". The `AAS…` strings at our [70:79]/[86:95]
     (`firmware_main`/`firmware_aux`) are unverified auxiliary identifiers
     ISM does not read as firmware.

   **Resulting change:** `fwTuple()` now returns `model_code` ONLY.
   `firmware_main`/`firmware_aux` stay in the DB + UI as **diagnostics
   only** ("Aux ID 1/2", de-emphasised, never compared, never drift). The
   highlighted/compared cell is now **Firmware** (model_code). This fixes
   the operator's screenshot where a uniform `AAV1003BC` fleet was
   falsely flagged purely on blank/variant `AAS` bytes. `firmwareMap`
   test suite rewritten → **15/15**, incl. explicit "aux-only change is
   NOT drift / NOT split". Full `npm run smoke`: **Node 86/86, Python
   432/432**. User Guide MD/HTML/PDF re-synced.

## 6. Out of scope / follow-ups

- FC11 `[44:51]` build/version byte exposure (would need a Python
  rebuild — deferred; `firmware_main`/`firmware_aux` suffice for
  homogeneity).
- Firmware *upgrade* remains the separate gated tool
  (`project_firmware_feature_status`); this feature is display+audit only.
- TI 32-byte payload firmware offsets (no TI hardware observed).
- **Live-fleet operator smoke pending**: a real `Scan firmware` against
  the 27-inverter plant + a calib-tool `Firmware Check` on a connected
  unit, across dark/light/classic themes.
