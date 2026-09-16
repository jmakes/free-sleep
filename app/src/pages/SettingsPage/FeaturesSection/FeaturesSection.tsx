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
import { useSettings, postSettings } from '@api/settings.ts';
import { useAppStore } from '@state/appStore.tsx';
import { DeepPartial } from 'ts-essentials';
import { Settings } from '@api/settingsSchema.ts';
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

  const updateSettings = (next: DeepPartial<Settings>) => {
    setIsUpdating(true);
    postSettings(next)
      .then(() => refetchSettings())
      .catch(error => {
        console.error(error);
      })
      .finally(() => setIsUpdating(false));
  };

  if (isLoading || !services || !settings) return <CircularProgress />;

  const autoCalEnabled = Boolean(settings.beta?.autoPresenceCalibration?.enabled);

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
      <FormControlLabel
        control={
          <Switch
            disabled={ isUpdating || !services.biometrics.enabled }
            checked={ autoCalEnabled }
            onChange={ (event) => updateSettings({
              beta: { autoPresenceCalibration: { enabled: event.target.checked } },
            }) }
          />
        }
        label="Auto presence calibration"
      />
      <Box display='flex' gap={ 1 } sx={ { mb: 1 } }>
        <InfoIcon sx={ { color: 'text.secondary' } }/>
        <Typography color='text.secondary' variant="body2">
          Weekly (Wed 3pm) schedule-prior recalibration over the last 14 days.
          Blends into existing thresholds so worn pads with smaller swings can still
          register occupancy. Piezo floor never drops below 50k (cross-talk).
          Turn this off if you often sleep with the Pod powered off — schedule priors
          get noisy then. Sides in Away mode use a strong empty prior (no occupied fit from schedule).
          Manual guided calibration still wins when you run it.
        </Typography>
      </Box>
      <Button
        size="small"
        variant="outlined"
        disabled={ isUpdating || !autoCalEnabled || !services.biometrics.enabled }
        onClick={ () => {
          const job = side === 'left'
            ? 'autoPresenceCalibrationLeft'
            : 'autoPresenceCalibrationRight';
          setIsUpdating(true);
          postJobs([job])
            .catch(console.error)
            .finally(() => setIsUpdating(false));
        } }
      >
        Run auto-cal now ({ side })
      </Button>
    </Section>
  );
}
