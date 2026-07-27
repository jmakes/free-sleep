import logger from '../logger.js';
import { Gesture, GestureSchema } from '../db/settingsSchema.js';
import { Side } from '../db/schedulesSchema.js';

/**
 * Pod 4 DEVICE_STATUS (observed on hardware):
 *
 *   doubleTap / tripleTap / quadTap = {"l":TS,"r":TS,"s":0}
 *     - l/r are last-event Unix timestamps (0 = never on that side)
 *     - s is always 0 in samples — not used for single-tap
 *
 *   dismissAlarm = {"l":TS,"r":TS,"s":0}
 *     - Present, but does NOT update on normal single-taps (stays frozen)
 *     - Likely only for OEM alarm-dismiss while an alarm is ringing
 *     - NOT used as singleTap input (would be a false signal)
 *
 * There is no singleTap key and no field that increments on a normal single tap.
 * Free-sleep therefore cannot receive single-tap for temp control on Pod 4.
 */
export const GESTURE_FIELD_ALIASES: Record<Gesture, string[]> = {
  // Kept for completeness if a future firmware adds a real field
  singleTap: [
    'singleTap',
    'single_tap',
    'single',
    'oneTap',
    'one_tap',
  ],
  doubleTap: ['doubleTap', 'double_tap', 'double'],
  tripleTap: ['tripleTap', 'triple_tap', 'triple'],
  quadTap: ['quadTap', 'quad_tap', 'quad', 'quadrupleTap', 'quadruple_tap'],
};

export type SideTapCounters = Partial<Record<Gesture, number>>;

export type GestureFieldSnapshot = {
  timestamp: string;
  allKeys: string[];
  tapLikeKeys: Record<string, string>;
  left: SideTapCounters;
  right: SideTapCounters;
  resolvedAliases: Partial<Record<Gesture, string>>;
  sChannel: { doubleTap?: number; tripleTap?: number; quadTap?: number };
  /** Explicit note for API consumers */
  singleTapSupported: boolean;
  singleTapNote: string;
};

let lastSnapshot: GestureFieldSnapshot | null = null;
let loggedDiscovery = false;

export function getLastGestureFieldSnapshot(): GestureFieldSnapshot | null {
  return lastSnapshot;
}

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
 * Extract left/right multi-tap last-event timestamps from DEVICE_STATUS.
 * Does not invent single-tap from dismissAlarm (stale / alarm-only on Pod 4).
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
  if (rawMap.dismissAlarm !== undefined) {
    tapLikeKeys.dismissAlarm = rawMap.dismissAlarm;
  }

  for (const gesture of GestureSchema.options) {
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

  // Only map a real singleTap-named field if firmware ever adds one
  for (const alias of GESTURE_FIELD_ALIASES.singleTap) {
    const raw = rawMap[alias];
    if (raw === undefined) continue;
    const counters = parseSideCounters(raw);
    if (!counters) continue;
    left.singleTap = counters.l;
    right.singleTap = counters.r;
    resolvedAliases.singleTap = alias;
    break;
  }

  const singleTapSupported = resolvedAliases.singleTap !== undefined;

  const snapshot: GestureFieldSnapshot = {
    timestamp: new Date().toISOString(),
    allKeys: Object.keys(rawMap).sort(),
    tapLikeKeys,
    left,
    right,
    resolvedAliases,
    sChannel,
    singleTapSupported,
    singleTapNote: singleTapSupported
      ? `Single-tap field: ${resolvedAliases.singleTap}`
      : 'Pod 4 dac/DEVICE_STATUS does not report normal single-taps. ' +
        'dismissAlarm stays frozen during idle single-taps (OEM snooze is likely cover-local while an alarm rings). ' +
        'Use double/triple/quad for free-sleep control.',
  };

  lastSnapshot = snapshot;

  if (!loggedDiscovery) {
    loggedDiscovery = true;
    logger.info(
      `Gesture field discovery: multiTap aliases=${JSON.stringify(resolvedAliases)} ` +
      `dismissAlarm=${rawMap.dismissAlarm ?? '(none)'}`
    );
    if (!singleTapSupported) {
      logger.warn(snapshot.singleTapNote);
    }
  }

  return snapshot;
}
