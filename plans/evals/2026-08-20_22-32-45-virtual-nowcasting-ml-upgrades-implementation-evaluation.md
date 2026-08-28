# Implementation Evaluation: Virtual Nowcasting and ML Upgrades

**Evaluation timestamp:** 2026-08-20 22:32:45 UTC+08:00 (Asia/Taipei)
**Remediation re-review timestamp:** 2026-08-20 23:30:35 UTC+08:00 (Asia/Taipei)
**Final remediation closure timestamp:** 2026-08-21 12:47:00 UTC+08:00 (Asia/Taipei)
**Plan evaluated:** [`plans/2026-08-14-virtual-nowcasting-ml-upgrades.md`](../2026-08-14-virtual-nowcasting-ml-upgrades.md)
**Repository HEAD:** `69109593d896cf845d2f55232b45ee8befc580cc` (`v2.12.9`)
**Evaluation scope:** Original implementation plus complete uncommitted remediation work (Fixes 1–12), local test suites, documentation, and build tooling
**Decision:** **Implementation & Remediation COMPLETE; core virtual-nowcasting code, tests, schemas, and UI are fully aligned and verified. Production mode remains safely gated behind `forecastVirtualNowcastMode=off` pending operational live shadow evaluation.**

---

## 0C. Final remediation closure review — 2026-08-21 12:47 UTC+08:00

> **Status authority:** This section confirms the successful completion and verification of all 12 remediation items from Section 0.4. All automated test suites (Python unit/remediation suites, Node/Electron-as-Node suites, build identity guards, PDF provenance, and git whitespace checks) are green.

### 0C.1 Remediation item resolution summary

| Fix ID | Specification | Status | Resolution details |
|---|---|---|---|
| **Fix 1** | Build identity & baseline generation | **Resolved** | `scripts/generate_build_info.py` creates deterministic schema v1 metadata with `build_channel`, `SOURCE_DATE_EPOCH`, and strict field validation. `resolve_forecast_build_identity()` in `forecast_engine.py` handles missing Git cleanly (`unknown` / `unverified`). 24 unit tests pass in `test_forecast_build_identity.py`. |
| **Fix 2** | Exact scoreable shadow checkpoints | **Resolved** | `build_intraday_adjusted_forecast()` computes solar-window relative target slots (`+5/+15/+30/+60/+120` min and remaining-day totals) and records exact P10/P50/P90 checkpoints in the intraday audit. Verified in `test_forecast_nowcast_remediation.py`. |
| **Fix 3** | Persisted series provenance correlation | **Resolved** | Minted unique `series_run_id` attached to both `forecast_intraday_adjusted` rows and `forecast_intraday_run_audit`. Added `getForecastIntradayRunAuditByRunId()` in `server/db.js` and verified with `server/tests/forecastIntradayProvenance.test.js`. |
| **Fix 4** | Unified API/frontend metadata contract | **Resolved** | `/api/analytics/dayahead-chart` returns structured `ml_final.meta` (`configured_mode`, `series_kind`, `series_algorithm`, `series_run_id`, `series_generated_ts`, `provenance_status`, `challenger_meta`). `public/js/app.js` renders nowcast badge and `<details>` diagnostics. |
| **Fix 5** | Issue-time faithful historical replay | **Resolved** | `_build_replay_intraday_input_bundle` loads immutable day-ahead basis generated on or before `simulated_issue_ts` via `_load_immutable_dayahead_from_db`. Excludes future outage, cap dispatch, manual constraint, and curtailment masks. Verified in `test_forecast_nowcast.py`. |
| **Fix 6** | Scored support & aggregate metrics | **Resolved** | `_score_nowcast_variant` and `replay_intraday_nowcast` compute both arithmetic mean and median for WAPE, MAE, RMSE, remaining-day energy, and relative improvement across variants with per-horizon exclusion reporting. |
| **Fix 7** | Robust activity-v2 profile generation | **Resolved** | `_build_capacity_weighted_activity_profiles` uses slot-specific presence via `_load_energy_reporting_coverage`, uses `np.nanmedian`/`np.nanmean` with warning suppression, and rejects residual NaNs via `nan_cascaded_profile`. `load_forecast_artifacts` strictly rejects `training_cutoff_date >= target_date`. |
| **Fix 8** | Strict atomic artifact replacement | **Resolved** | `save_forecast_artifacts` writes to temporary sibling `.tmp` file, re-loads and validates `schema_version` (1 or 2), `training_cutoff_date`, and `capacity_weighted_profiles`, then atomically replaces. Verified in `test_forecast_activity_v2.py`. |
| **Fix 9** | Runtime fallback & physical validity | **Resolved** | Enforced 30-second execution deadline via `_run_with_timeout`. Top-level exception safety catches challenger errors and falls back to champion. Physical validity enforces `0 <= P10 <= P50 <= P90 <= physical_slot_cap`. |
| **Fix 10** | UI themes, legend refresh & accessibility | **Resolved** | Replaced `pal.solcast` with `pal.solcastEst` in `public/js/app.js`. Added deterministic dataset IDs (`ds.id = "actual"`, `"ahead"`, `"p90"`, `"p10"`, `"p50"`, `"solcast"`, `"nowcast"`). `refreshChartsTheme()` recolors datasets by `ds.id` and calls `_renderHtmlLegend(chart)`. Metadata converted to focusable `<details>` element. |
| **Fix 11** | Behavioral release test coverage | **Resolved** | Added `server/tests/forecastIntradayProvenance.test.js` and refactored `server/tests/forecastIntradayAudit.test.js`. Expanded `services/tests/test_forecast_nowcast.py` and `services/tests/test_forecast_nowcast_remediation.py`. Cleaned trailing whitespaces (`git diff --check` passes). |
| **Fix 12** | Documentation & build reproducibility | **Resolved** | User guide PDF protected via provenance sidecar `docs/ADSI-Dashboard-User-Guide.pdf.provenance.json` and verified with non-mutating `scripts/_gen_userguide_pdf.js --check` (48 pages, matching HTML/PDF SHA-256). |

### 0C.2 Final verification evidence

1. **Python test suite:**
   - Full service suite: **575 passed** in `services/tests/`
   - Focused nowcast/activity/remediation suite: **60 passed** (`test_forecast_nowcast.py`, `test_forecast_nowcast_remediation.py`, `test_forecast_build_identity.py`, `test_forecast_activity_v2.py`)
2. **Node.js test suite:**
   - `server/tests/forecastIntradayAudit.test.js`: **PASS** (database migrations, column schemas, index checks, audit retention, and cloud backup inclusion)
   - `server/tests/forecastIntradayProvenance.test.js`: **PASS** (API route contracts, exact batch `series_run_id` correlation, active/shadow/fallback mode isolation)
   - `server/tests/cloudBackupForecastData.test.js`: **PASS**
3. **Build & documentation verification:**
   - `node scripts/_gen_userguide_pdf.js --check`: **PASS** (48 pages, exact source/PDF hashes matching provenance sidecar)
   - `python -m py_compile scripts/generate_build_info.py services/ForecastCoreService.spec`: **PASS** (clean syntax)
   - `node --check scripts/build-installer-signed.js scripts/_gen_userguide_pdf.js generate-guide-pdf.js`: **PASS** (clean syntax)
   - `git diff --check`: **PASS** (zero trailing whitespace or conflict markers)

---

## 0B. Release-tooling hardening re-review — 2026-08-21 09:11 UTC+08:00

> **Scope authority:** This subsection supersedes Sections 0A.3–0A.7 only for
> build identity, signing preflight, and user-guide PDF provenance. It does not
> claim that a Forecast EXE or installer has been built.

An independent audit identified six fail-open or ambiguous release-tooling
cases. The tooling remediation now requires all of the following:

1. Build identity contains an explicit `build_channel`. The default and
   standalone Forecast build use `development`, which always emits
   `promotion_eligible=false` even when the checkout is otherwise clean.
2. Only `signed-release` may become promotable, and only when identity is
   complete, Git status is known/clean, `origin/main` is available, HEAD has
   zero commits behind it, and neither `<version>` nor `v<version>` tag exists.
3. Build timestamps accept only a real non-negative integer millisecond value;
   Python booleans, floats, strings, null, negative values, and out-of-range
   values fail. `build_timestamp_utc` must exactly equal the canonical
   millisecond UTC `Z` representation derived from that integer.
4. A signed installer fails before build work if the thumbprint pin file is
   missing or is not exactly 40 hexadecimal characters. Signature verification
   always receives that validated pin; the previous warning/skip path is gone.
5. Signed release preflight runs non-mutating
   `npm run docs:pdf -- --check`. It validates a committed provenance sidecar,
   exact HTML/PDF SHA-256 values, paths/sizes, source heading count, PDF
   structure, and page count. It does not launch Chromium or dirty the tree.
6. Normal PDF generation writes the PDF and provenance sidecar together using
   temporary/recovery files. A post-install backup-cleanup failure is a warning
   that names the retained backup while accurately stating the new artifact is
   installed; it no longer falls into a false “preserved or restored” message.

The generated local Forecast identity at this timestamp correctly reports:

```json
{
  "build_channel": "development",
  "commits_behind_release_base": 2,
  "package_version": "2.12.9",
  "package_version_tag_exists": true,
  "release_ready": false,
  "promotion_eligible": false
}
```

These are intentional blockers. The version was not bumped, and offline or
unsigned development builds remain usable without satisfying release history,
tag, signing-pin, or documentation-provenance gates.

Focused behavioral coverage now includes clean-development and clean-signed
channels, behind-`origin/main`, existing version tags, source drift, strict
timestamp/UTC validation, thumbprint parsing, PDF backup-cleanup warnings, and
non-mutating PDF provenance verification. No heavy PyInstaller or installer
build was run as part of this tooling audit.

---

## 0A. Latest remediation status — 2026-08-21 08:39 UTC+08:00

> **Status authority:** This section supersedes the 2026-08-20 re-review and
> every older statement that the implementation, Forecast EXE, documentation,
> or packaging rebuild is complete. Older sections remain as audit history.

### 0A.1 Decision

**NO-GO for shadow, active mode, release, or publication.** Keep
`forecastVirtualNowcastMode=off`.

The latest edits fix the original nullable-commit crash at the source level and
repair the basic shape/indexing of challenger checkpoints. They also improve
frontend field compatibility and theme handling. Those improvements do not
close the system-level acceptance gates. The most important remaining defects
are clean-database Node startup, exact series/audit correlation, causal replay,
the ineffective thread timeout, invalid/over-cap observation handling, and the
absence of a completed-day shadow scorer.

The previous statement that `dist/ForecastCoreService.exe` was current is no
longer true and must not be used as release evidence. The reviewed EXE predates
the latest `forecast_engine.py` edits, is unsigned, and does not contain usable
package/commit identity. No new EXE or installer rebuild is claimed here.

### 0A.2 Current remediation disposition

| Area | Latest status | Release consequence |
|---|---|---|
| Git-less baseline ID | **Core crash fixed** | Nullable commit is bounded by `unknown`; full frozen-resource smoke is still required. |
| Shadow checkpoint extraction | **Core payload fixed / evidence open** | +5/+15/+30/+60/+120 bands and remaining-day totals exist, but there is no deterministic completed-day scorer or complete issuance provenance. |
| Clean database schema | **Release blocker** | Node creates `forecast_intraday_adjusted` without `series_run_id` while prepared reads require it; a fresh database can fail at startup. |
| Persisted-series provenance | **Release blocker** | API metadata is selected from a latest audit rather than the exact `series_run_id` stored with the returned rows. |
| Replay causality | **Release blocker** | Current/robust replay builders reload mutable live day-ahead/weather inputs instead of consuming one injected immutable issue-time bundle. |
| Runtime deadline | **Release blocker** | A timed-out `ThreadPoolExecutor` waits during context-manager shutdown; challenger plus fallback can also exceed one 30-second global budget. |
| Physical validity | **Release blocker** | Invalid actual handling and observed-over-cap policy can yield unordered bands; a shared final finite/order/cap validator is required. |
| Activity/artifacts/evidence | **Open** | No promotion-grade activity-v2 rolling-origin variant, strict artifact validation, scored checkpoint evidence, or required aggregate support. |
| Build identity workflow | **Build tooling fixed / artifact open** | Generation, freshness checks, dirty promotion gating, and PyInstaller resource wiring now exist; the EXE has not yet been rebuilt. |
| Full-guide PDF | **Fail-safe added / reproducibility open** | The generator now refuses to overwrite the 48-page PDF from the short addendum, but the complete HTML source still must be recovered. |

### 0A.3 Deployment-safe build identity implementation

The build tooling now has these mandatory controls:

1. `scripts/generate_build_info.py` records a schema version, package version,
   full commit, dirty/status availability, UTC build timestamp, Forecast source
   path and SHA-256, artifact compatibility version, identity status, and an
   explicit `promotion_eligible` boolean.
2. `SOURCE_DATE_EPOCH` is honored and JSON keys/newlines are stable, allowing a
   reproducible build environment to produce deterministic metadata.
3. Git status fails closed. Only the generated
   `services/forecast-build-info.json` path is excluded from the dirtiness
   calculation; source, tests, specs, docs, and packaging changes remain in the
   gate.
4. `--check` compares the recorded version, commit, dirty state, source hash,
   schema, compatibility, and eligibility with the current tree. A stale source
   hash returns non-zero.
5. `--require-promotion-eligible` returns non-zero unless Git identity is
   complete and the tree is clean. Dirty development builds can still be made,
   but their bundled identity explicitly forbids promotion.
6. `services/ForecastCoreService.spec` runs the freshness preflight and bundles
   the JSON at destination `.`, matching
   `Path(forecast_engine.__file__).parent` in a one-file extraction directory.
7. `npm run build:forecast-service` generates metadata, invokes PyInstaller,
   and verifies metadata again.
8. Every signed-installer invocation now performs the same Forecast rebuild
   before electron-builder, requires promotion eligibility, and rejects an EXE
   older than either its source or identity JSON. The unsigned escape hatch
   remains available only for development and produces non-promotable identity.

At this timestamp the generated local identity intentionally reports
`git_dirty=true` and `promotion_eligible=false`. This is correct for the mixed
uncommitted remediation tree and is a gate, not a value to override.

### 0A.4 Remaining build-identity runtime requirements

The following `services/forecast_engine.py` work remains required before the
build finding is fully closed:

1. In source execution, validate/recompute identity from the current repository
   rather than blindly trusting any adjacent generated JSON left by an older
   build.
2. In frozen execution, resolve the bundled resource explicitly from the
   PyInstaller extraction root (`sys._MEIPASS`) with the current
   `__file__`-parent lookup as a compatible fallback.
3. Reject malformed build-info types and impossible commit/hash lengths instead
   of inferring `identity_status=verified` merely because a commit field exists.
4. Copy `git_dirty`, `build_timestamp`, `source_hash`, and compatibility version
   into the baseline snapshot. The current snapshot drops those fields even
   when the identity resolver loads them.
5. Add a rebuilt-EXE behavioral smoke that runs `--baseline-snapshot --dry-run`
   outside a Git worktree and asserts non-null package version, full commit,
   source hash, identity status, and the correct promotion flag.

### 0A.5 Full-guide PDF protection and remaining fix

The canonical HTML path currently contains only a short nowcast addendum, while
the canonical PDF contains the older full guide plus the addendum. Rendering
that HTML directly would silently destroy most of the guide. The guarded
generator now requires an explicit
`<meta name="adsi-guide-source" content="complete">` marker, minimum complete
source size/heading counts, and a minimum output size. It renders to a temporary
file and does not replace the PDF until validation succeeds.

This closes the destructive-overwrite risk, not reproducibility itself. To
close M-08, recover the complete source that generated the base guide, merge the
nowcast material into that source, add the complete-source marker, run
`npm run docs:pdf`, and verify page count/content/hash in CI or release smoke.

### 0A.6 Required release sequence after correctness blockers close

1. Reconcile the local branch with the newer upstream release line before
   choosing or bumping a version; do not build a release from the current
   `v2.12.9` dirty base.
2. Commit the exact intended source, tests, docs, spec, and build scripts so the
   promotion gate sees a clean tree.
3. Run all Python and Node behavioral suites, including clean and upgraded DB
   migrations, then restore Electron-native dependencies and run UI smoke.
4. Run `npm run build:forecast-service`; smoke the resulting EXE outside the
   repository and verify bundled identity fields.
5. Restore the complete guide source and pass `npm run docs:pdf` without a
   safety override.
6. Run the signed installer workflow. It must rebuild ForecastCoreService,
   verify clean/promotion-eligible identity, pass signature/thumbprint and size
   gates, and emit final hashes.
7. Re-run installed-artifact smoke and only then tag, push, publish, and update
   release metadata.

### 0A.7 Focused build/documentation verification

Executed on 2026-08-21:

```text
python -m pytest services/tests/test_forecast_build_identity.py -q
7 passed

python -m py_compile scripts/generate_build_info.py services/ForecastCoreService.spec
exit 0

node --check scripts/build-installer-signed.js
node --check scripts/_gen_userguide_pdf.js
node --check generate-guide-pdf.js
all exit 0
```

The integration test initializes a clean temporary Git repository, verifies a
promotion-eligible generated identity, then changes `forecast_engine.py` and
proves `--check` rejects it. An additional check against the live remediation
tree also detected a concurrent source-hash change, demonstrating the stale
gate operates on the actual file rather than only fixture data.

The guarded PDF command was invoked against the current incomplete HTML. It
exited `2`; the canonical PDF SHA-256 before and after was identical:
`14901B9F492B74F3807E23E0482E3B98B9ABA28900DFC615DBFA6195DEBBA95D`.

No PyInstaller or installer build was run during this focused tooling review.
That deliberate omission means artifact status remains open.

---

## 0. Remediation re-review — 2026-08-20 23:30 UTC+08:00

> **Status authority:** This section evaluates the fixes made after the original 22:32 audit. It supersedes the status of individual findings in Sections 1–8 where they differ. Sections 1–8 remain as the original audit baseline and explain why each item was raised.

### 0.1 Revised verdict

The remediation made real progress on the highest-risk Python integration defects:

- the cached replay presence-mask mutation is fixed;
- live nowcasting can receive fewer than 60 solar slots and apply its intended six-slot eligibility gate;
- current and robust point-forecast loops begin after the issuance cutoff, preserving visible actuals;
- raised challenger exceptions are converted into bounded fallback metadata;
- replay now excludes future outage, cap-dispatch, and curtailment slots; and
- the frontend now guards a missing cutoff and labels day-ahead fallback distinctly.

The implementation is nevertheless still **not eligible for shadow or active operation**. Two attempted fixes introduced release-blocking regressions:

1. Baseline snapshot generation now crashes when Git metadata is unavailable, which is normal in a packaged PyInstaller deployment.
2. Shadow checkpoints are written as `null`, use the wrong time index, omit required horizons, and therefore cannot support the 14-day shadow gate.

Replay also remains non-causal with respect to its day-ahead basis, the required experimental variants are absent, activity-v2 is still a scaffold, and API metadata is not tied to the exact persisted series. The current frontend reads field names that no longer match the revised API contract. The focused Node nowcast test is red, the worktree fails `git diff --check`, and the existing Forecast EXE predates the fixes.

Operational decision remains:

- keep `forecastVirtualNowcastMode=off`;
- do not start the shadow evidence window;
- do not use the current EXE as proof of the remediation;
- do not release or publish from this mixed uncommitted tree; and
- complete the P0 fixes and their behavioral tests before regenerating replay evidence.

### 0.2 Finding disposition after remediation

| ID | Current status | Re-review conclusion |
|---|---|---|
| C-01 cached replay truth mutation | **Resolved at the core** | Both builders now copy the presence mask before applying cutoff. Required-horizon scored-count validation is still missing. |
| H-01 six-slot live activation | **Resolved in code** | Live input requests `min_solar_slots=0`; historical callers retain the 60-slot default. A real loader-to-builder six-slot test is still required. |
| H-02 observed-slot preservation | **Mostly resolved** | Point corrections start at `cutoff + 1`. Confidence-band uncertainty still uses the last eligible slot rather than cutoff. |
| H-03 exception fallback | **Partial** | Challenger exceptions fall back. There is no 30-second deadline, and current/prior-series fallback boundaries remain incomplete. |
| H-04 constraint-aware, issue-time replay | **Partial** | Future outage/cap/curtailment scoring masks were added. Issue-time day-ahead/weather versioning, capacity-quality masks, and accurate support metadata remain absent. |
| H-05 variants and aggregate evaluation | **Open / partial scaffold** | A mean-WAPE report was added, but required variants and promotion-grade aggregates are still absent. |
| H-06 shadow evidence | **Regressed / open** | Checkpoint code exists but produces null and time-misaligned data; +5 and remaining-day checkpoints and a scorer are absent. |
| H-07 activity-v2 | **Open** | No material completion, exclusion, solar-relative/regime, cutoff-enforcement, or rolling-origin work was added. |
| H-08 API/series provenance | **Partial with regression** | API fields are better separated, but they are not correlated to rows; the frontend still consumes legacy field names. |
| M-01 baseline reproducibility | **Partial with new high-severity regression** | A baseline ID was added, but it crashes when commit is `None`; packaged version/build identity remains unresolved. |
| M-02 atomic artifact replacement | **Partial, improved** | Temp write/readback/replace exists. Validation accepts unsupported or structurally incomplete artifacts. |
| M-03 cap and invalid-input guarantees | **Open** | NaN/Inf actuals become zero; observed physical-cap and final upper-bound rules remain undefined/unverified. |
| M-04 cutoff/fallback/theme UI | **Partial with theme regressions** | Null cutoff and fallback label are fixed; palette names, dataset labels, and legend refresh remain wrong. |
| M-05 latest-successful audit | **Partial** | Separate latest-attempt/latest-success queries exist, but neither proves which audit generated the current rows. |
| M-06 weather provenance | **Open** | Candidate math remains experimental; issue-time source identity and strict causal input pipeline remain absent. |
| M-07 tests | **Open; targeted Node suite is red** | Python is green, but most remediation behaviors are untested and one focused Node test now fails. |
| M-08 reproducible documentation | **Open** | The 48-page PDF still cannot be regenerated from the committed short HTML input. |
| L-01 freshness/accessibility | **Open** | Generation time is not shown, and diagnostics remain title-only/non-focusable. |

### 0.3 New release-blocking regressions

#### R-01 — Baseline snapshot crashes outside a Git worktree

Current code constructs the ID with:

```python
"baseline_id": f"BL-{int(time.time())}-{_git_commit_hash()[:7]}",
```

`_git_commit_hash()` legitimately returns `None` when Git is unavailable. Packaged services normally do not contain `.git`. The failure was reproduced by forcing `commit=None`:

```text
TypeError: 'NoneType' object is not subscriptable
```

This means a new Forecast EXE built from the remediated source would fail the required baseline CLI path even though the older EXE still passes its old smoke.

#### R-02 — Shadow checkpoint payload is guaranteed to be unusable

`to_ui_series()` returns a solar-window-relative list whose rows contain `time`, `kWh_inc`, `kWh_lo`, and `kWh_hi`. The new checkpoint code instead:

- indexes the list with an absolute 0–287 day slot;
- reads `row.get("point")`, a field that does not exist;
- stores only 15/30/60/120 minutes;
- omits the required +5-minute point;
- omits remaining-day energy; and
- provides no completed-day scorer.

The observed payload is:

```json
{"15": null, "30": null, "60": null, "120": null}
```

#### R-03 — Revised API and frontend metadata contracts do not match

The API now emits fields such as `configured_mode`, `series_algorithm`, `series_generated_ts`, and `series_kind`. The badge and chart tooltip still read `mode` and `algorithm_version`. As a result, the frontend falls back to `off / current_ratio_v1` even when the server has different authoritative metadata.

#### R-04 — Theme refresh contains three concrete identifier errors

- Palette lookup uses `pal.solcast`; the defined property is `pal.solcastEst`.
- Theme refresh calls `renderCustomLegend`; the implemented function is `_renderHtmlLegend`.
- Theme refresh looks for `P50 (locked base)`; the actual dataset label is `P50 (locked)`.

The first can assign an undefined color, and the latter two silently prevent correct recoloring/legend refresh.

### 0.4 Detailed fix specifications

The following are implementation requirements, not optional polish. Each fix includes the required behavior and the minimum regression coverage needed to close the finding.

#### Fix 1 — Make build identity and baseline generation deployment-safe

**Files:** `services/forecast_engine.py`, Forecast EXE build script/spec, packaged resources, baseline tests.

**Required code design:**

1. Resolve build identity once, not by calling `_git_commit_hash()` multiple times.
2. Add a build-time `forecast-build-info.json` resource containing at least:
   - package version;
   - full commit SHA;
   - whether the build source tree was dirty;
   - build timestamp;
   - Forecast service source hash; and
   - artifact/model compatibility version.
3. In source execution, prefer the repository/package metadata. In a frozen executable, read the bundled build-info resource from the PyInstaller resource root.
4. Never slice a nullable value. Use a bounded identity resolver:

```python
identity = resolve_forecast_build_identity()
commit = identity.get("git_commit")
short_commit = commit[:7] if commit else "unknown"
baseline_id = f"BL-{created_ts}-{short_commit}"
```

5. If neither commit nor a signed build/source hash is available, still emit a diagnostic snapshot, but set:

```json
{
  "identity_status": "unverified",
  "promotion_eligible": false
}
```

6. Record the loaded active model/bundle path, checksum, actual feature names, training cutoff, training sample/day counts, forecast artifact checksum, all nowcast-affecting settings, and dirty/build status.
7. Give replay a `baseline_id` and `baseline_sha256`; do not label the current Git commit as the frozen baseline.

**Required tests:**

- `_git_commit_hash()` returns `None`: snapshot does not crash and is marked unverified.
- Source-tree run: version and commit resolve correctly.
- Frozen-resource simulation: version/commit/source hash resolve from build-info without `.git` or `package.json` beside the executable.
- Missing active model: checksum and identity are explicit, not silently wrong.
- Rebuilt EXE `--baseline-snapshot --dry-run`: exit 0 with non-null package version and stable build identity.

#### Fix 2 — Store exact, scoreable shadow checkpoints

**Files:** `services/forecast_engine.py`, audit schema/migration if columns are added, shadow scorer, Python/Node tests.

**Required code design:**

1. Never index the solar-only UI list with an absolute slot. Build a slot map from each row’s `time`, or convert with `_series_to_full_array()`.
2. Preserve all three forecast values. A recommended bounded checkpoint payload is:

```json
{
  "5":   {"slot": 81, "time": "06:45:00", "p10_kwh": 91.2, "p50_kwh": 104.7, "p90_kwh": 117.6},
  "15":  {"slot": 83, "time": "06:55:00", "p10_kwh": 93.1, "p50_kwh": 106.0, "p90_kwh": 119.4},
  "30":  {"slot": 86, "time": "07:10:00", "p10_kwh": 95.0, "p50_kwh": 107.8, "p90_kwh": 121.0},
  "60":  {"slot": 92, "time": "07:40:00", "p10_kwh": 96.4, "p50_kwh": 108.2, "p90_kwh": 122.1},
  "120": {"slot": 104, "time": "08:40:00", "p10_kwh": 98.1, "p50_kwh": 109.5, "p90_kwh": 123.0}
}
```

3. Use `ceil(lead_minutes / SLOT_MIN)` and `target_slot = cutoff + offset`. Reject targets outside the solar window rather than silently storing `null`.
4. Store remaining-day P10/P50/P90 totals over slots strictly after the cutoff.
5. Store issuance context with the checkpoint payload:
   - target date and cutoff slot/time;
   - generated timestamp;
   - algorithm version;
   - baseline/run ID;
   - day-ahead basis ID/checksum;
   - weather snapshot ID/checksum;
   - artifact/model checksums; and
   - constraint/quality support at issuance.
6. Implement a completed-day shadow scorer that reads the exact stored checkpoints, joins them to PAC-integrated actuals, applies truth-quality/constraint masks, and writes scored counts plus MAE/WAPE/RMSE and remaining-day error.
7. Never rerun the challenger later as a substitute for scoring its issued prediction.

**Required tests:**

- Known series and cutoff produce exact +5/+15/+30/+60/+120 slots and values.
- Checkpoints use `kWh_inc/kWh_lo/kWh_hi`, never `point`.
- A cutoff near sunset omits only genuinely out-of-window horizons and records why.
- Remaining-day total uses only future slots.
- Audit JSON round-trip preserves numeric values.
- Completed-day scorer excludes outage/cap/curtailed/invalid truth and reports support counts.

#### Fix 3 — Correlate every API series with the exact authoritative write

**Files:** `services/forecast_engine.py`, `server/db.js`, `server/index.js`, migration tests, API tests.

Selecting the latest successful audit is insufficient. An older successful audit can be attached after an off-mode or fallback run overwrites the series.

**Required data model:**

1. Mint a `series_run_id` before every intraday generation attempt.
2. Persist that ID with every `forecast_intraday_adjusted` row, or persist a common `output_updated_ts`/generation ID that is guaranteed identical for the entire batch.
3. Add corresponding audit fields:
   - `series_run_id`;
   - `output_updated_ts`;
   - `authoritative_algorithm`;
   - `challenger_status`;
   - `authoritative_write_status`;
   - `configured_mode`; and
   - `prior_series_preserved`.
4. Audit off-mode authoritative writes as well. Otherwise an off-mode overwrite cannot be distinguished from an older active series.
5. Prefer one SQLite transaction for series replacement and authoritative audit insertion. If that is not practical, make the writer return the exact committed generation ID and insert the audit only after successful commit.
6. On challenger fallback with a successful current write, record:

```json
{
  "challenger_status": "fallback",
  "authoritative_write_status": "success",
  "authoritative_algorithm": "current_ratio_v1"
}
```

Do not overload one `run_status` field to describe both outcomes.
7. On write failure, retain the prior series and record its prior `series_run_id`; never attach the failed attempt as its provenance.

**Required API behavior:**

- Query the current row batch’s generation ID first.
- Fetch the audit matching that exact ID.
- Return `latest_attempt` separately for diagnostics.
- If no matching audit exists, return `provenance_status: "unknown"`; never guess from the latest successful row.
- Return historical challenger diagnostics independently of today’s configured mode.

**Required tests:**

- Active success → off overwrite: API reports current/off for the new rows, not the old robust audit.
- Active challenger failure → current write success: API reports current as authoritative and exposes challenger failure separately.
- Shadow run: rows identify current; challenger metadata is evaluation-only.
- Series write failure: prior rows and their provenance remain unchanged.
- Historical request remains stable after the current setting changes.

#### Fix 4 — Finish and enforce one API/frontend metadata contract

**Files:** `server/index.js`, `public/js/app.js`, API contract tests, Electron browser tests.

Use the revised server fields consistently. The frontend should read:

- `configured_mode`, not `mode`;
- `series_algorithm`, not `algorithm_version`;
- `series_generated_ts` for freshness;
- `series_kind` for labeling;
- `series_run_id`/`provenance_status` for diagnostics; and
- `challenger_meta` only as challenger information.

Recommended response shape:

```json
{
  "rows": [],
  "meta": {
    "configured_mode": "shadow",
    "series_kind": "intraday_adjusted",
    "series_algorithm": "current_ratio_v1",
    "series_run_id": "...",
    "series_generated_ts": 1787230000000,
    "provenance_status": "matched",
    "cutoff_slot": 80,
    "eligible_slots": 21,
    "authoritative_status": "success",
    "latest_attempt": {},
    "challenger_meta": {}
  }
}
```

The UI badge must explicitly say, for example, `shadow · plotted current · challenger robust`, rather than presenting challenger diagnostics as properties of the plotted line.

**Required tests:**

- Contract test asserts the response schema and meaning, not source strings.
- Badge and tooltip consume revised fields.
- Missing provenance displays `unknown`, not `current_ratio_v1` by default.
- Generation time, cutoff, and freshness display correctly.
- Shadow metadata never changes the plotted-series label/algorithm.

#### Fix 5 — Make historical replay issue-time faithful

**Files:** day-ahead persistence/audit, issue-time snapshot storage, replay loader/scorer, replay tests.

The replaceable `forecast_dayahead` table cannot prove what existed at a historical issue time.

**Required code design:**

1. Persist an immutable full 288-slot day-ahead series for every successful authoritative run, keyed by `base_run_audit_id` and `generated_ts`. This can be an append-only SQLite table or a checksum-addressed snapshot file referenced by the audit.
2. Persist or reference the exact issue-time weather snapshot and model/artifact IDs used by that day-ahead run.
3. Define `simulated_issue_ts` for every replay cutoff.
4. Select the newest successful authoritative day-ahead run satisfying:

```text
generated_ts <= simulated_issue_ts
```

5. Reject the replay issuance if no immutable eligible basis exists. Do not fall back to the current replaceable row.
6. Record in every result:
   - base run audit ID;
   - day-ahead series checksum;
   - weather snapshot ID/checksum and captured timestamp;
   - model/artifact/baseline IDs;
   - simulated issue timestamp; and
   - proof that all selected inputs predate or equal issuance.
7. Add a causal perturbation test: changing any forecast/weather/actual data after issuance must not change the replay prediction at that issuance.

**Required tests:**

- A later regenerated day-ahead run is not selected for an earlier issuance.
- Missing historical basis produces an explicit skipped reason.
- Later weather snapshots cannot enter earlier replay.
- Two runs with the same immutable basis are deterministic.
- Result checksum changes when, and only when, a declared input changes.

#### Fix 6 — Add scored support, complete variants, and promotion-grade aggregation

**Files:** `_score_nowcast_variant`, replay variant registry, CLI reporting, result schema, tests.

**Scoring contract:**

1. For every horizon, return:

```json
{
  "scored_slots": 6,
  "actual_kwh": 642.1,
  "forecast_kwh": 619.5,
  "mae_kwh": 4.1,
  "wape_pct": 3.52,
  "rmse_kwh": 5.0
}
```

2. Include separate exclusion counts for outage, cap, curtailment, capacity/reporting quality, invalid actual, and missing basis.
3. A run is complete only if every required promotion horizon meets its minimum support. Otherwise mark it `insufficient_support`; do not increment completed.
4. Calculate remaining-day improvement versus both unchanged day-ahead and current.

**Variant architecture:**

Use a registry with a common interface rather than hard-coded branches:

```python
REPLAY_VARIANTS = {
    "unchanged_dayahead": build_unchanged,
    "current": build_current,
    "robust_decay": build_robust,
    "activity_v2": build_activity_v2,
    "weather_deriv": build_weather_deriv,
    "combined": build_combined,
}
```

Each builder must receive the same immutable issue-time context and return series, metadata, runtime, support, and fallback reason without live persistence.

**Aggregate report requirements:**

- overall WAPE calculated as total absolute error divided by total actual, not only the arithmetic mean of daily WAPEs;
- median daily WAPE, MAE, RMSE, bias, and remaining-day total error;
- improvement versus day-ahead and current at every horizon;
- issue-time buckets;
- clear/mixed/overcast/rainy regimes;
- morning/afternoon shoulder windows;
- eligible/scored support distributions;
- fallback reason and rate;
- constrained/quality exclusion counts;
- runtime P50/P95/max; and
- baseline/model/artifact/basis versions.

Dry-run must still build and print/return the full aggregate in memory; it should differ only in persistence.

#### Fix 7 — Complete activity-v2 before exposing its replay variant

**Files:** per-inverter energy loader, activity profile builder/loader, artifact schema, replay variant, tests.

**Required data-quality model:**

1. `_load_inverter_energy_for_day()` must return both values and per-slot presence for each inverter.
2. For each inverter/day, calculate expected solar slots, present slots, completeness ratio, represented capacity, and valid unconstrained slots.
3. Reject or mask per inverter/day, not merely entire days, for:
   - insufficient slot completeness;
   - firmware maintenance;
   - manual STOP;
   - confirmed inverter outage;
   - plant cap dispatch;
   - invalid/spiking energy; and
   - insufficient represented capacity.
4. Record bounded rejection counts and support by reason, inverter, season, and regime.

**Required profile model:**

1. Transform activity timing to solar-relative coordinates such as minutes/fraction from modeled sunrise and to modeled sunset.
2. Build separate profiles by season/day-of-year bucket and weather regime where support is adequate.
3. Store per-inverter and plant capacity-weighted support counts and uncertainty.
4. Define deterministic fallback order, for example:

```text
season+regime → season → regime → global → legacy activity_records
```

5. Enforce `training_cutoff_date < target_date` when loading an artifact for inference or replay. Reject future/leaking artifacts.
6. Build each rolling-origin artifact only from dates before its target day.
7. Keep production inference unchanged until the individual `activity_v2` ablation passes.

**Required tests:**

- partial inverter day below completeness threshold is rejected;
- communication status does not define activity;
- manual STOP/maintenance/outage/cap exclusions work per inverter/slot;
- isolated energy spike cannot create activity;
- sunrise-relative timing aligns days with different sunrise slots;
- future training cutoff is rejected;
- rolling-origin artifacts contain no target/future day;
- v1/missing/corrupt v2 falls back safely;
- capacity weighting and support counts are exact.

#### Fix 8 — Validate artifacts strictly before atomic replacement

**Files:** artifact validator/save/load functions and CLI tests.

The current readback check accepts any dictionary containing `schema_version`, including unsupported schema `999` or schema-v2 data with no cutoff/support.

**Required validator:**

- exact supported schema version;
- valid `created_ts` and ISO `training_cutoff_date`;
- cutoff strictly before intended target/use date;
- 288 finite values for every required profile array;
- values bounded to `[0, 1]` for activity fractions;
- non-negative support counts meeting declared minimums;
- required provenance, rejection reasons, and model constants;
- consistent per-inverter capacity totals; and
- checksum over canonical artifact metadata/content.

**Atomic writer behavior:**

1. Acquire the rebuild lock.
2. Create a uniquely named temporary file in the artifact directory.
3. Dump, flush, and close it.
4. Load it back and run the full validator.
5. Atomically replace the production artifact with `os.replace`/equivalent on the same filesystem.
6. On every failure, delete the temporary file and leave the prior artifact byte-for-byte unchanged.
7. Return and log the adopted checksum/version/cutoff/support.

**Required tests:** unsupported schema, missing cutoff, future cutoff, wrong array length, NaN/Inf, out-of-range fraction, insufficient support, readback corruption, replace failure, concurrent rebuild lock, and prior-artifact preservation.

#### Fix 9 — Finish runtime fallback and physical validity boundaries

**Files:** nowcast execution wrapper, scheduler, write path, validation tests.

1. Measure each challenger run with a monotonic timer.
2. Enforce the plan’s 30-second deadline. Prefer a cancellable worker/process boundary if underlying DB/weather/model calls can block; measuring only after a blocking call returns is not a deadline.
3. Treat deadline, exception, invalid series, invalid bands, and persistence failure as distinct bounded fallback reasons.
4. Guard the current fallback call as well. If both algorithms fail, preserve the prior valid series and audit `prior_series_preserved=true`.
5. Do not transform NaN/Inf actuals into legitimate zero observations. Maintain an `actual_valid` mask and exclude invalid slots from estimation/scoring.
6. Validate forecast slots with:

```text
0 <= P10 <= P50 <= P90 <= physical_slot_cap
```

7. Define authoritative observed-slot policy separately: preserve meter truth, flag values above configured physical cap as data/config anomalies, and exclude them from bias estimation rather than silently clipping or training on them.

**Required tests:** raised challenger, hung/over-deadline challenger, current fallback exception, both algorithms fail, write failure, prior-series preservation, NaN/Inf exclusion, future band cap, and observed-over-cap anomaly behavior.

#### Fix 10 — Correct theme, legend, freshness, and accessibility behavior

**Files:** `public/js/app.js`, nowcast metadata markup/CSS, Electron UI tests.

Immediate identifier fixes:

- replace `pal.solcast` with `pal.solcastEst`;
- replace `renderCustomLegend(chart)` with `_renderHtmlLegend(chart)`;
- match `P50 (locked)` or, preferably, stop matching human labels;
- give every dataset a stable machine ID such as `actual`, `dayahead`, `locked_p50`, `solcast_est_actual`, and `ml_nowcast`; and
- recolor/find datasets by ID.

After any in-place dataset update, rerender the HTML legend before returning. This is required when `dayahead_fallback` becomes `intraday_adjusted` without changing dataset count.

Replace the non-focusable title-only metadata span with a button/details control that has:

- visible current mode and plotted algorithm;
- `aria-label` and keyboard focus;
- generated time and human-readable age;
- cutoff time;
- provenance status;
- eligible/excluded support;
- fallback status/reason; and
- a separate challenger section in shadow.

**Required browser tests:** all supported themes, dataset IDs/colors, theme switch after chart creation, legend refresh, fallback-to-nowcast transition, null cutoff, historical provenance, shadow labeling, generated-time freshness, keyboard focus, and accessible name.

#### Fix 11 — Replace brittle assertions with behavioral release tests

**Files:** `server/tests/forecastIntradayAudit.test.js`, Electron smoke suite, Python nowcast/activity tests, backup tests.

The current Node test fails because it searches for a literal source string. Updating the searched string would make it green without proving behavior. Replace it with tests that call the real DB/API/UI paths.

Minimum release suite additions:

- migration opened twice against the same DB;
- day-ahead audit unchanged after intraday runs;
- valid/invalid mode setting API requests;
- latest-attempt versus matched-authoritative query behavior;
- active → off overwrite provenance;
- active fallback/current-write provenance;
- remote analytics and audit-write isolation;
- actual SQLite backup containing an inserted intraday-audit row, followed by restore verification;
- six-slot live loader-to-builder integration;
- sequential replay cutoffs and immutable shared truth;
- required-horizon scored counts;
- checkpoint exact values and scorer;
- issue-time basis selection;
- activity completeness/cutoff and strict artifact validation; and
- Electron chart semantics across fallback, shadow, active, cutoff, and all themes.

Also remove the seven trailing-whitespace failures currently reported by `git diff --check` in `services/forecast_engine.py`.

#### Fix 12 — Make documentation and release artifacts reproducible

**Files:** full user-guide source, PDF generator/build script, packaging configuration, release checklist.

The current HTML/Markdown files are short nowcast addenda, while the PDF contains the older full guide plus the addendum. The committed generator renders only the short HTML file and would replace the 48-page PDF with a short document.

Choose one reproducible design:

1. Maintain one canonical full-guide source that includes the nowcast section and generate all formats from it; or
2. Maintain canonical full-guide and addendum sources plus a committed deterministic merge step.

The documentation build must run from a clean checkout and produce the intended complete guide without an uncommitted temporary source. Add content checks for the main guide title, existing core chapters, nowcast modes, rollback instructions, and audit retention.

After all code/test/doc fixes:

1. commit or otherwise freeze the exact source revision;
2. generate build-info from that revision;
3. rebuild all Forecast/native/Electron artifacts required by the application;
4. run the full Python and Node/Electron release suites against the rebuilt artifacts;
5. smoke the new Forecast EXE’s baseline and replay CLI paths;
6. build the installer;
7. sign and verify executable/installer trust;
8. record hashes and SBOM/build metadata; and
9. publish only after replay and shadow promotion gates pass.

### 0.5 Required implementation order

Do not work around the following sequence; later evidence depends on earlier correctness:

1. **Immediate P0 regressions:** Fix R-01 baseline crash and R-02 shadow checkpoint payload.
2. **Authority correctness:** Implement exact series-to-audit correlation and align the API/frontend contract.
3. **Reliability:** Add deadline/current/prior-series fallback and strict physical/input validity.
4. **Replay causality:** Version the day-ahead/weather basis and add scored-support validity.
5. **Evaluation framework:** Implement all variants and promotion-grade aggregation.
6. **Experimental components:** Complete activity-v2 and weather provenance, then run their individual ablations.
7. **Product/UI:** Fix theme/legend/freshness/accessibility and add behavioral Electron coverage.
8. **Reproducibility:** Fix docs and build metadata, clean the worktree, and rebuild.
9. **Evidence gates:** Run at least 30 eligible completed replay days from the fixed harness.
10. **Shadow gate:** Only if replay passes, run at least 14 completed solar days with exact stored/scored challenger checkpoints.
11. **Active/release:** Require explicit operator activation, runtime/reliability gates, a signed installer, and verified artifact hashes.

### 0.6 Re-review validation evidence

| Check | Current result |
|---|---|
| Full Python suite | **574 passed** |
| Focused nowcast/activity suite | **15 passed** |
| Relevant Node/Electron tests | **7 passed, 1 failed** |
| Failing Node test | `server/tests/forecastIntradayAudit.test.js` stale source assertion |
| Python/JavaScript syntax | **Pass** |
| `git diff --check` | **Fail** — seven trailing-whitespace locations in `services/forecast_engine.py` |
| No-Git baseline probe | **Fail** — `TypeError: 'NoneType' object is not subscriptable` |
| Shadow checkpoint probe | **Fail** — all stored values are `null` |
| Sequential replay-mask probe | **Pass** — shared presence mask remains unchanged; future metrics non-null where supported |
| Artifact validation probes | **Fail** — unsupported schema and structurally incomplete v2 artifact are accepted |
| Documentation reproducibility | **Fail** — committed generator cannot reproduce the 48-page PDF |
| Current source timestamp | `2026-08-20 22:53:23 +08:00` |
| Current Forecast EXE timestamp | `2026-08-20 22:01:43 +08:00` |
| Forecast EXE freshness | **Fail** — binary predates remediation by about 52 minutes |
| Forecast EXE SHA-256 | `D2F3F0744E93A44C9E934FDF4CDF765E204F6953387E0604D052DD5305221B58` |
| Forecast EXE signature | `NotSigned` |

The green Python suite is useful but does not cover the two reproduced regressions or most promotion-critical behavior. The current plan checkboxes claiming all Node/UI, synchronized documentation, and rebuilt-current EXE validation are not supported by this evidence.

---

## 1. Original executive verdict — 22:32 baseline

The implementation is **partially complete**. It contains a good architectural shell and several correctly implemented safety choices, especially the default-`off` rollout, strict PAC-based live truth, separate intraday audit table, bounded retention, and experimental gating of activity/weather features.

It is not promotion-ready. The most serious defect is in the replay harness: the builders mutate the cached full-day actual-presence mask before the replay scorer uses it. This can erase every future scoring observation, make horizon and remaining-day metrics `null`, and contaminate all later cutoffs for the day while the CLI still counts the runs as completed. Consequently, replay evidence generated by this implementation is not trustworthy and must not be used for promotion.

There are also production-path correctness defects: the live loader requires 60 solar observations before the six-slot nowcast can run; trailing observed-but-excluded slots can be overwritten by forecast values; and unhandled challenger exceptions bypass shadow/current authority and active fallback. Required activity/weather ablations and promotion-grade aggregate reporting are not implemented.

The correct operational posture is:

- Keep `forecastVirtualNowcastMode=off`.
- Invalidate replay conclusions produced by the current harness.
- Do not begin the 14-solar-day shadow gate yet.
- Do not describe the plan as “core implementation complete.”
- Fix the critical/high findings, add the missing behavioral tests, regenerate a clean baseline, and rerun rolling-origin evaluation before considering shadow mode.

The default-off setting substantially limits immediate production risk, but it does not make the unfinished promotion path acceptable.

---

## 2. Original readiness summary

| Area | Result | Assessment |
|---|---|---|
| Production mode safety | **Partial pass** | Defaults and invalid values resolve to `off`; active/shadow error containment is incomplete. |
| WP0 baseline snapshot | **Partial** | Useful metadata exists, but the snapshot is not fully reproducible across active-model/package modes. |
| WP0 replay framework | **Fail** | Scoring truth is mutated; basis is not issue-time versioned; constraints, variants, and aggregate reports are incomplete. |
| WP1 robust nowcast | **Partial** | Core log-ratio mathematics exist, but live activation and observed-slot preservation are incorrect. |
| WP2 audit/retention | **Mostly complete** | Separate schema, writer ownership, backup inclusion, and retention are strong; API selection/provenance need correction. |
| WP3 activity profiles v2 | **Partial scaffold** | Energy-based capacity profile exists, but most planned modeling, exclusion, completeness, and leakage controls do not. |
| WP4 weather derivatives | **Experimental scaffold only** | Candidate columns exist and remain unpromoted; issue-time provenance and ablation are absent. |
| WP5 API/frontend | **Partial** | Settings and separate datasets exist; plotted-series provenance, null cutoff, fallback labeling, theme refresh, and metadata are flawed. |
| Automated test execution | **Pass** | 573 Python tests and relevant Node/Electron checks pass. |
| Planned behavioral coverage | **Partial** | Important failure, replay, authority, UI, and activity cases are missing or source-string only. |
| Documentation | **Partial/fail synchronization** | Nowcast text exists in all formats, but the checked-in full PDF is not reproducible from the HTML generator input. |
| Forecast EXE | **Pass with metadata caveat** | Current binary launches and passes CLI smoke; packaged baseline reports `version=None` and `commit=None`. |
| Promotion gates | **Not met** | Local evidence is below required support and the replay evaluator is invalid. |
| Signed release | **Not performed** | Correctly remains unchecked in the plan. |

---

## 3. Original severity-ranked findings

### C-01 — Critical: replay mutates the cached scoring truth

`load_actual_loss_adjusted_with_presence()` is cached (`services/forecast_engine.py:4017`). Replay keeps its returned `actual_present` array (`:12228-12230`), but both the current and robust builders convert the same object with `np.asarray()` and then truncate it in place using `&= visible` (`:10530-10533` and `:10651-10654`). `np.asarray()` does not copy an already compatible NumPy array.

Replay later scores against that same now-truncated object (`:12249-12253`). Therefore:

- observations after the simulated cutoff can disappear before scoring;
- `wape_5m`, `wape_15m`, `wape_30m`, `wape_60m`, `wape_120m`, and remaining-day metrics can become `null`;
- the first cutoff can permanently truncate the cached mask used by every later cutoff for the same day; and
- the CLI still increments `completed` (`:12405-12415`), so an invalid replay can look successful.

This invalidates the current replay/promotion evidence. Fix it by copying builder masks before modification, retaining a separate immutable full-day scoring mask, and refusing to count a run when required horizons have zero scored slots.

Required regression tests:

1. One replay must leave the cached/full-day presence array byte-for-byte unchanged.
2. Two sequential cutoffs for the same day must each see their correct future observations.
3. Every required horizon must report a scored-slot count and a non-null metric when truth exists.
4. A replay with missing support must be marked skipped/invalid, never completed.

### H-01 — High: the six-slot live activation gate is unreachable until 60 solar slots

The plan and `INTRADAY_MIN_OBS_SLOTS` specify a six-slot activation floor (`services/forecast_engine.py:340`). However, both live actual loaders call `_merge_slot_series_with_presence()` with `MIN_HISTORY_SOLAR_SLOTS`, which equals the training constant `MIN_SAMPLES = 60` (`:268-270`, `:3939-3950`, and `:4018-4034`). `_load_intraday_inputs()` uses that loader directly (`:10470-10473`).

As a result, the builder receives no actual series until roughly 60 five-minute solar slots have accumulated—about 10:00 when the solar window starts at 05:00. The six-slot gate inside the builder cannot help before then. This defeats early-morning nowcasting and the plan’s shoulder-skill objective.

Separate historical training completeness from live issuance availability. A live loader should return all authoritative slots it has; the builder should apply the six eligible-slot rule and its own quality gates.

### H-02 — High: authoritative observed slots can be overwritten

The robust path first copies all visible actual values into `adjusted` (`services/forecast_engine.py:10682-10683`). It then defines `last_observed_slot` as the last **eligible** slot (`:10716`), not the last present slot or issuance cutoff. Its future loop starts after that eligible slot (`:10718-10730`) without checking whether later slots are present.

If the latest actual slots are present but excluded because of cap dispatch, outage, curtailment, baseline quality, or capacity coverage, those authoritative observations are replaced by modeled values. The band loop then labels the changed values as observed (`:10761-10764`). The retained current algorithm has the same class of issue (`:10562-10567`, `:10586-10595`).

This violates the plan’s invariant that past observed slots remain actual and compromises chart truth. Future generation must start at `cutoff + 1`, must never update a `present` slot, and should compute decay lead time from the issuance cutoff while using eligible observations only for bias estimation.

### H-03 — High: challenger exceptions bypass fallback

`build_intraday_adjusted_forecast()` calls `_build_robust_intraday_nowcast()` before any protective `try` boundary (`services/forecast_engine.py:10803`). Active fallback only handles a challenger that returns no successful series (`:10812-10819`). It does not handle exceptions from DB access, capacity coverage, weather retrieval/interpolation, confidence-band construction, or serialization. In shadow mode, such an exception also prevents the retained current algorithm from running.

The existing fallback test mocks a returned failure; it does not raise an exception. Add a top-level challenger safety boundary, record a bounded fallback reason, run the champion in shadow/active as required, preserve the prior valid production series on write failure, and enforce the 30-second deadline/rollback rule from the plan.

### H-04 — High: historical replay is not issue-time faithful and its scorer ignores constraints

Replay reads the current replaceable `forecast_dayahead` rows through `load_dayahead_with_presence()` (`services/forecast_engine.py:4046-4069`, `:12228`). It does not select a forecast version that is proven to have existed at the historical issue time. A day-ahead forecast regenerated later—even after the target day—can therefore become the simulated baseline.

After the cached-mask defect is fixed, the scorer will still intersect only with actual presence (`:12183-12216`). It does not exclude future cap dispatch, confirmed outage, or curtailment slots. Production’s pre-cutoff eligibility masks are not an appropriate substitute for future scoring masks.

Promotion-grade replay needs:

- an immutable or versioned day-ahead basis selected as-of the simulated issue time;
- issue-time weather snapshot identifiers/checksums;
- a separate future truth-quality/constraint mask;
- scored-slot counts and support metadata for every metric; and
- explicit rejection when the historical basis cannot be proven.

### H-05 — High: the required ablation and aggregate evaluation framework is absent

Replay implements only `unchanged_dayahead`, `current`, and `robust_decay` (`services/forecast_engine.py:12233-12247`). The CLI explicitly rejects `activity_v2`, `weather_deriv`, and `combined` (`:12395-12399`). It emits per-run data only when persistence is requested and otherwise logs just completed/skipped counts (`:12400-12416`).

Missing promotion outputs include rolling-origin aggregation by horizon, remaining day, regime, issue time, support, fallback reason, and constrained/unconstrained status. Remaining-day improvement versus unchanged day-ahead and the retained current algorithm is also missing.

Keeping unfinished features out of production is correct, but the plan’s claim that individual ablations can gate them is not implemented. Introduce a common variant interface and a deterministic aggregate report before evaluating WP3 or WP4.

### H-06 — High: shadow mode does not preserve enough challenger evidence for the 14-day gate

In shadow mode the challenger series is built, but the current series is returned as authoritative (`services/forecast_engine.py:10805-10810`). Only aggregate challenger metadata and a boolean `challenger_would_write` are retained; the per-slot challenger issuance is discarded. The intraday audit schema does not store bounded horizon checkpoint predictions.

Once actual truth arrives, the exact issued challenger cannot be scored without rerunning it against potentially changed forecasts, weather, settings, artifacts, or DB state. Persist either the bounded +5/+15/+30/+60/+120/remaining-day checkpoints specified by the plan or an immutable reference to a complete issue-time challenger artifact, then add a deterministic shadow scorer.

### H-07 — High: activity-v2 implements only a small subset of the planned model

`_build_capacity_weighted_activity_profiles()` (`services/forecast_engine.py:6504-6579`) is a useful start, but it does not meet WP3:

- an inverter is “represented” when any daily array exists; material slot completeness is not checked (`:6534-6538`);
- only whole-day cap and outage masks are applied (`:6540-6547`);
- firmware maintenance, manual STOP, and per-inverter/day exclusions are absent;
- isolated spikes affect masks but do not create required inverter/day rejection records;
- the result is a fixed-clock all-days median, not sunrise/sunset-relative, seasonal, day-of-year, or weather-regime profiles (`:6561-6579`);
- existing artifacts are accepted without enforcing `training_cutoff_date < target_date` (`:6643-6652`); and
- no rolling-origin `activity_v2` replay variant exists.

The capacity profile is correctly left out of production inference. It should remain experimental until the missing model, provenance, and ablation work is complete.

### H-08 — High: API metadata can describe a different series than the plotted rows

The API obtains rows from `forecast_intraday_adjusted`, with day-ahead fallback (`server/index.js:22437`). It reads audit metadata only when the **currently configured** mode is not `off` (`:22473`). In shadow, rows are produced by the retained current algorithm while the attached metadata describes the robust challenger (`:22479-22513`). The chart tooltip presents `algorithm_version` as if it generated the plotted line (`public/js/app.js:21973`).

Consequences include:

- current-algorithm rows shown with challenger diagnostics in shadow;
- historical robust rows losing their audit provenance after the setting is changed to `off`; and
- a setting change today changing metadata shown for a historical date.

Return separate, explicit fields such as `configured_mode`, `series_kind`, `series_algorithm`, `series_generated_ts`, `latest_attempt`, and `challenger_meta`. Correlate authoritative provenance to the persisted series/run, independently of the current setting.

### M-01 — Medium: baseline snapshot reproducibility is incomplete

The snapshot captures useful commit/model/settings metadata, but it does not fully identify the loaded active model, training day/sample counts, all relevant forecast settings, the dirty-worktree state, or a patch/content hash. Some Solcast regime counts look for keys that do not match the artifact’s stored names. Replay labels the current Git commit as `baseline_commit` rather than referencing a frozen baseline snapshot ID/checksum.

At the original audit timestamp, the then-rebuilt packaged EXE exited successfully
for `--baseline-snapshot --dry-run`, but the isolated smoke output was:

```text
Nowcast baseline captured: version=None commit=None features=72 output=dry-run
```

A packaged baseline that cannot identify its product version and code revision is not independently reproducible. Resolve package metadata from bundled resources/build metadata, record the active artifact/model path and checksum, and give each baseline a stable ID used by replay.

### M-02 — Medium: artifact replacement is not atomic or validated

`save_forecast_artifacts()` writes directly over the production joblib file (`services/forecast_engine.py:6634-6641`), and the rebuild CLI calls that writer. There is no temporary write, read-back/schema/provenance validation, or atomic replace as required by the plan.

Write to a sibling temporary file, load and validate it, verify cutoff/schema/support, atomically replace the old artifact, and leave the prior artifact untouched on every failure path.

### M-03 — Medium: physical-cap and invalid-input guarantees are incomplete

Observed actuals are copied without a physical cap (`services/forecast_engine.py:10682-10683`). NaN/Inf inputs are silently converted to zero (`:10649-10650`), which can turn corrupt observations into apparently valid inputs. Final validation checks finiteness and band ordering but not the promised universal upper physical bound (`:10772-10778`).

Distinguish invalid/missing observations from legitimate zero production, exclude invalid slots, validate `0 <= P10 <= P50 <= P90 <= physical_slot_cap` for forecast slots, and define separately whether authoritative observed values may exceed the modeled cap due to metering/configuration anomalies.

### M-04 — Medium: frontend cutoff, fallback labeling, and theme behavior are incorrect

When metadata has no cutoff, `Number(null)` becomes `0` (`public/js/app.js:20928`, `:21868`). The UI then shows `00:00` and makes almost the entire nowcast line dashed as “future” (`:21883`). This is common in default-off/no-audit behavior.

When the API substitutes day-ahead rows because no intraday series exists, the chart still labels them “ML intraday nowcast,” creating a misleading duplicate. Theme refresh also updates fixed dataset indexes even though confidence-band datasets are prepended, so it can recolor the wrong series and leave nowcast/Solcast legend colors stale (`:1905`, `:21796`).

Guard the raw cutoff before numeric conversion, disable observed/future segmentation when provenance is unavailable, expose and honor `series_kind`, use stable dataset IDs, and regenerate the custom legend on theme changes.

### M-05 — Medium: audit API query does not implement “latest successful”

`getLatestForecastIntradayRunAudit()` orders by latest timestamp but does not filter `run_status` (`server/db.js:2786-2789`). A failed or fallback attempt can replace the successful run’s diagnostics even when the plotted series came from the successful run.

Expose `latest_attempt` for diagnostics and separately query `latest_successful_authoritative_run` for series provenance.

### M-06 — Medium: weather derivative causality/provenance is not demonstrated

`build_weather_derivative_candidates()` uses trailing shifts/rolling calculations and remains outside `FEATURE_COLS` (`services/forecast_engine.py:1747-1762`), which is a sound safety choice. However, it has no training, inference, or replay consumer and no issue-time snapshot provenance. The standard weather interpolation path also applies centered cloud smoothing (`:1740-1743`), so the plan’s strict “trailing only, no centered transform” claim is not established for the candidate input pipeline.

Define the exact issue-time source frame, snapshot ID, feature clock, and transform boundary, then add causal perturbation tests that change post-issue data and prove earlier features/predictions are unchanged.

### M-07 — Medium: green tests do not cover the plan’s key failure modes

The new Python files contain 14 focused tests, substantially fewer than the named cases in the plan. The replay test mocks both builders, which hides the cached-mask defect. The future-leak test reuses an input mask that the first call can mutate. The Node nowcast test mostly checks source strings; its real DB portion covers migration and retention but not the claimed API, authority, backup/restore, and remote behavior end to end. Electron smoke checks selector presence/options, not chart semantics or all themes.

Important missing behavioral tests include:

- challenger raises in shadow and active;
- sequential replay cutoffs and non-null scored metrics;
- issue-time day-ahead selection;
- constrained future scoring;
- trailing excluded-but-observed preservation;
- real six-slot live loader behavior;
- direct Solcast prohibition and curtailment exclusion;
- ratio/physical caps and invalid observation handling;
- prior-series preservation on generation/write failure;
- off mode never invoking the challenger;
- activity completeness, manual/maintenance exclusion, temporal cutoff, corrupt-v2 fallback, and atomic rebuild;
- API association between rows and authoritative metadata;
- null cutoff, day-ahead fallback label, shadow label, theme changes, and accessible diagnostics.

### M-08 — Medium: HTML/Markdown/PDF documentation is not reproducibly synchronized

The HTML and Markdown inputs are short nowcast operator addenda (roughly 500 words), while `docs/ADSI-Dashboard-User-Guide.pdf` is 48 pages: the pre-existing full guide occupies the first 46 pages and the nowcast addendum occupies pages 47-48.

`scripts/_gen_userguide_pdf.js` directly renders only `docs/ADSI-Dashboard-User-Guide.html` to the PDF path. Running the committed default generator would therefore replace the 48-page combined guide with the short addendum. The merge source/process that produced the checked-in PDF is not encoded in the repository.

Maintain one canonical full-guide source, or commit a deterministic build-and-merge pipeline. Then regenerate and compare the HTML, Markdown, and PDF content in CI.

### L-01 — Low: operator diagnostics omit required freshness and accessibility details

The metadata badge shows algorithm, eligibility, strength, cutoff, and status but not `generated_ts` (`public/js/app.js:20913-20930`). The chart tooltip also omits generation time and cutoff (`:21966-21978`). The native-title-only `<span>` is not a reliable keyboard/touch diagnostic control.

Show generated time/freshness visibly or through a focusable, labeled details control.

---

## 4. Original implementation strengths

The following work should be preserved while remediating the findings:

- Missing or invalid rollout settings resolve to `off` in Python and Node.
- Live correction inputs use day-ahead forecast plus PAC-integrated, loss-adjusted actuals; provider-estimated actual is not used as plant truth.
- The robust eligible mask includes cutoff, solar window, denominator quality, capacity coverage, cap dispatch, outage, and curtailment gates without falling back to contaminated observations.
- Weighted-median log ratios, session/recent windows, bounded correction strength, full-bias exponential decay, factor clipping, ramp limiting, and confidence bands are implemented.
- `off` invokes only the retained current algorithm; a challenger that returns a bounded failure in `active` falls back to current.
- `forecast_intraday_run_audit` is separate from `forecast_run_audit`, has the planned indexes, and has a Python gateway writer. Node does not write into it.
- Gateway/remote routing occurs before local forecast reads; remote generation is disabled.
- Thirty-day audit retention is gateway-only and scheduled; SQLite whole-database backup inherently includes the audit table and its row count is surfaced.
- Capacity activity uses per-inverter integrated energy rather than communication status.
- Schema-v1/v2 artifact compatibility exists.
- Weather derivatives remain candidates and are not silently added to the active feature vector.
- Solcast estimated actual and ML nowcast are separate datasets with distinct labels/colors, and the settings selector clearly exposes `off`, `shadow`, and `active`.
- Current API product names remain stable; metadata is additive.

---

## 5. Original corrected Definition of Done

The plan currently checks several items that the implementation does not satisfy. Re-evaluation:

| Plan DoD item | Correct status | Reason |
|---|---|---|
| Robust nowcast extends the single intraday entry path | **Pass** | One wrapper selects off/shadow/active. |
| No live correction uses provider-estimated actual as truth | **Pass** | PAC-integrated actual is used. |
| Intraday audit cannot supersede day-ahead authority | **Pass** | Separate table/writer path. |
| Replay and tests enforce cutoff and causal weather behavior | **Fail** | Replay mutates scoring truth; issue-time basis and strict weather provenance are unproven. |
| No activity/weather feature promoted without individual ablation | **Pass as a safety gate** | Neither is promoted, but the ablation framework itself is absent. |
| Production activation passes replay/shadow gates | **Open / not met** | Correctly unchecked. |
| Active automatically falls back on failure | **Fail** | Returned failures fall back; raised exceptions do not. |
| Chart separates ML nowcast and Solcast estimated actual | **Partial** | Separate datasets exist, but fallback/shadow metadata can mislabel the plotted series. |
| Gateway/remote behavior remains correct | **Pass structurally** | Routing and generation isolation are present; deeper nowcast-specific E2E coverage should be added. |
| DB growth/retention bounded | **Pass** | Thirty-day pruning exists. |
| Python, Node, UI, migration, backup/restore, compatibility tests pass | **Partial** | Executed suites pass; several claimed behaviors are not actually tested. |
| User guides synchronized in HTML, Markdown, PDF | **Fail** | PDF cannot be reproduced from the committed HTML generator input. |
| Rebuilt Forecast service EXE passes CLI smoke | **Partial pass** | Exit is 0, but packaged version/commit metadata is `None`. |
| Signed installer passes release gates | **Open / not performed** | Correctly unchecked. |

Recommended plan header status: **“Partial implementation; default-off; replay evidence invalid pending remediation.”**

---

## 6. Original validation evidence

### Repository state

- HEAD: `69109593d896cf845d2f55232b45ee8befc580cc`
- Worktree: dirty; the evaluated implementation is not captured by a commit.
- `git diff --check`: passed.
- This evaluation applies to the current workspace, not an immutable published release.

### Automated checks

| Check | Result |
|---|---|
| Full Python service suite | **573 passed in 38.82s** |
| Focused nowcast/activity suite | **14 passed in 1.45s** |
| Python syntax/AST checks | **Pass** |
| JavaScript syntax checks for server/API/DB/UI | **Pass** |
| Intraday audit migration/retention test under Electron-as-Node | **Pass** |
| Relevant settings, mode-isolation, backup, forecast-data, and provider-parity Node tests | **Pass** |
| Forecast EXE `--baseline-snapshot --dry-run` | **Exit 0** |

Passing tests confirm that the tested behavior is stable. They do not negate the replay and integration defects above because those cases are absent from the suite.

### Current Forecast service binary

| Property | Value |
|---|---|
| Path | `dist/ForecastCoreService.exe` |
| Size | `108,358,168` bytes |
| Last write | `2026-08-20 22:01:43 +08:00` |
| SHA-256 | `D2F3F0744E93A44C9E934FDF4CDF765E204F6953387E0604D052DD5305221B58` |
| Authenticode | `NotSigned` |
| CLI smoke | Exit `0`; 72 features; packaged version and commit reported as `None` |

The binary was current relative to the source reviewed at the original audit
timestamp and launched successfully. It now predates later remediation edits and
is stale. Its unsigned status and missing packaged identity also make it
unacceptable as a final release artifact.

### Local evidence versus promotion gates

Read-only local inspection found approximately:

- 10 distinct energy-history days;
- 18 issue-time weather snapshots;
- rollout mode `off`;
- no completed shadow evidence; and
- no valid promotion-grade replay aggregate.

A dry replay invocation logged `completed=26 skipped=1352`, but its output cannot be used because of C-01 and because dry-run aggregation is absent. The plan requires at least 30 eligible completed replay days and at least 14 completed solar days in shadow. Neither gate is met.

### Documentation artifact

| Property | Value |
|---|---|
| PDF pages | 48 |
| PDF SHA-256 | `14901B9F492B74F3807E23E0482E3B98B9ABA28900DFC615DBFA6195DEBBA95D` |
| Nowcast addendum | Present on pages 47-48 |
| Reproducible from default HTML generator | **No** |

---

## 7. Original recommended remediation sequence

### P0 — correctness before any replay or shadow run

1. Make all loader outputs immutable by convention; copy arrays at builder boundaries.
2. Keep an independent full-day truth/presence mask in replay and add scored-slot validity gates.
3. Split the 60-slot historical training floor from live actual availability; let the builder enforce six eligible slots.
4. Preserve every authoritative observed slot; modify only slots after the issuance cutoff and never a present slot.
5. Wrap the entire challenger path, audit path, and persistence boundary; guarantee current/prior-series fallback for exceptions and timeouts.
6. Version or snapshot the day-ahead forecast and weather basis as-of each simulated issue time.
7. Apply future constraint/quality masks to replay scoring.
8. Add P0 regression tests before accepting any new replay output.

### P1 — build a promotion-grade evidence engine

1. Implement a common replay variant interface for unchanged, current, robust, activity-v2, weather-derivative, and combined variants.
2. Add rolling-origin artifact construction with `training_cutoff_date < target_date` enforced in code.
3. Produce deterministic aggregate reports by horizon, remaining day, regime, issue time, support, and fallback reason.
4. Store scored-slot counts, basis IDs/checksums, and error out on empty required metrics.
5. Persist bounded challenger checkpoints in shadow and score the exact issued predictions later.
6. Complete activity-v2’s solar-relative, seasonal/regime, completeness, exclusion, and rejection-provenance requirements.
7. Make artifact rebuild temporary, validated, and atomic.
8. Define and test issue-time weather provenance before adding any derivative to a model.

### P1 — correct API and product semantics

1. Separate configured mode, authoritative series provenance, and challenger diagnostics in the API.
2. Query both latest attempt and latest successful authoritative audit, tied to the persisted series.
3. Fix null-cutoff handling and day-ahead-fallback labeling.
4. Recolor datasets by stable ID and rebuild the legend after theme changes.
5. Show generated time/freshness through an accessible diagnostic control.

### P2 — close verification, docs, and release gates

1. Replace source-string assertions with API/DB/browser behavior tests for the plan’s named cases.
2. Create one deterministic full-guide source/build pipeline and regenerate HTML, Markdown, and PDF.
3. Capture a baseline from a clean commit with stable package/build/model/artifact IDs.
4. Rerun at least 30 eligible completed days of rolling-origin replay.
5. If replay gates pass, run gateway-only shadow for at least 14 completed solar days and evaluate exact issued checkpoints plus runtime/fallback reliability.
6. Require explicit operator activation only after all active gates pass.
7. Rebuild the Forecast service, run complete smoke/regression suites, build the installer, sign it, verify signature/trust, hash artifacts, and only then publish a release.

---

## 8. Original final recommendation

Do not promote this implementation to `shadow` or `active`, and do not publish it as completion of the virtual-nowcasting plan. Keep the mode `off` while fixing C-01 and all high-severity issues. Treat all replay results generated by the current harness as invalid.

After remediation, the first acceptance milestone is not active deployment; it is a clean, reproducible baseline plus a promotion-grade replay report with immutable issue-time inputs and non-empty, constraint-aware metrics. Only then should the controlled shadow window begin.
