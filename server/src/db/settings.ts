// LowDB, stores the schedules in /persistent/free-sleep-data/lowdb/settingsDB.json
import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

import { Settings, SideSettings, TapConfigType } from './settingsSchema.js';
import config from '../config.js';

const defaultSideSettings: SideSettings = {
  name: 'Side',
  awayMode: false,
  analyzeSleep: {
    enabled: true,
    minDurationMinutes: 30,
  },
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
    // Pod 4: no single-tap over dac. Double cool, triple warm, quad power off (when on).
    // Any gesture turns the side on when it is off (handled in gestureActions).
    doubleTap: {
      type: 'temperature',
      change: 'decrement',
      amount: 1,
    },
    tripleTap: {
      type: 'temperature',
      change: 'increment',
      amount: 1,
    },
    quadTap: {
      type: 'power',
      action: 'toggle',
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

/** Old shipped defaults we replace when migrating off singleTap / scheduleApply-quad */
function isLegacyTapDefaults(taps: Record<string, unknown> | undefined): boolean {
  if (!taps) return true;
  if ('singleTap' in taps) return true;
  const doubleTap = taps.doubleTap as TapConfigType | undefined;
  const tripleTap = taps.tripleTap as TapConfigType | undefined;
  const quadTap = taps.quadTap as TapConfigType | undefined;
  // Upstream-ish: double +1, triple none, quad scheduleApply
  if (
    doubleTap?.type === 'temperature' &&
    doubleTap.change === 'increment' &&
    tripleTap?.type === 'none' &&
    quadTap?.type === 'scheduleApply'
  ) {
    return true;
  }
  // Prior fork generation: double −1, triple +1, quad scheduleApply
  if (
    doubleTap?.type === 'temperature' &&
    doubleTap.change === 'decrement' &&
    doubleTap.amount === 1 &&
    tripleTap?.type === 'temperature' &&
    tripleTap.change === 'increment' &&
    tripleTap.amount === 1 &&
    quadTap?.type === 'scheduleApply'
  ) {
    return true;
  }
  return false;
}

const file = new JSONFile<Settings>(`${config.lowDbFolder}settingsDB.json`);
const settingsDB = new Low<Settings>(file, defaultData);
await settingsDB.read();

// Migrate tap mappings: strip singleTap and adopt multi-tap defaults when still on legacy set
for (const side of ['left', 'right'] as const) {
  const taps = settingsDB.data?.[side]?.taps as Record<string, unknown> | undefined;
  if (isLegacyTapDefaults(taps)) {
    settingsDB.data[side].taps = _.cloneDeep(defaultSideSettings.taps);
  } else if (taps && 'singleTap' in taps) {
    delete taps.singleTap;
  }
}

settingsDB.data = _.merge({}, defaultData, settingsDB.data);

// Ensure each side has only the three multi-tap keys (don't resurrect singleTap)
// and analyzeSleep defaults if missing from older installs
for (const side of ['left', 'right'] as const) {
  settingsDB.data[side].taps = {
    doubleTap: settingsDB.data[side].taps?.doubleTap ?? defaultSideSettings.taps.doubleTap,
    tripleTap: settingsDB.data[side].taps?.tripleTap ?? defaultSideSettings.taps.tripleTap,
    quadTap: settingsDB.data[side].taps?.quadTap ?? defaultSideSettings.taps.quadTap,
  };
  settingsDB.data[side].analyzeSleep = {
    enabled:
      settingsDB.data[side].analyzeSleep?.enabled ??
      defaultSideSettings.analyzeSleep.enabled,
    minDurationMinutes:
      settingsDB.data[side].analyzeSleep?.minDurationMinutes ??
      defaultSideSettings.analyzeSleep.minDurationMinutes,
  };
}

await settingsDB.write();

export default settingsDB;
