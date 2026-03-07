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
from datetime import datetime, timedelta
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
PORTABLE_ROOT_RAW = str(os.getenv("IM_PORTABLE_DATA_DIR") or "").strip()
PORTABLE_ROOT = Path(PORTABLE_ROOT_RAW) if PORTABLE_ROOT_RAW else None
EXPLICIT_DATA_DIR = str(os.getenv("IM_DATA_DIR") or "").strip()

if PORTABLE_ROOT is not None:
    BASE = PORTABLE_ROOT / "programdata"
else:
    BASE = Path(os.getenv("PROGRAMDATA") or os.getenv("ALLUSERSPROFILE") or r"C:\ProgramData") / "InverterDashboard"

HISTORY_CTX   = BASE / "history/context/global/global.json"
FORECAST_CTX  = BASE / "forecast/context/global/global.json"
MODEL_FILE    = BASE / "forecast/pv_dayahead_model.joblib"
SCALER_FILE   = BASE / "forecast/pv_dayahead_scaler.joblib"
WEATHER_DIR   = BASE / "weather"
IPCONFIG_FILE = (PORTABLE_ROOT / "config" / "ipconfig.json") if PORTABLE_ROOT is not None else (BASE / "ipconfig.json")
LOG_FILE      = BASE / "logs/forecast_dayahead.log"

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

for _d in [WEATHER_DIR, MODEL_FILE.parent, LOG_FILE.parent, APP_DB_FILE.parent, IPCONFIG_FILE.parent]:
    _d.mkdir(parents=True, exist_ok=True)

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
N_TRAIN_DAYS   = 14    # rolling training window (days)
MIN_TRAIN_DAYS = 3     # minimum days before ML is used
RECENCY_BASE   = 1.6   # weight multiplier per day closer to today
MIN_SAMPLES    = 60    # minimum usable slots per training day
MIN_HISTORY_SOLAR_SLOTS = MIN_SAMPLES
MIN_DAYAHEAD_SOLAR_SLOTS = max(24, MIN_SAMPLES // 2)

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


def clear_forecast_data_cache() -> None:
    load_actual.cache_clear()
    load_dayahead.cache_clear()


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


# ============================================================================
# WEATHER FETCH & CACHE
# ============================================================================

def fetch_weather(day: str) -> pd.DataFrame | None:
    """
    Fetch hourly weather from Open-Meteo for *day* (YYYY-MM-DD).
    Returns a DataFrame with columns: time, rad, cloud, temp, rh, wind_speed.
    Caches per-day CSV; re-fetches today every call.
    """
    loc_tag = f"{LAT_DEG:.6f}_{LON_DEG:.6f}".replace("-", "m")
    cache = WEATHER_DIR / f"om_{day}_{loc_tag}.csv"
    today = datetime.now().strftime("%Y-%m-%d")

    if day != today and cache.exists():
        try:
            df = pd.read_csv(cache, parse_dates=["time"])
            day_df = _slice_weather_day(df, day)
            ok, reason = validate_weather_hourly(day, day_df)
            if ok:
                log.debug("Weather cache hit: %s (%d rows)", day, len(day_df))
                return day_df
            log.warning("Weather cache invalid for %s: %s", day, reason)
        except Exception:
            pass

    hourly_fields = (
        "shortwave_radiation,direct_radiation,diffuse_radiation,"
        "cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high,"
        "temperature_2m,relativehumidity_2m,windspeed_10m,precipitation,cape"
    )
    if _is_past_day(day):
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
            log.error("Weather fetched but invalid for %s: %s", day, reason)
            return None
        day_df.to_csv(cache, index=False)
        log.info("Weather fetched & cached: %s (%d rows)", day, len(day_df))
        return day_df
    except Exception as e:
        log.error("Weather fetch failed for %s: %s", day, e)
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
        .clip(lower=0)
    )

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


# ============================================================================
# FEATURE ENGINEERING  (rich, physics-informed)
# ============================================================================

def build_features(w5: pd.DataFrame, day: str) -> pd.DataFrame:
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
        "doy_sin":       doy_sin,
        "doy_cos":       doy_cos,
        # Plant
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
    "solar_prog", "solar_prog_sq", "solar_prog_sin", "tod_sin", "tod_cos", "doy_sin", "doy_cos",
    "cap_kw",
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
def load_actual(day: str) -> np.ndarray | None:
    db_actual, db_present = _load_actual_from_appdata(day)
    legacy_actual, legacy_present = _load_actual_from_legacy_context(day)
    return _merge_slot_series(
        "Actual history",
        day,
        db_actual,
        db_present,
        legacy_actual,
        legacy_present,
        MIN_HISTORY_SOLAR_SLOTS,
    )


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
def load_dayahead(day: str) -> np.ndarray | None:
    db_rows, db_present = _load_dayahead_from_db(day)
    legacy_rows, legacy_present = _load_dayahead_from_legacy(day)
    return _merge_slot_series(
        "Day-ahead history",
        day,
        db_rows,
        db_present,
        legacy_rows,
        legacy_present,
        MIN_DAYAHEAD_SOLAR_SLOTS,
    )


# ============================================================================
# ERROR MEMORY  (rolling bias correction)
# ============================================================================

def compute_error_memory(today: datetime.date, w_today_5: pd.DataFrame) -> np.ndarray:
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


# ============================================================================
# MODEL TRAINING
# ============================================================================

def collect_training_data(today: datetime.date) -> tuple[pd.DataFrame, np.ndarray] | tuple[None, None]:
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
        wdata  = fetch_weather(day)

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


def train_model(today: datetime.date) -> bool:
    """Train (or retrain) the residual correction model."""
    X, y = collect_training_data(today)
    if X is None:
        return False

    scaler = RobustScaler()
    X_sc   = scaler.fit_transform(X)

    model = GradientBoostingRegressor(
        n_estimators      = 500,
        learning_rate     = 0.025,
        max_depth         = 4,
        min_samples_split = 15,
        min_samples_leaf  = 8,
        subsample         = 0.8,
        max_features      = 0.75,
        random_state      = 42,
        loss              = "huber",
        alpha             = 0.85,
        validation_fraction = 0.1,
        n_iter_no_change  = 30,
        tol               = 1e-4,
    )
    model.fit(X_sc, y)

    dump(model,  MODEL_FILE)
    dump(scaler, SCALER_FILE)
    log.info(
        "Model trained â€“ estimators used: %d  train_score: %.4f",
        model.n_estimators_,
        model.train_score_[-1],
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


def residual_blend_vector(w5: pd.DataFrame, day: str) -> np.ndarray:
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

    blend = solar_conf * (1.0 - ML_BLEND_ALPHA * uncertainty)
    blend = np.clip(blend, ML_BLEND_MIN, ML_BLEND_MAX)
    blend[:SOLAR_START_SLOT] = 0.0
    blend[SOLAR_END_SLOT:] = 0.0
    return blend


# ============================================================================
# CONFIDENCE BANDS
# ============================================================================

def confidence_bands(
    values: np.ndarray,
    w5: pd.DataFrame,
    day: str,
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
        conf      = (CONF_CLEAR_BASE + cloud_unc) * tod_factor[i]
        conf      = min(conf, 0.40)   # cap at Â±40%

        lo[i] = v * (1.0 - conf)
        hi[i] = v * (1.0 + conf)

    return lo, hi


# ============================================================================
# FORECAST QUALITY METRICS  (logged after each run)
# ============================================================================

def forecast_qa(today: datetime.date) -> None:
    """
    Compute and log MAPE, MBE, skill score vs persistence for yesterday.
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

    mask = (
        (actual > 0) &
        (fc > 0) &
        (np.arange(SLOTS_DAY) >= SOLAR_START_SLOT) &
        (np.arange(SLOTS_DAY) <  SOLAR_END_SLOT)
    )
    if mask.sum() == 0:
        return

    act_s = actual[mask]
    fc_s  = fc[mask]

    mape = float(np.mean(np.abs(act_s - fc_s) / np.maximum(act_s, 1)) * 100)
    mbe  = float(np.mean(fc_s - act_s))
    rmse = float(np.sqrt(np.mean((fc_s - act_s) ** 2)))

    if pers is not None and pers[mask].std() > 0:
        pers_s   = pers[mask]
        rmse_pers = float(np.sqrt(np.mean((pers_s - act_s) ** 2)))
        skill     = 1.0 - rmse / max(rmse_pers, 1)
    else:
        skill = float("nan")

    log.info(
        "QA [%s]  MAPE=%.1f%%  MBE=%.1f kWh/slot  RMSE=%.1f kWh/slot  Skill=%.3f",
        yesterday, mape, mbe, rmse, skill
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


def _ensure_forecast_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS forecast_dayahead (
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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_fd_ts ON forecast_dayahead(ts)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_fd_date_ts ON forecast_dayahead(date, ts)"
    )


def _write_forecast_db(key: str, day: str, series: list[dict]) -> bool:
    """
    Persist day-ahead slots to SQLite so forecast data is unified with AppData DB.
    Keeps file write path for compatibility while DB is now the source of truth.
    """
    if key != "PacEnergy_DayAhead":
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
                _ensure_forecast_table(conn)
                cur = conn.cursor()
                cur.execute("DELETE FROM forecast_dayahead WHERE date=?", (str(day),))
                cur.executemany(
                    """
                    INSERT INTO forecast_dayahead
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
            log.info("Wrote forecast DB [%s] - %d slots", day, len(rows))
            return True
        except Exception as e:
            if attempt < SQLITE_RETRY_ATTEMPTS and _is_retryable_sqlite_error(e):
                log.warning(
                    "DB forecast write retry %d/%d for %s: %s",
                    attempt,
                    SQLITE_RETRY_ATTEMPTS,
                    day,
                    e,
                )
                _sleep_sqlite_retry(attempt)
                continue
            log.error("DB forecast write failed for %s: %s", day, e)
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


# ============================================================================
# CORE FORECAST FUNCTION
# ============================================================================

def run_dayahead(target_date: datetime.date, today: datetime.date) -> bool:
    """
    Generate and persist the day-ahead forecast for *target_date*.

    Pipeline:
        1. Fetch weather for target day
        2. Compute physics baseline
        3. Predict ML residual (if model available)
        4. Apply error memory bias correction
        5. Clip to slot capacity, enforce ramp limits
        6. Compute confidence bands
        7. Write to forecast context

    Returns True on success.
    """
    target_s = target_date.isoformat()
    log.info("â”€â”€ Day-Ahead Forecast  target=%s â”€â”€", target_s)

    # 1. Weather
    wdata = fetch_weather(target_s)
    if wdata is None:
        log.error("Cannot run forecast â€“ weather unavailable for %s", target_s)
        return False

    w5   = interpolate_5min(wdata, target_s)
    ok_w5, reason_w5 = validate_weather_5min(target_s, w5)
    if not ok_w5:
        log.error("Cannot run forecast â€“ weather quality failed for %s: %s", target_s, reason_w5)
        return False
    stats = analyse_weather_day(target_s, w5)
    log.info(
        "Target weather: sky=%-14s  cloud=%.0f%%  rad_peak=%.0f W/mÂ²  "
        "RH=%.0f%%  convective=%s  rainy=%s",
        stats["sky_class"], stats["cloud_mean"], stats["rad_peak"],
        stats["rh_mean"], stats["convective"], stats["rainy"],
    )

    # 2. Physics baseline
    baseline = physics_baseline(target_s, w5)

    # 3. ML residual correction
    ml_residual = np.zeros(SLOTS_DAY)
    if MODEL_FILE.exists() and SCALER_FILE.exists():
        try:
            model  = load(MODEL_FILE)
            scaler = load(SCALER_FILE)
            feat   = build_features(w5, target_s)
            X_pred = feat[FEATURE_COLS]
            X_sc   = scaler.transform(X_pred)
            raw_residual          = model.predict(X_sc)
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
            blend = residual_blend_vector(w5, target_s)
            ml_residual = ml_residual * blend
            ml_residual = (
                pd.Series(ml_residual)
                .rolling(3, min_periods=1, center=True)
                .mean()
                .values
            )

            log.info(
                "ML residual: mean=%.2f  std=%.2f  p95=%.2f kWh/slot  blend_mean=%.2f",
                ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
                ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT].std(),
                np.percentile(np.abs(ml_residual[SOLAR_START_SLOT:SOLAR_END_SLOT]), 95),
                blend[SOLAR_START_SLOT:SOLAR_END_SLOT].mean(),
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
    forecast = baseline + ml_residual + bias_correction

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
    lo, hi = confidence_bands(forecast, w5, target_s)

    # 7. Summary log
    log.info(
        "Forecast summary: total=%.0f kWh  peak=%.2f kWh/slot  "
        "baseline_total=%.0f kWh  ml_corr=%.0f kWh  bias_corr=%.0f kWh",
        forecast.sum(),
        forecast.max(),
        baseline.sum(),
        ml_residual.sum(),
        bias_correction.sum(),
    )

    # 8. Write
    series = to_ui_series(forecast, lo, hi, target_s)
    return write_forecast("PacEnergy_DayAhead", target_s, series)


# ============================================================================
# MANUAL GENERATION (CLI)
# ============================================================================

def _parse_iso_date_safe(value: str) -> datetime.date:
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except Exception as e:
        raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from e


def _iter_days(start_date: datetime.date, end_date: datetime.date) -> list[datetime.date]:
    if end_date < start_date:
        raise ValueError("End date must be on or after start date.")
    days = []
    cur = start_date
    while cur <= end_date:
        days.append(cur)
        cur += timedelta(days=1)
    return days


def run_manual_generation(dates: list[datetime.date]) -> bool:
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
        ok_all = ok_all and ok
        if ok:
            log.info("Manual generation OK: %s", d.isoformat())
        else:
            log.error("Manual generation FAILED: %s", d.isoformat())

    return ok_all


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
    return parser.parse_args()


def run_cli_generation(args) -> int:
    try:
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

        return -1  # no CLI generation mode requested
    except Exception as e:
        log.error("Manual generation argument error: %s", e)
        return 2


# ============================================================================
# MAIN SERVICE LOOP
# ============================================================================

def main() -> None:
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

    while True:
        try:
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

                # (Re)train model before forecast
                trained = train_model(today)
                if not trained:
                    log.warning("Model training skipped â€“ will use existing model or physics")

                # Forecast quality audit of yesterday
                forecast_qa(today)

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
                run_dayahead(today, today)

            else:
                log.debug("No forecast action needed (hour=%02d)", now_h)

            time.sleep(60)   # check every minute

        except KeyboardInterrupt:
            log.info("Shutdown requested â€“ exiting")
            break
        except Exception:
            log.critical("Unhandled exception in main loop", exc_info=True)
            time.sleep(60)


if __name__ == "__main__":
    args = parse_cli_args()
    code = run_cli_generation(args)
    if code >= 0:
        sys.exit(code)
    main()
