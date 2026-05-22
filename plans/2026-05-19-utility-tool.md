# Plan — "Utility Tool" (rename + read-only setting tabs + TCP fleet scan)

**Date:** 2026-05-19
**Status:** IMPLEMENTED (Phases A–D) — 2026-05-19; verification in progress
(450/450 pytest green incl. golden; full Node smoke running). No git commit
(operator reviews). Enum reflection was dropped (x86 StackOverflow in the
AssemblyResolve delegate); booleans decode from name-encoded polarity, the
3 multi-value enums in B/C/D/I use a small curated table in
calibration_decoder.py.
**Author:** Engr. M. (analysis assistance: Claude)
**Relation:** Branding-supersedes `plans/2026-05-12-inverter-calibration-tool.md`.
The calibration scale-factor write path (offsets 81–94), session lockdown,
and every safety gate from that plan are **unchanged** by this one.

---

## 1. Scope (operator-confirmed)

| # | Deliverable |
|---|---|
| 1 | Rename the **standalone "Inverter Calibration Tool"** → **"Utility Tool"** (user-facing branding only) |
| 2 | Add **read-only tabs** for audit groups **B** (Node & Startup), **C** (Grid Protection Envelope), **D** (Power & Reactive), **I** (Isolation & Temp Derating) |
| 3 | In **TCP/Ethernet transport mode only**, add a **Fleet Scan** over the ipconfig inverter list |
| 4 | Do **not** compromise the existing calibration write workflow, session lockdown, or safety gates |

Out of scope (unchanged from prior plan §5): any *write* to B/C/D/I,
country-code switching, `eReactiveSetPoint` mode change, ISM admin
emulation. B/C/D/I tabs are **display-only**.

### Operator decisions (2026-05-19)
- **Fleet source:** reuse the existing **ipconfig** inverter/IP/slave map
  (same list the in-dashboard fleet-summary uses). No manual IP-range UI.
- **Decode posture:** decode **clean and confident** — no "verify vs ISM"
  hedging notes, no asterisks, one decoded column. The evidence
  (ISM DLL reflection) is authoritative; the operator will flag any value
  that reads wrong in the field. Consequence: the data layer must also
  reflect **enum member-name tables** so multi-value enums render their
  real named value (not a raw integer).

---

## 2. Current architecture (as found)

- **Two distinct surfaces — do not conflate:**
  - **Standalone tool** = `.calibrator-mode` Electron window →
    `server/calibratorServer.js` + `services/calibrator_app.py` (port 9200),
    direct TCP/serial to ONE inverter. Launched from Settings → "Field
    Calibrator" / desktop shortcut. **This is what gets renamed.**
  - **In-dashboard Field Calibration page** (top-nav `field-calibration`)
    → `server/calibrationRoutes.js`; already has fleet-summary scan.
- **Data layer:** `services/calibration_decoder.py` —
  `decode_calibration_block` (81–94, write target, **frozen**) and
  `decode_config_block` (RTC + only 12 context fields). Does **not**
  decode B/C/D/I.
- **Authoritative offset + enum maps:** `_spike/cfg_trif_AU_map.tsv`
  (and `_spike/cfg_trif_AS_map.tsv`), reflected from `_ism/FV.IngeBLL.dll`.
  `_spike/` and `_ism/` are **dev-only / gitignored** → cannot be a runtime
  dependency.
- `/calibration/full-config/{slave}` already reads all 177 regs under one
  lock and calls `decode_config_block`; raw regs available, decode shallow.
- Transport selector returns `"tcp" | "serial"` (app.js ~28460). Standalone
  fleet scan does not exist yet (only the in-dashboard one does).

---

## 3. Design

### 3.1 Branding rename (mechanical, isolated)
- New product name: **"ADSI Utility Tool"**. Button "Field Calibrator" →
  **"Utility Tool"**; "Calibrator Desktop Shortcut" → **"Utility Tool
  Shortcut"**; standalone window title → **"ADSI Utility Tool"**.
- **Frozen (NOT renamed):** `com.engr-m.inverter-dashboard` app ID,
  `.calibrator-mode` CSS class, `calibrator_app.py` /
  `calibratorServer.js` / `calibratorMain.js` filenames, all API paths,
  `_calib*` / `_fcal*` JS prefixes. Rename = **user-facing strings only**.
- Sweep surfaces: `public/index.html` (button labels + visible copy),
  `public/js/app.js` (panel `<h*>` + status strings only — not internal
  comments), standalone window title (electron BrowserWindow `title:` /
  shortcut `productName`), `docs/` User Guide (HTML+MD+PDF — guide-sync
  rule). Acceptance: grep sweep shows zero user-facing old names;
  internal identifiers untouched; standalone tool still launches.

### 3.2 Data layer — full grouped decoder (core work)
- **Dev-time generation, committed artifact.** A documented dev-only
  regen script reflects `FV.IngeBLL.dll` and emits a **committed**
  `services/cfg_trif_map.py` (or packaged `.json`) containing:
  - per-field: offset, field, label, kind/scaling attr, group (A–I),
    `writable=false` for everything except 81–94;
  - **enum member-name tables** (value → name) for every `HREnumAsBitArray`
    enum type (so multi-value enums render named values).
  Runtime never touches `_spike/`/`_ism/`. PyInstaller spec updated to
  bundle the artifact.
- `calibration_decoder.py` gains
  `decode_full_settings(regs) -> {groups, fields[]}` reusing the proven
  parser (`HR_UInt16/Int16/Decenas/Centesimas2Single/DateTime/PutoNodoCan/
  Byte/recta…` + `HREnumAsBitArray` → named value). Vac min/max rendered
  as volts. One clean decoded value per field; no hedge text.
- **Invariants:** `decode_calibration_block` (81–94) byte-for-byte
  unchanged (diff-locked test). PotenciaNominal stays empirical reg 17.
  Firmware lineage: default `CfgTrifAU`; if `CfgTrifAS` class detected and
  its map differs, use AS map (flag a hard mismatch, never silently guess).
- `decode_config_block` extended to embed the `full` block;
  `/calibration/full-config/{slave}` returns it. **No write path change;
  `calibration_io.py` untouched.**

### 3.3 UI — tabbed Utility Tool
- Standalone panel restructured into tabs; every existing element
  re-parented with **zero behavioural change**:
  1. **Calibration** — existing scale-factor / consign / session UI
     verbatim (default tab).
  2. **Node & Startup** (B) · 3. **Grid Protection** (C) ·
     4. **Power & Reactive** (D) · 5. **Isolation & Temp** (I) —
     read-only tables (label · raw hex · decoded · unit), fed by
     `full-config`, themed with existing `.fcal-*` tokens, no inputs.
  6. **Fleet Scan** — TCP-only (disabled + tooltip in serial mode).
- Read tabs use the existing "always-available read-only" trust level
  (like fleet-summary): they do **not** start a calibration session,
  do not trigger lockdown, are safe concurrent with normal operation.

### 3.4 TCP Fleet Scan (standalone)
- New `calibratorServer.js` route (e.g. `GET /api/utility/fleet-scan`)
  gated to `transport === "tcp"`. Iterates the **ipconfig** inverter/slave
  list. Ports the in-dashboard fleet-summary concurrency verbatim:
  in-flight singleton + per-IP serialized lock + progress endpoint +
  graceful per-node timeout (failure recorded, scan continues) — so it
  cannot race the poller or a calibration session.
- Output: per-(inverter,node) B/C/D/I + 81–94 with fleet-median deltas +
  outlier flags (reuse `summarize_fleet`); outliers-only / worst-first
  filters mirror the existing fleet table UX.
- Serial mode: tab disabled (single device — scan meaningless).

---

## 4. Phasing (each independently smoke-testable)

| Phase | Content | Gate |
|---|---|---|
| **A** | Committed offset+enum map artifact + `decode_full_settings` + golden test (decode `400152914R81` blob → assert B/C/D/I named values) | pytest green; `decode_calibration_block` diff-identical |
| **B** | Branding rename + User Guide sync | grep sweep clean; standalone launches; Node 85/85 |
| **C** | Read-only B/C/D/I tabs wired to `full-config` | all 4 groups render; Calibration tab byte-identical behaviour |
| **D** | TCP fleet-scan route + tab + serial-mode gating | scan respects singleton/lock; no poller race; serial disables tab |

Calibration write-path regression (`calibrationSafety.test.js` +
`calibrationRoutes` tests) verified green at **every** phase.

---

## 5. Risks & mitigations
- **Rename blast radius** → user-facing strings only; internal IDs frozen;
  explicit sweep list; grep acceptance gate.
- **Runtime dep on gitignored maps** → commit a generated artifact;
  `_spike`/`_ism` stay dev-only; PyInstaller spec bundles it.
- **Fleet-scan Modbus contention** → reuse existing throttle/lock/singleton;
  author no new concurrency.
- **Calibration regression** → calibration tab only re-parented;
  `decode_calibration_block` diff-locked; safety tests green each phase.
- **Firmware lineage drift (AU vs AS)** → class-keyed map, hard-fail on
  unknown lineage rather than mis-decode.
- **ABI / process** → after any Node-ABI smoke run
  `npm run rebuild:native:electron`; **no auto-commit** (operator reviews
  every commit).

---

## 6. Test plan
- Golden decode test: known `400152914R81` blob → asserts B/C/D/I named/
  scaled values (CountryCode=42, FMin/FMax_Disc=58.20/61.79, CAN=2,
  Modbus=1, TiempoArranqueTension=60 s, etc.).
- Diff test: `decode_calibration_block` output identical pre/post.
- Calibration write path: existing safety + routes tests unchanged & green.
- Fleet scan: singleton rejects concurrent; per-IP lock serializes; serial
  mode disables tab / 403s the route.
- Full smoke 85/85 + pytest; standalone tool launch + each tab manual check.
- User Guide HTML/MD/PDF updated (guide-sync rule).

---

## 7. References
- Audit (this session): decoded B/C/D/I for `400152914R81`.
- `_spike/cfg_trif_AU_map.tsv` / `cfg_trif_AS_map.tsv`,
  `_ism/FV.IngeBLL.dll` (dev-only).
- `services/calibration_decoder.py`, `services/calibrator_app.py`,
  `server/calibratorServer.js`, `server/calibrationRoutes.js`
  (fleet-summary concurrency pattern), `public/js/app.js`
  (`.calibrator-mode` panel, transport selector ~28460),
  `docs/Inverter-Modbus-Reference.md`, `audits/2026-05-17/
  display-firmware-reactive-blink-logic.md`.
