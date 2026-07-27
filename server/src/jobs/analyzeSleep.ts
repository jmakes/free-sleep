import moment from 'moment-timezone';
import { Side } from '../db/schedulesSchema.js';
import { executePythonScript } from './executePython.js';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import servicesDB from '../db/services.js';
import memoryDB from '../db/memoryDB.js';

const DEBOUNCE_MS = 10 * 60 * 1000;

export const executeAnalyzeSleep = (side: Side, startTime: string, endTime: string): void => {
  executePythonScript({
    script: '/home/dac/free-sleep/biometrics/sleep_detection/analyze_sleep.py',
    args: [
      `--side=${side}`,
      `--start_time=${startTime}`,
      `--end_time=${endTime}`
    ]
  });
};

/**
 * Record that a side was just powered on — used for min-duration checks on power-off.
 */
export async function markSidePoweredOn(side: Side): Promise<void> {
  await memoryDB.read();
  memoryDB.data[side].powerOnAt = new Date().toISOString();
  await memoryDB.write();
}

/**
 * Auto-run sleep analysis after a side powers off (schedule, GUI, gesture, etc.).
 * Gated by: biometrics service, per-side analyzeSleep.enabled, min on-duration, debounce.
 */
export async function maybeAnalyzeSleepOnPowerOff(side: Side): Promise<void> {
  try {
    await servicesDB.read();
    if (!servicesDB.data.biometrics.enabled) {
      logger.debug(`Analyze sleep ${side}: skipped (biometrics disabled)`);
      return;
    }

    await settingsDB.read();
    const sideSettings = settingsDB.data[side];
    if (sideSettings.awayMode) {
      logger.debug(`Analyze sleep ${side}: skipped (away mode)`);
      return;
    }

    const analyzeConfig = sideSettings.analyzeSleep;
    if (!analyzeConfig?.enabled) {
      logger.debug(`Analyze sleep ${side}: skipped (side setting off)`);
      return;
    }

    const minDurationMinutes = analyzeConfig.minDurationMinutes ?? 30;
    const minDurationMs = minDurationMinutes * 60 * 1000;
    const nowMs = Date.now();

    await memoryDB.read();
    const powerOnAt = memoryDB.data[side].powerOnAt;
    if (powerOnAt) {
      const onAtMs = Date.parse(powerOnAt);
      if (Number.isFinite(onAtMs)) {
        const onDurationMs = nowMs - onAtMs;
        if (onDurationMs < minDurationMs) {
          logger.info(
            `Analyze sleep ${side}: skipped (on for ${Math.round(onDurationMs / 60_000)}m < ${minDurationMinutes}m min)`
          );
          memoryDB.data[side].powerOnAt = undefined;
          await memoryDB.write();
          return;
        }
      }
    }

    const lastRan = memoryDB.data[side].analyzeSleep.lastRan;
    if (typeof lastRan === 'number' && nowMs - lastRan < DEBOUNCE_MS) {
      logger.debug(`Analyze sleep ${side}: skipped (ran ${Math.round((nowMs - lastRan) / 1000)}s ago)`);
      return;
    }

    memoryDB.data[side].analyzeSleep.lastRan = nowMs;
    memoryDB.data[side].powerOnAt = undefined;
    await memoryDB.write();

    // Prefer the recorded session window; fall back to a 12h lookback if unknown
    // (e.g. server restarted while the side was already on).
    const startTime = powerOnAt && Number.isFinite(Date.parse(powerOnAt))
      ? moment(powerOnAt).subtract(15, 'minutes').toISOString()
      : moment().subtract(12, 'hours').toISOString();
    const endTime = moment().add(1, 'hours').toISOString();

    logger.info(`Analyze sleep ${side}: starting window ${startTime} → ${endTime}`);
    executeAnalyzeSleep(side, startTime, endTime);
  } catch (error) {
    logger.error(
      `Analyze sleep ${side} failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
