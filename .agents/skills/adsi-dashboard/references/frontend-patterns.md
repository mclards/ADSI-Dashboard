# Frontend Patterns Reference

> **Note**: The contents of this file are superseded by the inline
> [Frontend Patterns] and [UI and Theming] sections in `SKILL.md`.
> This file is kept for backward compatibility with agents that load it directly.
> If this file and `SKILL.md` ever conflict, `SKILL.md` is authoritative.

---

## Inverter Detail Panel

When a single inverter is selected from `invFilter`, `filterInverters()` calls `loadInverterDetail(inv)` to populate `#invDetailPanel` with:
- Stat chips: Today kWh, Current PAC, Availability %, Active Alarms
- Today's AC Power chart (5-min energy → average kW via `kwh_inc * 12`)
- Recent Alarms table (last 30 days, max 15 rows)
- Last 7 Days summary table

Functions: `clearInverterDetail()`, `loadInverterDetail(inv)`, `renderInverterDetailStats()`, `renderInverterDetailChart()`, `renderInverterDetailAlarms()`, `renderInverterDetailHistory()` — all in `public/js/app.js` after `filterInverters()`.

`#invDetailPanel` lives inside `.inv-page-body` alongside `#invGrid`. Both scroll together in the wrapper.

**Rule**: Do not block initial detail rendering on the 7-day `/api/report/daily` history fetch. Stats and alarms render first; recent-history loading is best-effort and bounded by a timeout.

---

## Tab Date Initialization

`initAllTabDatesToToday()` sets all date inputs (Analytics, Alarms, Energy, Audit, Report) to today's date. Called:
- On `init()` after `loadSettings()`, overriding any stale `exportUiState` dates
- On day rollover inside `startClock()` tick (compares `dateStr(now)` to `State.lastDateInitDay`)

Day rollover also clears `State.tabFetchTs` and all tab row caches so data re-fetches on next tab visit.

---

## Startup Tab Prefetch

`prefetchAllTabs()` warms Alarms / Report / Audit / Energy sequentially during the loading phase. The main window stays behind the loading screen until critical bootstrap data and the first live WebSocket sample are ready. `TAB_STALE_MS = 60000` (60 s). Do not revert to a delayed parallel fire-and-forget path.

---

## PAC Indicator Thresholds

Each inverter node has a 6×14 px colored bar (`getPacRowClass()`) based on `NODE_RATED_W = 249,250 W`:

| Threshold | Class | Color | Label |
|---|---|---|---|
| ≥ 90% rated | `.row-pac-high` | `#00cf00` (green) | High |
| > 70% rated | `.row-pac-mid` | `#ffff00` (yellow) | Moderate |
| > 40% rated | `.row-pac-low` | `#ffa500` (orange) | Mild |
| ≤ 40% rated | `.row-pac-off` | `#ff0000` (red) | Low |
| Alarm active | blink animation | — | Alarm |

A compact static legend (`.pac-legend-wrap`) sits in the inverter toolbar between the layout selector and the counters. PAC legend signal colors are fixed across all themes — they do not inherit theme-tinted status colors.

---

## App Confirm Modal

`appConfirm(title, bodyText, { ok, cancel })` → `Promise<boolean>`. Renders `#appConfirmModal` with title, body (paragraphs split on `\n\n`), and labelled OK/Cancel buttons. Supports Escape (cancel), Enter (confirm), backdrop click (cancel). `initConfirmModal()` called from `init()`.

All `confirm()` / `window.confirm()` calls in `app.js` are replaced with `await appConfirm(...)`. All `alert()` calls replaced with `showToast(...)`.

---

## Availability Computation

Availability for today is computed live via `getDailyReportRowsForDay(today, { includeTodayPartial: true })`. The `/api/report/daily?start&end` range endpoint detects when today falls in the requested range and splices in the live result. The detail panel 60 s refresh timer fetches both `/api/energy/today` (kWh) and `/api/report/daily?date=<today>` (availability), then merges fresh rows into `State.invDetailReportRows`.

---

## Real-Time Metric Alignment (Analytics and Energy Pages)

When the selected date is today, `applyCurrentDaySummaryClient` calls `renderAnalyticsFromState()` on every WebSocket `todaySummary` push.

- `extractCurrentDaySummary()` parses the flat `todaySummary` object from the WS payload — do not wrap `todaySummary` in extra nesting without updating this parser.
- `renderAnalyticsFromState()` only runs when Analytics or Energy page is active and selected date equals today.
- Do not reintroduce a separate `patchAnalyticsSummaryLive` function.

---

## WebSocket Reconnection

Exponential backoff with jitter:
```js
Math.min(30000, 500 * 1.5^retries + random * 500 * retries)
```
Do not revert to linear backoff — it causes thundering herd on gateway restarts with multiple remote clients.

---

## Gateway Link Stability

The remote bridge polls gateway `/api/live` and must stay resilient over VPN/Tailscale links:

| Setting | Value | Rule |
|---|---|---|
| Adaptive polling | `max(1200, latency×2)` when latency > 400 ms | Do not revert to fixed interval |
| `REMOTE_LIVE_FAILURES_BEFORE_OFFLINE` | 6 (10 during sync) | Do not lower |
| `REMOTE_LIVE_DEGRADED_GRACE_MS` | 60,000 ms | Do not lower |
| `REMOTE_LIVE_STALE_RETENTION_MS` | 180,000 ms | Do not lower |
| Gateway `keepAliveTimeout` | 30 s (`headersTimeout` 35 s) | Must stay above client `REMOTE_FETCH_KEEPALIVE_MSECS` (15 s) |

`/api/energy/today` fetch inside `pollRemoteLiveOnce()` is fire-and-forget (`.then()` chain) — must not block the bridge tick.

---

## Proxy Timeout Rules

Remote-to-gateway proxy timeouts are centralized in the `PROXY_TIMEOUT_RULES` array, resolved via `resolveProxyTimeout(method, path)`. When adding new proxy routes, add a matching rule to the array — not inline if/else logic.

---

## Inverter Card UI Baseline

- Visual hierarchy: `INVERTER XX` title → compact `Pdc`/`Pac` summary → node-table data.
- PAC strip: left side has horizontal card `Start`/`Stop`; right side has separate inline `Pdc:` and `Pac:` cells (no `|` separator).
- Node-table typography is visually subordinate to the PAC summary totals.
- Bulk Command panel is a card in the inverter grid (first card, before all inverter cards) — not a full-width bar. Participates in grid layout columns and auto-height overrides like any `.inv-card`.
- After inverter-card CSS/HTML changes, run the live Electron Playwright smoke before handoff.

---

## Scrollable Page Body Pattern

`.page` is `position: absolute; overflow: hidden; display: flex; flex-direction: column`. Content areas use a body div with `flex: 1; min-height: 0; overflow: auto`. The Inverters page uses `.inv-page-body`.

```css
.inv-page-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

Never give `flex: 1` directly to a grid or content block inside `.page` — it clips siblings.

---

## Alarm Quick-ACK

Alarm toasts are rendered by `showAlarmToast()` (not generic `showToast()`), which includes an inline ACK button (`.toast-ack-btn`) in `.toast-hdr-actions`. Clicking ACK disables the button, sends `POST /api/alarms/:id/ack`, then auto-dismisses after 1.2 s. Toast TTL: 12 s.

The notification bell panel renders `.notif-ack-btn` per unacknowledged alarm and `.notif-acked` for acknowledged ones. Both paths call `ackAlarm(id, btn)`.

---

## Operator Messaging

- Canonical messages stored only on gateway in `chat_messages` (500-row retention).
- Browser always calls its own local `/api/chat/*` routes; in `remote` mode the local server forwards to gateway.
- Remote inbound messaging uses monotonic `id` cursors. `read_ts` changes only when the operator opens the thread.
- Visible sender identity: `operatorName` plus `Server` or `Remote` only.
- Chat send rate limit: 10 messages per 60 s per machine, enforced server-side via `_chatRateBuckets`. Do not remove.
- Chat notification sound fires only for inbound messages from the opposite machine — self-sent messages are silent. Requires shared browser audio context to already be unlocked by user interaction.

---

## File and Directory Paths

| Purpose | Path |
|---|---|
| License root | `C:\ProgramData\ADSI-InverterDashboard\license` |
| License mirror | `...\license\license.dat` |
| License state | `...\license\license-state.json` |
| License registry | `HKCU\Software\ADSI\InverterDashboard\License` |
| Server data root | `C:\ProgramData\InverterDashboard` |
| Archive root | `...\InverterDashboard\archive` |
| Default export path | `C:\Logs\InverterDashboard` |
| Forecast Analytics export | `...\All Inverters\Forecast\Analytics` |
| Forecast Solcast export | `...\All Inverters\Forecast\Solcast` |
| OneDrive/GDrive backup folder | `InverterDashboardBackups` |
| Legacy portable data root | `<portable exe dir>\InverterDashboardData` |

### Forecast Export File Naming

| Source | Prefix | Subfolder |
|---|---|---|
| Trained Day-Ahead (ML from `forecast_dayahead`) | `Trained Day-Ahead ...` | `\Forecast\Analytics` |
| Solcast Day-Ahead (from `solcast_snapshots`) | `Solcast Day-Ahead ...` | `\Forecast\Solcast` |
| Solcast Toolkit (live API preview) | `Solcast Toolkit ...` | `\Forecast\Solcast` |

Do not merge or confuse these three naming prefixes. Legacy flat `...\Forecast\<file>` results are relocated automatically into the matching subfolder.

### Solcast Toolkit URL Pattern

```
https://api.solcast.com.au/utility_scale_sites/{resourceId}/recent?view=Toolkit&theme=light&hours={days*24}&period={period}
```

Settings keys: `solcastToolkitSiteRef` (resource ID only), `solcastToolkitDays`, `solcastToolkitPeriod`. Do not reintroduce a raw URL input field.