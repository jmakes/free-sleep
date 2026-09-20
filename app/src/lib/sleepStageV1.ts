/**
 * stage_v1 -- multi-signal sleep-stage heuristic (movement + HR + HRV + breathing + presence).
 *
 * NOT medical-grade and NOT Eight Sleep / Garmin ground truth. Tuned for the left-side /
 * Hsiaolin path where capacitance calibration is good. See docs/sleep_stage_v1.md.
 *
 * Awake pass (jmakes.11): sleep-baseline HR = 30th pct of quiet epochs (exclude last
 * ~75 min morning wake); asleep-like requires quiet (not stirring); elevated-HR wake unchanged.
 */

import type { MovementRecord } from '../../../server/src/db/movementRecordSchema.ts';
import type { VitalRecord } from '../../../server/src/db/prismaDbTypes.ts';
import { BRIEF_GAP_SECONDS, type IntervalPair } from './bedExits.ts';

export type SleepStage = 'awake' | 'light' | 'deep' | 'rem';

export type StageEpoch = {
  startMs: number;
  endMs: number;
  stage: SleepStage;
  /** Short reason codes for explainability */
  reasons: string[];
};

export type StageSummary = {
  version: 'stage_v1';
  epochs: StageEpoch[];
  minutes: Record<SleepStage, number>;
  percent: Record<SleepStage, number>;
};

const EPOCH_MS = 5 * 60 * 1000;
const MIN_BLOCK_EPOCHS = 2; // >=10 min for Deep / REM after smoothing

const MOVEMENT_QUIET = 200;
const MOVEMENT_RESTLESS = 900;

/** Consecutive asleep-like epochs before sleep onset ends (~15 min). */
const SLEEP_ONSET_CONSECUTIVE = 3;
/** Need this many quiet epochs before trusting quiet-HR p30 as sleep baseline. */
const MIN_QUIET_BASELINE_EPOCHS = 6;
/** Drop last N ms of night from quiet-baseline pool (morning in-bed wake). */
const BASELINE_EXCLUDE_TAIL_MS = 75 * 60 * 1000;
/** Near-sleep HR ceiling during onset (quiet + HR <= baseline x this). */
const HR_NEAR_SLEEP = 1.03;
/** Quiet body + elevated HR -> restless-mind awake. */
const HR_ELEVATED_QUIET = 1.1;
/** Stirring + mildly elevated HR -> awake. */
const HR_ELEVATED_STIRRING = 1.05;
/** Isolated single elevated-HR awake epochs demote to Light; runs >= this keep. */
const MIN_ELEVATED_AWAKE_RUN = 2;

function toMs(value: string | number | Date): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return new Date(value).getTime();
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Percentile in [0, 1] on a copy (inclusive nearest-rank style). */
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function maxMovementInWindow(
  movement: { t: number; v: number }[],
  startMs: number,
  endMs: number,
): number {
  let max = 0;
  for (const row of movement) {
    if (row.t >= startMs && row.t < endMs) max = Math.max(max, row.v);
  }
  return max;
}

function meanVitalInWindow(
  vitals: { t: number; hr: number; hrv: number; br: number }[],
  startMs: number,
  endMs: number,
): { hr: number; hrv: number; br: number; n: number } {
  let hr = 0;
  let hrv = 0;
  let br = 0;
  let n = 0;
  for (const row of vitals) {
    if (row.t >= startMs && row.t < endMs) {
      if (row.hr > 0) {
        hr += row.hr;
        hrv += row.hrv;
        br += row.br;
        n += 1;
      }
    }
  }
  if (!n) return { hr: 0, hrv: 0, br: 0, n: 0 };
  return { hr: hr / n, hrv: hrv / n, br: br / n, n };
}

function overlapsAbsent(
  absences: { start: number; end: number }[],
  startMs: number,
  endMs: number,
  minGapSeconds: number,
): boolean {
  for (const gap of absences) {
    const overlapStart = Math.max(gap.start, startMs);
    const overlapEnd = Math.min(gap.end, endMs);
    if (overlapEnd - overlapStart >= minGapSeconds * 1000) return true;
  }
  return false;
}

/**
 * Sleep baseline HR from quiet-movement epoch means.
 * Uses 30th percentile (not median) so morning quiet-wake HR does not inflate baseline.
 * Excludes the last ~75 minutes of the night from the quiet pool when timestamps exist.
 * Fallback: 30th percentile of all positive epoch HR means.
 */
function sleepBaselineHr(
  epochHrs: { movementMax: number; hr: number; hasVitals: boolean; startMs?: number }[],
): number {
  const nightEnd = epochHrs.reduce((m, e) => Math.max(m, e.startMs ?? 0), 0);
  const cutoff = nightEnd > 0 ? nightEnd - BASELINE_EXCLUDE_TAIL_MS : 0;
  const quietHrs = epochHrs
    .filter(
      (e) =>
        e.hasVitals &&
        e.hr > 0 &&
        e.movementMax < MOVEMENT_QUIET &&
        (cutoff <= 0 || e.startMs === undefined || e.startMs < cutoff),
    )
    .map
