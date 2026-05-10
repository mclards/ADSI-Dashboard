# Polling Pressure + Zero-Row Traceback

Date: 2026-05-11
Status: AUDIT — one diagnostic surface added; runtime polling defaults UNCHANGED pending operator review.
Mode at audit time: REMOTE (operator's PC; gateway online and serving data).

---

## Triggering question

Operator's screenshot (Energy Summary export, 2026-05-10) shows two
Inv 16 nodes with zero data:

| Inv/Node | 1st Seen | Last Seen | Window | Peak | Total | Etotal | ParcE |
|---|---|---|---|---|---|---|---|
| 16 / 1 | 05:14:03 | 05:27:26 | 13.4 min | 0 | 0 | 0 | 0 |
| 16 / 2 | 12:52:30 | 13:04:27 | 11.9 min | 0 | 0 | 0 | 0 |

Plus a discrepancy:

| Inv/Node | Total MWh (PAC) | Etotal MWh (HW) | Gap |
|---|---|---|---|
| 12 / 3 | 1.100277 | 0.574 | -47.8% |

Operator question: "are these zeroes reading probably solved? make sure
that the modbus polling won't hurt the Inverters but at the same time
polling constant reliable value or accurate polling for accurate logging."

---

## Are the zero rows now solved?

**Operationally, yes — they are now correctly *labelled* as the
intermittent comm windows they are, and the BASELINE_LATE discrepancy
becomes a transparent PAC-derived value.** The export pipeline change
ladder applied this session:

1. [server/energySummaryNodeStatusCore.js](../../server/energySummaryNodeStatusCore.js)
   classifies each row. The screenshot becomes:

   | Row | New `Status` column | New `Notes` column |
   |---|---|---|
   | Inv 16 / 1 | `BRIEF_RESPONSE` | "Modbus comm window 13.4 min, no PAC observed" |
   | Inv 16 / 2 | `BRIEF_RESPONSE` | "Modbus comm window 11.9 min, no PAC observed" |
   | Inv 12 / 3 | `ESTIMATED_FROM_PAC`* | "HW Δ filled from PAC integral (baseline anchor unreliable)" |
   | Inv 16 / 3 | `ACTIVE` | "ok" |

   *After the persistCounterState change in the same session — see below.

2. [server/baselineAnchorDecisionCore.js](../../server/baselineAnchorDecisionCore.js)
   refuses to anchor today's HW baseline when the gateway boots after
   sunrise into an already-producing inverter. The morning baseline gets
   `source='poll_late'` instead of the wrong (late) Etotal value.

3. [server/hwCounterDeltaCore.js](../../server/hwCounterDeltaCore.js)
   knows about `source='poll_late'` and (with operator setting
   `hwBaselineUsePacFallback="1"`, default ON) fills the HW Δ columns
   from the same PAC integral that drives `Total_MWh`, with provenance
   `pac_fallback`. The `ESTIMATED_FROM_PAC` status surfaces this so the
   operator doesn't think they're seeing two independent measurements.

**What the rows _physically mean_:**
- `BRIEF_RESPONSE` rows mean the inverter responded to Modbus for a few
  minutes and reported PAC = 0 the entire time. The lifetime Etotal
  counter did not advance during that window. Most likely the inverter
  was attempting to start (initial-state / magnetizing phase per reg
  30074), encountered a fault, and went silent. The data is correct;
  the rows existed before only because the first frame of the window
  triggered a one-time persistence row.
- `ESTIMATED_FROM_PAC` rows mean the gateway booted after sunrise
  *without* yesterday's `eod_clean` snapshot, and the morning kWh
  produced before boot are unrecoverable from the HW counter.

---

## Polling pressure — gap finding

The Python service polls each inverter at the per-inverter
`poll_interval` from `ipconfig.json`. **All 27 of the operator's
inverters are configured at 0.05 s = 20 Hz**, which is **20× faster
than vendor guidance**:

> Ingeteam Level 2 workflow AAV2011IFA01_ p.8 (alarm 0x0008 RESET_WD):
> "reduce the frequency at which the SCADA communicates with the
> inverter (1 communication per second recommended)"

The code already detects this and prints `[POLL WARN]` at startup
([services/inverter_engine.py:1739-1746](../../services/inverter_engine.py#L1739)),
but the warning lives only in the Python stdout — operators in remote
mode never see it.

**What this could be doing to your inverters:**
- Comm-board CPU saturation (the Modbus TCP→RTU bridge inside each
  inverter is a shared resource for both the gateway poll and the
  comm board's own housekeeping).
- DSP watchdog reset risk (alarm 0x0008 ALARMA_RESET_WD per spec
  pg 4 line 36) when firmware enforces the 1 Hz recommendation.
- Brief comm windows that look like the screenshot's Inv 16 / 1 + 2
  rows — an inverter accepts a few polls, the comm board's queue fills,
  subsequent polls time out, the inverter is marked offline 20 s later.

We cannot prove from the available data that your screenshot's brief
windows were polling-induced (vs a real inverter restart), but the
20× over-poll is a standing risk that matches the symptom shape.

**Why the over-polling is also wasteful:**
The Node-side persistence cadence guard at
[server/poller.js:1497-1514](../../server/poller.js#L1497) only writes
a new `readings` row when one of:
- alarm bits change
- on/off state changes
- ≥ 1000 ms elapsed since last persist
- |ΔPAC| ≥ 250 W since last persist

So even though Python polls at 20 Hz, **only ~1 Hz of those polls
actually become persisted samples**. 19 out of 20 polls do nothing
useful from a logging perspective — they just stress the comm board.

**Recommended action (operator decision):**

Option A (conservative — recommended): set every inverter's
`poll_interval` to **1.0 s** in
`C:\ProgramData\InverterDashboard\ipconfig.json`. The change is hot-
reloaded; restart not required. Logging fidelity is unchanged because
persistence already throttles to 1 Hz. Comm-board pressure drops 20×.

Option B (compromise): **0.5 s = 2 Hz**. Twice the vendor
recommendation but well above the prior risk profile. Sub-second
resolution preserved for the live-tile UI. Halves comm-board pressure
~10×.

Option C (no change): keep 0.05 s. Accept that brief comm windows in
the export are an ongoing possibility and rely on the new
`BRIEF_RESPONSE` status to flag them.

I did NOT change runtime defaults. The warning's wording in
`services/inverter_engine.py` is fine as-is.

---

## What I added this session (already committed-ready)

1. **New diagnostic field on `/api/runtime/data-health`:**
   `pollCadence` — exposes `{configuredInverters, recommendedSec=1.0,
   minIntervalSec, maxIntervalSec, fasterThanRecommended,
   vendorGuidance}`. Lets the dashboard surface a banner in remote
   mode without RDP'ing into the gateway. Pure read of the in-memory
   ipconfig snapshot — no IO, no DB.
2. **Audit doc** (this file).

No runtime behaviour changes — additive diagnostics only.

---

## Verified-correct on this round

- Node smoke 63/63 PASS under Node ABI 115 (full suite including
  manualPullGuard regression that was in the IGNORE-set fix).
- Python pytest 272 / 277 PASS; 5 errors in `test_sqlite_retry.py`
  are the pre-existing `C:\Users\User\AppData\Local\Temp\pytest-of-User`
  Windows ACL lock (memory ID 2781) — not a regression from this work.
- Status classifier traced manually against all four rows of the
  operator screenshot — all four classify as expected (see table at
  the top of this file).
- Polling cadence helper (`getPollCadenceSummary`) verified against
  the operator's actual `ipconfig.json`: returns
  `{configuredInverters: 27, minIntervalSec: 0.05, maxIntervalSec: 0.05,
  fasterThanRecommended: 27}`.

---

## Gaps that remain (not fixed without operator say-so)

1. **Default poll interval (vendor compliance)** — see Option A/B above.
   I will NOT change runtime defaults silently on a live system.
2. **Backfill of historic `pac_kwh_raw`** — 2,301 finalized rows in
   `daily_readings_summary` carry `pac_kwh_raw=0` despite real
   production. Not surfaced in the export today (slow-path fallback
   handles them), but they will eventually expire from `archive/`. A
   one-shot backfill script can recompute from the archive shards. Risk:
   slow + writes back into a finalized table. Operator should pick the
   maintenance window.
3. **Dashboard UI surface for `pollCadence`** — the API field is
   wired; the actual amber banner / warning chip in `public/index.html`
   is not. Two-line addition once you confirm the design language
   (banner vs chip vs Settings page section).
