import { Router } from 'express';
import { jobs } from '../db.js';
import { serializeJob, triggerIngest } from '../lib/jobRunner.js';
import { NotFound, parseQuery, rules, validateJobId } from '../lib/errors.js';

export const ingestRouter = Router();

/**
 * POST /ingest/trigger
 * Starts the Python pipeline as a subprocess and returns immediately with a
 * job id. 202 rather than 200: the work has been accepted, not completed.
 * A run already in flight yields 409 with the existing job's id, so the client
 * can poll that one instead of failing.
 */
ingestRouter.post('/trigger', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : undefined;
  const job = triggerIngest({ reason });
  res.status(202)
     .location(job.statusUrl)
     .json({ data: { ...job, pollIntervalMs: 2000 } });
});

/**
 * GET /ingest/status/:jobId
 * Poll target. `isTerminal` is included so the client has an explicit stop
 * condition rather than string-matching on status values.
 */
ingestRouter.get('/status/:jobId', (req, res) => {
  const id = validateJobId(req.params.jobId);
  const row = jobs.get(id);
  if (!row) throw new NotFound(`No ingest job with id "${id}"`);
  res.json({ data: serializeJob(row) });
});

/** GET /ingest/jobs — recent run history, useful for a debug panel. */
ingestRouter.get('/jobs', (req, res) => {
  const q = parseQuery(req.query, { limit: rules.int({ min: 1, max: 50, default: 20 }) });
  res.json({ data: jobs.recent(q.limit).map(serializeJob) });
});
