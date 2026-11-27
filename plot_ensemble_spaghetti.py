import argparse
from collections import deque
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

from spaghetti_common import (
    INTENSITY_BANDS,
    PRESSURE_BOUNDS,
    PRESSURE_COLORS,
    WIND_BOUNDS,
    WIND_COLORS,
    check_single_track_landfall,
    compute_clean_mean_track_df,
    compute_ph_landfalls,
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
    get_ph_municipalities_tree,
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


def run_hdbscan(distance_matrix, min_cluster_size):
    """Iterative HDBSCAN fallback clustering used when Knack storm track matching needs grouping."""
    n = len(distance_matrix)
    if n == 0:
        return []

    k = min(n - 1, max(1, min_cluster_size - 1))
    core_dist = [0.0] * n
    for i in range(n):
        core_dist[i] = sorted(distance_matrix[i])[k]

    in_mst = [False] * n
    min_dist = [float('inf')] * n
    parent = [-1] * n
    min_dist[0] = 0.0
    edges = []

    for _ in range(n):
        u = -1
        best = float('inf')
        for i in range(n):
            if not in_mst[i] and min_dist[i] < best:
                best = min_dist[i]
                u = i
        if u == -1:
            break
        in_mst[u] = True
        if parent[u] != -1:
            edges.append({'u': parent[u], 'v': u, 'weight': best})
        for v in range(n):
            if not in_mst[v]:
                weight = max(core_dist[u], core_dist[v], distance_matrix[u][v])
                if weight < min_dist[v]:
                    min_dist[v] = weight
                    parent[v] = u

    edges.sort(key=lambda x: x['weight'])
    next_node_id = n
    uf_parent = list(range(n * 2))
    nodes = [
        {
            'id': i, 'left': None, 'right': None, 'weight': 0.0,
            'birth': 0.0, 'death': float('inf'), 'points': [i] if i < n else [],
        }
        for i in range(n * 2)
    ]

    def find_uf(idx):
        root = idx
        while uf_parent[root] != root:
            root = uf_parent[root]
        curr = idx
        while curr != root:
            nxt = uf_parent[curr]
            uf_parent[curr] = root
            curr = nxt
        return root

    for edge in edges:
        root_u = find_uf(edge['u'])
        root_v = find_uf(edge['v'])
        if root_u != root_v:
            new_id = next_node_id
            next_node_id += 1
            uf_parent[root_u] = new_id
            uf_parent[root_v] = new_id
            nodes[new_id]['left'] = nodes[root_u]
            nodes[new_id]['right'] = nodes[root_v]
            nodes[new_id]['weight'] = edge['weight']
            nodes[new_id]['points'] = nodes[root_u]['points'] + nodes[root_v]['points']
            nodes[root_u]['death'] = edge['weight']
            nodes[root_v]['death'] = edge['weight']

    root_node_id = next_node_id - 1
    if root_node_id < n:
        return [0] * n

    next_cluster_id = 1
    condensed_nodes = {
        0: {
            'id': 0, 'parent': None, 'birth': 0.0, 'death': nodes[root_node_id]['weight'],
            'points': nodes[root_node_id]['points'], 'stability': 0.0, 'selected': False,
        }
    }
    condense_stack = [(root_node_id, 0)]
    while condense_stack:
        node_id, parent_cluster_id = condense_stack.pop()
        node = nodes[node_id]
        if node['left'] is None and node['right'] is None:
            continue
        left, right = node['left'], node['right']
        left_count, right_count = len(left['points']), len(right['points'])
        if left_count >= min_cluster_size and right_count >= min_cluster_size:
            for child_node in (left, right):
                cid = next_cluster_id
                next_cluster_id += 1
                condensed_nodes[cid] = {
                    'id': cid, 'parent': parent_cluster_id, 'birth': node['weight'],
                    'death': child_node['death'], 'points': child_node['points'],
                    'stability': 0.0, 'selected': False,
                }
                condense_stack.append((child_node['id'], cid))
        elif left_count >= min_cluster_size:
            condense_stack.append((left['id'], parent_cluster_id))
        elif right_count >= min_cluster_size:
            condense_stack.append((right['id'], parent_cluster_id))

    for cnode in condensed_nodes.values():
        lambda_birth = 1.0 / max(cnode['birth'], 0.0001)
        sum_stability = 0.0
        for pt in cnode['points']:
            death_weight = cnode['death']
            curr = nodes[pt]
            while curr and curr['death'] < cnode['death']:
                death_weight = curr['death']
                curr = nodes[uf_parent[curr['id']]]
            lambda_death = 1.0 / max(death_weight, 0.0001)
            sum_stability += max(0.0, lambda_death - lambda_birth)
        cnode['stability'] = sum_stability

    subtree_stability = {}
    for cid in sorted(condensed_nodes.keys(), reverse=True):
        cnode = condensed_nodes[cid]
        children = [cn for cn in condensed_nodes.values() if cn['parent'] == cid]
        child_stability_sum = sum(subtree_stability.get(ch['id'], 0.0) for ch in children)
        if child_stability_sum > cnode['stability']:
            subtree_stability[cid] = child_stability_sum
            cnode['selected'] = False
        else:
            subtree_stability[cid] = cnode['stability']
            cnode['selected'] = True
            bfs_queue = deque(children)
            while bfs_queue:
                qnode = bfs_queue.popleft()
                qnode['selected'] = False
                bfs_queue.extend([cn for cn in condensed_nodes.values() if cn['parent'] == qnode['id']])

    labels = [-1] * n
    for cid, cnode in condensed_nodes.items():
        if cnode['selected']:
            lbl = cid if cid != 0 else 1
            for pt in cnode['points']:
                labels[pt] = lbl
    return labels


def filter_tracks_near_active_storms(df, knack_storms, max_dist_deg=8.0):
    """
    Filters tracks to only those passing within `max_dist_deg` of active Knack storms
    during their early forecast stages (lead_time_hours <= 60). Handles antimeridian wrap.
    """
    if df.empty or not knack_storms:
        return pd.DataFrame(columns=df.columns)

    early_df = df[df['lead_time_hours'] <= 60.0].dropna(subset=['lat', 'lon'])
    if early_df.empty:
        return pd.DataFrame(columns=df.columns)

    near_mask = pd.Series(False, index=early_df.index)
    for k_storm in knack_storms:
        k_lat, k_lon = k_storm.get('lat'), k_storm.get('lon')
        if k_lat is None or k_lon is None or np.isnan(k_lat) or np.isnan(k_lon):
            continue
        d_lat = early_df['lat'] - k_lat
        cos_lat = np.cos(np.radians((early_df['lat'] + k_lat) / 2.0))
        raw_d_lon = (early_df['lon'] - k_lon + 180.0) % 360.0 - 180.0
        dist = np.sqrt(d_lat ** 2 + (raw_d_lon * cos_lat) ** 2)
        near_mask |= (dist <= max_dist_deg)

    matching_groups = early_df[near_mask][['track_id', 'sample']].drop_duplicates()
    if matching_groups.empty:
        return pd.DataFrame(columns=df.columns)

    matching_keys = set(matching_groups['track_id'].astype(str) + "_" + matching_groups['sample'].astype(str))
    df_keys = df['track_id'].astype(str) + "_" + df['sample'].astype(str)
    return df[df_keys.isin(matching_keys)].copy()


def get_storm_display_name(track_id):
    """Formats ATCF identifiers such as 'WP112026', '90W', or '04C' to canonical display titles."""
    track_str = str(track_id).upper().strip()

    def is_invest_num(s):
        m = re.search(r'\d{2}', s)
        return bool(m and 90 <= int(m.group(0)) <= 99)

    is_invest = 'INVEST' in track_str or is_invest_num(track_str)
    num, letter = None, "W"

    m = re.match(r'^([A-Z]{2})(\d{2})\d{4}$', track_str)
    if m:
        num = m.group(2)
        letter = 'W' if m.group(1) == 'WP' else ('C' if m.group(1) == 'CP' else m.group(1)[0])
    elif (m := re.match(r'^(\d{2})([A-Z])$', track_str)):
        num, letter = m.group(1), m.group(2)
    elif (m := re.match(r'^([A-Z]{2})(\d{2})$', track_str)):
        num = m.group(2)
        letter = 'W' if m.group(1) == 'WP' else ('C' if m.group(1) == 'CP' else m.group(1)[0])
    elif (m := re.match(r'^([A-Z])(\d{2})$', track_str)):
        letter, num = m.group(1), m.group(2)
    elif (m := re.match(r'^(\d{2})$', track_str)):
        num = m.group(1)

    if num:
        return f"{num}{letter} INVEST" if is_invest else f"{num}{letter} STORM"
    return track_str


def cluster_genesis_locations(df, dist_threshold=6.0):
    """Groups tracks within the same init_time using HDBSCAN over pairwise track distances."""
    if df.empty:
        return df

    df = df.copy()
    df['storm_group'] = 'UNKNOWN'
    df['storm_group_name'] = 'UNKNOWN'
    df['rep_track_id'] = 'UNKNOWN'

    for init_val in df['init_time'].unique():
        init_df = df[df['init_time'] == init_val]
        tracks = []
        for (t_id, s_val), track_points in init_df.groupby(['track_id', 'sample']):
            track_points = track_points.sort_values('lead_time_hours')
            points_dict = {
                float(row['lead_time_hours']): (float(row['lat']), float(row['lon']))
                for _, row in track_points.iterrows()
                if not np.isnan(row['lat']) and not np.isnan(row['lon'])
            }
            if points_dict:
                tracks.append({
                    'track_id': t_id, 'sample': s_val,
                    'points_dict': points_dict, 'points_index': track_points.index.tolist(),
                })

        n_tracks = len(tracks)
        if n_tracks == 0:
            continue

        distance_matrix = [[0.0] * n_tracks for _ in range(n_tracks)]
        start_coords = [t['points_dict'][min(t['points_dict'].keys())] for t in tracks]

        for i in range(n_tracks):
            for j in range(i + 1, n_tracks):
                if haversine_km(start_coords[i][0], start_coords[i][1], start_coords[j][0], start_coords[j][1]) > 600.0:
                    dist = 5000.0
                else:
                    overlap = set(tracks[i]['points_dict'].keys()).intersection(tracks[j]['points_dict'].keys())
                    if not overlap:
                        dist = 5000.0
                    else:
                        dist = sum(
                            haversine_km(
                                tracks[i]['points_dict'][h][0], tracks[i]['points_dict'][h][1],
                                tracks[j]['points_dict'][h][0], tracks[j]['points_dict'][h][1],
                            )
                            for h in overlap
                        ) / len(overlap)
                distance_matrix[i][j] = dist
                distance_matrix[j][i] = dist

        num_members = len(init_df['sample'].unique())
        if num_members in (63, 64):
            num_members = 64
        elif num_members in (999, 1000):
            num_members = 1000
        min_cluster_size = max(4, int(round(num_members * (0.03 if num_members > 100 else 0.08))))
        min_cluster_size = min(n_tracks, max(2, min_cluster_size))

        labels = run_hdbscan(distance_matrix, min_cluster_size)
        next_label = (max(labels) + 1) if labels else 1
        for idx in range(n_tracks):
            if labels[idx] == -1:
                labels[idx] = next_label
                next_label += 1

        cluster_tracks = {}
        for idx, lbl in enumerate(labels):
            cluster_tracks.setdefault(lbl, []).append(tracks[idx])

        for lbl, cl_tracks in cluster_tracks.items():
            group_id = f"group_{str(init_val).replace(':', '').replace(' ', '_')}_{lbl}"
            track_counts = {}
            for t in cl_tracks:
                track_counts[t['track_id']] = track_counts.get(t['track_id'], 0) + 1

            best_tid = cl_tracks[0]['track_id']
            max_score = -1
            for tid, count in track_counts.items():
                is_inv = False
                m_wp = re.search(r'(?:WP|CP)(\d{2})', str(tid).upper())
                if m_wp and 90 <= int(m_wp.group(1)) <= 99:
                    is_inv = True
                elif str(tid).isdigit() and 90 <= int(tid) <= 99:
                    is_inv = True
                score = count + (0 if is_inv else 1000)
                if score > max_score:
                    max_score = score
                    best_tid = tid

            group_name = get_storm_display_name(best_tid)
            for t in cl_tracks:
                df.loc[t['points_index'], 'storm_group'] = str(group_id)
                df.loc[t['points_index'], 'storm_group_name'] = str(group_name)
                df.loc[t['points_index'], 'rep_track_id'] = str(best_tid)

    return df


def find_control_track_for_storm(
    df_storm,
    df_model,
    model_name,
    storm_name,
    atcf_pos=None,
    color_by='pressure',
    df_paired=None,
    storm_group_id='',
    rep_track_id='',
):
    """
    Identifies the official control track for the storm cluster:
      1. GDM models: strictly uses matching-init_time tracks from df_paired (sample == -1).
      2. ECMWF models: uses forecast_type == 0 / is_control == True / sample == 51/52 within 600 km.
    Returns (control_df, control_indices, has_control).
    """
    empty_df = pd.DataFrame(columns=['lead_time_hours', 'lat', 'lon', 'pressure', 'wind'])
    ref_lat, ref_lon = (atcf_pos[0], atcf_pos[1]) if atcf_pos else (None, None)
    if ref_lat is None:
        first_valid = df_storm.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
        if not first_valid.empty:
            ref_lat, ref_lon = float(first_valid.iloc[0]['lat']), float(first_valid.iloc[0]['lon'])

    is_gdm = any(k in model_name.lower() for k in ['wnv3', 'wnc', 'fnv3', 'oper', 'large', 'gdm'])
    if is_gdm:
        if df_paired is None or df_paired.empty:
            print(f"No paired dataset available for {storm_name} in {model_name}; using calculated ensemble mean.")
            return empty_df, pd.Index([]), False

        paired_candidates = df_paired.copy()
        if 'sample' in paired_candidates.columns:
            p_sample = paired_candidates[paired_candidates['sample'] == -1]
            if not p_sample.empty:
                paired_candidates = p_sample

        # Verify paired init_time matches storm init_time within +-1h so stale paired runs are never mixed in
        if 'init_time' in df_storm.columns and 'init_time' in paired_candidates.columns:
            storm_inits = pd.to_datetime(df_storm['init_time'], errors='coerce').dropna()
            paired_inits = pd.to_datetime(paired_candidates['init_time'], errors='coerce')
            if not storm_inits.empty and not paired_inits.isna().all():
                target_init = storm_inits.iloc[0]
                if target_init.tzinfo is not None:
                    target_init = target_init.tz_convert(timezone.utc).tz_localize(None)
                p_norm = paired_inits.apply(
                    lambda dt: dt.tz_convert(timezone.utc).tz_localize(None) if pd.notna(dt) and dt.tzinfo is not None else dt
                )
                same_init_mask = (p_norm - target_init).abs() <= pd.Timedelta(hours=1)
                paired_candidates = paired_candidates[same_init_mask]
                if paired_candidates.empty:
                    print(f"Paired dataset init_time does not match {storm_name} ({target_init}); falling back to computed ensemble mean.")
                    return empty_df, pd.Index([]), False

        storm_num = None
        for id_cand in (rep_track_id, storm_group_id, storm_name):
            m_num = re.search(r'(?:WP|CP|EP|AL|IO|SH)?(\d{2})(?:[WCEABSP])?', str(id_cand or '').upper())
            if m_num:
                storm_num = m_num.group(1)
                break

        best_paired_track = None
        if storm_num:
            id_pat = re.compile(rf'(?:WP|CP|EP|AL|IO|SH){storm_num}\b|\b{storm_num}[WCEABSP]\b|^{storm_num}$', re.I)
            for tid, t_df in paired_candidates.groupby('track_id'):
                t_df = t_df.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
                if len(t_df) >= 2 and id_pat.search(str(tid).upper()):
                    best_paired_track = t_df
                    break

        if best_paired_track is None and ref_lat is not None and ref_lon is not None:
            best_paired_dist = float('inf')
            for _, t_df in paired_candidates.groupby('track_id'):
                t_df = t_df.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
                if len(t_df) < 2:
                    continue
                t_early = t_df[t_df['lead_time_hours'] <= 48.0]
                if t_early.empty:
                    t_early = t_df.head(1)
                min_d = min(haversine_km(r['lat'], r['lon'], ref_lat, ref_lon) for _, r in t_early.iterrows())
                if min_d < 600.0 and min_d < best_paired_dist:
                    best_paired_dist = min_d
                    best_paired_track = t_df

        if best_paired_track is not None and len(best_paired_track) >= 2:
            cols = ['lead_time_hours', 'lat', 'lon', 'pressure', 'wind']
            res_df = best_paired_track[cols].sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
            tid_found = best_paired_track['track_id'].iloc[0]
            print(f"Using official {model_name} paired control track '{tid_found}' ({len(res_df)} points) for {storm_name}")
            return res_df, pd.Index([]), True

        print(f"No paired track found for {storm_name} in {model_name} paired dataset; using calculated ensemble mean.")
        return empty_df, pd.Index([]), False

    is_ecmwf = any(k in model_name.lower() for k in ['ecmwf', 'ifs', 'aifs'])
    if is_ecmwf:
        ctrl_mask = pd.Series(False, index=df_storm.index)
        if 'is_control' in df_storm.columns:
            ctrl_mask |= (df_storm['is_control'] == True)
        if 'forecast_type' in df_storm.columns:
            ctrl_mask |= (df_storm['forecast_type'] == 0)
        if 'sample' in df_storm.columns:
            if 'aifs' in model_name.lower():
                if (df_storm['sample'] == 52).any():
                    ctrl_mask |= (df_storm['sample'] == 52)
                elif (df_storm['sample'] == 51).any() and not ctrl_mask.any():
                    ctrl_mask |= (df_storm['sample'] == 51)
            elif 'ifs' in model_name.lower() and (df_storm['sample'] == 51).any():
                ctrl_mask |= (df_storm['sample'] == 51)

        ctrl_candidates = df_storm[ctrl_mask].copy()
        if not ctrl_candidates.empty and ref_lat is not None and ref_lon is not None:
            best_ctrl, best_dist = None, float('inf')
            for _, t_df in ctrl_candidates.groupby('track_id'):
                t_df = t_df.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
                if len(t_df) < 2:
                    continue
                min_d = min(haversine_km(r['lat'], r['lon'], ref_lat, ref_lon) for _, r in t_df.iterrows())
                if min_d < 600.0 and min_d < best_dist:
                    best_dist, best_ctrl = min_d, t_df
            if best_ctrl is not None and len(best_ctrl) >= 2:
                cols = ['lead_time_hours', 'lat', 'lon', 'pressure', 'wind']
                res_df = best_ctrl[cols].sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
                return res_df, best_ctrl.index, True

    return empty_df, pd.Index([]), False


def clean_storm_ensemble_tracks(
    df_storm,
    df_model,
    model_name,
    storm_name,
    atcf_pos=None,
    df_paired=None,
    df_mean=None,
    ctrl_indices=None,
    has_control=False,
):
    """
    Filters extraneous disturbance tracks using cosine-accurate haversine proximity against
    the control/early median track and strictly keeps at most one best track per member.
    """
    if df_storm.empty:
        return df_storm

    ref_by_h = {}
    if has_control and df_mean is not None and not df_mean.empty:
        for _, r in df_mean.iterrows():
            ref_by_h[float(r['lead_time_hours'])] = (float(r['lat']), float(r['lon']))
    else:
        early_tracks = []
        for (_, _), pts in df_storm.groupby(['track_id', 'sample']):
            pts = pts.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
            if not pts.empty and pts.iloc[0]['lead_time_hours'] <= 36.0:
                if atcf_pos is not None:
                    d_atcf = haversine_km(
                        float(pts.iloc[0]['lat']), float(pts.iloc[0]['lon']),
                        float(atcf_pos[0]), float(atcf_pos[1]),
                    )
                    if d_atcf > 880.0:
                        continue
                early_tracks.append(pts)
        if early_tracks:
            df_early = pd.concat(early_tracks)
            for h, grp in df_early.groupby('lead_time_hours'):
                c_lat, c_lon = mean_geo_center(grp['lat'].tolist(), grp['lon'].tolist())
                ref_by_h[float(h)] = (c_lat, c_lon)

    ctrl_set = set(ctrl_indices.tolist() if hasattr(ctrl_indices, 'tolist') else (list(ctrl_indices) if ctrl_indices is not None else []))
    candidates = []

    for (tid, sample), pts in df_storm.groupby(['track_id', 'sample']):
        if has_control and ctrl_set and any(idx in ctrl_set for idx in pts.index):
            continue

        pts = pts.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
        if len(pts) < 2:
            continue

        first = pts.iloc[0]
        lead_start = float(first['lead_time_hours'])
        if lead_start > 72.0:
            continue

        rlat, rlon = None, None
        if lead_start in ref_by_h:
            rlat, rlon = ref_by_h[lead_start]
        elif ref_by_h:
            closest_h = min(ref_by_h.keys(), key=lambda h: abs(h - lead_start))
            if abs(closest_h - lead_start) <= 18.0:
                rlat, rlon = ref_by_h[closest_h]
        if rlat is None and atcf_pos is not None:
            rlat, rlon = float(atcf_pos[0]), float(atcf_pos[1])
        elif rlat is None:
            rlat, rlon = float(first['lat']), float(first['lon'])

        init_dist_km = haversine_km(float(first['lat']), float(first['lon']), rlat, rlon)
        if init_dist_km > 720.0:
            continue

        early_dists_km = []
        for _, r in pts.iterrows():
            h = float(r['lead_time_hours'])
            if h <= 60.0 and h in ref_by_h:
                clat, clon = ref_by_h[h]
                early_dists_km.append(haversine_km(float(r['lat']), float(r['lon']), clat, clon))

        if early_dists_km and max(early_dists_km) > 780.0:
            continue

        mean_early_km = (sum(early_dists_km) / len(early_dists_km)) if early_dists_km else init_dist_km
        candidates.append({
            'track_id': tid,
            'sample': sample,
            'score': init_dist_km + mean_early_km,
            'indices': pts.index.tolist(),
        })

    if not candidates:
        if has_control and ctrl_set:
            return df_storm.loc[df_storm.index.intersection(list(ctrl_set))].copy()
        return df_storm.iloc[0:0].copy()

    cand_df = pd.DataFrame(candidates)
    best_cand = cand_df.sort_values('score').groupby('sample').first().reset_index()

    valid_indices = []
    for idx_list in best_cand['indices']:
        valid_indices.extend(idx_list)
    if has_control and ctrl_set:
        valid_indices.extend(ctrl_set)

    return df_storm.loc[df_storm.index.intersection(valid_indices)].copy()


def _truncate_place_label(place_name, max_chars=24):
    """Shortens long province + control municipality labels so they do not collide with percentages."""
    if len(place_name) <= max_chars:
        return place_name
    return place_name[: max_chars - 1].rstrip() + "…"


def _place_non_overlapping_milestone_labels(ax_map, df_mean, has_cpac, color_by):
    """
    Draws 24h milestone dots and intelligently offsets their text badges around the track direction
    while rejecting positions that collide with previously placed label centers.
    """
    pts = []
    for _, row in df_mean.iterrows():
        mx, my = float(row['lon']), float(row['lat'])
        if np.isnan(mx) or np.isnan(my):
            continue
        pts.append((int(row['lead_time_hours']), unwrap_lon_for_cpac(mx, has_cpac), my, row['wind'], row['pressure']))

    placed_boxes = []
    last_dot = None
    for idx, (hour, mx, my, mw, mp) in enumerate(pts):
        if hour <= 0 or hour % 24 != 0:
            continue
        if last_dot is not None:
            if math.hypot(mx - last_dot[0], my - last_dot[1]) < 1.8:
                continue
        last_dot = (mx, my)

        ax_map.plot(
            mx, my, marker='o', markerfacecolor='#ffffff', markeredgecolor='#090d14',
            markersize=5.0, markeredgewidth=1.5, zorder=9, transform=ccrs.PlateCarree(),
        )

        if color_by == 'pressure':
            val_str = f"{int(round(mp))}mb\n+{hour}h" if not np.isnan(mp) else f"+{hour}h"
        else:
            val_str = f"{int(round(mw))}kt\n+{hour}h" if not np.isnan(mw) else f"+{hour}h"

        # Estimate local track tangent to pick perpendicular candidate offsets first
        if idx > 0:
            dx_t = mx - pts[idx - 1][1]
            dy_t = my - pts[idx - 1][2]
        elif idx + 1 < len(pts):
            dx_t = pts[idx + 1][1] - mx
            dy_t = pts[idx + 1][2] - my
        else:
            dx_t, dy_t = -1.0, 0.5

        norm_t = math.hypot(dx_t, dy_t) or 1.0
        px, py = -dy_t / norm_t, dx_t / norm_t  # perpendicular unit vector
        cand_offsets = [
            (px * 0.9 + 0.25, py * 0.9 + 0.35, 'left' if px >= -0.2 else 'right', 'bottom' if py >= -0.2 else 'top'),
            (-px * 0.9 + 0.25, -py * 0.9 - 0.35, 'left' if -px >= -0.2 else 'right', 'top' if -py <= 0.2 else 'bottom'),
            (0.45, 0.70, 'left', 'bottom'),
            (-0.45, -0.70, 'right', 'top'),
            (-0.45, 0.70, 'right', 'bottom'),
            (0.45, -0.70, 'left', 'top'),
            (0.0, 1.35, 'center', 'bottom'),
            (0.0, -1.35, 'center', 'top'),
        ]

        def _est_box(lx, ly, ha, va, w=3.6, h=1.8):
            x0 = lx if ha == 'left' else (lx - w if ha == 'right' else lx - w * 0.5)
            y0 = ly if va == 'bottom' else (ly - h if va == 'top' else ly - h * 0.5)
            return (x0, x0 + w, y0, y0 + h)

        def _boxes_overlap(b1, b2):
            return not (b1[1] < b2[0] or b1[0] > b2[1] or b1[3] < b2[2] or b1[2] > b2[3])

        chosen = cand_offsets[0]
        for ox, oy, ha, va in cand_offsets:
            lx, ly = mx + ox, my + oy
            cand_box = _est_box(lx, ly, ha, va)
            if not any(_boxes_overlap(cand_box, pb) for pb in placed_boxes):
                chosen = (ox, oy, ha, va)
                break

        ox, oy, ha, va = chosen
        lx, ly = mx + ox, my + oy
        placed_boxes.append(_est_box(lx, ly, ha, va))

        t_node = ax_map.text(
            lx, ly, val_str, color='#f8fafc', weight='bold', fontsize=7.4,
            ha=ha, va=va, transform=ccrs.PlateCarree(), zorder=10,
        )
        t_node.set_path_effects([path_effects.withStroke(linewidth=2.4, foreground='#090d14')])


def _render_plume_card(
    fig,
    card_rect,
    title,
    subtitle_prefix,
    subtitle_highlight,
    model_name,
    is_pressure,
    deduped_track_dfs,
    lead_stats,
    df_mean,
    has_control,
    init_dt,
    peak_entry,
    y_min,
    y_max,
    y_ticks,
    unit_lbl,
):
    """Renders either Card 2 (wind intensity plume) or Card 3 (MSLP plume) inside a rounded dark card."""
    card_x, card_b, card_w, card_h = card_rect
    ax_bg = draw_card_container(fig, card_rect)

    ax_bg.text(0.055, 0.922, title, fontsize=11.0, weight='bold', color='#ffffff', va='top', ha='left', zorder=2)

    is_ai_model = any(k in model_name.lower() for k in ['wnc', 'wnv3', 'fnv3', 'aifs', 'large', 'ai'])
    if is_ai_model:
        caution_txt = "AI pressure · treat with caution" if is_pressure else "AI intensity · treat with caution"
        ax_bg.text(
            0.945, 0.892, caution_txt, fontsize=7.5, weight='medium', color='#f59e0b',
            va='center', ha='right', zorder=2,
            bbox=dict(boxstyle='round,pad=0.40,rounding_size=0.55', facecolor='#14110b', edgecolor='#f59e0b', linewidth=0.95),
        )

    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    inv_bg = ax_bg.transAxes.inverted()

    t_sub1 = ax_bg.text(0.055, 0.812, subtitle_prefix, fontsize=8.3, color='#94a3b8', va='center', ha='left', zorder=2)
    w_s1 = inv_bg.transform((t_sub1.get_window_extent(renderer=renderer).width, 0))[0] - inv_bg.transform((0, 0))[0]
    ax_bg.text(0.055 + w_s1, 0.812, subtitle_highlight, fontsize=8.3, weight='bold', color='#fbbf24', va='center', ha='left', zorder=2)

    leg_items = [
        ("—", "#ffffff", " Median", "#ffffff"),
        ("---", "#cbd5e1", " Mean", "#cbd5e1"),
        ("■", "#38bdf8", " 25–75%", "#94a3b8"),
        ("■", "#0284c7", " 10–90%", "#94a3b8"),
    ]
    if has_control:
        leg_items.append(("—", "#facc15", " Control", "#facc15"))

    cur_lx = 0.055
    for sym, sym_col, lbl, lbl_col in leg_items:
        t_sym = ax_bg.text(cur_lx, 0.692, sym, fontsize=7.8, weight='heavy', color=sym_col, va='center', ha='left', zorder=2)
        w_sym = inv_bg.transform((t_sym.get_window_extent(renderer=renderer).width, 0))[0] - inv_bg.transform((0, 0))[0]
        cur_lx += w_sym + 0.004
        t_lbl = ax_bg.text(cur_lx, 0.692, lbl, fontsize=7.6, weight='semibold', color=lbl_col, va='center', ha='left', zorder=2)
        w_lbl = inv_bg.transform((t_lbl.get_window_extent(renderer=renderer).width, 0))[0] - inv_bg.transform((0, 0))[0]
        cur_lx += w_lbl + 0.022

    ax_plot = fig.add_axes([card_x + card_w * 0.045, card_b + card_h * 0.120, card_w * 0.870, card_h * 0.510])
    ax_plot.set_facecolor('none')

    if not is_pressure:
        for c_label, c_low, c_high, c_bg, c_alpha, c_txt in INTENSITY_BANDS:
            ax_plot.axhspan(c_low, c_high, facecolor=c_bg, alpha=c_alpha, edgecolor='none', zorder=1)
            t_band = ax_plot.text(
                0.015, (c_low + c_high) / 2.0, c_label,
                color=c_txt, fontsize=7.4, weight='bold', va='center', ha='left',
                transform=ax_plot.get_yaxis_transform(), zorder=8,
            )
            t_band.set_path_effects([path_effects.withStroke(linewidth=2.3, foreground='#0b111d')])
    else:
        for yval in y_ticks:
            ax_plot.axhline(yval, color='#1e293b', linewidth=0.7, zorder=1)

    if lead_stats:
        ls_dts = [s['dt'] for s in lead_stats]
        k_med = 'p_median' if is_pressure else 'median'
        k_mean = 'p_mean' if is_pressure else 'mean'
        k_p10 = 'p_p10' if is_pressure else 'p10'
        k_p25 = 'p_p25' if is_pressure else 'p25'
        k_p75 = 'p_p75' if is_pressure else 'p75'
        k_p90 = 'p_p90' if is_pressure else 'p90'

        for tdf in deduped_track_dfs:
            sub = tdf.dropna(subset=['pressure' if is_pressure else 'wind', 'lead_time_hours'])
            if is_pressure:
                sub = sub[(sub['pressure'] > 800.0) & (sub['pressure'] < 1050.0)]
            if not sub.empty:
                tdf_dts = [init_dt + timedelta(hours=float(h)) for h in sub['lead_time_hours']]
                ax_plot.plot(tdf_dts, sub['pressure' if is_pressure else 'wind'], color='#94a3b8', alpha=0.08, linewidth=0.7, zorder=2)

        ax_plot.fill_between(ls_dts, [s[k_p10] for s in lead_stats], [s[k_p90] for s in lead_stats], color='#0284c7', alpha=0.22, zorder=3)
        ax_plot.fill_between(ls_dts, [s[k_p25] for s in lead_stats], [s[k_p75] for s in lead_stats], color='#38bdf8', alpha=0.38, zorder=3)
        ax_plot.plot(ls_dts, [s[k_mean] for s in lead_stats], color='#cbd5e1', linestyle='--', linewidth=1.7, zorder=5)
        ax_plot.plot(ls_dts, [s[k_med] for s in lead_stats], color='#ffffff', linewidth=2.6, zorder=5)

        if has_control and not df_mean.empty:
            col_c = 'pressure' if is_pressure else 'wind'
            c_sub = df_mean.dropna(subset=[col_c, 'lead_time_hours'])
            if is_pressure:
                c_sub = c_sub[(c_sub['pressure'] > 800.0) & (c_sub['pressure'] < 1050.0)]
            if not c_sub.empty:
                ctrl_dts = [init_dt + timedelta(hours=float(h)) for h in c_sub['lead_time_hours']]
                ax_plot.plot(ctrl_dts, c_sub[col_c], color='#facc15', linewidth=2.0, zorder=6)

        if peak_entry is not None:
            pv = peak_entry[k_med]
            ax_plot.plot(
                peak_entry['dt'], pv, marker='o', markersize=6.2,
                markerfacecolor='#ffffff', markeredgecolor='#000000', markeredgewidth=1.7, zorder=10,
            )
            badge_txt = f"{int(round(pv))} hPa" if is_pressure else f"{int(round(pv))} kt"
            ax_plot.annotate(
                badge_txt,
                xy=(peak_entry['dt'], pv),
                xytext=(8, -12 if is_pressure else 4), textcoords='offset points',
                fontsize=7.8, weight='bold', color='#ffffff',
                bbox=dict(boxstyle='round,pad=0.26,rounding_size=0.35', facecolor='#0b111d', edgecolor='#334155', linewidth=0.9),
                va='top' if is_pressure else 'bottom', ha='left', zorder=11,
            )

        min_dt, max_dt = min(ls_dts), max(ls_dts)
        pad_left = timedelta(hours=max(6.0, ((max_dt - min_dt).total_seconds() / 3600.0) * 0.08))
        ax_plot.set_xlim(min_dt - pad_left, max_dt)
        ax_plot.xaxis.set_major_locator(mdates.DayLocator(interval=compute_plume_day_interval(min_dt, max_dt)))
    else:
        ax_plot.set_xlim(init_dt, init_dt + timedelta(days=7))
        ax_plot.xaxis.set_major_locator(mdates.DayLocator(interval=2))

    ax_plot.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, pos: f"{mdates.num2date(x).strftime('%b')} {mdates.num2date(x).day}"))
    ax_plot.tick_params(axis='x', labelsize=7.5, colors='#94a3b8', length=0, pad=5)

    ax_plot.set_ylim(y_min, y_max)
    ax_plot.set_yticks(y_ticks)
    ax_plot.set_yticklabels([str(y) for y in y_ticks], fontsize=7.5, color='#94a3b8')
    ax_plot.yaxis.tick_right()
    ax_plot.tick_params(axis='y', length=0, colors='#94a3b8', pad=6)
    ax_plot.text(
        1.020, y_max - (y_max - y_min) * 0.015, unit_lbl,
        color='#94a3b8', fontsize=7.6, va='bottom', ha='left',
        transform=ax_plot.get_yaxis_transform(), zorder=6,
    )

    ax_plot.grid(False)
    for s_name, spine in ax_plot.spines.items():
        if s_name == 'bottom':
            spine.set_color('#1e293b')
            spine.set_linewidth(1.0)
        else:
            spine.set_visible(False)


def plot_model_tracks(
    df_model,
    model_name,
    storm_group_id,
    output_path,
    storm_name_override=None,
    color_by='wind',
    atcf_pos=None,
    df_paired=None,
    knack_storms=None,
    total_ensemble_members=None,
):
    """
    Generates a modern 16:10 dark broadcast dashboard spaghetti plot for an active ATCF storm or invest:
      - Aspect-matched Cartopy map with non-overlapping 24h milestone labels & docked rounded legend
      - Card 1: Philippines Landfall Outlook & Category Distribution (rounded card container)
      - Card 2: Member Intensity Plume with survivor-bias quorum filter
      - Card 3: Member Central Pressure Plume with survivor-bias quorum filter
    """
    df_storm = df_model[df_model['storm_group'] == storm_group_id].copy()
    if df_storm.empty:
        print(f"No tracks found for storm group {storm_group_id} under model {model_name}")
        return None

    df_storm = df_storm.dropna(subset=['lat', 'lon'])
    if df_storm.empty:
        print(f"No valid coordinate positions for storm group {storm_group_id}")
        return None

    init_time_raw = df_storm['init_time'].dropna().iloc[0] if not df_storm['init_time'].isna().all() else 'Unknown'
    init_dt = parse_utc_init_datetime(init_time_raw)
    init_date_str = init_dt.strftime('%d %b %Y').upper()
    cycle_str = f"{(init_dt.hour // 6) * 6:02d}Z"
    local_dt = init_dt + timedelta(hours=8)
    local_time_str = local_dt.strftime('%I:%M %p PHT').lstrip('0')

    group_name = df_storm['storm_group_name'].dropna().iloc[0] if not df_storm['storm_group_name'].isna().all() else 'Unknown'
    storm_name = storm_name_override if storm_name_override else group_name
    rep_track_id = df_storm['rep_track_id'].dropna().iloc[0] if ('rep_track_id' in df_storm.columns and not df_storm['rep_track_id'].dropna().empty) else ''

    active_storm_info = None
    atcf_id_clean = storm_group_id.replace('knack_', '').upper() if storm_group_id.startswith('knack_') else ''
    if knack_storms:
        for ks in knack_storms:
            ks_id = str(ks.get('atcf_id', '')).upper()
            if ks_id and (ks_id == atcf_id_clean or atcf_id_clean in ks_id or ks_id in atcf_id_clean):
                active_storm_info = ks
                break
            if ks.get('name') and str(ks['name']).upper() == str(storm_name).upper():
                active_storm_info = ks
                break

    if active_storm_info:
        real_name = active_storm_info.get('name', storm_name).strip()
        real_id = active_storm_info.get('atcf_id', atcf_id_clean).strip().upper()
    else:
        real_name = str(storm_name).strip()
        real_id = atcf_id_clean.strip().upper()

    has_name = bool(real_name and real_name.upper() not in ('INVEST', 'UNKNOWN', 'LPA', '', 'NONE', 'N/A') and not real_name.upper().startswith('INVEST'))
    tc_num = None
    for cid in [real_id, atcf_id_clean, rep_track_id, storm_name]:
        if cid:
            m_tc = re.search(r'(?:WP|CP)?(\d{2})(?:[WC])?', str(cid).upper())
            if m_tc:
                tc_num = int(m_tc.group(1))
                break

    if has_name:
        is_invest = False
        storm_title_display = f"{real_name.upper()} ({real_id})" if real_id else real_name.upper()
    elif tc_num is not None and 1 <= tc_num < 90:
        is_invest = False
        display_id = real_id if real_id else f"WP{tc_num:02d}"
        storm_title_display = f"TROPICAL CYCLONE {display_id}"
    elif (tc_num is not None and 90 <= tc_num <= 99) or 'INVEST' in str(storm_name).upper() or 'INVEST' in real_name.upper():
        is_invest = True
        display_id = real_id if real_id else (f"{tc_num}W" if tc_num is not None else str(storm_name).upper())
        storm_title_display = f"INVEST {display_id}" if not display_id.startswith('INVEST') else display_id
    else:
        is_invest = False
        storm_title_display = real_name.upper() if real_name else (real_id if real_id else "TROPICAL SYSTEM")

    df_mean, ctrl_indices, has_control = find_control_track_for_storm(
        df_storm, df_model, model_name, storm_name,
        atcf_pos=atcf_pos, color_by=color_by, df_paired=df_paired,
        storm_group_id=storm_group_id, rep_track_id=rep_track_id,
    )

    df_storm = clean_storm_ensemble_tracks(
        df_storm, df_model, model_name, storm_name,
        atcf_pos=atcf_pos, df_paired=df_paired, df_mean=df_mean,
        ctrl_indices=ctrl_indices, has_control=has_control,
    )

    if has_control:
        print(f"Using official {model_name} control track ({len(df_mean)} points) for {storm_name}")
        ensemble_data = df_storm[~df_storm.index.isin(ctrl_indices) & (df_storm['sample'] >= 0)].copy()
        if ensemble_data.empty:
            ensemble_data = df_storm[~df_storm.index.isin(ctrl_indices)].copy()
    else:
        print(f"No official control track found for {model_name} {storm_name}; using calculated ensemble mean.")
        ensemble_data = df_storm[df_storm['sample'] >= 0].copy()
        if ensemble_data.empty:
            ensemble_data = df_storm.copy()

    # Deduplicate strictly 1 best track per ensemble member (sample)
    by_sample = {}
    for (_, s_val), m_df in ensemble_data.groupby(['track_id', 'sample']):
        m_df = m_df.sort_values('lead_time_hours').dropna(subset=['lat', 'lon'])
        if len(m_df) >= 2:
            by_sample.setdefault(s_val, []).append(m_df)

    deduped_track_dfs = []
    for s_list in by_sample.values():
        best = s_list[0] if len(s_list) == 1 else max(s_list, key=lambda x: (len(x), x['wind'].max()))
        deduped_track_dfs.append(best)

    if not deduped_track_dfs and not df_mean.empty:
        deduped_track_dfs = [df_mean]

    plotted_members = len(deduped_track_dfs)
    if not has_control:
        if plotted_members >= 2:
            quorum_min = min(plotted_members, max(2, int(math.ceil(plotted_members * 0.35))))
            df_mean = compute_clean_mean_track_df(deduped_track_dfs, min_member_ratio=0.35, min_members=quorum_min)
        else:
            df_mean = pd.DataFrame(columns=['lead_time_hours', 'lat', 'lon', 'pressure', 'wind'])

    total_ensemble_members = max(
        plotted_members,
        infer_total_members(model_name=model_name, df_normalized=df_model, explicit_total=total_ensemble_members),
    )

    all_first_lats = [float(tdf.iloc[0]['lat']) for tdf in deduped_track_dfs if not tdf.empty]
    all_first_lons = [float(tdf.iloc[0]['lon']) for tdf in deduped_track_dfs if not tdf.empty]
    mean_gen_lat, mean_gen_lon = mean_geo_center(all_first_lats, all_first_lons)

    if (-180.0 <= mean_gen_lon <= -140.0) or (180.0 <= mean_gen_lon <= 220.0) or (mean_gen_lon < 0):
        region_desc = "in the Central Pacific / crossing Dateline"
    elif 100.0 <= mean_gen_lon < 114.0 and 4.0 <= mean_gen_lat <= 24.0:
        region_desc = "in the South China Sea"
    elif 114.0 <= mean_gen_lon <= 121.5 and 10.0 <= mean_gen_lat <= 21.5:
        region_desc = "in the West Philippine Sea"
    elif 121.0 <= mean_gen_lon <= 138.0 and 5.0 <= mean_gen_lat <= 25.0:
        region_desc = "in the Philippine Sea"
    elif 138.0 < mean_gen_lon <= 180.0 and 0.0 <= mean_gen_lat <= 25.0:
        region_desc = "in the Western Pacific"
    else:
        region_desc = "in the Northwest Pacific"

    # Survivor-bias-resistant intensity & pressure envelope statistics
    all_leads = sorted({float(h) for tdf in deduped_track_dfs for h in tdf['lead_time_hours'].dropna().values})
    stat_quorum = max(3, int(plotted_members * 0.15)) if plotted_members >= 6 else max(1, int(math.ceil(plotted_members * 0.5)))

    lead_stats = []
    for lh in all_leads:
        winds_at_h = []
        pressures_at_h = []
        for tdf in deduped_track_dfs:
            row = tdf[tdf['lead_time_hours'] == lh]
            if not row.empty:
                w = float(row.iloc[0]['wind'])
                if not np.isnan(w):
                    winds_at_h.append(w)
                p = float(row.iloc[0]['pressure'])
                if not np.isnan(p) and 800.0 < p < 1050.0:
                    pressures_at_h.append(p)

        has_w = len(winds_at_h) >= stat_quorum
        has_p = len(pressures_at_h) >= stat_quorum
        if has_w or has_p:
            lead_stats.append({
                'h': lh,
                'dt': init_dt + timedelta(hours=lh),
                'median': float(np.median(winds_at_h)) if has_w else np.nan,
                'mean': float(np.mean(winds_at_h)) if has_w else np.nan,
                'p10': float(np.percentile(winds_at_h, 10)) if has_w else np.nan,
                'p25': float(np.percentile(winds_at_h, 25)) if has_w else np.nan,
                'p75': float(np.percentile(winds_at_h, 75)) if has_w else np.nan,
                'p90': float(np.percentile(winds_at_h, 90)) if has_w else np.nan,
                'p_median': float(np.median(pressures_at_h)) if has_p else np.nan,
                'p_mean': float(np.mean(pressures_at_h)) if has_p else np.nan,
                'p_p10': float(np.percentile(pressures_at_h, 10)) if has_p else np.nan,
                'p_p25': float(np.percentile(pressures_at_h, 25)) if has_p else np.nan,
                'p_p75': float(np.percentile(pressures_at_h, 75)) if has_p else np.nan,
                'p_p90': float(np.percentile(pressures_at_h, 90)) if has_p else np.nan,
            })

    valid_w_entries = [s for s in lead_stats if not np.isnan(s['median'])]
    valid_p_entries = [s for s in lead_stats if not np.isnan(s['p_median'])]

    if valid_w_entries:
        peak_entry = max(valid_w_entries, key=lambda s: s['median'])
        peak_median_val = int(round(peak_entry['median']))
        peak_dt = peak_entry['dt']
        peak_median_str = f"PEAK MEDIAN {peak_median_val} KT · {peak_dt.strftime('%b %d %HZ').upper()}"
        peak_sub_hl = f"peak median {peak_median_val} kt on {peak_dt.strftime('%b')} {peak_dt.day} {peak_dt.hour:02d}Z"
        if peak_median_val >= 137:
            peak_cat_str = "CATEGORY 5 SUPER TYPHOON"
        elif peak_median_val >= 113:
            peak_cat_str = "CATEGORY 4 TYPHOON"
        elif peak_median_val >= 96:
            peak_cat_str = "CATEGORY 3 MAJOR"
        elif peak_median_val >= 83:
            peak_cat_str = "CATEGORY 2 TYPHOON"
        elif peak_median_val >= 64:
            peak_cat_str = "CATEGORY 1 TYPHOON"
        elif peak_median_val >= 34:
            peak_cat_str = "TROPICAL STORM"
        elif peak_median_val >= 25:
            peak_cat_str = "TROPICAL DEPRESSION"
        else:
            peak_cat_str = "LOW PRESSURE AREA"
    else:
        peak_entry = None
        peak_median_str = "PEAK MEDIAN N/A"
        peak_sub_hl = "peak median N/A"
        peak_cat_str = "N/A"

    if valid_p_entries:
        min_p_entry = min(valid_p_entries, key=lambda s: s['p_median'])
        min_p_val = int(round(min_p_entry['p_median']))
        min_p_dt = min_p_entry['dt']
        min_p_sub_hl = f"min median {min_p_val} hPa on {min_p_dt.strftime('%b')} {min_p_dt.day} {min_p_dt.hour:02d}Z"
    else:
        min_p_entry = None
        min_p_sub_hl = "min median N/A"

    has_cpac = any(p < 0.0 or p > 180.0 for tdf in deduped_track_dfs for p in tdf['lon'].dropna().values)
    if atcf_pos is not None and (atcf_pos[1] < 0.0 or atcf_pos[1] > 180.0):
        has_cpac = True
    if not df_mean.empty and any(p < 0.0 or p > 180.0 for p in df_mean['lon'].dropna().values):
        has_cpac = True

    if has_cpac:
        all_lons = [unwrap_lon_for_cpac(p, True) for tdf in deduped_track_dfs for p in tdf['lon'].dropna().values]
    else:
        all_lons = [p for tdf in deduped_track_dfs for p in tdf['lon'].dropna().values if 90 <= p <= 180]
    all_lats = [p for tdf in deduped_track_dfs for p in tdf['lat'].dropna().values if 0 <= p <= 55]
    if atcf_pos is not None:
        all_lons.append(unwrap_lon_for_cpac(atcf_pos[1], has_cpac))
        all_lats.append(atcf_pos[0])
    if not df_mean.empty:
        all_lons.extend(unwrap_lon_for_cpac(x, has_cpac) for x in df_mean['lon'].dropna().values)
        all_lats.extend(df_mean['lat'].dropna().values)

    if all_lons and all_lats:
        min_lon, max_lon = min(all_lons), max(all_lons)
        min_lat, max_lat = min(all_lats), max(all_lats)
        pad_lon = max(4.0, (max_lon - min_lon) * 0.18)
        pad_lat = max(3.0, (max_lat - min_lat) * 0.18)
        view_lon_min = max(100.0, min_lon - pad_lon)
        view_lon_max = min(220.0 if has_cpac else 180.0, max_lon + pad_lon)
        view_lat_min = max(0.0, min_lat - pad_lat)
        view_lat_max = min(50.0, max_lat + pad_lat)
    else:
        view_lon_min, view_lon_max, view_lat_min, view_lat_max = 110.0, 160.0, 5.0, 35.0

    print(f"Generating broadcast-grade ensemble track graphic for {model_name} • {storm_title_display} ...")

    fig = plt.figure(figsize=(16, 10), facecolor='#090d14')

    fig.text(0.035, 0.958, f"{storm_title_display} FORECAST TRACKS", fontsize=21, weight='heavy', color='#ffffff', fontfamily='sans-serif')
    fig.text(
        0.035, 0.932, f"{format_model_display_title(model_name)} {total_ensemble_members}-MEMBER ENSEMBLE  |  INIT {init_date_str} {cycle_str} ({local_time_str})",
        fontsize=10.2, weight='bold', color='#94a3b8', fontfamily='monospace',
    )
    fig.text(0.965, 0.958, "PHILIPPINE TYPHOON/WEATHER", fontsize=13.0, weight='heavy', color='#f1f5f9', ha='right', fontfamily='sans-serif')
    fig.text(0.965, 0.934, "ENSEMBLE TRACK & INTENSITY OUTLOOK", fontsize=9.0, weight='bold', color='#64748b', ha='right', fontfamily='monospace')

    map_rect = [0.035, 0.132, 0.575, 0.778]
    view_bounds = fit_extent_to_aspect(fig, map_rect, view_lon_min, view_lon_max, view_lat_min, view_lat_max, has_cpac=has_cpac)
    ax_map, prov_geoms = setup_map_backdrop(fig, map_rect, view_bounds, has_cpac=has_cpac, script_file=__file__)

    if color_by == 'pressure':
        track_cmap = mcolors.ListedColormap(PRESSURE_COLORS)
        track_norm = mcolors.BoundaryNorm(PRESSURE_BOUNDS, track_cmap.N, extend='both')
    else:
        track_cmap = mcolors.ListedColormap(WIND_COLORS)
        track_norm = mcolors.BoundaryNorm(WIND_BOUNDS, track_cmap.N, extend='both')

    ph_tracks_count = count_ph_tracks(deduped_track_dfs)
    is_large = (total_ensemble_members >= 200) or ('large' in model_name.lower())
    is_dense_over_ph = ph_tracks_count >= 15 or (is_large and ph_tracks_count >= 5)

    draw_member_tracks(ax_map, deduped_track_dfs, track_cmap, track_norm, color_by, has_cpac, is_large, is_dense_over_ph)
    if is_dense_over_ph:
        draw_dense_ph_provinces(ax_map, prov_geoms)

    if len(df_mean) >= 2:
        m_lons = [unwrap_lon_for_cpac(x, has_cpac) for x in df_mean['lon'].dropna().values]
        m_lats = list(df_mean['lat'].dropna().values)
        ax_map.plot(m_lons, m_lats, color='#ffffff', linewidth=5.2, zorder=7, transform=ccrs.PlateCarree())
        ax_map.plot(m_lons, m_lats, color='#090d14', linewidth=3.0, zorder=8, transform=ccrs.PlateCarree())
        _place_non_overlapping_milestone_labels(ax_map, df_mean, has_cpac, color_by)

    # Docked Rounded Legend directly below map
    ax_leg = dock_legend_axis_under_map(fig, ax_map, leg_h=0.056, gap=0.036, min_bottom=0.042)
    tw_x, tw_h, tw_y = 0.03, 0.28, 0.26
    pal_cols = WIND_COLORS if color_by == 'wind' else PRESSURE_COLORS
    tw_w = 0.040 if color_by == 'wind' else 0.038
    ax_leg.text(tw_x, 0.72, "TRACK WIND (KT)" if color_by == 'wind' else "MIN MSLP (HPA)", transform=ax_leg.transAxes, fontsize=6.8, weight='heavy', color='#e2e8f0', va='center')
    for idx, col in enumerate(pal_cols):
        ax_leg.add_patch(mpatches.Rectangle((tw_x + idx * tw_w, tw_y), tw_w, tw_h, transform=ax_leg.transAxes, facecolor=col, edgecolor='#090d14', linewidth=0.5))
    tw_ticks = (
        [(0, '20'), (2, '40'), (4, '60'), (6, '80'), (7, '100'), (8, '120'), (10, '140+')]
        if color_by == 'wind'
        else [(0, '930'), (2, '950'), (4, '970'), (6, '990'), (8, '1005'), (10, '1010+')]
    )
    for idx, lbl in tw_ticks:
        ax_leg.text(tw_x + idx * tw_w, tw_y - 0.06, lbl, transform=ax_leg.transAxes, fontsize=6.1, color='#94a3b8', ha='center', va='top')

    trk_type_lbl = "OFFICIAL FORECAST TRACK" if has_control else "ENSEMBLE MEAN TRACK"
    ax_leg.text(0.585, 0.72, trk_type_lbl, transform=ax_leg.transAxes, fontsize=6.6, weight='heavy', color='#e2e8f0', ha='center', va='center')
    ax_leg.plot([0.51, 0.66], [tw_y + tw_h / 2, tw_y + tw_h / 2], transform=ax_leg.transAxes, color='#ffffff', linewidth=4.0)
    ax_leg.plot([0.51, 0.66], [tw_y + tw_h / 2, tw_y + tw_h / 2], transform=ax_leg.transAxes, color='#090d14', linewidth=2.2)
    ax_leg.plot([0.585], [tw_y + tw_h / 2], transform=ax_leg.transAxes, marker='o', markerfacecolor='#ffffff', markeredgecolor='#090d14', markersize=4.6)

    ax_leg.text(0.715, 0.72, "SYSTEM STATUS", transform=ax_leg.transAxes, fontsize=6.6, weight='heavy', color='#e2e8f0', va='center')
    ax_leg.add_patch(mpatches.Rectangle((0.715, tw_y), 0.255, tw_h, transform=ax_leg.transAxes, facecolor='#1e293b', edgecolor='#334155', linewidth=0.8))
    status_text = "Potential Tropical System" if is_invest else "Active Tropical Cyclone"
    status_color = '#fbbf24' if is_invest else '#38bdf8'
    ax_leg.text(0.8425, tw_y + tw_h / 2, status_text, transform=ax_leg.transAxes, fontsize=6.5, weight='bold', color=status_color, ha='center', va='center')

    # Right Column Rounded Cards
    card_x = 0.640
    card_w = 0.325

    # Card 1: Philippines Landfall Outlook
    ax_card1 = draw_card_container(fig, [card_x, 0.670, card_w, 0.240])
    lf_info = compute_ph_landfalls(
        deduped_track_dfs, total_ensemble_members, init_dt,
        ctrl_df=df_mean if has_control else None,
        mean_df=df_mean if not has_control else None,
    )

    if lf_info['has_landfall']:
        ax_card1.text(0.055, 0.905, "PHILIPPINES LANDFALL", fontsize=9.2, weight='heavy', color='#ffffff', transform=ax_card1.transAxes)
        ax_card1.text(
            0.945, 0.905, f"{lf_info['landfall_pct_str']} ({lf_info['landfalling_count']}/{lf_info['total_members']} MEMBERS)",
            fontsize=8.3, weight='heavy', color='#38bdf8', ha='right', transform=ax_card1.transAxes,
        )

        ax_card1.text(0.055, 0.785, lf_info.get('timing_label', 'TIMING (IF LANDFALL)'), fontsize=6.8, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)
        ax_card1.text(0.055, 0.680, lf_info['most_likely_str'], fontsize=9.2, weight='heavy', color='#ffffff', transform=ax_card1.transAxes)
        ax_card1.text(0.055, 0.590, lf_info['window_str'], fontsize=6.3, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)

        ax_card1.text(0.055, 0.445, "STRENGTH AT LANDFALL", fontsize=6.8, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)
        ax_card1.text(0.055, 0.310, lf_info['strength_str'], fontsize=10.5, weight='heavy', color='#fbbf24', transform=ax_card1.transAxes)

        ax_card1.text(0.515, 0.785, "WHERE", fontsize=6.8, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)
        ctrl_hit = lf_info.get('ctrl_hit')
        if not has_control:
            ax_card1.text(0.945, 0.785, "TRACK: NONE", fontsize=6.2, weight='heavy', color='#64748b', ha='right', transform=ax_card1.transAxes)
        elif ctrl_hit:
            ctrl_short = _truncate_place_label(ctrl_hit['muni'].upper(), 16)
            ax_card1.text(0.945, 0.785, f"★ TRACK: {ctrl_short}", fontsize=6.2, weight='heavy', color='#facc15', ha='right', transform=ax_card1.transAxes)
        else:
            ax_card1.text(0.945, 0.785, "TRACK: OFFSHORE", fontsize=6.2, weight='heavy', color='#64748b', ha='right', transform=ax_card1.transAxes)

        places_to_show = lf_info['top_places']
        n_offshore = lf_info['n_offshore']
        has_offshore = n_offshore > 0
        total_rows = len(places_to_show) + (1 if has_offshore else 0)

        bar_w = 0.430
        y_pos = 0.685
        y_step = 0.118 if total_rows <= 2 else (0.095 if total_rows == 3 else (0.082 if total_rows == 4 else 0.068))
        h_bar = 0.020 if total_rows <= 2 else (0.016 if total_rows <= 4 else 0.013)
        f_sz = 6.3 if total_rows <= 3 else (5.9 if total_rows == 4 else 5.5)

        for item in places_to_show:
            place_name = _truncate_place_label(item['place'], 22)
            pct_val = item['pct_val']
            pct_str = item['pct_str']
            is_ctrl = item.get('is_control', False)

            if is_ctrl:
                ax_card1.text(0.515, y_pos, place_name, fontsize=f_sz, weight='heavy', color='#facc15', transform=ax_card1.transAxes)
                ax_card1.text(
                    0.945, y_pos, f"{pct_str} ★" if not pct_str.endswith('★') and pct_str != 'TRACK' else pct_str,
                    fontsize=f_sz + 0.1, weight='heavy', color='#facc15', ha='right', transform=ax_card1.transAxes,
                )
            else:
                ax_card1.text(0.515, y_pos, place_name, fontsize=f_sz, weight='heavy', color='#f1f5f9', transform=ax_card1.transAxes)
                ax_card1.text(0.945, y_pos, pct_str, fontsize=f_sz + 0.1, weight='bold', color='#ffffff', ha='right', transform=ax_card1.transAxes)

            ax_card1.add_patch(mpatches.Rectangle((0.515, y_pos - h_bar - 0.012), bar_w, h_bar, transform=ax_card1.transAxes, facecolor='#1e293b', edgecolor='none'))
            ax_card1.add_patch(mpatches.Rectangle((0.515, y_pos - h_bar - 0.012), bar_w * (pct_val / 100.0), h_bar, transform=ax_card1.transAxes, facecolor='#facc15' if is_ctrl else '#ffffff', edgecolor='none'))
            y_pos -= y_step

        if has_offshore:
            ax_card1.text(0.515, y_pos, "NO PH LANDFALL", fontsize=f_sz, weight='heavy', color='#38bdf8', transform=ax_card1.transAxes)
            ax_card1.text(0.945, y_pos, f"{lf_info['offshore_str']} ({n_offshore}/{lf_info['total_members']})", fontsize=f_sz, weight='bold', color='#38bdf8', ha='right', transform=ax_card1.transAxes)
            ax_card1.add_patch(mpatches.Rectangle((0.515, y_pos - h_bar - 0.012), bar_w, h_bar, transform=ax_card1.transAxes, facecolor='#1e293b', edgecolor='none'))
            ax_card1.add_patch(mpatches.Rectangle((0.515, y_pos - h_bar - 0.012), bar_w * (lf_info['offshore_val'] / 100.0), h_bar, transform=ax_card1.transAxes, facecolor='#0284c7', edgecolor='none'))

        cur_x, tot_w, bar_h, bar_y = 0.055, 0.890, 0.072, 0.065
        if lf_info['cat_dist']:
            for cat in lf_info['cat_dist']:
                seg_w = tot_w * (cat['pct'] / 100.0)
                ax_card1.add_patch(mpatches.Rectangle((cur_x, bar_y), seg_w, bar_h, transform=ax_card1.transAxes, facecolor=cat['col'], edgecolor='#090d14', linewidth=0.8))
                if seg_w >= 0.075:
                    ax_card1.text(cur_x + seg_w / 2.0, bar_y + bar_h / 2.0, f"{cat['name']} {cat['pct']}%", transform=ax_card1.transAxes, fontsize=6.2, weight='heavy', color='#090d14', ha='center', va='center')
                cur_x += seg_w
        else:
            ax_card1.add_patch(mpatches.Rectangle((0.055, bar_y), tot_w, bar_h, transform=ax_card1.transAxes, facecolor='#1e293b', edgecolor='#334155', linewidth=0.8))
    else:
        ax_card1.text(0.055, 0.905, "PHILIPPINES LANDFALL", fontsize=9.2, weight='heavy', color='#ffffff', transform=ax_card1.transAxes)
        ax_card1.text(0.945, 0.905, f"0% (0/{total_ensemble_members:,} MEMBERS)", fontsize=8.3, weight='heavy', color='#64748b', ha='right', transform=ax_card1.transAxes)

        ax_card1.text(0.055, 0.785, "TRAJECTORY STATUS", fontsize=6.8, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)
        ax_card1.text(0.055, 0.675, "NO PH LANDFALL", fontsize=11.0, weight='heavy', color='#38bdf8', transform=ax_card1.transAxes)
        ax_card1.text(0.055, 0.580, f"{total_ensemble_members:,} OF {total_ensemble_members:,} REMAIN OFFSHORE", fontsize=6.4, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)

        ax_card1.text(0.055, 0.445, "PEAK SYSTEM INTENSITY", fontsize=6.8, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)
        ax_card1.text(0.055, 0.335, peak_median_str, fontsize=8.0, weight='heavy', color='#fbbf24', transform=ax_card1.transAxes)
        ax_card1.text(0.055, 0.240, peak_cat_str, fontsize=7.2, weight='bold', color='#facc15', transform=ax_card1.transAxes)

        ax_card1.text(0.515, 0.785, "PATH CONSENSUS", fontsize=6.8, weight='bold', color='#94a3b8', transform=ax_card1.transAxes)
        offshore_label = (
            "CENTRAL PACIFIC / DATELINE" if "central pacific" in region_desc.lower()
            else ("OPEN PACIFIC / RECURVING" if any(w in region_desc.lower() for w in ['philippine', 'pacific', 'marianas', 'caroline', 'marshall', 'micronesia'])
                  else region_desc.upper().replace("IN THE ", "").replace("NEAR ", ""))
        )
        f_lbl_sz = 5.4 if (len(offshore_label) > 18 or total_ensemble_members >= 1000) else 6.3
        f_pct_sz = 5.4 if total_ensemble_members >= 1000 else 6.2
        ax_card1.text(0.515, 0.680, _truncate_place_label(offshore_label, 27), fontsize=f_lbl_sz, weight='heavy', color='#f1f5f9', transform=ax_card1.transAxes)
        ax_card1.text(0.945, 0.680, f"100% ({total_ensemble_members}/{total_ensemble_members})", fontsize=f_pct_sz, weight='bold', color='#38bdf8', ha='right', transform=ax_card1.transAxes)

        bar_w = 0.430
        ax_card1.add_patch(mpatches.Rectangle((0.515, 0.648), bar_w, 0.018, transform=ax_card1.transAxes, facecolor='#1e293b', edgecolor='none'))
        ax_card1.add_patch(mpatches.Rectangle((0.515, 0.648), bar_w, 0.018, transform=ax_card1.transAxes, facecolor='#0284c7', edgecolor='none'))

        ax_card1.text(0.515, 0.445, f"ALL {total_ensemble_members:,} MEMBERS REMAIN AT SEA", fontsize=6.4, weight='bold', color='#f8fafc', transform=ax_card1.transAxes)
        ax_card1.text(0.515, 0.355, "SPREAD REMAINS COMPLETELY OFFSHORE", fontsize=6.1, weight='bold', color='#64748b', transform=ax_card1.transAxes)

        bar_box = mpatches.FancyBboxPatch(
            (0.055, 0.065), 0.890, 0.072,
            boxstyle='round,pad=0.002,rounding_size=0.015',
            transform=ax_card1.transAxes, facecolor='#101928', edgecolor='#233247', linewidth=0.9,
        )
        ax_card1.add_patch(bar_box)
        ax_card1.text(
            0.50, 0.065 + 0.072 / 2.0,
            f"OFFSHORE TRAJECTORY  ·  {total_ensemble_members:,} OF {total_ensemble_members:,} MEMBERS REMAIN AT SEA (0% LANDFALL)",
            transform=ax_card1.transAxes, fontsize=6.4, weight='heavy', color='#94a3b8', ha='center', va='center',
        )

    # Card 2: Member Intensity Plume
    _render_plume_card(
        fig, [card_x, 0.355, card_w, 0.295],
        title="Member intensity",
        subtitle_prefix="1-min sustained wind · ",
        subtitle_highlight=peak_sub_hl,
        model_name=model_name,
        is_pressure=False,
        deduped_track_dfs=deduped_track_dfs,
        lead_stats=valid_w_entries,
        df_mean=df_mean,
        has_control=has_control,
        init_dt=init_dt,
        peak_entry=peak_entry,
        y_min=0, y_max=160, y_ticks=[0, 25, 50, 75, 100, 125, 150], unit_lbl="kt",
    )

    # Card 3: Member Central Pressure Plume
    all_member_p = [p for tdf in deduped_track_dfs for p in tdf['pressure'].dropna().values if 800 < p < 1050]
    min_obs_p = min(all_member_p) if all_member_p else 920.0
    if valid_p_entries:
        min_obs_p = min(min_obs_p, min(s['p_p10'] for s in valid_p_entries))
    y3_min = max(860, int(np.floor((min_obs_p - 10.0) / 20.0) * 20))
    y3_top_tick = 1020
    y3_max = 1030
    _render_plume_card(
        fig, [card_x, 0.042, card_w, 0.293],
        title="Member central pressure",
        subtitle_prefix="Minimum MSLP · ",
        subtitle_highlight=min_p_sub_hl,
        model_name=model_name,
        is_pressure=True,
        deduped_track_dfs=deduped_track_dfs,
        lead_stats=valid_p_entries,
        df_mean=df_mean,
        has_control=has_control,
        init_dt=init_dt,
        peak_entry=min_p_entry,
        y_min=y3_min, y_max=y3_max, y_ticks=list(range(y3_min, y3_top_tick + 1, 20)), unit_lbl="hPa",
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    plt.savefig(output_path, dpi=200, bbox_inches='tight', pad_inches=0.15, facecolor='#090d14', edgecolor='none')
    plt.close()

    print(f"Broadcast-grade spaghetti plot saved to: {output_path}")
    print(f"Stats: {plotted_members} tracks plotted out of {total_ensemble_members} members.")
    return {
        'storm_name': real_name.upper() if has_name else None,
        'basin': 'CP' if (has_cpac or str(storm_group_id).upper().startswith('CP') or (real_id and real_id.endswith('C'))) else 'WP',
        'display_title': storm_title_display,
    }


def map_hdbscan_clusters_to_knack_storms(df, knack_storms, dist_threshold=4.0):
    """Maps HDBSCAN clusters to Knack active storms by lead-time-matched proximity."""
    if df.empty or not knack_storms:
        return df, False

    df = df.copy()
    candidates_by_storm = {}

    for (init_val, group_id), group_df in df.groupby(['init_time', 'storm_group']):
        if group_id == 'UNKNOWN':
            continue
        try:
            f_init_dt = pd.to_datetime(str(init_val).strip())
            if f_init_dt.tzinfo is not None:
                f_init_dt = f_init_dt.tz_localize(None)
            f_init_dt = f_init_dt.to_pydatetime()
        except Exception:
            f_init_dt = None

        for k_storm in knack_storms:
            k_lat, k_lon = k_storm['lat'], k_storm['lon']
            if np.isnan(k_lat) or np.isnan(k_lon):
                continue
            try:
                k_dt = pd.to_datetime(str(k_storm['init_time']).strip())
                if k_dt.tzinfo is not None:
                    k_dt = k_dt.tz_localize(None)
                k_dt = k_dt.to_pydatetime()
            except Exception:
                k_dt = None

            target_lead_time = 0.0
            if f_init_dt and k_dt:
                target_lead_time = (k_dt - f_init_dt).total_seconds() / 3600.0
            if target_lead_time > 48.0 or target_lead_time < -24.0:
                continue
            target_lead_time = max(0.0, target_lead_time)

            diffs = (group_df['lead_time_hours'] - target_lead_time).abs()
            if not diffs.empty and diffs.min() <= 12.0:
                target_pts = group_df[diffs <= 6.0]
                if target_pts.empty:
                    target_pts = group_df[diffs == diffs.min()]
            else:
                closest_lead = group_df['lead_time_hours'].min()
                if closest_lead > 36.0:
                    continue
                target_pts = group_df[group_df['lead_time_hours'] == closest_lead]

            avg_lat, avg_lon = mean_geo_center(target_pts['lat'].dropna().tolist(), target_pts['lon'].dropna().tolist())
            if np.isnan(avg_lat) or np.isnan(avg_lon):
                continue

            d_lat = avg_lat - k_lat
            raw_d_lon = (avg_lon - k_lon + 180.0) % 360.0 - 180.0
            d_lon = raw_d_lon * math.cos(math.radians((avg_lat + k_lat) / 2.0))
            dist = math.sqrt(d_lat ** 2 + d_lon ** 2)

            if dist <= dist_threshold:
                k_atcf_id = k_storm['atcf_id']
                candidates_by_storm.setdefault(k_atcf_id, []).append({
                    'group_id': group_id,
                    'dist': dist,
                    'lead_time': target_lead_time,
                    'name': k_storm['name'],
                    'atcf_id': k_atcf_id,
                })

    mapped_groups = {}
    has_mapped = False
    for k_atcf_id, candidates in candidates_by_storm.items():
        if not candidates:
            continue
        min_dist = min(c['dist'] for c in candidates)
        allowed_max_dist = min(dist_threshold, max(3.0, min_dist + 1.5) if min_dist <= 3.0 else min_dist + 1.5)

        for cand in candidates:
            if cand['dist'] <= allowed_max_dist:
                k_name = cand['name']
                display_name = get_storm_display_name(k_atcf_id)
                if k_name and not k_name.upper().startswith('INVEST') and not k_name.upper().startswith('WP') and k_name.upper() != k_atcf_id.upper():
                    display_name = f"{k_name.upper()} ({k_atcf_id})"
                mapped_groups[cand['group_id']] = {
                    'storm_group': f"knack_{k_atcf_id}",
                    'storm_group_name': display_name,
                    'rep_track_id': k_atcf_id,
                    'atcf_id': k_atcf_id,
                    'dist': cand['dist'],
                    'lead_time': cand['lead_time'],
                }
                has_mapped = True

    for orig_group_id, mapping in mapped_groups.items():
        mask = df['storm_group'] == orig_group_id
        df.loc[mask, 'storm_group'] = str(mapping['storm_group'])
        df.loc[mask, 'storm_group_name'] = str(mapping['storm_group_name'])
        df.loc[mask, 'rep_track_id'] = str(mapping['rep_track_id'])
        print(f"Mapped HDBSCAN cluster {orig_group_id} to Knack storm {mapping['atcf_id']} (dist: {mapping['dist']:.2f} deg, target lead: {mapping['lead_time']:.1f}h)")

    return df, has_mapped


def assign_tracks_to_knack_storms(df, knack_storms):
    """
    Directly assigns each ensemble member track to its matching Knack active storm by
    ATCF identifier (`WP`/`W` or `CP`/`C`) or earliest-point proximity (<= 880 km).
    """
    if df.empty or not knack_storms:
        return df, False

    df = df.copy()
    df['storm_group'] = 'UNKNOWN'
    df['storm_group_name'] = 'UNKNOWN'
    df['rep_track_id'] = 'UNKNOWN'

    storm_info = {}
    for s in knack_storms:
        atcf_id = str(s.get('atcf_id', '')).upper()
        num_m = re.search(r'(\d{2})', atcf_id)
        num = num_m.group(1) if num_m else ''
        basin_code = 'CP' if (s.get('basin') == 'CP' or 'CP' in atcf_id or atcf_id.endswith('C')) else 'WP'
        basin_char = 'C' if basin_code == 'CP' else 'W'

        display_name = get_storm_display_name(atcf_id)
        k_name = s.get('name', '')
        if k_name and not k_name.upper().startswith(('INVEST', 'WP', 'CP')) and k_name.upper() != atcf_id:
            display_name = f"{k_name.upper()} ({atcf_id})"
        storm_info[atcf_id] = {
            'num': num,
            'basin_code': basin_code,
            'basin_char': basin_char,
            'lat': s['lat'],
            'lon': s['lon'],
            'atcf_id': atcf_id,
            'display_name': display_name,
        }

    has_mapped = False
    for (tid, _), t_df in df.groupby(['track_id', 'sample']):
        early = t_df[t_df['lead_time_hours'] <= 48.0].dropna(subset=['lat', 'lon']).sort_values('lead_time_hours')
        if early.empty:
            continue
        first_row = early.iloc[0]
        f_lat, f_lon = float(first_row['lat']), float(first_row['lon'])
        tid_upper = str(tid).upper()

        best_s = None
        for atcf_id, s_data in storm_info.items():
            n = s_data['num']
            if n and re.search(rf'(?:{s_data["basin_code"]}|^){n}(?:{s_data["basin_char"]}|\d{{4}}|\b)', tid_upper):
                best_s = atcf_id
                break

        if best_s is None:
            min_d = float('inf')
            for atcf_id, s_data in storm_info.items():
                if np.isnan(s_data['lat']) or np.isnan(s_data['lon']):
                    continue
                d = haversine_km(f_lat, f_lon, s_data['lat'], s_data['lon'])
                if d < min_d:
                    min_d = d
                    if d <= 880.0:
                        best_s = atcf_id

        if best_s:
            s_data = storm_info[best_s]
            t_idx = t_df.index
            df.loc[t_idx, 'storm_group'] = f"knack_{best_s}"
            df.loc[t_idx, 'storm_group_name'] = str(s_data['display_name'])
            df.loc[t_idx, 'rep_track_id'] = str(best_s)
            has_mapped = True

    if has_mapped:
        df = df[df['storm_group'].str.startswith('knack_')].copy()

    return df, has_mapped


def _resolve_paired_path(f_path):
    """Finds the matching paired control/mean file path for a GDM ensemble track file."""
    dir_name = os.path.dirname(f_path)
    base = os.path.basename(f_path)

    if not any(k in base.lower() for k in ['wnv3', 'wnc', 'fnv3', 'oper', 'large']):
        return None

    candidates = []
    if '_cyclogenesis.' in base:
        candidates.append(base.replace('_cyclogenesis.', '_paired.'))
    if '_latest.' in base:
        candidates.append(base.replace('_latest.', '_paired_latest.'))

    m_ts = re.match(r'^(fnv3_large|wnc_large|fnv3p2|fnv3p1|wnv3|oper)(_\d{4}_\d{2}_\d{2}T\d{2}_\d{2}\.(?:dat|csv|enc))$', base, re.I)
    if m_ts:
        candidates.append(f"{m_ts.group(1)}_paired{m_ts.group(2)}")

    for cand in candidates:
        full_cand = os.path.join(dir_name, cand)
        if os.path.exists(full_cand):
            return full_cand
    return None


def main():
    parser = argparse.ArgumentParser(description="Ensemble Track Visualization System")
    parser.add_argument('--input', type=str, nargs='*', help="Input DAT, CSV, or ATCF files")
    parser.add_argument('--storm-id', type=str, help="Specific track_id to plot (e.g. WP092026)")
    parser.add_argument('--storm-name', type=str, help="Storm display name (e.g. 90W INVEST)")
    parser.add_argument('--output-dir', type=str, default='public/assets', help="Directory to save generated plots")
    parser.add_argument('--color-by', type=str, default='wind', choices=['wind', 'pressure'], help="Parameter to color lines by")
    parser.add_argument('--skip-manifest', action='store_true', default=False, help="Skip updating spaghetti_manifest.json")
    args = parser.parse_args()

    input_files = args.input
    if not input_files:
        search_dir = resolve_data_path(('public', 'data'), script_file=__file__)
        input_files = []
        for prefix in ['wnv3_latest', 'fnv3_large_latest', 'wnc_large_latest']:
            for ext in ['.dat', '.csv', '.enc']:
                cand = os.path.join(search_dir, f"{prefix}{ext}")
                if os.path.exists(cand):
                    input_files.append(cand)
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
    if not knack_storms:
        print("Knack API returned 0 active storms; falling back to local active storms from tc_storms_index.json...")
        for s in load_atcf_storms_index(script_file=__file__):
            if s.get('active'):
                tid = str(s.get('track_id', '')).upper()
                aid = str(s.get('atcf_id', '')).upper()
                if not aid:
                    m = re.search(r'([A-Z]+)?(\d{2})', tid)
                    if m:
                        aid = f"{m.group(2)}{'C' if 'CP' in tid else 'W'}"
                knack_storms.append({
                    'atcf_id': aid,
                    'name': s.get('storm_name', 'TROPICAL SYSTEM'),
                    'lat': float(s.get('latest_lat', 15.0)),
                    'lon': float(s.get('latest_lon', 130.0)),
                    'basin': s.get('basin', 'CP' if 'CP' in tid or 'C' in aid else 'WP'),
                    'init_time': s.get('last_updated', ''),
                    'winds': None,
                    'pressure': None,
                })
        if knack_storms:
            print(f"Loaded {len(knack_storms)} active storms from local tc_storms_index.json.")

    print(f"Processing files: {input_files}")
    out_dir = resolve_output_dir(args.output_dir, script_file=__file__)
    latest_plotted_init = {}
    new_manifest_entries = []

    for f_path in input_files:
        raw_df = load_track_file(f_path)
        if raw_df.empty:
            print(f"Skipping empty file: {f_path}")
            continue

        normalized_df = normalize_dataframe(raw_df)
        model = detect_model_name(f_path)
        total_members = infer_total_members(file_path=f_path, model_name=model, df_normalized=normalized_df)
        wp_df = filter_western_pacific(normalized_df)

        if wp_df.empty:
            print(f"No Western Pacific tracks found in: {f_path}")
            continue

        too_old, latest_run_init, age_days = is_run_too_old(wp_df, max_age_days=5.0)
        if too_old:
            print(f"Skipping outdated file {f_path}: initialization {latest_run_init} is {age_days:.1f} days old.")
            continue

        if knack_storms:
            wp_df = filter_tracks_near_active_storms(wp_df, knack_storms, max_dist_deg=8.0)
            if wp_df.empty:
                print(f"No tracks near active Knack storms found in: {f_path}")
                continue

        df_paired = pd.DataFrame()
        paired_path = _resolve_paired_path(f_path)
        if paired_path:
            print(f"Found corresponding paired file: {paired_path}")
            raw_paired_df = load_track_file(paired_path)
            if not raw_paired_df.empty:
                df_paired = normalize_dataframe(raw_paired_df)

        wp_df, has_mapped = assign_tracks_to_knack_storms(wp_df, knack_storms)
        if not has_mapped:
            wp_df = cluster_genesis_locations(wp_df)
            wp_df, has_mapped = map_hdbscan_clusters_to_knack_storms(wp_df, knack_storms)
            if has_mapped:
                wp_df = wp_df[wp_df['storm_group'].str.startswith('knack_')].copy()
            else:
                print(f"No clusters matched Knack active storms in: {f_path}. Skipping.")
                continue

        storm_groups = wp_df['storm_group'].dropna().unique()
        print(f"Found storm groups {storm_groups} in {f_path}")
        model_clean = model.replace(' ', '_').lower()

        for sg_id in storm_groups:
            if sg_id == 'UNKNOWN':
                continue

            group_df = wp_df[wp_df['storm_group'] == sg_id]
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

            match_wp = re.search(r'WP(\d{2})', rep_track_id.upper())
            match_w = re.search(r'(\d{2})W', rep_track_id.upper())
            match_cp = re.search(r'CP(\d{2})', rep_track_id.upper())
            match_c = re.search(r'(\d{2})C', rep_track_id.upper())
            if match_wp:
                wp_id, num_w_id = f"WP{match_wp.group(1)}", f"{match_wp.group(1)}W"
            elif match_w:
                wp_id, num_w_id = f"WP{match_w.group(1)}", f"{match_w.group(1)}W"
            elif match_cp:
                wp_id, num_w_id = f"CP{match_cp.group(1)}", f"{match_cp.group(1)}C"
            elif match_c:
                wp_id, num_w_id = f"CP{match_c.group(1)}", f"{match_c.group(1)}C"
            else:
                wp_id = num_w_id = rep_track_id.upper()

            if args.storm_id:
                s_target = args.storm_id.upper().strip()
                if s_target not in (wp_id, num_w_id, rep_track_id.upper()):
                    continue

            primary_filename = f"{wp_id}_{ymd}_{cycle_str}_{model_clean}.png"
            out_file = os.path.join(out_dir, primary_filename)

            if out_file in latest_plotted_init and current_init_dt < latest_plotted_init[out_file]:
                print(f"Skipping older run for {out_file} (current init: {init_time_raw}, already plotted newer: {latest_plotted_init[out_file]})")
                continue

            atcf_pos = None
            if sg_id.startswith('knack_'):
                atcf_id_clean = sg_id.replace('knack_', '')
                for s in knack_storms:
                    if s['atcf_id'] == atcf_id_clean:
                        atcf_pos = (s['lat'], s['lon'])
                        break

            res_meta = plot_model_tracks(
                wp_df, model, sg_id, out_file,
                storm_name_override=args.storm_name,
                color_by=args.color_by,
                atcf_pos=atcf_pos,
                df_paired=df_paired,
                knack_storms=knack_storms,
                total_ensemble_members=total_members,
            )
            latest_plotted_init[out_file] = current_init_dt

            if not os.path.exists(out_file) or res_meta is None:
                continue

            unique_key = f"{wp_id}_{ymd}T{cycle_str}"
            new_manifest_entries.append({
                'storm_id': wp_id,
                'atcf_id': num_w_id,
                'storm_name': res_meta.get('storm_name'),
                'basin': res_meta.get('basin', 'CP' if wp_id.startswith('CP') else 'WP'),
                'init_date': ymd,
                'cycle': cycle_str,
                'model': model_clean,
                'unique_key': unique_key,
                'filename': primary_filename,
                'alt_filename': primary_filename,
                'timestamp': datetime.now(timezone.utc).isoformat(),
            })

    if not args.skip_manifest and new_manifest_entries:
        update_and_prune_spaghetti_manifest(
            new_manifest_entries,
            output_dir=out_dir,
            script_file=__file__,
            max_runs_retained=8,
        )


if __name__ == '__main__':
    main()
