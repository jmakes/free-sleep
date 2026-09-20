/** stage_v1 awake jmakes.11: p30 quiet baseline, exclude last 75m, quiet-only onset */
import type { MovementRecord } from '../../../server/src/db/movementRecordSchema.ts';
import type { VitalRecord } from '../../../server/src/db/prismaDbTypes.ts';
import { BRIEF_GAP_SECONDS, type IntervalPair } from './bedExits.ts';
export type SleepStage = 'awake' | 'light' | 'deep' | 'rem';
export type StageEpoch = {
startMs: number;
endMs: number;
stage: SleepStage;
reasons: string[];
};
export type StageSummary = {
version: 'stage_v1';
epochs: StageEpoch[];
minutes: Record<SleepStage, number>;
percent: Record<SleepStage, number>;
};
const EPOCH_MS = 5 * 60 * 1000;
const MIN_BLOCK_EPOCHS = 2;
const MOVEMENT_QUIET = 200;
const MOVEMENT_RESTLESS = 900;
const SLEEP_ONSET_CONSECUTIVE = 3;
const MIN_QUIET_BASELINE_EPOCHS = 6;
const BASELINE_EXCLUDE_TAIL_MS = 75 * 60 * 1000;
const HR_NEAR_SLEEP = 1.03;
const HR_ELEVATED_QUIET = 1.1;
const HR_ELEVATED_STIRRING = 1.05;
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
.map((e) => e.hr);
if (quietHrs.length >= MIN_QUIET_BASELINE_EPOCHS) return percentile(quietHrs, 0.3);
const allHrs = epochHrs.filter((e) => e.hasVitals && e.hr > 0).map((e) => e.hr);
return percentile(allHrs, 0.3);
}
function sleepBaselineBr(
epochBrs: { movementMax: number; br: number; hasVitals: boolean; startMs?: number }[],
): number {
const nightEnd = epochBrs.reduce((m, e) => Math.max(m, e.startMs ?? 0), 0);
const cutoff = nightEnd > 0 ? nightEnd - BASELINE_EXCLUDE_TAIL_MS : 0;
const quietBrs = epochBrs
.filter(
(e) =>
e.hasVitals &&
e.br > 0 &&
e.movementMax < MOVEMENT_QUIET &&
(cutoff <= 0 || e.startMs === undefined || e.startMs < cutoff),
)
.map((e) => e.br);
if (quietBrs.length >= MIN_QUIET_BASELINE_EPOCHS) return percentile(quietBrs, 0.3);
const allBrs = epochBrs.filter((e) => e.hasVitals && e.br > 0).map((e) => e.br);
