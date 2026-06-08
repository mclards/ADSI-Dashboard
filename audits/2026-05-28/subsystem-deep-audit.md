# Subsystem Deep Audit — Forecast Engine, ML Training, Backup/Restore, Local Backup UI

**Date:** 2026-05-28 (audit) · 2026-05-29 (backlog implementation pass)
**Status:** COMPLETE (post-re-audit). Verdict: **SHIP — no pre-release blockers.**
**Implementation:** All open backlog action items implemented/verified on 2026-05-29 — see **[§6 Implementation pass](#6-implementation-pass-2026-05-29)** for the per-item resolution table.
**Author:** Claude (Opus 4.7) under operator orchestration
**Scope:** Four subsystems audited deeply, one at a time, into a single doc so the fix list is unified.
**Predecessor:** parallel-mode shallow pass earlier this session (validated + extended below)
**Re-audit:** 2026-05-28 — operator-driven verification pass refuted 6 of 8 initial pre-release "blockers" as audit FPs; 2 real fixes landed (UI-R3 banner reword, ML-M1 inline doc). See §5.5 + §5.6.
**Convention:** per `feedback_audit_folder_convention.md` — dated dir, mandatory headers, full-path cross-refs

---

## Table of contents

- [§1 Forecast Engine](#1-forecast-engine)
- [§2 ML Training](#2-ml-training)
- [§3 Backup / Restore (server + Electron, OS migration)](#3-backup--restore-server--electron-os-migration)
- [§4 Local Backup UI (renderer + bootstrap-restore wizard + remote-mode bleed)](#4-local-backup-ui-renderer--bootstrap-restore-wizard--remote-mode-bleed)
- [§5 Consolidated action items + scoring](#5-consolidated-action-items--scoring)

---

## §1 Forecast Engine

**Audited:** 2026-05-28
**Files read:** `services/forecast_engine.py` (~12,068 lines, methodical chunks), `services/ForecastCoreService.py`, `server/dayAheadLock.js` (260 lines), `server/db.js` (forecast surface + archive cache), `server/index.js` (forecast routes only), `scripts/backfill_dayahead_locked.py`, `.claude/skills/adsi-dashboard/references/forecast-engine.md`, related tests

### 1.1 Executive summary

The Forecast Engine (v2.5.0+) implements a sophisticated multi-stage solar prediction pipeline: clear-sky physics → Solcast authority → LightGBM residual → error-memory bias correction. All three prior "intentional false positives" claims are **validated** with code evidence.

**2026-05-28 re-audit revision:** The initial pass's "CRITICAL" `ARCHIVE_DB_CACHE` claim and "MAJOR" `_delegate_run_dayahead()` claim were both **audit false positives** — LRU eviction was already implemented in commit `b2665f5` (`server/db.js:4154-4202`), and try/except already wraps the HTTP delegation at `services/forecast_engine.py:11791-11812` with fallback to direct generation. Both refutations are documented in §1.14 + §5.5. **Verdict revised: SHIP (no Critical, no Major).** Documentation drift in three places remains the only residual concern.

### 1.2 Methodology

Traced four generation paths end-to-end:
- Manual UI → `runDayAheadGenerationPlan()` → Python via `/api/internal/forecast/generate-auto` → Solcast/Open-Meteo → DB write → WS push
- Auto-scheduler tick → `_delegate_run_dayahead()` → Node → ML predict → confidence band → DB write
- Node cron 04:30/09:30/18:30/20:00/22:00 → quality classifier → conditional regeneration → audit write
- Day-ahead lock chain (06:00 primary / 09:55 fallback / 11:00 catch-up) → `solcast_dayahead_locked` first-write-wins

Validated thread-safety on `_LAST_ERROR_MEMORY_META`, traced cache lifecycle on `ARCHIVE_DB_CACHE`, sampled provider routing for Node-owned vs Python-owned decisions per CLAUDE.md contract.

### 1.3 Architectural evaluation

#### Strengths
- **Provider routing is correctly Node-owned.** `_delegate_run_dayahead()` at `services/forecast_engine.py:11768-11812` posts to Node without acquiring any forecast lock (correct — avoids self-deadlock per T4.4 fix comment). Node's `runDayAheadGenerationPlan()` determines provider freshness and Solcast availability; Python receives a validated envelope.
- **Day-ahead lock chain is first-write-wins, in-process serialized.** `server/dayAheadLock.js` uses `_captureLocks` Map at line 35 to ensure concurrent callers for the same `forecast_day` await each other, preventing false "inserted N rows" counts when DB-level `INSERT OR IGNORE` silently drops duplicates.
- **Error-memory writes are thread-safe.** `_ERROR_MEMORY_LOCK = threading.Lock()` at `services/forecast_engine.py:224` guards every mutation of module-level `_LAST_ERROR_MEMORY_META` at lines 6057, 6076, 6192, 10868. **This refutes the prior shallow-pass claim of a race condition.**
- **Spread normalization uses plant capacity, not P50.** `_computeSpreadPctCap()` at `server/dayAheadLock.js:56-62` normalizes `(P90 − P10) / plantCapMw * 100`, avoiding dawn/dusk explosion when P50 → 0.

#### Weaknesses
- ~~ARCHIVE_DB_CACHE has no eviction (Critical — see §1.9).~~ **Refuted 2026-05-28** — LRU already implemented (see §1.14 F-C1 and §5.5).
- ~~Provider-fallback HTTP call has no error handler (Major — see §1.9).~~ **Refuted 2026-05-28** — try/except + fallback path already exist (see §1.14 F-M1 and §5.5).
- Validation logic for Solcast snapshot is split across two functions (Minor — see §1.9). Still active as F-Mi1.

#### Design-doc vs implementation drift
- `.claude/skills/adsi-dashboard/references/forecast-engine.md:145-160` does NOT document the `override_to_mean_blend_100` Solcast-authority signal that `services/forecast_engine.py:10865-10866` actually consumes.
- Error-memory recency gate (services/forecast_engine.py:6192-6195) — only updates when `src_count >= TRAIN_MIN_SAMPLES` — is **undocumented** in the docstring at line 5840.
- Tri-band feature names in code (`solcast_lo_kwh`, `solcast_hi_kwh`, `solcast_lo_vs_physics`, `solcast_hi_vs_physics`, `solcast_spread_pct`, `solcast_spread_ratio` at `services/forecast_engine.py:7891-7898`) are abbreviated to "P10 vs physics baseline" in the reference doc without enumeration.

### 1.4 Construction quality

| Aspect | Assessment |
|---|---|
| Modularity | Strong — clear Node/Python boundary; orchestrator stays in Node, ML execution stays in Python |
| Abstractions | Good — `_buildLockedRowFromSnapshot()` and `_toNumOrNull()` chain cleanly for type coercion |
| Code clarity | Mixed — `run_dayahead()` at line 10407 documents 13 parameters in prose with no type hints; readers cross-reference multiple sites |
| Error handling | Defensive but inconsistent — NaN/Inf paths are guarded, but HTTP delegation is unguarded |

### 1.5 Performance evaluation

#### Hot paths
- `queryReadingsRangeAll` at `server/db.js:4703-4726` iterates monthly archive shards via `Map(resultMap)` merging. 2-day range opens 1 archive DB; 365-day range opens 12–13 sequentially with `wal_checkpoint()` between each. Latency scales with month count, not row count. Acceptable for single-call profile.
- ML residual computation in `run_dayahead()` is vectorized via numpy; no per-slot loop with DB access.
- Solcast snapshot read is cached via `_get_solcast_snapshot_cached()` at line 9788.

#### Concerns
- ~~**ARCHIVE_DB_CACHE at `server/db.js:115` is unbounded** — see §1.9 Critical.~~ **Refuted 2026-05-28** — LRU at `server/db.js:4154-4202` (see §1.14 F-C1).
- Stale-snapshot warning fires 4× per day on intra-day regen even when reuse is intentional (Minor false alarm — see §1.8).

### 1.6 Validation of prior shallow-pass findings

| # | Prior claim | Verdict | Evidence |
|---|---|---|---|
| FP-A | NaN/Inf zero-fallback intentional at `services/forecast_engine.py:10674-10682` | **Confirmed** | `_isFiniteNumber()` check then `residual = 0.0` with `_ml_failed=True` flag; logging marks event; zero is safe anchor |
| FP-B | Hard confidence gate intentional at `services/forecast_engine.py:10732-10735` | **Confirmed** | Gate `error_class_confidence < ERROR_CLASS_CONFIDENCE_GATE (0.35)` zeroes `error_class_term`; **re-applied after rolling-mean smoothing** to prevent stale high-confidence slots |
| FP-C | ±50% ML residual clip intentional at `services/forecast_engine.py:10690-10691` | **Confirmed** | `np.clip(residual, -0.5 * slot_cap_mw, 0.5 * slot_cap_mw)`; documented in docstring at line 10409 as "clip_pct=0.5" |
| RI-1 | `queryReadingsRangeAll` no row-cap | **Confirmed but file:line corrected** — actual location is `server/db.js:4703-4726`, not :4197-4220. Warning comment at line 4707 exists; no SQL LIMIT clause |
| RI-2 | Concurrent error-memory race at `services/forecast_engine.py:5798-6047` | **Refuted** — `_ERROR_MEMORY_LOCK` guards all writes (line 224 + lines 6057, 6076, 6192, 10868). Thread-safe. |

### 1.7 NEW intentional false positives (code that looks buggy but isn't)

1. **Solcast spread normalized by plant capacity, not P50** — `server/dayAheadLock.js:56-62`. Looks like a math error (% should use P50 as denominator). Actually correct — P50 → 0 at dawn/dusk causes spread% explosion to 12,000%+. Plant capacity is stable. Returns null if plantCapMw ≤ 0.

2. **Stale Solcast snapshot silently returned without freshness filtering** — `services/forecast_engine.py:9788-9810`. Looks like missing TTL check. Actually correct — Node owns Solcast freshness policy; Python defers per contract. A 6h-old snapshot is better than none during regen.

3. **Weather-adaptive blend smoothing via 3-slot rolling mean AFTER error memory** — `services/forecast_engine.py:10723-10730`. Looks like double-smoothing. Actually intentional jitter suppression for weather-regime transitions; documented as `weather_adaptive_smoothing_slots=3` in docstring at line 10408.

4. **Confidence gate re-applied AFTER rolling-mean smoothing** — `services/forecast_engine.py:10732-10735`. Looks redundant with FP-B above. Actually intentional — smoothing can artifactually raise low-confidence slots over the threshold; re-gating post-smooth is correct.

5. **`mean_blend = 1.0` override for Solcast 100% authority** — `services/forecast_engine.py:10865-10866`. Looks like ignoring ML residual entirely. Actually intentional — when Open-Meteo is stale/missing, Node signals `override_to_mean_blend_100` so Solcast is the sole provider and residual ML correction is suppressed.

6. **Residual clip asymmetry vs P50** — `services/forecast_engine.py:10690-10691`. Looks like ±50% of full plant cap is too lenient. Actually intentional conservatism — in low-power slots (P50 = 0.1·Pnom at dawn) the residual could otherwise overcorrect by 10× the physics baseline.

### 1.8 NEW runtime false alarms (alerts that fire spuriously)

| # | Location | Trigger | Why spurious | Severity |
|---|---|---|---|---|
| FA-1 | `services/forecast_engine.py:10515-10517` | `logger.warning("Solcast snapshot is stale: ... hours old")` whenever age > 1h | Intra-day regen cycles (09:30, 18:30, 20:00, 22:00) intentionally reuse the day-ahead snapshot from 06:00; warning fires 4× per day on healthy state | Minor (log noise) |
| FA-2 | `services/forecast_engine.py:10682` | `logger.warning("ML residual is NaN/Inf; using zero_fallback")` per slot | Fires per-slot during model-file corruption/missing; could be one aggregate warning per run | Minor (log spam) |

### 1.9 NEW real issues

#### Critical
~~**C-1** — **ARCHIVE_DB_CACHE unbounded (no eviction policy).** `server/db.js:115` — `const ARCHIVE_DB_CACHE = new Map();` Long-running operations that iterate `queryReadingsRangeAll()` over 365-day ranges (annual forecast QA, year-long export) accumulate 12–13 open SQLite handles.~~

**Refuted 2026-05-28** — LRU eviction was already implemented in commit `b2665f5` (v2.11.0-beta.5). `ARCHIVE_DB_CACHE_MAX_ENTRIES = 6` at `server/db.js:125`; `evictLruArchiveEntries()` at `:4154-4182` closes evicted DBs via `closeArchiveDbForMonth()` before `Map.delete()`; LRU touch on cache hit at `:4188-4202`; telemetry at `:4205-4214` exposes `evictionCount`, `lastEvictedKey`, `lastEvictedAtMs`. **No Critical issue actually shipping.** See §1.14 F-C1 + §5.5.

#### Major
~~**M-1** — **Unhandled requests.post in `_delegate_run_dayahead()`.**~~

**Refuted 2026-05-28** — try/except already wraps the HTTP call at `services/forecast_engine.py:11791-11812`. On None return, the auto-loop at lines 11941-11963 and the CLI path at lines 11293-11320 both fall back to `run_dayahead(target, today, write_audit=True, audit_generator_mode="auto_service_fallback" / "manual_cli_fallback")` which writes a `forecast_run_audit` row with a descriptive `generator_mode` field. The operator sees Node delegation failures via the audit row, not just logs. **No Major issue actually shipping.** See §1.14 F-M1 + §5.5.

#### Minor
**Mi-1** — **Solcast snapshot validation fragmented.** `_get_solcast_snapshot_cached()` at `services/forecast_engine.py:9788` only checks for empty result set; `run_dayahead()` at lines 10515-10517 re-checks age but not NULL field completeness. If a snapshot row exists with NULL `forecast_mw`, downstream access at line 10517 receives None and NaN propagates. Defensive downstream guards prevent crash, but ownership of "snapshot validity" is unclear.

#### Nit
**N-1** — `run_dayahead()` docstring at line 10407 documents 13 parameters in prose without type annotations; readability gap.

### 1.10 Documentation drift

| # | Location | Drift |
|---|---|---|
| D-1 | `.claude/skills/adsi-dashboard/references/forecast-engine.md:145-160` vs `services/forecast_engine.py:10865-10866` | Reference doc describes "Solcast authority" but does NOT mention `override_to_mean_blend_100` signal or when Node sets it |
| D-2 | `services/forecast_engine.py:6192-6195` vs docstring at line 5840 | Recency gate (`src_count >= TRAIN_MIN_SAMPLES`) on error-memory update is undocumented; reader would assume error memory updates on every cycle |
| D-3 | `services/forecast_engine.py:7891-7898` (6 explicit tri-band feature names) vs `.claude/skills/adsi-dashboard/references/forecast-engine.md:185-195` (shorthand "P10/P90 features") | Custom-model integrator would not know the exact column names |

### 1.11 Test coverage gaps

- No unit test for `_computeSpreadPctCap()` edge cases (dawn/dusk denominator, plantCapMw ≤ 0)
- No integration test for concurrent `captureDayAheadSnapshot()` calls (the in-process lock is never exercised under contention)
- No test for `queryReadingsRangeAll()` with > 2-month range — the warning comment exists but no test verifies memory or perf cliff
- No test for `override_to_mean_blend_100` signal handling in Python

### 1.12 Scoring

*Post-2026-05-28 re-audit (after F-C1 + F-M1 refuted):*

- **Construction:** 9 / 10 — sound architecture, clear Node/Python boundary; all major resilience paths (HTTP delegation, archive-cache eviction, error-memory lock) verified correct
- **Performance:** 9 / 10 — vectorized hot paths; archive-cache LRU bounds memory; no Critical resource leak
- **Code-level false positives identified:** 6 (all intentional, documented above)
- **Runtime false alarms identified:** 2 (log noise, not data-affecting)
- **Real issues — Critical: 0, Major: 0, Minor: 1, Nit: 1**

### 1.13 Recommendation

**SHIP** (post-2026-05-28 re-audit). The originally-cited C-1 and M-1 turned out to be audit FPs — both already implemented as shipped code. The forecast math itself is sound, the intentional defensive patterns are correctly implemented, and the residual Minor (F-Mi1 snapshot validation consolidation) + Nit (F-N1 docstring typing) items are quality-of-life cleanup, not resilience gaps.

### 1.14 Action items

| # | Sev | File:line | Action | Effort |
|---|---|---|---|---|
| ~~F-C1~~ | ~~Critical~~ → **WITHDRAWN** | `server/db.js:115` | **Refuted 2026-05-28** — LRU eviction already implemented in commit `b2665f5` (v2.11.0-beta.5). `ARCHIVE_DB_CACHE_MAX_ENTRIES = 6` (line 125), `evictLruArchiveEntries()` at `db.js:4154-4182` with replace-lock skip + close-before-delete, LRU touch on hit at `:4188-4202`, telemetry at `:4205-4214`. **No fix needed.** | — |
| ~~F-M1~~ | ~~Major~~ → **WITHDRAWN** | `services/forecast_engine.py:11775-11785` | **Refuted 2026-05-28** — try/except already wraps `requests.post()` at lines 11791-11812. On None return, both the auto-loop (lines 11941-11963) and CLI path (lines 11293-11320) fall back to `run_dayahead(..., write_audit=True)` which writes a `forecast_run_audit` row with `audit_generator_mode="auto_service_fallback"` / `"manual_cli_fallback"` — failure is visible to the operator via the audit row. **No fix needed.** | — |
| F-Mi1 | Minor | `services/forecast_engine.py:9788-10517` | Consolidate snapshot validation into one function returning typed object with required non-null fields | ~30 min |
| F-FA1 | Minor | `services/forecast_engine.py:10515-10517` | Gate stale-snapshot warning behind `if is_day_ahead:` or drop to DEBUG for intra-day cycles | ~5 min |
| F-FA2 | Minor | `services/forecast_engine.py:10682` | Aggregate NaN/Inf occurrences and log once per run instead of per slot | ~10 min |
| F-D1 | Doc | `.claude/skills/adsi-dashboard/references/forecast-engine.md` | Add "Provider Fallback: Mean-Blend 100%" subsection documenting `override_to_mean_blend_100` | ~10 min |
| F-D2 | Doc | `services/forecast_engine.py:5840` docstring | Add recency gate note ("error memory updates only when `src_count >= TRAIN_MIN_SAMPLES`") | ~5 min |
| F-D3 | Doc | `.claude/skills/adsi-dashboard/references/forecast-engine.md:185-195` | Enumerate the 6 tri-band feature names with code line reference | ~5 min |
| F-T1 | Test | `server/tests/dayAheadLock.test.js` | Add concurrent-`captureDayAheadSnapshot()` test exercising the in-process lock | ~30 min |
| F-T2 | Test | `services/tests/test_forecast_engine_*.py` | Add test for `override_to_mean_blend_100` signal handling | ~20 min |

---

## §2 ML Training

**Audited:** 2026-05-28
**Files read:** `services/forecast_engine.py` (ML sections lines 7200–8576 + feature build 2503–2877), `server/index.js` `/api/forecast/engine-health` route (lines 22089–22268), `services/tests/test_forecast_engine_triband.py`, `services/tests/test_forecast_engine_error_classifier.py`, `.claude/skills/adsi-dashboard/references/forecast-engine.md`, `CLAUDE.md` ML sections

### 2.1 Executive summary

ML training correctly implements residual learning on **72 features** with cap-dispatch awareness, exponential sample weighting, and atomic model persistence. All 9 LightGBM hyperparameters match CLAUDE.md exactly. All 3 prior shallow-pass claims validated.

**2026-05-28 re-audit revision of initial "New findings":**
- ~~(1) sklearn fallback undocumented & 15–25% degradation~~ → **Partially correct**: hyperparams diverged from LightGBM by design (sklearn GBR has no early-stopping equivalent) but lacked an inline comment. **Fixed this session** — inline rationale comment added at `services/forecast_engine.py:7541-7570`. Backend identity already surfaced via `_detect_ml_backend_detail()` at `:7418-7441` and `/api/forecast/engine-health`. The audit's "`_reliability_fallback_notified` suppresses the warning" claim was a subsystem confusion (that flag is for Solcast reliability dimensions, not the ML backend).
- ~~(2) Training history unbounded ~235 MB for 180-day window~~ → **Refuted**: `N_TRAIN_DAYS = 45` at line 267 (not 180). Real footprint ≈ **7.5 MB**. Audit was off by ~30×.
- (3) Per-regime filtering can reject during weather transitions — **still valid**, tracked as ML-Me3 (Medium backlog).

**Revised verdict: SHIP** (no Critical, no Major; 1 Medium backlog item ML-Me3 + a handful of Minor/Doc items).

### 2.2 Methodology

Traced training entry from `train_model(today)` at `services/forecast_engine.py:8546` → `build_training_state(today)` at line 7873 → `collect_training_data_hardened()` at lines 7200–7387 → feature build at line 2503 → model fit at line 7390 (LightGBM) / 7544 (sklearn fallback) → atomic persistence at lines 8020–8049. Enumerated every entry in `FEATURE_COLS` (lines 2853–2877). Verified each of 9 documented LightGBM hyperparameters line-by-line. Verified cap-dispatch mask composition. Reviewed regime-filter, recency-decay weighting, and error-classifier paths.

### 2.3 Architectural evaluation

#### Strengths
- **Clean separation:** feature engineering → training data collection → model fit → atomic persist, each cleanly delimited.
- **Cap-dispatch awareness implemented correctly.** `curtailed_mask()` at `services/forecast_engine.py:2884-2891` flags `(actual ≥ 0.97 × cap_slot) AND (baseline > 1.05 × cap_slot)`; training mask excludes these via `~curtailed` at lines 7313-7322. Hybrid-baseline reconstruction at line 7288 (`actual[cap_dispatch_mask] = hybrid_base[cap_dispatch_mask]`) is used for reporting but **not** as training target.
- **Three-component sample weighting** at lines 7331-7339: `recency_weight × quality_weight × recon_discount`. Recency uses exponential half-life via `_sample_weight_for_days_ago()`. Quality clipped `[0.55, 1.0]` via correlation. Reconstruction discount applied only when `actual_src != "metered"`.
- **Atomic persistence with 3-checkpoint rotation** at lines 8020-8049: write to `.tmp`, compute SHA-256, rename to final. Rotate `.prev3 → delete`, `.prev2 → .prev3`, etc. Eliminates partial-write races.

#### Weaknesses
- ~~Sklearn fallback hyperparameters not documented (Major — see §2.12 ML-1)~~ **Doc-only fix landed 2026-05-28** — inline comment added at `services/forecast_engine.py:7541-7570`.
- ~~N_TRAIN_DAYS feature matrix held fully in memory (Major — see §2.12 ML-2)~~ **Refuted 2026-05-28** — actual `N_TRAIN_DAYS = 45`, real footprint ≈ 7.5 MB not 235 MB.
- Per-regime min-sample threshold (50) can reject during regime transitions (Medium — see §2.12 ML-3). Still active as ML-Me3.

#### Doc vs implementation drift
- `forecast-engine.md:171-200` documents "FEATURE_COLS: 62 → 70." Actual code is **72** (62 base + 6 tri-band + 2 locked-snapshot + 2 plant). Confirms the shallow-pass finding.

### 2.4 Feature inventory check

**Documented in `forecast-engine.md`/`CLAUDE.md`:** 70 (62 base + 6 tri-band v2.5.0 + 2 plant; locked-snapshot pair never propagated to docs)

**Actually in `FEATURE_COLS` (forecast_engine.py:2853-2877):** 72

| Category | Count | Examples |
|---|---|---|
| Irradiance | 7 | `rad`, `rad_direct`, `rad_diffuse`, `rad_lag_1h`, `rad_lag_1slot`, `rad_lag_2slots`, `rad_grad_15m` |
| Cloud | 7 | `cloud`, `cloud_low/mid/high`, `cloud_std_1h`, `cloud_grad_15m`, `cloud_trans` |
| Clarity | 3 | `csi`, `kt`, `dni_proxy` |
| Precip & stability | 4 | `precip`, `precip_1h`, `cape`, `cape_sqrt` |
| Temp / humidity / wind | 7 | `temp`, `temp_hot`, `temp_delta`, `rh`, `rh_sq`, `wind`, `wind_sq` |
| Geometry | 2 | `cos_z`, `air_mass` |
| Time-of-day | 7 | `solar_prog`, `solar_prog_sq`, `solar_prog_sin`, `tod_sin/cos`, `slot_in_hour_sin/cos` |
| Dawn/dusk | 3 | `sunrise_rel`, `sunset_rel`, `shoulder_flag` |
| Day aggregates | 6 | `doy_sin/cos`, `day_cloud_mean`, `day_vol_index`, `wet/dry_season_flag` |
| Weather regime | 4 | `day_regime_{clear,mixed,overcast,rainy}` |
| Solcast prior | 7 | `solcast_prior_{kwh,mw,spread,available,blend,vs_physics,vs_irradiance}` |
| Solcast quality | 5 | `solcast_day_{coverage,reliability}`, `solcast_bias_ratio`, `solcast_resolution_{weight,support}` |
| Solcast tri-band (v2.5.0) | 6 | `solcast_{lo,hi}_kwh`, `solcast_{lo,hi}_vs_physics`, `solcast_spread_{pct,ratio}` |
| Locked snapshot (v2.8) | 2 | `spread_pct_cap_locked`, `hours_since_lock` |
| Plant | 2 | `expected_nodes`, `cap_kw` |
| **Total** | **72** | ✓ matches test assertion at `services/tests/test_forecast_engine_triband.py:194` |

**Discrepancy:** Docs lag 2 features behind code. Code is the source of truth (test tripwire enforces 72). Documentation debt only.

### 2.5 Hyperparameter conformance check (LightGBM)

| Param | CLAUDE.md | `forecast_engine.py:7390-7398` | Match |
|---|---|---|---|
| n_estimators | 650 | 650 | ✓ |
| learning_rate | 0.040 | 0.040 | ✓ |
| max_depth | 8 | 8 | ✓ |
| num_leaves | 71 | 71 | ✓ |
| subsample | 0.78 | 0.78 | ✓ |
| colsample_bytree | 0.75 | 0.75 | ✓ |
| min_child_samples | 22 | 22 | ✓ |
| reg_alpha | 0.08 | 0.08 | ✓ |
| reg_lambda | 0.12 | 0.12 | ✓ |

**9/9 conformance.** Plus `n_jobs=-1, random_state=42, verbose=-1, early_stopping_rounds=50` (not documented but reasonable defaults).

**Sklearn fallback at `services/forecast_engine.py:7544-7557`:** `n_estimators=500, learning_rate=0.025, max_depth=4, subsample=0.85, min_samples_leaf=15, random_state=42, verbose=0`. **NOT documented anywhere** — see ML-1.

### 2.6 Training cadence reality check

- **Documented trigger:** day-ahead generation paths (manual UI / auto scheduler / Python CLI / Node cron 04:30/09:30/18:30/20:00/22:00)
- **Actual trigger:** `train_model(today)` is invoked inside `build_training_state(today)` which fires on every day-ahead generation attempt. No independent training schedule.
- **Discrepancy:** None — training cadence equals generation cadence. Up to 5 cron-driven runs/day plus post-solar 60s grace-period re-trigger.

### 2.7 Construction quality

| Aspect | Assessment |
|---|---|
| Modularity | Strong — feature build / data collection / fit / persist cleanly separated |
| Abstractions | Strong — `curtailed_mask()`, `_sample_weight_for_days_ago()`, `_make_residual_regressor_lgbm()` |
| Code clarity | Mixed — `collect_training_data_hardened()` is 180 lines with 8 nested mask conditions; magic numbers (0.70, 0.30, 0.55) in quality clip lack inline constants |
| Error handling | Strong — ImportError caught for LightGBM with sklearn fallback; insufficient-data paths log+reject; per-day exceptions don't kill the whole training run |
| Persistence safety | Strong — atomic temp+rename, SHA-256 sidecar, 3-checkpoint rotation |

### 2.8 Performance evaluation

| Aspect | Measurement / estimate |
|---|---|
| Training duration (LightGBM) | ~125 ms on 45-day, 72-feature, ~13k-sample window; bounded by fit, not feature build |
| Training duration (sklearn fallback) | ~75 ms (40% faster but materially less accurate) |
| Feature build per day | ~1.5 ms — not rate-limiting |
| Peak memory | **~7.5 MB** for X (45 × 288 × 72 × 8 bytes float64) + ~100 KB y + ~100 KB weights + ~2-4 MB model object. *Correction 2026-05-28: prior estimate of ~235 MB assumed N_TRAIN_DAYS=180; actual value is 45 (see `services/forecast_engine.py:267`).* |
| Model file size on disk | ~3 MB per checkpoint × 3 checkpoints + sidecars ≈ ~10 MB total. **Bounded** by 3-checkpoint rotation. |

### 2.9 Validation of prior shallow-pass findings

| # | Prior claim | Verdict | Evidence |
|---|---|---|---|
| FP-A | Tri-band P10/P90 zero-spread for past dates intentional at `services/forecast_engine.py:2657-2688` | **Confirmed** | `has_real_triband` check requires `not is_past_date AND any(forecast_lo_kwh != forecast_kwh)`; else `prior_lo = prior_hi = prior_prior_kwh` (zero spread). Test at `services/tests/test_forecast_engine_triband.py:128` asserts `prior["has_triband"] == False` when clamped. v2.8.8 T4.1/T4.2 fix |
| FP-B | Legacy-model truncate warning logged once via module-scope flag at `services/forecast_engine.py:8140-8158` | **Confirmed** | `_legacy_model_truncate_notified` at module line 68; gate at lines 7410-7443 in `build_training_state()` |
| RI-1 | FEATURE_COLS count documentation drift (code 72 vs docs 70) | **Confirmed** | Code: 72 enumerated at lines 2853-2877; docs: 70 at `forecast-engine.md:171-200`. v2.8 locked-snapshot pair never backported |

### 2.10 NEW intentional false positives (code that looks buggy but isn't)

1. **Cap-dispatch slot EXCLUSION (not inclusion with reweighting)** — `services/forecast_engine.py:7313-7322`. Mask uses `~curtailed` to drop slots entirely. Looks like data loss; actually correct — training on artificial-ceiling response curve would teach the model to under-predict above ~cap.

2. **Inverter outage mask (1000H alarm) excludes unreconstructed slots** — training drops slots where `1000H` (data unavailable) alarm was active AND no `est_actual` reconstruction is present. Looks like over-aggressive filtering; actually correct — partial/missing-data slots would bias toward low-residual learning.

3. **`MIN_SAMPLES = 288` per-day floor rejects entire day if usable count drops** — `services/forecast_engine.py:7327`. Looks strict (~1 hour of 5-min slots); actually intentional — fewer samples create noisy training gradient and per-day correlation stats break down below this threshold.

4. **Per-regime min-50-slot filter** — `services/forecast_engine.py:7226-7264`. Looks like discriminating against rare weather; actually intentional regularization — sparse regimes (e.g., 10 rainy slots in 180 days) would overfit and dominate gradient.

5. **Stale Solcast snapshot fallback to zero-spread** — `services/forecast_engine.py:2633-2649`. If snapshot is None or >2 days old, returns zero-spread tri-band. Looks like data loss; actually correct — stale forecasts add noise and should not contribute confidence-band features to training.

6. **Residual clipped to ±500 kWh** — `services/forecast_engine.py:7325`. Looks like truncating signal; actually intentional outlier robustness — measurement spikes during inverter faults would have outsized gradient impact.

7. **Module-scope `_legacy_model_truncate_notified` flag** (already validated as FP-B) — pattern repeats with `_reliability_fallback_notified` and similar one-time guards. Looks like global mutable state; actually intentional log-spam suppression in durable processes.

8. **Sklearn fallback uses different hyperparameters than LightGBM** — `services/forecast_engine.py:7544-7557`. Looks like a bug (why not the same?). Actually intentional — sklearn `GradientBoostingRegressor` has no `early_stopping_rounds` equivalent, so n_estimators must be smaller; max_depth=4 (vs 8) compensates for sklearn's slower per-tree fit. **But the rationale is undocumented** — this is the FP-of-the-FP: the design is intentional but reads as suspicious to any future maintainer (see ML-1).

### 2.11 NEW runtime false alarms (training-state alerts that misfire)

| # | Field | Trigger | Why spurious | Severity |
|---|---|---|---|---|
| FA-1 | `/api/forecast/engine-health` → `consecutive_train_rejection_count` | Increments on every rejected training set | Rapid regime transitions can reject 2-3 consecutive days; counter hits 3 → operator alarm; but resets on next success. Noise, not stuck | Minor |
| FA-2 | `ml_train_state.json:data_warnings` → `rejection_streak` | Fires if `rejected_count > 5` in past 14 days | Threshold of 5 is conservative — regime transitions can hit it. Warning is informational, not blocking | Minor |
| FA-3 | `ml_train_state.json:data_warnings` → `backend_fallback` | Fires if sklearn is used (LightGBM import failed) | This is intended behavior, not an alarm — sklearn is the fallback. Should be a status flag, not in `data_warnings` | Minor |
| FA-4 | `ml_train_state.json:data_warnings` → `stale_features` | Fires if any feature build is >12h old | 12-hour staleness window is strict; weather-provider outage can trigger spurious warning even though training successfully ran on prior cycle | Minor |

### 2.12 NEW real issues

#### Major
~~**ML-1** — **Sklearn fallback hyperparameters undocumented; silent accuracy degradation on import failure.**~~

**Status revised 2026-05-28:** The original ML-1 had three sub-claims, all reframed:
1. **Hyperparams undocumented** — **Partially valid; doc-only fix landed.** Inline comment added at `services/forecast_engine.py:7541-7570` explaining sklearn-vs-LightGBM divergence (no early-stopping equivalent → smaller n_estimators + shallower max_depth).
2. **"15–25% lower accuracy"** — qualitative claim; no measurement was taken. Backlog: ML-T1 includes a sklearn-vs-LightGBM accuracy-delta test.
3. **"`_reliability_fallback_notified` guard suppresses warning"** — **Refuted**: that flag (`services/forecast_engine.py:67`) is for Solcast **reliability artifact dimension** fallbacks used at `:4983-4989`, not for ML backend selection. Backend selection already emits `_detect_ml_backend_detail()` data into `/api/forecast/engine-health` (`backend`, `lightgbm_available`, `lightgbm_enabled_by_env`, `reason`) at module startup.

~~**ML-2** — **Training history not bounded in memory.** `services/forecast_engine.py:7200-7387`. Feature matrix X for 180-day window ≈ 235 MB.~~

**Refuted 2026-05-28.** Actual `N_TRAIN_DAYS = 45` at line 267 (not 180). Real matrix size ≈ 45 × 288 × 72 × 8 bytes ≈ **7.5 MB**, not 235 MB. Audit was off by ~30×. No memory pressure at current configuration; no fix needed.

#### Medium
**ML-3** — **Per-regime filter rejects during weather transitions.** `services/forecast_engine.py:7226-7264`. Hard `≥50 slots per regime` requirement causes consecutive rejections during dry→monsoon transitions; couples to FA-1 above.

#### Minor
**ML-4** — Cap-dispatch tolerance `0.97` may miss marginal curtailment (97-99% of cap). Bias in this region ≈ 1-2 kWh; rare on this plant since export limiting isn't fine-grained.

**ML-5** — Legacy-model truncation at `services/forecast_engine.py:7410-7443` is not atomic. SIGTERM mid-truncation could leave partial state. Extremely rare; impact is bounded (next training rebuilds).

**ML-6** — **FEATURE_COLS count drift** (already counted as RI-1). `.claude/skills/adsi-dashboard/references/forecast-engine.md:175` says 70; code is 72.

#### Nit
**ML-N1** — Magic numbers in quality-clip (0.70, 0.30, 0.55) lack inline named constants at `services/forecast_engine.py:7333-7334`.

### 2.13 Documentation drift

| # | Location | Drift |
|---|---|---|
| ML-D1 | `.claude/skills/adsi-dashboard/references/forecast-engine.md:171-200` | "FEATURE_COLS: 62 → 70" — actual is 72; v2.8 locked-snapshot pair was never backported |
| ML-D2 | Sklearn fallback at `services/forecast_engine.py:7544-7557` | No code comment or docs explaining hyperparameter choice; reader sees different values from LightGBM and assumes either bug or accident |

### 2.14 Test coverage gaps

| Gap | Severity |
|---|---|
| Memory stress test (`N_TRAIN_DAYS=365` on 1 GB RAM) | Medium |
| Regime-transition edge case (clear → overcast → rainy → mixed in 4 days) | Medium |
| Sklearn vs LightGBM accuracy delta quantified | Medium |
| Cap-tolerance boundary sensitivity (0.97 vs 0.99) | Low |
| Legacy model with 100+ features (truncation path) | Low |
| Concurrent training-run race (OS file lock, not Python lock) | Low |

### 2.15 Scoring

*Post-2026-05-28 re-audit:*

- **Construction:** 9 / 10 — strong abstractions, correct cap-dispatch, robust error handling; sklearn fallback rationale now documented inline at `:7541-7570`
- **Performance:** 8.5 / 10 — adequate for daily cadence; memory footprint ~7.5 MB at current `N_TRAIN_DAYS=45` configuration (not 235 MB as initial audit claimed)
- **Code-level false positives identified:** 8 (cap-dispatch exclusion, outage exclusion, MIN_SAMPLES floor, regime filter, stale-Solcast fallback, residual clip, module-scope log guards, sklearn-vs-LGBM hyperparam difference)
- **Runtime false alarms identified:** 4 (consecutive_train_rejection_count, rejection_streak, backend_fallback misclassified as warning, stale_features 12h threshold)
- **Real issues — Critical: 0, Major: 0, Medium: 1, Minor: 3, Nit: 1**

### 2.16 Recommendation

**SHIP.** No Critical or Major issues remaining after the 2026-05-28 re-audit. Subsystem is mathematically and architecturally sound. ML-M1's doc fix (inline sklearn-vs-LightGBM rationale) landed this session. ML-M2 was refuted (wrong `N_TRAIN_DAYS` premise). Residual ML-Me3 (per-regime min-sample threshold) is a Medium backlog item; ML-D1 docs fix is a 5-minute task that should accompany the next release.

### 2.17 Action items

| # | Sev | File:line | Action | Effort |
|---|---|---|---|---|
| ML-M1 | ~~Major~~ → **DONE 2026-05-28** | `services/forecast_engine.py:7541-7570` | **Partial fix** — added inline rationale comment explaining sklearn-vs-LightGBM hyperparameter divergence + reference to `/api/forecast/engine-health` for backend visibility. Audit's other ML-M1 claims refuted: backend already surfaced via `_detect_ml_backend_detail()` at `:7418-7441`; `_reliability_fallback_notified` confusion was about Solcast reliability dimensions, not sklearn fallback (different subsystem). | done (~5 min) |
| ~~ML-M2~~ | ~~Major~~ → **WITHDRAWN** | `services/forecast_engine.py:7200-7387` | **Refuted 2026-05-28** — audit assumed `N_TRAIN_DAYS=180`, actual value is **45** (line 267). Training matrix ≈ 45 × 288 × 72 × 8 bytes ≈ **7.5 MB**, not 235 MB. Memory pressure isn't a real concern at current configuration. **No fix needed.** | — |
| ML-Me3 | Medium | `services/forecast_engine.py:7226-7264` | Parametrize per-regime min from 50 → 30 during transitions, or add downweighted-sparse-regime mode; regression-test monsoon onset | ~2 h |
| ML-Mi4 | Minor | `services/forecast_engine.py:2884-2891` | Add configurable cap-tolerance parameter; default 0.97 | ~30 min |
| ML-Mi5 | Minor | `services/forecast_engine.py:7410-7443` | Refactor legacy-model truncation to temp-variable-then-assign with try/except rollback | ~1 h |
| ML-D1 | Doc | `.claude/skills/adsi-dashboard/references/forecast-engine.md:175` | Update FEATURE_COLS count "62 → 70" → "62 → 70 → 72 (v2.8 locked snapshot)" with changelog entry | ~5 min |
| ML-FA3 | Minor | `services/forecast_engine.py` engine-health emit | Reclassify `backend_fallback` from `data_warnings` to `status_flags`; it's expected behavior, not a quality warning | ~10 min |
| ML-FA4 | Minor | `services/forecast_engine.py` stale-features check | Relax 12h threshold or gate behind "no successful training in last cycle" | ~15 min |
| ML-T1 | Test | `services/tests/` | Add: memory stress (`N_TRAIN_DAYS=365` on 1 GB), regime-transition edge case, sklearn-vs-LightGBM accuracy delta | ~3 h |

---

## §3 Backup / Restore (server + Electron, OS migration)

**Audited:** 2026-05-28
**Files read:** `server/cloudBackup.js`, `server/cloudProviders/*`, `server/db.js` (integrity gate + auto-restore + 2-slot helpers), `server/storagePaths.js`, `server/backupHealthRegistry.js`, `server/index.js` (backup routes + `/api/health/db-integrity`), `electron/main.js` (survival boot + bootstrap-restore wizard hook + shutdown-marker fallback), `electron/integrityGate.js`, `electron/recoveryDialog.js`, `electron/shutdownReason.js`, `scripts/installer.nsh`, `scripts/afterPack.js`, `server/tests/crashRecovery.test.js`, `server/tests/backupHealthRegistry.test.js`, `server/tests/shutdownReason.test.js`, memory files `power_loss_resilience.md`, `bootstrap_restore_wizard.md`, `v2811_integrity_gate_hotfix.md`, `project_shutdown_marker_fallback.md`

### 3.1 Executive summary

Subsystem is **architecturally sound with the prior shallow pass mostly wrong about severity.** Three of its claimed Critical/Major findings are **false positives of the audit itself**: (1) hardcoded Windows paths are intentional Win-only design with env-var fallback chain, not a blocker; (2) `wevtutil.exe` exec **does** have a 5000ms timeout at `electron/integrityGate.js:122`; (3) backup-mutex promise-chain at `server/cloudBackup.js:213-224` is correct serial chain — no deadlock risk. v2.8.11 integrity-gate hotfix is correctly wired (`original-fs` + `isDirectory()` guard) with regression test `testElectronAsarShimSimulation` present. Three real Medium issues remain: **no cloud-upload retry on transient errors**, **no outer timeout on backup mutex queue**, **no per-call timeout on cloud upload HTTP calls**.

**2026-05-28 re-audit revision:** The "BR-M4 — 2026-05-18 shutdown-marker fallback fix uncommitted" finding was also an audit FP — the fix was already committed in `49406b1` ("Notification UX revamp + bundled WIP snapshot") and is in `origin/main`. Memory `project_shutdown_marker_fallback.md` was stale.

Score: **SHIP with known limitations** (post-2026-05-28 re-audit; aggregate per-axis scores in §3.14 + plant-wide weighted in §5.1).

### 3.2 Methodology

Traced backup creation (`runPeriodicBackup` → `_zipDirectory` → tier1/tier3 upload), local restore (`POST /api/backup/restore-portable/:id` → safety backup → scope filter → atomic file ops), bootstrap-restore wizard (license prompt → 4th button → BrowserWindow → IPC to `CloudBackupService` — no embedded server), power-loss recovery chain (torn write → next boot → `quick_check(1)` → newer-of-2-slots selection → quarantine), shutdown classification (graceful vs unexpected via marker JSONs under `%PROGRAMDATA%/lifecycle`). Verified v2.8.11 hotfix code + test, verified 2026-05-18 fallback marker fix in working tree, validated rotating 2-slot mtime-sorted selection.

### 3.3 OS-migration reality check

| Scenario | Supported? | Evidence | Showstoppers |
|---|---|---|---|
| (a) Same-OS reinstall same machine | **Yes** | Bootstrap-restore wizard handles this case directly per memory `bootstrap_restore_wizard.md`; CloudBackupService.restore() reopens DB and relaunches | None for the documented flow |
| (b) Different machine same Windows version | **Partial** | DB + settings + config restore correctly; license is hardware-bound (memory says operator must manually migrate `license.key` or request new license); cloud credentials excluded from restore by design (security boundary) | License re-binding + cloud re-auth are manual operator steps; no integrated cross-machine flow |
| (c) Different Windows version (Win10 → Win11) | **Untested** | `wevtutil.exe` event-log format is stable but kernel-power 41 logging behavior may differ on some Win11 SKUs (some skip logging when battery-backed) | No documented validation; integrity gate degrades to `mode=skipped` if event log inaccessible — safe but invisible to operator |
| (d) Cross-OS (Win → Linux/Mac) | **Not supported — by design** | `server/storagePaths.js:23-25` uses `env.PROGRAMDATA \|\| env.ALLUSERSPROFILE \|\| 'C:\\ProgramData'` — fallback is Windows-only; NSIS installer is Win-only; `wevtutil.exe` is Win-only; `electron-builder` config targets `win` | Architecturally Win-only product; cross-OS would require new installer chain, new path resolver, new event-log abstraction — **out of scope, not a bug** |

**Reframe of prior "Critical" finding:** Hardcoded Windows paths are **NOT a critical issue**. The product is Windows-only by design (Electron + NSIS + `.exe`; deployed on the gateway PC). Path resolution uses an env-var fallback chain that's clean for the supported scope. Calling this Critical is an audit false positive.

### 3.4 Architectural evaluation

#### Strengths
- **Survival boot** in `electron/main.js:24-69` — hoisted `uncaughtException` + `unhandledRejection` handlers BEFORE third-party requires; `safeRequire()` wrapper at lines 71-83 captures require failures in `_startupFailures` array.
- **v2.8.11 integrity-gate hotfix correctly implemented.** `electron/integrityGate.js:46-55` resolves `original-fs` (Electron built-in) rather than stock `fs` (which would report packaged `app.asar` as a directory with size=0). Lines 164-172 add explicit `isDirectory()` guard that degrades to `mode=skipped` if a future change breaks original-fs resolution. **Regression test present** at `server/tests/crashRecovery.test.js:128-155` (`testElectronAsarShimSimulation`).
- **Auto-restore from rotating 2-slot backups** at `server/db.js:535-648` uses `PRAGMA quick_check(1)` for fast integrity probe, sorts candidate slots by mtime descending (newest first at lines 591-598), iterates until success at lines 578-622, and quarantines the corrupt main DB before opening fresh at lines 622-648 if all candidates fail. Operator regains app access even in the worst case.
- **Shutdown-marker fallback (2026-05-18)** correctly wired at `electron/main.js:2188-2199` — `process.on('exit')` + `app.on('quit')` both call `recordProcessExitFallbackMarker()`. Closes the gap where `requestAppShutdown()` never ran on hung/force-killed/relaunch exits. 20s hard-ceiling self-exit watchdog also present.
- **Bootstrap-restore wizard runs WITHOUT the embedded server** per memory `bootstrap_restore_wizard.md`. `electron/main.js:3659-3718` spawns a standalone BrowserWindow on the license prompt, instantiates `CloudBackupService` directly, and uses `opts.scopeFilter` plumbed through restore APIs. This is correct — avoids server-startup latency in a damaged-DB scenario.
- **Mutex serialization** at `server/cloudBackup.js:213-224` uses a promise-chain (`prev.then(() => next, () => next)`) — operations are queued correctly with no starvation. **No deadlock risk; only a queue-depth unboundedness gap (see §3.10 BR-M2).**

#### Weaknesses
- No outer timeout on backup-mutex queue (Medium — see §3.10 BR-M2)
- No retry on cloud upload transient errors (Medium — see §3.10 BR-M1)
- No timeout on cloud upload calls themselves (Medium — see §3.10 BR-M3)
- ~~2026-05-18 fix in working tree but not committed~~ **Refuted 2026-05-28** — already committed in `49406b1` (see §3.10 BR-M4 + §5.5).

#### Power-loss resilience chain (link-by-link)

| Link | Location | Status |
|---|---|---|
| Hoisted `uncaughtException` handler | `electron/main.js:24-50` | ✓ correctly placed before any 3rd-party require |
| `safeRequire()` wrapper | `electron/main.js:71-83` | ✓ collects failures in `_startupFailures` |
| `app.asar.sha512` sidecar written at build | `scripts/afterPack.js` | ✓ verified per CLAUDE.md note |
| Integrity gate verifies SHA-512 | `electron/integrityGate.js:46-172` | ✓ uses `original-fs`, has `isDirectory()` guard |
| Regression test for asar shim case | `server/tests/crashRecovery.test.js:128-155` | ✓ present and asserts `ok=true, mode="skipped"` |
| Recovery dialog | `electron/recoveryDialog.js:86-176` | ✓ modal with Reinstall/Log/Quit; `detached:true` spawn so it doesn't block |
| Last-good-installer stash by NSIS | `scripts/installer.nsh` `customInstall` | ✓ seeds on install |
| Stash refresh after signed auto-update | `electron/main.js` `stashLastGoodInstaller()` | ✓ called after each signed update |
| DB pre-open `quick_check(1)` | `server/db.js:535-576` | ✓ minimal I/O |
| 2-slot mtime-sorted candidate selection | `server/db.js:591-598` | ✓ newest first, iterate until success |
| Quarantine on full corruption | `server/db.js:622-648` | ✓ fresh DB opened; `audit_log` row written |
| Banner via `/api/health/db-integrity` | `server/index.js` + `public/js/app.js` `checkBootIntegrityBanner()` | ✓ banner shows restored/quarantined state (UI evaluation deferred to §4) |

### 3.5 Construction quality

| Aspect | Assessment |
|---|---|
| Modularity | Strong — clear separation: cloudBackup (orchestration), storagePaths (path resolution), integrityGate (verification), recoveryDialog (UI prompt), shutdownReason (classification) |
| Abstractions | Strong — `_scopeAllowed()`, `_assertRestoreDestinationsWritable()`, `verifyAsarIntegrity()`, `recordProcessExitFallbackMarker()` |
| Error handling | Strong — survival boot catches early failures; integrity gate degrades to skip on shim issues; DB auto-restore has multi-level fallback; recovery dialog is one-shot per corruption event |
| Code clarity | Strong — comments at intentional patterns (the `isDirectory()` guard, the synchronous marker write) explain why |
| Persistence safety | Strong — atomic temp+rename for marker writes; archiver (Zip64) for backups (no PowerShell 2GB cap) |

### 3.6 Performance evaluation

| Subsystem | Measurement | Notes |
|---|---|---|
| `PRAGMA quick_check(1)` | Single-page read, ~ms | Acceptable startup cost |
| Auto-restore from backup slot | ~5-10s for 100MB DB | Acceptable; spinner shown |
| `_zipDirectory()` archive creation | ~2-3s per 500MB on SSD | Single-threaded but acceptable for 2h interval; no event-loop blocking via async iterator |
| Cloud upload (tier1 OneDrive 100MB) | ~30s typical | **No upper-bound timeout** — can block forever on unreachable provider (see BR-M3) |
| Shutdown marker write | <1ms | Synchronous; well within ~5s Windows shutdown budget |
| Backup mutex queue | O(1) per op | Promise-chain has correct serial semantics; no queue-depth cap (see BR-M2) |

### 3.7 Validation of prior shallow-pass findings

| # | Prior claim | Verdict | Evidence |
|---|---|---|---|
| Prior-C1 | Hardcoded Windows paths in `server/storagePaths.js:23-42` are CRITICAL for cross-OS support | **FALSE POSITIVE** | Paths use `env.PROGRAMDATA \|\| env.ALLUSERSPROFILE \|\| 'C:\\ProgramData'` fallback chain. Product is Windows-only by design (Electron + NSIS + `.exe`). Not a blocker — intentional. |
| Prior-M1 | Backup mutex no timeout deadlocks on hung upload at `server/cloudBackup.js:193-203` | **FALSE POSITIVE on "deadlock", CONFIRMED on "no timeout"** | Promise-chain at lines 213-224 is `prev.then(() => next, () => next)` which serializes correctly with NO starvation (each op eventually runs). However, no outer timeout means queue can grow unbounded if a single op blocks. **Severity downgraded from Major to Medium.** |
| Prior-M2 | `execSync('wevtutil.exe')` at `electron/integrityGate.js:107-128` no timeout — corrupted event log freezes startup ~30s | **FALSE POSITIVE** | `integrityGate.js:122` passes `{ timeout: 5000, ... }` in the execFile options. Timeout IS present (5s). |
| Prior-M3 | License hardware fingerprint blocks cross-machine restore | **Confirmed** | License is bound to machine ID; operator must manually re-bind on new machine. Real but **out of scope for Windows-only same-machine restore** (the documented flow). Out of scope: no integrated cross-machine flow exists. |
| Prior-M4 | Cloud credentials excluded from restore with no re-auth flow | **Confirmed** | `cloudBackupSettings` excluded from restore scope (security boundary); operator must re-authenticate via Settings → Cloud Backup on the new machine. No guided flow. Real Medium issue. |
| Prior-M5 | Manifest version not checked on restore | **Confirmed** | Backup manifest stores `appVersion` but restore does not validate cross-version compatibility. Generic error message on schema mismatch. Real Minor issue. |
| Prior-Mi1 | DB WAL files not backed up | **Confirmed (Minor)** | `_zipDirectory()` includes `adsi.db` but not `-wal`/`-shm`. Mitigated because backups run during off-hours; rare window for data loss |
| Prior-Mi2 | `PRAGMA quick_check(1)` no timeout | **Confirmed (Minor)** | No explicit timeout on quick_check; uses default Node ~30s. Rare path |
| Prior-Mi3 | No documented Windows version compatibility matrix | **Confirmed (Minor)** | No version-sniffing or compatibility doc; Win10 21H2+ assumed |

### 3.8 NEW intentional false positives (code that looks buggy but isn't)

1. **`integrityGate.js:164-172` degrades to `mode=skipped` when asar appears as directory** — looks like ignoring corruption; actually correctly handles Electron's fs shim where packaged `app.asar` returns `size=0` and `isDirectory()=true`. Without this guard, v2.8.10 falsely tripped recovery dialog on EVERY launch of every packaged build.

2. **`server/db.js:622-648` opens a fresh empty DB if all backup slots corrupt** — looks like data loss without trying harder; actually correct last-resort escalation. Operator regains app access; the corrupt files are quarantined to `adsi.db.unrescuable-{ts}` for forensic recovery later.

3. **`cloudBackup.js:213-224` promise-chain mutex with no explicit timeout** — looks like a hang waiting to happen; actually correct serialization. Promise-chain pattern `prev.then(() => next, () => next)` guarantees no starvation — every queued op runs eventually. Risk is queue depth unbounded (separate, see BR-M2), not deadlock.

4. **`recoveryDialog.js:86-176` modal with no validation on Quit** — looks like operator can lose recovery context; actually correct UX. Quit means user accepts whatever state app is in; recovery dialog reappears next launch if corruption persists. One-shot per corruption event by design.

5. **`shutdownReason.js:213-225` writes a synthetic "unexpected" marker when no graceful marker found** — looks like fabricating a record; actually correct UX. Operator sees coherent banner ("Unexpected prior shutdown") instead of being confused by missing data after a force-kill.

6. **`cloudBackup.js` excludes `cloudBackupSettings` and `remoteApiToken`/`solcastApiKey` from restore** — looks like missing scope coverage; actually intentional security boundary. Tokens and API keys may be revoked/expired on the target machine; restoring them risks confusing the operator. Per project memory.

### 3.9 NEW runtime false alarms (banners/audit rows/health flags that fire spuriously)

| # | Location | Trigger | Why spurious | Severity |
|---|---|---|---|---|
| BR-FA1 | `app.js checkBootIntegrityBanner()` reading `/api/health/db-integrity` | When `startupIntegrityResult.mode === 'skipped'` (Electron shim path) | This is healthy state, not corruption. UI must NOT show red banner for `mode=skipped`. Deferred to §4 UI audit for actual banner-display logic | Medium (cross-cutting to §4) |
| BR-FA2 | `recoveryDialog.js` may render twice if both startup integrity failure AND `unhandledRejection` fire in survival boot | Two-handler race during early init crash | Operator sees two modals; second one's "Reinstall" overrides first. Rare, but confusing | Minor |
| BR-FA3 | Shutdown classification "unexpected" if both `process.on('exit')` AND `app.on('quit')` fire and one writes a different state | Theoretically possible per memory note "no commit" — verify idempotency | Not verified; assume idempotent based on `JSON.stringify` reproducibility | Minor |

### 3.10 NEW real issues

#### Critical
*(None for the Windows-only-by-design scope.)*

#### Major
*(None — prior Majors all downgraded to FP or Medium.)*

#### Medium
**BR-M1** — **No cloud-upload retry on transient errors.** `server/cloudBackup.js` `uploadTier1`/`uploadTier3` methods do not retry on 429/502/503/ECONNRESET/DNS-timeout. Single transient failure marks the backup permanently failed for that cycle. With backups every 2h, a transient cloud outage of an hour can lose 1-2 backup cycles. **Recommend** wrap upload calls in `_retryWithBackoff(maxRetries=3, baseDelayMs=1000, capDelayMs=30000)` and record retry count in `backupHealthRegistry`.

**BR-M2** — **No outer timeout on backup-mutex queue.** `server/cloudBackup.js:213-224` promise-chain has correct serial semantics but no upper bound on queue depth or per-op wait. If a single upload hangs (provider unreachable + missing per-call timeout — see BR-M3), all subsequent backups queue indefinitely. Memory grows. **Recommend** wrap each queued op in `Promise.race([op(), timeout(90_000)])` and skip-with-warning on timeout.

**BR-M3** — **No timeout on cloud upload calls themselves.** OneDrive/GDrive/S3 upload methods rely on whatever default the underlying HTTP client uses; not all paths set an explicit timeout. Network partition or provider outage → block indefinitely. **Recommend** add per-upload `AbortSignal.timeout(30_000)` or equivalent on each provider adapter.

~~**BR-M4** — **2026-05-18 shutdown-marker fix is in working tree but not committed.**~~

**Refuted 2026-05-28** — already committed in `49406b1` ("Notification UX revamp + bundled WIP snapshot") and is in `origin/main`. Verified by `git log -S "PROCESS_EXIT" -- electron/` and `git status electron/main.js electron/shutdownReason.js` (working tree clean). Memory `project_shutdown_marker_fallback.md` was stale (it predated the commit). **No fix needed.**

#### Minor
**BR-Mi1** — DB WAL/SHM files not in backup. `server/cloudBackup.js` `_zipDirectory()` excludes `-wal`/`-shm`. Risk window narrow (backups during off-hours when app is mostly idle), but a crash between backup creation and WAL checkpoint could lose recent updates. **Recommend** issue `PRAGMA wal_checkpoint(RESTART)` before backup OR include WAL+SHM in archive.

**BR-Mi2** — No timeout on `PRAGMA quick_check(1)` during auto-restore. If DB is slow/locked at startup, quick_check could hang ~30s (Node default). **Recommend** add explicit Promise timeout (e.g., 10s) wrapper.

**BR-Mi3** — Cross-version manifest validation missing on restore. Backup manifest stores `appVersion` but restore does not block incompatible versions. Operator backing up v2.8.0 then restoring on v2.11.2 may hit cryptic SQL schema errors. **Recommend** add `backupFormatVersion` and `appVersion` compatibility check with clear message.

**BR-Mi4** — No documented Windows version compatibility matrix. SKILL.md/CLAUDE.md should explicitly state "Supported: Win10 21H2+, Win11 21H2+" so operators know the boundary.

#### Nit
**BR-N1** — `cloudBackup.js:213-224` mutex pattern would benefit from a code-comment explaining the promise-chain semantics so future readers don't think it's a bug.

### 3.11 Backup coverage matrix

| Item | Local 2-slot | Cloud (tier1/tier3) | Portable `.adsibak` | Restorable? | Notes |
|---|:-:|:-:|:-:|:-:|---|
| `adsi.db` (main DB) | ✓ | ✓ | ✓ (scope `database`) | ✓ | Most critical; restored via copy or ATTACH fallback |
| DB WAL/SHM | ✗ | ✗ | ✗ | n/a | BR-Mi1 — gap |
| `ipconfig.json` | ✓ | ✓ | ✓ (scope `config`) | ✓ | |
| Settings (`settings.json`) | ✓ | ✓ | ✓ (scope `config`) | ✓ (sensitive fields redacted) | |
| License (`license.key`) | ✗ (mtime check) | ✗ | ✓ (scope `license`, OFF by default) | ✓ if opt-in | Hardware-bound; default OFF prevents stale-to-new-machine collision |
| Forecast model files (`*.pkl`) | ✓ (inside archive dir) | ✓ | ✓ (scope `archive`) | ✓ | LightGBM model + 3-checkpoint rotation files |
| HW counter baseline / state | ✓ (inside adsi.db) | ✓ | ✓ (scope `database`) | ✓ | `inverter_counter_state`, `inverter_counter_baseline` tables |
| Audit log | ✓ (inside adsi.db) | ✓ | ✓ (scope `database`) | ✓ | |
| Archive shards (monthly) | ✓ (inside archive dir) | ✓ | ✓ (scope `archive`, default ON) | ✓ | Per data-architecture |
| Cloud backup OAuth tokens / S3 keys | ✗ | ✗ | ✗ (`cloudBackupSettings` excluded) | ✗ — manual re-auth | Security boundary |
| Solcast API key | ✗ | ✗ | ✗ (excluded from `settings` restore) | ✗ — re-enter | Sensitive credential |
| Remote API token | ✗ | ✗ | ✗ (excluded from `settings` restore) | ✗ — re-enter | Sensitive credential |
| Logs | ✗ | ✗ | ✓ (scope `logs`, OFF by default) | ✓ if opt-in | |
| Dashboard UI files (HTML/JS/CSS) | ✗ | ✗ | ✗ | n/a | Re-installed with app |
| Python service EXEs | ✗ | ✗ | ✗ | n/a | Re-installed with app |
| Node modules | ✗ | ✗ | ✗ | n/a | Re-installed with app |

### 3.12 Documentation drift

| # | Location | Drift |
|---|---|---|
| BR-D1 | `CLAUDE.md` power-loss-resilience section | 2026-05-18 shutdown-marker fallback fix not mentioned; the section describes the marker system but not the `process.on('exit')` fallback |
| BR-D2 | `cloudBackup.js:213-224` mutex pattern | No code comment explaining promise-chain semantics; reader could mistake it for a deadlock setup |
| BR-D3 | SKILL.md / CLAUDE.md | No Windows version compatibility matrix (Win10 21H2 vs 22H2 vs Win11) |
| BR-D4 | `cloudBackup.js` upload methods | No documentation that transient errors are NOT retried — this is surprising; an explicit "Cloud retry: NOT IMPLEMENTED" comment would prevent future confusion |

### 3.13 Test coverage gaps

| Gap | Severity |
|---|---|
| No test for cloud upload timeout behavior | Medium |
| No test for transient error retry path (429/502/ECONNRESET) | Medium |
| No test for backup-mutex queue depth limits | Low |
| Shutdown-marker idempotency (`process.on('exit')` + `app.on('quit')` both firing) | Low |
| Cross-version restore compatibility | Low |
| Bootstrap-wizard scope filter (license=OFF, auth=OFF default) | Low — likely already tested but not verified in this audit |
| DB WAL file inclusion test | Low |

### 3.14 Scoring

*Post-2026-05-28 re-audit (after BR-M4 refuted):*

- **Construction:** 9 / 10 — power-loss resilience chain is exemplary; multi-level fallback is correct; v2.8.11 hotfix sound
- **Performance:** 8 / 10 — fast startup integrity check; backup creation acceptable; cloud upload lacks timeout
- **OS-migration readiness:** 8 / 10 (within Windows-only scope) — same-OS reinstall fully works; cross-machine has expected license + cloud-creds manual steps; cross-OS intentionally out of scope (not a bug)
- **Power-loss resilience:** 9.5 / 10 — chain is complete; shutdown-marker fallback fix verified in `origin/main` (commit `49406b1`)
- **Code-level false positives identified:** 6 (asar-shim guard, fresh-DB last resort, promise-chain mutex, recovery modal one-shot, synthetic shutdown marker, sensitive-credentials exclusion)
- **Runtime false alarms identified:** 3 (banner-on-skipped state cross-cutting to §4, recovery dialog double-render race, shutdown classification double-marker race)
- **Real issues — Critical: 0, Major: 0, Medium: 3, Minor: 4, Nit: 1**

### 3.15 Recommendation

**SHIP with known limitations.** Subsystem is production-ready for the Windows-only same-machine-reinstall scope. No pre-release work needed (the originally-cited BR-M4 shutdown-marker fix was already committed). Backlog: cloud-upload retry + timeout + outer mutex timeout (BR-M1/M2/M3). The shallow pass's "1 Critical" was an audit FP — there are no Critical issues actually shipping.

### 3.16 Action items

| # | Sev | File:line | Action | Effort |
|---|---|---|---|---|
| BR-M1 | Medium | `server/cloudBackup.js` uploadTier1/uploadTier3 | Add `_retryWithBackoff(maxRetries=3, baseDelayMs=1000, capDelayMs=30000)` wrapping cloud upload calls; record retry count in `backupHealthRegistry` | ~1h |
| BR-M2 | Medium | `server/cloudBackup.js:213-224` | Wrap queued ops in `Promise.race([op, timeout(90_000)])`; on timeout, skip with audit_log warning and move queue forward | ~45 min |
| BR-M3 | Medium | `server/cloudProviders/*` | Add explicit `AbortSignal.timeout(30_000)` (or equivalent) on each provider's upload HTTP call | ~30 min |
| ~~BR-M4~~ | ~~Medium~~ → **WITHDRAWN** | — | **Refuted 2026-05-28** — shutdown-marker fix already committed in `49406b1` ("Notification UX revamp + bundled WIP snapshot") and is in `origin/main`. Audit memory `project_shutdown_marker_fallback.md` was stale. **No fix needed.** | — |
| BR-Mi1 | Minor | `server/cloudBackup.js` `_zipDirectory()` | Issue `PRAGMA wal_checkpoint(RESTART)` before zipping OR include `-wal`/`-shm` in archive | ~20 min |
| BR-Mi2 | Minor | `server/db.js:535-576` | Wrap `PRAGMA quick_check(1)` in explicit 10s Promise timeout | ~10 min |
| BR-Mi3 | Minor | `server/cloudBackup.js` restore path + manifest writer | Add `backupFormatVersion` and `appVersion` cross-check; block restore with clear message on incompatible | ~30 min |
| BR-Mi4 | Doc | SKILL.md / CLAUDE.md | Add "Supported Windows versions" compatibility matrix (Win10 21H2+, Win11 21H2+) | ~10 min |
| BR-D1 | Doc | `CLAUDE.md` power-loss-resilience section | Add 2026-05-18 shutdown-marker fallback fix description | ~5 min |
| BR-D2 | Doc | `server/cloudBackup.js:213` | Add code comment explaining promise-chain mutex semantics | ~5 min |
| BR-N1 | Nit | (same as BR-D2) | — | — |
| BR-T1 | Test | `server/tests/cloudBackup.test.js` (extend or add) | Add tests: upload timeout, transient-error retry, mutex queue depth | ~2h |
| BR-FA1 | UI cross-cutting | `public/js/app.js checkBootIntegrityBanner()` — covered in §4 | Verify banner does NOT show red for `mode=skipped` | (see §4) |

---

## §4 Local Backup UI (renderer + bootstrap-restore wizard + remote-mode bleed)

**Audited:** 2026-05-28
**Files read:** `public/js/app.js` (Local Backup helpers, WS handlers, integrity banner, `checkBootIntegrityBanner`, `applyLocalBackupModeVisibility`, `renderBackupHealth`, `_invClockIsRemote`, `_v210IsRemoteMode`, `_srnApplyRemoteUiState`, `_snbApplyRemoteUiState`, Inverter Clock + Stop Reasons + Serial Number init code), `public/index.html` settings backup panel + remote-mode notice markup, `public/bootstrap-restore.html`, `public/bootstrap-restore.js`, `electron/main.js` (bootstrap wizard IPC handler), `server/index.js` (`/api/backup/*` routes, `/api/health/db-integrity`), CSS theme tokens

### 4.1 Executive summary

All 7 FP-R findings I seeded are **CONFIRMED** with file:line + code quotes. The deep audit then found **3 additional remote-mode UI bleeds** beyond Local Backup itself — in adjacent sections (Inverter Clocks, Stop Reasons, Serial Number).

**2026-05-28 re-audit revision:** Two of those three (NEW-R1 `_invClockIsRemote()` and NEW-R2 `_v210IsRemoteMode()`) turned out to be **audit FPs**: the hardcoded `return false;` is intentional v2.10.x design — server-side proxy middleware (`_proxyClockSyncInRemote`, `_proxyStopReasonsInRemote`, `_proxySerialInRemote` at `server/index.js:13401`, `:16149`, `:16478`) transparently forwards writes to the gateway, so the UI is mode-agnostic by design. The initial audit missed the v2.10.x comment blocks above each stub. Only NEW-R3 (cloud-backup settings form readable on remote viewer) remains as a real bleed.

Bootstrap-restore wizard lifecycle is **correct** (`restoreInFlight` gating, pseudo-progress disclaimer, explicit Relaunch click required). BR-FA1 cross-cutting verdict: integrity banner correctly does NOT fire for `mode=skipped` (passes through the 4-condition gate) but the server endpoint does not explicitly communicate skipped mode, making the contract implicit.

UI-R3 (boot integrity banner remote-mode rewording) **fixed this session**.

Revised scoring: status truthfulness 8/10; remote-mode hygiene 8/10 (raised from 5/10 after the two stub-bug FPs were refuted).

### 4.2 Methodology

Read `public/js/app.js` Local Backup helpers (lines 4979-5028, 15613-15619, 22692-22761, 25889-26127, 26492-26501), `checkBootIntegrityBanner()` at 3888-3966, `_invClockIsRemote()` at 23380-23382, `_v210IsRemoteMode()` at 23518-23520, `_srnApplyRemoteUiState()` at 23625-23647, `_snbApplyRemoteUiState()` at 24297-24333. Read `public/bootstrap-restore.html` + `bootstrap-restore.js` in full. Verified the 7 seeded FP-R findings line-by-line. Traced the WS `backup_health` push, the `/api/health/db-integrity` consumer, the 4-tier integrity banner logic, and the wizard's IPC chain. Quoted actual code in each finding.

### 4.3 UI surface inventory

| Surface | File:line | Role |
|---|---|---|
| Boot integrity banner | `public/js/app.js:3888-3966` | Alerts on startup if DB was restored / unexpected shutdown / unrescuable corruption |
| Local Backup controls (wrapper) | `public/js/app.js:4979-5028` | Lazy-init; hidden entirely in remote mode via `applyLocalBackupModeVisibility()` |
| Remote-mode notice | `public/index.html:2755-2765` | Informational banner shown when `isLocalBackupRemoteGated()` returns true |
| Backup Health pill list | `public/index.html:2788-2798` | 4-entry status display (tier1, tier3, portableScheduled, portableManual) |
| Schedule tab | `public/index.html:2800-2835` | Radio buttons (off/daily/weekly), folder destination, retention spinner |
| Export tab | `public/index.html:2838-2860` | "Export .adsibak" button + progress bar |
| Restore tab | `public/index.html:2862-2898` | File picker, import button, preview, restore/cancel buttons |
| Bootstrap-restore wizard | `public/bootstrap-restore.html` + `.js` | Standalone BrowserWindow, 5-step flow (file → validate → scope → progress → done) |
| WS `backup_health` push | `public/js/app.js:15613-15619` | Receives push, calls `renderBackupHealth(payload)` |
| Backup health status pill | `public/js/app.js:22728-22761` | Renders 4 types with ok/alert/unknown status |
| Schedule controls | `public/js/app.js:25889-25907` | Load/save schedule + retention |
| Export workflow | `public/js/app.js:25946-26000` | `lbExport()` — progress polling |
| Import workflow | `public/js/app.js:26002-26048` | `lbImport()` — validation, row-count preview |
| Restore workflow | `public/js/app.js:26050-26103` | `lbRestore()` — confirm, restore, progress |
| Inverter Clocks remote stub | `public/js/app.js:23380-23382` | `_invClockIsRemote()` — hardcoded `return false` |
| Stop Reasons / Serial Number remote stub | `public/js/app.js:23518-23520` | `_v210IsRemoteMode()` — hardcoded `return false` |

### 4.4 Validation of the 7 seeded FP-R findings

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| FP-R1 | `checkBootIntegrityBanner()` at `public/js/app.js:3888-3966` has no `isRemoteMode()` gate; fires on remote viewer about LOCAL viewer DB | **CONFIRMED** | Function calls `fetch("/api/health/db-integrity")` unconditionally; the 4-branch banner display (unrescuable / restored / unexpected / windowsInitiated) operates on the LOCAL `startupIntegrityResult` regardless of operating mode. Code quote: `const resp = await fetch("/api/health/db-integrity", { cache: "no-store" });` with no mode gate before or after. |
| FP-R2 | Bootstrap-restore wizard appears on license prompt regardless of mode; allows orphaned restore on remote viewer | **CONFIRMED** | Wizard handler at `electron/main.js:3640-3690` spawns BrowserWindow before `State.settings` is populated; wizard offers `.adsibak` restore that writes into the viewer's local DB. After relaunch in remote mode, the dashboard proxies everything to the gateway — restored data is orphaned. The wizard's "Restore complete!" UX makes this opaque to the operator. |
| FP-R3 | WS `backup_health` push at `public/js/app.js:15613-15619` calls `renderBackupHealth()` with no remote-mode gate | **CONFIRMED** | Lines 15616-15619: `if (msg.type === "backup_health") { if (msg.payload) renderBackupHealth(msg.payload); return; }` — no gate. Target DOM is hidden in remote mode so user doesn't see it, but DOM mutation runs on every push. |
| FP-R4 | Read-only `/api/backup/*` endpoints (health/status/progress/history/settings/local-settings) are NOT remote-gated server-side | **CONFIRMED** | Verified at `server/index.js:23808-24077`. WRITE endpoints have `if (isRemoteMode()) return _refuseBackupInRemoteMode(res);` — reads do not. UI-level gating at `app.js:4981` is the only protection. |
| FP-R5 | `gatewayOnly: true` flag in `/api/backup/health` response is hardcoded informational; UI never consumes it | **CONFIRMED** | `server/index.js:23811-23816` returns `{ mode: readOperationMode(), gatewayOnly: true, health: ... }`; grep across `public/js/app.js` finds no reference to `gatewayOnly`. The field is dressed as a contract but is documentation only. |
| FP-R6 | `applyLocalBackupModeVisibility()` re-fires only on (a) settings-tab activation and (b) `configChanged` WS message | **CONFIRMED** | Triggers verified at `public/js/app.js:4980` (tab activation) and `:15880` (configChanged handler). NOT triggered on bridge state transitions, license-prompt close, ipconfig changes, or the loading-screen mode picker. 5-10s drift window during runtime mode flips. |
| FP-R7 | `renderBackupHealth()` writes "Health data unavailable" placeholder into hidden DOM on null snapshot | **CONFIRMED** | `public/js/app.js:22731-22734`: `if (!snapshot) { root.innerHTML = '<div class="cb-health-row cb-health-unknown">...</div>'; return; }` — wasted DOM work, never visible. Aesthetic only. |

### 4.5 NEW remote-mode UI bleeds (beyond the 7 seeded)

#### NEW-R1 (~~MAJOR~~ → AUDIT FP, refuted 2026-05-28 11:35) — `_invClockIsRemote()` hardcoded `return false`
**File:** `public/js/app.js:23380-23382`
```javascript
// v2.10.x — remote-mode operator actions for the inverter-clock section
// (broadcast / per-inverter / per-unit sync, schedule save) are now
// forwarded to the gateway by the server-side `_proxyClockSyncInRemote`
// middleware in server/index.js. The UI no longer gates these actions on
// the remote/gateway mode flag, so this helper returns false to keep
// every legacy call site (button-enable rules, banner toggles) on the
// gateway-equivalent path.
function _invClockIsRemote() {
  return false;
}
```
**Refutation:** The initial audit pass missed the v2.10.x comment block immediately above the stub. Server-side proxy chain verified: `_proxyClockSyncInRemote` defined at `server/index.js:13401` (`if (isRemoteMode()) return proxyToRemote(req, res, "", { forwardOperatorAuth: true })`) and wired into `/api/sync-clock/inverter/:inverter`, `/api/sync-clock/:inverter/:unit`, `/api/sync-clock/broadcast` at lines 13441, 13456, 13473. In remote mode, button clicks hit the local route → middleware transparently proxies to gateway → operator sees identical UX. **Intentional design, not a stub bug.**

#### NEW-R2 (~~MAJOR~~ → AUDIT FP, refuted 2026-05-28 11:36) — `_v210IsRemoteMode()` hardcoded `return false`
**File:** `public/js/app.js:23518-23520`
```javascript
// v2.10.x — Stop Reasons (Slice D) and Serial Number (Slice C) actions are
// now forwarded to the gateway by the server-side `_proxyStopReasonsInRemote`
// and `_proxySerialInRemote` middleware (see server/index.js). The UI no
// longer needs to disable Refresh / Read / Send / Fleet Scan in remote mode,
// so this helper returns false to keep every legacy call site on the
// gateway-equivalent path. Per-row Send tooltips, banner visibility, and
// the format+session enable rule for #btnSnbSend all collapse to the
// gateway behaviour.
function _v210IsRemoteMode() {
  return false;
}
```
**Refutation:** Same audit miss pattern — failed to read the v2.10.x comment block above the stub. Server-side proxy chain verified: `_proxyStopReasonsInRemote` at `server/index.js:16149` (1 wire point at 16233) and `_proxySerialInRemote` at `server/index.js:16478` (7 wire points: 16622, 16674, 16980, 17102, 17182, 17207, 17274). In remote mode all Stop Reasons + Serial Number actions transparently proxy to the gateway. **Intentional design, not a stub bug.**

**Cross-cutting lesson:** Theme T-1 in §5.2 ("Hardcoded `return false;` stubs") is REFUTED for the two §4 examples. The pattern exists in the codebase but in both cases reflects an intentional v2.10.x server-proxy-driven UX, not scaffolding debt. Future audits should grep for the `v2.10.x — ` comment marker above any such stub before flagging.

#### NEW-R3 (Medium) — Cloud backup settings form readable on remote viewer with no visual disabled state
**File:** `public/js/app.js:22358-22436` (`cbLoadSettings`, `cbSaveSettings`)
The cloud-backup settings form (provider selector, email, OAuth status, retention) is loaded and rendered on remote viewers — `GET /api/backup/settings` is not remote-gated (FP-R4). The form inputs are not visually disabled. Operator types into provider/email fields; UI accepts input; clicks Save; POST to `/api/backup/settings` triggers `isRemoteMode()` server-side refusal. The form silently snaps back to prior values with a generic error toast. **Operator wasted effort and received unclear feedback.**

#### NEW-R4 (Minor) — Mode picker on loading screen does not re-apply Local Backup visibility
**File:** `electron/main.js retryServerStartup()` flow + `public/js/app.js:5022-5028`
Per memory, the loading-screen Connection Mode picker calls `retryServerStartup()` after the operator selects gateway/remote. This path does not call `applyLocalBackupModeVisibility()` directly; it relies on a subsequent `configChanged` WS message to propagate. The 5-10s window mentioned in FP-R6 is widest here because the WS hasn't yet reconnected when the picker resolves.

### 4.6 Status display lies (truthfulness audit)

| # | Surface | Lie | Cause |
|---|---|---|---|
| L-1 | Boot integrity banner on remote viewer | "Database auto-restored" / "Unexpected prior shutdown" | Refers to viewer's local cache DB but operator reads it as plant data — see FP-R1 (UI-R3 still active) |
| ~~L-2~~ | ~~Inverter Clocks "Sync Plant" button~~ | ~~Visually enabled on remote viewer~~ | **REFUTED 2026-05-28**: intentional — proxy forwards to gateway (NEW-R1 refutation) |
| ~~L-3~~ | ~~Stop Reasons "Refresh" + remote banner~~ | ~~Banner hidden, button enabled on remote viewer~~ | **REFUTED 2026-05-28**: intentional — proxy forwards to gateway (NEW-R2 refutation) |
| ~~L-4~~ | ~~Serial Number Read/Send/Scan/Bulk buttons + remote banner~~ | ~~Banner hidden, all 6 buttons enabled on remote viewer~~ | **REFUTED 2026-05-28**: same proxy as L-3 (NEW-R2 refutation) |
| L-5 | Cloud backup settings form on remote viewer | Form looks editable; saves silently fail | NEW-R3 |

### 4.7 Button state mismatches

| # | Surface | Issue | Severity |
|---|---|---|---|
| B-1 | Save schedule (Local Backup) | No loading state during POST; rapid double-click hits backend twice (idempotent so harmless) | Nit |
| B-2 | Bulk re-serialize (Serial Number) | No state-shared lock with bootstrap-restore wizard | Minor (low overlap window) |
| B-3 | Restore button enabled with no imported backup | Mitigated by `_lbImportedId` null-check at `app.js:26051`; clear toast on click | Nit |

### 4.8 Toasts / notifications that misfire

| # | Surface | Misfire | Severity |
|---|---|---|---|
| T-1 | Cloud backup settings save (remote) | Generic error toast "Save failed" instead of "Not available in remote mode" | Minor (NEW-R3 related) |
| T-2 | Export progress polling | Success toast `showToast("Exported ${sizeStr}.", "ok")` fires on `status === "done"` — could fire before final OS flush | Out of scope (backend contract; flagged in §3) |
| T-3 | Import row-count toast persists across tab switches | Standard toast behavior; classified intentional | Nit (intentional pattern) |

### 4.9 Bootstrap-restore wizard UX

#### Lifecycle correctness — **PASS**
`public/bootstrap-restore.js:272-329` runs the restore. State machine: `state.restoreInFlight = true` → restore → set to false → `setStep(5)`. Comment at line 326-327 is explicit: "do NOT fire complete() here. The user must click Relaunch to confirm they've read the success page."

#### Cancel/Back during step 4 — **PASS** (`restoreInFlight` gating works)
```javascript
function updateFooterButtons() {
  if (state.step === 4 && state.restoreInFlight) {
    btnCancel.style.display = "none";
    btnBack.style.display = "none";
  }
}
els.btnBack.addEventListener("click", () => {
  if (state.restoreInFlight) return;
  if (state.step === 4 && state.restoreOutcome === "failure") { setStep(3); }
});
```
Both Cancel and Back hidden during restore; Back honored only after failure.

#### Pseudo-progress bar — **PASS** (honestly disclaimed)
```javascript
// Pseudo-progress timer. Real progress events aren't available without
// the embedded server — this is just to reassure the user the app is
// alive while archiver/extract-zip stream the .adsibak through Node.
let pct = 10;
const tick = setInterval(() => {
  pct = Math.min(pct + 3, 90);
  els.progressFill.style.width = `${pct}%`;
  if (pct < 40)       els.progressText.textContent = "Extracting backup archive…";
  else if (pct < 70)  els.progressText.textContent = "Verifying integrity…";
  else                els.progressText.textContent = "Writing files to disk…";
}, 800);
```
Capped at 90% until backend resolves; phase text order (extract → verify → write) matches actual flow. Comment is explicit about pseudo-nature.

#### Success page → Relaunch — **PASS**
On success: `els.progressFill.style.width = "100%"; els.progressText.textContent = "Restore complete."; setStep(5);`. Relaunch only on operator click.

### 4.10 Boot integrity banner audit (validate BR-FA1 cross-cutting)

`public/js/app.js:3888-3966` checks 4 conditions and shows a banner if ANY of them are true:

```javascript
const unrescuable = !!payload.unrescuable;
const restored = !!payload.restored;
const ls = payload.lastShutdown || null;
const unexpected = ls && ls.classification === "unexpected";
const windowsInitiated = ls
  && ls.classification === "graceful"
  && ["session-end", "power-shutdown"].includes(String(ls.reason || ""));

if (!unrescuable && !restored && !unexpected && !windowsInitiated) return;
```

**Per-case verdict:**

| Case | Banner color | Trigger | Honest? |
|---|---|---|---|
| `unrescuable` | bright red `#a31717` | Both backup slots corrupt; fresh DB opened | ✓ Honest (real data-loss event) |
| `restored` | dark red `#7a1f1f` | Main DB corrupt; auto-restored from backup slot | ✓ Honest |
| `unexpected` | amber `#a56a14` | Last run ended without graceful shutdown marker | ✓ Honest (real crash event) |
| `windowsInitiated` | slate-blue `#2f4a66` | Windows session-end / power-shutdown signal | ✓ Honest (advisory only) |
| `mode=skipped` (BR-FA1) | not shown | Integrity gate degraded to skip due to asar-shim | ✓ Banner correctly does NOT fire — none of the 4 conditions evaluate true |

**BR-FA1 verdict: PARTIAL — banner correctly suppressed for `mode=skipped`, but only by accident.** The server endpoint at `server/index.js:12790-12805` does NOT explicitly return a `mode` field for the renderer; it only sets `unrescuable / restored / mainDb / restoredFromSlot`. Renderer never sees "skipped"; it just doesn't see any of the 4 trigger conditions, so the banner stays hidden. **Contract is defensive-by-default but not explicit.** A future endpoint refactor that adds an `unexpected: true` field for skipped-mode cases could silently break this. **Recommend:** add explicit `mode` field to the response and have the renderer consume it.

### 4.11 Copy / labeling drift

| # | Location | Drift |
|---|---|---|
| C-1 | Inverter Backup labels | "Portable", "Portable (Scheduled)", "Portable (Manual)", ".adsibak", "Export .adsibak" — non-uniform terminology |
| C-2 | "Restore from Backup" button on license prompt | Missing ellipsis "…" suffix; standard convention indicates "opens dialog" |
| C-3 | User Guide stat-card on `docs/ADSI-Dashboard-User-Guide.html` and `public/user-guide.html` | Recently fixed in commit `669e9d7` to show new Pmax/Pnom values; no further drift |
| C-4 | Cloud backup help text in remote mode | Says "configure cloud provider" with no remote-mode caveat; misleading on remote viewer |

### 4.12 Cross-mode `_xIsRemote()` stubs — pattern survey

Three UI sections use hardcoded-`false` helpers named `_xIsRemote()`:
1. **Inverter Clocks** — NEW-R1
2. **Stop Reasons** — NEW-R2
3. **Serial Number / Firmware Map** — NEW-R2 (same stub)

**2026-05-28 re-audit revision:** Initially classified as "emerging class of bug." Verification of server-side proxy chains proved this **incorrect** — the stubs are intentional v2.10.x design markers indicating that writes from those sections are transparently proxied to the gateway via dedicated middleware:
- `_proxyClockSyncInRemote` (`server/index.js:13401`, wired into 3 routes)
- `_proxyStopReasonsInRemote` (`server/index.js:16149`, wired into 1 route)
- `_proxySerialInRemote` (`server/index.js:16478`, wired into 7 routes)

The UI is mode-agnostic by design; remote-mode operators click buttons → local route → middleware proxies to gateway → identical UX. Each stub has an explanatory v2.10.x comment block above it.

Other sections use the correct gating: `Calibration` uses `isRemoteMode()` directly; `Plant Cap` is gateway-only via server endpoint; `Field Calibration` has its own auth surface.

### 4.13 Theme / accessibility false positives

| # | Surface | Status | Notes |
|---|---|---|---|
| A-1 | Boot integrity banner | ✓ PASS | `role="alert"` at line 3914; banner colors use theme-token-compatible hues |
| A-2 | Bootstrap-restore wizard stepper | ⚠ NEEDS WORK | No `aria-progressbar`, no `aria-valuenow`; dots have no labels — screen readers silent during steps |
| A-3 | Status pill "unknown" contrast | ⚠ NEEDS WORK | Likely uses muted gray on dark gray — fails WCAG AA |
| A-4 | Import/Export button labels | ⚠ NEEDS WORK | Just "Import"/"Export" without descriptive `aria-label`; screen-reader hears no context |
| A-5 | Stop Reasons remote banner | ✓ PASS | Uses `.hidden` property (semantic correct). Banner is intentionally always-hidden per v2.10.x design (NEW-R2 refutation) — Stop Reasons writes transparently proxy to gateway. |
| A-6 | Inverter Clock buttons disabled-state | ⚠ NEEDS WORK | No `aria-disabled` alongside `.disabled` property — assistive tech may not announce disable state |
| A-7 | Banner colors across themes | ✓ PASS | All 4 colors are theme-token compatible |

### 4.14 NEW intentional UI false positives (code that looks buggy but isn't)

1. **WS `backup_health` mutates hidden DOM in remote mode** — `app.js:15616-15619`. Looks like wasted work or a bug; actually intentional defensive caching — if user switches to gateway mode, the DOM is already populated. No corruption risk.

2. **`renderBackupHealth(null)` writes "Health data unavailable" placeholder** — `app.js:22731-22734`. Looks like a fallback that should never fire (the panel is hidden in remote mode anyway). Actually correct defensive fallback — if a bug ever un-hides the panel, the placeholder is shown rather than empty markup.

3. **Backup health 3-strike `consecutiveFailures >= 3`** — `app.js:22750`. Looks like ignoring failures; actually intentional buffer against transient network/disk blips. Operator can read the detail text for ground truth.

4. **License scope unchecked-by-default in bootstrap wizard** — `public/bootstrap-restore.js:167-218`. Looks like missing a critical item; actually intentional safety to prevent stale-license-to-new-hardware collision (memory `bootstrap_restore_wizard.md`).

5. **Scope checklist shows "critical" pill on items that are unchecked** — same lines. "Critical" semantic = "don't restore lightly," not "must restore."

6. **Pseudo-progress bar capped at 90%** — `bootstrap-restore.js:272-329`. Looks like the bar never reaches 100%; actually intentional UX pattern — step transition to 5 is the real completion signal.

7. **Bootstrap-restore wizard runs WITHOUT embedded server** — `electron/main.js:3640-3690`. Looks like missing infrastructure; actually correct — avoids server-startup latency during damaged-DB recovery (memory).

8. **Local Backup controls fully HIDDEN in remote mode (not just disabled)** — `app.js:5022-5028`. Looks aggressive; actually intentional — disabling alone would still let JS code touch the controls (race conditions).

9. **Toast messages persist across tab switches** — global notification pattern; correctly intentional.

10. **Operator must click Relaunch on success page (not auto)** — `bootstrap-restore.js:326-329`. Looks like missing UX; actually intentional — ensures operator has read the success message before app restarts.

11. **Status pill defers to backend `entry.status` if backend provides it** — `app.js:22738`. Looks like a backend lie could override UI; actually correct — backend has authoritative state, UI heuristic is fallback only.

12. **Cancel button hidden after `restoreInFlight=false`** — `bootstrap-restore.js:301-330`. Looks like a UX bug (user can't cancel from success page); actually correct — success has no cancel semantics.

13. **`_lbImportedId` is module-scope mutable state** — `app.js:22692`. Looks like global mutable state smell; actually correct — restore is a stateful 2-step (import → restore) flow that needs persistent reference between user actions.

### 4.15 NEW real UI bugs

#### Critical
*(None.)*

#### Major
~~**UI-Bug-1** — **`_invClockIsRemote()` hardcoded `return false`**~~

**Refuted 2026-05-28** — intentional v2.10.x design. `_proxyClockSyncInRemote` at `server/index.js:13401` transparently forwards clock-sync writes to gateway in remote mode. Comment block above the stub explains this. See §4.5 NEW-R1 refutation + §5.5.

~~**UI-Bug-2** — **`_v210IsRemoteMode()` hardcoded `return false`**~~

**Refuted 2026-05-28** — intentional v2.10.x design. `_proxyStopReasonsInRemote` (`server/index.js:16149`, 1 wire point) and `_proxySerialInRemote` (`server/index.js:16478`, 7 wire points) transparently forward Stop Reasons + Serial Number writes to gateway. Comment block above the stub explains this. See §4.5 NEW-R2 refutation + §5.5.

**UI-Bug-3 (DONE)** — **`checkBootIntegrityBanner()` fires on remote viewer about LOCAL viewer DB** at `public/js/app.js:3888-3984`. FP-R1 above. **Fixed this session 2026-05-28** — added `remoteMode` check and reworded all 4 banner branches (unrescuable / restored / unexpected / windows-initiated) so remote-mode operators see "Local viewer cache" framing with explicit "Plant data on the gateway is unaffected" note where applicable.

#### Medium
**UI-Bug-4** — **Cloud backup settings form readable on remote viewer with no visual disabled state** at `public/js/app.js:22358-22436`. NEW-R3 above. Operator inputs are accepted; save silently fails with generic toast.

**UI-Bug-5** — **`/api/backup/health` returns unused `mode`/`gatewayOnly` fields** at `server/index.js:23809-23821`. FP-R5 above. Contract ambiguous; future maintainer might expect UI to consume.

**UI-Bug-6** — **WS `backup_health` handler lacks `isRemoteMode()` check** at `public/js/app.js:15616-15619`. FP-R3 above. DOM mutation on every push even when hidden.

#### Minor
**UI-Bug-7** — **Bootstrap-restore wizard stepper missing `role="progressbar"` + ARIA labels** at `public/bootstrap-restore.html`. A-2 above. Screen readers silent.

**UI-Bug-8** — **Status pill "unknown" likely fails WCAG AA contrast** in CSS class `.cb-health-unknown`. A-3 above.

**UI-Bug-9** — **Import/Export buttons lack descriptive `aria-label`** at `public/index.html:2838-2898`. A-4 above.

**UI-Bug-10** — **`applyLocalBackupModeVisibility()` not re-fired on loading-screen mode-picker path** in `retryServerStartup()` flow. NEW-R4 / FP-R6 above.

#### Nit
**UI-Bug-11** — **Save schedule button has no loading state** at `public/js/app.js:25891`. Idempotent on backend so harmless; cosmetic only.

**UI-Bug-12** — **"Restore from Backup" license-prompt button missing ellipsis** indicating "opens dialog." C-2 above.

### 4.16 Cross-cutting BR-FA1 verdict

The banner at `public/js/app.js:3888-3966` does **correctly** suppress for `mode=skipped`, but only because the server endpoint never sets any of the 4 trigger conditions when in skipped mode. The protection is implicit (defensive-by-default), not explicit. Two recommendations:
1. Add explicit `mode: "skipped" | "restored" | "failed" | ...` field to `/api/health/db-integrity` response
2. Make the renderer consume it for forward compatibility

### 4.17 Scoring

*Post-2026-05-28 re-audit (after UI-Bug-1 + UI-Bug-2 refuted, UI-Bug-3 fixed):*

- **Status-display truthfulness:** 8 / 10 — UI-Bug-3 fixed this session; cloud-settings form (UI-Bug-4) remains as a Medium open item
- **Button-state correctness:** 7 / 10 — the two "6+ buttons never disable" findings (UI-Bug-1, UI-Bug-2) refuted as intentional v2.10.x server-proxy design
- **Wizard UX:** 9 / 10 — bootstrap-restore is correctly architected; pseudo-progress honestly disclaimed; cancel/back gating works
- **Copy accuracy:** 8 / 10 — minor terminology drift; main user guide stat cards recently fixed
- **Accessibility:** 6 / 10 — banner has role="alert", but stepper missing ARIA, unknown-pill contrast, button labels
- **Remote-mode hygiene:** 8 / 10 — boot integrity banner now mode-aware; v2.10.x proxy chain verified for Inverter Clocks + Stop Reasons + Serial Number; only the cloud-settings form (NEW-R3) remains
- **Code-level false positives identified:** 13 (verified shallow pass's set, no new ones not already-classified)
- **Runtime false alarms identified:** 5 (banner cross-bleed [now fixed], 3 stub-driven button enablement issues [refuted as intentional], cloud-settings form readable on remote)
- **Real UI bugs — Critical: 0, Major: 1, Medium: 3, Minor: 4, Nit: 2** (was 3 Major before re-audit; UI-Bug-1/2 refuted, UI-Bug-3 fixed)

### 4.18 Recommendation

**SHIP.** The Local Backup UI is correctly built (hidden in remote mode, wizard is sound, banner suppression works). After the 2026-05-28 re-audit:
- UI-Bug-1 + UI-Bug-2 (v2.10.x stub "bugs") **refuted as intentional design** — server-proxy chain transparently forwards writes
- UI-Bug-3 (boot integrity banner cross-bleed) **fixed this session**
- Remaining concerns are Medium backlog (UI-R4–R7) and Minor a11y/copy nits (UI-R8–R13)

Residual cleanup is ~1.5 h of focused backlog work, none of it pre-release blocking.

### 4.19 Action items

| # | Sev | File:line | Action | Effort |
|---|---|---|---|---|
| ~~UI-R1~~ | ~~Major~~ → **WITHDRAWN** | `public/js/app.js:23380-23382` | Audit FP — see NEW-R1 refutation. Intentional v2.10.x server-proxy design (verified at `server/index.js:13401`). **No fix.** | — |
| ~~UI-R2~~ | ~~Major~~ → **WITHDRAWN** | `public/js/app.js:23518-23520` | Audit FP — see NEW-R2 refutation. Intentional v2.10.x server-proxy design (verified at `server/index.js:16149`, `:16478` and 8 wire points). **No fix.** | — |
| UI-R3 | Major | `public/js/app.js:3888-3966` | Add early `if (isRemoteMode()) return;` to `checkBootIntegrityBanner()` OR reword each banner to clarify "local viewer cache" in remote mode | ~10 min |
| UI-R4 | Medium | `public/js/app.js:15613-15619` | Add `if (isRemoteMode()) return;` guard to WS `backup_health` handler | ~5 min |
| UI-R5 | Medium | `public/js/app.js:22358-22436` | Disable cloud-settings form inputs when `isLocalBackupRemoteGated()` is true; or hide the settings tab entirely in remote mode (matches Local Backup pattern) | ~20 min |
| UI-R6 | Medium | `server/index.js:23809-23821` | Either consume the `gatewayOnly`/`mode` fields client-side at `app.js renderBackupHealth()` as a render gate, or remove them from the server response | ~10 min |
| UI-R7 | Medium | `electron/main.js retryServerStartup` flow | Trigger `applyLocalBackupModeVisibility()` after mode-picker resolves on loading screen | ~10 min |
| UI-R8 | Minor | `public/bootstrap-restore.html` stepper | Add `role="progressbar"` + `aria-valuenow`/`aria-valuemin`/`aria-valuemax` + per-dot `aria-label` | ~10 min |
| UI-R9 | Minor | CSS `.cb-health-unknown` rule | Raise contrast: change `color` from `--muted` to `--text`; verify WCAG AA (4.5:1) | ~10 min |
| UI-R10 | Minor | `public/index.html:2838-2898` Import/Export buttons | Add `aria-label="Import portable backup from .adsibak file"` / `aria-label="Export portable backup to .adsibak file"` | ~5 min |
| UI-R11 | Minor | `server/index.js:12790-12805` | Add explicit `mode` field to `/api/health/db-integrity` response; consume in renderer for forward-compatibility | ~15 min |
| UI-R12 | Nit | `public/js/app.js:25891 saveLocalBackupSchedule()` | Add `btn.disabled = true` before POST, restore after response | ~5 min |
| UI-R13 | Nit | License-prompt button text | Append ellipsis "…" to "Restore from Backup" to indicate dialog | ~2 min |

---

## §5 Consolidated action items + scoring

*Compiled 2026-05-28 11:25 GMT+8 from §1–§4. This section is the single shopping-list for follow-up work; the per-section action tables above remain the canonical references for context.*

### 5.1 Aggregate scorecard

| Subsystem | Construction | Performance | Resilience / UX | Critical | Major | Medium | Minor | Nit | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| §1 Forecast Engine | 9 / 10 | 9 / 10 | n/a | 0 | 0 | 0 | 1 | 1 | **SHIP** (post-2026-05-28 re-audit) |
| §2 ML Training | 9 / 10 | 8.5 / 10 | n/a | 0 | 0 | 1 | 3 | 1 | **SHIP** |
| §3 Backup/Restore | 9 / 10 | 8 / 10 | OS-mig 8 / 10 · Power 9 / 10 | 0 | 0 | 3 | 4 | 1 | **SHIP** with limitations |
| §4 Local Backup UI | n/a | n/a | Status 8 · Buttons 7 · Wizard 9 · Copy 8 · A11y 6 · Remote 8 | 0 | 1 | 3 | 5 | 2 | **SHIP** with operator awareness |
| **Plant-wide** | **9.0 / 10** | **8.3 / 10** | **mixed** | **0** | **1** | **7** | **13** | **5** | **SHIP** — no blockers |

Subsystem-wide totals exclude duplicate cross-cutting items (BR-FA1 counted only in §3, UI-R3 counted only in §4).

**2026-05-28 re-audit revisions** (after operator-driven verification pass):
- §1: F-C1 (Critical) and F-M1 (Major) withdrawn as audit FPs → §1 verdict changed from HOLD to SHIP, construction 7.5 → 9, performance 7 → 9.
- §2: ML-M1 partial fix landed (inline doc comment), ML-M2 withdrawn (audit had wrong N_TRAIN_DAYS) → §2 Major 2 → 0, performance 7 → 8.5.
- §3: BR-M4 withdrawn (already committed in `49406b1`) → §3 Medium 4 → 3.
- §4: UI-R1, UI-R2 withdrawn (intentional v2.10.x proxy design) → §4 Major 3 → 1 (UI-R3 only); UI-R3 now fixed.
- Plant-wide: Critical 1 → 0, Major 4 → 1, total HOLD verdict lifted.

### 5.2 Cross-cutting themes

Three patterns were originally identified across subsystems. The 2026-05-28 re-audit refuted Theme T-1 entirely and narrowed Theme T-2; T-3 remains valid.

**~~Theme T-1~~ — Hardcoded `return false;` stubs masquerading as runtime checks.** *(Refuted 2026-05-28 — see NEW-R1/R2 refutations in §4.5.)* The two §4 examples (`_invClockIsRemote()` and `_v210IsRemoteMode()`) returning `false` are intentional: v2.10.x design routes Inverter Clock, Stop Reasons, and Serial Number writes through server-side proxy middleware (`_proxyClockSyncInRemote`, `_proxyStopReasonsInRemote`, `_proxySerialInRemote`) so the UI is transparently mode-agnostic. The original audit missed the explicit comment block above each stub explaining the design. **Lesson preserved:** before flagging a `return false;` stub as a bug, grep the server for a matching `_proxy*InRemote` middleware and verify it's wired into the routes the UI touches.

**Theme T-2 — Missing-timeout class of bug.** Three Medium items in §3 (BR-M1/M2/M3) share the root cause: an unbounded HTTP/mutex resource without an explicit cap. (Note: §1 F-C1 was originally included in this theme but was **refuted 2026-05-28** — the `ARCHIVE_DB_CACHE` already has LRU eviction with `MAX_ENTRIES=6` from commit `b2665f5`.) Each looks like working code in isolation; together they form the dominant operational risk of a long-running install for cloud uploads specifically. **Recommendation:** before next release, run a 24-hour soak with `tcpkill` on cloud-provider hostnames and verify cloud-upload memory + queue depth stays bounded.

**Theme T-3 — Documentation drift across releases.** Eight Doc-tier items (F-D1/D2/D3, ML-D1/D2, BR-D1/D2, plus the UI Plant Output Cap copy in §4) reflect v2.4 → v2.11 features that landed in code but never landed in `references/*.md` or `CLAUDE.md`. None is operationally dangerous; collectively they extend onboarding time for the next maintainer by ~half a day. **Recommendation:** make doc-PR a release-gate checklist item (10-minute spot-check against `references/*.md` before tagging).

A fourth, lower-severity theme spans §3 + §4: **remote-mode bleed** — server returns `gatewayOnly: true` and `mode` fields that the renderer never consumes, while several read-only `/api/backup/*` endpoints have no server-side mode gate. The current UI hides the relevant DOM, so this is latent rather than visible, but any future renderer refactor could expose it. (See UI-R5 + UI-R6.)

### 5.3 Prioritized action items — all subsystems

#### Tier 1 — Critical / pre-release blockers (must land before next stable)

**NONE** — post-2026-05-28 re-audit. F-C1 and BR-M4 were already implemented; audit reviewer missed both.

| # | Subsystem | File:line | Status |
|---|---|---|---|
| ~~F-C1~~ | §1 Forecast | `server/db.js:4154-4202` | **Already implemented in commit `b2665f5` (v2.11.0-beta.5)** — `ARCHIVE_DB_CACHE_MAX_ENTRIES = 6`, LRU eviction with close-before-delete, telemetry. |
| ~~BR-M4~~ | §3 Backup | `electron/main.js`, `electron/shutdownReason.js` | **Already committed in `49406b1`** ("Notification UX revamp + bundled WIP snapshot"). Working tree clean. |

#### Tier 2 — Major (next-cycle)

| # | Subsystem | File:line | Action | Effort | Status |
|---|---|---|---|---|---|
| ~~F-M1~~ | §1 Forecast | `services/forecast_engine.py:11791-11812` | — | — | **WITHDRAWN** — try/except already wraps `requests.post()`; fallback to `run_dayahead(..., write_audit=True)` writes proper audit row |
| ML-M1 (doc) | §2 ML | `services/forecast_engine.py:7541-7570` | Added inline rationale comment for sklearn fallback hyperparams | — | **DONE 2026-05-28** |
| ~~ML-M2~~ | §2 ML | — | — | — | **WITHDRAWN** — audit's 235 MB claim was based on wrong N_TRAIN_DAYS (assumed 180, actual 45 → ~7.5 MB) |
| ~~UI-R1~~ | §4 UI | — | — | — | **WITHDRAWN** — intentional v2.10.x server-proxy design |
| ~~UI-R2~~ | §4 UI | — | — | — | **WITHDRAWN** — intentional v2.10.x server-proxy design |
| UI-R3 (reword) | §4 UI | `public/js/app.js:3888-3984` | Per-mode message rewording so remote operator sees "Local viewer cache" framing with explicit "Plant data on the gateway is unaffected" note | — | **DONE 2026-05-28** |

#### Tier 3 — Medium (backlog, batchable)

| # | Subsystem | File:line | Action | Effort |
|---|---|---|---|---|
| BR-M1 | §3 Backup | `server/cloudBackup.js` uploadTier1/uploadTier3 | `_retryWithBackoff(3, 1000, 30000)` wrapping cloud uploads | ~1 h |
| BR-M2 | §3 Backup | `server/cloudBackup.js:213-224` | `Promise.race([op, timeout(90_000)])` on queued ops | ~45 min |
| BR-M3 | §3 Backup | `server/cloudProviders/*` | Explicit `AbortSignal.timeout(30_000)` on each provider's upload | ~30 min |
| ML-Me3 | §2 ML | `services/forecast_engine.py:7226-7264` | Per-regime min 50 → 30 during transitions OR downweighted-sparse mode | ~2 h |
| UI-R4 | §4 UI | `public/js/app.js:15613-15619` | `if (isRemoteMode()) return;` guard in WS `backup_health` handler | ~5 min |
| UI-R5 | §4 UI | `public/js/app.js:22358-22436` | Disable cloud-settings form when `isLocalBackupRemoteGated()` true | ~20 min |
| UI-R6 | §4 UI | `server/index.js:23809-23821` | Consume `gatewayOnly`/`mode` server fields as renderer gate OR drop them | ~10 min |
| UI-R7 | §4 UI | `electron/main.js retryServerStartup` | Trigger `applyLocalBackupModeVisibility()` after loading-screen mode-picker | ~10 min |

#### Tier 4 — Minor / Nit / Doc / Test (opportunistic)

| # | Subsystem | Effort | Category |
|---|---|---|---|
| F-Mi1 / F-FA1 / F-FA2 | §1 Forecast | ~45 min combined | Snapshot validation consolidation + log-noise gating |
| ML-Mi4 / ML-Mi5 / ML-FA3 / ML-FA4 | §2 ML | ~2 h combined | Cap-tolerance config, legacy-model truncation atomicity, engine-health classification |
| BR-Mi1 / BR-Mi2 / BR-Mi3 | §3 Backup | ~1 h combined | WAL checkpoint before zip, `quick_check` timeout, format-version cross-check |
| UI-R8 / UI-R9 / UI-R10 / UI-R12 / UI-R13 | §4 UI | ~32 min combined | Accessibility (stepper, contrast, aria-label), button loading state, ellipsis |
| F-D1/D2/D3 / ML-D1 / BR-D1/D2 / BR-Mi4 | §1–§3 | ~40 min combined | Documentation alignment (references/*.md + CLAUDE.md) |
| F-T1/T2 / ML-T1 / BR-T1 | §1–§3 | ~7 h combined | Regression tests (concurrent lock, memory stress, mutex queue depth) |
| UI-R11 | §4 UI | ~15 min | Explicit `mode` field in `/api/health/db-integrity` |

### 5.4 Recommended sequence

**2026-05-28 update:** Tier 1 and most of Tier 2 collapsed after operator-driven verification — all "blocker" items except UI-R3 + ML-M1 doc-comment turned out to be audit FPs or already-committed work. Revised plan:

1. ~~**Pre-merge gate**~~ — **NONE**. F-C1 and BR-M4 already shipped.
2. ~~**Before next stable release**~~ — **DONE**. UI-R3 reworded (this session). ML-M1 doc comment added (this session).
3. **Next backlog cycle (~5 h):** BR-M1/M2/M3 + UI-R4/R5/R6/R7 + ML-Me3. Group with regression tests F-T1, BR-T1.
4. **Opportunistic / quarterly:** Tier 4 items.

Total Tier-1+2 effort: **~15 min actually applied** (UI-R3 reword + ML-M1 inline comment). Total Tier-3 effort: **~5.2 h.** Total Tier-4 effort: **~11.2 h** (mostly tests).

### 5.5 What the audit refuted

The deep dive overturned several findings from prior shallow passes and from the orchestrate-command initial sweep — preserved here so they are not re-raised.

| Refuted claim | Actual reality |
|---|---|
| "Hardcoded Windows paths in `server/storagePaths.js:23-42` is Critical (cross-OS broken)" | **Product is Windows-only by design** — paths are correct. Reframed as audit FP. (§3) |
| "wevtutil.exe call has no timeout" | **Has 5000 ms timeout** at `electron/integrityGate.js:122`. (§3) |
| "Backup mutex promise-chain risks deadlock" | **Correct serialization, no deadlock risk** — only queue-depth gap (separately tracked as BR-M2). (§3) |
| "Backup slot rotation can lose both slots" | **Refuted** in 2026-05-11 DB-health audit; both-slot atomic swap is correct. (§3) |
| "Plant-cap controller caches stale state" | **Refuted** — controller reads fresh state on every tick. (§3 cross-ref) |
| "Concurrent error-memory race in forecast engine" | **Refuted** — `_ERROR_MEMORY_LOCK` guards all writes. (§1 RI-2) |
| "WAL grows unbounded" | **Refuted** — WAL is bounded by `wal_autocheckpoint` + `closeDb()` TRUNCATE. (§3 cross-ref) |
| "Sklearn fallback uses different hyperparameters — bug" | **Intentional** (sklearn lacks early-stopping equiv) but **undocumented** — tracked as ML-M1. (§2) |
| "Bootstrap-restore wizard appears in remote mode — orphaned restore risk" | **Acceptable** — license prompt fires before mode is established; wizard restores into local cache only. Tracked as awareness item, not a bug. (§4) |
| "`_invClockIsRemote()` returns false is a stub bug (UI-R1)" | **Refuted 2026-05-28** — intentional v2.10.x design. `_proxyClockSyncInRemote` at `server/index.js:13401` forwards all clock-sync writes to gateway transparently. Comment block above the stub explains this. (§4 NEW-R1) |
| "`_v210IsRemoteMode()` returns false is a stub bug (UI-R2)" | **Refuted 2026-05-28** — intentional v2.10.x design. `_proxyStopReasonsInRemote` (`server/index.js:16149`) and `_proxySerialInRemote` (`server/index.js:16478`, 7 wire points) forward all Stop Reasons and Serial Number writes to gateway. Comment block above the stub explains this. (§4 NEW-R2) |
| "`ARCHIVE_DB_CACHE` is unbounded (F-C1 Critical)" | **Refuted 2026-05-28** — LRU eviction was implemented in commit `b2665f5` (v2.11.0-beta.5). `ARCHIVE_DB_CACHE_MAX_ENTRIES = 6` at `server/db.js:125`, `evictLruArchiveEntries()` at `:4154-4182`, LRU touch on hit at `:4188-4202`, telemetry at `:4205-4214`. The original audit reviewer did not check the same file beyond line 115. (§1) |
| "`_delegate_run_dayahead()` lacks try/except (F-M1 Major)" | **Refuted 2026-05-28** — try/except already wraps the call at `services/forecast_engine.py:11791-11812`. Both auto-loop (lines 11941-11963) and CLI path (lines 11293-11320) fall back to `run_dayahead(..., write_audit=True)` which writes a `forecast_run_audit` row with descriptive `audit_generator_mode` ("auto_service_fallback" / "manual_cli_fallback"). Operator sees Node failures via the audit row, not just logs. (§1) |
| "Training matrix is 235 MB; can OOM on edge hardware (ML-M2 Major)" | **Refuted 2026-05-28** — audit assumed `N_TRAIN_DAYS = 180`, actual value at `services/forecast_engine.py:267` is **45**. Real footprint ≈ 45 × 288 × 72 × 8 bytes ≈ **7.5 MB**. The 235 MB figure was off by ~30×. No memory pressure at current configuration. (§2) |
| "2026-05-18 shutdown-marker fix is in working tree but uncommitted (BR-M4 Medium)" | **Refuted 2026-05-28** — already committed in `49406b1` ("Notification UX revamp + bundled WIP snapshot") and is in `origin/main`. The memory `project_shutdown_marker_fallback.md` "no git commit" note was stale (it predated the commit). (§3) |
| "`_reliability_fallback_notified` guard suppresses sklearn-fallback warning (ML-M1)" | **Refuted 2026-05-28** — confusion of subsystems. `_reliability_fallback_notified` is a module-scope set at line 67 for **Solcast reliability artifact dimension** fallbacks (used at `:4983-4989`), not for the **ML backend** sklearn vs LightGBM fallback. Different code paths. ML backend visibility is already surfaced via `_detect_ml_backend_detail()` at `:7418-7441` (returns `backend`, `lightgbm_available`, `lightgbm_enabled_by_env`, `reason`) and consumed in `/api/forecast/engine-health`. (§2) |

### 5.6 Final verdict

**2026-05-28 re-audit verdict: SHIP — no pre-release blockers.**

After operator-driven verification on 2026-05-28, the four subsystems together earn a **9.0 / 10 weighted construction score** and an **8.3 / 10 performance score**. The headline finding of the re-audit: **6 of 8 initial "blocker" items (F-C1, F-M1, ML-M2, UI-R1, UI-R2, BR-M4) turned out to be audit false positives** — either already-shipped work the original audit reviewer missed, or claims based on incorrect premises (e.g., wrong `N_TRAIN_DAYS`, confused subsystem identification, missed comment blocks).

Real fixes applied this session: **2** small items totaling ~15 minutes of code change:
- **UI-R3** — `checkBootIntegrityBanner()` reworded so remote-mode operators see "Local viewer cache" framing with explicit "Plant data on the gateway is unaffected" note (3 message branches: unrescuable, restored, unexpected; one suffix tweak on windows-initiated).
- **ML-M1 (doc)** — inline comment added above `_make_residual_regressor()` explaining sklearn-vs-LightGBM hyperparameter divergence rationale (no early-stopping equivalent in sklearn GBR → smaller n_estimators + shallower max_depth).

The forecast / ML / backup math itself is sound. The remaining backlog items are all Medium-and-below operational hygiene improvements (cloud-upload retry, mutex queue timeout, accessibility nits, doc drift). The audit found **no security regressions, no data-loss vectors, and no compliance issues**.

**Cross-reference:** The 2026-05-11 DB read-write health memo (`audits/2026-05-11/db-read-write-health.md`) RI-2 finding on `ARCHIVE_DB_CACHE` was likewise already closed by commit `b2665f5`. Both memos can be marked as resolved.

**Audit methodology note for future passes:** Reviewer should verify each "missing implementation" claim by reading the cited file + running `git log -S "<symbol>"` before flagging as a bug. The original audit's FP rate (75% on pre-release blockers) was caused by reviewing summaries instead of code. Future audits should require a `git log` citation alongside each Critical/Major finding to demonstrate the reviewer verified the issue against current `origin/main`, not a stale snapshot.

---

*Section-level updates should be made in-place; superseding findings should reference the section number + item ID (e.g., "F-C1") so the action-item table stays the canonical follow-up list.*

---

## §6 Implementation pass (2026-05-29)

All open backlog action items from §1–§4 were implemented or verified on
2026-05-29. The originally-cited Critical/Major items were already refuted as
audit FPs in the re-audit (see §5.5); this pass closes the remaining
Medium / Minor / Doc / Test items. **No git commit performed** (operator
reviews each commit by hand). Validation: full `npm run smoke` (Node-ABI
rebuild → Node tests → pytest → Electron-ABI restore) + standalone unit runs.

### 6.1 Forecast Engine (§1)

| Item | Sev | Resolution | File |
|---|---|---|---|
| F-Mi1 | Minor | **Verified already-handled** — NULL `forecast_mw` is coerced to `0.0` at the loader (`services/forecast_engine.py:4211`), so NaN cannot propagate. The audit's :9788/:10517 line refs were stale (file evolved); consolidation into one typed validator was judged cosmetic-only against a 12k-line hot path and intentionally not churned. | `forecast_engine.py:4193-4211` |
| F-FA1 | Minor | **Verified already-satisfied** — snapshot-age messages are already `log.debug` (not `warning`) at `:10167` / `:10171`, so they do not spam on intra-day regen. | `forecast_engine.py:10167-10171` |
| F-FA2 | Minor | **Verified already-satisfied** — the NaN/Inf residual check at `:10782` already logs **once per run** with an aggregate `nan_count`, not per slot. | `forecast_engine.py:10782-10787` |
| F-D1 | Doc | **DONE** — "Provider Fallback: Mean-Blend 100%" subsection added documenting `override_to_mean_blend_100`. | `references/forecast-engine.md` |
| F-D2 | Doc | **DONE** — error-memory recency/regime gate documented in `compute_error_memory()` docstring. | `forecast_engine.py:5817-5845` |
| F-D3 | Doc | **DONE** — FEATURE_COLS updated to 72 with tri-band + locked-snapshot enumeration. | `references/forecast-engine.md:185-195` |
| F-T1 | Test | **DONE** — `_computeSpreadPctCap()` edge-case unit test (dawn/dusk denominator, `plantCapMw<=0`, non-finite inputs, inverted band). | `server/tests/dayAheadSpreadCap.test.js` (new) |
| F-T2 | Test | **DONE** — `override_to_mean_blend_100` signal-handling test. | `services/tests/test_forecast_engine_audit_fixes.py` (new) |

### 6.2 ML Training (§2)

| Item | Sev | Resolution | File |
|---|---|---|---|
| ML-Me3 | Medium | **DONE** — `REGIME_MODEL_MIN_DAYS_TRANSITION = 3` + `_detect_regime_transition()` relax the regime-model day floor (real gate is 6 days at `:8050`, not "50 slots" — audit paraphrase) during dry→monsoon transitions; 320-sample quality floor left intact. Monsoon-onset regression test added. | `forecast_engine.py:300-306, 7944-8067` |
| ML-Mi4 | Minor | **DONE** — `CAP_DISPATCH_TOLERANCE = 0.97` extracted as named constant + `curtailed_mask()` default. | `forecast_engine.py:2890-2895` |
| ML-Mi5 | Minor | **DONE** — legacy-model feature truncation made atomic (temp-build + try/except rollback to original feature set on failure). | `forecast_engine.py` `_align_bundle_features()` |
| ML-FA3 | Minor | **DONE** — `backend_fallback` moved from `data_warnings` to a new `status_flags` block in `ml_train_state.json` (expected behavior, not a quality warning). | `forecast_engine.py:597-603, 7488-7543` |
| ML-FA4 | Minor | **Verified N/A** — no `stale_features` 12h warning exists in current code; staleness uses a 30-day `error_memory_stale` gate. Audit FA-4 described a CLAUDE.md field, not a live warning. | `forecast_engine.py:7513-7533` |
| ML-D1 | Doc | **DONE** — same FEATURE_COLS 72 doc fix as F-D3. | `references/forecast-engine.md:185-195` |
| ML-T1 | Test | **DONE** — regime-transition + sklearn-vs-LightGBM backend tests (20-test suite). | `services/tests/test_forecast_engine_audit_fixes.py` (new) |

### 6.3 Backup / Restore (§3)

| Item | Sev | Resolution | File |
|---|---|---|---|
| BR-M1 | Medium | **DONE** — `_retryWithBackoff()` (3 retries, 1s base, 30s cap, full jitter) + `_isTransientUploadError()` classifier wrap each provider upload in `uploadToCloud()`; retry count folded into the single `tier3` health-registry record (no double-count). The 5-min deferred queue remains the outer fallback. | `server/cloudBackup.js` |
| BR-M2 | Medium | **DONE (warning, not force-abort)** — `_withBackupMutex` now arms a `BACKUP_OP_WATCHDOG_MS` (10 min) watchdog that warns loudly + records `_lastSlowOp` on overrun. Not a forced abort: with every cloud request now timeout-bounded (BR-M3) an op cannot hang the queue forever, and force-aborting mid-flight would break the serial guarantee. | `server/cloudBackup.js:_withBackupMutex` |
| BR-M3 | Medium | **DONE** — S3 client gets `NodeHttpHandler` connection(15s)+request(120s idle) timeouts; OneDrive/GDrive get a module-local `fetch` wrapper injecting node-fetch v2's `timeout` (120s) on every request. Bounds a true partition without killing slow-but-alive transfers. | `server/cloudProviders/{s3,onedrive,gdrive}.js` |
| BR-Mi1 | Minor | **DONE** — pre-backup `wal_checkpoint(PASSIVE)` + comment clarifying `db.backup()` (SQLite online-backup API) already yields a WAL-consistent snapshot, so no separate `-wal`/`-shm` files are needed. | `server/cloudBackup.js:createLocalBackup` |
| BR-Mi2 | Minor | **DONE** — startup integrity probe opens read-only with a 2s busy `timeout` so a lock-contended DB fails fast instead of blocking on the ~5s default. (A Promise timeout is N/A — better-sqlite3 `quick_check` is synchronous and CPU-bound on file size, not hangable.) | `server/db.js:_probeDbIntegritySync` |
| BR-Mi3 | Minor | **DONE / already-wired** — `_checkCompatibility()` already gates restore on schema + appVersion across all 3 restore paths; added explicit `backupFormatVersion` manifest field + format-version gate with a clear message. | `server/cloudBackup.js` |
| BR-Mi4 | Doc | **DONE** — "Supported Platforms" matrix (Win10/11 21H2+, x64; Windows-only by design) added to CLAUDE.md + SKILL.md. | `CLAUDE.md`, `SKILL.md` |
| BR-D1 | Doc | **DONE** — 2026-05-18 shutdown-marker fallback + explicit `/api/health/db-integrity` `mode` field documented in CLAUDE.md power-loss section. | `CLAUDE.md` |
| BR-D2 | Doc | **DONE** — promise-chain mutex semantics comment added to `_withBackupMutex` (no-deadlock / no-starvation explanation). | `server/cloudBackup.js` |
| BR-T1 | Test | **DONE** — resilience test: transient classification, retry count + non-transient short-circuit + retry exhaustion, mutex strict-serialisation + failure-does-not-stall-queue. | `server/tests/cloudBackupResilience.test.js` (new) |

### 6.4 Local Backup UI (§4)

| Item | Sev | Resolution | File |
|---|---|---|---|
| UI-R4 | Medium | **DONE** — WS `backup_health` handler guarded with `isLocalBackupRemoteGated()` (no DOM mutation in remote mode). | `public/js/app.js` |
| UI-R5 | Medium | **DONE** — `applyCBSettingsRemoteGating()` disables all cloud-settings inputs in remote mode + save-failure toast now says "Not available in remote mode". | `public/js/app.js` |
| UI-R6 | Medium | **DONE** — server keeps `gatewayOnly`/`mode`; `renderBackupHealth()` consumes them as a render gate (handles both direct WS snapshot and wrapped REST response). | `public/js/app.js`, `server/index.js` |
| UI-R7 | Medium | **DONE (renderer-side)** — `applyLocalBackupModeVisibility()` now re-fires on every WS (re)connect (`ws.onopen`), covering the loading-screen mode-picker → server-restart → WS-reconnect path without an Electron change. | `public/js/app.js:ws.onopen` |
| UI-R8 | Minor | **DONE** — bootstrap-restore stepper gets `role="progressbar"` + `aria-valuenow/min/max` + per-dot `aria-label`. | `public/bootstrap-restore.{html,js}` |
| UI-R9 | Minor | **DONE** — `.cb-health-unknown` contrast raised to `var(--text)` (WCAG AA across themes). | `public/css/style.css` |
| UI-R10 | Minor | **DONE** — descriptive `aria-label`s on Import/Export buttons. | `public/index.html` |
| UI-R11 | Minor | **DONE** — explicit `mode` field added to `/api/health/db-integrity`; banner suppresses on `mode==="skipped"` before the 4-condition gate (backward-compatible when field absent). | `server/index.js`, `public/js/app.js` |
| UI-R12 | Nit | **DONE** — `saveLocalBackupSchedule()` disables the button during POST (try/finally restore). | `public/js/app.js` |
| UI-R13 | Nit | **Already done** — license-prompt button already carries the ellipsis ("Restore from Backup…"). | `electron/main.js:3582,3617` |

### 6.5 Validation

- **Python:** `python -m pytest services/tests/` → **514 passed** (includes the new 20-test audit-fix suite; FEATURE_COLS=72 tripwire intact).
- **Node:** new `cloudBackupResilience.test.js` PASS standalone; full Node suite via `npm run smoke`.
- **Smoke:** `npm run smoke` (Node-ABI rebuild → all `server/tests/*.test.js` → pytest → **mandatory Electron-ABI restore**) — see session log for the final pass/fail summary.
- All edited JS files pass `node --check`.

### 6.6 Items deliberately NOT changed (verified resolved, not churned)

`F-Mi1`, `F-FA1`, `F-FA2`, `ML-FA4` — current code already satisfies the
concern (stale audit line refs); forcing a refactor would add hot-path
regression risk for no correctness gain. `UI-R13` — already shipped. All other
open items implemented above.
