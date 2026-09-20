"""
stage_v1 -- multi-signal sleep-stage heuristic.

Mirrors app/src/lib/sleepStageV1.ts. See docs/sleep_stage_v1.md.
Intended for offline analysis / future DB enrichment; the Sleep UI currently
computes the same rules client-side from vitals + movement + presence gaps.

Awake pass (jmakes.12): adaptive lower-half-median baseline from mid-night
window (bed+90m .. end-75m, any movement); asleep-like = mild stillness
(movementMax < 500) + HR <= baseline * 1.08; elevated awake quiet*1.15 /
stirring*1.10. No person-specific hardcoded HR bpm values.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from statistics import median
from typing import Any, Dict, Iterable, List, Literal, Optional, Sequence, Tuple

Stage = Literal['awake', 'light', 'deep', 'rem']

EPOCH = timedelta(minutes=5)
MIN_BLOCK_EPOCHS = 2
MOVEMENT_QUIET = 200
MOVEMENT_RESTLESS = 900
MOVEMENT_ONSET_STILL = 500  # mild stillness — stirring OK, thrashing not
BRIEF_GAP_SECONDS = 45

SLEEP_ONSET_CONSECUTIVE = 3
MIN_BASELINE_EPOCHS = 6
BASELINE_EXCLUDE_ONSET = timedelta(minutes=90)
BASELINE_EXCLUDE_TAIL = timedelta(minutes=75)
HR_NEAR_SLEEP = 1.08
HR_ELEVATED_QUIET = 1.15
HR_ELEVATED_STIRRING = 1.10
MIN_ELEVATED_AWAKE_RUN = 2


@dataclass
class StageEpoch:
    start: datetime
    end: datetime
    stage: Stage
    reasons: List[str] = field(default_factory=list)


def _to_dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts < 1e12:
            ts *= 1000
        return datetime.utcfromtimestamp(ts / 1000.0)
    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).replace(tzinfo=None)


def _lower_half_median(values: Sequence[float]) -> float:
    """Median of the subset at or below the overall median."""
    if not values:
        return 0.0
    m = float(median(values))
    lower = [float(v) for v in values if v <= m]
    return float(median(lower)) if lower else m


def _overlaps_absent(
    absences: Sequence[Tuple[datetime, datetime]],
    start: datetime,
    end: datetime,
    min_gap_seconds: int = BRIEF_GAP_SECONDS,
) -> bool:
    min_gap = timedelta(seconds=min_gap_seconds)
    for gap_start, gap_end in absences:
        overlap_start = max(gap_start, start)
        overlap_end = min(gap_end, end)
        if overlap_end - overlap_start >= min_gap:
            return True
    return False


def _midnight_baseline_pool(
    features: Sequence[Dict[str, Any]],
    key: str,
    night_start: Optional[datetime],
    night_end: Optional[datetime],
) -> list[float]:
    """Epoch vitals in [bed+90m, nightEnd-75m] (any movement)."""
    if night_start is None or night_end is None:
        starts = [f['start'] for f in features if f.get('start') is not None]
        if not starts:
            return []
        night_start = min(starts)
        night_end = max(starts) + EPOCH
    win_start = night_start + BASELINE_EXCLUDE_ONSET
    win_end = night_end - BASELINE_EXCLUDE_TAIL
    out: list[float] = []
    for f in features:
        if not f['has_vitals'] or float(f[key]) <= 0:
            continue
        start = f.get('start')
        if start is None:
            continue
        if start < win_start or start >= win_end:
            continue
        out.append(float(f[key]))
    return out


def _sleep_baseline(
    features: Sequence[Dict[str, Any]],
    key: str,
    night_start: Optional[datetime] = None,
    night_end: Optional[datetime] = None,
) -> float:
    mid = _midnight_baseline_pool(features, key, night_start, night_end)
    if len(mid) >= MIN_BASELINE_EPOCHS:
        return _lower_half_median(mid)
    all_vals = [float(f[key]) for f in features if f['has_vitals'] and float(f[key]) > 0]
    return _lower_half_median(all_vals)


def _is_asleep_like(
    movement_max: float,
    hr: float,
    has_vitals: bool,
    is_absent: bool,
    baseline_hr: float,
) -> bool:
    if is_absent:
        return False
    if movement_max >= MOVEMENT_RESTLESS:
        return False
    if movement_max >= MOVEMENT_ONSET_STILL:
        return False
    if not has_vitals or baseline_hr <= 0:
        return True
    return hr > 0 and hr <= baseline_hr * HR_NEAR_SLEEP
