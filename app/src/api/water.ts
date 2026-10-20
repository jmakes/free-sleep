import axios from './api';
import { useQuery } from '@tanstack/react-query';
import type { WaterStatus } from '@lib/waterStatus.ts';

export const useWaterStatus = () => useQuery<WaterStatus>({
  queryKey: ['useWaterStatus'],
  queryFn: async () => {
    const response = await axios.get<WaterStatus>('/water');
    return response.data;
  },
  refetchInterval: 60_000,
});
