"""OS-level automation: processes, launching, focus, clipboard, hotkeys.

Companion to `tools_system.py` (shell/files) and `tools_ui_automation.py`
(structured control inside one application). This module is for the layer
between those two: starting and stopping whole applications, and the handful
of OS mechanisms -- clipboard, global hotkeys, "what's focused right now" --
that no application-specific tool covers.

**Prefer the OS mechanism over UI automation whenever one exists.** Opening
Notepad by finding and double-clicking its taskbar icon would be absurd when
`os.startfile` already knows how; the same principle applies here. Launching
an app, opening a file with its associated program, or opening a URL are all
one call each, on purpose, so the model reaches for them before reaching for
`run_command` or a UI Automation click sequence to do the same thing less
reliably.

Windows only for now, matching this desktop platform's own scope (see the
docstring in `tools_ui_automation.py` for why). `list_processes` and
`open_path` degrade to a clear "not supported here" on other platforms rather
than a crash; the rest presently assume Windows and are guarded accordingly.

Dependency-light module scope, same discipline as `tools_system.py`: `psutil`
and `pywin32` are imported inside each handler, never at module import time,
so a platform that never calls these tools never pays for having them
installed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import webbrowser
from dataclasses import dataclass

from pydantic import BaseModel, Field

logger = logging.getLogger("jarvis.tools.os")
audit = logging.getLogger("jarvis.audit")

#: How many processes a listing shows before truncating. A full process table
#: on a busy machine is hundreds of rows and almost never what "what's
#: running" actually wants -- the model can filter by name in the query
#: instead of paging through everything.
MAX_PROCESSES_SHOWN = 60

#: Longest a launched app or an OS-open call is allowed to block this turn.
#: Launching is normally instant; this exists only to keep a wedged spawn
#: from stalling the whole turn indefinitely.
LAUNCH_TIMEOUT_SECONDS = 15


# ---------------------------------------------------------------------------
# Windows key-chord translation
# ---------------------------------------------------------------------------

#: pywinauto's `send_keys` uses its own terse chord syntax (`^`, `+`, `%`,
#: `{VK}`), which the model would get subtly wrong zero-shot the same way it
#: gets shell quoting wrong (see `tools_system.py`'s file-tools rationale).
#: `send_hotkey` instead accepts the way a person types a shortcut --
#: "ctrl+shift+s" -- and this table does the translation.
_MODIFIERS = {"ctrl": "^", "control": "^", "alt": "%", "shift": "+", "win": "{VK_LWIN down}{VK_LWIN up}"}

_NAMED_KEYS = {
    "enter": "{ENTER}", "return": "{ENTER}", "esc": "{ESC}", "escape": "{ESC}",
    "tab": "{TAB}", "space": "{SPACE}", "backspace": "{BACKSPACE}", "delete": "{DELETE}",
    "up": "{UP}", "down": "{DOWN}", "left": "{LEFT}", "right": "{RIGHT}",
    "home": "{HOME}", "end": "{END}", "pageup": "{PGUP}", "pagedown": "{PGDN}",
    "f1": "{F1}", "f2": "{F2}", "f3": "{F3}", "f4": "{F4}", "f5": "{F5}", "f6": "{F6}",
    "f7": "{F7}", "f8": "{F8}", "f9": "{F9}", "f10": "{F10}", "f11": "{F11}", "f12": "{F12}",
}


def translate_hotkey(chord: str) -> str:
    """"ctrl+shift+s" -> "^+s"; a bare letter or named key passes through escaped."""
    parts = [p.strip().lower() for p in chord.split("+") if p.strip()]
    if not parts:
        raise ValueError("empty hotkey")
    *mods, key = parts
    prefix = ""
    for mod in mods:
        translated = _MODIFIERS.get(mod)
        if translated is None:
            raise ValueError(f"unrecognized modifier '{mod}' (use ctrl/alt/shift/win)")
        prefix += translated
    if key in _NAMED_KEYS:
        return prefix + _NAMED_KEYS[key]
    if len(key) == 1:
        # pywinauto treats {}, (), ^, +, %, ~ as syntax even for a literal
        # keypress -- escape defensively rather than special-case each one.
        escaped = key if key.isalnum() else "{" + key + "}"
        return prefix + escaped
    raise ValueError(f"unrecognized key '{key}'")


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

class ListProcessesInput(BaseModel):
    #: Case-insensitive substring on the process name. Omit to list the
    #: busiest processes overall.
    name_contains: str | None = None


async def _list_processes(payload: ListProcessesInput) -> str:
    import psutil

    query = (payload.name_contains or "").strip().lower()
    rows: list[tuple[str, int, float]] = []
    for proc in psutil.process_iter(["pid", "name", "cpu_percent"]):
        try:
            info = proc.info
            name = info.get("name") or ""
            if query and query not in name.lower():
                continue
            rows.append((name, info.get("pid", 0), info.get("cpu_percent") or 0.0))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    rows.sort(key=lambda r: r[0].lower())
    total = len(rows)
    shown = rows[:MAX_PROCESSES_SHOWN]

    header = f"{total} process(es)" + (f" matching '{payload.name_contains}'" if query else "")
    lines = [f"  {name}  (pid {pid})" for name, pid, _cpu in shown]
    if total > len(shown):
        lines.append(f"  ... and {total - len(shown)} more -- narrow with name_contains")
    return header + "\n" + "\n".join(lines) if lines else header + "\n(none)"


class CloseAppInput(BaseModel):
    #: Exactly one of these two.
    pid: int | None = Field(default=None, ge=1)
    name_contains: str | None = None
    #: Terminate every match rather than refusing on ambiguity. Off by
    #: default: closing "one Chrome window" should not take every Chrome
    #: process with it just because the name matched more than one.
    all_matches: bool = False


async def _close_app(payload: CloseAppInput) -> tuple[bool, str]:
    import psutil

    if payload.pid is None and not payload.name_contains:
        return False, "Give either pid or name_contains."

    targets: list[psutil.Process] = []
    if payload.pid is not None:
        try:
            targets = [psutil.Process(payload.pid)]
        except psutil.NoSuchProcess:
            return False, f"No process with pid {payload.pid}."
    else:
        query = payload.name_contains.strip().lower()  # type: ignore[union-attr]
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                if query in (proc.info.get("name") or "").lower():
                    targets.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        if not targets:
            return False, f"No running process matches '{payload.name_contains}'."
        if len(targets) > 1 and not payload.all_matches:
            names = ", ".join(f"{p.info.get('name', '?')} (pid {p.pid})" for p in targets[:8])
            return False, (
                f"{len(targets)} processes match '{payload.name_contains}': {names}"
                + (", ..." if len(targets) > 8 else "")
                + ". Name one by pid, or pass all_matches=true to close every match."
            )

    closed: list[str] = []
    failed: list[str] = []
    for proc in targets:
        try:
            label = f"{proc.name()} (pid {proc.pid})"
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except psutil.TimeoutExpired:
                proc.kill()
            closed.append(label)
        except psutil.NoSuchProcess:
            closed.append(f"pid {proc.pid} (already gone)")
        except psutil.AccessDenied:
            failed.append(f"pid {proc.pid} (access denied)")

    if failed and not closed:
        return False, "Could not close: " + ", ".join(failed)
    message = "Closed: " + ", ".join(closed)
    if failed:
        message += ". Could not close: " + ", ".join(failed)
    return True, message


# ---------------------------------------------------------------------------
# Launching
# ---------------------------------------------------------------------------

#: Common app names resolved to a launch command, so "open chrome" does not
#: depend on the model guessing the right executable name or full path.
#: Deliberately small and Windows-specific; anything not listed here still
#: works via `launch_app` treating the value as a literal command, which
#: covers anything already on PATH.
_APP_ALIASES = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe", "calc": "calc.exe",
    "explorer": "explorer.exe", "file explorer": "explorer.exe", "files": "explorer.exe",
    "task manager": "taskmgr.exe",
    "control panel": "control.exe",
    "cmd": "cmd.exe", "command prompt": "cmd.exe", "terminal": "wt.exe",
    "powershell": "powershell.exe",
    "paint": "mspaint.exe",
    "chrome": "chrome.exe", "google chrome": "chrome.exe",
    "edge": "msedge.exe", "microsoft edge": "msedge.exe",
    "firefox": "firefox.exe",
    "vs code": "code.exe", "vscode": "code.exe", "visual studio code": "code.exe",
    "word": "winword.exe", "excel": "excel.exe", "powerpoint": "powerpnt.exe",
    "spotify": "spotify.exe",
    "settings": "ms-settings:",
}


class LaunchAppInput(BaseModel):
    #: A common name ("notepad", "chrome") or an exact command/path to run.
    app: str = Field(min_length=1)
    #: Extra command-line arguments, space-separated as they would be typed.
    args: str | None = None


async def _launch_app(payload: LaunchAppInput) -> tuple[bool, str]:
    import subprocess

    app = payload.app.strip()
    resolved = _APP_ALIASES.get(app.lower(), app)

    try:
        if resolved.endswith(":") or resolved.startswith(("http://", "https://")):
            # A URI scheme (ms-settings:, mailto:, etc.) or bare URL --
            # os.startfile hands it to whatever the OS registered for it.
            os.startfile(resolved)  # noqa: S606 - intended OS launch, not arbitrary exec
        else:
            command = resolved if not payload.args else f"{resolved} {payload.args}"
            subprocess.Popen(  # noqa: S603, S607 - the whole point of this tool
                command,
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
            )
        return True, f"Launched '{app}'."
    except OSError as exc:
        return False, (
            f"Could not launch '{app}' ({resolved}): {exc}. "
            "If this is not a common app name, pass the exact executable name or full path."
        )


class OpenPathInput(BaseModel):
    #: A file or folder path, or a URL.
    path: str = Field(min_length=1)


async def _open_path(payload: OpenPathInput) -> tuple[bool, str]:
    target = payload.path.strip().strip('"').strip("'")
    if target.startswith(("http://", "https://")):
        opened = webbrowser.open(target)
        return opened, (f"Opened {target} in the default browser." if opened else f"Could not open {target}.")

    from pathlib import Path

    path = Path(target)
    if not path.exists():
        return False, f"'{target}' does not exist."
    try:
        os.startfile(str(path))  # noqa: S606 - opens with the OS-registered handler
        kind = "folder" if path.is_dir() else "file"
        return True, f"Opened the {kind} '{path}' with its default application."
    except OSError as exc:
        return False, f"Could not open '{target}': {exc}"


# ---------------------------------------------------------------------------
# Windows, focus, clipboard, hotkeys
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class ActiveWindow:
    title: str
    process_name: str
    pid: int


def _active_window() -> ActiveWindow | None:
    import win32gui
    import win32process

    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return None
    title = win32gui.GetWindowText(hwnd)
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        import psutil

        process_name = psutil.Process(pid).name()
    except Exception:  # noqa: BLE001 - best-effort enrichment only
        pid, process_name = 0, "?"
    return ActiveWindow(title=title, process_name=process_name, pid=pid)


class SendHotkeyInput(BaseModel):
    #: e.g. "ctrl+l", "alt+tab", "ctrl+shift+s", "f5".
    keys: str = Field(min_length=1)


async def _send_hotkey(payload: SendHotkeyInput) -> tuple[bool, str]:
    try:
        chord = translate_hotkey(payload.keys)
    except ValueError as exc:
        return False, str(exc)

    from pywinauto.keyboard import send_keys

    try:
        send_keys(chord, pause=0.01)
    except Exception as exc:  # noqa: BLE001 - surface whatever pywinauto raised, plainly
        return False, f"Could not send '{payload.keys}': {exc}"
    return True, f"Sent {payload.keys}."


class ClipboardSetInput(BaseModel):
    text: str


async def _open_clipboard_with_retry(attempts: int = 5, delay: float = 0.05) -> None:
    """`OpenClipboard` fails if another process holds it -- routine and brief
    (anything that just copied something), not a real error. Retried
    directly rather than surfaced, since the caller cannot do anything about
    a lock a different application released a moment later anyway.

    Bug this guards against, found by testing rather than assumed: a naive
    `try: open(); ...; finally: close()` calls `close()` even when `open()`
    itself raised, which fails with its own, unrelated-looking error
    ("Thread does not have a clipboard open") that masks whatever the real
    problem was.
    """
    import win32clipboard

    last: Exception | None = None
    for _ in range(attempts):
        try:
            win32clipboard.OpenClipboard()
            return
        except Exception as exc:  # noqa: BLE001 - pywintypes.error, not importable by name portably
            last = exc
            await asyncio.sleep(delay)
    raise last if last is not None else RuntimeError("could not open the clipboard")


async def _clipboard_set(payload: ClipboardSetInput) -> tuple[bool, str]:
    import win32clipboard

    try:
        await _open_clipboard_with_retry()
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not access the clipboard: {exc}"
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(payload.text, win32clipboard.CF_UNICODETEXT)
    finally:
        win32clipboard.CloseClipboard()
    return True, f"Clipboard set ({len(payload.text)} character(s))."


async def _clipboard_get() -> tuple[bool, str]:
    import win32clipboard

    try:
        await _open_clipboard_with_retry()
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not access the clipboard: {exc}"
    try:
        try:
            text = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
        except TypeError:
            return False, "Clipboard does not currently hold text."
    finally:
        win32clipboard.CloseClipboard()
    return True, text


# ---------------------------------------------------------------------------
# Handlers (wired into app/llm/tools.py's ToolOutcome contract there)
# ---------------------------------------------------------------------------

def is_supported() -> bool:
    return os.name == "nt"


def unsupported_outcome(tool: str) -> str:
    return f"'{tool}' is only implemented on Windows in this build."
