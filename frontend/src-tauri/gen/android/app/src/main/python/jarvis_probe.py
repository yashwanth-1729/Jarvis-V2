"""Does the Python side of JARVIS actually work on this device?

The cross-compiled pydantic-core links and looks correct, but a wrong ABI or a
missing symbol only shows up when CPython genuinely imports the module — never
at build time. So this runs the import for real, constructs a model and
validates through it, which is what exercises the Rust code rather than merely
loading it.

Deliberately reports failures as data instead of raising: a probe that crashes
the app tells you less than one that comes back and says what went wrong.
"""

from __future__ import annotations

import json


def check() -> str:
    """Return a JSON report of what works. Never raises."""
    report: dict[str, object] = {}

    try:
        import platform
        import sys

        report["python"] = sys.version.split()[0]
        report["machine"] = platform.machine()
    except Exception as exc:  # pragma: no cover - defensive
        report["interpreter_error"] = repr(exc)

    # The whole reason this file exists.
    try:
        import pydantic
        from pydantic import BaseModel

        class Probe(BaseModel):
            count: int
            label: str

        # Constructing through the model is what actually calls into the Rust
        # extension; importing it alone would not prove much.
        model = Probe(count=41, label="ok")
        coerced = Probe(count="7", label="coerced")  # type: ignore[arg-type]

        report["pydantic"] = pydantic.VERSION
        report["validated"] = model.count + 1
        report["coercion"] = coerced.count  # 7 as int, proving real validation

        from pydantic_core import __version__ as core_version

        report["pydantic_core"] = core_version
        report["ok"] = True
    except Exception as exc:
        report["ok"] = False
        report["pydantic_error"] = f"{type(exc).__name__}: {exc}"

    # sqlite backs the local store, and Chaquopy ships it as one of its
    # stdlib extension modules -- worth confirming while we are here.
    try:
        import sqlite3

        connection = sqlite3.connect(":memory:")
        connection.execute("CREATE TABLE t (x INTEGER)")
        connection.execute("INSERT INTO t VALUES (1)")
        report["sqlite"] = connection.execute("SELECT COUNT(*) FROM t").fetchone()[0]
        connection.close()
    except Exception as exc:
        report["sqlite_error"] = f"{type(exc).__name__}: {exc}"

    return json.dumps(report)
