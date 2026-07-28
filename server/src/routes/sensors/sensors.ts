import express, { Request, Response } from 'express';
import { readSideSensorSnapshot } from '../../8sleep/rawSensorReader.js';
import { Side } from '../../db/schedulesSchema.js';

const router = express.Router();

/**
 * Latest cap + piezo snapshot for one side from the Pod .RAW tail.
 * GET /api/sensors/live?side=left|right
 *
 * Lightweight poll endpoint — only hits disk when the Sensors UI is active.
 */
router.get('/live', (req: Request, res: Response) => {
  const sideParam = typeof req.query.side === 'string' ? req.query.side : 'right';
  const side: Side = sideParam === 'left' ? 'left' : 'right';
  const snapshot = readSideSensorSnapshot(side);
  res.json(snapshot);
});

export default router;
