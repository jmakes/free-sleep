/**
 * Attach sleep_score_v1 (+ components) to sleep records.
 * Uses persisted values when present; otherwise computes from vitals/movement/presence
 * with the shared formula in server/src/lib/sleepScoreV1.ts (same as Sleep UI).
 */
import { prisma } from './prisma.js';
import type { SleepRecord } from './prismaDbTypes.js';
import { computeSleepScoreV1 } from '../lib/sleepScoreV1.js';
import { loadVitals } from './loadVitals.js';
import { loadMovementRecords } from './loadMovementRecords.js';
import logger from '../logger.js';

function toUnixSeconds(isoOrEpoch: string | number): number {
  if (typeof isoOrEpoch === 'number') {
    return isoOrEpoch < 1e12 ? isoOrEpoch : Math.floor(isoOrEpoch / 1000);
  }
  return Math.floor(new Date(isoOrEpoch).getTime() / 1000);
}

export async function enrichSleepScores(records: SleepRecord[]): Promise<SleepRecord[]> {
  if (!records.length) return records;

  const needsCompute = records.some(
    (r) => r.sleep_score_v1 == null || r.sleep_score_v1_components == null,
  );
  if (!needsCompute) return records;

  const sides = [...new Set(records.map((r) => r.side))];
  const minTs = Math.min(...records.map((r) => toUnixSeconds(r.entered_bed_at)));
  const maxTs = Math.max(...records.map((r) => toUnixSeconds(r.left_bed_at)));

  try {
    const [vitalRows, movementRows] = await Promise.all([
      prisma.vitals.findMany({
        where: {
          side: { in: sides },
          timestamp: { gte: minTs, lte: maxTs },
        },
        orderBy: { timestamp: 'asc' },
      }),
      prisma.movement.findMany({
        where: {
          side: { in: sides },
          timestamp: { gte: minTs, lte: maxTs },
        },
        orderBy: { timestamp: 'asc' },
      }),
    ]);

    const vitals = await loadVitals(vitalRows);
    const movement = await loadMovementRecords(movementRows);

    return records.map((record) => {
      if (record.sleep_score_v1 != null && record.sleep_score_v1_components) {
        return record;
      }
      const side = record.side;
      const entered = new Date(record.entered_bed_at).getTime();
      const left = new Date(record.left_bed_at).getTime();
      const nightVitals = vitals.filter((v) => {
        if (v.side !== side) return false;
        const t = new Date(v.timestamp).getTime();
        return t >= entered && t <= left;
      });
      const nightMovement = movement.filter((m) => {
        if (m.side !== side) return false;
        const t = new Date(m.timestamp as unknown as string).getTime();
        return t >= entered && t <= left;
      });

      const scored = computeSleepScoreV1({
        sleepPeriodSeconds: record.sleep_period_seconds,
        enteredBedAt: record.entered_bed_at,
        leftBedAt: record.left_bed_at,
        timesExitedBed: record.times_exited_bed,
        notPresentIntervals: record.not_present_intervals,
        vitals: nightVitals,
        movement: nightMovement as any,
      });

      return {
        ...record,
        sleep_score_v1: scored.score,
        sleep_score_v1_components: scored.components,
      };
    });
  } catch (error) {
    logger.error(`enrichSleepScores failed: ${error instanceof Error ? error.message : error}`);
    return records;
  }
}
