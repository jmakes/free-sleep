import { useEffect, useRef, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { fetchRecentGestures, GestureEvent } from '@api/gestures.ts';
import { DeviceStatus } from '@api/deviceStatusSchema.ts';
import { useControlTempStore } from '../pages/ControlTempPage/controlTempStore.tsx';

/**
 * Polls for cover-tap gesture events and shows a brief toast.
 * Applies targetTemperatureF / isOn from the event immediately so the gauge
 * does not wait on (or fight with) a full deviceStatus refetch.
 */
export default function GestureToast() {
  const queryClient = useQueryClient();
  const setDeviceStatus = useControlTempStore((state) => state.setDeviceStatus);
  const lastSeenId = useRef<string | undefined>(undefined);
  const [queue, setQueue] = useState<GestureEvent[]>([]);
  const [current, setCurrent] = useState<GestureEvent | null>(null);

  useEffect(() => {
    let cancelled = false;

    const applyGestureToUi = (event: GestureEvent) => {
      if (event.targetTemperatureF === undefined && event.isOn === undefined) {
        return;
      }
      const sidePatch: Partial<DeviceStatus['left']> = {};
      if (event.targetTemperatureF !== undefined) {
        sidePatch.targetTemperatureF = event.targetTemperatureF;
      }
      if (event.isOn !== undefined) {
        sidePatch.isOn = event.isOn;
      }
      const patch = { [event.side]: sidePatch } as Partial<DeviceStatus>;

      // Immediate gauge / power update (store drives the slider)
      setDeviceStatus(patch);

      // Keep react-query cache in sync so props like currentTargetTemp match
      queryClient.setQueryData<DeviceStatus>(['useDeviceStatus'], (old) => {
        if (!old) return old;
        return {
          ...old,
          [event.side]: {
            ...old[event.side],
            ...sidePatch,
          },
        };
      });
    };

    const poll = async () => {
      try {
        const events = await fetchRecentGestures(lastSeenId.current);
        if (cancelled || events.length === 0) return;

        // events are newest-first; take only new ones and enqueue oldest-first
        const newestFirst = events;
        if (!lastSeenId.current) {
          // First poll: do not spam history; only remember the tip
          lastSeenId.current = newestFirst[0]?.id;
          return;
        }

        const fresh = [...newestFirst].reverse();
        lastSeenId.current = newestFirst[0].id;
        setQueue((prev) => [...prev, ...fresh]);

        for (const event of fresh) {
          applyGestureToUi(event);
        }

        // Delay refetch so franken target level has time to settle; avoids
        // stomping the optimistic target with a stale DEVICE_STATUS read.
        window.setTimeout(() => {
          if (cancelled) return;
          void queryClient.invalidateQueries({ queryKey: ['useDeviceStatus'] });
        }, 1_200);
        if (fresh.some((event) => event.message.includes('schedule') || event.gesture === 'quadTap')) {
          void queryClient.invalidateQueries({ queryKey: ['useSchedules'] });
        }
      } catch {
        // silent — pod may be restarting
      }
    };

    void poll();
    // Poll faster than franken gesture sampling so toasts feel snappy
    const interval = window.setInterval(() => {
      void poll();
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [queryClient, setDeviceStatus]);

  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setCurrent(next);
    setQueue(rest);
  }, [queue, current]);

  const handleClose = () => {
    setCurrent(null);
  };

  return (
    <Snackbar
      open={ Boolean(current) }
      autoHideDuration={ 4_000 }
      onClose={ handleClose }
      anchorOrigin={ { vertical: 'top', horizontal: 'center' } }
    >
      { current ? (
        <Alert
          onClose={ handleClose }
          severity={ current.success ? 'success' : 'warning' }
          variant="filled"
          sx={ { width: '100%' } }
        >
          { current.message }
        </Alert>
      ) : undefined }
    </Snackbar>
  );
}
