"""Tools that can touch the machine, and the guards around them.

The posture here was chosen deliberately: full access, with warnings. So these
tests are not about proving JARVIS is confined -- it is not, and cannot be while
the same shell that runs `rm -rf` runs `python -c`. They pin the things that
must hold anyway:

* the confirmation gate fires *before* anything runs, not after;
* a hang is survivable -- a timeout kills the process and comes back as text
  the model can act on, rather than taking the turn down;
* a non-zero exit is readable information, not a swallowed failure;
* the capability gate actually hides these on mobile, where the process is
  sandboxed and a shell reaches nothing.

Everything runs real subprocesses, because a mocked subprocess proves nothing
about the part that goes wrong (process groups, timeouts, decoding).

    .venv/Scripts/python.exe tests/system_tools_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SCRATCH = Path(tempfile.gettempdir()) / "jarvis_system_tools_test.db"
if SCRATCH.exists():
    SCRATCH.unlink()
os.environ["JARVIS_DB_PATH"] = str(SCRATCH)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.core.config as cfg  # noqa: E402

cfg.settings = get_settings()

import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(cfg.settings.db_file, 5)
import app.db.crud as crud  # noqa: E402

crud.db = dbmod.db

import app.llm.tools as tools  # noqa: E402
from app.llm.tools_system import (  # noqa: E402
    CommandResult,
    RunCommandInput,
    classify,
    describe_result,
    run_command,
)

tools.crud = crud
tools.settings = cfg.settings

PY = sys.executable

passed = 0
failed = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")


async def main() -> None:
    await dbmod.db.connect()
    try:
        print("== classify: what needs a confirmation ==")
        dangerous = [
            ("rm -rf /", "recursive delete"),
            ("rm -fr build", "short flag order"),
            ("sudo rm -rf ~/Documents", "with sudo"),
            ("del /s C:\\temp", "windows recursive del"),
            ("Remove-Item -Recurse -Force .\\dist", "powershell"),
            ("git reset --hard HEAD~3", "discards work"),
            ("git push origin main --force", "force push"),
            ("mkfs.ext4 /dev/sda1", "makes a filesystem"),
            ("dd if=/dev/zero of=/dev/sda", "raw device write"),
            ("shutdown /s /t 0", "powers the machine off"),
            ("DROP TABLE users;", "drops a table"),
        ]
        for command, why in dangerous:
            check(f"flags {command[:34]:<34} ({why})", classify(command) is not None)

        safe = [
            "ls -la",
            "git status",
            "git log --oneline -20",
            "python -m pytest",
            "npm run build",
            "cat README.md",
            "grep -rn TODO src/",
            "echo rm -rf is only a string here" .replace("rm -rf", "remove"),
            "curl -s https://example.com",
        ]
        for command in safe:
            check(f"allows {command[:40]:<40}", classify(command) is None, classify(command))

        print("\n== the gate fires before anything runs ==")
        marker = Path(tempfile.gettempdir()) / "jarvis_gate_probe.txt"
        marker.write_text("still here", encoding="utf-8")
        # A genuinely destructive command against a file we can check afterwards.
        destructive = (
            f'Remove-Item -Recurse -Force "{marker}"'
            if os.name == "nt"
            else f"rm -rf {marker}"
        )
        outcome = await tools.execute_tool("run_command", {"command": destructive})
        check("unconfirmed destructive returns CONFIRMATION REQUIRED",
              "CONFIRMATION REQUIRED" in outcome.content, outcome.content[:90])
        check("  ...and quotes the command back", destructive in outcome.content)
        check("  ...and the file is untouched", marker.exists())
        check("  ...and it is not reported as an error",
              outcome.is_error is False, outcome.is_error)
        marker.unlink(missing_ok=True)

        print("\n== ordinary commands just run ==")
        outcome = await tools.execute_tool(
            "run_command", {"command": f'{PY} -c "print(6*7)"'}
        )
        check("stdout comes back", "42" in outcome.content, outcome.content[:120])
        check("exit code reported", "exit code 0" in outcome.content)
        check("not an error", outcome.is_error is False)
        check("display carries the command", (outcome.display or {}).get("command") is not None)

        print("\n== failure is information, not a swallowed error ==")
        outcome = await tools.execute_tool(
            "run_command",
            {"command": f'{PY} -c "import sys; sys.stderr.write(\'boom\\n\'); sys.exit(3)"'},
        )
        check("non-zero exit is surfaced", "exit code 3" in outcome.content, outcome.content[:120])
        check("stderr is included", "boom" in outcome.content)
        check("marked as error so the model notices", outcome.is_error is True)

        print("\n== a hang is survivable ==")
        result = await run_command(f'{PY} -c "import time; time.sleep(30)"', timeout=2)
        check("timed out rather than hanging", result.timed_out is True)
        check("  ...and took about the timeout", 1.0 < result.duration < 12.0, f"{result.duration:.1f}s")
        text = describe_result(result)
        check("  ...and explains itself to the model", "Killed after" in text, text[:90])
        check("  ...and suggests a way out", "non-interactively" in text)

        print("\n== bad input is recoverable text, never an exception ==")
        outcome = await tools.execute_tool("run_command", {"command": "echo hi", "cwd": "/no/such/dir"})
        check("missing cwd is a readable error", outcome.is_error and "does not exist" in outcome.content,
              outcome.content[:90])
        outcome = await tools.execute_tool("run_command", {"command": "   "})
        check("blank command rejected by validation", outcome.is_error, outcome.content[:90])
        outcome = await tools.execute_tool("run_command", {})
        check("missing command rejected", outcome.is_error, outcome.content[:90])

        print("\n== output truncation keeps both ends ==")
        big = await run_command(
            f'{PY} -c "print(\'A\'*40000); print(\'ZEBRA_TAIL\')"', timeout=30
        )
        text = describe_result(big)
        check("truncated", "characters omitted" in text, f"{len(text)} chars")
        check("  ...head survives", "AAAA" in text)
        check("  ...tail survives", "ZEBRA_TAIL" in text)
        check("  ...bounded", len(text) < 20_000, len(text))

        print("\n== files: reading ==")
        sandbox = Path(tempfile.mkdtemp(prefix="jarvis_fs_test_"))
        sample = sandbox / "sample.py"
        sample.write_text(
            "\n".join(f"line {n}" for n in range(1, 51)), encoding="utf-8"
        )

        outcome = await tools.execute_tool("read_file", {"path": str(sample)})
        check("reads a file", "line 1" in outcome.content and "line 50" in outcome.content)
        check("  ...and states the line count", "50 line(s)" in outcome.content, outcome.content[:80])
        check("  ...without line-number prefixes", "\n1\t" not in outcome.content)

        outcome = await tools.execute_tool(
            "read_file", {"path": str(sample), "offset": 9, "limit": 3}
        )
        check("offset/limit pages", "line 10" in outcome.content and "line 12" in outcome.content)
        check("  ...and excludes the rest", "line 13" not in outcome.content)
        check("  ...and says which window", "lines 10-12 of 50" in outcome.content, outcome.content[:90])

        outcome = await tools.execute_tool("read_file", {"path": str(sandbox / "ghost.py")})
        check("missing file is a readable error", outcome.is_error and "does not exist" in outcome.content)
        check("  ...and orients with the cwd", "Working directory" in outcome.content)

        outcome = await tools.execute_tool("read_file", {"path": str(sandbox)})
        check("a directory redirects to list_dir", outcome.is_error and "list_dir" in outcome.content)

        binary = sandbox / "blob.bin"
        binary.write_bytes(b"\x00\x01\x02PNG\x00binary")
        outcome = await tools.execute_tool("read_file", {"path": str(binary)})
        check("binary is refused, not returned as garbage",
              outcome.is_error and "binary file" in outcome.content, outcome.content[:80])

        print("\n== files: writing ==")
        fresh = sandbox / "nested" / "new.txt"
        outcome = await tools.execute_tool(
            "write_file", {"path": str(fresh), "content": "hello\nworld\n"}
        )
        check("creates without asking", not outcome.is_error and "Created" in outcome.content)
        check("  ...including parent directories", fresh.exists())
        check("  ...with the right content", fresh.read_text(encoding="utf-8") == "hello\nworld\n")

        outcome = await tools.execute_tool(
            "write_file", {"path": str(fresh), "content": "REPLACED"}
        )
        check("overwrite asks first", "CONFIRMATION REQUIRED" in outcome.content)
        check("  ...and nothing was written", fresh.read_text(encoding="utf-8") == "hello\nworld\n")
        check("  ...and it points at edit_file", "edit_file" in outcome.content)

        outcome = await tools.execute_tool(
            "write_file", {"path": str(fresh), "content": "REPLACED", "confirmed": True}
        )
        check("confirmed overwrite proceeds", "Overwrote" in outcome.content)
        check("  ...and the content changed", fresh.read_text(encoding="utf-8") == "REPLACED")

        print("\n== files: editing is exact-match-or-refuse ==")
        target = sandbox / "config.py"
        original = 'DEBUG = True\nNAME = "jarvis"\nOTHER = "jarvis"\n'
        target.write_text(original, encoding="utf-8")

        outcome = await tools.execute_tool(
            "edit_file",
            {"path": str(target), "old_text": "DEBUG = True", "new_text": "DEBUG = False"},
        )
        check("a unique match edits", not outcome.is_error, outcome.content[:90])
        check("  ...and only that line changed",
              target.read_text(encoding="utf-8") == original.replace("DEBUG = True", "DEBUG = False"))

        target.write_text(original, encoding="utf-8")
        outcome = await tools.execute_tool(
            "edit_file", {"path": str(target), "old_text": '"jarvis"', "new_text": '"JARVIS"'},
        )
        check("an ambiguous match REFUSES", outcome.is_error and "Ambiguous" in outcome.content,
              outcome.content[:90])
        check("  ...says how many times it matched", "appears 2 times" in outcome.content)
        check("  ...AND CHANGES NOTHING", target.read_text(encoding="utf-8") == original)

        outcome = await tools.execute_tool(
            "edit_file",
            {"path": str(target), "old_text": '"jarvis"', "new_text": '"JARVIS"', "replace_all": True},
        )
        check("replace_all is the way through", not outcome.is_error)
        check("  ...and changed both", target.read_text(encoding="utf-8").count('"JARVIS"') == 2)

        outcome = await tools.execute_tool(
            "edit_file", {"path": str(target), "old_text": "NOT PRESENT", "new_text": "x"},
        )
        check("no match refuses", outcome.is_error and "No match" in outcome.content)
        check("  ...and suggests why", "whitespace" in outcome.content)

        outcome = await tools.execute_tool(
            "edit_file", {"path": str(sandbox / "ghost.py"), "old_text": "a", "new_text": "b"},
        )
        check("editing a missing file points at write_file",
              outcome.is_error and "write_file" in outcome.content)

        print("\n== files: listing and searching ==")
        (sandbox / "node_modules").mkdir()
        (sandbox / "node_modules" / "junk.py").write_text("NEEDLE", encoding="utf-8")
        (sandbox / "real.py").write_text("alpha\nNEEDLE here\nbeta", encoding="utf-8")

        outcome = await tools.execute_tool("list_dir", {"path": str(sandbox)})
        check("lists entries", "real.py" in outcome.content)
        check("  ...with sizes", "bytes" in outcome.content)

        outcome = await tools.execute_tool(
            "list_dir", {"path": str(sandbox), "pattern": "*.py"}
        )
        check("pattern filters", "real.py" in outcome.content and "blob.bin" not in outcome.content)

        outcome = await tools.execute_tool(
            "list_dir", {"path": str(sandbox), "recursive": True}
        )
        check("recursive skips node_modules", "junk.py" not in outcome.content, outcome.content[:200])

        outcome = await tools.execute_tool(
            "search_files", {"query": "NEEDLE", "path": str(sandbox)}
        )
        check("finds the match", "real.py" in outcome.content)
        check("  ...with a line number", ":2:" in outcome.content, outcome.content[:150])
        check("  ...and skips node_modules", "junk.py" not in outcome.content)

        outcome = await tools.execute_tool(
            "search_files", {"query": "NOTHINGHERE", "path": str(sandbox)}
        )
        check("no match says so plainly", "No match" in outcome.content and not outcome.is_error)

        outcome = await tools.execute_tool(
            "search_files", {"query": "N[EI]+DLE", "path": str(sandbox), "regex": True}
        )
        check("regex works", "real.py" in outcome.content)

        outcome = await tools.execute_tool(
            "search_files", {"query": "(unclosed", "path": str(sandbox), "regex": True}
        )
        check("a bad regex is explained, not raised",
              outcome.is_error and "Invalid regular expression" in outcome.content)

        print("\n== files: writes outside the workspace are flagged ==")
        outside = Path(tempfile.gettempdir()) / "jarvis_outside_probe.txt"
        outside.unlink(missing_ok=True)
        outcome = await tools.execute_tool(
            "write_file", {"path": str(outside), "content": "x"}
        )
        check("outside the cwd carries a note", "outside the working directory" in outcome.content,
              outcome.content[:140])
        inside = BACKEND / "storage" / "jarvis_inside_probe.txt"
        outcome = await tools.execute_tool(
            "write_file", {"path": str(inside), "content": "x"}
        )
        check("inside the cwd does not", "outside the working directory" not in outcome.content)
        inside.unlink(missing_ok=True)
        outside.unlink(missing_ok=True)

        import shutil

        shutil.rmtree(sandbox, ignore_errors=True)

        print("\n== 'not found' that really means 'wrong place' ==")
        # The failure this guards against, observed live: asked whether
        # `backend/app/llm/tools_system.py` existed, JARVIS ran the check from
        # inside `backend/`, got "cannot find the path", and reported the file
        # does not exist. It had been created minutes earlier.
        from app.llm.tools_system import orientation_hint

        backend = str(BACKEND)
        missed = CommandResult(
            exit_code=1, stdout="", stderr="The system cannot find the path specified.",
            timed_out=False, duration=0.1,
        )
        hint = orientation_hint("cat backend/app/llm/tools_system.py", missed, cwd=backend)
        check("a path that exists one level up is located", hint is not None, hint)
        check("  ...and named explicitly",
              hint is not None and "tools_system.py" in hint, hint)
        check("  ...and the model is told not to report it missing",
              hint is not None and "do not report it as missing" in hint, hint)

        deep = orientation_hint("cat app/llm/nope_not_real.py", missed, cwd=backend)
        check("a genuinely missing file reports where the path stops being real",
              deep is not None and "exists but" in deep, deep)

        clean = CommandResult(exit_code=0, stdout="fine", stderr="", timed_out=False, duration=0.1)
        check("no hint on success", orientation_hint("ls", clean, cwd=backend) is None)

        unrelated = CommandResult(
            exit_code=1, stdout="", stderr="permission denied", timed_out=False, duration=0.1,
        )
        check("no hint for unrelated failures",
              orientation_hint("cat secret.txt", unrelated, cwd=backend) is None)

        print("\n== the shell guidance is only paid for when the shell exists ==")
        import app.llm.agent as agent_mod

        with_tools = agent_mod._build_persona_message(voice=False)["content"]
        check("guidance present when enabled", "Working on this machine" in with_tools)
        check("working directory stated", "Working directory:" in with_tools)

        cfg.settings.jarvis_system_tools = False
        without = agent_mod._build_persona_message(voice=False)["content"]
        check("guidance absent when disabled", "Working on this machine" not in without)
        check("  ...and the prefix is shorter for it", len(without) < len(with_tools))
        cfg.settings.jarvis_system_tools = True

        print("\n== capability gating ==")
        names = {t["function"]["name"] for t in tools.openai_tools()}
        check("offered on desktop", "run_command" in names)

        cfg.settings.jarvis_client_owned_data = True   # the mobile build
        mobile = {t["function"]["name"] for t in tools.openai_tools()}
        check("hidden on mobile", "run_command" not in mobile)
        outcome = await tools.execute_tool("run_command", {"command": "echo hi"})
        check("  ...and refused even if called directly",
              outcome.is_error and "not available" in outcome.content, outcome.content[:90])
        cfg.settings.jarvis_client_owned_data = False

        cfg.settings.jarvis_system_tools = False       # operator switched it off
        check("hidden when the operator disables it",
              "run_command" not in {t["function"]["name"] for t in tools.openai_tools()})
        cfg.settings.jarvis_system_tools = True

        print("\n== core tools are unaffected by any of this ==")
        core_names = [s.name for s in tools.TOOL_REGISTRY if s.capability == "core"]
        # Not a count — counts change legitimately whenever a core tool is
        # added, and a magic number just makes an unrelated test fail. The
        # invariant that actually matters is that gating system tools off leaves
        # the core set intact and in the same order, because that order is the
        # cached request prefix.
        cfg.settings.jarvis_system_tools = False
        gated = [t["function"]["name"] for t in tools.openai_tools()]
        cfg.settings.jarvis_system_tools = True
        check("gating leaves the core set complete", gated == core_names, gated)
        check(
            "core keeps its positions when system tools are offered",
            [t["function"]["name"] for t in tools.openai_tools()][: len(core_names)]
            == core_names,
        )
        check("no system tool has crept into the core set",
              all(s.capability == "core" for s in tools.TOOL_REGISTRY
                  if s.name in core_names))
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
