"""Web search and page reading, without an account.

DuckDuckGo's HTML endpoint needs no key and no signup, and it is reachable with
the `httpx` already in the dependency list -- which is what decides it. Every
dependency has to be pinned by hand for the Android build and native wheels
cross-compiled one at a time, so a search provider needing an SDK would cost a
day of that. This costs nothing, and extraction is stdlib `html.parser` --
measured at 55KB of HTML down to 11KB of text with the title intact.

Two caveats, stated here rather than discovered later:

* It is HTML scraping. There is no contract, and a markup change breaks it. The
  parser is deliberately loose and returns nothing rather than throwing, and the
  provider is swappable for a keyed API (Brave, Tavily) the day reliability
  matters more than zero setup.
* Sites block bots. Wikipedia answers an automated request with a robot-policy
  stub instead of the article, so a fetch that receives one says so rather than
  handing the model a paragraph about crawling etiquette and calling it
  research.
"""

from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import unquote

import httpx

logger = logging.getLogger("jarvis.search")

SEARCH_URL = "https://html.duckduckgo.com/html/"
TIMEOUT = 20.0

#: A browser user agent. Not deception -- an empty or obviously scripted UA is
#: refused outright by most of the web, and this request is one a person asked
#: for, in the moment, on their own machine.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

MAX_RESULTS = 8
MAX_PAGE_CHARS = 20_000

_RESULT = re.compile(r'result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_SNIPPET = re.compile(r'result__snippet"[^>]*>(.*?)</a>', re.S)
_TAGS = re.compile(r"<[^>]+>")

#: Pages that are a bot-policy notice rather than content.
_BLOCKED = re.compile(
    r"(robot policy|are you a robot|captcha|enable javascript|access denied"
    r"|unusual traffic|bot-traffic)",
    re.I,
)


@dataclass(frozen=True, slots=True)
class Result:
    title: str
    url: str
    snippet: str

    @property
    def domain(self) -> str:
        match = re.match(r"https?://([^/]+)", self.url)
        return match.group(1).replace("www.", "") if match else ""


def _clean(raw: str) -> str:
    return html.unescape(_TAGS.sub("", raw or "")).strip()


def _unwrap(url: str) -> str:
    """DuckDuckGo wraps each hit in a redirect; recover the real destination."""
    match = re.search(r"uddg=([^&]+)", url)
    if match:
        return unquote(match.group(1))
    return url if url.startswith("http") else f"https:{url}"


async def search(query: str, limit: int = 5) -> list[Result]:
    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.post(
            SEARCH_URL,
            data={"q": query},
            headers={"User-Agent": _UA},
            timeout=TIMEOUT,
        )
        response.raise_for_status()

    titles = _RESULT.findall(response.text)
    snippets = _SNIPPET.findall(response.text)

    results: list[Result] = []
    for index, (href, title) in enumerate(titles):
        cleaned = _clean(title)
        if not cleaned:
            continue
        snippet = _clean(snippets[index]) if index < len(snippets) else ""
        results.append(Result(title=cleaned, url=_unwrap(href), snippet=snippet[:300]))
        if len(results) >= min(limit, MAX_RESULTS):
            break
    return results


class _Extract(HTMLParser):
    """Readable text from a page, using nothing but the standard library."""

    SKIP = {"script", "style", "noscript", "svg", "head", "nav", "footer", "form"}
    BREAK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr", "section", "article"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.depth = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: object) -> None:
        if tag in self.SKIP:
            self.depth += 1
        if tag == "title":
            self._in_title = True
        if tag in self.BREAK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self.depth:
            self.depth -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data.strip()
        if not self.depth and data.strip():
            self.parts.append(data)

    def text(self) -> str:
        joined = "".join(self.parts)
        collapsed = re.sub(r"[ \t]+", " ", joined)
        return re.sub(r"\n{3,}", "\n\n", collapsed).strip()


async def fetch(url: str) -> tuple[str, str]:
    """Return (title, readable text) for a page.

    Never raises for an HTTP status. A refusal is information the model should
    read and route around -- try another source -- not an exception that ends
    the turn. Wikipedia, for one, answers automated requests with a 403 rather
    than the stub page it used to serve, so both shapes have to be handled.
    """
    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get(url, headers={"User-Agent": _UA}, timeout=TIMEOUT)

    if response.status_code in (401, 403, 429):
        return "", (
            f"[{response.status_code}: this site refuses automated requests. "
            "The page exists — the fetch was blocked. Use a different source.]"
        )
    if response.status_code >= 400:
        return "", f"[HTTP {response.status_code} fetching this page.]"

    kind = response.headers.get("content-type", "")
    if "html" not in kind and "text" not in kind:
        return "", f"[{kind or 'unknown content type'} — not readable as text]"

    parser = _Extract()
    parser.feed(response.text)
    body = parser.text()

    # A short page that reads like a bot notice is one, not an article. Saying so
    # is the difference between the model reporting "no information found" and
    # it quoting a crawling policy back as research.
    if len(body) < 600 and _BLOCKED.search(body):
        return parser.title, (
            "[This site refused an automated request — the page is not empty, the "
            "fetch was blocked. Try a different source.]"
        )

    if len(body) > MAX_PAGE_CHARS:
        body = body[:MAX_PAGE_CHARS] + "\n\n[…truncated]"
    return parser.title, body


# ---------------------------------------------------------------------------
# Wikipedia
# ---------------------------------------------------------------------------

#: Wikipedia refuses browser-shaped user agents outright — the generic `_UA`
#: used for scraping search pages gets a flat 403 from the API. Their policy
#: asks for a descriptive agent naming the tool, so this one does.
WIKI_UA = "JARVIS-PersonalAssistant/2.1 (personal project; contact via github)"

WIKI_SEARCH_URL = "https://en.wikipedia.org/w/api.php"
WIKI_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/"


async def wikipedia(query: str) -> dict[str, Any] | None:
    """The encyclopedia entry for `query`, or None if there isn't a clear one.

    Search results are a list of places an answer might be. For "who was
    Y. S. Rajasekhara Reddy" that is the wrong shape entirely -- five link
    previews, each a truncated sentence, and the reader still has to assemble
    the answer themselves. Wikipedia has the answer already written, with a
    photograph and a one-line description, from a source nobody has to be
    talked into trusting.

    Two calls, both keyless: find the best-matching article, then take its
    summary. Returns None rather than raising, because a missing article is a
    reason to fall back to the search results, not a reason to fail the turn.
    """
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            found = await client.get(
                WIKI_SEARCH_URL,
                params={
                    "action": "query",
                    "list": "search",
                    "srsearch": query,
                    "srlimit": 1,
                    "format": "json",
                },
                headers={"User-Agent": WIKI_UA},
            )
            found.raise_for_status()
            hits = (found.json().get("query") or {}).get("search") or []
            if not hits:
                return None

            title = hits[0].get("title")
            if not title:
                return None

            summary = await client.get(
                WIKI_SUMMARY_URL + title.replace(" ", "_"),
                headers={"User-Agent": WIKI_UA},
            )
            if summary.status_code != 200:
                return None
            page = summary.json()
    except Exception as exc:  # noqa: BLE001 - a fallback path must not raise
        logger.warning("wikipedia lookup failed for %r: %s", query, exc)
        return None

    extract = (page.get("extract") or "").strip()
    if not extract:
        return None

    return {
        "title": page.get("title") or title,
        "description": (page.get("description") or "").strip() or None,
        "extract": extract,
        "image": ((page.get("thumbnail") or {}).get("source")) or None,
        "url": ((page.get("content_urls") or {}).get("desktop") or {}).get("page"),
    }
