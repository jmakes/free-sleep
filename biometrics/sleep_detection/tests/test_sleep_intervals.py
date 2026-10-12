"""Synthetic replays of mid-night gap patterns that used to split one night
into two records (or drop the short half). Stdlib only: python3 -m unittest."""
import os
import sys
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sleep_intervals import identify_sleep_intervals  # noqa: E402

CFG = dict(max_gap_in_minutes=45, min_sleep_hours=3, min_exit_gap_seconds=300,
           fragment_merge_gap_minutes=90)
BASE = datetime(2026, 1, 5, 21, 0)


def night(segments, block_min=20, flicker_s=30):
    """segments: list of (start_offset_min, end_offset_min). Each segment is
    chopped into blocks with short flicker gaps, like real presence data."""
    out = []
    for a, b in segments:
        t = BASE + timedelta(minutes=a)
        end = BASE + timedelta(minutes=b)
        while t < end:
            e = min(t + timedelta(minutes=block_min), end)
            out.append((t, e))
            t = e + timedelta(seconds=flicker_s)
    return out


class GapPatterns(unittest.TestCase):
    def one(self, segs):
        r = identify_sleep_intervals(night(segs), **CFG)
        self.assertEqual(len(r), 1, r)
        return r[0]

    def test_29_min_gap_both_halves_long(self):  # ~5.6h + 29m + ~4.2h
        r = self.one([(0, 338), (367, 622)])
        self.assertGreaterEqual(r['times_exited_bed'], 1)

    def test_39_min_gap(self):
        self.one([(0, 272), (311, 565)])

    def test_20_min_gap(self):
        self.one([(0, 233), (253, 595)])

    def test_short_first_half_not_dropped(self):  # 2.5h, 60m gap, 4h
        r = self.one([(0, 150), (210, 450)])
        self.assertEqual(r['entered_bed_at'], BASE)

    def test_short_second_half_not_dropped(self):  # 4h, 70m gap, 1.5h
        r = self.one([(0, 240), (310, 400)])
        self.assertEqual(r['left_bed_at'], BASE + timedelta(minutes=400))

    def test_fragmented_chunks(self):  # many short chunks with 15-40m gaps
        self.one([(0, 60), (80, 140), (180, 250), (270, 330), (370, 420)])

    def test_two_real_sleeps_stay_separate(self):  # nap + night, 6h apart
        r = identify_sleep_intervals(night([(0, 200), (560, 1000)]), **CFG)
        self.assertEqual(len(r), 2)

    def test_two_long_halves_far_apart_stay_separate(self):  # 2h gap, both >3h
        r = identify_sleep_intervals(night([(0, 240), (360, 600)]), **CFG)
        self.assertEqual(len(r), 2)

    def test_too_short_overall_dropped(self):
        self.assertEqual(identify_sleep_intervals(night([(0, 90), (120, 150)]), **CFG), [])

    def test_empty(self):
        self.assertEqual(identify_sleep_intervals([], **CFG), [])

    def test_flicker_not_exit(self):
        r = self.one([(0, 480)])
        self.assertEqual(r['times_exited_bed'], 0)


if __name__ == '__main__':
    unittest.main()
