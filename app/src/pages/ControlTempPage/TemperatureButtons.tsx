import { useRef, useCallback } from 'react';
import { useTheme } from '@mui/material/styles';
import { Button, Box } from '@mui/material';
import { Add, Remove } from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import { useControlTempStore } from './controlTempStore.tsx';
import { useAppStore } from '@state/appStore.tsx';
import { postDeviceStatus } from '@api/deviceStatus.ts';
import { DeviceStatus } from '@api/deviceStatusSchema.ts';
import { useSettings } from '@api/settings.ts';
import { MIN_TEMP_F, MAX_TEMP_F } from '@lib/temperatureConversions.ts';

type TemperatureButtonsProps = {
  refetch: any;
  currentTargetTemp: number;
}

const DEBOUNCE_MS = 2000;

function clampTargetTempF(tempF: number): number {
  return Math.min(MAX_TEMP_F, Math.max(MIN_TEMP_F, tempF));
}

export default function TemperatureButtons({ refetch, currentTargetTemp }: TemperatureButtonsProps) {
  const { side, setIsUpdating, isUpdating } = useAppStore();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const theme = useTheme();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read latest target from the store at POST time — do not close over deviceStatus
  // from useCallback deps (that was one degree behind after rapid +/- clicks).
  const postUpdate = useCallback(async () => {
    const { deviceStatus } = useControlTempStore.getState();
    const targetTemperatureF = deviceStatus?.[side]?.targetTemperatureF;
    if (targetTemperatureF == null) return;

    const clamped = clampTargetTempF(targetTemperatureF);
    setIsUpdating(true);
    try {
      await postDeviceStatus({
        [side]: { targetTemperatureF: clamped },
      });
      // Keep react-query cache aligned with what we just commanded (like GestureToast).
      queryClient.setQueryData<DeviceStatus>(['useDeviceStatus'], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          [side]: {
            ...prev[side],
            targetTemperatureF: clamped,
          },
        };
      });
      await new Promise(r => setTimeout(r, 1_500));
      await refetch?.();
    } catch (err) {
      console.error(err);
    } finally {
      setIsUpdating(false);
    }
  }, [side, refetch, setIsUpdating, queryClient]);

  const scheduleUpdate = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void postUpdate();
    }, DEBOUNCE_MS);
  }, [postUpdate]);

  const isInAwayMode = settings?.[side].awayMode;
  if (isInAwayMode) return null;

  const disabled = isUpdating || isInAwayMode;
  const borderColor = theme.palette.grey[800];
  const iconColor = theme.palette.grey[500];

  const handleClick = (change: number) => {
    const { deviceStatus } = useControlTempStore.getState();
    if (!deviceStatus) return;

    const next = clampTargetTempF(deviceStatus[side].targetTemperatureF + change);
    useControlTempStore.getState().setDeviceStatus({
      [side]: { targetTemperatureF: next },
    });

    scheduleUpdate();
  };

  const buttonStyle = {
    borderWidth: '2px',
    borderColor,
    width: 50,
    height: 50,
    borderRadius: '50%',
    minWidth: 0,
    padding: 0,
  };

  return (
    <Box
      sx={ {
        top: '75%',
        position: 'absolute',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '100px',
        width: '100%',
        marginLeft: 'auto',
        marginRight: 'auto',
      } }
    >
      <Button
        variant="outlined"
        color="primary"
        sx={ buttonStyle }
        onClick={ () => handleClick(-1) }
        disabled={ disabled || currentTargetTemp <= MIN_TEMP_F }
      >
        <Remove sx={ { color: iconColor } }/>
      </Button>
      <Button
        variant="outlined"
        sx={ buttonStyle }

        onClick={ () => handleClick(1) }
        disabled={ disabled || currentTargetTemp >= MAX_TEMP_F }
      >
        <Add sx={ { color: iconColor } }/>
      </Button>
    </Box>
  );
}
