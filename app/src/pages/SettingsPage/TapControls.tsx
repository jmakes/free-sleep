import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { DeepPartial } from 'ts-essentials';
import { Settings, TapConfigType, Gesture } from '@api/settingsSchema.ts';
import { Side, useAppStore } from '@state/appStore.tsx';

const GESTURES: { key: Gesture; label: string }[] = [
  { key: 'singleTap', label: 'Single tap' },
  { key: 'doubleTap', label: 'Double tap' },
  { key: 'tripleTap', label: 'Triple tap' },
  { key: 'quadTap', label: 'Quadruple tap' },
];

type ActionKind = TapConfigType['type'];

const ACTION_OPTIONS: { value: ActionKind; label: string }[] = [
  { value: 'temperature', label: 'Change temperature' },
  { value: 'power', label: 'Power on/off' },
  { value: 'scheduleApply', label: 'Save temp to schedule (all days)' },
  { value: 'alarm', label: 'Alarm dismiss/snooze' },
  { value: 'none', label: 'Do nothing' },
];

function defaultConfigForType(type: ActionKind): TapConfigType {
  switch (type) {
    case 'temperature':
      return { type: 'temperature', change: 'decrement', amount: 1 };
    case 'power':
      return { type: 'power', action: 'off' };
    case 'scheduleApply':
      return { type: 'scheduleApply' };
    case 'alarm':
      return {
        type: 'alarm',
        behavior: 'dismiss',
        snoozeDuration: 300,
        inactiveAlarmBehavior: 'none',
      };
    case 'none':
    default:
      return { type: 'none' };
  }
}

function describeConfig(config?: TapConfigType): string {
  if (!config) return '—';
  switch (config.type) {
    case 'temperature':
      return `${config.change === 'increment' ? '+' : '−'}${config.amount}°`;
    case 'power':
      return `power ${config.action}`;
    case 'scheduleApply':
      return 'save to schedule';
    case 'alarm':
      return `alarm ${config.behavior}`;
    case 'none':
      return 'none';
    default:
      return '—';
  }
}

type TapControlsProps = {
  side: Side;
  settings?: Settings;
  updateSettings: (settings: DeepPartial<Settings>) => void;
};

export default function TapControls({ side, settings, updateSettings }: TapControlsProps) {
  const { isUpdating } = useAppStore();
  const taps = settings?.[side]?.taps;

  const updateTap = (gesture: Gesture, config: TapConfigType) => {
    // Send full taps map so the server can replace the gesture object cleanly
    const nextTaps = {
      singleTap: taps?.singleTap ?? defaultConfigForType('temperature'),
      doubleTap: taps?.doubleTap ?? defaultConfigForType('temperature'),
      tripleTap: taps?.tripleTap ?? defaultConfigForType('none'),
      quadTap: taps?.quadTap ?? defaultConfigForType('scheduleApply'),
      [gesture]: config,
    };
    updateSettings({
      [side]: {
        taps: nextTaps,
      },
    });
  };

  return (
    <Box sx={ { width: '100%', mt: 1 } }>
      <Typography variant="subtitle2" color="text.secondary" sx={ { mb: 1 } }>
        Cover taps
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={ { mb: 1 } }>
        Vibration: N short ticks for N-tap (same side). Pod 4 does not report normal single-taps over
        the local API — use double/triple/quad. OEM single-tap snooze is cover-side while an alarm rings.
      </Typography>

      { GESTURES.map(({ key, label }) => {
        const config = taps?.[key] ?? defaultConfigForType('none');
        return (
          <Accordion key={ key } disableGutters elevation={ 0 } sx={ { bgcolor: 'background.paper' } }>
            <AccordionSummary expandIcon={ <ExpandMoreIcon /> }>
              <Typography variant="body2" sx={ { flex: 1 } }>
                { label }
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={ { mr: 1 } }>
                { describeConfig(config) }
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Box sx={ { display: 'flex', flexDirection: 'column', gap: 1.5 } }>
                <FormControl fullWidth size="small" disabled={ isUpdating }>
                  <InputLabel>Action</InputLabel>
                  <Select
                    label="Action"
                    value={ config.type }
                    onChange={ (event) => {
                      updateTap(key, defaultConfigForType(event.target.value as ActionKind));
                    } }
                  >
                    { ACTION_OPTIONS.map((option) => (
                      <MenuItem key={ option.value } value={ option.value }>
                        { option.label }
                      </MenuItem>
                    )) }
                  </Select>
                </FormControl>

                { config.type === 'temperature' && (
                  <>
                    <FormControl fullWidth size="small" disabled={ isUpdating }>
                      <InputLabel>Direction</InputLabel>
                      <Select
                        label="Direction"
                        value={ config.change }
                        onChange={ (event) => {
                          updateTap(key, {
                            ...config,
                            change: event.target.value as 'increment' | 'decrement',
                          });
                        } }
                      >
                        <MenuItem value="decrement">Decrease</MenuItem>
                        <MenuItem value="increment">Increase</MenuItem>
                      </Select>
                    </FormControl>
                    <TextField
                      label="Degrees (°F)"
                      type="number"
                      size="small"
                      disabled={ isUpdating }
                      value={ config.amount }
                      inputProps={ { min: 0, max: 10, step: 1 } }
                      onChange={ (event) => {
                        const amount = Math.min(10, Math.max(0, Number(event.target.value) || 0));
                        updateTap(key, { ...config, amount });
                      } }
                    />
                  </>
                ) }

                { config.type === 'power' && (
                  <FormControl fullWidth size="small" disabled={ isUpdating }>
                    <InputLabel>Power action</InputLabel>
                    <Select
                      label="Power action"
                      value={ config.action }
                      onChange={ (event) => {
                        updateTap(key, {
                          ...config,
                          action: event.target.value as 'off' | 'on' | 'toggle',
                        });
                      } }
                    >
                      <MenuItem value="off">Turn off</MenuItem>
                      <MenuItem value="on">Turn on</MenuItem>
                      <MenuItem value="toggle">Toggle</MenuItem>
                    </Select>
                  </FormControl>
                ) }

                { config.type === 'scheduleApply' && (
                  <Typography variant="caption" color="text.secondary">
                    Copies this side&apos;s current target temperature into the active schedule
                    time slot for every day of the week.
                  </Typography>
                ) }

                { config.type === 'alarm' && (
                  <FormControl fullWidth size="small" disabled={ isUpdating }>
                    <InputLabel>Alarm behavior</InputLabel>
                    <Select
                      label="Alarm behavior"
                      value={ config.behavior }
                      onChange={ (event) => {
                        updateTap(key, {
                          ...config,
                          behavior: event.target.value as 'snooze' | 'dismiss',
                        });
                      } }
                    >
                      <MenuItem value="dismiss">Dismiss</MenuItem>
                      <MenuItem value="snooze">Snooze (clear vibration)</MenuItem>
                    </Select>
                  </FormControl>
                ) }
              </Box>
            </AccordionDetails>
          </Accordion>
        );
      }) }
    </Box>
  );
}
