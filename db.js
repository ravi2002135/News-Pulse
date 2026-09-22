import Database from 'better-sqlite3';
import { config } from './config.js';

/**
 * The Python pipeline owns the `articles`, `clusters` and `article_clusters`
 * tables; this process only reads them. It does own `api_jobs`, which is
 * created here so ingest job state survives an API restart rather than living
 * in a Map that evaporates on deploy.
 *
 * Opened read-write (for api_jobs) with WAL enabled, so a Python ingest run
 * writing to the same file doesn't block reads served to the frontend.
 */

let db;

export function getDb() {
  if (!db) {
    db = new Database(config.databaseUrl, { fileMustExist: false });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_jobs (
        id           TEXT PRIMARY KEY,
        status       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT,
        exit_code    INTEGER,
        error        TEXT,
        log_tail     TEXT,
        stats        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON api_jobs(status, created_at);
    `);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

/** True when the pipeline tables exist — used by the health check. */
export function pipelineTablesPresent() {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type='table' AND name IN ('articles','clusters','article_clusters')`,
    )
    .get();
  return row.n === 3;
}

// --------------------------------------------------------------------------
// Cluster queries
// --------------------------------------------------------------------------

const CLUSTER_FIELDS = `
  c.id, c.label, c.keywords, c.size AS articleCount, c.source_count AS sourceCount,
  c.first_published AS startsAt, c.last_published AS endsAt, c.updated_at AS updatedAt
`;

/**
 * Filters are applied in SQL rather than in JS so the API doesn't load the
 * whole table to serve one page.
 */
export function listClusters({ limit, offset, minSize, source, q, since, until, sort }) {
  const where = ['1=1'];
  const params = {};

  if (minSize !== undefined) {
    where.push('c.size >= @minSize');
    params.minSize = minSize;
  }
  if (since) {
    where.push('c.last_published >= @since');
    params.since = since;
  }
  if (until) {
    where.push('c.first_published <= @until');
    params.until = until;
  }
  if (q) {
    where.push('(LOWER(c.label) LIKE @q OR LOWER(c.keywords) LIKE @q)');
    params.q = `%${q.toLowerCase()}%`;
  }
  if (source) {
    where.push(`EXISTS (
      SELECT 1 FROM article_clusters ac JOIN articles a ON a.id = ac.article_id
      WHERE ac.cluster_id = c.id AND a.source = @source)`);
    params.source = source;
  }

  const orderBy = {
    recent: 'c.last_published DESC, c.size DESC',
    size: 'c.size DESC, c.last_published DESC',
    oldest: 'c.first_published ASC',
    label: 'c.label COLLATE NOCASE ASC',
  }[sort] ?? 'c.size DESC, c.last_published DESC';

  const clause = where.join(' AND ');
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM clusters c WHERE ${clause}`)
    .get(params).n;

  const rows = getDb()
    .prepare(
      `SELECT ${CLUSTER_FIELDS} FROM clusters c
       WHERE ${clause} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  return { total, rows };
}

export function getCluster(id) {
  return getDb().prepare(`SELECT ${CLUSTER_FIELDS} FROM clusters c WHERE c.id = ?`).get(id);
}

export function getClusterArticles(id, { order = 'asc' } = {}) {
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  return getDb()
    .prepare(
      `SELECT a.id, a.url, a.source, a.title, a.summary, a.author,
              a.image_url AS imageUrl, a.published_at AS publishedAt,
              a.published_est AS publishedEstimated, a.body_status AS bodyStatus,
              LENGTH(a.body) AS bodyChars, ac.score
       FROM article_clusters ac
       JOIN articles a ON a.id = ac.article_id
       WHERE ac.cluster_id = ?
       ORDER BY a.published_at ${direction}`,
    )
    .all(id);
}

/** All clusters with their article timestamps — the input to the timeline. */
export function timelineRows({ minSize, since, until }) {
  const where = ['c.size >= @minSize'];
  const params = { minSize };
  if (since) {
    where.push('c.last_published >= @since');
    params.since = since;
  }
  if (until) {
    where.push('c.first_published <= @until');
    params.until = until;
  }
  return getDb()
    .prepare(
      `SELECT ${CLUSTER_FIELDS},
              GROUP_CONCAT(a.published_at, '|') AS stamps,
              GROUP_CONCAT(DISTINCT a.source)   AS sources
       FROM clusters c
       JOIN article_clusters ac ON ac.cluster_id = c.id
       JOIN articles a ON a.id = ac.article_id
       WHERE ${where.join(' AND ')}
       GROUP BY c.id
       ORDER BY c.first_published ASC`,
    )
    .all(params);
}

export function distinctSources() {
  return getDb()
    .prepare('SELECT source, COUNT(*) AS articleCount FROM articles GROUP BY source ORDER BY articleCount DESC')
    .all();
}

export function corpusStats() {
  const one = (sql) => getDb().prepare(sql).get();
  return {
    articles: one('SELECT COUNT(*) AS n FROM articles').n,
    clusters: one('SELECT COUNT(*) AS n FROM clusters').n,
    multiArticleClusters: one('SELECT COUNT(*) AS n FROM clusters WHERE size > 1').n,
    earliestArticle: one('SELECT MIN(published_at) AS v FROM articles').v,
    latestArticle: one('SELECT MAX(published_at) AS v FROM articles').v,
    lastClusteredAt: one('SELECT MAX(updated_at) AS v FROM clusters').v,
  };
}

// --------------------------------------------------------------------------
// Job persistence
// --------------------------------------------------------------------------

export const jobs = {
  insert(job) {
    getDb()
      .prepare(
        `INSERT INTO api_jobs (id,status,created_at,started_at,finished_at,exit_code,error,log_tail,stats)
         VALUES (@id,@status,@createdAt,@startedAt,@finishedAt,@exitCode,@error,@logTail,@stats)`,
      )
      .run(job);
  },
  update(id, patch) {
    const fields = Object.keys(patch).map((k) => `${camelToSnake(k)} = @${k}`);
    if (!fields.length) return;
    getDb().prepare(`UPDATE api_jobs SET ${fields.join(', ')} WHERE id = @id`).run({ ...patch, id });
  },
  get(id) {
    return getDb().prepare('SELECT * FROM api_jobs WHERE id = ?').get(id);
  },
  recent(limit = 20) {
    return getDb().prepare('SELECT * FROM api_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  activeCount() {
    return getDb()
      .prepare("SELECT COUNT(*) AS n FROM api_jobs WHERE status IN ('queued','running')").get().n;
  },
  /**
   * A job left in `running` by a crash or redeploy can never complete, but
   * would otherwise be polled forever by the frontend. Mark them failed at
   * boot so the status endpoint tells the truth.
   */
  reconcileOrphans() {
    return getDb()
      .prepare(
        `UPDATE api_jobs SET status='failed', finished_at=?, error=?
         WHERE status IN ('queued','running')`,
      )
      .run(new Date().toISOString(), 'Interrupted by API restart').changes;
  },
};

const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
