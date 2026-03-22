"""
Solar Power Forecasting System
Day-Ahead Forecast Engine · v3.0

Architecture
────────────
1. Solar Geometry      – precise declination / hour-angle / air-mass / AOI
2. Clear-Sky Model     – Ineichen simplified + humidity attenuation
3. Cloud Transmittance – non-linear cloud-cover → transmission mapping (PH-tuned)
4. Physics Baseline    – per-slot kWh_inc from plant specs (dependable rating)
5. Residual ML         – GradientBoosting learns (actual − physics) residual
                         trained on last N_TRAIN_DAYS with recency weighting
6. Error Memory        – rolling weighted average of recent forecast errors
                         applied as a bias-correction term
7. Anomaly Guard       – rejects training days with irradiance/generation
                         inconsistencies before they corrupt the model
8. Forecast QA         – logs MAPE, MBE, skill-score vs persistence each cycle
9. Output              – 5-min kWh_inc series with ±confidence bands

Author  : Engr. Clariden Montaño REE (Engr. M.)
Version : 3.0 (Day-Ahead Hardened)
© 2026 Engr. Clariden Montaño REE. All rights reserved.
"""

import argparse
import json
import logging
import math
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from logging.handlers import RotatingFileHandler

import numpy as np
import pandas as pd
import requests
from joblib import dump, load
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor


class IdentityFeatureScaler:
    """Legacy-compatible no-op transformer for standalone scaler artifacts."""

    def __init__(self, n_features: int):
        self.n_features_in_ = int(n_features)

    def transform(self, X):
        return np.asarray(X, dtype=float)

# ============================================================================
# PATHS
# ============================================================================
PORTABLE_ROOT_RAW = str(
    os.getenv("IM_PORTABLE_DATA_DIR")
    or os.getenv("ADSI_PORTABLE_DATA_DIR")
    or ""
).strip()
PORTABLE_ROOT = Path(PORTABLE_ROOT_RAW) if PORTABLE_ROOT_RAW else None
EXPLICIT_DATA_DIR = str(
    os.getenv("IM_DATA_DIR")
    or os.getenv("ADSI_DATA_DIR")
    or ""
).strip()

if PORTABLE_ROOT is not None:
    BASE = PORTABLE_ROOT / "programdata"
else:
    BASE = Path(os.getenv("PROGRAMDATA") or os.getenv("ALLUSERSPROFILE") or r"C:\ProgramData") / "InverterDashboard"

HISTORY_CTX   = BASE / "history/context/global/global.json"
FORECAST_CTX  = BASE / "forecast/context/global/global.json"
MODEL_FILE    = BASE / "forecast/pv_dayahead_model.joblib"
SCALER_FILE   = BASE / "forecast/pv_dayahead_scaler.joblib"
MODEL_BUNDLE_FILE = BASE / "forecast/pv_dayahead_model_bundle.joblib"
ARTIFACT_FILE = BASE / "forecast/pv_dayahead_artifacts.joblib"
WEATHER_BIAS_FILE = BASE / "forecast/pv_weather_bias.joblib"
SOLCAST_RELIABILITY_FILE = BASE / "forecast/pv_solcast_reliability.joblib"
FORECAST_SNAPSHOT_DIR = BASE / "forecast/snapshots"
WEATHER_DIR   = BASE / "weather"
LOG_FILE      = BASE / "logs/forecast_dayahead.log"
SERVICE_STOP_FILE_RAW = str(
    os.getenv("IM_SERVICE_STOP_FILE")
    or os.getenv("ADSI_SERVICE_STOP_FILE")
    or ""
).strip()
SERVICE_STOP_FILE = Path(SERVICE_STOP_FILE_RAW) if SERVICE_STOP_FILE_RAW else None
SERVICE_STOP_POLL_SEC = 0.5

if EXPLICIT_DATA_DIR:
    APP_DB_FILE = Path(EXPLICIT_DATA_DIR) / "adsi.db"
elif PORTABLE_ROOT is not None:
    APP_DB_FILE = PORTABLE_ROOT / "db" / "adsi.db"
else:
    APPDATA_ROOT = Path(os.getenv("APPDATA") or (str(Path.home() / ".inverter-dashboard")))
    APP_DB_FILE = APPDATA_ROOT / "Inverter-Dashboard" / "adsi.db" if os.getenv("APPDATA") else APPDATA_ROOT / "adsi.db"

if PORTABLE_ROOT is not None:
    IPCONFIG_FILE = PORTABLE_ROOT / "config" / "ipconfig.json"
    LEGACY_IPCONFIG_FILES: list[Path] = []
else:
    IPCONFIG_FILE = APP_DB_FILE.parent / "ipconfig.json"
    LEGACY_IPCONFIG_FILES = []
    for candidate in [BASE / "ipconfig.json", Path(__file__).resolve().parent / "ipconfig.json", Path.cwd() / "ipconfig.json"]:
        if candidate != IPCONFIG_FILE and candidate not in LEGACY_IPCONFIG_FILES:
            LEGACY_IPCONFIG_FILES.append(candidate)

ARCHIVE_DIR = APP_DB_FILE.parent / "archive"
SQLITE_READ_TIMEOUT_SEC = 8.0
SQLITE_WRITE_TIMEOUT_SEC = 20.0
SQLITE_RETRY_ATTEMPTS = 3
SQLITE_RETRY_BACKOFF_SEC = 0.35

for _d in [WEATHER_DIR, MODEL_FILE.parent, FORECAST_SNAPSHOT_DIR, LOG_FILE.parent, APP_DB_FILE.parent, IPCONFIG_FILE.parent]:
    _d.mkdir(parents=True, exist_ok=True)


def _service_stop_requested() -> bool:
    try:
        return bool(SERVICE_STOP_FILE and SERVICE_STOP_FILE.exists())
    except Exception:
        return False


def _clear_service_stop_file() -> None:
    if SERVICE_STOP_FILE is None:
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


def _sleep_with_service_stop(total_sec: float) -> None:
    deadline = time.monotonic() + max(0.0, float(total_sec or 0.0))
    while True:
        if _service_stop_requested():
            raise KeyboardInterrupt
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(SERVICE_STOP_POLL_SEC, remaining))

# ============================================================================
# LOGGING
# ============================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        RotatingFileHandler(LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=7),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("adsi.dayahead")

# ============================================================================
# SITE & PLANT CONSTANTS
# ============================================================================
LAT_DEG  =  6.772269   # Site latitude (Philippines)
LON_DEG  = 125.284455
TZ_NAME  = "Asia/Manila"
TZ_OFFSET = 8         # UTC+8

SLOT_MIN      = 5           # minutes per slot
SLOTS_DAY     = 288         # 24 Ã— 60 / 5
SOLAR_START_H = 5           # 05:00 - first forecast slot
SOLAR_END_H   = 18          # end boundary (exclusive), last slot = 17:55
SOLAR_SLOTS   = (SOLAR_END_H - SOLAR_START_H) * 60 // SLOT_MIN   # 156 slots
SLOT_HOURS    = SLOT_MIN / 60.0
SOLCAST_KWH_PER_MW_SLOT = 1000.0 * SLOT_HOURS

SOLAR_START_SLOT = SOLAR_START_H * 60 // SLOT_MIN
SOLAR_END_SLOT   = SOLAR_END_H   * 60 // SLOT_MIN

# Plant
EXPORT_MW          = 24.0   # fallback export ceiling when no explicit setting exists
FORECAST_EXPORT_LIMIT_SETTING_KEY = "forecastExportLimitMw"
IPCONFIG_SETTING_KEY = "ipConfigJson"
DEFAULT_INVERTER_LOSS_PCT = 2.5
UNIT_KW_MAX        = 997.0   # kW peak per inverter (4-node complete)
UNIT_KW_DEPENDABLE = 917.0   # kW dependable per inverter
PLANT_MW_FALLBACK  = 40.0    # used when ipconfig absent

# Physics thresholds
RAD_MIN_WM2   = 8.0    # W/mÂ² â€“ ignore radiation below this
TEMP_REF_C    = 25.0   # STC temperature
GAMMA_TC      = -0.004 # power temp coeff (/Â°C) â€“ typical Si module

# ============================================================================
# ML & TRAINING
# ============================================================================
N_TRAIN_DAYS   = 45    # rolling training window (days)
MIN_TRAIN_DAYS = 5     # minimum days before ML is used
MIN_SAMPLES    = 60    # minimum usable slots per training day
RECENCY_BASE = 1.0     # legacy compatibility; hardened path uses sample weights
MIN_HISTORY_SOLAR_SLOTS = MIN_SAMPLES
MIN_DAYAHEAD_SOLAR_SLOTS = max(24, MIN_SAMPLES // 2)
TRAIN_WEIGHT_HALF_LIFE_DAYS = 14.0
TRAIN_WEIGHT_FLOOR = 0.18
SHAPE_LOOKBACK_DAYS = 45
SHAPE_MIN_MATCHES = 4
SHAPE_TOP_K = 6
SHAPE_BLEND_MIN = 0.42
SHAPE_BLEND_MAX = 0.78
ACTIVITY_SUSTAIN_SLOTS = 2
STARTUP_RAD_WM2 = 80.0
STOPPING_RAD_WM2 = 28.0
ACTIVITY_MIN_FRACTION = 0.0022
LOW_POWER_STAGE_FRACTION = 0.16
STAGING_BLEND_MAX = 0.72
MODULES_PER_INVERTER = 4
NODE_KW_NOMINAL = 226.73
REGIME_MODEL_MIN_DAYS = 6
REGIME_MODEL_MIN_SAMPLES = 320
REGIME_BLEND_BASE = 0.52
REGIME_BLEND_MAX = 0.82
WEATHER_BUCKET_RAIN_MM = 0.05
WEATHER_BUCKET_RAIN_CLOUD = 82.0
WEATHER_BUCKET_RAIN_CAPE = 650.0
WEATHER_BUCKET_CLEAR_CLOUD = 25.0
WEATHER_BUCKET_CLEAR_EDGE_CLOUD = 40.0
WEATHER_BUCKET_CLEAR_KT = 0.70
WEATHER_BUCKET_CLEAR_EDGE_KT = 0.55
WEATHER_BUCKET_MIXED_KT = 0.40
WEATHER_BUCKET_MIXED_CLOUD = 70.0
WEATHER_BUCKET_MIXED_VOL_CLOUD = 80.0
WEATHER_BUCKET_CLEAR_DRAD = 90.0
WEATHER_BUCKET_MIXED_VOL_DRAD = 120.0
WEATHER_BUCKETS = (
    "clear_stable",
    "clear_edge",
    "mixed_stable",
    "mixed_volatile",
    "overcast",
    "rainy",
)
WEATHER_BIAS_LOOKBACK_DAYS = 21
WEATHER_BIAS_MIN_MATCHES = 4
WEATHER_BIAS_TOP_K = 6
WEATHER_BIAS_RAD_BLEND = 0.38
WEATHER_BIAS_CLOUD_BLEND = 0.26
WEATHER_BIAS_SHIFT_BLEND = 0.35
WEATHER_BIAS_FACTOR_CLIP = (0.84, 1.18)
WEATHER_BIAS_CLOUD_DELTA_CLIP = (-16.0, 16.0)
INTRADAY_MIN_OBS_SLOTS = 6
INTRADAY_MAX_OBS_SLOTS = 36
INTRADAY_RATIO_CLIP = (0.65, 1.35)
INTRADAY_RECENT_RATIO_CLIP = (0.55, 1.45)
INTRADAY_BLEND_MAX = 0.72
SOLCAST_MIN_USABLE_SLOTS = 48
SOLCAST_RELIABILITY_LOOKBACK_DAYS = 30
SOLCAST_RELIABILITY_MIN_DAYS = 5
SOLCAST_PRIOR_BLEND_MIN = 0.28
SOLCAST_PRIOR_BLEND_MAX = 0.92
SOLCAST_PRIMARY_COVERAGE_MIN = 0.80
SOLCAST_PRIMARY_RELIABILITY_MIN = 0.50
SOLCAST_PRIMARY_BLEND_FLOOR_MIN = 0.76
SOLCAST_PRIMARY_BLEND_FLOOR_MAX = 0.90
SOLCAST_PRIOR_TOTAL_RATIO_CLIP = (0.65, 1.70)
SOLCAST_PRIOR_SPREAD_FRAC_CLIP = 1.25
SOLCAST_BIAS_RATIO_CLIP = (0.82, 1.18)
SOLCAST_RESIDUAL_DAMP_MIN = 0.18
SOLCAST_RESIDUAL_DAMP_MAX = 0.72
SOLCAST_RESIDUAL_PRIMARY_CAP = 0.40
SOLCAST_RESOLUTION_WEIGHT_FALLBACK = 0.50
SOLCAST_RESOLUTION_BLEND_SCALE_MIN = 0.88
SOLCAST_RESOLUTION_BLEND_SCALE_MAX = 1.12
SOLCAST_RESOLUTION_PRIMARY_SCALE_MIN = 0.94
SOLCAST_RESOLUTION_PRIMARY_SCALE_MAX = 1.06
SOLCAST_RESOLUTION_AUTHORITY_MIN = 0.72
SOLCAST_RESOLUTION_AUTHORITY_MAX = 1.00

# Adaptive ML residual blending (higher uncertainty -> lower ML influence)
ML_BLEND_MIN = 0.35
ML_BLEND_MAX = 1.00
ML_BLEND_ALPHA = 0.45

# Error memory
ERR_MEMORY_DAYS   = 7      # days used for bias correction
ERR_MEMORY_DECAY  = 0.72   # older day weight decay (geometric series)
ERROR_ALPHA       = 0.28   # fraction of error correction to apply
ERROR_CLASS_NAMES = (
    "strong_over",
    "mild_over",
    "neutral",
    "mild_under",
    "strong_under",
)
ERROR_CLASS_NEUTRAL_IDX = 2
ERROR_CLASS_MILD_THRESHOLD = 0.04
ERROR_CLASS_STRONG_THRESHOLD = 0.14
ERROR_CLASS_OPPORTUNITY_FLOOR_FRAC = 0.12
ERROR_CLASS_BLEND_MIN = 0.10
ERROR_CLASS_BLEND_MAX = 0.35
ERROR_CLASS_BLEND_CONFIDENCE_FLOOR = 0.40
ERROR_CLASS_BIAS_CAP_FRAC = 0.18
ERROR_CLASS_CONF_BAND_ADD_MAX = 0.14
ERROR_CLASS_SEVERE_BAND_ADD_MAX = 0.08
ERROR_CLASS_CENTROID_SHRINKAGE_SAMPLES = 36.0
ERROR_CLASS_CALIBRATION_MIN_DAYS = 8
ERROR_CLASS_CALIBRATION_HOLDOUT_MAX_DAYS = 6
ERROR_CLASS_CALIBRATION_HOLDOUT_MIN_SAMPLES = 144
ERROR_CLASS_CALIBRATION_TEMP_MIN = 0.70
ERROR_CLASS_CALIBRATION_TEMP_MAX = 2.40
ERROR_CLASS_CALIBRATION_TEMP_STEPS = 18
ERROR_CLASS_SUPPORT_MILD_FULL_COUNT = 24.0
ERROR_CLASS_SUPPORT_STRONG_FULL_COUNT = 36.0
ERROR_CLASS_PROFILE_MIN_RELIABILITY = 0.55
ERROR_CLASS_PROFILE_DEFAULT_RELIABILITY = 0.62
ERROR_CLASS_PROFILE_PAIR_FULL_COUNT = 30.0
ERROR_CLASS_PROFILE_BUCKET_FULL_COUNT = 42.0
ERROR_CLASS_PROFILE_REGIME_FULL_COUNT = 60.0
ERROR_CLASS_PROFILE_MAE_REF_FRAC = 0.18
ERROR_CLASS_PROFILE_STD_REF_FRAC = 0.24
MODEL_STAGE_HOLDOUT_MIN_SAMPLES = 144

# Anomaly rejection thresholds
ANOM_MIN_CF    = 0.02   # capacity factor â€“ days below this are bad
ANOM_MAX_CF    = 1.05   # capacity factor â€“ days above this are bad
ANOM_RAD_CORR  = 0.55   # min Pearson r between radiation & generation

# Confidence bands
CONF_CLEAR_BASE = 0.08   # Â±8% on clear days
CONF_CLOUD_ADD  = 0.20   # additional Â±20% on overcast / volatile days
CLOUD_VOLATILE  = 60.0   # cloud cover % threshold for "volatile"

# Forecast re-run schedule (hours UTC+8 when a new day-ahead is computed)
DA_RUN_HOURS_PRIMARY = {6, 18}   # always run (retrain + generate)
MIN_HOURLY_POINTS = 20
MIN_5MIN_POINTS = 240
OPERATIONAL_CONSTRAINT_LOOKBACK_DAYS = 90

# ============================================================================
# I/O HELPERS
# ============================================================================

def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.error("JSON load failed %s: %s", path, e)
        return {}


def _save_json(path: Path, data: dict) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(path)
        return True
    except Exception as e:
        log.error("JSON save failed %s: %s", path, e)
        return False


def _has_forecast_dayahead_in_db(day: str) -> bool:
    """Check if forecast_dayahead has a complete solar-window rowset for the day."""
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            row = conn.execute(
                """
                SELECT COUNT(DISTINCT slot)
                  FROM forecast_dayahead
                 WHERE date = ?
                   AND slot >= ?
                   AND slot < ?
                """,
                (str(day), int(SOLAR_START_SLOT), int(SOLAR_END_SLOT)),
            ).fetchone()
            return int(row[0] or 0) >= int(SOLAR_SLOTS)
    except Exception:
        return False


def _is_retryable_sqlite_error(exc: Exception) -> bool:
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    msg = str(exc).lower()
    return (
        "database is locked" in msg
        or "database is busy" in msg
        or "locked" == msg.strip()
        or "busy" == msg.strip()
    )


def _open_sqlite(db_path: Path, timeout_sec: float, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        uri = f"file:{db_path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, timeout=timeout_sec, uri=True)
    else:
        conn = sqlite3.connect(str(db_path), timeout=timeout_sec)
    conn.execute(f"PRAGMA busy_timeout = {int(max(0.1, float(timeout_sec)) * 1000)}")
    return conn


def _sleep_sqlite_retry(attempt: int) -> None:
    time.sleep(SQLITE_RETRY_BACKOFF_SEC * max(1, int(attempt)))


def _coerce_non_negative_float(value, default: float = 0.0) -> float:
    try:
        f = float(value)
    except Exception:
        return float(default)
    if not math.isfinite(f):
        return float(default)
    return max(0.0, f)


def _coerce_optional_non_negative_float(value) -> float | None:
    try:
        f = float(value)
    except Exception:
        return None
    if not math.isfinite(f):
        return None
    return max(0.0, f)


def _normalize_solcast_slot_pair(
    energy_kwh_value,
    power_mw_value,
) -> tuple[float | None, float | None]:
    energy_kwh = _coerce_optional_non_negative_float(energy_kwh_value)
    power_mw = _coerce_optional_non_negative_float(power_mw_value)
    # Solcast arrives as MW. Forecast scoring inside the engine is done on a
    # per-slot energy basis, so derive the missing side when only one form is
    # stored in the snapshot row.
    if energy_kwh is None and power_mw is not None:
        energy_kwh = power_mw * SOLCAST_KWH_PER_MW_SLOT
    if power_mw is None and energy_kwh is not None:
        power_mw = energy_kwh / max(SOLCAST_KWH_PER_MW_SLOT, 1e-9)
    return energy_kwh, power_mw


def _empty_slot_values() -> np.ndarray:
    return np.zeros(SLOTS_DAY, dtype=float)


def _empty_slot_presence() -> np.ndarray:
    return np.zeros(SLOTS_DAY, dtype=bool)


def _count_solar_present_slots(present: np.ndarray | None) -> int:
    if present is None:
        return 0
    arr = np.asarray(present, dtype=bool)
    if arr.size < SLOTS_DAY:
        return 0
    return int(np.count_nonzero(arr[SOLAR_START_SLOT:SOLAR_END_SLOT]))


def _parse_slot_from_time_text(day: str, time_text: str | None) -> int | None:
    try:
        raw = str(time_text or "").strip()
        if not raw:
            return None
        parts = [int(p) for p in raw.split(":")]
        if len(parts) < 2:
            return None
        hh = parts[0]
        mm = parts[1]
        if hh < 0 or hh > 23 or mm < 0 or mm > 59:
            return None
        slot = (hh * 60 + mm) // SLOT_MIN
        return slot if 0 <= slot < SLOTS_DAY else None
    except Exception:
        return None


def _default_legacy_slot(index: int, total_rows: int) -> int:
    if total_rows <= SOLAR_SLOTS:
        return SOLAR_START_SLOT + int(index)
    return int(index)


def _merge_slot_series(
    label: str,
    day: str,
    primary_values: np.ndarray | None,
    primary_present: np.ndarray | None,
    fallback_values: np.ndarray | None,
    fallback_present: np.ndarray | None,
    min_solar_slots: int,
) -> np.ndarray | None:
    if primary_values is None and fallback_values is None:
        return None

    if primary_values is None:
        merged_values = np.array(fallback_values, dtype=float, copy=True)
        merged_present = np.array(fallback_present, dtype=bool, copy=True)
    else:
        merged_values = np.array(primary_values, dtype=float, copy=True)
        merged_present = np.array(primary_present, dtype=bool, copy=True)
        if fallback_values is not None and fallback_present is not None:
            fill_mask = (~merged_present) & np.asarray(fallback_present, dtype=bool)
            if np.any(fill_mask):
                merged_values[fill_mask] = np.asarray(fallback_values, dtype=float)[fill_mask]
                merged_present[fill_mask] = True
                log.info(
                    "%s source gap fill [%s]: filled %d slots from legacy fallback",
                    label,
                    day,
                    int(np.count_nonzero(fill_mask)),
                )

    solar_slots = _count_solar_present_slots(merged_present)
    if solar_slots <= 0:
        return None
    if solar_slots < min_solar_slots:
        log.warning(
            "%s coverage is sparse [%s]: %d solar slots available (min=%d). Skipping this day.",
            label,
            day,
            solar_slots,
            min_solar_slots,
        )
        return None

    merged_values = np.nan_to_num(merged_values, nan=0.0, posinf=0.0, neginf=0.0)
    merged_values[merged_values < 0] = 0.0
    return merged_values


def _merge_slot_series_with_presence(
    label: str,
    day: str,
    primary_values: np.ndarray | None,
    primary_present: np.ndarray | None,
    fallback_values: np.ndarray | None,
    fallback_present: np.ndarray | None,
    min_solar_slots: int,
) -> tuple[np.ndarray | None, np.ndarray | None]:
    if primary_values is None and fallback_values is None:
        return None, None

    if primary_values is None:
        merged_values = np.array(fallback_values, dtype=float, copy=True)
        merged_present = np.array(fallback_present, dtype=bool, copy=True)
    else:
        merged_values = np.array(primary_values, dtype=float, copy=True)
        merged_present = np.array(primary_present, dtype=bool, copy=True)
        if fallback_values is not None and fallback_present is not None:
            fill_mask = (~merged_present) & np.asarray(fallback_present, dtype=bool)
            if np.any(fill_mask):
                merged_values[fill_mask] = np.asarray(fallback_values, dtype=float)[fill_mask]
                merged_present[fill_mask] = True
                log.info(
                    "%s source gap fill [%s]: filled %d slots from legacy fallback",
                    label,
                    day,
                    int(np.count_nonzero(fill_mask)),
                )

    solar_slots = _count_solar_present_slots(merged_present)
    if solar_slots <= 0:
        return None, None
    if solar_slots < min_solar_slots:
        log.warning(
            "%s coverage is sparse [%s]: %d solar slots available (min=%d). Skipping this day.",
            label,
            day,
            solar_slots,
            min_solar_slots,
        )
        return None, None

    merged_values = np.nan_to_num(merged_values, nan=0.0, posinf=0.0, neginf=0.0)
    merged_values[merged_values < 0] = 0.0
    return merged_values, merged_present


def clear_forecast_data_cache() -> None:
    global _cached_loss_factors
    _cached_loss_factors = None
    _read_setting_value.cache_clear()
    load_forecast_export_limit_mw.cache_clear()
    load_ipconfig_authoritative.cache_clear()
    load_actual.cache_clear()
    load_actual_with_presence.cache_clear()
    load_actual_loss_adjusted.cache_clear()
    load_actual_loss_adjusted_with_presence.cache_clear()
    load_dayahead.cache_clear()
    load_dayahead_with_presence.cache_clear()
    load_intraday_adjusted.cache_clear()
    load_intraday_adjusted_with_presence.cache_clear()
    load_operational_constraint_profile.cache_clear()


def _slice_weather_day(df: pd.DataFrame, day: str) -> pd.DataFrame:
    """Return rows belonging only to YYYY-MM-DD (local naive timestamps)."""
    if df is None or df.empty or "time" not in df.columns:
        return pd.DataFrame()
    out = df.copy()
    out["time"] = pd.to_datetime(out["time"], errors="coerce")
    out = out.dropna(subset=["time"])
    if out.empty:
        return pd.DataFrame()
    day_start = pd.Timestamp(f"{day} 00:00:00")
    day_end = day_start + pd.Timedelta(days=1)
    out = out[(out["time"] >= day_start) & (out["time"] < day_end)].copy()
    out = out.sort_values("time").reset_index(drop=True)
    return out


def _is_past_day(day: str) -> bool:
    try:
        req = datetime.strptime(day, "%Y-%m-%d").date()
    except Exception:
        return False
    return req < datetime.now().date()


def validate_weather_hourly(day: str, wdf: pd.DataFrame) -> tuple[bool, str]:
    req_cols = {
        "time", "rad", "rad_direct", "rad_diffuse", "cloud", "cloud_low",
        "cloud_mid", "cloud_high", "temp", "rh", "wind", "precip", "cape"
    }
    if wdf is None or wdf.empty:
        return False, "weather dataframe is empty"
    missing = [c for c in req_cols if c not in wdf.columns]
    if missing:
        return False, f"missing weather columns: {', '.join(missing)}"
    if len(wdf) < MIN_HOURLY_POINTS:
        return False, f"insufficient hourly rows ({len(wdf)})"
    return True, ""


def validate_weather_5min(day: str, w5: pd.DataFrame) -> tuple[bool, str]:
    req_cols = [
        "rad", "rad_direct", "rad_diffuse", "cloud", "cloud_low", "cloud_mid",
        "temp", "rh", "wind"
    ]
    if w5 is None or w5.empty:
        return False, "interpolated weather is empty"
    missing = [c for c in req_cols if c not in w5.columns]
    if missing:
        return False, f"missing interpolated weather columns: {', '.join(missing)}"
    if len(w5) < MIN_5MIN_POINTS:
        return False, f"insufficient 5-min slots ({len(w5)})"
    for c in req_cols:
        arr = pd.to_numeric(w5[c], errors="coerce").values
        if not np.isfinite(arr).any():
            return False, f"column {c} has no finite values"
    return True, ""


# ============================================================================
# IPCONFIG RESOLUTION
# ============================================================================

def _default_ipconfig() -> dict:
    cfg = {"inverters": {}, "poll_interval": {}, "units": {}, "losses": {}}
    for i in range(1, 28):
        key = str(i)
        cfg["inverters"][key] = ""
        cfg["poll_interval"][key] = 0.05
        cfg["units"][key] = [1, 2, 3, 4]
        cfg["losses"][key] = float(DEFAULT_INVERTER_LOSS_PCT)
    return cfg


def _sanitize_ipconfig(data) -> dict:
    out = _default_ipconfig()
    src = data if isinstance(data, dict) else {}
    src_inv = src.get("inverters", {}) if isinstance(src.get("inverters"), dict) else {}
    src_poll = src.get("poll_interval", {}) if isinstance(src.get("poll_interval"), dict) else {}
    src_units = src.get("units", {}) if isinstance(src.get("units"), dict) else {}
    src_losses = src.get("losses", {}) if isinstance(src.get("losses"), dict) else {}

    for i in range(1, 28):
        key = str(i)
        ip_raw = src_inv.get(key, src_inv.get(i, out["inverters"][key]))
        poll_raw = src_poll.get(key, src_poll.get(i, out["poll_interval"][key]))
        units_raw = src_units.get(key, src_units.get(i, out["units"][key]))
        loss_raw = src_losses.get(key, src_losses.get(i, out["losses"][key]))

        ip = str(ip_raw or "").strip()

        try:
            poll = float(poll_raw)
        except Exception:
            poll = float(out["poll_interval"][key])
        if not math.isfinite(poll) or poll < 0.01:
            poll = float(out["poll_interval"][key])

        if isinstance(units_raw, list):
            units = []
            for unit in units_raw:
                try:
                    unit_i = int(unit)
                except Exception:
                    continue
                if 1 <= unit_i <= 4 and unit_i not in units:
                    units.append(unit_i)
        else:
            units = list(out["units"][key])

        try:
            loss_pct = float(loss_raw)
        except Exception:
            loss_pct = float(out["losses"][key])
        if not math.isfinite(loss_pct) or loss_pct < 0.0 or loss_pct > 100.0:
            loss_pct = float(out["losses"][key])

        out["inverters"][key] = ip
        out["poll_interval"][key] = poll
        out["units"][key] = units
        out["losses"][key] = loss_pct

    return out


@lru_cache(maxsize=1)
def load_ipconfig_authoritative() -> dict:
    raw = _read_setting_value(IPCONFIG_SETTING_KEY)
    if raw:
        try:
            return {
                "config": _sanitize_ipconfig(json.loads(raw)),
                "source": f"settings:{IPCONFIG_SETTING_KEY}",
                "path": str(APP_DB_FILE),
            }
        except Exception as e:
            log.warning("Invalid %s setting - falling back to file ipconfig: %s", IPCONFIG_SETTING_KEY, e)

    for path in [IPCONFIG_FILE, *LEGACY_IPCONFIG_FILES]:
        cfg = _load_json(path)
        if isinstance(cfg, dict) and cfg:
            return {
                "config": _sanitize_ipconfig(cfg),
                "source": "file",
                "path": str(path),
            }

    return {
        "config": _default_ipconfig(),
        "source": "default",
        "path": str(IPCONFIG_FILE),
    }


# ============================================================================
# PLANT CAPACITY
# ============================================================================

def _sanitize_units(raw) -> list[int]:
    """Return unique unit IDs in [1..4]."""
    out = []
    seen = set()
    if not isinstance(raw, list):
        return out
    for v in raw:
        try:
            u = int(v)
        except Exception:
            continue
        if 1 <= u <= 4 and u not in seen:
            out.append(u)
            seen.add(u)
    return out


def plant_capacity_profile() -> dict:
    """
    Capacity model from ipconfig:
      - 1 inverter full rating == 4 nodes
      - partial inverter scales by enabled_nodes / 4
      - if units entry is missing for a configured inverter, assume 4 nodes
      - if units entry is [], inverter contributes 0 nodes
    """
    ipconfig_meta = load_ipconfig_authoritative()
    cfg = ipconfig_meta.get("config", {}) if isinstance(ipconfig_meta, dict) else {}
    inv_map = cfg.get("inverters", {}) or {}
    unit_map = cfg.get("units", {}) or {}

    inv_map = {str(k): v for k, v in inv_map.items()}
    unit_map = {str(k): v for k, v in unit_map.items()}

    all_ids = set(inv_map.keys()) | set(unit_map.keys())
    if not all_ids:
        fb_kw = PLANT_MW_FALLBACK * 1000.0
        return {
            "configured_inverters": 0,
            "enabled_nodes": 0,
            "equiv_inverters": fb_kw / max(UNIT_KW_DEPENDABLE, 1.0),
            "dependable_kw": fb_kw,
            "max_kw": fb_kw,
            "source": "fallback",
            "ipconfig_source": str(ipconfig_meta.get("source", "missing")),
            "ipconfig_path": str(ipconfig_meta.get("path", IPCONFIG_FILE)),
        }

    def _sort_key(k: str):
        try:
            return (0, int(k))
        except Exception:
            return (1, k)

    loss_map = cfg.get("losses", {}) or {}
    loss_map = {str(k): v for k, v in loss_map.items()}

    configured = 0
    enabled_nodes = 0
    loss_adjusted_equiv = 0.0
    for inv_id in sorted(all_ids, key=_sort_key):
        ip = str(inv_map.get(inv_id, "") or "").strip()

        # If inverter exists in ip map but IP is blank, skip it.
        if inv_map and inv_id in inv_map and not ip:
            continue

        configured += 1
        raw_units = unit_map.get(inv_id, None)
        if raw_units is None:
            # Backward compatibility: no units config means full inverter.
            n_nodes = 4
        else:
            n_nodes = len(_sanitize_units(raw_units))
        enabled_nodes += n_nodes

        # Per-inverter transmission loss (cable degradation / distance)
        loss_pct = 0.0
        try:
            loss_pct = float(loss_map.get(inv_id, 0))
        except (TypeError, ValueError):
            pass
        if loss_pct < 0 or loss_pct > 100:
            loss_pct = 0.0
        inv_equiv = n_nodes / 4.0
        loss_adjusted_equiv += inv_equiv * (1.0 - loss_pct / 100.0)

    if configured == 0:
        fb_kw = PLANT_MW_FALLBACK * 1000.0
        return {
            "configured_inverters": 0,
            "enabled_nodes": 0,
            "equiv_inverters": fb_kw / max(UNIT_KW_DEPENDABLE, 1.0),
            "dependable_kw": fb_kw,
            "max_kw": fb_kw,
            "source": "fallback",
            "ipconfig_source": str(ipconfig_meta.get("source", "missing")),
            "ipconfig_path": str(ipconfig_meta.get("path", IPCONFIG_FILE)),
        }

    equiv_inverters = enabled_nodes / 4.0
    dependable_kw = loss_adjusted_equiv * UNIT_KW_DEPENDABLE
    max_kw = loss_adjusted_equiv * UNIT_KW_MAX

    return {
        "configured_inverters": configured,
        "enabled_nodes": enabled_nodes,
        "equiv_inverters": equiv_inverters,
        "loss_adjusted_equiv": loss_adjusted_equiv,
        "dependable_kw": dependable_kw,
        "max_kw": max_kw,
        "source": "ipconfig",
        "ipconfig_source": str(ipconfig_meta.get("source", "file")),
        "ipconfig_path": str(ipconfig_meta.get("path", IPCONFIG_FILE)),
    }


def plant_capacity_kw(dependable: bool = True) -> float:
    """Return plant capacity in kW from ipconfig or fallback."""
    p = plant_capacity_profile()
    cap = float(p["dependable_kw"] if dependable else p["max_kw"])
    log.debug(
        "Plant capacity [%s]: cfg_inv=%d enabled_nodes=%d equiv_inv=%.3f dep=%.1f kW max=%.1f kW",
        p["source"],
        p["configured_inverters"],
        p["enabled_nodes"],
        p["equiv_inverters"],
        p["dependable_kw"],
        p["max_kw"],
    )
    return cap

def slot_cap_kwh(dependable: bool = True) -> float:
    """Maximum kWh in a single 5-min slot based on plant capacity only.

    NOTE: The configured forecast export cap is intentionally NOT applied here.
    Applying it to the forecast curve creates an artificial flat plateau
    that hides the true shape â€” cloud dips, afternoon shoulders, etc.
    Export limiting is a dispatch/curtailment action, not a forecast property.
    """
    cap_kw = plant_capacity_kw(dependable)
    return cap_kw * SLOT_MIN / 60.0


def plant_node_count() -> int:
    """Return enabled power-module count across the plant."""
    profile = plant_capacity_profile()
    enabled_nodes = int(profile.get("enabled_nodes") or 0)
    if enabled_nodes > 0:
        return enabled_nodes
    fallback = int(round(max(profile.get("max_kw", 0.0), plant_capacity_kw(False)) / max(NODE_KW_NOMINAL, 1.0)))
    return max(1, fallback)


def node_slot_kwh() -> float:
    """Approximate per-node 5-minute energy step used for low-power staging."""
    node_count = max(1, plant_node_count())
    return plant_capacity_kw(True) * SLOT_MIN / 60.0 / node_count


def activity_threshold_kwh() -> float:
    """
    Minimum meaningful slot energy used for activity detection.

    This stays small enough for dawn pickup but large enough to suppress
    tiny non-zero artifacts created by interpolated weather.
    """
    return max(1.0, min(node_slot_kwh() * 0.18, slot_cap_kwh(True) * ACTIVITY_MIN_FRACTION))


def _solar_hour_bounds(hour: int) -> tuple[int, int]:
    start = int(hour) * 60 // SLOT_MIN
    end = start + (60 // SLOT_MIN)
    return max(0, start), min(SLOTS_DAY, end)


def _season_bucket_from_day(day: str) -> str:
    try:
        month = datetime.strptime(day, "%Y-%m-%d").month
    except Exception:
        month = datetime.now().month
    return "dry" if month in (12, 1, 2, 3, 4, 5) else "wet"


def _rolling_window_bounds(length: int, window: int, center: bool = False) -> tuple[np.ndarray, np.ndarray]:
    size = max(int(length), 0)
    win = max(int(window), 1)
    idx = np.arange(size, dtype=int)
    if center:
        left = (win - 1) // 2
        right = win // 2
        start = np.clip(idx - left, 0, size)
        end = np.clip(idx + right + 1, 0, size)
    else:
        start = np.clip(idx - win + 1, 0, size)
        end = idx + 1
    return start, end


def _rolling_sum(values: np.ndarray, window: int, center: bool = False) -> np.ndarray:
    arr = np.asarray(values, dtype=float).reshape(-1)
    if arr.size <= 0:
        return np.zeros(0, dtype=float)
    start, end = _rolling_window_bounds(arr.size, window, center=center)
    valid = np.isfinite(arr)
    arr_valid = np.where(valid, arr, 0.0)
    csum = np.concatenate(([0.0], np.cumsum(arr_valid, dtype=float)))
    count = np.concatenate(([0], np.cumsum(valid.astype(np.int64), dtype=np.int64)))
    out = csum[end] - csum[start]
    out[(count[end] - count[start]) <= 0] = np.nan
    return out


def _rolling_mean(values: np.ndarray, window: int, center: bool = False) -> np.ndarray:
    arr = np.asarray(values, dtype=float).reshape(-1)
    if arr.size <= 0:
        return np.zeros(0, dtype=float)
    start, end = _rolling_window_bounds(arr.size, window, center=center)
    valid = np.isfinite(arr)
    arr_valid = np.where(valid, arr, 0.0)
    csum = np.concatenate(([0.0], np.cumsum(arr_valid, dtype=float)))
    count = np.concatenate(([0], np.cumsum(valid.astype(np.int64), dtype=np.int64)))
    numer = csum[end] - csum[start]
    denom = count[end] - count[start]
    return np.divide(numer, denom, out=np.full(arr.size, np.nan, dtype=float), where=denom > 0)


def _rolling_std(values: np.ndarray, window: int, center: bool = False, ddof: int = 1) -> np.ndarray:
    arr = np.asarray(values, dtype=float).reshape(-1)
    if arr.size <= 0:
        return np.zeros(0, dtype=float)
    start, end = _rolling_window_bounds(arr.size, window, center=center)
    valid = np.isfinite(arr)
    arr_valid = np.where(valid, arr, 0.0)
    csum = np.concatenate(([0.0], np.cumsum(arr_valid, dtype=float)))
    csum_sq = np.concatenate(([0.0], np.cumsum(arr_valid * arr_valid, dtype=float)))
    count = np.concatenate(([0], np.cumsum(valid.astype(np.int64), dtype=np.int64)))
    numer = csum[end] - csum[start]
    numer_sq = csum_sq[end] - csum_sq[start]
    denom_count = count[end] - count[start]
    mean = np.divide(numer, denom_count, out=np.zeros(arr.size, dtype=float), where=denom_count > 0)
    var_numer = np.clip(numer_sq - (numer * mean), 0.0, None)
    denom = denom_count - max(int(ddof), 0)
    var = np.divide(var_numer, denom, out=np.full(arr.size, np.nan, dtype=float), where=denom > 0)
    return np.sqrt(np.clip(var, 0.0, None))


def _normalize_profile(values: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    if arr.size == 0:
        return np.array([], dtype=float)
    arr = _rolling_mean(arr, 3, center=True)
    total = float(arr.sum())
    if total <= 0:
        return np.full(arr.size, 1.0 / arr.size, dtype=float)
    return arr / total


def _find_first_active_slot(values: np.ndarray, threshold: float | None = None, sustain_slots: int = ACTIVITY_SUSTAIN_SLOTS) -> int | None:
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    threshold = activity_threshold_kwh() if threshold is None else float(threshold)
    sustain = max(1, int(sustain_slots))
    for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT - sustain + 1):
        window = arr[slot:slot + sustain]
        if window.size and float(window.mean()) >= threshold and np.all(window >= threshold * 0.55):
            return slot
    return None


def _find_last_active_slot(values: np.ndarray, threshold: float | None = None, sustain_slots: int = ACTIVITY_SUSTAIN_SLOTS) -> int | None:
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    threshold = activity_threshold_kwh() if threshold is None else float(threshold)
    sustain = max(1, int(sustain_slots))
    for slot in range(SOLAR_END_SLOT - sustain, SOLAR_START_SLOT - 1, -1):
        window = arr[slot:slot + sustain]
        if window.size and float(window.mean()) >= threshold and np.all(window >= threshold * 0.45):
            return slot + window.size - 1
    return None


def _sample_weight_for_days_ago(days_ago: int) -> float:
    days = max(0.0, float(days_ago) - 1.0)
    weight = 0.5 ** (days / max(TRAIN_WEIGHT_HALF_LIFE_DAYS, 1e-6))
    return float(np.clip(weight, TRAIN_WEIGHT_FLOOR, 1.0))


def _weather_cache_path(day: str, source_kind: str) -> Path:
    loc_tag = f"{LAT_DEG:.6f}_{LON_DEG:.6f}".replace("-", "m")
    tag = "archive" if str(source_kind or "").strip().lower() == "archive" else "forecast"
    return WEATHER_DIR / f"om_{tag}_{day}_{loc_tag}.csv"


# ============================================================================
# WEATHER FETCH & CACHE
# ============================================================================

def fetch_weather(day: str, source: str = "auto") -> pd.DataFrame | None:
    """
    Fetch hourly weather from Open-Meteo for *day* (YYYY-MM-DD).

    `source="archive"` always means observed archive weather for historical
    training and bias evaluation. `source="forecast"` means the provider
    forecast used for day-ahead generation. `source="auto"` uses archive for
    past days and forecast for today/future days.
    """
    src_raw = str(source or "auto").strip().lower()
    if src_raw not in {"auto", "archive", "forecast"}:
        src_raw = "auto"
    source_kind = "archive" if src_raw == "archive" or (src_raw == "auto" and _is_past_day(day)) else "forecast"
    cache = _weather_cache_path(day, source_kind)
    today = datetime.now().strftime("%Y-%m-%d")

    def _load_cached_weather() -> pd.DataFrame | None:
        try:
            if not cache.exists():
                return None
            df = pd.read_csv(cache, parse_dates=["time"])
            day_df = _slice_weather_day(df, day)
            ok, reason = validate_weather_hourly(day, day_df)
            if ok:
                log.debug("Weather cache hit [%s]: %s (%d rows)", source_kind, day, len(day_df))
                return day_df
            log.warning("Weather cache invalid [%s] for %s: %s", source_kind, day, reason)
        except Exception:
            return None
        return None

    def _fallback_cached_weather(reason: str) -> pd.DataFrame | None:
        if source_kind != "forecast":
            return None
        cached = _load_cached_weather()
        if cached is not None:
            log.warning(
                "Weather fetch fallback [%s] for %s: %s; using cached forecast weather.",
                source_kind,
                day,
                reason,
            )
            return cached
        return None

    use_cache = not (source_kind == "forecast" and day == today)
    if use_cache:
        cached = _load_cached_weather()
        if cached is not None:
            return cached

    hourly_fields = (
        "shortwave_radiation,direct_radiation,diffuse_radiation,"
        "cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high,"
        "temperature_2m,relativehumidity_2m,windspeed_10m,precipitation,cape"
    )
    if source_kind == "archive":
        # Backfill training weather when cache is missing.
        url = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={LAT_DEG}&longitude={LON_DEG}"
            f"&start_date={day}&end_date={day}"
            f"&hourly={hourly_fields}"
            f"&timezone={TZ_NAME}"
        )
    else:
        # Today / tomorrow / near-future day-ahead source.
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={LAT_DEG}&longitude={LON_DEG}"
            f"&hourly={hourly_fields}"
            f"&timezone={TZ_NAME}"
            "&forecast_days=16"
        )
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        j = r.json().get("hourly", {})
        if not j or "time" not in j:
            log.error("Weather API payload missing hourly data for %s", day)
            cached = _fallback_cached_weather("provider payload missing hourly data")
            if cached is not None:
                return cached
            return None
        full_df = pd.DataFrame({
            "time":       pd.to_datetime(j["time"]),
            "rad":        j["shortwave_radiation"],
            "rad_direct": j["direct_radiation"],
            "rad_diffuse":j["diffuse_radiation"],
            "cloud":      j["cloudcover"],
            "cloud_low":  j["cloudcover_low"],
            "cloud_mid":  j["cloudcover_mid"],
            "cloud_high": j["cloudcover_high"],
            "temp":       j["temperature_2m"],
            "rh":         j["relativehumidity_2m"],
            "wind":       j["windspeed_10m"],
            "precip":     j["precipitation"],
            "cape":       j["cape"],
        })
        day_df = _slice_weather_day(full_df, day)
        ok, reason = validate_weather_hourly(day, day_df)
        if not ok:
            log.error("Weather fetched but invalid [%s] for %s: %s", source_kind, day, reason)
            cached = _fallback_cached_weather(f"provider payload invalid ({reason})")
            if cached is not None:
                return cached
            return None
        day_df.to_csv(cache, index=False)
        log.info("Weather fetched & cached [%s]: %s (%d rows)", source_kind, day, len(day_df))
        return day_df
    except Exception as e:
        log.error("Weather fetch failed [%s] for %s: %s", source_kind, day, e)
        cached = _fallback_cached_weather(f"provider fetch failed ({e})")
        if cached is not None:
            return cached
        return None


def interpolate_5min(df: pd.DataFrame, day: str | None = None) -> pd.DataFrame:
    """
    Resample hourly weather to 5-min with shape-preserving interpolation.
    Radiation uses PCHIP (monotone cubic) â€“ avoids unphysical negative dips.
    Other variables use linear.
    """
    df = df.copy()
    df["time"] = pd.to_datetime(df["time"], errors="coerce")
    df = df.dropna(subset=["time"]).sort_values("time")
    if df.empty:
        return pd.DataFrame()
    if day:
        day_df = _slice_weather_day(df, day)
        if not day_df.empty:
            df = day_df
    df = df.set_index("time")

    # separate radiation cols (need pchip) from rest
    rad_cols  = ["rad", "rad_direct", "rad_diffuse"]
    rest_cols = [c for c in df.columns if c not in rad_cols]
    numeric_cols = [c for c in df.columns if c != "time"]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    if day:
        idx5 = pd.date_range(f"{day} 00:00:00", periods=SLOTS_DAY, freq="5min")
    else:
        idx5 = pd.date_range(df.index[0], df.index[-1], freq="5min")

    rad_interp = (
        df[rad_cols]
        .reindex(df.index.union(idx5))
        .interpolate(method="pchip")
        .reindex(idx5)
        .clip(lower=0)
    )
    rest_interp = (
        df[rest_cols]
        .reindex(df.index.union(idx5))
        .interpolate(method="linear")
        .reindex(idx5)
    )
    # Keep interpolation numeric-only so sparse Open-Meteo nulls do not leave
    # object dtypes behind and crash downstream comparisons/clipping.
    rest_interp = rest_interp.apply(pd.to_numeric, errors="coerce")
    for col in ["cloud", "cloud_low", "cloud_mid", "cloud_high", "rh", "wind", "precip", "cape"]:
        if col in rest_interp.columns:
            rest_interp[col] = rest_interp[col].clip(lower=0)

    out = pd.concat([rad_interp, rest_interp], axis=1).reset_index()
    if "index" in out.columns and "time" not in out.columns:
        out = out.rename(columns={"index": "time"})

    # Gentle smoothing for cloud (meteorological, not sub-minute noise)
    for col in ["cloud", "cloud_low", "cloud_mid", "cloud_high"]:
        if col in out.columns:
            out[col] = _rolling_mean(pd.to_numeric(out[col], errors="coerce").values, 5, center=True)

    return out.iloc[:SLOTS_DAY].reset_index(drop=True)


# ============================================================================
# SOLAR GEOMETRY (precise)
# ============================================================================

def solar_geometry(day: str) -> dict:
    """
    Return per-slot solar geometry arrays for *day*.

    Returns dict with keys:
        zenith_deg  â€“ solar zenith angle (degrees)
        elevation   â€“ solar elevation (radians)
        air_mass    â€“ Kasten & Young (1989) air mass
        cos_aoi     â€“ cosine of angle-of-incidence on horizontal plane (= cos Î¸z)
        extra_rad   â€“ extraterrestrial radiation W/mÂ²
    """
    lat  = math.radians(LAT_DEG)
    doy  = datetime.strptime(day, "%Y-%m-%d").timetuple().tm_yday

    # Solar declination (Spencer 1971)
    B      = math.radians((360 / 365) * (doy - 81))
    decl   = math.radians(23.45 * math.sin(B))

    # Equation of time (minutes)
    eot    = 9.87 * math.sin(2 * B) - 7.53 * math.cos(B) - 1.5 * math.sin(B)

    # Extraterrestrial radiation
    E0     = 1 + 0.033 * math.cos(math.radians(360 * doy / 365))
    I0     = 1367.0 * E0   # W/mÂ²

    zenith_arr   = np.zeros(SLOTS_DAY)
    air_mass_arr = np.zeros(SLOTS_DAY)
    extra_arr    = np.zeros(SLOTS_DAY)

    for slot in range(SLOTS_DAY):
        hour_frac = slot * SLOT_MIN / 60.0                   # local clock hours
        solar_time = hour_frac + (eot / 60.0) + (LON_DEG - 15 * TZ_OFFSET) / 15.0
        hour_angle = math.radians(15.0 * (solar_time - 12.0))

        cos_z = (math.sin(lat) * math.sin(decl)
                 + math.cos(lat) * math.cos(decl) * math.cos(hour_angle))
        cos_z = max(cos_z, 0.0)

        zenith_deg = math.degrees(math.acos(min(cos_z, 1.0)))
        zenith_arr[slot] = zenith_deg

        if cos_z > 0.01:
            # Kasten & Young 1989
            am = 1.0 / (cos_z + 0.50572 * (96.07995 - zenith_deg) ** -1.6364)
            air_mass_arr[slot] = min(am, 38.0)
        else:
            air_mass_arr[slot] = 0.0

        extra_arr[slot] = I0 * cos_z

    return {
        "cos_z":    np.cos(np.radians(zenith_arr)),
        "zenith":   zenith_arr,
        "air_mass": air_mass_arr,
        "extra":    extra_arr,
    }


# ============================================================================
# CLEAR-SKY MODEL  (Ineichen simplified + humidity correction)
# ============================================================================

def clear_sky_radiation(day: str, rh_hourly: np.ndarray | None = None) -> np.ndarray:
    """
    Estimate per-slot clear-sky GHI (W/mÂ²) using simplified Ineichen model
    with Linke turbidity estimated from relative humidity.

    Args:
        day        â€“ YYYY-MM-DD
        rh_hourly  â€“ 5-min RH array (0â€“100); if None uses climatological value

    Returns:
        csi  â€“ clear-sky GHI array, shape (SLOTS_DAY,)
    """
    geo = solar_geometry(day)
    cos_z = geo["cos_z"]
    am    = geo["air_mass"]

    # Linke turbidity from RH (Remund et al. approximation for tropical sites)
    if rh_hourly is not None:
        rh_mean = np.clip(rh_hourly.mean(), 30, 95)
    else:
        rh_mean = 78.0   # tropical climatological mean

    TL = 2.4 + 0.018 * rh_mean   # â‰ˆ 3.8â€“4.1 for Cotabato wet season

    csi = np.zeros(SLOTS_DAY)
    for i in range(SLOTS_DAY):
        if cos_z[i] < 0.01 or am[i] < 0.1:
            continue
        # Ineichen & Perez (2002) simplified
        fh1  = math.exp(-0.0148 * am[i])
        fh2  = math.exp(-0.1202 * am[i])
        Gh   = geo["extra"][i] * cos_z[i] * math.exp(
                   -0.0903 * am[i] ** 0.7241 * (TL - 1.0)
               ) * (0.9734 * fh1 + 0.0266 * fh2)
        csi[i] = max(Gh, 0.0)

    return csi


# ============================================================================
# CLOUD TRANSMITTANCE  (non-linear, PH-calibrated)
# ============================================================================

def cloud_transmittance(cloud_pct: np.ndarray,
                        cloud_low: np.ndarray,
                        cloud_mid: np.ndarray) -> np.ndarray:
    """
    Convert fractional cloud cover to GHI transmittance factor.

    Uses layer-weighted model:
      - Low cloud (Cu/Sc) is most opaque
      - Mid cloud moderately so
      - High cloud (Ci) mostly transparent

    PH tropical calibration:
      High cloud cover (frequent): transmittance â‰ˆ 0.85
      Dense low cloud / rain:      transmittance â‰ˆ 0.15â€“0.25
    """
    c  = np.clip(cloud_pct  / 100.0, 0, 1)
    cl = np.clip(cloud_low  / 100.0, 0, 1)
    cm = np.clip(cloud_mid  / 100.0, 0, 1)
    ch = np.clip((c - cl - cm), 0, 1)   # approximate high cloud

    # Layer opacities (empirical for PH tropical)
    tau_low  = 0.78
    tau_mid  = 0.52
    tau_high = 0.14

    trans = (1.0
             - tau_low  * cl
             - tau_mid  * cm
             - tau_high * ch)

    # Non-linear enhancement at partial cloud (broken cumulus â†’ brightening)
    brightening = 0.06 * np.sin(np.pi * c) * (1 - cl)
    trans = np.clip(trans + brightening, 0.10, 1.05)

    return trans


# ============================================================================
# PHYSICS BASELINE  (clear-sky Ã— cloud Ã— temperature derating)
# ============================================================================

def physics_baseline(day: str, w5: pd.DataFrame) -> np.ndarray:
    """
    Compute per-slot kWh_inc from pure physics.

    Steps:
        1. Clear-sky GHI (W/mÂ²)
        2. Ã— cloud transmittance
        3. â†’ effective irradiance â†’ normalised vs STC
        4. Ã— temperature derating (NOCT model)
        5. Ã— plant capacity (dependable kW)
        6. Ã— slot duration â†’ kWh

    Args:
        day  â€“ YYYY-MM-DD
        w5   â€“ 5-min weather DataFrame (from interpolate_5min)

    Returns:
        baseline kWh_inc array (SLOTS_DAY,)
    """
    cap_kw = plant_capacity_kw(dependable=True)

    csi  = clear_sky_radiation(day, w5["rh"].values)
    ctrans = cloud_transmittance(
        w5["cloud"].values,
        w5["cloud_low"].values,
        w5["cloud_mid"].values,
    )
    ghi_eff = csi * ctrans

    # Temperature derating: Tc = T_amb + (NOCT-20)/800 Ã— Geff
    noct    = 47.0   # Â°C (typical mono-Si module)
    temp_c  = w5["temp"].values
    tc      = temp_c + ((noct - 20.0) / 800.0) * np.clip(ghi_eff, 0, 1200)
    temp_factor = 1.0 + GAMMA_TC * (tc - TEMP_REF_C)
    temp_factor = np.clip(temp_factor, 0.7, 1.05)

    # STC irradiance reference
    G_stc = 1000.0

    # Power output
    power_kw = cap_kw * (ghi_eff / G_stc) * temp_factor
    power_kw = np.clip(power_kw, 0, cap_kw)

    # Zero below radiation threshold
    power_kw[ghi_eff < RAD_MIN_WM2] = 0.0

    # Sunrise/sunset ramp guard (avoid instantaneous step from 0)
    ramp_slots = 4
    for i in range(SOLAR_START_SLOT, min(SOLAR_START_SLOT + ramp_slots, SLOTS_DAY)):
        frac = (i - SOLAR_START_SLOT + 1) / ramp_slots
        power_kw[i] = min(power_kw[i], power_kw[i] * frac)

    # kWh per 5-min slot
    kwh = power_kw * SLOT_MIN / 60.0

    # Zero outside solar window
    kwh[:SOLAR_START_SLOT]  = 0.0
    kwh[SOLAR_END_SLOT:]    = 0.0

    return kwh


# ============================================================================
# WEATHER ANALYSIS  (for training quality & diagnostics)
# ============================================================================

def analyse_weather_day(day: str, w5: pd.DataFrame, actual: np.ndarray | None = None) -> dict:
    """
    Compute meteorological statistics for a given day.

    Returns a rich dict used for:
      - Anomaly rejection
      - Feature engineering
      - Diagnostic logging
    """
    solar_rad  = w5["rad"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_cld  = w5["cloud"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_rh   = w5["rh"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_temp = w5["temp"].values[SOLAR_START_SLOT:SOLAR_END_SLOT]

    rad_mean    = float(solar_rad.mean())
    rad_peak    = float(solar_rad.max())
    cloud_mean  = float(solar_cld.mean())
    cloud_std   = float(solar_cld.std())
    rh_mean     = float(solar_rh.mean())

    # Volatility index: fraction of slots where |Î”rad| > threshold
    drad        = np.abs(np.diff(solar_rad, prepend=solar_rad[0]))
    vol_index   = float((drad > 120).mean())   # fraction of "cloud edge" slots

    # Sky condition classification
    if cloud_mean < 20:
        sky_class = "clear"
    elif cloud_mean < 45:
        sky_class = "partly_cloudy"
    elif cloud_mean < 70:
        sky_class = "mostly_cloudy"
    else:
        sky_class = "overcast"

    # Convective instability (CAPE-based)
    cape_max = float(w5["cape"].values.max()) if "cape" in w5.columns else 0.0
    convective = cape_max > 500

    # Rain flag
    precip_total = float(w5["precip"].values.sum()) if "precip" in w5.columns else 0.0
    rainy = precip_total > 2.0

    stats = {
        "day":          day,
        "rad_mean":     rad_mean,
        "rad_peak":     rad_peak,
        "cloud_mean":   cloud_mean,
        "cloud_std":    cloud_std,
        "rh_mean":      rh_mean,
        "vol_index":    vol_index,
        "sky_class":    sky_class,
        "convective":   convective,
        "rainy":        rainy,
        "cape_max":     cape_max,
        "precip_total": precip_total,
        "temp_mean":    float(solar_temp.mean()),
    }

    # Generation metrics if actual provided
    if actual is not None:
        cap_kwh_day = plant_capacity_kw(True) * (SOLAR_END_H - SOLAR_START_H) / 1.0
        cf = float(actual.sum()) / max(cap_kwh_day, 1.0)
        stats["capacity_factor"] = cf
        stats["total_kwh"]       = float(actual.sum())

        # Pearson r between radiation & generation (solar hours only)
        act_solar = actual[SOLAR_START_SLOT:SOLAR_END_SLOT]
        if solar_rad.std() > 1 and act_solar.std() > 1:
            stats["rad_gen_corr"] = float(np.corrcoef(solar_rad, act_solar)[0, 1])
        else:
            stats["rad_gen_corr"] = 0.0

    return stats


def classify_day_regime(stats: dict) -> str:
    cloud_mean = float(stats.get("cloud_mean", 0.0))
    vol_index = float(stats.get("vol_index", 0.0))
    rad_peak = float(stats.get("rad_peak", 0.0))
    rainy = bool(stats.get("rainy", False))
    convective = bool(stats.get("convective", False))
    if rainy or (convective and cloud_mean >= 75.0):
        return "rainy"
    if cloud_mean < 26.0 and vol_index < 0.18 and rad_peak >= 650.0:
        return "clear"
    if cloud_mean < 72.0:
        return "mixed"
    return "overcast"


def classify_hour_regime(
    cloud_mean: float,
    cloud_std: float,
    kt_mean: float,
    precip_total: float,
    cape_max: float,
) -> str:
    """Classify the forecast context for a single hour."""
    if precip_total >= 0.2 or (cloud_mean >= 82.0 and cape_max >= 650.0):
        return "rainy"
    if kt_mean >= 0.70 and cloud_mean < 28.0 and cloud_std < 18.0:
        return "clear"
    if kt_mean >= 0.42 and cloud_mean < 72.0:
        return "mixed"
    return "overcast"


def classify_slot_weather_buckets(w5: pd.DataFrame, day: str) -> np.ndarray:
    """Classify each 5-minute slot into a weather bucket for error analysis."""
    def col(name: str, default: float = 0.0) -> np.ndarray:
        if name not in w5.columns:
            return np.full(SLOTS_DAY, default, dtype=float)
        arr = pd.to_numeric(w5[name], errors="coerce").fillna(default).values
        if len(arr) < SLOTS_DAY:
            arr = np.concatenate([arr, np.full(SLOTS_DAY - len(arr), default, dtype=float)])
        return arr[:SLOTS_DAY].astype(float)

    rad = np.clip(col("rad", 0.0), 0.0, None)
    cloud = np.clip(col("cloud", 0.0), 0.0, 100.0)
    precip = np.clip(col("precip", 0.0), 0.0, None)
    cape = np.clip(col("cape", 0.0), 0.0, None)
    rh = np.clip(col("rh", 0.0), 0.0, 100.0)
    csi = clear_sky_radiation(day, rh)
    kt = np.where(csi > 10.0, rad / np.maximum(csi, 1.0), 0.0)
    kt = np.clip(kt, 0.0, 1.2)
    drad = np.abs(np.diff(rad, prepend=rad[0]))

    out = np.full(SLOTS_DAY, "offsolar", dtype=object)
    solar_mask = np.zeros(SLOTS_DAY, dtype=bool)
    solar_mask[SOLAR_START_SLOT:SOLAR_END_SLOT] = True
    active = solar_mask.copy()

    rainy_mask = active & (
        (precip > WEATHER_BUCKET_RAIN_MM)
        | ((cape >= WEATHER_BUCKET_RAIN_CAPE) & (cloud >= WEATHER_BUCKET_RAIN_CLOUD))
    )
    out[rainy_mask] = "rainy"
    active &= ~rainy_mask

    clear_stable_mask = active & (
        (cloud < WEATHER_BUCKET_CLEAR_CLOUD)
        & (kt >= WEATHER_BUCKET_CLEAR_KT)
        & (drad < WEATHER_BUCKET_CLEAR_DRAD)
    )
    out[clear_stable_mask] = "clear_stable"
    active &= ~clear_stable_mask

    clear_edge_mask = active & (
        (cloud < WEATHER_BUCKET_CLEAR_EDGE_CLOUD)
        & (kt >= WEATHER_BUCKET_CLEAR_EDGE_KT)
        & (drad >= WEATHER_BUCKET_CLEAR_DRAD)
    )
    out[clear_edge_mask] = "clear_edge"
    active &= ~clear_edge_mask

    mixed_stable_mask = active & (
        (cloud >= WEATHER_BUCKET_CLEAR_CLOUD)
        & (cloud < WEATHER_BUCKET_MIXED_CLOUD)
        & (kt >= WEATHER_BUCKET_MIXED_KT)
        & (drad < WEATHER_BUCKET_MIXED_VOL_DRAD)
        & (precip <= WEATHER_BUCKET_RAIN_MM)
    )
    out[mixed_stable_mask] = "mixed_stable"
    active &= ~mixed_stable_mask

    mixed_volatile_mask = active & (
        (cloud >= WEATHER_BUCKET_CLEAR_CLOUD)
        & (cloud < WEATHER_BUCKET_MIXED_VOL_CLOUD)
        & (drad >= WEATHER_BUCKET_MIXED_VOL_DRAD)
        & (precip <= WEATHER_BUCKET_RAIN_MM)
    )
    out[mixed_volatile_mask] = "mixed_volatile"
    active &= ~mixed_volatile_mask

    out[active] = "overcast"
    return out


def _error_class_normalizer(
    residual: np.ndarray,
    opportunity_kwh: np.ndarray | float | None = None,
    baseline_kwh: np.ndarray | float | None = None,
    cap_slot: float | None = None,
) -> np.ndarray:
    residual_arr = np.asarray(residual, dtype=float)
    cap = max(float(cap_slot if cap_slot is not None else slot_cap_kwh(False)), 1.0)
    floor = cap * ERROR_CLASS_OPPORTUNITY_FLOOR_FRAC
    if opportunity_kwh is not None:
        scale = np.asarray(opportunity_kwh, dtype=float)
    elif baseline_kwh is not None:
        scale = np.maximum(np.clip(np.asarray(baseline_kwh, dtype=float), 0.0, None), floor)
    else:
        scale = np.full(residual_arr.shape, cap, dtype=float)
    if scale.shape != residual_arr.shape:
        if scale.size == 1:
            scale = np.full(residual_arr.shape, float(scale.reshape(-1)[0]), dtype=float)
        else:
            raise ValueError("Residual normalization scale shape mismatch")
    scale = np.where(np.isfinite(scale), scale, floor)
    scale = np.maximum(scale, floor)
    return scale


def classify_residual_error_classes(
    residual: np.ndarray,
    cap_slot: float | None = None,
    opportunity_kwh: np.ndarray | float | None = None,
    baseline_kwh: np.ndarray | float | None = None,
) -> np.ndarray:
    rn = np.asarray(residual, dtype=float) / _error_class_normalizer(
        residual,
        opportunity_kwh=opportunity_kwh,
        baseline_kwh=baseline_kwh,
        cap_slot=cap_slot,
    )
    out = np.full(rn.shape, ERROR_CLASS_NEUTRAL_IDX, dtype=int)
    out[rn <= -ERROR_CLASS_STRONG_THRESHOLD] = 0
    out[(rn > -ERROR_CLASS_STRONG_THRESHOLD) & (rn <= -ERROR_CLASS_MILD_THRESHOLD)] = 1
    out[(rn >= ERROR_CLASS_MILD_THRESHOLD) & (rn < ERROR_CLASS_STRONG_THRESHOLD)] = 3
    out[rn >= ERROR_CLASS_STRONG_THRESHOLD] = 4
    return out


def _apply_probability_temperature(prob_matrix: np.ndarray, temperature: float | None) -> np.ndarray:
    probs = np.asarray(prob_matrix, dtype=float)
    if probs.ndim != 2 or probs.size <= 0:
        return probs.copy()
    temp = float(temperature if temperature is not None else 1.0)
    if not math.isfinite(temp) or temp <= 0:
        temp = 1.0
    row_sum = probs.sum(axis=1, keepdims=True)
    probs = np.divide(probs, np.maximum(row_sum, 1e-9), out=np.zeros_like(probs), where=row_sum > 0)
    if abs(temp - 1.0) < 1e-6:
        return probs
    scaled = np.power(np.clip(probs, 1e-9, 1.0), 1.0 / temp)
    scaled_sum = scaled.sum(axis=1, keepdims=True)
    return np.divide(scaled, np.maximum(scaled_sum, 1e-9), out=np.zeros_like(scaled), where=scaled_sum > 0)


def _weighted_neg_log_loss(
    prob_matrix: np.ndarray,
    labels: np.ndarray,
    sample_weight: np.ndarray | None = None,
) -> float:
    probs = np.asarray(prob_matrix, dtype=float)
    y = np.asarray(labels, dtype=int).reshape(-1)
    if probs.ndim != 2 or probs.shape[0] != y.shape[0] or probs.shape[0] <= 0:
        return float("inf")
    y = np.clip(y, 0, probs.shape[1] - 1)
    losses = -np.log(np.clip(probs[np.arange(probs.shape[0]), y], 1e-9, 1.0))
    if sample_weight is None:
        return float(np.mean(losses))
    w = np.asarray(sample_weight, dtype=float).reshape(-1)
    if w.shape[0] != losses.shape[0]:
        return float(np.mean(losses))
    return float(np.average(losses, weights=np.maximum(w, 1e-9)))


def _weighted_mae_loss(
    pred: np.ndarray,
    actual: np.ndarray,
    sample_weight: np.ndarray | None = None,
) -> float:
    err = np.abs(np.asarray(pred, dtype=float).reshape(-1) - np.asarray(actual, dtype=float).reshape(-1))
    if sample_weight is None:
        return float(np.mean(err)) if err.size else float("inf")
    w = np.asarray(sample_weight, dtype=float).reshape(-1)
    if w.shape[0] != err.shape[0]:
        return float(np.mean(err)) if err.size else float("inf")
    return float(np.average(err, weights=np.maximum(w, 1e-9))) if err.size else float("inf")


def _blocked_day_holdout_mask(day_keys: np.ndarray | list[str] | None) -> np.ndarray:
    if day_keys is None:
        return np.zeros(0, dtype=bool)
    days = [str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)]
    if not days:
        return np.zeros(0, dtype=bool)
    ordered_unique = []
    seen = set()
    for day in days:
        if day not in seen:
            seen.add(day)
            ordered_unique.append(day)
    if len(ordered_unique) < ERROR_CLASS_CALIBRATION_MIN_DAYS:
        return np.zeros(len(days), dtype=bool)
    holdout_days = int(np.clip(round(len(ordered_unique) * 0.20), 2, ERROR_CLASS_CALIBRATION_HOLDOUT_MAX_DAYS))
    min_train_days = max(MIN_TRAIN_DAYS, 4)
    if (len(ordered_unique) - holdout_days) < min_train_days:
        holdout_days = max(0, len(ordered_unique) - min_train_days)
    if holdout_days < 2:
        return np.zeros(len(days), dtype=bool)
    holdout_set = set(ordered_unique[:holdout_days])
    return np.asarray([day in holdout_set for day in days], dtype=bool)


def _blocked_classifier_holdout_mask(day_keys: np.ndarray | list[str] | None) -> np.ndarray:
    return _blocked_day_holdout_mask(day_keys)


def _fit_error_classifier_temperature(
    X: pd.DataFrame,
    labels: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None,
) -> dict:
    meta = {
        "calibrated": False,
        "temperature": 1.0,
        "holdout_days": 0,
        "holdout_samples": 0,
        "nll_before": None,
        "nll_after": None,
        "accuracy_before": None,
        "accuracy_after": None,
    }
    holdout_mask = _blocked_day_holdout_mask(day_keys)
    if holdout_mask.size != len(labels) or not np.any(holdout_mask):
        return meta
    train_mask = ~holdout_mask
    if int(np.count_nonzero(holdout_mask)) < ERROR_CLASS_CALIBRATION_HOLDOUT_MIN_SAMPLES:
        return meta
    y_train = np.asarray(labels, dtype=int)[train_mask]
    y_holdout = np.asarray(labels, dtype=int)[holdout_mask]
    if len({int(v) for v in y_train}) < 2 or len({int(v) for v in y_holdout}) < 2:
        return meta

    X_train = X.iloc[train_mask].reset_index(drop=True)
    X_holdout = X.iloc[holdout_mask].reset_index(drop=True)
    w_train = np.asarray(sample_weight, dtype=float)[train_mask]
    w_holdout = np.asarray(sample_weight, dtype=float)[holdout_mask]
    model = _make_error_classifier()
    model.fit(X_train, y_train, sample_weight=w_train)

    raw_probs = _classifier_probabilities_to_full_vector(
        np.asarray(model.predict_proba(X_holdout), dtype=float),
        list(map(int, getattr(model, "classes_", []))),
    )
    base_nll = _weighted_neg_log_loss(raw_probs, y_holdout, w_holdout)
    base_acc = float(np.average((np.argmax(raw_probs, axis=1) == y_holdout).astype(float), weights=np.maximum(w_holdout, 1e-9)))
    best_temp = 1.0
    best_nll = base_nll
    best_probs = raw_probs
    for temp in np.linspace(
        ERROR_CLASS_CALIBRATION_TEMP_MIN,
        ERROR_CLASS_CALIBRATION_TEMP_MAX,
        ERROR_CLASS_CALIBRATION_TEMP_STEPS,
    ):
        cand_probs = _apply_probability_temperature(raw_probs, float(temp))
        cand_nll = _weighted_neg_log_loss(cand_probs, y_holdout, w_holdout)
        if cand_nll + 1e-6 < best_nll:
            best_nll = cand_nll
            best_temp = float(temp)
            best_probs = cand_probs
    meta.update({
        "calibrated": bool(best_temp != 1.0),
        "temperature": float(best_temp),
        "holdout_days": int(len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[holdout_mask]})),
        "holdout_samples": int(np.count_nonzero(holdout_mask)),
        "nll_before": float(base_nll),
        "nll_after": float(best_nll),
        "accuracy_before": base_acc,
        "accuracy_after": float(np.average((np.argmax(best_probs, axis=1) == y_holdout).astype(float), weights=np.maximum(w_holdout, 1e-9))),
    })
    return meta


def _error_class_name(label: int) -> str:
    idx = int(np.clip(int(label), 0, len(ERROR_CLASS_NAMES) - 1))
    return ERROR_CLASS_NAMES[idx]


def _error_class_sign(label: np.ndarray | int) -> np.ndarray:
    arr = np.asarray(label, dtype=int)
    out = np.zeros(arr.shape, dtype=int)
    out[arr < ERROR_CLASS_NEUTRAL_IDX] = -1
    out[arr > ERROR_CLASS_NEUTRAL_IDX] = 1
    return out


def _aggregate_scalar_series(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "mean": 0.0, "std": 0.0, "mae": 0.0}
    arr = np.asarray(values, dtype=float)
    return {
        "count": int(arr.size),
        "mean": float(arr.mean()),
        "std": float(arr.std()),
        "mae": float(np.mean(np.abs(arr))),
    }


def hour_weather_signature(day: str, w5: pd.DataFrame, hour: int, csi_arr: np.ndarray | None = None) -> dict:
    """Summarize the weather pattern for a single forecast hour."""
    start, end = _solar_hour_bounds(hour)
    if csi_arr is None:
        rh_arr = pd.to_numeric(w5["rh"], errors="coerce").fillna(0.0).values
        csi_arr = clear_sky_radiation(day, rh_arr[:SLOTS_DAY])

    rad = pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values[start:end]
    cloud = pd.to_numeric(w5["cloud"], errors="coerce").fillna(0.0).values[start:end]
    rh = pd.to_numeric(w5["rh"], errors="coerce").fillna(0.0).values[start:end]
    precip = pd.to_numeric(w5["precip"], errors="coerce").fillna(0.0).values[start:end]
    cape = pd.to_numeric(w5["cape"], errors="coerce").fillna(0.0).values[start:end]
    clear_hour = np.asarray(csi_arr[start:end], dtype=float)

    cloud_mean = float(np.mean(cloud)) if cloud.size else 0.0
    cloud_std = float(np.std(cloud)) if cloud.size else 0.0
    rh_mean = float(np.mean(rh)) if rh.size else 0.0
    rad_mean = float(np.mean(rad)) if rad.size else 0.0
    vol_index = float(np.mean(np.abs(np.diff(rad, prepend=rad[0])) > 120.0)) if rad.size else 0.0
    kt_mean = float(rad_mean / max(float(np.mean(clear_hour)) if clear_hour.size else 0.0, 1.0))
    precip_total = float(np.sum(precip)) if precip.size else 0.0
    cape_max = float(np.max(cape)) if cape.size else 0.0

    return {
        "hour": int(hour),
        "season": _season_bucket_from_day(day),
        "cloud_mean": cloud_mean,
        "cloud_std": cloud_std,
        "rh_mean": rh_mean,
        "rad_mean": rad_mean,
        "kt_mean": float(np.clip(kt_mean, 0.0, 1.2)),
        "vol_index": vol_index,
        "precip_total": precip_total,
        "cape_max": cape_max,
        "regime": classify_hour_regime(cloud_mean, cloud_std, kt_mean, precip_total, cape_max),
    }


def is_anomalous_day(stats: dict) -> tuple[bool, str]:
    """
    Return (True, reason) if the day looks like bad training data.
    Reasons: inverter outage, data gaps, irradiance inconsistency.
    """
    cf = stats.get("capacity_factor", 0.5)
    if cf < ANOM_MIN_CF:
        return True, f"CF too low ({cf:.3f}) â€“ likely outage or data gap"
    if cf > ANOM_MAX_CF:
        return True, f"CF too high ({cf:.3f}) â€“ sensor or data error"

    corr = stats.get("rad_gen_corr", 1.0)
    if stats.get("rad_mean", 0) > 100 and corr < ANOM_RAD_CORR:
        return True, f"Rad-gen correlation too low ({corr:.2f}) â€“ inconsistent data"

    return False, ""


def training_day_rejection(
    stats: dict,
    actual: np.ndarray,
    baseline: np.ndarray,
) -> tuple[bool, str]:
    """Stricter training-day filter used by the hardened residual model."""
    bad, reason = is_anomalous_day(stats)
    if bad:
        return bad, reason

    solar_actual = np.clip(np.asarray(actual, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
    solar_base = np.clip(np.asarray(baseline, dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
    cap_slot = max(slot_cap_kwh(False), 1.0)
    peak_ratio = float(solar_actual.max() / cap_slot) if solar_actual.size else 0.0
    if peak_ratio > 1.10:
        return True, f"Peak slot exceeds physical max ({peak_ratio:.2f}x)"

    threshold = activity_threshold_kwh()
    active = solar_actual[solar_actual >= threshold]
    if active.size >= 18:
        diff = np.abs(np.diff(active))
        flat_tol = max(0.30, float(np.nanmedian(active)) * 0.015)
        flatline_ratio = float(np.mean(diff <= flat_tol)) if diff.size else 0.0
        if flatline_ratio > 0.96 and stats.get("rad_gen_corr", 1.0) < 0.80:
            return True, f"Active period is implausibly flat ({flatline_ratio:.2f})"

    base_total = float(solar_base.sum())
    if base_total > 0 and stats.get("rad_mean", 0) > 180 and not stats.get("rainy", False):
        energy_ratio = float(solar_actual.sum() / base_total)
        if energy_ratio < 0.08:
            return True, f"Generation far below physics baseline ({energy_ratio:.2f})"

    return False, ""


# ============================================================================
# FEATURE ENGINEERING  (rich, physics-informed)
# ============================================================================

def build_features(
    w5: pd.DataFrame,
    day: str,
    solcast_prior: dict | None = None,
) -> pd.DataFrame:
    """
    Build a feature matrix from 5-min weather for ML training/prediction.

    Features:
        rad/rad_direct/rad_diffuse         â€“ spectral decomposition
        cloud layers + gradients            â€“ cloud dynamics
        precip/cape                         â€“ convective/rain context
        temp/rh/wind (+ non-linear terms)   â€“ atmospheric
        cos_z/air_mass                      â€“ geometry
        solar progression + cyclic encodingsâ€“ time context
        cloud_trans, kt, dni_proxy, csi     â€“ derived irradiance physics
        lag/rolling weather terms           â€“ short-memory trend terms
        cap_kw                              â€“ plant scale normalizer
    """
    geo  = solar_geometry(day)
    day_stats = analyse_weather_day(day, w5)
    day_regime = classify_day_regime(day_stats)

    def col(name: str, default: float = 0.0) -> np.ndarray:
        if name not in w5.columns:
            return np.full(SLOTS_DAY, default, dtype=float)
        arr = pd.to_numeric(w5[name], errors="coerce").fillna(default).values
        if len(arr) < SLOTS_DAY:
            pad = np.full(SLOTS_DAY - len(arr), default, dtype=float)
            arr = np.concatenate([arr, pad])
        return arr[:SLOTS_DAY].astype(float)

    rad = col("rad", 0.0)
    rad_direct = col("rad_direct", 0.0)
    rad_diffuse = col("rad_diffuse", 0.0)
    cloud = np.clip(col("cloud", 0.0), 0.0, 100.0)
    cloud_low = np.clip(col("cloud_low", 0.0), 0.0, 100.0)
    cloud_mid = np.clip(col("cloud_mid", 0.0), 0.0, 100.0)
    cloud_high = np.clip(col("cloud_high", 0.0), 0.0, 100.0)
    temp = col("temp", 0.0)
    rh = np.clip(col("rh", 0.0), 0.0, 100.0)
    wind = np.clip(col("wind", 0.0), 0.0, None)
    precip = np.clip(col("precip", 0.0), 0.0, None)
    cape = np.clip(col("cape", 0.0), 0.0, None)

    ctrans = cloud_transmittance(
        cloud,
        cloud_low,
        cloud_mid,
    )

    idx       = np.arange(SLOTS_DAY)
    solar_rel = (idx - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1)
    solar_rel = np.clip(solar_rel, 0, 1)
    solar_rel_sin = np.sin(np.pi * solar_rel)
    solar_rel_sin = np.clip(solar_rel_sin, 0, 1)

    slot_angle = 2 * np.pi * (idx / SLOTS_DAY)
    tod_sin = np.sin(slot_angle)
    tod_cos = np.cos(slot_angle)
    slot_in_hour = (idx % (60 // SLOT_MIN)) / max((60 // SLOT_MIN) - 1, 1)
    slot_in_hour_angle = 2 * np.pi * slot_in_hour
    slot_in_hour_sin = np.sin(slot_in_hour_angle)
    slot_in_hour_cos = np.cos(slot_in_hour_angle)

    try:
        doy = datetime.strptime(day, "%Y-%m-%d").timetuple().tm_yday
    except Exception:
        doy = datetime.now().timetuple().tm_yday
    doy_angle = 2 * np.pi * (doy / 365.25)
    doy_sin = np.full(SLOTS_DAY, np.sin(doy_angle), dtype=float)
    doy_cos = np.full(SLOTS_DAY, np.cos(doy_angle), dtype=float)

    csi_arr = clear_sky_radiation(day, rh)

    # Clearness index (actual / theoretical clear-sky)
    kt = np.where(csi_arr > 10, rad / np.maximum(csi_arr, 1), 0.0)
    kt = np.clip(kt, 0, 1.2)

    # DNI proxy: direct fraction relative to GHI
    dni_proxy = np.clip(rad_direct / np.maximum(rad, 1), 0, 1)

    # 1-hour lagged radiation (12 slots)
    rad_lag = np.roll(rad, 12)
    rad_lag[:12] = rad[:12]
    rad_grad_15m = np.diff(rad, prepend=rad[0])
    cloud_grad_15m = np.diff(cloud, prepend=cloud[0])
    precip_1h = np.nan_to_num(_rolling_sum(precip, 12), nan=0.0)
    cloud_std_1h = np.nan_to_num(_rolling_std(cloud, 12), nan=0.0)

    cap_kw = plant_capacity_kw(True)
    sunrise_slots = np.clip(idx - SOLAR_START_SLOT, 0, SOLAR_SLOTS)
    sunset_slots = np.clip((SOLAR_END_SLOT - 1) - idx, 0, SOLAR_SLOTS)
    sunrise_rel = sunrise_slots / max(SOLAR_SLOTS, 1)
    sunset_rel = sunset_slots / max(SOLAR_SLOTS, 1)
    shoulder_flag = ((sunrise_slots < 18) | (sunset_slots < 18)).astype(float)
    node_count = max(1, plant_node_count())
    expected_nodes = np.clip((cap_kw * np.clip(kt, 0.0, 1.0)) / max(NODE_KW_NOMINAL, 1.0), 0.0, float(node_count))
    season_bucket = _season_bucket_from_day(day)
    wet_season_flag = 1.0 if season_bucket == "wet" else 0.0
    dry_season_flag = 1.0 - wet_season_flag
    day_regime_clear = 1.0 if day_regime == "clear" else 0.0
    day_regime_mixed = 1.0 if day_regime == "mixed" else 0.0
    day_regime_overcast = 1.0 if day_regime == "overcast" else 0.0
    day_regime_rainy = 1.0 if day_regime == "rainy" else 0.0
    if solcast_prior:
        solcast_kwh = np.clip(np.asarray(solcast_prior.get("prior_kwh"), dtype=float), 0.0, None)[:SLOTS_DAY]
        solcast_mw = np.clip(np.asarray(solcast_prior.get("prior_mw"), dtype=float), 0.0, None)[:SLOTS_DAY]
        solcast_spread = np.clip(
            np.asarray(solcast_prior.get("spread_frac"), dtype=float),
            0.0,
            SOLCAST_PRIOR_SPREAD_FRAC_CLIP,
        )[:SLOTS_DAY]
        solcast_available = np.clip(np.asarray(solcast_prior.get("available"), dtype=float), 0.0, 1.0)[:SLOTS_DAY]
        solcast_blend = np.clip(np.asarray(solcast_prior.get("blend"), dtype=float), 0.0, 1.0)[:SLOTS_DAY]
        solcast_cov = float(np.clip(solcast_prior.get("coverage_ratio", 0.0), 0.0, 1.0))
        solcast_rel = float(np.clip(solcast_prior.get("reliability", 0.0), 0.0, 1.0))
        solcast_bias_ratio = float(np.clip(solcast_prior.get("bias_ratio", 1.0), *SOLCAST_BIAS_RATIO_CLIP))
        solcast_resolution_weight = np.clip(
            np.asarray(
                solcast_prior.get(
                    "resolution_weight",
                    np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float),
                ),
                dtype=float,
            ),
            0.0,
            1.0,
        )[:SLOTS_DAY]
        solcast_resolution_support = np.clip(
            np.asarray(
                solcast_prior.get("resolution_support", np.zeros(SLOTS_DAY, dtype=float)),
                dtype=float,
            ),
            0.0,
            1.0,
        )[:SLOTS_DAY]
    else:
        solcast_kwh = np.zeros(SLOTS_DAY, dtype=float)
        solcast_mw = np.zeros(SLOTS_DAY, dtype=float)
        solcast_spread = np.zeros(SLOTS_DAY, dtype=float)
        solcast_available = np.zeros(SLOTS_DAY, dtype=float)
        solcast_blend = np.zeros(SLOTS_DAY, dtype=float)
        solcast_cov = 0.0
        solcast_rel = 0.0
        solcast_bias_ratio = 1.0
        solcast_resolution_weight = np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float)
        solcast_resolution_support = np.zeros(SLOTS_DAY, dtype=float)
    slot_cap_arr = np.full(SLOTS_DAY, max(cap_kw * SLOT_MIN / 60.0, 0.05), dtype=float)
    solcast_vs_physics = np.clip(solcast_kwh / slot_cap_arr, 0.0, 1.5)
    irr_proxy = np.maximum((np.clip(rad, 0.0, None) / 1000.0) * slot_cap_arr, 0.05)
    solcast_vs_irradiance = np.clip(solcast_kwh / irr_proxy, 0.0, 4.0)

    df = pd.DataFrame({
        # Radiation
        "rad":           rad,
        "rad_direct":    rad_direct,
        "rad_diffuse":   rad_diffuse,
        "rad_lag_1h":    rad_lag,
        "rad_grad_15m":  rad_grad_15m,
        # Cloud
        "cloud":         cloud,
        "cloud_low":     cloud_low,
        "cloud_mid":     cloud_mid,
        "cloud_high":    cloud_high,
        "cloud_std_1h":  cloud_std_1h,
        "cloud_grad_15m": cloud_grad_15m,
        "cloud_trans":   ctrans,
        # Derived radiation
        "csi":           csi_arr,
        "kt":            kt,
        "dni_proxy":     dni_proxy,
        # Rain / convective context
        "precip":        precip,
        "precip_1h":     precip_1h,
        "cape":          cape,
        "cape_sqrt":     np.sqrt(cape),
        # Atmosphere
        "temp":          temp,
        "temp_hot":      np.clip(temp - 35.0, 0, None),   # severe heat
        "temp_delta":    temp - TEMP_REF_C,
        "rh":            rh,
        "rh_sq":         (rh / 100.0) ** 2,
        "wind":          wind,
        "wind_sq":       wind ** 2,
        # Geometry
        "cos_z":         geo["cos_z"],
        "air_mass":      geo["air_mass"],
        # Time
        "solar_prog":    solar_rel,
        "solar_prog_sq": solar_rel ** 2,
        "solar_prog_sin": solar_rel_sin,
        "tod_sin":       tod_sin,
        "tod_cos":       tod_cos,
        "slot_in_hour_sin": slot_in_hour_sin,
        "slot_in_hour_cos": slot_in_hour_cos,
        "sunrise_rel":   sunrise_rel,
        "sunset_rel":    sunset_rel,
        "shoulder_flag": shoulder_flag,
        "doy_sin":       doy_sin,
        "doy_cos":       doy_cos,
        "day_cloud_mean": np.full(SLOTS_DAY, float(day_stats.get("cloud_mean", 0.0))),
        "day_vol_index": np.full(SLOTS_DAY, float(day_stats.get("vol_index", 0.0))),
        "wet_season_flag": np.full(SLOTS_DAY, wet_season_flag),
        "dry_season_flag": np.full(SLOTS_DAY, dry_season_flag),
        "day_regime_clear": np.full(SLOTS_DAY, day_regime_clear),
        "day_regime_mixed": np.full(SLOTS_DAY, day_regime_mixed),
        "day_regime_overcast": np.full(SLOTS_DAY, day_regime_overcast),
        "day_regime_rainy": np.full(SLOTS_DAY, day_regime_rainy),
        # Solcast prior
        "solcast_prior_kwh": solcast_kwh,
        "solcast_prior_mw": solcast_mw,
        "solcast_prior_spread": solcast_spread,
        "solcast_prior_available": solcast_available,
        "solcast_prior_blend": solcast_blend,
        "solcast_prior_vs_physics": solcast_vs_physics,
        "solcast_prior_vs_irradiance": solcast_vs_irradiance,
        "solcast_day_coverage": np.full(SLOTS_DAY, solcast_cov),
        "solcast_day_reliability": np.full(SLOTS_DAY, solcast_rel),
        "solcast_bias_ratio": np.full(SLOTS_DAY, solcast_bias_ratio),
        "solcast_resolution_weight": solcast_resolution_weight,
        "solcast_resolution_support": solcast_resolution_support,
        # Plant
        "expected_nodes": expected_nodes,
        "cap_kw":        np.full(SLOTS_DAY, cap_kw),
    })

    return df


FEATURE_COLS = [
    "rad", "rad_direct", "rad_diffuse", "rad_lag_1h", "rad_grad_15m",
    "cloud", "cloud_low", "cloud_mid", "cloud_high", "cloud_std_1h", "cloud_grad_15m", "cloud_trans",
    "csi", "kt", "dni_proxy",
    "precip", "precip_1h", "cape", "cape_sqrt",
    "temp", "temp_hot", "temp_delta", "rh", "rh_sq", "wind", "wind_sq",
    "cos_z", "air_mass",
    "solar_prog", "solar_prog_sq", "solar_prog_sin", "tod_sin", "tod_cos",
    "slot_in_hour_sin", "slot_in_hour_cos", "sunrise_rel", "sunset_rel", "shoulder_flag",
    "doy_sin", "doy_cos",
    "day_cloud_mean", "day_vol_index", "wet_season_flag", "dry_season_flag",
    "day_regime_clear", "day_regime_mixed", "day_regime_overcast", "day_regime_rainy",
    "solcast_prior_kwh", "solcast_prior_mw", "solcast_prior_spread", "solcast_prior_available",
    "solcast_prior_blend", "solcast_prior_vs_physics", "solcast_prior_vs_irradiance",
    "solcast_day_coverage", "solcast_day_reliability", "solcast_bias_ratio",
    "solcast_resolution_weight", "solcast_resolution_support",
    "expected_nodes", "cap_kw",
]


# ============================================================================
# CURTAILMENT DETECTION
# ============================================================================

def curtailed_mask(actual: np.ndarray, baseline: np.ndarray, tol: float = 0.97) -> np.ndarray:
    """
    Boolean mask: True where generation was export-capped.
    These slots must be excluded from ML training or the model
    learns a falsely-depressed response at high irradiance.
    """
    cap_slot = load_forecast_export_limit_mw() * 1000.0 * SLOT_MIN / 60.0
    return (actual >= tol * cap_slot) & (baseline > cap_slot * 1.05)


# ============================================================================
# OPERATIONAL CONSTRAINTS (manual stops vs plant-cap curtailment)
# ============================================================================

def _iter_history_db_paths(start_ms: int, end_ms_exclusive: int) -> list[Path]:
    paths: list[Path] = []
    archive_paths = [ARCHIVE_DIR / f"{month_key}.db" for month_key in _archive_month_keys_for_range(start_ms, end_ms_exclusive)]
    for path in [APP_DB_FILE, *archive_paths]:
        if path.exists() and path not in paths:
            paths.append(path)
    return paths


def _normalize_audit_scope(value) -> str:
    return str(value or "single").strip().lower() or "single"


def _audit_result_ok(value) -> bool:
    result = str(value or "ok").strip().lower()
    return bool(result) and not result.startswith("error")


def _query_audit_log_latest_before(db_path: Path, before_ms: int) -> list[dict]:
    if not db_path.exists():
        return []
    sql = """
        SELECT a.ts,
               a.inverter,
               a.node,
               UPPER(COALESCE(a.action, '')) AS action,
               LOWER(COALESCE(a.scope, 'single')) AS scope,
               LOWER(COALESCE(a.result, 'ok')) AS result
          FROM audit_log a
          JOIN (
                SELECT inverter, node, MAX(ts) AS max_ts
                  FROM audit_log
                 WHERE ts < ?
                   AND inverter > 0
                   AND node > 0
                   AND UPPER(COALESCE(action, '')) IN ('STOP', 'START')
                   AND LOWER(COALESCE(result, 'ok')) NOT LIKE 'error%'
                 GROUP BY inverter, node
          ) last
            ON last.inverter = a.inverter
           AND last.node = a.node
           AND last.max_ts = a.ts
         WHERE a.inverter > 0
           AND a.node > 0
           AND UPPER(COALESCE(a.action, '')) IN ('STOP', 'START')
         ORDER BY a.ts ASC
    """
    try:
        with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            rows = conn.execute(sql, (int(before_ms),)).fetchall()
        return [
            {
                "ts": int(row[0] or 0),
                "inverter": int(row[1] or 0),
                "node": int(row[2] or 0),
                "action": str(row[3] or "").upper(),
                "scope": _normalize_audit_scope(row[4]),
                "result": str(row[5] or "").lower(),
            }
            for row in rows
            if int(row[0] or 0) > 0 and int(row[1] or 0) > 0 and int(row[2] or 0) > 0
        ]
    except Exception as e:
        if "no such table" in str(e).lower():
            return []
        log.warning("Audit-log latest-before query failed [%s]: %s", db_path, e)
        return []


def _query_audit_log_events(db_path: Path, start_ms: int, end_ms_exclusive: int) -> list[dict]:
    if not db_path.exists():
        return []
    sql = """
        SELECT ts,
               inverter,
               node,
               UPPER(COALESCE(action, '')) AS action,
               LOWER(COALESCE(scope, 'single')) AS scope,
               LOWER(COALESCE(result, 'ok')) AS result,
               id
          FROM audit_log
         WHERE ts >= ?
           AND ts < ?
           AND inverter > 0
           AND node > 0
           AND UPPER(COALESCE(action, '')) IN ('STOP', 'START')
           AND LOWER(COALESCE(result, 'ok')) NOT LIKE 'error%'
         ORDER BY ts ASC, id ASC
    """
    try:
        with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            rows = conn.execute(sql, (int(start_ms), int(end_ms_exclusive))).fetchall()
        return [
            {
                "ts": int(row[0] or 0),
                "inverter": int(row[1] or 0),
                "node": int(row[2] or 0),
                "action": str(row[3] or "").upper(),
                "scope": _normalize_audit_scope(row[4]),
                "result": str(row[5] or "").lower(),
                "order": int(row[6] or 0),
            }
            for row in rows
            if int(row[0] or 0) > 0 and int(row[1] or 0) > 0 and int(row[2] or 0) > 0
        ]
    except Exception as e:
        if "no such table" in str(e).lower():
            return []
        log.warning("Audit-log range query failed [%s]: %s", db_path, e)
        return []


@lru_cache(maxsize=256)
def load_operational_constraint_profile(day: str) -> dict:
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    zero_counts = np.zeros(SLOTS_DAY, dtype=np.int16)
    empty = {
        "day": str(day),
        "commanded_off_nodes": zero_counts.copy(),
        "cap_dispatched_off_nodes": zero_counts.copy(),
        "manual_off_nodes": zero_counts.copy(),
        "event_count": 0,
    }
    if day_start_ms is None or day_end_ms is None:
        return empty

    lookback_start_ms = max(
        0,
        int(day_start_ms) - int(OPERATIONAL_CONSTRAINT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    )
    db_paths = _iter_history_db_paths(lookback_start_ms, day_end_ms)
    if not db_paths:
        return empty

    latest_by_node: dict[tuple[int, int], dict] = {}
    events: list[dict] = []
    for db_path in db_paths:
        for rec in _query_audit_log_latest_before(db_path, day_start_ms):
            key = (int(rec["inverter"]), int(rec["node"]))
            prev = latest_by_node.get(key)
            if prev is None or int(rec["ts"]) >= int(prev.get("ts", 0)):
                latest_by_node[key] = rec
        events.extend(_query_audit_log_events(db_path, day_start_ms, day_end_ms))

    active_stops: dict[tuple[int, int], str] = {}
    for rec in latest_by_node.values():
        if not _audit_result_ok(rec.get("result")):
            continue
        key = (int(rec["inverter"]), int(rec["node"]))
        if str(rec.get("action")) == "STOP":
            active_stops[key] = _normalize_audit_scope(rec.get("scope"))
        elif str(rec.get("action")) == "START":
            active_stops.pop(key, None)

    events.sort(
        key=lambda rec: (
            int(rec.get("ts", 0)),
            int(rec.get("order", 0)),
            int(rec.get("inverter", 0)),
            int(rec.get("node", 0)),
            0 if str(rec.get("action")) == "STOP" else 1,
        )
    )

    slot_ms = SLOT_MIN * 60 * 1000
    commanded_off_nodes = np.zeros(SLOTS_DAY, dtype=np.int16)
    cap_dispatched_off_nodes = np.zeros(SLOTS_DAY, dtype=np.int16)
    cursor_slot = 0

    def fill_until(slot_exclusive: int) -> None:
        nonlocal cursor_slot
        slot_exclusive = int(np.clip(slot_exclusive, 0, SLOTS_DAY))
        if slot_exclusive <= cursor_slot:
            return
        commanded_count = len(active_stops)
        cap_count = sum(1 for scope in active_stops.values() if scope == "plant-cap")
        commanded_off_nodes[cursor_slot:slot_exclusive] = np.int16(commanded_count)
        cap_dispatched_off_nodes[cursor_slot:slot_exclusive] = np.int16(cap_count)
        cursor_slot = slot_exclusive

    for rec in events:
        slot = int((int(rec["ts"]) - int(day_start_ms)) // slot_ms)
        slot = int(np.clip(slot, 0, SLOTS_DAY - 1))
        fill_until(slot)
        key = (int(rec["inverter"]), int(rec["node"]))
        action = str(rec.get("action") or "").upper()
        if action == "STOP":
            active_stops[key] = _normalize_audit_scope(rec.get("scope"))
        elif action == "START":
            active_stops.pop(key, None)

    fill_until(SLOTS_DAY)
    manual_off_nodes = np.clip(
        commanded_off_nodes.astype(int) - cap_dispatched_off_nodes.astype(int),
        0,
        None,
    ).astype(np.int16)
    return {
        "day": str(day),
        "commanded_off_nodes": commanded_off_nodes,
        "cap_dispatched_off_nodes": cap_dispatched_off_nodes,
        "manual_off_nodes": manual_off_nodes,
        "event_count": int(len(events)),
    }


def build_operational_constraint_mask(day: str) -> tuple[np.ndarray, dict]:
    profile = load_operational_constraint_profile(day)
    commanded_off_nodes = np.asarray(
        profile.get("commanded_off_nodes", np.zeros(SLOTS_DAY, dtype=np.int16)),
        dtype=int,
    ).copy()
    cap_dispatched_off_nodes = np.asarray(
        profile.get("cap_dispatched_off_nodes", np.zeros(SLOTS_DAY, dtype=np.int16)),
        dtype=int,
    ).copy()
    manual_off_nodes = np.asarray(
        profile.get("manual_off_nodes", np.zeros(SLOTS_DAY, dtype=np.int16)),
        dtype=int,
    ).copy()
    cap_dispatched_off_nodes = np.clip(cap_dispatched_off_nodes, 0, commanded_off_nodes)
    manual_off_nodes = np.clip(manual_off_nodes, 0, commanded_off_nodes)

    operational_mask = commanded_off_nodes > 0
    cap_dispatch_mask = (cap_dispatched_off_nodes > 0) & (manual_off_nodes <= 0)
    manual_constraint_mask = manual_off_nodes > 0
    return operational_mask, {
        "day": str(day),
        "operational_mask": operational_mask,
        "cap_dispatch_mask": cap_dispatch_mask,
        "manual_constraint_mask": manual_constraint_mask,
        "commanded_off_nodes": commanded_off_nodes,
        "cap_dispatched_off_nodes": cap_dispatched_off_nodes,
        "manual_off_nodes": manual_off_nodes,
        "operational_slot_count": int(np.count_nonzero(operational_mask)),
        "cap_dispatch_slot_count": int(np.count_nonzero(cap_dispatch_mask)),
        "manual_constraint_slot_count": int(np.count_nonzero(manual_constraint_mask)),
        "event_count": int(profile.get("event_count", 0)),
    }


# ============================================================================
# ENERGY DATA LOADERS
# ============================================================================

def _day_bounds_ms(day: str) -> tuple[int, int] | tuple[None, None]:
    try:
        start = datetime.strptime(str(day).strip(), "%Y-%m-%d")
    except Exception:
        return None, None
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _archive_month_keys_for_range(start_ms: int, end_ms_exclusive: int) -> list[str]:
    try:
        start_dt = datetime.fromtimestamp(max(0, int(start_ms)) / 1000.0)
        end_dt = datetime.fromtimestamp(max(0, int(end_ms_exclusive - 1)) / 1000.0)
    except Exception:
        return []
    keys = []
    cur = datetime(start_dt.year, start_dt.month, 1)
    stop = datetime(end_dt.year, end_dt.month, 1)
    while cur <= stop:
        keys.append(f"{cur.year:04d}-{cur.month:02d}")
        if cur.month == 12:
            cur = datetime(cur.year + 1, 1, 1)
        else:
            cur = datetime(cur.year, cur.month + 1, 1)
    return keys


def _load_inverter_loss_factors() -> dict[str, float]:
    """Load per-inverter transmission loss factors (0.0-1.0) from ipconfig.

    Used exclusively by forecast-engine paths that compare or learn against
    substation-delivered energy. Dashboard telemetry and exports stay on raw
    actual inverter output.
    """
    ipconfig_meta = load_ipconfig_authoritative()
    cfg = ipconfig_meta.get("config", {}) if isinstance(ipconfig_meta, dict) else {}
    raw = cfg.get("losses", {}) or {}
    factors: dict[str, float] = {}
    for k, v in raw.items():
        pct = 0.0
        try:
            pct = float(v)
        except (TypeError, ValueError):
            pass
        if pct < 0 or pct > 100:
            pct = 0.0
        factors[str(k)] = pct / 100.0
    return factors


def _query_energy_5min_loss_adjusted(
    db_path: Path,
    day_start_ms: int,
    day_end_ms: int,
    loss_factors: dict[str, float],
) -> dict[int, float]:
    """Per-inverter loss-adjusted 5-min energy totals for forecast training.

    Each inverter kWh contribution is reduced by its configured transmission
    loss percentage so the forecast trains on substation-level output.
    """
    if not db_path.exists():
        return {}
    sql = """
        SELECT ts, inverter, COALESCE(kwh_inc, 0) AS kwh_inc
          FROM energy_5min
         WHERE ts >= ? AND ts < ?
         ORDER BY ts ASC
    """
    out: dict[int, float] = {}
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(sql, (int(day_start_ms), int(day_end_ms)))
                for ts, inverter, kwh_inc in cur.fetchall():
                    ts_i = int(ts or 0)
                    if ts_i <= 0:
                        continue
                    inv_key = str(inverter)
                    loss_frac = loss_factors.get(inv_key, 0.0)
                    adjusted = _coerce_non_negative_float(kwh_inc) * (1.0 - loss_frac)
                    out[ts_i] = out.get(ts_i, 0.0) + adjusted
            return out
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB loss-adjusted load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    db_path.name,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB loss-adjusted load failed [%s]: %s", db_path, e)
            break
    return out


def _query_energy_5min_totals(db_path: Path, day_start_ms: int, day_end_ms: int) -> dict[int, float]:
    """Raw plant-level 5-min energy totals -- no loss adjustment."""
    if not db_path.exists():
        return {}
    sql = """
        SELECT ts, SUM(COALESCE(kwh_inc, 0)) AS kwh_inc
          FROM energy_5min
         WHERE ts >= ? AND ts < ?
         GROUP BY ts
         ORDER BY ts ASC
    """
    out: dict[int, float] = {}
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(db_path, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(sql, (int(day_start_ms), int(day_end_ms)))
                for ts, kwh_inc in cur.fetchall():
                    ts_i = int(ts or 0)
                    if ts_i <= 0:
                        continue
                    out[ts_i] = _coerce_non_negative_float(kwh_inc)
            return out
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB actual load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    db_path.name,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB actual load failed [%s]: %s", db_path, e)
            break
    return out


def _load_actual_from_appdata(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return None, None

    merged = _query_energy_5min_totals(APP_DB_FILE, day_start_ms, day_end_ms)
    for month_key in _archive_month_keys_for_range(day_start_ms, day_end_ms):
        archive_path = ARCHIVE_DIR / f"{month_key}.db"
        archive_rows = _query_energy_5min_totals(archive_path, day_start_ms, day_end_ms)
        for ts, kwh_inc in archive_rows.items():
            prev = merged.get(ts, None)
            if prev is None:
                merged[ts] = kwh_inc
            elif prev <= 0 < kwh_inc:
                merged[ts] = kwh_inc

    if not merged:
        return None, None

    out = _empty_slot_values()
    present = _empty_slot_presence()
    slot_ms = SLOT_MIN * 60 * 1000
    for ts in sorted(merged.keys()):
        slot = int((int(ts) - day_start_ms) // slot_ms)
        if 0 <= slot < SLOTS_DAY:
            out[slot] += _coerce_non_negative_float(merged[ts])
            present[slot] = True
    return out, present


def _load_actual_from_legacy_context(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    ctx = _load_json(HISTORY_CTX)
    rows = ctx.get("PacEnergy_5min", {}).get("0", {}).get(day)
    if not isinstance(rows, list):
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    total_rows = len(rows)
    for i, r in enumerate(rows[:SLOTS_DAY]):
        if not isinstance(r, dict):
            continue
        slot = _parse_slot_from_time_text(day, r.get("time") or r.get("time_hms"))
        if slot is None:
            slot = _default_legacy_slot(i, total_rows)
        if 0 <= slot < SLOTS_DAY:
            out[slot] = _coerce_non_negative_float(r.get("kWh_inc", r.get("kwh_inc", 0)))
            present[slot] = True
    return (out, present) if present.any() else (None, None)


@lru_cache(maxsize=256)
def load_actual_with_presence(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    db_actual, db_present = _load_actual_from_appdata(day)
    legacy_actual, legacy_present = _load_actual_from_legacy_context(day)
    return _merge_slot_series_with_presence(
        "Actual history",
        day,
        db_actual,
        db_present,
        legacy_actual,
        legacy_present,
        MIN_HISTORY_SOLAR_SLOTS,
    )


@lru_cache(maxsize=256)
def load_actual(day: str) -> np.ndarray | None:
    values, _ = load_actual_with_presence(day)
    return values


# ---------------------------------------------------------------------------
# Loss-adjusted actual loaders (forecast engine only)
# ---------------------------------------------------------------------------
# These apply per-inverter transmission loss factors so the ML model, error
# memory, intraday adjustment, QA, and backtest all operate on consistent
# substation-level actuals.  Solcast reliability uses the same basis because
# Solcast snapshots are already substation-level.  Non-forecast consumers
# (inverter health display, exports, reports) use the raw load_actual() above.
# ---------------------------------------------------------------------------

# Module-level loss-factor snapshot refreshed each forecast cycle via
# clear_forecast_data_cache().  Avoids re-reading ipconfig.json on every
# per-day call inside training / error-memory loops.
_cached_loss_factors: dict[str, float] | None = None


def _get_loss_factors() -> dict[str, float]:
    """Return cached loss factors, loading from ipconfig on first call."""
    global _cached_loss_factors
    if _cached_loss_factors is None:
        _cached_loss_factors = _load_inverter_loss_factors()
    return _cached_loss_factors


def _has_nonzero_losses() -> bool:
    return any(v > 0 for v in _get_loss_factors().values())


def _load_actual_loss_adjusted_from_appdata(
    day: str,
    loss_factors: dict[str, float],
) -> tuple[np.ndarray | None, np.ndarray | None]:
    day_start_ms, day_end_ms = _day_bounds_ms(day)
    if day_start_ms is None or day_end_ms is None:
        return None, None

    merged = _query_energy_5min_loss_adjusted(APP_DB_FILE, day_start_ms, day_end_ms, loss_factors)
    for month_key in _archive_month_keys_for_range(day_start_ms, day_end_ms):
        archive_path = ARCHIVE_DIR / f"{month_key}.db"
        archive_rows = _query_energy_5min_loss_adjusted(archive_path, day_start_ms, day_end_ms, loss_factors)
        for ts, kwh_inc in archive_rows.items():
            prev = merged.get(ts, None)
            if prev is None:
                merged[ts] = kwh_inc
            elif prev <= 0 < kwh_inc:
                merged[ts] = kwh_inc

    if not merged:
        return None, None

    out = _empty_slot_values()
    present = _empty_slot_presence()
    slot_ms = SLOT_MIN * 60 * 1000
    for ts in sorted(merged.keys()):
        slot = int((int(ts) - day_start_ms) // slot_ms)
        if 0 <= slot < SLOTS_DAY:
            out[slot] += _coerce_non_negative_float(merged[ts])
            present[slot] = True
    return out, present


@lru_cache(maxsize=256)
def load_actual_loss_adjusted_with_presence(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Loss-adjusted (values, presence) pair for forecast-engine consumers."""
    if not _has_nonzero_losses():
        return load_actual_with_presence(day)

    loss_factors = _get_loss_factors()
    db_actual, db_present = _load_actual_loss_adjusted_from_appdata(day, loss_factors)
    legacy_actual, legacy_present = _load_actual_from_legacy_context(day)
    return _merge_slot_series_with_presence(
        "Actual history (loss-adjusted)",
        day,
        db_actual,
        db_present,
        legacy_actual,
        legacy_present,
        MIN_HISTORY_SOLAR_SLOTS,
    )


@lru_cache(maxsize=256)
def load_actual_loss_adjusted(day: str) -> np.ndarray | None:
    """Loss-adjusted 5-min actual for forecast training / day-ahead / QA.

    Falls back to raw load_actual() when configured losses are all zero.
    """
    values, _ = load_actual_loss_adjusted_with_presence(day)
    return values


def _load_dayahead_from_db(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    if not APP_DB_FILE.exists():
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(
                    """
                    SELECT slot, kwh_inc
                      FROM forecast_dayahead
                     WHERE date=?
                     ORDER BY slot ASC
                    """,
                    (str(day),),
                )
                for slot, kwh_inc in cur.fetchall():
                    slot_i = int(slot or 0)
                    if 0 <= slot_i < SLOTS_DAY:
                        out[slot_i] = _coerce_non_negative_float(kwh_inc)
                        present[slot_i] = True
            return (out, present) if present.any() else (None, None)
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB day-ahead load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB day-ahead load failed [%s]: %s", day, e)
            return None, None


def _load_dayahead_from_legacy(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    ctx = _load_json(FORECAST_CTX)
    da  = ctx.get("PacEnergy_DayAhead", {}).get(day)
    if not isinstance(da, list) or not da:
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    total_rows = len(da)
    for i, p in enumerate(da):
        if not isinstance(p, dict):
            continue
        slot = _parse_slot_from_time_text(day, p.get("time") or p.get("time_hms"))
        if slot is None:
            slot = _default_legacy_slot(i, total_rows)
        if 0 <= slot < SLOTS_DAY:
            out[slot] = _coerce_non_negative_float(p.get("kWh_inc", p.get("kwh_inc", 0)))
            present[slot] = True
    return (out, present) if present.any() else (None, None)


@lru_cache(maxsize=256)
def load_dayahead_with_presence(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    db_rows, db_present = _load_dayahead_from_db(day)
    legacy_rows, legacy_present = _load_dayahead_from_legacy(day)
    return _merge_slot_series_with_presence(
        "Day-ahead history",
        day,
        db_rows,
        db_present,
        legacy_rows,
        legacy_present,
        MIN_DAYAHEAD_SOLAR_SLOTS,
    )


@lru_cache(maxsize=256)
def load_dayahead(day: str) -> np.ndarray | None:
    values, _ = load_dayahead_with_presence(day)
    return values


def load_solcast_snapshot(day: str) -> dict | None:
    if not APP_DB_FILE.exists():
        return None

    forecast_kwh = _empty_slot_values()
    forecast_lo_kwh = _empty_slot_values()
    forecast_hi_kwh = _empty_slot_values()
    est_actual_kwh = _empty_slot_values()
    forecast_mw = _empty_slot_values()
    forecast_lo_mw = _empty_slot_values()
    forecast_hi_mw = _empty_slot_values()
    est_actual_mw = _empty_slot_values()
    present = _empty_slot_presence()
    pulled_ts = 0
    source = ""

    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(
                    """
                    SELECT slot,
                           forecast_kwh,
                           forecast_lo_kwh,
                           forecast_hi_kwh,
                           est_actual_kwh,
                           forecast_mw,
                           forecast_lo_mw,
                           forecast_hi_mw,
                           est_actual_mw,
                           pulled_ts,
                           source
                      FROM solcast_snapshots
                     WHERE forecast_day=?
                     ORDER BY slot ASC
                    """,
                    (str(day),),
                )
                rows = cur.fetchall()
            if not rows:
                return None

            for row in rows:
                slot_i = int(row[0] or 0)
                if not (0 <= slot_i < SLOTS_DAY):
                    continue
                has_prior = any(value is not None for value in (row[1], row[5], row[2], row[3]))
                row_forecast_kwh, row_forecast_mw = _normalize_solcast_slot_pair(row[1], row[5])
                row_forecast_lo_kwh, row_forecast_lo_mw = _normalize_solcast_slot_pair(row[2], row[6])
                row_forecast_hi_kwh, row_forecast_hi_mw = _normalize_solcast_slot_pair(row[3], row[7])
                row_est_actual_kwh, row_est_actual_mw = _normalize_solcast_slot_pair(row[4], row[8])
                forecast_kwh[slot_i] = float(row_forecast_kwh or 0.0)
                forecast_mw[slot_i] = float(row_forecast_mw or 0.0)
                forecast_lo_kwh[slot_i] = float(
                    forecast_kwh[slot_i] if row_forecast_lo_kwh is None else row_forecast_lo_kwh
                )
                forecast_hi_kwh[slot_i] = float(
                    forecast_kwh[slot_i] if row_forecast_hi_kwh is None else row_forecast_hi_kwh
                )
                est_actual_kwh[slot_i] = float(row_est_actual_kwh or 0.0)
                forecast_lo_mw[slot_i] = float(
                    forecast_mw[slot_i] if row_forecast_lo_mw is None else row_forecast_lo_mw
                )
                forecast_hi_mw[slot_i] = float(
                    forecast_mw[slot_i] if row_forecast_hi_mw is None else row_forecast_hi_mw
                )
                est_actual_mw[slot_i] = float(row_est_actual_mw or 0.0)
                present[slot_i] = bool(has_prior)
                if row[9] is not None:
                    pulled_ts = max(pulled_ts, int(float(row[9] or 0)))
                if row[10]:
                    source = str(row[10])

            solar_present = present[SOLAR_START_SLOT:SOLAR_END_SLOT]
            coverage_slots = int(np.count_nonzero(solar_present))
            if coverage_slots <= 0:
                return None

            solar_forecast = np.clip(forecast_kwh[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
            solar_lo = np.clip(forecast_lo_kwh[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
            solar_hi = np.clip(forecast_hi_kwh[SOLAR_START_SLOT:SOLAR_END_SLOT], 0.0, None)
            spread_frac = np.zeros(SLOTS_DAY, dtype=float)
            with np.errstate(divide="ignore", invalid="ignore"):
                solar_spread = np.clip(
                    (solar_hi - solar_lo) / np.maximum(solar_forecast, 0.05),
                    0.0,
                    SOLCAST_PRIOR_SPREAD_FRAC_CLIP,
                )
            spread_frac[SOLAR_START_SLOT:SOLAR_END_SLOT] = np.where(solar_present, solar_spread, 0.0)

            return {
                "day": str(day),
                "present": present,
                "forecast_kwh": forecast_kwh,
                "forecast_lo_kwh": forecast_lo_kwh,
                "forecast_hi_kwh": forecast_hi_kwh,
                "est_actual_kwh": est_actual_kwh,
                "forecast_mw": forecast_mw,
                "forecast_lo_mw": forecast_lo_mw,
                "forecast_hi_mw": forecast_hi_mw,
                "est_actual_mw": est_actual_mw,
                "spread_frac": spread_frac,
                "coverage_slots": coverage_slots,
                "coverage_ratio": float(coverage_slots / max(SOLAR_SLOTS, 1)),
                "power_unit": "mw",
                "energy_unit": "kwh_per_slot",
                "pulled_ts": int(pulled_ts),
                "source": source or "solcast",
            }
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB Solcast snapshot load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB Solcast snapshot load failed [%s]: %s", day, e)
            return None
    return None


def build_solcast_reliability_artifact(today: date) -> dict | None:
    records = []
    resolution_days: list[dict] = []
    resolution_overall_solcast: list[dict] = []
    resolution_overall_dayahead: list[dict] = []
    resolution_regime_solcast: dict[str, list[dict]] = {}
    resolution_regime_dayahead: dict[str, list[dict]] = {}
    resolution_bucket_solcast: dict[str, list[dict]] = {}
    resolution_bucket_dayahead: dict[str, list[dict]] = {}
    resolution_pair_solcast: dict[tuple[str, str], list[dict]] = {}
    resolution_pair_dayahead: dict[tuple[str, str], list[dict]] = {}
    lookback = max(SOLCAST_RELIABILITY_LOOKBACK_DAYS, N_TRAIN_DAYS)
    for days_ago in range(1, lookback + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        # Solcast's raw provider unit is MW, normalized to per-slot kWh for
        # forecast scoring, and already substation-level. Calibrate it against
        # the same loss-adjusted actual basis used by training, QA, and backtest.
        actual, actual_present = load_actual_loss_adjusted_with_presence(day)
        snapshot = load_solcast_snapshot(day)
        dayahead, dayahead_present = load_dayahead_with_presence(day)
        if actual is None or actual_present is None:
            continue
        wdata = fetch_weather(day, source="archive")
        if wdata is None:
            continue
        w5 = interpolate_5min(wdata, day)
        stats = analyse_weather_day(day, w5, actual)
        regime = classify_day_regime(stats)
        bucket_labels = classify_slot_weather_buckets(w5, day)
        _, constraint_meta = build_operational_constraint_mask(day)
        exclude_mask = np.asarray(constraint_meta.get("operational_mask"), dtype=bool)
        solcast_metrics = None
        solcast_bucket_metrics: dict[str, dict] = {}
        if snapshot:
            present = np.asarray(snapshot["present"], dtype=bool)
            mask = (
                present
                & (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
                & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
                & (np.asarray(snapshot["forecast_kwh"], dtype=float) > 0.0)
            )
            usable = int(np.count_nonzero(mask))
            if usable >= SOLCAST_MIN_USABLE_SLOTS:
                prior = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float)[mask], 0.0, None)
                actual_slots = np.clip(np.asarray(actual, dtype=float)[mask], 0.0, None)
                spread = np.asarray(snapshot["spread_frac"], dtype=float)[mask]
                if np.any(prior > 0):
                    ratio = float(np.clip(actual_slots.sum() / max(prior.sum(), 1.0), *SOLCAST_BIAS_RATIO_CLIP))
                    mape = float(np.mean(np.abs(actual_slots - prior) / np.maximum(actual_slots, 1.0)))
                    records.append({
                        "day": day,
                        "regime": regime,
                        "coverage_ratio": float(snapshot.get("coverage_ratio", 0.0)),
                        "bias_ratio": ratio,
                        "mape": mape,
                        "spread_mean": float(np.mean(spread)) if spread.size else 0.0,
                    })
                    solcast_forecast = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None)
                    solcast_metrics = compute_forecast_metrics(
                        actual,
                        solcast_forecast,
                        actual_present=actual_present,
                        forecast_present=present,
                        exclude_mask=exclude_mask,
                    )
                    solcast_bucket_metrics = compute_bucketed_forecast_metrics(
                        actual,
                        solcast_forecast,
                        bucket_labels,
                        actual_present=actual_present,
                        forecast_present=present,
                        exclude_mask=exclude_mask,
                    )
        dayahead_metrics = (
            compute_forecast_metrics(
                actual,
                dayahead,
                actual_present=actual_present,
                forecast_present=dayahead_present,
                exclude_mask=exclude_mask,
            )
            if dayahead is not None and dayahead_present is not None
            else None
        )
        dayahead_bucket_metrics = (
            compute_bucketed_forecast_metrics(
                actual,
                dayahead,
                bucket_labels,
                actual_present=actual_present,
                forecast_present=dayahead_present,
                exclude_mask=exclude_mask,
            )
            if dayahead is not None and dayahead_present is not None
            else {}
        )
        daily_record = _build_resolution_daily_record(
            day,
            regime,
            solcast_metrics,
            dayahead_metrics,
            solcast_bucket_metrics,
            dayahead_bucket_metrics,
        )
        overall_profile = daily_record.get("overall") if isinstance(daily_record.get("overall"), dict) else {}
        if overall_profile.get("solcast") or overall_profile.get("dayahead"):
            resolution_days.append(daily_record)
        if overall_profile.get("solcast"):
            resolution_overall_solcast.append(dict(overall_profile["solcast"]))
            resolution_regime_solcast.setdefault(regime, []).append(dict(overall_profile["solcast"]))
        if overall_profile.get("dayahead"):
            resolution_overall_dayahead.append(dict(overall_profile["dayahead"]))
            resolution_regime_dayahead.setdefault(regime, []).append(dict(overall_profile["dayahead"]))
        for bucket, profile in (daily_record.get("buckets") or {}).items():
            if not isinstance(profile, dict):
                continue
            if profile.get("solcast"):
                resolution_bucket_solcast.setdefault(bucket, []).append(dict(profile["solcast"]))
                resolution_pair_solcast.setdefault((regime, bucket), []).append(dict(profile["solcast"]))
            if profile.get("dayahead"):
                resolution_bucket_dayahead.setdefault(bucket, []).append(dict(profile["dayahead"]))
                resolution_pair_dayahead.setdefault((regime, bucket), []).append(dict(profile["dayahead"]))

    if len(records) < SOLCAST_RELIABILITY_MIN_DAYS:
        return None

    def aggregate(rows: list[dict]) -> dict:
        mape = float(np.mean([row["mape"] for row in rows]))
        bias_ratio = float(np.clip(np.mean([row["bias_ratio"] for row in rows]), *SOLCAST_BIAS_RATIO_CLIP))
        coverage_ratio = float(np.mean([row["coverage_ratio"] for row in rows]))
        spread_mean = float(np.mean([row["spread_mean"] for row in rows]))
        reliability = float(np.clip(1.0 - min(0.55, mape) / 0.55, 0.25, 1.0))
        return {
            "day_count": int(len(rows)),
            "mean_mape": mape,
            "bias_ratio": bias_ratio,
            "coverage_ratio": coverage_ratio,
            "spread_mean": spread_mean,
            "reliability": reliability,
        }

    by_regime: dict[str, list[dict]] = {}
    for row in records:
        by_regime.setdefault(str(row["regime"]), []).append(row)

    return {
        "created_ts": int(time.time()),
        "day_count": int(len(records)),
        "overall": aggregate(records),
        "regimes": {
            regime: aggregate(rows)
            for regime, rows in sorted(by_regime.items())
            if rows
        },
        "resolution_profiles": {
            "created_ts": int(time.time()),
            "day_count": int(len(resolution_days)),
            "resolution_minutes": int(SLOT_MIN),
            "source_power_unit": "mw",
            "energy_unit": "kwh_per_slot",
            "actual_basis": "loss_adjusted_actual",
            "days": resolution_days,
            "overall": _build_resolution_profile(
                resolution_overall_solcast,
                resolution_overall_dayahead,
            ),
            "regimes": {
                regime: _build_resolution_profile(
                    resolution_regime_solcast.get(regime),
                    resolution_regime_dayahead.get(regime),
                )
                for regime in sorted(set(resolution_regime_solcast.keys()) | set(resolution_regime_dayahead.keys()))
            },
            "buckets": {
                bucket: _build_resolution_profile(
                    resolution_bucket_solcast.get(bucket),
                    resolution_bucket_dayahead.get(bucket),
                )
                for bucket in sorted(set(resolution_bucket_solcast.keys()) | set(resolution_bucket_dayahead.keys()))
            },
            "pairs": {
                f"{regime}:{bucket}": _build_resolution_profile(
                    resolution_pair_solcast.get((regime, bucket)),
                    resolution_pair_dayahead.get((regime, bucket)),
                )
                for regime, bucket in sorted(set(resolution_pair_solcast.keys()) | set(resolution_pair_dayahead.keys()))
            },
        },
    }


def save_solcast_reliability_artifact(artifact: dict | None) -> bool:
    if artifact is None:
        try:
            if SOLCAST_RELIABILITY_FILE.exists():
                SOLCAST_RELIABILITY_FILE.unlink()
        except Exception:
            return False
        return True
    try:
        SOLCAST_RELIABILITY_FILE.parent.mkdir(parents=True, exist_ok=True)
        dump(artifact, SOLCAST_RELIABILITY_FILE)
        return True
    except Exception as e:
        log.error("Solcast reliability save failed %s: %s", SOLCAST_RELIABILITY_FILE, e)
        return False


def load_solcast_reliability_artifact(today: date | None = None, allow_build: bool = False) -> dict | None:
    if SOLCAST_RELIABILITY_FILE.exists():
        try:
            data = load(SOLCAST_RELIABILITY_FILE)
            if isinstance(data, dict):
                return data
        except Exception as e:
            log.warning("Solcast reliability load failed %s: %s", SOLCAST_RELIABILITY_FILE, e)
    if allow_build and today is not None:
        artifact = build_solcast_reliability_artifact(today)
        if artifact:
            save_solcast_reliability_artifact(artifact)
        return artifact
    return None


def _metric_reliability_from_mape_pct(mape_pct: float) -> float:
    mape_frac = max(float(mape_pct or 0.0), 0.0) / 100.0
    return float(np.clip(1.0 - min(0.55, mape_frac) / 0.55, 0.25, 1.0))


def _forecast_metric_summary(metrics: dict | None) -> dict | None:
    if not metrics or int(metrics.get("usable_slot_count", 0)) <= 0:
        return None
    usable = int(metrics.get("usable_slot_count", 0))
    rmse = float(metrics.get("rmse_kwh", 0.0))
    return {
        "usable_slot_count": usable,
        "actual_total_kwh": float(metrics.get("actual_total_kwh", 0.0)),
        "forecast_total_kwh": float(metrics.get("forecast_total_kwh", 0.0)),
        "abs_error_sum_kwh": float(metrics.get("abs_error_sum_kwh", 0.0)),
        "mae_kwh": float(metrics.get("mae_kwh", 0.0)),
        "mbe_kwh": float(metrics.get("mbe_kwh", 0.0)),
        "rmse_kwh": rmse,
        "mape_pct": float(metrics.get("mape_pct", 0.0)),
        "wape_pct": float(metrics.get("wape_pct", 0.0)),
        "total_ape_pct": float(metrics.get("total_ape_pct", 0.0)),
        "sse_kwh2": float((rmse ** 2) * usable),
        "reliability": _metric_reliability_from_mape_pct(float(metrics.get("mape_pct", 0.0))),
    }


def _aggregate_forecast_metric_rows(rows: list[dict] | None) -> dict | None:
    valid = [
        dict(row)
        for row in (rows or [])
        if isinstance(row, dict) and int(row.get("usable_slot_count", 0)) > 0
    ]
    if not valid:
        return None
    usable_total = int(sum(int(row.get("usable_slot_count", 0)) for row in valid))
    actual_total = float(sum(float(row.get("actual_total_kwh", 0.0)) for row in valid))
    forecast_total = float(sum(float(row.get("forecast_total_kwh", 0.0)) for row in valid))
    abs_error_sum = float(sum(float(row.get("abs_error_sum_kwh", 0.0)) for row in valid))
    sse = float(sum(float(row.get("sse_kwh2", 0.0)) for row in valid))
    mae = float(
        np.average(
            [float(row.get("mae_kwh", 0.0)) for row in valid],
            weights=[max(int(row.get("usable_slot_count", 0)), 1) for row in valid],
        )
    )
    mbe = float(
        np.average(
            [float(row.get("mbe_kwh", 0.0)) for row in valid],
            weights=[max(int(row.get("usable_slot_count", 0)), 1) for row in valid],
        )
    )
    mape = float(
        np.average(
            [float(row.get("mape_pct", 0.0)) for row in valid],
            weights=[max(int(row.get("usable_slot_count", 0)), 1) for row in valid],
        )
    )
    total_ape = float(
        np.average(
            [float(row.get("total_ape_pct", 0.0)) for row in valid],
            weights=[max(float(row.get("actual_total_kwh", 0.0)), 1.0) for row in valid],
        )
    )
    return {
        "day_count": int(len(valid)),
        "usable_slot_count": usable_total,
        "actual_total_kwh": actual_total,
        "forecast_total_kwh": forecast_total,
        "abs_error_sum_kwh": abs_error_sum,
        "mae_kwh": mae,
        "mbe_kwh": mbe,
        "rmse_kwh": float(np.sqrt(sse / max(usable_total, 1))),
        "mape_pct": mape,
        "wape_pct": float((abs_error_sum / max(actual_total, 1.0)) * 100.0),
        "total_ape_pct": total_ape,
        "reliability": _metric_reliability_from_mape_pct(mape),
    }


def _build_resolution_profile(solcast_rows: list[dict] | None, dayahead_rows: list[dict] | None) -> dict:
    solcast_stats = _aggregate_forecast_metric_rows(solcast_rows)
    dayahead_stats = _aggregate_forecast_metric_rows(dayahead_rows)
    common_days = int(
        min(
            int((solcast_stats or {}).get("day_count", 0)),
            int((dayahead_stats or {}).get("day_count", 0)),
        )
    ) if solcast_stats and dayahead_stats else 0
    solcast_weight = SOLCAST_RESOLUTION_WEIGHT_FALLBACK
    preferred_source = "blend"
    wape_gap = None
    if solcast_stats and dayahead_stats:
        solcast_wape = max(float(solcast_stats.get("wape_pct", 0.0)), 0.0)
        dayahead_wape = max(float(dayahead_stats.get("wape_pct", 0.0)), 0.0)
        if solcast_wape > 0.0 or dayahead_wape > 0.0:
            solcast_weight = float(
                np.clip(
                    dayahead_wape / max(solcast_wape + dayahead_wape, 1e-6),
                    0.0,
                    1.0,
                )
            )
        wape_gap = float(dayahead_wape - solcast_wape)
        if solcast_weight >= 0.55:
            preferred_source = "solcast"
        elif solcast_weight <= 0.45:
            preferred_source = "dayahead"
    return {
        "solcast": solcast_stats,
        "dayahead": dayahead_stats,
        "solcast_weight": float(solcast_weight),
        "preferred_source": preferred_source,
        "support_days": common_days,
        "wape_gap_pct": wape_gap,
    }


def _build_resolution_daily_record(
    day: str,
    regime: str,
    solcast_metrics: dict | None,
    dayahead_metrics: dict | None,
    solcast_bucket_metrics: dict[str, dict] | None,
    dayahead_bucket_metrics: dict[str, dict] | None,
) -> dict:
    solcast_summary = _forecast_metric_summary(solcast_metrics)
    dayahead_summary = _forecast_metric_summary(dayahead_metrics)
    bucket_profiles: dict[str, dict] = {}
    bucket_names = sorted(
        set((solcast_bucket_metrics or {}).keys()) | set((dayahead_bucket_metrics or {}).keys())
    )
    for bucket in bucket_names:
        profile = _build_resolution_profile(
            [_forecast_metric_summary((solcast_bucket_metrics or {}).get(bucket))]
            if (solcast_bucket_metrics or {}).get(bucket)
            else [],
            [_forecast_metric_summary((dayahead_bucket_metrics or {}).get(bucket))]
            if (dayahead_bucket_metrics or {}).get(bucket)
            else [],
        )
        if profile.get("solcast") or profile.get("dayahead"):
            bucket_profiles[str(bucket)] = profile
    return {
        "day": str(day),
        "day_regime": str(regime or ""),
        "resolution_minutes": int(SLOT_MIN),
        "source_power_unit": "mw",
        "energy_unit": "kwh_per_slot",
        "actual_basis": "loss_adjusted_actual",
        "overall": _build_resolution_profile(
            [solcast_summary] if solcast_summary else [],
            [dayahead_summary] if dayahead_summary else [],
        ),
        "buckets": bucket_profiles,
    }


def lookup_solcast_resolution_profile(
    artifact: dict | None,
    regime: str,
    bucket: str | None = None,
) -> dict:
    fallback = {
        "solcast_weight": SOLCAST_RESOLUTION_WEIGHT_FALLBACK,
        "preferred_source": "blend",
        "support_days": 0,
        "wape_gap_pct": None,
        "profile_key": "fallback",
    }
    if not artifact or not isinstance(artifact, dict):
        return fallback
    profiles = artifact.get("resolution_profiles")
    if not isinstance(profiles, dict):
        return fallback
    pair_key = f"{str(regime or '')}:{str(bucket or '')}"
    pairs = profiles.get("pairs") if isinstance(profiles.get("pairs"), dict) else {}
    if bucket and pair_key in pairs and isinstance(pairs[pair_key], dict):
        out = dict(fallback)
        out.update(pairs[pair_key])
        out["profile_key"] = pair_key
        return out
    buckets = profiles.get("buckets") if isinstance(profiles.get("buckets"), dict) else {}
    if bucket and str(bucket) in buckets and isinstance(buckets[str(bucket)], dict):
        out = dict(fallback)
        out.update(buckets[str(bucket)])
        out["profile_key"] = str(bucket)
        return out
    regimes = profiles.get("regimes") if isinstance(profiles.get("regimes"), dict) else {}
    if regime in regimes and isinstance(regimes[regime], dict):
        out = dict(fallback)
        out.update(regimes[regime])
        out["profile_key"] = str(regime)
        return out
    overall = profiles.get("overall") if isinstance(profiles.get("overall"), dict) else {}
    out = dict(fallback)
    out.update(overall)
    out["profile_key"] = "overall"
    return out


def lookup_solcast_resolution_weight_vector(
    artifact: dict | None,
    regime: str,
    bucket_labels: np.ndarray | list[str] | None,
) -> tuple[np.ndarray, np.ndarray]:
    weights = np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float)
    support = np.zeros(SLOTS_DAY, dtype=float)
    if bucket_labels is None:
        return weights, support
    labels = np.asarray(bucket_labels, dtype=object).reshape(-1)
    if labels.size < SLOTS_DAY:
        return weights, support
    support_norm = float(max(max(SOLCAST_RELIABILITY_LOOKBACK_DAYS, N_TRAIN_DAYS), 1))
    for bucket in sorted({
        str(label)
        for label in labels[:SLOTS_DAY]
        if str(label) and str(label) != "offsolar"
    }):
        profile = lookup_solcast_resolution_profile(artifact, regime, bucket)
        mask = labels[:SLOTS_DAY] == bucket
        weights[mask] = float(
            np.clip(
                profile.get("solcast_weight", SOLCAST_RESOLUTION_WEIGHT_FALLBACK),
                0.0,
                1.0,
            )
        )
        support[mask] = float(
            np.clip(float(profile.get("support_days", 0)) / support_norm, 0.0, 1.0)
        )
    return weights, support


def lookup_solcast_reliability(artifact: dict | None, regime: str) -> dict:
    fallback = {
        "day_count": 0,
        "mean_mape": 0.24,
        "bias_ratio": 1.0,
        "coverage_ratio": 0.0,
        "spread_mean": 0.0,
        "reliability": 0.62,
    }
    if not artifact or not isinstance(artifact, dict):
        return fallback
    regimes = artifact.get("regimes") or {}
    if regime in regimes and isinstance(regimes[regime], dict):
        out = dict(fallback)
        out.update(regimes[regime])
        return out
    overall = artifact.get("overall") if isinstance(artifact.get("overall"), dict) else {}
    out = dict(fallback)
    out.update(overall)
    return out


def solcast_prior_from_snapshot(
    day: str,
    w5: pd.DataFrame,
    snapshot: dict | None,
    reliability_artifact: dict | None = None,
) -> dict | None:
    if not snapshot or int(snapshot.get("coverage_slots", 0)) < SOLCAST_MIN_USABLE_SLOTS:
        return None

    stats = analyse_weather_day(day, w5)
    regime = classify_day_regime(stats)
    reliability = lookup_solcast_reliability(reliability_artifact, regime)
    bucket_labels = classify_slot_weather_buckets(w5, day)
    resolution_weight, resolution_support = lookup_solcast_resolution_weight_vector(
        reliability_artifact,
        regime,
        bucket_labels,
    )

    prior_kwh = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float), 0.0, None).copy()
    prior_lo = np.clip(np.asarray(snapshot["forecast_lo_kwh"], dtype=float), 0.0, None).copy()
    prior_hi = np.clip(np.asarray(snapshot["forecast_hi_kwh"], dtype=float), 0.0, None).copy()
    prior_mw = np.clip(np.asarray(snapshot["forecast_mw"], dtype=float), 0.0, None).copy()
    spread_frac = np.clip(np.asarray(snapshot["spread_frac"], dtype=float), 0.0, SOLCAST_PRIOR_SPREAD_FRAC_CLIP)
    present = np.asarray(snapshot["present"], dtype=bool).copy()

    bias_ratio = float(np.clip(reliability.get("bias_ratio", 1.0), *SOLCAST_BIAS_RATIO_CLIP))
    reliability_score = float(np.clip(reliability.get("reliability", 0.62), 0.25, 1.0))
    coverage_ratio = float(np.clip(snapshot.get("coverage_ratio", 0.0), 0.0, 1.0))

    prior_kwh *= bias_ratio
    prior_lo *= bias_ratio
    prior_hi *= bias_ratio
    prior_mw *= bias_ratio
    prior_kwh[:SOLAR_START_SLOT] = 0.0
    prior_kwh[SOLAR_END_SLOT:] = 0.0

    idx = np.arange(SLOTS_DAY)
    solar_rel = (idx - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1)
    solar_rel = np.clip(solar_rel, 0.0, 1.0)
    solar_weight = 0.58 + 0.42 * np.sin(np.pi * solar_rel)
    solar_weight = np.clip(solar_weight, 0.45, 1.0)
    base_by_regime = {
        "clear": 0.54,
        "mixed": 0.50,
        "overcast": 0.56,
        "rainy": 0.44,
    }.get(regime, 0.46)
    if regime == "clear":
        clear_rel = np.clip((reliability_score - 0.60) / 0.30, 0.0, 1.0)
        clear_cov = np.clip((coverage_ratio - 0.72) / 0.28, 0.0, 1.0)
        base_by_regime = max(base_by_regime, 0.58 + 0.16 * clear_rel + 0.08 * clear_cov)
    primary_mode = bool(
        coverage_ratio >= SOLCAST_PRIMARY_COVERAGE_MIN
        and reliability_score >= SOLCAST_PRIMARY_RELIABILITY_MIN
    )
    # Solcast-primary: when coverage is high and reliability is reasonable,
    # elevate base blend so Solcast becomes the primary forecast baseline.
    if primary_mode:
        base_by_regime = max(base_by_regime, 0.82)
        log.info(
            "Solcast-primary mode activated: coverage=%.2f reliability=%.2f base_blend=%.2f",
            coverage_ratio, reliability_score, base_by_regime,
        )
    spread_weight = 1.0 - 0.42 * np.clip(spread_frac / max(SOLCAST_PRIOR_SPREAD_FRAC_CLIP, 0.1), 0.0, 1.0)
    blend = base_by_regime * reliability_score * (0.55 + 0.45 * coverage_ratio) * spread_weight * solar_weight
    resolution_scale = (
        SOLCAST_RESOLUTION_BLEND_SCALE_MIN
        + (SOLCAST_RESOLUTION_BLEND_SCALE_MAX - SOLCAST_RESOLUTION_BLEND_SCALE_MIN) * resolution_weight
    )
    blend = blend * resolution_scale
    if primary_mode:
        rel_norm = np.clip(
            (reliability_score - SOLCAST_PRIMARY_RELIABILITY_MIN)
            / max(1.0 - SOLCAST_PRIMARY_RELIABILITY_MIN, 1e-6),
            0.0,
            1.0,
        )
        cov_norm = np.clip(
            (coverage_ratio - SOLCAST_PRIMARY_COVERAGE_MIN)
            / max(1.0 - SOLCAST_PRIMARY_COVERAGE_MIN, 1e-6),
            0.0,
            1.0,
        )
        primary_floor = (
            SOLCAST_PRIMARY_BLEND_FLOOR_MIN
            + 0.08 * rel_norm
            + 0.06 * cov_norm
        )
        primary_floor = np.clip(
            primary_floor * (0.92 + 0.08 * spread_weight) * (0.96 + 0.04 * solar_weight),
            SOLCAST_PRIMARY_BLEND_FLOOR_MIN,
            SOLCAST_PRIMARY_BLEND_FLOOR_MAX,
        )
        primary_floor = primary_floor * (
            SOLCAST_RESOLUTION_PRIMARY_SCALE_MIN
            + (SOLCAST_RESOLUTION_PRIMARY_SCALE_MAX - SOLCAST_RESOLUTION_PRIMARY_SCALE_MIN) * resolution_weight
        )
        blend = np.maximum(blend, primary_floor)
    blend = np.clip(blend, SOLCAST_PRIOR_BLEND_MIN, SOLCAST_PRIOR_BLEND_MAX)
    blend[~present] = 0.0
    blend[:SOLAR_START_SLOT] = 0.0
    blend[SOLAR_END_SLOT:] = 0.0

    return {
        "available": present.astype(float),
        "present": present,
        "prior_kwh": prior_kwh,
        "prior_lo_kwh": prior_lo,
        "prior_hi_kwh": prior_hi,
        "prior_mw": prior_mw,
        "spread_frac": spread_frac,
        "blend": blend,
        "coverage_ratio": coverage_ratio,
        "bias_ratio": bias_ratio,
        "reliability": reliability_score,
        "resolution_weight": resolution_weight,
        "resolution_support": resolution_support,
        "primary_mode": primary_mode,
        "regime": regime,
        "source": str(snapshot.get("source") or "solcast"),
        "pulled_ts": int(snapshot.get("pulled_ts", 0) or 0),
    }


def blend_physics_with_solcast(
    baseline: np.ndarray,
    solcast_prior: dict | None,
) -> tuple[np.ndarray, dict]:
    base = np.clip(np.asarray(baseline, dtype=float), 0.0, None)
    if not solcast_prior:
        return base.copy(), {
            "used_solcast": False,
            "coverage_ratio": 0.0,
            "mean_blend": 0.0,
            "bias_ratio": 1.0,
            "reliability": 0.0,
            "regime": "",
        }

    prior = np.clip(np.asarray(solcast_prior["prior_kwh"], dtype=float), 0.0, None)
    blend = np.clip(np.asarray(solcast_prior["blend"], dtype=float), 0.0, 1.0)
    present = np.asarray(solcast_prior["present"], dtype=bool)
    resolution_weight = np.clip(
        np.asarray(
            solcast_prior.get(
                "resolution_weight",
                np.full(SLOTS_DAY, SOLCAST_RESOLUTION_WEIGHT_FALLBACK, dtype=float),
            ),
            dtype=float,
        ),
        0.0,
        1.0,
    )
    resolution_support = np.clip(
        np.asarray(solcast_prior.get("resolution_support", np.zeros(SLOTS_DAY, dtype=float)), dtype=float),
        0.0,
        1.0,
    )
    adjusted_prior = prior.copy()
    solar_present = present[SOLAR_START_SLOT:SOLAR_END_SLOT]
    base_solar = base[SOLAR_START_SLOT:SOLAR_END_SLOT]
    prior_solar = prior[SOLAR_START_SLOT:SOLAR_END_SLOT]
    base_total = float(base_solar.sum())
    prior_total = float(prior_solar[solar_present].sum()) if np.any(solar_present) else 0.0
    raw_ratio = float(prior_total / max(base_total, 1.0)) if base_total > 0 else 1.0
    applied_ratio = float(np.clip(raw_ratio, *SOLCAST_PRIOR_TOTAL_RATIO_CLIP))
    if base_total > 0.0 and prior_total > 0.0 and np.any(solar_present):
        # Keep Solcast's intra-day shape, but constrain its daily energy against
        # the plant-aware physics baseline so raw provider totals do not dominate.
        solar_profile = np.zeros_like(prior_solar)
        solar_profile[solar_present] = prior_solar[solar_present] / max(prior_total, 1.0)
        adjusted_total = base_total * applied_ratio
        adjusted_prior[SOLAR_START_SLOT:SOLAR_END_SLOT] = solar_profile * adjusted_total
        adjusted_prior[:SOLAR_START_SLOT] = 0.0
        adjusted_prior[SOLAR_END_SLOT:] = 0.0
    out = base.copy()
    out[present] = (1.0 - blend[present]) * base[present] + blend[present] * adjusted_prior[present]
    out[:SOLAR_START_SLOT] = 0.0
    out[SOLAR_END_SLOT:] = 0.0
    return out, {
        "used_solcast": True,
        "coverage_ratio": float(solcast_prior.get("coverage_ratio", 0.0)),
        "mean_blend": float(np.mean(blend[SOLAR_START_SLOT:SOLAR_END_SLOT][present[SOLAR_START_SLOT:SOLAR_END_SLOT]])) if np.any(present[SOLAR_START_SLOT:SOLAR_END_SLOT]) else 0.0,
        "bias_ratio": float(solcast_prior.get("bias_ratio", 1.0)),
        "reliability": float(solcast_prior.get("reliability", 0.0)),
        "resolution_weight_mean": float(
            np.mean(
                resolution_weight[SOLAR_START_SLOT:SOLAR_END_SLOT][present[SOLAR_START_SLOT:SOLAR_END_SLOT]]
            )
        ) if np.any(present[SOLAR_START_SLOT:SOLAR_END_SLOT]) else SOLCAST_RESOLUTION_WEIGHT_FALLBACK,
        "resolution_support_mean": float(
            np.mean(
                resolution_support[SOLAR_START_SLOT:SOLAR_END_SLOT][present[SOLAR_START_SLOT:SOLAR_END_SLOT]]
            )
        ) if np.any(present[SOLAR_START_SLOT:SOLAR_END_SLOT]) else 0.0,
        "primary_mode": bool(solcast_prior.get("primary_mode", False)),
        "raw_prior_total_kwh": prior_total,
        "applied_prior_total_kwh": float(adjusted_prior[SOLAR_START_SLOT:SOLAR_END_SLOT].sum()),
        "raw_prior_ratio": raw_ratio,
        "applied_prior_ratio": applied_ratio,
        "regime": str(solcast_prior.get("regime") or ""),
        "source": str(solcast_prior.get("source") or "solcast"),
        "pulled_ts": int(solcast_prior.get("pulled_ts", 0) or 0),
    }


def _load_intraday_adjusted_from_db(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    if not APP_DB_FILE.exists():
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
                conn.execute("PRAGMA query_only = ON")
                cur = conn.execute(
                    """
                    SELECT slot, kwh_inc
                      FROM forecast_intraday_adjusted
                     WHERE date=?
                     ORDER BY slot ASC
                    """,
                    (str(day),),
                )
                for slot, kwh_inc in cur.fetchall():
                    slot_i = int(slot or 0)
                    if 0 <= slot_i < SLOTS_DAY:
                        out[slot_i] = _coerce_non_negative_float(kwh_inc)
                        present[slot_i] = True
            return (out, present) if present.any() else (None, None)
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB intraday load retry %d/%d [%s]: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.warning("DB intraday load failed [%s]: %s", day, e)
            return None, None


def _load_intraday_adjusted_from_legacy(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    ctx = _load_json(FORECAST_CTX)
    da = ctx.get("PacEnergy_IntradayAdjusted", {}).get(day)
    if not isinstance(da, list) or not da:
        return None, None
    out = _empty_slot_values()
    present = _empty_slot_presence()
    total_rows = len(da)
    for i, p in enumerate(da):
        if not isinstance(p, dict):
            continue
        slot = _parse_slot_from_time_text(day, p.get("time") or p.get("time_hms"))
        if slot is None:
            slot = _default_legacy_slot(i, total_rows)
        if 0 <= slot < SLOTS_DAY:
            out[slot] = _coerce_non_negative_float(p.get("kWh_inc", p.get("kwh_inc", 0)))
            present[slot] = True
    return (out, present) if present.any() else (None, None)


@lru_cache(maxsize=256)
def load_intraday_adjusted_with_presence(day: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    db_rows, db_present = _load_intraday_adjusted_from_db(day)
    legacy_rows, legacy_present = _load_intraday_adjusted_from_legacy(day)
    return _merge_slot_series_with_presence(
        "Intraday adjusted",
        day,
        db_rows,
        db_present,
        legacy_rows,
        legacy_present,
        MIN_DAYAHEAD_SOLAR_SLOTS,
    )


@lru_cache(maxsize=256)
def load_intraday_adjusted(day: str) -> np.ndarray | None:
    values, _ = load_intraday_adjusted_with_presence(day)
    return values


# ============================================================================
# ERROR MEMORY  (rolling bias correction)
# ============================================================================

def _compute_error_memory_legacy(today: date) -> np.ndarray:
    weight_vectors = []
    errors = []
    source_mismatch_penalty = 0.2
    try:
        start_date = (today - timedelta(days=ERR_MEMORY_DAYS)).isoformat()
        end_date = (today - timedelta(days=1)).isoformat()
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            cols = {
                str(row[1] or "")
                for row in conn.execute("PRAGMA table_info(forecast_error_compare_slot)")
            }
            err_col = "signed_error_kwh" if "signed_error_kwh" in cols else ("error_kwh" if "error_kwh" in cols else "")
            if not err_col:
                return np.zeros(SLOTS_DAY, dtype=float)
            provider_expr = "provider_used" if "provider_used" in cols else "'unknown'"
            query = (
                "SELECT target_date, slot, "
                + provider_expr
                + " AS provider_used, "
                + err_col
                + " AS error_val FROM forecast_error_compare_slot "
                + "WHERE target_date >= ? AND target_date <= ?"
            )
            history: dict[str, dict[int, tuple[str, float]]] = {}
            for row in conn.execute(query, (start_date, end_date)):
                day_str = str(row[0] or "")
                slot = int(row[1] or -1)
                if slot < 0 or slot >= SLOTS_DAY:
                    continue
                err_val = row[3]
                if err_val is None:
                    continue
                history.setdefault(day_str, {})[slot] = (
                    str(row[2] or "unknown"),
                    float(err_val),
                )

        for d in range(1, ERR_MEMORY_DAYS + 1):
            day = (today - timedelta(days=d)).isoformat()
            day_history = history.get(day)
            if not day_history:
                continue
            _, constraint_meta = build_operational_constraint_mask(day)
            exclude_arr = np.asarray(constraint_meta.get("operational_mask"), dtype=bool)
            err = np.zeros(SLOTS_DAY, dtype=float)
            weight_vec = np.zeros(SLOTS_DAY, dtype=float)
            for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
                if exclude_arr[slot] or slot not in day_history:
                    continue
                provider, slot_err = day_history[slot]
                err[slot] = float(np.clip(slot_err, -200.0, 200.0))
                w = ERR_MEMORY_DECAY ** (d - 1)
                if provider not in ("learning", "ml_local"):
                    w *= source_mismatch_penalty
                weight_vec[slot] = w
            if np.sum(weight_vec) <= 0:
                continue
            errors.append(err)
            weight_vectors.append(weight_vec)
    except Exception as e:
        log.warning("Legacy error-memory fallback failed: %s", e)

    if not errors:
        return np.zeros(SLOTS_DAY, dtype=float)

    weighted_sum = np.sum(np.stack([w * e for w, e in zip(weight_vectors, errors)]), axis=0)
    weight_sum = np.sum(np.stack(weight_vectors), axis=0)
    mem_err = np.divide(
        weighted_sum,
        np.maximum(weight_sum, 1e-9),
        out=np.zeros(SLOTS_DAY, dtype=float),
        where=weight_sum > 0,
    )
    mem_err = _rolling_mean(mem_err, 7, center=True)
    mem_err[weight_sum <= 0] = 0.0
    mem_err[:SOLAR_START_SLOT] = 0.0
    mem_err[SOLAR_END_SLOT:] = 0.0
    return mem_err


def compute_error_memory(today: date, w_today_5: pd.DataFrame) -> np.ndarray:
    """
    Compute weighted historical bias from saved comparison rows.

    Preferred source:
      - forecast_error_compare_daily (eligible rows only)
      - forecast_error_compare_slot (usable_for_error_memory=1)
    Fallback source:
      - legacy slot-only table reading.
    """
    del w_today_5  # explicit: current implementation uses persisted compare rows only.
    weight_vectors = []
    errors = []
    try:
        start_date = (today - timedelta(days=max(ERR_MEMORY_DAYS * 4, 30))).isoformat()
        end_date = (today - timedelta(days=1)).isoformat()
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            daily_rows = conn.execute(
                """
                SELECT target_date, COALESCE(run_audit_id, 0), COALESCE(forecast_variant, ''), COALESCE(provider_expected, '')
                  FROM forecast_error_compare_daily
                 WHERE target_date >= ? AND target_date <= ?
                   AND include_in_error_memory = 1
                   AND comparison_quality = 'eligible'
                 ORDER BY target_date DESC
                 LIMIT ?
                """,
                (start_date, end_date, max(ERR_MEMORY_DAYS * 4, 60))
            ).fetchall()

            if not daily_rows:
                return _compute_error_memory_legacy(today)

            selected_days = 0
            for day_row in daily_rows:
                day_s = str(day_row[0] or "")
                if not day_s:
                    continue
                try:
                    days_ago = (today - datetime.strptime(day_s, "%Y-%m-%d").date()).days
                except Exception:
                    continue
                if days_ago < 1:
                    continue

                run_audit_id = int(day_row[1] or 0)
                forecast_variant = str(day_row[2] or "")
                provider_expected = str(day_row[3] or "")
                source_weight = _memory_source_weight(forecast_variant, provider_expected)
                if source_weight <= 0:
                    continue

                _, constraint_meta = build_operational_constraint_mask(day_s)
                exclude_arr = np.asarray(constraint_meta.get("operational_mask"), dtype=bool)
                err = np.zeros(SLOTS_DAY, dtype=float)
                weight_vec = np.zeros(SLOTS_DAY, dtype=float)

                for slot_row in conn.execute(
                    """
                    SELECT slot, signed_error_kwh, support_weight, usable_for_error_memory
                      FROM forecast_error_compare_slot
                     WHERE target_date = ? AND run_audit_id = ?
                    """,
                    (day_s, run_audit_id),
                ):
                    slot = int(slot_row[0] or -1)
                    if slot < SOLAR_START_SLOT or slot >= SOLAR_END_SLOT:
                        continue
                    if exclude_arr[slot]:
                        continue
                    if int(slot_row[3] or 0) != 1:
                        continue
                    signed_err = slot_row[1]
                    if signed_err is None:
                        continue
                    support_weight = float(slot_row[2] or 1.0)
                    support_weight = float(np.clip(support_weight, 0.0, 1.0))
                    base_w = ERR_MEMORY_DECAY ** (days_ago - 1)
                    weight_vec[slot] = base_w * source_weight * support_weight
                    err[slot] = float(np.clip(float(signed_err), -200.0, 200.0))

                if np.sum(weight_vec) <= 0:
                    continue
                errors.append(err)
                weight_vectors.append(weight_vec)
                selected_days += 1
                if selected_days >= ERR_MEMORY_DAYS:
                    break

    except Exception as e:
        log.warning("Failed to compute persisted error memory: %s", e)
        return _compute_error_memory_legacy(today)

    if not errors:
        return _compute_error_memory_legacy(today)

    weighted_sum = np.sum(np.stack([w * e for w, e in zip(weight_vectors, errors)]), axis=0)
    weight_sum = np.sum(np.stack(weight_vectors), axis=0)
    mem_err = np.divide(
        weighted_sum,
        np.maximum(weight_sum, 1e-9),
        out=np.zeros(SLOTS_DAY, dtype=float),
        where=weight_sum > 0,
    )
    mem_err = _rolling_mean(mem_err, 7, center=True)
    mem_err[weight_sum <= 0] = 0.0
    mem_err[:SOLAR_START_SLOT] = 0.0
    mem_err[SOLAR_END_SLOT:] = 0.0
    return mem_err


def collect_history_days(
    today: date,
    lookback_days: int,
    solcast_reliability: dict | None = None,
) -> list[dict]:
    """
    Build the historical basis for training and intra-hour hardening.

    Historical samples always pair actual generation with archive weather for
    that same day. This keeps plant-response learning separate from any
    forecast-provider bias.
    """
    history = []
    solar_slot_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )
    log.info(
        "Collecting history basis from last %d days using actual archived weather + actual generation",
        lookback_days,
    )

    for days_ago in range(1, lookback_days + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        actual, actual_present = load_actual_loss_adjusted_with_presence(day)
        wdata = fetch_weather(day, source="archive")
        snapshot = load_solcast_snapshot(day)
        if actual is None or actual_present is None or wdata is None:
            log.debug("  Skip %s - missing history basis", day)
            continue

        w5 = interpolate_5min(wdata, day)
        ok_w5, reason_w5 = validate_weather_5min(day, w5)
        if not ok_w5:
            log.warning("  Reject %s - weather quality failed: %s", day, reason_w5)
            continue

        baseline = physics_baseline(day, w5)
        solcast_prior = solcast_prior_from_snapshot(day, w5, snapshot, solcast_reliability)
        history_baseline, hybrid_meta = blend_physics_with_solcast(baseline, solcast_prior)
        feature_frame = build_features(w5, day, solcast_prior)
        slot_weather_buckets = classify_slot_weather_buckets(w5, day)
        _, constraint_meta = build_operational_constraint_mask(day)
        actual_present_arr = np.asarray(actual_present, dtype=bool).copy()
        operational_mask = np.asarray(constraint_meta.get("operational_mask"), dtype=bool).copy()
        cap_dispatch_mask = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool).copy()
        manual_constraint_mask = np.asarray(constraint_meta.get("manual_constraint_mask"), dtype=bool).copy()
        rad_arr = pd.to_numeric(feature_frame["rad"], errors="coerce").fillna(0.0).values

        actual_effective = np.asarray(actual, dtype=float).copy()
        actual_effective[cap_dispatch_mask] = history_baseline[cap_dispatch_mask]
        actual_eval = actual_effective.copy()
        fill_mask = (~actual_present_arr) | operational_mask
        actual_eval[fill_mask] = history_baseline[fill_mask]
        residual = np.clip(actual_effective - history_baseline, -500.0, 500.0)
        curtailed = curtailed_mask(actual_effective, history_baseline)

        stats = analyse_weather_day(day, w5, actual_eval)
        bad, reason = training_day_rejection(stats, actual_eval, history_baseline)
        if bad:
            log.warning("  Reject %s - %s", day, reason)
            continue

        usable_mask = (
            solar_slot_mask
            & actual_present_arr
            & (~manual_constraint_mask)
            & (history_baseline > 0.0)
            & (rad_arr >= RAD_MIN_WM2)
        )
        usable_slots = int(np.count_nonzero(usable_mask))
        if usable_slots < MIN_SAMPLES:
            log.warning("  Reject %s - too few usable unconstrained slots (%d)", day, usable_slots)
            continue

        training_usable_mask = usable_mask & (~curtailed)
        training_feature_frame = feature_frame.loc[training_usable_mask, FEATURE_COLS].reset_index(drop=True)
        training_residual = residual[training_usable_mask]
        training_class_scale = _error_class_normalizer(
            training_residual,
            baseline_kwh=np.asarray(history_baseline, dtype=float)[training_usable_mask],
        )

        history.append({
            "day": day,
            "days_ago": days_ago,
            "actual": np.asarray(actual, dtype=float),
            "actual_present": actual_present_arr,
            "actual_effective": actual_effective,
            "weather": w5,
            "baseline": np.asarray(baseline, dtype=float),
            "hybrid_baseline": np.asarray(history_baseline, dtype=float),
            "residual": residual,
            "feature_frame": feature_frame,
            "slot_weather_buckets": slot_weather_buckets,
            "training_usable_mask": training_usable_mask,
            "training_feature_frame": training_feature_frame,
            "training_residual": training_residual,
            "training_class_scale": training_class_scale,
            "training_slot_count": int(np.count_nonzero(training_usable_mask)),
            "stats": stats,
            "season": _season_bucket_from_day(day),
            "day_regime": classify_day_regime(stats),
            "first_active_slot": _find_first_active_slot(actual_effective),
            "last_active_slot": _find_last_active_slot(actual_effective),
            "solcast_snapshot": snapshot,
            "solcast_prior": solcast_prior,
            "used_solcast": bool(hybrid_meta.get("used_solcast")),
            "operational_mask": operational_mask,
            "cap_dispatch_mask": cap_dispatch_mask,
            "manual_constraint_mask": manual_constraint_mask,
            "commanded_off_nodes": np.asarray(constraint_meta.get("commanded_off_nodes"), dtype=int).copy(),
            "cap_dispatched_off_nodes": np.asarray(constraint_meta.get("cap_dispatched_off_nodes"), dtype=int).copy(),
            "manual_off_nodes": np.asarray(constraint_meta.get("manual_off_nodes"), dtype=int).copy(),
            "operational_slot_count": int(constraint_meta.get("operational_slot_count", 0)),
            "cap_dispatch_slot_count": int(constraint_meta.get("cap_dispatch_slot_count", 0)),
            "manual_constraint_slot_count": int(constraint_meta.get("manual_constraint_slot_count", 0)),
            "event_count": int(constraint_meta.get("event_count", 0)),
            "usable_slots": usable_slots,
        })
        log.info(
            "  History %s  sky=%-14s  usable=%d  manual_slots=%d  cap_slots=%d  solcast=%s",
            day,
            stats["sky_class"],
            usable_slots,
            int(constraint_meta.get("manual_constraint_slot_count", 0)),
            int(constraint_meta.get("cap_dispatch_slot_count", 0)),
            "yes" if hybrid_meta.get("used_solcast") else "no",
        )

    log.info("History basis accepted: %d day(s)", len(history))
    return history


def build_forecast_artifacts(history_days: list[dict]) -> dict:
    """Build derived artifacts for shape correction and activity gating."""
    shape_records = []
    activity_records = []
    threshold = activity_threshold_kwh()

    for sample in history_days:
        day = str(sample["day"])
        actual = np.asarray(sample.get("actual_effective", sample["actual"]), dtype=float)
        actual_present = np.asarray(sample.get("actual_present"), dtype=bool) if sample.get("actual_present") is not None else np.ones(SLOTS_DAY, dtype=bool)
        manual_constraint_mask = np.asarray(sample.get("manual_constraint_mask"), dtype=bool) if sample.get("manual_constraint_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
        w5 = sample["weather"]
        stats = sample["stats"]
        first_slot = sample.get("first_active_slot")
        last_slot = sample.get("last_active_slot")
        csi_arr = clear_sky_radiation(day, pd.to_numeric(w5["rh"], errors="coerce").fillna(0.0).values)

        if (
            first_slot is not None
            and last_slot is not None
            and not np.any(manual_constraint_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])
        ):
            activity_records.append({
                "day": day,
                "days_ago": int(sample["days_ago"]),
                "season": sample.get("season") or _season_bucket_from_day(day),
                "sky_class": stats.get("sky_class"),
                "rainy": bool(stats.get("rainy")),
                "cloud_mean": float(stats.get("cloud_mean", 0.0)),
                "rh_mean": float(stats.get("rh_mean", 0.0)),
                "vol_index": float(stats.get("vol_index", 0.0)),
                "first_slot": int(first_slot),
                "last_slot": int(last_slot),
            })

        for hour in range(SOLAR_START_H, SOLAR_END_H):
            start, end = _solar_hour_bounds(hour)
            usable_hour_mask = actual_present[start:end] & (~manual_constraint_mask[start:end])
            if int(np.count_nonzero(usable_hour_mask)) < max(4, (60 // SLOT_MIN) // 2):
                continue
            hour_total = float(actual[start:end].sum())
            if hour_total < threshold * 1.5:
                continue

            meta = hour_weather_signature(day, w5, hour, csi_arr)
            shape_records.append({
                "day": day,
                "days_ago": int(sample["days_ago"]),
                "hour": int(hour),
                "season": meta["season"],
                "regime": meta["regime"],
                "cloud_mean": float(meta["cloud_mean"]),
                "rh_mean": float(meta["rh_mean"]),
                "kt_mean": float(meta["kt_mean"]),
                "vol_index": float(meta["vol_index"]),
                "profile": _normalize_profile(actual[start:end]).astype(np.float32),
            })

    return {
        "created_ts": int(time.time()),
        "training_basis": "actual archived weather + cleaned actual generation",
        "lookback_days": int(SHAPE_LOOKBACK_DAYS),
        "history_days": int(len(history_days)),
        "shape_records": shape_records,
        "activity_records": activity_records,
    }


def save_forecast_artifacts(artifact: dict) -> bool:
    try:
        ARTIFACT_FILE.parent.mkdir(parents=True, exist_ok=True)
        dump(artifact, ARTIFACT_FILE)
        return True
    except Exception as e:
        log.error("Artifact save failed %s: %s", ARTIFACT_FILE, e)
        return False


def load_forecast_artifacts(today: date | None = None, allow_build: bool = False) -> dict | None:
    if ARTIFACT_FILE.exists():
        try:
            data = load(ARTIFACT_FILE)
            if isinstance(data, dict):
                return data
        except Exception as e:
            log.warning("Artifact load failed %s: %s", ARTIFACT_FILE, e)

    if allow_build and today is not None:
        solcast_reliability = build_solcast_reliability_artifact(today)
        history_days = collect_history_days(
            today,
            SHAPE_LOOKBACK_DAYS,
            solcast_reliability=solcast_reliability,
        )
        if not history_days:
            return None
        artifact = build_forecast_artifacts(history_days)
        save_forecast_artifacts(artifact)
        return artifact

    return None


def _weather_frame_to_records(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []
    cols = [
        "time",
        "rad",
        "rad_direct",
        "rad_diffuse",
        "cloud",
        "cloud_low",
        "cloud_mid",
        "cloud_high",
        "temp",
        "rh",
        "wind",
        "precip",
        "cape",
    ]
    frame = df.copy()
    if "time" in frame.columns:
        frame["time"] = pd.to_datetime(frame["time"], errors="coerce")
    def safe_num(value) -> float:
        try:
            num = float(pd.to_numeric(value, errors="coerce"))
        except Exception:
            return 0.0
        return num if math.isfinite(num) else 0.0
    out = []
    for _, row in frame.iterrows():
        time_value = row.get("time")
        if pd.isna(time_value):
            continue
        rec = {"time": pd.Timestamp(time_value).strftime("%Y-%m-%d %H:%M:%S")}
        for col in cols[1:]:
            rec[col] = round(safe_num(row.get(col)), 6)
        out.append(rec)
    return out


def _weather_records_to_frame(records: list[dict], day: str) -> pd.DataFrame:
    if not isinstance(records, list) or not records:
        return pd.DataFrame()
    rows = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        rows.append({
            "time": pd.to_datetime(rec.get("time"), errors="coerce"),
            "rad": pd.to_numeric(rec.get("rad"), errors="coerce"),
            "rad_direct": pd.to_numeric(rec.get("rad_direct"), errors="coerce"),
            "rad_diffuse": pd.to_numeric(rec.get("rad_diffuse"), errors="coerce"),
            "cloud": pd.to_numeric(rec.get("cloud"), errors="coerce"),
            "cloud_low": pd.to_numeric(rec.get("cloud_low"), errors="coerce"),
            "cloud_mid": pd.to_numeric(rec.get("cloud_mid"), errors="coerce"),
            "cloud_high": pd.to_numeric(rec.get("cloud_high"), errors="coerce"),
            "temp": pd.to_numeric(rec.get("temp"), errors="coerce"),
            "rh": pd.to_numeric(rec.get("rh"), errors="coerce"),
            "wind": pd.to_numeric(rec.get("wind"), errors="coerce"),
            "precip": pd.to_numeric(rec.get("precip"), errors="coerce"),
            "cape": pd.to_numeric(rec.get("cape"), errors="coerce"),
        })
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    return _slice_weather_day(frame, day)


def forecast_snapshot_path(day: str) -> Path:
    return FORECAST_SNAPSHOT_DIR / f"{str(day).strip()}.json"


def weather_day_signature(day: str, hourly_df: pd.DataFrame) -> dict:
    w5 = interpolate_5min(hourly_df, day)
    stats = analyse_weather_day(day, w5)
    return {
        "day": str(day),
        "season": _season_bucket_from_day(day),
        "day_regime": classify_day_regime(stats),
        "sky_class": stats.get("sky_class"),
        "cloud_mean": float(stats.get("cloud_mean", 0.0)),
        "rad_peak": float(stats.get("rad_peak", 0.0)),
        "vol_index": float(stats.get("vol_index", 0.0)),
        "rh_mean": float(stats.get("rh_mean", 0.0)),
        "rainy": bool(stats.get("rainy", False)),
        "convective": bool(stats.get("convective", False)),
    }


def save_forecast_weather_snapshot(
    day: str,
    raw_hourly: pd.DataFrame,
    applied_hourly: pd.DataFrame | None = None,
    provider: str = "open-meteo",
    meta: dict | None = None,
) -> bool:
    payload = {
        "day": str(day),
        "provider": str(provider or "open-meteo"),
        "saved_ts": int(time.time()),
        "raw_hourly": _weather_frame_to_records(raw_hourly),
        "applied_hourly": _weather_frame_to_records(applied_hourly if applied_hourly is not None else raw_hourly),
        "signature": weather_day_signature(day, raw_hourly),
        "applied_signature": weather_day_signature(day, applied_hourly if applied_hourly is not None else raw_hourly),
        "meta": dict(meta or {}),
    }
    return _save_json(forecast_snapshot_path(day), payload)


def load_forecast_weather_snapshot(day: str) -> dict | None:
    payload = _load_json(forecast_snapshot_path(day))
    return payload if isinstance(payload, dict) and payload else None


def update_forecast_weather_snapshot_meta(day: str, updates: dict | None) -> bool:
    if not updates:
        return False
    payload = load_forecast_weather_snapshot(day)
    if not payload or not isinstance(payload, dict):
        return False
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    meta.update(dict(updates))
    payload["meta"] = meta
    return _save_json(forecast_snapshot_path(day), payload)


def _weather_bias_frame_5min(df: pd.DataFrame, day: str) -> pd.DataFrame:
    frame = _slice_weather_day(df, day)
    if frame.empty:
        return pd.DataFrame()
    w5 = interpolate_5min(frame, day)
    ok, reason = validate_weather_5min(day, w5)
    if not ok:
        log.warning("Weather-bias 5-minute frame invalid [%s]: %s", day, reason)
        return pd.DataFrame()
    return w5


def _weather_bias_slot_series_from_record(record: dict, key: str, default: float = 0.0) -> np.ndarray:
    raw = np.asarray(record.get(key, []), dtype=float).reshape(-1)
    if raw.size == SOLAR_SLOTS:
        return raw.astype(float)
    if raw.size == SLOTS_DAY:
        return raw[SOLAR_START_SLOT:SOLAR_END_SLOT].astype(float)

    legacy_hour_points = SOLAR_END_H - SOLAR_START_H
    if raw.size == legacy_hour_points:
        return np.repeat(raw.astype(float), 60 // SLOT_MIN)[:SOLAR_SLOTS]

    if raw.size <= 0:
        return np.full(SOLAR_SLOTS, default, dtype=float)

    src_idx = np.linspace(0.0, 1.0, num=raw.size)
    dst_idx = np.linspace(0.0, 1.0, num=SOLAR_SLOTS)
    return np.interp(dst_idx, src_idx, raw.astype(float)).astype(float)


def build_weather_bias_artifact(today: date, lookback_days: int = WEATHER_BIAS_LOOKBACK_DAYS) -> dict:
    records = []
    for days_ago in range(1, lookback_days + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        snap = load_forecast_weather_snapshot(day)
        if not snap:
            continue
        raw_hourly = _weather_records_to_frame(list(snap.get("raw_hourly") or []), day)
        if raw_hourly.empty:
            continue
        actual_hourly = fetch_weather(day, source="archive")
        if actual_hourly is None or actual_hourly.empty:
            continue
        raw_w5 = _weather_bias_frame_5min(raw_hourly, day)
        actual_w5 = _weather_bias_frame_5min(actual_hourly, day)
        if raw_w5.empty or actual_w5.empty:
            continue

        raw_sig = snap.get("signature") if isinstance(snap.get("signature"), dict) else weather_day_signature(day, raw_hourly)
        actual_sig = weather_day_signature(day, actual_hourly)
        solar_slice = slice(SOLAR_START_SLOT, SOLAR_END_SLOT)
        forecast_rad = np.clip(
            pd.to_numeric(raw_w5["rad"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            None,
        )
        actual_rad = np.clip(
            pd.to_numeric(actual_w5["rad"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            None,
        )
        forecast_cloud = np.clip(
            pd.to_numeric(raw_w5["cloud"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            100.0,
        )
        actual_cloud = np.clip(
            pd.to_numeric(actual_w5["cloud"], errors="coerce").fillna(0.0).values[solar_slice],
            0.0,
            100.0,
        )

        rad_ratio = np.ones_like(forecast_rad, dtype=float)
        for idx, (f_rad, a_rad) in enumerate(zip(forecast_rad, actual_rad)):
            if f_rad < 30.0 and a_rad < 30.0:
                rad_ratio[idx] = 1.0
            elif f_rad < 30.0:
                rad_ratio[idx] = float(np.clip(1.0 + ((a_rad - f_rad) / 180.0), 0.80, 1.35))
            else:
                rad_ratio[idx] = float(np.clip(a_rad / max(f_rad, 1.0), 0.55, 1.55))

        cloud_delta = np.clip(actual_cloud - forecast_cloud, -38.0, 38.0)
        mean_ratio_error = float(np.mean(np.abs(rad_ratio - 1.0))) if rad_ratio.size else 0.0
        mean_cloud_error = float(np.mean(np.abs(cloud_delta))) if cloud_delta.size else 0.0
        confidence = float(np.clip(1.0 - 0.55 * mean_ratio_error - 0.006 * mean_cloud_error, 0.55, 1.0))

        forecast_start = next((idx for idx, value in enumerate(forecast_rad) if value >= STARTUP_RAD_WM2), None)
        actual_start = next((idx for idx, value in enumerate(actual_rad) if value >= STARTUP_RAD_WM2), None)
        morning_shift_slots = 0.0
        if forecast_start is not None and actual_start is not None:
            morning_shift_slots = float(actual_start - forecast_start)

        records.append({
            "day": day,
            "days_ago": int(days_ago),
            "season": raw_sig.get("season") or _season_bucket_from_day(day),
            "forecast_regime": raw_sig.get("day_regime") or classify_day_regime(raw_sig),
            "actual_regime": actual_sig.get("day_regime") or classify_day_regime(actual_sig),
            "cloud_mean": float(raw_sig.get("cloud_mean", 0.0)),
            "rad_peak": float(raw_sig.get("rad_peak", 0.0)),
            "vol_index": float(raw_sig.get("vol_index", 0.0)),
            "rh_mean": float(raw_sig.get("rh_mean", 0.0)),
            "confidence": confidence,
            "morning_shift_slots": float(np.clip(morning_shift_slots, -24.0, 24.0)),
            "rad_ratio": rad_ratio.astype(np.float32),
            "cloud_delta": cloud_delta.astype(np.float32),
        })

    return {
        "created_ts": int(time.time()),
        "lookback_days": int(lookback_days),
        "resolution_minutes": int(SLOT_MIN),
        "slot_start": int(SOLAR_START_SLOT),
        "slot_end": int(SOLAR_END_SLOT),
        "slot_count": int(SOLAR_SLOTS),
        "record_count": int(len(records)),
        "records": records,
    }


def save_weather_bias_artifact(artifact: dict) -> bool:
    try:
        WEATHER_BIAS_FILE.parent.mkdir(parents=True, exist_ok=True)
        dump(artifact, WEATHER_BIAS_FILE)
        return True
    except Exception as e:
        log.error("Weather-bias artifact save failed %s: %s", WEATHER_BIAS_FILE, e)
        return False


def load_weather_bias_artifact(today: date | None = None, allow_build: bool = False) -> dict | None:
    if WEATHER_BIAS_FILE.exists():
        try:
            data = load(WEATHER_BIAS_FILE)
            if isinstance(data, dict):
                if _weather_bias_artifact_needs_upgrade(data):
                    if allow_build and today is not None:
                        log.info(
                            "Weather-bias artifact uses legacy resolution; rebuilding at %d-minute solar slots.",
                            SLOT_MIN,
                        )
                        artifact = build_weather_bias_artifact(today)
                        save_weather_bias_artifact(artifact)
                        return artifact
                    log.warning(
                        "Weather-bias artifact uses legacy hourly resolution; compatibility upsampling will be used until rebuilt."
                    )
                return data
        except Exception as e:
            log.warning("Weather-bias artifact load failed %s: %s", WEATHER_BIAS_FILE, e)

    if allow_build and today is not None:
        artifact = build_weather_bias_artifact(today)
        save_weather_bias_artifact(artifact)
        return artifact

    return None


def _weather_bias_artifact_needs_upgrade(artifact: dict | None) -> bool:
    if not isinstance(artifact, dict):
        return True
    if int(artifact.get("resolution_minutes", 0) or 0) != int(SLOT_MIN):
        return True
    if int(artifact.get("slot_count", 0) or 0) != int(SOLAR_SLOTS):
        return True

    for record in list(artifact.get("records") or []):
        rad_ratio = np.asarray(record.get("rad_ratio", []), dtype=float).reshape(-1)
        cloud_delta = np.asarray(record.get("cloud_delta", []), dtype=float).reshape(-1)
        if rad_ratio.size != SOLAR_SLOTS or cloud_delta.size != SOLAR_SLOTS:
            return True
    return False


def _weather_bias_similarity_score(record: dict, target: dict) -> float:
    score = 0.0
    if record.get("season") != target.get("season"):
        score += 0.55
    if record.get("forecast_regime") != target.get("day_regime"):
        score += 1.05
    score += abs(float(record.get("cloud_mean", 0.0)) - float(target.get("cloud_mean", 0.0))) / 26.0
    score += abs(float(record.get("rad_peak", 0.0)) - float(target.get("rad_peak", 0.0))) / 420.0
    score += abs(float(record.get("vol_index", 0.0)) - float(target.get("vol_index", 0.0))) / 0.18
    score += abs(float(record.get("rh_mean", 0.0)) - float(target.get("rh_mean", 0.0))) / 22.0
    score += min(float(record.get("days_ago", WEATHER_BIAS_LOOKBACK_DAYS)), float(WEATHER_BIAS_LOOKBACK_DAYS)) / max(float(WEATHER_BIAS_LOOKBACK_DAYS), 1.0) * 0.24
    return score


def apply_weather_bias_adjustment(
    hourly_df: pd.DataFrame,
    day: str,
    artifact: dict | None,
) -> tuple[pd.DataFrame, dict]:
    frame = _slice_weather_day(hourly_df, day)
    default_meta = {
        "matches": 0,
        "avg_score": None,
        "day_regime": None,
        "regime_confidence": 1.0,
        "morning_shift_slots": 0.0,
        "mean_rad_factor": 1.0,
    }
    records = list((artifact or {}).get("records") or [])
    if frame.empty or not records:
        if not frame.empty:
            sig = weather_day_signature(day, frame)
            default_meta["day_regime"] = sig.get("day_regime")
        return frame if not frame.empty else hourly_df.copy(), default_meta

    target = weather_day_signature(day, frame)
    exact = [
        record for record in records
        if record.get("season") == target.get("season") and record.get("forecast_regime") == target.get("day_regime")
    ]
    pool = exact if len(exact) >= WEATHER_BIAS_MIN_MATCHES else records
    scored = []
    for record in pool:
        score = _weather_bias_similarity_score(record, target)
        if math.isfinite(score):
            scored.append((score, record))
    if not scored:
        return frame.copy(), {
            **default_meta,
            "day_regime": target.get("day_regime"),
        }

    scored.sort(key=lambda item: item[0])
    top = scored[:WEATHER_BIAS_TOP_K]
    weights = np.array([1.0 / ((0.25 + score) ** 2) for score, _ in top], dtype=float)
    rad_ratio = np.average(
        np.array(
            [_weather_bias_slot_series_from_record(record, "rad_ratio", 1.0) for _, record in top],
            dtype=float,
        ),
        axis=0,
        weights=weights,
    )
    cloud_delta = np.average(
        np.array(
            [_weather_bias_slot_series_from_record(record, "cloud_delta", 0.0) for _, record in top],
            dtype=float,
        ),
        axis=0,
        weights=weights,
    )
    confidence = float(np.clip(np.average([float(record.get("confidence", 1.0)) for _, record in top], weights=weights), 0.55, 1.0))
    morning_shift = float(np.average([float(record.get("morning_shift_slots", 0.0)) for _, record in top], weights=weights))

    adjusted = _weather_bias_frame_5min(frame, day)
    if adjusted.empty:
        return frame.copy(), {
            **default_meta,
            "day_regime": target.get("day_regime"),
        }

    def safe_num(value) -> float:
        try:
            num = float(pd.to_numeric(value, errors="coerce"))
        except Exception:
            return 0.0
        return num if math.isfinite(num) else 0.0

    if "time" not in adjusted.columns:
        log.warning(
            "Weather-bias 5-minute frame missing time column [%s]; rebuilding synthetic 5-minute timestamps.",
            day,
        )
        adjusted = adjusted.copy()
        adjusted.insert(
            0,
            "time",
            pd.date_range(f"{day} 00:00:00", periods=len(adjusted), freq="5min"),
        )

    adjusted["time"] = pd.to_datetime(adjusted["time"], errors="coerce")
    rad_factors = []
    for idx, row in adjusted.iterrows():
        ts = pd.Timestamp(row["time"])
        slot = int((int(ts.hour) * 60 + int(ts.minute)) // SLOT_MIN)
        if slot < SOLAR_START_SLOT or slot >= SOLAR_END_SLOT:
            continue
        slot_idx = slot - SOLAR_START_SLOT
        raw_factor = 1.0 + WEATHER_BIAS_RAD_BLEND * float(rad_ratio[slot_idx] - 1.0)
        factor = float(np.clip(raw_factor, WEATHER_BIAS_FACTOR_CLIP[0], WEATHER_BIAS_FACTOR_CLIP[1]))
        rad_factors.append(factor)
        for col in ("rad", "rad_direct", "rad_diffuse"):
            adjusted.at[idx, col] = max(0.0, safe_num(row.get(col)) * factor)

        delta = float(
            np.clip(
                WEATHER_BIAS_CLOUD_BLEND * float(cloud_delta[slot_idx]),
                WEATHER_BIAS_CLOUD_DELTA_CLIP[0],
                WEATHER_BIAS_CLOUD_DELTA_CLIP[1],
            )
        )
        base_cloud = safe_num(row.get("cloud"))
        target_cloud = float(np.clip(base_cloud + delta, 0.0, 100.0))
        adjusted.at[idx, "cloud"] = target_cloud
        if base_cloud > 1.0:
            scale = target_cloud / max(base_cloud, 1.0)
            for col in ("cloud_low", "cloud_mid", "cloud_high"):
                adjusted.at[idx, col] = float(np.clip(safe_num(row.get(col)) * scale, 0.0, 100.0))
        else:
            adjusted.at[idx, "cloud_low"] = float(np.clip(safe_num(row.get("cloud_low")) + delta * 0.45, 0.0, 100.0))
            adjusted.at[idx, "cloud_mid"] = float(np.clip(safe_num(row.get("cloud_mid")) + delta * 0.35, 0.0, 100.0))
            adjusted.at[idx, "cloud_high"] = float(np.clip(safe_num(row.get("cloud_high")) + delta * 0.20, 0.0, 100.0))

    return adjusted, {
        "matches": int(len(top)),
        "avg_score": float(np.mean([score for score, _ in top])) if top else None,
        "day_regime": target.get("day_regime"),
        "regime_confidence": confidence,
        "morning_shift_slots": float(np.clip(morning_shift, -24.0, 24.0)),
        "mean_rad_factor": float(np.mean(rad_factors)) if rad_factors else 1.0,
    }


def _shape_similarity_score(record: dict, target_meta: dict) -> float:
    if int(record.get("hour", -1)) != int(target_meta.get("hour", -2)):
        return float("inf")

    score = 0.0
    if record.get("season") != target_meta.get("season"):
        score += 0.55
    if record.get("regime") != target_meta.get("regime"):
        score += 1.25
    score += abs(float(record.get("cloud_mean", 0.0)) - float(target_meta.get("cloud_mean", 0.0))) / 28.0
    score += abs(float(record.get("rh_mean", 0.0)) - float(target_meta.get("rh_mean", 0.0))) / 24.0
    score += abs(float(record.get("kt_mean", 0.0)) - float(target_meta.get("kt_mean", 0.0))) / 0.22
    score += abs(float(record.get("vol_index", 0.0)) - float(target_meta.get("vol_index", 0.0))) / 0.18
    score += min(float(record.get("days_ago", SHAPE_LOOKBACK_DAYS)), float(SHAPE_LOOKBACK_DAYS)) / max(float(SHAPE_LOOKBACK_DAYS), 1.0) * 0.30
    return score


def select_shape_profile(shape_records: list[dict], target_meta: dict, fallback_profile: np.ndarray) -> tuple[np.ndarray, int, float | None]:
    fallback = _normalize_profile(fallback_profile)
    if not shape_records:
        return fallback, 0, None

    hour_records = [r for r in shape_records if int(r.get("hour", -1)) == int(target_meta.get("hour", -2))]
    if not hour_records:
        return fallback, 0, None

    exact = [
        r for r in hour_records
        if r.get("season") == target_meta.get("season") and r.get("regime") == target_meta.get("regime")
    ]
    pool = exact if len(exact) >= SHAPE_MIN_MATCHES else hour_records

    scored = []
    for record in pool:
        score = _shape_similarity_score(record, target_meta)
        if not math.isfinite(score):
            continue
        scored.append((score, record))
    if not scored:
        return fallback, 0, None

    scored.sort(key=lambda item: item[0])
    top = scored[:SHAPE_TOP_K]
    weights = np.array([1.0 / ((0.25 + score) ** 2) for score, _ in top], dtype=float)
    profiles = np.array([np.asarray(record["profile"], dtype=float) for _, record in top], dtype=float)
    history_profile = np.average(profiles, axis=0, weights=weights)
    history_profile = _normalize_profile(history_profile)

    blend = SHAPE_BLEND_MIN + 0.08 * max(0, len(top) - 1)
    blend = min(blend, SHAPE_BLEND_MAX)
    best_score = float(top[0][0])
    if best_score > 2.0:
        blend *= 0.82
    if len(exact) >= SHAPE_MIN_MATCHES:
        blend = min(SHAPE_BLEND_MAX, blend + 0.06)

    final_profile = blend * history_profile + (1.0 - blend) * fallback
    return _normalize_profile(final_profile), len(top), best_score


def apply_hour_shape_correction(
    forecast: np.ndarray,
    day: str,
    w5: pd.DataFrame,
    artifacts: dict | None,
) -> tuple[np.ndarray, dict]:
    shape_records = list((artifacts or {}).get("shape_records") or [])
    if not shape_records:
        return np.asarray(forecast, dtype=float).copy(), {
            "hours_shaped": 0,
            "avg_matches": 0.0,
            "avg_score": None,
        }

    out = np.clip(np.asarray(forecast, dtype=float), 0.0, None).copy()
    csi_arr = clear_sky_radiation(day, pd.to_numeric(w5["rh"], errors="coerce").fillna(0.0).values)
    match_counts = []
    best_scores = []

    for hour in range(SOLAR_START_H, SOLAR_END_H):
        start, end = _solar_hour_bounds(hour)
        hour_total = float(out[start:end].sum())
        if hour_total <= 0:
            continue

        target_meta = hour_weather_signature(day, w5, hour, csi_arr)
        fallback = out[start:end]
        profile, matches, best_score = select_shape_profile(shape_records, target_meta, fallback)
        out[start:end] = hour_total * profile
        if matches > 0:
            match_counts.append(matches)
        if best_score is not None and math.isfinite(best_score):
            best_scores.append(best_score)

    return out, {
        "hours_shaped": int(sum(1 for hour in range(SOLAR_START_H, SOLAR_END_H) if out[_solar_hour_bounds(hour)[0]:_solar_hour_bounds(hour)[1]].sum() > 0)),
        "avg_matches": float(np.mean(match_counts)) if match_counts else 0.0,
        "avg_score": float(np.mean(best_scores)) if best_scores else None,
    }


def _activity_similarity_score(record: dict, target: dict) -> float:
    score = 0.0
    if record.get("season") != target.get("season"):
        score += 0.55
    if record.get("sky_class") != target.get("sky_class"):
        score += 0.95
    if bool(record.get("rainy")) != bool(target.get("rainy")):
        score += 0.75
    score += abs(float(record.get("cloud_mean", 0.0)) - float(target.get("cloud_mean", 0.0))) / 30.0
    score += abs(float(record.get("rh_mean", 0.0)) - float(target.get("rh_mean", 0.0))) / 25.0
    score += abs(float(record.get("vol_index", 0.0)) - float(target.get("vol_index", 0.0))) / 0.20
    score += min(float(record.get("days_ago", SHAPE_LOOKBACK_DAYS)), float(SHAPE_LOOKBACK_DAYS)) / max(float(SHAPE_LOOKBACK_DAYS), 1.0) * 0.20
    return score


def estimate_activity_window(
    day: str,
    w5: pd.DataFrame,
    forecast: np.ndarray,
    artifacts: dict | None,
) -> dict:
    stats = analyse_weather_day(day, w5)
    target = {
        "season": _season_bucket_from_day(day),
        "sky_class": stats.get("sky_class"),
        "rainy": bool(stats.get("rainy")),
        "cloud_mean": float(stats.get("cloud_mean", 0.0)),
        "rh_mean": float(stats.get("rh_mean", 0.0)),
        "vol_index": float(stats.get("vol_index", 0.0)),
    }
    records = list((artifacts or {}).get("activity_records") or [])

    forecast_arr = np.clip(np.asarray(forecast, dtype=float), 0.0, None)
    forecast_smooth = _rolling_mean(forecast_arr, 3, center=True)
    rad_smooth = _rolling_mean(pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values, 3, center=True)
    threshold = activity_threshold_kwh()

    weather_first = _find_first_active_slot(forecast_smooth, threshold * 0.80, sustain_slots=ACTIVITY_SUSTAIN_SLOTS)
    if weather_first is None:
        for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT - ACTIVITY_SUSTAIN_SLOTS + 1):
            if (
                float(np.mean(rad_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= STARTUP_RAD_WM2
                and float(np.mean(forecast_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= threshold * 0.55
            ):
                weather_first = slot
                break
    if weather_first is None:
        weather_first = SOLAR_START_SLOT

    weather_last = _find_last_active_slot(forecast_smooth, threshold * 0.70, sustain_slots=ACTIVITY_SUSTAIN_SLOTS)
    if weather_last is None:
        for slot in range(SOLAR_END_SLOT - ACTIVITY_SUSTAIN_SLOTS, SOLAR_START_SLOT - 1, -1):
            if (
                float(np.mean(rad_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= STOPPING_RAD_WM2
                and float(np.mean(forecast_smooth[slot:slot + ACTIVITY_SUSTAIN_SLOTS])) >= threshold * 0.40
            ):
                weather_last = slot + ACTIVITY_SUSTAIN_SLOTS - 1
                break
    if weather_last is None:
        weather_last = SOLAR_END_SLOT - 1

    hist_first = None
    hist_last = None
    match_count = 0
    if records:
        scored = sorted(
            (
                (_activity_similarity_score(record, target), record)
                for record in records
            ),
            key=lambda item: item[0],
        )[:SHAPE_TOP_K]
        if scored:
            weights = np.array([1.0 / ((0.25 + score) ** 2) for score, _ in scored], dtype=float)
            hist_first = float(np.average([record["first_slot"] for _, record in scored], weights=weights))
            hist_last = float(np.average([record["last_slot"] for _, record in scored], weights=weights))
            match_count = len(scored)

    first_slot = int(weather_first)
    last_slot = int(weather_last)
    if hist_first is not None:
        first_slot = int(round(max(weather_first, 0.45 * weather_first + 0.55 * hist_first)))
    if hist_last is not None:
        last_slot = int(round(0.60 * weather_last + 0.40 * hist_last))

    first_slot = int(np.clip(first_slot, SOLAR_START_SLOT, SOLAR_END_SLOT - 1))
    last_slot = int(np.clip(last_slot, first_slot, SOLAR_END_SLOT - 1))
    return {
        "first_slot": first_slot,
        "last_slot": last_slot,
        "weather_first": int(weather_first),
        "weather_last": int(weather_last),
        "history_matches": match_count,
    }


def _redistribute_hour_energy(hour_values: np.ndarray, allowed_mask: np.ndarray, rising: bool) -> np.ndarray:
    values = np.clip(np.asarray(hour_values, dtype=float), 0.0, None)
    allowed = np.asarray(allowed_mask, dtype=bool)
    total = float(values.sum())
    if total <= 0 or not np.any(allowed):
        return np.zeros_like(values)

    weights = values.copy()
    ramp = np.linspace(0.60, 1.25, values.size) if rising else np.linspace(1.25, 0.60, values.size)
    weights = weights * ramp
    weights[~allowed] = 0.0
    if float(weights.sum()) <= 0:
        weights = ramp
        weights[~allowed] = 0.0
    weights = _normalize_profile(weights)
    return total * weights


def apply_activity_hysteresis(
    forecast: np.ndarray,
    day: str,
    w5: pd.DataFrame,
    artifacts: dict | None,
    bias_meta: dict | None = None,
) -> tuple[np.ndarray, dict]:
    out = np.clip(np.asarray(forecast, dtype=float), 0.0, None).copy()
    if float(out.sum()) <= 0:
        return out, {"first_slot": None, "last_slot": None, "history_matches": 0}

    window = estimate_activity_window(day, w5, out, artifacts)
    first_slot = int(window["first_slot"])
    last_slot = int(window["last_slot"])
    morning_shift = float((bias_meta or {}).get("morning_shift_slots", 0.0) or 0.0)
    if abs(morning_shift) > 0.01:
        shift = int(round(np.clip(morning_shift * WEATHER_BIAS_SHIFT_BLEND, -8.0, 8.0)))
        first_slot = int(np.clip(first_slot + shift, SOLAR_START_SLOT, SOLAR_END_SLOT - 1))
        last_slot = max(first_slot, last_slot)
        window["bias_shift_slots"] = shift
    else:
        window["bias_shift_slots"] = 0
    first_hour = first_slot // (60 // SLOT_MIN)
    last_hour = last_slot // (60 // SLOT_MIN)

    out[:first_hour * (60 // SLOT_MIN)] = 0.0
    out[(last_hour + 1) * (60 // SLOT_MIN):] = 0.0

    if first_hour == last_hour:
        start, end = _solar_hour_bounds(first_hour)
        slots = np.arange(start, end)
        allowed = (slots >= first_slot) & (slots <= last_slot)
        out[start:end] = _redistribute_hour_energy(out[start:end], allowed, rising=True)
    else:
        start, end = _solar_hour_bounds(first_hour)
        out[start:end] = _redistribute_hour_energy(out[start:end], np.arange(start, end) >= first_slot, rising=True)
        start, end = _solar_hour_bounds(last_hour)
        out[start:end] = _redistribute_hour_energy(out[start:end], np.arange(start, end) <= last_slot, rising=False)

    out[:first_slot] = 0.0
    out[last_slot + 1:] = 0.0
    return out, window


def apply_block_staging(forecast: np.ndarray, w5: pd.DataFrame) -> tuple[np.ndarray, dict]:
    """
    Add conservative modular pickup at low power while preserving hourly totals.

    This does not fully quantize the plant. It only nudges low-power periods
    toward node-like staging so dawn and dusk do not stay perfectly smooth.
    """
    out = np.clip(np.asarray(forecast, dtype=float), 0.0, None)
    staged = out.copy()
    node_count = max(1, plant_node_count())
    node_step = max(node_slot_kwh(), 0.1)
    stage_limit = slot_cap_kwh(True) * LOW_POWER_STAGE_FRACTION
    threshold = activity_threshold_kwh()
    if stage_limit <= 0:
        return out.copy(), {"node_step_kwh": node_step, "staged_slots": 0}

    rad = _rolling_mean(pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values, 3, center=True)
    active_nodes = 0
    staged_slots = 0

    for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
        value = float(out[slot])
        if value <= 0:
            active_nodes = 0
            staged[slot] = 0.0
            continue
        if value > stage_limit:
            active_nodes = min(node_count, max(active_nodes, int(round(value / node_step))))
            staged[slot] = value
            continue

        desired_nodes = int(np.clip(round(value / node_step), 0, node_count))
        if value >= threshold and desired_nodes < 1:
            desired_nodes = 1

        if desired_nodes > active_nodes:
            active_nodes = desired_nodes
        elif desired_nodes < active_nodes - 1:
            active_nodes = desired_nodes
        elif desired_nodes == 0 and value < threshold * 0.85 and rad[slot] < STARTUP_RAD_WM2 * 0.60:
            active_nodes = 0

        staged_value = active_nodes * node_step
        blend = STAGING_BLEND_MAX * np.clip(1.0 - (value / max(stage_limit, 1e-6)), 0.0, 1.0)
        staged[slot] = (1.0 - blend) * value + blend * staged_value
        staged_slots += 1

    for hour in range(SOLAR_START_H, SOLAR_END_H):
        start, end = _solar_hour_bounds(hour)
        orig_total = float(out[start:end].sum())
        new_total = float(staged[start:end].sum())
        if orig_total > 0 and new_total > 0:
            staged[start:end] *= orig_total / new_total

    staged[:SOLAR_START_SLOT] = 0.0
    staged[SOLAR_END_SLOT:] = 0.0
    return staged, {
        "node_step_kwh": float(node_step),
        "staged_slots": int(staged_slots),
    }


# ============================================================================
# MODEL TRAINING
# ============================================================================

def collect_training_data(today: date) -> tuple[pd.DataFrame, np.ndarray] | tuple[None, None]:
    """
    Collect and validate training data from the last N_TRAIN_DAYS days.

    Each day is:
      1. Loaded from weather cache + actual generation
      2. Analysed for anomalies (rejected if bad)
      3. Features built
      4. Weighted by recency

    Returns (X_train, y_train) or (None, None) if insufficient data.
    """
    X_parts = []
    y_parts = []
    valid_days = 0

    log.info("Collecting training data from last %d days...", N_TRAIN_DAYS)

    for d in range(1, N_TRAIN_DAYS + 1):
        day = (today - timedelta(days=d)).isoformat()
        actual, actual_present = load_actual_loss_adjusted_with_presence(day)
        wdata = fetch_weather(day, source="archive")

        if actual is None or actual_present is None or wdata is None:
            log.debug("  Skip %s - missing data", day)
            continue

        w5 = interpolate_5min(wdata, day)
        ok_w5, reason_w5 = validate_weather_5min(day, w5)
        if not ok_w5:
            log.warning("  Reject %s - weather quality failed: %s", day, reason_w5)
            continue
        base = physics_baseline(day, w5)
        _, constraint_meta = build_operational_constraint_mask(day)
        actual_present_arr = np.asarray(actual_present, dtype=bool)
        operational_mask = np.asarray(constraint_meta.get("operational_mask"), dtype=bool)
        cap_dispatch_mask = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool)
        manual_constraint_mask = np.asarray(constraint_meta.get("manual_constraint_mask"), dtype=bool)
        actual_train = np.asarray(actual, dtype=float).copy()
        actual_train[cap_dispatch_mask] = base[cap_dispatch_mask]
        actual_eval = actual_train.copy()
        actual_eval[(~actual_present_arr) | operational_mask] = base[(~actual_present_arr) | operational_mask]
        stats = analyse_weather_day(day, w5, actual_eval)
        bad, reason = training_day_rejection(stats, actual_eval, base)

        if bad:
            log.warning("  Reject %s - %s", day, reason)
            continue

        log.info(
            "  Accept %s  sky=%-14s  CF=%.3f  corr=%.2f  vol=%.2f  manual_slots=%d  cap_slots=%d",
            day,
            stats["sky_class"],
            stats["capacity_factor"],
            stats.get("rad_gen_corr", 0),
            stats["vol_index"],
            int(constraint_meta.get("manual_constraint_slot_count", 0)),
            int(constraint_meta.get("cap_dispatch_slot_count", 0)),
        )

        feat = build_features(w5, day)
        curtailed = curtailed_mask(actual_train, base)
        mask = (
            (base > 0)
            & actual_present_arr
            & (~manual_constraint_mask)
            & (~curtailed)
            & (feat["rad"].values >= RAD_MIN_WM2)
            & (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
            & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
        )

        if mask.sum() < MIN_SAMPLES:
            log.warning("  Reject %s - too few usable slots (%d)", day, int(mask.sum()))
            continue

        residual = np.clip(actual_train - base, -500.0, 500.0)
        X = feat.loc[mask, FEATURE_COLS]
        y = residual[mask]

        recency_w = max(1, round(RECENCY_BASE ** (N_TRAIN_DAYS - d)))
        X = pd.concat([X] * recency_w, ignore_index=True)
        y = np.tile(y, recency_w)

        X_parts.append(X)
        y_parts.append(y)
        valid_days += 1

    if valid_days < MIN_TRAIN_DAYS:
        log.warning("Only %d valid training days - minimum is %d", valid_days, MIN_TRAIN_DAYS)
        return None, None

    X_train = pd.concat(X_parts, ignore_index=True)
    y_train = np.concatenate(y_parts)
    log.info("Training set: %d samples from %d days", len(y_train), valid_days)
    return X_train, y_train


def collect_training_data_hardened(
    today: date,
    history_days: list[dict] | None = None,
    day_regime: str | None = None,
    solcast_reliability: dict | None = None,
) -> tuple[pd.DataFrame, np.ndarray, np.ndarray, np.ndarray, np.ndarray] | tuple[None, None, None, None, None]:
    """
    Build the residual-training set from the hardened historical basis.

    The model learns residual plant response from actual archived weather and
    actual generation. Forecast weather is used only at inference time.
    """
    samples = list(history_days or collect_history_days(today, N_TRAIN_DAYS, solcast_reliability=solcast_reliability))
    samples = [sample for sample in samples if int(sample.get("days_ago", N_TRAIN_DAYS + 1)) <= N_TRAIN_DAYS]
    if day_regime:
        samples = [sample for sample in samples if str(sample.get("day_regime") or "") == str(day_regime)]

    X_parts = []
    y_parts = []
    weight_parts = []
    class_scale_parts = []
    day_parts = []
    solcast_days = 0

    if day_regime:
        log.info(
            "Collecting residual training samples from %d accepted history day(s) for regime=%s",
            len(samples),
            day_regime,
        )
    else:
        log.info("Collecting residual training samples from %d accepted history day(s)", len(samples))

    for sample in samples:
        day = str(sample["day"])
        stats = sample["stats"]
        manual_constraint_mask = np.asarray(sample.get("manual_constraint_mask"), dtype=bool) if sample.get("manual_constraint_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
        cap_dispatch_mask = np.asarray(sample.get("cap_dispatch_mask"), dtype=bool) if sample.get("cap_dispatch_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
        X = sample.get("training_feature_frame")
        y = np.asarray(sample.get("training_residual"), dtype=float) if sample.get("training_residual") is not None else np.asarray([], dtype=float)
        class_scale = np.asarray(sample.get("training_class_scale"), dtype=float) if sample.get("training_class_scale") is not None else np.asarray([], dtype=float)
        usable = int(sample.get("training_slot_count", len(y)))
        hybrid_meta = {
            "used_solcast": bool(sample.get("used_solcast")),
            "coverage_ratio": float(((sample.get("solcast_prior") or {}).get("coverage_ratio", 0.0)) if isinstance(sample.get("solcast_prior"), dict) else 0.0),
            "mean_blend": float(
                np.mean(
                    np.asarray(
                        ((sample.get("solcast_prior") or {}).get("blend", np.zeros(SLOTS_DAY)))
                        if isinstance(sample.get("solcast_prior"), dict)
                        else np.zeros(SLOTS_DAY),
                        dtype=float,
                    )[SOLAR_START_SLOT:SOLAR_END_SLOT]
                )
            ),
        }
        if not isinstance(X, pd.DataFrame) or len(X) != len(y) or len(y) != len(class_scale):
            actual = np.asarray(sample.get("actual_effective", sample["actual"]), dtype=float).copy()
            actual_present = np.asarray(sample.get("actual_present"), dtype=bool) if sample.get("actual_present") is not None else np.ones(SLOTS_DAY, dtype=bool)
            w5 = sample["weather"]
            base = np.asarray(sample["baseline"], dtype=float)
            solcast_prior = sample.get("solcast_prior") if isinstance(sample.get("solcast_prior"), dict) else solcast_prior_from_snapshot(
                day,
                w5,
                sample.get("solcast_snapshot"),
                solcast_reliability,
            )
            stored_hybrid = sample.get("hybrid_baseline")
            if stored_hybrid is not None:
                hybrid_base = np.asarray(stored_hybrid, dtype=float).copy()
                hybrid_meta = {
                    "used_solcast": bool(sample.get("used_solcast")),
                    "coverage_ratio": float((solcast_prior or {}).get("coverage_ratio", 0.0)),
                    "mean_blend": float(np.mean(np.asarray((solcast_prior or {}).get("blend", np.zeros(SLOTS_DAY)), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if solcast_prior else 0.0,
                }
            else:
                hybrid_base, hybrid_meta = blend_physics_with_solcast(base, solcast_prior)
            feat = build_features(w5, day, solcast_prior)
            actual[cap_dispatch_mask] = hybrid_base[cap_dispatch_mask]
            curtailed = curtailed_mask(actual, hybrid_base)
            mask = (
                (hybrid_base > 0)
                & actual_present
                & (~manual_constraint_mask)
                & (~curtailed)
                & (feat["rad"].values >= RAD_MIN_WM2)
                & (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
                & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
            )
            usable = int(np.count_nonzero(mask))
            X = feat.loc[mask, FEATURE_COLS].reset_index(drop=True)
            y = np.clip(actual - hybrid_base, -500.0, 500.0)[mask]
            class_scale = _error_class_normalizer(y, baseline_kwh=hybrid_base[mask])
        if usable < MIN_SAMPLES:
            log.warning("  Reject %s - too few usable slots (%d)", day, usable)
            continue

        recency_weight = _sample_weight_for_days_ago(int(sample.get("days_ago", N_TRAIN_DAYS)))
        corr = float(stats.get("rad_gen_corr", 0.0))
        quality_weight = float(np.clip(0.70 + 0.30 * max(corr, 0.0), 0.55, 1.0))
        sample_weight = np.full(len(y), recency_weight * quality_weight, dtype=float)

        X_parts.append(X.reset_index(drop=True))
        y_parts.append(y)
        weight_parts.append(sample_weight)
        class_scale_parts.append(class_scale)
        day_parts.append(np.full(len(y), day, dtype=object))
        if bool(hybrid_meta.get("used_solcast")):
            solcast_days += 1

        log.info(
            "  Train %s  sky=%-14s  CF=%.3f  corr=%.2f  weight=%.3f  usable=%d  manual_slots=%d  cap_slots=%d  solcast=%s blend=%.2f cov=%.2f",
            day,
            stats["sky_class"],
            stats["capacity_factor"],
            corr,
            float(sample_weight[0]) if len(sample_weight) else 0.0,
            usable,
            int(np.count_nonzero(manual_constraint_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
            int(np.count_nonzero(cap_dispatch_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
            "yes" if hybrid_meta.get("used_solcast") else "no",
            float(hybrid_meta.get("mean_blend", 0.0)),
            float(hybrid_meta.get("coverage_ratio", 0.0)),
        )

    valid_days = len(X_parts)
    if valid_days < MIN_TRAIN_DAYS:
        log.warning("Only %d valid training days - minimum is %d", valid_days, MIN_TRAIN_DAYS)
        return None, None, None, None, None

    X_train = pd.concat(X_parts, ignore_index=True)
    y_train = np.concatenate(y_parts)
    w_train = np.concatenate(weight_parts)
    class_scale_train = np.concatenate(class_scale_parts)
    day_train = np.concatenate(day_parts)
    log.info(
        "Training set: %d samples from %d days (mean sample weight=%.3f, solcast_days=%d)",
        len(y_train),
        valid_days,
        float(np.mean(w_train)),
        int(solcast_days),
    )
    return X_train, y_train, w_train, class_scale_train, day_train


def _make_residual_regressor(n_estimators: int | None = None) -> GradientBoostingRegressor:
    return GradientBoostingRegressor(
        n_estimators=int(n_estimators or 500),
        learning_rate=0.025,
        max_depth=4,
        min_samples_split=15,
        min_samples_leaf=8,
        subsample=0.8,
        max_features=0.75,
        random_state=42,
        loss="huber",
        alpha=0.85,
        n_iter_no_change=None,
        tol=1e-4,
    )


def _make_error_classifier(n_estimators: int | None = None) -> GradientBoostingClassifier:
    return GradientBoostingClassifier(
        n_estimators=int(n_estimators or 320),
        learning_rate=0.04,
        max_depth=3,
        min_samples_split=18,
        min_samples_leaf=10,
        subsample=0.8,
        max_features=0.75,
        random_state=42,
        n_iter_no_change=None,
        tol=1e-4,
    )


def _select_residual_regressor_stage(
    X: pd.DataFrame,
    y: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None,
) -> dict:
    meta = {
        "used_blocked_validation": False,
        "holdout_days": 0,
        "holdout_samples": 0,
        "best_n_estimators": int(_make_residual_regressor().n_estimators),
        "mae_full": None,
        "mae_best": None,
    }
    holdout_mask = _blocked_day_holdout_mask(day_keys)
    if holdout_mask.size != len(y) or not np.any(holdout_mask):
        return meta
    if int(np.count_nonzero(holdout_mask)) < MODEL_STAGE_HOLDOUT_MIN_SAMPLES:
        return meta
    train_mask = ~holdout_mask
    if len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[train_mask]}) < max(MIN_TRAIN_DAYS, 4):
        return meta
    X_train = X.iloc[train_mask].reset_index(drop=True)
    X_holdout = X.iloc[holdout_mask].reset_index(drop=True)
    y_train = np.asarray(y, dtype=float)[train_mask]
    y_holdout = np.asarray(y, dtype=float)[holdout_mask]
    w_train = np.asarray(sample_weight, dtype=float)[train_mask]
    w_holdout = np.asarray(sample_weight, dtype=float)[holdout_mask]
    model = _make_residual_regressor()
    model.fit(X_train, y_train, sample_weight=w_train)
    best_n = int(getattr(model, "n_estimators_", model.n_estimators))
    best_mae = float("inf")
    full_mae = None
    for idx, pred in enumerate(model.staged_predict(X_holdout), start=1):
        mae = _weighted_mae_loss(pred, y_holdout, w_holdout)
        if idx == int(getattr(model, "n_estimators_", model.n_estimators)):
            full_mae = mae
        if mae + 1e-6 < best_mae:
            best_mae = mae
            best_n = idx
    meta.update({
        "used_blocked_validation": True,
        "holdout_days": int(len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[holdout_mask]})),
        "holdout_samples": int(np.count_nonzero(holdout_mask)),
        "best_n_estimators": int(best_n),
        "mae_full": None if full_mae is None else float(full_mae),
        "mae_best": None if not math.isfinite(best_mae) else float(best_mae),
    })
    return meta


def _select_error_classifier_stage(
    X: pd.DataFrame,
    labels: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None,
) -> dict:
    meta = {
        "used_blocked_validation": False,
        "holdout_days": 0,
        "holdout_samples": 0,
        "best_n_estimators": int(_make_error_classifier().n_estimators),
        "nll_full": None,
        "nll_best": None,
    }
    holdout_mask = _blocked_day_holdout_mask(day_keys)
    if holdout_mask.size != len(labels) or not np.any(holdout_mask):
        return meta
    if int(np.count_nonzero(holdout_mask)) < MODEL_STAGE_HOLDOUT_MIN_SAMPLES:
        return meta
    train_mask = ~holdout_mask
    y_train = np.asarray(labels, dtype=int)[train_mask]
    y_holdout = np.asarray(labels, dtype=int)[holdout_mask]
    if len({int(v) for v in y_train}) < 2 or len({int(v) for v in y_holdout}) < 2:
        return meta
    X_train = X.iloc[train_mask].reset_index(drop=True)
    X_holdout = X.iloc[holdout_mask].reset_index(drop=True)
    w_train = np.asarray(sample_weight, dtype=float)[train_mask]
    w_holdout = np.asarray(sample_weight, dtype=float)[holdout_mask]
    model = _make_error_classifier()
    model.fit(X_train, y_train, sample_weight=w_train)
    best_n = int(getattr(model, "n_estimators_", model.n_estimators))
    best_nll = float("inf")
    full_nll = None
    for idx, probs in enumerate(model.staged_predict_proba(X_holdout), start=1):
        full_probs = _classifier_probabilities_to_full_vector(
            np.asarray(probs, dtype=float),
            list(map(int, getattr(model, "classes_", []))),
        )
        nll = _weighted_neg_log_loss(full_probs, y_holdout, w_holdout)
        if idx == int(getattr(model, "n_estimators_", model.n_estimators)):
            full_nll = nll
        if nll + 1e-6 < best_nll:
            best_nll = nll
            best_n = idx
    meta.update({
        "used_blocked_validation": True,
        "holdout_days": int(len({str(v) for v in np.asarray(day_keys, dtype=object).reshape(-1)[holdout_mask]})),
        "holdout_samples": int(np.count_nonzero(holdout_mask)),
        "best_n_estimators": int(best_n),
        "nll_full": None if full_nll is None else float(full_nll),
        "nll_best": None if not math.isfinite(best_nll) else float(best_nll),
    })
    return meta


def fit_residual_model(
    X: pd.DataFrame,
    y: np.ndarray,
    sample_weight: np.ndarray,
    day_keys: np.ndarray | list[str] | None = None,
) -> tuple[GradientBoostingRegressor, object | None, dict]:
    stage_meta = _select_residual_regressor_stage(X, y, sample_weight, day_keys)
    model = _make_residual_regressor(stage_meta.get("best_n_estimators"))
    model.fit(X.reset_index(drop=True), y, sample_weight=sample_weight)
    meta = {
        "sample_count": int(len(y)),
        "feature_count": int(X.shape[1]),
        "feature_names": list(X.columns),
        "train_score": float(model.train_score_[-1]) if getattr(model, "train_score_", None) is not None and len(model.train_score_) else None,
        "estimators_used": int(getattr(model, "n_estimators_", model.n_estimators)),
        "stage_validation": stage_meta,
    }
    return model, None, meta


def fit_error_classifier(
    X: pd.DataFrame,
    residual: np.ndarray,
    sample_weight: np.ndarray,
    opportunity_kwh: np.ndarray | None = None,
    day_keys: np.ndarray | list[str] | None = None,
) -> tuple[GradientBoostingClassifier, object | None, dict] | tuple[None, None, None]:
    labels = classify_residual_error_classes(residual, opportunity_kwh=opportunity_kwh)
    present = sorted({int(v) for v in np.asarray(labels, dtype=int)})
    if len(present) < 2:
        return None, None, None

    stage_meta = _select_error_classifier_stage(X, labels, sample_weight, day_keys)
    model = _make_error_classifier(stage_meta.get("best_n_estimators"))
    model.fit(X.reset_index(drop=True), labels, sample_weight=sample_weight)
    centroids = {}
    raw_centroids = {}
    label_arr = np.asarray(labels, dtype=int)
    residual_arr = np.asarray(residual, dtype=float)
    weight_arr = np.asarray(sample_weight, dtype=float)
    class_counts = {}
    residual_prior = float(np.average(residual_arr, weights=np.maximum(weight_arr, 1e-9)))
    for label in present:
        mask = label_arr == label
        count = int(np.count_nonzero(mask))
        class_counts[_error_class_name(label)] = count
        if not np.any(mask):
            continue
        raw_mean = float(np.average(residual_arr[mask], weights=np.maximum(weight_arr[mask], 1e-9)))
        shrink = count / (count + ERROR_CLASS_CENTROID_SHRINKAGE_SAMPLES)
        raw_centroids[str(label)] = raw_mean
        centroids[str(label)] = float((shrink * raw_mean) + ((1.0 - shrink) * residual_prior))
    calibration = _fit_error_classifier_temperature(X, label_arr, weight_arr, day_keys)
    meta = {
        "sample_count": int(len(residual_arr)),
        "feature_count": int(X.shape[1]),
        "feature_names": list(X.columns),
        "estimators_used": int(getattr(model, "n_estimators_", model.n_estimators)),
        "classes": list(map(int, getattr(model, "classes_", []))),
        "class_counts": class_counts,
        "centroids_kwh": centroids,
        "raw_centroids_kwh": raw_centroids,
        "centroid_prior_kwh": residual_prior,
        "label_normalization": "slot_opportunity" if opportunity_kwh is not None else "slot_cap",
        "opportunity_floor_frac": float(ERROR_CLASS_OPPORTUNITY_FLOOR_FRAC),
        "prob_temperature": float(calibration.get("temperature", 1.0)),
        "calibration": calibration,
        "stage_validation": stage_meta,
        "class_support_weights": {
            ERROR_CLASS_NAMES[idx]: float(weight)
            for idx, weight in enumerate(_error_class_support_weights({
                "class_counts": class_counts,
                "sample_count": int(len(residual_arr)),
            }))
        },
        "train_score": float(model.train_score_[-1]) if getattr(model, "train_score_", None) is not None and len(model.train_score_) else None,
    }
    return model, None, meta


def build_weather_error_profiles(history_days: list[dict]) -> dict:
    """Aggregate residual behavior by day regime and slot weather bucket."""
    pair_values: dict[tuple[str, str], list[float]] = {}
    regime_values: dict[str, list[float]] = {}
    bucket_values: dict[str, list[float]] = {}
    cap_slot = max(slot_cap_kwh(False), 1.0)
    solar_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )

    for sample in history_days:
        day = str(sample["day"])
        w5 = sample["weather"]
        residual = np.asarray(sample.get("residual"), dtype=float) if sample.get("residual") is not None else None
        usable_mask = np.asarray(sample.get("training_usable_mask"), dtype=bool) if sample.get("training_usable_mask") is not None else None
        bucket_labels = np.asarray(sample.get("slot_weather_buckets"), dtype=object) if sample.get("slot_weather_buckets") is not None else None
        if residual is None or residual.size < SLOTS_DAY or usable_mask is None or usable_mask.size < SLOTS_DAY:
            feat = sample.get("feature_frame")
            if not isinstance(feat, pd.DataFrame):
                feat = build_features(w5, day, sample.get("solcast_prior"))
            actual = np.asarray(sample.get("actual_effective", sample["actual"]), dtype=float).copy()
            hybrid = np.asarray(sample.get("hybrid_baseline", sample["baseline"]), dtype=float).copy()
            actual_present = np.asarray(sample.get("actual_present"), dtype=bool) if sample.get("actual_present") is not None else np.ones(SLOTS_DAY, dtype=bool)
            manual_constraint_mask = np.asarray(sample.get("manual_constraint_mask"), dtype=bool) if sample.get("manual_constraint_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
            cap_dispatch_mask = np.asarray(sample.get("cap_dispatch_mask"), dtype=bool) if sample.get("cap_dispatch_mask") is not None else np.zeros(SLOTS_DAY, dtype=bool)
            actual[cap_dispatch_mask] = hybrid[cap_dispatch_mask]
            usable_mask = (
                solar_mask
                & actual_present
                & (~manual_constraint_mask)
                & (~curtailed_mask(actual, hybrid))
                & (feat["rad"].values >= RAD_MIN_WM2)
                & (hybrid > 0.0)
            )
            residual = np.clip(actual - hybrid, -500.0, 500.0)
        if not np.any(usable_mask):
            continue
        if bucket_labels is None or bucket_labels.size < SLOTS_DAY:
            bucket_labels = classify_slot_weather_buckets(w5, day)
        regime = str(sample.get("day_regime") or classify_day_regime(sample.get("stats") or analyse_weather_day(day, w5)))
        for slot in np.flatnonzero(usable_mask):
            bucket = str(bucket_labels[slot] or "")
            if not bucket or bucket == "offsolar":
                continue
            value = float(residual[slot])
            pair_values.setdefault((regime, bucket), []).append(value)
            regime_values.setdefault(regime, []).append(value)
            bucket_values.setdefault(bucket, []).append(value)

    return {
        "created_ts": int(time.time()),
        "class_names": list(ERROR_CLASS_NAMES),
        "cap_slot_kwh": float(cap_slot),
        "pairs": {
            f"{regime}:{bucket}": _aggregate_scalar_series(values)
            for (regime, bucket), values in sorted(pair_values.items())
        },
        "regimes": {
            regime: _aggregate_scalar_series(values)
            for regime, values in sorted(regime_values.items())
        },
        "buckets": {
            bucket: _aggregate_scalar_series(values)
            for bucket, values in sorted(bucket_values.items())
        },
    }


def build_training_state(today: date) -> dict | None:
    """Build the in-memory model/artifact state for a given training cut-off date."""
    solcast_reliability = build_solcast_reliability_artifact(today)
    history_days = collect_history_days(
        today,
        max(N_TRAIN_DAYS, SHAPE_LOOKBACK_DAYS),
        solcast_reliability=solcast_reliability,
    )
    X, y, sample_weight, class_scale, day_keys = collect_training_data_hardened(
        today,
        history_days,
        solcast_reliability=solcast_reliability,
    )
    if X is None:
        return None

    global_model, global_scaler, global_meta = fit_residual_model(X, y, sample_weight, day_keys=day_keys)
    error_classifier_model, error_classifier_scaler, error_classifier_meta = fit_error_classifier(
        X,
        y,
        sample_weight,
        opportunity_kwh=class_scale,
        day_keys=day_keys,
    )
    bundle = {
        "created_ts": int(time.time()),
        "training_basis": "actual archived weather + cleaned actual generation (+ Solcast prior when available)",
        "history_days": int(len(history_days)),
        "feature_cols": list(X.columns),
        "global": {
            "model": global_model,
            "scaler": global_scaler,
            "meta": dict(global_meta),
        },
        "regimes": {},
        "error_classifier": {
            "class_names": list(ERROR_CLASS_NAMES),
            "global": {},
            "regimes": {},
            "weather_profiles": build_weather_error_profiles(history_days),
        },
    }
    if error_classifier_model is not None and error_classifier_scaler is not None and error_classifier_meta is not None:
        bundle["error_classifier"]["global"] = {
            "model": error_classifier_model,
            "scaler": error_classifier_scaler,
            "meta": dict(error_classifier_meta),
        }

    for regime in sorted({str(sample.get("day_regime") or "") for sample in history_days if sample.get("day_regime")}):
        regime_days = sum(1 for sample in history_days if str(sample.get("day_regime") or "") == regime)
        if regime_days < REGIME_MODEL_MIN_DAYS:
            continue
        X_reg, y_reg, w_reg, reg_class_scale, reg_day_keys = collect_training_data_hardened(
            today,
            history_days,
            day_regime=regime,
            solcast_reliability=solcast_reliability,
        )
        if X_reg is None or len(y_reg) < REGIME_MODEL_MIN_SAMPLES:
            continue
        regime_model, regime_scaler, regime_meta = fit_residual_model(X_reg, y_reg, w_reg, day_keys=reg_day_keys)
        regime_meta["day_count"] = int(regime_days)
        bundle["regimes"][regime] = {
            "model": regime_model,
            "scaler": regime_scaler,
            "meta": regime_meta,
        }
        log.info(
            "Regime model trained [%s] - days=%d samples=%d train_score=%s",
            regime,
            regime_days,
            int(regime_meta.get("sample_count", 0)),
            f"{float(regime_meta['train_score']):.4f}" if regime_meta.get("train_score") is not None else "n/a",
        )
        cls_model, cls_scaler, cls_meta = fit_error_classifier(
            X_reg,
            y_reg,
            w_reg,
            opportunity_kwh=reg_class_scale,
            day_keys=reg_day_keys,
        )
        if cls_model is not None and cls_scaler is not None and cls_meta is not None:
            cls_meta["day_count"] = int(regime_days)
            bundle["error_classifier"]["regimes"][regime] = {
                "model": cls_model,
                "scaler": cls_scaler,
                "meta": cls_meta,
            }

    return {
        "created_ts": int(time.time()),
        "training_date": today.isoformat(),
        "history_days": history_days,
        "model_bundle": bundle,
        "forecast_artifacts": build_forecast_artifacts(history_days),
        "weather_bias": build_weather_bias_artifact(today),
        "solcast_reliability": solcast_reliability,
    }


def save_model_bundle(bundle: dict) -> bool:
    try:
        MODEL_BUNDLE_FILE.parent.mkdir(parents=True, exist_ok=True)
        dump(bundle, MODEL_BUNDLE_FILE)
        return True
    except Exception as e:
        log.error("Model bundle save failed %s: %s", MODEL_BUNDLE_FILE, e)
        return False


def load_model_bundle() -> dict | None:
    if MODEL_BUNDLE_FILE.exists():
        try:
            data = load(MODEL_BUNDLE_FILE)
            if isinstance(data, dict):
                return data
        except Exception as e:
            log.warning("Model bundle load failed %s: %s", MODEL_BUNDLE_FILE, e)

    if MODEL_FILE.exists():
        try:
            model = load(MODEL_FILE)
            scaler = load(SCALER_FILE) if SCALER_FILE.exists() else None
            return {
                "created_ts": int(time.time()),
                "training_basis": "legacy-single-model",
                "global": {
                    "model": model,
                    "scaler": scaler,
                    "meta": {
                        "sample_count": 0,
                        "feature_count": len(FEATURE_COLS),
                        "feature_names": list(FEATURE_COLS),
                        "train_score": None,
                        "estimators_used": int(getattr(model, "n_estimators_", getattr(model, "n_estimators", 0)) or 0),
                    },
                },
                "regimes": {},
                "error_classifier": {
                    "class_names": list(ERROR_CLASS_NAMES),
                    "global": {},
                    "regimes": {},
                    "weather_profiles": {},
                },
            }
        except Exception as e:
            log.warning("Legacy model load failed: %s", e)
    return None


def _align_bundle_features(
    block: dict,
    bundle_feature_cols: list[str] | None,
    X_pred: pd.DataFrame,
) -> pd.DataFrame:
    expected_cols = list((block.get("meta") or {}).get("feature_names") or bundle_feature_cols or [])
    if expected_cols:
        X_aligned = pd.DataFrame(index=X_pred.index)
        for col in expected_cols:
            if col in X_pred.columns:
                X_aligned[col] = pd.to_numeric(X_pred[col], errors="coerce").fillna(0.0)
            else:
                X_aligned[col] = 0.0
        return X_aligned
    scaler = block.get("scaler")
    model = block.get("model")
    expected_count = None
    if hasattr(scaler, "n_features_in_"):
        expected_count = int(scaler.n_features_in_)
    elif hasattr(model, "n_features_in_"):
        expected_count = int(model.n_features_in_)
    if expected_count is not None and expected_count != int(X_pred.shape[1]):
        raise ValueError(
            f"Feature count mismatch for model bundle (expected {expected_count}, got {int(X_pred.shape[1])})"
        )
    return X_pred


def _transform_bundle_features(block: dict, X_pred: pd.DataFrame):
    scaler = block.get("scaler")
    if scaler is not None and hasattr(scaler, "transform"):
        return np.asarray(scaler.transform(X_pred), dtype=float)
    return X_pred


def predict_residual_with_bundle(
    bundle: dict | None,
    X_pred: pd.DataFrame,
    target_regime: str,
    regime_confidence: float = 1.0,
) -> tuple[np.ndarray, dict]:
    if not bundle or not isinstance(bundle, dict):
        return np.zeros(len(X_pred), dtype=float), {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    global_block = bundle.get("global") or {}
    global_model = global_block.get("model")
    if global_model is None:
        return np.zeros(len(X_pred), dtype=float), {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    X_pred = _align_bundle_features(global_block, list(bundle.get("feature_cols") or []), X_pred)

    X_global = _transform_bundle_features(global_block, X_pred)
    global_pred = np.asarray(global_model.predict(X_global), dtype=float)
    regime_block = ((bundle.get("regimes") or {}).get(target_regime) or {})
    regime_model = regime_block.get("model")
    if regime_model is None:
        return global_pred, {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    X_regime = _transform_bundle_features(regime_block, X_pred)
    regime_pred = np.asarray(regime_model.predict(X_regime), dtype=float)
    regime_meta = regime_block.get("meta") or {}
    regime_days = int(regime_meta.get("day_count", 0))
    blend = REGIME_BLEND_BASE + 0.05 * max(0, regime_days - REGIME_MODEL_MIN_DAYS)
    blend = min(blend, REGIME_BLEND_MAX)
    blend *= float(np.clip(regime_confidence, 0.60, 1.0))
    return ((1.0 - blend) * global_pred + blend * regime_pred), {
        "target_regime": target_regime,
        "used_regime_model": True,
        "blend": float(blend),
        "regime_days": regime_days,
        "regime_samples": int(regime_meta.get("sample_count", 0)),
    }


def _classifier_probabilities_to_full_vector(probs: np.ndarray, classes: list[int]) -> np.ndarray:
    out = np.zeros((len(probs), len(ERROR_CLASS_NAMES)), dtype=float)
    for idx, class_id in enumerate(classes):
        class_idx = int(class_id)
        if 0 <= class_idx < len(ERROR_CLASS_NAMES):
            out[:, class_idx] = np.asarray(probs[:, idx], dtype=float)
    row_sum = out.sum(axis=1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.divide(out, np.maximum(row_sum, 1e-9), out=np.zeros_like(out), where=row_sum > 0)
    return out


def _expected_bias_from_classifier_probs(prob_matrix: np.ndarray, centroids: dict) -> np.ndarray:
    expected = np.zeros(prob_matrix.shape[0], dtype=float)
    for class_idx, class_name in enumerate(ERROR_CLASS_NAMES):
        centroid = float(centroids.get(str(class_idx), 0.0))
        if centroid == 0.0:
            continue
        expected += np.asarray(prob_matrix[:, class_idx], dtype=float) * centroid
    return expected


def _error_class_support_weights(meta: dict | None) -> np.ndarray:
    meta_dict = meta if isinstance(meta, dict) else {}
    class_counts = dict(meta_dict.get("class_counts") or {})
    if not class_counts:
        return np.ones(len(ERROR_CLASS_NAMES), dtype=float)
    weights = np.ones(len(ERROR_CLASS_NAMES), dtype=float)
    for idx, name in enumerate(ERROR_CLASS_NAMES):
        if idx == ERROR_CLASS_NEUTRAL_IDX:
            weights[idx] = 1.0
            continue
        full_count = ERROR_CLASS_SUPPORT_STRONG_FULL_COUNT if idx in (0, len(ERROR_CLASS_NAMES) - 1) else ERROR_CLASS_SUPPORT_MILD_FULL_COUNT
        count = max(float(class_counts.get(name, 0.0)), 0.0)
        weights[idx] = float(np.sqrt(np.clip(count / max(full_count, 1.0), 0.0, 1.0)))
    return weights


def _stabilize_classifier_probabilities(
    prob_matrix: np.ndarray,
    meta: dict | None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    probs = np.asarray(prob_matrix, dtype=float)
    if probs.ndim != 2 or probs.size <= 0:
        support_weights = np.ones(len(ERROR_CLASS_NAMES), dtype=float)
        return probs.copy(), support_weights, np.ones(probs.shape[0] if probs.ndim == 2 else 0, dtype=float)
    support_weights = _error_class_support_weights(meta)
    adjusted = probs.copy()
    for idx in range(adjusted.shape[1]):
        if idx == ERROR_CLASS_NEUTRAL_IDX:
            continue
        adjusted[:, idx] *= float(support_weights[idx])
    row_sum = adjusted.sum(axis=1, keepdims=True)
    neutral_add = np.clip(1.0 - row_sum, 0.0, 1.0)
    adjusted[:, ERROR_CLASS_NEUTRAL_IDX] += neutral_add[:, 0]
    row_sum = adjusted.sum(axis=1, keepdims=True)
    adjusted = np.divide(adjusted, np.maximum(row_sum, 1e-9), out=np.zeros_like(adjusted), where=row_sum > 0)
    support_strength = np.clip(adjusted @ support_weights, 0.0, 1.0)
    return adjusted, support_weights, support_strength


def _weather_profile_stat_reliability(stat: dict | None, cap_slot_kwh: float, full_count: float) -> float | None:
    if not isinstance(stat, dict):
        return None
    count = int(stat.get("count", 0) or 0)
    if count <= 0:
        return None
    cap_slot = max(float(cap_slot_kwh), 1.0)
    count_score = float(np.clip(count / max(full_count, 1.0), 0.0, 1.0))
    mae_norm = float(np.clip(abs(float(stat.get("mae", 0.0))) / max(cap_slot * ERROR_CLASS_PROFILE_MAE_REF_FRAC, 1.0), 0.0, 1.0))
    std_norm = float(np.clip(abs(float(stat.get("std", 0.0))) / max(cap_slot * ERROR_CLASS_PROFILE_STD_REF_FRAC, 1.0), 0.0, 1.0))
    stability = float(np.clip(1.0 - 0.60 * mae_norm - 0.40 * std_norm, 0.0, 1.0))
    return float(
        np.clip(
            ERROR_CLASS_PROFILE_MIN_RELIABILITY
            + (1.0 - ERROR_CLASS_PROFILE_MIN_RELIABILITY) * count_score * stability,
            ERROR_CLASS_PROFILE_MIN_RELIABILITY,
            1.0,
        )
    )


def _weather_profile_reliability_vector(
    weather_profiles: dict | None,
    target_regime: str,
    slot_weather_buckets: np.ndarray | list[str] | None,
) -> np.ndarray:
    if slot_weather_buckets is None:
        return np.ones(0, dtype=float)
    labels = np.asarray(slot_weather_buckets, dtype=object).reshape(-1)
    out = np.full(labels.shape, ERROR_CLASS_PROFILE_DEFAULT_RELIABILITY, dtype=float)
    if labels.size <= 0:
        return out
    profiles = weather_profiles if isinstance(weather_profiles, dict) else {}
    pair_stats = dict(profiles.get("pairs") or {})
    bucket_stats = dict(profiles.get("buckets") or {})
    regime_stats = dict(profiles.get("regimes") or {})
    cap_slot = float(profiles.get("cap_slot_kwh", slot_cap_kwh(False)) or slot_cap_kwh(False))
    for idx, raw_label in enumerate(labels):
        bucket = str(raw_label or "")
        if not bucket or bucket == "offsolar":
            out[idx] = 0.0
            continue
        scored: list[tuple[float, float]] = []
        pair_rel = _weather_profile_stat_reliability(
            pair_stats.get(f"{target_regime}:{bucket}"),
            cap_slot,
            ERROR_CLASS_PROFILE_PAIR_FULL_COUNT,
        )
        if pair_rel is not None:
            scored.append((0.60, pair_rel))
        bucket_rel = _weather_profile_stat_reliability(
            bucket_stats.get(bucket),
            cap_slot,
            ERROR_CLASS_PROFILE_BUCKET_FULL_COUNT,
        )
        if bucket_rel is not None:
            scored.append((0.25, bucket_rel))
        regime_rel = _weather_profile_stat_reliability(
            regime_stats.get(target_regime),
            cap_slot,
            ERROR_CLASS_PROFILE_REGIME_FULL_COUNT,
        )
        if regime_rel is not None:
            scored.append((0.15, regime_rel))
        if scored:
            weights = np.asarray([w for w, _ in scored], dtype=float)
            values = np.asarray([v for _, v in scored], dtype=float)
            out[idx] = float(np.average(values, weights=weights))
        else:
            out[idx] = ERROR_CLASS_PROFILE_DEFAULT_RELIABILITY
    return np.clip(out, 0.0, 1.0)


def predict_error_classifier_with_bundle(
    bundle: dict | None,
    X_pred: pd.DataFrame,
    target_regime: str,
    regime_confidence: float = 1.0,
    slot_weather_buckets: np.ndarray | list[str] | None = None,
) -> tuple[np.ndarray, dict]:
    default_meta = {
        "available": False,
        "target_regime": target_regime,
        "used_regime_model": False,
        "blend": 0.0,
        "probabilities": np.zeros((len(X_pred), len(ERROR_CLASS_NAMES)), dtype=float),
        "predicted_labels": np.full(len(X_pred), ERROR_CLASS_NEUTRAL_IDX, dtype=int),
        "confidence": np.zeros(len(X_pred), dtype=float),
        "severe_probability": np.zeros(len(X_pred), dtype=float),
        "weather_profiles": {},
        "support_strength": np.zeros(len(X_pred), dtype=float),
        "profile_reliability": np.ones(len(X_pred), dtype=float),
        "trust_scale": np.zeros(len(X_pred), dtype=float),
        "cap_frac": np.full(len(X_pred), ERROR_CLASS_BIAS_CAP_FRAC, dtype=float),
        "class_support_weights": {name: 1.0 for name in ERROR_CLASS_NAMES},
    }
    if not bundle or not isinstance(bundle, dict):
        return np.zeros(len(X_pred), dtype=float), default_meta

    classifier_block = bundle.get("error_classifier") or {}
    global_block = classifier_block.get("global") or {}
    global_model = global_block.get("model")
    if global_model is None:
        return np.zeros(len(X_pred), dtype=float), default_meta

    X_pred = _align_bundle_features(global_block, list(bundle.get("feature_cols") or []), X_pred)
    X_global = _transform_bundle_features(global_block, X_pred)
    global_probs = _classifier_probabilities_to_full_vector(
        np.asarray(global_model.predict_proba(X_global), dtype=float),
        list(map(int, getattr(global_model, "classes_", []))),
    )
    global_probs = _apply_probability_temperature(
        global_probs,
        float((global_block.get("meta") or {}).get("prob_temperature", 1.0)),
    )
    global_probs, global_support_weights, global_support_strength = _stabilize_classifier_probabilities(
        global_probs,
        global_block.get("meta"),
    )
    global_centroids = dict((global_block.get("meta") or {}).get("centroids_kwh") or {})
    global_bias = _expected_bias_from_classifier_probs(global_probs, global_centroids)

    regime_block = ((classifier_block.get("regimes") or {}).get(target_regime) or {})
    regime_model = regime_block.get("model")
    if regime_model is None:
        probs = global_probs
        expected_bias = global_bias
        used_regime_model = False
        blend = 0.0
        regime_days = 0
        regime_samples = 0
        support_weights = global_support_weights
        support_strength = global_support_strength
    else:
        X_regime = _transform_bundle_features(regime_block, X_pred)
        regime_probs = _classifier_probabilities_to_full_vector(
            np.asarray(regime_model.predict_proba(X_regime), dtype=float),
            list(map(int, getattr(regime_model, "classes_", []))),
        )
        regime_probs = _apply_probability_temperature(
            regime_probs,
            float((regime_block.get("meta") or {}).get("prob_temperature", 1.0)),
        )
        regime_probs, regime_support_weights, regime_support_strength = _stabilize_classifier_probabilities(
            regime_probs,
            regime_block.get("meta"),
        )
        regime_centroids = dict((regime_block.get("meta") or {}).get("centroids_kwh") or {})
        regime_bias = _expected_bias_from_classifier_probs(regime_probs, regime_centroids)
        regime_meta = regime_block.get("meta") or {}
        regime_days = int(regime_meta.get("day_count", 0))
        regime_samples = int(regime_meta.get("sample_count", 0))
        blend = REGIME_BLEND_BASE + 0.05 * max(0, regime_days - REGIME_MODEL_MIN_DAYS)
        blend = min(blend, REGIME_BLEND_MAX)
        blend *= float(np.clip(regime_confidence, 0.60, 1.0))
        probs = ((1.0 - blend) * global_probs) + (blend * regime_probs)
        expected_bias = ((1.0 - blend) * global_bias) + (blend * regime_bias)
        used_regime_model = True
        support_weights = ((1.0 - blend) * global_support_weights) + (blend * regime_support_weights)
        support_strength = ((1.0 - blend) * global_support_strength) + (blend * regime_support_strength)

    profile_reliability = _weather_profile_reliability_vector(
        classifier_block.get("weather_profiles"),
        target_regime,
        slot_weather_buckets,
    )
    if profile_reliability.size != len(X_pred):
        profile_reliability = np.ones(len(X_pred), dtype=float)
    support_strength = np.clip(np.asarray(support_strength, dtype=float), 0.0, 1.0)
    trust_scale = np.clip(profile_reliability * support_strength, 0.0, 1.0)
    predicted_labels = np.argmax(probs, axis=1).astype(int)
    confidence = (np.max(probs, axis=1).astype(float) * np.sqrt(np.clip(trust_scale, 0.0, 1.0))).astype(float)
    severe_probability = (probs[:, 0] + probs[:, -1]).astype(float)
    cap_frac = (
        ERROR_CLASS_BIAS_CAP_FRAC
        * (0.45 + 0.55 * np.clip(profile_reliability, 0.0, 1.0))
        * (0.55 + 0.45 * np.clip(support_strength, 0.0, 1.0))
    )
    meta = {
        "available": True,
        "target_regime": target_regime,
        "used_regime_model": used_regime_model,
        "blend": float(blend),
        "regime_days": int(regime_days),
        "regime_samples": int(regime_samples),
        "probabilities": probs,
        "predicted_labels": predicted_labels,
        "confidence": confidence,
        "severe_probability": severe_probability,
        "weather_profiles": classifier_block.get("weather_profiles") or {},
        "support_strength": support_strength,
        "profile_reliability": profile_reliability,
        "trust_scale": trust_scale,
        "cap_frac": cap_frac.astype(float),
        "class_support_weights": {
            ERROR_CLASS_NAMES[idx]: float(support_weights[idx])
            for idx in range(min(len(ERROR_CLASS_NAMES), len(support_weights)))
        },
    }
    return expected_bias, meta


def train_model(today: date) -> bool:
    """Train (or retrain) the residual correction model."""
    state = build_training_state(today)
    if not state:
        return False

    bundle = state["model_bundle"]
    global_block = bundle.get("global") or {}
    global_model = global_block.get("model")
    global_scaler = global_block.get("scaler")
    global_meta = dict(global_block.get("meta") or {})
    dump(global_model, MODEL_FILE)
    if global_scaler is not None:
        dump(global_scaler, SCALER_FILE)
    else:
        dump(IdentityFeatureScaler(int(global_meta.get("feature_count", len(bundle.get("feature_cols") or FEATURE_COLS)))), SCALER_FILE)
    save_model_bundle(bundle)
    save_forecast_artifacts(state.get("forecast_artifacts") or {})
    save_weather_bias_artifact(state.get("weather_bias") or {})
    save_solcast_reliability_artifact(state.get("solcast_reliability"))
    classifier_block = bundle.get("error_classifier") or {}
    log.info(
        "Model trained - global_estimators=%d global_train_score=%s regime_models=%d classifier_regime_models=%d classifier_global=%s solcast_reliability_days=%d",
        int(global_meta.get("estimators_used", 0)),
        f"{float(global_meta['train_score']):.4f}" if global_meta.get("train_score") is not None else "n/a",
        int(len(bundle["regimes"])),
        int(len(classifier_block.get("regimes") or {})),
        bool((classifier_block.get("global") or {}).get("model")),
        int(((state.get("solcast_reliability") or {}).get("day_count", 0))),
    )
    return True


# ============================================================================
# RAMP RATE LIMITER
# ============================================================================

def apply_ramp_limit(arr: np.ndarray, max_step: float = 320.0) -> np.ndarray:
    """Enforce physical ramp-rate limit between consecutive slots."""
    arr = arr.copy()
    for i in range(1, len(arr)):
        diff = arr[i] - arr[i - 1]
        if diff > max_step:
            arr[i] = arr[i - 1] + max_step
        elif diff < -max_step:
            arr[i] = arr[i - 1] - max_step
    return arr


def residual_blend_vector(w5: pd.DataFrame, day: str, regime_confidence: float = 1.0) -> np.ndarray:
    """
    Compute per-slot ML blending factor [ML_BLEND_MIN..ML_BLEND_MAX].
    Lower blending is applied under high weather uncertainty:
      - strong cloud volatility
      - rain/convective conditions
      - dawn/dusk low-sun slots
    """
    def col(name: str, default: float = 0.0) -> np.ndarray:
        if name not in w5.columns:
            return np.full(SLOTS_DAY, default, dtype=float)
        arr = pd.to_numeric(w5[name], errors="coerce").fillna(default).values
        if len(arr) < SLOTS_DAY:
            arr = np.concatenate([arr, np.full(SLOTS_DAY - len(arr), default)])
        return arr[:SLOTS_DAY].astype(float)

    cloud = np.clip(col("cloud", 0.0), 0.0, 100.0)
    precip = np.clip(col("precip", 0.0), 0.0, None)
    cape = np.clip(col("cape", 0.0), 0.0, None)
    rad = np.clip(col("rad", 0.0), 0.0, None)

    idx = np.arange(SLOTS_DAY)
    solar_rel = (idx - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1)
    solar_rel = np.clip(solar_rel, 0, 1)
    # Dawn/dusk: trust ML less, noon: trust more.
    solar_conf = 0.68 + 0.32 * np.sin(np.pi * solar_rel)
    solar_conf = np.clip(solar_conf, 0.55, 1.0)

    cloud_std_1h = np.nan_to_num(_rolling_std(cloud, 12), nan=0.0) / 100.0
    precip_1h = np.nan_to_num(_rolling_sum(precip, 12), nan=0.0)

    cloud_unc = np.clip((cloud - 45.0) / 55.0, 0.0, 1.0)
    rain_unc = np.clip(precip_1h / 3.0, 0.0, 1.0)
    cape_unc = np.clip((cape - 400.0) / 1600.0, 0.0, 1.0)
    low_rad_unc = np.clip((RAD_MIN_WM2 * 8.0 - rad) / max(RAD_MIN_WM2 * 8.0, 1.0), 0.0, 1.0)

    uncertainty = (
        0.32 * cloud_std_1h +
        0.24 * cloud_unc +
        0.24 * rain_unc +
        0.12 * cape_unc +
        0.08 * low_rad_unc
    )
    uncertainty = np.clip(uncertainty, 0.0, 1.0)

    confidence_scale = float(np.clip(regime_confidence, 0.60, 1.0))
    blend = solar_conf * (1.0 - ML_BLEND_ALPHA * uncertainty) * confidence_scale
    blend = np.clip(blend, ML_BLEND_MIN, ML_BLEND_MAX)
    blend[:SOLAR_START_SLOT] = 0.0
    blend[SOLAR_END_SLOT:] = 0.0
    return blend


def solcast_residual_damp_factor(solcast_meta: dict | None) -> float:
    if not solcast_meta or not bool(solcast_meta.get("used_solcast")):
        return 1.0

    mean_blend = float(np.clip(solcast_meta.get("mean_blend", 0.0), 0.0, 1.0))
    reliability = float(np.clip(solcast_meta.get("reliability", 0.0), 0.0, 1.0))
    coverage = float(np.clip(solcast_meta.get("coverage_ratio", 0.0), 0.0, 1.0))
    resolution_weight = float(
        np.clip(
            solcast_meta.get("resolution_weight_mean", SOLCAST_RESOLUTION_WEIGHT_FALLBACK),
            0.0,
            1.0,
        )
    )
    resolution_authority = (
        SOLCAST_RESOLUTION_AUTHORITY_MIN
        + (SOLCAST_RESOLUTION_AUTHORITY_MAX - SOLCAST_RESOLUTION_AUTHORITY_MIN) * resolution_weight
    )
    damp = 1.0 - 0.70 * mean_blend * (0.35 + 0.65 * reliability) * (0.55 + 0.45 * coverage) * resolution_authority
    damp = float(np.clip(damp, SOLCAST_RESIDUAL_DAMP_MIN, SOLCAST_RESIDUAL_DAMP_MAX))
    if bool(solcast_meta.get("primary_mode")):
        damp = min(damp, SOLCAST_RESIDUAL_PRIMARY_CAP)
    return float(damp)


# ============================================================================
# CONFIDENCE BANDS
# ============================================================================

def confidence_bands(
    values: np.ndarray,
    w5: pd.DataFrame,
    day: str,
    regime_confidence: float = 1.0,
    error_class_meta: dict | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Per-slot confidence bands based on:
      - base uncertainty (Â±CONF_CLEAR_BASE on clear days)
      - cloud volatility index
      - cloud cover level
      - time-of-day (lower confidence at dawn/dusk)
    """
    stats = analyse_weather_day(day, w5)
    lo    = np.zeros(SLOTS_DAY)
    hi    = np.zeros(SLOTS_DAY)
    confidence_penalty = float(np.clip(1.0 - float(regime_confidence), 0.0, 0.4))
    if error_class_meta:
        class_confidence = np.asarray(error_class_meta.get("confidence"), dtype=float).reshape(-1)
        severe_probability = np.asarray(error_class_meta.get("severe_probability"), dtype=float).reshape(-1)
    else:
        class_confidence = np.ones(SLOTS_DAY, dtype=float)
        severe_probability = np.zeros(SLOTS_DAY, dtype=float)
    if class_confidence.size < SLOTS_DAY:
        class_confidence = np.pad(class_confidence, (0, SLOTS_DAY - class_confidence.size), constant_values=1.0)
    class_confidence = class_confidence[:SLOTS_DAY]
    if severe_probability.size < SLOTS_DAY:
        severe_probability = np.pad(severe_probability, (0, SLOTS_DAY - severe_probability.size), constant_values=0.0)
    severe_probability = severe_probability[:SLOTS_DAY]

    geo   = solar_geometry(day)
    solar_prog = np.clip(
        (np.arange(SLOTS_DAY) - SOLAR_START_SLOT) / max(SOLAR_SLOTS - 1, 1), 0, 1
    )
    # Time-of-day uncertainty (dawn/dusk Ã—1.6, noon Ã—1.0)
    tod_factor = 1.0 + 0.6 * (1 - np.sin(np.pi * solar_prog))

    for i in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
        v = values[i]
        if v <= 0:
            continue

        cloud_i  = w5["cloud"].values[i]
        # Additional uncertainty from cloud layer presence
        cloud_unc = CONF_CLOUD_ADD * np.clip((cloud_i - 30) / 70.0, 0, 1)
        classifier_unc = ERROR_CLASS_CONF_BAND_ADD_MAX * np.clip(1.0 - class_confidence[i], 0.0, 1.0)
        severe_unc = ERROR_CLASS_SEVERE_BAND_ADD_MAX * np.clip(severe_probability[i], 0.0, 1.0)
        conf      = (CONF_CLEAR_BASE + cloud_unc + confidence_penalty * 0.12 + classifier_unc + severe_unc) * tod_factor[i]
        conf      = min(conf, 0.40)   # cap at Â±40%

        lo[i] = v * (1.0 - conf)
        hi[i] = v * (1.0 + conf)

    return lo, hi


# ============================================================================
# FORECAST QUALITY METRICS  (logged after each run)
# ============================================================================

def compute_forecast_metrics(
    actual: np.ndarray | None,
    forecast: np.ndarray | None,
    actual_present: np.ndarray | None = None,
    forecast_present: np.ndarray | None = None,
    exclude_mask: np.ndarray | None = None,
) -> dict | None:
    """Compute solar-window forecast metrics on usable 5-minute slots only."""
    if actual is None or forecast is None:
        return None

    actual_arr = np.nan_to_num(np.asarray(actual, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    forecast_arr = np.nan_to_num(np.asarray(forecast, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    if actual_arr.size < SLOTS_DAY or forecast_arr.size < SLOTS_DAY:
        return None
    if actual_present is None:
        actual_present_arr = np.ones(SLOTS_DAY, dtype=bool)
    else:
        actual_present_arr = np.asarray(actual_present, dtype=bool)
        if actual_present_arr.size < SLOTS_DAY:
            return None
    if forecast_present is None:
        forecast_present_arr = np.ones(SLOTS_DAY, dtype=bool)
    else:
        forecast_present_arr = np.asarray(forecast_present, dtype=bool)
        if forecast_present_arr.size < SLOTS_DAY:
            return None
    if exclude_mask is None:
        exclude_arr = np.zeros(SLOTS_DAY, dtype=bool)
    else:
        exclude_arr = np.asarray(exclude_mask, dtype=bool)
        if exclude_arr.size < SLOTS_DAY:
            return None

    solar_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) &
        (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )
    usable_mask = solar_mask & actual_present_arr & forecast_present_arr & (~exclude_arr)
    if not np.any(usable_mask):
        return None

    act_s = np.clip(actual_arr[usable_mask], 0.0, None)
    fc_s = np.clip(forecast_arr[usable_mask], 0.0, None)
    err = fc_s - act_s
    abs_err = np.abs(err)
    actual_total = float(act_s.sum())
    forecast_total = float(fc_s.sum())

    actual_eval = actual_arr.copy()
    forecast_eval = forecast_arr.copy()
    actual_eval[~usable_mask] = 0.0
    forecast_eval[~usable_mask] = 0.0
    first_actual = _find_first_active_slot(actual_eval)
    first_forecast = _find_first_active_slot(forecast_eval)
    last_actual = _find_last_active_slot(actual_eval)
    last_forecast = _find_last_active_slot(forecast_eval)

    return {
        "slot_count": int(np.count_nonzero(solar_mask)),
        "usable_slot_count": int(np.count_nonzero(usable_mask)),
        "masked_slot_count": int(np.count_nonzero(solar_mask & (~usable_mask))),
        "operational_masked_slot_count": int(np.count_nonzero(solar_mask & exclude_arr)),
        "missing_actual_slot_count": int(np.count_nonzero(solar_mask & (~actual_present_arr))),
        "missing_forecast_slot_count": int(np.count_nonzero(solar_mask & (~forecast_present_arr))),
        "actual_total_kwh": actual_total,
        "forecast_total_kwh": forecast_total,
        "abs_error_sum_kwh": float(abs_err.sum()),
        "mae_kwh": float(np.mean(abs_err)),
        "mbe_kwh": float(np.mean(err)),
        "rmse_kwh": float(np.sqrt(np.mean(err ** 2))),
        "mape_pct": float(np.mean(abs_err / np.maximum(act_s, 1.0)) * 100.0),
        "wape_pct": float((abs_err.sum() / max(actual_total, 1.0)) * 100.0),
        "total_ape_pct": float((abs(forecast_total - actual_total) / max(actual_total, 1.0)) * 100.0),
        "first_active_slot_actual": first_actual,
        "first_active_slot_forecast": first_forecast,
        "last_active_slot_actual": last_actual,
        "last_active_slot_forecast": last_forecast,
        "first_active_error_min": None if first_actual is None or first_forecast is None else int((first_forecast - first_actual) * SLOT_MIN),
        "last_active_error_min": None if last_actual is None or last_forecast is None else int((last_forecast - last_actual) * SLOT_MIN),
    }


def compute_bucketed_forecast_metrics(
    actual: np.ndarray | None,
    forecast: np.ndarray | None,
    bucket_labels: np.ndarray | list[str] | None,
    actual_present: np.ndarray | None = None,
    forecast_present: np.ndarray | None = None,
    exclude_mask: np.ndarray | None = None,
) -> dict[str, dict]:
    if bucket_labels is None:
        return {}
    labels = np.asarray(bucket_labels, dtype=object).reshape(-1)
    if labels.size < SLOTS_DAY:
        return {}
    if exclude_mask is None:
        base_exclude = np.zeros(SLOTS_DAY, dtype=bool)
    else:
        base_exclude = np.asarray(exclude_mask, dtype=bool)
        if base_exclude.size < SLOTS_DAY:
            return {}
    out = {}
    bucket_names = sorted({
        str(label)
        for label in labels[SOLAR_START_SLOT:SOLAR_END_SLOT]
        if str(label) and str(label) != "offsolar"
    })
    for bucket in bucket_names:
        bucket_exclude = np.asarray(base_exclude, dtype=bool).copy()
        bucket_exclude |= labels[:SLOTS_DAY] != bucket
        metrics = compute_forecast_metrics(
            actual,
            forecast,
            actual_present=actual_present,
            forecast_present=forecast_present,
            exclude_mask=bucket_exclude,
        )
        if metrics and int(metrics.get("usable_slot_count", 0)) > 0:
            out[bucket] = metrics
    return out


def compute_error_class_metrics(
    actual: np.ndarray | None,
    hybrid_baseline: np.ndarray | None,
    predicted_labels: np.ndarray | list[int] | None,
    class_confidence: np.ndarray | list[float] | None = None,
    actual_present: np.ndarray | None = None,
    exclude_mask: np.ndarray | None = None,
) -> dict | None:
    if actual is None or hybrid_baseline is None or predicted_labels is None:
        return None
    actual_arr = np.asarray(actual, dtype=float).reshape(-1)
    hybrid_arr = np.asarray(hybrid_baseline, dtype=float).reshape(-1)
    pred_arr = np.asarray(predicted_labels, dtype=int).reshape(-1)
    if actual_arr.size < SLOTS_DAY or hybrid_arr.size < SLOTS_DAY or pred_arr.size < SLOTS_DAY:
        return None
    if actual_present is None:
        actual_present_arr = np.ones(SLOTS_DAY, dtype=bool)
    else:
        actual_present_arr = np.asarray(actual_present, dtype=bool)
        if actual_present_arr.size < SLOTS_DAY:
            return None
    if exclude_mask is None:
        exclude_arr = np.zeros(SLOTS_DAY, dtype=bool)
    else:
        exclude_arr = np.asarray(exclude_mask, dtype=bool)
        if exclude_arr.size < SLOTS_DAY:
            return None
    if class_confidence is None:
        conf_arr = np.zeros(SLOTS_DAY, dtype=float)
    else:
        conf_arr = np.asarray(class_confidence, dtype=float).reshape(-1)
        if conf_arr.size < SLOTS_DAY:
            return None

    usable_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
        & actual_present_arr
        & (~exclude_arr)
    )
    if not np.any(usable_mask):
        return None

    actual_labels = classify_residual_error_classes(
        actual_arr[:SLOTS_DAY] - hybrid_arr[:SLOTS_DAY],
        baseline_kwh=hybrid_arr[:SLOTS_DAY],
    )
    pred_sign = _error_class_sign(pred_arr[:SLOTS_DAY])
    actual_sign = _error_class_sign(actual_labels)
    sign_hit = float(np.mean(pred_sign[usable_mask] == actual_sign[usable_mask]))
    exact_hit = float(np.mean(pred_arr[:SLOTS_DAY][usable_mask] == actual_labels[usable_mask]))
    severe_actual_mask = usable_mask & ((actual_labels == 0) | (actual_labels == 4))
    severe_hit = None
    if np.any(severe_actual_mask):
        severe_hit = float(
            np.mean(
                (pred_arr[:SLOTS_DAY][severe_actual_mask] == actual_labels[severe_actual_mask])
                | (
                    (_error_class_sign(pred_arr[:SLOTS_DAY][severe_actual_mask]) == _error_class_sign(actual_labels[severe_actual_mask]))
                    & ((pred_arr[:SLOTS_DAY][severe_actual_mask] == 0) | (pred_arr[:SLOTS_DAY][severe_actual_mask] == 4))
                )
            )
        )
    return {
        "usable_slot_count": int(np.count_nonzero(usable_mask)),
        "sign_hit_rate": sign_hit,
        "exact_hit_rate": exact_hit,
        "severe_hit_rate": severe_hit,
        "mean_confidence": float(np.mean(conf_arr[:SLOTS_DAY][usable_mask])) if np.any(usable_mask) else 0.0,
    }


def summarize_value_by_bucket(values: np.ndarray | None, bucket_labels: np.ndarray | list[str] | None) -> dict[str, dict]:
    if values is None or bucket_labels is None:
        return {}
    value_arr = np.asarray(values, dtype=float).reshape(-1)
    labels = np.asarray(bucket_labels, dtype=object).reshape(-1)
    if value_arr.size < SLOTS_DAY or labels.size < SLOTS_DAY:
        return {}
    out = {}
    solar_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
        & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )
    for bucket in sorted({
        str(label)
        for label in labels[SOLAR_START_SLOT:SOLAR_END_SLOT]
        if str(label) and str(label) != "offsolar"
    }):
        slot_mask = solar_mask & (labels[:SLOTS_DAY] == bucket)
        if not np.any(slot_mask):
            continue
        out[bucket] = {
            "slot_count": int(np.count_nonzero(slot_mask)),
            "total_kwh": float(np.sum(value_arr[slot_mask])),
            "mean_kwh": float(np.mean(value_arr[slot_mask])),
        }
    return out


def _format_bucket_metric_summary(bucket_metrics: dict[str, dict] | None) -> str:
    if not bucket_metrics:
        return "n/a"
    parts = []
    for bucket, metrics in sorted(bucket_metrics.items()):
        parts.append(f"{bucket}:WAPE={float(metrics.get('wape_pct', 0.0)):.1f}%")
    return ", ".join(parts) if parts else "n/a"


def _format_minutes(value: int | None) -> str:
    if value is None:
        return "n/a"
    return f"{int(value):+d}m"


def _fetch_run_audit_meta(target_date: str) -> dict:
    fallback = {
        "run_audit_id": 0,
        "generator_mode": "",
        "provider_used": "unknown",
        "provider_expected": "",
        "forecast_variant": "",
        "weather_source": "",
        "solcast_freshness_class": "",
    }
    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            row = conn.execute(
                """
                SELECT id, generator_mode, provider_used, provider_expected,
                       forecast_variant, weather_source, solcast_freshness_class
                  FROM forecast_run_audit
                 WHERE target_date = ?
                   AND run_status = 'success'
                 ORDER BY is_authoritative_runtime DESC, generated_ts DESC
                 LIMIT 1
                """,
                (target_date,)
            ).fetchone()
            if not row:
                row = conn.execute(
                    """
                    SELECT id, generator_mode, provider_used, provider_expected,
                           forecast_variant, weather_source, solcast_freshness_class
                      FROM forecast_run_audit
                     WHERE target_date = ?
                     ORDER BY generated_ts DESC
                     LIMIT 1
                    """,
                    (target_date,)
                ).fetchone()
            if row:
                return {
                    "run_audit_id": int(row[0] or 0),
                    "generator_mode": str(row[1] or ""),
                    "provider_used": str(row[2] or "unknown"),
                    "provider_expected": str(row[3] or ""),
                    "forecast_variant": str(row[4] or ""),
                    "weather_source": str(row[5] or ""),
                    "solcast_freshness_class": str(row[6] or ""),
                }
    except Exception as e:
        log.warning("Failed to fetch run audit for %s: %s", target_date, e)
    return fallback


def _memory_source_weight(forecast_variant: str, provider_expected: str) -> float:
    variant = str(forecast_variant or "").strip().lower()
    expected = str(provider_expected or "").strip().lower()
    if variant == "solcast_direct":
        return 1.00
    if variant == "ml_solcast_hybrid_fresh":
        return 0.95
    if variant == "ml_solcast_hybrid_stale":
        return 0.35 if expected in {"solcast", "ml_local"} else 0.60
    if variant == "ml_without_solcast":
        return 0.20 if expected in {"solcast", "ml_local"} else 0.50
    return 0.50


def _persist_qa_comparison(
    target_date: str,
    run_audit_meta: dict,
    daily_metrics: dict,
    fc_slots: np.ndarray,
    actual_slots: np.ndarray,
    usable_mask: np.ndarray,
    actual_present: np.ndarray,
    forecast_present: np.ndarray,
    operational_mask: np.ndarray,
    manual_constraint_mask: np.ndarray,
    cap_dispatch_mask: np.ndarray,
    slot_weather_buckets: np.ndarray | None = None,
    day_regime: str = "",
    solcast_slots: np.ndarray | None = None,
    solcast_present: np.ndarray | None = None,
    hybrid_baseline_slots: np.ndarray | None = None,
    rad_slots: np.ndarray | None = None,
    cloud_slots: np.ndarray | None = None,
) -> None:
    provider_used = str((run_audit_meta or {}).get("provider_used") or "unknown")
    provider_expected = str((run_audit_meta or {}).get("provider_expected") or "")
    forecast_variant = str((run_audit_meta or {}).get("forecast_variant") or "")
    if provider_used == "unknown":
        return

    run_audit_id = int((run_audit_meta or {}).get("run_audit_id") or 0)
    generator_mode = str((run_audit_meta or {}).get("generator_mode") or "")
    weather_source = str((run_audit_meta or {}).get("weather_source") or "")
    solcast_freshness_class = str((run_audit_meta or {}).get("solcast_freshness_class") or "")

    actual_present_arr = np.asarray(actual_present, dtype=bool)
    forecast_present_arr = np.asarray(forecast_present, dtype=bool)
    usable_arr = np.asarray(usable_mask, dtype=bool)
    manual_arr = np.asarray(manual_constraint_mask, dtype=bool)
    cap_arr = np.asarray(cap_dispatch_mask, dtype=bool)
    operational_arr = np.asarray(operational_mask, dtype=bool)

    solar_slice = slice(SOLAR_START_SLOT, SOLAR_END_SLOT)
    usable_slots = int(np.count_nonzero(usable_arr[solar_slice]))
    actual_slots_count = int(np.count_nonzero(actual_present_arr[solar_slice]))
    forecast_slots_count = int(np.count_nonzero(forecast_present_arr[solar_slice]))
    manual_slots_count = int(np.count_nonzero(manual_arr[solar_slice]))
    cap_slots_count = int(np.count_nonzero(cap_arr[solar_slice]))
    operational_slots_count = int(np.count_nonzero(operational_arr[solar_slice]))
    masked_slots_count = int(np.count_nonzero((~usable_arr)[solar_slice]))
    solar_slot_count = max(1, SOLAR_END_SLOT - SOLAR_START_SLOT)
    constrained_ratio = float((manual_slots_count + cap_slots_count) / solar_slot_count)
    degraded_variant = (
        forecast_variant in {"ml_without_solcast", "ml_solcast_hybrid_stale"}
        and solcast_freshness_class != "not_expected"
    )
    provider_mismatch = provider_expected == "solcast" and forecast_variant != "solcast_direct"

    include_in_source_scoring = (
        actual_slots_count >= 150
        and forecast_slots_count >= 150
    )
    include_in_error_memory = (
        include_in_source_scoring
        and usable_slots >= 150
        and constrained_ratio <= 0.25
        and not provider_mismatch
        and solcast_freshness_class not in {"missing", "stale_reject"}
        and not degraded_variant
    )
    comparison_quality = "eligible" if include_in_error_memory else ("review" if include_in_source_scoring else "insufficient")

    total_forecast_kwh = float((daily_metrics or {}).get("forecast_total_kwh", 0.0))
    total_actual_kwh = float((daily_metrics or {}).get("actual_total_kwh", 0.0))
    daily_wape_pct = float((daily_metrics or {}).get("wape_pct", 0.0))
    daily_mape_pct = float((daily_metrics or {}).get("mape_pct", 0.0))
    daily_total_ape_pct = float((daily_metrics or {}).get("total_ape_pct", 0.0)
                                if (daily_metrics or {}).get("total_ape_pct") is not None else 0.0)
    total_abs_error_kwh = float((daily_metrics or {}).get("abs_error_sum_kwh", 0.0))

    support_base = _memory_source_weight(forecast_variant, provider_expected)
    slot_bucket_arr = np.asarray(slot_weather_buckets, dtype=object) if slot_weather_buckets is not None else np.asarray([""] * SLOTS_DAY, dtype=object)
    solcast_arr = np.asarray(solcast_slots, dtype=float) if solcast_slots is not None else np.zeros(SLOTS_DAY, dtype=float)
    solcast_present_arr = np.asarray(solcast_present, dtype=bool) if solcast_present is not None else np.zeros(SLOTS_DAY, dtype=bool)
    hybrid_arr = np.asarray(hybrid_baseline_slots, dtype=float) if hybrid_baseline_slots is not None else np.full(SLOTS_DAY, np.nan, dtype=float)
    rad_arr = np.asarray(rad_slots, dtype=float) if rad_slots is not None else np.full(SLOTS_DAY, np.nan, dtype=float)
    cloud_arr = np.asarray(cloud_slots, dtype=float) if cloud_slots is not None else np.full(SLOTS_DAY, np.nan, dtype=float)

    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC) as conn:
            daily_table_info = conn.execute("PRAGMA table_info(forecast_error_compare_daily)").fetchall()
            slot_table_info = conn.execute("PRAGMA table_info(forecast_error_compare_slot)").fetchall()
            daily_target_pk = any(str(row[1] or "") == "target_date" and int(row[5] or 0) == 1 for row in daily_table_info)
            slot_legacy_pk = (
                any(str(row[1] or "") == "target_date" and int(row[5] or 0) == 1 for row in slot_table_info)
                and any(str(row[1] or "") == "slot" and int(row[5] or 0) == 2 for row in slot_table_info)
            )
            daily_conflict_target = "target_date" if daily_target_pk else "target_date, run_audit_id"
            slot_conflict_target = "target_date, slot" if slot_legacy_pk else "target_date, run_audit_id, slot"

            if daily_target_pk:
                conn.execute("DELETE FROM forecast_error_compare_daily WHERE target_date = ?", (target_date,))

            daily_row = conn.execute(
                f"""
                INSERT INTO forecast_error_compare_daily(
                    target_date, run_audit_id, generator_mode,
                    provider_used, provider_expected, forecast_variant, weather_source, solcast_freshness_class,
                    total_forecast_kwh, total_actual_kwh, total_abs_error_kwh,
                    daily_wape_pct, daily_mape_pct, daily_total_ape_pct,
                    usable_slot_count, masked_slot_count,
                    available_actual_slots, available_forecast_slots,
                    manual_masked_slots, cap_masked_slots, operational_masked_slots,
                    include_in_error_memory, include_in_source_scoring, comparison_quality,
                    computed_ts, notes_json
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT({daily_conflict_target}) DO UPDATE SET
                    run_audit_id=excluded.run_audit_id,
                    generator_mode=excluded.generator_mode,
                    provider_used=excluded.provider_used,
                    provider_expected=excluded.provider_expected,
                    forecast_variant=excluded.forecast_variant,
                    weather_source=excluded.weather_source,
                    solcast_freshness_class=excluded.solcast_freshness_class,
                    total_forecast_kwh=excluded.total_forecast_kwh,
                    total_actual_kwh=excluded.total_actual_kwh,
                    total_abs_error_kwh=excluded.total_abs_error_kwh,
                    daily_wape_pct=excluded.daily_wape_pct,
                    daily_mape_pct=excluded.daily_mape_pct,
                    daily_total_ape_pct=excluded.daily_total_ape_pct,
                    usable_slot_count=excluded.usable_slot_count,
                    masked_slot_count=excluded.masked_slot_count,
                    available_actual_slots=excluded.available_actual_slots,
                    available_forecast_slots=excluded.available_forecast_slots,
                    manual_masked_slots=excluded.manual_masked_slots,
                    cap_masked_slots=excluded.cap_masked_slots,
                    operational_masked_slots=excluded.operational_masked_slots,
                    include_in_error_memory=excluded.include_in_error_memory,
                    include_in_source_scoring=excluded.include_in_source_scoring,
                    comparison_quality=excluded.comparison_quality,
                    computed_ts=excluded.computed_ts,
                    notes_json=excluded.notes_json
                """,
                (
                    target_date, run_audit_id, generator_mode,
                    provider_used, provider_expected, forecast_variant, weather_source, solcast_freshness_class,
                    total_forecast_kwh, total_actual_kwh, total_abs_error_kwh,
                    daily_wape_pct, daily_mape_pct, daily_total_ape_pct,
                    usable_slots, masked_slots_count,
                    actual_slots_count, forecast_slots_count,
                    manual_slots_count, cap_slots_count, operational_slots_count,
                    int(include_in_error_memory), int(include_in_source_scoring), comparison_quality,
                    int(time.time() * 1000),
                    json.dumps({
                        "degraded_variant": bool(degraded_variant),
                        "provider_mismatch": bool(provider_mismatch),
                        "support_base": float(support_base),
                    }),
                )
            )
            daily_compare_id = int(daily_row.lastrowid or 0)

            if slot_legacy_pk:
                conn.execute("DELETE FROM forecast_error_compare_slot WHERE target_date = ?", (target_date,))
            else:
                conn.execute(
                    "DELETE FROM forecast_error_compare_slot WHERE target_date = ? AND run_audit_id = ?",
                    (target_date, run_audit_id),
                )
            slot_rows = []
            for slot in range(SOLAR_START_SLOT, SOLAR_END_SLOT):
                ts_local = int((datetime.fromisoformat(target_date) + timedelta(minutes=slot * SLOT_MIN)).timestamp() * 1000)
                hh = (slot * SLOT_MIN) // 60
                mm = (slot * SLOT_MIN) % 60
                time_hms = f"{int(hh):02d}:{int(mm):02d}:00"
                fc_val = float(fc_slots[slot])
                act_present = bool(actual_present_arr[slot])
                fc_present = bool(forecast_present_arr[slot])
                act_val = float(actual_slots[slot]) if act_present else None
                signed_err = (float(act_val) - fc_val) if (act_present and fc_present) else None
                abs_err = abs(signed_err) if signed_err is not None else None
                ape = (abs_err / max(abs(float(act_val)), 1.0) * 100.0) if (abs_err is not None and act_present) else None
                opportunity = float(max(fc_val, 1.0))
                normalized = (signed_err / max(opportunity, 1.0)) if signed_err is not None else None
                slot_bucket = str(slot_bucket_arr[slot] or "")
                support_weight = support_base
                if opportunity < 2.0:
                    support_weight *= 0.6
                if slot_bucket in {"storm_risk", "rain_heavy"}:
                    support_weight *= 0.75

                usable_metrics = bool(usable_arr[slot])
                usable_mem = bool(
                    usable_metrics
                    and include_in_error_memory
                    and (not manual_arr[slot])
                    and (not cap_arr[slot])
                    and (not operational_arr[slot])
                    and fc_present
                    and act_present
                )
                slot_rows.append((
                    target_date, run_audit_id, daily_compare_id, slot, ts_local, time_hms,
                    provider_used, fc_val, act_val,
                    float(solcast_arr[slot]) if bool(solcast_present_arr[slot]) else None,
                    None,
                    float(hybrid_arr[slot]) if np.isfinite(hybrid_arr[slot]) else None,
                    None, None, None,
                    signed_err, abs_err, ape, normalized, opportunity,
                    slot_bucket, str(day_regime or ""),
                    int(act_present), int(fc_present), int(bool(solcast_present_arr[slot])),
                    int(usable_metrics), int(usable_mem),
                    int(bool(manual_arr[slot])), int(bool(cap_arr[slot])), 0, int(bool(operational_arr[slot])), 1,
                    float(rad_arr[slot]) if np.isfinite(rad_arr[slot]) else None,
                    float(cloud_arr[slot]) if np.isfinite(cloud_arr[slot]) else None,
                    float(max(0.0, min(1.0, support_weight))),
                ))

            if slot_rows:
                conn.executemany(
                    f"""
                    INSERT INTO forecast_error_compare_slot(
                        target_date, run_audit_id, daily_compare_id, slot, ts_local, time_hms,
                        provider_used, forecast_kwh, actual_kwh, solcast_kwh, physics_kwh, hybrid_baseline_kwh,
                        ml_residual_kwh, error_class_bias_kwh, memory_bias_kwh,
                        signed_error_kwh, abs_error_kwh, ape_pct, normalized_error, opportunity_kwh,
                        slot_weather_bucket, day_regime,
                        actual_present, forecast_present, solcast_present,
                        usable_for_metrics, usable_for_error_memory,
                        manual_constraint_mask, cap_dispatch_mask, curtailed_mask, operational_mask, solar_mask,
                        rad_wm2, cloud_pct, support_weight
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT({slot_conflict_target}) DO UPDATE SET
                        run_audit_id=excluded.run_audit_id,
                        daily_compare_id=excluded.daily_compare_id,
                        ts_local=excluded.ts_local,
                        time_hms=excluded.time_hms,
                        provider_used=excluded.provider_used,
                        forecast_kwh=excluded.forecast_kwh,
                        actual_kwh=excluded.actual_kwh,
                        solcast_kwh=excluded.solcast_kwh,
                        physics_kwh=excluded.physics_kwh,
                        hybrid_baseline_kwh=excluded.hybrid_baseline_kwh,
                        ml_residual_kwh=excluded.ml_residual_kwh,
                        error_class_bias_kwh=excluded.error_class_bias_kwh,
                        memory_bias_kwh=excluded.memory_bias_kwh,
                        signed_error_kwh=excluded.signed_error_kwh,
                        abs_error_kwh=excluded.abs_error_kwh,
                        ape_pct=excluded.ape_pct,
                        normalized_error=excluded.normalized_error,
                        opportunity_kwh=excluded.opportunity_kwh,
                        slot_weather_bucket=excluded.slot_weather_bucket,
                        day_regime=excluded.day_regime,
                        actual_present=excluded.actual_present,
                        forecast_present=excluded.forecast_present,
                        solcast_present=excluded.solcast_present,
                        usable_for_metrics=excluded.usable_for_metrics,
                        usable_for_error_memory=excluded.usable_for_error_memory,
                        manual_constraint_mask=excluded.manual_constraint_mask,
                        cap_dispatch_mask=excluded.cap_dispatch_mask,
                        curtailed_mask=excluded.curtailed_mask,
                        operational_mask=excluded.operational_mask,
                        solar_mask=excluded.solar_mask,
                        rad_wm2=excluded.rad_wm2,
                        cloud_pct=excluded.cloud_pct,
                        support_weight=excluded.support_weight
                    """,
                    slot_rows
                )
            conn.commit()
    except Exception as e:
        log.warning("Failed to persist forecast comparison for %s: %s", target_date, e)


def forecast_qa(today: date) -> None:
    """
    Compute and log forecast accuracy and skill score vs persistence for yesterday.
    Persistence forecast = yesterday's actual shifted to today.
    """
    yesterday = (today - timedelta(days=1)).isoformat()
    day2ago   = (today - timedelta(days=2)).isoformat()

    actual, actual_present = load_actual_loss_adjusted_with_presence(yesterday)
    fc, fc_present = load_dayahead_with_presence(yesterday)
    pers, pers_present = load_actual_loss_adjusted_with_presence(day2ago)   # persistence proxy

    if (
        actual is None
        or fc is None
        or actual_present is None
        or fc_present is None
    ):
        log.info("QA: no data for %s", yesterday)
        return

    _, constraint_meta = build_operational_constraint_mask(yesterday)
    exclude_mask = np.asarray(constraint_meta.get("operational_mask"), dtype=bool)
    metrics = compute_forecast_metrics(
        actual,
        fc,
        actual_present=actual_present,
        forecast_present=fc_present,
        exclude_mask=exclude_mask,
    )
    if metrics is None:
        return

    pers_metrics = (
        compute_forecast_metrics(
            actual,
            pers,
            actual_present=actual_present,
            forecast_present=pers_present,
            exclude_mask=exclude_mask,
        )
        if pers is not None and pers_present is not None
        else None
    )
    if pers_metrics is not None and pers_metrics["rmse_kwh"] > 0:
        skill = 1.0 - metrics["rmse_kwh"] / max(pers_metrics["rmse_kwh"], 1.0)
    else:
        skill = float("nan")

    bucket_labels = None
    weather_5min = None
    hybrid_baseline_slots = None
    classifier_metrics = None
    snapshot = load_forecast_weather_snapshot(yesterday)
    snapshot_meta = snapshot.get("meta") if isinstance(snapshot, dict) else {}
    error_debug = snapshot_meta.get("error_class_debug") if isinstance(snapshot_meta, dict) else {}
    if isinstance(error_debug, dict):
        debug_buckets = error_debug.get("slot_weather_buckets")
        if isinstance(debug_buckets, list) and len(debug_buckets) >= SLOTS_DAY:
            bucket_labels = np.asarray(debug_buckets[:SLOTS_DAY], dtype=object)
        hybrid_debug = error_debug.get("hybrid_baseline_kwh")
        if isinstance(hybrid_debug, list) and len(hybrid_debug) >= SLOTS_DAY:
            hybrid_baseline_slots = np.asarray(hybrid_debug[:SLOTS_DAY], dtype=float)
        predicted_debug = error_debug.get("predicted_labels")
        confidence_debug = error_debug.get("class_confidence")
        if (
            isinstance(hybrid_debug, list)
            and len(hybrid_debug) >= SLOTS_DAY
            and isinstance(predicted_debug, list)
            and len(predicted_debug) >= SLOTS_DAY
        ):
            classifier_metrics = compute_error_class_metrics(
                actual,
                np.asarray(hybrid_debug[:SLOTS_DAY], dtype=float),
                np.asarray(predicted_debug[:SLOTS_DAY], dtype=int),
                class_confidence=np.asarray(confidence_debug[:SLOTS_DAY], dtype=float) if isinstance(confidence_debug, list) and len(confidence_debug) >= SLOTS_DAY else None,
                actual_present=actual_present,
                exclude_mask=exclude_mask,
            )
    if bucket_labels is None:
        weather_hourly = load_forecast_weather_for_day(yesterday)
        if weather_hourly is not None and not weather_hourly.empty:
            weather_5min = interpolate_5min(weather_hourly, yesterday)
            bucket_labels = classify_slot_weather_buckets(weather_5min, yesterday)
    if weather_5min is None:
        weather_hourly = load_forecast_weather_for_day(yesterday)
        if weather_hourly is not None and not weather_hourly.empty:
            weather_5min = interpolate_5min(weather_hourly, yesterday)
    bucket_metrics = compute_bucketed_forecast_metrics(
        actual,
        fc,
        bucket_labels,
        actual_present=actual_present,
        forecast_present=fc_present,
        exclude_mask=exclude_mask,
    ) if bucket_labels is not None else {}
    solcast_metrics = None
    solcast_bucket_metrics = {}
    solcast_snapshot = load_solcast_snapshot(yesterday)
    solcast_forecast = np.zeros(SLOTS_DAY, dtype=float)
    solcast_present = np.zeros(SLOTS_DAY, dtype=bool)
    if solcast_snapshot:
        solcast_forecast = np.clip(np.asarray(solcast_snapshot.get("forecast_kwh"), dtype=float), 0.0, None)
        solcast_present = np.asarray(solcast_snapshot.get("present"), dtype=bool)
        solcast_metrics = compute_forecast_metrics(
            actual,
            solcast_forecast,
            actual_present=actual_present,
            forecast_present=solcast_present,
            exclude_mask=exclude_mask,
        )
        solcast_bucket_metrics = compute_bucketed_forecast_metrics(
            actual,
            solcast_forecast,
            bucket_labels,
            actual_present=actual_present,
            forecast_present=solcast_present,
            exclude_mask=exclude_mask,
        ) if bucket_labels is not None else {}
    day_regime = str(
        snapshot_meta.get("target_regime")
        or ((snapshot.get("applied_signature") or {}).get("day_regime") if isinstance(snapshot, dict) else "")
        or ((snapshot.get("signature") or {}).get("day_regime") if isinstance(snapshot, dict) else "")
        or ""
    )

    run_audit_meta = _fetch_run_audit_meta(yesterday)
    actual_present_arr = np.asarray(actual_present, dtype=bool)
    fc_present_arr = np.asarray(fc_present, dtype=bool)
    exclude_arr = np.asarray(exclude_mask, dtype=bool)
    manual_mask_arr = np.asarray(constraint_meta.get("manual_constraint_mask"), dtype=bool)
    cap_mask_arr = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool)
    usable_mask = actual_present_arr & fc_present_arr & (~exclude_arr)

    rad_slots = None
    cloud_slots = None
    if weather_5min is not None and not weather_5min.empty:
        rad_slots = pd.to_numeric(weather_5min.get("rad"), errors="coerce").fillna(0.0).values
        cloud_slots = pd.to_numeric(weather_5min.get("cloud"), errors="coerce").fillna(0.0).values

    _persist_qa_comparison(
        yesterday,
        run_audit_meta,
        metrics,
        fc,
        actual,
        usable_mask,
        actual_present_arr,
        fc_present_arr,
        exclude_arr,
        manual_mask_arr,
        cap_mask_arr,
        slot_weather_buckets=bucket_labels,
        day_regime=day_regime,
        solcast_slots=solcast_forecast,
        solcast_present=solcast_present,
        hybrid_baseline_slots=hybrid_baseline_slots,
        rad_slots=rad_slots,
        cloud_slots=cloud_slots,
    )

    resolution_debug = _build_resolution_daily_record(
        yesterday,
        day_regime,
        solcast_metrics,
        metrics,
        solcast_bucket_metrics,
        bucket_metrics,
    )
    overall_resolution = resolution_debug.get("overall") if isinstance(resolution_debug.get("overall"), dict) else {}
    if overall_resolution.get("solcast") or overall_resolution.get("dayahead"):
        update_forecast_weather_snapshot_meta(yesterday, {"resolution_debug": resolution_debug})

    log.info(
        "QA [%s] usable=%d masked=%d WAPE=%.1f%% MAPE=%.1f%% TotalAPE=%.1f%% MBE=%.1f kWh/slot RMSE=%.1f kWh/slot First=%s Last=%s Skill=%.3f",
        yesterday,
        metrics["usable_slot_count"],
        metrics["masked_slot_count"],
        metrics["wape_pct"],
        metrics["mape_pct"],
        metrics["total_ape_pct"],
        metrics["mbe_kwh"],
        metrics["rmse_kwh"],
        _format_minutes(metrics["first_active_error_min"]),
        _format_minutes(metrics["last_active_error_min"]),
        skill,
    )
    log.info("QA weather buckets [%s] %s", yesterday, _format_bucket_metric_summary(bucket_metrics))
    if overall_resolution:
        log.info(
            "QA resolution [%s] winner=%s solcast_weight=%.2f support_days=%d",
            yesterday,
            overall_resolution.get("preferred_source"),
            float(overall_resolution.get("solcast_weight", SOLCAST_RESOLUTION_WEIGHT_FALLBACK)),
            int(overall_resolution.get("support_days", 0)),
        )
    if classifier_metrics is not None:
        log.info(
            "QA classifier [%s] sign_hit=%.3f exact_hit=%.3f severe_hit=%s mean_conf=%.2f",
            yesterday,
            float(classifier_metrics.get("sign_hit_rate", 0.0)),
            float(classifier_metrics.get("exact_hit_rate", 0.0)),
            f"{float(classifier_metrics['severe_hit_rate']):.3f}" if classifier_metrics.get("severe_hit_rate") is not None else "n/a",
            float(classifier_metrics.get("mean_confidence", 0.0)),
        )


# ============================================================================
# OUTPUT SERIALISER
# ============================================================================

def to_ui_series(
    values: np.ndarray,
    lo: np.ndarray,
    hi: np.ndarray,
    day: str,
) -> list[dict]:
    base_time = datetime.fromisoformat(day) + timedelta(hours=SOLAR_START_H)
    solar_vals = values[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_lo   = lo[SOLAR_START_SLOT:SOLAR_END_SLOT]
    solar_hi   = hi[SOLAR_START_SLOT:SOLAR_END_SLOT]

    return [
        {
            "time":    (base_time + timedelta(minutes=i * SLOT_MIN)).strftime("%H:%M:%S"),
            "kWh_inc": round(float(v),  6),
            "kWh_lo":  round(float(l),  6),
            "kWh_hi":  round(float(h),  6),
        }
        for i, (v, l, h) in enumerate(zip(solar_vals, solar_lo, solar_hi))
    ]


def _forecast_table_name_for_key(key: str) -> str | None:
    mapping = {
        "PacEnergy_DayAhead": "forecast_dayahead",
        "PacEnergy_IntradayAdjusted": "forecast_intraday_adjusted",
    }
    return mapping.get(str(key or "").strip())


def _ensure_forecast_table(conn: sqlite3.Connection, table_name: str) -> None:
    index_prefix = "fd" if table_name == "forecast_dayahead" else "fia"
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            date       TEXT NOT NULL,
            ts         INTEGER NOT NULL,
            slot       INTEGER NOT NULL,
            time_hms   TEXT NOT NULL,
            kwh_inc    REAL NOT NULL DEFAULT 0,
            kwh_lo     REAL DEFAULT 0,
            kwh_hi     REAL DEFAULT 0,
            source     TEXT DEFAULT 'service',
            updated_ts INTEGER NOT NULL,
            PRIMARY KEY(date, slot)
        )
        """
    )
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{index_prefix}_ts ON {table_name}(ts)")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{index_prefix}_date_ts ON {table_name}(date, ts)")


def _write_forecast_db(key: str, day: str, series: list[dict]) -> bool:
    """
    Persist day-ahead slots to SQLite so forecast data is unified with AppData DB.
    Keeps file write path for compatibility while DB is now the source of truth.
    """
    table_name = _forecast_table_name_for_key(key)
    if table_name is None:
        return True
    if not series:
        return True

    try:
        day_dt = datetime.fromisoformat(day)
    except Exception:
        log.error("DB forecast write skipped: invalid day=%s", day)
        return False

    rows = []
    for rec in series:
        t = str(rec.get("time", "")).strip()
        try:
            hh, mm, ss = [int(x) for x in t.split(":")]
        except Exception:
            continue
        ts = int(datetime(day_dt.year, day_dt.month, day_dt.day, hh, mm, ss).timestamp() * 1000)
        slot = int((hh * 60 + mm) // SLOT_MIN)
        if slot < 0 or slot >= SLOTS_DAY:
            continue
        rows.append(
            (
                str(day),
                ts,
                slot,
                f"{hh:02d}:{mm:02d}:{ss:02d}",
                float(rec.get("kWh_inc", rec.get("kwh_inc", 0)) or 0.0),
                float(rec.get("kWh_lo", rec.get("kwh_lo", 0)) or 0.0),
                float(rec.get("kWh_hi", rec.get("kwh_hi", 0)) or 0.0),
                "service",
                int(time.time() * 1000),
            )
        )

    for attempt in range(1, SQLITE_RETRY_ATTEMPTS + 1):
        try:
            with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC, readonly=False) as conn:
                _ensure_forecast_table(conn, table_name)
                cur = conn.cursor()
                cur.execute(f"DELETE FROM {table_name} WHERE date=?", (str(day),))
                cur.executemany(
                    f"""
                    INSERT INTO {table_name}
                    (date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(date, slot) DO UPDATE SET
                        ts=excluded.ts,
                        time_hms=excluded.time_hms,
                        kwh_inc=excluded.kwh_inc,
                        kwh_lo=excluded.kwh_lo,
                        kwh_hi=excluded.kwh_hi,
                        source=excluded.source,
                        updated_ts=excluded.updated_ts
                    """,
                    rows,
                )
                conn.commit()
            clear_forecast_data_cache()
            log.info("Wrote forecast DB [%s:%s] - %d slots", key, day, len(rows))
            return True
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB forecast write retry %d/%d for %s:%s: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    key,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.error("DB forecast write failed for %s:%s: %s", key, day, e)
            return False


def _classify_variant_from_solcast_meta(solcast_meta: dict) -> str:
    """Derive forecast_variant string from solcast_meta dict."""
    if not solcast_meta or not bool(solcast_meta.get("used_solcast")):
        return "ml_without_solcast"
    coverage = float(solcast_meta.get("coverage_ratio", 0.0))
    mean_blend = float(solcast_meta.get("mean_blend", 0.0))
    if coverage >= 0.95 and mean_blend >= 0.5:
        return "ml_solcast_hybrid_fresh"
    return "ml_solcast_hybrid_stale"


def _classify_solcast_freshness_python(solcast_meta: dict) -> str:
    """Derive Solcast freshness class from solcast_meta dict."""
    if not solcast_meta or not bool(solcast_meta.get("used_solcast")):
        return "not_expected"
    coverage = float(solcast_meta.get("coverage_ratio", 0.0))
    if coverage >= 0.95:
        return "fresh"
    if coverage >= 0.80:
        return "stale_usable"
    return "stale_reject"


def _write_forecast_run_audit_from_python(
    target_date,
    generator_mode: str,
    weather_source: str,
    solcast_meta: dict,
    forecast_total_kwh: float,
    baseline_total_kwh: float,
    hybrid_total_kwh: float,
    ml_total_kwh: float,
    error_class_total_kwh: float,
    bias_total_kwh: float,
) -> int | None:
    """Write a forecast_run_audit row from Python direct generation path.

    Returns the new row id, or None on exception (logs warning, does not
    fail generation).
    """
    if solcast_meta is None:
        solcast_meta = {}
    target_s = str(target_date)
    variant = _classify_variant_from_solcast_meta(solcast_meta)
    freshness = _classify_solcast_freshness_python(solcast_meta)
    generated_ts = int(time.time() * 1000)

    try:
        with _open_sqlite(APP_DB_FILE, SQLITE_WRITE_TIMEOUT_SEC) as conn:
            # Check for existing authoritative audit row to supersede
            prev_row = conn.execute(
                """
                SELECT id FROM forecast_run_audit
                 WHERE target_date = ?
                   AND is_authoritative_runtime = 1
                   AND run_status = 'success'
                 ORDER BY generated_ts DESC LIMIT 1
                """,
                (target_s,),
            ).fetchone()
            prev_id = int(prev_row[0]) if prev_row else None

            notes = json.dumps({"source": "python_direct", "generator_mode": generator_mode})
            cur = conn.execute(
                """
                INSERT INTO forecast_run_audit(
                    target_date, generated_ts, generator_mode,
                    provider_used, provider_expected,
                    forecast_variant, weather_source,
                    solcast_snapshot_coverage_ratio, solcast_mean_blend,
                    solcast_reliability, solcast_primary_mode, solcast_snapshot_source,
                    physics_total_kwh, hybrid_total_kwh,
                    final_forecast_total_kwh, ml_residual_total_kwh,
                    error_class_total_kwh, bias_total_kwh,
                    shape_skipped_for_solcast,
                    run_status, solcast_freshness_class,
                    is_authoritative_runtime, is_authoritative_learning,
                    replaces_run_audit_id, notes_json
                ) VALUES(
                    ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?,
                    ?, ?,
                    ?, ?,
                    ?, ?
                )
                """,
                (
                    target_s, generated_ts, generator_mode,
                    "ml_local", "ml_local",
                    variant, weather_source,
                    float(solcast_meta.get("coverage_ratio", 0.0)),
                    float(solcast_meta.get("mean_blend", 0.0)),
                    float(solcast_meta.get("reliability", 0.0)),
                    1 if bool(solcast_meta.get("primary_mode")) else 0,
                    str(solcast_meta.get("source", "")),
                    float(baseline_total_kwh),
                    float(hybrid_total_kwh),
                    float(forecast_total_kwh),
                    float(ml_total_kwh),
                    float(error_class_total_kwh),
                    float(bias_total_kwh),
                    1 if bool(solcast_meta.get("used_solcast")) else 0,
                    "success", freshness,
                    1, 1,
                    prev_id, notes,
                ),
            )
            new_id = cur.lastrowid

            # Supersede previous authoritative row
            if prev_id is not None and new_id:
                conn.execute(
                    """
                    UPDATE forecast_run_audit
                       SET is_authoritative_runtime = 0,
                           is_authoritative_learning = 0,
                           superseded_by_run_audit_id = ?,
                           run_status = 'superseded'
                     WHERE id = ?
                    """,
                    (new_id, prev_id),
                )

            conn.commit()
            log.info(
                "Python audit row written for %s: id=%s variant=%s freshness=%s (replaces=%s)",
                target_s, new_id, variant, freshness, prev_id,
            )
            return new_id
    except Exception as e:
        log.warning("Failed to write forecast_run_audit from Python for %s: %s", target_s, e)
        return None


def write_forecast(key: str, day: str, series: list[dict]) -> bool:
    ctx = _load_json(FORECAST_CTX)
    ctx.setdefault(key, {})[day] = series
    ok_file = _save_json(FORECAST_CTX, ctx)
    ok_db = _write_forecast_db(key, day, series)
    if ok_file:
        log.info("Wrote %s[%s] â€“ %d slots", key, day, len(series))
    if ok_db and not ok_file:
        log.warning("Legacy forecast JSON write failed for %s; DB write succeeded and remains authoritative.", day)
    elif ok_file and not ok_db:
        log.warning("Forecast DB write failed for %s; legacy JSON fallback succeeded.", day)
    return bool(ok_db) if _forecast_table_name_for_key(key) is not None else bool(ok_file)


def load_forecast_weather_for_day(day: str) -> pd.DataFrame | None:
    snap = load_forecast_weather_snapshot(day)
    if snap:
        applied = _weather_records_to_frame(list(snap.get("applied_hourly") or []), day)
        if not applied.empty:
            return applied
        raw = _weather_records_to_frame(list(snap.get("raw_hourly") or []), day)
        if not raw.empty:
            return raw
    source = "forecast" if not _is_past_day(day) else "archive"
    return fetch_weather(day, source=source)


def build_intraday_adjusted_forecast(day: date) -> tuple[list[dict] | None, dict]:
    day_s = day.isoformat()
    dayahead, _ = load_dayahead_with_presence(day_s)
    actual, actual_present = load_actual_loss_adjusted_with_presence(day_s)
    _, constraint_meta = build_operational_constraint_mask(day_s)
    operational_mask = np.asarray(constraint_meta.get("operational_mask"), dtype=bool)
    cap_dispatch_mask = np.asarray(constraint_meta.get("cap_dispatch_mask"), dtype=bool)
    meta = {
        "day": day_s,
        "observed_slots": 0,
        "last_observed_slot": None,
        "global_ratio": 1.0,
        "recent_ratio": 1.0,
        "strength": 0.0,
        "constraint_mode": "none",
    }
    if dayahead is None or actual is None or actual_present is None:
        return None, meta

    actual_present_arr = np.asarray(actual_present, dtype=bool)
    unconstrained_mask = actual_present_arr & (~operational_mask)
    cap_free_mask = actual_present_arr & (~cap_dispatch_mask)
    fallback_mask = actual_present_arr.copy()

    def solar_slots(mask: np.ndarray) -> np.ndarray:
        return np.where(np.asarray(mask, dtype=bool)[SOLAR_START_SLOT:SOLAR_END_SLOT])[0] + SOLAR_START_SLOT

    solar_obs = solar_slots(unconstrained_mask)
    constraint_mode = "unconstrained"
    if solar_obs.size < INTRADAY_MIN_OBS_SLOTS:
        solar_obs = solar_slots(cap_free_mask)
        constraint_mode = "cap-free"
    if solar_obs.size < INTRADAY_MIN_OBS_SLOTS:
        solar_obs = solar_slots(fallback_mask)
        constraint_mode = "all-observed"
    if solar_obs.size < INTRADAY_MIN_OBS_SLOTS:
        meta["observed_slots"] = int(solar_obs.size)
        meta["constraint_mode"] = constraint_mode
        return None, meta

    observed_slots = solar_obs[-min(int(solar_obs.size), INTRADAY_MAX_OBS_SLOTS):]
    last_observed_slot = int(observed_slots[-1])
    obs_mask = np.zeros(SLOTS_DAY, dtype=bool)
    obs_mask[observed_slots] = True
    adjusted = np.asarray(dayahead, dtype=float).copy()
    adjusted[actual_present_arr] = np.asarray(actual, dtype=float)[actual_present_arr]

    dayahead_obs_total = float(np.asarray(dayahead, dtype=float)[obs_mask].sum())
    actual_obs_total = float(np.asarray(actual, dtype=float)[obs_mask].sum())
    global_ratio = float(np.clip(actual_obs_total / max(dayahead_obs_total, 1.0), INTRADAY_RATIO_CLIP[0], INTRADAY_RATIO_CLIP[1]))

    recent_slots = observed_slots[-12:]
    recent_mask = np.zeros(SLOTS_DAY, dtype=bool)
    recent_mask[recent_slots] = True
    dayahead_recent_total = float(np.asarray(dayahead, dtype=float)[recent_mask].sum())
    actual_recent_total = float(np.asarray(actual, dtype=float)[recent_mask].sum())
    recent_ratio = float(np.clip(actual_recent_total / max(dayahead_recent_total, 1.0), INTRADAY_RECENT_RATIO_CLIP[0], INTRADAY_RECENT_RATIO_CLIP[1]))
    strength = float(min(INTRADAY_BLEND_MAX, 0.24 + 0.02 * len(observed_slots)))

    cap_slot = slot_cap_kwh(False)
    for step, slot in enumerate(range(last_observed_slot + 1, SOLAR_END_SLOT)):
        fade = min(1.0, step / 24.0)
        target_ratio = (1.0 - fade) * recent_ratio + fade * global_ratio
        factor = 1.0 + strength * (target_ratio - 1.0)
        adjusted[slot] = float(np.clip(np.asarray(dayahead, dtype=float)[slot] * factor, 0.0, cap_slot))

    for slot in range(max(SOLAR_START_SLOT + 1, last_observed_slot + 1), SOLAR_END_SLOT):
        upper = adjusted[slot - 1] + 320.0
        lower = max(0.0, adjusted[slot - 1] - 320.0)
        adjusted[slot] = float(np.clip(adjusted[slot], lower, upper))

    adjusted[:SOLAR_START_SLOT] = 0.0
    adjusted[SOLAR_END_SLOT:] = 0.0

    weather_hourly = load_forecast_weather_for_day(day_s)
    if weather_hourly is not None and not weather_hourly.empty:
        w5 = interpolate_5min(weather_hourly, day_s)
    else:
        w5 = pd.DataFrame({
            "cloud": np.zeros(SLOTS_DAY),
            "cloud_low": np.zeros(SLOTS_DAY),
            "cloud_mid": np.zeros(SLOTS_DAY),
            "cloud_high": np.zeros(SLOTS_DAY),
            "rad": np.zeros(SLOTS_DAY),
            "rh": np.zeros(SLOTS_DAY),
            "temp": np.zeros(SLOTS_DAY),
            "wind": np.zeros(SLOTS_DAY),
            "precip": np.zeros(SLOTS_DAY),
            "cape": np.zeros(SLOTS_DAY),
        })
    lo, hi = confidence_bands(adjusted, w5, day_s)

    meta.update({
        "observed_slots": int(len(observed_slots)),
        "last_observed_slot": last_observed_slot,
        "global_ratio": global_ratio,
        "recent_ratio": recent_ratio,
        "strength": strength,
        "constraint_mode": constraint_mode,
        "cap_dispatch_slots": int(np.count_nonzero(cap_dispatch_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
        "operational_slots": int(np.count_nonzero(operational_mask[SOLAR_START_SLOT:SOLAR_END_SLOT])),
    })
    return to_ui_series(adjusted, lo, hi, day_s), meta


def run_intraday_adjusted(day: date) -> bool:
    series, meta = build_intraday_adjusted_forecast(day)
    day_s = day.isoformat()
    if not series:
        log.info(
            "Intraday-adjusted skipped [%s] - observed_slots=%d",
            day_s,
            int(meta.get("observed_slots", 0)),
        )
        return False
    ok = write_forecast("PacEnergy_IntradayAdjusted", day_s, series)
    if ok:
        log.info(
            "Intraday-adjusted updated [%s] - observed_slots=%d last_slot=%s global_ratio=%.3f recent_ratio=%.3f strength=%.2f",
            day_s,
            int(meta.get("observed_slots", 0)),
            meta.get("last_observed_slot"),
            float(meta.get("global_ratio", 1.0)),
            float(meta.get("recent_ratio", 1.0)),
            float(meta.get("strength", 0.0)),
        )
    return ok


# ============================================================================
# CORE FORECAST FUNCTION
# ============================================================================

def run_dayahead(
    target_date: date,
    today: date,
    runtime_state: dict | None = None,
    persist: bool = True,
    require_saved_snapshot_for_past: bool = False,
    write_audit: bool = False,
    audit_generator_mode: str = "",
) -> bool | dict:
    """
    Generate the day-ahead forecast for *target_date*.

    Pipeline:
        1. Fetch weather for target day
        2. Compute physics baseline
        3. Predict ML residual (if model available)
        4. Apply error memory bias correction
        5. Clip to slot capacity, enforce ramp limits
        6. Compute confidence bands
        7. Optionally write to forecast context

    Returns a boolean when `persist=True`, otherwise a result payload.
    """
    target_s = target_date.isoformat()
    log.info("â”€â”€ Day-Ahead Forecast  target=%s â”€â”€", target_s)

    def _load_saved_snapshot_hourly(snapshot_day: str) -> pd.DataFrame:
        snap = load_forecast_weather_snapshot(snapshot_day)
        if not snap:
            return pd.DataFrame()
        raw_hourly_records = list(snap.get("raw_hourly") or [])
        if raw_hourly_records:
            frame = _weather_records_to_frame(raw_hourly_records, snapshot_day)
            if not frame.empty:
                return frame
        applied_hourly_records = list(snap.get("applied_hourly") or [])
        if applied_hourly_records:
            return _weather_records_to_frame(applied_hourly_records, snapshot_day)
        return pd.DataFrame()

    # 1. Weather
    weather_source = "forecast"
    raw_hourly = pd.DataFrame()
    historical_snapshot_mode = bool(
        require_saved_snapshot_for_past and target_date < datetime.now().date()
    )
    if target_date < today or historical_snapshot_mode:
        snap = load_forecast_weather_snapshot(target_s)
        if snap:
            raw_hourly = _weather_records_to_frame(list(snap.get("raw_hourly") or []), target_s)
            weather_source = "snapshot"
        if raw_hourly.empty:
            if require_saved_snapshot_for_past:
                log.warning("Past target %s has no saved forecast snapshot - skipping strict day-ahead replay.", target_s)
                return False if persist else None
            log.warning("Past target %s has no saved forecast snapshot - using archive weather fallback.", target_s)
            fetched = fetch_weather(target_s, source="archive")
            raw_hourly = fetched if fetched is not None else pd.DataFrame()
            weather_source = "archive-fallback"
    else:
        fetched = fetch_weather(target_s, source="forecast")
        raw_hourly = fetched if fetched is not None else pd.DataFrame()
        if raw_hourly.empty:
            snap_hourly = _load_saved_snapshot_hourly(target_s)
            if not snap_hourly.empty:
                raw_hourly = snap_hourly
                weather_source = "snapshot-fallback"
                log.warning(
                    "Forecast weather unavailable for %s - using saved weather snapshot fallback.",
                    target_s,
                )

    if raw_hourly.empty and not persist:
        log.error("Cannot run forecast - weather unavailable for %s", target_s)
        return None

    if raw_hourly.empty:
        log.error("Cannot run forecast â€“ weather unavailable for %s", target_s)
        return False

    if runtime_state is not None and "weather_bias" in runtime_state:
        weather_bias = runtime_state.get("weather_bias")
    else:
        weather_bias = load_weather_bias_artifact(today, allow_build=True)
    hourly_applied, bias_meta = apply_weather_bias_adjustment(raw_hourly, target_s, weather_bias)
    w5   = interpolate_5min(hourly_applied, target_s)
    ok_w5, reason_w5 = validate_weather_5min(target_s, w5)
    if (not ok_w5) and (not persist):
        log.error("Cannot run forecast - weather quality failed for %s: %s", target_s, reason_w5)
        return None
    if not ok_w5:
        log.error("Cannot run forecast â€“ weather quality failed for %s: %s", target_s, reason_w5)
        return False
    stats = analyse_weather_day(target_s, w5)
    target_regime = classify_day_regime(stats)
    log.info(
        "Target weather: sky=%-14s  cloud=%.0f%%  rad_peak=%.0f W/mÂ²  "
        "RH=%.0f%%  convective=%s  rainy=%s",
        stats["sky_class"], stats["cloud_mean"], stats["rad_peak"],
        stats["rh_mean"], stats["convective"], stats["rainy"],
    )
    log.info(
        "Weather bias: source=%s matches=%d regime=%s conf=%.2f rad_factor=%.3f shift_slots=%.1f",
        weather_source,
        int(bias_meta.get("matches", 0)),
        bias_meta.get("day_regime"),
        float(bias_meta.get("regime_confidence", 1.0)),
        float(bias_meta.get("mean_rad_factor", 1.0)),
        float(bias_meta.get("morning_shift_slots", 0.0)),
    )

    # 2. Physics baseline
    baseline = physics_baseline(target_s, w5)
    solcast_snapshot = load_solcast_snapshot(target_s)
    if runtime_state is not None and "solcast_reliability" in runtime_state:
        solcast_reliability = runtime_state.get("solcast_reliability")
    else:
        solcast_reliability = load_solcast_reliability_artifact(today, allow_build=True)
    solcast_prior = solcast_prior_from_snapshot(target_s, w5, solcast_snapshot, solcast_reliability)
    hybrid_baseline, solcast_meta = blend_physics_with_solcast(baseline, solcast_prior)
    if runtime_state is not None and "forecast_artifacts" in runtime_state:
        artifacts = runtime_state.get("forecast_artifacts")
    else:
        artifacts = load_forecast_artifacts(today, allow_build=True)
    solcast_primary = bool(
        solcast_meta.get("used_solcast")
        and (
            bool(solcast_meta.get("primary_mode"))
            or float(solcast_meta.get("mean_blend", 0)) >= 0.75
        )
    )
    log.info(
        "Solcast prior: used=%s primary=%s regime=%s cov=%.2f blend=%.2f reliability=%.2f res=%.2f bias_ratio=%.3f ratio=%.2f->%.2f source=%s",
        bool(solcast_meta.get("used_solcast")),
        solcast_primary,
        solcast_meta.get("regime"),
        float(solcast_meta.get("coverage_ratio", 0.0)),
        float(solcast_meta.get("mean_blend", 0.0)),
        float(solcast_meta.get("reliability", 0.0)),
        float(solcast_meta.get("resolution_weight_mean", SOLCAST_RESOLUTION_WEIGHT_FALLBACK)),
        float(solcast_meta.get("bias_ratio", 1.0)),
        float(solcast_meta.get("raw_prior_ratio", 1.0)),
        float(solcast_meta.get("applied_prior_ratio", 1.0)),
        solcast_meta.get("source"),
    )

    # 3. ML residual correction
    feat = build_features(w5, target_s, solcast_prior)
    X_pred = feat[FEATURE_COLS]
    slot_weather_buckets = classify_slot_weather_buckets(w5, target_s)
    blend = residual_blend_vector(w5, target_s, float(bias_meta.get("regime_confidence", 1.0)))
    solcast_residual_scale = solcast_residual_damp_factor(solcast_meta)
    clear_slot_mask = np.isin(slot_weather_buckets, np.asarray(["clear_stable", "clear_edge"], dtype=object))
    clear_solcast_priority = 1.0
    if bool(solcast_meta.get("used_solcast")) and target_regime == "clear":
        clear_solcast_priority = float(np.clip(0.72 + 0.28 * float(solcast_meta.get("mean_blend", 0.0)), 0.72, 1.0))

    ml_residual = np.zeros(SLOTS_DAY)
    error_class_term = np.zeros(SLOTS_DAY)
    error_class_meta = {
        "available": False,
        "target_regime": target_regime,
        "used_regime_model": False,
        "blend": 0.0,
        "confidence": np.ones(SLOTS_DAY, dtype=float),
        "severe_probability": np.zeros(SLOTS_DAY, dtype=float),
        "predicted_labels": np.full(SLOTS_DAY, ERROR_CLASS_NEUTRAL_IDX, dtype=int),
        "probabilities": np.zeros((SLOTS_DAY, len(ERROR_CLASS_NAMES)), dtype=float),
        "slot_weather_buckets": slot_weather_buckets.copy(),
        "weather_profiles": {},
        "class_blend": np.zeros(SLOTS_DAY, dtype=float),
        "class_bias_kwh": np.zeros(SLOTS_DAY, dtype=float),
        "support_strength": np.zeros(SLOTS_DAY, dtype=float),
        "profile_reliability": np.ones(SLOTS_DAY, dtype=float),
        "trust_scale": np.zeros(SLOTS_DAY, dtype=float),
        "cap_frac": np.full(SLOTS_DAY, ERROR_CLASS_BIAS_CAP_FRAC, dtype=float),
        "class_support_weights": {name: 1.0 for name in ERROR_CLASS_NAMES},
    }
    if runtime_state is not None and "model_bundle" in runtime_state:
        model_bundle = runtime_state.get("model_bundle")
    else:
        model_bundle = load_model_bundle()
    if model_bundle:
        try:
            raw_residual, model_meta = predict_residual_with_bundle(
                model_bundle,
                X_pred,
                target_regime,
                regime_confidence=float(bias_meta.get("regime_confidence", 1.0)),
            )
            ml_residual           = np.zeros(SLOTS_DAY)
            ml_residual[:] = raw_residual

            # Zero residual outside solar hours & below radiation threshold
            ml_residual[:SOLAR_START_SLOT]  = 0.0
            ml_residual[SOLAR_END_SLOT:]    = 0.0
            ml_residual[w5["rad"].values < RAD_MIN_WM2] = 0.0

            # Clip extreme residuals (prevent model from overcorrecting)
            cap_kwh = slot_cap_kwh()
            ml_residual = np.clip(ml_residual, -cap_kwh * 0.5, cap_kwh * 0.5)

            # Weather-adaptive blending: trust ML less in volatile/rainy slots.
            ml_residual = ml_residual * blend
            ml_residual = _rolling_mean(ml_residual, 3, center=True)
            if solcast_residual_scale < 0.999:
                ml_residual = ml_residual * solcast_residual_scale
            if clear_solcast_priority < 0.999 and np.any(clear_slot_mask):
                ml_residual[clear_slot_mask] *= (1.0 - 0.28 * clear_solcast_priority)

            log.info(
                "ML residual: mean=%.2f  std=%.2f  p95=%.2f kWh/slot  blend_mean=%.2f  solcast_scale=%.2f",
                ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
                ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT].std(),
                np.percentile(np.abs(ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT]), 95),
                blend[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
                solcast_residual_scale,
            )
            log.info(
                "ML routing: target_regime=%s regime_model=%s blend=%.2f regime_days=%d regime_samples=%d",
                model_meta.get("target_regime"),
                bool(model_meta.get("used_regime_model")),
                float(model_meta.get("blend", 0.0)),
                int(model_meta.get("regime_days", 0)),
                int(model_meta.get("regime_samples", 0)),
            )
            raw_class_bias, classifier_meta = predict_error_classifier_with_bundle(
                model_bundle,
                X_pred,
                target_regime,
                regime_confidence=float(bias_meta.get("regime_confidence", 1.0)),
                slot_weather_buckets=slot_weather_buckets,
            )
            error_class_term = np.asarray(raw_class_bias, dtype=float)
            error_class_term[:SOLAR_START_SLOT] = 0.0
            error_class_term[SOLAR_END_SLOT:] = 0.0
            error_class_term[w5["rad"].values < RAD_MIN_WM2] = 0.0
            class_cap_frac = np.asarray(classifier_meta.get("cap_frac"), dtype=float).reshape(-1)
            if class_cap_frac.size < SLOTS_DAY:
                class_cap_frac = np.pad(class_cap_frac, (0, SLOTS_DAY - class_cap_frac.size), constant_values=ERROR_CLASS_BIAS_CAP_FRAC)
            class_cap_frac = np.clip(class_cap_frac[:SLOTS_DAY], 0.0, ERROR_CLASS_BIAS_CAP_FRAC)
            class_cap_kwh = cap_kwh * class_cap_frac
            error_class_term = np.clip(error_class_term, -class_cap_kwh, class_cap_kwh)
            class_confidence = np.asarray(classifier_meta.get("confidence"), dtype=float)
            class_blend = ERROR_CLASS_BLEND_MIN + (
                ERROR_CLASS_BLEND_MAX - ERROR_CLASS_BLEND_MIN
            ) * np.clip(
                (class_confidence - ERROR_CLASS_BLEND_CONFIDENCE_FLOOR)
                / max(1.0 - ERROR_CLASS_BLEND_CONFIDENCE_FLOOR, 1e-6),
                0.0,
                1.0,
            )
            class_trust_scale = np.asarray(classifier_meta.get("trust_scale"), dtype=float).reshape(-1)
            if class_trust_scale.size < SLOTS_DAY:
                class_trust_scale = np.pad(class_trust_scale, (0, SLOTS_DAY - class_trust_scale.size), constant_values=1.0)
            class_trust_scale = np.clip(class_trust_scale[:SLOTS_DAY], 0.0, 1.0)
            class_blend = class_blend * class_trust_scale
            if clear_solcast_priority < 0.999 and np.any(clear_slot_mask):
                class_blend = class_blend.copy()
                class_blend[clear_slot_mask] *= (1.0 - 0.35 * clear_solcast_priority)
            error_class_term = error_class_term * blend
            error_class_term = _rolling_mean(error_class_term, 3, center=True)
            if solcast_residual_scale < 0.999:
                error_class_term = error_class_term * solcast_residual_scale
            error_class_term = error_class_term * class_blend
            error_class_term = np.clip(error_class_term, -class_cap_kwh, class_cap_kwh)
            error_class_meta = {
                **classifier_meta,
                "slot_weather_buckets": slot_weather_buckets.copy(),
                "class_blend": class_blend,
                "class_bias_kwh": error_class_term.copy(),
            }
            log.info(
                "Error classifier: available=%s regime_model=%s blend=%.2f mean_conf=%.2f severe_prob=%.2f support=%.2f profile_rel=%.2f total_bias=%.0f kWh",
                bool(error_class_meta.get("available")),
                bool(error_class_meta.get("used_regime_model")),
                float(error_class_meta.get("blend", 0.0)),
                float(np.mean(np.asarray(error_class_meta.get("confidence"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.mean(np.asarray(error_class_meta.get("severe_probability"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.mean(np.asarray(error_class_meta.get("support_strength"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.mean(np.asarray(error_class_meta.get("profile_reliability"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])),
                float(np.sum(error_class_term)),
            )
        except Exception as e:
            log.error("ML prediction failed â€“ falling back to physics only: %s", e)
            ml_residual = np.zeros(SLOTS_DAY)
            error_class_term = np.zeros(SLOTS_DAY)
    else:
        log.warning("No trained model found â€“ using physics baseline only")

    # 4. Error memory bias correction
    err_mem = compute_error_memory(today, w5)
    bias_correction = ERROR_ALPHA * err_mem
    bias_correction[:SOLAR_START_SLOT] = 0.0
    bias_correction[SOLAR_END_SLOT:]   = 0.0

    log.info(
        "Bias correction: mean=%.2f  max=%.2f kWh/slot (alpha=%.2f)",
        bias_correction[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
        np.abs(bias_correction[SOLAR_START_SLOT:SOLAR_END_SLOT]).max(),
        ERROR_ALPHA,
    )

    # 5. Combine
    forecast = hybrid_baseline + ml_residual + error_class_term + bias_correction

    # Hard capacity constraints:
    # - dependable cap is used in physics baseline shaping
    # - max cap is the hard physical upper bound per 5-min slot
    cap_slot_dep = slot_cap_kwh(dependable=True)
    cap_slot_max = slot_cap_kwh(dependable=False)
    log.info(
        "Capacity guard: dep=%.4f MWh/slot  max=%.4f MWh/slot (5-min)",
        cap_slot_dep / 1000.0,
        cap_slot_max / 1000.0,
    )

    # Clamp by hard physical max so day-ahead cannot exceed real plant capacity.
    # Example: 23 MW max PAC -> 23 * (5/60) = 1.9167 MWh max per slot.
    cap_slot = cap_slot_max
    forecast = np.clip(forecast, 0.0, cap_slot)
    forecast[:SOLAR_START_SLOT] = 0.0
    forecast[SOLAR_END_SLOT:]   = 0.0

    if bool(solcast_meta.get("used_solcast")):
        shape_meta = {
            "hours_shaped": 0,
            "avg_matches": 0.0,
            "avg_score": None,
            "skipped_for_solcast": True,
        }
    else:
        forecast, shape_meta = apply_hour_shape_correction(forecast, target_s, w5, artifacts)
    forecast, activity_meta = apply_activity_hysteresis(forecast, target_s, w5, artifacts, bias_meta=bias_meta)
    forecast, staging_meta = apply_block_staging(forecast, w5)
    forecast = np.clip(forecast, 0.0, cap_slot)
    forecast[:SOLAR_START_SLOT] = 0.0
    forecast[SOLAR_END_SLOT:]   = 0.0

    log.info(
        "Hardening: shape_hours=%d avg_shape_matches=%.1f avg_shape_score=%s  start=%s end=%s hist_window=%d bias_shift=%d staged_slots=%d node_step=%.2f",
        int(shape_meta.get("hours_shaped", 0)),
        float(shape_meta.get("avg_matches", 0.0)),
        f"{float(shape_meta['avg_score']):.2f}" if shape_meta.get("avg_score") is not None else "n/a",
        activity_meta.get("first_slot"),
        activity_meta.get("last_slot"),
        int(activity_meta.get("history_matches", 0)),
        int(activity_meta.get("bias_shift_slots", 0)),
        int(staging_meta.get("staged_slots", 0)),
        float(staging_meta.get("node_step_kwh", 0.0)),
    )

    # Ramp rate limit
    forecast = apply_ramp_limit(forecast)

    # Final clip (ramp may push slightly over)
    forecast = np.clip(forecast, 0.0, cap_slot)

    # Sanity check: total energy must be <= theoretical physical maximum.
    max_kwh_day = plant_capacity_kw(False) * (SOLAR_END_H - SOLAR_START_H)
    if forecast.sum() > max_kwh_day:
        log.warning(
            "Forecast total %.0f kWh exceeds theoretical max %.0f kWh - scaling down",
            forecast.sum(), max_kwh_day,
        )
        forecast *= max_kwh_day / forecast.sum()
    # 6. Confidence bands
    lo, hi = confidence_bands(
        forecast,
        w5,
        target_s,
        float(bias_meta.get("regime_confidence", 1.0)),
        error_class_meta=error_class_meta if bool(error_class_meta.get("available")) else None,
    )

    # 7. Summary log
    log.info(
        "Forecast summary: total=%.0f kWh  peak=%.2f kWh/slot  "
        "baseline_total=%.0f kWh  hybrid_total=%.0f kWh  ml_corr=%.0f kWh  class_corr=%.0f kWh  bias_corr=%.0f kWh",
        forecast.sum(),
        forecast.max(),
        baseline.sum(),
        hybrid_baseline.sum(),
        ml_residual.sum(),
        error_class_term.sum(),
        bias_correction.sum(),
    )

    series = to_ui_series(forecast, lo, hi, target_s)
    error_class_summary = {
        "available": bool(error_class_meta.get("available")),
        "target_regime": target_regime,
        "used_regime_model": bool(error_class_meta.get("used_regime_model")),
        "blend": float(error_class_meta.get("blend", 0.0)),
        "mean_confidence": float(np.mean(np.asarray(error_class_meta.get("confidence"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if bool(error_class_meta.get("available")) else 0.0,
        "mean_support_strength": float(np.mean(np.asarray(error_class_meta.get("support_strength"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if bool(error_class_meta.get("available")) else 0.0,
        "mean_profile_reliability": float(np.mean(np.asarray(error_class_meta.get("profile_reliability"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT])) if bool(error_class_meta.get("available")) else 0.0,
        "mean_probabilities": {
            name: float(np.mean(np.asarray(error_class_meta.get("probabilities"), dtype=float)[SOLAR_START_SLOT:SOLAR_END_SLOT, idx]))
            for idx, name in enumerate(ERROR_CLASS_NAMES)
        } if bool(error_class_meta.get("available")) else {name: 0.0 for name in ERROR_CLASS_NAMES},
        "weather_bucket_forecast_summary": summarize_value_by_bucket(forecast, slot_weather_buckets),
        "weather_profiles": error_class_meta.get("weather_profiles") or {},
        "class_support_weights": dict(error_class_meta.get("class_support_weights") or {}),
        "slot_weather_buckets": slot_weather_buckets.copy(),
        "predicted_labels": np.asarray(error_class_meta.get("predicted_labels"), dtype=int).copy(),
        "class_confidence": np.asarray(error_class_meta.get("confidence"), dtype=float).copy(),
        "severe_probability": np.asarray(error_class_meta.get("severe_probability"), dtype=float).copy(),
        "support_strength": np.asarray(error_class_meta.get("support_strength"), dtype=float).copy(),
        "profile_reliability": np.asarray(error_class_meta.get("profile_reliability"), dtype=float).copy(),
        "trust_scale": np.asarray(error_class_meta.get("trust_scale"), dtype=float).copy(),
        "cap_frac": np.asarray(error_class_meta.get("cap_frac"), dtype=float).copy(),
        "class_blend": np.asarray(error_class_meta.get("class_blend"), dtype=float).copy(),
        "class_bias_kwh": np.asarray(error_class_meta.get("class_bias_kwh"), dtype=float).copy(),
        "total_bias_kwh": float(np.sum(error_class_term)),
    }
    if not persist:
        return {
            "day": target_s,
            "series": series,
            "forecast": forecast,
            "hybrid_baseline": hybrid_baseline,
            "lo": lo,
            "hi": hi,
            "weather_source": weather_source,
            "raw_hourly": raw_hourly,
            "hourly_applied": hourly_applied,
            "target_regime": target_regime,
            "bias_meta": bias_meta,
            "solcast_meta": solcast_meta,
            "shape_meta": shape_meta,
            "activity_meta": activity_meta,
            "staging_meta": staging_meta,
            "baseline_total_kwh": float(baseline.sum()),
            "hybrid_total_kwh": float(hybrid_baseline.sum()),
            "forecast_total_kwh": float(forecast.sum()),
            "ml_total_kwh": float(ml_residual.sum()),
            "error_class_total_kwh": float(error_class_term.sum()),
            "bias_total_kwh": float(bias_correction.sum()),
            "error_class_meta": error_class_summary,
        }

    # 8. Write
    ok = write_forecast("PacEnergy_DayAhead", target_s, series)
    if ok and weather_source in {"forecast", "snapshot"}:
        save_forecast_weather_snapshot(
            target_s,
            raw_hourly,
            hourly_applied,
            provider="open-meteo",
            meta={
                "weather_source": weather_source,
                "bias_meta": bias_meta,
                "target_regime": target_regime,
                "error_class_debug": {
                    "hybrid_baseline_kwh": [float(v) for v in np.asarray(hybrid_baseline, dtype=float)],
                    "slot_weather_buckets": [str(v) for v in np.asarray(slot_weather_buckets, dtype=object)],
                    "predicted_labels": [int(v) for v in np.asarray(error_class_meta.get("predicted_labels"), dtype=int)],
                    "class_confidence": [float(v) for v in np.asarray(error_class_meta.get("confidence"), dtype=float)],
                    "support_strength": [float(v) for v in np.asarray(error_class_meta.get("support_strength"), dtype=float)],
                    "profile_reliability": [float(v) for v in np.asarray(error_class_meta.get("profile_reliability"), dtype=float)],
                },
            },
        )

    if ok and write_audit:
        _write_forecast_run_audit_from_python(
            target_date=target_s,
            generator_mode=audit_generator_mode or "python_direct",
            weather_source=weather_source,
            solcast_meta=solcast_meta,
            forecast_total_kwh=float(forecast.sum()),
            baseline_total_kwh=float(baseline.sum()),
            hybrid_total_kwh=float(hybrid_baseline.sum()),
            ml_total_kwh=float(ml_residual.sum()),
            error_class_total_kwh=float(error_class_term.sum()),
            bias_total_kwh=float(bias_correction.sum()),
        )

    return ok


# ============================================================================
# MANUAL GENERATION (CLI)
# ============================================================================

def _parse_iso_date_safe(value: str) -> date:
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except Exception as e:
        raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from e


def _iter_days(start_date: date, end_date: date) -> list[date]:
    if end_date < start_date:
        raise ValueError("End date must be on or after start date.")
    days = []
    cur = start_date
    while cur <= end_date:
        days.append(cur)
        cur += timedelta(days=1)
    return days


def run_manual_generation(dates: list[date]) -> bool:
    dates = sorted(set(dates))
    if not dates:
        log.error("Manual generation: no target dates provided.")
        return False

    clear_forecast_data_cache()
    today_ref = datetime.now().date()
    log.info("Manual generation start: %d date(s), reference=%s", len(dates), today_ref.isoformat())

    trained = train_model(today_ref)
    if not trained:
        log.warning("Manual generation: model training skipped - physics fallback may be used.")

    forecast_qa(today_ref)

    ok_all = True
    node_reachable = True

    for d in dates:
        ok = False
        used_delegation = False

        if node_reachable:
            result = _delegate_run_dayahead(d, trigger="manual_cli")
            if result is not None:
                ok = True
                used_delegation = True
            else:
                node_reachable = False
                log.warning(
                    "Manual generation: Node delegation failed for %s - "
                    "falling back to direct run_dayahead for remaining dates.",
                    d.isoformat(),
                )

        if not used_delegation:
            ok = run_dayahead(d, today_ref, write_audit=True, audit_generator_mode="manual_cli_fallback")

        if ok and d == today_ref:
            run_intraday_adjusted(d)
        ok_all = ok_all and ok
        if ok:
            log.info("Manual generation OK: %s (delegated=%s)", d.isoformat(), used_delegation)
        else:
            log.error("Manual generation FAILED: %s", d.isoformat())

    return ok_all


def run_backtest(dates: list[date]) -> bool:
    """
    Replay historical day-ahead forecasts over a date range.

    This mode requires saved forecast-weather snapshots for past targets so the
    scored forecast reflects true day-ahead inputs instead of hindsight weather.
    """
    dates = sorted(set(dates))
    if not dates:
        log.error("Backtest: no target dates provided.")
        return False

    clear_forecast_data_cache()
    log.info(
        "Backtest start: %d date(s), range=%s..%s, strict_snapshots=true",
        len(dates),
        dates[0].isoformat(),
        dates[-1].isoformat(),
    )

    rows: list[dict] = []
    skipped_actual = 0
    skipped_snapshot = 0
    skipped_training = 0
    skipped_forecast = 0

    for target_date in dates:
        target_s = target_date.isoformat()
        actual, actual_present = load_actual_loss_adjusted_with_presence(target_s)
        if actual is None or actual_present is None:
            skipped_actual += 1
            log.warning("Backtest skip [%s] - actual 5-minute history unavailable", target_s)
            continue

        if not load_forecast_weather_snapshot(target_s):
            skipped_snapshot += 1
            log.warning("Backtest skip [%s] - saved forecast weather snapshot unavailable", target_s)
            continue

        reference_day = target_date - timedelta(days=1)
        runtime_state = build_training_state(reference_day)
        if not runtime_state:
            skipped_training += 1
            log.warning("Backtest skip [%s] - training state unavailable at reference=%s", target_s, reference_day.isoformat())
            continue

        result = run_dayahead(
            target_date,
            reference_day,
            runtime_state=runtime_state,
            persist=False,
            require_saved_snapshot_for_past=True,
        )
        if not isinstance(result, dict):
            skipped_forecast += 1
            log.warning("Backtest skip [%s] - forecast replay failed", target_s)
            continue

        _, constraint_meta = build_operational_constraint_mask(target_s)
        metrics = compute_forecast_metrics(
            actual,
            np.asarray(result["forecast"], dtype=float),
            actual_present=actual_present,
            exclude_mask=np.asarray(constraint_meta.get("operational_mask"), dtype=bool),
        )
        if metrics is None:
            skipped_forecast += 1
            log.warning("Backtest skip [%s] - forecast metrics unavailable", target_s)
            continue

        bucket_metrics = compute_bucketed_forecast_metrics(
            actual,
            np.asarray(result["forecast"], dtype=float),
            (result.get("error_class_meta") or {}).get("slot_weather_buckets"),
            actual_present=actual_present,
            exclude_mask=np.asarray(constraint_meta.get("operational_mask"), dtype=bool),
        )
        class_metrics = compute_error_class_metrics(
            actual,
            np.asarray(result.get("hybrid_baseline"), dtype=float) if result.get("hybrid_baseline") is not None else None,
            (result.get("error_class_meta") or {}).get("predicted_labels"),
            class_confidence=(result.get("error_class_meta") or {}).get("class_confidence"),
            actual_present=actual_present,
            exclude_mask=np.asarray(constraint_meta.get("operational_mask"), dtype=bool),
        )

        rows.append({
            "day": target_s,
            "reference_day": reference_day.isoformat(),
            "weather_source": str(result.get("weather_source") or ""),
            "target_regime": str(result.get("target_regime") or ""),
            "solcast_used": bool((result.get("solcast_meta") or {}).get("used_solcast")),
            "solcast_blend": float((result.get("solcast_meta") or {}).get("mean_blend", 0.0)),
            "bucket_metrics": bucket_metrics,
            "classifier_sign_hit_rate": None if class_metrics is None else float(class_metrics.get("sign_hit_rate", 0.0)),
            "classifier_severe_hit_rate": None if class_metrics is None or class_metrics.get("severe_hit_rate") is None else float(class_metrics.get("severe_hit_rate", 0.0)),
            "classifier_mean_confidence": 0.0 if class_metrics is None else float(class_metrics.get("mean_confidence", 0.0)),
            **metrics,
        })
        log.info(
            "Backtest [%s] usable=%d masked=%d WAPE=%.1f%% TotalAPE=%.1f%% MAPE=%.1f%% RMSE=%.1f kWh/slot First=%s Last=%s regime=%s solcast=%s blend=%.2f sign_hit=%s conf=%.2f",
            target_s,
            metrics["usable_slot_count"],
            metrics["masked_slot_count"],
            metrics["wape_pct"],
            metrics["total_ape_pct"],
            metrics["mape_pct"],
            metrics["rmse_kwh"],
            _format_minutes(metrics["first_active_error_min"]),
            _format_minutes(metrics["last_active_error_min"]),
            result.get("target_regime"),
            bool((result.get("solcast_meta") or {}).get("used_solcast")),
            float((result.get("solcast_meta") or {}).get("mean_blend", 0.0)),
            f"{float(class_metrics['sign_hit_rate']):.3f}" if class_metrics is not None else "n/a",
            0.0 if class_metrics is None else float(class_metrics.get("mean_confidence", 0.0)),
        )
        log.info("Backtest buckets [%s] %s", target_s, _format_bucket_metric_summary(bucket_metrics))

    if not rows:
        log.error(
            "Backtest produced no scored days (skipped: actual=%d snapshot=%d training=%d forecast=%d)",
            skipped_actual,
            skipped_snapshot,
            skipped_training,
            skipped_forecast,
        )
        return False

    actual_total = float(sum(row["actual_total_kwh"] for row in rows))
    abs_error_total = float(sum(row["abs_error_sum_kwh"] for row in rows))
    overall_wape = float((abs_error_total / max(actual_total, 1.0)) * 100.0)
    mean_daily_wape = float(np.mean([row["wape_pct"] for row in rows]))
    median_daily_wape = float(np.median([row["wape_pct"] for row in rows]))
    mean_total_ape = float(np.mean([row["total_ape_pct"] for row in rows]))
    mean_mape = float(np.mean([row["mape_pct"] for row in rows]))
    regime_summary_parts = []
    for regime in sorted({str(row.get("target_regime") or "") for row in rows if row.get("target_regime")}):
        regime_rows = [row for row in rows if str(row.get("target_regime") or "") == regime]
        regime_actual_total = float(sum(row["actual_total_kwh"] for row in regime_rows))
        regime_abs_total = float(sum(row["abs_error_sum_kwh"] for row in regime_rows))
        regime_wape = float((regime_abs_total / max(regime_actual_total, 1.0)) * 100.0)
        regime_summary_parts.append(f"{regime}:WAPE={regime_wape:.1f}% n={len(regime_rows)}")

    log.info(
        "Backtest summary: scored=%d/%d overall_WAPE=%.1f%% mean_daily_WAPE=%.1f%% median_daily_WAPE=%.1f%% mean_total_APE=%.1f%% mean_MAPE=%.1f%% skipped(actual=%d snapshot=%d training=%d forecast=%d)",
        len(rows),
        len(dates),
        overall_wape,
        mean_daily_wape,
        median_daily_wape,
        mean_total_ape,
        mean_mape,
        skipped_actual,
        skipped_snapshot,
        skipped_training,
        skipped_forecast,
    )
    if regime_summary_parts:
        log.info("Backtest regimes: %s", ", ".join(regime_summary_parts))
    return True


def parse_cli_args():
    parser = argparse.ArgumentParser(
        description="Inverter Dashboard Forecast Service - daemon mode or manual day-ahead generation",
    )
    parser.add_argument(
        "--generate-date",
        metavar="YYYY-MM-DD",
        help="Generate day-ahead for a single date and exit.",
    )
    parser.add_argument(
        "--generate-range",
        nargs=2,
        metavar=("START_YYYY-MM-DD", "END_YYYY-MM-DD"),
        help="Generate day-ahead for an inclusive date range and exit.",
    )
    parser.add_argument(
        "--generate-days",
        type=int,
        metavar="N",
        help="Generate day-ahead for N consecutive days starting tomorrow and exit.",
    )
    parser.add_argument(
        "--backtest-range",
        nargs=2,
        metavar=("START_YYYY-MM-DD", "END_YYYY-MM-DD"),
        help="Replay historical day-ahead forecasts over an inclusive date range using saved forecast weather snapshots.",
    )
    parser.add_argument(
        "--backtest-days",
        type=int,
        metavar="N",
        help="Replay historical day-ahead forecasts for the last N completed days using saved forecast weather snapshots.",
    )
    return parser.parse_args()


def run_cli_generation(args) -> int:
    try:
        if (
            args.generate_date
            or args.generate_range
            or args.generate_days is not None
        ) and _read_operation_mode() == "remote":
            log.error("Manual forecast generation is disabled in remote mode")
            return 2

        if args.generate_date:
            day = _parse_iso_date_safe(args.generate_date)
            ok = run_manual_generation([day])
            return 0 if ok else 2

        if args.generate_range:
            start_s, end_s = args.generate_range
            start_d = _parse_iso_date_safe(start_s)
            end_d = _parse_iso_date_safe(end_s)
            days = _iter_days(start_d, end_d)
            ok = run_manual_generation(days)
            return 0 if ok else 2

        if args.generate_days is not None:
            count = int(args.generate_days)
            if count < 1:
                raise ValueError("--generate-days must be >= 1")
            start_d = datetime.now().date() + timedelta(days=1)
            days = [start_d + timedelta(days=i) for i in range(count)]
            ok = run_manual_generation(days)
            return 0 if ok else 2

        if args.backtest_range:
            start_s, end_s = args.backtest_range
            start_d = _parse_iso_date_safe(start_s)
            end_d = _parse_iso_date_safe(end_s)
            days = _iter_days(start_d, end_d)
            ok = run_backtest(days)
            return 0 if ok else 2

        if args.backtest_days is not None:
            count = int(args.backtest_days)
            if count < 1:
                raise ValueError("--backtest-days must be >= 1")
            end_d = datetime.now().date() - timedelta(days=1)
            start_d = end_d - timedelta(days=count - 1)
            days = _iter_days(start_d, end_d)
            ok = run_backtest(days)
            return 0 if ok else 2

        return -1  # no CLI generation mode requested
    except Exception as e:
        log.error("Manual generation argument error: %s", e)
        return 2


# ============================================================================
# MAIN SERVICE LOOP
# ============================================================================

@lru_cache(maxsize=64)
def _read_setting_value(key: str) -> str | None:
    """Read a setting value from the settings table, returning None if absent."""
    if not APP_DB_FILE.exists():
        return None
    try:
        conn = _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True)
        try:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ? LIMIT 1",
                (str(key),),
            ).fetchone()
        finally:
            conn.close()
    except Exception:
        return None
    if not row or row[0] is None:
        return None
    value = str(row[0]).strip()
    return value or None


@lru_cache(maxsize=1)
def load_forecast_export_limit_mw() -> float:
    raw = _read_setting_value(FORECAST_EXPORT_LIMIT_SETTING_KEY)
    if raw is None:
        return float(EXPORT_MW)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        log.warning(
            "Invalid %s setting %r - using fallback %.1f MW",
            FORECAST_EXPORT_LIMIT_SETTING_KEY,
            raw,
            EXPORT_MW,
        )
        return float(EXPORT_MW)
    if not np.isfinite(value) or value <= 0.0:
        log.warning(
            "Non-positive %s setting %r - using fallback %.1f MW",
            FORECAST_EXPORT_LIMIT_SETTING_KEY,
            raw,
            EXPORT_MW,
        )
        return float(EXPORT_MW)
    return float(value)


def _read_operation_mode() -> str:
    """Read operationMode from the settings table. Returns 'gateway' or 'remote'."""
    try:
        value = str(_read_setting_value("operationMode") or "gateway").strip().lower()
        return "remote" if value == "remote" else "gateway"
    except Exception:
        return "gateway"


def _register_forecast_failure(
    consecutive_failures: int,
    monotonic_now: float,
    base_backoff_sec: int,
) -> tuple[int, float, int]:
    next_failures = max(0, int(consecutive_failures)) + 1
    backoff = min(
        int(base_backoff_sec) * (2 ** min(next_failures - 1, 3)),
        1800,
    )
    return next_failures, float(monotonic_now) + float(backoff), int(backoff)


def _resolve_service_target_date(today: date, now_h: int, da_today_in_db: bool) -> date:
    """
    Resolve the day-ahead target for the main service loop.

    Before sunrise, the upcoming solar window is today. During daylight hours,
    a missing day-ahead for today takes priority over generating tomorrow.
    Otherwise, target tomorrow.
    """
    hour = int(now_h)
    if hour < SOLAR_START_H:
        return today
    if (SOLAR_START_H <= hour < SOLAR_END_H) and (not da_today_in_db):
        return today
    return today + timedelta(days=1)


def _delegate_run_dayahead(target_date: date, trigger: str = "auto_service") -> dict | None:
    """Delegate day-ahead generation to the Node.js orchestrator.

    Returns the full response dict on success, or None on failure.
    Python truthiness is preserved: dict is truthy, None is falsy.
    """
    port = os.getenv("ADSI_SERVER_PORT", "3500")
    url = f"http://127.0.0.1:{port}/api/internal/forecast/generate-auto"
    target_s = target_date.isoformat()
    log.info("Delegating day-ahead generation for %s to Node.js orchestrator at %s (trigger=%s)", target_s, url, trigger)
    try:
        resp = requests.post(url, json={
            "dates": [target_s],
            "trigger": trigger,
        }, timeout=180)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            log.error("Node.js orchestrator returned error: %s", data.get("error"))
            return None
        log.info(
            "Delegation success for %s: provider_used=%s variant=%s freshness=%s total=%.1f kWh",
            target_s,
            data.get("provider_used", "?"),
            data.get("variant", "?"),
            data.get("freshness", "?"),
            float(data.get("total_kwh", 0) or 0),
        )
        return data
    except Exception as e:
        log.error("Failed to delegate generation to Node.js: %s", e)
        return None


def main() -> None:
    _clear_service_stop_file()
    profile = plant_capacity_profile()
    cap_dep = float(profile["dependable_kw"])
    cap_max = float(profile["max_kw"])

    log.info("=" * 70)
    log.info("Inverter Dashboard — Day-Ahead Forecast Service  v3.0")
    log.info("Site          : Configured  (%.6f N  %.6f E)", LAT_DEG, LON_DEG)
    log.info("Inverters     : %.0f kW max / %.0f kW dependable each", UNIT_KW_MAX, UNIT_KW_DEPENDABLE)
    log.info(
        "Configured    : %d inverter rows  |  enabled nodes=%d  (equiv inv=%.3f)",
        profile["configured_inverters"],
        profile["enabled_nodes"],
        profile["equiv_inverters"],
    )
    log.info(
        "IPConfig      : source=%s  path=%s",
        profile.get("ipconfig_source", profile.get("source", "unknown")),
        profile.get("ipconfig_path", IPCONFIG_FILE),
    )
    log.info("Plant Capacity: %.3f MW dep  /  %.3f MW max", cap_dep / 1000.0, cap_max / 1000.0)
    log.info("Slot Cap      : dep=%.4f MWh  max=%.4f MWh per 5-min", slot_cap_kwh(True) / 1000.0, slot_cap_kwh(False) / 1000.0)
    log.info(
        "Export Limit  : %.2f MW  (%s, dispatch only - not applied to forecast curve)",
        load_forecast_export_limit_mw(),
        FORECAST_EXPORT_LIMIT_SETTING_KEY,
    )
    log.info("Train Window  : %d days  (min %d)", N_TRAIN_DAYS, MIN_TRAIN_DAYS)
    log.info("Actual Source : AppData energy_5min (hot + archive), legacy JSON fallback only")
    log.info("=" * 70)

    last_run_hour = -1   # track which hour we last ran in
    last_intraday_slot_key = ""
    _fail_cooldown_until = 0.0       # monotonic time until retry is allowed
    _FAIL_COOLDOWN_BASE = 300        # 5 min base backoff after a failed attempt
    _consecutive_failures = 0

    while True:
        try:
            if _service_stop_requested():
                raise KeyboardInterrupt
            # Viewer model: skip all forecast generation in remote mode.
            if _read_operation_mode() == "remote":
                log.debug("Remote mode — skipping forecast generation (viewer model)")
                _sleep_with_service_stop(60)
                continue

            now        = datetime.now()
            today      = now.date()
            today_s    = today.isoformat()
            now_h      = now.hour
            mono_now   = time.monotonic()

            da_today_in_db = _has_forecast_dayahead_in_db(today_s)
            target     = _resolve_service_target_date(today, now_h, da_today_in_db)
            target_s   = target.isoformat()
            da_target_in_db = _has_forecast_dayahead_in_db(target_s)

            # â”€â”€â”€ Decide whether to run a forecast this loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            #
            # Run conditions (any one sufficient):
            #   A) Primary scheduled hour (DA_RUN_HOURS_PRIMARY) and we have not
            #      run this hour yet
            #   B) Outside-solar target missing from DB:
            #      today before sunrise, tomorrow after sunset
            #   C) Today's forecast is missing and we are inside solar hours
            #      (morning recovery)

            run_scheduled = (now_h in DA_RUN_HOURS_PRIMARY) and (last_run_hour != now_h)
            # Outside-solar constant checker:
            #   00:00-04:59 -> ensure today's solar-window forecast exists
            #   18:00-23:59 -> ensure tomorrow's solar-window forecast exists
            outside_solar = (now_h >= SOLAR_END_H) or (now_h < SOLAR_START_H)
            run_postsolar = outside_solar and (not da_target_in_db)
            run_recovery  = (SOLAR_START_H <= now_h < SOLAR_END_H) and (not da_today_in_db)

            # Respect failure cooldown for post-solar retries.
            # Primary scheduled runs always bypass the cooldown.
            if not run_scheduled and run_postsolar and mono_now < _fail_cooldown_until:
                log.debug(
                    "Target missing but in failure cooldown (%.0fs remaining)",
                    _fail_cooldown_until - mono_now,
                )
                run_postsolar = False

            if run_scheduled or run_postsolar:
                log.info(
                    "Run trigger: target=%s scheduled=%s postsolar_check=%s failures=%d",
                    target_s,
                    run_scheduled,
                    run_postsolar,
                    _consecutive_failures,
                )
                clear_forecast_data_cache()
                if _service_stop_requested():
                    raise KeyboardInterrupt

                try:
                    # (Re)train model before forecast
                    trained = train_model(today)
                    if _service_stop_requested():
                        raise KeyboardInterrupt
                    if not trained:
                        log.warning("Model training skipped â€“ will use existing model or physics")

                    # Forecast quality audit of yesterday
                    forecast_qa(today)
                    if _service_stop_requested():
                        raise KeyboardInterrupt

                    # Generate the resolved target day-ahead
                    ok = _delegate_run_dayahead(target)
                except Exception:
                    _consecutive_failures, _fail_cooldown_until, backoff = _register_forecast_failure(
                        _consecutive_failures,
                        time.monotonic(),
                        _FAIL_COOLDOWN_BASE,
                    )
                    log.error(
                        "Day-ahead for %s crashed (attempt %d, cooldown %ds)",
                        target_s, _consecutive_failures, backoff,
                        exc_info=True,
                    )
                else:
                    if ok:
                        last_run_hour = now_h
                        _consecutive_failures = 0
                        _fail_cooldown_until = 0.0
                        log.info("Day-ahead for %s completed successfully", target_s)
                    else:
                        _consecutive_failures, _fail_cooldown_until, backoff = _register_forecast_failure(
                            _consecutive_failures,
                            time.monotonic(),
                            _FAIL_COOLDOWN_BASE,
                        )
                        log.error(
                            "Day-ahead for %s FAILED (attempt %d, cooldown %ds)",
                            target_s, _consecutive_failures, backoff,
                        )

            elif run_recovery:
                log.warning("Recovery: today %s missing day-ahead â€“ generating now", today_s)
                clear_forecast_data_cache()
                if _service_stop_requested():
                    raise KeyboardInterrupt
                try:
                    ok = _delegate_run_dayahead(today)
                except Exception:
                    log.error("Recovery day-ahead for %s crashed", today_s, exc_info=True)
                else:
                    if ok:
                        log.info("Recovery day-ahead for %s completed successfully", today_s)
                        clear_forecast_data_cache()
                        run_intraday_adjusted(today)
                    else:
                        log.error("Recovery day-ahead for %s FAILED", today_s)

            else:
                if outside_solar and da_target_in_db:
                    log.debug("Outside-solar check: day-ahead for %s exists - OK", target_s)
                else:
                    log.debug("No forecast action needed (hour=%02d)", now_h)

            if SOLAR_START_H <= now_h < SOLAR_END_H:
                slot_idx = int((now_h * 60 + now.minute) // SLOT_MIN)
                intraday_slot_key = f"{today_s}:{slot_idx:03d}"
                if intraday_slot_key != last_intraday_slot_key:
                    if _service_stop_requested():
                        raise KeyboardInterrupt
                    clear_forecast_data_cache()
                    run_intraday_adjusted(today)
                    last_intraday_slot_key = intraday_slot_key

            _sleep_with_service_stop(60)   # check every minute

        except KeyboardInterrupt:
            log.info("Shutdown requested â€“ exiting")
            break
        except Exception:
            log.critical("Unhandled exception in main loop", exc_info=True)
            try:
                _sleep_with_service_stop(60)
            except KeyboardInterrupt:
                log.info("Shutdown requested Ã¢â‚¬â€œ exiting")
                break

    _clear_service_stop_file()


if __name__ == "__main__":
    args = parse_cli_args()
    code = run_cli_generation(args)
    if code >= 0:
        sys.exit(code)
    main()
