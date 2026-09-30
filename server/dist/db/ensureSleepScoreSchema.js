/**
 * Ensure sleep_score_v1 columns exist (SQLite). Safe if already present.
 * Mirrors biometrics ensure_sleep_score_schema for Pods ahead of prisma migrate.
 */
import { prisma } from './prisma.js';
import logger from '../logger.js';
let ensured = false;
export async function ensureSleepScoreSchema() {
    if (ensured)
        return;
    try {
        const rows = await prisma.$queryRawUnsafe('PRAGMA table_info(sleep_records)');
        const cols = new Set(rows.map((r) => r.name));
        if (!cols.has('sleep_score_v1')) {
            await prisma.$executeRawUnsafe('ALTER TABLE sleep_records ADD COLUMN sleep_score_v1 INTEGER');
            logger.info('Added sleep_records.sleep_score_v1 column');
        }
        if (!cols.has('sleep_score_v1_json')) {
            await prisma.$executeRawUnsafe('ALTER TABLE sleep_records ADD COLUMN sleep_score_v1_json TEXT');
            logger.info('Added sleep_records.sleep_score_v1_json column');
        }
        ensured = true;
    }
    catch (error) {
        logger.error(`ensureSleepScoreSchema failed: ${error instanceof Error ? error.message : error}`);
    }
}
//# sourceMappingURL=ensureSleepScoreSchema.js.map