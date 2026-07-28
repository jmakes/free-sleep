import express from 'express';
import { readSideSensorSnapshot } from '../../8sleep/rawSensorReader.js';
const router = express.Router();
/**
 * Latest cap + piezo snapshot for one side from the Pod .RAW tail.
 * GET /api/sensors/live?side=left|right
 *
 * Only used while the Sensors UI is streaming (client Start/Stop).
 */
router.get('/live', async (req, res) => {
    const sideParam = typeof req.query.side === 'string' ? req.query.side : 'right';
    const side = sideParam === 'left' ? 'left' : 'right';
    try {
        const snapshot = await readSideSensorSnapshot(side);
        res.json(snapshot);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({
            side,
            timestamp: new Date().toISOString(),
            error: message,
        });
    }
});
export default router;
//# sourceMappingURL=sensors.js.map