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
    /// Waiters for one-shot replies, by request id.
    oneshots: Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<serde_json::Value>>>,
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
                        if payload["type"] == "oneshot_result" {
                            // The app's own helper calls: hand back to the waiter, never logged as session activity.
                            if let Some(tx) = payload["id"].as_str().and_then(|id| handle.state::<Sidecar>().oneshots.lock().unwrap().remove(id)) {
                                let _ = tx.send(payload);
                            }
                            continue;
                        }
                        let kind = format!("sidecar.{}", payload["type"].as_str().unwrap_or("unknown"));
                        let session = payload["session"].as_str().map(str::to_owned);
                        crate::eventlog::record(&handle, session.as_deref(), &kind, &payload, None);
                        if payload["type"] == "ready" {
                            crate::selfbuild::on_ready(&handle);
                            // Show plan limits straight away, not only once a session reports them.
                            let _ = sidecar_send(handle.state::<Sidecar>(), serde_json::json!({ "type": "limits" }));
                        }
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

/// Re-reads plan limits (the UI calls this every few minutes); the answer arrives as `sidecar.limits`.
#[tauri::command]
pub fn limits_refresh(state: State<'_, Sidecar>) -> Result<(), String> {
    sidecar_send(state, serde_json::json!({ "type": "limits" }))
}

/// Runs one tool-less, unsaved turn in the sidecar and waits for its text (blocking; call off the UI thread).
pub fn oneshot(app: &AppHandle, prompt: &str, system: &str, model: &str, timeout: std::time::Duration) -> Result<String, String> {
    let id = ulid::Ulid::new().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    let state = app.state::<Sidecar>();
    state.oneshots.lock().unwrap().insert(id.clone(), tx);
    let msg = serde_json::json!({ "type": "oneshot", "id": id, "prompt": prompt, "system": system, "model": model });
    if let Err(e) = sidecar_send(state.clone(), msg) {
        state.oneshots.lock().unwrap().remove(&id);
        return Err(e);
    }
    let reply = rx.recv_timeout(timeout).map_err(|_| {
        app.state::<Sidecar>().oneshots.lock().unwrap().remove(&id);
        "timed out".to_string()
    })?;
    if reply["ok"].as_bool() == Some(true) {
        Ok(reply["text"].as_str().unwrap_or("").to_owned())
    } else {
        Err(reply["error"].as_str().unwrap_or("one-shot failed").to_owned())
    }
}

/// Appended to every session's system prompt (MR-56). The app renders choices as decision cards
/// and structured replies as visual blocks, so it asks Claude for those shapes instead of prose.
pub const VISUAL_GUIDANCE: &str = "You are running inside Minority report, a visual front-end for Claude Code. The user sees your replies as cards, not a terminal.
- When the user has to choose between options (which approach, which host, whether to continue), call the AskUserQuestion tool with 2-4 concrete options, each with a short description, instead of asking in prose. One decision per question.
- Write replies in Markdown: short `## ` section headings, numbered lists for steps or todos, `- ` bullets for facts. Start a list item with a **bold short title**, then the detail. Put rough time estimates in the item (\"about 15 min\") and file references as `path/to/file.ts:42`.
- End a turn that needs the user with one line starting `Next:`.";

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
    workspace: Option<String>,
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
    // Resumes stay in the workspace they started in.
    let workspace = workspace.unwrap_or_else(|| if resume.is_some() { crate::workspaces::workspace_of(&app, &session) } else { crate::workspaces::PERSONAL.into() });
    let mut payload = serde_json::json!({ "cwd": cwd, "prompt": prompt, "resume": resume, "kind": kind, "workspace": workspace });
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
    if let Some(dir) = crate::workspaces::config_dir(&app, &workspace) {
        msg["env"] = serde_json::json!({ "CLAUDE_CONFIG_DIR": dir });
    }
    // Every session gets the visual-app guidance (MR-56); Review/Address add their flow steps.
    let append = match crate::flows::system_prompt(&kind) {
        Some(p) => format!("{VISUAL_GUIDANCE}\n\n{p}"),
        None => VISUAL_GUIDANCE.to_owned(),
    };
    msg["append_system_prompt"] = append.into();
    state.live.lock().unwrap().insert(session.clone());
    sidecar_send(state, msg)?;
    Ok(session)
}

#[tauri::command]
pub fn session_send(app: AppHandle, state: State<'_, Sidecar>, session: String, text: String) -> Result<(), String> {
    let live = state.live.lock().unwrap().contains(&session);
    crate::eventlog::record(&app, Some(&session), "ui.message_sent", &serde_json::json!({ "text": text }), None);
    if live {
        return sidecar_send(state, serde_json::json!({ "type": "send", "session": session, "text": text }));
    }
    // Not running any more (app restarted, or it ended): resume the same conversation with this
    // message instead of failing with "unknown session" (MR-52).
    let (cwd, kind, workspace, sdk) = resume_info(&app, &session).ok_or("this session can't be resumed; start a new one")?;
    session_start(app, state, cwd, text, Some(sdk), None, Some(kind), Some(false), Some(session), Some(workspace)).map(|_| ())
}

/// Where and how a session ran, from the log: (cwd, kind, workspace, Claude session id).
fn resume_info(app: &AppHandle, session: &str) -> Option<(String, String, String, String)> {
    let evs = app.state::<crate::eventlog::EventLog>().list(Some(session), None, 100_000).ok()?;
    let req = evs.iter().find(|e| e.kind == "ui.session_requested")?;
    let sdk = evs.iter().rev().find(|e| e.kind == "sidecar.session_started")?.payload["sdk_session_id"].as_str()?.to_owned();
    let p = &req.payload;
    Some((p["worktree"].as_str().or(p["cwd"].as_str())?.to_owned(), p["kind"].as_str().unwrap_or("blank").to_owned(), p["workspace"].as_str().unwrap_or(crate::workspaces::PERSONAL).to_owned(), sdk))
}

#[tauri::command]
pub fn session_interrupt(app: AppHandle, state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    if !state.live.lock().unwrap().contains(&session) {
        return Ok(()); // nothing running to interrupt
    }
    crate::eventlog::record(&app, Some(&session), "ui.interrupted", &serde_json::json!({}), None);
    sidecar_send(state, serde_json::json!({ "type": "interrupt", "session": session }))
}

#[tauri::command]
pub fn session_stop(state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    if !state.live.lock().unwrap().contains(&session) {
        return Ok(()); // already stopped (e.g. marking an ended session done)
    }
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
