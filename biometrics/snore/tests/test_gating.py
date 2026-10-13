"""python3 -m unittest discover -s biometrics/snore/tests"""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from gating import excluded_windows, gate_timeline, snore_total  # noqa: E402

T0 = datetime(2026, 1, 1, 4, 44, tzinfo=timezone.utc)


def stage(labels, onset=1):
    eps = []
    for i, lab in enumerate(labels):
        s = T0 + timedelta(minutes=5 * i)
        eps.append({'start': s.isoformat().replace('+00:00', 'Z'),
                    'end': (s + timedelta(minutes=5)).isoformat().replace('+00:00', 'Z'),
                    'stage': lab, 'reasons': []})
    return {'epochs': eps, 'onset_end_index': onset}


def timeline(snore_minute_offsets, total_minutes):
    on = set(snore_minute_offsets)
    return [{'timestamp': int((T0 + timedelta(minutes=m)).timestamp()), 'side': 's',
             'snore': 1 if m in on else 0, 'likelihood': 0.5} for m in range(total_minutes)]


A, L, R, D = 'awake', 'light', 'rem', 'deep'


class Gating(unittest.TestCase):
    def test_replay_awake_evening_bout_is_removed(self):
        # Replays a real pattern: in bed but awake (arousal/stirring epochs with
        # short light/rem blips), a 44-min continuous "snore" bout 55..99 min
        # after entering bed, then sustained sleep later. Heuristic counted 44.
        labels = [A, A, L, L, A, A, R, R, A, L, A, A, A, A, L, A, A, A, A, A,
                  A, A, A, A, A, A, L, L, L, L, D, D, L, L, R, R, L, L, L, L]
        tl = timeline(range(55, 99), len(labels) * 5)
        self.assertEqual(snore_total(tl), 44)
        gated, n = gate_timeline(tl, excluded_windows(stage(labels)))
        self.assertEqual(snore_total(gated), 0)
        self.assertEqual(n, 44)

    def test_snore_in_sustained_sleep_kept(self):
        labels = [A, A, A] + [L] * 10 + [D] * 5 + [R] * 5
        tl = timeline(list(range(40, 50)) + list(range(80, 85)), len(labels) * 5)
        gated, n = gate_timeline(tl, excluded_windows(stage(labels)))
        self.assertEqual(snore_total(gated), 15)
        self.assertEqual(n, 0)

    def test_onset_grace_excludes_first_minutes(self):
        labels = [A, A] + [L] * 20  # sustained sleep starts at minute 10
        tl = timeline(range(10, 30), len(labels) * 5)
        gated, _ = gate_timeline(tl, excluded_windows(stage(labels)))
        self.assertEqual(snore_total(gated), 10)  # minutes 10..19 are grace

    def test_mid_night_awake_epoch_gated(self):
        labels = [L] * 10 + [A, A] + [L] * 10
        tl = timeline(range(50, 60), len(labels) * 5)
        gated, n = gate_timeline(tl, excluded_windows(stage(labels)))
        self.assertEqual((snore_total(gated), n), (0, 10))

    def test_lone_epoch_between_awake_is_blip(self):
        labels = [L] * 6 + [A] + [D] + [A] + [L] * 6
        self.assertIsNotNone(excluded_windows(stage(labels)))
        tl = timeline(range(35, 40), len(labels) * 5)  # the lone D epoch
        gated, _ = gate_timeline(tl, excluded_windows(stage(labels)))
        self.assertEqual(snore_total(gated), 0)  # flanked by awake -> blip

    def test_no_sustained_sleep_fails_open(self):
        labels = [A, L, A, L, L, A]
        self.assertIsNone(excluded_windows(stage(labels)))
        tl = timeline(range(0, 10), 30)
        gated, n = gate_timeline(tl, None)
        self.assertEqual((snore_total(gated), n), (10, 0))

    def test_missing_stage_fails_open(self):
        self.assertIsNone(excluded_windows(None))
        self.assertIsNone(excluded_windows({'epochs': []}))

    def test_rows_kept_for_overwrite(self):
        labels = [A] * 4 + [L] * 10
        tl = timeline(range(0, 10), len(labels) * 5)
        gated, _ = gate_timeline(tl, excluded_windows(stage(labels)))
        self.assertEqual(len(gated), len(tl))


if __name__ == '__main__':
    unittest.main()
