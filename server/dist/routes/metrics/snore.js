import express from 'express';
import { loadSnoreRecords } from '../../db/loadSnoreRecords.js';
import { prisma } from '../../db/prisma.js';
import { resolveUnixTimeRange } from '../../db/metricsRetention.js';
import logger from '../../logger.js';
const router = express.Router();
/**
 * GET /api/metrics/snore
 * Per-minute piezo snore *heuristic* timeline (mirrors /movement).
 * Values are night-adaptive band-energy scores — not OEM ML / clinical.
 */
router.get('/snore', async (req, res) => {
    try {
        const { startTime, endTime, side } = req.query;
        const query = {};
        if (side)
            query.side = side;
        let range;
        try {
            range = resolveUnixTimeRange(startTime, endTime);
        }
        catch {
            res.status(400).json({ error: { message: 'Invalid startTime or endTime' } });
            return;
        }
        query.timestamp = { gte: range.gte, lte: range.lte };
        const snoreRecords = await prisma.snore.findMany({
            where: query,
            orderBy: { timestamp: 'asc' },
        });
        const formattedRecords = await loadSnoreRecords(snoreRecords);
        res.json(formattedRecords);
    }
    catch (error) {
        logger.error(error);
        const message = error instanceof Error ? error.message : 'Failed to load snore heuristic';
        const isDiskFull = /SQLITE_FULL|database or disk is full/i.test(message);
        res.status(isDiskFull ? 507 : 500).json({
            error: {
                message: isDiskFull
                    ? 'Database or disk is full. Call POST /api/metrics/prune or wait for automatic retention.'
                    : message,
            },
        });
    }
});
export default router;
//# sourceMappingURL=snore.js.map