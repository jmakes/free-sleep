import _ from 'lodash';
import express from 'express';
import logger from '../../logger.js';
const router = express.Router();
import settingsDB from '../../db/settings.js';
import { GestureSchema, SettingsSchema } from '../../db/settingsSchema.js';
router.get('/settings', async (req, res) => {
    await settingsDB.read();
    res.json(settingsDB.data);
});
router.post('/settings', async (req, res) => {
    const { body } = req;
    const validationResult = SettingsSchema.deepPartial().safeParse(body);
    if (!validationResult.success) {
        logger.error('Invalid settings update:', validationResult.error);
        res.status(400).json({
            error: 'Invalid request data',
            details: validationResult?.error?.errors,
        });
        return;
    }
    delete body.id;
    await settingsDB.read();
    // Tap configs are discriminated unions — replace whole gesture objects instead of
    // deep-merging (which would leave stale fields when switching action types).
    for (const side of ['left', 'right']) {
        const tapsUpdate = body?.[side]?.taps;
        if (tapsUpdate) {
            for (const gesture of GestureSchema.options) {
                if (tapsUpdate[gesture] !== undefined) {
                    settingsDB.data[side].taps[gesture] = tapsUpdate[gesture];
                }
            }
            delete body[side].taps;
            if (body[side] && Object.keys(body[side]).length === 0) {
                delete body[side];
            }
        }
    }
    _.merge(settingsDB.data, body);
    await settingsDB.write();
    res.status(200).json(settingsDB.data);
});
export default router;
//# sourceMappingURL=settings.js.map