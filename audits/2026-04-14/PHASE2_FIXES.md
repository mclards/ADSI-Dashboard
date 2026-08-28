# v2.8.8 → v2.8.9 Phase 2 Fix Log

**Date:** 2026-04-14
**Baseline:** v2.8.8 (commits `1d88c8e` → `b153d69`)
**Target:** v2.8.9 (package.json bump deferred — see "Pending" below)
**Session scope:** Close the highest-value open loops left by Phase 1.

This log is the counterpart to [FIXES_PROGRESS.md](FIXES_PROGRESS.md) (Phase 1, 23 CRITICAL) and companion to [KNOWN_GAPS.md](KNOWN_GAPS.md) (100-item backlog).

---

## Why this scope

The audit README directed two consumer paths for "what's left":
- Partial fixes in [KNOWN_GAPS.md §2](KNOWN_GAPS.md#2-partial--defence-in-depth-only-fixes-in-v288) — explicitly flagged "debugger should NOT treat as closed"
- Phase-2 HIGH backlog in [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan)

Parallel sub-agent sweeps were explicitly ruled out — [KNOWN_GAPS.md §5.3](KNOWN_GAPS.md#53-agent-orchestration-issues-that-hurt-the-sweep) documents concrete harm from the previous sweep (one agent overwrote the findings doc, one committed unprompted). This session was run single-threaded to keep provenance clean.

Chosen 6 fixes:
- **T4.4 (partial → closed)** — the loudest open loop: duplicate `forecast_run_audit` rows on Node/Python race.
- **T6.3 (verification)** — confirm the hardcoded thumbprint is not a silent auto-update bricker.
- **T2.10 / T2.11 / T2.12** — three small, co-located Node fixes (cloud-backup + go2rtc).
- **T5.4** — one small frontend fix (chart axis reset on theme change).

---

## Fix-by-fix

### T4.4 — Node-side advisory lock + delegation handshake

| | |
|---|---|
| Files | `server/forecastGenLock.js` (new), `server/index.js`, `services/forecast_engine.py` |
| Before | Python's `_delegate_run_dayahead` held the lock across the HTTP delegation. If Node outran Python's 180 s timeout, Python released → ran its own fallback → Node wrote its own audit row late. Two rows for the same `(target_date, variant)`. |
| After | Node acquires the lock in `/api/internal/forecast/generate-auto` for every requested date. Python NO LONGER holds the lock across delegation. If Node is still running when Python's HTTP times out, Node's lock is still present, so Python's direct-fallback path (which still acquires the same lock) sees BUSY and skips. |
| Lock convention (shared) | `<DATA_DIR>/locks/dayahead_<YYYY-MM-DD>.lock`; body `<owner> pid=<pid> ts=<epoch>`; max age 300 s; fail-open on filesystem errors. |
| Fail-open? | Yes, both sides — matches Python's prior behaviour so a broken `locks/` directory cannot brick generation. |
| How to verify | 1. Start Node and Python. 2. Trigger Python auto-generation. 3. Wait until lock file appears in `%PROGRAMDATA%\InverterDashboard\db\locks\`. 4. While it exists, POST to `/api/internal/forecast/generate-auto` → should return 409 with `"already in progress (Python or Node)"`. |
| Rollback | Revert `server/forecastGenLock.js` (delete), the `forecastGenLock` import + lock/release blocks in `server/index.js`, and restore the `_dayahead_gen_lock_acquire/release` calls in `services/forecast_engine.py` `_delegate_run_dayahead`. |
| Known residual | The UNIQUE index on `forecast_run_audit(target_date, forecast_variant, trigger_source, attempt_number)` was considered but **NOT added** — creating a unique index would fail if any pre-existing duplicate rows are present, and this session did not run the data-cleanup pre-step. Tracked for v2.8.9 after a data audit. |

### T6.3 — Thumbprint verification against real installer

| | |
|---|---|
| File | `electron/main.js:666` (no code change) |
| Verified | `Get-AuthenticodeSignature release/Inverter-Dashboard-Setup-2.8.7.exe` returns thumbprint `44CD054E69D04011DAA8FB2B60127F1F6EB99C0E`, which matches `EXPECTED_SIGNER_THUMBPRINT`. |
| Conclusion | The hardcoded constant is correct. Auto-update will NOT silently reject itself against the v2.8.7 installer. |
| Still a known fragility | Cert rotation (Sectigo expiry) will still break updates until the constant is bumped. Long-term fix (ship v2.9.0): move thumbprint into a signed `trusted-signers.json` bundled with the installer. Tracked in [KNOWN_GAPS.md §2 T6.3](KNOWN_GAPS.md#t63--autoupdater-thumbprint-check). |
| Pre-v2.8.8 ship check | Re-run the PowerShell command on the actual v2.8.8 installer once built — if it produces a different thumbprint (rare — same cert should carry across builds), bump the constant before publishing. |

### T2.10 — Atomic manifest.json write

| | |
|---|---|
| File | `server/cloudBackup.js` (~line 640) |
| Before | Two `fs.writeFileSync(manifestPath, ...)` calls. Two concurrent backup runs could interleave and produce a torn file. |
| After | Writes to `manifest.json.tmp` first, then `fs.renameSync` — atomic on NTFS/POSIX. Applied to both writes (initial + checksum-embedded). |
| Risk if unfixed | Corrupt manifest breaks restore discovery silently. |
| Rollback | Revert the two `fs.writeFileSync(tmp) + fs.renameSync` pairs back to direct writes. |

### T2.11 — Explicit null-check before `poller.start()`

| | |
|---|---|
| File | `server/cloudBackup.js:1157-1165` |
| Before | `try { this.poller.start(); } catch { }` — if `this.poller` was null, `TypeError` fired, was caught, but the cause was opaque in logs. |
| After | Explicit `if (this.poller && typeof this.poller.start === "function")` with a warn-log fallback that tells the operator a restart may be required. |
| Risk if unfixed | Restore partially completes, poller never resumes, operator sees stale data and no log clue. |
| Rollback | Revert to the original try/catch. |

### T2.12 — go2rtc health-check honours HTTP status

| | |
|---|---|
| File | `server/go2rtcManager.js:85-102` |
| Before | Any HTTP response = alive. A 5xx from crashing go2rtc reported healthy. |
| After | `healthy = statusCode > 0 && statusCode < 500`. 4xx still counts as alive (server responding, auth/path mismatch). |
| Risk if unfixed | Camera page silently broken while health dashboard shows green. |
| Rollback | Revert to the `resolve(true)` branch in the response callback. |

### T5.4 — Chart y-axis bounds reset on theme change

| | |
|---|---|
| File | `public/js/app.js` inside `refreshChartsTheme` (~line 1811) |
| Before | Theme toggle triggered `chart.update("none")` while `scales.y.min/max` retained the previous render's cached bounds. After a data update with a tighter range, the plot was clipped/skewed. |
| After | Delete `scales.y.min/max/suggestedMin/suggestedMax` before `update("none")`, unless the chart owner set explicit `_configuredYMin` / `_configuredYMax` sentinels. No current caller uses those sentinels, so behaviour change is: bounds always re-derive from current data. |
| Risk if unfixed | Misleading scale in energy/analytics charts after any theme toggle. |
| Rollback | Remove the `delete opts.scales.y.*` block. |

---

## Verification run this session

| Check | Result |
|---|---|
| `node --check server/forecastGenLock.js` | pass |
| `node --check server/index.js` | pass |
| `node --check server/cloudBackup.js` | pass |
| `node --check server/go2rtcManager.js` | pass |
| `node --check public/js/app.js` | pass |
| `python -c "ast.parse(services/forecast_engine.py)"` | pass |
| PowerShell thumbprint match against `release/Inverter-Dashboard-Setup-2.8.7.exe` | match |
| Node test suite (`server/tests/*.test.js`) | NOT RUN — Electron ABI still active (see [KNOWN_GAPS.md §4.1](KNOWN_GAPS.md#41-node-test-suite)). |
| Python unit tests (`services/tests/`) | NOT RUN this session. |
| Playwright / E2E | NOT RUN. |

Syntax-only verification is consistent with the Phase-1 standard documented in [FIXES_PROGRESS.md](FIXES_PROGRESS.md). Before shipping v2.8.9, run the T7.3 smoke script from [KNOWN_GAPS.md §5.4](KNOWN_GAPS.md#54--t73--abi-toggle-smoke-script-build-this-next) once it exists.

---

## Pending / explicitly deferred

- **`package.json` version bump to 2.8.9** — deferred until the next release cycle. These fixes ride on the current v2.8.8 branch as "post-release patches" until a v2.8.9 tag is cut.
- **UNIQUE index on `forecast_run_audit`** — see T4.4 "Known residual" above. Needs a duplicate-row audit query first:
  ```sql
  SELECT target_date, forecast_variant, trigger_source, attempt_number, COUNT(*) c
  FROM forecast_run_audit
  GROUP BY 1,2,3,4 HAVING c > 1;
  ```
  If empty, safe to add `CREATE UNIQUE INDEX idx_fra_date_variant_trigger_attempt ON forecast_run_audit(target_date, forecast_variant, trigger_source, attempt_number)`. If non-empty, triage duplicates first.
- **Remaining Phase-2 HIGH items** (T1.5/1.6, T2.3–T2.9, T3.6–T3.12, T4.6–T4.12, T5.5–T5.8, T6.7–T6.11) — still deferred. [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan) remains the source of truth.

---

## Update to status in KNOWN_GAPS.md

After merging this session's fixes, the following entries in [KNOWN_GAPS.md](KNOWN_GAPS.md) should be treated as **closed** (the doc itself still reflects the pre-session state and should be regenerated for v2.8.9):

| Gap | Status after this session |
|---|---|
| §2 T4.4 "Still missing" items 1 & 3 (Node-side lock, Node-side cancel equivalent) | Item 1 closed. Item 3 effectively resolved — Python now no longer races Node because Node holds the lock throughout its run. Item 2 (UNIQUE index) still open. |
| §2 T6.3 "Verification step before v2.8.8 ship" | Verified — thumbprint matches. The three "Known fragility" bullets (not verified, rotation, PS-unreachable bypass) remain open. |
| §1 backlog T2.10, T2.11, T2.12 | Closed. |
| §1 backlog T5.4 | Closed. |

---

## Commit landed

Phase 2 + Phase 3 were committed together on 2026-04-14 in 4 commits
(consolidated from the 7-commit split originally proposed below, since
both phases touched `public/js/app.js` and the audit docs):

| Commit | Scope |
|---|---|
| `6ca5a66` | Phase 2 backend: T4.4 forecast lock + T2.10/T2.11/T2.12 (server/* + services/forecast_engine.py) |
| `eb1057b` | Phase 3 Electron: T6.7/T6.9/T6.10/T6.11 (electron/main.js) |
| `f83c131` | Phase 2+3 frontend bundle: T5.4/T5.5/T5.6/T5.7/T5.8 (public/js/app.js) |
| (this commit) | Phase 2+3 documentation: PHASE2_FIXES.md, PHASE3_FIXES.md, README + KNOWN_GAPS pointer updates |

Confirm with `git log --oneline -8`.

### Original commit-split intent (kept for reference)

1. `server/forecastGenLock.js` + `server/index.js` + `services/forecast_engine.py` → "Fix T4.4 (Phase 2): Node-side forecast advisory lock + remove Python pre-delegation lock"
2. `server/cloudBackup.js` + `server/go2rtcManager.js` → "Fix T2.10/T2.11/T2.12 (Phase 2): atomic manifest, poller null-check, go2rtc HTTP status"
3. `public/js/app.js` → "Fix T5.4 (Phase 2): reset chart y-axis bounds on theme change"
4. `audits/2026-04-14/PHASE2_FIXES.md` → "Document Phase 2 fixes + T6.3 thumbprint verification"

The consolidation merged steps 1+2 (both backend Node), kept Electron alone, bundled all `app.js` changes, and combined documentation.
