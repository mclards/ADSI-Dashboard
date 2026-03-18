import importlib.util
import logging
import os
import shutil
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "forecast_engine.py"
WORK_TMP = ROOT / ".tmp" / "forecast-engine-weather-tests"
WORK_TMP.mkdir(parents=True, exist_ok=True)


def load_module(temp_root: Path, tag: str):
    (temp_root / "data").mkdir(parents=True, exist_ok=True)
    (temp_root / "portable").mkdir(parents=True, exist_ok=True)
    os.environ["ADSI_DATA_DIR"] = str(temp_root / "data")
    os.environ["ADSI_PORTABLE_DATA_DIR"] = str(temp_root / "portable")
    spec = importlib.util.spec_from_file_location(f"forecast_engine_weather_test_{tag}", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ForecastEngineWeatherTests(unittest.TestCase):
    def test_interpolate_5min_preserves_time_column(self):
        tmp_root = WORK_TMP / "interpolate"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "interpolate")
            hourly = pd.DataFrame(
                {
                    "time": pd.date_range("2026-03-20 00:00:00", periods=24, freq="1h"),
                    "rad": [0.0] * 24,
                    "rad_direct": [0.0] * 24,
                    "rad_diffuse": [0.0] * 24,
                    "cloud": [40.0] * 24,
                    "cloud_low": [20.0] * 24,
                    "cloud_mid": [10.0] * 24,
                    "cloud_high": [10.0] * 24,
                    "temp": [28.0] * 24,
                    "rh": [70.0] * 24,
                    "wind": [3.0] * 24,
                    "precip": [0.0] * 24,
                    "cape": [100.0] * 24,
                }
            )

            w5 = mod.interpolate_5min(hourly, "2026-03-20")

            self.assertIn("time", w5.columns)
            self.assertEqual(len(w5), mod.SLOTS_DAY)
            self.assertTrue(pd.api.types.is_datetime64_any_dtype(w5["time"]))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
