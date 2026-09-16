#!/usr/bin/env python3
"""
Dump the latest capSense + piezo-dual sample for one side from the newest .RAW file,
plus empty-bed calibration baselines and presence thresholds used by sleep analysis.

Usage:
  /home/dac/venv/bin/python -B dump_sensor_snapshot.py --side=right
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import cbor2
import numpy as np

# Allow importing sleep_detection.presence_config when run as a script
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

RAW_DIRS = [
    '/persistent',
    os.environ.get('RAW_DATA_FOLDER') or '',
]

DATA_FOLDERS = [
    '/persistent/free-sleep-data/',
    os.environ.get('DATA_FOLDER') or '',
]


def _import_presence_config():
    """Import presence_config with fallbacks when logger folder isn't set up."""
    try:
        from sleep_detection.presence_config import (  # type: ignore
            thresholds_for_snapshot,
            load_sensor_profile,
            get_piezo_range_threshold,
            get_cap_zone_threshold,
            get_cap_method,
            DEFAULT_CAP_ZONE_THRESHOLD,
            DEFAULT_PIEZO_RANGE_THRESHOLD,
        )
        return {
            'thresholds_for_snapshot': thresholds_for_snapshot,
            'load_sensor_profile': load_sensor_profile,
            'get_piezo_range_threshold': get_piezo_range_threshold,
            'get_cap_zone_threshold': get_cap_zone_threshold,
            'get_cap_method': get_cap_method,
            'DEFAULT_CAP_ZONE_THRESHOLD': DEFAULT_CAP_ZONE_THRESHOLD,
            'DEFAULT_PIEZO_RANGE_THRESHOLD': DEFAULT_PIEZO_RANGE_THRESHOLD,
        }
    except Exception:
        # Minimal fallback if biometrics logger / deps aren't available
        def thresholds_for_snapshot(side: str):
            return {
                'cap': {
                    'method': 'max_z',
                    'occupancyThreshold': 2.0,
                    'rollingSeconds': 10,
                    'thresholdPercent': 0.90,
                    'description': 'Cap: max of per-zone z-scores vs empty baseline.',
                },
                'piezo': {
                    'rangeThreshold': 50_000,
                    'rollingSeconds': 10,
                    'thresholdPercent': 0.70,
                    'personalized': False,
                    'description': 'Piezo: packet range ≥ 50,000 (default).',
                },
                'fusion': {
                    'mode': 'piezo_primary',
                    'description': 'Piezo-primary with cap soft assist (OR).',
                },
            }

        return {
            'thresholds_for_snapshot': thresholds_for_snapshot,
            'load_sensor_profile': lambda side: {},
            'get_piezo_range_threshold': lambda side, p=None: 50_000,
            'get_cap_zone_threshold': lambda side, p=None: 2.0,
            'get_cap_method': lambda side, p=None: 'max_z',
            'DEFAULT_CAP_ZONE_THRESHOLD': 2.0,
            'DEFAULT_PIEZO_RANGE_THRESHOLD': 50_000,
        }


_CFG = _import_presence_config()


def find_latest_raw() -> Path | None:
    candidates: list[Path] = []
    for folder in RAW_DIRS:
        if not folder or not os.path.isdir(folder):
            continue
        for path in Path(folder).glob('*.RAW'):
            if path.name == 'SEQNO.RAW':
                continue
            if path.is_file():
                candidates.append(path)
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def baseline_path(side: str) -> Path | None:
    name = f'{side}_cap_baseline.json'
    for folder in DATA_FOLDERS:
        if not folder:
            continue
        path = Path(folder) / name
        if path.is_file():
            return path
    for path in (
        Path('/persistent/free-sleep-data') / name,
        Path('/home/dac/free-sleep/server/free-sleep-data') / name,
    ):
        if path.is_file():
            return path
    return None


def load_cap_baseline(side: str) -> dict | None:
    path = baseline_path(side)
    if not path:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        zones = {}
        for zone in ('out', 'cen', 'in'):
            key = f'{side}_{zone}'
            if key in data and isinstance(data[key], dict):
                zones[zone] = {
                    'mean': float(data[key].get('mean', 0)),
                    'std': float(data[key].get('std', 1)) or 1.0,
                }
        if len(zones) != 3:
            return None
        return {
            'path': str(path),
            'zones': zones,
            'mtime': datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            'piezo_range_threshold': data.get('piezo_range_threshold'),
            'cap_zone_threshold': data.get('cap_zone_threshold'),
            'cap_method': data.get('cap_method'),
            'source': data.get('source'),
            'poses': data.get('poses'),
            'version': data.get('version'),
        }
    except Exception:
        return None


def compute_cap_vs_baseline(cap: dict, baseline: dict, occupancy_threshold: float, method: str) -> dict:
    """Per-zone z-score and max_z / sum_z score used by detect_presence_cap."""
    zones_out = {}
    z_scores = []
    for zone in ('out', 'cen', 'in'):
        mean = baseline['zones'][zone]['mean']
        std = baseline['zones'][zone]['std'] or 1.0
        value = float(cap[zone])
        z = (value - mean) / std
        z_scores.append(z)
        zones_out[zone] = {
            'value': value,
            'mean': mean,
            'std': std,
            'zScore': round(z, 3),
            'emptyLow': round(mean - 2 * std, 1),
            'emptyHigh': round(mean + 2 * std, 1),
            'aboveEmptyBand': value > mean + 2 * std,
        }
    max_z = max(z_scores)
    sum_z = sum(z_scores)
    score = max_z if method != 'sum_z' else sum_z
    return {
        'zones': zones_out,
        'maxZ': round(max_z, 3),
        'sumZ': round(sum_z, 3),
        # combinedZ kept for UI back-compat; now reflects active method score
        'combinedZ': round(score, 3),
        'method': method,
        'occupancyThreshold': occupancy_threshold,
        'aboveThreshold': score > occupancy_threshold,
        'note': (
            f'Single-sample {method}={score:.2f} vs threshold {occupancy_threshold}. '
            f'max_z={max_z:.2f} sum_z={sum_z:.2f}.'
        ),
    }


def piezo_stats(raw_bytes: bytes) -> dict | None:
    if not raw_bytes or len(raw_bytes) < 4:
        return None
    samples = np.frombuffer(raw_bytes, dtype=np.int32)
    if samples.size == 0:
        return None
    return {
        'avg': int(np.round(samples.mean())),
        'min': int(samples.min()),
        'max': int(samples.max()),
        'range': int(samples.max() - samples.min()),
        'sampleCount': int(samples.size),
    }


def parse_cap(side_obj) -> dict | None:
    if not isinstance(side_obj, dict):
        return None
    try:
        return {
            'out': int(side_obj['out']),
            'cen': int(side_obj['cen']),
            'in': int(side_obj['in']),
            'status': side_obj.get('status'),
        }
    except (KeyError, TypeError, ValueError):
        return None


def format_ts(ts) -> str:
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, timezone.utc).isoformat()
    return str(ts)


def read_tail_records(path: Path, tail_bytes: int = 256 * 1024) -> list[dict]:
    size = path.stat().st_size
    start = max(0, size - tail_bytes)
    with open(path, 'rb') as handle:
        handle.seek(start)
        data = handle.read()

    records: list[dict] = []
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--side', choices=['left', 'right'], default='right')
    args = parser.parse_args()
    side = args.side
    other = 'left' if side == 'right' else 'right'

    thresholds = _CFG['thresholds_for_snapshot'](side)
    piezo_floor = int(thresholds['piezo']['rangeThreshold'])
    cap_thresh = float(thresholds['cap']['occupancyThreshold'])
    cap_method = thresholds['cap'].get('method') or 'max_z'

    baseline = load_cap_baseline(side)
    # Prefer values embedded in the baseline file if present
    if baseline and baseline.get('piezo_range_threshold') is not None:
        try:
            piezo_floor = int(baseline['piezo_range_threshold'])
            thresholds['piezo']['rangeThreshold'] = piezo_floor
            thresholds['piezo']['personalized'] = True
        except (TypeError, ValueError):
            pass
    if baseline and baseline.get('cap_zone_threshold') is not None:
        try:
            cap_thresh = float(baseline['cap_zone_threshold'])
            thresholds['cap']['occupancyThreshold'] = cap_thresh
        except (TypeError, ValueError):
            pass
    if baseline and baseline.get('cap_method'):
        cap_method = baseline['cap_method']
        thresholds['cap']['method'] = cap_method

    path = find_latest_raw()
    now = datetime.now(timezone.utc).isoformat()
    if path is None:
        json.dump({
            'side': side,
            'timestamp': now,
            'thresholds': thresholds,
            'calibration': {
                'capBaseline': baseline,
                'missing': baseline is None,
                'hint': (
                    None if baseline else
                    f'No {side}_cap_baseline.json — run Status → Calibrate {side} '
                    f'or Sensors → Multi-pose calibration (empty bed required).'
                ),
            },
            'error': (
                'No .RAW files under /persistent. Sensor capture is written by the Pod '
                'firmware (usually when cloud/internet is blocked). Bed power ON is not '
                'required; being in bed is not required for empty-bed samples.'
            ),
        }, sys.stdout)
        return 0

    try:
        records = read_tail_records(path)
    except Exception as error:
        json.dump({
            'side': side,
            'timestamp': now,
            'sourceFile': path.name,
            'thresholds': thresholds,
            'calibration': {'capBaseline': baseline, 'missing': baseline is None},
            'error': f'Failed reading RAW: {error}',
        }, sys.stdout)
        return 0

    latest_cap = None
    latest_other = None
    latest_piezo1 = None
    latest_piezo2 = None

    for row in records:
        rtype = row.get('type')
        ts = format_ts(row.get('ts'))
        if rtype == 'capSense':
            mine = parse_cap(row.get(side))
            other_cap = parse_cap(row.get(other))
            if mine:
                mine['ts'] = ts
                latest_cap = mine
            if other_cap:
                other_cap['ts'] = ts
                latest_other = other_cap
        elif rtype == 'piezo-dual':
            for channel, key in (('1', f'{side}1'), ('2', f'{side}2')):
                raw = row.get(key)
                if raw is None or not isinstance(raw, (bytes, bytearray)):
                    continue
                stats = piezo_stats(bytes(raw))
                if not stats:
                    continue
                stats['ts'] = ts
                stats['channel'] = channel
                stats['rangeThreshold'] = piezo_floor
                stats['aboveThreshold'] = stats['range'] >= piezo_floor
                if channel == '1':
                    latest_piezo1 = stats
                else:
                    latest_piezo2 = stats

    mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()

    cap_eval = None
    if latest_cap and baseline:
        cap_eval = compute_cap_vs_baseline(
            latest_cap, baseline, cap_thresh, cap_method
        )

    if not latest_cap and not latest_piezo1 and not latest_piezo2:
        json.dump({
            'side': side,
            'timestamp': now,
            'sourceFile': path.name,
            'fileMtime': mtime,
            'thresholds': thresholds,
            'calibration': {
                'capBaseline': baseline,
                'missing': baseline is None,
                'hint': (
                    None if baseline else
                    f'No {side}_cap_baseline.json — run multi-pose or empty-bed calibration.'
                ),
            },
            'error': (
                f'Found {path.name} but no capSense/piezo-dual frames in the last ~256KB. '
                f'Records decoded: {len(records)}.'
            ),
            'recordsInTail': len(records),
        }, sys.stdout)
        return 0

    live_verdict = 'unknown'
    if cap_eval is not None and latest_piezo1 is not None:
        cap_on = cap_eval['aboveThreshold']
        piezo_on = latest_piezo1.get('aboveThreshold', False)
        if cap_on and piezo_on:
            live_verdict = 'likely_occupied'
        elif not cap_on and not piezo_on:
            live_verdict = 'likely_empty'
        elif piezo_on and not cap_on:
            live_verdict = 'piezo_only'
        elif cap_on and not piezo_on:
            live_verdict = 'cap_only'
    elif latest_piezo1 is not None:
        live_verdict = 'piezo_only' if latest_piezo1.get('aboveThreshold') else 'likely_empty'
    elif cap_eval is not None:
        live_verdict = 'cap_only' if cap_eval['aboveThreshold'] else 'likely_empty'

    json.dump({
        'side': side,
        'timestamp': now,
        'sourceFile': path.name,
        'fileMtime': mtime,
        'cap': latest_cap,
        'piezo1': latest_piezo1,
        'piezo2': latest_piezo2,
        'otherCap': latest_other,
        'recordsInTail': len(records),
        'thresholds': thresholds,
        'calibration': {
            'capBaseline': baseline,
            'missing': baseline is None,
            'capEvaluation': cap_eval,
            'hint': (
                None if baseline else
                f'No {side}_cap_baseline.json — run Sensors multi-pose or Status empty-bed calibration.'
            ),
        },
        'liveVerdict': live_verdict,
    }, sys.stdout)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
