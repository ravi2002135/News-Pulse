"""Stage 2: group articles that cover the same story.

Two interchangeable methods are implemented:

  tfidf    (default) TF-IDF vectors over title + summary + body lead, cosine
           similarity, single-linkage union-find above a threshold.
  keyword  Pure-Python significant-word overlap (Option A in the brief). No
           third-party dependency, used as a fallback and as a sanity check
           that the TF-IDF clusters aren't an artefact of the vectoriser.

Both produce the same output shape, so downstream code doesn't care which ran.
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from . import config, db
from .stopwords import SKLEARN_STOPWORDS, STOPWORDS
from .util import now_iso, sha1

log = logging.getLogger("newspulse.cluster")

_WORD = re.compile(r"[a-z][a-z'\-]{2,}")
# Lead of the body only: full bodies swamp the headline signal and drag
# unrelated articles together via shared boilerplate.
BODY_LEAD_CHARS = 700


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

def doc_text(row) -> str:
    """Headline is weighted x2 - it is the densest topical signal we have."""
    title = (row["title"] or "").strip()
    summary = (row["summary"] or "")[:600]
    body = (row["body"] or "")[:BODY_LEAD_CHARS]
    return " ".join([title, title, summary, body])


def short_text(row) -> str:
    """Headline + summary only.

    The keyword method uses this rather than `doc_text`: raw word-overlap has no
    notion of term rarity, so shared boilerplate in full article bodies
    ("analysts said", "according to officials") pushes every pair over the
    threshold and the whole corpus fuses into one cluster. TF-IDF is immune to
    that because it down-weights terms that appear everywhere.
    """
    return " ".join([(row["title"] or ""), (row["summary"] or "")[:600]])


def tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in STOPWORDS]


class UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, i: int) -> int:
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a: int, b: int):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _dt(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def _within_window(rows, i: int, j: int) -> bool:
    """Two articles are only linked if they're close in time.

    Without this, recurring coverage of a standing topic (e.g. two unrelated
    election stories six weeks apart) collapses into one blob and the timeline
    loses meaning.
    """
    delta = abs(_dt(rows[i]["published_at"]) - _dt(rows[j]["published_at"]))
    return delta <= timedelta(hours=config.TIME_WINDOW_HOURS)


# --------------------------------------------------------------------------
# Method A - keyword overlap
# --------------------------------------------------------------------------

def cluster_keyword(rows, min_shared: int = 3):
    """Link two articles when they share >= min_shared significant words."""
    sets = [set(tokens(short_text(r))) for r in rows]
    uf = UnionFind(len(rows))
    scores = {}
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            if not _within_window(rows, i, j):
                continue
            shared = sets[i] & sets[j]
            if len(shared) >= min_shared:
                uf.union(i, j)
                scores[(i, j)] = len(shared)
    return uf, sets, scores


# --------------------------------------------------------------------------
# Method B - TF-IDF + cosine similarity
# --------------------------------------------------------------------------

def cluster_tfidf(rows, threshold: float | None = None):
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity

    threshold = config.SIMILARITY_THRESHOLD if threshold is None else threshold
    vec = TfidfVectorizer(
        stop_words=SKLEARN_STOPWORDS,
        ngram_range=(1, 2),      # bigrams catch names like "supreme court"
        sublinear_tf=True,       # damp repeated words in long bodies
        min_df=1,
        max_df=0.6,              # drop terms present in most articles
        max_features=40000,
    )
    matrix = vec.fit_transform(doc_text(r) for r in rows)
    sim = cosine_similarity(matrix)

    uf = UnionFind(len(rows))
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            if sim[i, j] >= threshold and _within_window(rows, i, j):
                uf.union(i, j)
    return uf, matrix, vec, sim


def _label_from_tfidf(matrix, vec, idxs, n_terms: int) -> list[str]:
    import numpy as np
    centroid = np.asarray(matrix[idxs].mean(axis=0)).ravel()
    names = vec.get_feature_names_out()
    order = centroid.argsort()[::-1]
    picked: list[str] = []
    for k in order:
        term = names[k]
        if centroid[k] <= 0:
            break
        # Skip a unigram already covered by a chosen bigram, and vice versa.
        if any(term in p or p in term for p in picked):
            continue
        picked.append(term)
        if len(picked) == n_terms:
            break
    return picked


def _label_from_counts(sets, idxs, n_terms: int) -> list[str]:
    counter = Counter()
    for i in idxs:
        counter.update(sets[i])
    return [w for w, _ in counter.most_common(n_terms)]


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

def build_clusters(rows, method: str = "tfidf", threshold: float | None = None,
                   min_shared: int = 3) -> list[dict]:
    if not rows:
        return []

    if method == "tfidf":
        uf, matrix, vec, sim = cluster_tfidf(rows, threshold)
        label_fn = lambda idxs: _label_from_tfidf(matrix, vec, idxs, config.LABEL_TERMS)
        score_fn = lambda idxs, i: float(sum(sim[i, j] for j in idxs) / len(idxs))
    else:
        uf, sets, _ = cluster_keyword(rows, min_shared)
        label_fn = lambda idxs: _label_from_counts(sets, idxs, config.LABEL_TERMS)
        score_fn = lambda idxs, i: float(len(sets[i])) / max(len(sets[i]), 1)

    groups: dict[int, list[int]] = {}
    for i in range(len(rows)):
        groups.setdefault(uf.find(i), []).append(i)

    clusters = []
    for idxs in groups.values():
        keywords = label_fn(idxs) or ["untagged"]
        members = [{"article_id": rows[i]["id"], "score": round(score_fn(idxs, i), 4)}
                   for i in idxs]
        dates = sorted(rows[i]["published_at"] for i in idxs)
        # Representative headline = member closest to the cluster centre.
        lead = max(idxs, key=lambda i: score_fn(idxs, i))
        label = " / ".join(w.title() for w in keywords)
        clusters.append({
            # Seeded on the earliest member so a cluster keeps its identity
            # across runs as later articles are appended to it.
            "id": sha1("cluster:" + min(rows[i]["id"] for i in idxs))[:16],
            "label": label,
            "keywords": keywords,
            "headline": rows[lead]["title"],
            "size": len(idxs),
            "source_count": len({rows[i]["source"] for i in idxs}),
            "members": members,
            "first_published": dates[0],
            "last_published": dates[-1],
            "updated_at": now_iso(),
        })

    clusters.sort(key=lambda c: (-c["size"], c["last_published"]), reverse=False)
    clusters.sort(key=lambda c: (c["size"], c["last_published"]), reverse=True)
    return clusters


def run(conn, method: str = "tfidf", threshold: float | None = None,
        min_shared: int = 3, lookback_hours: int | None = None) -> list[dict]:
    hours = lookback_hours or config.CLUSTER_LOOKBACK_HOURS
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    rows = db.articles_for_clustering(conn, since)
    log.info("clustering %d articles (method=%s)", len(rows), method)
    clusters = build_clusters(rows, method=method, threshold=threshold, min_shared=min_shared)
    db.replace_clusters(conn, clusters)
    conn.commit()
    multi = [c for c in clusters if c["size"] >= config.MIN_CLUSTER_SIZE]
    log.info("%d clusters (%d with >=2 articles)", len(clusters), len(multi))
    return clusters
