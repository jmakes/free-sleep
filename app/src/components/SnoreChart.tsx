import { useMemo } from 'react';
import { Card, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { LineChart, lineElementClasses, areaElementClasses } from '@mui/x-charts/LineChart';
import { useResizeDetector } from 'react-resize-detector';
import moment from 'moment-timezone';
import type { SnoreRecord } from '@api/snore.ts';

type SnoreChartProps = {
  snoreRecords: SnoreRecord[];
  label?: string;
};

type Pt = { x: Date; y: number };

/**
 * Overnight snore *heuristic* hypnogram: binary snore label (0/1) as steps.
 * Piezo spectral score — not OEM ML / clinical / mic-based.
 */
export default function SnoreChart({
  snoreRecords,
  label = 'Snore (heuristic)',
}: SnoreChartProps) {
  const theme = useTheme();
  const { ref } = useResizeDetector();

  const points = useMemo<Pt[]>(() => {
    if (!snoreRecords?.length) return [];

    return [...snoreRecords]
      .map((r) => ({
        t: typeof r.timestamp === 'number'
          ? (r.timestamp < 1e12 ? r.timestamp * 1000 : r.timestamp)
          : new Date(r.timestamp).getTime(),
        v: Number(r.snore) > 0 ? 1 : 0,
      }))
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t)
      .map((p) => ({ x: new Date(p.t), y: p.v }));
  }, [snoreRecords]);

  const snoreMinuteCount = useMemo(
    () => points.reduce((n, p) => n + (p.y > 0 ? 1 : 0), 0),
    [points],
  );

  if (!points.length) return null;

  const xData = points.map((p) => p.x);
  const yData = points.map((p) => p.y);

  return (
    <Card sx={ { pt: 1, mt: 2, pl: 2, pr: 1 } }>
      <Typography variant="h6" gutterBottom>{ label }</Typography>
      <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mb: 1, pr: 1 } }>
        Piezo band-energy heuristic — not clinical / OEM / mic. ~{ snoreMinuteCount } labeled minute
        { snoreMinuteCount === 1 ? '' : 's' } this night.
      </Typography>

      <LineChart
        ref={ ref }
        height={ 160 }
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
          min: -0.05,
          max: 1.15,
          tickMinStep: 1,
          tickNumber: 2,
          valueFormatter: (y) => (Number(y) >= 0.5 ? 'Snore' : 'Quiet'),
        }] }
        series={ [{
          id: 'snore',
          label,
          data: yData,
          area: true,
          showMark: false,
          curve: 'stepAfter',
        }] }
        margin={ { left: 72, right: 24, top: 12, bottom: 36 } }
        slotProps={ { legend: { hidden: true } } }
        sx={ {
          [`& .${lineElementClasses.root}`]: { stroke: theme.palette.warning.main },
          [`& .${areaElementClasses.root}`]: {
            fill: theme.palette.warning.main,
            opacity: 0.45,
            filter: 'none',
          },
          width: '100%',
        } }
      />
    </Card>
  );
}
