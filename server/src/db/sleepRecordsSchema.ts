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
});

// TypeScript type inference from Zod
export type SleepRecord = z.infer<typeof sleepRecordSchema>;
