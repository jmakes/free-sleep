/**
 * sleep score v1 -- explainable 0-100, Garmin-comparable in spirit (not calibrated yet).
 *
 * Components (weights sum to 100):
 *  - Duration 35
 *  - Continuity / exits 25
 *  - Restfulness / stage mix 20
 *  - Vitals stability 20
 */

import { displayExitCount, type IntervalPair } from './bedExits.ts';
import { computeStageV1, type StageSummary } from './sleepStageV1.ts';
import type { MovementRecord } from '../../../server/src/db/movementRecordSchema.ts';
import type { VitalRecord } from '../../../server/src/db/prismaDbTypes.ts';

export type ScoreComponent = {
  key: 'duration' | 'continuity' | 'restfulness' | 'vitals';
  label: string;
  points: number;
  maxPoints: number;
  detail: string;
};

export type SleepScoreV1 = {
  version: 'sleep_score_v1';
  score: number;
  components: ScoreComponent[];
  stageSummary?: StageSummary;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function durationPoints(sleepPeriodSeconds: number): ScoreComponent {
  const maxPoints = 35;
  const hours = sleepPeriodSeconds / 3600;
  // Peak 7-9h; linear taper to 0 at 3h and 12h
  let points: number;
  if (hours >= 7 && hours <= 9) points = maxPoints;
  else if (hours < 7) points = maxPoints * clamp((hours - 3) / 4, 0, 1);
  else points = maxPoints * clamp((12 - hours) / 3, 0, 1);
  points = Math.round(points);
  return {
    key: 'duration',
    label: 'Duration',
    points,
    maxPoints,
    detail: `${hours.toFixed(1)}h in bed (target 7-9h)`,
  };
}

function continuityPoints(args: {
  notPresentIntervals?: IntervalPair[] | null;
  enteredBedAt?: string;
  leftBedAt?: string;
  timesExitedBed?: number;
}): ScoreComponent {
  const maxPoints = 25;
  const exits = displayExitCount({
    times_exited_bed: args.timesExitedBed,
    not_present_intervals: args.notPresentIntervals || undefined,
    entered_bed_at: args.enteredBedAt,
    left_bed_at: args.leftBedAt,
  });
  // -5 per meaningful exit, -1 per brief gap (cap brief penalty at 5)
  const penalty = exits.meaningfulExits * 5 + Math.min(5, exits.briefGaps);
  const points = clamp(maxPoints - penalty, 0, maxPoints);
  return {
    key: 'continuity',
    label: 'Continuity',
    points,
    maxPoints,
    detail: `${exits.meaningfulExits} exit(s) >=5m, ${exits.briefGaps} brief gap(s)`,
  };
}

function restfulnessPoints(stage: StageSummary | undefined, movement?: MovementRecord[] | null): ScoreComponent {
  const maxPoints = 20;
  if (stage && stage.epochs.length) {
    const deepRem = stage.percent.deep + stage.percent.rem;
    const awake = stage.percent.awake;
    // Reward deep+REM up to ~40%, penalize awake above ~10%
    let points = maxPoints * clamp(deepRem / 40, 0, 1);
    points -= maxPoints * 0.5 * clamp((awake - 10) / 30, 0, 1);
    points = Math.round(clamp(points, 0, maxPoints));
    return {
      key: 'restfulness',
      label: 'Restfulness',
      points,
      maxPoints,
      detail: `Deep ${stage.percent.deep}% | REM ${stage.percent.rem}% | Awake ${stage.percent.awake}%`,
    };
  }

  // Movement-only fallback
  const rows = movement || [];
  if (!rows.length) {
    return {
      key: 'restfulness',
      label: 'Restfulness',
      points: Math.round(maxPoints * 0.5),
      maxPoints,
      detail: 'No stage/movement data -- neutral',
    };
  }
  const quiet = rows.filter((r) => Number(r.total_movement) < 200).length;
  const restless = rows.filter((r) => Number(r.total_movement) >= 900).length;
  const quietPct = quiet / rows.length;
  const restlessPct = restless / rows.length;
  const points = Math.round(clamp(maxPoints * quietPct - maxPoints * restlessPct, 0, maxPoints));
  return {
    key: 'restfulness',
    label: 'Restfulness',
    points,
    maxPoints,
    detail: `${Math.round(quietPct * 100)}% quiet movement bins`,
  };
}

function vitalsPoints(vitals?: VitalRecord[] | null): ScoreComponent {
  const maxPoints = 20;
  const hrs = (vitals || []).map((v) => Number(v.heart_rate)).filter((h) => h > 0);
  const hrvs = (vitals || []).map((v) => Number(v.hrv)).filter((h) => h > 0);
  if (hrs.length < 3) {
    return {
      key: 'vitals',
      label: 'Vitals stability',
      points: Math.round(maxPoints * 0.5),
      maxPoints,
      detail: 'Insufficient HR samples -- neutral',
    };
  }
  const mean = hrs.reduce((a, b) => a + b, 0) / hrs.length;
  const variance = hrs.reduce((a, b) => a + (b - mean) ** 2, 0) / hrs.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  // Lower CV is better; CV 0.05 -> full points, CV 0.2 -> ~0
  let points = maxPoints * clamp(1 - (cv - 0.05) / 0.15, 0, 1);
  const meanHrv = hrvs.length ? hrvs.reduce((a, b) => a + b, 0) / hrvs.length : 0;
  // Small bonus for non-zero HRV (alive autonomic signal)
  if (meanHrv >= 20) points = Math.min(maxPoints, points + 2);
  points = Math.round(clamp(points, 0, maxPoints));
  return {
    key: 'vitals',
    label: 'Vitals stability',
    points,
    maxPoints,
    detail: `HR CV ${(cv * 100).toFixed(1)}% | avg HRV ${meanHrv ? Math.round(meanHrv) : '--'} ms`,
  };
}

export function computeSleepScoreV1(args: {
  sleepPeriodSeconds: number;
  enteredBedAt: string;
  leftBedAt: string;
  timesExitedBed?: number;
  notPresentIntervals?: IntervalPair[] | null;
  vitals?: VitalRecord[] | null;
  movement?: MovementRecord[] | null;
}): SleepScoreV1 {
  const stageSummary = computeStageV1({
    enteredBedAt: args.enteredBedAt,
    leftBedAt: args.leftBedAt,
    vitals: args.vitals,
    movement: args.movement,
    notPresentIntervals: args.notPresentIntervals,
  });

  const components = [
    durationPoints(args.sleepPeriodSeconds),
    continuityPoints({
      notPresentIntervals: args.notPresentIntervals,
      enteredBedAt: args.enteredBedAt,
      leftBedAt: args.leftBedAt,
      timesExitedBed: args.timesExitedBed,
    }),
    restfulnessPoints(stageSummary, args.movement),
    vitalsPoints(args.vitals),
  ];

  const score = clamp(
    components.reduce((sum, c) => sum + c.points, 0),
    0,
    100,
  );

  return { version: 'sleep_score_v1', score, components, stageSummary };
}
