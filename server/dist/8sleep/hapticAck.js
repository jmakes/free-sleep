import cbor from 'cbor';
import logger from '../logger.js';
import { executeFunction } from './deviceApi.js';
import { wait } from './promises.js';
/**
 * Pod 4 only accepts pattern "double" ( "rise" logs invalid pattern and falls back).
 *
 * Important: keep `du` short (1s). A longer duration leaves a sustained low rumble
 * after the double-click pattern if ALARM_CLEAR is delayed by other franken commands.
 */
const PATTERN = 'double';
const HAPTIC_INTENSITY = 50;
const CLICK_ON_MS = 200;
const CLICK_GAP_MS = 300;
/** How long to let the firmware double-pattern play before CLEAR */
const DOUBLE_PATTERN_MS = 550;
async function startMotor(command) {
    // du=1 is the minimum useful window; we always CLEAR early for a short ack
    const payload = {
        pl: HAPTIC_INTENSITY,
        du: 1,
        pi: PATTERN,
        tt: Math.floor(Date.now() / 1000),
    };
    await executeFunction(command, cbor.encode(payload).toString('hex'));
}
async function stopMotor() {
    await executeFunction('ALARM_CLEAR', 'empty');
    // Second clear: belt-and-suspenders if the first was ignored while busy
    await wait(30);
    await executeFunction('ALARM_CLEAR', 'empty');
}
/**
 * Side-local vibration acknowledgment.
 * Must fully finish (including CLEAR) before other franken commands run,
 * or a late CLEAR lets the motor keep rumbling.
 */
export async function playHapticAck(side, pulses) {
    const count = Math.max(0, Math.min(8, Math.floor(pulses)));
    if (count === 0)
        return;
    const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';
    try {
        if (count === 2) {
            await startMotor(command);
            await wait(DOUBLE_PATTERN_MS);
            await stopMotor();
            logger.info(`Haptic ack: ${side} × 2 (double pattern, du=1)`);
            return;
        }
        for (let index = 0; index < count; index++) {
            await startMotor(command);
            await wait(CLICK_ON_MS);
            await stopMotor();
            if (index < count - 1) {
                await wait(CLICK_GAP_MS);
            }
        }
        logger.info(`Haptic ack: ${side} × ${count} (discrete)`);
    }
    catch (error) {
        // Always try to silence the motor if something failed mid-ack
        try {
            await stopMotor();
        }
        catch {
            // ignore
        }
        logger.warn(`Haptic ack failed for ${side}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function pulseCountForGesture(gesture) {
    switch (gesture) {
        case 'singleTap':
            return 1;
        case 'doubleTap':
            return 2;
        case 'tripleTap':
            return 3;
        case 'quadTap':
            return 4;
        default:
            return 1;
    }
}
//# sourceMappingURL=hapticAck.js.map