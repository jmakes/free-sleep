#!/usr/bin/env python3
"""Validate stage_v1 (jmakes.12) against Pod sleep nights.

Usage:
  python3 scripts/validate_stage_v1_nights.py --pod 192.168.86.33:3000 --nights 162,163

Prints baseline HR, onset end (local), awake%, and hourly stage counts.
Does not deploy. No hardcoded person-specific HR bpm values.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from biometrics.sleep_detection.stage_v1 import compute_stage_v1  # noqa: E402

PT = ZoneInfo('America/Los_Angeles')


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read().decode())


def parse_dt(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts < 1e12:
            ts *= 1000
        return datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc)
    s = str(value).replace('Z', '+00:00')
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def to_naive_utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def fetch_series(base: str, path: str, side: str, start: datetime, end: datetime):
    q = urllib.parse.urlencode({
        'side': side,
        'startTime': start.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
        'endTime': end.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
    })
    url = f'{base}/api/metrics/{path}?{q}'
    try:
        data = get_json(url)
    except Exception as exc:
        print(f'  WARN fetch {path}: {exc}', file=sys.stderr)
        return []
    if isinstance(data, dict):
        for key in ('vitals', 'movement', 'records', 'data', 'rows'):
            if key in data and isinstance(data[key], list):
                return data[key]
        for v in data.values():
            if isinstance(v, list):
                return v
        return []
    return data if isinstance(data, list) else []


def hourly_counts(epochs, tz=PT):
    buckets = {}
    for ep in epochs:
        start = parse_dt(ep['start'])
        if start is None:
            continue
        local = start.astimezone(tz)
        key = local.strftime('%Y-%m-%d %H:00')
        buckets.setdefault(key, Counter())[ep['stage']] += 1
    return buckets


def summarize_night(base: str, night_id: int, side: str | None = None):
    sleep = get_json(f'{base}/api/metrics/sleep')
    records = sleep if isinstance(sleep, list) else sleep.get('sleepRecords') or sleep.get('records') or sleep.get('data') or []
    rec = None
    for r in records:
        if int(r.get('id') or r.get('sleep_id') or -1) == night_id:
            rec = r
            break
    if rec is None:
        raise SystemExit(f'Night id {night_id} not found in /api/metrics/sleep ({len(records)} records)')

    side = side or rec.get('side') or 'right'
    entered = parse_dt(rec.get('entered_bed_at') or rec.get('enteredBedAt'))
    left = parse_dt(rec.get('left_bed_at') or rec.get('leftBedAt'))
    if not entered or not left:
        raise SystemExit(f'Night {night_id} missing bed times: {rec.keys()}')

    gaps = rec.get('not_present_intervals') or rec.get('notPresentIntervals') or []
    vitals = fetch_series(base, 'vitals', side, entered, left)
    movement = fetch_series(base, 'movement', side, entered, left)

    vit_norm = []
    for row in vitals:
        vit_norm.append({
            'timestamp': row.get('timestamp') or row.get('ts'),
            'heart_rate': row.get('heart_rate') or row.get('heartRate') or row.get('hr') or 0,
            'hrv': row.get('hrv') or 0,
            'breathing_rate': row.get('breathing_rate') or row.get('breathingRate') or row.get('br') or 0,
        })
    mov_norm = []
    for row in movement:
        mov_norm.append({
            'timestamp': row.get('timestamp') or row.get('ts'),
            'total_movement': row.get('total_movement') or row.get('totalMovement') or row.get('movement') or 0,
        })

    result = compute_stage_v1(
        to_naive_utc(entered),
        to_naive_utc(left),
        vit_norm,
        mov_norm,
        [(g[0], g[1]) for g in gaps],
    )

    onset_idx = int(result.get('onset_end_index', 0))
    if onset_idx < len(result['epochs']):
        onset_dt = parse_dt(result['epochs'][onset_idx]['start'])
        onset_local = onset_dt.astimezone(PT).strftime('%Y-%m-%d %H:%M %Z') if onset_dt else 'n/a'
    else:
        onset_local = 'never (whole night onset)'

    print('=' * 72)
    print(f'Night {night_id} side={side}')
    print(f'  bed {entered.astimezone(PT).strftime("%Y-%m-%d %H:%M %Z")} -> {left.astimezone(PT).strftime("%Y-%m-%d %H:%M %Z")}')
    print(f'  baseline_hr={result.get("baseline_hr"):.2f}  baseline_br={result.get("baseline_br"):.2f}')
    print(f'  onset_end_index={onset_idx}  onset_end_local={onset_local}')
    print(f'  awake%={result["percent"]["awake"]}  light%={result["percent"]["light"]}  deep%={result["percent"]["deep"]}  rem%={result["percent"]["rem"]}')
    print(f'  minutes={ {k: round(v,1) for k,v in result["minutes"].items()} }')
    print('  hourly epoch counts (local PT):')
    for hour, counts in sorted(hourly_counts(result['epochs']).items()):
        parts = ' '.join(f'{st}={counts[st]}' for st in ('awake', 'light', 'deep', 'rem') if counts[st])
        print(f'    {hour}  {parts}')
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pod', default='192.168.86.33:3000')
    ap.add_argument('--nights', default='162,163')
    ap.add_argument('--side', default=None, help='Override side (default: record side)')
    args = ap.parse_args()
    base = args.pod if args.pod.startswith('http') else f'http://{args.pod}'
    nights = [int(x.strip()) for x in args.nights.split(',') if x.strip()]
    print(f'Pod {base}  nights={nights}  stage_v1 jmakes.12 adaptive baseline')
    for nid in nights:
        summarize_night(base, nid, args.side)


if __name__ == '__main__':
    main()
