//! Supervises the SDK sidecar: one child process speaking NDJSON over stdio.
//! Every line the sidecar prints is first appended to the event log, then forwarded to the UI
//! (as the stored event on `mr-event`, and raw on `sidecar`).

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
                        let kind = format!("sidecar.{}", payload["type"].as_str().unwrap_or("unknown"));
                        let session = payload["session"].as_str().map(str::to_owned);
                        crate::eventlog::record(&handle, session.as_deref(), &kind, &payload, None);
                        let _ = handle.emit("sidecar", payload);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    let payload = serde_json::json!({ "type": "terminated", "code": status.code });
                    crate::eventlog::record(&handle, None, "sidecar.terminated", &payload, None);
                    let _ = handle.emit("sidecar", payload);
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

/// Starts a Claude Code session in `cwd`; returns the app's session id (a ULID).
#[tauri::command]
pub fn session_start(
    state: State<'_, Sidecar>,
    cwd: String,
    prompt: String,
    resume: Option<String>,
    tools: Option<serde_json::Value>,
) -> Result<String, String> {
    let session = ulid::Ulid::new().to_string();
    let mut msg = serde_json::json!({ "type": "start", "session": session, "cwd": cwd, "prompt": prompt });
    if let Some(r) = resume {
        msg["resume"] = r.into();
    }
    if let Some(t) = tools {
        msg["tools"] = t;
    }
    sidecar_send(state, msg)?;
    Ok(session)
}

#[tauri::command]
pub fn session_send(state: State<'_, Sidecar>, session: String, text: String) -> Result<(), String> {
    sidecar_send(state, serde_json::json!({ "type": "send", "session": session, "text": text }))
}

#[tauri::command]
pub fn session_interrupt(state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    sidecar_send(state, serde_json::json!({ "type": "interrupt", "session": session }))
}

#[tauri::command]
pub fn session_stop(state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    sidecar_send(state, serde_json::json!({ "type": "stop", "session": session }))
}

/// Answers a permission request: `decision` is `{behavior:"allow", updatedInput?}` or `{behavior:"deny", message}`.
#[tauri::command]
pub fn permission_respond(
    state: State<'_, Sidecar>,
    session: String,
    request_id: String,
    decision: serde_json::Value,
) -> Result<(), String> {
    sidecar_send(
        state,
        serde_json::json!({ "type": "permission_response", "session": session, "request_id": request_id, "decision": decision }),
    )
}

#[tauri::command]
pub fn tool_result(
    state: State<'_, Sidecar>,
    session: String,
    call_id: String,
    text: String,
    is_error: Option<bool>,
) -> Result<(), String> {
    sidecar_send(
        state,
        serde_json::json!({ "type": "tool_result", "session": session, "call_id": call_id, "text": text, "is_error": is_error.unwrap_or(false) }),
    )
}
