"""
Shared utilities for Tropical Cyclone ensemble and under-monitoring spaghetti plots.

Provides:
  - Geodesic math and antimeridian-safe coordinate normalization
  - Fast vectorized `.dat`/`.enc`/CSV/ATCF track loading and schema normalization
  - Cached Philippine province and municipality GeoJSON / STRtree spatial lookups
  - Philippine landfall detection and statistical aggregation
  - Shared Cartopy dark-theme map backdrop, track rendering, and docked layout helpers
  - Atomic `spaghetti_manifest.json` upsert and rolling 8-cycle PNG pruning
"""

import base64
from collections import Counter
from datetime import datetime, timedelta, timezone
import io
import json
import math
import os
import re
import urllib.request

import cartopy.crs as ccrs
import cartopy.feature as cfeature
from cartopy.mpl.gridliner import LongitudeFormatter
import matplotlib.colors as mcolors
import matplotlib.patches as mpatches
import matplotlib.patheffects as path_effects
import matplotlib.ticker as mticker
from matplotlib.collections import LineCollection
import numpy as np
import pandas as pd
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

# ── Color Palettes & Scales ───────────────────────────────────────────────────
WIND_BOUNDS = [20, 30, 40, 50, 60, 70, 80, 100, 120, 140]
WIND_COLORS = [
    '#0f766e',  # < 20: dark teal
    '#14b8a6',  # 20-30: teal
    '#06b6d4',  # 30-40: cyan
    '#22c55e',  # 40-50: green
    '#84cc16',  # 50-60: lime
    '#eab308',  # 60-70: yellow
    '#f97316',  # 70-80: orange
    '#ef4444',  # 80-100: red
    '#ec4899',  # 100-120: hot pink
    '#a855f7',  # 120-140: purple
    '#f3e8ff',  # > 140: light lilac
]

PRESSURE_BOUNDS = [930, 940, 950, 960, 970, 980, 990, 1000, 1005, 1010]
PRESSURE_COLORS = [
    '#311b92', '#4a148c', '#d500f9', '#880e4f', '#d50000',
    '#ff6d00', '#ffd600', '#00c853', '#00b0ff', '#2962ff', '#1a237e',
]

INTENSITY_BANDS = [
    ('LPA', 0, 25, '#080d1a', 0.45, '#94a3b8'),
    ('TD', 25, 34, '#0c1b2e', 0.40, '#38bdf8'),
    ('TS', 34, 64, '#042f2e', 0.35, '#2dd4bf'),
    ('C1', 64, 83, '#2e1c07', 0.35, '#facc15'),
    ('C2', 83, 96, '#381308', 0.35, '#fb923c'),
    ('C3', 96, 113, '#3b0b0b', 0.35, '#f87171'),
    ('C4', 113, 137, '#380a3a', 0.35, '#e879f9'),
    ('C5', 137, 160, '#22083a', 0.35, '#c084fc'),
]

PAR_VERTICES = [
    (115.0, 5.0), (115.0, 15.0), (120.0, 21.0), (120.0, 25.0),
    (135.0, 25.0), (135.0, 5.0), (115.0, 5.0),
]

DISCLAIMER_TEXT = "Note: For informational purposes only — not an official forecast."

# ── Module-Level Spatial Caches ───────────────────────────────────────────────
_ph_municipalities_tree = None
_ph_muni_geoms = None
_ph_muni_props = None
_ph_province_geoms = None


def resolve_data_path(rel_parts, script_file=None):
    """
    Returns the first existing path among script directory, current working directory,
    or relative path for a target inside the workspace, or the script-dir target if none exist yet.
    """
    base_dir = os.path.dirname(os.path.abspath(script_file or __file__))
    candidates = [
        os.path.join(base_dir, *rel_parts),
        os.path.join(os.getcwd(), *rel_parts),
        os.path.join(*rel_parts),
    ]
    return next((p for p in candidates if os.path.exists(p)), candidates[0])


def resolve_output_dir(output_dir, script_file=None):
    """Resolves a relative output directory consistently against cwd or script directory."""
    if os.path.isabs(output_dir):
        os.makedirs(output_dir, exist_ok=True)
        return output_dir
    base_dir = os.path.dirname(os.path.abspath(script_file or __file__))
    script_target = os.path.join(base_dir, output_dir)
    if not os.path.exists(output_dir) and os.path.exists(script_target):
        resolved = script_target
    elif os.path.exists(os.path.join(base_dir, 'public')):
        resolved = script_target
    else:
        resolved = os.path.abspath(output_dir)
    os.makedirs(resolved, exist_ok=True)
    return resolved


# ── Geodesic & Longitude Helpers ──────────────────────────────────────────────
def haversine_km(lat1, lon1, lat2, lon2):
    """
    Calculates great-circle distance between two points in kilometers.
    Wraps longitude difference across the antimeridian / dateline and clamps radicands.
    """
    radius_km = 6371.0
    dlat = math.radians(lat2 - lat1)
    diff_lon = (lon2 - lon1 + 180.0) % 360.0 - 180.0
    dlon = math.radians(diff_lon)
    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2.0) ** 2
    )
    a = min(1.0, max(0.0, a))
    return radius_km * 2.0 * math.asin(math.sqrt(a))


def unwrap_lon_for_cpac(lon, has_cpac=True):
    """Converts negative western-hemisphere longitudes to [0, 360) when rendering across the dateline."""
    if not has_cpac:
        return lon
    return lon if lon >= 0.0 else lon + 360.0


def unwrap_lon_array(lons):
    """Unwraps an ordered sequence of longitudes to avoid 360-degree discontinuities across ±180."""
    arr = np.asarray(lons, dtype=float)
    if len(arr) <= 1:
        return arr
    rads = np.deg2rad(arr)
    unwrapped = np.unwrap(rads)
    return np.rad2deg(unwrapped)


def mean_geo_center(points, lons=None):
    """
    Computes the geographic centroid using spherical (3D Cartesian) averaging,
    correctly handling dateline / antimeridian wrapping (-180 / +180).
    Supports either:
      1. points as list of dicts [{'lat': ..., 'lon': ...}] or list of (lat, lon) tuples
      2. points as lats list, with second argument lons list: mean_geo_center(lats, lons) -> (lat, lon)
    """
    is_lat_lon_pair = False
    if lons is not None:
        is_lat_lon_pair = True
        pts = [
            {'lat': float(lat), 'lon': float(lon)}
            for lat, lon in zip(points, lons)
            if not np.isnan(lat) and not np.isnan(lon)
        ]
    elif isinstance(points, (list, tuple)) and points and isinstance(points[0], (list, tuple)):
        pts = [
            {'lat': float(p[0]), 'lon': float(p[1])}
            for p in points
            if not np.isnan(p[0]) and not np.isnan(p[1])
        ]
    else:
        pts = [
            {'lat': float(p['lat']), 'lon': float(p['lon'])}
            for p in points
            if not np.isnan(p.get('lat', np.nan)) and not np.isnan(p.get('lon', np.nan))
        ]

    if not pts:
        return (15.0, 135.0) if is_lat_lon_pair else {'lat': 0.0, 'lon': 0.0}

    sum_x = 0.0
    sum_y = 0.0
    sum_z = 0.0
    for pt in pts:
        lat_rad = math.radians(pt['lat'])
        lon_rad = math.radians(pt['lon'])
        sum_x += math.cos(lat_rad) * math.cos(lon_rad)
        sum_y += math.cos(lat_rad) * math.sin(lon_rad)
        sum_z += math.sin(lat_rad)

    n = len(pts)
    avg_x = sum_x / n
    avg_y = sum_y / n
    avg_z = sum_z / n
    hyp = math.sqrt(avg_x * avg_x + avg_y * avg_y)
    lat = math.degrees(math.atan2(avg_z, hyp))
    lon = math.degrees(math.atan2(avg_y, avg_x))
    if is_lat_lon_pair:
        return lat, lon
    return {'lat': lat, 'lon': lon}


# ── Formatting & Model Inference ──────────────────────────────────────────────
def format_percentage(cnt, total):
    """
    Formats a member count as a percentage float value and human-readable string.
    For large ensembles (>= 500), shows 1 decimal below 10% so rare signals are not misrepresented as 0%.
    """
    if total <= 0 or cnt <= 0:
        return 0.0, "0%"
    raw = (cnt / total) * 100.0
    if total >= 500:
        if raw < 10.0:
            return raw, f"{raw:.1f}%"
        return float(round(raw)), f"{int(round(raw))}%"
    rounded = int(round(raw))
    if rounded == 0 and cnt > 0:
        return raw, "<1%"
    return float(rounded), f"{rounded}%"


def format_init_time(init_time_val):
    """Converts init_time values to standard formatted string: '18Z Nov 26 2026'."""
    if pd.isna(init_time_val):
        return 'Unknown'

    init_str = str(init_time_val).strip()
    formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d",
        "%Y%m%d%H",
        "%Y%m%d%H%M",
    ]
    for fmt in formats:
        try:
            dt = datetime.strptime(init_str, fmt)
            return dt.strftime("%HZ %b %d %Y")
        except ValueError:
            continue
    return init_str


def parse_utc_init_datetime(init_time_raw):
    """Parses an init_time value into a timezone-aware UTC datetime, falling back to current UTC."""
    try:
        dt = pd.to_datetime(init_time_raw)
        if pd.isna(dt):
            return datetime.now(timezone.utc)
        if dt.tzinfo is not None:
            return dt.tz_convert(timezone.utc).to_pydatetime()
        return dt.replace(tzinfo=timezone.utc).to_pydatetime()
    except Exception:
        return datetime.now(timezone.utc)


def format_model_display_title(model_name):
    """Formats the uppercase model label shown in graphic subtitles without changing manifest keys."""
    cleaned = re.sub(r'\bLARGE\b', '', str(model_name or 'Ensemble Model'), flags=re.I)
    return re.sub(r'\s+', ' ', cleaned).strip().upper() or 'ENSEMBLE MODEL'


def detect_model_name(file_path):
    """Determines canonical display model name from the dataset path."""
    name = os.path.basename(file_path).lower()
    if any(k in name for k in ['large', 'wnc_large', 'wnclarge']):
        return 'GDM WNC Large'
    if 'fnv3p2' in name:
        return 'GDM WNC Base'
    if 'fnv3p1' in name:
        return 'GDM WNCP1'
    if any(k in name for k in ['wnv3', 'wncv3', 'wnc', 'fnv3', 'oper']):
        return 'GDM WNCv3'
    if 'aifs' in name:
        return 'ECMWF AIFS'
    if 'ifs' in name:
        return 'ECMWF IFS'
    if 'aigefs' in name:
        return 'NOAA AI-GEFS'
    return 'Ensemble Model'


def infer_total_members(file_path='', model_name='', df_normalized=None, explicit_total=None):
    """
    Determines the true ensemble member count for percentage denominators.
    Distinguishes 50-member FNV3P2/P1 from 64-member WNCv3 and 1,000-member WNC Large.
    """
    f_lower = os.path.basename(file_path or '').lower()
    m_lower = (model_name or '').lower()

    raw_m = 0
    pos_m = 0
    if df_normalized is not None and not df_normalized.empty and 'sample' in df_normalized.columns:
        raw_m = int(df_normalized['sample'].nunique())
        pos_m = int(df_normalized[df_normalized['sample'] >= 0]['sample'].nunique())

    if 'large' in f_lower or 'large' in m_lower or raw_m in (999, 1000) or pos_m in (999, 1000):
        return 1000
    if any(k in f_lower for k in ['fnv3p2', 'fnv3p1']) or any(k in m_lower for k in ['wnc base', 'wncp1', 'fnv3p2', 'fnv3p1']):
        return 64 if raw_m in (63, 64) else 50
    if any(k in f_lower for k in ['wncv3', 'wnv3', 'fnv3', 'oper']) or any(k in m_lower for k in ['wncv3', 'wnv3', 'fnv3', 'oper']):
        if raw_m in (49, 50) and 'wnv3' not in f_lower and 'wncv3' not in m_lower:
            return 50
        return 64
    if 'aifs' in f_lower or 'aifs' in m_lower:
        return max(pos_m, 50) if pos_m in (51, 52) else 50
    if 'ifs' in f_lower or 'ifs' in m_lower:
        return max(pos_m, 51) if pos_m >= 50 else 51
    if 'aigefs' in f_lower or 'aigefs' in m_lower:
        return 31
    if explicit_total in (63, 64):
        return 64
    if explicit_total in (999, 1000):
        return 1000
    if explicit_total and explicit_total > 0:
        return int(explicit_total)
    return max(pos_m if pos_m > 0 else raw_m, 1)


def is_run_too_old(df, max_age_days=5.0):
    """Returns (is_too_old, latest_init_str, age_days) by parsing timestamps rather than sorting strings."""
    if 'init_time' not in df.columns or df['init_time'].dropna().empty:
        return False, None, 0.0
    parsed = pd.to_datetime(df['init_time'], errors='coerce').dropna()
    if parsed.empty:
        return False, None, 0.0
    latest_dt = parsed.max()
    if latest_dt.tzinfo is None:
        latest_dt = latest_dt.replace(tzinfo=timezone.utc)
    else:
        latest_dt = latest_dt.tz_convert(timezone.utc)
    age_days = (datetime.now(timezone.utc) - latest_dt).total_seconds() / 86400.0
    return age_days > max_age_days, latest_dt.strftime("%Y-%m-%d %H:%M:%S"), age_days


# ── API & Local Data Loading ──────────────────────────────────────────────────
def parse_atcf_latlon(val_str):
    """Parses ATCF latitude/longitude string like '135N' or '1205E' into signed degrees."""
    if not val_str or val_str.strip() == '':
        return float('nan')
    val_str = val_str.strip()
    try:
        num = float(val_str[:-1]) / 10.0
        direction = val_str[-1].upper()
        if direction in ('S', 'W'):
            num = -num
        return num
    except (ValueError, IndexError):
        return float('nan')


def fetch_knack_active_storms():
    """
    Fetches active tropical cyclones from the Knack API (WPAC and CPAC filtered).
    Returns list of dicts with keys: atcf_id, name, lat, lon, basin, init_time, winds, pressure.
    """
    url = "https://api.knackwx.com/atcf/v2"
    try:
        print(f"Fetching active storms from Knack API: {url} ...")
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))

        storms = []
        for item in data:
            lat = item.get('latitude')
            lon = item.get('longitude')
            if lat is None or lon is None:
                continue

            lat = float(lat)
            lon = ((float(lon) + 180.0) % 360.0) - 180.0
            if lon == -180.0 and float(item.get('longitude')) > 0:
                lon = 180.0

            analysis_time = item.get('analysis_time', '')
            init_time = analysis_time
            if 'T' in str(analysis_time):
                try:
                    dt = datetime.strptime(str(analysis_time).split('.')[0], "%Y-%m-%dT%H:%M:%S")
                    init_time = dt.strftime("%Y-%m-%d %H:%M:%S")
                except (ValueError, TypeError):
                    pass

            atcf_id = item.get('atcf_id', '')
            atcf_upper = str(atcf_id).upper()
            is_wp = atcf_upper.endswith('W') or atcf_upper.startswith('WP') or (100.0 <= lon <= 180.0 and 0.0 <= lat <= 50.0)
            is_cp = atcf_upper.endswith('C') or atcf_upper.startswith('CP') or (-180.0 <= lon <= -140.0 and 0.0 <= lat <= 50.0)
            if not (is_wp or is_cp):
                continue

            raw_w = item.get('winds')
            raw_p = item.get('pressure')
            storms.append({
                'atcf_id': atcf_id,
                'name': item.get('storm_name', 'INVEST'),
                'lat': lat,
                'lon': lon,
                'basin': 'CP' if is_cp and not is_wp else 'WP',
                'init_time': init_time,
                'winds': float(raw_w) if raw_w is not None else None,
                'pressure': float(raw_p) if raw_p is not None else None,
            })
        print(f"Successfully fetched {len(storms)} active storms from Knack API.")
        return storms
    except Exception as e:
        print(f"Warning: Failed to fetch from Knack API: {e}")
        return []


def load_atcf_storms_index(script_file=None):
    """Loads active and historical storms from local `public/data/tc_storms_index.json`."""
    path = resolve_data_path(('public', 'data', 'tc_storms_index.json'), script_file=script_file)
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: Failed to load {path}: {e}")
    return []


def load_track_file(file_path):
    """
    Loads storm tracks from an obfuscated `.dat`/`.enc` file, CSV file, or raw ATCF file.
    Uses vectorized NumPy XOR decoding for both `0xAA` and `CalauanWeather2026`.
    """
    print(f"Loading data from {file_path} ...")
    if not os.path.exists(file_path):
        print(f"Error: File not found {file_path}")
        return pd.DataFrame()

    if file_path.endswith('.dat') or file_path.endswith('.enc'):
        try:
            with open(file_path, 'rb') as f:
                b64_content = f.read().strip()
            encrypted_bytes = base64.b64decode(b64_content)
            enc_arr = np.frombuffer(encrypted_bytes, dtype=np.uint8)

            # 1. Single-byte XOR (0xAA) used by obfuscate_csvs.py
            try:
                csv_text = (enc_arr ^ 0xAA).tobytes().decode('utf-8')
                if any(h in csv_text[:300] for h in ['#', 'track_id', 'sample', 'lat', 'init_time']):
                    return pd.read_csv(io.StringIO(csv_text), comment='#')
            except Exception:
                pass

            # 2. Multi-byte XOR key "CalauanWeather2026" (tc_aigefs_tracks.py)
            try:
                key_arr = np.frombuffer(b"CalauanWeather2026", dtype=np.uint8)
                dec_arr = enc_arr ^ np.resize(key_arr, len(enc_arr))
                csv_text = dec_arr.tobytes().decode('utf-8')
                if any(h in csv_text[:300] for h in ['#', 'track_id', 'sample', 'lat', 'init_time']):
                    return pd.read_csv(io.StringIO(csv_text), comment='#')
            except Exception:
                pass

            csv_text = (enc_arr ^ 0xAA).tobytes().decode('utf-8')
            return pd.read_csv(io.StringIO(csv_text), comment='#')
        except Exception as e:
            print(f"Failed to decrypt and read encrypted file {file_path}: {e}")
            return pd.DataFrame()

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            first_line = f.readline()
    except Exception as e:
        print(f"Failed to read file {file_path}: {e}")
        return pd.DataFrame()

    if first_line.startswith('#'):
        try:
            return pd.read_csv(file_path, comment='#')
        except (ValueError, pd.errors.ParserError):
            pass

    if ',' in first_line and any(k in first_line for k in ('init_time', 'track_id', 'lat', 'sample')):
        try:
            return pd.read_csv(file_path)
        except Exception as e:
            print(f"Error reading CSV {file_path}: {e}")
            return pd.DataFrame()

    rows = []
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip() == '' or line.startswith('#'):
                    continue
                parts = [p.strip() for p in line.split(',')]
                if len(parts) < 10:
                    continue
                try:
                    lead_time = int(parts[5])
                except (ValueError, TypeError):
                    lead_time = 0
                try:
                    wind = float(parts[8])
                except (ValueError, TypeError):
                    wind = np.nan
                try:
                    pressure = float(parts[9])
                except (ValueError, TypeError):
                    pressure = np.nan
                rows.append({
                    'basin': parts[0],
                    'cyclone_number': parts[1],
                    'init_time': parts[2],
                    'tech': parts[4],
                    'lead_time_hours': lead_time,
                    'lat': parse_atcf_latlon(parts[6]),
                    'lon': parse_atcf_latlon(parts[7]),
                    'maximum_sustained_wind_speed_knots': wind,
                    'minimum_sea_level_pressure_hpa': pressure,
                })
        return pd.DataFrame(rows)
    except Exception as e:
        print(f"Failed to parse raw ATCF file {file_path}: {e}")
        return pd.DataFrame()


def normalize_dataframe(df):
    """
    Standardizes dataframe columns to:
    ['init_time', 'track_id', 'sample', 'lead_time_hours', 'lat', 'lon', 'pressure', 'wind']
    plus optional control metadata ('is_control', 'forecast_type').
    """
    if df.empty:
        return df

    df = df.copy()
    df.columns = df.columns.str.strip()

    rename_dict = {}
    for col in df.columns:
        col_lower = col.lower()
        if col_lower in ('lat', 'latitude', 'lat_str'):
            rename_dict[col] = 'lat'
        elif col_lower in ('lon', 'longitude', 'lon_str'):
            rename_dict[col] = 'lon'
        elif col_lower in ('pressure', 'minimum_sea_level_pressure_hpa', 'mslp', 'minimum_sea_level_pressure_mb'):
            rename_dict[col] = 'pressure'
        elif col_lower in ('wind', 'maximum_sustained_wind_speed_knots', 'vmax', 'maximum_sustained_wind_speed_kph'):
            rename_dict[col] = 'wind'
        elif col_lower in ('lead_time_hours', 'tau'):
            rename_dict[col] = 'lead_time_hours'

    df = df.rename(columns=rename_dict)

    if 'track_id' not in df.columns:
        if 'basin' in df.columns and 'cyclone_number' in df.columns:
            df['track_id'] = df['basin'].astype(str) + df['cyclone_number'].astype(str).str.zfill(2)
        else:
            df['track_id'] = 'STORM'
    else:
        df['track_id'] = df['track_id'].astype(str)

    if 'lead_time_hours' not in df.columns and 'lead_time' in df.columns:
        try:
            df['lead_time_hours'] = pd.to_timedelta(df['lead_time']).dt.total_seconds() / 3600.0
        except (ValueError, TypeError):
            df['lead_time_hours'] = np.nan

    if 'sample' not in df.columns and 'tech' in df.columns:
        samples = []
        for tech_val in df['tech'].astype(str):
            if 'mn' in tech_val.lower() or 'mean' in tech_val.lower():
                samples.append(-1)
            else:
                match = re.search(r'\d+', tech_val)
                samples.append(int(match.group()) if match else 0)
        df['sample'] = samples

    required_cols = ['init_time', 'track_id', 'sample', 'lead_time_hours', 'lat', 'lon', 'pressure', 'wind']
    for col in required_cols:
        if col not in df.columns:
            df[col] = np.nan

    df['lat'] = pd.to_numeric(df['lat'], errors='coerce')
    df['lon'] = pd.to_numeric(df['lon'], errors='coerce')
    df['pressure'] = pd.to_numeric(df['pressure'], errors='coerce')
    df['wind'] = pd.to_numeric(df['wind'], errors='coerce')
    df['lead_time_hours'] = pd.to_numeric(df['lead_time_hours'], errors='coerce')

    # Wrap longitudes into standard [-180, 180] (preserving +180.0 as 180.0)
    lon_vals = df['lon'].to_numpy(dtype=float)
    wrapped = np.where(lon_vals > 180.0, ((lon_vals + 180.0) % 360.0) - 180.0, lon_vals)
    wrapped = np.where(wrapped < -180.0, ((wrapped + 180.0) % 360.0) - 180.0, wrapped)
    df['lon'] = wrapped

    extra_cols = [c for c in ['is_control', 'forecast_type'] if c in df.columns]
    return df[required_cols + extra_cols]


def filter_western_pacific(df):
    """
    Retains tracks belonging to:
      1. Western Pacific basin: initial position in Lon [100, 180], Lat [0, 50].
      2. Central Pacific (CPAC) tracks crossing westward into Western Pacific ([100, 180], [0, 50]).
    For official non-numeric track_ids (e.g. 'CP042026'), retaining any WPAC-crossing member retains
    all CPAC members of that named storm; for per-member numeric IDs ('0', '1', ...), each trajectory
    is checked individually so unrelated CPAC disturbances across members are not pulled in.
    """
    if df.empty:
        return df

    wp_tracks = []
    cpac_named_by_tid = {}
    entering_named_tids = set()

    for (t_id, s_val), track_points in df.groupby(['track_id', 'sample']):
        track_points = track_points.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
        if track_points.empty:
            continue
        first_pt = track_points.iloc[0]
        f_lat = float(first_pt['lat'])
        f_lon = float(first_pt['lon'])

        if 100.0 <= f_lon <= 180.0 and 0.0 <= f_lat <= 50.0:
            wp_tracks.append((t_id, s_val))
        elif ((-180.0 <= f_lon <= -140.0) or (180.0 <= f_lon <= 220.0)) and (0.0 <= f_lat <= 50.0):
            has_wp_entry = bool(
                ((track_points['lon'] >= 100.0) & (track_points['lon'] <= 180.0)
                 & (track_points['lat'] >= 0.0) & (track_points['lat'] <= 50.0)).any()
            )
            tid_clean = str(t_id).strip()
            is_numeric_cluster = tid_clean.isdigit()
            if is_numeric_cluster:
                if has_wp_entry:
                    wp_tracks.append((t_id, s_val))
            else:
                cpac_named_by_tid.setdefault(t_id, []).append((t_id, s_val))
                if has_wp_entry:
                    entering_named_tids.add(t_id)

    for tid in entering_named_tids:
        wp_tracks.extend(cpac_named_by_tid[tid])

    if not wp_tracks:
        return pd.DataFrame(columns=df.columns)

    wp_set = {f"{tid}_{sid}" for tid, sid in wp_tracks}
    df_keys = df['track_id'].astype(str) + "_" + df['sample'].astype(str)
    return df[df_keys.isin(wp_set)].copy()


# ── Cached GeoJSON & Philippine Landfall Detection ────────────────────────────
def get_ph_municipalities_tree(script_file=None):
    """Loads and caches the Shapely STRtree spatial index for Philippine municipalities."""
    global _ph_municipalities_tree, _ph_muni_geoms, _ph_muni_props
    if _ph_municipalities_tree is not None:
        return _ph_municipalities_tree, _ph_muni_geoms, _ph_muni_props

    found = resolve_data_path(('public', 'data', 'ph_municipalities.json'), script_file=script_file)
    if not os.path.exists(found):
        print("Warning: ph_municipalities.json not found.")
        return None, None, None
    try:
        with open(found, 'r', encoding='utf-8') as f:
            data = json.load(f)
        valid = [(shape(feat['geometry']), feat['properties']) for feat in data.get('features', []) if feat.get('geometry')]
        if not valid:
            return None, None, None
        _ph_muni_geoms, _ph_muni_props = zip(*valid)
        _ph_municipalities_tree = STRtree(_ph_muni_geoms)
        return _ph_municipalities_tree, _ph_muni_geoms, _ph_muni_props
    except Exception as e:
        print(f"Warning: Failed to load ph_municipalities.json: {e}")
        return None, None, None


def get_ph_provinces_geoms(script_file=None):
    """Loads and caches Philippine province polygons from `public/data/ph_provinces.json`."""
    global _ph_province_geoms
    if _ph_province_geoms is not None:
        return _ph_province_geoms

    found = resolve_data_path(('public', 'data', 'ph_provinces.json'), script_file=script_file)
    if not os.path.exists(found):
        _ph_province_geoms = []
        return _ph_province_geoms
    try:
        with open(found, 'r', encoding='utf-8') as f:
            data = json.load(f)
        _ph_province_geoms = [
            shape(feature['geometry'])
            for feature in data.get('features', [])
            if feature.get('geometry')
        ]
        return _ph_province_geoms
    except Exception as e:
        print(f"Warning: Province boundary overlay skipped: {e}")
        _ph_province_geoms = []
        return _ph_province_geoms


def _interp_metric(v1, v2, step, default_val):
    """Interpolates two metric values safely when either or both endpoints may be NaN."""
    ok1 = not np.isnan(v1)
    ok2 = not np.isnan(v2)
    if ok1 and ok2:
        return float(v1 + step * (v2 - v1))
    if ok1:
        return float(v1)
    if ok2:
        return float(v2)
    return float(default_val)


def check_single_track_landfall(tdf, tree, geoms, props):
    """
    Checks if a single track dataframe makes landfall in the Philippines.
    Returns the first genuine landfall hit dict (crossing from water onto land at lead > 0) or None.
    Uses ~5 km step sampling along segments to detect narrow islands.
    """
    tdf_s = tdf.sort_values('lead_time_hours').dropna(subset=['lon', 'lat'])
    if len(tdf_s) < 2:
        return None
    pts = list(zip(tdf_s['lon'], tdf_s['lat'], tdf_s['lead_time_hours'], tdf_s['wind'], tdf_s['pressure']))

    first_pt = Point(pts[0][0], pts[0][1])
    init_over_land = False
    if pts[0][2] <= 0:
        for i in tree.query(first_pt):
            if geoms[i].contains(first_pt):
                init_over_land = True
                break

    was_over_water = not init_over_land

    for k in range(len(pts) - 1):
        x1, y1, h1, w1, p1 = pts[k]
        x2, y2, h2, w2, p2 = pts[k + 1]

        if h2 <= 0:
            continue
        if abs(x2 - x1) > 180.0 or x1 < 0.0 or x2 < 0.0 or x1 > 180.0 or x2 > 180.0:
            was_over_water = True
            continue
        if max(x1, x2) < 116.0 or min(x1, x2) > 127.0 or max(y1, y2) < 4.5 or min(y1, y2) > 22.0:
            was_over_water = True
            continue

        seg_km = haversine_km(y1, x1, y2, x2)
        n_steps = max(2, int(seg_km / 5.0))
        for step in np.linspace(0, 1, n_steps):
            cur_h = h1 + step * (h2 - h1)
            if cur_h <= 0:
                continue
            cur_x = x1 + step * (x2 - x1)
            cur_y = y1 + step * (y2 - y1)
            pt = Point(cur_x, cur_y)
            hit_poly = None
            for i in tree.query(pt):
                if geoms[i].contains(pt):
                    hit_poly = i
                    break

            if hit_poly is not None:
                if was_over_water:
                    muni = props[hit_poly].get('NAME_2', '').strip()
                    prov = props[hit_poly].get('PROVINCE', '').strip()
                    if not prov:
                        prov = props[hit_poly].get('NAME_1', muni).strip()
                    place = f"{muni}, {prov}".strip(', ')
                    return {
                        'muni': muni,
                        'prov': prov,
                        'place': place,
                        'lead_h': float(cur_h),
                        'wind': _interp_metric(w1, w2, step, 30.0),
                        'pres': _interp_metric(p1, p2, step, 1004.0),
                    }
            else:
                was_over_water = True

    return None


def compute_ph_landfalls(track_dfs, total_members, init_dt, ctrl_df=None, mean_df=None):
    """
    Calculates Philippine landfall probability, timing in PHT, strength, top locations,
    and category distribution across ensemble members and control track.
    """
    if total_members in (63, 64):
        total_members = 64
    elif total_members in (999, 1000):
        total_members = 1000

    tree, geoms, props = get_ph_municipalities_tree()
    if tree is None:
        return {
            'has_landfall': False,
            'landfalling_count': 0,
            'total_members': total_members,
            'landfall_pct_str': "0%",
            'timing_label': "TIMING (IF LANDFALL)",
            'top_places': [],
            'cat_dist': [],
            'ctrl_hit': None,
            'ens_mean_hit': None,
            'n_offshore': total_members,
            'offshore_str': "100%",
            'offshore_val': 100.0,
        }

    ctrl_hit = check_single_track_landfall(ctrl_df, tree, geoms, props) if (ctrl_df is not None and not ctrl_df.empty) else None
    ens_mean_hit = check_single_track_landfall(mean_df, tree, geoms, props) if (mean_df is not None and not mean_df.empty) else None

    landfalls = []
    for tdf in track_dfs:
        hit = check_single_track_landfall(tdf, tree, geoms, props)
        if hit:
            landfalls.append(hit)

    n_hits = len(landfalls)
    effective_total = max(total_members, len(track_dfs), 1)
    if effective_total in (63, 64):
        effective_total = 64
    elif effective_total in (999, 1000):
        effective_total = 1000

    if n_hits == 0 and ctrl_hit is None:
        return {
            'has_landfall': False,
            'landfalling_count': 0,
            'total_members': effective_total,
            'landfall_pct_str': "0%",
            'timing_label': "TIMING (IF LANDFALL)",
            'top_places': [],
            'cat_dist': [],
            'ctrl_hit': None,
            'ens_mean_hit': ens_mean_hit,
            'n_offshore': effective_total,
            'offshore_str': "100%",
            'offshore_val': 100.0,
        }

    raw_lf_pct, lf_pct_str = format_percentage(n_hits, effective_total)

    n_recurve = 0
    for tdf in track_dfs:
        if len(tdf) >= 2:
            first_r = tdf.iloc[0]
            last_r = tdf.iloc[-1]
            dlon_rec = ((last_r['lon'] - first_r['lon'] + 180.0) % 360.0) - 180.0
            if (last_r['lat'] >= 21.0 and last_r['lon'] >= 126.0) or (dlon_rec > 4.0 and last_r['lat'] > 17.0):
                n_recurve += 1
    has_recurve = (n_recurve / max(len(track_dfs), 1)) >= 0.25

    recurve_uncertainty = has_recurve and ens_mean_hit is None and ctrl_hit is None
    is_high_percentage_landfall = (
        (raw_lf_pct >= 50.0 and not recurve_uncertainty)
        or (raw_lf_pct >= 40.0 and ctrl_hit is not None and ens_mean_hit is not None)
    )
    timing_label = "MOST LIKELY" if is_high_percentage_landfall else "TIMING (IF LANDFALL)"

    eval_hits = landfalls if landfalls else [ctrl_hit]
    leads = [h['lead_h'] for h in eval_hits]
    med_lead = float(np.median(leads))
    p25_lead = float(np.percentile(leads, 25))
    p75_lead = float(np.percentile(leads, 75))

    pht_med = init_dt + timedelta(hours=med_lead) + timedelta(hours=8)
    pht_p25 = init_dt + timedelta(hours=p25_lead) + timedelta(hours=8)
    pht_p75 = init_dt + timedelta(hours=p75_lead) + timedelta(hours=8)

    most_likely_str = f"{pht_med.strftime('%a').upper()} {pht_med.strftime('%I %p').lstrip('0')} PHT · {pht_med.strftime('%b').upper()} {pht_med.day}"
    p25_str = f"{pht_p25.strftime('%a').upper()} {pht_p25.strftime('%I %p').lstrip('0')}"
    p75_str = f"{pht_p75.strftime('%a').upper()} {pht_p75.strftime('%I %p').lstrip('0')}" if p75_lead != p25_lead else ""
    window_str = f"MIDDLE 50%: {p25_str} - {p75_str}" if p75_str else f"MIDDLE 50%: ~{p25_str}"

    winds = [float(h['wind']) for h in eval_hits if h.get('wind') is not None and not np.isnan(h['wind'])]
    med_wind = int(round(np.median(winds))) if winds else 30
    if med_wind >= 137:
        cat_str = "CAT 5"
    elif med_wind >= 113:
        cat_str = "CAT 4"
    elif med_wind >= 96:
        cat_str = "CAT 3"
    elif med_wind >= 83:
        cat_str = "CAT 2"
    elif med_wind >= 64:
        cat_str = "CAT 1"
    elif med_wind >= 34:
        cat_str = "TS"
    else:
        cat_str = "TD"
    strength_str = f"{med_wind} KT · {cat_str}"

    prov_counter = Counter([h['prov'].upper() for h in landfalls])
    n_offshore = max(0, effective_total - n_hits)
    has_offshore_row = n_offshore > 0
    max_prov_slots = 4 if has_offshore_row else 5

    top_places = []
    for prov, cnt in prov_counter.most_common(max_prov_slots):
        raw_p, p_str = format_percentage(cnt, effective_total)
        top_places.append({
            'place': prov,
            'prov': prov,
            'pct_val': raw_p,
            'pct_str': p_str,
            'cnt': cnt,
            'is_control': False,
        })

    if ctrl_hit is not None:
        c_prov = ctrl_hit['prov'].upper()
        c_muni = ctrl_hit['muni'].upper()
        ctrl_matched = False
        for item in top_places:
            if item['prov'] == c_prov:
                item['is_control'] = True
                item['place'] = f"{c_prov} (★ {c_muni})"
                ctrl_matched = True
                break
        if not ctrl_matched:
            c_cnt = prov_counter.get(c_prov, 0)
            c_pct_val, c_pct_str = format_percentage(c_cnt, effective_total)
            ctrl_entry = {
                'place': f"★ {c_muni}, {c_prov}",
                'prov': c_prov,
                'pct_val': c_pct_val,
                'pct_str': c_pct_str if c_cnt > 0 else "TRACK",
                'cnt': c_cnt,
                'is_control': True,
            }
            top_places = top_places[: max_prov_slots - 1] + [ctrl_entry]

    cat_defs = [
        ('TD', 0, 34, '#38bdf8'),
        ('TS', 34, 64, '#22c55e'),
        ('C1', 64, 83, '#facc15'),
        ('C2', 83, 96, '#fb923c'),
        ('C3', 96, 113, '#ef4444'),
        ('C4', 113, 137, '#e879f9'),
        ('C5', 137, 250, '#c084fc'),
    ]
    cat_dist = []
    wind_denom = max(len(winds), 1)
    for c_name, c_lo, c_hi, c_col in cat_defs:
        cnt = sum(1 for w in winds if c_lo <= w < c_hi)
        if cnt > 0:
            pct = int(round((cnt / wind_denom) * 100))
            if pct > 0:
                cat_dist.append({'name': c_name, 'pct': pct, 'col': c_col})

    if cat_dist:
        tot = sum(cd['pct'] for cd in cat_dist)
        if tot != 100 and tot > 0:
            max_cat = max(cat_dist, key=lambda cd: cd['pct'])
            max_cat['pct'] = max(1, max_cat['pct'] + (100 - tot))

    offshore_val, offshore_str = format_percentage(n_offshore, effective_total)
    return {
        'has_landfall': True,
        'landfalling_count': n_hits,
        'total_members': effective_total,
        'landfall_pct_str': lf_pct_str,
        'timing_label': timing_label,
        'most_likely_str': most_likely_str,
        'window_str': window_str,
        'strength_str': strength_str,
        'top_places': top_places,
        'cat_dist': cat_dist,
        'ctrl_hit': ctrl_hit,
        'ens_mean_hit': ens_mean_hit,
        'n_offshore': n_offshore,
        'offshore_str': offshore_str,
        'offshore_val': offshore_val,
    }


# ── Shared Mean Track Computation ─────────────────────────────────────────────
def compute_clean_mean_track_df(deduped_track_dfs, min_member_ratio=0.25, min_members=4):
    """
    Computes a smooth, physical ensemble mean track from deduplicated member DataFrames.
    Includes quorum gating, step-to-step displacement continuity, 450 km outlier rejection,
    and antimeridian-safe longitude smoothing.
    """
    if not deduped_track_dfs:
        return pd.DataFrame(columns=['lead_time_hours', 'lat', 'lon', 'pressure', 'wind', 'members'])

    norm_tracks = []
    for item in deduped_track_dfs:
        if isinstance(item, dict) and 'points_dict' in item:
            norm_tracks.append(item)
        else:
            tdf = item.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
            if tdf.empty:
                continue
            norm_tracks.append({
                'points_dict': {float(r['lead_time_hours']): (float(r['lat']), float(r['lon'])) for _, r in tdf.iterrows()},
                'wind_dict': {float(r['lead_time_hours']): float(r['wind']) for _, r in tdf.iterrows()},
                'press_dict': {float(r['lead_time_hours']): float(r['pressure']) for _, r in tdf.iterrows()},
            })

    total_members = len(norm_tracks)
    if total_members == 0:
        return pd.DataFrame(columns=['lead_time_hours', 'lat', 'lon', 'pressure', 'wind', 'members'])

    required_quorum = min(total_members, max(min_members, int(math.ceil(total_members * min_member_ratio))))
    all_hours = sorted({h for t in norm_tracks for h in t['points_dict'].keys()})

    mean_points = []
    prev_pos = None
    prev_h = None

    for h in all_hours:
        pts_at_h = []
        winds_at_h = []
        press_at_h = []
        for t in norm_tracks:
            if h in t['points_dict']:
                pts_at_h.append(t['points_dict'][h])
                if h in t.get('wind_dict', {}):
                    winds_at_h.append(t['wind_dict'][h])
                if h in t.get('press_dict', {}):
                    press_at_h.append(t['press_dict'][h])

        if len(pts_at_h) < required_quorum:
            if mean_points:
                break
            continue

        if prev_pos is not None:
            dh = h - prev_h
            max_step_dist = max(350.0, 75.0 * max(dh, 1.0))
            pts_near_prev = []
            winds_near_prev = []
            press_near_prev = []
            for idx, p in enumerate(pts_at_h):
                if haversine_km(prev_pos[0], prev_pos[1], p[0], p[1]) <= max_step_dist:
                    pts_near_prev.append(p)
                    if idx < len(winds_at_h):
                        winds_near_prev.append(winds_at_h[idx])
                    if idx < len(press_at_h):
                        press_near_prev.append(press_at_h[idx])

            if len(pts_near_prev) < min(total_members, max(2, required_quorum // 2)):
                break
            pts_at_h = pts_near_prev
            winds_at_h = winds_near_prev
            press_at_h = press_near_prev

        med_lat = float(np.median([p[0] for p in pts_at_h]))
        lons_h = [p[1] for p in pts_at_h]
        if any(x < 0 for x in lons_h) and any(x > 0 for x in lons_h):
            lons_360 = [(x if x >= 0 else x + 360.0) for x in lons_h]
            med_lon_raw = float(np.median(lons_360))
            med_lon = med_lon_raw if med_lon_raw <= 180.0 else med_lon_raw - 360.0
        else:
            med_lon = float(np.median(lons_h))

        valid_pts = []
        valid_w = []
        valid_p = []
        for idx, p in enumerate(pts_at_h):
            if haversine_km(p[0], p[1], med_lat, med_lon) <= 450.0:
                valid_pts.append({'lat': p[0], 'lon': p[1]})
                if idx < len(winds_at_h):
                    valid_w.append(winds_at_h[idx])
                if idx < len(press_at_h):
                    valid_p.append(press_at_h[idx])

        if len(valid_pts) < min(total_members, max(2, required_quorum // 2)):
            if mean_points:
                break
            continue

        geo_mean = mean_geo_center(valid_pts)
        m_lat = geo_mean['lat']
        m_lon = geo_mean['lon']
        valid_w_clean = [w for w in valid_w if not np.isnan(w)]
        valid_p_clean = [p for p in valid_p if not np.isnan(p) and 800.0 < p < 1050.0]
        m_wind = float(np.median(valid_w_clean)) if valid_w_clean else float('nan')
        m_press = float(np.median(valid_p_clean)) if valid_p_clean else float('nan')

        if prev_pos is not None and prev_h is not None:
            dh = h - prev_h
            if dh > 0:
                dist_km = haversine_km(prev_pos[0], prev_pos[1], m_lat, m_lon)
                if dist_km / dh > 75.0:
                    break
                if prev_pos[0] >= 24.0 and (m_lat - prev_pos[0]) < -1.2:
                    break

        prev_pos = (m_lat, m_lon)
        prev_h = h
        mean_points.append({
            'lead_time_hours': h,
            'lat': m_lat,
            'lon': m_lon,
            'pressure': m_press,
            'wind': m_wind,
            'members': len(valid_pts),
        })

    df_mean = pd.DataFrame(mean_points)
    if len(df_mean) >= 4:
        lats = df_mean['lat'].to_numpy(dtype=float)
        lons_unwrapped = unwrap_lon_array(df_mean['lon'].to_numpy(dtype=float))
        smooth_lats = np.convolve(lats, [0.2, 0.6, 0.2], mode='same')
        smooth_lons = np.convolve(lons_unwrapped, [0.2, 0.6, 0.2], mode='same')
        smooth_lats[0], smooth_lats[-1] = lats[0], lats[-1]
        smooth_lons[0], smooth_lons[-1] = lons_unwrapped[0], lons_unwrapped[-1]
        smooth_lons = ((smooth_lons + 180.0) % 360.0) - 180.0
        df_mean['lat'] = smooth_lats
        df_mean['lon'] = smooth_lons

    return df_mean


# ── Shared Cartopy & Dashboard Rendering Helpers ──────────────────────────────
def fit_extent_to_aspect(fig, map_rect, view_lon_min, view_lon_max, view_lat_min, view_lat_max, has_cpac=False):
    """
    Expands the shorter dimension of a geographic bounding box (within basin limits)
    so Cartopy's equal-aspect PlateCarree axes fills the allocated dashboard box cleanly
    without leaving thick black empty margins above/below the map.
    """
    fig_w, fig_h = fig.get_size_inches()
    box_w_in = map_rect[2] * fig_w
    box_h_in = map_rect[3] * fig_h
    target_aspect = box_w_in / max(box_h_in, 0.1)

    lon_span = max(12.0, view_lon_max - view_lon_min)
    lat_span = max(10.0, view_lat_max - view_lat_min)
    lon_max_limit = 220.0 if has_cpac else 180.0
    lon_min_limit = 100.0
    lat_min_limit = 0.0
    lat_max_limit = 50.0

    cur_aspect = lon_span / lat_span
    if cur_aspect < target_aspect:
        desired_lon_span = min(lon_max_limit - lon_min_limit, lat_span * target_aspect)
        extra = max(0.0, desired_lon_span - lon_span)
        view_lon_min = max(lon_min_limit, view_lon_min - extra * 0.5)
        view_lon_max = min(lon_max_limit, view_lon_max + extra * 0.5)
        if view_lon_max - view_lon_min < desired_lon_span:
            rem = desired_lon_span - (view_lon_max - view_lon_min)
            if view_lon_min > lon_min_limit:
                view_lon_min = max(lon_min_limit, view_lon_min - rem)
            else:
                view_lon_max = min(lon_max_limit, view_lon_max + rem)
    elif cur_aspect > target_aspect:
        desired_lat_span = min(lat_max_limit - lat_min_limit, lon_span / target_aspect)
        extra = max(0.0, desired_lat_span - lat_span)
        view_lat_min = max(lat_min_limit, view_lat_min - extra * 0.5)
        view_lat_max = min(lat_max_limit, view_lat_max + extra * 0.5)
        if view_lat_max - view_lat_min < desired_lat_span:
            rem = desired_lat_span - (view_lat_max - view_lat_min)
            if view_lat_min > lat_min_limit:
                view_lat_min = max(lat_min_limit, view_lat_min - rem)
            else:
                view_lat_max = min(lat_max_limit, view_lat_max + rem)

    return view_lon_min, view_lon_max, view_lat_min, view_lat_max


def setup_map_backdrop(
    fig,
    map_rect,
    view_bounds,
    has_cpac=False,
    script_file=None,
    ocean_color='#0b111b',
    land_color='#181e29',
    coast_color='#64748b',
    border_color='#334155',
):
    """
    Creates the Cartopy PlateCarree map axis with land/coast/borders, cached Philippine provinces,
    PAR polygon, canonical sea labels, gridlines, and disclaimer badge.
    Returns (ax_map, prov_geoms).
    """
    view_lon_min, view_lon_max, view_lat_min, view_lat_max = view_bounds
    map_proj = ccrs.PlateCarree(central_longitude=180) if has_cpac else ccrs.PlateCarree()
    ax_map = fig.add_axes(map_rect, projection=map_proj)
    ax_map.set_facecolor(ocean_color)
    ax_map.set_extent([view_lon_min, view_lon_max, view_lat_min, view_lat_max], crs=ccrs.PlateCarree())

    ax_map.add_feature(cfeature.OCEAN, facecolor=ocean_color, zorder=1)
    try:
        land_feature = cfeature.NaturalEarthFeature('physical', 'land', '50m', facecolor=land_color, edgecolor='none')
        coast_feature = cfeature.NaturalEarthFeature('physical', 'coastline', '50m', edgecolor=coast_color, linewidth=0.7, facecolor='none')
        borders_feature = cfeature.NaturalEarthFeature('cultural', 'admin_0_boundary_lines_land', '50m', edgecolor=border_color, linewidth=0.5, linestyle='-', alpha=0.8, facecolor='none')
        ax_map.add_feature(land_feature, zorder=2)
        ax_map.add_feature(coast_feature, zorder=3)
        ax_map.add_feature(borders_feature, zorder=3)
    except Exception:
        ax_map.add_feature(cfeature.LAND, facecolor=land_color, edgecolor='none', zorder=2)
        ax_map.add_feature(cfeature.COASTLINE, edgecolor=coast_color, linewidth=0.7, zorder=3)
        ax_map.add_feature(cfeature.BORDERS, linestyle='-', edgecolor=border_color, linewidth=0.5, alpha=0.8, zorder=3)

    prov_geoms = get_ph_provinces_geoms(script_file=script_file)
    if prov_geoms:
        ax_map.add_geometries(prov_geoms, crs=ccrs.PlateCarree(), facecolor='none', edgecolor='#334155', linewidth=0.45, alpha=0.6, zorder=3)

    ax_map.add_patch(mpatches.Polygon(
        PAR_VERTICES, facecolor='none', edgecolor='#f97316', linestyle='-', linewidth=1.6,
        alpha=0.75, transform=ccrs.PlateCarree(), zorder=4, label='PAR',
    ))

    lon_span = view_lon_max - view_lon_min
    if view_lon_min + 2.0 <= 117.5 <= view_lon_max - 2.0 and view_lat_min + 1.5 <= 14.5 <= view_lat_max - 1.5:
        wps_fs = 6.2 if lon_span >= 40.0 else 7.6
        wps_text = 'West\nPhilippine Sea' if lon_span >= 40.0 else 'West Philippine\nSea'
        t_wps = ax_map.text(
            117.5, 14.5, wps_text, fontsize=wps_fs, color='#94a3b8', weight='bold',
            transform=ccrs.PlateCarree(), ha='center', va='center', style='italic',
            linespacing=0.92, alpha=0.78, zorder=3.5, clip_on=True,
        )
        t_wps.set_path_effects([path_effects.withStroke(linewidth=2.0, foreground=ocean_color)])

    if view_lon_min + 2.0 <= 130.5 <= view_lon_max - 2.0 and view_lat_min + 1.5 <= 18.5 <= view_lat_max - 1.5:
        t_phs = ax_map.text(
            130.5, 18.5, 'Philippine\nSea', fontsize=9.0, color='#94a3b8', weight='bold',
            transform=ccrs.PlateCarree(), ha='center', va='center', style='italic',
            alpha=0.78, zorder=3.5, clip_on=True,
        )
        t_phs.set_path_effects([path_effects.withStroke(linewidth=2.2, foreground=ocean_color)])

    gl = ax_map.gridlines(draw_labels=True, linewidth=0.4, color='#334155', alpha=0.4, linestyle=':', crs=ccrs.PlateCarree())
    gl.top_labels = False
    gl.right_labels = False
    gl.xlabel_style = {'size': 8.0, 'color': '#64748b', 'weight': 'bold'}
    gl.ylabel_style = {'size': 8.0, 'color': '#64748b', 'weight': 'bold'}
    if has_cpac:
        gl.xlocator = mticker.FixedLocator([100, 110, 120, 130, 140, 150, 160, 170, 180, -170, -160, -150, -140])
        gl.xformatter = LongitudeFormatter()

    for spine in ax_map.spines.values():
        spine.set_edgecolor('#1e293b')
        spine.set_linewidth(1.2)

    ax_map.text(
        0.985, 0.025,
        DISCLAIMER_TEXT,
        transform=ax_map.transAxes,
        fontsize=7.0,
        weight='semibold',
        color='#cbd5e1',
        va='bottom',
        ha='right',
        zorder=20,
        bbox=dict(
            boxstyle='round,pad=0.35,rounding_size=0.4',
            facecolor='#090d14',
            edgecolor='#334155',
            linewidth=0.7,
            alpha=0.88,
        ),
    )

    return ax_map, prov_geoms


def dock_legend_axis_under_map(fig, ax_map, leg_h=0.056, gap=0.036, min_bottom=0.042):
    """
    Draws the canvas so Cartopy finalizes ax_map's aspect-fitted box, then creates
    a rounded-style legend axis directly below ax_map aligned to its exact x/width.
    """
    fig.canvas.draw()
    pos = ax_map.get_position()
    leg_bottom = max(min_bottom, pos.y0 - gap - leg_h)
    ax_leg = fig.add_axes([pos.x0, leg_bottom, pos.width, leg_h])
    ax_leg.set_facecolor('none')
    ax_leg.set_xlim(0.0, 1.0)
    ax_leg.set_ylim(0.0, 1.0)
    ax_leg.set_xticks([])
    ax_leg.set_yticks([])
    for spine in ax_leg.spines.values():
        spine.set_visible(False)

    bg = mpatches.FancyBboxPatch(
        (0.0, 0.0), 1.0, 1.0,
        boxstyle='round,pad=-0.002,rounding_size=0.025',
        facecolor='#0b111d', edgecolor='#1e293b', linewidth=1.0,
        transform=ax_leg.transAxes, zorder=0,
    )
    ax_leg.add_patch(bg)
    return ax_leg


def draw_member_tracks(ax_map, deduped_track_dfs, track_cmap, track_norm, color_by, has_cpac, is_large, is_dense_over_ph):
    """Renders colored ensemble member track segments with optional dark/glow halos."""
    if is_large:
        track_lw = 0.85 if is_dense_over_ph else 0.95
        track_alpha = 0.34 if is_dense_over_ph else 0.42
        halo_alpha = 0.08
        halo_lw = 1.8
    else:
        track_lw = 1.15 if is_dense_over_ph else 1.35
        track_alpha = 0.72 if is_dense_over_ph else 0.86
        halo_alpha = 0.20 if is_dense_over_ph else 0.30
        halo_lw = 2.4 if is_dense_over_ph else 2.8

    for member_df in deduped_track_dfs:
        member_df = member_df.sort_values('lead_time_hours')
        if len(member_df) < 2:
            continue
        lons = member_df['lon'].to_numpy(dtype=float)
        lats = member_df['lat'].to_numpy(dtype=float)
        winds = member_df['wind'].to_numpy(dtype=float)
        pressures = member_df['pressure'].to_numpy(dtype=float)

        segments = []
        seg_vals = []
        for i in range(len(lons) - 1):
            if np.isnan(lons[i]) or np.isnan(lons[i + 1]) or np.isnan(lats[i]) or np.isnan(lats[i + 1]):
                continue
            p1_lon = unwrap_lon_for_cpac(lons[i], has_cpac)
            p2_lon = unwrap_lon_for_cpac(lons[i + 1], has_cpac)
            if abs(p2_lon - p1_lon) > 180.0:
                continue
            segments.append([[p1_lon, lats[i]], [p2_lon, lats[i + 1]]])
            if color_by == 'pressure':
                seg_vals.append(_interp_metric(pressures[i], pressures[i + 1], 0.5, 1008.0))
            else:
                seg_vals.append(_interp_metric(winds[i], winds[i + 1], 0.5, 25.0))

        if not segments:
            continue

        vals_arr = np.asarray(seg_vals, dtype=float)
        if halo_alpha > 0:
            lc_halo = LineCollection(
                segments, cmap=track_cmap, norm=track_norm,
                linewidth=halo_lw, alpha=halo_alpha, transform=ccrs.PlateCarree(), zorder=5,
            )
            lc_halo.set_array(vals_arr)
            ax_map.add_collection(lc_halo)

        lc = LineCollection(
            segments, cmap=track_cmap, norm=track_norm,
            linewidth=track_lw, alpha=track_alpha, capstyle='round', joinstyle='round',
            transform=ccrs.PlateCarree(), zorder=6,
        )
        lc.set_array(vals_arr)
        ax_map.add_collection(lc)


def draw_dense_ph_provinces(ax_map, prov_geoms):
    """Overlays crisp high-contrast Philippine province boundaries above dense track clusters."""
    if not prov_geoms:
        return
    ax_map.add_geometries(
        prov_geoms, crs=ccrs.PlateCarree(), facecolor='none',
        edgecolor='#090d14', linewidth=1.3, alpha=0.75, zorder=6.4,
    )
    ax_map.add_geometries(
        prov_geoms, crs=ccrs.PlateCarree(), facecolor='none',
        edgecolor='#94a3b8', linewidth=0.55, alpha=0.85, zorder=6.5,
    )


def count_ph_tracks(deduped_track_dfs):
    """Counts member tracks passing inside the Philippine domain box [4.5–22N, 115–130E]."""
    count = 0
    for m_df in deduped_track_dfs:
        in_ph = ((m_df['lat'] >= 4.5) & (m_df['lat'] <= 22.0) & (m_df['lon'] >= 115.0) & (m_df['lon'] <= 130.0)).any()
        if in_ph:
            count += 1
    return count


def compute_plume_day_interval(min_dt, max_dt):
    """Chooses an uncluttered x-axis day step for time-series cards based on span length."""
    span_days = max(1.0, (max_dt - min_dt).total_seconds() / 86400.0)
    if span_days <= 8.0:
        return 2
    if span_days <= 13.0:
        return 3
    return 4


def draw_card_container(fig, rect, bg_color='#0b111d', border_color='#1e293b'):
    """Creates a borderless figure-level rounded card container axes and returns it."""
    ax = fig.add_axes(rect)
    ax.set_facecolor('none')
    ax.set_xlim(0.0, 1.0)
    ax.set_ylim(0.0, 1.0)
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    patch = mpatches.FancyBboxPatch(
        (0.0, 0.0), 1.0, 1.0,
        boxstyle='round,pad=-0.004,rounding_size=0.045',
        facecolor=bg_color, edgecolor=border_color, linewidth=1.1,
        transform=ax.transAxes, zorder=0,
    )
    ax.add_patch(patch)
    return ax


# ── Manifest & Rolling PNG Pruning ────────────────────────────────────────────
def update_and_prune_spaghetti_manifest(
    new_entries,
    output_dir,
    script_file=None,
    max_runs_retained=8,
    replace_scope_keys=None,
):
    """
    Atomically updates `public/data/spaghetti_manifest.json` with `new_entries`,
    optionally removing superseded monitoring entries for any `(init_date, cycle, model)`
    tuple in `replace_scope_keys`, then prunes expired runs beyond `max_runs_retained`
    and deletes orphaned spaghetti PNGs from `output_dir`.
    """
    base_dir = os.path.dirname(os.path.abspath(script_file or __file__))
    script_manifest = os.path.join(base_dir, 'public', 'data', 'spaghetti_manifest.json')
    if os.path.isdir(os.path.dirname(script_manifest)):
        manifest_file = script_manifest
    else:
        manifest_file = resolve_data_path(('public', 'data', 'spaghetti_manifest.json'), script_file=script_file)
    manifest_data = []
    if os.path.exists(manifest_file):
        try:
            with open(manifest_file, 'r', encoding='utf-8') as mf:
                loaded = json.load(mf)
                if isinstance(loaded, list):
                    manifest_data = loaded
        except Exception:
            manifest_data = []

    if replace_scope_keys:
        new_keys = {(e.get('unique_key'), e.get('model')) for e in new_entries}
        cleaned = []
        for entry in manifest_data:
            scope = (entry.get('init_date'), str(entry.get('cycle', '')).upper(), entry.get('model'))
            if scope in replace_scope_keys and entry.get('is_monitoring'):
                if (entry.get('unique_key'), entry.get('model')) not in new_keys:
                    continue
            cleaned.append(entry)
        manifest_data = cleaned

    for new_e in new_entries:
        u_key = new_e.get('unique_key')
        m_key = new_e.get('model')
        matched = False
        for existing in manifest_data:
            if existing.get('unique_key') == u_key and existing.get('model') == m_key:
                existing.update(new_e)
                matched = True
                break
        if not matched:
            manifest_data.append(new_e)

    unique_runs = sorted(
        {f"{e.get('init_date', '20261008')}_{e.get('cycle', '00Z')}" for e in manifest_data},
        reverse=True,
    )

    pruned_manifest = manifest_data
    removed_entries = []
    if len(unique_runs) > max_runs_retained:
        retained_runs = set(unique_runs[:max_runs_retained])
        pruned_manifest = []
        for e in manifest_data:
            run_tag = f"{e.get('init_date', '20261008')}_{e.get('cycle', '00Z')}"
            if run_tag in retained_runs:
                pruned_manifest.append(e)
            else:
                removed_entries.append(e)
        print(f"Rolling retention: pruned manifest to {len(pruned_manifest)} entries across {len(retained_runs)} active runs.")

    os.makedirs(os.path.dirname(manifest_file), exist_ok=True)
    tmp_manifest = f"{manifest_file}.tmp"
    with open(tmp_manifest, 'w', encoding='utf-8') as mf:
        json.dump(pruned_manifest, mf, indent=2)
    os.replace(tmp_manifest, manifest_file)

    # Delete orphaned spaghetti PNGs no longer referenced in pruned_manifest
    if output_dir and os.path.isdir(output_dir):
        active_files = set()
        for e in pruned_manifest:
            if e.get('filename'):
                active_files.add(e['filename'])
            if e.get('alt_filename'):
                active_files.add(e['alt_filename'])

        spaghetti_png_pat = re.compile(
            r'^(?:WP|CP)\d{2}_\d{8}_\d{2}Z_.*\.png$|^MONITORING_LPA\d{2}_\d{8}_\d{2}Z_.*\.png$',
            re.I,
        )
        retained_runs_set = {
            f"{e.get('init_date', '20261008')}_{e.get('cycle', '00Z')}"
            for e in pruned_manifest
        }
        removed_filenames = {r.get('filename') for r in removed_entries if r.get('filename')}
        removed_count = 0
        for fname in os.listdir(output_dir):
            if spaghetti_png_pat.match(fname) and fname not in active_files:
                m_run = re.search(r'_(\d{8})_(\d{2}Z)_', fname)
                if not m_run:
                    continue
                f_run_tag = f"{m_run.group(1)}_{m_run.group(2)}"
                is_expired_run = not retained_runs_set or f_run_tag not in retained_runs_set
                if is_expired_run or fname in removed_filenames:
                    try:
                        os.remove(os.path.join(output_dir, fname))
                        removed_count += 1
                    except OSError:
                        pass
        if removed_count > 0:
            print(f"Rolling retention: removed {removed_count} expired spaghetti PNG(s) from {output_dir}.")
