import express from 'express';
import { connectFranken } from '../../8sleep/frankenServer.js';
import { DeviceStatusSchema } from './deviceStatusSchema.js';
import logger from '../../logger.js';
import { updateDeviceStatus } from './updateDeviceStatus.js';
const router = express.Router();
function resolveBody(req) {
    if (req.body !== undefined && req.body !== null && req.body !== '') {
        // express.json may leave a string if content-type was text/plain
        if (typeof req.body === 'string') {
            try {
                return JSON.parse(req.body);
            }
            catch {
                return req.body;
            }
        }
        return req.body;
    }
    // Fallback: parse raw buffer if middleware stashed it
    if (req.rawBody && req.rawBody.length > 0) {
        try {
            return JSON.parse(req.rawBody.toString('utf8'));
        }
        catch (error) {
            logger.warn(`Failed to parse rawBody: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return undefined;
}
router.get('/deviceStatus', async (req, res) => {
    try {
        const franken = await connectFranken();
        const resp = await franken.getDeviceStatus();
        res.json(resp);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`GET /deviceStatus failed: ${message}`);
        res.status(503).json({ error: { message: `Device status unavailable: ${message}` } });
    }
});
router.post('/deviceStatus', async (req, res) => {
    const contentType = req.headers['content-type'] ?? '(none)';
    const contentLength = req.headers['content-length'] ?? '(none)';
    const body = resolveBody(req);
    if (body === undefined || body === null) {
        const rawLen = req.rawBody?.length ?? 0;
        logger.error(`POST /deviceStatus missing body (content-type=${contentType}, content-length=${contentLength}, rawBodyBytes=${rawLen}).`);
        res.status(400).json({
            error: {
                message: 'Missing JSON body. Send Content-Type: application/json with a payload like {"left":{"isOn":true}}.',
            },
        });
        return;
    }
    const validationResult = DeviceStatusSchema.deepPartial().safeParse(body);
    if (!validationResult.success) {
        logger.error(`Invalid device status update (content-type=${contentType}): ${JSON.stringify(validationResult.error.issues)} body=${JSON.stringify(body)}`);
        res.status(400).json({
            error: 'Invalid request data',
            details: validationResult.error.issues,
        });
        return;
    }
    try {
        await updateDeviceStatus(body);
        res.status(204).end();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`POST /deviceStatus failed: ${message}`);
        res.status(500).json({ error: { message } });
    }
});
export default router;
//# sourceMappingURL=deviceStatus.js.map