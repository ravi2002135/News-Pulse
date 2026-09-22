"""Stop words: standard English list + news-wire filler that is topically empty.

The second group matters more than the first. Words like "says", "report" and
"breaking" appear in a large share of headlines, so leaving them in makes
unrelated articles look similar and inflates cluster sizes.
"""

_BASE = """
a about above after again against all am an and any are aren't as at be because
been before being below between both but by can can't cannot could couldn't did
didn't do does doesn't doing don't down during each few for from further had
hadn't has hasn't have haven't having he he'd he'll he's her here here's hers
herself him himself his how how's i i'd i'll i'm i've if in into is isn't it
it's its itself let's me more most mustn't my myself no nor not of off on once
only or other ought our ours ourselves out over own same shan't she she'd
she'll she's should shouldn't so some such than that that's the their theirs
them themselves then there there's these they they'd they'll they're they've
this those through to too under until up very was wasn't we we'd we'll we're
we've were weren't what what's when when's where where's which while who who's
whom why why's with won't would wouldn't you you'd you'll you're you've your
yours yourself yourselves
"""

_NEWS = """
said says say saying told tells according report reports reported reporting
news breaking latest update updates updated live coverage analysis opinion
video watch photos photo read more full story week day today yesterday tomorrow
year years month months first new newly amid ahead following after before also
one two three many much made make makes take takes took get gets got go goes
going come comes came back set sets put puts see sees seen know knows known
think thinks thought want wants need needs way ways thing things people person
time times year-old bbc npr guardian jazeera reuters world us uk
"""

STOPWORDS = frozenset(_BASE.split()) | frozenset(_NEWS.split())


def _sklearn_safe(words):
    """scikit-learn's default token pattern (\\b\\w\\w+\\b) splits "don't" into
    "don" + "t", so contractions in a stop list never match and sklearn emits an
    inconsistency warning. Expand them into the fragments it will actually see.
    """
    import re
    out = set()
    for word in words:
        out.update(re.findall(r"\w\w+", word))
    return sorted(out)


# Pass this to TfidfVectorizer(stop_words=...) instead of STOPWORDS.
SKLEARN_STOPWORDS = _sklearn_safe(STOPWORDS)
