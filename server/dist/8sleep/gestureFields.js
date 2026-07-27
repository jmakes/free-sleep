import logger from '../logger.js';
import { GestureSchema } from '../db/settingsSchema.js';
/**
 * OEM / firmware may use different key names for the same multi-tap counters.
 * Single-tap (OEM: snooze) is especially inconsistent across firmware revisions.
 */
export const GESTURE_FIELD_ALIASES = {
    singleTap: [
        'singleTap',
        'single_tap',
        'single',
        'tap',
        'Tap',
        'oneTap',
        'one_tap',
        'tapCount',
        'coverTap',
        'cover_tap',
        'alarmTap',
        'alarm_tap',
        'snoozeTap',
        'snooze_tap',
    ],
    doubleTap: ['doubleTap', 'double_tap', 'double'],
    tripleTap: ['tripleTap', 'triple_tap', 'triple'],
    quadTap: ['quadTap', 'quad_tap', 'quad', 'quadrupleTap', 'quadruple_tap'],
};
/** Side-specific integer counters sometimes appear instead of JSON {l,r} blobs */
const SIDE_SPECIFIC_SINGLE_ALIASES = {
    left: ['leftTap', 'left_tap', 'leftSingleTap', 'left_single_tap', 'lTap', 'LTap'],
    right: ['rightTap', 'right_tap', 'rightSingleTap', 'right_single_tap', 'rTap', 'RTap'],
};
let lastSnapshot = null;
let loggedDiscovery = false;
export function getLastGestureFieldSnapshot() {
    return lastSnapshot;
}
/**
 * Split DEVICE_STATUS text into key/value pairs.
 * Handles both `key = value` and `key=value`.
 */
export function parseDeviceStatusLines(response) {
    const result = {};
    for (const rawLine of response.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        let sep = ' = ';
        let idx = line.indexOf(sep);
        if (idx === -1) {
            sep = '=';
            idx = line.indexOf(sep);
        }
        if (idx === -1)
            continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + sep.length).trim();
        if (key)
            result[key] = value;
    }
    return result;
}
function parseSideCounters(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const l = Number(parsed.l ?? parsed.left ?? parsed.L ?? parsed.Left);
        const r = Number(parsed.r ?? parsed.right ?? parsed.R ?? parsed.Right);
        if (!Number.isFinite(l) || !Number.isFinite(r))
            return null;
        return { l, r };
    }
    catch {
        return null;
    }
}
function isTapLikeKey(key) {
    return /tap|gesture|snooze|click/i.test(key);
}
/**
 * Extract left/right gesture counters from a raw DEVICE_STATUS key map.
 */
export function extractGestureCounters(rawMap) {
    const left = {};
    const right = {};
    const resolvedAliases = {};
    const tapLikeKeys = {};
    for (const [key, value] of Object.entries(rawMap)) {
        if (isTapLikeKey(key)) {
            tapLikeKeys[key] = value;
        }
    }
    for (const gesture of GestureSchema.options) {
        for (const alias of GESTURE_FIELD_ALIASES[gesture]) {
            const raw = rawMap[alias];
            if (raw === undefined)
                continue;
            const counters = parseSideCounters(raw);
            if (!counters) {
                // Plain integer → treat as unknown-side; skip (use side-specific keys below)
                if (/^-?\d+$/.test(raw.trim()) && gesture === 'singleTap') {
                    // Ambiguous which side; ignore here
                    continue;
                }
                continue;
            }
            left[gesture] = counters.l;
            right[gesture] = counters.r;
            resolvedAliases[gesture] = alias;
            break;
        }
    }
    // Side-specific single-tap integers (OEM alarm-snooze style fields)
    for (const side of ['left', 'right']) {
        if (left.singleTap !== undefined && side === 'left')
            continue;
        if (right.singleTap !== undefined && side === 'right')
            continue;
        for (const alias of SIDE_SPECIFIC_SINGLE_ALIASES[side]) {
            const raw = rawMap[alias];
            if (raw === undefined)
                continue;
            const value = Number(raw);
            if (!Number.isFinite(value))
                continue;
            if (side === 'left')
                left.singleTap = value;
            else
                right.singleTap = value;
            if (!resolvedAliases.singleTap)
                resolvedAliases.singleTap = alias;
            break;
        }
    }
    // Last-resort: any unused tap-like JSON blob with {l,r} that wasn't mapped
    if (left.singleTap === undefined && right.singleTap === undefined) {
        for (const [key, value] of Object.entries(tapLikeKeys)) {
            const known = Object.values(resolvedAliases).includes(key);
            if (known)
                continue;
            const counters = parseSideCounters(value);
            if (!counters)
                continue;
            // Prefer keys that look "single" over double/triple/quad
            if (/double|triple|quad|multi/i.test(key))
                continue;
            left.singleTap = counters.l;
            right.singleTap = counters.r;
            resolvedAliases.singleTap = key;
            logger.info(`Mapped unknown tap-like field "${key}" → singleTap`);
            break;
        }
    }
    const snapshot = {
        timestamp: new Date().toISOString(),
        allKeys: Object.keys(rawMap).sort(),
        tapLikeKeys,
        left,
        right,
        resolvedAliases,
    };
    lastSnapshot = snapshot;
    if (!loggedDiscovery) {
        loggedDiscovery = true;
        logger.info(`Gesture field discovery: tapLikeKeys=${JSON.stringify(tapLikeKeys)} resolved=${JSON.stringify(resolvedAliases)}`);
        if (!resolvedAliases.singleTap) {
            logger.warn('No single-tap field found in DEVICE_STATUS. Single-tap actions will not fire until firmware exposes a counter. ' +
                'Check GET /api/gestures/probe after tapping the cover.');
        }
        else {
            logger.info(`Single-tap field resolved via alias "${resolvedAliases.singleTap}"`);
        }
    }
    return snapshot;
}
//# sourceMappingURL=gestureFields.js.map