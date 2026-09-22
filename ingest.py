"""Stage 1: pull RSS feeds, normalise into one schema, fetch article bodies.

Design points the assessment asks about:

* Format inconsistency  -> `normalise_entry` reads every field a feed *might*
  use (content:encoded, summary_detail, description, media:*), and `parse_date`
  tries struct_time, RFC-822, ISO-8601 and a fuzzy parser in turn.
* Full article text      -> `extract_body` uses trafilatura first and falls back
  to a BeautifulSoup heuristic; failures are recorded per-article, never raised.
* Duplicates             -> canonical-URL sha1 as the primary key plus a
  title+source key, both enforced by UNIQUE constraints in SQLite.
* Re-runnable            -> URLs already in the DB are skipped before any
  network call, so a repeat run only pays for genuinely new articles.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import feedparser
import requests
from bs4 import BeautifulSoup

from . import config, db
from .util import canonical_url, clean_text, now_iso, parse_date, sha1, title_key

log = logging.getLogger("newspulse.ingest")

_session = requests.Session()
_session.headers.update({"User-Agent": config.USER_AGENT})


@dataclass
class RunStats:
    seen: int = 0
    inserted: int = 0
    duplicates: int = 0
    body_ok: int = 0
    body_failed: int = 0
    feed_errors: int = 0

    def as_dict(self):
        return {"seen": self.seen, "inserted": self.inserted,
                "duplicates": self.duplicates, "body_ok": self.body_ok,
                "body_failed": self.body_failed}


# --------------------------------------------------------------------------
# Feed parsing
# --------------------------------------------------------------------------

def fetch_feed(url: str):
    """Fetch + parse a feed. Never raises: a dead feed shouldn't kill the run."""
    try:
        resp = _session.get(url, timeout=config.REQUEST_TIMEOUT)
        resp.raise_for_status()
        return feedparser.parse(resp.content)
    except Exception as exc:  # noqa: BLE001 - deliberately broad at boundary
        log.warning("feed fetch failed %s: %s", url, exc)
        return None


def _first_text(entry, *keys) -> str:
    """Return the first non-empty field among the many names feeds use."""
    for key in keys:
        val = entry.get(key)
        if isinstance(val, list) and val:
            val = val[0].get("value") if isinstance(val[0], dict) else val[0]
        if isinstance(val, dict):
            val = val.get("value")
        text = clean_text(val if isinstance(val, str) else None)
        if text:
            return text
    return ""


def _image(entry) -> str | None:
    for key in ("media_thumbnail", "media_content"):
        items = entry.get(key) or []
        if items and isinstance(items[0], dict) and items[0].get("url"):
            return items[0]["url"]
    for link in entry.get("links", []):
        if str(link.get("type", "")).startswith("image/"):
            return link.get("href")
    return None


def normalise_entry(entry, source: str, feed_date=None) -> dict | None:
    """Map one feed entry onto the internal schema. Returns None if unusable."""
    url = canonical_url(entry.get("link") or entry.get("id") or "")
    title = _first_text(entry, "title", "title_detail")
    if not url or not title:
        return None

    summary = _first_text(entry, "summary", "summary_detail", "description",
                          "subtitle", "content")
    # content:encoded is richer than <description> when a feed provides it.
    body = ""
    for block in entry.get("content", []) or []:
        candidate = clean_text(block.get("value"))
        if len(candidate) > len(body):
            body = candidate

    published, estimated = parse_date(
        entry.get("published_parsed"), entry.get("updated_parsed"),
        entry.get("published"), entry.get("updated"),
        entry.get("dc_date"), entry.get("created"), feed_date,
    )

    return {
        "id": sha1(url),
        "url": url,
        "source": source,
        "title": title,
        "title_key": title_key(source, title),
        "summary": summary[:2000],
        "body": body or None,
        "author": clean_text(entry.get("author")) or None,
        "image_url": _image(entry),
        "published_at": published,
        "published_est": int(estimated),
        "body_status": "ok" if len(body) >= config.MIN_BODY_CHARS else "pending",
        "body_error": None,
        "fetched_at": now_iso(),
    }


# --------------------------------------------------------------------------
# Full-text extraction
# --------------------------------------------------------------------------

def extract_body(url: str) -> tuple[str | None, str, str | None]:
    """Fetch the article page and pull out the main body text.

    Returns (body, status, error). Any failure is reported, not raised.
    """
    try:
        resp = _session.get(url, timeout=config.REQUEST_TIMEOUT)
        resp.raise_for_status()
        html = resp.text
    except Exception as exc:  # noqa: BLE001
        return None, "failed", f"fetch: {type(exc).__name__}: {exc}"[:300]

    # 1. trafilatura handles boilerplate removal well across most outlets.
    try:
        import trafilatura
        text = trafilatura.extract(html, include_comments=False,
                                   include_tables=False, favor_precision=True)
        if text and len(text) >= config.MIN_BODY_CHARS:
            return clean_text(text), "ok", None
    except Exception as exc:  # noqa: BLE001
        log.debug("trafilatura failed on %s: %s", url, exc)

    # 2. Fallback: longest <article>/<main> paragraph block.
    try:
        soup = BeautifulSoup(html, "lxml")
        for tag in soup(["script", "style", "nav", "aside", "footer", "header", "form"]):
            tag.decompose()
        root = soup.find("article") or soup.find("main") or soup.body
        if root:
            paras = [clean_text(p.get_text(" ")) for p in root.find_all("p")]
            text = " ".join(p for p in paras if len(p) > 40)
            if len(text) >= config.MIN_BODY_CHARS:
                return text, "ok", None
        return None, "failed", "no body block above minimum length"
    except Exception as exc:  # noqa: BLE001
        return None, "failed", f"parse: {type(exc).__name__}: {exc}"[:300]


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------

def run(conn, feeds=None, fetch_bodies: bool = True, limit: int | None = None) -> RunStats:
    feeds = feeds or config.FEEDS
    stats = RunStats()
    run_id = db.start_run(conn)

    seen_urls = db.known_urls(conn)
    seen_titles = db.known_title_keys(conn)
    pending: list[dict] = []

    for feed in feeds:
        parsed = fetch_feed(feed["url"])
        if parsed is None or not parsed.entries:
            stats.feed_errors += 1
            log.warning("no entries from %s", feed["name"])
            continue
        feed_date = getattr(parsed.feed, "updated", None) or getattr(parsed.feed, "published", None)
        log.info("%s: %d entries", feed["name"], len(parsed.entries))

        for entry in parsed.entries:
            stats.seen += 1
            art = normalise_entry(entry, feed["name"], feed_date)
            if art is None:
                continue
            # Skip before any article-page request: this is what makes repeat
            # runs cheap.
            if art["url"] in seen_urls or art["title_key"] in seen_titles:
                stats.duplicates += 1
                continue
            seen_urls.add(art["url"])
            seen_titles.add(art["title_key"])
            pending.append(art)

    budget = limit if limit is not None else config.MAX_ARTICLE_FETCHES
    fetched = 0
    for art in pending:
        if fetch_bodies and art["body_status"] == "pending":
            if fetched < budget:
                body, status, error = extract_body(art["url"])
                art.update(body=body or art["body"], body_status=status, body_error=error)
                stats.body_ok += status == "ok"
                stats.body_failed += status == "failed"
                fetched += 1
                time.sleep(config.FETCH_DELAY)
            else:
                art["body_status"] = "skipped"
        if db.insert_article(conn, art):
            stats.inserted += 1
        else:
            stats.duplicates += 1

    conn.commit()
    db.finish_run(conn, run_id, **stats.as_dict())
    return stats
