import { config, assertDatabaseReachable } from './config.js';
import { createApp } from './app.js';
import { closeDb, getDb, jobs } from './db.js';
import { stopAll } from './lib/jobRunner.js';

try {
  assertDatabaseReachable();
} catch (err) {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
}

getDb();
const orphans = jobs.reconcileOrphans();
if (orphans) console.warn(`Marked ${orphans} interrupted ingest job(s) as failed`);

const server = createApp().listen(config.port, config.host, () => {
  console.log(`News Pulse API listening on http://${config.host}:${config.port} (${config.env})`);
  console.log(`Database: ${config.databaseUrl}`);
});

// Drain in-flight requests and kill any child process rather than leaving the
// pipeline orphaned when the platform sends SIGTERM on redeploy.
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  stopAll();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
