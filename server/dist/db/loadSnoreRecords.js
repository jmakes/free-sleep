import settingsDB from './settings.js';
import moment from 'moment-timezone';
export const loadSnoreRecords = async (snoreRecords) => {
    await settingsDB.read();
    const userTimeZone = settingsDB.data.timeZone || 'UTC';
    return snoreRecords.map((record) => ({
        ...record,
        timestamp: moment.tz(record.timestamp * 1000, userTimeZone).format(),
        // Explicit so API consumers know this is not OEM / clinical.
        heuristic: true,
    }));
};
//# sourceMappingURL=loadSnoreRecords.js.map