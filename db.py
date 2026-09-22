"""SQLite storage layer.

Schema notes
------------
articles.id        sha1 of the canonical URL -> natural idempotency key, so
                   re-running the scraper can never insert the same story twice.
articles.title_key normalised title + source, used as a secondary dedupe guard
                   for outlets that republish a story under a new URL.
clusters/          rebuilt from scratch on every clustering run (clustering is
article_clusters   cheap and assignments shift as new articles arrive), while
                   `articles` is append-only.
"""
import sqlite3
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL UNIQUE,
    source        TEXT NOT NULL,
    title         TEXT NOT NULL,
    title_key     TEXT NOT NULL,
    summary       TEXT,
    body          TEXT,
    author        TEXT,
    image_url     TEXT,
    published_at  TEXT NOT NULL,          -- ISO-8601 UTC
    published_est INTEGER NOT NULL DEFAULT 0,  -- 1 = date was inferred, not given
    body_status   TEXT NOT NULL DEFAULT 'pending', -- ok | failed | skipped | pending
    body_error    TEXT,
    fetched_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_title_key ON articles(title_key);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);

CREATE TABLE IF NOT EXISTS clusters (
    id             TEXT PRIMARY KEY,
    label          TEXT NOT NULL,
    keywords       TEXT NOT NULL,         -- comma separated
    size           INTEGER NOT NULL,
    source_count   INTEGER NOT NULL,
    first_published TEXT NOT NULL,
    last_published  TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_clusters (
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    score      REAL NOT NULL DEFAULT 0,   -- similarity to cluster centroid
    PRIMARY KEY (article_id, cluster_id)
);
CREATE INDEX IF NOT EXISTS idx_ac_cluster ON article_clusters(cluster_id);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    seen        INTEGER DEFAULT 0,
    inserted    INTEGER DEFAULT 0,
    duplicates  INTEGER DEFAULT 0,
    body_ok     INTEGER DEFAULT 0,
    body_failed INTEGER DEFAULT 0,
    notes       TEXT
);
"""


def connect(path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(path or config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def session(path: str | None = None):
    conn = connect(path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def known_urls(conn) -> set[str]:
    return {r["url"] for r in conn.execute("SELECT url FROM articles")}


def known_title_keys(conn) -> set[str]:
    return {r["title_key"] for r in conn.execute("SELECT title_key FROM articles")}


def insert_article(conn, art: dict) -> bool:
    """Insert one article. Returns False if it was already stored."""
    cols = ("id url source title title_key summary body author image_url "
            "published_at published_est body_status body_error fetched_at").split()
    try:
        conn.execute(
            f"INSERT INTO articles ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
            [art.get(c) for c in cols],
        )
        return True
    except sqlite3.IntegrityError:
        return False


def update_body(conn, article_id: str, body: str | None, status: str, error: str | None = None):
    conn.execute(
        "UPDATE articles SET body=?, body_status=?, body_error=? WHERE id=?",
        (body, status, error, article_id),
    )


def articles_for_clustering(conn, since_iso: str) -> list[sqlite3.Row]:
    return list(conn.execute(
        "SELECT id, source, title, summary, body, published_at FROM articles "
        "WHERE published_at >= ? ORDER BY published_at DESC",
        (since_iso,),
    ))


def replace_clusters(conn, clusters: list[dict]):
    conn.execute("DELETE FROM article_clusters")
    conn.execute("DELETE FROM clusters")
    for c in clusters:
        conn.execute(
            "INSERT INTO clusters (id,label,keywords,size,source_count,"
            "first_published,last_published,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (c["id"], c["label"], ",".join(c["keywords"]), c["size"], c["source_count"],
             c["first_published"], c["last_published"], c["updated_at"]),
        )
        conn.executemany(
            "INSERT INTO article_clusters (article_id,cluster_id,score) VALUES (?,?,?)",
            [(m["article_id"], c["id"], m["score"]) for m in c["members"]],
        )


def start_run(conn) -> int:
    from .util import now_iso
    cur = conn.execute("INSERT INTO runs (started_at) VALUES (?)", (now_iso(),))
    return cur.lastrowid


def finish_run(conn, run_id: int, **stats):
    from .util import now_iso
    fields = ", ".join(f"{k}=?" for k in stats)
    conn.execute(
        f"UPDATE runs SET finished_at=?, {fields} WHERE id=?",
        [now_iso(), *stats.values(), run_id],
    )
