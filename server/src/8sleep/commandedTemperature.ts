import { Side } from '../db/schedulesSchema.js';
import { MAX_TEMP_F, MIN_TEMP_F } from '../utils/temperature.js';

/**
 * Last temperature free-sleep commanded to franken, per side.
 *
 * Gesture ±1°F must not use DEVICE_STATUS targetTemperatureF as the baseline:
 * franken stores an integer heat *level* (−100…100), and level↔°F conversion is
 * lossy. Reading back after a set often yields a different °F (e.g. set 59 →
 * read 62), so successive +1 taps look like random multi-degree jumps even
 * though the toast math said "+1".
 *
 * Always increment from the last commanded °F; fall back to hardware only when
 * we have never commanded a target this process lifetime.
 */
const commandedTargetF: Record<Side, number | undefined> = {
  left: undefined,
  right: undefined,
};

export function clampTempF(tempF: number): number {
  return Math.min(MAX_TEMP_F, Math.max(MIN_TEMP_F, Math.round(tempF)));
}

export function getCommandedTargetF(side: Side): number | undefined {
  return commandedTargetF[side];
}

export function setCommandedTargetF(side: Side, tempF: number): number {
  const clamped = clampTempF(tempF);
  commandedTargetF[side] = clamped;
  return clamped;
}

export function clearCommandedTargetF(side: Side): void {
  commandedTargetF[side] = undefined;
}

/**
 * Baseline for a temperature delta: prefer last command, else hardware target.
 */
export function resolveTargetBaselineF(
  side: Side,
  hardwareTargetF: number | undefined,
  fallbackF: number,
): number {
  const commanded = getCommandedTargetF(side);
  if (commanded !== undefined) return commanded;
  if (typeof hardwareTargetF === 'number' && Number.isFinite(hardwareTargetF)) {
    return clampTempF(hardwareTargetF);
  }
  return clampTempF(fallbackF);
}
