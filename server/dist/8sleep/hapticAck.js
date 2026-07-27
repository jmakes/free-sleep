import cbor from 'cbor';
import logger from '../logger.js';
import { executeFunction } from './deviceApi.js';
import { wait } from './promises.js';
/**
 * Pod 4 franken only accepts alarm pattern "double" ("rise" is rejected).
 *
 * We cannot get a true "single click" pattern from firmware, so each "tick" is a
 * very short burst of the double pattern, cut with ALARM_CLEAR, then a gap so
 * N ticks are countable (1 / 2 / 3 / 4) rather than one long rumble.
 */
const PATTERN = 'double';
const HAPTIC_INTENSITY = 45;
/** Cut the motor almost immediately so each tick is short */
const TICK_ON_MS = 110;
/** Gap between ticks — ~2 ticks/sec overall with motor spin-down */
const TICK_GAP_MS = 390;
async function tick(command) {
    const payload = {
        pl: HAPTIC_INTENSITY,
        du: 1,
        pi: PATTERN,
        tt: Math.floor(Date.now() / 1000),
    };
    await executeFunction(command, cbor.encode(payload).toString('hex'));
    await wait(TICK_ON_MS);
    await executeFunction('ALARM_CLEAR', 'empty');
}
/**
 * Play `pulses` distinct haptic ticks on one side.
 * Caller must await this fully before other franken commands.
 */
export async function playHapticAck(side, pulses) {
    const count = Math.max(0, Math.min(8, Math.floor(pulses)));
    if (count === 0)
        return;
    const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';
    try {
        // Ensure motor is silent before starting a new sequence
        await executeFunction('ALARM_CLEAR', 'empty');
        await wait(50);
        for (let index = 0; index < count; index++) {
            await tick(command);
            if (index < count - 1) {
                await wait(TICK_GAP_MS);
            }
        }
        // Final silence
        await executeFunction('ALARM_CLEAR', 'empty');
        logger.debug(`Haptic ack: ${side} × ${count} ticks`);
    }
    catch (error) {
        try {
            await executeFunction('ALARM_CLEAR', 'empty');
        }
        catch {
            // ignore
        }
        logger.warn(`Haptic ack failed for ${side}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function pulseCountForGesture(gesture) {
    switch (gesture) {
        case 'doubleTap':
            return 2;
        case 'tripleTap':
            return 3;
        case 'quadTap':
            return 4;
        default:
            return 2;
    }
}
//# sourceMappingURL=hapticAck.js.map