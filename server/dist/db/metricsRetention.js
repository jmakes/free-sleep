import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import moment from 'moment-timezone';
import { prisma } from './prisma.js';
import config from '../config.js';
import logger from '../logger.js';
/**
 * Retention defaults for the Pod's constrained /persistent storage.
 * Override with env vars without changing schema/UI.
 */
export const RETENTION = {
    vitalsDays: Number(process.env.FREE_SLEEP_VITALS_RETENTION_DAYS ?? 30),
    movementDays: Number(process.env.FREE_SLEEP_MOVEMENT_RETENTION_DAYS ?? 30),
    sleepDays: Number(process.env.FREE_SLEEP_SLEEP_RETENTION_DAYS ?? 180),
    /** When free space is below this (MB), prune more aggressively */
    lowDiskMb: Number(process.env.FREE_SLEEP_LOW_DISK_MB ?? 150),
    lowDiskVitalsDays: Number(process.env.FREE_SLEEP_LOW_DISK_VITALS_DAYS ?? 14),
    lowDiskMovementDays: Number(process.env.FREE_SLEEP_LOW_DISK_MOVEMENT_DAYS ?? 14),
};
function dbPaths() {
    const base = path.join(config.dbFolder, 'free-sleep.db');
    return {
        db: base,
        wal: `${base}-wal`,
        shm: `${base}-shm`,
    };
}
export async function getFileSizeBytes(filePath) {
    try {
        const stat = await fsPromises.stat(filePath);
        return stat.size;
    }
    catch {
        return 0;
    }
}
export async function getDbSizeBytes() {
    const { db, wal, shm } = dbPaths();
    const sizes = await Promise.all([db, wal, shm].map(getFileSizeBytes));
    return sizes.reduce((sum, size) => sum + size, 0);
}
export async function getFreeDiskMb(targetPath = config.dbFolder) {
    try {
        // Node 18.15+ / 19+
        const stats = await fsPromises.statfs(targetPath);
        const free = Number(stats.bfree) * Number(stats.bsize);
        return Math.round((free / (1024 * 1024)) * 10) / 10;
    }
    catch {
        // Fallback: df via /proc not available everywhere; leave undefined
        return undefined;
    }
}
export async function getMetricsStats() {
    const freeDiskMb = await getFreeDiskMb();
    const dbBytes = await getDbSizeBytes();
    const [vitalsCount, movementCount, sleepCount, oldestVital, newestVital, oldestMovement, newestMovement] = await Promise.all([
        prisma.vitals.count(),
        prisma.movement.count(),
        prisma.sleep_records.count(),
        prisma.vitals.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } }),
        prisma.vitals.findFirst({ orderBy: { timestamp: 'desc' }, select: { timestamp: true } }),
        prisma.movement.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } }),
        prisma.movement.findFirst({ orderBy: { timestamp: 'desc' }, select: { timestamp: true } }),
    ]);
    return {
        freeDiskMb,
        dbBytes,
        dbMb: Math.round((dbBytes / (1024 * 1024)) * 100) / 100,
        retention: RETENTION,
        counts: {
            vitals: vitalsCount,
            movement: movementCount,
            sleep_records: sleepCount,
        },
        range: {
            vitals: {
                oldest: oldestVital?.timestamp ?? null,
                newest: newestVital?.timestamp ?? null,
            },
            movement: {
                oldest: oldestMovement?.timestamp ?? null,
                newest: newestMovement?.timestamp ?? null,
            },
        },
    };
}
/**
 * Delete old high-volume metrics rows and reclaim space when possible.
 * Sleep records are kept much longer (low volume, high value).
 */
export async function pruneMetrics(options) {
    const reason = options?.reason ?? 'scheduled';
    const freeDiskMbBefore = await getFreeDiskMb();
    const dbBytesBefore = await getDbSizeBytes();
    let vitalsDays = RETENTION.vitalsDays;
    let movementDays = RETENTION.movementDays;
    const sleepDays = RETENTION.sleepDays;
    if (freeDiskMbBefore !== undefined && freeDiskMbBefore < RETENTION.lowDiskMb) {
        vitalsDays = Math.min(vitalsDays, RETENTION.lowDiskVitalsDays);
        movementDays = Math.min(movementDays, RETENTION.lowDiskMovementDays);
        logger.warn(`Low free disk (${freeDiskMbBefore} MB). Using aggressive retention: vitals=${vitalsDays}d movement=${movementDays}d`);
    }
    const vitalsCutoff = moment().subtract(vitalsDays, 'days').unix();
    const movementCutoff = moment().subtract(movementDays, 'days').unix();
    const sleepCutoff = moment().subtract(sleepDays, 'days').unix();
    logger.info(`Pruning metrics (${reason}): vitals < ${vitalsDays}d, movement < ${movementDays}d, sleep < ${sleepDays}d`);
    const vitals = await prisma.vitals.deleteMany({
        where: { timestamp: { lt: vitalsCutoff } },
    });
    const movement = await prisma.movement.deleteMany({
        where: { timestamp: { lt: movementCutoff } },
    });
    const sleep = await prisma.sleep_records.deleteMany({
        where: { entered_bed_at: { lt: sleepCutoff } },
    });
    let vacuumed = false;
    const deletedAny = vitals.count + movement.count + sleep.count > 0;
    const lowDisk = freeDiskMbBefore !== undefined && freeDiskMbBefore < RETENTION.lowDiskMb;
    // VACUUM reclaims file size but can be heavy; only when we deleted rows or disk is low
    if (deletedAny || lowDisk || options?.force) {
        try {
            // Checkpoint WAL first so VACUUM can shrink the main file
            await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
            await prisma.$executeRawUnsafe('VACUUM');
            vacuumed = true;
            logger.info('SQLite VACUUM completed after prune');
        }
        catch (error) {
            logger.warn(`VACUUM failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const freeDiskMbAfter = await getFreeDiskMb();
    const dbBytesAfter = await getDbSizeBytes();
    const result = {
        vitalsDeleted: vitals.count,
        movementDeleted: movement.count,
        sleepDeleted: sleep.count,
        vacuumed,
        freeDiskMbBefore,
        freeDiskMbAfter,
        dbBytesBefore,
        dbBytesAfter,
        reason,
    };
    logger.info(`Prune done (${reason}): vitals=${result.vitalsDeleted} movement=${result.movementDeleted} sleep=${result.sleepDeleted} vacuumed=${vacuumed} dbMb ${((dbBytesBefore ?? 0) / 1e6).toFixed(1)}→${((dbBytesAfter ?? 0) / 1e6).toFixed(1)}`);
    return result;
}
/**
 * Shared time-range resolution for metrics APIs.
 * Prevents unbounded scans that OOM / lock the Pod when the DB is large.
 */
export function resolveUnixTimeRange(startTime, endTime, options) {
    const defaultDays = options?.defaultDays ?? Number(process.env.FREE_SLEEP_DEFAULT_QUERY_DAYS ?? 7);
    const maxDays = options?.maxDays ?? Number(process.env.FREE_SLEEP_MAX_QUERY_DAYS ?? 31);
    let end = endTime ? moment(endTime) : moment();
    let start = startTime ? moment(startTime) : end.clone().subtract(defaultDays, 'days');
    const defaulted = !startTime || !endTime;
    let clamped = false;
    if (!start.isValid() || !end.isValid()) {
        throw new Error('Invalid startTime or endTime');
    }
    if (start.isAfter(end)) {
        const tmp = start.clone();
        start = end.clone();
        end = tmp;
    }
    if (end.diff(start, 'days', true) > maxDays) {
        start = end.clone().subtract(maxDays, 'days');
        clamped = true;
    }
    return {
        gte: start.unix(),
        lte: end.unix(),
        defaulted,
        clamped,
    };
}
// Ensure data folder exists when imported in local dev
if (!fs.existsSync(config.dbFolder)) {
    try {
        fs.mkdirSync(config.dbFolder, { recursive: true });
    }
    catch {
        // ignore
    }
}
//# sourceMappingURL=metricsRetention.js.map