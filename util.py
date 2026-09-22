"""Normalisation helpers shared by the ingestion and clustering stages."""
import hashlib
import re
import unicodedata
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

from dateutil import parser as dateparser

# Tracking params that differ per-feed for the same underlying article.
_JUNK_QUERY_PREFIXES = ("utm_", "cmp", "cmpid", "ito", "at_", "fbclid", "gclid",
                        "ns_", "ocid", "smid", "partner", "ref", "src")

_WS = re.compile(r"\s+")
_TAG = re.compile(r"<[^>]+>")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha1(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()


def canonical_url(url: str) -> str:
    """Strip tracking params + fragments so the same story hashes identically."""
    if not url:
        return ""
    p = urlparse(url.strip())
    query = [(k, v) for k, v in parse_qsl(p.query)
             if not any(k.lower().startswith(j) for j in _JUNK_QUERY_PREFIXES)]
    path = p.path.rstrip("/") or "/"
    netloc = p.netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    return urlunparse((p.scheme or "https", netloc, path, "", urlencode(query), ""))


def clean_text(value: str | None) -> str:
    """Strip HTML, collapse whitespace, normalise unicode. Safe on None."""
    if not value:
        return ""
    text = unicodedata.normalize("NFKC", value)
    text = _TAG.sub(" ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&quot;", '"').replace("&#39;", "'")
                .replace("&lt;", "<").replace("&gt;", ">"))
    return _WS.sub(" ", text).strip()


def title_key(source: str, title: str) -> str:
    """Secondary dedupe key: same outlet + same headline (ignoring punctuation)."""
    norm = re.sub(r"[^a-z0-9 ]+", "", clean_text(title).lower())
    return sha1(f"{source.lower()}|{_WS.sub(' ', norm).strip()}")


def parse_date(*candidates) -> tuple[str, bool]:
    """Try every candidate date representation a feed might hand us.

    Accepts struct_time tuples (feedparser), RFC-822 strings, ISO strings and
    anything dateutil can guess. Returns (iso_utc, was_estimated).
    """
    for cand in candidates:
        if not cand:
            continue
        dt = _coerce(cand)
        if dt:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dt = dt.astimezone(timezone.utc)
            # Guard against feeds with wildly wrong clocks.
            if 2000 < dt.year < datetime.now(timezone.utc).year + 1:
                return dt.isoformat(timespec="seconds"), False
    return now_iso(), True


def _coerce(cand):
    if isinstance(cand, datetime):
        return cand
    if isinstance(cand, (tuple, list)) and len(cand) >= 6:
        try:
            return datetime(*cand[:6], tzinfo=timezone.utc)
        except (TypeError, ValueError):
            return None
    if isinstance(cand, str):
        s = cand.strip()
        if not s:
            return None
        for fn in (parsedate_to_datetime, _iso, dateparser.parse):
            try:
                dt = fn(s)
                if dt:
                    return dt
            except (TypeError, ValueError, OverflowError):
                continue
    return None


def _iso(s: str):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
