import _ from 'lodash';
import { DeepPartial } from 'ts-essentials';
import cbor from 'cbor';

import { DeviceStatus, SideStatus } from './deviceStatusSchema.js';
import { executeFunction } from '../../8sleep/deviceApi.js';
import logger from '../../logger.js';
import settingsDB from '../../db/settings.js';
import memoryDB from '../../db/memoryDB.js';
import { INVERTED_SETTINGS_KEY_MAPPING } from '../../8sleep/loadDeviceStatus.js';
import { setCommandedTargetF } from '../../8sleep/commandedTemperature.js';

const DEFAULT_ON_TEMP_F = 82;

const calculateLevelFromF = (temperatureF: number) => {
  const level = (temperatureF - 82.5) / 27.5 * 100;
  return Math.round(level).toString();
};

const updateSide = async (side: 'left' | 'right', sideStatus: DeepPartial<SideStatus>) => {
  await settingsDB.read();
  const settings = settingsDB.data;

  if (settings[side]?.awayMode) {
    // Only block updates for the side that is actually away (and the other side is not
    // driving dual-control). Upstream logged but continued; that could surprise users.
    const otherSide = side === 'left' ? 'right' : 'left';
    if (!settings[otherSide]?.awayMode) {
      const message = `${side} side is in away mode, not updating side`;
      logger.warn(message);
      throw new Error(message);
    }
  }

  const controlBothSides = settings.left.awayMode || settings.right.awayMode;
  const updateLeft = side === 'left' || controlBothSides;
  const updateRight = side === 'right' || controlBothSides;

  const { isOn, targetTemperatureF, secondsRemaining, isAlarmVibrating } = sideStatus;

  if (controlBothSides) {
    logger.debug('One side is in away mode, updating both sides...');
  }

  // Power on: set duration AND a temperature level. Duration alone can leave the
  // side looking "on" in software without the cover actually engaging; matching
  // the schedule power-on path is more reliable.
  if (isOn === true) {
    const onDuration = '43200';
    const tempF = setCommandedTargetF(side, targetTemperatureF ?? DEFAULT_ON_TEMP_F);
    // When controlling both sides, keep commanded baseline in sync for each
    if (controlBothSides) {
      setCommandedTargetF('left', tempF);
      setCommandedTargetF('right', tempF);
    }
    const level = calculateLevelFromF(tempF);
    logger.info(
      `Power ON ${side}: duration=${onDuration}s tempF=${tempF} level=${level} updateL=${updateLeft} updateR=${updateRight}`
    );
    if (updateLeft) {
      await executeFunction('TEMP_LEVEL_LEFT', level);
      await executeFunction('LEFT_TEMP_DURATION', onDuration);
    }
    if (updateRight) {
      await executeFunction('TEMP_LEVEL_RIGHT', level);
      await executeFunction('RIGHT_TEMP_DURATION', onDuration);
    }
  } else if (isOn === false) {
    logger.info(`Power OFF ${side}: updateL=${updateLeft} updateR=${updateRight}`);
    // Keep last commanded temp so turn-on / next +1 has a stable baseline
    if (updateLeft) await executeFunction('LEFT_TEMP_DURATION', '0');
    if (updateRight) await executeFunction('RIGHT_TEMP_DURATION', '0');
  }

  // Temperature-only updates (power already on)
  if (targetTemperatureF !== undefined && isOn !== true) {
    const tempF = setCommandedTargetF(side, targetTemperatureF);
    if (controlBothSides) {
      setCommandedTargetF('left', tempF);
      setCommandedTargetF('right', tempF);
    }
    const level = calculateLevelFromF(tempF);
    logger.info(`Set temp ${side}: tempF=${tempF} level=${level}`);
    if (updateLeft) await executeFunction('TEMP_LEVEL_LEFT', level);
    if (updateRight) await executeFunction('TEMP_LEVEL_RIGHT', level);
  }

  if (secondsRemaining) {
    const seconds = Math.round(secondsRemaining).toString();
    if (updateLeft) await executeFunction('LEFT_TEMP_DURATION', seconds);
    if (updateRight) await executeFunction('RIGHT_TEMP_DURATION', seconds);
  }

  if (isAlarmVibrating !== undefined) {
    logger.debug('Can only set isAlarmVibrating to false for now...');
    if (!isAlarmVibrating) await executeFunction('ALARM_CLEAR', 'empty');
    await memoryDB.read();
    memoryDB.data[side].isAlarmVibrating = false;
    await memoryDB.write();
  }
};


const updateSettings = async (settings: Partial<DeviceStatus['settings']>) => {
  const renamedSettings = _.mapKeys(settings, (value, key) => INVERTED_SETTINGS_KEY_MAPPING[key] || key);
  const encodedBuffer = cbor.encode(renamedSettings);
  const hexString = encodedBuffer.toString('hex');
  await executeFunction('SET_SETTINGS', hexString);
};

export const updateDeviceStatus = async (deviceStatus: DeepPartial<DeviceStatus>) => {
  logger.debug(`Updating device status: ${JSON.stringify(deviceStatus)}`);

  if (deviceStatus.isPriming) await executeFunction('PRIME');
  if (deviceStatus?.left) await updateSide('left', deviceStatus.left);
  if (deviceStatus?.right) await updateSide('right', deviceStatus.right);
  if (deviceStatus?.settings) await updateSettings(deviceStatus.settings);
  logger.debug('Finished updating device status');
};
