# Firmware Upgrade Modal — UI Polish & Correctness Pass

**Date:** 2026-06-01
**Status:** Implemented (frontend + docs); live hardware soak still pending (unchanged from prior firmware work)
**Scope:** `public/index.html`, `public/css/style.css`, `public/js/app.js`, `docs/ADSI-Dashboard-User-Manual.md`, `docs/ADSI-Dashboard-User-Guide.html`, `docs/ADSI-Dashboard-User-Guide.pdf`
**Surface:** Standalone Inverter Calibration Tool only (`body.calibrator-mode`) — the gated Firmware Upgrade dialog (`#fcalFirmwarePanel`).

Follows `audits/2026-05-31/firmware-ism-fidelity-polish.md` (the 4-step wizard
restructure). This pass fixes the visual + behavioural defects the operator
flagged on the rendered wizard and hardens the state machine.

---

## Method

A 6-lens read-only review (CSS/theming, JS state-machine, transport-UX,
a11y, ISM-fidelity/copy, cross-file wiring) was fanned out and each finding
adversarially verified (18/26 confirmed, 8 rejected). Findings were then
implemented by a single writer to avoid parallel-edit conflicts on the three
shared frontend files.

Verification used the project's own Electron/Chromium to render the **real**
markup + **real** `style.css` headlessly (`_spike/fw_render_electron.cjs`),
measure box geometry (`_spike/fw_measure.cjs`), and execute the changed JS in
the real app context (`_spike/fw_console_check.cjs`). `_spike/` is gitignored.

---

## Root-cause bug (app-wide, surfaced here)

**Status-message colours were dead.** `_fcalSetMsg()` writes
`class="smsg smsg-err"` / `smsg-ok`, and ~17 other call sites use
`smsg-err`/`smsg-ok`/`smsg-warn`, but **none of those modifier classes were
defined** in `style.css` (only `.smsg.error` and an unrelated `.smsg-error`
box existed). Every err/ok/warn message therefore fell back to the base
`.smsg { color: var(--green) }` — so the firmware modal's red "Identity read
failed…" rendered **green**, and the same was true across the calibration and
inverter-clock surfaces.

- **Fix:** defined `.smsg-ok` (green), `.smsg-err` (red), `.smsg-warn`
  (orange), `.smsg-info` (muted) in `style.css`, placed after `.smsg.error`
  so they win the cascade. `_fcalSetMsg()` now maps `info`→`smsg-info`
  (neutral) instead of bare green, so a progress line never reads as success.
- **Verified:** computed colour of the identity error is now
  `rgb(232,56,101)` (red); runtime smoke shows `_fcalSetMsg('…','test','err')`
  yields `class="smsg smsg-err"`.

## Step-card clip

The long "connect a transport first" identity message was clipped at the
card's bottom edge on high-DPI/zoomed displays. Cause: `.fcal-fw-step` used
`overflow: hidden` (present only to keep the active header's tinted
background inside the rounded top corners), which also clipped a wrapped
status line.

- **Fix:** removed `overflow:hidden` from `.fcal-fw-step`; rounded the top
  corners of `.fcal-fw-step-head` instead, so the header tint still respects
  the card radius while content can grow freely.
- **Verified:** `getComputedStyle(step2).overflow === "visible"`; the message
  now sits 14px clear of the card bottom.

## Transport dead-end (UX)

Identity read / live flash need an open Modbus transport, which is connected
on the calibration page **behind** the dialog. The modal had no indicator and
failed with a cryptic "connect a transport first".

- **Fix:** added a modal-level **transport-status chip** (`#fwTransportStatus`,
  green=ready / amber=down with an inline **Connect…** shortcut) driven by
  `_fwSyncTransportStatus()` from `FieldCalibrationUI.transportReady`.
  Pre-checks in `_fwReadIdentity` and `_fwStartFlash` now guide the operator
  instead of round-tripping to a failure; a transport-class failure clears the
  optimistic ready flag so the chip re-engages. **Connect…** (`_fwGotoTransport`)
  closes the dialog (never mid-flash) and focuses the transport Connect button.
  Dry-Run is intentionally **not** gated — it is hardware-free.

## State-machine hardening

- **`allow_downgrade` blessing gap (high).** The flag is sent to the live
  flash but wasn't part of the dry-run blessing, so toggling it after a
  dry-run flashed a different mode than was validated. Now stored on dry-run
  success, compared in `_fwSameImage`, and added to the invalidation
  listeners (`fwAllowDowngrade`).
- **Incomplete flash guard (high).** `_fwStartFlash` validated only file+node;
  now re-checks the full `_fwSameImage(p)` (all 5 params) before arming.
- **Stale identity readout.** `_fwInvalidateDryRun` now clears the identity
  box + message, so a changed node/file never shows a prior unit's
  serial/firmware/direction line.
- **Credential reset.** On flash completion the irreversible ack + auth key are
  cleared (defence in depth; a fresh dry-run is already required).
- **`fwNode` invalidates on `input`** (not just blur).

## Accessibility

- `aria-live="polite"` on the three status spans + the flash progress text.
- Focus management: focus moves into the dialog on open (file-path field) and
  is restored to the opener (`#btnFwOpen`) on close.
- **Focus trap**: Tab/Shift+Tab wrap within the dialog (visible-only
  focusables), so focus can't reach the dimmed page during the irreversible
  flow. Escape still closes (never mid-flash).
- Removed conflicting `role="document"` on the inner dialog; `aria-hidden` on
  the decorative backdrop and on the visual step rail (the step-card headers
  already carry state text). Close button now signals the Escape affordance.
- `aria-disabled` kept in sync with the Dry-Run and FLASH disabled states.

## Copy / log polish

- Advanced-parameters row now `flex-wrap: wrap` — "Allow downgrade" was being
  pushed off the right edge of the 680px dialog (body clips overflow-x) and
  was unreachable.
- Flash log renders event detail as compact `k=v` pairs instead of raw
  `JSON.stringify`, and only auto-scrolls when the operator is already at the
  bottom (or the job finished) — a 1.5s poll no longer yanks them off an
  earlier line.
- Removed the stale "exact typed phrase" comment (that gate was retired
  2026-05-19).

---

## Verification summary

| Check | Result |
|---|---|
| `node --check public/js/app.js` | pass (parses) |
| Headless render, dark + light themes | clean; chip, red error, wrapped advanced row, step-4 accent all correct |
| Geometry measure | `overflow:visible`, identity msg red, 14px bottom clearance |
| Runtime smoke (real app, JS executing) | all changed fns execute, `ok:true`; chip `down` + correct text; `_fcalSetMsg` → `smsg smsg-err` |
| Docs | Manual.md + Guide.html updated; Guide.pdf regenerated via `scripts/_gen_userguide_pdf.js` |

No server/Python code touched. Live hardware soak of the flash path remains
the only outstanding item, unchanged by this UI pass.
