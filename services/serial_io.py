"""Serial Number Read / Edit / Send (Slice C of v2.10.0).

Mirrors ISM's `frmSetSerial` form:
  • READ — FC11 Report Slave ID  (returns SlaveIdInfo with serial + model + fw)
  • UNLOCK — FC16 to register 0xFFFA with magic [0x0065, 0x07A7]
  • WRITE — FC16 to register 0x9C74 with the ASCII serial bytes
  • VERIFY — Sleep(1000) then re-read via FC11

All three transports proven on hardware 2026-04-27 (comm board AND EKI fallback).

Per the v2.9.0 counter-recovery / v2.10.0 Slice B pattern, this module is
**read-only for SQLite** — Python returns dicts, Node persists.  Fleet-wide
uniqueness scan is orchestrated by Node (which already knows the topology
+ owns the cache) by calling our `read_serial_with_lock` once per
(inverter, slave) pair.
"""
from __future__ import annotations

import struct
import threading
import time
from dataclasses import asdict, dataclass
from typing import Optional

from services.vendor_pdu import (
    SlaveIdInfo,
    VendorPduError,
    parse_fc11_slave_id,
    read_slave_id,
)


# ─── Wire constants (decompiled from frmSetSerial.SetMotorola/TexasSerialNumber) ─

UNLOCK_REGISTER = 0xFFFA
UNLOCK_VALUES = (0x0065, 0x07A7)

SERIAL_REGISTER = 0x9C74
SERIAL_REG_COUNT = {"motorola": 6, "tx": 16}     # ASCII bytes / 2
SERIAL_BYTE_LEN = {"motorola": 12, "tx": 32}

VERIFY_DELAY_S = 1.0   # mirrors ISM's Sleep(1000)
DEFAULT_TIMEOUT_S = 3.0


class SerialIoError(Exception):
    """Operational failure during a serial read / write / verify pipeline."""


class SerialFormatError(SerialIoError):
    """Operator-supplied serial doesn't match the chosen format."""


# ─── Small helpers ─────────────────────────────────────────────────────────

def validate_serial_format(new_serial: str, fmt: str) -> None:
    """Raise SerialFormatError if `new_serial` is wrong length / non-ASCII."""
    if fmt not in SERIAL_BYTE_LEN:
        raise SerialFormatError(f"unknown fmt '{fmt}' (expected motorola|tx)")
    expected = SERIAL_BYTE_LEN[fmt]
    if not isinstance(new_serial, str):
        raise SerialFormatError("serial must be a string")
    if len(new_serial) != expected:
        raise SerialFormatError(
            f"{fmt} format requires exactly {expected} chars, got {len(new_serial)}"
        )
    if not new_serial.isascii():
        raise SerialFormatError("serial must be ASCII-only")
    # Match what ISM uses on the wire — printable, no control characters.
    for ch in new_serial:
        if ord(ch) < 0x20 or ord(ch) >= 0x7F:
            raise SerialFormatError(
                f"serial contains non-printable byte: 0x{ord(ch):02X}"
            )


def serial_to_registers(new_serial: str, fmt: str) -> list:
    """Pack an ASCII serial into Modbus UINT16 registers (big-endian byte
    pairs, exactly as ISM frames it on the wire — see Field[1297]/[1299])."""
    validate_serial_format(new_serial, fmt)
    n_regs = SERIAL_REG_COUNT[fmt]
    payload = new_serial.encode("ascii")
    return [(payload[2 * i] << 8) | payload[2 * i + 1] for i in range(n_regs)]


# ─── Modbus operations (sync — caller MUST hold thread_locks[ip]) ──────────

def _do_unlock(client, slave: int) -> None:
    """Send the FC16 unlock frame.  Raises SerialIoError on failure."""
    try:
        r = client.write_registers(
            address=UNLOCK_REGISTER,
            values=list(UNLOCK_VALUES),
            unit=int(slave),
        )
    except Exception as exc:
        raise SerialIoError(f"unlock_exception: {exc}") from exc
    if r is None or r.isError():
        raise SerialIoError(f"unlock_modbus_error: {r}")


def _do_write(client, slave: int, regs: list) -> None:
    """Send the FC16 serial-write frame.  Raises SerialIoError on failure."""
    try:
        r = client.write_registers(
            address=SERIAL_REGISTER,
            values=regs,
            unit=int(slave),
        )
    except Exception as exc:
        raise SerialIoError(f"write_exception: {exc}") from exc
    if r is None or r.isError():
        raise SerialIoError(f"write_modbus_error: {r}")


def read_serial_with_lock(
    client,
    lock: threading.Lock,
    slave: int,
    *,
    expected_fmt: str = "auto",
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> dict:
    """Acquire `lock`, read serial via FC11, return JSON-ready dict.

    Returns:
      { ok: bool,
        slave: int,
        serial: str,                  # decoded, trimmed
        serial_format: str,           # 'motorola' | 'tx' | 'unknown'
        format_warning: str | None,   # set if expected_fmt != detected
        model_code: str,
        firmware_main: str,
        firmware_aux: str,
        live_snapshot_hex: str,
        raw_payload_hex: str,
        error: str | None,
      }
    """
    out_err = None
    info = None
    with lock:
        try:
            info = read_slave_id(client, int(slave), timeout_s=timeout_s)
        except VendorPduError as exc:
            out_err = str(exc)
        except Exception as exc:
            out_err = f"unexpected: {exc}"

    if info is None or out_err:
        return {
            "ok": False,
            "slave": int(slave),
            "error": out_err or "unknown read failure",
        }

    warning = None
    if expected_fmt and expected_fmt != "auto" and expected_fmt != info.serial_format:
        warning = (
            f"detected format '{info.serial_format}' but operator picked "
            f"'{expected_fmt}'"
        )
    return {
        "ok": True,
        "slave": int(slave),
        "serial": info.serial,
        "serial_format": info.serial_format,
        "format_warning": warning,
        "model_code": info.model_code,
        "firmware_main": info.firmware_main,
        "firmware_aux": info.firmware_aux,
        "live_snapshot_hex": info.live_snapshot_raw.hex(),
        "raw_payload_hex": info.raw_payload.hex(),
        "error": None,
    }


def write_serial_with_lock(
    client,
    lock: threading.Lock,
    slave: int,
    new_serial: str,
    fmt: str,
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    verify_delay_s: float = VERIFY_DELAY_S,
) -> dict:
    """Three-stage operator pipeline: UNLOCK → WRITE → VERIFY (single lock).

    Returns:
      { status:        'success' | 'unlock_failed' | 'write_failed' |
                       'verify_failed' | 'format_error',
        new_serial:    str,
        readback:      str | None,    # what we got back from FC11 (may differ!)
        error:         str | None,
        unlock_done:   bool,
        write_done:    bool,
        verify_passed: bool,
      }

    All three Modbus exchanges happen under one lock acquisition so the
    poller cannot interleave between unlock and write.  ISM does the same.
    """
    # Format gate first — fail before touching the bus.
    try:
        regs = serial_to_registers(new_serial, fmt)
    except SerialFormatError as exc:
        return {
            "status": "format_error",
            "new_serial": str(new_serial),
            "readback": None,
            "error": str(exc),
            "unlock_done": False,
            "write_done": False,
            "verify_passed": False,
        }

    out = {
        "status": "unlock_failed",
        "new_serial": new_serial,
        "readback": None,
        "error": None,
        "unlock_done": False,
        "write_done": False,
        "verify_passed": False,
    }

    with lock:
        # ── Stage 1: UNLOCK ──────────────────────────────────────────
        try:
            _do_unlock(client, slave)
            out["unlock_done"] = True
        except SerialIoError as exc:
            out["error"] = str(exc)
            return out

        # ── Stage 2: WRITE ────────────────────────────────────────────
        try:
            _do_write(client, slave, regs)
            out["write_done"] = True
        except SerialIoError as exc:
            out["status"] = "write_failed"
            out["error"] = str(exc)
            return out

        # ── Stage 3: VERIFY ───────────────────────────────────────────
        # Sleep inside the lock so a poller burst can't race in between
        # the write and the readback.
        time.sleep(max(0.0, float(verify_delay_s)))
        try:
            info = read_slave_id(client, int(slave), timeout_s=timeout_s)
        except Exception as exc:
            out["status"] = "verify_failed"
            out["error"] = f"verify_read_exception: {exc}"
            return out

        out["readback"] = info.serial
        if info.serial == new_serial:
            out["status"] = "success"
            out["verify_passed"] = True
        else:
            out["status"] = "verify_failed"
            out["error"] = (
                f"readback mismatch: wrote '{new_serial}', got '{info.serial}'"
            )
    return out


# ─── Convenience wrappers used by the FastAPI handlers ─────────────────────

def info_to_dict(info: SlaveIdInfo) -> dict:
    """Serialize a SlaveIdInfo for HTTP response (raw bytes → hex strings)."""
    return {
        "serial": info.serial,
        "serial_format": info.serial_format,
        "model_code": info.model_code,
        "firmware_main": info.firmware_main,
        "firmware_aux": info.firmware_aux,
        "live_snapshot_hex": info.live_snapshot_raw.hex(),
        "raw_payload_hex": info.raw_payload.hex(),
    }
