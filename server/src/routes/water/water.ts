import express, { Request, Response } from 'express';
import { DEFAULT_ALERT_AFTER_SECONDS, waterTracker } from '../../8sleep/waterState.js';

const router = express.Router();

// GET /api/water[?alertAfterSeconds=N]
// Served from the last DEVICE_STATUS sample (no extra hardware request), so it
// is safe to poll from an external routine. `alert` is true once the firmware
// low-water flag has been continuously low for alertAfterSeconds.
router.get('/water', (req: Request, res: Response) => {
  const raw = Number(req.query.alertAfterSeconds);
  const alertAfterSeconds = Number.isFinite(raw) && raw >= 0 && raw <= 7 * 24 * 3600
    ? Math.floor(raw)
    : DEFAULT_ALERT_AFTER_SECONDS;
  res.json(waterTracker.alertView(alertAfterSeconds));
});

export default router;
