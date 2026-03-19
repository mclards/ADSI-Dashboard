import importlib.util
import logging
import os
import shutil
import unittest
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "services" / "forecast_engine.py"
WORK_TMP = ROOT / ".tmp" / "forecast-engine-error-classifier-tests"
WORK_TMP.mkdir(parents=True, exist_ok=True)


def load_module(temp_root: Path, tag: str):
    (temp_root / "data").mkdir(parents=True, exist_ok=True)
    (temp_root / "portable").mkdir(parents=True, exist_ok=True)
    os.environ["ADSI_DATA_DIR"] = str(temp_root / "data")
    os.environ["ADSI_PORTABLE_DATA_DIR"] = str(temp_root / "portable")
    spec = importlib.util.spec_from_file_location(f"forecast_engine_error_classifier_test_{tag}", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class IdentityScaler:
    def __init__(self, n_features: int):
        self.n_features_in_ = n_features

    def transform(self, X):
        return np.asarray(X, dtype=float)


class ZeroRegressor:
    def __init__(self):
        self.n_estimators = 1

    def predict(self, X):
        return np.zeros(len(X), dtype=float)


class FixedClassifier:
    def __init__(self, probs):
        self.classes_ = np.arange(len(probs), dtype=int)
        self.n_estimators = 1
        self._probs = np.asarray(probs, dtype=float)

    def predict_proba(self, X):
        return np.tile(self._probs, (len(X), 1))


class ForecastEngineErrorClassifierTests(unittest.TestCase):
    def test_fit_error_classifier_skips_when_only_one_class_present(self):
        tmp_root = WORK_TMP / "single-class-skip"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "single-class-skip")
            X = pd.DataFrame({
                col: np.zeros(24, dtype=float)
                for col in mod.FEATURE_COLS
            })
            residual = np.zeros(24, dtype=float)
            sample_weight = np.ones(24, dtype=float)

            model, scaler, meta = mod.fit_error_classifier(X, residual, sample_weight)

            self.assertIsNone(model)
            self.assertIsNone(scaler)
            self.assertIsNone(meta)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_weather_bucket_and_residual_classification(self):
        tmp_root = WORK_TMP / "bucket-classes"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "bucket-classes")
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 200.0),
                "cloud": np.full(mod.SLOTS_DAY, 90.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "precip": np.zeros(mod.SLOTS_DAY),
                "cape": np.zeros(mod.SLOTS_DAY),
            })
            clear_slot = mod.SOLAR_START_SLOT + 10
            clear_edge_slot = mod.SOLAR_START_SLOT + 20
            mixed_slot = mod.SOLAR_START_SLOT + 30
            volatile_slot = mod.SOLAR_START_SLOT + 40
            rainy_slot = mod.SOLAR_START_SLOT + 50

            w5.loc[clear_slot - 1, "rad"] = 760.0
            w5.loc[clear_slot, ["rad", "cloud"]] = [800.0, 12.0]

            w5.loc[clear_edge_slot - 1, "rad"] = 500.0
            w5.loc[clear_edge_slot, ["rad", "cloud"]] = [700.0, 20.0]

            w5.loc[mixed_slot - 1, "rad"] = 520.0
            w5.loc[mixed_slot, ["rad", "cloud"]] = [500.0, 50.0]

            w5.loc[volatile_slot - 1, "rad"] = 300.0
            w5.loc[volatile_slot, ["rad", "cloud"]] = [700.0, 60.0]

            w5.loc[rainy_slot, ["rad", "cloud", "precip", "cape"]] = [400.0, 88.0, 0.2, 900.0]

            orig_clear_sky = mod.clear_sky_radiation
            try:
                mod.clear_sky_radiation = lambda day, rh: np.full(mod.SLOTS_DAY, 1000.0, dtype=float)
                buckets = mod.classify_slot_weather_buckets(w5, "2026-03-20")
            finally:
                mod.clear_sky_radiation = orig_clear_sky

            self.assertEqual(str(buckets[clear_slot]), "clear_stable")
            self.assertEqual(str(buckets[clear_edge_slot]), "clear_edge")
            self.assertEqual(str(buckets[mixed_slot]), "mixed_stable")
            self.assertEqual(str(buckets[volatile_slot]), "mixed_volatile")
            self.assertEqual(str(buckets[rainy_slot]), "rainy")

            labels = mod.classify_residual_error_classes(
                np.array([-180.0, -60.0, 0.0, 60.0, 180.0], dtype=float),
                cap_slot=1000.0,
            )
            self.assertEqual(labels.tolist(), [0, 1, 2, 3, 4])
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_confidence_bands_widen_with_low_classifier_confidence(self):
        tmp_root = WORK_TMP / "confidence-bands"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "confidence-bands")
            values = np.zeros(mod.SLOTS_DAY, dtype=float)
            values[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 100.0
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 650.0),
                "cloud": np.full(mod.SLOTS_DAY, 18.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "temp": np.full(mod.SLOTS_DAY, 28.0),
            })
            mid_slot = mod.SOLAR_START_SLOT + (mod.SOLAR_SLOTS // 2)
            low_conf_meta = {
                "confidence": np.full(mod.SLOTS_DAY, 0.10, dtype=float),
                "severe_probability": np.full(mod.SLOTS_DAY, 0.85, dtype=float),
            }

            lo_base, hi_base = mod.confidence_bands(values, w5, "2026-03-20")
            lo_cls, hi_cls = mod.confidence_bands(values, w5, "2026-03-20", error_class_meta=low_conf_meta)

            base_width = float(hi_base[mid_slot] - lo_base[mid_slot])
            cls_width = float(hi_cls[mid_slot] - lo_cls[mid_slot])
            self.assertGreater(cls_width, base_width)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_solcast_prior_prefers_clear_weather_when_reliable(self):
        tmp_root = WORK_TMP / "solcast-clear"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "solcast-clear")
            day = "2026-03-20"
            w5 = pd.DataFrame({
                "rad": np.full(mod.SLOTS_DAY, 750.0),
                "cloud": np.full(mod.SLOTS_DAY, 15.0),
                "rh": np.full(mod.SLOTS_DAY, 60.0),
                "precip": np.zeros(mod.SLOTS_DAY),
                "cape": np.zeros(mod.SLOTS_DAY),
                "cloud_low": np.full(mod.SLOTS_DAY, 10.0),
                "cloud_mid": np.full(mod.SLOTS_DAY, 8.0),
                "cloud_high": np.full(mod.SLOTS_DAY, 6.0),
                "temp": np.full(mod.SLOTS_DAY, 28.0),
                "wind": np.full(mod.SLOTS_DAY, 3.0),
            })
            snapshot = {
                "forecast_kwh": np.full(mod.SLOTS_DAY, 120.0, dtype=float),
                "forecast_lo_kwh": np.full(mod.SLOTS_DAY, 100.0, dtype=float),
                "forecast_hi_kwh": np.full(mod.SLOTS_DAY, 140.0, dtype=float),
                "forecast_mw": np.full(mod.SLOTS_DAY, 1.44, dtype=float),
                "spread_frac": np.full(mod.SLOTS_DAY, 0.08, dtype=float),
                "present": np.ones(mod.SLOTS_DAY, dtype=bool),
                "coverage_slots": int(mod.SOLAR_SLOTS),
                "coverage_ratio": 0.78,
                "source": "solcast",
            }
            reliability = {
                "regimes": {
                    "clear": {"bias_ratio": 1.0, "reliability": 0.92, "coverage_ratio": 0.85},
                    "mixed": {"bias_ratio": 1.0, "reliability": 0.92, "coverage_ratio": 0.85},
                }
            }

            orig_analyse = mod.analyse_weather_day
            orig_classify = mod.classify_day_regime
            try:
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "cloud_mean": 12.0,
                    "rad_peak": 800.0,
                    "rh_mean": 60.0,
                    "vol_index": 0.05,
                    "rainy": False,
                    "convective": False,
                    "sky_class": "clear",
                }
                mod.classify_day_regime = lambda stats: "clear"
                clear_prior = mod.solcast_prior_from_snapshot(day, w5, snapshot, reliability)
                mod.classify_day_regime = lambda stats: "mixed"
                mixed_prior = mod.solcast_prior_from_snapshot(day, w5, snapshot, reliability)
            finally:
                mod.analyse_weather_day = orig_analyse
                mod.classify_day_regime = orig_classify

            self.assertIsNotNone(clear_prior)
            self.assertIsNotNone(mixed_prior)
            clear_blend = float(np.mean(np.asarray(clear_prior["blend"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT]))
            mixed_blend = float(np.mean(np.asarray(mixed_prior["blend"], dtype=float)[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT]))
            self.assertGreater(clear_blend, mixed_blend)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_run_dayahead_returns_error_class_meta_and_bias(self):
        tmp_root = WORK_TMP / "run-dayahead-error-class"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "run-dayahead-error-class")
            day = date(2026, 3, 20)
            day_s = day.isoformat()
            hourly = pd.DataFrame(
                {
                    "time": pd.date_range(f"{day_s} 00:00:00", periods=24, freq="1h"),
                    "rad": [0.0] * 6 + [100.0, 220.0, 420.0, 600.0, 760.0, 820.0, 780.0, 640.0, 500.0, 320.0, 180.0, 90.0] + [0.0] * 6,
                    "rad_direct": [0.0] * 24,
                    "rad_diffuse": [0.0] * 24,
                    "cloud": [18.0] * 24,
                    "cloud_low": [10.0] * 24,
                    "cloud_mid": [8.0] * 24,
                    "cloud_high": [6.0] * 24,
                    "temp": [28.0] * 24,
                    "rh": [60.0] * 24,
                    "wind": [3.0] * 24,
                    "precip": [0.0] * 24,
                    "cape": [50.0] * 24,
                }
            )
            solar_forecast = np.zeros(mod.SLOTS_DAY, dtype=float)
            solar_forecast[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 20.0

            bundle = {
                "feature_cols": list(mod.FEATURE_COLS),
                "global": {
                    "model": ZeroRegressor(),
                    "scaler": IdentityScaler(len(mod.FEATURE_COLS)),
                    "meta": {"feature_names": list(mod.FEATURE_COLS), "sample_count": 10, "estimators_used": 1},
                },
                "regimes": {},
                "error_classifier": {
                    "class_names": list(mod.ERROR_CLASS_NAMES),
                    "global": {
                        "model": FixedClassifier([0.04, 0.08, 0.16, 0.27, 0.45]),
                        "scaler": IdentityScaler(len(mod.FEATURE_COLS)),
                        "meta": {
                            "feature_names": list(mod.FEATURE_COLS),
                            "centroids_kwh": {"0": -160.0, "1": -70.0, "2": 0.0, "3": 90.0, "4": 220.0},
                        },
                    },
                    "regimes": {},
                    "weather_profiles": {"pairs": {"clear:clear_stable": {"count": 12, "mean": 40.0, "std": 10.0, "mae": 45.0}}},
                },
            }

            orig_fetch_weather = mod.fetch_weather
            orig_load_weather_bias = mod.load_weather_bias_artifact
            orig_apply_bias = mod.apply_weather_bias_adjustment
            orig_validate_w5 = mod.validate_weather_5min
            orig_analyse = mod.analyse_weather_day
            orig_classify = mod.classify_day_regime
            orig_physics = mod.physics_baseline
            orig_load_solcast_snapshot = mod.load_solcast_snapshot
            orig_load_solcast_rel = mod.load_solcast_reliability_artifact
            orig_blend_solcast = mod.blend_physics_with_solcast
            orig_load_artifacts = mod.load_forecast_artifacts
            orig_load_model = mod.load_model_bundle
            orig_error_memory = mod.compute_error_memory
            orig_shape = mod.apply_hour_shape_correction
            orig_activity = mod.apply_activity_hysteresis
            orig_staging = mod.apply_block_staging
            orig_ramp = mod.apply_ramp_limit
            try:
                mod.fetch_weather = lambda day, source="auto": hourly.copy()
                mod.load_weather_bias_artifact = lambda today, allow_build=True: {}
                mod.apply_weather_bias_adjustment = lambda raw_hourly, day, weather_bias: (raw_hourly, {"regime_confidence": 0.9, "matches": 5, "day_regime": "clear", "mean_rad_factor": 1.0, "morning_shift_slots": 0.0})
                mod.validate_weather_5min = lambda day, w5: (True, "")
                mod.analyse_weather_day = lambda day, w5, actual=None: {
                    "sky_class": "clear",
                    "cloud_mean": 15.0,
                    "rad_peak": 820.0,
                    "rh_mean": 60.0,
                    "convective": False,
                    "rainy": False,
                    "vol_index": 0.05,
                }
                mod.classify_day_regime = lambda stats: "clear"
                mod.physics_baseline = lambda day, w5: solar_forecast.copy()
                mod.load_solcast_snapshot = lambda day: None
                mod.load_solcast_reliability_artifact = lambda today, allow_build=True: None
                mod.blend_physics_with_solcast = lambda baseline, prior: (
                    baseline.copy(),
                    {"used_solcast": False, "coverage_ratio": 0.0, "mean_blend": 0.0, "reliability": 0.0, "bias_ratio": 1.0, "raw_prior_ratio": 1.0, "applied_prior_ratio": 1.0, "regime": "", "source": ""},
                )
                mod.load_forecast_artifacts = lambda today, allow_build=True: {}
                mod.load_model_bundle = lambda: bundle
                mod.compute_error_memory = lambda today, w5: np.zeros(mod.SLOTS_DAY, dtype=float)
                mod.apply_hour_shape_correction = lambda forecast, target_s, w5, artifacts: (
                    forecast.copy(),
                    {"hours_shaped": 0, "avg_matches": 0.0, "avg_score": None},
                )
                mod.apply_activity_hysteresis = lambda forecast, target_s, w5, artifacts, bias_meta=None: (
                    forecast.copy(),
                    {"first_slot": mod.SOLAR_START_SLOT, "last_slot": mod.SOLAR_END_SLOT - 1, "history_matches": 0, "bias_shift_slots": 0},
                )
                mod.apply_block_staging = lambda forecast, w5: (
                    forecast.copy(),
                    {"staged_slots": 0, "node_step_kwh": 0.0},
                )
                mod.apply_ramp_limit = lambda arr, max_step=320.0: arr.copy()

                result = mod.run_dayahead(day, day, persist=False)
            finally:
                mod.fetch_weather = orig_fetch_weather
                mod.load_weather_bias_artifact = orig_load_weather_bias
                mod.apply_weather_bias_adjustment = orig_apply_bias
                mod.validate_weather_5min = orig_validate_w5
                mod.analyse_weather_day = orig_analyse
                mod.classify_day_regime = orig_classify
                mod.physics_baseline = orig_physics
                mod.load_solcast_snapshot = orig_load_solcast_snapshot
                mod.load_solcast_reliability_artifact = orig_load_solcast_rel
                mod.blend_physics_with_solcast = orig_blend_solcast
                mod.load_forecast_artifacts = orig_load_artifacts
                mod.load_model_bundle = orig_load_model
                mod.compute_error_memory = orig_error_memory
                mod.apply_hour_shape_correction = orig_shape
                mod.apply_activity_hysteresis = orig_activity
                mod.apply_block_staging = orig_staging
                mod.apply_ramp_limit = orig_ramp

            self.assertIsInstance(result, dict)
            self.assertTrue(bool(result["error_class_meta"]["available"]))
            self.assertGreater(float(result["error_class_total_kwh"]), 0.0)
            self.assertEqual(len(result["error_class_meta"]["slot_weather_buckets"]), mod.SLOTS_DAY)
            self.assertTrue(result["error_class_meta"]["weather_bucket_forecast_summary"])
            self.assertGreater(float(result["forecast_total_kwh"]), float(result["hybrid_total_kwh"]))
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_forecast_qa_logs_bucket_and_classifier_summaries(self):
        tmp_root = WORK_TMP / "qa-weather-summary"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "qa-weather-summary")
            actual = np.zeros(mod.SLOTS_DAY, dtype=float)
            actual[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 100.0
            forecast = actual.copy()
            forecast[mod.SOLAR_START_SLOT + 12:mod.SOLAR_START_SLOT + 24] += 20.0
            present = np.zeros(mod.SLOTS_DAY, dtype=bool)
            present[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = True
            slot_buckets = np.array(["offsolar"] * mod.SLOTS_DAY, dtype=object)
            slot_buckets[mod.SOLAR_START_SLOT:mod.SOLAR_START_SLOT + 30] = "clear_stable"
            slot_buckets[mod.SOLAR_START_SLOT + 30:mod.SOLAR_END_SLOT] = "mixed_volatile"
            predicted_labels = np.full(mod.SLOTS_DAY, mod.ERROR_CLASS_NEUTRAL_IDX, dtype=int)
            predicted_labels[mod.SOLAR_START_SLOT + 12:mod.SOLAR_START_SLOT + 24] = 4
            hybrid = actual.copy()

            orig_actual = mod.load_actual_loss_adjusted_with_presence
            orig_dayahead = mod.load_dayahead_with_presence
            orig_constraints = mod.build_operational_constraint_mask
            orig_snapshot = mod.load_forecast_weather_snapshot
            try:
                mod.load_actual_loss_adjusted_with_presence = lambda day: (actual.copy(), present.copy())
                mod.load_dayahead_with_presence = lambda day: (forecast.copy(), present.copy())
                mod.build_operational_constraint_mask = lambda day: (
                    np.zeros(mod.SLOTS_DAY, dtype=bool),
                    {"operational_mask": np.zeros(mod.SLOTS_DAY, dtype=bool)},
                )
                mod.load_forecast_weather_snapshot = lambda day: {
                    "meta": {
                        "error_class_debug": {
                            "slot_weather_buckets": [str(v) for v in slot_buckets],
                            "hybrid_baseline_kwh": [float(v) for v in hybrid],
                            "predicted_labels": [int(v) for v in predicted_labels],
                            "class_confidence": [0.85] * mod.SLOTS_DAY,
                        }
                    }
                }
                with self.assertLogs(mod.log.name, level="INFO") as captured:
                    mod.forecast_qa(date(2026, 3, 21))
            finally:
                mod.load_actual_loss_adjusted_with_presence = orig_actual
                mod.load_dayahead_with_presence = orig_dayahead
                mod.build_operational_constraint_mask = orig_constraints
                mod.load_forecast_weather_snapshot = orig_snapshot

            joined = "\n".join(captured.output)
            self.assertIn("QA weather buckets [2026-03-20]", joined)
            self.assertIn("clear_stable:WAPE=", joined)
            self.assertIn("QA classifier [2026-03-20]", joined)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)

    def test_run_backtest_logs_bucket_and_regime_summaries(self):
        tmp_root = WORK_TMP / "backtest-weather-summary"
        shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        try:
            mod = load_module(tmp_root, "backtest-weather-summary")
            actual = np.zeros(mod.SLOTS_DAY, dtype=float)
            actual[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = 100.0
            present = np.zeros(mod.SLOTS_DAY, dtype=bool)
            present[mod.SOLAR_START_SLOT:mod.SOLAR_END_SLOT] = True
            forecast = actual.copy()
            forecast[mod.SOLAR_START_SLOT + 6:mod.SOLAR_START_SLOT + 18] += 10.0
            hybrid = actual.copy()
            slot_buckets = np.array(["offsolar"] * mod.SLOTS_DAY, dtype=object)
            slot_buckets[mod.SOLAR_START_SLOT:mod.SOLAR_START_SLOT + 40] = "clear_stable"
            slot_buckets[mod.SOLAR_START_SLOT + 40:mod.SOLAR_END_SLOT] = "mixed_stable"
            predicted_labels = np.full(mod.SLOTS_DAY, mod.ERROR_CLASS_NEUTRAL_IDX, dtype=int)
            predicted_labels[mod.SOLAR_START_SLOT + 6:mod.SOLAR_START_SLOT + 18] = 3

            orig_actual = mod.load_actual_loss_adjusted_with_presence
            orig_snapshot = mod.load_forecast_weather_snapshot
            orig_training = mod.build_training_state
            orig_run_dayahead = mod.run_dayahead
            orig_constraints = mod.build_operational_constraint_mask
            orig_clear_cache = mod.clear_forecast_data_cache
            try:
                mod.clear_forecast_data_cache = lambda: None
                mod.load_actual_loss_adjusted_with_presence = lambda day: (actual.copy(), present.copy())
                mod.load_forecast_weather_snapshot = lambda day: {"meta": {}}
                mod.build_training_state = lambda reference_day: {"ok": True}
                mod.run_dayahead = lambda target_date, reference_day, runtime_state=None, persist=False, require_saved_snapshot_for_past=True: {
                    "forecast": forecast.copy(),
                    "hybrid_baseline": hybrid.copy(),
                    "weather_source": "snapshot",
                    "target_regime": "clear",
                    "solcast_meta": {"used_solcast": True, "mean_blend": 0.84},
                    "error_class_meta": {
                        "slot_weather_buckets": slot_buckets.copy(),
                        "predicted_labels": predicted_labels.copy(),
                        "class_confidence": np.full(mod.SLOTS_DAY, 0.78, dtype=float),
                    },
                }
                mod.build_operational_constraint_mask = lambda day: (
                    np.zeros(mod.SLOTS_DAY, dtype=bool),
                    {"operational_mask": np.zeros(mod.SLOTS_DAY, dtype=bool)},
                )
                with self.assertLogs(mod.log.name, level="INFO") as captured:
                    ok = mod.run_backtest([date(2026, 3, 20)])
            finally:
                mod.clear_forecast_data_cache = orig_clear_cache
                mod.load_actual_loss_adjusted_with_presence = orig_actual
                mod.load_forecast_weather_snapshot = orig_snapshot
                mod.build_training_state = orig_training
                mod.run_dayahead = orig_run_dayahead
                mod.build_operational_constraint_mask = orig_constraints

            self.assertTrue(ok)
            joined = "\n".join(captured.output)
            self.assertIn("Backtest buckets [2026-03-20]", joined)
            self.assertIn("clear_stable:WAPE=", joined)
            self.assertIn("Backtest regimes: clear:WAPE=", joined)
        finally:
            logging.shutdown()
            shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
