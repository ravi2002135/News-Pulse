'use client';

import styles from './SourceFilter.module.css';

type Props = {
  sources: { source: string; articleCount: number }[];
  colors: Record<string, string>;
  hidden: Set<string>;
  onToggle: (source: string) => void;
  onReset: () => void;
};

/**
 * Doubles as the colour legend. The swatch on each toggle is the same hue used
 * for that outlet's marks on the timeline, so the filter teaches the encoding
 * rather than needing a separate key.
 *
 * Filtering happens client-side: the timeline payload already carries every
 * article's source, so toggling is instant and needs no round trip.
 */
export default function SourceFilter({ sources, colors, hidden, onToggle, onReset }: Props) {
  const anyHidden = hidden.size > 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        {sources.map(({ source, articleCount }) => {
          const on = !hidden.has(source);
          return (
            <button
              key={source}
              className={styles.chip}
              data-on={on || undefined}
              onClick={() => onToggle(source)}
              aria-pressed={on}
            >
              <span
                className={styles.swatch}
                style={{ background: on ? colors[source] : 'transparent', borderColor: colors[source] }}
              />
              <span>{source}</span>
              <span className={styles.count}>{articleCount}</span>
            </button>
          );
        })}
      </div>
      {anyHidden && (
        <button className={styles.reset} onClick={onReset}>
          Show all sources
        </button>
      )}
    </div>
  );
}
