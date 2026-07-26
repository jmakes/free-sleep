import moment from 'moment-timezone';
import { DeepPartial } from 'ts-essentials';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import schedulesDB from '../db/schedules.js';
import memoryDB from '../db/memoryDB.js';
import { DayOfWeek, Side } from '../db/schedulesSchema.js';
import { Gesture, TapConfigType } from '../db/settingsSchema.js';
import { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { executeFunction } from './deviceApi.js';
import { DAYS_OF_WEEK } from '../jobs/utils.js';
import { pushGestureEvent } from '../db/gestureEvents.js';
import { MAX_TEMP_F, MIN_TEMP_F } from '../utils/temperature.js';

function clampTempF(tempF: number): number {
  return Math.min(MAX_TEMP_F, Math.max(MIN_TEMP_F, Math.round(tempF)));
}

function parseMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function offsetFromPowerOn(minutes: number, powerOnMinutes: number): number {
  return (minutes - powerOnMinutes + 24 * 60) % (24 * 60);
}

/**
 * Find the schedule temperature slot currently in effect for this side/day.
 * Uses power on as session start so overnight schedules work (e.g. 21:00 → 09:00).
 */
export function findActiveTemperatureSlot(
  temperatures: Record<string, number>,
  powerOn: string,
  nowMinutes: number,
): string | null {
  const keys = Object.keys(temperatures);
  if (keys.length === 0) return null;

  const powerOnMinutes = parseMinutes(powerOn);
  const nowOffset = offsetFromPowerOn(nowMinutes, powerOnMinutes);

  let bestTime: string | null = null;
  let bestOffset = -1;

  for (const time of keys) {
    const offset = offsetFromPowerOn(parseMinutes(time), powerOnMinutes);
    if (offset <= nowOffset && offset >= bestOffset) {
      bestOffset = offset;
      bestTime = time;
    }
  }

  // If nothing has fired yet in this session, use the earliest slot after power-on
  if (bestTime === null) {
    let earliestOffset = Number.POSITIVE_INFINITY;
    for (const time of keys) {
      const offset = offsetFromPowerOn(parseMinutes(time), powerOnMinutes);
      if (offset < earliestOffset) {
        earliestOffset = offset;
        bestTime = time;
      }
    }
  }

  return bestTime;
}

/**
 * Write the current target temperature into the active schedule slot for every day.
 */
export async function applyCurrentTempToScheduleAllDays(
  side: Side,
  temperatureF: number,
): Promise<{ slotTime: string; temperatureF: number; daysUpdated: number }> {
  await schedulesDB.read();
  await settingsDB.read();

  const timeZone = settingsDB.data.timeZone || 'UTC';
  const now = moment.tz(timeZone);
  const dayName = now.format('dddd').toLowerCase() as DayOfWeek;
  const nowMinutes = now.hours() * 60 + now.minutes();

  const todaySchedule = schedulesDB.data[side][dayName];
  let slotTime = findActiveTemperatureSlot(
    todaySchedule.temperatures,
    todaySchedule.power.on,
    nowMinutes,
  );

  // No temperature adjustments yet — create one at power-on time
  if (!slotTime) {
    slotTime = todaySchedule.power.on;
  }

  const temp = clampTempF(temperatureF);
  let daysUpdated = 0;
  for (const day of DAYS_OF_WEEK as DayOfWeek[]) {
    schedulesDB.data[side][day].temperatures[slotTime] = temp;
    daysUpdated += 1;
  }

  await schedulesDB.write();
  logger.info(
    `Gesture scheduleApply: ${side} set ${slotTime} → ${temp}°F on all ${daysUpdated} days`
  );

  return { slotTime, temperatureF: temp, daysUpdated };
}

function describeAction(config: TapConfigType, detail?: string): string {
  switch (config.type) {
    case 'temperature':
      return `${config.change === 'increment' ? '+' : '−'}${config.amount}°F${detail ? ` (${detail})` : ''}`;
    case 'power':
      return `power ${config.action}`;
    case 'scheduleApply':
      return detail ?? 'apply temperature to schedule (all days)';
    case 'alarm':
      return `alarm ${config.behavior}`;
    case 'none':
      return 'no action';
    default:
      return 'unknown action';
  }
}

export async function runGestureAction(
  side: Side,
  gesture: Gesture,
  config: TapConfigType,
  deviceStatus: DeviceStatus,
): Promise<{ success: boolean; message: string }> {
  await settingsDB.read();

  if (settingsDB.data[side].awayMode) {
    const message = `${side} side is in away mode — tap ignored`;
    logger.info(message);
    return { success: false, message };
  }

  try {
    if (config.type === 'none') {
      return { success: true, message: `${side}: ${gesture} → no action` };
    }

    if (config.type === 'temperature') {
      const current = deviceStatus[side].targetTemperatureF;
      const delta = config.change === 'increment' ? config.amount : -config.amount;
      const next = clampTempF(current + delta);
      await updateDeviceStatus({
        [side]: { targetTemperatureF: next },
      } as DeepPartial<DeviceStatus>);
      const message = `${side}: ${gesture} → ${describeAction(config, `${current}→${next}°F`)}`;
      return { success: true, message };
    }

    if (config.type === 'power') {
      // Temporarily refuse power gestures so a bad tap detection cannot fight the UI
      // or leave a side stuck off while debugging power-on reliability.
      const message = `${side}: ${gesture} → power action ignored (temporarily disabled)`;
      logger.warn(message);
      return { success: false, message };
    }

    if (config.type === 'scheduleApply') {
      // Prefer target temp; fall back to measured if target missing
      const temperatureF = deviceStatus[side].targetTemperatureF || deviceStatus[side].currentTemperatureF;
      const result = await applyCurrentTempToScheduleAllDays(side, temperatureF);
      const message = `${side}: ${gesture} → schedule ${result.slotTime} = ${result.temperatureF}°F (all days)`;
      return { success: true, message };
    }

    if (config.type === 'alarm') {
      if (config.behavior === 'dismiss') {
        await executeFunction('ALARM_CLEAR', 'empty');
        await memoryDB.read();
        memoryDB.data[side].isAlarmVibrating = false;
        await memoryDB.write();
        if (config.inactiveAlarmBehavior === 'power' && !deviceStatus[side].isAlarmVibrating) {
          // Optional: if no alarm was running, treat as power toggle — leave as dismiss-only for safety
        }
        const message = `${side}: ${gesture} → alarm dismissed`;
        return { success: true, message };
      }
      // Snooze: clear current vibration; full reschedule is not wired yet
      await executeFunction('ALARM_CLEAR', 'empty');
      await memoryDB.read();
      memoryDB.data[side].isAlarmVibrating = false;
      await memoryDB.write();
      const message = `${side}: ${gesture} → alarm snoozed (cleared)`;
      return { success: true, message };
    }

    return { success: false, message: `${side}: ${gesture} → unsupported action` };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Gesture action failed: ${errMessage}`);
    return { success: false, message: `${side}: ${gesture} failed — ${errMessage}` };
  }
}

export function recordGestureResult(
  side: Side,
  gesture: Gesture,
  result: { success: boolean; message: string },
) {
  pushGestureEvent({
    side,
    gesture,
    message: result.message,
    success: result.success,
  });
}
