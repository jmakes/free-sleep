"""
stage_v1 -- multi-signal sleep-stage heuristic.

Mirrors app/src/lib/sleepStageV1.ts. See docs/sleep_stage_v1.md.
Intended for offline analysis / future DB enrichment; the Sleep UI currently
computes the same rules client-side from vitals + movement + presence gaps.

Awake pass (jmakes.11): sleep-baseline HR = 30th pct of quiet epochs (exclude
last ~75 min morning wake); asleep-like requires quiet (not stirring).
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
BRIEF_GAP_SECONDS = 45

SLEEP_ONSET_CONSECUTIVE = 3
MIN_QUIET_BASELINE_EPOCHS = 6
BASELINE_EXCLUDE_TAIL = timedelta(minutes=75)
HR_NEAR_SLEEP = 1.03
HR_ELEVATED_QUIET = 1.1
HR_ELEVATED_STIRRING = 1.05
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


def _percentile(values: Sequence[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    idx = max(0, min(len(sorted_vals) - 1, int(p * (len(sorted_vals) - 1))))
    return float(sorted_vals[idx])


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


def _quiet_baseline_pool(features: Sequence[Dict[str, Any]], key: str) -> list[float]:
    """Quiet-movement epoch vitals, excluding last ~75 min of night when timestamps exist."""
    starts = [f['start'] for f in features if f.get('start') is not None]
    cutoff = None
    if starts:
        night_end = max(starts)
        cutoff = night_end - BASELINE_EXCLUDE_TAIL
    out: list[float] = []
    for f in features:
        if not f['has_vitals'] or float(f[key]) <= 0:
            continue
        if f['movement_max'] >= MOVEMENT_QUIET:
            continue
        if cutoff is not None and f.get('start') is not None and f['start'] >= cutoff:
            continue
        out.append(float(f[key]))
    return out


def _sleep_baseline_hr(features: Sequence[Dict[str, Any]]) -> float:
    quiet = _quiet_baseline_pool(features, 'hr')
    if len(quiet) >= MIN_QUIET_BASELINE_EPOCHS:
        return _percentile(quiet, 0.3)
    all_hrs = [float(f['hr']) for f in features if f['has_vitals'] and f['hr'] > 0]
    return _percentile(all_hrs, 0.3)


def _sleep_baseline_br(features: Sequence[Dict[str, Any]]) -> float:
    quiet = _quiet_baseline_pool(features, 'br')
    if len(quiet) >= MIN_QUIET_BASELINE_EPOCHS:
        return _percentile(quiet, 0.3)
    all_brs = [float(f['br']) for f in features if f['has_vitals'] and f['br'] > 0]
    return _percentile(all_brs, 0.3)


def _is_asleep_like(
    movement_max: float,
    hr: float,
    has_vitals: bool,
    is_absent: bool,
    baseline_hr: float,
) -> bool:
    if is_absent:
        return False
    # Stirring must NOT end sleep onset — require quiet movement.
    if movement_max >= MOVEMENT_QUIET:
        return False
    if not has_vitals or baseline_hr <= 0:
        return True
    return hr > 0 and hr <= baseline_hr * HR_NEAR_SLEEP


def _classify(
    movement_max: float,
    hr: float,
    hrv: float,
    br: float,
    has_vitals: bool,
    is_absent: bool,
    baseline_hr: float,
    med_hrv: float,
    baseline_br: float,
) -> Tuple[Stage, List[str]]:
    reasons: List[str] = []
    if is_absent:
        return 'awake', ['presence_gap']

    restless = movement_max >= MOVEMENT_RESTLESS
    stirring = MOVEMENT_QUIET <= movement_max < MOVEMENT_RESTLESS
    quiet = movement_max < MOVEMENT_QUIET
    reasons.append('restless_movement' if restless else ('stirring' if stirring else 'quiet_movement'))

    if not has_vitals or baseline_hr <= 0:
        if restless:
            return 'awake', reasons + ['no_vitals']
        return 'light', reasons + ['no_vitals']

    hr_low = hr > 0 and hr <= baseline_hr
    hr_elevated_quiet = hr >= baseline_hr * HR_ELEVATED_QUIET
    hr_elevated_stirring = hr >= baseline_hr * HR_ELEVATED_STIRRING
    hr_mild_high = hr >= baseline_hr * 1.05
    hrv_high = med_hrv > 0 and hrv >= med_hrv * 1.08
    hrv_low = hrv > 0 and med_hrv > 0 and hrv <= med_hrv * 0.95
    br_low = br > 0 and baseline_br > 0 and br <= baseline_br * 1.02

    if restless:
        return 'awake', reasons + ['arousal']
    if quiet and hr_elevated_quiet:
        return 'awake', reasons + ['elevated_hr_quiet']
    if stirring and hr_elevated_stirring:
        return 'awake', reasons + ['elevated_hr_stirring']
    if quiet and hr_low and br_low and not hrv_high:
        return 'deep', reasons + ['deep_signals']
    if (quiet or stirring) and hr_mild_high and hrv_high and not restless:
        return 'rem', reasons + ['rem_signals']
    if quiet and (hr_low or hrv_low):
        return 'light', reasons + ['light_quiet']
    return 'light', reasons + ['default_light']


def _apply_sleep_onset(
    epochs: List[StageEpoch],
    features: Sequence[Dict[str, Any]],
    baseline_hr: float,
) -> List[StageEpoch]:
    if not epochs:
        return epochs
    consecutive = 0
    onset_end = len(epochs)
    for i, feat in enumerate(features):
        if _is_asleep_like(
            feat['movement_max'],
            feat['hr'],
            feat['has_vitals'],
            feat['is_absent'],
            baseline_hr,
        ):
            consecutive += 1
            if consecutive >= SLEEP_ONSET_CONSECUTIVE:
                onset_end = i - SLEEP_ONSET_CONSECUTIVE + 1
                break
        else:
            consecutive = 0

    for i in range(onset_end):
        if epochs[i].stage == 'awake' and 'presence_gap' in epochs[i].reasons:
            continue
        reasons = [r for r in epochs[i].reasons if r != 'sleep_onset'] + ['sleep_onset']
        epochs[i].stage = 'awake'
        epochs[i].reasons = reasons
    return epochs


def _smooth_isolated_elevated_awake(epochs: List[StageEpoch]) -> List[StageEpoch]:
    elevated = {'elevated_hr_quiet', 'elevated_hr_stirring'}
    index = 0
    while index < len(epochs):
        if epochs[index].stage != 'awake' or not elevated.intersection(epochs[index].reasons):
            index += 1
            continue
        end = index
        while (
            end < len(epochs)
            and epochs[end].stage == 'awake'
            and elevated.intersection(epochs[end].reasons)
        ):
            end += 1
        run_len = end - index
        if run_len < MIN_ELEVATED_AWAKE_RUN:
            prev_sleep = index > 0 and epochs[index - 1].stage != 'awake'
            next_sleep = end < len(epochs) and epochs[end].stage != 'awake'
            if prev_sleep and next_sleep:
                for i in range(index, end):
                    epochs[i].stage = 'light'
                    epochs[i].reasons.append('smoothed_isolated_awake')
        index = end
    return epochs


def _smooth(epochs: List[StageEpoch]) -> List[StageEpoch]:
    if len(epochs) < MIN_BLOCK_EPOCHS:
        for epoch in epochs:
            if epoch.stage in ('deep', 'rem'):
                epoch.stage = 'light'
                epoch.reasons.append('smoothed_short')
        return epochs

    index = 0
    while index < len(epochs):
        stage = epochs[index].stage
        if stage not in ('deep', 'rem'):
            index += 1
            continue
        end = index
        while end < len(epochs) and epochs[end].stage == stage:
            end += 1
        if end - index < MIN_BLOCK_EPOCHS:
            for i in range(index, end):
                epochs[i].stage = 'light'
                epochs[i].reasons.append('smoothed_short')
        index = end
    return epochs


def compute_stage_v1(
    entered_bed_at: Any,
    left_bed_at: Any,
    vitals: Optional[Iterable[Dict[str, Any]]] = None,
    movement: Optional[Iterable[Dict[str, Any]]] = None,
    not_present_intervals: Optional[Iterable[Tuple[Any, Any]]] = None,
) -> Dict[str, Any]:
    """
    Returns {version, epochs, minutes, percent}.

    vitals rows: timestamp, heart_rate, hrv, breathing_rate
    movement rows: timestamp, total_movement
    """
    night_start = _to_dt(entered_bed_at)
    night_end = _to_dt(left_bed_at)

    mov_rows = []
    for row in movement or []:
        ts = _to_dt(row.get('timestamp') or row.get('ts'))
        if night_start <= ts <= night_end:
            mov_rows.append((ts, float(row.get('total_movement') or 0)))
    mov_rows.sort(key=lambda item: item[0])

    vit_rows = []
    for row in vitals or []:
        ts = _to_dt(row.get('timestamp') or row.get('ts'))
        hr = float(row.get('heart_rate') or 0)
        if night_start <= ts <= night_end and hr > 0:
            vit_rows.append((
                ts,
                hr,
                float(row.get('hrv') or 0),
                float(row.get('breathing_rate') or 0),
            ))
    vit_rows.sort(key=lambda item: item[0])

    absences = []
    for pair in not_present_intervals or []:
        absences.append((_to_dt(pair[0]), _to_dt(pair[1])))

    features: List[Dict[str, Any]] = []
    cursor = night_start
    while cursor < night_end:
        end = min(cursor + EPOCH, night_end)
        mov_max = max((v for t, v in mov_rows if cursor <= t < end), default=0.0)
        window_vit = [r for r in vit_rows if cursor <= r[0] < end]
        if window_vit:
            hr = sum(r[1] for r in window_vit) / len(window_vit)
            hrv = sum(r[2] for r in window_vit) / len(window_vit)
            br = sum(r[3] for r in window_vit) / len(window_vit)
            has_vitals = True
        else:
            hr = hrv = br = 0.0
            has_vitals = False
        features.append({
            'start': cursor,
            'end': end,
            'movement_max': mov_max,
            'hr': hr,
            'hrv': hrv,
            'br': br,
            'has_vitals': has_vitals,
            'is_absent': _overlaps_absent(absences, cursor, end),
        })
        cursor = end

    baseline_hr = _sleep_baseline_hr(features)
    baseline_br = _sleep_baseline_br(features)
    med_hrv = median([r[2] for r in vit_rows if r[2] > 0]) if any(r[2] > 0 for r in vit_rows) else 0.0

    raw: List[StageEpoch] = []
    for feat in features:
        stage, reasons = _classify(
            feat['movement_max'],
            feat['hr'],
            feat['hrv'],
            feat['br'],
            feat['has_vitals'],
            feat['is_absent'],
            baseline_hr,
            med_hrv,
            baseline_br,
        )
        raw.append(StageEpoch(feat['start'], feat['end'], stage, reasons))

    with_onset = _apply_sleep_onset(raw, features, baseline_hr)
    with_elevated = _smooth_isolated_elevated_awake(with_onset)
    epochs = _smooth(with_elevated)

    minutes = {'awake': 0.0, 'light': 0.0, 'deep': 0.0, 'rem': 0.0}
    for epoch in epochs:
        minutes[epoch.stage] += (epoch.end - epoch.start).total_seconds() / 60.0
    total = sum(minutes.values()) or 1.0
    percent = {k: int(round(v / total * 100)) for k, v in minutes.items()}
    return {
        'version': 'stage_v1',
        'epochs': [
            {
                'start': e.start.isoformat(),
                'end': e.end.isoformat(),
                'stage': e.stage,
                'reasons': e.reasons,
            }
            for e in epochs
        ],
        'minutes': minutes,
        'percent': percent,
    }
