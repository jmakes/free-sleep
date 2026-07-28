"""
This module detects sleep periods by analyzing presence intervals derived from piezoelectric
and capacitance sensor data.

Key functionalities:
- Loads and preprocesses raw sensor data.
- Detects presence using piezoelectric and capacitance sensors.
- Identifies sleep intervals by merging presence periods with small gaps.
- Filters valid sleep periods based on predefined thresholds.
- Saves detected sleep records to a database.
"""

import pandas as pd
import gc
from typing import List, Tuple
from datetime import datetime, timedelta

from data_types import *
from db import insert_sleep_records, insert_movement_df
from sleep_detection.cap_data import load_cap_df, load_baseline, detect_presence_cap
from get_logger import get_logger
from load_raw_files import load_raw_files
from piezo_data import load_piezo_df, detect_presence_piezo

logger = get_logger()


def _get_presence_intervals(df: pd.DataFrame, side: Side, presence_duration_threshold_seconds=60) -> Tuple[
    List[Tuple[datetime, datetime]], List[Tuple[datetime, datetime]]]:
    """
    Get time intervals when someone was present and not present on the bed,
    requiring presence intervals to be at least 1 minute long.

    Parameters:
        df (pd.DataFrame): The input DataFrame with occupancy data.
        side (str): 'left' or 'right' to check occupancy.
        presence_duration_threshold_seconds (int): The minimum amount of time presence must be detected in order to add it

    Returns:
        present_intervals (list): List of tuples (start_time, end_time) when occupied (>= 1 min).
        not_present_intervals (list): List of tuples (start_time, end_time) when not occupied.
    """
    # Select the relevant column based on the chosen side
    occupancy_col = f'final_{side}_occupied'

    # Initialize tracking variables
    present_intervals = []
    not_present_intervals = []
    current_status = None
    start_time = df.index[0]

    # Iterate over DataFrame to find state changes
    for timestamp, row in df.iterrows():
        status = row[occupancy_col] == 2  # Presence condition

        if current_status is None:
            current_status = status
            continue

        # Check for status change
        if status != current_status:
            end_time = timestamp
            duration = end_time - start_time

            if current_status:
                # Only add presence intervals >= 1 minute
                if duration >= timedelta(minutes=1):
                    present_intervals.append((start_time, end_time))
            else:
                not_present_intervals.append((start_time, end_time))

            # Update for the new interval
            start_time = timestamp
            current_status = status

    # Capture the last interval
    end_time = df.index[-1]
    duration = end_time - start_time

    if current_status:
        if duration >= timedelta(seconds=presence_duration_threshold_seconds):
            present_intervals.append((start_time, end_time))
    else:
        not_present_intervals.append((start_time, end_time))

    return present_intervals, not_present_intervals


def _total_duration_seconds(intervals) -> int:
    """
    Given an array of (start_time, end_time) tuples, calculate the total duration.

    Args:
        intervals (list of tuples): List of (start_time, end_time) tuples.
    """
    total_time = sum((end - start for start, end in intervals), timedelta())
    return int(total_time.total_seconds())


def _identify_sleep_intervals(present_intervals: List[Tuple[datetime, datetime]], max_gap_in_minutes: int = 15):
    """
    Identifies sleep periods by merging intervals with small gaps.

    Args:
        present_intervals (list of tuples): List of (start_time, end_time) tuples representing presence periods.
        max_gap_in_minutes (int, optional): Maximum allowed minutes between intervals before merging them. Defaults to 15.

    Returns:
        list of dicts: A list of detected sleep periods, each containing:
            - 'entered_bed_at': Start time of the sleep period.
            - 'left_bed_at': End time of the sleep period.
            - 'sleep_period': Total sleep duration.
            - 'times_exited_bed': Number of times the person exited the bed.
    """
    logger.debug(f'Identifying sleep intervals... | max_gap_in_minutes: {max_gap_in_minutes}')
    max_gap = timedelta(minutes=max_gap_in_minutes)
    if not present_intervals:
        return []

    sleep_intervals = []
    current_start, current_end = present_intervals[0]  # Start with the first interval
    total_sleep_time = current_end - current_start
    exit_count = 0

    for ix in range(1, len(present_intervals)):
        next_start, next_end = present_intervals[ix]  # Get next interval
        gap = next_start - current_end  # Calculate gap between intervals

        if gap <= max_gap:
            # Merge into the current sleep period
            current_end = next_end
            total_sleep_time += (next_end - next_start)
            exit_count += 1
        else:
            # Only add sleep interval if it's greater than 3 hours
            if total_sleep_time > timedelta(hours=3):
                sleep_intervals.append({
                    'entered_bed_at': current_start,
                    'left_bed_at': current_end,
                    'sleep_period_seconds': int(total_sleep_time.total_seconds()),
                    'times_exited_bed': exit_count,
                })

            # Reset values for the new sleep period
            current_start, current_end = next_start, next_end
            total_sleep_time = current_end - current_start
            exit_count = 0

    # Ensure the last interval is added only if it meets the 3-hour requirement
    if total_sleep_time > timedelta(hours=3):
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
        end: datetime
) -> List[Tuple[datetime, datetime]]:
    """
    Filters intervals to include only those that overlap with the given start and end times.
    """
    filtered_intervals = [
        (max(interval_start, start), min(interval_end, end))
        for interval_start, interval_end in intervals
        if interval_end > start and interval_start < end  # Overlap condition
    ]
    return filtered_intervals


def build_sleep_records(merged_df: pd.DataFrame, side: Side, max_gap_in_minutes: int = 15) -> List[SleepRecord]:
    logger.debug('Building sleep records...')

    present_intervals, not_present_intervals = _get_presence_intervals(merged_df, side)
    sleep_intervals = _identify_sleep_intervals(present_intervals, max_gap_in_minutes=max_gap_in_minutes)

    sleep_records: List[SleepRecord] = []
    for sleep_interval in sleep_intervals:
        entered_bed_at = sleep_interval['entered_bed_at']
        left_bed_at = sleep_interval['left_bed_at']

        # Filter intervals specific to the current sleep interval
        filtered_present_intervals = _filter_intervals(present_intervals, entered_bed_at, left_bed_at)
        filtered_not_present_intervals = _filter_intervals(not_present_intervals, entered_bed_at, left_bed_at)

        sleep_records.append({
            "side": side,
            **sleep_interval,
            'present_intervals': filtered_present_intervals,
            'not_present_intervals': filtered_not_present_intervals,
        })

    return sleep_records


def detect_sleep(side: Side, start_time: datetime, end_time: datetime, folder_path: str) -> Tuple[pd.DataFrame, int]:
    expected_row_count = int((end_time - start_time).total_seconds())
    logger.info(f"Detecting sleep interval for {side} side | {start_time.isoformat()} -> {end_time.isoformat()} | Expected row count: {expected_row_count:,}")

    data = load_raw_files(folder_path, start_time, end_time, side, sensor_count=1, raw_data_types=['capSense', 'piezo-dual'])

    piezo_df = load_piezo_df(data, side, expected_row_count=expected_row_count)
    cap_df = load_cap_df(data, side, expected_row_count=expected_row_count)
    # Cleanup data
    del data
    gc.collect()

    detect_presence_piezo(
        piezo_df,
        side,
        rolling_seconds=10,
        threshold_percent=0.70,
        range_threshold=20_000,
        range_rolling_seconds=10,
        clean=True
    )

    merged_df = piezo_df.merge(cap_df, on='ts', how='inner')
    merged_df.drop_duplicates(inplace=True)

    # Free up memory from old dfs
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
        occupancy_threshold=5,
        rolling_seconds=10,
        threshold_percent=0.90,
        clean=False
    )

    piezo_col = f'piezo_{side}1_presence'
    cap_col = f'cap_{side}_occupied'
    total_rows = max(len(merged_df), 1)
    piezo_count = int((merged_df[piezo_col] == 1).sum())
    cap_count = int((merged_df[cap_col] == 1).sum())
    both_count = int(((merged_df[piezo_col] == 1) & (merged_df[cap_col] == 1)).sum())
    piezo_rate = piezo_count / total_rows
    cap_rate = cap_count / total_rows

    # Presence intervals require final_occupied == 2 (legacy).
    #
    # Sensor roles (as used in free-sleep):
    # - Piezo: high-rate vibration/pressure signal; presence = signal *range/energy*
    #   over a short window (heartbeat, breathing, micro-motion) — not static weight.
    # - Cap (out/cen/in): slower load vs an *empty-bed baseline* (mean/std).
    #
    # Original AND (both must fire) reduces false positives when both are healthy.
    # When one channel is nearly dead for the whole night while the other is strong,
    # that is almost always miscalibration/drift — not "nobody was there".
    # In that case use the strong channel and flag the weak one for recalibration.
    ACTIVE = 0.05   # sensor is "saying something" across the window
    STRONG = 0.20   # sensor is strongly asserting occupancy

    recalibrate_hint = ''
    if piezo_rate >= ACTIVE and cap_rate >= ACTIVE:
        # Both sensors healthy enough → dual confirmation (original intent)
        merged_df[f'final_{side}_occupied'] = (
            merged_df[piezo_col] + merged_df[cap_col]
        ).astype(int)
        occupancy_mode = 'piezo+cap'
    elif piezo_rate >= STRONG and cap_rate < ACTIVE:
        merged_df[f'final_{side}_occupied'] = (merged_df[piezo_col] * 2).astype(int)
        occupancy_mode = 'piezo-only'
        recalibrate_hint = (
            f'Recalibrate {side} side cap sensors (empty bed required) — '
            f'cap barely fired ({cap_rate:.1%}) while piezo saw occupancy ({piezo_rate:.1%}).'
        )
        logger.warning(recalibrate_hint)
    elif cap_rate >= STRONG and piezo_rate < ACTIVE:
        merged_df[f'final_{side}_occupied'] = (merged_df[cap_col] * 2).astype(int)
        occupancy_mode = 'cap-only'
        recalibrate_hint = (
            f'Piezo nearly silent on {side} ({piezo_rate:.1%}) while cap saw occupancy '
            f'({cap_rate:.1%}). Check biometrics stream / RAW capture for that night.'
        )
        logger.warning(recalibrate_hint)
    elif piezo_rate < ACTIVE and cap_rate < ACTIVE:
        merged_df[f'final_{side}_occupied'] = 0
        occupancy_mode = 'empty'
    else:
        # One weakly active — prefer OR so we don't drop ambiguous nights
        merged_df[f'final_{side}_occupied'] = (
            ((merged_df[piezo_col] == 1) | (merged_df[cap_col] == 1)).astype(int) * 2
        )
        occupancy_mode = 'either-weak'

    occupied_final = int((merged_df[f'final_{side}_occupied'] == 2).sum())
    logger.info(
        f'Presence summary {side}: mode={occupancy_mode} rows={total_rows:,} '
        f'final_occupied={occupied_final:,} both={both_count:,} '
        f'piezo={piezo_count:,} ({piezo_rate:.1%}) cap={cap_count:,} ({cap_rate:.1%})'
    )

    sleep_records = build_sleep_records(merged_df, side, max_gap_in_minutes=15)
    if len(sleep_records) == 0:
        logger.warning(
            f'No sleep periods found for {side} side! {start_time} -> {end_time} '
            f'(need continuous presence >3h with gaps ≤15m; mode={occupancy_mode})'
        )
    else:
        insert_sleep_records(sleep_records)

    # Stash diagnostics for analyze_sleep finish message / GUI
    merged_df.attrs['occupancy_mode'] = occupancy_mode
    merged_df.attrs['recalibrate_hint'] = recalibrate_hint
    merged_df.attrs['piezo_rate'] = piezo_rate
    merged_df.attrs['cap_rate'] = cap_rate
    return merged_df, len(sleep_records)



def detect_movement(side: Side, merged_df: pd.DataFrame):
    """
    Derive movement series and insert into SQLite.
    Does NOT destroy merged_df — callers may still need it.
    """
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


