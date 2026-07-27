import logger from '../logger.js';
import { Gesture, GestureSchema } from '../db/settingsSchema.js';
import { Side } from '../db/schedulesSchema.js';

/**
 * OEM / firmware may use different key names for the same multi-tap counters.
 *
 * Pod 4 DEVICE_STATUS (observed):
 *   doubleTap/tripleTap/quadTap = {"l":N,"r":N,"s":N}
 *   where l/r are last-event Unix timestamps (0 = never), not simple +1 counters.
 *   `s` is present but has been 0 in samples so far.
 *   dismissAlarm is a separate key — likely single-tap / alarm-snooze path.
 */
export const GESTURE_FIELD_ALIASES: Record<Gesture, string[]> = {
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
    // OEM alarm snooze / single-tap candidate (present on Pod 4)
    'dismissAlarm',
    'dismiss_alarm',
  ],
  doubleTap: ['doubleTap', 'double_tap', 'double'],
  tripleTap: ['tripleTap', 'triple_tap', 'triple'],
  quadTap: ['quadTap', 'quad_tap', 'quad', 'quadrupleTap', 'quadruple_tap'],
};

/** Side-specific integer counters sometimes appear instead of JSON {l,r} blobs */
const SIDE_SPECIFIC_SINGLE_ALIASES: Record<Side, string[]> = {
  left: ['leftTap', 'left_tap', 'leftSingleTap', 'left_single_tap', 'lTap', 'LTap'],
  right: ['rightTap', 'right_tap', 'rightSingleTap', 'right_single_tap', 'rTap', 'RTap'],
};

export type SideTapCounters = Partial<Record<Gesture, number>>;

export type GestureFieldSnapshot = {
  timestamp: string;
  allKeys: string[];
  /** Keys that look gesture/alarm related (for discovery) */
  tapLikeKeys: Record<string, string>;
  /** Normalized counters / last-event timestamps we extracted */
  left: SideTapCounters;
  right: SideTapCounters;
  /** Alias that supplied each canonical gesture, if any */
  resolvedAliases: Partial<Record<Gesture, string>>;
  /** Raw `s` channel from multi-tap JSON blobs (unknown meaning; logged for discovery) */
  sChannel: { doubleTap?: number; tripleTap?: number; quadTap?: number };
};

let lastSnapshot: GestureFieldSnapshot | null = null;
let loggedDiscovery = false;

export function getLastGestureFieldSnapshot(): GestureFieldSnapshot | null {
  return lastSnapshot;
}

/**
 * Split DEVICE_STATUS text into key/value pairs.
 * Handles both `key = value` and `key=value`.
 */
export function parseDeviceStatusLines(response: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let sep = ' = ';
    let idx = line.indexOf(sep);
    if (idx === -1) {
      sep = '=';
      idx = line.indexOf(sep);
    }
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + sep.length).trim();
    if (key) result[key] = value;
  }
  return result;
}

type ParsedCounters = { l: number; r: number; s: number };

function parseSideCounters(raw: string): ParsedCounters | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;

    const l = Number(parsed.l ?? parsed.left ?? parsed.L ?? parsed.Left ?? 0);
    const r = Number(parsed.r ?? parsed.right ?? parsed.R ?? parsed.Right ?? 0);
    const s = Number(parsed.s ?? parsed.single ?? parsed.S ?? 0);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
    return { l, r, s: Number.isFinite(s) ? s : 0 };
  } catch {
    return null;
  }
}

function isTapLikeKey(key: string): boolean {
  return /tap|gesture|snooze|click|dismiss|alarm/i.test(key);
}

/**
 * Extract left/right gesture event stamps from a raw DEVICE_STATUS key map.
 * Values are often last-event Unix timestamps (0 = never), not +1 counters.
 * Detection still uses next > previous.
 */
export function extractGestureCounters(rawMap: Record<string, string>): GestureFieldSnapshot {
  const left: SideTapCounters = {};
  const right: SideTapCounters = {};
  const resolvedAliases: Partial<Record<Gesture, string>> = {};
  const tapLikeKeys: Record<string, string> = {};
  const sChannel: GestureFieldSnapshot['sChannel'] = {};

  for (const [key, value] of Object.entries(rawMap)) {
    if (isTapLikeKey(key)) {
      tapLikeKeys[key] = value;
    }
  }

  // Always surface dismissAlarm even if empty — critical for single-tap discovery
  if (rawMap.dismissAlarm !== undefined) {
    tapLikeKeys.dismissAlarm = rawMap.dismissAlarm;
  }

  for (const gesture of GestureSchema.options) {
    // singleTap is handled specially below (dismissAlarm + s channel)
    if (gesture === 'singleTap') continue;

    for (const alias of GESTURE_FIELD_ALIASES[gesture]) {
      const raw = rawMap[alias];
      if (raw === undefined) continue;

      const counters = parseSideCounters(raw);
      if (!counters) continue;

      left[gesture] = counters.l;
      right[gesture] = counters.r;
      resolvedAliases[gesture] = alias;

      if (gesture === 'doubleTap' || gesture === 'tripleTap' || gesture === 'quadTap') {
        sChannel[gesture] = counters.s;
      }
      break;
    }
  }

  // --- singleTap resolution (priority order) ---

  // 1) Explicit singleTap-like keys / dismissAlarm with {l,r} or {l,r,s}
  for (const alias of GESTURE_FIELD_ALIASES.singleTap) {
    const raw = rawMap[alias];
    if (raw === undefined) continue;

    const counters = parseSideCounters(raw);
    if (counters) {
      left.singleTap = counters.l;
      right.singleTap = counters.r;
      resolvedAliases.singleTap = alias;
      break;
    }

    // Plain integer event stamp (side unknown) — apply to both so either side can fire
    if (/^-?\d+$/.test(raw.trim())) {
      const value = Number(raw.trim());
      left.singleTap = value;
      right.singleTap = value;
      resolvedAliases.singleTap = `${alias}(scalar)`;
      break;
    }
  }

  // 2) Side-specific integer fields
  if (left.singleTap === undefined || right.singleTap === undefined) {
    for (const side of ['left', 'right'] as Side[]) {
      if (side === 'left' && left.singleTap !== undefined) continue;
      if (side === 'right' && right.singleTap !== undefined) continue;

      for (const alias of SIDE_SPECIFIC_SINGLE_ALIASES[side]) {
        const raw = rawMap[alias];
        if (raw === undefined) continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        if (side === 'left') left.singleTap = value;
        else right.singleTap = value;
        if (!resolvedAliases.singleTap) resolvedAliases.singleTap = alias;
        break;
      }
    }
  }

  // 3) Use the `s` channel from multi-tap blobs as single-tap stamps if non-zero / changing
  //    Observed shape: doubleTap={"l":0,"r":TS,"s":0}. If firmware ever stamps single taps
  //    into `s`, we pick it up here (prefer doubleTap's s, then triple, then quad).
  if (left.singleTap === undefined && right.singleTap === undefined) {
    const sCandidates = [sChannel.doubleTap, sChannel.tripleTap, sChannel.quadTap];
    const sValue = sCandidates.find((value) => value !== undefined);
    if (sValue !== undefined) {
      // `s` is a single shared channel in the blob — mirror to both sides.
      // processGestures will only fire the side whose stamp increased.
      left.singleTap = sValue;
      right.singleTap = sValue;
      resolvedAliases.singleTap = 's-channel(from multi-tap JSON)';
    }
  }

  const snapshot: GestureFieldSnapshot = {
    timestamp: new Date().toISOString(),
    allKeys: Object.keys(rawMap).sort(),
    tapLikeKeys,
    left,
    right,
    resolvedAliases,
    sChannel,
  };

  lastSnapshot = snapshot;

  if (!loggedDiscovery) {
    loggedDiscovery = true;
    logger.info(
      `Gesture field discovery: tapLikeKeys=${JSON.stringify(tapLikeKeys)} ` +
      `resolved=${JSON.stringify(resolvedAliases)} sChannel=${JSON.stringify(sChannel)}`
    );
    if (!resolvedAliases.singleTap) {
      logger.warn(
        'No single-tap field found yet. On Pod 4, multi-tap uses doubleTap/tripleTap/quadTap ' +
        'with {l,r,s} timestamps. dismissAlarm is present — watch it via GET /api/gestures/probe ' +
        'while single-tapping. OEM alarm-snooze may only update fields while an alarm is ringing.'
      );
    } else {
      logger.info(`Single-tap field resolved via "${resolvedAliases.singleTap}"`);
    }
  }

  return snapshot;
}
