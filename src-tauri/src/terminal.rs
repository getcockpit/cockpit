//! "Take over in terminal" (decision 13): pause the SDK session, run the real `claude --resume` for
//! the same conversation in a PTY shown in the app, and hand it back to the SDK when it exits.
//! Terminal bytes go straight to the UI (`term-data`), not into the event log.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

struct Term {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Default)]
pub struct Terminals {
    terms: Mutex<HashMap<String, Term>>,
}

/// The user's own claude, same order as the sidecar: MR_CLAUDE_PATH, ~/.local/bin, PATH.
pub fn claude_path() -> String {
    if let Ok(p) = std::env::var("MR_CLAUDE_PATH") {
        return p;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let native = format!("{home}/.local/bin/claude");
    if std::path::Path::new(&native).exists() { native } else { "claude".into() }
}

/// Runs `argv` in a PTY under `key`, streaming output as `term-data` and calling `on_exit` when it ends.
pub fn open_command_with(
    app: &AppHandle,
    key: &str,
    argv: Vec<String>,
    cwd: &str,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
    on_exit: Box<dyn FnOnce(&AppHandle) + Send>,
) -> Result<(), String> {
    let terms = app.state::<Terminals>();
    if terms.terms.lock().unwrap().contains_key(key) {
        return Ok(());
    }
    let pty = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.cwd(cwd);
    cmd.env_clear();
    for (k, v) in crate::selfbuild::child_env() {
        cmd.env(k, v);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    terms.terms.lock().unwrap().insert(key.to_owned(), Term { writer, master: pty.master });

    let (app2, k2) = (app.clone(), key.to_owned());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let _ = app2.emit("term-data", serde_json::json!({ "session": k2, "data": String::from_utf8_lossy(&buf[..n]) }));
        }
    });
    let (app3, k3) = (app.clone(), key.to_owned());
    std::thread::spawn(move || {
        let _ = child.wait();
        app3.state::<Terminals>().terms.lock().unwrap().remove(&k3);
        let _ = app3.emit("term-exit", serde_json::json!({ "session": k3 }));
        on_exit(&app3);
    });
    Ok(())
}

pub fn open_command(app: &AppHandle, key: &str, argv: Vec<String>, cwd: &str, env: Vec<(String, String)>, cols: u16, rows: u16) -> Result<(), String> {
    open_command_with(app, key, argv, cwd, env, cols, rows, Box::new(|_| {}))
}

/// Opens a terminal for `session`: stops the SDK run, then starts `claude --resume <sdk id>` in its
/// folder (and its workspace's Claude config), handing it back to the SDK on exit. `command`: a slash
/// command that needs Claude Code's own terminal (/mcp sign-in, /doctor…), run as the first input.
#[tauri::command]
pub fn term_open(app: AppHandle, session: String, sdk_session_id: String, cwd: String, cols: u16, rows: u16, command: Option<String>) -> Result<(), String> {
    if app.state::<Terminals>().terms.lock().unwrap().contains_key(&session) {
        return Ok(());
    }
    let workspace = crate::workspaces::workspace_of(&app, &session);
    let env: Vec<(String, String)> = crate::workspaces::config_dir(&app, &workspace).map(|c| vec![("CLAUDE_CONFIG_DIR".into(), c.display().to_string())]).unwrap_or_default();
    let _ = crate::sidecar::session_stop(app.state::<crate::sidecar::Sidecar>(), session.clone());
    let command = command.filter(|c| c.starts_with('/') && !c.contains('\n'));
    crate::eventlog::record(&app, Some(&session), "ui.terminal_opened", &serde_json::json!({ "sdk_session_id": sdk_session_id, "command": command }), None);
    // Let the SDK run release the conversation before the CLI picks it up.
    std::thread::sleep(std::time::Duration::from_millis(800));
    let (sid, cwd2, sdk) = (session.clone(), cwd.clone(), sdk_session_id.clone());
    let mut argv = vec![claude_path(), "--resume".into(), sdk_session_id];
    argv.extend(command);
    open_command_with(&app, &session, argv, &cwd, env, cols, rows, Box::new(move |app: &AppHandle| {
        crate::eventlog::record(app, Some(&sid), "ui.terminal_closed", &serde_json::json!({}), None);
        let _ = crate::sidecar::session_start(
            app.clone(), app.state::<crate::sidecar::Sidecar>(), cwd2,
            "I'm back from the terminal. Say in one line what changed there, then continue.".into(),
            Some(sdk), None, None, Some(false), Some(sid), Some(workspace), None, None
        );
    }))
}

#[tauri::command]
pub fn term_write(terms: State<'_, Terminals>, session: String, data: String) -> Result<(), String> {
    let mut map = terms.terms.lock().unwrap();
    let t = map.get_mut(&session).ok_or("no terminal")?;
    t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(terms: State<'_, Terminals>, session: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = terms.terms.lock().unwrap();
    let t = map.get(&session).ok_or("no terminal")?;
    t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)] // on Windows `bash` can resolve to the WSL stub
    #[test]
    fn a_pty_runs_a_command_and_streams_its_output() {
        let pty = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("bash");
        cmd.args(["-c", "echo mr-pty-ok; sleep 1"]);
        let _child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = String::new();
            let mut buf = [0u8; 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
                if out.contains("mr-pty-ok") { let _ = tx.send(out.clone()); break; }
            }
        });
        let out = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("no PTY output within 5s");
        assert!(out.contains("mr-pty-ok"), "{out}");
    }
}
