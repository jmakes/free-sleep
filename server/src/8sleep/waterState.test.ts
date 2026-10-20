// Run: node --test server/src/8sleep/waterState.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaterTracker, parseWaterFlag } from './waterState.ts';

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

test('parses the firmware flag', () => {
  assert.equal(parseWaterFlag('true'), 'ok');
  assert.equal(parseWaterFlag('false'), 'low');
  assert.equal(parseWaterFlag('maybe'), 'unknown');
  assert.equal(parseWaterFlag(undefined), 'unknown');
});

test('unknown before any sample, and stale', () => {
  const w = createWaterTracker();
  const a = w.alertView(120, t(0));
  assert.equal(a.state, 'unknown');
  assert.equal(a.alert, false);
  assert.equal(a.stale, true);
  assert.equal(a.levelPercent, null);
});

test('low sets lowSince; alert only after debounce', () => {
  const w = createWaterTracker();
  w.record('true', false, t(0));
  assert.equal(w.record('false', false, t(10)), 'ok');
  assert.equal(w.get().lowSince, t(10).toISOString());
  assert.equal(w.alertView(120, t(60)).alert, false);
  w.record('false', false, t(130));
  const a = w.alertView(120, t(130));
  assert.equal(a.alert, true);
  assert.equal(a.lowForSeconds, 120);
  assert.equal(w.get().lowSince, t(10).toISOString()); // unchanged by repeat low samples
});

test('refill clears low', () => {
  const w = createWaterTracker();
  w.record('false', false, t(0));
  w.record('true', false, t(200));
  const a = w.alertView(120, t(300));
  assert.equal(a.isLow, false);
  assert.equal(a.lowSince, null);
  assert.equal(a.alert, false);
});

test('one unexpected value does not reset lowSince', () => {
  const w = createWaterTracker();
  w.record('false', false, t(0));
  w.record('???', false, t(5));
  w.record('false', false, t(10));
  assert.equal(w.get().lowSince, t(0).toISOString());
});

test('stale after no samples for 5 minutes', () => {
  const w = createWaterTracker();
  w.record('true', true, t(0));
  assert.equal(w.alertView(120, t(100)).stale, false);
  assert.equal(w.alertView(120, t(400)).stale, true);
  assert.equal(w.get().isPriming, true);
});
