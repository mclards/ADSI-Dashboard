# Solcast-Outage Resilience — Physics Fallback

**Date:** 2026-05-30
**Status:** DONE — verified (542/542 Python tests green, EXIT 0). Post-merge adversarial
review found 3 real defects in the FIRST cut (below); all fixed + regression-tested.
**Scope:** `services/forecast_engine.py` (`run_dayahead`, `_write_forecast_run_audit_from_python`,
new `_setting_bool_or_default`), `server/index.js` (`buildSettingsSnapshot`),
`services/tests/test_forecast_engine_audit_fixes.py`,
`services/tests/test_forecast_engine_error_classifier.py`,
`.claude/skills/adsi-dashboard/references/forecast-engine.md`
**Driver:** operator concern — the engine was over-reliant on Solcast; if Solcast were
totally unavailable the day-ahead forecast could fail entirely.

---

## The risk (confirmed in code, not hypothetical)

`run_dayahead()` had a hard gate: `load_solcast_snapshot(target_s)` → if `None` (or no
`forecast_kwh`, or prior failed, or wrong slot count), `return False/None` — **no forecast
generated.** The PHASE-4 redesign had made the Solcast snapshot the forecast *baseline itself*
(`baseline = solcast_mid_kwh`), so a missing snapshot for the target date meant no output at
all. Training has a parallel skip, so a prolonged outage also slowly starves the model.

Mitigating factors already present: snapshots are cached locally with freshness tiers (short
API outages tolerated); the physics model is Open-Meteo-driven (separate provider); actuals
resolve metered → inverter → est_actual (Solcast last). The gap was specifically the
**target-date "no usable snapshot"** case.

## The fix

Replaced the hard gate + baseline-assignment block (engine ~10658–10706) with a branch:

- **Solcast-primary path** (unchanged): usable snapshot → Solcast mid is the baseline;
  `solcast_meta` overridden to `used_solcast=True, mean_blend=1.0, primary_mode=True`.
- **Physics fallback path** (new): no usable snapshot → `baseline = physics_baseline()`,
  `blend_physics_with_solcast(physics, None)` (physics passthrough, `used_solcast=False`),
  then the existing ML residual + error-memory pipeline runs unchanged. The downstream
  `used_solcast == False` branch (already present + tested as `test_physics_only_path`) applies
  full-strength error memory and skips the Solcast floor.

Gate: `forecastAllowPhysicsFallback` (default **on**) via new `_setting_bool_or_default()`,
read fresh each cycle. OFF restores the legacy hard-fail. Snapshot validity is checked in
tiers; any failure routes to fallback with a `log.warning`, not a crash.

## Safety / correctness

- **Zero behavior change on the happy path:** when a usable snapshot exists, the
  Solcast-primary branch is equivalent to the prior logic (same baseline, same meta override).
  Verified: physics baseline computed exactly once, shared by both branches; exactly one
  `return False if persist else None` remains in the function (the fallback-disabled branch).
- **None-safety confirmed** for the fallback's `solcast_prior=None`: `build_features()` guards
  with `bool(solcast_prior and ...)` (→ zero-spread tri-band); `confidence_bands()` guards with
  `if solcast_prior is not None:`. Downstream `solcast_snapshot.get(...)` reads sit inside
  `if used_solcast` / `if solcast_snapshot` guards.
- No DB schema change. **No dead-residual change was made** — the audit's feared
  `slot_cap_mw_arr` does not exist in the file; the residual clip already uses `slot_cap_kwh()`
  (test `test_no_dead_residual_var` locks this).

## Verification

- `ast.parse` clean; hard-assertion validator on disk: exactly one residual `return`, blend-None
  once, bool-helper once, primary_mode once, dead-var zero, old hard-fail string gone,
  physics-baseline computed once.
- `TestPhysicsFallback` (9 cases): bool-helper unset/true-false/garbage parsing, physics
  passthrough, variant classification, branch wiring (source-locked), primary-path contract,
  no-dead-var. **9 passed.**
- **Full suite: 540 passed, 0 failed, 0 errors, EXIT 0** (was 531 → +9).

> Tooling note: this session's tool *display* channel intermittently doubled lines and injected
> phantom text into Read/Bash output. All edits were verified against on-disk truth via
> `ast.parse` + `repr()` line dumps + substring-count assertions in Python (exit-code gated),
> never the rendered text. One migration attempt aborted on a deliberate assert (gate had 5
> returns, not the assumed 4) and left the file untouched — re-run after correction succeeded.

## Operator handoff

- Resilience is **on by default** — no action needed. The engine self-heals to physics when
  Solcast is unavailable for a target date.
- To audit it: look for `forecast_variant='ml_without_solcast'` rows / `PHYSICS FALLBACK` log
  lines; these mean the fallback engaged.
- Before trusting degraded output, backtest the physics-only path on the gateway
  (`--train` then `--backtest-days 30`; optionally force a no-snapshot dry run).
- To disable (restore hard-fail): set `forecastAllowPhysicsFallback=0` in the settings table.

## Follow-up offered (not done)

- Expose `forecastAllowPhysicsFallback` in the server `/api/settings` allowlist + a UI toggle
  (currently Python-read default-on; settable via DB). Low value since the default is the
  desired behavior, but available on request.

---

## Post-merge adversarial review (2026-05-30) — 3 real defects found + fixed

A 6-dimension adversarial workflow re-reviewed the first cut. It mixed real findings with
several hallucinated details (claimed "0–100" validation range — actually 0.50–1.00/0.00–1.00;
"70 feature cols" — actually 72; stale "432 Python" test count). Each claim was verified against
the on-disk code before acting. Three were CONFIRMED real and fixed:

1. **CRITICAL — AttributeError crash on the fallback non-persist path.**
   `run_dayahead(persist=False)` builds a return dict at (then) lines 11255-11256 calling
   `solcast_snapshot.get(...)` **unguarded**. On the physics-fallback path `solcast_snapshot`
   is `None` → `None.get()` crashes. This path is hit by Node's `/api/forecast/engine-health`
   and Python CLI state queries. **Fix:** `... if solcast_snapshot else None` (mirrors the
   already-correct persist-path audit writer). The happy path was unaffected, which is why the
   original suite (no non-persist fallback test) stayed green — that gap is now closed.

2. **MAJOR — provenance flag hardcoded.** `baseline_is_solcast_mid: True` (return dict) and the
   literal `1` (DB insert in `_write_forecast_run_audit_from_python`) mislabel the baseline as
   Solcast even on physics fallback. **Fix:** both now `bool(solcast_meta.get("used_solcast"))`
   / `1 if ... else 0`, so audit rows correctly show `0` on fallback days.

3. **CRITICAL — tunables dropped on UI refresh.** `forecastEstActualWeight` /
   `forecastIntradayBlendMax` were in DEFAULT_SETTINGS + POST validation but **missing from
   `buildSettingsSnapshot()`** (what `GET /api/settings` returns), so saved values vanished on
   reload. **Fix:** added both to `buildSettingsSnapshot()` returning the stored number or
   `null` when blank (resolves the blank-vs-null default concern too); `app.js` `?? ""` renders
   null as an empty input → engine default.

**Regression tests added** (`test_forecast_engine_error_classifier.py`):
- `test_run_dayahead_physics_fallback_when_no_solcast` — drives `run_dayahead(persist=False)`
  with `load_solcast_snapshot → None`; asserts no crash, `used_solcast=False`,
  `baseline_is_solcast_mid=False`, `solcast_lo/hi_total_kwh=None`, variant `ml_without_solcast`,
  and a real physics forecast. **Would have failed (AttributeError) on the pre-fix code.**
- `test_run_dayahead_hard_fail_when_fallback_disabled` — `forecastAllowPhysicsFallback=off` +
  no snapshot → returns `None` (legacy hard-fail), not a crash.

Full suite after fixes: **542 passed, 0 failed, EXIT 0** (was 540 → +2).
