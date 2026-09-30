import { z } from 'zod';

export const sleepRecordSchema = z.object({
  id: z.number().int(),
  side: z.string(),
  entered_bed_at: z.string().datetime(),
  left_bed_at: z.string().datetime(),
  sleep_period_seconds: z.number().int(),
  times_exited_bed: z.number().int(),
  present_intervals: z.array(z.tuple([z.string().datetime(), z.string().datetime()])),
  not_present_intervals: z.array(z.tuple([z.string().datetime(), z.string().datetime()])),
  /** Heuristic piezo snore minute total (nullable until scored). Not OEM/clinical. */
  snore_minutes: z.number().int().nullable().optional(),
  /** sleep_score_v1 0-100 (nullable until scored). Same formula as Sleep UI. */
  sleep_score_v1: z.number().int().min(0).max(100).nullable().optional(),
  /** Optional component breakdown for sleep_score_v1. */
  sleep_score_v1_components: z.array(z.object({
    key: z.enum(['duration', 'continuity', 'restfulness', 'vitals']),
    label: z.string(),
    points: z.number(),
    maxPoints: z.number(),
    detail: z.string(),
  })).optional(),
});

// TypeScript type inference from Zod
export type SleepRecord = z.infer<typeof sleepRecordSchema>;
