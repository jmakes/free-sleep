import axios from './api';
import { useQuery } from '@tanstack/react-query';

export type GestureEvent = {
  id: string;
  timestamp: string;
  side: 'left' | 'right';
  gesture: 'singleTap' | 'doubleTap' | 'tripleTap' | 'quadTap';
  message: string;
  success: boolean;
};

export const fetchRecentGestures = async (sinceId?: string) => {
  const response = await axios.get<{ events: GestureEvent[] }>('/gestures/recent', {
    params: sinceId ? { sinceId } : undefined,
  });
  return response.data.events;
};

export const useRecentGestures = (enabled = true) => useQuery({
  queryKey: ['useRecentGestures'],
  queryFn: () => fetchRecentGestures(),
  refetchInterval: enabled ? 2_000 : false,
  enabled,
});
