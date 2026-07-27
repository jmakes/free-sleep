// This is for storing data in memory when we don't want to update any files in the config.dbFolder
// Updating files in the config.dbFolder will re-trigger job deletion and creation
import { Low, Memory } from 'lowdb';
const defaultMemoryDB = {
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
const adapter = new Memory();
const memoryDB = new Low(adapter, defaultMemoryDB);
await memoryDB.read();
memoryDB.data = memoryDB.data || defaultMemoryDB;
await memoryDB.write();
export default memoryDB;
//# sourceMappingURL=memoryDB.js.map