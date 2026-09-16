import schedule from 'node-schedule';
import { Settings } from '../db/settingsSchema.js';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import servicesDB from '../db/services.js';
import { executeAutoPresenceCalibration } from './autoPresenceCalibration.js';

/**
 * Weekly auto presence calibration (Wed 15:00 local) when beta toggle is on.
 * Sliding-window blend lives in the Python script; this only triggers runs.
 */
export const scheduleAutoPresenceCalibration = (settingsData: Settings) => {
  const { timeZone } = settingsData;
  if (!timeZone) return;
  if (!settingsData.beta?.autoPresenceCalibration?.enabled) {
    logger.debug('Auto presence calibration beta off — not scheduling weekly job');
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
      if (!settingsDB.data.beta?.autoPresenceCalibration?.enabled) {
        logger.info('Weekly auto-cal skipped — beta toggle off');
        return;
      }
      if (!servicesDB.data.biometrics.enabled) {
        logger.info('Weekly auto-cal skipped — biometrics disabled');
        return;
      }
      logger.info('Executing weekly auto presence calibration (left then right)');
      await executeAutoPresenceCalibration('left', { apply: true, days: 14 });
      // Stagger right side 20 minutes via delayed call so RAW/memory can settle
      setTimeout(() => {
        void executeAutoPresenceCalibration('right', { apply: true, days: 14 });
      }, 20 * 60 * 1000);
    } catch (error) {
      logger.error(error);
    }
  });
};
