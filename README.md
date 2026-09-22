# News Pulse

Pulls live news RSS feeds, groups related articles into topic clusters, and
plots those clusters on a timeline.

```
feeds ──▶ Python pipeline ──▶ SQLite ──▶ Node API ──▶ Next.js timeline
         (ingest + cluster)            (REST + jobs)   (schedule grid)
```

| Part | Directory | Docs |
|---|---|---|
| 1. RSS ingestion & topic grouping | `newspulse/` | [pipeline README](./PIPELINE.md) |
| 2. REST API | `api/` | [api/README.md](./api/README.md) |
| 3. Timeline frontend | `web/` | [web/README.md](./web/README.md) |

## Run it locally

```bash
# 1. Pipeline — pulls feeds, extracts article text, builds clusters
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m newspulse run

# 2. API (terminal 2)
cd api && npm install && cp .env.example .env    # set DATABASE_URL
npm start                                         # http://localhost:4000

# 3. Frontend (terminal 3)
cd web && npm install && cp .env.example .env.local
npm run dev                                       # http://localhost:3000
```

Keeping data fresh, once deployed:

```
*/30 * * * * cd /srv/news-pulse && .venv/bin/python -m newspulse run >> logs/pulse.log 2>&1
```

The UI's "Refresh data" button triggers the same command on demand through the
API, so a scheduler is a convenience rather than a requirement.

## Feeds

BBC News, NPR, The Guardian (World), Al Jazeera — all public RSS. Listed with
their URLs in the pipeline README; change them in `newspulse/config.py`.

## Tests

```bash
python tests/run_offline.py    # pipeline end-to-end against mock feeds
python tests/tune.py           # clustering parameter sweep vs. ground truth
cd api && npm test             # 24 API integration tests
cd web && npm run build        # type check + production build
```

The pipeline tests run against generated fixtures with deliberately inconsistent
feed formats, so they need no network and no live news.

## Deploying

`api/Dockerfile` builds one image containing both the Node API and the Python
pipeline — `POST /ingest/trigger` spawns the pipeline as a subprocess, so they
need to be co-located. The SQLite file lives on a mounted volume at `/data` so
ingested articles survive a redeploy, and the container seeds it on first boot.

The frontend deploys separately as a standard Next.js app; point
`NEXT_PUBLIC_API_URL` at the API and add that origin to the API's
`CORS_ORIGINS`.

## What I'd change next

- **Average-linkage clustering.** Single-linkage chains through bridge articles;
  this is the pipeline's main failure mode and is written up in its README.
- **Postgres instead of SQLite**, if this ever needs more than one API instance.
  The queries are plain SQL, so it touches `api/src/db.js` and nothing else.
- **URL state in the frontend**, so a filtered view can be shared.
