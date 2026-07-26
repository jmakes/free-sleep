// LowDB, stores the schedules in /persistent/free-sleep-data/lowdb/settingsDB.json
import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

import { Settings, SideSettings } from './settingsSchema.js';
import config from '../config.js';

const defaultSideSettings: SideSettings = {
  name: 'Side',
  awayMode: false,
  scheduleOverrides: {
    temperatureSchedules: {
      disabled: false,
      expiresAt: ''
    },
    alarm: {
      disabled: false,
      timeOverride: '',
      expiresAt: '',
    }
  },
  taps: {
    // Defaults match common bed-side preferences:
    // 1× cool, 2× warm, 3× power off, 4× lock current temp into schedule (all days)
    singleTap: {
      type: 'temperature',
      change: 'decrement',
      amount: 1,
    },
    doubleTap: {
      type: 'temperature',
      change: 'increment',
      amount: 1,
    },
    // Power-off via triple-tap temporarily disabled (false positives / diagnosis).
    // Re-enable after tap counters are proven stable on-device.
    tripleTap: {
      type: 'none',
    },
    quadTap: {
      type: 'scheduleApply',
    },
  }
};

const defaultData: Settings = {
  id: crypto.randomUUID(),
  timeZone: 'UTC',
  temperatureFormat: 'fahrenheit',
  rebootDaily: true,
  left: {
    ..._.cloneDeep(defaultSideSettings),
    name: 'Left',
  },
  right: {
    ..._.cloneDeep(defaultSideSettings),
    name: 'Right',
  },
  primePodDaily: {
    enabled: false,
    time: '14:00',
  },
};

const file = new JSONFile<Settings>(`${config.lowDbFolder}settingsDB.json`);
const settingsDB = new Low<Settings>(file, defaultData);
await settingsDB.read();

// One-time upgrade: older installs only had double/triple/quad. Apply the new
// single–quad defaults once so mappings match the documented product behavior.
const legacyTapMap =
  Boolean(settingsDB.data?.left?.taps) &&
  !Object.prototype.hasOwnProperty.call(settingsDB.data.left.taps, 'singleTap');

// Allows us to add default values to the settings if users have existing settingsDB.json data
settingsDB.data = _.merge({}, defaultData, settingsDB.data);

if (legacyTapMap) {
  settingsDB.data.left.taps = _.cloneDeep(defaultSideSettings.taps);
  settingsDB.data.right.taps = _.cloneDeep(defaultSideSettings.taps);
}

// Safety: neutralize power gestures until cover-tap detection is validated on this Pod
for (const side of ['left', 'right'] as const) {
  if (settingsDB.data[side]?.taps?.tripleTap?.type === 'power') {
    settingsDB.data[side].taps.tripleTap = { type: 'none' };
  }
}

await settingsDB.write();

export default settingsDB;
