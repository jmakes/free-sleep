import { z } from 'zod';
import { SideSchema } from './schedulesSchema.js';

/**
 * Per-minute piezo snore heuristic row.
 * likelihood / snore are night-adaptive spectral scores — not OEM ML / clinical.
 */
export const snoreRecordSchema = z.object({
  id: z.number().optional(),
  side: SideSchema,
  timestamp: z.union([z.number().int(), z.string()]),
  /** Heuristic binary label (0/1). */
  snore: z.number().int(),
  /** Heuristic likelihood score. */
  likelihood: z.number(),
  /** Always true for this endpoint — callers should treat values as heuristic. */
  heuristic: z.literal(true).optional(),
});

export type SnoreRecord = z.infer<typeof snoreRecordSchema>;
