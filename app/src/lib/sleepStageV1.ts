/**
 * stage_v1 awake (jmakes.11): p30 quiet baseline, exclude last 75m; quiet-only onset.
 * Compact mirror of biometrics/sleep_detection/stage_v1.py (awake rules).
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
};

const EPOCH_MS = 5 * 60 * 1000;
const MIN_BLOCK = 2;
const QUIET = 200;
const RESTLESS = 900;
const ONSET_N = 3;
const MIN_QUIET_N = 6;
const TAIL_MS = 75 * 60 * 1000;
const HR_NEAR = 1.03;
const HR_EQ = 1.1;
const HR_ES = 1.05;
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
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1))))];
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

  const nightEndFeat = feats.reduce((m, f) => Math.max(m, f.startMs), 0);
  const cut = nightEndFeat > 0 ? nightEndFeat - TAIL_MS : 0;
  const quietHrs = feats.filter((f) => f.hasVitals && f.hr > 0 && f.movementMax < QUIET && f.startMs < cut).map((f) => f.hr);
  const quietBrs = feats.filter((f) => f.hasVitals && f.br > 0 && f.movementMax < QUIET && f.startMs < cut).map((f) => f.br);
  const baseHr = quietHrs.length >= MIN_QUIET_N ? pct(quietHrs, 0.3) : pct(feats.filter((f) => f.hasVitals && f.hr > 0).map((f) => f.hr), 0.3);
  const baseBr = quietBrs.length >= MIN_QUIET_N ? pct(quietBrs, 0.3) : pct(feats.filter((f) => f.hasVitals && f.br > 0).map((f) => f.br), 0.3);
  const medHrv = median(vitals.map((v) => v.hrv).filter((v) => v > 0));

  const asleepLike = (f: F): boolean => {
    if (f.isAbsent) return false;
    if (f.movementMax >= QUIET) return false;
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
  return { version: 'stage_v1', epochs: raw, minutes, percent };
}
