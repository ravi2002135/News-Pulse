import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

/**
 * All configuration comes from the environment. Nothing that varies between
 * machines or environments is written into the source.
 *
 * Required values are validated at boot rather than at first use, so a
 * misconfigured deploy fails immediately and loudly instead of returning 500s
 * on the first request that happens to touch the bad setting.
 */

const required = (name) => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
};

const optional = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value.trim();
};

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
};

const list = (name, fallback) => {
  const raw = optional(name, fallback);
  return raw === '*' ? '*' : raw.split(',').map((s) => s.trim()).filter(Boolean);
};

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: int('PORT', 4000),
  host: optional('HOST', '0.0.0.0'),

  // Absolute path to the SQLite file the Python pipeline writes.
  databaseUrl: path.resolve(required('DATABASE_URL').replace(/^sqlite:\/\//, '')),

  cors: { origins: list('CORS_ORIGINS', 'http://localhost:3000') },

  ingest: {
    // How the pipeline is invoked. Kept configurable so the same image can run
    // it via a venv python, a container exec, or a wrapper script.
    command: optional('INGEST_COMMAND', 'python3'),
    args: optional('INGEST_ARGS', '-m,newspulse,run').split(',').filter(Boolean),
    cwd: path.resolve(optional('INGEST_CWD', process.cwd())),
    timeoutMs: int('INGEST_TIMEOUT_MS', 10 * 60 * 1000),
    // Retaining every line of pipeline output in memory would grow unbounded
    // over a long-running process; only the tail is kept for debugging.
    logTailLines: int('INGEST_LOG_TAIL_LINES', 200),
    enabled: optional('INGEST_ENABLED', 'true') !== 'false',
  },

  limits: {
    defaultPageSize: int('DEFAULT_PAGE_SIZE', 25),
    maxPageSize: int('MAX_PAGE_SIZE', 100),
  },
};

export function assertDatabaseReachable() {
  if (!fs.existsSync(config.databaseUrl)) {
    throw new Error(
      `Database not found at ${config.databaseUrl}. ` +
        'Run the Python pipeline first (python -m newspulse run), or set DATABASE_URL.',
    );
  }
}
