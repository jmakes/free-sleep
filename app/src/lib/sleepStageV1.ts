/**
 * stage_v1 awake (jmakes.12): adaptive lower-half-median baseline (bed+90m .. end-75m);
 * mild-stillness onset (\u003c500, HR\u003c=baseline*1.08); elevated awake quiet*1.15 / stirring*1.10.
 * Compact mirror of biometrics/sleep_detection/stage_v1.py (awake rules).
 * No person-specific hardcoded HR bpm values — ratios vs adaptive baseline only.
 */
import type { MovementRecord } from '../../../server/src/db/movementRecordSchema.ts';
import type { VitalRecord } from '../../../server/src/db/prismaDbTypes.ts';
import { BRIEF_GAP_SECONDS, type IntervalPair } from './bedExits.ts';

export type SleepStage = 'awake' | 'light' | 'deep' | 'rem';
export type StageEpoch = { startMs: number; endMs: number; stage: SleepStage; reasons: string[] };
export type StageSummary = {
  version: 'stage_v1';
  epochs: StageEpoch[];
  minutes: Record\u003cSleepStage, number\u003e;
  percent: Record\u003cSleepStage, number\u003e;
  /** Adaptive sleep baseline HR (bpm); 0 if unavailable. */
  baselineHr?: number;
  /** Adaptive sleep baseline BR; 0 if unavailable. */
  baselineBr?: number;
  /** Epoch index where sleep_onset ends (first post-onset epoch); length if never. */
  onsetEndIndex?: number;
};

const EPOCH_MS = 5 * 60 * 1000;
const MIN_BLOCK = 2;
const QUIET = 200;
const RESTLESS = 900;
/** Mild stillness for onset — stirring OK, thrashing not. */
const ONSET_STILL = 500;
const ONSET_N = 3;
const MIN_BASELINE_N = 6;
/** Exclude first ~90 min (onset tail) from baseline pool. */
const ONSET_SKIP_MS = 90 * 60 * 1000;
/** Exclude last ~75 min (morning wake) from baseline pool. */
const TAIL_MS = 75 * 60 * 1000;
const HR_NEAR = 1.08;
const HR_EQ = 1.15;
const HR_ES = 1.1;
const MIN_ELEV = 2;

function toMs(v: string | number | Date): number {
  if (typeof v === 'number') return v \u003c 1e12 ? v * 1000 : v;
  return new Date(v).getTime();
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) =\u003e a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Median of values at or below the overall median (lower half). */
function lowerHalfMedian(xs: number[]): number {
  if (!xs.length) return 0;
  const m = median(xs);
  const lower = xs.filter((v) =\u003e v \u003c= m);
  return median(lower.length ? lower : xs);
}
function maxMov(rows: { t: number; v: number }[], a: number, b: number): number {
  let m = 0;
  for (const r of rows) if (r.t \u003e= a && r.t \u003c b) m = Math.max(m, r.v);
  return m;
}
