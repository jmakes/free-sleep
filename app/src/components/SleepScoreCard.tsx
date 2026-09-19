import { Card, Typography, Box, LinearProgress, Stack } from '@mui/material';
import type { SleepScoreV1 } from '@lib/sleepScoreV1.ts';

type SleepScoreCardProps = {
  scoreResult?: SleepScoreV1 | null;
};

export default function SleepScoreCard({ scoreResult }: SleepScoreCardProps) {
  if (!scoreResult) return null;

  return (
    <Card sx={ { p: 2, backgroundColor: 'background.paper', mt: 2 } }>
      <Box display="flex" justifyContent="space-between" alignItems="baseline" mb={ 1 }>
        <Typography variant="h6">Sleep score</Typography>
        <Typography variant="h4" fontWeight="bold" color="primary.light">
          { scoreResult.score }
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" display="block" mb={ 2 }>
        Explainable v1 (duration · continuity · restfulness · vitals). Compare later to Garmin — not calibrated yet.
      </Typography>
      <Stack spacing={ 1.5 }>
        { scoreResult.components.map((component) => (
          <Box key={ component.key }>
            <Box display="flex" justifyContent="space-between">
              <Typography variant="body2" fontWeight="bold">{ component.label }</Typography>
              <Typography variant="body2">
                { component.points }/{ component.maxPoints }
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={ (component.points / component.maxPoints) * 100 }
              sx={ { height: 8, borderRadius: 1, my: 0.5 } }
            />
            <Typography variant="caption" color="text.secondary">{ component.detail }</Typography>
          </Box>
        )) }
      </Stack>
    </Card>
  );
}
