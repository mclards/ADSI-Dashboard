# Audit 2026-04-17 — Shutdown Serialization Race (scheduled for v2.8.12)

Date: 2026-04-17
Status: SCHEDULED — v2.8.12. Originally scheduled for v2.8.11. v2.8.11 was
reassigned to the hotfix for the integrity-gate asar-virtualization bug
(`audits/2026-04-17/integrity-gate-asar-virtualization.md`) after v2.8.10
was pulled from GitHub.
Discovered during: v2.8.10 deep verification
  (see `audits/2026-04-17/README.md`).

## Symptom

During `npm run smoke` on Windows + Node 24, the test
`server/tests/solcastLazyBackfill.test.js` exits with status `0xC0000409`
(`STATUS_STACK_BUFFER_OVERRUN`, the code Windows uses for a native
assertion failure). The stderr ends with:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

Critically, stdout shows `[Test] All tests passed!` BEFORE the crash — all
11 test assertions succeed. The crash happens inside
`_beginShutdown("embedded")` → `httpServer.close()` → libuv's per-socket
close path, during teardown.

## Why it's a production bug, not just a test flake

`_beginShutdown` at `server/index.js:17333` is the SAME function used in
production by:

- `shutdownEmbedded()` — Electron embedded-server mode (the packaged path).
- `gracefulShutdown()` — dev mode child-process path on SIGTERM/SIGINT.
- The Electron `before-quit` handler at `electron/main.js:1586`.
- The overnight auto-install path and `quitAndInstall()`.

When that function asserts on Windows:

- Operator closes the dashboard → one tick before app exit, libuv aborts.
  Usually invisible because Electron is already tearing down, but the
  Windows Event Log records `Application Error 0xC0000409` and
  `sometimes` surfaces a "stopped working" dialog on slower machines.
- Auto-update flow (`quitAndInstall(true, true)` at
  `electron/main.js:1617`) relies on a clean child exit before NSIS
  overwrites files. A native abort during this window can leave NSIS
  waiting on a stale handle, producing silent update failures that look
  to the operator like "the update did nothing."
- Embedded mode (our default) runs the server in the same process as
  Electron main. The abort can propagate and `app.exit()` races with it,
  occasionally leaving orphaned `go2rtc` / `ffmpeg` processes.

## Root cause

`_beginShutdown` fires five close paths in the same event-loop tick:

| Close path | Async handles touched |
|---|---|
| `stopRemoteBridge()` | AbortController → uv_async_t per in-flight fetch |
| `stopRemoteChatBridge()` | Same — AbortController handles |
| `plantCapController.stop()` | setInterval + internal timer handles |
| `poller.stop()` | clearTimeout on pollTimer |
| `go2rtcManager.stop()` | `taskkill` child spawn → own uv_async_t |
| `httpServer.close()` | uv_tcp_t listener + per-keepalive-socket handles |
| `_flushAndClose()` → `closeDb()` | better-sqlite3 native finalizer |

On Node 24 + Windows, when one handle enters `UV_HANDLE_CLOSING` and
another close-path runs in the same tick and touches it again, libuv's
invariant check at `src/win/async.c:76` asserts and the process aborts
via `_exit(3)`. This is a well-known libuv-on-Windows race documented in
nodejs/node #54491 and libuv #4277.

The `_beginShutdown` function was written for a simpler shape before
AbortController and go2rtc were introduced. Each new subsystem added
another native handle without serializing the close sequence.

## Fix approach (not yet implemented)

Serialize the shutdown across ticks so libuv has time to transition
handles out of `UV_HANDLE_CLOSING` before the next close arrives:

```js
async function _beginShutdown(mode, reason) {
  if (_shutdownPromise) return _shutdownPromise;
  _shutdownCalled = true;
  console.log(`[Server] ${mode === "embedded" ? "Embedded" : "Graceful"} shutdown (${reason || "signal"}): flushing DB...`);

  // Phase 1 (sync, fast): stop new work. No async handles closed.
  stopRemoteBridge();
  stopRemoteChatBridge();
  plantCapController?.stop();

  // Phase 2: yield one tick so AbortController-triggered fetches release
  //          their uv_async_t before we close the http server.
  await new Promise((r) => setImmediate(r));

  // Phase 3: poller + go2rtc (own child process with async handle).
  try { poller.stop(); } catch (_) {}
  try { go2rtcManager.stop(); } catch (_) {}
  await new Promise((r) => setImmediate(r));

  // Phase 4: close HTTP server with a 2 s deadline.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      httpServer.close(() => { clearTimeout(timer); resolve(); });
    } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });

  // Phase 5: DB flush LAST, when no more event-loop traffic can touch it.
  _flushAndClose();
  _shutdownPromise = Promise.resolve();
  return _shutdownPromise;
}
```

Two `setImmediate` yields are the minimum that reliably clears the
`UV_HANDLE_CLOSING` flag in practice. Using `setTimeout(..., 0)` is
equivalent. `process.nextTick` is NOT — it runs before libuv's close
processing.

## Test strategy

1. **Reproduce** — run `server/tests/solcastLazyBackfill.test.js` alone 30
   times on Windows + Node 24. Record failure rate before fix (expected:
   ~100% on affected boxes, ~0% if the race lost the coin flip).
2. **Apply fix** and re-run 30× — expected 0 failures.
3. **Expand**: write `server/tests/shutdownSerialization.test.js` that
   boots the server, spawns 10 concurrent in-flight fetches, then calls
   `shutdownEmbedded()` in a loop to force the race condition. Pre-fix
   fails; post-fix passes.
4. **Smoke** — `npm run smoke` must return to 30/30 Node tests green.
5. **Electron integration** — manually test: normal quit, Restart &
   Install, overnight auto-install, system shutdown. No new dialogs, no
   Event Log errors, clean Python EXE exit confirmed via `tasklist`.

## Scope boundary (why NOT in v2.8.10)

v2.8.10 is a focused power-loss-resilience release. Bundling the
shutdown-race fix would:

- Conflate two failure modes in release notes, making rollback ambiguous.
- Add risk to a patch that currently has high test coverage for its
  narrow scope.
- Require testing the full Electron auto-update flow twice (once for
  power-loss recovery, once for shutdown).
- Delay the field fix for the PXE incident that triggered v2.8.10.

Both fixes are additive — the shutdown-race fix does not depend on any
v2.8.10 code. v2.8.12 can be cut as soon as v2.8.11 is stable in the
field (target: 1-2 weeks after v2.8.10 release).

## Related files

- `server/index.js:17333-17373` — `_beginShutdown` (the code to refactor)
- `server/index.js:17402-17422` — `gracefulShutdown`, `shutdownEmbedded`
  wrappers (unchanged; they delegate to `_beginShutdown`)
- `server/index.js:17424-17429` — signal handlers
- `server/index.js:17435-17442` — `process.on("exit")` and
  `uncaughtException` safety nets (unchanged)
- `electron/main.js:1586-1597` — `before-quit` hook
- `electron/main.js:1382-1422` — `stopRuntimeServices` (separate; handles
  tearing down Python child processes and embedded server together)
- `server/tests/solcastLazyBackfill.test.js` — reproduces the race
  reliably on Windows

## Plan

See `plans/2026-04-17-shutdown-serialization.md`.
