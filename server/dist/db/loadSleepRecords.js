import settingsDB from './settings.js';
import moment from 'moment-timezone';
export const loadSleepRecords = async (sleepRecords) => {
    await settingsDB.read();
    const userTimeZone = settingsDB.data.timeZone || 'UTC';
    // Parse JSON fields
    return sleepRecords.map((record) => {
        let components;
        if (record.sleep_score_v1_json) {
            try {
                const parsed = JSON.parse(record.sleep_score_v1_json);
                if (parsed && Array.isArray(parsed.components)) {
                    components = parsed.components;
                }
            }
            catch {
                // ignore bad JSON
            }
        }
        const { sleep_score_v1_json: _json, ...rest } = record;
        return {
            ...rest,
            entered_bed_at: moment.tz(record.entered_bed_at * 1000, userTimeZone).format(),
            left_bed_at: moment.tz(record.left_bed_at * 1000, userTimeZone).format(),
            present_intervals: record.present_intervals
                ? JSON.parse(record.present_intervals).map(([start, end]) => [
                    moment.tz(start * 1000, userTimeZone).format(),
                    moment.tz(end * 1000, userTimeZone).format(),
                ])
                : [],
            not_present_intervals: record.not_present_intervals
                ? JSON.parse(record.not_present_intervals).map(([start, end]) => [
                    moment.tz(start * 1000, userTimeZone).format(),
                    moment.tz(end * 1000, userTimeZone).format(),
                ])
                : [],
            sleep_score_v1: record.sleep_score_v1 ?? null,
            ...(components ? { sleep_score_v1_components: components } : {}),
        };
    });
};
//# sourceMappingURL=loadSleepRecords.js.map