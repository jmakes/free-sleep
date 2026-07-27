// This is for storing data in memory when we don't want to update any files in the config.dbFolder
// Updating files in the config.dbFolder will re-trigger job deletion and creation
import { Low, Memory } from 'lowdb';

type SideState = {
  isAlarmVibrating: boolean;
  /** ISO timestamp when this side was last powered on (for session length / analyze window) */
  powerOnAt?: string;
  analyzeSleep: {
    /** Date.now() ms of last analyze start — used to debounce duplicates */
    lastRan?: number;
  }
};

type MemoryDB = {
  left: SideState;
  right: SideState;
};

const defaultMemoryDB: MemoryDB = {
  left: {
    isAlarmVibrating: false,
    powerOnAt: undefined,
    analyzeSleep: {
      lastRan: undefined,
    }
  },
  right: {
    isAlarmVibrating: false,
    powerOnAt: undefined,
    analyzeSleep: {
      lastRan: undefined,
    }
  },
};

const adapter = new Memory<MemoryDB>();
const memoryDB = new Low<MemoryDB>(adapter, defaultMemoryDB);

await memoryDB.read();
memoryDB.data = memoryDB.data || defaultMemoryDB;
await memoryDB.write();

export default memoryDB;
