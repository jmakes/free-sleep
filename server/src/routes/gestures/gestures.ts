import express, { Request, Response } from 'express';
import { getRecentGestureEvents } from '../../db/gestureEvents.js';
import { getLastGestureFieldSnapshot } from '../../8sleep/gestureFields.js';
import { connectFranken } from '../../8sleep/frankenServer.js';
import logger from '../../logger.js';

const router = express.Router();

/**
 * Recent cover tap events for UI toasts / debugging.
 * GET /api/gestures/recent?sinceId=<id>
 */
router.get('/recent', (req: Request, res: Response) => {
  const sinceId = typeof req.query.sinceId === 'string' ? req.query.sinceId : undefined;
  res.json({ events: getRecentGestureEvents(sinceId) });
});

/**
 * Last extracted gesture counters + raw tap-like DEVICE_STATUS keys.
 * GET /api/gestures/probe
 *
 * Usage: single-tap the cover a few times, then curl this endpoint to see
 * which firmware fields changed (for discovering single-tap key names).
 */
router.get('/probe', async (_req: Request, res: Response) => {
  try {
    // Force a fresh DEVICE_STATUS read with gesture parsing
    const franken = await connectFranken();
    const status = await franken.getDeviceStatus(true);
    const snapshot = getLastGestureFieldSnapshot();
    res.json({
      now: new Date().toISOString(),
      taps: {
        left: status.left.taps ?? {},
        right: status.right.taps ?? {},
      },
      snapshot,
      hint:
        'Single-tap the cover, wait 1s, call this again. Compare taps/snapshot.tapLikeKeys. ' +
        'If a new key appears or a counter increases, free-sleep can map it to singleTap.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`GET /gestures/probe failed: ${message}`);
    res.status(503).json({ error: { message } });
  }
});

export default router;
