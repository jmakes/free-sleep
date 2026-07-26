import cbor from 'cbor';
import logger from '../logger.js';
import { Side } from '../db/schedulesSchema.js';
import { executeFunction } from './deviceApi.js';
import { wait } from './promises.js';

/**
 * ~2 pulses/sec (mouse double-click pacing).
 * Keep ON long enough for the motor to engage; CLEAR too early feels like one blip.
 */
const PULSE_ON_MS = 320;
const PULSE_GAP_MS = 180;
const HAPTIC_INTENSITY = 60;

async function fireAlarmPulse(command: 'ALARM_LEFT' | 'ALARM_RIGHT', pattern: 'rise' | 'double', durationSec: number) {
  const payload = {
    pl: HAPTIC_INTENSITY,
    du: durationSec,
    pi: pattern,
    tt: Math.floor(Date.now() / 1000),
  };
  const hexPayload = cbor.encode(payload).toString('hex');
  await executeFunction(command, hexPayload);
}

/**
 * Side-local vibration acknowledgment: N short pulses on the tapped side.
 * Uses the alarm motor briefly, then clears so we do not leave an alarm running.
 */
export async function playHapticAck(side: Side, pulses: number): Promise<void> {
  const count = Math.max(0, Math.min(8, Math.floor(pulses)));
  if (count === 0) return;

  const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';

  try {
    // Firmware has a built-in double pattern — more reliable than two short rises
    if (count === 2) {
      await fireAlarmPulse(command, 'double', 2);
      await wait(700);
      await executeFunction('ALARM_CLEAR', 'empty');
      logger.info(`Haptic ack complete: ${side} × 2 (firmware double pattern)`);
      return;
    }

    for (let index = 0; index < count; index++) {
      await fireAlarmPulse(command, 'rise', 1);
      await wait(PULSE_ON_MS);
      await executeFunction('ALARM_CLEAR', 'empty');
      // Brief settle so the next pulse is a distinct click
      if (index < count - 1) {
        await wait(PULSE_GAP_MS);
      }
    }
    logger.info(`Haptic ack complete: ${side} × ${count}`);
  } catch (error) {
    logger.warn(`Haptic ack failed for ${side}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function pulseCountForGesture(gesture: string): number {
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
