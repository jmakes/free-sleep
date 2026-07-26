import axios from './api';
import { baseURL } from './api';
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


export class DeviceStatusPostError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'DeviceStatusPostError';
    this.status = status;
    this.data = data;
  }
}

/**
 * POST device status updates.
 *
 * Uses fetch (not axios) so the JSON body is always sent with an explicit
 * Content-Type. Empty bodies were reaching the Pod as req.body === undefined,
 * which made power/temp controls silently no-op with HTTP 400.
 */
export const postDeviceStatus = async (deviceStatus: DeepPartial<DeviceStatus>) => {
  if (deviceStatus == null || typeof deviceStatus !== 'object') {
    const error = new Error('postDeviceStatus requires a JSON object body');
    console.error(error, deviceStatus);
    throw error;
  }

  const payload = JSON.stringify(deviceStatus);
  const url = `${baseURL}/api/deviceStatus`;

  // Helpful when debugging from the browser console
  console.debug('POST', url, payload);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    body: payload,
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      try {
        data = await response.text();
      } catch {
        data = null;
      }
    }
    const message =
      (data as { error?: { message?: string } })?.error?.message ||
      (typeof data === 'string' && data) ||
      `POST /deviceStatus failed (${response.status})`;
    throw new DeviceStatusPostError(message, response.status, data);
  }

  // 204 No Content is the normal success response
  return { status: response.status, data: null };
};
