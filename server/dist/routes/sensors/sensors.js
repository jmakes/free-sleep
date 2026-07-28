import express from 'express';
import { readSideSensorSnapshot } from '../../8sleep/rawSensorReader.js';
const router = express.Router();
/**
 * Latest cap + piezo snapshot for one side from the Pod .RAW tail.
 * GET /api/sensors/live?side=left|right
 *
 * Lightweight poll endpoint — only hits disk when the Sensors UI is active.
 */
router.get('/live', (req, res) => {
    const sideParam = typeof req.query.side === 'string' ? req.query.side : 'right';
    const side = sideParam === 'left' ? 'left' : 'right';
    const snapshot = readSideSensorSnapshot(side);
    res.json(snapshot);
});
export default router;
//# sourceMappingURL=sensors.js.map