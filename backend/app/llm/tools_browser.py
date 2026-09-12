"""Browser control through the DOM/accessibility tree, via Playwright.

Same principle as `tools_ui_automation.py`, one layer up: a web page already
exposes a tree of named, typed, actionable elements (the accessibility tree
every screen reader already reads), so this drives that tree instead of
screen coordinates or hand-rolled HTML scraping.

    browser_open() / browser_navigate(url) / browser_new_tab() / ...
    browser_inspect()                        -- what's on the page, as [e1] [e2] ...
    browser_find(role=, text=, label=, ...)  -- narrow to specific elements
    browser_click / browser_type / ...        -- act on a [eN] reference

A fresh, isolated Chromium instance (Playwright's own bundled browser),
**not** the user's actual Chrome/Edge and not their existing tabs, cookies,
or logins. Attaching to a real running browser's profile is possible with
Playwright but requires that browser to already be running with remote
debugging enabled and closes off using it normally at the same time --
worse for this assistant's purpose than a clean, disposable browser it fully
owns. `tools_os_control.launch_app("chrome")` remains the way to open the
user's actual browser when the point is for *them* to look at it, not for
JARVIS to drive it.

One browser process for the life of the backend (`_Session`, a module-level
singleton opened lazily on first use) -- the whole point of DOM control
across several tool calls in one turn is that the same page stays open
between them. Elements are referenced by `[eN]` ids
(`tools_automation_common.ElementRegistry`) built from **role + accessible
name**, not raw element handles: a handle can go stale the instant the page
re-renders, while "the button named Login" is meaningful for as long as a
button named Login exists, and re-resolving through `page.get_by_role` on
every action is what makes Playwright locators durable across minor DOM
changes in the first place.

Dependency-light at module scope, same as every file in this group:
`playwright.async_api` is imported inside the functions that need it.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

from pydantic import BaseModel, Field

from app.llm.tools_automation_common import (
    MAX_ELEMENTS_SHOWN,
    ElementRegistry,
    Ref,
    ReferenceNotFoundError,
    StaleReferenceError,
    format_listing,
)

logger = logging.getLogger("jarvis.tools.browser")
audit = logging.getLogger("jarvis.audit")

#: How long a navigation or an action's own auto-wait may take before this
#: tool gives up and reports rather than stalling the turn. Generous for a
#: cold navigation (DNS, TLS, a slow site); Playwright's own action timeout
#: for click/fill is left at its default (30s) since those are almost always
#: fast once the element exists.
NAVIGATION_TIMEOUT_MS = 20_000

#: Roles worth surfacing in a page inspection. The accessibility tree of a
#: real page includes a great deal of pure-structure nodes (generic, none)
#: that add tokens and no information.
_INTERESTING_ROLES = {
    "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox",
    "option", "menuitem", "menu", "tab", "tabpanel", "searchbox", "switch",
    "slider", "spinbutton", "heading", "img", "dialog", "alert", "list",
    "listitem", "table", "row", "cell", "columnheader",
}


@dataclass(slots=True)
class _TabHandle:
    tab_id: str
    page: object  # playwright.async_api.Page, kept untyped to avoid a module-level import


class _Session:
    """The one Playwright browser this process owns, opened on first use."""

    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self._tabs: dict[str, _TabHandle] = {}
        self._active_tab: str | None = None
        self._next_tab_id = 1
        self._lock = asyncio.Lock()

    async def ensure_open(self) -> _TabHandle:
        async with self._lock:
            if self._browser is None:
                from playwright.async_api import async_playwright

                self._playwright = await async_playwright().start()
                self._browser = await self._playwright.chromium.launch(headless=False)
            if self._active_tab is None:
                await self._new_tab_locked()
            return self._tabs[self._active_tab]  # type: ignore[index]

    async def _new_tab_locked(self) -> str:
        page = await self._browser.new_page()  # type: ignore[union-attr]
        page.set_default_navigation_timeout(NAVIGATION_TIMEOUT_MS)
        tab_id = f"t{self._next_tab_id}"
        self._next_tab_id += 1
        self._tabs[tab_id] = _TabHandle(tab_id=tab_id, page=page)
        self._active_tab = tab_id
        return tab_id

    async def new_tab(self) -> str:
        await self.ensure_open()
        async with self._lock:
            return await self._new_tab_locked()

    async def close_tab(self, tab_id: str) -> None:
        async with self._lock:
            handle = self._tabs.pop(tab_id, None)
            if handle is None:
                raise LookupError(f"No open tab '{tab_id}'.")
            await handle.page.close()  # type: ignore[attr-defined]
            if self._active_tab == tab_id:
                self._active_tab = next(iter(self._tabs), None)

    def switch_tab(self, tab_id: str) -> _TabHandle:
        handle = self._tabs.get(tab_id)
        if handle is None:
            raise LookupError(f"No open tab '{tab_id}'. Open tabs: {', '.join(self._tabs) or '(none)'}.")
        self._active_tab = tab_id
        return handle

    def get_tab(self, tab_id: str | None) -> _TabHandle:
        if tab_id is not None:
            handle = self._tabs.get(tab_id)
            if handle is None:
                raise LookupError(f"No open tab '{tab_id}'. Open tabs: {', '.join(self._tabs) or '(none)'}.")
            return handle
        if self._active_tab is None:
            raise LookupError("No browser tab is open yet. Call browser_open first.")
        return self._tabs[self._active_tab]

    def list_tabs(self) -> list[str]:
        return list(self._tabs.keys())

    async def close_all(self) -> None:
        async with self._lock:
            for handle in self._tabs.values():
                try:
                    await handle.page.close()  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    pass
            self._tabs.clear()
            self._active_tab = None
            if self._browser is not None:
                await self._browser.close()
                self._browser = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None


_session = _Session()
#: One registry per open tab, so an [eN] issued for tab A can never resolve
#: against tab B's tree even by coincidence of numbering.
_registries: dict[str, ElementRegistry] = {}


def _registry_for(tab_id: str) -> ElementRegistry:
    reg = _registries.get(tab_id)
    if reg is None:
        reg = ElementRegistry()
        _registries[tab_id] = reg
    return reg


async def close_session() -> None:
    """For test teardown and process shutdown -- not exposed as a tool."""
    await _session.close_all()
    _registries.clear()


# ---------------------------------------------------------------------------
# Accessibility snapshot -> compact listing
#
# `page.accessibility.snapshot()` (a nested dict) was removed in this
# Playwright version -- verified directly (`AttributeError` on a real Page,
# not assumed from changelog reading) -- in favour of
# `locator.aria_snapshot()`, a YAML-like *text* tree:
#
#     - heading "Example Domain" [level=1]
#     - paragraph: This domain is for use in documentation examples...
#     - paragraph:
#       - link "Learn more":
#         - /url: https://iana.org/domains/example
#
# One bullet per node: `role "name" [attr=val, ...]`, or `role: plain text`
# for a leaf with no accessible name, or `role "name":` when children
# follow indented beneath it. `/url` lines are a link's href shown as a
# pseudo-child, not a role, and are skipped. This is parsed flat -- nesting
# depth is dropped -- because every downstream action re-resolves an element
# by role + name via `page.get_by_role`, which does not care where in the
# tree that name lived.
# ---------------------------------------------------------------------------

_ARIA_LINE = re.compile(
    r'^-\s+(?P<role>[a-zA-Z][\w-]*)'
    r'(?:\s+"(?P<name>[^"]*)")?'
    r'(?:\s*\[(?P<attrs>[^\]]*)\])?'
    r'\s*(?::\s*(?P<text>.*))?$'
)


def _parse_aria_snapshot(snapshot: str) -> list[dict]:
    nodes: list[dict] = []
    for raw_line in snapshot.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("- /"):  # a /url (or similar) pseudo-property, not a role
            continue
        match = _ARIA_LINE.match(line)
        if not match:
            continue
        role = match.group("role")
        name = match.group("name") or match.group("text") or ""
        attrs = match.group("attrs") or ""
        nodes.append({"role": role.lower(), "name": name.strip(), "attrs": attrs})
    return nodes


def _flatten(nodes: list[dict], out: list[dict]) -> None:
    for node in nodes:
        role = node.get("role") or ""
        name = node.get("name") or ""
        if role in _INTERESTING_ROLES and (name or role in {"textbox", "searchbox", "combobox"}):
            out.append(node)


def _describe(node: dict) -> str:
    role = node.get("role") or "generic"
    name = node.get("name") or ""
    label = f'{role} "{name}"' if name else role
    attrs = node.get("attrs") or ""
    facts = [a.strip() for a in attrs.split(",") if a.strip() in ("disabled", "checked", "expanded")]
    if facts:
        label += " (" + ", ".join(facts) + ")"
    return label


# ---------------------------------------------------------------------------
# Tool input models
# ---------------------------------------------------------------------------

class TabIdInput(BaseModel):
    tab_id: str | None = Field(default=None, description="Omit to use the active tab.")


class BrowserNavigateInput(TabIdInput):
    url: str = Field(min_length=1)


class BrowserSwitchTabInput(BaseModel):
    tab_id: str = Field(min_length=1)


class BrowserCloseTabInput(BaseModel):
    tab_id: str = Field(min_length=1)


class BrowserInspectInput(TabIdInput):
    pass


class BrowserFindInput(TabIdInput):
    role: str | None = Field(default=None, description='ARIA role, e.g. "button", "textbox", "link".')
    text: str | None = Field(default=None, description="Substring of the element's visible text or accessible name.")
    label: str | None = Field(default=None, description="Substring of an associated <label>.")
    placeholder: str | None = None
    test_id: str | None = Field(default=None, description="data-testid attribute value.")
    selector: str | None = Field(default=None, description="Raw CSS selector, last resort if nothing else matches.")


class ElementRefInput(BaseModel):
    element_id: str = Field(min_length=1, description='An "[eN]" id from browser_inspect or browser_find.')


class BrowserTypeInput(ElementRefInput):
    text: str
    clear_first: bool = True


class BrowserSelectInput(ElementRefInput):
    value: str = Field(min_length=1, description="The <option>'s value or visible label.")


class BrowserCheckInput(ElementRefInput):
    checked: bool = True


class BrowserScrollInput(TabIdInput):
    direction: str = Field(default="down", description='"up" or "down".')
    amount_px: int = Field(default=600, ge=1, le=10_000)


class BrowserUploadInput(ElementRefInput):
    path: str = Field(min_length=1, description="Absolute path to the file to upload.")


class BrowserGetAttributeInput(ElementRefInput):
    attribute: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# Handlers -- return (ok, message) or str; tools.py wraps these in ToolOutcome
# ---------------------------------------------------------------------------

async def browser_open() -> str:
    handle = await _session.ensure_open()
    return f"Browser open. Active tab: {handle.tab_id} (about:blank)."


async def browser_new_tab() -> str:
    tab_id = await _session.new_tab()
    return f"Opened tab {tab_id}."


async def browser_close_tab(payload: BrowserCloseTabInput) -> tuple[bool, str]:
    try:
        await _session.close_tab(payload.tab_id)
    except LookupError as exc:
        return False, str(exc)
    _registries.pop(payload.tab_id, None)
    return True, f"Closed tab {payload.tab_id}."


async def browser_switch_tab(payload: BrowserSwitchTabInput) -> tuple[bool, str]:
    try:
        handle = _session.switch_tab(payload.tab_id)
    except LookupError as exc:
        return False, str(exc)
    return True, f"Switched to tab {handle.tab_id} ({handle.page.url})."  # type: ignore[attr-defined]


async def browser_list_tabs() -> str:
    tabs = _session.list_tabs()
    if not tabs:
        return "No tabs open. Call browser_open first."
    rows = []
    for tab_id in tabs:
        handle = _session.get_tab(tab_id)
        try:
            rows.append(f"  {tab_id}: {handle.page.url} — {await handle.page.title()}")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            rows.append(f"  {tab_id}: (unavailable)")
    return format_listing(f"{len(tabs)} open tab(s)", rows)


async def browser_navigate(payload: BrowserNavigateInput) -> tuple[bool, str]:
    await _session.ensure_open()
    try:
        handle = _session.get_tab(payload.tab_id)
    except LookupError as exc:
        return False, str(exc)
    url = payload.url if "://" in payload.url else f"https://{payload.url}"
    try:
        await handle.page.goto(url, wait_until="domcontentloaded")  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001 - Playwright's TimeoutError etc.
        return False, f"Could not navigate to {url}: {exc}"
    _registry_for(handle.tab_id).clear()
    return True, f"Navigated to {handle.page.url}."  # type: ignore[attr-defined]


async def browser_back(payload: TabIdInput) -> tuple[bool, str]:
    handle = _session.get_tab(payload.tab_id)
    await handle.page.go_back(wait_until="domcontentloaded")  # type: ignore[attr-defined]
    _registry_for(handle.tab_id).clear()
    return True, f"Back to {handle.page.url}."  # type: ignore[attr-defined]


async def browser_forward(payload: TabIdInput) -> tuple[bool, str]:
    handle = _session.get_tab(payload.tab_id)
    await handle.page.go_forward(wait_until="domcontentloaded")  # type: ignore[attr-defined]
    _registry_for(handle.tab_id).clear()
    return True, f"Forward to {handle.page.url}."  # type: ignore[attr-defined]


async def browser_refresh(payload: TabIdInput) -> tuple[bool, str]:
    handle = _session.get_tab(payload.tab_id)
    await handle.page.reload(wait_until="domcontentloaded")  # type: ignore[attr-defined]
    _registry_for(handle.tab_id).clear()
    return True, f"Refreshed {handle.page.url}."  # type: ignore[attr-defined]


async def browser_current_url(payload: TabIdInput) -> tuple[bool, str]:
    try:
        handle = _session.get_tab(payload.tab_id)
    except LookupError as exc:
        return False, str(exc)
    return True, handle.page.url  # type: ignore[attr-defined]


async def browser_title(payload: TabIdInput) -> tuple[bool, str]:
    try:
        handle = _session.get_tab(payload.tab_id)
    except LookupError as exc:
        return False, str(exc)
    return True, await handle.page.title()  # type: ignore[attr-defined]


async def browser_inspect(payload: BrowserInspectInput) -> str:
    try:
        handle = _session.get_tab(payload.tab_id)
    except LookupError as exc:
        return str(exc)

    raw = await handle.page.locator("body").aria_snapshot()  # type: ignore[attr-defined]
    if not raw or not raw.strip():
        return "The page has no accessible content (it may still be loading)."

    parsed = _parse_aria_snapshot(raw)
    found: list[dict] = []
    _flatten(parsed, found)
    limited = found[:MAX_ELEMENTS_SHOWN]

    registry = _registry_for(handle.tab_id)
    refs = registry.reset([Ref(node, _describe(node)) for node in limited])
    rows = [f"  [{ref}] {_describe(node)}" for ref, node in zip(refs, limited)]

    header = f"Page: {await handle.page.title()} ({handle.page.url})\n{len(found)} interactive element(s)"  # type: ignore[attr-defined]
    return format_listing(header, rows, truncated_count=max(0, len(found) - len(limited)))


async def browser_find(payload: BrowserFindInput) -> str:
    try:
        handle = _session.get_tab(payload.tab_id)
    except LookupError as exc:
        return str(exc)
    page = handle.page

    locator = None
    strategy = None
    if payload.role:
        kwargs = {"name": payload.text, "exact": False} if payload.text else {}
        locator, strategy = page.get_by_role(payload.role, **kwargs), f'role="{payload.role}"'
    elif payload.label:
        locator, strategy = page.get_by_label(payload.label, exact=False), f'label~"{payload.label}"'
    elif payload.placeholder:
        locator, strategy = page.get_by_placeholder(payload.placeholder, exact=False), f'placeholder~"{payload.placeholder}"'
    elif payload.test_id:
        locator, strategy = page.get_by_test_id(payload.test_id), f'test_id="{payload.test_id}"'
    elif payload.text:
        locator, strategy = page.get_by_text(payload.text, exact=False), f'text~"{payload.text}"'
    elif payload.selector:
        locator, strategy = page.locator(payload.selector), f"selector={payload.selector}"
    else:
        return "Give at least one of: role, text, label, placeholder, test_id, selector."

    try:
        count = await locator.count()
    except Exception as exc:  # noqa: BLE001 - a malformed selector, most likely
        return f"Search failed ({strategy}): {exc}"

    if count == 0:
        return f"No element matched {strategy}."

    registry = _registry_for(handle.tab_id)
    items: list[Ref] = []
    rows: list[str] = []
    shown = min(count, MAX_ELEMENTS_SHOWN)
    for i in range(shown):
        one = locator.nth(i)
        try:
            role = await one.get_attribute("role") or (await one.evaluate("el => el.tagName.toLowerCase()"))
            text = (await one.inner_text())[:80] if await one.count() else ""
        except Exception:  # noqa: BLE001
            role, text = "element", ""
        node = {"role": role, "name": text}
        items.append(Ref(one, _describe(node)))
    refs = registry.reset(items)
    for ref, item in zip(refs, items):
        rows.append(f"  [{ref}] {item.summary}")

    return format_listing(f"{count} element(s) matched {strategy}", rows, truncated_count=max(0, count - shown))


def _resolve(tab_id_hint: str | None, element_id: str):
    """Every registry is per-tab, but a [eN] id alone doesn't say which tab
    issued it -- search whichever tab was hinted, else all open registries."""
    if tab_id_hint is not None:
        registry = _registries.get(tab_id_hint)
        if registry is None:
            raise ReferenceNotFoundError(f"No elements have been inspected on tab '{tab_id_hint}' yet.")
        return registry.get(element_id), registry.describe(element_id)
    last_error: Exception | None = None
    for registry in _registries.values():
        try:
            return registry.get(element_id), registry.describe(element_id)
        except (ReferenceNotFoundError, StaleReferenceError) as exc:
            last_error = exc
    raise last_error or ReferenceNotFoundError(f"'{element_id}' does not exist.")


async def browser_click(payload: ElementRefInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        await locator.click(timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not click {label}: {exc}"
    return True, f"Clicked {label}."


async def browser_type(payload: BrowserTypeInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        if payload.clear_first:
            await locator.fill(payload.text, timeout=10_000)
        else:
            await locator.press_sequentially(payload.text, timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not type into {label}: {exc}"
    return True, f"Typed into {label}."


async def browser_clear(payload: ElementRefInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        await locator.fill("", timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not clear {label}: {exc}"
    return True, f"Cleared {label}."


async def browser_submit(payload: ElementRefInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        await locator.press("Enter", timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not submit from {label}: {exc}"
    return True, f"Submitted from {label}."


async def browser_select(payload: BrowserSelectInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        try:
            await locator.select_option(value=payload.value, timeout=10_000)
        except Exception:  # noqa: BLE001 - value didn't match; try visible label
            await locator.select_option(label=payload.value, timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not select '{payload.value}' in {label}: {exc}"
    return True, f"Selected '{payload.value}' in {label}."


async def browser_check(payload: BrowserCheckInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        if payload.checked:
            await locator.check(timeout=10_000)
        else:
            await locator.uncheck(timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not {'check' if payload.checked else 'uncheck'} {label}: {exc}"
    return True, f"{'Checked' if payload.checked else 'Unchecked'} {label}."


async def browser_get_text(payload: ElementRefInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        text = await locator.inner_text(timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not read text from {label}: {exc}"
    return True, text or "(empty)"


async def browser_get_attribute(payload: BrowserGetAttributeInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    try:
        value = await locator.get_attribute(payload.attribute, timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not read '{payload.attribute}' from {label}: {exc}"
    return True, value if value is not None else f"{label} has no '{payload.attribute}' attribute."


async def browser_scroll(payload: BrowserScrollInput) -> tuple[bool, str]:
    handle = _session.get_tab(payload.tab_id)
    delta = payload.amount_px if payload.direction == "down" else -payload.amount_px
    try:
        await handle.page.mouse.wheel(0, delta)  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not scroll: {exc}"
    return True, f"Scrolled {payload.direction} {payload.amount_px}px."


async def browser_upload_file(payload: BrowserUploadInput) -> tuple[bool, str]:
    locator, label = _resolve(None, payload.element_id)
    from pathlib import Path

    if not Path(payload.path).exists():
        return False, f"'{payload.path}' does not exist."
    try:
        await locator.set_input_files(payload.path, timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not upload to {label}: {exc}"
    return True, f"Uploaded '{payload.path}' to {label}."


__all__ = [
    "close_session",
    "TabIdInput", "BrowserNavigateInput", "BrowserSwitchTabInput", "BrowserCloseTabInput",
    "BrowserInspectInput", "BrowserFindInput", "ElementRefInput", "BrowserTypeInput",
    "BrowserSelectInput", "BrowserCheckInput", "BrowserScrollInput", "BrowserUploadInput",
    "BrowserGetAttributeInput",
    "browser_open", "browser_new_tab", "browser_close_tab", "browser_switch_tab",
    "browser_list_tabs", "browser_navigate", "browser_back", "browser_forward",
    "browser_refresh", "browser_current_url", "browser_title", "browser_inspect",
    "browser_find", "browser_click", "browser_type", "browser_clear", "browser_submit",
    "browser_select", "browser_check", "browser_get_text", "browser_get_attribute",
    "browser_scroll", "browser_upload_file",
]
