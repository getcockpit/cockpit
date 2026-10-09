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
    /// App session ids currently running in the sidecar (for the cap).
    live: Mutex<std::collections::HashSet<String>>,
}

fn session_cap() -> usize {
    std::env::var("MR_SESSION_CAP").ok().and_then(|v| v.parse().ok()).unwrap_or(6)
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
                        if payload["type"] == "session_ended" {
                            if let Some(id) = payload["session"].as_str() {
                                handle.state::<Sidecar>().live.lock().unwrap().remove(id);
                            }
                        }
                        if payload["type"] == "tool_call" {
                            answer_tool_call(&handle, &payload);
                        }
                        if crate::selftest::enabled() {
                            crate::selftest::on_message(&handle, &payload);
                        }
                        let _ = handle.emit("sidecar", payload);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    handle.state::<Sidecar>().live.lock().unwrap().clear();
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

/// Starts (or resumes) a Claude Code session; returns the app's session id (a ULID).
/// Blank sessions in a git repo get their own worktree unless `worktree` is false (decision 7).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn session_start(
    app: AppHandle,
    state: State<'_, Sidecar>,
    cwd: String,
    prompt: String,
    resume: Option<String>,
    tools: Option<serde_json::Value>,
    kind: Option<String>,
    worktree: Option<bool>,
    session_id: Option<String>,
) -> Result<String, String> {
    let mut cwd = expand_home(&app, &cwd);
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("not a folder: {cwd}"));
    }
    {
        let live = state.live.lock().unwrap();
        if live.len() >= session_cap() {
            return Err(format!("{} sessions are already running (the cap). Finish or stop one first.", live.len()));
        }
    }
    let kind = kind.unwrap_or_else(|| "blank".into());
    let session = session_id.unwrap_or_else(|| ulid::Ulid::new().to_string());
    let mut extra = serde_json::json!({});
    let wants_tree = worktree.unwrap_or(kind == "blank" && resume.is_none());
    if wants_tree && crate::worktree::repo_root(std::path::Path::new(&cwd)).is_some() {
        let wt = crate::worktree::create(std::path::Path::new(&cwd), &prompt, &session)?;
        extra = serde_json::json!({ "repo": wt.repo, "worktree": wt.path, "branch": wt.branch });
        cwd = wt.path.display().to_string();
    }
    let mut payload = serde_json::json!({ "cwd": cwd, "prompt": prompt, "resume": resume, "kind": kind });
    if let (Some(p), Some(e)) = (payload.as_object_mut(), extra.as_object()) {
        p.extend(e.clone());
    }
    crate::eventlog::record(&app, Some(&session), "ui.session_requested", &payload, None);
    let mut msg = serde_json::json!({ "type": "start", "session": session, "cwd": cwd, "prompt": prompt });
    if let Some(r) = resume {
        msg["resume"] = r.into();
    }
    msg["tools"] = tools.unwrap_or_else(|| {
        let mut specs = crate::docs::tool_specs().as_array().cloned().unwrap_or_default();
        specs.extend(crate::flows::tool_specs(&kind));
        serde_json::Value::Array(specs)
    });
    if let Some(p) = crate::flows::system_prompt(&kind) {
        msg["append_system_prompt"] = p.into();
    }
    state.live.lock().unwrap().insert(session.clone());
    sidecar_send(state, msg)?;
    Ok(session)
}

#[tauri::command]
pub fn session_send(app: AppHandle, state: State<'_, Sidecar>, session: String, text: String) -> Result<(), String> {
    crate::eventlog::record(&app, Some(&session), "ui.message_sent", &serde_json::json!({ "text": text }), None);
    sidecar_send(state, serde_json::json!({ "type": "send", "session": session, "text": text }))
}

#[tauri::command]
pub fn session_interrupt(app: AppHandle, state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    crate::eventlog::record(&app, Some(&session), "ui.interrupted", &serde_json::json!({}), None);
    sidecar_send(state, serde_json::json!({ "type": "interrupt", "session": session }))
}

#[tauri::command]
pub fn session_stop(state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    sidecar_send(state, serde_json::json!({ "type": "stop", "session": session }))
}

/// Answers a permission request: `decision` is `{behavior:"allow", updatedInput?}` or `{behavior:"deny", message}`.
#[tauri::command]
pub fn permission_respond(
    app: AppHandle,
    state: State<'_, Sidecar>,
    session: String,
    request_id: String,
    decision: serde_json::Value,
) -> Result<(), String> {
    crate::eventlog::record(
        &app,
        Some(&session),
        "ui.permission_answered",
        &serde_json::json!({ "request_id": request_id, "decision": decision }),
        Some(&format!("decision:{request_id}")),
    );
    sidecar_send(
        state,
        serde_json::json!({ "type": "permission_response", "session": session, "request_id": request_id, "decision": decision }),
    )
}

#[tauri::command]
pub fn tool_result(
    _app: AppHandle,
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

pub fn expand_home(app: &AppHandle, path: &str) -> String {
    match (path.strip_prefix("~"), app.path().home_dir()) {
        (Some(rest), Ok(home)) if rest.is_empty() || rest.starts_with('/') => format!("{}{}", home.display(), rest),
        _ => path.to_owned(),
    }
}

/// Answers a relayed `mr` MCP tool call from the core's own state (docs), then replies to the sidecar.
fn answer_tool_call(app: &AppHandle, payload: &serde_json::Value) {
    let session = payload["session"].as_str().unwrap_or_default().to_owned();
    let call_id = payload["call_id"].as_str().unwrap_or_default().to_owned();
    let tool = payload["tool"].as_str().unwrap_or_default();
    let (events, text, is_error) = if crate::flows::is_flow_tool(tool) {
        crate::flows::handle_tool(tool, &payload["args"])
    } else {
        crate::docs::handle_tool(&app.state::<crate::docs::Docs>(), Some(&session), tool, &payload["args"])
    };
    for (kind, p) in events {
        let anchor = p["doc_id"].as_str().map(|d| format!("doc:{d}"));
        crate::eventlog::record(app, Some(&session), &kind, &p, anchor.as_deref());
    }
    let _ = tool_result(app.clone(), app.state::<Sidecar>(), session, call_id, text, Some(is_error));
}
