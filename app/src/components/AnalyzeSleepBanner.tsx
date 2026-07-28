import { Alert, CircularProgress, Box } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import axios from '@api/api.ts';
import { Services } from '@api/services.ts';
import { useSettings } from '@api/settings.ts';
import { Side } from '@state/appStore.tsx';

/**
 * Global banner while sleep analysis is running for either side.
 * Polls services; Node marks jobs "started" when analysis launches, Python
 * sets healthy/failed when finished.
 */
export default function AnalyzeSleepBanner() {
  const { data: settings } = useSettings();

  const { data: services } = useQuery<Services>({
    queryKey: ['useServices'],
    queryFn: async () => {
      const response = await axios.get<Services>('/services');
      return response.data;
    },
    // Always share cache with useServices; poll faster while analyzing
    refetchInterval: (query) => {
      const data = query.state.data;
      const left = data?.biometrics?.jobs?.analyzeSleepLeft?.status;
      const right = data?.biometrics?.jobs?.analyzeSleepRight?.status;
      return left === 'started' || right === 'started' ? 3_000 : false;
    },
  });

  const leftStatus = services?.biometrics?.jobs?.analyzeSleepLeft?.status;
  const rightStatus = services?.biometrics?.jobs?.analyzeSleepRight?.status;
  const leftMessage = services?.biometrics?.jobs?.analyzeSleepLeft?.message;
  const rightMessage = services?.biometrics?.jobs?.analyzeSleepRight?.message;

  const runningSides: Side[] = [];
  if (leftStatus === 'started') runningSides.push('left');
  if (rightStatus === 'started') runningSides.push('right');

  if (runningSides.length === 0) return null;

  const labels = runningSides.map((side) => {
    const name = settings?.[side]?.name?.trim();
    return name || (side === 'left' ? 'Left' : 'Right');
  });

  const detail =
    runningSides.length === 1
      ? (runningSides[0] === 'left' ? leftMessage : rightMessage)
      : undefined;

  const message =
    runningSides.length === 2
      ? `Analyzing sleep for ${labels[0]} and ${labels[1]}… This can take several minutes.`
      : detail && detail.length > 0
        ? detail
        : `Analyzing sleep for ${labels[0]}… This can take several minutes. Results appear under Data → Sleep.`;

  return (
    <Box
      sx={ {
        position: 'fixed',
        top: 8,
        left: 0,
        right: 0,
        zIndex: 1300,
        display: 'flex',
        justifyContent: 'center',
        px: 2,
        pointerEvents: 'none',
      } }
    >
      <Alert
        severity="info"
        variant="filled"
        icon={ <CircularProgress size={ 18 } color="inherit" /> }
        sx={ { maxWidth: 520, width: '100%', pointerEvents: 'auto' } }
      >
        { message }
      </Alert>
    </Box>
  );
}
