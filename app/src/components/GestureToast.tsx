import { useEffect, useRef, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import { fetchRecentGestures, GestureEvent } from '@api/gestures.ts';

/**
 * Polls for cover-tap gesture events and shows a brief toast.
 */
export default function GestureToast() {
  const lastSeenId = useRef<string | undefined>(undefined);
  const [queue, setQueue] = useState<GestureEvent[]>([]);
  const [current, setCurrent] = useState<GestureEvent | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const events = await fetchRecentGestures(lastSeenId.current);
        if (cancelled || events.length === 0) return;

        // events are newest-first; take only new ones and enqueue oldest-first
        const newestFirst = events;
        if (!lastSeenId.current) {
          // First poll: do not spam history; only remember the tip
          lastSeenId.current = newestFirst[0]?.id;
          return;
        }

        const fresh = [...newestFirst].reverse();
        lastSeenId.current = newestFirst[0].id;
        setQueue((prev) => [...prev, ...fresh]);
      } catch {
        // silent — pod may be restarting
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 2_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setCurrent(next);
    setQueue(rest);
  }, [queue, current]);

  const handleClose = () => {
    setCurrent(null);
  };

  return (
    <Snackbar
      open={ Boolean(current) }
      autoHideDuration={ 4_000 }
      onClose={ handleClose }
      anchorOrigin={ { vertical: 'top', horizontal: 'center' } }
    >
      { current ? (
        <Alert
          onClose={ handleClose }
          severity={ current.success ? 'success' : 'warning' }
          variant="filled"
          sx={ { width: '100%' } }
        >
          { current.message }
        </Alert>
      ) : undefined }
    </Snackbar>
  );
}
