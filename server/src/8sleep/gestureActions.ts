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
import {
  clampTempF,
  resolveTargetBaselineF,
} from './commandedTemperature.js';

const DEFAULT_ON_TEMP_F = 82;

function parseMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function offsetFromPowerOn(minutes: number, powerOnMinutes: number): number {
  return (minutes - powerOnMinutes + 24 * 60) % (24 * 60);
}

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

export type GestureActionResult = {
  success: boolean;
  message: string;
  targetTemperatureF?: number;
  isOn?: boolean;
};

export async function runGestureAction(
  side: Side,
  gesture: Gesture,
  config: TapConfigType,
  deviceStatus: DeviceStatus,
): Promise<GestureActionResult> {
  await settingsDB.read();

  if (settingsDB.data[side].awayMode) {
    const message = `${side} side is in away mode — tap ignored`;
    logger.debug(message);
    return { success: false, message };
  }

  try {
    const sideStatus = deviceStatus[side];
    const wasOn = sideStatus.isOn;

    // Any gesture turns the side on when it is off (no temp delta on that tap)
    if (!wasOn) {
      const targetTemperatureF = resolveTargetBaselineF(
        side,
        sideStatus.targetTemperatureF,
        sideStatus.currentTemperatureF || DEFAULT_ON_TEMP_F,
      );
      await updateDeviceStatus({
        [side]: { isOn: true, targetTemperatureF },
      } as DeepPartial<DeviceStatus>);
      const message = `${side}: ${gesture} → turned on at ${targetTemperatureF}°F`;
      return { success: true, message, targetTemperatureF, isOn: true };
    }

    // Side is on — apply configured action
    if (config.type === 'none') {
      const targetTemperatureF = resolveTargetBaselineF(
        side,
        sideStatus.targetTemperatureF,
        DEFAULT_ON_TEMP_F,
      );
      return {
        success: true,
        message: `${side}: ${gesture} → no action`,
        targetTemperatureF,
        isOn: true,
      };
    }

    if (config.type === 'temperature') {
      // Use last commanded °F, NOT franken level→°F (lossy / can lag by several °F)
      const current = resolveTargetBaselineF(
        side,
        sideStatus.targetTemperatureF,
        DEFAULT_ON_TEMP_F,
      );
      const delta = config.change === 'increment' ? config.amount : -config.amount;
      const next = clampTempF(current + delta);
      await updateDeviceStatus({
        [side]: { targetTemperatureF: next },
      } as DeepPartial<DeviceStatus>);
      const sign = config.change === 'increment' ? '+' : '−';
      const message = `${side}: ${gesture} → ${sign}${config.amount}°F (${current}→${next}°F)`;
      return { success: true, message, targetTemperatureF: next, isOn: true };
    }

    if (config.type === 'power') {
      let isOn = true;
      if (config.action === 'off') isOn = false;
      else if (config.action === 'on') isOn = true;
      else isOn = !sideStatus.isOn;

      const targetTemperatureF = resolveTargetBaselineF(
        side,
        sideStatus.targetTemperatureF,
        DEFAULT_ON_TEMP_F,
      );
      await updateDeviceStatus({
        [side]: isOn
          ? { isOn: true, targetTemperatureF }
          : { isOn: false },
      } as DeepPartial<DeviceStatus>);
      const message = `${side}: ${gesture} → power ${isOn ? 'on' : 'off'}`;
      return {
        success: true,
        message,
        targetTemperatureF,
        isOn,
      };
    }

    if (config.type === 'scheduleApply') {
      const temperatureF = resolveTargetBaselineF(
        side,
        sideStatus.targetTemperatureF,
        sideStatus.currentTemperatureF || DEFAULT_ON_TEMP_F,
      );
      const result = await applyCurrentTempToScheduleAllDays(side, temperatureF);
      const message = `${side}: ${gesture} → schedule ${result.slotTime} = ${result.temperatureF}°F (all days)`;
      return {
        success: true,
        message,
        targetTemperatureF: result.temperatureF,
        isOn: true,
      };
    }

    if (config.type === 'alarm') {
      await executeFunction('ALARM_CLEAR', 'empty');
      await memoryDB.read();
      memoryDB.data[side].isAlarmVibrating = false;
      await memoryDB.write();
      const targetTemperatureF = resolveTargetBaselineF(
        side,
        sideStatus.targetTemperatureF,
        DEFAULT_ON_TEMP_F,
      );
      const message = `${side}: ${gesture} → alarm ${config.behavior}`;
      return {
        success: true,
        message,
        targetTemperatureF,
        isOn: true,
      };
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
  result: GestureActionResult,
) {
  pushGestureEvent({
    side,
    gesture,
    message: result.message,
    success: result.success,
    targetTemperatureF: result.targetTemperatureF,
    isOn: result.isOn,
  });
}
