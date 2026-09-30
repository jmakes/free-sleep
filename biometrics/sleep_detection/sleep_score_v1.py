"""
sleep_score_v1 -- explainable 0-100 sleep score.

Mirrors server/src/lib/sleepScoreV1.ts (and app re-export). See docs/sleep_stage_v1.md.
Components (weights sum to 100): Duration 35, Continuity 25, Restfulness 20, Vitals 20.
"""
from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from stage_v1 import BRIEF_GAP_SECONDS, compute_stage_v1, _to_dt

MIN_MEANINGFUL_EXIT_SECONDS = 5 * 60


def _clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def _gap_seconds(start: Any, end: Any) -> int:
    return max(0, int((_to_dt(end) - _to_dt(start)).total_seconds()))


def count_bed_exits(
    not_present_intervals: Optional[Iterable[Tuple[Any, Any]]],
    *,
    entered_bed_at: Any = None,
    left_bed_at: Any = None,
) -> Dict[str, int]:
    """Match app/src bedExits.countBedExits / displayExitCount."""
    night_start = _to_dt(entered_bed_at) if entered_bed_at is not None else None
    night_end = _to_dt(left_bed_at) if left_bed_at is not None else None
    meaningful = brief = flicker = 0
    for pair in not_present_intervals or []:
        if not pair or len(pair) < 2:
            continue
        start = _to_dt(pair[0])
        end = _to_dt(pair[1])
        if end <= start:
            continue
        if night_start is not None and night_end is not None:
            if end <= night_start or start >= night_end:
                continue
        seconds = _gap_seconds(start, end)
        if seconds >= MIN_MEANINGFUL_EXIT_SECONDS:
            meaningful += 1
        elif seconds >= BRIEF_GAP_SECONDS:
            brief += 1
        else:
            flicker += 1
    return {
        'meaningfulExits': meaningful,
        'briefGaps': brief,
        'flickerGaps': flicker,
    }


def _duration_points(sleep_period_seconds: float) -> Dict[str, Any]:
    max_points = 35
    hours = sleep_period_seconds / 3600.0
    if 7 <= hours <= 9:
        points = max_points
    elif hours < 7:
        points = max_points * _clamp((hours - 3) / 4, 0, 1)
    else:
        points = max_points * _clamp((12 - hours) / 3, 0, 1)
    points = int(round(points))
    return {
        'key': 'duration',
        'label': 'Duration',
        'points': points,
        'maxPoints': max_points,
        'detail': f'{hours:.1f}h in bed (target 7-9h)',
    }


def _continuity_points(
    not_present_intervals: Optional[Iterable[Tuple[Any, Any]]],
    entered_bed_at: Any,
    left_bed_at: Any,
) -> Dict[str, Any]:
    max_points = 25
    exits = count_bed_exits(
        not_present_intervals,
        entered_bed_at=entered_bed_at,
        left_bed_at=left_bed_at,
    )
    penalty = exits['meaningfulExits'] * 5 + min(5, exits['briefGaps'])
    points = int(_clamp(max_points - penalty, 0, max_points))
    return {
        'key': 'continuity',
        'label': 'Continuity',
        'points': points,
        'maxPoints': max_points,
        'detail': (
            f"{exits['meaningfulExits']} exit(s) >=5m, "
            f"{exits['briefGaps']} brief gap(s)"
        ),
    }


def _restfulness_points(
    stage: Optional[Dict[str, Any]],
    movement: Optional[Sequence[Dict[str, Any]]],
) -> Dict[str, Any]:
    max_points = 20
    percent = (stage or {}).get('percent') or {}
    epochs = (stage or {}).get('epochs') or []
    if stage and epochs:
        deep_rem = float(percent.get('deep') or 0) + float(percent.get('rem') or 0)
        awake = float(percent.get('awake') or 0)
        points = max_points * _clamp(deep_rem / 40, 0, 1)
        points -= max_points * 0.5 * _clamp((awake - 10) / 30, 0, 1)
        points = int(round(_clamp(points, 0, max_points)))
        return {
            'key': 'restfulness',
            'label': 'Restfulness',
            'points': points,
            'maxPoints': max_points,
            'detail': (
                f"Deep {percent.get('deep', 0)}% | REM {percent.get('rem', 0)}% | "
                f"Awake {percent.get('awake', 0)}%"
            ),
        }

    rows = list(movement or [])
    if not rows:
        return {
            'key': 'restfulness',
            'label': 'Restfulness',
            'points': int(round(max_points * 0.5)),
            'maxPoints': max_points,
            'detail': 'No stage/movement data -- neutral',
        }
    quiet = sum(1 for r in rows if float(r.get('total_movement') or 0) < 200)
    restless = sum(1 for r in rows if float(r.get('total_movement') or 0) >= 900)
    quiet_pct = quiet / len(rows)
    restless_pct = restless / len(rows)
    points = int(round(_clamp(max_points * quiet_pct - max_points * restless_pct, 0, max_points)))
    return {
        'key': 'restfulness',
        'label': 'Restfulness',
        'points': points,
        'maxPoints': max_points,
        'detail': f'{int(round(quiet_pct * 100))}% quiet movement bins',
    }


def _vitals_points(vitals: Optional[Sequence[Dict[str, Any]]]) -> Dict[str, Any]:
    max_points = 20
    hrs = [float(v.get('heart_rate') or 0) for v in (vitals or [])]
    hrs = [h for h in hrs if h > 0]
    hrvs = [float(v.get('hrv') or 0) for v in (vitals or [])]
    hrvs = [h for h in hrvs if h > 0]
    if len(hrs) < 3:
        return {
            'key': 'vitals',
            'label': 'Vitals stability',
            'points': int(round(max_points * 0.5)),
            'maxPoints': max_points,
            'detail': 'Insufficient HR samples -- neutral',
        }
    mean = sum(hrs) / len(hrs)
    variance = sum((h - mean) ** 2 for h in hrs) / len(hrs)
    cv = (math.sqrt(variance) / mean) if mean > 0 else 1.0
    points = max_points * _clamp(1 - (cv - 0.05) / 0.15, 0, 1)
    mean_hrv = (sum(hrvs) / len(hrvs)) if hrvs else 0.0
    if mean_hrv >= 20:
        points = min(max_points, points + 2)
    points = int(round(_clamp(points, 0, max_points)))
    hrv_label = str(int(round(mean_hrv))) if mean_hrv else '--'
    return {
        'key': 'vitals',
        'label': 'Vitals stability',
        'points': points,
        'maxPoints': max_points,
        'detail': f'HR CV {cv * 100:.1f}% | avg HRV {hrv_label} ms',
    }


def compute_sleep_score_v1(
    *,
    sleep_period_seconds: float,
    entered_bed_at: Any,
    left_bed_at: Any,
    not_present_intervals: Optional[Iterable[Tuple[Any, Any]]] = None,
    vitals: Optional[Sequence[Dict[str, Any]]] = None,
    movement: Optional[Sequence[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Return {version, score, components} matching SleepScoreV1 (no full stage epochs)."""
    stage = compute_stage_v1(
        entered_bed_at,
        left_bed_at,
        vitals=vitals,
        movement=movement,
        not_present_intervals=not_present_intervals,
    )
    components = [
        _duration_points(float(sleep_period_seconds or 0)),
        _continuity_points(not_present_intervals, entered_bed_at, left_bed_at),
        _restfulness_points(stage, movement),
        _vitals_points(vitals),
    ]
    score = int(_clamp(sum(c['points'] for c in components), 0, 100))
    return {
        'version': 'sleep_score_v1',
        'score': score,
        'components': components,
    }


def load_night_inputs_from_db(
    db_path: str,
    side: str,
    start: datetime,
    end: datetime,
) -> List[Dict[str, Any]]:
    """Load sleep nights + overlapping vitals/movement for scoring."""
    start_ts = int(start.timestamp()) if start.tzinfo is None else int(start.astimezone(timezone.utc).timestamp())
    end_ts = int(end.timestamp()) if end.tzinfo is None else int(end.astimezone(timezone.utc).timestamp())
    # Prefer unix from naive-as-UTC or aware
    if hasattr(start, 'timestamp'):
        start_ts = int(start.timestamp())
        end_ts = int(end.timestamp())

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            '''
            SELECT id, side, entered_bed_at, left_bed_at, sleep_period_seconds,
                   times_exited_bed, not_present_intervals
            FROM sleep_records
            WHERE side = ?
              AND entered_bed_at < ?
              AND left_bed_at > ?
            ORDER BY entered_bed_at ASC
            ''',
            (side, end_ts, start_ts),
        ).fetchall()

        nights: List[Dict[str, Any]] = []
        for row in rows:
            entered = int(row[2])
            left = int(row[3])
            gaps = json.loads(row[6] or '[]')
            vitals = [
                {
                    'timestamp': r[0],
                    'heart_rate': r[1],
                    'hrv': r[2],
                    'breathing_rate': r[3],
                }
                for r in conn.execute(
                    '''
                    SELECT timestamp, heart_rate, hrv, breathing_rate
                    FROM vitals
                    WHERE side = ? AND timestamp >= ? AND timestamp <= ?
                    ORDER BY timestamp ASC
                    ''',
                    (side, entered, left),
                ).fetchall()
            ]
            movement = [
                {'timestamp': r[0], 'total_movement': r[1]}
                for r in conn.execute(
                    '''
                    SELECT timestamp, total_movement
                    FROM movement
                    WHERE side = ? AND timestamp >= ? AND timestamp <= ?
                    ORDER BY timestamp ASC
                    ''',
                    (side, entered, left),
                ).fetchall()
            ]
            nights.append({
                'id': row[0],
                'side': row[1],
                'entered_bed_at': entered,
                'left_bed_at': left,
                'sleep_period_seconds': int(row[4] or (left - entered)),
                'times_exited_bed': int(row[5] or 0),
                'not_present_intervals': gaps,
                'vitals': vitals,
                'movement': movement,
            })
        return nights
    finally:
        conn.close()


def score_nights_from_db(db_path: str, side: str, start: datetime, end: datetime) -> List[Dict[str, Any]]:
    """Compute sleep_score_v1 for each overlapping sleep night."""
    results = []
    for night in load_night_inputs_from_db(db_path, side, start, end):
        payload = compute_sleep_score_v1(
            sleep_period_seconds=night['sleep_period_seconds'],
            entered_bed_at=night['entered_bed_at'],
            left_bed_at=night['left_bed_at'],
            not_present_intervals=night['not_present_intervals'],
            vitals=night['vitals'],
            movement=night['movement'],
        )
        results.append({
            'id': night['id'],
            'side': night['side'],
            'entered_bed_at': night['entered_bed_at'],
            'ok': True,
            **payload,
        })
    return results
