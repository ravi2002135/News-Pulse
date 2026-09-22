'use client';

import { useEffect, useRef } from 'react';
import type { ClusterDetail } from '@/lib/api';
import { clockTime, dateTime, duration, hostname } from '@/lib/format';
import styles from './ClusterPanel.module.css';

type Props = {
  cluster: ClusterDetail | null;
  loading: boolean;
  error: string | null;
  colors: Record<string, string>;
  onClose: () => void;
};

/**
 * Detail for the selected story. Articles are listed in the order they
 * published, which makes the panel read as the story's own chronology — who
 * broke it, who followed, how the framing shifted between outlets.
 */
export default function ClusterPanel({ cluster, loading, error, colors, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes the panel; focus moves into it on open so keyboard users
  // aren't stranded back at the timeline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (cluster) closeRef.current?.focus();
  }, [cluster?.id]);

  return (
    <aside className={styles.panel} aria-label="Story detail">
      {loading && <p className={styles.note}>Loading the story</p>}

      {error && !loading && (
        <div className={styles.note}>
          <p className={styles.errorText}>{error}</p>
        </div>
      )}

      {!cluster && !loading && !error && (
        <div className={styles.placeholder}>
          <p className={styles.placeholderLead}>Pick a story on the timeline.</p>
          <p className={styles.placeholderBody}>
            Each bar spans the hours a story stayed in the news. The coloured marks are
            individual articles, placed at the minute they published.
          </p>
        </div>
      )}

      {cluster && !loading && (
        <>
          <header className={styles.header}>
            <button ref={closeRef} className={styles.close} onClick={onClose} aria-label="Close story detail">
              Close
            </button>
            <h2 className={styles.headline}>
              {cluster.representativeHeadline ?? cluster.label}
            </h2>
            <p className={styles.meta}>
              <span>{cluster.articleCount} articles</span>
              <span>{cluster.sourceCount} outlets</span>
              <span>{duration(cluster.timeRange.durationHours)}</span>
            </p>
            <ul className={styles.keywords}>
              {cluster.keywords.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          </header>

          <ol className={styles.list}>
            {cluster.articles.map((a, i) => {
              const previous = cluster.articles[i - 1];
              const gapHours = previous
                ? (new Date(a.publishedAt).getTime() - new Date(previous.publishedAt).getTime()) / 3600000
                : 0;

              return (
                <li key={a.id} className={styles.item}>
                  {/* A visible gap marker where coverage paused for a while. */}
                  {gapHours >= 6 && (
                    <p className={styles.gap}>{duration(gapHours)} later</p>
                  )}

                  <div className={styles.itemHead}>
                    <span className={styles.source}>
                      <span
                        className={styles.dot}
                        style={{ background: colors[a.source] ?? 'var(--ink-soft)' }}
                      />
                      {a.source}
                    </span>
                    <time dateTime={a.publishedAt} title={dateTime(a.publishedAt)}>
                      {clockTime(a.publishedAt)}
                      {a.publishedEstimated && (
                        <span className={styles.estimated} title="This feed gave no publish time; this is when we first saw it">
                          approx
                        </span>
                      )}
                    </time>
                  </div>

                  <a className={styles.title} href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.title}
                  </a>

                  {a.summary && <p className={styles.summary}>{a.summary}</p>}

                  <p className={styles.itemFoot}>{hostname(a.url)}</p>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </aside>
  );
}
