'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type ClusterDetail, type Meta, type Timeline as TimelineData } from '@/lib/api';
import { relativeTime, sourceColors } from '@/lib/format';
import ClusterPanel from './ClusterPanel';
import RefreshButton from './RefreshButton';
import SourceFilter from './SourceFilter';
import Timeline from './Timeline';
import styles from './Dashboard.module.css';

/** Range presets map to the API's `since` filter rather than slicing client-side. */
const RANGES = [
  { id: '48h', label: 'Last 48 hours', hours: 48 },
  { id: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { id: 'all', label: 'Everything', hours: null },
] as const;

type RangeId = (typeof RANGES)[number]['id'];

export default function Dashboard() {
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [range, setRange] = useState<RangeId>('7d');
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cluster, setCluster] = useState<ClusterDetail | null>(null);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [clusterError, setClusterError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const hours = RANGES.find((r) => r.id === range)!.hours;
      const since = hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined;
      const [t, m] = await Promise.all([api.timeline({ minSize: 1, since }), api.meta()]);
      setTimeline(t);
      setMeta(m);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Something went wrong loading the timeline.');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  // Detail is fetched on selection rather than bundled into /timeline: article
  // bodies and summaries would multiply the timeline payload for data the
  // reader sees one cluster at a time.
  useEffect(() => {
    if (!selectedId) {
      setCluster(null);
      setClusterError(null);
      return;
    }
    let cancelled = false;
    setClusterLoading(true);
    setClusterError(null);
    api
      .cluster(selectedId)
      .then((c) => !cancelled && setCluster(c))
      .catch((err) => !cancelled && setClusterError(err instanceof ApiError ? err.message : 'Could not load this story.'))
      .finally(() => !cancelled && setClusterLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const colors = useMemo(
    () => sourceColors(meta?.sources.map((s) => s.source) ?? []),
    [meta],
  );

  const toggleSource = (source: string) =>
    setHiddenSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });

  const visibleCount = useMemo(() => {
    if (!timeline) return 0;
    return timeline.series.filter((s) => s.sources.some((src) => !hiddenSources.has(src))).length;
  }, [timeline, hiddenSources]);

  return (
    <div className={styles.page}>
      <header className={styles.masthead}>
        <div>
          <h1 className={styles.wordmark}>News Pulse</h1>
          <p className={styles.standfirst}>{summarise(meta, timeline, loading)}</p>
        </div>
        <RefreshButton onComplete={load} />
      </header>

      <div className={styles.controls}>
        {meta && meta.sources.length > 0 && (
          <SourceFilter
            sources={meta.sources}
            colors={colors}
            hidden={hiddenSources}
            onToggle={toggleSource}
            onReset={() => setHiddenSources(new Set())}
          />
        )}

        <div className={styles.ranges} role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              className={styles.range}
              data-on={r.id === range || undefined}
              onClick={() => setRange(r.id)}
              aria-pressed={r.id === range}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.split}>
        <main className={styles.main}>
          {loadError && (
            <div className={styles.state}>
              <p className={styles.stateLead}>The timeline could not load.</p>
              <p className={styles.stateBody}>{loadError}</p>
              <button className={styles.retry} onClick={load}>
                Try again
              </button>
            </div>
          )}

          {!loadError && loading && !timeline && (
            <div className={styles.state}>
              <p className={styles.stateBody}>Loading the timeline</p>
            </div>
          )}

          {!loadError && timeline && visibleCount === 0 && (
            <div className={styles.state}>
              <p className={styles.stateLead}>
                {hiddenSources.size > 0
                  ? 'No stories from the sources you have on.'
                  : 'No stories in this window yet.'}
              </p>
              <p className={styles.stateBody}>
                {hiddenSources.size > 0
                  ? 'Turn a source back on, or widen the time range.'
                  : 'Refresh the data to pull the latest articles, or widen the time range.'}
              </p>
            </div>
          )}

          {!loadError && timeline && visibleCount > 0 && (
            <Timeline
              timeline={timeline}
              colors={colors}
              hiddenSources={hiddenSources}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />
          )}
        </main>

        <ClusterPanel
          cluster={cluster}
          loading={clusterLoading}
          error={clusterError}
          colors={colors}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </div>
  );
}

/**
 * The standfirst carries the live state, so the reader knows how current the
 * page is without hunting for a timestamp.
 */
function summarise(meta: Meta | null, timeline: TimelineData | null, loading: boolean): string {
  if (loading && !meta) return 'Reading the latest clusters';
  if (!meta || !timeline) return 'Waiting on the API';

  const stories = timeline.series.length;
  const outlets = meta.sources.length;
  if (stories === 0) return `Nothing tracked yet across ${outlets} outlets`;

  const freshness = meta.lastClusteredAt ? `, grouped ${relativeTime(meta.lastClusteredAt)}` : '';
  return `${stories} ${stories === 1 ? 'story' : 'stories'} from ${meta.articles} articles across ${outlets} outlets${freshness}`;
}
