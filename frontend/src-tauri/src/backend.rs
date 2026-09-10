//! Start the Python backend alongside the window, and stop it with the window.
//!
//! Without this, JARVIS is a webview pointing at a server the user has to
//! remember to start from a terminal — which is the single thing that makes an
//! installed application still feel like a development checkout. Double-click
//! the icon and it should simply work.
//!
//! Deliberately conservative about what it takes responsibility for:
//!
//! * If something is already answering on the port, it leaves it alone. That is
//!   the developer case — `run.ps1` already running with `--reload` — and
//!   spawning a second uvicorn would just fail to bind and litter the log.
//! * If it cannot find a Python environment it gives up quietly. The UI already
//!   handles an unreachable backend, so a missing venv should degrade to the
//!   existing "Backend unreachable" banner rather than a crash on launch.
//! * The child is killed on exit. A backend surviving its window is a port
//!   conflict the next time the app opens, and a mystery process holding the
//!   database.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Keeps the spawned process so it can be killed on shutdown.
pub struct Backend(Mutex<Option<Child>>);

impl Backend {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.0.lock() {
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

pub fn spawn(state: &Backend) {
    if already_running() {
        log::info!("backend already listening on {PORT}; leaving it alone");
        return;
    }

    let Some(backend_dir) = find_backend_dir() else {
        log::warn!("no backend/ directory found; the UI will show it as unreachable");
        return;
    };
    let Some(python) = find_python(&backend_dir) else {
        log::warn!("no python interpreter found for {:?}", backend_dir);
        return;
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
            if let Ok(mut guard) = state.0.lock() {
                *guard = Some(child);
            }
        }
        Err(err) => log::warn!("could not start the backend: {err}"),
    }
}
