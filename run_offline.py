"""Offline end-to-end check against the mock feeds (no external network)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from newspulse import db, ingest, cluster, config

BASE = "http://127.0.0.1:8765"
FEEDS = [{"name": "Mock Wire A", "url": f"{BASE}/feed_a.xml"},
         {"name": "Mock Wire B", "url": f"{BASE}/feed_b.xml"},
         {"name": "Mock Wire C", "url": f"{BASE}/feed_c.xml"}]

config.FETCH_DELAY = 0
DBP = "/tmp/offline.db"
if os.path.exists(DBP): os.remove(DBP)

with db.session(DBP) as conn:
    s1 = ingest.run(conn, feeds=FEEDS)
    print("run 1:", s1.as_dict())
    s2 = ingest.run(conn, feeds=FEEDS)          # idempotency check
    print("run 2:", s2.as_dict(), "<- inserted must be 0")
    assert s2.inserted == 0, "re-run inserted duplicates!"

    for row in conn.execute("SELECT source, body_status, published_est, LENGTH(body) n, published_at FROM articles ORDER BY source LIMIT 4"):
        print("  ", dict(row))

    for method in ("tfidf", "keyword"):
        cs = cluster.run(conn, method=method, lookback_hours=24*30)
        multi = [c for c in cs if c["size"] > 1]
        print(f"\n== {method}: {len(cs)} clusters, {len(multi)} multi-article")
        for c in cs:
            print(f'   [{c["size"]}a/{c["source_count"]}src] {c["label"]}')
            for m in c["members"]:
                t = conn.execute("SELECT title FROM articles WHERE id=?", (m["article_id"],)).fetchone()[0]
                print(f'        - {t[:70]}')
