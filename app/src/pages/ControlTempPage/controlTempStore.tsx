import _ from 'lodash';
import { create } from 'zustand';
import { DeepPartial } from 'ts-essentials';
import { DeviceStatus } from '@api/deviceStatusSchema.ts';


type ControlTempStore = {
  deviceStatus: DeviceStatus | undefined;
  setDeviceStatus: (newDeviceStatus: DeepPartial<DeviceStatus> | DeviceStatus) => void;
};

export const useControlTempStore = create<ControlTempStore>((set, get) => ({
  deviceStatus: undefined,
  setDeviceStatus: (newDeviceStatus) => {
    const { deviceStatus } = get();
    // Never mutate existing state / react-query objects in place
    const updatedDeviceStatus = _.merge({}, deviceStatus ?? {}, newDeviceStatus) as DeviceStatus;
    set({ deviceStatus: updatedDeviceStatus });
  },
}));
