import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { jobs } from '../db.js';
import { Conflict, ServiceUnavailable } from './errors.js';

/**
 * Runs the Python pipeline as a detached subprocess and tracks it.
 *
 * Two deliberate choices:
 *
 * 1. The HTTP request returns as soon as the process is spawned. An ingest run
 *    fetches dozens of article pages and takes minutes; holding a connection
 *    open for that would hit every proxy and load-balancer timeout in the path.
 *    Hence the job-id + polling contract.
 *
 * 2. Only one run at a time. Concurrent runs would race on the same SQLite
 *    file and duplicate article-page fetches for no benefit, so a second
 *    trigger gets a 409 pointing at the job already in flight.
 *
 * For a single API instance this is sufficient. Across multiple instances the
 * in-memory handle map would need replacing with a real queue (BullMQ/Redis) —
 * the job *state* is already in SQLite, so only the runner would change.
 */

const running = new Map(); // jobId -> { child, timer }

const nowIso = () => new Date().toISOString();

function appendLog(buffer, chunk) {
  buffer.push(...chunk.toString().split('\n').filter(Boolean));
  const overflow = buffer.length - config.ingest.logTailLines;
  if (overflow > 0) buffer.splice(0, overflow);
  return buffer;
}

export function triggerIngest({ reason } = {}) {
  if (!config.ingest.enabled) {
    throw new ServiceUnavailable('Ingest triggering is disabled on this deployment', {
      hint: 'Set INGEST_ENABLED=true to allow it.',
    });
  }

  const active = jobs.activeCount();
  if (active > 0) {
    const current = jobs.recent(5).find((j) => j.status === 'running' || j.status === 'queued');
    throw new Conflict('An ingest job is already in progress', {
      jobId: current?.id,
      statusUrl: current ? `/ingest/status/${current.id}` : undefined,
    });
  }

  const id = randomUUID();
  jobs.insert({
    id,
    status: 'queued',
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    logTail: null,
    stats: reason ? JSON.stringify({ reason }) : null,
  });

  // Spawn on the next tick so the HTTP response isn't blocked by process setup.
  setImmediate(() => start(id));

  // Same key name as GET /ingest/status returns, so the client isn't
  // handling two names for one value.
  return { jobId: id, status: 'queued', statusUrl: `/ingest/status/${id}` };
}

function start(id) {
  const logs = [];
  let child;

  try {
    child = spawn(config.ingest.command, config.ingest.args, {
      cwd: config.ingest.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    jobs.update(id, {
      status: 'failed',
      finishedAt: nowIso(),
      error: `Failed to spawn pipeline: ${err.message}`,
    });
    return;
  }

  jobs.update(id, { status: 'running', startedAt: nowIso() });

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    // If it ignores SIGTERM, escalate rather than leaking the process.
    setTimeout(() => child.killed || child.kill('SIGKILL'), 5000);
    jobs.update(id, { error: `Timed out after ${config.ingest.timeoutMs}ms` });
  }, config.ingest.timeoutMs);

  child.stdout.on('data', (chunk) => appendLog(logs, chunk));
  child.stderr.on('data', (chunk) => appendLog(logs, chunk));

  child.on('error', (err) => {
    clearTimeout(timer);
    running.delete(id);
    jobs.update(id, {
      status: 'failed',
      finishedAt: nowIso(),
      error: err.message,
      logTail: logs.join('\n'),
    });
  });

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    running.delete(id);
    const existing = jobs.get(id);
    const timedOut = Boolean(existing?.error);
    jobs.update(id, {
      status: code === 0 && !timedOut ? 'succeeded' : 'failed',
      finishedAt: nowIso(),
      exitCode: code,
      error:
        code === 0 && !timedOut
          ? null
          : existing?.error ?? `Pipeline exited with code ${code}${signal ? ` (${signal})` : ''}`,
      logTail: logs.join('\n'),
      stats: JSON.stringify(parseStats(logs)),
    });
  });

  running.set(id, { child, timer });
}

/**
 * The pipeline prints a summary line like
 *   seen=120 new=14 duplicates=106 bodies ok=12 failed=2 feed_errors=0
 * Pulling those numbers out means the frontend can show what a run actually did
 * instead of just "done".
 */
function parseStats(logs) {
  const stats = {};
  for (const line of logs) {
    for (const [, key, value] of line.matchAll(/(\w+)=(\d+)/g)) {
      stats[key] = Number(value);
    }
    const clusters = line.match(/^(\d+) clusters, (\d+) multi-article/);
    if (clusters) {
      stats.clusters = Number(clusters[1]);
      stats.multiArticleClusters = Number(clusters[2]);
    }
  }
  return stats;
}

export function serializeJob(row) {
  if (!row) return null;
  const durationMs =
    row.started_at && row.finished_at
      ? new Date(row.finished_at) - new Date(row.started_at)
      : row.started_at
        ? Date.now() - new Date(row.started_at).getTime()
        : null;

  return {
    jobId: row.id,
    status: row.status, // queued | running | succeeded | failed
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs,
    exitCode: row.exit_code,
    error: row.error,
    stats: row.stats ? safeParse(row.stats) : null,
    logTail: row.log_tail ? row.log_tail.split('\n').slice(-40) : [],
    isTerminal: row.status === 'succeeded' || row.status === 'failed',
  };
}

const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Kill any in-flight child on shutdown so it isn't orphaned. */
export function stopAll() {
  for (const [, { child, timer }] of running) {
    clearTimeout(timer);
    child.kill('SIGTERM');
  }
  running.clear();
}
