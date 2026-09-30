import { Side } from './schedulesSchema.js';

export interface VitalRecord {
  id: number;
  side: Side;
  timestamp: string;
  heart_rate: number;
  hrv: number;
  breathing_rate: number;
}


export interface SleepRecord {
  id: number;
  side: Side;
  entered_bed_at: string;
  left_bed_at: string;
  sleep_period_seconds: number;
  times_exited_bed: number;
  present_intervals: [string, string][];
  not_present_intervals: [string, string][];
  /** Heuristic piezo snore minute total (nullable until scored). */
  snore_minutes?: number | null;
  /** sleep_score_v1 0-100 (nullable until scored). */
  sleep_score_v1?: number | null;
  /** Optional component breakdown (enriched on read / from sleep_score_v1_json). */
  sleep_score_v1_components?: Array<{
    key: 'duration' | 'continuity' | 'restfulness' | 'vitals';
    label: string;
    points: number;
    maxPoints: number;
    detail: string;
  }>;
}

export interface MovementRecord {
  timestamp: string;
  side: Side;
  total_movement: number;
}

export interface SnoreRecord {
  id?: number;
  timestamp: string;
  side: Side;
  /** Heuristic binary 0/1 — not clinical. */
  snore: number;
  /** Heuristic likelihood — not OEM ML. */
  likelihood: number;
  heuristic: true;
}
