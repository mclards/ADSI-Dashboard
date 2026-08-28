# Inverter Firmware Upgrade — Feature Audit (Phases 1–4)

Date: 2026-05-18
Status: Phases 1–3 COMPLETE + Phase 4 docs COMPLETE; live hardware soak PENDING operator

Author: Claude (paired with Engr. Clariden Montaño REE)
Decision basis: operator-approved "gated experimental build" 2026-05-18.
Protocol reference: `d:/ADSI-Dashboard/audits/2026-05-18/ism-per-node-firmware-upgrade.md`

---

## 1. Summary

An EXPERIMENTAL, heavily-gated per-node inverter firmware-upgrade feature
was added to the **standalone Inverter Calibration Tool** (never the
fleet dashboard). It is a byte-for-byte faithful port of the decoded ISM
`Cargador`. Flashing is irreversible and brick-capable on a live 997 kW
plant, so it was built in safety-ordered phases, each independently
proven before the next, with **dry-run as the default everywhere**.

As of 2026-05-18 ~13:00, all code + automated proofs are green and the
operator-facing docs are updated. The only remaining step is a
supervised live flash on real hardware (operator-driven).

## 2. Where the code lives

| Layer | File | Role |
|---|---|---|
| Pure core | `d:/ADSI-Dashboard/services/firmware_loader.py` | SREC parse/validate, DSP807/803 flash map, frame builders 0x90/0x91/0x92/0x96, `flash_node` state machine, `MockDSP`, `dry_run`. No I/O. |
| Gated transport | `d:/ADSI-Dashboard/services/firmware_transport.py` | The ONLY module that can hit the wire. `ModbusVendorTcpTransport` (raw MBAP, TCP-only) + `flash_inverter_node()` single choke point enforcing every gate. |
| Python service | `d:/ADSI-Dashboard/services/calibrator_app.py` | Phase 3 endpoints: `/firmware/files`, `/firmware/identity/{slave}`, `/firmware/dryrun`, `/firmware/flash`, `/firmware/job/{id}`, `/firmware/job/{id}/abort`. Carries dry-run blessing + background job + audit. |
| Node proxy | `d:/ADSI-Dashboard/server/calibratorServer.js` | `/api/firmware/*` passthrough. ONLY `POST /api/firmware/flash` is topology-auth gated; dry-run/list/identity/poll/abort are public read-only/fail-safe. |
| UI | `d:/ADSI-Dashboard/public/index.html`, `public/js/app.js`, `public/css/style.css` | "FW Upgrade" button (top-right of the per-node controls row) opens a centred modal dialog; calibrator-mode only via CSS. |
| Tests | `d:/ADSI-Dashboard/services/tests/test_firmware_loader.py`, `services/tests/test_firmware_transport.py` | 56 tests, all green (2026-05-18 13:0x). |
| Docs | `docs/ADSI-Dashboard-User-Manual.md` §6.11, `docs/ADSI-Dashboard-User-Guide.html` §14b, `docs/ADSI-Dashboard-User-Guide.pdf` | Operator workflow + gate list. PDF regenerated via `scripts/_gen_userguide_pdf.js`. |

## 3. Safety model (defence in depth)

Dry-run is the default in every layer. A LIVE flash requires ALL of:

1. Explicit `confirm_irreversible == true` (boolean, not truthy).
2. A prior SUCCESSFUL dry-run of the **same SHA-256** (cross-request
   key `(sha256,node,arg_dsp,frame_len,legacy50)` in `calibrator_app`).
3. EXACTLY ONE link — a TCP host OR a serial COM port (never both,
   never neither). See §3b for the RS485/RTU path. `0x96` baud-bump is
   never emitted on either link, so there is no baud-switch race.
4. Single node 1..247 — broadcast/0 forbidden.
5. Verified file: operator-chosen via the Electron native picker
   (absolute `path`) or legacy bare `file` confined to `_FW_DIR`; in
   both cases `verify_firmware_file` enforces realpath + is-a-regular-
   file + `.S` + size cap + ISM `LLLnnnn` filename rule + SHA-256
   allowlist match. `_fw_resolve(body)` returns the `allowed_dir`
   (None for picker path — endpoints are 127.0.0.1-bound in Electron
   and the path comes from a trusted OS dialog; `_FW_DIR` for `file`).
6. FC11 model/version compatibility; apparent downgrade blocked unless
   `allow_downgrade`.
7. Caller-supplied RS-485 bus lock (the calibrator per-IP
   `threading.Lock` — poller-lockout equivalent).
8. Caller-supplied audit sink + watchdog deadline.

UI friction on top (not a substitute for the server gates): collapsed by
default; live block hidden until dry-run passes; irreversible checkbox;
typed `FLASH <node>` phrase; topology key field; final `confirm()`
restating file/node/SHA; any image/param change invalidates the dry-run.

**Bootloader-preservation invariant** (locked by tests): banks 3
(0xF800-0xFFFF) and 4 (0x0000-0x0003) are loaded but NEVER transmitted,
so a failed/aborted application flash stays re-flashable. Abort is
therefore fail-safe and intentionally NOT auth-gated.

## 3a. Downgrade — verified POSSIBLE

Question raised 2026-05-18: is firmware *downgrade* possible?

**Answer: yes.** Verified against the decoded ISM behaviour in
`audits/2026-05-18/ism-per-node-firmware-upgrade.md` §4 (lines 158-162):
the DSP bootloader and the on-wire `Cargador` protocol enforce **no
version monotonicity** — they erase and write whatever compatible image
is sent, older or newer. ISM's upgrade-vs-downgrade decision is purely an
application-layer policy: `Ingecon.QueHableAhoraOCalleParaSiempre(newCode,
forceDowngrade)` + `IngeconFwUpdateHelper.CheckCanUpgradeFirmware`,
bypassable with ISM's own `forceDowngrade` flag.

Our implementation mirrors this exactly. `verify_inverter_compatible()`
in `services/firmware_transport.py` blocks an apparent downgrade only via
a **conservative software heuristic** — a lexicographic compare of the
FC11 `firmware_main` string vs the filename version trailer — and lifts
it when `allow_downgrade=True` (the **Allow downgrade** checkbox under
the UI's Advanced section → request `allow_downgrade` → orchestrator
`allow_downgrade`). The heuristic does NOT read the embedded
`CodigoFirmware.Version` ISM uses, so it can over- or under-flag; it does
not change what the hardware accepts. The file↔model prefix gate
(`code.startswith(model_key)`) and the SHA-pinned mandatory dry-run still
apply, and bootloader-bank preservation keeps even a mistaken-direction
flash recoverable. No code change was required — the path already exists
and is exercised by `test_downgrade_blocked_unless_forced` in
`services/tests/test_firmware_transport.py`.

## 3b. RS485 / Modbus-RTU path added (2026-05-18 ~15:00)

Operator question: "why TCP-only when RS485-USB is the more direct link?"
— a valid point. TCP-only was a Phase-2 scoping choice, not a protocol
limit (ISM flashes over serial too), and the original "no 0x96
baud-switch race" rationale was already moot because `flash_node` never
emits `0x96`. A gated RS485/RTU path was therefore added:

- `ModbusVendorRtuTransport` (`services/firmware_transport.py`): raw
  Modbus-RTU — ADU = `[node] + frame[1:] + CRC16(le)` (poly 0xA001,
  init 0xFFFF; CRC kept local so the module stays pymodbus-free).
  Same `query()->[node,func,status,…]` contract as the TCP transport, so
  `flash_node` is unchanged. `_serial_factory` test seam (no real
  pyserial in tests); pyserial imported lazily only on hardware. Adds
  `report_slave_id()` — FC11 over RTU → `vendor_pdu.SlaveIdInfo`, so the
  compat/downgrade gate is transport-agnostic.
- `flash_inverter_node` gate now requires EXACTLY ONE of TCP host /
  serial port; serial must inject the RTU transport (caller owns the
  COM settings). TCP path byte-for-byte unchanged.
- `calibrator_app.py`: `TransportRegistry` remembers full serial cfg;
  `release_serial_port()` frees the single COM handle so the firmware
  RTU transport takes **exclusive ownership** for the flash duration
  (serial analogue of the bus-lock). `/firmware/flash` and
  `/firmware/identity` branch tcp/serial; the read-only identity peek
  over serial releases→reads→**restores** the operator's calibrator
  serial client. `_AbortableTransport` generalised to wrap either link.
- UI: warn text updated; the panel uses whichever transport is
  connected (no new control needed — `_registry.get_transport_type()`).
- Net safety unchanged: every other gate (dry-run-first, SHA, FC11
  compat, typed confirm, bus-lock, audit, watchdog, bootloader-bank
  preservation) applies identically on serial. Serial is arguably
  *safer* for firmware (no gateway translation layer, no concurrent
  second TCP socket — the prior open soak item).
- Tests: `_FakeSerial`/`_CannedSerial` loopback ↔ MockDSP; RTU
  round-trip, CRC-mismatch refusal, full state machine over serial,
  FC11 parse, and serial-link gate refusals (no-transport / both-links
  / neither). Suite **66 passed**.

## 4. Validation performed (2026-05-18)

- `python -m pytest services/tests/test_firmware_loader.py
  services/tests/test_firmware_transport.py -q` → **66 passed**
  (56 + first-frame-ordering regression §4a + 9 RS485/RTU + serial-gate
  tests §3b).
- `python -m py_compile` on `calibrator_app.py`, `firmware_transport.py`,
  `firmware_loader.py` → OK.
- `node --check server/calibratorServer.js` and
  `node --check public/js/app.js` → OK.
- `server/tests/calibratorServer.test.js` — first subtest
  (`testCalibrationFilesUnchanged`) PASS; the DB-persistence subtest
  fails ONLY due to the pre-existing better-sqlite3 Electron-vs-Node ABI
  mismatch (NODE_MODULE_VERSION 121 vs 115) — environmental, unrelated to
  the firmware proxy routes (pure HTTP passthrough, no DB).
- Triple agent review (code/python/security) in Phase 1/2 = SHIP/GO,
  brick-safe; HIGH findings fixed and regression-locked.
- Full-feature review incl. RS485 path (2026-05-18 ~16:xx): independent
  code-review = all 7 verification points PASS (frame-at-a-time parity
  TCP/RTU, TCP unchanged, serial release/own/restore lifecycle, abort
  semantics, gate enforcement, end-to-end wiring, concurrency). VERDICT:
  works as intended, hardware-soak-ready. One MED (observability): a
  failed `_restore_serial` was silent → fixed (now logs a clear WARNING
  + a confirmation on successful restore; behaviour unchanged, best-
  effort, never raises). Pre-arm serial-identity failure is now
  non-destructive (releases under bus-lock, restores operator session).

## 4a. Orchestrated verification pass (2026-05-18 ~14:00)

Operator request: "verify everything works as intended; verify that when
using ISM to upgrade, it sends frames at a time."

**Frame-at-a-time: VERIFIED CORRECT.** Cross-checked the ISM decode
(`audits/2026-05-18/ism-per-node-firmware-upgrade.md` §8 steps 3-7)
against `firmware_loader.flash_node` and `ModbusVendorTcpTransport.query`.
The DATA loop sends exactly ONE 0x91 frame, blocks on that frame's
synchronous reply (`transport.query` = sendall + `_recv_exact`), and only
advances on status 0; status 1 resends the SAME frame; per-frame retries
bounded by `num_intentos`. No burst/pipelining. Byte-for-byte faithful to
ISM `modbusQR`-per-trama. START 0x90 + erase wait, END 0x92 global
checksum present and ordered. Independent code-review concurred.

**Two defects found and fixed in this pass:**
1. HIGH (fidelity) — the extra first-data-frame erase-margin wait was
   placed AFTER `transport.query()` (and only on `attempt==0`), so it
   never covered the timeout it exists for. Moved BEFORE the first 0x91
   send in `firmware_loader.py` (matches ISM step 5). Regression-locked
   by `test_first_frame_wait_is_before_first_data_send` (events-order
   assertion). Suite now **57 passed**.
2. MED (hygiene) — `_fw_jobs` grew unbounded. Added `_fw_prune_jobs()`
   (TTL `_FW_JOB_TTL_S=3600`, cap `_FW_JOB_MAX=64`, running jobs never
   evicted), called before each new job in `api_firmware_flash`.

Security review of the Phase 3 wiring + file-picker change = SHIP after
the job-cleanup fix (now applied); `allowed_dir=None` for the native
picker path judged acceptable (127.0.0.1-bound, trusted OS dialog,
verify_firmware_file still enforces realpath/.S/size/LLLnnnn/SHA + the
dry-run/compat/typed-confirm/topology-auth chain).

## 5. NOT done / out of scope / next

- **Live hardware soak**: a supervised real flash on one inverter has
  NOT been performed — requires operator go-ahead and a maintenance
  window. The dry-run path is fully exercised hardware-free.
- Concurrent-socket note: identity FC11 read uses the calibrator
  pymodbus client while `flash_inverter_node` opens its own
  `ModbusVendorTcpTransport` socket to the same `ip:502` through the
  transparent gateway. The bus lock serialises calibrator traffic, but
  whether the gateway tolerates the second concurrent TCP connection
  during a real flash is a Phase-soak verification item.
- Not ISM-parity: no embedded-code version scan (downgrade heuristic
  uses FC11 string vs filename trailer, conservative).

## 6. Cross-references

- Decoded protocol: `d:/ADSI-Dashboard/audits/2026-05-18/ism-per-node-firmware-upgrade.md`
- Memory: `project_firmware_feature_status`, `project_ism_firmware_upgrade_protocol`
- Reusable IL tooling (gitignored): `d:/ADSI-Dashboard/_spike/ism_load.ps1`, `_spike/ism_il.ps1`
