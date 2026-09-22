# News Pulse — Part 1: RSS Ingestion & Topic Grouping

Pulls articles from multiple public news RSS feeds, normalises them into one
schema, fetches the real article body, stores everything in SQLite, and groups
articles covering the same story into topic clusters with timestamps — the data
that powers the timeline in Part 3.

## Feeds used

| Source | Feed URL |
|---|---|
| BBC News | `http://feeds.bbci.co.uk/news/rss.xml` |
| NPR | `https://feeds.npr.org/1001/rss.xml` |
| The Guardian (World) | `https://www.theguardian.com/world/rss` |
| Al Jazeera | `https://www.aljazeera.com/xml/rss/all.xml` |

Four rather than three, because cross-outlet clusters only appear when several
outlets cover the same story on the same day; three feeds produced a lot of
singletons. Edit `FEEDS` in `newspulse/config.py` to change them.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m newspulse ingest      # pull feeds, store new articles, fetch bodies
python -m newspulse cluster     # build topic clusters
python -m newspulse stats       # what's in the DB
python -m newspulse export -o clusters.json   # JSON handoff for the Node API
```

`python -m newspulse run` does ingest + cluster in one go — that's the command a
scheduler calls:

```
*/30 * * * * cd /srv/news-pulse && .venv/bin/python -m newspulse run >> logs/pulse.log 2>&1
```

## How it works

### Handling feed inconsistency

Every feed shapes its XML differently, so nothing is read from a single field
name. `normalise_entry` walks a list of candidates for each piece of data —
`content:encoded` → `summary_detail` → `description` → `subtitle` for text,
`media:thumbnail` → `media:content` → typed `<link>` for images.

Dates are the worst offender. `util.parse_date` accepts feedparser's
`struct_time`, RFC-822 strings, ISO-8601, `dc:date`, and anything `dateutil` can
guess, trying each candidate in turn. Items with **no** date at all fall back to
the feed-level `lastBuildDate`, and finally to ingestion time — those rows are
flagged `published_est = 1` so the timeline can render them differently rather
than silently pretending they're precise. Timestamps are stored as ISO-8601 UTC.

### Full article text

RSS gives a one-line summary, so each new article's page is fetched and the body
extracted: **trafilatura** first (good boilerplate removal across most outlets),
falling back to a BeautifulSoup heuristic that strips nav/aside/footer, finds
`<article>`/`<main>`, and joins the substantial `<p>` blocks. Anything under
`MIN_BODY_CHARS` (400) counts as a failed extraction.

Failures are expected and never raised. Each article carries `body_status`
(`ok` / `failed` / `skipped` / `pending`) and `body_error`, so one paywalled or
JS-rendered page can't take down a run. Article-page fetching is also capped per
run (`MAX_ARTICLE_FETCHES`) with a politeness delay between requests.

### Deduplication and re-runnability

Two layers, both enforced as UNIQUE constraints in SQLite so correctness doesn't
depend on the application logic being right:

1. **`id = sha1(canonical_url)`.** `canonical_url` lowercases the host, drops
   `www.`, strips the fragment, trailing slash, and tracking params (`utm_*`,
   `cmp`, `ocid`, `fbclid`…), so the same article arriving via two feeds hashes
   identically.
2. **`title_key = sha1(source + normalised_title)`**, which catches an outlet
   republishing a story under a fresh URL.

Known URLs are loaded into memory *before* any network call and new items are
checked against them, so a repeat run does no article-page fetching at all. A
second identical run inserts 0 rows — asserted in the offline test.

Note this dedupes *identical* articles. Merging the same story across different
outlets is the clustering step's job, not the dedupe step's.

## Clustering

### Which approach, and why

**Option B — TF-IDF + cosine similarity** is the default. Option A
(keyword overlap) is also implemented and selectable with `--method keyword`,
partly as a no-dependency fallback and partly as a check that the TF-IDF
clusters aren't an artefact of the vectoriser.

TF-IDF was chosen because raw word overlap has no notion of term rarity. In news
text that matters a lot: "officials", "analysts", "according" and similar wire
filler appear in most articles, so overlap counts are dominated by words that
carry no topical signal. TF-IDF down-weights exactly those terms automatically,
which means it can safely read the full article body — the keyword method can't,
and is restricted to headline + summary for that reason. (This is visible in the
offline fixtures: run the keyword method over full bodies and all 13 articles
fuse into one cluster.)

Mechanics:

- **Document text** = headline (counted twice — it's the densest topical signal
  available) + summary + the first 700 chars of the body. Body *leads*, not
  whole bodies: later paragraphs drift into background context and blur topics.
- **Vectoriser**: `ngram_range=(1,2)` so multi-word entities like "supreme
  court" survive as single features, `sublinear_tf=True` to damp word repetition
  in long articles, `max_df=0.6` to drop near-universal terms.
- **Grouping**: pairwise cosine similarity, then single-linkage via union-find
  — any pair over the threshold joins the same cluster. Chosen over KMeans
  because the number of stories in a feed window isn't known in advance and
  shouldn't have to be guessed.
- **Time window**: two articles are only linked if published within
  `TIME_WINDOW_HOURS` (96) of each other. Without this, recurring coverage of a
  standing topic — two unrelated election stories six weeks apart — collapses
  into one permanent blob and the timeline stops meaning anything.
- **Label**: top 3 terms of the cluster's TF-IDF centroid, skipping terms
  subsumed by a chosen bigram. A representative headline (member nearest the
  centroid) is also stored, since labels like "Inflation / Bank / Interest" are
  useful for grouping but a headline reads better on a timeline card.
- **Cluster IDs** are seeded on the earliest member's ID, so a cluster keeps a
  stable identity across runs as later articles are appended to it.

### How the thresholds were picked

`tests/make_fixtures.py` generates 13 synthetic articles across 6 known stories,
spread over three feeds with deliberately different formats. `tests/tune.py`
sweeps parameters and scores pairwise precision/recall against that ground truth:

```
TF-IDF cosine threshold          Keyword min shared words
  0.15  6 clusters  F1=1.00        2   6 clusters  F1=1.00
  0.20  6 clusters  F1=1.00        3   8 clusters  F1=0.80
  0.24  6 clusters  F1=1.00        4  10 clusters  F1=0.50
  0.28  7 clusters  F1=0.88        5  12 clusters  F1=0.20
  0.32  9 clusters  F1=0.62
  0.40 10 clusters  F1=0.50
```

Defaults: **cosine ≥ 0.24**, **3 shared words**. Two caveats worth being
explicit about:

- The synthetic corpus is cleaner than real news, so the plateau at the top is
  wider than it would be on live feeds. 0.24 sits mid-plateau rather than at its
  edge deliberately — there's headroom on both sides before quality degrades.
- The sweep shows precision stays at 1.00 everywhere and only recall moves.
  That's a property of single-linkage: raising the threshold only ever splits
  clusters. The real risk is at the *low* end, where a single spurious link
  chains two unrelated stories together, and the fixtures are too clean to
  surface it. On live feeds I'd tune downward cautiously and watch for
  chaining, not upward.

Both were verified end-to-end offline (`tests/run_offline.py`): TF-IDF recovers
all 6 ground-truth stories exactly, with no cross-story contamination.

### One limitation I noticed

**Single-linkage chains through "bridge" articles.** Because any single pair
above the threshold merges two groups, one article that straddles two stories —
a round-up piece, or an analysis mentioning both an election and an economy
story — can fuse two otherwise-distinct clusters into one. The time window keeps
this from doing unbounded damage, but within a 96-hour window it does happen,
and it's the failure mode most likely to produce an incoherent cluster.

The fix isn't a higher threshold (that fragments genuine clusters faster than it
prevents chaining, as the sweep shows). It's either average-linkage — require a
new member to be similar to the cluster *centroid*, not just to one member — or
a post-pass that splits any cluster whose internal similarity falls below a
floor. Average-linkage is the change I'd make next.

A second, smaller one: labels are extractive, so a cluster about a named person
often gets labelled with their surname plus two generic nouns. Good enough for a
chip on a timeline card, not good enough to read as a headline — which is why
the representative headline is stored alongside it.

## Layout

```
newspulse/
  config.py      feeds, thresholds, limits
  util.py        date parsing, URL canonicalisation, text cleaning, hashing
  db.py          SQLite schema + data access
  ingest.py      feed parsing, normalisation, body extraction, dedupe
  cluster.py     TF-IDF and keyword clustering, labelling
  stopwords.py   English stop words + news-wire filler
  cli.py         ingest / cluster / run / export / stats
tests/
  make_fixtures.py  synthetic feeds with inconsistent formats
  run_offline.py    end-to-end test, no external network
  tune.py           parameter sweep vs. ground truth
```

## Schema

`articles` is append-only. `clusters` and `article_clusters` are rebuilt on every
clustering run, since assignments legitimately shift as new articles arrive —
clustering is cheap, and keeping stale assignments would be worse than redoing
them. `runs` records per-run counts for debugging ingestion over time.

## Handoff to Part 2

`python -m newspulse export -o clusters.json` writes clusters with their
articles, labels, keywords, source counts and `first_published` /
`last_published` span — shaped so the Node API can serve it directly, or read
the SQLite file itself.
