'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type Job } from '@/lib/api';
import styles from './RefreshButton.module.css';

type Props = { onComplete: () => void };

type State =
  | { phase: 'idle' }
  | { phase: 'working'; job: Job | null }
  | { phase: 'done'; summary: string }
  | { phase: 'error'; message: string };

const POLL_MS = 2000;
const MAX_POLLS = 300; // 10 minutes at 2s, matching the API's own job timeout

/**
 * Triggers the Python pipeline and polls until it finishes.
 *
 * The run takes minutes, so the button reports what the pipeline is actually
 * doing rather than spinning silently: the API parses the pipeline's summary
 * line into counts, and those are shown as they arrive. A run that fetches 40
 * article pages and finds nothing new should say so.
 */
export default function RefreshButton({ onComplete }: Props) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const poll = useCallback(
    (jobId: string, attempt: number) => {
      timer.current = setTimeout(async () => {
        try {
          const job = await api.jobStatus(jobId);

          if (!job.isTerminal) {
            if (attempt >= MAX_POLLS) {
              setState({ phase: 'error', message: 'The run is taking longer than expected. Check the API logs.' });
              return;
            }
            setState({ phase: 'working', job });
            poll(jobId, attempt + 1);
            return;
          }

          if (job.status === 'failed') {
            setState({ phase: 'error', message: job.error ?? 'The pipeline run failed.' });
            return;
          }

          const added = job.stats?.new ?? 0;
          setState({
            phase: 'done',
            summary:
              added > 0
                ? `Added ${added} ${added === 1 ? 'article' : 'articles'}`
                : 'No new articles',
          });
          onComplete();
        } catch (err) {
          setState({
            phase: 'error',
            message: err instanceof ApiError ? err.message : 'Lost contact with the API.',
          });
        }
      }, POLL_MS);
    },
    [onComplete],
  );

  const start = async () => {
    setState({ phase: 'working', job: null });
    try {
      const { jobId } = await api.triggerIngest();
      poll(jobId, 0);
    } catch (err) {
      // A 409 means a run is already going — that isn't a failure worth
      // alarming the reader about, so say what's true and leave it running.
      if (err instanceof ApiError && err.status === 409) {
        setState({ phase: 'error', message: 'A run is already in progress.' });
        return;
      }
      setState({
        phase: 'error',
        message: err instanceof ApiError ? err.message : 'Could not start the run.',
      });
    }
  };

  const working = state.phase === 'working';

  return (
    <div className={styles.wrap}>
      <button className={styles.button} onClick={start} disabled={working}>
        {working ? 'Fetching articles' : 'Refresh data'}
        {working && <span className={styles.pulse} aria-hidden />}
      </button>

      <p className={styles.status} role="status" aria-live="polite">
        {state.phase === 'working' && describe(state.job)}
        {state.phase === 'done' && state.summary}
        {state.phase === 'error' && <span className={styles.error}>{state.message}</span>}
      </p>
    </div>
  );
}

function describe(job: Job | null): string {
  if (!job || job.status === 'queued') return 'Starting the pipeline';
  const seen = job.stats?.seen;
  return seen ? `Read ${seen} feed items` : 'Reading feeds and article pages';
}
