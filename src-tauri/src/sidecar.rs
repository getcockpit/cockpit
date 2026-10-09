//! Supervises the SDK sidecar: one child process speaking NDJSON over stdio.
//! Every line the sidecar prints is forwarded to the UI as a `sidecar` event.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
}

pub fn start(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (mut rx, child) = app.shell().sidecar("mr-sidecar")?.spawn()?;
    *app.state::<Sidecar>().child.lock().unwrap() = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    // stdout may arrive in chunks; forward complete lines only.
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(i) = buf.find('\n') {
                        let line: String = buf.drain(..=i).collect();
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let payload = serde_json::from_str::<serde_json::Value>(line)
                            .unwrap_or_else(|_| serde_json::json!({ "type": "raw", "line": line }));
                        let _ = handle.emit("sidecar", payload);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    let _ = handle.emit("sidecar", serde_json::json!({ "type": "terminated", "code": status.code }));
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Sends one JSON message to the sidecar as a single NDJSON line.
#[tauri::command]
pub fn sidecar_send(state: State<'_, Sidecar>, message: serde_json::Value) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("sidecar is not running")?;
    let mut line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    line.push('\n');
    child.write(line.as_bytes()).map_err(|e| e.to_string())
}
