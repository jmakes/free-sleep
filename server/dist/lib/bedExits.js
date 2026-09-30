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
function toMs(value) {
    if (typeof value === 'number') {
        // Heuristic: unix seconds vs ms
        return value < 1e12 ? value * 1000 : value;
    }
    return new Date(value).getTime();
}
export function gapSeconds(start, end) {
    const ms = toMs(end) - toMs(start);
    return Math.max(0, Math.floor(ms / 1000));
}
export function classifyGapSeconds(seconds, options) {
    const minMeaningful = options?.minMeaningfulSeconds ?? MIN_MEANINGFUL_EXIT_SECONDS;
    const briefFloor = options?.briefGapSeconds ?? BRIEF_GAP_SECONDS;
    if (seconds >= minMeaningful)
        return 'meaningful';
    if (seconds >= briefFloor)
        return 'brief';
    return 'flicker';
}
/**
 * Classify each not_present interval that overlaps the night window.
 * Shared by exit counts and PresenceTimelineChart so thresholds stay single-sourced.
 */
export function classifyNotPresentIntervals(notPresentIntervals, options) {
    const minMeaningful = options?.minMeaningfulSeconds ?? MIN_MEANINGFUL_EXIT_SECONDS;
    const briefFloor = options?.briefGapSeconds ?? BRIEF_GAP_SECONDS;
    const nightStart = options?.enteredBedAt !== undefined ? toMs(options.enteredBedAt) : null;
    const nightEnd = options?.leftBedAt !== undefined ? toMs(options.leftBedAt) : null;
    const out = [];
    for (const pair of notPresentIntervals || []) {
        if (!pair || pair.length < 2)
            continue;
        const startMs = toMs(pair[0]);
        const endMs = toMs(pair[1]);
        if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs)
            continue;
        if (nightStart !== null && nightEnd !== null) {
            // Require the gap to fall inside the night window
            if (endMs <= nightStart || startMs >= nightEnd)
                continue;
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
export function countBedExits(notPresentIntervals, options) {
    const gaps = classifyNotPresentIntervals(notPresentIntervals, options);
    let meaningfulExits = 0;
    let briefGaps = 0;
    let flickerGaps = 0;
    for (const gap of gaps) {
        if (gap.kind === 'meaningful')
            meaningfulExits += 1;
        else if (gap.kind === 'brief')
            briefGaps += 1;
        else
            flickerGaps += 1;
    }
    return { meaningfulExits, briefGaps, flickerGaps };
}
/** Prefer recomputed meaningful count over stale DB times_exited_bed (old 45s rule). */
export function displayExitCount(record) {
    return countBedExits(record.not_present_intervals, {
        enteredBedAt: record.entered_bed_at,
        leftBedAt: record.left_bed_at,
    });
}
//# sourceMappingURL=bedExits.js.map