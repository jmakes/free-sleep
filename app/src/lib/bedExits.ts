/**
 * Bed-exit counting from not_present_intervals.
 *
 * Meaningful exits (≥ MIN_MEANINGFUL_EXIT_SECONDS) are bathroom trips / leaving bed.
 * Brief gaps (BRIEF_GAP_SECONDS … meaningful) are tosses / sensor flicker — shown
 * separately so the main "exits" number stops looking like "22" for a quiet night.
 */

export const BRIEF_GAP_SECONDS = 45;
/** Default: 5 minutes — matches biometrics MIN_EXIT_GAP_SECONDS */
export const MIN_MEANINGFUL_EXIT_SECONDS = 5 * 60;

export type IntervalPair = [string | number | Date, string | number | Date];

export type GapKind = 'flicker' | 'brief' | 'meaningful';

export type ClassifiedGap = {
  startMs: number;
  endMs: number;
  seconds: number;
  kind: GapKind;
};

export type BedExitCounts = {
  /** Gaps ≥ minMeaningfulSeconds (default 5 min) */
  meaningfulExits: number;
  /** Gaps in [BRIEF_GAP_SECONDS, minMeaningfulSeconds) */
  briefGaps: number;
  /** Gaps shorter than BRIEF_GAP_SECONDS (usually ignored) */
  flickerGaps: number;
};

function toMs(value: string | number | Date): number {
  if (typeof value === 'number') {
    // Heuristic: unix seconds vs ms
    return value < 1e12 ? value * 1000 : value;
  }
  return new Date(value).getTime();
}

export function gapSeconds(start: string | number | Date, end: string | number | Date): number {
  const ms = toMs(end) - toMs(start);
  return Math.max(0, Math.floor(ms / 1000));
}

export function classifyGapSeconds(
  seconds: number,
  options?: { minMeaningfulSeconds?: number; briefGapSeconds?: number },
): GapKind {
  const minMeaningful = options?.minMeaningfulSeconds ?? MIN_MEANINGFUL_EXIT_SECONDS;
  const briefFloor = options?.briefGapSeconds ?? BRIEF_GAP_SECONDS;
  if (seconds >= minMeaningful) return 'meaningful';
  if (seconds >= briefFloor) return 'brief';
  return 'flicker';
}

/**
 * Classify each not_present interval that overlaps the night window.
 * Shared by exit counts and PresenceTimelineChart so thresholds stay single-sourced.
 */
export function classifyNotPresentIntervals(
  notPresentIntervals: IntervalPair[] | undefined | null,
  options?: {
    minMeaningfulSeconds?: number;
    briefGapSeconds?: number;
    enteredBedAt?: string | number | Date;
    leftBedAt?: string | number | Date;
  },
): ClassifiedGap[] {
  const minMeaningful = options?.minMeaningfulSeconds ?? MIN_MEANINGFUL_EXIT_SECONDS;
  const briefFloor = options?.briefGapSeconds ?? BRIEF_GAP_SECONDS;
  const nightStart = options?.enteredBedAt !== undefined ? toMs(options.enteredBedAt) : null;
  const nightEnd = options?.leftBedAt !== undefined ? toMs(options.leftBedAt) : null;
  const out: ClassifiedGap[] = [];

  for (const pair of notPresentIntervals || []) {
    if (!pair || pair.length < 2) continue;
    const startMs = toMs(pair[0]);
    const endMs = toMs(pair[1]);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) continue;

    if (nightStart !== null && nightEnd !== null) {
      // Require the gap to fall inside the night window
      if (endMs <= nightStart || startMs >= nightEnd) continue;
    }

    const seconds = Math.floor((endMs - startMs) / 1000);
    out.push({
      startMs,
      endMs,
      seconds,
      kind: classifyGapSeconds(seconds, {
        minMeaningfulSeconds: minMeaningful,
        briefGapSeconds: briefFloor,
      }),
    });
  }

  return out;
}

/**
 * Count exits from not_present_intervals inside a sleep night.
 * Intervals that do not overlap [enteredBedAt, leftBedAt] are ignored when bounds given.
 */
export function countBedExits(
  notPresentIntervals: IntervalPair[] | undefined | null,
  options?: {
    minMeaningfulSeconds?: number;
    briefGapSeconds?: number;
    enteredBedAt?: string | number | Date;
    leftBedAt?: string | number | Date;
  },
): BedExitCounts {
  const gaps = classifyNotPresentIntervals(notPresentIntervals, options);
  let meaningfulExits = 0;
  let briefGaps = 0;
  let flickerGaps = 0;
  for (const gap of gaps) {
    if (gap.kind === 'meaningful') meaningfulExits += 1;
    else if (gap.kind === 'brief') briefGaps += 1;
    else flickerGaps += 1;
  }
  return { meaningfulExits, briefGaps, flickerGaps };
}

/** Prefer recomputed meaningful count over stale DB times_exited_bed (old 45s rule). */
export function displayExitCount(
  record: {
    times_exited_bed?: number;
    not_present_intervals?: IntervalPair[];
    entered_bed_at?: string;
    left_bed_at?: string;
  },
): BedExitCounts {
  return countBedExits(record.not_present_intervals, {
    enteredBedAt: record.entered_bed_at,
    leftBedAt: record.left_bed_at,
  });
}
