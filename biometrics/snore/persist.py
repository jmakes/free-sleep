"""
Persist snore heuristic results into SQLite (mirrors movement insert path).

Additive only — does not touch vitals / presence / temp / schedules.
"""
from __future__ import annotations

import gc
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Sequence

import pandas as pd

from data_types import Side
from db import (
    DB_FILE_PATH,
    insert_snore_df,
    update_sleep_record_snore_minutes,
)
from get_logger import get_logger
from snore.analyze import ALGORITHM, analyze_side, load_sleep_records_from_db, parse_dt

logger = get_logger()


def detect_snore(
    side: Side,
    start_time: datetime,
    end_time: datetime,
    folder_path: str,
    *,
    sensor: str = '1',
    sleep_records: Optional[Sequence[dict]] = None,
) -> dict:
    """
    Post-night snore heuristic for one side/window.

    Loads sleep_records (present_intervals) for the window, scores RAW piezo,
    upserts per-minute `snore` rows, and updates sleep_records.snore_minutes.
    Failures are logged; callers should treat this as best-effort additive work.
    """
    raw_dir = Path(folder_path)
    if not raw_dir.is_dir():
        logger.warning(f'Snore heuristic skipped — raw dir missing: {raw_dir}')
        return {'ok': False, 'reason': 'raw_dir_missing', 'nights': []}

    records = list(sleep_records) if sleep_records is not None else load_sleep_records_from_db(
        DB_FILE_PATH, side, start_time, end_time
    )
    if not records:
        logger.info(
            f'Snore heuristic: no sleep_records for {side} '
            f'{parse_dt(start_time).isoformat()} -> {parse_dt(end_time).isoformat()}'
        )
        return {'ok': True, 'nights': [], 'algorithm': ALGORITHM}

    night_summaries: List[dict] = []
    for rec in records:
        rec_side = rec.get('side') or side
        entered = parse_dt(rec['entered_bed_at'])
        left = parse_dt(rec['left_bed_at'])
        intervals = rec.get('present_intervals') or []
        logger.info(
            f'Snore heuristic scoring {rec_side} night id={rec.get("id")} '
            f'{entered.isoformat()} -> {left.isoformat()} '
            f'(intervals={len(intervals)}) [{ALGORITHM}]'
        )
        try:
            result = analyze_side(
                raw_dir,
                rec_side,
                entered,
                left,
                present_intervals=intervals,
                sensor=sensor,
            )
        except Exception as error:
            logger.error(f'Snore heuristic failed for night id={rec.get("id")}: {error}')
            night_summaries.append({
                'id': rec.get('id'),
                'ok': False,
                'error': repr(error),
            })
            continue

        timeline = result.get('timeline') or []
        if timeline:
            df = pd.DataFrame(timeline)
            # Keep only columns the snore table expects
            df = df[['timestamp', 'side', 'snore', 'likelihood']]
            insert_snore_df(df)
        else:
            logger.info(f'Snore heuristic: no present-minute timeline for night id={rec.get("id")}')

        total = int(result.get('snore_minutes') or 0)
        if rec.get('id') is not None:
            update_sleep_record_snore_minutes(int(rec['id']), total)
        else:
            update_sleep_record_snore_minutes(
                None,
                total,
                side=rec_side,
                entered_bed_at=int(entered.timestamp()),
            )

        summary = {
            'id': rec.get('id'),
            'ok': True,
            'side': rec_side,
            'snore_minutes': total,
            'present_minutes': result.get('present_minutes'),
            'packets_scored': result.get('packets_scored'),
            'raw_files_used': result.get('raw_files_used'),
            'algorithm': ALGORITHM,
            'heuristic': True,
        }
        logger.info(
            f'Snore heuristic saved {rec_side} night id={rec.get("id")}: '
            f'{total} snore_minutes / {result.get("present_minutes")} present '
            f'(packets={result.get("packets_scored")})'
        )
        night_summaries.append(summary)
        gc.collect()

    return {'ok': True, 'nights': night_summaries, 'algorithm': ALGORITHM}
