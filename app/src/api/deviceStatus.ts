import axios from './api';
import { useQuery } from '@tanstack/react-query';
import { DeepPartial } from 'ts-essentials';
import { DeviceStatus } from './deviceStatusSchema';


export const getDeviceStatus = async () => {
  return axios.get<DeviceStatus>('/deviceStatus');
};

export const useDeviceStatus = () => useQuery<DeviceStatus>({
  queryKey: ['useDeviceStatus'],
  queryFn: async () => {
    const response = await getDeviceStatus();
    return response.data;
  },
  refetchInterval: 30_000,
});


export const postDeviceStatus = (deviceStatus: DeepPartial<DeviceStatus>) => {
  // Guard: axios omits the request body when data is undefined, which produces
  // "expected object, received undefined" on the server (power/temp no-ops).
  if (deviceStatus == null || typeof deviceStatus !== 'object') {
    const error = new Error('postDeviceStatus requires a JSON object body');
    console.error(error, deviceStatus);
    return Promise.reject(error);
  }

  // Explicit Content-Type + stringify so proxies / service workers cannot
  // "forget" the body (seen as empty POSTs → 400 on the Pod).
  return axios.post('/deviceStatus', deviceStatus, {
    headers: {
      'Content-Type': 'application/json',
    },
    transformRequest: [
      (data, headers) => {
        headers.set('Content-Type', 'application/json');
        return JSON.stringify(data);
      },
    ],
  });
};
