import express, { Request, Response } from 'express';
import { readSideSensorSnapshot } from '../../8sleep/rawSensorReader.js';
import {
  PoseAction,
  PoseName,
  runPoseCalibration,
} from '../../8sleep/poseCalibration.js';
import {
  getSensorThresholds,
  patchSensorThresholds,
} from '../../8sleep/sensorProfile.js';
import { Side } from '../../db/schedulesSchema.js';

const router = express.Router();

const POSES: PoseName[] = ['unoccupied', 'center', 'inner', 'outer'];
const ACTIONS: PoseAction[] = ['capture', 'status', 'finalize', 'reset'];

function parseSide(value: unknown): Side {
  return value === 'left' ? 'left' : 'right';
}

/**
 * Latest cap + piezo snapshot for one side from the Pod .RAW tail.
 * GET /api/sensors/live?side=left|right
 *
 * Only used while the Sensors UI is streaming (client Start/Stop).
 */
router.get('/live', async (req: Request, res: Response) => {
  const side = parseSide(req.query.side);
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
 * Current presence thresholds from `{side}_cap_baseline.json`.
 * GET /api/sensors/thresholds?side=left|right
 */
router.get('/thresholds', (req: Request, res: Response) => {
  const side = parseSide(req.query.side);
  try {
    res.json(getSensorThresholds(side));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Manual threshold override (cap max-z + piezo floor).
 * PUT /api/sensors/thresholds  body: { side, capZoneThreshold?, piezoRangeThreshold? }
 * Sticks until the next auto or guided calibration overwrites the baseline.
 */
router.put('/thresholds', (req: Request, res: Response) => {
  const body = req.body ?? {};
  const side = parseSide(body.side);
  const patch: { capZoneThreshold?: number; piezoRangeThreshold?: number } = {};
  if (body.capZoneThreshold !== undefined) {
    patch.capZoneThreshold = Number(body.capZoneThreshold);
  }
  if (body.piezoRangeThreshold !== undefined) {
    patch.piezoRangeThreshold = Number(body.piezoRangeThreshold);
  }
  if (patch.capZoneThreshold === undefined && patch.piezoRangeThreshold === undefined) {
    res.status(400).json({
      ok: false,
      error: 'Provide capZoneThreshold and/or piezoRangeThreshold',
    });
    return;
  }
  try {
    const thresholds = patchSensorThresholds(side, patch);
    res.json({ ok: true, thresholds });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /No .* calibration baseline/i.test(message);
    res.status(missing ? 404 : 400).json({ ok: false, error: message });
  }
});

/**
 * Multi-pose calibration wizard API.
 * GET  /api/sensors/calibrate-pose?side=left|right          → status
 * POST /api/sensors/calibrate-pose
 *   body: { side, action: capture|status|finalize|reset, pose?, seconds? }
 */
router.get('/calibrate-pose', async (req: Request, res: Response) => {
  const side = parseSide(req.query.side);
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
