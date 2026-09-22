import { Router } from 'express';
import * as store from '../db.js';
import { pipelineTablesPresent } from '../db.js';

export const metaRouter = Router();

/** GET /health — liveness plus a real DB round-trip, for the deploy platform. */
metaRouter.get('/health', (req, res) => {
  try {
    const ready = pipelineTablesPresent();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      database: ready ? 'connected' : 'pipeline tables missing',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'unreachable', message: err.message });
  }
});

/** GET /meta — corpus counts and source list, for filter UIs and headers. */
metaRouter.get('/meta', (req, res) => {
  res.json({ data: { ...store.corpusStats(), sources: store.distinctSources() } });
});
