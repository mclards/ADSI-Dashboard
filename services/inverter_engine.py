# =================================================
#   Inverter Dashboard — Hybrid Engine
#   ASYNCIO POLLING + WRITE THREADS
#
#   Designed & Developed by Engr. Clariden Montaño REE (Engr. M.)
#   © 2026 Engr. Clariden Montaño REE. All rights reserved.
# =================================================
import sys
import os

# Fix for frozen/GUI environments where stdout/stderr may be None
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

import subprocess
import re
import os
import asyncio
import json
import time
import sqlite3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import threading
from queue import Queue

from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.responses import JSONResponse
import uvicorn
from fastapi.middleware.cors import CORSMiddleware

from drivers.modbus_tcp import create_client, read_input, read_holding, write_single
from .shared_data import shared

ENGINE_PORT = int(os.getenv("INVERTER_ENGINE_PORT", "9100"))
ENGINE_HOST = str(os.getenv("INVERTER_ENGINE_HOST", "127.0.0.1") or "127.0.0.1").strip() or "127.0.0.1"


# -------------------------------------------------
#   FastAPI app  —  created ONCE with CORS middleware
# -------------------------------------------------

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # allow any origin (browser, file://, etc.)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------------------------
#   Helpers
# -------------------------------------------------

def free_engine_port():
    """Kill any process currently listening on ENGINE_PORT (Windows only)."""
    try:
        result = subprocess.run(["netstat", "-ano"], capture_output=True, text=True)
        pattern = rf"TCP\s+\S+:{ENGINE_PORT}\s+\S+\s+LISTENING\s+(\d+)"
        pids = re.findall(pattern, result.stdout)
        for pid in set(pids):
            subprocess.run(["taskkill", "/PID", pid, "/F", "/T"], capture_output=True)
            print(f"[PORT {ENGINE_PORT}] Killed PID {pid}")
    except Exception as e:
        print(f"[PORT {ENGINE_PORT}] Error:", e)


def hex_h_to_dec(val):
    """Convert a HEX+H string (e.g. '01000H') to an integer. Returns None on failure."""
    try:
        if isinstance(val, str) and val.upper().endswith("H"):
            return int(val[:-1], 16)
    except Exception:
        pass
    return None


def inverter_number_from_ip(ip):
    """Return the inverter number (1–27) for a given IP address, or None."""
    for inv_num, inv_ip in ip_map.items():
        if inv_ip == ip:
            return int(inv_num)
    return None


# -------------------------------------------------
#   Configuration  —  paths & tunables
# -------------------------------------------------

PORTABLE_ROOT = str(os.getenv("IM_PORTABLE_DATA_DIR") or "").strip()
EXPLICIT_DATA_DIR = str(os.getenv("IM_DATA_DIR") or "").strip()

if PORTABLE_ROOT:
    PROGRAMDATA_DIR = Path(PORTABLE_ROOT) / "programdata"
else:
    PROGRAMDATA_ROOT = (
        os.getenv("PROGRAMDATA")
        or os.getenv("ALLUSERSPROFILE")
        or str(Path.home())
    )
    PROGRAMDATA_DIR = Path(PROGRAMDATA_ROOT) / "InverterDashboard"
PROGRAMDATA_DIR.mkdir(parents=True, exist_ok=True)

if EXPLICIT_DATA_DIR:
    DATA_DIR = Path(EXPLICIT_DATA_DIR)
elif PORTABLE_ROOT:
    DATA_DIR = Path(PORTABLE_ROOT) / "db"
else:
    APPDATA_ROOT = os.getenv("APPDATA")
    if APPDATA_ROOT:
        DATA_DIR = Path(APPDATA_ROOT) / "Inverter-Dashboard"
    else:
        DATA_DIR = Path.home() / ".inverter-dashboard"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "adsi.db"
if PORTABLE_ROOT:
    IPCONFIG_PATH = Path(PORTABLE_ROOT) / "config" / "ipconfig.json"
else:
    IPCONFIG_PATH = DATA_DIR / "ipconfig.json"
IPCONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
LEGACY_IPCONFIG_PATHS = [
    DATA_DIR / "ipconfig.json",
    PROGRAMDATA_DIR / "ipconfig.json",
    Path(os.path.dirname(__file__)) / "ipconfig.json",
    Path.cwd() / "ipconfig.json",
]
AUTORESET_PATH = PROGRAMDATA_DIR / "autoreset.json"

DEFAULT_INTERVAL  = 0.05   # default poll interval per inverter
MIN_POLL_INTERVAL = 0.05   # keep poll cadence close to configured interval

# ── Tunable constants — overridden at runtime from DB 'inverterPollConfig' ──
READ_SPACING    = 0.005  # seconds between input / holding reads
RECONNECT_DELAY = 0.5    # seconds to wait after reconnect before retry read
_modbus_timeout = 1.0    # Modbus TCP read timeout (passed to create_client)


# -------------------------------------------------
#   Global state
# -------------------------------------------------

ip_map          = {}   # inv_num (str) -> ip
inverters       = []   # ordered list of active IPs
clients         = {}   # ip -> modbus client
thread_locks    = {}   # ip -> threading.Lock
write_queues    = {}   # ip -> Queue
write_threads   = {}   # ip -> Thread
write_pending   = {}   # ip -> threading.Event set while control write is queued/running
intervals       = {}   # ip -> poll interval (float)
static_units    = {}   # ip -> [unit list] or None

auto_reset_state = {}  # (ip, unit) -> {"state": str, "since": float, "busy": bool}
_last_unit_fail  = {}  # ip -> timestamp of last failed unit-detect

auto_reset_cfg = {
    "enabled":                 False,
    "wait_clear_hex":          "01000H",
    "auto_reset_alarms":       [],
    "wait_clear_timeout_sec":  10,
}

executor = ThreadPoolExecutor(max_workers=16)
WRITE_WAIT_TIMEOUT_MIN_SEC = 8.0
WRITE_WAIT_TIMEOUT_MAX_SEC = 20.0
WRITE_QUEUE_SLOT_SEC = 1.5


def _resolve_future_threadsafe(loop, fut, value):
    try:
        if fut.done():
            return
        fut.set_result(value)
    except Exception:
        pass


# -------------------------------------------------
#   ipconfig.json  —  load
# -------------------------------------------------

def _default_ipconfig():
    cfg = {"inverters": {}, "poll_interval": {}, "units": {}}
    for i in range(1, 28):
        key = str(i)
        cfg["inverters"][key] = f"192.168.1.{100 + i}"
        cfg["poll_interval"][key] = float(DEFAULT_INTERVAL)
        cfg["units"][key] = [1, 2, 3, 4]
    return cfg


def _sanitize_ipconfig(data):
    out = _default_ipconfig()
    src = data if isinstance(data, dict) else {}
    src_inv = src.get("inverters", {}) if isinstance(src.get("inverters"), dict) else {}
    src_poll = src.get("poll_interval", {}) if isinstance(src.get("poll_interval"), dict) else {}
    src_units = src.get("units", {}) if isinstance(src.get("units"), dict) else {}

    for i in range(1, 28):
        key = str(i)

        ip_raw = src_inv.get(key, src_inv.get(i, out["inverters"][key]))
        ip = str(ip_raw).strip()

        poll_raw = src_poll.get(key, src_poll.get(i, out["poll_interval"][key]))
        try:
            poll = float(poll_raw)
        except Exception:
            poll = float(DEFAULT_INTERVAL)

        units_raw = src_units.get(key, src_units.get(i, out["units"][key]))
        if isinstance(units_raw, list):
            units = []
            for u in units_raw:
                try:
                    n = int(u)
                except Exception:
                    continue
                if 1 <= n <= 4 and n not in units:
                    units.append(n)
        else:
            units = [1, 2, 3, 4]

        out["inverters"][key] = ip
        out["poll_interval"][key] = poll if poll >= 0.01 else float(DEFAULT_INTERVAL)
        out["units"][key] = units if units else [1]

    return out


def _read_ipconfig_from_db():
    if not DB_PATH.exists():
        return None

    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=1.0)
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?",
            ("ipConfigJson",),
        ).fetchone()
        if not row or not row[0]:
            return None
        return json.loads(row[0])
    except Exception:
        return None
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass


def _read_ipconfig_file(path_obj):
    try:
        if not path_obj.exists():
            return None
        with open(path_obj, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_ipconfig_file(path_obj, cfg):
    try:
        path_obj.parent.mkdir(parents=True, exist_ok=True)
        with open(path_obj, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        return True
    except Exception:
        return False


def _load_ipconfig_sync():
    """Synchronous load; called via executor so the event loop stays unblocked."""
    # 1) Primary source: Node/Electron DB settings key (single source of truth).
    db_raw = _read_ipconfig_from_db()
    if db_raw is not None:
        cfg = _sanitize_ipconfig(db_raw)
        _write_ipconfig_file(IPCONFIG_PATH, cfg)
        return cfg

    # 2) Fallbacks: AppData ipconfig, then legacy paths.
    candidate_paths = [IPCONFIG_PATH]
    candidate_paths.extend(LEGACY_IPCONFIG_PATHS)

    for p in candidate_paths:
        raw = _read_ipconfig_file(p)
        if raw is None:
            continue
        cfg = _sanitize_ipconfig(raw)
        _write_ipconfig_file(IPCONFIG_PATH, cfg)
        return cfg

    # 3) Default if nothing exists.
    cfg = _default_ipconfig()
    _write_ipconfig_file(IPCONFIG_PATH, cfg)
    print("[IPCONFIG] Created default ipconfig.json at", IPCONFIG_PATH)
    return cfg


async def load_ipconfig():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, _load_ipconfig_sync)


# -------------------------------------------------
#   inverterPollConfig  —  live-tunable constants
# -------------------------------------------------

def _load_poll_config_sync():
    """Read inverterPollConfig JSON from the SQLite settings table."""
    if not DB_PATH.exists():
        return {}
    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=1.0)
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?",
            ("inverterPollConfig",),
        ).fetchone()
        if not row or not row[0]:
            return {}
        cfg = json.loads(row[0])
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}
    finally:
        try:
            if conn:
                conn.close()
        except Exception:
            pass


def _apply_poll_config(cfg):
    """Apply a poll-config dict to the module-level tunable constants."""
    global READ_SPACING, RECONNECT_DELAY, _modbus_timeout

    if "readSpacing" in cfg:
        v = float(cfg["readSpacing"])
        READ_SPACING = max(0.001, min(v, 1.0))
    if "reconnectDelay" in cfg:
        v = float(cfg["reconnectDelay"])
        RECONNECT_DELAY = max(0.1, min(v, 10.0))
    if "modbusTimeout" in cfg:
        v = float(cfg["modbusTimeout"])
        _modbus_timeout = max(0.2, min(v, 10.0))


# -------------------------------------------------
#   autoreset.json  —  load
# -------------------------------------------------

def load_autoreset_config():
    global auto_reset_cfg

    if not AUTORESET_PATH.exists():
        with open(AUTORESET_PATH, "w") as f:
            json.dump(auto_reset_cfg, f, indent=2)
        return

    try:
        with open(AUTORESET_PATH, "r") as f:
            auto_reset_cfg = json.load(f)
    except Exception as e:
        print("[AUTORESET] Load failed:", e)


# -------------------------------------------------
#   Write worker thread  (one per inverter)
# -------------------------------------------------

def write_worker_loop(ip, lock, q):
    """
    Runs in a daemon thread. Drains the write queue and executes
    write_single() under the inverter's lock. Stops on a None sentinel.
    """
    while True:
        pending_evt = write_pending.get(ip)
        job = q.get()
        if job is None:
            if pending_evt:
                pending_evt.clear()
            break

        client = clients.get(ip)
        fut  = job["future"]
        loop = job.get("loop")
        if not client:
            try:
                if loop and not fut.done():
                    loop.call_soon_threadsafe(_resolve_future_threadsafe, loop, fut, False)
            except Exception:
                pass
            if pending_evt and q.empty():
                pending_evt.clear()
            continue

        addr = job["address"]
        val  = job["value"]
        unit = job["unit"]

        ok = False
        try:
            with lock:
                ok = write_single(client, addr, val, unit)
        except Exception:
            ok = False

        try:
            if loop and not fut.done():
                loop.call_soon_threadsafe(_resolve_future_threadsafe, loop, fut, ok)
        except Exception:
            pass
        finally:
            if pending_evt and q.empty():
                pending_evt.clear()


# -------------------------------------------------
#   Safe reads  (run in executor, auto-reconnect)
# -------------------------------------------------

def _threaded_read_input(client, addr, count, unit, lock):
    try:
        with lock:
            return read_input(client, addr, count, unit)
    except Exception:
        return None


def _threaded_read_holding(client, addr, count, unit, lock):
    try:
        with lock:
            return read_holding(client, addr, count, unit)
    except Exception:
        return None


async def safe_read(func, client, addr, count, unit, ip):
    """
    Attempt a register read; on failure, reconnect once and retry.
    Returns the register list or None.
    """
    loop = asyncio.get_running_loop()
    lock = thread_locks.get(ip)
    if lock is None:
        return None

    # ── First attempt ──
    try:
        result = await loop.run_in_executor(executor, func, client, addr, count, unit, lock)
        if result:
            return result
    except Exception:
        pass

    # ── Reconnect + retry ──
    def reconnect_and_read():
        try:
            with lock:
                try:   client.close()
                except Exception: pass
                try:   client.connect()
                except Exception: pass

            time.sleep(RECONNECT_DELAY)

            with lock:
                if func is _threaded_read_input:
                    return read_input(client, addr, count, unit)
                else:
                    return read_holding(client, addr, count, unit)
        except Exception:
            return None

    try:
        return await loop.run_in_executor(executor, reconnect_and_read)
    except Exception:
        return None


def is_write_pending(ip):
    evt = write_pending.get(ip)
    return bool(evt and evt.is_set())


def compute_write_wait_timeout(ip):
    q = write_queues.get(ip)
    lock = thread_locks.get(ip)
    pending = 0
    try:
        pending = int(q.qsize()) if q is not None else 0
    except Exception:
        pending = 0
    base = max(WRITE_WAIT_TIMEOUT_MIN_SEC, (_modbus_timeout * 4.0) + 2.0)
    timeout = base + (pending * WRITE_QUEUE_SLOT_SEC)
    if lock and lock.locked():
        timeout += max(WRITE_QUEUE_SLOT_SEC, _modbus_timeout * 2.0)
    return max(WRITE_WAIT_TIMEOUT_MIN_SEC, min(WRITE_WAIT_TIMEOUT_MAX_SEC, timeout))


def mark_write_pending(ip):
    evt = write_pending.get(ip)
    if evt is None:
        evt = threading.Event()
        write_pending[ip] = evt
    evt.set()
    return evt


# -------------------------------------------------
#   Auto-reset alarm handler
# -------------------------------------------------

async def handle_auto_reset(ip, unit, alarm_val):
    """
    State machine that resets a tripped inverter:
      armed          → alarm detected → write OFF → waiting_clear
      waiting_clear  → alarm clears   → write ON  → armed
      waiting_clear  → timeout        →              armed
    """
    key = (ip, unit)

    # Guard: block concurrent executions for the same inverter/unit
    entry = auto_reset_state.get(key)
    if entry and entry.get("busy"):
        return

    if not auto_reset_cfg.get("enabled"):
        return

    alarm_hex_list = auto_reset_cfg.get("auto_reset_alarms", [])
    if not alarm_hex_list:
        return

    alarm_dec_list = [d for a in alarm_hex_list if (d := hex_h_to_dec(a)) is not None]

    clear_dec = hex_h_to_dec(auto_reset_cfg.get("wait_clear_hex", "01000H"))
    if clear_dec is None:
        return

    wait_timeout = float(auto_reset_cfg.get("wait_clear_timeout_sec", 10))

    entry = auto_reset_state.get(key, {"state": "armed", "since": 0, "busy": False})
    state = entry["state"]
    now   = time.time()

    entry["busy"] = True
    auto_reset_state[key] = entry

    try:
        # ── State: armed ──────────────────────────────────────
        if state == "armed" and alarm_val in alarm_dec_list:
            loop = asyncio.get_running_loop()
            fut  = loop.create_future()
            mark_write_pending(ip)

            write_queues[ip].put({
                "address": 16,
                "value":   0,       # OFF
                "unit":    unit,
                "future":  fut,
                "loop":    loop,
            })

            try:
                ok = await asyncio.wait_for(
                    asyncio.shield(fut),
                    timeout=max(2.0, compute_write_wait_timeout(ip)),
                )
            except asyncio.TimeoutError:
                ok = False

            if not ok:
                print(f"[AUTORESET] OFF write FAILED  {ip}  unit {unit}")
                return

            auto_reset_state[key] = {"state": "waiting_clear", "since": now, "busy": True}
            print(f"[AUTORESET] OFF OK → waiting_clear  {ip}  unit {unit}")
            return

        # ── State: waiting_clear ──────────────────────────────
        if state == "waiting_clear":
            elapsed = now - entry["since"]

            if alarm_val == clear_dec:
                loop = asyncio.get_running_loop()
                fut  = loop.create_future()
                mark_write_pending(ip)

                write_queues[ip].put({
                    "address": 16,
                    "value":   1,   # ON
                    "unit":    unit,
                    "future":  fut,
                    "loop":    loop,
                })

                auto_reset_state[key] = {"state": "armed", "since": 0}
                print(f"[AUTORESET] CLEAR → ON  {ip}  unit {unit}")
                return

            if elapsed >= wait_timeout:
                auto_reset_state[key] = {"state": "armed", "since": 0}
                print(f"[AUTORESET] CLEAR TIMEOUT ({wait_timeout}s) → re-armed  {ip}  unit {unit}")
                return

    finally:
        entry = auto_reset_state.get(key)
        if entry:
            entry["busy"] = False


# -------------------------------------------------
#   Unit detection
# -------------------------------------------------

async def detect_units_async(ip):
    """
    Return the active unit list for an IP.
    Honours static overrides; throttles on repeated failure.
    """
    now = time.time()
    if _last_unit_fail.get(ip, 0) + 5 > now:
        return []

    # Static override wins
    if ip in static_units and static_units[ip]:
        return static_units[ip]

    client = clients.get(ip)
    if not client:
        return []

    units = []
    for u in [1, 2, 3, 4]:
        if is_write_pending(ip):
            await asyncio.sleep(0.05)
            break
        r = await safe_read(_threaded_read_input, client, 1, 1, u, ip)
        if r:
            units.append(u)

    if not units:
        _last_unit_fail[ip] = now
        await asyncio.sleep(0.5)

    return units


# -------------------------------------------------
#   Fast packet read
# -------------------------------------------------

async def read_fast_async(client, unit, ip):
    """
    Read 26 input registers + ON/OFF holding register.
    Returns a dict keyed to the field names expected by Node-RED,
    or None on failure.
    """
    if is_write_pending(ip):
        await asyncio.sleep(min(READ_SPACING, 0.01))
        return None

    regs = await safe_read(_threaded_read_input, client, 0, 26, unit, ip)
    if not regs:
        return None

    onoff = None
    if not is_write_pending(ip):
        await asyncio.sleep(READ_SPACING)
        onoff = await safe_read(_threaded_read_holding, client, 16, 1, unit, ip)

    def reg(i):
        return regs[i] if len(regs) > i else 0

    return {
        "ts":       int(time.time() * 1000),
        "kwh_high": reg(0),
        "kwh_low":  reg(1),
        "alarm":    reg(7),
        "vdc":      reg(8),
        "idc":      reg(9),
        "vac1":     reg(10),
        "vac2":     reg(11),
        "vac3":     reg(12),
        "iac1":     reg(13),
        "iac2":     reg(14),
        "iac3":     reg(15),
        "pac":      reg(18),
        "year":     reg(20),
        "month":    reg(21),
        "day":      reg(22),
        "hour":     reg(23),
        "minute":   reg(24),
        "second":   reg(25),
        "on_off":   onoff[0] if onoff else None,
    }


# -------------------------------------------------
#   Poll loop (one coroutine per inverter)
# -------------------------------------------------

async def poll_inverter(ip):
    interval = max(MIN_POLL_INTERVAL, intervals.get(ip, DEFAULT_INTERVAL))
    print(f"[POLL] Started  {ip}  every {interval}s")

    while True:
        # ── Wait for a live client ──
        client = clients.get(ip)
        if not client:
            await asyncio.sleep(0.5)
            continue

        # ── Discover units ──
        units = await detect_units_async(ip)
        print(f"[POLL] {ip}  units: {units}")

        if not units:
            await asyncio.sleep(1)
            continue

        # ── Continuous poll ──
        while True:
            client = clients.get(ip)
            if not client:
                break

            out     = []
            inv_num = inverter_number_from_ip(ip)
            if inv_num is None:
                print(f"[POLL] WARNING: no inverter number for IP {ip} — data will be dropped")
                await asyncio.sleep(1)
                break  # wait for ip_map to be rebuilt

            for u in units:
                if is_write_pending(ip):
                    await asyncio.sleep(min(interval, 0.05))
                    break
                data = await read_fast_async(client, u, ip)
                if not data:
                    continue

                data["inverter"] = inv_num if inv_num is not None else -1
                data["unit"]     = u
                out.append(data)

                # Trigger auto-reset check (non-blocking)
                key   = (ip, u)
                entry = auto_reset_state.get(key, {"busy": False})
                if not entry.get("busy"):
                    asyncio.create_task(handle_auto_reset(ip, u, data["alarm"]))

            # Do not wipe last good frame on transient all-unit read misses.
            if out:
                shared[ip] = list(out)
            await asyncio.sleep(interval)


# -------------------------------------------------
#   Global map rebuild
# -------------------------------------------------

async def rebuild_global_maps(cfg=None):
    """
    Re-read ipconfig.json and reconcile clients / threads / queues.
    Safe to call at runtime (e.g. from the file watcher).
    """
    global ip_map, inverters, intervals, static_units

    if cfg is None:
        cfg = await load_ipconfig()
    ip_map   = cfg["inverters"]
    poll_cfg = cfg["poll_interval"]
    unit_cfg = cfg["units"]

    inverters[:] = []
    for i in range(1, 28):
        ip = str(ip_map.get(str(i), "")).strip()
        if not ip:
            continue
        inverters.append(ip)

    intervals = {}
    for i in range(1, 28):
        ip = str(ip_map.get(str(i), "")).strip()
        if not ip:
            continue
        try:
            poll = float(poll_cfg.get(str(i), DEFAULT_INTERVAL))
        except Exception:
            poll = DEFAULT_INTERVAL
        poll = poll if poll >= 0.01 else DEFAULT_INTERVAL
        intervals[ip] = max(MIN_POLL_INTERVAL, poll)

    static_units.clear()
    for i in range(1, 28):
        key = str(i)
        ip = str(ip_map.get(key, "")).strip()
        if ip:
            static_units[ip] = unit_cfg.get(key)

    # ── Bring up new inverters ──
    for ip in inverters:
        if ip not in clients:
            loop = asyncio.get_running_loop()
            try:
                c = await loop.run_in_executor(executor, create_client, ip, 502, _modbus_timeout)
            except Exception:
                c = None
            clients[ip] = c

        thread_locks.setdefault(ip, threading.Lock())
        write_pending.setdefault(ip, threading.Event())
        write_queues.setdefault(ip, Queue())

        if ip not in write_threads or not write_threads[ip].is_alive():
            t = threading.Thread(
                target=write_worker_loop,
                args=(ip, thread_locks[ip], write_queues[ip]),
                daemon=True,
            )
            write_threads[ip] = t
            t.start()

    # ── Tear down removed inverters ──
    for ip in list(clients.keys()):
        if ip not in inverters:
            if ip in write_queues:
                try:   write_queues[ip].put(None)
                except Exception: pass
                write_queues.pop(ip, None)

            write_threads.pop(ip, None)

            try:   clients.pop(ip).close()
            except Exception: pass

            thread_locks.pop(ip, None)
            evt = write_pending.pop(ip, None)
            if evt:
                evt.clear()
            intervals.pop(ip, None)
            shared.pop(ip, None)   # remove stale live-data so dropped inverters don't linger in /data

    print(f"[IPCONFIG] Maps rebuilt — {len(inverters)} inverter(s) active")


# -------------------------------------------------
#   Polling manager  (supervises poll tasks)
# -------------------------------------------------

async def start_polling_manager():
    """Wait for at least one inverter, then launch and supervise poll tasks."""
    while not inverters:
        await asyncio.sleep(0.2)

    tasks = {ip: asyncio.create_task(poll_inverter(ip)) for ip in inverters}

    async def _supervisor():
        while True:
            # Restart crashed tasks
            for ip in inverters:
                if ip not in tasks or tasks[ip].done():
                    tasks[ip] = asyncio.create_task(poll_inverter(ip))

            # Cancel tasks for removed inverters
            for ip in list(tasks):
                if ip not in inverters:
                    tasks.pop(ip).cancel()

            await asyncio.sleep(1)

    asyncio.create_task(_supervisor())


# -------------------------------------------------
#   File watcher  (hot-reload ipconfig.json)
# -------------------------------------------------

async def ipconfig_watcher():
    """Re-build maps whenever DB/file-backed ipconfig or poll config changes."""
    last_signature = None
    last_poll_sig = ""
    loop = asyncio.get_running_loop()
    while True:
        # ── Check ipconfig ──
        try:
            cfg = await load_ipconfig()
            signature = json.dumps(cfg, sort_keys=True, separators=(",", ":"))
            if signature != last_signature:
                if last_signature is not None:
                    print("[WATCH] ipconfig changed — reloading")
                last_signature = signature
                await rebuild_global_maps(cfg)
        except Exception:
            pass

        # ── Check poll config (inverterPollConfig) ──
        try:
            poll_cfg = await loop.run_in_executor(executor, _load_poll_config_sync)
            poll_sig = json.dumps(poll_cfg, sort_keys=True, separators=(",", ":"))
            if poll_sig != last_poll_sig:
                last_poll_sig = poll_sig
                old_timeout = _modbus_timeout
                _apply_poll_config(poll_cfg)
                if _modbus_timeout != old_timeout:
                    print(f"[WATCH] modbusTimeout changed to {_modbus_timeout}s — rebuilding clients")
                    await rebuild_global_maps()
                elif last_poll_sig != "{}":
                    print(f"[WATCH] poll config updated: {poll_cfg}")
        except Exception:
            pass

        await asyncio.sleep(1)


# -------------------------------------------------
#   Metrics state  (mirrors Node-RED global context)
# -------------------------------------------------

metrics_state = {
    "pacEnergy":        {},   # nk -> {lastPacRaw, lastPacChangeTime, lastTime, totalWh, date}
    "energyData":       {},   # nk -> {prevkWh, actualkWh, date}
    "pdcData":          {},   # nk -> {lastPdcRaw}
    "uiAlarm":          {},   # nk -> {AlarmValue, AlarmText}
    "lastUpdate":       {},   # nk -> timestamp ms
    "pacEnergyHistory": {},   # nk -> {date: kWh}
}

OFFLINE_THRESHOLD_MS = 30_000
FREEZE_THRESHOLD_MS  = 30_000


def _pad2(n): return str(int(n)).zfill(2)


def _update_metrics_from_frame(frame: dict):
    """Replicates Node-RED parser + engine: update in-memory metrics state from one raw frame."""
    ms  = metrics_state
    now = int(time.time() * 1000)

    inverter = int(frame.get("inverter") or 0)
    module   = int(frame.get("unit")     or 0)
    if not inverter or not module:
        return

    nk = f"{inverter}_{module}"
    ms["lastUpdate"][nk] = now

    vdc = float(frame.get("vdc") or 0)
    idc = float(frame.get("idc") or 0)

    pdc_raw = (vdc * idc) if vdc * idc <= 265_000 else 0
    ms["pdcData"][nk] = {"lastPdcRaw": pdc_raw}

    pac_reg  = float(frame.get("pac") or 0)
    pac_cand = pac_reg * 10 if pac_reg * 10 <= 260_000 else 0
    pac_raw  = 0.0 if (vdc == 0 or idc == 0) else pac_cand

    # Register kWh
    hi = int(frame.get("kwh_high") or 0) & 0xFFFF
    lo = int(frame.get("kwh_low")  or 0) & 0xFFFF
    current_kwh = ((hi << 16) & 0xFFFFFFFF) + lo

    y  = frame.get("year")   or 0
    mo = frame.get("month")  or 0
    dy = frame.get("day")    or 0
    formatted_date = f"{y}-{_pad2(mo)}-{_pad2(dy)}" if y else time.strftime("%Y-%m-%d")

    ed = ms["energyData"].get(nk)
    if not ed:
        ms["energyData"][nk] = {
            "prevkWh": current_kwh, "firstkWh": current_kwh,
            "actualkWh": 0.0, "date": formatted_date,
        }
    else:
        if ed["date"] != formatted_date or current_kwh < ed["prevkWh"]:
            ed.update({"prevkWh": current_kwh, "firstkWh": current_kwh,
                        "actualkWh": 0.0, "date": formatted_date})
        else:
            diff = current_kwh - ed["prevkWh"]
            if diff >= 0:
                ed["actualkWh"] = round(ed["actualkWh"] + diff, 6)
            ed["prevkWh"] = current_kwh

    pe = ms["pacEnergy"].get(nk)
    if not pe:
        ms["pacEnergy"][nk] = {
            "lastTime": now, "lastPacRaw": pac_raw,
            "lastPacChangeTime": now, "totalWh": 0.0, "date": formatted_date,
        }
    else:
        new_day = pe["date"] != formatted_date
        if new_day:
            pe.update({"date": formatted_date, "totalWh": 0.0,
                        "lastTime": now, "lastPacRaw": pac_raw,
                        "lastPacChangeTime": now})
        else:
            dt_sec = (now - pe["lastTime"]) / 1000.0
            if pac_raw != pe["lastPacRaw"]:
                pe["lastPacChangeTime"] = now
            if dt_sec > 0 and pac_raw >= 0:
                avg = (pe["lastPacRaw"] + pac_raw) / 2.0
                pe["totalWh"] += (avg * dt_sec) / 3600.0
            pe["lastPacRaw"] = pac_raw
            pe["lastTime"]   = now

    alarm_val = int(frame.get("alarm") or 0)
    alarm_hex = format(alarm_val, '05X') + "H"
    ms["uiAlarm"][nk] = {"AlarmValue": alarm_val, "AlarmText": alarm_hex}

    kwh_pac = ms["pacEnergy"][nk]["totalWh"] / 1000.0
    if nk not in ms["pacEnergyHistory"]:
        ms["pacEnergyHistory"][nk] = {}
    ms["pacEnergyHistory"][nk][formatted_date] = round(kwh_pac, 6)


def _build_metrics() -> list:
    """
    Replicates the Node-RED ENGINE NODE output exactly.
    Returns list of dicts: Inverter, Module, Pac, Pdc, kWh, kWh_Pac,
                           ONLINE, AlarmValue, Alarm, on_off, Date, Time
    """
    ms  = metrics_state
    now = int(time.time() * 1000)

    # Update state from all current live frames
    for arr in shared.values():
        if isinstance(arr, list):
            for frame in arr:
                _update_metrics_from_frame(frame)

    # Build on_off lookup from live frames
    live_map = {}
    for arr in shared.values():
        if isinstance(arr, list):
            for f in arr:
                inv = f.get("inverter"); unit = f.get("unit")
                if inv and unit:
                    live_map[f"{inv}_{unit}"] = f.get("on_off")

    results = []

    for nk, pe in ms["pacEnergy"].items():
        parts    = nk.split("_")
        inverter = int(parts[0])
        module   = int(parts[1])

        last_seen = ms["lastUpdate"].get(nk, 0)
        online    = (now - last_seen) < OFFLINE_THRESHOLD_MS

        # Skip nodes that have been offline too long
        if not online and (now - last_seen) > OFFLINE_THRESHOLD_MS + 1500:
            continue

        pac_raw = pe.get("lastPacRaw", 0)
        pdc_raw = ms["pdcData"].get(nk, {}).get("lastPdcRaw", 0)

        pac_frozen  = (now - pe.get("lastPacChangeTime", now)) >= FREEZE_THRESHOLD_MS
        display_pac = 0.0 if (not online or pac_frozen) else pac_raw
        display_pdc = 0.0 if (not online or pac_frozen) else pdc_raw

        reg_kwh = ms["energyData"].get(nk, {}).get("actualkWh", 0.0)
        kwh_pac = pe.get("totalWh", 0.0) / 1000.0

        alarm_info = ms["uiAlarm"].get(nk, {"AlarmValue": 0, "AlarmText": "00000H"})

        lt  = pe.get("lastTime", now)
        ldt = time.localtime(lt / 1000)
        time_str = f"{ldt.tm_hour:02d}:{ldt.tm_min:02d}:{ldt.tm_sec:02d}"
        date_str = time.strftime("%Y-%m-%d")

        results.append({
            "Inverter":   inverter,
            "Module":     module,
            "Date":       date_str,
            "Time":       time_str,
            "Pac":        round(display_pac, 2),
            "Pdc":        round(display_pdc, 2),
            "kWh":        round(reg_kwh, 3),
            "kWh_Pac":    round(kwh_pac, 3),
            "ONLINE":     online,
            "lastUpdate": last_seen,
            "AlarmValue": alarm_info.get("AlarmValue", 0),
            "Alarm":      alarm_info.get("AlarmText", "00000H"),
            "on_off":     live_map.get(nk),
        })

    results.sort(key=lambda x: (x["Inverter"], x["Module"]))
    return results


# -------------------------------------------------
#   REST endpoints  (registered on the app above)
# -------------------------------------------------

@app.get("/data")
def get_data():
    """Return a flat list of all live inverter data frames (raw modbus)."""
    flat = []
    for arr in shared.values():
        if isinstance(arr, list):
            flat.extend(arr)
    return flat


@app.get("/metrics")
def get_metrics():
    """
    Return processed inverter metrics — mirrors Node-RED engine output.
    Fields per node: Inverter, Module, Date, Time, Pac(W), Pdc(W),
                     kWh, kWh_Pac, ONLINE, AlarmValue, Alarm, on_off
    """
    return _build_metrics()


class WriteCommand(BaseModel):
    inverter: int
    unit:     int
    value:    int


@app.post("/write")
async def write_command(cmd: WriteCommand):
    """Queue a single-register write (address 16) for the specified inverter/unit."""

    if cmd.value == 2:
        return {"status": "skipped"}

    ip = ip_map.get(str(cmd.inverter))
    if not ip:
        return JSONResponse({"status": "error", "msg": "invalid inverter"}, 400)

    client = clients.get(ip)
    if not client:
        return JSONResponse({"status": "error", "msg": "client not available"}, 400)

    loop = asyncio.get_running_loop()
    fut  = loop.create_future()
    mark_write_pending(ip)

    write_queues[ip].put({
        "address": 16,
        "value":   cmd.value,
        "unit":    cmd.unit,
        "future":  fut,
        "loop":    loop,
    })

    wait_timeout = compute_write_wait_timeout(ip)
    try:
        ok = await asyncio.wait_for(asyncio.shield(fut), timeout=wait_timeout)
    except asyncio.TimeoutError:
        return JSONResponse({"status": "error", "msg": f"write timeout after {wait_timeout:.1f}s"}, 500)

    if not ok:
        return JSONResponse({"status": "error", "msg": "write failed"}, 500)

    return {"status": "ok"}


from fastapi import WebSocket, WebSocketDisconnect

@app.websocket("/ws")
async def websocket_metrics(ws: WebSocket):
    await ws.accept()
    print("[WS] Client connected")

    try:
        while True:
            data = _build_metrics()   # use your existing metrics builder
            await ws.send_text(json.dumps(data))
            await asyncio.sleep(0.5)  # 500ms push
    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except Exception as e:
        print("[WS] Error:", e)

# -------------------------------------------------
#   Entry point
# -------------------------------------------------

async def main():
    if os.name == "nt":
        free_engine_port()

    load_autoreset_config()
    auto_reset_state.clear()

    await rebuild_global_maps()
    asyncio.create_task(ipconfig_watcher())
    asyncio.create_task(start_polling_manager())

    print(f"[ENGINE] Hybrid engine started — listening on {ENGINE_HOST}:{ENGINE_PORT}")

    config = uvicorn.Config(
        app,
        host=ENGINE_HOST,
        port=ENGINE_PORT,
        log_level="critical",
        access_log=False,
    )
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[ENGINE] Stopping...")
