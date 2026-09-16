import express, { Request, Response } from 'express';
import { readSideSensorSnapshot } from '../../8sleep/rawSensorReader.js';
import {
  PoseAction,
  PoseName,
  runPoseCalibration,
} from '../../8sleep/poseCalibration.js';
import { Side } from '../../db/schedulesSchema.js';

const router = express.Router();

const POSES: PoseName[] = ['unoccupied', 'center', 'inner', 'outer'];
const ACTIONS: PoseAction[] = ['capture', 'status', 'finalize', 'reset'];

/**
 * Latest cap + piezo snapshot for one side from the Pod .RAW tail.
 * GET /api/sensors/live?side=left|right
 *
 * Only used while the Sensors UI is streaming (client Start/Stop).
 */
router.get('/live', async (req: Request, res: Response) => {
  const sideParam = typeof req.query.side === 'string' ? req.query.side : 'right';
  const side: Side = sideParam === 'left' ? 'left' : 'right';
  try {
    const snapshot = await readSideSensorSnapshot(side);
    res.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      side,
      timestamp: new Date().toISOString(),
      error: message,
    });
  }
});

/**
 * Multi-pose calibration wizard API.
 * GET  /api/sensors/calibrate-pose?side=left|right          → status
 * POST /api/sensors/calibrate-pose
 *   body: { side, action: capture|status|finalize|reset, pose?, seconds? }
 */
router.get('/calibrate-pose', async (req: Request, res: Response) => {
  const sideParam = typeof req.query.side === 'string' ? req.query.side : 'right';
  const side: Side = sideParam === 'left' ? 'left' : 'right';
  try {
    const result = await runPoseCalibration({ side, action: 'status' });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, action: 'status', error: message });
  }
});

router.post('/calibrate-pose', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const side: Side = body.side === 'left' ? 'left' : 'right';
  const action = body.action as PoseAction;
  if (!ACTIONS.includes(action)) {
    res.status(400).json({
      ok: false,
      error: `action must be one of ${ACTIONS.join(', ')}`,
    });
    return;
  }

  let pose: PoseName | undefined;
  if (action === 'capture') {
    if (!POSES.includes(body.pose)) {
      res.status(400).json({
        ok: false,
        error: `pose must be one of ${POSES.join(', ')} for capture`,
      });
      return;
    }
    pose = body.pose;
  }

  const seconds =
    typeof body.seconds === 'number' && body.seconds > 0
      ? Math.min(60, Math.floor(body.seconds))
      : 15;

  try {
    const result = await runPoseCalibration({
      side,
      action,
      pose,
      seconds,
      settle: typeof body.settle === 'number' ? body.settle : 1,
    });
    // Always 200 with ok flag so the UI can show the Python error string
    // instead of a generic axios "status code 400".
    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, action, error: message });
  }
});

export default router;
