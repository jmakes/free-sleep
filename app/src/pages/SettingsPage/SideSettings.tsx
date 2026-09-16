import Grid from '@mui/material/GridLegacy';
import Switch from '@mui/material/Switch';
import { Box, Button, TextField, Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import { useCallback, useEffect, useState } from 'react';

import { Settings } from '@api/settingsSchema.ts';
import { Side, useAppStore } from '@state/appStore.tsx';
import { postJobs } from '@api/jobs.ts';
import {
  fetchSensorThresholds,
  putSensorThresholds,
  SensorThresholds,
} from '@api/sensors.ts';
import { useServices } from '@api/services.ts';
import TapControls from './TapControls.tsx';


type AwayModeSwitchProps = {
  side: Side;
  settings?: Settings;
  updateSettings: (settings: DeepPartial<Settings>) => void;
}

export default function SideSettings({ side, settings, updateSettings }: AwayModeSwitchProps) {
  const { isUpdating, setIsUpdating } = useAppStore();
  const { data: services } = useServices();
  const title = side.charAt(0).toUpperCase() + side.slice(1);

  const analyzeSleep = settings?.[side]?.analyzeSleep;
  const analyzeEnabled = analyzeSleep?.enabled ?? true;
  const savedMinDuration = analyzeSleep?.minDurationMinutes ?? 30;
  const autoCalEnabled = settings?.[side]?.autoPresenceCalibration?.enabled ?? false;
  const biometricsOn = Boolean(services?.biometrics.enabled);

  const [sideName, setSideName] = useState(settings?.[side]?.name || '');
  const [minDuration, setMinDuration] = useState(String(savedMinDuration));
  const [thresholds, setThresholds] = useState<SensorThresholds | null>(null);
  const [capZ, setCapZ] = useState('');
  const [piezoFloor, setPiezoFloor] = useState('');
  const [threshError, setThreshError] = useState<string | null>(null);
  const [threshSaved, setThreshSaved] = useState<string | null>(null);

  useEffect(() => {
    setSideName(settings?.[side]?.name || side);
  }, [settings, side]);

  useEffect(() => {
    setMinDuration(String(savedMinDuration));
  }, [savedMinDuration]);

  const loadThresholds = useCallback(() => {
    fetchSensorThresholds(side)
      .then((data) => {
        setThresholds(data);
        setCapZ(String(data.capZoneThreshold));
        setPiezoFloor(String(data.piezoRangeThreshold));
        setThreshError(null);
      })
      .catch((error) => {
        console.error(error);
        setThreshError('Could not load thresholds');
      });
  }, [side]);

  useEffect(() => {
    loadThresholds();
  }, [loadThresholds]);

  const handleNameBlur = () => {
    if (sideName.trim().length === 0) return;
    if (sideName.trim() !== settings?.[side]?.name) {
      updateSettings({ [side]: { name: sideName.trim() } });
    }
  };

  const handleMinDurationBlur = () => {
    const next = Math.min(24 * 60, Math.max(0, Math.round(Number(minDuration) || 0)));
    setMinDuration(String(next));
    if (next !== savedMinDuration) {
      updateSettings({
        [side]: {
          analyzeSleep: {
            enabled: analyzeEnabled,
            minDurationMinutes: next,
          },
        },
      });
    }
  };

  const saveThresholds = () => {
    const capZoneThreshold = Number(capZ);
    const piezoRangeThreshold = Number(piezoFloor);
    setIsUpdating(true);
    setThreshError(null);
    setThreshSaved(null);
    putSensorThresholds(side, { capZoneThreshold, piezoRangeThreshold })
      .then((res) => {
        if (!res.ok) {
          setThreshError(res.error || 'Save failed');
          return;
        }
        setThresholds(res.thresholds);
        setCapZ(String(res.thresholds.capZoneThreshold));
        setPiezoFloor(String(res.thresholds.piezoRangeThreshold));
        setThreshSaved('Saved — sticks until next auto or guided cal');
      })
      .catch((error) => {
        const msg = error?.response?.data?.error || error?.message || 'Save failed';
        setThreshError(String(msg));
      })
      .finally(() => setIsUpdating(false));
  };

  return (
    <Box sx={ { display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' } }>
      <Typography variant="h6">{ title } Side</Typography>
      <TextField
        label="Side Name"
        placeholder="Enter side name"
        value={ sideName }
        onChange={ (e) => setSideName(e.target.value) }
        onBlur={ handleNameBlur }
        disabled={ isUpdating }
        sx={ { mt: 2 } }
        inputProps={ { maxLength: 20 } }
        fullWidth
      />
      <Grid container spacing={ 0 } sx={ { width: '100%', mt: 1 } }>
        <Typography alignContent="center">Away mode</Typography>
        <Switch
          disabled={ isUpdating }
          checked={ settings?.[side]?.awayMode || false }
          onChange={ (event) => updateSettings({ [side]: { awayMode: event.target.checked } }) }
        />
      </Grid>
      <Grid container spacing={ 0 } sx={ { width: '100%', mt: 0.5, alignItems: 'center' } }>
        <Typography alignContent="center">Analyze sleep</Typography>
        <Switch
          disabled={ isUpdating }
          checked={ analyzeEnabled }
          onChange={ (event) => updateSettings({
            [side]: {
              analyzeSleep: {
                enabled: event.target.checked,
                minDurationMinutes: savedMinDuration,
              },
            },
          }) }
        />
      </Grid>
      { analyzeEnabled && (
        <TextField
          label="Min on time (minutes)"
          type="number"
          size="small"
          disabled={ isUpdating }
          value={ minDuration }
          inputProps={ { min: 0, max: 24 * 60, step: 5 } }
          helperText="Auto-analyze when this side turns off after being on at least this long (schedule, button, or cover tap). Requires biometrics under Features."
          sx={ { width: '100%', mt: 1 } }
          onChange={ (event) => setMinDuration(event.target.value) }
          onBlur={ handleMinDurationBlur }
        />
      ) }
      <Grid container spacing={ 0 } sx={ { width: '100%', mt: 1.5, alignItems: 'center' } }>
        <Typography alignContent="center">Auto presence cal (beta)</Typography>
        <Switch
          disabled={ isUpdating || !biometricsOn }
          checked={ autoCalEnabled }
          onChange={ (event) => updateSettings({
            [side]: {
              autoPresenceCalibration: { enabled: event.target.checked },
            },
          }) }
        />
      </Grid>
      <Typography color="text.secondary" variant="body2" sx={ { width: '100%', mt: 0.5 } }>
        Weekly Wed 3pm, 14-day schedule prior, 35% blend, piezo floor ≥50k.
        Away mode uses a strong empty prior. Manual guided calibration still wins.
        Turn off if you often sleep with the Pod powered off — schedule priors get noisy then.
      </Typography>
      <Button
        size="small"
        variant="outlined"
        sx={ { mt: 1, alignSelf: 'flex-start' } }
        disabled={ isUpdating || !autoCalEnabled || !biometricsOn }
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
        Run auto-cal now
      </Button>

      <Typography variant="subtitle2" sx={ { width: '100%', mt: 2, fontWeight: 600 } }>
        Presence thresholds (manual)
      </Typography>
      <Typography color="text.secondary" variant="body2" sx={ { width: '100%', mt: 0.5 } }>
        Cap max-z and piezo floor used for presence. Edit after checking live values on Sensors.
        Saves to this side&apos;s baseline and overrides until the next auto or guided calibration.
        { thresholds?.source ? ` Current source: ${thresholds.source}.` : '' }
        { thresholds && !thresholds.exists
          ? ' No baseline yet — run guided Sensors calibration first.'
          : '' }
      </Typography>
      <TextField
        label="Cap max-z threshold"
        type="number"
        size="small"
        disabled={ isUpdating || !thresholds?.exists }
        value={ capZ }
        inputProps={ { min: 0.5, max: 10, step: 0.1 } }
        helperText="Lower = easier to count as occupied (typical 1.2–4)"
        sx={ { width: '100%', mt: 1 } }
        onChange={ (e) => { setCapZ(e.target.value); setThreshSaved(null); } }
      />
      <TextField
        label="Piezo floor"
        type="number"
        size="small"
        disabled={ isUpdating || !thresholds?.exists }
        value={ piezoFloor }
        inputProps={ { min: 5000, max: 500000, step: 1000 } }
        helperText="Lower = more sensitive to motion (floor usually ≥50k to limit cross-talk)"
        sx={ { width: '100%', mt: 1 } }
        onChange={ (e) => { setPiezoFloor(e.target.value); setThreshSaved(null); } }
      />
      <Box sx={ { width: '100%', mt: 1, display: 'flex', gap: 1, alignItems: 'center' } }>
        <Button
          size="small"
          variant="contained"
          disabled={ isUpdating || !thresholds?.exists }
          onClick={ saveThresholds }
        >
          Save thresholds
        </Button>
        <Button size="small" disabled={ isUpdating } onClick={ loadThresholds }>
          Reload
        </Button>
      </Box>
      { threshError && (
        <Typography color="error" variant="caption" sx={ { width: '100%', mt: 0.5 } }>
          { threshError }
        </Typography>
      ) }
      { threshSaved && (
        <Typography color="success.main" variant="caption" sx={ { width: '100%', mt: 0.5 } }>
          { threshSaved }
        </Typography>
      ) }

      <TapControls side={ side } settings={ settings } updateSettings={ updateSettings } />
    </Box>
  );
}
