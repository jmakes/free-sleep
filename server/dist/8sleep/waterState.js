// Water reservoir state, derived from the firmware's binary `waterLevel` flag.
//
// The Pod firmware reports only "true" (water OK) / "false" (low or empty);
// there is no level reading, so levelPercent is always null. Samples arrive
// with every DEVICE_STATUS read (the franken monitor polls about once a
// second), so serving this state never needs an extra hardware request.
// State is in memory only; lowSince resets if the service restarts while low.
export const DEFAULT_ALERT_AFTER_SECONDS = 120;
export const STALE_AFTER_SECONDS = 300;
export function parseWaterFlag(raw) {
    if (raw === 'true' || raw === true)
        return 'ok';
    if (raw === 'false' || raw === false)
        return 'low';
    return 'unknown';
}
export function createWaterTracker() {
    let state = {
        state: 'unknown',
        isLow: false,
        isPriming: false,
        source: 'firmware_flag',
        levelPercent: null,
        rawValue: null,
        lowSince: null,
        lastChangedAt: null,
        lastCheckedAt: null,
    };
    /** Returns the previous state name when this sample changed it, else null. */
    function record(raw, isPriming, now = new Date()) {
        const next = parseWaterFlag(raw);
        const nowIso = now.toISOString();
        const prev = state.state;
        const changed = next !== prev;
        let lowSince = state.lowSince;
        if (next === 'low' && !lowSince)
            lowSince = nowIso;
        if (next === 'ok')
            lowSince = null;
        // 'unknown' (unexpected firmware value) keeps lowSince so one odd sample doesn't reset it
        state = {
            ...state,
            state: next,
            isLow: next === 'low',
            isPriming,
            rawValue: raw === undefined || raw === null ? null : String(raw),
            lowSince,
            lastChangedAt: changed ? nowIso : state.lastChangedAt,
            lastCheckedAt: nowIso,
        };
        return changed ? prev : null;
    }
    function get() {
        return { ...state };
    }
    function alertView(alertAfterSeconds = DEFAULT_ALERT_AFTER_SECONDS, now = new Date()) {
        const s = get();
        const lowForSeconds = s.isLow && s.lowSince
            ? Math.max(0, Math.floor((now.getTime() - Date.parse(s.lowSince)) / 1000))
            : 0;
        const stale = !s.lastCheckedAt
            || (now.getTime() - Date.parse(s.lastCheckedAt)) / 1000 > STALE_AFTER_SECONDS;
        return {
            ...s,
            lowForSeconds,
            alertAfterSeconds,
            alert: s.isLow && lowForSeconds >= alertAfterSeconds,
            stale,
        };
    }
    return { record, get, alertView };
}
export const waterTracker = createWaterTracker();
//# sourceMappingURL=waterState.js.map