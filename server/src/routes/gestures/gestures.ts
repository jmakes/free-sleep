import express, { Request, Response } from 'express';
import { getRecentGestureEvents } from '../../db/gestureEvents.js';

const router = express.Router();

/**
 * Recent cover tap events for UI toasts / debugging.
 * GET /api/gestures/recent?sinceId=<id>
 */
router.get('/recent', (req: Request, res: Response) => {
  const sinceId = typeof req.query.sinceId === 'string' ? req.query.sinceId : undefined;
  res.json({ events: getRecentGestureEvents(sinceId) });
});

export default router;
