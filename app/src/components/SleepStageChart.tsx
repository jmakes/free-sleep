import { useMemo } from 'react';
import { Card, Typography, Box, Stack, Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { LineChart, lineElementClasses, areaElementClasses } from '@mui/x-charts/LineChart';
import { useResizeDetector } from 'react-resize-detector';
import moment from 'moment-timezone';
import type { StageSummary, SleepStage } from '@lib/sleepStageV1.ts';

type SleepStageChartProps = {
  summary?: StageSummary | null;
  label?: string;
};

/** y mapping: awake=4, rem=3, light=2, deep=1 (hypnogram style) */
const STAGE_Y: Record<SleepStage, number> = {
  awake: 4,
  rem: 3,
  light: 2,
  deep: 1,
};

const STAGE_LABEL: Record<number, string> = {
  1: 'Deep',
  2: 'Light',
  3: 'REM',
  4: 'Awake',
};

const STAGE_COLOR_KEY: Record<SleepStage, 'error' | 'secondary' | 'info' | 'primary'> = {
  awake: 'error',
  rem: 'secondary',
  light: 'info',
  deep: 'primary',
};

/**
 * Heuristic stage hypnogram -- separate from the movement Restlessness chart.
 */
export default function SleepStageChart({
  summary,
  label = 'Sleep stages (heuristic v1)',
}: SleepStageChartProps) {
  const theme = useTheme();
  const { ref } = useResizeDetector();

  const points = useMemo(() => {
    if (!summary?.epochs?.length) return [];
    return summary.epochs.map((epoch) => ({
      x: new Date(epoch.startMs),
      y: STAGE_Y[epoch.stage],
    }));
  }, [summary]);

  if (!points.length || !summary) return null;

  const xData = points.map((p) => p.x);
  const yData = points.map((p) => p.y);

  return (
    <Card sx={ { pt: 1, mt: 2, pl: 2, pr: 1 } }>
      <Typography variant="h6" gutterBottom>{ label }</Typography>
      <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mb: 1, pr: 1 } }>
        Multi-signal heuristic (movement + HR + HRV + breathing + presence). Not Garmin / Eight Sleep ground truth -- validate left-side scores later against a watch.
      </Typography>
      <Stack direction="row" spacing={ 1 } flexWrap="wrap" useFlexGap sx={ { mb: 1 } }>
        { (['deep', 'rem', 'light', 'awake'] as SleepStage[]).map((stage) => (
          <Chip
            key={ stage }
            size="small"
            color={ STAGE_COLOR_KEY[stage] }
            variant="outlined"
            label={ `${stage[0].toUpperCase()}${stage.slice(1)} ${summary.percent[stage]}%` }
          />
        )) }
      </Stack>
      <Box>
        <LineChart
          ref={ ref }
          height={ 220 }
          xAxis={ [{
            scaleType: 'time',
            data: xData,
            valueFormatter: (v) => moment(v as number).format('HH:mm'),
            min: xData[0],
            max: xData[xData.length - 1],
            tickMinStep: 60 * 60 * 1000,
            tickNumber: 5,
          }] }
          yAxis={ [{
            min: 0.5,
            max: 4.5,
            tickMinStep: 1,
            tickNumber: 4,
            valueFormatter: (y) => STAGE_LABEL[Number(y)] ?? '',
          }] }
          series={ [{
            id: 'stage_v1',
            label,
            data: yData,
            area: true,
            showMark: false,
            curve: 'stepAfter',
          }] }
          margin={ { left: 72, right: 24, top: 12, bottom: 36 } }
          slotProps={ { legend: { hidden: true } } }
          sx={ {
            [`& .${lineElementClasses.root}`]: { stroke: theme.palette.primary.light },
            [`& .${areaElementClasses.root}`]: { fill: theme.palette.primary.dark, opacity: 0.45, filter: 'none' },
            width: '100%',
          } }
        />
      </Box>
    </Card>
  );
}
