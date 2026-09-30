import axios from './api';
import { useQuery } from '@tanstack/react-query';
import { SnoreRecord } from '../../../server/src/db/snoreRecordSchema.ts';
export type { SnoreRecord };

interface SnoreQueryParams {
  startTime?: string;
  endTime?: string;
  side?: 'left' | 'right';
}

/** Per-minute piezo snore heuristic timeline (GET /api/metrics/snore). */
export const useSnoreRecords = (params?: SnoreQueryParams, enabled = true) => {
  return useQuery<SnoreRecord[]>({
    queryKey: ['useSnoreRecords', params],
    queryFn: async () => {
      const queryParams = new URLSearchParams();

      if (params?.startTime) queryParams.append('startTime', params.startTime);
      if (params?.endTime) queryParams.append('endTime', params.endTime);
      if (params?.side) queryParams.append('side', params.side);

      const response = await axios.get<SnoreRecord[]>(`/metrics/snore?${queryParams.toString()}`);
      return response.data;
    },
    enabled,
  });
};
