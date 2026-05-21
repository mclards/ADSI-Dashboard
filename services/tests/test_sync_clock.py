"""
Slice D unit tests — v2.9.0 clock-sync helpers.

After the 2026-04-25 packet-capture analysis (docs/capture-file.pcapng frame
#8017) we replaced the template-based vendor frame with plain Modbus FC16.
These tests now cover the bulk-auth helper only; the on-wire write path is
exercised against a live inverter via the canary command.
"""
import unittest
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "inverter_engine.py"


def _extract(fn_name, src):
    marker = f"def {fn_name}("
    i = src.find(marker)
    assert i >= 0, f"could not find def {fn_name}"
    lines = src[i:].splitlines(keepends=True)
    buf = []
    for idx, line in enumerate(lines):
        if idx == 0:
            buf.append(line)
            continue
        if line and not line.startswith((" ", "\t", "\n", "#")):
            break
        buf.append(line)
    return "".join(buf)


def _load_helpers():
    src = MODULE_PATH.read_text(encoding="utf-8")
    ns = {}
    exec("from datetime import datetime, timedelta", ns)
    exec(_extract("_check_bulk_auth", src), ns)
    return ns


class BulkAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load_helpers()

    def test_current_minute_key_accepted(self):
        now = datetime.now()
        key = f"sacups{now.minute:02d}"
        self.assertTrue(self.ns["_check_bulk_auth"](key))

    def test_prior_minute_key_accepted(self):
        prev = (datetime.now() + timedelta(minutes=-1)).minute
        self.assertTrue(self.ns["_check_bulk_auth"](f"sacups{prev}"))
        self.assertTrue(self.ns["_check_bulk_auth"](f"sacups{prev:02d}"))

    def test_rejects_unknown(self):
        self.assertFalse(self.ns["_check_bulk_auth"]("wrongkey"))
        self.assertFalse(self.ns["_check_bulk_auth"](""))
        self.assertFalse(self.ns["_check_bulk_auth"](None))

    def test_bearer_prefix_ok(self):
        now = datetime.now()
        self.assertTrue(self.ns["_check_bulk_auth"](f"Bearer sacups{now.minute:02d}"))


if __name__ == "__main__":
    unittest.main()
