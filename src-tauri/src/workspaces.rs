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
            link(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn link(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

/// Windows symlinks need Developer Mode; without it, copy instead (changes then don't flow back).
#[cfg(windows)]
fn link(src: &Path, dst: &Path) -> std::io::Result<()> {
    let linked = if src.is_dir() { std::os::windows::fs::symlink_dir(src, dst) } else { std::os::windows::fs::symlink_file(src, dst) };
    linked.or_else(|_| copy_all(src, dst))
}

#[cfg(windows)]
fn copy_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.is_dir() {
        return std::fs::copy(src, dst).map(|_| ());
    }
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        copy_all(&e.path(), &dst.join(e.file_name()))?;
    }
    Ok(())
}

/// The user's home folder. Not `$HOME`: Windows doesn't set it (USERPROFILE instead), which made
/// every workspace action fail there.
pub fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "couldn't find your home folder".to_string())
}

/// Personal, or a workspace whose folder is still there (deleting one moves it to the Trash).
pub fn exists(app: &AppHandle, workspace: &str) -> bool {
    config_dir(app, workspace).is_none_or(|c| c.is_dir())
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
    let home = home()?.join(".claude");
    prepare_config_dir(&config, &home).map_err(|e| e.to_string())?;
    crate::eventlog::record(&app, None, "ui.workspace_created", &serde_json::json!({ "id": id, "name": name, "config_dir": config }), Some(&format!("workspace:{id}")));
    Ok(id)
}

#[tauri::command]
pub fn workspace_rename(app: AppHandle, id: String, name: String) -> Result<(), String> {
    crate::eventlog::record(&app, None, "ui.workspace_renamed", &serde_json::json!({ "id": id, "name": name.trim() }), Some(&format!("workspace:{id}")));
    Ok(())
}

/// The tab order after a drag in the top bar (MR-84): the full list of ids, left to right.
#[tauri::command]
pub fn workspace_reorder(app: AppHandle, order: Vec<String>) -> Result<(), String> {
    crate::eventlog::record(&app, None, "ui.workspaces_reordered", &serde_json::json!({ "order": order }), None);
    Ok(())
}

/// A workspace's rectangle dragged on the Overview canvas (decision 40): its new top-left, in canvas units.
#[tauri::command]
pub fn overview_move(app: AppHandle, workspace: String, x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("not a position".into());
    }
    crate::eventlog::record(&app, None, "ui.overview_moved", &serde_json::json!({ "workspace": workspace, "x": x.round(), "y": y.round() }), Some(&format!("workspace:{workspace}")));
    Ok(())
}

/// "Tidy up" on the Overview (MR-157): forget every dragged spot, so the workspaces go back to the
/// auto grid. Undo re-sends the old spots as `overview_move`s.
#[tauri::command]
pub fn overview_tidy(app: AppHandle) -> Result<(), String> {
    crate::eventlog::record(&app, None, "ui.overview_tidied", &serde_json::json!({}), None);
    Ok(())
}

/// Pins the folder new sessions in this workspace start in (MR-65); `None` unpins, so the picker
/// falls back to the last folder a session started in there.
#[tauri::command(async)]
pub fn workspace_set_folder(app: AppHandle, id: String, folder: Option<String>) -> Result<(), String> {
    let folder = match folder.map(|f| f.trim().to_owned()).filter(|f| !f.is_empty()) {
        Some(f) => {
            let full = crate::sidecar::expand_home(&app, &f);
            if !Path::new(&full).is_dir() {
                return Err(format!("{f} isn't a folder"));
            }
            Some(full)
        }
        None => None,
    };
    crate::eventlog::record(&app, None, "ui.workspace_folder_set", &serde_json::json!({ "id": id, "folder": folder }), Some(&format!("workspace:{id}")));
    Ok(())
}

/// Moves a folder to the macOS Trash (recoverable), named so it's recognisable there.
pub fn to_trash(dir: &Path, label: &str, home: &Path) -> Result<Option<PathBuf>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    let trash = home.join(".Trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let safe: String = label.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let dest = trash.join(format!("Cockpit workspace {safe} {}", chrono_free_stamp()));
    std::fs::rename(dir, &dest).map_err(|e| format!("couldn't move it to the Trash: {e}"))?;
    Ok(Some(dest))
}

fn chrono_free_stamp() -> String {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default()
}

/// Deletes a workspace (MR-54): stops its running sessions, moves its folder (its own Claude
/// sign-in, memory and transcripts) to the Trash, and logs it; its sessions become read-only
/// history in Personal's archive. Personal can't be deleted.
#[tauri::command(async)]
pub fn workspace_delete(app: AppHandle, id: String, name: String) -> Result<(), String> {
    if id == PERSONAL || id.is_empty() {
        return Err("the Personal workspace can't be deleted".into());
    }
    let stopped = crate::sidecar::stop_sessions_in(&app, &id);
    let home = home()?;
    let folder = crate::selfbuild::data_dir(&app).join("workspaces").join(&id);
    let trashed = to_trash(&folder, &name, &home)?;
    crate::eventlog::record(&app, None, "ui.workspace_deleted", &serde_json::json!({ "id": id, "name": name, "stopped": stopped, "trashed_to": trashed }), Some(&format!("workspace:{id}")));
    Ok(())
}

/// Signs a workspace in: runs Claude Code's own `claude auth login` in its config folder (the
/// browser sign-in; it exits by itself once done, so nothing needs typing). Personal signs in to
/// your normal Claude Code config; other workspaces to their own folder.
#[tauri::command]
pub fn workspace_sign_in(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<String, String> {
    let env = config_dir(&app, &id).map(|c| vec![("CLAUDE_CONFIG_DIR".to_string(), c.display().to_string())]).unwrap_or_default();
    let key = format!("login:{id}");
    crate::eventlog::record(&app, None, "ui.sign_in_opened", &serde_json::json!({ "workspace": id }), Some(&format!("workspace:{id}")));
    crate::terminal::open_command(&app, &key, sign_in_argv(crate::terminal::claude_path()), &home().map(|h| h.display().to_string()).unwrap_or_default(), env, cols, rows)?;
    Ok(key)
}

fn sign_in_argv(claude: String) -> Vec<String> {
    vec![claude, "auth".into(), "login".into(), "--claudeai".into()]
}

/// Whether Claude Code is signed in for this workspace, from `claude auth status --json`: checked
/// after the sign-in terminal closes, so the refused message only goes again once it took.
#[tauri::command(async)]
pub fn workspace_auth_status(app: AppHandle, id: String) -> Result<bool, String> {
    let mut cmd = crate::sys::cmd(crate::terminal::claude_path());
    cmd.args(["auth", "status", "--json"]).env_clear().envs(crate::selfbuild::child_env()).stdin(std::process::Stdio::null());
    if let Some(dir) = config_dir(&app, &id) {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    let out = cmd.output().map_err(|e| format!("couldn't run claude: {e}"))?;
    let signed_in = logged_in(&String::from_utf8_lossy(&out.stdout));
    crate::eventlog::record(&app, None, "ui.sign_in_checked", &serde_json::json!({ "workspace": id, "signed_in": signed_in }), Some(&format!("workspace:{id}")));
    Ok(signed_in)
}

fn logged_in(status_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(status_json).ok().and_then(|v| v["loggedIn"].as_bool()).unwrap_or(false)
}

/// Which workspace a session belongs to, from the log: where it was last moved to (MR-154), else
/// where it was requested (default: personal).
pub fn workspace_of(app: &AppHandle, session: &str) -> String {
    let evs = app.state::<crate::eventlog::EventLog>().list(Some(session), None, 100_000).unwrap_or_default();
    workspace_in(&evs)
}

pub fn workspace_in(evs: &[crate::eventlog::Event]) -> String {
    evs.iter()
        .rev()
        .find_map(|e| match e.kind.as_str() {
            "ui.session_moved" => e.payload["to"].as_str(),
            "ui.session_requested" => Some(e.payload["workspace"].as_str().unwrap_or(PERSONAL)),
            _ => None,
        })
        .unwrap_or(PERSONAL)
        .to_owned()
}

/// Claude Code's own folder for a workspace: its config folder, or the normal one for Personal.
pub fn claude_home(app: &AppHandle, workspace: &str) -> Result<PathBuf, String> {
    if let Some(dir) = config_dir(app, workspace) {
        return Ok(dir);
    }
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(home()?.join(".claude"))
}

/// Copies one conversation's transcript (`projects/<folder>/<sdk>.jsonl`, plus its `<sdk>/` folder
/// of subagent and tool output) from one Claude folder to another, so `--resume` finds it there.
/// The source keeps its copy. Returns how many transcripts it copied (0: nothing to copy yet).
pub fn copy_transcript(from: &Path, to: &Path, sdk: &str) -> Result<usize, String> {
    if sdk.is_empty() || sdk.contains(['/', '\\']) || sdk.contains("..") {
        return Err("bad session id".into());
    }
    let Ok(dirs) = std::fs::read_dir(from.join("projects")) else { return Ok(0) };
    let mut copied = 0;
    for dir in dirs.flatten() {
        let file = dir.path().join(format!("{sdk}.jsonl"));
        if !file.is_file() {
            continue;
        }
        let dest = to.join("projects").join(dir.file_name());
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        std::fs::copy(&file, dest.join(format!("{sdk}.jsonl"))).map_err(|e| format!("couldn't copy the conversation: {e}"))?;
        let extra = dir.path().join(sdk);
        if extra.is_dir() {
            copy_tree(&extra, &dest.join(sdk)).map_err(|e| format!("couldn't copy the conversation: {e}"))?;
        }
        copied += 1;
    }
    Ok(copied)
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let (from, to) = (e.path(), dst.join(e.file_name()));
        if e.file_type()?.is_dir() { copy_tree(&from, &to)? } else { std::fs::copy(&from, &to).map(|_| ())? }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn sign_in_runs_claude_auth_login() {
        assert_eq!(super::sign_in_argv("claude".into()), ["claude", "auth", "login", "--claudeai"]);
    }

    #[test]
    fn reads_auth_status() {
        assert!(super::logged_in(r#"{"loggedIn": true, "authMethod": "claude.ai"}"#));
        assert!(!super::logged_in(r#"{"loggedIn": false, "authMethod": "none"}"#));
        assert!(!super::logged_in("error: not json"));
    }

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

    #[test]
    fn moving_copies_the_conversation_into_the_other_claude_folder() {
        let root = std::env::temp_dir().join(format!("mr-move-{}", ulid::Ulid::new()));
        let (from, to) = (root.join("a"), root.join("b"));
        let proj = from.join("projects/-Users-x-repo");
        std::fs::create_dir_all(proj.join("abc/subagents")).unwrap();
        std::fs::write(proj.join("abc.jsonl"), "turns").unwrap();
        std::fs::write(proj.join("abc/subagents/agent-1.jsonl"), "sub").unwrap();
        std::fs::write(proj.join("other.jsonl"), "not this one").unwrap();
        assert_eq!(copy_transcript(&from, &to, "abc").unwrap(), 1);
        let dest = to.join("projects/-Users-x-repo");
        assert_eq!(std::fs::read_to_string(dest.join("abc.jsonl")).unwrap(), "turns");
        assert_eq!(std::fs::read_to_string(dest.join("abc/subagents/agent-1.jsonl")).unwrap(), "sub");
        assert!(!dest.join("other.jsonl").exists());
        assert!(proj.join("abc.jsonl").exists(), "the source keeps its copy");
        assert_eq!(copy_transcript(&from, &to, "missing").unwrap(), 0);
        assert_eq!(copy_transcript(&root.join("nowhere"), &to, "abc").unwrap(), 0);
        assert!(copy_transcript(&from, &to, "../abc").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_last_move_decides_the_workspace() {
        let ev = |kind: &str, payload: serde_json::Value| crate::eventlog::Event { id: String::new(), session_id: Some("s".into()), kind: kind.into(), payload, anchor: None, created_at: 0, origin: None };
        let mut evs = vec![ev("ui.session_requested", serde_json::json!({ "workspace": "ws_a" }))];
        assert_eq!(workspace_in(&evs), "ws_a");
        evs.push(ev("ui.session_moved", serde_json::json!({ "from": "ws_a", "to": "personal" })));
        evs.push(ev("sidecar.sdk", serde_json::json!({})));
        assert_eq!(workspace_in(&evs), "personal");
        evs.push(ev("ui.session_requested", serde_json::json!({ "workspace": "personal", "resume": "x" })));
        assert_eq!(workspace_in(&evs), "personal");
        assert_eq!(workspace_in(&[]), PERSONAL);
    }

    #[test]
    fn deleting_moves_the_folder_to_the_trash() {
        let home = std::env::temp_dir().join(format!("mr-trash-{}", ulid::Ulid::new()));
        let ws = home.join("data/workspaces/ws_x");
        std::fs::create_dir_all(ws.join("claude")).unwrap();
        std::fs::write(ws.join("claude/.credentials.json"), "x").unwrap();
        let dest = to_trash(&ws, "Client A", &home).unwrap().unwrap();
        assert!(!ws.exists());
        assert!(dest.starts_with(home.join(".Trash")) && dest.join("claude/.credentials.json").exists());
        assert_eq!(to_trash(&ws, "Client A", &home).unwrap(), None);
        let _ = std::fs::remove_dir_all(&home);
    }
}
