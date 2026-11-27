import argparse
from datetime import datetime, timedelta, timezone
import math
import os
import re

import cartopy.crs as ccrs
import matplotlib
matplotlib.use('Agg')  # Headless mode
import matplotlib.colors as mcolors
import matplotlib.dates as mdates
import matplotlib.patches as mpatches
import matplotlib.patheffects as path_effects
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform
from scipy.stats import gaussian_kde

from spaghetti_common import (
    INTENSITY_BANDS,
    WIND_BOUNDS,
    WIND_COLORS,
    compute_clean_mean_track_df,
    compute_plume_day_interval,
    count_ph_tracks,
    detect_model_name,
    dock_legend_axis_under_map,
    draw_card_container,
    draw_dense_ph_provinces,
    draw_member_tracks,
    fetch_knack_active_storms,
    filter_western_pacific,
    fit_extent_to_aspect,
    format_init_time,
    format_model_display_title,
    format_percentage,
    haversine_km,
    infer_total_members,
    is_run_too_old,
    load_atcf_storms_index,
    load_track_file,
    mean_geo_center,
    normalize_dataframe,
    parse_atcf_latlon,
    parse_utc_init_datetime,
    resolve_data_path,
    resolve_output_dir,
    setup_map_backdrop,
    unwrap_lon_for_cpac,
    update_and_prune_spaghetti_manifest,
)


def is_atcf_storm_or_invest(tracks, knack_storms=None, atcf_index_storms=None):
    """
    Determines if a candidate cluster belongs to an official ATCF storm or invest.
    Clusters with official ATCF status must NOT have monitoring graphics generated.
    """
    atcf_patterns = [
        re.compile(r'^(WP|EP|AL|CP|IO|SH)\d{2}\d{4}', re.I),
        re.compile(r'^(WP|EP|AL|CP|IO|SH)?(0[1-9]|[1-4][0-9]|9[0-9])[A-Z](\(\d+\))?$', re.I),
        re.compile(r'^(WP|EP|AL|CP|IO|SH)(0[1-9]|[1-4][0-9]|9[0-9])(\(\d+\))?$', re.I),
        re.compile(r'^(TC|INVEST)\s*\d+[A-Z]?', re.I),
    ]

    known_official_identifiers = set()
    if knack_storms:
        for s in knack_storms:
            if s.get('atcf_id'):
                known_official_identifiers.add(str(s['atcf_id']).upper().strip())
            if s.get('name') and str(s['name']).upper() != 'INVEST':
                known_official_identifiers.add(str(s['name']).upper().strip())

    if atcf_index_storms:
        for s in atcf_index_storms:
            if s.get('track_id'):
                known_official_identifiers.add(str(s['track_id']).upper().strip())
            if s.get('storm_name'):
                name_clean = str(s['storm_name']).upper().replace('TC', '').replace('INVEST', '').strip()
                if name_clean:
                    known_official_identifiers.add(name_clean)
                known_official_identifiers.add(str(s['storm_name']).upper().strip())

    for t in tracks:
        tid = str(t.get('track_id', '')).strip().upper()
        if not tid or tid in ('UNKNOWN', 'STORM', 'NONE', 'NAN'):
            continue
        if tid.isdigit():
            continue

        for ident in known_official_identifiers:
            if not ident or ident in ('UNKNOWN', 'STORM', 'NONE', 'NAN', 'INVEST', 'TC'):
                continue
            if ident == tid:
                return True, f"Track ID '{tid}' matches official ATCF storm identifier '{ident}'"
            if len(ident) >= 4 and ident in tid:
                return True, f"Track ID '{tid}' contains official ATCF storm identifier '{ident}'"
            if len(tid) >= 4 and tid in ident:
                return True, f"Track ID '{tid}' matches official ATCF storm identifier '{ident}'"

        for pat in atcf_patterns:
            if pat.search(tid):
                return True, f"Track ID '{tid}' matches ATCF format pattern"

    active_storm_locations = []
    if knack_storms:
        for s in knack_storms:
            lat, lon = s.get('lat'), s.get('lon')
            if lat is not None and lon is not None and not (np.isnan(lat) or np.isnan(lon)):
                active_storm_locations.append((lat, lon, s.get('atcf_id', s.get('name', 'Active ATCF Storm'))))

    if atcf_index_storms:
        for s in atcf_index_storms:
            if s.get('active'):
                lat, lon = s.get('latest_lat'), s.get('latest_lon')
                if lat is not None and lon is not None and not (np.isnan(lat) or np.isnan(lon)):
                    active_storm_locations.append((lat, lon, s.get('storm_name', s.get('track_id', 'Active ATCF Storm'))))

    for t in tracks:
        for h, (p_lat, p_lon) in t.get('points_dict', {}).items():
            if h <= 48:
                for a_lat, a_lon, a_name in active_storm_locations:
                    d = haversine_km(p_lat, p_lon, a_lat, a_lon)
                    if d < 450.0:
                        return True, f"Cluster track is within {d:.0f}km of active ATCF storm {a_name} at T+{h}h"

    return False, ""


def _compute_cluster_heading(tracks):
    """Computes normalized 48h displacement vector (dx, dy) with dateline wrap for a track group."""
    dx_list, dy_list = [], []
    for t in tracks:
        p_dict = t.get('points_dict', {})
        if not p_dict:
            continue
        sorted_h = sorted(p_dict.keys())
        if len(sorted_h) < 2:
            continue
        p_start = p_dict[sorted_h[0]]
        candidates = [h for h in sorted_h if h <= sorted_h[0] + 48]
        target_h = candidates[-1] if len(candidates) > 1 else sorted_h[-1]
        p_end = p_dict[target_h]
        dlat_km = (p_end[0] - p_start[0]) * 111.0
        dlon_deg = ((p_end[1] - p_start[1] + 180.0) % 360.0) - 180.0
        dlon_km = dlon_deg * 111.0 * math.cos(math.radians(p_start[0]))
        dx_list.append(dlon_km)
        dy_list.append(dlat_km)

    mean_dx = float(np.mean(dx_list)) if dx_list else 0.0
    mean_dy = float(np.mean(dy_list)) if dy_list else 0.0
    norm = math.sqrt(mean_dx ** 2 + mean_dy ** 2)
    return mean_dx, mean_dy, norm


def _clusters_overlap_trajectory_distance(anchor_tracks, cand_tracks):
    """
    Computes median simultaneous distance between anchor and candidate tracks across overlapping
    lead times, helping match late-detected vortex fragments moving along the same corridor.
    """
    dists = []
    for t1 in anchor_tracks[:25]:
        p1 = t1.get('points_dict', {})
        for t2 in cand_tracks[:25]:
            p2 = t2.get('points_dict', {})
            overlap = sorted(set(p1.keys()).intersection(p2.keys()))
            if len(overlap) < 3:
                continue
            early_h = overlap[: min(6, len(overlap))]
            pair_d = [haversine_km(p1[h][0], p1[h][1], p2[h][0], p2[h][1]) for h in early_h]
            dists.append(float(np.mean(pair_d)))
    if not dists:
        return float('inf')
    return float(np.median(dists))


def aggregate_nursery_lpas(
    candidate_lpas,
    max_nursery_dist=600.0,
    max_genesis_gap_h=96.0,
    min_motion_cos=0.50,
    min_motion_displacement_km=120.0,
    max_member_overlap=0.20,
):
    """
    Groups LPA candidate clusters originating within the same spatial nursery (<= 600km)
    or overlapping downstream along the same trajectory with compatible heading vectors,
    adjacent genesis time windows, and distinct ensemble member realizations.
    """
    if len(candidate_lpas) <= 1:
        return candidate_lpas

    lpas_with_meta = []
    for idx, c in enumerate(candidate_lpas):
        tracks = c['tracks']
        geo_c = mean_geo_center([{'lat': t['f_lat'], 'lon': t['f_lon']} for t in tracks])
        avg_lat = c.get('avg_lat', float(geo_c['lat']))
        avg_lon = c.get('avg_lon', float(geo_c['lon']))
        avg_h = c.get('avg_h', float(np.mean([t['h_min'] for t in tracks])))

        mean_dx, mean_dy, norm = _compute_cluster_heading(tracks)
        dir_vec = (mean_dx / norm, mean_dy / norm) if norm >= min_motion_displacement_km else None

        lpas_with_meta.append({
            'cluster_label': c.get('cluster_label', f"Candidate_{idx + 1}"),
            'tracks': tracks,
            'members': c['members'],
            'avg_lat': avg_lat,
            'avg_lon': avg_lon,
            'avg_h': avg_h,
            'dir_vec': dir_vec,
            'displacement_km': norm,
            'max_w': c['max_w'],
            'min_p': c['min_p'],
            'duration': c['duration'],
        })

    sorted_lpas = sorted(lpas_with_meta, key=lambda x: x['members'], reverse=True)
    merged = []
    used = set()

    for i, anchor in enumerate(sorted_lpas):
        if i in used:
            continue
        group = [anchor]
        used.add(i)
        group_mems = {t['sample'] for t in anchor['tracks']}

        for j, candidate in enumerate(sorted_lpas):
            if j in used:
                continue

            dh = abs(anchor['avg_h'] - candidate['avg_h'])
            if dh > max_genesis_gap_h:
                continue

            dist_gen = haversine_km(anchor['avg_lat'], anchor['avg_lon'], candidate['avg_lat'], candidate['avg_lon'])
            same_corridor = False
            if dist_gen > max_nursery_dist:
                if dh >= 18.0 and dist_gen <= max_nursery_dist * 1.45:
                    traj_dist = _clusters_overlap_trajectory_distance(anchor['tracks'], candidate['tracks'])
                    if traj_dist <= 380.0:
                        same_corridor = True

                if not same_corridor:
                    close_to_secondary = any(
                        haversine_km(g['avg_lat'], g['avg_lon'], candidate['avg_lat'], candidate['avg_lon']) <= max_nursery_dist
                        for g in group[1:]
                    )
                    if close_to_secondary:
                        print(
                            f"Nursery Aggregation Notice: Candidate {candidate.get('cluster_label')} at "
                            f"({candidate['avg_lat']:.1f}N, {candidate['avg_lon']:.1f}E) is within {max_nursery_dist:.0f}km "
                            f"of a secondary group member, but {dist_gen:.0f}km from anchor "
                            f"({anchor['avg_lat']:.1f}N, {anchor['avg_lon']:.1f}E). Retained as separate to prevent basin chaining."
                        )
                    continue

            if anchor['dir_vec'] is not None and candidate['dir_vec'] is not None:
                cos_sim = anchor['dir_vec'][0] * candidate['dir_vec'][0] + anchor['dir_vec'][1] * candidate['dir_vec'][1]
                if cos_sim < min_motion_cos:
                    continue

            cand_mems = {t['sample'] for t in candidate['tracks']}
            shared_mems = group_mems.intersection(cand_mems)
            min_member_pool = min(len(group_mems), len(cand_mems))
            overlap_ratio = len(shared_mems) / min_member_pool if min_member_pool > 0 else 0.0

            if overlap_ratio > max_member_overlap:
                print(
                    f"Nursery Aggregation Notice: Candidate {candidate.get('cluster_label')} shares "
                    f"{len(shared_mems)}/{min_member_pool} members ({overlap_ratio:.1%}) with group "
                    f"(> {max_member_overlap:.0%}). Treated as distinct sequential/concurrent events and kept separate."
                )
                continue

            group.append(candidate)
            group_mems.update(cand_mems)
            used.add(j)

        if len(group) == 1:
            merged.append(anchor)
            continue

        combined_tracks = []
        for item in group:
            combined_tracks.extend(item['tracks'])

        by_member = {}
        for t in combined_tracks:
            by_member.setdefault(t['sample'], []).append(t)

        deduped = []
        for m_tracks in by_member.values():
            if len(m_tracks) == 1:
                deduped.append(m_tracks[0])
            else:
                deduped.append(max(m_tracks, key=lambda tr: (len(tr.get('points_dict', {})), tr.get('max_w', 0))))

        geo_merged = mean_geo_center([{'lat': t['f_lat'], 'lon': t['f_lon']} for t in deduped])
        c_lat = float(geo_merged['lat'])
        c_lon = float(geo_merged['lon'])
        c_h = float(np.mean([t['h_min'] for t in deduped]))
        c_max_w = float(max(t['max_w'] for t in deduped))
        c_min_p = float(min(t['min_p'] for t in deduped))
        c_duration = float(max(t['h_max'] for t in deduped) - min(t['h_min'] for t in deduped))

        merged_label = anchor.get('cluster_label', f"Nursery_{i + 1}")
        print(
            f"Spatial Nursery Aggregation: Merged {len(group)} candidate clusters (anchored by {merged_label}) "
            f"near ({c_lat:.1f}N, {c_lon:.1f}E) into unified signal with {len(deduped)} members"
        )
        merged.append({
            'cluster_label': merged_label,
            'tracks': deduped,
            'members': len(deduped),
            'avg_lat': c_lat,
            'avg_lon': c_lon,
            'avg_h': c_h,
            'max_w': c_max_w,
            'min_p': c_min_p,
            'duration': c_duration,
        })

    return merged


def cluster_and_validate_lpas(
    df_wp,
    knack_storms,
    atcf_index_storms=None,
    total_members=50,
    min_members=5,
    min_wind_kt=25.0,
    max_mslp_hpa=1004.0,
    min_duration=36.0,
    max_dist=450.0,
    enable_nursery_aggregation=True,
    max_nursery_dist=600.0,
    max_nursery_gap_h=96.0,
    min_motion_cos=0.50,
    min_motion_disp_km=120.0,
    max_member_overlap=0.20,
):
    """
    Identifies, clusters, and validates tropical disturbances under monitoring using Average-Linkage
    spatio-temporal clustering and nursery aggregation. Prevents chaining, survivor bias, and fragment dropout.
    """
    if df_wp.empty:
        return df_wp, []

    df_wp = df_wp.copy()
    df_wp['storm_group'] = 'UNKNOWN'
    df_wp['storm_group_name'] = 'UNKNOWN'
    df_wp['rep_track_id'] = 'UNKNOWN'
    df_wp['is_monitoring'] = False

    known_official_names = set()
    if knack_storms:
        for s in knack_storms:
            if s.get('atcf_id'):
                known_official_names.add(str(s['atcf_id']).upper().strip())
            if s.get('name') and str(s['name']).upper() not in ('INVEST', 'UNKNOWN'):
                known_official_names.add(str(s['name']).upper().strip())
    if atcf_index_storms:
        for s in atcf_index_storms:
            if s.get('track_id'):
                known_official_names.add(str(s['track_id']).upper().strip())
            if s.get('storm_name'):
                name_clean = str(s['storm_name']).upper().replace('TC', '').replace('INVEST', '').strip()
                if name_clean:
                    known_official_names.add(name_clean)

    atcf_prefilter_pat = re.compile(
        r'^(?:WP|EP|AL|CP|IO|SH)\d{2}\d{4}(?:\(\d+\))?'
        r'|^(?:WP|EP|AL|CP|IO|SH)?(?:0[1-9]|[1-4]\d|9\d)[A-Z](?:\(\d+\))?$'
        r'|^(?:WP|EP|AL|CP|IO|SH)(?:0[1-9]|[1-4]\d|9\d)(?:\(\d+\))?$',
        re.I,
    )

    tracks = []
    for (t_id, s_val), track_points in df_wp.groupby(['track_id', 'sample']):
        t_id_str = str(t_id).strip().upper()
        if not t_id_str.isdigit() and (t_id_str in known_official_names or atcf_prefilter_pat.match(t_id_str)):
            continue
        track_points = track_points.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
        if len(track_points) < 3:
            continue
        h_min = float(track_points['lead_time_hours'].min())
        h_max = float(track_points['lead_time_hours'].max())
        f_lat = float(track_points.iloc[0]['lat'])
        f_lon = float(track_points.iloc[0]['lon'])
        max_w = float(track_points['wind'].max())
        min_p = float(track_points['pressure'].min())
        points_dict = {float(row['lead_time_hours']): (float(row['lat']), float(row['lon'])) for _, row in track_points.iterrows()}
        wind_dict = {float(row['lead_time_hours']): float(row['wind']) for _, row in track_points.iterrows()}
        press_dict = {float(row['lead_time_hours']): float(row['pressure']) for _, row in track_points.iterrows()}
        tracks.append({
            'track_id': t_id,
            'sample': s_val,
            'h_min': h_min,
            'h_max': h_max,
            'f_lat': f_lat,
            'f_lon': f_lon,
            'max_w': max_w,
            'min_p': min_p,
            'points_dict': points_dict,
            'wind_dict': wind_dict,
            'press_dict': press_dict,
            'index': track_points.index.tolist(),
        })

    n = len(tracks)
    if n == 0:
        return df_wp, []

    dist_matrix = np.full((n, n), 100000.0)
    np.fill_diagonal(dist_matrix, 0.0)

    for i in range(n):
        t1 = tracks[i]
        for j in range(i + 1, n):
            t2 = tracks[j]
            overlap = set(t1['points_dict'].keys()).intersection(t2['points_dict'].keys())
            if not overlap:
                continue

            dh = abs(t1['h_min'] - t2['h_min'])
            if dh > 48:
                continue

            sorted_overlap = sorted(overlap)
            early_overlap = sorted_overlap[: min(8, len(sorted_overlap))]
            d_early_mean = sum(
                haversine_km(
                    t1['points_dict'][h][0], t1['points_dict'][h][1],
                    t2['points_dict'][h][0], t2['points_dict'][h][1],
                )
                for h in early_overlap
            ) / len(early_overlap)

            if d_early_mean > 500.0:
                continue

            d_gen = haversine_km(t1['f_lat'], t1['f_lon'], t2['f_lat'], t2['f_lon'])
            d_overlap_start = haversine_km(
                t1['points_dict'][sorted_overlap[0]][0], t1['points_dict'][sorted_overlap[0]][1],
                t2['points_dict'][sorted_overlap[0]][0], t2['points_dict'][sorted_overlap[0]][1],
            )
            # Match either co-located genesis points or late-detected fragments overlapping cleanly
            if d_gen > max_nursery_dist:
                if not (dh >= 18.0 and len(sorted_overlap) >= 4 and d_overlap_start <= 420.0 and d_gen <= max_nursery_dist * 1.45):
                    continue

            d_all_mean = sum(
                haversine_km(
                    t1['points_dict'][h][0], t1['points_dict'][h][1],
                    t2['points_dict'][h][0], t2['points_dict'][h][1],
                )
                for h in sorted_overlap
            ) / len(sorted_overlap)

            eff_gen_dist = d_gen if d_gen <= max_nursery_dist else d_overlap_start
            combined_dist = 0.40 * eff_gen_dist + 0.40 * d_early_mean + 0.20 * min(max_nursery_dist, d_all_mean) + (dh * 2.0)
            dist_matrix[i, j] = combined_dist
            dist_matrix[j, i] = combined_dist

    if n == 1:
        labels = [1]
    else:
        condensed = squareform(dist_matrix, checks=False)
        Z = linkage(condensed, method='average')
        labels = fcluster(Z, t=max_dist, criterion='distance')

    clusters = {}
    for idx, lbl in enumerate(labels):
        clusters.setdefault(lbl, []).append(tracks[idx])

    # Keep candidate floor at 2 before nursery aggregation so valid 2-4 member fragments
    # can merge into a unified nursery signal prior to strict min_members validation.
    candidate_floor = 2 if enable_nursery_aggregation else max(2, min_members // 3)
    candidate_lpas = []
    for lbl, cl_tracks in clusters.items():
        by_member = {}
        for t in cl_tracks:
            by_member.setdefault(t['sample'], []).append(t)

        deduped_tracks = []
        for m_tracks in by_member.values():
            if len(m_tracks) == 1:
                deduped_tracks.append(m_tracks[0])
            else:
                deduped_tracks.append(max(m_tracks, key=lambda tr: (len(tr['points_dict']), tr['max_w'])))

        num_members = len(deduped_tracks)
        if num_members < candidate_floor:
            continue

        cand_geo = mean_geo_center([{'lat': t['f_lat'], 'lon': t['f_lon']} for t in deduped_tracks])
        avg_lat = float(cand_geo['lat'])
        avg_lon = float(cand_geo['lon'])
        avg_h = float(np.mean([t['h_min'] for t in deduped_tracks]))
        max_w = float(max(t['max_w'] for t in deduped_tracks))
        min_p = float(min(t['min_p'] for t in deduped_tracks))
        duration = float(max(t['h_max'] for t in deduped_tracks) - min(t['h_min'] for t in deduped_tracks))

        is_in_wp = 100.0 <= avg_lon <= 180.0
        is_in_cp = (-180.0 <= avg_lon <= -140.0) or (180.0 <= avg_lon <= 220.0)
        if not (0.0 <= avg_lat <= 38.0 and (is_in_wp or is_in_cp)):
            continue

        is_atcf, reason = is_atcf_storm_or_invest(deduped_tracks, knack_storms=knack_storms, atcf_index_storms=atcf_index_storms)
        if is_atcf:
            print(f"Skipping pre-candidate cluster {lbl}: {reason} (TC suppression active - no monitoring plot needed)")
            continue

        candidate_lpas.append({
            'cluster_label': lbl,
            'tracks': deduped_tracks,
            'members': num_members,
            'max_w': max_w,
            'min_p': min_p,
            'duration': duration,
            'avg_lat': avg_lat,
            'avg_lon': avg_lon,
            'avg_h': avg_h,
        })

    if enable_nursery_aggregation and len(candidate_lpas) > 1:
        aggregated_groups = aggregate_nursery_lpas(
            candidate_lpas,
            max_nursery_dist=max_nursery_dist,
            max_genesis_gap_h=max_nursery_gap_h,
            min_motion_cos=min_motion_cos,
            min_motion_displacement_km=min_motion_disp_km,
            max_member_overlap=max_member_overlap,
        )
    else:
        aggregated_groups = candidate_lpas

    validated_lpas = []
    for grp in aggregated_groups:
        if grp['members'] < min_members:
            continue
        if grp['duration'] < min_duration:
            continue
        if (np.isnan(grp['max_w']) or grp['max_w'] < min_wind_kt) and (np.isnan(grp['min_p']) or grp['min_p'] > max_mslp_hpa):
            continue
        if not (0.0 <= grp['avg_lat'] <= 38.0 and (100.0 <= grp['avg_lon'] <= 180.0 or (-180.0 <= grp['avg_lon'] <= -140.0))):
            continue

        is_atcf, reason = is_atcf_storm_or_invest(grp['tracks'], knack_storms=knack_storms, atcf_index_storms=atcf_index_storms)
        if is_atcf:
            print(f"Skipping merged cluster {grp.get('cluster_label')}: {reason} (Official ATCF storm/invest)")
            continue

        validated_lpas.append(grp)

    validated_lpas.sort(key=lambda x: (x['members'], x['max_w'] if not np.isnan(x['max_w']) else 0), reverse=True)

    lpa_clusters_info = []
    for idx, lpa in enumerate(validated_lpas):
        lpa_num = idx + 1
        sg_id = f"monitoring_lpa{lpa_num:02d}"
        display_name = f"LPA {lpa_num:02d} (UNDER MONITORING - {lpa['members']} MEMBERS)"
        rep_id = f"LPA{lpa_num:02d}"

        for t in lpa['tracks']:
            df_wp.loc[t['index'], 'storm_group'] = sg_id
            df_wp.loc[t['index'], 'storm_group_name'] = display_name
            df_wp.loc[t['index'], 'rep_track_id'] = rep_id
            df_wp.loc[t['index'], 'is_monitoring'] = True

        lpa_clusters_info.append({
            'storm_group': sg_id,
            'storm_group_name': display_name,
            'rep_track_id': rep_id,
            'members': lpa['members'],
            'tracks': lpa['tracks'],
            'max_w': lpa['max_w'],
            'min_p': lpa['min_p'],
            'duration': lpa['duration'],
        })
        print(
            f"Validated Under-Monitoring Candidate: {sg_id} ({display_name}) with {lpa['members']} members, "
            f"max wind {lpa['max_w']:.1f}kt, min MSLP {lpa['min_p']:.1f}hPa, duration {lpa['duration']:.0f}h"
        )

    return df_wp, lpa_clusters_info


def _classify_genesis_region(mean_gen_lat, mean_gen_lon):
    """Maps a genesis centroid (lat, lon) to canonical Philippine/WestPac sea sub-region names."""
    if (-180.0 <= mean_gen_lon <= -140.0) or (180.0 <= mean_gen_lon <= 220.0) or (mean_gen_lon < 0):
        return "CENTRAL PACIFIC / DATELINE", "in the Central Pacific / crossing Dateline"
    if 100.0 <= mean_gen_lon < 114.0 and 4.0 <= mean_gen_lat <= 24.0:
        return "SOUTH CHINA SEA", "in the South China Sea"
    if 118.5 <= mean_gen_lon <= 123.5 and 19.5 <= mean_gen_lat <= 22.5:
        return "LUZON STRAIT", "in the Luzon Strait"
    if 114.0 <= mean_gen_lon <= 121.5 and 10.0 <= mean_gen_lat <= 21.5:
        return "WEST PHILIPPINE SEA", "in the West Philippine Sea"
    if 117.0 <= mean_gen_lon <= 122.5 and 6.5 <= mean_gen_lat <= 11.5:
        return "SULU SEA", "in the Sulu Sea"
    if 118.0 <= mean_gen_lon <= 126.0 and 2.0 <= mean_gen_lat < 6.5:
        return "CELEBES SEA", "in the Celebes Sea"
    if mean_gen_lon < 121.0 and mean_gen_lat < 10.0:
        return "SULU / CELEBES SEA", "in the Sulu / Celebes Sea"
    if 121.0 <= mean_gen_lon <= 127.5 and 13.5 <= mean_gen_lat <= 19.5:
        return "EAST OF LUZON", "east of Luzon"
    if 122.0 <= mean_gen_lon <= 127.5 and 9.5 <= mean_gen_lat < 13.5:
        return "EAST OF VISAYAS", "east of the Visayas"
    if 123.0 <= mean_gen_lon < 127.5 and 3.5 <= mean_gen_lat < 9.5:
        return "EAST OF MINDANAO", "east of Mindanao"
    if 127.5 <= mean_gen_lon < 133.5 and 3.5 <= mean_gen_lat <= 11.5:
        return "WEST OF PALAU", "west of Palau"
    if 133.5 <= mean_gen_lon <= 136.5 and 3.5 <= mean_gen_lat <= 11.5:
        return "PALAU VICINITY", "near Palau"
    if 136.5 < mean_gen_lon <= 143.0 and 3.0 <= mean_gen_lat <= 11.5:
        return "EAST OF PALAU", "east of Palau"
    if 141.0 <= mean_gen_lon <= 148.0 and 11.5 <= mean_gen_lat <= 21.0:
        return "MARIANA ISLANDS / GUAM", "near the Mariana Islands / Guam"
    if 137.0 <= mean_gen_lon < 141.0 and 11.5 <= mean_gen_lat <= 23.0:
        return "WEST OF MARIANAS", "west of the Marianas"
    if 148.0 < mean_gen_lon <= 158.0 and 11.5 <= mean_gen_lat <= 25.0:
        return "EAST OF MARIANAS", "east of the Marianas"
    if 143.0 < mean_gen_lon <= 150.0 and 3.0 <= mean_gen_lat < 11.5:
        return "CAROLINE ISLANDS", "in the Caroline Islands"
    if 150.0 < mean_gen_lon <= 161.0 and 3.0 <= mean_gen_lat <= 16.0:
        return "MICRONESIA", "in Micronesia"
    if 161.0 < mean_gen_lon <= 176.0 and 3.0 <= mean_gen_lat <= 20.0:
        return "MARSHALL ISLANDS", "in the Marshall Islands"
    if mean_gen_lon > 176.0 and mean_gen_lat <= 20.0:
        return "EAST OF MARSHALL ISLANDS", "east of the Marshall Islands"
    if mean_gen_lon >= 152.0 and mean_gen_lat <= 20.0:
        return "EASTERN CAROLINE", "in Eastern Caroline Islands"
    if 121.0 <= mean_gen_lon <= 130.0 and 21.5 <= mean_gen_lat <= 26.5:
        return "TAIWAN / RYUKYU", "near Taiwan / Ryukyu Islands"
    if mean_gen_lon <= 130.0 and mean_gen_lat > 26.5:
        return "EAST CHINA SEA", "in the East China Sea"
    if mean_gen_lat > 25.0:
        if mean_gen_lon <= 132.0:
            return "EAST CHINA SEA / RYUKYU", "in the East China Sea / Ryukyu"
        return "NORTHWEST PACIFIC", "in the Northwest Pacific"
    if 121.0 <= mean_gen_lon <= 138.0 and 5.0 <= mean_gen_lat <= 25.0:
        return "PHILIPPINE SEA", "in the Philippine Sea"
    return "WESTERN PACIFIC", "in the Western Pacific"


def _format_card1_region(region_name, region_friendly):
    region_display = region_friendly.strip()
    prefixes = [
        ("in the ", ""),
        ("in ", ""),
        ("near the ", ""),
        ("near ", ""),
        ("east of the ", "East of the "),
        ("east of ", "East of "),
        ("west of the ", "West of the "),
        ("west of ", "West of "),
    ]
    for pfx, repl in prefixes:
        if region_display.startswith(pfx):
            return repl + region_display[len(pfx):]
    return region_name.title()


def _compute_cumulative_crossing_hours(deduped_track_dfs):
    """Precomputes the earliest forecast hour each member reaches TS (34kt), TY (64kt), and Major (96kt)."""
    ts_hours, ty_hours, maj_hours = [], [], []
    for tdf in deduped_track_dfs:
        ts_sub = tdf[tdf['wind'] >= 34.0]['lead_time_hours']
        if not ts_sub.empty:
            ts_hours.append(float(ts_sub.min()))
        ty_sub = tdf[tdf['wind'] >= 64.0]['lead_time_hours']
        if not ty_sub.empty:
            ty_hours.append(float(ty_sub.min()))
        maj_sub = tdf[tdf['wind'] >= 96.0]['lead_time_hours']
        if not maj_sub.empty:
            maj_hours.append(float(maj_sub.min()))
    return ts_hours, ty_hours, maj_hours


def _resolve_label_y_positions(items, y_top):
    """
    Separates end-point callout labels vertically while clamping them strictly inside
    [y_min_floor, y_top_ceil] so no label drops below 0% into the x-axis ticks.
    """
    if not items:
        return []
    n = len(items)
    min_gap = max(2.4, y_top * 0.145)
    y_floor = max(1.6, y_top * 0.06)
    y_ceil = y_top * 0.96

    if (n - 1) * min_gap > (y_ceil - y_floor):
        min_gap = (y_ceil - y_floor) / max(1, n - 1)

    target_ys = [min(y_ceil, max(y_floor, float(item['dot_y']))) for item in items]

    # Iterative relaxation respecting bounds
    for _ in range(30):
        for i in range(n - 1):
            gap = target_ys[i] - target_ys[i + 1]
            if gap < min_gap:
                need = min_gap - gap
                target_ys[i] += need * 0.5
                target_ys[i + 1] -= need * 0.5
        # Clamp bottom-up from y_floor, then top-down from y_ceil
        if target_ys[-1] < y_floor:
            target_ys[-1] = y_floor
        for i in range(n - 2, -1, -1):
            if target_ys[i] < target_ys[i + 1] + min_gap:
                target_ys[i] = target_ys[i + 1] + min_gap
        if target_ys[0] > y_ceil:
            target_ys[0] = y_ceil
        for i in range(1, n):
            if target_ys[i] > target_ys[i - 1] - min_gap:
                target_ys[i] = target_ys[i - 1] - min_gap

    return target_ys


def plot_monitoring_tracks(
    df_model,
    model_name,
    storm_group_id,
    output_path,
    storm_name_override=None,
    color_by='wind',
    min_mean_members=25,
    total_ensemble_members=None,
    knack_storms=None,
    atcf_index_storms=None,
    show_genesis=False,
):
    """
    Renders a broadcast-grade dark infographic for an under-monitoring disturbance cluster:
      - Aspect-matched Cartopy map with docked bottom legend and optional consensus track
      - Card 1: Development Probability & Intensity Tiers (<1% precision on 1,000M runs)
      - Card 2: Member Intensity Plume (with survivor-bias quorum & readable category labels)
      - Card 3: Cumulative Probability Curves with clamped non-overlapping callouts
    """
    df_storm = df_model[df_model['storm_group'] == storm_group_id].copy()
    if df_storm.empty:
        print(f"No tracks found for under-monitoring group {storm_group_id}")
        return None

    df_storm = df_storm.dropna(subset=['lat', 'lon'])
    if df_storm.empty:
        print(f"No valid coordinate positions for under-monitoring group {storm_group_id}")
        return None

    by_member = {}
    for (_, s_val), g in df_storm.groupby(['track_id', 'sample']):
        by_member.setdefault(s_val, []).append(g)

    deduped_track_dfs = []
    track_meta_list = []
    for s_val, t_list in by_member.items():
        best_df = t_list[0] if len(t_list) == 1 else max(t_list, key=lambda x: (len(x), x['wind'].max()))
        sorted_tdf = best_df.sort_values('lead_time_hours')
        deduped_track_dfs.append(sorted_tdf)
        track_meta_list.append({
            'track_id': sorted_tdf['track_id'].iloc[0] if not sorted_tdf.empty else '',
            'sample': s_val,
            'points_dict': {float(r['lead_time_hours']): (float(r['lat']), float(r['lon'])) for _, r in sorted_tdf.iterrows()},
            'max_w': float(sorted_tdf['wind'].max()),
            'f_lat': float(sorted_tdf.iloc[0]['lat']) if not sorted_tdf.empty else np.nan,
            'f_lon': float(sorted_tdf.iloc[0]['lon']) if not sorted_tdf.empty else np.nan,
        })

    is_atcf, reason = is_atcf_storm_or_invest(track_meta_list, knack_storms=knack_storms, atcf_index_storms=atcf_index_storms)
    if is_atcf:
        print(f"Skipping plot generation for {storm_group_id}: {reason} (Official ATCF storm/invest - no monitoring plot needed)")
        return None

    cluster_members = len(deduped_track_dfs)
    if cluster_members == 0:
        return None

    total_ensemble_members = max(
        cluster_members,
        infer_total_members(model_name=model_name, explicit_total=total_ensemble_members),
    )

    init_time_raw = df_storm['init_time'].dropna().iloc[0] if not df_storm['init_time'].isna().all() else 'Unknown'
    init_dt = parse_utc_init_datetime(init_time_raw)
    pht_dt = init_dt + timedelta(hours=8)
    pht_time_str = pht_dt.strftime('%I:%M %p').lstrip('0')
    init_str = f"INIT {init_dt.strftime('%d %b %H').upper()}Z ({pht_time_str} PHT)"

    all_first_lats = [tdf.iloc[0]['lat'] for tdf in deduped_track_dfs if not tdf.empty]
    all_first_lons = [tdf.iloc[0]['lon'] for tdf in deduped_track_dfs if not tdf.empty]
    cand_geo = mean_geo_center([{'lat': lat, 'lon': lon} for lat, lon in zip(all_first_lats, all_first_lons)])
    mean_gen_lat = float(cand_geo['lat']) if all_first_lats else 15.0
    mean_gen_lon = float(cand_geo['lon']) if all_first_lons else 135.0
    region_name, region_friendly = _classify_genesis_region(mean_gen_lat, mean_gen_lon)

    max_lead_h = max(float(tdf['lead_time_hours'].max()) for tdf in deduped_track_dfs if not tdf.empty)
    end_run_dt = init_dt + timedelta(hours=max_lead_h)

    dev_raw_pct, dev_pct_str = format_percentage(cluster_members, total_ensemble_members)
    ts_hours, ty_hours, maj_hours = _compute_cumulative_crossing_hours(deduped_track_dfs)
    ts_count, ty_count, major_count = len(ts_hours), len(ty_hours), len(maj_hours)
    ts_raw_pct, ts_pct_str = format_percentage(ts_count, total_ensemble_members)
    ty_raw_pct, ty_pct_str = format_percentage(ty_count, total_ensemble_members)
    maj_raw_pct, maj_pct_str = format_percentage(major_count, total_ensemble_members)

    gen_hours = [float(tdf.iloc[0]['lead_time_hours']) for tdf in deduped_track_dfs if not tdf.empty]
    p25_gen_h = float(np.percentile(gen_hours, 25)) if gen_hours else 12.0
    p75_gen_h = float(np.percentile(gen_hours, 75)) if gen_hours else 48.0
    gen_start_dt = init_dt + timedelta(hours=p25_gen_h)
    gen_end_dt = init_dt + timedelta(hours=max(p75_gen_h, p25_gen_h + 24.0))

    # Intensity plume with survivor-bias quorum
    all_leads = sorted({float(h) for tdf in deduped_track_dfs for h in tdf['lead_time_hours'].dropna().values})
    quorum_floor = max(3, int(cluster_members * 0.15)) if cluster_members >= 6 else max(2, int(math.ceil(cluster_members * 0.4)))
    lead_stats = []
    for lh in all_leads:
        winds_at_h = []
        for tdf in deduped_track_dfs:
            row = tdf[tdf['lead_time_hours'] == lh]
            if not row.empty:
                w = float(row.iloc[0]['wind'])
                if not np.isnan(w):
                    winds_at_h.append(w)
        if len(winds_at_h) >= quorum_floor:
            lead_stats.append({
                'lead_hour': lh,
                'dt': init_dt + timedelta(hours=lh),
                'p10': float(np.percentile(winds_at_h, 10)),
                'p25': float(np.percentile(winds_at_h, 25)),
                'median': float(np.median(winds_at_h)),
                'mean': float(np.mean(winds_at_h)),
                'p75': float(np.percentile(winds_at_h, 75)),
                'p90': float(np.percentile(winds_at_h, 90)),
            })

    # Compute cluster consensus mean track
    consensus_quorum = min(cluster_members, max(3, int(math.ceil(cluster_members * 0.30))))
    df_consensus = compute_clean_mean_track_df(deduped_track_dfs, min_member_ratio=0.30, min_members=consensus_quorum)
    has_consensus = len(df_consensus) >= 2

    print(f"Generating broadcast-grade development signal graphic for {model_name} – {storm_group_id} ({region_name}) ...")

    fig = plt.figure(figsize=(16, 10), facecolor='#090d14')

    fig.text(0.035, 0.958, f"{region_name} DEVELOPMENT SIGNAL", fontsize=22, weight='heavy', color='#ffffff', fontfamily='sans-serif')
    fig.text(
        0.035, 0.932, f"{format_model_display_title(model_name)} {total_ensemble_members}-MEMBER ENSEMBLE  |  {init_str}",
        fontsize=10.5, weight='bold', color='#94a3b8', fontfamily='monospace',
    )
    fig.text(0.965, 0.958, "PHILIPPINE TYPHOON/WEATHER", fontsize=13.0, weight='heavy', color='#f1f5f9', ha='right', fontfamily='sans-serif')
    fig.text(0.965, 0.934, "ENSEMBLE CLUSTER GENESIS SIGNAL", fontsize=9.0, weight='bold', color='#64748b', ha='right', fontfamily='monospace')

    has_cpac = any(p < 0.0 or p > 180.0 for tdf in deduped_track_dfs for p in tdf['lon'].dropna().values)
    if has_cpac:
        all_lons = [unwrap_lon_for_cpac(p, True) for tdf in deduped_track_dfs for p in tdf['lon'].dropna().values]
    else:
        all_lons = [p for tdf in deduped_track_dfs for p in tdf['lon'].dropna().values]
    all_lats = [p for tdf in deduped_track_dfs for p in tdf['lat'].dropna().values]

    min_lon = float(np.percentile(all_lons, 1))
    max_lon = float(np.percentile(all_lons, 99))
    min_lat = float(np.percentile(all_lats, 1))
    max_lat = float(np.percentile(all_lats, 99))

    lon_pad = max(8.0, (max_lon - min_lon) * 0.25)
    lat_pad = max(5.0, (max_lat - min_lat) * 0.25)
    if has_cpac:
        view_lon_min = max(100.0, min_lon - lon_pad)
        view_lon_max = min(220.0, max_lon + lon_pad)
    else:
        view_lon_min = max(105.0, min_lon - lon_pad)
        view_lon_max = min(180.0, max_lon + lon_pad)
    view_lat_min = max(3.0, min_lat - lat_pad)
    view_lat_max = min(44.0, max_lat + lat_pad)

    if not has_cpac and max_lon > 150.0 and view_lon_max < 176.0:
        view_lon_max = 178.0

    if view_lon_max - view_lon_min < 26.0:
        mid_lon = (view_lon_min + view_lon_max) / 2.0
        view_lon_min = max(100.0 if has_cpac else 105.0, mid_lon - 13.0)
        view_lon_max = min(220.0 if has_cpac else 180.0, mid_lon + 13.0)
    if view_lat_max - view_lat_min < 18.0:
        mid_lat = (view_lat_min + view_lat_max) / 2.0
        view_lat_min = max(3.0, mid_lat - 9.0)
        view_lat_max = min(44.0, mid_lat + 9.0)

    map_rect = [0.035, 0.132, 0.575, 0.778]
    view_bounds = fit_extent_to_aspect(fig, map_rect, view_lon_min, view_lon_max, view_lat_min, view_lat_max, has_cpac=has_cpac)
    ax_map, prov_geoms = setup_map_backdrop(fig, map_rect, view_bounds, has_cpac=has_cpac, script_file=__file__)

    if show_genesis:
        early_pts = []
        for tdf in deduped_track_dfs:
            if not tdf.empty:
                r0 = tdf.iloc[0]
                if not np.isnan(r0['lon']) and not np.isnan(r0['lat']):
                    early_pts.append((unwrap_lon_for_cpac(float(r0['lon']), has_cpac), float(r0['lat'])))

        if len(early_pts) >= 6:
            e_lons = [p[0] for p in early_pts]
            e_lats = [p[1] for p in early_pts]
            gx, gy = np.mgrid[min(e_lons) - 2.0 : max(e_lons) + 2.0 : 120j, min(e_lats) - 2.0 : max(e_lats) + 2.0 : 120j]
            kde = gaussian_kde(np.vstack([e_lons, e_lats]), bw_method=0.20)
            gz = np.reshape(kde(np.vstack([gx.ravel(), gy.ravel()])).T, gx.shape)
            gz_norm = (gz / gz.max()) * 100.0

            ax_map.contourf(
                gx, gy, gz_norm, levels=[30, 50, 70, 85, 100],
                colors=['#0c2340', '#133e68', '#1a5994', '#1f78c1', '#28a0f0'], alpha=0.35,
                transform=ccrs.PlateCarree(), zorder=3,
            )
            cs_lines = ax_map.contour(
                gx, gy, gz_norm, levels=[40, 70], colors=['#60a5fa', '#ffffff'],
                linewidths=[0.8, 1.2], transform=ccrs.PlateCarree(), zorder=4,
            )
            clabels = ax_map.clabel(cs_lines, levels=[40, 70], inline=True, fontsize=7.2, fmt='%1.0f%%', colors='#ffffff', zorder=5)
            for cl in clabels:
                cl.set_rotation(0)
                cl.set_weight('bold')
                cl.set_path_effects([path_effects.withStroke(linewidth=2.0, foreground='#090d14')])

    track_cmap = mcolors.ListedColormap(WIND_COLORS)
    track_norm = mcolors.BoundaryNorm(WIND_BOUNDS, track_cmap.N, extend='both')

    ph_tracks_count = count_ph_tracks(deduped_track_dfs)
    is_large = (total_ensemble_members >= 200) or ('large' in model_name.lower())
    is_dense_over_ph = ph_tracks_count >= 15 or (is_large and ph_tracks_count >= 5)

    draw_member_tracks(ax_map, deduped_track_dfs, track_cmap, track_norm, 'wind', has_cpac, is_large, is_dense_over_ph)

    if is_dense_over_ph:
        draw_dense_ph_provinces(ax_map, prov_geoms)

    # Render cluster genesis centroid and consensus path when available
    gen_plot_lon = unwrap_lon_for_cpac(mean_gen_lon, has_cpac)
    if has_consensus:
        c_lons = [unwrap_lon_for_cpac(x, has_cpac) for x in df_consensus['lon'].to_numpy(dtype=float)]
        c_lats = df_consensus['lat'].to_numpy(dtype=float)
        ax_map.plot(c_lons, c_lats, color='#090d14', linewidth=4.2, alpha=0.80, zorder=7.5, transform=ccrs.PlateCarree())
        ax_map.plot(c_lons, c_lats, color='#f8fafc', linestyle='--', linewidth=2.0, alpha=0.95, zorder=8.0, transform=ccrs.PlateCarree())
        ax_map.plot(
            c_lons[0], c_lats[0], marker='o', markersize=6.0,
            markerfacecolor='#38bdf8', markeredgecolor='#090d14', markeredgewidth=1.4,
            zorder=8.5, transform=ccrs.PlateCarree(),
        )
    else:
        ax_map.plot(
            gen_plot_lon, mean_gen_lat, marker='o', markersize=6.0,
            markerfacecolor='#38bdf8', markeredgecolor='#090d14', markeredgewidth=1.4,
            zorder=8.5, transform=ccrs.PlateCarree(),
        )

    # Docked Legend directly below finalized map box
    ax_leg = dock_legend_axis_under_map(fig, ax_map, leg_h=0.056, gap=0.036, min_bottom=0.042)
    tw_h = 0.28
    tw_y = 0.26

    if show_genesis:
        ax_leg.text(0.02, 0.72, "GENESIS WITHIN 60 NM (%)", transform=ax_leg.transAxes, fontsize=6.6, weight='heavy', color='#e2e8f0', va='center')
        step_x, step_w = 0.02, 0.033
        ax_leg.text(step_x, tw_y - 0.06, "0", transform=ax_leg.transAxes, fontsize=6.0, color='#94a3b8', ha='center', va='top')
        for idx, (val, col) in enumerate(zip([20, 40, 60, 80, 100], ['#133e68', '#1a5994', '#1f78c1', '#28a0f0', '#93c5fd'])):
            ax_leg.add_patch(mpatches.Rectangle((step_x + idx * step_w, tw_y), step_w, tw_h, transform=ax_leg.transAxes, facecolor=col, edgecolor='#090d14', linewidth=0.5))
            ax_leg.text(step_x + idx * step_w + step_w / 2, tw_y - 0.06, f"{val}", transform=ax_leg.transAxes, fontsize=6.0, color='#94a3b8', ha='center', va='top')

        ax_leg.text(0.23, 0.72, "TRACK WIND (KT)", transform=ax_leg.transAxes, fontsize=6.6, weight='heavy', color='#e2e8f0', va='center')
        tw_x, tw_w = 0.23, 0.038
    else:
        ax_leg.text(0.03, 0.72, "TRACK WIND (KT)", transform=ax_leg.transAxes, fontsize=7.0, weight='heavy', color='#e2e8f0', va='center')
        tw_x, tw_w = 0.03, 0.042

    for idx, col in enumerate(WIND_COLORS):
        ax_leg.add_patch(mpatches.Rectangle((tw_x + idx * tw_w, tw_y), tw_w, tw_h, transform=ax_leg.transAxes, facecolor=col, edgecolor='#090d14', linewidth=0.5))
    for idx, lbl in [(0, '20'), (2, '40'), (4, '60'), (6, '80'), (7, '100'), (8, '120'), (10, '140+')]:
        ax_leg.text(tw_x + idx * tw_w, tw_y - 0.06, lbl, transform=ax_leg.transAxes, fontsize=6.2, color='#94a3b8', ha='center', va='top')

    if not show_genesis and has_consensus:
        ax_leg.text(0.60, 0.72, "CONSENSUS", transform=ax_leg.transAxes, fontsize=6.8, weight='heavy', color='#e2e8f0', ha='center', va='center')
        ax_leg.plot([0.535, 0.665], [tw_y + tw_h / 2, tw_y + tw_h / 2], transform=ax_leg.transAxes, color='#090d14', linewidth=3.4)
        ax_leg.plot([0.535, 0.665], [tw_y + tw_h / 2, tw_y + tw_h / 2], transform=ax_leg.transAxes, color='#f8fafc', linestyle='--', linewidth=1.8)

    status_x = 0.715 if not show_genesis else 0.74
    status_w = 0.255 if not show_genesis else 0.23
    ax_leg.text(status_x, 0.72, "MONITORING STATUS", transform=ax_leg.transAxes, fontsize=6.8, weight='heavy', color='#e2e8f0', va='center')
    ax_leg.add_patch(mpatches.Rectangle((status_x, tw_y), status_w, tw_h, transform=ax_leg.transAxes, facecolor='#1e293b', edgecolor='#334155', linewidth=0.8))
    ax_leg.text(status_x + status_w / 2, tw_y + tw_h / 2, "POTENTIAL GENESIS CLUSTER", transform=ax_leg.transAxes, fontsize=6.5, weight='bold', color='#38bdf8', ha='center', va='center')

    # Right Column Cards
    card_x = 0.640
    card_w = 0.325

    # Card 1: Development Probability & Intensity Breakdown
    ax_card1 = draw_card_container(fig, [card_x, 0.670, card_w, 0.240])
    region_display = _format_card1_region(region_name, region_friendly)
    ax_card1.text(0.055, 0.935, region_display, fontsize=9.6, color='#94a3b8', fontfamily='sans-serif', va='top', ha='left', zorder=2)

    t_big_pct = ax_card1.text(0.055, 0.770, dev_pct_str, fontsize=32, weight='bold', color='#ffffff', fontfamily='sans-serif', va='center', ha='left', zorder=2)
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    inv_c1 = ax_card1.transAxes.inverted()
    bb_big = t_big_pct.get_window_extent(renderer=renderer)
    w_big = inv_c1.transform((bb_big.width, 0))[0] - inv_c1.transform((0, 0))[0]
    pct_text_x = min(0.45, 0.055 + w_big + 0.025)
    ax_card1.text(
        pct_text_x, 0.770, "of ensemble members develop\na tropical cyclone",
        fontsize=9.1, color='#e2e8f0', fontfamily='sans-serif', linespacing=1.2, va='center', ha='left', zorder=2,
    )

    end_run_display = f"{end_run_dt.strftime('%b')} {end_run_dt.day}"
    ax_card1.text(
        0.055, 0.635, f"{cluster_members} of {total_ensemble_members:,} members · full run to {end_run_display}",
        fontsize=8.6, color='#94a3b8', fontfamily='sans-serif', va='center', ha='left',
    )

    if gen_start_dt.strftime('%b') == gen_end_dt.strftime('%b'):
        peak_pill_dates = f"{gen_start_dt.strftime('%b')} {gen_start_dt.day}–{gen_end_dt.day}"
    else:
        peak_pill_dates = f"{gen_start_dt.strftime('%b')} {gen_start_dt.day} – {gen_end_dt.strftime('%b')} {gen_end_dt.day}"
    ax_card1.text(
        0.055, 0.525, f"Peak genesis window · {peak_pill_dates}",
        fontsize=8.0, weight='medium', color='#cbd5e1', fontfamily='sans-serif', va='center', ha='left',
        bbox=dict(boxstyle='round,pad=0.38,rounding_size=0.55', facecolor='#101928', edgecolor='#233247', linewidth=0.9),
    )

    ax_card1.plot([0.055, 0.945], [0.420, 0.420], color='#1e293b', linewidth=1.0)

    tiles = [
        {'label': 'Reach TS', 'pct_str': ts_pct_str, 'pct_raw': ts_raw_pct, 'count': ts_count, 'color': '#38bdf8'},
        {'label': 'Typhoon', 'pct_str': ty_pct_str, 'pct_raw': ty_raw_pct, 'count': ty_count, 'color': '#f59e0b'},
        {'label': 'Major', 'pct_str': maj_pct_str, 'pct_raw': maj_raw_pct, 'count': major_count, 'color': '#ef4444'},
    ]
    tile_w, gap, tile_bottom, tile_h = 0.276, 0.031, 0.055, 0.315
    for idx, tile in enumerate(tiles):
        tile_x = 0.055 + idx * (tile_w + gap)
        ax_card1.add_patch(mpatches.FancyBboxPatch(
            (tile_x, tile_bottom), tile_w, tile_h,
            boxstyle='round,pad=0.012,rounding_size=0.045',
            facecolor='#101826', edgecolor='#1e2d42', linewidth=0.9, transform=ax_card1.transAxes, zorder=2,
        ))
        ax_card1.text(tile_x + 0.025, tile_bottom + tile_h - 0.045, tile['label'], fontsize=8.2, color='#94a3b8', va='top', ha='left', zorder=3)
        ax_card1.text(tile_x + 0.025, tile_bottom + tile_h - 0.125, tile['pct_str'], fontsize=17.0, color=tile['color'], weight='bold', va='top', ha='left', zorder=3)
        ax_card1.text(tile_x + 0.025, tile_bottom + 0.070, f"{tile['count']} of {total_ensemble_members:,}", fontsize=7.2, color='#64748b', va='center', ha='left', zorder=3)

        bar_x, bar_w, bar_y, bar_h = tile_x + 0.025, tile_w - 0.050, tile_bottom + 0.025, 0.018
        ax_card1.add_patch(mpatches.FancyBboxPatch(
            (bar_x, bar_y), bar_w, bar_h, boxstyle='round,pad=0.002,rounding_size=0.006',
            facecolor='#1e293b', edgecolor='none', transform=ax_card1.transAxes, zorder=3,
        ))
        if tile['count'] > 0:
            fill_len = max(0.012, min(bar_w, bar_w * (tile['pct_raw'] / 100.0)))
            ax_card1.add_patch(mpatches.FancyBboxPatch(
                (bar_x, bar_y), fill_len, bar_h, boxstyle='round,pad=0.002,rounding_size=0.006',
                facecolor=tile['color'], edgecolor='none', transform=ax_card1.transAxes, zorder=4,
            ))

    # Card 2: Member Intensity Card
    card2_card_bottom, card2_card_h = 0.355, 0.295
    ax_card2_bg = draw_card_container(fig, [card_x, card2_card_bottom, card_w, card2_card_h])
    ax_card2_bg.text(0.055, 0.920, "Member intensity", fontsize=11.5, weight='bold', color='#ffffff', va='top', ha='left', zorder=2)

    is_ai_model = any(k in model_name.lower() for k in ['wnc', 'wnv3', 'fnv3', 'large', 'ai'])
    if is_ai_model:
        ax_card2_bg.text(
            0.945, 0.890, "AI intensity · treat with caution",
            fontsize=7.8, weight='medium', color='#f59e0b', va='center', ha='right', zorder=2,
            bbox=dict(boxstyle='round,pad=0.45,rounding_size=0.6', facecolor='#14110b', edgecolor='#f59e0b', linewidth=1.0),
        )

    if lead_stats:
        peak_stat = max(lead_stats, key=lambda s: s['median'])
        peak_median_kt = int(round(peak_stat['median']))
        peak_dt = peak_stat['dt']
        peak_med_sub = f"peak median {peak_median_kt} kt on {peak_dt.strftime('%b')} {peak_dt.day} {peak_dt.hour:02d}Z"
    else:
        peak_stat = None
        peak_median_kt = None
        peak_med_sub = "peak median N/A"

    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    inv_c2_bg = ax_card2_bg.transAxes.inverted()

    t_sub1 = ax_card2_bg.text(0.055, 0.810, "1-min sustained wind · ", fontsize=8.5, color='#94a3b8', va='center', ha='left', zorder=2)
    bb_s1 = t_sub1.get_window_extent(renderer=renderer)
    w_s1 = inv_c2_bg.transform((bb_s1.width, 0))[0] - inv_c2_bg.transform((0, 0))[0]
    ax_card2_bg.text(0.055 + w_s1, 0.810, peak_med_sub, fontsize=8.5, weight='bold', color='#fbbf24', va='center', ha='left', zorder=2)

    leg2_items = [
        ("—", "#ffffff", " Median", "#ffffff"),
        ("---", "#cbd5e1", " Mean", "#cbd5e1"),
        ("■", "#38bdf8", " 25–75%", "#94a3b8"),
        ("■", "#0284c7", " 10–90%", "#94a3b8"),
    ]
    cur_lx = 0.055
    for sym, sym_col, lbl, lbl_col in leg2_items:
        t_sym = ax_card2_bg.text(cur_lx, 0.690, sym, fontsize=8.2, weight='heavy', color=sym_col, va='center', ha='left', zorder=2)
        w_sym = inv_c2_bg.transform((t_sym.get_window_extent(renderer=renderer).width, 0))[0] - inv_c2_bg.transform((0, 0))[0]
        cur_lx += w_sym + 0.006
        t_lbl = ax_card2_bg.text(cur_lx, 0.690, lbl, fontsize=8.0, weight='semibold', color=lbl_col, va='center', ha='left', zorder=2)
        w_lbl = inv_c2_bg.transform((t_lbl.get_window_extent(renderer=renderer).width, 0))[0] - inv_c2_bg.transform((0, 0))[0]
        cur_lx += w_lbl + 0.032

    ax_card2 = fig.add_axes([card_x + card_w * 0.045, card2_card_bottom + card2_card_h * 0.120, card_w * 0.875, card2_card_h * 0.510])
    ax_card2.set_facecolor('none')

    for c_label, c_low, c_high, c_bg, c_alpha, c_txt in INTENSITY_BANDS:
        ax_card2.axhspan(c_low, c_high, facecolor=c_bg, alpha=c_alpha, edgecolor='none', zorder=1)
        t_band = ax_card2.text(
            0.015, (c_low + c_high) / 2.0, c_label,
            color=c_txt, fontsize=7.6, weight='bold', va='center', ha='left',
            transform=ax_card2.get_yaxis_transform(), zorder=8,
        )
        t_band.set_path_effects([path_effects.withStroke(linewidth=2.4, foreground='#0b111d')])

    if lead_stats:
        ls_dts = [s['dt'] for s in lead_stats]
        for tdf in deduped_track_dfs:
            tdf_dts = [init_dt + timedelta(hours=float(h)) for h in tdf['lead_time_hours']]
            ax_card2.plot(tdf_dts, tdf['wind'], color='#94a3b8', alpha=0.08, linewidth=0.7, zorder=2)

        ax_card2.fill_between(ls_dts, [s['p10'] for s in lead_stats], [s['p90'] for s in lead_stats], color='#0284c7', alpha=0.22, zorder=3)
        ax_card2.fill_between(ls_dts, [s['p25'] for s in lead_stats], [s['p75'] for s in lead_stats], color='#38bdf8', alpha=0.38, zorder=3)
        ax_card2.plot(ls_dts, [s['mean'] for s in lead_stats], color='#cbd5e1', linestyle='--', linewidth=1.8, zorder=5)
        ax_card2.plot(ls_dts, [s['median'] for s in lead_stats], color='#ffffff', linewidth=2.8, zorder=5)

        if peak_stat:
            ax_card2.plot(
                peak_stat['dt'], peak_stat['median'], marker='o', markersize=6.5,
                markerfacecolor='#ffffff', markeredgecolor='#000000', markeredgewidth=1.8, zorder=10,
            )
            ax_card2.annotate(
                f"{peak_median_kt} kt",
                xy=(peak_stat['dt'], peak_stat['median']),
                xytext=(9, 4), textcoords='offset points',
                fontsize=8.0, weight='bold', color='#ffffff',
                bbox=dict(boxstyle='round,pad=0.28,rounding_size=0.35', facecolor='#0b111d', edgecolor='#334155', linewidth=0.9),
                va='bottom', ha='left', zorder=11,
            )

        min_c2_dt, max_c2_dt = min(ls_dts), max(ls_dts)
        pad_left = timedelta(hours=max(6.0, ((max_c2_dt - min_c2_dt).total_seconds() / 3600.0) * 0.08))
        ax_card2.set_xlim(min_c2_dt - pad_left, max_c2_dt)
        day_int = compute_plume_day_interval(min_c2_dt, max_c2_dt)
        ax_card2.xaxis.set_major_locator(mdates.DayLocator(interval=day_int))
    else:
        ax_card2.set_xlim(init_dt, init_dt + timedelta(days=7))
        ax_card2.xaxis.set_major_locator(mdates.DayLocator(interval=2))

    ax_card2.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, pos: f"{mdates.num2date(x).strftime('%b')} {mdates.num2date(x).day}"))
    ax_card2.tick_params(axis='x', labelsize=7.6, colors='#94a3b8', length=0, pad=5)

    ax_card2.set_ylim(0, 160)
    ax_card2.set_yticks([0, 25, 50, 75, 100, 125, 150])
    ax_card2.set_yticklabels(['0', '25', '50', '75', '100', '125', '150'], fontsize=7.6, color='#94a3b8')
    ax_card2.yaxis.tick_right()
    ax_card2.tick_params(axis='y', length=0, colors='#94a3b8', pad=6)
    ax_card2.text(1.020, 158, "kt", color='#94a3b8', fontsize=7.8, va='bottom', ha='left', transform=ax_card2.get_yaxis_transform(), zorder=6)
    ax_card2.grid(False)
    for s_name, spine in ax_card2.spines.items():
        if s_name == 'bottom':
            spine.set_color('#1e293b')
            spine.set_linewidth(1.0)
        else:
            spine.set_visible(False)

    # Card 3: Cumulative Probability Card
    card3_card_bottom, card3_card_h = 0.042, 0.293
    ax_card3_bg = draw_card_container(fig, [card_x, card3_card_bottom, card_w, card3_card_h])
    ax_card3_bg.text(0.055, 0.915, "Cumulative probability", fontsize=11.5, weight='bold', color='#ffffff', va='top', ha='left', zorder=2)

    end_run_disp = f"{end_run_dt.strftime('%b')} {end_run_dt.day}"
    ax_card3_bg.text(
        0.055, 0.810, f"Share of members reaching each intensity, through {end_run_disp}",
        fontsize=8.5, color='#94a3b8', va='center', ha='left', zorder=2,
    )

    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    inv_c3_bg = ax_card3_bg.transAxes.inverted()
    leg3_items = [("●", "#38bdf8", " TS", "#e2e8f0"), ("●", "#f59e0b", " Typhoon", "#e2e8f0"), ("●", "#ef4444", " Major", "#e2e8f0")]
    cur_rx = 0.945
    for sym, sym_col, lbl, lbl_col in reversed(leg3_items):
        t_lbl = ax_card3_bg.text(cur_rx, 0.905, lbl, fontsize=8.0, weight='medium', color=lbl_col, va='center', ha='right', zorder=2)
        w_lbl = inv_c3_bg.transform((t_lbl.get_window_extent(renderer=renderer).width, 0))[0] - inv_c3_bg.transform((0, 0))[0]
        sym_x = cur_rx - w_lbl - 0.004
        t_sym = ax_card3_bg.text(sym_x, 0.905, sym, fontsize=8.2, color=sym_col, va='center', ha='right', zorder=2)
        w_sym = inv_c3_bg.transform((t_sym.get_window_extent(renderer=renderer).width, 0))[0] - inv_c3_bg.transform((0, 0))[0]
        cur_rx = sym_x - w_sym - 0.025

    ax_card3 = fig.add_axes([card_x + card_w * 0.115, card3_card_bottom + card3_card_h * 0.130, card_w * 0.700, card3_card_h * 0.535])
    ax_card3.set_facecolor('none')

    eval_max_h = max(48.0, max_lead_h)
    eval_hours = np.arange(0.0, eval_max_h + 0.1, 6.0)
    if eval_hours[-1] < eval_max_h:
        eval_hours = np.append(eval_hours, eval_max_h)
    eval_dts = [init_dt + timedelta(hours=float(h)) for h in eval_hours]

    ts_by_lead = [(sum(1 for x in ts_hours if x <= h) / total_ensemble_members) * 100.0 for h in eval_hours]
    ty_by_lead = [(sum(1 for x in ty_hours if x <= h) / total_ensemble_members) * 100.0 for h in eval_hours]
    maj_by_lead = [(sum(1 for x in maj_hours if x <= h) / total_ensemble_members) * 100.0 for h in eval_hours]

    ax_card3.plot(eval_dts, ts_by_lead, color='#38bdf8', linewidth=2.6, zorder=4)
    ax_card3.plot(eval_dts, ty_by_lead, color='#f59e0b', linewidth=2.6, zorder=5)
    ax_card3.plot(eval_dts, maj_by_lead, color='#ef4444', linewidth=2.6, zorder=6)

    max_prob = max(ts_by_lead + ty_by_lead + maj_by_lead + [10.0])
    if max_prob <= 25:
        y_top, y_ticks, y_labels = 30, [0, 10, 20, 30], ['0%', '10%', '20%', '30%']
    elif max_prob <= 45:
        y_top, y_ticks, y_labels = 50, [0, 10, 20, 30, 40, 50], ['0%', '10%', '20%', '30%', '40%', '50%']
    elif max_prob <= 70:
        y_top, y_ticks, y_labels = 75, [0, 25, 50, 75], ['0%', '25%', '50%', '75%']
    else:
        y_top, y_ticks, y_labels = 100, [0, 25, 50, 75, 100], ['0%', '25%', '50%', '75%', '100%']

    ax_card3.set_ylim(-1, y_top + 4)
    ax_card3.set_yticks(y_ticks)
    ax_card3.set_yticklabels(y_labels, fontsize=7.6, color='#94a3b8')
    ax_card3.tick_params(axis='y', length=0, colors='#94a3b8', pad=6)

    for yval in y_ticks[1:]:
        ax_card3.axhline(yval, color='#1e293b', linewidth=0.8, zorder=1)

    ax_card3.set_xlim(eval_dts[0] - timedelta(hours=6), eval_dts[-1] + timedelta(hours=56))
    tick_step_days = compute_plume_day_interval(eval_dts[0], eval_dts[-1])
    x_tick_dts = []
    curr_t = eval_dts[-1]
    while curr_t >= eval_dts[0]:
        x_tick_dts.append(curr_t)
        curr_t -= timedelta(days=tick_step_days)
    x_tick_dts.sort()
    ax_card3.set_xticks(x_tick_dts)
    ax_card3.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, pos: f"{mdates.num2date(x).strftime('%b')} {mdates.num2date(x).day}"))
    ax_card3.tick_params(axis='x', labelsize=7.6, colors='#94a3b8', length=0, pad=5)

    ax_card3.grid(False)
    for s_name, spine in ax_card3.spines.items():
        if s_name == 'bottom':
            spine.set_color('#1e293b')
            spine.set_linewidth(1.0)
        else:
            spine.set_visible(False)

    dt_end = eval_dts[-1]
    ax_card3.plot(dt_end, ts_by_lead[-1], marker='o', markersize=5.8, color='#38bdf8', zorder=10)
    ax_card3.plot(dt_end, ty_by_lead[-1], marker='o', markersize=5.8, color='#f59e0b', zorder=11)
    if major_count > 0:
        ax_card3.plot(dt_end, maj_by_lead[-1], marker='o', markersize=5.8, color='#ef4444', zorder=12)

    labels_to_plot = [
        {'key': 'ts', 'val_str': ts_pct_str, 'name': 'TS', 'color': '#38bdf8', 'dot_y': ts_by_lead[-1]},
        {'key': 'ty', 'val_str': ty_pct_str, 'name': 'Typhoon', 'color': '#f59e0b', 'dot_y': ty_by_lead[-1]},
    ]
    if major_count > 0:
        labels_to_plot.append({'key': 'maj', 'val_str': maj_pct_str, 'name': 'Major', 'color': '#ef4444', 'dot_y': maj_by_lead[-1]})

    labels_to_plot.sort(key=lambda item: item['dot_y'], reverse=True)
    target_ys = _resolve_label_y_positions(labels_to_plot, y_top)

    dt_knee1 = dt_end + timedelta(hours=4.0)
    dt_knee2 = dt_end + timedelta(hours=11.0)
    dt_text = dt_end + timedelta(hours=14.0)

    for idx, item in enumerate(labels_to_plot):
        y_dot = item['dot_y']
        y_tgt = target_ys[idx]
        ax_card3.plot([dt_end, dt_knee1, dt_knee2, dt_text], [y_dot, y_dot, y_tgt, y_tgt], color=item['color'], linewidth=1.2, zorder=14)
        ax_card3.text(
            dt_text + timedelta(hours=2.0), y_tgt, f"{item['val_str']} {item['name']}",
            color=item['color'], fontsize=8.0, weight='bold', va='center', ha='left', zorder=15,
        )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    plt.savefig(output_path, dpi=200, bbox_inches='tight', pad_inches=0.15, facecolor='#090d14', edgecolor='none')
    plt.close()
    print(f"Broadcast-grade under-monitoring plot saved to: {output_path}")
    return {
        'region_name': region_name,
        'region_friendly': region_friendly,
        'is_cpac': (has_cpac or region_name == "CENTRAL PACIFIC / DATELINE"),
    }


def main():
    parser = argparse.ArgumentParser(description="Ensemble Under-Monitoring LPA / Invest Candidate Tracking System")
    parser.add_argument('--input', type=str, nargs='*', help="Input DAT, CSV, or ATCF files")
    parser.add_argument('--lpa-id', type=str, help="Specific LPA ID to plot (e.g. LPA01, MONITORING_LPA01)")
    parser.add_argument('--output-dir', type=str, default='public/assets', help="Directory to save generated plots")
    parser.add_argument('--color-by', type=str, default='wind', choices=['wind', 'pressure'], help="Parameter to color lines by")
    parser.add_argument('--min-members', type=int, default=5, help="Minimum ensemble members for a monitoring disturbance")
    parser.add_argument('--min-mean-members', type=int, default=25, help="Minimum ensemble members for consensus track")
    parser.add_argument('--min-wind', type=float, default=25.0, help="Minimum maximum wind in knots")
    parser.add_argument('--min-duration', type=float, default=36.0, help="Minimum duration in hours")
    parser.add_argument('--nursery-aggregation', action='store_true', default=True, help="Aggregate compatible nursery candidate clusters")
    parser.add_argument('--no-nursery-aggregation', action='store_false', dest='nursery_aggregation', help="Disable nursery aggregation")
    parser.add_argument('--nursery-dist', type=float, default=600.0, help="Maximum distance in km between genesis centers to aggregate")
    parser.add_argument('--nursery-gap-h', type=float, default=96.0, help="Maximum timing gap in lead hours between genesis times")
    parser.add_argument('--min-motion-disp', type=float, default=120.0, help="Minimum 48h displacement in km to evaluate heading compatibility")
    parser.add_argument('--max-member-overlap', type=float, default=0.20, help="Maximum member overlap ratio to allow merging")
    parser.add_argument('--show-genesis', action='store_true', default=False, help="Render genesis density contours on map")
    parser.add_argument('--skip-manifest', action='store_true', default=False, help="Skip updating spaghetti_manifest.json")
    args = parser.parse_args()

    input_files = args.input
    if not input_files:
        search_dir = resolve_data_path(('public', 'data'), script_file=__file__)
        input_files = []
        for prefix in ['wnv3_latest', 'fnv3_large_latest']:
            for ext in ['.dat', '.csv', '.enc']:
                candidate = os.path.join(search_dir, f"{prefix}{ext}")
                if os.path.exists(candidate):
                    input_files.append(candidate)
                    break

    if not input_files:
        print("No input files specified and no default datasets found in public/data.")
        return

    knack_storms = fetch_knack_active_storms()
    if knack_storms:
        knack_storms = [
            s for s in knack_storms
            if ((100.0 <= s['lon'] <= 180.0) or (-180.0 <= s['lon'] <= -140.0) or (180.0 <= s['lon'] <= 220.0)) and (0.0 <= s['lat'] <= 50.0)
        ]
    atcf_index_storms = load_atcf_storms_index(script_file=__file__)

    print(f"Processing under-monitoring disturbances from files: {input_files}")
    out_dir = resolve_output_dir(args.output_dir, script_file=__file__)
    latest_plotted_init = {}
    new_manifest_entries = []
    replace_scope_keys = set()

    for f_path in input_files:
        raw_df = load_track_file(f_path)
        if raw_df.empty:
            continue

        normalized_df = normalize_dataframe(raw_df)
        wp_df = filter_western_pacific(normalized_df)
        if wp_df.empty:
            continue

        too_old, latest_run_init, age_days = is_run_too_old(wp_df, max_age_days=5.0)
        if too_old:
            print(f"Skipping outdated file {f_path}: initialization {latest_run_init} is {age_days:.1f} days old.")
            continue

        model = detect_model_name(f_path)
        total_members = infer_total_members(file_path=f_path, model_name=model, df_normalized=normalized_df)
        eff_min_members = max(args.min_members, int(total_members * 0.015)) if total_members >= 500 else args.min_members
        eff_min_mean_members = max(args.min_mean_members, int(total_members * 0.05)) if total_members >= 500 else args.min_mean_members

        wp_df, _ = cluster_and_validate_lpas(
            wp_df,
            knack_storms,
            atcf_index_storms=atcf_index_storms,
            total_members=total_members,
            min_members=eff_min_members,
            min_wind_kt=args.min_wind,
            min_duration=args.min_duration,
            enable_nursery_aggregation=args.nursery_aggregation,
            max_nursery_dist=args.nursery_dist,
            max_nursery_gap_h=args.nursery_gap_h,
            min_motion_disp_km=args.min_motion_disp,
            max_member_overlap=args.max_member_overlap,
        )

        monitoring_df = wp_df[wp_df['storm_group'].str.startswith('monitoring_')].copy()
        if monitoring_df.empty:
            print(f"No under-monitoring LPA candidate clusters found in: {f_path}")
            continue

        storm_groups = monitoring_df['storm_group'].dropna().unique()
        print(f"Found under-monitoring groups {storm_groups} in {f_path}")
        model_clean = model.replace(' ', '_').lower()

        for sg_id in storm_groups:
            group_df = monitoring_df[monitoring_df['storm_group'] == sg_id]
            rep_track_id = str(group_df['rep_track_id'].dropna().iloc[0])

            init_time_raw = group_df['init_time'].dropna().iloc[0] if not group_df['init_time'].isna().all() else 'Unknown'
            try:
                current_init_dt = pd.to_datetime(init_time_raw)
                ymd = current_init_dt.strftime('%Y%m%d')
                cycle_str = f"{(current_init_dt.hour // 6) * 6:02d}Z"
            except (ValueError, TypeError):
                current_init_dt = datetime.min
                ymd = datetime.now(timezone.utc).strftime('%Y%m%d')
                cycle_str = "00Z"

            if not args.lpa_id:
                replace_scope_keys.add((ymd, cycle_str, model_clean))

            wp_id = f"MONITORING_{rep_track_id.upper()}"
            num_w_id = rep_track_id.upper()

            if args.lpa_id:
                s_target = args.lpa_id.upper().strip()
                if s_target not in (wp_id, num_w_id, rep_track_id.upper()):
                    continue

            primary_filename = f"{wp_id}_{ymd}_{cycle_str}_{model_clean}.png"
            out_file = os.path.join(out_dir, primary_filename)

            if out_file in latest_plotted_init and current_init_dt < latest_plotted_init[out_file]:
                continue

            res_meta = plot_monitoring_tracks(
                monitoring_df,
                model,
                sg_id,
                out_file,
                color_by=args.color_by,
                min_mean_members=eff_min_mean_members,
                total_ensemble_members=total_members,
                knack_storms=knack_storms,
                atcf_index_storms=atcf_index_storms,
                show_genesis=args.show_genesis,
            )
            latest_plotted_init[out_file] = current_init_dt

            if not os.path.exists(out_file) or res_meta is None:
                continue

            unique_key = f"{wp_id}_{ymd}T{cycle_str}"
            new_manifest_entries.append({
                'storm_id': wp_id,
                'atcf_id': num_w_id,
                'init_date': ymd,
                'cycle': cycle_str,
                'model': model_clean,
                'unique_key': unique_key,
                'filename': primary_filename,
                'alt_filename': primary_filename,
                'is_monitoring': True,
                'region': res_meta.get('region_name', ''),
                'basin': 'CP' if res_meta.get('is_cpac', False) else 'WP',
                'timestamp': datetime.now(timezone.utc).isoformat(),
            })

    if not args.skip_manifest and (new_manifest_entries or replace_scope_keys):
        update_and_prune_spaghetti_manifest(
            new_manifest_entries,
            output_dir=out_dir,
            script_file=__file__,
            max_runs_retained=8,
            replace_scope_keys=replace_scope_keys if not args.lpa_id else None,
        )


if __name__ == '__main__':
    main()
