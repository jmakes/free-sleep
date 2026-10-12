"""
Pure (stdlib-only) sleep-period assembly from presence intervals.

Two passes:
1. Merge presence blocks whose gap is <= max_gap into fragments.
2. Merge adjacent fragments separated by <= fragment_merge_gap when either
   neighbour is shorter than the minimum sleep length, *before* the minimum
   filter runs. A single longer mid-night gap (bathroom, sensor dropout) must
   not split one night into two records or silently drop the short half.

Kept free of pandas/numpy so it can be unit-tested anywhere.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, List, Tuple

Interval = Tuple[datetime, datetime]


def _fragments(present: List[Interval], max_gap: timedelta, min_exit_gap: timedelta) -> List[Dict]:
    frags: List[Dict] = []
    for start, end in sorted(present, key=lambda p: p[0]):
        if frags and start - frags[-1]['end'] <= max_gap:
            f = frags[-1]
            gap = start - f['end']
            if gap >= min_exit_gap:
                f['exits'] += 1
            f['end'] = max(f['end'], end)
            f['present'] += end - start
        else:
            frags.append({'start': start, 'end': end, 'present': end - start, 'exits': 0})
    return frags


def _merge_fragments(frags: List[Dict], min_sleep: timedelta, fragment_merge_gap: timedelta) -> List[Dict]:
    merged: List[Dict] = []
    for f in frags:
        if merged:
            prev = merged[-1]
            gap = f['start'] - prev['end']
            short = prev['present'] <= min_sleep or f['present'] <= min_sleep
            if gap <= fragment_merge_gap and short:
                prev['end'] = max(prev['end'], f['end'])
                prev['present'] += f['present']
                prev['exits'] += f['exits'] + 1  # the separating gap is a real exit
                continue
        merged.append(dict(f))
    return merged


def identify_sleep_intervals(
    present_intervals: List[Interval],
    max_gap_in_minutes: float,
    min_sleep_hours: float,
    min_exit_gap_seconds: int,
    fragment_merge_gap_minutes: float,
) -> List[Dict]:
    if not present_intervals:
        return []
    frags = _fragments(
        present_intervals,
        timedelta(minutes=max_gap_in_minutes),
        timedelta(seconds=min_exit_gap_seconds),
    )
    min_sleep = timedelta(hours=min_sleep_hours)
    frags = _merge_fragments(frags, min_sleep, timedelta(minutes=fragment_merge_gap_minutes))
    return [
        {
            'entered_bed_at': f['start'],
            'left_bed_at': f['end'],
            'sleep_period_seconds': int(f['present'].total_seconds()),
            'times_exited_bed': f['exits'],
        }
        for f in frags
        if f['present'] > min_sleep
    ]
