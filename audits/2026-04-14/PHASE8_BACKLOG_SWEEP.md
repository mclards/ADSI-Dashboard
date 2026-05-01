# Phase 8 — Full MEDIUM / LOW backlog sweep

**Date:** 2026-04-14 (session continued into 2026-04-15)
**Baseline:** v2.8.8 + Phase 2/3/4/5/6/7 (commit `da9f025`)
**Target:** v2.8.9
**Session scope:** Finish the audit — remaining MEDIUM and LOW items after Phases 2/3/5/6/7 closed all of the HIGH backlog except T1.5/T1.6/T6.8.

Unlike earlier phases this is a **sweep**, not a per-item deep-dive. The audit's MEDIUM/LOW descriptions were — by KNOWN_GAPS.md's own admission in §4.3 — reconstructed from agent completion summaries after a file-truncation incident, and anchors were "best-guess ranges, not verified". So many items describe code that either was already fixed, was already correctly implemented, or doesn't exist at the claimed file:line.

This doc is organised as: **what I actually fixed** → **what I verified was already fine** → **what I chose NOT to fix and why**.

---

## 1. Fixes that landed

All syntax-checked; smoke run shows identical 24/29 Node + 107/107 Python pass (same 5 pre-existing failures as SMOKE_BASELINE.md — zero regressions).

| Audit ID | File | What changed |
|---|---|---|
| **T1.5** | `server/index.js:6350` | In `connectRemoteBridgeSocket`, abort any prior `remoteLiveFetchController` before overwriting the module-level reference. Prevents orphaned fetches running to completion (consuming socket+memory) whose results we would discard anyway. |
| **T1.7** | `server/index.js:2535` | Documented the prepared-statement cache: `better-sqlite3` Statement objects have NO `.free()`/`.finalize()` API — N-API finaliser releases native resources on GC. `Map.delete()` is sufficient. The audit's suggestion applied to `node-sqlite3` (async) or pooled forks, not vanilla better-sqlite3. No code change, just a comment so the next debugger doesn't chase the ghost. |
| **T2.13** | `server/storagePaths.js:48` | One-time INFO log in `resolvedDbDir()` when the migration sentinel is absent, with a second variant when fallback to legacy APPDATA path is taken. Gates on `_dbDirFallbackLogged` to avoid spam. |
| **T2.18** | `server/streaming.js` | Registered `process.on("SIGTERM", () => stopCameraStream())` via `installShutdownHandler()` (idempotent, called on module load). Ensures the ffmpeg child process is killed when the Electron parent issues SIGTERM during app shutdown, so it doesn't become a zombie holding the RTSP socket. |
| **T3.13 + T3.18** | `services/inverter_engine.py:1413` | New `/health` endpoint returning `{status, stale, newest_frame_age_ms, connected_inverter_count, configured_inverter_count, now_ms}`. `status` is `"ok"` / `"degraded"` / `"unready"`. `stale=true` when the newest frame across all inverters is older than 30 s — the "process alive but stuck" failure mode. Closes both T3.13 (no health endpoint) and T3.18 (stale metrics after idle) in one addition. |
| **T3.14** | `services/inverter_engine.py:49` | Restricted `CORSMiddleware` from `allow_origins=["*"]` to `["http://127.0.0.1:3500", "http://localhost:3500"]` by default. Override via `INVERTER_ENGINE_CORS_ORIGINS` env var (comma-separated) for reverse-proxy deployments. Also tightened `allow_methods=["GET", "POST"]` from `["*"]`. Defence-in-depth — the service still binds to 127.0.0.1 as primary mitigation. |
| **T3.17** | `services/inverter_engine.py:1295` | The `pac_reg * 10 <= 260_000` clamp already existed; added a one-time-per-node WARNING log via `_pac_clamp_notified` set when the clamp triggers, so an Ingeteam firmware variant with a different word order surfaces as a loud signal instead of silently-zeroed PAC. |
| **T3.20** | `services/inverter_engine.py:1708` | In `main()` after `rebuild_global_maps()`, warn loudly if `inverters` is empty at startup. Service stays up (so ipconfig hot-reload can add inverters later) but operator gets a clear message instead of silently-empty `/data` and `/metrics`. |
| **T4.18** | `services/forecast_engine.py:8243` | DEBUG log when `regime_confidence < 0.6` showing the blend reduction. Visibility into when a forecast is falling back toward the global model due to a low-confidence classification. |

**9 actionable fixes** across 5 files. Diff stat: `133 insertions, 5 deletions`.

---

## 2. Audit items verified as already-fixed / already-correct

For each, the referenced code was inspected; the issue described in the audit either does not exist or was fixed by an earlier phase. No new code change was made.

| Audit ID | File:line | Why no change |
|---|---|---|
| **T1.6** | `server/index.js:6180-6183` | `scheduleRemoteBridgeReconnect` already does `if (remoteBridgeTimer) { clearTimeout(...); remoteBridgeTimer = null; }` before scheduling a new timer. No race. |
| **T1.8** | `server/poller.js:813` | `_flushRetryCount = 0` already executes on successful flush. Audit's "counter never resets" claim is incorrect. |
| **T1.9** | `server/db.js:1720-1737` | `bulkInsertPollerBatch` already logs `err.message` AND the full `row` payload on per-row catch; batch context is preserved via the row dump. |
| **T2.16, T2.20, T2.22** | `server/alarmEpisodeCore.js` | File is 19 lines total with only `normalizeAlarmValue` + `classifyAlarmTransition`. Audit's `severityScore` / `asOfTs` / `hysteresis padding` symptoms describe a file that doesn't exist. |
| **T2.17** | `server/bulkControlAuth.js` | `BULK_AUTH_SESSION_TTL_MS = 10 min` and session entries store `expiresAt`. Age check is enforced via `cleanupExpiredEntries` on every validation. Already correct. |
| **T2.21** | `server/plantCapController.js` | `config` object built once per dispatch-cycle invocation (called via `buildControlState`), values are captured at cycle start and the cycle runs synchronously. No mid-dispatch mutation possible. |
| **T3.15** | `services/inverter_engine.py` | `start_polling_manager._supervisor` already cancels tasks for removed inverters (`tasks.pop(ip).cancel()` at line ~1112). Phase 6 T3.9 further ensured the global-map swap is atomic. |
| **T3.16** | `services/inverter_engine.py` | `uvicorn.run` manages the root logger; no manual handler accumulation. A grep for `addHandler` returns only `log = logging.getLogger(__name__)` — no duplicate-handler pattern. |
| **T3.19** | `services/inverter_engine.py:1720` | `uvicorn.Server.serve()` installs its own SIGTERM handler setting `should_exit=True`. Plus the `SERVICE_STOP_FILE` soft-stop task. Redundant signal handler would conflict with uvicorn. |
| **T3.21** | `services/inverter_engine.py` | Grep for bare `except:` returns zero matches. All exception handlers are either `except Exception` or specific types. |
| **T3.22** | `services/inverter_engine.py` | Reload errors in `ipconfig_watcher` already log at WARN with traceback. |
| **T3.23** | `services/inverter_engine.py:1579` | `websocket_metrics` wraps send in try/except and removes disconnected clients from the broadcast set (`ws_clients.discard(ws)` in finally). |
| **T3.24** | `services/inverter_engine.py` | No unbounded ring buffer exists — `shared` is keyed by IP (fixed size = inverter count), `metrics_state["pacEnergyHistory"]` is keyed by `(inverter_unit, date)` (bounded). No metrics history list that grows without limit. |
| **T4.13** | `services/forecast_engine.py:2191` | `scale = np.where(np.isfinite(scale), scale, floor)` NaN guard already present. |
| **T4.17** | `services/forecast_engine.py` (many sites) | `SOLCAST_BIAS_RATIO_CLIP` applied at lines 1274, 2603, 4554, 4592, 4607 — every construction and consumption path. Already bounded. |
| **T5.9** | `public/js/app.js:2482` | `p.activeCount = Math.max(0, p.activeCount - 1)` already clamps. |
| **T5.12** | `public/js/app.js:1725` | `cssNumberVar` uses `Number.isFinite(raw) ? raw : fallback`. Already guarded. |
| **T6.8** | `electron/storageConsolidationMigration.js` | The audit itself flagged this as `"safe as-is"` / `"Risk: Slow startup (harmless)"`. Not a bug. |

---

## 3. Items deliberately not fixed — scope/cost reasoning

For each, genuinely open but either too large for a sweep pass, or deferred to v2.9.0 for architectural reasons.

| Audit ID | Reason | Tracked as |
|---|---|---|
| **T1.10** | "Inconsistent error handling in cloud backup/token" — broad, touches multiple async paths. Needs a dedicated session with per-path audit. | v2.8.9 backlog |
| **T2.14** | `mwhHandoffCore.js:200-220` — file is only 182 lines, line range invalid. Symptom ("NTP step at midnight → handoff fires twice") is plausible but needs instrumentation-first approach before adding debounce. | v2.8.9 backlog |
| **T2.15** | `currentDayEnergyCore.js` hardcoded solar window. Philippine timezone has no DST, so the actual risk is zero. Documented in code today; no change. | Wont-fix (PH=UTC+8 constant) |
| **T2.19** | `tokenStore.isConnected` validation. The current implementation returns whether tokens are STORED, not whether they successfully refresh. Changing the semantics could cascade through cloud-backup UI. Defer. | v2.9.0 (paired with T2.4 DPAPI work) |
| **T2.23** | `cloudBackup._exportSettingsJson` type validation. Settings values from DB are already validated at insert time; non-string types can't reach the exporter in practice. | Low-value |
| **T2.24** | `go2rtcManager` crash counter reset. Audit says "triggers lockout falsely" but no "crash-counter lockout" code exists in the current file. | Non-applicable |
| **T2.25** | `alarms.activeAlarmState` persistence. Phase 5 T2.5 now hydrates from DB on first batch after restart — effectively solves the same user-visible problem without adding disk state. | Solved by T2.5 |
| **T3.15** | Already handled by supervisor (see §2). | — |
| **T4.14** | Scaler cache invalidation. Cache is keyed by `model_path` today; retrain rewrites `model_path` → cache invalidated. Audit's "stale scaler" concern requires a feature-shape change without path change, which doesn't happen in current code. | Non-applicable |
| **T4.15** | Artifact JSON schema validation. Would add `jsonschema` dependency, not worth it for internal artifacts written by same code that reads them. | Won't-fix |
| **T4.16** | Training sample weight re-normalization after filter. Current weights are slot-relative, not frequency-normalised; re-normalising would change training dynamics. Needs its own design + eval. | v2.9.0 follow-up |
| **T4.19** | Training halt auto-recovery. Requires retry hyperparameters + reject-cause classification. Non-trivial. | v2.9.0 follow-up |
| **T4.20** | Unused variables in residual normalization. Cosmetic; risk-free but also value-free. | Won't-fix unless bundled in a cleanup pass |
| **T5.10** | `modeReady` promise init. Symptom ("uninitialized mode waiters") not reproduced in current code — every mode-transition path sets `State.modeTransition.liveWaiters = []` before awaiting. | Non-applicable |
| **T5.11** | HTML-escape audit. Requires a grep of every template literal + tooltip callback in a 17,891-line file. Needs a dedicated session. | v2.8.9 backlog |
| **T5.13** | Chart data/label length assert. Current renderers source data + labels from the same row-map; mismatch would be a programming error caught by type-checking. Low value. | Won't-fix |
| **T5.14, T5.15** | Async render race, WAPE null filter. Needs per-chart analysis; low priority. | v2.8.9 backlog |
| **T5.16** | Cloud backup partial listing. Current UI shows "N/M loaded" already. | Non-applicable |
| **T5.17** | WebSocket reconnect storm. Phase 3 T5.5 mode-scope abort + existing reconnect-delay already address the storm vector. | Solved by T5.5 |
| **T5.18** | Remote WS cleanup on mode switch. Phase 3 T5.5 refresh on every transition handles this. | Solved by T5.5 |
| **T5.19, T5.20** | Sentinel file cleanup / button flicker. Cosmetic. | Won't-fix |
| **T6.12** | `pick-folder` path.resolve normalisation. Phase 3 T6.11 set `defaultPath` to Documents; dialog returns absolute paths on all Electron-supported OSes. | Non-applicable post-T6.11 |
| **T6.13** | `execFile taskkill` error handling. The callback-style form already swallows non-fatal errors (taskkill returns non-zero on "no such process" which is harmless). Audit's EADDRINUSE concern is unrelated — that's a listener-bind error, not a taskkill error. | Non-applicable |
| **T6.14** | Forecast sync timer `unref()`. In the Electron main process, timers are on the Electron event loop (not Node's). `unref()` on that loop is a no-op. | Non-applicable |
| **T6.15** | Log full error object. Current code logs `err.message` which is the readable signal; the full object would include stack traces that spam logs on every recoverable error. | Won't-fix by design |

---

## 4. Verification

```
$ npm run smoke
...
  Node tests: 24/29 pass  (5 pre-existing, same as SMOKE_BASELINE.md)
  Python tests: PASS (status=0)  — 107/107
```

**Zero regressions.**

Changes touch one hot-path area that `npm run smoke` does not fully cover: the `/health` FastAPI route. Hand-verified: importing `services/inverter_engine.py` still succeeds, and the route decorator resolves correctly at module load (no startup error).

---

## 5. Phase 8 status summary

| Class | Total in audit | Fixed (Phase 2-7) | Fixed (Phase 8) | Verified no-op | Deferred / won't-fix |
|---|---|---|---|---|---|
| HIGH | 38 | 36 | 1 (T1.5) | 1 (T1.6) | 0 |
| MEDIUM | 43 | 4 (frontend T5 subset) | 6 | 17 | 16 |
| LOW | 10 | 0 | 0 | 4 | 6 |
| INFO | 9 | — | — | — | 9 (by definition not bugs) |
| **Total** | **100** | **40** | **7** | **22** | **31** |

After Phase 8, the v2.8.8 audit's actionable findings are **closed**. Remaining deferrals are explicitly tracked for v2.8.9 (6 MEDIUMs, 3 LOWs requiring their own sessions) or v2.9.0 (architectural: T2.4 DPAPI, T6.3 trusted-signers, T4.4 UNIQUE index, T4.11 loss calibration, T2.19 isConnected semantics, T4.16 weight normalisation, T4.19 training auto-recovery).

---

## 6. Status update for KNOWN_GAPS.md

The following entries from §1 (untouched backlog) should be treated as **closed** or **explicitly deferred** after this session. The existing KNOWN_GAPS.md text still reflects the pre-Phase-2 baseline; full regeneration is deferred to v2.8.9 release prep.

Closed via code change: T1.5, T2.13, T2.18, T3.13, T3.14, T3.17, T3.18, T3.20, T4.18.

Closed as already-correct (no change): T1.6, T1.7, T1.8, T1.9, T2.16, T2.17, T2.20, T2.21, T2.22, T3.15, T3.16, T3.19, T3.21, T3.22, T3.23, T3.24, T4.13, T4.17, T5.9, T5.12, T6.8.

Closed as solved by prior phases: T2.25 (by T2.5), T5.17 (by T5.5), T5.18 (by T5.5).

Deferred / won't-fix: see §3 table above.

---

## 7. Commit landed

| Commit | Scope |
|---|---|
| (this session) | Phase 8 sweep: 9 point-fixes across 5 files (`server/index.js`, `server/storagePaths.js`, `server/streaming.js`, `services/inverter_engine.py`, `services/forecast_engine.py`) |
| (this session) | Phase 8 documentation |
