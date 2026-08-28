# IGBT Hardening + AC Contactor Health Implementation

**Date:** 2026-05-11
**Status:** Implemented (backend + UI, no schema migration)
**Version target:** v2.11.x Slice κ
**Related:** [plans/igbt-health-phase1.md](../../plans/igbt-health-phase1.md), [server/alarms.js](../../server/alarms.js) §11, [docs/Inverter-Modbus-Reference.md](../../docs/Inverter-Modbus-Reference.md)

---

## §1 — Why this slice exists

The AC contactor K1 sits between the IGBT bridge and the grid. When operators
saw repeated IGBT module failures over the lifetime of this 27-inverter plant,
the post-mortems pointed at three coupled failure modes:

1. **Welded K1 contact** → won't open after a stop command, so the IGBT bridge
   absorbs fault current that should have been isolated. Repeated exposure
   accelerates IGBT junction wear.
2. **Carbonized / worn K1 contacts** → high pole-to-pole resistance, asymmetric
   phase currents, sustained Vac spread under load. IGBT PI loop saturates
   trying to compensate.
3. **Coil weakness / chatter** → rapid close/open cycling produces in-rush
   surges that trip the IGBT branch protection (FRAMA).

The pre-Slice-κ dashboard had IGBT health monitoring but no contactor
visibility. Aging contactor wear was therefore being mis-attributed to IGBT
aging, and joint failures were being scheduled as two separate replacements
instead of one paired job.

This slice closes the gap and surfaces the coupling explicitly via a
**Linked Findings** banner in each drilldown.

---

## §2 — Files touched

| File | Kind | Summary |
|---|---|---|
| [server/acContactorHealth.js](../../server/acContactorHealth.js) | NEW | Pure-function scoring core: `computeContactorScore`, `tierForScore`, `countContactorStops`, `countContactorAlarmEpisodes`, `detectChatter`, `vacImbalanceUnderLoad`, `iacImbalanceUnderLoad`, `correlateWithIgbt`. Zero side effects. |
| [server/tests/acContactorHealthCore.test.js](../../server/tests/acContactorHealthCore.test.js) | NEW | 28 assertions covering tier bands, motive aggregation, chatter detection, imbalance math, score weights, cross-correlation rules R1–R4. |
| [server/igbtHealth.js](../../server/igbtHealth.js) | MODIFY | Added `medianImbalanceWithCount`, `dataQualityFlags`, `AGING_MOTIVES`, `TIER_BANDS`. No breaking change — original exports preserved. |
| [server/index.js](../../server/index.js) | MODIFY | Added `acContactor` require, fixed off-by-N stale motive-code constants (legacy block pre-dated Slice ε), added `loadContactorSignals` helper, three new endpoints `/api/contactor/fleet`, `/api/contactor/node/:inv/:slave`, `/api/contactor/fleet.csv`, injected `linked_findings` into IGBT drilldown response. |
| [public/index.html](../../public/index.html) | MODIFY | Subsystem tab bar above the page-toolbar (`#peSubsystemTabs`), wrapped IGBT table in `.pe-tab-pane`, added matching contactor `#contactorFleetTable` pane. Updated nav tooltip to mention both subsystems. |
| [public/js/app.js](../../public/js/app.js) | MODIFY | Tab state machine (`_peActiveTab`, `setActivePeTab`, `attachPeTabListeners`), `loadAndRenderContactorPage`, `renderContactorFleetTable`, `attachContactorTableClickListeners`, `renderContactorDrilldown`, `renderLinkedFindingsSection`. Refresh + window-days inputs now drive whichever tab is active. |
| [public/css/style.css](../../public/css/style.css) | MODIFY | `.pe-tabs`, `.pe-tab`, `.pe-linked-findings` (info/watch/act variants), `.pe-linked-list`, `.alarm-detail-asset-health` + asset-tile + linked-findings styling for the in-modal panel. |
| [public/js/app.js](../../public/js/app.js) — alarm modal | MODIFY | New `_alarmSubsystemScope`, `fetchAssetHealthContext`, `renderAssetHealthContext`, `_wireAssetHealthTileClicks`. `openAlarmDetail` now slots an asset-health placeholder when the alarm bits map onto IGBT/contactor failure modes (bits 4/5/7/8/11), and patches it in with both nodes' live scores after `/api/alarms/:id/stop-reason` resolves (inverter+unit). Tiles are deep links into the Asset Health page on the matching tab. |

**No schema changes.** All signals are derived from existing tables
(`inverter_stop_reasons_std`, `alarms`, `inverter_5min_param`).

---

## §3 — Contactor signal inventory (what feeds the score)

Five components, weights sum to 1.0:

| Component | Weight | Source | Formula |
|---|---|---|---|
| Stop reasons (motive 22/23/24) | 0.30 | `inverter_stop_reasons_std` filtered by motive_code ∈ {22,23,24} | `min(100, count × 35)` |
| Bit-11 alarm episodes (0x0800) | 0.25 | `alarms` rows where `(alarm_value & 2048) != 0` | `min(100, count × 25)` |
| Chatter (short bit-11 episodes) | 0.20 | Subset of above where `cleared_ts - ts ≤ 60_000 ms` | `min(100, chatter × 50)` |
| Vac spread under load | 0.15 | `inverter_5min_param` median `(max(vac) − min(vac))/avg(vac) × 100`, gated by `iac_avg ≥ 5 A` | Linear remap of 1.0 % → 6.0 % to 0–100 |
| Iac imbalance under load | 0.10 | `inverter_5min_param` median `max(|iac_i − avg|)/avg × 100`, gated by `iac_avg ≥ 5 A` | Linear remap of 2.0 % → 15.0 % to 0–100 |

Tier bands match the IGBT score (manual §5 convention):
healthy < 25, watch 25–49, aging 50–74, EOL ≥ 75.

### What we explicitly do NOT score yet (and why)

| Signal | Reason for deferring |
|---|---|
| Lifetime Conex counter (reg 30005-30006) | Already in the 60-reg fast read, but NOT persisted. Adding 2 INTEGER columns to `inverter_5min_param` + 1 mod in `services/inverter_engine.py` is straightforward but is a schema change — deferred until the user reconnects to the gateway so we can validate the column shape against live data. |
| In-rush Vac sag during contact closure | Only resolvable at sub-second cadence; the 5-min aggregates can't see it. Would need a new fast-bucket table. |
| Coil resistance / +15 Vdc rail telemetry | Not exposed via Modbus on this fleet. Manual multimeter test per `server/alarms.js` §11 action steps. |

---

## §4 — Linked Findings rules (acContactorHealth.correlateWithIgbt)

The symmetric correlator runs the same rule set whether the operator clicked
an IGBT row or a Contactor row. Rules below; severity rises to `act` if any
critical rule fires.

| ID | Trigger | Severity | Operator action |
|---|---|---|---|
| R1 | chatter ≥ 1 ∧ FRAMA ≥ 1 | act | Chatter in-rush is the likely trip cause — fix K1 first, FRAMA may stop. |
| R2 | contactor stops ≥ 1 ∧ Iac imbalance ≥ 5 % | watch | One K1 pole carrying less current — inspect contact resistance per pole. |
| R3 | both tiers = EOL | act | Schedule joint K1 + IGBT replacement — ignoring one accelerates the other. |
| R4 | thermal trips ≥ 1 ∧ chatter ≥ 1 | watch | Repeated in-rush elevates junction temperature; thermal trip may be symptom. |
| R5 (soft) | contactor alarm ≥ 1 ∧ IGBT tier ∈ {aging, eol} | info | Track jointly — contactor wear often masquerades as IGBT aging. |

R1, R3 stick at `act` severity. R5 only fires when no other rule has already produced a reason — it's a tie-breaker.

---

## §5 — API surface

All three contactor endpoints check `isRemoteMode()` first and proxy to the
gateway when called from a remote viewer. Same shape as the existing IGBT
endpoints (single-source-of-truth `parseWindowDays`, same `?days=` clamp,
same CSV BOM + escape helpers).

| Endpoint | Returns | Cost |
|---|---|---|
| `GET /api/contactor/fleet?days=N` | `{ ok, nodes[], summary }` per-node scores + tier counts | 108 nodes × 3 SQL counts ≈ 50 ms |
| `GET /api/contactor/node/:inv/:slave?days=N` | full drilldown with `linked_findings` | ~10 ms |
| `GET /api/contactor/fleet.csv?days=N` | UTF-8 + BOM CSV, 13 columns | ~80 ms |
| `GET /api/igbt/node/:inv/:slave` | NOW also returns `linked_findings` | unchanged |

---

## §6 — Hardening additions to IGBT module (server/igbtHealth.js)

- `medianImbalanceWithCount(rows)` returns `{ value, sample_count }` so the
  endpoint layer (and CSV exporter) can distinguish "imbalance is healthy 0 %"
  from "imbalance was synthesised as 0 because no rows met the load floor."
- `dataQualityFlags({thermalCount, framaCount, piAnaCount, imbalanceSampleCount, lastParamTsMs, now})`
  returns `{ has_stop_signal, has_imbalance, is_silent, stale_param_min }` so
  the UI can render an honest "insufficient data" badge for silent nodes
  instead of pretending they're healthy.
- `AGING_MOTIVES` and `TIER_BANDS` exported as frozen objects — eliminates the
  three off-by-N stale constants previously at the top of the IGBT endpoint
  block (legacy code from before the Slice ε motive relabel).
- Existing function signatures unchanged; existing tests still pass.

---

## §7 — Tests

- 28/28 new assertions green in
  `server/tests/acContactorHealthCore.test.js`.
- Existing IGBT pure-function tests pass unchanged (29 assertions in
  `igbtHealthCore.test.js`, ~25 in `igbtThermalCore.test.js`).
- Integration test `igbtFleetEndpoint.test.js` runs under the **Node-ABI**
  harness; current environment has Electron-ABI bindings loaded, so we did
  not exercise it from this remote session. To re-run when the gateway is
  reachable:
  ```
  npm run rebuild:native:node
  node server/tests/igbtFleetEndpoint.test.js
  npm run rebuild:native:electron
  ```

---

## §8 — Operator-visible changes

- Sidebar nav label **ASSET HEALTH** is unchanged. Tooltip now mentions both
  subsystems.
- Page header gains a 2-tab strip: **IGBT Modules** (default) and
  **AC Contactor (K1)**. Both tabs share the window-days picker, refresh
  button, tier filter chips, and the drilldown side panel.
- **IGBT drilldown** now ends with a Linked Findings banner when contactor
  events correlate with IGBT findings on the same node, same window. Banner
  is amber for watch-level rules and red for act-level rules.
- **Contactor drilldown** is symmetric — shows the same banner when IGBT
  findings correlate.
- **Alarm diagnostic modal** — when the active alarm bits map onto IGBT
  failure modes (bit 4 RMS OC, bit 5 Overtemp, bit 7 Inst OC) or contactor
  modes (bit 8 AC Prot, bit 11 Contactor Fault), the modal now shows an
  **Asset Health Context** panel directly above the per-bit cards. Two
  compact tiles render side-by-side with the node's current IGBT and AC
  Contactor scores, tier badges, top component counts, and (when present)
  the Linked Findings reasons. The tile matching the alarm's failure mode
  gets an accent border. Clicking either tile closes the modal and deep-links
  to the Asset Health page on the matching subsystem tab.
- CSV export from the Export page still drives IGBT. Contactor CSV is reachable
  at `/api/contactor/fleet.csv` directly; a dedicated Export-page button is
  the next-best follow-up but was not bundled in this slice.

---

## §8.1 — Data pipeline per section (freshness audit)

Each section of the Power Electronics page (IGBT + Contactor tabs) is fed
from a specific table. The list below is the source of truth for "where does
this number come from"; if a section ever shows blank or stale data, this
maps directly to the underlying query.

| Section | Source table | Time window | Endpoint field | Freshness guard |
|---|---|---|---|---|
| Fleet — health score | inverter_stop_reasons_std (motive counts) + inverter_5min_param (imbalance) + igbt_thermal_baseline (YoY drift) | 90 d (stops) + 1 h (params) + 365 d (baseline) | `nodes[].health_score` | none — score is always computable; a silent node scores 0 / Healthy until events appear |
| Fleet — Imb % column | inverter_5min_param | 1 h, ≥5 A load floor | `nodes[].imbalance_pct` / `vac_imbalance_pct` / `iac_imbalance_pct` | null when no in-load rows; tier-tinted when above watch/act thresholds |
| Fleet — Temp °C | inverter_5min_param.temp_c | latest row in 1 h | `nodes[].temp_pe_now_c` | null when offline |
| Fleet — Active Bits | (preferred) `alarms` table WHERE cleared_ts IS NULL · (fallback) inverter_5min_param.inv_alarms latest row | live · 5-min slot | `nodes[].live_alarm_bits` · `current_alarm_bits` | UI shows a pulsing red ● when sourcing from `live_alarm_bits` |
| Fleet — row offline tint | inverter_5min_param.ts_ms latest | last 10 min | `nodes[].is_online_now` | diagonal-stripe tint at 55 % opacity when false |
| Drilldown — stop event lists | inverter_stop_reasons_std | window param (default 90 d) | `components.*_events[]` | always |
| Drilldown — thermal baseline | igbt_thermal_baseline | rolling 90 d × 2 (YoY) | `thermal_baseline.*` | `ready=false` until 365-day cycle is complete; UI shows progress bar |
| Drilldown — Stale banner | inverter_5min_param.ts_ms | live | `current_state.last_5min_ts_ms` | watch banner > 10 min, act banner > 60 min, "No telemetry" banner when null |
| Drilldown — DC Side strip | inverter_5min_param (vdc_v, idc_a, pdc_w, pac_w) | latest row in 1 h | `current_state.vdc_v` etc. | tiles render empty when all null; stale banner above warns |
| Drilldown — AC Phase table | inverter_5min_param (vac1/2/3_v, iac1/2/3_a) | latest row in 1 h | `current_state.vac*_v` / `iac*_a` | section is omitted entirely when no rows; spread cells tinted at watch/act |
| Drilldown — Active Alarm Bits | same as fleet — `live_alarm_bits` preferred | live · 5-min slot | `current_state.live_alarm_bits` · `current_alarm_bits` | section header shows "Live" or "Recent (5-min)" badge so source is explicit |
| Drilldown — Linked Findings | server-side correlator `acContactor.correlateWithIgbt()` consuming BOTH subsystems' signals | same windows as parents | `data.linked_findings` | wrapped in try/catch on the IGBT side; contactor side re-queries IGBT signals inline (acceptable extra ~5 ms per drilldown) |

### Notes on the new live alarm pipeline

- Pre-Slice-κ the modal alarm-bits source was `inv_alarms` (OR-mask across the
  5-min slot). That value is stale by construction: it can show bits that
  cleared 4 minutes ago, and it misses bits raised in the last few seconds.
- Slice κ adds `live_alarm_bits` — the OR-mask of every uncleared row in the
  `alarms` episode table for (inverter, unit). This is the authoritative
  "what's raised right now" source. The UI prefers `live_alarm_bits` when
  non-zero and falls back to `current_alarm_bits` only when nothing is
  uncleared (so the operator still sees "raised 2 min ago" context if the
  alarm cleared in the gap between polls).
- Both masks are exposed in every endpoint payload so future consumers can
  distinguish them too.

## §8.2 — Alarm-diagnostic wiring

The Alarm Detail modal is the central diagnostic surface for any single bit
or bitmask. Slice κ wires every alarm-bit display on the Power Electronics
page into that modal so operators always reach the same diagnostic flow.

### Entry points → openAlarmDetail()

| Where you click | Carries | What the modal does |
|---|---|---|
| Alarms table row | `data-alarm-value`, `data-alarm-id` | Fetches `/api/alarms/:id/stop-reason` → gets inverter/unit → loads SCOPE snapshot + asset-health tiles |
| Inverter detail panel | `data-alarm-value`, `data-alarm-id` | Same as above |
| **Fleet table — Active Bits column** | `data-alarm-value`, `data-alarm-hex`, `data-alarm-inverter`, `data-alarm-unit` | alarmId=0, but explicit inverter+unit means asset-health tiles populate immediately without waiting for stop-reason lookup |
| **Drilldown — Active Alarm Bits chips** | same | same |

All of these route through one global delegated handler
(`wireAlarmDetailModal` in `public/js/app.js`) which reads the data-attrs
from `.cell-alarm.clickable` and calls `openAlarmDetail(value, hex,
alarmId, ctxInv, ctxUnit)`.

### Inside the modal

1. Per-bit cards — decoded from `alarm_value`, always rendered.
2. Variant warning banner — fires for bit 11 (Contactor Fault vs Branch Fault).
3. StopReason snapshot panel — only when `alarmId > 0`. Pulls SCOPE peek payload from `inverter_stop_reasons` via `/api/alarms/:id/stop-reason`.
4. **Asset Health Context tiles** — fires for bits 4/5/7 (IGBT scope) or 8/11 (Contactor scope) when the node is resolvable:
   - **Explicit-ctx path** (from PE chips): asset-health fetch fires immediately, parallel to the stop-reason fetch.
   - **Implicit path** (from alarms table): asset-health fetch chains after stop-reason resolves (because it depends on the alarm row's inverter/unit).
5. Linked Findings — included inside each asset-health tile when the cross-correlator fires.
6. Tile click → closes the modal → opens the Asset Health page on the matching subsystem tab (IGBT or Contactor).

### Closing the loop

Round-trip:
```
   PE drilldown alarm chip ──► alarm modal asset-health tile ──► PE page (same tab)
        ▲                                                              │
        └──────────────────────────────────────────────────────────────┘
                            (same node, same data)
```

No matter where the operator clicks in the diagnostic flow, the (inverter,
unit) context follows through and the health scores stay consistent.

## §8.3 — Conex K1 cycle counter (Slice κ.2 — landed 2026-05-11)

Wired the lifetime grid-connection counter (`Conex` regs 30005-30006) as a
**phase-2 cycle-rate component** on the contactor score. The signal was
already inside the existing fast-read range so this adds zero Modbus
traffic — only schema + decode + aggregation work.

### Wiring
- `services/inverter_engine.py` `read_fast_async` — decodes `_u32_hi_lo(regs, 4)` (lifetime) + `_u32_hi_lo(regs, 62)` (resettable), emits as `conex_lifetime` + `conex_resettable`
- `server/poller.js` `parseRow` — pass-through with monotone safety + null-when-absent (predates Slice κ)
- `server/dailyAggregator.js` — new `conexLifetimeLast` / `conexResettableLast` bucket fields; same anti-regression guard as `parceLast`
- `server/db.js` — additive columns `conex_lifetime_last`, `conex_resettable_last` on `inverter_5min_param` (INTEGER, nullable)
- `server/acContactorHealth.js` — new `computeCycleRatePerDay()` pure function + `cycle_rate_per_day` input to `computeContactorScore`. Phase-1 weights when null, phase-2 weights when finite
- `/api/contactor/fleet` + `/api/contactor/node` — expose `conex_lifetime`, `cycle_rate_per_day`, `cycle_total_30d`, `cycle_span_days`, `cycle_samples`, `scoring_phase`
- UI: new "K1 Wear" column group in the contactor fleet table (Cycles + Rate/day); new "K1 Cycle Counter" section in the contactor drilldown

### Score weights
| Phase | Trigger | stop | alarm | chatter | cycle | vac | iac |
|---|---|---|---|---|---|---|---|
| 1 | `cycle_rate_per_day` null (warm-up < 1 h) | 0.30 | 0.25 | 0.20 | — | 0.15 | 0.10 |
| 2 | `cycle_rate_per_day` finite (≥ 1 h history) | 0.25 | 0.20 | 0.20 | **0.15** | 0.12 | 0.08 |

Cycle-rate thresholds: floor 3/day (component starts), ceil 20/day (component saturates at 100). A healthy solar inverter cycles ~1× per day (sunrise connect / sunset disconnect); anything above the floor signals curtailment ping-pong, weak-grid disconnects, or chatter-induced repeated K1 actuations.

### Anti-regression guards
- `computeCycleRatePerDay()` ignores monotone regressions (a counter going down can only be a reset or glitch — skipped).
- Requires ≥ 1 h span between oldest/newest sample before returning a rate; otherwise null.
- Skips zero-valued samples (zero is only valid on a brand-new commissioned inverter; treat conservatively).
- 16 new tests in `acContactorHealthCore.test.js` cover the helper + the phase-2 score variants. All green.

## §8.4 — Critical Alarm Pattern detection (Slice κ.3 — landed 2026-05-11)

Forensic precursor detector for two multi-bit alarm patterns linked to
catastrophic IGBT failure. Operator quote (2026-05-11):

> *"2-day recurring 0x0240 or 0x0210 episode count must be considered
> critical already, needs attention by the inverter engineer."*

### Catalogue (in [server/criticalAlarmPatterns.js](../../server/criticalAlarmPatterns.js))

| Pattern key | Mask | Bits | Diagnosis |
|---|---|---|---|
| `DC_SUBSTRATE_BREACH` | `0x0240` | bit 6 (ADC/Sync) + bit 9 (DC Prot) | DC bus instability disrupting the analog measurement chain. Recurring episodes erode IGBT Vds margin → eventual substrate-breaching explosion that welds K1 and trips QAC + GFCI. |
| `DC_FAULT_AC_OVERCURRENT` | `0x0210` | bit 4 (RMS OC) + bit 9 (DC Prot) | DC-side protection trip co-occurring with sustained AC RMS overcurrent. Bond-wire fatigue accumulates faster than design lifetime. |

### Recurrence rule

- Window: 48 h rolling (`DEFAULT_WINDOW_MS`)
- Threshold: ≥ 2 episodes (`DEFAULT_MIN_COUNT`) → `severity = critical`
- 1 episode → `severity = watch` (early warning, single observation)
- 0 episodes → `severity = ok`
- Mask matching is superset-aware: alarm value with extra bits still matches.
- Episodes list capped at 20 per pattern at the API boundary; raw count is uncapped.

### Severity ranking (added 2026-05-12, operator ruling)

When both patterns reach `severity = critical` simultaneously, the auto-block
+ overlay must display the **worse failure mode**, not the more recent
episode. Each catalogue entry carries an explicit `severity_rank`:

| Signal | rank | rationale |
|---|---|---|
| `0x0240` DC Substrate Breach | **3** | catastrophic IGBT explosion + K1 weld + QAC/GFCI trip — happens immediately |
| `IGBT_HEALTH_EOL` (synthetic) | **2** | preventive: aggregate health score crossed EOL band before alarm fires |
| `0x0210` DC Fault + AC OC | **1** | degenerative bond-wire fatigue — accumulates over time |

### IGBT_HEALTH_EOL preventive trigger (added 2026-05-12)

Operator ruling: *"apply also the IGBT health status, preventing the IGBT
to be exploded before it happen."* The auto-block must fire on **wear-based
EOL** before the catastrophic alarm pattern reaches critical.

- `loadCriticalPatterns(inv, slave, now)` in [server/index.js](../../server/index.js) now also
  calls `_evaluateIgbtHealthEolSignal(inv, slave, now)` which mirrors the
  exact query path used by `/api/igbt/fleet` (thermal + FRAMA + PI motive
  counts over 90 d, 1 h phase imbalance, YoY drift) and invokes
  `igbtHealth.computeHealthScore`. When `tier === "eol"` (score ≥ 75) the
  helper emits a synthetic critical signal in the same shape as alarm-pattern
  entries: `{ key: "IGBT_HEALTH_EOL", hex: "EOL", severity_rank: 2,
  severity: "critical", recurring: true, health_score, health_tier,
  scoring_phase }` plus the catalogue-style `description / failure_mode /
  recommended_action` text.
- The synthetic signal flows through the existing fleet/node payloads, the
  drilldown's "Critical Patterns" section, the alarm-modal asset-health
  badge, and the fleet table row-border indicator without any code changes
  to those renderers — they iterate over `critical_patterns[]` agnostically.
- The enforcer's `decideBlockAction` uses `severity_rank` for ordering, so
  the EOL signal slots between 0x0240 and 0x0210 automatically: an active
  0x0210 block promotes to `IGBT_HEALTH_EOL` when EOL fires; an active
  `IGBT_HEALTH_EOL` block promotes to `DC_SUBSTRATE_BREACH` when 0x0240
  fires; an active `DC_SUBSTRATE_BREACH` is never demoted.
- `POST /api/critical-blocks/:inverter/simulate` accepts `patternKey:
  "IGBT_HEALTH_EOL"` so operators can preview the EOL overlay without
  waiting for real wear-band data.

`decideBlockAction()` orders critical candidates by `severity_rank` (desc),
then by `last_seen_ts` (desc) as tiebreaker. The pure helper
`patternSeverityRank(key)` looks up rank from the catalogue and is exported
so the enforcer can compare an active block's pattern against the
currently-worst critical pattern.

### Wiring

- `server/criticalAlarmPatterns.js` — NEW pure-function module (matchesPattern, countPatternEpisodesInWindow, evaluateCriticalPatterns, hasAnyCriticalPattern, worstSeverity).
- `server/tests/criticalAlarmPatternsCore.test.js` — NEW. 20 assertions covering the catalogue, mask matching with extra/missing bits, 48 h window edges, recurrence threshold tuning, NaN/non-finite handling.
- `server/index.js` `loadCriticalPatterns(inv, slave, now)` — DB-fronted helper that pulls 48 h of alarms rows for `(inverter, unit)` and runs them through the evaluator.
- `/api/igbt/fleet` + `/api/contactor/fleet` — each row gets compact `critical_patterns[]` summary + `worst_pattern_severity` + `has_critical_pattern` boolean (drives red-bordered row indicator).
- `/api/igbt/node/:inv/:slave` + `/api/contactor/node/:inv/:slave` — full pattern catalogue with episodes, recommended-action text, threshold info.
- UI:
  - `renderCriticalPatternsSection()` in [public/js/app.js](../../public/js/app.js) — red-bordered card block rendered at the **top** of both IGBT and AC Contactor drilldowns. Card carries per-pattern severity badge, episode timeline (capped at 6 visible + count of remaining), failure-mode + recommended-action text.
  - Fleet tables — rows with `worst_pattern_severity === "critical"` get `.pe-row-critical-pattern` (red left border + tint); `"watch"` gets `.pe-row-watch-pattern` (orange left border).
  - Alarm modal asset-health context (`renderAssetHealthContext`) — adds `.alarm-asset-crit` block listing any `critical`/`watch` patterns inline with the IGBT/Contactor tiles so operators see the precursor without leaving the alarm context.
- CSS additions in [public/css/style.css](../../public/css/style.css): `.pe-crit-section*`, `.pe-crit-card*`, `.pe-crit-bit`, `.pe-crit-mask`, `.pe-crit-meta`, `.pe-crit-failure`, `.pe-crit-action`, `.pe-crit-episodes`, `.pe-row-critical-pattern`, `.pe-row-watch-pattern`, `.alarm-asset-crit*`.

## §8.5 — Critical-pattern auto-block (Slice κ.3 — landed 2026-05-12)

Operator quote (2026-05-11, follow-up):

> *"Block START control of the entire Inverter once after 2-day of re-occurrence still not resolved. STOP the generation automatically and block the control on the inverter card and put notice overlayed on it."*

When `evaluateCriticalPatterns` returns `severity = critical` on **any node** of an inverter, the gateway autonomously:

1. **Opens a critical-block row** in `inverter_critical_blocks` (`acked_at_ms IS NULL` = active). The chosen pattern is the highest-`severity_rank` critical pattern across all slaves (per §8.4 severity ranking).
2. **Issues STOP (`value=0`) to every configured slave** of that inverter via the existing `executeLocalControlWriteRequest` path with `operator: "SYSTEM:CRIT_BLOCK"` so the write-path block guard exempts the system itself.
3. **Re-enforces STOP** every 5 min (`RE_ENFORCEMENT_INTERVAL_MS`) until the operator acks. Re-enforcement is gated by a cooldown to avoid hammering the Modbus queue.
4. **Refuses manual START/STOP** at `/api/write` and `/api/write/batch` while the block is active (HTTP 423 Locked). The system-issued STOP itself bypasses.
5. **Broadcasts `critical_block_changed` over WS** so all connected clients drop the overlay or apply it instantly without waiting for the 30 s poll.
6. **Promotes the block** when an active block carries a lesser pattern and a more-severe pattern reaches critical on the same inverter (e.g. block opened on `0x0210`, then `0x0240` becomes critical). The block row is updated in place via `updateCriticalBlockPattern` — `pattern_key` / `pattern_hex` / `pattern_label` / `triggering_slave` / `count_in_window` / `latest_episode_ts` change; `created_at_ms`, `stop_issued_at_ms`, `reenforce_count` are preserved. No new STOP is issued (the inverter is already stopped). The audit row reads `action = critical_block_promoted` with `reason = promoted_<from>_to_<to>`.

### Files touched

| File | Kind | Summary |
|---|---|---|
| [server/db.js](../../server/db.js) | EDIT | New table `inverter_critical_blocks` + DAO: `getActiveCriticalBlock`, `getAllActiveCriticalBlocks`, `getCriticalBlockHistory`, `insertCriticalBlock`, `updateCriticalBlockReenforcement`, `ackCriticalBlock`. |
| [server/criticalPatternEnforcer.js](../../server/criticalPatternEnforcer.js) | NEW | Pure decision logic (`decideBlockAction`) + side-effect-injected runner (`enforceOne`) + API summarizer. |
| [server/tests/criticalPatternEnforcerCore.test.js](../../server/tests/criticalPatternEnforcerCore.test.js) | NEW | 12 assertions: decision matrix (noop / open_block / reenforce / skip_reenforce), STOP fan-out to all configured slaves, block row survives STOP failure, API summarizer null/active/acked. |
| [server/index.js](../../server/index.js) | EDIT | Enforcer tick every 2 min (first run + 90 s after boot, gateway-only). New endpoints: `GET /api/critical-blocks` (active map keyed by inverter), `GET /api/critical-blocks/:inverter` (history), `POST /api/critical-blocks/:inverter/confirm` (operator ack, gated by bulk-control auth). Write-path block guard added to `executeLocalControlWriteRequest` + `executeLocalBatchControlWriteRequest`. |
| [public/js/app.js](../../public/js/app.js) | EDIT | `State.criticalBlocks` map + `refreshCriticalBlocks()` (30 s poll + WS-triggered). `_renderCriticalBlockOverlay()` paints red barber-pole overlay with `mdi-alert-octagram` glyph + pattern info + "Confirmed (issue fixed)" button. `confirmCriticalBlock()` runs a 3-step prompt (confirm + auth key + optional note) before posting to `/api/critical-blocks/:inv/confirm`. Card click delegation gates START/STOP and node-toggle clicks while blocked. Card buttons get `disabled` attr each render tick as defense in depth. WS handler picks up `critical_block_changed`. |
| [public/css/style.css](../../public/css/style.css) | EDIT | `.inv-card.crit-blocked`, `.inv-card-crit-overlay` (animated barber-pole), `.inv-crit-overlay-inner`, `.inv-crit-confirm-btn`. |

### Operator unblock flow

1. Operator sees red overlay on the inverter card: *"BLOCKED — 0x0240 DC Substrate Breach Precursor — N episodes in 48 h"*.
2. Clicks the white **"Confirmed (issue fixed)"** button.
3. Browser prompts: confirmation modal with pattern details, then prompts for the bulk-control auth key (sacupsMM pattern), then optional note ("Replaced K1 contactor", "Reseated DC bus", etc.).
4. POST `/api/critical-blocks/:inv/confirm` writes `acked_at_ms`, `acked_by`, `ack_note` to the block row and broadcasts removal.
5. Overlay clears; manual control is re-enabled.
6. If a new critical episode lands after the ack, a **new** block row is created (history is preserved).

### Safety properties

- **Idempotent**: re-enforcement loop only re-issues STOP after the 5-min cooldown; no rapid-fire writes.
- **Fail-safe**: STOP write failure does NOT roll back the block row — the safety intent (gated manual control) persists even if the inverter is unreachable.
- **Audit trail**: every open / re-enforce / ack writes to `audit_log` via `db.insertAuditLogRow`. Block row itself carries `created_at_ms`, `stop_issued_at_ms`, `last_reenforced_ms`, `reenforce_count`, `acked_at_ms`, `acked_by`, `ack_note`.
- **Gateway-only**: the enforcer tick early-returns when `isRemoteMode()`. Remote viewers read the gateway's authoritative block state via the proxied API + WS broadcast.
- **System bypass is explicit**: only writes with `operator === "SYSTEM:CRIT_BLOCK"` skip the block guard. Any other operator (including the original `OPERATOR` default) is refused with HTTP 423.

## §8.6 — False-positive hardening contract (Slice κ.4 — landed 2026-05-12)

Operator ruling: *"avoid false decision to avoid inverter unnecessary
downtime. make sure to harden that well and is connected to each sources
carefully and precise."* Six gates land at distinct points in the
detection pipeline. Each gate is independently testable and each refuses
to fire the auto-block when its precondition is unmet, rather than
softening downstream thresholds — defence in depth.

| Gate | Where | What it prevents |
|---|---|---|
| **1. Episode spacing** | `criticalAlarmPatterns.countPatternEpisodesInWindow` — new `minSpacingMs` arg, default `DEFAULT_MIN_EPISODE_SPACING_MS = 30 min`. Threaded through `evaluateCriticalPatterns(opts.minSpacingMs)`. | Alarm flaps (same fault re-raising the bit within seconds) being counted as multiple episodes. Five fast flaps → one episode → `severity = watch`, not `critical`. Pre-dedup count is preserved as `raw_matches` so the audit still sees the raw signal. |
| **2. Popcount filter** | `criticalAlarmPatterns.matchesPattern` — uses `_popcount16` to reject alarm payloads with > `MAX_ALARM_BITS_FOR_PATTERN = 8` bits set. | Sensor / firmware glitches (e.g. `alarm_value = 0xFFFF`, all 16 bits set) trigger every catalogue pattern at once. A single comm reset previously could fire 0x0240 AND 0x0210 simultaneously. |
| **3. Configured-node check** | `server/index.js loadCriticalPatterns` — `lookupConfiguredNode(cfg, inv, slave)` gate at the top. Returns "all ok" patterns if the node isn't currently in ipconfig. | Auto-blocking on a node that has been removed from service. The alarms table retains rows for nodes no longer in ipconfig; without this gate, an operator decommissioning a node could trigger a block on a phantom unit. |
| **4. Online check (EOL only)** | `server/index.js _evaluateIgbtHealthEolSignal` — queries latest `inverter_5min_param.ts_ms` for the node; returns null if `> EOL_MAX_PARAM_STALENESS_MS = 30 min` stale. | EOL firing on an inverter that's already offline. The 90-day score is a *historical* signal; if the node hasn't reported in 30 min, the operator can't act on the result anyway, and the alarm-pattern path (which uses persisted alarm rows) still works. Does NOT block alarm-pattern detection — those rows are real even after a node goes offline. |
| **5. EOL data sanity** | Same helper — requires either `≥ EOL_MIN_PARAM_ROWS (3)` recent 5-min samples OR `≥ EOL_MIN_STOPREASON_ROWS (5)` stop-reason events in the 90-day window. | Freshly-commissioned nodes with sparse data landing in EOL spuriously. Returns null otherwise (no signal emitted). |
| **6. Enforcer re-entrancy guard** | `server/index.js _runCriticalPatternEnforcerTick` — `_critBlockTickInFlight` + `_critBlockTickQueued` mutex pair. | Two ticks overlapping (the tick does ~108 DB reads + serial Modbus STOP fan-out) and double-firing STOP commands or racing on the block row. A second fire while a tick is in flight is coalesced into a single follow-up tick via `setImmediate`. |

### Forensic surfacing

Every block row + every `critical_patterns[]` entry now carries:

- `raw_matches` — pre-dedup matching alarm rows (the pre-Gate-1 count)
- `min_spacing_ms` — the spacing setting applied
- `last_param_ts_ms` — proof the node was online when EOL fired (Gate 4)
- `param_rows_1h` / `stop_reasons_90d` — proof the data passed Gate 5
- `breakdown` — per-component health score so the inspection guide can
  point at the dominant aging axis

### Test coverage

`server/tests/criticalAlarmPatternsCore.test.js` adds 7 new assertions:

- `matchesPattern: rejects 0xFFFF` (Gate 2)
- `matchesPattern: still accepts realistic multi-bit payloads` (Gate 2 boundary)
- `countPatternEpisodesInWindow: dedups flaps within minSpacingMs` (Gate 1)
- `countPatternEpisodesInWindow: rejects 0xFFFF rows entirely` (Gate 2)
- `evaluateCriticalPatterns: production default applies 30-min spacing` (Gate 1 default wiring)
- `evaluateCriticalPatterns: explicit minSpacingMs=0 restores legacy raw count` (Gate 1 escape hatch)

Two pre-existing tests were updated to pass `minSpacingMs: 0` so they still
assert the raw-count semantics they were written for. Gates 3 / 4 / 5 / 6
exercise live DB / clock state and are validated end-to-end via the
demo flow (`/simulate` → overlay → Confirm → audit log).

### Tunables (operator override via `setting` keys, planned for Slice κ.5)

| Constant | Default | Where |
|---|---|---|
| `DEFAULT_MIN_EPISODE_SPACING_MS` | 30 min | `server/criticalAlarmPatterns.js` |
| `MAX_ALARM_BITS_FOR_PATTERN`     | 8       | `server/criticalAlarmPatterns.js` |
| `EOL_MIN_PARAM_ROWS`             | 3       | `server/index.js` |
| `EOL_MIN_STOPREASON_ROWS`        | 5       | `server/index.js` |
| `EOL_MAX_PARAM_STALENESS_MS`     | 30 min  | `server/index.js` |
| `RE_ENFORCEMENT_INTERVAL_MS`     | 5 min   | `server/criticalPatternEnforcer.js` |
| `CRITICAL_BLOCK_ENFORCE_INTERVAL_MS` | 2 min | `server/index.js` |

## §8.7 — Counter reset on Confirm + graceful STOP (Slice κ.5 — landed 2026-05-12)

Two operator-driven safety changes after observing the demo:

### Counter reset on Confirm

> *"reset the counter before alarm reappear again after confirmation."*

When the operator clicks **Confirmed (issue fixed)** on the inverter card,
the assumption is they've physically inspected and resolved the underlying
fault. Pre-ack alarm rows are historical evidence of the SAME fault — if
the auto-block kept counting them after the operator confirmed, a single
fresh alarm at T+5 min would already push the in-window count back to 3
and re-block immediately. That's a poor operator experience and risks
unnecessary downtime.

**Mechanism**: `loadCriticalPatterns` resolves the latest acked block for
the inverter via `getLatestAckedCriticalBlock(inverter)` and uses
`max(48h-window-cutoff, latest_ack_at_ms)` as the effective alarm-query
floor. So:

- A confirmed block at T=10:00 effectively zeros the recurrence counter.
- A fresh alarm at T=10:05 makes the count `1` → severity `watch`, not
  `critical`. The operator sees the warning but isn't auto-blocked again.
- A second fresh alarm at T=10:35 (≥ 30 min later, per Gate 1) brings the
  count to `2` → severity `critical` → block re-fires. This is real
  recurrence after the fix, and warrants another block.

The DAO helper `getLatestAckedCriticalBlock(inverter)` is a new export
from [server/db.js](../../server/db.js) and is destructured at the top of
[server/index.js](../../server/index.js).

### EOL post-ack grace period

The 90-day IGBT health score doesn't reset just because an operator
confirmed — but if they've replaced the module, the historical wear is
no longer the right basis for blocking. To bridge that:

- `EOL_POST_ACK_GRACE_MS = 24 h` — after a Confirm, the synthetic
  `IGBT_HEALTH_EOL` signal is suppressed for 24 h. New stop-reasons /
  imbalance / YoY-drift accumulating on the new module will pull the
  score down by then.
- If after 24 h the score is *still* in the EOL band (≥ 75), the fix
  presumably didn't help and the block re-fires — that's a real signal
  the module wear hasn't actually decreased.
- Gate 7 is the cheapest filter (one DAO lookup) and runs before the
  five expensive health-component queries; ack grace is a fast-path.

### Graceful STOP

> *"make sure that before blocking, STOP the inverter gracefully."*

The pre-Slice-κ.5 implementation fired STOP to every slave of the blocked
inverter sequentially with `await`, but with no inter-slave settle delay.
On a shared AC bus that means all four K1 contactors open within ~tens of
milliseconds, producing a coincident voltage transient + di/dt that
adjacent inverters can see.

**`STOP_PER_SLAVE_DELAY_MS = 1500 ms`** (in
[server/criticalPatternEnforcer.js](../../server/criticalPatternEnforcer.js))
inserts a settle delay BETWEEN per-slave STOPs — not BEFORE the first one.
The block row + UI overlay still land synchronously on tick fire; the
delays only govern the hardware sequence. 1500 ms is conservative:

- ≫ K1 mechanical settle (typ. 50–80 ms)
- ≫ IGBT gate-driver soft-shutdown ramp (typ. ms)
- ≪ operator perception of "still responsive"

The constant is exposed via `deps.stopPerSlaveDelayMs` in the enforcer
dependency contract, so tests can pass `0` for deterministic timing and a
future operator setting can tune it without code changes.

### Tests added (criticalPatternEnforcerCore.test.js)

- `STOP_PER_SLAVE_DELAY_MS = 1500 ms (graceful-stop default)`
- `enforceOne: graceful STOP — delay between slaves, NOT before the first`
  (asserts ≥ 70 ms total elapsed for 4 slaves × 25 ms settle, AND ≥ 20 ms
  gap between slaves 1 → 2)
- `enforceOne: stopPerSlaveDelayMs=0 disables graceful spacing` (legacy
  test-mode escape hatch; total elapsed < 100 ms)

### Tunables added

| Constant | Default | Where |
|---|---|---|
| `EOL_POST_ACK_GRACE_MS` | 24 h | `server/index.js` |
| `STOP_PER_SLAVE_DELAY_MS` | 1500 ms | `server/criticalPatternEnforcer.js` |

## §8.8 — 0x0040 (ADC/Sync Persisting) — early precursor (Slice κ.6, 2026-05-12)

Operator field observation: *"include the alarm 0x0040 in the count that
is also persisting before the explosion."*

`0x0040` (bit 6 alone — ADC/Sync error) is added as a fourth catalogue
entry, sitting between EOL and 0x0210 in the new 4-tier rank scale:

| Signal | rank | Failure mode position |
|---|---|---|
| `0x0240` DC Substrate Breach | **4** | catastrophic / immediate (the explosion mode) |
| `IGBT_HEALTH_EOL` (synthetic) | **3** | preventive — aggregate wear at EOL |
| `0x0040` ADC / Sync Persisting | **2** | early-warning — sensor-side disturbance precursor to 0x0240 |
| `0x0210` DC Fault + AC Overcurrent | **1** | degenerative — bond-wire fatigue |

The progression operators observed in the field is: `0x0040` (ADC/Sync
disturbed but not yet escalated) → `0x0240` (disturbance now coupled
with DC-protection trip) → IGBT explosion. Catching `0x0040` while it's
still on its own gives the inverter engineer the longest possible
intervention window.

### Mutual exclusion via `exclude_mask`

Naive mask matching would double-count `0x0240` events toward `0x0040`'s
counter (because `(0x0240 & 0x0040) === 0x0040`). The new
`exclude_mask` field on the catalogue entry — set to `0x0200` on
`0x0040` — makes the matcher reject any value that ALSO has bit 9 set:

```
matchesPattern(value, mask, excludeMask):
  (value & mask) === mask         // every mask bit present
  AND (value & excludeMask) === 0 // no exclude bit present
```

So a single alarm row never counts toward both buckets. `0x0240` events
fire only the `0x0240` counter; `0x0040` events fire only the `0x0040`
counter; the operator sees both signals tracked independently.

### Tests added

- `CRITICAL_PATTERNS contains 0x0240, 0x0210, and 0x0040`
- `Catalogue rank order: 0x0240 > EOL-rank > 0x0040 > 0x0210` (asserts
  there's room for the synthetic EOL signal between 0x0240 and 0x0040)
- `0x0040 carries exclude_mask = 0x0200 (mutually exclusive with 0x0240)`
- `matchesPattern: excludeMask blocks otherwise-matching value`
- `evaluateCriticalPatterns: 0x0040 (alone) recurs → critical; 0x0240 unchanged`
- `evaluateCriticalPatterns: 0x0240 event does NOT also count toward 0x0040`
- `evaluateCriticalPatterns: mixed 0x0040 + 0x0240 — each counted in its own bucket`

### Demo

Same simulate endpoint works:
```powershell
$m = (Get-Date).Minute
$body = @{ patternKey = "ADC_SYNC_PERSISTENT" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3500/api/critical-blocks/1/simulate" `
  -Method POST -Headers @{ "x-topology-key" = "adsi$m" } `
  -ContentType "application/json" -Body $body
```

The overlay will read `BLOCKED — 0x0040 ADC / Sync Persisting (Pre-
Substrate-Breach)`. Same Confirm flow clears it.

## §9 — Action items deferred to next on-gateway session

1. ~~Persist Conex lifetime counter (regs 30005-30006) for proper wear-cycle tracking.~~ ✅ **Landed Slice κ.2 — see §8.3.**
2. Add a dedicated contactor CSV button on the Export page.
3. Wire a smoke test that exercises both endpoints end-to-end against a
   seeded test DB (mirror the existing `igbtFleetEndpoint.test.js`).
4. Run `npm run smoke` in Node-ABI mode, then `rebuild:native:electron`
   before any installer build.
5. Capture before/after screenshots from the dashboard for the v2.11.x
   release notes.
6. End-to-end soak: trigger a synthetic 0x0240 recurrence on a non-production
   inverter and verify the auto-block → STOP → overlay → operator-ack → unblock
   round-trip end-to-end against a live gateway (the pure-function tests
   cover the decision matrix but not the Modbus fan-out + DB persistence).
7. Add a User Guide section explaining the red overlay + the "Confirmed" flow
   so first-time operators don't mistake it for a regular alarm and panic.

---

## §10 — Risks / known limitations

- Bit-11 mapping is fleet-specific. On AAV2011 firmware variants the same bit
  means a branch fault, not a contactor fault — this is documented in
  `server/alarms.js` §11.variantWarning. The fleet here is 920TL where bit 11
  *does* mean contactor, so the score is valid for this site only.
- Chatter detection uses `cleared_ts - ts ≤ 60 s` as the proxy. A genuine
  brief contactor fault that auto-recovers will look like chatter. Operator
  judgement still required when chatter_count is 1.
- `iac/vac imbalance under load` only works when current crosses the
  `VAC_LOAD_FLOOR_A = 5 A` threshold for ≥1 sample in the rolling hour. Quiet
  / overnight / cloudy windows therefore contribute zero — that's correct
  behaviour, but the UI shows `0` not `n/a` so operators reading a midnight
  snapshot might mistake "no data" for "no imbalance." The drilldown does
  show `imbalance_sample_count` so this is recoverable on inspection; the
  fleet table does not surface it.
