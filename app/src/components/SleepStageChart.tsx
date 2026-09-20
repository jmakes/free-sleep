import { useMemo } from 'react';
import { Card, Typography, Box, Stack, Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import moment from 'moment-timezone';
import type { StageSummary, SleepStage } from '@lib/sleepStageV1.ts';

type SleepStageChartProps = {
  summary?: StageSummary | null;
  label?: string;
};

const STAGE_ORDER: SleepStage[] = ['awake', 'rem', 'light', 'deep'];

/** Row index top→bottom (hypnogram convention: awake on top) */
const STAGE_ROW: Record<SleepStage, number> = {
  awake: 0,
  rem: 1,
  light: 2,
  deep: 3,
};

const STAGE_LABEL: Record<SleepStage, string> = {
  awake: 'Awake',
  rem: 'REM',
  light: 'Light',
  deep: 'Deep',
};

const STAGE_COLOR_KEY: Record<SleepStage, 'error' | 'secondary' | 'info' | 'primary'> = {
  awake: 'error',
  rem: 'secondary',
  light: 'info',
  deep: 'primary',
};

const TICK_COUNT = 5;
const ROW_HEIGHT = 28;
const ROW_GAP = 4;
const CHART_HEIGHT = STAGE_ORDER.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP;

/**
 * Multi-color band hypnogram — distinct deep / rem / light / awake colors, L→R overnight.
 */
export default function SleepStageChart({
  summary,
  label = 'Sleep stages (heuristic v1)',
}: SleepStageChartProps) {
  const theme = useTheme();

  const stageColors: Record<SleepStage, string> = useMemo(() => ({
    awake: theme.palette.error.main,
    rem: theme.palette.secondary.light,
    light: theme.palette.info.light,
    deep: theme.palette.primary.main,
  }), [theme]);

  const model = useMemo(() => {
    if (!summary?.epochs?.length) return null;
    const startMs = summary.epochs[0].startMs;
    const endMs = summary.epochs[summary.epochs.length - 1].endMs;
    if (!(endMs > startMs)) return null;
    const durationMs = endMs - startMs;

    const bands = summary.epochs.map((epoch) => {
      const clippedStart = Math.max(epoch.startMs, startMs);
      const clippedEnd = Math.min(epoch.endMs, endMs);
      return {
        stage: epoch.stage,
        leftPct: ((clippedStart - startMs) / durationMs) * 100,
        widthPct: Math.max(0.2, ((clippedEnd - clippedStart) / durationMs) * 100),
        startMs: clippedStart,
        endMs: clippedEnd,
      };
    });

    const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
      const t = startMs + (durationMs * i) / (TICK_COUNT - 1);
      return { leftPct: (i / (TICK_COUNT - 1)) * 100, label: moment(t).format('HH:mm') };
    });

    return { bands, ticks, startMs, endMs };
  }, [summary]);

  if (!model || !summary) return null;

  const trackBg = theme.palette.mode === 'dark'
    ? 'rgba(255,255,255,0.04)'
    : 'rgba(0,0,0,0.04)';

  return (
    <Card sx={ { pt: 1, mt: 2, pl: 2, pr: 2, pb: 2 } }>
      <Typography variant="h6" gutterBottom>{ label }</Typography>
      <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mb: 1 } }>
        Multi-signal heuristic (movement + HR + HRV + breathing + presence). Not Garmin / Eight Sleep ground truth — validate left-side scores later against a watch.
      </Typography>
      <Stack direction="row" spacing={ 1 } flexWrap="wrap" useFlexGap sx={ { mb: 1.5 } }>
        { (['deep', 'rem', 'light', 'awake'] as SleepStage[]).map((stage) => (
          <Chip
            key={ stage }
            size="small"
            color={ STAGE_COLOR_KEY[stage] }
            variant="outlined"
            label={ `${STAGE_LABEL[stage]} ${summary.percent[stage]}%` }
          />
        )) }
      </Stack>

      <Box sx={ { display: 'flex', gap: 1 } }>
        <Box sx={ {
          display: 'flex',
          flexDirection: 'column',
          gap: `${ROW_GAP}px`,
          width: 52,
          flexShrink: 0,
        } }
        >
          { STAGE_ORDER.map((stage) => (
            <Typography
              key={ stage }
              variant="caption"
              color="text.secondary"
              sx={ {
                height: ROW_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                pr: 0.5,
                fontSize: '0.7rem',
                fontWeight: 600,
              } }
            >
              { STAGE_LABEL[stage] }
            </Typography>
          )) }
        </Box>

        <Box sx={ { flex: 1, minWidth: 0 } }>
          <Box sx={ {
            position: 'relative',
            height: CHART_HEIGHT,
            borderRadius: 1,
            overflow: 'hidden',
            border: `1px solid ${theme.palette.divider}`,
          } }
          >
            { STAGE_ORDER.map((stage) => (
              <Box
                key={ `track-${stage}` }
                sx={ {
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: STAGE_ROW[stage] * (ROW_HEIGHT + ROW_GAP),
                  height: ROW_HEIGHT,
                  bgcolor: trackBg,
                } }
              />
            )) }
            { model.bands.map((band, i) => (
              <Box
                key={ `${band.startMs}-${i}` }
                title={ `${STAGE_LABEL[band.stage]} · ${moment(band.startMs).format('HH:mm')}–${moment(band.endMs).format('HH:mm')}` }
                sx={ {
                  position: 'absolute',
                  top: STAGE_ROW[band.stage] * (ROW_HEIGHT + ROW_GAP),
                  height: ROW_HEIGHT,
                  left: `${band.leftPct}%`,
                  width: `${band.widthPct}%`,
                  bgcolor: stageColors[band.stage],
                  opacity: 0.9,
                  borderRadius: 0.5,
                  minWidth: 2,
                } }
              />
            )) }
          </Box>

          <Box sx={ { position: 'relative', height: 18, mt: 0.5 } }>
            { model.ticks.map((tick) => (
              <Typography
                key={ tick.label + tick.leftPct }
                variant="caption"
                color="text.secondary"
                sx={ {
                  position: 'absolute',
                  left: `${tick.leftPct}%`,
                  transform: tick.leftPct === 0
                    ? 'none'
                    : tick.leftPct === 100
                      ? 'translateX(-100%)'
                      : 'translateX(-50%)',
                  fontSize: '0.7rem',
                } }
              >
                { tick.label }
              </Typography>
            )) }
          </Box>
        </Box>
      </Box>
    </Card>
  );
}
