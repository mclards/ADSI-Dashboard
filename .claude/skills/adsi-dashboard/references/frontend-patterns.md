# Frontend Patterns Reference

## Themes

Three themes: `dark`, `light`, `classic`. Always use shared CSS tokens:
`--bg`, `--surface`, `--surface2`, `--border`, `--border2`, `--text`, `--text2`, `--text3`, `--accent`

Never hardcode one-off colors. Validate all changes against all three themes. PAC legend signal colors are fixed across all themes: green, yellow, orange, red, blinking red for alarm.

## Scrollable Page Body Pattern

`.page` is `position: absolute; overflow: hidden; display: flex; flex-direction: column`. Never give `flex: 1` directly to a grid or content block inside `.page`.

```css
.some-page-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

## Inverter Card Layout

Hierarchy: `INVERTER XX` title → compact `Pdc`/`Pac` summary → node-table data. PAC strip: `Start`/`Stop` left, `Pdc:`/`Pac:` cells right, no `|` separator. Node-table typography is subordinate to PAC totals.

Bulk Command panel is the first card in the inverter grid — not a full-width bar. Participates in grid layout like any `.inv-card`.

## Inverter Detail Panel

`filterInverters()` calls `loadInverterDetail(inv)` / `clearInverterDetail()`. Render functions `renderInverterDetailStats`, `renderInverterDetailChart`, `renderInverterDetailAlarms`, `renderInverterDetailHistory` live after `filterInverters()`. Panel sits inside `.inv-page-body` alongside `#invGrid`.

Stats and alarms render first. The 7-day `/api/report/daily` history fetch is best-effort and bounded by a timeout — do not block initial rendering on it.

## Tab Date Initialization

`initAllTabDatesToToday()` runs on startup and on day rollover inside `startClock()`. Day rollover also clears `State.tabFetchTs`.

## Startup Tab Prefetch

`prefetchAllTabs()` warms Alarms, Report, Audit, and Energy sequentially during the loading phase. The main window stays behind the loading screen until critical bootstrap data and the first live WebSocket sample are ready. `TAB_STALE_MS = 60000`. Do not revert to a delayed parallel fire-and-forget path.

## PAC Indicator Thresholds

`getPacRowClass()` uses `NODE_RATED_W = 249,250 W`:
- ≥90% → High (green `#00cf00`)
- >70% → Moderate (yellow `#ffff00`)
- >40% → Mild (orange `#ffa500`)
- ≤40% → Low (red `#ff0000`)
- Alarm active → blink animation

Static `.pac-legend-wrap` in the inverter toolbar.

## App Confirm Modal

`appConfirm(title, body, {ok, cancel})` → `Promise<boolean>`. Replaces all native `confirm()` and `alert()`. DOM: `#appConfirmModal` + `.confirm-dialog`. Initialized via `initConfirmModal()` from `init()`.

## Alarm Quick-ACK

Use `showAlarmToast()` not `showToast()`. Inline ACK button (`.toast-ack-btn`) in `.toast-hdr-actions`. Toast TTL 12 s. After ACK: auto-dismiss after 1.2 s. Bell panel renders `.notif-ack-btn` / `.notif-acked`. Both paths call `ackAlarm(id, btn)`.

## Availability Computation

`getDailyReportRowsForDay(today, { includeTodayPartial: true })` computes live availability. The `/api/report/daily` range handler splices in the live result when today is in range. Detail panel 60 s refresh fetches both `/api/energy/today` and `/api/report/daily?date=<today>` and merges into `State.invDetailReportRows`.

## Real-Time Metric Alignment

When today is selected on Analytics or Energy, `applyCurrentDaySummaryClient` calls `renderAnalyticsFromState()` on every WebSocket `todaySummary` push. `extractCurrentDaySummary()` parses the flat `todaySummary` WS object — not a nested shape. Do not reintroduce a separate `patchAnalyticsSummaryLive` function.

## WebSocket Reconnection

Exponential backoff with jitter: `Math.min(30000, 500 × 1.5^retries + random × 500 × retries)`. Do not revert to linear — prevents thundering herd with multiple remote clients.

## Gateway Link Stability

- Adaptive polling: `max(1200, latency × 2)` when latency > 400 ms
- `REMOTE_LIVE_FAILURES_BEFORE_OFFLINE = 6` (10 during sync) — do not lower
- `REMOTE_LIVE_DEGRADED_GRACE_MS = 60000` — do not lower
- `REMOTE_LIVE_STALE_RETENTION_MS = 180000` — do not lower
- Gateway `keepAliveTimeout = 30 s` — must stay above client keepAlive (15 s)
- `/api/energy/today` fetch inside `pollRemoteLiveOnce()` is fire-and-forget — must not block the bridge tick

## Proxy Timeout Rules

All proxy route timeouts are centralized in `PROXY_TIMEOUT_RULES`, resolved via `resolveProxyTimeout()`. Add new route timeouts there — not inline.

## Weather Offline Hardening

`fetchDailyWeatherRange()` in `server/index.js` wraps the weather API fetch in try/catch. On failure it serves the stale in-memory cache with a `console.warn`. Only re-throws if there is no cached data at all.

## User Guide Sync

Any UI change must update all three formats before handoff:
- `docs/ADSI-Dashboard-User-Guide.html`
- `docs/ADSI-Dashboard-User-Manual.md`
- `docs/ADSI-Dashboard-User-Guide.pdf`

PDF regeneration: `chrome --headless=new --disable-gpu --no-sandbox --print-to-pdf="<pdf>" --print-to-pdf-no-header "<html>"`

User Guide version header tracks `package.json`.