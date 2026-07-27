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
  { key: 'doubleTap', label: 'Double tap' },
  { key: 'tripleTap', label: 'Triple tap' },
  { key: 'quadTap', label: 'Quadruple tap' },
];

/**
 * Flat UI actions — map to TapConfigType without nested type→direction menus.
 */
type UiAction =
  | 'tempIncrease'
  | 'tempDecrease'
  | 'powerToggle'
  | 'scheduleApply'
  | 'alarm'
  | 'none';

const ACTION_OPTIONS: { value: UiAction; label: string }[] = [
  { value: 'tempDecrease', label: 'Decrease temperature' },
  { value: 'tempIncrease', label: 'Increase temperature' },
  { value: 'powerToggle', label: 'Toggle power on/off' },
  { value: 'scheduleApply', label: 'Save temp to schedule (all days)' },
  { value: 'alarm', label: 'Alarm dismiss/snooze' },
  { value: 'none', label: 'Do nothing' },
];

function configToUiAction(config: TapConfigType): UiAction {
  switch (config.type) {
    case 'temperature':
      return config.change === 'increment' ? 'tempIncrease' : 'tempDecrease';
    case 'power':
      // All power variants collapse to one UI choice (stored as toggle when re-saved)
      return 'powerToggle';
    case 'scheduleApply':
      return 'scheduleApply';
    case 'alarm':
      return 'alarm';
    case 'none':
    default:
      return 'none';
  }
}

function configFromUiAction(action: UiAction, previous?: TapConfigType): TapConfigType {
  switch (action) {
    case 'tempIncrease':
      return {
        type: 'temperature',
        change: 'increment',
        amount: previous?.type === 'temperature' ? previous.amount : 1,
      };
    case 'tempDecrease':
      return {
        type: 'temperature',
        change: 'decrement',
        amount: previous?.type === 'temperature' ? previous.amount : 1,
      };
    case 'powerToggle':
      return { type: 'power', action: 'toggle' };
    case 'scheduleApply':
      return { type: 'scheduleApply' };
    case 'alarm':
      if (previous?.type === 'alarm') return previous;
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

function defaultConfigForGesture(gesture: Gesture): TapConfigType {
  switch (gesture) {
    case 'doubleTap':
      return { type: 'temperature', change: 'decrement', amount: 1 };
    case 'tripleTap':
      return { type: 'temperature', change: 'increment', amount: 1 };
    case 'quadTap':
      return { type: 'power', action: 'toggle' };
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
      // Prefer plain "toggle power"; keep legacy off/on labels if still stored
      if (config.action === 'off') return 'power off';
      if (config.action === 'on') return 'power on';
      return 'toggle power';
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
    const nextTaps = {
      doubleTap: taps?.doubleTap ?? defaultConfigForGesture('doubleTap'),
      tripleTap: taps?.tripleTap ?? defaultConfigForGesture('tripleTap'),
      quadTap: taps?.quadTap ?? defaultConfigForGesture('quadTap'),
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
        Defaults: double −1°, triple +1°, quad toggle power. Any tap turns the side on if it is
        off. Haptics: N short ticks for an N-tap.
      </Typography>

      { GESTURES.map(({ key, label }) => {
        const config = taps?.[key] ?? defaultConfigForGesture(key);
        const uiAction = configToUiAction(config);
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
                    value={ uiAction }
                    onChange={ (event) => {
                      updateTap(key, configFromUiAction(event.target.value as UiAction, config));
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
                ) }

                { config.type === 'power' && (
                  <Typography variant="caption" color="text.secondary">
                    Toggles this side on/off. (If the side is already off, any tap turns it on first.)
                  </Typography>
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
