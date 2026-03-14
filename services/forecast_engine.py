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
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.preprocessing import RobustScaler

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
IPCONFIG_FILE = (PORTABLE_ROOT / "config" / "ipconfig.json") if PORTABLE_ROOT is not None else (BASE / "ipconfig.json")
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

SOLAR_START_SLOT = SOLAR_START_H * 60 // SLOT_MIN
SOLAR_END_SLOT   = SOLAR_END_H   * 60 // SLOT_MIN

# Plant
EXPORT_MW          = 24.0
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

# Adaptive ML residual blending (higher uncertainty -> lower ML influence)
ML_BLEND_MIN = 0.35
ML_BLEND_MAX = 1.00
ML_BLEND_ALPHA = 0.45

# Error memory
ERR_MEMORY_DAYS   = 7      # days used for bias correction
ERR_MEMORY_DECAY  = 0.72   # older day weight decay (geometric series)
ERROR_ALPHA       = 0.28   # fraction of error correction to apply

# Anomaly rejection thresholds
ANOM_MIN_CF    = 0.02   # capacity factor â€“ days below this are bad
ANOM_MAX_CF    = 1.05   # capacity factor â€“ days above this are bad
ANOM_RAD_CORR  = 0.55   # min Pearson r between radiation & generation

# Confidence bands
CONF_CLEAR_BASE = 0.08   # Â±8% on clear days
CONF_CLOUD_ADD  = 0.20   # additional Â±20% on overcast / volatile days
CLOUD_VOLATILE  = 60.0   # cloud cover % threshold for "volatile"

# Forecast re-run schedule (hours UTC+8 when a new day-ahead is computed)
DA_RUN_HOURS = {6, 18}   # 06:00 and 18:00 local
MIN_HOURLY_POINTS = 20
MIN_5MIN_POINTS = 240

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
    load_actual.cache_clear()
    load_actual_with_presence.cache_clear()
    load_dayahead.cache_clear()
    load_dayahead_with_presence.cache_clear()
    load_intraday_adjusted.cache_clear()
    load_intraday_adjusted_with_presence.cache_clear()


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
    cfg = _load_json(IPCONFIG_FILE)
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
        }

    def _sort_key(k: str):
        try:
            return (0, int(k))
        except Exception:
            return (1, k)

    configured = 0
    enabled_nodes = 0
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

    if configured == 0:
        fb_kw = PLANT_MW_FALLBACK * 1000.0
        return {
            "configured_inverters": 0,
            "enabled_nodes": 0,
            "equiv_inverters": fb_kw / max(UNIT_KW_DEPENDABLE, 1.0),
            "dependable_kw": fb_kw,
            "max_kw": fb_kw,
            "source": "fallback",
        }

    equiv_inverters = enabled_nodes / 4.0
    dependable_kw = equiv_inverters * UNIT_KW_DEPENDABLE
    max_kw = equiv_inverters * UNIT_KW_MAX

    return {
        "configured_inverters": configured,
        "enabled_nodes": enabled_nodes,
        "equiv_inverters": equiv_inverters,
        "dependable_kw": dependable_kw,
        "max_kw": max_kw,
        "source": "ipconfig",
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

    NOTE: The export cap (EXPORT_MW) is intentionally NOT applied here.
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


def _normalize_profile(values: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(values, dtype=float), 0.0, None)
    if arr.size == 0:
        return np.array([], dtype=float)
    arr = pd.Series(arr).rolling(3, min_periods=1, center=True).mean().values
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

    use_cache = not (source_kind == "forecast" and day == today)
    if use_cache and cache.exists():
        try:
            df = pd.read_csv(cache, parse_dates=["time"])
            day_df = _slice_weather_day(df, day)
            ok, reason = validate_weather_hourly(day, day_df)
            if ok:
                log.debug("Weather cache hit [%s]: %s (%d rows)", source_kind, day, len(day_df))
                return day_df
            log.warning("Weather cache invalid [%s] for %s: %s", source_kind, day, reason)
        except Exception:
            pass

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
            return None
        day_df.to_csv(cache, index=False)
        log.info("Weather fetched & cached [%s]: %s (%d rows)", source_kind, day, len(day_df))
        return day_df
    except Exception as e:
        log.error("Weather fetch failed [%s] for %s: %s", source_kind, day, e)
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

    out = pd.concat([rad_interp, rest_interp], axis=1).reset_index(drop=True)

    # Gentle smoothing for cloud (meteorological, not sub-minute noise)
    for col in ["cloud", "cloud_low", "cloud_mid", "cloud_high"]:
        if col in out.columns:
            out[col] = out[col].rolling(5, min_periods=1, center=True).mean()

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
    precip_1h = pd.Series(precip).rolling(12, min_periods=1).sum().values
    cloud_std_1h = (
        pd.Series(cloud).rolling(12, min_periods=1).std().fillna(0.0).values
    )

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
    else:
        solcast_kwh = np.zeros(SLOTS_DAY, dtype=float)
        solcast_mw = np.zeros(SLOTS_DAY, dtype=float)
        solcast_spread = np.zeros(SLOTS_DAY, dtype=float)
        solcast_available = np.zeros(SLOTS_DAY, dtype=float)
        solcast_blend = np.zeros(SLOTS_DAY, dtype=float)
        solcast_cov = 0.0
        solcast_rel = 0.0
        solcast_bias_ratio = 1.0
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
    cap_slot = EXPORT_MW * 1000.0 * SLOT_MIN / 60.0
    return (actual >= tol * cap_slot) & (baseline > cap_slot * 1.05)


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


def _query_energy_5min_totals(db_path: Path, day_start_ms: int, day_end_ms: int) -> dict[int, float]:
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
                forecast_kwh[slot_i] = _coerce_non_negative_float(row[1])
                forecast_lo_kwh[slot_i] = _coerce_non_negative_float(row[2], forecast_kwh[slot_i])
                forecast_hi_kwh[slot_i] = _coerce_non_negative_float(row[3], forecast_kwh[slot_i])
                est_actual_kwh[slot_i] = _coerce_non_negative_float(row[4])
                forecast_mw[slot_i] = _coerce_non_negative_float(row[5])
                forecast_lo_mw[slot_i] = _coerce_non_negative_float(row[6], forecast_mw[slot_i])
                forecast_hi_mw[slot_i] = _coerce_non_negative_float(row[7], forecast_mw[slot_i])
                est_actual_mw[slot_i] = _coerce_non_negative_float(row[8])
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
    lookback = max(SOLCAST_RELIABILITY_LOOKBACK_DAYS, N_TRAIN_DAYS)
    for days_ago in range(1, lookback + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        actual = load_actual(day)
        snapshot = load_solcast_snapshot(day)
        if actual is None or not snapshot:
            continue
        wdata = fetch_weather(day, source="archive")
        if wdata is None:
            continue
        w5 = interpolate_5min(wdata, day)
        stats = analyse_weather_day(day, w5, actual)
        present = np.asarray(snapshot["present"], dtype=bool)
        mask = (
            present
            & (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT)
            & (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
            & (np.asarray(snapshot["forecast_kwh"], dtype=float) > 0.0)
        )
        usable = int(np.count_nonzero(mask))
        if usable < SOLCAST_MIN_USABLE_SLOTS:
            continue
        prior = np.clip(np.asarray(snapshot["forecast_kwh"], dtype=float)[mask], 0.0, None)
        actual_slots = np.clip(np.asarray(actual, dtype=float)[mask], 0.0, None)
        spread = np.asarray(snapshot["spread_frac"], dtype=float)[mask]
        if not np.any(prior > 0):
            continue
        ratio = float(np.clip(actual_slots.sum() / max(prior.sum(), 1.0), *SOLCAST_BIAS_RATIO_CLIP))
        mape = float(np.mean(np.abs(actual_slots - prior) / np.maximum(actual_slots, 1.0)))
        records.append({
            "day": day,
            "regime": classify_day_regime(stats),
            "coverage_ratio": float(snapshot.get("coverage_ratio", 0.0)),
            "bias_ratio": ratio,
            "mape": mape,
            "spread_mean": float(np.mean(spread)) if spread.size else 0.0,
        })

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
        "clear": 0.34,
        "mixed": 0.52,
        "overcast": 0.58,
        "rainy": 0.46,
    }.get(regime, 0.44)
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

def compute_error_memory(today: date, w_today_5: pd.DataFrame) -> np.ndarray:
    """
    Compute a weighted-average error correction vector from recent days.

    Uses geometric decay so recent days matter more.
    Only applies where both forecast and actual existed.
    Returns a SLOTS_DAY array of kWh bias corrections.
    """
    weights  = []
    errors   = []
    geo_today = solar_geometry(today.isoformat())

    for d in range(1, ERR_MEMORY_DAYS + 1):
        day   = (today - timedelta(days=d)).isoformat()
        actual = load_actual(day)
        fc     = load_dayahead(day)
        if actual is None or fc is None:
            continue

        err = actual - fc

        # Only count solar hours with meaningful activity
        solar_mask = (
            (geo_today["cos_z"] > 0.05) &
            (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) &
            (np.arange(SLOTS_DAY) <  SOLAR_END_SLOT)
        )
        err[~solar_mask] = 0.0

        # Clip extreme single-slot errors (sensor spikes)
        err = np.clip(err, -200, 200)

        weight = ERR_MEMORY_DECAY ** (d - 1)
        errors.append(err)
        weights.append(weight)

    if not errors:
        return np.zeros(SLOTS_DAY)

    weights   = np.array(weights)
    weight_sum = weights.sum()
    mem_err   = sum(w * e for w, e in zip(weights, errors)) / weight_sum

    # Smooth the error correction (avoid slot-level noise amplification)
    mem_err = pd.Series(mem_err).rolling(7, min_periods=1, center=True).mean().values

    mem_err[:SOLAR_START_SLOT] = 0.0
    mem_err[SOLAR_END_SLOT:]   = 0.0

    return mem_err


def collect_history_days(today: date, lookback_days: int) -> list[dict]:
    """
    Build the historical basis for training and intra-hour hardening.

    Historical samples always pair actual generation with archive weather for
    that same day. This keeps plant-response learning separate from any
    forecast-provider bias.
    """
    history = []
    log.info(
        "Collecting history basis from last %d days using actual archived weather + actual generation",
        lookback_days,
    )

    for days_ago in range(1, lookback_days + 1):
        day = (today - timedelta(days=days_ago)).isoformat()
        actual = load_actual(day)
        wdata = fetch_weather(day, source="archive")
        snapshot = load_solcast_snapshot(day)
        if actual is None or wdata is None:
            log.debug("  Skip %s - missing history basis", day)
            continue

        w5 = interpolate_5min(wdata, day)
        ok_w5, reason_w5 = validate_weather_5min(day, w5)
        if not ok_w5:
            log.warning("  Reject %s - weather quality failed: %s", day, reason_w5)
            continue

        baseline = physics_baseline(day, w5)
        stats = analyse_weather_day(day, w5, actual)
        bad, reason = training_day_rejection(stats, actual, baseline)
        if bad:
            log.warning("  Reject %s - %s", day, reason)
            continue

        history.append({
            "day": day,
            "days_ago": days_ago,
            "actual": np.asarray(actual, dtype=float),
            "weather": w5,
            "baseline": np.asarray(baseline, dtype=float),
            "stats": stats,
            "season": _season_bucket_from_day(day),
            "day_regime": classify_day_regime(stats),
            "first_active_slot": _find_first_active_slot(actual),
            "last_active_slot": _find_last_active_slot(actual),
            "solcast_snapshot": snapshot,
        })

    log.info("History basis accepted: %d day(s)", len(history))
    return history


def build_forecast_artifacts(history_days: list[dict]) -> dict:
    """Build derived artifacts for shape correction and activity gating."""
    shape_records = []
    activity_records = []
    threshold = activity_threshold_kwh()

    for sample in history_days:
        day = str(sample["day"])
        actual = np.asarray(sample["actual"], dtype=float)
        w5 = sample["weather"]
        stats = sample["stats"]
        first_slot = sample.get("first_active_slot")
        last_slot = sample.get("last_active_slot")
        csi_arr = clear_sky_radiation(day, pd.to_numeric(w5["rh"], errors="coerce").fillna(0.0).values)

        if first_slot is not None and last_slot is not None:
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
        "training_basis": "actual archived weather + actual generation",
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
        history_days = collect_history_days(today, SHAPE_LOOKBACK_DAYS)
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
    forecast_smooth = pd.Series(forecast_arr).rolling(3, min_periods=1, center=True).mean().values
    rad_smooth = pd.Series(pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values).rolling(3, min_periods=1, center=True).mean().values
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

    rad = pd.Series(pd.to_numeric(w5["rad"], errors="coerce").fillna(0.0).values).rolling(3, min_periods=1, center=True).mean().values
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

    log.info("Collecting training data from last %d daysâ€¦", N_TRAIN_DAYS)

    for d in range(1, N_TRAIN_DAYS + 1):
        day    = (today - timedelta(days=d)).isoformat()
        actual = load_actual(day)
        wdata  = fetch_weather(day, source="archive")

        if actual is None or wdata is None:
            log.debug("  Skip %s â€“ missing data", day)
            continue

        w5      = interpolate_5min(wdata, day)
        ok_w5, reason_w5 = validate_weather_5min(day, w5)
        if not ok_w5:
            log.warning("  Reject %s â€“ weather quality failed: %s", day, reason_w5)
            continue
        base    = physics_baseline(day, w5)
        stats   = analyse_weather_day(day, w5, actual)
        bad, reason = is_anomalous_day(stats)

        if bad:
            log.warning("  Reject %s â€“ %s", day, reason)
            continue

        log.info(
            "  Accept %s  sky=%-14s  CF=%.3f  corr=%.2f  vol=%.2f",
            day, stats["sky_class"], stats["capacity_factor"],
            stats.get("rad_gen_corr", 0), stats["vol_index"]
        )

        feat    = build_features(w5, day)
        curtailed = curtailed_mask(actual, base)
        mask    = (
            (base > 0) &
            (actual >= 0) &
            (~curtailed) &
            (feat["rad"].values >= RAD_MIN_WM2) &
            (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) &
            (np.arange(SLOTS_DAY) <  SOLAR_END_SLOT)
        )

        if mask.sum() < MIN_SAMPLES:
            log.warning("  Reject %s â€“ too few usable slots (%d)", day, mask.sum())
            continue

        # Residual target: actual âˆ’ physics (what ML needs to learn)
        residual = actual - base
        residual = np.clip(residual, -500, 500)

        X  = feat.loc[mask, FEATURE_COLS]
        y  = residual[mask]

        # Recency weighting (repeat rows proportionally)
        recency_w = max(1, round(RECENCY_BASE ** (N_TRAIN_DAYS - d)))
        X = pd.concat([X] * recency_w, ignore_index=True)
        y = np.tile(y, recency_w)

        X_parts.append(X)
        y_parts.append(y)
        valid_days += 1

    if valid_days < MIN_TRAIN_DAYS:
        log.warning("Only %d valid training days â€“ minimum is %d", valid_days, MIN_TRAIN_DAYS)
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
) -> tuple[pd.DataFrame, np.ndarray, np.ndarray] | tuple[None, None, None]:
    """
    Build the residual-training set from the hardened historical basis.

    The model learns residual plant response from actual archived weather and
    actual generation. Forecast weather is used only at inference time.
    """
    samples = list(history_days or collect_history_days(today, N_TRAIN_DAYS))
    samples = [sample for sample in samples if int(sample.get("days_ago", N_TRAIN_DAYS + 1)) <= N_TRAIN_DAYS]
    if day_regime:
        samples = [sample for sample in samples if str(sample.get("day_regime") or "") == str(day_regime)]

    X_parts = []
    y_parts = []
    weight_parts = []
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
        actual = np.asarray(sample["actual"], dtype=float)
        w5 = sample["weather"]
        base = np.asarray(sample["baseline"], dtype=float)
        stats = sample["stats"]
        solcast_prior = solcast_prior_from_snapshot(
            day,
            w5,
            sample.get("solcast_snapshot"),
            solcast_reliability,
        )
        hybrid_base, hybrid_meta = blend_physics_with_solcast(base, solcast_prior)
        feat = build_features(w5, day, solcast_prior)
        curtailed = curtailed_mask(actual, base)
        mask = (
            (hybrid_base > 0) &
            (actual >= 0) &
            (~curtailed) &
            (feat["rad"].values >= RAD_MIN_WM2) &
            (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) &
            (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
        )

        usable = int(np.count_nonzero(mask))
        if usable < MIN_SAMPLES:
            log.warning("  Reject %s - too few usable slots (%d)", day, usable)
            continue

        residual = np.clip(actual - hybrid_base, -500.0, 500.0)
        X = feat.loc[mask, FEATURE_COLS]
        y = residual[mask]

        recency_weight = _sample_weight_for_days_ago(int(sample.get("days_ago", N_TRAIN_DAYS)))
        corr = float(stats.get("rad_gen_corr", 0.0))
        quality_weight = float(np.clip(0.70 + 0.30 * max(corr, 0.0), 0.55, 1.0))
        sample_weight = np.full(len(y), recency_weight * quality_weight, dtype=float)

        X_parts.append(X)
        y_parts.append(y)
        weight_parts.append(sample_weight)
        if bool(hybrid_meta.get("used_solcast")):
            solcast_days += 1

        log.info(
            "  Train %s  sky=%-14s  CF=%.3f  corr=%.2f  weight=%.3f  usable=%d  solcast=%s blend=%.2f cov=%.2f",
            day,
            stats["sky_class"],
            stats["capacity_factor"],
            corr,
            float(sample_weight[0]) if len(sample_weight) else 0.0,
            usable,
            "yes" if hybrid_meta.get("used_solcast") else "no",
            float(hybrid_meta.get("mean_blend", 0.0)),
            float(hybrid_meta.get("coverage_ratio", 0.0)),
        )

    valid_days = len(X_parts)
    if valid_days < MIN_TRAIN_DAYS:
        log.warning("Only %d valid training days - minimum is %d", valid_days, MIN_TRAIN_DAYS)
        return None, None, None

    X_train = pd.concat(X_parts, ignore_index=True)
    y_train = np.concatenate(y_parts)
    w_train = np.concatenate(weight_parts)
    log.info(
        "Training set: %d samples from %d days (mean sample weight=%.3f, solcast_days=%d)",
        len(y_train),
        valid_days,
        float(np.mean(w_train)),
        int(solcast_days),
    )
    return X_train, y_train, w_train


def _make_residual_regressor() -> GradientBoostingRegressor:
    return GradientBoostingRegressor(
        n_estimators=500,
        learning_rate=0.025,
        max_depth=4,
        min_samples_split=15,
        min_samples_leaf=8,
        subsample=0.8,
        max_features=0.75,
        random_state=42,
        loss="huber",
        alpha=0.85,
        validation_fraction=0.1,
        n_iter_no_change=30,
        tol=1e-4,
    )


def fit_residual_model(
    X: pd.DataFrame,
    y: np.ndarray,
    sample_weight: np.ndarray,
) -> tuple[GradientBoostingRegressor, RobustScaler, dict]:
    scaler = RobustScaler()
    X_sc = scaler.fit_transform(X)
    model = _make_residual_regressor()
    model.fit(X_sc, y, sample_weight=sample_weight)
    meta = {
        "sample_count": int(len(y)),
        "feature_count": int(X.shape[1]),
        "feature_names": list(X.columns),
        "train_score": float(model.train_score_[-1]) if getattr(model, "train_score_", None) is not None and len(model.train_score_) else None,
        "estimators_used": int(getattr(model, "n_estimators_", model.n_estimators)),
    }
    return model, scaler, meta


def build_training_state(today: date) -> dict | None:
    """Build the in-memory model/artifact state for a given training cut-off date."""
    history_days = collect_history_days(today, max(N_TRAIN_DAYS, SHAPE_LOOKBACK_DAYS))
    solcast_reliability = build_solcast_reliability_artifact(today)
    X, y, sample_weight = collect_training_data_hardened(
        today,
        history_days,
        solcast_reliability=solcast_reliability,
    )
    if X is None:
        return None

    global_model, global_scaler, global_meta = fit_residual_model(X, y, sample_weight)
    bundle = {
        "created_ts": int(time.time()),
        "training_basis": "actual archived weather + actual generation (+ Solcast prior when available)",
        "history_days": int(len(history_days)),
        "feature_cols": list(X.columns),
        "global": {
            "model": global_model,
            "scaler": global_scaler,
            "meta": dict(global_meta),
        },
        "regimes": {},
    }

    for regime in sorted({str(sample.get("day_regime") or "") for sample in history_days if sample.get("day_regime")}):
        regime_days = sum(1 for sample in history_days if str(sample.get("day_regime") or "") == regime)
        if regime_days < REGIME_MODEL_MIN_DAYS:
            continue
        X_reg, y_reg, w_reg = collect_training_data_hardened(
            today,
            history_days,
            day_regime=regime,
            solcast_reliability=solcast_reliability,
        )
        if X_reg is None or len(y_reg) < REGIME_MODEL_MIN_SAMPLES:
            continue
        regime_model, regime_scaler, regime_meta = fit_residual_model(X_reg, y_reg, w_reg)
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

    return {
        "created_ts": int(time.time()),
        "training_date": today.isoformat(),
        "history_days": history_days,
        "model_bundle": bundle,
        "forecast_artifacts": build_forecast_artifacts(history_days),
        "weather_bias": build_weather_bias_artifact(today),
        "solcast_reliability": solcast_reliability,
        "global_meta": dict(global_meta),
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

    if MODEL_FILE.exists() and SCALER_FILE.exists():
        try:
            model = load(MODEL_FILE)
            scaler = load(SCALER_FILE)
            return {
                "created_ts": int(time.time()),
                "training_basis": "legacy-single-model",
                "global": {
                    "model": model,
                    "scaler": scaler,
                    "meta": {
                        "sample_count": 0,
                        "feature_count": len(FEATURE_COLS),
                        "train_score": None,
                        "estimators_used": int(getattr(model, "n_estimators_", getattr(model, "n_estimators", 0)) or 0),
                    },
                },
                "regimes": {},
            }
        except Exception as e:
            log.warning("Legacy model load failed: %s", e)
    return None


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
    global_scaler = global_block.get("scaler")
    if global_model is None or global_scaler is None:
        return np.zeros(len(X_pred), dtype=float), {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    expected_cols = list((global_block.get("meta") or {}).get("feature_names") or bundle.get("feature_cols") or [])
    if expected_cols:
        X_aligned = pd.DataFrame(index=X_pred.index)
        for col in expected_cols:
            if col in X_pred.columns:
                X_aligned[col] = pd.to_numeric(X_pred[col], errors="coerce").fillna(0.0)
            else:
                X_aligned[col] = 0.0
        X_pred = X_aligned
    elif hasattr(global_scaler, "n_features_in_") and int(global_scaler.n_features_in_) != int(X_pred.shape[1]):
        raise ValueError(
            f"Feature count mismatch for model bundle (expected {int(global_scaler.n_features_in_)}, got {int(X_pred.shape[1])})"
        )

    X_global = global_scaler.transform(X_pred)
    global_pred = np.asarray(global_model.predict(X_global), dtype=float)
    regime_block = ((bundle.get("regimes") or {}).get(target_regime) or {})
    regime_model = regime_block.get("model")
    regime_scaler = regime_block.get("scaler")
    if regime_model is None or regime_scaler is None:
        return global_pred, {"target_regime": target_regime, "used_regime_model": False, "blend": 0.0}

    X_regime = regime_scaler.transform(X_pred)
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
    dump(global_scaler, SCALER_FILE)
    save_model_bundle(bundle)
    save_forecast_artifacts(state.get("forecast_artifacts") or {})
    save_weather_bias_artifact(state.get("weather_bias") or {})
    save_solcast_reliability_artifact(state.get("solcast_reliability"))
    log.info(
        "Model trained - global_estimators=%d global_train_score=%s regime_models=%d solcast_reliability_days=%d",
        int(global_meta.get("estimators_used", 0)),
        f"{float(global_meta['train_score']):.4f}" if global_meta.get("train_score") is not None else "n/a",
        int(len(bundle["regimes"])),
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

    cloud_std_1h = (
        pd.Series(cloud).rolling(12, min_periods=1).std().fillna(0.0).values / 100.0
    )
    precip_1h = pd.Series(precip).rolling(12, min_periods=1).sum().values

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
    damp = 1.0 - 0.70 * mean_blend * (0.35 + 0.65 * reliability) * (0.55 + 0.45 * coverage)
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
        conf      = (CONF_CLEAR_BASE + cloud_unc + confidence_penalty * 0.12) * tod_factor[i]
        conf      = min(conf, 0.40)   # cap at Â±40%

        lo[i] = v * (1.0 - conf)
        hi[i] = v * (1.0 + conf)

    return lo, hi


# ============================================================================
# FORECAST QUALITY METRICS  (logged after each run)
# ============================================================================

def compute_forecast_metrics(actual: np.ndarray | None, forecast: np.ndarray | None) -> dict | None:
    """Compute solar-window forecast accuracy metrics for slot-level generation."""
    if actual is None or forecast is None:
        return None

    actual_arr = np.nan_to_num(np.asarray(actual, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    forecast_arr = np.nan_to_num(np.asarray(forecast, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    if actual_arr.size < SLOTS_DAY or forecast_arr.size < SLOTS_DAY:
        return None

    solar_mask = (
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) &
        (np.arange(SLOTS_DAY) < SOLAR_END_SLOT)
    )
    if not np.any(solar_mask):
        return None

    act_s = np.clip(actual_arr[solar_mask], 0.0, None)
    fc_s = np.clip(forecast_arr[solar_mask], 0.0, None)
    err = fc_s - act_s
    abs_err = np.abs(err)
    actual_total = float(act_s.sum())
    forecast_total = float(fc_s.sum())

    first_actual = _find_first_active_slot(actual_arr)
    first_forecast = _find_first_active_slot(forecast_arr)
    last_actual = _find_last_active_slot(actual_arr)
    last_forecast = _find_last_active_slot(forecast_arr)

    return {
        "slot_count": int(np.count_nonzero(solar_mask)),
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


def _format_minutes(value: int | None) -> str:
    if value is None:
        return "n/a"
    return f"{int(value):+d}m"


def forecast_qa(today: date) -> None:
    """
    Compute and log forecast accuracy and skill score vs persistence for yesterday.
    Persistence forecast = yesterday's actual shifted to today.
    """
    yesterday = (today - timedelta(days=1)).isoformat()
    day2ago   = (today - timedelta(days=2)).isoformat()

    actual = load_actual(yesterday)
    fc     = load_dayahead(yesterday)
    pers   = load_actual(day2ago)   # persistence proxy

    if actual is None or fc is None:
        log.info("QA: no data for %s", yesterday)
        return

    metrics = compute_forecast_metrics(actual, fc)
    if metrics is None:
        return

    pers_metrics = compute_forecast_metrics(actual, pers) if pers is not None else None
    if pers_metrics is not None and pers_metrics["rmse_kwh"] > 0:
        skill = 1.0 - metrics["rmse_kwh"] / max(pers_metrics["rmse_kwh"], 1.0)
    else:
        skill = float("nan")

    log.info(
        "QA [%s] WAPE=%.1f%% MAPE=%.1f%% TotalAPE=%.1f%% MBE=%.1f kWh/slot RMSE=%.1f kWh/slot First=%s Last=%s Skill=%.3f",
        yesterday,
        metrics["wape_pct"],
        metrics["mape_pct"],
        metrics["total_ape_pct"],
        metrics["mbe_kwh"],
        metrics["rmse_kwh"],
        _format_minutes(metrics["first_active_error_min"]),
        _format_minutes(metrics["last_active_error_min"]),
        skill,
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
    return bool(ok_db or ok_file)


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
    actual, actual_present = load_actual_with_presence(day_s)
    meta = {
        "day": day_s,
        "observed_slots": 0,
        "last_observed_slot": None,
        "global_ratio": 1.0,
        "recent_ratio": 1.0,
        "strength": 0.0,
    }
    if dayahead is None or actual is None or actual_present is None:
        return None, meta

    solar_obs = np.where(np.asarray(actual_present, dtype=bool)[SOLAR_START_SLOT:SOLAR_END_SLOT])[0] + SOLAR_START_SLOT
    if solar_obs.size < INTRADAY_MIN_OBS_SLOTS:
        meta["observed_slots"] = int(solar_obs.size)
        return None, meta

    observed_slots = solar_obs[-min(int(solar_obs.size), INTRADAY_MAX_OBS_SLOTS):]
    last_observed_slot = int(observed_slots[-1])
    obs_mask = np.zeros(SLOTS_DAY, dtype=bool)
    obs_mask[observed_slots] = True
    adjusted = np.asarray(dayahead, dtype=float).copy()
    adjusted[np.asarray(actual_present, dtype=bool)] = np.asarray(actual, dtype=float)[np.asarray(actual_present, dtype=bool)]

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
        "Solcast prior: used=%s primary=%s regime=%s cov=%.2f blend=%.2f reliability=%.2f bias_ratio=%.3f ratio=%.2f->%.2f source=%s",
        bool(solcast_meta.get("used_solcast")),
        solcast_primary,
        solcast_meta.get("regime"),
        float(solcast_meta.get("coverage_ratio", 0.0)),
        float(solcast_meta.get("mean_blend", 0.0)),
        float(solcast_meta.get("reliability", 0.0)),
        float(solcast_meta.get("bias_ratio", 1.0)),
        float(solcast_meta.get("raw_prior_ratio", 1.0)),
        float(solcast_meta.get("applied_prior_ratio", 1.0)),
        solcast_meta.get("source"),
    )

    # 3. ML residual correction
    ml_residual = np.zeros(SLOTS_DAY)
    if runtime_state is not None and "model_bundle" in runtime_state:
        model_bundle = runtime_state.get("model_bundle")
    else:
        model_bundle = load_model_bundle()
    if model_bundle:
        try:
            feat   = build_features(w5, target_s, solcast_prior)
            X_pred = feat[FEATURE_COLS]
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
            blend = residual_blend_vector(w5, target_s, float(bias_meta.get("regime_confidence", 1.0)))
            ml_residual = ml_residual * blend
            ml_residual = (
                pd.Series(ml_residual)
                .rolling(3, min_periods=1, center=True)
                .mean()
                .values
            )
            solcast_residual_scale = solcast_residual_damp_factor(solcast_meta)
            if solcast_residual_scale < 0.999:
                ml_residual = ml_residual * solcast_residual_scale

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
        except Exception as e:
            log.error("ML prediction failed â€“ falling back to physics only: %s", e)
            ml_residual = np.zeros(SLOTS_DAY)
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
    forecast = hybrid_baseline + ml_residual + bias_correction

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
    lo, hi = confidence_bands(forecast, w5, target_s, float(bias_meta.get("regime_confidence", 1.0)))

    # 7. Summary log
    log.info(
        "Forecast summary: total=%.0f kWh  peak=%.2f kWh/slot  "
        "baseline_total=%.0f kWh  hybrid_total=%.0f kWh  ml_corr=%.0f kWh  bias_corr=%.0f kWh",
        forecast.sum(),
        forecast.max(),
        baseline.sum(),
        hybrid_baseline.sum(),
        ml_residual.sum(),
        bias_correction.sum(),
    )

    series = to_ui_series(forecast, lo, hi, target_s)
    if not persist:
        return {
            "day": target_s,
            "series": series,
            "forecast": forecast,
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
            "bias_total_kwh": float(bias_correction.sum()),
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
            },
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

    # Train once for the batch to keep forecast basis consistent.
    trained = train_model(today_ref)
    if not trained:
        log.warning("Manual generation: model training skipped - physics fallback may be used.")

    forecast_qa(today_ref)

    ok_all = True
    for d in dates:
        ok = run_dayahead(d, today_ref)
        if ok and d == today_ref:
            run_intraday_adjusted(d)
        ok_all = ok_all and ok
        if ok:
            log.info("Manual generation OK: %s", d.isoformat())
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
        actual = load_actual(target_s)
        if actual is None:
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

        metrics = compute_forecast_metrics(actual, np.asarray(result["forecast"], dtype=float))
        if metrics is None:
            skipped_forecast += 1
            log.warning("Backtest skip [%s] - forecast metrics unavailable", target_s)
            continue

        rows.append({
            "day": target_s,
            "reference_day": reference_day.isoformat(),
            "weather_source": str(result.get("weather_source") or ""),
            "target_regime": str(result.get("target_regime") or ""),
            "solcast_used": bool((result.get("solcast_meta") or {}).get("used_solcast")),
            "solcast_blend": float((result.get("solcast_meta") or {}).get("mean_blend", 0.0)),
            **metrics,
        })
        log.info(
            "Backtest [%s] WAPE=%.1f%% TotalAPE=%.1f%% MAPE=%.1f%% RMSE=%.1f kWh/slot First=%s Last=%s regime=%s solcast=%s blend=%.2f",
            target_s,
            metrics["wape_pct"],
            metrics["total_ape_pct"],
            metrics["mape_pct"],
            metrics["rmse_kwh"],
            _format_minutes(metrics["first_active_error_min"]),
            _format_minutes(metrics["last_active_error_min"]),
            result.get("target_regime"),
            bool((result.get("solcast_meta") or {}).get("used_solcast")),
            float((result.get("solcast_meta") or {}).get("mean_blend", 0.0)),
        )

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

def _read_operation_mode() -> str:
    """Read operationMode from the settings table. Returns 'gateway' or 'remote'."""
    try:
        conn = _open_sqlite(APP_DB_FILE, SQLITE_READ_TIMEOUT_SEC, readonly=True)
        try:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = 'operationMode' LIMIT 1"
            ).fetchone()
            return str(row[0]).strip().lower() if row else "gateway"
        finally:
            conn.close()
    except Exception:
        return "gateway"


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
    log.info("Plant Capacity: %.3f MW dep  /  %.3f MW max", cap_dep / 1000.0, cap_max / 1000.0)
    log.info("Slot Cap      : dep=%.4f MWh  max=%.4f MWh per 5-min", slot_cap_kwh(True) / 1000.0, slot_cap_kwh(False) / 1000.0)
    log.info("Export Limit  : %.0f MW  (dispatch only - not applied to forecast curve)", EXPORT_MW)
    log.info("Train Window  : %d days  (min %d)", N_TRAIN_DAYS, MIN_TRAIN_DAYS)
    log.info("Actual Source : AppData energy_5min (hot + archive), legacy JSON fallback only")
    log.info("=" * 70)

    last_run_hour = -1   # track which hour we last ran in
    last_intraday_slot_key = ""

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
            target     = today + timedelta(days=1)
            target_s   = target.isoformat()
            now_h      = now.hour

            ctx_fc     = _load_json(FORECAST_CTX)
            da_target  = ctx_fc.get("PacEnergy_DayAhead", {}).get(target_s)
            da_today   = ctx_fc.get("PacEnergy_DayAhead", {}).get(today_s)

            # â”€â”€â”€ Decide whether to run a forecast this loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            #
            # Run conditions (any one sufficient):
            #   A) Scheduled hour (DA_RUN_HOURS) and we haven't run this hour yet
            #   B) Target-day forecast is missing entirely
            #   C) Today's forecast is missing and we are inside solar hours
            #      (morning recovery)

            run_scheduled = (now_h in DA_RUN_HOURS) and (last_run_hour != now_h)
            run_missing   = (da_target is None)
            run_recovery  = (SOLAR_START_H <= now_h < SOLAR_END_H) and (da_today is None)

            if run_scheduled or run_missing:
                log.info(
                    "Run trigger: scheduled=%s  missing_target=%s",
                    run_scheduled, run_missing,
                )
                clear_forecast_data_cache()
                if _service_stop_requested():
                    raise KeyboardInterrupt

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

                # Generate tomorrow's day-ahead
                ok = run_dayahead(target, today)
                if ok:
                    last_run_hour = now_h
                    log.info("Day-ahead for %s completed successfully", target_s)
                else:
                    log.error("Day-ahead for %s FAILED", target_s)

            elif run_recovery:
                log.warning("Recovery: today %s missing day-ahead â€“ generating now", today_s)
                clear_forecast_data_cache()
                if _service_stop_requested():
                    raise KeyboardInterrupt
                run_dayahead(today, today)

            else:
                log.debug("No forecast action needed (hour=%02d)", now_h)

            if SOLAR_START_H <= now_h < SOLAR_END_H:
                slot_idx = int((now_h * 60 + now.minute) // SLOT_MIN)
                intraday_slot_key = f"{today_s}:{slot_idx:03d}"
                if intraday_slot_key != last_intraday_slot_key:
                    if _service_stop_requested():
                        raise KeyboardInterrupt
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
