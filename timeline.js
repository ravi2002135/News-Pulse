/**
 * Shapes clusters into something a charting library can render directly.
 *
 * The guiding idea is that the frontend should not have to do any maths. A raw
 * list of clusters forces the chart component to derive its own x-domain,
 * bucket the timestamps, normalise intensity and solve row placement — all of
 * which is layout-independent work that belongs on the server, where it is
 * computed once instead of on every re-render.
 *
 * What ships:
 *   domain   shared x-axis extent + the bucket size chosen for it
 *   buckets  the x-axis tick timestamps, identical across every series, so a
 *            stacked/stream chart can index them positionally
 *   series   one entry per cluster: a Gantt bar (start/end/lane), a per-bucket
 *            histogram for sparklines, and normalised intensity for colour
 *   meta     the maxima a legend or colour scale needs
 */

const HOUR = 3600 * 1000;

// Snapped bucket sizes. Charts read better on human-recognisable intervals
// than on an exact span/48 that lands on 37 minutes.
const BUCKET_CHOICES_HOURS = [1, 2, 3, 6, 12, 24, 48, 168];
const TARGET_BUCKETS = 48;

/** Single-article clusters have zero duration; a bar of zero width is invisible. */
const MIN_BAR_HOURS = 1;

function chooseBucketHours(spanMs) {
  const ideal = spanMs / HOUR / TARGET_BUCKETS;
  return BUCKET_CHOICES_HOURS.find((h) => h >= ideal) ?? BUCKET_CHOICES_HOURS.at(-1);
}

/**
 * Greedy interval packing: assign each cluster the lowest lane (row) whose last
 * bar ends before this one starts, so a Gantt-style timeline renders without
 * overlapping bars and without the client solving it.
 */
function assignLanes(items) {
  const laneEnds = [];
  for (const item of items) {
    const start = new Date(item.start).getTime();
    let lane = laneEnds.findIndex((end) => end <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = new Date(item.displayEnd).getTime();
    item.lane = lane;
  }
  return laneEnds.length;
}

export function buildTimeline(rows, { bucketHours: forcedBucket } = {}) {
  if (!rows.length) {
    return {
      domain: null,
      buckets: [],
      laneCount: 0,
      series: [],
      meta: { clusterCount: 0, totalArticles: 0, maxArticleCount: 0, maxBucketCount: 0, generatedAt: new Date().toISOString() },
    };
  }

  const parsed = rows.map((r) => ({
    id: r.id,
    label: r.label,
    keywords: r.keywords ? r.keywords.split(',') : [],
    sources: r.sources ? r.sources.split(',') : [],
    articleCount: r.articleCount,
    sourceCount: r.sourceCount,
    // Each article as (timestamp, source). Small — a handful per cluster — and
    // it lets the client mark every individual article on the bar instead of
    // fetching each cluster's detail just to draw it.
    marks: (r.stamps ?? '')
      .split('|')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.lastIndexOf('~');
        return { t: new Date(pair.slice(0, at)).toISOString(), source: pair.slice(at + 1) };
      })
      .sort((a, b) => new Date(a.t) - new Date(b.t)),
    start: r.startsAt,
    end: r.endsAt,
  }));

  const domainStart = Math.min(...parsed.map((p) => new Date(p.start).getTime()));
  const domainEnd = Math.max(...parsed.map((p) => new Date(p.end).getTime()));
  const spanMs = Math.max(domainEnd - domainStart, HOUR);
  const bucketHours = forcedBucket ?? chooseBucketHours(spanMs);
  const bucketMs = bucketHours * HOUR;

  // Align bucket boundaries to the bucket size so ticks land on round hours.
  const alignedStart = Math.floor(domainStart / bucketMs) * bucketMs;
  const bucketCount = Math.max(1, Math.ceil((domainEnd - alignedStart) / bucketMs) + 1);
  const buckets = Array.from({ length: bucketCount }, (_, i) =>
    new Date(alignedStart + i * bucketMs).toISOString());

  const maxArticleCount = Math.max(...parsed.map((p) => p.articleCount));
  let maxBucketCount = 0;

  const series = parsed.map((p) => {
    const counts = new Array(bucketCount).fill(0);
    for (const { t: iso } of p.marks) {
      const t = new Date(iso).getTime();
      const i = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - alignedStart) / bucketMs)));
      counts[i] += 1;
    }
    const peakIndex = counts.indexOf(Math.max(...counts));
    maxBucketCount = Math.max(maxBucketCount, ...counts);

    const startMs = new Date(p.start).getTime();
    const endMs = new Date(p.end).getTime();
    const durationHours = (endMs - startMs) / HOUR;
    const displayEnd = new Date(Math.max(endMs, startMs + MIN_BAR_HOURS * HOUR)).toISOString();

    let cumulative = 0;
    const points = counts.map((count, i) => {
      cumulative += count;
      return { t: buckets[i], count, cumulative };
    });

    return {
      id: p.id,
      label: p.label,
      keywords: p.keywords,
      sources: p.sources,
      start: p.start,
      end: p.end,
      // Zero-width bars would be invisible; the client should draw displayEnd
      // and show `end` in the tooltip.
      displayEnd,
      durationHours: Number(durationHours.toFixed(2)),
      articleCount: p.articleCount,
      sourceCount: p.sourceCount,
      // 0..1, for a colour/opacity scale without the client scanning the set.
      intensity: Number((p.articleCount / maxArticleCount).toFixed(3)),
      // Articles per day while the story was live — separates a story that drew
      // 6 articles in 3 hours from one that drew 6 over a week.
      velocity: Number((p.articleCount / Math.max(durationHours, MIN_BAR_HOURS) * 24).toFixed(2)),
      peakAt: buckets[peakIndex],
      marks: p.marks,
      points,
    };
  });

  series.sort((a, b) => new Date(a.start) - new Date(b.start) || b.articleCount - a.articleCount);
  const laneCount = assignLanes(series);

  return {
    domain: {
      start: new Date(domainStart).toISOString(),
      end: new Date(domainEnd).toISOString(),
      durationHours: Number((spanMs / HOUR).toFixed(2)),
      bucketHours,
      bucketCount,
    },
    buckets,
    laneCount,
    series,
    meta: {
      clusterCount: series.length,
      totalArticles: series.reduce((sum, s) => sum + s.articleCount, 0),
      maxArticleCount,
      maxBucketCount,
      minBarHours: MIN_BAR_HOURS,
      generatedAt: new Date().toISOString(),
    },
  };
}
