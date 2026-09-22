"""Command line interface.

    python -m newspulse ingest            # pull feeds, store new articles
    python -m newspulse cluster           # (re)build topic clusters
    python -m newspulse run               # ingest + cluster, for a scheduler
    python -m newspulse export -o out.json
    python -m newspulse stats
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from . import cluster as cluster_mod
from . import config, db, ingest


def _log(verbose: bool):
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def cmd_ingest(args, conn):
    stats = ingest.run(conn, fetch_bodies=not args.no_bodies, limit=args.limit)
    print(f"seen={stats.seen} new={stats.inserted} duplicates={stats.duplicates} "
          f"bodies ok={stats.body_ok} failed={stats.body_failed} "
          f"feed_errors={stats.feed_errors}")


def cmd_cluster(args, conn):
    clusters = cluster_mod.run(conn, method=args.method, threshold=args.threshold,
                               min_shared=args.min_shared, lookback_hours=args.lookback)
    multi = [c for c in clusters if c["size"] > 1]
    print(f"{len(clusters)} clusters, {len(multi)} multi-article\n")
    for c in multi[:15]:
        span = f'{c["first_published"][:16]} -> {c["last_published"][:16]}'
        print(f'  [{c["size"]:>2}a/{c["source_count"]}src] {c["label"]}')
        print(f'        {span}  |  {c["headline"][:80]}')


def cmd_export(args, conn):
    """Dump clusters + articles as JSON - the handoff to the Node API."""
    articles = {r["id"]: dict(r) for r in conn.execute(
        "SELECT id,url,source,title,summary,author,image_url,published_at,"
        "published_est,body_status,LENGTH(body) AS body_chars FROM articles")}
    payload = {"generated_at": __import__("datetime").datetime.now().isoformat(),
               "clusters": [], "article_count": len(articles)}
    for c in conn.execute("SELECT * FROM clusters ORDER BY size DESC, last_published DESC"):
        members = conn.execute(
            "SELECT article_id, score FROM article_clusters WHERE cluster_id=? "
            "ORDER BY score DESC", (c["id"],)).fetchall()
        payload["clusters"].append({
            "id": c["id"], "label": c["label"],
            "keywords": c["keywords"].split(","),
            "size": c["size"], "source_count": c["source_count"],
            "first_published": c["first_published"],
            "last_published": c["last_published"],
            "articles": [{**articles[m["article_id"]], "score": m["score"]}
                         for m in members if m["article_id"] in articles],
        })
    out = json.dumps(payload, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out)
        print(f"wrote {args.out} ({len(payload['clusters'])} clusters)")
    else:
        print(out)


def cmd_stats(args, conn):
    def q(sql, *params):
        return conn.execute(sql, params).fetchone()[0]

    print(f"articles         : {q('SELECT COUNT(*) FROM articles')}")
    print(f"  bodies ok      : {q('SELECT COUNT(*) FROM articles WHERE body_status=?', 'ok')}")
    print(f"  estimated dates: {q('SELECT COUNT(*) FROM articles WHERE published_est=1')}")
    print(f"clusters         : {q('SELECT COUNT(*) FROM clusters')}")
    print(f"  multi-article  : {q('SELECT COUNT(*) FROM clusters WHERE size>1')}")
    print("\nby source:")
    for r in conn.execute("SELECT source, COUNT(*) n FROM articles GROUP BY source ORDER BY n DESC"):
        print(f"  {r['source']:<16} {r['n']}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="newspulse")
    p.add_argument("--db", default=config.DB_PATH)
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("ingest", help="fetch feeds and store new articles")
    pi.add_argument("--no-bodies", action="store_true", help="skip article-page fetches")
    pi.add_argument("--limit", type=int, default=None, help="max article pages to fetch")
    pi.set_defaults(fn=cmd_ingest)

    pc = sub.add_parser("cluster", help="rebuild topic clusters")
    pc.add_argument("--method", choices=["tfidf", "keyword"], default="tfidf")
    pc.add_argument("--threshold", type=float, default=None, help="cosine threshold (tfidf)")
    pc.add_argument("--min-shared", type=int, default=3, help="shared words (keyword)")
    pc.add_argument("--lookback", type=int, default=None, help="hours of history to cluster")
    pc.set_defaults(fn=cmd_cluster)

    pr = sub.add_parser("run", help="ingest then cluster")
    pr.add_argument("--no-bodies", action="store_true")
    pr.add_argument("--limit", type=int, default=None)
    pr.add_argument("--method", choices=["tfidf", "keyword"], default="tfidf")
    pr.add_argument("--threshold", type=float, default=None)
    pr.add_argument("--min-shared", type=int, default=3)
    pr.add_argument("--lookback", type=int, default=None)
    pr.set_defaults(fn=lambda a, c: (cmd_ingest(a, c), cmd_cluster(a, c)))

    pe = sub.add_parser("export", help="dump clusters as JSON for the API")
    pe.add_argument("-o", "--out", default=None)
    pe.set_defaults(fn=cmd_export)

    ps = sub.add_parser("stats", help="show what is in the database")
    ps.set_defaults(fn=cmd_stats)

    args = p.parse_args(argv)
    _log(args.verbose)
    with db.session(args.db) as conn:
        args.fn(args, conn)
    return 0


if __name__ == "__main__":
    sys.exit(main())
