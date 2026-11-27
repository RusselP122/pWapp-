"""
enemble.py  -  Legacy Tropical Cyclone Track + Cone of Uncertainty -> JSON
==========================================================================
Standalone legacy script (not wired into frontend routes or GitHub Actions).
Converts hardcoded data_dict / history_dict into:

    public/data/ensemble_tracks.json
"""

from datetime import datetime, timezone
import json
import math
import os

import numpy as np
import pandas as pd
from shapely.geometry import Polygon
from shapely.ops import unary_union

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "data")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "ensemble_tracks.json")
os.makedirs(OUTPUT_DIR, exist_ok=True)

data_dict = {
    'lead_time_hours': [6.0, 30.0, 54.0],
    'lat': [8.70, 10.40, 11.48],
    'lon': [136.10, 134.11, 130.55],
    'minimum_sea_level_pressure_hpa': [1003.6, 1003.5, 1005.1],
    'maximum_sustained_wind_speed_knots': [35.1, 30.8, 20.7],
}

history_dict = [
    {'init_time': '2026-05-07 06:00:00', 'lead_time': '0 days 00:00:00', 'lat': 7.50, 'lon': 142.90, 'minimum_sea_level_pressure_hpa': 1006.9, 'maximum_sustained_wind_speed_knots': 16.1},
    {'init_time': '2026-05-07 12:00:00', 'lead_time': '0 days 00:00:00', 'lat': 7.70, 'lon': 143.20, 'minimum_sea_level_pressure_hpa': 1006.9, 'maximum_sustained_wind_speed_knots': 16.1},
    {'init_time': '2026-05-07 18:00:00', 'lead_time': '0 days 00:00:00', 'lat': 8.10, 'lon': 141.10, 'minimum_sea_level_pressure_hpa': 1006.9, 'maximum_sustained_wind_speed_knots': 16.1},
    {'init_time': '2026-05-08 00:00:00', 'lead_time': '0 days 00:00:00', 'lat': 8.50, 'lon': 139.90, 'minimum_sea_level_pressure_hpa': 1006.9, 'maximum_sustained_wind_speed_knots': 16.1},
    {'init_time': '2026-05-08 06:00:00', 'lead_time': '0 days 00:00:00', 'lat': 8.70, 'lon': 137.90, 'minimum_sea_level_pressure_hpa': 1006.9, 'maximum_sustained_wind_speed_knots': 16.1},
    {'init_time': '2026-05-08 12:00:00', 'lead_time': '0 days 00:00:00', 'lat': 8.70, 'lon': 138.70, 'minimum_sea_level_pressure_hpa': 1006.9, 'maximum_sustained_wind_speed_knots': 16.1},
]

STORM_NAME = "Tropical Storm Hagupit"
INIT_TIME_STR = "2026-05-08 12:00:00"
CURRENT_TIME_PH = "9:00 AM PhST, May 9, 2026"

LEAD_STANDARD = [0, 12, 24, 36, 48, 60, 72, 96, 120, 144]
RADII_NM = [0, 26, 38, 50, 59, 71, 83, 113, 146, 180]


def offset_point(lat, lon, distance_km, bearing_deg):
    """Return (lat2, lon2) displaced from (lat, lon) by distance_km along bearing_deg."""
    radius_km = 6371.0
    br = math.radians(bearing_deg)
    la1 = math.radians(lat)
    lo1 = math.radians(lon)
    la2 = math.asin(
        math.sin(la1) * math.cos(distance_km / radius_km)
        + math.cos(la1) * math.sin(distance_km / radius_km) * math.cos(br)
    )
    lo2 = lo1 + math.atan2(
        math.sin(br) * math.sin(distance_km / radius_km) * math.cos(la1),
        math.cos(distance_km / radius_km) - math.sin(la1) * math.sin(la2),
    )
    lon_deg = ((math.degrees(lo2) + 180.0) % 360.0) - 180.0
    return math.degrees(la2), lon_deg


def build_cone_polygon(lats, lons, lead_times):
    """
    Build the cone-of-uncertainty outer envelope using a continuous swept tangent union.
    Unwraps longitudes across the antimeridian before building polygons and closes all rings.
    """
    if len(lats) == 0:
        return []

    radii_nm_interp = np.interp(lead_times, LEAD_STANDARD, RADII_NM)
    radii_km = radii_nm_interp * 1.852
    unwrapped_lons = np.rad2deg(np.unwrap(np.deg2rad(lons)))

    if len(lats) == 1:
        circ = []
        radius = max(float(radii_km[0]), 0.1)
        for ang in range(0, 360, 10):
            clat, clon = offset_point(float(lats[0]), float(unwrapped_lons[0]), radius, ang)
            circ.append([round(clon, 4), round(clat, 4)])
        circ.append(circ[0])
        return circ

    circles = []
    for i in range(len(lats)):
        circ_coords = []
        radius = max(float(radii_km[i]), 0.1)
        for ang in range(0, 360, 10):
            clat, clon = offset_point(float(lats[i]), float(unwrapped_lons[i]), radius, ang)
            # Keep polygon rings continuous near center longitude
            if abs(clon - unwrapped_lons[i]) > 180.0:
                clon += 360.0 if clon < unwrapped_lons[i] else -360.0
            circ_coords.append((clon, clat))
        circles.append(Polygon(circ_coords))

    segments = [circles[i].union(circles[i + 1]).convex_hull for i in range(len(circles) - 1)]
    cone_geom = unary_union(segments)

    if cone_geom.geom_type == 'Polygon':
        geoms = [cone_geom]
    elif cone_geom.geom_type == 'MultiPolygon':
        geoms = list(cone_geom.geoms)
    else:
        geoms = []

    if not geoms:
        return []

    largest_geom = max(geoms, key=lambda g: g.area)
    coords = list(largest_geom.exterior.coords)
    return [[round(((p[0] + 180.0) % 360.0) - 180.0, 4), round(p[1], 4)] for p in coords]


def main():
    wp_mean = pd.DataFrame(data_dict)
    history_data = pd.DataFrame(history_dict)

    ref = pd.to_datetime(INIT_TIME_STR)
    history_data['actual_time'] = pd.to_datetime(history_data['init_time'])
    history_data['lead_time_hours'] = (history_data['actual_time'] - ref).dt.total_seconds() / 3600.0

    history_df = history_data.sort_values('lead_time_hours').drop_duplicates('lead_time_hours')
    history_out = [
        {
            "lead_time_hours": round(float(r['lead_time_hours']), 1),
            "lat": round(float(r['lat']), 2),
            "lon": round(float(r['lon']), 2),
            "wind_kt": round(float(r['maximum_sustained_wind_speed_knots']), 1),
            "pressure_hpa": round(float(r['minimum_sea_level_pressure_hpa']), 1),
        }
        for _, r in history_df.iterrows()
    ]

    lats = wp_mean['lat'].values
    lons = wp_mean['lon'].values
    lead_times = wp_mean['lead_time_hours'].values
    winds = wp_mean['maximum_sustained_wind_speed_knots'].values
    pressures = wp_mean['minimum_sea_level_pressure_hpa'].values

    radii_km = np.interp(lead_times, LEAD_STANDARD, RADII_NM) * 1.852
    forecast_out = [
        {
            "lead_time_hours": round(float(lead_times[i]), 1),
            "lat": round(float(lats[i]), 2),
            "lon": round(float(lons[i]), 2),
            "wind_kt": round(float(winds[i]), 1),
            "pressure_hpa": round(float(pressures[i]), 1),
            "cone_radius_km": round(float(radii_km[i]), 1),
        }
        for i in range(len(lats))
    ]

    # Anchor cone origin at latest historical position (0h) if forecast starts > 0h
    cone_lats, cone_lons, cone_leads = list(lats), list(lons), list(lead_times)
    if history_out and cone_leads and cone_leads[0] > 0.0:
        last_hist = history_out[-1]
        cone_lats.insert(0, last_hist['lat'])
        cone_lons.insert(0, last_hist['lon'])
        cone_leads.insert(0, 0.0)

    cone_polygon = build_cone_polygon(np.array(cone_lats), np.array(cone_lons), np.array(cone_leads))

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "storm_name": STORM_NAME,
        "init_time": INIT_TIME_STR,
        "current_time_ph": CURRENT_TIME_PH,
        "history": history_out,
        "forecast": forecast_out,
        "cone_polygon": cone_polygon,
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"Written -> {OUTPUT_FILE}")
    print(f"  History points : {len(history_out)}")
    print(f"  Forecast points: {len(forecast_out)}")
    print(f"  Cone polygon   : {len(cone_polygon)} vertices")
    for p in forecast_out:
        print(f"  T+{p['lead_time_hours']:5.0f}h  {p['lat']}N {p['lon']}E  wind={p['wind_kt']}kt  cone_r={p['cone_radius_km']}km")


if __name__ == "__main__":
    main()
