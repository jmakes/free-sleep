import moment from 'moment-timezone';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import { connectFranken } from './frankenServer.js';
import { wait } from './promises.js';
import { DeviceStatus, Version } from '../routes/deviceStatus/deviceStatusSchema.js';
import { Side } from '../db/schedulesSchema.js';
import { Gesture, GestureSchema } from '../db/settingsSchema.js';
import serverStatus from '../serverStatus.js';
import { playHapticAck, pulseCountForGesture } from './hapticAck.js';
import { recordGestureResult, runGestureAction } from './gestureActions.js';



export class FrankenMonitor {
  private isRunning: boolean;
  private deviceStatus?: DeviceStatus;
  /** Prevent overlapping gesture handling storms */
  private handlingGesture: boolean;

  constructor() {
    this.isRunning = false;
    this.deviceStatus = undefined;
    this.handlingGesture = false;
  }

  public async start() {
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

  public stop() {
    if (!this.isRunning) return;
    logger.debug('Stopping FrankenMonitor loop');
    this.isRunning = false;
  }

  private async processGesture(side: Side, gesture: Gesture, nextDeviceStatus: DeviceStatus) {
    await settingsDB.read();
    const behavior = settingsDB.data[side]?.taps?.[gesture];
    if (!behavior) {
      logger.warn(`No tap mapping for ${side}.${gesture}`);
      return;
    }

    logger.info(`Gesture detected: ${side} ${gesture} → ${behavior.type}`);

    // Haptic MUST finish (including ALARM_CLEAR) before other franken commands.
    // Running in parallel with temp updates delayed CLEAR and left a long low rumble
    // after the double-click pattern (du was also too long).
    await playHapticAck(side, pulseCountForGesture(gesture));
    const actionResult = await runGestureAction(side, gesture, behavior, nextDeviceStatus);
    recordGestureResult(side, gesture, actionResult);
    logger.info(actionResult.message);
  }

  /**
   * Only treat a real counter *increase* as a tap.
   * Do not fire on undefined→N (first sample / flaky DEVICE_STATUS fields) or N→undefined.
   * Firing on those caused accidental power-offs when tripleTap maps to power off.
   */
  private isCounterIncrease(previous: number | undefined, next: number | undefined): boolean {
    if (typeof previous !== 'number' || typeof next !== 'number') return false;
    if (!Number.isFinite(previous) || !Number.isFinite(next)) return false;
    return next > previous;
  }

  private async processGesturesForSide(nextDeviceStatus: DeviceStatus, side: Side) {
    try {
      // Prefer higher-count gestures first so a triple doesn't also fire single/double
      // if firmware stamps multiple fields. singleTap (dismissAlarm) is still checked.
      const order: Gesture[] = ['quadTap', 'tripleTap', 'doubleTap', 'singleTap'];
      let handled = false;
      for (const gesture of order) {
        const previous = this.deviceStatus?.[side]?.taps?.[gesture];
        const next = nextDeviceStatus[side]?.taps?.[gesture];
        if (this.isCounterIncrease(previous, next)) {
          logger.info(
            `Tap event: ${side}.${gesture} ${previous} → ${next}`
          );
          await this.processGesture(side, gesture, nextDeviceStatus);
          handled = true;
          // One gesture per side per poll — multi-tap timestamps can be close
          break;
        }
      }
      // Log singleTap stamps when present so we can see dismissAlarm activity
      if (!handled) {
        const single = nextDeviceStatus[side]?.taps?.singleTap;
        if (single !== undefined && single > 0) {
          logger.debug(`${side}.singleTap stamp=${single}`);
        }
      }
    } catch (error) {
      logger.error(error);
    }
  }

  private async processGestures(nextDeviceStatus: DeviceStatus) {
    if (!this.deviceStatus) {
      logger.warn('Missing current deviceStatus, exiting...');
      return;
    }
    // Need a prior sample that already included tap counters, otherwise any first
    // non-zero reading would look like a "change" and fire every mapping at once.
    const hadTapBaseline =
      this.deviceStatus.left.taps !== undefined || this.deviceStatus.right.taps !== undefined;
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
    } finally {
      this.handlingGesture = false;
    }
  }


  private async frankenLoop() {
    const franken = await connectFranken();
    this.deviceStatus = await franken.getDeviceStatus(false);
    let hasGestures = this.deviceStatus.coverVersion !== Version.Pod3;
    // 1s sampling balances responsiveness vs franken load (toasts poll separately at 500ms)
    let waitTime = hasGestures ? 1_000 : 60_000;
    if (hasGestures) {
      this.deviceStatus = await franken.getDeviceStatus(true);
      logger.info(`Gestures supported for ${this.deviceStatus.coverVersion}`);
    } else {
      logger.info(`Gestures not supported for ${this.deviceStatus.coverVersion}`);
    }
    // No point in querying device status every 3 seconds for checking the prime status...
    while (this.isRunning) {
      try {
        while (this.isRunning) {
          hasGestures = this.deviceStatus.coverVersion !== Version.Pod3;
          waitTime = hasGestures ? 1_000 : 60_000;
          await wait(waitTime);
          if (!this.isRunning) break;
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
      } catch (error) {
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
