#!/usr/bin/env python3
"""
Dump the latest capSense + piezo-dual sample for one side from the newest .RAW file.

Used by the free-sleep Sensors UI (via Node). Fast path: only reads the file tail.

Usage:
  /home/dac/venv/bin/python -B dump_sensor_snapshot.py --side=right
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import cbor2
import numpy as np

RAW_DIRS = [
    '/persistent',
    os.environ.get('RAW_DATA_FOLDER') or '',
]


def find_latest_raw() -> Path | None:
    candidates: list[Path] = []
    for folder in RAW_DIRS:
        if not folder or not os.path.isdir(folder):
            continue
        for path in Path(folder).glob('*.RAW'):
            if path.name == 'SEQNO.RAW':
                continue
            if path.is_file():
                candidates.append(path)
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def piezo_stats(raw_bytes: bytes) -> dict | None:
    if not raw_bytes or len(raw_bytes) < 4:
        return None
    samples = np.frombuffer(raw_bytes, dtype=np.int32)
    if samples.size == 0:
        return None
    return {
        'avg': int(np.round(samples.mean())),
        'min': int(samples.min()),
        'max': int(samples.max()),
        'range': int(samples.max() - samples.min()),
        'sampleCount': int(samples.size),
    }


def parse_cap(side_obj) -> dict | None:
    if not isinstance(side_obj, dict):
        return None
    try:
        return {
            'out': int(side_obj['out']),
            'cen': int(side_obj['cen']),
            'in': int(side_obj['in']),
            'status': side_obj.get('status'),
        }
    except (KeyError, TypeError, ValueError):
        return None


def format_ts(ts) -> str:
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, timezone.utc).isoformat()
    return str(ts)


def read_tail_records(path: Path, tail_bytes: int = 256 * 1024) -> list[dict]:
    size = path.stat().st_size
    start = max(0, size - tail_bytes)
    with open(path, 'rb') as handle:
        handle.seek(start)
        data = handle.read()

    # Walk the buffer until we can decode a CBOR object, then keep going
    records: list[dict] = []
    bio = io.BytesIO(data)
    # Skip broken prefix (mid-object)
    while bio.tell() < len(data):
        pos = bio.tell()
        try:
            row = cbor2.load(bio)
        except Exception:
            bio.seek(pos + 1)
            continue
        try:
            if isinstance(row, dict) and 'data' in row:
                decoded = cbor2.loads(row['data'])
            elif isinstance(row, dict) and 'type' in row:
                decoded = row
            else:
                continue
            if isinstance(decoded, dict) and 'type' in decoded:
                records.append(decoded)
        except Exception:
            continue
    return records


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--side', choices=['left', 'right'], default='right')
    args = parser.parse_args()
    side = args.side
    other = 'left' if side == 'right' else 'right'

    path = find_latest_raw()
    now = datetime.now(timezone.utc).isoformat()
    if path is None:
        json.dump({
            'side': side,
            'timestamp': now,
            'error': (
                'No .RAW files under /persistent. Sensor capture is written by the Pod '
                'firmware (usually when cloud/internet is blocked). Bed power ON is not '
                'required; being in bed is not required for empty-bed samples. '
                'Check: free-sleep-stream running, biometrics enabled, WAN blocked if needed.'
            ),
        }, sys.stdout)
        return 0

    try:
        records = read_tail_records(path)
    except Exception as error:
        json.dump({
            'side': side,
            'timestamp': now,
            'sourceFile': path.name,
            'error': f'Failed reading RAW: {error}',
        }, sys.stdout)
        return 0

    latest_cap = None
    latest_other = None
    latest_piezo1 = None
    latest_piezo2 = None

    for row in records:
        rtype = row.get('type')
        ts = format_ts(row.get('ts'))
        if rtype == 'capSense':
            mine = parse_cap(row.get(side))
            other_cap = parse_cap(row.get(other))
            if mine:
                mine['ts'] = ts
                latest_cap = mine
            if other_cap:
                other_cap['ts'] = ts
                latest_other = other_cap
        elif rtype == 'piezo-dual':
            for channel, key in (('1', f'{side}1'), ('2', f'{side}2')):
                raw = row.get(key)
                if raw is None:
                    continue
                if isinstance(raw, (bytes, bytearray)):
                    stats = piezo_stats(bytes(raw))
                else:
                    continue
                if not stats:
                    continue
                stats['ts'] = ts
                stats['channel'] = channel
                if channel == '1':
                    latest_piezo1 = stats
                else:
                    latest_piezo2 = stats

    mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    if not latest_cap and not latest_piezo1 and not latest_piezo2:
        json.dump({
            'side': side,
            'timestamp': now,
            'sourceFile': path.name,
            'fileMtime': mtime,
            'error': (
                f'Found {path.name} but no capSense/piezo-dual frames in the last ~256KB. '
                f'File may be stale or a different format. Age check: mtime={mtime}. '
                f'Records decoded from tail: {len(records)}.'
            ),
            'recordsInTail': len(records),
        }, sys.stdout)
        return 0

    json.dump({
        'side': side,
        'timestamp': now,
        'sourceFile': path.name,
        'fileMtime': mtime,
        'cap': latest_cap,
        'piezo1': latest_piezo1,
        'piezo2': latest_piezo2,
        'otherCap': latest_other,
        'recordsInTail': len(records),
    }, sys.stdout)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
