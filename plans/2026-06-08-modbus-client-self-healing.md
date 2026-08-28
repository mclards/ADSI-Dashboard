# Plan: Self-healing Modbus client recovery + manual Reconnect (AAX0041 comms-wedge fix)

**Date:** 2026-06-08
**Status:** Approved — implementing
**Author:** Engr. M. (via Claude Code)
**Scope:** `services/inverter_engine.py`, `server/index.js`, `public/index.html`,
`public/js/app.js`, new `services/tests/test_client_rebuild.py`, User Guide (HTML/MD/PDF).

---

## Problem

Field symptom on the 27-inverter ring (Ingeteam **AAX0041** Ethernet→RS-485 comm
board → Advantech switch → Mikrotik RB750r → gateway PC): polling for an inverter
fails ("nodes cannot be fetched") while the IP is still pingable. Rebooting the
comm board does **not** recover it; **changing the inverter's IP does**.

### Root cause (code-confirmed)

The per-IP `ModbusTcpClient` is created once and cached for the entire
`InverterCoreService` process lifetime (`clients[ip]`,
`services/inverter_engine.py:1955-1961`). The only failure recovery is
`close()`/`connect()` on that **same object**, to the **same IP**
(`safe_read:766-786`, `drivers/modbus_tcp.py:80-100`). A genuinely fresh client
object is only ever constructed for an IP **not already in `clients`**
(`rebuild_global_maps:1954-1961`).

Therefore, when the cached client/socket/flow reaches a state that
`close()`/`connect()` cannot clear (pymodbus 2.5.3 sync-client wedge, or an
IP-keyed black-hole on the path), the **only** way to force a brand-new client
object is to make the IP look new — i.e. change the inverter IP. That is exactly
the operator's workaround, and it explains why a comm-board reboot (same IP →
same cached object) does nothing.

Confirmed secondary bug: the `[WATCH] modbusTimeout changed — rebuilding clients`
path (`inverter_engine.py:2754-2756`) calls `rebuild_global_maps()`, which
**skips IPs already in `clients`** — so a Modbus-timeout setting change never
reaches existing inverters.

### Contributing factors (manual-confirmed)

- Read timeout is `_modbus_timeout = 1.0 s` (`inverter_engine.py:226`). The
  AAX0041 manual (p.28) states 27 nodes share one 9600 bps RS-485 ring, with a
  100 ms inter-request gap and a single no-priority queue serving all TCP
  clients; under congestion a response can exceed 1.0 s → timeout → wedge
  trigger. **Decision:** keep the 1.0 s default (best for the 4-node product
  baseline); Fix B makes the per-site `modbusTimeout` setting effective so this
  ring can be set to ~2.0 s. The self-healing rebuild is timeout-agnostic.
- Multiple masters on port 502 (poller, write worker, calibrator). Intra-app
  reads/writes to one IP are already serialized by `thread_locks[ip]`, and the
  calibrator is gated by `firmware_buslock`. No change needed.

---

## Changes

### Fix A — Failure-driven per-IP client rebuild (`services/inverter_engine.py`)

Constants near the dead-node-backoff block (~L271):

```
IP_REBUILD_AFTER_S        = 30.0   # zero successful reads on an IP this long -> rebuild
IP_REBUILD_MIN_INTERVAL_S = 60.0   # never rebuild the same IP more often than this
DISABLE_IP_CLIENT_REBUILD = env flag (fail back to current behavior)
_ip_health = {}   # ip -> {"last_success": monotonic, "last_rebuild": monotonic}
```

Pure decision function (unit-testable, mirrors `rtc_year_valid` style):

```
def should_rebuild_client(now, last_success, last_rebuild, disabled, write_pending, fw_active):
    if disabled or write_pending or fw_active: return False
    if (now - last_success) < IP_REBUILD_AFTER_S: return False
    if (now - last_rebuild) < IP_REBUILD_MIN_INTERVAL_S: return False
    return True
```

Async helper (single code path, reused by Fix B and Fix C):

```
async def rebuild_ip_client(ip, reason):
    new = await loop.run_in_executor(executor, create_client, ip, 502, _modbus_timeout)
    lock = thread_locks.get(ip)
    with lock:                       # serialize against in-flight write-worker frame
        old = clients.get(ip)
        try: old and old.close()
        finally: clients[ip] = new
    mark last_rebuild; clear this IP's _unit_health; log "[POLL] {ip} client rebuilt ({reason})"
```

Poll-loop hook (end of cycle, ~L1870): track `last_success` when `out` is
non-empty; otherwise, if `should_rebuild_client(...)` → `await rebuild_ip_client`.
Skips when write-pending / firmware-flash active.

Teardown (~L1991 removed-IP block): `_ip_health.pop(ip, None)`.

### Fix B — `modbusTimeout` change rebuilds existing clients (`inverter_engine.py:2754`)

Replace the no-op `rebuild_global_maps()` call with a loop of
`rebuild_ip_client(ip, "modbusTimeout change")` over existing inverters so the
new timeout takes effect and operators gain a no-IP-change recovery lever.

### Fix C — Manual "Reconnect" (engine + server + UI)

- **Engine:** `@app.post("/reconnect/{inverter}")` → `_check_bulk_auth` →
  resolve `ip_map[inverter]` → `await rebuild_ip_client(ip, "operator reconnect")`
  → `{inverter, ip, ok:true}`.
- **Server (`server/index.js`):** `POST /api/reconnect/inverter/:inverter`
  mirroring `/api/sync-clock/inverter/:inverter`: remote-proxy passthrough,
  per-origin-IP rate-limit (10 s), forward to
  `${INVERTER_ENGINE_BASE_URL}/reconnect/:inv` with `_currentAdsiKey()` injected
  upstream, audit_log action `comms-reconnect`. Auth-free at the operator prompt
  (socket rebuild changes no inverter state — "2-type model" like per-inverter
  clock sync).
- **UI (relocated 2026-06-08 per operator):** the manual control lives on each
  **IP Configuration** row (`public/ip-config.html`) as a circular **Reconnect**
  button next to Save → `reconnectInverter(num)` → `POST /api/reconnect/inverter/:num`.
  (The earlier Settings → Inverter Clocks button was reverted.) IP Config is
  already gated by IP-config auth to open, so no extra prompt.

### Fix D — "Open device web page" works in gateway AND remote

The IP Config gear icon (`openInverter`) previously called
`electronAPI.openIP(ip)`, which is a no-op in a plain browser and, in a remote
Electron viewer, runs the reachability/open on the remote PC (can't reach the
plant-LAN device). New behavior:

- **Remote viewer:** `window.open("/api/comm-proxy/<ip>/")` → the viewer's local
  app (loopback, token-exempt) hands off via `proxyToRemote` to the gateway with
  the remote token injected → the gateway reverse-proxies the device.
- **Gateway + Electron:** unchanged `electronAPI.openIP(ip)` (native window +
  reachability check).
- **Gateway + plain browser:** `window.open("http://<ip>/")` directly on the LAN.

New gateway route `app.use("/api/comm-proxy/:ip", …)` (`server/index.js`):
remote-mode → `proxyToRemote`; gateway-mode → reverse-proxy to `http://<ip>/<tail>`
with **SSRF guard** (`_isConfiguredInverterIp` — only IPs in current ipconfig),
`<base>` + root-absolute URL rewrite (`_rewriteCommHtml`), `Location` rewrite,
8 s AbortController timeout, binary passthrough via `arrayBuffer`. Sits behind
`remoteApiTokenGate`. Known limitation: the remote hop streams text via
`proxyToRemote.text()`, so very image-heavy device pages may not render every
binary asset over the remote link (HTML/CSS/JS are fine).

### Tests / Guide

- `services/tests/test_client_rebuild.py` — branch coverage of
  `should_rebuild_client`.
- User Guide HTML + MD + regenerated PDF: one subsection on auto-recovery + the
  Reconnect button.

---

## Concurrency safety

Rebuild swap under `thread_locks[ip]`; blocking `connect()` runs in the executor
before the lock; `clients[ip] = new` is atomic under the GIL; rebuild is
rate-limited to ≤1 / 60 s / IP (powered-off inverter harmless).
`DISABLE_IP_CLIENT_REBUILD=1` fully reverts.

## Validation

Python smoke via `sub_smoker` (expect 96/98 green per known libuv-teardown
crashes). Node syntax/smoke for `index.js`. No Electron-ABI involvement.

## Rollout

`inverter_engine.py` ships inside `InverterCoreService.exe` → production requires
a Python EXE rebuild + full signed installer (separate step on operator go-ahead).

## Verification (2026-06-08, max-level)

- **Full ABI-toggle smoke** (`npm run smoke`): Node **100/100**, Python green,
  exit 0; `rebuild:native:node` + `rebuild:native:electron` both 0. The 100/100
  Node pass confirms `server/index.js` and all server modules load+run at
  runtime, not just parse.
- **Python**: 399/399 suite + 10/10 `test_client_rebuild`.
- **3 independent review agents** (python, typescript, holistic cross-file).
- **Bugs found & fixed during verification:**
  1. `rebuild_ip_client` acquired the per-IP `threading.Lock` on the asyncio
     event loop (could stall all polling ~2 s during a write) → moved the
     close+swap into `_swap_ip_client` run via `run_in_executor`.
  2. `_swap_ip_client` now takes the canonical lock via `thread_locks.setdefault`
     (removes a TOCTOU vs `rebuild_global_maps`).
  3. `POST /reconnect/{inverter}` bounds-check 1–27.
  4. Comm-proxy IPv4 regex tightened to real 0–255 octets.
  5. **Option A**: comm-proxy remote hop is now binary-safe
     (`_commProxyForwardToGateway`, arrayBuffer) so images/fonts/CSS render over
     the remote link; remote-forward timeout widened to 20 s (> gateway's 8 s).
  6. Stale/misleading comm-proxy header comment corrected.
- **Verified assumption**: `SERVER_URL = http://localhost:3500`, so a remote
  viewer's `window.open("/api/comm-proxy/<ip>/")` is a loopback request →
  exempted by `remoteApiTokenGate`; the gateway hop carries the injected token.
- **False alarms triaged**: better-sqlite3 loading under node is N-API ABI-stable
  (authoritative check = `rebuild:native:electron` exit 0, which passed); the
  reviewer's "comm-proxy 401" concern is disproved by the localhost SERVER_URL.
- ABI left in **Electron** state (correct for the app).
