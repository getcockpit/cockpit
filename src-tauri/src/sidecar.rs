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
    /// App session ids currently running in the sidecar.
    live: Mutex<std::collections::HashSet<String>>,
    /// Live sessions whose turn has ended: they wait for your next message and don't count toward the cap (MR-105).
    idle: Mutex<std::collections::HashSet<String>>,
    /// Waiters for one-shot replies, by request id.
    oneshots: Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<serde_json::Value>>>,
    /// Sessions whose flow finished (review published, address pushed): archived already, stopped when the turn ends.
    closing: Mutex<std::collections::HashSet<String>>,
    /// Sessions started in a mode of their own (a recurring run's, MR-167) until you set one for all.
    modes: Mutex<std::collections::HashMap<String, String>>,
    /// Moves asked for mid-turn (MR-177), by session: the workspace it goes to once the turn ends.
    moving: Mutex<std::collections::HashMap<String, String>>,
}

/// How many sessions may be mid-turn at once when nothing else says (MR-105; was 6, decision 14).
pub const SESSION_CAP: usize = 10;

/// The cap: your last `ui.session_cap_set` in Settings, else `MR_SESSION_CAP`, else `SESSION_CAP`.
pub fn fold_session_cap<'a>(payloads: impl IntoIterator<Item = &'a serde_json::Value>, env: Option<&str>) -> usize {
    let base = env.and_then(|v| v.parse().ok()).unwrap_or(SESSION_CAP);
    payloads.into_iter().fold(base, |cap, p| p["cap"].as_u64().map_or(cap, |n| n.max(1) as usize))
}

fn session_cap(app: &AppHandle) -> usize {
    let evs = app.state::<crate::eventlog::EventLog>().list_kind("ui.session_cap_set").unwrap_or_default();
    fold_session_cap(evs.iter().map(|e| &e.payload), std::env::var("MR_SESSION_CAP").ok().as_deref())
}

/// Whether an SDK message shows the session working (`Some(true)`) or its turn over (`Some(false)`).
/// Anything else (rate limits, hooks, background task notices) says nothing about it.
pub fn turn_signal(message: &serde_json::Value) -> Option<bool> {
    match (message["type"].as_str()?, message["subtype"].as_str()) {
        ("result", _) => Some(false),
        ("assistant" | "user" | "stream_event" | "tool_progress", _) | ("system", Some("init")) => Some(true),
        _ => None,
    }
}

/// Live sessions that count toward the cap: the ones mid-turn.
pub fn busy(state: &Sidecar) -> usize {
    let idle = state.idle.lock().unwrap();
    state.live.lock().unwrap().iter().filter(|s| !idle.contains(*s)).count()
}

/// Whether this session is live and mid-turn (a recurring run still going, MR-169).
pub fn mid_turn(app: &AppHandle, session: &str) -> bool {
    let state = app.state::<Sidecar>();
    let live = state.live.lock().unwrap().contains(session);
    live && !state.idle.lock().unwrap().contains(session)
}

pub fn start(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (mut rx, child) = app.shell().sidecar("mr-sidecar")?.env_clear().envs(crate::selfbuild::child_env()).spawn()?;
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
                        let mut payload = serde_json::from_str::<serde_json::Value>(line)
                            .unwrap_or_else(|_| serde_json::json!({ "type": "raw", "line": line }));
                        // Never ask (I109): allowed here, logged as auto_allowed so no card is drawn.
                        if payload["type"] == "permission_request" && session_mode(&handle, payload["session"].as_str().unwrap_or("")) == "never" && auto_allows(&payload) {
                            payload["auto_allowed"] = true.into();
                            let decision = serde_json::json!({ "behavior": "allow", "updatedInput": payload["input"] });
                            let _ = sidecar_send(handle.state::<Sidecar>(), serde_json::json!({ "type": "permission_response", "session": payload["session"], "request_id": payload["request_id"], "decision": decision }));
                        }
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
                                handle.state::<Sidecar>().idle.lock().unwrap().remove(id);
                                // Ended before its turn did (interrupted, stopped): the queued move happens now.
                                if let Some(to) = handle.state::<Sidecar>().moving.lock().unwrap().remove(id) {
                                    apply_queued_move(&handle, id, to);
                                }
                            }
                        }
                        if let (Some(id), Some(working)) = (session.as_deref(), (payload["type"] == "sdk").then(|| turn_signal(&payload["message"])).flatten()) {
                            let state = handle.state::<Sidecar>();
                            let mut idle = state.idle.lock().unwrap();
                            if working { idle.remove(id); } else { idle.insert(id.to_owned()); }
                        }
                        if payload["type"] == "tool_call" {
                            answer_tool_call(&handle, &payload);
                        }
                        // The Cockpit layer draws the cards once a turn ends (decision 34).
                        if payload["type"] == "sdk" && payload["message"]["type"] == "result" {
                            if let Some(id) = session.as_deref() {
                                crate::schedules::on_turn_end(&handle, id, &payload["message"]);
                                crate::spawn::on_turn_end(&handle, id, &payload["message"]);
                                relay_doc_changes(&handle, id);
                                if handle.state::<Sidecar>().closing.lock().unwrap().remove(id) {
                                    let _ = sidecar_send(handle.state::<Sidecar>(), serde_json::json!({ "type": "stop", "session": id }));
                                } else {
                                    crate::cockpit_layer::after_turn(handle.clone(), id.to_owned());
                                }
                                if let Some(to) = handle.state::<Sidecar>().moving.lock().unwrap().remove(id) {
                                    apply_queued_move(&handle, id, to);
                                }
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
                    handle.state::<Sidecar>().idle.lock().unwrap().clear();
                    handle.state::<Sidecar>().moving.lock().unwrap().clear();
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

/// How sessions ask before using tools: `auto` (Claude Code's classifier approves safe calls and asks
/// about the risky ones), `acceptEdits` (file edits go through, commands ask), `default` (every
/// tool asks) or `never` (Cockpit allows everything below high risk, I109). Auto until you choose;
/// the first-run intro asks you to (decision I106).
pub const PERMISSION_MODE: &str = "auto";
pub const PERMISSION_MODES: [&str; 4] = ["auto", "acceptEdits", "default", "never"];

/// The mode Claude Code runs in. Never ask is Cockpit's, not Claude Code's bypass (which would skip
/// the permission hook entirely): sessions run in acceptEdits, so only edits outside the project and
/// non-edit tools reach `auto_allows`, which lets everything through except high-risk calls.
pub fn sdk_mode(mode: &str) -> &str {
    if mode == "never" { "acceptEdits" } else { mode }
}

static HIGH_RISK: std::sync::LazyLock<Vec<regex::Regex>> = std::sync::LazyLock::new(|| {
    let rules: serde_json::Value = serde_json::from_str(include_str!("../../ui/src/picker/risk-rules.json")).expect("risk-rules.json");
    rules["high"].as_array().into_iter().flatten().filter_map(|r| {
        let flags = if r["flags"].as_str().unwrap_or("").contains('i') { "(?i)" } else { "" };
        regex::Regex::new(&format!("{flags}{}", r["source"].as_str()?)).ok()
    }).collect()
});

/// Under Never ask: may this permission request be allowed without asking? Questions and plan
/// approvals always reach you; so do edits (in acceptEdits only edits outside the project get here)
/// and shell commands the cards rate high risk (`risk-rules.json`).
pub fn auto_allows(request: &serde_json::Value) -> bool {
    match request["tool"].as_str().unwrap_or("") {
        "AskUserQuestion" | "ExitPlanMode" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => false,
        "Bash" => {
            let command = request["input"]["command"].as_str().unwrap_or("");
            !HIGH_RISK.iter().any(|r| r.is_match(command))
        }
        _ => true,
    }
}

/// Your last valid `ui.permission_mode_set`, else `PERMISSION_MODE`.
pub fn fold_permission_mode<'a>(payloads: impl IntoIterator<Item = &'a serde_json::Value>) -> &'static str {
    payloads.into_iter().fold(PERMISSION_MODE, |m, p| PERMISSION_MODES.into_iter().find(|x| p["mode"].as_str() == Some(*x)).unwrap_or(m))
}

fn permission_mode(app: &AppHandle) -> &'static str {
    let evs = app.state::<crate::eventlog::EventLog>().list_kind("ui.permission_mode_set").unwrap_or_default();
    fold_permission_mode(evs.iter().map(|e| &e.payload))
}

/// A session's own mode if it started in one (a recurring run), else everyone's.
fn session_mode(app: &AppHandle, session: &str) -> String {
    let own = app.state::<Sidecar>().modes.lock().unwrap().get(session).cloned();
    own.unwrap_or_else(|| permission_mode(app).to_owned())
}

/// Whether a new session would be refused for the cap right now.
pub fn at_cap(app: &AppHandle) -> bool {
    busy(&app.state::<Sidecar>()) >= session_cap(app)
}

/// Sets how sessions ask for permission. Logged first, then switched on every running session so
/// it applies at once; new and resumed sessions start in it.
#[tauri::command]
pub fn permission_mode_set(app: AppHandle, state: State<'_, Sidecar>, mode: String) -> Result<(), String> {
    if !PERMISSION_MODES.contains(&mode.as_str()) {
        return Err(format!("unknown permission mode: {mode}"));
    }
    crate::eventlog::record(&app, None, "ui.permission_mode_set", &serde_json::json!({ "mode": mode }), None);
    state.modes.lock().unwrap().clear();
    let live: Vec<String> = state.live.lock().unwrap().iter().cloned().collect();
    for id in live {
        let _ = sidecar_send(app.state::<Sidecar>(), serde_json::json!({ "type": "set_permission_mode", "session": id, "mode": sdk_mode(&mode) }));
    }
    Ok(())
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
- For work with 3 or more steps, publish mcp__mr__plan_set with every step, and send the full list again only when a step starts or finishes, in the message that starts the next step's work. Close it (every step done) in the same message as your last real tool call or render_view, or, when you end with a text reply, in that reply's message: the text first, then plan_set. Never send it in a message of its own.
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
    attachments: Option<Vec<serde_json::Value>>,
) -> Result<String, String> {
    start_with(app, state, cwd, prompt, resume, tools, kind, worktree, session_id, workspace, preset, attachments, Started::default())
}

/// Appended for a recurring run (MR-167): nobody is watching when it starts.
pub const UNATTENDED: &str = "This session was started by a schedule (a recurring session); nobody is watching it right now. Do the whole task end to end without stopping to ask: pick sensible defaults and say which you picked. Only ask when you truly can't continue. End with a short report of the result.";

/// The system-prompt append, plus `UNATTENDED` for a recurring run.
pub fn unattended(append: Option<String>, scheduled: bool) -> Option<String> {
    if !scheduled {
        return append;
    }
    Some(append.map_or_else(|| UNATTENDED.to_owned(), |a| format!("{a}\n\n{UNATTENDED}")))
}

/// What only Cockpit itself starts sessions with: a recurring run's schedule and its own mode (MR-167).
#[derive(Default)]
pub struct Started {
    pub schedule: Option<String>,
    pub permission_mode: Option<String>,
    /// Nobody is watching: append `UNATTENDED`. A prompt-mode run is; a review a schedule starts
    /// (MR-171) isn't, since it must stop for you before anything goes to GitHub.
    pub unattended: bool,
    /// Spawned by this session's `session_spawn` call (MR-176).
    pub parent: Option<String>,
}

/// The system-prompt append a session starts with: the visual guidance, its flow's steps, and
/// `UNATTENDED` only when `started` says nobody is watching.
pub fn system_append(kind: &str, layer: bool, started: &Started) -> Option<String> {
    unattended(append_prompt(kind, layer), started.unattended)
}

#[allow(clippy::too_many_arguments)]
pub fn start_with(
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
    attachments: Option<Vec<serde_json::Value>>,
    started: Started,
) -> Result<String, String> {
    let mut cwd = expand_home(&app, &cwd);
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("not a folder: {cwd}"));
    }
    // Only sessions mid-turn count: ones waiting for your next message don't (MR-105).
    let (working, cap) = (busy(&state), session_cap(&app));
    if working >= cap {
        return Err(format!("{working} sessions are working (the cap is {cap}). Wait for one to finish its turn, stop one, or raise the cap in Settings → Sessions."));
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
    // A recurring run (MR-167): its tile is tagged ↻ and its history lists it.
    if let Some(id) = &started.schedule {
        payload["schedule"] = id.clone().into();
    }
    if let Some(m) = &started.permission_mode {
        payload["permission_mode"] = m.clone().into();
    }
    // A spawned session (MR-176): its tile names the parent, and it can't spawn more.
    if let Some(p) = &started.parent {
        payload["parent"] = p.clone().into();
    }
    let parent = started.parent.clone().or_else(|| resume.as_ref().and_then(|_| crate::spawn::spawned_by(&app.state::<crate::eventlog::EventLog>().list(Some(&session), None, 100_000).unwrap_or_default())));
    let spawned = parent.is_some();
    if let Some(p) = parent {
        crate::spawn::remember(&session, &p, &prompt); // its turns report back to the parent
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
    // Pasted, dropped or picked files (images, PDFs…): the log keeps their paths, the sidecar reads them.
    let attachments = attachments.filter(|a| !a.is_empty());
    if let Some(a) = &attachments {
        payload["attachments"] = a.clone().into();
    }
    crate::eventlog::record(&app, Some(&session), "ui.session_requested", &payload, None);
    let mut msg = serde_json::json!({ "type": "start", "session": session, "cwd": cwd, "prompt": prompt });
    if let Some(a) = attachments {
        msg["attachments"] = a.into();
    }
    if let Some(r) = resume {
        msg["resume"] = r.into();
    }
    let mode = match started.permission_mode.clone().filter(|m| PERMISSION_MODES.contains(&m.as_str())) {
        Some(m) => {
            state.modes.lock().unwrap().insert(session.clone(), m.clone());
            m
        }
        None => session_mode(&app, &session),
    };
    msg["permission_mode"] = sdk_mode(&mode).into();
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
        if !spawned {
            specs.push(crate::spawn::tool_spec());
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
    // A recurring run starts with nobody watching: it shouldn't stop to ask what it can decide.
    if let Some(a) = system_append(&kind, layer, &started) {
        msg["append_system_prompt"] = a.into();
    }
    state.live.lock().unwrap().insert(session.clone());
    state.idle.lock().unwrap().remove(&session);
    sidecar_send(state, msg)?;
    Ok(session)
}

pub fn is_live(app: &AppHandle, session: &str) -> bool {
    app.state::<Sidecar>().live.lock().unwrap().contains(session)
}

/// Sends `text` to a running `session` as a message: it starts a turn, or joins the one going.
pub fn send_to_live(app: &AppHandle, session: &str, text: &str) -> Result<(), String> {
    let state = app.state::<Sidecar>();
    state.idle.lock().unwrap().remove(session);
    sidecar_send(state, serde_json::json!({ "type": "send", "session": session, "text": text }))
}

#[tauri::command]
pub fn session_send(app: AppHandle, state: State<'_, Sidecar>, session: String, text: String, attachments: Option<Vec<serde_json::Value>>) -> Result<(), String> {
    let live = state.live.lock().unwrap().contains(&session);
    if !live && crate::instances::owned_elsewhere(&app, &session).is_some() {
        return Err(ELSEWHERE.into());
    }
    let attachments = attachments.filter(|a| !a.is_empty());
    let mut sent = serde_json::json!({ "text": text });
    // Doc changes that waited for your next message go in front of it (MR-168).
    let mut before = String::new();
    for (doc_id, note) in app.state::<crate::docs::Docs>().waiting_for(&session) {
        crate::eventlog::record(&app, Some(&session), "doc.relay", &serde_json::json!({ "doc_id": doc_id, "text": note, "waited": true }), Some(&format!("doc:{doc_id}")));
        before.push_str(&note);
        before.push_str("\n\n");
    }
    for (waited, note) in crate::spawn::waiting_for(&app, &session) {
        crate::eventlog::record(&app, Some(&session), "session.child_report", &serde_json::json!({ "child": waited.1, "text": note, "waited": waited.0 }), None);
        before.push_str(&note);
        before.push_str("\n\n");
    }
    let text = before + &text;
    if let Some(a) = &attachments {
        sent["attachments"] = a.clone().into();
    }
    crate::eventlog::record(&app, Some(&session), "ui.message_sent", &sent, None);
    if live {
        state.idle.lock().unwrap().remove(&session); // a message starts (or joins) a turn
        let mut msg = serde_json::json!({ "type": "send", "session": session, "text": text });
        if let Some(a) = attachments {
            msg["attachments"] = a.into();
        }
        return sidecar_send(state, msg);
    }
    // Not running any more (app restarted, or it ended): resume the same conversation with this
    // message instead of failing with "unknown session" (MR-52).
    let (cwd, kind, workspace, sdk) = resume_info(&app, &session).ok_or("this session can't be resumed; start a new one")?;
    session_start(app, state, cwd, text, Some(sdk), None, Some(kind), Some(false), Some(session), Some(workspace), None, attachments).map(|_| ())
}

/// After signing back in (MR-153): Claude Code may hold on to the expired login, so a live session is
/// stopped first and the message resumes the same conversation in a fresh process.
#[tauri::command]
pub async fn session_retry_signed_in(app: AppHandle, session: String, text: String) -> Result<(), String> {
    let live = || app.state::<Sidecar>().live.lock().unwrap().contains(&session);
    if live() {
        crate::eventlog::record(&app, Some(&session), "ui.relogin_restart", &serde_json::json!({}), None);
        sidecar_send(app.state::<Sidecar>(), serde_json::json!({ "type": "stop", "session": session }))?;
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while live() {
            if std::time::Instant::now() > until {
                return Err("the session didn't stop in time; try again".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    session_send(app.clone(), app.state::<Sidecar>(), session, text, None)
}

/// Whether a session can take a turn of Cockpit's asking right now (the catch-up brief): live and
/// between turns, or ended but resumable here. Mid-turn sessions can't.
pub fn can_take_turn(app: &AppHandle, session: &str) -> bool {
    let state = app.state::<Sidecar>();
    if state.live.lock().unwrap().contains(session) {
        return state.idle.lock().unwrap().contains(session);
    }
    crate::instances::owned_elsewhere(app, session).is_none() && resume_info(app, session).is_some()
}

/// Where and how a session ran, from the log: (cwd, kind, workspace, Claude session id).
fn resume_info(app: &AppHandle, session: &str) -> Option<(String, String, String, String)> {
    let evs = app.state::<crate::eventlog::EventLog>().list(Some(session), None, 100_000).ok()?;
    let req = evs.iter().find(|e| e.kind == "ui.session_requested")?;
    let sdk = evs.iter().rev().find(|e| e.kind == "sidecar.session_started")?.payload["sdk_session_id"].as_str()?.to_owned();
    let p = &req.payload;
    Some((p["worktree"].as_str().or(p["cwd"].as_str())?.to_owned(), p["kind"].as_str().unwrap_or("blank").to_owned(), crate::workspaces::workspace_in(&evs), sdk))
}

/// Moves a session to another workspace (MR-154): copies its Claude conversation into that
/// workspace's Claude folder, so it resumes there with that workspace's sign-in and memory, and
/// logs `ui.session_moved`. A session waiting for you is stopped first. One mid-turn is queued
/// instead (MR-177, `ui.session_move_queued`) and moves when its turn ends; asking to move it back
/// where it is cancels that. Returns "moved", "queued" or "unchanged".
#[tauri::command(async)]
pub fn session_move(app: AppHandle, session: String, workspace: String) -> Result<String, String> {
    let from = crate::workspaces::workspace_of(&app, &session);
    if from == workspace {
        session_move_cancel(app, session)?;
        return Ok("unchanged".into());
    }
    let target = crate::workspaces::claude_home(&app, &workspace)?;
    if workspace != crate::workspaces::PERSONAL && !target.is_dir() {
        return Err("that workspace doesn't exist any more".into());
    }
    if crate::instances::owned_elsewhere(&app, &session).is_some() {
        return Err(ELSEWHERE.into());
    }
    let state = app.state::<Sidecar>();
    if mid_turn(&app, &session) {
        state.moving.lock().unwrap().insert(session.clone(), workspace.clone());
        crate::eventlog::record(&app, Some(&session), "ui.session_move_queued", &serde_json::json!({ "from": from, "to": workspace }), None);
        return Ok("queued".into());
    }
    state.moving.lock().unwrap().remove(&session);
    if state.live.lock().unwrap().contains(&session) {
        sidecar_send(app.state::<Sidecar>(), serde_json::json!({ "type": "stop", "session": session }))?;
        // Wait for it to end, so its transcript is complete before it's copied.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while state.live.lock().unwrap().contains(&session) {
            if std::time::Instant::now() > deadline {
                return Err("it didn't stop in time; try again".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    let sdk = resume_info(&app, &session).map(|(_, _, _, sdk)| sdk);
    let copied = match &sdk {
        Some(id) => crate::workspaces::copy_transcript(&crate::workspaces::claude_home(&app, &from)?, &target, id)?,
        None => 0,
    };
    crate::eventlog::record(&app, Some(&session), "ui.session_moved", &serde_json::json!({ "from": from, "to": workspace, "copied": copied }), None);
    Ok("moved".into())
}

/// Drops a move queued mid-turn (MR-177); logs `ui.session_move_cancelled` if there was one.
#[tauri::command]
pub fn session_move_cancel(app: AppHandle, session: String) -> Result<(), String> {
    if let Some(to) = app.state::<Sidecar>().moving.lock().unwrap().remove(&session) {
        crate::eventlog::record(&app, Some(&session), "ui.session_move_cancelled", &serde_json::json!({ "to": to }), None);
    }
    Ok(())
}

/// Runs a queued move once the turn is over, off the reader thread: the move waits for the
/// session to end, which arrives on that thread. A failure is logged as `ui.session_move_failed`.
fn apply_queued_move(app: &AppHandle, session: &str, to: String) {
    let (app, session) = (app.clone(), session.to_owned());
    std::thread::spawn(move || {
        if let Err(error) = session_move(app.clone(), session.clone(), to.clone()) {
            crate::eventlog::record(&app, Some(&session), "ui.session_move_failed", &serde_json::json!({ "to": to, "error": error }), None);
        }
    });
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

/// Adds an MCP server from /mcp: the sidecar saves it with `claude mcp add-json` in `scope`, then
/// attaches it to the running session. The log keeps the name, scope and transport, never the
/// config itself (headers and env often hold tokens). The answer arrives as `sidecar.mcp_status`.
#[tauri::command]
pub fn session_mcp_add(app: AppHandle, state: State<'_, Sidecar>, session: String, server: String, scope: String, config: serde_json::Value) -> Result<(), String> {
    let transport = check_mcp_add(&server, &scope, &config)?;
    if !state.live.lock().unwrap().contains(&session) {
        return Err("this session isn't running: resume it to add an MCP server".into());
    }
    crate::eventlog::record(&app, Some(&session), "ui.mcp_action", &serde_json::json!({ "server": server, "action": "add", "scope": scope, "transport": transport }), None);
    sidecar_send(state, serde_json::json!({ "type": "mcp_add", "session": session, "server": server, "scope": scope, "config": config }))
}

/// What `claude mcp add-json` would refuse, caught before anything is logged or sent. Returns the transport.
fn check_mcp_add(server: &str, scope: &str, config: &serde_json::Value) -> Result<String, String> {
    if server.is_empty() || !server.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("a server name takes letters, digits, - and _".into());
    }
    if server == "mr" {
        return Err("mr is Cockpit's own server: pick another name".into());
    }
    if !["local", "project", "user"].contains(&scope) {
        return Err(format!("unknown scope: {scope}"));
    }
    let transport = config.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let key = match transport {
        "stdio" => "command",
        "http" | "sse" => "url",
        _ => return Err(format!("unknown transport: {transport}")),
    };
    if config.get(key).and_then(|v| v.as_str()).map_or(true, |v| v.trim().is_empty()) {
        return Err(format!("a {transport} server needs a {key}"));
    }
    Ok(transport.to_string())
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
    end_turn: Option<String>,
) -> Result<(), String> {
    sidecar_send(
        state,
        serde_json::json!({ "type": "tool_result", "session": session, "call_id": call_id, "text": text, "is_error": is_error.unwrap_or(false), "end_turn": end_turn }),
    )
}

pub fn expand_home(app: &AppHandle, path: &str) -> String {
    match (path.strip_prefix("~"), app.path().home_dir()) {
        (Some(rest), Ok(home)) if rest.is_empty() || rest.starts_with('/') => format!("{}{}", home.display(), rest),
        _ => path.to_owned(),
    }
}

/// The doc changes a session made this turn go to the doc's other running sessions (MR-168): right
/// away, queued behind their turn if they're mid-turn. Recorded as `doc.relay` on the recipient.
fn relay_doc_changes(app: &AppHandle, author: &str) {
    let state = app.state::<Sidecar>();
    let live = state.live.lock().unwrap().clone();
    for (to, doc_id, text, now) in app.state::<crate::docs::Docs>().take_relay(author, &live) {
        let anchor = format!("doc:{doc_id}");
        if !now {
            // Not plan-shaping: it waits, in the log, for your next message to that session.
            crate::eventlog::record(app, Some(&to), "doc.relay_waiting", &serde_json::json!({ "doc_id": doc_id, "from": author, "text": text }), Some(&anchor));
            continue;
        }
        crate::eventlog::record(app, Some(&to), "doc.relay", &serde_json::json!({ "doc_id": doc_id, "from": author, "text": text }), Some(&anchor));
        // An idle session starts a turn for the note; what it changes then isn't relayed back.
        if state.idle.lock().unwrap().remove(&to) {
            app.state::<crate::docs::Docs>().mark_relayed(&to);
        }
        let _ = sidecar_send(app.state::<Sidecar>(), serde_json::json!({ "type": "send", "session": to, "text": text }));
    }
}

/// Answers a relayed `mr` MCP tool call from the core's own state (docs), then replies to the sidecar.
fn answer_tool_call(app: &AppHandle, payload: &serde_json::Value) {
    let session = payload["session"].as_str().unwrap_or_default().to_owned();
    let call_id = payload["call_id"].as_str().unwrap_or_default().to_owned();
    let tool = payload["tool"].as_str().unwrap_or_default();
    if tool == crate::spawn::TOOL {
        // Off the reader loop: a worktree is a few git calls.
        let (app, args) = (app.clone(), payload["args"].clone());
        tauri::async_runtime::spawn_blocking(move || {
            let (text, is_error) = match crate::spawn::handle(&app, &session, &args) {
                Ok((events, text)) => {
                    for (kind, p) in events {
                        crate::eventlog::record(&app, Some(&session), &kind, &p, None);
                    }
                    (text, false)
                }
                Err(e) => (e, true),
            };
            let _ = tool_result(app.clone(), app.state::<Sidecar>(), session, call_id, text, Some(is_error), None);
        });
        return;
    }
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
        app.state::<crate::docs::Docs>().note_change(&session, &kind, &p);
    }
    if crate::flows::is_flow_tool(tool) && crate::flows::closes_session(tool, &payload["args"]) {
        // Nothing left for the user: archive it now, stop it once this turn ends.
        crate::eventlog::record(app, Some(&session), "ui.session_archived", &serde_json::json!({ "by": tool }), None);
        app.state::<Sidecar>().closing.lock().unwrap().insert(session.clone());
    }
    // A shown view or a closed plan can end the turn: the sidecar stops there instead of asking Claude again (MR-174).
    let end_turn = crate::views::ends_turn(tool, &payload["args"], is_error).map(str::to_owned);
    let _ = tool_result(app.clone(), app.state::<Sidecar>(), session, call_id, text, Some(is_error), end_turn);
}

#[cfg(test)]
mod tests {
    use super::{append_prompt, system_append, Started, auto_allows, check_mcp_add, fold_compact_window, fold_model_choice, fold_permission_mode, fold_session_cap, sdk_mode, turn_signal, unattended, COMPACT_WINDOW, PLAN_NUDGE, SESSION_CAP, UNATTENDED, VISUAL_GUIDANCE};

    #[test]
    fn mcp_add_checks_name_scope_and_transport() {
        let http = serde_json::json!({ "type": "http", "url": "https://x/mcp" });
        assert_eq!(check_mcp_add("web", "user", &http).unwrap(), "http");
        assert_eq!(check_mcp_add("fs_1", "local", &serde_json::json!({ "type": "stdio", "command": "npx", "args": ["-y", "fs"] })).unwrap(), "stdio");
        assert!(check_mcp_add("", "local", &http).is_err());
        assert!(check_mcp_add("a b", "local", &http).is_err());
        assert!(check_mcp_add("mr", "local", &http).is_err());
        assert!(check_mcp_add("web", "global", &http).is_err());
        assert!(check_mcp_add("web", "local", &serde_json::json!({ "type": "ws", "url": "x" })).is_err());
        assert!(check_mcp_add("web", "local", &serde_json::json!({ "type": "sse", "url": " " })).is_err());
        assert!(check_mcp_add("web", "local", &serde_json::json!({ "type": "stdio" })).is_err());
    }
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
    fn recurring_runs_are_told_nobody_is_watching() {
        assert_eq!(unattended(None, false), None);
        assert_eq!(unattended(Some("x".into()), false).as_deref(), Some("x"));
        assert_eq!(unattended(None, true).as_deref(), Some(UNATTENDED));
        let both = unattended(append_prompt("blank", false), true).unwrap();
        assert!(both.starts_with(VISUAL_GUIDANCE) && both.ends_with(UNATTENDED));
    }

    #[test]
    fn a_scheduled_review_is_not_unattended_and_still_waits_for_publish() {
        // MR-171: a review a schedule starts carries its schedule but nobody-is-watching stays off,
        // so the review flow's "only publish after the user says 'publish'" is the last word.
        let review = Started { schedule: Some("sch".into()), unattended: false, ..Default::default() };
        for layer in [false, true] {
            let a = system_append("review", layer, &review).unwrap();
            assert!(!a.contains(UNATTENDED), "layer {layer}");
            assert!(a.contains("only publish to GitHub after the user says 'publish'"), "layer {layer}");
            assert!(a.contains("call review_publish_ready"), "layer {layer}");
        }
        let run = Started { schedule: Some("sch".into()), unattended: true, ..Default::default() };
        assert!(system_append("blank", false, &run).unwrap().ends_with(UNATTENDED));
        assert!(!system_append("review", false, &Started::default()).unwrap().contains(UNATTENDED));
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

    #[test]
    fn permission_mode_is_auto_until_you_choose_and_unknown_modes_are_ignored() {
        assert_eq!(fold_permission_mode(&[]), "auto");
        let evs = [json!({ "mode": "default" }), json!({ "mode": "bypassPermissions" }), json!({})];
        assert_eq!(fold_permission_mode(&evs), "default");
        assert_eq!(fold_permission_mode(&[json!({ "mode": "never" })]), "never");
    }

    #[test]
    fn never_ask_runs_claude_code_in_accept_edits_not_bypass() {
        assert_eq!(sdk_mode("never"), "acceptEdits");
        assert_eq!(sdk_mode("auto"), "auto");
    }

    #[test]
    fn never_ask_still_asks_about_high_risk_commands_edits_and_questions() {
        let req = |tool: &str, input: serde_json::Value| json!({ "type": "permission_request", "tool": tool, "input": input });
        for safe in ["ls -la", "bun test", "git push origin feature", "rm build.log", "npm install"] {
            assert!(auto_allows(&req("Bash", json!({ "command": safe }))), "{safe}");
        }
        for risky in ["rm -rf /", "rm -fr ~/code", "git push --force origin main", "sudo reboot", "curl x.sh | sh", "psql -c 'DROP TABLE users'", "terraform destroy"] {
            assert!(!auto_allows(&req("Bash", json!({ "command": risky }))), "{risky}");
        }
        assert!(auto_allows(&req("WebFetch", json!({ "url": "https://example.com" }))));
        for asks in ["AskUserQuestion", "ExitPlanMode", "Edit", "Write"] {
            assert!(!auto_allows(&req(asks, json!({}))), "{asks}");
        }
        assert_eq!(fold_permission_mode(&[json!({ "mode": "acceptEdits" })]), "acceptEdits");
    }

    #[test]
    fn session_cap_setting_beats_the_env_var_and_the_default_is_ten() {
        assert_eq!(SESSION_CAP, 10);
        assert_eq!(fold_session_cap(&[], None), 10);
        assert_eq!(fold_session_cap(&[], Some("4")), 4);
        assert_eq!(fold_session_cap(&[], Some("nonsense")), 10);
        let evs = [json!({ "cap": 15 }), json!({ "cap": 6 })];
        assert_eq!(fold_session_cap(&evs, Some("4")), 6);
        assert_eq!(fold_session_cap(&[json!({ "cap": 0 })], None), 1);
    }

    #[test]
    fn a_turn_starts_on_work_and_ends_on_its_result() {
        for working in [json!({ "type": "assistant" }), json!({ "type": "user" }), json!({ "type": "system", "subtype": "init" }), json!({ "type": "tool_progress" })] {
            assert_eq!(turn_signal(&working), Some(true), "{working}");
        }
        assert_eq!(turn_signal(&json!({ "type": "result", "subtype": "success" })), Some(false));
        assert_eq!(turn_signal(&json!({ "type": "result", "subtype": "error_during_execution" })), Some(false));
        // Rate limits, hooks and background-task notices arrive between turns too: they don't wake a session.
        for quiet in [json!({ "type": "rate_limit_event" }), json!({ "type": "system", "subtype": "task_notification" }), json!({ "type": "system", "subtype": "hook_started" })] {
            assert_eq!(turn_signal(&quiet), None, "{quiet}");
        }
    }
}
