import {
  Accordion,
  AccordionSummary,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  FormGroup,
  Typography
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { AccordionExpanded, DaysSelected } from './SchedulePage.types.ts';
import { DayOfWeek } from '@api/schedulesSchema.ts';
import { useAppStore } from '@state/appStore.tsx';
import { DEFAULT_DAYS_SELECTED, useScheduleStore } from './scheduleStore';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import { LOWERCASE_DAYS } from './days.ts';

export const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ACCORDION_NAME: AccordionExpanded = 'applyToDays';

const ALL_DAYS: DaysSelected = { ...DEFAULT_DAYS_SELECTED };

const WEEKDAYS: DaysSelected = {
  sunday: false,
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
};

const WEEKENDS: DaysSelected = {
  sunday: true,
  monday: false,
  tuesday: false,
  wednesday: false,
  thursday: false,
  friday: false,
  saturday: true,
};

const THIS_DAY_ONLY = (day: DayOfWeek): DaysSelected => {
  const next = { ...ALL_DAYS };
  for (const d of LOWERCASE_DAYS) {
    next[d] = d === day;
  }
  return next;
};

export default function ApplyToOtherDaysAccordion() {
  const {
    selectedDays,
    toggleSelectedDay,
    setSelectedDays,
    accordionExpanded,
    setAccordionExpanded,
    selectedSchedule,
    selectedDay,
  } = useScheduleStore();
  const { isUpdating } = useAppStore();

  const selectedCount = LOWERCASE_DAYS.filter((day) => selectedDays[day]).length;
  const summaryLabel =
    selectedCount === 7
      ? 'Applies to all days'
      : selectedCount === 1
        ? 'Applies to this day only'
        : `Applies to ${selectedCount} days`;

  return (
    <Accordion
      sx={ { width: '100%', mt: -2 } }
      expanded={ accordionExpanded === ACCORDION_NAME }
      onChange={ () => setAccordionExpanded(ACCORDION_NAME) }
      disabled={ !selectedSchedule?.power.enabled }
    >
      <AccordionSummary expandIcon={ <ExpandMoreIcon/> }>
        <Typography sx={ { display: 'flex', alignItems: 'center', gap: 3 } }>
          <EventRepeatIcon /> { summaryLabel }
        </Typography>
      </AccordionSummary>
      <Box sx={ { mt: -2, p: 2 } }>
        <Typography variant="caption" color="text.secondary" display="block" sx={ { mb: 1.5 } }>
          By default, saves apply to every day of the week. Uncheck days (or use This day only)
          when you want a one-off schedule for specific days.
        </Typography>
        <Box sx={ { display: 'flex', gap: 1, flexWrap: 'wrap' } }>
          <Button
            variant="contained"
            size="small"
            sx={ { mb: 1 } }
            disabled={ isUpdating }
            onClick={ () => setSelectedDays({ ...ALL_DAYS }) }
          >
            Every day
          </Button>
          <Button
            variant="outlined"
            size="small"
            sx={ { mb: 1 } }
            disabled={ isUpdating }
            onClick={ () => setSelectedDays({ ...WEEKDAYS }) }
          >
            Weekdays
          </Button>
          <Button
            variant="outlined"
            size="small"
            sx={ { mb: 1 } }
            disabled={ isUpdating }
            onClick={ () => setSelectedDays({ ...WEEKENDS }) }
          >
            Weekends
          </Button>
          <Button
            variant="outlined"
            size="small"
            sx={ { mb: 1 } }
            disabled={ isUpdating }
            onClick={ () => setSelectedDays(THIS_DAY_ONLY(selectedDay)) }
          >
            This day only
          </Button>
        </Box>
        <FormGroup>
          {
            daysOfWeek.map((day) => {
              const lowerCaseDay = day.toLowerCase() as DayOfWeek;
              const isCurrentDay = lowerCaseDay === selectedDay;
              return (
                <FormControlLabel
                  key={ day }
                  control={
                    <Checkbox
                      disabled={ isUpdating || isCurrentDay }
                      checked={ selectedDays[lowerCaseDay] || isCurrentDay }
                      onChange={ () => toggleSelectedDay(lowerCaseDay) }
                    />
                  }
                  label={ isCurrentDay ? `${day} (editing)` : day }
                />
              );
            })
          }
        </FormGroup>
      </Box>
    </Accordion>
  );
}
