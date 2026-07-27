import Grid from '@mui/material/GridLegacy';
import Switch from '@mui/material/Switch';
import { Box, TextField, Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import { useEffect, useState } from 'react';

import { Settings } from '@api/settingsSchema.ts';
import { Side, useAppStore } from '@state/appStore.tsx';
import TapControls from './TapControls.tsx';


type AwayModeSwitchProps = {
  side: Side;
  settings?: Settings;
  updateSettings: (settings: DeepPartial<Settings>) => void;
}

export default function SideSettings({ side, settings, updateSettings }: AwayModeSwitchProps) {
  const { isUpdating } = useAppStore();
  const title = side.charAt(0).toUpperCase() + side.slice(1);

  const analyzeSleep = settings?.[side]?.analyzeSleep;
  const analyzeEnabled = analyzeSleep?.enabled ?? true;
  const savedMinDuration = analyzeSleep?.minDurationMinutes ?? 30;

  // Local state for text fields
  const [sideName, setSideName] = useState(settings?.[side]?.name || '');
  const [minDuration, setMinDuration] = useState(String(savedMinDuration));

  useEffect(() => {
    setSideName(settings?.[side]?.name || side);
  }, [settings, side]);

  useEffect(() => {
    setMinDuration(String(savedMinDuration));
  }, [savedMinDuration]);

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
      <TapControls side={ side } settings={ settings } updateSettings={ updateSettings } />
    </Box>
  );
}
