"""Parameter sweep against the fixture ground truth (6 known stories).
Reports pairwise precision/recall/F1 over same-cluster article pairs."""
import os, sys, itertools
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from newspulse import db, cluster
from tests.make_fixtures import STORIES

truth = {}
for i, (_, headlines, _) in enumerate(STORIES):
    for h in headlines: truth[h] = i

def score(clusters, rows):
    byid = {r["id"]: r["title"] for r in rows}
    pred = {}
    for c in clusters:
        for m in c["members"]: pred[m["article_id"]] = c["id"]
    ids = list(pred)
    tp=fp=fn=0
    for a,b in itertools.combinations(ids,2):
        same_t = truth[byid[a]] == truth[byid[b]]
        same_p = pred[a] == pred[b]
        tp += same_t and same_p; fp += (not same_t) and same_p; fn += same_t and (not same_p)
    p = tp/(tp+fp) if tp+fp else 1.0
    r = tp/(tp+fn) if tp+fn else 1.0
    f = 2*p*r/(p+r) if p+r else 0.0
    return p,r,f

with db.session("/tmp/offline.db") as conn:
    rows = db.articles_for_clustering(conn, "2000-01-01T00:00:00+00:00")
    print("TF-IDF cosine threshold sweep")
    for t in [0.10,0.15,0.20,0.24,0.28,0.32,0.40,0.50]:
        cs = cluster.build_clusters(rows,"tfidf",threshold=t)
        p,r,f = score(cs,rows)
        print(f"  thr={t:<5} clusters={len(cs):<3} P={p:.2f} R={r:.2f} F1={f:.2f}")
    print("\nKeyword min-shared-words sweep")
    for m in [2,3,4,5,6]:
        cs = cluster.build_clusters(rows,"keyword",min_shared=m)
        p,r,f = score(cs,rows)
        print(f"  min={m:<5} clusters={len(cs):<3} P={p:.2f} R={r:.2f} F1={f:.2f}")
