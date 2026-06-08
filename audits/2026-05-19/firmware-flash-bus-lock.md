# Audit — Cross-Process Firmware-Flash Bus Lock

**Date:** 2026-05-19
**Status:** Implemented, independently reviewed (code + safety), hardened,
fully verified. **Live hardware soak still pending operator go-ahead.**
**ROOT-CAUSE CORRECTION (2026-05-19, see §10):** field testing with the
*standalone* tool and the dashboard NOT running still produced
`0x90 error code 2`. The dashboard poller was therefore **not** the cause
of the observed failure; this bus-lock is a valid same-box safeguard but
`error code 2` is the inverter DSP refusing the load (running inverter /
external master), resolved at the inverter, not in software.
**Author:** Engr. M. (implementation assistance: Claude)
**Plan:** [plans/2026-05-19-firmware-flash-bus-lock.md](../../plans/2026-05-19-firmware-flash-bus-lock.md)
**Related:** [audits/2026-05-18/ism-per-node-firmware-upgrade.md](../2026-05-18/ism-per-node-firmware-upgrade.md),
[audits/2026-05-19/firmware-version-comparison.md](firmware-version-comparison.md)

---

## 1. Problem

The standalone calibrator firmware flash and the dashboard's live Modbus
poller are **separate processes that both master the same transparent
TCP→RTU gateway**. During the timing-critical erase-entry the two masters
interleave frames on the shared RS-485 segment and the inverter DSP
rejects the flash start: `Firmware load start (0x90) error code 2` (busy).

Root cause confirmed: the real Modbus master is the Python engine
(`services/inverter_engine.py:9000`, one `poll_inverter`/`slow_poll_inverter`
asyncio task per inverter IP). The calibrator's own `bus_lock` only
serialises its *own* traffic — nothing told the engine to stand down on
the inverter being flashed.

## 2. Fix — fail-open filesystem marker (mirrors `is_write_pending`)

`%PROGRAMDATA%\InverterDashboard\firmware-active.json`. The calibrator is
the **only writer** (claim/heartbeat/release); the engine and the Node
poller are **read-only**.

| Component | File | Role |
|---|---|---|
| Writer + pure filter | `services/firmware_buslock.py` | atomic temp+`os.replace`; `claim`/`heartbeat`/`release`; pure `filter_active`; fail-open `active_ips` |
| Node consumer | `server/firmwareBusLock.js` | read-only; pure `_parseClaims`; fail-open `activeInverterIps`; ~1 s fs-read cache |
| Engine poll skip | `services/inverter_engine.py` | `firmware_flash_active(ip)` (2 s cache) guards both `poll_inverter` and `slow_poll_inverter` |
| Poller suppression | `server/poller.js` | `fwSuspendedInverters` → marks the inverter `maintenance`, drops it from the missing-key sweep and the availability denominator |
| Lifecycle wiring | `services/calibrator_app.py` | `claim` before worker start (TCP only — `link_host` truthy), ~40 s heartbeat daemon, `release` in `finally` |

**Invariant (non-negotiable): FAIL-OPEN.** Any missing / empty / corrupt /
oversized / expired / wrong-shape marker yields **no active claims** →
live polling is never silenced and a true comms outage is never masked.
Serial/RTU flashes pass `host=None` and write no claim (no TCP poller
contention). The hard TTL (120 s, heartbeat-extended) is the real safety
net; `release()` is best-effort.

The flashed inverter is shown as **maintenance**, *not* offline, and is
excluded from the availability denominator so the planned gap is never
charged as downtime or a false comms alarm.

## 3. Independent reviews

Two independent agents reviewed the full change set (code-reviewer +
safety/abuse-focused). Consensus:

- **Fail-open invariant holds** across all four layers (Python writer,
  Node consumer, Python engine, Node poller).
- **Release is guaranteed** — `finally` sets `job["done"]` and calls
  `release()`; even if `release()` throws, the TTL reclaims within 120 s.
- **Atomicity/TOCTOU clean** — `tempfile.mkstemp` + `os.replace`; in-process
  `_LOCK` serialises read-modify-write; idempotent expiry filter.
- **No permanent-suppression / wildcard / cross-job / API-injection /
  parser-crash / deadlock vector.** Each claim is a single literal IP
  (no patterns); `job_id`-scoped upsert prevents cross-job collision;
  no REST surface accepts a caller TTL.
- Zero CRITICAL. The flagged items were a cache-aliasing footgun (HIGH
  as a *future* regression risk, not a live bug), an unbounded TTL if the
  marker were hand-edited (MEDIUM), and an unbounded marker-file read
  (MEDIUM DoS-stall). All three fixed below.

## 4. Hardening applied post-review

| Fix | File | Detail |
|---|---|---|
| TTL hard ceiling | `services/firmware_buslock.py` | `MAX_TTL_S = 3600`; `ttl = max(1, min(int(ttl_s), MAX_TTL_S))` with safe fallback — a corrupt/hand-edited marker can't silence an inverter for years |
| Marker size guard (Py) | `services/firmware_buslock.py` | `_read_raw` returns `None` if `getsize > MAX_MARKER_BYTES` (100 KB) — no parse-bomb |
| Marker size guard (Node) | `server/firmwareBusLock.js` | `statSync().size <= MAX_MARKER_BYTES` gate before `JSON.parse` — poll loop never stalls on a multi-MB file |
| Cache-raw refactor | `server/firmwareBusLock.js` | cache the **raw** parsed marker, not the filtered result; every caller re-runs `_parseClaims` against the live clock — expiry filtering is now non-optional and a future direct-cache consumer can't leak stale claims |

GIL-safe daemon-flag read in the heartbeat thread was reviewed and left
as-is (write-once boolean, read-only in the daemon, idiomatic with the
codebase's other daemon threads — not a defect).

## 5. Verification

| Check | Result |
|---|---|
| `node --check` (firmwareBusLock.js, poller.js) | OK |
| `py_compile` (firmware_buslock.py, inverter_engine.py, calibrator_app.py) | OK |
| `server/tests/firmwareBusLock.test.js` | 7/7 pass (post-hardening) |
| `services/tests/test_firmware_buslock.py` | 8/8 pass (post-hardening) |
| Full `npm run smoke` (pre-hardening) | Node **87/87**, Python **440 passed** |
| Full `npm run smoke` (post-hardening) | Python **440 passed**; Node 86/87 — the single fail is the **pre-existing `better-sqlite3` `NODE_MODULE_VERSION 121 vs 115` ABI ordering flake** in `shutdownSerialization.test.js`, unrelated (bus-lock files import zero SQLite); see [project_better_sqlite3_napi_abi_stable](../../../C:/Users/User/.claude/projects/d--ADSI-Dashboard/memory/project_better_sqlite3_napi_abi_stable.md) |
| Repo ABI end state | Electron (smoke ran `rebuild:native:electron` last — required state) |

The Node ABI flake is environmental and order-dependent (proven before
in `manualPullGuard.test.js`/`stopReasonAggregator.test.js`); the bus-lock
change set does not touch any SQLite path.

## 6. Docs synced

- `docs/ADSI-Dashboard-User-Manual.md` — Firmware Upgrade section: added
  the bus-lock note; corrected stale steps 5–6 (removed the deleted
  type-to-confirm `FLASH <node>` phrase and the redundant browser
  confirm; relabelled to "authorization key").
- `docs/ADSI-Dashboard-User-Guide.html` — same bus-lock note + same
  step 5/6 correction.
- `docs/ADSI-Dashboard-User-Guide.pdf` — regenerated from the HTML.

## 6b. Deep re-verification — integration gaps found & fixed (2026-05-19)

The unit tests are pure (no engine/poller hookup), so a second pass
inspected the actual wiring end-to-end. Two real gaps were found and
fixed; both would have silently degraded the feature, not crashed it.

1. **Poller host-match was normalization-inconsistent and duplicated the
   ip→inv derivation.** `server/poller.js` re-built the mapping with a
   hardcoded `1..27` loop reading raw `ipConfig.inverters[inv]` with only
   `.trim()`, then compared against the raw marker IPs, while the rest of
   the poller resolves identity through `normalizeSourceIp` + the
   `ipConfigLookup.byIp` Map (built one line above). A configured IP or a
   marker `link_host` carrying a `:port` (or any normalization drift)
   would miss the match → `fwSuspendedInverters` empty → the flashed
   inverter **still false-alarms offline and is docked from
   availability** during the flash. **Fix:** normalise the marker IPs
   through the same `normalizeSourceIp`, then intersect with the existing
   `ipConfigLookup.byIp`. No more hardcoded count, single source of truth.
2. **No bus-settle before the very first flash frame.** The claim is
   published before the worker thread starts, but the Python engine
   re-reads the marker on a 2 s cache and the Node poller on a 1 s cache.
   The first frame (`0x90` load-start) is precisely the one the DSP
   rejects with "error code 2" on contention, and it had **no pre-flash
   settle** (the existing 5 s erase margin sits *after* `0x90`, before the
   first `0x91`). A poll cycle could still be in flight when `0x90` went
   out. **Fix:** `_fw_live_worker` now waits ~3.5 s (TCP only,
   abort-aware, with an operator-visible progress line) — longer than the
   longest consumer cache plus the engine's one-poll skip latency — so
   the bus is provably clear before `0x90`. Negligible vs a multi-minute
   flash; serial flashes skip it (no poller contention).

Also verified correct (no change needed): engine guards sit after the
client check and before any unit reads in **both** `poll_inverter` and
`slow_poll_inverter` (mirrors `is_write_pending`); the missing-key sweep
derives `invNum` from the `${inverter}_${unit}` key correctly and
`fwSuspendedInverters` holds matching inverter numbers; calibrator
`claim` precedes `t.start()`, the heartbeat daemon is TCP-gated, and
`release()` is in the worker `finally` with the TTL as backstop.

## 7. Residual risk / next step

Code path is reviewed, hardened and green. The only outstanding item is
the **live hardware soak** (flash a real inverter end-to-end and confirm
the `0x90 error code 2` no longer occurs and the poller cleanly suspends
and resumes that one inverter) — gated on operator go-ahead, consistent
with the firmware-upgrade feature's pre-soak status. No git commit
(operator reviews each commit by hand).

## 10. Root-cause correction — standalone reproduction (2026-05-19)

Field test: standalone calibrator, dashboard NOT running, still fails with
`0x90 error code 2` (host 192.168.1.101, node 1, AAV1003IJK01BC).

- Verified from the ISM decompile IL (`_spike/fw_eng1.txt` IL_0394-03A7):
  `error code 2` == `Cargador.bTramaRx[2] == 2` on the 0x90 echo — the
  inverter DSP's own "will not enter load" status byte, NOT a TCP/socket
  error and NOT produced by any second master per se.
- For FreescaleDSP56F (Motorola, our hardware, argDSP 1-3) the IL takes
  neither the HMSRequireMaster nor Bridge2Transparent path — there is no
  transport pre-handshake we are missing; `Cargar` has no inverter-stop
  step (that lives in the ISM operator workflow).
- In-process the flash holds the registry per-IP `threading.Lock` for the
  ENTIRE `flash_node` (`firmware_transport.py:568 with bus_lock:`), so the
  calibrator's own live-calibration reads are fully serialized and are
  NOT the collision source.
- Therefore the realistic causes are, in order: (1) the **inverter is
  running/grid-connected** and the DSP refuses a reflash until stopped;
  (2) an **external Modbus master the calibrator cannot lock out** —
  ISM/SCADA on another PC, or the dashboard/poller on the *gateway* PC
  (cross-process file lock only de-conflicts a same-machine dashboard);
  (3) wrong node/slave or legacy-0x50 unit.

**Changes made:** (a) `firmware_loader.py` now raises an actionable
`error code 2` message (DSP refused; stop the inverter; clear other
masters) instead of the bare code; (b) the `_fw_live_worker` pre-load
step no longer claims "Waiting for dashboard poller…" — it is reworded to
"Settling the Modbus bus before load-start…" and documented as a
best-effort same-box safeguard, explicitly NOT a dashboard dependency.
Message-only; 74 firmware tests green; no git commit.

## 11. Bidirectional open-order reverification (2026-05-19)

Operator asked to reverify the calibrator and dashboard never conflict
**regardless of which is opened first**, and that resume is seamless.

Planner-agent analysis of all five ordering scenarios + independent
verification found the design sound EXCEPT one real gap the agent
initially missed and which was then confirmed in source and fixed:

- **GAP (fixed): `poll_inverter` issued an UNGUARDED `detect_units_async`
  probe on a cold start.** `services/inverter_engine.py` `poll_inverter`
  did `client = clients.get(ip)` -> `detect_units_async(ip)` (Modbus
  probe) BEFORE its only `firmware_flash_active` guard (deep in the inner
  loop). `slow_poll_inverter` already guarded *before* its detect. So if
  the **calibrator was opened first and a flash was already in progress,
  then the dashboard cold-started**, the engine first action per inverter
  was an unguarded probe -> collision with the in-flight flash. Fixed by
  adding the `firmware_flash_active(ip)` guard immediately after the
  client check and before `detect_units_async` (mirrors slow_poll).
  FAIL-OPEN preserved; backoff `min(interval,1.0)` matches the existing
  inner guard. Both `detect_units_async` call sites (slow_poll:1629,
  poll_inverter pre-detect) are now guarded; no other callers.
- Regression test `services/tests/test_poll_firmware_guard_order.py`
  (static source parse, no engine import) locks the invariant: in BOTH
  poll loops the `firmware_flash_active(ip)` guard MUST precede the first
  `detect_units_async(ip)`. Fails loudly if reordered/removed.
- Independent code-review of the engine change: APPROVED — correct,
  fail-open intact, no hot-path regression, pattern-consistent.

Verified correct WITHOUT change (evidence-checked, not just agent claim):
(1) engine `_fw_active_cache.ts=0.0` forces a fresh marker read on the
first `firmware_flash_active` call -> cold start honours a pre-existing
claim; (2) Node poller `activeInverterIps` + `fwSuspendedInverters`
computed each poll before the missing-key sweep -> cold poller suspends a
pre-claimed inverter on cycle 1; (3) disjoint ports (3500/9000 vs
3600/9200), separate SQLite (adsi.db vs ~/.calibrator), fail-open shared
marker -> opening either app never blocks the other; (4) release/expiry
clears `maintenance` on next good read, excluded from availability while
suspended -> no false offline, no flap, in both orders.

**Conclusion: with the poll_inverter gap fixed, the calibrator and
dashboard do not conflict in EITHER open order, and resume is seamless.**
Message-only standalone clarity fixes from the prior turn remain in
place. No git commit (operator reviews).

## 12. Deeper gap-hunt — calibrator self-block fixed (2026-05-19)

Adversarial lifecycle hunt. Verified directly (not just agent claim):
Node `storagePaths.getNewRoot()` and Python `firmware_buslock._marker_path()`
BOTH resolve to `C:\ProgramData\InverterDashboardirmware-active.json`
— marker-path agreement confirmed (the single highest-risk gap does NOT
exist). Safe (evidence-checked): multi-node (single-node-per-job, IP-keyed
claim, no release-between-nodes window); abort (cooperative flag ->
AbortableTransport raises -> guaranteed `finally` release); engine
restart/map-rebuild (re-reads marker first op); remote mode (gateway-only,
inert); ipConfig drift (operator-error, out of scope). MEDIUM external-kill
-> claim stuck <=120 s is BOUNDED BY THE TTL BY DESIGN (the TTL *is* the
fail-safe) — intentionally not "fixed" (a thread-liveness watchdog would
be over-engineering a TTL-bounded rare case).

**GAP FOUND + FIXED (HIGH): calibrator self-block.** The flash worker
holds the singleton `_registry` `threading.Lock` (`with bus_lock:`) for
the ENTIRE multi-minute flash. SEVEN calibration/identity HTTP routes
(`/calibration/state|write|write-bulk|consign|preflight|full-config`,
`/firmware/identity`) also `lock = _registry.get_lock()` -> during a
flash they would block for minutes (frozen UI, blocked-thread pile-up) —
standalone-reproducible, NO dashboard involved. Fix: new
`_fw_flash_in_progress()` helper (any `_fw_jobs` entry `done is False`,
under `_fw_jobs_lock`) + a uniform fast-fail
`return {"ok": False, "error": "firmware_flash_in_progress"}` inserted
before each of the 7 lock-acquires. Flash STARTER
(`bus_lock = _registry.get_lock()`), `/firmware/job/{id}` and
`/firmware/job/{id}/abort` deliberately NOT guarded (abort must never be
blocked). Locked by static test
`services/tests/test_calibrator_flash_route_guard.py`. Independent
code-review: APPROVE, zero findings (predicate correct, no TOCTOU/
deadlock, prune keeps it from wedging, return shape FE-consistent,
coverage exhaustive). smoke Node 87/87, Py 444 PASS, Electron ABI. No
git commit.
