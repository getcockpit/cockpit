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
                            let _ = sidecar_send(handle.state::<Sidecar>(), serde_json::json!({ "type": "models" }));
                        }
                        if payload["type"] == "session_ended" {
                            if let Some(id) = payload["session"].as_str() {
                                handle.state::<Sidecar>().live.lock().unwrap().remove(id);
                            }
                        }
                        if payload["type"] == "tool_call" {
                            answer_tool_call(&handle, &payload);
                        }
                        // The Cockpit layer draws the cards once a turn ends (decision 34).
                        if payload["type"] == "sdk" && payload["message"]["type"] == "result" {
                            if let Some(id) = session.as_deref() {
                                crate::cockpit_layer::after_turn(handle.clone(), id.to_owned());
                            }
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

/// Stops every running session of a workspace (before it's deleted, MR-54). Returns how many.
pub fn stop_sessions_in(app: &AppHandle, workspace: &str) -> usize {
    let state = app.state::<Sidecar>();
    let ids: Vec<String> = state.live.lock().unwrap().iter().filter(|s| crate::workspaces::workspace_of(app, s) == workspace).cloned().collect();
    for id in &ids {
        let _ = sidecar_send(app.state::<Sidecar>(), serde_json::json!({ "type": "stop", "session": id }));
    }
    ids.len()
}

/// Re-reads plan limits (the UI calls this every few minutes); the answer arrives as `sidecar.limits`.
#[tauri::command]
pub fn limits_refresh(state: State<'_, Sidecar>) -> Result<(), String> {
    sidecar_send(state, serde_json::json!({ "type": "limits" }))
}

/// Re-reads the models Claude Code offers this login; the answer arrives as `sidecar.models`.
#[tauri::command]
pub fn models_refresh(state: State<'_, Sidecar>) -> Result<(), String> {
    sidecar_send(state, serde_json::json!({ "type": "models" }))
}

/// Switches a session's model and/or effort (MR-73). `change` holds `model` and/or `effort`; null
/// means Claude Code's default, an absent key leaves it as it is. Logged first, so a session that
/// isn't running picks it up when it resumes.
#[tauri::command]
pub fn session_set_model(app: AppHandle, state: State<'_, Sidecar>, session: String, change: serde_json::Value) -> Result<(), String> {
    let mut payload = serde_json::json!({});
    for key in ["model", "effort"] {
        if let Some(v) = change.get(key) {
            if !(v.is_null() || v.is_string()) {
                return Err(format!("{key} must be a string or null"));
            }
            payload[key] = v.clone();
        }
    }
    if payload.as_object().is_none_or(|o| o.is_empty()) {
        return Err("nothing to change: give a model or an effort".into());
    }
    crate::eventlog::record(&app, Some(&session), "ui.model_set", &payload, None);
    if !state.live.lock().unwrap().contains(&session) {
        return Ok(());
    }
    let mut msg = payload;
    msg["type"] = "set_model".into();
    msg["session"] = session.into();
    sidecar_send(state, msg)
}

/// The model and effort a session was last switched to, folded from its `ui.model_set` events in
/// order (None: Claude Code's default). Resumes start with these.
pub fn fold_model_choice<'a>(payloads: impl IntoIterator<Item = &'a serde_json::Value>) -> (Option<String>, Option<String>) {
    let (mut model, mut effort) = (None, None);
    for p in payloads {
        if let Some(v) = p.get("model") {
            model = v.as_str().map(str::to_owned);
        }
        if let Some(v) = p.get("effort") {
            effort = v.as_str().map(str::to_owned);
        }
    }
    (model, effort)
}

/// Sessions auto-compact once their context reaches this many tokens. Re-reading a long conversation
/// on every call is most of a session's cost, and on 1M-context models Claude Code otherwise waits
/// until ~967k (token diet, decision I63).
pub const COMPACT_WINDOW: u64 = 200_000;

/// The compaction window folded from `ui.compact_window_set` events in order; `tokens: null` means
/// Claude Code's own default (the model's limit).
pub fn fold_compact_window<'a>(payloads: impl IntoIterator<Item = &'a serde_json::Value>) -> Option<u64> {
    payloads.into_iter().fold(Some(COMPACT_WINDOW), |_, p| p["tokens"].as_u64())
}

fn compact_window(app: &AppHandle) -> Option<u64> {
    let evs = app.state::<crate::eventlog::EventLog>().list_kind("ui.compact_window_set").unwrap_or_default();
    fold_compact_window(evs.iter().map(|e| &e.payload))
}

fn model_choice(app: &AppHandle, session: &str) -> (Option<String>, Option<String>) {
    let evs = app.state::<crate::eventlog::EventLog>().list(Some(session), None, 100_000).unwrap_or_default();
    fold_model_choice(evs.iter().filter(|e| e.kind == "ui.model_set").map(|e| &e.payload))
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
pub const VISUAL_GUIDANCE: &str = "You are running inside Cockpit, a visual front-end for Claude Code. The user sees your replies as cards, not a terminal.
- The mr tools never get a model call of their own: send each mr call in the same message as real work (parallel tool calls).
- Name the thread with mcp__mr__title_set (2-6 words) in your first message with tool calls, and again only when its focus clearly shifts.
- For work with 3 or more steps, publish mcp__mr__plan_set with every step, and send the full list again only when a step starts or finishes, in the message that starts the next step's work.
- When the user must choose between options, use AskUserQuestion with 2-4 concrete options, each with a short description. One decision per question.
- Write replies in Markdown: short `## ` headings, numbered lists for steps, `- ` bullets for facts. Start a list item with a **bold short title**. Put time estimates in the item (\"about 15 min\") and file references as `path/to/file.ts:42`.
- For a status report, summary, comparison, verification result or progress, use mcp__mr__render_view instead of prose (decision 26) as the turn's last call, with no text after it. Review findings → `findings` (with a `tier` first); fixes for one finding → `fix_options`; a number to choose → `tradeoff`; does it already exist → `novelty`; a reviewer's comment → `thread`.
- End every turn with one line: `Next:` then 1-3 replies the user is likely to send, each in double quotes, best first (e.g. Next: \"Merge it\" · \"Show me the diff\"). After render_view, put them in its `next` block instead.";

/// Appended to blank sessions only (MR-98): Plan sessions already write a doc, and Review/Address
/// follow their flow. Claude, having read the code, judges better than a heuristic on the prompt.
pub const PLAN_NUDGE: &str = "- If the task turns out to need larger decisions, context only the user has, or a round of context gathering before any code (several open design choices, unclear scope, a cross-cutting change), ask with AskUserQuestion whether to plan it in a working doc first, with the options \"Plan it in a doc\" (recommended) and \"Just do it\". If the user picks the doc, write it in this session with the mr doc tools (mcp__mr__doc_create, then mcp__mr__doc_set_block per section, open choices as section=question, each block with a view) and stop for their review before writing code. Don't ask for small or clear tasks.";

/// The system prompt appended for a session of this kind; `layer` means the Cockpit layer draws
/// the cards, so the visual guidance is left out (decision 34).
fn append_prompt(kind: &str, layer: bool) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if !layer {
        parts.push(VISUAL_GUIDANCE.to_owned());
    }
    if kind == "blank" {
        parts.push(PLAN_NUDGE.to_owned());
    }
    let mut out = parts.join("\n");
    if let Some(p) = crate::flows::system_prompt(kind) {
        out = if out.is_empty() { p.to_string() } else { format!("{out}\n\n{p}") };
    }
    (!out.is_empty()).then_some(out)
}

/// Another copy of the app (dev or /Applications) is running this session (MR-99).
const ELSEWHERE: &str = "this session is open in another copy of Cockpit: continue it there, or quit that copy";

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
    preset: Option<String>,
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
    if let (Some(_), Some(id)) = (&resume, &session_id) && crate::instances::owned_elsewhere(&app, id).is_some() {
        return Err(ELSEWHERE.into());
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
    // Started from one of your own kinds in the start picker (MR-80).
    if let Some(id) = preset {
        payload["preset"] = id.into();
    }
    // What the session compacts at, so usage reports can tell sessions apart (I63).
    let compact = compact_window(&app);
    payload["compact_window"] = compact.into();
    // With the Cockpit layer on, the session runs as plain Claude Code and the layer draws the
    // cards on its own key after each turn (decision 34).
    let layer = crate::cockpit_layer::on(&app);
    if layer {
        payload["cockpit_layer"] = true.into();
    }
    crate::eventlog::record(&app, Some(&session), "ui.session_requested", &payload, None);
    let mut msg = serde_json::json!({ "type": "start", "session": session, "cwd": cwd, "prompt": prompt });
    if let Some(r) = resume {
        msg["resume"] = r.into();
    }
    let (model, effort) = model_choice(&app, &session);
    if let Some(m) = model {
        msg["model"] = m.into();
    }
    if let Some(e) = effort {
        msg["effort"] = e.into();
    }
    msg["tools"] = tools.unwrap_or_else(|| {
        let mut specs = crate::docs::tool_specs().as_array().cloned().unwrap_or_default();
        specs.extend(crate::flows::tool_specs(&kind));
        if !layer {
            specs.push(crate::views::tool_spec());
            specs.push(crate::views::plan_spec());
            specs.push(crate::views::title_spec());
        }
        if crate::selfbuild::update_available(&cwd) {
            specs.push(crate::selfbuild::update_spec());
        }
        serde_json::Value::Array(specs)
    });
    let mut env = serde_json::Map::new();
    if let Some(dir) = crate::workspaces::config_dir(&app, &workspace) {
        env.insert("CLAUDE_CONFIG_DIR".into(), dir.display().to_string().into());
    }
    if let Some(w) = compact {
        env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), w.to_string().into());
    }
    if !env.is_empty() {
        msg["env"] = env.into();
    }
    // Every session gets the visual-app guidance (MR-56); blank ones the plan nudge (MR-98);
    // Review/Address add their flow steps.
    if let Some(a) = append_prompt(&kind, layer) {
        msg["append_system_prompt"] = a.into();
    }
    state.live.lock().unwrap().insert(session.clone());
    sidecar_send(state, msg)?;
    Ok(session)
}

#[tauri::command]
pub fn session_send(app: AppHandle, state: State<'_, Sidecar>, session: String, text: String) -> Result<(), String> {
    let live = state.live.lock().unwrap().contains(&session);
    if !live && crate::instances::owned_elsewhere(&app, &session).is_some() {
        return Err(ELSEWHERE.into());
    }
    crate::eventlog::record(&app, Some(&session), "ui.message_sent", &serde_json::json!({ "text": text }), None);
    if live {
        return sidecar_send(state, serde_json::json!({ "type": "send", "session": session, "text": text }));
    }
    // Not running any more (app restarted, or it ended): resume the same conversation with this
    // message instead of failing with "unknown session" (MR-52).
    let (cwd, kind, workspace, sdk) = resume_info(&app, &session).ok_or("this session can't be resumed; start a new one")?;
    session_start(app, state, cwd, text, Some(sdk), None, Some(kind), Some(false), Some(session), Some(workspace), None).map(|_| ())
}

/// Where and how a session ran, from the log: (cwd, kind, workspace, Claude session id).
fn resume_info(app: &AppHandle, session: &str) -> Option<(String, String, String, String)> {
    let evs = app.state::<crate::eventlog::EventLog>().list(Some(session), None, 100_000).ok()?;
    let req = evs.iter().find(|e| e.kind == "ui.session_requested")?;
    let sdk = evs.iter().rev().find(|e| e.kind == "sidecar.session_started")?.payload["sdk_session_id"].as_str()?.to_owned();
    let p = &req.payload;
    Some((p["worktree"].as_str().or(p["cwd"].as_str())?.to_owned(), p["kind"].as_str().unwrap_or("blank").to_owned(), p["workspace"].as_str().unwrap_or(crate::workspaces::PERSONAL).to_owned(), sdk))
}

/// Asks a running session for its slash commands and skills (the / menu); the answer arrives as `sidecar.commands`.
#[tauri::command]
pub fn session_commands(state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    if !state.live.lock().unwrap().contains(&session) {
        return Err("this session isn't running".into());
    }
    sidecar_send(state, serde_json::json!({ "type": "commands", "session": session }))
}

/// What /mcp shows, for a running session; the answer arrives as `sidecar.mcp_status`.
#[tauri::command]
pub fn session_mcp_status(state: State<'_, Sidecar>, session: String) -> Result<(), String> {
    if !state.live.lock().unwrap().contains(&session) {
        return Err("this session isn't running: resume it to see its MCP servers".into());
    }
    sidecar_send(state, serde_json::json!({ "type": "mcp_status", "session": session }))
}

/// Reconnects, enables or disables one MCP server of a running session. Logged before it's sent;
/// the fresh list (with how the action went) arrives as `sidecar.mcp_status`.
#[tauri::command]
pub fn session_mcp_action(app: AppHandle, state: State<'_, Sidecar>, session: String, server: String, action: String) -> Result<(), String> {
    if !["reconnect", "enable", "disable"].contains(&action.as_str()) {
        return Err(format!("unknown MCP action: {action}"));
    }
    if !state.live.lock().unwrap().contains(&session) {
        return Err("this session isn't running: resume it to manage its MCP servers".into());
    }
    crate::eventlog::record(&app, Some(&session), "ui.mcp_action", &serde_json::json!({ "server": server, "action": action }), None);
    sidecar_send(state, serde_json::json!({ "type": "mcp_action", "session": session, "server": server, "action": action }))
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
    } else if crate::views::is_view_tool(tool) {
        crate::views::handle_tool(tool, &payload["args"])
    } else if tool == crate::selfbuild::UPDATE_TOOL {
        crate::selfbuild::handle_update(app, &payload["args"])
    } else {
        crate::docs::handle_tool(&app.state::<crate::docs::Docs>(), Some(&session), tool, &payload["args"])
    };
    for (kind, p) in events {
        let anchor = p["doc_id"].as_str().map(|d| format!("doc:{d}"));
        crate::eventlog::record(app, Some(&session), &kind, &p, anchor.as_deref());
    }
    let _ = tool_result(app.clone(), app.state::<Sidecar>(), session, call_id, text, Some(is_error));
}

#[cfg(test)]
mod tests {
    use super::{append_prompt, fold_compact_window, fold_model_choice, COMPACT_WINDOW, PLAN_NUDGE, VISUAL_GUIDANCE};
    use serde_json::json;

    #[test]
    fn only_blank_sessions_get_the_plan_nudge() {
        let blank = append_prompt("blank", false).unwrap();
        assert!(blank.starts_with(VISUAL_GUIDANCE) && blank.ends_with(PLAN_NUDGE));
        assert_eq!(append_prompt("blank", true).as_deref(), Some(PLAN_NUDGE));
        assert_eq!(append_prompt("plan", false).as_deref(), Some(VISUAL_GUIDANCE));
        assert_eq!(append_prompt("plan", true), None);
        let review = append_prompt("review", false).unwrap();
        assert!(review.starts_with(VISUAL_GUIDANCE) && !review.contains(PLAN_NUDGE));
        assert!(!append_prompt("review", true).unwrap().contains(VISUAL_GUIDANCE));
    }

    #[test]
    fn model_choice_folds_in_order_and_null_means_default() {
        let evs = [json!({ "model": "opus", "effort": "high" }), json!({ "effort": "low" }), json!({ "model": null })];
        assert_eq!(fold_model_choice(&evs), (None, Some("low".into())));
        assert_eq!(fold_model_choice(&evs[..2]), (Some("opus".into()), Some("low".into())));
        assert_eq!(fold_model_choice(&[]), (None, None));
    }

    #[test]
    fn compact_window_defaults_low_and_the_last_choice_wins() {
        assert_eq!(fold_compact_window(&[]), Some(COMPACT_WINDOW));
        let evs = [json!({ "tokens": 400_000 }), json!({ "tokens": null }), json!({ "tokens": 120_000 })];
        assert_eq!(fold_compact_window(&evs), Some(120_000));
        assert_eq!(fold_compact_window(&evs[..2]), None);
    }
}
