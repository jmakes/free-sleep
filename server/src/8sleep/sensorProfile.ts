import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import config from '../config.js';
import { Side } from '../db/schedulesSchema.js';
import logger from '../logger.js';

/** Defaults mirrored from biometrics/sleep_detection/presence_config.py */
export const DEFAULT_CAP_ZONE_THRESHOLD = 2.0;
export const DEFAULT_PIEZO_RANGE_THRESHOLD = 50_000;
export const MIN_PIEZO_FLOOR = 5_000;
export const MAX_PIEZO_FLOOR = 500_000;
export const MIN_CAP_Z = 0.5;
export const MAX_CAP_Z = 10;

export type SensorThresholds = {
  side: Side;
  exists: boolean;
  path: string;
  mtime: string | null;
  capZoneThreshold: number;
  piezoRangeThreshold: number;
  capMethod: string;
  source: string | null;
  manualOverrideAt: string | null;
  personalized: boolean;
};

export type SensorThresholdPatch = {
  capZoneThreshold?: number;
  piezoRangeThreshold?: number;
};

function baselinePath(side: Side): string {
  return path.join(config.dbFolder, `${side}_cap_baseline.json`);
}

function readProfile(side: Side): Record<string, unknown> | null {
  const filePath = baselinePath(side);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return typeof data === 'object' && data !== null ? data as Record<string, unknown> : null;
  } catch (error) {
    logger.warn(`Failed reading sensor profile for ${side}: ${error}`);
    return null;
  }
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function getSensorThresholds(side: Side): SensorThresholds {
  const filePath = baselinePath(side);
  const profile = readProfile(side);
  const exists = profile !== null;
  let mtime: string | null = null;
  if (existsSync(filePath)) {
    try {
      mtime = statSync(filePath).mtime.toISOString();
    } catch {
      mtime = null;
    }
  }
  const capZoneThreshold = exists
    ? num(profile?.cap_zone_threshold, DEFAULT_CAP_ZONE_THRESHOLD)
    : DEFAULT_CAP_ZONE_THRESHOLD;
  const piezoRangeThreshold = exists
    ? Math.max(MIN_PIEZO_FLOOR, Math.round(num(profile?.piezo_range_threshold, DEFAULT_PIEZO_RANGE_THRESHOLD)))
    : DEFAULT_PIEZO_RANGE_THRESHOLD;
  const capMethod = typeof profile?.cap_method === 'string' ? profile.cap_method : 'max_z';
  const source = typeof profile?.source === 'string' ? profile.source : null;
  const manualOverrideAt =
    typeof profile?.manual_override_at === 'string' ? profile.manual_override_at : null;
  const personalized = Boolean(
    profile?.piezo_range_threshold != null || profile?.poses || source === 'manual',
  );
  return {
    side,
    exists,
    path: filePath,
    mtime,
    capZoneThreshold,
    piezoRangeThreshold,
    capMethod,
    source,
    manualOverrideAt,
    personalized,
  };
}

/**
 * Patch cap/piezo thresholds on the side baseline file.
 * Marks source=manual; next auto/guided cal overwrites these keys.
 */
export function patchSensorThresholds(side: Side, patch: SensorThresholdPatch): SensorThresholds {
  const filePath = baselinePath(side);
  const existing = readProfile(side);
  if (!existing) {
    throw new Error(
      `No ${side} calibration baseline yet. Run guided Sensors calibration or empty-bed cal first.`,
    );
  }

  const next = { ...existing };
  if (patch.capZoneThreshold !== undefined) {
    const v = Number(patch.capZoneThreshold);
    if (!Number.isFinite(v) || v < MIN_CAP_Z || v > MAX_CAP_Z) {
      throw new Error(`capZoneThreshold must be between ${MIN_CAP_Z} and ${MAX_CAP_Z}`);
    }
    next.cap_zone_threshold = Math.round(v * 1000) / 1000;
  }
  if (patch.piezoRangeThreshold !== undefined) {
    const v = Math.round(Number(patch.piezoRangeThreshold));
    if (!Number.isFinite(v) || v < MIN_PIEZO_FLOOR || v > MAX_PIEZO_FLOOR) {
      throw new Error(`piezoRangeThreshold must be between ${MIN_PIEZO_FLOOR} and ${MAX_PIEZO_FLOOR}`);
    }
    next.piezo_range_threshold = v;
  }

  next.source = 'manual';
  next.manual_override_at = new Date().toISOString();
  next.version = typeof next.version === 'number' ? next.version : 2;
  if (!next.cap_method) next.cap_method = 'max_z';

  const folder = path.dirname(filePath);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 4)}\n`, 'utf8');
  logger.info(
    `Manual threshold override for ${side}: cap_z=${next.cap_zone_threshold} piezo=${next.piezo_range_threshold}`,
  );
  return getSensorThresholds(side);
}
