"""Tools that reach outside JARVIS's own database.

Everything in `tools.py` operates on the user's tasks, schedule and notes. These
operate on the machine. That is a different kind of power and it is gated
differently: `settings.system_tools_enabled` must be on, and it is forced off in
the Android build, where the process is sandboxed and a shell can reach nothing
worth reaching.

**This module must stay dependency-light.** The same backend is packaged into
the APK by Chaquopy, where every dependency is pinned by hand and native wheels
have to be cross-compiled one at a time -- `pydantic_core` needed a wheel that
exists nowhere upstream. Nothing here imports anything the phone build does not
already carry. When something heavier lands (a browser driver, an HTML
parser with a C extension), import it *inside its handler*, not at module
scope, so merely having the tool cannot break the phone.

The safety posture is deliberate and was chosen by the operator: full access,
with warnings. There is no sandbox and no path allowlist. What there is:

* a confirmation gate on the small set of commands that are unrecoverable,
  reusing the two-step pattern `delete_record` already proves out — the first
  call describes, it does not run;
* a hard timeout, so a command that hangs cannot take the turn with it;
* an audit line for every invocation;
* output truncation that says how much it dropped, from the middle, because the
  tail of a failing command is the part that explains it.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("jarvis.tools.system")

#: Separate logger so an operator can route "what did it actually run" somewhere
#: durable without turning on debug logging for everything else.
audit = logging.getLogger("jarvis.audit")

#: Hard ceiling on a single command, whatever the caller asks for. A spoken turn
#: is already waiting on this; past a minute or so the right answer is to run it
#: in the background, not to keep the user listening to silence.
MAX_TIMEOUT_SECONDS = 300
DEFAULT_TIMEOUT_SECONDS = 60

#: How much captured output goes back to the model. Generous, because truncating
#: a stack trace defeats the point of running the command, but bounded because
#: this lands in the context window and is re-sent on every later iteration.
MAX_OUTPUT_CHARS = 12_000

#: Commands whose damage cannot be undone by running something else. Matched
#: loosely and deliberately over-eagerly: a needless confirmation costs one round
#: trip, a missed one costs the filesystem.
#:
#: This is not a security boundary. It cannot be -- the same shell that runs
#: `rm -rf` runs `python -c` -- and pretending otherwise would be worse than
#: saying plainly what it is: a guard against the model being careless, not
#: against it being adversarial.
_DESTRUCTIVE = [
    (re.compile(r"\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rRf]", re.I), "recursive or forced delete"),
    (re.compile(r"\brmdir\s+/s", re.I), "recursive directory delete"),
    (re.compile(r"\bdel\s+/[sq]", re.I), "recursive or quiet delete"),
    (re.compile(r"\bRemove-Item\b.*-Recurse", re.I), "recursive delete"),
    (re.compile(r"\bformat\b\s+[a-z]:", re.I), "formatting a drive"),
    (re.compile(r"\bmkfs(\.\w+)?\b", re.I), "making a filesystem"),
    (re.compile(r"\bdd\b.*\bof=/dev/", re.I), "raw write to a device"),
    (re.compile(r">\s*/dev/(sd|nvme|hd)", re.I), "raw write to a device"),
    (re.compile(r"\b(shutdown|reboot|halt)\b", re.I), "shutting the machine down"),
    (re.compile(r"\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)", re.I), "discarding git work"),
    (re.compile(r"\bdrop\s+(database|table)\b", re.I), "dropping a database object"),
    (re.compile(r":\(\)\s*\{.*\};\s*:", re.S), "a fork bomb"),
]


@dataclass(frozen=True, slots=True)
class CommandResult:
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    duration: float


#: Appended to the persona whenever the shell is available.
#:
#: The existing system prompt was written for an assistant whose tools each
#: answered a question outright -- add a task, list the schedule. One call, one
#: answer, then stop, and it says so emphatically ("answer ONLY what was
#: asked"). A shell does not work like that, and the mismatch produced a
#: specific and confident failure in testing: asked to count `.py` files,
#: JARVIS ran a single non-recursive listing, saw `__init__.py` among the
#: output, and replied "there are no .py files" -- contradicting its own
#: terminal output in the same breath.
#:
#: So this is not a general exhortation to try harder. It names the two ways
#: that turn goes wrong: stopping after one command, and stating a conclusion
#: the output does not support.
SYSTEM_TOOLS_GUIDANCE = """\
# Working on this machine

You have a real shell. Investigating takes more than one command, and that is
normal — the brevity rules govern what you *say*, never how much you check.

- Keep going until you actually know. One command rarely answers a question;
  chain them. Counting files means a recursive search, not a listing of the
  top level.
- Never state a conclusion your own output contradicts. If a listing showed a
  file, you cannot report there are none. Read what came back before answering.
- "No such file or directory" means you looked in the wrong place at least as
  often as it means the thing is missing. Check where you are before concluding
  something does not exist.
- Prefer one precise command over a guess you will have to correct. Quote paths
  that contain spaces.
- Nothing here can answer an interactive prompt, so pass the non-interactive
  flag (`-y`, `--yes`, `--no-input`) rather than waiting to be asked.

Then answer briefly. The work is allowed to be long; the reply is not."""


def environment_note() -> str:
    """Where the model actually is, for the system-prompt prefix.

    Added after watching a live turn get this wrong in the most confident way
    available: asked how many `.py` files were in `backend/app`, JARVIS ran
    `find backend/app`, got "No such file or directory" because the process
    starts *inside* `backend/`, and reported that the directory does not exist
    on this machine. It does. The model had no way to know its own footing, so
    it read a relative-path miss as an absolute fact.

    Stable for the life of the process, so it belongs in the cached prefix
    rather than the per-turn state block.
    """
    import platform

    shell = "cmd.exe" if os.name == "nt" else os.environ.get("SHELL", "/bin/sh")
    return (
        "# This machine\n"
        f"- Operating system: {platform.system()} {platform.release()}\n"
        f"- Shell used by run_command: {shell}\n"
        f"- Working directory: {os.getcwd()}\n"
        "\n"
        "Relative paths resolve against that working directory. Before "
        "concluding from a 'no such file' error that something does not exist, "
        "check where you are — list the directory, or use an absolute path."
    )


def classify(command: str) -> str | None:
    """Return why a command needs confirming, or None if it does not."""
    for pattern, reason in _DESTRUCTIVE:
        if pattern.search(command):
            return reason
    return None


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    """Keep both ends. The head says what it started doing, the tail says how it
    went; the middle of a long log is the least informative part."""
    if len(text) <= limit:
        return text
    head = limit // 2
    tail = limit - head
    dropped = len(text) - limit
    return f"{text[:head]}\n\n... [{dropped:,} characters omitted] ...\n\n{text[-tail:]}"


async def _kill_tree(process: asyncio.subprocess.Process) -> None:
    """Kill the command *and everything it started*.

    Killing only the direct child is not enough, and the failure is different on
    each platform. A shell command is run by an intermediary -- `cmd /c` on
    Windows, `/bin/sh -c` elsewhere -- so the process we hold a handle to is
    usually not the process doing the work.

    On Windows this was measured leaving the real command running after a
    timeout: `process.kill()` terminated `cmd.exe`, the orphan kept the stdout
    pipe open, and `process.wait()` then blocked for its full five-second grace
    period before giving up -- turning a 2s timeout into a 7s one and leaking
    the process. `taskkill /T` walks the tree.
    """
    if process.returncode is not None:
        return
    try:
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/F", "/T", "/PID", str(process.pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(killer.wait(), timeout=5)
        else:
            os.killpg(os.getpgid(process.pid), 9)
    except (ProcessLookupError, PermissionError, OSError, asyncio.TimeoutError):
        # Best effort. If the tree cannot be killed, the fallback below still
        # stops us waiting on it forever.
        try:
            process.kill()
        except (ProcessLookupError, OSError):
            pass


async def run_command(
    command: str,
    *,
    cwd: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> CommandResult:
    """Run one shell command to completion, or kill it at the timeout.

    Uses the platform shell so the model can write the command the way a person
    would -- pipes, redirects, `&&` -- rather than an argv list it would get
    subtly wrong.
    """
    loop = asyncio.get_running_loop()
    started = loop.time()

    process = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd or None,
        # Detached on POSIX so the whole process group can be killed; a shell
        # that spawns children otherwise leaves them running after a timeout.
        start_new_session=os.name != "nt",
    )

    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []

    async def drain(stream: asyncio.StreamReader | None, into: list[bytes]) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.read(8192)
            if not chunk:
                return
            into.append(chunk)

    # Read as it arrives rather than with `communicate()`. Two reasons, and the
    # second is the one that matters: a command killed at the timeout has
    # usually printed the very thing that explains why it hung, and
    # `communicate()` discards all of it when it is cancelled. Draining into
    # buffers means a timeout still comes back with everything it managed to
    # say. It is also the shape live streaming needs.
    readers = [
        asyncio.create_task(drain(process.stdout, out_chunks)),
        asyncio.create_task(drain(process.stderr, err_chunks)),
    ]

    try:
        await asyncio.wait_for(
            asyncio.gather(*readers, process.wait()), timeout=timeout
        )
        timed_out = False
    except asyncio.TimeoutError:
        timed_out = True
        await _kill_tree(process)
        for reader in readers:
            reader.cancel()
        # Reap it, so the timeout leaves neither a zombie nor -- on Windows,
        # where an unclosed pipe transport screams from __del__ at interpreter
        # shutdown -- a stream of unrelated tracebacks in the log.
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except (asyncio.TimeoutError, ProcessLookupError):
            pass
        await asyncio.gather(*readers, return_exceptions=True)

    def decode(chunks: list[bytes]) -> str:
        # errors="replace": a command emitting one bad byte must not fail the
        # turn with a UnicodeDecodeError.
        return b"".join(chunks).decode("utf-8", errors="replace")

    return CommandResult(
        exit_code=process.returncode,
        stdout=decode(out_chunks),
        stderr=decode(err_chunks),
        timed_out=timed_out,
        duration=loop.time() - started,
    )


# ---------------------------------------------------------------------------
# Tool input
# ---------------------------------------------------------------------------

class RunCommandInput(BaseModel):
    command: str = Field(min_length=1)
    cwd: str | None = None
    timeout: int = Field(default=DEFAULT_TIMEOUT_SECONDS, ge=1, le=MAX_TIMEOUT_SECONDS)
    confirmed: bool = False

    @field_validator("command")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("command cannot be empty")
        return cleaned


#: How each platform says "that path is not there".
_NOT_FOUND = re.compile(
    r"(no such file or directory"
    r"|cannot find the path"
    r"|cannot find the file"
    r"|does not exist"
    r"|not found)",
    re.I,
)


def _path_like(command: str) -> list[str]:
    """Tokens from a command line that look like paths."""
    try:
        tokens = shlex.split(command, posix=os.name != "nt")
    except ValueError:  # unbalanced quotes
        tokens = command.split()
    out: list[str] = []
    for token in tokens:
        token = token.strip("\"'")
        if token.startswith("-") or not token:
            continue
        if "/" in token or "\\" in token or re.search(r"\.\w{1,5}$", token):
            out.append(token)
    return out


def orientation_hint(command: str, result: CommandResult, cwd: str | None = None) -> str | None:
    """Turn "cannot find the path" into something the model can act on.

    A relative path that misses is ambiguous: the file may be absent, or you may
    be standing somewhere else. The model resolves that ambiguity badly and
    confidently — asked whether `backend/app/llm/tools_system.py` existed, it
    ran the check from inside `backend/`, got "cannot find the path", and
    reported the file does not exist. It had been created minutes earlier.

    So when a command fails that way, look for the path it actually meant and
    say where it is. This is the same move `delete_record` makes when a lookup
    misses: hand back the real answer instead of a bare refusal, so the model
    recovers inside the same turn rather than asserting something false.
    """
    if not result.timed_out and (result.exit_code or 0) == 0:
        return None
    if not _NOT_FOUND.search(result.stderr or ""):
        return None

    here = Path(cwd) if cwd else Path.cwd()
    # Where a mistyped relative path plausibly lives instead: above us (the
    # user naming a path from the repo root while we run inside a subdirectory)
    # or below us.
    bases = [here.parent, here.parent.parent, *sorted(p for p in here.iterdir() if p.is_dir())[:12]] \
        if here.exists() else []

    for candidate in _path_like(command):
        if Path(candidate).is_absolute():
            continue
        try:
            if (here / candidate).exists():
                continue  # this one was fine; the failure was something else
        except OSError:
            continue
        for base in bases:
            try:
                found = base / candidate
                if found.exists():
                    return (
                        f"Note: '{candidate}' does not exist relative to the working "
                        f"directory ({here}), but it does exist at {found.resolve()}. "
                        "You were looking in the wrong place — do not report it as missing."
                    )
            except OSError:
                continue
        # Walk up the candidate to find the deepest part that *does* exist, so
        # the model learns where the path stops being real.
        parts = Path(candidate).parts
        for depth in range(len(parts) - 1, 0, -1):
            partial = here.joinpath(*parts[:depth])
            try:
                if partial.exists():
                    return (
                        f"Note: relative to the working directory ({here}), "
                        f"'{Path(*parts[:depth])}' exists but "
                        f"'{Path(*parts[:depth + 1])}' does not. "
                        "Check the level that failed before concluding anything is missing."
                    )
            except OSError:
                break

    return f"Note: the working directory is {here}. Relative paths resolve from there."


def describe_result(result: CommandResult) -> str:
    """The text the model reads back. Ordered so failures explain themselves."""
    if result.timed_out:
        parts = [
            f"Killed after {result.duration:.0f}s — the command was still running. "
            "It may have been waiting for input, which it cannot receive here. "
            "Re-run it non-interactively, or raise the timeout if it is genuinely slow."
        ]
        # What it managed to print before it hung is normally the whole
        # explanation — a prompt it was blocked on, or the step it got stuck at.
        captured = "\n\n".join(
            f"{label}:\n{_truncate(text).rstrip()}"
            for label, text in (("stdout", result.stdout), ("stderr", result.stderr))
            if text.strip()
        )
        if captured:
            parts.append(f"Output before it was killed:\n\n{captured}")
        return "\n\n".join(parts)

    parts: list[str] = [f"exit code {result.exit_code} ({result.duration:.1f}s)"]
    if result.stdout.strip():
        parts.append(f"stdout:\n{_truncate(result.stdout).rstrip()}")
    if result.stderr.strip():
        parts.append(f"stderr:\n{_truncate(result.stderr).rstrip()}")
    if not result.stdout.strip() and not result.stderr.strip():
        parts.append("(no output)")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
#
# `run_command` can already `cat` and `sed`. These exist anyway, because three
# things go wrong when file work goes through a shell and two of them go wrong
# silently:
#
# * Quoting. Windows and POSIX disagree about quotes, escapes and globbing, and
#   the model gets it wrong in ways that look like the file's fault. It reached
#   for `python3` on Windows inside the first live turn.
# * Editing. `sed -i` on a pattern that matches twice edits both and says
#   nothing. Exact-match-or-refuse is the whole difference between an edit and
#   a corruption.
# * Portability. ls/dir, grep/findstr, wc/Measure-Object -- the same question
#   needs a different command per platform, and the model has to guess which
#   platform it is on before it can ask.

#: Read ceiling. Generous enough for any source file, bounded because the result
#: lands in the context window and is re-sent on every later tool iteration.
MAX_READ_CHARS = 200_000

#: A file with a null byte in its first block is binary; returning it as text
#: produces garbage that burns a turn and tells the model nothing.
_BINARY_SNIFF_BYTES = 8192

#: Directories never worth walking for a content search. Without this, a search
#: at the repo root spends its entire budget inside `node_modules` and reports
#: nothing the user asked about.
SEARCH_SKIP_DIRS = frozenset({
    ".git", ".venv", "venv", "node_modules", "__pycache__", ".next", "out",
    "build", "dist", "target", ".gradle", ".idea", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "site-packages",
})

MAX_SEARCH_RESULTS = 100
MAX_LIST_ENTRIES = 300


def is_binary(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return b"\0" in handle.read(_BINARY_SNIFF_BYTES)
    except OSError:
        return False


def outside_workspace(path: Path) -> bool:
    """Whether a path sits outside the tree JARVIS was started in.

    Not a boundary -- there is no sandbox here, by decision. It decides whether
    the outcome carries a warning, so that "edit the config in my project" and
    "edit something under Windows/System32" do not read identically to someone
    skimming the tool log afterwards.
    """
    try:
        path.resolve().relative_to(Path.cwd().resolve())
        return False
    except (ValueError, OSError):
        return True


def read_text_file(path: Path, offset: int = 0, limit: int | None = None) -> str:
    """Read a text file.

    Deliberately returns no line numbers. The model's usual next move after
    reading is `edit_file`, which matches an exact string -- and a numbered
    listing invites it to paste the numbers back in, where they match nothing
    and look like the file changed underneath it.
    """
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = raw.splitlines()
    total = len(lines)

    if offset or limit:
        start = max(0, offset)
        end = total if limit is None else min(total, start + limit)
        body = "\n".join(lines[start:end])
        header = f"{path} — lines {start + 1}-{end} of {total}"
    else:
        body = raw
        header = f"{path} — {total} line(s)"

    if len(body) > MAX_READ_CHARS:
        dropped = len(body) - MAX_READ_CHARS
        body = (
            f"{body[:MAX_READ_CHARS]}\n\n"
            f"... [{dropped:,} more characters — re-read with offset/limit]"
        )

    return f"{header}\n\n{body}"


@dataclass(frozen=True, slots=True)
class EditResult:
    ok: bool
    message: str
    occurrences: int = 0


def edit_text_file(
    path: Path, old_text: str, new_text: str, replace_all: bool = False
) -> EditResult:
    """Replace an exact string, or refuse and explain.

    The refusal is the point. A pattern matching twice when the caller meant one
    of them is the failure that corrupts a file quietly and is not noticed for
    hours, so ambiguity stops the edit and reports the count rather than picking
    one.
    """
    try:
        original = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return EditResult(False, f"{path} is not a UTF-8 text file.")
    except OSError as exc:
        return EditResult(False, f"Could not read {path}: {exc}")

    count = original.count(old_text)
    if count == 0:
        return EditResult(
            False,
            f"No match in {path}. That exact text is not present — check "
            "whitespace and indentation, and read the file again if it may "
            "have changed since you last saw it.",
        )
    if count > 1 and not replace_all:
        return EditResult(
            False,
            f"Ambiguous: that text appears {count} times in {path}. Nothing was "
            "changed. Include more surrounding context so the match is unique, "
            "or pass replace_all=true if every occurrence should change.",
            occurrences=count,
        )

    updated = (
        original.replace(old_text, new_text)
        if replace_all
        else original.replace(old_text, new_text, 1)
    )
    try:
        path.write_text(updated, encoding="utf-8")
    except OSError as exc:
        return EditResult(False, f"Could not write {path}: {exc}")

    changed = count if replace_all else 1
    delta = len(updated.splitlines()) - len(original.splitlines())
    shape = f"{delta:+d} lines" if delta else "same line count"
    return EditResult(
        True,
        f"Edited {path} — {changed} replacement(s), {shape}.",
        occurrences=count,
    )


def list_directory(
    path: Path, pattern: str | None = None, recursive: bool = False
) -> str:
    if not path.exists():
        return f"{path} does not exist."
    if not path.is_dir():
        return f"{path} is a file, not a directory."

    try:
        found = path.rglob(pattern or "*") if recursive else path.glob(pattern or "*")
        entries = sorted(found, key=lambda p: (p.is_file(), str(p).lower()))
    except OSError as exc:
        return f"Could not list {path}: {exc}"

    if recursive:
        entries = [
            entry
            for entry in entries
            if not any(part in SEARCH_SKIP_DIRS for part in entry.relative_to(path).parts)
        ]

    if not entries:
        qualifier = f" matching {pattern!r}" if pattern else ""
        return f"{path} contains nothing{qualifier}."

    lines = [f"{path} — {len(entries)} entries"]
    for entry in entries[:MAX_LIST_ENTRIES]:
        name = str(entry.relative_to(path)) if recursive else entry.name
        try:
            lines.append(
                f"  {name}/" if entry.is_dir()
                else f"  {name}  ({entry.stat().st_size:,} bytes)"
            )
        except OSError:
            lines.append(f"  {name}  (unreadable)")
    if len(entries) > MAX_LIST_ENTRIES:
        lines.append(f"  ... and {len(entries) - MAX_LIST_ENTRIES:,} more")
    return "\n".join(lines)


def search_in_files(
    query: str,
    root: Path,
    glob: str = "*",
    regex: bool = False,
    ignore_case: bool = True,
) -> str:
    """Grep, without having to know whether this machine has grep."""
    if not root.exists():
        return f"{root} does not exist."

    try:
        matcher = re.compile(
            query if regex else re.escape(query),
            re.IGNORECASE if ignore_case else 0,
        )
    except re.error as exc:
        return f"Invalid regular expression: {exc}"

    hits: list[str] = []
    scanned = 0
    truncated = False

    candidates = root.rglob(glob) if root.is_dir() else iter([root])
    for candidate in candidates:
        if len(hits) >= MAX_SEARCH_RESULTS:
            truncated = True
            break
        try:
            if not candidate.is_file():
                continue
            if any(part in SEARCH_SKIP_DIRS for part in candidate.parts):
                continue
            if is_binary(candidate):
                continue
            scanned += 1
            with candidate.open("r", encoding="utf-8", errors="replace") as handle:
                for number, line in enumerate(handle, start=1):
                    if matcher.search(line):
                        try:
                            shown = candidate.relative_to(root)
                        except ValueError:
                            shown = candidate
                        hits.append(f"{shown}:{number}: {line.strip()[:200]}")
                        if len(hits) >= MAX_SEARCH_RESULTS:
                            truncated = True
                            break
        except (OSError, ValueError):
            continue

    if not hits:
        return f"No match for {query!r} in {root} ({scanned:,} file(s) searched)."

    header = f"{len(hits)} match(es) for {query!r} across {scanned:,} file(s)"
    if truncated:
        header += f" — stopped at {MAX_SEARCH_RESULTS}; narrow the search for the rest"
    return header + "\n" + "\n".join(f"  {hit}" for hit in hits)


# ---------------------------------------------------------------------------
# File tool inputs
# ---------------------------------------------------------------------------

class _PathInput(BaseModel):
    path: str = Field(min_length=1)

    @field_validator("path")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        cleaned = value.strip().strip('"').strip("'")
        if not cleaned:
            raise ValueError("path cannot be empty")
        return cleaned


class ReadFileInput(_PathInput):
    offset: int = Field(default=0, ge=0)
    limit: int | None = Field(default=None, ge=1)


class WriteFileInput(_PathInput):
    content: str
    confirmed: bool = False


class EditFileInput(_PathInput):
    old_text: str = Field(min_length=1)
    new_text: str
    replace_all: bool = False


class ListDirInput(BaseModel):
    path: str = "."
    pattern: str | None = None
    recursive: bool = False


class SearchFilesInput(BaseModel):
    query: str = Field(min_length=1)
    path: str = "."
    glob: str = "*"
    regex: bool = False
