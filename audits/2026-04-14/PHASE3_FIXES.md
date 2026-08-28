# v2.8.8 → v2.8.9 Phase 3 Fix Log

**Date:** 2026-04-14
**Baseline:** v2.8.8 + Phase 2 (see [PHASE2_FIXES.md](PHASE2_FIXES.md))
**Target:** v2.8.9 (version bump still deferred)
**Session scope:** Continue closing HIGH backlog — Electron hardening (T6.7/T6.9/T6.10/T6.11) and frontend tail (T5.5/T5.6/T5.7/T5.8).

This log is a continuation of [PHASE2_FIXES.md](PHASE2_FIXES.md). Read in order: [FIXES_PROGRESS.md](FIXES_PROGRESS.md) (Phase 1) → [PHASE2_FIXES.md](PHASE2_FIXES.md) → this file. The remaining backlog is still tracked in [KNOWN_GAPS.md](KNOWN_GAPS.md).

---

## Why this scope

Two co-located tracks were chosen so blast radius stays bounded:
- **Electron main process** (`electron/main.js`) — one file, security/reliability flavour.
- **Frontend** (`public/js/app.js`) — one file, race/dedup flavour.

Tracks T2.3–T2.9, T3.6–T3.12, and T4.6–T4.12 deferred to a later session — they touch poller / inverter engine / forecast Python paths and need the T7.3 ABI-toggle smoke harness to verify safely. See [KNOWN_GAPS.md §5.4](KNOWN_GAPS.md#54--t73--abi-toggle-smoke-script-build-this-next).

---

## Fix-by-fix

### T6.7 — `unhandledRejection` handler in main process

| | |
|---|---|
| File | `electron/main.js:97` |
| Before | Only `uncaughtException` was handled. Promise rejections that escaped a `.catch` were swallowed by Node's default future-fatal warning, so "feels stuck" Electron bugs had no log. |
| After | Added `process.on("unhandledRejection", ...)` next to the existing `uncaughtException` handler. Logs and continues — does NOT rethrow (this process must stay up for the renderer/tray). |
| Risk if unfixed | Mysterious silent failures, no breadcrumb to start debugging. |
| Rollback | Delete the new block. |

### T6.9 — Backend auto-restart with backoff

| | |
|---|---|
| Files | `electron/main.js` (constants ~131, state ~227, exit handler ~3393, helpers ~3413, `restartBackendProcess` ~3550) |
| Before | `backendProc.on("exit")` only logged `"[main] Backend exited"` and left `backendProc = null`. App rendered a blank window and required manual restart. |
| After | Added `BACKEND_RESTART_BASE_MS=1500`, `BACKEND_RESTART_MAX_MS=30000`, `backendRestartTimer`, `backendRestartAttempts`, `clearBackendRestartTimer()`, `scheduleBackendRestart(reason)`. The exit handler now calls `scheduleBackendRestart` for unexpected exits; the spawn handler resets the attempt counter on success. `restartBackendProcess()` clears any pending timer first to prevent dual-spawn during manual restart. Mirrors the existing forecast-process pattern. |
| Risk if unfixed | App hangs after backend crash. Operator-visible. |
| Rollback | Revert the four edits in order; the manual `restartBackendProcess()` path is unchanged in behaviour. |
| Verification (manual, post-build) | 1. Launch app. 2. `taskkill /im node.exe /f` (or kill the backend exe). 3. Backend should respawn within 1.5–30 s, attempts back off, app recovers without restart. |

### T6.10 — OAuth `authUrl` scheme whitelist

| | |
|---|---|
| File | `electron/main.js:4814` (handler `oauth-start`) |
| Before | `oauthWin.loadURL(String(authUrl))` accepted any scheme. A compromised renderer could pass `file://`, `javascript:`, `data:`, or app-protocol URIs and load them in a window sharing the main app's session partition. |
| After | Parse `authUrl` with `new URL()`; reject anything other than `http:` or `https:` *before* the BrowserWindow is even constructed. Returns `{ ok: false, error: ... }` to the renderer. |
| Risk if unfixed | Credential-harvesting foothold. |
| Rollback | Remove the new try/catch block at the top of the Promise. |

### T6.11 — `pick-folder` defaults to Documents

| | |
|---|---|
| File | `electron/main.js:4441` (handler `pick-folder`) |
| Before | When the renderer passed no `startPath`, the OS dialog opened wherever Electron's cwd happened to be — often `C:\Windows\System32` for shortcut launches. |
| After | Falls back to `app.getPath("documents")`. The OS dialog still allows free navigation (no real sandbox is possible at the IPC layer) but the user lands somewhere safe and predictable. |
| Risk if unfixed | User confusion; accidental writes into surprising locations. |
| Rollback | Inline the previous one-liner default. |

### T5.5 — Mode-scoped `AbortController` for in-flight fetches

| | |
|---|---|
| Files | `public/js/app.js:3737` (`apiWithTimeout`), `public/js/app.js:6878` (`handleOperationModeTransition`) |
| Before | Mode transitions invalidated late responses via `reqId` counters but did NOT abort in-flight fetches. A remote-mode fetch issued just before a switch to gateway mode kept the socket open and consumed bandwidth even though its result was discarded. |
| After | Added module-level `_modeScopeAbortCtl` rotated by `refreshModeScopeAbort(reason)`. `apiWithTimeout` now auto-chains to this signal when the caller did not pass one. `handleOperationModeTransition` calls `refreshModeScopeAbort` before clearing per-mode state. Callers that pass their own signal keep their own lifetime — no behaviour change for them. |
| Risk if unfixed | Pre-transition fetches resolve late, can race the discard logic, also cost bandwidth/sockets. |
| Rollback | Remove the new top-of-function block in `apiWithTimeout` and the `refreshModeScopeAbort` call in `handleOperationModeTransition`. |

### T5.6 — Alarm toast dedup key includes alarm id

| | |
|---|---|
| File | `public/js/app.js:12270` (`handleAlarmPush`) |
| Before | The toast was emitted unconditionally per push event. A WS push that re-raised an alarm with the same `(inverter, unit)` produced a duplicate toast. |
| After | Added `_shouldEmitAlarmToast(a)` that dedups by `(inverter, unit, alarm_id)` over a 1.5 s window, with a bounded `Map` (drop entries older than 10× window when size > 256). Episode-id surrogate is `a.id` since each new alarm row gets a fresh PK. |
| Risk if unfixed | Toast spam on flap; also pollutes the toast-collapse pill counter. |
| Rollback | Remove `_shouldEmitAlarmToast` + the dedup-set + the `if (!_shouldEmitAlarmToast(a)) return;` line. |

### T5.7 — `AbortController` defensively aborted on timeout-wrapper exit

| | |
|---|---|
| File | `public/js/app.js:3737` (`apiWithTimeout`) |
| Before | The setTimeout was correctly cleared in `finally`, but the controller was NEVER explicitly aborted — only via the timeout firing. On error paths (network, parse), the controller stayed pending in devtools' Network panel as "still in flight". |
| After | `controller.abort("wrapper-exit")` after `clearTimeout`. After successful completion it's a no-op; on error it guarantees underlying Response body cancellation. The audit's strict-reading of "never calls abort" was about the success path — now covered. |
| Risk if unfixed | Cosmetic + occasional socket linger; rarely operator-visible. |
| Rollback | Remove the trailing `controller.abort(...)` in finally. |

### T5.8 — `cardOrder` localStorage namespaced by mode

| | |
|---|---|
| File | `public/js/app.js:1908` (`getStoredInverterCardOrder` / `persistInverterCardOrder`) |
| Before | One `adsi_inv_card_order` key for both gateway and remote modes. Re-arranging cards in one mode silently overwrote the other's layout. |
| After | Derive `${CARD_ORDER_STORAGE_KEY}:${mode}` per call. New `_cardOrderKeyForCurrentMode()` returns the scoped key. Legacy unscoped key is read once as a fallback so v2.8.8 users don't lose their existing layout — first read after the upgrade migrates the unscoped value into the active mode's scope. |
| Risk if unfixed | Operator's preferred card layout silently swapped on every mode switch. |
| Rollback | Replace the helper-based reads/writes with direct `CARD_ORDER_STORAGE_KEY` access. The legacy fallback path is then unused — safe to leave. |

---

## Verification this session

| Check | Result |
|---|---|
| `node --check electron/main.js` | pass |
| `node --check public/js/app.js` | pass |
| Manual / E2E | NOT RUN — same blockers as Phase 2 (T7.3 smoke harness still TODO). |

---

## Update to status in KNOWN_GAPS.md

After this session the following entries should be treated as **closed** (KNOWN_GAPS.md still reflects pre-Phase-2 state):

| Gap | Status |
|---|---|
| §1 backlog T6.7 | Closed |
| §1 backlog T6.9 | Closed |
| §1 backlog T6.10 | Closed |
| §1 backlog T6.11 | Closed |
| §1 backlog T5.5 | Closed |
| §1 backlog T5.6 | Closed |
| §1 backlog T5.7 | Closed |
| §1 backlog T5.8 | Closed |

T6.8 (storage migration atomicity) was deliberately not addressed — it's flagged "safe as-is, optimization only" in the bug sweep.

---

## Remaining HIGH backlog after Phases 2+3

The following Phase-2 HIGH items from [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan) are still deferred:

- **T1.5 / T1.6** — AbortController cleanup in remote fetches, reconnect-timer race
- **T2.3 – T2.9** — session token replay, token-store key derivation, alarms dedup, cap math clamp, go2rtc zombie, dayAheadLock UNIQUE index, streaming backoff cap
- **T3.6 – T3.12** — per-inverter polling isolation, Modbus socket leak, rebuild_global_maps lock, read timeout refresh, bounded write queue, post-write verification
- **T4.6 – T4.12** — Solcast reliability artifact logging, data-quality clock, legacy-model feature-count check, LightGBM reason exposure, error-memory eligibility filter, transmission-loss calibration, regime sample-count threshold
- **T6.8** — storage migration atomicity (optimization only)

These are the riskier HIGH items — they touch Python services and core polling — and benefit from the T7.3 ABI-toggle smoke harness existing first. Recommended next session order:
1. Build T7.3 smoke harness ([KNOWN_GAPS.md §5.4](KNOWN_GAPS.md#54--t73--abi-toggle-smoke-script-build-this-next)).
2. T2.3–T2.9 batch (session/token/streaming Node fixes — covered by Node test suite).
3. T3.6–T3.12 batch (Python inverter — covered by `services/tests/`).
4. T4.6–T4.12 batch (Python forecast — same).
5. T1.5/T1.6 + T6.8 cleanup.
6. UNIQUE index on `forecast_run_audit` (still pending from Phase 2).

---

## Commit landed

See [PHASE2_FIXES.md § Commit landed](PHASE2_FIXES.md#commit-landed) for
the full 4-commit table — Phase 2 and Phase 3 were committed together
on 2026-04-14.  Phase-3-specific commits:

| Commit | Scope |
|---|---|
| `eb1057b` | Phase 3 Electron: T6.7/T6.9/T6.10/T6.11 (electron/main.js) |
| `f83c131` | Phase 2+3 frontend bundle: T5.4 + T5.5/T5.6/T5.7/T5.8 (public/js/app.js) |
| (this commit) | Phase 2+3 documentation |
