"""
Detect sleep periods from piezo + capacitance presence.

Fusion is piezo-primary with cap soft assist (OR), not hard AND:
- Piezo fires → occupied (vibration / micro-motion).
- Cap max-z above threshold → also occupied (static load), even if piezo is quiet.
Hard AND previously halved presence when one channel was weak/noisy (common on
asymmetric cap zones) and fragmented nights below the >3h continuous rule.
"""

from __future__ import annotations

import gc
from collections import Counter
from datetime import datetime, timedelta
from typing import Any, Dict, List, Tuple

import pandas as pd

from data_types import *
from db import insert_sleep_records, insert_movement_df
from get_logger import get_logger
from load_raw_files import load_raw_files
from piezo_data import load_piezo_df, detect_presence_piezo
try:
    from cap_data import load_cap_df, load_baseline, detect_presence_cap
    from presence_config import (
        DEFAULT_CAP_ROLLING_SECONDS,
        DEFAULT_CAP_THRESHOLD_PERCENT,
        DEFAULT_PIEZO_ROLLING_SECONDS,
        DEFAULT_PIEZO_THRESHOLD_PERCENT,
        MAX_PRESENCE_GAP_MINUTES,
        MIN_EXIT_GAP_SECONDS,
        MIN_SLEEP_HOURS,
        get_cap_method,
        get_cap_zone_threshold,
        get_piezo_range_threshold,
        load_sensor_profile,
    )
except ImportError:
    from sleep_detection.cap_data import load_cap_df, load_baseline, detect_presence_cap
    from sleep_detection.presence_config import (
        DEFAULT_CAP_ROLLING_SECONDS,
        DEFAULT_CAP_THRESHOLD_PERCENT,
        DEFAULT_PIEZO_ROLLING_SECONDS,
        DEFAULT_PIEZO_THRESHOLD_PERCENT,
        MAX_PRESENCE_GAP_MINUTES,
        MIN_EXIT_GAP_SECONDS,
        MIN_SLEEP_HOURS,
        get_cap_method,
        get_cap_zone_threshold,
        get_piezo_range_threshold,
        load_sensor_profile,
    )

logger = get_logger()


def _get_presence_intervals(
    df: pd.DataFrame,
    side: Side,
    presence_duration_threshold_seconds: int = 60,
) -> Tuple[List[Tuple[datetime, datetime]], List[Tuple[datetime, datetime]]]:
    """
    Build present / not-present intervals from final_occupied == 2.
    Presence intervals shorter than presence_duration_threshold_seconds are dropped.
    """
    occupancy_col = f'final_{side}_occupied'

    present_intervals: List[Tuple[datetime, datetime]] = []
    not_present_intervals: List[Tuple[datetime, datetime]] = []
    current_status = None
    start_time = df.index[0]

    for timestamp, row in df.iterrows():
        status = row[occupancy_col] == 2

        if current_status is None:
            current_status = status
            continue

        if status != current_status:
            end_time = timestamp
            duration = end_time - start_time

            if current_status:
                if duration >= timedelta(minutes=1):
                    present_intervals.append((start_time, end_time))
            else:
                not_present_intervals.append((start_time, end_time))

            start_time = timestamp
            current_status = status

    end_time = df.index[-1]
    duration = end_time - start_time

    if current_status:
        if duration >= timedelta(seconds=presence_duration_threshold_seconds):
            present_intervals.append((start_time, end_time))
    else:
        not_present_intervals.append((start_time, end_time))

    return present_intervals, not_present_intervals


def _total_duration_seconds(intervals) -> int:
    total_time = sum((end - start for start, end in intervals), timedelta())
    return int(total_time.total_seconds())


def _identify_sleep_intervals(
    present_intervals: List[Tuple[datetime, datetime]],
    max_gap_in_minutes: int = MAX_PRESENCE_GAP_MINUTES,
    min_sleep_hours: float = MIN_SLEEP_HOURS,
    min_exit_gap_seconds: int = MIN_EXIT_GAP_SECONDS,
):
    """
    Merge presence with gaps ≤ max_gap_in_minutes; keep only periods with
    total presence > min_sleep_hours (default 3h).

    times_exited_bed counts only gaps ≥ min_exit_gap_seconds (default 45s).
    Shorter dropouts (tosses, sensor flicker) still merge the night but are not exits.
    """
    logger.debug(
        f'Identifying sleep intervals... | max_gap_in_minutes: {max_gap_in_minutes} '
        f'| min_sleep_hours: {min_sleep_hours} | min_exit_gap_seconds: {min_exit_gap_seconds}'
    )
    max_gap = timedelta(minutes=max_gap_in_minutes)
    min_sleep = timedelta(hours=min_sleep_hours)
    min_exit_gap = timedelta(seconds=min_exit_gap_seconds)
    if not present_intervals:
        return []

    sleep_intervals = []
    current_start, current_end = present_intervals[0]
    total_sleep_time = current_end - current_start
    exit_count = 0

    for ix in range(1, len(present_intervals)):
        next_start, next_end = present_intervals[ix]
        gap = next_start - current_end

        if gap <= max_gap:
            current_end = next_end
            total_sleep_time += (next_end - next_start)
            if gap >= min_exit_gap:
                exit_count += 1
        else:
            if total_sleep_time > min_sleep:
                sleep_intervals.append({
                    'entered_bed_at': current_start,
                    'left_bed_at': current_end,
                    'sleep_period_seconds': int(total_sleep_time.total_seconds()),
                    'times_exited_bed': exit_count,
                })

            current_start, current_end = next_start, next_end
            total_sleep_time = current_end - current_start
            exit_count = 0

    if total_sleep_time > min_sleep:
        sleep_intervals.append({
            'entered_bed_at': current_start,
            'left_bed_at': current_end,
            'sleep_period_seconds': int(total_sleep_time.total_seconds()),
            'times_exited_bed': exit_count,
        })

    return sleep_intervals


def _filter_intervals(
    intervals: List[Tuple[datetime, datetime]],
    start: datetime,
    end: datetime,
) -> List[Tuple[datetime, datetime]]:
    return [
        (max(interval_start, start), min(interval_end, end))
        for interval_start, interval_end in intervals
        if interval_end > start and interval_start < end
    ]


def compute_presence_diagnostics(
    present_intervals: List[Tuple[datetime, datetime]],
    not_present_intervals: List[Tuple[datetime, datetime]],
) -> Dict[str, Any]:
    """
    Longest continuous presence, gap histogram, and fragmentation stats for
    analyze-finish messages when no sleep record is saved.
    """
    longest_seconds = 0
    longest_start = None
    longest_end = None
    for start, end in present_intervals:
        seconds = int((end - start).total_seconds())
        if seconds > longest_seconds:
            longest_seconds = seconds
            longest_start = start
            longest_end = end

    # Gaps between successive presence blocks (not in-bed absences after merge)
    gap_seconds: List[int] = []
    sorted_present = sorted(present_intervals, key=lambda pair: pair[0])
    for index in range(1, len(sorted_present)):
        gap = sorted_present[index][0] - sorted_present[index - 1][1]
        gap_seconds.append(max(0, int(gap.total_seconds())))

    # Bucket gaps for a compact histogram string
    buckets = [
        ('≤1m', 0, 60),
        ('1–5m', 60, 300),
        ('5–15m', 300, 900),
        ('15–60m', 900, 3600),
        ('>60m', 3600, 10**12),
    ]
    hist_counts: Counter = Counter()
    for gap in gap_seconds:
        for label, low, high in buckets:
            if low <= gap < high:
                hist_counts[label] += 1
                break

    gap_histogram = {label: hist_counts.get(label, 0) for label, _, _ in buckets}
    total_present = _total_duration_seconds(present_intervals)
    total_absent = _total_duration_seconds(not_present_intervals)

    return {
        'presence_blocks': len(present_intervals),
        'longest_continuous_seconds': longest_seconds,
        'longest_continuous_hours': round(longest_seconds / 3600.0, 2),
        'longest_start': longest_start.isoformat() if longest_start is not None else None,
        'longest_end': longest_end.isoformat() if longest_end is not None else None,
        'total_present_seconds': total_present,
        'total_present_hours': round(total_present / 3600.0, 2),
        'total_absent_seconds': total_absent,
        'gap_count': len(gap_seconds),
        'gap_histogram': gap_histogram,
        'median_gap_seconds': (
            int(sorted(gap_seconds)[len(gap_seconds) // 2]) if gap_seconds else 0
        ),
        'max_gap_seconds': max(gap_seconds) if gap_seconds else 0,
    }


def format_diagnostics_summary(diag: Dict[str, Any]) -> str:
    """One-line human summary for job health / logs."""
    hist = diag.get('gap_histogram') or {}
    hist_str = ', '.join(f'{k}={v}' for k, v in hist.items() if v)
    if not hist_str:
        hist_str = 'none'
    return (
        f'longest_presence={diag.get("longest_continuous_hours", 0):.2f}h '
        f'({diag.get("presence_blocks", 0)} blocks, '
        f'total_present={diag.get("total_present_hours", 0):.2f}h); '
        f'gaps[{hist_str}]'
    )


def build_sleep_records(
    merged_df: pd.DataFrame,
    side: Side,
    max_gap_in_minutes: int = MAX_PRESENCE_GAP_MINUTES,
) -> List[SleepRecord]:
    logger.debug('Building sleep records...')

    present_intervals, not_present_intervals = _get_presence_intervals(merged_df, side)
    sleep_intervals = _identify_sleep_intervals(
        present_intervals,
        max_gap_in_minutes=max_gap_in_minutes,
        min_sleep_hours=MIN_SLEEP_HOURS,
    )

    # Always attach diagnostics for the caller (analyze finish message)
    diag = compute_presence_diagnostics(present_intervals, not_present_intervals)
    merged_df.attrs['presence_diagnostics'] = diag
    merged_df.attrs['presence_diagnostics_summary'] = format_diagnostics_summary(diag)

    sleep_records: List[SleepRecord] = []
    for sleep_interval in sleep_intervals:
        entered_bed_at = sleep_interval['entered_bed_at']
        left_bed_at = sleep_interval['left_bed_at']

        filtered_present_intervals = _filter_intervals(
            present_intervals, entered_bed_at, left_bed_at
        )
        filtered_not_present_intervals = _filter_intervals(
            not_present_intervals, entered_bed_at, left_bed_at
        )

        sleep_records.append({
            'side': side,
            **sleep_interval,
            'present_intervals': filtered_present_intervals,
            'not_present_intervals': filtered_not_present_intervals,
        })

    return sleep_records


def _apply_piezo_primary_fusion(
    merged_df: pd.DataFrame,
    side: Side,
    piezo_rate: float,
    cap_rate: float,
) -> Tuple[str, str]:
    """
    Piezo-primary + cap soft assist (OR).

    final_occupied uses legacy encoding where presence intervals require == 2:
      2 = occupied, 0/1 = not used as presence.
    """
    piezo_col = f'piezo_{side}1_presence'
    cap_col = f'cap_{side}_occupied'
    ACTIVE = 0.05
    STRONG = 0.20
    recalibrate_hint = ''

    # Primary path: OR fusion (piezo primary, cap soft-assists when piezo misses)
    occupied = ((merged_df[piezo_col] == 1) | (merged_df[cap_col] == 1)).astype(int) * 2
    merged_df[f'final_{side}_occupied'] = occupied
    occupancy_mode = 'piezo-primary'

    if piezo_rate < ACTIVE and cap_rate < ACTIVE:
        merged_df[f'final_{side}_occupied'] = 0
        occupancy_mode = 'empty'
    elif piezo_rate >= STRONG and cap_rate < ACTIVE:
        # Cap almost never fires — still use piezo-only via OR result, but warn
        occupancy_mode = 'piezo-primary(cap-weak)'
        recalibrate_hint = (
            f'Recalibrate {side} side sensors (empty + multi-pose) — '
            f'cap barely fired ({cap_rate:.1%}) while piezo saw occupancy ({piezo_rate:.1%}).'
        )
        logger.warning(recalibrate_hint)
    elif cap_rate >= STRONG and piezo_rate < ACTIVE:
        occupancy_mode = 'piezo-primary(piezo-weak)'
        recalibrate_hint = (
            f'Piezo nearly silent on {side} ({piezo_rate:.1%}) while cap saw occupancy '
            f'({cap_rate:.1%}). Check stream / RAW; consider raising cap threshold if false.'
        )
        logger.warning(recalibrate_hint)

    return occupancy_mode, recalibrate_hint


def detect_sleep(
    side: Side,
    start_time: datetime,
    end_time: datetime,
    folder_path: str,
) -> Tuple[pd.DataFrame, int]:
    expected_row_count = int((end_time - start_time).total_seconds())
    logger.info(
        f'Detecting sleep interval for {side} side | '
        f'{start_time.isoformat()} -> {end_time.isoformat()} | '
        f'Expected row count: {expected_row_count:,}'
    )

    profile = load_sensor_profile(side)
    piezo_floor = get_piezo_range_threshold(side, profile)
    cap_threshold = get_cap_zone_threshold(side, profile)
    cap_method = get_cap_method(side, profile)
    logger.info(
        f'Presence thresholds {side}: piezo_floor={piezo_floor:,} '
        f'cap_method={cap_method} cap_threshold={cap_threshold} '
        f'(profile_keys={list(profile.keys())})'
    )

    data = load_raw_files(
        folder_path,
        start_time,
        end_time,
        side,
        sensor_count=1,
        raw_data_types=['capSense', 'piezo-dual'],
    )

    piezo_df = load_piezo_df(data, side, expected_row_count=expected_row_count)
    cap_df = load_cap_df(data, side, expected_row_count=expected_row_count)
    del data
    gc.collect()

    detect_presence_piezo(
        piezo_df,
        side,
        rolling_seconds=DEFAULT_PIEZO_ROLLING_SECONDS,
        threshold_percent=DEFAULT_PIEZO_THRESHOLD_PERCENT,
        range_threshold=piezo_floor,
        range_rolling_seconds=DEFAULT_PIEZO_ROLLING_SECONDS,
        clean=True,
    )

    merged_df = piezo_df.merge(cap_df, on='ts', how='inner')
    merged_df.drop_duplicates(inplace=True)

    piezo_df.drop(piezo_df.index, inplace=True)
    cap_df.drop(cap_df.index, inplace=True)
    del piezo_df
    del cap_df
    gc.collect()

    cap_baseline = load_baseline(side)

    detect_presence_cap(
        merged_df,
        cap_baseline,
        side,
        occupancy_threshold=cap_threshold,
        rolling_seconds=DEFAULT_CAP_ROLLING_SECONDS,
        threshold_percent=DEFAULT_CAP_THRESHOLD_PERCENT,
        method=cap_method,
        clean=False,
    )

    piezo_col = f'piezo_{side}1_presence'
    cap_col = f'cap_{side}_occupied'
    total_rows = max(len(merged_df), 1)
    piezo_count = int((merged_df[piezo_col] == 1).sum())
    cap_count = int((merged_df[cap_col] == 1).sum())
    both_count = int(((merged_df[piezo_col] == 1) & (merged_df[cap_col] == 1)).sum())
    piezo_rate = piezo_count / total_rows
    cap_rate = cap_count / total_rows

    occupancy_mode, recalibrate_hint = _apply_piezo_primary_fusion(
        merged_df, side, piezo_rate, cap_rate
    )

    occupied_final = int((merged_df[f'final_{side}_occupied'] == 2).sum())
    logger.info(
        f'Presence summary {side}: mode={occupancy_mode} rows={total_rows:,} '
        f'final_occupied={occupied_final:,} both={both_count:,} '
        f'piezo={piezo_count:,} ({piezo_rate:.1%}) cap={cap_count:,} ({cap_rate:.1%}) '
        f'piezo_floor={piezo_floor:,} cap_thresh={cap_threshold}'
    )

    sleep_records = build_sleep_records(
        merged_df, side, max_gap_in_minutes=MAX_PRESENCE_GAP_MINUTES
    )
    diag_summary = merged_df.attrs.get('presence_diagnostics_summary', '')
    if len(sleep_records) == 0:
        logger.warning(
            f'No sleep periods found for {side} side! {start_time} -> {end_time} '
            f'(need continuous presence >{MIN_SLEEP_HOURS}h with gaps '
            f'≤{MAX_PRESENCE_GAP_MINUTES}m; mode={occupancy_mode}); {diag_summary}'
        )
    else:
        insert_sleep_records(sleep_records)
        logger.info(
            f'Saved {len(sleep_records)} sleep record(s) for {side}; {diag_summary}'
        )

    merged_df.attrs['occupancy_mode'] = occupancy_mode
    merged_df.attrs['recalibrate_hint'] = recalibrate_hint
    merged_df.attrs['piezo_rate'] = piezo_rate
    merged_df.attrs['cap_rate'] = cap_rate
    merged_df.attrs['piezo_floor'] = piezo_floor
    merged_df.attrs['cap_threshold'] = cap_threshold
    return merged_df, len(sleep_records)


def detect_movement(side: Side, merged_df: pd.DataFrame):
    """Derive movement series and insert into SQLite without destroying merged_df."""
    logger.debug('Logging movement...')
    work = merged_df.copy()
    if work.index.name == 'ts' or 'ts' not in work.columns:
        work = work.reset_index()
    if 'ts' not in work.columns and 'index' in work.columns:
        work.rename(columns={'index': 'ts'}, inplace=True)

    work.sort_values('ts', inplace=True)
    work.drop_duplicates(subset=['ts'], inplace=True)

    sensor_cols = [f'{side}_out', f'{side}_cen', f'{side}_in']
    missing = [c for c in sensor_cols if c not in work.columns]
    if missing:
        logger.warning(f'Skipping movement insert — missing cap columns: {missing}')
        return

    movement_df = work[sensor_cols].diff().abs()
    movement_df['total_movement'] = movement_df.sum(axis=1)
    movement_df['timestamp'] = work['ts']
    movement_df.set_index('timestamp', inplace=True)

    resampled_df = movement_df.resample('2min').max().dropna().reset_index()
    resampled_df.drop(columns=sensor_cols, inplace=True, errors='ignore')
    resampled_df['side'] = side

    try:
        resampled_df.to_csv(
            '/home/dac/free-sleep/server/free-sleep-data/movement.csv',
            index=False,
        )
    except Exception as error:
        logger.debug(f'Could not write movement.csv: {error}')

    insert_movement_df(resampled_df)
    gc.collect()
