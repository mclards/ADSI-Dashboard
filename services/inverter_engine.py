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
import math
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import threading
from queue import Queue, Full

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

# T3.14 fix (Phase 8, 2026-04-14): restrict CORS to the loopback dashboard
# origin so that if the service port is ever accidentally exposed beyond
# 127.0.0.1 (e.g. firewall misconfiguration, future remote-access feature),
# an untrusted browser origin cannot POST /write.  The service ALSO binds
# to ENGINE_HOST (default 127.0.0.1) which is the primary defence — this
# is belt-and-braces.  Override with INVERTER_ENGINE_CORS_ORIGINS env var
# (comma-separated) if the operator needs to add a reverse-proxy origin.
_cors_default = ["http://127.0.0.1:3500", "http://localhost:3500"]
_cors_env = os.getenv("INVERTER_ENGINE_CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] if _cors_env else _cors_default
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
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

PORTABLE_ROOT = str(
    os.getenv("IM_PORTABLE_DATA_DIR")
    or os.getenv("ADSI_PORTABLE_DATA_DIR")
    or ""
).strip()
EXPLICIT_DATA_DIR = str(
    os.getenv("IM_DATA_DIR")
    or os.getenv("ADSI_DATA_DIR")
    or ""
).strip()

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
    # v2.4.43+: prefer consolidated layout under PROGRAMDATA_DIR/db/ when migration is done.
    _new_db_dir = PROGRAMDATA_DIR / "db"
    _sentinel   = PROGRAMDATA_DIR / ".adsi-migration-v2.4.43.json"
    if _sentinel.exists() or (_new_db_dir / "adsi.db").exists():
        DATA_DIR = _new_db_dir
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
    PROGRAMDATA_DIR / "config" / "ipconfig.json",
    PROGRAMDATA_DIR / "ipconfig.json",
    # NOTE: Intentionally excluding Path(__file__).parent / "ipconfig.json"
    # and Path.cwd() / "ipconfig.json". In a PyInstaller bundle __file__'s
    # directory is the extracted _MEIxxxx dir which may contain a stale
    # build-time ipconfig, and CWD depends on how the installer launches
    # the service — both would be replaced on every update and could
    # silently shadow the user's real config.
]
AUTORESET_PATH = PROGRAMDATA_DIR / "autoreset.json"
SERVICE_STOP_FILE_RAW = str(
    os.getenv("IM_SERVICE_STOP_FILE")
    or os.getenv("ADSI_SERVICE_STOP_FILE")
    or ""
).strip()
SERVICE_STOP_FILE = Path(SERVICE_STOP_FILE_RAW) if SERVICE_STOP_FILE_RAW else None
SERVICE_STOP_POLL_SEC = 0.25

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
# T3.3 fix: this lock makes (mark_write_pending + q.put) and (q.empty() + evt.clear())
# atomic with respect to each other, closing a TOCTOU where a job enqueued between
# the worker's empty-check and clear could have its pending signal silently dropped.
write_pending_lock = threading.Lock()
# T3.5 fix: tracks the monotonic timestamp of the last operator /write call per
# (ip, unit).  handle_auto_reset suppresses the opposite-direction reset for
# AUTO_RESET_WRITE_HOLD_SEC seconds after a manual write to avoid races where
# the auto-reset loop immediately undoes an operator command.
last_operator_write_ts = {}
AUTO_RESET_WRITE_HOLD_SEC = 5.0
intervals       = {}   # ip -> poll interval (float)
static_units    = {}   # ip -> [unit list] or None

auto_reset_state = {}  # (ip, unit) -> {"state": str, "since": float, "busy": bool}
_last_unit_fail  = {}  # ip -> timestamp of last failed unit-detect

# Phase 8 code-review fix (2026-04-15): module-scope initializers for the
# one-time-log guards used by T3.17 (PAC clamp) so a race between concurrent
# first-time writers cannot lose an entry.  Previously the guards used
# `global X; try: X except NameError: X = set()` inside the function, which
# has a small window where two threads both hit NameError and one
# re-initialises away the other's just-added entry.  Pre-initialising at
# module scope closes the window — the first `add()` always lands in the
# already-existing set.
_pac_clamp_notified: set = set()

auto_reset_cfg = {
    "enabled":                 False,
    "wait_clear_hex":          "01000H",
    "auto_reset_alarms":       [],
    "wait_clear_timeout_sec":  10,
}

# Per-unit last-known on_off state: holds the most recent successful holding-register
# read. If the next read returns None (transient failure), we fall back to this value
# so Node does not briefly see the inverter as OFF and skip a persistence cycle.
_last_known_on_off = {}   # key: f"{ip}_{unit}" -> int (0 or 1)

executor = ThreadPoolExecutor(max_workers=16)
WRITE_WAIT_TIMEOUT_MIN_SEC = 8.0
WRITE_WAIT_TIMEOUT_MAX_SEC = 20.0
WRITE_QUEUE_SLOT_SEC = 1.5


def service_stop_requested():
    try:
        return bool(SERVICE_STOP_FILE and SERVICE_STOP_FILE.exists())
    except Exception:
        return False


def clear_service_stop_file():
    if not SERVICE_STOP_FILE:
        return
    try:
        SERVICE_STOP_FILE.unlink(missing_ok=True)
    except TypeError:
        try:
            if SERVICE_STOP_FILE.exists():
                SERVICE_STOP_FILE.unlink()
        except Exception:
            pass
    except Exception:
        pass


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

DEFAULT_LOSS_PCT = 2.5


def _default_ipconfig():
    cfg = {"inverters": {}, "poll_interval": {}, "units": {}, "losses": {}}
    for i in range(1, 28):
        key = str(i)
        cfg["inverters"][key] = f"192.168.1.{100 + i}"
        cfg["poll_interval"][key] = float(DEFAULT_INTERVAL)
        cfg["units"][key] = [1, 2, 3, 4]
        cfg["losses"][key] = float(DEFAULT_LOSS_PCT)
    return cfg


def _sanitize_ipconfig(data):
    out = _default_ipconfig()
    src = data if isinstance(data, dict) else {}
    src_inv = src.get("inverters", {}) if isinstance(src.get("inverters"), dict) else {}
    src_poll = src.get("poll_interval", {}) if isinstance(src.get("poll_interval"), dict) else {}
    src_units = src.get("units", {}) if isinstance(src.get("units"), dict) else {}
    src_losses = src.get("losses", {}) if isinstance(src.get("losses"), dict) else {}

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

        loss_raw = src_losses.get(key, src_losses.get(i, out["losses"][key]))
        try:
            loss = float(loss_raw)
        except Exception:
            loss = float(out["losses"][key])
        if not math.isfinite(loss) or loss < 0 or loss > 100:
            loss = float(out["losses"][key])

        out["inverters"][key] = ip
        out["poll_interval"][key] = poll if poll >= 0.01 else float(DEFAULT_INTERVAL)
        out["units"][key] = units if units else [1]
        out["losses"][key] = loss

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

    # 2) Fallbacks: AppData ipconfig, then legacy paths. These paths live in
    #    user-data locations that are preserved across updates. Bundle-dir and
    #    CWD paths are intentionally excluded (see LEGACY_IPCONFIG_PATHS).
    candidate_paths = [IPCONFIG_PATH]
    candidate_paths.extend(LEGACY_IPCONFIG_PATHS)

    for p in candidate_paths:
        raw = _read_ipconfig_file(p)
        if raw is None:
            continue
        cfg = _sanitize_ipconfig(raw)
        _write_ipconfig_file(IPCONFIG_PATH, cfg)
        # Do NOT write back to the DB from the fallback path. _read_ipconfig_from_db
        # returns None on both "key missing" AND "transient SQLite lock" — writing
        # back on the latter would silently overwrite a newer value Node just wrote.
        # Node's loadIpConfigFromDb already seeds the DB from legacy files on
        # startup when its own read returns empty, so this migration is already
        # covered by the Node side without the race window.
        return cfg

    # 3) Default if nothing exists. Do NOT promote the default into the DB —
    #    a Node restart may still populate the real setting from a mirror
    #    file that appeared after we checked.
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
            # T3.3 fix: atomic empty-check + clear so a concurrent
            # enqueue_write_atomically cannot race with the clear.
            if pending_evt:
                with write_pending_lock:
                    if q.empty():
                        pending_evt.clear()
            continue

        steps = job.get("steps")
        if isinstance(steps, list) and steps:
            normalized_steps = []
            for step in steps:
                try:
                    normalized_steps.append({
                        "address": int(step.get("address", 16)),
                        "value":   int(step.get("value")),
                        "unit":    int(step.get("unit")),
                    })
                except Exception:
                    continue
        else:
            normalized_steps = [{
                "address": int(job["address"]),
                "value":   int(job["value"]),
                "unit":    int(job["unit"]),
            }]

        # T3.4 fix: re-validate each step at dequeue time.  Defence in depth
        # against direct queue injection (tests, future refactors) that
        # bypasses the API-level bounds check.  Invalid steps are dropped
        # and the write resolves as failure rather than hitting Modbus.
        validated_steps = []
        for step in normalized_steps:
            if not (1 <= step["unit"] <= 4) or step["value"] not in (0, 1):
                print(
                    f"[write_worker] rejecting invalid step ip={ip} "
                    f"unit={step.get('unit')} value={step.get('value')}"
                )
                continue
            validated_steps.append(step)
        if not validated_steps:
            try:
                if loop and not fut.done():
                    loop.call_soon_threadsafe(_resolve_future_threadsafe, loop, fut, False)
            except Exception:
                pass
            if pending_evt:
                with write_pending_lock:
                    if q.empty():
                        pending_evt.clear()
            continue
        normalized_steps = validated_steps

        batch_mode = bool(job.get("batch")) or len(normalized_steps) > 1
        result_payload = [] if batch_mode else False

        # T3.12 fix (Phase 6, 2026-04-14): post-write read-back verification.
        # Modbus FC6 returns success on transport ACK, which does NOT prove
        # the register actually changed (e.g. inverter rejects the write
        # silently due to interlock).  Read back the same holding register
        # under the same lock and compare; if mismatch, mark this step ok=False
        # so the caller sees the real outcome.  Best-effort — verification
        # failure (read returns None) does NOT downgrade a successful write,
        # only a value MISMATCH does.
        def _verify_step(step):
            try:
                regs = read_holding(client, step["address"], 1, step["unit"])
                if regs and len(regs) >= 1:
                    return int(regs[0]) == int(step["value"])
            except Exception:
                pass
            return None  # could not verify; do not downgrade

        try:
            with lock:
                if batch_mode:
                    result_payload = []
                    for step in normalized_steps:
                        step_ok = write_single(
                            client,
                            step["address"],
                            step["value"],
                            step["unit"],
                        )
                        if step_ok:
                            verdict = _verify_step(step)
                            if verdict is False:
                                # Confirmed mismatch — surface as failure.
                                step_ok = False
                                print(
                                    f"[write_worker] post-write verify MISMATCH "
                                    f"ip={ip} unit={step['unit']} "
                                    f"wrote={step['value']} addr={step['address']}"
                                )
                        result_payload.append({
                            "unit": step["unit"],
                            "ok": bool(step_ok),
                        })
                else:
                    step = normalized_steps[0]
                    result_payload = write_single(
                        client,
                        step["address"],
                        step["value"],
                        step["unit"],
                    )
                    if result_payload:
                        verdict = _verify_step(step)
                        if verdict is False:
                            result_payload = False
                            print(
                                f"[write_worker] post-write verify MISMATCH "
                                f"ip={ip} unit={step['unit']} "
                                f"wrote={step['value']} addr={step['address']}"
                            )
        except Exception:
            result_payload = [] if batch_mode else False

        try:
            if loop and not fut.done():
                loop.call_soon_threadsafe(
                    _resolve_future_threadsafe,
                    loop,
                    fut,
                    result_payload,
                )
        except Exception:
            pass
        finally:
            # T3.3 fix: atomic empty-check + clear under write_pending_lock,
            # so a concurrent enqueue_write_atomically cannot enqueue a job
            # between the empty check and the clear.
            if pending_evt:
                with write_pending_lock:
                    if q.empty():
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


def compute_write_wait_timeout(ip, step_count=1):
    q = write_queues.get(ip)
    lock = thread_locks.get(ip)
    pending = 0
    try:
        pending = int(q.qsize()) if q is not None else 0
    except Exception:
        pending = 0
    try:
        extra_steps = max(0, int(step_count) - 1)
    except Exception:
        extra_steps = 0
    base = max(WRITE_WAIT_TIMEOUT_MIN_SEC, (_modbus_timeout * 4.0) + 2.0)
    timeout = base + ((pending + extra_steps) * WRITE_QUEUE_SLOT_SEC)
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


def enqueue_write_atomically(ip, job):
    """T3.3 fix: atomically mark pending and enqueue.

    Prevents the worker from observing q.empty()==True between the API
    thread's mark_write_pending() and its subsequent q.put(), which would
    cause the pending event to be cleared immediately after the job is
    enqueued (silently dropping the wake-up signal that callers rely on).
    """
    with write_pending_lock:
        # T3.11 fix (Phase 6): bounded queue rejects with Full when capacity
        # exceeded.  Use put_nowait so the API thread never blocks.  Caller
        # converts the WriteQueueFullError to HTTP 429 / WS error response.
        try:
            write_queues[ip].put_nowait(job)
        except Full:
            raise WriteQueueFullError(
                f"Write queue for {ip} is full ({write_queues[ip].maxsize} pending). "
                f"Retry shortly."
            )
        mark_write_pending(ip)


class WriteQueueFullError(RuntimeError):
    """T3.11 fix (Phase 6): raised when per-IP write queue is at capacity."""
    pass


def note_operator_write(ip, unit):
    """T3.5 fix: record the time of an operator-initiated write so
    handle_auto_reset can suppress auto-reset actions on the same (ip, unit)
    for a short hold window, avoiding operator/auto-reset collisions."""
    try:
        last_operator_write_ts[(ip, int(unit))] = time.monotonic()
    except Exception:
        pass


def operator_write_hold_active(ip, unit):
    try:
        ts = last_operator_write_ts.get((ip, int(unit)))
    except Exception:
        return False
    if ts is None:
        return False
    return (time.monotonic() - ts) < AUTO_RESET_WRITE_HOLD_SEC


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
            # T3.5 fix: suppress auto-reset if an operator write just happened
            # on this (ip, unit) — avoids racing with manual control.
            if operator_write_hold_active(ip, unit):
                return

            loop = asyncio.get_running_loop()
            fut  = loop.create_future()

            # T3.3 fix: atomic mark+enqueue.
            try:
                enqueue_write_atomically(ip, {
                    "address": 16,
                    "value":   0,       # OFF
                    "unit":    unit,
                    "future":  fut,
                    "loop":    loop,
                })
            except WriteQueueFullError as e:
                # T3.11 fix (Phase 6): auto-reset is best-effort; on a full
                # queue, log and skip this cycle — next alarm tick will retry.
                print(f"[AUTORESET] queue full, skipping OFF for {ip} unit {unit}: {e}")
                return

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
                # T3.5 fix: same operator-write hold applies to the ON re-arm.
                if operator_write_hold_active(ip, unit):
                    # Don't re-arm ON while operator is actively controlling.
                    return

                loop = asyncio.get_running_loop()
                fut  = loop.create_future()

                # T3.3 fix: atomic mark+enqueue.
                try:
                    enqueue_write_atomically(ip, {
                        "address": 16,
                        "value":   1,   # ON
                        "unit":    unit,
                        "future":  fut,
                        "loop":    loop,
                    })
                except WriteQueueFullError as e:
                    # T3.11 fix (Phase 6): same best-effort skip as the OFF path.
                    print(f"[AUTORESET] queue full, skipping ON for {ip} unit {unit}: {e}")
                    return

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

    # ── on_off: hold last known value on transient holding-register failure (Fix #6) ──
    on_off_key = f"{ip}_{unit}"
    on_off_raw = onoff[0] if onoff else None
    if on_off_raw is not None:
        _last_known_on_off[on_off_key] = on_off_raw
    on_off_val = on_off_raw if on_off_raw is not None else _last_known_on_off.get(on_off_key)

    # ── Fix #3: warn when inverter RTC date diverges from server wall-clock ──
    inv_num_for_log = inverter_number_from_ip(ip)
    y_reg  = reg(20)
    mo_reg = reg(21)
    dy_reg = reg(22)
    if y_reg and mo_reg and dy_reg:
        inverter_date = f"{y_reg}-{_pad2(mo_reg)}-{_pad2(dy_reg)}"
        server_date   = time.strftime("%Y-%m-%d")
        if inverter_date != server_date:
            print(
                f"[CLOCK] Date mismatch inv={inv_num_for_log} unit={unit}"
                f" inverter={inverter_date} server={server_date}"
                f" — bucket ts will use server clock but 'day' field uses inverter date"
            )

    return {
        "ts":       int(time.time() * 1000),
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
        "on_off":   on_off_val,
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
        # T3.6 fix (Phase 6, 2026-04-14): wrap inner cycle in try/except so a
        # single bad read (KeyError from a mid-rebuild map flip, transient
        # asyncio.CancelledError edge, decode error from a misbehaving
        # inverter, etc.) does not kill the whole task and force the
        # supervisor's ~1 s restart.  The supervisor restart path was the
        # original "one bad inverter freezes everyone" symptom.
        while True:
            try:
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

                    data["source_ip"] = ip
                    data["inverter"] = inv_num if inv_num is not None else -1
                    data["unit"]     = u
                    data["node_number"] = u
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
            except asyncio.CancelledError:
                # Cooperative cancel from supervisor; propagate.
                raise
            except Exception as e:
                # Log and keep looping; do not let a single bad cycle freeze
                # this IP or trigger supervisor churn.
                print(f"[POLL] {ip} cycle error (continuing): {type(e).__name__}: {e}")
                await asyncio.sleep(min(interval, 1.0))


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

    # T3.9 fix (Phase 6, 2026-04-14): build the new maps in LOCAL variables
    # first, then atomically swap them into the module globals.  The previous
    # code mutated `intervals = {}` and `static_units.clear()` mid-rebuild;
    # any concurrent poll task iterating those dicts could see them empty
    # (KeyError, "no inverter number") for a window of ~1 ms.  CPython
    # single-statement rebinding of the module attribute is atomic under the
    # GIL, so swap-after-build is race-free without an explicit lock.
    new_ip_map = cfg["inverters"]
    poll_cfg   = cfg["poll_interval"]
    unit_cfg   = cfg["units"]

    new_inverters = []
    new_intervals = {}
    new_static_units = {}
    for i in range(1, 28):
        ip = str(new_ip_map.get(str(i), "")).strip()
        if not ip:
            continue
        new_inverters.append(ip)
        try:
            poll = float(poll_cfg.get(str(i), DEFAULT_INTERVAL))
        except Exception:
            poll = DEFAULT_INTERVAL
        poll = poll if poll >= 0.01 else DEFAULT_INTERVAL
        new_intervals[ip] = max(MIN_POLL_INTERVAL, poll)
        new_static_units[ip] = unit_cfg.get(str(i))

    # Atomic swaps (single-statement rebinding under GIL).
    # Phase 8 code-review fix (2026-04-15): use rebind for `static_units` too
    # (was clear()+update() before).  Previously a concurrent reader of
    # `detect_units_async` could observe static_units mid-rebuild as empty
    # and fall through to Modbus auto-detect for the ~1 µs window.  Rebind
    # avoids the window entirely, matching `intervals` and `ip_map`.
    ip_map = new_ip_map
    inverters[:] = new_inverters  # in-place because consumers hold the list ref
    intervals = new_intervals
    static_units = new_static_units

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
        # T3.11 fix (Phase 6, 2026-04-14): bound the write queue per-IP so a
        # burst of operator clicks (or a stuck UI retry loop) cannot grow
        # RAM unbounded.  64 in-flight commands per inverter is well above
        # any realistic operator workflow; producers see queue.Full and
        # propagate as a 429 to the caller.
        write_queues.setdefault(ip, Queue(maxsize=64))

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
    # T3.17 fix (Phase 8, 2026-04-14): log when the clamp triggers so an
    # Ingeteam firmware variant that uses a different word order surfaces
    # as a loud warning instead of silently-zeroed PAC.  Previously a bad
    # register layout produced 0 kW forever with no log signal.
    _pac_scaled = pac_reg * 10
    if _pac_scaled > 260_000:
        _clamp_key = nk  # e.g. "3_2" for inverter 3 unit 2
        if _clamp_key not in _pac_clamp_notified:
            print(
                f"[POLL] PAC sanity-clamp triggered for {_clamp_key}: raw={pac_reg} "
                f"scaled={_pac_scaled:.0f}W > 260kW cap.  Possible word-swap/firmware "
                f"variant mismatch; values reported as 0.  Verify register layout."
            )
            _pac_clamp_notified.add(_clamp_key)
    pac_cand = _pac_scaled if _pac_scaled <= 260_000 else 0
    pac_raw  = 0.0 if (vdc == 0 or idc == 0) else pac_cand

    y  = frame.get("year")   or 0
    mo = frame.get("month")  or 0
    dy = frame.get("day")    or 0
    formatted_date = f"{y}-{_pad2(mo)}-{_pad2(dy)}" if y else time.strftime("%Y-%m-%d")

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
            # Fix #2: cap dt at 30s to match Node's MAX_PAC_DT_S.
            # Without this cap, /metrics energy grows unbounded during any dropout
            # and always diverges from the Node energy_5min DB totals.
            dt_sec = min((now - pe["lastTime"]) / 1000.0, 30.0)
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
    Returns list of dicts: Inverter, Module, Pac, Pdc,
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

# T3.13 + T3.18 fix (Phase 8, 2026-04-14): Liveness/readiness endpoint for
# Electron parent and external monitors.  Returns both coarse liveness
# (process responding) and functional health (recent polls, connected
# clients).  `stale=true` when the newest frame across all inverters is
# older than 30 s — the "process alive but stuck" failure mode.
@app.get("/health")
def get_health():
    now_ms = int(time.time() * 1000)
    newest_ts = 0
    connected = 0
    for arr in shared.values():
        if isinstance(arr, list):
            for frame in arr:
                ts = int(frame.get("ts") or 0)
                if ts > newest_ts:
                    newest_ts = ts
        if arr:
            connected += 1
    age_ms = (now_ms - newest_ts) if newest_ts > 0 else -1
    stale = age_ms < 0 or age_ms > 30_000
    status = "ok" if not stale and connected > 0 else ("degraded" if connected > 0 else "unready")
    return {
        "status": status,
        "stale": stale,
        "newest_frame_age_ms": age_ms,
        "connected_inverter_count": connected,
        "configured_inverter_count": len(inverters),
        "now_ms": now_ms,
    }


@app.get("/data")
def get_data():
    """Return a flat list of all live inverter data frames (raw modbus).

    Stale-frame guard: Python caches the last successful Modbus frame per IP.
    Frames older than STALE_FRAME_MAX_AGE_MS are excluded so Node sees no frame
    (and naturally marks the inverter offline) when Modbus is down.

    Energy enrichment: each fresh frame is enriched with `kwh_today` — the
    per-unit accumulated kWh from Python's high-frequency (50ms) integrator.
    Node uses this value directly instead of re-integrating PAC at 200ms.
    """
    STALE_FRAME_MAX_AGE_MS = 3000  # must match STALE_FRAME_MAX_AGE_MS in Node poller.js
    now_ms = int(time.time() * 1000)
    flat = []
    for arr in shared.values():
        if isinstance(arr, list):
            for frame in arr:
                frame_ts = int(frame.get("ts") or 0)
                age_ms = now_ms - frame_ts
                if 0 <= age_ms <= STALE_FRAME_MAX_AGE_MS:
                    # Ensure metrics state is current for this frame, then read kwh_today
                    _update_metrics_from_frame(frame)
                    inv  = frame.get("inverter")
                    unit = frame.get("unit")
                    nk   = f"{inv}_{unit}" if inv and unit else None
                    pe   = metrics_state["pacEnergy"].get(nk) if nk else None
                    kwh_today = round(pe["totalWh"] / 1000.0, 6) if pe else 0.0
                    enriched = dict(frame)
                    enriched["kwh_today"] = kwh_today
                    flat.append(enriched)
    return flat


@app.get("/metrics")
def get_metrics():
    """
    Return processed inverter metrics — mirrors Node-RED engine output.
    Fields per node: Inverter, Module, Date, Time, Pac(W), Pdc(W),
                     ONLINE, AlarmValue, Alarm, on_off
    """
    return _build_metrics()


class WriteCommand(BaseModel):
    inverter: int
    unit:     int
    value:    int


class WriteBatchCommand(BaseModel):
    inverter: int
    units:    list[int]
    value:    int


def _sanitize_write_units(units_raw):
    units = []
    for unit_raw in units_raw if isinstance(units_raw, list) else []:
        try:
            unit = int(unit_raw)
        except Exception:
            continue
        if 1 <= unit <= 4 and unit not in units:
            units.append(unit)
    return units


@app.post("/write")
async def write_command(cmd: WriteCommand):
    """Queue a single-register write (address 16) for the specified inverter/unit."""

    # T3.1 fix: validate unit range at the API boundary.
    # Ingeteam nodes are 1..4 (see SKILL.md §Current Metrics — 4 nodes per inverter).
    if not isinstance(cmd.unit, int) or not (1 <= cmd.unit <= 4):
        return JSONResponse({"status": "error", "msg": "invalid unit (must be 1..4)"}, 400)

    # T3.2 fix: ON/OFF register only accepts 0 (off) or 1 (on);
    # value == 2 is the historic "skip" sentinel retained below.
    if cmd.value == 2:
        return {"status": "skipped"}
    if cmd.value not in (0, 1):
        return JSONResponse({"status": "error", "msg": "invalid value (must be 0 or 1)"}, 400)

    ip = ip_map.get(str(cmd.inverter))
    if not ip:
        return JSONResponse({"status": "error", "msg": "invalid inverter"}, 400)

    client = clients.get(ip)
    if not client:
        return JSONResponse({"status": "error", "msg": "client not available"}, 400)

    loop = asyncio.get_running_loop()
    fut  = loop.create_future()

    # T3.3 fix: atomic mark+enqueue.  T3.5: record operator write timestamp
    # so handle_auto_reset can suppress the opposite-direction reset.
    note_operator_write(ip, cmd.unit)
    try:
        enqueue_write_atomically(ip, {
            "address": 16,
            "value":   cmd.value,
            "unit":    cmd.unit,
            "future":  fut,
            "loop":    loop,
        })
    except WriteQueueFullError as e:
        # T3.11 fix (Phase 6): map bounded-queue overflow to HTTP 429 so the
        # operator UI can surface a clear "system busy, retry shortly" hint.
        return JSONResponse({"status": "error", "msg": str(e)}, 429)

    wait_timeout = compute_write_wait_timeout(ip)
    try:
        ok = await asyncio.wait_for(asyncio.shield(fut), timeout=wait_timeout)
    except asyncio.TimeoutError:
        return JSONResponse({"status": "error", "msg": f"write timeout after {wait_timeout:.1f}s"}, 500)

    if not ok:
        return JSONResponse({"status": "error", "msg": "write failed"}, 500)

    return {"status": "ok"}


@app.post("/write/batch")
async def write_batch_command(cmd: WriteBatchCommand):
    """Queue a write batch (address 16) for one inverter across multiple units."""

    units = _sanitize_write_units(cmd.units)
    if not units:
        return JSONResponse({"status": "error", "msg": "no valid units"}, 400)

    # T3.2 fix: same ON/OFF bounds as /write.
    if cmd.value == 2:
        return {
            "status":  "skipped",
            "results": [{"unit": unit, "ok": True} for unit in units],
        }
    if cmd.value not in (0, 1):
        return JSONResponse({"status": "error", "msg": "invalid value (must be 0 or 1)"}, 400)

    ip = ip_map.get(str(cmd.inverter))
    if not ip:
        return JSONResponse({"status": "error", "msg": "invalid inverter"}, 400)

    client = clients.get(ip)
    if not client:
        return JSONResponse({"status": "error", "msg": "client not available"}, 400)

    loop = asyncio.get_running_loop()
    fut  = loop.create_future()

    # T3.3 fix: atomic mark+enqueue.  T3.5: record operator write timestamp
    # for each target unit so auto-reset is held off.
    for unit in units:
        note_operator_write(ip, unit)
    try:
        enqueue_write_atomically(ip, {
            "steps": [
                {"address": 16, "value": cmd.value, "unit": unit}
                for unit in units
            ],
            "future": fut,
            "loop":   loop,
            "batch":  True,
        })
    except WriteQueueFullError as e:
        return JSONResponse({"status": "error", "msg": str(e)}, 429)

    wait_timeout = compute_write_wait_timeout(ip, len(units))
    try:
        results = await asyncio.wait_for(asyncio.shield(fut), timeout=wait_timeout)
    except asyncio.TimeoutError:
        return JSONResponse(
            {"status": "error", "msg": f"write timeout after {wait_timeout:.1f}s"},
            500,
        )

    safe_results = []
    for unit in units:
        match = None
        if isinstance(results, list):
            match = next(
                (entry for entry in results if int(entry.get("unit", -1)) == unit),
                None,
            )
        safe_results.append({
            "unit": unit,
            "ok": bool(match and match.get("ok")),
        })

    ok_count = sum(1 for entry in safe_results if entry["ok"])
    fail_count = len(safe_results) - ok_count

    if ok_count == len(safe_results):
        return {"status": "ok", "results": safe_results}
    if ok_count > 0:
        return {
            "status":    "partial",
            "results":   safe_results,
            "okCount":   ok_count,
            "failCount": fail_count,
        }
    return JSONResponse(
        {
            "status":    "error",
            "msg":       "write failed",
            "results":   safe_results,
            "okCount":   0,
            "failCount": fail_count,
        },
        500,
    )


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

    clear_service_stop_file()
    load_autoreset_config()
    auto_reset_state.clear()

    await rebuild_global_maps()
    # T3.20 fix (Phase 8, 2026-04-14): warn loudly if ipconfig is empty at
    # startup.  The service stays up (so ipconfig hot-reload can add inverters
    # later) but the operator gets a clear signal rather than silently-empty
    # /data and /health responses.
    if not inverters:
        print(
            "[ENGINE] WARNING: ipconfig lists zero inverters. Service will stay up "
            "waiting for ipconfig hot-reload, but /data and /metrics will return empty "
            "until an inverter IP is configured.  Check %PROGRAMDATA%\\InverterDashboard\\ipconfig.json."
        )
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
    stop_task = None
    try:
        if SERVICE_STOP_FILE is not None:
            async def watch_service_stop():
                while not server.should_exit:
                    if service_stop_requested():
                        print("[ENGINE] Soft stop requested - shutting down...")
                        server.should_exit = True
                        return
                    await asyncio.sleep(SERVICE_STOP_POLL_SEC)

            stop_task = asyncio.create_task(watch_service_stop())
        await server.serve()
    finally:
        if stop_task is not None:
            stop_task.cancel()
            try:
                await stop_task
            except asyncio.CancelledError:
                pass
        clear_service_stop_file()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[ENGINE] Stopping...")
