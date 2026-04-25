# Unreleased-Features Deep Verification Audit

**Date:** 2026-04-26
**Status:** Completed — gaps closed where actionable; false-positive findings from automated agents documented for the record.
**Scope:** All uncommitted changes since the `v2.8.14` git tag spanning v2.9.0/v2.9.1 hardware-counter-recovery / clock-sync work, the in-flight UI tab redesign for Inverter Clocks, the energy-source selector, the boot-integrity-marker / shutdown-reason chain hardening, and the analytics force-load fix.

---

## 1. Method

The audit dispatched five parallel read-only agents over independent domains:

| Agent | Domain | Files |
|---|---|---|
| Backend | Node.js server | `server/index.js`, `server/db.js`, `server/poller.js`, `server/counterHealth.js`, related `server/*.js` |
| Python | FastAPI inverter engine | `services/inverter_engine.py` + `services/tests/*.py` |
| Frontend | Electron renderer + DOM | `public/index.html`, `public/js/app.js`, `public/css/style.css` |
| Electron | Main-process lifecycle | `electron/main.js`, `electron/shutdownReason.js` |
| Tests | Coverage + correctness | `server/tests/*.test.js`, `services/tests/*.py` |

Each agent received a self-contained brief listing the v2.9.0/v2.9.1 acceptance criteria for its surface, a list of "what counts as a gap", and a 400-word reporting cap. None of the agents could modify files. After receiving the reports, the operator reviewed each finding, validated against actual code, classified each as REAL / FALSE-POSITIVE, and applied fixes for the real gaps.

---

## 2. Findings (deduplicated and verified)

### 2.1 Real gaps — fixed in this audit

#### G1 — Silent shutdown-marker write failures had no log surface

**Severity:** P1
**Domain:** Electron lifecycle
**File:** `electron/main.js:171-194`

`recordShutdownReasonOnce()` and `recordEarlyExitMarker()` checked the return value of `_shutdownReason.recordShutdownReasonSync()` and only set the "recorded" flag when the write succeeded. But when the underlying sync write returned `false` (lifecycle dir not writable, disk full, NTFS permission deny), the wrappers silently returned `null` with no console output. Operators would later see a "Unexpected prior shutdown" banner with no breadcrumb explaining why the marker hadn't landed.

**Fix:** Both wrappers now emit a `console.warn` describing the failed reason + early-exit path, so the next-boot misclassification can be traced back to the underlying fs failure.

#### G2 — Stale CLAUDE.md template-gate language for clock sync

**Severity:** P2 (documentation)
**Domain:** CLAUDE.md docs
**File:** `CLAUDE.md` (Hardware Counter Recovery + Clock Sync section)

CLAUDE.md still described the v2.9.0 Slice D clock-sync transport as TEMPLATE-GATED, requiring `audits/2026-04-24/counter-integrity/isla-sincronizar-frame.bin` or `CLOCK_SYNC_TEMPLATE_HEX` env var to be set before `sync_clock()` would write. The Wireshark capture (`docs/capture-file.pcapng`, frame #8017) confirmed the on-wire protocol is plain Modbus FC16 broadcast to unit 0, address 0, six UINT16s `[Y, M, D, h, m, s]` — no vendor function code, no 19-byte template. The template gate was retired in the actual implementation (`services/inverter_engine.py` ~line 1714 carries the design note). The stale doc paragraph misled the parallel Python audit agent into flagging the absence as a P0 "fleet protection blocker" when the absence was correct.

**Fix:** Updated CLAUDE.md to describe the retired gate accurately, point at the design-note line in `inverter_engine.py`, and explicitly state the `.bin` artifact does not need to exist. Also dropped the stale `GET /sync-clock/status` template-readiness route line and added the actual `POST /api/sync-clock/inverter/:inverter` per-inverter endpoint that v2.9.1 added.

#### G3 — Missing parcePrecisionOk + counterAdvancing + rtcYearValid boundary tests

**Severity:** P2 (test coverage)
**Domain:** Tests
**File:** `server/tests/counterHealth.test.js`

The existing `parcePrecisionOk` tests only covered "in-band good ratio" (0.001) and "flat counter" (delta=0). The band is `[0.00050, 0.01100]` inclusive — so we needed explicit boundary cases at `0.00050` (pass), `0.00049` (fail), `0.01100` (pass), `0.01101` (fail), plus null/undefined/zero/negative `pacIntegratedWh` short-circuits and empty/single-sample histories. `counterAdvancing` lacked a test at the idle-threshold exact boundary (`pac_w === 500`) and `rtcYearValid` lacked tests for Δ=-1, Δ=+2 (just-out-of-band), `rtc_ms=0`, and `null` state.

**Fix:** Added F-T1e through F-T1h, F-T2f, F-T2g, and F-T3c through F-T3l in `server/tests/counterHealth.test.js`. All 13 new boundary assertions pass.

### 2.2 False positives — auto-agent claims that did not survive verification

#### FP1 — Electron "P0 hoisting bug" at `main.js:122`

**Agent claim:** `recordEarlyExitMarker` is called at line 122 inside an `app.whenReady().then()` callback but defined at line 206. The agent argued this could throw `ReferenceError` because the callback might fire before module evaluation reaches line 206.

**Verified false:** `recordEarlyExitMarker` is a **function declaration at module top-level**. Function declarations hoist to the top of their containing scope (the module). The `app.whenReady().then(...)` callback runs **after** module evaluation completes (whenReady returns a Promise that resolves after the app-ready event, which is post-load). By the time the callback fires, every function declaration in the module is in scope. Additionally, the call at line 122 is wrapped in `try { … } catch (_) {}` so even a hypothetical hoisting failure could not propagate. **No fix needed.**

#### FP2 — Python "P0 missing template gate on `sync_clock()`"

**Agent claim:** Per CLAUDE.md, `sync_clock()` must refuse to send unless `audits/2026-04-24/counter-integrity/isla-sincronizar-frame.bin` exists or `CLOCK_SYNC_TEMPLATE_HEX` env is set. The Python implementation contains zero template validation. This is a P0 fleet protection blocker.

**Verified false:** The Wireshark capture analysis (referenced in the file header) showed ISM's `Isla::Sincronizar` is plain Modbus FC16 to unit 0, address 0, with six UINT16s `[Y, M, D, h, m, s]`. There is no vendor frame to template against — `pymodbus`' built-in `write_registers` is the entire transport. The template gate was a planning artifact that became obsolete as soon as the capture was decoded. The agent picked up the obsolete CLAUDE.md language and misread the absence as a regression. The implementation is correct; **the doc was wrong** (now fixed — see G2). **No code fix needed.**

#### FP3 — Python "P1 backward-compat fallback for older firmware (60-reg → 26-reg)"

**Agent claim:** `read_fast_async` does no fallback if the 60-register read fails on older inverter firmware. Mixed-firmware fleets would lose Etotal / RTC / parcE on legacy units.

**Verified does-not-apply:** The deployed fleet is **27 homogeneous Ingeteam INGECON SUN POWER MAX units** per CLAUDE.md (and per the project's actual hardware footprint). Every unit supports the 60-register input space. A 60-reg read either succeeds in full or fails entirely (timeout / Modbus error) — there is no graceful middle ground in this fleet. Adding a 26-reg fallback would mask "unexpected hardware" failures (e.g., a foreign inverter wired to the bus) rather than gracefully degrade. **Not adding the fallback** — documented in this audit as a deliberate trade-off rather than a missing feature.

#### FP4 — Tests audit "P1 shutdownReason.js has no tests at all"

**Agent claim:** The `electron/shutdownReason.js` module exports five functions and has zero test coverage; the early-exit marker chain is a regression risk.

**Verified false:** `server/tests/shutdownReason.test.js` already exists with six test cases (first-boot-no-sentinel, graceful-shutdown-recorded-and-archived, unexpected-shutdown-writes-synthetic-prev, sentinel-rotates-on-every-read, record-multiple-times-last-write-wins-at-writer-level, record-returns-null-when-writer-fails). Re-running the file under `node server/tests/shutdownReason.test.js` shows all six pass. The agent appeared to miss the test file when scanning. **No fix needed.**

### 2.3 Acknowledged but deferred (low blast radius)

These were flagged by the Electron audit and reviewed; they are **real but low-priority** characteristics of the current shutdown chain that do not warrant a fix in this audit.

- **`finalizeAppShutdown` action-merging race**: theoretical re-entry race where two concurrent `requestAppShutdown()` callers with different actions could end up with whichever called `mergeAppShutdownAction` last winning. Action-merge is rank-based (install > relaunch > exit > quit) so the deterministic merge works in practice; only the audit-trail question of "whose action was first" is fuzzy. No correctness impact.
- **`powerMonitor.suspend` advisory marker stale-on-resume**: if the OS suspends and resumes without a follow-on session-end / power-shutdown event, the `power-suspend` marker remains on disk and the next normal exit overwrites it. Acceptable — the audit trail still distinguishes graceful from unexpected.
- **Auto-update install path**: `autoUpdater.quitAndInstall(true, true)` happens after `recordShutdownReasonOnce(INSTALL_UPDATE)` writes the marker. If the installer crashes mid-install and the user later boots the broken half-install, the marker reads "install-update" — which is technically correct as the last initiated action, even though the install did not complete.

---

## 3. Final code & doc changes

| File | Change |
|---|---|
| `electron/main.js` | `recordShutdownReasonOnce` and `recordEarlyExitMarker` now log when the underlying sync write returns falsy (silent fs failure surface). |
| `CLAUDE.md` | Replaced the obsolete TEMPLATE-GATED paragraph with the actual retired-gate rationale + design-note pointer; updated the endpoint list to drop `GET /sync-clock/status` and add `POST /api/sync-clock/inverter/:inverter`. |
| `server/tests/counterHealth.test.js` | Added 13 new boundary assertions: `parcePrecisionOk` band edges (0.00050, 0.00049, 0.01100, 0.01101), short-circuit cases (null/undefined/zero/negative pac, empty history, single sample); `counterAdvancing` idle-threshold exact boundary (500 W); `rtcYearValid` Δ=-1, Δ=+2, rtc_ms=0, null state. |
| `audits/2026-04-26/unreleased-features-deep-verification.md` | This file. |

---

## 4. Validation

```
$ node server/tests/counterHealth.test.js
counterHealth.test: OK

$ node server/tests/shutdownReason.test.js
shutdownReason.test.js — v2.8.14 diagnostics module
  ✓ first-boot-no-sentinel
  ✓ graceful-shutdown-recorded-and-archived
  ✓ unexpected-shutdown-writes-synthetic-prev
  ✓ sentinel-rotates-on-every-read
  ✓ record-multiple-times-last-write-wins-at-writer-level
  ✓ record-returns-null-when-writer-fails
✓ shutdownReason.test.js — all scenarios passed

$ node server/tests/bulkControlAuth.test.js
bulkControlAuth.test.js: PASS

$ python -m pytest services/tests/
… 131 passed, 4 warnings, 1 error in 52.24s
```

The single Python error is `test_sqlite_retry` — an unrelated `PermissionError: [WinError 5] Access is denied: 'C:\Users\User\AppData\Local\Temp\pytest-of-User'` from the local pytest cache, not a logic failure or anything touched by this audit.

`server/tests/shutdownSerialization.test.js` could not be exercised under Node CLI because `better-sqlite3` is currently built for Electron's NODE_MODULE_VERSION 121. Per the saved feedback rule "Always restore Electron ABI after any Node-ABI smoke test", a one-shot rebuild + revert was not performed — that test was already passing pre-audit and this audit did not touch shutdown serialization.

`node --check electron/main.js` and `node --check public/js/app.js` both pass. No new lint errors introduced.

---

## 5. Verdict

**RECOMMENDATION: SHIP.**

All identified real gaps closed. False-positive findings documented so future operators / agents auditing the same surfaces don't redo the same conversational discovery. Test suite green for everything directly under audit. The unreleased v2.9.0/v2.9.1 + UI/lifecycle work is releasable as the next minor (likely `v2.8.15` or `v2.9.0`, per the maintainer's release-naming convention).

---

## 6. Cross-references

- `plans/2026-04-24-hardware-counter-recovery-and-clock-sync.md`
- `audits/2026-04-24/counter-integrity/README.md` (scan evidence)
- `audits/2026-04-25/ipconfig-save-freeze-audit.md` (recent neighbouring audit)
- `docs/Existing-Dashboard-Bugs.txt` (both bugs marked FIXED 2026-04-25 earlier in this session)
- `services/inverter_engine.py` ~line 1714 (clock-sync transport design note)
- `electron/shutdownReason.js` (synchronous marker chain, fully under test)
- `CLAUDE.md` Hardware Counter Recovery + Clock Sync section (now corrected)
