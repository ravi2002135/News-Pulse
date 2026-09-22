# News Pulse — Part 2: Node.js Backend API

Express API serving the topic clusters produced by the Python pipeline, plus a
job runner that triggers the pipeline on demand.

## Setup

```bash
cd api
npm install
cp .env.example .env        # then set DATABASE_URL
npm start                   # or: npm run dev
npm test                    # 24 integration tests, no mocks
```

The API reads the SQLite file the Python pipeline writes, so run
`python -m newspulse run` at least once first. The server refuses to start if
`DATABASE_URL` is missing or points at a nonexistent file — a loud failure at
boot beats 500s on the first request that touches the bad setting.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/clusters` | Paginated cluster list: label, article count, time range |
| GET | `/clusters/:id` | Full cluster with all articles, chronological |
| GET | `/timeline` | Clusters shaped for plotting |
| POST | `/ingest/trigger` | Starts the Python pipeline, returns a job id (202) |
| GET | `/ingest/status/:jobId` | Poll target for a running job |
| GET | `/ingest/jobs` | Recent run history |
| GET | `/meta` | Corpus counts + source list, for filter UIs |
| GET | `/health` | Liveness + real DB round-trip |

### `GET /clusters`

Query params (all validated; unknown params are **rejected**, not ignored):

`limit` (1–`MAX_PAGE_SIZE`), `offset`, `minSize`, `source`, `q` (matches label
or keywords), `since`, `until` (ISO-8601), `sort` (`size` | `recent` | `oldest`
| `label`).

```json
{
  "data": [{
    "id": "1574d48cb1f47022",
    "label": "Coastal / Wildfire / Towns",
    "keywords": ["coastal", "wildfire", "towns"],
    "articleCount": 3,
    "sourceCount": 3,
    "timeRange": { "start": "...", "end": "...", "durationHours": 10 },
    "updatedAt": "..."
  }],
  "pagination": { "total": 6, "limit": 25, "offset": 0, "hasMore": false, "nextOffset": null },
  "filters": { "minSize": null, "sort": "size", "...": null }
}
```

No article bodies here — this backs a list view that may hold hundreds of
clusters, and filtering happens in SQL rather than by loading the table into JS.

### `GET /clusters/:id`

Adds `articles` (chronological, `?order=desc` to flip), `sources`, and
`representativeHeadline` — the member nearest the cluster centre, which reads
better on a card than the extractive keyword label. Each article carries
`publishedEstimated` so the UI can mark timestamps the pipeline had to infer
rather than presenting a guess as fact, and `hasFullText` so it can indicate
where body extraction failed.

400 on a malformed id, 404 on a well-formed but unknown one.

### `GET /timeline`

The shape here is the part worth explaining. A raw list of clusters would force
the chart component to derive its own x-domain, bucket the timestamps, normalise
intensity and solve row placement — all layout-independent work that belongs on
the server, computed once instead of on every re-render.

```jsonc
{
  "data": {
    "domain":  { "start": "...", "end": "...", "durationHours": 28,
                 "bucketHours": 6, "bucketCount": 7 },
    "buckets": ["2026-09-20T06:00:00.000Z", "..."],   // shared x-axis ticks
    "laneCount": 4,
    "series": [{
      "id": "13da4a03bfd764b7",
      "label": "Football / League / Deal",
      "keywords": ["football", "league", "deal"],
      "sources": ["BBC News", "NPR"],
      "start": "...", "end": "...",
      "displayEnd": "...",      // bar end, floored to 1h so nothing is invisible
      "durationHours": 28,
      "articleCount": 2, "sourceCount": 2,
      "intensity": 0.667,       // 0..1, ready for a colour/opacity scale
      "velocity": 1.71,         // articles per day while the story was live
      "peakAt": "...",
      "lane": 0,                // pre-packed row index for a Gantt view
      "points": [{ "t": "...", "count": 1, "cumulative": 1 }]
    }],
    "meta": { "clusterCount": 5, "totalArticles": 12, "maxArticleCount": 3,
              "maxBucketCount": 3, "minBarHours": 1, "generatedAt": "..." }
  }
}
```

Specific decisions:

- **Bucket size is snapped**, not computed as `span/48`. Targeting 48 buckets
  and rounding to the nearest of 1/2/3/6/12/24/48/168 hours means axis ticks
  land on recognisable intervals instead of 37-minute ones. Override with
  `?bucketHours=`.
- **`points` is the same length for every series**, indexed against `buckets`,
  so a stacked or stream chart can index positionally without joining on
  timestamps.
- **`displayEnd`** exists because single-article clusters have `start === end`
  and a zero-width bar renders as nothing. Draw `displayEnd`, show `end` in the
  tooltip.
- **`lane`** is greedy interval packing done server-side, so a Gantt view can
  render rows directly. A test asserts no two bars on a lane overlap.
- **`intensity` and `velocity` are different metrics on purpose.** Article count
  alone can't distinguish a story that drew 6 articles in 3 hours from one that
  drew 6 over a week; the first is breaking news and should look different.
- **`minSize` defaults to 2.** Singletons are the bulk of any run and would bury
  the real stories under one-bar-high noise. Pass `minSize=1` to see everything.

Empty results still return a valid payload (`series: []`, `domain: null`) rather
than a 404 — no matches is a legitimate answer to a well-formed query.

### `POST /ingest/trigger` → `GET /ingest/status/:jobId`

Returns **202** with a job id, not 200: the work has been accepted, not
completed. An ingest run fetches dozens of article pages and takes minutes;
holding an HTTP connection open for that hits every proxy and load-balancer
timeout in the path, hence the job-id + polling contract.

```json
{ "data": { "jobId": "…uuid…", "status": "queued",
            "statusUrl": "/ingest/status/…", "pollIntervalMs": 2000 } }
```

Status returns `queued` | `running` | `succeeded` | `failed`, plus `durationMs`,
`exitCode`, a `logTail`, and `stats` parsed out of the pipeline's own summary
line (`seen=120 new=14 duplicates=106 …`) so the UI can show what a run actually
did rather than just "done". `isTerminal` gives the client an explicit stop
condition instead of string-matching on status values.

**One run at a time.** Concurrent runs would race on the same SQLite file and
re-fetch the same article pages for no benefit, so a second trigger returns
**409** with the in-flight job's id — the client polls that one instead of
failing.

Job state lives in an `api_jobs` table rather than an in-memory Map, so it
survives a restart. On boot, any job still marked `running` is reconciled to
`failed` ("Interrupted by API restart") — otherwise a crash mid-run leaves the
frontend polling forever.

## Errors

One envelope everywhere, including 404s on unmatched routes, so the client never
handles two error shapes:

```json
{ "error": { "code": "BAD_REQUEST", "message": "…", "details": { } } }
```

| Status | When |
|---|---|
| 400 | Bad or unknown query param, malformed id, inverted date range, bad JSON body |
| 404 | Well-formed id that doesn't exist; unmatched route |
| 409 | Ingest triggered while another run is in flight |
| 500 | Unexpected — logged in full, message **not** echoed to the client |
| 503 | `INGEST_ENABLED=false`, or DB unreachable at `/health` |

Unknown query parameters are a 400 rather than being ignored, because silently
dropping a misspelled `minSize` returns a plausible-looking but wrong result set
— worse for a frontend developer than an explicit rejection.

Internal error messages are never returned in production; they can leak file
paths and SQL. `NODE_ENV=development` adds a `debug` field.

## Configuration

Everything is environment-driven — see `.env.example`. Nothing that varies
between machines is in the source.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Path to the pipeline's SQLite file |
| `PORT` / `HOST` | 4000 / 0.0.0.0 | |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated, or `*` |
| `INGEST_COMMAND` | `python3` | Point at the venv interpreter in production |
| `INGEST_ARGS` | `-m,newspulse,run` | |
| `INGEST_CWD` | `.` | Must contain the `newspulse` package |
| `INGEST_TIMEOUT_MS` | 600000 | SIGTERM then SIGKILL on overrun |
| `INGEST_ENABLED` | `true` | Set `false` where a scheduler owns ingestion |
| `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` | 25 / 100 | |

## Database

SQLite via `better-sqlite3`, opened with WAL so a Python ingest run writing to
the file doesn't block reads being served to the frontend, and a 5s busy
timeout for the moments it does contend.

The API **reads** `articles` / `clusters` / `article_clusters` (owned by the
pipeline) and **owns** `api_jobs`. That split is deliberate: the pipeline is
free to drop and rebuild cluster assignments on every run without the API
needing to care.

SQLite was chosen because both halves run on one host and it removes a service
from the deploy. It is the one thing here that wouldn't survive horizontal
scaling — see below.

## Tests

`npm test` runs 24 integration tests against a real Express server and a real
database. No mocked DB layer, so the SQL is actually exercised. Coverage
includes every endpoint, each error status, chronological ordering, the lane
non-overlap invariant, cumulative-count consistency, and the 409 concurrency
guard.

## Known limits

- **Single instance.** Job state is in SQLite, but the child-process handles are
  in-memory, so the 409 guard is per-process. Across instances this needs a real
  queue (BullMQ/Redis); only the runner changes, since the state is already
  persisted.
- **SQLite means one writer.** Fine for one API process plus a scheduled
  pipeline. A move to Postgres would touch `db.js` and nothing else — the query
  shapes are plain SQL.
- **`/timeline` computes buckets per request.** Cheap at a few hundred clusters,
  but it's the first thing to cache (keyed on `lastClusteredAt`) if the corpus
  grows.
