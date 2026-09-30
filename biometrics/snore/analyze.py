"""
Night-level piezo snore analysis (v0 heuristic).

Streams CBOR `.RAW` piezo-dual packets, gates on present_intervals, aggregates
per-minute features, and scores with night-adaptive thresholds.

Heuristic only — not OEM ML, not a medical device, not mic-based.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import cbor2
import numpy as np

from snore.features import (
    SAMPLE_RATE,
    SNORE_BAND_HZ,
    aggregate_minute_features,
    compute_packet_features,
    score_snore_minutes,
)

ALGORITHM = 'snore_v0_piezo_spectral_heuristic'


def parse_dt(value) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 1e12:
            ts /= 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    s = str(value).replace('Z', '+00:00')
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def decode_piezo_bytes(raw) -> np.ndarray:
    if isinstance(raw, np.ndarray):
        return raw.astype(np.int32, copy=False)
    if isinstance(raw, (bytes, bytearray, memoryview)):
        return np.frombuffer(raw, dtype=np.int32)
    if isinstance(raw, list):
        return np.asarray(raw, dtype=np.int32)
    raise TypeError(f'Unexpected piezo payload type: {type(raw)}')


def iter_raw_files(raw_dir: Path) -> List[Path]:
    return sorted(
        p for p in raw_dir.glob('*.RAW')
        if p.is_file() and p.name != 'SEQNO.RAW'
    )


def file_first_ts(path: Path) -> Optional[float]:
    try:
        with open(path, 'rb') as fh:
            while True:
                row = cbor2.load(fh)
                data = cbor2.loads(row['data'])
                if 'ts' in data:
                    return float(data['ts'])
    except EOFError:
        return None
    except Exception:
        return None


def select_files(raw_dir: Path, start: datetime, end: datetime) -> List[Path]:
    """Pick RAW chunks that may overlap [start, end] (files are ~15 min)."""
    start_ts = start.timestamp() - 20 * 60
    end_ts = end.timestamp() + 5 * 60
    chosen: List[Path] = []
    for path in iter_raw_files(raw_dir):
        ts = file_first_ts(path)
        if ts is None:
            continue
        if ts + 20 * 60 < start_ts:
            continue
        if ts > end_ts:
            continue
        chosen.append(path)
    return chosen


def in_any_interval(ts: float, intervals: Sequence[Tuple[float, float]]) -> bool:
    for a, b in intervals:
        if a <= ts < b:
            return True
    return False


def stream_side_packets(
    files: Sequence[Path],
    side: str,
    start: datetime,
    end: datetime,
    present_intervals: Sequence[Tuple[float, float]],
    sensor: str = '1',
    range_threshold: float = 10_000.0,
):
    """Yield (unix_ts, features_dict) for present, in-window packets."""
    channel = f'{side}{sensor}'
    start_ts = start.timestamp()
    end_ts = end.timestamp()
    use_intervals = len(present_intervals) > 0

    for path in files:
        try:
            with open(path, 'rb') as fh:
                while True:
                    try:
                        row = cbor2.load(fh)
                    except EOFError:
                        break
                    data = cbor2.loads(row['data'])
                    if data.get('type') != 'piezo-dual':
                        continue
                    ts = float(data['ts'])
                    if ts < start_ts or ts >= end_ts:
                        continue
                    if use_intervals and not in_any_interval(ts, present_intervals):
                        continue
                    if channel not in data:
                        continue
                    arr = decode_piezo_bytes(data[channel])
                    if arr.size == 0:
                        continue
                    ptp = float(np.ptp(arr.astype(np.float64)))
                    if not use_intervals and ptp < range_threshold:
                        continue
                    feats = compute_packet_features(arr, fs=float(data.get('freq') or SAMPLE_RATE))
                    yield ts, feats
        except Exception:
            # Caller / night runner logs file-level skips; keep stream resilient.
            continue


def minute_floor(ts: float) -> int:
    return int(ts) - (int(ts) % 60)


def normalize_intervals(
    present_intervals: Sequence,
) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for pair in present_intervals or []:
        if isinstance(pair, (list, tuple)) and len(pair) >= 2:
            a, b = parse_dt(pair[0]).timestamp(), parse_dt(pair[1]).timestamp()
            if a < b:
                out.append((a, b))
    return out


def analyze_side(
    raw_dir: Path,
    side: str,
    start: datetime,
    end: datetime,
    present_intervals: Sequence = (),
    sensor: str = '1',
) -> dict:
    """
    Score one side/window. Returns summary + per-minute timeline.

    Timeline rows are suitable for SQLite persistence (minute resolution).
    """
    start = parse_dt(start)
    end = parse_dt(end)
    present_ts = normalize_intervals(present_intervals)
    files = select_files(raw_dir, start, end)

    buckets: Dict[int, list] = defaultdict(list)
    n_packets = 0
    for ts, feats in stream_side_packets(files, side, start, end, present_ts, sensor=sensor):
        buckets[minute_floor(ts)].append(feats)
        n_packets += 1

    minutes: List[Dict[str, float]] = []
    for minute_ts in sorted(buckets.keys()):
        agg = aggregate_minute_features(buckets[minute_ts])
        if agg is None:
            continue
        present = 1.0
        if present_ts:
            present = 1.0 if in_any_interval(float(minute_ts) + 30.0, present_ts) else 0.0
        minutes.append({
            'minute_ts': float(minute_ts),
            'present': present,
            **agg,
        })

    minutes = score_snore_minutes(minutes)
    snore_rows = [m for m in minutes if m.get('snore', 0.0) >= 1.0]

    clusters = []
    if snore_rows:
        run_start = snore_rows[0]['minute_ts']
        prev = snore_rows[0]['minute_ts']
        for m in snore_rows[1:]:
            if m['minute_ts'] == prev + 60:
                prev = m['minute_ts']
                continue
            clusters.append({
                'start_ts': run_start,
                'end_ts': prev + 60,
                'minutes': int((prev - run_start) / 60) + 1,
            })
            run_start = m['minute_ts']
            prev = m['minute_ts']
        clusters.append({
            'start_ts': run_start,
            'end_ts': prev + 60,
            'minutes': int((prev - run_start) / 60) + 1,
        })

    present_min = sum(1 for m in minutes if m.get('present', 0) >= 1.0)
    snore_minutes_total = len(snore_rows)

    timeline = [
        {
            'timestamp': int(m['minute_ts']),
            'side': side,
            # Heuristic binary label (0/1) — not a clinical diagnosis.
            'snore': int(m.get('snore', 0)),
            # Heuristic likelihood (night-adaptive band energy / peakiness).
            'likelihood': float(round(float(m.get('likelihood', 0)), 4)),
        }
        for m in minutes
        if m.get('present', 0) >= 1.0
    ]

    return {
        'algorithm': ALGORITHM,
        'heuristic': True,
        'side': side,
        'sensor': sensor,
        'snore_band_hz': list(SNORE_BAND_HZ),
        'start': start.isoformat(),
        'end': end.isoformat(),
        'raw_files_used': len(files),
        'packets_scored': n_packets,
        'present_minutes': present_min,
        # Night total: count of minute bins labeled snore by the heuristic.
        'snore_minutes': snore_minutes_total,
        'snore_fraction_of_present': (snore_minutes_total / present_min) if present_min else 0.0,
        'clusters': clusters,
        'timeline': timeline,
        'top_likelihood_minutes': sorted(
            (
                {
                    'minute_ts': m['minute_ts'],
                    'likelihood': m['likelihood'],
                    'ratio': m.get('ratio', 0.0),
                    'peakiness': m.get('peakiness', 0.0),
                    'movement': m.get('movement', 0.0),
                }
                for m in minutes if m.get('present', 0) >= 1.0
            ),
            key=lambda r: r['likelihood'],
            reverse=True,
        )[:15],
    }


def load_sleep_records_from_db(db_path: str, side: str, start: datetime, end: datetime) -> List[dict]:
    """Load sleep_records overlapping [start, end] for side (unix seconds in DB)."""
    import sqlite3

    start_ts = int(parse_dt(start).timestamp())
    end_ts = int(parse_dt(end).timestamp())
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            '''
            SELECT id, side, entered_bed_at, left_bed_at,
                   present_intervals, not_present_intervals
            FROM sleep_records
            WHERE side = ?
              AND entered_bed_at < ?
              AND left_bed_at > ?
            ORDER BY entered_bed_at ASC
            ''',
            (side, end_ts, start_ts),
        ).fetchall()
    finally:
        conn.close()

    records = []
    for row in rows:
        present = json.loads(row[4] or '[]')
        records.append({
            'id': row[0],
            'side': row[1],
            'entered_bed_at': row[2],
            'left_bed_at': row[3],
            'present_intervals': present,
        })
    return records
