"""
Capacitance sensor loading, empty-bed baselines, and presence detection.

Presence scoring uses max of per-zone z-scores (out/cen/in) vs empty baseline by
default, so a single strong zone still registers when another zone is weak or
noisy (common on Pod covers with asymmetric load).
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime
from typing import Any, Dict, Optional

import pandas as pd

from data_types import *
from get_logger import get_logger

try:
    from presence_config import (  # type: ignore
        DEFAULT_CAP_METHOD,
        DEFAULT_CAP_ROLLING_SECONDS,
        DEFAULT_CAP_THRESHOLD_PERCENT,
        DEFAULT_CAP_ZONE_THRESHOLD,
        baseline_file_path,
        extract_cap_baseline,
        load_sensor_profile,
        save_sensor_profile,
    )
except ImportError:
    from sleep_detection.presence_config import (
        DEFAULT_CAP_METHOD,
        DEFAULT_CAP_ROLLING_SECONDS,
        DEFAULT_CAP_THRESHOLD_PERCENT,
        DEFAULT_CAP_ZONE_THRESHOLD,
        baseline_file_path,
        extract_cap_baseline,
        load_sensor_profile,
        save_sensor_profile,
    )

logger = get_logger()

# Back-compat aliases used by older call sites / docs
LEFT_CAP_BASE_LINE_FILE_PATH = f'{logger.folder_path}left_cap_baseline.json'
RIGHT_CAP_BASELINE_FILE_PATH = f'{logger.folder_path}right_cap_baseline.json'
pd.set_option('display.width', 300)
pd.set_option('display.max_columns', 50)


def create_cap_baseline_from_cap_df(
    merged_df: pd.DataFrame,
    start_time: datetime,
    end_time: datetime,
    side: Side,
    min_std: int = 5,
) -> Dict[str, Dict[str, float]]:
    """Empty-bed mean/std per zone for the given time window."""
    logger.debug('Creating baseline for capacitance sensors...')
    filtered_df = merged_df[start_time:end_time]
    logger.debug(f'filtered_df: \n{filtered_df.describe()}')
    cap_baseline: Dict[str, Dict[str, float]] = {}
    for sensor in [f'{side}_out', f'{side}_cen', f'{side}_in']:
        cap_baseline[sensor] = {
            'mean': float(filtered_df[sensor].mean()),
            'std': float(max(filtered_df[sensor].std(), min_std)),
        }

    logger.debug(f'cap_baseline: \n{json.dumps(cap_baseline, indent=4)}')
    return cap_baseline


def save_baseline(side: Side, cap_baseline: dict, extra: Optional[Dict[str, Any]] = None) -> str:
    """
    Persist empty-bed zones and optional extras (piezo floor, pose metadata).

    Merges with any existing profile so multi-pose fields are not wiped when
    only re-running empty-bed calibration. Returns the baseline file path.
    """
    existing = load_sensor_profile(side)
    profile = dict(existing)
    for key, value in cap_baseline.items():
        profile[key] = value
    if extra:
        profile.update(extra)
    path = save_sensor_profile(side, profile)
    logger.debug(f'Saving {side} side cap_baseline to {path}')
    return path


def load_baseline(side: Side) -> Dict[str, Dict[str, float]]:
    """Load empty-bed zone stats; raises if missing (analyze needs a baseline)."""
    path = baseline_file_path(side)
    logger.debug(f'Loading cap baseline from: {path}')
    profile = load_sensor_profile(side)
    zones = extract_cap_baseline(profile, side)
    if zones is None:
        raise FileNotFoundError(
            f'''Capacitance thresholds must be calibrated prior to running
Run `python3 calibrate_sensor_thresholds.py --side={side} --start_time="2025-02-02 06:00:00" --end_time="2025-02-02 15:01:00"`
'''
        )
    return zones


def load_cap_df(data: Data, side: Side, expected_row_count=None) -> pd.DataFrame:
    logger.debug('Loading cap df...')
    df = pd.DataFrame(data['cap_senses'], columns=['ts', side])

    df[f'{side}_out'] = df[side].str['out']
    df[f'{side}_cen'] = df[side].str['cen']
    df[f'{side}_in'] = df[side].str['in']

    df.drop(columns=[side], inplace=True)

    df.sort_values('ts', inplace=True)
    df['ts'] = pd.to_datetime(df['ts'])
    df.set_index('ts', inplace=True)
    logger.debug(f'Capacitance rows loaded: {df.shape[0]:,}')
    if expected_row_count is not None:
        row_count = df.shape[0]
        if row_count / expected_row_count < 0.80:
            logger.warning(
                f'Potentially missing cap rows! Expected: {expected_row_count:,} '
                f'Loaded: {row_count:,} ({row_count / expected_row_count * 100:0.0f}%)'
            )

    logger.debug(f'Loaded cap df time range: {df.index[0]} -> {df.index[-1]}')
    return df


def _zone_z_columns(
    merged_df: pd.DataFrame,
    cap_baseline: dict,
    side: Side,
) -> None:
    """Write per-zone z-score columns and aggregate scores onto merged_df."""
    for zone in ('out', 'cen', 'in'):
        key = f'{side}_{zone}'
        mean = float(cap_baseline[key]['mean'])
        std = float(cap_baseline[key]['std']) or 1.0
        merged_df[f'{key}_z'] = (merged_df[key] - mean) / std

    z_out = merged_df[f'{side}_out_z']
    z_cen = merged_df[f'{side}_cen_z']
    z_in = merged_df[f'{side}_in_z']
    merged_df[f'{side}_max_z'] = pd.concat([z_out, z_cen, z_in], axis=1).max(axis=1)
    merged_df[f'{side}_sum_z'] = z_out + z_cen + z_in
    # Alias used by older movement / debug code
    merged_df[f'{side}_combined'] = merged_df[f'{side}_max_z']


def detect_presence_cap(
    merged_df: pd.DataFrame,
    cap_baseline,
    side: Side,
    occupancy_threshold: float = DEFAULT_CAP_ZONE_THRESHOLD,
    rolling_seconds: int = DEFAULT_CAP_ROLLING_SECONDS,
    threshold_percent: float = DEFAULT_CAP_THRESHOLD_PERCENT,
    method: str = DEFAULT_CAP_METHOD,
    clean: bool = True,
) -> pd.DataFrame:
    """
    Mark cap presence using zone z-scores vs empty baseline.

    method:
      - max_z: any single strong zone is enough (default; best for weak/noisy caps)
      - sum_z: legacy sum of three z-scores
      - zone_or: OR of (zone_z > occupancy_threshold) — same threshold per zone
    """
    logger.debug(f'Detecting cap presence (method={method}, threshold={occupancy_threshold})...')
    _zone_z_columns(merged_df, cap_baseline, side)

    if method == 'sum_z':
        score = merged_df[f'{side}_sum_z']
        instant = (score > occupancy_threshold).astype(int)
    elif method == 'zone_or':
        instant = (
            (merged_df[f'{side}_out_z'] > occupancy_threshold)
            | (merged_df[f'{side}_cen_z'] > occupancy_threshold)
            | (merged_df[f'{side}_in_z'] > occupancy_threshold)
        ).astype(int)
        score = merged_df[f'{side}_max_z']
    else:
        # max_z (default)
        score = merged_df[f'{side}_max_z']
        instant = (score > occupancy_threshold).astype(int)

    merged_df[f'cap_{side}_occupied'] = instant
    threshold_count = math.ceil(threshold_percent * rolling_seconds)

    merged_df[f'cap_{side}_occupied'] = (
        merged_df[f'cap_{side}_occupied']
        .rolling(window=rolling_seconds, min_periods=1)
        .sum()
        >= threshold_count
    ).astype(int)

    logger.debug(f'Cap baseline for {side} side:')
    logger.debug(json.dumps(cap_baseline, indent=4))
    logger.debug(f'Presence df: \n{merged_df.describe()}')
    if clean:
        drop_cols = [
            f'{side}_combined',
            f'{side}_max_z',
            f'{side}_sum_z',
            f'{side}_out',
            f'{side}_cen',
            f'{side}_in',
            f'{side}_out_z',
            f'{side}_cen_z',
            f'{side}_in_z',
        ]
        merged_df.drop(columns=[c for c in drop_cols if c in merged_df.columns], inplace=True)
    return merged_df
