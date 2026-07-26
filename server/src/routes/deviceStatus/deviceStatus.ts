import express, { Request, Response } from 'express';
import { connectFranken } from '../../8sleep/frankenServer.js';
import { DeviceStatus, DeviceStatusSchema } from './deviceStatusSchema.js';
import logger from '../../logger.js';
import { updateDeviceStatus } from './updateDeviceStatus.js';
import { DeepPartial } from 'ts-essentials';

const router = express.Router();


router.get('/deviceStatus', async (req: Request, res: Response) => {
  try {
    const franken = await connectFranken();
    const resp = await franken.getDeviceStatus();
    res.json(resp);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`GET /deviceStatus failed: ${message}`);
    res.status(503).json({ error: { message: `Device status unavailable: ${message}` } });
  }
});


router.post('/deviceStatus', async (req: Request, res: Response) => {
  const body = req.body;
  const contentType = req.headers['content-type'] ?? '(none)';
  const contentLength = req.headers['content-length'] ?? '(none)';

  // Classic failure mode: client/proxy sent no JSON body → body is undefined
  if (body === undefined || body === null) {
    logger.error(
      `POST /deviceStatus missing body (content-type=${contentType}, content-length=${contentLength}). ` +
      'Client must send JSON with Content-Type: application/json.'
    );
    res.status(400).json({
      error: {
        message:
          'Missing JSON body. Send Content-Type: application/json with a payload like {"left":{"isOn":true}}.',
      },
    });
    return;
  }

  const validationResult = DeviceStatusSchema.deepPartial().safeParse(body);
  if (!validationResult.success) {
    logger.error(
      `Invalid device status update (content-type=${contentType}): ${JSON.stringify(validationResult.error.issues)} body=${JSON.stringify(body)}`
    );
    res.status(400).json({
      error: 'Invalid request data',
      details: validationResult.error.issues,
    });
    return;
  }

  try {
    await updateDeviceStatus(body as DeepPartial<DeviceStatus>);
    res.status(204).end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`POST /deviceStatus failed: ${message}`);
    res.status(500).json({ error: { message } });
  }
});


export default router;
