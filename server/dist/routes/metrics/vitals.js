import express from 'express';
import settingsDB from '../../db/settings.js';
import { loadVitals } from '../../db/loadVitals.js';
import { prisma } from '../../db/prisma.js';
import { resolveUnixTimeRange } from '../../db/metricsRetention.js';
import logger from '../../logger.js';
const router = express.Router();
router.get('/vitals', async (req, res) => {
    try {
        const { side, startTime, endTime } = req.query;
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
        if (range.defaulted || range.clamped) {
            logger.debug(`Vitals query bounded: defaulted=${range.defaulted} clamped=${range.clamped} gte=${range.gte} lte=${range.lte}`);
        }
        const vitals = await prisma.vitals.findMany({
            where: query,
            orderBy: { timestamp: 'asc' },
        });
        await settingsDB.read();
        const formattedVitals = await loadVitals(vitals);
        res.json(formattedVitals);
    }
    catch (error) {
        logger.error(error);
        const message = error instanceof Error ? error.message : 'Failed to load vitals';
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
router.get('/vitals/summary', async (req, res) => {
    try {
        const { side, startTime, endTime } = req.query;
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
        // Query: Min & Max Heart Rate
        const heartRateSummary = await prisma.vitals.aggregate({
            where: query,
            _min: { heart_rate: true },
            _max: { heart_rate: true },
            _avg: { heart_rate: true },
        });
        // Query: Average Breathing Rate (excluding 0)
        const avgBreathingRate = await prisma.vitals.aggregate({
            where: {
                ...query,
                breathing_rate: { not: 0, lte: 20, gte: 5 }, // Exclude zero values
            },
            _avg: { breathing_rate: true },
        });
        // Query: Average HRV (excluding 0)
        const avgHRV = await prisma.vitals.aggregate({
            where: {
                ...query,
                hrv: { not: 0, lte: 120, gte: 30 }, // Exclude zero values
            },
            _avg: { hrv: true },
        });
        res.json({
            avgHeartRate: Math.round(heartRateSummary._avg.heart_rate || 0),
            minHeartRate: Math.round(heartRateSummary._min.heart_rate || 0),
            maxHeartRate: Math.round(heartRateSummary._max.heart_rate || 0),
            avgHRV: Math.round(avgHRV._avg.hrv || 0),
            avgBreathingRate: Math.round(avgBreathingRate._avg.breathing_rate || 0),
        });
    }
    catch (error) {
        logger.error(error);
        const message = error instanceof Error ? error.message : 'Failed to load vitals summary';
        res.status(500).json({ error: { message } });
    }
});
export default router;
//# sourceMappingURL=vitals.js.map