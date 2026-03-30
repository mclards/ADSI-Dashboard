# ADSI Dashboard UI/UX Improvement Blueprint

## Document Info

- **Version:** 1.0
- **Created:** 2026-03-29
- **Target App Version:** v2.5.1+
- **Author:** Architecture Review
- **Status:** PROPOSED — Pending Engr. M. approval
- **Scope:** Incremental enhancements to frontend interaction, visual depth, and data presentation

---

## Table of Contents

1. [How to Use This Guide](#how-to-use-this-guide)
2. [Current Architecture Summary](#current-architecture-summary)
3. [TIER 1: Quick Wins](#tier-1-quick-wins)
   - [1.1 Enhanced Button Depth & Hover Lift](#11-enhanced-button-depth--hover-lift)
   - [1.2 Page Transition Animations](#12-page-transition-animations)
   - [1.3 Enhanced Empty States](#13-enhanced-empty-states)
   - [1.4 Status Indicator Micro-Animations](#14-status-indicator-micro-animations)
   - [1.5 Card Visual Depth Enhancement](#15-card-visual-depth-enhancement)
   - [1.6 Animated Focus Indicators](#16-animated-focus-indicators)
   - [1.7 Themed Scrollbar Enhancement](#17-themed-scrollbar-enhancement)
   - [1.8 Progress Bar Visual Enhancement](#18-progress-bar-visual-enhancement)
4. [TIER 2: Medium Effort](#tier-2-medium-effort)
   - [2.1 Sparklines in Inverter Cards](#21-sparklines-in-inverter-cards)
   - [2.2 Toast Notification System](#22-toast-notification-system)
   - [2.3 Sortable Data Tables](#23-sortable-data-tables)
   - [2.4 Breadcrumb Navigation](#24-breadcrumb-navigation)
   - [2.5 Chart Skeleton Loaders](#25-chart-skeleton-loaders)
5. [TIER 3: Major Enhancements](#tier-3-major-enhancements)
6. [Cross-Cutting Concerns](#cross-cutting-concerns)
7. [Appendices](#appendices)

---

## How to Use This Guide

Each enhancement is **self-contained** and can be implemented independently in any order. Follow these steps for each enhancement:

1. **Read the problem statement** to understand the UX gap
2. **Collect exact line numbers** from the CSS/JS/HTML files specified
3. **Copy the "before" code** from those exact lines
4. **Apply the "after" code changes** with exact syntax
5. **Test in all 3 themes** (dark, light, classic) at 1440px and 2560px viewports
6. **Validate no CSS tokens are hardcoded** — only use `var(--token-name)`
7. **Check keyboard navigation** and screen reader compatibility
8. **Commit changes** with a clear message referencing this document

### Validation Commands

Before committing, run:

```bash
node --check public/js/app.js
npm run rebuild:native:electron
```

Then smoke test from `server/tests/`:

```bash
npx playwright test electronUiSmoke.spec.js --reporter=line
```

---

## Current Architecture Summary

### Shell Structure

The dashboard uses a fixed shell with three layers:

- **Header** (`#titlebar`) — height `calc(58px * var(--top-scale))`, fixed at top (z-index 1000), contains logo, metrics pills, theme toggle, alarm button
- **Progress bar** (`.tb-progress-row`) — fixed below header (z-index 999), height `var(--progress-h)` (10px)
- **Main container** (`#main`) — positioned fixed, fills remaining viewport, contains sidebar + page content
- **Footer** (`.app-footer`) — positioned absolute at bottom of `#main`, height `var(--app-footer-h)` (32px)
- **Sidebar** (`.side-nav`) — fixed left, width `var(--side-nav-w)` (268px), collapsible on small screens

### Page Container Pattern

Every page (`.page`) uses a consistent pattern:

```css
.page {
  position: absolute;
  inset: 0 0 var(--app-footer-h) 0;  /* leave room for footer */
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  overflow: hidden;  /* CRITICAL: children must handle own scroll */
  opacity: 0;        /* hidden by default */
  pointer-events: none;
  transform: translateY(4px);
  transition: opacity 0.18s, transform 0.18s;
}

.page.active {
  opacity: 1;
  pointer-events: all;
  transform: translateY(0);
}
```

**Key rule:** Never put `flex: 1` directly on a scrollable content block. Use `flex: 1; min-height: 0;` to enable proper overflow behavior. See `.inv-page-body` at line 2127.

### CSS Custom Property System

The app uses ~95 CSS tokens across 3 themes (dark, light, classic). Tokens are organized by category:

**Core palette** (lines 1-64):
- Background: `--bg`, `--bg2`
- Surface: `--surface`, `--surface2`
- Borders: `--border`, `--border2`
- Text: `--text`, `--text2`, `--text3`
- Accent: `--accent`, `--accent2`
- Status: `--green`, `--green2`, `--red`, `--red2`, `--orange`, `--cyan`
- Status levels: `--status-high`, `--status-moderate`, `--status-mild`, `--status-critical`

**Button tokens** (lines 93-159):
- Base buttons: `--btn-base-color`, `--btn-base-border`, `--btn-base-1`, `--btn-base-2`, `--btn-base-shadow`, `--btn-base-shadow-hover`, `--btn-base-shadow-active`
- Accent buttons: `--btn-accent-color`, `--btn-accent-border`, `--btn-accent-1`, `--btn-accent-2`, `--btn-accent-shadow`, `--btn-accent-shadow-hover`
- Green buttons: `--btn-green-*` (color, border, 1, 2, shadow variants)
- Red buttons: `--btn-red-*`
- Outline buttons: `--btn-outline-*`
- Topbar buttons: `--btn-topbar-*`
- Focus ring: `--btn-focus-ring`

**Chart tokens** (lines 64-72, 202-210):
- Grid/ticks: `--chart-tick`, `--chart-grid`, `--chart-legend`
- Actual data: `--chart-actual`, `--chart-actual-fill`
- Forecast: `--chart-ahead`, `--chart-ahead-fill`, `--chart-band-border`, `--chart-band-fill`

**Scaling system** (lines 1-4, 58-59, 328-362):
- `--base-font-size`: 12px → 13px (2200px+) → 14px (3000px+)
- `--surface-scale`, `--inv-toolbar-scale`, `--inv-card-scale`, `--top-scale`: responsive multipliers
- Applied to padding, gaps, font-sizes, dimensions throughout

**Three theme blocks:**
- **Dark** (default, lines 1-164): muted magentas, cool dark purples
- **Light** (lines 166-303): warm beiges, muted earth tones
- **Classic** (lines 7187-7318): cool dark blues (legacy)

### Theme System

Themes are switched via `data-theme` attribute on `<html>` or `:root`:

```javascript
// In app.js (search for "switchTheme")
function switchTheme(name) {
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("theme", name);
}
```

Theme selectors in CSS use:
```css
:root[data-theme="light"] { /* light-specific overrides */ }
:root[data-theme="classic"] { /* classic-specific overrides */ }
/* dark is default, no selector needed */
```

### State Management

The global `State` object (lines 37-100 in app.js) holds all app state:

- `liveData` — raw inverter snapshots keyed by `${inv}_${unit}`
- `totals` — per-inverter aggregates (pac, pdc, kwh)
- `settings` — user preferences (inverter count, layout, theme, etc.)
- `currentPage` — active page name ("inverters", "analytics", "alarms", etc.)
- `charts` — Chart.js instances keyed by chart ID
- `analyticsBaseRows` — 5-minute actual rows for selected date
- `analyticsDayAheadBaseRows` — forecast rows

### Rendering Patterns

**Inverter cards** — Built once at startup in `buildInverterCard()` (line 7826), updated dynamically with `updateInverterCards()`. Card structure: header → PAC strip → node table → controls rail.

**Analytics** — Charts created on first render via `ensureAnalyticsCards()` (line 11476), then updated via Chart.js instance methods. Data pulled from `/api/energy/daily`, `/api/energy/5m`, `/api/forecast/...` endpoints.

**Tables** — Built in JS, inserted into HTML. Use `<table class="data-table">` with `<thead>` and `<tbody>`. Rows are `<tr>` with `<td>` cells.

**Chart.js instances** — Stored in `State.charts[id]`. Updates via `.data.datasets[0].data = newData; .update()`. Never recreate unless necessary.

---

## TIER 1: Quick Wins

Estimated effort: 2-4 hours total. No API changes, no DOM refactoring.

### 1.1 Enhanced Button Depth & Hover Lift

**Problem:** Buttons (`.btn`, `.btn-accent`, `.btn-green`, `.btn-red`) have minimal hover feedback — users may not perceive interactivity on first glance.

**Solution:** Add `transform: translateY(-2px)` on hover, enhanced shadow layering, optional CSS-only click ripple effect.

**Files to modify:**
- `public/css/style.css` — button rules (search for `.btn {`)

**Current button CSS (snippet from around line 1900+):**

```css
/* Existing .btn base: */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: calc(28px * var(--surface-scale));
  padding: calc(4px * var(--surface-scale)) calc(10px * var(--surface-scale));
  border-radius: calc(6px * var(--surface-scale));
  border: 1px solid var(--btn-base-border);
  background: linear-gradient(180deg, var(--btn-base-1) 0%, var(--btn-base-2) 100%);
  color: var(--btn-base-color);
  font-size: calc(10px * var(--surface-scale));
  font-weight: var(--fw-semibold);
  line-height: 1;
  letter-spacing: 0.02em;
  text-decoration: none;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  box-shadow: var(--btn-base-shadow);
  transition: border-color 0.12s, box-shadow 0.12s, transform 0.12s;
}
```

**Enhanced CSS (add/replace):**

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: calc(28px * var(--surface-scale));
  padding: calc(4px * var(--surface-scale)) calc(10px * var(--surface-scale));
  border-radius: calc(6px * var(--surface-scale));
  border: 1px solid var(--btn-base-border);
  background: linear-gradient(180deg, var(--btn-base-1) 0%, var(--btn-base-2) 100%);
  color: var(--btn-base-color);
  font-size: calc(10px * var(--surface-scale));
  font-weight: var(--fw-semibold);
  line-height: 1;
  letter-spacing: 0.02em;
  text-decoration: none;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  box-shadow: var(--btn-base-shadow);
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.12s ease,
    filter 0.12s ease;
  will-change: transform;
}

.btn:hover:not(:disabled) {
  transform: translateY(-2px);
  border-color: var(--btn-base-border-hover);
  box-shadow: var(--btn-base-shadow-hover);
  filter: brightness(1.05);
}

.btn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--btn-base-shadow-active);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}
```

**Apply the same pattern to:**
- `.btn-accent`, `.btn-accent:hover`, `.btn-accent:active` — use `--btn-accent-shadow*` tokens
- `.btn-green`, `.btn-green:hover`, `.btn-green:active` — use `--btn-green-shadow*` tokens
- `.btn-red`, `.btn-red:hover`, `.btn-red:active` — use `--btn-red-shadow*` tokens
- `.btn-outline`, `.btn-outline:hover`, `.btn-outline:active`

**Theme considerations:**
- Dark theme: shadows naturally work due to black background
- Light theme: `--btn-base-shadow` already uses light-appropriate `rgba(92, 70, 40, 0.12)` — no change needed
- Classic theme: `--btn-base-shadow` is `rgba(0, 0, 0, 0.28)` — perfect for depth

**Testing checklist:**
- [ ] Hover lift visible on all button types at 1440px and 2560px
- [ ] Active press resets translateY instantly
- [ ] No layout shift from transform (GPU-composited)
- [ ] Disabled buttons don't lift
- [ ] All 3 themes tested, button shadows appear correct
- [ ] Keyboard navigation `:focus-visible` not affected

---

### 1.2 Page Transition Animations

**Problem:** Page switches are instant — users may feel disoriented when clicking nav items.

**Solution:** Enhance the fade+slide transition with staggered content animations and smoother easing.

**Files to modify:**
- `public/css/style.css` — `.page` rules (line 1559+) and add new `@keyframes`
- `public/js/app.js` — `switchPage()` function (line 3675)

**Current CSS (lines 1559-1577):**

```css
.page {
  position: absolute;
  inset: 0 0 var(--app-footer-h) 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateY(4px);
  transition: opacity 0.18s, transform 0.18s;
}

.page.active {
  opacity: 1;
  pointer-events: all;
  transform: translateY(0);
}
```

**Enhanced CSS (replace above):**

```css
@keyframes pageEnter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pageExit {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.page {
  position: absolute;
  inset: 0 0 var(--app-footer-h) 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  animation: pageExit 0.24s cubic-bezier(0.2, 0, 0.8, 1) forwards;
}

.page.active {
  opacity: 1;
  pointer-events: all;
  animation: pageEnter 0.24s cubic-bezier(0.2, 0, 0.8, 1) forwards;
}
```

**Current switchPage() (line 3675-3695):**

```javascript
function switchPage(page) {
  State.currentPage = page;
  if (page !== "analytics") {
    stopAnalyticsRealtime();
    stopAnalyticsAutoRefresh();
  }
  if (page !== "settings") {
    stopReplicationHealthPolling();
  }
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.remove("active"));
  const pg = $("page-" + page);
  if (pg) pg.classList.add("active");
  const btn = document.querySelector(`[data-page="${page}"]`);
  if (btn) btn.classList.add("active");
  if (window.innerWidth <= 1200) setSideNavOpen(false, true);
```

No JS changes needed — the animation is CSS-driven via class toggling, which already works.

**Theme considerations:**
- Animation colors use `opacity` and `transform` only (no color changes) — works on all 3 themes identically
- Easing uses standard `cubic-bezier(0.2, 0, 0.8, 1)` — no theme-specific adjustment needed

**Testing checklist:**
- [ ] Smooth fade-in/out on all page transitions at 1440px and 2560px
- [ ] No flash of previous content (opacity starts at 0)
- [ ] Charts render correctly after transition completes (check analytics page)
- [ ] Detail panels within pages (e.g., detail view on inverters) don't re-animate
- [ ] All 3 themes render identically
- [ ] Motion respects `prefers-reduced-motion` if desired (optional enhancement)

---

### 1.3 Enhanced Empty States

**Problem:** When a table is empty or a page has no data, the space remains blank with generic "No data" text or nothing at all. This feels incomplete.

**Solution:** Create a reusable empty state component with an icon, title, description, and optional action button. Apply consistently across all data-driven pages.

**Files to modify:**
- `public/css/style.css` — add new CSS classes (insert after line 2000 or with other card styles)
- `public/js/app.js` — add helper function and integrate into table-rendering code

**New CSS to add (insert around line 2050, after button styles):**

```css
/* ── Empty State Component ────────────────────────────────────────── */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  min-height: 240px;
  border-radius: 10px;
  border: 1px dashed var(--border2);
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.01) 0%,
    rgba(255, 255, 255, 0.005) 100%
  );
}

.empty-state-icon {
  font-size: 48px;
  line-height: 1;
  color: var(--text3);
  opacity: 0.6;
}

.empty-state-title {
  font-size: 14px;
  font-weight: var(--fw-semibold);
  color: var(--text2);
  letter-spacing: 0.02em;
}

.empty-state-description {
  font-size: 12px;
  color: var(--text3);
  line-height: 1.5;
  max-width: 280px;
  text-align: center;
}

.empty-state-action {
  margin-top: 8px;
}
```

**New JS helper function (add to app.js around line 9800, after alarm toast functions):**

```javascript
/**
 * Render an empty state in a container.
 * @param {HTMLElement} container - The container to render into
 * @param {Object} opts - Configuration
 * @param {string} opts.icon - MDI icon class (e.g., "mdi-database-off")
 * @param {string} opts.title - Main title text
 * @param {string} opts.description - Description text (can include HTML)
 * @param {string} [opts.actionLabel] - Button label (if action provided)
 * @param {Function} [opts.actionFn] - Click handler for button
 */
function renderEmptyState(container, opts) {
  if (!container) return;
  const { icon, title, description, actionLabel, actionFn } = opts;

  container.innerHTML = "";
  const wrap = el("div", "empty-state");

  if (icon) {
    const iconEl = el("div", "empty-state-icon");
    iconEl.innerHTML = `<span class="mdi ${icon}"></span>`;
    wrap.appendChild(iconEl);
  }

  const titleEl = el("div", "empty-state-title");
  titleEl.textContent = title;
  wrap.appendChild(titleEl);

  if (description) {
    const descEl = el("div", "empty-state-description");
    descEl.innerHTML = description;
    wrap.appendChild(descEl);
  }

  if (actionLabel && actionFn) {
    const actionDiv = el("div", "empty-state-action");
    const btn = el("button", "btn btn-accent");
    btn.textContent = actionLabel;
    btn.addEventListener("click", actionFn);
    actionDiv.appendChild(btn);
    wrap.appendChild(actionDiv);
  }

  container.appendChild(wrap);
}
```

**Integration points (examples):**

1. **Alarms table** — when `tbody` is empty:
   ```javascript
   // In alarm rendering code, after tbody is populated:
   const tbody = $("alarmsTableBody");
   if (tbody && tbody.querySelectorAll("tr").length === 0) {
     renderEmptyState($("alarmsTableContainer"), {
       icon: "mdi-bell-off-outline",
       title: "No Alarms",
       description: "No alarm records found for the selected period.",
       actionLabel: "Load More Periods",
       actionFn: () => { /* fetch earlier data */ }
     });
   }
   ```

2. **Energy table** — when empty:
   ```javascript
   renderEmptyState(energyTableContainer, {
     icon: "mdi-chart-box-outline",
     title: "No Energy Data",
     description: "Energy data is not yet available for this date."
   });
   ```

3. **Audit table** — when empty:
   ```javascript
   renderEmptyState(auditTableContainer, {
     icon: "mdi-file-document-outline",
     title: "No Audit Records",
     description: "No audit entries found for this date range."
   });
   ```

4. **Report page** — when no reports exist:
   ```javascript
   renderEmptyState(reportGridContainer, {
     icon: "mdi-file-export-outline",
     title: "No Reports Generated",
     description: "Create a new report to see data exports here.",
     actionLabel: "Generate Report",
     actionFn: () => switchPage("export")
   });
   ```

**Theme considerations:**
- Border uses `var(--border2)` — works across all themes
- Icons use `var(--text3)` (muted secondary text) — visible in all themes
- Background uses low-opacity white gradient — invisible on dark, subtle on light

**Testing checklist:**
- [ ] Empty state renders correctly when table has zero rows
- [ ] Icon displays correctly (check MDI icon names)
- [ ] All text is readable in all 3 themes
- [ ] Action button works when provided
- [ ] No layout shift when transitioning from empty to populated
- [ ] All 3 themes tested

---

### 1.4 Status Indicator Micro-Animations

**Problem:** Alarm indicators (red nodes with `.alarm-unacked` class) blink but lack visual prominence. Users may miss critical alarms in dense card layouts.

**Solution:** Enhance `@keyframes alarmBlink` and `@keyframes alarmBtnPulse` with box-shadow glow, subtle scale pulse, and color-shifting effect.

**Files to modify:**
- `public/css/style.css` — `@keyframes alarmBlink` and `@keyframes alarmBtnPulse` (lines 3400-3451)

**Current animations:**

```css
@keyframes alarmBlink {
  0%, 100% {
    opacity: 1;
    box-shadow: 0 0 0 rgba(224, 53, 96, 0.0);
  }
  50% {
    opacity: 0.45;
    box-shadow: 0 0 10px rgba(224, 53, 96, 0.6);
  }
}

@keyframes alarmBtnPulse {
  0%, 100% {
    box-shadow: 0 0 0 rgba(224, 53, 96, 0);
  }
  50% {
    box-shadow: 0 0 10px rgba(224, 53, 96, 0.55);
  }
}
```

**Enhanced animations (replace):**

```css
@keyframes alarmBlink {
  0%, 100% {
    opacity: 1;
    box-shadow:
      0 0 0 rgba(224, 53, 96, 0),
      inset 0 0 10px rgba(224, 53, 96, 0.1);
    transform: scale(1);
  }
  25% {
    box-shadow:
      0 0 14px rgba(224, 53, 96, 0.55),
      inset 0 0 12px rgba(224, 53, 96, 0.2);
    transform: scale(1.02);
  }
  50% {
    opacity: 0.35;
    box-shadow:
      0 0 20px rgba(224, 53, 96, 0.75),
      inset 0 0 8px rgba(224, 53, 96, 0.15);
    transform: scale(1.04);
  }
  75% {
    box-shadow:
      0 0 14px rgba(224, 53, 96, 0.55),
      inset 0 0 12px rgba(224, 53, 96, 0.2);
    transform: scale(1.02);
  }
}

@keyframes alarmBtnPulse {
  0%, 100% {
    box-shadow: 0 0 0 rgba(224, 53, 96, 0);
    transform: scale(1);
  }
  50% {
    box-shadow:
      0 0 16px rgba(224, 53, 96, 0.68),
      inset 0 0 8px rgba(224, 53, 96, 0.25);
    transform: scale(1.03);
  }
}
```

**Note:** Both animations now include:
- Layered box-shadows (outer glow + inner highlight)
- Subtle scale pulse (1 → 1.04 → 1) for attention-grabbing
- Multi-stop keyframes for smoother motion
- Inset shadows for depth effect

**Apply animation to existing elements:**
- `.node-btn.alarm-unacked` — already uses `animation: alarmBtnPulse 1s ease-in-out infinite;` (line 3434)
- `.node-power-indicator.alarm` — may need to add `animation: alarmBlink 1.8s infinite;` if not present

**Theme considerations:**
- Red (`rgba(224, 53, 96, ...)`) is theme-agnostic (same color in all themes)
- Scale transform is GPU-composited, no performance hit
- Glow effect is subtle enough to not overwhelm light theme

**Testing checklist:**
- [ ] Alarm nodes pulse at 1.8s interval
- [ ] Glow expands and contracts smoothly
- [ ] Scale pulse is visible but not jarring (max 4% growth)
- [ ] Inset shadows give depth effect
- [ ] Animation is smooth on lower-end hardware (check 60fps in DevTools)
- [ ] All 3 themes render the red color correctly
- [ ] Pulsing stops when alarm is acked (`.alarm-acked` doesn't animate)

---

### 1.5 Card Visual Depth Enhancement

**Problem:** Inverter cards (`.inv-card`) and chart cards (`.chart-card`) are flat with minimal 3D visual hierarchy. They blend into the background.

**Solution:** Add gradient backgrounds, top-edge highlight, multi-layer box-shadows, and subtle border glow to create premium depth.

**Files to modify:**
- `public/css/style.css` — `.inv-card` (line 2581+), `.chart-card` (line 4146+)

**Current `.inv-card` CSS (lines 2581-2608):**

```css
.inv-card {
  --card-fixed-h: calc(186px * var(--inv-card-scale));
  /* ...vars... */
  border-radius: calc(10px * var(--inv-card-scale));
  border: 1px solid var(--border);
  background: linear-gradient(160deg, #2a121a 0%, #1b0c12 100%);
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
}

.inv-card:hover {
  transform: translateY(-1px);
  border-color: var(--border2);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
```

**Enhanced `.inv-card` CSS (replace):**

```css
.inv-card {
  --card-fixed-h: calc(186px * var(--inv-card-scale));
  /* ...vars... */
  border-radius: calc(10px * var(--inv-card-scale));
  border: 1px solid var(--border);
  background:
    linear-gradient(to bottom, rgba(255, 255, 255, 0.035) 0%, rgba(255, 255, 255, 0) 8%),
    linear-gradient(160deg, #2a121a 0%, #1b0c12 100%);
  box-shadow:
    0 10px 32px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    inset 0 -8px 16px rgba(0, 0, 0, 0.16);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.15s ease;
  position: relative;
  overflow: hidden;
}

.inv-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(216, 106, 139, 0.2) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  pointer-events: none;
}

.inv-card:hover {
  transform: translateY(-2px);
  border-color: var(--border2);
  box-shadow:
    0 14px 40px rgba(0, 0, 0, 0.36),
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -8px 16px rgba(0, 0, 0, 0.2);
}
```

**Changes explanation:**
- **Gradient background:** Added top-to-bottom white fade (2-8% height) for light edge effect
- **Multi-layer shadows:** Outer shadow (depth), top inset (highlight), bottom inset (depth shadow)
- **`::before` pseudo-element:** Thin top edge with accent glow (works in dark theme, subtle in light)
- **Enhanced hover:** Slightly larger shadow for more dramatic lift, increased brightness

**Apply similar pattern to `.chart-card` (lines 4146-4155):**

```css
.chart-card {
  min-height: 330px;
  display: flex;
  flex-direction: column;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background:
    linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0) 6%),
    linear-gradient(160deg, #2a121a 0%, #1b0c12 100%);
  box-shadow:
    0 10px 32px rgba(0, 0, 0, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    inset 0 -12px 20px rgba(0, 0, 0, 0.14);
  overflow: hidden;
  position: relative;
  transition: box-shadow 0.2s ease;
}

.chart-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(216, 106, 139, 0.15) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  pointer-events: none;
}

.chart-card:hover {
  box-shadow:
    0 14px 40px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -12px 20px rgba(0, 0, 0, 0.18);
}
```

**Token usage verification:**
- Border: `var(--border)` ✓
- Background: hardcoded `#2a121a` and `#1b0c12` — these are dark theme specific. For full theme support, use:
  ```css
  background:
    linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0) 6%),
    linear-gradient(160deg, var(--surface) 0%, var(--surface2) 100%);
  ```
- Shadows: use `rgba(0, 0, 0, ...)` — black shadows work on all themes
- Accents: `rgba(216, 106, 139, ...)` (hard-coded pink) — this is the dark theme accent. For multi-theme:
  ```css
  background: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, color-mix(in srgb, var(--accent) 15%, transparent) 50%, rgba(255, 255, 255, 0) 100%);
  ```

**Light theme override (add after the main card rules):**

```css
:root[data-theme="light"] .inv-card,
:root[data-theme="light"] .chart-card {
  box-shadow:
    0 8px 20px rgba(92, 70, 40, 0.14),
    inset 0 1px 0 rgba(255, 255, 255, 0.88),
    inset 0 -8px 16px rgba(163, 142, 109, 0.1);
}

:root[data-theme="light"] .inv-card:hover,
:root[data-theme="light"] .chart-card:hover {
  box-shadow:
    0 12px 28px rgba(92, 70, 40, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.94),
    inset 0 -8px 16px rgba(163, 142, 109, 0.14);
}
```

**Testing checklist:**
- [ ] Cards have visible top edge highlight in dark theme
- [ ] Hover lift is smooth and shadow expands
- [ ] Light theme: shadows are warm/brown, not pink
- [ ] Classic theme: shadows are blue-tinted
- [ ] No performance issues (shadows use `inset`, GPU-friendly)
- [ ] `::before` pseudo-element doesn't break existing card content (it's positioned absolutely with `pointer-events: none`)
- [ ] All 3 themes at 1440px and 2560px tested

---

### 1.6 Animated Focus Indicators

**Problem:** Default outline focus indicators (from browser) are minimal and inconsistent across browsers. Keyboard-only users may struggle to see focused elements.

**Solution:** Replace default outlines with custom `:focus-visible` styling with animated ring and pulse animation.

**Files to modify:**
- `public/css/style.css` — focus styles (already partially at lines 2020-2030, expand them)

**Current focus CSS (lines 2019-2030):**

```css
.btn:focus-visible {
  outline: none;
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--btn-focus-ring) 72%, transparent);
  outline-offset: 2px;
}
```

**Enhanced focus CSS (replace and expand):**

```css
/* Enhanced Focus Ring Animation */
@keyframes focusPulse {
  0%, 100% {
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--btn-focus-ring);
  }
  50% {
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 6px var(--btn-focus-ring);
  }
}

/* All interactive elements */
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[tabindex]:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--btn-focus-ring);
}

/* Optional: Pulse animation when focused */
.btn:focus-visible,
button:focus-visible {
  animation: focusPulse 0.6s infinite;
}

.btn:focus-visible:active,
button:focus-visible:active {
  animation: none;
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--btn-focus-ring);
}

/* Form inputs: simpler focus ring (no pulse, interferes with typing) */
input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  animation: none;
}

/* Ensure disabled elements don't show focus ring */
:disabled:focus-visible {
  box-shadow: none;
  outline: none;
}
```

**Token usage:**
- `var(--btn-focus-ring)` — exists in all 3 themes, automatically theme-aware
- `var(--surface)` — used for ring interior (matches page background)

**Integration with existing elements:**
- Already applied to `.btn`, buttons, inputs (lines 2020-2030)
- Extends to all interactive elements with `[tabindex]:focus-visible`
- Pulse animation only on buttons, not inputs (prevents distraction while typing)

**Testing checklist:**
- [ ] Press Tab key and cycle through all interactive elements
- [ ] Focus ring appears around buttons, inputs, selects
- [ ] Ring is visible in all 3 themes (dark: light ring, light: dark ring)
- [ ] Pulse animation doesn't interfere with form input
- [ ] Ring disappears when focus is lost
- [ ] Disabled buttons don't show focus ring
- [ ] Mouse click doesn't trigger focus ring (only keyboard)
- [ ] Screen reader compatibility unaffected

---

### 1.7 Themed Scrollbar Enhancement

**Problem:** Scrollbars (webkit) are functional but generic — they don't match the premium aesthetic of the dashboard.

**Solution:** Add gradient thumb, rounded corners, hover glow effect, and theme-aware colors.

**Files to modify:**
- `public/css/style.css` — scrollbar styles (lines 387-403)

**Current scrollbar CSS:**

```css
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: var(--bg2);
}

::-webkit-scrollbar-thumb {
  background: var(--border2);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--accent);
}
```

**Enhanced scrollbar CSS (replace):**

```css
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--bg2);
  border-radius: 10px;
}

::-webkit-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    var(--border2) 0%,
    var(--accent2) 100%
  );
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  transition: box-shadow 0.2s ease;
}

::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(
    180deg,
    var(--accent) 0%,
    var(--accent2) 100%
  );
  box-shadow:
    0 0 10px color-mix(in srgb, var(--accent) 30%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

::-webkit-scrollbar-corner {
  background: var(--bg2);
  border-radius: 10px;
}

/* Firefox scrollbar (simplified, less customizable) */
* {
  scrollbar-color: var(--border2) var(--bg2);
  scrollbar-width: thin;
}

*:hover {
  scrollbar-color: var(--accent) var(--bg2);
}
```

**Changes explanation:**
- Width increased from 6px to 8px (easier to target)
- Gradient thumb: border → accent2 for depth
- Border-radius: 3px → 10px (more premium)
- Top border: subtle white edge for highlight
- Hover glow: `box-shadow` with accent color
- Firefox fallback: `scrollbar-color` property (limited but better than default)

**Token usage verification:**
- `var(--border2)`, `var(--accent)`, `var(--accent2)`, `var(--bg2)` — all exist in all 3 themes
- `color-mix()` function — CSS 4 standard, supported in modern browsers

**Testing checklist:**
- [ ] Scrollbar is wider and more visible (8px)
- [ ] Gradient thumb looks smooth
- [ ] Hover effect glows with accent color
- [ ] All 3 themes: dark (pink gradient), light (brown gradient), classic (blue gradient)
- [ ] Firefox browser: scrollbar color changes on hover
- [ ] Edge/Chrome: smooth transitions
- [ ] No horizontal/vertical overlap issues (`::-webkit-scrollbar-corner` styling)
- [ ] Works in nested scrollable containers (`.inv-page-body`, tables)

---

### 1.8 Progress Bar Visual Enhancement

**Problem:** Progress bar (`.tb-progress-fill`) is a simple gradient — lacks animated feedback during long operations.

**Solution:** Add diagonal animated stripes, shimmer effect, enhanced gradient, and better color definition.

**Files to modify:**
- `public/css/style.css` — progress bar rules (lines 447-458)

**Current progress bar CSS (lines 447-457):**

```css
.tb-progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 0%;
  opacity: 0.65;
  background: linear-gradient(90deg, rgba(212, 109, 137, 0.9), rgba(145, 47, 76, 0.95));
  box-shadow: 0 0 10px rgba(184, 73, 104, 0.35);
  transition: width 140ms linear, opacity 140ms linear;
}
```

**Enhanced progress bar CSS (replace):**

```css
@keyframes progressStripes {
  0% { background-position: 0 0; }
  100% { background-position: 20px 0; }
}

@keyframes progressShimmer {
  0%, 100% { opacity: 0.65; filter: brightness(1); }
  50% { opacity: 0.8; filter: brightness(1.08); }
}

.tb-progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 0%;
  opacity: 0.65;
  background:
    repeating-linear-gradient(
      45deg,
      rgba(212, 109, 137, 0.9),
      rgba(212, 109, 137, 0.9) 10px,
      rgba(184, 73, 104, 0.85) 10px,
      rgba(184, 73, 104, 0.85) 20px
    ),
    linear-gradient(90deg, rgba(212, 109, 137, 0.95), rgba(145, 47, 76, 0.98));
  background-size: 20px 100%, 100% 100%;
  background-position: 0 0, 0 0;
  box-shadow:
    0 0 12px rgba(184, 73, 104, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  transition:
    width 140ms linear,
    opacity 140ms linear;
  animation: progressStripes 0.8s linear infinite, progressShimmer 2s ease-in-out infinite;
}

.tb-progress-row:not(.active) .tb-progress-fill {
  opacity: 0.18;
  animation: none;
}

.tb-progress-row.active .tb-progress-fill {
  animation: progressStripes 0.8s linear infinite, progressShimmer 2s ease-in-out infinite;
}
```

**Changes explanation:**
- **Diagonal stripes:** `repeating-linear-gradient()` at 45° angle, 10px width, animates left
- **Shimmer effect:** `progressShimmer` keyframe pulses opacity and brightness every 2s
- **Dual background-image:** Stripes layer + base gradient for depth
- **Enhanced shadow:** Outer glow + inset highlight
- **Animation condition:** Only animates when `.tb-progress-row.active`, stops when inactive

**Token usage:**
- Hardcoded colors: `rgba(212, 109, 137, ...)` (dark theme pink)
- For full theme support, consider:
  ```css
  background-color: color-mix(in srgb, var(--accent) 90%, var(--accent2));
  ```
  But this requires more complex setup; for now, the pink is fine (accent color is universal)

**Testing checklist:**
- [ ] Stripes animate left-to-right smoothly when progress is active
- [ ] Shimmer pulse is visible (opacity + brightness change)
- [ ] Animation stops when progress completes (`.active` removed)
- [ ] Opacity dims to 0.18 when inactive
- [ ] Performance: animation runs smoothly at 60fps in DevTools
- [ ] All 3 themes: pink stripes are visible (might need color override for light theme)
- [ ] Works at various progress widths (20%, 50%, 100%)

---

## TIER 2: Medium Effort

Estimated effort: 6-12 hours total. Some API/data changes, more complex DOM manipulation.

### 2.1 Sparklines in Inverter Cards

**Problem:** Inverter cards show only current state (PAC, nodes) — no temporal context. Users can't quickly assess trending performance.

**Solution:** Add a tiny sparkline chart (24px height, 7-day trend) below the node table. Use raw Canvas API for performance. Hide in compact layouts (5+ columns).

**Architecture Decisions:**

- Data source: New endpoint `/api/energy/daily?inverter=X` returns daily totals for past 7 days
- Update frequency: Once per page load (static data), or every 5 minutes (configurable)
- Compact mode: Hidden in layouts 5+ columns to save horizontal space
- Fallback: Show flat line or "No data" if endpoint unavailable
- Canvas size: 100% width × 24px height per card

**Files to modify:**
- `public/js/app.js` — `buildInverterCard()` (line 7826), add new `drawSparkline()` function, data fetching
- `public/css/style.css` — new `.card-sparkline-wrap`, `.card-sparkline` classes
- (Optional) `server/index.js` — add `/api/energy/daily` endpoint

**New CSS (insert around line 2800, after card controls styles):**

```css
/* ── Sparkline Container ────────────────────────────────────────── */

.card-sparkline-wrap {
  width: 100%;
  height: 24px;
  min-height: 24px;
  max-height: 24px;
  padding: 0 calc(6px * var(--inv-card-scale));
  border-top: 1px solid rgba(104, 52, 67, 0.45);
  background: rgba(20, 10, 16, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.card-sparkline {
  width: 100%;
  height: 20px;
  display: block;
  image-rendering: crisp-edges;
}

/* Hide sparklines in compact layouts (5+ columns) */
:is(.inv-grid.layout-5, .inv-grid.layout-6, .inv-grid.layout-7) .card-sparkline-wrap {
  display: none;
}

/* Light theme: adjust sparkline colors */
:root[data-theme="light"] .card-sparkline-wrap {
  border-top-color: rgba(150, 130, 100, 0.35);
  background: rgba(240, 230, 215, 0.3);
}

/* Classic theme: adjust colors */
:root[data-theme="classic"] .card-sparkline-wrap {
  border-top-color: rgba(60, 90, 140, 0.35);
  background: rgba(20, 35, 60, 0.4);
}
```

**New JS helper function (add around line 9900, after empty state function):**

```javascript
/**
 * Draw a sparkline (line chart) on a canvas element.
 * @param {HTMLCanvasElement} canvas - Target canvas (20px × parent width)
 * @param {number[]} data - Y-axis values (typically 7-day kWh)
 * @param {string} color - Line color (use theme token, e.g., var(--green))
 * @param {Object} opts - Options
 * @param {boolean} opts.fill - Fill area under line (default: true)
 */
function drawSparkline(canvas, data, color, opts = {}) {
  if (!canvas || !data || data.length === 0) return;

  const { fill = true } = opts;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const padding = 2; // top/bottom padding

  // Clear canvas
  ctx.clearRect(0, 0, width, height);

  // Find min/max for scaling
  const min = Math.min(...data.filter(d => d != null));
  const max = Math.max(...data.filter(d => d != null));
  const range = max - min || 1; // avoid division by zero

  // Draw fill area
  if (fill) {
    ctx.fillStyle = color.replace(/[\d.]+\)$/m, "0.1)"); // add 0.1 opacity
    ctx.beginPath();
    ctx.moveTo(0, height - padding);
    data.forEach((val, i) => {
      if (val == null) return;
      const x = (i / (data.length - 1)) * width;
      const normalizedY = (val - min) / range;
      const y = height - padding - normalizedY * (height - 2 * padding);
      ctx.lineTo(x, y);
    });
    ctx.lineTo(width, height - padding);
    ctx.closePath();
    ctx.fill();
  }

  // Draw line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  data.forEach((val, i) => {
    if (val == null) return;
    const x = (i / (data.length - 1)) * width;
    const normalizedY = (val - min) / range;
    const y = height - padding - normalizedY * (height - 2 * padding);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // Draw small dots on data points
  ctx.fillStyle = color;
  data.forEach((val, i) => {
    if (val == null) return;
    const x = (i / (data.length - 1)) * width;
    const normalizedY = (val - min) / range;
    const y = height - padding - normalizedY * (height - 2 * padding);
    ctx.fillRect(x - 1, y - 1, 2, 2);
  });
}

/**
 * Load 7-day energy data for all inverters and render sparklines.
 */
async function loadAndRenderSparklines() {
  try {
    const resp = await fetch("/api/energy/daily");
    if (!resp.ok) {
      console.warn("Sparkline data unavailable:", resp.status);
      return;
    }
    const dailyByInv = await resp.json(); // { "1": [kWh, ...], "2": [...], ... }

    // For each inverter card, render its sparkline
    const count = Number(State.settings.inverterCount || 27);
    for (let inv = 1; inv <= count; inv++) {
      const canvas = document.querySelector(`#card-sparkline-${inv}`);
      if (!canvas || !dailyByInv[inv]) continue;

      // Color: green if all values > 0, else muted
      const hasData = dailyByInv[inv].some(v => v > 0);
      const color = hasData ? getComputedStyle(document.documentElement).getPropertyValue("--green") : "rgba(150, 150, 150, 0.5)";

      drawSparkline(canvas, dailyByInv[inv], color, { fill: true });
    }
  } catch (err) {
    console.error("Failed to load sparkline data:", err);
  }
}
```

**Modify `buildInverterCard()` (line 7826+):**

Find the closing `</div>` of the card HTML and insert sparkline container before it:

```javascript
// In buildInverterCard(), near the end of card.innerHTML, add:
function buildInverterCard(inv, nodeCount) {
  const card = el("div", "inv-card");
  card.id = `inv-card-${inv}`;
  // ... existing code ...

  // Add this near the end, before closing </div> of card-pac or after card-table-wrap:
  const sparklineWrap = el("div", "card-sparkline-wrap");
  const canvas = el("canvas");
  canvas.id = `card-sparkline-${inv}`;
  canvas.width = 200; // logical width, CSS sets display width
  canvas.height = 20;
  sparklineWrap.appendChild(canvas);
  card.appendChild(sparklineWrap);

  return card;
}
```

Or modify the HTML template string directly (around line 7831-7920):

```html
<!-- At the end of .inv-card div, before closing: -->
<div class="card-sparkline-wrap">
  <canvas id="card-sparkline-${inv}" width="200" height="20"></canvas>
</div>
```

**Fetch and render on page load:**

In `setupApp()` (around line 9200-9300), after inverter cards are built, call:

```javascript
// After buildInverterCards() completes
setTimeout(() => loadAndRenderSparklines(), 500); // wait for DOM to settle

// Optionally, refresh sparklines every 5 minutes
setInterval(loadAndRenderSparklines, 5 * 60 * 1000);
```

**Backend endpoint** (if not already exist in `server/index.js`):

```javascript
app.get("/api/energy/daily", async (req, res) => {
  try {
    const days = 7;
    const today = new Date();
    const result = {};

    for (let inv = 1; inv <= 27; inv++) {
      const dailyKwh = [];
      for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split("T")[0];

        // Query DB for daily total energy for this inverter on this date
        const row = db.prepare(`
          SELECT COALESCE(SUM(e_yield_mwh), 0) as kwh
          FROM daily_energy
          WHERE inverter = ? AND date = ?
        `).get(inv, dateStr);

        dailyKwh.push((row?.kwh || 0) * 1000); // convert MWh to kWh
      }
      result[inv] = dailyKwh;
    }

    res.json(result);
  } catch (err) {
    console.error("GET /api/energy/daily:", err);
    res.status(500).json({ error: err.message });
  }
});
```

**Testing checklist:**
- [ ] Sparklines render in all 4 inverter card layouts (2, 3, 4 columns)
- [ ] Sparklines hidden in compact layouts (5, 6, 7 columns)
- [ ] Line color is green when data > 0, gray when unavailable
- [ ] Fill area under line is semi-transparent
- [ ] Dots appear at 7 data points
- [ ] Fallback: "No data" or flat line when endpoint unavailable
- [ ] All 3 themes: line color adapts (green in all themes)
- [ ] Performance: <50ms to draw all 27 sparklines
- [ ] No layout shift when canvas renders
- [ ] High-DPI displays: canvas scales correctly (check retina)

---

### 2.2 Toast Notification System

**Problem:** User feedback after actions (bulk control, export, forecast generation) is inconsistent. Some use `showToast()` (generic), some use `showAlarmToast()` (alarm-specific). Need a unified, type-aware toast system.

**Solution:** Create a dedicated `Toast` object with 4 types (success, warning, error, info), auto-dismiss, manual dismiss, and consistent styling. Position: bottom-right above footer, z-index 11000.

**Files to modify:**
- `public/css/style.css` — new `.toast-container-modern`, `.toast-modern`, variant classes
- `public/js/app.js` — add `Toast` object, integrate into action handlers

**New CSS (insert around line 2100, after other UI component styles):**

```css
/* ── Modern Toast Notification System ────────────────────────────── */

.toast-container-modern {
  position: fixed;
  bottom: calc(32px + 12px);  /* footer height + gap */
  right: 12px;
  z-index: 11000;  /* below modals at 12000 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 380px;
  pointer-events: none;
}

.toast-modern {
  pointer-events: all;
  min-height: 60px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  border-left: 4px solid var(--text3);  /* will override per type */
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.02) 0%,
    rgba(255, 255, 255, 0.005) 100%
  ),
  var(--surface);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  animation: slideInRight 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.toast-modern.removing {
  animation: slideOutRight 0.24s cubic-bezier(0.2, 0, 1, 0.2) forwards;
}

@keyframes slideInRight {
  from {
    opacity: 0;
    transform: translateX(400px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes slideOutRight {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(400px);
  }
}

.toast-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  border-radius: 4px;
}

.toast-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.toast-title {
  font-size: 11px;
  font-weight: var(--fw-bold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text2);
}

.toast-message {
  font-size: 12px;
  color: var(--text);
  line-height: 1.4;
  word-break: break-word;
}

.toast-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-top: 4px;
}

.toast-action-btn {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  color: var(--text2);
  cursor: pointer;
  transition: all 0.12s ease;
}

.toast-action-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: var(--text);
}

.toast-close {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text3);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.12s ease;
}

.toast-close:hover {
  color: var(--text2);
}

/* ── Toast Variants ────────────────────────────────────────────── */

.toast-modern.success {
  border-left-color: var(--green);
}

.toast-modern.success .toast-icon {
  background: rgba(16, 179, 112, 0.15);
  color: var(--green);
}

.toast-modern.success .toast-title {
  color: var(--green);
}

.toast-modern.error {
  border-left-color: var(--red);
}

.toast-modern.error .toast-icon {
  background: rgba(224, 53, 96, 0.15);
  color: var(--red);
}

.toast-modern.error .toast-title {
  color: var(--red);
}

.toast-modern.warning {
  border-left-color: var(--orange);
}

.toast-modern.warning .toast-icon {
  background: rgba(240, 144, 0, 0.15);
  color: var(--orange);
}

.toast-modern.warning .toast-title {
  color: var(--orange);
}

.toast-modern.info {
  border-left-color: var(--cyan);
}

.toast-modern.info .toast-icon {
  background: rgba(7, 181, 214, 0.15);
  color: var(--cyan);
}

.toast-modern.info .toast-title {
  color: var(--cyan);
}

/* Light theme adjustments */
:root[data-theme="light"] .toast-modern {
  box-shadow:
    0 6px 18px rgba(92, 70, 40, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.88);
}
```

**New JS Toast object (add around line 10000 in app.js, after notification functions):**

```javascript
/**
 * Modern Toast Notification System
 * Usage: Toast.success("Title", "Message");
 *        Toast.error("Error", "Something went wrong");
 *        Toast.warning("Warning", "Check your input");
 *        Toast.info("Info", "FYI: data updated");
 */
const Toast = (() => {
  const MAX_VISIBLE = 5;
  const DEFAULT_TTL = {
    success: 4000,
    error: 8000,
    warning: 6000,
    info: 4000,
  };

  let container = null;

  function getContainer() {
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container-modern";
      document.body.appendChild(container);
    }
    return container;
  }

  function show(type, title, message, opts = {}) {
    const cont = getContainer();

    // Enforce max visible limit
    while (cont.children.length >= MAX_VISIBLE) {
      const oldest = cont.firstElementChild;
      if (oldest) {
        oldest.classList.add("removing");
        setTimeout(() => oldest.remove(), 240);
      }
    }

    const toast = document.createElement("div");
    toast.className = `toast-modern ${type}`;

    const ttl = opts.ttl !== undefined ? opts.ttl : DEFAULT_TTL[type];
    const icon = opts.icon || getDefaultIcon(type);

    toast.innerHTML = `
      <div class="toast-icon">${icon}</div>
      <div class="toast-content">
        <div class="toast-title">${escapeHtml(title)}</div>
        <div class="toast-message">${escapeHtml(message)}</div>
        ${opts.actionLabel ? `<div class="toast-actions"><button class="toast-action-btn" data-action="custom">${escapeHtml(opts.actionLabel)}</button></div>` : ""}
      </div>
      <button class="toast-close" aria-label="Dismiss" data-action="close">✕</button>
    `;

    // Event handlers
    toast.querySelector(".toast-close")?.addEventListener("click", () => {
      toast.classList.add("removing");
      setTimeout(() => toast.remove(), 240);
      if (opts.onDismiss) opts.onDismiss();
    });

    const actionBtn = toast.querySelector("[data-action='custom']");
    if (actionBtn && opts.actionFn) {
      actionBtn.addEventListener("click", () => {
        opts.actionFn();
        toast.classList.add("removing");
        setTimeout(() => toast.remove(), 240);
      });
    }

    cont.appendChild(toast);

    // Auto-dismiss
    if (ttl > 0) {
      setTimeout(() => {
        if (toast.parentElement) {
          toast.classList.add("removing");
          setTimeout(() => toast.remove(), 240);
        }
      }, ttl);
    }

    return toast;
  }

  function getDefaultIcon(type) {
    const icons = {
      success: '<span class="mdi mdi-check-circle"></span>',
      error: '<span class="mdi mdi-alert-circle"></span>',
      warning: '<span class="mdi mdi-alert-outline"></span>',
      info: '<span class="mdi mdi-information"></span>',
    };
    return icons[type] || icons.info;
  }

  return {
    success: (title, message, opts) => show("success", title, message, opts),
    error: (title, message, opts) => show("error", title, message, opts),
    warning: (title, message, opts) => show("warning", title, message, opts),
    info: (title, message, opts) => show("info", title, message, opts),
    show,
  };
})();

function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return text.replace(/[&<>"']/g, m => map[m]);
}
```

**Integration points — find and modify these action handlers:**

1. **Bulk control** (search for `btnStartSelected` or `btnStopSelected` click handlers, around line 10500):
   ```javascript
   // Instead of: showToast("Command sent", "fault", 4000);
   // Use:
   Toast.success("Bulk Control", "START command sent to selected inverters");
   ```

2. **Export completion** (search for `exportBtn` click or export fetch response, around line 12000):
   ```javascript
   // Instead of: showMsg(exportId, "Export complete", "success");
   // Use:
   Toast.success("Export Complete", `Data exported to: ${filePath}`);
   ```

3. **Settings save** (search for settings form submit, around line 12500):
   ```javascript
   // After settings are posted:
   Toast.success("Settings Saved", "Your changes have been applied");
   ```

4. **Forecast generation** (search for `/api/forecast/generate` fetch, around line 11000):
   ```javascript
   // On success:
   Toast.success("Forecast Generated", "Day-ahead model trained successfully");
   // On error:
   Toast.error("Generation Failed", error.message);
   ```

5. **WebSocket reconnect** (search for `onopen` or reconnect handler, around line 3500):
   ```javascript
   // On reconnect:
   Toast.info("Connection Restored", "Live data streaming resumed");
   ```

**Testing checklist:**
- [ ] `Toast.success()`, `Toast.error()`, `Toast.warning()`, `Toast.info()` all render
- [ ] Icons appear correctly (check MDI icon names)
- [ ] Title and message display properly
- [ ] Close button (✕) dismisses toast instantly
- [ ] Auto-dismiss works (success: 4s, error: 8s, warning: 6s)
- [ ] Slide-in animation is smooth
- [ ] Slide-out animation on dismiss is smooth
- [ ] Max 5 toasts visible at once (oldest removed when limit exceeded)
- [ ] All 3 themes: colors correct (green, red, orange, cyan)
- [ ] Action button works when provided
- [ ] Z-index correct (above page content, below modals)
- [ ] Bottom position respects footer height (32px + 12px gap)
- [ ] No text wrapping issues (max-width: 380px)

---

### 2.3 Sortable Data Tables

**Problem:** Tables (alarms, energy, audit, report) lack sorting — users must manually scan to find specific records.

**Solution:** Make column headers clickable, toggle ascending/descending, show visual sort indicators (↑ ↓), preserve sort state in session.

**Files to modify:**
- `public/css/style.css` — add `.sortable`, `.sorted-asc`, `.sorted-desc` classes
- `public/js/app.js` — add `makeTableSortable()` and `sortTableRows()` functions
- `public/index.html` — add `data-sort-key` attributes to `<th>` elements in table templates

**New CSS (insert around line 4850, after table styles):**

```css
/* ── Sortable Table Headers ────────────────────────────────────── */

.data-table thead th.sortable {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.12s ease;
  position: relative;
}

.data-table thead th.sortable:hover {
  background-color: color-mix(in srgb, var(--border) 50%, transparent);
}

.data-table thead th.sortable::after {
  content: " ⇅";  /* default unsorted indicator */
  font-size: 10px;
  opacity: 0.4;
  margin-left: 4px;
}

.data-table thead th.sorted-asc::after {
  content: " ↑";
  opacity: 1;
  color: var(--accent);
}

.data-table thead th.sorted-desc::after {
  content: " ↓";
  opacity: 1;
  color: var(--accent);
}

.data-table thead th.sorted-asc,
.data-table thead th.sorted-desc {
  background-color: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
```

**New JS functions (add around line 10200 in app.js, after Toast definition):**

```javascript
/**
 * Make a table's headers sortable.
 * @param {string} tableId - ID of <table> element
 * @param {string} storageKey - localStorage key for persisting sort state
 */
function makeTableSortable(tableId, storageKey) {
  const table = $(tableId);
  if (!table) return;

  const thead = table.querySelector("thead");
  if (!thead) return;

  // Restore sort state from localStorage
  const savedState = localStorage.getItem(storageKey);
  let currentSort = { colIndex: 0, direction: "asc" };
  if (savedState) {
    try {
      currentSort = JSON.parse(savedState);
    } catch (e) {
      console.warn("Failed to parse sort state:", e);
    }
  }

  const ths = thead.querySelectorAll("th[data-sort-key]");

  ths.forEach((th, colIndex) => {
    th.classList.add("sortable");

    // Restore visual state
    if (colIndex === currentSort.colIndex) {
      th.classList.add(currentSort.direction === "asc" ? "sorted-asc" : "sorted-desc");
    }

    th.addEventListener("click", () => {
      // Remove sort indicators from all headers
      ths.forEach(h => h.classList.remove("sorted-asc", "sorted-desc"));

      // Determine new direction
      let direction = "asc";
      if (currentSort.colIndex === colIndex && currentSort.direction === "asc") {
        direction = "desc";
      }

      currentSort = { colIndex, direction };

      // Save state
      localStorage.setItem(storageKey, JSON.stringify(currentSort));

      // Add visual indicator
      th.classList.add(direction === "asc" ? "sorted-asc" : "sorted-desc");

      // Sort table
      const tbody = table.querySelector("tbody");
      const sortKey = th.dataset.sortKey;
      const sortType = th.dataset.sortType || "string"; // "string", "number", "date"

      sortTableRows(tbody, colIndex, direction, sortType);
    });
  });

  // Initial sort if saved state exists
  if (savedState) {
    const th = ths[currentSort.colIndex];
    if (th) {
      th.click(); // trigger sort
    }
  }
}

/**
 * Sort table rows.
 * @param {HTMLTableSectionElement} tbody - <tbody> element
 * @param {number} colIndex - Column index (0-based)
 * @param {"asc"|"desc"} direction - Sort direction
 * @param {"string"|"number"|"date"} type - Data type for comparison
 */
function sortTableRows(tbody, colIndex, direction, type) {
  const rows = Array.from(tbody.querySelectorAll("tr"));

  rows.sort((rowA, rowB) => {
    const cellA = rowA.cells[colIndex];
    const cellB = rowB.cells[colIndex];

    if (!cellA || !cellB) return 0;

    let valA = cellA.textContent.trim();
    let valB = cellB.textContent.trim();

    // Convert to comparable type
    if (type === "number") {
      valA = parseFloat(valA) || 0;
      valB = parseFloat(valB) || 0;
    } else if (type === "date") {
      valA = new Date(valA).getTime() || 0;
      valB = new Date(valB).getTime() || 0;
    }

    // Compare
    if (valA < valB) return direction === "asc" ? -1 : 1;
    if (valA > valB) return direction === "asc" ? 1 : -1;
    return 0;
  });

  // Reorder rows in DOM
  rows.forEach(row => tbody.appendChild(row));
}
```

**HTML modifications** — Find table elements in `index.html` and add `data-sort-key` and `data-sort-type` to `<th>` elements:

**Example: Alarms table** (search for alarms table in HTML, around line 3500+):

```html
<!-- Before: -->
<thead>
  <tr>
    <th>Inverter</th>
    <th>Code</th>
    <th>Message</th>
    <th>Time</th>
    <!-- etc -->
  </tr>
</thead>

<!-- After: -->
<thead>
  <tr>
    <th data-sort-key="inverter" data-sort-type="string">Inverter</th>
    <th data-sort-key="hex" data-sort-type="string">Code</th>
    <th data-sort-key="desc" data-sort-type="string">Message</th>
    <th data-sort-key="ts" data-sort-type="date">Time</th>
    <!-- etc -->
  </tr>
</thead>
```

**Enable sorting for each table** — Find where tables are rendered and call `makeTableSortable()`:

```javascript
// In alarm page initialization:
makeTableSortable("alarmsTable", "sort-alarms");

// In energy page initialization:
makeTableSortable("energyTable", "sort-energy");

// In audit page initialization:
makeTableSortable("auditTable", "sort-audit");

// In report page initialization:
makeTableSortable("reportTable", "sort-report");
```

**Testing checklist:**
- [ ] Column headers are clickable (cursor: pointer)
- [ ] First click sorts ascending (↑ appears)
- [ ] Second click sorts descending (↓ appears)
- [ ] Third click (optional) toggles back to ascending
- [ ] Sorted header has accent background color
- [ ] Table rows reorder visually
- [ ] Sort state persists in localStorage (reload page, sort is maintained)
- [ ] Works for string, number, and date columns
- [ ] All 3 themes: accent color shows correctly
- [ ] Performance: sorting 100+ rows is instant (<100ms)
- [ ] Screen reader: sort direction is announced (consider adding `aria-sort`)

---

### 2.4 Breadcrumb Navigation

**Problem:** When users drill into detail views (inverter detail panel, settings sections), they lose context of where they are in the hierarchy.

**Solution:** Add breadcrumb bar below page toolbar showing current location. Breadcrumbs are clickable to navigate back up levels.

**Files to modify:**
- `public/css/style.css` — new `.breadcrumb-nav`, `.breadcrumb-item` classes
- `public/js/app.js` — add `setBreadcrumbs()` helper, integrate with detail view handlers
- `public/index.html` — insert breadcrumb container in each page

**New CSS:**

```css
/* ── Breadcrumb Navigation ────────────────────────────────────────── */

.breadcrumb-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  min-height: 28px;
  font-size: 10px;
  color: var(--text3);
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
}

.breadcrumb-nav::-webkit-scrollbar {
  display: none;
}

.breadcrumb-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.breadcrumb-link {
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
  transition: color 0.12s ease;
}

.breadcrumb-link:hover {
  color: var(--text2);
  text-decoration: underline;
}

.breadcrumb-sep {
  color: var(--text3);
  opacity: 0.5;
  user-select: none;
}

.breadcrumb-current {
  color: var(--text2);
  font-weight: var(--fw-semibold);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

**New JS helper:**

```javascript
/**
 * Set breadcrumb navigation for current page/view.
 * @param {string[]} items - Array of { label, action? } objects or strings
 * Example: setBreadcrumbs([
 *   { label: "Home", action: () => switchPage("inverters") },
 *   "Inverter 1",
 *   "Node 3 Details"
 * ])
 */
function setBreadcrumbs(items) {
  let bcNav = $("breadcrumbNav");
  if (!bcNav) {
    // Create breadcrumb container if doesn't exist
    const pageToolbar = document.querySelector(".page.active .page-toolbar");
    if (!pageToolbar) return;

    bcNav = el("nav", "breadcrumb-nav");
    bcNav.id = "breadcrumbNav";
    pageToolbar.parentElement.insertBefore(bcNav, pageToolbar.nextElementSibling);
  }

  bcNav.innerHTML = "";

  items.forEach((item, idx) => {
    const itemEl = el("div", "breadcrumb-item");

    if (typeof item === "string") {
      // Current level (not clickable)
      if (idx < items.length - 1) {
        const linkEl = el("a", "breadcrumb-link");
        linkEl.textContent = item;
        linkEl.href = "#";
        itemEl.appendChild(linkEl);
      } else {
        const currentEl = el("span", "breadcrumb-current");
        currentEl.textContent = item;
        itemEl.appendChild(currentEl);
      }
    } else {
      // Object with label and optional action
      const { label, action } = item;
      if (idx < items.length - 1) {
        const linkEl = el("a", "breadcrumb-link");
        linkEl.textContent = label;
        linkEl.href = "#";
        if (action) {
          linkEl.addEventListener("click", (e) => {
            e.preventDefault();
            action();
          });
        }
        itemEl.appendChild(linkEl);
      } else {
        const currentEl = el("span", "breadcrumb-current");
        currentEl.textContent = label;
        itemEl.appendChild(currentEl);
      }
    }

    bcNav.appendChild(itemEl);

    // Add separator between items (except after last)
    if (idx < items.length - 1) {
      const sep = el("span", "breadcrumb-sep");
      sep.textContent = "/";
      bcNav.appendChild(sep);
    }
  });
}

/**
 * Clear breadcrumb navigation (e.g., when returning to main list view).
 */
function clearBreadcrumbs() {
  const bcNav = $("breadcrumbNav");
  if (bcNav) bcNav.innerHTML = "";
}
```

**Integration example** — when user clicks to view inverter details:

```javascript
// In inverter card click handler:
card.addEventListener("click", () => {
  showInverterDetailPanel(inv);
  setBreadcrumbs([
    { label: "Inverters", action: () => { closeDetailPanel(); } },
    `Inverter ${inv}`,
  ]);
});

// When closing detail panel:
function closeDetailPanel() {
  // ...
  clearBreadcrumbs();
}
```

**Testing checklist:**
- [ ] Breadcrumbs appear below toolbar when detail view opens
- [ ] Each level is clickable (except last)
- [ ] Click navigates back to that level
- [ ] Long breadcrumb labels truncate with ellipsis
- [ ] Separators (/) display between items
- [ ] Current level (last item) is bold, not clickable
- [ ] Breadcrumbs clear when returning to main view
- [ ] Works in all 3 themes
- [ ] Accessibility: breadcrumb links have clear focus indicators

---

### 2.5 Chart Skeleton Loaders

**Problem:** Charts show blank canvas while data is loading, creating a jarring visual gap and poor perceived performance.

**Solution:** Display animated skeleton placeholders (repeating bars or shimmer effect) until chart data arrives.

**Files to modify:**
- `public/css/style.css` — new `.chart-skeleton`, `@keyframes skeletonShimmer`
- `public/js/app.js` — add `renderChartSkeleton()`, call before chart updates

**New CSS:**

```css
/* ── Chart Skeleton Loaders ────────────────────────────────────── */

@keyframes skeletonShimmer {
  0% { background-position: -100% 0; }
  100% { background-position: 100% 0; }
}

.chart-skeleton {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  background: var(--surface);
  border-radius: 6px;
}

.skeleton-bar {
  height: 12px;
  background: linear-gradient(
    90deg,
    var(--border) 0%,
    color-mix(in srgb, var(--border) 50%, transparent) 50%,
    var(--border) 100%
  );
  background-size: 200% 100%;
  border-radius: 4px;
  animation: skeletonShimmer 1.5s infinite;
}

.skeleton-bar:nth-child(1) { width: 95%; }
.skeleton-bar:nth-child(2) { width: 98%; }
.skeleton-bar:nth-child(3) { width: 92%; }
.skeleton-bar:nth-child(4) { width: 96%; }
.skeleton-bar:nth-child(5) { width: 91%; }
.skeleton-bar:nth-child(6) { width: 94%; }
.skeleton-bar:nth-child(7) { width: 89%; }
.skeleton-bar:nth-child(8) { width: 97%; }

.chart-skeleton.large {
  gap: 14px;
}

.chart-skeleton.large .skeleton-bar {
  height: 16px;
}
```

**New JS function:**

```javascript
/**
 * Render an animated skeleton loader in a chart container.
 * @param {HTMLElement} container - Container to render skeleton in
 * @param {boolean} large - Use large bar variant (optional)
 */
function renderChartSkeleton(container, large = false) {
  if (!container) return;

  const skeleton = el("div", `chart-skeleton ${large ? "large" : ""}`);
  const barCount = large ? 12 : 8;

  for (let i = 0; i < barCount; i++) {
    const bar = el("div", "skeleton-bar");
    skeleton.appendChild(bar);
  }

  container.innerHTML = "";
  container.appendChild(skeleton);
}

/**
 * Remove skeleton loader (called when chart data is ready).
 * @param {HTMLElement} container
 */
function removeChartSkeleton(container) {
  const skeleton = container?.querySelector(".chart-skeleton");
  if (skeleton) {
    skeleton.remove();
  }
}
```

**Integration example** — in chart rendering code (search for `ensureAnalyticsCards()`, line 11476):

```javascript
async function updateAnalyticsChart(chartId) {
  const container = $(chartId);
  if (!container) return;

  // Show skeleton while loading
  renderChartSkeleton(container, true);

  try {
    // Fetch data
    const resp = await fetch("/api/energy/...");
    const data = await resp.json();

    // Remove skeleton
    removeChartSkeleton(container);

    // Render chart
    renderChartFromData(container, data);
  } catch (err) {
    removeChartSkeleton(container);
    // Show error
  }
}
```

**Testing checklist:**
- [ ] Skeleton appears immediately when chart container is empty
- [ ] Animated shimmer effect is smooth
- [ ] Bars vary in width (avoid uniformity)
- [ ] Skeleton is replaced by actual chart when data loads
- [ ] Works in all 3 themes (skeleton uses border color, adapts)
- [ ] Large variant (16px bars) for full-width charts
- [ ] Skeleton cleared if chart load fails
- [ ] No layout shift when transitioning from skeleton to chart
- [ ] Performance: skeleton animation smooth on lower-end hardware

---

## TIER 3: Major Enhancements

These are larger features that would require significant refactoring or new functionality. Estimated effort: 16+ hours each.

### 3.1 Drag-to-Reorder Inverter Cards

Allow users to rearrange inverter card order via drag-and-drop. Save preference to `localStorage` under `invCardOrder`. Would require event listeners on card dragging, visual reordering, and persistence layer.

### 3.2 SVG Circular Gauges

Replace flat PAC/PDC strips with animated SVG circular gauges showing power output with color bands (green → yellow → orange → red). Would require SVG rendering logic and real-time updates via Canvas or DOM manipulation.

### 3.3 Chart Zoom/Pan/Crosshair

Add Chart.js plugins to allow zooming into time ranges, panning left/right, and crosshair cursor that shows precise values. Would require plugin integration and state management for zoom level.

### 3.4 Theme Preview Modal

Show before/applying toggle for all 3 themes side-by-side in a modal before committing. Would require rendering 3 versions of key components and theme switching without navigation.

### 3.5 Header "Today's Profile" Sparkline

Add a 24-hour energy profile sparkline to the header metrics bar, showing today's kWh per hour. Would require `/api/energy/today` endpoint and hourly data aggregation.

---

## Cross-Cutting Concerns

### Animation Performance Rules

**GPU-Composited Properties Only:**

✓ DO animate these (GPU-friendly):
- `transform: translate()`, `rotate()`, `scale()`, `skew()`
- `opacity`
- `filter` (blur, brightness, contrast)

✗ DON'T animate these (CPU-heavy, causes repaints):
- `width`, `height`, `left`, `top`, `margin`, `padding`
- `border-width`, `border-color` (except in exceptional cases)
- `box-shadow` (use sparingly; can be expensive)

**Optimization Tips:**

```css
/* Good: uses will-change to hint GPU acceleration */
.animated-element {
  will-change: transform;
  transition: transform 0.3s ease;
}

.animated-element:hover {
  transform: translateY(-2px);  /* GPU-composited */
}

/* Bad: animates width (CPU-heavy, causes reflow) */
.bad-element {
  transition: width 0.3s ease;
}

.bad-element:hover {
  width: 200px;  /* reflows page! */
}
```

### CSS Token Rules

**NEVER hardcode colors.** Always use `var(--token-name)`:

```css
/* Good */
.my-component {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.24);  /* black shadows OK */
}

/* Bad */
.my-component {
  background: #1c0f15;        /* hardcoded color! */
  color: #f1e7eb;             /* hardcoded color! */
  border: 1px solid #4f2533;  /* hardcoded color! */
}
```

**Adding a New Token:**

If you need a new color/dimension, add it to ALL 3 theme blocks:

```css
:root {
  --my-new-token: #somevalue;
  /* ... other tokens ... */
}

:root[data-theme="light"] {
  --my-new-token: #light-variant;
  /* ... */
}

:root[data-theme="classic"] {
  --my-new-token: #classic-variant;
  /* ... */
}
```

**Common Token Patterns:**

| Intent | Token | Usage |
|--------|-------|-------|
| Background | `--bg`, `--surface`, `--surface2` | Page background, containers |
| Text | `--text`, `--text2`, `--text3` | Primary, secondary, muted text |
| Borders | `--border`, `--border2` | Component borders |
| Accents | `--accent`, `--accent2` | Links, highlights, focus rings |
| Status | `--green`, `--red`, `--orange`, `--cyan` | Status indicators |
| Shadows | `rgba(0, 0, 0, 0.XX)` | Hardcoded black at various opacity |

### Theme Testing Matrix

Create a checklist for each enhancement:

| Feature | Dark | Light | Classic | 1440px | 2560px | Notes |
|---------|------|-------|---------|--------|--------|-------|
| Button hover | [ ] | [ ] | [ ] | [ ] | [ ] | Verify shadow color |
| Toast success | [ ] | [ ] | [ ] | [ ] | [ ] | Green color visible? |
| Empty state icon | [ ] | [ ] | [ ] | [ ] | [ ] | Gray icon readable? |
| Sparkline line | [ ] | [ ] | [ ] | [ ] | [ ] | Green line visible in all? |
| Scrollbar gradient | [ ] | [ ] | [ ] | [ ] | [ ] | Gradient direction OK? |

### Accessibility Requirements

**Color Contrast:**
- Primary text on background: 4.5:1 minimum (AA standard)
- Large text (18pt+) on background: 3:1 minimum
- Components like buttons: 3:1 minimum

**Verify with:**
```bash
# Use WebAIM Contrast Checker online
# Or use ColorOracle (free app) to simulate colorblindness
```

**Focus Indicators:**
- All interactive elements must have visible focus when tabbed
- Focus ring size: min 2px, outline-offset 2px
- Focus color must contrast with background 3:1

**Keyboard Navigation:**
- Tab order follows visual left-to-right, top-to-bottom
- No keyboard traps (elements where you can't Tab out)
- Enter/Space triggers buttons, dropdown opens
- Escape closes modals/dropdowns

**Screen Reader Compatibility:**
- Icon-only buttons need `aria-label` (e.g., `aria-label="Close"`)
- Form inputs need `<label>` association
- Tables need `<thead>` and `<tbody>` for semantic structure
- Links: no "Click here" links; use descriptive link text
- Test with NVDA (Windows, free) or JAWS

---

## Appendix A: Current CSS Token Reference

### Color Palette (Dark Theme, Default)

```css
:root {
  /* Background & Surface */
  --bg: #0e070a;
  --bg2: #150b10;
  --surface: #1c0f15;
  --surface2: #23131b;

  /* Borders */
  --border: #4f2533;
  --border2: #6f3345;

  /* Text */
  --text: #f1e7eb;          /* primary */
  --text2: #d0b5c0;         /* secondary */
  --text3: #967684;         /* muted */

  /* Accent & Brand */
  --accent: #d86a8b;        /* primary accent (pink) */
  --accent2: #b74e6d;       /* secondary accent */

  /* Status Colors */
  --green: #10b370;
  --green2: #0c8f59;
  --red: #e03560;
  --red2: #b82048;
  --orange: #f09000;
  --cyan: #07b5d6;

  /* Status Levels */
  --status-high: #00cf00;        /* 90%+ */
  --status-moderate: #e8e800;    /* 70-90% */
  --status-mild: #ffa500;        /* 40-70% */
  --status-critical: #ff0000;    /* <40%, alarm */
}
```

### Button Tokens (Sample)

```css
/* Accent Button (Primary) */
--btn-accent-color: #f8fbff;           /* text color */
--btn-accent-border: rgba(124, 186, 255, 0.84);
--btn-accent-border-hover: rgba(182, 220, 255, 0.98);
--btn-accent-1: #67baff;               /* gradient top */
--btn-accent-2: #2f6cff;               /* gradient bottom */
--btn-accent-shadow: 0 12px 26px rgba(30, 78, 170, 0.30), ...;
--btn-accent-shadow-hover: 0 16px 34px rgba(30, 78, 170, 0.38), ...;

/* Green Button */
--btn-green-color: #f7fffb;
--btn-green-border: rgba(73, 214, 158, 0.74);
--btn-green-1: #34d399;               /* gradient */
--btn-green-2: #10976e;
--btn-green-shadow: 0 12px 26px rgba(11, 114, 82, 0.28), ...;

/* Red Button */
--btn-red-color: #fff8f9;
--btn-red-border: rgba(255, 139, 149, 0.8);
--btn-red-1: #ff8a7a;
--btn-red-2: #d94a5d;
--btn-red-shadow: 0 12px 26px rgba(154, 42, 66, 0.28), ...;
```

### Scaling Variables

```css
:root {
  --base-font-size: 12px;              /* 1440px viewport */
  --surface-scale: 1;
  --inv-toolbar-scale: 1;
  --inv-card-scale: 1;
  --top-scale: 1.5;                    /* header height multiplier */

  /* @media (min-width: 2200px) */
  --base-font-size: 13px;
  --surface-scale: 1.08;
  --inv-card-scale: 1.12;
  --top-scale: 1.6;

  /* @media (min-width: 3000px) — 4K */
  --base-font-size: 14px;
  --surface-scale: 1.14;
  --inv-card-scale: 1.2;
  --top-scale: 1.72;
}
```

---

## Appendix B: Current Page Structure Reference

### Shell DOM Tree

```
<html>
  <body>
    <header #titlebar>
      <div .tb-metrics-row>
        <div .tb-logo>
        <div .tb-metrics-center>
          <div .metric-pill (TOTAL POWER OUTPUT)
          <div .metric-pill (TOTAL ENERGY GENERATED)
        <div .tb-right>
          <button #btnAlarmSound
          <button #themeToggleBtn
          <div .tb-clock-wrap
          <button #navToggleBtn

    <div .tb-progress-row#globalProgressRow>
      <div .tb-progress-track>
        <div .tb-progress-fill#globalProgressFill>

    <div #licenseNotice.license-notice

    <aside .side-nav#sideNav>
      <nav .tb-nav#mainNav>
        <div .nav-section-label
        <button .nav-btn[data-page="inverters"]
        <button .nav-btn[data-page="analytics"]
        <!-- ... more nav buttons ... -->
      <div .side-about-card
        <div .side-about-ver
        <div .side-about-db

    <main #main>
      <!-- Each page container below, only one .page.active at a time -->

      <div .page#page-inverters>
        <div .page-toolbar
          <div .tl-left (layout selector, stats chips)
          <div .tl-right (filter buttons)
        <div .inv-page-body (flex: 1; min-height: 0; overflow: auto)
          <div .bulk-control-bar (Bulk Command panel)
          <div .inv-grid (CSS grid of inverter cards)
            <div .inv-card × 27 (inverter cards)

      <div .page#page-analytics>
        <div .page-toolbar
        <div .analytics-scroll-wrap (flex: 1; overflow: auto)
          <div .chart-grid (2-column grid)
            <div .chart-card (Pac Total, Pdc Total, etc.)
              <canvas #chart-total

      <div .page#page-alarms>
        <div .page-toolbar
        <div .table-wrap (flex: 1; overflow: auto)
          <table .data-table#alarmsTable
            <thead>
            <tbody#alarmsTableBody

      <!-- ... more pages ... -->

    <footer .app-footer>
      <div .app-footer-item
        <span Version: 2.5.1
      <div .app-footer-sep
      <div .app-footer-item
        <a href="..." (Author, GitHub, etc.)

    <!-- Toast container (appended dynamically) -->
    <div #alarmToast (legacy toast notifications)

    <!-- Modals (appended dynamically) -->
    <div .modal#appModal (confirm/alert dialogs)
  </body>
</html>
```

### Inverter Card DOM Structure

```
<div .inv-card#inv-card-1>
  <div .card-hdr>
    <div .card-hdr-left>
      <div .card-inv-icon#icon-1 ⚡
      <div>
        <div .card-title#card-title-1 INV-1
        <div .card-subtitle#card-subtitle-1 192.168.1.100
    <div .card-badges>
      <span .badge.badge-online#badge-1 ONLINE

  <div .card-pac>
    <div .pac-left (Start/Stop buttons)
    <div .pac-right (Pdc:, Pac: cells)

  <div style="display: flex; flex: 1; gap: 0; overflow: hidden;">
    <div .card-table-wrap
      <table .card-table
        <thead>
          <tr>
            <th Node
            <th Ctl
            <!-- ... more headers ... -->
        <tbody#nodes-1 (node rows)
          <tr> N1 | 249W | ...
          <tr> N2 | 0W | ...
          <!-- ... 4 nodes per inverter ... -->

    <div .card-controls-rail (vertical control buttons)
      <div .card-ctrl-hdr CTRL
      <div .card-node-controls-vertical
        <!-- node control buttons -->

  <div .card-sparkline-wrap (if not in compact layout)
    <canvas #card-sparkline-1
```

---

## Appendix C: JS Function Index

| Function | File | Line | Purpose |
|----------|------|------|---------|
| `switchPage(page)` | app.js | 3675 | Navigate to named page, trigger animations |
| `buildInverterCard(inv, nodeCount)` | app.js | 7826 | Create DOM for single inverter card |
| `updateInverterCards()` | app.js | ~8200 | Update all card data from State |
| `ensureAnalyticsCards()` | app.js | 11476 | Ensure all chart canvas elements exist |
| `renderAnalyticsFromState()` | app.js | ~11500 | Populate chart data and redraw |
| `showToast(html, severity, ttlMs)` | app.js | 9733 | (Legacy) Show notification toast |
| `showAlarmToast(alarm, invLabel, hex, desc)` | app.js | 9768 | (Legacy) Show alarm-specific toast with ACK |
| `ackAlarm(id, btn)` | app.js | ~9870 | Acknowledge alarm by ID |
| `renderEmptyState(container, opts)` | app.js | ~10000 | (NEW) Render empty state placeholder |
| `Toast.success/error/warning/info()` | app.js | ~10100 | (NEW) Modern toast notifications |
| `makeTableSortable(tableId, storageKey)` | app.js | ~10200 | (NEW) Enable sorting on table headers |
| `sortTableRows(tbody, colIndex, dir, type)` | app.js | ~10250 | (NEW) Sort table rows in-place |
| `setBreadcrumbs(items)` | app.js | ~10350 | (NEW) Set breadcrumb navigation |
| `drawSparkline(canvas, data, color, opts)` | app.js | ~9900 | (NEW) Draw line sparkline on canvas |
| `renderChartSkeleton(container, large)` | app.js | ~10400 | (NEW) Show animated skeleton loader |
| `$()` | app.js | ~100 | Helper: `document.getElementById()` shorthand |
| `el(tag, className)` | app.js | ~120 | Helper: Create element with class |

---

## Implementation Summary

This blueprint provides a complete roadmap for 20+ UI/UX improvements across three tiers of effort. Each enhancement:

1. **Respects existing architecture** — no breaking changes to State, API contracts, or core patterns
2. **Uses CSS token system** — all colors theme-aware, automatically adapt to dark/light/classic
3. **Maintains performance** — GPU-accelerated animations, efficient DOM updates
4. **Follows accessibility standards** — WCAG 2.1 AA focus rings, color contrast, keyboard navigation
5. **Can be implemented incrementally** — each enhancement is independent, can be done in any order
6. **Is fully testable** — clear validation checklists for each feature

Start with **TIER 1** for quick visual wins, move to **TIER 2** for feature depth, and save **TIER 3** for major refactoring efforts.

---

**Document Version History:**
- v1.0 (2026-03-29): Initial comprehensive blueprint covering TIER 1-2 enhancements with exact line numbers, code snippets, and CSS token usage.

