import cbor from 'cbor';
import logger from '../logger.js';
import { executeFunction } from './deviceApi.js';
import { wait } from './promises.js';
/**
 * Pod 4 franken only accepts certain alarm patterns. Sending `rise` logs:
 *   parseAlarmPattern|[alarm] invalid pattern - using double
 * so we always use `double` for haptic acks.
 *
 * Timing aims for ~2 distinct motor hits per second (mouse double-click pace).
 */
const PATTERN = 'double';
const HAPTIC_INTENSITY = 55;
/** How long to leave the motor on before CLEAR for a single "click" feel */
const CLICK_ON_MS = 220;
/** Gap after CLEAR before the next click */
const CLICK_GAP_MS = 280;
async function startMotor(command, durationSec) {
    const payload = {
        pl: HAPTIC_INTENSITY,
        du: durationSec,
        pi: PATTERN,
        tt: Math.floor(Date.now() / 1000),
    };
    await executeFunction(command, cbor.encode(payload).toString('hex'));
}
async function stopMotor() {
    await executeFunction('ALARM_CLEAR', 'empty');
}
/**
 * Side-local vibration acknowledgment: N short pulses on the tapped side.
 */
export async function playHapticAck(side, pulses) {
    const count = Math.max(0, Math.min(8, Math.floor(pulses)));
    if (count === 0)
        return;
    const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';
    try {
        // Two taps: let firmware run its native double pattern (two hits)
        if (count === 2) {
            await startMotor(command, 3);
            await wait(750);
            await stopMotor();
            logger.info(`Haptic ack: ${side} × 2 (firmware double pattern)`);
            return;
        }
        // 1 / 3 / 4…: discrete clicks via start → wait → clear → gap
        for (let index = 0; index < count; index++) {
            // du must be >= 1 second in firmware; we CLEAR early for a short click
            await startMotor(command, 2);
            await wait(CLICK_ON_MS);
            await stopMotor();
            if (index < count - 1) {
                await wait(CLICK_GAP_MS);
            }
        }
        logger.info(`Haptic ack: ${side} × ${count} (discrete clicks)`);
    }
    catch (error) {
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