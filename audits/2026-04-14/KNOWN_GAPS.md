# v2.8.8 Known Gaps — What Was NOT Fixed

**Date:** 2026-04-14
**Baseline:** v2.8.8 (after commits `1d88c8e` → `0d4f8b9`)
**Companion docs:**
- [BUG_SWEEP.md](BUG_SWEEP.md) — the 123-finding audit
- [FIXES_PROGRESS.md](FIXES_PROGRESS.md) — the 23 CRITICAL fixes shipped
- [PHASE2_FIXES.md](PHASE2_FIXES.md) — **post-v2.8.8 session (2026-04-14)** closing T4.4 Node-side lock, verifying T6.3 thumbprint, and fixing T2.10/T2.11/T2.12/T5.4. **This doc below still reflects pre-Phase-2 state; see PHASE2_FIXES.md "Update to status" table for what is now closed.**
- [PHASE3_FIXES.md](PHASE3_FIXES.md) — **same-day Phase 3 session (2026-04-14)** closing T6.7/T6.9/T6.10/T6.11 (Electron) and T5.5/T5.6/T5.7/T5.8 (frontend). Same amend convention.
- [SMOKE_BASELINE.md](SMOKE_BASELINE.md) — **same-day** first run of the new T7.3 smoke harness; catalogues 5 pre-existing Node-test failures.
- [PHASE5_FIXES.md](PHASE5_FIXES.md) — **same-day Phase 5 session (2026-04-14)** closing T2.3–T2.9 (Node subsystem). Smoke-verified zero regressions.

This doc is the **source of truth for what was deliberately NOT fixed** in v2.8.8, organised so a future debugger can grep for a symptom and find the relevant known issue.

---

## 1. Untouched backlog (Phase 2-4 of the original plan)

| Count | Severity | Target release | Status |
|---|---|---|---|
| 38 | HIGH | v2.8.9 | deferred |
| 43 | MEDIUM | v2.8.9 / v2.9.0 | deferred |
| 10 | LOW | v2.9.0+ | deferred |
| 9 | INFO | backlog | deferred |
| **100** | **total** | | |

All 100 items are in [BUG_SWEEP.md](BUG_SWEEP.md) with file:line anchors, symptoms, and proposed fixes. The Phase-2 subset called out in the original remediation plan:

- **T1.5 / T1.6** — AbortController cleanup in remote fetches, reconnect-timer race
- **T2.3 – T2.12** — session token replay, token-store key derivation, alarms dedup, cap math clamp, go2rtc zombie, dayAheadLock UNIQUE index, streaming backoff cap, cloudBackup manifest race + poller null-check + health HTTP status
- **T3.6 – T3.12** — per-inverter polling isolation, Modbus socket leak, rebuild_global_maps lock, read timeout refresh, bounded write queue, post-write verification
- **T4.6 – T4.12** — Solcast reliability artifact logging, data-quality clock, legacy-model feature-count check, LightGBM reason exposure, error-memory eligibility filter, transmission-loss calibration, regime sample-count threshold
- **T5.4 – T5.8** — chart axis reset on theme change, mode-switch AbortController, alarm dedup key, timeout controller abort, card-order localStorage namespacing
- **T6.7 – T6.11** — unhandledRejection handler, storage migration atomicity, backend auto-restart, OAuth authUrl validation, pick-folder whitelist

---

## 2. Partial / defence-in-depth only fixes in v2.8.8

These landed but are incomplete. Log them here so the debugger knows NOT to treat them as closed.

### T4.4 — Forecast delegation / fallback race (partial)

- **Landed:** Python-side advisory lock in `services/forecast_engine.py` (commit `0402ff7`).
  Guards all four Python generation call sites (`_delegate_run_dayahead`, manual CLI fallback, auto-service fallback, recovery fallback) via `DAYAHEAD_GEN_LOCK_DIR`.
- **Still missing — v2.8.9 scope:**
  1. Node orchestrator (`/api/internal/forecast/generate-auto`) does not respect the same lock file.
  2. `forecast_run_audit` has no `UNIQUE (forecast_day, variant, trigger_source)` index.
  3. No Node-side cancel endpoint so Python can abort a late Node completion after its own fallback ran.
- **How a duplicate could still occur:** Python calls Node → Python acquires lock → Node times out on Python's 180 s → Python releases lock in `finally`, runs its own fallback (re-acquires lock) → **meanwhile Node is still processing and writes its own audit row after Python's lock release**. The lock only protects Python-vs-Python concurrency.
- **Debug hint:** search logs for `"delegation success"` within 5 min of `"auto_service_fallback"` on the same `target_date` — that's the symptom.

### T6.3 — autoUpdater thumbprint check

- **Landed:** thumbprint `44CD054E69D04011DAA8FB2B60127F1F6EB99C0E` hardcoded in `electron/main.js`. Reject-on-mismatch when PowerShell is reachable; log-and-accept otherwise.
- **Known fragility:**
  1. The constant is **not verified** against the actual v2.8.7 / v2.8.8 installer on disk. If wrong, **every future auto-update will reject itself silently** (the user will see "Update available → does not install").
  2. Cert rotation (Sectigo-issued certs expire) will break updates until the constant is bumped.
  3. PowerShell-unreachable fallback accepts the binary, so the defence is bypassed on machines where PS is missing / policy-blocked.
- **Verification step before v2.8.8 ship:**
  ```powershell
  Get-AuthenticodeSignature release/Inverter-Dashboard-Setup-2.8.7.exe `
    | Select-Object -ExpandProperty SignerCertificate `
    | Select-Object -ExpandProperty Thumbprint
  ```
  The result MUST match the constant; otherwise update to the actual thumbprint before shipping.
- **Long-term fix (v2.9.0):** move the thumbprint into `settings` or a signed `trusted-signers.json` bundled with the installer; document rotation procedure.

### T1.1 — Replication SQL whitelist

- **Landed:** `REPLICATION_ALLOWED_TABLES` guard at both dynamic-SQL sites.
- **Reality check:** current callers of `mergeAppendReplicationRow` / `mergeUpdatedReplicationRow` only pass `def.name` from the hardcoded `REPLICATION_TABLE_DEFS`. **There is no currently-exploitable SQL injection.** The fix protects against future refactors that might expose these functions to untrusted input.
- **Not a bug today — don't chase ghost reports.**

### T3.3 — TOCTOU on `write_pending`

- **Landed:** `write_pending_lock` guards (mark + enqueue) atomically against (q.empty + clear).
- **Side effect to watch:** because the lock now serialises a short critical section on every write + every job dequeue, a pathological storm of `/write` calls across all 27 inverters could see micro-contention on `write_pending_lock`. In practice this is invisible (lock held < 1 ms), but if queue throughput ever drops mysteriously look here first.

### T3.5 — Auto-reset operator hold window

- **Landed:** 5-second hold after `/write` on the same `(ip, unit)`; suppresses auto-reset transitions both ways.
- **Limitation:** the hold is per-unit, so a write to unit 1 does NOT suppress auto-reset on unit 2 of the same inverter. If an operator writes unit 1 and unit 2 alarms immediately afterwards, auto-reset will fire on unit 2 even if the operator's intent was plant-wide.
- **Debug hint:** logs will show `[AUTORESET] OFF OK` with a timestamp close to an operator `/write/batch` event — verify units differ.

---

## 3. Audit / coverage gaps (what wasn't inspected)

These are places the 2026-04-14 sweep **did not look**. Absence of findings ≠ absence of bugs.

### 3.1 Frontend — most of `public/js/app.js`

The Track 5 agent closely read approximately the following line ranges (per its own completion report):

| Feature | Lines reviewed |
|---|---|
| WebSocket lifecycle | 11413–11436 |
| Theme toggle / modal | 1999–2035 |
| Chart rendering / analytics | 13936–14863, 5501–5911 |
| Export UI + AbortController | 15472–15784 |
| Alarm deduplication | 2970–3070 |
| Mode transition / fetch abort | 3580–3741 |
| LocalStorage / card order | 1893–1924 |
| HTML escaping utilities | 17127–17133 |

Everything else in the 17,891-line file was **not** deeply audited. High-risk untouched areas:

- Inverter card-grid rendering
- IP-config window logic
- Plant-cap dispatch UI
- User-guide embedded viewer
- Camera tile lifecycle (jsmpeg.min.js integration)
- Login / license gate

### 3.2 Python forecast engine

Track 4 agent self-reported ~30 % close-read coverage (≈3,500 / 11,751 lines) before hitting token limits. Close-read:
- `run_dayahead()` and its physics baseline
- `solcast_prior_from_snapshot()`
- `build_features()` + residual path
- ML training data collection + audit persistence

Skimmed only:
- Intraday adjustment (`run_intraday_adjusted`)
- Most of `forecast_qa()` and per-slot QA classifiers
- Scheduler main-loop tail
- Backup / restore glue
- Error-classifier training paths

### 3.3 Not audited at all

- Node test suite (`server/tests/*.test.js`) — 29 tests. See §4.1 below.
- Playwright spec (`server/tests/electronUiSmoke.spec.js`)
- `drivers/modbus_tcp.py` beyond import-level scan — register unpacking endianness/word-order assumptions NOT deeply verified.
- `server/cloudProviders/*.js` — OneDrive / GDrive / S3 adapters read by Track 2 agent but no deep finding list (token limit hit earlier).
- `scripts/*` — build-installer-signed.js, generate-codesign-cert.ps1, verify-codesign-trust.ps1.
- `services/ForecastCoreService.spec` / `services/InverterCoreService.spec` — PyInstaller specs.
- `electron/storageConsolidationMigration.js` beyond scan-level read.
- **Dependency CVEs** — zero `npm audit` or `pip-audit` runs this session.
- **Secrets hygiene** — zero scan of git history for committed tokens; `.gitignore` coverage of `private/*.md` and `ipconfig.json` not verified.

---

## 4. Verification gaps

Everything Phase 1 shipped was verified at **syntax + Python unit-test level only**. The following verification dimensions were **not** exercised:

### 4.1 Node test suite

- `for t in server/tests/*.test.js; do node "$t"; done` — **never run this session**.
- Blocked by Electron ABI mismatch on `better-sqlite3` (expected per `feedback_native_rebuild.md`).
- The 29 tests in `server/tests/` could have caught regressions in:
  - T1.1 (replication merge path) — `manualPullGuard.test.js`, `manualReplicationCancel.test.js`, `manualPullFailureCleanup.test.js`
  - T1.2 (exporter yields) — `xlsxExportStyling.test.js`, `forecastActualAverageTable.test.js`
  - T1.4 (poller) — `pollerIpConfigMapping.test.js`, `pollerTodayEnergyTotal.test.js`
  - T2.1 (bulk auth) — `bulkControlAuth.test.js`
- **Required before v2.8.9:** build `scripts/smoke-all.js` that toggles ABI → runs tests → restores ABI. Tracked as T7.3 in the sweep.

### 4.2 E2E / behavioural

No Playwright run; `server/tests/electronUiSmoke.spec.js` never executed. The following fixes have **zero runtime verification**:

| Fix | What would need to be tested |
|---|---|
| T6.1 single-instance | Launch installed app twice; confirm second exits and first focuses |
| T6.2 open-ip validation | Call the IPC with `file:///etc/passwd`, `javascript:alert(1)`, `data:text/html,` — all should be rejected |
| T6.3 thumbprint | Forge a `latest.yml` → sign with different cert → confirm rejection |
| T6.5 openExternal | `window.open("javascript:alert(1)")` from DevTools — must be blocked |
| T3.3 TOCTOU | Stress 1000 concurrent `/write` per inverter, zero dropped |
| T4.4 advisory lock | Fire delegate + manual CLI concurrently; exactly one audit row |
| T2.2 backup mutex | Call `/api/backup/create` and `/api/backup/restore/<id>` in parallel; DB remains consistent |
| T5.1 listener idempotency | Navigate between 10 pages; DevTools → getEventListeners(document).length stable |
| T5.3 modal dedup | Double-click theme toggle rapidly; handler count stays 1 |

### 4.3 File:line anchor re-verification

Track 3 (Python inverter) and Track 4 (Python forecast) findings were **reconstructed from agent completion summaries** after a file-truncation incident during the sweep. Most anchors were spot-checked when applying the fix, but not all. Specifically:

- T3.13 – T3.24 (MEDIUM + LOW inverter findings in the reconstructed section) — anchors were the agent's best-guess ranges, not verified.
- T4.6 – T4.20 (HIGH / MEDIUM / LOW forecast findings after the critical band) — same caveat.

If a future debugger is tracking one of these, **re-grep for the described symptom** rather than trusting the exact line number.

---

## 5. Tooling / process gaps

### 5.1 No `npm audit` / `pip-audit` this session

- Dependencies like `node-fetch@2` (EOL since 2024), `electron@29` (Electron 34 is current as of this baseline), `chart.js@4`, `electron-updater@6.3.9`, `exceljs@4`, etc. — transitive CVEs not reviewed.
- **Required before v2.8.8 release OR log explicitly:** run `npm audit --production` and `pip-audit -r <(pip freeze)` and triage any HIGH/CRITICAL.

### 5.2 No secrets scan

- `git log -p | grep -iE "token|secret|password|key"` or `gitleaks detect` not run.
- `.gitignore` coverage of `private/`, `ipconfig.json`, `.env`, `.adsi-keyring`, installer signing keys not confirmed in this session.
- Memory states "live secrets in git-ignored `private/*.md` only" — believed but not verified.

### 5.3 Agent-orchestration issues that hurt the sweep

Documented in [BUG_SWEEP.md](BUG_SWEEP.md) §Audit conduct notes. Summary: one agent overwrote the findings doc (recovered from git reflog); one committed unprompted (reset); multiple returned summaries without writing.

**Preventive measures for the next sweep:**
- Mandate `bash heredoc` append in agent prompts; forbid `Write` / `Edit` on the findings doc from sub-agents.
- Forbid unprompted `git commit` at prompt level.
- Pre-create per-track output files; main agent concatenates.
- Use forward-slash POSIX paths in Git-Bash commands.

### 5.4 T7.3 — ABI-toggle smoke script (build this next)

```
scripts/smoke-all.js should:
  1. npm run rebuild:native:node
  2. for each server/tests/*.test.js, run it; collect pass/fail
  3. python -m pytest services/tests/ --junitxml
  4. npm run rebuild:native:electron     (MANDATORY restore per memory)
  5. write JSON summary + exit code 0 only if all green
```

Once this exists, every future bug-fix batch can be smoke-verified in one command.

---

## 6. Environment-specific gotchas for future debugging

- Repo is **currently in Electron ABI** (post-installer build). Running `node server/tests/*.test.js` will fail with `ERR_DLOPEN_FAILED` until `npm run rebuild:native:node` is run. **ALWAYS restore with `npm run rebuild:native:electron` before leaving the repo** (per memory `feedback_native_rebuild.md`).
- `d:\ADSI-Dashboard\app_v2.5.0.js` and `d:\ADSI-Dashboard\style_v2.5.0.css` at repo root are **stale backups**, not live code. Flagged in the sweep but not removed to avoid surprise.
- `release_aux_20260313-222410/`, `release_full_2427/`, `release_prev_2426/` are prior-build artefacts. Do not assume they reflect current source.
- `private/`, `build-output.log`, `.adsi-migration-v2.4.43.json` are transient / gitignored. Do not inspect without understanding what generated them.

---

## 7. Quick "is this a known gap?" grep reference

| Symptom | Known gap |
|---|---|
| Duplicate `forecast_run_audit` rows on same date | §2 T4.4 |
| Auto-updater silently refuses every update | §2 T6.3 (thumbprint mismatch) |
| Strange "write dropped" behaviour under load | §2 T3.3 side effect |
| Auto-reset firing on unit N after operator wrote unit M | §2 T3.5 limitation |
| Chart axis stuck after theme toggle | Backlog T5.4 |
| Remote-mode stale data after mode switch | Backlog T5.5 + T1.5 |
| WebSocket reconnect storm on flap | Backlog T5.17 (MEDIUM) + T2.3 session concerns |
| Backup upload stuck or corrupted during restore | §2 T2.2 (fixed) OR §1 T2.10-T2.11 (pullFromCloud/portable not yet wrapped) |
| Modbus values garbage from a new firmware variant | §3.3 modbus driver not deeply audited |
| A test file in `server/tests/` that would have caught my fix | §4.1 Node suite never ran |
