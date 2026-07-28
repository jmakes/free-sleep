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
  error?: string;
};

export const fetchSensorLive = async (side: 'left' | 'right') => {
  const response = await axios.get<SideSensorSnapshot>('/sensors/live', {
    params: { side },
  });
  return response.data;
};
