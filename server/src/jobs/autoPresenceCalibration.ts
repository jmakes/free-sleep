import { Side } from '../db/schedulesSchema.js';
import { executePythonScript } from './executePython.js';
import settingsDB from '../db/settings.js';
import servicesDB from '../db/services.js';
import logger from '../logger.js';

/**
 * Schedule-prior auto presence calibration (beta).
 * Gated by biometrics + settings.beta.autoPresenceCalibration.enabled.
 */
export const executeAutoPresenceCalibration = async (
  side: Side,
  options: { apply?: boolean; days?: number } = {},
): Promise<void> => {
  await settingsDB.read();
  await servicesDB.read();

  if (!servicesDB.data.biometrics.enabled) {
    logger.info(`Skipping auto presence cal (${side}): biometrics disabled`);
    return;
  }
  if (!settingsDB.data.beta?.autoPresenceCalibration?.enabled) {
    logger.info(`Skipping auto presence cal (${side}): beta toggle off`);
    return;
  }

  const apply = options.apply !== false;
  const days = options.days ?? 14;
  const args = [
    `--side=${side}`,
    `--days=${days}`,
  ];
  if (apply) {
    args.push('--apply');
  } else {
    args.push('--dry-run');
  }

  executePythonScript({
    script: '/home/dac/free-sleep/biometrics/sleep_detection/auto_calibrate_presence.py',
    args,
  });
};
