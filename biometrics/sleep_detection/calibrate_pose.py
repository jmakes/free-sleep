#!/usr/bin/env python3
"""
Multi-pose, multi-repetition personalized sensor calibration.

Captures at least two reps of each pose:
  unoccupied, center, inner, outer

Then finalizes into `{side}_cap_baseline.json` with:
  - empty-bed mean/std per zone (from unoccupied reps)
  - personalized cap_zone_threshold (max_z) from separation of empty vs occupied
  - optional per-side piezo_range_threshold from empty vs occupied piezo ranges

Usage (on Pod):
  # Reset session
  python -B calibrate_pose.py --side=right --action=reset

  # Capture one rep (hold pose; script samples last --seconds of RAW)
  python -B calibrate_pose.py --side=right --action=capture --pose=unoccupied --seconds=15
  python -B calibrate_pose.py --side=right --action=capture --pose=center --seconds=15
  ...

  # Status / finalize
  python -B calibrate_pose.py --side=right --action=status
  python -B calibrate_pose.py --side=right --action=finalize

JSON is printed to stdout for the Node API / Sensors wizard.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import platform
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cbor2
import numpy as np

sys.path.append(os.getcwd())
if platform.system().lower() == 'linux':
    sys.path.append('/home/dac/free-sleep/biometrics/')

from get_logger import get_logger

logger = get_logger('calibrate-sensor')

from data_types import Side

try:
    from cap_data import save_baseline
    from presence_config import (
        DEFAULT_CAP_METHOD,
        DEFAULT_CAP_ZONE_THRESHOLD,
        DEFAULT_PIEZO_RANGE_THRESHOLD,
        load_sensor_profile,
        pose_session_path,
    )
except ImportError:
    from sleep_detection.cap_data import save_baseline
    from sleep_detection.presence_config import (
        DEFAULT_CAP_METHOD,
        DEFAULT_CAP_ZONE_THRESHOLD,
        DEFAULT_PIEZO_RANGE_THRESHOLD,
        load_sensor_profile,
        pose_session_path,
    )

POSES = ('unoccupied', 'center', 'inner', 'outer')
MIN_REPS = 2
FOLDER_PATH = '/persistent/' if platform.system().lower() == 'linux' else (
    os.environ.get('RAW_DATA_FOLDER') or '/persistent/'
)
# How much of each RAW file to scan from the end (same idea as live Sensors dump)
RAW_TAIL_BYTES = 2 * 1024 * 1024
RAW_FILES_TO_SCAN = 3


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_session(side: Side) -> Dict[str, Any]:
    return {
        'side': side,
        'version': 1,
        'created_at': _now_iso(),
        'updated_at': _now_iso(),
        'reps': {pose: [] for pose in POSES},
        'min_reps': MIN_REPS,
    }


def load_session(side: Side) -> Dict[str, Any]:
    path = pose_session_path(side)
    if not os.path.isfile(path):
        return _empty_session(side)
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            return _empty_session(side)
        data.setdefault('reps', {pose: [] for pose in POSES})
        for pose in POSES:
            data['reps'].setdefault(pose, [])
        data['side'] = side
        return data
    except Exception:
        return _empty_session(side)


def save_session(side: Side, session: Dict[str, Any]) -> str:
    path = pose_session_path(side)
    folder = os.path.dirname(path)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
    session['updated_at'] = _now_iso()
    # Atomic write so a partial file is never left behind
    tmp_path = f'{path}.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as handle:
        json.dump(session, handle, indent=2)
    os.replace(tmp_path, path)
    try:
        os.chmod(path, 0o664)
    except OSError:
        pass
    return path


def session_status(session: Dict[str, Any]) -> Dict[str, Any]:
    counts = {pose: len(session['reps'].get(pose, [])) for pose in POSES}
    ready = all(counts[pose] >= MIN_REPS for pose in POSES)
    missing = [pose for pose in POSES if counts[pose] < MIN_REPS]
    return {
        'side': session.get('side'),
        'counts': counts,
        'min_reps': MIN_REPS,
        'ready_to_finalize': ready,
        'missing_poses': missing,
        'updated_at': session.get('updated_at'),
        'created_at': session.get('created_at'),
        'reps': session.get('reps', {}),
    }


def _find_latest_raw_files(folder: str, limit: int = RAW_FILES_TO_SCAN) -> List[Path]:
    """Newest .RAW files by mtime (same source as live Sensors dump)."""
    root = Path(folder)
    if not root.is_dir():
        return []
    candidates = [
        path for path in root.glob('*.RAW')
        if path.is_file() and path.name != 'SEQNO.RAW'
    ]
    candidates.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return candidates[:limit]


def _parse_ts(value) -> Optional[datetime]:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    if isinstance(value, str):
        try:
            # ISO or "YYYY-MM-DD HH:MM:SS"
            cleaned = value.replace('Z', '+00:00')
            if 'T' not in cleaned and ' ' in cleaned:
                cleaned = cleaned.replace(' ', 'T', 1)
            dt = datetime.fromisoformat(cleaned)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            return None
    return None


def _read_tail_records(path: Path, tail_bytes: int = RAW_TAIL_BYTES) -> List[dict]:
    """Decode CBOR records from the end of a RAW file (Sensors dump style)."""
    try:
        size = path.stat().st_size
    except OSError:
        return []
    start = max(0, size - tail_bytes)
    try:
        with open(path, 'rb') as handle:
            handle.seek(start)
            data = handle.read()
    except OSError:
        return []

    records: List[dict] = []
    bio = io.BytesIO(data)
    while bio.tell() < len(data):
        pos = bio.tell()
        try:
            row = cbor2.load(bio)
        except Exception:
            bio.seek(pos + 1)
            continue
        try:
            if isinstance(row, dict) and 'data' in row:
                decoded = cbor2.loads(row['data'])
            elif isinstance(row, dict) and 'type' in row:
                decoded = row
            else:
                continue
            if isinstance(decoded, dict) and 'type' in decoded:
                records.append(decoded)
        except Exception:
            continue
    return records


def _piezo_range_from_bytes(raw_bytes: bytes) -> Optional[int]:
    if not raw_bytes or len(raw_bytes) < 4:
        return None
    # int64 avoids overflow when max−min spans large int32 extremes
    samples = np.frombuffer(raw_bytes, dtype=np.int32).astype(np.int64)
    if samples.size == 0:
        return None
    return int(samples.max() - samples.min())


def _collect_live_samples(
    side: Side,
    seconds: int,
) -> Tuple[List[Dict[str, Any]], List[float]]:
    """
    Sample the newest RAW tail(s) for cap zones + piezo packet ranges.

    Does NOT use load_raw_files(time window): that path skips mid-file data when
    the query window is only a few seconds (common Guided Calibration case).
    Instead we scan the same live RAW stream the Sensors UI uses.
    """
    files = _find_latest_raw_files(FOLDER_PATH)
    if not files:
        raise RuntimeError(
            f'No .RAW files under {FOLDER_PATH}. '
            'Sensor capture needs cloud/internet blocked so the Pod writes RAW data.'
        )

    cap_rows: List[Dict[str, Any]] = []
    piezo_ranges: List[Tuple[datetime, float]] = []

    for path in files:
        for row in _read_tail_records(path):
            ts = _parse_ts(row.get('ts'))
            if ts is None:
                continue
            rtype = row.get('type')
            if rtype == 'capSense':
                side_obj = row.get(side)
                if not isinstance(side_obj, dict):
                    continue
                try:
                    cap_rows.append({
                        'ts': ts,
                        'out': float(side_obj['out']),
                        'cen': float(side_obj['cen']),
                        'in': float(side_obj['in']),
                    })
                except (KeyError, TypeError, ValueError):
                    continue
            elif rtype == 'piezo-dual':
                raw = row.get(f'{side}1')
                if raw is None or not isinstance(raw, (bytes, bytearray)):
                    continue
                packet_range = _piezo_range_from_bytes(bytes(raw))
                if packet_range is not None:
                    piezo_ranges.append((ts, float(packet_range)))

    if not cap_rows:
        raise RuntimeError(
            f'Found {len(files)} RAW file(s) but no capSense frames in the recent tail. '
            'Wait a few seconds for capture to write, then try again.'
        )

    cap_rows.sort(key=lambda row: row['ts'])
    piezo_ranges.sort(key=lambda pair: pair[0])

    # Prefer wall-clock last `seconds`, but fall back to the newest N samples in
    # the file if the short time filter empties the set (clock skew / sparse ts).
    newest_ts = cap_rows[-1]['ts']
    cut = newest_ts.timestamp() - max(5, seconds)
    windowed = [row for row in cap_rows if row['ts'].timestamp() >= cut]
    if len(windowed) < 3:
        # Last ~seconds samples at ~1 Hz expected
        windowed = cap_rows[-max(5, seconds):]

    if len(windowed) < 3:
        raise RuntimeError(
            f'Too few cap samples ({len(windowed)}). Hold the pose and try again.'
        )

    piezo_windowed = [
        value for ts, value in piezo_ranges
        if ts.timestamp() >= cut
    ]
    if len(piezo_windowed) < 3 and piezo_ranges:
        piezo_windowed = [value for _, value in piezo_ranges[-max(5, seconds):]]

    return windowed, piezo_windowed


def _sample_window(side: Side, seconds: int) -> Dict[str, Any]:
    """
    Hold-window sample: wait `seconds` so new RAW frames accumulate, then
    read the live RAW tail and compute zone/piezo stats for this side.
    """
    # Wait first so the pose is held while firmware writes samples
    hold = max(3, int(seconds))
    logger.info(f'Sampling {side} live RAW for ~{hold}s (tail of newest files)…')
    time.sleep(hold)

    cap_rows, piezo_ranges = _collect_live_samples(side, seconds=hold)

    zones: Dict[str, Dict[str, float]] = {}
    for zone in ('out', 'cen', 'in'):
        series = np.array([row[zone] for row in cap_rows], dtype=float)
        zones[zone] = {
            'mean': float(series.mean()),
            'std': float(max(series.std(ddof=0), 1.0)),
            'p10': float(np.quantile(series, 0.10)),
            'p50': float(np.quantile(series, 0.50)),
            'p90': float(np.quantile(series, 0.90)),
            'n': int(series.size),
        }

    piezo_stats: Dict[str, Any] = {'available': False}
    if piezo_ranges:
        arr = np.array(piezo_ranges, dtype=float)
        piezo_stats = {
            'available': True,
            'mean': float(arr.mean()),
            'p50': float(np.quantile(arr, 0.50)),
            'p90': float(np.quantile(arr, 0.90)),
            'p95': float(np.quantile(arr, 0.95)),
            'p99': float(np.quantile(arr, 0.99)),
            'max': float(arr.max()),
            'n': int(arr.size),
        }

    return {
        'ts': _now_iso(),
        'seconds': hold,
        'sample_count': int(len(cap_rows)),
        'window_start': cap_rows[0]['ts'].isoformat(),
        'window_end': cap_rows[-1]['ts'].isoformat(),
        'zones': zones,
        'piezo': piezo_stats,
    }


def capture_pose(side: Side, pose: str, seconds: int, settle: float = 1.0) -> Dict[str, Any]:
    if pose not in POSES:
        raise ValueError(f'pose must be one of {POSES}')

    # Brief settle so the user can finish getting into position after click
    if settle > 0:
        time.sleep(settle)

    # _sample_window itself holds for `seconds` while RAW accumulates
    sample = _sample_window(side, seconds)
    session = load_session(side)
    session['reps'][pose].append(sample)
    path = save_session(side, session)
    status = session_status(session)
    return {
        'ok': True,
        'action': 'capture',
        'pose': pose,
        'rep_index': len(session['reps'][pose]),
        'sample': sample,
        'session_path': path,
        'status': status,
    }


def reset_session(side: Side) -> Dict[str, Any]:
    session = _empty_session(side)
    path = save_session(side, session)
    return {
        'ok': True,
        'action': 'reset',
        'session_path': path,
        'status': session_status(session),
    }


def _pool_zone_means(reps: List[Dict[str, Any]], zone: str) -> List[float]:
    values = []
    for rep in reps:
        z = rep.get('zones', {}).get(zone)
        if z and 'mean' in z:
            values.append(float(z['mean']))
    return values


def _pool_piezo_metric(reps: List[Dict[str, Any]], key: str = 'p95') -> List[float]:
    values = []
    for rep in reps:
        piezo = rep.get('piezo') or {}
        if piezo.get('available') and key in piezo:
            values.append(float(piezo[key]))
    return values


def finalize_session(side: Side) -> Dict[str, Any]:
    session = load_session(side)
    status = session_status(session)
    if not status['ready_to_finalize']:
        return {
            'ok': False,
            'action': 'finalize',
            'error': (
                f'Need ≥{MIN_REPS} reps of each pose. Missing: {status["missing_poses"]}. '
                f'Counts: {status["counts"]}'
            ),
            'status': status,
        }

    unoccupied = session['reps']['unoccupied']
    center = session['reps']['center']
    inner = session['reps']['inner']
    outer = session['reps']['outer']

    # Empty baseline: mean of rep means (2+ unoccupied captures averaged).
    # Std = max(avg within-rep std, rep-to-rep std of means, min_std=5).
    cap_baseline: Dict[str, Dict[str, float]] = {}
    empty_means: Dict[str, float] = {}
    empty_stds: Dict[str, float] = {}
    for zone in ('out', 'cen', 'in'):
        means = _pool_zone_means(unoccupied, zone)
        stds = []
        for rep in unoccupied:
            z = rep.get('zones', {}).get(zone)
            if z and 'std' in z:
                stds.append(float(z['std']))
        mean = float(np.mean(means))  # average the two (or more) rep means
        # Prefer observed empty std, floor at 5 for stability (legacy min_std)
        std = float(max(np.mean(stds) if stds else 5.0, 5.0))
        # Also widen std if rep-to-rep mean variance is larger
        if len(means) >= 2:
            rep_std = float(np.std(means, ddof=1))
            std = max(std, rep_std, 5.0)
        key = f'{side}_{zone}'
        cap_baseline[key] = {'mean': mean, 'std': std}
        empty_means[zone] = mean
        empty_stds[zone] = std

    # Occupied means by pose → zone they load most
    pose_zone_map = {
        'center': 'cen',
        'inner': 'in',
        'outer': 'out',
    }
    occupied_means: Dict[str, float] = {}
    separation_z: Dict[str, float] = {}
    for pose, zone in pose_zone_map.items():
        reps = session['reps'][pose]
        means = _pool_zone_means(reps, zone)
        if not means:
            continue
        occ_mean = float(np.mean(means))  # average the two (or more) occupied rep means
        occupied_means[zone] = occ_mean
        sep = (occ_mean - empty_means[zone]) / (empty_stds[zone] or 1.0)
        separation_z[zone] = float(sep)

    # Cap threshold: fraction of the weakest occupied-zone separation so all
    # three poses clear the threshold. Fallback to default if separation is poor.
    positive_seps = [v for v in separation_z.values() if v > 0.5]
    if positive_seps:
        # Mid-point-ish of the weakest good separation, clamped to [1.2, 4.0]
        weakest = min(positive_seps)
        cap_zone_threshold = float(np.clip(weakest * 0.40, 1.2, 4.0))
    else:
        cap_zone_threshold = DEFAULT_CAP_ZONE_THRESHOLD
        logger.warning(
            f'{side} multi-pose finalize: weak zone separation {separation_z}; '
            f'using default cap_zone_threshold={cap_zone_threshold}'
        )

    # Piezo floor: above empty p99, below occupied p50 when available
    empty_piezo = _pool_piezo_metric(unoccupied, 'p99')
    occ_reps = center + inner + outer
    occ_piezo = _pool_piezo_metric(occ_reps, 'p50')

    if empty_piezo and occ_piezo:
        empty_hi = float(np.mean(empty_piezo))
        occ_lo = float(np.mean(occ_piezo))
        if occ_lo > empty_hi * 1.2:
            mid = empty_hi + (occ_lo - empty_hi) * 0.35
            piezo_floor = int(np.clip(mid, 25_000, 200_000))
        else:
            # Occupied piezo not cleanly above empty — use empty-based estimate
            piezo_floor = int(np.clip(max(empty_hi * 3.0, empty_hi + 15_000), 25_000, 150_000))
    elif empty_piezo:
        empty_hi = float(np.mean(empty_piezo))
        piezo_floor = int(np.clip(max(empty_hi * 3.0, empty_hi + 15_000), 25_000, 150_000))
    else:
        existing = load_sensor_profile(side)
        piezo_floor = int(
            existing.get('piezo_range_threshold') or DEFAULT_PIEZO_RANGE_THRESHOLD
        )

    extra = {
        'cap_method': DEFAULT_CAP_METHOD,
        'cap_zone_threshold': round(cap_zone_threshold, 3),
        'piezo_range_threshold': piezo_floor,
        'fusion_mode': 'piezo_primary',
        'source': 'multi_pose',
        'poses': {
            'counts': status['counts'],
            'separation_z': {k: round(v, 3) for k, v in separation_z.items()},
            'occupied_means': {k: round(v, 1) for k, v in occupied_means.items()},
            'empty_means': {k: round(v, 1) for k, v in empty_means.items()},
            'finalized_at': _now_iso(),
        },
        'session_snapshot': {
            'created_at': session.get('created_at'),
            'updated_at': session.get('updated_at'),
            'counts': status['counts'],
        },
    }

    path = save_baseline(side, cap_baseline, extra=extra)
    logger.info(
        f'{side} multi-pose finalized: cap_zone_threshold={cap_zone_threshold:.2f} '
        f'piezo_floor={piezo_floor:,} separation_z={separation_z} → {path}'
    )

    return {
        'ok': True,
        'action': 'finalize',
        'baseline_path': path,
        'cap_baseline': cap_baseline,
        'thresholds': {
            'cap_method': DEFAULT_CAP_METHOD,
            'cap_zone_threshold': round(cap_zone_threshold, 3),
            'piezo_range_threshold': piezo_floor,
            'separation_z': {k: round(v, 3) for k, v in separation_z.items()},
        },
        'status': status,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Multi-pose sensor calibration')
    parser.add_argument('--side', choices=['left', 'right'], required=True)
    parser.add_argument(
        '--action',
        choices=['capture', 'status', 'finalize', 'reset'],
        required=True,
    )
    parser.add_argument(
        '--pose',
        choices=list(POSES),
        help='Required for capture',
    )
    parser.add_argument(
        '--seconds',
        type=int,
        default=15,
        help='Seconds of RAW window to sample (capture)',
    )
    parser.add_argument(
        '--settle',
        type=float,
        default=1.0,
        help='Seconds to wait before sampling (capture)',
    )
    args = parser.parse_args()
    side: Side = args.side  # type: ignore

    try:
        if args.action == 'status':
            result = {
                'ok': True,
                'action': 'status',
                'status': session_status(load_session(side)),
                'profile': load_sensor_profile(side) or None,
            }
        elif args.action == 'reset':
            result = reset_session(side)
        elif args.action == 'capture':
            if not args.pose:
                raise ValueError('--pose is required for capture')
            result = capture_pose(side, args.pose, args.seconds, settle=args.settle)
        elif args.action == 'finalize':
            result = finalize_session(side)
        else:
            raise ValueError(f'Unknown action {args.action}')

        print(json.dumps(result))
        return 0 if result.get('ok', True) else 1
    except Exception as error:
        logger.error(error)
        logger.error(traceback.format_exc())
        print(json.dumps({
            'ok': False,
            'action': args.action,
            'error': repr(error),
        }))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
