import InfoIcon from '@mui/icons-material/Info';
import {
  Box,
  CircularProgress,
  FormControlLabel,
  Typography,
  Switch,
  Divider,
} from '@mui/material';
import Section from '../Section.tsx';
import { Services, useServices, postServices } from '@api/services.ts';
import { useSettings } from '@api/settings.ts';
import { useAppStore } from '@state/appStore.tsx';
import { DeepPartial } from 'ts-essentials';
import { postJobs } from '@api/jobs.ts';
import Button from '@mui/material/Button';

export default function FeaturesSection() {
  const { data: services, refetch, isLoading } = useServices();
  const { data: settings, refetch: refetchSettings } = useSettings();
  const setIsUpdating = useAppStore(state => state.setIsUpdating);
  const isUpdating = useAppStore(state => state.isUpdating);
  const side = useAppStore(state => state.side);

  const updateServices = (services: DeepPartial<Services>) => {
    setIsUpdating(true);

    postServices(services)
      .then(() => refetch())
      .catch(error => {
        console.error(error);
      })
      .finally(() => setIsUpdating(false));
  };

  if (isLoading || !services || !settings) return <CircularProgress />;

  const sideAutoCal = Boolean(settings[side]?.autoPresenceCalibration?.enabled);
  const leftOn = Boolean(settings.left?.autoPresenceCalibration?.enabled);
  const rightOn = Boolean(settings.right?.autoPresenceCalibration?.enabled);

  return (
    <Section title='Features'>
      <FormControlLabel
        control={
          <Switch
            disabled={ isUpdating || services?.biometrics.jobs.installation.status !== 'healthy' }
            checked={ services.biometrics.enabled }
            onChange={ (event) => updateServices({ biometrics: { enabled: event.target.checked } }) }
          />
        }
        label="Biometrics"
      />
      <Box display='flex' gap={ 1 }>

        <InfoIcon sx={ { color: 'text.secondary' } }/>

        <Typography color='text.secondary'>
          Calculate biometrics for the pod.
          Requires you to run this command on your pod. Once installation completes successfully, you can toggle this on/off.
          <Typography color='text.secondary' sx={ { fontFamily: 'monospace' } }>
            sh /home/dac/free-sleep/scripts/enable_biometrics.sh
          </Typography>
        </Typography>

      </Box>
      <br />
      <FormControlLabel
        control={
          <Switch
            disabled={ isUpdating }
            checked={ services.sentryLogging.enabled }
            onChange={ (event) => updateServices({ sentryLogging: { enabled: event.target.checked } }) }
          />
        }
        label="Enable Sentry error reporting"
      />
      <Typography color='text.secondary'>
        Help improve stability by sending anonymous error reports to the free-sleep maintainers.
      </Typography>

      <Divider sx={ { my: 2 } }/>
      <Typography variant="subtitle1" sx={ { fontWeight: 600 } }>
        Beta
      </Typography>
      <Typography color='text.secondary' variant="body2" sx={ { mb: 1 } }>
        Auto presence calibration is per-side under Side settings
        (left: { leftOn ? 'on' : 'off' }, right: { rightOn ? 'on' : 'off' }).
        Weekly Wed 3pm, 14-day schedule prior, 35% blend, piezo floor ≥50k.
        Away mode uses a strong empty prior. Manual guided calibration still wins.
      </Typography>
      <Button
        size="small"
        variant="outlined"
        disabled={ isUpdating || !sideAutoCal || !services.biometrics.enabled }
        onClick={ () => {
          const job = side === 'left'
            ? 'autoPresenceCalibrationLeft'
            : 'autoPresenceCalibrationRight';
          setIsUpdating(true);
          postJobs([job])
            .then(() => refetchSettings())
            .catch(console.error)
            .finally(() => setIsUpdating(false));
        } }
      >
        Run auto-cal now ({ side })
      </Button>
    </Section>
  );
}
