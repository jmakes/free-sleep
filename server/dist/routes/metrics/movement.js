import express from 'express';
import { loadMovementRecords } from '../../db/loadMovementRecords.js';
import { prisma } from '../../db/prisma.js';
import { resolveUnixTimeRange } from '../../db/metricsRetention.js';
import logger from '../../logger.js';
const router = express.Router();
router.get('/movement', async (req, res) => {
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
        const movementRecords = await prisma.movement.findMany({
            where: query,
            orderBy: { timestamp: 'asc' },
        });
        const formattedRecords = await loadMovementRecords(movementRecords);
        res.json(formattedRecords);
    }
    catch (error) {
        logger.error(error);
        const message = error instanceof Error ? error.message : 'Failed to load movement';
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
//# sourceMappingURL=movement.js.map