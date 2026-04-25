"""
Slice A unit tests — v2.9.0 hardware-counter + RTC decoding helpers.

Tests the pure-function helpers (_u32_hi_lo, _rtc_from_regs) directly
without booting pymodbus / FastAPI. The async read_fast_async path is
covered by integration smoke in server/tests.
"""
import importlib.util
import os
import sys
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "inverter_engine.py"


def _load_engine_helpers():
    """
    Load inverter_engine.py without triggering its FastAPI / pymodbus
    import chain at module top. We extract the two pure helpers via
    source-text import so the test suite stays dependency-free.
    """
    src = MODULE_PATH.read_text(encoding="utf-8")
    # Isolate the two helpers plus datetime import — they are self-contained.
    ns = {}
    # Inject datetime so the inlined function body can resolve `_dt`.
    exec("from datetime import datetime", ns)
    # Pull out _u32_hi_lo and _rtc_from_regs source regions by markers.
    def extract(fn_name):
        marker = f"def {fn_name}("
        i = src.find(marker)
        assert i >= 0, f"could not find def {fn_name}"
        # Walk forward to the next top-level def/async def (zero indent)
        j = i + 1
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

    exec(extract("_u32_hi_lo"), ns)
    exec(extract("_rtc_from_regs"), ns)
    return ns


class HardwareCounterDecodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load_engine_helpers()

    def test_u32_decode_known_etotal(self):
        """A-T1 variant: hi=0x003C, lo=0x22B0 → Etotal = (60<<16)|8880 = 3,941,040."""
        regs = [0] * 60
        regs[0] = 0x003C
        regs[1] = 0x22B0
        self.assertEqual(self.ns["_u32_hi_lo"](regs, 0), (0x003C << 16) | 0x22B0)

    def test_u32_decode_zero(self):
        regs = [0] * 60
        self.assertEqual(self.ns["_u32_hi_lo"](regs, 0), 0)

    def test_u32_decode_out_of_range(self):
        regs = [0] * 10
        self.assertEqual(self.ns["_u32_hi_lo"](regs, 58), 0)

    def test_alarm32_composite(self):
        """A-T3: reg(6)=0x1234, reg(7)=0x5678 → alarm_32 == 0x12345678."""
        regs = [0] * 60
        regs[6] = 0x1234
        regs[7] = 0x5678
        self.assertEqual(self.ns["_u32_hi_lo"](regs, 6), 0x12345678)

    def test_parce_decode(self):
        """parcE hi=0x0039, lo=0x9654 → (57<<16)|38484 = 3,774,036."""
        regs = [0] * 60
        regs[58] = 0x0039
        regs[59] = 0x9654
        self.assertEqual(self.ns["_u32_hi_lo"](regs, 58), 3_774_036)

    def test_rtc_valid_current_year(self):
        regs = [0] * 60
        regs[20] = 2026
        regs[21] = 4
        regs[22] = 24
        regs[23] = 16
        regs[24] = 41
        regs[25] = 1
        dt, valid = self.ns["_rtc_from_regs"](regs, server_year=2026)
        self.assertTrue(valid)
        self.assertEqual(dt, datetime(2026, 4, 24, 16, 41, 1))

    def test_rtc_year_2047_invalid(self):
        """A-T2: inv 21/u3 fault pattern — year 2047 vs server 2026 → |Δy|>5."""
        regs = [0] * 60
        regs[20] = 2047
        regs[21] = 5
        regs[22] = 11
        regs[23] = 17
        regs[24] = 41
        regs[25] = 1
        dt, valid = self.ns["_rtc_from_regs"](regs, server_year=2026)
        self.assertFalse(valid)
        self.assertIsNone(dt)

    def test_rtc_year_2100_accepted_without_server_year(self):
        """Without a server_year anchor the decoder only enforces 2000..2100."""
        regs = [0] * 60
        regs[20] = 2099
        regs[21] = 1
        regs[22] = 1
        regs[23] = 0
        regs[24] = 0
        regs[25] = 0
        dt, valid = self.ns["_rtc_from_regs"](regs)
        self.assertTrue(valid)

    def test_rtc_all_zero_invalid(self):
        """A-T3: dead inverter returns all zeros."""
        regs = [0] * 60
        dt, valid = self.ns["_rtc_from_regs"](regs, server_year=2026)
        self.assertFalse(valid)
        self.assertIsNone(dt)

    def test_rtc_out_of_band_month(self):
        regs = [0] * 60
        regs[20] = 2026
        regs[21] = 13  # invalid month
        regs[22] = 1
        regs[23] = 0
        regs[24] = 0
        regs[25] = 0
        dt, valid = self.ns["_rtc_from_regs"](regs, server_year=2026)
        self.assertFalse(valid)

    def test_rtc_short_buffer(self):
        regs = [0] * 10  # too short for reg[25]
        dt, valid = self.ns["_rtc_from_regs"](regs, server_year=2026)
        self.assertFalse(valid)


if __name__ == "__main__":
    unittest.main()
