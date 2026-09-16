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
  maxZ?: number;
  sumZ?: number;
  method?: string;
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
      method?: string;
    };
    piezo: {
      rangeThreshold: number;
      rollingSeconds: number;
      thresholdPercent: number;
      description: string;
      personalized?: boolean;
    };
    fusion?: {
      mode: string;
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
      piezo_range_threshold?: number;
      cap_zone_threshold?: number;
      cap_method?: string;
      source?: string;
      poses?: {
        counts?: Record<string, number>;
        separation_z?: Record<string, number>;
        finalized_at?: string;
      };
    } | null;
    capEvaluation?: CapEvaluation | null;
  };
  liveVerdict?: 'likely_occupied' | 'likely_empty' | 'piezo_only' | 'cap_only' | 'unknown';
  error?: string;
};

export type PoseName = 'unoccupied' | 'center' | 'inner' | 'outer';

export type PoseCalibrationStatus = {
  side?: string;
  counts?: Record<PoseName, number>;
  min_reps?: number;
  ready_to_finalize?: boolean;
  missing_poses?: string[];
  updated_at?: string;
  created_at?: string;
};

export type PoseCalibrationResult = {
  ok?: boolean;
  action?: string;
  error?: string;
  status?: PoseCalibrationStatus;
  thresholds?: {
    cap_method?: string;
    cap_zone_threshold?: number;
    piezo_range_threshold?: number;
    separation_z?: Record<string, number>;
  };
  pose?: string;
  rep_index?: number;
  baseline_path?: string;
  sample?: unknown;
};

export const fetchSensorLive = async (side: 'left' | 'right') => {
  const response = await axios.get<SideSensorSnapshot>('/sensors/live', {
    params: { side },
  });
  return response.data;
};

export const fetchPoseCalibrationStatus = async (side: 'left' | 'right') => {
  const response = await axios.get<PoseCalibrationResult>('/sensors/calibrate-pose', {
    params: { side },
  });
  return response.data;
};

export const postPoseCalibration = async (body: {
  side: 'left' | 'right';
  action: 'capture' | 'status' | 'finalize' | 'reset';
  pose?: PoseName;
  seconds?: number;
}) => {
  try {
    const response = await axios.post<PoseCalibrationResult>('/sensors/calibrate-pose', body);
    return response.data;
  } catch (error: unknown) {
    // Surface server error body when present (axios throws on 4xx/5xx)
    const axiosErr = error as {
      response?: { data?: PoseCalibrationResult };
      message?: string;
    };
    if (axiosErr.response?.data && typeof axiosErr.response.data === 'object') {
      return {
        ok: false,
        action: body.action,
        error:
          axiosErr.response.data.error ||
          axiosErr.message ||
          'Calibration request failed',
        status: axiosErr.response.data.status,
      };
    }
    throw error;
  }
};
