//! Start the Python backend alongside the window, and stop it with the window.
//!
//! Without this, JARVIS is a webview pointing at a server the user has to
//! remember to start from a terminal — which is the single thing that makes an
//! installed application still feel like a development checkout. Double-click
//! the icon and it should simply work.
//!
//! A watchdog thread also keeps it running for the life of the window: if the
//! backend process dies mid-session (crash, OOM-kill, anything), the app
//! notices within a few seconds and restarts it on its own, the same way a
//! normal desktop app doesn't just go blank because one of its own worker
//! processes fell over. Without this, a mid-session crash left the UI stuck
//! on "Backend unreachable" until the user closed and reopened JARVIS —
//! `spawn` only ever ran once, at launch.
//!
//! Deliberately conservative about what it takes responsibility for:
//!
//! * If something is already answering on the port, it leaves it alone. That is
//!   the developer case — `run.ps1` already running with `--reload` — and
//!   spawning a second uvicorn would just fail to bind and litter the log. The
//!   watchdog applies the same rule on every check, so it never fights a
//!   developer's own server either.
//! * If it cannot find a Python environment it gives up quietly. The UI already
//!   handles an unreachable backend, so a missing venv should degrade to the
//!   existing "Backend unreachable" banner rather than a crash on launch.
//! * The watchdog gives up after 5 consecutive failed restart attempts, so a
//!   backend that is broken in a way restarting can't fix (a bad dependency, a
//!   corrupted venv) degrades to the same banner instead of spinning forever.
//! * The child is killed on exit, and the watchdog stops with it. A backend
//!   surviving its window is a port conflict the next time the app opens, and
//!   a mystery process holding the database.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// How often the watchdog checks that the backend is still alive.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);

/// Give up restarting after this many failed attempts in a row, so a backend
/// that is broken in a way a restart can't fix doesn't spin forever. A
/// restart that stays up gets its own fresh set of attempts (see
/// `WATCHDOG_HEALTHY_AFTER`).
const WATCHDOG_MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// How long a restarted backend has to stay up before it counts as healthy
/// again, resetting the failure count. Shorter than this and a backend that
/// starts, then immediately dies (a real, unfixable problem) would otherwise
/// look like 5 separate one-off failures instead of a spiral, and never trip
/// the giving-up threshold above.
const WATCHDOG_HEALTHY_AFTER: Duration = Duration::from_secs(10);

/// Keeps the spawned process so it can be killed on shutdown, and tells the
/// watchdog thread to stop looping once that happens.
pub struct Backend {
    child: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
}

impl Backend {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn stop(&self) {
        // Set first: otherwise the watchdog can see the child gone (we just
        // killed it) and the port free (kill hasn't fully released it yet, or
        // has), and "helpfully" restart the backend we are trying to shut down.
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
                log::info!("backend stopped");
            }
        }
    }
}

impl Default for Backend {
    fn default() -> Self {
        Self::new()
    }
}

/// Windows: don't flash a console window for the child process.
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

const PORT: u16 = 8000;

/// Whether something is already serving. Cheap, and it is the difference
/// between "start the backend" and "fight the one that is already running".
pub fn already_running() -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], PORT).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// Find `backend/` by walking up from the executable, then from the working
/// directory.
///
/// Two very different layouts have to work: a dev build living in
/// `src-tauri/target/debug/`, and an installed build in Program Files whose
/// backend sits wherever the user keeps the repo. `JARVIS_BACKEND_DIR`
/// overrides both, which is the escape hatch for an install that moved.
fn find_backend_dir() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("JARVIS_BACKEND_DIR") {
        let path = PathBuf::from(explicit);
        if path.join("main.py").is_file() {
            return Some(path);
        }
        log::warn!("JARVIS_BACKEND_DIR is set but has no main.py: {:?}", path);
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        roots.extend(exe.ancestors().map(Path::to_path_buf));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.extend(cwd.ancestors().map(Path::to_path_buf));
    }

    roots
        .into_iter()
        .map(|root| root.join("backend"))
        .find(|candidate| candidate.join("main.py").is_file())
}

/// The interpreter to run, preferring the project's virtualenv.
///
/// A bare `python` is the last resort rather than the first choice: the venv is
/// where the dependencies actually are, and a system Python would start and
/// then die on the first import, which reads to the user as "the app is broken"
/// rather than "the environment is not set up".
fn find_python(backend: &Path) -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![
            backend.join(".venv/Scripts/python.exe"),
            backend.join("venv/Scripts/python.exe"),
        ]
    } else {
        vec![
            backend.join(".venv/bin/python"),
            backend.join("venv/bin/python"),
        ]
    };

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| Some(PathBuf::from(if cfg!(windows) { "python" } else { "python3" })))
}

/// Start the backend once and record the child, if one gets spawned.
/// Returns whether a process was actually launched -- the watchdog's failure
/// counter cares about this, not just whether the port ends up serving
/// (which takes the backend a moment after this returns).
fn try_start(state: &Backend) -> bool {
    let Some(backend_dir) = find_backend_dir() else {
        log::warn!("no backend/ directory found; the UI will show it as unreachable");
        return false;
    };
    let Some(python) = find_python(&backend_dir) else {
        log::warn!("no python interpreter found for {:?}", backend_dir);
        return false;
    };

    log::info!("starting backend: {:?} in {:?}", python, backend_dir);

    let mut command = Command::new(&python);
    command
        .args([
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            &PORT.to_string(),
        ])
        .current_dir(&backend_dir)
        // Inherited pipes would fill and block the child once nothing drains
        // them; the backend writes its own log and does not need a console.
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(NO_WINDOW);

    match command.spawn() {
        Ok(child) => {
            if let Ok(mut guard) = state.child.lock() {
                *guard = Some(child);
            }
            true
        }
        Err(err) => {
            log::warn!("could not start the backend: {err}");
            false
        }
    }
}

/// Start the backend for a freshly-opened window, then keep watching it for
/// as long as the window stays open.
pub fn spawn(app: &AppHandle) {
    let state = app.state::<Backend>();
    if already_running() {
        log::info!("backend already listening on {PORT}; leaving it alone");
    } else {
        try_start(&state);
    }
    watch(app.clone());
}

/// Background loop: notice a dead backend and restart it, the way a normal
/// app recovers from one of its own worker processes crashing instead of
/// just going blank until relaunched.
fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut consecutive_failures = 0u32;
        let mut healthy_since: Option<std::time::Instant> = None;

        loop {
            std::thread::sleep(WATCHDOG_INTERVAL);

            let state = app.state::<Backend>();
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            let child_alive = state
                .child
                .lock()
                .ok()
                .and_then(|mut guard| guard.as_mut().map(|child| child.try_wait()))
                .map(|status| matches!(status, Ok(None)))
                .unwrap_or(false);

            if child_alive {
                // Reset the failure count once a restart has proven itself,
                // not the instant it starts -- a backend that starts and
                // immediately dies again should still count toward giving up.
                if healthy_since.is_none() {
                    healthy_since = Some(std::time::Instant::now());
                }
                if healthy_since.is_some_and(|since| since.elapsed() >= WATCHDOG_HEALTHY_AFTER) {
                    consecutive_failures = 0;
                }
                continue;
            }
            healthy_since = None;

            // Our own child isn't running, but something else might be —
            // another instance, or a developer's own `run.ps1`. Leave it
            // alone either way, exactly like the initial launch check does.
            if already_running() {
                continue;
            }

            if consecutive_failures >= WATCHDOG_MAX_CONSECUTIVE_FAILURES {
                // Broken in a way restarting can't fix. Keep checking in case
                // the user (or a dev server) fixes it externally, but stop
                // hammering a start command that keeps failing.
                continue;
            }

            log::warn!("backend is not responding; attempting to restart it");
            if try_start(&state) {
                consecutive_failures = 0;
            } else {
                consecutive_failures += 1;
            }
        }
    });
}
