import { Router } from 'express';
import { config } from '../config.js';
import * as store from '../db.js';
import { NotFound, assertRange, parseQuery, rules, validateClusterId } from '../lib/errors.js';

export const clustersRouter = Router();

const shape = (row) => ({
  id: row.id,
  label: row.label,
  keywords: row.keywords ? row.keywords.split(',') : [],
  articleCount: row.articleCount,
  sourceCount: row.sourceCount,
  timeRange: {
    start: row.startsAt,
    end: row.endsAt,
    durationHours: Number(((new Date(row.endsAt) - new Date(row.startsAt)) / 3600000).toFixed(2)),
  },
  updatedAt: row.updatedAt,
});

/**
 * GET /clusters
 * Paginated list. Kept deliberately light — no article bodies — because this
 * backs a list view that may hold hundreds of clusters.
 */
clustersRouter.get('/', (req, res) => {
  const q = parseQuery(req.query, {
    limit: rules.int({ min: 1, max: config.limits.maxPageSize, default: config.limits.defaultPageSize }),
    offset: rules.int({ min: 0, default: 0 }),
    minSize: rules.int({ min: 1, default: undefined }),
    source: rules.text({ maxLength: 80, default: undefined }),
    q: rules.text({ maxLength: 120, default: undefined }),
    since: rules.isoDate(undefined),
    until: rules.isoDate(undefined),
    sort: rules.enum(['size', 'recent', 'oldest', 'label'], 'size'),
  });
  assertRange(q.since, q.until);

  const { total, rows } = store.listClusters(q);
  res.json({
    data: rows.map(shape),
    pagination: {
      total,
      limit: q.limit,
      offset: q.offset,
      hasMore: q.offset + rows.length < total,
      nextOffset: q.offset + rows.length < total ? q.offset + q.limit : null,
    },
    filters: { minSize: q.minSize, source: q.source, q: q.q, since: q.since, until: q.until, sort: q.sort },
  });
});

/**
 * GET /clusters/:id
 * Full detail: every article in the cluster, chronological.
 */
clustersRouter.get('/:id', (req, res) => {
  const id = validateClusterId(req.params.id);
  const q = parseQuery(req.query, {
    order: rules.enum(['asc', 'desc'], 'asc'),
  });

  const cluster = store.getCluster(id);
  if (!cluster) throw new NotFound(`No cluster with id "${id}"`);

  const articles = store.getClusterArticles(id, q);
  res.json({
    data: {
      ...shape(cluster),
      // The member nearest the cluster centre reads better on a card than the
      // extractive keyword label.
      representativeHeadline: [...articles].sort((a, b) => b.score - a.score)[0]?.title ?? null,
      sources: [...new Set(articles.map((a) => a.source))],
      articles: articles.map((a) => ({
        id: a.id,
        title: a.title,
        url: a.url,
        source: a.source,
        author: a.author,
        summary: a.summary,
        imageUrl: a.imageUrl,
        publishedAt: a.publishedAt,
        // Surfaced so the UI can mark timestamps the pipeline had to infer.
        publishedEstimated: Boolean(a.publishedEstimated),
        hasFullText: a.bodyStatus === 'ok',
        bodyChars: a.bodyChars ?? 0,
        similarityToCluster: a.score,
      })),
    },
  });
});
