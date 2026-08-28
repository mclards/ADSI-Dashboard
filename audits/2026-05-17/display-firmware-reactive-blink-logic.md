# Display-Firmware Reverse-Engineering Audit — Reactive (X1/Y1, X2/Y2) Blink/Edit Logic

**Date:** 2026-05-17
**Status:** COMPLETE — hypothesis answered (with one bounded uncertainty, explicitly flagged)
**Analyst:** Claude (opus-4-7) at operator (Engr. M.) request
**Subject:** `docs/InverterDisplayFirmware.bin`
**Cross-refs:**
- `d:/ADSI-Dashboard/docs/TrinPM20-Inverter-calibration.pdf` (procedure, page 5–6)
- `d:/ADSI-Dashboard/services/calibration_decoder.py` (offsets 91–94)
- `d:/ADSI-Dashboard/public/js/app.js` (`_fcalControlCardsHtml`, `_fcalRenderSingleEditable`)
- Memory: `project_trinpm20_reactive_edit_x_not_y.md`

---

## 0. Operator question being answered

> "analyze this display firmware deeply on how the blinking logic works for the
> X1Y1, X2Y2 reactive params. The reason is, maybe it might not be always Y1
> should be blinking nor X2, maybe different across each node based on the
> status. confirm that first."

**Short answer:** The initially-blinking (editable) field is selected by a
**per-sub-screen compile-time CONSTANT** stored in the display firmware image,
then made **sticky** (it resumes wherever the operator last left the cursor on
that sub-screen). It is **NOT** indexed by, branched on, or otherwise derived
from the node number or the inverter's operating status. It is identical on all
27 inverters. The hypothesis "different across nodes based on status" is **not
supported by the firmware**. Detailed evidence below.

---

## 1. Firmware identification

| Property | Value |
|---|---|
| File | `docs/InverterDisplayFirmware.bin` |
| Size | 130 048 bytes (~127 KB) |
| SHA-256 | `83ad86d3304c1e7f4d1cb2147b5c0aec23bef4c1f174dcb8859d4ebe7b9e369b` |
| Build date (file mtime) | 2022-05-31 |
| Architecture | **ARM Cortex-M (Thumb-2), STM32-class** (`CS_MODE_MCLASS`) |
| Load base | `0x08000000` (flat image = vector table @ file 0) |
| Initial SP | `0x20000850` |
| Reset handler | `0x08001a8c` |
| RAM | `0x20000000`+ (SRAM) |

NOTE: This is the **display/HMI board** processor, a *separate* CPU from the
power-stage DSP. The `project_inverter_dsp_architecture.md` memory
(FreescaleDSP56F, Motorola serial) is about the **power DSP** and does **not**
apply to this binary. The calibration *menu UI* the TrinPM20 video shows is
rendered by THIS Cortex-M firmware.

Tooling: `capstone 5.0.7` (pip-installed), `pdftotext`, custom Python.

---

## 2. Reactive calibration strings (anchors)

ASCII field labels (addr = file_off + 0x08000000):

| Addr | String |
|---|---|
| `0x0801a41c` | `Comp. Reacti_Y1= ` |
| `0x0801a430` | `Comp. Reacti_Y2= ` |
| `0x0801a444` | `Pot. Reactiv_X1= ` |
| `0x0801a458` | `Pot. Reactiv_X2= ` |
| `0x0801a24c` | `REAC1 P SETTING` (screen title) |
| `0x0801a25c` | `REAC2 P SETTING` (screen title) |
| `0x0801a274` | `Enter the real value` (edit-help line) |
| `0x0801a28c` | `of the adjust. var` |
| `0x0801a6a0` | `Calibrating..` |
| `0x0801a8c4` | `CONSIGN OPERATING MODE` |

These labels are **never loaded by a direct `ldr [pc]` in code** (full-image
capstone scan: zero PC-relative code loads of any of the four addresses). They
are consumed **as data by a generic menu engine** that walks screen-descriptor
tables — confirming the UI is table-driven, not per-field hand-coded.

---

## 3. Screen-descriptor tables (field ORDER is Y-then-X)

Two descriptor tables reference the reactive labels.

**Descriptor table @ `0x0800ca08`** (clean prefix, then a code/literal island):

```
[0] 0x0800ca08  'REAC1 P SETTING'      <- title
[1] 0x0800ca0c  'Comp. Reacti_Y1= '    <- field label, slot 0  (Y FIRST)
[2] 0x0800ca10  'Pot. Reactiv_X1= '    <- field label, slot 1  (X SECOND)
[3] 0x0800ca14  RAM 0x200026aa         <- bound value/var
[4] 0x0800ca18  'Comp. Reacti_Y2= '
[5] 0x0800ca1c  'Pot. Reactiv_X2= '
[6] 0x0800ca20  RAM 0x20000228         <- screen-state struct (see §4)
[7] 0x0800ca24  'AC VOL SETTING'       <- next screen
```

**Descriptor table @ `0x08007834`** (same ordering, plus an extra readout line):

```
[17] 0x08007834 'REAC1 P SETTING'
[18] 0x08007838 'Comp. Reacti_Y1= '    (Y FIRST)
[19] 0x0800783c 'Pot. Reactiv_X1= '    (X SECOND)
[20] 0x08007840 'Iac1= '               (live readout shown on the same screen)
[25] 0x08007854 'REAC2 P SETTING'
[26] 0x08007858 'Comp. Reacti_Y2= '
[27] 0x0800785c 'Pot. Reactiv_X2= '
[28] 0x08007860 'Enter the real value'
[29] 0x08007864 'of the adjust. var'
```

**Finding 3.1 —** In the firmware the two editable fields are ordered
**`Comp. Reacti_Y` first, then `Pot. Reactiv_X`** on both REAC1 and REAC2
screens. The physical top line is the `Y` label; the second line is `X`.
There is a separate debug screen `Full Scale Parameters` (`0x0801ab52`) that
lays the six scale params out as `FEVPVN / REACX1 / FEIPV / REACY1 / REACX2 /
REACY2` — that one is read-only diagnostics, not the editable menu.

---

## 4. Screen-state struct & the cursor/blink descriptor

- `sb` (r9) is loaded with `0x200000ac` repeatedly.
- Screen-state struct base = `sb + 0x17C` = **`0x20000228`** (matches
  descriptor `[6]`).
- Relevant fields *inside the struct*:

| Offset | Type | Role (reverse-engineered) |
|---|---|---|
| `+0x36` | u16 | **CURSOR / blink position** (the field that blinks) |
| `+0x38,+0x3a,+0x3c,+0x3e` | u16×4 | **saved cursor**, one slot per sub-page |
| `+0x09,+0x0a,+0x0b,+0x0c` | u8×4 | **"visited" one-shot flag**, one per sub-page |

- Blink-region descriptor = **`0x20002498`** (only TWO code references in the
  entire image: the reactive handler and the LCD field renderer):

| `0x20002498` field | Set to | Meaning |
|---|---|---|
| `[0]` (u8) | `0x00 / 0x20 / 0x40 / 0x80` | blink mode / region id (per sub-page) |
| `[+2]` (u16) | `cursor − 0x0F` | blink X position derived from cursor |
| `[+4]` (u16) | `0x3C` (=60) | blink region width (the value field) |

- `0x200002e0` = LCD render-command block; `[+0xd]` = page/sub-state id
  (0,1,2,3), `[+0x18]/[+0x1a]` = glyph codes.
- `0x2000261c` = **node index**; used ONLY to set a dirty bit:
  `0x2000005c[node] |= 0x800`.
- `0x200026aa` = event/key-state (compared against `1,2,4,8` — OK/UP/DOWN/ESC
  bitmask), drives the dispatch switch.

---

## 5. The decisive init pattern (cursor selection)

Every reactive sub-page initialises the cursor with the **identical shape**.
Cleanest instance, `0x0800d63c` (page id 0):

```
0x0800d63c  ldr   r0,=0x20000228          ; screen-state struct
0x0800d640  ldrb  r0,[r0,#9]              ; visited flag for this sub-page
0x0800d642  cmp   r0,#0
0x0800d644  ldr   r9,=0x200000ac
0x0800d648  add.w r5,r9,#0x17c            ; r5 = 0x20000228
0x0800d64c  beq   0x800d65a
0x0800d64e  movw  r0,#0xfe02              ; <-- CURSOR = CONSTANT 0xFE02
0x0800d652  strh  r0,[r5,#0x36]           ;     (compile-time immediate)
0x0800d656  strb  r0,[r5,#9]              ;     clear visited
0x0800d658  b     0x800d65e
0x0800d65a  ldrh  r0,[r5,#0x38]           ; else CURSOR = saved cursor (sticky)
0x0800d65c  strh  r0,[r5,#0x36]
0x0800d65e  ldrh  r0,[r5,#0x36]
0x0800d660  sub.w r2,r0,#0xf              ; blinkpos = cursor - 0x0F
0x0800d664  ldr   r6,=0x20002498
0x0800d668  strh  r2,[r6,#2]              ; -> blink X position
0x0800d66a  movs  r0,#0x80
0x0800d66c  strb  r0,[r6]                 ; -> blink mode 0x80
0x0800d66e  movs  r0,#0x3c
0x0800d670  strh  r0,[r6,#4]              ; -> blink width 60
0x0800d672  ldr   r4,=0x2000261c          ; node index
0x0800d676  ldrh  r1,[r4]
0x0800d678  ldr   r0,=0x2000005c
0x0800d67c  ldr   r3,[r0,r1,lsl #2]
0x0800d680  orr   r3,r3,#0x800            ; node dirty-bit  (ONLY use of node)
0x0800d684  str   r3,[r0,r1,lsl #2]
0x0800d688  ...   [0x200002e0+0xd] = 0    ; sub-page id
0x0800d6a6  bl    0x800fcaa               ; LCD refresh (bus driver only)
```

Sibling blocks (`0x0800d6c8`, `0x0800d744`, `0x0800d7c0`, `0x0800d732`,
`0x0800d7ae`) are byte-for-byte the same shape with different **literal**
constants and different struct slots:

| Code | Sub-page `[0x200002e0+0xd]` | visited flag | first-entry cursor CONST | saved slot | blink mode `[0x20002498]` |
|---|---|---|---|---|---|
| 0x0800d63c | 0 | `+0x09` | **`0xFE02`** (literal) | `+0x38` | `0x80` |
| 0x0800d6c0 | (pre) | `+0x0a` | **`2`** (literal) | `+0x3a` | — |
| 0x0800d732 | 1 | `+0x0b` | **`2`** (literal) | `+0x3a` | `0x00` |
| 0x0800d7ae | 3 | `+0x0c` | **`2`** (literal) | `+0x3e` | `0x20` |

**Finding 5.1 (CORE) —** In *every* branch the first-entry cursor is a
**hard-coded immediate baked into the firmware** (`movs r0,#2` /
`movw r0,#0xfe02`). There is **no path** in which the cursor / blink position
is read from the node number, an inverter status register, a Modbus status
word, or any per-node array. The only node-indexed access on this path writes
a *dirty bit* (`0x2000005c[node] |= 0x800`) and never feeds the cursor.

**Finding 5.2 —** The `else` branch restores `[struct+0x38/0x3a/0x3c/0x3e]`
— the **last cursor position the operator left on that sub-page** ("sticky" /
resume). This is the only reason the blinking field can *appear* to differ
between two visits: it remembers where you were. That memory is **per
sub-page, in the single shared screen struct `0x20000228`** — it is NOT
per-node and is overwritten as soon as you navigate.

**Finding 5.3 —** Sub-page selection (`[0x200002e0+0xd]` ∈ {0,1,2,3}) and the
whole dispatch are driven by `0x200026aa`, an **event/key bitmask**
(`cmp #1/#2/#4/#8`). REAC1 vs REAC2 and "which line is active" are pure menu
navigation. No node-status conditional appears anywhere in the reactive
handler region (`0x0800d480`–`0x0800d834`).

---

## 6. Blink mechanics

`0x20002498` is the single "region to blink" descriptor: `{mode, pos =
cursor−0x0F, width = 0x3C}`. The LCD field renderer (the only other consumer
of `0x20002498`, around `0x08017560`) and the bus driver `0x800fcaa`
(peripheral `0x40010c00`) blank/redraw exactly that one region on the periodic
refresh, producing the visible blink on the **single field the cursor points
at**. There is exactly **one** blinking region at a time, located at
`cursor − 0x0F`, width 60 px (the value column).

---

## 7. Reconciliation with the TrinPM20 video & the dashboard

| Source | Says | Consistent? |
|---|---|---|
| TrinPM20 PDF p.6 | "The first value you see blinking … is the one we have to modify"; at 70 % go to the "X2 Y2" screen | ✔ — one blink region; sub-page per production point |
| Operator observation | At 70 % Pn, **Pot. Reactiv_X2** was the blinking/edited field | ✔ — consistent with the per-sub-page cursor CONSTANT pointing at the X row |
| Firmware descriptor order | `Comp. Reacti_Y` is line 0, `Pot. Reactiv_X` is line 1 | The label list is Y-then-X, but the **edit cursor default is an independent constant** that can point at the X line regardless of label order |
| Dashboard (post-fix) | "edit X1 @20 %, X2 @70 %" | ✔ — matches the operator/video |

**Reconciliation:** label *display order* (Y then X) and *edit-cursor default*
(a separate constant) are independent. The firmware proves the blinking field
is whatever the per-sub-page constant points to — fixed, identical per node.
This is fully consistent with the operator seeing **X** blink at the
production point, and confirms the corrected dashboard guidance (edit X1/X2,
not Y1/Y2) is right.

---

## 8. Bounded uncertainty (intellectual honesty)

What is **proven**: the blink/edit field is a firmware constant + sticky
resume; it is **NOT** node- or status-dependent (the operator's hypothesis is
disproved).

What is **inferred, not bit-proven**: the exact mapping from a specific cursor
constant (`2`, `0xFE02`) to the precise on-glyph (decisively "this pixel = the
X1 label vs the Y1 label") would require fully reversing the LCD layout/glyph
engine (`0x08012602` bus writer + font tables) — out of scope and not needed
to answer the question. The operator's direct video observation (X is the
blinking one at the production point) is the ground truth for *which* field;
the firmware confirms it is *constant per node*, which is the part that was
asked.

---

## 9. Conclusion / impact

1. **Hypothesis answer:** NO — the blinking reactive field is **not** different
   across nodes and **not** a function of node status. It is a fixed
   compile-time constant per sub-page, identical on every inverter, with a
   sticky "resume last position" behaviour that is per-sub-page (not per-node).
2. The TrinPM20 procedure and the operator's observation (edit **X** at the
   production point) are consistent with the firmware.
3. The corrected dashboard guidance (`project_trinpm20_reactive_edit_x_not_y`)
   stands: instruct the operator to edit **Pot. Reactiv_X1 (off 91) @ 20 %**
   and **Pot. Reactiv_X2 (off 93) @ 70 %**. No per-node conditional guidance is
   warranted.
4. No code change required from this audit; it is investigative confirmation.
   The earlier app.js guidance fix remains correct and complete.

---

*Analysis artifacts: capstone disassembly of `0x0800d520–0x0800d834`
(reactive handler), `0x0800fcaa` (LCD bus driver), `0x08017560` (field
renderer), descriptor tables `0x08007834` / `0x0800ca08`. Reproduce with the
Python+capstone snippets recorded in the session transcript.*

---

## 10. Consign Mode — firmware vs dashboard (added 2026-05-17, later same day)

**Operator follow-up:** "make sure to apply the consign mode the same from the
firmware."

### 10.1 Firmware findings

- Consign strings: `0x0801a8c4 'CONSIGN OPERATING MODE'`, `0x0801a948
  'Consign'`, `0x0801a97c 'PotAC = '`, `0x0801a988 'IdRef (%) = '`,
  `0x0801a9b4 'RefIsc(%) = '`, `0x0801a9c4 ' Reduc:'`, `0x0801a5cc
  'Power_Ramp_Val ='`, plus consumption-mode strings `0x080199af /
  0x08019d09 'CONSUMO POT:'`, `0x0801a063 'POTVERBRAUCH:'` (DE),
  `0x08019b5c 'LOW POWER  :'`.
- The consign menu screen exposes a power setpoint (PotAC) plus reactive
  refs; consign value vars at RAM `0x200026d2/0x200026d4`. The consign menu
  is drawn by the same generic scrolling-list renderer `0x0800f964` (its
  literal pool at `0x0800f944` holds the CONSIGN strings).
- The firmware drives a **% of nominal power** setpoint. Functionally
  identical to the dashboard's remote path, which uses **APC cmd opcode
  0x0003 (SET-P)** with a Q15 setpoint (`set_active_power_pct` in
  `services/inverter_engine.py`), `/api/calibration/consign`, range 0–100 %.
- TrinPM20 procedure (the firmware's own workflow), consign ladder used:
  **10 %** (initial, after E-stop release) → **60 %** (DC current / Ipv
  offset 87) → **20 %** (reactive pt 1) → **70 %** (reactive pt 2) →
  **0 % "Consume Mode"** (inverter consumes; calibrate consumption power
  = Per. Vacio, offset 90) → restore.

### 10.2 Gap found & fixed

The dashboard consign tiles were `10/20/60/70/Release(100)` — **missing the
firmware's 0 % "Consume Mode" step** that the procedure explicitly uses to
calibrate Per. Vacio (offset 90). The codebase already supports it: the
calibration-session lockdown deliberately suppresses auto-reset so the
operator can drive consign 0 % without an auto-reset race
(`services/inverter_engine.py` ~L865 comment).

Applied (`public/js/app.js` `_fcalControlCardsHtml`, `public/css/style.css`):
- Added a **0 % Consume · Per. Vacio** tile (amber `.fcal-consign-tile-consume`
  caution accent — it is deliberately protection-tripping).
- Re-labelled tiles to the firmware step each setpoint serves (10 % "Start /
  DC ladder", 60 % "DC Ipv", 20 % "Reactive Y1", 70 % "Reactive X2", 100 %
  "Release"); enriched tooltips with the firmware rationale.
- Tile grid 5 → 6 columns (still one row, per operator preference).
- Verified `pct=0` flows correctly end-to-end (no falsy-zero bug): handler
  `_fcalHandleConsign(0)`, server `0..100` validation, `set_active_power_pct`
  → Q15 0. Server 30 s dwell guard applies to 0 % (good — settle before the
  consumption read); session-end auto-restores 100 %.

### 10.3 RESOLVED — Ipv re-gated to the 60 % consign band (operator directive)

Operator decision 2026-05-17: *"follow the script in the video — if it says
60 % there then only enable the Ipv if the current consign mode is set to
60 % else block. review if that only applies to Ipv. the same to the
Reactive."*

Applied to `server/calibrationSafety.js` + `server/tests/calibrationSafety.test.js`:

- **Fesc_ipv (87):** replaced the `≥ 70 %` minimum with a **60 % band**
  (`FESC_IPV_TARGET_PCT = 60`, `±5 pp` → 55–65 %). Now a BAND gate (too low
  AND too high both block), exactly like the reactive points. 70 % now
  *blocks* (it is the wrong consign target for Ipv).

Review of "does this only apply to Ipv" — scope verified:

| Offset(s) | Consign-target gate | Status |
|---|---|---|
| 87 Fesc_ipv | **60 % ± 5** | changed (this directive) |
| 92 Comp. Reacti_Y1 | 20 % ± 5 (`REACTIVE_X1Y1`) | already correct — no change |
| 93 Pot. Reactiv_X2 | 70 % ± 5 (`REACTIVE_X2Y2`) | already correct — no change |
| 91 X1 / 94 Y2 | n/a | display-only, hard-blocked non-bypassably (§9) |
| 81–86 Vac/Iac, 88–89 Vpv | **none — state-only** | UNCHANGED by deliberate prior operator contract (2026-05-16): scale-factor calibration is valid off-grid; `calibrationSafety.test.js` asserts "offset 81: no Pac/Pn band". |
| 90 Per. Vacio | ~~none — state-only~~ → **0 % ± 5 band** | **SUPERSEDED by §15** (operator directive, later same day). 90 is editable and uses a bypassable 0 %-consign band gate (`PER_VACIO_*`). The "not power-gated / not dashboard-writable" stance in the original row was the bug §15 corrects — do NOT trust this row. |

So the consign-target band applies to **Ipv (60 %), Y1 (20 %), X2 (70 %),
and — per §15 — Per. Vacio (90 @ 0 %)**. 81–86 / 88–89 remain state-only.
Tests updated and green.

*Consign artifacts: strings sweep + disasm of `0x0800f964` (generic list
renderer / consign pool `0x0800f944`), `0x08003460` (menu nav), and
`set_active_power_pct` @ `services/inverter_engine.py:3511`.*

---

## 11. ACT P ADJUSTMENT — Per. Vacio is display-only; Pot. Activ is the typed value (added 2026-05-17, later same day)

**Operator clarification + screenshot (ground truth):** the inverter's
`ACT P ADJUSTMENT` screen shows `PER. VACIO= 2.080` (a small decimal
coefficient), `POT. ACTIV= -2480` (watts), `IAC1= 0.0`, and the prompt
"ENTER THE REAL VALUE OF THE ADJUST. VAR". The operator attaches a wattmeter
and **types the real measured watts into `POT. ACTIV`**; `PER. VACIO` is
**not** touched (the firmware derives it).

### 11.1 Firmware verification

- Screen descriptor `0x0800c8cc`: `[title 'ACTIV P SETTING', slot0
  'Per. Vacio= ', slot1 'Pot. Activ= ']` — byte-for-byte the SAME 2-slot
  structure as `REAC1 P SETTING` / `REAC2 P SETTING`.
- Same cursor/blink/saved-slot state machine as the reactive screens
  (`[0x20000228+0x36]` cursor, blink-region `0x20002498`, per-sub-page
  saved slots `+0x38/+0x3a/+0x3c`, cursor nav ±1/±0xF/±0xFF, blink pos =
  cursor−0xF, render+highlight via `0x8010bd0`; ACT P handler render loop
  `0x0800dafe–0x0800ded2`, save-cursor `0x0800dfa6+`).
- For `REAC2` (identical structure) the verified edited slot is **slot 1**
  (`Pot. Reactiv_X2`); slot 0 is display. By the same machinery + the
  operator's screenshot, ACT P's edited slot is **slot 1 = `Pot. Activ`**,
  slot 0 `Per. Vacio` is display-only. (The descriptor tables are reached
  via a base+index by a generic engine — no direct LE32 refs — so the
  per-screen cursor-init constant was not isolated to a single instruction;
  the descriptor structure + REAC2 analogy + the operator screenshot +
  the decoder mapping below are jointly conclusive.)

### 11.2 Dashboard mapping — the decisive point

`services/calibration_decoder.py:52` (its header states the catalog was
derived FROM this firmware's string table): **Modbus calibration offset
90 = `comp_per_vacio` = "Per. Vacio"** — i.e. offset 90 is the **slot-0
display-only coefficient**, NOT the editable "Pot. Activ" watts entry.
There is **no register in the 81–94 calibration block** for the
"enter the real wattmeter value" entry — that is an HMI-only workflow
(operator types watts → firmware computes the coefficient).

**Conclusion:** offset 90 must be **display-only** on the dashboard.
Active-P / consumption calibration is **HMI-only** and cannot be performed
via a raw Modbus write to offset 90.

### 11.3 Applied (supersedes the prior-turn speculative edits)

Prior turns had speculatively made Per. Vacio editable + added a 50 %
"Per. Vacio" consign tile + planned a 50 % server write-gate. Those were
based on the wrong premise and are **reverted**. Final state:

- `public/js/app.js`: `_FCAL_REACTIVE_READONLY_OFFSETS` → renamed
  `_FCAL_DISPLAY_ONLY_OFFSETS = {90,91,94}`. Offset 90 renders the
  "Display-only" chip (no input, no Write); name + metric tooltips explain
  Per. Vacio is a derived coefficient and Pot. Activ is the HMI-typed
  watts. Both values still shown (Factor = Per. Vacio coeff, Live =
  Pot. Activ W).
- Consign tiles = 10 / 20 / 50 / 60 / 70 / Release (grid `repeat(6)`). The
  50 % tile was wrongly mislabelled "Per. Vacio" then wrongly removed; it is
  REINSTATED with the correct rationale — it is the **TrinPM20 final-
  verification midpoint** (verify active-power error ≤ 3 % vs wattmeter at
  20 / 50 / 70 % Pn, video p.7), a measurement/observation point, not a
  write target. No 0 % tile.
- `server/calibrationRoutes.js`: `REACTIVE_READONLY_OFFSETS` → renamed
  `CALIB_DISPLAY_ONLY_OFFSETS = {90,91,94}`; `checkTrinPmSafetyGates`
  refuses 90/91/94 non-bypassably (before the force check), generalized
  message.
- `server/calibrationSafety.js`: unchanged (no 50 % band added; offset 90
  never reaches the pure gate — refused at the route layer). The Ipv 60 %
  band (§10.3) stands.
- Validation: `node --check` app.js + calibrationRoutes.js OK; CSS
  3301/3301; `calibrationSafety.test.js` green (the "comp_per_vacio (90):
  state-only" unit test still passes — `evaluateWriteSafety(90)` is
  intentionally unchanged; enforcement is the route-layer non-bypassable
  backstop).

### 11.4 Open (flagged, not guessed)

The Active-P calibration is now correctly HMI-only on the dashboard. If a
dashboard-driven Active-P calibration is ever wanted, it needs a dedicated
"enter the real wattmeter watts" flow that writes the correct Modbus
register with the firmware's watts→coefficient conversion — that register
is NOT in the 81–94 block and must be identified from the inverter's
Modbus map before any such feature is built. Out of scope here.

---

## 12. Meter-value auto-compute mode (linear scale factors 81–89)

**Operator request (2026-05-17):** *"for Vpv, IpV, Vacs, and Iacs, is it
possible to apply the same concept of entering the literal value from the
wattmeter/Multimeter, and just saving it automatically as the needed
factor?"* — design chosen by the operator via AskUserQuestion:
**"Compute → show → Write"** + **"Toggle: Factor ⇌ Meter"**.

### 12.1 Why it is mathematically sound (and bounded to 81–89)

The ESCALE / scale offsets are single-point **gain trims**: the displayed
reading is *linearly proportional* to the stored factor (no offset term).
For a given true input the relationship is `displayed = k · F_E`, so

```
F_E_new = round( F_E_current × ( meter_reading / live_displayed ) )
```

is the exact closed form of the manual trial-and-error loop, not an
approximation. This holds **only** for the linear scale block:

| Offsets | Param | Linear gain trim? | Meter mode |
|---|---|---|---|
| 81–83 | Vac1–3 scale | yes | **enabled** |
| 84–86 | Iac1–3 scale | yes | **enabled** |
| 87 | Fesc_ipv (DC current) | yes | **enabled** |
| 88–89 | Vpvp / Vpvn scale | yes | **enabled** |
| 90 | Per. Vacio | n/a — display-only, HMI-derived (§11) | excluded |
| 91–94 | Reactive X1/Y1/X2/Y2 | no — Q≈0 trial-and-error, not a gain trim | excluded |

Reactive is excluded because its calibration target is "measured Q
fluctuates around 0 VAr", not "displayed value = meter value" — the linear
closed form does not apply. 90 is excluded because it is display-only and
HMI-derived (§11). Both are excluded *by construction*: the
`.fcal-mode-toggle` is rendered only when `81 ≤ offset ≤ 89`.

### 12.2 Implementation (applied)

- `public/js/app.js`, `_fcalRenderSingleEditable`:
  - `isLinearScale = offset>=81 && offset<=89` gates a compact
    **Factor ⇌ Meter** segmented toggle, a `.fcal-meter-input`
    (placeholder shows the live unit from `_FCAL_LIVE_MAP`), and a
    `.fcal-meter-calc` derivation line — all inside the existing editable
    `writeBlock`.
  - Wiring (added after the `.fcal-write-input` dirty-sync forEach so the
    in-scope `_fcalSyncDirty` helper is reused): the meter `input` event
    reads the slot's `.fcal-live-num` text as `live`, the factor input's
    `data-base` as `F_E_current`, computes
    `factor = round(base × meter / live)`, writes it into
    **`.fcal-write-input` (the unchanged single write source)**, shows
    `→ F_E <factor> (was <base>)`, and calls `_fcalSyncDirty(fInp)` so the
    dirty-edge + emphasized-Write treatment fires exactly as for a manual
    factor edit. Guards (red `.fcal-meter-bad` line, no factor change): no
    live reading / live = 0, non-numeric meter, base = 0/unknown. Clearing
    the meter field reverts the factor to "no change".
- `public/css/style.css`: `.fcal-mode-toggle` / `.fcal-mode-btn`
  (+`.fcal-mode-active`, `:disabled`), `.fcal-meter-input` (accent left
  rail to read as "a measurement"), `.fcal-meter-calc` (+`.fcal-meter-bad`)
  — themed with the project token system, slotted with the other
  `.fcal-slot-write` rules.

### 12.3 Safety invariant (unchanged)

Meter mode is **pure pre-fill of the existing factor input**. It does NOT
add a write path: `_fcalWriteOne(offset)` still reads `.fcal-write-input`
and every existing guard applies untouched — the > 50 % delta range guard,
the inverter-state gate, the TrinPM20 consign-band gate
(`server/calibrationSafety.js`, incl. the §10.3 Ipv 60 % band), and the
non-bypassable display-only refusal for 90/91/94
(`server/calibrationRoutes.js`). The operator still reviews the computed
factor and clicks Write; nothing auto-commits.

### 12.4 Validation

`node --check public/js/app.js` OK; CSS braces 3310/3310 balanced. No
server / test changes (write path and gates untouched by design).

---

## 13. Safety-Bypass switches relocated to the pinned Read toolbar

**Operator request (2026-05-17):** the standalone "Safety Bypass" control
card was redundant. First ask was to remove it; revised ask: *"if you dont
want to remove that, just put checkboxes for that intention here at the
right side, remove unnecessary texts line, put it in tooltip instead"* +
*"we dont need this reminder 'Armed switches stay on until you turn them
off.'"* — i.e. KEEP the bypass capability, move the two checkboxes inline
to the right of the INVERTER / NODE / Read toolbar, tooltip-only.

### 13.1 What changed (capability + gates unchanged)

This is a **UI relocation only** — `forceWrite` / `forceSafety` semantics,
the write payload (`max_delta_pct` / `force_safety_gate`), and every server
gate are byte-for-byte unchanged. Specifically:

- `public/index.html`: two `.fcal-force-toggle` labels (`#fcalForceWrite`,
  `#fcalForceSafetyGate`) added inside `.srn-controls`, after
  `#fcalReadMsg`, wrapped in `.fcal-bypass-inline` (right-aligned via
  `margin-left:auto`). Concise labels only ("Force range guard" / "Force
  TrinPM20 gate"); the old subtitle detail spans ("allow > 50 % delta" /
  "skip state / Pac band"), the "off by default" card hint, and the "Armed
  switches stay on…" note are **deleted** — their content folded into the
  `title=` tooltip (per `feedback_no_ui_intro_copy`). The TrinPM20 tooltip
  also states display-only 90/91/94 stay refused even when armed.
- `public/js/app.js`:
  - `_fcalControlCardsHtml()` — the entire `#fcalBypassPanel` card removed;
    Consign Mode is now the only control card (still cell 1 of the grid).
    Header comment updated.
  - The switches are static now, so they are bound **once** at init
    (`_bindBypassOnce`, next to the Read-button binding) instead of the
    per-render `_bindBypass` (removed from `_fcalRenderSingleEditable`,
    which would have double-bound static elements every render).
  - `_fcalSyncControlCards()` — dead `#fcalBypassPanel` `fcal-ctl-locked`
    lookup removed; `getElementById("fcalForceWrite"/"…SafetyGate")` is
    location-agnostic so it still reflects persisted flags →
    checked + `.fcal-force-armed` + `.fcal-ctl-disabled` (Calibration-Mode
    lock) onto the toolbar pills. The `fcal-force-on` host toggle (red
    dirty-Write treatment when a bypass is armed) is retained.
- `public/css/style.css`: `.fcal-bypass-inline` added (right-aligned,
  compact pill padding 4×10, 11.5 px, 14 px box). Dead `.fcal-bypass-list`,
  `.fcal-bypass-list .fcal-force-toggle`, `.fcal-bypass-note`,
  `.fcal-ctl-locked .fcal-bypass-list`, and `.fcal-force-toggle-detail`
  pruned. Shared `.fcal-force-toggle` / `.fcal-force-armed` /
  `.fcal-ctl-disabled` styling kept.

### 13.2 Scope note

The toggles sit in the `data-fcal-header="single"` block, so they appear
only on the single-node tab (correct — fleet scan is read-only) and remain
disabled until Calibration Mode is entered (`_fcalSyncControlCards` sets
`el.disabled = !writesEnabled`), exactly as before.

### 13.3 Validation

`node --check public/js/app.js` OK; CSS braces 3309/3309 balanced;
sanity-grep confirms zero dangling `fcalBypassPanel` / `fcal-bypass-list` /
`fcal-bypass-note` / `fcal-force-toggle-detail` references in app.js /
index.html / style.css. No server / test changes (write path + gates
untouched by design).

---

## 14. Cohesion review — auth / read-write race / meter / consign / checkboxes

**Operator request (2026-05-17):** *"make sure everything will work as
intended, from factor-meter logic, auth logic, consign logic status to
parameter-related editing, checkboxes purposes, read and writing race …
not conflicting … for smoother and easy writes, and other not mentioned."*
End-to-end trace of every interaction path on the Field Calibration page.

### 14.1 Verified SOUND (no change needed)

- **Auth.** `_fcalGetBulkAuth()` = `getCachedBulkAuthKey() || ""` — never
  prompts. `_fcalAuthedFetch` (read path) never prompts; read endpoints
  public server-side; 401/403 on reads do NOT touch caches/mode.
  `_fcalEnsureSession` is the single unlock (`_fcalEnsureUnlock`) then
  starts the session; write/consign/copy/restore all go through
  `_fcalGetBulkAuth` (no prompt) and surface "Enter Calibration Mode
  first" when locked. The relocated bypass checkboxes' change handler
  does NO auth. → matches `feedback_calibration_auth_minimal` (one prompt
  per visit, reads public).
- **3-s live auto-refresh.** `_fcalQuietRefreshLive` → `_fcalPatchLiveCells`
  (only rewrites `.fcal-live` innerHTML) + `_fcalPatchStateStrip` (only
  header chips). It NEVER re-renders, so it cannot clobber a typed factor,
  an active Meter toggle, the meter input, dirty highlights, or the bypass
  checkboxes. Tab-hidden guard present. Stash into `lastState.live` keeps
  write/restore handlers current.
- **Factor ⇌ Meter.** Meter mode only pre-fills the single write source
  `.fcal-write-input`; `_fcalWriteOne` reads exclusively that. Guards for
  non-numeric meter / no-live / zero-or-unknown base. Freezing the factor
  at meter-entry time is mathematically *correct* (meter reading and live
  must be sampled at the same instant for the gain ratio) — recomputing
  later against a newer live would corrupt it, so the absence of a "live
  changed → recompute" coupling is intentional and right.
- **Consign.** `setStatus` persists to `FieldCalibrationUI.consignStatus`
  AND patches `#fcalConsignStatus.textContent` in place; no re-render;
  active-tile is a class toggle. Status survives a later grid rebuild
  because `_fcalControlCardsHtml()` re-emits `consignStatus`.
- **Checkboxes.** Static toolbar markup; bound once (`_bindBypassOnce`);
  `_fcalSyncControlCards` reflects persisted `forceWrite/forceSafety` →
  `checked` + `.fcal-force-armed` + `.fcal-ctl-disabled`; disabled unless
  Calibration Mode. Write payload reads `getElementById?.checked ||
  FieldCalibrationUI.force*` (robust dual source). Display-only 90/91/94
  stay non-bypassably refused server-side regardless.
- **Write races.** `FieldCalibrationUI._writing` Set guards per-offset
  double-click; all write buttons disabled during a write / Write-All and
  re-enabled only when `_writing.size === 0`. `_fcalWriteOne` does a
  targeted `.fcal-val` update + clears its own input, then a debounced
  full re-read verifies from the inverter.
- *(False alarm checked & dismissed: a grep `-A` context line rendered the
  valid `// Initials field removed …` comment at app.js:28998 as `\ …`;
  the file bytes are a correct `//` comment — `node --check` confirms.)*

### 14.2 Issue FOUND + FIXED — post-write rebuild discarded other slots

`_fcalHandleWrite` / `_fcalHandleWriteAll` success → `_fcalScheduleReadRefresh()`
→ 400 ms debounce → `_fcalHandleRead()` → `_fcalRenderSingleEditable()`
**rebuilds the whole `#fcalReadResult` innerHTML**. The full re-read is
required (re-verify factors + ValidCfgCode + gate badges from the
inverter), but it also wiped any *unsaved* edit on **other** slots —
typed-but-unwritten factors, an active Meter toggle + meter reading, dirty
state. Invisible in the strict one-field-at-a-time TrinPM20 flow; a real
silent-data-loss footgun once Meter mode makes multi-slot setup common.

**Fix (scoped to the post-write path only):** `_fcalSnapshotInProgressEdits()`
captures per-offset `{factorVal, meterActive, meterVal}` for slots with a
genuine unsaved edit immediately before the rebuild;
`_fcalRestoreInProgressEdits()` reapplies them after — for Meter slots it
re-clicks the (freshly wired) Meter toggle, restores the reading, and
dispatches `input` so the value recomputes against the **just-read** live
(the correct freshest denominator); for Factor slots it restores the value
and dispatches `input` → `_fcalSyncDirty`. The just-written slot is
excluded for free (its input was already cleared by `_fcalWriteOne`, so
the snapshot sees nothing unsaved). A **manual Read button press still
does a clean full reset** (snapshot/restore is only wired into
`_fcalScheduleReadRefresh`). No change to auth, gates, the write payload,
or verification semantics — purely edit preservation.

### 14.3 Validation

`node --check public/js/app.js` OK. No server / test changes (write path,
gates, auth untouched by design). Behavioural: write slot A with slot B
mid-edit → after the post-write refresh slot B's value + Meter mode are
retained and re-derived against the fresh live; slot A shows the clean
verified factor; manual Read still resets all inputs.

---

## 15. CORRECTION — Per. Vacio (offset 90) IS editable (supersedes §11)

**This section reverses the §11 conclusion.** §11 said offset 90 is
"display-only / HMI-only / never written from the dashboard" and it was
enforced non-bypassably. **That was wrong.** Operator directive
2026-05-17: *"Pot. Activ is set to match the read Active power Pac (watts)
when the inverter is not generating (consign set to 0 %)"* + *"why you
saying it is not editable?"* + *"make sure that the calculation logic
between meter and factor is very precise."*

### 15.1 Why §11 was wrong

§11 reasoned from the **HMI display** (the screen shows "Per. Vacio" as a
derived decimal you don't hand-type, and "Pot. Activ" as the typed field →
concluded "no writable register → HMI-only"). That inverts the evidence.
The authoritative source is **not** the display firmware's on-screen
behaviour — it is `services/calibration_decoder.py`, whose catalog was
reflected from **Ingeteam's own ISM service DLL**
(`FV.IngeBLL…CfgTrifAU`). That file:

- line 37: *"The 14 **writable** scale-factor registers"* — and offset 90
  is in the list;
- line 52: `(90, "comp_per_vacio", "Per. Vacio", "Active P", False,
  "Self-consumption / standby comp")`;
- lines 11-12: *"Calibration **write target** block (offsets 81-94) …
  present in CfgTrifAS and CfgTrifAU."*

So ISM itself writes offset 90. The HMI "Pot. Activ" is just an *input
helper* that back-solves the offset-90 gain; over Modbus you write 90
directly, exactly as ISM does. Firmware string-pool order confirms the
two ACTIV-P slots (`Pot. Activ= ` @0x0801a3fc, `Per. Vacio= ` @0x0801a40c)
with the prompt **"Enter the real value of the adjust. var"** (0x0801a274)
— an *input* screen, not a read-only display.

### 15.2 The precise calculation (operator: "very precise")

[calibration_decoder.py:37](../../services/calibration_decoder.py) groups
offset 90 with the F_E_* registers as a **scale-factor** (gain), and the
screenshot `PER. VACIO = 2.080` is a ~2× coefficient, not a watt offset.
The procedure ("set Pot. Activ to match read Pac at 0 % consign" = make
*reported* = *measured* at the no-load point) is a textbook **single-point
gain trim**. So the exact transform is the SAME one already proven/shipped
for 81-89 — no new or guessed formula:

```
F_E_new = round( F_E_cur × ( meter_watts / live_reported_Pac ) )
```

The ratio is dimensionless (W/W) ⇒ unit-safe and exact. Precision/safety
guards were ADDED to the shared recompute (universally correct — they
never trip on the always-positive 81-89 V/A path, but protect 90 where
no-load Pac is small/negative, e.g. −2480 W): refuse if `meter == 0`
(would zero the gain), refuse if `sign(meter) ≠ sign(live)` (gross
miscal / wrong consign), refuse if the rounded factor falls outside the
u16 register range. The success line now shows the applied `×ratio` for
auditability.

### 15.3 Applied

- `server/calibrationRoutes.js`: offset 90 removed from
  `CALIB_DISPLAY_ONLY_OFFSETS` (`{91,94}` now); the non-bypassable 409
  refusal and its message no longer reference 90.
- `server/calibrationSafety.js`: new `PER_VACIO_OFFSET=90`,
  `PER_VACIO_TARGET_PCT=0`, `PER_VACIO_TOLERANCE_PCT_PP=5` → offset 90
  uses a **0 %-consign band gate** (−5…+5 % = "not generating"),
  **bypassable** like Ipv/reactive (NOT a hard refusal). Exported;
  `calibrationSafety.test.js` updated (allows at 0 %/band, blocks when
  generating) — full suite green.
- `public/js/app.js`: `_FCAL_DISPLAY_ONLY_OFFSETS = {91,94}`;
  `isLinearScale` now `81..90` so 90 gets the Factor⇌Meter toggle + the
  precise gain formula (`_FCAL_LIVE_MAP[90]` = `pac_w` W); offset-90
  label/tooltips rewritten (editable Per. Vacio no-load scale factor,
  calibrate at 0 % consign); recompute hardened with the sign/zero/range
  guards above. **0 % consign tile re-added** ("Per. Vacio"); consign
  guide updated; tiles grid `repeat(7)`.
- Audit (this §15) + memory `project_trinpm20_reactive_edit_x_not_y` +
  MEMORY.md index updated to mark §11 superseded.

### 15.4 Validation

`node --check` on app.js + calibrationSafety.js + calibrationRoutes.js OK;
`server/tests/calibrationSafety.test.js` all PASS incl. the new offset-90
0 %-band cases; CSS 3309/3309 balanced.

### 15.5 Standing rule (don't regress again)

Per. Vacio / offset 90 is **editable** — a no-load active-power scale
factor, calibrated at **0 % consign** (inverter not generating) with the
same precise single-point gain math as 81-89. Display-only is now ONLY
91 + 94 (paired reactive coordinate). Defer to the operator + the
**ISM-reflected decoder** as authoritative; never re-derive editability
from the display firmware's on-screen rendering.

---

## 16. CORRECTION — X1 (91) + Y2 (94) writes ENABLED (supersedes §9 / §11.3 / §15.5 for 91+94)

**Operator directive 2026-05-17, backed by field evidence.** Reviewing the
**Fleet Anomalies** view, the operator observed large per-node drift on the
reactive-Y coordinates (Y1 deltas −16 % … −116 %, Y2 deltas +62 % …
+531 % vs fleet median) and concluded a prior bad edit likely corrupted
those registers on some units. Decision: *"enable writes on X1 and Y2 …
I'm gonna verify that manually in field."*

### 16.1 What changed

The "X1 (91) / Y2 (94) are the paired coordinate → display-only,
non-bypassably refused" rule (from §9, reaffirmed in §11.3/§15.5) is
**reversed for 91 and 94**. All four reactive coordinates (91-94) are now
dashboard-editable, so a drifted X1/Y2 can be hand-corrected/verified on
site. This is **not** a regression of the firmware analysis (Y1/X2 remain
the inverter's *blinking* fields) — it is a deliberate operator choice to
expose the paired coordinate for field repair of suspected bad data.

### 16.2 Safety posture (unchanged gate, just no longer a hard refusal)

`server/calibrationSafety.js` already gates 91 via `REACTIVE_X1Y1_OFFSETS`
(20 % ± 5 consign band) and 94 via `REACTIVE_X2Y2_OFFSETS` (70 % ± 5) —
**identical to Y1/X2**. So enabling writes does NOT remove safety: 91/94
still only write when consign is at the matching reactive point
(bypassable via `force_safety_gate`, same as every other consign-gated
offset). The only thing removed is the *non-bypassable* refusal.

### 16.3 Applied

- `public/js/app.js`: `_FCAL_DISPLAY_ONLY_OFFSETS = new Set([])` (empty —
  90 had been removed in §15; 91+94 removed here). Reactive `role` text
  for 91/94 rewritten ("EDIT at 20 %/70 % — paired coordinate, dashboard-
  editable per operator directive to correct drift"); consign-guide text
  updated; the stale "display-only" comment + `roTip` made generic/defensive.
  91-94 stay plain trial-and-error inputs (NO meter-mode — reactive is
  Q≈0, not a gain trim; `isLinearScale` unchanged at 81-90).
- `server/calibrationRoutes.js`: `CALIB_DISPLAY_ONLY_OFFSETS = new Set([])`;
  the non-bypassable guard is kept (defensive, re-populatable) but never
  fires; `_doName` generalised to an offset→name map; 409 message
  genericised.
- `server/calibrationSafety.js`: **unchanged** — 91/94 band gates already
  present and correct.
- Tests: `calibrationSafety.test.js` unchanged and green (27 PASS / 0
  FAIL) — it exercises the consign-band gate (still in force for 91/94),
  not the removed UI/route lock.

### 16.4 Validation

`node --check` app.js + calibrationRoutes.js + calibrationSafety.js OK;
`calibrationSafety.test.js` 27 PASS / 0 FAIL; CSS balanced; stale-text
sweep clean (no remaining "91/94 display-only / NOT editable").

### 16.5 Standing rule (current truth — supersedes earlier reactive rules)

ALL of 91/92/93/94 are operator-editable. Y1 (92 @20 %) and X2 (93 @70 %)
are the inverter's blinking fields; X1 (91 @20 %) and Y2 (94 @70 %) are
the paired coordinate, editable for field correction of drift. Every
reactive write is consign-band gated (bypassable). `_FCAL_DISPLAY_ONLY_OFFSETS`
and `CALIB_DISPLAY_ONLY_OFFSETS` are both empty; per-offset safety is the
`calibrationSafety.js` consign/state gate alone. Defer to the operator +
the ISM-reflected decoder, never re-derive editability from the display
firmware's on-screen rendering.
