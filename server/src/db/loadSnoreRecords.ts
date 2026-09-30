// Load snore heuristic rows from SQLite and convert epoch timestamps -> ISO8601
import { snore as PrismaSnoreRecord } from '.prisma/client';
import settingsDB from './settings.js';
import moment from 'moment-timezone';

import { SnoreRecord } from './prismaDbTypes.js';

export const loadSnoreRecords = async (snoreRecords: PrismaSnoreRecord[]): Promise<SnoreRecord[]> => {
  await settingsDB.read();
  const userTimeZone: string = settingsDB.data.timeZone || 'UTC';

  return snoreRecords.map((record: any) => ({
    ...record,
    timestamp: moment.tz(record.timestamp * 1000, userTimeZone).format(),
    // Explicit so API consumers know this is not OEM / clinical.
    heuristic: true as const,
  })) as SnoreRecord[];
};
