import SearchIcon from '@mui/icons-material/Search';
import { Button, Box, Alert } from '@mui/material';
import { DeviceStatusPostError, postDeviceStatus } from '@api/deviceStatus.ts';
import { DeviceStatus } from '@api/deviceStatusSchema.ts';
import { DeepPartial } from 'ts-essentials';
import { useAppStore } from '@state/appStore.tsx';
import { useSettings } from '@api/settings.ts';
import { useState } from 'react';
import { useServices } from '@api/services.ts';
import { Job, postJobs } from '@api/jobs.ts';
import AnalyzeSleepNotification from './AnalyzeSleepNotification.tsx';
import { useControlTempStore } from './controlTempStore.tsx';


type PowerButtonProps = {
  isOn: boolean;
  refetch: any;
}

export default function PowerButton({ isOn, refetch }: PowerButtonProps) {
  const { isUpdating, setIsUpdating, side } = useAppStore();
  const { data: settings } = useSettings();
  const { data: services } = useServices();
  const deviceStatusStore = useControlTempStore(state => state.deviceStatus);
  const setDeviceStatus = useControlTempStore(state => state.setDeviceStatus);
  const isInAwayMode = settings?.[side].awayMode;
  const disabled = isUpdating || isInAwayMode;
  const [showAnalyzeSleep, setShowAnalyzeSleep] = useState(false);
  const [showAnalyzeNotification, setShowAnalyzeNotification] = useState(false);
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
    if (powerOn) {
      setShowAnalyzeSleep(false);
    } else {
      setShowAnalyzeSleep(true);
      setTimeout(() => setShowAnalyzeSleep(false), 20_000);
    }

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

  const handleAnalyzeSleep = () => {
    const capitalized = side.charAt(0).toUpperCase() + side.slice(1) as Job;
    setShowAnalyzeNotification(true);
    // @ts-expect-error
    postJobs([`analyzeSleep${capitalized}`])
      .catch(error => {
        console.error(error);
      });
    setTimeout(() => setShowAnalyzeNotification(false), 120_000);
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
      {
        showAnalyzeSleep && !isUpdating && services?.biometrics?.enabled && (
          <Button
            variant="contained"
            disabled={ disabled }
            onClick={ handleAnalyzeSleep }
          >
            <SearchIcon />
            Analyze sleep
          </Button>
        )
      }
      {
        showAnalyzeNotification && (
          <AnalyzeSleepNotification />
        )
      }
    </Box>
  );
}
