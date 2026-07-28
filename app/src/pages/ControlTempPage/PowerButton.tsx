import { Button, Box, Alert } from '@mui/material';
import { DeviceStatusPostError, postDeviceStatus } from '@api/deviceStatus.ts';
import { DeviceStatus } from '@api/deviceStatusSchema.ts';
import { DeepPartial } from 'ts-essentials';
import { useAppStore } from '@state/appStore.tsx';
import { useSettings } from '@api/settings.ts';
import { useState } from 'react';
import { useControlTempStore } from './controlTempStore.tsx';


type PowerButtonProps = {
  isOn: boolean;
  refetch: any;
}

export default function PowerButton({ isOn, refetch }: PowerButtonProps) {
  const { isUpdating, setIsUpdating, side } = useAppStore();
  const { data: settings } = useSettings();
  const deviceStatusStore = useControlTempStore(state => state.deviceStatus);
  const setDeviceStatus = useControlTempStore(state => state.setDeviceStatus);
  const isInAwayMode = settings?.[side].awayMode;
  const disabled = isUpdating || isInAwayMode;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleOnClick = (powerOn: boolean) => {
    setErrorMessage(null);
    // Match schedule power-on: send duration + a temperature so the cover engages
    const targetTemperatureF =
      deviceStatusStore?.[side]?.targetTemperatureF ??
      82;

    const payload: DeepPartial<DeviceStatus> = {
      [side]: powerOn
        ? { isOn: true, targetTemperatureF }
        : { isOn: false },
    };

    setIsUpdating(true);
    setDeviceStatus(payload);
    postDeviceStatus(payload)
      .then(() => {
        // Wait for franken to apply TEMP_LEVEL + TEMP_DURATION before refresh
        return new Promise((resolve) => setTimeout(resolve, 1_500));
      })
      .then(() => refetch())
      .then((result) => {
        if (result?.data) {
          setDeviceStatus(result.data);
          const stillOff = powerOn && !result.data?.[side]?.isOn;
          if (stillOff) {
            setErrorMessage(
              'Command sent, but the pod still reports off. Check free-sleep logs / franken status.'
            );
          }
        }
        // Analyze-sleep progress is shown via AnalyzeSleepBanner (services job status)
      })
      .catch(error => {
        console.error(error);
        let message = 'Failed to update power';
        if (error instanceof DeviceStatusPostError) {
          message = error.message;
        } else if (error instanceof Error) {
          message = error.message;
        }
        setErrorMessage(message);
      })
      .finally(() => {
        setIsUpdating(false);
      });
  };

  if (isInAwayMode) return null;

  return (
    <Box sx={ { mt: -6, display: 'flex', flexDirection: 'column', gap: 2 } }>
      <Button variant="outlined" disabled={ disabled } onClick={ () => handleOnClick(!isOn) }>
        { isOn ? 'Turn off' : 'Turn on' }
      </Button>
      {
        errorMessage && (
          <Alert severity="error" onClose={ () => setErrorMessage(null) }>
            { errorMessage }
          </Alert>
        )
      }
    </Box>
  );
}
