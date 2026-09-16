import schedule from 'node-schedule';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import servicesDB from '../db/services.js';
import { executeAutoPresenceCalibration } from './autoPresenceCalibration.js';
/**
 * Weekly auto presence calibration (Wed 15:00 local) when any side has it enabled.
 * Per-side gate lives in executeAutoPresenceCalibration; this only schedules the run.
 */
export const scheduleAutoPresenceCalibration = (settingsData) => {
    const { timeZone } = settingsData;
    if (!timeZone)
        return;
    const anyEnabled = Boolean(settingsData.left?.autoPresenceCalibration?.enabled
        || settingsData.right?.autoPresenceCalibration?.enabled);
    if (!anyEnabled) {
        logger.debug('Auto presence calibration off on both sides — not scheduling weekly job');
        return;
    }
    const rule = new schedule.RecurrenceRule();
    rule.dayOfWeek = 3; // Wednesday
    rule.hour = 15;
    rule.minute = 0;
    rule.tz = timeZone;
    logger.info(`Scheduling weekly auto presence calibration (Wed 15:00 ${timeZone})`);
    schedule.scheduleJob('weekly-auto-presence-calibration', rule, async () => {
        try {
            await settingsDB.read();
            await servicesDB.read();
            if (!servicesDB.data.biometrics.enabled) {
                logger.info('Weekly auto-cal skipped — biometrics disabled');
                return;
            }
            const leftOn = Boolean(settingsDB.data.left?.autoPresenceCalibration?.enabled);
            const rightOn = Boolean(settingsDB.data.right?.autoPresenceCalibration?.enabled);
            if (!leftOn && !rightOn) {
                logger.info('Weekly auto-cal skipped — both sides off');
                return;
            }
            logger.info(`Executing weekly auto presence calibration (left=${leftOn}, right=${rightOn})`);
            // Away mode is handled in Python as a strong empty prior (no occupied fit).
            if (leftOn) {
                await executeAutoPresenceCalibration('left', { apply: true, days: 14 });
            }
            if (rightOn) {
                const delay = leftOn ? 20 * 60 * 1000 : 0;
                setTimeout(() => {
                    void executeAutoPresenceCalibration('right', { apply: true, days: 14 });
                }, delay);
            }
        }
        catch (error) {
            logger.error(error);
        }
    });
};
//# sourceMappingURL=autoPresenceCalibrationScheduler.js.map