# ADSI Dashboard — Agent Knowledge Base & UI System Architecture

This file documents the core project rules, responsive design patterns, and operational knowledge established for the **ADSI Dashboard** codebase. All AI assistants, models, and agents working on this repository must adhere to these principles.

---

## 1. Golden Rules & Workspace Invariants

1. **Strict Desktop Protection:**
   - **NEVER** modify or break the desktop UI layout.
   - Desktop view (`> 768px`) must remain 100% intact, pristine, and verified.
2. **Mobile Scope Enforcement:**
   - All mobile-specific styles, layout overrides, and component refactors must be strictly placed inside `@media screen and (max-width: 768px)` at the bottom of `public/css/style.css`.
3. **Cache Busting Protocol:**
   - Whenever any edit is made to `public/css/style.css` (or core scripts), increment the stylesheet query parameter in `public/index.html` (e.g. `<link rel="stylesheet" href="css/style.css?v=XX" />`).
4. **Input Overlap Prevention (Mobile Sizing Invariants):**
   - Desktop CSS contains fixed min-widths on inputs/selects (e.g. `.cmp-sel { min-width: 220px }`, `.cmp-text-flex { min-width: 320px }`).
   - On mobile, always enforce:
     ```css
     min-width: 0 !important;
     max-width: 100% !important;
     box-sizing: border-box !important;
     width: 100% !important;
     ```
   - Always wrap form inputs inside semantic `<label class="...-field">` containers with top labels (`display: flex; flex-direction: column; gap: 2px;`) to prevent grid cell collisions and border overlap.
5. **Decluttering on Mobile:**
   - Hide lengthy prose, multi-paragraph help text, `<details class="cmp-howto">`, and `.cmp-target-help` on mobile. Focus on actionable controls, readable metrics, and compact touch targets.

---

## 2. Plant Controller Page (`#page-plant-cap`) UI Patterns

### A. Sub-Navigation Tab Bar (`#plantCapTabStrip`)
- **Zero Horizontal Scrolling:** Rendered as an on-screen structured 2-row grid:
  - **Row 1 (APC Category):** `APC` Badge (Cyan) + 3 tabs (`MW Cap`, `%P Setpoint`, `Grid Code`) taking 100% width.
  - **Row 2 (GRID TESTS Category):** `GRID TESTS` Badge (Indigo) + 4 tabs (`T2 Freq`, `T3 Q-V`, `T5 Sweep`, `Reports`) taking 100% width.
  - All 7 tabs and badges are immediately visible and tap-accessible without swiping.

### B. MW Cap Tab (`#plantCapTabPaneMwCap`)
- **Toolbar:** Balanced 4-column single row (`Status` | `Plant MW` | `Band` | `+ Add Schedule`).
- **Hero Metrics:** Balanced 4-column single row (`PLANT` | `BAND` | `MODE` | `EXPORT LIMIT`).
- **Form:**
  - Row 1 (2-Cols): `Upper Limit (MW)` | `Lower Limit (MW)`.
  - Row 2 (3-Cols): `Sequence` | `Exempted` | `Cooldown (s)`. (The `Exempted` field is always visible in the middle slot).
- **Action Buttons:** Balanced 4-column single row (`Preview Plan` | `Enable Cap` | `Disable Monitoring` | `Release Controlled Inverters`).
- **Status Grid:** 2 columns × 4 rows (8 distinct status cards).
- **Schedule Modal (`#capScheduleModal`):**
  - 8 input fields arranged into a clean 2-column × 4-row grid.
  - Single full-width Save button.
  - Redundant Cancel button hidden (`display: none`).
  - Empty error pill containers strictly hidden (`:empty { display: none !important; }`).

### C. Active Power Control (%P Setpoint) Tab (`#plantCapTabPaneApc`)
- **Scope Selection:** 3-chip segment bar (`Per Node` | `Per Inverter` | `Plant-Wide`).
- **Target Selection:** 2-column dropdowns (`Inverter` & `Node`) + full-width current %P setpoint readout pill.
- **Setpoint & Presets:** Large % input box with a 6-button preset grid (`100` | `90` | `75` | `50` | `25` | `0`).
- **Actions:** 3-column row (`STOP` [Red] | `START` [Green] | `Apply Setpoint` [Accent]).
- **Ramp-Rate Limiter:** Compact inline control row.

### D. Grid Code Tab (`#plantCapTabPaneGridControl`)
- Compact alert pill for safety banner.
- 2-column target selectors with read-state button.
- Side-by-side action buttons (`Set PF` | `Set kVAr` | `Disable Reactive`).

### E. Compliance Tests (`T2 Freq`, `T3 Q-V`, `T5 Sweep`, `Reports`)
- **Target Selector:** 2-column grid (`Inverter` | `Internal node`). Redundant IP input is hidden on mobile.
- **Parameters:**
  - Multi-value sequence inputs (`Sweep`, `Ramp`): Full-width row with horizontal scrolling.
  - Numeric parameter trios (`Hold` | `Settle` | `Tol`): Balanced 3-column row (`repeat(3, minmax(0, 1fr))`).
- **Action Buttons:** Side-by-side balanced 2-column or 3-column buttons (`Run sweep / Start observation`, `Abort`, `Read-back state`).
- **Results Metrics:** 3-column balanced grid with fixed 48px tile height and ellipsis text protection.
- **Live Feed & Run History Tables:** Encapsulated in responsive overflow-x swipe containers.

---

## 3. Data Export Section (`#page-export`) UI Patterns

- **Card Stacking:** `export-grid` styled as a vertical flex container with a `12px` gap (preventing card overlaps).
- **Descriptions & Notes:** `.exp-desc` and `.exp-note` text hidden on mobile.
- **Inputs:** Locked to a uniform `30px` height with clean 2-column or 3-column layouts.
- **Actions:** Side-by-side balanced `Export` and `Cancel` buttons.

---

## 4. Testing & Verification Checklist

When making UI adjustments:
1. **Mobile Verification:** Test in responsive viewport (e.g. 360px–390px width) using headless browser/Puppeteer to confirm zero horizontal scroll on tab bars and zero field overlap.
2. **Desktop Verification:** Take full desktop screenshots (1440px width) to verify zero layout regressions.
3. **Bump CSS Version:** Ensure `public/index.html` has incremented CSS query version before finalizing.
