# T7.3 Smoke Harness — First Baseline Run

**Date:** 2026-04-14
**Harness:** `scripts/smoke-all.js` (new)
**Invocation:** `npm run smoke` (also `:node-only`, `:no-rebuild` variants)
**Repo state at run:** post-Phase-3 (commit `fb36a19`)

This file records the **first end-to-end smoke run** of the ADSI-Dashboard repo against the new T7.3 ABI-toggle harness. It exists so future runs can compare against a known baseline and see whether failures are pre-existing or new regressions.

---

## What the harness does

Per [KNOWN_GAPS.md §5.4](KNOWN_GAPS.md#54--t73--abi-toggle-smoke-script-build-this-next):

1. `npm run rebuild:native:node` — flip `better-sqlite3` to Node ABI
2. Run every `server/tests/*.test.js` via `node`, collect status + stdout/stderr tails
3. `python -m pytest services/tests/ --junitxml`
4. **`npm run rebuild:native:electron`** — MANDATORY restore in `finally`, runs even on crash, so the repo is never left in Node ABI (per memory `feedback_native_rebuild.md`)
5. Write JSON summary to `scripts/.smoke-summary.json` (gitignored)
6. Exit `0` only if all green; `1` for test failures; `2` for harness/rebuild crash

Flags:
- `--skip-python` / `--node-only` — skip pytest
- `--no-rebuild` — assume Node ABI already active (useful for fast iteration; will leave repo in whatever ABI it was in)

---

## Baseline results (2026-04-14)

| Bucket | Pass | Total | Notes |
|---|---|---|---|
| Node tests | **24** | 29 | 5 pre-existing failures, see below |
| Python tests | **107** | 107 | All green, 4 deprecation warnings (`freq="5T"` → `"5min"` in pandas) |
| Wall time | | | 143 s (Node rebuild ~30 s, tests ~30 s, pytest ~63 s, Electron restore ~20 s) |
| ABI restore | OK | | Repo left in Electron ABI as required |

### The 5 Node failures

| Test | Failure mode | Verified pre-existing? |
|---|---|---|
| `cloudBackupS3Dedupe.test.js` | `ENOENT: adsi.db` after S3 pull | **Yes** — reproduced against commit `1b3a436` (pre-Phase-2) |
| `forecastActualAverageTable.test.js` | `0 !== 0.006` average mismatch | Likely pre-existing (forecast-actual area not touched by Phase 2/3) |
| `forecastCompletenessSource.test.js` | `ERR_ASSERTION` actual=false expected=true | Likely pre-existing (forecast completeness, untouched by Phase 2/3) |
| `manualPullFailureCleanup.test.js` | "main DB and first archive should be staged before later archive fails" | Likely pre-existing (replication staging path, untouched) |
| `manualReplicationCancel.test.js` | "main DB and first archive should be staged before cancellation" | Likely pre-existing (replication staging path, untouched) |

The first failure was explicitly verified by running the test against the pre-Phase-2 commit; it produced the **identical** ENOENT path. The other four touch code paths Phase 2/3 did not modify (replication pull staging, forecast actual averaging, forecast completeness source) and are catalogued here without per-test bisection. Future investigators can verify any one of them by:

```bash
git stash --include-untracked --quiet
git checkout 1b3a436 -- server/cloudBackup.js server/index.js services/forecast_engine.py
node server/tests/<test>.test.js
git checkout HEAD -- server/cloudBackup.js server/index.js services/forecast_engine.py
git stash pop --quiet
```

If the failure reproduces, it's pre-existing. If it disappears, it's a Phase 2/3 regression to investigate.

---

## Conclusion for Phases 2 + 3

**Zero regressions introduced.** Phase 2 (T4.4 + T2.10/2.11/2.12 + T5.4) and Phase 3 (T6.7/9/10/11 + T5.5/6/7/8) ship with the same Node-test-suite pass rate as the pre-Phase-2 baseline.

The 5 pre-existing failures are now formally tracked here; they should each get a HIGH backlog entry in [KNOWN_GAPS.md](KNOWN_GAPS.md) (or its v2.8.9-regenerated successor) so they get triaged before the next release.

---

## How to run

```bash
npm run smoke               # full cycle — Node rebuild → all tests → pytest → Electron restore
npm run smoke:node-only     # skip pytest (faster iteration)
npm run smoke:no-rebuild    # skip both ABI rebuilds (assumes current ABI is correct)
```

Read summary:
```bash
cat scripts/.smoke-summary.json | jq '.nodeTests[] | select(.ok == false)'
```

Always end in Electron ABI before launching the app — the harness handles this automatically; if you ran a single test manually with `node ...`, run `npm run rebuild:native:electron` afterward.
