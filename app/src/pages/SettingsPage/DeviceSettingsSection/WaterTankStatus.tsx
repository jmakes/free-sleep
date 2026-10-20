import { Box, Chip, Typography } from '@mui/material';
import moment from 'moment-timezone';
import { useWaterStatus } from '@api/water.ts';
import { waterChip } from '@lib/waterStatus.ts';

// Read-only water tank row. Same source as the Status page (GET /api/water).
export default function WaterTankStatus() {
  const { data: water } = useWaterStatus();
  const chip = waterChip(water);
  const since = water?.isLow && water.lowSince
    ? `since ${moment(water.lowSince).format('MMM D HH:mm')}`
    : null;
  return (
    <Box sx={ { display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' } }>
      <Typography variant='body2'>Water tank</Typography>
      <Chip label={ chip.label } color={ chip.color } size='small'/>
      { since && <Typography variant='body2' color='text.secondary'>{ since }</Typography> }
    </Box>
  );
}
