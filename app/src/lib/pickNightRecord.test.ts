// Run: node --test src/lib/pickNightRecord.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLongestOfLatestNight } from './pickNightRecord.ts';

const r = (id: number, left: string, secs: number) => ({ id, left_bed_at: left, sleep_period_seconds: secs });

test('split night picks longest fragment, not last', () => {
  const recs = [
    r(1, '2026-01-04T07:30:00', 30000),
    r(2, '2026-01-05T02:47:00', 17637),
    r(3, '2026-01-05T07:30:00', 13986),
  ];
  assert.equal(pickLongestOfLatestNight(recs)?.id, 2);
});

test('single record per night picks latest night', () => {
  const recs = [r(1, '2026-01-04T07:30:00', 40000), r(2, '2026-01-05T07:30:00', 30000)];
  assert.equal(pickLongestOfLatestNight(recs)?.id, 2);
});

test('empty', () => {
  assert.equal(pickLongestOfLatestNight([]), undefined);
});
