import { useMemo } from 'react';
import { Card, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { LineChart, lineElementClasses, areaElementClasses } from '@mui/x-charts/LineChart';
import { useResizeDetector } from 'react-resize-detector';
import moment from 'moment-timezone';
import type { MovementRecord } from '@api/movement.ts';

type MovementChartProps = {
  movementRecords: MovementRecord[];
  label?: string;
  bucketMs?: number;
};

type Pt = { x: Date; y: number };

/**
 * Restlessness levels from mattress movement — NOT sleep stages.
 * Quiet / Stirring / Restless only. Real REM/Deep/Light needs HR+HRV+breathing.
 */
function snapToRestlessness(v: number): number {
  if (v >= 900) return 3; // Restless
  if (v >= 200) return 2; // Stirring
  return 1; // Quiet
}

/** Max-pool inside fixed time buckets */
function bucketMaxByTime(items: { t: number; v: number }[], bucketMs: number) {
  if (!items.length) return [];

  const out: { t: number; v: number }[] = [];

  let bucketStart = Math.floor(items[0].t / bucketMs) * bucketMs;
  let bucketEnd = bucketStart + bucketMs;

  let maxT = items[0].t;
  let maxV = -Infinity;

  let i = 0;
  while (i < items.length) {
    const { t, v } = items[i];
    if (t < bucketEnd) {
      if (v > maxV) { maxV = v; maxT = t; }
      i++;
    } else {
      out.push({ t: maxT, v: maxV === -Infinity ? 0 : maxV });
      bucketStart = bucketEnd;
      bucketEnd = bucketStart + bucketMs;
      maxV = -Infinity;
      maxT = bucketStart;
    }
  }

  out.push({ t: maxT, v: maxV === -Infinity ? 0 : maxV });
  return out;
}

const LEVEL_LABEL: Record<number, string> = {
  1: 'Quiet',
  2: 'Stirring',
  3: 'Restless',
};

/**
 * Horizontal restlessness hypnogram: time left→right, level as horizontal steps.
 * Brief tosses stay brief (no 10‑minute dilation that invented fake "awake" blocks).
 */
export default function MovementAreaChart({
  movementRecords,
  label = 'Restlessness',
  bucketMs = 60_000, // 1 min buckets
}: MovementChartProps) {
  const theme = useTheme();
  const { ref } = useResizeDetector();

  const points = useMemo<Pt[]>(() => {
    if (!movementRecords?.length) return [];

    const raw = [...movementRecords]
      .map(r => ({ t: new Date(r.timestamp).getTime(), v: Number(r.total_movement) }))
      .sort((a, b) => a.t - b.t);

    const pooled = bucketMaxByTime(raw, bucketMs);

    return pooled.map(p => ({
      x: new Date(p.t),
      y: snapToRestlessness(p.v),
    }));
  }, [movementRecords, bucketMs]);

  if (!points.length) return null;

  const xData = points.map(p => p.x);
  const yData = points.map(p => p.y);

  return (
    <Card sx={ { pt: 1, mt: 2, pl: 2, pr: 1 } }>
      <Typography variant="h6" gutterBottom>{ label }</Typography>
      <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mb: 1, pr: 1 } }>
        Mattress movement only — not sleep stages (REM / Deep / Light). Quiet stretches can be deep or REM; restless can be a toss or a wake.
      </Typography>

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
          max: 3.5,
          tickMinStep: 1,
          tickNumber: 3,
          valueFormatter: (y) => LEVEL_LABEL[Number(y)] ?? '',
        }] }
        series={ [{
          id: 'restlessness',
          label,
          data: yData,
          area: true,
          showMark: false,
          curve: 'stepAfter',
        }] }
        margin={ { left: 88, right: 24, top: 12, bottom: 36 } }
        slotProps={ { legend: { hidden: true } } }
        sx={ {
          [`& .${lineElementClasses.root}`]: { stroke: theme.palette.secondary.dark },
          [`& .${areaElementClasses.root}`]: { fill: theme.palette.secondary.dark, opacity: 0.55, filter: 'none' },
          // Emphasize wide horizontal timeline
          width: '100%',
        } }
      />
    </Card>
  );
}
