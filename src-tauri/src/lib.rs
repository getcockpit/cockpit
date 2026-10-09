mod eventlog;
mod gh;
mod selftest;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar::Sidecar::default())
        .setup(|app| {
            // MR_DATA_DIR keeps tests and self-builds away from the real event log.
            let dir = match std::env::var("MR_DATA_DIR") {
                Ok(d) if !d.is_empty() => std::path::PathBuf::from(d),
                _ => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            app.manage(eventlog::EventLog::open(&dir.join("events.sqlite"))?);
            sidecar::start(app.handle())?;
            if selftest::enabled() {
                selftest::run(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::sidecar_send,
            sidecar::session_start,
            sidecar::session_send,
            sidecar::session_interrupt,
            sidecar::session_stop,
            sidecar::permission_respond,
            sidecar::tool_result,
            eventlog::event_append,
            eventlog::events_list,
            gh::gh_prs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
