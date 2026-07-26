import cbor from 'cbor';
import logger from '../logger.js';
import { executeFunction } from './deviceApi.js';
import { wait } from './promises.js';
/** ~2 pulses per second (mouse double-click pacing) */
const PULSE_ON_MS = 160;
const PULSE_GAP_MS = 340;
const HAPTIC_INTENSITY = 50;
/**
 * Side-local vibration acknowledgment: N short pulses on the tapped side.
 * Uses the alarm motor briefly, then clears so we do not leave an alarm running.
 */
export async function playHapticAck(side, pulses) {
    const count = Math.max(0, Math.min(8, Math.floor(pulses)));
    if (count === 0)
        return;
    const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';
    try {
        for (let index = 0; index < count; index++) {
            const payload = {
                pl: HAPTIC_INTENSITY,
                // Firmware uses seconds; keep short and clear early for a click-like feel
                du: 1,
                pi: 'rise',
                tt: Math.floor(Date.now() / 1000),
            };
            const hexPayload = cbor.encode(payload).toString('hex');
            await executeFunction(command, hexPayload);
            await wait(PULSE_ON_MS);
            await executeFunction('ALARM_CLEAR', 'empty');
            if (index < count - 1) {
                await wait(PULSE_GAP_MS);
            }
        }
        logger.debug(`Haptic ack complete: ${side} × ${count}`);
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