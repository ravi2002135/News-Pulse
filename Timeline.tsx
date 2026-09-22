'use client';

import { useMemo, useRef, useState } from 'react';
import type { Timeline as TimelineData, TimelineSeries } from '@/lib/api';
import { axisLabel, clockTime, duration } from '@/lib/format';
import styles from './Timeline.module.css';

type Props = {
  timeline: TimelineData;
  colors: Record<string, string>;
  hiddenSources: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
};

type Hover = { left: number; top: number; series: TimelineSeries } | null;

/**
 * A schedule grid rather than a chart: each story occupies a rail spanning the
 * hours it was live, and every article inside it is marked at the moment it
 * published, coloured by outlet.
 *
 * That last part is the point of the view. A plain bar answers "when was this
 * topic active"; the marks also answer "how did coverage arrive, and who
 * picked it up" — a story where four outlets published within an hour reads
 * very differently from one that trickled out over two days, and here the
 * difference is visible without opening anything.
 */
export default function Timeline({
  timeline,
  colors,
  hiddenSources,
  selectedId,
  onSelect,
}: Props) {
  const [hover, setHover] = useState<Hover>(null);
  // Tooltip coordinates are measured against the wrapper, not the hovered bar:
  // the bar's offsetParent is its own track, which is inset by the label rail,
  // so offsetLeft/offsetTop would place the tooltip a rail-width off.
  const wrapRef = useRef<HTMLDivElement>(null);

  const { domain, series } = timeline;

  // Percent position along the axis. Computed here so the SVG-free DOM can be
  // laid out with plain CSS percentages and stay responsive without a resize
  // observer.
  const scale = useMemo(() => {
    if (!domain) return () => 0;
    const start = new Date(domain.start).getTime();
    const span = Math.max(new Date(domain.end).getTime() - start, 1);
    return (iso: string) =>
      Math.min(100, Math.max(0, ((new Date(iso).getTime() - start) / span) * 100));
  }, [domain]);

  const ticks = useMemo(() => {
    if (!domain) return [];
    // Thin the bucket list down to a readable number of labelled ticks.
    const stride = Math.max(1, Math.ceil(timeline.buckets.length / 8));
    return timeline.buckets
      .filter((_, i) => i % stride === 0)
      .map((t, i, all) => ({ t, left: scale(t), label: axisLabel(t, all[i - 1]) }));
  }, [domain, timeline.buckets, scale]);

  if (!domain || series.length === 0) return null;

  const visible = series.filter((s) => s.sources.some((src) => !hiddenSources.has(src)));

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div className={styles.axis}>
        <div className={styles.axisGutter}>{duration(domain.durationHours)} of coverage</div>
        <div className={styles.axisTrack}>
          {ticks.map((tick) => (
            <span key={tick.t} className={styles.tick} style={{ left: `${tick.left}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.rows} role="list">
        {visible.map((s, index) => {
          const left = scale(s.start);
          const right = scale(s.displayEnd);
          const isSelected = s.id === selectedId;
          const marks = s.marks.filter((m) => !hiddenSources.has(m.source));

          return (
            <div key={s.id} className={styles.row} role="listitem">
              <button
                className={styles.label}
                data-selected={isSelected || undefined}
                onClick={() => onSelect(s.id)}
                aria-expanded={isSelected}
              >
                <span className={styles.labelText}>{s.label}</span>
                <span className={styles.labelCount}>
                  {s.articleCount} {s.articleCount === 1 ? 'article' : 'articles'}
                </span>
              </button>

              <div className={styles.track}>
                {ticks.map((tick) => (
                  <span
                    key={tick.t}
                    className={styles.gridline}
                    style={{ left: `${tick.left}%` }}
                    aria-hidden
                  />
                ))}

                <button
                  className={styles.bar}
                  data-selected={isSelected || undefined}
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(right - left, 0.6)}%`,
                    // Weight the fill by how much coverage the story drew, so a
                    // dominant story reads as solid and a minor one as faint.
                    '--fill': 0.1 + s.intensity * 0.22,
                    '--delay': `${Math.min(index * 26, 400)}ms`,
                  } as React.CSSProperties}
                  onClick={() => onSelect(s.id)}
                  onMouseEnter={(e) => {
                    const wrap = wrapRef.current?.getBoundingClientRect();
                    const bar = e.currentTarget.getBoundingClientRect();
                    if (!wrap) return;
                    setHover({ left: bar.left - wrap.left, top: bar.top - wrap.top, series: s });
                  }}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => onSelect(s.id)}
                  title={`${s.label} — ${clockTime(s.start)} to ${clockTime(s.end)}`}
                >
                  <span className={styles.srOnly}>
                    {s.label}, {s.articleCount} articles from {s.sourceCount} sources, active{' '}
                    {duration(s.durationHours)}
                  </span>
                </button>

                {/* One mark per article, at the minute it published. */}
                {marks.map((m, i) => (
                  <span
                    key={`${m.t}-${i}`}
                    className={styles.mark}
                    style={{
                      left: `${scale(m.t)}%`,
                      background: colors[m.source] ?? 'var(--ink-soft)',
                      '--delay': `${Math.min(index * 26, 400) + 120}ms`,
                    } as React.CSSProperties}
                    title={`${m.source}, ${clockTime(m.t)}`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {hover && (
        <div
          className={styles.tooltip}
          style={{ left: hover.left, top: hover.top }}
          aria-hidden
        >
          <strong className={styles.tooltipTitle}>{hover.series.label}</strong>
          <span className={styles.tooltipMeta}>
            Active {clockTime(hover.series.start)} to {clockTime(hover.series.end)}, over{' '}
            {duration(hover.series.durationHours)}
          </span>
          <span className={styles.tooltipMeta}>
            {hover.series.velocity} articles per day at peak rate
          </span>
          <ul className={styles.tooltipSources}>
            {hover.series.sources.map((src) => (
              <li key={src}>
                <span className={styles.dot} style={{ background: colors[src] }} />
                {src}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
