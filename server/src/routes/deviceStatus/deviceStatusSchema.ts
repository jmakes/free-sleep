// WARNING! - Any changes here MUST be the same between app/src/api & server/src/db/

import { z } from 'zod';

const SideStatusSchema = z.object({
  currentTemperatureLevel: z.number(),
  currentTemperatureF: z.number(),
  targetTemperatureF: z.number()
    .min(55, { message: 'Temperature must be at least 55°F' })
    .max(110, { message: 'Temperature cannot exceed 110°F' }),
  secondsRemaining: z.number(),
  isOn: z.boolean(),
  isAlarmVibrating: z.boolean(),
  taps: z.object({
    singleTap: z.number().optional(),
    doubleTap: z.number().optional(),
    tripleTap: z.number().optional(),
    quadTap: z.number().optional(),
  }).optional(),
}).strict();


export const DeviceStatusSchema = z.object({
  left: SideStatusSchema,
  right: SideStatusSchema,
  waterLevel: z.string(),
  isPriming: z.boolean(),
  settings: z.object({
    v: z.number(),
    gainLeft: z.number(),
    gainRight: z.number(),
    ledBrightness: z.number(),
  }),
  coverVersion: z.string(),
  hubVersion: z.string(),
  freeSleep: z.object({
    version: z.string(),
    branch: z.string(),
    commit: z.string().optional(),
    githubOwner: z.string().optional(),
    githubRepo: z.string().optional(),
  }),
  wifiStrength: z.number(),
}).strict();

export type SideStatus = z.infer<typeof SideStatusSchema>;
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export enum Version {
  NotFound = 'Version not found',
  Pod3 = 'Pod 3',
  Pod4 = 'Pod 4',
  Pod5 = 'Pod 5',
}
