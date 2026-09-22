"""Generate three mock RSS feeds + article pages with deliberately different
shapes, so the normaliser can be tested offline (CI, or a sandbox without
outbound network access to news sites).

Feed A: RFC-822 dates, <description> only.
Feed B: ISO-8601 dates in <dc:date>, <content:encoded> bodies, media:thumbnail.
Feed C: no per-item date at all (must fall back to the feed date), Atom-ish.
"""
import os
import random
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from xml.sax.saxutils import escape

OUT = os.path.join(os.path.dirname(__file__), "fixtures")

STORIES = [
    ("Central bank holds interest rates steady as inflation cools", [
        "Central bank holds interest rates steady as inflation cools",
        "Rate decision: policymakers keep borrowing costs on hold",
        "Interest rates unchanged as inflation slows to 2.4%, central bank says",
    ], "interest rates inflation central bank policymakers borrowing costs monetary policy committee economists"),
    ("Wildfires force thousands to evacuate coastal towns", [
        "Wildfires force thousands to evacuate coastal towns",
        "Evacuation orders widen as wildfire spreads along the coast",
        "Firefighters battle coastal wildfire for a third day",
    ], "wildfire evacuation firefighters coastal towns residents flames smoke emergency services hectares"),
    ("Parliament passes contested immigration bill", [
        "Parliament passes contested immigration bill",
        "Immigration bill clears parliament after late-night vote",
    ], "immigration bill parliament vote lawmakers opposition asylum legislation amendment"),
    ("Tech firm unveils low-power AI chip", [
        "Tech firm unveils low-power AI chip",
        "New AI chip promises big efficiency gains for data centres",
    ], "chip semiconductor artificial intelligence data centres efficiency processor manufacturing"),
    ("Record heat closes schools across the region", [
        "Record heat closes schools across the region",
    ], "heatwave temperatures schools closed pupils meteorological record summer"),
    ("Football league announces new broadcasting deal", [
        "Football league announces new broadcasting deal",
        "Broadcast rights sold in record football league agreement",
    ], "football league broadcasting rights deal clubs television streaming season"),
]

FILLER = ("The development follows several months of consultation with officials "
          "and industry groups. Analysts said the outcome was broadly in line "
          "with expectations, though questions remain about implementation. ")


def body_for(headline, terms, n=6):
    words = terms.split()
    paras = []
    for _ in range(n):
        random.shuffle(words)
        paras.append(f"<p>{escape(headline)}. " + " ".join(words) + ". " + FILLER + "</p>")
    return "\n".join(paras)


def build():
    os.makedirs(OUT, exist_ok=True)
    now = datetime.now(timezone.utc)
    random.seed(7)
    feeds = {"feed_a": [], "feed_b": [], "feed_c": []}
    names = list(feeds)

    idx = 0
    for story_no, (_, headlines, terms) in enumerate(STORIES):
        for k, headline in enumerate(headlines):
            feed = names[(story_no + k) % 3]
            published = now - timedelta(hours=story_no * 5 + k * 2 + 1)
            slug = f"article-{idx}"
            with open(os.path.join(OUT, f"{slug}.html"), "w", encoding="utf-8") as fh:
                fh.write(f"<html><head><title>{escape(headline)}</title></head><body>"
                         f"<nav>menu menu menu</nav><article><h1>{escape(headline)}</h1>"
                         f"{body_for(headline, terms)}</article>"
                         f"<footer>copyright</footer></body></html>")
            feeds[feed].append({"title": headline, "slug": slug,
                                "published": published, "terms": terms})
            idx += 1

    _write_a(feeds["feed_a"], now)
    _write_b(feeds["feed_b"], now)
    _write_c(feeds["feed_c"], now)
    print(f"wrote fixtures to {OUT}: {idx} articles across 3 feeds")


def _item_common(a, base="http://127.0.0.1:8765"):
    return f"{base}/{a['slug']}.html?utm_source=rss&utm_medium=feed"


def _write_a(items, now):
    body = "".join(
        f"""<item>
  <title>{escape(a['title'])}</title>
  <link>{_item_common(a)}</link>
  <description>{escape(a['title'])} - {escape(a['terms'][:90])}...</description>
  <pubDate>{format_datetime(a['published'])}</pubDate>
  <guid isPermaLink="false">a-{a['slug']}</guid>
</item>""" for a in items)
    _rss("feed_a.xml", "Mock Wire A", body, now)


def _write_b(items, now):
    body = "".join(
        f"""<item>
  <title>{escape(a['title'])}</title>
  <link>{_item_common(a)}</link>
  <description>{escape(a['title'][:60])}</description>
  <content:encoded><![CDATA[<p>{a['title']}. {a['terms']}. {FILLER}</p>]]></content:encoded>
  <dc:date>{a['published'].isoformat()}</dc:date>
  <dc:creator>Staff Reporter</dc:creator>
  <media:thumbnail url="http://127.0.0.1:8765/img/{a['slug']}.jpg"/>
</item>""" for a in items)
    _rss("feed_b.xml", "Mock Wire B", body, now)


def _write_c(items, now):
    # No pubDate on items at all - exercises the feed-level date fallback.
    body = "".join(
        f"""<item>
  <title>{escape(a['title'])}</title>
  <link>{_item_common(a)}</link>
  <summary>{escape(a['title'])}</summary>
</item>""" for a in items)
    _rss("feed_c.xml", "Mock Wire C", body, now)


def _rss(filename, title, items, now):
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>{title}</title>
  <link>http://127.0.0.1:8765/</link>
  <description>Offline fixture feed</description>
  <lastBuildDate>{format_datetime(now)}</lastBuildDate>
  {items}
</channel>
</rss>"""
    with open(os.path.join(OUT, filename), "w", encoding="utf-8") as fh:
        fh.write(xml)


if __name__ == "__main__":
    build()
