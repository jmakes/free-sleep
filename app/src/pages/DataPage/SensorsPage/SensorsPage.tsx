import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Stack,
  Step,
  StepLabel,
  Stepper,
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
  fetchPoseCalibrationStatus,
  fetchSensorLive,
  PoseCalibrationResult,
  PoseName,
  postPoseCalibration,
  SideSensorSnapshot,
} from '@api/sensors.ts';

const POLL_MS = 1_500;
const MIN_REPS = 2;

const POSE_STEPS: { pose: PoseName; label: string; help: string }[] = [
  {
    pose: 'unoccupied',
    label: 'Unoccupied',
    help: 'Leave this side completely empty (no person, heavy blanket piles ok if stable). Hold still ~15s.',
  },
  {
    pose: 'center',
    label: 'Center',
    help: 'Lie on your back in the center of this side. Stay still ~15s.',
  },
  {
    pose: 'inner',
    label: 'Inner',
    help: 'Lie toward the inner edge of this side (toward the other person). Stay still ~15s.',
  },
  {
    pose: 'outer',
    label: 'Outer',
    help: 'Lie toward the outer edge of this side. Stay still ~15s.',
  },
];

function verdictChip(verdict: SideSensorSnapshot['liveVerdict']) {
  switch (verdict) {
    case 'likely_occupied':
      return { label: 'Likely occupied (cap + piezo above)', color: 'success' as const };
    case 'likely_empty':
      return { label: 'Likely empty (both below)', color: 'default' as const };
    case 'piezo_only':
      return { label: 'Piezo only (primary path OK)', color: 'warning' as const };
    case 'cap_only':
      return { label: 'Cap only (soft assist)', color: 'warning' as const };
    default:
      return { label: 'Verdict unknown', color: 'default' as const };
  }
}

function zoneColor(evalZone?: CapZoneEval, aboveCombined?: boolean): string {
  if (!evalZone) return 'rgba(0,0,0,0.2)';
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
  goodWhenBelow: boolean;
}) {
  if (value === undefined) {
    return (
      <Box sx={ { mb: 1.5 } }>
        <Typography variant="caption" color="text.secondary">{ label }: —</Typography>
      </Box>
    );
  }
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
    50_000;
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
        Cap: max-z vs empty band. Piezo: packet range vs floor (primary). Fusion: piezo OR cap.
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

function GuidedCalibration({
  side,
  sideName,
}: {
  side: 'left' | 'right';
  sideName: string;
}) {
  const [activeStep, setActiveStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [status, setStatus] = useState<PoseCalibrationResult['status']>();
  const [lastFinalize, setLastFinalize] = useState<PoseCalibrationResult | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const result = await fetchPoseCalibrationStatus(side);
      setStatus(result.status);
      if (result.error) setError(result.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }, [side]);

  useEffect(() => {
    void refreshStatus();
  }, [side, refreshStatus]);

  const counts = status?.counts;
  const pose = POSE_STEPS[activeStep]?.pose;
  const poseCount = pose && counts ? (counts[pose] ?? 0) : 0;
  const ready = Boolean(status?.ready_to_finalize);

  const runAction = async (
    action: 'capture' | 'finalize' | 'reset',
    poseName?: PoseName,
  ) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await postPoseCalibration({
        side,
        action,
        pose: poseName,
        seconds: 15,
      });
      if (result.status) setStatus(result.status);
      if (result.ok === false || result.error) {
        setError(result.error || 'Calibration step failed');
      } else if (action === 'capture') {
        setInfo(
          `Captured ${result.pose} rep #${result.rep_index}. ` +
          `${result.status?.counts?.[result.pose as PoseName] ?? '?'}/${MIN_REPS} for this pose.`,
        );
        // Auto-advance when this pose has enough reps
        const newCount = result.status?.counts?.[poseName as PoseName] ?? 0;
        if (newCount >= MIN_REPS && activeStep < POSE_STEPS.length - 1) {
          setActiveStep((step) => step + 1);
        }
      } else if (action === 'finalize') {
        setLastFinalize(result);
        const thresh = result.thresholds;
        setInfo(
          thresh
            ? `Saved thresholds: cap max-z ≥ ${thresh.cap_zone_threshold}, ` +
              `piezo floor ≥ ${thresh.piezo_range_threshold?.toLocaleString()}.`
            : 'Calibration finalized and saved.',
        );
      } else if (action === 'reset') {
        setLastFinalize(null);
        setActiveStep(0);
        setInfo('Session reset. Start again with unoccupied.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper
      variant="outlined"
      sx={ {
        p: 2,
        width: '100%',
        maxWidth: 440,
        borderRadius: 3,
        borderColor: 'primary.main',
        borderWidth: 2,
      } }
    >
      <Typography variant="subtitle1" fontWeight={ 700 } gutterBottom>
        Guided Calibration · { sideName }
      </Typography>
      <Alert severity="info" sx={ { mb: 1.5 } }>
        <strong>Start stream is not required.</strong> Capture reads the Pod RAW files
        directly. Use the live stream above only if you want to watch sensors while you hold a pose.
      </Alert>
      <Typography variant="caption" color="text.secondary" display="block" sx={ { mb: 1 } }>
        Hold each pose and capture <strong>twice</strong> (unoccupied → center → inner → outer).
        On finalize, the two reps for each pose are <strong>averaged</strong> (mean of each
        rep&apos;s zone mean). Empty-bed std also uses the larger of within-rep noise and
        rep-to-rep spread, so a shaky second take does not understate empty variance.
        That sets empty baseline, cap max-z threshold, and a per-side piezo floor.
      </Typography>

      <Stepper activeStep={ activeStep } alternativeLabel sx={ { mb: 2 } }>
        { POSE_STEPS.map((step) => {
          const count = counts?.[step.pose] ?? 0;
          const done = count >= MIN_REPS;
          return (
            <Step key={ step.pose } completed={ done }>
              <StepLabel
                optional={
                  <Typography variant="caption" color={ done ? 'success.main' : 'text.secondary' }>
                    { count }/{ MIN_REPS }
                  </Typography>
                }
              >
                { step.label }
              </StepLabel>
            </Step>
          );
        }) }
      </Stepper>

      { POSE_STEPS[activeStep] && (
        <Alert severity="info" sx={ { mb: 1.5 } }>
          <strong>{ POSE_STEPS[activeStep].label }</strong>
          { ' — ' }
          { POSE_STEPS[activeStep].help }
          { poseCount > 0 && ` (${poseCount}/${MIN_REPS} captured)` }
        </Alert>
      ) }

      { error && (
        <Alert severity="error" sx={ { mb: 1.5 } } onClose={ () => setError(null) }>
          { error }
        </Alert>
      ) }
      { info && (
        <Alert severity="success" sx={ { mb: 1.5 } } onClose={ () => setInfo(null) }>
          { info }
        </Alert>
      ) }

      <Stack direction="row" spacing={ 1 } sx={ { mb: 1 } }>
        <Button
          variant="contained"
          disabled={ busy || !pose }
          onClick={ () => void runAction('capture', pose) }
          fullWidth
        >
          { busy ? 'Sampling…' : `Capture ${POSE_STEPS[activeStep]?.label ?? ''} (~15s)` }
        </Button>
      </Stack>
      <Stack direction="row" spacing={ 1 }>
        <Button
          size="small"
          disabled={ busy || activeStep === 0 }
          onClick={ () => setActiveStep((s) => Math.max(0, s - 1)) }
        >
          Prev
        </Button>
        <Button
          size="small"
          disabled={ busy || activeStep >= POSE_STEPS.length - 1 }
          onClick={ () => setActiveStep((s) => Math.min(POSE_STEPS.length - 1, s + 1)) }
        >
          Next pose
        </Button>
        <Box sx={ { flex: 1 } } />
        <Button
          size="small"
          color="warning"
          disabled={ busy }
          onClick={ () => void runAction('reset') }
        >
          Reset
        </Button>
      </Stack>

      <Button
        sx={ { mt: 1.5 } }
        variant="outlined"
        color="success"
        disabled={ busy || !ready }
        fullWidth
        onClick={ () => void runAction('finalize') }
      >
        { ready ? 'Finalize & save thresholds' : `Need ${MIN_REPS}× each pose to finalize` }
      </Button>

      { lastFinalize?.thresholds && (
        <Box sx={ { mt: 1.5 } }>
          <Typography variant="caption" color="text.secondary" display="block">
            Last save: max-z ≥ { lastFinalize.thresholds.cap_zone_threshold }
            { ' · ' }
            piezo ≥ { lastFinalize.thresholds.piezo_range_threshold?.toLocaleString() }
          </Typography>
          { lastFinalize.thresholds.separation_z && (
            <Typography variant="caption" color="text.secondary" display="block">
              Zone separation z:{' '}
              { Object.entries(lastFinalize.thresholds.separation_z)
                .map(([zone, value]) => `${zone}=${value}`)
                .join(', ') }
            </Typography>
          ) }
        </Box>
      ) }
    </Paper>
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
    50_000;
  const capThreshold =
    capEval?.occupancyThreshold ??
    snapshot?.thresholds?.cap.occupancyThreshold ??
    2;
  const capScoreLabel =
    (capEval?.method || snapshot?.thresholds?.cap.method || 'max_z') === 'sum_z'
      ? 'Cap sum z-score'
      : 'Cap max z-score';
  const verdict = snapshot?.liveVerdict ? verdictChip(snapshot.liveVerdict) : null;
  const fusionNote = snapshot?.thresholds?.fusion?.description;

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
        <strong>Start stream</strong> is only for live visualization (optional).
        Sleep fusion is <strong>piezo-primary</strong> with cap soft assist (OR).
        Cap uses <strong>max-z</strong> across out/cen/in. Guided Calibration at the bottom
        does not need the stream running.
      </Typography>

      { pollError && (
        <Alert severity="warning" sx={ { width: '100%', maxWidth: 440 } }>
          { pollError }
        </Alert>
      ) }

      { snapshot?.calibration?.missing && (
        <Alert severity="warning" sx={ { width: '100%', maxWidth: 440 } }>
          { snapshot.calibration.hint ||
            'No cap baseline for this side. Scroll down to Guided Calibration, or Status → empty-bed Calibrate.' }
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
              label={ capScoreLabel }
              value={ capEval?.combinedZ }
              threshold={ capThreshold }
              goodWhenBelow
            />
            <ThresholdBar
              label={
                snapshot.thresholds?.piezo.personalized
                  ? 'Piezo range (personalized floor)'
                  : 'Piezo packet range'
              }
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
            { fusionNote && (
              <Typography variant="caption" color="text.secondary" display="block" sx={ { mt: 0.5 } }>
                { fusionNote }
              </Typography>
            ) }
            { snapshot.calibration?.capBaseline?.mtime && (
              <Typography variant="caption" color="text.secondary" display="block" sx={ { mt: 1 } }>
                Cap baseline file mtime:{' '}
                { new Date(snapshot.calibration.capBaseline.mtime).toLocaleString() }
                { snapshot.calibration.capBaseline.source
                  ? ` · source=${snapshot.calibration.capBaseline.source}`
                  : '' }
              </Typography>
            ) }
          </>
        ) }
      </Paper>

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
              label={ capScoreLabel }
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
            { capEval?.maxZ !== undefined && (
              <ValueRow
                label="max_z / sum_z"
                value={ `${capEval.maxZ.toFixed(2)} / ${(capEval.sumZ ?? 0).toFixed(2)}` }
              />
            ) }
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
        (expect when on bed). Sleep analysis also uses a short rolling window and requires
        &gt;3h continuous presence with gaps ≤15m.
      </Typography>

      { /* Rare setup flow — keep below live visualization */ }
      <GuidedCalibration side={ side } sideName={ sideName } />
    </PageContainer>
  );
}
