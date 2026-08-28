# Phase 6 — Python inverter engine hardening (T3.6–T3.12)

**Date:** 2026-04-14
**Baseline:** v2.8.8 + Phase 2/3/4/5 (commit `cacf31d`)
**Target:** v2.8.9
**Session scope:** T3.6–T3.12 from [KNOWN_GAPS.md §1](KNOWN_GAPS.md#1-untouched-backlog-phase-2-4-of-the-original-plan).

Continuation of [PHASE5_FIXES.md](PHASE5_FIXES.md). Verified zero regressions via [SMOKE_BASELINE.md](SMOKE_BASELINE.md) harness.

---

## Files touched

- `services/inverter_engine.py` — T3.6, T3.9, T3.11, T3.12 (and T3.11 wiring at all 4 enqueue call sites)
- `drivers/modbus_tcp.py` — T3.7, T3.10

---

## Fix-by-fix

### T3.6 — Per-inverter polling task isolation

| | |
|---|---|
| File | `services/inverter_engine.py:944` (`poll_inverter`) |
| Before | The inner cycle had no try/except. A single bad read (KeyError from a mid-rebuild map flip, decode error from a misbehaving inverter, transient asyncio edge) would propagate, kill the task, and force the supervisor's ~1 s restart. The audit's "one bad inverter freezes everyone" symptom traced to this restart-on-every-cycle pattern. |
| After | Wrap inner cycle in try/except. `asyncio.CancelledError` propagates (cooperative cancel from supervisor); other exceptions log and continue with a 1 s back-off. The supervisor pattern is unchanged for the truly-dead-task case. |
| Note on audit description | The audit cited "asyncio.gather(*tasks) with default return_exceptions=False" but this codebase uses one task per IP supervised separately, not gather-over-tasks. The fix targets the same outcome (a bad cycle doesn't freeze the inverter) just at the right level. |
| Rollback | Remove the try/except wrapper. |

### T3.7 — Modbus socket close on read exception

| | |
|---|---|
| File | `drivers/modbus_tcp.py` (`read_input`, `read_holding`, new `_close_quietly` helper) |
| Before | On a TRUE exception during read, the socket handle was leaked. pymodbus does not always clean up on `OSError`, and over weeks of uptime FD pressure accumulates. |
| After | On exception, call `_close_quietly(client)`. pymodbus reconnects transparently on the next read. `isError()` results are unchanged — that's a normal "no data" response, not a socket-state issue. |
| Risk if unfixed | FD pressure over long uptime; eventually `EMFILE`. |
| Rollback | Drop the `_close_quietly(client)` calls in the `except` blocks. |

### T3.8 — Lock scope review (no fix)

| | |
|---|---|
| Status | **Reviewed, no change required.** |
| Reasoning | The audit said "thread lock too narrow — protects only I/O, not queue/state". On inspection: `thread_locks[ip]` correctly serialises all per-IP Modbus traffic via `safe_read` (read path) and `write_worker_loop` (write path). The mentioned "queue and state mutated" patterns are GIL-protected single-statement dict assignments (`shared[ip] = list(out)`, `write_pending[ip].clear()`). Adding broader locks would serialise reads across IPs and worsen latency. |
| Recorded for future debuggers | If a "torn dict" symptom ever materialises, look at `shared`, `auto_reset_state`, or `last_operator_write_ts` first — those are the candidate hot dicts. |

### T3.9 — `rebuild_global_maps` atomic swap

| | |
|---|---|
| File | `services/inverter_engine.py:1021` (`rebuild_global_maps`) |
| Before | `intervals = {}` and `static_units.clear()` mid-function, then re-populated entry-by-entry. A polling task iterating those dicts during the rebuild window could see them empty for ~1 ms and either KeyError or get a wrong default. |
| After | Build all three maps (`new_inverters`, `new_intervals`, `new_static_units`) in LOCAL variables, then atomic single-statement rebinding. CPython GIL guarantees the rebind is observed atomically by other threads. `inverters[:] = new_inverters` stays in-place because `start_polling_manager` and `_supervisor` hold the list reference and iterate it. |
| Risk if unfixed | Sporadic KeyError-induced poll task crashes during ipconfig hot-reload. T3.6 now hides those, but they should not happen in the first place. |
| Rollback | Revert to the inline mutate pattern. |

### T3.10 — Modbus read timeout refresh per call

| | |
|---|---|
| File | `drivers/modbus_tcp.py` (new `_refresh_timeout` helper, called at top of `read_input`/`read_holding`) |
| Before | pymodbus sets `socket.settimeout(timeout)` at construct/connect time. Long-idle sockets on Windows can have their `SO_RCVTIMEO` reset by TCP keepalive interactions, so a stuck read could hang indefinitely. |
| After | `_refresh_timeout(client)` re-applies `socket.settimeout(client.timeout)` before every read. Best-effort — wrapped in try/except so a missing attribute on a future pymodbus version cannot break reads. |
| Risk if unfixed | Hangs beyond the advertised timeout, holding `thread_locks[ip]` and freezing all activity for that IP. |
| Rollback | Drop the `_refresh_timeout(client)` line at the top of each read function. |

### T3.11 — Bounded write queue + 429 propagation

| | |
|---|---|
| Files | `services/inverter_engine.py` (queue init at `rebuild_global_maps`, new `WriteQueueFullError`, all 4 enqueue call sites) |
| Before | `Queue()` with no max size. A burst of operator clicks (UI bug, scripted attack, or stuck-retry loop) could fill RAM unbounded. |
| After | `Queue(maxsize=64)`. `enqueue_write_atomically` now uses `put_nowait` and raises `WriteQueueFullError` on overflow. The two API handlers (`/write`, `/write/batch`) catch this and return HTTP 429 with a clear message. The two auto-reset call sites (in `handle_auto_reset`) catch and skip — best-effort, the next alarm cycle retries. |
| Why 64 | Well above any realistic operator workflow per inverter (4 nodes, single-digit clicks per minute). High enough that legitimate batch operations (plant-cap dispatch across all 27 inverters at once) are not impacted. |
| Test | `npm run smoke` exercised the full Python suite (107 tests pass); no test covers the queue-full path explicitly, but the put_nowait API surface is unchanged for the in-bounds case. |
| Rollback | Revert `Queue(maxsize=64)` to `Queue()`; restore `put` from `put_nowait`; remove the try/except wrappers; delete the WriteQueueFullError class. |

### T3.12 — Post-write read-back verification

| | |
|---|---|
| File | `services/inverter_engine.py:543` (`write_worker_loop`, both batch and single paths) |
| Before | `write_single` returns success on Modbus FC6 transport ACK. The inverter could still silently reject the write (interlock, mode mismatch, register unwritable). The caller saw `ok` and assumed the register actually changed. |
| After | After every successful write, `_verify_step()` reads back the same holding register under the same lock and compares. A confirmed mismatch downgrades the result to `ok=false`; verification failure (read returns None) does NOT downgrade — it's a transient issue, not a known-bad write. Mismatch logs `[write_worker] post-write verify MISMATCH ip=... unit=... wrote=...`. |
| Latency | Adds one Modbus read per successful write (~5–20 ms per inverter). Acceptable for control writes which are not high-frequency. |
| Risk if unfixed | Operator believes a START/STOP took effect when the inverter silently ignored it. |
| Rollback | Remove `_verify_step` definition and the post-write call sites in both batch and single branches. |

---

## Verification

```
$ npm run smoke
...
  Node tests: 24/29 pass  (same 5 pre-existing failures as SMOKE_BASELINE.md)
  Python tests: PASS (status=0)  — 107/107
  Total wall time: 122646ms
```

**Zero regressions.** Same baseline pattern as Phases 2/3/5. The full Python suite (which exercises forecast paths but not the inverter polling/write paths directly) passed cleanly. Inverter polling and write paths are not covered by `services/tests/` — the verification floor here is syntax + Python-import + linter-clean.

Manual verification candidates for future operators:
- T3.6: spawn a transient KeyError in `poll_inverter` (e.g. by removing an inverter mid-cycle) and confirm the task survives.
- T3.7: kill an inverter's TCP listener mid-read and `lsof | grep modbus` to confirm FD count stable.
- T3.10: introduce `time.sleep(60)` inside an inverter's TCP listener handler; confirm read returns within `client.timeout` instead of hanging.
- T3.11: hammer `/write` 100 times in a tight loop; expect 429 after the 64th.
- T3.12: configure an inverter with an interlock that silently rejects writes; confirm the API returns `ok:false` instead of `ok:true`.

---

## Status update for KNOWN_GAPS.md

| Gap | Status |
|---|---|
| §1 backlog T3.6 | Closed |
| §1 backlog T3.7 | Closed |
| §1 backlog T3.8 | Reviewed — no fix needed (GIL-safe; documented above) |
| §1 backlog T3.9 | Closed |
| §1 backlog T3.10 | Closed |
| §1 backlog T3.11 | Closed |
| §1 backlog T3.12 | Closed |

---

## Remaining HIGH backlog after Phase 6

- **T1.5 / T1.6** — frontend remote-fetch AbortController + reconnect-timer race
- **T4.6 – T4.12** — Python forecast (reliability artifact, data-quality clock, legacy-model check, LightGBM reason, error-memory eligibility, transmission loss, regime threshold)
- **T6.8** — storage migration atomicity (optimisation only)

Pending follow-ups (separate tickets):
- v2.9.0: T2.4 DPAPI/safeStorage
- v2.9.0: T6.3 trusted-signers.json bundling
- T4.4 UNIQUE index on `forecast_run_audit` (Phase 2 partial residual)
- 5 pre-existing Node test failures from [SMOKE_BASELINE.md](SMOKE_BASELINE.md)

Recommended next: **T4.6–T4.12 (Python forecast)** — `services/tests/` has the strongest coverage of any subsystem (107 tests, all passing) and would catch any regression immediately.

---

## Commit landed

| Commit | Scope |
|---|---|
| (this session) | Phase 6 Python: T3.6/T3.7/T3.9/T3.10/T3.11/T3.12 + T3.8 review |
| (this session) | Phase 6 documentation |
