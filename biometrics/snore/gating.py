"""
Gate heuristic snore minutes to scored sleep (stdlib only).

Snore minutes are counted only in non-awake stage_v1 epochs. Minutes before
sustained sleep onset, plus a short grace window after it, are also excluded: pre-sleep talking/reading/TV and settling often look like snore band
energy on the piezo. If staging cannot find a sleep onset at all (e.g. vitals
missing), gating fails open and the caller logs it, so a data gap never zeroes
a night silently.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

SNORE_ONSET_GRACE_MINUTES = 10
# Sleep must be sustained (consecutive non-awake stage epochs) before snore can
# count; with 5-min epochs, 3 = 15 minutes. Shorter non-awake blips that sit
# between awake epochs (e.g. one smoothed "light" epoch inside an arousal run)
# are treated as awake for snore purposes.
SUSTAINED_SLEEP_EPOCHS = 3

Window = Tuple[float, float]


def _ts(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _runs(flags: Sequence[bool]) -> List[Tuple[int, int, bool]]:
    """(start, end_exclusive, value) runs."""
    out: List[Tuple[int, int, bool]] = []
    i = 0
    while i < len(flags):
        j = i
        while j < len(flags) and flags[j] == flags[i]:
            j += 1
        out.append((i, j, flags[i]))
        i = j
    return out


def excluded_windows(
    stage: Optional[Dict[str, Any]],
    onset_grace_minutes: float = SNORE_ONSET_GRACE_MINUTES,
    sustained_sleep_epochs: int = SUSTAINED_SLEEP_EPOCHS,
) -> Optional[List[Window]]:
    """Windows (unix seconds) where snore must not count, or None to fail open."""
    if not stage:
        return None
    epochs = stage.get('epochs') or []
    if not epochs:
        return None
    asleep = [e.get('stage') != 'awake' for e in epochs]
    runs = _runs(asleep)
    sustained = next((r for r in runs if r[2] and r[1] - r[0] >= sustained_sleep_epochs), None)
    if sustained is None:
        return None  # staging never found sustained sleep -> cannot separate sleep from wake

    excluded = [not a for a in asleep]
    for k, (i, j, val) in enumerate(runs):
        if val and j - i < sustained_sleep_epochs:
            before_awake = k == 0 or not runs[k - 1][2]
            after_awake = k == len(runs) - 1 or not runs[k + 1][2]
            if before_awake and after_awake:
                for x in range(i, j):
                    excluded[x] = True

    windows: List[Window] = [
        (_ts(epochs[i]['start']), _ts(epochs[j - 1]['end']))
        for i, j, val in _runs(excluded) if val
    ]
    night_start = _ts(epochs[0]['start'])
    onset_start = _ts(epochs[sustained[0]]['start'])
    windows.append((night_start, onset_start + onset_grace_minutes * 60.0))
    return windows


def _inside(ts: float, windows: Sequence[Window]) -> bool:
    return any(a <= ts < b for a, b in windows)


def gate_timeline(timeline: List[Dict[str, Any]], windows: Optional[Sequence[Window]]) -> Tuple[List[Dict[str, Any]], int]:
    """Zero snore on minutes whose centre lies in an excluded window.
    Rows are kept (snore=0) so a re-score overwrites stale snore=1 rows."""
    if windows is None:
        return [dict(r) for r in timeline], 0
    out: List[Dict[str, Any]] = []
    gated = 0
    for row in timeline:
        r = dict(row)
        if int(r.get('snore', 0)) and _inside(float(r['timestamp']) + 30.0, windows):
            r['snore'] = 0
            gated += 1
        out.append(r)
    return out, gated


def snore_total(timeline: Sequence[Dict[str, Any]]) -> int:
    return sum(1 for r in timeline if int(r.get('snore', 0)))
