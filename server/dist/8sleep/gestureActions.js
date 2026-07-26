import moment from 'moment-timezone';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import schedulesDB from '../db/schedules.js';
import memoryDB from '../db/memoryDB.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { executeFunction } from './deviceApi.js';
import { DAYS_OF_WEEK } from '../jobs/utils.js';
import { pushGestureEvent } from '../db/gestureEvents.js';
import { MAX_TEMP_F, MIN_TEMP_F } from '../utils/temperature.js';
function clampTempF(tempF) {
    return Math.min(MAX_TEMP_F, Math.max(MIN_TEMP_F, Math.round(tempF)));
}
function parseMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
}
function offsetFromPowerOn(minutes, powerOnMinutes) {
    return (minutes - powerOnMinutes + 24 * 60) % (24 * 60);
}
/**
 * Find the schedule temperature slot currently in effect for this side/day.
 * Uses power on as session start so overnight schedules work (e.g. 21:00 → 09:00).
 */
export function findActiveTemperatureSlot(temperatures, powerOn, nowMinutes) {
    const keys = Object.keys(temperatures);
    if (keys.length === 0)
        return null;
    const powerOnMinutes = parseMinutes(powerOn);
    const nowOffset = offsetFromPowerOn(nowMinutes, powerOnMinutes);
    let bestTime = null;
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
export async function applyCurrentTempToScheduleAllDays(side, temperatureF) {
    await schedulesDB.read();
    await settingsDB.read();
    const timeZone = settingsDB.data.timeZone || 'UTC';
    const now = moment.tz(timeZone);
    const dayName = now.format('dddd').toLowerCase();
    const nowMinutes = now.hours() * 60 + now.minutes();
    const todaySchedule = schedulesDB.data[side][dayName];
    let slotTime = findActiveTemperatureSlot(todaySchedule.temperatures, todaySchedule.power.on, nowMinutes);
    // No temperature adjustments yet — create one at power-on time
    if (!slotTime) {
        slotTime = todaySchedule.power.on;
    }
    const temp = clampTempF(temperatureF);
    let daysUpdated = 0;
    for (const day of DAYS_OF_WEEK) {
        schedulesDB.data[side][day].temperatures[slotTime] = temp;
        daysUpdated += 1;
    }
    await schedulesDB.write();
    logger.info(`Gesture scheduleApply: ${side} set ${slotTime} → ${temp}°F on all ${daysUpdated} days`);
    return { slotTime, temperatureF: temp, daysUpdated };
}
function describeAction(config, detail) {
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
export async function runGestureAction(side, gesture, config, deviceStatus) {
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
            });
            const message = `${side}: ${gesture} → ${describeAction(config, `${current}→${next}°F`)}`;
            return { success: true, message };
        }
        if (config.type === 'power') {
            let isOn = deviceStatus[side].isOn;
            if (config.action === 'off')
                isOn = false;
            else if (config.action === 'on')
                isOn = true;
            else
                isOn = !isOn;
            await updateDeviceStatus({
                [side]: { isOn },
            });
            const message = `${side}: ${gesture} → power ${isOn ? 'on' : 'off'}`;
            return { success: true, message };
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
    }
    catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Gesture action failed: ${errMessage}`);
        return { success: false, message: `${side}: ${gesture} failed — ${errMessage}` };
    }
}
export function recordGestureResult(side, gesture, result) {
    pushGestureEvent({
        side,
        gesture,
        message: result.message,
        success: result.success,
    });
}
//# sourceMappingURL=gestureActions.js.map