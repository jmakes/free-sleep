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
