import moment from 'moment-timezone';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import memoryDB from '../db/memoryDB.js';
import { connectFranken } from './frankenServer.js';
import { wait } from './promises.js';
import { Version } from '../routes/deviceStatus/deviceStatusSchema.js';
import serverStatus from '../serverStatus.js';
import { playHapticAck, pulseCountForGesture } from './hapticAck.js';
import { recordGestureResult, runGestureAction } from './gestureActions.js';
import { markSidePoweredOn } from '../jobs/analyzeSleep.js';
export class FrankenMonitor {
    isRunning;
    deviceStatus;
    /** Prevent overlapping gesture handling storms */
    handlingGesture;
    constructor() {
        this.isRunning = false;
        this.deviceStatus = undefined;
        this.handlingGesture = false;
    }
    async start() {
        if (this.isRunning) {
            logger.warn('FrankenMonitor is already running');
            return;
        }
        this.isRunning = true;
        this.frankenLoop().catch(error => {
            logger.error(error);
            serverStatus.status.frankenMonitor.status = 'failed';
            serverStatus.status.frankenMonitor.message = String(error);
            serverStatus.status.frankenMonitor.timestamp = moment.tz().format();
        });
    }
    stop() {
        if (!this.isRunning)
            return;
        logger.debug('Stopping FrankenMonitor loop');
        this.isRunning = false;
    }
    async processGesture(side, gesture, nextDeviceStatus) {
        await settingsDB.read();
        const behavior = settingsDB.data[side]?.taps?.[gesture];
        if (!behavior) {
            logger.warn(`No tap mapping for ${side}.${gesture}`);
            return;
        }
        // Haptic MUST finish (including ALARM_CLEAR) before other franken commands.
        // Running in parallel with temp updates delayed CLEAR and left a long low rumble
        // after the double-click pattern (du was also too long).
        await playHapticAck(side, pulseCountForGesture(gesture));
        const actionResult = await runGestureAction(side, gesture, behavior, nextDeviceStatus);
        recordGestureResult(side, gesture, actionResult);
        // Single info line per gesture (haptic is debug elsewhere)
        logger.info(`Gesture ${side}.${gesture} (${behavior.type}): ${actionResult.message}`);
    }
    /**
     * Only treat a real counter *increase* as a tap.
     * Do not fire on undefined→N (first sample / flaky DEVICE_STATUS fields) or N→undefined.
     * Firing on those caused accidental power-offs when tripleTap maps to power off.
     */
    isCounterIncrease(previous, next) {
        if (typeof previous !== 'number' || typeof next !== 'number')
            return false;
        if (!Number.isFinite(previous) || !Number.isFinite(next))
            return false;
        return next > previous;
    }
    async processGesturesForSide(nextDeviceStatus, side) {
        try {
            // Higher-count first so a triple/quad doesn't also fire double if firmware
            // stamps multiple multi-tap fields. Single-tap is not mapped (Pod 4 dac).
            const order = ['quadTap', 'tripleTap', 'doubleTap'];
            for (const gesture of order) {
                const previous = this.deviceStatus?.[side]?.taps?.[gesture];
                const next = nextDeviceStatus[side]?.taps?.[gesture];
                if (this.isCounterIncrease(previous, next)) {
                    logger.debug(`Tap counter: ${side}.${gesture} ${previous} → ${next}`);
                    await this.processGesture(side, gesture, nextDeviceStatus);
                    // One gesture per side per poll — multi-tap timestamps can be close
                    break;
                }
            }
        }
        catch (error) {
            logger.error(error);
        }
    }
    async processGestures(nextDeviceStatus) {
        if (!this.deviceStatus) {
            logger.warn('Missing current deviceStatus, exiting...');
            return;
        }
        // Need a prior sample that already included tap counters, otherwise any first
        // non-zero reading would look like a "change" and fire every mapping at once.
        const hadTapBaseline = this.deviceStatus.left.taps !== undefined || this.deviceStatus.right.taps !== undefined;
        if (!hadTapBaseline) {
            return;
        }
        if (this.handlingGesture) {
            logger.debug('Already handling a gesture; skipping this poll');
            return;
        }
        this.handlingGesture = true;
        try {
            await this.processGesturesForSide(nextDeviceStatus, 'left');
            await this.processGesturesForSide(nextDeviceStatus, 'right');
        }
        finally {
            this.handlingGesture = false;
        }
    }
    async frankenLoop() {
        const franken = await connectFranken();
        this.deviceStatus = await franken.getDeviceStatus(false);
        let hasGestures = this.deviceStatus.coverVersion !== Version.Pod3;
        // 1s sampling balances responsiveness vs franken load (toasts poll separately at 500ms)
        let waitTime = hasGestures ? 1_000 : 60_000;
        if (hasGestures) {
            this.deviceStatus = await franken.getDeviceStatus(true);
            logger.info(`Gestures supported for ${this.deviceStatus.coverVersion}`);
        }
        else {
            logger.info(`Gestures not supported for ${this.deviceStatus.coverVersion}`);
        }
        // If a side is already on at startup, seed session start so min-duration
        // analyze checks work after a service restart mid-sleep.
        await memoryDB.read();
        for (const side of ['left', 'right']) {
            if (this.deviceStatus[side]?.isOn && !memoryDB.data[side].powerOnAt) {
                await markSidePoweredOn(side);
                logger.info(`Seeded powerOnAt for ${side} (already on at franken start)`);
            }
        }
        // No point in querying device status every 3 seconds for checking the prime status...
        while (this.isRunning) {
            try {
                while (this.isRunning) {
                    hasGestures = this.deviceStatus.coverVersion !== Version.Pod3;
                    waitTime = hasGestures ? 1_000 : 60_000;
                    await wait(waitTime);
                    if (!this.isRunning)
                        break;
                    const franken = await connectFranken();
                    const nextDeviceStatus = await franken.getDeviceStatus(hasGestures);
                    await settingsDB.read();
                    if (hasGestures) {
                        await this.processGestures(nextDeviceStatus);
                    }
                    this.deviceStatus = nextDeviceStatus;
                    serverStatus.status.frankenMonitor.status = 'healthy';
                    serverStatus.status.frankenMonitor.message = '';
                    serverStatus.status.frankenMonitor.timestamp = moment.tz().format();
                }
            }
            catch (error) {
                serverStatus.status.frankenMonitor.status = 'failed';
                serverStatus.status.frankenMonitor.message = String(error);
                serverStatus.status.frankenMonitor.timestamp = moment.tz().format();
                logger.error(error instanceof Error ? error.message : String(error), 'franken disconnected');
                await wait(waitTime);
            }
        }
        logger.debug('FrankenMonitor loop exited');
    }
}
//# sourceMappingURL=frankenMonitor.js.map