import moment from 'moment-timezone';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import { connectFranken } from './frankenServer.js';
import { wait } from './promises.js';
import { Version } from '../routes/deviceStatus/deviceStatusSchema.js';
import { GestureSchema } from '../db/settingsSchema.js';
import serverStatus from '../serverStatus.js';
import { playHapticAck, pulseCountForGesture } from './hapticAck.js';
import { recordGestureResult, runGestureAction } from './gestureActions.js';
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
        logger.info(`Gesture detected: ${side} ${gesture} → ${behavior.type}`);
        // Haptic ack on the same side, paced like a mouse double-click (~2/sec)
        const hapticPromise = playHapticAck(side, pulseCountForGesture(gesture));
        const actionPromise = runGestureAction(side, gesture, behavior, nextDeviceStatus);
        const [, actionResult] = await Promise.all([hapticPromise, actionPromise]);
        recordGestureResult(side, gesture, actionResult);
        logger.info(actionResult.message);
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
            for (const gesture of GestureSchema.options) {
                const previous = this.deviceStatus?.[side]?.taps?.[gesture];
                const next = nextDeviceStatus[side]?.taps?.[gesture];
                if (this.isCounterIncrease(previous, next)) {
                    logger.info(`Tap counter increase: ${side}.${gesture} ${previous} → ${next}`);
                    await this.processGesture(side, gesture, nextDeviceStatus);
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
        let waitTime = hasGestures ? 2_000 : 60_000;
        if (hasGestures) {
            this.deviceStatus = await franken.getDeviceStatus(true);
            logger.info(`Gestures supported for ${this.deviceStatus.coverVersion}`);
        }
        else {
            logger.info(`Gestures not supported for ${this.deviceStatus.coverVersion}`);
        }
        // No point in querying device status every 3 seconds for checking the prime status...
        while (this.isRunning) {
            try {
                while (this.isRunning) {
                    hasGestures = this.deviceStatus.coverVersion !== Version.Pod3;
                    waitTime = hasGestures ? 2_000 : 60_000;
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