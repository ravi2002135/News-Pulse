import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { clustersRouter } from './routes/clusters.js';
import { timelineRouter } from './routes/timeline.js';
import { ingestRouter } from './routes/ingest.js';
import { metaRouter } from './routes/meta.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // correct client IPs behind a platform proxy
  app.use(express.json({ limit: '32kb' }));
  app.use(
    cors({
      origin: config.cors.origins === '*' ? true : config.cors.origins,
      methods: ['GET', 'POST'],
    }),
  );
  if (config.env !== 'test') app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

  app.use('/', metaRouter);
  app.use('/clusters', clustersRouter);
  app.use('/timeline', timelineRouter);
  app.use('/ingest', ingestRouter);

  app.get('/', (req, res) => {
    res.json({
      name: 'News Pulse API',
      endpoints: [
        'GET  /clusters?limit&offset&minSize&source&q&since&until&sort',
        'GET  /clusters/:id?order=asc|desc',
        'GET  /timeline?minSize&since&until&bucketHours',
        'POST /ingest/trigger',
        'GET  /ingest/status/:jobId',
        'GET  /ingest/jobs?limit',
        'GET  /meta',
        'GET  /health',
      ],
    });
  });

  // Unmatched route -> 404 in the same envelope as every other error, so the
  // client never has to handle two error shapes.
  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
    });
  });

  // Malformed JSON bodies surface here as a SyntaxError; they are the caller's
  // fault, so they must be a 400 rather than falling through to the 500 branch.
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' },
      });
    }
    return next(err);
  });

  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    // Anything unexpected is logged in full but not echoed to the client: an
    // internal message can leak file paths or SQL.
    console.error(`[500] ${req.method} ${req.originalUrl}`, err);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        ...(config.env === 'development' ? { debug: err.message } : {}),
      },
    });
  });

  return app;
}
