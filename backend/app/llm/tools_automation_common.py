"""Shared machinery for the computer-control tool modules.

`tools_ui_automation.py` (Windows Accessibility/UI Automation),
`tools_browser.py` (Playwright/DOM), and `tools_os_control.py` (processes,
windows, clipboard) each let the model act on *structured* elements instead
of screen coordinates. The two that inspect a live element tree --
UI Automation and the browser -- share one problem: the model should never
have to repeat a long selector to click the thing it just saw in a list, but
the live objects a lookup returns are exactly the kind of handle that goes
stale the moment the real UI changes underneath them.

This module is that solution, factored out once rather than written twice:
a short-lived table of `[e1]`, `[e2]`, ... references, each holding whatever
the owning module needs to act on it again (a pywinauto control, a Playwright
locator + description), and cleared in full on every fresh inspection --
never partially invalidated, because partial invalidation requires knowing
exactly which elements changed, which is precisely what neither backend can
promise across an arbitrary UI mutation. Same shape as `run_command`'s
confirm-then-act gate in `tools_system.py`: the conservative rule survives
being ignored under pressure, a clever one does not.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class Ref(Generic[T]):
    """One live reference: what it is, and enough to describe it in an error."""

    value: T
    summary: str  # e.g. 'Button "Send"' -- echoed back in "not found" errors


class ElementRegistry(Generic[T]):
    """A generation-stamped table of `[eN]` references.

    Every fresh listing bumps the generation and replaces the table wholesale
    -- there is no partial update. A reference from an old generation is
    reported as stale rather than silently resolved against a table that has
    moved on, which is what "automatically invalid when the UI changes"
    means in practice: the model is told plainly to re-inspect, rather than
    being handed whatever now happens to occupy that slot.
    """

    def __init__(self) -> None:
        self._table: dict[str, Ref[T]] = {}
        self._generation = 0
        #: Every id this registry has ever handed out, kept even after
        #: `reset()` replaces the live table -- the one piece of state that
        #: must NOT reset with the rest, or a superseded id would look
        #: indistinguishable from one that was simply made up, and the two
        #: deserve different instructions back to the model (re-inspect,
        #: versus stop guessing ids).
        self._ever_issued: set[str] = set()

    def reset(self, items: list[Ref[T]]) -> list[str]:
        """Replace the whole table. Returns the `[eN]` id assigned to each item, in order."""
        self._generation += 1
        prefix = f"e{self._generation}."
        self._table = {f"{prefix}{i + 1}": item for i, item in enumerate(items)}
        self._ever_issued.update(self._table)
        return list(self._table.keys())

    def get(self, ref_id: str) -> T:
        entry = self._table.get(ref_id)
        if entry is None:
            if ref_id in self._ever_issued:
                raise StaleReferenceError(
                    f"'{ref_id}' is from an earlier inspection and no longer valid "
                    "-- the UI was re-inspected since. Inspect again and use the "
                    "new reference."
                )
            raise ReferenceNotFoundError(
                f"'{ref_id}' does not exist. Inspect or search first to get valid references."
            )
        return entry.value

    def describe(self, ref_id: str) -> str:
        entry = self._table.get(ref_id)
        return entry.summary if entry else ref_id

    def clear(self) -> None:
        self._table = {}


class ReferenceNotFoundError(KeyError):
    """A `[eN]` id was never issued."""


class StaleReferenceError(KeyError):
    """A `[eN]` id was issued by a table a later inspection replaced."""


#: Element counts above this are truncated in any listing tool -- inspecting
#: a genuinely huge tree/page a piece at a time (narrow the `find` query, or
#: inspect a specific sub-region) costs far fewer tokens than one dump of
#: everything, and the model rarely needs more than the first couple dozen
#: candidates to find what it is looking for.
MAX_ELEMENTS_SHOWN = 40


def format_listing(header: str, rows: list[str], truncated_count: int = 0) -> str:
    """The shared 'progressive inspection' rendering: a header, a numbered list.

    Deliberately plain text, not JSON -- these results are read by the model,
    not parsed by code, and a numbered list is fewer tokens than repeating
    field names on every row.
    """
    if not rows:
        return f"{header}\n(nothing found)"
    lines = [header, ""]
    lines.extend(rows)
    if truncated_count:
        lines.append(
            f"... and {truncated_count} more, not shown -- narrow the search "
            "(role/name/automation id) to see further matches."
        )
    return "\n".join(lines)
