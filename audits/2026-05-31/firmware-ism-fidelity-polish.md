# Firmware Upgrade — ISM Fidelity Audit & Polish

**Date:** 2026-05-31
**Status:** Complete — code + tests + docs done; live hardware soak still pending (no real flash performed)
**Scope:** Verify the Utility Tool (standalone Inverter Calibration Tool)
firmware-upgrade feature replicates INGECON SUN Manager (ISM) "precisely and
gracefully", and polish the confirmed divergences.
**Author:** Polish/verify session (Claude, Opus 4.8)
**Ground truth:** `audits/2026-05-18/ism-per-node-firmware-upgrade.md` +
fresh ISM .NET IL decode (this session) of
`FreescaleDSP56F.VerificaFicheroFirmware`, `DSP807/DSP803
get_PosicionDelCodigoFirmwareEnFichero`, `Utiles.InvierteEndianness /
String2HexString / HexString2String`, `CodigoFirmware.RemoveIJKcode`.

---

## 1. Method

A 6-dimension adversarial verification workflow (62 agents) reviewed the
whole stack against the decoded ISM spec, then refuted each candidate
finding against the live code (10 confirmed-actionable of 55 candidates).
Core brick-safety invariants were **independently re-verified by hand**
against the real image `docs/AAV1003IJK01BC_InverterFirmware.S`:

- **Bootloader preservation** — the real `.S` populates the boot bank
  (`bank[3]` 0xF800-0xFFFF, 1532 words), but ISM's frame-count math
  (`pflash + pflash2 + xflash` = banks 1,2,0 only) excludes banks 3 & 4.
  `build_all_frames` emits 119 frames (117 data + start + end) carrying
  **zero** boot/reset words → an aborted flash stays re-flashable. ✔
- **Pipeline fidelity** — `dry_run` reconstructs banks 0/1/2 **byte-identical**
  to the source image, the END-frame global checksum agrees, and the boot
  bank is never written on the receiver. ✔

## 2. Confirmed divergences & fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | correctness | `verify_inverter_compatible` compared `firmware_main` (FC11 `AAS…` aux, usually blank) vs the `AAV…` filename code — different namespaces, so the downgrade guard never fired (dead code; masked by an unrealistic test mock). | Compare the **authoritative `model_code`** (`AAV1003xx`) version trailer vs the file's. `services/firmware_transport.py`. |
| 2 | correctness | ISM's `VerificaFicheroFirmware` embedded-code-vs-filename guard was absent (the primary anti-"wrong file"/rename protection). | Ported it. `services/firmware_loader.py` `verify_embedded_firmware_code()`; wired into `flash_inverter_node` (both modes). |
| 3 | correctness | No post-flash re-identify (ISM `Identifica` after each flash). | Best-effort, read-only FC11 re-read in `_fw_live_worker`; emits `firmware.live.verify_ok/_warn`; never flips the flash result. |
| 4 | ux | 0x90 status-1/2 messages diverged from ISM wording. | Lead with ISM-verbatim "Firmware load start (0x90) error code N", keep the actionable guidance. |
| 5 | ux | ISM `QueHableAhoraOCalleParaSiempre` upgrade/downgrade advisory not surfaced. | `firmware_upgrade_direction()` + `firmware.pre_flash.direction` audit event; client cue in Read-Identity readout. |
| 6 | ux | Modal X/backdrop not guarded mid-flash (only Escape was). | `_fwClose()` now refuses while `_fwState.jobId` is set. |
| 7 | ux | Arm block (auth/ack/FLASH) not reset when a job finishes. | `_fwPollJob` calls `_fwInvalidateDryRun()` on `done` (also clears the lingering dry-run box → finding #8). |
| 9 | cosmetic | Auth field not focused when the arm block appears. | Focus+select `#fwAuthKey` on dry-run success. |

(Workflow findings `file-verification-complete` and `embedded-firmware-code-cross-check-missing` were the two views of the same gap, resolved by #2. Finding #8 is folded into #7.)

## 3. The embedded-code guard (ISM `VerificaFicheroFirmware`) — decoded, not invented

The base `FreescaleDSP56F.get_PosicionDelCodigoFirmwareEnFichero()` throws
`NotImplementedException`; the constant lives in the subclass overrides:

- **DSP807** (`arg_dsp ∈ {1,6}`): S-record line at byte-address **0x00202000**
  → marker string `"S35100202000"`.
- **DSP803**: 0x00201000 → `"S35100201000"`.

Algorithm: `code = RemoveIJKcode(filename)` (`AAV1003IJK01BC → AAV1003BC`),
length-normalize to 10 (pad a trailing space), `InvierteEndianness` (swap
adjacent char pairs), `String2HexString` → expected 20-hex; on the marker
line assert the first 8 bytes (`loc5`) are present and byte 9 (`loc6`,
byte 8 = pad, skipped) matches; else **"Invalid firmware"**.

Validated against the real image: its 0x202000 line carries
`41413156303042332043` = endian-inverted ASCII of `"AAV1003BC "`. The port
**passes** the known-good file and **rejects** a copy renamed `…IJK01ZZ…`.

## 4. Validation

- `python -m pytest services/tests/test_firmware_*.py
  services/tests/test_calibrator_flash_route_guard.py
  services/tests/test_poll_firmware_guard_order.py` → **84 passed**
  (was 79; +5 new: embedded-code real-pass / rename-reject /
  orchestrator-reject, downgrade-ignores-aux, direction-classifier).
- `node --check public/js/app.js`, `node --check server/calibratorServer.js`,
  `py_compile` of all changed Python → clean.
- User Guide HTML + Manual MD updated; PDF regenerated
  (`scripts/_gen_userguide_pdf.js`).

## 5. DO NOT TOUCH (frozen byte-for-byte ISM ports)

`firmware_loader.py`: `valida_linea_de_sfile`, `build_flash_map`,
`rellena_datos_flash` (the `addr > 0x200000` X-flash boundary),
`calcula_cantidad_tramas`, `avanza_flash`, `crear_trama_0x90/91/92`,
`xor_checksum`, `calculo_checksum_global`, `build_all_frames`, and the
`flash_node` ACK/NACK/err2/err3 + sleep sequence. The deliberate `0x96`
omission (TCP has no baud; RTU runs at fixed bus baud) stays.

## 5b. UI overhaul — guided stepper (2026-05-31, operator-requested)

The Firmware Upgrade dialog was rebuilt as a **guided 4-step wizard**
(operator chose this over a compact single-column or two-pane layout) to be
lighter, friendlier, and cleaner:

- Restructured `#fcalFirmwarePanel` into a progress rail + four step cards
  (`File → Target → Dry-run → Flash`), each with a number badge, title, and a
  done / current / locked status chip. Dialog narrowed 960px → 680px. All
  existing element IDs preserved (no JS/route churn).
- `public/js/app.js`: `_fwUpdateStepUI()` / `_fwSetStep()` / `_fwSameImage()` /
  `_fwHideArm()` drive a single-active progression — later steps stay locked
  (dimmed + `pointer-events:none`) until their prerequisite is met; a completed
  flash shows all-done; `_fwState.lastFlashOk` tracks the terminal state.
- The verbose "Before you flash" wall-of-text became a collapsed `<details>`
  checklist (honors the no-prose-in-UI preference); one slim irreversible
  warning kept.
- Themed entirely with the project's `--accent/--green/--red/--border` tokens;
  verified by headless render across **dark + light** in initial (locked) and
  mid-flow states.
- **Latent bug fixed (pre-existing):** `.fcal-fw-arm` / `.fcal-fw-progress-wrap`
  set `display:flex`, which (author origin) beat the UA `[hidden]{display:none}`
  — so toggling the `hidden` attribute never actually hid the arm block or
  progress bar (they showed even before any dry-run). Added the project-idiom
  `.fcal-fw-*[hidden]{display:none!important}` override (cf.
  `.apc-progress-wrap[hidden]`). Caught only by the render check, not by tests.

Docs updated (Manual MD + Guide HTML + PDF) with the 4-step-wizard framing.

## 6. Fidelity verdict

The feature now replicates ISM's firmware-upgrade workflow precisely
(frame protocol, embedded-code guard, version/downgrade policy, pre/post
advisories) and gracefully (staged friction, honest reset, always-reachable
abort, un-closable mid-flash). No invented constants — the one missing ISM
constant (the embedded-code flash position) was decoded from the vendor IL
and proven against the real image. Live hardware soak remains the only
open item. No git commit (no-auto-commit rule).
