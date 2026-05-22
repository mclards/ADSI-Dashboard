# Plan — Cross-Process Firmware-Flash Bus Lock

**Date:** 2026-05-19
**Status:** Implemented + reviewed + hardened — 2026-05-19. Live hardware
soak still pending operator go-ahead. Audit:
[audits/2026-05-19/firmware-flash-bus-lock.md](../audits/2026-05-19/firmware-flash-bus-lock.md)
**Author:** Engr. M. (implementation assistance: Claude)
**Goal:** Stop the dashboard's live poller from contending on the Modbus
bus with the standalone calibrator while it flashes an inverter's
firmware. Symptom: `Firmware load start (0x90) error code 2` (DSP busy)
because two independent Modbus masters interleave frames through the same
transparent TCP→RTU gateway during the timing-critical erase-entry.

---

## 1. Root cause (verified)

- The actual Modbus master is the **Python engine**
  `services/inverter_engine.py` (:9000), one `poll_inverter(ip)` /
  `slow_poll_inverter(ip)` asyncio task per inverter IP
  ([inverter_engine.py:1645/1561](../services/inverter_engine.py)).
- The **calibrator** is a separate process (`calibrator_app.py` :9200 via
  `calibratorServer.js` :3600) flashing one inverter via the same gateway
  IP. Its `bus_lock` only serialises **its own** traffic
  ([firmware_transport.py:568](../services/firmware_transport.py)).
- Nothing tells the engine to stop polling the inverter being flashed →
  concurrent masters → DSP `error code 2` on `0x90`
  ([ism-per-node-firmware-upgrade.md §8](../audits/2026-05-18/ism-per-node-firmware-upgrade.md)).
  This is exactly the pre-soak risk flagged in
  `project_firmware_feature_status`.

## 2. Design — fail-open marker, mirrors `is_write_pending`

A flash job publishes a **claim** in a shared JSON marker; the engine
skips Modbus for a claimed inverter exactly like the existing, proven
`is_write_pending(ip)` guard ([inverter_engine.py:768/1709](../services/inverter_engine.py));
the Node poller treats a claimed inverter as **planned maintenance** (no
offline alarm, not counted as downtime). Every failure mode is
**fail-open** (no/garbled/stale marker ⇒ normal polling).

### 2.1 Marker

`%PROGRAMDATA%\InverterDashboard\firmware-active.json` (same dir as
`firmware-audit.jsonl`; writable by Node + both Python services):

```json
{ "claims": [ { "inverter_ip":"192.168.1.101", "node":1, "slave":1,
                "job_id":"fw-ab12", "pid":1234,
                "started_ms":0, "expires_ms":0 } ] }
```

- A claim is **active** iff `expires_ms > now`.
- Atomic write: temp file + `os.replace`. Readers tolerate
  missing/empty/corrupt → **no claims** (never silence polling on a bad
  file). Hard TTL (default **120 s**) bounds even a crashed job; a live
  job heartbeats every TTL/3.
- Only the **calibrator** writes; engine + poller are **read-only**
  (single-writer — calibrator flashes one node at a time via its single
  transport registry). Writes still merge+drop-expired so a stale
  concurrent write self-heals next heartbeat.
- TCP only: a claim is written only when the flash link is a gateway IP
  (`link_host`). A serial/RTU flash has no IP the TCP poller contends
  with, so no claim is needed.

### 2.2 Components

| Unit | Change |
|---|---|
| `services/firmware_buslock.py` (NEW) | `claim/heartbeat/release(job_id…)`, `active_ips(now_ms)->set`, atomic write, fail-open read |
| `services/inverter_engine.py` | `_firmware_active_ips()` (≤2 s cached); in `poll_inverter` + `slow_poll_inverter`, before any Modbus this cycle: if `ip` claimed → `await asyncio.sleep(min(interval,1)); continue` (mirrors `is_write_pending`) |
| `server/firmwareBusLock.js` (NEW) | read-only; pure `_parseClaims(raw, now)` (unit-tested, no FS) + `activeInverterIps(now)` (mtime+interval cached, fail-open) |
| `server/poller.js` | each tick map claimed IPs→inverter numbers via ipConfig; in the missing-key sweep skip `markMissingKey` for suspended keys + clear `unreachableState` + set `liveData[key].maintenance=1`; exclude suspended inverters from the availability `expectedInverters` set |
| `services/calibrator_app.py` | `/firmware/flash`: after job row, if `link_host` → `claim(...)`; `_fw_live_worker`: daemon heartbeat thread until `job["done"]`; `finally` → `release(job_id)` (covers success/fail/abort/crash) |
| `public/index.html` | one concise line in the existing FW modal warning banner: target inverter polling auto-suspends during the flash and resumes after |

### 2.3 Safety properties

1. **Fixes the bug at the wire** — the engine (the real master) stops
   issuing Modbus to the flashed inverter; calibrator becomes sole
   master.
2. **No false outage** — poller doesn't `markMissingKey` a suspended
   inverter ⇒ no `offline` broadcast / comms alarm; it's excluded from
   the availability denominator ⇒ a planned flash is not counted as
   downtime (mirrors how an unconfigured inverter is excluded).
3. **Fail-open everywhere** — any marker read error ⇒ empty set ⇒
   unchanged polling. A crashed/aborted job's claim expires within the
   TTL and polling auto-resumes; `finally`-release makes the normal case
   instant.
4. **Minimal blast radius** — only the one flashed inverter IP is
   affected; all others poll normally. Engine guard is a copy of the
   already-proven `is_write_pending` skip shape.
5. **No new network coupling** — filesystem marker works whether or not
   the dashboard is running (standalone field use unaffected).

## 3. Tests

- `server/tests/firmwareBusLock.test.js` — pure `_parseClaims`: active
  vs expired, corrupt/empty/missing → `[]`, multi-claim, IP-set, `now`
  boundary. ABI-agnostic (no better-sqlite3), auto-discovered by smoke.
- `services/tests/test_firmware_buslock.py` — claim→active_ips→heartbeat
  (extends expiry)→release roundtrip; expiry; corrupt file fail-open;
  atomicity (no partial read).

## 4. Verification

`node server/tests/firmwareBusLock.test.js`; `py_compile` +
`node --check` on every edited file; full `npm run smoke` (Node must
stay green, pytest includes the new Python test); then independent
code-review + a safety review of the live-polling change.

## 5. Out of scope

- Pausing the *entire* dashboard (unnecessary — per-inverter is precise).
- Serial/RTU contention (no shared master).
- Auto-stopping the inverter before flash (operator/ISM-field procedure;
  this plan only removes the *software* contention).

## 6. Constraints

- No git commit (`feedback_no_auto_commit`).
- Do not break live polling/reporting — guard is additive, fail-open,
  mirrors `is_write_pending`.
- `git check-ignore` sweep before handoff.
