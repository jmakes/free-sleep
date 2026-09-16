#!/usr/bin/env python3
"""
Schedule-prior auto presence calibration (beta).

Uses each side's power schedule as a soft prior for likely in-bed vs empty
windows, fits empty/occupied distributions from RAW, and blends into
`{side}_cap_baseline.json`.

Disable via settings.beta.autoPresenceCalibration.enabled (Node job gates this).
Piezo floor is hard-clamped to ≥ MIN_PIEZO_FLOOR_AUTO to limit cross-talk.
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import platform
import sys
import traceback
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

sys.path.append(os.getcwd())
if platform.system().lower() == 'linux':
    sys.path.append('/home/dac/free-sleep/biometrics/')

from get_logger import get_logger

logger = get_logger('auto-calibrate')

from load_raw_files import load_raw_files
from piezo_data import load_piezo_df
from resource_usage import get_available_memory_mb
from service_health import update_health, is_biometrics_enabled

try:
    from cap_data import load_cap_df, save_baseline
    from presence_config import (
        AUTO_CAL_BLEND,
        AUTO_CAL_HISTORY_MAX,
        AUTO_CAL_LOOKBACK_DAYS,
        AUTO_CAL_MIN_EMPTY_SAMPLES,
        AUTO_CAL_MIN_OCC_SAMPLES,
        DEFAULT_CAP_METHOD,
        DEFAULT_CAP_ZONE_THRESHOLD,
        DEFAULT_PIEZO_RANGE_THRESHOLD,
        MAX_PIEZO_FLOOR_AUTO,
        MIN_PIEZO_FLOOR_AUTO,
        data_folder,
        load_sensor_profile,
    )
except ImportError:
    from sleep_detection.cap_data import load_cap_df, save_baseline
    from sleep_detection.presence_config import (
        AUTO_CAL_BLEND,
        AUTO_CAL_HISTORY_MAX,
        AUTO_CAL_LOOKBACK_DAYS,
        AUTO_CAL_MIN_EMPTY_SAMPLES,
        AUTO_CAL_MIN_OCC_SAMPLES,
        DEFAULT_CAP_METHOD,
        DEFAULT_CAP_ZONE_THRESHOLD,
        DEFAULT_PIEZO_RANGE_THRESHOLD,
        MAX_PIEZO_FLOOR_AUTO,
        MIN_PIEZO_FLOOR_AUTO,
        data_folder,
        load_sensor_profile,
    )

FOLDER_PATH = '/persistent/' if platform.system().lower() == 'linux' else (
    os.environ.get('RAW_DATA_FOLDER') or '/persistent/'
)
DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']


def _lowdb_path(name: str) -> Path:
    return Path(data_folder()) / 'lowdb' / name


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    with open(path, 'r', encoding='utf-8') as handle:
        data = json.load(handle)
    return data if isinstance(data, dict) else {}


def _parse_hhmm(value: str) -> Tuple[int, int]:
    hour, minute = value.split(':')
    return int(hour), int(minute)


def _schedule_windows_for_day(
    side_schedule: Dict[str, Any],
    day_local: datetime,
) -> List[Tuple[datetime, datetime]]:
    """Return local-tz aware [start, end) power-on windows for this calendar day."""
    day_name = DAY_NAMES[day_local.weekday()]
    daily = (side_schedule or {}).get(day_name) or {}
    power = daily.get('power') or {}
    if not power.get('enabled'):
        return []
    on_h, on_m = _parse_hhmm(power.get('on', '21:00'))
    off_h, off_m = _parse_hhmm(power.get('off', '07:00'))
    start = day_local.replace(hour=on_h, minute=on_m, second=0, microsecond=0)
    end = day_local.replace(hour=off_h, minute=off_m, second=0, microsecond=0)
    if end <= start:
        end = end + timedelta(days=1)
    return [(start, end)]


def _in_any_window(ts: pd.Timestamp, windows: List[Tuple[datetime, datetime]], buffer: timedelta) -> bool:
    t = ts.to_pydatetime()
    if t.tzinfo is None:
        # compare naive to naive
        for start, end in windows:
            s = start.replace(tzinfo=None) if start.tzinfo else start
            e = end.replace(tzinfo=None) if end.tzinfo else end
            if (s - buffer) <= t < (e + buffer):
                return True
        return False
    for start, end in windows:
        s = start if start.tzinfo else start.replace(tzinfo=t.tzinfo)
        e = end if end.tzinfo else end.replace(tzinfo=t.tzinfo)
        if (s - buffer) <= t < (e + buffer):
            return True
    return False


def _piezo_range_series(piezo_df: pd.DataFrame, side: str, window: int = 10) -> pd.Series:
    col = f'{side}1_avg'
    if col not in piezo_df.columns:
        return pd.Series(dtype=float)
    rolling_min = piezo_df[col].rolling(window=window, center=True, min_periods=3).min()
    rolling_max = piezo_df[col].rolling(window=window, center=True, min_periods=3).max()
    return (rolling_max - rolling_min).abs()


def _accumulate_day(
    side: str,
    day_start_utc: datetime,
    day_end_utc: datetime,
    schedule_windows_local: List[Tuple[datetime, datetime]],
    empty_caps: Dict[str, List[float]],
    occ_caps: Dict[str, List[float]],
    empty_piezo: List[float],
    occ_piezo: List[float],
) -> None:
    expected = int((day_end_utc - day_start_utc).total_seconds())
    if get_available_memory_mb() < 350:
        logger.warning(f'Skipping {day_start_utc.date()} — low memory ({get_available_memory_mb()} MB)')
        return
    try:
        data = load_raw_files(
            FOLDER_PATH,
            day_start_utc,
            day_end_utc,
            side,  # type: ignore
            sensor_count=1,
            raw_data_types=['capSense', 'piezo-dual'],
        )
    except Exception as error:
        logger.warning(f'RAW load failed for {day_start_utc.date()}: {error}')
        return

    if not data.get('cap_senses') and not data.get('piezo_dual'):
        del data
        gc.collect()
        return

    try:
        piezo_df = load_piezo_df(data, side, expected_row_count=expected)  # type: ignore
        cap_df = load_cap_df(data, side, expected_row_count=expected)  # type: ignore
    except Exception as error:
        logger.warning(f'Failed building dfs for {day_start_utc.date()}: {error}')
        del data
        gc.collect()
        return
    finally:
        del data
        gc.collect()

    if piezo_df.empty or cap_df.empty:
        return

    merged = piezo_df.merge(cap_df, left_index=True, right_index=True, how='inner')
    if merged.empty:
        return

    ranges = _piezo_range_series(merged, side)
    merged = merged.assign(_piezo_range=ranges).dropna(subset=['_piezo_range'])
    # Downsample to ~5s to keep lists small
    merged = merged.resample('5s').median().dropna()

    buffer = timedelta(minutes=30)
    zone_cols = [f'{side}_out', f'{side}_cen', f'{side}_in']
    for ts, row in merged.iterrows():
        in_sched = _in_any_window(ts, schedule_windows_local, buffer)
        pr = float(row['_piezo_range'])
        if not in_sched:
            # Likely empty prior — only keep quiet piezo samples
            empty_piezo.append(pr)
            for col in zone_cols:
                if col in row and np.isfinite(row[col]):
                    empty_caps[col.split('_')[-1]].append(float(row[col]))
        else:
            # Likely in-bed prior — keep salient samples (motion or will filter later)
            occ_piezo.append(pr)
            for col in zone_cols:
                if col in row and np.isfinite(row[col]):
                    occ_caps[col.split('_')[-1]].append(float(row[col]))

    del piezo_df, cap_df, merged
    gc.collect()


def _robust_mean_std(values: List[float], min_std: float = 5.0) -> Tuple[float, float]:
    arr = np.asarray(values, dtype=float)
    arr = arr[np.isfinite(arr)]
    if arr.size == 0:
        return float('nan'), float('nan')
    # Trim extremes
    lo, hi = np.percentile(arr, [5, 95])
    clipped = arr[(arr >= lo) & (arr <= hi)]
    if clipped.size < 10:
        clipped = arr
    mean = float(np.mean(clipped))
    std = float(max(np.std(clipped), min_std))
    return mean, std


def _blend(old: Optional[float], new: float, weight: float = AUTO_CAL_BLEND) -> float:
    if old is None or not np.isfinite(old):
        return new
    return float(weight * new + (1.0 - weight) * float(old))


def run_auto_cal(side: str, days: int, apply: bool) -> Dict[str, Any]:
    settings = _load_json(_lowdb_path('settingsDB.json'))
    schedules = _load_json(_lowdb_path('schedulesDB.json'))
    tz_name = settings.get('timeZone') or 'UTC'
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = timezone.utc

    side_schedule = (schedules.get(side) or {})
    now_local = datetime.now(tz)
    empty_caps: Dict[str, List[float]] = defaultdict(list)
    occ_caps: Dict[str, List[float]] = defaultdict(list)
    empty_piezo: List[float] = []
    occ_piezo: List[float] = []

    for day_offset in range(1, days + 1):
        # Look at completed local days (yesterday back)
        day_local = (now_local - timedelta(days=day_offset)).replace(
            hour=12, minute=0, second=0, microsecond=0
        )
        window_start_local = day_local
        window_end_local = day_local + timedelta(days=1)
        # Schedule windows that overlap this 12:00–12:00 span (yesterday evening + this morning)
        prev_day = day_local - timedelta(days=1)
        windows = _schedule_windows_for_day(side_schedule, prev_day) + _schedule_windows_for_day(
            side_schedule, day_local
        )
        start_utc = window_start_local.astimezone(timezone.utc).replace(tzinfo=None)
        end_utc = window_end_local.astimezone(timezone.utc).replace(tzinfo=None)
        # validate_datetime_utc expects naive UTC in some call sites — keep naive UTC
        _accumulate_day(
            side,
            start_utc.replace(tzinfo=timezone.utc),
            end_utc.replace(tzinfo=timezone.utc),
            windows,
            empty_caps,
            occ_caps,
            empty_piezo,
            occ_piezo,
        )
        logger.info(
            f'{side} day={day_local.date()} empty_n={len(empty_piezo)} occ_n={len(occ_piezo)}'
        )

    report: Dict[str, Any] = {
        'side': side,
        'days': days,
        'empty_piezo_samples': len(empty_piezo),
        'occ_piezo_samples': len(occ_piezo),
        'zones': {},
        'applied': False,
    }

    if len(empty_piezo) < AUTO_CAL_MIN_EMPTY_SAMPLES:
        report['ok'] = False
        report['error'] = (
            f'Not enough likely-empty samples ({len(empty_piezo)} < {AUTO_CAL_MIN_EMPTY_SAMPLES}). '
            'Need quieter off-schedule windows.'
        )
        return report

    # Refine occupied: require piezo above empty p90 * 1.25 (salience)
    empty_p90 = float(np.percentile(empty_piezo, 90))
    salience = max(empty_p90 * 1.25, empty_p90 + 5_000)
    # Rebuild occ zone samples filtered by matching piezo salience — approximate by
    # keeping top motion half of occ_piezo and corresponding zone values already pooled.
    # Simpler: keep occ_caps as-is but require enough occ_piezo above salience.
    salient_occ_piezo = [v for v in occ_piezo if v >= salience]
    report['empty_piezo_p90'] = int(empty_p90)
    report['salience_piezo'] = int(salience)
    report['salient_occ_piezo_samples'] = len(salient_occ_piezo)

    if len(salient_occ_piezo) < AUTO_CAL_MIN_OCC_SAMPLES // 2:
        report['ok'] = False
        report['error'] = (
            f'Not enough salient in-bed piezo samples ({len(salient_occ_piezo)}). '
            'Schedule prior may not match real occupancy, or sensors too quiet.'
        )
        return report

    existing = load_sensor_profile(side)
    cap_baseline: Dict[str, Dict[str, float]] = {}
    separation_z: Dict[str, float] = {}
    occupied_means: Dict[str, float] = {}
    empty_means: Dict[str, float] = {}
    empty_stds: Dict[str, float] = {}
    weak_zones: List[str] = []

    for zone in ('out', 'cen', 'in'):
        e_vals = empty_caps.get(zone) or []
        o_vals = occ_caps.get(zone) or []
        if len(e_vals) < AUTO_CAL_MIN_EMPTY_SAMPLES // 3:
            weak_zones.append(zone)
            report['zones'][zone] = {'ok': False, 'reason': 'insufficient_empty'}
            continue
        e_mean, e_std = _robust_mean_std(e_vals)
        if not np.isfinite(e_mean):
            weak_zones.append(zone)
            continue
        # Occupied: prefer values clearly above empty
        o_arr = np.asarray(o_vals, dtype=float)
        o_arr = o_arr[np.isfinite(o_arr)]
        o_hi = o_arr[o_arr >= (e_mean + 0.5 * e_std)] if o_arr.size else o_arr
        if o_hi.size < 50:
            # Still record empty baseline; mark weak separation
            weak_zones.append(zone)
            o_mean = float(np.median(o_arr)) if o_arr.size else e_mean
            sep = (o_mean - e_mean) / (e_std or 1.0)
        else:
            o_mean = float(np.median(o_hi))
            sep = (o_mean - e_mean) / (e_std or 1.0)

        # Blend empty baseline with existing
        old_zone = existing.get(f'{side}_{zone}') or {}
        blended_mean = _blend(old_zone.get('mean'), e_mean)
        blended_std = _blend(old_zone.get('std'), e_std)
        blended_std = float(max(blended_std, 5.0))
        cap_baseline[f'{side}_{zone}'] = {'mean': blended_mean, 'std': blended_std}
        empty_means[zone] = blended_mean
        empty_stds[zone] = blended_std
        occupied_means[zone] = o_mean
        separation_z[zone] = float(sep)
        report['zones'][zone] = {
            'ok': True,
            'empty_mean': round(blended_mean, 1),
            'empty_std': round(blended_std, 1),
            'occupied_mean': round(o_mean, 1),
            'separation_z': round(float(sep), 2),
            'weak': zone in weak_zones or sep < 1.0,
        }

    if len(cap_baseline) < 1:
        report['ok'] = False
        report['error'] = 'No zones produced an empty baseline'
        return report

    positive_seps = [v for z, v in separation_z.items() if v > 0.8 and z not in weak_zones]
    if not positive_seps:
        positive_seps = [v for v in separation_z.values() if v > 0.5]
    if positive_seps:
        weakest = min(positive_seps)
        # Smaller swings → lower threshold (catch worn pads); clamp sane range
        cap_zone_threshold = float(np.clip(weakest * 0.35, 1.0, 3.5))
    else:
        cap_zone_threshold = DEFAULT_CAP_ZONE_THRESHOLD

    old_cap = existing.get('cap_zone_threshold')
    cap_zone_threshold = _blend(float(old_cap) if old_cap is not None else None, cap_zone_threshold)

    # Piezo floor: between empty p95 and salient occupied p50, clamped for cross-talk
    empty_p95 = float(np.percentile(empty_piezo, 95))
    occ_p50 = float(np.percentile(salient_occ_piezo, 50))
    if occ_p50 > empty_p95 * 1.15:
        mid = empty_p95 + (occ_p50 - empty_p95) * 0.40
    else:
        mid = max(empty_p95 * 2.5, empty_p95 + 20_000)
    piezo_floor = int(np.clip(mid, MIN_PIEZO_FLOOR_AUTO, MAX_PIEZO_FLOOR_AUTO))
    old_piezo = existing.get('piezo_range_threshold')
    if old_piezo is not None:
        piezo_floor = int(_blend(float(old_piezo), float(piezo_floor)))
        piezo_floor = int(np.clip(piezo_floor, MIN_PIEZO_FLOOR_AUTO, MAX_PIEZO_FLOOR_AUTO))

    report['thresholds'] = {
        'cap_method': DEFAULT_CAP_METHOD,
        'cap_zone_threshold': round(cap_zone_threshold, 3),
        'piezo_range_threshold': piezo_floor,
        'separation_z': {k: round(v, 2) for k, v in separation_z.items()},
        'weak_zones': weak_zones,
        'empty_piezo_p95': int(empty_p95),
        'occ_piezo_p50': int(occ_p50),
    }
    report['ok'] = True

    history = list(existing.get('auto_cal_history') or [])
    history.append({
        'at': datetime.now(timezone.utc).isoformat(),
        'thresholds': report['thresholds'],
        'days': days,
        'empty_n': len(empty_piezo),
        'occ_salient_n': len(salient_occ_piezo),
    })
    history = history[-AUTO_CAL_HISTORY_MAX:]

    if not apply:
        report['applied'] = False
        report['note'] = 'dry-run — profile not written'
        # Still write a proposal file for inspection
        proposal_path = Path(data_folder()) / f'{side}_auto_cal_proposal.json'
        with open(proposal_path, 'w', encoding='utf-8') as handle:
            json.dump(report, handle, indent=2)
        report['proposal_path'] = str(proposal_path)
        return report

    extra = {
        'cap_method': DEFAULT_CAP_METHOD,
        'cap_zone_threshold': round(cap_zone_threshold, 3),
        'piezo_range_threshold': piezo_floor,
        'fusion_mode': 'piezo_primary',
        'source': 'auto_presence',
        'auto_cal': {
            'finalized_at': datetime.now(timezone.utc).isoformat(),
            'lookback_days': days,
            'blend': AUTO_CAL_BLEND,
            'separation_z': {k: round(v, 3) for k, v in separation_z.items()},
            'occupied_means': {k: round(v, 1) for k, v in occupied_means.items()},
            'empty_means': {k: round(v, 1) for k, v in empty_means.items()},
            'weak_zones': weak_zones,
            'min_piezo_floor': MIN_PIEZO_FLOOR_AUTO,
        },
        'auto_cal_history': history,
    }
    # Keep pose metadata if present (don't wipe guided cal history)
    if existing.get('poses'):
        extra['poses'] = existing['poses']

    path = save_baseline(side, cap_baseline, extra=extra)
    report['applied'] = True
    report['baseline_path'] = path
    logger.info(
        f'{side} auto-cal applied: cap_z={cap_zone_threshold:.2f} '
        f'piezo_floor={piezo_floor:,} weak={weak_zones} → {path}'
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description='Schedule-prior auto presence calibration')
    parser.add_argument('--side', choices=['left', 'right'], required=True)
    parser.add_argument('--days', type=int, default=AUTO_CAL_LOOKBACK_DAYS)
    parser.add_argument(
        '--apply',
        action='store_true',
        help='Write blended profile (default is dry-run proposal only)',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Force proposal-only (overrides --apply)',
    )
    args = parser.parse_args()
    side = args.side
    job_key = f'autoCalibrate{side.capitalize()}'

    try:
        if not is_biometrics_enabled():
            msg = 'Biometrics disabled — skipping auto-cal'
            logger.info(msg)
            update_health(job_key, 'healthy', msg)
            print(json.dumps({'ok': False, 'skipped': True, 'reason': msg}))
            return 0

        update_health(job_key, 'started', f'Auto-cal {side} over {args.days}d…')
        apply = bool(args.apply) and not bool(args.dry_run)
        report = run_auto_cal(side, days=max(3, min(args.days, 28)), apply=apply)
        print(json.dumps(report))
        if report.get('ok'):
            thr = report.get('thresholds') or {}
            msg = (
                f'Auto-cal {side}: cap_z={thr.get("cap_zone_threshold")} '
                f'piezo={thr.get("piezo_range_threshold"):,} '
                f'applied={report.get("applied")} weak={thr.get("weak_zones")}'
            )
            update_health(job_key, 'healthy', msg)
            return 0
        update_health(job_key, 'failed', report.get('error') or 'auto-cal failed')
        return 1
    except Exception as error:
        logger.error(error)
        logger.error(traceback.format_exc())
        update_health(job_key, 'failed', repr(error))
        print(json.dumps({'ok': False, 'error': repr(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
