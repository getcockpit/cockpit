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

/// Opens a terminal for `session`: stops the SDK run, then starts `claude --resume <sdk id>` in its folder.
#[tauri::command]
pub fn term_open(app: AppHandle, terms: State<'_, Terminals>, session: String, sdk_session_id: String, cwd: String, cols: u16, rows: u16) -> Result<(), String> {
    if terms.terms.lock().unwrap().contains_key(&session) {
        return Ok(());
    }
    let _ = crate::sidecar::session_stop(app.state::<crate::sidecar::Sidecar>(), session.clone());
    crate::eventlog::record(&app, Some(&session), "ui.terminal_opened", &serde_json::json!({ "sdk_session_id": sdk_session_id }), None);
    // Let the SDK run release the conversation before the CLI picks it up.
    std::thread::sleep(std::time::Duration::from_millis(800));

    let pty = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(claude_path());
    cmd.args(["--resume", &sdk_session_id]);
    cmd.cwd(&cwd);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    terms.terms.lock().unwrap().insert(session.clone(), Term { writer, master: pty.master });

    let (app2, sid) = (app.clone(), session.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let _ = app2.emit("term-data", serde_json::json!({ "session": sid, "data": String::from_utf8_lossy(&buf[..n]) }));
        }
    });
    let (app3, sid3, cwd3) = (app.clone(), session, cwd);
    std::thread::spawn(move || {
        let _ = child.wait();
        app3.state::<Terminals>().terms.lock().unwrap().remove(&sid3);
        crate::eventlog::record(&app3, Some(&sid3), "ui.terminal_closed", &serde_json::json!({}), None);
        let _ = app3.emit("term-exit", serde_json::json!({ "session": sid3 }));
        // Hand the conversation back to the app.
        let _ = crate::sidecar::session_start(
            app3.clone(), app3.state::<crate::sidecar::Sidecar>(), cwd3,
            "I'm back from the terminal. Say in one line what changed there, then continue.".into(),
            Some(sdk_session_id), None, None, Some(false), Some(sid3),
        );
    });
    Ok(())
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
