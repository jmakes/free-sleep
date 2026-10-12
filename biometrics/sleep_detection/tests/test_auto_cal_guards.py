"""python3 -m unittest discover -s biometrics/sleep_detection/tests"""
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from auto_cal_guards import (  # noqa: E402
    drop_overflow, effective_lookback, oldest_raw_mtime, retained_days, stats_look_wrapped,
)


class Guards(unittest.TestCase):
    def test_wrapped_stat_rejected(self):
        self.assertTrue(stats_look_wrapped(4_295_229, 4_295_243))  # ~2**32/1000 (Sep 23 run)
        self.assertTrue(stats_look_wrapped(4_294_967_000, 10))
        self.assertFalse(stats_look_wrapped(859_834, 974_732))

    def test_drop_overflow(self):
        kept, dropped = drop_overflow([10_000, 2 ** 32 - 5, float('nan'), 200_000, -1])
        self.assertEqual(kept, [10_000, 200_000])
        self.assertEqual(dropped, 3)

    def test_lookback_capped_to_retained(self):
        self.assertEqual(effective_lookback(14, 1), 1)
        self.assertEqual(effective_lookback(14, 20), 14)
        self.assertEqual(effective_lookback(14, 0), 0)

    def test_retained_days(self):
        now = datetime(2026, 1, 10, tzinfo=timezone.utc)
        self.assertEqual(retained_days(now.timestamp() - 32 * 3600, now), 1)
        self.assertEqual(retained_days(now.timestamp() - 3600, now), 0)
        self.assertEqual(retained_days(None, now), 0)

    def test_oldest_raw_mtime(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(oldest_raw_mtime(d))
            for name, age in (('A.RAW', 100), ('B.RAW', 5000), ('x.txt', 99999)):
                p = os.path.join(d, name)
                open(p, 'w').close()
                t = time.time() - age
                os.utime(p, (t, t))
            self.assertAlmostEqual(oldest_raw_mtime(d), time.time() - 5000, delta=5)


if __name__ == '__main__':
    unittest.main()
