"""
Stdlib-only guards for auto presence calibration.

- Lookback is capped to the raw data the Pod actually retains (RAW files are
  rotated after roughly a day or two), so a "14 day" run does not silently
  train on one day while claiming fourteen.
- Piezo range statistics near 2**32 are unsigned-wrap artefacts, not motion;
  they are dropped per sample and a run whose summary stats still look
  wrapped is rejected.
"""

from __future__ import annotations

import glob
import math
import os
from datetime import datetime, timezone
from typing import Iterable, List, Optional, Tuple

# Anything at/above 2**31 cannot be a real packet range (real ranges are
# ~1e4..1e6); values near 2**32 come from unsigned wrap. A wrap inside an
# averaged column shows up scaled, e.g. ~2**32/1000 = 4,294,967, so values
# within WRAP_BAND of 2**32 / 10**k are treated as wrap artefacts too.
PIEZO_RANGE_OVERFLOW = 2 ** 31
WRAP_SCALES = (1, 10, 100, 1000)
WRAP_BAND = 0.001  # ±0.1%
# Minimum whole days of retained RAW needed before auto-cal will fit anything.
AUTO_CAL_MIN_RETAINED_DAYS = 1


def oldest_raw_mtime(folder: str) -> Optional[float]:
    files = glob.glob(os.path.join(folder, '*.RAW'))
    if not files:
        return None
    return min(os.path.getmtime(p) for p in files)


def retained_days(oldest_mtime: Optional[float], now: Optional[datetime] = None) -> int:
    if oldest_mtime is None:
        return 0
    now = now or datetime.now(timezone.utc)
    span_s = now.timestamp() - oldest_mtime
    return max(0, int(span_s // 86400))


def effective_lookback(requested_days: int, available_days: int) -> int:
    return max(0, min(requested_days, available_days))


def _near_scaled_wrap(value: float) -> bool:
    for k in WRAP_SCALES:
        target = (2 ** 32) / k
        if abs(value - target) <= target * WRAP_BAND:
            return True
    return False


def is_overflow(value: float) -> bool:
    if not math.isfinite(value) or value < 0:
        return True
    return value >= PIEZO_RANGE_OVERFLOW or _near_scaled_wrap(value)


def drop_overflow(values: Iterable[float]) -> Tuple[List[float], int]:
    kept: List[float] = []
    dropped = 0
    for v in values:
        if is_overflow(float(v)):
            dropped += 1
        else:
            kept.append(float(v))
    return kept, dropped


def stats_look_wrapped(*stats: float) -> bool:
    return any(is_overflow(float(s)) for s in stats)
