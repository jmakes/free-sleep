import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
// Stack used for cap zones + controls
import SensorsIcon from '@mui/icons-material/Sensors';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import { useTheme } from '@mui/material/styles';

import PageContainer from '../../PageContainer.tsx';
import Header from '../Header.tsx';
import SideControl from '@components/SideControl.tsx';
import { useAppStore } from '@state/appStore.tsx';
import { useSettings } from '@api/settings.ts';
import { fetchSensorLive, SideSensorSnapshot } from '@api/sensors.ts';

const POLL_MS = 1_500;

function heatColor(value: number, baseline: number, span: number): string {
  // Map deviation from a soft baseline into blue → green → amber → red
  const t = Math.max(0, Math.min(1, (value - baseline) / Math.max(span, 1)));
  if (t < 0.33) return `rgba(33, 150, 243, ${0.25 + t})`;
  if (t < 0.66) return `rgba(76, 175, 80, ${0.35 + t * 0.4})`;
  return `rgba(244, 67, 54, ${0.35 + t * 0.5})`;
}

function piezoIntensity(range: number | undefined): number {
  if (range === undefined) return 0;
  // Typical presence range thresholds in analysis are ~10k–20k
  return Math.max(0, Math.min(1, range / 40_000));
}

function CapZone({
  label,
  value,
  color,
}: {
  label: string;
  value?: number;
  color: string;
}) {
  return (
    <Box
      sx={ {
        flex: 1,
        minHeight: 88,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: color,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 1,
      } }
    >
      <Typography variant="caption" color="text.secondary">
        { label }
      </Typography>
      <Typography variant="h6" fontWeight={ 700 }>
        { value !== undefined ? value : '—' }
      </Typography>
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
  const cap = snapshot?.cap;
  // Soft baselines for color only (empty-ish cap values vary by pod)
  const baseline = 400;
  const span = 800;

  // Physical layout (top of screen = head of bed):
  // Cap zones out/cen/in: outer edge → center of side → toward mattress midline.
  // Left side: out is screen-left; right side: out is screen-right.
  const zones =
    side === 'left'
      ? [
        { key: 'out', label: 'Outer', value: cap?.out },
        { key: 'cen', label: 'Center', value: cap?.cen },
        { key: 'in', label: 'Inner', value: cap?.in },
      ]
      : [
        { key: 'in', label: 'Inner', value: cap?.in },
        { key: 'cen', label: 'Center', value: cap?.cen },
        { key: 'out', label: 'Outer', value: cap?.out },
      ];

  const piezoRange = snapshot?.piezo1?.range;
  const piezoGlow = piezoIntensity(piezoRange);

  return (
    <Paper
      variant="outlined"
      sx={ {
        p: 2,
        width: '100%',
        maxWidth: 420,
        borderRadius: 3,
        bgcolor: theme.palette.background.paper,
      } }
    >
      <Typography variant="subtitle1" fontWeight={ 700 } gutterBottom>
        { sideName } side · bed map
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={ { mb: 1.5 } }>
        Head of bed ↑ · Cap zones (out / cen / in) · Piezo strip at chest level
        (Eight Sleep places the piezo band across the torso)
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

        { /* Capacitance zones */ }
        <Stack direction="row" spacing={ 1 } sx={ { mb: 1.5 } }>
          { zones.map((zone) => (
            <CapZone
              key={ zone.key }
              label={ zone.label }
              value={ zone.value }
              color={
                zone.value !== undefined
                  ? heatColor(zone.value, baseline, span)
                  : theme.palette.grey[900]
              }
            />
          )) }
        </Stack>

        { /* Piezo strip */ }
        <Box
          sx={ {
            height: 56,
            borderRadius: 1,
            border: '1px dashed',
            borderColor: 'primary.main',
            mb: 1.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            background: `rgba(83, 147, 255, ${0.15 + piezoGlow * 0.55})`,
            boxShadow: piezoGlow > 0.3
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
              ? `range ${piezoRange.toLocaleString()} · avg ${snapshot?.piezo1?.avg.toLocaleString()}`
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

function ValueRow({ label, value }: { label: string; value: string }) {
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
      <Typography variant="body2" fontFamily="monospace" fontWeight={ 600 }>
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

  // Stop when leaving the page
  useEffect(() => () => stop(), [stop]);

  // If side changes while running, keep streaming the new side
  useEffect(() => {
    if (running) void pollOnce();
  }, [side, running, pollOnce]);

  return (
    <PageContainer sx={ { mb: 15, gap: 1.5, mt: 0, alignItems: 'center' } }>
      <Header title="Sensors" icon={ <SensorsIcon /> } />
      <SideControl />

      <Stack direction="row" spacing={ 1 } alignItems="center" sx={ { width: '100%', maxWidth: 420 } }>
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

      <Typography variant="caption" color="text.secondary" sx={ { maxWidth: 420, textAlign: 'center' } }>
        Polls the latest Pod <code>.RAW</code> file while streaming. Does <strong>not</strong> require
        the side to be powered on or someone in bed — empty-bed samples still produce cap/piezo
        readings. RAW capture usually needs the Pod offline / cloud blocked, and biometrics enabled.
      </Typography>

      { pollError && (
        <Alert severity="warning" sx={ { width: '100%', maxWidth: 420 } }>
          { pollError }
        </Alert>
      ) }

      { running && snapshot && !pollError && !snapshot.cap && !snapshot.piezo1 && (
        <Alert severity="info" sx={ { width: '100%', maxWidth: 420 } }>
          Connected but no frames yet. Waiting for capSense / piezo-dual in the RAW tail…
        </Alert>
      ) }

      <BedSideViz side={ side } snapshot={ snapshot } sideName={ sideName } />

      <Paper
        variant="outlined"
        sx={ { p: 2, width: '100%', maxWidth: 420, borderRadius: 3 } }
      >
        <Typography variant="subtitle2" gutterBottom>
          Numeric readout · { sideName }
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
            <ValueRow label="File mtime" value={ snapshot.fileMtime
              ? new Date(snapshot.fileMtime).toLocaleString()
              : '—' }
            />
            <Typography variant="caption" color="text.secondary" sx={ { mt: 1.5, display: 'block' } }>
              Capacitance
            </Typography>
            <ValueRow label="Outer (out)" value={ snapshot.cap ? String(snapshot.cap.out) : '—' } />
            <ValueRow label="Center (cen)" value={ snapshot.cap ? String(snapshot.cap.cen) : '—' } />
            <ValueRow label="Inner (in)" value={ snapshot.cap ? String(snapshot.cap.in) : '—' } />
            <ValueRow label="Cap status" value={ snapshot.cap?.status || '—' } />
            <ValueRow label="Cap ts" value={ snapshot.cap?.ts || '—' } />
            <Typography variant="caption" color="text.secondary" sx={ { mt: 1.5, display: 'block' } }>
              Piezo channel 1
            </Typography>
            <ValueRow
              label="Avg"
              value={ snapshot.piezo1 ? snapshot.piezo1.avg.toLocaleString() : '—' }
            />
            <ValueRow
              label="Min / Max"
              value={
                snapshot.piezo1
                  ? `${snapshot.piezo1.min.toLocaleString()} / ${snapshot.piezo1.max.toLocaleString()}`
                  : '—'
              }
            />
            <ValueRow
              label="Range"
              value={ snapshot.piezo1 ? snapshot.piezo1.range.toLocaleString() : '—' }
            />
            <ValueRow
              label="Samples / packet"
              value={ snapshot.piezo1 ? String(snapshot.piezo1.sampleCount) : '—' }
            />
            { snapshot.piezo2 && (
              <>
                <Typography variant="caption" color="text.secondary" sx={ { mt: 1.5, display: 'block' } }>
                  Piezo channel 2
                </Typography>
                <ValueRow label="Avg" value={ snapshot.piezo2.avg.toLocaleString() } />
                <ValueRow label="Range" value={ snapshot.piezo2.range.toLocaleString() } />
              </>
            ) }
          </Box>
        ) }
      </Paper>

      <Typography variant="caption" color="text.secondary" sx={ { maxWidth: 420 } }>
        Layout note: exact Pod 4 fabric placement is not fully public. Cap labels follow free-sleep&apos;s
        out/cen/in naming (outer edge → midline). Piezo is shown as a chest-level band per Eight Sleep&apos;s
        published sensor strip location.
      </Typography>
    </PageContainer>
  );
}
