// Run: node --test src/lib/waterStatus.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waterBanner, waterLabel, type WaterStatus } from './waterStatus.ts';

const base: WaterStatus = {
  state: 'ok', isLow: false, isPriming: false, source: 'firmware_flag', levelPercent: null,
  rawValue: 'true', lowSince: null, lastChangedAt: null, lastCheckedAt: null,
  lowForSeconds: 0, alertAfterSeconds: 120, alert: false, stale: false,
};

test('no banner when ok or not loaded', () => {
  assert.equal(waterBanner(base), null);
  assert.equal(waterBanner(undefined), null);
  assert.equal(waterLabel(base), 'OK');
});

test('banner when low', () => {
  const b = waterBanner({ ...base, state: 'low', isLow: true, rawValue: 'false', lowSince: '2026-01-01T10:05:00Z' });
  assert.equal(b?.severity, 'warning');
  assert.match(b!.text, /low or empty/);
  assert.match(b!.text, /low since \d\d:\d\d/);
  assert.equal(waterLabel({ ...base, state: 'low', isLow: true }), 'Low');
});

test('unexpected firmware value surfaces, no sample stays quiet', () => {
  assert.match(waterBanner({ ...base, state: 'unknown', rawValue: 'maybe' })!.text, /maybe/);
  assert.equal(waterBanner({ ...base, state: 'unknown', rawValue: null }), null);
  assert.equal(waterLabel({ ...base, state: 'unknown', rawValue: null }), 'Unknown');
});
