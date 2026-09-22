import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DB ?? '/tmp/offline.db';
process.env.INGEST_COMMAND = 'node';
process.env.INGEST_ARGS = '-e,console.log("seen=3 new=1 duplicates=2")';
process.env.INGEST_CWD = process.cwd();

const { createApp } = await import('../src/app.js');
const { getDb, closeDb } = await import('../src/db.js');

let base;
let server;

before(async () => {
  getDb().exec('DELETE FROM api_jobs');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
});

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

describe('GET /clusters', () => {
  it('returns a paginated envelope', async () => {
    const { status, body } = await get('/clusters?limit=2');
    assert.equal(status, 200);
    assert.equal(body.data.length, 2);
    assert.equal(body.pagination.limit, 2);
    assert.ok(body.pagination.total >= 2);
    assert.ok(Array.isArray(body.data[0].keywords));
    assert.ok(body.data[0].timeRange.start <= body.data[0].timeRange.end);
  });

  it('filters by minimum cluster size', async () => {
    const { body } = await get('/clusters?minSize=2&limit=100');
    assert.ok(body.data.every((c) => c.articleCount >= 2));
  });

  it('rejects a limit above the configured maximum', async () => {
    const { status, body } = await get('/clusters?limit=9999');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'BAD_REQUEST');
  });

  it('rejects a non-integer limit', async () => {
    const { status } = await get('/clusters?limit=abc');
    assert.equal(status, 400);
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    const { status, body } = await get('/clusters?minSizee=2');
    assert.equal(status, 400);
    assert.match(body.error.message, /Unknown query parameter/);
  });

  it('rejects an inverted date range', async () => {
    const { status } = await get('/clusters?since=2026-02-01&until=2026-01-01');
    assert.equal(status, 400);
  });

  it('rejects an invalid sort value', async () => {
    const { status } = await get('/clusters?sort=sideways');
    assert.equal(status, 400);
  });
});

describe('GET /clusters/:id', () => {
  it('returns articles in chronological order', async () => {
    const { body: list } = await get('/clusters?minSize=2&limit=1');
    const id = list.data[0].id;
    const { status, body } = await get(`/clusters/${id}`);
    assert.equal(status, 200);
    assert.equal(body.data.id, id);
    assert.ok(body.data.articles.length >= 2);
    const times = body.data.articles.map((a) => a.publishedAt);
    assert.deepEqual(times, [...times].sort());
    assert.ok(body.data.representativeHeadline);
  });

  it('honours order=desc', async () => {
    const { body: list } = await get('/clusters?minSize=2&limit=1');
    const { body } = await get(`/clusters/${list.data[0].id}?order=desc`);
    const times = body.data.articles.map((a) => a.publishedAt);
    assert.deepEqual(times, [...times].sort().reverse());
  });

  it('404s on a well-formed but unknown id', async () => {
    const { status, body } = await get('/clusters/0123456789abcdef');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('400s on a malformed id', async () => {
    const { status } = await get('/clusters/not-an-id');
    assert.equal(status, 400);
  });
});

describe('GET /timeline', () => {
  it('returns a chart-ready payload', async () => {
    const { status, body } = await get('/timeline?minSize=1');
    assert.equal(status, 200);
    const { domain, buckets, series, meta, laneCount } = body.data;

    assert.ok(domain.start <= domain.end);
    assert.ok(domain.bucketHours > 0);
    assert.equal(buckets.length, domain.bucketCount);
    assert.ok(laneCount >= 1);

    for (const s of series) {
      assert.equal(s.points.length, buckets.length, 'every series shares the x-axis');
      assert.ok(s.intensity > 0 && s.intensity <= 1);
      assert.ok(new Date(s.displayEnd) > new Date(s.start), 'no zero-width bars');
      assert.equal(s.points.at(-1).cumulative, s.articleCount);
      assert.ok(Number.isInteger(s.lane));
    }
    assert.equal(
      meta.totalArticles,
      series.reduce((n, s) => n + s.articleCount, 0),
    );
  });

  it('packs lanes so bars on the same lane never overlap', async () => {
    const { body } = await get('/timeline?minSize=1');
    const byLane = new Map();
    for (const s of body.data.series) {
      const lane = byLane.get(s.lane) ?? [];
      lane.push(s);
      byLane.set(s.lane, lane);
    }
    for (const lane of byLane.values()) {
      lane.sort((a, b) => new Date(a.start) - new Date(b.start));
      for (let i = 1; i < lane.length; i++) {
        assert.ok(
          new Date(lane[i].start) >= new Date(lane[i - 1].displayEnd),
          'overlap on a shared lane',
        );
      }
    }
  });

  it('respects an explicit bucket size', async () => {
    const { body } = await get('/timeline?minSize=1&bucketHours=6');
    assert.equal(body.data.domain.bucketHours, 6);
  });

  it('400s on an out-of-range bucket size', async () => {
    const { status } = await get('/timeline?bucketHours=0');
    assert.equal(status, 400);
  });

  it('returns an empty but valid payload when nothing matches', async () => {
    const { status, body } = await get('/timeline?minSize=9999');
    assert.equal(status, 200);
    assert.deepEqual(body.data.series, []);
    assert.equal(body.data.domain, null);
  });
});

describe('ingest jobs', () => {
  it('accepts a trigger with 202 and completes', async () => {
    const res = await fetch(`${base}/ingest/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(res.status, 202);
    const { data } = await res.json();
    assert.match(data.jobId, /^[0-9a-f-]{36}$/);
    const { jobId } = data;

    let job;
    for (let i = 0; i < 50; i++) {
      const r = await get(`/ingest/status/${jobId}`);
      job = r.body.data;
      if (job.isTerminal) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.equal(job.status, 'succeeded');
    assert.equal(job.exitCode, 0);
    assert.equal(job.stats.new, 1, 'pipeline summary line is parsed into stats');
    assert.ok(job.durationMs >= 0);
  });

  it('409s when a run is already in flight', async () => {
    process.env.INGEST_ARGS = '-e,setTimeout(()=>{},3000)';
    const first = await fetch(`${base}/ingest/trigger`, { method: 'POST' });
    assert.equal(first.status, 202);
    const second = await fetch(`${base}/ingest/trigger`, { method: 'POST' });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.error.code, 'CONFLICT');
    assert.ok(body.error.details.jobId);
  });

  it('400s on a malformed job id', async () => {
    const { status } = await get('/ingest/status/nope');
    assert.equal(status, 400);
  });

  it('404s on an unknown job id', async () => {
    const { status } = await get('/ingest/status/00000000-0000-4000-8000-000000000000');
    assert.equal(status, 404);
  });

  it('400s on a malformed JSON body', async () => {
    const res = await fetch(`${base}/ingest/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

describe('meta', () => {
  it('reports health', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  it('lists sources and counts', async () => {
    const { body } = await get('/meta');
    assert.ok(body.data.articles > 0);
    assert.ok(body.data.sources.length >= 1);
  });

  it('404s an unknown route in the standard error envelope', async () => {
    const { status, body } = await get('/nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});
