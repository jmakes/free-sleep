#!/usr/bin/env python3
"""
Offline snore detection v0 — piezo spectral heuristic on presence epochs.

Loads CBOR `.RAW` `piezo-dual` packets (full 500 Hz int32 arrays), gates on sleep
present_intervals (or piezo range), computes 20–150 Hz band features, and reports
per-minute snore likelihood + total snore minutes.

With --persist, writes the heuristic timeline into SQLite (snore table +
sleep_records.snore_minutes), mirroring movement persistence.

Examples:
  python3 scripts/analyze_snore_v0.py \\
    --raw-dir /persistent \\
    --pod-api http://127.0.0.1:3000 \\
    --night-ids 180,182 \\
    --out /tmp/snore_v0_last_night.json

  # Persist to local/Pod DB after scoring:
  python3 scripts/analyze_snore_v0.py --raw-dir /persistent --side right \\
    --start 2026-09-29T04:47:00Z --end 2026-09-29T13:16:00Z --persist
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'biometrics'))

from snore.analyze import (  # noqa: E402
    ALGORITHM,
    SNORE_BAND_HZ,
    analyze_side,
    parse_dt,
)

PT_LABEL = 'America/Los_Angeles'


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read().decode())


def fetch_sleep_records(base: str) -> list:
    data = get_json(f'{base.rstrip("/")}/api/metrics/sleep')
    if isinstance(data, list):
        return data
    return data.get('sleepRecords') or data.get('records') or data.get('data') or []


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


def night_from_record(rec: dict) -> Tuple[str, datetime, datetime, list]:
    side = rec.get('side') or 'right'
    start = parse_dt(rec['entered_bed_at'])
    end = parse_dt(rec['left_bed_at'])
    intervals = []
    for pair in rec.get('present_intervals') or []:
        if len(pair) >= 2:
            intervals.append((parse_dt(pair[0]), parse_dt(pair[1])))
    return side, start, end, intervals


def persist_result(result: dict, sleep_id=None) -> None:
    import pandas as pd
    # db.py resolves the existing named logger; init before importing db.
    from get_logger import get_logger
    get_logger('sleep-analyzer')
    from db import insert_snore_df, update_sleep_record_snore_minutes

    timeline = result.get('timeline') or []
    if timeline:
        df = pd.DataFrame(timeline)
        insert_snore_df(df[['timestamp', 'side', 'snore', 'likelihood']])
    total = int(result.get('snore_minutes') or 0)
    if sleep_id is not None:
        update_sleep_record_snore_minutes(int(sleep_id), total)
    else:
        update_sleep_record_snore_minutes(
            None,
            total,
            side=result['side'],
            entered_bed_at=int(parse_dt(result['start']).timestamp()),
        )
    print(f"Persisted heuristic snore_minutes={total} id={sleep_id} side={result['side']}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description='Offline piezo snore detection v0 (heuristic)')
    ap.add_argument('--raw-dir', default=os.environ.get('RAW_DATA_FOLDER', '/persistent'))
    ap.add_argument('--pod-api', default=os.environ.get('POD_API', ''))
    ap.add_argument('--night-ids', default='', help='Comma-separated sleep record ids')
    ap.add_argument('--side', choices=['left', 'right'], default=None)
    ap.add_argument('--start', default=None, help='UTC ISO start if not using --night-ids')
    ap.add_argument('--end', default=None, help='UTC ISO end if not using --night-ids')
    ap.add_argument('--sensor', default='1', choices=['1', '2'], help='Piezo channel suffix')
    ap.add_argument('--out', default='', help='Write full JSON results here')
    ap.add_argument(
        '--persist',
        action='store_true',
        help='Write heuristic timeline + snore_minutes into SQLite (mirrors movement)',
    )
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
        if args.persist:
            persist_result(result, sleep_id=job['id'])
        results.append(result)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            'algorithm': ALGORITHM,
            'heuristic': True,
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
