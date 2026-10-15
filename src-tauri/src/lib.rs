mod attachments;
mod brief;
mod changes;
mod cockpit_layer;
mod daily;
mod docs;
mod eventlog;
mod flows;
mod gh;
mod instances;
mod folders;
mod layer3;
mod mentions;
mod files;
mod layer2;
mod migrate;
mod notify;
mod personal;
mod release_update;
mod runs;
mod selfbuild;
mod selftest;
mod sidecar;
mod terminal;
mod update;
mod usage;
mod views;
mod voice;
mod workspaces;
mod worktree;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Opened from Finder, the app inherits launchd's /usr/bin:/bin:/usr/sbin:/sbin, so git hooks
    // (git-lfs) and Claude's own Bash miss Homebrew tools. Fix it once, before any thread spawns.
    // Windows GUI apps already get the user's PATH.
    #[cfg(unix)]
    {
        let path = full_path(&std::env::var("PATH").unwrap_or_default(), login_path().as_deref());
        // SAFETY: single-threaded here; nothing else reads the environment yet.
        unsafe { std::env::set_var("PATH", path) };
    }
    // Before anything opens the data folder or a webview: the identifier changed (MR-135).
    migrate::run();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(sidecar::Sidecar::default())
        .manage(terminal::Terminals::default())
        .manage(voice::Voice::default())
        .manage(runs::Runs::default())
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
            app.manage(usage::Usage::open(&dir.join("events.sqlite"))?);
            app.manage(log);
            app.manage(docs);
            // Before app.started: copies that died since are reported first (MR-99).
            instances::start(app.handle(), &dir);
            update::on_start(app.handle());
            release_update::on_start(app.handle());
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
            sidecar::session_set_model,
            sidecar::permission_mode_set,
            sidecar::session_commands,
            sidecar::session_mcp_status,
            sidecar::session_mcp_action,
            sidecar::models_refresh,
            sidecar::session_stop,
            sidecar::permission_respond,
            sidecar::tool_result,
            eventlog::event_append,
            eventlog::events_list,
            gh::gh_prs,
            gh::gh_repo,
            gh::gh_review_state,
            docs::docs_list,
            daily::daily_driver,
            changes::session_changes,
            changes::session_diff,
            changes::task_output,
            runs::run_command,
            runs::run_stop,
            runs::run_output,
            changes::app_repo_path,
            changes::godmode_save_mark,
            selfbuild::selfbuild_start,
            selfbuild::selfbuild_list,
            selfbuild::selfbuild_relaunch,
            update::update_status,
            update::update_start,
            update::update_restart,
            release_update::release_status,
            release_update::release_check,
            release_update::release_install,
            release_update::release_choose,
            release_update::release_seen,
            personal::personal_history,
            personal::fix_apply,
            personal::personal_sync,
            layer2::layer2_classify,
            cockpit_layer::cockpit_save_key,
            cockpit_layer::cockpit_status,
            layer3::layer3_diagram,
            sidecar::limits_refresh,
            gh::pr_repo,
            folders::recent_folders,
            mentions::session_paths,
            files::files_exist,
            attachments::attachment_save,
            attachments::attachment_info,
            attachments::attachment_read,
            files::file_reveal,
            layer2::layer2_status,
            layer2::layer2_save_credentials,
            personal::personal_apply,
            personal::personal_revert,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            notify::notify,
            voice::voice_start,
            voice::voice_stop,
            workspaces::workspace_create,
            workspaces::workspace_rename,
            workspaces::workspace_reorder,
            workspaces::workspace_set_folder,
            workspaces::workspace_delete,
            sidecar::session_move,
            workspaces::workspace_sign_in,
            docs::doc_feedback,
            brief::brief_start,
            brief::brief_continue,
            docs::doc_archive,
            docs::doc_build_started,
            docs::doc_check_shipped,
            docs::doc_mark_shipped,
            usage::usage_track,
            usage::usage_report,
            instances::instance_id
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                instances::stop(app);
            }
        });
}

#[cfg(unix)]
/// The login shell's PATH, if it answers within a few seconds (a slow rc file must not block launch).
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = std::process::Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let start = std::time::Instant::now();
    while child.try_wait().ok()?.is_none() {
        if start.elapsed() > std::time::Duration::from_secs(3) {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out.trim().to_owned()).filter(|p| !p.is_empty())
}

#[cfg_attr(not(unix), allow(dead_code))]
/// Login PATH first, then the inherited one, then the tool dirs scripts rely on; no duplicates.
fn full_path(current: &str, login: Option<&str>) -> String {
    let base = selfbuild::sh_path();
    let mut seen = std::collections::HashSet::new();
    [login.unwrap_or(""), current, base.as_str()]
        .iter()
        .flat_map(|p| p.split(':'))
        .filter(|d| !d.is_empty() && seen.insert(*d))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod path_tests {
    use super::full_path;

    #[test]
    fn adds_homebrew_and_keeps_order_without_duplicates() {
        let p = full_path("/usr/bin:/bin", Some("/custom/bin:/usr/bin"));
        let dirs: Vec<&str> = p.split(':').collect();
        assert_eq!(&dirs[..3], &["/custom/bin", "/usr/bin", "/bin"]);
        assert!(dirs.contains(&"/opt/homebrew/bin"));
        assert_eq!(dirs.iter().filter(|d| **d == "/usr/bin").count(), 1);
    }

    #[test]
    fn works_without_a_login_shell() {
        assert!(full_path("/usr/bin:/bin", None).split(':').any(|d| d == "/opt/homebrew/bin"));
    }
}
