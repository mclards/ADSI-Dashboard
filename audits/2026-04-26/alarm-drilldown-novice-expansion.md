# Alarm Drilldown — Novice-Operator Expansion

**Date:** 2026-04-26
**Status:** Implemented — release-ready; PDF/installer rebuild deferred to next release cut.
**Scope:** Full rewrite of the per-bit content shown in the alarm drilldown
modal (16 alarm bits), driven by operator feedback that *"some operators are
not that good in troubleshooting."*

---

## Motivation

Existing drilldown cards exposed a terse `actionSteps` list (4–7 items) plus a
short `physicalDevices` array of bare device names. Novice operators were
expected to mentally fill in the safety prep, the expected-good readings, the
schematic context, and the escalation criteria — all of which live in the
Ingeteam Level 1 / Level 2 PDFs but were never surfaced in the dashboard UI.

Goal: the drilldown should be a complete walk-through that lets a novice
operator work an alarm without having to bounce between the dashboard, the
PDFs, and the schematic — but with enough precision that experienced
operators don't lose any speed.

---

## Source grounding (the "be very careful and precise" requirement)

All new content traces directly to PDFs that already ship under `docs/`:

| Source | File | Used for |
|---|---|---|
| Level 1 | `docs/Inverter-Incident-Workflow.pdf` (AAV2011IMC01_, 06/2014) | First-line decision flow per alarm code |
| Level 2 | `docs/Inverter-Incident-Workflow-Level2.pdf` (AAV2011IFA01_, 06/2014) | DebugDesc sub-codes, calibration steps, electronic-block replacement |
| Schematic | `docs/Inverter-Schematic-Diagram.pdf` (AQM0027, 22 pages) | Per-page content extraction for `schematicNote` |
| Training | `https://www.ingeconsuntraining.info/?page_id=3749` | TrinPM video index (28 modules) |

PDF text was extracted via `pdftotext -layout` (poppler) for the workflow PDFs
and `pymupdf` (per-page) for the schematic. Each `schematicNote` field is a
one-sentence description of what that page actually depicts — when a
referenced page shows auxiliary supply rather than the device itself
(e.g. bit 8 → schematic p.12 = +15 Vdc rails that drive the K1 contactor coil;
the K1 contactor itself is on p.5), the note says so explicitly so the
operator knows where to actually look.

---

## Schema changes

`server/alarms.js` — every entry in `ALARM_BITS` gains four new optional fields:

| Field | Type | Purpose | Renderer styling |
|---|---|---|---|
| `safetyPrep` | `string[]` | PPE, what stays energized after stop, tools/records to have on hand | Amber left border, amber icon + label |
| `expectedReadings` | `string[]` | What "good" looks like — pass/fail criteria for measurements | Default styling, gauge icon |
| `escalateWhen` | `string[]` | Explicit stop-criteria for calling Ingeteam SAT | Red left border, red icon + label |
| `schematicNote` | `string` | One precise sentence about what the linked schematic page actually depicts | Default styling, sitemap icon |

Existing fields preserved byte-for-byte: `bit`, `hex`, `label`, `severity`,
`description`, `action`, `altLabel`, `level1Ref`, `level2Ref`, `trinPM`,
`schematicPage`, `schematicPageExtra`, `stopReasonSubcodes`, `variantWarning`.

Expanded in place:

- `actionSteps` — from 4–7 terse imperatives to 8–17 procedural steps with
  branching criteria, pass/fail triggers, and PDF page citations
  (`L1 p.X` / `L2 p.Y` references inline).
- `physicalDevices` — from bare device names to "device — where on the cabinet"
  format. Audited by the regression test (em-dash or ≥ 5 words required;
  bit 13 firmware-only is exempt).
- `debugDesc` — filled in for bits where the L2 PDF documents specific
  sub-codes (0x0004 → 40/92/107-109; 0x0040 → 55,56/119).

---

## Files changed

| File | Change |
|---|---|
| `server/alarms.js` | Rewrite of `ALARM_BITS` (16 bits). +750 lines. |
| `public/js/app.js` | `renderListRow` helper + four new section blocks in the alarm-detail modal. Section order: Safety → Action → Physical → Schematic note → Expected → Training → DebugDesc → Stop sub-codes → Escalate → Note. |
| `public/css/style.css` | `.alarm-detail-safety` (amber border) + `.alarm-detail-escalate` (red border) selectors. |
| `docs/ADSI-Dashboard-User-Manual.md` | Drilldown section updated to describe the 9 sub-sections. |
| `server/tests/alarmReferenceShape.test.js` | NEW — regression test (schema + TrinPM coverage + JSON serializability + warn-marker placement + PDF existence). |

---

## Regression test

`server/tests/alarmReferenceShape.test.js` parses `ALARM_BITS` directly from
the source file (no SQLite import — runs under both Node-ABI and Electron-ABI
native builds) and asserts:

1. **Count + completeness**: exactly 16 bits, bits 0–15 all present, no gaps.
2. **Core fields**: `bit`/`hex`/`label`/`severity`/`description`/`action` all
   present; `hex` matches `2^bit`; severity ∈ {info, warning, fault, critical}.
3. **Novice fields**: `safetyPrep` ≥ 2, `actionSteps` ≥ 4, `expectedReadings` ≥ 2,
   `escalateWhen` ≥ 1, `schematicNote` is a string. All list items are
   non-empty strings.
4. **Physical-device descriptors**: every entry contains an em-dash OR has ≥ 5
   words (heuristic — guards against regression to bare device names).
   Bit 13 firmware-only exempt.
5. **Schematic page bounds**: `schematicPage` is null OR an integer 1–22
   (matches the 22-page AQM0027 PDF). Same for `schematicPageExtra`.
6. **TrinPM coverage**: every TrinPM code in `alarms.js` has a video in
   `TRINPM_VIDEOS` in `public/js/app.js`. Asserts TrinPM22 is never referenced
   (no published video on the source training site).
7. **JSON-serializable**: `ALARM_BITS` round-trips through JSON.stringify /
   parse cleanly (the `/api/alarms/reference` endpoint relies on this).
8. **Warn marker convention**: every `actionSteps` entry containing `⚠` has it
   as the first character — required for the renderer's `startsWith("⚠")`
   check that triggers the red `.alarm-detail-step-warn` class.
9. **Level1/Level2 PDFs ship under `docs/`**: each `level1Ref` / `level2Ref`
   filename actually exists on disk.

Test runs under `node` (no Electron-ABI requirement — pure data validation).

---

## Per-bit content depth audit

| Bit | Hex | Label | safetyPrep | actionSteps | expected | escalate | physicalDev |
|---:|---:|---|---:|---:|---:|---:|---:|
| 0 | 0x0001 | Frequency Alarm | 4 | 11 | 4 | 3 | 4 |
| 1 | 0x0002 | Voltage Alarm | 4 | 12 | 3 | 3 | 4 |
| 2 | 0x0004 | Current Control Fault | 4 | 9 | 4 | 4 | 5 |
| 3 | 0x0008 | DSP Watchdog Reset | 3 | 6 | 3 | 2 | 3 |
| 4 | 0x0010 | RMS Overcurrent | 4 | 8 | 4 | 3 | 4 |
| 5 | 0x0020 | Overtemperature | 4 | 10 | 5 | 2 | 5 |
| 6 | 0x0040 | ADC / Sync Error | 4 | 12 | 5 | 3 | 4 |
| 7 | 0x0080 | Instantaneous Overcurrent | 4 | 8 | 4 | 3 | 4 |
| 8 | 0x0100 | AC Protection Fault | 5 | 17 | 6 | 3 | 6 |
| 9 | 0x0200 | DC Protection Fault | 5 | 13 | 7 | 3 | 6 |
| 10 | 0x0400 | Insulation / Ground Fault | 5 | 11 | 4 | 3 | 5 |
| 11 | 0x0800 | Contactor Fault (variant) | 5 | 9 | 4 | 2 | 4 |
| 12 | 0x1000 | Manual Shutdown | 4 | 14 | 6 | 2 | 5 |
| 13 | 0x2000 | Configuration Change | 3 | 6 | 4 | 2 | 3 |
| 14 | 0x4000 | DC Overvoltage | 5 | 8 | 4 | 2 | 4 |
| 15 | 0x8000 | DC Undervoltage / Low Power | 4 | 9 | 5 | 2 | 4 |

Bits 8–10 (AC Protection / DC Protection / Insulation) carry the deepest
walkthroughs — those are the critical-severity branches with the most complex
L2 diagnostic flow and the most safety prep needed before opening a cabinet.
Bit 13 (Configuration Change) is the lightest — info-only event with no
physical inspection required.

---

## Validation

- `node --check server/alarms.js`: clean.
- `node --check public/js/app.js`: clean.
- `node server/tests/alarmReferenceShape.test.js`: PASS (16 bits validated).
- `node server/tests/alarmEpisodeCore.test.js`: PASS (no regression).
- `node server/tests/recoverySeedClamp.test.js`: PASS.
- `node server/tests/energySummaryScaleCore.test.js`: PASS.
- All 28 referenced TrinPM codes have a corresponding YouTube video in
  `TRINPM_VIDEOS`. TrinPM22 (no published video) is not referenced anywhere.

---

## Release follow-ups

1. `package.json` bump (suggest `2.9.3` — content-only patch over `2.9.2`).
2. Regenerate the User Guide PDF from the updated Markdown if it is part of
   the installer payload.
3. Electron-ABI rebuild required before installer build:
   `npm run rebuild:native:electron` — standard release flow.
