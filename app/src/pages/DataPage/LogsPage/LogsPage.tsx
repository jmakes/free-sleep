import { useEffect, useState, useRef, useCallback } from 'react';
import { baseURL } from '@api/api';
import {
  Paper,
  Typography,
  Box,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Button,
  Stack,
  Chip,
  TextField,
} from '@mui/material';
import PageContainer from '../../PageContainer.tsx';
import { useTheme } from '@mui/material/styles';
import axios from 'axios';
import Header from '../Header.tsx';
import TextSnippetIcon from '@mui/icons-material/TextSnippet';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';


const MAX_BUFFERED_LINES = 1000;

export default function LogsPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [logFiles, setLogFiles] = useState<string[]>([]);
  const [selectedLog, setSelectedLog] = useState<string>('');
  const [frozen, setFrozen] = useState(false);
  const [exportCount, setExportCount] = useState(200);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const logsContainerRef = useRef<HTMLDivElement | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const isUserAtBottom = useRef(true);
  /** Lines arrived while frozen — flushed on resume */
  const pendingWhileFrozen = useRef<string[]>([]);
  const frozenRef = useRef(false);
  const theme = useTheme();

  useEffect(() => {
    frozenRef.current = frozen;
  }, [frozen]);

  // Fetch available log files
  useEffect(() => {
    const fetchLogFiles = async () => {
      try {
        const response = await axios.get<{ logs: string[] }>(`${baseURL}/api/logs`);
        if (response.data.logs.length > 0) {
          setLogFiles(response.data.logs);
          setSelectedLog(response.data.logs[0]);
        }
      } catch (error) {
        console.error('Error fetching log files:', error);
      }
    };

    fetchLogFiles();
  }, []);

  // Subscribe to log updates for the selected file
  useEffect(() => {
    if (!selectedLog) return;

    pendingWhileFrozen.current = [];
    const eventSource = new EventSource(`${baseURL}/api/logs/${selectedLog}`);

    eventSource.onmessage = (event) => {
      try {
        const logData = JSON.parse(event.data);
        const line = logData.message as string;
        if (frozenRef.current) {
          // Hold lines so the visible buffer (and text selection) stays stable
          pendingWhileFrozen.current = [
            ...pendingWhileFrozen.current.slice(-(MAX_BUFFERED_LINES - 1)),
            line,
          ];
          return;
        }
        setLogs((prevLogs) => [...prevLogs.slice(-(MAX_BUFFERED_LINES - 1)), line]);
      } catch {
        // ignore malformed frames
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [selectedLog]);

  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    isUserAtBottom.current = scrollHeight - scrollTop <= clientHeight + 50;
  };

  // Auto-scroll only if not frozen and user is at the bottom
  useEffect(() => {
    if (frozen) return;
    if (isUserAtBottom.current) {
      logsEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [logs, frozen]);

  const handleToggleFreeze = () => {
    if (frozen) {
      // Resume: append buffered lines
      const pending = pendingWhileFrozen.current;
      pendingWhileFrozen.current = [];
      if (pending.length > 0) {
        setLogs((prev) => [...prev, ...pending].slice(-MAX_BUFFERED_LINES));
      }
      setFrozen(false);
      // Snap to bottom on resume so live tail is visible
      requestAnimationFrame(() => {
        isUserAtBottom.current = true;
        logsEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    } else {
      setFrozen(true);
    }
  };

  const sliceForExport = useCallback(() => {
    const n = Math.min(MAX_BUFFERED_LINES, Math.max(1, Math.floor(exportCount) || 200));
    return logs.slice(-n);
  }, [logs, exportCount]);

  const handleExport = () => {
    const lines = sliceForExport();
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `${selectedLog || 'free-sleep'}-${stamp}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    const text = sliceForExport().join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`Copied ${sliceForExport().length} lines`);
    } catch {
      // Fallback for older browsers / non-secure contexts
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        setCopyStatus(`Copied ${sliceForExport().length} lines`);
      } catch {
        setCopyStatus('Copy failed — try Export instead');
      }
      document.body.removeChild(area);
    }
    window.setTimeout(() => setCopyStatus(null), 2_500);
  };

  const pendingCount = frozen ? pendingWhileFrozen.current.length : 0;

  return (
    <PageContainer
      sx={ {
        [theme.breakpoints.up('sm')]: {
          width: '95%',
          padding: 0,
          paddingTop: 6,
          paddingBottom: 6,
          maxWidth: '100%',
          height: '100%',
        },
      } }
    >
      <Header title="Logs" icon={ <TextSnippetIcon /> }/>

      <Paper
        elevation={ 3 }
        sx={ {
          p: 2,
          bgcolor: theme.palette.background.paper,
          color: '#fff',
          borderRadius: 2,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          [theme.breakpoints.up('sm')]: {
            width: '100%',
          },
        } }
      >
        <Stack
          direction={ { xs: 'column', sm: 'row' } }
          spacing={ 1 }
          alignItems={ { xs: 'stretch', sm: 'center' } }
          sx={ { mb: 1.5, flexWrap: 'wrap', gap: 1 } }
        >
          <FormControl sx={ { minWidth: 180, flex: 1 } } size="small">
            <InputLabel sx={ { color: theme.palette.grey[100] } }>Log file</InputLabel>
            <Select
              value={ selectedLog }
              label="Log file"
              onChange={ (e) => {
                setLogs([]);
                pendingWhileFrozen.current = [];
                setSelectedLog(e.target.value);
              } }
            >
              { logFiles.map((file) => (
                <MenuItem key={ file } value={ file }>
                  { file }
                </MenuItem>
              )) }
            </Select>
          </FormControl>

          <Button
            variant={ frozen ? 'contained' : 'outlined' }
            color={ frozen ? 'warning' : 'primary' }
            size="small"
            startIcon={ frozen ? <PlayArrowIcon /> : <PauseIcon /> }
            onClick={ handleToggleFreeze }
          >
            { frozen ? 'Resume' : 'Freeze' }
          </Button>

          <TextField
            label="Lines"
            type="number"
            size="small"
            value={ exportCount }
            onChange={ (e) => setExportCount(Math.min(1000, Math.max(1, Number(e.target.value) || 1))) }
            inputProps={ { min: 1, max: 1000, step: 50 } }
            sx={ { width: 100 } }
          />

          <Button
            variant="outlined"
            size="small"
            startIcon={ <ContentCopyIcon /> }
            onClick={ handleCopy }
            disabled={ logs.length === 0 }
          >
            Copy
          </Button>

          <Button
            variant="outlined"
            size="small"
            startIcon={ <DownloadIcon /> }
            onClick={ handleExport }
            disabled={ logs.length === 0 }
          >
            Export
          </Button>
        </Stack>

        <Box sx={ { display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' } }>
          <Typography
            variant="h6"
            sx={ {
              fontWeight: 'bold',
              color: theme.palette.grey[100],
              flex: 1,
            } }
          >
            Live Server Logs
          </Typography>
          { frozen && (
            <Chip
              size="small"
              color="warning"
              label={ pendingCount > 0 ? `Frozen · ${pendingCount} new lines waiting` : 'Frozen' }
            />
          ) }
          { copyStatus && (
            <Chip size="small" color="success" label={ copyStatus } />
          ) }
          <Typography variant="caption" color="text.secondary">
            { logs.length } lines buffered
          </Typography>
        </Box>

        <Box
          ref={ logsContainerRef }
          onScroll={ handleScroll }
          sx={ {
            flex: 1,
            overflowY: 'auto',
            maxHeight: `${window.innerHeight - 320}px`,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            p: 1,
            border: frozen ? `1px solid ${theme.palette.warning.main}` : `1px solid ${theme.palette.grey[800]}`,
            borderRadius: 1,
            userSelect: 'text',
            '&::-webkit-scrollbar': {
              width: '10px',
            },
            '&::-webkit-scrollbar-track': {
              background: theme.palette.background.paper,
              borderRadius: '5px',
            },
            '&::-webkit-scrollbar-thumb': {
              background: theme.palette.grey[600],
              borderRadius: '5px',
            },
            '&::-webkit-scrollbar-thumb:hover': {
              background: theme.palette.grey[500],
            },
          } }
        >
          <Typography
            component="pre"
            sx={ {
              fontFamily: 'monospace',
              color: theme.palette.grey[200],
              fontSize: '12px',
              m: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            } }
          >
            { logs.join('\n') }
          </Typography>
          <div ref={ logsEndRef } />
        </Box>

        <Typography variant="caption" color="text.secondary" sx={ { mt: 1 } }>
          Tip: Freeze before selecting text, or use Copy / Export for the last N lines.
        </Typography>
      </Paper>
    </PageContainer>
  );
}
