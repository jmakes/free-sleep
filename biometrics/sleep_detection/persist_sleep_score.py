"""Persist sleep_score_v1 onto sleep_records after analyze-sleep."""
from __future__ import annotations

import json
from datetime import datetime
from typing import List

from db import DB_FILE_PATH, update_sleep_record_score
from get_logger import get_logger
from sleep_score_v1 import score_nights_from_db

logger = get_logger()


def persist_sleep_scores(side: str, start_time: datetime, end_time: datetime) -> dict:
    """
    Score overlapping sleep nights from SQLite vitals/movement/presence and persist.

    Best-effort: failures are logged; analyze-sleep should treat as non-fatal.
    """
    nights = score_nights_from_db(DB_FILE_PATH, side, start_time, end_time)
    saved: List[dict] = []
    for night in nights:
        components = night.get('components') or []
        payload = {
            'version': night.get('version') or 'sleep_score_v1',
            'score': int(night['score']),
            'components': components,
        }
        update_sleep_record_score(
            night.get('id'),
            int(night['score']),
            json.dumps(payload),
            side=night.get('side') or side,
            entered_bed_at=night.get('entered_bed_at'),
        )
        saved.append({
            'id': night.get('id'),
            'ok': True,
            'sleep_score_v1': int(night['score']),
        })
        logger.info(
            f"sleep_score_v1 persisted for {side} night id={night.get('id')}: "
            f"{night['score']}"
        )
    return {'ok': True, 'nights': saved}
