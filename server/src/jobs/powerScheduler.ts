import schedule from 'node-schedule';
import { Settings } from '../db/settingsSchema.js';
import { DailySchedule, DayOfWeek, Side } from '../db/schedulesSchema.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { getDayIndexForSchedule, getDayOfWeekIndex, logJob } from './utils.js';
import serverStatus from '../serverStatus.js';
import logger from '../logger.js';



export const schedulePowerOn = (settingsData: Settings, side: Side, day: DayOfWeek, power: DailySchedule['power']) => {
  if (!power.enabled) return;
  if (settingsData[side].awayMode) return;
  if (settingsData.timeZone === null) return;

  const onRule = new schedule.RecurrenceRule();
  const dayOfWeekIndex = getDayOfWeekIndex(day);
  onRule.dayOfWeek = dayOfWeekIndex;
  const [onHour, onMinute] = power.on.split(':').map(Number);
  const time = power.on;
  onRule.hour = onHour;
  onRule.minute = onMinute;
  onRule.tz = settingsData.timeZone;

  logJob('Scheduling power on job', side, day, dayOfWeekIndex, time);
  schedule.scheduleJob(`${side}-${day}-${time}-power-on`, onRule, async () => {
    try {
      logJob('Executing power on job', side, day, dayOfWeekIndex, time);

      await updateDeviceStatus({
        [side]: {
          isOn: true,
          targetTemperatureF: power.onTemperature
        }
      });
      serverStatus.status.powerSchedule.status = 'healthy';
      serverStatus.status.powerSchedule.message = '';
    } catch (error: unknown) {
      serverStatus.status.powerSchedule.status = 'failed';
      const message = error instanceof Error ? error.message : String(error);
      serverStatus.status.powerSchedule.message = message;
      logger.error(error);
    }
  });
};


/**
 * Schedule power-off. Sleep analysis is no longer a separate clock job —
 * updateDeviceStatus triggers maybeAnalyzeSleepOnPowerOff for every off path
 * (schedule, GUI, gesture) when the per-side setting allows it.
 */
export const schedulePowerOffAndSleepAnalysis = (settingsData: Settings, side: Side, day: DayOfWeek, power: DailySchedule['power']) => {
  if (!power.enabled) return;
  if (settingsData[side].awayMode) return;
  if (settingsData.timeZone === null) return;

  const offRule = new schedule.RecurrenceRule();
  const dayOfWeekIndex = getDayIndexForSchedule(day, power.off);
  offRule.dayOfWeek = dayOfWeekIndex;
  const time = power.off;
  const [offHour, offMinute] = time.split(':').map(Number);
  offRule.hour = offHour;
  offRule.minute = offMinute;
  offRule.tz = settingsData.timeZone;
  logJob('Scheduling power off job', side, day, dayOfWeekIndex, time);

  schedule.scheduleJob(`${side}-${day}-${time}-power-off`, offRule, async () => {
    try {
      logJob('Executing power off job', side, day, dayOfWeekIndex, time);
      await updateDeviceStatus({
        [side]: {
          isOn: false,
        }
      });
      serverStatus.status.powerSchedule.status = 'healthy';
      serverStatus.status.powerSchedule.message = '';
    } catch (error: unknown) {
      serverStatus.status.powerSchedule.status = 'failed';
      const message = error instanceof Error ? error.message : String(error);
      serverStatus.status.powerSchedule.message = message;
      logger.error(error);
    }
  });
};
