mod backend;

use backend::Backend;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Desktop only. On Android the backend runs in-process via Chaquopy, and a
    // second instance is not a thing the OS lets happen anyway.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Clicking the taskbar icon while JARVIS is already open should
            // raise the window it already has, not start a second copy that
            // fights the first one for port 8000.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .manage(Backend::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(desktop)]
            backend::spawn(&app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window ends the app, so the backend has to go with
            // it. Without this it keeps the port and the database open, and the
            // next launch finds something already listening and declines to
            // start its own.
            if let WindowEvent::Destroyed = event {
                window.app_handle().state::<Backend>().stop();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                app.state::<Backend>().stop();
            }
        });
}
