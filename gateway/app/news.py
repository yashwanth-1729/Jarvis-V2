"""The News tab: one shared copy per section, refreshed every night by Grok
with live web search (docs/public-edition.md, "News Drops").

* **Nightly, not per user.** At ``NEWS_REFRESH_AT`` (04:30 IST) the gateway
  asks ``NEWS_MODEL`` (Grok 4.3) once per section for the day's biggest
  stories, using OpenRouter's native web search (web + X). The result is
  stored once and ``GET /v1/news`` serves it to everyone, so reading news
  costs no AI call, no Aura and no sign-in.
* **Checked, not trusted.** The model answers in a strict JSON schema. Every
  item is cleaned (lengths, plain text, http(s) links only), dated within the
  section's window and de-duplicated. Its link is checked against the
  citations the search actually returned: a link that isn't among them is
  dropped (the story stays, without a link), unless it is an article on a
  site the search read.
* **Never worse than yesterday.** A section whose refresh fails or comes back
  thin keeps its previous copy; only the attempt is recorded.
* **Bounded spend.** The model gets a search budget per section
  (``NEWS_SEARCHES_PER_SECTION``; cost grows with every search, because each
  one's results are re-read on the next step). ``NEWS_DAILY_BUDGET_USD``
  stops the day's refreshes, nightly and admin together, once reached. Every
  call is logged in ``usage`` as ``system:news`` with plan ``system``: no
  account is charged and the free pool is untouched.

* **Off until launch; hand-posting always works.** The nightly refresh
  only runs with ``NEWS_REFRESH_ENABLED=true`` (the owner turns it on at the
  Play Store launch). The owner can post stories by hand at any time
  (``POST /v1/admin/news/items``); those stay pinned at the top of their
  section, through later refreshes, until they're older than its window.

Endpoints: ``GET /v1/news`` (public, rate-limited per IP), and with
``X-Admin-Token``: ``POST /v1/admin/news/refresh``, ``POST
/v1/admin/news/items``, ``DELETE /v1/admin/news/items/{section}[/{id}]``.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import insert, select, update

from app.config import Settings
from app.context import Gateway, gateway
from app.db import aware, news_sections, utcnow
from app.errors import GatewayError
from app.limits import read_json
from app.metering import extract_chat_usage, usd_to_inr
from app.planner import _client_ip
from app.proxy import _timeout, _upstream_headers

logger = logging.getLogger("holo.gateway.news")

router = APIRouter()

#: Whose spend the refreshes are logged under (``usage.user_id``).
NEWS_USER = "system:news"
#: Fewer usable items than this and the section keeps its previous copy.
MIN_ITEMS = 3
#: At most this many stories per section are flagged as trending.
MAX_TRENDING = 2
#: Stories in one hand post, and in a section at most.
MAX_POSTED = 10
MAX_SECTION_ITEMS = 20
#: The source shown on a hand-posted story that names none.
POSTED_SOURCE = "JARVIS"
#: Reads of GET /v1/news per minute per IP.
READS_PER_MINUTE = 30
#: One section's call: searching plus writing took 19-40 s when measured.
UPSTREAM_TIMEOUT = 180.0
#: Room for the reasoning and eight items.
MAX_TOKENS = 6000
#: The nightly run's failed sections are tried once more after this long.
RETRY_AFTER_SECONDS = 20 * 60
#: Let startup finish before the catch-up refresh.
STARTUP_DELAY_SECONDS = 20.0

#: Grok 4.3's list price on 2026-10-17, used only when OpenRouter reports no
#: cost of its own (it normally does, search included).
_FALLBACK_PROMPT = Decimal("1.25e-6")
_FALLBACK_CACHED = Decimal("0.2e-6")
_FALLBACK_COMPLETION = Decimal("2.5e-6")
_FALLBACK_SEARCH = Decimal("0.005")


@dataclass(frozen=True)
class Section:
    id: str
    title: str
    #: What the section covers, as the model is told.
    brief: str
    #: The oldest story kept, in days before today.
    max_age_days: int = 3


#: The sections, in the app's default order (the user's interests come first
#: in the app). Ids are stable: the app keys its icons and its saved order on
#: them. A section added here shows up in the app with a default icon.
SECTIONS: tuple[Section, ...] = (
    Section("cricket", "Cricket", "Cricket. India's matches first (men's and women's), then the biggest international cricket: results with scores, squads, injuries, records. IPL and WPL news when they are in the headlines."),
    Section("esports", "Esports & gaming", "Esports and gaming, India first: BGMI, Valorant, Free Fire MAX, CS2, Dota 2 and LoL tournaments and results, Indian teams and players, big game launches, updates and bans."),
    Section("india", "India", "Indian national politics and governance: Parliament, the central government's decisions, elections, major state politics, and Supreme Court rulings with wide impact. Neutral and factual; no opinion pieces."),
    Section("world", "World", "International politics and world affairs: wars and ceasefires, elections, summits, diplomacy, and India's foreign relations. Neutral and factual; no opinion pieces."),
    Section("tech", "Tech & IT", "IT and tech: Indian IT companies (TCS, Infosys, Wipro, HCLTech), hiring and layoffs, big tech, phone and gadget launches in India, apps, telecom, and cybersecurity incidents."),
    Section("ai", "AI", "AI: new model releases, AI companies (OpenAI, Anthropic, Google, Meta, xAI, Indian AI startups), research breakthroughs, AI rules and policy, and AI tools people can actually use."),
    Section("current_affairs", "Current affairs", "Current affairs for competitive-exam aspirants (UPSC, SSC, banking, state PSCs): government schemes, appointments, awards, reports and indices, defence, space, economy numbers (RBI, GDP, inflation) and important days. Exam-relevant facts, stated plainly."),
    Section("business", "Business & startups", "Business, markets and startups in India: Sensex and Nifty moves, big deals, funding rounds, IPOs, startup launches and shutdowns, the RBI and the economy, and personal-finance changes (tax, UPI, rates)."),
    Section("football", "Football", "Football: the India team and the ISL first, then the Premier League, La Liga, the Champions League and other big leagues: results, transfers, injuries, records."),
    Section("sports", "More sports", "Other sports, Indian athletes first: chess, badminton, tennis, hockey, kabaddi, athletics, boxing, wrestling, shooting, Formula 1 and the Olympics."),
    Section("entertainment", "Movies & OTT", "Movies, OTT and music in India: Telugu, Tamil, Hindi and Malayalam films (releases, box office, trailers, casting), OTT drops, big K-drama and anime news, and music releases."),
    Section("science", "Science & space", "Science and space: ISRO missions, NASA and SpaceX, discoveries, climate and environment, and health research that matters to people.", 4),
    Section("jobs", "Exams & jobs", "Exams and jobs for students in India: government exam notifications, admit cards, results and answer keys, application deadlines (UPSC, SSC, banking, railways, state PSCs, JEE, NEET, GATE, CAT), and campus hiring news.", 5),
)
_BY_ID = {section.id: section for section in SECTIONS}

SYSTEM = """You are the news desk for JARVIS, an app for young people in India (16-28, students and early-career).
Find the latest, most talked-about news for ONE section, using live web search (and X to judge what is trending).
Today is {today} (India time).
Rules:
- Only real stories published on or after {oldest}. Never invent a story, a number, a quote or a link.
- Search budget: at most {searches} in total, so make each query count. Do not open extra pages.
- url: the specific article page for that story, taken from your search results (it usually has a long slug or an id). Never a homepage, a section, tag or topic page, or a search page. If the only page you have for a story is a listing page, leave the story out.
- Rank by how big and how talked-about the story is right now. trending = true for at most 2 stories that are blowing up today.
- title: a short, clear headline in plain English, at most 90 characters. No clickbait, no emojis.
- summary: 2 sentences, at most 280 characters: what happened, and why it matters. Facts only; neutral on politics.
- source: the publication's name, like "ESPNcricinfo" or "The Hindu".
- published: the article's date as YYYY-MM-DD.
- One item per story, no duplicates. Prefer established outlets (Indian and international) over blogs and aggregators.
Return {low} to {high} items, most important first."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "summary", "source", "url", "published", "trending"],
                "properties": {
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "source": {"type": "string"},
                    "url": {"type": "string"},
                    "published": {"type": "string"},
                    "trending": {"type": "boolean"},
                },
            },
        },
    },
}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def active_sections(settings: Settings) -> list[Section]:
    """The sections the refresh covers (``NEWS_SECTIONS``, else all)."""
    wanted = [s.strip() for s in settings.news_sections.split(",") if s.strip()]
    return [_BY_ID[s] for s in wanted if s in _BY_ID] if wanted else list(SECTIONS)


def refresh_time(settings: Settings) -> tuple[int, int]:
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", settings.news_refresh_at.strip())
    if not match or int(match[1]) > 23 or int(match[2]) > 59:
        raise ValueError(f"NEWS_REFRESH_AT must be HH:MM, got {settings.news_refresh_at!r}.")
    return int(match[1]), int(match[2])


def validate_settings(settings: Settings) -> None:
    """Called by ``create_app``: a typo here should stop the deploy, not leave
    a section silently unrefreshed."""
    refresh_time(settings)
    wanted = [s.strip() for s in settings.news_sections.split(",") if s.strip()]
    unknown = sorted(set(wanted) - set(_BY_ID))
    if unknown:
        raise ValueError(f"NEWS_SECTIONS has unknown sections {unknown}; known: {sorted(_BY_ID)}.")


def next_run(now: datetime, settings: Settings) -> datetime:
    """The next nightly refresh after ``now`` (UTC in, UTC out)."""
    hour, minute = refresh_time(settings)
    offset = timedelta(minutes=settings.daily_cap_utc_offset_minutes)
    local = now + offset
    target = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return target - offset


def _today(gw: Gateway) -> date:
    return (gw.clock() + timedelta(minutes=gw.settings.daily_cap_utc_offset_minutes)).date()


# ---------------------------------------------------------------------------
# Cleaning the model's answer
# ---------------------------------------------------------------------------

_TAGS = re.compile(r"<[^>]{0,200}>")
_CONTROL = re.compile(r"[\x00-\x1f\x7f​-‏ -‮﻿]")
#: Citation markers a model sometimes leaves in prose: [1], [12], 【3】.
_MARKERS = re.compile(r"\s*(\[\d{1,3}\]|【[^】]{0,40}】)")
_ARTICLE_FILE = re.compile(r"\.(s?html?|ece|cms|php|aspx?)$", re.I)
_LONG_NUMBER = re.compile(r"\d{4,}")
_WORD = re.compile(r"[a-z0-9]+")
_TRACKING = ("utm_", "fbclid", "gclid", "ref", "ref_src", "cmp", "mc_")
_STOPWORDS = frozenset(
    "the a an and or of to in on for at by with from as is are was were be after over into amid "
    "vs v new its it this that his her their says said will can".split()
)


def _text(value: Any, limit: int) -> str:
    """Plain, single-line text, cut at a word boundary."""
    if not isinstance(value, str):
        return ""
    text = _MARKERS.sub("", _CONTROL.sub(" ", _TAGS.sub(" ", value)))
    text = " ".join(text.split())
    if len(text) > limit:
        cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:-")
        text = (cut or text[: limit - 1]) + "…"
    return text


def _http_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    url = value.strip()
    if not url or len(url) > 600 or any(c.isspace() for c in url):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    host = parts.hostname or ""
    if parts.scheme not in ("http", "https") or "." not in host or parts.username or parts.password:
        return None
    return url


def _host(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    for prefix in ("www.", "m.", "amp."):
        host = host.removeprefix(prefix)
    return host


def _norm(url: str) -> str:
    """Scheme, fragment, a trailing slash and tracking parameters don't make a
    different page."""
    parts = urlsplit(url)
    query = urlencode(sorted(
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith(_TRACKING)
    ))
    return f"{_host(url)}{parts.path.rstrip('/')}" + (f"?{query}" if query else "")


def _clean_url(url: str) -> str:
    """The link as stored: without tracking parameters or a fragment."""
    parts = urlsplit(url)
    query = urlencode([
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith(_TRACKING)
    ])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def article_like(url: str) -> bool:
    """An article page, not a homepage, section, tag or search page: it ends
    in a long slug or a file name, or carries an id."""
    parts = urlsplit(url)
    segments = [s for s in parts.path.split("/") if s]
    if not segments:
        return False
    last = segments[-1]
    return bool(
        _LONG_NUMBER.search(parts.path) or _LONG_NUMBER.search(parts.query)
        or last.count("-") >= 3 or last.count("_") >= 3 or _ARTICLE_FILE.search(last)
    )


def _words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if len(w) > 2 and w not in _STOPWORDS}


def _same_story(a: set[str], b: set[str]) -> bool:
    return bool(a and b) and len(a & b) / len(a | b) >= 0.6


def _published(value: Any, today: date, max_age_days: int) -> tuple[bool, str | None]:
    """(keep, date). A story older than the window is dropped; a date that
    can't be read, or is in the future, is kept without a date."""
    match = re.match(r"\s*(\d{4})-(\d{2})-(\d{2})", value) if isinstance(value, str) else None
    if not match:
        return True, None
    try:
        day = date(int(match[1]), int(match[2]), int(match[3]))
    except ValueError:
        return True, None
    if day > today + timedelta(days=1):
        return True, None
    if day < today - timedelta(days=max_age_days):
        return False, None
    return True, day.isoformat()


def citations(message: dict[str, Any]) -> list[str]:
    """The URLs the web search returned (OpenRouter's ``url_citation``
    annotations)."""
    found: list[str] = []
    for note in message.get("annotations") or []:
        if not isinstance(note, dict) or note.get("type") != "url_citation":
            continue
        url = _http_url((note.get("url_citation") or {}).get("url"))
        if url:
            found.append(url)
    return found


def _link(url: str | None, cited: set[str], cited_hosts: set[str]) -> str | None:
    if url is None:
        return None
    if _norm(url) in cited:
        return _clean_url(url)
    # Not among the citations, but an article on a site the search read:
    # most likely a page it saw whose URL the citation list shortened.
    if _host(url) in cited_hosts and article_like(url):
        return _clean_url(url)
    return None


def parse_items(content: Any) -> list[Any] | None:
    """The ``items`` list from the model's content: strict JSON, or (when the
    provider ignored the schema) the first JSON object in the prose."""
    data: Any = content
    if isinstance(content, str):
        try:
            data = json.loads(content)
        except ValueError:
            match = re.search(r"\{.*\}", content, re.S)
            if not match:
                return None
            try:
                data = json.loads(match.group(0))
            except ValueError:
                return None
    items = data.get("items") if isinstance(data, dict) else None
    return items if isinstance(items, list) else None


def clean_items(
    raw: list[Any], section: Section, today: date, cited_urls: list[str], limit: int,
) -> list[dict[str, Any]]:
    cited = {_norm(u) for u in cited_urls}
    cited_hosts = {_host(u) for u in cited_urls}
    out: list[dict[str, Any]] = []
    seen_titles: list[set[str]] = []
    seen_articles: set[str] = set()
    trending = 0
    for entry in raw:
        if len(out) >= limit:
            break
        if not isinstance(entry, dict):
            continue
        title = _text(entry.get("title"), 120)
        summary = _text(entry.get("summary"), 360)
        if len(title) < 8 or len(summary) < 20:
            continue
        keep, published = _published(entry.get("published"), today, section.max_age_days)
        if not keep:
            continue
        words = _words(title)
        if any(_same_story(words, other) for other in seen_titles):
            continue
        url = _link(_http_url(entry.get("url")), cited, cited_hosts)
        if url and article_like(url):
            key = _norm(url)
            if key in seen_articles:
                continue
            seen_articles.add(key)
        seen_titles.append(words)
        source = _text(entry.get("source"), 60) or (_host(url) if url else "")
        hot = entry.get("trending") is True and trending < MAX_TRENDING
        trending += hot
        out.append({
            "id": hashlib.sha1(f"{section.id}:{_norm(url) if url else title.lower()}".encode()).hexdigest()[:12],
            "title": title,
            "summary": summary,
            "source": source,
            "url": url,
            "published": published,
            "trending": hot,
            "manual": False,
        })
    return out


def _still_pinned(items: list[Any], section: Section, now: datetime) -> list[dict[str, Any]]:
    """Hand-posted stories younger than the section's window."""
    cutoff = now - timedelta(days=section.max_age_days)
    keep = []
    for entry in items:
        if not isinstance(entry, dict) or entry.get("manual") is not True:
            continue
        try:
            posted = aware(datetime.fromisoformat(str(entry.get("posted_at"))))
        except ValueError:
            continue
        if posted is not None and posted >= cutoff:
            keep.append(entry)
    return keep


def _merge(first: list[dict[str, Any]], rest: list[Any]) -> list[dict[str, Any]]:
    """``first`` on top, then ``rest`` without the stories ``first`` already
    tells."""
    told = [_words(entry["title"]) for entry in first]
    seen = {entry["id"] for entry in first}
    merged = list(first)
    for entry in rest:
        if not isinstance(entry, dict) or entry.get("id") in seen:
            continue
        if any(_same_story(_words(str(entry.get("title", ""))), words) for words in told):
            continue
        seen.add(entry.get("id"))
        merged.append(entry)
    return merged[:MAX_SECTION_ITEMS]


def _loads(raw: Any) -> list[Any]:
    try:
        items = json.loads(raw) if isinstance(raw, str) else []
    except ValueError:
        return []
    return items if isinstance(items, list) else []


# ---------------------------------------------------------------------------
# Refreshing
# ---------------------------------------------------------------------------

def _payload(gw: Gateway, section: Section, today: date, *, structured: bool) -> dict[str, Any]:
    settings = gw.settings
    searches = max(1, settings.news_searches_per_section)
    high = max(MIN_ITEMS, settings.news_items_per_section)
    system = SYSTEM.format(
        today=today.isoformat(),
        oldest=(today - timedelta(days=section.max_age_days)).isoformat(),
        searches=f"{searches} web search{'es' if searches != 1 else ''}",
        low=max(MIN_ITEMS, high - 2), high=high,
    )
    payload: dict[str, Any] = {
        "model": settings.news_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": f"Section: {section.title}. {section.brief}"},
        ],
        # Grok's own search (web + X). max_results only steers engines that
        # take it; the search budget in the prompt is what bounds the cost.
        "plugins": [{"id": "web", "max_results": 6}],
        "reasoning": {"effort": "low"},
        "max_tokens": MAX_TOKENS,
        "usage": {"include": True},
    }
    if structured:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "news_section", "strict": True, "schema": SCHEMA},
        }
    else:
        payload["messages"][0]["content"] += (
            '\nAnswer with JSON only: {"items": [{"title", "summary", "source", "url", "published", "trending"}]}.'
        )
    return payload


def _cost(raw_usage: Any) -> tuple[Decimal, Decimal | None, int]:
    """(cost charged to us, OpenRouter's own figure, searches made)."""
    usage = extract_chat_usage(raw_usage)
    searches = 0
    if isinstance(raw_usage, dict):
        tools = raw_usage.get("server_tool_use_details")
        if isinstance(tools, dict) and isinstance(tools.get("web_search_requests"), int):
            searches = max(tools["web_search_requests"], 0)
    if usage is None:
        return Decimal(0), None, searches
    cached = min(usage.cached_tokens, usage.prompt_tokens)
    estimate = (
        (usage.prompt_tokens - cached) * _FALLBACK_PROMPT + cached * _FALLBACK_CACHED
        + usage.completion_tokens * _FALLBACK_COMPLETION + searches * _FALLBACK_SEARCH
    )
    reported = usage.upstream_cost
    return (reported if reported is not None else estimate), reported, searches


async def _call(gw: Gateway, section: Section, today: date) -> tuple[str, str | None, dict[str, Any]]:
    """(status, error, response body). Retries once without the schema if the
    provider refuses structured output alongside search."""
    for structured in (True, False):
        try:
            response = await gw.upstream.post(
                "/chat/completions", json=_payload(gw, section, today, structured=structured),
                headers=_upstream_headers(gw), timeout=_timeout(gw, UPSTREAM_TIMEOUT),
            )
        except httpx.HTTPError as exc:
            return "upstream_unreachable", type(exc).__name__, {}
        if response.status_code == 400 and structured:
            logger.warning("news %s: structured output refused, retrying as text: %s",
                           section.id, response.text[:200])
            continue
        if response.status_code >= 400:
            return "upstream_error", f"HTTP {response.status_code}: {response.text[:200]}", {}
        try:
            data = response.json()
        except ValueError:
            return "unreadable", "the response was not JSON", {}
        return "ok", None, data if isinstance(data, dict) else {}
    return "upstream_error", "HTTP 400", {}


async def _store(gw: Gateway, section: Section, items: list[dict[str, Any]] | None,
                 cost: Decimal, error: str | None) -> None:
    now = gw.clock()
    async with gw.db.tx() as conn:
        exists = (await conn.execute(
            select(news_sections.c.stories).where(news_sections.c.section == section.id)
        )).first()
        if items is not None:
            # Hand-posted stories outlive the refresh while they're current.
            pinned = _still_pinned(_loads(exists.stories), section, now) if exists else []
            values: dict[str, Any] = dict(
                stories=json.dumps(_merge(pinned, items), ensure_ascii=False), model=gw.settings.news_model,
                cost_usd=float(cost), refreshed_at=now, attempted_at=now, last_error=None,
            )
        else:
            values = dict(attempted_at=now, last_error=(error or "failed")[:500])
        if exists:
            await conn.execute(
                update(news_sections).where(news_sections.c.section == section.id).values(**values)
            )
        else:
            await conn.execute(insert(news_sections).values(
                section=section.id, **{"stories": "[]", "cost_usd": 0.0, **values},
            ))


async def refresh_section(gw: Gateway, section: Section) -> dict[str, Any]:
    """Ask the model for one section and store what survives the checks."""
    today = _today(gw)
    started = time.perf_counter()
    status, error, data = await _call(gw, section, today)
    cost, reported, searches = _cost(data.get("usage"))
    usage = extract_chat_usage(data.get("usage"))
    # Logged whatever the content: the call happened.
    await gw.bank.record_system(NEWS_USER, "news", gw.settings.news_model, {
        "status": status, "cost_usd": float(cost),
        "upstream_cost_usd": float(reported) if reported is not None else None,
        "cost_inr": float(usd_to_inr(cost, gw.settings)),
        "duration_ms": int((time.perf_counter() - started) * 1000),
        "prompt_tokens": usage.prompt_tokens if usage else 0,
        "cached_tokens": usage.cached_tokens if usage else 0,
        "completion_tokens": usage.completion_tokens if usage else 0,
        "reasoning_tokens": usage.reasoning_tokens if usage else 0,
        "generation_id": str(data.get("id"))[:128] if data.get("id") else None,
    })
    items: list[dict[str, Any]] = []
    if status == "ok":
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            message = None
        raw = parse_items(message.get("content")) if isinstance(message, dict) else None
        if raw is None:
            status, error = "unreadable", "no items in the answer"
        else:
            items = clean_items(raw, section, today, citations(message), gw.settings.news_items_per_section)
            if len(items) < MIN_ITEMS:
                status, error = "too_few", f"{len(items)} usable of {len(raw)}"
    await _store(gw, section, items if status == "ok" else None, cost, error)
    report: dict[str, Any] = {
        "section": section.id, "status": status, "items": len(items) if status == "ok" else 0,
        "cost_usd": round(float(cost), 5), "searches": searches,
        "seconds": round(time.perf_counter() - started, 1),
    }
    if error:
        report["error"] = error
    log = logger.info if status == "ok" else logger.warning
    log("news %s: %s, %d items, $%.4f, %d searches, %.1fs%s", section.id, status, report["items"],
        cost, searches, report["seconds"], f" ({error})" if error else "")
    return report


async def refresh(gw: Gateway, section_ids: list[str] | None = None, *, reason: str) -> dict[str, Any]:
    """Refresh these sections (default: all active ones), a few at a time,
    stopping at the day's budget."""
    chosen = [s for s in active_sections(gw.settings) if section_ids is None or s.id in section_ids]
    if section_ids is not None:
        # An admin may refresh a section that isn't in the nightly list.
        chosen += [_BY_ID[s] for s in section_ids if s in _BY_ID and _BY_ID[s] not in chosen]
    budget = gw.settings.news_daily_budget_usd
    gate = asyncio.Semaphore(max(1, gw.settings.news_concurrency))
    reports: dict[str, dict[str, Any]] = {}

    async def one(section: Section) -> None:
        async with gate:
            # Checked as each section starts: running sections can overrun it
            # by at most NEWS_CONCURRENCY calls (~$0.03 each).
            spent = await gw.bank.system_spend_usd(NEWS_USER, gw.bank.day_start(gw.clock()))
            if budget > 0 and spent >= budget:
                reports[section.id] = {"section": section.id, "status": "budget", "items": 0,
                                       "cost_usd": 0.0, "searches": 0, "seconds": 0.0}
                return
            try:
                reports[section.id] = await refresh_section(gw, section)
            except Exception as exc:  # noqa: BLE001 - one section never stops the rest
                logger.exception("news %s: refresh crashed", section.id)
                reports[section.id] = {"section": section.id, "status": "crashed", "items": 0,
                                       "cost_usd": 0.0, "searches": 0, "seconds": 0.0,
                                       "error": type(exc).__name__}

    async with gw.news_lock:
        started = time.perf_counter()
        await asyncio.gather(*(one(section) for section in chosen))
    ordered = [reports[s.id] for s in chosen]
    total = round(sum(r["cost_usd"] for r in ordered), 5)
    ok = sum(1 for r in ordered if r["status"] == "ok")
    logger.info("news %s refresh: %d/%d sections ok, $%.4f, %.0fs", reason, ok, len(ordered), total,
                time.perf_counter() - started)
    return {"reason": reason, "ok": ok, "sections": ordered, "cost_usd": total}


async def _rows(gw: Gateway) -> dict[str, Any]:
    async with gw.db.read() as conn:
        rows = (await conn.execute(select(news_sections))).all()
    return {row.section: row for row in rows}


async def stale_sections(gw: Gateway) -> list[str]:
    """Active sections with nothing stored, or older than NEWS_STALE_HOURS."""
    rows = await _rows(gw)
    cutoff = gw.clock() - timedelta(hours=gw.settings.news_stale_hours)
    stale = []
    for section in active_sections(gw.settings):
        row = rows.get(section.id)
        refreshed = aware(row.refreshed_at) if row is not None else None
        if refreshed is None or refreshed < cutoff:
            stale.append(section.id)
    return stale


async def nightly(gw: Gateway) -> None:
    """The refresh loop, started by the app's lifespan: catch up on anything
    stale, then refresh every night at NEWS_REFRESH_AT, retrying failed
    sections once."""
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    try:
        stale = await stale_sections(gw)
        if stale:
            await refresh(gw, stale, reason="catch-up")
    except Exception:  # noqa: BLE001 - the loop must survive a bad night
        logger.exception("news catch-up failed")
    while True:
        now = utcnow()
        await asyncio.sleep(max((next_run(now, gw.settings) - now).total_seconds(), 1.0))
        try:
            report = await refresh(gw, reason="nightly")
            failed = [r["section"] for r in report["sections"] if r["status"] not in ("ok", "budget")]
            if failed:
                await asyncio.sleep(RETRY_AFTER_SECONDS)
                await refresh(gw, failed, reason="retry")
        except Exception:  # noqa: BLE001
            logger.exception("nightly news refresh failed")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


@router.get("/v1/news")
async def get_news(request: Request, since: str | None = None, section: str | None = None) -> JSONResponse:
    """Everyone's news, from the stored copy. ``?since=<updated_at>`` answers
    ``{"unchanged": true}`` when nothing is newer; ``?section=`` gives one."""
    gw = gateway(request)
    wait = gw.limiter.hit(f"news:{_client_ip(request)}", READS_PER_MINUTE)
    if wait is not None:
        seconds = max(int(wait) + 1, 1)
        raise GatewayError(429, "rate_limited", f"Too many requests. Try again in {seconds} s.",
                           headers={"Retry-After": str(seconds)}, retry_after=seconds)
    if section is not None and section not in _BY_ID:
        raise GatewayError(404, "not_found", f"No news section {section!r}.")
    rows = await _rows(gw)
    sections: list[dict[str, Any]] = []
    newest: datetime | None = None
    for known in SECTIONS:
        row = rows.get(known.id)
        refreshed = aware(row.refreshed_at) if row is not None else None
        if refreshed is None or (section is not None and known.id != section):
            continue
        items = _loads(row.stories)
        if not items:
            continue
        newest = refreshed if newest is None or refreshed > newest else newest
        sections.append({"id": known.id, "title": known.title, "updated_at": _iso(refreshed), "items": items})
    headers = {"Cache-Control": "public, max-age=300"}
    if since and newest is not None:
        try:
            seen = aware(datetime.fromisoformat(since.replace("Z", "+00:00")))
        except ValueError:
            seen = None
        if seen is not None and newest <= seen:
            return JSONResponse({"unchanged": True, "updated_at": _iso(newest)}, headers=headers)
    return JSONResponse({
        "updated_at": _iso(newest),
        "next_refresh": _iso(next_run(gw.clock(), gw.settings)) if gw.settings.news_refresh_enabled else None,
        "sections": sections,
    }, headers=headers)


def _require_admin(gw: Gateway, request: Request) -> None:
    expected = gw.settings.admin_token
    if not expected:
        raise GatewayError(503, "admin_disabled", "Admin endpoints are not enabled.")
    given = request.headers.get("x-admin-token", "")
    if not hmac.compare_digest(given.encode(), expected.encode()):
        raise GatewayError(401, "unauthorized", "Bad or missing admin token.")


@router.post("/v1/admin/news/refresh")
async def admin_refresh(request: Request) -> JSONResponse:
    """Refresh now. Header ``X-Admin-Token``. Body (optional)::

        {"sections": ["cricket", "ai"],   # default: every active section
         "wait": true}                    # answer with the report (else 202)
    """
    gw = gateway(request)
    _require_admin(gw, request)
    if not gw.settings.openrouter_api_key:
        raise GatewayError(503, "gateway_not_configured", "The AI service is not configured yet.")
    body = await read_json(request, 64 * 1024) if request.headers.get("content-length", "0") != "0" else {}
    ids = body.get("sections")
    if ids is not None and (
        not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i in _BY_ID for i in ids)
    ):
        raise GatewayError(400, "invalid_request", f"sections must be a list of {sorted(_BY_ID)}.")
    if body.get("wait") is True:
        return JSONResponse(await refresh(gw, ids, reason="admin"))
    if gw.news_lock.locked():
        raise GatewayError(409, "refresh_running", "A news refresh is already running.")
    task = asyncio.create_task(refresh(gw, ids, reason="admin"))
    gw.news_tasks.add(task)
    task.add_done_callback(gw.news_tasks.discard)
    return JSONResponse(
        {"started": ids or [s.id for s in active_sections(gw.settings)]}, status_code=202,
    )


def _posted_story(entry: Any, today: date, now: datetime, section: Section, index: int) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise GatewayError(400, "invalid_request", "Each story must be an object.")
    title = _text(entry.get("title"), 120)
    if len(title) < 3:
        raise GatewayError(400, "invalid_request", "Each story needs a title.")
    given = entry.get("url")
    url = _http_url(given) if given not in (None, "") else None
    if given not in (None, "") and url is None:
        raise GatewayError(400, "invalid_request", "url must be an http(s) link.")
    keep, published = _published(entry.get("published"), today, 3650)
    return {
        "id": hashlib.sha1(f"manual:{section.id}:{now.isoformat()}:{index}:{title}".encode()).hexdigest()[:12],
        "title": title,
        "summary": _text(entry.get("summary"), 360),
        "source": _text(entry.get("source"), 60) or POSTED_SOURCE,
        "url": _clean_url(url) if url else None,
        "published": published if keep and published else today.isoformat(),
        "trending": entry.get("trending") is True,
        "manual": True,
        "posted_at": now.isoformat(),
    }


@router.post("/v1/admin/news/items")
async def admin_post_items(request: Request) -> dict[str, Any]:
    """Post stories by hand (works with the nightly refresh off). Header
    ``X-Admin-Token``. Body::

        {"section": "cricket",
         "items": [{"title": "...", "summary": "...", "source": "JARVIS",
                    "url": "https://...", "trending": true}],
         "replace": false}      # true: the section becomes exactly these

    Only ``title`` is required. New stories go on top; they stay there through
    later refreshes until they're older than the section's window. No model
    call, no cost.
    """
    gw = gateway(request)
    _require_admin(gw, request)
    body = await read_json(request, 256 * 1024)
    section = _BY_ID.get(body.get("section")) if isinstance(body.get("section"), str) else None
    if section is None:
        raise GatewayError(400, "invalid_request", f"section must be one of {sorted(_BY_ID)}.")
    raw = body.get("items")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_POSTED:
        raise GatewayError(400, "invalid_request", f"items must be a list of 1 to {MAX_POSTED} stories.")
    now = gw.clock()
    today = _today(gw)
    posted = [_posted_story(entry, today, now, section, i) for i, entry in enumerate(raw)]
    async with gw.db.tx() as conn:
        row = (await conn.execute(
            select(news_sections.c.stories).where(news_sections.c.section == section.id)
        )).first()
        current = [] if body.get("replace") is True or row is None else _loads(row.stories)
        merged = _merge(posted, current)
        values = dict(stories=json.dumps(merged, ensure_ascii=False), refreshed_at=now)
        if row is not None:
            await conn.execute(
                update(news_sections).where(news_sections.c.section == section.id).values(**values)
            )
        else:
            await conn.execute(insert(news_sections).values(
                section=section.id, model="manual", cost_usd=0.0, **values,
            ))
    logger.info("news %s: %d story(ies) posted by hand", section.id, len(posted))
    return {"section": section.id, "posted": [entry["id"] for entry in posted], "items": len(merged)}


async def _remove(gw: Gateway, section_id: str, item_id: str | None) -> dict[str, Any]:
    if section_id not in _BY_ID:
        raise GatewayError(404, "not_found", f"No news section {section_id!r}.")
    async with gw.db.tx() as conn:
        row = (await conn.execute(
            select(news_sections.c.stories).where(news_sections.c.section == section_id)
        )).first()
        items = _loads(row.stories) if row is not None else []
        kept = [] if item_id is None else [
            e for e in items if not (isinstance(e, dict) and e.get("id") == item_id)
        ]
        if item_id is not None and len(kept) == len(items):
            raise GatewayError(404, "not_found", f"No story {item_id!r} in {section_id}.")
        if row is not None:
            # A newer time, so the apps' ?since= check picks the change up.
            await conn.execute(
                update(news_sections).where(news_sections.c.section == section_id)
                .values(stories=json.dumps(kept, ensure_ascii=False), refreshed_at=gw.clock())
            )
    return {"section": section_id, "removed": len(items) - len(kept), "items": len(kept)}


@router.delete("/v1/admin/news/items/{section_id}/{item_id}")
async def admin_remove_item(section_id: str, item_id: str, request: Request) -> dict[str, Any]:
    """Take one story down (``X-Admin-Token``)."""
    gw = gateway(request)
    _require_admin(gw, request)
    return await _remove(gw, section_id, item_id)


@router.delete("/v1/admin/news/items/{section_id}")
async def admin_clear_section(section_id: str, request: Request) -> dict[str, Any]:
    """Empty a section (``X-Admin-Token``); the app stops showing it."""
    gw = gateway(request)
    _require_admin(gw, request)
    return await _remove(gw, section_id, None)
