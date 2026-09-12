"""Computer-control tools, exercised against real Notepad and a real browser.

Unlike `smoke_test.py`'s wiring probes (offline, no visible side effect),
these tests actually launch Notepad and a browser window on the machine
running them and drive them end to end -- this is the only way to prove the
structured-control claim (no screenshots, no coordinates) actually holds
against live Windows UI Automation and a live page. Requires an interactive
desktop session; skips itself cleanly if `psutil`/`pywinauto`/`playwright`
are not importable (the same lazy-import discipline the tools themselves
use) or if this is not Windows.

Five scenarios, matching the five required in the task spec:

    TEST 1  Notepad: launch -> inspect -> type -> verify -> close
    TEST 2  Browser: navigate -> inspect -> find -> interact -> verify
    TEST 3  list_windows -> focus -> inspect
    TEST 4  launch_app via native OS tools (already covered by TEST 1's
            launch, isolated here as its own explicit assertion)
    TEST 5  A clean, specific error when an element does not exist

    .venv/Scripts/python.exe tests/computer_control_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

failures: list[str] = []
passed = 0
skipped = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


def skip(reason: str) -> None:
    global skipped
    skipped += 1
    print(f"SKIPPED: {reason}")


async def main() -> int:
    if os.name != "nt":
        skip("computer-control tools are Windows-only in this build")
        return 0

    try:
        import psutil  # noqa: F401
        import pywinauto  # noqa: F401
        from playwright.async_api import async_playwright  # noqa: F401
    except ImportError as exc:
        skip(f"a required dependency is not installed ({exc}) -- pip install -r requirements.txt")
        return 0

    from app.llm import tools_browser, tools_os_control, tools_ui_automation
    from app.llm.tools_automation_common import ReferenceNotFoundError, StaleReferenceError
    from app.llm.tools_os_control import CloseAppInput, LaunchAppInput
    from app.llm.tools_ui_automation import (
        ElementRefInput,
        UiFindElementInput,
        UiFocusWindowInput,
        UiInspectInput,
        UiSetTextInput,
    )

    # ------------------------------------------------------------ TEST 1 & 4
    print("\n== TEST 1 & 4: launch Notepad (native OS tool) -> inspect -> type -> verify ==")
    ok, message = await tools_os_control._launch_app(LaunchAppInput(app="notepad"))
    check("TEST 4: launch_app launched notepad via the OS, not a UI click", ok, message)

    await asyncio.sleep(1.5)  # give the window time to actually appear

    listing = await tools_ui_automation.ui_list_windows()
    check("notepad appears in ui_list_windows", "notepad" in listing.lower(), listing[:200])

    inspected = await tools_ui_automation.ui_inspect(UiInspectInput(window="Notepad"))
    check("ui_inspect found at least one element", "[e" in inspected, inspected[:200])
    check(
        "ui_inspect found an editable text area",
        "Document" in inspected or "Edit" in inspected,
        inspected[:300],
    )

    found = await tools_ui_automation.ui_find_element(
        UiFindElementInput(window="Notepad", role="Document")
    )
    if "[e" not in found:
        found = await tools_ui_automation.ui_find_element(
            UiFindElementInput(window="Notepad", role="Edit")
        )
    check("ui_find_element located the editor", "[e" in found, found[:300])

    editor_ref = None
    for line in found.splitlines():
        line = line.strip()
        if line.startswith("[e") and "]" in line:
            editor_ref = line[1 : line.index("]")]
            break
    check("an editor reference was extracted", editor_ref is not None, found[:200])

    probe_text = "JARVIS computer-control test — hello, Notepad."
    if editor_ref:
        ok, message = await tools_ui_automation.ui_set_text(
            UiSetTextInput(element_id=editor_ref, text=probe_text)
        )
        check("ui_set_text reported success", ok, message)

        await asyncio.sleep(0.3)
        ok, read_back = await tools_ui_automation.ui_get_text(ElementRefInput(element_id=editor_ref))
        check(
            "ui_get_text reads back exactly what was typed",
            ok and probe_text in read_back,
            read_back[:200],
        )
    else:
        check("ui_set_text (skipped, no editor reference)", False, "see above")
        check("ui_get_text (skipped, no editor reference)", False, "see above")

    ok, message = await tools_os_control._close_app(CloseAppInput(name_contains="notepad", all_matches=True))
    check("close_app closed notepad", ok, message)

    # ---------------------------------------------------------------- TEST 5
    print("\n== TEST 5: clean failure when a requested element does not exist ==")
    try:
        tools_ui_automation._resolve("e999.999")
        check("resolving a never-issued reference raises", False, "no exception was raised")
    except ReferenceNotFoundError as exc:
        check(
            "resolving a never-issued reference raises a specific, actionable error",
            "does not exist" in str(exc) and "Inspect" in str(exc),
            str(exc),
        )

    # A stale reference: inspect something once, then inspect again (bumping
    # the generation), then try to use the first generation's id.
    ok, _ = await tools_os_control._launch_app(LaunchAppInput(app="notepad"))
    await asyncio.sleep(1.5)
    first = await tools_ui_automation.ui_inspect(UiInspectInput(window="Notepad"))
    first_ref = next(
        (l.strip()[1 : l.strip().index("]")] for l in first.splitlines() if l.strip().startswith("[e")),
        None,
    )
    await tools_ui_automation.ui_inspect(UiInspectInput(window="Notepad"))  # bump the generation
    if first_ref:
        try:
            tools_ui_automation._resolve(first_ref)
            check("a superseded reference is refused, not silently resolved", False, "no exception was raised")
        except StaleReferenceError as exc:
            check(
                "a superseded reference names itself stale and says to re-inspect",
                "no longer valid" in str(exc) or "Inspect again" in str(exc),
                str(exc),
            )
    else:
        check("stale-reference case (skipped, no reference to stage)", False, first[:200])
    await tools_os_control._close_app(CloseAppInput(name_contains="notepad", all_matches=True))

    # ---------------------------------------------------------------- TEST 3
    print("\n== TEST 3: list_windows -> focus -> retrieve UI structure ==")
    ok, _ = await tools_os_control._launch_app(LaunchAppInput(app="calculator"))
    check("TEST 3: launched calculator", ok)
    await asyncio.sleep(1.5)

    windows_before = await tools_ui_automation.ui_list_windows()
    check("calculator is listed among open windows", "calculator" in windows_before.lower(), windows_before[:200])

    ok, message = await tools_ui_automation.ui_focus_window(UiFocusWindowInput(title="Calculator"))
    check("ui_focus_window focused it", ok, message)

    structure = await tools_ui_automation.ui_inspect(UiInspectInput(window="Calculator"))
    check("ui_inspect returned real structure, not an empty listing", "[e" in structure, structure[:200])

    await tools_os_control._close_app(CloseAppInput(name_contains="calculator", all_matches=True))

    # ---------------------------------------------------------------- TEST 2
    print("\n== TEST 2: browser -> navigate -> inspect DOM -> interact -> verify ==")
    try:
        opened = await tools_browser.browser_open()
        check("browser_open reports success", "Browser open" in opened, opened)

        from app.llm.tools_browser import BrowserFindInput, BrowserNavigateInput, ElementRefInput as BElementRefInput

        ok, message = await tools_browser.browser_navigate(
            BrowserNavigateInput(url="https://example.com")
        )
        check("browser_navigate reached the page", ok, message)

        ok, url = await tools_browser.browser_current_url(tools_browser.TabIdInput())
        check("browser_current_url reports example.com", ok and "example.com" in url, url)

        ok, title = await tools_browser.browser_title(tools_browser.TabIdInput())
        check("browser_title returned a real title", ok and bool(title.strip()), title)

        page_structure = await tools_browser.browser_inspect(tools_browser.BrowserInspectInput())
        check(
            "browser_inspect returned the page's accessibility tree",
            "example.com" in page_structure.lower() or "[e" in page_structure or "link" in page_structure.lower(),
            page_structure[:300],
        )

        found = await tools_browser.browser_find(BrowserFindInput(role="link"))
        link_ref = None
        for line in found.splitlines():
            line = line.strip()
            if line.startswith("[e") and "]" in line:
                link_ref = line[1 : line.index("]")]
                break
        check("browser_find located a link on the page", link_ref is not None, found[:300])

        if link_ref:
            ok, text = await tools_browser.browser_get_text(BElementRefInput(element_id=link_ref))
            check("browser_get_text read the link's text", ok, text[:100])

            ok, message = await tools_browser.browser_click(BElementRefInput(element_id=link_ref))
            check("browser_click followed the link", ok, message)

            await asyncio.sleep(1.0)
            ok, url_after = await tools_browser.browser_current_url(tools_browser.TabIdInput())
            check(
                "TEST 2 verification: the URL actually changed after the click",
                ok and url_after != "https://example.com/",
                url_after,
            )
    finally:
        await tools_browser.close_session()

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"{passed} checks passed" + (f", {skipped} section(s) skipped" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
