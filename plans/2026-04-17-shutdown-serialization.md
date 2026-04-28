# Plan 2026-04-17 — Shutdown Serialization (v2.8.12)

Date: 2026-04-17
Status: SCHEDULED — to be executed AFTER v2.8.11 is stable in the field.
Target release: v2.8.12.
Audit: `audits/2026-04-17/shutdown-race.md`.

History: originally scheduled for v2.8.11. v2.8.11 was reassigned to the
hotfix for the packaged-build integrity gate bug
(`audits/2026-04-17/integrity-gate-asar-virtualization.md`) after v2.8.10
was pulled from GitHub. This plan now ships as v2.8.12.

## Goal

Eliminate the Windows + Node 24 libuv `UV_HANDLE_CLOSING` assertion
during dashboard shutdown. Outcome:

- `npm run smoke` returns to 32/32 Node tests green.
- No `Application Error 0xC0000409` entries in the Windows Event Log
  after normal dashboard quit, Restart & Install, overnight auto-install,
  or system shutdown.
- `autoUpdater.quitAndInstall()` always sees a clean child exit;
  subsequent NSIS install completes without the silent-failure mode
  described in the audit.
- No orphan `go2rtc.exe` / `ffmpeg.exe` / Python EXE processes after quit.

## Non-goals

- No behavior change for healthy shutdowns that already complete within
  2 s. The 2 s `httpServer.close` deadline stays.
- No change to the power-loss-resilience chain shipped in v2.8.10. The
  shutdown path uses `_flushAndClose()` which is also v2.8.10's crash-
  safe DB close; that contract stays intact.
- No change to the signal-handler registration in
  `server/index.js:17424-17429` or the Electron `before-quit` hook in
  `electron/main.js:1586-1597`. Those call into the same refactored
  `_beginShutdown` and do not need their own rewrites.

## Architecture — 5 phases inside `_beginShutdown`

See `audits/2026-04-17/shutdown-race.md` §"Fix approach" for the full
reference implementation. Summary:

| Phase | What runs | Async-handle cost |
|---|---|---|
| 1 (sync) | `stopRemoteBridge`, `stopRemoteChatBridge`, `plantCapController.stop` | Schedules AbortController fires |
| yield | `await setImmediate` | Let uv drain in-flight handle closes |
| 2 | `poller.stop`, `go2rtcManager.stop` | Timers cleared; child process spawn |
| yield | `await setImmediate` | Let taskkill's uv_async_t close |
| 3 | `httpServer.close(deadline=2 s)` | TCP listener + keepalive sockets |
| 4 | `_flushAndClose()` | better-sqlite3 native finalizer |

The serialized sequence guarantees each handle fully transitions out of
`UV_HANDLE_CLOSING` before the next close-path touches it.

## Invariants

S1. The DB must still be flushed on all exit paths — including
    `uncaughtException` and `process.on("exit")`. Those handlers at
    `server/index.js:17435-17442` continue to call `_flushAndClose()`
    directly (synchronous path, no `await`), unchanged.

S2. Shutdown must complete within ~3 s in the happy path (2 s
    `httpServer.close` deadline + 2 × `setImmediate` yields). Electron's
    `APP_SHUTDOWN_WEB_TIMEOUT_MS = 5000` ceiling at `electron/main.js:137`
    stays above that.

S3. The function must be safe to call multiple times. The
    `if (_shutdownPromise) return _shutdownPromise` guard at the top is
    preserved; the refactor swaps the promise-wrapped body for an async
    function that returns the same memoized promise.

S4. `shutdownEmbedded()` and `gracefulShutdown()` wrappers remain one-
    liners that delegate to `_beginShutdown(mode, reason)`. Callers
    outside the file see no API change.

S5. Power-loss-resilience artifacts (v2.8.10):
    - `startupIntegrityResult` is unaffected — it's read at startup, not
      at shutdown.
    - The two-slot rotating backup at
      `server/index.js:17425 runPeriodicBackup` is unaffected.
    - The Electron integrity gate is unaffected — it runs at boot.

## Execution order

1. **Reproduce baseline** (Day 1).
   - Run `solcastLazyBackfill.test.js` 30 times on the staging Windows
     PC. Record pass/fail rate. Expected: 100% fail on affected boxes.
   - Capture one full stack trace via `node --abort-on-uncaught-exception`
     + a native-debugger minidump to confirm the exact handle type at
     fault. (Expected: AbortController-owned uv_async_t.)
2. **Implement** the 5-phase refactor (Day 1).
   - Edit `server/index.js:17333-17373` (`_beginShutdown`) only.
   - No change to wrappers or signal handlers.
3. **Unit test** (Day 2).
   - New `server/tests/shutdownSerialization.test.js`:
     - Boots the embedded server on a random port.
     - Kicks off 10 concurrent in-flight `fetch(/api/live)` calls.
     - Calls `shutdownEmbedded()` while they're in flight.
     - Asserts clean promise resolution, no abort, DB file closed
       (WAL file absent, main file header valid).
     - Repeats 20 times in a loop.
4. **Stability run** (Day 2).
   - Re-run `solcastLazyBackfill.test.js` 30 times. Expected: 0 failures.
   - `npm run smoke` → 30/30 Node, 107/107 Python.
5. **Electron integration** (Day 3 — manual on staging PC).
   - Normal window close → clean exit, nothing in Event Log.
   - `Restart & Install` path → installer runs, app relaunches, no
     orphan Python EXE.
   - Overnight scheduled install → same, confirmed via `tasklist` after
     relaunch.
   - Windows restart → clean shutdown in the Event Log's System log.
6. **Documentation** (Day 3).
   - Update `audits/2026-04-17/shutdown-race.md` with `Status: FIXED`,
     add the commit SHA + verification matrix.
   - Add a paragraph to `docs/ADSI-Dashboard-User-Manual.md` §10
     troubleshooting removing the "dashboard sometimes crashes on quit"
     line (once field verification confirms).
7. **Version bump + release** (Day 4).
   - `package.json` 2.8.11 → 2.8.12.
   - Rebuild Python EXEs is NOT required (no Python changes).
   - `npm run build:installer:signed`.
   - Cut GitHub release v2.8.12.
   - CLAUDE.md version line updated.

## Risk

| Risk | Mitigation |
|---|---|
| New race introduced by the `await` (async function becomes multi-tick) | Keep the `_shutdownPromise` memoization. All callers already `await` / chain off the returned promise. |
| 3 s shutdown becomes user-visible (window lingers before close) | 2 s `httpServer.close` deadline is unchanged; 2 × setImmediate is sub-millisecond. Net change in happy-path shutdown: 0 ms perceptible. |
| Electron `before-quit` event.preventDefault + requestAppShutdown path assumes synchronous return | It already returns a Promise (`requestAppShutdown` at `electron/main.js:1529`). No change. |
| Regression in auto-update path | Run the full Restart & Install + overnight install matrix before release. |
| Python EXE shutdown-order (separate concern) | Out of scope. `waitForProcessGone` at `electron/main.js:1455` already handles that via polling. |

## Verification matrix (for the release notes)

| Scenario | Pre-fix | Target |
|---|---|---|
| `npm run smoke` Node tests | 29/30 | 30/30 |
| `solcastLazyBackfill.test.js` alone | ~0% pass | 30/30 pass |
| Normal dashboard quit, Windows Event Log | Occasional 0xC0000409 | Zero |
| Restart & Install round-trip | Occasional silent failure | 100% success |
| Overnight auto-install | Occasional silent failure | 100% success |
| Orphan processes after quit | Occasional | Zero |
| `shutdownSerialization.test.js` (new) | n/a | 20/20 loops green |

## Rollback plan

- v2.8.12 is additive over v2.8.11 (shutdown path refactor + 1 new test).
- If field telemetry shows a regression, revert the single commit
  touching `server/index.js:17333-17373`. All other v2.8.10 behavior
  persists (power-loss resilience, integrity gate, auto-restore).
- Operator recovery is the same as any bad release: re-install the
  last-good installer stashed by v2.8.10 at
  `C:\ProgramData\InverterDashboard\updates\last-good-installer.exe`
  (which will be v2.8.10 if that was the previous version).

## Open questions (to resolve during implementation)

1. Should Phase 2's yield happen BEFORE or AFTER `go2rtcManager.stop()`?
   The stop() spawns a `taskkill` child — does its uv_async_t need to
   clear before `httpServer.close()`? The reference implementation puts
   go2rtcManager in Phase 2; if testing shows it still races with
   phase 3, move it to its own phase with another yield.
2. Is `plantCapController.stop()` synchronous? Need to inspect. If it
   returns a Promise it must be awaited in phase 1.
3. Does `stopRemoteBridge()` also need a yield to let its keep-alive
   agent's sockets drain? Currently assumed no (TLS keep-alive handles
   close inline). Testing will confirm.
