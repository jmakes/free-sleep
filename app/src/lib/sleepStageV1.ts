/**
 * stage_v1 -- multi-signal sleep-stage heuristic (movement + HR + HRV + breathing + presence).
 *
 * NOT medical-grade and NOT Eight Sleep / Garmin ground truth. Tuned for the left-side /
 * Hsiaolin path where capacitance calibration is good. See docs/sleep_stage_v1.md.
 *
 * Awake pass (jmakes.10): sleep-baseline HR from quiet epochs, sleep-onset latency,
 * and quiet/restless-mind elevated-HR wake (not whole-night median).
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
/** Need this many quiet epochs before trusting quiet-HR median as sleep baseline. */
const MIN_QUIET_BASELINE_EPOCHS = 6;
/** Near-sleep HR ceiling during onset (quiet/stirring + HR <= baseline x this). */
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
 * Fallback: 30th percentile of all positive epoch HR means (avoids wake-inflated median).
 */
function sleepBaselineHr(
  epochHrs: { movementMax: number; hr: number; hasVitals: boolean }[],
): number {
  const quietHrs = epochHrs
    .filter((e) => e.hasVitals && e.hr > 0 && e.movementMax < MOVEMENT_QUIET)
    .map((e) => e.hr);
  if (quietHrs.length >= MIN_QUIET_BASELINE_EPOCHS) return median(quietHrs);

  const allHrs = epochHrs.filter((e) => e.hasVitals && e.hr > 0).map((e) => e.hr);
  return percentile(allHrs, 0.3);
}

function sleepBaselineBr(
  epochBrs: { movementMax: number; br: number; hasVitals: boolean }[],
): number {
  const quietBrs = epochBrs
    .filter((e) => e.hasVitals && e.br > 0 && e.movementMax < MOVEMENT_QUIET)
    .map((e) => e.br);
  if (quietBrs.length >= MIN_QUIET_BASELINE_EPOCHS) return median(quietBrs);

  const allBrs = epochBrs.filter((e) => e.hasVitals && e.br > 0).map((e) => e.br);
  return percentile(allBrs, 0.3);
}

function isAsleepLike(args: {
  movementMax: number;
  hr: number;
  hasVitals: boolean;
  isAbsent: boolean;
  baselineHr: number;
}): boolean {
  if (args.isAbsent) return false;
  const restless = args.movementMax >= MOVEMENT_RESTLESS;
  if (restless) return false;
  const quietOrStirring = args.movementMax < MOVEMENT_RESTLESS;
  if (!quietOrStirring) return false;
  if (!args.hasVitals || args.baselineHr <= 0) {
    // Without vitals, only quiet counts as asleep-like (stirring alone is weak).
    return args.movementMax < MOVEMENT_QUIET;
  }
  return args.hr > 0 && args.hr <= args.baselineHr * HR_NEAR_SLEEP;
}

function classifyEpoch(args: {
  movementMax: number;
  hr: number;
  hrv: number;
  br: number;
  hasVitals: boolean;
  isAbsent: boolean;
  baselineHr: number;
  medHrv: number;
  baselineBr: number;
}): { stage: SleepStage; reasons: string[] } {
  const reasons: string[] = [];

  if (args.isAbsent) {
    reasons.push('presence_gap');
    return { stage: 'awake', reasons };
  }

  const restless = args.movementMax >= MOVEMENT_RESTLESS;
  const stirring = args.movementMax >= MOVEMENT_QUIET && !restless;
  const quiet = args.movementMax < MOVEMENT_QUIET;

  if (restless) reasons.push('restless_movement');
  else if (stirring) reasons.push('stirring');
  else reasons.push('quiet_movement');

  if (!args.hasVitals || args.baselineHr <= 0) {
    // Movement-only fallback (still honest: no fake Deep/REM without vitals)
    if (restless) return { stage: 'awake', reasons: [...reasons, 'no_vitals'] };
    return { stage: 'light', reasons: [...reasons, 'no_vitals'] };
  }

  const hrLow = args.hr > 0 && args.hr <= args.baselineHr;
  const hrElevatedQuiet = args.hr >= args.baselineHr * HR_ELEVATED_QUIET;
  const hrElevatedStirring = args.hr >= args.baselineHr * HR_ELEVATED_STIRRING;
  // Mild elevation used for REM (above baseline but below quiet-wake threshold).
  const hrMildHigh = args.hr >= args.baselineHr * 1.05;
  const hrvHigh = args.hrv >= args.medHrv * 1.08 && args.medHrv > 0;
  const hrvLow = args.hrv > 0 && args.medHrv > 0 && args.hrv <= args.medHrv * 0.95;
  const brLow = args.br > 0 && args.baselineBr > 0 && args.br <= args.baselineBr * 1.02;

  // Restless body -> Awake (arousal), even without elevated HR.
  if (restless) {
    reasons.push('arousal');
    return { stage: 'awake', reasons };
  }

  // Quiet / restless-mind awake: elevated HR vs sleep baseline.
  if (quiet && hrElevatedQuiet) {
    reasons.push('elevated_hr_quiet');
    return { stage: 'awake', reasons };
  }
  if (stirring && hrElevatedStirring) {
    reasons.push('elevated_hr_stirring');
    return { stage: 'awake', reasons };
  }

  // Deep-ish: very quiet, lower HR, lower breathing, HRV not spiking like REM
  if (quiet && hrLow && brLow && !hrvHigh) {
    reasons.push('deep_signals');
    return { stage: 'deep', reasons };
  }

  // REM-ish: quiet/mild stirring, HR slightly up, HRV up (autonomic variability)
  // Must not claim REM when quiet HR already hit awake threshold (handled above).
  if ((quiet || stirring) && hrMildHigh && hrvHigh && !restless) {
    reasons.push('rem_signals');
    return { stage: 'rem', reasons };
  }

  // Quiet but not deep -> light; mild HR drop without full deep stack
  if (quiet && (hrLow || hrvLow)) {
    reasons.push('light_quiet');
    return { stage: 'light', reasons };
  }

  reasons.push('default_light');
  return { stage: 'light', reasons };
}

/** Mark pre-onset epochs Awake until N consecutive asleep-like epochs. */
function applySleepOnset(
  epochs: StageEpoch[],
  features: {
    movementMax: number;
    hr: number;
    hasVitals: boolean;
    isAbsent: boolean;
  }[],
  baselineHr: number,
): StageEpoch[] {
  if (!epochs.length) return epochs;
  const out = epochs.map((epoch) => ({ ...epoch, reasons: [...epoch.reasons] }));
  let consecutive = 0;
  let onsetEnd = out.length; // if never consolidates, whole night stays onset-marked where applied
  for (let i = 0; i < out.length; i += 1) {
    const feat = features[i];
    if (
      isAsleepLike({
        movementMax: feat.movementMax,
        hr: feat.hr,
        hasVitals: feat.hasVitals,
        isAbsent: feat.isAbsent,
        baselineHr,
      })
    ) {
      consecutive += 1;
      if (consecutive >= SLEEP_ONSET_CONSECUTIVE) {
        onsetEnd = i - SLEEP_ONSET_CONSECUTIVE + 1;
        break;
      }
    } else {
      consecutive = 0;
    }
  }

  for (let i = 0; i < onsetEnd; i += 1) {
    if (out[i].stage === 'awake' && out[i].reasons.includes('presence_gap')) continue;
    out[i] = {
      ...out[i],
      stage: 'awake',
      reasons: [...out[i].reasons.filter((r) => r !== 'sleep_onset'), 'sleep_onset'],
    };
  }
  return out;
}

/**
 * Demote isolated single elevated-HR awake epochs sandwiched in sleep.
 * Do not demote runs of >= MIN_ELEVATED_AWAKE_RUN (sustained restless-mind wake).
 */
function smoothIsolatedElevatedAwake(epochs: StageEpoch[]): StageEpoch[] {
  const elevatedCodes = new Set(['elevated_hr_quiet', 'elevated_hr_stirring']);
  const out = epochs.map((epoch) => ({ ...epoch, reasons: [...epoch.reasons] }));
  let index = 0;
  while (index < out.length) {
    if (out[index].stage !== 'awake' || !out[index].reasons.some((r) => elevatedCodes.has(r))) {
      index += 1;
      continue;
    }
    let end = index;
    while (
      end < out.length &&
      out[end].stage === 'awake' &&
      out[end].reasons.some((r) => elevatedCodes.has(r))
    ) {
      end += 1;
    }
    const runLen = end - index;
    if (runLen < MIN_ELEVATED_AWAKE_RUN) {
      const prevSleep = index > 0 && out[index - 1].stage !== 'awake';
      const nextSleep = end < out.length && out[end].stage !== 'awake';
      if (prevSleep && nextSleep) {
        for (let i = index; i < end; i += 1) {
          out[i] = {
            ...out[i],
            stage: 'light',
            reasons: [...out[i].reasons, 'smoothed_isolated_awake'],
          };
        }
      }
    }
    index = end;
  }
  return out;
}

/** Collapse isolated Deep/REM epochs shorter than MIN_BLOCK_EPOCHS into Light. */
function smoothStages(epochs: StageEpoch[]): StageEpoch[] {
  if (epochs.length < MIN_BLOCK_EPOCHS) {
    return epochs.map((epoch) =>
      epoch.stage === 'deep' || epoch.stage === 'rem'
        ? { ...epoch, stage: 'light' as SleepStage, reasons: [...epoch.reasons, 'smoothed_short'] }
        : epoch,
    );
  }

  const out = epochs.map((epoch) => ({ ...epoch, reasons: [...epoch.reasons] }));
  let index = 0;
  while (index < out.length) {
    const stage = out[index].stage;
    if (stage !== 'deep' && stage !== 'rem') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < out.length && out[end].stage === stage) end += 1;
    const runLen = end - index;
    if (runLen < MIN_BLOCK_EPOCHS) {
      for (let i = index; i < end; i += 1) {
        out[i] = {
          ...out[i],
          stage: 'light',
          reasons: [...out[i].reasons, 'smoothed_short'],
        };
      }
    }
    index = end;
  }
  return out;
}

export function computeStageV1(args: {
  enteredBedAt: string | number | Date;
  leftBedAt: string | number | Date;
  vitals?: VitalRecord[] | null;
  movement?: MovementRecord[] | null;
  notPresentIntervals?: IntervalPair[] | null;
}): StageSummary {
  const nightStart = toMs(args.enteredBedAt);
  const nightEnd = toMs(args.leftBedAt);

  const movement = (args.movement || [])
    .map((row) => ({ t: toMs(row.timestamp as unknown as string | number), v: Number(row.total_movement) || 0 }))
    .filter((row) => row.t >= nightStart && row.t <= nightEnd)
    .sort((a, b) => a.t - b.t);

  const vitals = (args.vitals || [])
    .map((row) => ({
      t: toMs(row.timestamp as unknown as string | number),
      hr: Number(row.heart_rate) || 0,
      hrv: Number(row.hrv) || 0,
      br: Number(row.breathing_rate) || 0,
    }))
    .filter((row) => row.t >= nightStart && row.t <= nightEnd && row.hr > 0)
    .sort((a, b) => a.t - b.t);

  const absences = (args.notPresentIntervals || [])
    .map((pair) => ({ start: toMs(pair[0]), end: toMs(pair[1]) }))
    .filter((gap) => gap.end > gap.start);

  // First pass: gather per-epoch features for sleep baseline (quiet-only).
  type EpochFeat = {
    startMs: number;
    endMs: number;
    movementMax: number;
    hr: number;
    hrv: number;
    br: number;
    hasVitals: boolean;
    isAbsent: boolean;
  };
  const features: EpochFeat[] = [];
  for (let startMs = nightStart; startMs < nightEnd; startMs += EPOCH_MS) {
    const endMs = Math.min(startMs + EPOCH_MS, nightEnd);
    const movementMax = maxMovementInWindow(movement, startMs, endMs);
    const vital = meanVitalInWindow(vitals, startMs, endMs);
    const isAbsent = overlapsAbsent(absences, startMs, endMs, BRIEF_GAP_SECONDS);
    features.push({
      startMs,
      endMs,
      movementMax,
      hr: vital.hr,
      hrv: vital.hrv,
      br: vital.br,
      hasVitals: vital.n > 0,
      isAbsent,
    });
  }

  const baselineHr = sleepBaselineHr(features);
  const baselineBr = sleepBaselineBr(features);
  // HRV still uses whole-night median of positive samples (less wake-skewed than HR).
  const medHrv = median(vitals.map((v) => v.hrv).filter((v) => v > 0));

  const raw: StageEpoch[] = features.map((feat) => {
    const { stage, reasons } = classifyEpoch({
      movementMax: feat.movementMax,
      hr: feat.hr,
      hrv: feat.hrv,
      br: feat.br,
      hasVitals: feat.hasVitals,
      isAbsent: feat.isAbsent,
      baselineHr,
      medHrv,
      baselineBr,
    });
    return { startMs: feat.startMs, endMs: feat.endMs, stage, reasons };
  });

  const withOnset = applySleepOnset(raw, features, baselineHr);
  const withElevatedSmooth = smoothIsolatedElevatedAwake(withOnset);
  const epochs = smoothStages(withElevatedSmooth);

  const minutes: Record<SleepStage, number> = { awake: 0, light: 0, deep: 0, rem: 0 };
  for (const epoch of epochs) {
    minutes[epoch.stage] += (epoch.endMs - epoch.startMs) / 60_000;
  }
  const total = Object.values(minutes).reduce((a, b) => a + b, 0) || 1;
  const percent: Record<SleepStage, number> = {
    awake: Math.round((minutes.awake / total) * 100),
    light: Math.round((minutes.light / total) * 100),
    deep: Math.round((minutes.deep / total) * 100),
    rem: Math.round((minutes.rem / total) * 100),
  };

  return { version: 'stage_v1', epochs, minutes, percent };
}
