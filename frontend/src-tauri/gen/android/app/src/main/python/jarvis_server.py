"""Run the JARVIS backend inside the Android app.

The phone hosts its own JARVIS rather than reaching a machine on the network,
so the same FastAPI application that runs on the desktop runs here, served by
uvicorn on loopback. The WebView then talks to 127.0.0.1 exactly as the desktop
app talks to its local backend -- one architecture, two devices.

Two things differ from the desktop and both matter:

*Storage.* ``BACKEND_ROOT`` resolves into Chaquopy's extracted assets, which are
read-only. The database path is therefore overridden with an absolute location
in the app's private files directory, which is writable and survives restarts.

*Lifetime.* Nothing here outlives the app. The server runs on a daemon thread
and is asked to stop when the activity goes away, because a foreground-only
assistant that leaves a socket listening is exactly what the design rules out.
"""

from __future__ import annotations

import json
import logging
from logging.handlers import RotatingFileHandler
import os
import sys
import threading
from typing import Any

HOST = "127.0.0.1"
PORT = 8000

_server: Any = None
_thread: threading.Thread | None = None
_lock = threading.Lock()


def _configure(files_dir: str) -> None:
    """Point the backend at writable storage before anything imports settings.

    Order matters: ``app.core.config`` reads the environment once at import
    time, so every value has to be in place before the first import of the
    application package.
    """
    storage = os.path.join(files_dir, "jarvis")
    os.makedirs(storage, exist_ok=True)

    # Absolute, because a relative path would resolve under the read-only
    # asset directory rather than here.
    os.environ.setdefault("JARVIS_DB_PATH", os.path.join(storage, "jarvis_memory.db"))
    os.environ.setdefault("JARVIS_HOST", HOST)
    os.environ.setdefault("JARVIS_PORT", str(PORT))

    # The desktop reads these from backend/.env, which is not shipped. Sync
    # stays off until the user enters credentials in the app's settings; the
    # board works locally without it.
    os.environ.setdefault("JARVIS_SYNC_ENABLED", "false")

    # IndexedDB in the WebView is the authoritative store here; this database is
    # a working copy the agent reads and writes, seeded and drained through
    # /api/local. Without this the agent's edits would land in SQLite and never
    # reach the board the user is looking at.
    os.environ.setdefault("JARVIS_CLIENT_OWNED_DATA", "true")

    # The actual platform signal -- desktop is client-owned-data too now (see
    # above), but only Android is sandboxed and foreground-only. This is what
    # config.py's system_tools_enabled/scheduler_enabled key off instead of
    # the data-ownership flag, so desktop keeps its shell tools and scheduler.
    os.environ.setdefault("JARVIS_ANDROID", "true")


class _LogcatHandler(logging.Handler):
    """Send Python log records where they can actually be read on a phone.

    Chaquopy forwards stdout and stderr to logcat, but the logging module
    writes nowhere by default, so every logger in the backend -- including the
    timing instrumentation -- was invisible on the device. Diagnosing anything
    meant guessing.

    Tagged so it can be filtered: `adb logcat -s JarvisPy`.
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            stream = sys.stderr if record.levelno >= logging.WARNING else sys.stdout
            print(f"JarvisPy {record.levelname[0]} {record.name}: {self.format(record)}",
                  file=stream, flush=True)
        except Exception:  # pragma: no cover - logging must never raise
            pass


def _wire_logging(files_dir: str) -> None:
    """Log to logcat *and* to a file that outlives the process.

    logcat alone is not enough to diagnose anything reported after the fact.
    Its ring buffer defaults to 256 KiB, and on this phone the system's own
    chatter evicts a whole session's Python output inside about seven minutes;
    a reboot clears it outright, along with any `logcat -G` resizing. Twice now
    a user-reported problem has been investigated with the evidence already
    gone.

    So the same records also go to a small rotating file in the app's private
    storage, which survives both. Pull it with:

        adb exec-out run-as <package> cat files/jarvis/jarvis.log
    """
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    if not any(isinstance(h, _LogcatHandler) for h in root.handlers):
        handler = _LogcatHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        root.addHandler(handler)

    if any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        return
    try:
        storage = os.path.join(files_dir, "jarvis")
        os.makedirs(storage, exist_ok=True)
        # Two files of 512 KB: enough for several sessions, small enough to be
        # irrelevant next to a 150 MB app.
        to_file = RotatingFileHandler(
            os.path.join(storage, "jarvis.log"),
            maxBytes=512 * 1024,
            backupCount=1,
            encoding="utf-8",
        )
        to_file.setFormatter(
            logging.Formatter("%(asctime)s %(levelname).1s %(name)s: %(message)s")
        )
        root.addHandler(to_file)
    except Exception:  # pragma: no cover - logging must never break startup
        pass


def start(files_dir: str) -> str:
    """Start the backend if it is not already running. Returns a JSON report.

    Never raises: a backend that fails to come up should leave the app working
    from local data, which it can, rather than taking the activity down with
    it.
    """
    global _server, _thread

    with _lock:
        if _thread is not None and _thread.is_alive():
            return json.dumps({"ok": True, "already_running": True, "port": PORT})

        try:
            _configure(files_dir)
            _wire_logging(files_dir)

            import uvicorn

            from main import app  # noqa: PLC0415 - must follow _configure()

            config = uvicorn.Config(
                app,
                host=HOST,
                port=PORT,
                # asyncio rather than uvloop, and wsproto rather than
                # websockets: both alternatives are native and neither is
                # available here. Pure-Python equivalents cost throughput that
                # a single-user loopback server does not need.
                loop="asyncio",
                ws="wsproto",
                log_level="info",
                # Nothing is proxying this, and access logs on a loopback
                # socket are noise in logcat.
                access_log=False,
            )
            _server = uvicorn.Server(config)

            # Daemon so a hung server can never keep the process alive after
            # the user has closed the app.
            _thread = threading.Thread(target=_server.run, name="jarvis-uvicorn", daemon=True)
            _thread.start()

            return json.dumps({"ok": True, "port": PORT, "db": os.environ["JARVIS_DB_PATH"]})
        except Exception as exc:
            return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def stop() -> str:
    """Ask the server to shut down, and wait briefly for it to finish."""
    global _server, _thread

    with _lock:
        if _server is None:
            return json.dumps({"stopped": False, "reason": "not running"})
        try:
            # uvicorn watches this flag and unwinds its own lifespan, which is
            # what closes the database cleanly.
            _server.should_exit = True
            if _thread is not None:
                _thread.join(timeout=5)
            alive = _thread.is_alive() if _thread else False
            _server, _thread = None, None
            return json.dumps({"stopped": True, "clean": not alive})
        except Exception as exc:
            return json.dumps({"stopped": False, "error": f"{type(exc).__name__}: {exc}"})


def health() -> str:
    """Whether the server thread is currently alive."""
    return json.dumps({"running": _thread is not None and _thread.is_alive()})
