"""
Shared presence-detection defaults and per-side personalized thresholds.

Sleep analysis, empty-bed calibration, multi-pose calibration, and the live
Sensors snapshot all read the same constants / baseline files so UI and offline
analysis stay aligned.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

from data_types import Side
from get_logger import get_logger

logger = get_logger()

# ---------------------------------------------------------------------------
# Defaults (used when no personalized floor/threshold is stored)
# ---------------------------------------------------------------------------

# Cap: max of per-zone z-scores vs empty baseline (was sum of z-scores).
# max-z ~2 means one zone is clearly elevated; sum-of-3 at 5 was harsher on
# sides where only one zone responds (e.g. weak center).
DEFAULT_CAP_METHOD = 'max_z'
DEFAULT_CAP_ZONE_THRESHOLD = 2.0
DEFAULT_CAP_ROLLING_SECONDS = 10
DEFAULT_CAP_THRESHOLD_PERCENT = 0.90

# Piezo: packet range (max−min) over a short window. Raised from 20k to reduce
# cross-talk false positives when the other side is occupied.
DEFAULT_PIEZO_RANGE_THRESHOLD = 50_000
DEFAULT_PIEZO_ROLLING_SECONDS = 10
DEFAULT_PIEZO_THRESHOLD_PERCENT = 0.70

# Fusion: piezo is primary; cap soft-assists (OR) rather than hard AND.
DEFAULT_FUSION_MODE = 'piezo_primary'

# Sleep period rules (unchanged intentional defaults).
MIN_SLEEP_HOURS = 3
MAX_PRESENCE_GAP_MINUTES = 15
# Count as a bed exit only when presence is gone this long (tosses/flicker are shorter).
MIN_EXIT_GAP_SECONDS = 45

BASELINE_VERSION = 2


def data_folder() -> str:
    return getattr(logger, 'folder_path', None) or '/persistent/free-sleep-data/'


def baseline_file_path(side: Side) -> str:
    return os.path.join(data_folder(), f'{side}_cap_baseline.json')


def pose_session_path(side: Side) -> str:
    return os.path.join(data_folder(), f'{side}_pose_calibration_session.json')


def load_sensor_profile(side: Side) -> Dict[str, Any]:
    """
    Load empty-bed baseline (+ optional pose-derived thresholds / piezo floor).

    Always returns a dict with at least zone means/stds when the file exists.
    Extra keys (piezo_range_threshold, cap_zone_threshold, poses, …) are optional.
    """
    path = baseline_file_path(side)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            return {}
        return data
    except Exception as error:
        logger.warning(f'Failed loading sensor profile for {side}: {error}')
        return {}


def extract_cap_baseline(profile: Dict[str, Any], side: Side) -> Optional[Dict[str, Dict[str, float]]]:
    """Return {side_out, side_cen, side_in: {mean, std}} or None if incomplete."""
    zones = {}
    for zone in ('out', 'cen', 'in'):
        key = f'{side}_{zone}'
        entry = profile.get(key)
        if not isinstance(entry, dict):
            return None
        mean = entry.get('mean')
        std = entry.get('std')
        if mean is None or std is None:
            return None
        zones[key] = {'mean': float(mean), 'std': float(std) or 1.0}
    return zones


def get_piezo_range_threshold(side: Side, profile: Optional[Dict[str, Any]] = None) -> int:
    """Per-side piezo floor if calibrated; otherwise the global default."""
    if profile is None:
        profile = load_sensor_profile(side)
    value = profile.get('piezo_range_threshold')
    if value is None:
        return DEFAULT_PIEZO_RANGE_THRESHOLD
    try:
        return max(5_000, int(value))
    except (TypeError, ValueError):
        return DEFAULT_PIEZO_RANGE_THRESHOLD


def get_cap_zone_threshold(side: Side, profile: Optional[Dict[str, Any]] = None) -> float:
    if profile is None:
        profile = load_sensor_profile(side)
    value = profile.get('cap_zone_threshold')
    if value is None:
        return DEFAULT_CAP_ZONE_THRESHOLD
    try:
        return float(value)
    except (TypeError, ValueError):
        return DEFAULT_CAP_ZONE_THRESHOLD


def get_cap_method(side: Side, profile: Optional[Dict[str, Any]] = None) -> str:
    if profile is None:
        profile = load_sensor_profile(side)
    method = profile.get('cap_method') or DEFAULT_CAP_METHOD
    if method not in ('max_z', 'sum_z', 'zone_or'):
        return DEFAULT_CAP_METHOD
    return method


def save_sensor_profile(side: Side, profile: Dict[str, Any]) -> str:
    """Write baseline JSON (creates parent dir if needed). Returns path."""
    path = baseline_file_path(side)
    folder = os.path.dirname(path)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
    profile = dict(profile)
    profile.setdefault('version', BASELINE_VERSION)
    profile.setdefault('cap_method', DEFAULT_CAP_METHOD)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(profile, handle, indent=4)
    logger.info(f'Saved sensor profile for {side} → {path}')
    return path


def thresholds_for_snapshot(side: Side) -> Dict[str, Any]:
    """JSON-friendly threshold block for dump_sensor_snapshot / Sensors UI."""
    profile = load_sensor_profile(side)
    piezo_floor = get_piezo_range_threshold(side, profile)
    cap_thresh = get_cap_zone_threshold(side, profile)
    method = get_cap_method(side, profile)
    personalized = bool(profile.get('piezo_range_threshold') or profile.get('poses'))
    return {
        'cap': {
            'method': method,
            'occupancyThreshold': cap_thresh,
            'rollingSeconds': DEFAULT_CAP_ROLLING_SECONDS,
            'thresholdPercent': DEFAULT_CAP_THRESHOLD_PERCENT,
            'description': (
                f'Cap: {method} of per-zone z-scores vs empty baseline. '
                f'Instant sample above {cap_thresh} counts toward occupancy; '
                f'analysis needs ≥{int(DEFAULT_CAP_THRESHOLD_PERCENT * 100)}% of a '
                f'{DEFAULT_CAP_ROLLING_SECONDS}s window.'
            ),
        },
        'piezo': {
            'rangeThreshold': piezo_floor,
            'rollingSeconds': DEFAULT_PIEZO_ROLLING_SECONDS,
            'thresholdPercent': DEFAULT_PIEZO_THRESHOLD_PERCENT,
            'personalized': personalized,
            'description': (
                f'Piezo: packet range (max−min) ≥ {piezo_floor:,} counts as active'
                f'{" (personalized floor)" if personalized else " (default)"}; '
                f'analysis needs ≥{int(DEFAULT_PIEZO_THRESHOLD_PERCENT * 100)}% of a '
                f'{DEFAULT_PIEZO_ROLLING_SECONDS}s window.'
            ),
        },
        'fusion': {
            'mode': profile.get('fusion_mode') or DEFAULT_FUSION_MODE,
            'description': (
                'Piezo-primary with cap soft assist (OR): presence if piezo fires, '
                'or if cap max-z is above threshold. Not hard AND.'
            ),
        },
    }
