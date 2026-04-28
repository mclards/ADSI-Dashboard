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

from fastapi import FastAPI, Request, HTTPException
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
MIN_POLL_INTERVAL = 0.05   # hard floor — protects against runaway tight loops
# Ingeteam Level 2 workflow (AAV2011IFA01_ p.8, 0008H alarm) recommends no
# faster than 1 Hz per unit at the SCADA level: "reduce the frequency at which
# the SCADA communicates with the inverter (1 communication per second
# recommended)". Per-inverter intervals below this threshold are allowed but
# emit a startup warning so operators know the upstream vendor guidance.
RECOMMENDED_POLL_INTERVAL = 1.0

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

    # Guard: fatal error (0x7FFF) cannot be cleared remotely. Per Ingeteam
    # Level 1 workflow (AAV2011IMC01_ p.14) and Level 2 (AAV2011IFA01_ p.18):
    #   "When a FATAL ERROR occurs, the inverter is unblocked by entering a
    #    code through the display."
    # Looping auto-reset on 7FFF just burns Modbus writes and obscures the
    # real state. Skip and log once per state entry so operators see the note.
    if alarm_val == 0x7FFF:
        if not entry or entry.get("state") != "fatal_locked":
            print(
                f"[AUTORESET] {ip} unit {unit}: alarm 0x7FFF (fatal) — "
                f"cannot be auto-reset. Requires display-code unlock at the unit. "
                f"See docs/Inverter-Incident-Workflow.pdf p.14.",
                flush=True,
            )
        auto_reset_state[key] = {"state": "fatal_locked", "since": time.time(), "busy": False}
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

def _u32_hi_lo(regs, off):
    """UInt32 decode for Ingeteam big-endian word-pair (high word first).

    Raises ValueError on a truncated frame so callers detect the gap instead of
    silently consuming a zero — corrupted Etotal/parcE during crash-recovery
    seed would reset kwh_today on restart.
    """
    if off + 1 >= len(regs):
        raise ValueError(f"truncated frame: need {off + 2} regs, got {len(regs)}")
    a = regs[off] or 0
    b = regs[off + 1] or 0
    return ((a & 0xFFFF) << 16) | (b & 0xFFFF)


def _rtc_from_regs(regs, server_year=None):
    """
    Decode RTC from regs(20..25). Returns (dt_naive_or_None, valid: bool).

    Validity:
      • year within ±5 of server_year (catches inv-21/u3 2047 fault pattern)
        — when server_year is None, accept 2000..2100 for offline/testing
      • month 1..12, day 1..31, hour 0..23, minute 0..59, second 0..59
    Drift (minor clock skew) is handled by the caller via rtc_drift_s; the
    decoder rejects only clearly-corrupt RTCs.
    """
    try:
        if len(regs) < 26:
            return (None, False)
        y  = int(regs[20] or 0)
        mo = int(regs[21] or 0)
        dy = int(regs[22] or 0)
        h  = int(regs[23] or 0)
        mi = int(regs[24] or 0)
        s  = int(regs[25] or 0)
        if not (2000 <= y <= 2100): return (None, False)
        if server_year is not None and abs(y - int(server_year)) > 5:
            return (None, False)
        if not (1 <= mo <= 12):      return (None, False)
        if not (1 <= dy <= 31):      return (None, False)
        if not (0 <= h  <= 23):      return (None, False)
        if not (0 <= mi <= 59):      return (None, False)
        if not (0 <= s  <= 59):      return (None, False)
        from datetime import datetime as _dt
        return (_dt(y, mo, dy, h, mi, s), True)
    except Exception:
        return (None, False)


async def read_fast_async(client, unit, ip):
    """
    Read 72 input registers + ON/OFF holding register.
    Returns a dict keyed to the field names expected by Node-RED,
    plus the v2.9.0 hardware-counter / RTC / full-alarm fields,
    or None on failure.

    Widened from 26→60 regs in v2.9.0 (Slice A) to capture:
      • Etotal (reg 0-1, UInt32 hi-lo)
      • Alarm bitfield (reg 6-7, UInt32 hi-lo) — was truncated to 16-bit
      • Fac grid frequency (reg 19)
      • parcE partial kWh (reg 58-59, UInt32 hi-lo)
    Widened from 60→72 regs in v2.10.x to capture:
      • temp_c heatsink temperature (reg 71, raw °C minus 1 for ISM parity)
    All legacy keys preserved; new keys are additive.
    """
    if is_write_pending(ip):
        await asyncio.sleep(min(READ_SPACING, 0.01))
        return None

    regs = await safe_read(_threaded_read_input, client, 0, 72, unit, ip)
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

    # ── v2.9.0 Slice A: decode hardware counters + RTC + full alarm ──
    now_ms      = int(time.time() * 1000)
    _server_year = time.localtime().tm_year
    rtc_dt, rtc_valid = _rtc_from_regs(regs, server_year=_server_year)
    rtc_ms      = int(rtc_dt.timestamp() * 1000) if rtc_dt else None
    rtc_drift_s = round((rtc_ms - now_ms) / 1000.0, 2) if rtc_ms is not None else None

    try:
        alarm_32   = _u32_hi_lo(regs, 6)
        etotal_kwh = _u32_hi_lo(regs, 0)
        parce_kwh  = _u32_hi_lo(regs, 58)
    except ValueError as ve:
        print(f"[POLL] {ip} unit {unit} truncated frame, dropping: {ve}")
        return None
    fac_hz     = round((reg(19) or 0) / 100.0, 2)

    # v2.10.x All Parameters Data — additional fields needed by the
    # 5-min aggregator. Register map verified against capture-inverter1.pcapng
    # (INV01 / Slave 1 @ 16:50:57 4/27/2026 — every screenshot value matched).
    #   reg 16 = CosPhi × 1000  (0..1000)
    #   reg 17 = Phi Sine Sign  (0=−, 1=+) — kept for ISM column parity
    #   reg 71 = TempCI (cooling-system / heatsink temperature, signed °C).
    #
    #            ── Two-source cross-validation ──
    #            (a) ISM live display: 30-sample × 30-second monitor on
    #                192.168.1.109 / s1 (2026-04-28 08:37–08:52). reg 71
    #                tracked the ISM "Temp (°C)" column exactly with a
    #                constant +1 °C offset (reg 71 reads 1 °C higher than
    #                ISM displays). reg 70 stayed at 0 — confirmed not a
    #                hi/lo pair.
    #            (b) Stop Reason snapshot (services/stop_reason.py:50): the
    #                vendor FC 0x71 SCOPE struct's idx-11 `temp` field is
    #                signed int16, raw °C, no scaling — verified 2026-04-27
    #                to match ISM display directly. Since reg 71 = ISM + 1
    #                and StopReason.temp = ISM, we have:
    #                    StopReason.temp == reg(71) - 1
    #                Subtracting 1 here makes the continuous Parameters-page
    #                Temp column align with both ISM AND the StopReason
    #                snapshot captured at fault time.
    #
    #            Per the alarm reference (server/alarms.js:266 Overtemperature):
    #              • TempCI alarm threshold = 78 °C
    #              • TempCI = -14 °C is a SENSOR FAULT sentinel (open NTC),
    #                NOT a real reading — return None so the dashboard's
    #                Temp column shows "—" instead of a misleading number.
    #              • reg 72 looks like TempINT (internal electronics, threshold
    #                80 °C, slower response) — capture but don't surface yet.
    cosphi_x1000 = int(reg(16) or 0)
    cosphi_val   = round(cosphi_x1000 / 1000.0, 3) if cosphi_x1000 else 0.0
    phi_sign     = 1 if int(reg(17) or 0) else 0
    # Signed int16 interpretation so the -14 sentinel and any cold-weather
    # negatives decode correctly. Modbus regs are unsigned by default.
    raw_temp_ci   = int(reg(71) or 0)
    if raw_temp_ci & 0x8000:
        raw_temp_ci -= 0x10000
    if raw_temp_ci == -14:
        # Sensor fault — open NTC. Don't average a fake number into the
        # 5-min slot; let the column render "—" so the operator notices.
        temp_c_val = None
    elif raw_temp_ci == 0:
        # Inverter offline / register not yet refreshed.
        temp_c_val = None
    else:
        temp_c_val = raw_temp_ci - 1   # ISM-parity calibration

    return {
        "ts":            now_ms,
        # ─── existing fields (preserve exactly for Node-RED / poller compatibility) ───
        "alarm":         reg(7),               # DEPRECATED — 16-bit legacy, remove in v2.10
        "vdc":           reg(8),
        "idc":           reg(9),
        "vac1":          reg(10),
        "vac2":          reg(11),
        "vac3":          reg(12),
        "iac1":          reg(13),
        "iac2":          reg(14),
        "iac3":          reg(15),
        "pac":           reg(18),
        "year":          reg(20),
        "month":         reg(21),
        "day":           reg(22),
        "hour":          reg(23),
        "minute":        reg(24),
        "second":        reg(25),
        "on_off":        on_off_val,
        # ─── NEW fields (v2.9.0 Slice A) ───
        "alarm_32":      alarm_32,              # full 32-bit alarm bitfield
        "fac_hz":        fac_hz,                # grid frequency (Hz)
        "etotal_kwh":    etotal_kwh,            # lifetime kWh counter (UInt32)
        "parce_kwh":     parce_kwh,             # partial kWh counter  (UInt32)
        "rtc_iso":       rtc_dt.isoformat() if rtc_dt else None,
        "rtc_ms":        rtc_ms,
        "rtc_valid":     bool(rtc_valid),
        "rtc_drift_s":   rtc_drift_s,
        # ─── NEW fields (v2.10.x All Parameters Data) ───
        "cosphi":        cosphi_val,            # 0.000 .. 1.000
        "phi_sign":      phi_sign,              # 0=neg, 1=pos
        # Inverter heatsink temperature (°C) — sourced from input reg 71,
        # widened block read above to 72 regs to include it. ISM-parity
        # offset (-1) applied during decode; see the temp_raw block. None
        # while the inverter is offline / sleeping (raw 0 sentinel).
        "temp_c":        temp_c_val,
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

                    # v2.9.0 Slice E — drift / year-invalid clock-sync triggers (non-blocking)
                    try:
                        if data.get("rtc_valid") and data.get("rtc_drift_s") is not None:
                            if abs(float(data["rtc_drift_s"])) > _DRIFT_TRIGGER_THRESHOLD_S:
                                asyncio.create_task(
                                    maybe_trigger_drift_sync(ip, u, float(data["rtc_drift_s"]))
                                )
                        elif not data.get("rtc_valid"):
                            y_probe = int(data.get("year") or 0)
                            if y_probe > 2100 or (0 < y_probe < 2000):
                                asyncio.create_task(
                                    trigger_year_invalid_sync(ip, u, y_probe)
                                )
                    except Exception as _trig_exc:
                        # Never let trigger failure break poll loop
                        pass

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
    fast_poll_inverters = []
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
        effective = max(MIN_POLL_INTERVAL, poll)
        new_intervals[ip] = effective
        new_static_units[ip] = unit_cfg.get(str(i))
        if effective < RECOMMENDED_POLL_INTERVAL:
            fast_poll_inverters.append((i, ip, effective))
    if fast_poll_inverters:
        sample = ", ".join(
            f"inv{inv}@{iv:.2f}s" for inv, _ip, iv in fast_poll_inverters[:3]
        )
        more = f" (+{len(fast_poll_inverters) - 3} more)" if len(fast_poll_inverters) > 3 else ""
        print(
            f"[POLL WARN] {len(fast_poll_inverters)} inverter(s) polling faster than "
            f"{RECOMMENDED_POLL_INTERVAL:.1f}s recommended by Ingeteam Level 2 "
            f"(AAV2011IFA01_ p.8, 0x0008 alarm). Sample: {sample}{more}. "
            f"Tight polling can trigger DSP watchdog resets if the inverter firmware "
            f"enforces the 1 Hz recommendation.",
            flush=True,
        )

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
#   v2.9.0 Slice C/E/F — health gates, crash recovery, clock triggers
# -------------------------------------------------

NODE_API_BASE = os.environ.get("NODE_API_BASE", "http://127.0.0.1:3500")
DISABLE_COUNTER_RECOVERY = os.environ.get("DISABLE_COUNTER_RECOVERY", "").strip() in ("1", "true", "yes")

# Last-sync-attempt throttle for drift trigger: {(inv, unit) -> ts_ms}
_last_drift_sync_at = {}
_DRIFT_SYNC_COOLDOWN_MS = 4 * 3600 * 1000    # 4 h
_DRIFT_TRIGGER_THRESHOLD_S = 3600.0          # 1 h — overrideable by Node setting


def _http_get_json(url: str, timeout_s: float = 5.0):
    """Stdlib HTTP GET returning parsed JSON or None on failure."""
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            if getattr(resp, "status", 200) != 200:
                return None
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else None
    except Exception:
        return None


def _http_post_json(url: str, payload: dict, timeout_s: float = 3.0):
    """Stdlib HTTP POST of JSON body. Returns parsed JSON or None."""
    import urllib.request
    try:
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(
            url, data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else {}
    except Exception:
        return None


# ── Slice F — health gates ────────────────────────────────────────────────

def rtc_year_valid(frame_or_state: dict, server_now=None) -> bool:
    """Last observed RTC year within ±1 of server year."""
    from datetime import datetime as _dt
    if not frame_or_state or not frame_or_state.get("rtc_valid"):
        return False
    rtc_ms = frame_or_state.get("rtc_ms")
    if rtc_ms is None:
        return False
    try:
        rtc_dt = _dt.fromtimestamp(int(rtc_ms) / 1000.0)
    except Exception:
        return False
    now = server_now or _dt.now()
    return abs(rtc_dt.year - now.year) <= 1


def counter_advancing(history: list, window_s: int = 300,
                       pac_idle_w: int = 500) -> bool:
    """
    history: list of dicts ordered oldest→newest, each with keys
             {ts_ms, etotal_kwh, pac_w}.
    Returns True if EITHER:
      • etotal_kwh strictly increased at least once in the window
      • mean(pac_w) over the window < pac_idle_w  (unit idle → no tick expected)
    """
    if not history or len(history) < 2:
        return True
    now_ms = history[-1].get("ts_ms", 0)
    cutoff = now_ms - window_s * 1000
    recent = [r for r in history if r.get("ts_ms", 0) >= cutoff]
    if len(recent) < 2:
        return True
    mean_pac = sum(r.get("pac_w", 0) for r in recent) / float(len(recent))
    if mean_pac < pac_idle_w:
        return True
    vals = [r.get("etotal_kwh", 0) for r in recent]
    return any(b > a for a, b in zip(vals, vals[1:]))


def parce_precision_ok(history: list, pac_integrated_wh: float,
                       window_s: int = 300) -> bool:
    """parcE delta/PAC ratio sanity: catches firmware that exposes parcE at wrong scale."""
    if pac_integrated_wh <= 0 or not history or len(history) < 2:
        return True
    dp = history[-1].get("parce_kwh", 0) - history[0].get("parce_kwh", 0)
    if dp <= 0:
        return False
    ratio = dp / float(pac_integrated_wh)
    return 0.00050 <= ratio <= 0.01100


def trust_etotal(frame_state, history, server_now=None) -> bool:
    return rtc_year_valid(frame_state, server_now) and counter_advancing(history)


def trust_parce(frame_state, history, pac_wh, server_now=None) -> bool:
    return (rtc_year_valid(frame_state, server_now)
            and counter_advancing(history)
            and parce_precision_ok(history, pac_wh))


# ── Slice C — crash-recovery seed ────────────────────────────────────────

async def audit_counter_recovery(inverter, unit, source, recovered_kwh, reason):
    """Best-effort audit-log write to Node for each recovery decision."""
    loop = asyncio.get_running_loop()
    def _post():
        _http_post_json(
            f"{NODE_API_BASE}/api/audit/counter-recovery",
            {"inverter": int(inverter), "unit": int(unit),
             "source": source, "recovered_kwh": float(recovered_kwh or 0),
             "reason": reason or ""},
            timeout_s=3.0,
        )
    try:
        await loop.run_in_executor(executor, _post)
    except Exception:
        pass


def classify_seed_decision(
    cur_etotal,
    cur_parce,
    today_baseline_etotal,
    today_baseline_parce,
    yesterday_etotal,
    yesterday_present,
    rtc_year_ok,
    night_gap_sanity_kwh=50,
    delta_sanity_cap_kwh=50_000,
):
    """
    Pure decision function for v2.9.1 crash-recovery seed gating.

    Returns (recovered_kwh, source, reason) where source ∈ {"etotal","parce","zero"}
    and reason is set when source=="zero". Yesterday's snapshot is the primary
    anchor: without it (or if today's baseline is inconsistent with it) the
    function refuses to seed.
    """
    etotal_delta = int(cur_etotal) - int(today_baseline_etotal or 0)
    parce_delta  = int(cur_parce)  - int(today_baseline_parce  or 0)
    night_gap = int(today_baseline_etotal or 0) - int(yesterday_etotal or 0)

    yesterday_ok = (
        bool(yesterday_present) and
        int(yesterday_etotal or 0) > 0 and
        int(today_baseline_etotal or 0) >= int(yesterday_etotal or 0) and
        night_gap <= night_gap_sanity_kwh
    )

    etotal_ok = (
        bool(rtc_year_ok) and yesterday_ok and
        etotal_delta >= 0 and etotal_delta < delta_sanity_cap_kwh
    )
    parce_ok = (
        bool(rtc_year_ok) and yesterday_ok and
        parce_delta >= 0 and parce_delta < delta_sanity_cap_kwh
    )

    if etotal_ok and etotal_delta > 0:
        return float(etotal_delta), "etotal", ""
    if parce_ok and parce_delta > 0:
        return float(parce_delta), "parce", ""

    if not yesterday_present:
        reason = "no_yesterday_snapshot"
    elif int(yesterday_etotal or 0) <= 0:
        reason = "yesterday_etotal_zero"
    elif int(today_baseline_etotal or 0) < int(yesterday_etotal or 0):
        reason = "baseline_below_yesterday"
    elif night_gap > night_gap_sanity_kwh:
        reason = "midnight_gap_too_large"
    elif not rtc_year_ok:
        reason = "rtc_invalid"
    elif etotal_delta < 0:
        reason = "counter_regressed"
    elif etotal_delta >= delta_sanity_cap_kwh:
        reason = "sanity_cap_exceeded"
    else:
        reason = "counter_flat"

    return 0.0, "zero", reason


async def seed_pac_from_baseline():
    """
    v2.9.0 Slice C — seed PAC integrator per unit from today's baseline +
    first successful poll. Called once during startup before poll loops spin up.

    Safe behaviour on failure: PAC starts at 0 (pre-v2.9.0 default).
    Controlled via DISABLE_COUNTER_RECOVERY env var.
    """
    if DISABLE_COUNTER_RECOVERY:
        print("[RECOVERY] DISABLE_COUNTER_RECOVERY=1 — skipping Etotal/parcE seed")
        return

    from datetime import datetime as _dt
    loop = asyncio.get_running_loop()
    date_key = _dt.now().strftime("%Y-%m-%d")

    # Fetch baselines from Node. Node may not be up yet — retry briefly.
    data = None
    for attempt in range(6):  # ~30 s max (5 s × 6)
        data = await loop.run_in_executor(
            executor,
            _http_get_json,
            f"{NODE_API_BASE}/api/counter-baseline/{date_key}",
            5.0,
        )
        if data is not None:
            break
        print(f"[RECOVERY] Node not ready (attempt {attempt + 1}/6); backing off 5 s")
        await asyncio.sleep(5)

    if data is None:
        print("[RECOVERY] Node unreachable — PAC starts at 0 for all units")
        return

    baselines = {
        (int(b.get("inverter", 0)), int(b.get("unit", 0))): b
        for b in (data.get("baselines") or [])
    }

    # v2.9.1 — refuse to seed any unit that lacks a clear snapshot of
    # yesterday's last reading. Without that anchor we cannot confirm today's
    # baseline is consistent (e.g., baseline accidentally captured during a
    # transient bad first-frame read), so the safe path is to start at 0.
    yesterday = {
        (int(y.get("inverter", 0)), int(y.get("unit", 0))): y
        for y in (data.get("yesterday") or [])
    }

    if not baselines:
        print(f"[RECOVERY] No baselines for {date_key} yet — zero-seed + wait for first poll")
        return

    # v2.9.1 — gap-ratio crash detector. If solar-window readings are dense
    # (ratio >= threshold), this is a clean restart; PAC should accumulate
    # from the live moment forward and we leave the integrator at 0. Only when
    # readings are sparse (low ratio inside the open solar window) do we seed
    # the integrator from hardware-counter deltas.
    crash_detected = bool(data.get("crash_detected"))
    gap_ratio = data.get("gap_ratio")
    gap_thr   = data.get("gap_threshold")
    if not crash_detected:
        print(f"[RECOVERY] clean restart — gap_ratio={gap_ratio} thr={gap_thr}; "
              "PAC integrator starts at 0 (live accumulation only)")
        # Audit one row so operators can see why we declined to seed.
        await audit_counter_recovery(0, 0, "skip", 0.0,
                                     f"clean_restart gap_ratio={gap_ratio} thr={gap_thr}")
        return

    print(f"[RECOVERY] crash detected — gap_ratio={gap_ratio} thr={gap_thr}; "
          "evaluating per-unit seed decisions")

    # Energy that a healthy plant accumulates between yesterday's last RTC-valid
    # frame and today's midnight. ~0 kWh on a working install (sun is down, only
    # standby losses). Anything materially larger means today's baseline was
    # captured at a non-midnight wallclock and is unsafe to subtract from.
    NIGHT_GAP_SANITY_KWH = 50

    seeded = 0
    fallbacks = 0

    for ip, client in list(clients.items()):
        inv = inverter_number_from_ip(ip)
        if inv is None:
            continue
        units = static_units.get(ip) or [1, 2, 3, 4]
        for unit in units:
            try:
                regs = await safe_read(_threaded_read_input, client, 0, 60, unit, ip)
            except Exception:
                regs = None
            if not regs:
                continue

            try:
                cur_etotal = _u32_hi_lo(regs, 0)
                cur_parce  = _u32_hi_lo(regs, 58)
            except ValueError as ve:
                print(f"[RECOVERY] {ip} unit {unit} truncated frame, skipping seed: {ve}")
                continue
            _server_year = time.localtime().tm_year
            rtc_dt, rtc_valid = _rtc_from_regs(regs, server_year=_server_year)

            b = baselines.get((int(inv), int(unit)))
            if not b:
                continue

            y = yesterday.get((int(inv), int(unit)))
            year_ok = bool(rtc_valid and rtc_dt and abs(rtc_dt.year - _dt.now().year) <= 1)

            recovered_kwh, source, reason = classify_seed_decision(
                cur_etotal=cur_etotal,
                cur_parce=cur_parce,
                today_baseline_etotal=int(b.get("etotal_baseline") or 0),
                today_baseline_parce=int(b.get("parce_baseline") or 0),
                yesterday_etotal=int((y or {}).get("etotal_kwh") or 0),
                yesterday_present=bool(y),
                rtc_year_ok=year_ok,
                night_gap_sanity_kwh=NIGHT_GAP_SANITY_KWH,
            )

            nk = f"{int(inv)}_{int(unit)}"
            now_ms = int(time.time() * 1000)
            metrics_state["pacEnergy"][nk] = {
                "lastTime":           now_ms,
                "lastPacRaw":         0.0,
                "lastPacChangeTime":  now_ms,
                "totalWh":            recovered_kwh * 1000.0,
                "date":               date_key,
            }
            metrics_state.setdefault("pacEnergyHistory", {}).setdefault(nk, {})[date_key] = round(recovered_kwh, 6)

            if source == "zero":
                fallbacks += 1
                print(f"[RECOVERY] inv {inv}/u{unit} zero-seeded ({reason})")
            else:
                seeded += 1
                print(f"[RECOVERY] inv {inv}/u{unit} recovered={recovered_kwh:.2f} kWh source={source}")

            await audit_counter_recovery(inv, unit, source, recovered_kwh, reason)

    print(f"[RECOVERY] done — seeded={seeded} zero-fallback={fallbacks}")


# ── Slice E — drift + year-invalid triggers ──────────────────────────────

async def _post_sync_clock_for(inv: int, unit: int, trigger: str):
    """Tell Node to execute a sync-clock for this unit via /api/sync-clock-internal."""
    loop = asyncio.get_running_loop()
    def _post():
        return _http_post_json(
            f"{NODE_API_BASE}/api/sync-clock-internal",
            {"inverter": int(inv), "unit": int(unit), "trigger": trigger},
            timeout_s=10.0,
        )
    try:
        return await loop.run_in_executor(executor, _post)
    except Exception:
        return None


async def maybe_trigger_drift_sync(ip, unit, drift_s):
    """Throttled drift-based sync: at most once per 4 h per (inv, unit)."""
    inv = inverter_number_from_ip(ip)
    if inv is None:
        return
    key = (int(inv), int(unit))
    now = int(time.time() * 1000)
    last = _last_drift_sync_at.get(key, 0)
    if now - last < _DRIFT_SYNC_COOLDOWN_MS:
        return
    _last_drift_sync_at[key] = now
    print(f"[CLOCK] drift trigger inv {inv}/u{unit} drift={drift_s:.0f}s")
    await _post_sync_clock_for(inv, unit, "drift")


async def trigger_year_invalid_sync(ip, unit, y_probe):
    """Year-invalid trigger — light throttle (10 min) to avoid hammering."""
    inv = inverter_number_from_ip(ip)
    if inv is None:
        return
    key = (int(inv), int(unit), "year")
    now = int(time.time() * 1000)
    last = _last_drift_sync_at.get(key, 0)
    if now - last < 10 * 60 * 1000:
        return
    _last_drift_sync_at[key] = now
    print(f"[CLOCK] YEAR-INVALID trigger inv {inv}/u{unit} year_probe={y_probe}")
    await _post_sync_clock_for(inv, unit, "year_invalid")


# -------------------------------------------------
#   v2.9.0 Slice D — clock-sync transport
# -------------------------------------------------
#
# Wireshark capture of ISM's Isla::Sincronizar (docs/capture-file.pcapng,
# frame #8017) confirmed the on-wire protocol is plain Modbus FC16
# (Write Multiple Registers) broadcast to unit 0, starting at register 0,
# writing six UINT16s [year, month, day, hour, minute, second]. No vendor
# function code, no template — pymodbus' built-in write_registers is enough.

async def sync_clock(ip: str, unit: int, target_dt=None,
                     readback_delay_ms: int = 1000):
    """
    Write the server datetime to one inverter+unit. Returns a dict:
        { ok, drift_before_s, drift_after_s, accepted, error }.

    Per ISM packet capture (docs/capture-file.pcapng frame #8017):
      • Modbus FC16 Write Multiple Registers
      • Unit ID: 0 (broadcast — frame propagates to every unit on the daisy chain)
      • Start address: 0
      • Values: [year, month, day, hour, minute, second] as UINT16
    For per-unit sync we still pass the slave ID through so a single inverter
    can be targeted explicitly when desired.
    """
    from datetime import datetime as _dt
    target_dt = target_dt or _dt.now()

    client = clients.get(ip)
    if not client:
        return {
            "ok": False, "accepted": False,
            "error": "no_client", "drift_before_s": None, "drift_after_s": None,
            "target_iso": target_dt.isoformat(),
        }

    lock = thread_locks.get(ip)
    if lock is None:
        return {
            "ok": False, "accepted": False,
            "error": "no_lock", "drift_before_s": None, "drift_after_s": None,
            "target_iso": target_dt.isoformat(),
        }

    loop = asyncio.get_running_loop()
    _server_year = time.localtime().tm_year

    def _do_sync():
        import time as _t
        with lock:
            # 1. read current RTC → drift_before
            before_regs = read_input(client, 20, 6, unit)
            padded_before = [0] * 20 + list(before_regs or [0] * 6)
            rtc_before_dt, _ = _rtc_from_regs(padded_before, server_year=_server_year)
            drift_before = None
            if rtc_before_dt:
                drift_before = (rtc_before_dt - target_dt).total_seconds()

            # 2. write [Y,M,D,h,m,s] via FC16 to the requested slave
            values = [
                int(target_dt.year),
                int(target_dt.month),
                int(target_dt.day),
                int(target_dt.hour),
                int(target_dt.minute),
                int(target_dt.second),
            ]
            write_ok = False
            write_err = None
            try:
                r = client.write_registers(address=0, values=values, unit=int(unit))
                write_ok = bool(r and not r.isError())
                if not write_ok and r is not None:
                    write_err = f"modbus_error: {r}"
            except Exception as exc:
                write_err = f"write_exception: {exc}"

            # 3. read-back
            _t.sleep(readback_delay_ms / 1000.0)
            after_regs = read_input(client, 20, 6, unit)
            padded_after = [0] * 20 + list(after_regs or [0] * 6)
            rtc_after_dt, after_valid = _rtc_from_regs(padded_after, server_year=_server_year)
            drift_after = None
            if rtc_after_dt:
                now_after = _dt.now()
                drift_after = (rtc_after_dt - now_after).total_seconds()

            accepted = bool(
                write_ok
                and after_valid and drift_after is not None
                and abs(drift_after) < 5.0
            )
            return {
                "ok": accepted,
                "drift_before_s": drift_before,
                "drift_after_s":  drift_after,
                "accepted":       accepted,
                "rtc_before_iso": rtc_before_dt.isoformat() if rtc_before_dt else None,
                "rtc_after_iso":  rtc_after_dt.isoformat()  if rtc_after_dt  else None,
                "write_ok":       write_ok,
                "error":          None if accepted else (write_err or "readback_mismatch"),
                "target_iso":     target_dt.isoformat(),
            }

    try:
        return await loop.run_in_executor(executor, _do_sync)
    except Exception as exc:
        return {
            "ok": False, "accepted": False,
            "error": f"executor_error: {exc}",
            "drift_before_s": None, "drift_after_s": None,
            "target_iso": target_dt.isoformat(),
        }


async def sync_clock_inverter(ip: str, units, target_dt=None,
                              readback_delay_ms: int = 1000):
    """
    Sync ALL daisy-chained nodes of one inverter with a SINGLE Modbus FC16
    broadcast write (unit=0). One frame fans out to every slave on the bus;
    we then read each unit's RTC back individually to verify.

    Returns:
      {
        ok: bool,                 # True iff every readback drift_after < 5 s
        target_iso: str,
        write_ok: bool,           # True iff broadcast write didn't raise
        error: str | None,        # Top-level write error, if any
        accepted: int,            # Count of units whose readback was good
        total: int,               # Number of units checked
        units: [
          { unit, drift_before_s, drift_after_s, accepted, error,
            rtc_before_iso, rtc_after_iso }, ...
        ],
      }
    """
    from datetime import datetime as _dt
    target_dt = target_dt or _dt.now()
    unit_list = sorted({int(u) for u in (units or [1, 2, 3, 4]) if u})

    base = {
        "ok": False, "target_iso": target_dt.isoformat(),
        "write_ok": False, "error": None,
        "accepted": 0, "total": len(unit_list), "units": [],
    }

    client = clients.get(ip)
    if not client:
        return {**base, "error": "no_client"}

    lock = thread_locks.get(ip)
    if lock is None:
        return {**base, "error": "no_lock"}

    loop = asyncio.get_running_loop()
    _server_year = time.localtime().tm_year

    def _do():
        import time as _t
        per_unit = []
        write_ok = False
        write_err = None
        with lock:
            # 1. drift_before per unit
            before = {}
            for u in unit_list:
                regs = read_input(client, 20, 6, u)
                padded = [0] * 20 + list(regs or [0] * 6)
                rtc_dt, _ = _rtc_from_regs(padded, server_year=_server_year)
                before[u] = (
                    rtc_dt,
                    (rtc_dt - target_dt).total_seconds() if rtc_dt else None,
                )

            # 2. Single FC16 broadcast write (unit=0).  Per Modbus spec,
            # broadcast slaves do not reply — so a None/error response from
            # pymodbus is normal here; we rely on readback for verification.
            values = [
                int(target_dt.year), int(target_dt.month), int(target_dt.day),
                int(target_dt.hour), int(target_dt.minute), int(target_dt.second),
            ]
            try:
                client.write_registers(address=0, values=values, unit=0)
                write_ok = True
            except Exception as exc:
                write_err = f"write_exception: {exc}"
                write_ok = False

            # 3. drift_after per unit
            _t.sleep(readback_delay_ms / 1000.0)
            for u in unit_list:
                regs = read_input(client, 20, 6, u)
                padded = [0] * 20 + list(regs or [0] * 6)
                rtc_after_dt, valid = _rtc_from_regs(padded, server_year=_server_year)
                drift_after = None
                if rtc_after_dt:
                    drift_after = (rtc_after_dt - _dt.now()).total_seconds()
                rtc_before_dt, drift_before = before.get(u, (None, None))
                accepted = bool(
                    write_ok and valid
                    and drift_after is not None and abs(drift_after) < 5.0
                )
                per_unit.append({
                    "unit": int(u),
                    "drift_before_s": drift_before,
                    "drift_after_s":  drift_after,
                    "accepted":       accepted,
                    "rtc_before_iso": rtc_before_dt.isoformat() if rtc_before_dt else None,
                    "rtc_after_iso":  rtc_after_dt.isoformat()  if rtc_after_dt  else None,
                    "error":          None if accepted else (write_err or "readback_mismatch"),
                })
        return write_ok, write_err, per_unit

    try:
        write_ok, write_err, per_unit = await loop.run_in_executor(executor, _do)
        accepted = sum(1 for u in per_unit if u["accepted"])
        return {
            "ok":         bool(write_ok and accepted == len(per_unit) and per_unit),
            "target_iso": target_dt.isoformat(),
            "write_ok":   write_ok,
            "error":      write_err,
            "accepted":   accepted,
            "total":      len(per_unit),
            "units":      per_unit,
        }
    except Exception as exc:
        return {**base, "error": f"executor_error: {exc}"}


# ── Bulk-auth helper (mirrors server/bulkControlAuth.js sacupsMM pattern) ──
def _check_bulk_auth(header_value: str) -> bool:
    """Accept `sacupsMM` or `sacupsMM` of current or prior minute. Case-insensitive."""
    if not header_value:
        return False
    raw = str(header_value).strip()
    # Strip optional "Bearer " prefix.
    if raw.lower().startswith("bearer "):
        raw = raw.split(" ", 1)[1].strip()
    raw = raw.lower()
    from datetime import datetime as _dt, timedelta
    now = _dt.now()
    candidates = set()
    for offset in (0, -1):
        m = (now + timedelta(minutes=offset)).minute
        candidates.add(f"sacups{m}")
        candidates.add(f"sacups{m:02d}")
    return raw in candidates


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


# ─── v2.9.0 Slice D — clock-sync endpoints ────────────────────────────────

def _extract_auth_header(request):
    """Return the best-available bulk-auth header value (lowercased, trimmed)."""
    if request is None:
        return ""
    headers = getattr(request, "headers", {}) or {}
    # FastAPI headers are case-insensitive MultiDict.
    for name in ("x-bulk-auth", "authorization"):
        val = headers.get(name) if hasattr(headers, "get") else None
        if val:
            return str(val).strip()
    return ""


@app.post("/sync-clock/{inverter}/{unit}")
async def api_sync_clock_one(inverter: int, unit: int, request: Request):
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    ip = ip_map.get(str(int(inverter)))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    from datetime import datetime as _dt
    target_dt = _dt.now()
    result = await sync_clock(ip, int(unit), target_dt)
    return {"inverter": int(inverter), "unit": int(unit), **result}


@app.post("/sync-clock/inverter/{inverter}")
async def api_sync_clock_inverter(inverter: int, request: Request):
    """Sync ALL nodes of one inverter using a single FC16 broadcast frame
    (unit=0). Body may pass `units: [1,2,3,4]` to override the unit list
    that gets read back; defaults to ipconfig.units[inverter] when omitted."""
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    cfg = await load_ipconfig()
    unit_map = cfg.get("units", {}) or {}
    body_units = None
    try:
        body = await request.json()
        if isinstance(body, dict) and isinstance(body.get("units"), list):
            body_units = body["units"]
    except Exception:
        body_units = None
    units = (
        body_units
        or unit_map.get(str(inv_int))
        or unit_map.get(inv_int)
        or [1, 2, 3, 4]
    )

    from datetime import datetime as _dt
    target_dt = _dt.now()
    result = await sync_clock_inverter(ip, units, target_dt)
    # Tag every per-unit row with the inverter number for the Node logger.
    tagged_units = [{"inverter": inv_int, **u} for u in result.get("units", [])]
    return {
        "inverter":   inv_int,
        "ip":         ip,
        "target_iso": result.get("target_iso"),
        "write_ok":   result.get("write_ok"),
        "error":      result.get("error"),
        "accepted":   result.get("accepted"),
        "total":      result.get("total"),
        "results":    tagged_units,
    }


@app.post("/sync-clock/broadcast")
async def api_sync_clock_all(request: Request):
    """Fan out per-inverter broadcasts across the whole fleet — one Modbus
    FC16 frame per inverter (NOT per unit). Used by the daily auto-sync cron.
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    from datetime import datetime as _dt
    target_dt = _dt.now()
    cfg = await load_ipconfig()
    inv_map = cfg.get("inverters", {}) or {}
    unit_map = cfg.get("units", {}) or {}

    flat_results = []

    async def _sync_one_inverter(inv_key, ip, units):
        try:
            inv = int(inv_key)
        except Exception:
            return
        try:
            r = await sync_clock_inverter(ip, units, target_dt)
        except Exception as exc:
            for u in units or [1, 2, 3, 4]:
                flat_results.append({
                    "inverter": inv, "unit": int(u),
                    "accepted": False,
                    "error": f"exception: {exc}",
                    "drift_before_s": None, "drift_after_s": None,
                })
            return
        for row in r.get("units", []):
            flat_results.append({"inverter": inv, **row})

    tasks = []
    for inv_key, ip in inv_map.items():
        if not ip:
            continue
        units = unit_map.get(inv_key) or unit_map.get(str(inv_key)) or [1, 2, 3, 4]
        tasks.append(_sync_one_inverter(inv_key, ip, units))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    accepted = sum(1 for r in flat_results if r.get("accepted"))
    return {
        "target_iso": target_dt.isoformat(),
        "total":      len(flat_results),
        "accepted":   accepted,
        "results":    flat_results,
    }


# ─── v2.10.0 Slice B — Stop Reasons (vendor FC 0x71 SCOPE peek) ────────────

@app.post("/stop-reasons/{inverter}/{slave}")
async def api_stop_reasons_read(inverter: int, slave: int, request: Request):
    """Read StopReason snapshots for one inverter+slave via vendor FC 0x71.

    Returns JSON-ready dicts. No persistence side-effect — Node's route
    handler decides whether to write rows into inverter_stop_reasons.

    Query / body knobs:
      • nodes:              CSV list "1,2,3"  (default: all 1..3)
      • include_histogram:  bool (default false)
    Bulk-auth gated — same key as clock-sync broadcast since this drives
    Modbus traffic on the shared bus.
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    client = clients.get(ip)
    if client is None:
        raise HTTPException(503, f"no Modbus client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:
        raise HTTPException(503, f"no per-IP lock for {ip}")

    # Parse knobs from query OR body (so callers can use either form).
    body = {}
    try:
        body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    except Exception:
        body = {}
    qp = request.query_params

    def _parse_nodes(val):
        if val is None or val == "":
            return None
        if isinstance(val, list):
            raw = val
        else:
            raw = str(val).split(",")
        out = []
        for s in raw:
            try:
                n = int(str(s).strip())
                if 1 <= n <= 3:  # NODE_MAX_SUPPORTED
                    out.append(n)
            except Exception:
                continue
        return out or None

    nodes = _parse_nodes(body.get("nodes")) or _parse_nodes(qp.get("nodes"))
    include_histogram = bool(
        body.get("include_histogram")
        or qp.get("include_histogram") in ("1", "true", "True", "yes")
    )

    from services.stop_reason import read_with_lock as _read_with_lock

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: _read_with_lock(
                client, lock, int(slave),
                nodes=nodes, include_histogram=include_histogram,
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

    return {
        "ok": True,
        "inverter": inv_int,
        "ip": ip,
        "slave": int(slave),
        "read_at_ms": int(time.time() * 1000),
        "nodes": result.get("nodes", []),
        "histogram": result.get("histogram"),
    }


# ─── v2.10.0 Slice C — Serial Number Read / Edit / Send ────────────────────

@app.get("/serial/{inverter}/{slave}")
async def api_serial_read(inverter: int, slave: int, request: Request):
    """FC11 Report Slave ID read for one inverter+slave.

    Returns:
      {
        ok, inverter, ip, slave, read_at_ms,
        serial, serial_format, format_warning,
        model_code, firmware_main, firmware_aux,
        live_snapshot_hex, raw_payload_hex,
      }

    Bulk-auth gated.  Optional query: `?fmt=motorola|tx|auto` (default auto).
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    client = clients.get(ip)
    if client is None:
        raise HTTPException(503, f"no Modbus client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:
        raise HTTPException(503, f"no per-IP lock for {ip}")

    fmt = (request.query_params.get("fmt") or "auto").strip().lower()
    if fmt not in ("auto", "motorola", "tx"):
        raise HTTPException(400, f"unknown fmt '{fmt}'")

    # Optional per-call timeout override (Node passes 5s for fleet scans
    # because the comm board needs more headroom than the 3s default
    # when the bus is warm with poller traffic).  Clamped to [1.0, 15.0]
    # so a runaway value can't stall the executor pool.
    raw_to = request.query_params.get("timeout_s")
    try:
        timeout_s = float(raw_to) if raw_to is not None else 0.0
    except (TypeError, ValueError):
        timeout_s = 0.0
    if timeout_s <= 0:
        timeout_s = 3.0
    timeout_s = max(1.0, min(15.0, timeout_s))

    from services.serial_io import read_serial_with_lock as _read_serial

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: _read_serial(
                client, lock, int(slave),
                expected_fmt=fmt, timeout_s=timeout_s,
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

    return {
        "ok": bool(result.get("ok")),
        "inverter": inv_int,
        "ip": ip,
        "slave": int(slave),
        "read_at_ms": int(time.time() * 1000),
        **{k: v for k, v in result.items() if k not in ("ok", "slave")},
    }


@app.post("/serial/{inverter}/{slave}")
async def api_serial_write(inverter: int, slave: int, request: Request):
    """UNLOCK + WRITE + readback-VERIFY pipeline for one inverter+slave.

    Body:
      {
        new_serial: str,        # 12 (Motorola) or 32 (TX) ASCII chars
        fmt:        str,        # 'motorola' | 'tx'
        verify_delay_s: float,  # optional override (default 1.0)
      }

    Bulk-auth gated.  Returns the same shape as
    services.serial_io.write_serial_with_lock plus identification fields.
    """
    auth = _extract_auth_header(request)
    if not _check_bulk_auth(auth):
        raise HTTPException(401, "unauthorized")

    inv_int = int(inverter)
    ip = ip_map.get(str(inv_int))
    if not ip:
        raise HTTPException(400, f"no IP configured for inverter {inverter}")

    client = clients.get(ip)
    if client is None:
        raise HTTPException(503, f"no Modbus client for {ip}")
    lock = thread_locks.get(ip)
    if lock is None:
        raise HTTPException(503, f"no per-IP lock for {ip}")

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    new_serial = str(body.get("new_serial") or "").strip()
    fmt = str(body.get("fmt") or "").strip().lower()
    if not new_serial:
        raise HTTPException(400, "new_serial required")
    if fmt not in ("motorola", "tx"):
        raise HTTPException(400, "fmt must be 'motorola' or 'tx'")
    verify_delay_s = float(body.get("verify_delay_s") or 1.0)

    from services.serial_io import write_serial_with_lock as _write_serial

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            executor,
            lambda: _write_serial(
                client, lock, int(slave),
                new_serial=new_serial, fmt=fmt,
                verify_delay_s=verify_delay_s,
            ),
        )
    except Exception as exc:
        raise HTTPException(500, f"executor_error: {exc}")

    return {
        "ok": result.get("status") == "success",
        "inverter": inv_int,
        "ip": ip,
        "slave": int(slave),
        "fmt": fmt,
        "acted_at_ms": int(time.time() * 1000),
        **result,
    }


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

    # v2.9.0 Slice C — crash-recovery seed before polling begins.
    # Runs in background so a stuck Node call never blocks engine startup.
    try:
        asyncio.create_task(seed_pac_from_baseline())
    except Exception as exc:
        print(f"[RECOVERY] could not schedule seed_pac_from_baseline: {exc}")

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
