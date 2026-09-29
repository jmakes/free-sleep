#!/usr/bin/env python3
"""
Offline snore detection v0 — piezo spectral heuristic on presence epochs.

Loads CBOR `.RAW` `piezo-dual` packets (full 500 Hz int32 arrays), gates on sleep
present_intervals (or piezo range), computes 20–150 Hz band features, and reports
per-minute snore likelihood + total snore minutes.

Does NOT deploy, write the DB, or use a microphone.

Examples:
  # Against Pod RAW + sleep API (run on a machine that can reach both):
  python3 scripts/analyze_snore_v0.py \\
    --raw-dir /persistent \\
    --pod-api http://127.0.0.1:3000 \\
    --night-ids 180,182 \\
    --out /tmp/snore_v0_last_night.json

  # Explicit window (UTC ISO):
  python3 scripts/analyze_snore_v0.py --raw-dir /persistent --side left \\
    --start 2026-09-28T04:57:00Z --end 2026-09-28T15:00:00Z
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import cbor2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'biometrics'))

from snore.features import (  # noqa: E402
    SNORE_BAND_HZ,
    SAMPLE_RATE,
    compute_packet_features,
    aggregate_minute_features,
    score_snore_minutes,
)

PT_LABEL = 'America/Los_Angeles'


def parse_dt(value) -> datetime:
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


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read().decode())


def fetch_sleep_records(base: str) -> list:
    data = get_json(f'{base.rstrip("/")}/api/metrics/sleep')
    if isinstance(data, list):
        return data
    return data.get('sleepRecords') or data.get('records') or data.get('data') or []


def decode_piezo_bytes(raw) -> np.ndarray:
    if isinstance(raw, np.ndarray):
        return raw.astype(np.int32, copy=False)
    if isinstance(raw, (bytes, bytearray, memoryview)):
        return np.frombuffer(raw, dtype=np.int32)
    if isinstance(raw, list):
        return np.asarray(raw, dtype=np.int32)
    raise TypeError(f'Unexpected piezo payload type: {type(raw)}')


def iter_raw_files(raw_dir: Path) -> List[Path]:
    files = sorted(
        p for p in raw_dir.glob('*.RAW')
        if p.is_file() and p.name != 'SEQNO.RAW'
    )
    return files


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
        # Each file spans ~15 minutes
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
                    # Presence soft-gate via packet range when no intervals given
                    ptp = float(np.ptp(arr.astype(np.float64)))
                    if not use_intervals and ptp < range_threshold:
                        continue
                    feats = compute_packet_features(arr, fs=float(data.get('freq') or SAMPLE_RATE))
                    yield ts, feats
        except Exception as exc:
            print(f'WARN skip {path.name}: {exc}', file=sys.stderr)


def minute_floor(ts: float) -> int:
    return int(ts) - (int(ts) % 60)


def analyze_side(
    raw_dir: Path,
    side: str,
    start: datetime,
    end: datetime,
    present_intervals: Sequence[Tuple[datetime, datetime]],
    sensor: str = '1',
) -> dict:
    files = select_files(raw_dir, start, end)
    present_ts = [(a.timestamp(), b.timestamp()) for a, b in present_intervals]
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
        row = {
            'minute_ts': float(minute_ts),
            'present': present,
            **agg,
        }
        minutes.append(row)

    minutes = score_snore_minutes(minutes)
    snore_minutes = [m for m in minutes if m.get('snore', 0.0) >= 1.0]
    # Cluster: contiguous snore minutes
    clusters = []
    if snore_minutes:
        run_start = snore_minutes[0]['minute_ts']
        prev = snore_minutes[0]['minute_ts']
        for m in snore_minutes[1:]:
            if m['minute_ts'] == prev + 60:
                prev = m['minute_ts']
                continue
            clusters.append({'start_ts': run_start, 'end_ts': prev + 60, 'minutes': int((prev - run_start) / 60) + 1})
            run_start = m['minute_ts']
            prev = m['minute_ts']
        clusters.append({'start_ts': run_start, 'end_ts': prev + 60, 'minutes': int((prev - run_start) / 60) + 1})

    present_min = sum(1 for m in minutes if m.get('present', 0) >= 1.0)
    return {
        'side': side,
        'sensor': sensor,
        'snore_band_hz': list(SNORE_BAND_HZ),
        'start': start.isoformat(),
        'end': end.isoformat(),
        'raw_files_used': len(files),
        'packets_scored': n_packets,
        'present_minutes': present_min,
        'snore_minutes': len(snore_minutes),
        'snore_fraction_of_present': (len(snore_minutes) / present_min) if present_min else 0.0,
        'clusters': clusters,
        'top_likelihood_minutes': sorted(
            (
                {
                    'minute_ts': m['minute_ts'],
                    'likelihood': m['likelihood'],
                    'ratio': m['ratio'],
                    'peakiness': m['peakiness'],
                    'movement': m['movement'],
                }
                for m in minutes if m.get('present', 0) >= 1.0
            ),
            key=lambda r: r['likelihood'],
            reverse=True,
        )[:15],
        'timeline': [
            {
                'minute_ts': m['minute_ts'],
                'snore': int(m.get('snore', 0)),
                'likelihood': round(float(m.get('likelihood', 0)), 3),
                'ratio': round(float(m.get('ratio', 0)), 4),
                'peakiness': round(float(m.get('peakiness', 0)), 2),
                'band_rms': round(float(m.get('band_rms', 0)), 1),
                'ptp': round(float(m.get('ptp', 0)), 1),
                'movement': round(float(m.get('movement', 0)), 3),
                'present': int(m.get('present', 0)),
            }
            for m in minutes
        ],
    }


def fmt_local(ts: float) -> str:
    try:
        from zoneinfo import ZoneInfo
        dt = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(ZoneInfo(PT_LABEL))
        return dt.strftime('%Y-%m-%d %H:%M %Z')
    except Exception:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


def print_summary(result: dict) -> None:
    print('=' * 72)
    print(f"Side {result['side']}  sensor={result['sensor']}  band={result['snore_band_hz']} Hz")
    print(f"Window {result['start']} -> {result['end']}")
    print(f"RAW files={result['raw_files_used']}  packets={result['packets_scored']:,}  "
          f"present_min={result['present_minutes']}  snore_min={result['snore_minutes']}  "
          f"frac={result['snore_fraction_of_present']:.1%}")
    print(f"Clusters ({len(result['clusters'])}):")
    for c in result['clusters'][:12]:
        print(f"  {fmt_local(c['start_ts'])} -> {fmt_local(c['end_ts'])}  ({c['minutes']} min)")
    if len(result['clusters']) > 12:
        print(f"  ... +{len(result['clusters']) - 12} more")
    print('Top likelihood minutes:')
    for row in result['top_likelihood_minutes'][:8]:
        print(f"  {fmt_local(row['minute_ts'])}  L={row['likelihood']:.2f}  "
              f"ratio={row['ratio']:.3f}  peak={row['peakiness']:.1f}  mov={row['movement']:.2f}")


def night_from_record(rec: dict) -> Tuple[str, datetime, datetime, List[Tuple[datetime, datetime]]]:
    side = rec.get('side') or 'right'
    start = parse_dt(rec['entered_bed_at'])
    end = parse_dt(rec['left_bed_at'])
    intervals = []
    for pair in rec.get('present_intervals') or []:
        if len(pair) >= 2:
            intervals.append((parse_dt(pair[0]), parse_dt(pair[1])))
    return side, start, end, intervals


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description='Offline piezo snore detection v0')
    ap.add_argument('--raw-dir', default=os.environ.get('RAW_DATA_FOLDER', '/persistent'))
    ap.add_argument('--pod-api', default=os.environ.get('POD_API', ''))
    ap.add_argument('--night-ids', default='', help='Comma-separated sleep record ids')
    ap.add_argument('--side', choices=['left', 'right'], default=None)
    ap.add_argument('--start', default=None, help='UTC ISO start if not using --night-ids')
    ap.add_argument('--end', default=None, help='UTC ISO end if not using --night-ids')
    ap.add_argument('--sensor', default='1', choices=['1', '2'], help='Piezo channel suffix')
    ap.add_argument('--out', default='', help='Write full JSON results here')
    args = ap.parse_args(argv)

    raw_dir = Path(args.raw_dir)
    if not raw_dir.is_dir():
        print(f'ERROR: raw dir not found: {raw_dir}', file=sys.stderr)
        return 2

    jobs = []
    if args.night_ids:
        if not args.pod_api:
            print('ERROR: --pod-api required with --night-ids', file=sys.stderr)
            return 2
        records = fetch_sleep_records(args.pod_api)
        want = {int(x) for x in args.night_ids.split(',') if x.strip()}
        by_id = {int(r.get('id') or r.get('sleep_id') or -1): r for r in records}
        for nid in sorted(want):
            if nid not in by_id:
                print(f'ERROR: night id {nid} not found', file=sys.stderr)
                return 2
            side, start, end, intervals = night_from_record(by_id[nid])
            if args.side and side != args.side:
                print(f'WARN night {nid} side={side} != --side {args.side}; using record side')
            jobs.append({'id': nid, 'side': side, 'start': start, 'end': end, 'intervals': intervals})
    else:
        if not args.side or not args.start or not args.end:
            print('ERROR: provide --night-ids or --side/--start/--end', file=sys.stderr)
            return 2
        jobs.append({
            'id': None,
            'side': args.side,
            'start': parse_dt(args.start),
            'end': parse_dt(args.end),
            'intervals': [],
        })

    results = []
    for job in jobs:
        print(f"\nAnalyzing side={job['side']} id={job['id']} ...", flush=True)
        result = analyze_side(
            raw_dir,
            job['side'],
            job['start'],
            job['end'],
            job['intervals'],
            sensor=args.sensor,
        )
        result['night_id'] = job['id']
        print_summary(result)
        # Drop full timeline from stdout path; keep in JSON
        results.append(result)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            'algorithm': 'snore_v0_piezo_spectral',
            'band_hz': list(SNORE_BAND_HZ),
            'notes': (
                'Heuristic only — band energy + peakiness on presence epochs. '
                'Not OEM ML. Movement-heavy minutes suppressed.'
            ),
            'results': results,
        }
        out_path.write_text(json.dumps(payload, indent=2))
        print(f'\nWrote {out_path}')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
