mod changes;
mod daily;
mod docs;
mod eventlog;
mod flows;
mod gh;
mod folders;
mod layer3;
mod layer2;
mod personal;
mod selfbuild;
mod selftest;
mod sidecar;
mod terminal;
mod voice;
mod workspaces;
mod worktree;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar::Sidecar::default())
        .manage(terminal::Terminals::default())
        .manage(voice::Voice::default())
        .setup(|app| {
            // MR_DATA_DIR keeps tests and self-builds away from the real event log.
            let dir = match std::env::var("MR_DATA_DIR") {
                Ok(d) if !d.is_empty() => std::path::PathBuf::from(d),
                _ => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            let log = eventlog::EventLog::open(&dir.join("events.sqlite"))?;
            // Rebuild docs by replaying the log; afterwards record() keeps them current.
            let docs = docs::Docs::default();
            for ev in log.list(None, None, i64::MAX)? {
                docs.apply(&ev);
            }
            app.manage(log);
            app.manage(docs);
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
            gh::gh_prs,
            docs::docs_list,
            daily::daily_driver,
            changes::session_changes,
            changes::session_diff,
            changes::app_repo_path,
            changes::godmode_save_mark,
            selfbuild::selfbuild_start,
            selfbuild::selfbuild_list,
            selfbuild::selfbuild_relaunch,
            personal::personal_history,
            personal::fix_apply,
            personal::personal_sync,
            layer2::layer2_classify,
            layer3::layer3_diagram,
            sidecar::limits_refresh,
            gh::pr_repo,
            folders::recent_folders,
            layer2::layer2_status,
            layer2::layer2_save_credentials,
            personal::personal_apply,
            personal::personal_revert,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            voice::voice_start,
            voice::voice_stop,
            workspaces::workspace_create,
            workspaces::workspace_rename,
            workspaces::workspace_sign_in,
            docs::doc_feedback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
