"""Central configuration for News Pulse ingestion + clustering."""
import os

DB_PATH = os.environ.get("NEWSPULSE_DB", "newspulse.db")

# Real, public RSS feeds. `name` is stored as the article's source.
FEEDS = [
    {"name": "BBC News", "url": "http://feeds.bbci.co.uk/news/rss.xml"},
    {"name": "NPR", "url": "https://feeds.npr.org/1001/rss.xml"},
    {"name": "The Guardian", "url": "https://www.theguardian.com/world/rss"},
    {"name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
]

# --- Ingestion -------------------------------------------------------------
USER_AGENT = "NewsPulse/1.0 (+https://example.com/newspulse; assessment project)"
REQUEST_TIMEOUT = 15          # seconds per article page
FETCH_DELAY = 0.7             # politeness delay between article-page fetches
MAX_ARTICLE_FETCHES = 60      # cap per run so a run stays bounded
MIN_BODY_CHARS = 400          # shorter than this = treat extraction as failed

# --- Clustering ------------------------------------------------------------
# Cosine similarity above which two articles are linked into the same cluster.
SIMILARITY_THRESHOLD = 0.24
# Only cluster articles published within this window of each other (hours).
TIME_WINDOW_HOURS = 96
# Ignore articles older than this when building the timeline (hours).
CLUSTER_LOOKBACK_HOURS = 24 * 14
MIN_CLUSTER_SIZE = 2          # smaller groups are kept as singleton clusters
LABEL_TERMS = 3               # number of terms in an auto-generated label
