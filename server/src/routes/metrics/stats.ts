import express, { Request, Response } from 'express';
import logger from '../../logger.js';
import { getMetricsStats, pruneMetrics } from '../../db/metricsRetention.js';

const router = express.Router();

/**
 * Lightweight visibility for on-pod health and off-pod agents.
 * GET /api/metrics/stats
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getMetricsStats();
    res.json(stats);
  } catch (error) {
    logger.error(error);
    res.status(500).json({
      error: { message: error instanceof Error ? error.message : 'Failed to load metrics stats' },
    });
  }
});

/**
 * Manual prune trigger (safe; only deletes aged rows per retention policy).
 * POST /api/metrics/prune
 * Body optional: { "force": true } to VACUUM even if nothing deleted.
 */
router.post('/prune', async (req: Request, res: Response) => {
  try {
    const force = Boolean(req.body?.force);
    const result = await pruneMetrics({ force, reason: 'api' });
    res.json(result);
  } catch (error) {
    logger.error(error);
    res.status(500).json({
      error: { message: error instanceof Error ? error.message : 'Prune failed' },
    });
  }
});

export default router;
