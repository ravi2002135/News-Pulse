# Single image containing both the Node API and the Python pipeline, because
# POST /ingest/trigger spawns the pipeline as a subprocess and therefore needs
# the interpreter and the newspulse package present in the same container.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY api/package*.json ./api/
RUN cd api && npm ci --omit=dev

COPY newspulse ./newspulse
COPY api ./api

ENV NODE_ENV=production \
    PORT=4000 \
    DATABASE_URL=/data/newspulse.db \
    INGEST_COMMAND=/opt/venv/bin/python \
    INGEST_ARGS=-m,newspulse,run \
    INGEST_CWD=/srv

# The DB lives on a mounted volume so ingested articles survive a redeploy.
VOLUME ["/data"]
EXPOSE 4000

# Seed the database on first boot so the API has something to serve; the
# server exits at startup if the file is missing.
CMD ["sh", "-c", "[ -f \"$DATABASE_URL\" ] || (cd /srv && NEWSPULSE_DB=$DATABASE_URL /opt/venv/bin/python -m newspulse run); node api/src/server.js"]
