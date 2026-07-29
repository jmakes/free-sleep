import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import SensorsIcon from '@mui/icons-material/Sensors';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import { useTheme } from '@mui/material/styles';

import PageContainer from '../../PageContainer.tsx';
import Header from '../Header.tsx';
import SideControl from '@components/SideControl.tsx';
import { useAppStore } from '@state/appStore.tsx';
import { useSettings } from '@api/settings.ts';
import {
  CapZoneEval,
  fetchSensorLive,
  SideSensorSnapshot,
} from '@api/sensors.ts';

const POLL_MS = 1_500;

function verdictChip(verdict: SideSensorSnapshot['liveVerdict']) {
  switch (verdict) {
    case 'likely_occupied':
      return { label: 'Likely occupied (cap + piezo above)', color: 'success' as const };
    case 'likely_empty':
      return { label: 'Likely empty (both below)', color: 'default' as const };
    case 'piezo_only':
      return { label: 'Piezo only above threshold', color: 'warning' as const };
    case 'cap_only':
      return { label: 'Cap only above threshold', color: 'warning' as const };
    default:
      return { label: 'Verdict unknown', color: 'default' as const };
  }
}

function zoneColor(evalZone?: CapZoneEval, aboveCombined?: boolean): string {
  if (!evalZone) return 'rgba(0,0,0,0.2)';
  // Green-ish when near empty mean; warm when elevated vs empty band
  if (evalZone.aboveEmptyBand || (aboveCombined && evalZone.zScore > 0.5)) {
    const t = Math.min(1, Math.max(0, evalZone.zScore / 5));
    return `rgba(244, 67, 54, ${0.25 + t * 0.5})`;
  }
  return 'rgba(76, 175, 80, 0.35)';
}

function CapZone({
  label,
  evalZone,
  combinedAbove,
}: {
  label: string;
  evalZone?: CapZoneEval;
  combinedAbove?: boolean;
}) {
  return (
    <Box
      sx={ {
        flex: 1,
        minHeight: 110,
        borderRadius: 2,
        border: '1px solid',
        borderColor: evalZone?.aboveEmptyBand ? 'warning.main' : 'divider',
        bgcolor: zoneColor(evalZone, combinedAbove),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 0.5,
        py: 1,
      } }
    >
      <Typography variant="caption" color="text.secondary">
        { label }
      </Typography>
      <Typography variant="h6" fontWeight={ 700 } lineHeight={ 1.1 }>
        { evalZone ? Math.round(evalZone.value) : '—' }
      </Typography>
      { evalZone && (
        <>
          <Typography variant="caption" sx={ { fontSize: '0.65rem', opacity: 0.9 } }>
            empty { Math.round(evalZone.emptyLow) }–{ Math.round(evalZone.emptyHigh) }
          </Typography>
          <Typography variant="caption" sx={ { fontSize: '0.65rem' } }>
            z={ evalZone.zScore.toFixed(2) }
          </Typography>
        </>
      ) }
    </Box>
  );
}

function ThresholdBar({
  label,
  value,
  threshold,
  format = (n: number) => n.toFixed(1),
  goodWhenBelow,
}: {
  label: string;
  value?: number;
  threshold: number;
  format?: (n: number) => string;
  /** true = empty bed should be below threshold */
  goodWhenBelow: boolean;
}) {
  if (value === undefined) {
    return (
      <Box sx={ { mb: 1.5 } }>
        <Typography variant="caption" color="text.secondary">{ label }: —</Typography>
      </Box>
    );
  }
  // Scale bar so threshold sits ~40% across for readability
  const max = Math.max(threshold * 2.5, value * 1.1, 1);
  const valuePct = Math.min(100, (value / max) * 100);
  const threshPct = Math.min(100, (threshold / max) * 100);
  const above = value >= threshold;
  const looksEmpty = goodWhenBelow ? !above : above;

  return (
    <Box sx={ { mb: 1.5 } }>
      <Box sx={ { display: 'flex', justifyContent: 'space-between', mb: 0.5 } }>
        <Typography variant="caption">{ label }</Typography>
        <Typography
          variant="caption"
          fontWeight={ 700 }
          color={ looksEmpty ? 'success.main' : 'warning.main' }
        >
          { format(value) } { above ? '≥' : '<' } { format(threshold) }{' '}
          { above ? '(above)' : '(below)' }
        </Typography>
      </Box>
      <Box sx={ { position: 'relative', height: 10, borderRadius: 1, bgcolor: 'grey.800' } }>
        <LinearProgress
          variant="determinate"
          value={ valuePct }
          sx={ {
            height: 10,
            borderRadius: 1,
            bgcolor: 'transparent',
            '& .MuiLinearProgress-bar': {
              bgcolor: above ? 'warning.main' : 'success.main',
            },
          } }
        />
        <Box
          sx={ {
            position: 'absolute',
            left: `${threshPct}%`,
            top: -2,
            bottom: -2,
            width: 2,
            bgcolor: 'error.light',
          } }
          title={ `threshold ${format(threshold)}` }
        />
      </Box>
    </Box>
  );
}

function BedSideViz({
  side,
  snapshot,
  sideName,
}: {
  side: 'left' | 'right';
  snapshot?: SideSensorSnapshot;
  sideName: string;
}) {
  const theme = useTheme();
  const capEval = snapshot?.calibration?.capEvaluation;
  const zonesKeys =
    side === 'left'
      ? (['out', 'cen', 'in'] as const)
      : (['in', 'cen', 'out'] as const);
  const labels = { out: 'Outer', cen: 'Center', in: 'Inner' };

  const piezoRange = snapshot?.piezo1?.range;
  const piezoThreshold =
    snapshot?.piezo1?.rangeThreshold ??
    snapshot?.thresholds?.piezo.rangeThreshold ??
    20_000;
  const piezoAbove = snapshot?.piezo1?.aboveThreshold
    ?? (piezoRange !== undefined && piezoRange >= piezoThreshold);
  const piezoGlow = Math.max(0, Math.min(1, (piezoRange ?? 0) / (piezoThreshold * 2)));

  return (
    <Paper
      variant="outlined"
      sx={ {
        p: 2,
        width: '100%',
        maxWidth: 440,
        borderRadius: 3,
        bgcolor: theme.palette.background.paper,
      } }
    >
      <Typography variant="subtitle1" fontWeight={ 700 } gutterBottom>
        { sideName } side · bed map + thresholds
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={ { mb: 1 } }>
        Cap: value vs empty-band (mean±2σ). Piezo: packet range vs presence threshold.
        Off bed → both below; on bed → both above (ideal).
      </Typography>

      <Box
        sx={ {
          border: `2px solid ${theme.palette.grey[700]}`,
          borderRadius: 2,
          p: 1.5,
          background: `linear-gradient(180deg, ${theme.palette.grey[900]} 0%, #0a0a0a 100%)`,
        } }
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={ { display: 'block', textAlign: 'center', mb: 1 } }
        >
          HEAD
        </Typography>

        <Stack direction="row" spacing={ 1 } sx={ { mb: 1.5 } }>
          { zonesKeys.map((key) => (
            <CapZone
              key={ key }
              label={ labels[key] }
              evalZone={ capEval?.zones[key] }
              combinedAbove={ capEval?.aboveThreshold }
            />
          )) }
        </Stack>

        <Box
          sx={ {
            height: 64,
            borderRadius: 1,
            border: '1px solid',
            borderColor: piezoAbove ? 'warning.main' : 'success.main',
            mb: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            background: `rgba(83, 147, 255, ${0.12 + piezoGlow * 0.55})`,
            boxShadow: piezoGlow > 0.25
              ? `0 0 ${12 + piezoGlow * 20}px rgba(83, 147, 255, ${piezoGlow})`
              : 'none',
            transition: 'background 0.3s, box-shadow 0.3s',
          } }
        >
          <Typography variant="caption" color="primary.light">
            Piezo strip (chest)
          </Typography>
          <Typography variant="body2" fontWeight={ 600 }>
            { piezoRange !== undefined
              ? `range ${piezoRange.toLocaleString()} ${piezoAbove ? '≥' : '<'} ${piezoThreshold.toLocaleString()}`
              : 'no piezo sample' }
          </Typography>
        </Box>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={ { display: 'block', textAlign: 'center' } }
        >
          FOOT
        </Typography>
      </Box>
    </Paper>
  );
}

function ValueRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: 'ok' | 'warn' | 'none';
}) {
  const color =
    emphasis === 'ok' ? 'success.main' : emphasis === 'warn' ? 'warning.main' : undefined;
  return (
    <Box
      sx={ {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 2,
        py: 0.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
      } }
    >
      <Typography variant="body2" color="text.secondary">
        { label }
      </Typography>
      <Typography
        variant="body2"
        fontFamily="monospace"
        fontWeight={ 600 }
        color={ color }
      >
        { value }
      </Typography>
    </Box>
  );
}

export default function SensorsPage() {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const sideName = settings?.[side]?.name?.trim() || (side === 'left' ? 'Left' : 'Right');

  const [running, setRunning] = useState(false);
  const [snapshot, setSnapshot] = useState<SideSensorSnapshot | undefined>();
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const sideRef = useRef(side);
  sideRef.current = side;

  const stop = useCallback(() => {
    setRunning(false);
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const data = await fetchSensorLive(sideRef.current);
      setSnapshot(data);
      if (data.error) {
        setPollError(data.error);
      } else {
        setPollError(null);
        setLastOkAt(new Date().toLocaleTimeString());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPollError(message);
    }
  }, []);

  const start = useCallback(() => {
    setRunning(true);
    void pollOnce();
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      void pollOnce();
    }, POLL_MS);
  }, [pollOnce]);

  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    if (running) void pollOnce();
  }, [side, running, pollOnce]);

  const capEval = snapshot?.calibration?.capEvaluation;
  const piezoThreshold =
    snapshot?.piezo1?.rangeThreshold ??
    snapshot?.thresholds?.piezo.rangeThreshold ??
    20_000;
  const verdict = snapshot?.liveVerdict ? verdictChip(snapshot.liveVerdict) : null;

  return (
    <PageContainer sx={ { mb: 15, gap: 1.5, mt: 0, alignItems: 'center' } }>
      <Header title="Sensors" icon={ <SensorsIcon /> } />
      <SideControl />

      <Stack direction="row" spacing={ 1 } alignItems="center" sx={ { width: '100%', maxWidth: 440 } }>
        <Button
          variant="contained"
          color={ running ? 'warning' : 'primary' }
          startIcon={ running ? <StopIcon /> : <PlayArrowIcon /> }
          onClick={ () => (running ? stop() : start()) }
          fullWidth
        >
          { running ? 'Stop stream' : 'Start stream' }
        </Button>
        { running && <Chip size="small" color="success" label="Live" /> }
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={ { maxWidth: 440, textAlign: 'center' } }>
        Live RAW samples vs sleep-analysis thresholds. Off bed: cap combined z and piezo range
        should stay <strong>below</strong> thresholds. On bed: ideally <strong>above</strong> both.
        Power on / occupancy not required for empty-bed readings.
      </Typography>

      { pollError && (
        <Alert severity="warning" sx={ { width: '100%', maxWidth: 440 } }>
          { pollError }
        </Alert>
      ) }

      { snapshot?.calibration?.missing && (
        <Alert severity="warning" sx={ { width: '100%', maxWidth: 440 } }>
          { snapshot.calibration.hint ||
            'No cap baseline for this side. Run Status → Calibrate with an empty bed.' }
        </Alert>
      ) }

      { verdict && snapshot && !pollError && (
        <Chip
          label={ verdict.label }
          color={ verdict.color }
          variant={ verdict.color === 'default' ? 'outlined' : 'filled' }
        />
      ) }

      <BedSideViz side={ side } snapshot={ snapshot } sideName={ sideName } />

      { /* Threshold comparison */ }
      <Paper variant="outlined" sx={ { p: 2, width: '100%', maxWidth: 440, borderRadius: 3 } }>
        <Typography variant="subtitle2" gutterBottom>
          Live vs thresholds · { sideName }
        </Typography>
        { !snapshot && (
          <Typography variant="body2" color="text.secondary">
            Start stream to compare live values with calibration.
          </Typography>
        ) }
        { snapshot && (
          <>
            <ThresholdBar
              label="Cap combined z-score"
              value={ capEval?.combinedZ }
              threshold={
                capEval?.occupancyThreshold ??
                snapshot.thresholds?.cap.occupancyThreshold ??
                5
              }
              goodWhenBelow
            />
            <ThresholdBar
              label="Piezo packet range"
              value={ snapshot.piezo1?.range }
              threshold={ piezoThreshold }
              format={ (n) => Math.round(n).toLocaleString() }
              goodWhenBelow
            />
            <Typography variant="caption" color="text.secondary" display="block">
              { snapshot.thresholds?.cap.description }
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" sx={ { mt: 0.5 } }>
              { snapshot.thresholds?.piezo.description }
            </Typography>
            { snapshot.calibration?.capBaseline?.mtime && (
              <Typography variant="caption" color="text.secondary" display="block" sx={ { mt: 1 } }>
                Cap baseline file mtime:{' '}
                { new Date(snapshot.calibration.capBaseline.mtime).toLocaleString() }
              </Typography>
            ) }
          </>
        ) }
      </Paper>

      { /* Numeric + baseline table */ }
      <Paper variant="outlined" sx={ { p: 2, width: '100%', maxWidth: 440, borderRadius: 3 } }>
        <Typography variant="subtitle2" gutterBottom>
          Calibration detail · { sideName }
        </Typography>
        { !snapshot && !running && (
          <Typography variant="body2" color="text.secondary">
            Press Start stream to poll sensors.
          </Typography>
        ) }
        { snapshot && (
          <Box>
            <ValueRow label="Sample time" value={ lastOkAt || '—' } />
            <ValueRow label="Source file" value={ snapshot.sourceFile || '—' } />
            <Typography variant="caption" color="text.secondary" sx={ { mt: 1.5, display: 'block' } }>
              Capacitance (value · empty mean±2σ · z)
            </Typography>
            { (['out', 'cen', 'in'] as const).map((zone) => {
              const evalZone = capEval?.zones[zone];
              const raw = snapshot.cap?.[zone];
              if (!evalZone && raw === undefined) {
                return <ValueRow key={ zone } label={ zone } value="—" />;
              }
              if (!evalZone) {
                return <ValueRow key={ zone } label={ zone } value={ String(raw) } />;
              }
              return (
                <ValueRow
                  key={ zone }
                  label={ `${zone}` }
                  value={
                    `${Math.round(evalZone.value)} · empty ${Math.round(evalZone.mean)}±${Math.round(2 * evalZone.std)} · z ${evalZone.zScore.toFixed(2)}`
                  }
                  emphasis={ evalZone.aboveEmptyBand ? 'warn' : 'ok' }
                />
              );
            }) }
            <ValueRow
              label="Cap combined z"
              value={
                capEval
                  ? `${capEval.combinedZ.toFixed(2)} (threshold ${capEval.occupancyThreshold})`
                  : '—'
              }
              emphasis={
                capEval
                  ? (capEval.aboveThreshold ? 'warn' : 'ok')
                  : 'none'
              }
            />
            <Typography variant="caption" color="text.secondary" sx={ { mt: 1.5, display: 'block' } }>
              Piezo channel 1
            </Typography>
            <ValueRow
              label="Range"
              value={
                snapshot.piezo1
                  ? `${snapshot.piezo1.range.toLocaleString()} (threshold ${piezoThreshold.toLocaleString()})`
                  : '—'
              }
              emphasis={
                snapshot.piezo1
                  ? (snapshot.piezo1.range >= piezoThreshold ? 'warn' : 'ok')
                  : 'none'
              }
            />
            <ValueRow
              label="Avg / min / max"
              value={
                snapshot.piezo1
                  ? `${snapshot.piezo1.avg.toLocaleString()} / ${snapshot.piezo1.min.toLocaleString()} / ${snapshot.piezo1.max.toLocaleString()}`
                  : '—'
              }
            />
            <ValueRow
              label="Samples / packet"
              value={ snapshot.piezo1 ? String(snapshot.piezo1.sampleCount) : '—' }
            />
          </Box>
        ) }
      </Paper>

      <Typography variant="caption" color="text.secondary" sx={ { maxWidth: 440 } }>
        Green ≈ below presence threshold (expect when off bed). Amber/red ≈ above threshold
        (expect when on bed). Single samples are approximate; sleep analysis also uses a short
        rolling window. Cap baseline comes from empty-bed calibration.
      </Typography>
    </PageContainer>
  );
}
