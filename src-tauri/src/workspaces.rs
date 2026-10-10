//! Workspaces (decision 24): tabs whose sessions, docs and Claude memory never overlap.
//! "personal" uses the normal ~/.claude. Every other workspace gets its own CLAUDE_CONFIG_DIR, so
//! Claude Code keeps its projects/ (memory + transcripts), sessions and history separate, while the
//! user's own commands, skills, settings and CLAUDE.md are linked in. A new workspace signs in once.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

pub const PERSONAL: &str = "personal";

/// What every workspace shares with ~/.claude (behaviour), as opposed to what it keeps apart (state).
pub const SHARED: [&str; 9] = ["CLAUDE.md", "commands", "skills", "agents", "hooks", "plugins", "settings.json", "output-styles", "keybindings.json"];

/// Creates `<config>` and links the shared pieces from `home_claude`. Never copies credentials.
pub fn prepare_config_dir(config: &Path, home_claude: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(config)?;
    for name in SHARED {
        let src = home_claude.join(name);
        let dst = config.join(name);
        if src.exists() && std::fs::symlink_metadata(&dst).is_err() {
            std::os::unix::fs::symlink(&src, &dst)?;
        }
    }
    Ok(())
}

pub fn config_dir(app: &AppHandle, workspace: &str) -> Option<PathBuf> {
    if workspace == PERSONAL || workspace.is_empty() {
        return None;
    }
    Some(crate::selfbuild::data_dir(app).join("workspaces").join(workspace).join("claude"))
}

// Off the main thread: it does I/O, and a sync command would freeze the UI (MR-57).
#[tauri::command(async)]
pub fn workspace_create(app: AppHandle, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("give the workspace a name".into());
    }
    let id = format!("ws_{}", &ulid::Ulid::new().to_string()[16..].to_lowercase());
    let config = config_dir(&app, &id).ok_or("bad id")?;
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".claude");
    prepare_config_dir(&config, &home).map_err(|e| e.to_string())?;
    crate::eventlog::record(&app, None, "ui.workspace_created", &serde_json::json!({ "id": id, "name": name, "config_dir": config }), Some(&format!("workspace:{id}")));
    Ok(id)
}

#[tauri::command]
pub fn workspace_rename(app: AppHandle, id: String, name: String) -> Result<(), String> {
    crate::eventlog::record(&app, None, "ui.workspace_renamed", &serde_json::json!({ "id": id, "name": name.trim() }), Some(&format!("workspace:{id}")));
    Ok(())
}

/// Opens an interactive `claude` in this workspace's config folder so the user can run /login once.
#[tauri::command]
pub fn workspace_sign_in(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<String, String> {
    // Personal signs in to your normal Claude Code config; other workspaces to their own folder.
    let env = config_dir(&app, &id).map(|c| vec![("CLAUDE_CONFIG_DIR".to_string(), c.display().to_string())]).unwrap_or_default();
    let key = format!("login:{id}");
    crate::terminal::open_command(&app, &key, vec![crate::terminal::claude_path()], &std::env::var("HOME").unwrap_or_default(), env, cols, rows)?;
    Ok(key)
}

/// Which workspace a session belongs to, from its request in the log (default: personal).
pub fn workspace_of(app: &AppHandle, session: &str) -> String {
    app.state::<crate::eventlog::EventLog>()
        .list(Some(session), None, 50)
        .ok()
        .and_then(|evs| evs.into_iter().find(|e| e.kind == "ui.session_requested").and_then(|e| e.payload["workspace"].as_str().map(str::to_owned)))
        .unwrap_or_else(|| PERSONAL.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_links_shared_behaviour_but_keeps_its_own_state() {
        let root = std::env::temp_dir().join(format!("mr-ws-{}", ulid::Ulid::new()));
        let home = root.join("home/.claude");
        std::fs::create_dir_all(home.join("commands")).unwrap();
        std::fs::create_dir_all(home.join("projects/-Users-x-repo/memory")).unwrap();
        std::fs::write(home.join("CLAUDE.md"), "rules").unwrap();
        std::fs::write(home.join("settings.json"), "{}").unwrap();
        std::fs::write(home.join("history.jsonl"), "secret history").unwrap();
        let ws = root.join("ws/claude");
        prepare_config_dir(&ws, &home).unwrap();
        assert_eq!(std::fs::read_to_string(ws.join("CLAUDE.md")).unwrap(), "rules");
        assert!(ws.join("commands").is_dir());
        assert!(!ws.join("projects").exists(), "memories and transcripts must not be shared");
        assert!(!ws.join("history.jsonl").exists());
        // Idempotent.
        prepare_config_dir(&ws, &home).unwrap();
    }
}
