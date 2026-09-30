"""Snore detection v0 — piezo spectral heuristic (not OEM ML)."""

from .features import (
    SNORE_BAND_HZ,
    compute_packet_features,
    aggregate_minute_features,
    score_snore_minutes,
)
from .analyze import ALGORITHM, analyze_side

# detect_snore imports db (needs get_logger first) — lazy via __getattr__
def __getattr__(name: str):
    if name == 'detect_snore':
        from .persist import detect_snore
        return detect_snore
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')

__all__ = [
    'SNORE_BAND_HZ',
    'ALGORITHM',
    'compute_packet_features',
    'aggregate_minute_features',
    'score_snore_minutes',
    'analyze_side',
    'detect_snore',
]
