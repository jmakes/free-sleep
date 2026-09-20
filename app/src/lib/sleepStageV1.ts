/**
 * stage_v1 awake (jmakes.12): adaptive lower-half-median baseline (bed+90m .. end-75m);
 * mild-stillness onset (<500, HR<=baseline*1.08); elevated awake quiet*1.15 / stirring*1.10.
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
  minutes: Record<SleepStage, number>;
  percent: Record<SleepStage, number>;
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
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  return new Date(v).getTime();
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Median of values at or below the overall median (lower half). */
function lowerHalfMedian(xs: number[]): number {
  if (!xs.length) return 0;
  const m = median(xs);
  const lower = xs.filter((v) => v <= m);
  return median(lower.length ? lower : xs);
}
function maxMov(rows: { t: number; v: number }[], a: number, b: number): number {
  let m = 0;
  for (const r of rows) if (r.t >= a && r.t < b) m = Math.max(m, r.v);
  return m;
}
function meanVit(
  rows: { t: number; hr: number; hrv: number; br: number }[],
  a: number,
  b: number,
): { hr: number; hrv: number; br: number; n: number } {
  let hr = 0, hrv = 0, br = 0, n = 0;
  for (const r of rows) {
    if (r.t >= a && r.t < b && r.hr > 0) { hr += r.hr; hrv += r.hrv; br += r.br; n += 1; }
  }
  return n ? { hr: hr / n, hrv: hrv / n, br: br / n, n } : { hr: 0, hrv: 0, br: 0, n: 0 };
}
function isAbsent(gaps: { start: number; end: number }[], a: number, b: number, minSec: number): boolean {
  for (const g of gaps) {
    const s = Math.max(g.start, a), e = Math.min(g.end, b);
    if (e - s >= minSec * 1000) return true;
  }
  return false;
}

function baselineFromWindow(
  feats: { startMs: number; hr: number; br: number; hasVitals: boolean }[],
  nightStart: number,
  nightEnd: number,
  key: 'hr' | 'br',
): number {
  const winStart = nightStart + ONSET_SKIP_MS;
  const winEnd = nightEnd - TAIL_MS;
  const mid: number[] = [];
  for (const f of feats) {
    if (!f.hasVitals) continue;
    const v = key === 'hr' ? f.hr : f.br;
    if (v <= 0) continue;
    if (f.startMs >= winStart && f.startMs < winEnd) mid.push(v);
  }
  if (mid.length >= MIN_BASELINE_N) return lowerHalfMedian(mid);
  const all: number[] = [];
  for (const f of feats) {
    if (!f.hasVitals) continue;
    const v = key === 'hr' ? f.hr : f.br;
    if (v > 0) all.push(v);
  }
  return lowerHalfMedian(all);
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
    .map((r) => ({ t: toMs(r.timestamp as unknown as string | number), v: Number(r.total_movement) || 0 }))
    .filter((r) => r.t >= nightStart && r.t <= nightEnd)
    .sort((a, b) => a.t - b.t);
  const vitals = (args.vitals || [])
    .map((r) => ({
      t: toMs(r.timestamp as unknown as string | number),
      hr: Number(r.heart_rate) || 0,
      hrv: Number(r.hrv) || 0,
      br: Number(r.breathing_rate) || 0,
    }))
    .filter((r) => r.t >= nightStart && r.t <= nightEnd && r.hr > 0)
    .sort((a, b) => a.t - b.t);
  const gaps = (args.notPresentIntervals || [])
    .map((p) => ({ start: toMs(p[0]), end: toMs(p[1]) }))
    .filter((g) => g.end > g.start);

  type F = {
    startMs: number; endMs: number; movementMax: number;
    hr: number; hrv: number; br: number; hasVitals: boolean; isAbsent: boolean;
  };
  const feats: F[] = [];
  for (let t = nightStart; t < nightEnd; t += EPOCH_MS) {
    const e = Math.min(t + EPOCH_MS, nightEnd);
    const v = meanVit(vitals, t, e);
    feats.push({
      startMs: t, endMs: e, movementMax: maxMov(movement, t, e),
      hr: v.hr, hrv: v.hrv, br: v.br, hasVitals: v.n > 0,
      isAbsent: isAbsent(gaps, t, e, BRIEF_GAP_SECONDS),
    });
  }

  const baseHr = baselineFromWindow(feats, nightStart, nightEnd, 'hr');
  const baseBr = baselineFromWindow(feats, nightStart, nightEnd, 'br');
  const medHrv = median(vitals.map((v) => v.hrv).filter((v) => v > 0));

  const asleepLike = (f: F): boolean => {
    if (f.isAbsent) return false;
    if (f.movementMax >= RESTLESS) return false;
    if (f.movementMax >= ONSET_STILL) return false;
    if (!f.hasVitals || baseHr <= 0) return true;
    return f.hr > 0 && f.hr <= baseHr * HR_NEAR;
  };

  let raw: StageEpoch[] = feats.map((f) => {
    const reasons: string[] = [];
    if (f.isAbsent) return { startMs: f.startMs, endMs: f.endMs, stage: 'awake' as SleepStage, reasons: ['presence_gap'] };
    const restless = f.movementMax >= RESTLESS;
    const stirring = f.movementMax >= QUIET && !restless;
    const quiet = f.movementMax < QUIET;
    reasons.push(restless ? 'restless_movement' : stirring ? 'stirring' : 'quiet_movement');
    if (!f.hasVitals || baseHr <= 0) {
      return { startMs: f.startMs, endMs: f.endMs, stage: (restless ? 'awake' : 'light') as SleepStage, reasons: [...reasons, 'no_vitals'] };
    }
    if (restless) return { startMs: f.startMs, endMs: f.endMs, stage: 'awake', reasons: [...reasons, 'arousal'] };
    if (quiet && f.hr >= baseHr * HR_EQ) return { startMs: f.startMs, endMs: f.endMs, stage: 'awake', reasons: [...reasons, 'elevated_hr_quiet'] };
    if (stirring && f.hr >= baseHr * HR_ES) return { startMs: f.startMs, endMs: f.endMs, stage: 'awake', reasons: [...reasons, 'elevated_hr_stirring'] };
    const hrLow = f.hr > 0 && f.hr <= baseHr;
    const hrvHigh = medHrv > 0 && f.hrv >= medHrv * 1.08;
    const hrvLow = f.hrv > 0 && medHrv > 0 && f.hrv <= medHrv * 0.95;
    const brLow = f.br > 0 && baseBr > 0 && f.br <= baseBr * 1.02;
    if (quiet && hrLow && brLow && !hrvHigh) return { startMs: f.startMs, endMs: f.endMs, stage: 'deep', reasons: [...reasons, 'deep_signals'] };
    if ((quiet || stirring) && f.hr >= baseHr * 1.05 && hrvHigh) return { startMs: f.startMs, endMs: f.endMs, stage: 'rem', reasons: [...reasons, 'rem_signals'] };
    if (quiet && (hrLow || hrvLow)) return { startMs: f.startMs, endMs: f.endMs, stage: 'light', reasons: [...reasons, 'light_quiet'] };
    return { startMs: f.startMs, endMs: f.endMs, stage: 'light', reasons: [...reasons, 'default_light'] };
  });

  let consec = 0, onsetEnd = raw.length;
  for (let i = 0; i < feats.length; i++) {
    if (asleepLike(feats[i])) {
      consec++;
      if (consec >= ONSET_N) { onsetEnd = i - ONSET_N + 1; break; }
    } else consec = 0;
  }
  raw = raw.map((ep, i) => {
    if (i >= onsetEnd) return ep;
    if (ep.stage === 'awake' && ep.reasons.includes('presence_gap')) return ep;
    return { ...ep, stage: 'awake' as SleepStage, reasons: [...ep.reasons.filter((r) => r !== 'sleep_onset'), 'sleep_onset'] };
  });

  const elev = new Set(['elevated_hr_quiet', 'elevated_hr_stirring']);
  let i = 0;
  while (i < raw.length) {
    if (raw[i].stage !== 'awake' || !raw[i].reasons.some((r) => elev.has(r))) { i++; continue; }
    let j = i;
    while (j < raw.length && raw[j].stage === 'awake' && raw[j].reasons.some((r) => elev.has(r))) j++;
    if (j - i < MIN_ELEV) {
      const prev = i > 0 && raw[i - 1].stage !== 'awake';
      const next = j < raw.length && raw[j].stage !== 'awake';
      if (prev && next) {
        for (let k = i; k < j; k++) raw[k] = { ...raw[k], stage: 'light', reasons: [...raw[k].reasons, 'smoothed_isolated_awake'] };
      }
    }
    i = j;
  }

  i = 0;
  while (i < raw.length) {
    const st = raw[i].stage;
    if (st !== 'deep' && st !== 'rem') { i++; continue; }
    let j = i;
    while (j < raw.length && raw[j].stage === st) j++;
    if (j - i < MIN_BLOCK) {
      for (let k = i; k < j; k++) raw[k] = { ...raw[k], stage: 'light', reasons: [...raw[k].reasons, 'smoothed_short'] };
    }
    i = j;
  }

  const minutes: Record<SleepStage, number> = { awake: 0, light: 0, deep: 0, rem: 0 };
  for (const ep of raw) minutes[ep.stage] += (ep.endMs - ep.startMs) / 60_000;
  const total = Object.values(minutes).reduce((a, b) => a + b, 0) || 1;
  const percent: Record<SleepStage, number> = {
    awake: Math.round((minutes.awake / total) * 100),
    light: Math.round((minutes.light / total) * 100),
    deep: Math.round((minutes.deep / total) * 100),
    rem: Math.round((minutes.rem / total) * 100),
  };
  return {
    version: 'stage_v1',
    epochs: raw,
    minutes,
    percent,
    baselineHr: baseHr,
    baselineBr: baseBr,
    onsetEndIndex: onsetEnd,
  };
}
