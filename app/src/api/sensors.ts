import axios from './api';

export type CapReading = {
  ts: string;
  out: number;
  cen: number;
  in: number;
  status?: string;
};

export type PiezoReading = {
  ts: string;
  channel: '1' | '2';
  avg: number;
  min: number;
  max: number;
  range: number;
  sampleCount: number;
  rangeThreshold?: number;
  aboveThreshold?: boolean;
};

export type CapZoneEval = {
  value: number;
  mean: number;
  std: number;
  zScore: number;
  emptyLow: number;
  emptyHigh: number;
  aboveEmptyBand: boolean;
};

export type CapEvaluation = {
  zones: {
    out: CapZoneEval;
    cen: CapZoneEval;
    in: CapZoneEval;
  };
  combinedZ: number;
  occupancyThreshold: number;
  aboveThreshold: boolean;
  note?: string;
};

export type CapBaselineZone = {
  mean: number;
  std: number;
};

export type SideSensorSnapshot = {
  side: 'left' | 'right';
  timestamp: string;
  sourceFile?: string;
  fileMtime?: string;
  cap?: CapReading;
  piezo1?: PiezoReading;
  piezo2?: PiezoReading;
  otherCap?: CapReading;
  recordsInTail?: number;
  thresholds?: {
    cap: {
      occupancyThreshold: number;
      rollingSeconds: number;
      thresholdPercent: number;
      description: string;
    };
    piezo: {
      rangeThreshold: number;
      rollingSeconds: number;
      thresholdPercent: number;
      description: string;
    };
  };
  calibration?: {
    missing?: boolean;
    hint?: string | null;
    capBaseline?: {
      path?: string;
      mtime?: string;
      zones: {
        out: CapBaselineZone;
        cen: CapBaselineZone;
        in: CapBaselineZone;
      };
    } | null;
    capEvaluation?: CapEvaluation | null;
  };
  liveVerdict?: 'likely_occupied' | 'likely_empty' | 'piezo_only' | 'cap_only' | 'unknown';
  error?: string;
};

export const fetchSensorLive = async (side: 'left' | 'right') => {
  const response = await axios.get<SideSensorSnapshot>('/sensors/live', {
    params: { side },
  });
  return response.data;
};
