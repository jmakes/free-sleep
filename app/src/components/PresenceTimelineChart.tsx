import { useMemo } from 'react';
import { Box, Card, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import moment from 'moment-timezone';
import {
  BRIEF_GAP_SECONDS,
  MIN_MEANINGFUL_EXIT_SECONDS,
  classifyNotPresentIntervals,
  type IntervalPair,
} from '@lib/bedExits.ts';

type PresenceTimelineChartProps = {
  enteredBedAt?: string | number | Date | null;
  leftBedAt?: string | number | Date | null;
  notPresentIntervals?: IntervalPair[] | null;
  label?: string;
};

function toMs(value: string | number | Date): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return new Date(value).getTime();
}

const TICK_COUNT = 5;

/**
 * Overnight left→right presence strip: in-bed baseline with brief vs meaningful gaps.
 * Makes ~2 real exits visible amid cal flicker / brief gaps.
 */
export default function PresenceTimelineChart({
  enteredBedAt,
  leftBedAt,
  notPresentIntervals,
  label = 'Presence overnight',
}: PresenceTimelineChartProps) {
  const theme = useTheme();

  const model = useMemo(() => {
    if (enteredBedAt == null || leftBedAt == null) return null;
    const startMs = toMs(enteredBedAt);
    const endMs = toMs(leftBedAt);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;

    const durationMs = endMs - startMs;
    const gaps = classifyNotPresentIntervals(notPresentIntervals, {
      enteredBedAt: startMs,
      leftBedAt: endMs,
    }).map((gap) => {
      const clippedStart = Math.max(gap.startMs, startMs);
      const clippedEnd = Math.min(gap.endMs, endMs);
      return {
        ...gap,
        leftPct: ((clippedStart - startMs) / durationMs) * 100,
        widthPct: Math.max(0.15, ((clippedEnd - clippedStart) / durationMs) * 100),
      };
    });

    const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
      const t = startMs + (durationMs * i) / (TICK_COUNT - 1);
      return { leftPct: (i / (TICK_COUNT - 1)) * 100, label: moment(t).format('HH:mm') };
    });

    const counts = gaps.reduce(
      (acc, g) => {
        acc[g.kind] += 1;
        return acc;
      },
      { meaningful: 0, brief: 0, flicker: 0 },
    );

    return { startMs, endMs, gaps, ticks, counts };
  }, [enteredBedAt, leftBedAt, notPresentIntervals]);

  if (!model) return null;

  const inBedColor = theme.palette.mode === 'dark'
    ? 'rgba(76, 175, 80, 0.35)'
    : 'rgba(76, 175, 80, 0.28)';
  const meaningfulColor = theme.palette.error.main;
  const briefColor = theme.palette.warning.main;
  const flickerColor = theme.palette.grey[500];

  return (
    <Card sx={ { p: 2, mt: 2, backgroundColor: 'background.paper' } }>
      <Typography variant="h6" gutterBottom>{ label }</Typography>
      <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mb: 1.5 } }>
        Left → right overnight. Green = in bed. Red = counted exits (≥{ MIN_MEANINGFUL_EXIT_SECONDS / 60 }m away).
        Amber = brief gaps ({ BRIEF_GAP_SECONDS }s–{ MIN_MEANINGFUL_EXIT_SECONDS / 60 }m: tosses / short absences).
        Gray = flicker (&lt;{ BRIEF_GAP_SECONDS }s: cal noise — not in the main exit count).
      </Typography>

      <Stack direction="row" spacing={ 1 } flexWrap="wrap" useFlexGap sx={ { mb: 1 } }>
        <Typography variant="caption" color="text.secondary">
          { model.counts.meaningful } exit{ model.counts.meaningful === 1 ? '' : 's' } (≥5m)
          { ' · ' }
          { model.counts.brief } brief
          { model.counts.flicker > 0 ? ` · ${model.counts.flicker} flicker` : '' }
        </Typography>
      </Stack>

      <Box sx={ { position: 'relative', width: '100%', mb: 0.5 } }>
        <Box
          sx={ {
            position: 'relative',
            height: 28,
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: inBedColor,
            border: `1px solid ${theme.palette.divider}`,
          } }
        >
          { model.gaps.map((gap, i) => {
            const color =
              gap.kind === 'meaningful' ? meaningfulColor
                : gap.kind === 'brief' ? briefColor
                  : flickerColor;
            const opacity = gap.kind === 'flicker' ? 0.55 : 0.92;
            return (
              <Box
                key={ `${gap.startMs}-${i}` }
                title={ `${gap.kind}: ${gap.seconds}s · ${moment(gap.startMs).format('HH:mm')}–${moment(gap.endMs).format('HH:mm')}` }
                sx={ {
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${gap.leftPct}%`,
                  width: `${gap.widthPct}%`,
                  bgcolor: color,
                  opacity,
                  minWidth: 2,
                } }
              />
            );
          }) }
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

      <Stack direction="row" spacing={ 2 } flexWrap="wrap" useFlexGap sx={ { mt: 1 } }>
        { [
          { color: inBedColor, text: 'In bed' },
          { color: meaningfulColor, text: 'Exit ≥5m' },
          { color: briefColor, text: 'Brief gap' },
          { color: flickerColor, text: 'Flicker' },
        ].map((item) => (
          <Stack key={ item.text } direction="row" spacing={ 0.75 } alignItems="center">
            <Box sx={ {
              width: 12,
              height: 12,
              borderRadius: 0.5,
              bgcolor: item.color,
              border: `1px solid ${theme.palette.divider}`,
            } }
            />
            <Typography variant="caption" color="text.secondary">{ item.text }</Typography>
          </Stack>
        )) }
      </Stack>
    </Card>
  );
}
