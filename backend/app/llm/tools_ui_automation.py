"""Structured control of Windows application UIs via the Accessibility tree.

The model should never have to guess pixel coordinates when the operating
system can already tell it exactly what is on screen: every window exposes a
tree of named, typed, actionable elements through Windows' own UI Automation
API, and this module reads and drives that tree instead of a screenshot.

    ui_list_windows()                          -- what's open
    ui_inspect(window)                         -- what's in it, as [e1] [e2] ...
    ui_find_element(window, role=, name=)      -- narrow to specific elements
    ui_click / ui_set_text / ui_get_text / ...  -- act on a [eN] reference

Backed by `pywinauto`'s ``uia`` backend, which wraps the same COM
UI Automation interfaces a screen reader uses -- role, name, automation id,
enabled/focused state, and the control-pattern methods (`invoke`, `toggle`,
`expand`, `select`, ...) that make an element's *supported actions* a fact
the code can read rather than something the model has to infer from a
screenshot.

Windows-only. There is no cross-platform equivalent of UI Automation worth
having half of -- macOS's Accessibility API and Linux's AT-SPI are different
enough in shape that a shared interface today would mean the lowest common
denominator of all three, for zero current benefit (this project's desktop
build only ships Windows). The public functions below are the extension
point: a future ``tools_ui_automation_macos.py`` implementing the same
handler signatures would need no changes to the tool registry in
``tools.py``, only a platform check at registration.

Elements are referenced by short-lived `[eN]` ids from
`tools_automation_common.ElementRegistry` -- see that module for why. A
pywinauto ``UIAWrapper`` is not safe to hold across calls once the element it
points to has actually been removed from the tree (clicking a "Close"
button, for instance), so every action re-validates with `.exists()` before
touching the control and reports a clean, specific failure rather than
pywinauto's own raw COM exception when it has gone stale.
"""

from __future__ import annotations

import logging
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

logger = logging.getLogger("jarvis.tools.ui")
audit = logging.getLogger("jarvis.audit")

#: How deep `ui_inspect` walks the control tree by default. Most dialogs and
#: toolbars are 2-3 levels deep; deeper trees exist (a browser chrome, a
#: complex ribbon) but walking them fully by default would dump hundreds of
#: elements for one inspect call. `ui_find_element` searches the whole tree
#: regardless of this cap, for exactly the cases where the default depth
#: misses the target.
DEFAULT_MAX_DEPTH = 3

#: Roles worth surfacing. UI Automation trees include a great deal of pure
#: layout scaffolding (panes, groups with no name) that add tokens and no
#: information -- filtered out of `ui_inspect`'s default listing.
_INTERESTING_CONTROL_TYPES = {
    "Button", "Edit", "Text", "CheckBox", "RadioButton", "ComboBox", "List",
    "ListItem", "Menu", "MenuItem", "Tab", "TabItem", "Tree", "TreeItem",
    "Hyperlink", "Document", "Pane", "Dialog", "Window", "ScrollBar", "Slider",
    "Group", "ToolBar", "StatusBar", "Header", "HeaderItem", "DataGrid", "DataItem",
}

_registry: ElementRegistry = ElementRegistry()


@dataclass(frozen=True, slots=True)
class WindowMatch:
    title: str
    process_name: str
    pid: int


def _desktop():
    from pywinauto import Desktop

    return Desktop(backend="uia")


def _list_windows() -> list[WindowMatch]:
    import psutil

    windows: list[WindowMatch] = []
    for w in _desktop().windows():
        try:
            title = w.window_text()
            if not title:
                continue
            pid = w.process_id()
            try:
                process_name = psutil.Process(pid).name()
            except Exception:  # noqa: BLE001
                process_name = "?"
            windows.append(WindowMatch(title=title, process_name=process_name, pid=pid))
        except Exception:  # noqa: BLE001 - one uninspectable window must not kill the listing
            continue
    return windows


def _find_window(title_contains: str):
    """The first top-level window whose title contains the query, or raise."""
    query = title_contains.strip().lower()
    for w in _desktop().windows():
        try:
            if query in w.window_text().lower():
                return w
        except Exception:  # noqa: BLE001
            continue
    available = ", ".join(f'"{m.title}"' for m in _list_windows()[:10])
    raise LookupError(
        f"No open window with a title containing '{title_contains}'. "
        f"Open windows include: {available or '(none)'}."
    )


def _element_summary(el) -> tuple[str, str, dict[str, str]]:
    """(role, name, extra facts) for one element, defensively -- any property
    read can throw on a control mid-teardown, and one bad element must not
    abort the whole listing."""
    def safe(fn, default=""):
        try:
            return fn()
        except Exception:  # noqa: BLE001
            return default

    role = safe(lambda: el.element_info.control_type) or "Unknown"
    name = safe(lambda: el.element_info.name) or safe(lambda: el.window_text())
    facts: dict[str, str] = {}
    if not safe(lambda: el.is_enabled(), True):
        facts["disabled"] = "true"
    try:
        if el.has_keyboard_focus():
            facts["focused"] = "true"
    except Exception:  # noqa: BLE001
        pass
    auto_id = safe(lambda: el.element_info.automation_id)
    if auto_id:
        facts["id"] = auto_id
    return role, name, facts


def _format_element(role: str, name: str, facts: dict[str, str]) -> str:
    label = f'{role} "{name}"' if name else role
    if facts:
        label += " (" + ", ".join(f"{k}={v}" for k, v in facts.items()) + ")"
    return label


def _walk(el, depth: int, max_depth: int, out: list) -> None:
    if depth > max_depth:
        return
    try:
        children = el.children()
    except Exception:  # noqa: BLE001
        return
    for child in children:
        role, name, facts = _element_summary(child)
        if role in _INTERESTING_CONTROL_TYPES and (name or role in {"Edit", "Button", "CheckBox"}):
            out.append((child, role, name, facts))
        _walk(child, depth + 1, max_depth, out)


# ---------------------------------------------------------------------------
# Tool input models
# ---------------------------------------------------------------------------

class UiFocusWindowInput(BaseModel):
    title: str = Field(min_length=1, description="Substring of the window title.")


class UiInspectInput(BaseModel):
    window: str = Field(min_length=1, description="Substring of the window title to inspect.")
    max_depth: int = Field(default=DEFAULT_MAX_DEPTH, ge=1, le=8)


class UiFindElementInput(BaseModel):
    window: str = Field(min_length=1)
    role: str | None = Field(default=None, description='e.g. "Button", "Edit", "CheckBox".')
    name: str | None = Field(default=None, description="Substring of the element's accessible name.")
    automation_id: str | None = None


class ElementRefInput(BaseModel):
    element_id: str = Field(min_length=1, description='An "[eN]"-style id from ui_inspect or ui_find_element.')


class UiSetTextInput(ElementRefInput):
    text: str
    clear_first: bool = True


class UiPressKeyInput(ElementRefInput):
    keys: str = Field(min_length=1, description='e.g. "enter", "ctrl+a", "tab".')


class UiSelectInput(ElementRefInput):
    item: str = Field(min_length=1)


class UiToggleInput(ElementRefInput):
    #: None = flip whatever it currently is; True/False = force a state.
    checked: bool | None = None


class UiScrollInput(ElementRefInput):
    direction: str = Field(description='"up", "down", "left", or "right".')
    amount: str = Field(default="line", description='"line" or "page".')


class UiExpandCollapseInput(ElementRefInput):
    expand: bool = True


class UiWindowActionInput(BaseModel):
    window: str = Field(min_length=1)
    action: str = Field(description='"minimize", "maximize", "restore", or "close".')


# ---------------------------------------------------------------------------
# Handlers -- return (ok, message); tools.py wraps these in ToolOutcome
# ---------------------------------------------------------------------------

async def ui_list_windows() -> str:
    windows = _list_windows()
    rows = [f"  {i + 1}. {w.title}  ({w.process_name}, pid {w.pid})" for i, w in enumerate(windows)]
    return format_listing(f"{len(windows)} open window(s)", rows)


async def ui_focus_window(payload: UiFocusWindowInput) -> tuple[bool, str]:
    try:
        w = _find_window(payload.title)
    except LookupError as exc:
        return False, str(exc)
    try:
        if w.is_minimized():
            w.restore()
        w.set_focus()
    except Exception as exc:  # noqa: BLE001
        return False, f"Found the window but could not focus it: {exc}"
    return True, f'Focused "{w.window_text()}".'


async def ui_inspect(payload: UiInspectInput) -> str:
    try:
        w = _find_window(payload.window)
    except LookupError as exc:
        return str(exc)

    found: list = []
    root_role, root_name, root_facts = _element_summary(w)
    _walk(w, 1, payload.max_depth, found)

    limited = found[:MAX_ELEMENTS_SHOWN]
    refs = _registry.reset([Ref(el, _format_element(role, name, facts)) for el, role, name, facts in limited])
    rows = [f"  [{ref}] {_format_element(role, name, facts)}" for ref, (_, role, name, facts) in zip(refs, limited)]

    header = f'Window: {w.window_text()} ({len(found)} interactive element(s) within depth {payload.max_depth})'
    return format_listing(header, rows, truncated_count=max(0, len(found) - len(limited)))


async def ui_find_element(payload: UiFindElementInput) -> str:
    try:
        w = _find_window(payload.window)
    except LookupError as exc:
        return str(exc)

    found: list = []
    # A generous depth for a targeted search -- unlike ui_inspect, this is
    # meant to actually locate the thing regardless of nesting.
    _walk(w, 1, 10, found)

    role_query = (payload.role or "").strip().lower()
    name_query = (payload.name or "").strip().lower()
    id_query = (payload.automation_id or "").strip().lower()

    def matches(role: str, name: str, facts: dict[str, str]) -> bool:
        if role_query and role_query != role.lower():
            return False
        if name_query and name_query not in name.lower():
            return False
        if id_query and id_query != facts.get("id", "").lower():
            return False
        return True

    matched = [(el, role, name, facts) for el, role, name, facts in found if matches(role, name, facts)]
    limited = matched[:MAX_ELEMENTS_SHOWN]
    refs = _registry.reset([Ref(el, _format_element(role, name, facts)) for el, role, name, facts in limited])
    rows = [f"  [{ref}] {_format_element(role, name, facts)}" for ref, (_, role, name, facts) in zip(refs, limited)]

    header = f"{len(matched)} matching element(s) in \"{w.window_text()}\""
    return format_listing(header, rows, truncated_count=max(0, len(matched) - len(limited)))


def _resolve(element_id: str):
    """Look up a [eN] ref and confirm the underlying control is still real.

    A concrete `UIAWrapper` (what `.children()` returns, and what every
    reference in the registry holds) has no `.exists()` method at all --
    that is a `WindowSpecification` method, a different pywinauto type for
    lazy, re-searched lookups. Verified directly against a real closed
    window: `is_visible()` on a wrapper whose element has been torn down
    returns `False` rather than raising or returning a stale `True`, which
    is exactly the liveness signal needed here.
    """
    el = _registry.get(element_id)  # raises ReferenceNotFoundError / StaleReferenceError
    try:
        alive = el.is_visible()
    except Exception:  # noqa: BLE001
        alive = False
    if not alive:
        raise StaleReferenceError(
            f"'{element_id}' ({_registry.describe(element_id)}) no longer exists in the UI "
            "-- the window or control it pointed to was closed or replaced. Inspect again."
        )
    return el


async def ui_click(payload: ElementRefInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        el.click_input()
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not click {label}: {exc}"
    return True, f"Clicked {label}."


#: Delay between simulated keystrokes for the `type_keys` fallback below.
#:
#: `set_edit_text` (a direct UIA ValuePattern write) is instant and exact
#: when a control supports it, but plenty of real controls do not --
#: verified directly against modern Notepad's "Document"-type editor, which
#: has no `set_edit_text` at all (`AttributeError`, not a slow path
#: silently chosen). The `type_keys` fallback simulates real keystrokes, and
#: at pywinauto's faster defaults (~0.01s) that measured as dropped and
#: transposed characters against this exact control -- "computer" arrived
#: as "pputer", "test" as "ssst". 0.03s reliably reproduced the input
#: byte-for-byte in the same test; kept with a little headroom rather than
#: the bare minimum that happened to pass once.
_TYPE_KEYS_PAUSE = 0.03


async def ui_set_text(payload: UiSetTextInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        if payload.clear_first:
            try:
                el.set_edit_text(payload.text)
            except Exception:  # noqa: BLE001 - not every control supports set_edit_text
                el.click_input()
                el.type_keys("^a{DELETE}", pause=_TYPE_KEYS_PAUSE)
                el.type_keys(payload.text, with_spaces=True, pause=_TYPE_KEYS_PAUSE)
        else:
            el.click_input()
            el.type_keys(payload.text, with_spaces=True, pause=_TYPE_KEYS_PAUSE)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not set text on {label}: {exc}"

    # `type_keys` simulating real input means the control's own rendering
    # decides when the text actually lands -- verify rather than trust the
    # call returning without an exception, and say plainly if it did not
    # take, instead of reporting success on a guess.
    try:
        actual = el.window_text()
    except Exception:  # noqa: BLE001
        return True, f"Set text on {label} (could not verify the result)."
    if payload.text not in actual:
        return False, (
            f"Sent text to {label}, but it does not match what was typed -- "
            f"got {actual!r}. The control may not support reliable text input, "
            "or something intercepted the keystrokes."
        )
    return True, f"Set text on {label}."


async def ui_get_text(payload: ElementRefInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        text = el.window_text()
        if not text:
            try:
                text = el.get_value()
            except Exception:  # noqa: BLE001
                text = ""
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not read text from {label}: {exc}"
    return True, text if text else "(empty)"


async def ui_focus_element(payload: ElementRefInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        el.set_focus()
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not focus {label}: {exc}"
    return True, f"Focused {label}."


async def ui_press_key(payload: UiPressKeyInput) -> tuple[bool, str]:
    from app.llm.tools_os_control import translate_hotkey

    try:
        chord = translate_hotkey(payload.keys)
    except ValueError as exc:
        return False, str(exc)
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        el.set_focus()
        el.type_keys(chord, pause=0.01)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not send '{payload.keys}' to {label}: {exc}"
    return True, f"Sent {payload.keys} to {label}."


async def ui_toggle(payload: UiToggleInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        current = None
        try:
            current = el.get_toggle_state()  # 0 unchecked, 1 checked, 2 indeterminate
        except Exception:  # noqa: BLE001
            pass
        if payload.checked is None or (current is not None and bool(current) != payload.checked):
            el.toggle()
        return True, f"Toggled {label}."
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not toggle {label}: {exc}"


async def ui_select(payload: UiSelectInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        el.select(payload.item)
    except Exception as exc:  # noqa: BLE001
        return False, (
            f"Could not select '{payload.item}' in {label}: {exc}. "
            "The item text must match an actual entry exactly -- inspect the "
            "control's children to see the real option text."
        )
    return True, f"Selected '{payload.item}' in {label}."


async def ui_scroll(payload: UiScrollInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    direction = payload.direction.strip().lower()
    if direction not in {"up", "down", "left", "right"}:
        return False, "direction must be up, down, left, or right."
    try:
        el.scroll(direction, payload.amount)
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not scroll {label}: {exc}"
    return True, f"Scrolled {label} {direction}."


async def ui_expand_collapse(payload: UiExpandCollapseInput) -> tuple[bool, str]:
    el = _resolve(payload.element_id)
    label = _registry.describe(payload.element_id)
    try:
        if payload.expand:
            el.expand()
        else:
            el.collapse()
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not {'expand' if payload.expand else 'collapse'} {label}: {exc}"
    return True, f"{'Expanded' if payload.expand else 'Collapsed'} {label}."


async def ui_window_action(payload: UiWindowActionInput) -> tuple[bool, str]:
    try:
        w = _find_window(payload.window)
    except LookupError as exc:
        return False, str(exc)
    action = payload.action.strip().lower()
    try:
        if action == "minimize":
            w.minimize()
        elif action == "maximize":
            w.maximize()
        elif action == "restore":
            w.restore()
        elif action == "close":
            w.close()
        else:
            return False, "action must be minimize, maximize, restore, or close."
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not {action} '{w.window_text()}': {exc}"
    return True, f"{action.capitalize()}d \"{payload.window}\"."


__all__ = [
    "ReferenceNotFoundError", "StaleReferenceError",
    "UiFocusWindowInput", "UiInspectInput", "UiFindElementInput", "ElementRefInput",
    "UiSetTextInput", "UiPressKeyInput", "UiSelectInput", "UiToggleInput",
    "UiScrollInput", "UiExpandCollapseInput", "UiWindowActionInput",
    "ui_list_windows", "ui_focus_window", "ui_inspect", "ui_find_element",
    "ui_click", "ui_set_text", "ui_get_text", "ui_focus_element", "ui_press_key",
    "ui_toggle", "ui_select", "ui_scroll", "ui_expand_collapse", "ui_window_action",
]
