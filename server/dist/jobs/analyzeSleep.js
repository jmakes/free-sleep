import moment from 'moment-timezone';
import { executePythonScript } from './executePython.js';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import servicesDB from '../db/services.js';
import memoryDB from '../db/memoryDB.js';
const DEBOUNCE_MS = 10 * 60 * 1000;
function jobKeyForSide(side) {
    return side === 'left' ? 'analyzeSleepLeft' : 'analyzeSleepRight';
}
/** Mark biometrics job started so the GUI can show progress immediately */
async function markAnalyzeJobStarted(side, message) {
    await servicesDB.read();
    const jobKey = jobKeyForSide(side);
    servicesDB.data.biometrics.jobs[jobKey] = {
        ...servicesDB.data.biometrics.jobs[jobKey],
        status: 'started',
        message,
        timestamp: new Date().toISOString(),
    };
    await servicesDB.write();
}
export const executeAnalyzeSleep = async (side, startTime, endTime) => {
    await markAnalyzeJobStarted(side, `Analyzing ${side} sleep (${moment(startTime).format('MMM D h:mm A')} – ${moment(endTime).format('h:mm A')})…`);
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
export async function markSidePoweredOn(side) {
    await memoryDB.read();
    memoryDB.data[side].powerOnAt = new Date().toISOString();
    await memoryDB.write();
}
/**
 * Auto-run sleep analysis after a side powers off (schedule, GUI, gesture, etc.).
 * Gated by: biometrics service, per-side analyzeSleep.enabled, min on-duration, debounce.
 */
export async function maybeAnalyzeSleepOnPowerOff(side) {
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
                    logger.info(`Analyze sleep ${side}: skipped (on for ${Math.round(onDurationMs / 60_000)}m < ${minDurationMinutes}m min)`);
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
        await executeAnalyzeSleep(side, startTime, endTime);
    }
    catch (error) {
        logger.error(`Analyze sleep ${side} failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=analyzeSleep.js.map